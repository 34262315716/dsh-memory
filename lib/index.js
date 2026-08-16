/**
 * dsh-memory — DSH 进阶自动记忆插件（阶段一落地）
 *
 * 已实现：
 *   - SQLite 存储（node:sqlite，WAL + STRICT + FTS5 trigram 中文检索）
 *   - 分层记忆（ep 情景 / sm 语义）+ scope
 *   - 时间维度世界线（time 开关）：更新追加版本，旧版本隐藏不参与检索/注入
 *   - 写入侧：turn/end 自动沉淀 + 价值门（规则）+ Jaccard 去重合并（更新而非新建）
 *   - 注入侧：pre-step 每步触发（步距节流 + 签名去抖 + 注入块 hash 去抖 + 防循环窗口）
 *     + KV 缓存友好格式（稳定块头、确定性排序、只 append 尾部）
 *   - 工具面：memory_add / search / forget / list / stats（manageTools 开关）
 *   - 图谱骨架：graph 开关开启时建 entity 节点 + mentions 共现边
 *   - 存量 auto-memory.json 一键迁移
 *
 * 设计文档：D:\AItool\dsh-work\memory-plugin-proposal.md
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MemoryStore, tokenize, jaccard } from './store.js'
import { createEmbeddingServices } from './embedder.js'

export const name = 'dsh-memory'
export const inject = ['tools', 'llm', 'settings']


/** 插件配置：参数 + 功能开关矩阵（§16）。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 数据库文件；留空默认 ~/.dsh/memory.db */
  dbFile: z.string().default(''),
  /** 默认作用域（跨会话默认收窄到当前工作目录名，避免全局泄漏） */
  scope: z.string().default(''),
  /** 每次注入最大 token 估算 */
  injectMaxTokens: z.number().min(100).max(4000).default(800),
  /** 注入最低分数（RRF 融合量纲：三路全中 ~0.049、单路 rank1 ~0.016；0.015 ≈ 至少一路排前 13，语义召回不丢） */
  injectMinScore: z.number().min(0).max(1).default(0.015),
  /** 步距节流：每 N 步全量重检索 */
  stepInterval: z.number().min(1).max(10).default(2),
  /** 每个 agent 最近注入窗口（防循环） */
  maxRecentPerAgent: z.number().min(1).max(50).default(6),
  /** 每条记忆最多保留版本数（世界线长度） */
  maxVersionsPerMemory: z.number().min(1).max(50).default(8),
  /** 独立提取模型（refiner）：用 LLM 从会话中蒸馏有效记忆，替代原始高噪声文本入库。 */
  refiner: z.object({
    /** 开关：开启后 turn/end 走 LLM 提取（失败自动降级规则路径）。 */
    enabled: z.boolean().default(false),
    /** 提取用的 provider（如 opencode-go / deepseek-official / 自建独立供应商）。 */
    provider: z.string().default('opencode-go'),
    /** 提取用的模型（如 deepseek-v4-flash / deepseek-v4-pro）。 */
    model: z.string().default('deepseek-v4-flash'),
    /**
     * 独立密钥引用名（凭据文件 ~/.dsh/.credentials.yaml 中的键）。
     * 该 provider 的 adapter 通过此引用解析 API key；密钥绝不进入 settings 文档/记忆库。
     * 使用自建供应商时，在「设置→模型」添加 provider 并把 apiKeyEnv 设为同名。
     */
    apiKeyEnv: z.string().default('MEMORY_REFINER_API_KEY'),
    /** 提取输出最大 token。 */
    maxTokens: z.number().min(100).max(4000).default(800),
  }),
  features: z.object({
    /** 自动写入（turn/end 沉淀） */
    autoWrite: z.boolean().default(true),
    /** 价值门（噪音过滤） */
    valueGate: z.boolean().default(true),
    /** 去重合并（相似记忆更新而非新建） */
    dedupMerge: z.boolean().default(true),
    /** pre-step 自动注入 */
    preStepInject: z.boolean().default(true),
    /** 管理工具集 */
    manageTools: z.boolean().default(true),
    /** 时间维度（版本化世界线） */
    time: z.boolean().default(true),
    /** 图谱骨架（节点+共现边） */
    graph: z.boolean().default(false),
  }),
  /** 嵌入模型（阶段三④）：rule 哈希兜底 | remote OpenAI 兼容 API | onnx 本地（预留） */
  embedding: z.object({
    provider: z.string().default('remote'),
    model: z.string().default('Qwen/Qwen3-VL-Embedding-8B'),
    baseUrl: z.string().default('https://api.siliconflow.cn/v1'),
    apiKeyEnv: z.string().default('MEMORY_EMBEDDING_API_KEY'),
    cacheSize: z.number().min(64).max(8192).default(1024),
  }),
  /** 重排模型（阶段三④）：RRF 融合后精排（失败降级 RRF 顺序） */
  reranker: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default('remote'),
    model: z.string().default('Qwen/Qwen3-VL-Reranker-8B'),
    baseUrl: z.string().default(''),
    apiKeyEnv: z.string().default('MEMORY_RERANK_API_KEY'),
    topK: z.number().min(5).max(50).default(20),
    minCandidates: z.number().min(2).max(20).default(3),
    rrfWeight: z.number().min(0).max(1).default(0.7),
  }),
  /** 图谱力导向参数（GUI 记忆图谱物理手感；改后重开图谱面板生效） */
  graphView: z.object({
    spring: z.number().min(0.02).max(0.5).default(0.13),
    repulsion: z.number().min(0.2).max(2).default(1),
    damping: z.number().min(0.05).max(0.9).default(0.3),
    gravity: z.number().min(0).max(0.05).default(0.005),
  }),
  /** 管家（阶段三⑥）：低频自动巡检（去重/老化，只读报告不擅改数据）。
   *  触发策略（与对话轮数解耦）：每写入 interval 条记忆 或 距上次巡检超 maxIntervalHours 小时。 */
  housekeeping: z.object({
    enabled: z.boolean().default(true),
    interval: z.number().min(5).max(500).default(20),   // 每沉淀 N 条记忆巡检一次
    maxIntervalHours: z.number().min(1).max(720).default(24),  // 时间兜底（小时）
    dedupThreshold: z.number().min(0.8).max(0.99).default(0.92),
    agingDays: z.number().min(7).max(365).default(30),
  }),
  /** 事件分类（阶段四 v0.9.0）：时间连续 + 因果相关的记忆聚簇（区别于主题语义聚类） */
  events: z.object({
    enabled: z.boolean().default(true),
    gapHours: z.number().min(0.5).max(48).default(2),  // 时间线扫描间隔阈值（小时）
  }),
})

