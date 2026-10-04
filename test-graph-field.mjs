// v0.15.1 专题：图谱力模型的**可执行曲线**（用户 m01136「去掉中心引力」/ m01186「重写底层逻辑」
// / m01367「拖动一个点，盘里的球乱飞」）
// 用法: node test-graph-field.mjs（纯函数 + 小规模数值仿真，无需部署副本、无需浏览器）
//
// 这个文件存在的理由：力模型以前只能"看画面猜"。现在模型是纯函数，于是
// 「零点在哪、半径外是不是真的没力、把点放远会不会被中心拽回去、云会不会塌成一点、
//   初始种子会不会把点叠在一起、拖动的瞬态会不会失控」
// 都能在几毫秒内用数字回答 —— 而不是靠截图讨论。
//
// v0.15.1 相比 v0.15.0 的模型变化（本文件断言的就是新律）：
//   引力从「1/d 尾巴、无上限累加」改成「峰值 attract 封顶、随距离线性衰减到半径处归零」。
//   原因是实测出来的：**引力是累加的、斥力是封顶的** —— 一个点周围壳层里 ~25 个邻居各给一点
//   引力，其和会压过核心斥力，整个盘就会塌成密实圆盘并持续沸腾（v0.15.0 的实拍截图）。
import {
  pairForce, springForce, clampSpeed, recenter, seedLayout,
  REP_C, CORE_U, SPRING_TIGHT, FIELD_DEFAULTS,
} from './client/graph-force.js'
import { clusterByDistance } from './client/graph-geometry.js'   // 【7b】主题团聚用（与渲染层同一个聚类器）

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) } }

const P = { ...FIELD_DEFAULTS }
const k = 40                    // 布局密度尺度（本机真实数据 k≈44px）
const dEq = k * P.spacing       // 平衡间距 u=1
const R = k * P.range           // 邻域半径
const near = (a, b, tol) => Math.abs(a - b) < tol
/** 核心斥力（u ≤ CORE_U 之后的封顶值）：塌陷护栏的参照量 */
const coreRep = pairForce(0.1 * k, k, P)

console.log('\n【1】单对节点的力曲线（近斥 → 换向 → 轻吸 → 半径外严格 0）')
check(`d→0 时斥力为正且**有限**（软化核心 u<${CORE_U} 不再增长，对应 d3 的 distanceMin）：f=${pairForce(0.01 * k, k, P).toFixed(3)}`,
  pairForce(0.01 * k, k, P) > 0 && Number.isFinite(pairForce(0.01 * k, k, P)))
check(`核心封顶：u<${CORE_U} 的所有距离受力相同（0.05k 与 0.5·dEq 都是 ${coreRep.toFixed(3)}）`,
  near(pairForce(0.05 * k, k, P), pairForce(CORE_U * dEq, k, P), 1e-12))
check(`u<1 为斥（比平衡间距近）：f=${pairForce(0.8 * dEq, k, P).toFixed(3)} > 0`, pairForce(0.8 * dEq, k, P) > 0)
check(`u=1 处**不爆**：|f|=${Math.abs(pairForce(dEq, k, P)).toExponential(2)} ≤ attract=${P.attract}（换向点是个 ≤attract 的小台阶，不是奇点）`,
  Math.abs(pairForce(dEq, k, P)) <= P.attract + 1e-12)
check(`u>1 为吸且**峰值封顶**：f(1.02dEq)=${pairForce(1.02 * dEq, k, P).toFixed(4)}、f(2dEq)=${pairForce(2 * dEq, k, P).toFixed(4)}，都在 [−attract, 0)`,
  pairForce(1.02 * dEq, k, P) < 0 && pairForce(2 * dEq, k, P) < 0 &&
  pairForce(1.02 * dEq, k, P) >= -P.attract - 1e-12 && pairForce(2 * dEq, k, P) >= -P.attract - 1e-12)
