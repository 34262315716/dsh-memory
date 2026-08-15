// 阶段二专项回归：向量 / 图遍历 / 遗忘 / merge-purge / 社区（18 项）
// 用法: node test-phase2.mjs
import { MemoryStore, ruleEmbed, VEC_DIM, tokenize } from './lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-p2-'))
const dbFile = join(dir, 'test.db')
const store = new MemoryStore(dbFile, { time: true, maxVersions: 3 })

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}
function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // ruleEmbed 输出已归一化，点积即余弦
}

console.log('== 1. 向量（rule embedding + vec0） ==')
check('sqlite-vec 扩展已启用', store.stats().vector === true)
const e1 = ruleEmbed('SQLite 存储记忆')
const e2 = ruleEmbed('SQLite 保存记录')
const e3 = ruleEmbed('今天天气很好')
check('ruleEmbed 输出 256 维', e1.length === VEC_DIM && e2.length === VEC_DIM)
check('ruleEmbed 确定性（同输入同输出）',
  JSON.stringify(ruleEmbed('SQLite')) === JSON.stringify(ruleEmbed('SQLite')))
check('近似文本余弦 > 无关文本余弦', cosine(e1, e2) > cosine(e1, e3))
const vid = await store.add({ layer: 'sm', type: 'note', scope: 'global', content: '数据库使用 SQLite 存储，启用 WAL 模式', keywords: [...tokenize('数据库使用 SQLite 存储，启用 WAL 模式')] })
const vhits = await store.search('SQLite 数据库', { scope: 'global' })
check('三路 RRF 检索返回 score', vhits.length > 0 && vhits.every((h) => typeof h.score === 'number'))

console.log('== 2. 图遍历（k-hop / BFS / 记忆邻域） ==')
const gid = await store.add({ layer: 'sm', scope: 'global', content: '图谱测试 A：sqlite/fts/vec 三件套', keywords: [...tokenize('图谱测试 sqlite fts vec')] })
store.graphLink(gid, ['sqlite', 'fts', 'vec'])
const nodesA = store.db.prepare('SELECT id FROM nodes WHERE memory_id = ?').all(gid)
check('neighbors 直接邻域（全连接图）', store.neighbors(nodesA[0].id).length >= 2)
const k2 = store.neighborsK(nodesA[0].id, 2)
check('neighborsK k-hop 扩散（带深度）', k2.length >= 2 && k2.every((x) => x.depth >= 1))
const p = store.path(nodesA[0].id, nodesA[2].id, 6)
check('path BFS 最短路径', p !== null && p.nodes[0] === nodesA[0].id && p.nodes[p.nodes.length - 1] === nodesA[2].id)
// 跨记忆连边（手动 link，模拟 8 型边预留的 link 能力）
const gid2 = await store.add({ layer: 'sm', scope: 'global', content: '图谱测试 B：lancedb 相关', keywords: [...tokenize('图谱测试 lancedb')] })
store.graphLink(gid2, ['lance', 'db'])
const nodesB = store.db.prepare('SELECT id FROM nodes WHERE memory_id = ?').all(gid2)
store.db.prepare('INSERT INTO edges (id, type, from_node, to_node, valid_from, valid_to, weight) VALUES (?, ?, ?, ?, ?, NULL, 1)').run('e-manual', 'mentions', nodesA[0].id, nodesB[0].id, Date.now())
const mn = store.memoryNeighbors(gid, 2)
check('memoryNeighbors 跨记忆邻域扩散', mn.some((x) => x.label === 'lance' || x.label === 'db'))

console.log('== 3. 遗忘曲线（惰性衰减） ==')
const f1 = await store.add({ layer: 'sm', scope: 'global', content: '三天没访问的记忆', keywords: [] })
const f2 = await store.add({ layer: 'sm', scope: 'global', content: '一百天没访问的记忆', keywords: [] })
const f3 = await store.add({ layer: 'sm', scope: 'global', content: '一小时前刚访问的记忆', keywords: [] })
const now = Date.now()
store.db.prepare('UPDATE memories SET last_access = ? WHERE id = ?').run(now - 3 * 86400e3, f1)
store.db.prepare('UPDATE memories SET last_access = ? WHERE id = ?').run(now - 100 * 86400e3, f2)
store.db.prepare('UPDATE memories SET last_access = ? WHERE id = ?').run(now - 3600e3, f3)
const decayed = store.decayExpired(now, 0.15)
check('3 天未访问按指数衰减（≈0.64）', decayed >= 2 && store.get(f1).strength > 0.5 && store.get(f1).strength < 0.8)
check('衰减下限 0.1（100 天）', store.get(f2).strength === 0.1)
check('1 小时内访问不衰减', store.get(f3).strength === 1)

console.log('== 4. merge / purge ==')
const mt = await store.add({ layer: 'sm', scope: 'global', content: '偏好 SQLite 存储', keywords: [...tokenize('偏好 SQLite 存储')] })
const ms = await store.add({ layer: 'sm', scope: 'global', content: 'LanceDB 也用过，效果不错', keywords: [...tokenize('LanceDB 也用过')] })
// 复现 memory_merge 工具逻辑（get → update 合并 → forget source）
const ma = store.get(mt), mb = store.get(ms)
const merged = `${ma.content}\n---\n${mb.content}`
const res = await store.update(mt, { content: merged, keywords: [...new Set([...ma.keywords, ...mb.keywords])].slice(0, 60), strengthDelta: 0.3 })
check('merge 合并内容且 revision 递增', res.revision === 2 && store.get(mt).content.includes('LanceDB'))
check('merge 后 source 被删除', store.forget(ms) === true && store.get(ms) === undefined)
const p1 = await store.add({ layer: 'sm', scope: 'proj-a', content: '项目 A 的记忆', keywords: [] })
const p2 = await store.add({ layer: 'sm', scope: 'proj-b', content: '项目 B 的记忆', keywords: [] })
check('purge 只清指定 scope', store.purge('proj-a') === 1 && store.get(p1) === undefined && store.get(p2) !== undefined)

console.log('== 5. 社区检测（label propagation） ==')
const comms = store.detectCommunities(15)
check('detectCommunities 成簇（成员 ≥3）', comms.length >= 1 && comms[0].members.length >= 3)
const clist = store.communities()
check('communities() 列出成员', clist.length >= 1 && Array.isArray(clist[0].members) && clist[0].members.length >= 3)

console.log('== 6. purge 全清 ==')
const removed = store.purge(undefined)
check('purge 全清（库空）', removed >= 1 && store.list({}).length === 0)

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
