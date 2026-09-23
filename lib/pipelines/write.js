/**
 * 写入侧管线（原 lib/index.js apply 内的会话写入逻辑，v0.10 拆分为工厂）。
 * 职责：turn/end 自动沉淀 + 价值门 + Jaccard 去重合并 + refiner 蒸馏 + 管家触发。
 * 依赖经参数注入（store / getCfg / wsRegistry / logStore），不触碰 apply 局部状态。
 */
import { jaccard } from '../store.js'
import { extractWithLlm, pickKeywords, summarizeSessionWithLlm } from '../refiner.js'
import { OUTCOME_RE, messageText, scopeOf, truncate } from '../util.js'

/**
 * 纯寒暄/确认：整条消息不含任何信息量（"继续""好的""早上好啊""谢谢"）。
 * v0.12：库内实测这类轮次会被完整沉淀成 ep 记忆，甚至被去重合并反复拼接
 * （"早上好啊"曾被拼成 3 段、占满一条记忆），故在价值门里前置拦掉。
 */
const TRIVIAL_MSG_RE = /^[\s，。！~～,.!?？、]*(?:(?:早上好|中午好|下午好|晚上好|晚安|你好|您好|嗨|哈喽|在吗|谢谢|多谢|辛苦了|收到|好的|好嘞|好吧|行吧|行|可以|没问题|嗯+|哦+|继续|开始吧|来吧|ok|OK|Ok|yes|no)[\s，。！~～,.!?？、]*)+$/

/** 偏好/纠正/决定信号词：短消息里出现这些，说明它有内容，绝不能按寒暄丢掉
 *  （用户大量高价值表达本身就极短："不要堆代码""用大白话""改成 12 步""我认"）。 */
const SIGNAL_RE = /不要|不用|别|禁止|必须|改成|换成|以后|记住|注意|我认|偏好|喜欢|讨厌|不对|错了|不是这样|重来|我的意思|应该是|按我/

/**
 * 无价值轮次判定（v0.12 价值门）：这一轮是否"扫过去就行、不必进长期记忆"。
 * 判据保守——宁可多记一条，也不要把用户的短表达（偏好/纠正）当寒暄丢掉。
 */
export function isTrivialTurn(userPart, assistantPart) {
  const u = String(userPart ?? '').trim()
  const a = String(assistantPart ?? '').trim()
  // 助手有实质输出 → 这一轮有产出，不算空洞
  const assistantEmpty = !a || a === '(无输出)' || a.length < 4
  if (!assistantEmpty) return false
  if (!u) return true
  if (SIGNAL_RE.test(u)) return false
  if (u.length > 40) return false
  return TRIVIAL_MSG_RE.test(u) || u.length <= 4
}

