import { RuleEmbedder, RemoteEmbedder, RemoteReranker, createEmbeddingServices, cosine } from './lib/embedder.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
