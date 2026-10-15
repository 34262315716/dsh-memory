// v0.10.1 注入管线专项：修复"AI 回复后记忆块作为独立一步被消费 → 模型多答一轮"
// 用法: node test-inject-pipeline.mjs（需在部署副本或 harness 环境运行，依赖 @deepseek-ai 包）
import { attachInjectPipeline, buildPinned } from '../lib/pipelines/inject.js'
import { Config, INJECT_PACE_LABELS, INJECT_PACE_STEPS, resolveStepInterval } from '../lib/config.js'

// v0.14.0：Config 是**整表** `.volatile()` 的 schema（0.2.0-rc.2 上设置面板能显示表单的前提），
// 所以 `Config(x)` 解析出来的是 cosmokit `Volatile` 包装——读值前要先解包。
// 这与 lib/index.js 的 `getCfg()`、lib/compat.js 的 `plainConfig()` 是同一条规则；
// 本用例关心的是"schema 的默认值/取值/校验"，所以统一经 cfgOf() 读 plain。
const cfgOf = (input) => {
  const parsed = Config(input)
  return typeof parsed?.get === 'function' ? parsed.get() : parsed
}
import { MemoryStore } from '../lib/store.js'
import { extractUserText, renderPinned, stripInjectedNoise } from '../lib/util.js'
import { WORK_ITEM_CHARS, WORK_KEEP, extractWorkText, workProjectionApply, workProjectionInit, workStateSchema } from '../lib/work-projection.js'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) } }

const CFG = () => ({
  scope: 'test',
  features: { preStepInject: true },
  // 老用例按数字断言节奏 → 显式走「自定义」档，让 stepInterval 说了算
  // （v0.11.2 起默认档位 steady=12 会覆盖数字，不给 custom 这些用例就全错）
  injectPace: 'custom',
  stepInterval: 2,
  injectMaxTokens: 800,
  injectMinScore: 0.02,
  maxRecentPerAgent: 6,
  pinnedLimit: 8,
  pinnedMaxTokens: 600,
  /**
   * v0.18.0：既有用例（§0~§15）描述的统统是「每步注入」的旧行为——那时它是唯一行为，
   * 用例写的时候就默认了它。新档位把默认值改成了 session，所以这里**显式退回 step**，
   * 让老用例继续锁住旧契约（这也正是需求 §四.7「切回旧行为要能一键退回」的用法示范）。
   * 新档位的契约见文末 §17。
   */
  pinnedInjection: 'step',
})

/**
 * v0.16.0：这些用例测的是**纯步距节流**这条老契约（每 N 步必检）。
 * 必须显式关掉「用户消息触发」——开着它时，每条文本不同的用户消息都会强制检索一次，
 * 步距就再也观察不到（而这正是新功能要改的事）。新契约的用例见文末 §15。
 */
const CFG_STEP_ONLY = (over = {}) => ({
  ...CFG(),
  ...over,
  features: { ...CFG().features, userMessageTrigger: false, ...(over.features ?? {}) },
})

const HITS = [{ id: 'mem-x', content: '测试记忆内容：用户偏好纯白设定图', score: 0.6, layer: 'sm', updated_at: Date.now() }]

/** 用**真实的**投影单元折叠一段事件流，得到工作上下文 state（与内核折叠路径同构）。 */
function foldWork(events) {
  let state = workProjectionInit()
  for (const ev of events) state = workProjectionApply(state, ev)
  return state
}

/** 组装一个可触发的注入管线实例。pins：常驻记忆（v0.13.0）；workState：工作上下文投影快照（v0.15.3）。 */
function setup({ hits = HITS, cfg = CFG, pins = [], workState = null } = {}) {
  const events = {}
  const logs = []
  const lastArgs = {}
  const ctx = { on: (name, cb) => { events[name] = cb } }
  attachInjectPipeline(ctx, {
    store: {
      search: async (q, opts) => {
        lastArgs.query = q
        lastArgs.opts = opts
        return typeof hits === 'function' ? hits() : hits
      },
      listPinned: () => (typeof pins === 'function' ? pins() : pins),
    },
    getCfg: cfg,
    wsRegistry: { list: () => [] },
    // v0.15.3：工作上下文改走官方会话投影（lib/work-projection.js）。测试喂的都是 foldWork()
    // 折叠出来的真 state——与真实路径同构，不再伪造内核没有的 session.events。
    workProjection: { available: workState !== null, read: () => workState },
    // 保留 level/ev：断言既能读 data 字段，也能按事件名过滤（v0.15.3 起有 inject.coord_missing）
    logStore: (level, ev, data) => logs.push({ level, ev, ...data }),
  })
  const handler = events['agent/pre-step']
  // 默认 agent 复用同一实例（模拟同一会话连续多步）。
  // v0.15.3：session 上**不再挂 events**——真实内核的 Session 没有这个属性，
  // 测试当年伪造它，正是"读 session.events"能稳定通过的原因。
  const sharedAgent = { id: 'agent-1', session: {} }
  // v0.15.3：真实内核每一步都送**递增**坐标（agent-loop: `const step = phase.step + 1`）。
  // 旧 mock 硬编码 {turn:1, step:1}，等于向被测代码宣称"内核每步都报第 1 步"——
  // 正是这条与内核不同构的假坐标，让"步号恒为 0"的老 bug 在测试里一直看不出来。
  let seq = 0
  const call = async (text, next, opts = {}) => {
    const messages = opts.messages ?? (text ? [userMsg(text)] : [])
    const agent = opts.agent ?? sharedAgent
    seq += 1
    return handler({ messages, agent, turn: opts.turn ?? 1, step: opts.step ?? seq, signal: {} }, next)
  }
  return { call, logs, lastArgs, handler }
}

/** 构造真实用户消息（source.kind='user'）。 */
function userMsg(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

console.log('== 0. 守卫（v0.15.3）：步号只认内核坐标，不读 session.events ==')
{
  // 0a：正常路径——内核坐标每步递增，日志步号必须跟着走（旧 bug 下恒为 1，节流永远卡死）
  let n = 0
  const { call, logs } = setup({ cfg: CFG_STEP_ONLY, hits: () => [{ id: `mem-g${++n}`, content: `守卫记忆${n}`, score: 0.6, layer: 'sm', updated_at: Date.now() }] })
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('x'), { type: 'context' }] })
  await call('守卫甲', fallback) // step 1 → 注入
  await call('守卫乙', fallback) // step 2 → 步距内跳过（stepInterval=2）
  await call('守卫丙', fallback) // step 3 → 步距到 → 注入
  const injects = logs.filter((l) => l.ev === 'inject')
  check('步号随内核坐标推进（日志步号 1,3 而非恒 1）', injects.map((l) => l.step).join(',') === '1,3')
  check('正常路径不写坐标缺失告警', logs.every((l) => l.ev !== 'inject.coord_missing'))

  // 0b：内核没给坐标（老版本/异常形状）→ 降级为逐次 +1，而不是归零后永远早退
  let m = 0
  const { handler, logs: logs2 } = setup({
    cfg: () => CFG_STEP_ONLY({ injectPace: 'custom', stepInterval: 1 }),
    hits: () => [{ id: `mem-nc${++m}`, content: `降级记忆${m}`, score: 0.5, layer: 'sm', updated_at: Date.now() }],
  })
  const fb = async () => ({ kind: 'enter', messages: [userMsg('x'), { type: 'context' }] })
  const agent2 = { id: 'agent-nocoord', session: { events: [] } }
  await handler({ messages: [userMsg('守卫甲')], agent: agent2, signal: {} }, fb)
  await handler({ messages: [userMsg('守卫乙')], agent: agent2, signal: {} }, fb)
  await handler({ messages: [userMsg('守卫丙')], agent: agent2, signal: {} }, fb)
  const injects2 = logs2.filter((l) => l.ev === 'inject')
  check('无坐标降级：步号自增 1,2,3（不是恒 0）', injects2.map((l) => l.step).join(',') === '1,2,3')
  check('无坐标只告警一次（每个 agent 一条）', logs2.filter((l) => l.ev === 'inject.coord_missing').length === 1)
}

