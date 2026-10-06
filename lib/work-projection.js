/**
 * 工作上下文投影（v0.15.3）：官方 sessionProjections 的一个 host-only 单元。
 *
 * **为什么需要它**：v0.9.23 起的「自主轮次 query 兜底」读的是 `agent.session.events`——
 * 内核的 Session 上从来没有这个属性（真源是日志，且 `eventAt`/`snapshotEvents`/`ownEvents`
 * 三个同步读者已被官方废弃，见
 * `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`），
 * 于是恒返空串 ⇒ 凡「没有真实用户文本的步」（工具调用步、自主轮次、goal 长任务）永远拿不到
 * 检索 query，注入在 `if (!queryText && pinned.pins.length === 0) return next()` 处静默早退。
 * 这与 pre-step 步号那处是**同一类错误**：读一个内核从未提供的属性，然后拿"空"当"没有"。
 *
 * **修法照官方活样本** `@deepseek-ai/dsh-time-context/lib/index.js:181-219`：注册一个投影单元，
 * 由框架订阅 `session/event` 并把每个已提交事件折叠进来；插件侧只在 pre-step 读 `stateOf()`，
 * 自己**不持有任何订阅、不回看历史日志**。
 *
 * **手册约束**（docs/subsystems/session-projection.zh.md）：
 *   · `:20` 单元函数必须**同步**，`state` 必须是**纯 JSON**（持久化缓存的前提）；
 *   · `:45` 纯转移：不关心的事件**必须返回同一引用**（`Object.is` 不变 → 下游零工作量）；
 *   · `:106` 领域插件在 `ctx.inject(['sessionProjections'], …)` 下注册，因此不带注册表的
 *     headless 组装完全不受影响 —— 本模块据此做**可选注册**（见 attachWorkProjection）；
 *   · `:106` cell 惰性构建：注册晚于事件流过时，首次触达会从 `init` 起在内存日志上补折叠，
 *     所以插件加载前已有的会话历史也能被读到。
 */

import { messageText, stripInjectedNoise } from './util.js'

/** 投影 key（host-only：不 wire，客户端看不到，因此不需要 viewSchema）。 */
export const WORK_PROJECTION_KEY = 'memoryWork'

/**
 * 持久化缓存失效版本（内核 `session-projection/src/index.ts:270` 要求非负整数，
 * 同 key 不同版本直接 throw）：state 字段或折叠语义一变就必须 +1，
 * 否则旧缓存会被前向折叠成垃圾。
 */
export const WORK_PROJECTION_VERSION = 1

/** 保留最近多少条消息、单条截断多少字符（工作上下文只要"最近在忙什么"，不是全文）。 */
export const WORK_KEEP = 6
export const WORK_ITEM_CHARS = 400
/** 工作 query 的默认总长上限（与检索侧对 userText 的量级保持一致）。 */
export const WORK_QUERY_LIMIT = 800

/**
 * 状态 schema（ZodType 鸭子类型）。
 *
 * 内核只在**用持久化缓存播种折叠**时调用它（`session-projection/src/index.ts:142` 的内部
 * 类型就是 `{ parse(value: unknown): unknown }`，调用点 `:462` / `:521`）——所以不必为它引入
 * zod 依赖（本项目依赖只有 sqlite-vec）。`parse` **总返回一个合法状态**（脏字段就地清洗）：
 * 缓存损坏时抛错会把整条投影驱动带崩，而降级成"少几条工作文本"没人会疼。
 */
export const workStateSchema = {
  parse(value) {
    const raw = Array.isArray(value?.recent) ? value.recent : []
    const recent = []
    for (const item of raw) {
      const role = item?.role
      const text = typeof item?.text === 'string' ? item.text : ''
      if ((role === 'user' || role === 'assistant') && text) recent.push({ role, text })
    }
    return { recent: recent.slice(-WORK_KEEP) }
  },
}

/** 空日志 / 新会话的初始状态（init 的 header 与 inheritedEventCount 参数这里用不上）。 */
export function workProjectionInit() {
  return { recent: [] }
}

/** 追加一条并维持环形缓冲（超出 WORK_KEEP 丢最旧）。 */
function pushWork(state, role, text) {
  const recent = state.recent.slice(-(WORK_KEEP - 1))
  recent.push({ role, text })
  return { recent }
}

