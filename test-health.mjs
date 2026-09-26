import { buildHealthReport, healthLogDetail } from './lib/index.js'
import { MemoryStore, VEC_DIM } from './lib/store.js'
import { RuleEmbedder } from './lib/embedder.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 连通性自检专项（v0.11.1）：
 *  真事故驱动——硅基流动余额 402 → 嵌入静默降级 rule、重排每次白等，
 *  而设置面板仍显示「● 已配置」。本套件钉死：自检必须把「配置齐了」和「真的能用」分开报。 */

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) } }

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-health-'))
const dbs = []
const mkStore = (opts) => {
  const s = new MemoryStore(join(dir, `h${dbs.length}.db`), opts)
  dbs.push(s)
  return s
}
/** 成功嵌入器桩（不联网）。 */
const okEmbedder = (dim = 8) => ({ name: 'remote', dim, async embed(texts) { return texts.map(() => Array(dim).fill(0.1)) } })
/** 失败嵌入器桩：模拟余额不足的 HTTP 402。 */
const badEmbedder = { name: 'remote', dim: 8, async embed() { throw new Error('embedding API 402: {"code":30001,"message":"Sorry, your account balance is insufficient"}') } }
/** 成功重排器桩。 */
const okReranker = { name: 'remote', async rerank(q, docs) { return docs.map((_, i) => ({ index: i, score: i === 0 ? 0.9 : 0.1 })) } }

const baseCfg = (over = {}) => ({
  embedding: { provider: 'remote', model: 'Qwen/Qwen3-Embedding-8B', baseUrl: 'https://api.siliconflow.cn/v1', apiKeyEnv: '__NO_SUCH_KEY__' },
  reranker: { enabled: false, model: 'Qwen/Qwen3-Reranker-8B', apiKeyEnv: '__NO_SUCH_KEY__' },
  refiner: { enabled: true, provider: 'opencode-go', model: 'deepseek-v4.1-flash', apiKeyEnv: '__NO_SUCH_KEY__', reasoningEffort: 'off' },
  ...over,
})

console.log('== 1. 嵌入探针：真发一次请求，失败如实上报 ==')
{
  const store = mkStore({ embedder: okEmbedder(8) })
  const rep = await buildHealthReport({ llm: null }, store, baseCfg())
  check('可用：ok=true 且带维度与耗时', rep.embedding.live.ok === true && rep.embedding.live.dim === 8 && typeof rep.embedding.live.ms === 'number')
  check('可用：active 报出真正算向量的 embedder', rep.embedding.active.embedder === 'remote' && rep.embedding.active.dim === 8)
  check('凭据引用不存在时 keyConfigured=false（不谎报「已配置」）', rep.embedding.keyConfigured === false && rep.reranker.keyConfigured === false)
  check('reranker 未启用 → live 为 null（不假装检测过）', rep.reranker.live === null)
}
{
  const store = mkStore({ embedder: badEmbedder })
  const rep = await buildHealthReport({ llm: null }, store, baseCfg())
  check('余额不足 402：live.ok=false', rep.embedding.live.ok === false)
  check('402 原文透传（可定位到服务端原因）', /402/.test(rep.embedding.live.error) && /balance/.test(rep.embedding.live.error))
  check('整体 ok=false', rep.ok === false)
}

console.log('== 2. 降级态必须显形（vector:true 曾经掩盖 rule 兜底） ==')
{
  const store = mkStore({ embedder: new RuleEmbedder(VEC_DIM), degraded: true })
  const rep = await buildHealthReport({ llm: null }, store, baseCfg())
  check('rule 兜底：live.ok=true（哈希不会失败）', rep.embedding.live.ok === true)
  check('但 active.embedder=rule + degraded=true 同时报出', rep.embedding.active.embedder === 'rule' && rep.embedding.active.degraded === true)
  const st = store.stats()
  check('stats() 不再只有一个布尔：带 vecDim/vecRows/embedder/degraded', st.vecDim === VEC_DIM && typeof st.vecRows === 'number' && st.embedder === 'rule' && st.degraded === true)
}