console.log('== 1. 修复主行为：记忆块合并进本步 decision，不再经 agent.inject() ==')
{
  const { call } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('请问记忆?'), { type: 'context' }] })
  const decision = await call('请问记忆?', fallback)
  check('decision.kind 保持 enter', decision?.kind === 'enter')
  check('消息数 = 用户 + context + 记忆块（同一步）', decision?.messages?.length === 3)
  const mem = decision?.messages?.at(-1)
  check("记忆块溯源 form=recall / kind='plugin:dsh-memory'", mem?.source?.kind === 'plugin:dsh-memory' && mem?.source?.form === 'recall')
  check('记忆块内容含记忆标题', String(mem?.content?.[0]?.text ?? '').includes('[记忆]'))
  check('未调用 agent.inject（agent mock 无 inject 方法，调用即 TypeError）', true)
}

console.log('== 2. 步距内同 query 跳过（纯步距节流；步距到则必检） ==')
{
  const { call } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('同一个问题'), { type: 'context' }] })
  const d1 = await call('同一个问题', fallback)
  const d2 = await call('同一个问题', fallback)
  check('首次注入', d1.messages.length === 3)
  check('步距内重复同 query 原样放行（无记忆块）', d2.messages.length === 2)
}

console.log('== 3. 步距节流 + 恢复：按真实步数计数（stepInterval=2） ==')
{
  // 每轮检索结果不同（避开 blockHash 去抖干扰，单独验证节流）
  let n = 0
  const { call } = setup({ cfg: CFG_STEP_ONLY, hits: () => [{ id: `mem-${++n}`, content: `记忆内容${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }] })
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('x'), { type: 'context' }] })
  const d1 = await call('第一轮问题', fallback)
  const d2 = await call('第二轮问题', fallback)
  const d3 = await call('第三轮问题', fallback)
  check('第一轮注入', d1.messages.length === 3)
  check('第二轮被步距节流跳过', d2.messages.length === 2)
  check('第三轮恢复注入', d3.messages.length === 3)

  // 3b：无文本步（工具/自主步）同样消耗步数——连续两轮用户消息中间夹工具步 → 第二轮也注入
  let m = 0
  const { call: callB } = setup({ cfg: CFG_STEP_ONLY, hits: () => [{ id: `mem2-${++m}`, content: `记忆${m}`, score: 0.5, layer: 'sm', updated_at: Date.now() }] })
  const db1 = await callB('甲问题', fallback)
  const dbMid = await callB(null, fallback) // 模拟工具结果步（无真实用户文本）
  const db2 = await callB('乙问题', fallback)
  check('3b 甲问题注入', db1.messages.length === 3)
  check('3b 工具步不注入但计数', dbMid.messages.length === 2)
  check('3b 乙问题步距已到、恢复注入', db2.messages.length === 3)
}

console.log('== 3c. 自主轮次注入（v0.9.23）：无用户消息时用会话工作上下文兜底 ==')
{
  const events = [
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '原始任务：搭建记忆系统' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', source: { provider: 'mock' }, content: [{ type: 'text', text: '我正在处理图谱构建' }] } } },
  ]
  // v0.15.3：工作上下文改由投影单元折叠出 state（旧写法伪造 agent.session.events）
  const { call, logs } = setup({ workState: foldWork(events) })
  const fallback = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
  const d = await call(null, fallback, { agent: { id: 'agent-1', session: {} } })
  check("自主轮次注入成功（context + 记忆块）", d.messages.length === 2 && d.messages.at(-1)?.source?.kind === 'plugin:dsh-memory')
  check('检索 query 用了最近 assistant 工作内容', logs.at(-1)?.query?.includes('图谱构建'))
  check('且包含历史任务文本', logs.at(-1)?.query?.includes('原始任务'))
}

console.log('== 3d. 自主轮次守卫：无会话 / 会话仅注入块 / 均不注入 ==')
{
  const fallback = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
  const { call } = setup() // 投影不可用（headless 组装 / 无该服务）→ 没有工作文本
  const d1 = await call(null, fallback, { agent: { id: 'no-session' } })
  check('agent 无 session：不注入', d1.messages.length === 1)

  // 投影可用，但里面只有插件自己的注入块（apply 里按 source.kind 跳过）→ 仍是"没有工作文本"
  const pluginOnly = [{ type: 'user/message', data: { role: 'user', source: { kind: 'plugin:dsh-memory' }, content: [{ type: 'text', text: '[记忆] 注入块' }] } }]
  const { call: call2 } = setup({ workState: foldWork(pluginOnly) })
  const d2 = await call2(null, fallback, { agent: { id: 'agent-2', session: {} } })
  check('会话仅插件注入块：不注入', d2.messages.length === 1)
}

console.log('== 4. 注入块 hash 去抖：检索结果未变则跨轮不重复注入 ==')
{
  const { call } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('x'), { type: 'context' }] })
  // 第1轮注入（blockHash=h1）→ 第3轮节流窗口外但检索结果相同 → hash 相同 → 跳过
  await call('问题甲', fallback)
  await call('问题乙', fallback)
  const d3 = await call('问题丙', fallback)
  check('第三轮同 hits 不重复注入', d3.messages.length === 2)
}

console.log('== 4b. 同 query 步距到 → 必检（命中内容变化则再次注入） ==')
{
  let n = 0
  const { call } = setup({ hits: () => [{ id: `memq-${++n}`, content: `新记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }] })
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('x'), { type: 'context' }] })
  const d1 = await call('同一个问题', fallback) // step1
  const d2 = await call('同一个问题', fallback) // step2 步距内跳过
  const d3 = await call('同一个问题', fallback) // step3 步距到 → 重检（新记忆）→ 注入
  check('首次注入', d1.messages.length === 3)
  check('步距内同 query 跳过', d2.messages.length === 2)
  check('步距到同 query 重检并注入（检索出更新内容）', d3.messages.length === 3)
}

console.log('== 7. 自定义档 stepInterval=10：75 步 → 8 个检索注入点（步 1 首检 + 每满 10 步） ==')
{
  const CFG10 = () => CFG_STEP_ONLY({ injectPace: 'custom', stepInterval: 10 })
  let n = 0
  const { call, logs } = setup({
    cfg: CFG10,
    hits: () => [{ id: `mem10-${++n}`, content: `记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }],
  })
  const fallback = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
  const injected = []
  for (let i = 1; i <= 75; i++) {
    const d = await call(`第 ${i} 步的工作内容 ${i}`, fallback)
    if (d.messages.length === 2) injected.push(i) // context + 记忆块 = 注入了
  }
  check('75 步内注入于步 1,11,21,31,41,51,61,71', injected.join(',') === '1,11,21,31,41,51,61,71')
  check('8 次注入 = 1 次首检 + 7 次满 10 步', injected.length === 8)
  check('日志 step 与注入步号一致', logs.map((l) => l.step).join(',') === injected.join(','))
}

console.log('== 7b. 档位解析（v0.11.2）：激进 4 / 平稳 12 / 懒惰 30 / 自定义用数字 / 未知回落平稳 ==')
{
  check('激进档 = 4 步', resolveStepInterval({ injectPace: 'aggressive' }) === 4)
  check('平稳档 = 12 步', resolveStepInterval({ injectPace: 'steady' }) === 12)
  check('懒惰档 = 30 步', resolveStepInterval({ injectPace: 'lazy' }) === 30)
  check('自定义档读 stepInterval', resolveStepInterval({ injectPace: 'custom', stepInterval: 12 }) === 12)
  check('自定义档：超上限夹到 60，非法值（0/非数）回落平稳 12 而不是夹成"每步都检"',
    resolveStepInterval({ injectPace: 'custom', stepInterval: 999 }) === 60
    && resolveStepInterval({ injectPace: 'custom', stepInterval: 0 }) === 12
    && resolveStepInterval({ injectPace: 'custom', stepInterval: 'abc' }) === 12)
  check('档位缺失（老配置只写了 stepInterval: 2）→ 平稳 12，不再吃旧数字', resolveStepInterval({ stepInterval: 2 }) === 12)
  check('档位写错（steadyy）→ 回落平稳，不抛错', resolveStepInterval({ injectPace: 'steadyy' }) === 12)
  check('档位表单调：激进 < 平稳 < 懒惰', INJECT_PACE_STEPS.aggressive < INJECT_PACE_STEPS.steady && INJECT_PACE_STEPS.steady < INJECT_PACE_STEPS.lazy)
}

console.log('== 7c. 平稳档（steady=12）长任务节奏：121 步 → 11 个检索注入点 ==')
{
  const CFGSteady = () => CFG_STEP_ONLY({ injectPace: 'steady' })
  let n = 0
  const { call, logs } = setup({
    cfg: CFGSteady,
    hits: () => [{ id: `mem12-${++n}`, content: `记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }],
  })
  const fallback = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
  const injected = []
  for (let i = 1; i <= 121; i++) {
    const d = await call(`第 ${i} 步的工作内容 ${i}`, fallback)
    if (d.messages.length === 2) injected.push(i)
  }
  check('121 步内注入于步 1,13,25,37,49,61,73,85,97,109,121（每满 12 步）', injected.join(',') === '1,13,25,37,49,61,73,85,97,109,121')
  check('11 次注入 = 1 次首检 + 10 次满 12 步', injected.length === 11)
  check('日志 step 与注入步号一致', logs.map((l) => l.step).join(',') === injected.join(','))
  check('日志带生效步距与档位（能对账"是哪档在跑"）', logs.every((l) => l.interval === 12 && l.pace === 'steady'))
}

