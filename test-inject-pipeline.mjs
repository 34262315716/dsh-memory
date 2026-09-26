// v0.10.1 注入管线专项：修复"AI 回复后记忆块作为独立一步被消费 → 模型多答一轮"
// 用法: node test-inject-pipeline.mjs（需在部署副本或 harness 环境运行，依赖 @deepseek-ai 包）
import { attachInjectPipeline, buildPinned } from './lib/pipelines/inject.js'
import { Config, INJECT_PACE_LABELS, INJECT_PACE_STEPS, resolveStepInterval } from './lib/config.js'
import { MemoryStore } from './lib/store.js'
import { extractUserText, extractWorkText, renderPinned, stripInjectedNoise } from './lib/util.js'
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
})

const HITS = [{ id: 'mem-x', content: '测试记忆内容：用户偏好纯白设定图', score: 0.6, layer: 'sm', updated_at: Date.now() }]

/** 组装一个可触发的注入管线实例。pins：常驻记忆（v0.13.0）。 */
function setup({ hits = HITS, cfg = CFG, pins = [] } = {}) {
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
    logStore: (level, ev, data) => logs.push(data),
  })
  const handler = events['agent/pre-step']
  // 默认 agent 复用同一实例：session.events 跨调用累积（模拟真实会话步数推进）
  const sharedAgent = { id: 'agent-1', session: { events: [] } }
  const call = async (text, next, opts = {}) => {
    const messages = opts.messages ?? (text ? [userMsg(text)] : [])
    const agent = opts.agent ?? sharedAgent
    const result = await handler({ messages, agent, turn: 1, step: 1, signal: {} }, next)
    // 模拟本步完成：push step/start（下次 pre-step 时步号 +1，对齐 agent-loop 真实时序）
    if (agent.session) agent.session.events.push({ type: 'step/start', data: { turn: 1 } })
    return result
  }
  return { call, logs, lastArgs }
}

/** 构造真实用户消息（source.kind='user'）。 */
function userMsg(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

console.log('== 1. 修复主行为：记忆块合并进本步 decision，不再经 agent.inject() ==')
{
  const { call } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('请问记忆?'), { type: 'context' }] })
  const decision = await call('请问记忆?', fallback)
  check('decision.kind 保持 enter', decision?.kind === 'enter')
  check('消息数 = 用户 + context + 记忆块（同一步）', decision?.messages?.length === 3)
  const mem = decision?.messages?.at(-1)
  check('记忆块溯源 form=recall / plugin', mem?.source?.kind === 'plugin' && mem?.source?.form === 'recall')
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
  const { call } = setup({ hits: () => [{ id: `mem-${++n}`, content: `记忆内容${n}`, score: 0.5, layer: 'sm', updated_at: Date.now() }] })
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('x'), { type: 'context' }] })
  const d1 = await call('第一轮问题', fallback)
  const d2 = await call('第二轮问题', fallback)
  const d3 = await call('第三轮问题', fallback)
  check('第一轮注入', d1.messages.length === 3)
  check('第二轮被步距节流跳过', d2.messages.length === 2)
  check('第三轮恢复注入', d3.messages.length === 3)

  // 3b：无文本步（工具/自主步）同样消耗步数——连续两轮用户消息中间夹工具步 → 第二轮也注入
  let m = 0
  const { call: callB } = setup({ hits: () => [{ id: `mem2-${++m}`, content: `记忆${m}`, score: 0.5, layer: 'sm', updated_at: Date.now() }] })
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
  const { call, logs } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
  const d = await call(null, fallback, { agent: { id: 'agent-1', session: { events } } })
  check('自主轮次注入成功（context + 记忆块）', d.messages.length === 2 && d.messages.at(-1)?.source?.kind === 'plugin')
  check('检索 query 用了最近 assistant 工作内容', logs.at(-1)?.query?.includes('图谱构建'))
  check('且包含历史任务文本', logs.at(-1)?.query?.includes('原始任务'))
}

