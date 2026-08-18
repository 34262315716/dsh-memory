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
    const { embedder, reranker } = await createEmbeddingServices({
      provider: embCfg.provider ?? 'rule',
      model: embCfg.model,
      baseUrl: embCfg.baseUrl,
      apiKey: readCredential(embCfg.apiKeyEnv ?? 'MEMORY_EMBEDDING_API_KEY'),
      cacheSize: embCfg.cacheSize,
      rerank: rkCfg.enabled
        ? {
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
      rerankCfg: {
        topK: rkCfg.topK,
        minCandidates: rkCfg.minCandidates,
        rrfWeight: rkCfg.rrfWeight,
      },
    })
    console.log(`[dsh-memory] embedder: ${embedder.name}（dim ${embedder.dim}）${reranker ? '；reranker: ' + reranker.name + '（' + rkCfg.model + '）' : ''}`)
    // 运行日志（v0.9.5）：初始化状态透明可见
    store.log('info', 'init', { embedder: embedder.name, dim: embedder.dim, reranker: reranker?.name ?? null, dbFile })
    // 维度迁移后的后台重嵌入 + 主题聚类 + 首次事件检测（不阻塞启动；迁移期 FTS/关键词路照常）
    void (async () => {
      try {
        const r = await store.reembedMissing()
        if (r.done > 0 || r.pending > 0) console.log(`[dsh-memory] 重嵌入 ${r.done} 条，剩余 ${r.pending}`)
        if (r.pending === 0) {
          const themes = await store.themeMemories()
          console.log(`[dsh-memory] 主题聚类完成: ${themes.length} 个主题`)
        }
        // 阶段四：首次事件检测（表为空或配置变更时重建）
        const evCfg = getCfg().events ?? {}
        if (evCfg.enabled !== false) {
          const evs = store.detectEvents((evCfg.gapHours ?? 2) * 3600 * 1000)
          console.log(`[dsh-memory] 事件检测完成: ${evs.length} 个事件`)
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
        return () => { dispose?.(); disposeLogs?.() }
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
