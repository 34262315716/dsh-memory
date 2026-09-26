/**
 * LLM 蒸馏提取（原 lib/index.js extractWithLlm，v0.10 拆分独立）。
 *
 * v0.12 重做（2026-09-21）——两条教训催生的重写：
 *
 * ① 「关思考」关不掉：pi-ai 适配器把 `reasoningEffort: 'off'` 翻译成**省略 reasoning 参数**，
 *    于是由上游模型默认说了算。本机 opencode-go 的 deepseek-v4.1-flash 默认强制思考，
 *    把 maxTokens=800 全部吃成 reasoning（实测 reasoning_tokens=800、正文 0 字）→
 *    JSON.parse('') → 从 2026-09-16 起 **100% 蒸馏失败**，全部静默降级成规则路径。
 *    同样的坑 2026-09-08 踩过一次（v0.9.25 那次用「显式传 off」压下去，换模型即复发）。
 *    根治办法不是想办法关掉思考，而是：**不设 token 上限（思考想多久都行）+ 只用时间约束**。
 *
 * ② 掐断了要能接着写：单次调用有「时间预算」（默认 2 分钟），到点主动掐断，
 *    把**已经写出来的部分**原样带回去续跑（断点续思），直到 JSON 完整闭合或续跑轮数用尽。
 *    这样无论上游模型怎么变、思考多长，提取都不会再因为"预算不够"而整条丢失。
 */

import { truncate } from './util.js'
import { tokenize } from './store.js'

/** 单次调用时间预算（毫秒）：到点掐断 → 带已写内容续跑。0 = 不限时。 */
export const DEFAULT_TIME_BUDGET_MS = 120000
/** 续跑轮数上限（掐断/空输出后最多再发起几次）。 */
export const DEFAULT_MAX_CONTINUATIONS = 3
/**
 * v0.13.3 输入瘦身：单侧对话截断字数（9000 位上从 6000 降到 4000）。
 *
 * 依据：提取本质是**压缩**任务，输入越大，模型的通读成本与思考量一起涨——
 * 线上实测思考 14122 / 34052 / 45327 字，达到单次输入（约 13.5k 字）的 1~3.4 倍。
 * 一轮对话的"值得记"的信息几乎总在前几千字里，把整段原文全塞进去只买来更长的心算。
 */
export const DEFAULT_DIALOG_CHARS = 4000
/** 【库里已有记忆】每条截断字数（v0.13.3：220 → 120，只留判断"是否推翻"所需的骨架）。 */
export const DEFAULT_KNOWN_CHARS = 120
/** 【库里已有记忆】最多给几条（v0.13.3 新增上限，防检索结果变多后把输入撑爆）。 */
export const DEFAULT_KNOWN_TOP_N = 5
/** 续跑系统提示：接着写，别重来。 */
const CONTINUE_SYSTEM = '你是一位严谨的写作者。用户会给你一段被中断的、尚未写完的输出，你要从断点处直接续写剩余部分。只输出续写的内容，不要重复、不要总结、不要解释、不要加代码块标记。'
/** 跑题重试系统提示（v0.9.27 行为，保持不变）。 */
const RETRY_SYSTEM = '你只输出合法 JSON 本体。任何解释、前言、后语、散文、列表或代码块标记都会导致输出被整体丢弃。'

function clampInt(value, lo, hi, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/**
 * 宽松 JSON 解析：剥 markdown 围栏 → 剥前后叙述（取最外层 `{…}` 片段）。
 * 空串/纯叙述会抛错，由调用方决定续跑还是重试。
 */
export function parseJsonLoose(text, stats) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('LLM 输出为空')
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fence ? fence[1] : raw).trim()
  try {
    return JSON.parse(body)
  } catch { /* 继续：可能是前后带叙述的 JSON */ }
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1))
    } catch { /* 继续：可能被 max_tokens 截断（括号没闭合） */ }
  }
  // v0.12.7 截断修复：输出被 max_tokens 掐断时，JSON 往往只差几个闭合符号。
  // 退到「最后一个完整的顶层成员」再补全括号，能把已经写出来的 analysis 与 items 救回来，
  // 而不是把整条输出丢掉走降级路径（2026-09-23 实测：maxTokens=800 时 100% 命中这条）。
  const repaired = repairTruncatedJson(body)
  if (repaired !== null) {
    if (stats && typeof stats === 'object') stats.repaired = true
    return repaired
  }
  throw new Error('输出中没有可解析的 JSON 结构')
}

/**
 * 截断 JSON 修复：找出「最后一个闭合的顶层成员」的位置，截断后补全未闭合的括号。
 *
 * 只做结构补全，**不猜测、不编造内容**——补不齐就返回 null，交给调用方走续跑/重试。
 * @returns {object|Array|null}
 */
