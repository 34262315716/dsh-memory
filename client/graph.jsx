/**
 * dsh-memory 客户端：记忆图谱（Obsidian 风格力导向画布 + 时间维度/事件可视化）。
 * 原 client/index.jsx 拆分（v0.10 解耦），注册到 sidebar.footer.action 插槽。
 */
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
// v0.12.8：日志并入图谱面板——不再单独占侧边栏入口
import { MemoryLogPanel } from './logs.jsx'
import { themeBounds, clusterByDistance, densityCore, convexHull, padConvexPolygon, polygonContains } from './graph-geometry.js'
import { layoutSignature, loadLayout, saveLayout, restoredRatio } from './layout-cache.js'
// v0.15.0：力模型整体搬进 graph-force.js（纯函数、可在 Node 里断言）。这里是它的唯一消费者。
import { pairForce, springForce, recenter, clampSpeed, seedLayout, FIELD_DEFAULTS } from './graph-force.js'
/** 主题色板：色相均匀 14 色 + 相邻明度交替（奇亮偶暗）。
 *  深色背景下高辨识；环形布局里相邻扇区一个亮一个暗，天然错开。 */
function themePalette(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const h = Math.round((i * 360) / n)
    const l = i % 2 ? 57 : 65
    out.push(`hsl(${h},74%,${l}%)`)
  }
  return out
}
const THEME_COLORS = themePalette(14)

/** 无主题节点：按记忆类型上色（v0.10：96% 的记忆无主题，原先清一色 #888 被压暗成"深蓝灰"一坨；
 *  类型是高区分度第一维——一眼分出决策/记录/教训/画像/偏好）。 */
const TYPE_COLORS = {
  note:       'hsl(199, 92%, 62%)',   // 天青蓝（记录/中性）
  decision:   'hsl(36, 95%, 61%)',    // 琥珀（决策=行动）
  preference: 'hsl(291, 52%, 62%)',   // 紫（偏好=个性）
  lesson:     'hsl(1, 83%, 63%)',     // 珊瑚红（教训=警示）
  profile:    'hsl(122, 45%, 58%)',   // 翠绿（画像=用户本人）
  aggregate:  'hsl(45, 70%, 60%)',   // 金色（折叠容器：多条记忆聚合成的占位）
}
const TYPE_COLOR_FALLBACK = 'hsl(200, 16%, 60%)'   // 蓝灰（legacy/未知类型）
const TYPE_LABEL = { note: "记录", decision: "决策", preference: "偏好", lesson: "教训", profile: "画像", aggregate: "聚合" }

/** 节点最终色（v0.10 重写）：
 *  基色（主题色或类型色）→ strength 明度微调（次级维度，同类型节点也有层次）
 *  → ditherId 色相抖动（无主题节点按 id 确定性 ±12°，同类型内也有颜色渐变，避免"一坨同色"）
 *  → 年龄明度压缩（四维蠕虫时间维度）。全程只动 HSL 明度/微动色相，饱和度永不失真：
 *  旧节点依然"看得出来是什么颜色"，只是比新的暗一点（压暗上限旧版 55% → 40%）。 */
function nodeColor(base, strength, createdAt, minCreatedAt, now = Date.now(), ditherId = null) {
  const m = /hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)/.exec(base)
  if (!m) return base
  let h = +m[1], s = +m[2], l = +m[3]
  // strength 实测 0.1~1.3（均值 ~0.18）→ 明度增量 -2.4 ~ +10
  l += Math.max(-8, Math.min(10, (strength - 0.3) * 12))
  // 确定性色相抖动（同 id 永远同色）：±12°，保持类型色相区域语义不破
  if (ditherId) {
    let x = 0
    for (const ch of String(ditherId)) x = (x * 31 + ch.charCodeAt(0)) % 997
    h += ((x % 5) - 2) * 6
    if (h < 0) h += 360
    if (h >= 360) h -= 360
  }
  // 库内相对映射（minCreatedAt=库内最早创建时间）：任意时间跨度下新旧对比都明显
  const span = Math.max(1, now - (minCreatedAt ?? now))
  const ratio = 1 - Math.max(0, Math.min(1, (now - (createdAt ?? now)) / span))
  l = (0.60 + 0.40 * ratio) * l
  return `hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(Math.min(90, Math.max(12, l)))}%)`
}

