/**
 * 记忆级图谱快照投影（原 lib/index.js buildGraphSnapshot，v0.10 拆分独立）。
 * 只消费 store 实例的方法/属性，不依赖 index 侧状态。
 */

/**
 * 图谱快照（记忆级投影）：一记忆一节点 + 记忆间关系边（similarTo/before）。
 * 阶段三⑥（简化）：边直接读 memory_links 表（记忆级边的一等存储），不再经实体图
 * node_memories 映射（删除了 memOf 的实体→记忆回查复杂度）。
 */
export function buildGraphSnapshot(store, opts = {}) {
  /**
   * 节点上限 + 溢出整合（v0.17.1，2026-10-15 主人要求）。
   *
   * ## 为什么需要上限
   *   历史上这里写的是 store.list({ limit: 1000 })——带 1000 条上限。v0.17.0 我为了
   *   "不再静默丢数据"把它改成无上限查询，于是真库 1970 条全部进图谱。服务端生成只要
   *   52ms，瓶颈在**浏览器端的力导向**：节点翻倍后加载明显变慢（主人实测反馈
   *   "加载时间很长，和原来的不一样"）。所以上限本身是对的，错的只是原来那版
   *   **静默丢弃**超出部分——最旧的记忆画不出来，且没有任何提示。
   *
   * ## 正确的做法：上限 + 整合（一条都不丢）
   *   保留最新的 maxNodes 条作为独立节点；**超出的按主题聚合成容器节点**——
   *   每个容器带 childCount（画成大圆 + 内部子点，与"合并产物"同一套视觉）与
   *   memberIds（点开侧栏列出成员）。于是节点数被压住、加载回到原来的速度，
   *   被整合的记忆**仍然看得见、点得开**，只是折叠进容器里。
   *
   * 实测（真库 1970 条 / 上限 850 / 折叠门槛 3）：溢出 1120 条 → 聚成约 50 个容器，
   * 图谱节点数回到 900 上下，与改动前的规模一致。
   *
   * 同时带出 merged_from / merged_into（v0.17.0 主题合并）：
   *   merged_from 非空 = 这条是**合并产物**（图谱里画成"容器"）
   *   merged_into 非空 = 这条**已被并入别处**（默认不画，点开父节点时在侧栏展开）
   */
  const maxNodes = Math.max(100, Number(opts.maxNodes) || 850)
  const COLS = "id, layer, type, scope, content, keywords, theme, abstract, profile_aspect," 
    + " strength, created_at, updated_at, merged_from, merged_into"
  const pick = (m) => ({ ...m, keywords: (() => { try { return JSON.parse(m.keywords) } catch { return [] } })() })
  const mems = store.db.prepare(
    "SELECT " + COLS + " FROM memories WHERE layer = 'sm' AND archived = 0 ORDER BY updated_at DESC LIMIT ?",
  ).all(maxNodes).map(pick)
  // 溢出部分：只取聚合所需字段（不拉全文，这里用不上）
  const overflow = store.db.prepare(
    "SELECT id, theme, type, created_at FROM memories WHERE layer = 'sm' AND archived = 0"
    + " ORDER BY updated_at DESC LIMIT -1 OFFSET ?",
  ).all(maxNodes)
  /**
   * 溢出 → 容器节点：**按主题聚合**（无主题的并成一个"未归类"容器）。
   *
   * 为什么按主题：主题是这张图的固有语义分组，同主题的记忆本来就被画在一起。
   * 聚成"每主题一个容器"后，容器落在这个主题的团里，视觉上就是"这团太密，
   * 折叠成一颗大的"——比按类型或按时间聚合更符合"这是一坨同类东西"的直觉。
   *
   * 容器 id 用 agg:<主题> 前缀，与真实记忆 id（mem-xxx）不会冲突；
   * 容器不参与边计算（它没有 memory_links），只是个折叠占位。
   */
  const aggMap = new Map()
  for (const r of overflow) {
    const key = r.theme || ''
    if (!aggMap.has(key)) aggMap.set(key, [])
    aggMap.get(key).push(r)
  }
  /**
   * 折叠门槛（v0.17.1）：**只折叠够大的组**，小组还原成散点。
   *
   * 为什么要门槛（2026-10-15 看图发现）：没有门槛时，长尾小主题各成一个小容器，
   * 实测 106 个金色大圈铺满外圈，把整张图搅成"一圈金点"——比原来看不清还糟。
   * 小主题本来就只有两三条，折叠省不下节点，却白添一个圈。
   *
   * 实测（真库 970 条溢出 / 上限 1000）：
   *   门槛 2 → 105 个容器（覆盖 420 条）+ 散点 19 条
   *   门槛 3 →  54 个容器（覆盖 318 条）+ 散点 121 条 ← 取这一档
   *   门槛 5 →  25 个容器（覆盖 228 条）+ 散点 211 条
   * 取 3：容器数减半、仍吃掉三分之一的溢出，散点也不会一下冒出太多。
   */
  const FOLD_MIN = Math.max(2, Number(opts.foldMin) || 3)
  const soloNodes = []
  const aggNodes = []
  for (const [theme, list] of aggMap) {
    if (list.length === 0) continue
    if (list.length < FOLD_MIN) {
      // 小组：还原成普通节点（不折叠），保留可读性
      for (const r of list) soloNodes.push({ id: r.id, theme, type: r.type, created_at: r.created_at })
      continue
    }
    aggNodes.push({
      id: "agg:" + (theme || "__none__"),
      label: theme || "未归类",
      theme,
      type: "aggregate",
      layer: "sm",
      strength: 1,
      createdAt: list[list.length - 1].created_at,
      updatedAt: list[list.length - 1].created_at,
      versions: 1,
      eventId: null,
      aspect: "",
      content: "（" + list.length + " 条较早的记忆已折叠进此容器）",
      childCount: list.length,
      mergedFrom: [],
      mergedInto: "",
      // 完整成员 id（不截断）——容器要能完整展开，否则最后几十条永远看不到
      memberIds: list.map((r) => r.id),
      aggregated: true,
    })
  }
  // 版本数统计（世界线长度：更新过几次 = 版本数 - 1）——四维蠕虫的时间痕迹
  const versionCounts = new Map()
  for (const r of store.db.prepare(
    'SELECT memory_id, COUNT(*) AS c FROM memory_versions GROUP BY memory_id',
  ).all()) {
    versionCounts.set(r.memory_id, r.c)
  }
  // 事件映射（阶段四）：mem -> eventId（GUI 事件筛选/高亮）
  const evMap = store.eventMap()
  /**
   * 单条溢出的记忆：还原成普通节点（不折叠）。
   * 它们不在 mems 里（那是 only 前 maxNodes 条），所以单独拉一次。
   */
  const soloExtra = soloNodes.length === 0 ? [] : store.db.prepare(
    "SELECT " + COLS + " FROM memories WHERE id IN (" + soloNodes.map(() => "?").join(",") + ")",
  ).all(...soloNodes.map((r) => r.id)).map(pick).map((m) => ({ ...m, aggregated: false }))
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
    aggregated: false,
  })).concat(soloExtra.map((m) => (
    {
      id: m.id,
      label: m.theme || m.type,
      theme: m.theme || '',
      type: m.type,
      layer: m.layer,
      strength: m.strength,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      versions: versionCounts.get(m.id) ?? 1,
      eventId: evMap.get(m.id) ?? null,
      aspect: m.profile_aspect ?? '',
      content: m.content.slice(0, 160),
      childCount: (() => { try { const a = JSON.parse(m.merged_from || '[]'); return Array.isArray(a) ? a.length : 0 } catch { return 0 } })(),
      mergedFrom: [],
      mergedInto: m.merged_into || '',
      aggregated: false,
    }
  ))).concat(aggNodes)
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