/** 估算文本 token 数（中文按字、英文按 4 字符，粗略）。 */
function estimateTokens(text) {
  let n = 0
  for (const seg of text.matchAll(/[\u4e00-\u9fff]/g)) n++ // 每中文字 ~1 token
  const rest = text.replace(/[\u4e00-\u9fff]/g, '')
  n += Math.ceil(rest.length / 4)
  return n
}

const WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 当前系统时间（本地格式化 + ISO + Unix）。供 system_now 工具与预热注入复用。 */
export function formatNow(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const tzOffset = -now.getTimezoneOffset() / 60
  return {
    iso: now.toISOString(),
    unix: now.getTime(),
    local,
    date: local.slice(0, 10),
    time: local.slice(11),
    weekday: WEEKDAYS_CN[now.getDay()],
    tz: `UTC${tzOffset >= 0 ? '+' : ''}${tzOffset}`,
  }
}

/** 预热 seed 选择：画像优先——画像 3 条 + 非画像 2 条（"用户是谁"优先于"最近干了啥"）。导出可测。 */
export function pickPreheatSeeds(sm) {
  const profiles = sm.filter((m) => m.type === 'profile').slice(0, 3)
  const others = sm.filter((m) => m.type !== 'profile').slice(0, 2)
  return [...profiles, ...others]
}

/** 从消息数组提取真实用户文本（排除注入内容）。 */
function extractUserText(messages) {
  const parts = []
  for (const msg of messages) {
    if (msg?.role !== 'user' || msg.source?.kind !== 'user') continue
    for (const block of msg.content ?? []) {
      if (block.type === 'text' && block.text) parts.push(block.text)
    }
  }
  return parts.join('\n').slice(0, 8000)
}

function messageText(msg) {
  const parts = []
  for (const block of msg?.content ?? []) {
    if (block.type === 'text' && block.text) parts.push(block.text)
  }
  return parts.join('\n')
}

function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** 成果信号：无用户消息的自主轮次只有输出含这些标记才沉淀（过滤思考中间态噪音）。 */
const OUTCOME_RE = /✅|已完成|已修复|已交付|已迁移|已同步|已产出|已通过|全部通过|通过|成功|完成|修复|交付|产出|结论[:：]|结果[:：]/

/** 从凭据文件读取密钥引用（值绝不出现在 settings/日志/记忆）。 */
function readCredential(name) {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const cr = String.fromCharCode(13); const lf = String.fromCharCode(10)
  const line = raw.replaceAll(cr + lf, lf).split(lf).find((l) => l.startsWith(name + ':'))
  if (!line) return undefined
  return line.slice(line.indexOf(':') + 1).trim() || undefined
    return m?.[1] ?? undefined
  } catch {
    return undefined
  }
}

