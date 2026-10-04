/**
 * 布局缓存（v0.10.7）：把力导向**收敛后**的节点坐标存进 localStorage，下次打开图谱面板
 * 直接落位到"已平衡"的形态——不再每次从环形初始位重新迁移（用户实拍反馈：每次进去都要看一遍迁移过程）。
 *
 * 关键设计：**按节点 id 复用**，不做严格拓扑匹配。
 * 记忆图谱几乎每次会话都在长新节点（每写一条记忆拓扑就变），若"签名不符即整包作废"，
 * 缓存等于永远失效。故缓存只按 id 取交集复用：老节点留在原地，新节点落在同主题已恢复节点的质心附近，
 * 再由力导向微调——既保住"打开即平衡"，又能平滑接纳新记忆。
 *
 * 纯函数（encode / decode / restoredRatio）与读写封装分开：前者可被 Node 守护测试直接引用，
 * 后者只在浏览器里调用（localStorage 访问全部 try/catch 兜底：隐私模式、配额满、SSR 都不炸）。
 */

/** 序列化：{ sig, pos: [[id, x, y], ...] }（坐标取 1 位小数，体积减半且肉眼无差）。 */
export function encodeLayout(sig, nodes) {
  const pos = []
  for (const n of nodes ?? []) {
    if (!n?.id || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
    pos.push([n.id, Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10])
  }
  return JSON.stringify({ sig: String(sig ?? ''), pos })
}

/** 反序列化 → { sig, map }；坏数据返回 null（绝不抛）。 */
export function decodeLayout(raw) {
  try {
    const obj = JSON.parse(raw)
    // 兼容早期数组格式（仅坐标列表）
    const arr = Array.isArray(obj) ? obj : obj?.pos
    if (!Array.isArray(arr)) return null
    const map = new Map()
    for (const it of arr) {
      if (!Array.isArray(it) || it.length < 3) continue
      const [id, x, y] = it
      if (typeof id === 'string' && Number.isFinite(x) && Number.isFinite(y)) map.set(id, [x, y])
    }
    if (map.size === 0) return null
    return { sig: Array.isArray(obj) ? '' : String(obj?.sig ?? ''), map }
  } catch {
    return null
  }
}

/** 复用率：缓存里能对上多少比例的当前节点（用于决定"直接落位"还是"重新预热"）。 */
export function restoredRatio(map, nodes) {
  if (!map || !Array.isArray(nodes) || nodes.length === 0) return 0
  let hit = 0
  for (const n of nodes) if (map.has(n.id)) hit++
  return hit / nodes.length
}

/** 拓扑签名（仅作诊断/版本标记，不用于严格匹配；见文件头说明）。 */
export function layoutSignature(data) {
  const ids = (data?.nodes ?? []).map((n) => n.id).sort()
  const edges = (data?.edges ?? []).length
  const s = `${ids.length}|${edges}|${(data?.themes ?? []).length}|${ids[0] ?? ''}|${ids[ids.length - 1] ?? ''}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16)}-${ids.length}-${edges}`
}

/**
 * 缓存键带版本（v2：环形假平衡；v3：有重合；v4：旧力模型的"团状贴紧"布局 → 一并作废；
 * v5：v0.14.1 反转了力模型的方向 —— 度递增回中力 / 斥力按度数折减 / 弹簧长度恒定且 hub 更硬
 *     → 旧布局是"孤立点占中心、枢纽飘外圈"的收敛结果，必须作废重算，否则新力模型只会在
 *     旧平衡点附近微调，用户根本看不出改动）。
 * 注意：签名只由**数据**算出（节点数/边数/主题数/首尾 id），力模型改了多少它都不会变，
 * 所以每次改力场逻辑都必须手动升这个版本号。
 * v0.14.4 **故意不升**（仍为 v5）：这一版加的是"全向引力（弱）"与"常活微动（零均值）"——
 *   两者都不移动平衡点（引力只做就近微调、微动时间平均为 0），却会**丢掉用户手动拖好的摆位**
 *   （缓存里存的就是他们摆的位置）。所以这里保持 v5：让新力场在旧布局上自然接管。
 *   判据是"平衡点是否移动"：移动了才升版本。
 * v6：v0.15.0 **重写了力模型并删掉中心引力** —— 平衡点的位置、形状、靠什么维持全变了
 *   （旧布局是"中心引力 + 度数加权"塑造的收敛结果，新模型下它连力的方向都对不上），
 *   属于判据里"平衡点已移动"的情形 → 整片作废重算。
 * v7：v0.15.1 **引力从"累加无上限"改成"极轻 + 硬截断"，并换了初始种子**（环状种 → 分量成盘）。
 *   平衡点又移动了一次：旧缓存在新力场下会先塌后散（引力过量）且种子已不同 → 整片作废。
 */
const KEY = 'dsh-memory:graph-layout:v7'

/** 读缓存（浏览器环境；任何异常 → null）。 */
export function loadLayout() {
  try {
    if (typeof localStorage === 'undefined') return null
    return decodeLayout(localStorage.getItem(KEY))
  } catch {
    return null
  }
}

/** 写缓存（浏览器环境；任何异常静默忽略——缓存失败不影响功能）。 */
export function saveLayout(sig, nodes) {
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(KEY, encodeLayout(sig, nodes))
    return true
  } catch {
    return false
  }
}