export function repairTruncatedJson(text) {
  const s = String(text ?? '')
  const start = s.indexOf('{')
  const startArr = s.indexOf('[')
  const from = start >= 0 && (startArr < 0 || start < startArr) ? start : startArr
  if (from < 0) return null
  const body = s.slice(from)

  // 扫描一遍：记住**最后一个完整容器闭合的位置**以及那一刻的未闭合层级。
  // 例：`{…,"items":[{条目1},{条目2 被截断` —— 最后一个完整容器是 `条目1` 的 `}`，
  // 那一刻还欠着 `]` 与 `}`，补上它们就能拿到「analysis + 条目1」。
  const stack = []
  let inStr = false
  let esc = false
  let cut = -1
  let stackAtCut = null
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']')
    else if (c === '}' || c === ']') {
      if (stack.length === 0) break   // 多余的闭合符：后面的内容不可信，停下
      stack.pop()
      cut = i
      stackAtCut = stack.slice()
    }
  }
  if (cut < 0 || stackAtCut === null) return null   // 一个完整容器都没有 → 救不回来
  let patched = body.slice(0, cut + 1)
  while (stackAtCut.length > 0) patched += stackAtCut.pop()
  try {
    return JSON.parse(patched)
  } catch {
    return null
  }
}

/**
 * 单次流式收集：正文与思考分轨，时间到即掐断，**已收到的内容一律保留**。
 *
 * 与旧实现的区别：
 *   - 认得 `reasoning-delta`（v0.12 之前只收 text-delta，思考流被整条丢掉）
 *   - 传 AbortSignal 做时间预算；掐断不算失败，返回已收内容供续跑
 *   - `maxTokens <= 0` 时不传该参数（不设上限，由时间预算兜底）
 *
 * @returns {Promise<{text: string, reasoning: string, finish: string|null, timedOut: boolean, error?: Error}>}
 */
