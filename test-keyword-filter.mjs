// v0.9.12 专项：关键词→实体稀有化（pickRareEntities + graphLink 硬过滤）
// 用法: node test-keyword-filter.mjs
import { MemoryStore } from './lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-kw-'))
const store = new MemoryStore(join(dir, 't.db'), { time: true })

console.log('== 1. pickRareEntities：剔泛词 + 稀有度升序 + 截断 k ==')
// 先造 9 条记忆共享"泛词X"（> RARE_MAX=8）；每条带垫词凑满 2 个标签让节点真正建出来
for (let i = 0; i < 9; i++) {
  const m = await store.add({ layer: 'sm', scope: 'test', content: `泛词记忆 ${i}`, keywords: ['泛词X', `垫词${i}`] })
  store.graphLink(m, ['泛词X', `垫词${i}`])
}
// 造"稀有A"共享 2 条 → 稀有度高于"稀有B"(0)
const rA1 = await store.add({ layer: 'sm', scope: 'test', content: 'A1', keywords: ['稀有A'] })
const rA2 = await store.add({ layer: 'sm', scope: 'test', content: 'A2', keywords: ['稀有A'] })
store.graphLink(rA1, ['稀有A', '垫稀有1'])
store.graphLink(rA2, ['稀有A', '垫稀有2'])
const picked = store.pickRareEntities(['泛词X', '稀有A', '稀有B', '稀有C'], { k: 3 })
check('泛词被剔除', !picked.includes('泛词X'))
check('稀有度升序（最稀有在前，共享2的稀有A排最后）', picked[0] === '稀有B' && picked[picked.length - 1] === '稀有A')
const pickedK = store.pickRareEntities(['稀有A', '稀有B', '稀有C'], { k: 2 })
check('截断 k=2', pickedK.length === 2)

console.log('== 2. graphLink 稀有化：高频泛词不进图 ==')
const m = await store.add({ layer: 'sm', scope: 'test', content: '新记忆带泛词与真实体', keywords: ['泛词X', '真实体1', '真实体2'] })
const beforeNodes = store.db.prepare('SELECT COUNT(*) c FROM nodes').get().c
store.graphLink(m, ['泛词X', '真实体1', '真实体2'])
const afterNodes = store.db.prepare('SELECT COUNT(*) c FROM nodes').get().c
const genericNode = store.db.prepare("SELECT COUNT(*) c FROM nodes WHERE label='泛词X' AND memory_id=?").get(m).c
const realNodes = store.db.prepare("SELECT COUNT(*) c FROM nodes WHERE label IN ('真实体1','真实体2') AND memory_id=?").get(m).c
check('泛词X 不为此记忆建节点', genericNode === 0)
check('真实体 为此记忆建节点', realNodes === 2)
check('节点总数仅 +2（不含泛词）', afterNodes === beforeNodes + 2)

console.log('== 3. 只剩 1 个稀有实体 → 不建（需要 ≥2） ==')
const m2 = await store.add({ layer: 'sm', scope: 'test', content: '只有单实体', keywords: ['泛词X', '唯一真实体'] })
const before2 = store.db.prepare('SELECT COUNT(*) c FROM nodes').get().c
store.graphLink(m2, ['泛词X', '唯一真实体'])   // 泛词被剔 → 只剩 1 个 → 不建
const after2 = store.db.prepare('SELECT COUNT(*) c FROM nodes').get().c
check('单稀有实体不建节点', after2 === before2)

console.log('== 4. 全停用词 → 不建 ==')
const m3 = await store.add({ layer: 'sm', scope: 'test', content: '停用词', keywords: ['阶段', '完成'] })
const before3 = store.db.prepare('SELECT COUNT(*) c FROM nodes').get().c
store.graphLink(m3, ['阶段', '完成'])
check('全停用词不产生节点', store.db.prepare('SELECT COUNT(*) c FROM nodes').get().c === before3)

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
