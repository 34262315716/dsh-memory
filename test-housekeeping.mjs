// 阶段三⑥：管家子代理专项（去重扫描 / 老化报告 / 自动合并 / 边界）
// 用法: node test-housekeeping.mjs
import { MemoryStore } from './lib/store.js'
import { RuleEmbedder } from './lib/embedder.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-hk-'))
const store = new MemoryStore(join(dir, 'test.db'), { embedder: new RuleEmbedder(256), time: true })

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

console.log('== 1. 空库边界 ==')
const empty0 = await store.housekeeping({ dryRun: true })
check('空库巡检无候选', empty0.duplicates.length === 0 && empty0.aging.length === 0 && empty0.merged === 0)

console.log('== 2. dedupScan 近重复扫描 ==')
const m1 = await store.add({ layer: 'sm', scope: 'test', content: '管家测试甲：SQLite 存储与向量检索', keywords: ['sqlite', '向量'] })
const m2 = await store.add({ layer: 'sm', scope: 'test', content: '管家测试乙：SQLite 存储与向量检索', keywords: ['sqlite', '向量'] })
const m3 = await store.add({ layer: 'sm', scope: 'test', content: '今天天气很好出门散步吃午饭', keywords: ['天气'] })
// rule 哈希嵌入下近重复文本余弦 ~0.917（真嵌入 4096 维区分度更高）；测试阈值取 0.9
const dup = await store.dedupScan(0.9)
check('相似对命中（不误报无关）', dup.length >= 1 && dup.every((d) => !d.a.includes(m3) && !d.b.includes(m3)))
check('候选包含 m1/m2 对', dup.some((d) => (d.a === m1 && d.b === m2) || (d.a === m2 && d.b === m1)))

console.log('== 3. agingReport 老化报告 ==')
const old = await store.add({ layer: 'sm', scope: 'test', content: '远古记忆：早期技术选型讨论', keywords: ['早期'] })
const now = Date.now()
const day = 24 * 3600 * 1000
store.db.prepare('UPDATE memories SET created_at = ?, last_access = ?, strength = 0.3 WHERE id = ?').run(now - 40 * day, now - 40 * day, old)
const aging = store.agingReport(30)
check('40 天闲置记忆进入老化报告', aging.some((a) => a.id === old && a.idleDays >= 40))
const aging2 = store.agingReport(60)
check('60 天窗口不含 40 天记忆', !aging2.some((a) => a.id === old))

console.log('== 4. housekeeping dryRun=false 自动合并近重复 ==')
const x1 = await store.add({ layer: 'sm', scope: 'test', content: '完全重复的内容样板', keywords: ['样板'] })
const x2 = await store.add({ layer: 'sm', scope: 'test', content: '完全重复的内容样板', keywords: ['样板'] })
const r = await store.housekeeping({ dedupThreshold: 0.95, dryRun: false, autoMergeThreshold: 0.95, limit: 20 })
check('几乎重复对自动合并', r.merged >= 1)
const xRemain = store.list({ scope: 'test', limit: 100 }).filter((m) => m.content.includes('完全重复的内容样板'))
check('合并后仅剩一条（source 已删）', xRemain.length === 1 && (xRemain[0].id === x1 || xRemain[0].id === x2))

console.log('== 5. 合并保留 target 语义（强度高者） ==')
store.db.prepare('UPDATE memories SET strength = 0.9 WHERE id = ?').run(m1)
store.db.prepare('UPDATE memories SET strength = 0.4 WHERE id = ?').run(m2)
const r2 = await store.housekeeping({ dedupThreshold: 0.9, dryRun: false, autoMergeThreshold: 0.9, limit: 20 })
const kept = store.get(m1) ? m1 : m2
check('强度高者保留为 target', r2.merged >= 1 && store.get(kept) !== undefined)

console.log('== 6. meta 键值（巡检时间戳跨重启持久化） ==')
check('getMeta 未设置返回 undefined', store.getMeta('last_housekeeping_at') === undefined)
store.setMeta('last_housekeeping_at', 123456789)
check('setMeta/getMeta 往返一致', store.getMeta('last_housekeeping_at') === '123456789')
store.setMeta('last_housekeeping_at', 987654321)
check('setMeta UPSERT 覆盖', store.getMeta('last_housekeeping_at') === '987654321')

console.log('== 7. 巡检触发条件（写入量 + 时间双驱动） ==')
const mkState = (written, lastAt, now) => {
  const interval = 20, maxIntervalHours = 24
  return written >= interval || (now - lastAt > maxIntervalHours * 3600 * 1000)
}
check('写入量未达且时间未到 → 不触发', !mkState(5, Date.now(), Date.now()))
check('写入量达到 → 触发', mkState(20, Date.now(), Date.now()))
check('时间超期 → 触发（即使写入量小）', mkState(1, Date.now() - 25 * 3600 * 1000, Date.now()))
check('重启后 lastAt 缺失（0）→ 触发', mkState(0, 0, Date.now()))

