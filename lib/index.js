/**
 * dsh-memory — DSH 进阶自动记忆插件
 *
 * v0.10 装配壳：本文件只做依赖装配（settings/init/Web API/管线/工具/ctx.memory），
 * 业务已拆分为独立模块（零行为改动）：
 *   - lib/config.js          配置 schema + 默认值
 *   - lib/util.js            纯函数与常量（scopeOf/formatNow/注入渲染/消息提取…）
 *   - lib/store.js           存储层（sqlite + 检索 + 图谱 + 世界线 + 事件 + 日志）
 *   - lib/embedder.js        Embedder/Reranker seam
 *   - lib/refiner.js         LLM 蒸馏提取
 *   - lib/graph-snapshot.js  记忆级图谱快照投影
 *   - lib/pipelines/         write（沉淀）/ inject（pre-step 注入）/ preheat（会话预热）
 *   - lib/tools/             工具注册（按域拆分的注册器）
 *
 * 公共导出契约（测试与宿主依赖）：apply / Config / scopeOf + name / inject。
 * 设计文档：D:\AItool\dsh-work\memory-plugin-proposal.md
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MemoryStore, tokenize } from './store.js'
import { createEmbeddingServices } from './embedder.js'
import { Config } from './config.js'
import { readCredential, truncate } from './util.js'
import { buildGraphSnapshot } from './graph-snapshot.js'
import { attachWritePipeline } from './pipelines/write.js'
import { attachInjectPipeline, attachPreheatPipeline } from './pipelines/inject.js'
import { registerTools } from './tools/index.js'

export const name = 'dsh-memory'
export const inject = ['tools', 'llm', 'settings', 'workspaceRegistry']

// 对外再导出（保持拆分前 index.js 的导入点契约：测试 import { apply, scopeOf }）
export { Config }
export { scopeOf } from './util.js'

export async function apply(ctx, config) {
  // ============ 防崩溃原则 ============
  // 任何一步失败只警告不抛出：dsh 必须存活，agent 才能回来修。
  // 配置三源合一：schema 默认值 ← 组合层（cordis.patch.yml 的 config，作为 base）
  // ← 用户层（GUI 设置写入 settings.yaml 的 memory 命名空间）。
  let settingsScope = null
  try {
    // 设置命名空间注册：0.1.2-alpha.1 起内核已官方暴露所有已注册命名空间
    // （dsh-api-settings-controller describe()），无需 apiproxy 白名单 hack。
    settingsScope = ctx.settings.register(settingsNamespace('memory'), Config, {
      base: config,
      applies: 'live',
    })
  } catch (err) {
    console.warn(`[dsh-memory] settings 注册失败，用组合层配置兜底: ${err.message}`)
  }
  const getCfg = () => {
    try {
      return settingsScope ? settingsScope.get() : (config ?? {})
    } catch {
      return config ?? {}
    }
  }
  try {
    if (!getCfg().enabled) return
  } catch {
    return
  }

  // ---------- 初始化（隔离：失败 → 记忆功能停用，dsh 正常运行） ----------
  let store
  try {
    const dbFile = getCfg().dbFile || join(homedir(), '.dsh', 'memory.db')
    // 阶段三④：embedder/reranker 初始化（降级链 onnx→remote→rule；密钥走凭据文件）
    const embCfg = getCfg().embedding ?? {}
    const rkCfg = getCfg().reranker ?? {}
    const { embedder, reranker, warnings } = await createEmbeddingServices({
      provider: embCfg.provider ?? 'rule',
      model: embCfg.model,
      baseUrl: embCfg.baseUrl,
      apiKey: readCredential(embCfg.apiKeyEnv ?? 'MEMORY_EMBEDDING_API_KEY'),
      cacheSize: embCfg.cacheSize,
      rerank: rkCfg.enabled
        ? {
            enabled: true, // 透传开关：createEmbeddingServices 按「对象存在」判定（v0.9.25 装配 bug 修复）
            model: rkCfg.model,
            baseUrl: rkCfg.baseUrl || embCfg.baseUrl,
            apiKey: readCredential(rkCfg.apiKeyEnv ?? 'MEMORY_RERANK_API_KEY'),
          }
        : undefined,
    })
    store = new MemoryStore(dbFile, {
      time: getCfg().features.time,
      maxVersions: getCfg().maxVersionsPerMemory,
      embedder,
      reranker,
      // 降级态（v0.9.31）：配置了远程嵌入但初始化失败落到 rule——禁止破坏性维度迁移，
      // 保留现有向量表并暂停向量路（FTS/关键词照常），网络恢复后自动回来。
      degraded: embedder.name === 'rule' && (embCfg.provider ?? 'rule') !== 'rule',
      rerankCfg: {
        topK: rkCfg.topK,
        minCandidates: rkCfg.minCandidates,
        rrfWeight: rkCfg.rrfWeight,
      },
    })
    console.log(`[dsh-memory] embedder: ${embedder.name}（dim ${embedder.dim}）${reranker ? '；reranker: ' + reranker.name + '（' + rkCfg.model + '）' : ''}`)
    // v0.12.7 误配置护栏：强制思考的模型会把 maxTokens 额度**全部花在 reasoning 上**，正文一个字不剩。
    // 这不是理论风险：2026-09-23 实测 settings 里残留 `maxTokens: 800` 时 finish_reason=length、
    // reasoning_tokens=800、正文 0 字 → JSON 解析必失败 → 提取持续降级；同一请求不传上限则
    // finish=stop、正文 2030 字、JSON 直接可解析。启动时吼一声，别让它再静默复发。
    {
      const refCfgWarn = getCfg().refiner ?? {}
      const refMaxWarn = Number(refCfgWarn.maxTokens)
      if (refCfgWarn.enabled !== false && Number.isFinite(refMaxWarn) && refMaxWarn > 0) {
        console.warn(`[dsh-memory] ⚠️ memory.refiner.maxTokens=${refMaxWarn}：强制思考的模型会把额度全花在 reasoning 上，正文为空 → 提取会持续降级为规则路径。建议设为 0（不限制，由 timeBudgetMs 兜底）。`)
      }
    }
    // 运行日志（v0.9.5）：初始化状态透明可见；warnings（降级原因）一并记录，GUI 记忆日志可直接定位
    store.log('info', 'init', { embedder: embedder.name, dim: embedder.dim, reranker: reranker?.name ?? null, dbFile, warnings: warnings.length > 0 ? warnings : undefined })
    // 维度迁移后的后台重嵌入 + 主题聚类 + 首次事件检测（不阻塞启动；迁移期 FTS/关键词路照常）
    void (async () => {
      try {
        // v0.9.31：reembedMissing 内部已带批次重试（指数退避）；这里再对整体补跑，
        // 网络短暂不通时等网络恢复自动补完，而不是留到下次启动
        let r = await store.reembedMissing()
        let round = 0
        while (r.pending > 0 && round < 3 && store.vecEnabled) {
          await new Promise((res) => setTimeout(res, 5000))
          r = await store.reembedMissing()
          round++
        }
        if (r.done > 0 || r.pending > 0) console.log(`[dsh-memory] 重嵌入 ${r.done} 条，剩余 ${r.pending}`)
        if (r.pending === 0) {
          const themes = await store.themeMemories()
          console.log(`[dsh-memory] 主题聚类完成: ${themes.length} 个主题`)
        }
        // 阶段四：首次事件检测（表为空或配置变更时重建）
        const evCfg = getCfg().events ?? {}
        if (evCfg.enabled !== false) {
          const evs = store.detectEventsIncremental((evCfg.gapHours ?? 2) * 3600 * 1000)
          console.log(`[dsh-memory] 事件增量检测: ${evs.length} 个新/更新事件`)
        }
      } catch (err) {
        console.warn(`[dsh-memory] 重嵌入/主题聚类失败（不影响主流程）: ${err.message}`)
      }
    })()

    // ---------- 迁移：存量 auto-memory.json 一键导入 ----------
    void migrateLegacy(store, getCfg().features.time)
  } catch (err) {
    console.error(`[dsh-memory] 初始化失败（已隔离：dsh 正常运行，记忆功能停用）: ${err.stack ?? err.message}`)
    return
  }
  const scope = getCfg().scope || 'global'

  // ---------- 运行日志 helper + workspaceRegistry（供各管线/工具注入） ----------
  const logStore = (level, event, detail, sc) => {
    const lg = getCfg().logging ?? {}
    if (lg.enabled === false) return
    try { store.log(level, event, detail, sc ?? '') } catch { /* 忽略 */ }
  }
  let wsRegistry = null
  try { wsRegistry = ctx.workspaceRegistry ?? null } catch { /* 无 registry 时回落 global */ }
  const pipelineDeps = { store, getCfg, wsRegistry, logStore }

  // ---------- 图谱数据 API + 运行日志 API（供 Web GUI「记忆图谱 / 记忆日志」） ----------
  try {
    ctx.inject(['webServer', 'loader'], (hostCtx) => {
      hostCtx.effect(() => {
        const dispose = hostCtx.webServer.register({
          kind: 'exact',
          path: '/dsh-memory/graph',
          handler: async (request, response) => {
            try {
              if (request.method !== 'GET') {
                response.writeHead(405, { allow: 'GET' })
                response.end()
                return
              }
              const data = buildGraphSnapshot(store)
              response.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              response.end(JSON.stringify(data))
            } catch (err) {
              response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              response.end(String(err?.message ?? err))
            }
          },
        })
        // 运行日志 API（v0.9.5）：GUI「记忆日志」面板数据源
        const disposeLogs = hostCtx.webServer.register({
          kind: 'exact',
          path: '/dsh-memory/logs',
          handler: async (request, response) => {
            try {
              if (request.method !== 'GET') {
                response.writeHead(405, { allow: 'GET' })
                response.end()
                return
              }
              const url = new URL(request.url ?? '/', 'http://localhost')
              const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000)
              const level = url.searchParams.get('level') ?? undefined
              const event = url.searchParams.get('event') ?? undefined
              const rows = store.listLogs({ limit, level, event })
              response.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              response.end(JSON.stringify({ logs: rows }))
            } catch (err) {
              response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              response.end(String(err?.message ?? err))
            }
          },
        })
        // 连通性自检 API（v0.11.1）：把「密钥已配置」升级为「服务真的能用」——
        // 嵌入/重排各发一次真实最小请求；?llm=1 时再附带一次极小的提取模型调用。
        // 背景：硅基流动余额耗尽（402）时，设置面板仍显示「● 已配置」，而日志里
        // 嵌入早已降级到 rule 兜底——配置的"看起来对"和"实际能用"是两件事。
        const disposeHealth = hostCtx.webServer.register({
          kind: 'exact',
          path: '/dsh-memory/health',
          handler: async (request, response) => {
            try {
              if (request.method !== 'GET') {
                response.writeHead(405, { allow: 'GET' })
                response.end()
                return
              }
              const url = new URL(request.url ?? '/', 'http://localhost')
              // 实现里的名字是 llm=1，面板/文档里有人写成 withLlm=1（v0.13.2 起两个都认，
              // 免得再被参数名骗一次——2026-09-26 我拿 withLlm=1 探了半天 refiner.live 恒为 null）
              const withLlm = url.searchParams.get('llm') === '1' || url.searchParams.get('withLlm') === '1'
              const payload = await buildHealthReport(ctx, store, getCfg(), { withLlm })
              store.log(payload.ok ? 'info' : 'warn', 'health', healthLogDetail(payload))
              response.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              response.end(JSON.stringify(payload))
            } catch (err) {
              response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              response.end(String(err?.message ?? err))
            }
          },
        })
        return () => { dispose?.(); disposeLogs?.(); disposeHealth?.() }
      })
    })
  } catch (err) {
    console.warn(`[dsh-memory] 图谱 API 注册失败（GUI 记忆视图不可用）: ${err.message}`)
  }

  // ---------- 管线：写入（turn/end 沉淀）/ 预热（session-start）/ 注入（pre-step） ----------
  attachWritePipeline(ctx, pipelineDeps)
  attachPreheatPipeline(ctx, pipelineDeps)
  attachInjectPipeline(ctx, pipelineDeps)

  // ---------- 工具面（注册失败不影响 dsh——单工具被隔离） ----------
  if (getCfg().features.manageTools) {
    try {
      registerTools(ctx, store, getCfg)
    } catch (err) {
      console.error(`[dsh-memory] 工具注册失败（记忆工具不可用，dsh 正常运行）: ${err.message}`)
    }
  }

  // ---------- ctx.memory seam（简化门面，阶段二完整三件套） ----------
  ctx.provide('memory', {
    store,
    search: (q, opts) => store.search(q, opts),
    add: (entry) => store.add({ scope, ...entry }),
    stats: () => store.stats(),
  })

  ctx.on('dispose', () => {
    store.close()
  })
}

