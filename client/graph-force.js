/**
 * 图表力模型 + 初始布局 —— **整个布局的唯一出处**（v0.15.1 修正版）
 *
 * 为什么单独一个文件：力模型以前散在 graph.jsx 的循环里，改一次要"看画面猜"。
 * 现在它是**纯函数**，可以在 Node 里直接求值/断言（见仓库根 test-graph-field.mjs），
 * 也可以拿真实记忆库（857 点 / 716 边）离线跑上千帧再读数（见开发探针 _probe-graph-sim2.mjs）。
 * 改曲线先用数字验证，再交给眼睛。
 *
 * ## 模型（用户 m01095 的定义）
 * 「每一个点以它自己为中心向周围划定一个半径，**半径内的点会影响这个点**，每一个点都是这样」
 *   · 局部：半径 R 外**互不影响**（d ≥ R 时力严格为 0）—— 对应 d3-force 的 manyBody.distanceMax
 *     （d3 文档原话："a finite maximum distance improves performance and produces a more
 *     localized layout"）。
 *   · 各向同性：力只由距离 d 决定，与方位无关（360° 连续，没有任何特权方向）。
 *   · 每个点平等：**不按度数加权**。
 *
 * ## 单对节点的径向力（v0.15.1：硬截断斥力 + 轻触式引力）
 *     u = d / dEq                                                     dEq = k·spacing
 *     u < 1            : f = +field·REP_C/k'²·(1/uc² − 1/uc)   uc = max(u, 0.5)   → **斥**
 *     u = 1            : f = 0                                                      → 平衡距离
 *     1 < d < R        : f = −field·attract·(1 − (d−dEq)/(R−dEq))                   → **轻吸**
 *     d ≥ R            : f = 0                                                      → 互不影响
 *
 *   ⚠️ 为什么引力必须"轻"：引力是**累加**的，斥力是**封顶**的。
 *   一个点周围的小壳层里有 ~25 个邻居，每个都给一点向内的引力；而近场斥力在 d ≤ 0.5·dEq
 *   之后就不再增长（软化核心）。只要引力峰值 × 邻居数 > 核心斥力，整个盘就会**塌**，
 *   塌到 1/d² 重新变得很大、且积分不稳定为止 —— 那正是 2026-10-03 用户看到的
 *   「中间一个密实大圆盘 + 外圈孤岛 + 大量空白」+「一拖动球就乱飞」。
 *   实测（857 点真实数据，1200 帧，α=0.4）：
 *     | 力模型                                    | 最近邻 | 静息平均速度 | >2px/帧的点 | 拖动峰值 |
 *     |------------------------------------------|--------|-------------|------------|---------|
 *     | v0.15.0（1/d 引力尾巴，尾巴在邻域内积分）   | 16-19px| 3.7-9.7     | 375-414    | 76.8    |
 *     | v0.15.1（硬截断斥力 + 轻引力 0.06）        | 54-58px| 0.03-0.06   | **0**      | 1.6-2.1 |
 *   （`dist` 单位 px/帧；dEq=71px。测法见 _probe-graph-sim2.mjs 变体 G/H/L。）
 *
 * ## 没有的东西（这次重写**删掉**的）
 *   · **中心引力**：`vx += (W/2 − x)·gravity·alpha`（等价于 d3-force 的 forceX：源码
 *     `node.vx += (xz[i] - node.x) * strength * alpha`）。强度 ∝ 距离，是旧模型里唯一的
 *     单向力，拖动把 α 抬高时全场会一起朝中心缩。替代品不是"更弱的引力"，而是
 *     **整体平移归心**：d3-force 的 forceCenter 源码里**一个力都没施加**，只算质心再整体
 *     平移（`node.x -= sx`）——数学上不可能改变相对结构。见 recenter()。
 *   · 度数加权（斥力折减 / 弹簧按度数加硬 / 回中权重）：按用户的模型，每一对节点都平等。
 *   · 主题锚点、以及任何"朝某个固定点拉"的力。
 *
 * ## 布局从哪来（关键）：**距离由力管，远近由种**子管
 *   纯局部场没有任何"把远处的东西拉过来"的机制 —— 这是用户模型的直接推论，不是缺陷。
 *   所以**分量的相对位置必须由初始布局决定**（见 seedLayout），力只做局部抛光：
 *   · 度数高的节点/大的连通分量 → 靠中心（"连接越多越靠近中心"，用**结构**实现，不用中心力）
 *   · 同一连通分量的成员 → 同一个圆盘内，边不会拉成横贯全图的长线
 *   · 孤立点（本机数据 857 点里有 395 个）→ 外圈光环，规整排列，不会变成"孤岛"
 */

