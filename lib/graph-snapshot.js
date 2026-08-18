/**
 * 记忆级图谱快照投影（原 lib/index.js buildGraphSnapshot，v0.10 拆分独立）。
 * 只消费 store 实例的方法/属性，不依赖 index 侧状态。
 */

/**
 * 图谱快照（记忆级投影）：一记忆一节点 + 记忆间关系边（similarTo/before）。
 * 阶段三⑥（简化）：边直接读 memory_links 表（记忆级边的一等存储），不再经实体图
 * node_memories 映射（删除了 memOf 的实体→记忆回查复杂度）。
 */
export function buildGraphSnapshot(store) {
  const mems = store.list({ limit: 1000 }).filter((m) => m.layer === 'sm')
  // 版本数统计（世界线长度：更新过几次 = 版本数 - 1）——四维蠕虫的时间痕迹
  const versionCounts = new Map()
  for (const r of store.db.prepare(
    'SELECT memory_id, COUNT(*) AS c FROM memory_versions GROUP BY memory_id',
  ).all()) {
    versionCounts.set(r.memory_id, r.c)
  }
  // 事件映射（阶段四）：mem -> eventId（GUI 事件筛选/高亮）
  const evMap = store.eventMap()
  const nodes = mems.map((m) => ({
    id: m.id,
    label: m.theme || m.type,
    theme: m.theme || '',
    type: m.type,
    layer: m.layer,
    strength: m.strength,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    versions: versionCounts.get(m.id) ?? 1,   // 版本数（≥1；>1 表示被更新过）
    eventId: evMap.get(m.id) ?? null,          // 所属事件
    aspect: m.profile_aspect ?? '',            // 画像子域（type=profile 时非空）
    content: m.content.slice(0, 160),
  }))
  const edges = []
  const seen = new Set()
  for (const r of store.db.prepare(
    'SELECT from_memory, to_memory, type, weight FROM memory_links WHERE valid_to IS NULL ORDER BY valid_from',
  ).all()) {
    const key = r.type + '|' + r.from_memory + '|' + r.to_memory
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ from: r.from_memory, to: r.to_memory, type: r.type, weight: r.weight })
  }
  const themes = [...new Set(nodes.map((n) => n.theme).filter(Boolean))]
  // 事件列表（阶段四）：GUI 事件筛选下拉数据
  const events = store.events(50).map((e) => ({
    id: e.id,
    label: e.label,
    startAt: e.startAt,
    endAt: e.endAt,
    count: e.members.length,
  }))
  return { stats: store.stats(), themes, nodes, edges, events }
}