/**
 * 自检结果 → 落日志的摘要（纯函数，便于单测）。
 *
 * 为什么要单独抽出来：v0.11.1 起这里的字段名写错过一次（读 `payload.embedder`，而响应里的
 * 字段叫 `embedding`），于是 `/dsh-memory/health` 每次都在**返回前**抛
 * 「Cannot read properties of undefined」——自检端点自己坏了整整 4 天没人发现，
 * 因为原有测试只覆盖底层报告函数、没覆盖这条日志行。现在它可被直接单测，且全程用可选链兜底。
 */
export function healthLogDetail(payload) {
  return {
    embedder: payload?.embedding?.live?.ok ?? null,
    reranker: payload?.reranker?.live?.ok ?? null,
    refiner: payload?.refiner?.live?.ok ?? null,
  }
}

/** 单路探针：统一产出 { ok, ms, ... }。任何异常都吞成结果，绝不抛出——自检不能反过来打断服务。 */
async function probe(fn) {
  const t0 = Date.now()
  try {
    const detail = (await fn()) ?? {}
    return { ok: true, ms: Date.now() - t0, ...detail }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 300) }
  }
}

/**
 * 连通性自检报告（v0.11.1）：三路各发一次真实最小请求 + 报告配置与凭据存在性。
 *
 * 为什么不复用初始化结果：初始化只发生一次，网络/余额/配额随时会变；而设置面板上的
 * 「● 已配置」只证明凭据文件里有这个键，不证明它能用（本机真实事故：硅基流动 402
 * 余额不足 → 嵌入静默降级 rule、重排每次 402 白等，界面上却一切正常）。
 *
 * @param ctx 插件上下文（提取探针走 ctx.llm.stream）
 * @param store MemoryStore 实例
 * @param cfg 当前配置（live 读取）
 * @param opts.withLlm 是否附带提取模型探针（会产生一次极小的 LLM 调用）
 */
