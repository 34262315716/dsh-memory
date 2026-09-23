/**
 * 工具域：降级记忆重写（v0.12.6）。
 *
 * 背景：2026-09-16~09-23 提取链路瘫痪 7 天，期间写进库的都是「任务: X 结果: Y」式
 * 降级产物（规则路径直接落原文）。修好提取后，这些记忆需要**救回来**——
 * 不是清理掉，而是交回提取器重新判断、产出正常的自包含结论。
 *
 * 可续跑：处理过的条目正文不再以「任务:」开头，下次扫描天然跳过。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { truncate } from '../util.js'
import { extractWithLlm, pickKeywords } from '../refiner.js'
import { makeSafeRegister, makeLogStore } from './shared.js'

/** 把「任务: X\n结果: Y」拆回对话两侧。找不到分隔符时整段当用户侧（交给模型自己读）。 */
export function splitDegraded(content) {
  const text = String(content ?? '')
  const idx = text.indexOf('结果:')
  if (idx < 0) return { user: text.replace(/^任务:\s*/, '').trim().slice(0, 6000), assistant: '' }
  return {
    user: text.slice(0, idx).replace(/^任务:\s*/, '').trim().slice(0, 6000),
    assistant: text.slice(idx + '结果:'.length).trim().slice(0, 6000),
  }
}

/** 待重写的降级产物（正文以「任务:」开头且未归档）。 */
export function degradedCandidates(store, { layer, minChars = 80, limit = 5 } = {}) {
  return store.db.prepare(
    `SELECT id, layer, type, scope, content FROM memories
     WHERE archived = 0 AND content LIKE '任务:%' AND LENGTH(content) >= ?
       ${layer ? 'AND layer = ?' : ''}
     ORDER BY created_at DESC LIMIT ?`,
  ).all(...(layer ? [minChars, layer, limit] : [minChars, limit]))
}

export function registerRewriteTools(ctx, store, getCfg) {
  const safeRegister = makeSafeRegister(ctx)
  const logStore = makeLogStore(store, getCfg)

  safeRegister(defineTool({
    name: 'memory_rewrite',
    description: '把提取瘫痪期间写下的「任务: xxx 结果: xxx」式降级记忆，用当前提取器**重新处理成正常记忆**（更新原条目，旧文进世界线可回滚；提取器判定无长期价值的则归档）。默认只预演。可反复调用续跑——处理过的条目不再以「任务:」开头，自动跳过。',
    parameters: {
      dryRun: { type: 'boolean', description: '默认 true：只报告将处理哪些条目，不写库' },
      limit: { type: 'integer', description: '本次最多处理几条（1~50，默认 5）。全量请分批反复调用' },
      layer: { type: 'string', enum: ['ep', 'sm'], description: '只处理指定层级（默认两者都处理）' },
      minChars: { type: 'integer', description: '只处理正文长度 ≥ 该值的条目（默认 80，过滤掉纯噪音短条）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean', required: true },
          processed: { type: 'integer', required: true },
          rewritten: { type: 'integer', required: true },
          archived: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          remain: { type: 'integer', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.note }],
    },
    async execute({ dryRun = true, limit = 5, layer, minChars = 80 }) {
      const cfg = getCfg()
      if (!cfg.refiner?.enabled) {
        return { dryRun, processed: 0, rewritten: 0, archived: 0, failed: 0, remain: 0, note: '提取器未启用（refiner.enabled=false），重写需要它——请先启用。' }
      }
      const rows = degradedCandidates(store, { layer, minChars, limit })
      let rewritten = 0
      let archived = 0
      let failed = 0
      const samples = []

      for (const m of rows) {
        const { user, assistant } = splitDegraded(m.content)
        const before = m.content.replace(/\s+/g, ' ').slice(0, 90)
        if (dryRun) {
          samples.push(`· [${m.layer}/${m.scope}] ${before}`)
          continue
        }
        try {
          // 与自动提取同一套调用；sessionId 必传——缺它这条路由会被上游 400 拒掉
          const out = await extractWithLlm(ctx, cfg, user, assistant, {
            sessionId: `session-rewrite-${Date.now().toString(36)}`,
          })
          if (!Array.isArray(out.items) || out.items.length === 0) {
            store.archiveMemories([m.id], 'rewrite: 提取器判定无长期价值')
            archived++
            samples.push(`· [归档] ${before} ← ${(out.analysis ?? '').slice(0, 70)}`)
            continue
          }
          const item = out.items[0]
          await store.update(m.id, {
            content: truncate(item.content, 2000),
            keywords: (item.keywords?.length ? item.keywords : pickKeywords(item.content)).slice(0, 40),
            strengthDelta: 0.2,
          })
          rewritten++
          samples.push(`· [重写/${item.type}${out.items.length > 1 ? ` +${out.items.length - 1}` : ''}] ${item.content.replace(/\s+/g, ' ').slice(0, 110)}`)
        } catch (err) {
          failed++
          samples.push(`· [失败] ${before} ← ${err.message.slice(0, 100)}`)
        }
      }

      const remain = store.db.prepare(
        "SELECT COUNT(*) c FROM memories WHERE archived = 0 AND content LIKE '任务:%'",
      ).get().c

      const note = dryRun
        ? `【预演】本次将处理 ${rows.length} 条，库中待处理共 ${remain} 条。\n\n${samples.join('\n') || '（没有符合条件的条目）'}`
        : `已处理 ${rows.length} 条：重写 ${rewritten} / 归档 ${archived} / 失败 ${failed}，库中剩 ${remain} 条——继续调用即可续跑。\n\n${samples.join('\n')}`

      if (!dryRun && rows.length > 0) {
        logStore('info', 'memory.rewrite', { processed: rows.length, rewritten, archived, failed, remain })
      }
      return { dryRun, processed: rows.length, rewritten, archived, failed, remain, note }
    },
  }))
}