/** 去重合并：相似记忆（Jaccard >= 0.8）→ 更新而非新建。 */
export async function upsertMemory(store, features, entry) {
  // 阶段三：只有语义记忆（sm）进知识图谱——ep 快照是过程噪音，不成节点/边
  const doGraph = features.graph && entry.layer === 'sm'
  if (!features.dedupMerge) {
    await store.add(entry)
    return
  }
  const qTokens = new Set(entry.keywords)
  if (qTokens.size === 0) {
    await store.add(entry)
    return
  }
  // 轻量扫描最近 sm/ep 记忆找相似
  const rows = store.list({ scope: entry.scope, limit: 200 })
  let best = null
  let bestSim = 0
  for (const r of rows) {
    const sim = jaccard(qTokens, new Set(r.keywords))
    if (sim > bestSim) {
      bestSim = sim
      best = r
    }
  }
  let id
  if (best && bestSim >= 0.8) {
    // 注意：store.list() 返回的 keywords 已是数组（DB 里存 JSON 字符串），不能再次 JSON.parse
    id = best.id
    // v0.9.10：更新时新内容永远接在旧内容末尾（+N 徽标每更新 +1）；
    // 内容与整条相同、或与上一条已追加片段相同 → 无操作（不追加不升版本，防重复刷屏）
    const sepIdx = best.content.lastIndexOf('\n---\n')
    const lastChunk = sepIdx >= 0 ? best.content.slice(sepIdx + 5) : best.content
    if (best.content !== entry.content && lastChunk !== entry.content) {
      await store.update(best.id, {
        content: `${best.content}\n---\n${entry.content}`,
        keywords: [...new Set([...best.keywords, ...entry.keywords])],
        strengthDelta: 0.3,
      })
    }
  } else {
    id = await store.add(entry)
    // 阶段三：similarTo 自动边——相似但未达合并阈值 → 记为去重候选（供管家/merge 决策）
    // v0.9.1：阈值 0.5 → 0.6（0.5 太宽，"同主题≠相似"的糊团边过多）
    if (doGraph && best && bestSim >= 0.6) {
      try { store.linkSimilar(best.id, id, bestSim) } catch { /* 图谱失败不影响主流程 */ }
    }
  }
  if (doGraph && id) {
    // 用 add/update 的返回值建边，避免按时间倒序误取到别的记忆
    // v0.9.12：graphLink 内部做实体稀有化（高频泛词不进图），传全量关键词避免截断挤掉稀有词
    store.graphLink(id, entry.keywords)
    // 阶段三：before 时间链自动边（同实体跨记忆按时间演化）
    try { store.linkBefore(id) } catch { /* 图谱失败不影响主流程 */ }
    // v0.11.0：语义连边（纯算法，不调 LLM）——用已有向量 + 四道闸门把新记忆连回主图，
    // 避免"写进去就孤立"。任何异常都不影响写入主流程。
    try { store.linkSemantic(id) } catch (err) { /* 图谱失败不影响主流程 */ void err }
  }
  return id
}

/**
 * 把提取结果落到库里（v0.12.2 抽出，便于单测）。
 *
 * 两条分支：
 *   - 带 `supersedes`（且 id 在本次真的喂给模型的已知集合里）→ **纠正**：更新那条既有记忆，
 *     旧内容进世界线版本（可回滚），而不是新建一条与它并存的矛盾记忆；
 *   - 其余 → 走 upsertMemory（查重合并 / 新建 + 图谱连边）。
 *
 * 白名单是硬性的：只接受 `knownIds` 里的 id——模型凭空编一个 id 也改不动无关记忆。
 *
 * @returns {Promise<{written: number, corrected: number}>}
 */
export async function applyExtractedItems(store, features, items, { knownIds = new Set(), writeScope = () => 'global', logStore = () => {} } = {}) {
  let written = 0
  let corrected = 0
  for (const item of items ?? []) {
    const sup = (item?.supersedes ?? []).filter((id) => knownIds.has(id)).slice(0, 1)
    if (sup.length > 0) {
      const prev = store.get(sup[0])
      await store.update(sup[0], {
        content: truncate(item.content, 2000),
        keywords: [...new Set([...(item.keywords ?? []), ...(prev?.keywords ?? [])])].slice(0, 60),
        strengthDelta: 0.3,
      })
      corrected++
      logStore('info', 'write.corrected', {
        id: sup[0], type: item.type, scope: writeScope(item.type),
        before: (prev?.content ?? '').slice(0, 80), after: String(item.content ?? '').slice(0, 80),
      })
      continue
    }
    await upsertMemory(store, features, {
      layer: item.layer === 'ep' ? 'ep' : 'sm',
      type: item.type,
      scope: writeScope(item.type),
      content: truncate(item.content, 2000),
      keywords: (item.keywords?.length ? item.keywords : pickKeywords(item.content)).slice(0, 40),
      aspect: item.aspect ?? '',
      // v0.10 双输出：abstraction（principle/event）+ theme 名词标签
      abstract: item.abstract ?? '',
      theme: item.theme ?? '',
    })
    written++
  }
  return { written, corrected }
}

/**
 * 写入侧管线工厂：挂载 session/event 监听。
 * @param {object} ctx 插件上下文（需已 inject 'tools' 等；仅用于注册监听与 refiner 的 ctx.llm）
 * @param {{ store, getCfg, wsRegistry, logStore }} deps
 */
