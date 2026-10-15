/**
 * 会话级常驻注入 · 取证脚本（v0.18.0）
 *
 * 用途：拿**真库副本** + **真配置**（Config schema 默认值）+ **真注入管线**（attachInjectPipeline）
 * 跑一串连续步，把每一步注入块里**常驻段**的原文逐字打出来，供人工对照需求《常驻记忆改会话级注入》
 * 的七条验收标准。
 *
 * 为什么这样取证而不是另开一个真实会话：改代码后需要重启 DSH 实例才生效，而重启会掐断取证会话本身。
 * 本脚本走的是与线上**同一套**装配路径（同一份 buildPinned / resolvePinned / renderPinned /
 * blockHash 去抖 / 步距节流），差别只在于驱动它的是脚本而不是内核的 agent 循环——因此它证的是
 * 「注入管线在连续步上的行为」，内核侧的事件送达早已由 test-inject-pipeline.mjs 的坐标用例把守。
 * （真实的端到端确认：改完重启实例，在任意新会话里看头两轮的注入块。）
 *
 * 用法：node tools/verify-session-pinned.mjs [真库路径]
 *   真库路径缺省 ~/.dsh/memory.db；脚本只读它、复制到临时目录后操作副本，绝不写回原库。
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, resolveStepInterval } from '../lib/config.js'
import { MemoryStore } from '../lib/store.js'
import { attachInjectPipeline } from '../lib/pipelines/inject.js'

const plain = (c) => (typeof c?.get === 'function' ? c.get() : c)
// Config 解析出来的对象是冻结的（schemastery），要现场改档位就得先摊成可变副本
const BASE_CFG = plain(Config({ injectPace: 'custom', stepInterval: 5 }))
let CFG = { ...BASE_CFG }

const srcDb = process.argv[2] ?? join(homedir(), '.dsh', 'memory.db')
if (!existsSync(srcDb)) {
  console.error(`真库不存在：${srcDb}`)
  process.exit(2)
}
const dir = mkdtempSync(join(tmpdir(), 'dsh-pin-verify-'))
const dbFile = join(dir, 'memory.db')
copyFileSync(srcDb, dbFile)
for (const suffix of ['-wal', '-shm']) {
  if (existsSync(srcDb + suffix)) copyFileSync(srcDb + suffix, dbFile + suffix)
}

const store = new MemoryStore(dbFile, { time: true })
const logs = []
const events = {}
const ctx = { on: (name, cb) => { events[name] = cb } }
attachInjectPipeline(ctx, {
  store,
  getCfg: () => CFG,
  wsRegistry: { list: () => [] },
  logStore: (level, ev, data) => logs.push({ level, ev, ...data }),
  workProjection: { available: false, read: () => null },
})
const handler = events['agent/pre-step']

const agent = { id: 'verify-session-1', session: {} }
let step = 0
/** 只截常驻那一段（块头以「[记忆] 常驻要点」起，到下一个 `[记忆] ` 块头之前）。 */
function pinSegment(text) {
  const i = text.indexOf('[记忆] 常驻要点')
  if (i < 0) return ''
  const j = text.indexOf('\n[记忆] ', i + 1)
  return (j < 0 ? text.slice(i) : text.slice(i, j)).trimEnd()
}
/** 跑一步，打印这一步注入块里的常驻段与日志对账。 */
async function stepOnce(label, text) {
  step += 1
  const messages = text ? [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text' }] }] : []
  messages[0] && (messages[0].content[0].text = text)
  const decision = await handler(
    { messages, agent, turn: 1, step, signal: {} },
    async () => ({ kind: 'enter', messages: [...messages, { type: 'context' }] }),
  )
  const injected = (decision?.messages ?? []).filter((m) => m?.source?.kind === 'plugin:dsh-memory')
  const log = logs.at(-1)
  const seg = injected.map((m) => pinSegment(String(m.content?.[0]?.text ?? ''))).filter(Boolean).join('\n')
  console.log(`\n───── ${label}（step ${step}）─────`)
  console.log(`日志：pinPhase=${log?.pinPhase ?? '(本步无注入日志)'}  trigger=${log?.trigger ?? '-'}` +
    (log?.pinDelta ? `  pinDelta=${JSON.stringify(log.pinDelta)}` : ''))
  console.log(seg ? seg.split('\n').map((l) => `  ${l.slice(0, 150)}`).join('\n') : '  （本步没有常驻段）')
  return { injected: injected.length, seg }
}

const allPins = store.listPinned({ limit: 50 })
console.log(`真库：${srcDb}`)
console.log(`库内钉选记忆 ${store.pinnedCount()} 条，装配窗口 pinnedLimit=${CFG.pinnedLimit} / pinnedMaxTokens=${CFG.pinnedMaxTokens}`)
console.log(`注入档位 pinnedInjection=${CFG.pinnedInjection}，步距 ${resolveStepInterval(CFG)} 步（custom）`)
console.log(`清单（按 rowid = 钉选先后）：${allPins.map((p) => p.id).join(', ')}`)

// 取证只动**装配窗口内**的那一条：窗口外的改动本来就进不了块，拿它比差量等于测了个寂寞
// （这一点上一版脚本就踩了：新钉的记忆落在第 13 位、装配上限 8，于是"pin 了却没增量"）。
const target = allPins[0]
if (!target) {
  console.error('库里没有钉选记忆，本取证无对象')
  process.exit(2)
}
console.log(`取证对象：${target.id}（${target.type}）`)

console.log('\n\n########## 场景一：会话首轮 → 后续步（验收 1 / 2） ##########')
const s1 = await stepOnce('首轮（会话第一次模型请求）', '开场的第一个问题')
for (const q of ['第二个问题', '第三个问题', '第四个问题', '第五个问题']) await stepOnce('后续轮', q)
const s6 = await stepOnce('第六轮（步距 5 到点，清单没变）', '第六个问题')

console.log('\n\n########## 场景二：会话中途 unpin 一条（验收 4） ##########')
store.setPinned(target.id, false)
await stepOnce('unpin 后的下一轮', '随手问一句')

console.log('\n\n########## 场景三：会话中途重新 pin 回来（验收 3） ##########')
store.setPinned(target.id, true)
await stepOnce('pin 后的下一轮', '再问一句')

console.log('\n\n########## 场景四：会话中途修改已钉记忆的内容（验收 5） ##########')
await store.update(target.id, { content: `${String(target.content).slice(0, 120)}【取证：这一版内容被改过】` })
await stepOnce('改内容后的下一轮', '又问一句')

console.log('\n\n########## 场景五：清单稳定后的再一步（增量不刷屏） ##########')
const s5 = await stepOnce('清单稳定后的下一步', '最后一句')

console.log('\n\n########## 场景六：切回 step 档（验收 7，旧行为对照） ##########')
CFG.pinnedInjection = 'step'
const agent2 = { id: 'verify-session-2', session: {} }
const runStep2 = async (text) => {
  step += 1
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }]
  const decision = await handler(
    { messages, agent: agent2, turn: 1, step, signal: {} },
    async () => ({ kind: 'enter', messages: [...messages, { type: 'context' }] }),
  )
  const injected = (decision?.messages ?? []).filter((m) => m?.source?.kind === 'plugin:dsh-memory')
  const seg = injected.map((m) => pinSegment(String(m.content?.[0]?.text ?? ''))).filter(Boolean).join('\n')
  return seg
}
const stepA = await runStep2('甲')
await runStep2('乙')
const stepC = await runStep2('丙')
console.log(`\n───── step 档：首轮 / 后续 ─────`)
console.log(`首轮常驻段：${stepA ? `有（${stepA.split('\n')[0].slice(0, 80)}…）` : '无'}`)
console.log(`步距到那一步常驻段：${stepC ? `有（与首轮同一份整份，逐字相同=${stepA === stepC}）` : '无'}`)

console.log('\n\n########## 汇总 ##########')
const phases = logs.filter((l) => l.ev === 'inject').map((l) => `step${l.step}:${l.pinPhase}`)
console.log(`注入日志 pinPhase 序列：${phases.join(' → ')}`)
console.log(`首轮注入块条数 ${s1.injected}（常驻整份）`)
console.log(`第六轮（清单未变）注入块条数 ${s6.injected}，其中常驻段：${s6.seg ? '有（不合格）' : '无（验收 2 通过）'}`)
console.log(`清单稳定后再一步：${s5.seg ? '仍有常驻段（不合格）' : '无常驻段（增量不刷屏，通过）'}`)

store.close()
rmSync(dir, { recursive: true, force: true })
