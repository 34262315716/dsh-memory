/**
 * 注入侧管线（原 lib/index.js apply 内的 pre-step 检索注入 + session-start 预热，v0.10 拆分为工厂）。
 * 职责：步距节流（每 N 步必检）+ 注入块 hash 去抖 + 防循环窗口 + token 预算 + KV 缓存友好注入。
 * 依赖经参数注入（store / getCfg / wsRegistry / logStore），状态由工厂闭包持有。
 */
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { estimateTokens, extractUserText, extractWorkText, formatNow, renderInjection, scopeOf, truncate } from '../util.js'

/**
 * agent 当前步号：会话内 step/start 事件数 + 1（pre-step 触发时当前步的 step/start 尚未 append）。
 * 与会话界面显示步数一致；插件重载不清零；多 agent 各自独立计数（v0.9.24）。
 */
function agentStepCount(agent) {
  const events = agent?.session?.events
  if (!Array.isArray(events)) return 0
  let n = 0
  for (const ev of events) if (ev?.type === 'step/start') n++
  return n + 1
}

/**
 * pre-step 检索注入工厂：挂载 agent/pre-step 监听。
 * KV 缓存友好：稳定块头 + 确定性排序 + append-only 尾部 + 溯源锚点（#mem-id）。
 */
export function attachInjectPipeline(ctx, { store, getCfg, wsRegistry, logStore }) {
  const recentInjected = new Map() // agentId -> [memId...]
  const lastHit = new Map() // agentId -> { step }（上次检索时的 agent 步号）
  const lastBlockHash = new Map() // agentId -> 注入块 hash
  const scope = getCfg().scope || 'global'

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const cfg = getCfg()
      if (!cfg.features.preStepInject) return next()
      const agentId = payload.agent.id
      // agent 真实步号（v0.9.24）：与界面步数一致，多 agent 独立，插件重载持续
      const step = agentStepCount(payload.agent)
      if (step === 0) return next()
      // query：优先真实用户文本；自主轮次（goal/后台，无用户消息）用会话最近工作上下文兜底
      const text = extractUserText(payload.messages) || extractWorkText(payload.agent)
      if (!text) return next()
      // 步距节流：距上次检索不足 stepInterval 步 → 跳过。
      // 步距到必检——同 query 也重检（库里可能有新记忆涌入）；重复注入由 blockHash 去抖兜底
      const last = lastHit.get(agentId)
      if (last && step - last.step < cfg.stepInterval) return next()
      lastHit.set(agentId, { step })
      // 3) 检索（异步：真嵌入下 query 向量为网络调用）——当前项目 scope + global 公共层（v0.9.4）
      //    profile boost（P0.1 画像召回）：画像 content 短/关键词少，RRF 中易被泛词长记忆碾压；
      //    乘 3 使其弱命中也能过注入门槛。仅注入路径生效，memory_search 工具不受影响。
      //    v0.10 abstraction 联动：principle ×1.5 优先、event ×0.7 降权（强相关才注入）
      //    ——"我怎么看待设计"优先于"设计了什么"（store.search boost 双维：type×abstract）
      const excluded = recentInjected.get(agentId) ?? []
      const hits = await store.search(text, {
        scope: [scopeOf(payload.agent, wsRegistry), 'global'],
        limit: 6,
        minScore: cfg.injectMinScore,
        excludeIds: excluded,
        boost: { profile: 3, principle: 1.5, event: 0.7 },
      })
      if (hits.length === 0) return next()
      // 4) token 预算：贪心装入
      const budget = cfg.injectMaxTokens
      let used = 0
      const picked = []
      for (const h of hits) {
        const cost = 8 + estimateTokens(h.content)
        if (used + cost > budget && picked.length > 0) break
        picked.push(h)
        used += cost
      }
      if (picked.length === 0) return next()
      // 5) 注入块 hash 去抖：检索出的内容与上次相同 → 不重复注入。
      //    v0.9.32 时间戳分离：去抖 hash 用**不带时间**的渲染（内容指纹），
      //    注入文本用**带时间**版本——内容没变不重复注入（v0.8.5 KV 友好原则），
      //    但每次真正注入时模型都会拿到当前时间，长会话时间认知不断锚定。
      const blockFp = renderInjection(picked, scope) // 去抖指纹：无时间戳
      const block = renderInjection(picked, scope, { withTime: true })
      const blockHash = createHash('sha1').update(blockFp).digest('hex')
      if (lastBlockHash.get(agentId) === blockHash) return next()
      lastBlockHash.set(agentId, blockHash)
      // 6) 注入（append-only 尾部；form='recall' 溯源）
      //    v0.10.1 修复：不再用 agent.inject()——它会把消息塞进 next-step 队列，
      //    记忆块在 AI 回复后被当作独立一步消费，模型被迫多答一轮（"AI 回复完记忆又注入"）。
      //    改为合并进本步 decision.messages（与 claimed/context 同一 step 内 append+生成）。
      const decision = await next()
      if (decision.kind === 'reject') return decision
      // 运行日志（v0.9.5）：检索与注入透明可见（v0.9.24 加 step 便于核对步距节奏）
      logStore('info', 'inject', {
        step,
        query: text.slice(0, 80),
        hits: hits.length,
        picked: picked.length,
        ids: picked.map((h) => h.id),
        scores: picked.map((h) => h.score),
        scope: scopeOf(payload.agent, wsRegistry),
      })
      // 7) 防循环窗口
      const window = [...excluded, ...picked.map((h) => h.id)]
      recentInjected.set(agentId, window.slice(-cfg.maxRecentPerAgent))
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
            content: [{ type: 'text', text: block }],
          }),
        ],
      }
    } catch (err) {
      console.warn(`[dsh-memory] 注入失败: ${err.message}`)
    }
    return next()
  })
}