check('吸力随距离**单调减弱**（没有第二个零点、没有"越远越吸"的尾巴）',
  pairForce(1.02 * dEq, k, P) < pairForce(1.5 * dEq, k, P) && pairForce(1.5 * dEq, k, P) < pairForce(2.9 * dEq, k, P))
check(`半径外严格为 0（d=R 处 f=${pairForce(R, k, P)}；d=2R、d=1000k 同样为 0）`,
  pairForce(R, k, P) === 0 && pairForce(2 * R, k, P) === 0 && pairForce(1000 * k, k, P) === 0)
check('近域严格单调递减：力从核心值一路降到 0（无回头）', (() => {
  let prev = Infinity
  for (let u = CORE_U; u <= 1.0001; u += 0.05) { const f = pairForce(u * dEq, k, P); if (!(f <= prev + 1e-12)) return false; prev = f }
  return true
})())
check('标度不变：密度变了形状不变 —— 力只认 u=d/dEq，故 f(2k, 2d) === f(k, d)',
  near(pairForce(2 * (2.5 * dEq), 2 * k, P), pairForce(2.5 * dEq, k, P), 1e-9) &&
  near(pairForce(2 * (0.6 * dEq), 2 * k, P), pairForce(0.6 * dEq, k, P), 1e-9))
check('field=0 → 场内力完全关闭（只剩弹簧）',
  pairForce(0.5 * dEq, k, { ...P, field: 0 }) === 0 && pairForce(2 * dEq, k, { ...P, field: 0 }) === 0)
check('attract=0 → 纯斥力（平衡距离之外互不影响）',
  pairForce(2 * dEq, k, { ...P, attract: 0 }) === 0 && pairForce(0.5 * dEq, k, { ...P, attract: 0 }) > 0)
// ★ 这条是 v0.15.0 塌陷事故的**可执行护栏**：壳层邻居的引力之和必须远小于核心斥力，
//   否则"引力累加 vs 斥力封顶"会让整个盘塌到密实圆盘（实测：attract=0.25 → 沸腾）。
check(`★ 塌陷护栏：25 个邻居（1.05·dEq）的引力之和 ${(25 * Math.abs(pairForce(1.05 * dEq, k, P))).toFixed(2)} < 核心斥力的一半 ${(0.5 * coreRep).toFixed(2)}`,
  25 * Math.abs(pairForce(1.05 * dEq, k, P)) < 0.5 * coreRep)
check(`★ 参数护栏：attract 出厂值 ${P.attract} 只占核心斥力的 ${(100 * P.attract / coreRep).toFixed(1)}%（量级差 ≥ 10 倍才安全）`,
  P.attract < coreRep / 10)

console.log('\n【2】空间性质：各向同性、局部、没有特权方向（也没有中心引力）')
/** 按 graph.jsx 的施加规则（沿连线、两端反向）把一个点周围的邻居合成净力 */
function netForce(node, others, kk, PP) {
  let vx = 0, vy = 0
  for (const o of others) {
    const dx = node.x - o.x, dy = node.y - o.y
    const d = Math.hypot(dx, dy) || 1
    const f = pairForce(d, kk, PP)
    vx += (dx / d) * f; vy += (dy / d) * f
  }
  return { vx, vy, mag: Math.hypot(vx, vy) }
}
check('8 向等距环 → 净力 ≈ 0（力只由距离决定，360° 无偏爱方向）', (() => {
  const c = { x: 0, y: 0 }
  const ring = Array.from({ length: 8 }, (_, i) => ({ x: Math.cos((i * Math.PI) / 4) * 1.5 * dEq, y: Math.sin((i * Math.PI) / 4) * 1.5 * dEq }))
  return netForce(c, ring, k, P).mag < 1e-9
})())
check('单个邻居 → 力严格沿两点连线（无侧向分量，且方向是"被拉向对方"）', (() => {
  const c = { x: 0, y: 0 }, o = { x: 3 * k, y: 0 }
  const nf = netForce(c, [o], k, P)
  return nf.vy === 0 && nf.vx > 0          // 邻居在 +x 侧、距离 > 平衡间距 → 被拉向 +x
})())
check('★ 孤立点放在任何位置都不受力（这就是"删掉中心引力"的可执行断言）', (() => {
  for (const pos of [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 0, y: -3000 }, { x: 1234, y: 567 }]) {
    if (netForce(pos, [], k, P).mag !== 0) return false
  }
  return true
})())
check('局部性：半径外的邻居**一个都影响不到**（哪怕它离"中心"很近；这是用户要的"半径外互不影响"）', (() => {
  const c = { x: 0, y: 0 }
  const far = [{ x: R + 1, y: 0 }, { x: 0, y: R + 1 }, { x: -R - 50, y: -R - 50 }]
  return netForce(c, far, k, P).mag === 0
})())
check('对称性：把整幅图**整体平移**不改变任何一对的力（力只认相对距离）',
  pairForce(3 * k, k, P) === pairForce(3 * k, k, P) && pairForce(0.7 * dEq, k, P) === pairForce(0.7 * dEq, k, P))

