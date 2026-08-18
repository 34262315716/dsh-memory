/**
 * 工具域：记忆 CRUD 与维护（add/search/forget/list/stats/merge/purge/reembed）。
 * 原 registerTools 拆分（v0.10 解耦）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '../util.js'
import { tokenize } from '../store.js'
import { makeSafeRegister, makeLogStore } from './shared.js'

export function registerMemoryTools(ctx, store, getCfg) {
  const safeRegister = makeSafeRegister(ctx)
  const logStore = makeLogStore(store, getCfg)
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
    async execute(args, exec) {
      // 工具写入按调用 agent 的会话工作目录分层（v0.9.4）；profile 固定 global
      const toolScope = args.type === 'profile' ? 'global' : scopeOf(exec?.agent, ctx?.workspaceRegistry)
      const id = await store.add({
        layer: args.layer ?? 'sm',
        type: args.type ?? 'note',
        scope: toolScope,
        content: args.content,
        keywords: [...tokenize(args.content)].slice(0, 40),
        aspect: args.aspect ?? '',
      })
      logStore('info', 'tool.add', { id, type: args.type ?? 'note', scope: toolScope, content: args.content.slice(0, 80) }, toolScope)
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
