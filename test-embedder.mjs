import { RuleEmbedder, RemoteEmbedder, RemoteReranker, createEmbeddingServices, cosine } from './lib/embedder.js'
import { MemoryStore } from './lib/store.js'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) } }

// 1. RuleEmbedder 行为与 ruleEmbed 一致
const r1 = new RuleEmbedder(256)
const vecs = await r1.embed(['SQLite 存储'])
check('rule embedder 256 维 + 确定性', vecs[0].length === 256 && JSON.stringify(vecs[0]) === JSON.stringify((await r1.embed(['SQLite 存储']))[0]))

// 2. RemoteEmbedder：mock fetch 测批量/缓存/降维学习
let calls = 0
const mockFetch = async (url, opts) => {
  calls++
  const body = JSON.parse(opts.body)
  return {
    ok: true,
    json: async () => ({ data: body.input.map((t) => ({ embedding: [t.length, 1, 2, 3] })) }),
    text: async () => 'mock',
  }
}
const remote = new RemoteEmbedder({ baseUrl: 'https://mock', apiKey: 'x', model: 'm', dim: 0, fetchImpl: mockFetch })
const v1 = await remote.embed(['aaaa', 'bb'])
check('remote 批量返回 + 从响应学习维度', v1.length === 2 && v1[0][0] === 4 && remote.dim === 4)
const v2 = await remote.embed(['aaaa'])   // 缓存命中，不再发请求
check('LRU 缓存命中（无新请求）', calls === 1 && v2[0][0] === 4)

// 3. 降级链：remote 失败 → rule
const badFetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
const svc = await createEmbeddingServices({ provider: 'remote', model: 'm', apiKey: 'x', baseUrl: 'https://mock' }, { fetchImpl: badFetch })
check('降级链落到 rule', svc.embedder.name === 'rule' && svc.warnings.length > 0)

// 4. Reranker mock
const mockRerankFetch = async (url, opts) => ({ ok: true, json: async () => ({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }), text: async () => '' })
const reranker = new RemoteReranker({ baseUrl: 'https://mock', apiKey: 'x', model: 'r', fetchImpl: mockRerankFetch })
const rr = await reranker.rerank('q', ['a', 'b'])
check('reranker 返回全部 doc 的分数（按 docs 顺序）', rr.length === 2 && rr[0].score === 0.1 && rr[1].score === 0.9)

// 4b. createEmbeddingServices 启用判定（v0.9.25 装配 bug 守护）：
//     index.js 组装后传入的 rerank 对象不带 enabled 字段，判定必须是「存在即启用」
const svcR = await createEmbeddingServices({ provider: 'rule', rerank: { model: 'r', apiKey: 'x' } }, { fetchImpl: mockRerankFetch })
check('rerank 对象存在即创建 reranker（不带 enabled 字段）', svcR.reranker?.name === 'remote')
const svc0 = await createEmbeddingServices({ provider: 'rule' }, { fetchImpl: mockRerankFetch })
check('rerank 缺省不创建 reranker', svc0.reranker === null)

// 5. 真实硅基流动 API（凭据文件读密钥；兼容 refs 嵌套缩进——修复前顶格匹配恒 undefined 致本测试静默跳过）
const cred = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const key = (cred.match(/^\s*MEMORY_EMBEDDING_API_KEY:\s*(\S+)/m) ?? [])[1]
if (key) {
  try {
    const real = new RemoteEmbedder({ baseUrl: 'https://api.siliconflow.cn/v1', apiKey: key, model: 'Qwen/Qwen3-VL-Embedding-8B' })
    const rv = await real.embed(['SQLite 向量检索', '今天天气很好'])
    check('真实 API：4096 维 + 相似文本余弦 > 无关', rv[0].length === 4096 && cosine(rv[0], rv[0]) > 0.99)
    check('真实 API：dim 自动学习', real.dim === 4096)
  } catch (e) { fail++; console.log('  ❌ 真实 API: ' + e.message.slice(0, 100)) }
}

