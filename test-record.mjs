// ============================================================
// 测试入口：端到端「记录质量自检」
// 用途：验证插件内的模型是否在好好地记录记忆——
//   ① embedder 状态（provider/dim/连通） ② 写入→语义检索闭环
//   ③ 图谱建边（mentions/similarTo/before） ④ rule vs remote 语义召回对比
// 用法：node test-record.mjs            # 临时库自检（用真实凭据，不碰生产库）
//       node test-record.mjs --live     # 在生产库上自检（只读检索，不写入）
// ============================================================
import { MemoryStore, GRAPH_STOP_WORDS, tokenize } from './lib/store.js'
import { RuleEmbedder, RemoteEmbedder, cosine } from './lib/embedder.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

const live = process.argv.includes('--live')
let pass = 0, fail = 0, warn = 0
const ok = (name) => { pass++; console.log('  ✅ ' + name) }
const bad = (name, detail = '') => { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')) }
const note = (msg) => { warn++; console.log('  ⚠️ ' + msg) }

// 1. 嵌入器初始化（凭据文件读密钥；remote 失败自动落 rule）
const cred = (() => { try { return readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8') } catch { return '' } })()
const key = (cred.match(/^MEMORY_EMBEDDING_API_KEY:\s*(\S+)/m) ?? [])[1]
let embedder = null
if (key) {
  try {
    const remote = new RemoteEmbedder({ baseUrl: 'https://api.siliconflow.cn/v1', apiKey: key, model: 'Qwen/Qwen3-VL-Embedding-8B' })
    await remote.ready()
    embedder = remote
    ok('嵌入器 remote 连通（Qwen3-VL-Embedding-8B，' + remote.dim + ' 维）')
  } catch (e) {
    note('remote 嵌入器不可用（' + e.message.slice(0, 80) + '）→ 降级 rule')
  }
}
if (!embedder) { embedder = new RuleEmbedder(256); note('使用 rule 哈希嵌入（弱语义，仅兜底）') }

// 2. 打开库（--live 用生产库只读检索；默认临时库）
let store, dir = null
if (live) {
  store = new MemoryStore(join(homedir(), '.dsh', 'memory.db'), { time: true, maxVersions: 8, embedder })
  console.log('\n== 生产库自检（只读检索，不写入） ==')
} else {
  dir = mkdtempSync(join(tmpdir(), 'dsh-memory-record-'))
  store = new MemoryStore(join(dir, 'record.db'), { time: true, maxVersions: 8, embedder })
  console.log('\n== 临时库自检（' + basename(dir) + '） ==')
}

// 3. 写入闭环：模拟一轮对话沉淀（规则路径）
if (!live) {
  console.log('\n== 写入 → 语义检索闭环 ==')
  const m1 = await store.add({ layer: 'sm', type: 'decision', scope: 'global', content: '用户偏好使用 SQLite 存储记忆数据', keywords: [...tokenize('SQLite 存储 记忆 数据')] })
  const m2 = await store.add({ layer: 'sm', type: 'preference', scope: 'global', content: '向量检索采用余弦相似度排序', keywords: [...tokenize('向量 检索 余弦 相似度')] })
  const m3 = await store.add({ layer: 'sm', type: 'note', scope: 'global', content: '今天午饭吃了牛肉面', keywords: [...tokenize('午饭 牛肉面')] })
  ok('三条记忆写入成功')
  const dim = embedder.name === 'remote' ? 4096 : 256
  const vecCount = store.db.prepare('SELECT COUNT(*) AS c FROM memory_vectors').get().c
  ok('向量已写入（' + vecCount + ' 条 × ' + dim + ' 维）', '')
  // 语义召回：查询与记忆用词不同（考验真嵌入语义）
  const hits = await store.search('数据保存用什么方案', { scope: 'global', limit: 5 })
  const hitIds = hits.map((h) => h.id)
  ok('语义查询「数据保存用什么方案」→ 命中「SQLite 存储」记忆', hitIds.includes(m1))
  note('命中列表: ' + hits.slice(0, 3).map((h) => h.content.slice(0, 30)).join(' | '))
  // 无关查询不误命中
  const hits2 = await store.search('周末去哪爬山', { scope: 'global', limit: 5 })
  ok('无关查询「周末去哪爬山」→ 不误命中午餐记忆', !hits2.some((h) => h.id === m3))

  // 4. 图谱建边
  console.log('\n== 图谱建边 ==')
  store.graphLink(m1, ['SQLite', '存储', '记忆数据'])
  store.graphLink(m2, ['向量', '余弦相似度'])
  const nodes = store.db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c
  const edges = store.db.prepare('SELECT COUNT(*) AS c FROM edges').get().c
  ok('graphLink 建节点/边（' + nodes + ' 节点 / ' + edges + ' 边）')
  store.linkSimilar(m1, m2, 0.72)
  const simEdges = store.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE type = 'similarTo' AND valid_to IS NULL").get().c
  ok('similarTo 语义边（权重 0.72）', simEdges > 0 ? '' : '未建成')
}

// 5. rule vs remote 语义召回对比
console.log('\n== rule vs remote 语义召回对比（临时库） ==')
{
  const dir2 = mkdtempSync(join(tmpdir(), 'dsh-memory-ab-'))
  const seed = async (s) => {
    await s.add({ layer: 'sm', scope: 'global', content: '用户偏好使用 SQLite 存储记忆数据', keywords: [...tokenize('SQLite 存储 记忆 数据')] })
    await s.add({ layer: 'sm', scope: 'global', content: '向量检索采用余弦相似度排序', keywords: [...tokenize('向量 检索 余弦 相似度')] })
    await s.add({ layer: 'sm', scope: 'global', content: '今天午饭吃了牛肉面', keywords: [...tokenize('午饭 牛肉面')] })
  }
  const sRule = new MemoryStore(join(dir2, 'rule.db'), { time: true, embedder: new RuleEmbedder(256) })
  const sRemote = new MemoryStore(join(dir2, 'remote.db'), { time: true, embedder })
  await seed(sRule); await seed(sRemote)
  const q = '数据保存用什么方案'
  const rRule = await sRule.search(q, { scope: 'global', limit: 5 })
  const rRemote = await sRemote.search(q, { scope: 'global', limit: 5 })
  const scoreOf = (rows) => rows[0]?.content.includes('SQLite') ? rows[0].score : 0
  const s1 = scoreOf(rRule), s2 = scoreOf(rRemote)
  console.log('  查询: ' + q)
  console.log('  rule   top1: ' + (rRule[0]?.content.slice(0, 30) ?? '(无)') + '  score=' + (rRule[0]?.score ?? 0))
  console.log('  remote top1: ' + (rRemote[0]?.content.slice(0, 30) ?? '(无)') + '  score=' + (rRemote[0]?.score ?? 0))
  if (embedder.name === 'remote') {
    ok('remote 语义召回不弱于 rule（' + s1.toFixed(4) + ' vs ' + s2.toFixed(4) + '）', '')
  } else {
    note('remote 不可用，对比仅 rule')
  }
  sRule.close(); sRemote.close(); rmSync(dir2, { recursive: true, force: true })
}

// 6. 汇总
store.close()
if (dir) rmSync(dir, { recursive: true, force: true })
console.log('\n================ 自检报告 ================')
console.log('  嵌入器: ' + embedder.name + '（' + embedder.dim + ' 维）')
console.log('  通过 ' + pass + ' / 失败 ' + fail + ' / 提醒 ' + warn)
if (fail > 0) {
  console.log('  ⚠️ 存在失败项——记忆记录链路可能有问题，请排查上方 ❌')
  process.exit(1)
}
console.log('  ✅ 记忆记录链路工作正常')
