import { MemoryStore, tokenize, jaccard } from './lib/store.js'
import { readCredential } from './lib/util.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
const id1 = await store.add({ layer: 'sm', type: 'preference', scope: 'global', content: '用户偏好使用 SQLite 存储记忆', keywords: [...tokenize('用户偏好使用 SQLite 存储记忆')] })
const id2 = await store.add({ layer: 'ep', scope: 'global', content: '今天修复了 FTS5 trigram 中文检索问题', keywords: [...tokenize('今天修复了 FTS5 trigram 中文检索问题')] })
check('add 返回 id', id1.startsWith('mem-'))
check('get 读取', store.get(id1)?.content.includes('SQLite'))

console.log('== 2. 中文检索（三路） ==')
const r1 = await store.search('SQLite 存储', { scope: 'global' })
check('FTS 英文词命中', r1.some((r) => r.id === id1))
const r2 = await store.search('中文检索', { scope: 'global' })
check('2 字中文子串兜底命中', r2.some((r) => r.id === id2))

console.log('== 3. 版本化（世界线） ==')
const u1 = await store.update(id1, { content: '用户偏好使用 SQLite 存储记忆（更新版：改用 node:sqlite）', keywords: [...tokenize('用户偏好使用 SQLite 存储记忆 node:sqlite')] })
check('第一次更新 revision=2', u1.revision === 2)
const u2 = await store.update(id1, { content: '用户偏好使用 SQLite 存储记忆（最终版：WAL+STRICT）', keywords: [...tokenize('用户偏好使用 SQLite 存储记忆 WAL STRICT')] })
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
const r3 = await store.search('FTS5', { scope: 'global' })
check('已删记忆不再命中', !r3.some((r) => r.id === id2))

store.close()
rmSync(dir, { recursive: true, force: true })
console.log('== 8. 凭据读取兼容两种格式（v0.9.25） ==')
{
  const cdir = mkdtempSync(join(tmpdir(), 'dsh-cred-'))
  const nested = join(cdir, 'nested.yaml')
  writeFileSync(nested, [
    'version: 1',
    'refs:',
    '  OPENCODE_GO_API_KEY: sk-old',
    '  MEMORY_EMBEDDING_API_KEY: sk-embed-new',
    '  MEMORY_RERANK_API_KEY: sk-rerank-new',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      secret: uBy-not-a-key',
    '',
  ].join('\n'), 'utf8')
  check('refs 嵌套格式可读到密钥（修复前恒 undefined）', readCredential('MEMORY_EMBEDDING_API_KEY', nested) === 'sk-embed-new')
  check('refs 嵌套 reranker 键同样命中', readCredential('MEMORY_RERANK_API_KEY', nested) === 'sk-rerank-new')
  check('records 段内不误匹配（值不泄露为密钥）', readCredential('secret', nested) === undefined)
  check('缺失键返回 undefined', readCredential('NOPE_KEY', nested) === undefined)

  const flat = join(cdir, 'flat.yaml')
  writeFileSync(flat, 'MEMORY_EMBEDDING_API_KEY: sk-flat\nEMPTY_KEY:\n', 'utf8')
  check('旧平铺格式仍兼容', readCredential('MEMORY_EMBEDDING_API_KEY', flat) === 'sk-flat')
  check('空值键返回 undefined', readCredential('EMPTY_KEY', flat) === undefined)
  rmSync(cdir, { recursive: true, force: true })
}

console.log('== 9. 类型加权 boost：画像短记忆不再被泛词长记忆碾压（P0.1） ==')
{
  const bdir = mkdtempSync(join(tmpdir(), 'dsh-boost-'))
  const s = new MemoryStore(join(bdir, 't.db'), {})
  // 泛词长记忆（多关键词 + 含查询子串）vs 画像短记忆（单稀有词）
  const noteId = await s.add({ layer: 'sm', type: 'note', scope: 'test', content: '今天把丹道修炼记录与图谱治理方法整理完成，修复了注入链路问题。', keywords: ['丹道', '修炼', '记录', '图谱', '治理'] })
  const profId = await s.add({ layer: 'sm', type: 'profile', scope: 'test', content: '用户修行丹道，近期课题是接纳情绪。', keywords: ['丹道'], aspect: 'habit' })
  const q = '丹道修炼记录'
  const plain = await s.search(q, { scope: 'test', limit: 5, minScore: 0 })
  const plainTop = plain.find((h) => h.id === noteId)?.score ?? 0
  const profPlain = plain.find((h) => h.id === profId)?.score ?? 0
  check('无 boost：长记忆排前（画像弱势基线）', plain[0]?.id === noteId && profPlain < plainTop)
  const boosted = await s.search(q, { scope: 'test', limit: 5, minScore: 0, boost: { profile: 3 } })
  const bTop = boosted.find((h) => h.id === profId)
  const bNote = boosted.find((h) => h.id === noteId)
  check('boost profile×3：画像升至首位', boosted[0]?.id === profId)
  check('画像分数 ×3', Math.abs((bTop?.score ?? 0) - profPlain * 3) < 0.002)
  check('其他类型分数不受影响', Math.abs((bNote?.score ?? 0) - plainTop) < 1e-9)
  const gate = await s.search(q, { scope: 'test', limit: 5, minScore: 0.05 })
  check('无 boost：画像弱命中不达高门槛', !gate.some((h) => h.id === profId))
  const gateB = await s.search(q, { scope: 'test', limit: 5, minScore: 0.05, boost: { profile: 3 } })
  check('boost 后画像过门槛（弱命中也能注入）', gateB.some((h) => h.id === profId))
  const otherBoost = await s.search(q, { scope: 'test', limit: 5, minScore: 0, boost: { lesson: 3 } })
  check('不相关类型 boost 不改变排序', otherBoost[0]?.id === noteId)
  s.close(); rmSync(bdir, { recursive: true, force: true })
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
