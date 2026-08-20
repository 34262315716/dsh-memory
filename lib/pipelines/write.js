/**
 * 写入侧管线（原 lib/index.js apply 内的会话写入逻辑，v0.10 拆分为工厂）。
 * 职责：turn/end 自动沉淀 + 价值门 + Jaccard 去重合并 + refiner 蒸馏 + 管家触发。
 * 依赖经参数注入（store / getCfg / wsRegistry / logStore），不触碰 apply 局部状态。
 */
import { jaccard, tokenize } from '../store.js'
import { extractWithLlm } from '../refiner.js'
import { OUTCOME_RE, messageText, scopeOf, truncate } from '../util.js'

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
    store.graphLink(id, entry.keywords.slice(0, 8))
    // 阶段三：before 时间链自动边（同实体跨记忆按时间演化）
    try { store.linkBefore(id) } catch { /* 图谱失败不影响主流程 */ }
  }
  return id
}

/**
 * 写入侧管线工厂：挂载 session/event 监听。
 * @param {object} ctx 插件上下文（需已 inject 'tools' 等；仅用于注册监听与 refiner 的 ctx.llm）
 * @param {{ store, getCfg, wsRegistry, logStore }} deps
 */
export function attachWritePipeline(ctx, { store, getCfg, wsRegistry, logStore }) {
  // 防循环：按会话缓存消息文本，turn/end 沉淀
  const turnCache = new Map() // sessionId -> { turn, userTexts, assistantTexts, writtenTurns }
  // 管家：写入计数 + 巡检在途保护
  const hkState = { writtenSinceCheck: 0, inFlight: false }

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
        const r = await store.housekeeping({
          dedupThreshold: hk.dedupThreshold ?? 0.92,
          agingDays: hk.agingDays ?? 30,
          dryRun: true,
          limit: 8,
        })
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
        if (notes.length > 0) console.log(`[dsh-memory] 管家巡检: ${notes.join('，')}（可调用 memory_housekeeping 查看/处理）`)
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
    if (event.type === 'user/message') {
      // 防循环：只缓存真实用户消息（注入/合成上下文不沉淀为记忆原料）
      if (event.data?.source?.kind !== 'user') return
      const text = messageText(event.data)
      if (!text) return
      const turn = event.data.turn ?? 0
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
        const keywords = [...tokenize(`${userPart} ${assistantPart}`)].slice(0, 40)
        // 价值门（规则）：无用户消息且无输出 → 跳过；内容过短 → 跳过；
        // 无用户消息的自主轮次 → 仅当输出含成果信号才沉淀（过滤思考中间态噪音）
        if (cfg.features.valueGate) {
          if (!userPart && !assistantPart) { logStore('warn', 'write.skipped', { reason: 'empty', scope: writeScope('ep') }); return }
          if (content.length < 20 && keywords.length === 0) { logStore('warn', 'write.skipped', { reason: 'too-short', scope: writeScope('ep') }); return }
          if (!userPart && !OUTCOME_RE.test(assistantPart)) { logStore('warn', 'write.skipped', { reason: 'no-outcome', scope: writeScope('ep') }); return }
        }
        // refiner 开启：LLM 蒸馏有效记忆（异步，失败降级规则路径）
        if (cfg.refiner.enabled) {
          // 价值预判：过短/无实词的低价值轮次不送 LLM（省成本），直接规则路径
          if (content.length < 40 || keywords.length < 3) {
            await upsertMemory(store, cfg.features, { layer: 'ep', scope: writeScope('ep'), content, keywords })
            maybeHousekeeping()
          } else {
            void (async () => {
              try {
                const extracted = await extractWithLlm(ctx, cfg, userPart, assistantPart)
                if (!extracted?.content) throw new Error('LLM 未返回内容')
                await upsertMemory(store, cfg.features, {
                  layer: extracted.layer === 'ep' ? 'ep' : 'sm',
                  type: extracted.type,
                  scope: writeScope(extracted.type),
                  content: truncate(extracted.content, 2000),
                  keywords: (extracted.keywords ?? [...tokenize(extracted.content)]).slice(0, 40),
                  aspect: extracted.aspect ?? '',
                })
                logStore('info', 'write.refined', { type: extracted.type, scope: writeScope(extracted.type), content: extracted.content.slice(0, 80) })
                maybeHousekeeping()
              } catch (err) {
                console.warn(`[dsh-memory] LLM 提取失败，降级规则路径: ${err.message}`)
                await upsertMemory(store, cfg.features, { layer: 'ep', scope: writeScope('ep'), content, keywords })
                logStore('warn', 'write.fallback', { err: err.message, scope: writeScope('ep') })
                maybeHousekeeping()
              }
            })()
          }
        } else {
          await upsertMemory(store, cfg.features, { layer: 'ep', scope: writeScope('ep'), content, keywords })
          logStore('info', 'write', { layer: 'ep', scope: writeScope('ep'), content: content.slice(0, 80) })
          maybeHousekeeping()
        }
      } catch (err) {
        logStore('error', 'write.failed', { err: err.message })
        console.warn(`[dsh-memory] 写入管线异常（已隔离，不影响 dsh）: ${err.message}`)
      }
    }
  })
}