/** 节点基色：有主题 → 主题色（色板按主题列表索引）；无主题 → 类型色。 */
function pickColor(themes, theme, type) {
  /**
   * 折叠容器优先用金色（v0.17.1）。
   *
   * 为什么必须放在最前面：容器**大多有主题**（按主题折叠出来的），而下面那行
   * 是"有主题就用主题色"——于是容器会被染成和它内部成员一样的颜色，
   * 在图上完全认不出来。容器的语义是"这里折叠了一堆"，它必须一眼可辨，
   * 所以类型优先于主题。
   */
  if (type === "aggregate") return TYPE_COLORS.aggregate
  if (theme) {
    const i = themes.indexOf(theme)
    if (i >= 0) return THEME_COLORS[i % THEME_COLORS.length]
  }
  return TYPE_COLORS[type] ?? TYPE_COLOR_FALLBACK
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

/** 初始布局（v0.15.1）：**连通分量成盘 + 度数高者靠中心**，由 graph-force.js 的 seedLayout 负责。
 *  旧的"主题环形布局"（所有节点铺在一个半径 200px 的环上）已删除：857 个点挤在周长 ≈1257px
 *  的环上意味着局部间距 ~1.5px，近场斥力会把它们弹到几千 px 外，而**局部场对已经跑出半径的
 *  点零作用** → 它们永远回不来，就是用户截图里的「大量空白 + 外圈孤岛」。详见 seedLayout 的注释。 */

/** Obsidian 风格力导向图谱（Canvas 渲染）：
 *  物理（v0.15.1 重写，见 graph-force.js）：**邻域场**（半径内每对节点都有引/斥，一条公式 pairForce）
 *       + 边的弹簧（springForce）+ 速度阻尼 + 单帧限速 + 常活微动；`recenter` 只做整体平移（不是力），
 *       **没有任何"朝某个点拉"的中心引力**。实时循环常开，α 恒为 0.4（静息与拖动同一工作点）。
 *  交互：拖节点（降阻尼 + 1 环速度前馈）、拖背景平移、滚轮以鼠标为中心缩放、hover 高亮邻居、点击选中
 *  性能：单 Canvas 每帧整绘（数百节点 <5ms）；选中/hover 经 ref 传入，组件零重渲染
 */

const ObsidianGraph = memo(function ObsidianGraph({ data, onSelect, selectedRef, drawRef, physics, focusIdsRef, themeFocusRef }) {
  const canvasRef = useRef(null)
  const hoverRef = useRef(null)
  const hoverEdgeRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    const dpr = window.devicePixelRatio || 1
    // v0.15.0：力模型参数集中到 graph-force.js 的 FIELD_DEFAULTS（唯一出处），
    // 兜底值与设置页默认值不会再各写一份、各漂各的。
    const P = physics ?? { ...FIELD_DEFAULTS, themeShape: 'circle', themeScope: 'focus' }
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
    const colorOf = (theme, type) => pickColor(data.themes, theme, type)
    const degree = new Map()
    for (const e of data.edges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1) }
    // 初始位置（v0.15.1）：**优先复用上次收敛坐标**（localStorage，按 id 取交集）——
    // 打开即落在"全局平衡"位置，不再每次从种子重跑一遍迁移；新节点（缓存里没有的）
    // 落在同主题已恢复节点的质心附近，再由力导向微调，平滑接纳新记忆。
    const init = seedLayout(data, W(), H(), P)
    const sig = layoutSignature(data)
    const cached = loadLayout()
    const cacheMap = cached?.map ?? null
    const reuse = restoredRatio(cacheMap, data.nodes)
    const restoreOk = reuse >= 0.85
    // 同主题质心（给新节点找落点）
    const themeCentroid = new Map()
    if (cacheMap) {
      const acc = new Map()
      for (const n of data.nodes) {
        const p = cacheMap.get(n.id)
        if (!p || !n.theme) continue
        const a = acc.get(n.theme) ?? { x: 0, y: 0, n: 0 }
        a.x += p[0]; a.y += p[1]; a.n++
        acc.set(n.theme, a)
      }
      for (const [t, a] of acc) if (a.n > 0) themeCentroid.set(t, [a.x / a.n, a.y / a.n])
    }
    const now = Date.now()
    const minCreated = Math.min(...data.nodes.map((n) => n.createdAt ?? now), now)
    const nodes = data.nodes.map((n) => {
      const cachedPos = cacheMap?.get(n.id)
      const cen = n.theme ? themeCentroid.get(n.theme) : null
      const p = cachedPos ?? (cen ? [cen[0] + (Math.random() - 0.5) * 90, cen[1] + (Math.random() - 0.5) * 90] : null)
        ?? init.positions.get(n.id) ?? [W() / 2 + (Math.random() - 0.5) * 60, H() / 2 + (Math.random() - 0.5) * 60]
      // 基色（主题色/类型色）→ strength 微调 → 色相抖动（仅无主题）→ 新旧色温（新亮旧暗）
      return { ...n, x: p[0], y: p[1], vx: 0, vy: 0, degree: degree.get(n.id) ?? 0, color: nodeColor(colorOf(n.theme, n.type), n.strength, n.createdAt, minCreated, now, n.theme ? null : n.id) }
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

    // ---- 力导向（v0.15.1：**邻域场**） ----
    //  物理全在 graph-force.js，这里一行都不重复实现：
    //    pairForce(d,k,P)  —— 半径内**每一对**节点之间的一条公式：近处斥、远处（很轻地）吸，
    //                        零点 = spacing·k；两个边界都硬归零，不带到半径外
    //    springForce(d,k,P) —— 边的弹簧（静止长度 0.9·dEq，簇才像簇）
    //    clampSpeed —— 单帧限速；recenter —— 质心平移（**不是力**）
    //  ★ 这里既没有"中心引力"，也没有 v0.14.x 那三条按度数加权的特权方向（度只影响节点半径的
    //    视觉大小，不影响任何力）。
    let alpha = 0.45, raf = 0   // 初始 α 调低：首帧运动更温和（配合预热，打开即稳定全景）
    // 主题区域聚簇态（v0.10.6）：自适应门槛缓存 + 帧计数（避免逐帧重算中位边长的开销与抖动）
    let clusterR = 0
    let coreEps = 0
    /** 主题区域的自适应尺度（v0.10.8）：聚簇门槛与密度半径跟随「实测邻边中位长度」——
     *  只在**重建成员划分**时计算一次（不再每 45 帧刷新：定期刷新会让区域形状定期跳变）。 */
    const computeThemeScale = (edgeList) => {
      const ds = []
      const stepE = Math.max(1, Math.floor(edgeList.length / 240))
      for (let i = 0; i < edgeList.length && ds.length < 240; i += stepE) {
        const e = edgeList[i]
        ds.push(Math.hypot(e.a.x - e.b.x, e.a.y - e.b.y))
      }
      ds.sort((x, y) => x - y)
      const med = ds.length > 0 ? ds[ds.length >> 1] : 60
      clusterR = Math.min(280, Math.max(40, 1.6 * med))   // 聚簇门槛
      coreEps = Math.max(24, 1.0 * med)                   // 密度核心半径
      return { clusterR, coreEps }
    }
    // 区域计划缓存（v0.10.8）：聚簇/密度核心是**离散**判定，节点微动就会让成员跨过阈值 →
    // 区域数量与形状逐帧抖动（用户实拍："多面圈不断扩大缩小"）。故把「成员划分」缓存起来，
    // 只在离散事件（数据量变化 / 主题切换 / 模式变化）时重建；每帧只按实时坐标重算包围形状（平滑跟随）。
    const regionPlanCache = new Map()
    const regionSmooth = new Map()   // 区域形状的时间平滑状态（v0.10.8）：key = planKey#i

    const k = Math.sqrt((W() * H()) / Math.max(nodes.length, 1))
    // v0.15.0：maxDeg 随"度数加权"一起删除 —— 力模型不再关心度数（每一对节点平等），
    // 节点半径自带的 degree 项（nodeRadiusOf）纯属视觉。
    /** 节点世界半径（v0.10.11：**不随缩放变化**的布局常量）。原式带了 /√k：
     *  半径随缩放漂移 → "节点不重合"无法成为布局约束（放大就重叠），观感也会忽大忽小。
     *  现在半径是布局空间常量，配合下面的碰撞规避给出硬保证：任何缩放倍率下都不重合。 */
    /**
   * 节点半径（v0.17.0 加容器项；v0.17.1 改对数压制）。
   *
   * 合并产物 / 折叠容器的半径要**大于**普通节点——它代表的不止是一条记忆。
   *
   * 为什么不用 sqrt（v0.17.1 看图修正）：原式 base·√(1+k) 在 k=531 时算出 452px，
   * 画到画布上是个把整个主题团吞掉的巨无霸（实测预览图：最大的金色圆直径占画面 1/3）。
   * 折叠容器的 childCount 可以很大（无主题那批 531 条），任何无上界的增长都会失控。
   *
   * 改用**对数压制**：base·(1 + log2(1+k)·0.42)。实测各档位：
   *   k=10 → 48px、k=100 → 74px、k=531 → 94px（不是 452px）。
   * 差别只在"明显更大"，不再有失控的尾部——531 条的容器和 10 条的容器
   * 视觉上只差一倍，符合"它就是个占位"的语义。
   *
   * 为什么必须一起进物理：半径同时喂给碰撞检测（COLLIDE_GAP），容器变大后
   * 周围节点会自动让位——否则子点画出来会跟邻居重叠。
   */
  const nodeRadiusOf = (n) => {
    const base = 7 + Math.min(n?.degree ?? 0, 14) * 0.9
    const kids = Math.max(0, n?.childCount ?? 0)
    return kids > 0 ? base * (1 + Math.log2(1 + kids) * 0.42) : base
  }
    // v0.15.1：REP_C 这类力常数已全部搬到 graph-force.js（唯一定义处），这里不再留一份影子常量。
    const COLLIDE_GAP = 6        // 节点之间的最小空隙（世界坐标）；力已负责间距，这里只兜底"绝不重合"
    const collideCell = 2 * nodeRadiusOf({ degree: 14 }) + COLLIDE_GAP
    let dragNode = null
    // 被拖节点的上一帧位置：用来算"这一帧指针把它搬了多远"，作为 1 环邻居的速度前馈。
    const dragPrev = { x: 0, y: 0 }
    // 拖动模型（v0.14.3 重做）：**没有作用域、不冻结任何节点**。
    //   · 被拖节点是"运动学"物体：位置只由指针写死（速度清零、碰撞也不推它）；
    //   · 其余节点全程照常受力 —— 扰动沿弹簧网逐跳传播，阻尼让它自然衰减为涟漪，
    //     近处跟得多、远处几乎不动，但**不存在一圈僵住不动的边界**；
    //   · 1 环邻居额外吃一份"拖动速度前馈"，起手就跟（注入的是速度而不是位置，边照样能拉长）。
    // v0.10.10 的"图距离 ≤2 才动、范围外 v=0 冻结"会在图上留下一圈肉眼可见的僵死边界，
    // 用户实拍否掉了它：拖动应当是弹簧的涟漪，不是拖着一块焊死的铁板。
    // v0.15.0：主题锚点（零连接节点向本主题质心靠拢）删除 —— 又一种"朝某个特定点拉"的
    //   特权方向。零连接的点现在由邻域场自然吸附（半径内谁近就先被谁拉），不需要第二套规则。
    /** 确定性哈希（0..1）：同一 id 永远同一值——微动相位、碰撞同位置破局据此微分化。 */
    const hash01 = (id) => {
      let h = 0x811c9dc5
      const s2 = String(id)
      for (let i = 0; i < s2.length; i++) { h ^= s2.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
      return (h % 1000) / 1000
    }
    const transform = { x: 0, y: 0, k: 1 }
    const heat = (a) => { alpha = Math.max(alpha, a) }
    /** fixedAlpha 传入时用**固定** alpha（预热求真实平衡用）；否则按原衰减律 + 活跃度地板。 */
    const step = (fixedAlpha) => {
      if (typeof fixedAlpha === "number") alpha = fixedAlpha
      else alpha += (0 - alpha) * 0.028
      // ★ v0.15.1：**拖动不再单独"升温"**。α 是"工作点"，不是"温度"：
      //   旧代码静息 α=0.02、拖动抬到 0.4（相差 20 倍）—— 静息时布局被冻在"碰撞约束 + 弹簧"
      //   挤出的非平衡态上，一拖动等于全场力同时放大 20 倍，于是"拖一个点，盘里的球乱飞"。
      //   现在静息地板就是 0.4（见实时循环里的 alpha 地板），两者**同一个工作点**；
      //   拖动只做两件事：阻尼减半（让涟漪传出去）+ 给 1 环邻居速度前馈。
      //   布局本身已经停在力平衡处（净力 ≈ 0），所以抬高工作点不会"释放"任何存量不平衡。
      // 拖动前馈（v0.14.2）：被拖节点这一帧被指针搬了多远。1 环邻居据此**起手就跟**，
      // 不必等弹簧把拉伸量攒起来（旧实现只有弹簧，所以"拉很长才有明显加速"）。
      let dragDX = 0, dragDY = 0
      if (dragNode) {
        dragDX = dragNode.x - dragPrev.x; dragDY = dragNode.y - dragPrev.y
        dragPrev.x = dragNode.x; dragPrev.y = dragNode.y
      }
      // ★ 邻域半径场（v0.14.5，用户 m01095）
      //   模型（用户原话）：「每一个点以它自己为中心向周围划定一个半径，**半径内的点会影响这个点**，
      //   每一个点都是这样」—— 影响是**局部**的、**各向同性**的、**每个点平等**的：
      //     · 半径 R 内：每一对节点之间都有一对沿连线的力（近处斥、中距离吸），与有没有边无关；
      //     · 半径 R 外：**互不影响**（下面直接剔除，不参与任何力的计算）。
      //   与旧模型的差别：旧式斥力是**全对、无截断**的（一个点会被 800px 外的点推），
      //   引力只沿"有边"的方向，另有全场朝同一个点的中心引力 —— 于是力的"方向"只有那三种。
      //   现在每个点只跟**自己半径内的邻居**发生关系，方向是 360° 连续的，没有特权方向。
      //   R = k×range（默认 4.5k；按当前数据 k≈37px → R≈168px）。
      // 半径是**参数**：R = k×range（默认 4.5k；按当前数据 k≈37px → R≈168px）。
      // 曲线本身在 graph-force.js 的 pairForce() 里，可在 Node 里直接求值（test-graph-field.mjs）。
      const R = k * (P.range || 4.5)
      const R2 = R * R
      // 场内**任意一对**节点的力：近域斥、越过平衡距离后吸、半径外严格为 0。
      // 全部由 graph-force.js 的 pairForce() 决定 —— **一条公式**，不再是"斥力一条 + 引力一条"
      // 拼起来再指望它们碰巧抵消在某个位置。这里只负责：乘降温系数 α、拖动期折减、沿连线施加。
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          let dx = a.x - b.x, dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1e-6) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
          // 半径外互不影响：最便宜的剔除（d² ≥ R² 直接跳过，连 sqrt 都不做）
          if (d2 >= R2) continue
          const d = Math.sqrt(d2)
          // 拖动期只做一件事：与被拖节点相关的对少推 88%（否则指针会被自己的斥力顶开）。
          const dragPush = dragNode && (a === dragNode || b === dragNode) ? 0.12 : 1
          const f = pairForce(d, k, P) * alpha * dragPush
          a.vx += (dx / d) * f; a.vy += (dy / d) * f
          b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
        }
      }
      // 边弹簧（graph-force.js 的 springForce）：静止长度 k·1.15，**统一刚度**。
      // 长度不写死：受力时由力的平衡决定 —— 拉得越狠伸得越长，松手自己弹回（用户 m00958 要的弹簧感）。
      // 度数不再影响刚度：按"每对平等"的模型，枢纽的辐条不该比别人的硬。
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const f = springForce(d, k, P) * alpha
        e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f
        e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f
      }
      // 节点循环：只做「阻尼 → 常活微动 → 积分」。**这里没有任何位置力** ——
      // v0.15.0 删掉了中心引力与主题锚点，回到 d3-force 的配方：
      // link（弹簧）+ manyBody（带 distanceMax 的邻域场）+ collide + 整体平移归心。
      for (const n of nodes) {
        // 被拖节点：运动学物体 —— 位置由指针写死（onMove），这里只清速度，不让任何力推它。
        if (n === dragNode) { n.vx = 0; n.vy = 0; continue }
        // 拖动期间全场用**更轻的阻尼**（0.6：每帧保留 60% 速度）。静止值 0.3 太黏 ——
        // 弹簧力每帧被抹掉 70%，牵引根本传不出一跳，看起来就是"只有身边动、其余僵住"。
        // 轻阻尼让扰动像涟漪一样沿边逐跳衰减地传开：距离是**连续**变化的，没有那条硬边界。
        // 1 环邻居再额外吃 25% 的拖动位移（速度前馈）：起手就跟；注入的是速度不是位置，
        // 所以边依然会被拉长（保住弹簧感）。
        let damp = P.damping
        if (dragNode) {
          damp = 0.6
          if (neighbors.get(dragNode.id)?.has(n.id)) { n.vx += dragDX * 0.25; n.vy += dragDY * 0.25 }
        }
        // ★ v0.15.0：**删掉中心引力与主题锚点**。两者都是"全场朝同一个点拉"的特权方向，
        //   正是"拖一个点 → 所有点往中间跑"的元凶：引力强度 ∝ 到画布中心的距离，平时被阻尼
        //   冻在"力不平衡但不动"的静默态里，拖动一旦把 α 抬到 0.4 就全场一起收缩。
        //   替代品不是"更弱的中心力"，而是**整体平移归心**（recenter，见 step 末尾）：
        //   d3-force 的 forceCenter 正是这么做（源码里一个力都没施加，只有 node.x -= sx），
        //   数学上不可能改变形状、不可能收缩 —— 也就不可能再"偷"出一个约束力。
        //   同时删掉度数加权（degNorm/jitter/gw）：按"每一对节点平等"的模型，
        //   度数是拓扑的自然结果，不该被特判成位置偏好。
        // ★ v0.14.4 常活微动（用户 m01002：「我不拉的时候图谱又不动了，这也是我不想的」）
        //   力导向收敛后每个节点的净力都 ≈ 0 —— 图"死"在平衡点上（循环还在跑，但没有力了）。
        //   这里加一层**零均值**的低频扰动：相位由 id 哈希决定、两条正交正弦（周期 16s/22s），
        //   节点绕着平衡点缓慢游走（±10~20px）。时间平均为 0 → 平衡点不变、布局不会被带偏；
        //   是"缓慢游走"而不是 v0.9.13 那种高频抖动（那个被用户否过）。
        //   ★ v0.15.1 改判据：α 现在**常驻 0.4**（拖动与静息同一个工作点），不能再拿"α 小"当
        //   "已静止"的信号 —— 否则 calm 恒为 0，图会彻底死住。改用**交互状态**做闸门：
        //   预热求平衡、拖动、背景平移期间关掉，其余时间常开。幅度/周期/相位都不变，
        //   其稳态速度 ≈ 0.057px/帧 ≈ 3.4px/s（与 α 无关，实测过）。P.wobble = 0 可完全关掉。
        const calm = (!dragNode && !preheating) ? 1 : 0
        if (P.wobble > 0 && calm > 0) {
          const tms = performance.now()
          const ph = hash01(n.id) * 6.283185307
          n.vx += Math.sin(tms * 0.0004 + ph) * P.wobble * calm
          n.vy += Math.cos(tms * 0.00029 + ph * 1.618) * P.wobble * calm
        }
        n.vx *= damp; n.vy *= damp
        // 单帧速度上限（v0.15.1）：数值安全网。近场斥力 ∝ 1/u²，两点贴到一起时单帧冲量可以极大；
        // 上限让"乱飞"在物理上不可能发生，且**不改变平衡位置**（只截断瞬态、不截断稳态）。
        clampSpeed(n, P.maxSpeed)
        n.x += n.vx * 1.5; n.y += n.vy * 1.5
      }
      // 碰撞规避（v0.10.11）：节点**不得重合**——位置式硬约束（网格加速，O(n)）。
      // 力（斥力/弹簧/引力）负责"自然布局"，这一步只负责兜底"物理上不重叠"，
      // 两者配合 = 用户要的"各自引斥力平衡 + 不重合"。
      const grid = new Map()
      for (const n of nodes) {
        const key = Math.floor(n.x / collideCell) + ',' + Math.floor(n.y / collideCell)
        const arr = grid.get(key)
        if (arr) arr.push(n)
        else grid.set(key, [n])
      }
      for (const n of nodes) {
        const gx0 = Math.floor(n.x / collideCell), gy0 = Math.floor(n.y / collideCell)
        const fixedN = n === dragNode   // 被拖节点不被碰撞推开：它的位置归指针管（推它会跟指针打架、画面抖）
        for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
          for (let gy = gy0 - 1; gy <= gy0 + 1; gy++) {
            const arr = grid.get(gx + ',' + gy)
            if (!arr) continue
            for (const m of arr) {
              if (m === n || m.id <= n.id) continue     // 每对只处理一次（id 比较，稳定）
              const minD = nodeRadiusOf(n) + nodeRadiusOf(m) + COLLIDE_GAP
              let dx = m.x - n.x, dy = m.y - n.y
              let d2 = dx * dx + dy * dy
              if (d2 >= minD * minD) continue
              let d = Math.sqrt(d2)
              if (d < 1e-6) { dx = hash01(n.id) - 0.5; dy = hash01(m.id) - 0.5; d = Math.hypot(dx, dy) || 1 }
              const push = (minD - d) * 0.5 * 0.8       // 各推一半、留 20% 欠松弛：既快速分离又不抖
              const ux = dx / d, uy = dy / d
              const fixedM = m === dragNode
              if (!fixedN) { n.x -= ux * push; n.y -= uy * push }
              if (!fixedM) { m.x += ux * push; m.y += uy * push }
              if (n !== dragNode && m !== dragNode) { n.vx *= 0.6; n.vy *= 0.6; m.vx *= 0.6; m.vy *= 0.6 }
            }
          }
        }
      }

      // 整体平移归心（d3-force forceCenter 语义，**不是力**）：把质心挪回画布中心。
      // 一个力都不施加 → 不可能改变形状、不可能让图收缩；它只保证图不飘出视野。
      // 力模型里从此没有"中心"这个概念，位置归中纯粹是渲染层的事。
      recenter(nodes, W() / 2, H() / 2)
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

    /** 聚焦到指定节点集合（v0.10.7）：主题筛选后自动把视口收拢到该主题，
     *  留 130px 边距、上限放大 2.4×（密度低时不至于糊成巨点）。 */
    const fitTo = (ids) => {
      if (!ids || ids.size === 0) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      let hit = 0
      for (const n of nodes) {
        if (!ids.has(n.id)) continue
        hit++
        if (n.x < minX) minX = n.x
        if (n.y < minY) minY = n.y
        if (n.x > maxX) maxX = n.x
        if (n.y > maxY) maxY = n.y
      }
      if (hit === 0) return
      const pad = 130
      const bw = Math.max(maxX - minX, 80), bh = Math.max(maxY - minY, 80)
      const kFit = Math.min((W() - pad * 2) / bw, (H() - pad * 2) / bh, 2.4)
      transform.k = Math.max(0.28, kFit)
      transform.x = (W() - bw * transform.k) / 2 - minX * transform.k
      transform.y = (H() - bh * transform.k) / 2 - minY * transform.k
    }

    // ---- 打开动画：预热模拟 → 立即全景 → 从中心向两边平滑显现 ----
    // 1) 预热（v0.10.7）：
    //    - 命中缓存（≥85% 节点有旧坐标）：坐标已是上次收敛态 → 只做几步微松弛，打开即"全局平衡"；
    //    - 未命中：把力导向**跑到收敛**（alpha ≤ 0.003，上限 2500 步）再落盘 —— 等于"把平衡跑在打开之前"。
    let warm = 0
    // v0.15.1：预热（求平衡）期间关掉常活微动 —— 别把噪声写进"平衡态"，也让上面那些
    // 固定 α 的松弛步只做纯力学。实时循环一开就置回 false（见下面 fitToView 之前）。
    let preheating = true
    if (restoreOk) {
      alpha = 0.02
      for (let i = 0; i < 24; i++) step()
    } else {
      // 收敛策略（v0.10.10 修正，两段式）：
      // 原实现让 `step()` 衰减 alpha —— 速度变小只是因为"力被 alpha 杀死了"，布局远未平衡，
      // 于是把"种子初位 + 一点扰动"当成平衡冻进缓存（用户实拍：节点像按顺序排在同心的圈上 ——
      // 旧版种子确实是把所有节点铺在一个半径 200px 的环上，v0.15.1 换成分量成盘了）。
      // 物理事实：平衡位置与 alpha 无关（所有力同倍缩放），alpha 只决定步长。
      // 故：① 大步快铺（固定 0.45）把结构铺开；② 慢衰减收尾（×0.985/步）让布局真正落到力平衡。
      // 实测（真实快照 490 节点）：800 步 / 约 250ms，一次收敛后落盘，后续打开直接复用。
      for (let i = 0; i < 400; i++) { step(0.45); warm++ }
      for (let i = 0; i < 400; i++) { step(0.45 * Math.pow(0.985, i + 1)); warm++ }
      alpha = 0.4   // 交给实时循环的工作点（v0.15.1：静息与拖动同一个 α，不再有 20 倍跳变）
      saveLayout(sig, nodes)
    }
    // 2) 立即全景（不再等模拟收敛后才跳变缩放）
    preheating = false   // 预热结束：常活微动从这里开始生效
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
      // 主题高亮（v0.15.2）：同主题是一条**独立**读数，不能只靠"边相邻"。
      // 主题是**语义**分组：本机 857 点里 395 个孤立点（46%）没有任何边，而同一个主题的成员
      // 绝大多数彼此无边 —— 只点亮边相邻点，等于"圈出了整个主题、却只亮了几个人"（用户 2026-10-03 反馈）。
      // 空主题/未归类不参与（否则一次悬停点亮几百个无关点）。
      const hlTheme = (() => {
        if (!focusId) return null
        const t = nodeById.get(focusId)?.theme
        return t && t !== "(未归类)" ? t : null
      })()
      // 事件高亮（阶段四）：focusIds 非空时，非事件成员降透明度
      const focusIds = focusIdsRef?.current ?? null
      // 主题筛选（v0.10.7）：选中某主题 → 该主题节点保留、其余变灰降透明；与事件高亮可叠加
      const tf = themeFocusRef?.current ?? null
      const themeFilterName = tf?.theme ?? null
      const themeIds = tf?.ids ?? null
      const dimOf = (id) => (focusIds && !focusIds.has(id)) || (themeIds && !themeIds.has(id))
      // 入场动画：边整体淡入（350ms），节点按距中心距离延迟显现
      const elapsed = performance.now() - bornAt
      const overallT = Math.min(1, elapsed / 350)
      for (const e of edges) {
        const on = !focusId || e.a.id === focusId || e.b.id === focusId
        const dimmed = dimOf(e.a.id) || dimOf(e.b.id)
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
      // 主题区域（v0.10.6 重做，替代 v0.10.5 的"全主题全局凸包"）：
      // 教训：主题是**语义**分组，在力导向布局里往往弥散（实测 96 条成员的簇摊开半个画布），
      // 直接给每个主题取全局凸包 → 一堆巨大多边形互相叠、把别家节点兜进来，观感"碎玻璃"。
      // 现按 graphView.themeScope 分策略：
      //   focus（默认）：只画**当前聚焦节点所属主题**的完整范围（悬停/选中即见，含全体成员）——零干扰、信息明确；
      //   always：只给每个主题的**密集团**画（densityCore 滤掉链状稀疏末端，最多 8 片）；
      //   off：不画。
      // 形状 themeShape：hull 贴合凸包 / circle 最小外接圆；每帧按实时坐标重算 → 随主题中心移动。
      const themeMode = P.themeScope === "always" ? "always" : (P.themeScope === "off" ? "off" : "focus")
      const themeShape = P.themeShape === "hull" ? "hull" : "circle"
      const themeGroupsAll = new Map()
      for (const n of nodes) {
        const t = n.theme
        if (!t || t === "(未归类)") continue
        if (!themeGroupsAll.has(t)) themeGroupsAll.set(t, [])
        themeGroupsAll.get(t).push(n)
      }
      // 要画哪个/哪些主题：主题筛选 > 悬停主题（focus 模式）> 全部（always 模式）
      const focusTheme = (() => {
        if (themeFilterName) return themeFilterName
        const t = focusId ? nodeById.get(focusId)?.theme : null
        return t && t !== "(未归类)" ? t : null
      })()
      const planKey = `${themeMode}|${themeShape}|${themeFilterName ?? ""}|${focusTheme ?? ""}|${nodes.length}|${edges.length}`
      let plan = regionPlanCache.get(planKey)
      if (!plan) {
        if (regionPlanCache.size > 48) { regionPlanCache.clear(); regionSmooth.clear() }
        const { clusterR: cr, coreEps: ce } = computeThemeScale(edges)
        // 两种语义（v0.10.9）：
        //  · 选中/聚焦某主题（focus 模式或主题筛选）：画**整主题**——把所有成员都包住（其余节点已变灰，
        //    此刻不需要"只圈密集团"，散落的同主题节点若落在圈外反而费解）；
        //  · 常显（always）：多个主题同时在图上，只圈各自的**密集团**（densityCore 滤稀疏末端），否则糊成一片。
        const wholeTheme = !!themeFilterName || themeMode === "focus"
        const themesToDraw = themeMode === "always" && !themeFilterName ? [...themeGroupsAll.keys()] : (focusTheme ? [focusTheme] : [])
        plan = []
        for (const theme of themesToDraw) {
          const all = themeGroupsAll.get(theme) ?? []
          if (all.length === 0) continue
          if (wholeTheme) {
            // v0.15.2：整主题改成**分片**画，不再"全体成员一个圈"。
            // 根因：主题是**语义**分组，连通分量是**物理**分组 —— 本机 499 个分量里 66 个跨主题（372 点），
            // 按多数主题归属后仍有 204 点（24%）落在别家组团里。只要有一个离群成员，
            // "全体成员的最小外接圆"就会被撑到整块画布：实测 comfyui/dsh-memory 全体圈 223% vs 本主题圈 105%、
            // 莉音/休眠舱 73% vs 39%（用户实拍：圈罩住大半个画布、圈内亮点稀疏）。
            // 现按 clusterByDistance 分片：主片贴合"这片相关的内容"，离群成员各得一个小圈 → 一眼看出"它在别处"。
            const clumps = all.length >= 2 ? clusterByDistance(all, cr, { minSize: 1 }) : [all]
            for (const clump of clumps) {
              const hullPts = convexHull(clump)
              const pinnedIds = hullPts.map((hp) => clump.find((n) => n.x === hp.x && n.y === hp.y)?.id).filter(Boolean)
              plan.push({ theme, members: clump, pinnedIds, total: all.length })
            }
            continue
          }
          if (all.length < 4) continue
          for (const clump of clusterByDistance(all, cr, { minSize: 4 })) {
            const core = densityCore(clump, { eps: ce, minNeighbors: 2, minSize: 4 })
            if (core.length < 4) continue
            // 凸包钉顶点（v0.10.8）：凸包顶点会随节点微动进出（实测 300 帧 72 次）→ 轮廓突变。
            // 故在重建计划时把顶点**固定到具体节点**，之后每帧只移动这些节点对应的顶点。
            const hullPts = convexHull(core)
            const pinnedIds = hullPts.map((hp) => core.find((n) => n.x === hp.x && n.y === hp.y)?.id).filter(Boolean)
            plan.push({ theme, members: core, pinnedIds, total: all.length })
          }
        }
        plan.sort((a, b) => b.members.length - a.members.length)
        if (themeMode === "always" && !themeFilterName) plan = plan.slice(0, 8)
        regionPlanCache.set(planKey, plan)
      }
      const primaryTheme = !!themeFilterName || themeMode === "focus"
      const themeLabels = []
      let primaryLabeled = false
      const SMOOTH = 0.22   // 时间平滑系数：跟手但不过冲（滞后约 4 帧 ≈ 67ms，肉眼无感）
      for (let i = 0; i < plan.length; i++) {
        const r = plan[i]
        const rk = planKey + "#" + i
        // 每帧按**实时坐标**重算包围形状（成员划分来自缓存 → 形状平滑跟随），再做一次时间平滑：
        // 实时物理有 0.02 的活跃度地板，节点一直在微动，而凸包顶点会把单点微动放大成外轮廓呼吸
        // （用户实拍："多面圈不断扩大缩小"）——指数滤波把这种抖动抹平。
        let maxNodeR = 0
        for (const n of r.members) maxNodeR = Math.max(maxNodeR, nodeRadiusOf(n))
        const pad = maxNodeR + 10 / transform.k
        let raw
        if (themeShape === "hull" && r.pinnedIds && r.pinnedIds.length >= 3) {
          // 钉住顶点版凸包：顶点集合固定，位置随节点实时更新 → 轮廓连续（配合下面的时间平滑更稳）
          const poly = r.pinnedIds.map((id) => nodeById.get(id)).filter(Boolean).map((n) => ({ x: n.x, y: n.y }))
          const hull = convexHull(poly)
          raw = hull.length >= 3
            ? { kind: "hull", points: padConvexPolygon(hull, pad), hull, cx: 0, cy: 0, topY: 0 }
            : themeBounds(r.members, { shape: "circle", pad })
        } else {
          raw = themeBounds(r.members, { shape: themeShape, pad })
        }
        if (!raw) continue
        const prev = regionSmooth.get(rk)
        let drawShape
        if (raw.kind === "hull") {
          let pts = raw.points
          if (prev && prev.kind === "hull" && prev.points.length === pts.length) {
            pts = pts.map((p, k) => {
              const q = prev.points[k]
              return { x: q.x + (p.x - q.x) * SMOOTH, y: q.y + (p.y - q.y) * SMOOTH }
            })
          }
          drawShape = { kind: "hull", points: pts, cx: pts.reduce((a, p) => a + p.x, 0) / pts.length, topY: Math.min(...pts.map((p) => p.y)) }
        } else {
          let cx = raw.cx, cy = raw.cy, rr = raw.r
          if (prev && prev.kind === "circle") {
            cx = prev.cx + (cx - prev.cx) * SMOOTH
            cy = prev.cy + (cy - prev.cy) * SMOOTH
            rr = prev.r + (rr - prev.r) * SMOOTH
          }
          drawShape = { kind: "circle", cx, cy, r: rr, topY: cy - rr }
        }
        regionSmooth.set(rk, drawShape)
        // 覆盖自检（v0.10.9）：钉住顶点的多边形可能因节点漂移而漏掉成员——发现漏点即作废该计划，
        // 下一帧重建（重建会把漏掉的点重新纳入顶点集），确保"整主题全部被包住"。
        if (themeShape === "hull" && drawShape.kind === "hull") {
          for (const n of r.members) {
            if (!polygonContains(drawShape.points, n)) {
              regionPlanCache.delete(planKey)
              break
            }
          }
        }
        const base = pickColor(data.themes, r.theme, "note")
        const mm = /hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)/.exec(base)
        const hue = mm ? +mm[1] : 200
        const dimmed = r.members.every((n) => dimOf(n.id))
        const isPrimary = primaryTheme
        // 层序（v0.10.6）：区域画到**边与节点之下**（destination-over），否则半透明填充像彩色塑料膜蒙住网络
        ctx.globalAlpha = (isPrimary ? 0.95 : 0.7) * overallT * (dimmed ? 0.06 : 1)
        ctx.beginPath()
        if (drawShape.kind === "hull") {
          const pts = drawShape.points
          ctx.moveTo(pts[0].x, pts[0].y)
          for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y)
          ctx.closePath()
        } else {
          ctx.arc(drawShape.cx, drawShape.cy, drawShape.r, 0, Math.PI * 2)
        }
        ctx.lineJoin = "round"   // 外扩多边形顶点本身已贴合，不走顶点圆滑（会切进节点），只柔化描边转角
        ctx.globalCompositeOperation = "destination-over"
        ctx.fillStyle = `hsla(${hue},70%,58%,${isPrimary ? 0.14 : 0.10})`
        ctx.fill()
        ctx.globalCompositeOperation = "source-over"
        ctx.strokeStyle = `hsla(${hue},74%,66%,${isPrimary ? 0.5 : 0.28})`
        ctx.lineWidth = (isPrimary ? 1.5 : 1.1) / transform.k
        ctx.setLineDash([])
        ctx.stroke()
        // 聚焦/筛选主题：主片标签写"主题总数"，其余片不刷屏（v0.15.2 起：片数可能 >1，
        // 只有 ≥3 成员的片值得贴自己的片内数；1~2 个离群成员只留一个小圈，不写字）
        const isPrimaryLabel = isPrimary && !primaryLabeled
        if (isPrimaryLabel) primaryLabeled = true
        if (isPrimaryLabel || r.members.length >= 3) themeLabels.push({
          text: (isPrimaryLabel ? r.total : r.members.length) + " · " + r.theme,
          x: drawShape.cx,
          y: drawShape.topY - 8 / transform.k,
          hue,
          primary: isPrimaryLabel,
          dimmed: !!dimmed,
        })
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
        // 同主题成员：亮起但略暗于"自己/直连邻居"，两档读数并存（连接 ≠ 主题）
        const isTheme = hlTheme && n.id !== focusId && !isNbr && n.theme === hlTheme
        const dimmed = dimOf(n.id)
        // 从中心向两边显现：延迟按距中心距离比例（0~55% 的动画时长），easeOutCubic 放大+淡入
        const dist = Math.hypot(n.x - cx0, n.y - cy0)
        const delay = (dist / maxDist) * 0.55 * revealMs
        const t = Math.min(1, Math.max(0, (elapsed - delay) / 320))
        const ease = t <= 0 ? 0 : 1 - (1 - t) * (1 - t) * (1 - t)
        if (ease <= 0.001) continue
        // 三档：自己 + 直连邻居 1.0 / 同主题成员 0.85 / 其余 0.2
        ctx.globalAlpha = (focusId ? (isFocus || isNbr ? 1 : (isTheme ? 0.85 : 0.2)) : 1) * ease * (dimmed ? 0.12 : 1)
        ctx.beginPath()
        const r = nodeRadiusOf(n) * ease
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = n.color
        ctx.fill()
        /**
         * 容器可视化（v0.17.0 主题合并）：合并产物画成"装着子记忆的容器"。
         *
         * 为什么是**画在容器内的一圈小点**而不是真的把子节点塞进去跑物理：
         * 子记忆（已归档）不参与布局计算——它们若进物理循环，会把这个主题团撑散、
         * 把邻居拱走。所以子点位置**由父节点推导**（固定角度均匀分布），不跑力。
         * 这样"看得见"与"不影响布局"两件事同时成立。
         *
         * 默认只在放大到一定程度或聚焦时画小点：缩得太小时它们只是一个像素的噪点。
         */
        if ((n.childCount ?? 0) > 0 && (transform.k > 0.7 || isFocus)) {
          const kids = Math.min(n.childCount, 12)
          const kr = Math.max(2.2, r * 0.14)          // 子点半径
          const orbit = r * 0.62                       // 子点分布半径（容器内一圈）
          for (let ki = 0; ki < kids; ki++) {
            const ang = (ki / kids) * Math.PI * 2 - Math.PI / 2
            const kx = n.x + Math.cos(ang) * orbit
            const ky = n.y + Math.sin(ang) * orbit
            ctx.beginPath()
            ctx.arc(kx, ky, kr * ease, 0, Math.PI * 2)
            ctx.fillStyle = "#ffd54f"
            ctx.globalAlpha = 0.85 * (focusId ? (isFocus ? 1 : 0.35) : 1) * ease
            ctx.fill()
          }
          // 容器外圈描边：让"这是一团"读得出来
          ctx.beginPath()
          ctx.arc(n.x, n.y, r + 2 / transform.k, 0, Math.PI * 2)
          ctx.strokeStyle = "#ffd54f"
          ctx.lineWidth = 1.2 / transform.k
          ctx.globalAlpha = 0.5 * ease * (focusId ? (isFocus ? 1 : 0.3) : 1)
          ctx.stroke()
          ctx.globalAlpha = (focusId ? (isFocus || isNbr ? 1 : (isTheme ? 0.85 : 0.2)) : 1) * ease * (dimmed ? 0.12 : 1)
        }
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
      // 主题标签（v0.10.6）：画在**节点之上**（免得被节点盖住），带碰撞避让与"每主题 1 个"上限
      if (themeLabels.length > 0) {
        ctx.font = `bold ${11 / transform.k}px sans-serif`
        ctx.textAlign = "center"
        const placed = []
        const perTheme = new Map()
        for (const lb of themeLabels) {
          const key = lb.text.replace(/^\d+ · /, "")
          const cnt = perTheme.get(key) ?? 0
          if (!lb.primary && cnt >= 1) continue
          const tw = ctx.measureText(lb.text).width
          const th = 13 / transform.k
          const box = { minX: lb.x - tw / 2, maxX: lb.x + tw / 2, minY: lb.y - th, maxY: lb.y + th * 0.3 }
          const hit = placed.some((b) => !(box.maxX < b.minX || box.minX > b.maxX || box.maxY < b.minY || box.minY > b.maxY))
          if (hit && !lb.primary) continue
          placed.push(box)
          perTheme.set(key, cnt + 1)
          ctx.globalAlpha = (lb.primary ? 1 : 0.85) * overallT * (lb.dimmed ? 0.1 : 1)
          ctx.fillStyle = `hsla(${lb.hue},70%,${lb.primary ? 78 : 74}%,0.95)`
          ctx.fillText(lb.text, lb.x, lb.y)
        }
      }
      ctx.globalAlpha = 1
      ctx.restore()
    }
    drawRef.current = draw

    let persistTick = 0
    let lastThemeStamp = null
    const loop = () => {
      // v0.9.17 实时持续物理：活跃度地板保底，力导向一直运行、永不冻结。
      // ★ v0.15.1：地板从 0.02 提到 **0.4**。旧值把力压到设计强度的 2%，布局永远爬不到平衡
      //   （实测：1500 帧后仍在 0.457px/帧 缓慢膨胀，最近邻只有平衡距离的 22%），而一旦拖动
      //   把 α 抬到 0.4，全场力同时放大 20 倍 → "拖一个点，盘里的球乱飞"。
      //   现在静息与拖动**同一个工作点**，布局停在真正的力平衡上，拖动不再释放存量不平衡。
      alpha = Math.max(alpha, 0.4)
      step()
      // 主题筛选（v0.10.7）：stamp 变化 → 视口收拢到该主题（只做一次，之后用户可自由平移缩放）
      const tf = themeFocusRef?.current ?? null
      if (tf && tf.stamp !== lastThemeStamp) {
        lastThemeStamp = tf.stamp
        if (tf.ids && tf.ids.size > 0) fitTo(tf.ids)
      } else if (!tf) {
        lastThemeStamp = null
      }
      draw()
      // 布局落盘（v0.10.7）：每 ~5s 存一次当前收敛坐标，供下次打开直接落位
      if (++persistTick % 300 === 0) saveLayout(sig, nodes)
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
      let best = null, bestD = (nodeRadiusOf({ degree: 14 }) + 8) ** 2   // 世界空间常量（v0.10.11）
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
      // 抓住的瞬间"升温"到 0.35：整张图醒过来、弹簧开始牵引；松手后 alpha 自然衰减冷却，
      // 于是能看到一次回弹后的收敛（弹簧感的一部分）。
      if (n) { dragNode = n; dragPrev.x = n.x; dragPrev.y = n.y; heat(0.35); if (!raf) raf = requestAnimationFrame(loop) }
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
      saveLayout(sig, nodes)   // 关闭面板时落盘当前收敛布局（v0.10.7）
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

/**
 * 合并来源列表（v0.17.0 主题合并）：点开看这条结论是由哪几条合来的。
 *
 * 为什么需要它：合并是**有损**的——模型合成时只保留关键约束，细节会丢。
 * 源记忆虽然归档了（不进检索、不进图谱顶层），但它们的数据完整保留；
 * 这个面板就是那道"要看原文随时能看"的口子。没有它，用户对合并只能选择信任。
 */
const MergeSources = memo(function MergeSources({ id, count, kind }) {
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState(null)
  const [err, setErr] = useState("")
  const load = async () => {
    if (group || err) { setOpen((v) => !v); return }
    try {
      const r = await fetch("/dsh-memory/merged?id=" + encodeURIComponent(id))
      const j = await r.json()
      if (j && Array.isArray(j.children)) { setGroup(j); setOpen(true) }
      else { setErr("接口未返回数据") ; setOpen(true) }
    } catch (e) { setErr(String(e && e.message || e)); setOpen(true) }
  }
  return (
    <div style={{ margin: "12px 0 0" }}>
      <button
        onClick={load}
        style={{ fontSize: 12, padding: "4px 10px", cursor: "pointer", background: "#242424", color: "#ffd54f", border: "1px solid #3a3a3a", borderRadius: 4 }}
      >
        {open ? "▾" : "▸"} {kind === "aggregate" ? ("已折叠的记忆（" + count + " 条）") : ("合并来源（" + count + " 条）")}
      </button>
      {open && err ? <p style={{ fontSize: 12, color: "#e07b39", margin: "8px 0 0" }}>读取失败：{err}</p> : null}
      {open && group ? (
        <div style={{ marginTop: 8, borderLeft: "2px solid #3a3a3a", paddingLeft: 10 }}>
          {group.children.map((c, i) => (
            <div key={c.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "#888" }}>
                {i + 1}. {c.type} · {new Date(c.created_at).toLocaleDateString("zh-CN")} · {c.archived ? "已归档" : "活跃"}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.55, color: "#bbb", whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto" }}>
                {c.content}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
})

/** 详情面板（memo：仅选中变化时重渲染）。 */
const DetailPanel = memo(function DetailPanel({ selected, data }) {
  const { colorOf, adj, nodeById } = useMemo(() => {
    const co = (theme, type) => pickColor(data.themes, theme, type)
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
      <h4 style={{ margin: "0 0 8px", color: colorOf(selected.theme, selected.type) }}>{selected.theme || "(未归类)"}</h4>
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
      {/**
        * 合并来源（v0.17.0）：这条记忆是由哪几条合来的。
        * 默认不展开——它的价值是"让人知道这条结论有底可查"，而不是每次都读一遍原文。
        * 点开才拉取（懒加载，一次 HTTP），避免打开面板就为每条记忆拉一遍源内容。
        */}
      {(selected.childCount ?? 0) > 0 ? <MergeSources id={selected.id} count={selected.childCount} kind={selected.aggregated ? "aggregate" : "merged"} /> : null}
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
    // v0.15.1：力模型重写后只剩「邻域场 + 边弹簧 + 阻尼 + 微动」。
    // 旧键 repulsion / attract / gravity 三个一起废除：前两个合并成 field 与 spacing，
    // 中心引力**没有替代品**（它换成了纯平移的 recenter，见 graph-force.js）。
    //   field    = 整场强度倍率（0 = 关掉场内力，只剩弹簧）
    //   spacing  = 平衡间距（×k）：比它近就斥、比它远就吸，d = k·spacing 处受力恰好为 0
    //   attract  = 远场引力峰值（v0.15.1 新增，默认 0.06）。**必须小**：引力是累加的、斥力是
    //              封顶的，一个点周围壳层里 ~25 个邻居的引力之和会压过核心斥力 → 整盘塌陷
    //              （实测表见 graph-force.js 文件头）。0 = 只剩斥力（孤立点会更散）。
    //   maxSpeed = 单帧速度上限（v0.15.1 新增，默认 4）。数值安全网，不动平衡位置。
    spring: Number(gv.spring) || 0.13,
    damping: Number(gv.damping) || 0.3,
    // field / spacing / attract / maxSpeed / wobble / range 用 isFinite 而不是 `||`：
    // **0 是合法值**（关掉某项），用 `||` 会把用户填的 0 悄悄换成默认值——"设了没反应"最容易被当成 bug。
    field: Number.isFinite(Number(gv.field)) ? Number(gv.field) : 1,
    spacing: (() => { const v = Number(gv.spacing); return Number.isFinite(v) && v > 0 ? v : 1.6 })(),
    attract: Number.isFinite(Number(gv.attract)) ? Number(gv.attract) : 0.06,
    maxSpeed: (() => { const v = Number(gv.maxSpeed); return Number.isFinite(v) && v > 0 ? v : 4 })(),
    wobble: Number.isFinite(Number(gv.wobble)) ? Number(gv.wobble) : 0.04,
    // 邻域半径（×k）。≤0 / 非数字 → 默认 4.5：R=0 意味着"谁也不影响谁"，那不是一种手感而是故障。
    range: (() => { const v = Number(gv.range); return Number.isFinite(v) && v > 0 ? v : 4.5 })(),
    themeShape: gv.themeShape === 'hull' ? 'hull' : 'circle',   // 主题区域形状（v0.10.8：默认圆形，轮廓连续不抖）
    themeScope: gv.themeScope === 'always' || gv.themeScope === 'off' ? gv.themeScope : 'focus',   // 显示策略（v0.10.6）
  }), [gv.spring, gv.damping, gv.field, gv.spacing, gv.attract, gv.maxSpeed, gv.wobble, gv.range, gv.themeShape, gv.themeScope])

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

  // 主题筛选（v0.10.7）：选中某主题 → 该主题节点/边保留，其余变灰降透明；视口自动收拢到该主题
  const [themeFilter, setThemeFilter] = useState("all")
  const themeFocusRef = useRef(null)
  const themeStampRef = useRef(0)
  const themeCounts = useMemo(() => {
    const m = new Map()
    for (const n of filtered?.nodes ?? []) {
      const t = n.theme
      if (!t) continue
      m.set(t, (m.get(t) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [filtered])
  useEffect(() => {
    if (themeFilter === "all") {
      themeFocusRef.current = null
    } else {
      const ids = new Set((filtered?.nodes ?? []).filter((n) => n.theme === themeFilter).map((n) => n.id))
      // 空集合会把整图变灰（dimOf 对每个节点都返回 true）——该主题在当前时间窗内没有节点时不启用筛选
      themeFocusRef.current = ids.size > 0 ? { theme: themeFilter, ids, stamp: ++themeStampRef.current } : null
    }
    drawRef.current?.()
  }, [themeFilter, filtered])

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
          <select
            value={themeFilter}
            onChange={(e) => setThemeFilter(e.target.value)}
            style={{ padding: "1px 6px", fontSize: 12, borderRadius: 5, border: "1px solid #555", background: "#1a1a1a", color: "#ccc", maxWidth: 220 }}
            title="按主题筛选：选中的主题高亮并自动聚焦视口，其余记忆变灰"
          >
            <option value="all">全部主题</option>
            {themeCounts.map(([t, c]) => (
              <option key={t} value={t}>
                {t}（{c} 条）
              </option>
            ))}
          </select>
          <button onClick={load} style={{ padding: "1px 10px", borderRadius: 5, border: "1px solid #555", background: "transparent", color: "#aaa", cursor: "pointer", fontSize: 12 }}>刷新</button>
        </div>
          <ObsidianGraph data={filtered} onSelect={setSelected} selectedRef={selectedRef} drawRef={drawRef} physics={physics} focusIdsRef={focusIdsRef} themeFocusRef={themeFocusRef} />
        <div style={{ position: "absolute", right: 14, bottom: 10, fontSize: 11, color: "#777", zIndex: 2, display: "flex", flexWrap: "wrap", gap: 8, maxWidth: "72%", justifyContent: "flex-end", alignItems: "center" }}>
          {(filtered?.nodes ?? []).length > 0 && (
            <>
              <span>节点色：</span>
              {Object.entries(TYPE_COLORS).filter(([t2]) => (filtered?.nodes ?? []).some((n) => n.type === t2)).map(([t2, c]) => (
                <span key={t2} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <i style={{ width: 8, height: 8, borderRadius: "50%", background: c, display: "inline-block" }} />{TYPE_LABEL[t2] ?? t2}
                </span>
              ))}
              <span style={{ color: "#888" }}>无主题默认按类型上色</span>
            </>
          )}
          {EDGE_ORDER.filter((t2) => (filtered?.edges ?? []).some((e) => e.type === t2)).map((t2) => (
            <span key={t2} style={{ color: EDGE_STYLE[t2].color }}>
              {t2 === "similarTo" ? "—" : t2 === "before" ? "→" : t2 === "mentions" ? "· ·" : "—"}{" "}{EDGE_LABEL[t2]}
            </span>
          ))}
          <span style={{ color: "#ffd54f" }}>◎ +N = 更新过 N 次</span>
          <span>色浅新 · 色深旧（明度差=年龄）</span>
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
  // v0.12.8：日志并入本面板，用标签切换（不再单独占侧边栏入口）
  const [view, setView] = useState('graph')
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
        {/* v0.12.8 图标：渐变 + 光晕的节点网络（替换原来的纯色三点连线） */}
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id="dshMemGrad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#7cc4ff" />
              <stop offset="52%" stopColor="#a78bfa" />
              <stop offset="100%" stopColor="#f0a868" />
            </linearGradient>
          </defs>
          <circle cx="12" cy="12" r="9.2" stroke="url(#dshMemGrad)" strokeWidth="0.9" opacity="0.3" />
          <path d="M5 6 L12 12 M19 6 L12 12 M12 12 L12 20" stroke="url(#dshMemGrad)" strokeWidth="1.5" strokeLinecap="round" opacity="0.9" />
          <circle cx="5" cy="6" r="2.3" fill="url(#dshMemGrad)" />
          <circle cx="19" cy="6" r="2.3" fill="url(#dshMemGrad)" />
          <circle cx="12" cy="20" r="2.3" fill="url(#dshMemGrad)" />
          <circle cx="12" cy="12" r="3.1" fill="url(#dshMemGrad)" />
          <circle cx="12" cy="12" r="3.1" fill="#fff" opacity="0.35" />
        </svg>
        {wide ? <span>记忆</span> : null}
      </button>
      {open ? (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(16, 16, 18, 0.72)',
          backdropFilter: 'blur(22px) saturate(1.2)',
          WebkitBackdropFilter: 'blur(22px) saturate(1.2)',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '44px 16px 10px', flex: 'none' }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: '#ddd', letterSpacing: 0.5 }}>记忆</span>
            {/* v0.12.8：图谱 / 日志 两个视图，共用一个入口 */}
            <div style={{ display: 'flex', gap: 4 }}>
              {[['graph', '图谱'], ['logs', '日志']].map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setView(k)}
                  style={{
                    padding: '4px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5,
                    border: '1px solid ' + (view === k ? 'rgba(124,196,255,0.55)' : 'rgba(255,255,255,0.14)'),
                    background: view === k ? 'rgba(124,196,255,0.16)' : 'transparent',
                    color: view === k ? '#cfe6ff' : '#999',
                  }}
                >{label}</button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {view === 'logs' ? <MemoryLogPanel /> : <MemoryGraphView scope={scope} />}
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