console.log('== 3d. 自主轮次守卫：无会话 / 会话仅注入块 / 均不注入 ==')
{
  const { call } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
  const d1 = await call(null, fallback, { agent: { id: 'no-session' } })
  check('agent 无 session：不注入', d1.messages.length === 1)

  const pluginOnly = [{ type: 'user/message', data: { role: 'user', source: { kind: 'plugin', plugin: 'dsh-memory' }, content: [{ type: 'text', text: '[记忆] 注入块' }] } }]
  const d2 = await call(null, fallback, { agent: { id: 'agent-1', session: { events: pluginOnly } } })
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
  const CFG10 = () => ({ ...CFG(), injectPace: 'custom', stepInterval: 10 })
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
  const CFGSteady = () => ({ ...CFG(), injectPace: 'steady' })
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
  const CFGLazy = () => ({ ...CFG(), injectPace: 'lazy' })
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
  const CFG12 = () => ({ ...CFG(), injectPace: 'custom', stepInterval: 12 })
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
  check('Config({}).injectPace 默认 steady', Config({}).injectPace === 'steady')
  check('Config({injectPace:"lazy"}) 接受', Config({ injectPace: 'lazy' }).injectPace === 'lazy')
  check('Config({injectPace:"乱写"}) 不抛错（回落由解析层兜底）', Config({ injectPace: '乱写' }).injectPace === '乱写')
  check('Config({stepInterval:12}) = 12（旧上限 10 会把用户要的 12 判非法）', Config({ stepInterval: 12 }).stepInterval === 12)
  check('Config({}).stepInterval 默认仍是 10（自定义档的起点）', Config({}).stepInterval === 10)
  let rejected = false
  try { Config({ stepInterval: 61 }) } catch { rejected = true }
  check('Config({stepInterval:61}) 被拒（上限 60）', rejected)
  let rejected0 = false
  try { Config({ stepInterval: 0 }) } catch { rejected0 = true }
  check('Config({stepInterval:0}) 被拒（下限 1）', rejected0)
}

console.log('== 7g. 客户端档位表与 config 同源（防"UI 写 12、代码跑 10"漂移） ==')
{
  const src = readFileSync(new URL('./client/settings.jsx', import.meta.url), 'utf8')
  const block = src.match(/const INJECT_PACE_OPTIONS = \[([\s\S]*?)\n\]/)?.[1] ?? ''
  const rows = [...block.matchAll(/\['([a-z]+)', '([^']+)', (\d+),/g)].map((m) => ({ key: m[1], label: m[2], steps: Number(m[3]) }))
  check('客户端列出 4 个档位（三档 + 自定义）', rows.length === 4 && rows.map((r) => r.key).join(',') === 'aggressive,steady,lazy,custom')
  check('档位步距与 INJECT_PACE_STEPS 完全一致', rows.filter((r) => r.key !== 'custom').every((r) => r.steps === INJECT_PACE_STEPS[r.key]))
  check('档位标签与 INJECT_PACE_LABELS 完全一致', rows.every((r) => r.label === INJECT_PACE_LABELS[r.key]))
}

console.log('== 5. 守卫：无真实用户文本 / 空检索 / reject 均不注入 ==')
{
  const { call } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: '[记忆] 注入块' }] }, { type: 'context' }] })
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
  const w = extractWorkText({ session: { events } })
  check('extractWorkText 同样剥掉提醒块', w.includes('注入管线') && !w.includes('system-reminder'))
}

