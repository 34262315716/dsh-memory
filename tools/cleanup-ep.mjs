/**
 * 存量清理：归档陈旧的情景快照（ep）。默认**只预演**，加 --apply 才写库。
 *
 * 判据（全部满足才归档）：
 *   ① layer='ep' 且未归档
 *   ② 创建时间早于 --days 天（默认 7）
 *   ③ **从未被检索命中**（last_access <= created_at；被命中过的会被 touch 抬高 last_access）
 *   ④ strength <= 1.0（从未被访问加固）
 *   ⑤ 可选 --noise-only：内容以「任务:」开头（规则路径降级产物，即"潦草记忆"的残留形态）
 *
 * 安全：
 *   · 写库前用 VACUUM INTO 做一致性快照（WAL 库直接 copy 会漏数据）
 *   · 只做 UPDATE archived=1，**不删除任何数据**（memory_archive 可一键恢复）
 *   · 打印前后统计与样本，便于核对
 *
 * 用法：
 *   node tools/cleanup-ep.mjs                       # 预演（默认 7 天 + 仅噪音形态）
 *   node tools/cleanup-ep.mjs --days 30 --all-shapes
 *   node tools/cleanup-ep.mjs --apply
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const days = Number(arg('days', 7))
const apply = argv.includes('--apply')
const noiseOnly = !argv.includes('--all-shapes')
// 默认**不要求**"从未被检索命中"：实测噪音 ep 照样会被注入检索命中（于是 last_access 被抬高），
// 但"被命中过"不等于"有价值"——它们本来就是降级路径的原始文本。加 --require-unused 才启用该条件。
const requireUnused = argv.includes('--require-unused')
const dbPath = arg('db', join(homedir(), '.dsh', 'memory.db'))

const db = new DatabaseSync(dbPath, { allowExtension: true })
db.exec('PRAGMA busy_timeout = 8000')   // 插件进程可能正在写，等锁而不是失败
const q = (s, ...a) => db.prepare(s).all(...a)
const one = (s, ...a) => db.prepare(s).get(...a)
const cutoff = Date.now() - days * 24 * 3600 * 1000
const noiseClause = noiseOnly ? " AND content LIKE '任务:%'" : ''
const unusedClause = requireUnused ? ' AND last_access <= created_at' : ''

const where = `layer = 'ep' AND archived = 0 AND created_at < ? AND strength < 1.5${noiseClause}${unusedClause}`
const cands = q(`SELECT id, content, created_at, last_access, strength FROM memories WHERE ${where} ORDER BY created_at ASC`, cutoff)

console.log(`===== 清理预演（判据：${days} 天前 + 强度未加固${noiseOnly ? ' + 「任务:」形态' : ''}${requireUnused ? ' + 从未被检索命中' : ''}）=====`)
console.log(`候选 ${cands.length} 条`)
const before = one("SELECT COUNT(*) total, SUM(layer='ep') ep, SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) archived FROM memories")
console.log(`当前库：总计 ${before.total} · ep ${before.ep} · 已归档 ${before.archived ?? 0}`)

// 对照：各档判据下的候选量（让人看清"松一点会多收多少"）
for (const d of [1, 3, 7, 14, 30]) {
  const c = one(`SELECT COUNT(*) c FROM memories WHERE layer='ep' AND archived=0 AND created_at < ? AND strength < 1.5${noiseClause}${unusedClause}`,
    Date.now() - d * 24 * 3600 * 1000).c
  console.log(`  · ${d} 天判据 → ${c} 条`)
}

if (cands.length > 0) {
  console.log('\n--- 样本（最早 6 条）---')
  for (const c of cands.slice(0, 6)) {
    console.log(`· ${new Date(c.created_at).toLocaleString('zh-CN', { hour12: false })} | ${c.content.replace(/\s+/g, ' ').slice(0, 90)}`)
  }
  console.log('\n--- 样本（最新 3 条，最接近保留线）---')
  for (const c of cands.slice(-3)) {
    console.log(`· ${new Date(c.created_at).toLocaleString('zh-CN', { hour12: false })} | ${c.content.replace(/\s+/g, ' ').slice(0, 90)}`)
  }
}

if (!apply) {
  console.log('\n（预演模式：未写入任何数据。加 --apply 执行归档）')
  db.close()
  process.exit(0)
}

if (cands.length === 0) { console.log('\n没有候选，无需执行。'); db.close(); process.exit(0) }

// 一致性快照（WAL 库必须用 VACUUM INTO，直接 copy 会漏掉未 checkpoint 的部分）
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(homedir(), '.dsh', `memory.db.snapshot-epclean-${stamp}`)
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
console.log(`\n已备份：${backup}`)

const now = Date.now()
const stmt = db.prepare('UPDATE memories SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0')
let n = 0
db.exec('BEGIN IMMEDIATE')
try {
  for (const c of cands) n += stmt.run(now, c.id).changes ?? 0
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('写入失败已回滚：', err.message)
  process.exit(1)
}

const after = one("SELECT COUNT(*) total, SUM(layer='ep') ep, SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) archived FROM memories")
console.log(`\n归档完成：${n} 条`)
console.log(`归档后库：总计 ${after.total} · ep ${after.ep} · 已归档 ${after.archived ?? 0}`)
console.log(`恢复方式：memory_archive {action:"list"} 查看，{action:"restore", ids:[...]} 捞回`)
db.close()
