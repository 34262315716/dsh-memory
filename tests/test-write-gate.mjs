// v0.16.0 写入侧决策门专项：轮次结束时先问一次决策模型「这段对话值得记吗」。
// 用法: node tests/test-write-gate.mjs
//
// 采信规则是**非对称**的，本套用例主要就是把这条不对称钉住：
//   只有它高把握说"不值得"（worth === false）才省掉 LLM 提取；其余一切（没把握、服务不在、
//   门抛错、门关掉）都必须照常提取。反过来判错的代价是"少记一条"，不可逆。
//
// 上半场（§1-§6）用假门驱动写入管线；下半场（§7）用**真 HTTP 假服务**验决策门本体——
// 被测代码的真实路径就是「POST 到 8090 拿 JSON」，用假 fetch 会让"请求体形状""超时"
// "非 JSON 响应""HTTP 错误码"这些真会出问题的分支全部消失。
import { attachWritePipeline } from '../lib/pipelines/write.js'
import { Config } from '../lib/config.js'
import { MemoryStore } from '../lib/store.js'
import { createWriteGate, DEFAULT_WRITE_MIN_CONFIDENCE, WORTH_RECORDING_PROMPT } from '../lib/write-gate.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) } }

/** Config 是整表 .volatile() 的 schema，读值前先解包（同 lib/index.js 的 getCfg）。 */
const cfgOf = (input) => {
  const parsed = Config(input)
  return typeof parsed?.get === 'function' ? parsed.get() : parsed
}

/** 一段足够长、能过价值门的对话（太短的轮次会被"too-short"挡在决策门之前）。 */
const USER_TEXT = '帮我把这个注入管线的节流参数改成十二步，并且顺手检查一下日志里有没有漏掉的分支。'
const ASSISTANT_TEXT = '已经改成十二步，并且把日志里缺的那条分支补上了，跑完测试全绿。'

const CFG = (over = {}) => ({
  scope: 'test',
  features: { autoWrite: true, valueGate: true, dedupMerge: true, preStepInject: true, userMessageTrigger: true, decisionGate: true, writeGate: true },
  refiner: { enabled: true, provider: 'mock', model: 'mock', reasoningEffort: 'low', maxTokens: 0, timeBudgetMs: 1000, maxContinuations: 0 },
  sessionSummary: { enabled: false },
  housekeeping: { enabled: false },
  logging: { enabled: false },
  decision: { endpoint: 'http://127.0.0.1:1/v1/systemone', timeoutMs: 500, minConfidence: 0.65, writeMinConfidence: 0.9 },
  ...over,
})

/** 造一个假决策门，记录它收到的证据。 */
const gateOf = (result) => {
  const calls = []
  return {
    calls,
    askWorth: async (input) => {
      calls.push(input)
      return typeof result === 'function' ? result(input) : result
    },
  }
}