/** 注入块渲染：稳定块头 + 确定性排序（score desc, id asc）+ 固定字段结构。 */
function renderInjection(hits, scopeLabel) {
  const lines = [
    '[记忆] 与当前工作相关的既有记录（来源：dsh-memory，form=recall，可能过时仅供参考）',
  ]
  for (const h of hits) {
    const when = new Date(h.updated_at).toISOString().slice(0, 10)
    const layer = h.layer === 'ep' ? '情景' : '语义'
    lines.push(`【${layer}记忆】#${h.id}  ·  相关度 ${h.score.toFixed(2)}  ·  ${when}`)
    lines.push(`> ${h.content.replace(/\n/g, '\n> ')}`)
  }
  return lines.join('\n')
}

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
    const scope = getCfg().scope || 'global'
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

  // ---------- 图谱数据 API（供 Web GUI「记忆」视图，记忆级投影：一记忆一节点） ----------
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
        return () => dispose?.()
      })
    })
  } catch (err) {
    console.warn(`[dsh-memory] 图谱 API 注册失败（GUI 记忆视图不可用）: ${err.message}`)
  }

  // ---------- 写入侧：缓存消息文本，turn/end 沉淀 + 价值门 + 去重 ----------
  const turnCache = new Map() // sessionId -> { turn, userTexts, assistantTexts, writtenTurns }
  const hkState = { writtenSinceCheck: 0, inFlight: false }  // 管家：写入计数 + 巡检在途保护

  /** 阶段三⑥：管家自动巡检（写入量 + 时间双驱动，与对话轮数解耦）。
   *  仅在真实沉淀（add/update 成功）后计数；inFlight 防并发双巡检。 */
  const maybeHousekeeping = () => {
    const hk = getCfg().housekeeping ?? {}
    if (hk.enabled === false || hkState.inFlight) return
    hkState.writtenSinceCheck++
    const lastAt = Number(store.getMeta('last_housekeeping_at') ?? 0)
    const due = hkState.writtenSinceCheck >= (hk.interval ?? 20)
      || (Date.now() - lastAt > (hk.maxIntervalHours ?? 24) * 3600 * 1000)
    if (!due) return
    hkState.inFlight = true
    void (async () => {
      try {
        const r = await store.housekeeping({
          dedupThreshold: hk.dedupThreshold ?? 0.92,
          agingDays: hk.agingDays ?? 30,
          dryRun: true,
          limit: 8,
        })
        // 阶段四：事件检测（派生数据全量重建，不碰记忆本体）
        const evCfg = getCfg().events ?? {}
        if (evCfg.enabled !== false) {
          try {
            const evs = store.detectEvents((evCfg.gapHours ?? 2) * 3600 * 1000)
            if (evs.length > 0) console.log(`[dsh-memory] 事件检测: ${evs.length} 个事件（gap ${evCfg.gapHours ?? 2}h）`)
          } catch (err) {
            console.warn(`[dsh-memory] 事件检测失败（不影响主流程）: ${err.message}`)
          }
        }
        // before 边方向修正（派生数据：倒挂边断开重建，历史审计发现的 4/84 方向错误自动自愈）
        try {
          const n = store.fixBeforeDirections()
          if (n > 0) console.log(`[dsh-memory] before 边方向修正: ${n} 条倒挂边已重建`)
        } catch (err) {
          console.warn(`[dsh-memory] before 边修正失败（不影响主流程）: ${err.message}`)
        }
        const notes = []
        if (r.duplicates.length > 0) notes.push(`近重复 ${r.duplicates.length} 对（最高 ${r.duplicates[0].sim}）`)
        if (r.aging.length > 0) notes.push(`老化候选 ${r.aging.length} 条`)
        if (notes.length > 0) console.log(`[dsh-memory] 管家巡检: ${notes.join('，')}（可调用 memory_housekeeping 查看/处理）`)
      } catch (err) {
        console.warn(`[dsh-memory] 管家巡检失败（不影响主流程）: ${err.message}`)
      } finally {
        hkState.writtenSinceCheck = 0
        hkState.inFlight = false
        try { store.setMeta('last_housekeeping_at', Date.now()) } catch { /* 元数据写入失败忽略 */ }
      }
    })()
  }
  ctx.on('session/event', async (session, event) => {
    const cfg = getCfg()
    if (!cfg.features.autoWrite) return
    if (event.type === 'user/message') {
      // 防循环：只缓存真实用户消息（注入/合成上下文不沉淀为记忆原料）
      if (event.data?.source?.kind !== 'user') return
      const text = messageText(event.data)
      if (!text) return
      const turn = event.data.turn ?? 0
      let c = turnCache.get(session.id)
      if (!c || c.turn !== turn) c = { turn, userTexts: [], assistantTexts: [], writtenTurns: new Set() }
      c.userTexts.push(text)
      turnCache.set(session.id, c)
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data.message)
      if (!text) return
      const turn = event.data.turn ?? 0
      let c = turnCache.get(session.id)
      if (!c || c.turn !== turn) c = { turn, userTexts: [], assistantTexts: [], writtenTurns: new Set() }
      c.assistantTexts.push(text)
      turnCache.set(session.id, c)
    } else if (event.type === 'turn/end') {
      try {
      const c = turnCache.get(session.id)
      if (!c) return
      const turn = event.data.turn
      if (c.writtenTurns.has(turn)) return
      c.writtenTurns.add(turn)
      // 阶段二：遗忘曲线低频衰减（每轮一次，惰性幂等）
      try { store.decayExpired() } catch { /* 衰减失败不影响主流程 */ }
      const userPart = c.userTexts.join('\n').trim()
      const assistantPart = c.assistantTexts.at(-1)?.trim() ?? ''
      if (!userPart && !assistantPart) return
      const content = truncate(`任务: ${userPart || '(无显式用户消息)'}\n结果: ${assistantPart || '(无输出)'}`, 2000)
      const keywords = [...tokenize(`${userPart} ${assistantPart}`)].slice(0, 40)
      // 价值门（规则）：无用户消息且无输出 → 跳过；内容过短 → 跳过；
      // 无用户消息的自主轮次 → 仅当输出含成果信号才沉淀（过滤思考中间态噪音）
      if (cfg.features.valueGate) {
        if (!userPart && !assistantPart) return
        if (content.length < 20 && keywords.length === 0) return
        if (!userPart && !OUTCOME_RE.test(assistantPart)) return
      }
      // refiner 开启：LLM 蒸馏有效记忆（异步，失败降级规则路径）
      if (cfg.refiner.enabled) {
        // 价值预判：过短/无实词的低价值轮次不送 LLM（省成本），直接规则路径
        if (content.length < 40 || keywords.length < 3) {
          await upsertMemory(store, cfg.features, { layer: 'ep', scope, content, keywords })
          maybeHousekeeping()
        } else {
          void (async () => {
            try {
              const extracted = await extractWithLlm(ctx, cfg, userPart, assistantPart)
              if (!extracted?.content) throw new Error('LLM 未返回内容')
              await upsertMemory(store, cfg.features, {
                layer: extracted.layer === 'ep' ? 'ep' : 'sm',
                type: extracted.type,
                scope,
                content: truncate(extracted.content, 2000),
                keywords: (extracted.keywords ?? [...tokenize(extracted.content)]).slice(0, 40),
                aspect: extracted.aspect ?? '',
              })
              maybeHousekeeping()
            } catch (err) {
              console.warn(`[dsh-memory] LLM 提取失败，降级规则路径: ${err.message}`)
              await upsertMemory(store, cfg.features, { layer: 'ep', scope, content, keywords })
              maybeHousekeeping()
            }
          })()
        }
      } else {
        await upsertMemory(store, cfg.features, { layer: 'ep', scope, content, keywords })
        maybeHousekeeping()
      }
      } catch (err) {
        console.warn(`[dsh-memory] 写入管线异常（已隔离，不影响 dsh）: ${err.message}`)
      }
    }
  })