/** 近场强度基准（×1/k'²，k' = k/spacing）。沿用历史值 8 —— 与旧布局的间距手感连续。 */
export const REP_C = 8
/** 软化核心：u < CORE_U 之后斥力不再增长（对应 d3 的 manyBody.distanceMin）。 */
export const CORE_U = 0.5
/** 边的静止长度 = SPRING_TIGHT · dEq：比场的平衡距离略紧，让"簇"看起来像簇。 */
export const SPRING_TIGHT = 0.9

/** 出厂参数：设置页里的图谱项就是这几个（旧的 repulsion/gravity 已废弃）。 */
export const FIELD_DEFAULTS = {
  field: 1,        // 邻域场强度倍率
  spacing: 1.2,    // 平衡间距（×k）：u=1 的位置，斥↔吸的翻转点。★ 出厂 1.2（实测 857 点时 fit 缩放 0.42×；1.6 只有 0.33×）
  range: 4.5,      // 邻域半径（×k）：之外的节点完全不影响这个点
  attract: 0.06,   // 轻触式引力峰值（**必须远小于斥力**，见文件头的塌陷说明；0 = 纯斥力）
  spring: 0.13,    // 边弹簧刚度
  damping: 0.3,    // 速度阻尼
  maxSpeed: 4,     // 单帧速度上限（px）：数值安全网，让"乱飞"在物理上不可能
  wobble: 0.04,    // 收敛后的常活微动幅度
}

/**
 * 邻域场内**任意一对**节点之间的力（>0 斥、<0 吸、0 = 互不影响）。
 * 与"有没有边"无关：边的弹簧是另一条通道（springForce）。
 * @param {number} d  两点的距离
 * @param {number} k  √(画布面积 / 节点数)：布局的密度尺度
 * @param {{field?:number,spacing?:number,range?:number,attract?:number}} P 参数
 */
export function pairForce(d, k, P) {
  const spacing = P.spacing ?? FIELD_DEFAULTS.spacing
  const dEq = k * spacing
  if (!(d > 0) || !(dEq > 0)) return 0
  const field = P.field ?? FIELD_DEFAULTS.field
  const u = d / dEq
  if (u < 1) {
    const uc = u < CORE_U ? CORE_U : u
    return field * (REP_C / (spacing * spacing)) * (1 / (uc * uc) - 1 / uc)
  }
  const R = k * (P.range ?? FIELD_DEFAULTS.range)
  if (!(d < R)) return 0
  const attract = P.attract ?? FIELD_DEFAULTS.attract
  if (!(attract > 0)) return 0
  return -field * attract * (1 - (d - dEq) / (R - dEq))
}

/**
 * 边弹簧（胡克）：静止长度 SPRING_TIGHT·dEq，**统一刚度**（不按度数加硬）。
 * @returns {number} >0 表示该把两端**拉近**的力
 */
export function springForce(d, k, P) {
  const stiff = P.spring ?? FIELD_DEFAULTS.spring
  const spacing = P.spacing ?? FIELD_DEFAULTS.spacing
  return (d - k * spacing * SPRING_TIGHT) * stiff
}

/** 单帧速度上限（数值安全网）。返回是否被截断。 */
export function clampSpeed(v, max) {
  if (!(max > 0)) return false
  const s = Math.hypot(v.vx, v.vy)
  if (!(s > max)) return false
  v.vx = (v.vx / s) * max
  v.vy = (v.vy / s) * max
  return true
}

