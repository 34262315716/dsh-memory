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
check('reranker 返回排序结果', rr[0].index === 1 && rr[0].score === 0.9)

// 5. 真实硅基流动 API（凭据文件读密钥）
const cred = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const key = (cred.match(/^MEMORY_EMBEDDING_API_KEY:\s*(\S+)/m) ?? [])[1]
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
const c3 = await rrCached.rerank('q1', ['docC'])            // 新 doc 只发新请求
check('rerank 部分缓存命中', rrCalls === 2 && c3[0].score === 0.5)

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
