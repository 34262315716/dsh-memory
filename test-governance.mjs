/**
 * v0.12.1 专项：管家真治理（归档 / 归并 / 可见）。
 *
 * 背景（2026-09-21 用户原话）：「AI 对记忆的维护和整合我没有明显的感觉」。
 * 查下去发现两件事：① 管家每次巡检都是 dryRun——**只报告、不动手**，报告写进日志表就没了；
 * ② 唯一自动发生的"整合"是把两条内容用横线拼起来（库内实测最长 9099 字、同一个"早上好啊"拼了三遍）。
 *
 * 本套件钉住治理的四个承诺：
 *   只归档不删除（可恢复）· 归并是"合成一条新结论"不是"堆叠" · 归档后彻底退出检索 ·
 *   陈旧情景快照有清理口 · 分组是"一团"而不是"一对"。
 */
import { MemoryStore, VEC_DIM } from './lib/store.js'
import { RuleEmbedder } from './lib/embedder.js'
import { groupSimilarPairs, mergeMemoriesWithLlm } from './lib/refiner.js'
import { registerHousekeepingTools } from './lib/tools/housekeeping.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const check = (name, ok) => { if (ok) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) } }

const dir = mkdtempSync(join(tmpdir(), 'dsh-gov-'))
const dbs = []
const mkStore = () => {
  const s = new MemoryStore(join(dir, `g${dbs.length}.db`), { embedder: new RuleEmbedder(VEC_DIM) })
  dbs.push(s)
  return s
}

console.log('== 1. 归档 = 移出检索，不是删除 ==')
{
  const store = mkStore()
  const id = await store.add({ layer: 'sm', scope: 't', content: '归档专用标记文本 ZZZQQQ，用于验证检索行为', keywords: ['归档标记'] })
  const before = await store.search('归档专用标记', { scope: 't', limit: 5 })
  check('归档前能被检索到', before.some((h) => h.id === id))

  check('归档返回条数', store.archiveMemories([id]) === 1)
  check('重复归档不再计数（幂等）', store.archiveMemories([id]) === 0)
  const after = await store.search('归档专用标记', { scope: 't', limit: 5 })
  check('归档后彻底退出检索（含关键词/子串路）', !after.some((h) => h.id === id))
  check('数据没被删除（get 仍能取到）', store.get(id)?.content.includes('ZZZQQQ'))

  const listed = store.list({ scope: 't', limit: 50 })
  check('list 默认不含归档记忆', !listed.some((m) => m.id === id))
  check('includeArchived 才看得到', store.list({ scope: 't', limit: 50, includeArchived: true }).some((m) => m.id === id))
  check('archivedList 能列出来', store.archivedList(10).some((m) => m.id === id))
  check('归档计数正确', store.archivedStat().archived === 1)

  check('恢复返回条数', store.restoreMemories([id]) === 1)
  const back = await store.search('归档专用标记', { scope: 't', limit: 5 })
  check('恢复后重新可被检索（治理可回退）', back.some((h) => h.id === id))
  check('恢复后归档计数归零', store.archivedStat().archived === 0)
}

console.log('== 2. 归并 = 合成一条更完整的结论（不是横线堆叠） ==')
{
  const store = mkStore()
  const a = await store.add({ layer: 'sm', scope: 't', type: 'lesson', content: '旧说法：注入步距是 2 步', keywords: ['注入步距', 'stepInterval'], created_at: Date.now() })
  const b = await store.add({ layer: 'sm', scope: 't', type: 'decision', content: '新说法：注入步距改成 12 步（steady 档）', keywords: ['steady'] })
  const r = await store.mergeMemories(a, [b], {
    content: '注入步距以前是 2 步一检，现在改成 12 步（steady 档）；stepInterval 只在自定义档生效。',
    theme: '注入节奏',
    abstract: 'principle',
  })
  const merged = store.get(a)
  check('目标内容被换成归并结论', merged.content.startsWith('注入步距以前是 2 步'))
  check('不再用横线拼接（旧实现 `\\n---\\n` 的病根）', !merged.content.includes('\n---\n'))
  check('世界线追加了一个版本', r.revision === 2)
  check('源记忆被归档（不是删除）', store.get(b)?.archived === 1)
  check('源记忆数据仍在（可恢复）', store.get(b)?.content.includes('12 步'))
  check('关键词合并', merged.keywords.includes('注入步距') && merged.keywords.includes('steady'))
  check('主题透传到归并结论', merged.theme === '注入节奏')
  check('抽象层级透传（注入加权才生效）', merged.abstract === 'principle')
  check('归并后只剩一条活跃', store.list({ scope: 't', limit: 20 }).length === 1)
}