/**
 * 整体平移归心（d3-force 的 forceCenter 语义）：**不是力**。
 * 只把所有点一起挪动同一个量，使质心落在 (cx, cy) —— 相对结构逐点不变（见 test-graph-field.mjs）。
 * 有了它就不需要中心引力：图不会被拉扯、不会收缩，但也不会飘出视野。
 */
export function recenter(nodes, cx, cy) {
  const n = nodes.length
  if (!n) return { dx: 0, dy: 0 }
  let sx = 0, sy = 0
  for (const p of nodes) { sx += p.x; sy += p.y }
  const dx = sx / n - cx
  const dy = sy / n - cy
  if (dx || dy) for (const p of nodes) { p.x -= dx; p.y -= dy }
  return { dx, dy }
}

/* ────────────────────────────── 初始布局 ────────────────────────────── */

/** 并查集 */
function unionFind(ids, edges) {
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (x) => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)
    while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx }
    return r
  }
  for (const e of edges) {
    if (!parent.has(e.from) || !parent.has(e.to)) continue
    const a = find(e.from), b = find(e.to)
    if (a !== b) parent.set(a, b)
  }
  return find
}

/**
 * 圆盘装箱器（v0.15.2 抽出成独立函数）：把一组圆盘摆成一坨互不重叠的东西，
 * 返回每项的**相对位置**与整坨的**包围半径**。两层装箱（分量→组团、组团→画布）**共用同一个实现** ——
 * 规则一致才不会出现"某一层特别松"的浪费。
 *
 *   · **搜索起点按已用面积算**（v0.15.2 定稿）：`floor = max(r, sqrt(已放面积/π) − r)` ——
 *     这是"已放置的东西摊成一个圆盘"的半径，**紧下界**，不是保守保证。搜索从它出发往外找第一个
 *     不重叠的位置，所以下界偏小只是多试几圈，绝不会浪费（两代老实现都栽在"保守地板"上：
 *     先是逐项累加的中心半径下限 → 4013px；再是"按档取上一档外沿" → 空档太多，
 *     真实数据 2919px 直接涨到 9643px，fit 从 0.36× 掉到 0.11×）。
 *   · **结构由"顺序 + 面积地板"保证**：调用方按**大到小**给项，先放的占中心；面积随放置单调增长，
 *     后放的小项自然被推到外圈（真实数据：大分量在中心、孤立点在最外圈 —— 见 test-graph-field.mjs
 *     的统计断言）。不再有"某一档独占一圈"的机械保证，换来的是接近最密排布的直径。
 *   · **分环**：从起点出发绕圈找最近空位，一圈填满再往外开新圈 → 方阵级密度（每项约 (2r)² 面积）。
 *
 * @param {number[]} slots 每项的**槽半径**（已含该项想要的间隙），调用方按大到小传
 * @param {number} dEq 平衡间距（决定径向步长与角采样的尺度）
 * @returns {{pos:Array<[number,number]>, R:number}} pos 与 slots 同序；R = max(|pos| + slot)
 */
