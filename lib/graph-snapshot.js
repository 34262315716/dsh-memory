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
  /**
   * v0.17.0 修截断：原来写的是 `store.list({ limit: 1000 })`——按 updated_at 倒序取前 1000 条。
   * 而 2026-10-15 实测：真库 sm 层已有 1351 条激活记忆，**最旧那批（8 月中到 9 月初）根本画不出来**，
   * 且没有任何提示（看着像"记忆库只有 1000 条"）。这是既有缺陷，与合并功能无关，一并修掉。
   *
   * 改法：直接查表，只按 layer 过滤，不设上限。代价是节点数随库增长——但 Canvas 每帧整绘
   * 数百节点只要 <5ms（见 graph.jsx 头注释），千级仍在可接受范围；真到性能边界时应该做的是
   * 视口裁剪或分页，而不是静默丢数据。
   *
   * 同时带出 merged_from / merged_into（v0.17.0 主题合并）：
   *   merged_from 非空 = 这条是**合并产物**（图谱里画成"容器"）
   *   merged_into 非空 = 这条**已被并入别处**（默认不画，点开父节点时在侧栏展开）
   */
  const mems = store.db.prepare(
    `SELECT id, layer, type, scope, content, keywords, theme, abstract, profile_aspect,
            strength, created_at, updated_at, merged_from, merged_into
     FROM memories WHERE layer = 'sm' AND archived = 0 ORDER BY updated_at DESC`,
  ).all().map((m) => ({ ...m, keywords: (() => { try { return JSON.parse(m.keywords) } catch { return [] } })() }))
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
    // v0.17.0 主题合并：图谱要按这两个字段决定怎么画
    //   childCount > 0 → 画成"容器"（半径随子节点数增长，子点摆在容器内）
    //   mergedInto     → 已被并入别处（默认不画；点开父节点时在侧栏展开）
    childCount: (() => { try { const a = JSON.parse(m.merged_from || '[]'); return Array.isArray(a) ? a.length : 0 } catch { return 0 } })(),
    mergedFrom: (() => { try { const a = JSON.parse(m.merged_from || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } })(),
    mergedInto: m.merged_into || '',
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
  // 共现联系（mentions，v0.9.11）：共享 ≥2 个实体 label 的记忆对 → 记忆级"强共现"边（weight = 共享实体数）。
  // 让"联系有多种方式"在记忆级图谱可见；限定 sm 层 + 阈值过滤防糊（生产库 ~29 对）。
  const mentionRows = store.db.prepare(`
    SELECT x.mem AS a, y.mem AS b, COUNT(*) AS weight
    FROM (SELECT DISTINCT n.memory_id AS mem, n.label AS label
          FROM nodes n JOIN memories m ON m.id = n.memory_id AND m.layer = 'sm'
          WHERE n.kind = 'entity') x
    JOIN (SELECT DISTINCT n.memory_id AS mem, n.label AS label
          FROM nodes n JOIN memories m ON m.id = n.memory_id AND m.layer = 'sm'
          WHERE n.kind = 'entity') y
      ON x.label = y.label AND x.mem < y.mem
    GROUP BY x.mem, y.mem HAVING COUNT(*) >= 2
  `).all()
  const memSet = new Set(nodes.map((n) => n.id))
  for (const r of mentionRows) {
    if (!memSet.has(r.a) || !memSet.has(r.b)) continue
    const key = 'mentions|' + r.a + '|' + r.b
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ from: r.a, to: r.b, type: 'mentions', weight: r.weight })
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