// ---------- 阶段二：会话预热 seed（session-start 注入；画像优先——"用户是谁"优先于"最近干了啥"） ----------
ctx.on('agent/session-start', (payload) => {
    try {
      const cfg = getCfg()
      if (!cfg.features.preStepInject || !payload.agent) return
      const seeds = pickPreheatSeeds(store.list({ layer: 'sm', limit: 50 }))
      if (seeds.length === 0) return
      const t = formatNow()
      const lines = [
        `[记忆] 会话预热（当前时间：${t.local} ${t.weekday} · 画像优先的长期记忆，由 dsh-memory 注入）`,
        ...seeds.map((s) => `- [${s.type === 'profile' ? '画像' : s.type}] ${truncate(s.content, 200)}`),
      ]
      payload.agent.inject(
        createUserMessage({
          source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
          content: [{ type: 'text', text: lines.join('\n') }],
        }),
      )
    } catch (err) {
      console.warn(`[dsh-memory] 会话预热失败: ${err.message}`)
    }
  })

  // ---------- 注入侧：pre-step 检索 + 注入（KV 缓存友好） ----------
  const recentInjected = new Map() // agentId -> [memId...]
  const lastSignature = new Map() // agentId -> { hash, step }
  const lastBlockHash = new Map() // agentId -> 注入块 hash
  let currentStep = 0

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const cfg = getCfg()
      if (!cfg.features.preStepInject) return next()
      currentStep++
      const text = extractUserText(payload.messages)
      if (!text) return next()
      const agentId = payload.agent.id
      // 1) 签名去抖：query 与上次相同 → 跳过（不查库不注入）
      const sig = createHash('sha1').update(text.slice(0, 500)).digest('hex')
      const last = lastSignature.get(agentId)
      if (last && last.sig === sig) return next()
      // 2) 步距节流：距上次全量检索不足 stepInterval 步 → 复用（直接跳过本次）
      if (last && currentStep - last.step < cfg.stepInterval) {
        // 中间步不注入（避免注入块抖动），但仍更新节流时间
        return next()
      }
      lastSignature.set(agentId, { sig, step: currentStep })
      // 3) 检索（异步：真嵌入下 query 向量为网络调用）
      const excluded = recentInjected.get(agentId) ?? []
      const hits = await store.search(text, {
        scope,
        limit: 6,
        minScore: cfg.injectMinScore,
        excludeIds: excluded,
      })
      if (hits.length === 0) return next()
      // 4) token 预算：贪心装入
      const budget = cfg.injectMaxTokens
      let used = 0
      const picked = []
      for (const h of hits) {
        const cost = 8 + estimateTokens(h.content)
        if (used + cost > budget && picked.length > 0) break
        picked.push(h)
        used += cost
      }
      if (picked.length === 0) return next()
      // 5) 注入块 hash 去抖：与上次相同 → 不重复注入
      const block = renderInjection(picked, scope)
      const blockHash = createHash('sha1').update(block).digest('hex')
      if (lastBlockHash.get(agentId) === blockHash) return next()
      lastBlockHash.set(agentId, blockHash)
      // 6) 注入（append-only 尾部；form='recall' 溯源）
      payload.agent.inject(
        createUserMessage({
          source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
          content: [{ type: 'text', text: block }],
        }),
      )
      // 7) 防循环窗口
      const window = [...excluded, ...picked.map((h) => h.id)]
      recentInjected.set(agentId, window.slice(-cfg.maxRecentPerAgent))
    } catch (err) {
      console.warn(`[dsh-memory] 注入失败: ${err.message}`)
    }
    return next()
  })

  // ---------- 工具面（注册失败不影响 dsh——单个工具被隔离） ----------
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
    turnCache.clear()
  })
}

/**
 * LLM 蒸馏提取：用独立配置的模型从一轮会话中提炼有效记忆（去噪、自包含）。
 * 输出严格 JSON：{ content, type, layer, keywords }。
 * @returns {Promise<{content: string, type: string, layer: string, keywords: string[]}>}
 */
async function extractWithLlm(ctx, cfg, userPart, assistantPart) {
  const prompt = `你是记忆提取器。从以下一轮对话中提取值得长期记忆的信息。

规则：
1. 只提取有价值内容：决策、结论、偏好、教训、关键事实；忽略寒暄、过程噪音、工具中间输出
2. content 用简洁、自包含的一句话或段落，不包含"用户说/助手说"等元信息
3. type ∈ note | decision | preference | lesson | profile
   - profile = 关于用户本人的稳定信息（身份/习惯/长期偏好/沟通方式/背景），
     例如"用户偏好 X""用户习惯 Y""用户是 Z 背景"——与一次性决策（decision）区分
4. aspect ∈ identity | preference | habit | background | communication_style
   （仅 type=profile 时填写；其他类型填空字符串）
5. layer ∈ sm（长期语义知识）| ep（一次性情景快照）
6. keywords：3-10 个关键词（中英文均可，用于检索）
7. 没有值得记的内容时输出 {"content": ""}

输出严格 JSON（无其他文字、无 markdown 围栏）：
{"content": "...", "type": "decision", "layer": "sm", "keywords": ["..."], "aspect": ""}

对话：
[用户]
${truncate(userPart, 4000)}

[助手]
${truncate(assistantPart, 4000)}`

  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: cfg.refiner.provider,
    model: cfg.refiner.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    system: '你是严格的 JSON 输出器，只输出合法 JSON。',
    maxTokens: cfg.refiner.maxTokens,
  })) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
  }
  const text = chunks.join('').trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = (fence ? fence[1] : text).trim()
  const parsed = JSON.parse(jsonText)
  if (typeof parsed?.content !== 'string') throw new Error('LLM 输出缺少 content')
  const types = ['note', 'decision', 'preference', 'lesson', 'profile']
  const aspects = ['identity', 'preference', 'habit', 'background', 'communication_style']
  const type = types.includes(parsed.type) ? parsed.type : 'note'
  return {
    content: parsed.content,
    type,
    layer: parsed.layer === 'ep' ? 'ep' : 'sm',
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k) => typeof k === 'string').slice(0, 40) : [],
    aspect: type === 'profile' && aspects.includes(parsed.aspect) ? parsed.aspect : '',
  }
}