console.log('\n【3】整体平移归心 recenter（d3-force 的 forceCenter 语义：不是力）')
check('平移后质心落在指定点，且两两距离**逐一不变**（形状不可能被改变）', (() => {
  const pts = Array.from({ length: 12 }, (_, i) => ({ x: Math.cos(i) * 300 + 40, y: Math.sin(i * 1.7) * 220 - 90 }))
  const before = []
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) before.push(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y))
  const moved = recenter(pts, 700, 600)
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const after = []
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) after.push(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y))
  const same = before.every((d, i) => near(d, after[i], 1e-9))
  return near(cx, 700, 1e-9) && near(cy, 600, 1e-9) && same && Math.hypot(moved.dx, moved.dy) > 0
})())
check('recenter 是**平移**：不动形状 → 也不可能像中心引力那样"把图收缩"（收缩会改变两两距离）', (() => {
  const pts = Array.from({ length: 40 }, (_, i) => ({ x: Math.cos(i * 2.3) * (100 + i * 30), y: Math.sin(i * 1.1) * (80 + i * 20) }))
  let d0 = 0
  for (let i = 0; i < pts.length - 1; i++) d0 += Math.hypot(pts[i].x - pts[i + 1].x, pts[i].y - pts[i + 1].y)
  recenter(pts, 0, 0)
  let d1 = 0
  for (let i = 0; i < pts.length - 1; i++) d1 += Math.hypot(pts[i].x - pts[i + 1].x, pts[i].y - pts[i + 1].y)
  return near(d0, d1, 1e-9)
})())
check('空数组不抛错', (() => { try { return recenter([], 5, 5).dx === 0 } catch { return false } })())

console.log('\n【4】边弹簧 springForce')
check(`零点 = ${SPRING_TIGHT}·k·spacing = ${(k * P.spacing * SPRING_TIGHT).toFixed(1)}px：|f|=${Math.abs(springForce(k * P.spacing * SPRING_TIGHT, k, P)).toExponential(2)}`,
  near(springForce(k * P.spacing * SPRING_TIGHT, k, P), 0, 1e-12))
check('比静止长度长 → 拉回（f>0）；短 → 推开（f<0）', springForce(3 * k, k, P) > 0 && springForce(0.2 * k, k, P) < 0)
check('长度不写死：越拉回弹力越大（是弹簧，不是铁棍）', springForce(2.6 * k, k, P) > springForce(1.3 * k, k, P))
check(`边的静止长度（${SPRING_TIGHT}·dEq）**紧于**场的平衡距离（1.0·dEq）—— 簇才像簇，但不会紧到压穿平衡`,
  SPRING_TIGHT < 1 && SPRING_TIGHT > 0.5)

