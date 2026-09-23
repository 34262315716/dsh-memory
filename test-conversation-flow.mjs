/**
 * v0.12.2 专项：日常对话流程（会话级汇总 + 纠正既有记忆）。
 *
 * 用户原话：「提取日常对话中的内容也需要进行方法流程上的优化」。查下去是两个缺口：
 *   ① 只有"这一轮发生了什么"的碎片，**没有"整段会话最后落在哪里"**——一晚上的讨论定了什么，
 *      散在十几条记忆里，没人给结论；
 *   ② 用户说"不对/我改成 X"时，系统**只会新建**一条，旧的那条还留着 → 库里长期存在
 *      新旧并存的矛盾记忆（身高、家庭关系、择偶倾向都出现过"旧记 + 更正记"）。
 *
 * 本套件钉住：纠正走"更新既有记忆"（旧内容进世界线可回滚）、模型编的 id 改不动无关记忆、
 * 汇总真的把整段会话当输入且只收结论。
 */
import { MemoryStore, VEC_DIM } from './lib/store.js'
import { RuleEmbedder } from './lib/embedder.js'
import { applyExtractedItems } from './lib/pipelines/write.js'
import { extractWithLlm, summarizeSessionWithLlm, normalizeItems } from './lib/refiner.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const check = (name, ok) => { if (ok) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) } }

const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-'))
const dbs = []
const mkStore = () => {
  const s = new MemoryStore(join(dir, `f${dbs.length}.db`), { embedder: new RuleEmbedder(VEC_DIM) })
  dbs.push(s)
  return s
}
const FEATURES = { graph: false, dedupMerge: true }
const llmReturning = (payload, seen) => ({
  llm: {
    async *stream(opts) {
      seen?.push(opts)
      yield { type: 'text-delta', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }
    },
  },
})

console.log('== 1. 纠正：更新既有记忆，而不是新建一条并存的矛盾记忆 ==')
{
  const store = mkStore()
  const old = await store.add({ layer: 'sm', scope: 't', type: 'profile', content: '用户喜欢比自己高的女生', keywords: ['择偶'] })
  const items = normalizeItems({ items: [{ content: '用户目前不想谈恋爱，对大多数女性没什么感觉；旧记「喜欢比自己高的女生」属误判', type: 'profile', layer: 'sm', keywords: ['择偶'], supersedes: [old] }] })
  const r = await applyExtractedItems(store, FEATURES, items, { knownIds: new Set([old]), writeScope: () => 't' })

  check('走的是纠正分支（corrected=1，没有新建）', r.corrected === 1 && r.written === 0)
  check('同一条记忆被更新（id 不变）', store.get(old).content.includes('不想谈恋爱'))
  check('旧内容进了世界线（可回滚，不是抹掉）', store.versions(old).some((v) => String(v.content).includes('喜欢比自己高的女生')))
  check('版本链长到 2 条（revision 只存在于版本表，memories 表无此列）', store.versions(old).length >= 2)
  check('库里只有一条相关记忆（不再新旧并存）', store.list({ scope: 't', limit: 10 }).filter((m) => m.content.includes('恋爱') || m.content.includes('比自己高')).length === 1)
}

console.log('== 2. 白名单：模型凭空编的 id 改不动无关记忆 ==')
{
  const store = mkStore()
  const untouched = await store.add({ layer: 'sm', scope: 't', content: '一条无关的记忆，不该被任何纠正碰到', keywords: ['无关'] })
  const items = normalizeItems({ items: [{ content: '试图改一条没喂给模型的记忆', type: 'note', keywords: [], supersedes: [untouched] }] })
  const r = await applyExtractedItems(store, FEATURES, items, { knownIds: new Set(['mem-other']), writeScope: () => 't' })
  check('不在白名单 → 不走纠正分支', r.corrected === 0 && r.written === 1)
  check('无关记忆原文一字未动', store.get(untouched).content === '一条无关的记忆，不该被任何纠正碰到')
}

console.log('== 3. 混合一轮：新内容新建、旧内容纠正（同一条消息里同时发生） ==')
{
  const store = mkStore()
  const stale = await store.add({ layer: 'sm', scope: 't', content: '注入步距是每 2 步一检', keywords: ['注入步距'] })
  const items = normalizeItems({ items: [
    { content: '注入步距改成每 12 步一检（steady 档）', type: 'decision', keywords: ['注入步距'], supersedes: [stale] },
    { content: '用户偏好先看产出再讨论提示词', type: 'preference', keywords: ['提示词'], supersedes: [] },
  ] })
  const r = await applyExtractedItems(store, FEATURES, items, { knownIds: new Set([stale]), writeScope: () => 't' })
  check('一条纠正 + 一条新建', r.corrected === 1 && r.written === 1)
  check('被纠正的那条内容已更新', store.get(stale).content.includes('12 步'))
  check('新内容确实新增了', store.list({ scope: 't', limit: 10 }).some((m) => m.content.includes('先看产出')))
}