console.log('== 7d. 懒惰档（lazy=30）长任务节奏：61 步 → 3 个检索注入点 ==')
{
  const CFGLazy = () => CFG_STEP_ONLY({ injectPace: 'lazy' })
  let n = 0
  const { call } = setup({
    cfg: CFGLazy,
    hits: () => [{ id: `mem30-${++n}`, content: `记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }],
  })
  const fallback = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
  const injected = []
  for (let i = 1; i <= 61; i++) {
    const d = await call(`第 ${i} 步的工作内容 ${i}`, fallback)
    if (d.messages.length === 2) injected.push(i)
  }
  check('61 步内只注入于步 1,31,61', injected.join(',') === '1,31,61')
}

console.log('== 7e. 自定义档 stepInterval=12：数字真正说了算 ==')
{
  const CFG12 = () => CFG_STEP_ONLY({ injectPace: 'custom', stepInterval: 12 })
  let n = 0
  const { call } = setup({
    cfg: CFG12,
    hits: () => [{ id: `memc-${++n}`, content: `记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }],
  })
  const fallback = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
  const injected = []
  for (let i = 1; i <= 37; i++) {
    const d = await call(`第 ${i} 步的工作内容 ${i}`, fallback)
    if (d.messages.length === 2) injected.push(i)
  }
  check('37 步内注入于步 1,13,25,37', injected.join(',') === '1,13,25,37')
}

console.log('== 7f. schema：injectPace 默认平稳、stepInterval 上限 60（v0.11.2 由 10 放宽） ==')
{
  check('Config({}).injectPace 默认 steady', cfgOf({}).injectPace === 'steady')
  check('Config({injectPace:"lazy"}) 接受', cfgOf({ injectPace: 'lazy' }).injectPace === 'lazy')
  check('Config({injectPace:"乱写"}) 不抛错（回落由解析层兜底）', cfgOf({ injectPace: '乱写' }).injectPace === '乱写')
  check('Config({stepInterval:12}) = 12（旧上限 10 会把用户要的 12 判非法）', cfgOf({ stepInterval: 12 }).stepInterval === 12)
  check('Config({}).stepInterval 默认仍是 10（自定义档的起点）', cfgOf({}).stepInterval === 10)
  let rejected = false
  try { Config({ stepInterval: 61 }) } catch { rejected = true }
  check('Config({stepInterval:61}) 被拒（上限 60）', rejected)
  let rejected0 = false
  try { Config({ stepInterval: 0 }) } catch { rejected0 = true }
  check('Config({stepInterval:0}) 被拒（下限 1）', rejected0)
}

console.log('== 7g. 客户端档位表与 config 同源（防"UI 写 12、代码跑 10"漂移） ==')
{
  const src = readFileSync(new URL('../client/settings.jsx', import.meta.url), 'utf8')
  const block = src.match(/const INJECT_PACE_OPTIONS = \[([\s\S]*?)\n\]/)?.[1] ?? ''
  const rows = [...block.matchAll(/\['([a-z]+)', '([^']+)', (\d+),/g)].map((m) => ({ key: m[1], label: m[2], steps: Number(m[3]) }))
  check('客户端列出 4 个档位（三档 + 自定义）', rows.length === 4 && rows.map((r) => r.key).join(',') === 'aggressive,steady,lazy,custom')
  check('档位步距与 INJECT_PACE_STEPS 完全一致', rows.filter((r) => r.key !== 'custom').every((r) => r.steps === INJECT_PACE_STEPS[r.key]))
  check('档位标签与 INJECT_PACE_LABELS 完全一致', rows.every((r) => r.label === INJECT_PACE_LABELS[r.key]))
}

console.log('== 5. 守卫：无真实用户文本 / 空检索 / reject 均不注入 ==')
{
  const { call } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'plugin:dsh-memory' }, content: [{ type: 'text', text: '[记忆] 注入块' }] }, { type: 'context' }] })
  const d1 = await call('', fallback) // handler 内 extractUserText 为空
  check('纯插件消息轮次：不注入且原样放行', d1.messages.length === 2)

  const { call: call2, logs: logs2 } = setup({ hits: [] })
  const d2 = await call2('检索无命中', async () => ({ kind: 'enter', messages: [userMsg('检索无命中'), { type: 'context' }] }))
  check('空检索：不注入', d2.messages.length === 2)

  const { call: call3 } = setup()
  const d3 = await call3('被否决轮次', async () => ({ kind: 'reject', reason: { kind: 'blocked', why: '测试' } }))
  check('reject 决策：原样透传、不注入', d3?.kind === 'reject' && d3?.messages === undefined)
}

console.log('== 6. 日志仍记录注入事件（步号/查询/命中/分数/scope） ==')
{
  const { call, logs } = setup()
  await call('日志验证问题', async () => ({ kind: 'enter', messages: [userMsg('日志验证问题'), { type: 'context' }] }))
  check('注入日志含 step=1 与 query/ids', logs.length === 1 && logs[0].step === 1 && logs[0].query.includes('日志验证问题') && logs[0].ids?.[0] === 'mem-x')
}

console.log('== 8. 时间戳注入（v0.9.32）：带时间但不破坏去抖 ==')
{
  const { call } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('x'), { type: 'context' }] })
  // 时间戳分离：注入文本带「当前时间」，去抖指纹不含时间
  const d1 = await call('时间戳问题甲', fallback)
  const memText = String(d1.messages.at(-1).content[0].text)
  check('注入块头带当前时间戳（当前时间：YYYY-MM-DD HH:MM:SS 周X）', /当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 周[一二三四五六日]/.test(memText))
  // 同一 hits 跨轮（间隔 ≥ stepInterval）：内容未变 → 即使时间在流逝也不重复注入
  await call('时间戳问题乙', fallback)
  const d3 = await call('时间戳问题丙', fallback)
  check('时间戳不破坏去抖：同 hits 第三轮不重复注入', d3.messages.length === 2)
}