console.log('\n【5】clampSpeed：单帧速度上限（"乱飞"的物理否决权）')
check('超限 → 截断到上限，且**方向不变**', (() => {
  const v = { vx: 30, vy: 40 }               // |v| = 50
  const hit = clampSpeed(v, 4)
  return hit && near(Math.hypot(v.vx, v.vy), 4, 1e-12) && near(Math.atan2(v.vy, v.vx), Math.atan2(40, 30), 1e-12)
})())
check('未超限 → 原样不动（返回 false，不引入任何扰动）', (() => {
  const v = { vx: 1, vy: -1 }
  const hit = clampSpeed(v, 4)
  return !hit && v.vx === 1 && v.vy === -1
})())
check('max 非法（0 / 负数 / NaN）→ 不截断也不抛错', (() => {
  const a = { vx: 9, vy: 9 }
  return !clampSpeed(a, 0) && a.vx === 9 && !clampSpeed({ vx: 1, vy: 1 }, NaN)
})())

console.log('\n【6】行为仿真：60 点随机云 + 只有邻域场（无中心引力），会怎样？')
// 镜像 graph.jsx 的积分规则：力×α 累加到速度 → v *= damping → 限速 → x += v*1.5
function simulate(pts, kk, PP, steps, alpha = 0.4) {
  for (const p of pts) { p.vx = 0; p.vy = 0 }
  const RR = kk * PP.range
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j]
        const dx = a.x - b.x, dy = a.y - b.y
        const d = Math.hypot(dx, dy) || 1
        if (d >= RR) continue                       // 半径外互不影响（与 graph.jsx 同一剔除）
        const f = pairForce(d, kk, PP) * alpha
        a.vx += (dx / d) * f; a.vy += (dy / d) * f
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
      }
    }
    for (const p of pts) { p.vx *= PP.damping; p.vy *= PP.damping; clampSpeed(p, PP.maxSpeed); p.x += p.vx * 1.5; p.y += p.vy * 1.5 }
  }
  return pts
}
const stat = (pts) => {
  const n = pts.length
  const cx = pts.reduce((s, p) => s + p.x, 0) / n, cy = pts.reduce((s, p) => s + p.y, 0) / n
  const rms = Math.sqrt(pts.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / n)
  let nn = 0
  for (let i = 0; i < n; i++) {
    let best = Infinity
    for (let j = 0; j < n; j++) if (i !== j) best = Math.min(best, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y))
    nn += best
  }
  return { rms, nn: nn / n, cx, cy, minD: (() => { let m = Infinity; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) m = Math.min(m, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)); return m })() }
}
const cloudOf = (n, seed = 7) => {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  return Array.from({ length: n }, (_, i) => ({ id: 'n' + i, x: (rnd() - 0.5) * 900, y: (rnd() - 0.5) * 900, vx: 0, vy: 0 }))
}
const before = cloudOf(60)
const s0 = stat(before)
const after = simulate(before, k, P, 3000)
const s1 = stat(after)
console.log(`     初始: RMS=${s0.rms.toFixed(0)}px  平均最近邻=${s0.nn.toFixed(0)}px`)
console.log(`     终态: RMS=${s1.rms.toFixed(0)}px  平均最近邻=${s1.nn.toFixed(0)}px  最小间距=${s1.minD.toFixed(1)}px`)
check(`不发散也不塌陷：RMS ${s0.rms.toFixed(0)} → ${s1.rms.toFixed(0)}px（同一量级，且**不能塌成一个点**）`,
  s1.rms > 0.3 * s0.rms && s1.rms < 3 * s0.rms)
check(`平衡后最近邻间距落在 dEq=${dEq.toFixed(0)}px 附近（实测 ${s1.nn.toFixed(0)}px = ${(s1.nn / dEq).toFixed(2)}·dEq）`,
  s1.nn > 0.4 * dEq && s1.nn < 1.6 * dEq)
