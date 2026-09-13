// v0.10.5 专题：主题圈几何守护（贴合凸包 / 最小外接圆 / 随中心移动）
// 用法: node test-graph-geometry.mjs（纯函数，无需部署副本环境）
import { convexHull, padConvexPolygon, polygonContains, minimalEnclosingCircle, circleContains, themeBounds } from './client/graph-geometry.js'

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) } }
const P = (x, y) => ({ x, y })
const area = (poly) => {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}
const allInside = (poly, pts) => pts.every((p) => polygonContains(poly, p, 1e-6))
const allInCircle = (c, pts) => pts.every((p) => circleContains(c, p, 1e-6))
/** 暴力最优最小外接圆（枚举 1/2/3 点确定的圆，取覆盖全部点的最小者）——用于校验 Welzl 的最优性 */
function bruteMec(pts) {
  const covers = (c) => pts.every((p) => Math.hypot(p.x - c.x, p.y - c.y) <= c.r + 1e-9)
  let best = null
  const consider = (c) => { if (c && covers(c) && (!best || c.r < best.r)) best = c }
  for (const p of pts) consider({ x: p.x, y: p.y, r: 0 })
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j]
      consider({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: Math.hypot(a.x - b.x, a.y - b.y) / 2 })
      for (let k = j + 1; k < pts.length; k++) {
        const c = pts[k]
        const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
        if (Math.abs(d) < 1e-12) continue
        const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y
        const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d
        const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
        consider({ x: ux, y: uy, r: Math.hypot(ux - a.x, uy - a.y) })
      }
    }
  }
  return best
}

console.log('== 1. convexHull：凸包顶点与退化 ==')
{
  const tri = [P(0, 0), P(10, 0), P(0, 10), P(2, 2)] // 第 4 点在内部
  const h1 = convexHull(tri)
  check('三角形+内部点 → 3 个顶点（内部点被剔除）', h1.length === 3)
  check('凸包顶点集合正确', h1.some((p) => p.x === 0 && p.y === 0) && h1.some((p) => p.x === 10 && p.y === 0) && h1.some((p) => p.x === 0 && p.y === 10))
  const col = [P(0, 0), P(5, 0), P(10, 0), P(5, 5)]
  check('共线中间点被剔除', convexHull(col).length === 3)
  check('重复点被剔除', convexHull([P(1, 1), P(1, 1), P(5, 1), P(1, 5)]).length === 3)
  check('单点/两点原样返回', convexHull([P(3, 4)]).length === 1 && convexHull([P(0, 0), P(1, 1)]).length === 2)
  check('空输入返回空', convexHull([]).length === 0 && convexHull(null).length === 0)
  check('非法坐标被过滤', convexHull([P(0, 0), P(NaN, 1), P(5, 5), { x: undefined, y: 2 }]).length === 2)
  const ccw = convexHull([P(0, 0), P(10, 0), P(10, 10), P(0, 10)])
  let s = 0
  for (let i = 0; i < ccw.length; i++) { const a = ccw[i], b = ccw[(i + 1) % ccw.length]; s += a.x * b.y - b.x * a.y }
  check('输出统一为逆时针（外法线方向可定）', s > 0)
}

console.log('== 2. padConvexPolygon：外扩刚好包住 ============')
{
  const hull = convexHull([P(0, 0), P(40, 0), P(40, 30), P(0, 30)])
  const pad = 12
  const grown = padConvexPolygon(hull, pad)
  const pts = [P(0, 0), P(40, 0), P(40, 30), P(0, 30), P(20, 15)]
  check('外扩后仍包含全部原始点', allInside(grown, pts))
  check('外扩后面积变大', area(grown) > area(hull))
  check('外扩距离贴合 pad（上边 y ≈ -pad）', Math.abs(Math.min(...grown.map((p) => p.y)) + pad) < 1e-6)
  check('外扩距离贴合 pad（右边 x ≈ 40+pad）', Math.abs(Math.max(...grown.map((p) => p.x)) - (40 + pad)) < 1e-6)
  const exact = padConvexPolygon(hull, 0)
  check('pad=0 原样返回（不无谓放大）', exact.length === hull.length && allInside(exact, pts) && Math.abs(area(exact) - area(hull)) < 1e-9)
  check('退化：单点/空点集不抛错', padConvexPolygon([P(1, 1)], 5).length === 1 && padConvexPolygon([], 5).length === 0)
}

