/**
 * v0.12.0 专项：工具写入不再「孤岛」。
 *
 * 事故（2026-09-21 实测）：库里 41 条 tool.add 记忆**全部**无图节点、无任何连边，
 * 而同期的自动提取路径有 57% 连上了边。根因是 memory_add 只调 store.add，
 * 没走图谱那只手（连同关键词都用 tokenize 的 2-gram 碎片兜底，落出 `取链`/`路根`/`器里` 这种词）。
 * 本套件钉住三件事：连边必须调、关图必须不调、维度必须透传。
 */
import { registerMemoryTools } from './lib/tools/memory.js'
import { MemoryStore, VEC_DIM } from './lib/store.js'
import { RuleEmbedder } from './lib/embedder.js'
import { pickKeywords } from './lib/refiner.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const check = (name, ok) => { if (ok) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) } }

const dir = mkdtempSync(join(tmpdir(), 'dsh-tooladd-'))
const dbs = []
const mkStore = (opts = {}) => {
  const s = new MemoryStore(join(dir, `t${dbs.length}.db`), { embedder: new RuleEmbedder(VEC_DIM), ...opts })
  dbs.push(s)
  return s
}
/** 给 store 的图谱方法装监听（记录被调用的方法名），返回调用记录数组。 */
const spyGraph = (store) => {
  const calls = []
  for (const m of ['graphLink', 'linkBefore', 'linkSemantic']) {
    const orig = store[m].bind(store)
    store[m] = (...a) => { calls.push(m); return orig(...a) }
  }
  return calls
}
/** 注册工具并返回工具表。 */
const mkTools = (store, cfg) => {
  const registered = {}
  registerMemoryTools({ tools: { register: (t) => { registered[t.name] = t } } }, store, () => cfg)
  return registered
}

const CONTENT = '潜空间两段式放大只降峰值显存、不减总计算量；tile_count 从 4 改 6 后 peak_vram 由 9.1GB 降到 7.4GB，重叠税 1.47→1.21 倍'

console.log('== 1. memory_add 必须走图谱连边（此前 41/41 全是孤岛） ==')
{
  const store = mkStore()
  const calls = spyGraph(store)
  const tool = mkTools(store, { features: { graph: true }, logging: { enabled: false } }).memory_add
  const r = await tool.execute({ content: CONTENT, type: 'lesson', layer: 'sm' }, {})
  check('返回 { id, revision }', /^mem-/.test(r.id) && r.revision === 1)
  check('调用了 graphLink（实体共现边）', calls.includes('graphLink'))
  check('调用了 linkBefore（时间演化边）', calls.includes('linkBefore'))
  check('调用了 linkSemantic（语义连边）', calls.includes('linkSemantic'))
  check('三条边各调一次（不重复劳动）', calls.length === 3)
}

console.log('== 2. 关图 / ep 层不得连边（与自动提取口径一致） ==')
{
  const store = mkStore()
  const calls = spyGraph(store)
  const tool = mkTools(store, { features: { graph: false }, logging: { enabled: false } }).memory_add
  await tool.execute({ content: CONTENT, type: 'lesson' }, {})
  check('features.graph=false → 完全不碰图谱', calls.length === 0)

  const store2 = mkStore()
  const calls2 = spyGraph(store2)
  const tool2 = mkTools(store2, { features: { graph: true }, logging: { enabled: false } }).memory_add
  await tool2.execute({ content: CONTENT, type: 'note', layer: 'ep' }, {})
  check('layer=ep（情景快照）→ 不进图谱', calls2.length === 0)
}

console.log('== 3. abstract / theme 维度必须能透传（旧版没有这两个参数） ==')
{
  const store = mkStore()
  spyGraph(store)
  const tool = mkTools(store, { features: { graph: true }, logging: { enabled: false } }).memory_add
  const r = await tool.execute({
    content: CONTENT,
    type: 'lesson',
    abstract: 'principle',
    theme: '  显存调优  ',
  }, {})
  const m = store.get(r.id)
  check('abstract 落库（注入加权才生效）', m.abstract === 'principle')
  check('theme 落库并去空白', m.theme === '显存调优')
  check('工具声明里有 abstract 参数（LLM 可传）', Boolean(tool.parameters?.properties?.abstract))
  check('工具声明里有 theme 参数（LLM 可传）', Boolean(tool.parameters?.properties?.theme))

  const store2 = mkStore()
  const tool2 = mkTools(store2, { features: { graph: false }, logging: { enabled: false } }).memory_add
  const r2 = await tool2.execute({ content: CONTENT }, {})
  check('不填 abstract/theme → 落库为空串（不报错）', store2.get(r2.id).abstract === '' && store2.get(r2.id).theme === '')
}

console.log('== 4. 关键词：2-gram 碎片与虚词不再进库 ==')
{
  const store = mkStore()
  spyGraph(store)
  const tool = mkTools(store, { features: { graph: true }, logging: { enabled: false } }).memory_add
  const r = await tool.execute({ content: '提取链路根治：refiner 的适配器里等于省略参数，于是上游把 maxTokens 吃光', type: 'lesson' }, {})
  const kw = store.get(r.id).keywords
  check('保留具体实体（refiner / maxTokens）', kw.includes('refiner') && kw.includes('maxtokens'))
  check('剔除跨词边界碎片（器里 / 里等 / 于上）', !kw.some((k) => ['器里', '里等', '于上', '的适'].includes(k)))
  check('剔除口语虚词（于是 / 参数 这类不含碎片词）', !kw.includes('于是'))

  // 直接盯住过滤函数本身（防止将来有人把规则删掉）
  const k = pickKeywords('提取链路根治：器里等于省略参数')
  check('pickKeywords 丢弃"器里"（尾字虚词）', !k.includes('器里'))
  check('pickKeywords 丢弃"里等"（首字虚词）', !k.includes('里等'))
  check('pickKeywords 保留"链路"（真词，边界无虚词）', k.includes('链路'))
}

console.log('== 5. content 归一化 + 落库可检索 ==')
{
  const store = mkStore()
  spyGraph(store)
  const tool = mkTools(store, { features: { graph: true }, logging: { enabled: false } }).memory_add
  const r = await tool.execute({ content: `   ${CONTENT}   ` }, {})
  check('content 前后空白被清掉', store.get(r.id).content === CONTENT)
  const hits = await store.search('重叠税', { limit: 5 })
  check('检索命中新写入的这条（不是只写不读）', Array.isArray(hits) && hits.some((h) => h.id === r.id))
}

for (const s of dbs) { try { s.close() } catch { /* 已关闭 */ } }
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
