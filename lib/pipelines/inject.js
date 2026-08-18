/**
 * 注入侧管线（原 lib/index.js apply 内的 pre-step 检索注入 + session-start 预热，v0.10 拆分为工厂）。
 * 职责：步距节流 + 签名去抖 + 注入块 hash 去抖 + 防循环窗口 + token 预算 + KV 缓存友好注入。
 * 依赖经参数注入（store / getCfg / wsRegistry / logStore），状态由工厂闭包持有。
 */
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { estimateTokens, extractUserText, formatNow, renderInjection, scopeOf, truncate } from '../util.js'

/**
 * pre-step 检索注入工厂：挂载 agent/pre-step 监听。
 * KV 缓存友好：稳定块头 + 确定性排序 + append-only 尾部 + 溯源锚点（#mem-id）。
 */
export function attachInjectPipeline(ctx, { store, getCfg, wsRegistry, logStore }) {
  const recentInjected = new Map() // agentId -> [memId...]
  const lastSignature = new Map() // agentId -> { hash, step }
  const lastBlockHash = new Map() // agentId -> 注入块 hash
  let currentStep = 0
  const scope = getCfg().scope || 'global'

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const cfg = getCfg()
      if (!cfg.features.preStepInject) return next()
      currentStep++
      const text = extractUserText(payload.messages)
      if (!text) return next()
      const agentId = payload.agent.id
      // 1) 签名去抖：query 与上次相同 → 跳过（不查库不注入）
      const sig = createHash('sha1').update(text.slice(0, 500)).digest('hex')
      const last = lastSignature.get(agentId)
      if (last && last.sig === sig) return next()
      // 2) 步距节流：距上次全量检索不足 stepInterval 步 → 复用（直接跳过本次）
      if (last && currentStep - last.step < cfg.stepInterval) {
        // 中间步不注入（避免注入块抖动），但仍更新节流时间
        return next()
      }
      lastSignature.set(agentId, { sig, step: currentStep })
      // 3) 检索（异步：真嵌入下 query 向量为网络调用）——当前项目 scope + global 公共层（v0.9.4）
      const excluded = recentInjected.get(agentId) ?? []
      const hits = await store.search(text, {
        scope: [scopeOf(payload.agent, wsRegistry), 'global'],
        limit: 6,
        minScore: cfg.injectMinScore,
        excludeIds: excluded,
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
      // 5) 注入块 hash 去抖：与上次相同 → 不重复注入
      const block = renderInjection(picked, scope)
      const blockHash = createHash('sha1').update(block).digest('hex')
      if (lastBlockHash.get(agentId) === blockHash) return next()
      lastBlockHash.set(agentId, blockHash)
      // 6) 注入（append-only 尾部；form='recall' 溯源）
      payload.agent.inject(
        createUserMessage({
          source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
          content: [{ type: 'text', text: block }],
        }),
      )
      // 运行日志（v0.9.5）：检索与注入透明可见
      logStore('info', 'inject', {
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
      const curScope = store.list({ layer: 'sm', scope: cur, limit: 5 }).filter((m) => m.type !== 'profile').slice(0, 2)
      const others = curScope.length < 2
        ? [...curScope, ...store.list({ layer: 'sm', scope: 'global', limit: 5 }).filter((m) => m.type !== 'profile').slice(0, 2 - curScope.length)]
        : curScope
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