export async function buildHealthReport(ctx, store, cfg, { withLlm = false } = {}) {
  const emb = cfg.embedding ?? {}
  const rk = cfg.reranker ?? {}
  const ref = cfg.refiner ?? {}

  const embedLive = await probe(async () => {
    const vecs = await store.embedTexts(['dsh-memory health probe'])
    const dim = vecs?.[0]?.length ?? 0
    if (!dim) throw new Error('embedding 返回空向量')
    return { dim, model: emb.model, endpoint: emb.baseUrl || '(默认硅基流动端点)' }
  })
  // 嵌入探针成功但走的是 rule 兜底 → 上层配置其实没生效，这在健康报告里必须显形
  const embedding = {
    provider: emb.provider ?? 'remote',
    model: emb.model,
    endpoint: emb.baseUrl || '(默认硅基流动端点)',
    keyRef: emb.apiKeyEnv ?? 'MEMORY_EMBEDDING_API_KEY',
    keyConfigured: Boolean(readCredential(emb.apiKeyEnv ?? 'MEMORY_EMBEDDING_API_KEY')),
    live: embedLive,
    active: store.vectorInfo(),
  }

  const reranker = {
    enabled: Boolean(rk.enabled),
    model: rk.model,
    endpoint: rk.baseUrl || emb.baseUrl || '(跟随嵌入端点)',
    keyRef: rk.apiKeyEnv ?? 'MEMORY_RERANK_API_KEY',
    keyConfigured: Boolean(readCredential(rk.apiKeyEnv ?? 'MEMORY_RERANK_API_KEY')),
    live: rk.enabled
      ? await probe(async () => {
          if (!store.reranker) throw new Error('reranker 未创建（密钥缺失或初始化失败）')
          const scores = await store.reranker.rerank('dsh-memory health probe', ['SQLite 向量检索', '猫粮采购清单'])
          if (!Array.isArray(scores) || scores.length === 0) throw new Error('rerank 返回空结果')
          return { scores: scores.map((s) => Number(s.score?.toFixed?.(4) ?? s.score)) }
        })
      : null,
  }

  const refiner = {
    enabled: Boolean(ref.enabled),
    provider: ref.provider,
    model: ref.model,
    keyRef: ref.apiKeyEnv ?? 'MEMORY_REFINER_API_KEY',
    keyConfigured: Boolean(readCredential(ref.apiKeyEnv ?? 'MEMORY_REFINER_API_KEY')),
    live: null,
  }
  if (withLlm) {
    refiner.live = await probe(async () => {
      // 探针预算：默认 60 秒，但不得比用户给真实提取的预算更宽松。
      // v0.12.7：原来定 25 秒——2026-09-23 实测一次正常提取（不传 maxTokens）要 20.3 秒，
      // 25 秒的探针会**在真实路径正常时也报失败**（探针与被检验路径不同构 → 仪器骗人）。
      // 真实提取的预算是 120 秒，探针取一半，既能挡住"完全不通"也能容下正常的思考时间。
      const cfgBudget = Number(ref.timeBudgetMs)
      const budgetMs = Math.min(60000, Number.isFinite(cfgBudget) && cfgBudget > 0 ? cfgBudget : 60000)
      const PROBE_SYSTEM = '你是记忆提取器。先把判断写进 analysis，再产出 items，只输出合法 JSON。'
      const probeSessionId = `session-probe-${Date.now().toString(36)}`
      const PROBE_TASK = '【合成自检数据，不是真实对话】\n[用户]\n把注入步距改成 12 步。\n[助手]\n已改好，steady 档即每 12 步一检。\n\n请按记忆提取规则输出 JSON（含 analysis 与 items 两个字段）。'

      /**
       * 单次探测。v0.12.6：把"带不带工具表"做成显式变量——
       * 2026-09-23 实测发现：同一个请求带上工具清单时模型会改用 tool_calls、正文为空，
       * 但线上传了 tools: [] 仍为空，所以必须把三种形态一次测穿：
       *   A tools: []（当前修复策略）· B 带一个假工具（验证工具表能否透传）· C 完全不传该字段
       */
      const runOnce = async (label, tools) => {
        const chunks = []
        const reasoning = []
        const chunkTypes = []
        let sawToolCall = false
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), budgetMs)
        try {
          for await (const chunk of ctx.llm.stream({
            provider: ref.provider,
            model: ref.model,
            ...(ref.reasoningEffort ? { reasoningEffort: ref.reasoningEffort } : {}),
            messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_TASK }] }],
            system: PROBE_SYSTEM,
            ...(tools === undefined ? {} : { tools }),
            // v0.12.6：探针必须与真实提取同构——同样带 sessionId（opencode* 路由缺它必 400）
            sessionId: probeSessionId,
            signal: ac.signal,
          })) {
            if (chunk.type && !chunkTypes.includes(chunk.type)) chunkTypes.push(chunk.type)
            if (chunk.type === 'text-delta') chunks.push(chunk.text)
            else if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
            else if (String(chunk.type).includes('tool')) sawToolCall = true
          }
        } catch (err) {
          if (!ac.signal.aborted) throw err
        } finally {
          clearTimeout(timer)
        }
        return { label, text: chunks.join('').trim(), reasoningChars: reasoning.join('').length, chunkTypes, sawToolCall, timedOut: ac.signal.aborted }
      }

      const a1 = await runOnce('A tools=[]', [])
      // v0.13.2：空回包 ≠ 提取模型坏。2026-09-26 实测（进程刚起、第一次 LLM 调用）：
      // A 只回到 [usage,finish] 的空回包；同一进程紧接着再探两次 A 都成功（8.6s / 10.3s 出正文）。
      // 冷启动/上游抖动是瞬时故障，探针必须重试一次才能下「不可用」的结论——否则就是仪器
      // 骗人（教训 mem-1b4267ae：探针把瞬时故障说成稳定结论，会让人去修一个没坏的东西）。
      const a = a1.text || a1.timedOut ? a1 : await runOnce('A tools=[]（冷启动重试）', [])
      if (a.text) {
        return {
          text: a.text.slice(0, 80),
          reasoningChars: a.reasoningChars,
          note: a1.text
            ? '探测A（tools=[]）成功'
            : `探测A 首次空回包（[${a1.chunkTypes.join(',') || '无'}]），重试成功——属瞬时抖动，不算故障`,
          ...(a.timedOut ? { note: '到达预算，已用部分输出判定可用' } : {}),
        }
      }
      // A 连续两次都失败才会走到这里（慢一点但换来一次定位）
      const b = await runOnce('B tools=[假工具]', [{ name: 'probe_noop_tool', description: '自检用的空工具，请勿调用。', parameters: { type: 'object', properties: {}, required: [] } }])
      const c = await runOnce('C 不传 tools', undefined)
      const fmt = (r) => `${r.label}：正文 ${r.text.length} 字、思考 ${r.reasoningChars} 字、块类型=[${r.chunkTypes.join(',') || '无'}]${r.sawToolCall ? '、出现工具调用' : ''}`
      throw new Error(`提取模型未输出正文。${fmt(a1)}${a === a1 ? '' : `；${fmt(a)}`}；${fmt(b)}；${fmt(c)}。（据此可判定：A 成功=修复生效；B 出现工具调用=tools 是元凶但空数组未生效；三者皆空=另有原因）`)
    })
  }

  return {
    ok: embedLive.ok && (!reranker.live || reranker.live.ok) && (!refiner.live || refiner.live.ok),
    checkedAt: new Date().toISOString(),
    embedding,
    reranker,
    refiner,
  }
}

/** 存量 auto-memory.json 迁移（幂等：库为空且旧文件存在才导入）。 */
async function migrateLegacy(store, time) {
  const legacy = join(homedir(), '.dsh', 'auto-memory.json')
  if (!existsSync(legacy)) return
  const stats = store.stats()
  if (stats.memories > 0) return
  try {
    const raw = JSON.parse(readFileSync(legacy, 'utf8'))
    if (!Array.isArray(raw?.entries)) return
    let n = 0
    for (const e of raw.entries) {
      if (!e?.content) continue
      await store.add({
        layer: 'sm',
        type: 'legacy',
        scope: 'global',
        content: truncate(e.content, 2000),
        keywords: (e.keywords ?? [...tokenize(e.content)]).slice(0, 40),
        strength: 0.8,
      })
      n++
    }
    if (n > 0) renameSync(legacy, `${legacy}.bak`)
    console.log(`[dsh-memory] 已迁移 ${n} 条旧记忆 → ${legacy}.bak`)
  } catch (err) {
    console.warn(`[dsh-memory] 迁移失败: ${err.message}`)
  }
}