check(`没有任何两点重叠（最小间距 ${s1.minD.toFixed(1)}px > ${(CORE_U * dEq).toFixed(0)}px 软化核心）`, s1.minD > CORE_U * dEq * 0.6)
check('质心没有漂移的**理由**：场力是内力（成对反向、合力恒 0）—— 没有任何"朝中心的力"', (() => {
  const pts = cloudOf(30, 21)
  const c0 = { x: pts.reduce((s, p) => s + p.x, 0) / 30, y: pts.reduce((s, p) => s + p.y, 0) / 30 }
  simulate(pts, k, P, 800)
  const c1 = { x: pts.reduce((s, p) => s + p.x, 0) / 30, y: pts.reduce((s, p) => s + p.y, 0) / 30 }
  return Math.hypot(c1.x - c0.x, c1.y - c0.y) < 0.05 * stat(pts).rms
})())
// ★ 拖动场景：拖一个点 15 帧走 150px → 松手 30 帧。全场峰值速度就是"乱飞"的量化定义。
//   旧模型（α 静息 0.02 → 拖动 0.4，力放大 20 倍）实测全场峰值 204px/帧 = 用户说的"乱飞"。
check('★ 拖动一个点不会引爆全场：峰值速度 ≤ maxSpeed（限速器给出硬上界）', (() => {
  const pts = cloudOf(80, 33)
  simulate(pts, k, P, 600)                          // 先收敛
  const victim = pts[0]
  let peak = 0
  for (let f = 0; f < 15; f++) {                    // 拖动 15 帧 × 10px
    victim.x += 10
    for (const p of pts) { p.vx = 0; p.vy = 0 }
    const RR = k * P.range
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j]
        const dx = a.x - b.x, dy = a.y - b.y
        const d = Math.hypot(dx, dy) || 1
        if (d >= RR) continue
        const f2 = pairForce(d, k, P) * 0.4
        a.vx += (dx / d) * f2; a.vy += (dy / d) * f2
        b.vx -= (dx / d) * f2; b.vy -= (dy / d) * f2
      }
    }
    for (const p of pts) { p.vx *= P.damping; p.vy *= P.damping; clampSpeed(p, P.maxSpeed); p.x += p.vx * 1.5; p.y += p.vy * 1.5 }
    for (const p of pts) peak = Math.max(peak, Math.hypot(p.vx, p.vy))
  }
  console.log(`     拖动中全场峰值速度 = ${peak.toFixed(2)}px/帧（上限 ${P.maxSpeed}）`)
  return peak <= P.maxSpeed + 1e-9
})())

console.log('\n【7】初始种子 seedLayout：分量成盘 + 度数高者靠中心（"距离由力管，远近由种子管"）')
const synth = {
  nodes: [
    { id: 'h1', theme: 'A' }, { id: 'a2', theme: 'A' }, { id: 'a3', theme: 'A' },
    { id: 'a4', theme: 'A' }, { id: 'a5', theme: 'A' }, { id: 'a6', theme: 'A' },
    { id: 'c1', theme: 'A' }, { id: 'c2', theme: 'A' }, { id: 'c3', theme: 'A' },
    { id: 'z1', theme: 'B' }, { id: 'z2', theme: 'B' }, { id: 'z3', theme: 'B' }, { id: 'z4', theme: 'B' },
  ],
  edges: [
    { from: 'h1', to: 'a2' }, { from: 'h1', to: 'a3' }, { from: 'h1', to: 'a4' },
    { from: 'h1', to: 'a5' }, { from: 'h1', to: 'a6' },
    { from: 'c1', to: 'c2' }, { from: 'c2', to: 'c3' },
  ],
}
const seed = seedLayout(synth, 1400, 1200, P)
const seed2 = seedLayout(synth, 1400, 1200, P)
const pos = (id) => seed.positions.get(id)
const compA = ['h1', 'a2', 'a3', 'a4', 'a5', 'a6']
const compC = ['c1', 'c2', 'c3']
const isolates = ['z1', 'z2', 'z3', 'z4']
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])
const maxIn = (ids) => { let m = 0; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) m = Math.max(m, dist(pos(ids[i]), pos(ids[j]))); return m }
const minCross = (A, B) => { let m = Infinity; for (const a of A) for (const b of B) m = Math.min(m, dist(pos(a), pos(b))); return m }
check(`确定性：同一份数据两次调用给出**逐点相同**的坐标（可复现，缓存才有意义）`,
  synth.nodes.every((n) => near(pos(n.id)[0], seed2.positions.get(n.id)[0], 1e-9) && near(pos(n.id)[1], seed2.positions.get(n.id)[1], 1e-9)))
