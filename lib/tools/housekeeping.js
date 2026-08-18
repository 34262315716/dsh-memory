/**
 * 工具域：管家巡检 / 事件分类 / 运行日志 / 画像蒸馏。
 * 原 registerTools 拆分（v0.10 解耦）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { truncate } from '../util.js'
import { tokenize } from '../store.js'
import { makeSafeRegister, makeLogStore } from './shared.js'

export function registerHousekeepingTools(ctx, store, getCfg) {
  const safeRegister = makeSafeRegister(ctx)
  const logStore = makeLogStore(store, getCfg)
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
      const r = await store.housekeeping({
        dedupThreshold: args.minSimilarity ?? 0.92,
        agingDays: args.agingDays ?? 30,
        dryRun: args.dryRun !== false,
      })
      logStore('info', 'tool.housekeeping', { dryRun: args.dryRun !== false, duplicates: r.duplicates.length, aging: r.aging.length, merged: r.merged })
      return r
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
        logStore('info', 'tool.events.detect', { forced: true })
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
    name: 'memory_logs',
    description: '查看运行日志（写入/注入/检索/巡检/蒸馏/错误全透明）。背后运行了什么完全可见。',
    parameters: {
      limit: { type: 'integer', description: '条数（默认 50）' },
      level: { type: 'string', enum: ['info', 'warn', 'error'], description: '按级别过滤' },
      event: { type: 'string', description: '按事件类型过滤（如 inject/write/housekeeping）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ts: { type: 'integer', required: true },
                level: { type: 'string', required: true },
                event: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.logs.length === 0) return [{ type: 'text', text: '暂无日志。' }]
        const lines = value.logs.map((l) => {
          const t = new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false })
          const d = l.detail.length > 140 ? l.detail.slice(0, 140) + '…' : l.detail
          return `[${t}] ${l.level.toUpperCase()} ${l.event}${l.scope ? '(' + l.scope + ')' : ''} ${d}`
        })
        return [{ type: 'text', text: `运行日志（最近 ${value.logs.length} 条）：\n${lines.join('\n')}` }]
      },
    },
    execute(args) {
      const rows = store.listLogs({ limit: args.limit ?? 50, level: args.level, event: args.event })
      return {
        logs: rows.map((r) => ({
          ts: r.ts,
          level: r.level,
          event: r.event,
          scope: r.scope,
          detail: r.detail,
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
      // 去重幂等：已参与过蒸馏的源记忆 id 记录在 meta（避免跨调用重复聚合画像）
      let distilledIds = new Set()
      try {
        const saved = JSON.parse(store.getMeta('profile_distilled_sources') ?? '[]')
        if (Array.isArray(saved)) distilledIds = new Set(saved)
      } catch { /* meta 损坏时从头蒸馏 */ }
      const candidates = store.list({ layer: 'sm', limit: args.limit ?? 20 })
        .filter((m) => m.type !== 'profile' && (m.type === 'preference' || m.type === 'decision') && !distilledIds.has(m.id))
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
      // 坏 JSON 容错：与 auto-write 降级路径一致——返回空结果而非抛错
      let parsed
      try {
        parsed = JSON.parse((fence ? fence[1] : text).trim())
      } catch (err) {
        console.warn(`[dsh-memory] 画像蒸馏 LLM 输出解析失败（返回空结果）: ${err.message}`)
        return { profiles: [] }
      }
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      const aspects = new Set(['identity', 'preference', 'habit', 'background', 'communication_style'])
      const profiles = []
      for (const it of items) {
        if (typeof it?.content !== 'string' || !it.content.trim()) continue
        const aspect = aspects.has(it.aspect) ? it.aspect : 'preference'
        const id = await store.add({
          layer: 'sm',
          type: 'profile',
          scope: 'global',
          content: truncate(it.content.trim(), 500),
          keywords: [...tokenize(it.content)].slice(0, 20),
          aspect,
        })
        profiles.push({ id, aspect, content: it.content.trim().slice(0, 500) })
      }
      logStore('info', 'tool.distill', { profiles: profiles.length, sources: candidates.length })
      // 记录已蒸馏源（去重幂等：下次调用跳过这批源记忆）
      try {
        const merged = new Set([...distilledIds, ...candidates.map((m) => m.id)])
        store.setMeta('profile_distilled_sources', JSON.stringify([...merged]))
      } catch { /* meta 记录失败不影响蒸馏结果 */ }
      return { profiles }
    },
  }))
}
