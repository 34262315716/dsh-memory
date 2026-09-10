import { MemoryStore, tokenize, jaccard } from './lib/store.js'
import { extractWithLlm } from './lib/refiner.js'
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

  // P1-2 复现：records 段内的顶格注释行不得提前关闭段状态机（否则 secret 等字段泄漏进键匹配）
  const commented = join(cdir, 'commented.yaml')
  writeFileSync(commented, [
    'version: 1',
    'refs:',
    '  MEMORY_EMBEDDING_API_KEY: sk-embed',
    'records:',
    '  # 顶格注释（评审发现的真实风险形态）',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      secret: uBy-not-a-key',
    '  # another comment',
    '  other-record:',
    '    secret: sk-other-secret',
    '',
  ].join('\n'), 'utf8')
  check('records 内顶格注释行不关闭段（secret 仍不匹配）', readCredential('secret', commented) === undefined)
  check('refs 段键读取不受注释影响', readCredential('MEMORY_EMBEDDING_API_KEY', commented) === 'sk-embed')
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

console.log('== 10. v0.10 abstraction：列迁移 + 白名单 + 注入加权（principle 优先/event 降权） ==')
{
  const adir = mkdtempSync(join(tmpdir(), 'dsh-abs-'))
  const s = new MemoryStore(join(adir, 't.db'), {})
  // 白名单：越界 abstract 回落空串，合法值落库
  const badId = await s.add({ layer: 'sm', type: 'note', scope: 'test', content: '越界抽象测试内容', keywords: ['越界'], abstract: 'nonsense' })
  const pId = await s.add({ layer: 'sm', type: 'lesson', scope: 'test', content: '原则甲：注入阈值必须与量纲对齐，否则旋钮失灵', keywords: ['阈值'], abstract: 'principle', theme: 'dsh-memory 开发' })
  const eId = await s.add({ layer: 'sm', type: 'decision', scope: 'test', content: '事件乙：昨天修复了蓝牙驱动回退问题', keywords: ['蓝牙'], abstract: 'event', theme: '硬件排障' })
  check('越界 abstract 回落空串', s.get(badId).abstract === '')
  check('principle/event 合法落库', s.get(pId).abstract === 'principle' && s.get(eId).abstract === 'event')
  check('theme 一并落库', s.get(pId).theme === 'dsh-memory 开发' && s.get(eId).theme === '硬件排障')
  // 老库迁移幂等：无 abstract 列的库重开 → 自动补列且不重复
  const raw = s.db.prepare('PRAGMA table_info(memories)').all()
  check('abstract 列存在', raw.some((c) => c.name === 'abstract'))
  s.close()
  const s2 = new MemoryStore(join(adir, 't.db'), {})
  const raw2 = s2.db.prepare('PRAGMA table_info(memories)').all()
  check('重开不重复加列（列唯一）', raw2.filter((c) => c.name === 'abstract').length === 1)
  // 注入加权：同分场景 principle 抬升、event 压低
  const q = '阈值'
  const boostAll = await s2.search(q, { scope: 'test', limit: 5, minScore: 0, boost: { principle: 1.5, event: 0.7 } })
  const pB = boostAll.find((h) => h.id === pId)
  const eB = boostAll.find((h) => h.id === eId)
  const rawPS = (await s2.search(q, { scope: 'test', limit: 5, minScore: 0 })).find((h) => h.id === pId)?.score ?? 0
  const rawES = (await s2.search(q, { scope: 'test', limit: 5, minScore: 0 })).find((h) => h.id === eId)?.score ?? 0
  check('principle ×1.5（注入路径优先）', Math.abs((pB?.score ?? 0) - rawPS * 1.5) < 0.002)
  check('event ×0.7（强相关才注入）', Math.abs((eB?.score ?? 0) - rawES * 0.7) < 0.002)
  s2.close(); rmSync(adir, { recursive: true, force: true })
}

console.log('== 11. v0.10 蒸馏双输出：abstraction + theme（mock LLM） ==')
{
  const mockCtx = { llm: { stream: async function* () { yield { type: 'text-delta', text: '{"content": "注入阈值必须与量纲对齐", "type": "lesson", "layer": "sm", "keywords": ["阈值"], "aspect": "", "abstract": "principle", "theme": "dsh-memory 开发"}' } } } }
  const cfg = { refiner: { provider: 'mock', model: 'mock', maxTokens: 800 } }
  const out = await extractWithLlm(mockCtx, cfg, 'u', 'a')
  check('蒸馏输出 abstract=principle', out.abstract === 'principle')
  check('蒸馏输出 theme', out.theme === 'dsh-memory 开发')
  // 越界 abstract / 非字符串 theme → 兜底
  const badCtx = { llm: { stream: async function* () { yield { type: 'text-delta', text: '{"content": "x", "type": "note", "layer": "sm", "keywords": [], "aspect": "", "abstract": "weird", "theme": 42}' } } } }
  const bad = await extractWithLlm(badCtx, cfg, 'u', 'a')
  check('越界 abstract 回落空串', bad.abstract === '')
  check('非字符串 theme 回落空串', bad.theme === '')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