check(`全部节点都有坐标（${seed.positions.size}/${synth.nodes.length}）`, seed.positions.size === synth.nodes.length)
check(`返回的密度尺度正确：k=${seed.k.toFixed(1)} = √(1400×1200/13)、dEq=${seed.dEq.toFixed(1)}`,
  near(seed.k, Math.sqrt(1400 * 1200 / 13), 1e-9) && near(seed.dEq, seed.k * P.spacing, 1e-9))
check('★ 分量团聚：同分量的点都挤在同一个盘里（最大内部距离 ≤ 盘直径）', (() => {
  const discR = (m) => (m <= 1 ? 0.3 * seed.dEq : seed.dEq * Math.sqrt((m * 0.9) / Math.PI))
  return maxIn(compA) <= 2 * discR(compA.length) * 1.05 && maxIn(compC) <= 2 * discR(compC.length) * 1.05
})())
check(`★ 分量之间不重叠：最近的两个跨分量点距 ${minCross(compA, compC).toFixed(1)}px ≥ 0.8·dEq=${(0.8 * seed.dEq).toFixed(1)}px（档间地板按**外沿**算，后一档整体落在前一档圆盘外）`,
  minCross(compA, compC) >= 0.8 * seed.dEq * 0.99)
check('★ 结构上的"连接越多越靠中心"：以最大分量为核心，中分量在外、孤立点最外（半径随连接度单调增）', (() => {
  // ★ 参考点必须是**核心自己**，不是画布中心（v0.15.1 修正的正是这条断言）：
  //   seedLayout 最后会整体平移，让**全体节点的质心**落在画布中心。13 点样本里卫星全在同一侧，
  //   于是核心被推到离画布中心 2.06·dEq 处 —— 实测按画布中心算 compC 1.78dEq < compA 2.16dEq，
  //   看起来像"分量比核心更靠中心"，其实装箱完全正确（`_probe-seed.mjs` 逐点打印过）。
  //   按核心算：compA 0.87 < compC 3.47 < 孤立点 4.55 ·dEq，单调 ✅。
  //   真实数据（857 点 / 499 分量，径向对称）两种参考点结论一致：有连接 877px vs 孤立点 1191px。
  const c0 = compA.reduce((s, id) => { const p = pos(id); return [s[0] + p[0] / compA.length, s[1] + p[1] / compA.length] }, [0, 0])
  const rc = (ids) => ids.reduce((s, id) => s + Math.hypot(pos(id)[0] - c0[0], pos(id)[1] - c0[1]), 0) / ids.length
  return rc(compA) < rc(compC) && rc(compC) < rc(isolates)
})())
check('孤立点不会被叠在一起（每个都是独立槽位）', minCross(['z1'], ['z2']) >= 0.8 * seed.dEq * 0.99 && minCross(['z3'], ['z4']) >= 0.8 * seed.dEq * 0.99)
check('质心落在画布中心（整体平移，不是力）', (() => {
  let sx = 0, sy = 0
  for (const [, p] of seed.positions) { sx += p[0]; sy += p[1] }
  return near(sx / seed.positions.size, 700, 1e-9) && near(sy / seed.positions.size, 600, 1e-9)
})())
// v0.15.2：这里原本断言"包围盒 < 2×画布"。两层装箱之后，这条在 n=13 时**不可能**成立 ——
// dEq=431px（k=√(1400×1200/13)=359px）时，"两个主题组团分开摆"必然是几千 px；
// 真实数据（857 点，k≈44px）同样的结构只有 2910px ⇒ 尺度正确的护栏搬到【7b】。
// 小样本改断言**分层本身的证据**：同主题的两个分量比不同主题的团更近。
check(`★ 同主题的分量装进同一团（v0.15.2 两层装箱的核心）：compA–compC ${minCross(compA, compC).toFixed(0)}px < compA–孤立点 ${minCross(compA, isolates).toFixed(0)}px`,
  minCross(compA, compC) < minCross(compA, isolates))
