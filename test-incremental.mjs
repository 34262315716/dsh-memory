// v0.9.8 专项：主题聚类增量 + 事件检测增量（水位线驱动）——启动/巡检不再全量重建。
// 用法: node test-incremental.mjs
import { MemoryStore } from './lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

console.log('== 1. 主题聚类增量：先全量归簇，后续只处理新增记忆 ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-inc-theme-'))
  const store = new MemoryStore(join(dir, 't.db'), { time: true })
  // 第一对相似记忆（应聚成一簇）
  const a = await store.add({ layer: 'sm', scope: 'test', content: '共享主题：向量检索调优一', keywords: ['向量检索'] })
  const b = await store.add({ layer: 'sm', scope: 'test', content: '共享主题：向量检索调优二', keywords: ['向量检索'] })
  await store.themeMemories(0.6)
  const ca = store.db.prepare('SELECT cluster_id, theme FROM memories WHERE id = ?').get(a)
  const cb = store.db.prepare('SELECT cluster_id, theme FROM memories WHERE id = ?').get(b)
  check('首轮：相似记忆归入同一簇', ca.cluster_id === cb.cluster_id && ca.cluster_id !== '')
  check('首轮：簇有主题标签', ca.theme !== '' && ca.theme.includes('向量检索'))
  const nClusters1 = store.db.prepare('SELECT COUNT(*) AS c FROM theme_clusters').get().c
  check('首轮：簇表已持久化', nClusters1 >= 1)
  const caId = ca.cluster_id

  // 第二条无关记忆 → 增量处理：只新建一簇，已有簇不动
  const c = await store.add({ layer: 'sm', scope: 'test', content: '完全无关：机甲 AI 绘画配色方案', keywords: ['机甲绘画'] })
  const out2 = await store.themeMemories(0.6)
  const ca2 = store.db.prepare('SELECT cluster_id, theme FROM memories WHERE id = ?').get(a)
  const cc = store.db.prepare('SELECT cluster_id, theme FROM memories WHERE id = ?').get(c)
  const nClusters2 = store.db.prepare('SELECT COUNT(*) AS c FROM theme_clusters').get().c
  check('增量：已有记忆簇不变（cluster_id 稳定）', ca2.cluster_id === caId)
  check('增量：新记忆新簇（不与旧簇混淆）', cc.cluster_id !== '' && cc.cluster_id !== caId)
  check('增量：簇数恰 +1', nClusters2 === nClusters1 + 1)
  // 旧簇词频不受影响：a 的 theme 保持
  check('增量：旧簇标签不回退', store.db.prepare('SELECT theme FROM memories WHERE id = ?').get(a).theme === ca.theme)

  // 全量模式：全部重归且不抛错
  await store.themeMemories(0.6, { incremental: false })
  const nClustersFull = store.db.prepare('SELECT COUNT(*) AS c FROM theme_clusters').get().c
  check('全量重聚：簇表一致且记忆全部有归属', nClustersFull >= 1 && store.db.prepare("SELECT COUNT(*) AS c FROM memories WHERE cluster_id = ''").get().c === 0)

  // 维度迁移自愈：塞入错误维度的伪造簇 → 下次增量自动清空重聚
  store.db.prepare("INSERT INTO theme_clusters (id, label, centroid, keywords, member_count, updated_at) VALUES ('tc-bogus', '', '[1,2,3]', '{}', 1, 0)").run()
  await store.themeMemories(0.6)
  const bogusGone = store.db.prepare("SELECT COUNT(*) AS c FROM theme_clusters WHERE id = 'tc-bogus'").get().c
  check('维度迁移自愈：伪造簇被清空', bogusGone === 0)
  check('维度迁移自愈：记忆全部重新有归属', store.db.prepare("SELECT COUNT(*) AS c FROM memories WHERE cluster_id = ''").get().c === 0)
  store.close(); rmSync(dir, { recursive: true, force: true })
}

