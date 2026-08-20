/**
 * dsh-memory 客户端：记忆图谱（Obsidian 风格力导向画布 + 时间维度/事件可视化）。
 * 原 client/index.jsx 拆分（v0.10 解耦），注册到 sidebar.footer.action 插槽。
 */
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
const THEME_COLORS = [
  '#5b9bd5', '#70ad47', '#ffc000', '#e07b39', '#9e6fc2', '#d65c5c',
  '#4db6ac', '#a1887f', '#7986cb', '#f06292', '#26a69a', '#8d6e63',
]

/** 新旧色温（四维蠕虫的时间维度）：按创建时间把主题色压暗——新=原色亮，旧=暗。
 *  库内相对映射（minCreatedAt=库内最早创建时间）：任意时间跨度下新旧对比都明显。 */
function ageShade(hex, createdAt, minCreatedAt, now = Date.now()) {
  const span = Math.max(1, now - (minCreatedAt ?? now))
  const ratio = 1 - Math.max(0, Math.min(1, (now - (createdAt ?? now)) / span)) * 0.55
  const n = parseInt(String(hex).slice(1), 16)
  if (Number.isNaN(n)) return hex
  const r = Math.round(((n >> 16) & 255) * ratio)
  const g = Math.round(((n >> 8) & 255) * ratio)
  const b = Math.round((n & 255) * ratio)
  return `rgb(${r},${g},${b})`
}

/** 记忆时间筛选窗口。 */
const AGE_WINDOWS = [
  ['all', '全部'],
  ['7d', '近 7 天'],
  ['30d', '近 30 天'],
  ['90d', '近 90 天'],
  ['old', '90 天以上'],
]

/** 边类型 → 视觉样式（v0.9.11：让"多种联系方式"显性化——每型一色一型）。 */
const EDGE_STYLE = {
  similarTo:   { color: "#5b9bd5", dash: [],       w: 0.9,  alpha: 0.5 },
  before:      { color: "#e07b39", dash: [],       w: 0.75, alpha: 0.45 },
  mentions:    { color: "#8a8f98", dash: [3, 3],   w: 0.6,  alpha: 0.32 },
  partOf:      { color: "#70ad47", dash: [],       w: 0.9,  alpha: 0.5 },
  causes:      { color: "#e84118", dash: [],       w: 1.0,  alpha: 0.55 },
  solves:      { color: "#20c997", dash: [],       w: 0.95, alpha: 0.55 },
  supports:    { color: "#f3c623", dash: [],       w: 0.9,  alpha: 0.5 },
  contradicts: { color: "#e056fd", dash: [4, 3],   w: 1.0,  alpha: 0.5 },
}
const EDGE_ORDER = ["similarTo", "before", "mentions", "partOf", "causes", "solves", "supports", "contradicts"]
const EDGE_LABEL = { similarTo: "语义相似", before: "时间演化", mentions: "实体共现", partOf: "部分属于", causes: "导致", solves: "解决", supports: "支持", contradicts: "矛盾" }
/** 相对时间文案（中文）。 */
function agoText(ts, now = Date.now()) {
  const d = Math.max(0, Math.floor((now - ts) / (24 * 3600 * 1000)))
  if (d <= 0) return '今天'
  if (d < 30) return `${d} 天前`
  if (d < 365) return `${Math.floor(d / 30)} 个月前`
  return `${Math.floor(d / 365)} 年前`
}

/** 主题环形布局：每个主题一个扇区，组内节点均匀分布；返回 id → [x, y]。 */
function layoutNodes(data, W, H) {
  const cx = W / 2, cy = H / 2
  const themes = data.themes.length > 0 ? data.themes : ['(未归类)']
  const groups = new Map()
  for (const n of data.nodes) {
    const t = n.theme || '(未归类)'
    if (!groups.has(t)) groups.set(t, [])
    groups.get(t).push(n)
  }
  const positions = new Map()
  let idx = 0
  for (const [theme, members] of groups) {
    const ti = themes.indexOf(theme)
    const base = ti >= 0 ? (ti / themes.length) * 2 * Math.PI : (idx / groups.size) * 2 * Math.PI
    const spread = ((2 * Math.PI) / themes.length) * 0.88
    const R = 200
    members.forEach((n, i) => {
      const ang = members.length === 1
        ? base
        : base - spread / 2 + (spread * i) / (members.length - 1)
      const r = R + (i % 4) * 24
      positions.set(n.id, [cx + r * Math.cos(ang), cy + r * Math.sin(ang)])
    })
    idx++
  }
  return { positions, groups }
}

