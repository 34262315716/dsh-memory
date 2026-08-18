/**
 * 工具域：记忆图谱（communities/neighbors/versions/rollback/path/link/unlink/node）。
 * 原 registerTools 拆分（v0.10 解耦）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { truncate } from '../util.js'
import { makeSafeRegister } from './shared.js'

export function registerGraphTools(ctx, store, getCfg) {
  const safeRegister = makeSafeRegister(ctx)
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
}
