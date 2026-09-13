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

const KEY = 'dsh-memory:graph-layout'

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
