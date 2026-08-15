/** 阶段二专项测试：向量 KNN + 三路 RRF + k-hop + 路径 + 遗忘曲线 + merge/purge。 */
import { MemoryStore, ruleEmbed, tokenize } from './lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-p2-'))
const dbFile = join(dir, 'p2.db')
const store = new MemoryStore(dbFile, { time: true, maxVersions: 5 })

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

console.log('== 1. 向量启用与 rule embedding ==')
check('vecEnabled', store.vecEnabled === true)
const v1 = ruleEmbed('中文测试文本')
const v2 = ruleEmbed('中文测试文本')
check('确定性（同文同向量）', JSON.stringify([...v1]) === JSON.stringify([...v2]))
check('归一化（模长≈1）', Math.abs(Math.sqrt([...v1].reduce((s, x) => s + x * x, 0)) - 1) < 0.001)

console.log('== 2. 向量写入 + KNN 语义召回 ==')
const idA = store.add({ layer: 'sm', scope: 'global', content: '用户的偏好是使用 SQLite 作为记忆存储', keywords: [...tokenize('用户 偏好 SQLite 存储')] })
const idB = store.add({ layer: 'sm', scope: 'global', content: '用户喜欢在 Windows 上用 Node 开发插件', keywords: [...tokenize('用户 喜欢 Windows Node 插件')] })
// 语义相近查询（用词不同：'数据库' vs 'SQLite'）
const r1 = store.search('数据库存储选择', { scope: 'global', limit: 3 })
check('语义查询命中 SQLite 记忆（向量路）', r1.some((r) => r.id === idA))
const r2 = store.search('windows node 插件开发', { scope: 'global', limit: 3 })
check('语义查询命中 Node 记忆', r2.some((r) => r.id === idB))

console.log('== 3. 图遍历 ==')
store.graphLink(idA, ['SQLite', '存储', '偏好'])
store.graphLink(idB, ['Windows', 'Node', '插件'])
const nodes = store.db.prepare('SELECT id, label FROM nodes').all()
const nodeOf = (label) => nodes.find((n) => n.label === label)?.id
const n1 = nodeOf('SQLite')
check('节点已建', n1 !== undefined)
const hops = store.neighborsK(n1, 2)
check('k-hop 返回邻域', hops.length >= 2)
const memNbrs = store.memoryNeighbors(idA, 2)
check('记忆邻域（从记忆出发）', memNbrs.length >= 2)

console.log('== 4. 路径查询 ==')
const nA = nodeOf('偏好')
const nB = nodeOf('存储')
const p = nA && nB ? store.path(nA, nB, 3) : null
check('最短路径可达', p !== null && p.edges.length >= 1)

console.log('== 5. 遗忘曲线 ==')
store.db.prepare('UPDATE memories SET last_access = last_access - 48*3600*1000 WHERE id = ?').run(idB)
const decayed = store.decayExpired()
check('衰减执行（返回条数）', decayed >= 1)
const b = store.get(idB)
check('strength 已衰减', b.strength < 1)

console.log('== 6. merge + purge ==')
const idC = store.add({ layer: 'sm', scope: 'global', content: '测试合并用记忆 C', keywords: ['测试'] })
const idD = store.add({ layer: 'sm', scope: 'global', content: '测试合并用记忆 D', keywords: ['合并'] })
const merged = store.update(idC, { content: store.get(idC).content + '\n---\n' + store.get(idD).content, keywords: ['测试', '合并'], strengthDelta: 0.3 })
check('merge 更新成功', merged.id === idC)
check('source 删除', store.forget(idD) === true && store.get(idD) === undefined)
const purged = store.purge('global')
check('purge 清空', purged >= 2 && store.stats().memories === 0)

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n阶段二结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