console.log('== 2. 事件检测增量：水位线跳过 + 尾部重建 + 旧事件保留 ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-inc-ev-'))
  const store = new MemoryStore(join(dir, 't.db'), { time: true })
  const HOUR = 3600 * 1000
  const t0 = Date.now() - 24 * HOUR
  // 事件 A：t0 / t0+0.5h（同主题 T1 → 聚为一事件）
  const a1 = await store.add({ layer: 'sm', scope: 'test', content: 'A1', keywords: [] })
  const a2 = await store.add({ layer: 'sm', scope: 'test', content: 'A2', keywords: [] })
  store.db.prepare('UPDATE memories SET created_at = ?, theme = ? WHERE id = ?').run(t0, 'T1', a1)
  store.db.prepare('UPDATE memories SET created_at = ?, theme = ? WHERE id = ?').run(t0 + 0.5 * HOUR, 'T1', a2)
  // 事件 B：t0+9h（隔离，主题 T2）
  const b1 = await store.add({ layer: 'sm', scope: 'test', content: 'B1', keywords: [] })
  store.db.prepare('UPDATE memories SET created_at = ?, theme = ? WHERE id = ?').run(t0 + 9 * HOUR, 'T2', b1)

  const evs1 = store.detectEventsIncremental(2 * HOUR)
  check('首轮增量 = 全量 onboarding（2 事件）', evs1.length === 2)
  const watermark1 = Number(store.getMeta('event_scan_at'))
  check('水位线已推进到最新记忆', watermark1 === t0 + 9 * HOUR)

  const evs2 = store.detectEventsIncremental(2 * HOUR)
  check('无新增 → 直接跳过（0 事件刷新）', evs2.length === 0)
  const nEvents2 = store.events(20).length
  check('无新增 → 事件表保持现状', nEvents2 === 2)

  // 新增 T3 隔离记忆（t0+10h）：尾部重建 → 事件 B 独立、新事件 C 独立，旧事件 A 不动
  const c1 = await store.add({ layer: 'sm', scope: 'test', content: 'C1', keywords: [] })
  store.db.prepare('UPDATE memories SET created_at = ?, theme = ? WHERE id = ?').run(t0 + 10 * HOUR, 'T3', c1)
  const evs3 = store.detectEventsIncremental(2 * HOUR)
  const nEvents3 = store.events(20).length
  const aEvent = store.events(20).find((e) => e.label === 'T1')
  const t3Event = store.events(20).find((e) => e.label === 'T3')
  check('增量：事件总数 3（A/B/C）', nEvents3 === 3)
  check('增量：旧事件 A 保留且成员数不变', aEvent?.count === 2)
  check('增量：新事件 C 独立成事件', t3Event?.count === 1)
  check('增量：水位线继续推进', Number(store.getMeta('event_scan_at')) === t0 + 10 * HOUR)

  // 再加同主题 T3 近刻（t0+10.2h）：与 C 合并成 2 成员事件，事件数仍为 3
  const c2 = await store.add({ layer: 'sm', scope: 'test', content: 'C2', keywords: [] })
  store.db.prepare('UPDATE memories SET created_at = ?, theme = ? WHERE id = ?').run(t0 + 10.2 * HOUR, 'T3', c2)
  store.detectEventsIncremental(2 * HOUR)
  const t3Event2 = store.events(20).find((e) => e.label === 'T3')
  check('增量：同主题近刻合并进 T3 事件（2 成员）', t3Event2?.count === 2)
  check('增量：事件总数仍为 3（合并不新增）', store.events(20).length === 3)

  // 全量 detectEvents 与增量结果对齐（同一数据）
  const evsFull = store.detectEvents(2 * HOUR)
  check('全量 vs 增量：事件数一致', evsFull.length === 3 && evsFull.find((e) => e.label === 'T3')?.count === 2)
  store.close(); rmSync(dir, { recursive: true, force: true })
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
