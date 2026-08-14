import { MemoryStore, tokenize, jaccard } from './lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
const dbFile = join(dir, 'test.db')
const store = new MemoryStore(dbFile, { time: true, maxVersions: 3 })

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

console.log('== 1. 写入与读取 ==')
const id1 = store.add({ layer: 'sm', type: 'preference', scope: 'global', content: '用户偏好使用 SQLite 存储记忆', keywords: [...tokenize('用户偏好使用 SQLite 存储记忆')] })
const id2 = store.add({ layer: 'ep', scope: 'global', content: '今天修复了 FTS5 trigram 中文检索问题', keywords: [...tokenize('今天修复了 FTS5 trigram 中文检索问题')] })
check('add 返回 id', id1.startsWith('mem-'))
check('get 读取', store.get(id1)?.content.includes('SQLite'))

console.log('== 2. 中文检索（三路） ==')
const r1 = store.search('SQLite 存储', { scope: 'global' })
check('FTS 英文词命中', r1.some((r) => r.id === id1))
const r2 = store.search('中文检索', { scope: 'global' })
check('2 字中文子串兜底命中', r2.some((r) => r.id === id2))

console.log('== 3. 版本化（世界线） ==')
const u1 = store.update(id1, { content: '用户偏好使用 SQLite 存储记忆（更新版：改用 node:sqlite）', keywords: [...tokenize('用户偏好使用 SQLite 存储记忆 node:sqlite')] })
check('第一次更新 revision=2', u1.revision === 2)
const u2 = store.update(id1, { content: '用户偏好使用 SQLite 存储记忆（最终版：WAL+STRICT）', keywords: [...tokenize('用户偏好使用 SQLite 存储记忆 WAL STRICT')] })
check('第二次更新 revision=3', u2.revision === 3)
const v = store.versions(id1, 10)
check('版本链 3 段', v.length === 3 && v[0].revision === 3 && v[2].revision === 1)
check('旧版本 valid_to 非空（隐藏）', v[1].valid_to !== null && v[2].valid_to !== null)
check('活跃版本唯一', v.filter((x) => x.valid_to === null).length === 1)
check('检索只见最新版内容', store.get(id1).content.includes('最终版'))

console.log('== 4. 去重合并（Jaccard） ==')
const sim = jaccard(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b', 'c', 'e']))
check('Jaccard 计算', Math.abs(sim - 0.6) < 0.01)

console.log('== 5. 图谱骨架 ==')
store.graphLink(id2, ['FTS5', '中文', '检索'])
const nid = store.neighbors.length > 0 ? undefined : undefined
const nodes = store.db.prepare('SELECT * FROM nodes').all()
const edges = store.db.prepare('SELECT * FROM edges').all()
check('节点已建', nodes.length >= 3)
check('mentions 边已建', edges.length >= 3)

console.log('== 6. 统计与删除 ==')
const st = store.stats()
check('统计有记忆', st.memories >= 2 && st.versions >= 4 && st.nodes >= 3)
check('forget 删除', store.forget(id2) === true && store.get(id2) === undefined)

console.log('== 7. 检索排除已删记忆 ==')
const r3 = store.search('FTS5', { scope: 'global' })
check('已删记忆不再命中', !r3.some((r) => r.id === id2))

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