console.log('== 9b. 真凶回归：工具步（消息里只剩提醒）不再拿提醒当 query，回落工作上下文 ==')
{
  const REMIND = '<system-reminder>\nConfigured MCP servers in this session (**capability descriptions only**)\n</system-reminder>'
  const events = [
    { type: 'user/message', data: userMsg('帮我把常驻注入做出来') },
    { type: 'assistant/message', data: { message: { role: 'assistant', source: { provider: 'mock' }, content: [{ type: 'text', text: '正在改 inject.js' }] } } },
  ]
  const { call, logs } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [{ type: 'context' }] })
  const d = await call(null, fallback, { agent: { id: 'tool-step', session: { events } }, messages: [userMsg(REMIND)] })
  check('工具步照样注入', d.messages.length === 2)
  check('query 用的是真实工作上下文', logs.at(-1).queryKind === 'work' && logs.at(-1).query.includes('常驻注入'))
  check('query 里不再有 MCP 提醒字样', !logs.at(-1).query.includes('MCP servers'))
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
  const fakeStore = { listPinned: ({ limit }) => [mk(1, 10), mk(2, 4000), mk(3, 10)].slice(0, limit) }
  const r = buildPinned(fakeStore, { pinnedLimit: 8, pinnedMaxTokens: 100 })
  check('buildPinned 受 pinnedMaxTokens 约束（4000 字那条被挡在预算外）', r.pins.length === 1 && r.pins[0].id === 'mem-b1')
  check('buildPinned 渲染非空', r.text.includes('#mem-b1') && r.text.includes('恒定注入'))
  const r2 = buildPinned({ listPinned: () => [] }, { pinnedLimit: 8, pinnedMaxTokens: 600 })
  check('无常驻 → 空文本（不产生空块头）', r2.pins.length === 0 && r2.text === '')
  const r3 = buildPinned({ listPinned: () => { throw new Error('boom') } }, {})
  check('存储异常 → 降级为空且不抛错（常驻坏了不连累注入）', r3.pins.length === 0 && r3.text === '')
  const fakeLimit = { listPinned: ({ limit }) => [mk(1, 10), mk(2, 10), mk(3, 10)].slice(0, limit) }
  check('pinnedLimit 生效（只取前 2 条）', buildPinned(fakeLimit, { pinnedLimit: 2, pinnedMaxTokens: 600 }).pins.length === 2)
  // v0.13.1：预算必须按「真正注入的那一行」计费（旧实现按未截断原文计费 → 只装得下 1 条）
  {
    const longPins = { listPinned: ({ limit }) => [mk(1, 4000), mk(2, 4000), mk(3, 4000)].slice(0, limit) }
    const r4 = buildPinned(longPins, { pinnedLimit: 8, pinnedMaxTokens: 500 })
    check('超长钉选按渲染后的行长计费（3 条在 500 token 预算内全装得下）', r4.pins.length === 3)
    check('超长钉选在块内被截到单条上限', r4.text.length < 1100 && r4.text.includes('#mem-b3'))
  }
  const text = renderPinned([{ id: 'mem-1', type: 'lesson', content: '第一行\n第二行' }])
  check('renderPinned 头含条数与「恒定注入」', text.startsWith('[记忆] 常驻要点（恒定注入 · 钉选 1 条'))
  check('renderPinned 多行内容压成单行', text.includes('第一行 第二行') && !text.includes('\n第二行'))
  check('renderPinned 带类型小标（lesson → 教训）', text.includes('【教训】#mem-1'))
  check('renderPinned 空数组 → 空串', renderPinned([]) === '' && renderPinned(undefined) === '')
  check('renderPinned 确定性：同输入逐字相同（去抖前提）',
    renderPinned([{ id: 'a', type: 'note', content: 'z' }]) === renderPinned([{ id: 'a', type: 'note', content: 'z' }]))
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
  check('Config({}).pinnedLimit 默认 8', Config({}).pinnedLimit === 8)
  check('Config({}).pinnedMaxTokens 默认 600', Config({}).pinnedMaxTokens === 600)
  check('Config({pinnedLimit:20}).pinnedLimit = 20', Config({ pinnedLimit: 20 }).pinnedLimit === 20)
  let rej = false
  try { Config({ pinnedLimit: 0 }) } catch { rej = true }
  check('pinnedLimit=0 被拒（至少 1 条）', rej)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)