/** Obsidian 风格力导向图谱（Canvas 渲染）：
 *  物理：斥力 + 弹簧 + 中心引力 + 速度阻尼；alpha 冷却到阈值后停帧（省 CPU）
 *  交互：拖节点（固定 + 重新加热）、拖背景平移、滚轮以鼠标为中心缩放、hover 高亮邻居、点击选中
 *  性能：单 Canvas 每帧整绘（数百节点 <5ms）；选中/hover 经 ref 传入，组件零重渲染
 */
const ObsidianGraph = memo(function ObsidianGraph({ data, onSelect, selectedRef, drawRef, physics, focusIdsRef }) {
  const canvasRef = useRef(null)
  const hoverRef = useRef(null)
  const hoverEdgeRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    const dpr = window.devicePixelRatio || 1
    const P = physics ?? { spring: 0.13, repulsion: 1, damping: 0.3, gravity: 0.005 }
    const resize = () => {
      const rect = canvas.parentElement.getBoundingClientRect()
      canvas.width = Math.max(1, rect.width) * dpr
      canvas.height = Math.max(1, rect.height) * dpr
      canvas.style.width = rect.width + "px"
      canvas.style.height = rect.height + "px"
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener("resize", resize)
    const W = () => canvas.width / dpr, H = () => canvas.height / dpr

    // ---- 模拟状态 ----
    const colorOf = (theme) => {
      const i = data.themes.indexOf(theme)
      return i >= 0 ? THEME_COLORS[i % THEME_COLORS.length] : "#888"
    }
    const degree = new Map()
    for (const e of data.edges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1) }
    // 初始位置：主题环形布局（力导向从有序起点自然展开，观感优雅）
    const init = layoutNodes(data, W(), H())
    const now = Date.now()
    const minCreated = Math.min(...data.nodes.map((n) => n.createdAt ?? now), now)
    const nodes = data.nodes.map((n) => {
      const p = init.positions.get(n.id) ?? [W() / 2 + (Math.random() - 0.5) * 60, H() / 2 + (Math.random() - 0.5) * 60]
      // 新旧色温：新记忆亮、旧记忆暗（时间作为第四维的视觉编码；库内相对映射）
      return { ...n, x: p[0], y: p[1], vx: 0, vy: 0, degree: degree.get(n.id) ?? 0, color: ageShade(colorOf(n.theme), n.createdAt, minCreated, now) }
    })
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    const edges = data.edges.map((e) => ({ ...e, a: nodeById.get(e.from), b: nodeById.get(e.to) })).filter((e) => e.a && e.b)
    const neighbors = new Map()
    for (const e of edges) {
      if (!neighbors.has(e.a.id)) neighbors.set(e.a.id, new Set())
      neighbors.get(e.a.id).add(e.b.id)
      if (!neighbors.has(e.b.id)) neighbors.set(e.b.id, new Set())
      neighbors.get(e.b.id).add(e.a.id)
    }

    // ---- 力导向（平衡设计：连线多不挤团、连线少不漂远） ----
    //  斥力：Fruchterman k²/d + 距离截断 2.2k（远距零斥力 → 孤立节点不被无限推远）
    //  弹簧：目标长度度感知（枢纽节点周围留更大空间）+ 强度 0.07（更紧）
    //  中心引力：0.005 线性（孤立节点回归中心；被拖拽节点豁免）
    let alpha = 0.45, raf = 0   // 初始 α 调低：首帧运动更温和（配合预热，打开即稳定全景）
    const k = Math.sqrt((W() * H()) / Math.max(nodes.length, 1))
    const maxDeg = Math.max(...nodes.map((n) => n.degree), 1)
    let dragNode = null
    const transform = { x: 0, y: 0, k: 1 }
    const heat = (a) => { alpha = Math.max(alpha, a) }
    const step = () => {
      alpha += (0 - alpha) * 0.028
      // 拖动期间维持模拟活跃（alpha 地板）：弹簧持续牵引，邻居弹性跟随拖点
      if (dragNode) alpha = Math.max(alpha, 0.15)
      // 斥力（带截断与最小距离钳制）
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          let dx = a.x - b.x, dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1e-6) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
          const d = Math.sqrt(d2)
          if (d >= 2.2 * k) continue   // 远距截断：太远的节点互不影响
          const dd = Math.max(d, 22)   // 软化核心：22px 内斥力不再增长（拖点压邻居不爆炸）
          // 拖动期间斥力减半：跟随交给弹簧，斥力只做让位——防团内连锁推挤振荡
          const f = Math.min((k * k) / dd, k * 0.6) * alpha * P.repulsion * (dragNode ? 0.45 : 1)
          a.vx += (dx / d) * f; a.vy += (dy / d) * f
          b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
        }
      }
      // 弹簧（度感知目标长度：连线越多间距越大，防挤团）
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const degFactor = 1 + 0.5 * Math.sqrt(((e.a.degree + e.b.degree) / 2) / maxDeg)
        const target = k * 1.15 * degFactor
        const f = (d - target) * P.spring * alpha
        e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f
        e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f
      }
      // 中心引力（增强，孤立节点不漂远）
      // 拖动期间强阻尼爬行：邻居缓慢平滑漂向拖点（无惯性回摆 = 无抖动）；松手恢复弹性
      const damp = dragNode ? 0.11 : P.damping
      for (const n of nodes) {
        if (n === dragNode) { n.vx = 0; n.vy = 0; continue }
        n.vx += (W() / 2 - n.x) * P.gravity * alpha
        n.vy += (H() / 2 - n.y) * P.gravity * alpha
        n.vx *= damp; n.vy *= damp
        n.x += n.vx * 1.5; n.y += n.vy * 1.5
      }
    }

    // ---- 自适应视野（fit-to-view） ----
    const fitToView = () => {
      if (nodes.length === 0) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of nodes) {
        if (n.x < minX) minX = n.x
        if (n.y < minY) minY = n.y
        if (n.x > maxX) maxX = n.x
        if (n.y > maxY) maxY = n.y
      }
      const pad = 70
      const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1)
      const kFit = Math.min((W() - pad * 2) / bw, (H() - pad * 2) / bh, 1.5)
      transform.k = Math.max(0.28, kFit)
      transform.x = (W() - bw * transform.k) / 2 - minX * transform.k
      transform.y = (H() - bh * transform.k) / 2 - minY * transform.k
    }

    // ---- 打开动画：预热模拟 → 立即全景 → 从中心向两边平滑显现 ----
    // 1) 预热：跑到力导向真正收敛（alpha 冷却到阈值）——打开面板时刻节点已在平衡位，
    //    不再从固定位置慢慢迁移到平衡；入场只是淡入放大。
    let warm = 0
    while (warm < 800 && alpha > 0.006) { step(); warm++ }
    // 2) 立即全景（不再等模拟收敛后才跳变缩放）
    fitToView()
    // 3) 显现动画参数：节点按距视口中心距离延迟淡入+放大（中心先亮，向两边扩散）
    const bornAt = performance.now()
    const revealMs = 700
    const cx0 = W() / 2, cy0 = H() / 2
    let maxDist = 1
    for (const n of nodes) maxDist = Math.max(maxDist, Math.hypot(n.x - cx0, n.y - cy0))

    // ---- 绘制 ----
    const draw = () => {
      ctx.clearRect(0, 0, W(), H())
      ctx.save()
      ctx.translate(transform.x, transform.y)
      ctx.scale(transform.k, transform.k)
      // 点阵背景（Obsidian 风格定位网格：随平移/缩放跟随）
      ctx.fillStyle = "rgba(255,255,255,0.16)"
      const grid = 44
      const gx0 = Math.floor(-transform.x / transform.k / grid) * grid
      const gy0 = Math.floor(-transform.y / transform.k / grid) * grid
      const gx1 = gx0 + W() / transform.k + grid
      const gy1 = gy0 + H() / transform.k + grid
      for (let wx = gx0; wx <= gx1; wx += grid) {
        for (let wy = gy0; wy <= gy1; wy += grid) {
          ctx.fillRect(wx, wy, 1.4, 1.4)
        }
      }
      const selId = selectedRef.current
      const hovId = hoverRef.current
      const focusId = selId || hovId
      // 事件高亮（阶段四）：focusIds 非空时，非事件成员降透明度
      const focusIds = focusIdsRef?.current ?? null
      // 入场动画：边整体淡入（350ms），节点按距中心距离延迟显现
      const elapsed = performance.now() - bornAt
      const overallT = Math.min(1, elapsed / 350)
      for (const e of edges) {
        const on = !focusId || e.a.id === focusId || e.b.id === focusId
        const dimmed = focusIds && !(focusIds.has(e.a.id) && focusIds.has(e.b.id))
        const st = EDGE_STYLE[e.type] ?? EDGE_STYLE.similarTo
        ctx.globalAlpha = (focusId ? (on ? 1 : 0.08) : (st.alpha ?? 0.45)) * overallT * (dimmed ? 0.08 : 1)
        ctx.strokeStyle = st.color
        ctx.lineWidth = (st.w ?? 0.9) / transform.k
        ctx.setLineDash(st.dash ?? [])
        ctx.beginPath()
        ctx.moveTo(e.a.x, e.a.y)
        ctx.lineTo(e.b.x, e.b.y)
        ctx.stroke()
      }
      ctx.setLineDash([])
      // 边 hover 标签（v0.9.11）：鼠标悬停边时显示类型（+权重）
      const hovE = hoverEdgeRef.current
      if (hovE) {
        const hx = (hovE.a.x + hovE.b.x) / 2, hy = (hovE.a.y + hovE.b.y) / 2
        const lbl = (EDGE_LABEL[hovE.type] ?? hovE.type)
          + (hovE.type === "similarTo" ? " " + Number(hovE.weight ?? 0).toFixed(2) : "")
          + (hovE.type === "mentions" ? " ×" + (hovE.weight ?? 1) : "")
        ctx.globalAlpha = 0.95
        ctx.font = `${10 / transform.k}px sans-serif`
        const tw = ctx.measureText(lbl).width
        const ph = 10 / transform.k, pw = tw + 8 / transform.k
        ctx.fillStyle = "rgba(18,18,22,0.88)"
        ctx.beginPath()
        if (ctx.roundRect) ctx.roundRect(hx - pw / 2, hy - ph - 8 / transform.k, pw, ph + 4 / transform.k, 3 / transform.k)
        else ctx.rect(hx - pw / 2, hy - ph - 8 / transform.k, pw, ph + 4 / transform.k)
        ctx.fill()
        ctx.fillStyle = EDGE_STYLE[hovE.type]?.color ?? "#ccc"
        ctx.textAlign = "center"
        ctx.fillText(lbl, hx, hy - 3 / transform.k)
      }
      for (const n of nodes) {
        const isFocus = n.id === focusId
        const isNbr = focusId && neighbors.get(focusId)?.has(n.id)
        const dimmed = focusIds && !focusIds.has(n.id)
        // 从中心向两边显现：延迟按距中心距离比例（0~55% 的动画时长），easeOutCubic 放大+淡入
        const dist = Math.hypot(n.x - cx0, n.y - cy0)
        const delay = (dist / maxDist) * 0.55 * revealMs
        const t = Math.min(1, Math.max(0, (elapsed - delay) / 320))
        const ease = t <= 0 ? 0 : 1 - (1 - t) * (1 - t) * (1 - t)
        if (ease <= 0.001) continue
        ctx.globalAlpha = (focusId ? (isFocus || isNbr ? 1 : 0.2) : 1) * ease * (dimmed ? 0.12 : 1)
        ctx.beginPath()
        const r = (4 + Math.min(n.degree, 14) * 0.55) / Math.sqrt(transform.k) * ease
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = n.color
        ctx.fill()
        // 版本环（四维蠕虫的时间痕迹）：更新过几次 = 几圈年轮（封顶 3 圈）
        if (n.versions > 1) {
          const rings = Math.min(n.versions - 1, 3)
          const step = 3.2 / Math.sqrt(transform.k)
          for (let ri = 0; ri < rings; ri++) {
            ctx.beginPath()
            ctx.arc(n.x, n.y, r + 3 + ri * step, 0, Math.PI * 2)
            ctx.strokeStyle = "#ffd54f"
            ctx.lineWidth = 1.3 / Math.sqrt(transform.k)
            ctx.stroke()
          }
        }
        // +N 更新徽标（v0.9.10）：更新过的节点右上角标注更新次数（取代纵深拖尾——"旧节点"不再散落）
        if ((n.versions ?? 1) > 1) {
          const cnt = (n.versions ?? 1) - 1
          const br = 7.5 / transform.k
          const bx = n.x + r * 0.9, by = n.y - r * 0.9
          ctx.globalAlpha = (focusId ? (isFocus || isNbr ? 1 : 0.2) : 0.95) * ease * (dimmed ? 0.12 : 1)
          ctx.beginPath()
          ctx.arc(bx, by, br, 0, Math.PI * 2)
          ctx.fillStyle = "#1e1e24"
          ctx.fill()
          ctx.strokeStyle = "#ffd54f"
          ctx.lineWidth = 1.1 / transform.k
          ctx.stroke()
          ctx.fillStyle = "#ffd54f"
          ctx.font = `bold ${8.5 / transform.k}px sans-serif`
          ctx.textAlign = "center"
          ctx.textBaseline = "middle"
          ctx.fillText(`+${cnt}`, bx, by + 0.5 / transform.k)
          ctx.textBaseline = "alphabetic"
        }
        if (isFocus) {
          ctx.strokeStyle = "#fff"
          ctx.lineWidth = 1.5 / transform.k
          ctx.stroke()
          // 悬浮/选中标签：创建时间 + 更新次数（四维蠕虫的时间信息）
          const tag = `${agoText(n.createdAt)}${(n.versions ?? 1) > 1 ? ` · 更新 ${(n.versions ?? 1) - 1} 次` : ''}`
          ctx.font = (10 / transform.k) + "px sans-serif"
          ctx.textAlign = "center"
          ctx.fillStyle = "#ddd"
          ctx.fillText(tag, n.x, n.y - r - 10 / transform.k)
        }
        if (transform.k > 0.65 || isFocus) {
          ctx.globalAlpha = (isFocus || !focusId ? 1 : 0.3) * ease
          ctx.fillStyle = "#ccc"
          ctx.font = (10 / transform.k) + "px sans-serif"
          ctx.textAlign = "center"
          ctx.fillText(n.label.slice(0, 9), n.x, n.y + r + 11 / transform.k)
        }
      }
      ctx.globalAlpha = 1
      ctx.restore()
    }
    drawRef.current = draw

    const loop = () => {
      // v0.9.17 实时持续物理：低活跃度地板（0.02）保底，力导向一直运行、永不冻结；
      // 打开已收敛（warmup），故只做缓慢弹性律动，无 v0.9.13 的高频抖动
      alpha = Math.max(alpha, 0.02)
      step()
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    // ---- 交互 ----
    // 点到线段距离平方（边 hover）
    const distToSegSq = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay
      const l2 = dx * dx + dy * dy
      let tt = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
      tt = Math.max(0, Math.min(1, tt))
      const qx = ax + dx * tt, qy = ay + dy * tt
      const ex = px - qx, ey = py - qy
      return ex * ex + ey * ey
    }
    const hitTest = (mx, my) => {
      const wx = (mx - transform.x) / transform.k, wy = (my - transform.y) / transform.k
      let best = null, bestD = (14 * 14) / (transform.k * transform.k)
      for (const n of nodes) {
        const dx = n.x - wx, dy = n.y - wy
        const d2 = dx * dx + dy * dy
        if (d2 < bestD) { bestD = d2; best = n }
      }
      return best
    }
    let panStart = null, downPos = null, moved = false
    const getPos = (ev) => {
      const rect = canvas.getBoundingClientRect()
      return [ev.clientX - rect.left, ev.clientY - rect.top]
    }
    const onDown = (ev) => {
      downPos = [ev.clientX, ev.clientY]
      moved = false
      const [mx, my] = getPos(ev)
      const n = hitTest(mx, my)
      if (n) { dragNode = n; heat(0.35); if (!raf) raf = requestAnimationFrame(loop) }
      else panStart = { x: ev.clientX, y: ev.clientY, tx: transform.x, ty: transform.y }
    }
    const onMove = (ev) => {
      if (downPos && (Math.abs(ev.clientX - downPos[0]) > 4 || Math.abs(ev.clientY - downPos[1]) > 4)) moved = true
      const [mx, my] = getPos(ev)
      if (dragNode) {
        dragNode.x = (mx - transform.x) / transform.k
        dragNode.y = (my - transform.y) / transform.k
        // 兜底：拖动中循环若意外停止，立即重启（防画面冻结）
        if (!raf) raf = requestAnimationFrame(loop)
      } else if (panStart) {
        transform.x = panStart.tx + (ev.clientX - panStart.x)
        transform.y = panStart.ty + (ev.clientY - panStart.y)
        if (!raf) { draw() }
      } else {
        const n = hitTest(mx, my)
        // 边 hover（v0.9.11）：鼠标最近处有边（屏幕阈值内）→ 显示类型标签
        const wx = (mx - transform.x) / transform.k, wy = (my - transform.y) / transform.k
        const eTh = 14 / transform.k
        let bestE = null, bestEd = eTh * eTh
        for (const e of edges) {
          const d = distToSegSq(wx, wy, e.a.x, e.a.y, e.b.x, e.b.y)
          if (d < bestEd) { bestEd = d; bestE = e }
        }
        if (bestE !== hoverEdgeRef.current) {
          hoverEdgeRef.current = bestE
          if (!raf) { raf = requestAnimationFrame(() => { draw(); raf = 0 }) }
        }
        if ((n?.id ?? null) !== hoverRef.current) {
          hoverRef.current = n?.id ?? null
          if (!raf) { raf = requestAnimationFrame(() => { draw(); raf = 0 }) }
        }
      }
    }
    const onUp = () => { dragNode = null; panStart = null; downPos = null }
    const onClick = (ev) => {
      if (moved) return
      const [mx, my] = getPos(ev)
      const n = hitTest(mx, my)
      onSelect(n ?? null)
    }
    const onWheel = (ev) => {
      ev.preventDefault()
      const [mx, my] = getPos(ev)
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12
      const nk = Math.min(4, Math.max(0.25, transform.k * factor))
      transform.x = mx - ((mx - transform.x) / transform.k) * nk
      transform.y = my - ((my - transform.y) / transform.k) * nk
      transform.k = nk
      draw()
    }
    canvas.addEventListener("mousedown", onDown)
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    canvas.addEventListener("click", onClick)
    canvas.addEventListener("wheel", onWheel, { passive: false })

    return () => {
      cancelAnimationFrame(raf)
      drawRef.current = null
      window.removeEventListener("resize", resize)
      canvas.removeEventListener("mousedown", onDown)
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      canvas.removeEventListener("click", onClick)
      canvas.removeEventListener("wheel", onWheel)
    }
  }, [data, onSelect, selectedRef, drawRef, physics])

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", cursor: "grab" }} />
})