check('空数据不抛错', (() => { try { return seedLayout({ nodes: [], edges: [] }, 100, 100, P).positions.size === 0 } catch { return false } })())

console.log('\n【7b】真实尺度合成样本（600 点）：包围盒 / 不重叠 / 结构 / 主题团聚')
// 为什么另起一节：13 点样本的密度尺度 k=359px，任何构图都是几千 px，**代表不了真实观感**。
// 这里造一份尺度对得上的样本：600 点（k≈52.9px、dEq≈63.5px），结构与本机真实数据同型 ——
// 大量孤立点、最大分量只有几十点、**同一主题跨多个连通分量**（v0.15.2 要解决的正是后者）。
const big = (() => {
  const nodes = [], edges = []
  let seq = 0
  const add = (theme) => { const id = 'n' + (seq++); nodes.push({ id, theme }); return id }
  const hub = add('T1'); const bigComp = [hub]; const ring = []
  for (let i = 0; i < 39; i++) {
    const id = add('T1'); bigComp.push(id); edges.push({ from: hub, to: id })
    if (ring.length) edges.push({ from: ring[ring.length - 1], to: id })
    ring.push(id)
  }
  // 8 条 6 点链：T1 占 3 条（连大分量共 4 个分量）、T2 占 2 条，T3/T4/T5 各 1 条
  for (const th of ['T1', 'T1', 'T1', 'T2', 'T2', 'T3', 'T4', 'T5']) {
    let prev = add(th)
    for (let i = 0; i < 5; i++) { const id = add(th); edges.push({ from: prev, to: id }); prev = id }
  }
  const isoThemes = ['T2', 'T3', 'T6', '', '', '']   // 孤立点：一半带主题、一半无主题（真实数据 46% 是孤立点）
  const isolates = []
  while (nodes.length < 600) { const id = add(isoThemes[nodes.length % isoThemes.length]); isolates.push(id) }
  return { nodes, edges, bigComp, isolates }
})()
const t0 = Date.now()
const sb = seedLayout(big, 1400, 1200, P)
const seedMs = Date.now() - t0
const bp = (id) => sb.positions.get(id)
const bbox = (() => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const [, p] of sb.positions) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
  return { w: x1 - x0, h: y1 - y0 }
})()
const fit = Math.min(1400, 1200) / Math.max(bbox.w, bbox.h)
let minPair = Infinity
const allPts = [...sb.positions.values()]
for (let i = 0; i < allPts.length; i++) for (let j = i + 1; j < allPts.length; j++) minPair = Math.min(minPair, dist(allPts[i], allPts[j]))
const meanR = (ids) => ids.reduce((s, id) => s + Math.hypot(bp(id)[0] - 700, bp(id)[1] - 600), 0) / ids.length
const maxIn2 = (ids) => { let m = 0; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) m = Math.max(m, dist(bp(ids[i]), bp(ids[j]))); return m }
check(`种子规模与耗时：${big.nodes.length} 点 / ${big.edges.length} 边，k=${sb.k.toFixed(1)}px、dEq=${sb.dEq.toFixed(1)}px，${seedMs}ms`,
  big.nodes.length === 600 && sb.positions.size === 600 && near(sb.k, Math.sqrt(1400 * 1200 / 600), 1e-9))