function packDiscs(slots, dEq) {
  const ARC = 0.45 * dEq
  // 径向步长**必须细**（v0.15.2 实测踩坑）：曾用 `max(0.5·dEq, 2r)`，那是"环与环不重叠"的**下限**，
  // 当槽半径很大时（主题组团 r 可达 10·dEq 以上）每圈要往外跳 2r=20·dEq —— 大槽一多，整张图就被
  // 一层层"大步"甩到一万 px 外（实测 3236px → 10369px，fit 从 0.33× 掉到 0.10×）。径向要的是
  // **贴着已占区域慢慢挪**（切向才需要 2r 的间距），角度扫描会把环内填满。
  const ringStepOf = (r) => Math.max(0.4 * dEq, 0.6 * r)
  // 网格边长取"最大槽半径"（slots 由调用方按大到小传入）：这样一次重叠测试最多只跨 ±2 格，
  // 而格子数少、空格查找便宜（v0.15.2 实测：用固定 4·dEq 时 857 点种子要 939ms，
  // 改成随最大槽缩放后大幅减少空格扫描）。
  const cell = Math.max(2 * dEq, slots[0] || 1)
  const placed = []
  let maxPlacedR = 0   // 已放置项里最大的槽半径（决定 overlaps 的扫描圈数）
  const buckets = new Map()
  const bkey = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  const overlaps = (x, y, r) => {
    const bx = Math.floor(x / cell), by = Math.floor(y / cell)
    // 扫描窗口**必须随半径自适应**（v0.15.2 实测踩坑）：原写死 ±2 格 = ±8·dEq，
    // 只对 r + r' ≤ 8·dEq 的项成立。组团层里单个槽可达 10·dEq 以上，于是"两个大组团彼此压住"
    // 这种情况根本扫不到 → 600 点样本里出现 46 对重叠点，最近两点只隔 1.81px（0.03·dEq）——
    // 实拍后果就是"点叠点、像一个大色块"。现在按 r + maxPlacedR 决定扫几圈。
    const span = Math.max(2, Math.ceil((r + maxPlacedR) / cell))
    for (let i = bx - span; i <= bx + span; i++) {
      for (let j = by - span; j <= by + span; j++) {
        const arr = buckets.get(`${i},${j}`)
        if (!arr) continue
        for (const p of arr) {
          if (Math.hypot(p.x - x, p.y - y) < p.r + r) return true
        }
      }
    }
    return false
  }
  const put = (x, y, r) => {
    const rec = { x, y, r }
    placed.push(rec)
    if (r > maxPlacedR) maxPlacedR = r
    const key = bkey(x, y)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(rec)
  }
  const pos = []
  let theta = 0
  let usedArea = 0   // 已放置项的面积之和（πr²）——搜索起点由它算，不再由"最大外沿"算
  for (let i = 0; i < slots.length; i++) {
    const r = slots[i]
    let px = 0, py = 0
    if (placed.length === 0) {
      put(0, 0, r)
    } else {
      let ok = false
      const ringStep = ringStepOf(r)
      const floor = Math.max(r, Math.sqrt(usedArea / Math.PI) - r)
      for (let ring = 0; ring < 200 && !ok; ring++) {
        const rad = floor + ring * ringStep
        const steps = Math.max(24, Math.ceil((2 * Math.PI * rad) / ARC))
        for (let s = 0; s < steps; s++) {
          const a = theta + (s / steps) * 2 * Math.PI
          const x = rad * Math.cos(a), y = rad * Math.sin(a)
          if (!overlaps(x, y, r)) { px = x; py = y; theta = a; ok = true; break }
        }
      }
      if (!ok) { // 极端拥挤时的兜底：往外放，宁可远一点也不重叠
        const rad = floor + 200 * ringStep
        px = rad * Math.cos(theta); py = rad * Math.sin(theta)
      }
      put(px, py, r)
    }
    usedArea += Math.PI * r * r
    pos.push([px, py])
  }
  let R = 0
  for (let i = 0; i < slots.length; i++) R = Math.max(R, Math.hypot(pos[i][0], pos[i][1]) + slots[i])
  return { pos, R }
}

/**
 * 初始布局：**连通分量成盘 + 按"连接度"从中心向外排布**。
 *
 * 为什么不能再用"所有节点铺在一个半径固定的环上"（v0.15.0 及以前）：857 个点挤在周长
 * ≈1257px 的环上，局部间距 ~1.5px —— 近场斥力（哪怕封顶）也会把点弹到几千 px 外，
 * 而局部场对"已经跑出半径的点"零作用，于是它们**永远回不来** → 就是用户截图里的
 * 「大量空白 + 外圈孤岛」。种子必须在**模型自己的密度**上，才谈得上"稳定"。
 *
 * 排布规则（全部是**结构**决定的，不含任何"朝中心拉"的力）：
 *   1. 连通分量按大小降序 → 从中心向外放置：最大的分量在正中，孤立点在最外圈。
 *      度数高的节点天然属于大分量 → 视觉上"连接越多越靠近中心"。
 *   2. 分量内部按度数降序铺黄金角螺旋盘 → 分量里最"hub"的那个点在盘心。
 *   3. 分量圆盘沿一条"按面积增长"的螺旋向外找空位（先试近处，被占就往外挪），
 *      留白 0.8·dEq → 跨分量的点距也不会小于模型平衡距离。
 *
 * @param {{nodes:Array,edges:Array}} data 图谱数据（节点需有 id，边需有 from/to）
 * @param {number} W 画布宽 @param {number} H 画布高
 * @returns {{positions:Map<string,[number,number]>, groups:Map<string,Array>, k:number, dEq:number}}
 */