// 6. RemoteReranker LRU 缓存：同 (query, doc) 命中缓存，不再发请求
let rrCalls = 0
const cacheFetch = async (url, opts) => {
  rrCalls++
  const body = JSON.parse(opts.body)
  return { ok: true, json: async () => ({ results: body.documents.map((_, i) => ({ index: i, relevance_score: 0.5 + i * 0.1 })) }), text: async () => '' }
}
const rrCached = new RemoteReranker({ baseUrl: 'https://mock', apiKey: 'x', model: 'r', fetchImpl: cacheFetch })
const c1 = await rrCached.rerank('q1', ['docA', 'docB'])
const c2 = await rrCached.rerank('q1', ['docA', 'docB'])   // 全部缓存命中
check('rerank 结果按 index 返回', c1[0].index === 0 && c1[1].index === 1)
check('rerank LRU 缓存命中（第二次零请求）', rrCalls === 1 && c2[1].score === c1[1].score)
await rrCached.rerank('q1', ['docB'])                       // 预热缓存 B
const c3 = await rrCached.rerank('q1', ['docA', 'docB', 'docC'])   // 部分命中：B 缓存，A/C 请求
check('rerank 部分缓存命中：返回全部 doc（不丢缓存项）', c3.length === 3 && c3[1].score === c1[1].score && c3[2].score === 0.5)
const c4 = await rrCached.rerank('q1', ['docC'])            // 新 doc 单条
check('rerank 新 doc 请求', c4.length === 1 && c4[0].score === 0.5)