/** 去重合并：相似记忆（Jaccard >= 0.8）→ 更新而非新建。 */
async function upsertMemory(store, features, entry) {
  // 阶段三：只有语义记忆（sm）进知识图谱——ep 快照是过程噪音，不成节点/边
  const doGraph = features.graph && entry.layer === 'sm'
  if (!features.dedupMerge) {
    await store.add(entry)
    return
  }
  const qTokens = new Set(entry.keywords)
  if (qTokens.size === 0) {
    await store.add(entry)
    return
  }
  // 轻量扫描最近 sm/ep 记忆找相似
  const rows = store.list({ scope: entry.scope, limit: 200 })
  let best = null
  let bestSim = 0
  for (const r of rows) {
    const sim = jaccard(qTokens, new Set(r.keywords))
    if (sim > bestSim) {
      bestSim = sim
      best = r
    }
  }
  let id
  if (best && bestSim >= 0.8) {
    // 注意：store.list() 返回的 keywords 已是数组（DB 里存 JSON 字符串），不能再次 JSON.parse
    id = best.id
    await store.update(best.id, {
      content: best.content.length >= entry.content.length
        ? best.content
        : `${best.content}\n---\n${entry.content}`,
      keywords: [...new Set([...best.keywords, ...entry.keywords])],
      strengthDelta: 0.3,
    })
  } else {
    id = await store.add(entry)
    // 阶段三：similarTo 自动边——相似但未达合并阈值 → 记为去重候选（供管家/merge 决策）
    // v0.9.1：阈值 0.5 → 0.6（0.5 太宽，"同主题≠相似"的糊团边过多）
    if (doGraph && best && bestSim >= 0.6) {
      try { store.linkSimilar(best.id, id, bestSim) } catch { /* 图谱失败不影响主流程 */ }
    }
  }
  if (doGraph && id) {
    // 用 add/update 的返回值建边，避免按时间倒序误取到别的记忆
    store.graphLink(id, entry.keywords.slice(0, 8))
    // 阶段三：before 时间链自动边（同实体跨记忆按时间演化）
    try { store.linkBefore(id) } catch { /* 图谱失败不影响主流程 */ }
  }
  return id
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

/**
 * 图谱快照（记忆级投影）：一记忆一节点 + 记忆间关系边（similarTo/before）。
 * 阶段三⑥（简化）：边直接读 memory_links 表（记忆级边的一等存储），不再经实体图
 * node_memories 映射（删除了 memOf 的实体→记忆回查复杂度）。
 */
function buildGraphSnapshot(store) {
  const mems = store.list({ limit: 1000 }).filter((m) => m.layer === 'sm')
  // 版本数统计（世界线长度：更新过几次 = 版本数 - 1）——四维蠕虫的时间痕迹
  const versionCounts = new Map()
  for (const r of store.db.prepare(
    'SELECT memory_id, COUNT(*) AS c FROM memory_versions GROUP BY memory_id',
  ).all()) {
    versionCounts.set(r.memory_id, r.c)
  }
  // 事件映射（阶段四）：mem -> eventId（GUI 事件筛选/高亮）
  const evMap = store.eventMap()
  const nodes = mems.map((m) => ({
    id: m.id,
    label: m.theme || m.type,
    theme: m.theme || '',
    type: m.type,
    layer: m.layer,
    strength: m.strength,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    versions: versionCounts.get(m.id) ?? 1,   // 版本数（≥1；>1 表示被更新过）
    eventId: evMap.get(m.id) ?? null,          // 所属事件
    content: m.content.slice(0, 160),
  }))
  const edges = []
  const seen = new Set()
  for (const r of store.db.prepare(
    'SELECT from_memory, to_memory, type, weight FROM memory_links WHERE valid_to IS NULL ORDER BY valid_from',
  ).all()) {
    const key = r.type + '|' + r.from_memory + '|' + r.to_memory
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ from: r.from_memory, to: r.to_memory, type: r.type, weight: r.weight })
  }
  const themes = [...new Set(nodes.map((n) => n.theme).filter(Boolean))]
  // 事件列表（阶段四）：GUI 事件筛选下拉数据
  const events = store.events(50).map((e) => ({
    id: e.id,
    label: e.label,
    startAt: e.startAt,
    endAt: e.endAt,
    count: e.members.length,
  }))
  return { stats: store.stats(), themes, nodes, edges, events }
}

