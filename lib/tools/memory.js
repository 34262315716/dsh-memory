/**
 * 工具域：记忆 CRUD 与维护（add/search/forget/list/stats/merge/purge/reembed）。
 * 原 registerTools 拆分（v0.10 解耦）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '../util.js'
import { pickKeywords } from '../refiner.js'
import { makeSafeRegister, makeLogStore } from './shared.js'

export function registerMemoryTools(ctx, store, getCfg) {
  const safeRegister = makeSafeRegister(ctx)
  const logStore = makeLogStore(store, getCfg)
  safeRegister(defineTool({
    name: 'memory_add',
    description: '主动写入一条长期记忆（决策/结论/偏好/教训/画像）。模型认为重要时调用；自动写入已覆盖普通轮次，此工具用于显式记录。写入时会自动过滤关键词、并入知识图谱（与自动提取同一套连接逻辑）。',
    parameters: {
      content: { type: 'string', required: true, description: '记忆内容（完整、自包含的一句话或段落）' },
      layer: { type: 'string', enum: ['ep', 'sm'], description: '层级：sm=语义长期（默认），ep=情景' },
      type: { type: 'string', enum: ['note', 'decision', 'preference', 'lesson', 'profile'], description: '记忆类型；profile=关于用户本人的稳定信息（身份/习惯/长期偏好/沟通方式）' },
      aspect: { type: 'string', enum: ['identity', 'preference', 'habit', 'background', 'communication_style'], description: '画像子域（仅 type=profile 时有意义）' },
      abstract: { type: 'string', enum: ['principle', 'event'], description: '抽象层级：principle=可复用的原则/方法（注入优先 ×1.5）｜event=一次性事件产出（×0.7）。不填则注入路径不加权' },
      theme: { type: 'string', description: '主题名词标签（2-8 字，如"四级备考"/"AI绘画"），用于主题聚类与图谱着色；不确定可留空' },
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
    async execute(args, exec) {
      // 工具写入按调用 agent 的会话工作目录分层（v0.9.4）；profile 固定 global
      const toolScope = args.type === 'profile' ? 'global' : scopeOf(exec?.agent, ctx?.workspaceRegistry)
      const layer = args.layer ?? 'sm'
      const type = args.type ?? 'note'
      const content = String(args.content ?? '').trim()
      // v0.12.0：工具写入过去是「孤岛」——实测 41 条 tool.add 记忆**全部**无图节点、无任何连边，
      // 而自动提取路径有 57% 连上了边，根因就是这里只调 store.add、没走图谱那只手
      // （连同关键词都用 tokenize 的 2-gram 碎片兜底）。现在与自动路径对齐：同一套关键词过滤
      // + 同一组连边 + 同一套 abstract/theme 维度。
      const keywords = pickKeywords(content, 40)
      const id = await store.add({
        layer,
        type,
        scope: toolScope,
        content,
        keywords,
        aspect: args.aspect ?? '',
        abstract: args.abstract ?? '',
        theme: typeof args.theme === 'string' ? args.theme.trim().replace(/\s+/g, ' ').slice(0, 30) : '',
      })
      // 图谱连边：仅 sm（与 pipelines/write.js 的 upsertMemory 同一口径：ep 快照是过程噪音，不成节点）
      try {
        if (getCfg()?.features?.graph && layer === 'sm') {
          store.graphLink(id, keywords)
          store.linkBefore(id)
          store.linkSemantic(id)
        }
      } catch { /* 图谱失败不影响记忆落库 */ }
      logStore('info', 'tool.add', {
        id, type, scope: toolScope, content: content.slice(0, 80),
        keywords: keywords.length, abstract: args.abstract ?? '', theme: args.theme ?? '',
      }, toolScope)
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
                type: { type: 'string', required: true },
                content: { type: 'string', required: true },
                score: { type: 'number', required: true },
                aspect: { type: 'string', required: true },
                updated_at: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.results.length === 0) return [{ type: 'text', text: '没有找到相关记忆。' }]
        const lines = value.results.map((r) => {
          const asp = r.aspect ? `(${r.aspect}) ` : ''
          return `#${r.id} [${r.layer}/${r.type}] (${r.score}) ${asp}${r.content.slice(0, 150)}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const results = await store.search(args.query, {
        scope: [scopeOf(exec?.agent, ctx?.workspaceRegistry), 'global'],
        limit: args.limit ?? 5,
        minScore: 0,
      })
      logStore('info', 'tool.search', { query: args.query.slice(0, 80), hits: results.length, ids: results.slice(0, 5).map((r) => r.id) })
      return {
        results: results.map((r) => ({
          id: r.id,
          layer: r.layer,
          type: r.type,
          content: r.content,
          score: r.score,
          aspect: r.profile_aspect ?? '',
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
    description: '列出记忆库中的记忆（可按 scope/layer/type 过滤）。',
    parameters: {
      layer: { type: 'string', enum: ['ep', 'sm'], description: '按层级过滤' },
      type: { type: 'string', enum: ['note', 'decision', 'preference', 'lesson', 'profile'], description: '按类型过滤（profile=用户画像）' },
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
                aspect: { type: 'string', required: true },
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
          const asp = r.aspect ? `(${r.aspect}) ` : ''
          return `#${r.id} [${r.layer}/${r.type}] ${asp}${th}${r.content.slice(0, 110)}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const rows = store.list({ scope: [scopeOf(exec?.agent, ctx?.workspaceRegistry), 'global'], layer: args.layer, type: args.type, limit: args.limit ?? 20 })
      return {
        memories: rows.map((r) => ({
          id: r.id,
          layer: r.layer,
          type: r.type,
          content: r.content,
          theme: r.theme ?? '',
          aspect: r.profile_aspect ?? '',
          updated_at: r.updated_at,
        })),
      }
    },
  }))
  // ── 常驻记忆（v0.13.0）：恒定注入通道 ─────────────────────────────
  safeRegister(defineTool({
    name: 'memory_pin',
    description: '钉选/取消钉选「常驻记忆」：被钉选的记忆会**恒定注入**到每一步（不走检索、不看得分、不受节流），用于珍贵教训与铁律——"一直在场，而不是讲到才出现"。省略 id 则只查看当前常驻清单。',
    parameters: {
      id: { type: 'string', description: '记忆 id（如 mem-xxxx）；省略则只查看常驻清单' },
      pinned: { type: 'boolean', description: 'true=钉选（默认）；false=取消钉选' },
      limit: { type: 'integer', description: '返回清单条数（默认 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          id: { type: 'string' },
          count: { type: 'integer', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                abstract: { type: 'string', required: true },
                content: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        const head = v.action === 'pin' ? `已钉选 ${v.id}（此后恒定注入）`
          : v.action === 'unpin' ? `已取消钉选 ${v.id}`
            : v.action === 'not-found' ? `未找到记忆 ${v.id}` : '常驻记忆清单'
        if (v.items.length === 0) return [{ type: 'text', text: `${head}：当前没有常驻记忆。` }]
        return [{
          type: 'text',
          text: [head + `（当前常驻 ${v.count} 条，恒定注入）`, ...v.items.map((r) => `- #${r.id} [${r.type}] ${r.content.slice(0, 120)}`)].join('\n'),
        }]
      },
    },
    execute(args) {
      const take = () => store.listPinned({ limit: args.limit ?? 20 }).map((r) => ({
        id: r.id, type: r.type, abstract: r.abstract ?? '', content: r.content,
      }))
      if (!args.id) return { ok: true, action: 'list', count: store.pinnedCount(), items: take() }
      const on = args.pinned !== false
      const changed = store.setPinned(args.id, on)
      logStore('info', on ? 'pin.on' : 'pin.off', { id: args.id, changed })
      return {
        ok: changed,
        id: args.id,
        action: changed ? (on ? 'pin' : 'unpin') : 'not-found',
        count: store.pinnedCount(),
        items: take(),
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
              archived: { type: 'integer', required: true },
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
              // v0.12.1 补齐：v0.11.1 加入 stats() 的这四个字段此前没进 schema
              // （工具声明 additionalProperties: false —— 声明缺失就可能让整次调用被校验拦下）
              vecDim: { type: 'integer' },
              vecRows: { type: 'integer' },
              embedder: { type: 'string' },
              degraded: { type: 'boolean' },
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