// 7. store 层 rerank 集成：RRF 融合后精排（mock reranker 反转顺序）
class MockReranker {
  constructor(scores) { this.name = 'mock'; this.calls = 0; this.scores = scores ?? [] }
  async rerank(query, docs) {
    this.calls++
    return docs.map((_, i) => ({ index: i, score: this.scores[i] ?? 0.1 }))
  }
}
const mkStore = async (reranker, rerankCfg) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-test-'))
  const store = new MemoryStore(join(dir, 't.db'), {
    embedder: new RuleEmbedder(256),
    reranker,
    rerankCfg: rerankCfg ?? { topK: 20, minCandidates: 3, rrfWeight: 0.7 },
  })
  for (const [i, text] of ['记忆甲 rrf 主题', '记忆乙 rrf 主题', '记忆丙 rrf 主题'].entries()) {
    await store.add({ layer: 'sm', type: 'note', scope: 'test', content: text, keywords: ['rrf', '主题', '记忆' + '甲乙丙'[i]] })
  }
  return { store, dir }
}
{
  const mock = new MockReranker([0.1, 0.2, 0.99])
  const { store, dir } = await mkStore(mock)
  const hits = await store.search('rrf 主题', { scope: 'test', limit: 3, minScore: 0 })
  // 三条 kw 分相同 → RRF 后按 id 序；rerank 给丙 0.99 → 融合后丙应第一
  check('rerank 融合：高分文档升至第一', hits.length === 3 && hits[0].content.includes('丙') && mock.calls === 1)
  store.close(); rmSync(dir, { recursive: true, force: true })
}
{
  // reranker 失败 → 降级 RRF 顺序，不抛异常
  const failing = { name: 'mock', async rerank() { throw new Error('api down') } }
  const { store, dir } = await mkStore(failing)
  let threw = false
  let hits = []
  try { hits = await store.search('rrf 主题', { scope: 'test', limit: 3, minScore: 0 }) }
  catch { threw = true }
  check('reranker 失败降级 RRF（无异常且结果非空）', !threw && hits.length === 3)
  store.close(); rmSync(dir, { recursive: true, force: true })
}
{
  // 候选不足（2 < minCandidates 3）→ 不调用 reranker
  const mock = new MockReranker()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-test-'))
  const store = new MemoryStore(join(dir, 't.db'), { embedder: new RuleEmbedder(256), reranker: mock, rerankCfg: { topK: 20, minCandidates: 3, rrfWeight: 0.7 } })
  await store.add({ layer: 'sm', type: 'note', scope: 'test', content: '只有两条 rrf', keywords: ['rrf'] })
  await store.add({ layer: 'sm', type: 'note', scope: 'test', content: '也是两条 rrf', keywords: ['rrf'] })
  const hits = await store.search('rrf', { scope: 'test', limit: 3, minScore: 0 })
  check('候选不足不触发 rerank', hits.length === 2 && mock.calls === 0)
  store.close(); rmSync(dir, { recursive: true, force: true })
}
{
  // P1-1 守护（v0.9.29）：minScore 门槛在 rerank 前按 RRF 分过滤——
  // rerank 全给低分也不得用融合分 [0,1] 尺度绕过门槛（修复前噪音候选融合 0.69 仍漏网）
  const mock = new MockReranker([0.01, 0.01, 0.01])
  const { store, dir } = await mkStore(mock)
  const hits = await store.search('rrf 主题', { scope: 'test', limit: 3, minScore: 0.05 })
  check('minScore 按 RRF 分前置过滤（rerank 低分噪音被滤且不触发 rerank）', hits.length === 0 && mock.calls === 0)
  const hits0 = await store.search('rrf 主题', { scope: 'test', limit: 3, minScore: 0 })
  check('minScore=0 仍走 rerank 融合', hits0.length === 3 && mock.calls === 1)
  store.close(); rmSync(dir, { recursive: true, force: true })
}
{
  // P2-1 守护（v0.9.29）：rerank 失败熔断——失败后冷却期内不再调用（免每次 8s 挂起 + warn 刷屏）
  const failing = { name: 'mock', calls: 0, async rerank() { this.calls++; throw new Error('api down') } }
  const { store, dir } = await mkStore(failing)
  const h1 = await store.search('rrf 主题', { scope: 'test', limit: 3, minScore: 0 })
  check('rerank 失败降级且置冷却', h1.length === 3 && failing.calls === 1 && store.rerankCooldownUntil > Date.now())
  const h2 = await store.search('rrf 主题', { scope: 'test', limit: 3, minScore: 0 })
  check('冷却期内跳过 rerank（结果仍按 RRF 返回）', h2.length === 3 && failing.calls === 1)
  store.close(); rmSync(dir, { recursive: true, force: true })
}
{
  // rerank+boost 组合（v0.9.29）：boost 抬升的画像成为 rerank topK 候选首位
  const seen = []
  const spy = {
    name: 'mock', calls: 0,
    async rerank(query, docs) { this.calls++; seen.push([...docs]); return docs.map((_, i) => ({ index: i, relevance_score: 0.5 })) },
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-test-'))
  const store = new MemoryStore(join(dir, 't.db'), { embedder: new RuleEmbedder(256), reranker: spy, rerankCfg: { topK: 2, minCandidates: 2, rrfWeight: 0.7 } })
  await store.add({ layer: 'sm', type: 'note', scope: 'test', content: '丹道修炼记录与图谱治理方法整理完成修复注入链路', keywords: ['丹道', '修炼', '记录', '图谱', '治理'] })
  await store.add({ layer: 'sm', type: 'profile', scope: 'test', content: '用户修行丹道，近期课题是接纳情绪。', keywords: ['丹道'], aspect: 'habit' })
  await store.search('丹道修炼记录', { scope: 'test', limit: 5, minScore: 0 })
  check('无 boost：rerank 候选首位是长记忆', seen.length === 1 && seen[0][0].includes('图谱治理') && !seen[0][0].includes('接纳情绪'))
  await store.search('丹道修炼记录', { scope: 'test', limit: 5, minScore: 0, boost: { profile: 3 } })
  check('boost 后画像升至 rerank 候选首位', seen.length === 2 && seen[1][0].includes('接纳情绪'))
  store.close(); rmSync(dir, { recursive: true, force: true })
}
{
  // 向量独有命中回归：2 字查询 FTS/关键词均不命中，只有向量路 → 结果必须非空（修复前丢失）
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-test-'))
  const store = new MemoryStore(join(dir, 't.db'), { embedder: new RuleEmbedder(256), reranker: null })
  await store.add({ layer: 'sm', type: 'note', scope: 'test', content: '深蓝海洋的记忆内容', keywords: ['深蓝', '海洋'] })
  const hits = await store.search('蓝海', { scope: 'test', limit: 3, minScore: 0 })
  check('向量独有命中不再丢失', hits.length === 1)
  // 阈值语义（RRF 量纲：理论上限三路全中 ~0.049）：
  // 旧默认 0.2 超过理论上限 → 永不注入（pre-step 注入从未触发的根因）；新默认 0.015 放行
  const hits20 = await store.search('蓝海', { scope: 'test', limit: 3, minScore: 0.2 })
  const hits015 = await store.search('蓝海', { scope: 'test', limit: 3, minScore: 0.015 })
  check('minScore 0.2 过滤一切命中（旧默认永不注入的根因）', hits20.length === 0)
  check('minScore 0.015 放行命中（新默认）', hits015.length === 1)
  store.close(); rmSync(dir, { recursive: true, force: true })
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
