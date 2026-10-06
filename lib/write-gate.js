/**
 * 写入侧决策门（v0.16.0）：把「这一轮对话值不值得送 LLM 提取」这一件小判断交给本机
 * StartLux-Decision 9B（HTTP `127.0.0.1:8090/v1/systemone`，输出 0 token，不生成文本）。
 *
 * **它只在写入侧。** 检索路径上不做任何决策模型判断（2026-10-06 主人判定）：查库是注入链路的
 * 本职工作，来了新消息就查，不问"要不要查"。决策模型留给**昂贵且不可逆**的地方——LLM 提取
 * 一轮几十秒，而"这段对话有没有值得记的东西"本地 0.3~0.9 秒就能答；判"不值得"时改落一条 ep
 * 快照，记录不丢，省掉的只是那次 LLM。
 *
 * 采信规则是**非对称**的，这是本模块唯一要紧的约定：
 *   只有 `worth === false` 且把握度过门槛，才改变行为；其余一切情形——服务没起、超时、HTTP 错、
 *   返回形状不对、把握度不足、本轮被取消——一律 `worth: null`，调用方照常提取。
 * 反方向的错误（判"值得"其实不值得）只是多花一次 LLM；判错成"不值得"则是少记一条，不可逆。
 *
 * 为什么走裸 HTTP 而不是 MCP：插件跑在 DSH 进程内，MCP 工具是给会话模型用的通道。
 * 决策服务对外就是一个 HTTP POST，插件直连它才是与真实路径同构的调用。
 * 实测延迟（2026-10-06，9B Q4_K_M，短证据）：0.3~0.9 秒；服务未启动时是几十毫秒的
 * ECONNREFUSED，不会干等到超时。
 */

/** 默认端点：与技能文档「decision-model」里的 DECISION_ENDPOINT 一致。 */
export const DEFAULT_DECISION_ENDPOINT = 'http://127.0.0.1:8090/v1/systemone'

/** 服务失败后的冷却时长：避免每一轮都去撞一个没起的服务。 */
const DOWN_COOLDOWN_MS = 5 * 60 * 1000

/** 对话两侧在证据里的截断字数（超长粘贴不该把判断淹没）。 */
const SIDE_CHARS = 1500

/** 这一问的题面。措辞取自决策模型技能里的「记忆预筛」模板。 */
export const WORTH_RECORDING_PROMPT =
  '这条对话内容属于稳定的知识/偏好/决策/教训，值得写入长期记忆库？' +
  '一次性的任务安排、过程记录、临时提醒、空转寒暄都不值得。'

/**
 * 默认采信门槛（0.9）。
 * 定得这么严是因为代价不对称：判错一次就少记一条，而放宽门槛省下的只是"多花一次 LLM"。
 * 实测（9B Q4_K_M）：明显不值的一轮（操作流水、临时待办）把握度 0.95~0.98；而"这是不是一条
 * 稳定知识"这种中段判断只有 0.55~0.60——门槛就卡在两者之间。
 */
export const DEFAULT_WRITE_MIN_CONFIDENCE = 0.9

/**
 * 数值夹取（配置读进来的东西可能是字符串、NaN、空值）。
 * @param {unknown} value 候选值
 * @param {number} min 下限
 * @param {number} max 上限
 * @param {number} fallback 非法时的默认值
 * @returns {number} 合法数值
 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 合并两个取消信号（当前轮的取消 + 本次调用的超时）。
 * `AbortSignal.any` 要 Node 20+；拿不到时退回超时信号（宁可少响应一次取消，也不能抛错）。
 * @param {AbortSignal|undefined} a 外部信号（可能没有）
 * @param {AbortSignal|undefined} b 内部信号
 * @returns {AbortSignal|undefined} 合并后的信号
 */
function combineSignals(a, b) {
  if (!a) return b
  if (!b) return a
  try {
    if (typeof AbortSignal?.any === 'function') return AbortSignal.any([a, b])
  } catch { /* 老运行时：退回单一信号 */ }
  return b
}

