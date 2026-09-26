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

/**
 * 注入噪音剥离（v0.13.0）：平台/其它插件塞进用户消息的包装块（MCP 的 <system-reminder>、
 * 本地命令回显等）不是「用户在说什么」，却和真实用户文本同车抵达——role=user、
 * source.kind 也是 user，所以按来源过滤根本拦不住。
 * 实测（2026-09-26）：工具步的 payload.messages 里往往只剩一条 system-reminder，
 * 它被当成检索 query 用 → 注入出来的全是插件/MCP 味的无关记忆（用户："讲的不是这个"）。
 * 这里**整块剥掉**而不是整条丢弃：同一条消息可能既有真实文本又挂着提醒块。
 */
const NOISE_BLOCK_RE = /<(system-reminder|system|local-command-stdout|command-name|command-message|attachment)\b[^>]*>[\s\S]*?<\/\1>/gi

export function stripInjectedNoise(text) {
  if (typeof text !== 'string' || !text) return ''
  return text.replace(NOISE_BLOCK_RE, ' ').replace(/[ \t]+\n/g, '\n').trim()
}

/** 从消息数组提取真实用户文本（排除注入内容与平台提醒块）。 */
export function extractUserText(messages) {
  const parts = []
  for (const msg of messages) {
    if (msg?.role !== 'user' || msg.source?.kind !== 'user') continue
    for (const block of msg.content ?? []) {
      if (block.type !== 'text' || !block.text) continue
      const clean = stripInjectedNoise(block.text)
      if (clean) parts.push(clean)
    }
  }
  return parts.join('\n').slice(0, 8000)
}

/**
 * 自主轮次 query 兜底（v0.9.23）：无真实用户文本时，从会话事件历史提取最近工作上下文
 * （最近的 user/assistant 消息，跳过插件的注入块）作为检索 query——让 goal 长任务、
 * 后台自主轮次也能自动注入相关记忆，不必等用户发消息。
 */
export function extractWorkText(agent, limit = 800) {
  const events = agent?.session?.events
  if (!Array.isArray(events)) return ''
  const parts = []
  let total = 0
  for (let i = events.length - 1; i >= 0 && total < limit; i--) {
    const ev = events[i]
    let msg = null
    if (ev?.type === 'user/message') msg = ev.data
    else if (ev?.type === 'assistant/message') msg = ev.data?.message
    if (!msg || msg.source?.kind === 'plugin') continue
    const t = stripInjectedNoise(messageText(msg))
    if (t) {
      parts.unshift(t)
      total += t.length
    }
  }
  return parts.join('\n').slice(0, limit)
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

/**
 * 从凭据文件读取密钥引用（值绝不出现在 settings/日志/记忆）。
 * 兼容两种格式：
 *   - 旧版平铺：`KEY: value`（顶格）
 *   - EAC 新内核（0.1.2-alpha.1 起）：`version: 1` + `refs:` 段嵌套（密钥行二级缩进，
 *     `records:` 段用于非密钥凭据，不参与匹配）
 * 逐行 trim 后匹配「键名:」前缀，两种格式均命中；records 段整段跳过。
 * @param name 凭据键名（如 MEMORY_EMBEDDING_API_KEY）
 * @param filePath 凭据文件路径（默认 ~/.dsh/.credentials.yaml；测试可注入临时文件）
 */
export function readCredential(name, filePath = join(homedir(), '.dsh', '.credentials.yaml')) {
  try {
    const raw = readFileSync(filePath, 'utf8')
    let inRecords = false
    for (const line of raw.replaceAll('\r\n', '\n').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('#')) continue // 注释行（顶格/缩进）不扰动段状态机、不参与匹配
      if (inRecords) {
        // records 段结束 = 出现非注释的顶格新键
        if (!line.startsWith(' ') && !line.startsWith('\t')) inRecords = false
        else continue
      }
      if (trimmed === 'records:') { inRecords = true; continue }
      if (trimmed.startsWith(name + ':')) {
        const value = trimmed.slice(trimmed.indexOf(':') + 1).trim()
        return value || undefined
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 注入块渲染：稳定块头 + 确定性排序（score desc, id asc）+ 固定字段结构。
 *  opts.withTime（v0.9.32）：块头附当前时间戳，让模型在长会话中也能感知"现在"，
 *  不依赖会话开始时的预热锚点。注意：调用方去抖 hash 必须用不带时间的版本渲染，
 *  否则内容未变时时间戳每步都在变、去抖永久失效（v0.8.5 教训，见 inject.js）。 */
export function renderInjection(hits, scopeLabel, opts = {}) {
  const t = formatNow()
  const head = opts.withTime ? `（当前时间：${t.local} ${t.weekday} · 来源：dsh-memory，form=recall，可能过时仅供参考）` : '（来源：dsh-memory，form=recall，可能过时仅供参考）'
  const lines = [
    `[记忆] 与当前工作相关的既有记录${head}`,
  ]
  for (const h of hits) {
    const when = new Date(h.updated_at).toISOString().slice(0, 10)
    const layer = h.layer === 'ep' ? '情景' : '语义'
    lines.push(`【${layer}记忆】#${h.id}  ·  相关度 ${h.score.toFixed(2)}  ·  ${when}`)
    lines.push(`> ${h.content.replace(/\n/g, '\n> ')}`)
  }
  return lines.join('\n')
}

/** 常驻标签：类型 → 中文小标。 */
const PIN_KIND = { lesson: '教训', decision: '决策', preference: '偏好', profile: '画像', note: '要点' }

/**
 * 常驻（pinned）记忆块渲染（v0.13.0）：恒定注入块的正文。
 * 与 renderInjection 的关键差别：**没有相关度、没有时间戳**——它不依赖任何检索结果，
 * 每次注入抵达的文本必须逐字相同（调用方拿它做块指纹去抖），否则"恒定"会退化成每步刷屏。
 * 调用方（buildPinned）只负责按预算截取，渲染保持确定性：按传入顺序、不做排序。
 */
// 单条常驻行的正文上限（字）：钉的是「要点」，不是整篇笔记。
export const PIN_ITEM_CHARS = 260

/**
 * 单条常驻行的渲染（v0.13.1）：buildPinned 的预算计费与 renderPinned 共用，
 * 保证「计费的 token 数」= 「真正注入的那一行」，否则长条目会被按原长收费、白占预算。
 */
export function renderPinLine(p, per = PIN_ITEM_CHARS) {
  const body = truncate(String(p?.content ?? '').replace(/\s*\n\s*/g, ' ').trim(), per)
  return `- 【${PIN_KIND[p?.type] ?? '要点'}】#${p?.id} ${body}`
}

export function renderPinned(pins, opts = {}) {
  if (!Array.isArray(pins) || pins.length === 0) return ''
  const per = opts.perItem ?? PIN_ITEM_CHARS
  const lines = [
    `[记忆] 常驻要点（恒定注入 · 钉选 ${pins.length} 条 · 由 dsh-memory 维护——与当前话题是否相关都一直在场）`,
  ]
  for (const p of pins) lines.push(renderPinLine(p, per))
  return lines.join('\n')
}