console.log('== 4. supersedes 字段清洗（格式越界一律回落） ==')
{
  check('非数组回落空数组', normalizeItems({ items: [{ content: 'x', supersedes: 'mem-1' }] })[0].supersedes.length === 0)
  check('非 mem- 前缀被剔除', normalizeItems({ items: [{ content: 'x', supersedes: ['abc', 'mem-1'] }] })[0].supersedes.join() === 'mem-1')
  check('最多保留 2 个', normalizeItems({ items: [{ content: 'x', supersedes: ['mem-1', 'mem-2', 'mem-3'] }] })[0].supersedes.length === 2)
  check('缺字段时为空数组（旧模型输出不炸）', normalizeItems({ items: [{ content: 'x' }] })[0].supersedes.length === 0)
}

console.log('== 5. 提取时看得见库里已有的相关记忆（否则无从判断"这是纠正"） ==')
{
  const seen = []
  const ctx = llmReturning({ analysis: 'a', items: [] }, seen)
  await extractWithLlm(ctx, { refiner: { provider: 'p', model: 'm' } }, '不对，我说的是 12 步', '好的', {
    known: [{ id: 'mem-abc123', type: 'decision', content: '注入步距是每 2 步一检' }],
  })
  const prompt = seen[0].messages[0].content[0].text
  check('已知记忆的 id 与内容进了提示词', prompt.includes('mem-abc123') && prompt.includes('每 2 步一检'))
  check('明确要求 supersedes 只填"旧记忆已经不对了"的', prompt.includes('supersedes') && prompt.includes('宁可留空'))
  check('输出格式示例带 supersedes 字段', prompt.includes('"supersedes": []'))

  const seen2 = []
  await extractWithLlm(llmReturning({ analysis: 'a', items: [] }, seen2), { refiner: { provider: 'p', model: 'm' } }, 'u', 'a')
  check('没有已知记忆时明确说明（不留悬念）', seen2[0].messages[0].content[0].text.includes('没有检索到相关旧记忆'))
}

console.log('== 6. 会话级汇总：整段会话当输入，只收结论 ==')
{
  const seen = []
  const turns = [
    { user: '把注入步距改成 12 步', assistant: '改好了，steady 档即 12 步' },
    { user: '那 4 步呢', assistant: '4 步是激进档，会太吵，建议保持 12' },
    { user: '行，就 12', assistant: '已确认 12 步' },
  ]
  const ctx = llmReturning({ analysis: '整段只落定一件事', items: [{ content: '注入步距最终定为每 12 步一检（steady 档）；4 步激进档被否掉', type: 'decision', keywords: ['注入步距'], theme: '注入节奏' }] }, seen)
  const out = await summarizeSessionWithLlm(ctx, { refiner: { provider: 'p', model: 'm' } }, turns)
  const prompt = seen[0].messages[0].content[0].text
  check('轮次全部进入提示词', prompt.includes('第 1 轮') && prompt.includes('第 3 轮') && prompt.includes('就 12'))
  check('要求写"结论清单"而不是复述过程', prompt.includes('结论清单') && prompt.includes('落在哪里'))
  check('明确要求只写最后落定的那个', prompt.includes('只写最后落定的那个'))
  check('汇总结果返回 items', out.items.length === 1 && out.items[0].theme === '注入节奏')
  check('汇总的 analysis 一并带回（可审计）', out.analysis.includes('只落定一件事'))

  let threw = false
  try { await summarizeSessionWithLlm(llmReturning({ items: [] }), { refiner: {} }, []) } catch { threw = true }
  check('没有轮次时直接拒绝（不空跑模型）', threw)
}

console.log('== 7. 汇总条目落库后是一等记忆（与逐轮提取同规格） ==')
{
  const store = mkStore()
  const items = normalizeItems({ items: [{ content: '本次会话结论：注入步距定 12 步', type: 'decision', layer: 'sm', keywords: ['注入步距'], abstract: 'principle', theme: '注入节奏' }] })
  const r = await applyExtractedItems(store, FEATURES, items, { writeScope: () => 't' })
  const m = store.list({ scope: 't', limit: 5 })[0]
  check('汇总条目正常入库', r.written === 1 && m.content.includes('定 12 步'))
  check('抽象层级与主题保留（注入加权照常生效）', m.abstract === 'principle' && m.theme === '注入节奏')
  check('可被检索到', (await store.search('注入步距', { scope: 't', limit: 5 })).length >= 1)
}

for (const s of dbs) { try { s.close() } catch { /* 已关闭 */ } }
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