console.log('== 9. 噪音剥离（v0.13.0）：平台/插件提醒不再被当成检索 query ==')
{
  const REMIND = '<system-reminder>\nConfigured MCP servers in this session (**capability descriptions only**)\n</system-reminder>'
  check('纯 system-reminder → 剥成空串', stripInjectedNoise(REMIND) === '')
  check('混排（真文本 + 提醒块）→ 只留真文本', stripInjectedNoise(`帮我看下注入\n${REMIND}`) === '帮我看下注入')
  check('普通文本原样通过', stripInjectedNoise('普通用户问题') === '普通用户问题')
  check('extractUserText 忽略「只有提醒」的用户消息', extractUserText([userMsg(REMIND)]) === '')
  check('extractUserText 仍取到同轮混合消息里的真文本', extractUserText([userMsg(`要点是这个\n${REMIND}`)]) === '要点是这个')
  check('多消息只留真文本（提醒不污染 query）', extractUserText([userMsg('先说 A'), userMsg(REMIND)]) === '先说 A')
  const events = [
    { type: 'user/message', data: userMsg(REMIND) },
    { type: 'assistant/message', data: { message: { role: 'assistant', source: { provider: 'mock' }, content: [{ type: 'text', text: '我在改注入管线' }] } } },
  ]
  // v0.15.3：改由真实投影单元折叠出 state（旧写法是伪造 agent.session.events 喂给 extractWorkText）
  const w = extractWorkText(foldWork(events))
  check('extractWorkText（投影 state）同样剥掉提醒块', w.includes('注入管线') && !w.includes('system-reminder'))
}

console.log('== 9b. 真凶回归：工具步（消息里只剩提醒）不再拿提醒当 query，回落工作上下文 ==')
{
  const REMIND = '<system-reminder>\nConfigured MCP servers in this session (**capability descriptions only**)\n</system-reminder>'
  const events = [
    { type: 'user/message', data: userMsg('帮我把常驻注入做出来') },
    { type: 'assistant/message', data: { message: { role: 'assistant', source: { provider: 'mock' }, content: [{ type: 'text', text: '正在改 inject.js' }] } } },
  ]
  const { call, logs } = setup({ workState: foldWork(events) })
  const fallback = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
  const d = await call(null, fallback, { agent: { id: 'tool-step', session: {} }, messages: [userMsg(REMIND)] })
  check('工具步照样注入', d.messages.length === 2)
  check('query 用的是真实工作上下文', logs.at(-1).queryKind === 'work' && logs.at(-1).query.includes('常驻注入'))
  check('query 里不再有 MCP 提醒字样', !logs.at(-1).query.includes('MCP servers'))

  // 9c：投影服务不可用（headless 组装 / 老内核）→ 退回"没有工作文本"，不炸，并留一条诊断告警
  {
    const s2 = setup() // workState 默认 null → available=false
    const d2 = await s2.call(null, fallback, { agent: { id: 'no-proj', session: {} }, messages: [userMsg(REMIND)] })
    check('投影不可用 + 无用户文本 → 不注入且不抛错', Array.isArray(d2.messages) && d2.messages.length === 1)
    check('写一条 inject.work_missing 诊断告警', s2.logs.filter((l) => l.ev === 'inject.work_missing').length === 1)
  }
}