export function attachWritePipeline(ctx, { store, getCfg, wsRegistry, logStore }) {
  // 防循环：按会话缓存消息文本，turn/end 沉淀
  const turnCache = new Map() // sessionId -> { turn, userTexts, assistantTexts, writtenTurns }
  // 轮次号兜底（EAC 5.3 适配）：0.1.2 内核的 session/event 'user/message' data 直接是
  // UserMessage（无 turn 字段），用每会话最近一次显式 turn（turn/start / assistant/message
  // / turn/end 携带）兜底，保证新旧内核轮次聚合一致。
  const lastTurn = new Map() // sessionId -> turn
  // 管家：写入计数 + 巡检在途保护
  const hkState = { writtenSinceCheck: 0, inFlight: false }

  // 提取串行队列（v0.12）：提取走思考档后，单次可能跑满时间预算（默认 2 分钟，续跑更久），
  // 多轮并发会互相抢流、打爆供应商配额。这里**串行执行 + 有界排队**：超限丢最旧的任务
  // （保留最近的对话，旧轮次价值本来就低），并把丢弃记进日志，避免"悄悄什么都没写"。
  const MAX_EXTRACT_QUEUE = 12
  const extractQueue = []
  let extractRunning = false
  // 会话级累积（v0.12.2）：逐轮提取记的是"这一轮发生了什么"，记不了"整段会话最后落在哪里"。
  // 这里按会话攒轮次，够了就做一次汇总。
  const sessionTurns = new Map() // sessionId -> [{ user, assistant }]
  const enqueueExtract = (job) => {
    extractQueue.push(job)
    while (extractQueue.length > MAX_EXTRACT_QUEUE) {
      extractQueue.shift()
      logStore('warn', 'write.queue.dropped', { pending: extractQueue.length, max: MAX_EXTRACT_QUEUE })
    }
    if (extractRunning) return
    extractRunning = true
    void (async () => {
      try {
        while (extractQueue.length > 0) {
          const next = extractQueue.shift()
          try { await next() } catch (err) {
            logStore('error', 'write.queue.job_failed', { err: err.message })
          }
        }
      } finally { extractRunning = false }
    })()
  }

  /** 阶段三⑥：管家自动巡检（写入量 + 时间双驱动，与对话轮数解耦）。
   *  仅在真实沉淀（add/update 成功）后计数；inFlight 防并发双巡检。 */
  const maybeHousekeeping = () => {
    const hk = getCfg().housekeeping ?? {}
    if (hk.enabled === false || hkState.inFlight) return
    hkState.writtenSinceCheck++
    const lastAt = Number(store.getMeta('last_housekeeping_at') ?? 0)
    const due = hkState.writtenSinceCheck >= (hk.interval ?? 20)
      || (Date.now() - lastAt > (hk.maxIntervalHours ?? 24) * 3600 * 1000)
    if (!due) return
    hkState.inFlight = true
    void (async () => {
      try {
        // v0.12.1：管家从"只报告"升级为**真治理**（autoApply，默认开）。
        // 自动档只做安全动作——近乎重复直接合并、陈旧情景快照归档；**LLM 归并不在后台跑**
        // （它要花模型额度，交给用户在 memory_housekeeping 里显式开启 consolidate）。
        // 所有动作只归档不删除，memory_archive 可恢复。
        const autoApply = hk.autoApply !== false
        const r = await store.housekeeping({
          dedupThreshold: hk.dedupThreshold ?? 0.92,
          agingDays: hk.agingDays ?? 30,
          autoMergeThreshold: hk.autoMergeThreshold ?? 0.95,
          archiveEpAfterDays: autoApply ? (hk.archiveEpAfterDays ?? 45) : 0,
          dryRun: !autoApply,
          limit: 20,
        })
        // 治理留痕（v0.12.1）：把"这次做了什么"写进 meta，预热时附一行——
        // 用户说"维护和整合我没有明显感觉"，一半原因就是它从来没出现在视野里。
        if (autoApply && (r.merged > 0 || r.archivedEp > 0)) {
          const summary = `合并近乎重复 ${r.merged} 组、归档陈旧情景快照 ${r.archivedEp} 条`
          store.setMeta('last_governance', JSON.stringify({ at: Date.now(), merged: r.merged, archivedEp: r.archivedEp, summary }))
          logStore('info', 'housekeeping.applied', { merged: r.merged, archivedEp: r.archivedEp, duplicates: r.duplicates.length, aging: r.aging.length })
        }
        // 阶段四：事件检测（派生数据全量重建，不碰记忆本体）
        const evCfg = getCfg().events ?? {}
        if (evCfg.enabled !== false) {
          try {
            const evs = store.detectEventsIncremental((evCfg.gapHours ?? 2) * 3600 * 1000)
            if (evs.length > 0) console.log(`[dsh-memory] 事件增量检测: ${evs.length} 个新/更新事件（gap ${evCfg.gapHours ?? 2}h）`)
            logStore('info', 'events.detect', { count: evs.length, gapHours: evCfg.gapHours ?? 2 })
          } catch (err) {
            logStore('error', 'events.detect.failed', { err: err.message })
            console.warn(`[dsh-memory] 事件检测失败（不影响主流程）: ${err.message}`)
          }
        }
        // before 边方向修正（派生数据：倒挂边断开重建，历史审计发现的 4/84 方向错误自动自愈）
        try {
          const n = store.fixBeforeDirections()
          if (n > 0) console.log(`[dsh-memory] before 边方向修正: ${n} 条倒挂边已重建`)
          if (n > 0) logStore('info', 'links.fix', { fixed: n })
        } catch (err) {
          logStore('error', 'links.fix.failed', { err: err.message })
          console.warn(`[dsh-memory] before 边修正失败（不影响主流程）: ${err.message}`)
        }
        const notes = []
        if (r.duplicates.length > 0) notes.push(`近重复 ${r.duplicates.length} 对（最高 ${r.duplicates[0].sim}）`)
        if (r.aging.length > 0) notes.push(`老化候选 ${r.aging.length} 条`)
        if (r.merged > 0) notes.push(`已合并 ${r.merged} 组`)
        if (r.archivedEp > 0) notes.push(`已归档情景快照 ${r.archivedEp} 条`)
        if (notes.length > 0) console.log(`[dsh-memory] 管家巡检: ${notes.join('，')}（${autoApply ? '已自动治理，只归档不删除' : '只报告未动手'}；memory_housekeeping 可查看详情）`)
        logStore('info', 'housekeeping', { duplicates: r.duplicates.length, aging: r.aging.length })
      } catch (err) {
        console.warn(`[dsh-memory] 管家巡检失败（不影响主流程）: ${err.message}`)
      } finally {
        hkState.writtenSinceCheck = 0
        hkState.inFlight = false
        try { store.setMeta('last_housekeeping_at', Date.now()) } catch { /* 元数据写入失败忽略 */ }
      }
    })()
  }

  ctx.on('session/event', async (session, event) => {
    const cfg = getCfg()
    if (!cfg.features.autoWrite) return
    // 轮次号追踪（EAC 5.3 适配）：带显式 turn 的事件先更新兜底值
    if (Number.isInteger(event.data?.turn)
      && (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'assistant/message')) {
      lastTurn.set(session.id, event.data.turn)
    }
    if (event.type === 'user/message') {
      // 防循环：只缓存真实用户消息（注入/合成上下文不沉淀为记忆原料）
      if (event.data?.source?.kind !== 'user') return
      const text = messageText(event.data)
      if (!text) return
      // user/message 的 data 直接是 UserMessage（新内核无 turn），用 lastTurn 兜底
      const turn = Number.isInteger(event.data?.turn) ? event.data.turn : (lastTurn.get(session.id) ?? 0)
      let c = turnCache.get(session.id)
      if (!c || c.turn !== turn) c = { turn, userTexts: [], assistantTexts: [], writtenTurns: new Set() }
      c.userTexts.push(text)
      turnCache.set(session.id, c)
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data.message)
      if (!text) return
      const turn = event.data.turn ?? 0
      let c = turnCache.get(session.id)
      if (!c || c.turn !== turn) c = { turn, userTexts: [], assistantTexts: [], writtenTurns: new Set() }
      c.assistantTexts.push(text)
      turnCache.set(session.id, c)
    } else if (event.type === 'turn/end') {
      try {
        const c = turnCache.get(session.id)
        if (!c) return
        const turn = event.data.turn
        if (c.writtenTurns.has(turn)) return
        c.writtenTurns.add(turn)
        // 写入 scope：按会话工作目录自动分层（项目隔离，v0.9.4）；
        // 画像（profile）固定 global（"用户是谁"跨项目适用）
        const writeScope = (type) => (type === 'profile' ? 'global' : scopeOf(session, wsRegistry))
        // 阶段二：遗忘曲线低频衰减（每轮一次，惰性幂等）
        try { store.decayExpired() } catch { /* 衰减失败不影响主流程 */ }
        const userPart = c.userTexts.join('\n').trim()
        const assistantPart = c.assistantTexts.at(-1)?.trim() ?? ''
        if (!userPart && !assistantPart) return
        const content = truncate(`任务: ${userPart || '(无显式用户消息)'}\n结果: ${assistantPart || '(无输出)'}`, 2000)
        // v0.12：规则路径的关键词也过泛词/虚词过滤（旧实现直接 tokenize 取 40 个，
        // 把"现在/什么/这个/用户"塞进关键词污染检索与图谱实体）
        const keywords = pickKeywords(`${userPart} ${assistantPart}`, 40)
        // 价值门（规则）：无内容 → 跳过；寒暄空转 → 跳过；内容过短 → 跳过；
        // 无用户消息的自主轮次 → 仅当输出含成果信号才沉淀（过滤思考中间态噪音）
        if (cfg.features.valueGate) {
          if (!userPart && !assistantPart) { logStore('warn', 'write.skipped', { reason: 'empty', scope: writeScope('ep') }); return }
          if (isTrivialTurn(userPart, assistantPart)) { logStore('warn', 'write.skipped', { reason: 'trivial', scope: writeScope('ep') }); return }
          if (content.length < 20 && keywords.length === 0) { logStore('warn', 'write.skipped', { reason: 'too-short', scope: writeScope('ep') }); return }
          if (!userPart && !OUTCOME_RE.test(assistantPart)) { logStore('warn', 'write.skipped', { reason: 'no-outcome', scope: writeScope('ep') }); return }
        }
        // refiner 开启：LLM 蒸馏有效记忆（串行队列，失败降级规则路径）
        if (cfg.refiner.enabled) {
          // 价值预判只挡"明显没东西"的轮次（v0.12 阈值由 40/3 放宽到 20/0）——
          // 用户要求"全部走思考档"，所以除极短轮次外一律送 LLM，让模型来判断值不值得记
          if (content.length < 20 && keywords.length === 0) {
            await upsertMemory(store, cfg.features, { layer: 'ep', scope: writeScope('ep'), content, keywords })
            logStore('info', 'write.prefiltered', { reason: 'too-short', scope: writeScope('ep') })
            maybeHousekeeping()
          } else {
            enqueueExtract(async () => {
              try {
                // v0.12.2 纠正识别：先把库里已有的相关记忆捞出来交给模型，让它能判断
                // "这一轮是在推翻旧的"还是"新增"。库内长期存在新旧并存的矛盾记忆
                // （身高、家庭关系、择偶倾向都出现过"旧记 + 更正记"），根子就是提取时看不见库里写了什么。
                let known = []
                try {
                  known = await store.search(userPart || assistantPart, {
                    scope: [scopeOf(session, wsRegistry), 'global'],
                    limit: 5,
                    minScore: 0,
                  })
                } catch { /* 检索失败按"无已知记忆"处理，不影响提取 */ }
                const knownIds = new Set(known.map((m) => m.id))
                const extracted = await extractWithLlm(ctx, cfg, userPart, assistantPart, { known, sessionId: session.id })
                const items = Array.isArray(extracted?.items) ? extracted.items : []
                if (items.length === 0) {
                  // 模型的判断是"这轮不值得记"（寒暄/过程/无实质输出）——这是有效结论，
                  // 记日志不写库。v0.12 起这是**正常路径**，不再降级成原始文本入库。
                  logStore('info', 'write.no_value', {
                    scope: writeScope('ep'),
                    analysis: (extracted?.analysis ?? '').slice(0, 200),
                    meta: extracted?.meta,
                  })
                  return
                }
                // v0.12 多条目 + v0.12.2 纠正：带 supersedes 的条目走"更新既有记忆"分支
                const { written, corrected } = await applyExtractedItems(store, cfg.features, items, {
                  knownIds, writeScope, logStore,
                })
                // analysis（模型的判断过程）+ meta（几次调用/是否续跑/是否被掐断/思考字数）
                // 一并落日志：提取"想了什么"从此可审计，而不是黑箱
                logStore('info', 'write.refined', {
                  type: items[0].type, abstract: items[0].abstract ?? '', theme: items[0].theme ?? '',
                  scope: writeScope(items[0].type),
                  route: `${cfg.refiner?.provider ?? '?'}/${cfg.refiner?.model ?? '?'}`,
                  items: items.length,
                  written,
                  corrected,
                  known: known.length,
                  content: items[0].content.slice(0, 80),
                  analysis: (extracted.analysis ?? '').slice(0, 300),
                  meta: extracted.meta,
                })
                maybeHousekeeping()
              } catch (err) {
                console.warn(`[dsh-memory] LLM 提取失败，降级规则路径: ${err.message}`)
                await upsertMemory(store, cfg.features, { layer: 'ep', scope: writeScope('ep'), content, keywords })
                // route 一并落日志（v0.11.1）：失败必须能归因到具体供应商/模型——
                // 2026-09-17 就是靠这行才看清「deepseek-official 余额 402」在 100% 静默降级
                logStore('warn', 'write.fallback', { err: err.message, route: `${cfg.refiner?.provider ?? '?'}/${cfg.refiner?.model ?? '?'}`, scope: writeScope('ep') })
                maybeHousekeeping()
              }
            })
          }
        } else {
          await upsertMemory(store, cfg.features, { layer: 'ep', scope: writeScope('ep'), content, keywords })
          logStore('info', 'write', { layer: 'ep', scope: writeScope('ep'), content: content.slice(0, 80) })
          maybeHousekeeping()
        }
        // v0.12.2 会话级汇总：逐轮碎片之外，还要有"整段会话最后落在哪里"。
        // 攒够 rounds 轮就把这批轮次交回模型总结一次；汇总后清空累积，避免重复提交。
        const ss = cfg.sessionSummary ?? {}
        if (cfg.refiner.enabled && ss.enabled !== false && (userPart || assistantPart)) {
          const acc = sessionTurns.get(session.id) ?? []
          acc.push({ user: userPart.slice(0, 800), assistant: assistantPart.slice(0, 800) })
          if (acc.length >= (ss.rounds ?? 12)) {
            sessionTurns.set(session.id, [])
            const snapshot = acc
            enqueueExtract(async () => {
              try {
                const out = await summarizeSessionWithLlm(ctx, cfg, snapshot, session.id)
                for (const item of out.items) {
                  await upsertMemory(store, cfg.features, {
                    layer: item.layer === 'ep' ? 'ep' : 'sm',
                    type: item.type,
                    scope: writeScope(item.type),
                    content: truncate(item.content, 2000),
                    keywords: (item.keywords?.length ? item.keywords : pickKeywords(item.content)).slice(0, 40),
                    aspect: item.aspect ?? '',
                    abstract: item.abstract ?? '',
                    theme: item.theme ?? '',
                  })
                }
                logStore('info', 'write.session_summary', {
                  rounds: snapshot.length, items: out.items.length,
                  scope: writeScope('sm'), analysis: out.analysis.slice(0, 300), meta: out.meta,
                })
                if (out.items.length > 0) maybeHousekeeping()
              } catch (err) {
                logStore('warn', 'write.session_summary_failed', { err: err.message, rounds: snapshot.length })
              }
            })
          } else {
            sessionTurns.set(session.id, acc)
          }
        }
      } catch (err) {
        logStore('error', 'write.failed', { err: err.message })
        console.warn(`[dsh-memory] 写入管线异常（已隔离，不影响 dsh）: ${err.message}`)
      }
    }
  })
}
