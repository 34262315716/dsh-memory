// v0.10.1 注入管线专项：修复"AI 回复后记忆块作为独立一步被消费 → 模型多答一轮"
// 用法: node test-inject-pipeline.mjs（需在部署副本或 harness 环境运行，依赖 @deepseek-ai 包）
import { attachInjectPipeline } from './lib/pipelines/inject.js'

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) } }

const CFG = () => ({
  scope: 'test',
  features: { preStepInject: true },
  stepInterval: 2,
  injectMaxTokens: 800,
  injectMinScore: 0.02,
  maxRecentPerAgent: 6,
})

const HITS = [{ id: 'mem-x', content: '测试记忆内容：用户偏好纯白设定图', score: 0.6, layer: 'sm', updated_at: Date.now() }]

/** 组装一个可触发的注入管线实例。 */
function setup({ hits = HITS } = {}) {
  const events = {}
  const logs = []
  const ctx = { on: (name, cb) => { events[name] = cb } }
  attachInjectPipeline(ctx, {
    store: { search: async () => (typeof hits === 'function' ? hits() : hits) },
    getCfg: CFG,
    wsRegistry: { list: () => [] },
    logStore: (level, ev, data) => logs.push(data),
  })
  const handler = events['agent/pre-step']
  const call = async (text, next, opts = {}) => {
    const messages = opts.messages ?? (text ? [userMsg(text)] : [])
    const agent = opts.agent ?? { id: 'agent-1', session: { events: [] } }
    return handler({ messages, agent, turn: 1, step: 1, signal: {} }, next)
  }
  return { call, logs }
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

console.log('== 2. 签名去抖：同 query 重复 pre-step 不注入 ==')
{
  const { call } = setup()
  const fallback = async () => ({ kind: 'enter', messages: [userMsg('同一个问题'), { type: 'context' }] })
  const d1 = await call('同一个问题', fallback)
  const d2 = await call('同一个问题', fallback)
  check('首次注入', d1.messages.length === 3)
  check('重复同 query 原样放行（无记忆块）', d2.messages.length === 2)
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

console.log('== 6. 日志仍记录注入事件（查询/命中/分数/scope） ==')
{
  const { call, logs } = setup()
  await call('日志验证问题', async () => ({ kind: 'enter', messages: [userMsg('日志验证问题'), { type: 'context' }] }))
  check('注入日志已记录 query/ids', logs.length === 1 && logs[0].query.includes('日志验证问题') && logs[0].ids?.[0] === 'mem-x')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)