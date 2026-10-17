/**
 * 会话静置后的批量提取（v0.20.0，批次 2）。
 *
 * **为什么要重做**：旧的 turn/end 逐轮提取，一轮一提、提了直接入库，
 * 同一件事在长会话里会被切成几十条碎片（实测 749 条里 420 条写入后从未被检索）。
 *
 * **新流程**（设计见 docs/记忆整理/B-提取重做.md）：
 *   ① 会话静置满 idleHours（默认 12h）→ 触发
 *   ② 按分段切整段会话（每段最多 segmentTurns 轮）分批读
 *   ③ 每段提取候选 → 进 memory_candidates（**不进 memories**）
 *   ④ 候选池按 signature 分桶，同桶攒够 minSessions 个不同会话 → 归纳成一条
 *   ⑤ 归纳结果写入 memories
 *
 * **粒度依据**（MemOS，见 docs/记忆整理/C-MemOS架构调研.md）：
 * 算法只认「小步」和「任务」，「轮」不该进算法。这里用「会话」当任务边界，
 * 分段只是为了控制单次输入长度，不是为了按轮提取。
 */

import { scopeOf, truncate } from './util.js'
import { extractWithLlm, pickKeywords } from './refiner.js'

/** 默认静置阈值：2 小时**无新消息**（主人 2026-10-17 定；先定 12h，后改 2h）。 */
export const DEFAULT_IDLE_HOURS = 2
/** 单段最多几轮（控制单次 LLM 输入长度）。 */
export const DEFAULT_SEGMENT_TURNS = 12
/** 归纳门槛：同 signature 桶至少来自几个不同会话。 */
export const DEFAULT_MIN_SESSIONS = 2

/**
 * 把累积的会话轮次切成段。
 *
 * 分段理由：一次会话可能有几百轮，全部塞给模型既超上下文也看不清重点。
 * 按轮数切段而不是按 token，是因为轮与轮之间长度差异大、按 token 切会把
 * 一轮劈成两半。
 *
 * @param {Array<{user: string, assistant: string}>} turns 累积的轮次
 * @param {number} size 每段轮数
 * @returns {Array<Array<{user: string, assistant: string}>>} 分段结果
 */
export function segmentTurns(turns, size = DEFAULT_SEGMENT_TURNS) {
  const list = Array.isArray(turns) ? turns : []
  const n = Math.max(1, Math.round(size) || DEFAULT_SEGMENT_TURNS)
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

/**
 * 候选的分桶键：主题 | 类型 | 首个关键词。
 *
 * 为什么用这三个：主题定领域、类型定性质、首个关键词（按稀有度排序后）定具体对象。
 * 同桶 = 讲同一类事，才值得归纳成一条。
 *
 * @param {{theme?: string, type?: string, keywords?: string[]}} item 候选条目
 * @returns {string} signature
 */
export function signatureOf(item) {
  const theme = String(item?.theme ?? '').trim().toLowerCase() || 'no-theme'
  const type = String(item?.type ?? 'note').trim().toLowerCase()
  const kw = Array.isArray(item?.keywords) && item.keywords.length > 0
    ? String(item.keywords[0]).trim().toLowerCase()
    : 'no-kw'
  return `${theme}|${type}|${kw}`
}

/**
 * 判断会话是否已经静置够久。
 *
 * @param {number} lastActiveAt 最后一次活动时间戳（ms）
 * @param {number} now 当前时间戳
 * @param {number} idleHours 静置阈值（小时）
 * @returns {boolean} 是否该触发提取
 */
export function isIdleEnough(lastActiveAt, now, idleHours = DEFAULT_IDLE_HOURS) {
  const hours = Number(idleHours)
  if (!Number.isFinite(hours) || hours <= 0) return false
  const last = Number(lastActiveAt)
  if (!Number.isFinite(last) || last <= 0) return false
  return now - last >= hours * 3600 * 1000
}

/**
 * 把一批候选归纳成一条正式记忆的内容。
 *
 * **为什么不让模型直接产出最终条目**：候选是逐段提取的碎片，模型在单段里
 * 看不到全局。归纳这一步给它同桶的全部候选，让它合成一条完整的。
 *
 * @param {object} ctx 插件上下文（需要 ctx.llm）
 * @param {object} cfg 配置
 * @param {string} signature 桶键
 * @param {Array<object>} items 同桶候选
 * @param {string} sessionId 用于 LLM 调用的会话 id
 * @returns {Promise<{content: string, type: string, theme: string, keywords: string[], abstract: string, analysis: string} | null>}
 */
export async function consolidateBucket(ctx, cfg, signature, items, sessionId) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return null
  // 只有一条时不必调模型，直接用原文
  if (list.length === 1) {
    const it = list[0]
    return {
      content: String(it.content ?? '').trim(),
      type: it.type || 'note',
      theme: it.theme || '',
      keywords: Array.isArray(it.keywords) ? it.keywords : [],
      abstract: it.abstract || '',
      analysis: 'single candidate, no consolidation needed',
    }
  }
  const ref = cfg.refiner ?? {}
  const body = list.map((it, i) => `[${i + 1}] ${truncate(it.content, 600)}`).join('\n')
  const prompt = `你是记忆整理器。下面是从同一段工作里分批提取出来的 ${list.length} 条候选记录，它们讲的是同一类事（分桶键：${signature}）。

你的任务：把它们**合成一条完整、可复用的记忆**。

要求：
1. 只保留有长期价值的内容；重复的、只对当次成立的、过程流水一律丢掉
2. 补齐因果与判据：为什么这么做、什么条件下成立、数字是多少
3. 一条讲一件完整的事，能直接照着做
4. 不要简单拼接，要真正整合——同一件事的多个侧面并成一套规则
5. 如果这些候选其实没有长期价值，返回 {"content": "", "skip": true}

候选记录：
${body}

输出严格 JSON（无其他文字、无 markdown 围栏）：
{"content": "合成后的内容", "type": "note|decision|preference|lesson|profile", "theme": "2-8字主题", "keywords": ["具体名词"], "abstract": "principle|event", "skip": false, "analysis": "一句话说明你怎么合的"}`
  try {
    const { llmStrictJson } = await import('./refiner.js')
    const { json } = await llmStrictJson(ctx, cfg, prompt, undefined, sessionId)
    if (!json || json.skip === true || !String(json.content ?? '').trim()) return null
    return {
      content: String(json.content).trim(),
      type: ['note', 'decision', 'preference', 'lesson', 'profile'].includes(json.type) ? json.type : (list[0].type || 'note'),
      theme: typeof json.theme === 'string' ? json.theme.trim().slice(0, 30) : (list[0].theme || ''),
      keywords: Array.isArray(json.keywords) ? json.keywords.filter((k) => typeof k === 'string').slice(0, 20) : (list[0].keywords || []),
      abstract: json.abstract === 'principle' || json.abstract === 'event' ? json.abstract : (list[0].abstract || ''),
      analysis: typeof json.analysis === 'string' ? json.analysis.slice(0, 300) : '',
    }
  } catch {
    return null
  }
}