/** 详情面板（memo：仅选中变化时重渲染）。 */
const DetailPanel = memo(function DetailPanel({ selected, data }) {
  const { colorOf, adj, nodeById } = useMemo(() => {
    const co = (theme) => {
      const i = data.themes.indexOf(theme)
      return i >= 0 ? THEME_COLORS[i % THEME_COLORS.length] : "#888"
    }
    const nodeById = new Map(data.nodes.map((n) => [n.id, n]))
    const a = new Map()
    for (const e of data.edges) {
      if (!a.has(e.from)) a.set(e.from, [])
      a.get(e.from).push({ other: e.to, type: e.type, weight: e.weight })
      if (!a.has(e.to)) a.set(e.to, [])
      a.get(e.to).push({ other: e.from, type: e.type, weight: e.weight })
    }
    return { colorOf: co, adj: a, nodeById }
  }, [data])
  if (!selected) return null
  return (
    <div style={{ width: 280, borderLeft: "1px solid #333", padding: 14, overflowY: "auto", background: "#161616" }}>
      <h4 style={{ margin: "0 0 8px", color: colorOf(selected.theme) }}>{selected.theme || "(未归类)"}</h4>
      <p style={{ fontSize: 12, color: "#888", margin: "0 0 10px" }}>
        {selected.type} · {selected.layer} · strength {selected.strength} · {new Date(selected.createdAt).toLocaleString("zh-CN", { hour12: false })}
      </p>
      <p style={{ fontSize: 12, margin: "0 0 10px" }}>
        {(selected.versions ?? 1) > 1
          ? <span style={{ color: "#ffd54f" }}>◉ 更新过 {(selected.versions ?? 1) - 1} 次（世界线保留最近 {(selected.versions ?? 1)} 段）</span>
          : <span style={{ color: "#777" }}>○ 未更新过（单版本）</span>}
        <span style={{ color: "#888" }}> · 创建于 {agoText(selected.createdAt)}</span>
        {selected.updatedAt && selected.updatedAt !== selected.createdAt
          ? <span style={{ color: "#888" }}> · 最后更新 {agoText(selected.updatedAt)}</span>
          : null}
      </p>
      <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{selected.content}</p>
      <h5 style={{ margin: "14px 0 6px", fontSize: 12, color: "#aaa" }}>关联记忆</h5>
      {(adj.get(selected.id) ?? []).length === 0 ? (
        <p style={{ fontSize: 12, color: "#777" }}>暂无关联</p>
      ) : (
        (adj.get(selected.id) ?? []).map((a, i) => {
          const other = nodeById.get(a.other)
          return (
            <div key={i} style={{ fontSize: 12, margin: "4px 0", color: "#bbb" }}>
              <span style={{ color: a.type === "similarTo" ? "#5b9bd5" : "#e07b39" }}>[{a.type}]</span>
              {a.type === "similarTo" ? " 相似 " + a.weight.toFixed(2) + " " : " "}
              {other ? other.label.slice(0, 12) : a.other}
            </div>
          )
        })
      )}
    </div>
  )
})