/** 注册面向模型的工具。 */
function registerTools(ctx, store, getCfg) {
  // 防崩溃：单个工具 schema 非法只跳过该工具，不炸插件树
  const safeRegister = (tool) => {
    try {
      ctx.tools.register(tool)
      return true
    } catch (err) {
      console.warn('[dsh-memory] 工具 ' + (tool?.name ?? '(匿名)') + ' 注册失败（已跳过）: ' + err.message)
      return false
    }
  }
  const scope = () => getCfg().scope || 'global'

  safeRegister(defineTool({
    name: 'system_now',
    description: '获取当前系统时间（本地时间 + ISO + Unix 毫秒 + 星期 + 时区）。需要知道"现在几点/今天几号"时调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          iso: { type: 'string', required: true },
          unix: { type: 'integer', required: true },
          local: { type: 'string', required: true },
          date: { type: 'string', required: true },
          time: { type: 'string', required: true },
          weekday: { type: 'string', required: true },
          tz: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `当前时间：${value.local} ${value.weekday}（${value.tz}）`,
      }],
    },
    execute() {
      return formatNow()
    },
  }))

  safeRegister(defineTool({
    name: 'memory_add',
    description: '主动写入一条长期记忆（决策/结论/偏好/教训/画像）。模型认为重要时调用；自动写入已覆盖普通轮次，此工具用于显式记录。',
    parameters: {
      content: { type: 'string', required: true, description: '记忆内容（完整、自包含的一句话或段落）' },
      layer: { type: 'string', enum: ['ep', 'sm'], description: '层级：sm=语义长期（默认），ep=情景' },
      type: { type: 'string', enum: ['note', 'decision', 'preference', 'lesson', 'profile'], description: '记忆类型；profile=关于用户本人的稳定信息（身份/习惯/长期偏好/沟通方式）' },
      aspect: { type: 'string', enum: ['identity', 'preference', 'habit', 'background', 'communication_style'], description: '画像子域（仅 type=profile 时有意义）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `记忆已保存: ${value.id} (rev ${value.revision})` }],
    },
    async execute(args) {
      const id = await store.add({
        layer: args.layer ?? 'sm',
        type: args.type ?? 'note',
        scope: scope(),
        content: args.content,
        keywords: [...tokenize(args.content)].slice(0, 40),
        aspect: args.aspect ?? '',
      })
      return { id, revision: 1 }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_search',
    description: '检索历史记忆（关键词+全文混合）。模型觉得上下文不够、需要回忆过往决策/结论/偏好时调用。',
    parameters: {
      query: { type: 'string', required: true, description: '检索内容描述' },
      limit: { type: 'integer', description: '返回条数（默认 5）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                layer: { type: 'string', required: true },
                content: { type: 'string', required: true },
                score: { type: 'number', required: true },
                updated_at: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.results.length === 0) return [{ type: 'text', text: '没有找到相关记忆。' }]
        const lines = value.results.map((r) => `#${r.id} [${r.layer}] (${r.score}) ${r.content.slice(0, 150)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const results = await store.search(args.query, { scope: scope(), limit: args.limit ?? 5, minScore: 0 })
      return {
        results: results.map((r) => ({
          id: r.id,
          layer: r.layer,
          content: r.content,
          score: r.score,
          updated_at: r.updated_at,
        })),
      }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_forget',
    description: '忘记（删除）一条记忆。用户要求删除/隐私场景使用。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆 id（如 mem-xxxx）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.ok ? '已删除该记忆。' : '未找到该记忆。' }],
    },
    execute(args) {
      return { ok: store.forget(args.id) }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_list',
    description: '列出记忆库中的记忆（可按 scope/layer 过滤）。',
    parameters: {
      layer: { type: 'string', enum: ['ep', 'sm'], description: '按层级过滤' },
      limit: { type: 'integer', description: '条数（默认 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                layer: { type: 'string', required: true },
                type: { type: 'string', required: true },
                content: { type: 'string', required: true },
                theme: { type: 'string', required: true },
                updated_at: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.memories.length === 0) return [{ type: 'text', text: '记忆库为空。' }]
        const lines = value.memories.map((r) => {
          const th = r.theme ? '[' + r.theme + '] ' : ''
          return `#${r.id} [${r.layer}/${r.type}] ${th}${r.content.slice(0, 110)}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args) {
      const rows = store.list({ scope: scope(), layer: args.layer, limit: args.limit ?? 20 })
      return {
        memories: rows.map((r) => ({
          id: r.id,
          layer: r.layer,
          type: r.type,
          content: r.content,
          theme: r.theme ?? '',
          updated_at: r.updated_at,
        })),
      }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_stats',
    description: '查看记忆库统计信息（条数/分层/版本/图谱规模）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stats: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              memories: { type: 'integer', required: true },
              layers: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  ep: { type: 'integer', required: true },
                  sm: { type: 'integer', required: true },
                },
              },
              versions: { type: 'integer', required: true },
              nodes: { type: 'integer', required: true },
              edges: { type: 'integer', required: true },
              timeDimension: { type: 'boolean', required: true },
              vector: { type: 'boolean', required: true },
              rerank: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.stats, null, 2) }],
    },
    execute() {
      return { stats: store.stats() }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_graph_communities',
    description: '检测/查看图谱社区（自动聚类），返回社区列表与成员。',
    parameters: {
      detect: { type: 'boolean', description: '重新运行社区检测（默认 false=读现有结果）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          communities: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                members: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.communities.length === 0) return [{ type: 'text', text: '暂无社区（图谱开关开启、有足够节点后检测）。' }]
        const lines = value.communities.map((c) => `  [${c.label}] ${c.members.join('、')}`)
        return [{ type: 'text', text: `图谱社区（${value.communities.length} 个）：\n${lines.join('\n')}` }]
      },
    },
    execute(args) {
      if (args.detect) store.detectCommunities()
      return { communities: store.communities().map((c) => ({ id: c.id, label: c.label, members: c.members })) }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_merge',
    description: '合并两条相似记忆：source 的内容并入 target，source 被删除。',
    parameters: {
      targetId: { type: 'string', required: true, description: '保留的记忆 id' },
      sourceId: { type: 'string', required: true, description: '被合并（删除）的记忆 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已合并到 ${value.id}（rev ${value.revision}）` }],
    },
    async execute(args) {
      const a = store.get(args.targetId)
      const b = store.get(args.sourceId)
      if (!a) throw new Error(`target ${args.targetId} not found`)
      if (!b) throw new Error(`source ${args.sourceId} not found`)
      const merged = a.content.length + b.content.length > 2000
        ? `${a.content}\n---\n${b.content}`.slice(0, 2000)
        : `${a.content}\n---\n${b.content}`
      const result = await store.update(args.targetId, {
        content: merged,
        keywords: [...new Set([...a.keywords, ...b.keywords])].slice(0, 60),
        strengthDelta: 0.3,
      })
      store.forget(args.sourceId)
      return result
    },
  }))

  safeRegister(defineTool({
    name: 'memory_purge',
    description: '清空某作用域（或全部）的记忆。隐私/重置场景，不可撤销。',
    parameters: {
      scope: { type: 'string', description: '作用域名；省略 = 清空全部' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已删除 ${value.removed} 条记忆。` }],
    },
    execute(args) {
      return { removed: store.purge(args.scope || undefined) }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_housekeeping',
    description: '记忆管家巡检：全局去重扫描（余弦近重复候选）+ 老化报告（长期未访问的低价值记忆）。dryRun=false 时自动合并相似度 ≥0.95 的几乎重复对（强度高者保留）。只报告不删数据是默认安全行为。',
    parameters: {
      dryRun: { type: 'boolean', description: 'true=只报告不执行（默认）；false=自动合并近重复对' },
      minSimilarity: { type: 'number', description: '去重相似度阈值（0.8~0.99，默认 0.92）' },
      agingDays: { type: 'integer', description: '老化报告天数（默认 30）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          duplicates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                a: { type: 'string', required: true },
                b: { type: 'string', required: true },
                sim: { type: 'number', required: true },
                aContent: { type: 'string', required: true },
                bContent: { type: 'string', required: true },
              },
            },
          },
          aging: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                layer: { type: 'string', required: true },
                type: { type: 'string', required: true },
                content: { type: 'string', required: true },
                strength: { type: 'number', required: true },
                idleDays: { type: 'integer', required: true },
              },
            },
          },
          merged: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.duplicates.length === 0 && value.aging.length === 0) {
          lines.push('记忆库健康：无近重复、无老化候选。')
        }
        if (value.duplicates.length > 0) {
          lines.push(`近重复候选（${value.duplicates.length} 对）：`)
          for (const d of value.duplicates) {
            lines.push(`  ${d.sim.toFixed(2)} | ${d.a} ⇄ ${d.b}\n    ${d.aContent.slice(0, 60)}\n    ${d.bContent.slice(0, 60)}`)
          }
        }
        if (value.aging.length > 0) {
          lines.push(`老化候选（${value.aging.length} 条，闲置 ${value.aging[0].idleDays} 天起）：`)
          for (const a of value.aging) {
            lines.push(`  [${a.layer}/${a.type}] str ${a.strength.toFixed(2)} 闲置 ${a.idleDays} 天 | ${a.content.slice(0, 80)}`)
          }
        }
        if (value.merged > 0) lines.push(`已自动合并 ${value.merged} 对近重复（dryRun=false）。`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      return await store.housekeeping({
        dedupThreshold: args.minSimilarity ?? 0.92,
        agingDays: args.agingDays ?? 30,
        dryRun: args.dryRun !== false,
      })
    },
  }))

  safeRegister(defineTool({
    name: 'memory_events',
    description: '列出记忆事件（时间连续 + 因果相关的记忆聚簇，如"一次开发会话""一个版本迭代"）。事件由管家自动检测（时间线扫描），detect=true 可强制重新检测。',
    parameters: {
      limit: { type: 'integer', description: '返回事件数（默认 10）' },
      detect: { type: 'boolean', description: 'true=立即重新检测事件（默认 false 读现有结果）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          events: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                startAt: { type: 'integer', required: true },
                endAt: { type: 'integer', required: true },
                count: { type: 'integer', required: true },
                members: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      content: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.events.length === 0) return [{ type: 'text', text: '暂无事件（管家巡检后自动检测，或用 detect=true 强制检测）。' }]
        const lines = value.events.map((e) => {
          const span = new Date(e.startAt).toLocaleDateString('zh-CN') + '~' + new Date(e.endAt).toLocaleDateString('zh-CN')
          return `【${e.label}】${span}（${e.count} 条）\n` + e.members.slice(0, 6).map((m) => `    · ${m.content.slice(0, 60)}`).join('\n')
        })
        return [{ type: 'text', text: `记忆事件（${value.events.length} 个）：\n${lines.join('\n')}` }]
      },
    },
    execute(args) {
      if (args.detect) {
        const evCfg = getCfg().events ?? {}
        store.detectEvents((evCfg.gapHours ?? 2) * 3600 * 1000)
      }
      const evs = store.events(args.limit ?? 10)
      return {
        events: evs.map((e) => ({
          id: e.id,
          label: e.label,
          startAt: e.startAt,
          endAt: e.endAt,
          count: e.members.length,
          members: e.members.map((m) => ({ id: m.id, content: m.content })),
        })),
      }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_profile_distill',
    description: '画像蒸馏：把散落的偏好/决策类记忆聚合为关于用户本人的稳定画像条目（type=profile + aspect 子域）。需 refiner 启用（LLM 聚合）。',
    parameters: {
      limit: { type: 'integer', description: '聚合的源记忆数（默认 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profiles: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                aspect: { type: 'string', required: true },
                content: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.profiles.length === 0) return [{ type: 'text', text: '未蒸馏出新的画像条目（源记忆中没有稳定的人物属性）。' }]
        const lines = value.profiles.map((p) => `  [${p.aspect}] ${p.content.slice(0, 100)}`)
        return [{ type: 'text', text: `画像蒸馏完成（${value.profiles.length} 条）：\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      const cfg = getCfg()
      if (!cfg.refiner?.enabled) throw new Error('refiner 未启用：画像蒸馏依赖 LLM 聚合（在设置面板开启独立提取模型）')
      const candidates = store.list({ layer: 'sm', limit: args.limit ?? 20 })
        .filter((m) => m.type !== 'profile' && (m.type === 'preference' || m.type === 'decision'))
      if (candidates.length === 0) return { profiles: [] }
      const prompt = `你是画像蒸馏器。从以下记忆条目中提取"关于用户本人的稳定信息"，聚合成画像条目。

输入条目（每行一条）：
${candidates.map((m) => `- ${m.content.slice(0, 200)}`).join('\n')}

规则：
1. 只保留稳定的人物属性：身份、长期偏好、习惯、沟通方式、背景
2. 忽略一次性决策、项目进展、技术细节（那些不是画像）
3. 相同属性合并成一条（不要重复画像）
4. 输出 JSON 数组：{"items": [{"content": "...", "aspect": "identity|preference|habit|background|communication_style"}]}
5. 没有画像内容时输出 {"items": []}`

      const chunks = []
      for await (const chunk of ctx.llm.stream({
        provider: cfg.refiner.provider,
        model: cfg.refiner.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        system: '你是严格的 JSON 输出器，只输出合法 JSON。',
        maxTokens: cfg.refiner.maxTokens,
      })) {
        if (chunk.type === 'text-delta') chunks.push(chunk.text)
      }
      const text = chunks.join('').trim()
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
      const parsed = JSON.parse((fence ? fence[1] : text).trim())
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      const aspects = new Set(['identity', 'preference', 'habit', 'background', 'communication_style'])
      const profiles = []
      for (const it of items) {
        if (typeof it?.content !== 'string' || !it.content.trim()) continue
        const aspect = aspects.has(it.aspect) ? it.aspect : 'preference'
        const id = await store.add({
          layer: 'sm',
          type: 'profile',
          scope: scope(),
          content: truncate(it.content.trim(), 500),
          keywords: [...tokenize(it.content)].slice(0, 20),
          aspect,
        })
        profiles.push({ id, aspect, content: it.content.trim().slice(0, 500) })
      }
      return { profiles }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_graph_neighbors',
    description: '查询一条记忆的图谱邻域（k-hop 扩散）：返回相关实体节点与跳数。',
    parameters: {
      memoryId: { type: 'string', required: true, description: '记忆 id（如 mem-xxxx）' },
      hops: { type: 'integer', description: '扩散跳数（默认 2）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                label: { type: 'string', required: true },
                depth: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.nodes.length === 0) return [{ type: 'text', text: '该记忆没有关联节点（图谱开关开启且写入后才有）。' }]
        const lines = value.nodes.map((n) => `  [${n.depth}跳] ${n.label} (${n.kind})`)
        return [{ type: 'text', text: `图谱邻域（${value.nodes.length} 个节点）：\n${lines.join('\n')}` }]
      },
    },
    execute(args) {
      const nodes = store.memoryNeighbors(args.memoryId, args.hops ?? 2)
      return {
        nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, depth: n.depth })),
      }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_versions',
    description: '查看一条记忆的世界线版本链（各 revision 的内容摘要与有效区间），供回滚前选择目标版本。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆 id（如 mem-xxxx）' },
      limit: { type: 'integer', description: '版本数（默认 10）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          versions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                revision: { type: 'integer', required: true },
                content: { type: 'string', required: true },
                valid_from: { type: 'integer', required: true },
                active: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.versions.length === 0) return [{ type: 'text', text: '该记忆没有版本链（time 开关关闭或记忆刚创建）。' }]
        const lines = value.versions.map((v) => {
          const mark = v.active ? '【活跃】' : '（已隐藏）'
          return `  rev ${v.revision} ${mark} ${truncate(v.content, 80)}`
        })
        return [{ type: 'text', text: `世界线版本（${value.versions.length} 段）：\n${lines.join('\n')}` }]
      },
    },
    execute(args) {
      const versions = store.versions(args.id, args.limit ?? 10).map((v) => ({
        revision: v.revision,
        content: v.content,
        valid_from: v.valid_from,
        active: v.valid_to === null,
      }))
      return { versions }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_rollback',
    description: '把一条记忆回滚到指定历史版本（世界线时间旅行）：目标版本重新激活为当前内容，旧版不销毁。先用 memory_versions 查看版本号。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆 id（如 mem-xxxx）' },
      revision: { type: 'integer', required: true, description: '目标版本号（来自 memory_versions）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          restoredFrom: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已回滚 ${value.id}：rev ${value.revision} 恢复自 rev ${value.restoredFrom}（世界线未销毁，可再次回滚）` }],
    },
    async execute(args) {
      return await store.rollback(args.id, args.revision)
    },
  }))

  safeRegister(defineTool({
    name: 'memory_graph_path',
    description: '查询图谱上两个节点之间的最短路径（BFS，正向+反向边），返回节点序列与边类型链。节点 id 可从 memory_graph_neighbors 获得。',
    parameters: {
      fromId: { type: 'string', required: true, description: '起始节点 id（如 n-xxxx）' },
      toId: { type: 'string', required: true, description: '目标节点 id' },
      maxLen: { type: 'integer', description: '最大跳数（默认 6）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          nodes: { type: 'array', required: true, items: { type: 'string' } },
          edges: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (!value.found) return [{ type: 'text', text: '两节点之间没有路径。' }]
        const steps = value.nodes.map((n, i) => (i === 0 ? n : ' --' + value.edges[i - 1] + '--> ' + n))
        return [{ type: 'text', text: '最短路径：\n' + steps.join('\n') }]
      },
    },
    execute(args) {
      const p = store.path(args.fromId, args.toId, args.maxLen ?? 6)
      return { found: p !== null, nodes: p?.nodes ?? [], edges: p?.edges ?? [] }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_graph_link',
    description: '手动连边：在两条记忆的图谱节点之间建立语义关系边（8 型：mentions/partOf/similarTo/causes/solves/before/supports/contradicts）。',
    parameters: {
      memoryAId: { type: 'string', required: true, description: '源记忆 id（如 mem-xxxx）' },
      memoryBId: { type: 'string', required: true, description: '目标记忆 id' },
      type: { type: 'string', required: true, enum: ['mentions', 'partOf', 'similarTo', 'causes', 'solves', 'before', 'supports', 'contradicts'], description: '边类型（8 型语义：因果 causes/solves、时间 before、佐证 supports、翻案 contradicts 等）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: '已建立 ' + value.created + ' 条边（幂等：重复连边不叠加）。' }],
    },
    execute(args) {
      return { created: store.link(args.memoryAId, args.memoryBId, args.type) }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_graph_unlink',
    description: '断开两条记忆之间的语义关系边（valid_to 置为当前时间，历史保留不销毁）。',
    parameters: {
      memoryAId: { type: 'string', required: true, description: '源记忆 id' },
      memoryBId: { type: 'string', required: true, description: '目标记忆 id' },
      type: { type: 'string', required: true, enum: ['mentions', 'partOf', 'similarTo', 'causes', 'solves', 'before', 'supports', 'contradicts'], description: '要断开的边类型' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: '已断开 ' + value.removed + ' 条边（旧边保留在历史，可审计）。' }],
    },
    execute(args) {
      return { removed: store.unlink(args.memoryAId, args.memoryBId, args.type) }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_graph_node',
    description: '查看一个图谱节点的详情：类型、标签、所属记忆、直接邻域。节点 id 可从 memory_graph_neighbors 获得。',
    parameters: {
      nodeId: { type: 'string', required: true, description: '节点 id（如 n-xxxx）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              label: { type: 'string', required: true },
              memoryId: { type: 'string' },
              created_at: { type: 'integer', required: true },
            },
          },
          neighbors: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (!value.node) return [{ type: 'text', text: '节点不存在。' }]
        const nb = value.neighbors.length === 0 ? '（无邻域）' : value.neighbors.join('、')
        return [{ type: 'text', text: '节点 ' + value.node.id + ' [' + value.node.kind + '] ' + value.node.label + '\n  所属记忆: ' + (value.node.memoryId ?? '—') + '\n  邻域: ' + nb }]
      },
    },
    execute(args) {
      const node = store.getNode(args.nodeId)
      return {
        node: node ? { id: node.id, kind: node.kind, label: node.label, memoryId: node.memory_id ?? '', created_at: node.created_at } : null,
        neighbors: node ? store.neighbors(node.id).map((n) => n.id) : [],
      }
    },
  }))

  safeRegister(defineTool({
    name: 'memory_reembed',
    description: '用当前嵌入模型重算缺失向量（维度迁移或嵌入失败后的补写）。返回完成/剩余条数。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          done: { type: 'integer', required: true },
          pending: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: '重嵌入完成 ' + value.done + ' 条' + (value.pending > 0 ? '，剩余 ' + value.pending + ' 条' : '') }],
    },
    async execute() {
      const r = await store.reembedMissing()
      return { done: r.done, pending: r.pending ?? 0 }
    },
  }))
}

