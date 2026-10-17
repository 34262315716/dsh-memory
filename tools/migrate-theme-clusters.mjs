/**
 * 主题簇迁移（v0.19.0）。
 *
 * 1) 清理单成员簇（实际成员 ≤1）：对应记忆标 cluster_id='solo'（保留 theme），删簇；
 * 2) 剩余簇的质心量化到 1e-4（4096 维 JSON 约 86KB → 约 35KB/行）；
 * 3) 可选 --vacuum 回收磁盘（需要短暂独占写锁）。
 *
 * 用法：
 *   node tools/migrate-theme-clusters.mjs --dry-run
 *   node tools/migrate-theme-clusters.mjs
 *   node tools/migrate-theme-clusters.mjs --vacuum
 * 数据库默认取 DSH_HOME/memory.db（没有 DSH_HOME 时用 ~/.dsh/memory.db）。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const vacuum = args.includes('--vacuum')
const dbIdx = args.indexOf('--db')
const dbFile = dbIdx >= 0 ? args[dbIdx + 1] : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memory.db')

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 10000')

const stat = () => ({
  clusters: db.prepare('SELECT COUNT(*) AS c FROM theme_clusters').get().c,
  soloClusters: db.prepare('SELECT COUNT(*) AS c FROM theme_clusters c WHERE (SELECT COUNT(*) FROM memories m WHERE m.cluster_id = c.id) <= 1').get().c,
  emptyLabels: db.prepare("SELECT COUNT(*) AS c FROM theme_clusters WHERE label = ''").get().c,
  centroidBytes: db.prepare('SELECT SUM(LENGTH(centroid)) AS c FROM theme_clusters').get().c ?? 0,
  emptyTheme: db.prepare("SELECT COUNT(*) AS c FROM memories WHERE theme = ''").get().c,
})

console.log('库:', dbFile)
console.log('迁移前:', JSON.stringify(stat()))

const soloIds = db.prepare(
  'SELECT c.id FROM theme_clusters c WHERE (SELECT COUNT(*) FROM memories m WHERE m.cluster_id = c.id) <= 1',
).all().map((r) => r.id)
console.log('待清理单成员簇:', soloIds.length)

if (dry) {
  db.close()
  process.exit(0)
}

if (soloIds.length > 0) {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (let i = 0; i < soloIds.length; i += 200) {
      const chunk = soloIds.slice(i, i + 200)
      const ph = chunk.map(() => '?').join(',')
      db.prepare(`UPDATE memories SET cluster_id = 'solo' WHERE cluster_id IN (${ph})`).run(...chunk)
      db.prepare(`DELETE FROM theme_clusters WHERE id IN (${ph})`).run(...chunk)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  console.log('已清理单成员簇:', soloIds.length)
}

// 量化剩余质心
const rows = db.prepare('SELECT id, centroid FROM theme_clusters').all()
let quantized = 0
db.exec('BEGIN IMMEDIATE')
try {
  const upd = db.prepare('UPDATE theme_clusters SET centroid = ? WHERE id = ?')
  for (const r of rows) {
    let arr
    try { arr = JSON.parse(r.centroid) } catch { continue }
    if (!Array.isArray(arr) || arr.length === 0) continue
    const q = arr.map((x) => Math.round(Number(x) * 1e4) / 1e4)
    const s = JSON.stringify(q)
    if (s.length < r.centroid.length) { upd.run(s, r.id); quantized++ }
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  throw err
}
console.log('已量化质心:', quantized)

// 建检索/图谱/聚类热路径索引（与 store.js #ensureIndexes 同一份清单，幂等）
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived)',
  'CREATE INDEX IF NOT EXISTS idx_memories_theme ON memories(theme)',
  'CREATE INDEX IF NOT EXISTS idx_memories_cluster ON memories(cluster_id)',
  'CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(layer, archived, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned) WHERE pinned = 1',
]
for (const sql of INDEXES) {
  try { db.exec(sql) } catch (err) { console.warn('索引创建失败:', err.message) }
}
console.log('索引已就绪')
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
if (vacuum) {
  console.log('VACUUM 中（会短暂锁库）…')
  const t0 = Date.now()
  db.exec('VACUUM')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  console.log(`VACUUM 完成（${Date.now() - t0}ms）`)
}
console.log('迁移后:', JSON.stringify(stat()))
db.close()
