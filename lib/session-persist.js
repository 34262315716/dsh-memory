/**
 * 会话累积的持久化（v0.20.0）。
 *
 * **为什么必须落盘**：批量提取靠"静置 2 小时无新消息"触发，而进程重启会清空
 * 内存里的 sessionTurns——不落盘的话，只要在两小时内重启过一次，那段会话就
 * 永远不会被提取（静置计时器跟着一起没了）。
 *
 * **存哪**：复用 meta 表（key/value），按会话一条 JSON。不新建表是因为数据量小、
 * 且天然跟着库里走；会话处理完就删。
 */

/** meta 表的键前缀。 */
const KEY_PREFIX = 'batch:turns:'

/**
 * 把某个会话的累积轮次写进 meta 表。
 *
 * @param {object} store MemoryStore 实例
 * @param {string} sid 会话 id
 * @param {Array<{user: string, assistant: string, at: number}>} turns 累积轮次
 * @param {number} lastAt 最后活动时间戳
 */
export function persistSessionTurns(store, sid, turns, lastAt) {
  if (!store || !sid) return
  try {
    const payload = JSON.stringify({ turns: turns ?? [], lastAt: lastAt ?? Date.now() })
    store.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(KEY_PREFIX + sid, payload)
  } catch { /* 落盘失败不影响主流程：最坏情况是这次会话不提取 */ }
}

/**
 * 从 meta 表读回全部会话累积。
 *
 * @param {object} store MemoryStore 实例
 * @returns {Map<string, {turns: Array, lastAt: number}>} sessionId → 累积
 */
export function loadAllSessionTurns(store) {
  const out = new Map()
  if (!store) return out
  try {
    const rows = store.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'batch:turns:%'").all()
    for (const r of rows) {
      try {
        const sid = String(r.key).slice(KEY_PREFIX.length)
        const parsed = JSON.parse(r.value)
        if (Array.isArray(parsed?.turns) && parsed.turns.length > 0) {
          out.set(sid, { turns: parsed.turns, lastAt: Number(parsed.lastAt) || 0 })
        }
      } catch { /* 单条坏数据跳过 */ }
    }
  } catch { /* meta 表不可用时退化为纯内存 */ }
  return out
}

/**
 * 删掉某个会话的持久化累积（处理完或确认不要了）。
 *
 * @param {object} store MemoryStore 实例
 * @param {string} sid 会话 id
 */
export function dropSessionTurns(store, sid) {
  if (!store || !sid) return
  try {
    store.db.prepare('DELETE FROM meta WHERE key = ?').run(KEY_PREFIX + sid)
  } catch { /* ignore */ }
}