/**
 * 跑一轮「候选池 → 归纳 → 入库」。
 *
 * 这是整个批量提取的最后一步：把攒够门槛的桶逐桶归纳，写进 memories，
 * 并把参与归纳的候选标记为已提升（不删除，便于溯源）。
 *
 * @param {object} deps { store, ctx, cfg, logStore }
 * @param {{minSessions?: number, maxBuckets?: number}} opts 选项
 * @returns {Promise<{buckets: number, promoted: number, skipped: number, written: number}>}
 */
export async function runConsolidation({ store, ctx, cfg, logStore }, opts = {}) {
  const minSessions = Number(opts.minSessions) || DEFAULT_MIN_SESSIONS
  const maxBuckets = Number(opts.maxBuckets) || 8
  const buckets = store.candidateBuckets({ minSessions }).slice(0, maxBuckets)
  const stat = { buckets: buckets.length, promoted: 0, skipped: 0, written: 0 }
  if (buckets.length === 0) return stat

  for (const bucket of buckets) {
    const items = store.listCandidates({ signature: bucket.signature, limit: 50 })
    if (items.length === 0) continue
    const sessionId = items[0].session_id
    let merged = null
    try {
      merged = await consolidateBucket(ctx, cfg, bucket.signature, items, sessionId)
    } catch (err) {
      logStore?.('warn', 'batch.consolidate_failed', { sig: bucket.signature, err: String(err?.message ?? err) })
    }
    if (!merged) {
      // 归纳不出东西 → 丢弃这批候选（判定为无长期价值），避免它们一直挂在池子里
      store.dropCandidates(items.map((it) => it.id))
      stat.skipped += items.length
      logStore?.('info', 'batch.dropped', { sig: bucket.signature, n: items.length })
      continue
    }
    const scopeHint = items.find((it) => it.scope_hint === 'global')?.scope_hint ?? ''
    const scope = merged.type === 'profile' ? 'global' : (scopeHint === 'global' ? 'global' : (items[0].scope || 'global'))
    let memoryId
    try {
      memoryId = await store.add({
        layer: 'sm',
        type: merged.type,
        scope,
        content: truncate(merged.content, 2000),
        keywords: merged.keywords?.length ? merged.keywords : pickKeywords(merged.content),
        abstract: merged.abstract,
        theme: merged.theme,
      })
    } catch (err) {
      logStore?.('warn', 'batch.write_failed', { sig: bucket.signature, err: String(err?.message ?? err) })
      continue
    }
    const n = store.promoteCandidates(items.map((it) => it.id), memoryId)
    stat.promoted += n
    stat.written++
    logStore?.('info', 'batch.promoted', {
      sig: bucket.signature, candidates: items.length, sessions: bucket.sessions,
      memory: memoryId, scope, theme: merged.theme, analysis: merged.analysis,
    })
  }
  return stat
}