console.log('== 3. minimalEnclosingCircle：最紧圆 ============')
{
  const two = [P(0, 0), P(10, 0)]
  const c2 = minimalEnclosingCircle(two)
  check('两点 → 圆心中点、r = 距离/2（严格最紧）', Math.abs(c2.x - 5) < 1e-9 && Math.abs(c2.r - 5) < 1e-9)
  const pts = [P(0, 0), P(30, 0), P(30, 20), P(0, 20), P(15, 10), P(6, 14), P(24, 3)]
  const c = minimalEnclosingCircle(pts)
  check('覆盖全部点', allInCircle(c, pts))
  const opt = bruteMec(pts)
  check('与暴力最优解一致（半径误差 < 1e-6）', Math.abs(c.r - opt.r) < 1e-6)
  const c2b = minimalEnclosingCircle(pts)
  check('确定性：同输入两次结果一致（逐帧无抖动）', c2b.x === c.x && c2b.y === c.y && c2b.r === c.r)
  check('空集返回 null', minimalEnclosingCircle([]) === null)
  const col = [P(0, 0), P(4, 0), P(10, 0)]
  check('共线点：r = 端点距离/2', Math.abs(minimalEnclosingCircle(col).r - 5) < 1e-9)
}

console.log('== 4. themeBounds：贴合形状 + 随中心移动 ============')
{
  // 弧状/条状分布（模拟力导向把同主题拉成长条——粗圆在这里最吃亏）
  const arc = [P(0, 0), P(30, 2), P(60, 8), P(90, 18), P(120, 32)]
  const b = themeBounds(arc, { shape: 'hull', pad: 10 })
  check('hull 模式返回凸包多边形', b.kind === 'hull' && b.points.length >= 3)
  check('全部成员被多边形包住（贴合不遗漏）', allInside(b.points, arc))
  check('标签锚点在多边形顶部（topY = 最小 y）', Math.abs(b.topY - Math.min(...b.points.map((p) => p.y))) < 1e-9)
  const mec = minimalEnclosingCircle(arc)
  check('贴合度：凸包面积 < 同点集最小外接圆面积（条状分布不再圈空地）', area(b.points) < Math.PI * (mec.r + 10) ** 2 * 0.9)
  // 随中心移动：整组平移 → 圈跟着平移同样的位移
  const dx = 37, dy = -21
  const moved = themeBounds(arc.map((p) => P(p.x + dx, p.y + dy)), { shape: 'hull', pad: 10 })
  check('随主题中心移动：包围盒随点集平移等量位移', Math.abs(moved.cx - (b.cx + dx)) < 1e-6 && Math.abs(moved.topY - (b.topY + dy)) < 1e-6)
  // circle 模式 = 最小外接圆 + pad（正圆盘形态的严格实现）
  const bc = themeBounds(arc, { shape: 'circle', pad: 10 })
  check('circle 模式：圆心/半径 = 最小外接圆 + pad', bc.kind === 'circle' && allInCircle({ x: bc.cx, y: bc.cy, r: bc.r }, arc) && Math.abs(bc.r - (mec.r + 10)) < 1e-6)
  // 退化与非法输入
  check('单点 → 圆（半径 = pad）', themeBounds([P(5, 5)], { pad: 8 }).kind === 'circle' && Math.abs(themeBounds([P(5, 5)], { pad: 8 }).r - 8) < 1e-9)
  check('两点 → 圆（无面可围）', themeBounds([P(0, 0), P(10, 0)], { pad: 4 }).kind === 'circle')
  check('空集 → null', themeBounds([]) === null)
  check('非法坐标被过滤后仍可用', themeBounds([P(0, 0), P(NaN, 1), P(10, 0), P(5, 9)]).kind === 'hull')
  check('pad 缺省不报错（默认 18）', themeBounds([P(0, 0), P(20, 0), P(10, 18)]).kind === 'hull')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
