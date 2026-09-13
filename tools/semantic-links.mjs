/**
 * 语义连边工具（默认只读）：用已有 4096 维向量跑 lib/link-suggest.js 的判定，
 * 输出"会新增哪些边"供人工判读；加 --apply 才真正写入 memory_links（带备份与回滚）。
 *
 * 用法：
 *   node tools/semantic-links.mjs                          # 只读报告（默认）
 *   node tools/semantic-links.mjs --apply --limit 50       # 只落库相似度最高的 50 条（试水）
 *   node tools/semantic-links.mjs --apply                  # 全量落库
 *   node tools/semantic-links.mjs --rollback <stamp>       # 回滚某次落库（按 stamp 文件）
 * 参数：--tau 0.80 --tau-cross 0.88 --max 2 --samples 12 --with-ep --db <路径>
 *
 * 安全设计：
 *   · 写入前用 `VACUUM INTO` 做**一致性快照备份**（WAL 库直接 copy 会漏数据）
 *   · 整批边共用同一个 valid_from = stamp，回滚 = 把该 stamp 的边置 valid_to（不删数据）
 *   · 落库清单写 JSON（~/.dsh/memory-links-<stamp>.json），回滚据此执行
 *   · 只 INSERT/UPDATE，绝不 DELETE
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, readFileSync } from 'node:fs'
import { getLoadablePath } from 'sqlite-vec'
import { suggestLinks, pairKey, LINK_TOPK } from '../lib/link-suggest.js'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const bool = (name) => argv.includes(`--${name}`)
const tau = Number(arg('tau', 0.80))
const tauCross = Number(arg('tau-cross', 0.88))
const maxLinks = Number(arg('max', 2))
const sampleN = Number(arg('samples', 12))
const limit = Number(arg('limit', 0))
const withEp = bool('with-ep')
const apply = bool('apply')
const rollbackStamp = arg('rollback', null)
const dbPath = arg('db', join(homedir(), '.dsh', 'memory.db'))
const TOPK = LINK_TOPK

const db = new DatabaseSync(dbPath, { allowExtension: true })
db.loadExtension(getLoadablePath())
db.exec('PRAGMA busy_timeout = 8000')   // 插件进程可能正在写，等锁而不是直接失败
const q = (s, ...a) => db.prepare(s).all(...a)

// ---------- 回滚模式 ----------
if (rollbackStamp) {
  const file = join(homedir(), '.dsh', `memory-links-${rollbackStamp}.json`)
  const plan = JSON.parse(readFileSync(file, 'utf8'))
  const now = Date.now()
  const stmt = db.prepare("UPDATE memory_links SET valid_to = ? WHERE from_memory = ? AND to_memory = ? AND type = ? AND valid_from = ?")
  let n = 0
  for (const e of plan.edges) {
    const r = stmt.run(now, e.from, e.to, e.type, plan.stamp)
    n += r.changes ?? 0
  }
  console.log(`回滚完成：置 valid_to 的边 ${n} 条（清单 ${file}）`)
  db.close()
  process.exit(0)
}

// ---------- 读数据 ----------
const mem = q('SELECT rowid, id, layer, scope, theme, created_at, content FROM memories')
const byId = new Map(mem.map((m) => [m.id, m]))
const byRow = new Map(mem.map((m) => [m.rowid, m]))
const rows = q('SELECT rowid, embedding FROM memory_vectors')
if (rows.length === 0) { console.log('没有向量数据，无法判定。'); process.exit(1) }
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
const existing = new Set()
for (const r of q('SELECT from_memory f, to_memory t FROM memory_links WHERE valid_to IS NULL')) existing.add(pairKey(r.f, r.t))

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
console.log(`载入 ${mem.length} 条记忆 / ${vec.size} 条向量（维度 ${dim}）| 现有活跃边 ${existing.size} | KNN ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const rankByIds = (aId, bId) => {
  const A = byId.get(aId), B = byId.get(bId)
  return A && B ? (rankMap.get(`${A.rowid}|${B.rowid}`) ?? Infinity) : Infinity
}
const { edges, stats } = suggestLinks({
  memories: mem,
  neighbors,
  rankOf: rankByIds,
  existing,
  opts: { tau, tauCrossScope: tauCross, maxLinks, layers: withEp ? null : undefined },
})
let picked = [...edges].sort((a, b) => b.sim - a.sim)
if (limit > 0) picked = picked.slice(0, limit)

const linkedIds = new Set()
for (const k of existing) k.split('|').forEach((id) => linkedIds.add(id))
const reconnected = picked.filter((e) => !linkedIds.has(e.from) && !linkedIds.has(e.to))

console.log(`\n===== 判定结果（τ=${tau} / 跨scope ${tauCross} / 上限 ${maxLinks} / ${withEp ? '含 ep' : '仅 sm'}）=====`)
console.log(`候选边 ${stats.edges} 条${limit > 0 ? ` → 本次只取相似度最高的 ${picked.length} 条` : ''} | 涉及记忆 ${stats.memoriesTouched} | 跨 scope ${stats.crossScopeEdges}`)
console.log(`跳过：低于阈值 ${stats.skipped.belowTau} · 跨scope未达标 ${stats.skipped.crossScope} · 非互NN ${stats.skipped.notMutual} · 已有边 ${stats.skipped.dup} · 超上限 ${stats.skipped.cap} · 层级不符 ${stats.skipped.layer}`)
console.log(`其中"双方原本都孤立、将被接回主图"：${reconnected.length} 条`)

const snippets = (id) => {
  const m = byId.get(id)
  return `[${m?.layer}/${m?.scope}] ${(m?.content ?? '').replace(/\s+/g, ' ').slice(0, 52)}`
}
const show = (list, title, n) => {
  console.log(`\n--- ${title}（${Math.min(n, list.length)}/${list.length} 对）---`)
  for (const e of list.slice(0, n)) {
    console.log(`· sim=${e.sim.toFixed(3)} ${e.sameScope ? '同scope' : '跨scope'} ${e.mutual ? '互NN' : '单向'}`)
    console.log(`    ${snippets(e.from)}`)
    console.log(`  ↔ ${snippets(e.to)}`)
  }
}
show(picked, '本次将落库·相似度最高', Math.ceil(sampleN / 2))
show([...picked].reverse(), '本次将落库·相似度最低（重点复核）', Math.ceil(sampleN / 2))

if (!apply) {
  console.log('\n（只读模式：未写入任何数据。加 --apply 落库）')
  db.close()
  process.exit(0)
}

// ---------- 落库 ----------
const stamp = Date.now()
const backup = join(homedir(), '.dsh', `memory.db.snapshot-${new Date(stamp).toISOString().replace(/[:.]/g, '-')}`)
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)   // WAL 一致性快照
console.log(`\n已备份：${backup}`)

const ins = db.prepare(`INSERT INTO memory_links (from_memory, to_memory, type, weight, valid_from, valid_to)
  VALUES (?, ?, ?, ?, ?, NULL)
  ON CONFLICT(from_memory, to_memory, type) DO UPDATE SET valid_to = NULL, weight = excluded.weight`)
let written = 0
db.exec('BEGIN')
try {
  for (const e of picked) {
    const r = ins.run(e.from, e.to, e.type, e.weight, stamp)
    written += r.changes ?? 0
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('写入失败已回滚：', err.message)
  process.exit(1)
}
const planFile = join(homedir(), '.dsh', `memory-links-${stamp}.json`)
writeFileSync(planFile, JSON.stringify({ stamp, tau, tauCross, maxLinks, withEp, edges: picked.map((e) => ({ from: e.from, to: e.to, type: e.type, weight: e.weight, sim: e.sim })) }, null, 2))

const after = q("SELECT type, COUNT(*) c FROM memory_links WHERE valid_to IS NULL GROUP BY type").map((r) => `${r.type}:${r.c}`).join(' · ')
console.log(`落库完成：写入 ${written} 条（stamp ${stamp}）`)
console.log(`现有活跃边：${after}`)
console.log(`回滚命令：node tools/semantic-links.mjs --rollback ${stamp}`)
db.close()