/**
 * 发一次判断请求（超时与取消合并），返回解析后的 JSON 与耗时。
 * 抛错即失败——调用方一律降级成"照常提取"。
 * @param {string} endpoint 决策服务端点
 * @param {object} body 请求体（state + questions）
 * @param {number} timeoutMs 超时
 * @param {AbortSignal|undefined} signal 外部取消信号
 * @returns {Promise<{data: any, ms: number}>} 响应与耗时
 */
async function postOnce(endpoint, body, timeoutMs, signal) {
  const started = Date.now()
  const timeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: combineSignals(signal, timeout),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return { data, ms: Date.now() - started }
}

/**
 * 造一个写入侧决策门。
 *
 * @param {() => any} getCfg 读当前生效配置（每次调用都重读：设置页是 live 生效的）
 * @param {(level: string, event: string, detail: object) => void} logStore 运行日志写入器
 * @returns {{askWorth: (input: {userText?: string, assistantText?: string, agentId?: string,
 *            signal?: AbortSignal}) => Promise<{worth: boolean|null, p?: number,
 *            confidence?: number, ms: number, degraded?: string, error?: string}>,
 *            isDown: () => boolean}} 决策门
 */
export function createWriteGate(getCfg, logStore) {
  let downUntil = 0 // 冷却截止时间戳（Date.now() 量纲）
  let downReason = '' // 最近一次失败原因（诊断用）

  /**
   * 问一次「这一轮对话值得记吗」。
   *
   * 返回值语义：`worth === false` 是**唯一**会让调用方跳过 LLM 提取的结论，而且要它自己有把握。
   * 其余一切情形都是 `worth: null`，并把原因放在 `degraded` 里（'service-down' | 'aborted' |
   * 'low-confidence' | 'error'）——调用方据此只记日志、不做分支。
   */
  async function askWorth({ userText, assistantText, signal, agentId }) {
    const cfg = getCfg()?.decision ?? {}
    const endpoint = String(cfg.endpoint || DEFAULT_DECISION_ENDPOINT)
    const timeoutMs = clampNumber(cfg.timeoutMs, 200, 10000, 2000)
    const minConfidence = clampNumber(cfg.writeMinConfidence, 0.5, 0.99, DEFAULT_WRITE_MIN_CONFIDENCE)

    // 冷却期内不再发请求：省掉每轮几十毫秒的无效连接。
    if (Date.now() < downUntil) {
      return { worth: null, ms: 0, degraded: 'service-down', error: downReason }
    }

    const state = {
      exchange: `用户：${String(userText ?? '').slice(0, SIDE_CHARS)}\n助手：${String(assistantText ?? '').slice(0, SIDE_CHARS)}`,
    }
    const questions = { worth_recording: { type: 'noul', instructions: WORTH_RECORDING_PROMPT } }
    const started = Date.now()

    try {
      const { data, ms } = await postOnce(endpoint, { state, questions }, timeoutMs, signal)
      const p = Number(data?.answers?.worth_recording?.noul)
      if (!Number.isFinite(p)) throw new Error('返回里没有 worth_recording.noul')
      // 题自答上了：清掉冷却（服务显然活着）
      downUntil = 0
      downReason = ''
      // noul 的把握度取 max(p, 1-p)：p=0.02 是「98% 确信为假」，不是没把握。
      const confidence = Math.max(p, 1 - p)
      if (confidence < minConfidence) {
        return { worth: null, p, confidence, ms, degraded: 'low-confidence' }
      }
      return { worth: p >= 0.5, p, confidence, ms }
    } catch (err) {
      const ms = Date.now() - started
      // 本轮被取消（用户点了停止）不是服务故障：不设冷却，也别记成 error。
      if (signal?.aborted) {
        logStore?.('info', 'write.gate', { agent: agentId, ms, degraded: 'aborted' })
        return { worth: null, ms, degraded: 'aborted' }
      }
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      const reason = isTimeout ? `超时 ${timeoutMs}ms` : String(err?.message ?? err)
      downUntil = Date.now() + DOWN_COOLDOWN_MS
      downReason = reason
      logStore?.('warn', 'write.gate', { agent: agentId, ms, degraded: 'error', error: reason })
      return { worth: null, ms, degraded: 'error', error: reason }
    }
  }

  return { askWorth, isDown: () => Date.now() < downUntil }
}