/**
 * 纯转移：一个已提交会话事件 → 新状态（不关心的事件返回**同一引用**）。
 *
 * 只收「人话」：`user/message` 用**白名单** `source.kind === 'user'`，其余（插件注入块）一律跳过。
 * v0.15.3 修正：内核 v4 里第三方插件的 producer kind 是 `plugin:<插件名>`（producerKind() 的
 * 兜底分支），v3 的裸 `'plugin'` 是已退役写法。旧代码按 `=== 'plugin'` 黑名单排除 → 在 v4 下
 * **永远匹配不到**，自己的注入块会被当成人话收进上下文，工具步的检索 query 变成插件回声。
 * 与 `assistant/message` 一起构成"人话"的两个来源。工具结果不进上下文：内容长且噪音大。
 *
 * @param {{recent: Array<{role: string, text: string}>}} state 覆盖此前全部事件的状态
 * @param {{type?: string, data?: object}} event 下一个已提交会话事件
 * @returns {{recent: Array<{role: string, text: string}>}} 新状态（同引用 = 本单元不关心）
 */
export function workProjectionApply(state, event) {
  const prev = state?.recent ? state : workProjectionInit()
  const type = event?.type
  if (type === 'user/message') {
    const msg = event.data
    if (msg?.source?.kind !== 'user') return prev
    const text = stripInjectedNoise(messageText(msg)).slice(0, WORK_ITEM_CHARS)
    if (!text) return prev
    return pushWork(prev, 'user', text)
  }
  if (type === 'assistant/message') {
    // 两种事件形状都见过：data 就是消息本体，或 data.message 才是（见旧实现的 `ev.data?.message`）
    const msg = event.data?.message ?? event.data
    const text = stripInjectedNoise(messageText(msg)).slice(0, WORK_ITEM_CHARS)
    if (!text) return prev
    return pushWork(prev, 'assistant', text)
  }
  return prev
}

/**
 * 从投影 state 提取检索 query（最近的 user/assistant 文本，时间序拼接后截断）。
 * 纯函数：调用方负责把 `stateOf()` 的结果取来（见 attachWorkProjection）。
 *
 * @param {{recent?: Array<{text: string}>} | null | undefined} state 投影状态
 * @param {number} limit 总长上限
 * @returns {string} 空 state → 空串（调用方据此回落到"没有工作文本"）
 */
export function extractWorkText(state, limit = WORK_QUERY_LIMIT) {
  const recent = state?.recent
  if (!Array.isArray(recent) || recent.length === 0) return ''
  const parts = []
  let total = 0
  for (let i = recent.length - 1; i >= 0 && total < limit; i--) {
    const text = recent[i]?.text
    if (!text) continue
    parts.unshift(text)
    total += text.length
  }
  return parts.join('\n').slice(0, limit)
}

/**
 * 注册工作上下文投影单元，返回只读句柄 `{ available, read(session) }`。
 *
 * 用 `ctx.inject(['sessionProjections'], …)` 做**可选注册**（手册 `:106` 推荐的领域插件姿势）：
 * 内核没有这个注册表时（headless 组装、更老的内核）回调不执行，句柄保持 `read === null`，
 * 注入侧退回「没有工作文本」——插件其余功能照常，不会因缺一项能力整包起不来。
 *
 * @param {object} ctx 插件上下文（需具备 ctx.inject）
 * @returns {{available: boolean, read: ((session: object) => object | null) | null}} 句柄
 */
export function attachWorkProjection(ctx) {
  const handle = { available: false, read: null }
  try {
    ctx.inject(['sessionProjections'], (scoped) => {
      scoped.sessionProjections.register({
        key: WORK_PROJECTION_KEY,
        stateVersion: WORK_PROJECTION_VERSION,
        stateSchema: workStateSchema,
        init: workProjectionInit,
        apply: workProjectionApply,
      })
      handle.available = true
      handle.read = (session) => {
        try {
          return scoped.sessionProjections.stateOf(session, WORK_PROJECTION_KEY) ?? null
        } catch {
          return null
        }
      }
    })
  } catch (err) {
    console.warn(`[dsh-memory] 工作上下文投影注册失败（工具步将退回不注入）: ${err?.message ?? err}`)
  }
  return handle
}
