// 阶段四（v0.9.0）：事件分类专项——时间线扫描 / 同主题合并 / 共享实体合并 / 孤立记忆 / label / 幂等 / 级联
// 用法: node test-events.mjs
import { MemoryStore } from './lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-ev-'))
const store = new MemoryStore(join(dir, 'test.db'), { time: true })

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

const HOUR = 3600 * 1000
const base = Date.now() - 24 * HOUR

console.log('== 1. 时间线扫描：组内聚合、组间切分 ==')
// A 组：t+0/t+0.5h，同 theme T1 + 共享实体 sqlite
const a1 = await store.add({ layer: 'sm', scope: 'test', content: '事件甲一：SQLite 存储设计', keywords: ['sqlite'] })
const a2 = await store.add({ layer: 'sm', scope: 'test', content: '事件甲二：SQLite 检索调优', keywords: ['sqlite'] })
store.db.prepare('UPDATE memories SET created_at = ?, theme = ? WHERE id = ?').run(base, 'T1', a1)
store.db.prepare('UPDATE memories SET created_at = ?, theme = ? WHERE id = ?').run(base + 0.5 * HOUR, 'T1', a2)
// B 组：t+3h/t+3.5h，同 theme T2（时间上与 A 相隔 >2h 切分）
const b1 = await store.add({ layer: 'sm', scope: 'test', content: '事件乙一：向量检索方案', keywords: ['vector'] })
const b2 = await store.add({ layer: 'sm', scope: 'test', content: '事件乙二：向量维度调优', keywords: ['vector'] })
store.db.prepare('UPDATE memories SET created_at = ?, theme = ? WHERE id = ?').run(base + 3 * HOUR, 'T2', b1)
store.db.prepare('UPDATE memories SET created_at = ?, theme = ? WHERE id = ?').run(base + 3.5 * HOUR, 'T2', b2)
// C 组：t+6h/t+6.2h，theme 空但共享实体（node_memories）→ 靠实体归并
const c1 = await store.add({ layer: 'sm', scope: 'test', content: '事件丙一：实体映射重构', keywords: ['sqlite'] })
const c2 = await store.add({ layer: 'sm', scope: 'test', content: '事件丙二：实体映射验证', keywords: ['sqlite'] })
store.graphLink(c1, ['sqlite', 'refactor'])
store.graphLink(c2, ['sqlite', 'refactor'])
store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(base + 6 * HOUR, c1)
store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(base + 6.2 * HOUR, c2)
// D：孤立记忆（距 C 组 >2h）
const d1 = await store.add({ layer: 'sm', scope: 'test', content: '孤立记忆：独立事件', keywords: ['alone'] })
store.db.prepare('UPDATE memories SET created_at = ?, theme = ? WHERE id = ?').run(base + 9 * HOUR, 'T3', d1)

const evs = store.detectEvents(2 * HOUR)
check('检测到 4 个事件（A/B/C/D 组）', evs.length === 4)
const byFirst = new Map(evs.map((e) => [e.label, e]))
check('A 组聚合（2 成员）', evs.find((e) => e.label === 'T1')?.count === 2)
check('B 组聚合（2 成员）', evs.find((e) => e.label === 'T2')?.count === 2)
check('C 组靠共享实体归并（2 成员，label=type 兜底）', evs.some((e) => e.count === 2 && e.label === 'note'))
check('D 孤立记忆独立事件（1 成员）', evs.find((e) => e.label === 'T3')?.count === 1)
const t1ev = evs.find((e) => e.label === 'T1')
check('事件 start/end 为首末成员时间', t1ev.startAt === base && t1ev.endAt === base + 0.5 * HOUR)

console.log('== 2. 幂等与稳定性 ==')
const evs2 = store.detectEvents(2 * HOUR)
check('重复检测事件数不变', evs2.length === evs.length)
check('事件 id 稳定（重建一致）', JSON.stringify(evs2.map((e) => e.id)) === JSON.stringify(evs.map((e) => e.id)))

console.log('== 3. events() 列表与 eventMap ==')
const list = store.events(20)
check('events() 返回 4 个事件（含成员）', list.length === 4 && list.every((e) => e.count === e.members.length && e.members.length >= 1))
const map = store.eventMap()
check('eventMap：记忆 → 事件映射完整', map.get(a1) === `ev-${a1}` && map.get(b2) !== map.get(a1) && map.get(c1) === map.get(c2))

console.log('== 4. 事件变化响应（记忆删除 → 重检测） ==')
store.forget(a2)
const evs3 = store.detectEvents(2 * HOUR)
check('删除成员后重检测：A 组收缩为 1 成员事件', evs3.find((e) => e.label === 'T1')?.count === 1)
check('event_members 级联清理（无 a2 残留）', store.db.prepare('SELECT COUNT(*) AS c FROM event_members WHERE memory_id = ?').get(a2).c === 0)

console.log('== 5. gap 阈值影响 ==')
// B 组内间隔 0.5h：gap 收紧到 0.3h → 组内切分（事件数 +1）
const evs4 = store.detectEvents(0.3 * HOUR)
check('gap 收紧（0.3h）→ B 组内切分（事件数 +1）', evs4.length === evs3.length + 1)

console.log('== 6. 空库边界 ==')
store.db.exec('DELETE FROM memories')
const evs5 = store.detectEvents(2 * HOUR)
check('空库检测返回空', evs5.length === 0 && store.events(5).length === 0)

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
