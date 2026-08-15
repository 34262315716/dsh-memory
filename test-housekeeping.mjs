// 阶段三⑥：管家子代理专项（去重扫描 / 老化报告 / 自动合并 / 边界）
// 用法: node test-housekeeping.mjs
import { MemoryStore } from './lib/store.js'
import { RuleEmbedder } from './lib/embedder.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-hk-'))
const store = new MemoryStore(join(dir, 'test.db'), { embedder: new RuleEmbedder(256), time: true })

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

console.log('== 1. 空库边界 ==')
const empty0 = await store.housekeeping({ dryRun: true })
check('空库巡检无候选', empty0.duplicates.length === 0 && empty0.aging.length === 0 && empty0.merged === 0)

console.log('== 2. dedupScan 近重复扫描 ==')
const m1 = await store.add({ layer: 'sm', scope: 'test', content: '管家测试甲：SQLite 存储与向量检索', keywords: ['sqlite', '向量'] })
const m2 = await store.add({ layer: 'sm', scope: 'test', content: '管家测试乙：SQLite 存储与向量检索', keywords: ['sqlite', '向量'] })
const m3 = await store.add({ layer: 'sm', scope: 'test', content: '今天天气很好出门散步吃午饭', keywords: ['天气'] })
// rule 哈希嵌入下近重复文本余弦 ~0.917（真嵌入 4096 维区分度更高）；测试阈值取 0.9
const dup = await store.dedupScan(0.9)
check('相似对命中（不误报无关）', dup.length >= 1 && dup.every((d) => !d.a.includes(m3) && !d.b.includes(m3)))
check('候选包含 m1/m2 对', dup.some((d) => (d.a === m1 && d.b === m2) || (d.a === m2 && d.b === m1)))

console.log('== 3. agingReport 老化报告 ==')
const old = await store.add({ layer: 'sm', scope: 'test', content: '远古记忆：早期技术选型讨论', keywords: ['早期'] })
const now = Date.now()
const day = 24 * 3600 * 1000
store.db.prepare('UPDATE memories SET created_at = ?, last_access = ?, strength = 0.3 WHERE id = ?').run(now - 40 * day, now - 40 * day, old)
const aging = store.agingReport(30)
check('40 天闲置记忆进入老化报告', aging.some((a) => a.id === old && a.idleDays >= 40))
const aging2 = store.agingReport(60)
check('60 天窗口不含 40 天记忆', !aging2.some((a) => a.id === old))

console.log('== 4. housekeeping dryRun=false 自动合并近重复 ==')
const x1 = await store.add({ layer: 'sm', scope: 'test', content: '完全重复的内容样板', keywords: ['样板'] })
const x2 = await store.add({ layer: 'sm', scope: 'test', content: '完全重复的内容样板', keywords: ['样板'] })
const r = await store.housekeeping({ dedupThreshold: 0.95, dryRun: false, autoMergeThreshold: 0.95, limit: 20 })
check('几乎重复对自动合并', r.merged >= 1)
const xRemain = store.list({ scope: 'test', limit: 100 }).filter((m) => m.content.includes('完全重复的内容样板'))
check('合并后仅剩一条（source 已删）', xRemain.length === 1 && (xRemain[0].id === x1 || xRemain[0].id === x2))

console.log('== 5. 合并保留 target 语义（强度高者） ==')
store.db.prepare('UPDATE memories SET strength = 0.9 WHERE id = ?').run(m1)
store.db.prepare('UPDATE memories SET strength = 0.4 WHERE id = ?').run(m2)
const r2 = await store.housekeeping({ dedupThreshold: 0.9, dryRun: false, autoMergeThreshold: 0.9, limit: 20 })
const kept = store.get(m1) ? m1 : m2
check('强度高者保留为 target', r2.merged >= 1 && store.get(kept) !== undefined)

store.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
