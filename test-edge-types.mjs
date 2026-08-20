// v0.9.11 专项：图谱「多种联系方式」——mentions 共现边 + before 演化收紧 + beforeAudit 审计清理
// 用法: node test-edge-types.mjs
import { MemoryStore } from './lib/store.js'
import { buildGraphSnapshot } from './lib/graph-snapshot.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-edge-'))
const store = new MemoryStore(join(dir, 't.db'), { time: true })

console.log('== 1. mentions 记忆级边（共享 ≥2 实体） ==')
const m1 = await store.add({ layer: 'sm', scope: 'test', content: '甲：sqlite 与向量检索', keywords: ['sqlite', 'vector'] })
const m2 = await store.add({ layer: 'sm', scope: 'test', content: '乙：sqlite 向量实践', keywords: ['sqlite', 'vector'] })
const m3 = await store.add({ layer: 'sm', scope: 'test', content: '丙：只共享 sqlite 一个词', keywords: ['sqlite'] })
store.graphLink(m1, ['sqlite', 'vector'])
store.graphLink(m2, ['sqlite', 'vector'])
store.graphLink(m3, ['sqlite'])
const snap = buildGraphSnapshot(store)
const men = snap.edges.filter((e) => e.type === 'mentions')
const pair12 = men.find((e) => (e.from === m1 && e.to === m2) || (e.from === m2 && e.to === m1))
check('共享 2 实体 → mentions 边 weight=2', Boolean(pair12 && pair12.weight === 2))
check('只共享 1 实体 → 不产生 mentions', !men.some((e) => e.from === m3 || e.to === m3))

console.log('== 2. before 收紧：真演化（共享 ≥2 稀有实体）仍连 ==')
const e1 = await store.add({ layer: 'sm', scope: 'test', content: '演化甲：alpha 方案演进', keywords: ['alpha', 'beta'] })
const e2 = await store.add({ layer: 'sm', scope: 'test', content: '演化乙：alpha 进阶', keywords: ['alpha', 'beta'] })
store.graphLink(e1, ['alpha', 'beta'])
store.graphLink(e2, ['alpha', 'beta'])
const nReal = store.linkBefore(e2)
check('共享 2 稀有实体 → before 连接', nReal > 0)

console.log('== 3. before 收紧：单共享词 / 泛词 / 跨主题 不连 ==')
// 单共享稀有实体但不同主题 → 不连
const s1 = await store.add({ layer: 'sm', scope: 'test', content: '单共甲', keywords: ['alpha'] })
const s2 = await store.add({ layer: 'sm', scope: 'test', content: '单共乙', keywords: ['alpha'] })
store.graphLink(s1, ['alpha'])
store.graphLink(s2, ['alpha'])
store.db.prepare('UPDATE memories SET theme = ? WHERE id = ?').run('TA', s1)
store.db.prepare('UPDATE memories SET theme = ? WHERE id = ?').run('TB', s2)
check('仅共享 1 稀有实体且主题不同 → 不连', store.linkBefore(s2) === 0)
// 泛词：被 >8 条记忆共享的 label 不承担演化
const gen = []
for (let i = 0; i < 8; i++) {
  const g = await store.add({ layer: 'sm', scope: 'test', content: `泛词记忆 ${i}`, keywords: ['泛词X'] })
  store.graphLink(g, ['泛词X'])
  gen.push(g)
}
const gA = await store.add({ layer: 'sm', scope: 'test', content: '泛词目标', keywords: ['泛词X'] })
store.graphLink(gA, ['泛词X'])
check('label 被 9 条记忆共享（>8）→ 泛词不连', store.linkBefore(gA) === 0)

console.log('== 4. beforeAudit：低质量边可识别（dryRun）+ apply 落库 ==')
const a = await store.add({ layer: 'sm', scope: 'test', content: '审计甲：zz1', keywords: ['zz1'] })
const b = await store.add({ layer: 'sm', scope: 'test', content: '审计乙：zz2', keywords: ['zz2'] })
store.graphLink(a, ['zz1'])
store.graphLink(b, ['zz2'])
store.db.prepare('UPDATE memories SET theme = ? WHERE id = ?').run('TA', a)
store.db.prepare('UPDATE memories SET theme = ? WHERE id = ?').run('TB', b)
store.link(a, b, 'before', 1)   // 手动伪造的"假演化"
const audit0 = store.beforeAudit({ apply: false })
check('dryRun：识别出该假演化边', audit0.removed >= 1 && audit0.removable.some((r) => r.from === a && r.to === b))
check('dryRun：真演化边保留（kept≥1）', audit0.kept >= 1)
const audit1 = store.beforeAudit({ apply: true })
const activeAB = store.db.prepare("SELECT COUNT(*) c FROM memory_links WHERE type='before' AND valid_to IS NULL AND from_memory=? AND to_memory=?").get(a, b).c
check('apply：假演化边已停用（valid_to 置位）', audit1.removed >= 1 && activeAB === 0)
const activeABHist = store.db.prepare("SELECT COUNT(*) c FROM memory_links WHERE type='before' AND from_memory=? AND to_memory=?").get(a, b).c
check('历史保留（valid_to 置位不销毁）', activeABHist === 1)

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
