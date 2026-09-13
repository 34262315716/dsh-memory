/**
 * 语义连边判定（纯函数，v0.11.0 提案）：给"向量最近的候选邻居"过四道**确定性**闸门，
 * 决定哪些是"真实有效的联系"。本模块**不做 embedding、不调 LLM**——
 * 向量在写入管线里本来就已算好（检索必需），这里只做判定。
 *
 * 四道闸门（按实测校准，见 docs/CHANGELOG v0.11.0）：
 *   ① 阈值：cos ≥ τ（默认 0.78，与主题聚类阈值同口径）
 *   ② 互为最近邻（MNN）：双方都把对方排进各自 top-K —— 实测砍掉约一半单向噪声，是主力判据
 *   ③ 上下文守卫：跨 scope 的相似要求更高阈值（默认 0.85，治"不同项目但都讲工作流"的假阳性）
 *   ④ 度数上限：每条记忆最多新增 maxLinks 条（默认 2），避免长成毛球
 *
 * 只读、可回放：同一输入永远同一输出（无随机数、无时间依赖）。
 */

/** 相似度阈值（同 scope）。 */
export const LINK_TAU = 0.78
/** 跨 scope 阈值（更高，防跨项目假阳性）。 */
export const LINK_TAU_CROSS_SCOPE = 0.85
/** 每条记忆最多新增边数。 */
export const LINK_MAX_PER_MEMORY = 2
/** 互最近邻判定的 K（与取邻居的 K 一致）。 */
export const LINK_TOPK = 6
/** 参与连边的层（默认只连语义长期层）。 */
export const LINK_LAYERS = ['sm']

/** 无序对键（a|b 与 b|a 同一把）。 */
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/**
 * @param {object} input
 * @param {Array<{id:string, layer?:string, scope?:string, theme?:string, createdAt?:number}>} input.memories 全部记忆（用于查 scope/theme/layer）
 * @param {Map<string, Array<{id:string, sim:number}>>} input.neighbors 每条记忆的候选邻居（按 sim 降序，长度 ≤ K）
 * @param {(aId:string, bId:string) => number} input.rankOf 反查名次：a 眼中 b 排第几（不存在返回 Infinity）
 * @param {Set<string>} input.existing 现有边（pairKey 归一化）
 * @param {object} [opts]
 * @returns {{edges:Array<{from:string,to:string,type:string,weight:number,sim:number,sameScope:boolean,mutual:boolean}>, stats:object}}
 */
export function suggestLinks({ memories, neighbors, rankOf, existing, opts = {} }) {
  const tau = opts.tau ?? LINK_TAU
  const tauCross = opts.tauCrossScope ?? LINK_TAU_CROSS_SCOPE
  const maxLinks = opts.maxLinks ?? LINK_MAX_PER_MEMORY
  const requireMutual = opts.requireMutual !== false
  const topK = opts.topK ?? LINK_TOPK
  // layers 语义：undefined = 用默认（只连 sm）；null / 空数组 = 不限层级
  const layers = opts.layers === undefined
    ? LINK_LAYERS
    : (Array.isArray(opts.layers) && opts.layers.length > 0 ? opts.layers : null)
  const byId = new Map((memories ?? []).map((m) => [m.id, m]))
  const edges = []
  const emitted = new Set()   // 同一对只出一次（否则 A 视角与 B 视角会各输出一遍，数字虚高一倍）
  const skipped = { layer: 0, dup: 0, belowTau: 0, crossScope: 0, notMutual: 0, cap: 0 }
  for (const m of memories ?? []) {
    if (layers && !layers.includes(m.layer)) { skipped.layer++; continue }
    const cands = neighbors.get(m.id) ?? []
    if (cands.length === 0) continue
    let picked = 0
    for (const c of cands) {
      if (picked >= maxLinks) { skipped.cap++; break }
      const other = byId.get(c.id)
      if (!other) continue
      if (layers && !layers.includes(other.layer)) { skipped.layer++; continue }   // 候选端也要在参与层内（默认 sm↔sm）
      const pk = pairKey(m.id, c.id)
      if (existing.has(pk)) { skipped.dup++; continue }
      if (emitted.has(pk)) continue   // 已从对端输出过
      const sameScope = (m.scope ?? '') === (other.scope ?? '')
      if (c.sim < tau) { skipped.belowTau++; continue }
      if (!sameScope && c.sim < tauCross) { skipped.crossScope++; continue }
      const mutual = rankOf(c.id, m.id) < topK
      if (requireMutual && !mutual) { skipped.notMutual++; continue }
      emitted.add(pk)
      edges.push({
        from: m.id,
        to: c.id,
        type: opts.edgeType ?? 'similarTo',
        weight: Math.round(c.sim * 10000) / 10000,
        sim: c.sim,
        sameScope,
        mutual,
      })
      picked++
    }
  }
  const touched = new Set()
  for (const e of edges) { touched.add(e.from); touched.add(e.to) }
  return {
    edges,
    stats: {
      edges: edges.length,
      memoriesTouched: touched.size,
      mutualEdges: edges.filter((e) => e.mutual).length,
      crossScopeEdges: edges.filter((e) => !e.sameScope).length,
      skipped,
      tau,
      tauCross,
      maxLinks,
      requireMutual,
    },
  }
}