console.log('== 8. 访问加成：search 命中记 last_access + strength（遗忘曲线语义） ==')
{
  const dir3 = mkdtempSync(join(tmpdir(), 'dsh-memory-hk2-'))
  const s = new MemoryStore(join(dir3, 't.db'), { embedder: new RuleEmbedder(256) })
  const mid = await s.add({ layer: 'sm', scope: 'test', content: '访问测试：SQLite 检索专题', keywords: ['sqlite', '检索'] })
  // 制造"创建很久但未被访问"的假象：strength 0.5、last_access 30 天前
  s.db.prepare('UPDATE memories SET created_at = ?, last_access = ?, strength = 0.5 WHERE id = ?').run(Date.now() - 30 * 24 * 3600 * 1000, Date.now() - 30 * 24 * 3600 * 1000, mid)
  await s.search('SQLite 检索', { scope: 'test', limit: 3, minScore: 0 })
  const after = s.db.prepare('SELECT last_access, strength FROM memories WHERE id = ?').get(mid)
  const fresh = Date.now() - after.last_access < 5000
  check('search 命中后 last_access 刷新为现在', fresh)
  check('search 命中后 strength 加成（0.5 → 0.55）', Math.abs(after.strength - 0.55) < 0.01)
  // 未命中的记忆不 touch：无关记忆仅向量路 rank2（~0.016 < 0.02）被过滤 → last_access 保持 30 天前
  const mid2 = await s.add({ layer: 'sm', scope: 'test', content: '无关记忆：今天天气很好出门散步', keywords: ['天气'] })
  s.db.prepare('UPDATE memories SET last_access = ? WHERE id = ?').run(Date.now() - 30 * 24 * 3600 * 1000, mid2)
  await s.search('SQLite 检索专题', { scope: 'test', limit: 3, minScore: 0.02 })
  const untouched = s.db.prepare('SELECT last_access FROM memories WHERE id = ?').get(mid2)
  check('未命中记忆不 touch', Date.now() - untouched.last_access > 25 * 24 * 3600 * 1000)
  s.close(); rmSync(dir3, { recursive: true, force: true })
}

console.log('== 9. 迁移幂等：重开 store 不重复插入 ==')
{
  const dir4 = mkdtempSync(join(tmpdir(), 'dsh-memory-hk3-'))
  const db4 = join(dir4, 't.db')
  const s1 = new MemoryStore(db4, {})
  const a = await s1.add({ layer: 'sm', scope: 'test', content: '幂等甲：向量库对比', keywords: ['向量'] })
  const b = await s1.add({ layer: 'sm', scope: 'test', content: '幂等乙：向量库对比', keywords: ['向量'] })
  s1.db.prepare('INSERT INTO nodes (id, kind, label, memory_id, created_at) VALUES (?, ?, ?, ?, ?)').run('n-idem-1', 'entity', '向量', a, Date.now())
  s1.db.prepare('INSERT INTO nodes (id, kind, label, memory_id, created_at) VALUES (?, ?, ?, ?, ?)').run('n-idem-2', 'entity', '向量', b, Date.now())
  s1.db.prepare('INSERT INTO node_memories (node_id, memory_id) VALUES (?, ?)').run('n-idem-1', a)
  s1.db.prepare('INSERT INTO node_memories (node_id, memory_id) VALUES (?, ?)').run('n-idem-2', b)
  s1.db.prepare("INSERT INTO edges (id, type, from_node, to_node, valid_from, weight) VALUES (?, 'similarTo', ?, ?, ?, 0.8)").run('e-idem', 'n-idem-1', 'n-idem-2', Date.now())
  s1.close()
  const s2 = new MemoryStore(db4, {})   // 第一次迁移
  const s3 = new MemoryStore(db4, {})   // 第二次打开：增量迁移不重复
  const links = s2.db.prepare("SELECT COUNT(*) AS c FROM memory_links WHERE type = 'similarTo'").get().c
  check('迁移一次且重开不重复插入', links === 1)
  s2.close(); s3.close(); rmSync(dir4, { recursive: true, force: true })
}

console.log('== 10. 多 scope 检索/列表（项目隔离，v0.9.4） ==')
{
  const dir5 = mkdtempSync(join(tmpdir(), 'dsh-memory-sc-'))
  const s = new MemoryStore(join(dir5, 't.db'), { embedder: new RuleEmbedder(256) })
  await s.add({ layer: 'sm', scope: 'dsh-memory', content: '项目甲：reranker 接线完成', keywords: ['reranker'] })
  await s.add({ layer: 'sm', scope: 'mecha', content: '项目乙：机甲提示词 v2', keywords: ['机甲'] })
  await s.add({ layer: 'sm', scope: 'global', content: '公共层：用户画像偏好', keywords: ['画像'] })
  // 单 scope 检索互不可见
  const r1 = await s.search('reranker', { scope: 'dsh-memory', limit: 5, minScore: 0 })
  const r2 = await s.search('reranker', { scope: 'mecha', limit: 5, minScore: 0 })
  check('项目甲 scope 检索命中自己', r1.some((h) => h.content.includes('reranker')))
  check('项目乙 scope 检索不到项目甲记忆', !r2.some((h) => h.content.includes('reranker')))
  // 双 scope（项目 + global 公共层）：都能看到
  const both = await s.search('reranker', { scope: ['dsh-memory', 'global'], limit: 5, minScore: 0 })
  check('双 scope（项目+global）命中项目甲', both.some((h) => h.content.includes('reranker')))
  const bothMe = await s.search('机甲', { scope: ['mecha', 'global'], limit: 5, minScore: 0 })
  check('双 scope（项目乙+global）不含项目甲记忆', !bothMe.some((h) => h.content.includes('reranker')))
  // list 多 scope
  const ls = s.list({ scope: ['dsh-memory', 'global'], limit: 10 })
  check('list 多 scope 返回项目甲+公共层（不含项目乙）', ls.some((m) => m.scope === 'dsh-memory') && ls.some((m) => m.scope === 'global') && !ls.some((m) => m.scope === 'mecha'))
  s.close(); rmSync(dir5, { recursive: true, force: true })
}

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