/** 记忆图谱视图组件（容器：数据加载 + 选中态；画布与面板均 memo 隔离）。
 *  scope：memory 设置命名空间（读 graphView 力导向参数，live 生效）。 */
function MemoryGraphView({ scope }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState(null)
  const selectedRef = useRef(null)
  const drawRef = useRef(null)

  // 力导向物理参数：settings.graphView（缺省回落默认手感）；scope 变化 → physics 引用变化 → 重建模拟
  const [gv, setGv] = useState(() => {
    try { return scope?.getSnapshot()?.value?.graphView ?? {} } catch { return {} }
  })
  useEffect(() => {
    if (!scope) return
    const sub = scope.subscribe(() => {
      try { setGv(scope.getSnapshot()?.value?.graphView ?? {}) } catch { /* 快照异常忽略 */ }
    })
    return sub
  }, [scope])
  const physics = useMemo(() => ({
    spring: Number(gv.spring) || 0.13,
    repulsion: Number(gv.repulsion) || 1,
    damping: Number(gv.damping) || 0.3,
    gravity: Number(gv.gravity) || 0.005,   // || 而非 ??：Number(undefined)=NaN，NaN??x 仍是 NaN 会击穿力导向
  }), [gv.spring, gv.repulsion, gv.damping, gv.gravity])

  const load = useCallback(() => {
    setError("")
    fetch("/dsh-memory/graph")
      .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json() })
      .then(setData)
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])
  useEffect(load, [load])

  // 选中态经 ref 通知画布重绘（零组件重渲染；Canvas 绘制循环读取 selectedRef）
  useEffect(() => {
    selectedRef.current = selected?.id ?? null
    drawRef.current?.()
  }, [selected])

  // 时间筛选（四维蠕虫：只看某时间窗内的记忆）
  const [ageWindow, setAgeWindow] = useState("all")
  const filtered = useMemo(() => {
    if (!data) return data
    if (ageWindow === "all") return data
    const now = Date.now()
    const cutoffOld = now - 90 * 24 * 3600 * 1000
    const inWindow = (ts) => {
      if (ageWindow === "old") return (ts ?? 0) < cutoffOld
      const days = Number(ageWindow.replace("d", ""))
      return (ts ?? 0) >= now - days * 24 * 3600 * 1000
    }
    const ids = new Set(data.nodes.filter((n) => inWindow(n.createdAt)).map((n) => n.id))
    const nodes = data.nodes.filter((n) => ids.has(n.id))
    return {
      ...data,
      nodes,
      edges: data.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      themes: [...new Set(nodes.map((n) => n.theme).filter(Boolean))],   // 筛选后主题数口径一致
    }
  }, [data, ageWindow])
  const updatedCount = (filtered?.nodes ?? []).filter((n) => (n.versions ?? 1) > 1).length

  // 事件高亮（阶段四）：选中事件 → 成员高亮、其余降透明；经 ref 通知画布（不重建模拟）
  const [eventFilter, setEventFilter] = useState("all")
  const focusIdsRef = useRef(null)
  useEffect(() => {
    // 陈旧 id 防护：detectEvents 全量重建后事件 id 可能变更——若选中事件已不存在，
    // 重置为 "all"（否则空 Set 会让全图 ×0.12 灰暗）
    if (eventFilter !== "all" && !(data?.events ?? []).some((e) => e.id === eventFilter)) {
      setEventFilter("all")
      focusIdsRef.current = null
      drawRef.current?.()
      return
    }
    if (eventFilter === "all" || !filtered) {
      focusIdsRef.current = null
    } else {
      focusIdsRef.current = new Set(filtered.nodes.filter((n) => n.eventId === eventFilter).map((n) => n.id))
    }
    drawRef.current?.()
  }, [eventFilter, filtered, data])

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <h3 style={{ margin: "0 0 12px" }}>记忆图谱</h3>
        <p style={{ color: "#e07b39" }}>加载失败：{error}</p>
        <button onClick={load} style={{ padding: "4px 16px", borderRadius: 6, border: "1px solid #555", background: "transparent", color: "#aaa", cursor: "pointer" }}>重试</button>
      </div>
    )
  }
  if (!data) {
    return <div style={{ padding: 24, color: "#888" }}>加载记忆图谱中…</div>
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 560, gap: 0 }}>
      <div style={{ flex: 1, minWidth: 0, position: "relative", minHeight: 560 }}>
        <div style={{ position: "absolute", top: 10, left: 14, fontSize: 12, color: "#aaa", zIndex: 2, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>
            记忆 {filtered.nodes.length} · 更新过 {updatedCount} · 主题 {filtered.themes.length} · 关系 {filtered.edges.length}
          </span>
          <select
            value={ageWindow}
            onChange={(e) => setAgeWindow(e.target.value)}
            style={{ padding: "1px 6px", fontSize: 12, borderRadius: 5, border: "1px solid #555", background: "#1a1a1a", color: "#ccc" }}
            title="按创建时间筛选记忆（时间维度）"
          >
            {AGE_WINDOWS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <select
            value={eventFilter}
            onChange={(e) => setEventFilter(e.target.value)}
            style={{ padding: "1px 6px", fontSize: 12, borderRadius: 5, border: "1px solid #555", background: "#1a1a1a", color: "#ccc" }}
            title="按事件高亮（时间连续 + 因果相关的记忆聚簇）"
          >
            <option value="all">全部事件</option>
            {(data?.events ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}（{e.count} 条）
              </option>
            ))}
          </select>
          <button onClick={load} style={{ padding: "1px 10px", borderRadius: 5, border: "1px solid #555", background: "transparent", color: "#aaa", cursor: "pointer", fontSize: 12 }}>刷新</button>
        </div>
        <ObsidianGraph data={filtered} onSelect={setSelected} selectedRef={selectedRef} drawRef={drawRef} physics={physics} focusIdsRef={focusIdsRef} />
        <div style={{ position: "absolute", right: 14, bottom: 10, fontSize: 11, color: "#777", zIndex: 2, display: "flex", flexWrap: "wrap", gap: 8, maxWidth: "72%", justifyContent: "flex-end" }}>
          {EDGE_ORDER.filter((t2) => (filtered?.edges ?? []).some((e) => e.type === t2)).map((t2) => (
            <span key={t2} style={{ color: EDGE_STYLE[t2].color }}>
              {t2 === "similarTo" ? "—" : t2 === "before" ? "→" : t2 === "mentions" ? "· ·" : "—"}{" "}{EDGE_LABEL[t2]}
            </span>
          ))}
          <span style={{ color: "#ffd54f" }}>◎ +N = 更新过 N 次</span>
          <span>色浅新 · 色深旧</span>
          <span>拖节点 · 平移 · 缩放 · 点边看类型</span>
        </div>
      </div>
      <DetailPanel selected={selected} data={filtered} />
    </div>
  )
}