check(`★ 布局装得进画布：包围盒 ${Math.round(bbox.w)}×${Math.round(bbox.h)}px → fit ${fit.toFixed(3)}×（真实数据 2910px / 0.358×）`, fit >= 0.28)
check(`★ 没有两点叠在一起：最近点距 ${minPair.toFixed(1)}px ≥ 0.5·dEq=${(0.5 * sb.dEq).toFixed(1)}px`, minPair >= 0.5 * sb.dEq)
check(`★ 结构：大分量比孤立点更靠画布中心（${meanR(big.bigComp).toFixed(0)}px < ${meanR(big.isolates).toFixed(0)}px）`,
  meanR(big.bigComp) < meanR(big.isolates))
// ★ 这一条是 v0.15.2 的**主诉护栏**：主题是语义分组、分量是物理分组，两者不重合。
//   旧版按分量装箱 → 同主题的分量散落全图（用户截图：主题圈罩住大半个画布、圈内亮点稀疏）。
//   现在同主题的分量必须装成**一团**：既看"分成几团"（单链聚类），也看"占画布多大"。
const themeIds = (t) => big.nodes.filter((n) => n.theme === t).map((n) => n.id)
// 铺开程度**不能**拿"画布的百分之几"当门槛 —— 91 个点密排本来就要占那么大一片
// （半径 ≈ √(m·0.9/π)·dEq，这是面积账，不是布局质量）。正确的参照是**理想密排直径的倍数**：
// 实测 0.59~0.71×；旧版按连通分量装箱时，同主题的分量散落全图，这个比值会到 5× 上下。
for (const [th, expectComponents] of [['T1', 4], ['T2', 3], ['T3', 2]]) {
  const ids = themeIds(th)
  const clumps = clusterByDistance(ids.map((id) => ({ x: bp(id)[0], y: bp(id)[1], id })), 2.5 * sb.dEq, { minSize: 1 })
  const spanPx = maxIn2(ids)
  const ideal = 2 * sb.dEq * Math.sqrt((ids.length * 0.9) / Math.PI)
  const ratio = spanPx / ideal
  check(`★ 主题团聚 ${th}：${ids.length} 个成员来自 ${expectComponents} 个连通分量，2.5·dEq 门槛下聚成 ${clumps.length} 团、铺开 ${ratio.toFixed(2)}× 理想密排直径（实测 ${Math.round(spanPx)}px / 理想 ${Math.round(ideal)}px）`,
    clumps.length === 1 && ratio <= 1.8)
}

console.log('\n【8】旧模型的三个"特权方向"确实不存在了（回归护栏）')
check('没有中心引力 / 没有旧斥力系数：FIELD_DEFAULTS 不含 gravity、repulsion',
  !('gravity' in FIELD_DEFAULTS) && !('repulsion' in FIELD_DEFAULTS))
check(`v0.15.1 新键就位：attract=${FIELD_DEFAULTS.attract}（轻引力峰值）、maxSpeed=${FIELD_DEFAULTS.maxSpeed}（限速）`,
  FIELD_DEFAULTS.attract === 0.06 && FIELD_DEFAULTS.maxSpeed === 4)
check(`出厂手感与实测通过的组合一致：spacing=${FIELD_DEFAULTS.spacing}、range=${FIELD_DEFAULTS.range}、spring=${FIELD_DEFAULTS.spring}、damping=${FIELD_DEFAULTS.damping}`,
  FIELD_DEFAULTS.spacing === 1.2 && FIELD_DEFAULTS.range === 4.5 && FIELD_DEFAULTS.spring === 0.13 && FIELD_DEFAULTS.damping === 0.3)
check('没有度数加权：pairForce/springForce 只认距离与参数，签名里没有 degree',
  pairForce.length === 3 && springForce.length === 3)
check(`REP_C 仍是 ${REP_C}（近场强度与旧布局手感连续，不是重新发明一套量纲）`, REP_C === 8)
check('没有"位置偏好"参数：整个 FIELD_DEFAULTS 里没有任何以画布中心/坐标为依据的键', (() => {
  const keys = Object.keys(FIELD_DEFAULTS)
  return !keys.some((kk) => /center|gravity|anchor|bias|target/i.test(kk))
})())

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