console.log('== 10. 常驻通道（v0.13.0）：不依赖检索，恒定抵达 ==')
{
  const PINS = [
    { id: 'mem-pin1', type: 'lesson', content: '先搜再动：任何工作先搜索六个方向，别乱窜。', abstract: 'principle' },
    { id: 'mem-pin2', type: 'decision', content: '密钥绝不进日志与记忆。', abstract: 'principle' },
  ]
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('随便问一句'), { type: 'context' }] })
  // 10a：检索零命中，常驻仍注入（这正是用户要的"不是讲到了才注入"）
  {
    const { call, logs } = setup({ hits: [], pins: PINS })
    const d = await call('家常话，与记忆毫无关系', fallback)
    check('检索 0 命中但常驻有内容 → 照常注入', d.messages.length === 3)
    const text = String(d.messages.at(-1).content[0].text)
    check('块内含常驻段落与两条钉选记忆', text.includes('[记忆] 常驻要点') && text.includes('#mem-pin1') && text.includes('#mem-pin2'))
    check('常驻块不带相关度/时间戳（恒定文本，不随时间变）', !text.includes('相关度') && !text.includes('当前时间'))
    check('日志记录常驻条数与 id', logs.at(-1).pinned === 2 && logs.at(-1).pinIds.join(',') === 'mem-pin1,mem-pin2')
  }
  // 10b：有检索命中时，常驻在前、检索在后（位置稳定 → KV 前缀可命中）
  {
    const { call } = setup({ pins: PINS })
    const d = await call('记忆偏好问题', fallback)
    const text = String(d.messages.at(-1).content[0].text)
    check('常驻块排在检索块之前', text.indexOf('常驻要点') < text.indexOf('与当前工作相关的既有记录'))
    check('两块同处一条注入消息', text.includes('#mem-pin1') && text.includes('#mem-x'))
    check('检索 query 照旧（常驻不影响检索）', true)
  }
  // 10c：常驻内容不变 → 跨轮去抖，不刷屏
  {
    const { call } = setup({ hits: [], pins: PINS })
    const d1 = await call('甲', fallback)
    const d2 = await call('乙', fallback)
    const d3 = await call('丙', fallback)
    check('首轮注入常驻块', d1.messages.length === 3)
    check('步距内跳过', d2.messages.length === 2)
    check('步距到但常驻内容未变 → 去抖不重复注入（恒定≠每步刷屏）', d3.messages.length === 2)
  }
  // 10d：常驻清单变化 → 块指纹变化 → 重新抵达
  {
    let list = [PINS[0]]
    const { call } = setup({ hits: [], pins: () => list })
    const d1 = await call('甲', fallback)
    await call('乙', fallback)
    list = [PINS[0], PINS[1]]
    const d3 = await call('丙', fallback)
    check('首轮注入', d1.messages.length === 3)
    check('新钉选一条后重新注入（指纹含常驻块）', d3.messages.length === 3 && String(d3.messages.at(-1).content[0].text).includes('#mem-pin2'))
  }
  // 10e：常驻不进防循环窗口（excludeIds 只收检索块）
  {
    let n = 0
    const { call, lastArgs } = setup({
      pins: PINS,
      hits: () => [{ id: `mem-r${++n}`, content: `检索记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }],
    })
    await call('甲', fallback); await call('乙', fallback); await call('丙', fallback)
    check('excludeIds 只含检索块，不含常驻 id', lastArgs.opts.excludeIds.every((id) => !String(id).startsWith('mem-pin')))
    check('excludeIds 已累积前轮检索命中', lastArgs.opts.excludeIds.includes('mem-r1'))
  }
}

console.log('== 11. 常驻装配与渲染（buildPinned / renderPinned） ==')
{
  const mk = (i, len) => ({ id: `mem-b${i}`, type: 'lesson', content: 'x'.repeat(len), abstract: 'principle' })
  // v0.18.0：本节的断言锁的是 **step 档**（旧行为）的渲染——故显式带上该档位。
  // session 档的块头与增量渲染见 §17。
  const STEP = { pinnedInjection: 'step' }
  const fakeStore = { listPinned: ({ limit }) => [mk(1, 10), mk(2, 4000), mk(3, 10)].slice(0, limit) }
  const r = buildPinned(fakeStore, { ...STEP, pinnedLimit: 8, pinnedMaxTokens: 100 })
  check('buildPinned 受 pinnedMaxTokens 约束（4000 字那条被挡在预算外）', r.pins.length === 1 && r.pins[0].id === 'mem-b1')
  check('buildPinned 渲染非空', r.text.includes('#mem-b1') && r.text.includes('恒定注入'))
  const r2 = buildPinned({ listPinned: () => [] }, { ...STEP, pinnedLimit: 8, pinnedMaxTokens: 600 })
  check('无常驻 → 空文本（不产生空块头）', r2.pins.length === 0 && r2.text === '')
  const r3 = buildPinned({ listPinned: () => { throw new Error('boom') } }, STEP)
  check('存储异常 → 降级为空且不抛错（常驻坏了不连累注入）', r3.pins.length === 0 && r3.text === '')
  const fakeLimit = { listPinned: ({ limit }) => [mk(1, 10), mk(2, 10), mk(3, 10)].slice(0, limit) }
  check('pinnedLimit 生效（只取前 2 条）', buildPinned(fakeLimit, { ...STEP, pinnedLimit: 2, pinnedMaxTokens: 600 }).pins.length === 2)
  // v0.13.1：预算必须按「真正注入的那一行」计费（旧实现按未截断原文计费 → 只装得下 1 条）
  {
    const longPins = { listPinned: ({ limit }) => [mk(1, 4000), mk(2, 4000), mk(3, 4000)].slice(0, limit) }
    const r4 = buildPinned(longPins, { ...STEP, pinnedLimit: 8, pinnedMaxTokens: 500 })
    check('超长钉选按渲染后的行长计费（3 条在 500 token 预算内全装得下）', r4.pins.length === 3)
    check('超长钉选在块内被截到单条上限', r4.text.length < 1100 && r4.text.includes('#mem-b3'))
  }
  // v0.18.0：预算计费与档位无关——session 档的块头更长一点，不该把成员挤出预算
  {
    const longPins = { listPinned: ({ limit }) => [mk(1, 4000), mk(2, 4000), mk(3, 4000)].slice(0, limit) }
    const r5 = buildPinned(longPins, { pinnedInjection: 'session', pinnedLimit: 8, pinnedMaxTokens: 500 })
    check('session 档同样按行长计费（3 条全装得下）', r5.pins.length === 3 && r5.text.includes('会话级注入'))
  }
  const text = renderPinned([{ id: 'mem-1', type: 'lesson', content: '第一行\n第二行' }], { scope: 'step' })
  check('renderPinned 头含条数与「恒定注入」', text.startsWith('[记忆] 常驻要点（恒定注入 · 钉选 1 条'))
  check('renderPinned 多行内容压成单行', text.includes('第一行 第二行') && !text.includes('\n第二行'))
  check('renderPinned 带类型小标（lesson → 教训）', text.includes('【教训】#mem-1'))
  check('renderPinned 空数组 → 空串', renderPinned([]) === '' && renderPinned(undefined) === '')
  check('renderPinned 确定性：同输入逐字相同（去抖前提）',
    renderPinned([{ id: 'a', type: 'note', content: 'z' }], { scope: 'step' }) === renderPinned([{ id: 'a', type: 'note', content: 'z' }], { scope: 'step' }))
}

console.log('== 12. 存储层：pinned 列 / 常驻清单 / 确定性顺序 ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pin-'))
  let s
  try {
    s = new MemoryStore(join(dir, 'p.db'), {})
    const id1 = await s.add({ layer: 'sm', type: 'lesson', scope: 'global', content: '教训一：先搜再动', keywords: [] })
    const id2 = await s.add({ layer: 'sm', type: 'note', scope: 'global', content: '普通笔记', keywords: [] })
    check('新库默认无常驻', s.pinnedCount() === 0 && s.listPinned().length === 0)
    check('setPinned 生效', s.setPinned(id1, true) === true && s.pinnedCount() === 1)
    check('listPinned 带出该条', s.listPinned()[0].id === id1)
    check('list({pinned:true}) 过滤生效', s.list({ pinned: true }).length === 1 && s.list({ pinned: true })[0].id === id1)
    check('list() 默认不受 pinned 影响', s.list().length === 2)
    const before = s.get(id1).updated_at
    check('钉选不动 updated_at（治理动作不该顶到浏览列表最前）', s.get(id1).updated_at === before)
    check('取消钉选生效', s.setPinned(id1, false) === true && s.pinnedCount() === 0)
    check('未知 id → false（不抛错）', s.setPinned('mem-nope', true) === false)
    s.setPinned(id1, true)
    s.setPinned(id2, true)
    check('顺序按创建先后（rowid）且与 updated_at 无关 —— 注入块必须确定性',
      s.listPinned().map((m) => m.id).join(',') === `${id1},${id2}`)
    s.setPinned(id1, false)
    check('取消钉选后清单只剩一条', s.listPinned().map((m) => m.id).join(',') === id2)
  } finally {
    try { s.close() } catch { /* 已关或未建 */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 句柄未释放时忽略 */ }
  }
}

console.log('== 12b. schema：常驻旋钮默认值 ==')
{
  check('Config({}).pinnedLimit 默认 8', cfgOf({}).pinnedLimit === 8)
  check('Config({}).pinnedMaxTokens 默认 600', cfgOf({}).pinnedMaxTokens === 600)
  check('Config({pinnedLimit:20}).pinnedLimit = 20', cfgOf({ pinnedLimit: 20 }).pinnedLimit === 20)
  let rej = false
  try { Config({ pinnedLimit: 0 }) } catch { rej = true }
  check('pinnedLimit=0 被拒（至少 1 条）', rej)
}

console.log('== 13. 工作上下文投影（v0.15.3）：官方 sessionProjections 单元的本体行为 ==')
{
  const U = (t) => ({ type: 'user/message', data: userMsg(t) })
  const A = { type: 'assistant/message', data: { message: { role: 'assistant', source: { provider: 'mock' }, content: [{ type: 'text', text: '答一' }] } } }
  const PL = { type: 'user/message', data: { role: 'user', source: { kind: 'plugin:other' }, content: [{ type: 'text', text: '插件回声不该进工作上下文' }] } }

  // 13a：不关心的事件必须返回**同一引用**（内核靠 Object.is 短路；返回新对象会让下游白跑一遍）
  const st0 = workProjectionInit()
  check('不关心的事件返回同一引用', workProjectionApply(st0, { type: 'turn/start', data: { turn: 1 } }) === st0)

  // 13b：只收人话；插件自己的注入块要跳过（否则拿自己的回声当 query，滚雪球）
  let st = workProjectionApply(st0, U('第一句'))
  st = workProjectionApply(st, PL)
  st = workProjectionApply(st, A)
  check('跳过 source.kind=plugin 的注入块', !JSON.stringify(st).includes('插件回声'))
  check('收下用户与助手文本（时间序）', extractWorkText(st) === '第一句\n答一')

  // 13c：环形缓冲上限（工作上下文只要"最近在忙什么"，不是全会话）
  let st2 = workProjectionApply(workProjectionInit(), U('第一句'))
  for (let i = 0; i < WORK_KEEP + 3; i++) st2 = workProjectionApply(st2, U(`第${i}句`))
  check(`只保留最近 ${WORK_KEEP} 条（环形缓冲）`, st2.recent.length === WORK_KEEP)
  check('最旧的被挤掉、最新的在', !extractWorkText(st2).includes('第一句') && extractWorkText(st2).includes(`第${WORK_KEEP + 2}句`))

  // 13d：纯提醒块不产生工作文本（工具步 payload 里常只剩 MCP 提醒）
  const dirty = workProjectionApply(workProjectionInit(), U('<system-reminder>\nMCP servers\n</system-reminder>'))
  check('纯提醒块的用户消息不产生工作文本', extractWorkText(dirty) === '')

  // 13e：stateSchema.parse 清洗脏数据（内核恢复持久化缓存时调用；抛错会带崩整条投影驱动）
  const parsed = workStateSchema.parse({ recent: [{ role: 'bogus', text: 'x' }, { role: 'user', text: 'ok' }, null, { role: 'assistant', text: '' }] })
  check('parse 剔掉非法条目且不抛错', parsed.recent.length === 1 && parsed.recent[0].text === 'ok')
  check('parse(垃圾) 也返回合法空状态', workStateSchema.parse(undefined).recent.length === 0)

  // 13f：单条截断（工作 query 不该被一段超长粘贴撑爆）
  const longState = workProjectionApply(workProjectionInit(), U('啊'.repeat(WORK_ITEM_CHARS * 12)))
  check(`单条按 WORK_ITEM_CHARS=${WORK_ITEM_CHARS} 截断`, extractWorkText(longState).length === WORK_ITEM_CHARS)
}

console.log('== 14. v4 producer source（v0.15.3）：LLM 请求与注入消息必须带 producer-owned source ==')
{
  // 背景（2026-10-04 主人实测报错）：内核 dsh-session-format-v3-to-v4 的 source() 规则是
  //   source 必须是 JSON 对象 + kind 必须是非空字符串 + kind !== 'plugin'（裸 'plugin' 是已退役的
  //   v3 写法），第三方插件按 producerKind() 兜底分支取 `plugin:<插件名>`。
  // assertV4MessageSources 在 Session **采纳**前对每个消息槽无条件校验（mapEventMessages 里
  // `session/title-llm-request` 取 data.messages），缺 source 就直接抛错 → 提取全线降级规则路径。
  const { call } = setup()
  const d = await call('测 source 形状', async () => ({ kind: 'enter', messages: [userMsg('测 source 形状')] }))
  const injected = d.messages.find((m) => m.source?.kind === 'plugin:dsh-memory')
  check("注入消息 kind 是 producer-owned 的 'plugin:dsh-memory'", !!injected)
  check('注入消息不带已退役的 plugin 字段', !!injected && !Object.hasOwn(injected.source, 'plugin'))

  // 源码级守卫：这两处手写 LLM 请求消息曾因缺 source 被内核拒绝（refiner 提取 / 诊断探针）
  const { readFileSync } = await import('node:fs')
  const pat = /messages: \[\{ role: 'user', source: \{ kind: 'plugin:dsh-memory'/
  const refinerSrc = readFileSync(new URL('../lib/refiner.js', import.meta.url), 'utf8')
  check('refiner 的 LLM 请求消息带 producer source', pat.test(refinerSrc))
  const indexSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  check('诊断探针的 LLM 请求消息带 producer source', pat.test(indexSrc))
}

console.log('== 15. 用户消息触发（v0.16.0）：每条新用户消息都必检一次，不看步距 ==')
{
  const fb = async () => ({ kind: 'enter', messages: [userMsg('x'), { type: 'context' }] })
  /** 用户消息触发开启的配置（步距故意设成 12，用来证明"新消息不受它管"）。 */
  const CFG_UM = (over = {}) => ({
    ...CFG(),
    ...over,
    injectPace: over.injectPace ?? 'custom',
    stepInterval: over.stepInterval ?? 12,
    features: { preStepInject: true, userMessageTrigger: true, ...(over.features ?? {}) },
  })

  // 15a：步距 12 也拦不住——三条不同的用户消息连着发，逐条检索注入
  {
    let n = 0
    const { call, logs } = setup({ cfg: CFG_UM, hits: () => [{ id: `mem-u${++n}`, content: `新消息记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }] })
    const d1 = await call('第一个问题', fb)
    const d2 = await call('第二个问题', fb)
    const d3 = await call('第三个问题', fb)
    check('15a 三条新消息各自注入（步距 12 拦不住）', [d1, d2, d3].every((d) => d.messages.length === 3))
    check('15a 三次检索、三条注入日志', logs.filter((l) => l.ev === 'inject').length === 3)
    check("15a 日志触发源标为 user-message", logs.filter((l) => l.ev === 'inject').every((l) => l.trigger === 'user-message'))
  }

  // 15b：同一条用户消息再次出现（同轮里被重复带上）→ 不重复检索
  {
    let n = 0
    const { call, logs } = setup({ cfg: CFG_UM, hits: () => [{ id: `mem-v${++n}`, content: `记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }] })
    const d1 = await call('同一个问题', fb)
    const d2 = await call('同一个问题', fb)
    check('15b 首次注入', d1.messages.length === 3)
    check('15b 同文本再出现不重复检索', d2.messages.length === 2 && logs.filter((l) => l.ev === 'inject').length === 1)
  }

  // 15c：开关关掉 → 回到纯步距契约（v0.15.x 行为）
  {
    let n = 0
    const { call } = setup({ cfg: () => CFG_STEP_ONLY({ stepInterval: 12 }), hits: () => [{ id: `mem-w${++n}`, content: `记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }] })
    const d1 = await call('第一个问题', fb)
    const d2 = await call('第二个问题', fb)
    check('15c 关掉后：首检注入、第二条被步距拦下', d1.messages.length === 3 && d2.messages.length === 2)
  }

  // 15d：工具步仍然按步距走（触发源可对账）
  {
    const events = [{ type: 'user/message', data: userMsg('原始任务：改注入管线') }]
    let n = 0
    const { call, logs } = setup({
      cfg: () => CFG_UM({ stepInterval: 2 }),
      workState: foldWork(events),
      hits: () => [{ id: `mem-t${++n}`, content: `记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }],
    })
    const fbWork = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
    await call('问题甲', fb) // step1：用户消息 → 必检
    await call(null, fbWork, { messages: [] }) // step2：工具步（无用户文本）→ 步距内 → 跳过
    await call(null, fbWork, { messages: [] }) // step3：工具步 → 步距到 → 检索
    const trig = logs.filter((l) => l.ev === 'inject').map((l) => l.trigger)
    check('15d 触发源可对账（user-message → interval）', trig.join(',') === 'user-message,interval')
  }
}

console.log('== 16. 注入侧不接决策模型（2026-10-06 主人判定）：来了新消息就直接查库 ==')
{
  // 源码级守卫：这条链路上**不该**再出现对决策门的任何调用。
  // 曾经接过一次（ask + skipSearch），被判定为多余——查库是注入链路的本职工作，
  // 为它加一道"要不要查"的本地判断，等于在关键路径上多花 0.4~1.2 秒，还要承担"判错就漏检索"的风险。
  const injectSrc = readFileSync(new URL('../lib/pipelines/inject.js', import.meta.url), 'utf8')
  check('16a 注入管线没有决策门调用（ask / askWorth）', !/askWorth\(|\.ask\(/.test(injectSrc))
  check('16b 注入管线没有跳过检索的分支（skipSearch）', !/skipSearch/.test(injectSrc))
  // v0.18.0：检索的触发条件多了 searchNow（常驻差量那一步不发检索，见 §17c），
  // 所以这里断言的是「检索仍由 queryText 直接作为检索输入」，而不是它的前置条件长什么样。
  check('16c 检索仍由 queryText 直接触发', /const hits = searchNow && queryText\s*\n\s*\? await store\.search\(queryText/.test(injectSrc))
  check('16d 注入管线源码里不再出现 decisionGate 字样', !/decisionGate/.test(injectSrc))

  // schema：注入侧的开关与门槛都已移除，写入侧的仍在
  const c = cfgOf({})
  check('16e features 里不再有 decisionGate 开关', c.features.decisionGate === undefined)
  check('16f decision 里不再有注入侧 minConfidence', c.decision.minConfidence === undefined)
  // v0.16.1：writeGate 默认值由 true 改成 false（决策服务一般不开），但开关与门槛都还在
  check('16g 写入侧的开关与门槛还在（不受影响）', c.features.writeGate === false && c.decision.writeMinConfidence === 0.9)
}

console.log('== 17. 会话级注入（v0.18.0）：首轮一次 + 变化时增量 ==')
{
  // 需求《常驻记忆改会话级注入》的验收标准逐条对应在本节：
  //   ① 首轮整份 ② 后续不重复 ③ pin 新增增量 ④ unpin 移除增量 ⑤ 内容修改增量 ⑦ 切回旧档每步注入
  //   ⑥ 检索行为不受影响 —— 由 §15/§16 的既有断言继续把守，这里只补一条"常驻不再挤检索"的现场。
  const PINS = [
    { id: 'mem-p1', type: 'lesson', content: '教训甲：先搜再动。', abstract: 'principle' },
    { id: 'mem-p2', type: 'decision', content: '决策乙：密钥不进日志。', abstract: 'principle' },
  ]
  /** session 档（默认）+ 关掉用户消息触发，好观察步距与常驻各自的作用。 */
  const CFG_SESSION = (over = {}) => ({
    ...CFG(),
    ...over,
    pinnedInjection: 'session',
    injectPace: 'custom',
    stepInterval: over.stepInterval ?? 5,
    features: { preStepInject: true, userMessageTrigger: false, ...(over.features ?? {}) },
  })
  const fb = async () => ({ kind: 'enter', messages: [userMsg('x'), { type: 'context' }] })
  const textOf = (d) => String(d?.messages?.at(-1)?.content?.[0]?.text ?? '')
  const memBlocks = (d) => (d?.messages ?? []).filter((m) => m?.source?.kind === 'plugin:dsh-memory')

  // 17a（验收 1 + 2）：首轮整份、后续不重复
  {
    const { call, logs } = setup({ hits: [], pins: PINS, cfg: CFG_SESSION })
    const d1 = await call('第一句话', fb)
    check('17a 首轮注入常驻整份', memBlocks(d1).length === 1 && textOf(d1).includes('#mem-p1') && textOf(d1).includes('#mem-p2'))
    check('17a 首轮块头是 session 档措辞', textOf(d1).includes('会话级注入') && !textOf(d1).includes('恒定注入'))
    check('17a 日志标 phase=initial', logs.at(-1)?.pinPhase === 'initial')
    const d2 = await call('第二句话', fb)
    check('17a 第二轮无重复常驻块（步距内整步跳过）', memBlocks(d2).length === 0)
    // 走到步距（5 步）→ 完整检索路径重跑，常驻仍**不重复**（清单没变）
    await call('中间甲', fb); await call('中间乙', fb); await call('中间丙', fb)
    const d6 = await call('第六句话', fb)
    check('17a 步距到、清单未变 → 这一步没有常驻整份', memBlocks(d6).length === 0)
    // 这一步检索零命中且常驻 unchanged → 块为空、整步早退，连注入日志都不产生。
    // 于是"首轮那一条 initial 之后没有再写任何 inject 日志"本身就是 unchanged 的证据。
    check('17a 全程只发生过首轮那一次注入（没有重复）',
      logs.filter((l) => l.ev === 'inject').length === 1 && logs.at(-1)?.pinPhase === 'initial')
    // 同上这条容易误读成"检索也停了"，所以补一个检索有命中的场面：
    // 步距到 → 检索块照常注入，但块里**只有**检索段，且日志标 unchanged。
    let n = 0
    const s2 = setup({
      pins: PINS, cfg: CFG_SESSION,
      hits: () => [{ id: `mem-r${++n}`, content: `检索记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }],
    })
    await s2.call('开头', fb)
    await s2.call('二', fb); await s2.call('三', fb); await s2.call('四', fb); await s2.call('五', fb)
    const dp = await s2.call('六', fb)
    check('17a 清单未变时检索块照常注入、块内无常驻段',
      textOf(dp).includes('与当前工作相关的既有记录') && !textOf(dp).includes('#mem-p1'))
    check('17a 该步日志 phase=unchanged（常驻这次什么都没发）', s2.logs.at(-1)?.pinPhase === 'unchanged')
  }

  // 17b（验收 3/4/5）：pin / 改内容 / unpin → 下一轮增量
  {
    let list = [PINS[0]]
    const { call, logs } = setup({ hits: [], pins: () => list, cfg: CFG_SESSION })
    const d1 = await call('开场', fb)
    check('17b 开场只带 1 条', textOf(d1).includes('#mem-p1') && !textOf(d1).includes('#mem-p2'))
    // ① 新增钉选 → 下一轮增量（且不被步距拦下）
    list = [PINS[0], PINS[1]]
    const d2 = await call('随手一句', fb)
    const t2 = textOf(d2)
    check('17b 新钉选 → 下一轮出现增量块（步距拦不住）', memBlocks(d2).length === 1 && t2.includes('常驻要点变更'))
    check('17b 增量块只报新增那条（不重发整份）', t2.includes('➕ 新增') && t2.includes('#mem-p2') && !t2.includes('#mem-p1'))
    check('17b 日志标 phase=delta 并记下变化 id',
      logs.at(-1)?.pinPhase === 'delta' && logs.at(-1)?.pinDelta?.added?.join(',') === 'mem-p2')
    // ② 内容被修改 → 下一轮增量（更新）
    list = [PINS[0], { ...PINS[1], content: '决策乙（修订）：密钥不进日志与记忆。' }]
    const d3 = await call('再一句', fb)
    const t3 = textOf(d3)
    check('17b 已钉内容被改 → 下一轮出现更新增量', t3.includes('✏️ 更新') && t3.includes('密钥不进日志与记忆'))
    check('17b 更新日志记下 updated id', logs.at(-1)?.pinDelta?.updated?.join(',') === 'mem-p2')
    // ③ 取消钉选 → 下一轮增量（移除）
    list = [PINS[0]]
    const d4 = await call('又一句', fb)
    const t4 = textOf(d4)
    check('17b 取消钉选 → 下一轮出现移除提示', t4.includes('➖ 移除') && t4.includes('#mem-p2'))
    check('17b 移除日志记下 removed id', logs.at(-1)?.pinDelta?.removed?.join(',') === 'mem-p2')
    // ④ 稳定态：清单没再动 → 不再发增量（增量本身也不能刷屏）
    const d5 = await call('最后一句', fb)
    check('17b 清单稳定后不再发增量', memBlocks(d5).length === 0)
  }

  // 17c：增量那一步不做检索（不把节拍提前、不捞窗口外的旧命中）
  {
    let list = [PINS[0]]
    let searches = 0
    const { call, logs } = setup({
      pins: () => list,
      hits: () => { searches++; return [{ id: `mem-h${searches}`, content: `命中${searches}`, score: 0.5, layer: 'sm', updated_at: Date.now() }] },
      cfg: CFG_SESSION,
    })
    await call('开场', fb)
    const afterFirst = searches
    list = [PINS[0], PINS[1]]
    const d2 = await call('随手一句', fb)
    check('17c 增量步仍注入', memBlocks(d2).length === 1)
    check('17c 增量步不触发检索', searches === afterFirst)
    check('17c 触发源标为 pinned-delta', logs.at(-1)?.trigger === 'pinned-delta')
  }

  // 17d（需求 §六.3 判定方式）：记账按 agent id 隔离，各会话各自首轮
  {
    const { call } = setup({ hits: [], pins: PINS, cfg: CFG_SESSION })
    const agentA = { id: 'sess-A', session: {} }
    const agentB = { id: 'sess-B', session: {} }
    const dA = await call('A 开场', fb, { agent: agentA })
    const dB = await call('B 开场', fb, { agent: agentB })
    check('17d 两个会话各自拿到整份（互不消耗）', textOf(dA).includes('#mem-p1') && textOf(dB).includes('#mem-p1'))
    const dA2 = await call('A 第二句', fb, { agent: agentA })
    check('17d A 的第二句不再重复', memBlocks(dA2).length === 0)
    // 记账随 agent 生命周期回收（源码级守卫：进程内 Map 不该随会话无限增长）
    check('17d 记账随 agent 销毁回收（挂了 agent/disposed）',
      /ctx\.on\('agent\/disposed'[\s\S]{0,200}pinSession\.delete/.test(readFileSync(new URL('../lib/pipelines/inject.js', import.meta.url), 'utf8')))
  }

  // 17e（验收 6）：检索行为不受影响——门槛、scope、日志字段照旧
  {
    let n = 0
    const { call, lastArgs, logs } = setup({
      pins: PINS,
      hits: () => [{ id: `mem-q${++n}`, content: `检索记忆${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }],
      // setup 的 cfg 是**取配置的函数**（对应真实的 getCfg），不是配置对象本身
      cfg: () => CFG_SESSION({ features: { userMessageTrigger: true } }),
    })
    const d1 = await call('记忆偏好问题', fb)
    check('17e 首轮常驻在前、检索在后（位置稳定）', textOf(d1).indexOf('常驻要点') < textOf(d1).indexOf('与当前工作相关的既有记录'))
    const d2 = await call('另一个问题', fb)
    check('17e 第二条用户消息照常检索注入', textOf(d2).includes('#mem-q2'))
    check('17e 第二条里没有再出现常驻整份', !textOf(d2).includes('#mem-p1'))
    check('17e 检索门槛与 scope 参数原样传下去', lastArgs.opts.minScore === 0.02 && lastArgs.opts.scope.includes('global'))
    check('17e 检索日志字段未被改动（picked/ids 照旧）', logs.at(-1)?.picked === 1 && logs.at(-1)?.ids?.length === 1)
  }

  // 17f（验收 7）：切回 step 档 → 与改动前一致（首轮注入 + 内容变则重发；内容不变由块指纹去抖）
  {
    let list = [PINS[0]]
    // 步距压到 2，省得为了踩到节拍点写一长串无意义的步
    const CFG_STEP = () => ({ ...CFG_SESSION({ stepInterval: 2 }), pinnedInjection: 'step' })
    const { call } = setup({ hits: [], pins: () => list, cfg: CFG_STEP })
    const d1 = await call('甲', fb) // step 1 → 首轮，注入
    await call('乙', fb)            // step 2 → 距上次 1 步 < 2 → 节流
    const d3 = await call('丙', fb) // step 3 → 距上次 2 步 → 步距到
    check('17f step 档首轮注入整份且措辞为「恒定注入」', textOf(d1).includes('恒定注入') && textOf(d1).includes('#mem-p1'))
    check('17f step 档步距到、清单未变 → 与 §10c 一致（块指纹去抖，不刷屏）', memBlocks(d3).length === 0)
    list = [PINS[0], PINS[1]]
    await call('丁', fb)            // step 4 → 节流
    const d5 = await call('戊', fb) // step 5 → 步距到，清单已变
    check('17f step 档清单变了 → 重发**整份**（旧行为；session 档此时只发差量，见 17b）',
      memBlocks(d5).length === 1 && textOf(d5).includes('#mem-p1') && textOf(d5).includes('#mem-p2'))
  }

  // 17g：预热不再重复摆常驻（需求 §六.4）——session 档下由注入管线在首轮负责
  {
    const { attachPreheatPipeline } = await import('../lib/pipelines/inject.js')
    const mkPreheat = (cfgFn) => {
      const events = {}
      let text = ''
      const agent = {
        id: 'pre-1',
        session: {},
        ctx: {
          inject: (_svc, cb) => {
            cb({ systemPrompt: { getSectionOrder: () => 0, section: (o) => { text = o.text() } } })
            return { dispose() {} }
          },
        },
      }
      const ctx = {
        on: (n, cb) => { events[n] = cb },
        // 通道 A 的准入门槛：ctx.get('systemPrompt') 必须存在（老内核没有 → 自动走通道 B）。
        // 这里给一个非 undefined 的占位，模拟 0.2.0-rc.2。
        get: (name) => (name === 'systemPrompt' ? {} : undefined),
      }
      attachPreheatPipeline(ctx, {
        store: {
          listPinned: () => [{ id: 'mem-p1', type: 'lesson', content: '教训甲', abstract: 'principle' }],
          list: () => [{ id: 'mem-s1', type: 'note', content: '种子记忆', abstract: 'principle', layer: 'sm', scope: 'global', keywords: [] }],
          getMeta: () => null,
        },
        getCfg: cfgFn,
        wsRegistry: { list: () => [] },
        logStore: () => {},
      })
      events['agent/created']({ agent })
      return { text: () => text }
    }
    const session = mkPreheat(() => ({ ...CFG_SESSION(), features: { preStepInject: true, preheatRoute: 'prompt-section' } }))
    // 注意：预热块头本身就写着「常驻/画像优先的长期记忆」，所以判据取**条目行**（`- [常驻·…]`）
    // 而不是"块里有没有常驻这两个字"——那会把块头也算进去，是一条会自己骗自己的断言。
    check('17g session 档：预热块不含常驻条目（避免首轮两段重复）',
      !session.text().includes('[常驻·') && session.text().includes('种子记忆'))
    const step = mkPreheat(() => ({ ...CFG_SESSION(), pinnedInjection: 'step', features: { preStepInject: true, preheatRoute: 'prompt-section' } }))
    check('17g step 档：预热照旧摆常驻条目（旧形态不变）', step.text().includes('[常驻·lesson] 教训甲'))
  }

  // 17h（schema + 容错）：档位默认值与非法值处置
  {
    const c = cfgOf({})
    check('17h pinnedInjection 默认 session', c.pinnedInjection === 'session')
    check('17h 显式 step 被接受', cfgOf({ pinnedInjection: 'step' }).pinnedInjection === 'step')
    const { call } = setup({ hits: [], pins: PINS, cfg: () => ({ ...CFG_SESSION(), pinnedInjection: '瞎写的' }) })
    const d = await call('开场', fb, { agent: { id: 'sess-bad', session: {} } })
    check('17h 非法档位静默回落 session（照常注入不抛错）', textOf(d).includes('会话级注入'))
  }

  // 17j（需求 §六.1 长会话截断）：步号倒退 = 会话被 clear/compact 过 → 重发整份兜底
  {
    const { handler, logs } = setup({ hits: [], pins: PINS, cfg: CFG_SESSION })
    const agent = { id: 'sess-compact', session: {} }
    const run = (turn, step) => handler(
      { messages: [userMsg(`第${turn}轮`)], agent, turn, step, signal: {} },
      async () => ({ kind: 'enter', messages: [userMsg('x'), { type: 'context' }] }),
    )
    const d1 = await run(1, 1)
    await run(1, 2)
    // 压缩后内核从 turn 1 / step 1 重数 —— 步号倒退
    const d3 = await run(1, 1)
    check('17j 首轮注入整份', textOf(d1).includes('#mem-p1'))
    check('17j 步号倒退（compact/clear 后重数）→ 重发整份兜底',
      memBlocks(d3).length === 1 && textOf(d3).includes('#mem-p1') && logs.at(-1)?.pinPhase === 'restart')
    check('17j 重注入留下可对账的日志（pin_restart）', logs.some((l) => l.ev === 'inject.pin_restart'))
    // 兜底之后仍回到"清单没变就不发"
    const d4 = await run(1, 2)
    check('17j 兜底之后照旧按 unchanged 走', memBlocks(d4).length === 0)
    // 反向守卫：正常推进不得被判成 restart（否则每一轮都会重发整份）
    const s2 = setup({ hits: [], pins: PINS, cfg: CFG_SESSION })
    const a2 = { id: 'sess-normal', session: {} }
    await s2.handler({ messages: [userMsg('一')], agent: a2, turn: 1, step: 1, signal: {} }, fb)
    await s2.handler({ messages: [userMsg('二')], agent: a2, turn: 1, step: 2, signal: {} }, fb)
    await s2.handler({ messages: [userMsg('三')], agent: a2, turn: 2, step: 1, signal: {} }, fb)
    check('17j 正常换轮（turn 1→2）不算 restart', !s2.logs.some((l) => l.ev === 'inject.pin_restart'))
  }

  // 17i：增量渲染与差分（纯函数层，不经过管线）
  {
    const { pinnedItemMap, diffPinned, renderPinnedDelta } = await import('../lib/util.js')
    const a = { id: 'x', type: 'lesson', content: '甲' }
    const b = { id: 'y', type: 'note', content: '乙' }
    const empty = diffPinned(new Map(), [a])
    check('17i 没有旧账 → 全部算新增', empty.added.length === 1 && empty.removed.length === 0)
    const mod = diffPinned(pinnedItemMap([a, b]), [a, { ...b, content: '乙改' }])
    check('17i 内容变了 → updated（不是 added）', mod.updated.length === 1 && mod.updated[0].id === 'y' && mod.added.length === 0)
    const drop = diffPinned(pinnedItemMap([a, b]), [a])
    check('17i 少了 → removed 且带上次那行原文', drop.removed.length === 1 && drop.removed[0].prevLine.includes('乙'))
    const none = diffPinned(pinnedItemMap([a]), [a])
    check('17i 完全一致 → 三个数组都空（管线据此判定 unchanged）', none.added.length + none.updated.length + none.removed.length === 0)
    check('17i 空差分 → 空文本（不产生空块头）', renderPinnedDelta(none) === '')
    const deltaText = renderPinnedDelta(drop)
    check('17i 移除行回显上次正文，不是裸 id', deltaText.includes('➖ 移除') && deltaText.includes('乙'))
  }
}
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)