/**
 * 会话预热工厂：挂载 agent/session-start 监听（画像优先 + 项目 scope 隔离）。
 */
export function attachPreheatPipeline(ctx, { store, getCfg, wsRegistry, logStore }) {
  ctx.on('agent/session-start', (payload) => {
    try {
      const cfg = getCfg()
      if (!cfg.features.preStepInject || !payload.agent) return
      // 画像：全 scope 直取（跨项目公共层，type=profile 过滤）
      const profiles = store.list({ layer: 'sm', type: 'profile', limit: 3 })
      // 非画像：当前项目 scope 优先（新记忆已分层），不足补 global（存量兼容）
      const cur = scopeOf(payload.agent, wsRegistry)
      // v0.10 principle 优先：非画像种子按 abstract 排序（principle 排前），
      // 预热时间认知的"我如何看待设计"先于"设计了什么"
      const rankAbstract = (a, b) => (b.abstract === 'principle' ? 1 : 0) - (a.abstract === 'principle' ? 1 : 0)
      const curScope = store.list({ layer: 'sm', scope: cur, limit: 5 }).filter((m) => m.type !== 'profile').sort(rankAbstract).slice(0, 2)
      const othersBase = store.list({ layer: 'sm', scope: 'global', limit: 5 }).filter((m) => m.type !== 'profile').sort(rankAbstract)
      const others = curScope.length < 2 ? [...curScope, ...othersBase.slice(0, 2 - curScope.length)] : curScope
      const seeds = [...profiles, ...others]
      if (seeds.length === 0) return
      const t = formatNow()
      logStore('info', 'preheat', { seeds: seeds.length, scope: cur, profiles: profiles.length, ts: t.local })
      const lines = [
        `[记忆] 会话预热（当前时间：${t.local} ${t.weekday} · 画像优先的长期记忆，由 dsh-memory 注入）`,
        ...seeds.map((s) => {
          const kind = s.type === 'profile' ? `画像${s.profile_aspect ? '·' + s.profile_aspect : ''}` : s.type
          return `- [${kind}] ${truncate(s.content, 200)}`
        }),
      ]
      payload.agent.inject(
        createUserMessage({
          source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
          content: [{ type: 'text', text: lines.join('\n') }],
        }),
      )
    } catch (err) {
      console.warn(`[dsh-memory] 会话预热失败: ${err.message}`)
    }
  })
}
