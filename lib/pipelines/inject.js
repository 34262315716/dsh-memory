/**
 * 注入侧管线（原 lib/index.js apply 内的 pre-step 检索注入 + session-start 预热，v0.10 拆分为工厂）。
 * 职责：步距节流（每 N 步必检）+ 注入块 hash 去抖 + 防循环窗口 + token 预算 + KV 缓存友好注入。
 * v0.13.0 起有两条并行通道：
 *   ① 检索通道（原有）：按 query 检索、按得分取前几、受节流与去抖约束；
 *   ② 常驻通道（新）：被显式钉选（memories.pinned=1）的记忆**不经过检索**、恒定随每次注入抵达，
 *      回答用户那句"珍贵教训要一直注入，不是讲到了相关内容才注入"。
 * v0.16.0 检索通道多了一个**触发源**：用户消息（不是步距）。
 *   用户的每条新消息都必检一次（`trigger='user-message'`），步距节流只约束工具步之间的重检——
 *   修的是"用户连问几句新问题，整段都在吃几句之前那次检索结果"这个缺口。
 *   **检索路径上不做任何决策模型判断**（2026-10-06 主人判定）：查库是这条链路的本职，
 *   来了新消息就查，不问"要不要查"。
 * 依赖经参数注入（store / getCfg / wsRegistry / logStore / workProjection），状态由工厂闭包持有。
 */
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveStepInterval } from '../config.js'
import { safeGet } from '../compat.js'
import { estimateTokens, extractUserText, formatNow, renderInjection, renderPinned, scopeOf, truncate } from '../util.js'
import { extractWorkText } from '../work-projection.js'

/**
 * 从 `agent/pre-step` 的 payload 读官方步坐标（v0.15.3）。
 *
 * 官方签名（docs/subsystems/core.zh.md 生成区）：payload 携带「拟进入步骤的坐标（turn、step）」。
 * 0.1.5-rc.3 与 0.2.0-rc.2 两份内核都传（agent-loop 的 preStep 调用处
 * `const step = phase.step + 1` → `this.preStep(target, { turn, step })`）。
 * 按 compat.js 的规矩「按能力探测，不按版本号比较」：此处只问 payload 有没有坐标。
 *
 * @param {object} payload pre-step payload
 * @returns {{turn: number, step: number} | null} 坐标；null = 该内核没给，由调用方降级
 */
function stepCoordinate(payload) {
  const turn = payload?.turn
  const step = payload?.step
  if (!Number.isSafeInteger(turn) || turn < 1) return null
  if (!Number.isSafeInteger(step) || step < 1) return null
  return { turn, step }
}

/**
 * 把「轮内步号」折成「会话内累计步号」（v0.15.3），还原 v0.9.24 以来的节流语义（每 N 步必检）。
 *
 * **为什么要折**：`step/start` 的定义是 "opens step `step` of turn `turn`"——**每轮从 1 重数**
 * （docs/subsystems/session.zh.md）。而 v0.15.2 及以前读的是 `agent?.session?.events`：
 * 内核的 Session 上从来没有 `events` 这个属性（真源是 `session.log`，且 `eventAt` /
 * `snapshotEvents` / `ownEvents` 三个同步读者已被官方废弃，见
 * `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`），
 * 于是恒返 0 → 命中 `step === 0` 静默早退 → 检索、注入、日志全不发生（"看不见注入"的根因）。
 *
 * **折法**（保证 value 在同一 agent 内单调不减；否则节流会算出负差值而永久卡死）：
 *   · 首次 / 轮次或步号回退（clear、compact 后重数）→ 清零起算
 *   · 同一轮内 → value = 基准 + 当前步号
 *   · 进入新轮 → 上一轮的最大步号折进基准，value = 新基准 + 当前步号
 *
 * @param {{turn: number, base: number, maxStep: number, value: number} | undefined} state 上一状态
 * @param {number} turn 轮次号
 * @param {number} step 轮内步号
 * @returns {{turn: number, base: number, maxStep: number, value: number}} 新状态（value = 累计步号）
 */
