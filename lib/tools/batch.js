/**
 * 工具域：批量提取（v0.20.0）。
 *
 * 候选池是「碎片先进池、攒够才归纳」的中间态。没有观测入口的话，
 * 出了问题时（比如候选一直攒不满、或归纳一直失败）界面上完全看不出来。
 * 这个工具补那个洞。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeSafeRegister } from './shared.js'

export function registerBatchTools(ctx, store, getCfg) {
  const safeRegister = makeSafeRegister(ctx)

  safeRegister(defineTool({
    name: 'memory_batch_status',
    description: '查看批量提取（候选池）的状态：攒了多少候选、哪些桶快够门槛、最近归纳了什么。排查"记忆为什么没写进来"时用。',
    parameters: {
      buckets: { type: 'integer', description: '列出多少个待归纳的桶（默认 10）' },
      limit: { type: 'integer', description: '列出多少条候选（默认 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          idleHours: { type: 'number', required: true },
          total: { type: 'integer', required: true },
          pending: { type: 'integer', required: true },
          promoted: { type: 'integer', required: true },
          buckets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                signature: { type: 'string', required: true },
                n: { type: 'integer', required: true },
                sessions: { type: 'integer', required: true },
                need: { type: 'integer', required: true },
              },
            },
          },
          recent: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                theme: { type: 'string', required: true },
                content: { type: 'string', required: true },
                session: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        const lines = []
        lines.push(`批量提取：${v.enabled ? '开启' : '关闭'}（静置 ${v.idleHours} 小时无新消息触发）`)
        lines.push(`候选池：共 ${v.total} 条（待归纳 ${v.pending}，已归纳 ${v.promoted}）`)
        if (v.buckets.length > 0) {
          lines.push('')
          lines.push('待归纳的桶（同桶攒够门槛才会归纳）：')
          for (const b of v.buckets) {
            const ready = b.sessions >= b.need ? '✅够门槛' : `还需 ${b.need - b.sessions} 个会话`
            lines.push(`  · ${b.signature} — ${b.n} 条 / ${b.sessions} 个会话（${ready}）`)
          }
        } else {
          lines.push('（没有待归纳的桶）')
        }
        if (v.recent.length > 0) {
          lines.push('')
          lines.push('最近的候选：')
          for (const c of v.recent.slice(0, 5)) lines.push(`  · [${c.type}] ${String(c.content).slice(0, 70)}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args) {
      const cfg = getCfg()
      const be = cfg.batchExtract ?? {}
      const stat = store.candidateStat()
      const minSessions = Number(be.minSessions) || 2
      const bucketRows = store.candidateBuckets({ minSessions: 1 }).slice(0, args.buckets ?? 10)
      const recent = store.listCandidates({ limit: args.limit ?? 20 })
      return {
        enabled: be.enabled === true,
        idleHours: Number(be.idleHours) || 2,
        total: stat.total,
        pending: stat.pending,
        promoted: Math.max(0, stat.total - stat.pending),
        buckets: bucketRows.map((b) => ({
          signature: b.signature, n: b.n, sessions: b.sessions, need: minSessions,
        })),
        recent: recent.map((c) => ({ id: c.id, type: c.type, theme: c.theme, content: c.content, session: c.session_id })),
      }
    },
  }))
}
