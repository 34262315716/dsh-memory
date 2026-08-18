/**
 * 共享纯函数与常量（原 lib/index.js，v0.10 拆分独立）——模型无关、无副作用。
 */
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

/** 估算文本 token 数（中文按字、英文按 4 字符，粗略）。 */
export function estimateTokens(text) {
  let n = 0
  for (const seg of text.matchAll(/[\u4e00-\u9fff]/g)) n++ // 每中文字 ~1 token
  const rest = text.replace(/[\u4e00-\u9fff]/g, '')
  n += Math.ceil(rest.length / 4)
  return n
}

export const WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 会话工作目录 → 记忆 scope（项目隔离，v0.9.4）：cwd 的 basename；无 cwd → 'global'。
 *  接受 session 对象或 agent（自动取 agent.session）。 */
/** 会话 → 记忆 scope（项目隔离，v0.9.4/0.9.5）：优先 session.meta.cwd 的 basename；
 *  EAC/web 会话通常无 cwd——fallback 查 workspaceRegistry（会话所属工作区 path 的 basename）；
 *  仍无 → 'global'。 */
export function scopeOf(sessionOrAgent, registry) {
  const session = sessionOrAgent?.session ?? sessionOrAgent
  const cwd = session?.meta?.cwd ?? session?.cwd
  if (cwd) {
    const base = basename(String(cwd).replace(/\\/g, '/'))
    if (base && base !== '.' && base !== '/') return base
  }
  if (registry && session?.id) {
    try {
      for (const ws of registry.list()) {
        if (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(session.id)) {
          const base = basename(String(ws.path ?? ws.title ?? '').replace(/\\/g, '/'))
          if (base && base !== '.' && base !== '/') return base
        }
      }
    } catch { /* registry 不可用时回落 global */ }
  }
  return 'global'
}

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

/** 从消息数组提取真实用户文本（排除注入内容）。 */
export function extractUserText(messages) {
  const parts = []
  for (const msg of messages) {
    if (msg?.role !== 'user' || msg.source?.kind !== 'user') continue
    for (const block of msg.content ?? []) {
      if (block.type === 'text' && block.text) parts.push(block.text)
    }
  }
  return parts.join('\n').slice(0, 8000)
}

export function messageText(msg) {
  const parts = []
  for (const block of msg?.content ?? []) {
    if (block.type === 'text' && block.text) parts.push(block.text)
  }
  return parts.join('\n')
}

export function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** 成果信号：无用户消息的自主轮次只有输出含这些标记才沉淀（过滤思考中间态噪音）。 */
export const OUTCOME_RE = /✅|已完成|已修复|已交付|已迁移|已同步|已产出|已通过|全部通过|通过|成功|完成|修复|交付|产出|结论[:：]|结果[:：]/

/** 从凭据文件读取密钥引用（值绝不出现在 settings/日志/记忆）。 */
export function readCredential(name) {
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
export function renderInjection(hits, scopeLabel) {
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