function foldStep(state, turn, step) {
  if (!state || turn < state.turn || (turn === state.turn && step < state.maxStep)) {
    return { turn, base: 0, maxStep: step, value: step }
  }
  if (turn > state.turn) {
    const base = state.base + state.maxStep
    return { turn, base, maxStep: step, value: base + step }
  }
  return { turn, base: state.base, maxStep: step, value: state.base + step }
}

/**
 * 常驻块装配（v0.13.0）：取钉选记忆，按 pinnedMaxTokens 独立预算贪心装入。
 * 任何异常（老库无列、读库失败）都降级为空——常驻通道坏了不能连累整条注入管线。
 * @returns {{ pins: object[], text: string }}
 */
export function buildPinned(store, cfg) {
  try {
    const limit = Math.max(1, cfg?.pinnedLimit ?? 8)
    const budget = Math.max(100, cfg?.pinnedMaxTokens ?? 600)
    const all = store.listPinned({ limit })
    let pins = []
    for (const p of all) {
      // v0.13.1：按「装配出来的块」实际计费。渲染会把每条截到 PIN_ITEM_CHARS，
      // 逐条累加估算都比真实块偏贵（真实库 12 条只装进 7 条 / 修正后仍偏贵到 11 条），
      // 所以这里直接量最终文本——反正最多 12 条、每次几步字符串操作。
      const next = [...pins, p]
      if (pins.length > 0 && estimateTokens(renderPinned(next)) > budget) break
      pins = next
    }
    return { pins, text: renderPinned(pins) }
  } catch (err) {
    console.warn(`[dsh-memory] 常驻记忆读取失败（本轮跳过常驻块）: ${err.message}`)
    return { pins: [], text: '' }
  }
}

/**
 * pre-step 检索注入工厂：挂载 agent/pre-step 监听。
 * KV 缓存友好：稳定块头 + 确定性排序 + append-only 尾部 + 溯源锚点（#mem-id）。
 * 常驻块永远排在检索块之前（位置稳定 → 前缀可命中缓存）。
 */
