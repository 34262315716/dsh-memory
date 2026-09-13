/**
 * 语义连边集成测试（lib/store.js#linkSemantic）：用临时库 + 手工构造向量精确控制余弦值，
 * 覆盖四道闸门在**真实 store 接口**上的行为（纯函数规则本身由 test-link-suggest.mjs 覆盖）。
 * 每段用**独立的临时库**——否则前一段的高相似向量会成为后一段的邻居，测试互相污染。
 */
import { MemoryStore, cosine } from './lib/store.js'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ✅', name) } else { fail++; console.log('  ❌', name) }
}
/** 4 维单位向量：角度越大余弦越低。 */
const unit = (deg) => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0, 0])

/** 每段一个全新库，返回绑定好的小工具箱。 */
function freshStore() {
  const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'dsh-semlink-')), 'test.db'), { vecDim: 4, time: true })
  const putVec = (id, vec) => {
    const row = store.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id)
    store.stmt.vecUpdate.run(JSON.stringify(Array.from(vec)), BigInt(row.rowid))
  }
  const add = async (content, scope, layer = 'sm') => await store.add({ layer, type: 'note', scope, content, keywords: [content.slice(0, 4)] })
  const edgeCount = (id) => store.db.prepare('SELECT COUNT(*) c FROM memory_links WHERE valid_to IS NULL AND (from_memory = ? OR to_memory = ?)').get(id, id).c
  const edgeOf = (id) => store.db.prepare('SELECT type, weight FROM memory_links WHERE valid_to IS NULL AND (from_memory = ? OR to_memory = ?)').get(id, id)
  return { store, putVec, add, edgeCount, edgeOf }
}
console.log('== 1. 高相似 + 互为最近邻 → 连边 ============')
{
  const { store, putVec, add, edgeOf } = freshStore()
  const a = await add('记忆图谱的主题圈应当贴合内容', 'proj')
  const b = await add('主题圈的边界需要刚好包住同主题节点', 'proj')
  putVec(a, unit(0)); putVec(b, unit(12))       // cos ≈ 0.978
  const n = store.linkSemantic(a)
  check('新建 1 条语义边', n === 1)
  const e = edgeOf(a)
  const want = cosine(unit(0), unit(12))
  check(`边类型 similarTo（实际 ${e?.type}）`, e?.type === 'similarTo')
  check(`权重=余弦（期望 ${want.toFixed(4)} 实际 ${Number(e?.weight).toFixed(4)}）`, Math.abs(want - e.weight) < 1e-3)
}

console.log('== 2. 低于阈值 → 不连边 ============')
{
  const { store, putVec, add } = freshStore()
  const a = await add('低相似度对照组 A', 'p2')
  const b = await add('完全无关的话题内容 B', 'p2')
  putVec(a, unit(0)); putVec(b, unit(55))       // cos ≈ 0.574 < 0.78
  check('不新建边', store.linkSemantic(a) === 0)
}

console.log('== 3. 单向（非互为最近邻）→ 不连边 ============')
{
  const { store, putVec, add } = freshStore()
  const a = await add('单向候选的发起方', 'p3')
  // 让 a 的候选是 b，但 b 的最近邻居里有多个比 a 更近的（topK=2 时 a 排第 3）
  const b = await add('候选接收方', 'p3')
  const c1 = await add('更近的干扰项 1', 'p3')
  const c2 = await add('更近的干扰项 2', 'p3')
  putVec(a, unit(0)); putVec(b, unit(10)); putVec(c1, unit(1)); putVec(c2, unit(2))
  check('b 眼中的 a 排在 topK 之外 → 不连边', store.linkSemantic(a, { topK: 2 }) === 0)
  check('把 topK 放宽到 4 → 可连边', store.linkSemantic(a, { topK: 4 }) >= 1)
}

console.log('== 4. 跨 scope 守卫 ============')
{
  const { store, putVec, add } = freshStore()
  const a = await add('跨项目同域内容 A', 'proj-x')
  const b = await add('跨项目同域内容 B', 'proj-y')
  putVec(a, unit(0)); putVec(b, unit(30))       // cos ≈ 0.866：高于 0.78、低于跨域 0.88
  check('跨 scope 且未达跨域阈值 → 不连边', store.linkSemantic(a) === 0)
  const a2 = await add('跨项目高相似 A2', 'proj-x')
  const b2 = await add('跨项目高相似 B2', 'proj-y')
  putVec(a2, unit(60)); putVec(b2, unit(63))    // cos ≈ 0.998 > 0.88，且与 a/b 分开（避免互相当邻居）
  check('跨 scope 但足够高 → 连边', store.linkSemantic(a2) === 1)
}

console.log('== 5. 度数上限 / 层级 / 向量缺失 ============')
{
  const { store, putVec, add, edgeCount } = freshStore()
  const a = await add('中心节点（三个强邻居）', 'p5')
  const b = await add('强邻居 1', 'p5')
  const c = await add('强邻居 2', 'p5')
  const d = await add('强邻居 3', 'p5')
  putVec(a, unit(0)); putVec(b, unit(3)); putVec(c, unit(4)); putVec(d, unit(5))
  const n = store.linkSemantic(a, { maxLinks: 2 })
  check('每条记忆最多连 2 条', n === 2 && edgeCount(a) === 2)

  const e = await add('情景层记忆不应参与', 'p6', 'ep')
  const f = await add('语义层对照', 'p6')
  putVec(e, unit(0)); putVec(f, unit(2))
  check('ep 层不参与连边', store.linkSemantic(e) === 0 && edgeCount(e) === 0)

  const g = await add('没有向量的记忆', 'p7')
  check('向量缺失 → 返回 0（不抛）', store.linkSemantic(g) === 0)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
