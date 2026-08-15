/** sqlite-vec + node:sqlite 可行性验证：loadExtension + vec0 表 + KNN + 余弦距离。 */
import { DatabaseSync } from 'node:sqlite'
import { getLoadablePath } from 'sqlite-vec'

const db = new DatabaseSync(':memory:', { allowExtension: true })
try {
  db.loadExtension(getLoadablePath())
  console.log('✅ loadExtension OK, dll =', getLoadablePath())
} catch (err) {
  console.log('❌ loadExtension 失败:', err.message)
  process.exit(1)
}

db.exec('CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[4])')
// 4 维测试向量
const v1 = [1, 0, 0, 0]
const v2 = [0.9, 0.1, 0, 0]
const v3 = [0, 0, 0, 1]
const ins = db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)")
ins.run(1n, JSON.stringify(v1))
ins.run(2n, JSON.stringify(v2))
ins.run(3n, JSON.stringify(v3))

const rows = db.prepare(
  "SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k = 3 ORDER BY distance",
).all(JSON.stringify([0.95, 0.05, 0, 0]))

console.log('KNN 结果（应 rowid 1/2 近、3 远）:')
for (const r of rows) console.log(`  rowid=${r.rowid} distance=${r.distance}`)

// 删除与更新
db.prepare('DELETE FROM vec_items WHERE rowid = 2').run()
const after = db.prepare('SELECT COUNT(*) AS c FROM vec_items').get().c
console.log('删除后行数:', after, after === 2 ? '✅' : '❌')
db.close()

