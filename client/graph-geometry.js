/**
 * 图谱几何：主题范围（贴合凸包 / 最小外接圆）——纯函数，无 DOM/Canvas 依赖，可被 Node 守护测试直接引用。
 *
 * 为什么不用「质心 + 最远距离」的粗圆（v0.10.1 初版做法）：同主题节点在力导向下常被拉成弧状/条状，
 * 粗圆半径由最远点决定，会圈进大片不属于该主题的空白（甚至别组节点）——观感上既糊又不随组形变化。
 * v0.10.5 起按实际点位计算（每帧重算 → 圈随主题中心与组形实时移动）：
 *   - hull  ：凸包 + 沿边外法线外扩 padding —— 紧贴成员，是"刚好圈住"的默认形态；
 *   - circle：最小外接圆（确定性 Welzl）—— 仍是正圆盘，但已同点集最紧的圆（旧拍板样式的严格实现）。
 *
 * 坐标约定：调用方传的是画布世界坐标（可能 y 向下）；本模块只做数值运算，方向由有向面积归正，
 * 故与坐标系朝向无关。
 */

/** 有向面积二倍值（shoelace）：>0 表示数值意义上的逆时针。 */
function signedArea2(poly) {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return s
}

/**
 * 凸包（Andrew monotone chain）：返回逆时针顶点序列，剔除重复点与共线中间点。
 * 点数 <3 时原样返回（0/1/2 个点的退化情形由调用方转圆处理）。
 * @param {{x:number,y:number}[]} points
 * @returns {{x:number,y:number}[]}
 */
export function convexHull(points) {
  const pts = []
  for (const p of points ?? []) {
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) pts.push([p.x, p.y])
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const uniq = []
  for (const p of pts) {
    const last = uniq[uniq.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p)
  }
  if (uniq.length <= 2) return uniq.map(([x, y]) => ({ x, y }))
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  const hull = [...lower, ...upper].map(([x, y]) => ({ x, y }))
  return signedArea2(hull) < 0 ? hull.reverse() : hull // 统一为逆时针（外法线方向才有确定含义）
}

/** 两条直线（p + t·d）求交；平行时退化为取 l2 起点。 */
function intersectLines(l1, l2) {
  const den = l1.dx * l2.dy - l1.dy * l2.dx
  if (Math.abs(den) < 1e-9) return { x: l2.px, y: l2.py }
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den
  return { x: l1.px + l1.dx * t, y: l1.py + l1.dy * t }
}

/**
 * 凸多边形沿各边外法线外扩 pad（凸包专用：相邻两条偏移线求交得到新顶点）。
 * 凸包保证外扩后仍是凸多边形，且原多边形整体位于新多边形内部（含边界）。
 * @param {{x:number,y:number}[]} poly 逆时针凸多边形
 * @param {number} pad 外扩距离（世界坐标单位）
 */
export function padConvexPolygon(poly, pad) {
  const n = poly?.length ?? 0
  const width = Number(pad)
  if (n === 0 || !Number.isFinite(width) || width <= 0) return (poly ?? []).map((p) => ({ x: p.x, y: p.y }))
  if (n === 1) return [{ x: poly[0].x, y: poly[0].y }]
  const lines = []
  for (let i = 0; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    // 逆时针多边形的外法线：边方向 (dx,dy) 的右法线 (dy,-dx)
    const nx = dy / len
    const ny = -dx / len
    lines.push({ px: a.x + nx * width, py: a.y + ny * width, dx, dy })
  }
  const out = []
  for (let i = 0; i < n; i++) out.push(intersectLines(lines[(i - 1 + n) % n], lines[i]))
  return out
}

/** 点是否落在凸多边形内（含边界，带 eps 容差）。 */
export function polygonContains(poly, p, eps = 1e-6) {
  const n = poly?.length ?? 0
  if (n === 0) return false
  if (n === 1) return Math.hypot(p.x - poly[0].x, p.y - poly[0].y) <= eps
  if (n === 2) {
    const [a, b] = poly
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y) <= eps
    let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y))) <= eps
  }
  // 逆时针：点相对每条边的叉积非负（在边左侧或线上）
  for (let i = 0; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cr < -eps) return false
  }
  return true
}

/** 两点最小圆。 */
function circleFrom2(a, b) {
  const cx = (a.x + b.x) / 2
  const cy = (a.y + b.y) / 2
  return { x: cx, y: cy, r: Math.hypot(a.x - b.x, a.y - b.y) / 2 }
}

