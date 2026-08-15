/**
 * Embedder / Reranker seam（阶段三④ 真 embedding，期 1/2）：
 *   - Embedder：rule（哈希兜底）| remote（OpenAI 兼容 /v1/embeddings）| onnx（预留期 3）
 *   - Reranker：remote（/v1/rerank，如硅基流动 Qwen3-VL-Reranker）| onnx（预留）
 * 接口统一 async；降级链：onnx → remote → rule（rule 永不失败）。
 * 密钥一律经凭据引用传入，绝不落 settings 文档/记忆库。
 */
import { ruleEmbed, VEC_DIM } from './store.js'

/** 规则嵌入器（默认兜底）：同步计算、离线、确定性。 */
export class RuleEmbedder {
  constructor(dim = VEC_DIM) {
    this.name = 'rule'
    this.dim = dim
  }
  async ready() { /* 无初始化 */ }
  async embed(texts) {
    return texts.map((t) => Array.from(ruleEmbed(t, this.dim)))
  }
}

/** 远程嵌入器：OpenAI 兼容 /v1/embeddings（批量 ≤32/请求，LRU 缓存，超时保护）。 */
export class RemoteEmbedder {
  constructor({ baseUrl, apiKey, model, dim = 0, cacheSize = 1024, timeoutMs = 8000, fetchImpl }) {
    this.name = 'remote'
    this.baseUrl = (baseUrl ?? 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
    this.apiKey = apiKey
    this.model = model
    this.dim = dim            // 0 = 首次请求后从响应学习
    this.cacheSize = cacheSize
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.cache = new Map()    // text -> number[]
    this._ready = false
  }
  async ready() {
    if (this._ready) return
    const vecs = await this.embed(['ready-probe'])
    if (vecs.length === 0 || vecs[0].length === 0) throw new Error('remote embedder 探测失败（空响应）')
    if (!this.dim) this.dim = vecs[0].length
    this._ready = true
  }
  async embed(texts) {
    const out = new Array(texts.length)
    const pending = []
    const pendingIdx = []
    for (let i = 0; i < texts.length; i++) {
      const hit = this.cache.get(texts[i])
      if (hit) out[i] = hit
      else { pending.push(texts[i]); pendingIdx.push(i) }
    }
    for (let s = 0; s < pending.length; s += 32) {
      const batch = pending.slice(s, s + 32)
      const res = await this._post('/embeddings', { model: this.model, input: batch })
      if (!res.ok) throw new Error('embedding API ' + res.status + ': ' + (await res.text()).slice(0, 120))
      const j = await res.json()
      const data = Array.isArray(j.data) ? j.data : []
      for (let k = 0; k < batch.length; k++) {
        const vec = data[k]?.embedding
        if (!Array.isArray(vec) || vec.length === 0) throw new Error('embedding 响应缺少向量')
        this._cacheSet(batch[k], vec)
        out[pendingIdx[s + k]] = vec
      }
      if (!this.dim) this.dim = data[0]?.embedding?.length ?? 0
    }
    return out
  }
  async _post(path, body) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(this.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
  _cacheSet(key, vec) {
    if (this.cache.has(key)) this.cache.delete(key)
    this.cache.set(key, vec)
    while (this.cache.size > this.cacheSize) {
      const first = this.cache.keys().next()
      if (first.done) break
      this.cache.delete(first.value)
    }
  }
}

/** 远程重排器：/v1/rerank（query × documents 对打分，返回 index + relevance_score）。
 *  LRU 缓存 (query, doc) → score：注入签名去抖场景下同一 query 重复 rerank 命中率高。 */
export class RemoteReranker {
  constructor({ baseUrl, apiKey, model, timeoutMs = 8000, cacheSize = 1024, fetchImpl }) {
    this.name = 'remote'
    this.baseUrl = (baseUrl ?? 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
    this.apiKey = apiKey
    this.model = model
    this.timeoutMs = timeoutMs
    this.cacheSize = cacheSize
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.cache = new Map() // query + '\u0000' + doc -> score
  }
  async rerank(query, docs) {
    const scores = new Map() // doc index -> score（缓存命中直接回填）
    const pending = []       // { i, doc, key }
    for (let i = 0; i < docs.length; i++) {
      const key = query + '\u0000' + docs[i]
      const hit = this.cache.get(key)
      if (hit !== undefined) scores.set(i, hit)
      else pending.push({ i, doc: docs[i], key })
    }
    if (pending.length === 0) {
      // 全部缓存命中：按 docs 顺序回填（无网络请求）
      return docs.map((_, i) => ({ index: i, score: scores.get(i) ?? 0 }))
    }
    // 返回顺序 = API results 顺序（即按相关分降序的排序结果）；API 未覆盖的 doc 补 0 分
    const out = []
    const seen = new Set()
    if (pending.length > 0) {
      const res = await this._post('/rerank', { model: this.model, query, documents: pending.map((p) => p.doc), top_n: pending.length })
      if (!res.ok) throw new Error('rerank API ' + res.status + ': ' + (await res.text()).slice(0, 120))
      const j = await res.json()
      for (const r of Array.isArray(j.results) ? j.results : []) {
        const p = pending[r.index]
        if (!p) continue
        const score = Number(r.relevance_score) ?? 0
        out.push({ index: p.i, score })
        seen.add(r.index)
        scores.set(p.i, score)
        this._cacheSet(p.key, score)
      }
    }
    for (let i = 0; i < pending.length; i++) {
      if (!seen.has(i)) out.push({ index: pending[i].i, score: 0 })
    }
    return out
  }
  _cacheSet(key, score) {
    if (this.cache.has(key)) this.cache.delete(key)
    this.cache.set(key, score)
    while (this.cache.size > this.cacheSize) {
      const first = this.cache.keys().next()
      if (first.done) break
      this.cache.delete(first.value)
    }
  }
  async _post(path, body) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(this.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 工厂 + 降级链：按配置 provider 初始化，失败自动落下一级，最终 rule（永不失败）。
 * 返回 { embedder, reranker, warnings }。
 */
export async function createEmbeddingServices(cfg, deps = {}) {
  const warnings = []
  let embedder = null
  let reranker = null
  const provider = cfg.provider ?? 'rule'
  const baseUrl = cfg.baseUrl || undefined
  const apiKey = cfg.apiKey || undefined

  if (provider === 'onnx') {
    warnings.push('provider=onnx 尚未实现（期 3），走降级链')
  }
  if (provider === 'onnx' || provider === 'remote') {
    if (!apiKey) warnings.push('未配置 embedding apiKey，跳过 remote')
    else {
      try {
        const remote = new RemoteEmbedder({
          baseUrl, apiKey, model: cfg.model, dim: cfg.dim ?? 0,
          cacheSize: cfg.cacheSize ?? 1024, fetchImpl: deps.fetchImpl,
        })
        await remote.ready()
        embedder = remote
      } catch (err) {
        warnings.push('remote embedder 初始化失败: ' + err.message)
      }
    }
  }
  if (!embedder) {
    embedder = new RuleEmbedder(cfg.ruleDim ?? VEC_DIM)
    if (provider !== 'rule') warnings.push('已降级到 rule embedder')
  }

  if (cfg.rerank?.enabled) {
    const rk = cfg.rerank
    if (!rk.apiKey) warnings.push('未配置 rerank apiKey，重排禁用')
    else {
      try {
        reranker = new RemoteReranker({
          baseUrl: rk.baseUrl || baseUrl, apiKey: rk.apiKey, model: rk.model,
          fetchImpl: deps.fetchImpl,
        })
      } catch (err) {
        warnings.push('reranker 初始化失败: ' + err.message)
      }
    }
  }

  for (const w of warnings) console.warn('[dsh-memory] ' + w)
  return { embedder, reranker, warnings }
}

/** 余弦相似度（向量可能未归一化）。 */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