async function streamCollect(ctx, cfg, { system, prompt, sessionId }) {
  const ref = cfg.refiner ?? {}
  const budgetMs = clampInt(ref.timeBudgetMs, 0, 600000, DEFAULT_TIME_BUDGET_MS)
  const maxTokens = Number(ref.maxTokens)
  const out = { text: '', reasoning: '', finish: null, timedOut: false, textChunks: 0, reasoningChunks: 0, otherChunks: 0, chunkTypes: [] }
  const ac = new AbortController()
  const timer = budgetMs > 0 ? setTimeout(() => ac.abort(), budgetMs) : null
  try {
    for await (const chunk of ctx.llm.stream({
      provider: ref.provider,
      model: ref.model,
      ...(ref.reasoningEffort ? { reasoningEffort: ref.reasoningEffort } : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      system,
      // v0.12：0 / 缺省 = 不传 maxTokens（不设上限）；只有显式正数才透传
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      // v0.12.5 根因修复（2026-09-23 实测对照）：DSH 调用时会带上会话的工具清单，
      // 模型看到有工具可用就**改用 tool_calls 而不输出正文**——实测带 tools 时
      // finish=tool_calls、正文 0 字；同一请求去掉 tools 后正常输出 265 字。
      // 提取是纯文本任务，必须显式清空工具表（adapter 只在 tools.length > 0 时才下发）。
      tools: [],
      // v0.12.6 根因修复：必须传 sessionId。dsh-llm-pi-ai 只在它存在时才给 opencode*
      // 路由加 x-opencode-session 头（上游要求，缺了直接 400）；该失败会被适配器转成
      // "usage + finish" 两块并且**不抛错**，表现为"模型没输出正文"。
      ...(sessionId ? { sessionId: String(sessionId) } : {}),
      signal: ac.signal,
    })) {
      if (!chunk) continue
      // v0.12.4 诊断：把收到过的块类型全记下来——正文为空时一眼看出适配器到底送来了什么
      // （是 block-start/usage/finish，还是压根没有 delta 块）
      if (chunk.type && !out.chunkTypes.includes(chunk.type)) out.chunkTypes.push(chunk.type)
      if (chunk.type === 'text-delta') { out.text += chunk.text ?? ''; out.textChunks++ }
      else if (chunk.type === 'reasoning-delta') { out.reasoning += chunk.text ?? ''; out.reasoningChunks++ }
      else if (chunk.type === 'finish') {
        out.finish = chunk.reason ?? null
        // v0.12.6：适配器把上游失败（400/配额/空响应）转成 {kind:'error',failure:{message,code}}
        // 的 finish 块，流照常结束——必须显式抓出来，否则真相永远看不见
        const reason = chunk.reason
        if (reason && typeof reason === 'object' && reason.kind === 'error') {
          out.finishError = reason.failure ?? { message: '适配器报告流以错误结束' }
        }
      }
      // v0.12.4 诊断：记下"收到过哪些非文本块"——正文为空时，靠它区分
      // "模型根本没吐正文" vs "吐了但类型不是 text-delta（适配器映射问题）"
      else out.otherChunks++
    }
  } catch (err) {
    // 掐断（时间到）不是错误：已收内容照样有效，交给续跑接上
    if (ac.signal.aborted) out.timedOut = true
    else out.error = err
  } finally {
    if (timer) clearTimeout(timer)
  }
  return out
}

/** 续跑提示：把已写内容原样交回，要求从断点续写。 */
function continuePrompt(originalPrompt, written, { hasReasoning = false } = {}) {
  if (!written.trim()) {
    // v0.12.4：思考型模型最常见的一种"空正文"是**想完了但没落笔**——
    // 提示词要针对这个说清楚，而不是笼统说"预算不够"。
    return hasReasoning
      ? `${originalPrompt}\n\n你上一轮的思考已经完成，但**正文一个字都没输出**。现在请只做一件事：把结论写成 JSON 正文输出。不要再思考、不要再解释，直接输出 JSON 本体。`
      : `${originalPrompt}\n\n你上一次没有输出任何正文。这次请直接给出结论 JSON 本体。`
  }
  return `${originalPrompt}\n\n你上一次的 JSON 因为时间或长度限制被中断了。你已经写出的部分如下：\n\n<<<已写开始\n${truncate(written, 12000)}\n已写结束>>>\n\n请**从断点处直接接着写**：不要重复上面被中断的内容，不要重新开始，只输出剩余部分，直到整个 JSON 完整闭合。`
}

/**
 * LLM 严格 JSON 输出（共享给自动沉淀提取与画像蒸馏、主题重命名）。
 *
 * v0.12 行为：
 *   - 不设 token 上限（`maxTokens<=0` 不传参），只用 `timeBudgetMs` 约束单次调用
 *   - 到点掐断 / 上游截断（finish=length）/ 正文为空 → **带已写内容续跑**（最多 maxContinuations 次）
 *   - 续跑后正文没变长 → 判定模型不肯续写，停止空转（不浪费配额）
 *   - 首次输出非 JSON（纯叙述，无 `{`）→ 沿用 v0.9.27 的强化指令重试一次
 *
 * @returns {Promise<{text: string, json: any, meta: object}>}
 */
export async function llmStrictJson(ctx, cfg, prompt, system = '你是严格的 JSON 输出器，只输出合法 JSON。', sessionId) {
  const ref = cfg.refiner ?? {}
  const maxCont = clampInt(ref.maxContinuations, 0, 8, DEFAULT_MAX_CONTINUATIONS)
  const meta = { attempts: 0, continuations: 0, timedOut: false, truncated: false, reasoningChars: 0, reasoningCharsTotal: 0, textChars: 0, textCharsTotal: 0, salvaged: false, textChunks: 0, reasoningChunks: 0, otherChunks: 0, lastFinish: null, maxTokens: Number(ref.maxTokens) || 0, repaired: false, proseRetry: false, calls: [] }
  let acc = ''
  let reasoning = ''

  const call = async (sys, text, { reset = false } = {}) => {
    meta.attempts++
    // v0.13.3：重试是要求模型**重写一份完整 JSON**，此时旧缓冲必须清掉。
    // 不清的后果被 test-refiner-slim.mjs 当场抓住：散文里夹着的 `{ 那个改法 }` 会把
    // 后面那份合法 JSON 一起毒死——parseJsonLoose 只会从**第一个** `{` 取到最后一个 `}`，
    // 于是"重试成功"也是假的（嗯，老代码同样有这个洞，只是旧判据根本走不到这里）。
    if (reset) { acc = ''; reasoning = '' }
    const startedAt = Date.now()
    const r = await streamCollect(ctx, cfg, { system: sys, prompt: text, sessionId })
    if (r.error) throw r.error
    if (r.finishError) {
      const f = r.finishError
      throw new Error(`提取调用被适配器判为失败：${f.message ?? '（无消息）'}${f.code ? `（${f.code}）` : ''}`)
    }
    if (r.timedOut) meta.timedOut = true
    // v0.12.7 修：finish 是**对象** `{kind}`，以前写成 `r.finish === 'length'`（拿对象比字符串）
    // → 恒为 false → `meta.truncated` 从来没被置过位，截断识别形同虚设。
    // 正确的 kind 是 'max-tokens'（见 dsh-llm-pi-ai 的 mapStopReason）。
    if (r.finish?.kind === 'max-tokens') meta.truncated = true
    acc += r.text ?? ''
    reasoning += r.reasoning ?? ''
    meta.reasoningChars = reasoning.length
    // v0.13.3：跨调用累计值。`reasoningChars` 只是**当前缓冲**的长度（重试会把它清零），
    // 想知道"这一次提取一共让模型想了多少字"，必须看 total——诊断线与日志都用它。
    meta.reasoningCharsTotal += (r.reasoning ?? '').length
    meta.textCharsTotal += (r.text ?? '').length
    // v0.12.4 诊断：正文/思考各收了几段、还收到过几个非文本块——失败时靠这组数字区分
    // "模型根本没吐正文" 与 "吐了、但适配器把它映射成了别的块类型"
    meta.textChunks += r.textChunks
    meta.textChars = acc.length
    meta.reasoningChunks += r.reasoningChunks
    meta.otherChunks += r.otherChunks
    meta.lastFinish = r.finish ?? null
    meta.chunkTypes ??= []
    for (const t of r.chunkTypes ?? []) if (!meta.chunkTypes.includes(t)) meta.chunkTypes.push(t)
    // v0.13.3 诊断：逐次调用单独记账。meta.reasoningChars 是**同一次提取里所有调用累加**的
    // （首调 + 续跑 + 重试都往里加），只看总数分不清"一次想太多"还是"重试把额度烧光了"。
    meta.calls ??= []
    meta.calls.push({
      n: meta.attempts,
      textChars: (r.text ?? '').length,
      reasoningChars: (r.reasoning ?? '').length,
      finish: fmtFinish(r.finish).kind,
      ms: Date.now() - startedAt,
    })
    return r
  }

  // v0.12.4 兜底：思考型模型有时把**结论整段写在思考里**、正文一个字不吐（线上实测形态）。
  // 思考流本身也是文本，里面常常已经包含完整 JSON —— 先试着从里面捞一次，比直接判失败强。
  const salvageFromReasoning = () => {
    if (acc.trim() || !reasoning.trim()) return null
    try {
      const j = parseJsonLoose(reasoning, meta)
      meta.salvaged = true
      return j
    } catch { return null }
  }

  await call(system, prompt)
  let parsed = null
  try { parsed = parseJsonLoose(acc, meta) } catch { /* 交给兜底/续跑/重试 */ }
  if (parsed !== null) return { text: acc, json: parsed, meta }
  parsed = salvageFromReasoning()
  if (parsed !== null) return { text: reasoning, json: parsed, meta }

  // 截断类（空输出 / 掐断 / 上游 length / JSON 已开头没闭合）→ 接着写。
  //
  // v0.13.3 修：老判据是 `acc.includes('{')` —— 只要正文里**出现过**一个 `{`，就当成"JSON 写了一半"。
  // 线上实测的形态恰恰相反：模型把判断写成了**散文**（正文 1854 字、finish=stop，纯叙述，
  // 里面顺手夹了个 `{`），于是 3 次续跑全在催它"接着写"，每次都要重新思考一遍，
  // 白烧 3 次调用（思考 4.5 万字里的大头就是它们）而且照样救不回来。
  // 现在的判据是"正文**已经在写 JSON**"：真在写才值得续；散文走下面的强化重试。
  const looksLikeJson = () => /^\s*[[{]/.test(acc) || /"(analysis|items|content|keywords)"\s*:/.test(acc)
  const truncatedLike = () => acc.trim() === '' || meta.timedOut || meta.truncated || looksLikeJson()
  while (meta.continuations < maxCont && truncatedLike()) {
    meta.continuations++
    const r = await call(CONTINUE_SYSTEM, continuePrompt(prompt, acc, { hasReasoning: reasoning.trim().length > 0 }))
    try { parsed = parseJsonLoose(acc, meta) } catch { /* 继续 */ }
    if (parsed !== null) return { text: acc, json: parsed, meta }
    parsed = salvageFromReasoning()
    if (parsed !== null) return { text: reasoning, json: parsed, meta }
    // 收敛：这次续跑一个字都没写出来 → 模型不肯接话，别再空转烧配额
    if (!String(r.text ?? '').trim()) break
  }

  // 跑题（没在写 JSON）→ 强化指令重试**一次**（v0.9.27 起；v0.13.3 把判据从"正文里没有 {"
  // 放宽成"正文没有在写 JSON"，并把提示词针对实测形态说清楚：判断写进 analysis，正文只给 JSON）。
  if (!looksLikeJson()) {
    meta.proseRetry = true
    const why = acc.trim() === ''
      ? '你上一次没有输出任何正文（不是合法 JSON）。'
      : '你上一次输出的是叙述文字，不是合法 JSON。'
    await call(RETRY_SYSTEM, `${prompt}\n\n${why}判断过程写进 analysis 字段，正文只给 JSON 本体：无散文、无解释、无 markdown 围栏。`, { reset: true })
    try {
      return { text: acc, json: parseJsonLoose(acc, meta), meta }
    } catch (err) {
      // 失败也要给足诊断——"LLM 输出为空"这种笼统错误正是这次要根治的痛点
      throw new Error(diagnose(err.message, meta))
    }
  }
  throw new Error(diagnose('输出里没有可解析的 JSON 结构', meta))
}

/**
 * finish.reason 可读化（v0.12.7 修）。
 *
 * 它是个**对象**（`{kind, failure?:{message,code}}`），以前直接塞进模板串，日志里只剩
 * `末次 finish=[object Object]` —— 2026-09-23 排查"提取失败"时，最关键的终止原因被自己吞掉了，
 * 只能靠另写探针复现才知道是 `max-tokens`。诊断信息不能是黑盒。
 */
export function fmtFinish(reason) {
  if (reason == null) return { kind: '', text: '无' }
  if (typeof reason === 'string') return { kind: reason, text: reason }
  const kind = String(reason.kind ?? '?')
  const message = reason.failure?.message
  const code = reason.failure?.code
  const parts = [kind]
  if (message) parts.push(message)
  if (code) parts.push(`code=${code}`)
  return { kind, text: parts.join('｜'), message, code }
}

/** 失败诊断：把"为什么解析不出来"讲清楚（正文段数/字数 / 思考字数 / 其他块 / 末次 finish / 是否被掐断）。 */
function diagnose(reason, meta) {
  const f = fmtFinish(meta.lastFinish)
  const hints = []
  if (f.kind === 'max-tokens') {
    const cur = Number(meta.maxTokens)
    hints.push('输出被 max_tokens 截断'
      + (Number.isFinite(cur) && cur > 0 ? `（当前 memory.refiner.maxTokens=${cur}）` : '')
      + '：强制思考的模型会把额度全花在 reasoning 上，正文就没了；把 memory.refiner.maxTokens 设为 0（不限制，由时间预算兜底）')
  }
  if (f.kind === 'error' && f.message) hints.push(`适配器报错：${f.message}${f.code ? `（${f.code}）` : ''}`)
  if (meta.timedOut) hints.push('曾撞到时间预算（timeBudgetMs）被掐断')
  if (meta.repaired) hints.push('曾尝试按截断修复 JSON')
  if (meta.proseRetry) hints.push('正文是叙述文字而不是 JSON（判断过程被写进了正文）——已按 v0.13.3 的强化指令重试一次')
  const perCall = Array.isArray(meta.calls) && meta.calls.length > 1
    ? `；逐次调用：[${meta.calls.map((c) => `#${c.n} 正文${c.textChars}字/思考${c.reasoningChars}字/${c.finish || '无 finish'}${c.ms ? `/${c.ms}ms` : ''}`).join('，')}]`
    : ''
  return `LLM 输出无法解析为 JSON（${reason}；尝试 ${meta.attempts} 次、续跑 ${meta.continuations} 次；`
    + `正文回包 ${meta.textChunks} 段（${meta.textCharsTotal ?? meta.textChars ?? 0} 字）/ 思考 ${meta.reasoningCharsTotal ?? meta.reasoningChars} 字（跨调用累计，逐次见下）/ 其他块 ${meta.otherChunks} 个；`
    + `末次 finish=${f.text}；收到的块类型=[${(meta.chunkTypes ?? []).join(',') || '无'}]`
    + perCall
    + (hints.length > 0 ? `；诊断：${hints.join('；')}` : '') + '）'
}

/**
 * 提取规则（v0.12）：让模型**先判断再写**，而不是把对话复述成一句话。
 *
 * 为什么要 analysis：v0.11 及以前的提取是「一次直出、单条、越简洁越好」——
 * 模型没有判断过程，写出来的是一句复述；而且一轮对话里的决策/偏好/教训被硬压成一条。
 * 现在要求先写判断（值不值得记、属哪一层、该保留什么关键约束），再产出 0-3 条条目。
 */
const EXTRACT_RULES = `先把判断想清楚，再写条目。**不要在思考里复述对话、也不要逐条复读下面的规则**，想清楚就直接写 JSON。

【analysis：1-2 句直给结论，不要展开论证、不要复述对话、不要自检规则】
- 这轮值不值得记？值得的话是什么性质：决策 / 结论 / 偏好 / 教训 / 关键事实 / 关于用户本人的稳定信息
- 写的时候必须保住哪些关键约束（数字、版本、路径、边界条件、前提、否定条件）——写漏了会让这条记忆在未来被误用
- 没有任何长期价值（寒暄、确认、纯过程、工具中间输出）→ 说明一句，items 给空数组

【items（0-3 条，每条独立、自包含、可单独读懂）】
硬性要求：
- content 必须自包含：脱离这轮对话也能看懂，不出现"上面""这次""刚才"这类指代
- content 必须带判据：写清数字/条件/边界/原因。禁止"优化了性能""改进了流程"这类没有信息量的空话
- 不写过程、不写元信息：不写"讨论了""尝试了""最终确定"，不出现"用户说""助手认为""对话中"
- 一条只讲一件事；性质不同的内容拆成多条（例如"定了方案 A" + "用户不接受方案 B"）
- 寒暄、确认性回复（你好/早上好/谢谢/继续/好的/嗯）、无实质输出的轮次 → items 必须是空数组，不要硬凑

字段取值：
- type ∈ note | decision | preference | lesson | profile
  （profile = 关于用户本人的稳定信息：身份/习惯/长期偏好/沟通方式/背景，与一次性 decision 区分）
- aspect ∈ identity | preference | habit | background | communication_style（仅 type=profile 填，其他填空串）
- layer ∈ sm（长期语义知识）| ep（一次性情景快照）
- abstract ∈ principle | event
  （principle = 可复用的方法/原则/经验/看法；event = 一次性具体事件/产出。
   能抽成通用原则的记 principle，即使它来自具体事件；纯事实记录是 event）
- keywords：3-8 个**具体名词实体**（技术栈/模块名/类名/文件名/版本号/专有名词），用于检索与图谱。
  不要动作泛词（完成/修复/实现/使用/优化/更新）、话题词（本项目/记忆系统/图谱/插件/DSH）、
  口语虚词（现在/什么/这个/没有/不是/一个/问题/用户/主人/继续）、2 字碎片词。
  宁可 3 个精准实体，也不要 10 个泛词
- theme：简短稳定的**名词标签**（2-8 字，概括内容所属领域，如"四级备考"/"AI绘画"/"dsh-memory 开发"）；
  不要句子、动词短语、标点或语气词；确实无法归类时填空字符串 ""`

/**
 * LLM 蒸馏提取：用独立配置的模型从一轮会话中提炼有效记忆（去噪、自包含、先判断后写）。
 *
 * 输出兼容两种形态（便于模型偶尔回到旧格式时不丢数据）：
 *   - v0.12：{ analysis, items: [{content, type, layer, keywords, aspect, abstract, theme}, ...] }
 *   - v0.11 及以前：{ content, type, layer, keywords, aspect, abstract, theme }
 *
 * @returns {Promise<{content, type, layer, keywords, aspect, abstract, theme, analysis, items, meta}>}
 *          顶层字段是 items[0]（兼容旧调用点），`items` 是完整数组（v0.12 多条目）
 */
export async function extractWithLlm(ctx, cfg, userPart, assistantPart, { known = [], sessionId } = {}) {
  // v0.12.2 纠正识别：把库里已有的相关记忆一并交给模型，让它判断这轮是"新增"还是"在推翻旧的"。
  // 为什么必须做：库内长期存在新旧并存的矛盾记忆（身高、家庭关系、择偶倾向都出现过"旧记 + 更正记"），
  // 根子就是提取时**看不见库里已经写了什么**——只能新建，没法纠正。
  const ref = cfg.refiner ?? {}
  const dialogChars = clampInt(ref.dialogChars, 500, 20000, DEFAULT_DIALOG_CHARS)
  const knownChars = clampInt(ref.knownChars, 40, 500, DEFAULT_KNOWN_CHARS)
  const knownMax = clampInt(ref.knownTopN, 1, 20, DEFAULT_KNOWN_TOP_N)
  const knownList = (Array.isArray(known) ? known.filter((m) => m?.id) : []).slice(0, knownMax)
  const knownBlock = knownList.length > 0
    ? `\n【库里已有的相关记忆】（判断这一轮是否在修正/推翻它们）\n${knownList.map((m) => `- ${m.id}｜${m.type}｜${truncate(m.content, knownChars)}`).join('\n')}\n\n规则：只有当某条旧记忆**已经不对了**（被这一轮推翻、更正、换掉了）时，才在对应 item 的 supersedes 里填它的 id（最多一条）；\n仅仅是"相关"或"补充了新信息但旧的仍然成立"的，supersedes 一律留空数组 []。宁可留空，不要误杀。\n`
    : '\n（本次没有检索到相关旧记忆，所有 item 的 supersedes 都留空数组 []）\n'
  const prompt = `你是记忆提取器。你的任务不是复述对话，而是**判断**这一轮对话里有什么值得进入长期记忆，然后把它写成一条能被未来准确复用的记录。

${EXTRACT_RULES}
${knownBlock}
输出严格 JSON（无其他文字、无 markdown 围栏）：
{"analysis": "...", "items": [{"content": "...", "type": "decision", "layer": "sm", "keywords": ["..."], "aspect": "", "abstract": "principle", "theme": "示例主题", "supersedes": []}]}

没有值得记的内容时输出：{"analysis": "（说明为什么不记）", "items": []}

对话：
[用户]
${truncate(userPart, dialogChars)}

[助手]
${truncate(assistantPart, dialogChars)}`

  const { json: parsed, meta } = await llmStrictJson(ctx, cfg, prompt, undefined, sessionId)
  const items = normalizeItems(parsed)
  const head = items[0] ?? {
    content: '',
    type: 'note',
    layer: 'sm',
    keywords: [],
    aspect: '',
    abstract: '',
    theme: '',
    supersedes: [],
  }
  return {
    ...head,
    analysis: typeof parsed?.analysis === 'string' ? parsed.analysis.trim().slice(0, 2000) : '',
    items,
    meta,
  }
}

/**
 * 会话级汇总（v0.12.2）：逐轮提取记的是"这一轮发生了什么"，它记不了"整段会话最后落在哪里"。
 *
 * 用户原话是"提取日常对话中的内容也需要方法流程上的优化"——缺的就是这一层：
 * 一晚上的讨论最终定了什么、否掉了什么，散在十几条碎片里，没人给结论。
 *
 * @param turns [{ user, assistant }] 本轮会话累积的轮次（已截断）
 * @returns {Promise<{analysis, items, meta}>}
 */
export async function summarizeSessionWithLlm(ctx, cfg, turns, sessionId) {
  const list = (turns ?? []).filter((t) => t && (t.user || t.assistant))
  if (list.length === 0) throw new Error('没有可汇总的轮次')
  const prompt = `下面是一段连续对话（共 ${list.length} 轮）。请总结**这段会话最后定下了什么**——不是复述过程，而是结论清单。

规则：
1. 只写**有结论的部分**：定了什么、改成了什么、否掉了什么、发现了什么；没有结论的闲聊、试探与过程一律不写
2. 每条自包含、带判据（数字/条件/边界/原因），不出现"讨论了/尝试了/这次会话"这类过程词
3. 最多 3 条；如果整段会话确实没有值得长期保留的结论，items 返回空数组
4. 与逐轮提取的区别：逐轮记的是"某一轮发生了什么"，你要记的是"**整段下来落在哪里**"——同一个决定被反复修改过，只写最后落定的那个

${EXTRACT_RULES}

对话：
${list.map((t, i) => `【第 ${i + 1} 轮】\n用户：${truncate(t.user ?? '', 500)}\n助手：${truncate(t.assistant ?? '', 500)}`).join('\n\n')}

输出严格 JSON（无其他文字、无 markdown 围栏）：
{"analysis": "...", "items": [{"content": "...", "type": "decision", "layer": "sm", "keywords": ["..."], "aspect": "", "abstract": "principle", "theme": "示例主题", "supersedes": []}]}`

  const { json: parsed, meta } = await llmStrictJson(ctx, cfg, prompt, undefined, sessionId)
  return {
    analysis: typeof parsed?.analysis === 'string' ? parsed.analysis.trim().slice(0, 2000) : '',
    items: normalizeItems(parsed),
    meta,
  }
}

/**
 * 归一化提取结果：优先 `items[]`（v0.12），回落到顶层单条（v0.11 及以前）。
 * 字段白名单校验 + 长度截断，越界值一律回落而不抛错（旧模型输出不炸主流程）。
 */
export function normalizeItems(parsed) {
  const TYPES = ['note', 'decision', 'preference', 'lesson', 'profile']
  const ASPECTS = ['identity', 'preference', 'habit', 'background', 'communication_style']
  const raw = Array.isArray(parsed?.items)
    ? parsed.items
    : (parsed && typeof parsed.content === 'string' ? [parsed] : [])
  const out = []
  for (const it of raw.slice(0, 3)) {
    if (typeof it?.content !== 'string' || !it.content.trim()) continue
    const type = TYPES.includes(it.type) ? it.type : 'note'
    out.push({
      content: it.content.trim(),
      type,
      layer: it.layer === 'ep' ? 'ep' : 'sm',
      keywords: Array.isArray(it.keywords)
        ? it.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim()).slice(0, 40)
        : [],
      aspect: type === 'profile' && ASPECTS.includes(it.aspect) ? it.aspect : '',
      abstract: it.abstract === 'principle' || it.abstract === 'event' ? it.abstract : '',
      theme: typeof it.theme === 'string' ? it.theme.trim().replace(/\s+/g, ' ').slice(0, 30) : '',
      // v0.12.2：模型认为"被这条推翻的旧记忆 id"。这里只做格式清洗，
      // 真正的白名单校验在写入侧（只接受本次真的喂给模型的那些 id）——防模型凭空编 id。
      supersedes: Array.isArray(it.supersedes)
        ? it.supersedes.filter((x) => typeof x === 'string' && x.startsWith('mem-')).slice(0, 2)
        : [],
    })
  }
  return out
}

/**
 * LLM 归并：把一组讲同一件事的记忆合成**一条更完整的结论**（v0.12.1）。
 *
 * 与「拼接」的本质区别：拼接是把 N 条内容用横线堆在一起（越堆越长、互相矛盾处无人裁决、
 * 库内实测最长 9099 字）；归并是让模型读完全部后输出一条——去重、保住全部关键约束、
 * 矛盾处以时间较新者为准并写清新旧关系。这是用户要的"整合"，也是管家从"只报告"走向真治理的核心动作。
 *
 * 复用 llmStrictJson（思考档 + 不设 token 上限 + 时间预算 + 断点续思），因此归并同样享受
 * "想清楚再写"的能力，不会因为预算不足而丢结果。
 *
 * @returns {Promise<{content, keywords, theme, abstract, analysis, meta}>}
 */
export async function mergeMemoriesWithLlm(ctx, cfg, memories) {
  const items = (memories ?? []).filter((m) => m?.content)
  if (items.length < 2) throw new Error('归并至少需要两条记忆')
  const prompt = `你在整理记忆库。下面这 ${items.length} 条记忆讲的是同一件事（相似度很高），请把它们**合成一条更完整的结论**。

规则：
1. 去掉重复表述，但**保住全部关键约束**（数字、版本号、路径、条件、边界、否定条件）——漏掉任何一条都会让这条记忆在未来被误用
2. 如果它们互相矛盾，以**日期较新**的那条为准，并在结论里明确写清新旧关系（"以前是 X，现在改成 Y"）
3. 不要罗列、不要编号、不要"以上/综上/这几条"这类结构词；写成一段通顺、自包含的话
4. 不要添加任何原文里没有的信息；原文没有的东西不许推测
5. 控制在 500 字以内——宁可只留关键约束，也不要为凑字数灌水

${items.map((m, i) => `【第 ${i + 1} 条｜${new Date(m.created_at).toISOString().slice(0, 10)}｜${m.type}】\n${truncate(m.content, 1200)}`).join('\n\n')}

输出严格 JSON（无其他文字、无 markdown 围栏）：
{"analysis": "为什么这样归并、哪些地方冲突、以哪条为准", "content": "归并后的结论", "keywords": ["..."], "theme": "主题标签", "abstract": "principle"}`

  const { json, meta } = await llmStrictJson(ctx, cfg, prompt)
  if (typeof json?.content !== 'string' || !json.content.trim()) throw new Error('归并输出缺少 content')
  return {
    content: json.content.trim(),
    keywords: Array.isArray(json.keywords) ? json.keywords.filter((k) => typeof k === 'string' && k.trim()).slice(0, 40) : [],
    theme: typeof json.theme === 'string' ? json.theme.trim().replace(/\s+/g, ' ').slice(0, 30) : '',
    abstract: json.abstract === 'principle' || json.abstract === 'event' ? json.abstract : '',
    analysis: typeof json.analysis === 'string' ? json.analysis.trim().slice(0, 1500) : '',
    meta,
  }
}

/**
 * 把相似对聚成组（并查集）——管家归并的最小单位不是"一对"，而是"一团讲同一件事的记忆"。
 * @param {{a: string, b: string, sim: number}[]} pairs 相似对
 * @returns {string[][]} 分组（每组 ≥2 条；组内与组间均排序，保证确定性）
 */
export function groupSimilarPairs(pairs) {
  const parent = new Map()
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x)
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)
    let cur = x
    while (parent.get(cur) !== r) { const next = parent.get(cur); parent.set(cur, r); cur = next }
    return r
  }
  for (const p of pairs ?? []) {
    if (!p?.a || !p?.b) continue
    const ra = find(p.a)
    const rb = find(p.b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const groups = new Map()
  for (const id of parent.keys()) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(id)
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => g.sort())
    .sort((a, b) => a[0].localeCompare(b[0]))
}