export function seedLayout(data, W, H, P = FIELD_DEFAULTS) {
  const nodes = data?.nodes ?? []
  const edges = data?.edges ?? []
  const positions = new Map()
  const groups = new Map()
  const n = nodes.length
  if (!n) return { positions, groups, k: 0, dEq: 0 }
  const k = Math.sqrt((Math.max(W, 1) * Math.max(H, 1)) / n)
  const dEq = k * (P.spacing ?? FIELD_DEFAULTS.spacing)

  // 主题分组（保留给渲染层用）+ 度数
  const deg = new Map()
  for (const nd of nodes) {
    deg.set(nd.id, 0)
    const t = nd.theme || '(未归类)'
    if (!groups.has(t)) groups.set(t, [])
    groups.get(t).push(nd)
  }
  for (const e of edges) {
    if (deg.has(e.from)) deg.set(e.from, deg.get(e.from) + 1)
    if (deg.has(e.to)) deg.set(e.to, deg.get(e.to) + 1)
  }

  // 连通分量
  const find = unionFind(nodes.map((nd) => nd.id), edges)
  const compMap = new Map()
  for (const nd of nodes) {
    const r = find(nd.id)
    if (!compMap.has(r)) compMap.set(r, [])
    compMap.get(r).push(nd)
  }
  // 分量归哪个主题：**多数票**，不是第一个成员的主题（v0.15.2 修）。
  // 真实数据里 66 个连通分量是**混主题**的（涉及 372 个点）—— 一条边跨越两个主题再正常不过。
  // 用 members[0] 决定归属，等于把该主题成批的成员搬进邻居的组团里（实测 `comfyui/dsh-memory`
  // 有 56 个成员、`dsh-memory/图谱` 有 56% 的成员是这样"流落在外"的），主题范围圈必然撑满全图。
  // 平票时偏向**有主题**的一方（无主题是兜底，不该抢走有身份的成员）。
  const dominantTheme = (members) => {
    const hist = new Map()
    for (const m of members) {
      const t = m.theme || ''
      hist.set(t, (hist.get(t) ?? 0) + 1)
    }
    let best = '', bc = -1
    for (const [t, c] of hist) {
      if (c > bc || (c === bc && (t && !best)) || (c === bc && t && best && t < best)) { best = t; bc = c }
    }
    return best
  }
  const items = [...compMap.values()].map((members) => {
    members.sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0) || String(a.id).localeCompare(String(b.id)))
    return {
      members,
      size: members.length,
      degSum: members.reduce((s, m) => s + (deg.get(m.id) ?? 0), 0),
      theme: dominantTheme(members),
    }
  })
  // 排序交给下面两层装箱：分量在**自己的主题组团内**按大小降序，组团再按面积降序占内圈（v0.15.2）
  const bySize = (a, b) =>
    b.size - a.size ||
    b.degSum - a.degSum ||
    String(a.members[0].id).localeCompare(String(b.members[0].id))

  /** m 个成员铺成黄金角圆盘所需的半径 */
  const discR = (m) => (m <= 1 ? 0.3 * dEq : dEq * Math.sqrt((m * 0.9) / Math.PI))
  // ★ 槽半径 = 分量圆盘半径 + 极小的装箱间隙（0.12·dEq）。
  // ★ 槽间隙**刻意留得很小**（见下面的 GAP_COMP / GAP_BLOCK）——种子宁可铺得比平衡距离**紧**：
  //   场对"太近"的反应是强斥力（近场核心 1/u²，量级 6.25），几百帧内就能推回 dEq；而对"太远"
  //   只有极轻的远场引力（峰值 0.06），拉回来慢得多（实测 1.21·dEq 只收到 1.14）。反过来说，
  //   间隙留得越大、fit 缩放越小、越看不清（v0.15.1 曾用 0.4·dEq 的间隙，白扔了近两成直径）。
  const local = (m, r) => {
    if (m === 1) return [[0, 0]]
    const out = []
    for (let i = 0; i < m; i++) {
      const rr = r * Math.sqrt((i + 0.5) / m)
      const a = i * 2.399963229728653
      out.push([rr * Math.cos(a), rr * Math.sin(a)])
    }
    return out
  }

  // 装箱器已抽成模块级 packDiscs()（见上）——两层装箱共用，规则不一致会各留一份浪费。

  // ── 装箱（v0.15.2）：**分量 → 主题组团 → 画布** ─────────────────────────────
  // 为什么要有"组团"这一层：用户实拍「同一个主题的点离得太远」。主题是**语义**分组，而种子原先只按
  //   **连通分量**分组，同一个主题的分量被摊到画布各处（本机真实数据：`莉音/休眠舱` 21 个成员散在
  //   8 个分量里，`comfyui/dsh-memory` 195 个成员散在 140 个分量里）→ 主题范围圈于是巨大到罩住
  //   半个画布、圈里全是别家的点。现在把**同一主题的所有分量装进同一个组团**，主题范围圈随之收紧到
  //   组团大小 —— 这是**结构保证**，不是"画得好看一点"。
  // 无主题的节点**不组队**（没有语义可聚），按散件身份排在最外圈；本机 325 个无主题节点里绝大多数
  //   是孤立点，于是"孤立点在外圈"的老规矩依然成立。
  const GAP_COMP = 0.4 * dEq    // 分量槽间隙 → 跨分量最近成员距 ≥ 0.8·dEq（紧于平衡距离 1.0，场会推开）
  const GAP_BLOCK = 0.5 * dEq   // 组团槽间隙 → 不同主题之间留得出白（相邻组团最近成员距 ≥ 1.0·dEq）
  const slotOf = (it) => discR(it.size) + GAP_COMP
  const themeLists = new Map()
  const lone = []
  for (const it of items) {
    if (it.theme) {
      if (!themeLists.has(it.theme)) themeLists.set(it.theme, [])
      themeLists.get(it.theme).push(it)
    } else lone.push(it)
  }
  // ① 组团内装箱：同一主题的分量装成一坨（组内仍是"大分量在正中"）
  const blocks = []
  for (const [theme, list] of themeLists) {
    list.sort(bySize)
    const inner = packDiscs(list.map(slotOf), dEq)
    blocks.push({ theme, list, offs: inner.pos, R: inner.R })
  }
  // ② 组团之间装箱：面积大的占内圈（"连接越多越靠中心"在**主题**这一级同样成立）
  blocks.sort((a, b) => b.R - a.R || String(a.theme).localeCompare(String(b.theme)))
  lone.sort((a, b) => slotOf(b) - slotOf(a) || bySize(a, b))
  const outerSlots = blocks.map((b) => b.R + GAP_BLOCK).concat(lone.map(slotOf))
  const outer = packDiscs(outerSlots, dEq)
  const place = (it, px, py) => {
    const offs = local(it.members.length, discR(it.size))
    it.members.forEach((nd, i) => positions.set(nd.id, [px + offs[i][0], py + offs[i][1]]))
  }
  blocks.forEach((b, i) => {
    const bc = outer.pos[i]
    b.list.forEach((it, j) => place(it, bc[0] + b.offs[j][0], bc[1] + b.offs[j][1]))
  })
  lone.forEach((it, k) => {
    const p = outer.pos[blocks.length + k]
    place(it, p[0], p[1])
  })

  // 整体归到画布中心（不是力，只是平移）
  let sx = 0, sy = 0
  for (const [, p] of positions) { sx += p[0]; sy += p[1] }
  const cx = sx / positions.size - W / 2, cy = sy / positions.size - H / 2
  for (const [id, p] of positions) positions.set(id, [p[0] - cx, p[1] - cy])
  return { positions, groups, k, dEq }
}