export function attachInjectPipeline(ctx, { store, getCfg, wsRegistry, logStore, workProjection }) {
  const recentInjected = new Map() // agentId -> [memId...]
  const lastHit = new Map() // agentId -> { step }（上次检索时的累计步号）
  const lastUserQuery = new Map() // agentId -> 上次触发检索的用户文本（v0.16.0 用户消息触发）
  const stepSeen = new Map() // agentId -> 累计步状态（v0.15.3：由 payload 坐标折叠而来）
  const coordWarned = new Set() // 已就「内核没给坐标」告警过的 agentId（每个 agent 只吵一次）
  const workWarned = new Set() // 已就「会话投影服务不可用」告警过的 agentId（每个 agent 只吵一次）
  const lastBlockHash = new Map() // agentId -> 注入块 hash
  const scope = getCfg().scope || 'global'

  ctx.on('agent/pre-step', async (payload, next) => {
    // v0.15.3：异常路径不得重复调用 waterfall 下游——next() 至多调一次，取到的决策留存复用
    let decision = null
    let agentId
    let step
    try {
      const cfg = getCfg()
      if (!cfg.features.preStepInject) return next()
      agentId = payload.agent.id
      // agent 累计步号（v0.15.3）：官方 payload 坐标 → 会话内累计步；只有内核没给坐标时才退化计数
      const coord = stepCoordinate(payload)
      const prev = stepSeen.get(agentId)
      const counted = coord
        ? foldStep(prev, coord.turn, coord.step)
        : { turn: 0, base: 0, maxStep: 0, value: (prev?.value ?? 0) + 1 }
      stepSeen.set(agentId, counted)
      step = counted.value
      if (!coord && !coordWarned.has(agentId)) {
        coordWarned.add(agentId)
        logStore('warn', 'inject.coord_missing', { agent: agentId, step })
      }
      if (!Number.isSafeInteger(step) || step <= 0) return next()
      // query：优先真实用户文本；自主轮次（goal/后台，无用户消息）用会话最近工作上下文兜底。
      // v0.13.0 修正：extractUserText 现在会**剥掉 <system-reminder> 等平台/插件注入块**——
      // 以前工具步的 payload.messages 里常常只剩一条 MCP 系统提醒，它被当成检索 query，
      // 于是"注入出来的内容跟正在聊的事对不上"。剥掉后工具步自动落到工作上下文兜底。
      const userText = extractUserText(payload.messages)
      // 工作上下文兜底（v0.15.3）：改由官方会话投影单元 memoryWork 折叠而来
      // （lib/work-projection.js），不再读内核从未提供的 agent.session.events ——
      // 后者恒返空串，工具步 / 自主轮次因此永远拿不到 query、永远不注入。
      const workText = userText ? '' : extractWorkText(workProjection?.read?.(payload.agent.session))
      if (!userText && !workText && workProjection && workProjection.available === false && !workWarned.has(agentId)) {
        workWarned.add(agentId)
        logStore('warn', 'inject.work_missing', { agent: agentId, step })
      }
      const queryText = userText || workText
      // 常驻记忆（v0.13.0）：与检索正交的恒定通道——没有任何 query 也照常抵达。
      const pinned = buildPinned(store, cfg)
      if (!queryText && pinned.pins.length === 0) return next()
      // 用户消息触发（v0.16.0）：**每条用户消息都重新检索一次**，不受步距节流限制。
      // 缺口在哪：步距按「步」计，而一轮用户消息通常只走几步——平稳档（12 步）下，
      // 用户连问几句新问题，整段都在吃几句之前那次检索的结果，体感就是"我说了新的，它没去查"。
      // 判据取「用户文本变了」而不是「轮次变了」：同一轮里用户插话（steering）也是新内容，
      // 而同一轮里被重复带上的同一条用户消息不该重复检索。
      const isNewUserMessage = cfg.features?.userMessageTrigger !== false
        && Boolean(userText)
        && userText !== lastUserQuery.get(agentId)
      // 步距节流：距上次检索不足「生效步距」步 → 跳过（用户消息触发时无视它）。
      // 生效步距来自 injectPace 档位（激进 4 / 平稳 12 / 懒惰 30；custom 用 stepInterval）——
      // 解析走 config.js 的单一来源 resolveStepInterval，本文件不再自己算。
      // 步距到必检——同 query 也重检（库里可能有新记忆涌入）；重复注入由 blockHash 去抖兜底
      const interval = resolveStepInterval(cfg)
      const last = lastHit.get(agentId)
      if (!isNewUserMessage && last && step - last.step < interval) return next()
      lastHit.set(agentId, { step })
      if (isNewUserMessage) lastUserQuery.set(agentId, userText)
      // 这里**不设决策门**（2026-10-06 主人判定）：检索是本分，每条新用户消息直接查库。
      // 先前接过一次（lib/decision-gate.js 的 ask），被判定为多余——查库就是这条链路的本职工作，
      // 为它加一道本地模型判断，等于在关键路径上多花 0.4~1.2 秒去问"要不要干活"，
      // 还要承担"判错就漏检索"的风险。决策模型只在**昂贵且不可逆**的地方用：
      // 写入侧的 LLM 提取（一轮几十秒，见 lib/pipelines/write.js）。
      // 3) 检索（异步：真嵌入下 query 向量为网络调用）——当前项目 scope + global 公共层（v0.9.4）
      //    profile boost（P0.1 画像召回）：画像 content 短/关键词少，RRF 中易被泛词长记忆碾压；
      //    乘 3 使其弱命中也能过注入门槛。仅注入路径生效，memory_search 工具不受影响。
      //    v0.10 abstraction 联动：principle ×1.5 优先、event ×0.7 降权（强相关才注入）
      //    ——"我怎么看待设计"优先于"设计了什么"（store.search boost 双维：type×abstract）
      const excluded = recentInjected.get(agentId) ?? []
      const hits = queryText
        ? await store.search(queryText, {
            scope: [scopeOf(payload.agent, wsRegistry), 'global'],
            limit: 6,
            minScore: cfg.injectMinScore,
            excludeIds: excluded,
            boost: { profile: 3, principle: 1.5, event: 0.7 },
          })
        : []
      if (hits.length === 0 && !pinned.text) return next()
      // 4) token 预算：贪心装入（检索块吃 injectMaxTokens；常驻块已在 buildPinned 里独立预算）
      const budget = cfg.injectMaxTokens
      let used = 0
      const picked = []
      for (const h of hits) {
        const cost = 8 + estimateTokens(h.content)
        if (used + cost > budget && picked.length > 0) break
        picked.push(h)
        used += cost
      }
      // 5) 注入块 hash 去抖：指纹**含常驻块**——常驻清单变了（新钉选/取消钉选）要重新抵达。
      //    v0.9.32 时间戳分离：去抖 hash 用**不带时间**的渲染（内容指纹），
      //    注入文本用**带时间**版本——内容没变不重复注入（v0.8.5 KV 友好原则），
      //    但每次真正注入时模型都会拿到当前时间，长会话时间认知不断锚定。
      const recallFp = picked.length > 0 ? renderInjection(picked, scope) : '' // 去抖指纹：无时间戳
      const recallBlock = picked.length > 0 ? renderInjection(picked, scope, { withTime: true }) : ''
      const blockFp = `${pinned.text}\n${recallFp}`
      const block = [pinned.text, recallBlock].filter(Boolean).join('\n\n')
      if (!block) return next()
      const blockHash = createHash('sha1').update(blockFp).digest('hex')
      if (lastBlockHash.get(agentId) === blockHash) return next()
      lastBlockHash.set(agentId, blockHash)
      // 6) 注入（append-only 尾部；form='recall' 溯源）
      //    v0.10.1 修复：不再用 agent.inject()——它会把消息塞进 next-step 队列，
      //    记忆块在 AI 回复后被当作独立一步消费，模型被迫多答一轮（"AI 回复完记忆又注入"）。
      //    改为合并进本步 decision.messages（与 claimed/context 同一 step 内 append+生成）。
      decision = await next()
      if (decision.kind === 'reject') return decision
      // 运行日志（v0.9.5）：检索与注入透明可见（v0.9.24 加 step；v0.13.0 加 queryKind/pinned；
      // v0.16.0 加 trigger/gate——"这次为什么检索、决策门怎么判的"都要能对账）
      logStore('info', 'inject', {
        step,
        interval,
        pace: cfg.injectPace ?? 'steady',
        trigger: isNewUserMessage ? 'user-message' : 'interval',
        query: queryText.slice(0, 80),
        queryKind: userText ? 'user' : 'work',
        hits: hits.length,
        picked: picked.length,
        ids: picked.map((h) => h.id),
        scores: picked.map((h) => h.score),
        pinned: pinned.pins.length,
        pinIds: pinned.pins.map((p) => p.id),
        scope: scopeOf(payload.agent, wsRegistry),
      })
      // 7) 防循环窗口（只收检索块：常驻是恒定的，不该被"最近注入过"排除掉）
      const window = [...excluded, ...picked.map((h) => h.id)]
      recentInjected.set(agentId, window.slice(-cfg.maxRecentPerAgent))
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            // v0.15.3：v4 的 producer kind 是 `plugin:<插件名>`；裸 'plugin' 是已退役写法
          // （内核 source() 明确拒绝，assertV4SourceRowAdmission 也会对 kind==='plugin' 的行抛错）
          source: { kind: 'plugin:dsh-memory', form: 'recall' },
            content: [{ type: 'text', text: block }],
          }),
        ],
      }
    } catch (err) {
      // v0.15.3：注入失败不再只写宿主 stderr——面板日志也留一条。
      // 本次排查的教训：catch 只 console.warn，于是"检索与注入整个没发生"这件事
      // 在记忆面板里完全看不见，只能靠翻代码反推。
      const message = err?.message ?? String(err)
      console.warn(`[dsh-memory] 注入失败: ${message}`)
      try {
        logStore('warn', 'inject.error', { agent: agentId, step, message })
      } catch { /* 日志自身失败不再抛：宁可少一条记录，也不能炸掉整条 pre-step 流水线 */ }
    }
    // 已取到下游决策就复用它（v0.15.3）：避免 next() 被调两次、让 waterfall 下游跑两遍
    return decision ?? next()
  })
}