/** 三点最小圆：三点不共线取外接圆；共线时取最远点对的圆（退化最紧）。 */
function circleFrom3(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-12) {
    let best = null
    for (const [p, q] of [[a, b], [b, c], [a, c]]) {
      const t = circleFrom2(p, q)
      if (!best || t.r > best.r) best = t
    }
    return best
  }
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  return { x: ux, y: uy, r: Math.hypot(ux - a.x, uy - a.y) }
}

/** 点是否在圆内（含边界，带 eps 容差）。 */
export function circleContains(c, p, eps = 1e-6) {
  if (!c) return false
  return Math.hypot(p.x - c.x, p.y - c.y) <= c.r + eps
}

/** 确定性洗牌（mulberry32 固定种子 + Fisher-Yates）——同一输入永远同一顺序，逐帧调用无抖动。 */
function seededShuffle(input) {
  let seed = 0x9e3779b9
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const a = input.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = a[i]
    a[i] = a[j]
    a[j] = tmp
  }
  return a
}

/**
 * 最小外接圆（确定性 Welzl，迭代实现）：覆盖全部点的最紧圆。
 * @returns {{x:number,y:number,r:number}|null} 空集返回 null
 */
export function minimalEnclosingCircle(points) {
  const pts = []
  for (const p of points ?? []) {
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) pts.push({ x: p.x, y: p.y })
  }
  if (pts.length === 0) return null
  const shuffled = seededShuffle(pts)
  let c = null
  for (let i = 0; i < shuffled.length; i++) {
    const p = shuffled[i]
    if (c && circleContains(c, p, 1e-9)) continue
    c = { x: p.x, y: p.y, r: 0 }
    for (let j = 0; j < i; j++) {
      const q = shuffled[j]
      if (circleContains(c, q, 1e-9)) continue
      c = circleFrom2(p, q)
      for (let k = 0; k < j; k++) {
        const r = shuffled[k]
        if (circleContains(c, r, 1e-9)) continue
        c = circleFrom3(p, q, r)
      }
    }
  }
  return c
}

/**
 * 就地聚簇（单链 / union-find，门槛 = 欧氏距离）：把同主题成员按"谁挨着谁"拆成局部团。
 *
 * 为什么需要它（v0.10.6 教训）：同主题记忆在力导向布局里常散成好几坨、甚至绕场一周——
 * 直接对全部成员取凸包，凸边会把中间大量**别家节点**一并兜进来（实测：96 条成员的簇糊住半个画布）。
 * 先聚簇再各自取包围形状，才是"圈住这片相关的内容"而不是"圈住整块地图"。
 *
 * @param {{x:number,y:number}[]} points
 * @param {number} threshold 邻居判定距离（世界坐标单位）
 * @param {{minSize?:number}} opts 只返回成员数 ≥ minSize 的团（默认 1）
 * @returns {{x:number,y:number}[][]}
 */