/**
 * 侧边栏底部入口（sidebar.footer.action，与任务看板同槽）：
 * 点开渲染全视口面板（fixed 覆盖层，含标题栏与关闭按钮），面板内是完整图谱页面。
 */
export function MemoryGraphLauncher({ wide, scope }) {
  const [open, setOpen] = useState(false)
  // Esc 关闭全视口面板（键盘可达性；关闭按钮被遮挡时的兜底路径）
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="记忆图谱"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
          padding: '5px 8px', borderRadius: 6, border: 'none',
          background: open ? 'rgba(91,155,213,0.18)' : 'transparent',
          color: '#ccc', cursor: 'pointer', fontSize: 12,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="3" cy="3" r="1.8" fill="#5b9bd5" />
          <circle cx="11" cy="3" r="1.8" fill="#e07b39" />
          <circle cx="7" cy="11" r="1.8" fill="#70ad47" />
          <line x1="3.8" y1="4.2" x2="9.8" y2="4.2" stroke="#777" strokeWidth="0.8" />
          <line x1="3.6" y1="4.6" x2="6.4" y2="9.6" stroke="#777" strokeWidth="0.8" />
          <line x1="10.4" y1="4.6" x2="7.6" y2="9.6" stroke="#777" strokeWidth="0.8" />
        </svg>
        {wide ? <span>记忆图谱</span> : null}
      </button>
      {open ? (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(16, 16, 18, 0.72)',
          backdropFilter: 'blur(22px) saturate(1.2)',
          WebkitBackdropFilter: 'blur(22px) saturate(1.2)',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '44px 16px 10px', flex: 'none' }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: '#ddd', letterSpacing: 0.5 }}>记忆图谱</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <MemoryGraphView scope={scope} />
            {/* 左下角退出键：毛玻璃质感，远离顶栏不被遮挡；Esc 同效 */}
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="关闭图谱（Esc）"
              style={{
                position: 'absolute', left: 16, bottom: 16, zIndex: 10,
                padding: '8px 22px', borderRadius: 10, cursor: 'pointer',
                border: '1px solid rgba(255,255,255,0.22)',
                background: 'rgba(255,255,255,0.08)',
                backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
                color: '#eee', fontSize: 13, fontWeight: 500, letterSpacing: 0.5,
                boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
              }}
            >
              退出图谱（Esc）
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}