/**
 * 会话预热工厂（v0.14.0 跨内核适配）：把「常驻 + 画像 + 项目 scope」整块长期记忆摆在会话开头。
 *
 * 两条通道**按能力二选一**（不是按版本号猜），判定是同步做的，所以绝不会都触发：
 *
 *   通道 A「系统提示段落」——0.2.0-rc.2 的路径。
 *     0.2.0-rc.2 的事件表里**没有** `agent/session-start`（只有 `agent/created`），而"会话开始时
 *     把上下文摆进去"的正规做法是给该 agent 注册一个 system-prompt section：
 *     范本 `@deepseek-ai/dsh-file-reference-local/lib/index.js:339-372`（created 装、disposed 拆）、
 *     活样本 `dsh-soul-md/index.js:254-266`。
 *     比消息注入稳的地方：不占对话消息位、且不受"首步空批次短路"影响
 *     （`dsh-agent-instance/lib/index.js:1271-1289`：step===1 且 messages 为空时该步不进入，
 *      于是创建时推的那条消息谁也看不见）。
 *
 *   通道 B「消息注入」——0.1.2 老路径，原样保留：
 *     `agent/session-start` + `agent.inject()`（queued model-facing context，不唤醒 driver，
 *      在开头那一步被 Inbox.claim 优先取走）。0.2.0-rc.2 上这个事件不触发，自然静默。
 *
 * 内容每个 agent **只装配一次并缓存**：系统提示是前缀，随步变化会打掉后面整段 KV 缓存，
 * 而"预热"的语义本来也就是会话开头那一刻的快照。
 */