export function clusterByDistance(points, threshold, { minSize = 1 } = {}) {
  const pts = (points ?? []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
  if (pts.length === 0) return []
  const d = Number(threshold)
  if (!Number.isFinite(d) || d <= 0) return pts.map((p) => [p])
  const n = pts.length
  const parent = new Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (i) => {
    let r = i
    while (parent[r] !== r) r = parent[r]
    while (parent[i] !== r) { const nx = parent[i]; parent[i] = r; i = nx }
    return r
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  // 按 x 排序 + 窗口剪枝：只需比较 x 距离 < threshold 的点对（避免全 O(n²)）
  const order = pts.map((p, i) => i).sort((a, b) => pts[a].x - pts[b].x)
  const d2 = d * d
  for (let i = 0; i < order.length; i++) {
    const a = pts[order[i]]
    for (let j = i + 1; j < order.length; j++) {
      const b = pts[order[j]]
      if (b.x - a.x > d) break
      const dx = a.x - b.x
      const dy = a.y - b.y
      if (dx * dx + dy * dy <= d2) union(order[i], order[j])
    }
  }
  const groups = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(pts[i])
  }
  const out = [...groups.values()].filter((g) => g.length >= Math.max(1, minSize))
  // 确定性排序（成员多者在前，其次按左上角）——逐帧顺序稳定，绘制层叠不闪
  out.sort((g1, g2) => g2.length - g1.length
    || Math.min(...g1.map((p) => p.y)) - Math.min(...g2.map((p) => p.y))
    || Math.min(...g1.map((p) => p.x)) - Math.min(...g2.map((p) => p.x)))
  return out
}

/**
 * 密度核心（v0.10.6）：只保留"身边有邻居"的成员，滤掉链状/条状的稀疏末端。
 *
 * 起因：单链聚簇会把**一串**彼此挨着、但整体拉得很长的同主题成员算作一团，其包围形状
 * 会罩进大片空地（实测：圈半径 ~200px 却只有零星几个点）。
 * 判据不能用"离圆心最远"——最小外接圆的边界点永远最远，等于每次都在剔点。
 * 改用密度：邻居数 ≥ minNeighbors（半径 eps 内）才算核心成员；核心不足 minSize → 返回空，
 * 调用方据此**不画**该区域（稀疏同主题本就成不了"一片区域"）。离群点仍以彩色节点显示。
 *
 * @param {{x:number,y:number}[]} points
 * @param {{eps?:number, minNeighbors?:number, minSize?:number}} opts
 *   eps 邻居判定半径（默认 1）；minNeighbors 核心所需邻居数（默认 2）；minSize 核心最小成员数（默认 3）
 * @returns {{x:number,y:number}[]} 核心成员；不足 minSize 时返回空数组
 */
export function densityCore(points, { eps = 1, minNeighbors = 2, minSize = 3 } = {}) {
  const pts = (points ?? []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
  const need = Math.max(1, Math.floor(minSize))
  if (pts.length < need) return []
  const e = Number(eps)
  if (!Number.isFinite(e) || e <= 0) return pts.slice(0, pts.length)
  const e2 = e * e
  const keep = []
  for (let i = 0; i < pts.length; i++) {
    let n = 0
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue
      const dx = pts[i].x - pts[j].x
      const dy = pts[i].y - pts[j].y
      if (dx * dx + dy * dy <= e2) {
        n++
        if (n >= minNeighbors) break
      }
    }
    if (n >= minNeighbors) keep.push(pts[i])
  }
  return keep.length >= need ? keep : []
}

/** 包围形状的外接矩形（world 坐标）：用于控件裁剪/碰撞与"过散不画"判定。 */
export function boundsBox(bounds) {
  if (!bounds) return null
  if (bounds.kind === 'circle') {
    return { minX: bounds.cx - bounds.r, minY: bounds.cy - bounds.r, maxX: bounds.cx + bounds.r, maxY: bounds.cy + bounds.r }
  }
  const xs = bounds.points.map((p) => p.x)
  const ys = bounds.points.map((p) => p.y)
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

/**
 * 主题范围统一入口：给一组成员（含实时世界坐标 x/y）算出贴合的形状。
 * 每帧调用即为"随主题中心/组形移动"。
 * @param {{x:number,y:number}[]} members
 * @param {{shape?:'hull'|'circle', pad?:number}} opts shape 默认 hull（贴合凸包）；pad 外扩距离（世界坐标单位）
 * @returns {{kind:'hull', points:{x:number,y:number}[], hull:{x:number,y:number}[], cx:number, cy:number, topY:number}
 *          |{kind:'circle', cx:number, cy:number, r:number, topY:number}|null}
 */
export function themeBounds(members, { shape = 'hull', pad = 18 } = {}) {
  const pts = (members ?? []).filter((m) => Number.isFinite(m?.x) && Number.isFinite(m?.y))
  if (pts.length === 0) return null
  const padPx = Number.isFinite(pad) && pad > 0 ? pad : 0
  const asCircle = () => {
    const c = minimalEnclosingCircle(pts)
    if (!c) return null
    return { kind: 'circle', cx: c.x, cy: c.y, r: c.r + padPx, topY: c.y - c.r - padPx }
  }
  if (shape === 'circle') return asCircle()
  const hull = convexHull(pts)
  // 退化（<3 个不共线点）：凸包撑不出面，退回最小外接圆（此时圆本身就是最紧形态）
  if (hull.length < 3) return asCircle()
  const poly = padConvexPolygon(hull, padPx)
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length
  const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length
  return { kind: 'hull', points: poly, hull, cx, cy, topY: Math.min(...poly.map((p) => p.y)) }
}
