// v0.9.10 专项：更新时新内容永远接在旧内容末尾（+N 徽标每更新 +1），完全相同内容 = 无操作
// 用法: node test-update-append.mjs
import { MemoryStore, tokenize } from './lib/store.js'
import { upsertMemory } from './lib/pipelines/write.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-upd-'))
const store = new MemoryStore(join(dir, 't.db'), { time: true, maxVersions: 8 })
const features = { graph: true, dedupMerge: true }
const kw = [...tokenize('记忆更新机制 SQLite 内容拼接')]
const kwA = [...tokenize('记忆更新机制 SQLite 内容拼接 A')]

console.log('== 1. 首次写入（无相似记忆 → 新建） ==')
const id1 = await upsertMemory(store, features, { layer: 'sm', type: 'note', scope: 'test', content: '初版内容：记忆系统更新机制', keywords: kw })
check('新建返回 id', id1.startsWith('mem-'))
check('版本 revision=1', store.db.prepare('SELECT MAX(revision) m FROM memory_versions WHERE memory_id = ?').get(id1).m === 1)

console.log('== 2. 更新：新内容无条件接末尾（新的比旧的短也照样接） ==')
// 关键词相同（Jaccard=1 → 走更新分支）；新内容更短，旧逻辑会"保留旧版吞掉新内容"，现应无条件拼接
await upsertMemory(store, features, { layer: 'sm', type: 'note', scope: 'test', content: '短更新', keywords: kw })
const c1 = store.get(id1)
check('新内容接在旧内容末尾', c1.content === '初版内容：记忆系统更新机制\n---\n短更新')
check('版本 revision=2（+1）', store.db.prepare('SELECT MAX(revision) m FROM memory_versions WHERE memory_id = ?').get(id1).m === 2)

console.log('== 3. 再更新：持续追加 + 版本继续涨 ==')
await upsertMemory(store, features, { layer: 'sm', type: 'note', scope: 'test', content: '第三段新内容', keywords: kw })
const c2 = store.get(id1)
check('持续追加到末尾', c2.content.endsWith('\n---\n第三段新内容'))
check('版本 revision=3（+2）', store.db.prepare('SELECT MAX(revision) m FROM memory_versions WHERE memory_id = ?').get(id1).m === 3)

console.log('== 4. 完全相同内容 = 无操作（不追加、不升版本） ==')
await upsertMemory(store, features, { layer: 'sm', type: 'note', scope: 'test', content: '第三段新内容', keywords: kw })
const c3 = store.get(id1)
check('一模一样内容不重复追加', c3.content === c2.content)
check('版本不再升（保持 3）', store.db.prepare('SELECT MAX(revision) m FROM memory_versions WHERE memory_id = ?').get(id1).m === 3)

console.log('== 5. 不同关键词组（Jaccard 不足 → 新建，不影响原记忆） ==')
await upsertMemory(store, features, { layer: 'sm', type: 'note', scope: 'test', content: '另一个完全无关主题：机甲 AI 绘画', keywords: ['机甲绘画'] })
check('无关主题新建', store.get(id1).content === c3.content && store.stats().memories === 2)

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