console.log('== 3. 相似对聚成"一团"（并查集），而不是只处理"一对" ==')
{
  const groups = groupSimilarPairs([{ a: 'x1', b: 'x2' }, { a: 'x2', b: 'x3' }, { a: 'y1', b: 'y2' }, { a: 'z1', b: 'z2' }])
  check('传递性成组（x1-x2-x3 归为一组）', groups.some((g) => g.length === 3 && g.includes('x1') && g.includes('x3')))
  check('孤立对各自成组', groups.filter((g) => g.length === 2).length === 2)
  check('单条不成组', groupSimilarPairs([]).length === 0 && groupSimilarPairs([{ a: 'p', b: 'p' }]).length === 0)
  check('输出确定性（同输入同顺序）', JSON.stringify(groupSimilarPairs([{ a: 'b', b: 'a' }])) === JSON.stringify([['a', 'b']]))
}

console.log('== 4. housekeeping：dryRun 只报告，apply 才动手 ==')
{
  const store = mkStore()
  const c = '完全一样的内容样板：向量检索阈值必须与分数量纲对齐'
  const d1 = await store.add({ layer: 'sm', scope: 't', content: c, keywords: ['量纲', '阈值'] })
  const d2 = await store.add({ layer: 'sm', scope: 't', content: c, keywords: ['量纲', '阈值'] })

  const dry = await store.housekeeping({ dedupThreshold: 0.95, dryRun: true })
  check('dryRun 报出近重复候选', dry.duplicates.length >= 1)
  check('dryRun 不动数据', dry.merged === 0 && store.archivedStat().archived === 0)
  check('dryRun 也不归档 ep（archivedEp=0）', dry.archivedEp === 0)

  const applied = await store.housekeeping({ dedupThreshold: 0.95, dryRun: false, autoMergeThreshold: 0.95 })
  check('apply 合并近乎重复', applied.merged >= 1)
  check('源记忆转归档（不再删除）', store.archivedStat().archived >= 1 && (d1 !== d2))
  check('保留的那条内容未被拼接污染', !store.list({ scope: 't', limit: 10 }).find((m) => m.id === d1 || m.id === d2).content.includes('---'))
  check('返回值带治理明细 details', Array.isArray(applied.details))
}

console.log('== 5. 陈旧情景快照有清理口（"任务/结果"噪音不再永久占库） ==')
{
  const store = mkStore()
  const old = await store.add({ layer: 'ep', scope: 't', content: '任务: 继续\n结果: (无输出)', keywords: [] })
  const fresh = await store.add({ layer: 'ep', scope: 't', content: '任务: 刚发生的事情\n结果: (无输出)', keywords: [] })
  const strong = await store.add({ layer: 'ep', scope: 't', content: '任务: 重要旧事\n结果: (无输出)', keywords: [] })
  const old60 = Date.now() - 60 * 24 * 3600 * 1000
  // 模拟"60 天前创建、且从未被检索命中过"（last_access=0 是老化判据的另一半）
  store.db.prepare('UPDATE memories SET created_at = ?, last_access = 0 WHERE id IN (?, ?)').run(old60, old, strong)
  store.db.prepare('UPDATE memories SET strength = 2.0 WHERE id = ?').run(strong)   // 被访问过/加固过 → 不动

  const cands = store.epArchiveCandidates(45)
  const ids = cands.map((c) => c.id)
  check('陈旧 ep 进入候选', ids.includes(old))
  check('新 ep 不进候选', !ids.includes(fresh))
  check('强度高的 ep 不进候选（保护被用过的）', !ids.includes(strong))

  const r = await store.housekeeping({ dryRun: false, archiveEpAfterDays: 45, dedupThreshold: 0.99 })
  check('apply 时归档陈旧 ep', r.archivedEp >= 1)
  check('被保护的那条仍在活跃集合', store.list({ layer: 'ep', scope: 't', limit: 10 }).some((m) => m.id === strong))
  check('archivedEpAfterDays=0 时不动手（可关闭）', (await store.housekeeping({ dryRun: false, archiveEpAfterDays: 0 })).archivedEp === 0)
}

