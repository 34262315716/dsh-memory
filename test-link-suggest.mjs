/**
 * 语义连边判定守护测试（lib/link-suggest.js）：四道闸门 + 去重 + 上限 + 层级过滤 + 确定性。
 * 纯函数，无 DB/网络依赖。
 */
import { suggestLinks, pairKey, LINK_TAU, LINK_TAU_CROSS_SCOPE, LINK_TOPK } from './lib/link-suggest.js'

let pass = 0, fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log('  ✅', name) } else { fail++; console.log('  ❌', name) }
}

const M = (id, extra = {}) => ({ id, layer: 'sm', scope: 'proj', theme: '', createdAt: 0, ...extra })
const N = (id, sim) => ({ id, sim })
const rank = (map) => (a, b) => map[`${a}|${b}`] ?? Infinity

console.log('== 1. 基本闸门 ============')
{
  const memories = [M('a'), M('b'), M('c')]
  const neighbors = new Map([['a', [N('b', 0.9), N('c', 0.7)]], ['b', [N('a', 0.9)]], ['c', [N('a', 0.7)]]])
  const r = suggestLinks({ memories, neighbors, rankOf: rank({ 'a|b': 0, 'b|a': 0, 'a|c': 1, 'c|a': 0 }), existing: new Set() })
  check('高于阈值 → 建边', r.edges.some((e) => (e.from === 'a' && e.to === 'b') || (e.from === 'b' && e.to === 'a')))
  check('低于阈值 → 不建边', !r.edges.some((e) => e.from === 'c' || e.to === 'c'))
  check('权重=相似度（4 位小数）', r.edges[0].weight === 0.9)
  check('统计字段齐全', r.stats.tau === LINK_TAU && r.stats.tauCross === LINK_TAU_CROSS_SCOPE && r.stats.memoriesTouched === 2)
}

console.log('== 2. 互为最近邻（MNN）============')
{
  const memories = [M('a'), M('b')]
  const neighbors = new Map([['a', [N('b', 0.95)]], ['b', [N('a', 0.95)]]])
  const mutual = suggestLinks({ memories, neighbors, rankOf: rank({ 'a|b': 0, 'b|a': 0 }), existing: new Set() })
  check('双向互认 → 建边', mutual.edges.length === 1 && mutual.edges[0].mutual === true)
  // 真正单向：a 的候选里有 b，但 b 的候选里没有 a
  const ow = [M('a'), M('b'), M('c')]
  const owNb = new Map([['a', [N('b', 0.95)]], ['b', [N('c', 0.95)]], ['c', [N('b', 0.95)]]])
  const oneWay = suggestLinks({ memories: ow, neighbors: owNb, rankOf: rank({ 'a|b': 0, 'b|c': 0, 'c|b': 0 }), existing: new Set() })
  check('单向（b 眼中 a 不在 top-K）→ 不建边', !oneWay.edges.some((e) => (e.from === 'a' && e.to === 'b') || (e.from === 'b' && e.to === 'a')) && oneWay.stats.skipped.notMutual > 0)
  const off = suggestLinks({ memories, neighbors, rankOf: rank({ 'a|b': 0 }), existing: new Set(), opts: { requireMutual: false } })
  check('关掉 MNN 开关 → 建边（可配置）', off.edges.length === 1)
  check('K 常量与阈值同源', LINK_TOPK === 6)
}

console.log('== 3. 跨 scope 守卫 ============')
{
  const memories = [M('a', { scope: 'p1' }), M('b', { scope: 'p2' })]
  const neighbors = new Map([['a', [N('b', 0.80)]], ['b', [N('a', 0.80)]]])
  const r = suggestLinks({ memories, neighbors, rankOf: rank({ 'a|b': 0, 'b|a': 0 }), existing: new Set() })
  check('跨 scope 且低于跨域阈值 → 不建边', r.edges.length === 0 && r.stats.skipped.crossScope === 2)   // 两端各计一次
  const hi = new Map([['a', [N('b', 0.9)]], ['b', [N('a', 0.9)]]])
  const r2 = suggestLinks({ memories, neighbors: hi, rankOf: rank({ 'a|b': 0, 'b|a': 0 }), existing: new Set() })
  check('跨 scope 但足够高（≥跨域阈值）→ 建边并标记', r2.edges.length === 1 && r2.edges[0].sameScope === false)
  const same = suggestLinks({ memories: [M('a'), M('b')], neighbors, rankOf: rank({ 'a|b': 0, 'b|a': 0 }), existing: new Set() })
  check('同 scope 用低阈值 → 建边', same.edges.length === 1 && same.edges[0].sameScope === true)
}

console.log('== 4. 去重 / 上限 / 层级 / 已存在 ============')
{
  const memories = [M('a'), M('b')]
  const neighbors = new Map([['a', [N('b', 0.9)]], ['b', [N('a', 0.9)]]])
  const r = suggestLinks({ memories, neighbors, rankOf: rank({ 'a|b': 0, 'b|a': 0 }), existing: new Set() })
  check('同一对只输出一次（两端视角去重）', r.edges.length === 1)

  const existing = new Set([pairKey('a', 'b')])
  const r2 = suggestLinks({ memories, neighbors, rankOf: rank({ 'a|b': 0, 'b|a': 0 }), existing })
  check('已有边 → 跳过', r2.edges.length === 0 && r2.stats.skipped.dup === 2)   // 两端各计一次

  const many = [M('a'), M('b'), M('c'), M('d')]
  const nb = new Map([['a', [N('b', 0.95), N('c', 0.94), N('d', 0.93)]]])
  const r3 = suggestLinks({ memories: many, neighbors: nb, rankOf: rank({ 'b|a': 0, 'c|a': 0, 'd|a': 0 }), existing: new Set() })
  check('每条记忆默认最多 2 条新边', r3.edges.length === 2)

  const ep = [M('a', { layer: 'ep' }), M('b')]
  const r4 = suggestLinks({ memories: ep, neighbors, rankOf: rank({ 'a|b': 0, 'b|a': 0 }), existing: new Set() })
  check('ep 层默认不参与（发起端与候选端都过滤）', r4.edges.length === 0 && r4.stats.skipped.layer === 2)
  const r5 = suggestLinks({ memories: ep, neighbors, rankOf: rank({ 'a|b': 0, 'b|a': 0 }), existing: new Set(), opts: { layers: null } })
  check('layers=null → 不限层级', r5.edges.length === 1)
}

console.log('== 5. 确定性 ============')
{
  const memories = [M('a'), M('b'), M('c')]
  const neighbors = new Map([['a', [N('b', 0.9), N('c', 0.85)]], ['b', [N('a', 0.9)]], ['c', [N('a', 0.85)]]])
  const args = () => ({ memories, neighbors, rankOf: rank({ 'a|b': 0, 'b|a': 0, 'a|c': 1, 'c|a': 0 }), existing: new Set() })
  const j1 = JSON.stringify(suggestLinks(args()))
  const j2 = JSON.stringify(suggestLinks(args()))
  check('同输入 → 同输出（无随机/时间依赖）', j1 === j2)
  check('pairKey 无序', pairKey('x', 'y') === pairKey('y', 'x'))
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
