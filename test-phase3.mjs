// 阶段三专项：世界线回滚（rollback）+ 时间旅行（5 项）
// 用法: node test-phase3.mjs
import { MemoryStore, tokenize } from './lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-p3-'))
const dbFile = join(dir, 'test.db')
const store = new MemoryStore(dbFile, { time: true, maxVersions: 8 })

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

console.log('== 1. 世界线回滚（time 维度） ==')
const id = await store.add({ layer: 'sm', type: 'preference', scope: 'global', content: 'v1: 用户偏好 SQLite 存储', keywords: [...tokenize('v1 用户偏好 SQLite 存储')] })
await store.update(id, { content: 'v2: 改用 node:sqlite 内置驱动', keywords: [...tokenize('v2 node sqlite 内置驱动')] })
await store.update(id, { content: 'v3: 最终 WAL + STRICT 方案', keywords: [...tokenize('v3 WAL STRICT 方案')] })

const r1 = await store.rollback(id, 1)
check('rollback 返回新 revision 且记录恢复源', r1.revision === 4 && r1.restoredFrom === 1)
check('活跃切片恢复为 v1 内容', store.get(id).content === 'v1: 用户偏好 SQLite 存储')
const vs = store.versions(id, 10)
check('版本链 4 段不断链', vs.length === 4 && vs[0].revision === 4 && vs[3].revision === 1)
check('活跃版本唯一', vs.filter((v) => v.valid_to === null).length === 1)

console.log('== 2. 回滚后检索见恢复内容 ==')
const hits = await store.search('SQLite 存储', { scope: 'global' })
check('检索命中恢复后的 v1 内容', hits.some((h) => h.id === id && h.content.includes('v1')))

console.log('== 3. 二次回滚（世界线不断链，可往复） ==')
const r2 = await store.rollback(id, 3)
check('二次回滚到 v3', r2.revision === 5 && store.get(id).content === 'v3: 最终 WAL + STRICT 方案')

console.log('== 4. 错误处理 ==')
let threw = false
try { await store.rollback(id, 99) } catch (e) { threw = e.message.includes('not found') }
check('不存在的 revision 报错', threw)

console.log('== 5. 8 型边：幂等建图 ==')
const g1 = await store.add({ layer: 'sm', scope: 'global', content: '记忆甲：SQLite 与向量检索', keywords: [...tokenize('sqlite 向量 检索')] })
store.graphLink(g1, ['sqlite', 'vec'])
const nBefore = store.db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c
const eBefore = store.db.prepare('SELECT COUNT(*) AS c FROM edges').get().c
store.graphLink(g1, ['sqlite', 'vec'])   // 重复调用
const nAfter = store.db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c
const eAfter = store.db.prepare('SELECT COUNT(*) AS c FROM edges').get().c
check('graphLink 幂等（节点/边不重复）', nBefore === nAfter && eBefore === eAfter)

console.log('== 6. 8 型边：记忆级 link/unlink ==')
const g2 = await store.add({ layer: 'sm', scope: 'global', content: '记忆乙：LanceDB 的对比', keywords: [...tokenize('lancedb 对比')] })
store.graphLink(g2, ['lance', 'db'])
const created = store.link(g1, g2, 'similarTo', 0.6)
check('link 跨记忆建边（边数>0）', created > 0)
const created2 = store.link(g1, g2, 'similarTo', 0.6)
check('link 幂等（重复连边不叠加）', created2 === created)
const removed = store.unlink(g1, g2, 'similarTo')
check('unlink 断开（valid_to 置位）', removed === created)
const activeSim = store.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE type = 'similarTo' AND valid_to IS NULL").get().c
check('断开后无活跃 similarTo 边（历史保留）', activeSim === 0 && store.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE type = 'similarTo'").get().c > 0)

console.log('== 7. 8 型边：similarTo 权重 / before 时间链 ==')
store.link(g1, g2, 'similarTo', 0.7)
const w = store.db.prepare("SELECT weight FROM edges WHERE type = 'similarTo' AND valid_to IS NULL LIMIT 1").get()
check('similarTo 权重 = 相似度', Math.abs(w.weight - 0.7) < 0.01)
const g3 = await store.add({ layer: 'sm', scope: 'global', content: '记忆丙：sqlite 的进阶实践', keywords: [...tokenize('sqlite vec 实践')] })
store.graphLink(g3, ['sqlite', 'vec'])
const beforeN = store.linkBefore(g3)   // 与 g1 共享 'sqlite'/'vec' 实体 → 时间链
check('before 时间链自动建边', beforeN > 0)
const beforeEdges = store.db.prepare("SELECT from_node, to_node FROM edges WHERE type = 'before' AND valid_to IS NULL").all()
check('before 边存在于同 label 节点间', beforeEdges.length > 0)

console.log('== 8b. 实体过滤（停用词） ==')
const nodesCountBefore = store.db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c
store.graphLink(g3, ['阶段', '进阶', '完成'])   // 全是停用词 → 不建节点
const nodesCountAfter = store.db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c
check('停用词不产生图谱节点', nodesCountBefore === nodesCountAfter)

console.log('== 8. 8 型边：跨类型最短路径 ==')
const nodesG1 = store.nodesOfMemory(g1)
const nodesG2 = store.nodesOfMemory(g2)
store.link(g1, g2, 'partOf', 1)   // 再连一条不同类型边
const p = store.path(nodesG1[0].id, nodesG2[0].id, 4)
check('path 跨类型边可达', p !== null && p.edges.length >= 1)

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