/**
 * 规则路径的关键词兜底（无 LLM 时的降级提取）：
 * 泛词/虚词过滤 + 数量收紧 —— 旧实现直接 tokenize 取 40 个，把"现在/什么/这个/用户"
 * 这类词塞进关键词，污染检索与图谱实体（库内实测：平均 22.9 个关键词、出现最多的前 25 名里
 * 有 8 个是口语虚词）。
 */
const STOPWORDS = new Set([
  '现在', '什么', '这个', '那个', '没有', '不是', '一个', '问题', '用户', '主人', '继续', '可以',
  '应该', '需要', '因为', '所以', '但是', '如果', '就是', '还是', '已经', '这样', '那样', '我们',
  '他们', '你们', '自己', '时候', '东西', '一下', '还有', '然后', '真的', '可能', '知道', '觉得',
  '任务', '结果', '助手', '对话', '内容', '信息', '情况', '方式', '方法', '使用', '进行', '完成',
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'was', 'not', 'but', 'can', 'has',
])

/**
 * 中文虚词/助词/方位词（v0.12.0）：`tokenize` 对中文是按 **2-gram 滑窗**切的，
 * 于是"提取链路根治"会切出 `提取/取链/链路/路根/根治`——其中 `取链`、`路根` 是**跨词边界的碎片**，
 * 进了关键词表就会污染图谱实体与检索。规则无法可靠区分"根因"（真词）与"取链"（碎片），
 * 但**首尾含虚词的一定是碎片**（`器里`、`里等`），这条能低成本挡掉一大类。
 */
const CN_BOUNDARY_CHARS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '把', '被', '就', '都', '也', '很', '而', '等',
  '里', '上', '下', '中', '到', '从', '对', '为', '以', '及', '并', '于', '这', '那', '个',
  '们', '着', '过', '给', '让', '使', '得', '且', '又', '再', '还', '只', '更', '最',
])

/** 从文本抽取可做检索/图谱实体的词：滤掉虚词、单字碎片、跨词边界碎片与超长串，最多 limit 个。 */
export function pickKeywords(text, limit = 8) {
  const out = []
  const seen = new Set()
  for (const raw of tokenize(text)) {
    const w = String(raw).trim()
    if (w.length < 2 || w.length > 24) continue
    const lower = w.toLowerCase()
    if (STOPWORDS.has(lower) || STOPWORDS.has(w)) continue
    if (/^[\d.%]+$/.test(w)) continue
    // 中文 2-gram：首尾是虚词 → 跨了词边界的碎片，丢弃（英文/数字 token 不受影响）
    if (/^[\u4e00-\u9fff]{2}$/.test(w) && (CN_BOUNDARY_CHARS.has(w[0]) || CN_BOUNDARY_CHARS.has(w[1]))) continue
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(w)
    if (out.length >= limit) break
  }
  return out
}