/** 组装一次完整的"一轮对话 → turn/end"。返回 store / logs / 断言用的把手。 */
async function runTurn({ gate, cfg = CFG, userText = USER_TEXT, assistantText = ASSISTANT_TEXT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wgate-'))
  const store = new MemoryStore(join(dir, 't.db'), {})
  const events = {}
  const logs = []
  let llmCalls = 0
  const ctx = {
    on: (name, cb) => { events[name] = cb },
    llm: {
      stream: async function* () {
        llmCalls++
        yield { type: 'text-delta', text: '{"analysis":"这一轮有稳定结论","items":[{"content":"注入节流参数改为十二步","type":"decision","layer":"sm","keywords":["节流","十二步"],"abstract":"event","theme":"dsh-memory 开发"}]}' }
      },
    },
    tools: { register: () => true },
  }
  attachWritePipeline(ctx, {
    store,
    getCfg: typeof cfg === 'function' ? cfg : () => cfg,
    wsRegistry: { list: () => [] },
    logStore: (level, ev, data) => logs.push({ level, ev, ...data }),
    writeGate: gate ?? null,
  })
  const handler = events['session/event']
  const session = { id: 'sess-1', workspaceDirectory: undefined }
  // 三个事件必须共享同一个 turn：turnCache 按轮次聚合，turn 一变就把之前攒的用户文本清掉
  // （第一次写这套用例就踩了——user/message 不带 turn 落到兜底 0，assistant 带 turn=1，
  //   于是 turn/end 时 userPart 为空，值门判定成"自主轮次"直接跳过）。
  await handler(session, { type: 'turn/start', data: { turn: 1 } })
  await handler(session, { type: 'user/message', data: { turn: 1, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] } })
  await handler(session, { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', source: { provider: 'mock' }, content: [{ type: 'text', text: assistantText }] } } })
  await handler(session, { type: 'turn/end', data: { turn: 1 } })
  // LLM 提取走串行队列（异步），给它一点时间落地
  await new Promise((r) => setTimeout(r, 300))
  return {
    store,
    logs,
    llmCalls: () => llmCalls,
    epCount: () => store.list({ layer: 'ep', limit: 20 }).length,
    smCount: () => store.list({ layer: 'sm', limit: 20 }).length,
    close: () => { try { store.close() } catch { /* 已关 */ } try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 句柄未释放 */ } },
  }
}

console.log('== 1. 高把握判"不值得" → 省掉 LLM，但仍然落一条 ep 快照（记录不丢） ==')
{
  const gate = gateOf({ worth: false, p: 0.02, confidence: 0.98, ms: 320 })
  const r = await runTurn({ gate })
  check('1a LLM 一次都没被调用', r.llmCalls() === 0)
  check('1b 仍落了 ep 快照（不丢记录，只是不花 LLM）', r.epCount() === 1 && r.smCount() === 0)
  const g = r.logs.find((l) => l.ev === 'write.gate')
  check("1c 日志 decision='skip-llm' 且带回把握度", g?.decision === 'skip-llm' && g?.confidence === 0.98)
  check('1d 日志记了省掉的原因', r.logs.some((l) => l.ev === 'write.prefiltered' && l.reason === 'decision-gate'))
  check('1e 门收到的证据是这一轮的对话', gate.calls[0]?.userText === USER_TEXT && gate.calls[0]?.assistantText === ASSISTANT_TEXT)
  r.close()
}

console.log('== 2. 门说"值得" → 照常走 LLM 提取 ==')
{
  const gate = gateOf({ worth: true, p: 0.93, confidence: 0.93, ms: 410 })
  const r = await runTurn({ gate })
  check('2a LLM 被调用（提取照常发生）', r.llmCalls() > 0)
  check('2b 写进了 sm 层记忆', r.smCount() >= 1)
  check("2c 日志 decision='proceed'", r.logs.find((l) => l.ev === 'write.gate')?.decision === 'proceed')
  r.close()
}

console.log('== 3. 门没把握 / 服务不在 / 门炸了 → 一律照常提取 ==')
{
  // 3a：把握度不足（worth=null 是"没结论"的表达）
  const g1 = gateOf({ worth: null, p: 0.55, confidence: 0.55, ms: 260, degraded: 'low-confidence' })
  const r1 = await runTurn({ gate: g1 })
  check('3a 没把握 → LLM 照常调用', r1.llmCalls() > 0)
  check("3a 日志记 degraded='low-confidence'", r1.logs.find((l) => l.ev === 'write.gate')?.degraded === 'low-confidence')
  check('3a 不是 skip-llm', r1.logs.find((l) => l.ev === 'write.gate')?.decision === 'proceed')
  r1.close()

  // 3b：服务不在（冷却期返回）
  const g2 = gateOf({ worth: null, ms: 0, degraded: 'service-down', error: 'ECONNREFUSED' })
  const r2 = await runTurn({ gate: g2 })
  check('3b 服务不在 → LLM 照常调用', r2.llmCalls() > 0)
  r2.close()

  // 3c：门自己抛错（就算它坏了也不能漏记）
  const g3 = { askWorth: async () => { throw new Error('boom') } }
  const r3 = await runTurn({ gate: g3 })
  check("3c 门抛错 → 不炸、LLM 照常调用", r3.llmCalls() > 0)
  check("3c 日志记 degraded='threw'", r3.logs.find((l) => l.ev === 'write.gate')?.degraded === 'threw')
  r3.close()
}

console.log('== 4. features.writeGate=false → 一次都不问门 ==')
{
  const gate = gateOf({ worth: false, confidence: 0.99, ms: 10 })
  const r = await runTurn({ gate, cfg: () => CFG({ features: { ...CFG().features, writeGate: false } }) })
  check('4a 门未被调用', gate.calls.length === 0)
  check('4b LLM 照常调用', r.llmCalls() > 0)
  check('4c 没有 write.gate 日志（门没参与）', !r.logs.some((l) => l.ev === 'write.gate'))
  r.close()
}

console.log('== 5. 太短的轮次连问都不问（先过价值门，省掉这次本地调用） ==')
{
  const gate = gateOf({ worth: false, confidence: 0.99, ms: 10 })
  const r = await runTurn({ gate, userText: '嗯', assistantText: '好' })
  check('5a 门未被调用', gate.calls.length === 0)
  check('5b 也没有 write.gate 日志', !r.logs.some((l) => l.ev === 'write.gate'))
  r.close()
}

console.log('== 6. schema：新开关与写入门槛默认值 ==')
{
  const c = cfgOf({})
  check('6a features.writeGate 默认 true', c.features.writeGate === true)
  check('6b decision.writeMinConfidence 默认 0.9（写入侧唯一的门槛）', c.decision.writeMinConfidence === 0.9)
  check('6c 注入侧门槛已移除（检索路径不接决策模型）', c.decision.minConfidence === undefined)
  check('6d writeMinConfidence 也可配', cfgOf({ decision: { writeMinConfidence: 0.95 } }).decision.writeMinConfidence === 0.95)
}

// ---------------------------------------------------------------- 下半场：决策门本体（真 HTTP 假服务）

/**
 * 起一个假决策服务，跑完自动关。
 * @param {(req: object, res: object) => any} handler 每个请求的处理
 * @param {(ctx: {endpoint: string, calls: object[]}) => Promise<any>} fn 用例体
 */
async function withServer(handler, fn) {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    try { calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { calls.push({ __unparsable: true }) }
    await handler(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/systemone`
  try {
    return await fn({ endpoint, calls })
  } finally {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
}

/** 应答一个 noul 答案。 */
const worthAnswer = (noul) => ({ answers: { worth_recording: { type: 'noul', noul, confidence: Math.max(noul, 1 - noul) } } })
const sendJson = (res, obj, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}
/** 造一个真门（配置每次重读，与生产装配一致）。 */
const realGateWith = (endpoint, over = {}, logs = []) => createWriteGate(
  () => ({ decision: { endpoint, timeoutMs: 2000, writeMinConfidence: 0.9, ...over } }),
  (level, ev, data) => logs.push({ level, ev, ...data }),
)

console.log('== 7. 决策门本体（真 HTTP 假服务）：采信门槛与降级链 ==')
{
  check('7a 默认门槛 0.9', DEFAULT_WRITE_MIN_CONFIDENCE === 0.9)
  check('7b 题面问的是"值不值得记"', typeof WORTH_RECORDING_PROMPT === 'string' && WORTH_RECORDING_PROMPT.includes('值得写入长期记忆'))

  // 7c-7e：唯一会改变行为的结论，顺带验请求体形状
  await withServer(
    (req, res) => sendJson(res, worthAnswer(0.02)),
    async ({ endpoint, calls }) => {
      const r = await realGateWith(endpoint).askWorth({ userText: '把那个变量改个名', assistantText: '已改完，测试全绿' })
      check('7c noul=0.02 且把握 0.98 → worth=false', r.worth === false && Math.abs(r.confidence - 0.98) < 1e-9 && r.degraded === undefined)
      check('7d 请求体问的是 worth_recording（noul）', calls[0].questions.worth_recording?.type === 'noul')
      check('7e 证据是成对的对话（用户 + 助手）', String(calls[0].state.exchange).startsWith('用户：') && String(calls[0].state.exchange).includes('\n助手：'))
    },
  )

  // 7f-7h：值得 / 没把握 / 门槛可调
  const askWith = async (noul, over = {}) => {
    let out = null
    await withServer(
      (req, res) => sendJson(res, worthAnswer(noul)),
      async ({ endpoint }) => { out = await realGateWith(endpoint, over).askWorth({ userText: '甲', assistantText: '乙' }) },
    )
    return out
  }
  check('7f noul=0.93 → worth=true（照常提取）', (await askWith(0.93)).worth === true)
  const unsure = await askWith(0.55)
  check("7g 把握 0.55 < 0.9 → worth=null 且 degraded='low-confidence'", unsure.worth === null && unsure.degraded === 'low-confidence')
  check('7h 门槛降到 0.5 后同一条被采信（worth=true）', (await askWith(0.55, { writeMinConfidence: 0.5 })).worth === true)

  // 7i：两侧各截到 1500 字（超长粘贴不该把判断淹没）
  await withServer(
    (req, res) => sendJson(res, worthAnswer(0.9)),
    async ({ endpoint, calls }) => {
      await realGateWith(endpoint).askWorth({ userText: '啊'.repeat(2000), assistantText: '嗯'.repeat(2000) })
      const ex = String(calls[0].state.exchange)
      check('7i 两侧各截到 1500 字', ex.length === 1500 * 2 + '用户：'.length + '\n助手：'.length)
    },
  )

  // 7j-7l：HTTP 错 → 降级 + 冷却
  await withServer(
    (req, res) => { res.writeHead(500); res.end('boom') },
    async ({ endpoint, calls }) => {
      const logs = []
      const gate = realGateWith(endpoint, {}, logs)
      const a = await gate.askWorth({ userText: '甲', assistantText: '乙' })
      check("7j HTTP 500 → worth=null 且 degraded='error'，并写 warn 日志", a.worth === null && a.degraded === 'error' && logs.some((l) => l.level === 'warn'))
      check('7k 门被标记为不可用', gate.isDown() === true)
      const b = await gate.askWorth({ userText: '丙', assistantText: '丁' })
      check("7l 冷却期内第二次不发请求（calls 仍为 1），返回 service-down", calls.length === 1 && b.degraded === 'service-down' && b.worth === null)
    },
  )

  // 7m-7p：其余降级形态
  await withServer(
    (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not json</html>') },
    async ({ endpoint }) => {
      check("7m 非 JSON 响应 → worth=null 且 degraded='error'", (await realGateWith(endpoint).askWorth({ userText: '甲' })).degraded === 'error')
    },
  )
  await withServer(
    (req, res) => sendJson(res, { answers: {} }),
    async ({ endpoint }) => {
      const r = await realGateWith(endpoint).askWorth({ userText: '甲' })
      check('7n 缺 worth_recording.noul → 降级且错误信息点名缺了哪个字段', r.worth === null && String(r.error).includes('worth_recording.noul'))
    },
  )
  {
    // 端口 1 上不会有服务；拒连会立刻返回，不会等满超时
    const r = await realGateWith('http://127.0.0.1:1/v1/systemone').askWorth({ userText: '甲' })
    check("7o 连不上 → worth=null 且 degraded='error'（不等满 2 秒超时）", r.worth === null && r.degraded === 'error' && r.ms < 1900)
  }
  await withServer(
    (req, res) => setTimeout(() => sendJson(res, worthAnswer(0.02)), 600),
    async ({ endpoint }) => {
      const r = await realGateWith(endpoint, { timeoutMs: 200 }).askWorth({ userText: '甲' })
      // 余量：批量跑全量套件时负载高，200ms 的定时器可能晚一两百毫秒才响；
      // 门槛卡在服务那 600ms 响应之下即可证明没干等。
      check("7p 超预算 → worth=null 且 degraded='error'，错误写明超时", r.worth === null && r.degraded === 'error' && String(r.error).includes('超时'))
    },
  )

  // 7q-7r：本轮被取消不是服务故障（记 aborted、不设冷却）
  await withServer(
    (req, res) => sendJson(res, worthAnswer(0.02)),
    async ({ endpoint, calls }) => {
      const gate = realGateWith(endpoint)
      const ac = new AbortController()
      ac.abort()
      const r1 = await gate.askWorth({ userText: '甲', signal: ac.signal })
      check("7q 本轮被取消 → degraded='aborted'（不是 error），且不设冷却", r1.degraded === 'aborted' && gate.isDown() === false)
      const r2 = await gate.askWorth({ userText: '乙' })
      check('7r 取消后下一次照常发请求', calls.length === 1 && r2.worth === false)
    },
  )
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
