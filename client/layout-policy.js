/**
 * 布局计划（v0.10.13）：决定"打开图谱时算多少、算到什么时候停"。
 *
 * 用户诉求：① 进去之后**先把布局算到所有点都不动再展示**；② 大图/弱机要有降级手段。
 * 这里把策略做成纯函数，便于守护测试；实际计算由 graph.jsx 分块执行（每帧 ≤12ms，带进度条）。
 *
 * 档位：
 *   precise  跑到静止（速度阈值），时间预算 4s / 步数上限 8000 —— 默认
 *   balanced 时间预算 1.2s / 步数上限 3000 —— 大图或想要快
 *   instant  不重算（直接用缓存/初始布局）—— 超大图或极弱机
 * 自动降档：节点数超阈值时 precise → balanced → instant（缓存命中才 instant）。
 */

/** 速度阈值（|vx|+|vy|）：低于它视为"所有点都不动"。 */
export const STOP_SPEED = 0.02

/** 自动降档阈值（节点数）。 */
export const AUTO_DOWNGRADE = { balanced: 2000, instant: 6000 }   // v0.10.14：斥力改 O(n) 后放宽（8k 节点每步 ~15ms）

/**
 * @param {{quality?:string, nodeCount?:number, hasCache?:boolean}} opts
 * @returns {{mode:'precise'|'balanced'|'instant', compute:boolean, budgetMs:number, stepCap:number, stopSpeed:number, downgraded:boolean, reason:string}}
 */
export function resolveLayoutPlan({ quality = 'precise', nodeCount = 0, hasCache = false } = {}) {
  const q = quality === 'balanced' || quality === 'instant' ? quality : 'precise'
  const n = Number.isFinite(nodeCount) ? nodeCount : 0
  let mode = q
  let downgraded = false
  let reason = ''
  // 自动降档：大图重算代价高（all-pairs 步进 O(n²)），按规模退档
  if (n > AUTO_DOWNGRADE.instant && (mode === 'precise' || mode === 'balanced')) {
    mode = hasCache ? 'instant' : 'balanced'
    downgraded = true
    reason = `节点 ${n} > ${AUTO_DOWNGRADE.instant}，自动降档`
  } else if (n > AUTO_DOWNGRADE.balanced && mode === 'precise') {
    mode = 'balanced'
    downgraded = true
    reason = `节点 ${n} > ${AUTO_DOWNGRADE.balanced}，自动降档`
  }
  if (mode === 'instant') {
    return { mode, compute: false, budgetMs: 0, stepCap: 0, stopSpeed: STOP_SPEED, downgraded, reason }
  }
  const precise = mode === 'precise'
  return {
    mode,
    compute: true,
    budgetMs: precise ? 4000 : 1200,
    stepCap: precise ? 8000 : 3000,
    stopSpeed: STOP_SPEED,
    downgraded,
    reason,
  }
}

/** 进度文案（覆盖层用）。 */
export function progressLabel(plan, step, maxSpeed) {
  if (!plan?.compute) return '直接展示缓存布局…'
  const pct = Math.min(99, Math.round((step / Math.max(1, plan.stepCap)) * 100))
  const still = Number.isFinite(maxSpeed) ? `（残余速度 ${maxSpeed.toFixed(2)}）` : ''
  return `正在计算全局平衡布局… ${pct}%${still}`
}