console.log('== 6. stats 把活跃与归档分开报（不再"库还在长"的错觉） ==')
{
  const store = mkStore()
  await store.add({ layer: 'sm', scope: 't', content: '活跃记忆一条', keywords: ['活跃'] })
  const gone = await store.add({ layer: 'sm', scope: 't', content: '将被归档的一条', keywords: ['归档'] })
  store.archiveMemories([gone])
  const st = store.stats()
  check('memories 只算活跃', st.memories === 1)
  check('archived 单独报', st.archived === 1)
  check('degraded 恒为布尔（schema 要求，不得 undefined）', typeof st.degraded === 'boolean')
}

console.log('== 7. memory_archive 工具：查看与恢复 ==')
{
  const store = mkStore()
  const id = await store.add({ layer: 'sm', scope: 't', content: '工具恢复测试用的记忆', keywords: ['恢复测试'] })
  store.archiveMemories([id])
  const registered = {}
  registerHousekeepingTools({ tools: { register: (t) => { registered[t.name] = t } } }, store, () => ({ refiner: { enabled: false }, logging: { enabled: false }, housekeeping: {} }))
  const tool = registered.memory_archive
  check('memory_archive 已注册', typeof tool?.execute === 'function')

  const list = await tool.execute({ action: 'list', limit: 10 })
  check('list 列出归档记忆', list.items.some((m) => m.id === id) && list.archivedTotal === 1)
  check('列表带内容摘要（能看清是什么）', list.items[0].content.length > 0)

  const rest = await tool.execute({ action: 'restore', ids: [id] })
  check('restore 恢复记忆', rest.restored === 1 && rest.archivedTotal === 0)
  check('恢复后重新进入活跃集合', store.list({ scope: 't', limit: 10 }).some((m) => m.id === id))

  const bad = await tool.execute({ action: 'restore', ids: ['mem-不存在'] })
  check('恢复不存在的 id 不报错（返回 0）', bad.restored === 0)
}

console.log('== 8. LLM 归并器：走思考档基础设施，且拒绝单条输入 ==')
{
  const store = mkStore()
  const m1 = store.get(await store.add({ layer: 'sm', scope: 't', content: '第一条', keywords: ['a'] }))
  let threw = false
  try { await mergeMemoriesWithLlm({ llm: { stream: async function* () {} } }, { refiner: {} }, [m1]) } catch { threw = true }
  check('少于两条直接拒绝（不该归并）', threw)

  const llmSeen = []
  const mockCtx = { llm: { stream: async function* (opts) { llmSeen.push(opts); yield { type: 'text-delta', text: '{"analysis":"两条冲突，以新的为准","content":"归并结论","keywords":["x"],"theme":"主题","abstract":"principle"}' } } } }
  const m2 = store.get(await store.add({ layer: 'sm', scope: 't', content: '第二条', keywords: ['b'] }))
  const out = await mergeMemoriesWithLlm(mockCtx, { refiner: { provider: 'p', model: 'm', maxTokens: 0 } }, [m1, m2])
  check('归并返回 content / keywords / theme / abstract', out.content === '归并结论' && out.keywords[0] === 'x' && out.theme === '主题' && out.abstract === 'principle')
  check('归并判断（analysis）一并带回，可审计', out.analysis.includes('以新的为准'))
  check('归并提示词带上两条原文', llmSeen[0].messages[0].content[0].text.includes('第一条') && llmSeen[0].messages[0].content[0].text.includes('第二条'))
  check('归并不设 token 上限（与提取同一套策略）', llmSeen[0].maxTokens === undefined)
  check('归并要求去重并保住关键约束', llmSeen[0].messages[0].content[0].text.includes('关键约束'))
}

for (const s of dbs) { try { s.close() } catch { /* 已关闭 */ } }
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
