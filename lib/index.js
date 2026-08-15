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
  /** 注入最低分数 */
  injectMinScore: z.number().min(0).max(10).default(0.2),
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
})

/** 估算文本 token 数（中文按字、英文按 4 字符，粗略）。 */
function estimateTokens(text) {
  let n = 0
  for (const seg of text.matchAll(/[\u4e00-\u9fff]/g)) n++ // 每中文字 ~1 token
  const rest = text.replace(/[\u4e00-\u9fff]/g, '')
  n += Math.ceil(rest.length / 4)
  return n
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

export function apply(ctx, config) {
  // 配置三源合一：schema 默认值 ← 组合层（cordis.patch.yml 的 config，作为 base）
  // ← 用户层（GUI 设置写入 settings.yaml 的 memory 命名空间）。
  // 注册后 GUI 卡片与 host 插件读写同一文档，改动 live 生效。
  let settingsScope
  try {
    settingsScope = ctx.settings.register(settingsNamespace('memory'), Config, {
      base: config,
      applies: 'live',
    })
  } catch (err) {
    throw err
  }
  const getCfg = () => settingsScope.get()
  if (!getCfg().enabled) {
    return
  }

  const dbFile = getCfg().dbFile || join(homedir(), '.dsh', 'memory.db')
  const scope = getCfg().scope || 'global'
  const store = new MemoryStore(dbFile, {
    time: getCfg().features.time,
    maxVersions: getCfg().maxVersionsPerMemory,
  })

  // ---------- 迁移：存量 auto-memory.json 一键导入 ----------
  migrateLegacy(store, getCfg().features.time)

  // ---------- 写入侧：缓存消息文本，turn/end 沉淀 + 价值门 + 去重 ----------
  const turnCache = new Map() // sessionId -> { turn, userTexts, assistantTexts, writtenTurns }
  ctx.on('session/event', (session, event) => {
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
      const c = turnCache.get(session.id)
      if (!c) return
      const turn = event.data.turn
      if (c.writtenTurns.has(turn)) return
      c.writtenTurns.add(turn)
      const userPart = c.userTexts.join('\n').trim()
      const assistantPart = c.assistantTexts.at(-1)?.trim() ?? ''
      if (!userPart && !assistantPart) return
      const content = truncate(`任务: ${userPart || '(无显式用户消息)'}\n结果: ${assistantPart || '(无输出)'}`, 2000)
      const keywords = [...tokenize(`${userPart} ${assistantPart}`)].slice(0, 40)
      // 价值门（规则）：无用户消息且无输出 → 跳过；内容过短 → 跳过
      if (cfg.features.valueGate) {
        if (!userPart && !assistantPart) return
        if (content.length < 20 && keywords.length === 0) return
      }
      // refiner 开启：LLM 蒸馏有效记忆（异步，失败降级规则路径）
      if (cfg.refiner.enabled) {
        void (async () => {
          try {
            const extracted = await extractWithLlm(ctx, cfg, userPart, assistantPart)
            if (!extracted?.content) throw new Error('LLM 未返回内容')
            upsertMemory(store, cfg.features, {
              layer: extracted.layer === 'ep' ? 'ep' : 'sm',
              type: extracted.type,
              scope,
              content: truncate(extracted.content, 2000),
              keywords: (extracted.keywords ?? [...tokenize(extracted.content)]).slice(0, 40),
            })
          } catch (err) {
            console.warn(`[dsh-memory] LLM 提取失败，降级规则路径: ${err.message}`)
            upsertMemory(store, cfg.features, { layer: 'ep', scope, content, keywords })
          }
        })()
      } else {
        upsertMemory(store, cfg.features, { layer: 'ep', scope, content, keywords })
      }
    }
  })

  // ---------- 注入侧：pre-step 检索 + 注入（KV 缓存友好） ----------
  const recentInjected = new Map() // agentId -> [memId...]
  const lastSignature = new Map() // agentId -> { hash, step }
  const lastBlockHash = new Map() // agentId -> 注入块 hash
  let currentStep = 0

  ctx.on('agent/pre-step', (payload, next) => {
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
      // 3) 检索
      const excluded = recentInjected.get(agentId) ?? []
      const hits = store.search(text, {
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

  // ---------- 工具面 ----------
  if (getCfg().features.manageTools) {
    registerTools(ctx, store, getCfg)
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
3. type ∈ note | decision | preference | lesson
4. layer ∈ sm（长期语义知识）| ep（一次性情景快照）
5. keywords：3-10 个关键词（中英文均可，用于检索）
6. 没有值得记的内容时输出 {"content": ""}

输出严格 JSON（无其他文字、无 markdown 围栏）：
{"content": "...", "type": "decision", "layer": "sm", "keywords": ["..."]}

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
  return {
    content: parsed.content,
    type: ['note', 'decision', 'preference', 'lesson'].includes(parsed.type) ? parsed.type : 'note',
    layer: parsed.layer === 'ep' ? 'ep' : 'sm',
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k) => typeof k === 'string').slice(0, 40) : [],
  }
}

/** 去重合并：相似记忆（Jaccard >= 0.8）→ 更新而非新建。 */
function upsertMemory(store, features, entry) {
  if (!features.dedupMerge) {
    store.add(entry)
    return
  }
  const qTokens = new Set(entry.keywords)
  if (qTokens.size === 0) {
    store.add(entry)
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
  if (best && bestSim >= 0.8) {
    store.update(best.id, {
      content: best.content.length >= entry.content.length
        ? best.content
        : `${best.content}\n---\n${entry.content}`,
      keywords: [...new Set([...JSON.parse(best.keywords), ...entry.keywords])],
      strengthDelta: 0.3,
    })
  } else {
    store.add(entry)
  }
  if (features.graph) {
    const entities = entry.keywords.slice(0, 5)
    const id = store.list({ scope: entry.scope, limit: 1 })[0]?.id
    if (id) store.graphLink(id, entities)
  }
}

/** 存量 auto-memory.json 迁移（幂等：库为空且旧文件存在才导入）。 */
function migrateLegacy(store, time) {
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
      store.add({
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

/** 注册面向模型的工具。 */
function registerTools(ctx, store, getCfg) {
  const scope = () => getCfg().scope || 'global'

  ctx.tools.register(defineTool({
    name: 'memory_add',
    description: '主动写入一条长期记忆（决策/结论/偏好/教训）。模型认为重要时调用；自动写入已覆盖普通轮次，此工具用于显式记录。',
    parameters: {
      content: { type: 'string', required: true, description: '记忆内容（完整、自包含的一句话或段落）' },
      layer: { type: 'string', enum: ['ep', 'sm'], description: '层级：sm=语义长期（默认），ep=情景' },
      type: { type: 'string', enum: ['note', 'decision', 'preference', 'lesson'], description: '记忆类型' },
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
    execute(args) {
      const id = store.add({
        layer: args.layer ?? 'sm',
        type: args.type ?? 'note',
        scope: scope(),
        content: args.content,
        keywords: [...tokenize(args.content)].slice(0, 40),
      })
      return { id, revision: 1 }
    },
  }))

  ctx.tools.register(defineTool({
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
    execute(args) {
      const results = store.search(args.query, { scope: scope(), limit: args.limit ?? 5, minScore: 0 })
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

  ctx.tools.register(defineTool({
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

  ctx.tools.register(defineTool({
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
                updated_at: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.memories.length === 0) return [{ type: 'text', text: '记忆库为空。' }]
        const lines = value.memories.map((r) => `#${r.id} [${r.layer}/${r.type}] ${r.content.slice(0, 120)}`)
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
          updated_at: r.updated_at,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: '查看记忆库统计信息（条数/分层/版本/图谱规模）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stats: { type: 'object', required: true, additionalProperties: false },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.stats, null, 2) }],
    },
    execute() {
      return { stats: store.stats() }
    },
  }))
}