export function attachPreheatPipeline(ctx, { store, getCfg, wsRegistry, logStore }) {
  const warmed = new WeakSet() // 已预热的 agent（两条通道共用，防重复）
  const promptFibers = new WeakMap() // agent -> cordis fiber（通道 A 的回收把手）
  const promptText = new WeakMap() // agent -> 装配好的预热文本（缓存，保证前缀稳定）

  /**
   * 装配预热文本（常驻优先 + 画像 + 项目 scope 隔离）。
   * @param {object} agent 目标 agent
   * @returns {string} 整块注入文本；'' 表示这次没有可摆的内容
   */
  function buildPreheatText(agent) {
    try {
      const cfg = getCfg()
      if (!cfg.features.preStepInject || !agent) return ''
      // 常驻记忆（v0.13.0）：会话一开始就先摆上——"恒定注入"的第一现场。
      const pinned = buildPinned(store, cfg)
      const pinLines = pinned.pins.map((p) => `- [常驻·${p.type}] ${truncate(String(p.content ?? ''), 220)}`)
      // 画像：全 scope 直取（跨项目公共层，type=profile 过滤）
      const profiles = store.list({ layer: 'sm', type: 'profile', limit: 3 })
      // 非画像：当前项目 scope 优先（新记忆已分层），不足补 global（存量兼容）
      const cur = scopeOf(agent, wsRegistry)
      // v0.10 principle 优先：非画像种子按 abstract 排序（principle 排前），
      // 预热时间认知的"我如何看待设计"先于"设计了什么"
      const rankAbstract = (a, b) => (b.abstract === 'principle' ? 1 : 0) - (a.abstract === 'principle' ? 1 : 0)
      const curScope = store.list({ layer: 'sm', scope: cur, limit: 5 }).filter((m) => m.type !== 'profile').sort(rankAbstract).slice(0, 2)
      const othersBase = store.list({ layer: 'sm', scope: 'global', limit: 5 }).filter((m) => m.type !== 'profile').sort(rankAbstract)
      const others = curScope.length < 2 ? [...curScope, ...othersBase.slice(0, 2 - curScope.length)] : curScope
      const seeds = [...profiles, ...others]
      if (seeds.length === 0 && pinLines.length === 0) return ''
      const t = formatNow()
      logStore('info', 'preheat', { seeds: seeds.length, pinned: pinned.pins.length, scope: cur, profiles: profiles.length, ts: t.local })
      const lines = [
        `[记忆] 会话预热（当前时间：${t.local} ${t.weekday} · 常驻/画像优先的长期记忆，由 dsh-memory 注入）`,
        ...pinLines,
        ...seeds.map((s) => {
          const kind = s.type === 'profile' ? `画像${s.profile_aspect ? '·' + s.profile_aspect : ''}` : s.type
          return `- [${kind}] ${truncate(s.content, 200)}`
        }),
      ]
      // v0.12.1 治理留痕：管家最近 24h 内做过整理就把结论摆进上下文——
      // 用户说"维护和整合我没明显感觉"，一半原因就是它从不出现在视野里。
      // 这条不是给模型当记忆用的，而是让它知道"库刚被整理过"，必要时可以顺口告诉用户。
      try {
        const gv = JSON.parse(store.getMeta('last_governance') ?? 'null')
        if (gv?.at && Date.now() - gv.at < 24 * 3600 * 1000) {
          lines.push(`- [维护] 记忆库最近整理过：${gv.summary}（只归档不删除，用 memory_archive 可查看/恢复）`)
        }
      } catch { /* 治理留痕读取失败忽略 */ }
      return lines.join('\n')
    } catch (err) {
      console.warn(`[dsh-memory] 会话预热装配失败: ${err.message}`)
      return ''
    }
  }

  // ---------- 通道 A：系统提示段落（0.2.0-rc.2）----------
  // ⚠️ agent/created 的 listener 抛错会让"创建 agent"失败并跳过后续 listener，
  // 所以这里必须整体 try/catch —— 记忆插件坏了不能连带 dsh 起不来。
  ctx.on('agent/created', ({ agent }) => {
    try {
      if (!agent || warmed.has(agent)) return
      if ((getCfg().features.preheatRoute ?? 'auto') === 'message') return // 用户强制走老通道
      if (safeGet(ctx, 'systemPrompt') === undefined) return // 老内核没有该服务 → 交给通道 B
      warmed.add(agent)
      promptText.set(agent, buildPreheatText(agent))
      const fiber = agent.ctx.inject(['systemPrompt'], (scoped) => {
        scoped.systemPrompt.section({
          name: 'dsh-memory:preheat',
          order: scoped.systemPrompt.getSectionOrder('FILE_REFERENCE'),
          text: () => promptText.get(agent) ?? '',
          // 记忆正文里完全可能出现 `{{…}}`，绝不能让提示词插值把它吃掉
          interpolate: false,
        })
      })
      promptFibers.set(agent, fiber)
    } catch (err) {
      console.warn(`[dsh-memory] 会话预热（系统提示段落）失败: ${err.message}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    try {
      if (!agent) return
      const fiber = promptFibers.get(agent)
      if (fiber && typeof fiber.dispose === 'function') fiber.dispose()
      promptFibers.delete(agent)
    } catch { /* 回收失败忽略：内核在 agent 销毁时会自行 unwind scoped 注册 */ }
  })

  // ---------- 通道 B：消息注入（0.1.2 老路径）----------
  ctx.on('agent/session-start', (payload) => {
    try {
      const agent = payload?.agent
      if (!agent || warmed.has(agent)) return
      const text = buildPreheatText(agent)
      if (!text) return
      warmed.add(agent)
      agent.inject(
        createUserMessage({
          // v0.15.3：v4 的 producer kind 是 `plugin:<插件名>`；裸 'plugin' 是已退役写法
          // （内核 source() 明确拒绝，assertV4SourceRowAdmission 也会对 kind==='plugin' 的行抛错）
          source: { kind: 'plugin:dsh-memory', form: 'recall' },
          content: [{ type: 'text', text }],
        }),
      )
    } catch (err) {
      console.warn(`[dsh-memory] 会话预热失败: ${err.message}`)
    }
  })
}