console.log('== 3. 重排探针 ==')
{
  const store = mkStore({ embedder: okEmbedder(8), reranker: okReranker })
  const rep = await buildHealthReport({ llm: null }, store, baseCfg({ reranker: { enabled: true, model: 'Qwen/Qwen3-Reranker-8B', apiKeyEnv: '__NO_SUCH_KEY__' } }))
  check('启用且创建成功：live.ok=true + 返回打分', rep.reranker.live.ok === true && rep.reranker.live.scores[0] === 0.9)
  check('端点缺省时回落「跟随嵌入端点」', rep.reranker.endpoint === 'https://api.siliconflow.cn/v1')
}
{
  const store = mkStore({ embedder: okEmbedder(8) })   // 无 reranker（密钥缺失/降级）
  const rep = await buildHealthReport({ llm: null }, store, baseCfg({ reranker: { enabled: true, model: 'Qwen/Qwen3-Reranker-8B' } }))
  check('启用但未创建：live.ok=false 且说明原因', rep.reranker.live.ok === false && /未创建/.test(rep.reranker.live.error))
}

console.log('== 4. 提取（refiner）探针 ==')
{
  const store = mkStore({ embedder: okEmbedder(8) })
  const repSilent = await buildHealthReport({ llm: null }, store, baseCfg())
  check('默认不产生 LLM 调用（live=null）', repSilent.refiner.live === null && repSilent.ok === true)

  const ctx = { llm: { stream: async function* () { yield { type: 'text-delta', text: '{"ok":true}' } } } }
  const rep = await buildHealthReport(ctx, store, baseCfg(), { withLlm: true })
  check('LLM 探针拿到文本：ok=true', rep.refiner.live.ok === true && /ok/.test(rep.refiner.live.text))
  check('报告带 provider/model/密钥引用', rep.refiner.provider === 'opencode-go' && rep.refiner.model === 'deepseek-v4.1-flash' && rep.refiner.keyRef === '__NO_SUCH_KEY__')
}
{
  // v0.12.0：探针曾硬编码 maxTokens:32 → 思考型模型正文必然为空 → 自检永远误报。
  const seen = []
  const ctx = {
    llm: { stream: async function* (opts) { seen.push(opts); yield { type: 'reasoning-delta', text: '先判断一下……' }; yield { type: 'text-delta', text: '{"ok":true}' } } },
  }
  const store = mkStore({ embedder: okEmbedder(8) })
  const rep = await buildHealthReport(ctx, store, baseCfg(), { withLlm: true })
  check('探针不传 maxTokens（不再硬编码 32 逼死思考型模型）', seen[0].maxTokens === undefined)
  check('探针也收思考流并报字数', rep.refiner.live.reasoningChars > 0)
  check('有正文即判可用（不被思考拖死）', rep.refiner.live.ok === true)
}
{
  // 掐断但已有正文 → 仍判可用（与提取路径同一条语义：掐断 ≠ 失败）
  const ctx = {
    llm: {
      async *stream(opts) {
        yield { type: 'text-delta', text: '{"ok":true}' }
        await new Promise((resolve) => {
          if (opts.signal?.aborted) return resolve()
          opts.signal?.addEventListener('abort', resolve, { once: true })
          setTimeout(resolve, 3000)
        })
        if (opts.signal?.aborted) throw new Error('aborted')
      },
    },
  }
  const store = mkStore({ embedder: okEmbedder(8) })
  const rep = await buildHealthReport(ctx, store, baseCfg({ refiner: { enabled: true, provider: 'p', model: 'm', timeBudgetMs: 60 } }), { withLlm: true })
  check('时间预算掐断但正文已到手 → ok=true', rep.refiner.live.ok === true)
  check('并如实标注到达预算', /预算/.test(rep.refiner.live.note ?? ''))
}
{
  // v0.13.2：真实事故（2026-09-26）——进程刚起时第一次 LLM 调用只回 [usage,finish] 空回包，
  // 同一进程紧接着再探两次都正常出正文。探针必须重试一次，不能把冷启动抖动报成「模型不可用」。
  const calls = []
  const ctxCold = {
    llm: {
      async *stream() {
        calls.push(1)
        if (calls.length === 1) { yield { type: 'usage', usage: {} }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
        yield { type: 'text-delta', text: '{"ok":true}' }
      },
    },
  }
  const store = mkStore({ embedder: okEmbedder(8) })
  const rep = await buildHealthReport(ctxCold, store, baseCfg(), { withLlm: true })
  check('首次空回包 → 自动重试一次后判可用', rep.refiner.live.ok === true && calls.length === 2)
  check('重试成功时 note 如实写明抖动（不掩盖）', /重试成功/.test(rep.refiner.live.note ?? ''))
}
{
  const store = mkStore({ embedder: okEmbedder(8) })
  const ctxEmpty = { llm: { stream: async function* () { /* 空回包 */ } } }
  const r1 = await buildHealthReport(ctxEmpty, store, baseCfg(), { withLlm: true })
  check('LLM 空回包判失败（思考吞输出的经典形态）', r1.refiner.live.ok === false && /未输出正文/.test(r1.refiner.live.error))

  const ctxBoom = { llm: { stream: async function* () { throw new Error('model not found: deepseek-v4.1-flash') } } }
  const r2 = await buildHealthReport(ctxBoom, store, baseCfg(), { withLlm: true })
  check('LLM 抛错：ok=false 且错误原文透传', r2.refiner.live.ok === false && /model not found/.test(r2.refiner.live.error))
  check('整体 ok=false', r2.ok === false)
}

console.log('== 5. 探针自身绝不抛（自检不能反过来打断服务） ==')
{
  const store = mkStore({ embedder: badEmbedder })
  const ctxBoom = { llm: { get stream() { throw new Error('ctx.llm 不可用') } } }
  let threw = false
  try { await buildHealthReport(ctxBoom, store, baseCfg({ reranker: { enabled: true, model: 'm' } }), { withLlm: true }) } catch { threw = true }
  check('嵌入失败 + llm 取用即抛 + rerank 未创建 → 仍返回报告不抛错', threw === false)
}

console.log('== 端点日志行：字段名必须与报告结构对齐（v0.11.1 的真实事故） ==')
{
  // 事故复盘：handler 里写的是 payload.embedder，而 buildHealthReport 的字段叫 embedding，
  // 于是 /dsh-memory/health 每次都在返回前抛 "Cannot read properties of undefined (reading 'live')"，
  // 自检按钮点了只看到一串报错——而本套件当时没覆盖这条日志行，所以一直绿。
  const store = mkStore({ embedder: okEmbedder(8) })
  const rep = await buildHealthReport({ llm: null }, store, baseCfg())
  let detail = null
  let threw = false
  try { detail = healthLogDetail(rep) } catch { threw = true }
  check('用真实报告喂日志行不抛错', threw === false)
  check('embedder 取自 embedding.live（字段名对齐）', detail?.embedder === true)
  check('reranker 未启用 → 记 null（不是 undefined/抛错）', detail?.reranker === null)
  check('refiner 未做 LLM 探针 → 记 null', detail?.refiner === null)

  // 防御：报告字段缺失/结构意外时也不能炸掉端点
  let threw2 = false
  try { healthLogDetail(undefined); healthLogDetail({}); healthLogDetail({ embedding: {} }) } catch { threw2 = true }
  check('报告残缺时仍不抛错（可选链兜底）', threw2 === false)
  check('残缺时三路一律记 null', healthLogDetail({}).embedder === null && healthLogDetail({}).refiner === null)
}

for (const s of dbs) { try { s.close() } catch { /* 已关闭 */ } }
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }

console.log(`\n连通性自检：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
