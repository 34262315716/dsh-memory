/**
 * 语义连边 dryRun 报告（只读工具，不写库）：用已有 4096 维向量跑 lib/link-suggest.js 的判定，
 * 输出"如果落库会新增哪些边"，供人工判断是否会污染图谱。
 *
 * 用法：node tools/link-dryrun.mjs [--tau 0.78] [--tau-cross 0.85] [--max 2] [--samples 20] [--db <路径>]
 * 默认读 ~/.dsh/memory.db（只读 + allowExtension 加载 sqlite-vec）。
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getLoadablePath } from 'sqlite-vec'
import { suggestLinks, pairKey, LINK_TOPK } from '../lib/link-suggest.js'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const tau = Number(arg('tau', 0.78))
const tauCross = Number(arg('tau-cross', 0.85))
const maxLinks = Number(arg('max', 2))
const sampleN = Number(arg('samples', 20))
const dbPath = arg('db', join(homedir(), '.dsh', 'memory.db'))
const withEp = argv.includes('--with-ep')   // 是否允许 sm↔ep 连边（默认只连 sm↔sm）
const TOPK = LINK_TOPK

const db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: true })
db.loadExtension(getLoadablePath())
const q = (s, ...a) => db.prepare(s).all(...a)

const mem = q('SELECT rowid, id, layer, scope, theme, created_at, content FROM memories')
const byId = new Map(mem.map((m) => [m.id, m]))
const byRow = new Map(mem.map((m) => [m.rowid, m]))

const rows = q('SELECT rowid, embedding FROM memory_vectors')
if (rows.length === 0) {
  console.log('没有向量数据，无法判定。')
  process.exit(1)
}
const dim = rows[0].embedding.length / 4
const vec = new Map()
for (const r of rows) {
  const f = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, dim)
  let n = 0
  for (let i = 0; i < dim; i++) n += f[i] * f[i]
  n = Math.sqrt(n) || 1
  const a = new Float32Array(dim)
  for (let i = 0; i < dim; i++) a[i] = f[i] / n
  vec.set(r.rowid, a)
}

// 现有活跃边（归一化）
const existing = new Set()
for (const r of q('SELECT from_memory f, to_memory t FROM memory_links WHERE valid_to IS NULL')) {
  existing.add(pairKey(r.f, r.t))
}

// 逐条算 top-K 邻居（KNN 全对；783 条 × 4096 维）
const ids = [...vec.keys()]
const neighbors = new Map()
const rankMap = new Map()
const t0 = Date.now()
for (const a of ids) {
  const A = vec.get(a)
  const scored = []
  for (const b of ids) {
    if (a === b) continue
    const B = vec.get(b)
    let s = 0
    for (let i = 0; i < dim; i++) s += A[i] * B[i]
    scored.push([b, s])
  }
  scored.sort((x, y) => y[1] - x[1])
  scored.forEach(([b, s], idx) => rankMap.set(`${a}|${b}`, idx))
  neighbors.set(byRow.get(a).id, scored.slice(0, TOPK).map(([b, s]) => ({ id: byRow.get(b).id, sim: s })))
}
console.log(`载入 ${mem.length} 条记忆 / ${vec.size} 条向量（维度 ${dim}）| 现有活跃边 ${existing.size} | KNN 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const rankOf = (aId, bId) => rankMap.get(`${byRow.get(byId.get(aId)?.rowid)}|${byRow.get(byId.get(bId)?.rowid)}`) ?? Infinity
// rankMap 的键用的是 rowid，这里换成 id→rowid 的查询
const rankByIds = (aId, bId) => {
  const A = byId.get(aId)
  const B = byId.get(bId)
  if (!A || !B) return Infinity
  return rankMap.get(`${A.rowid}|${B.rowid}`) ?? Infinity
}
void rankOf

// 只对"零连接"与"有连接"分别出报告
const linkedIds = new Set()
for (const k of existing) k.split('|').forEach((id) => linkedIds.add(id))

const run = (memories, label) => {
  const { edges, stats } = suggestLinks({
    memories,
    neighbors,
    rankOf: (a, b) => rankByIds(a, b),
    existing,
    opts: { tau, tauCrossScope: tauCross, maxLinks, layers: withEp ? null : undefined },
  })
  const relink = edges.filter((e) => !linkedIds.has(e.from) && !linkedIds.has(e.to))
  console.log(`\n===== ${label} =====`)
  console.log(`新增边 ${stats.edges} 条 | 涉及记忆 ${stats.memoriesTouched} 条 | 其中互为最近邻 ${stats.mutualEdges} | 跨 scope ${stats.crossScopeEdges}`)
  console.log(`跳过原因：低于阈值 ${stats.skipped.belowTau} · 跨scope未达标 ${stats.skipped.crossScope} · 非互NN ${stats.skipped.notMutual} · 已存在边 ${stats.skipped.dup} · 超出上限 ${stats.skipped.cap} · 层级不符 ${stats.skipped.layer}`)
  if (label.startsWith('存量')) console.log(`其中"双方原本都孤立、靠这条边接回主图"的：${relink.length} 条`)
  return { edges, stats, relink }
}

const all = run(mem, `存量全量补连（τ=${tau} / 跨scope ${tauCross} / 每条上限 ${maxLinks}）`)

// 度数影响
const degBefore = new Map()
for (const k of existing) k.split('|').forEach((id) => degBefore.set(id, (degBefore.get(id) ?? 0) + 1))
const degAfter = new Map(degBefore)
for (const e of all.edges) {
  degAfter.set(e.from, (degAfter.get(e.from) ?? 0) + 1)
  degAfter.set(e.to, (degAfter.get(e.to) ?? 0) + 1)
}
const dist = (m) => {
  const d = new Map()
  for (const m2 of mem) {
    const v = m.get(m2.id) ?? 0
    const bucket = v === 0 ? '0' : v <= 2 ? '1-2' : v <= 5 ? '3-5' : '6+'
    d.set(bucket, (d.get(bucket) ?? 0) + 1)
  }
  return ['0', '1-2', '3-5', '6+'].map((b) => `${b}度:${d.get(b) ?? 0}`).join(' · ')
}
console.log(`\n度数分布 补连前：${dist(degBefore)}`)
console.log(`度数分布 补连后：${dist(degAfter)}`)

// 抽样：最强 / 最弱 / 跨scope 各若干，供人工判读
const snippets = (id) => {
  const m = byId.get(id)
  const s = (m?.content ?? '').replace(/\s+/g, ' ').slice(0, 54)
  return `[${m?.layer}/${m?.scope}] ${s}`
}
const show = (list, title, n) => {
  console.log(`\n--- ${title}（${n} 对）---`)
  for (const e of list.slice(0, n)) {
    console.log(`· sim=${e.sim.toFixed(3)} ${e.sameScope ? '同scope' : '跨scope'} ${e.mutual ? '互NN' : '单向'}`)
    console.log(`    ${snippets(e.from)}`)
    console.log(`  ↔ ${snippets(e.to)}`)
  }
}
const sorted = [...all.edges].sort((a, b) => b.sim - a.sim)
show(sorted, '相似度最高', Math.ceil(sampleN / 3))
show([...sorted].reverse(), '相似度最低（最可能误连，重点看）', Math.ceil(sampleN / 3))
show(sorted.filter((e) => !e.sameScope), '跨 scope（次高危）', Math.ceil(sampleN / 3))
db.close()
