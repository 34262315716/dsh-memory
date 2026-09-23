/**
 * v0.12.6 专项：降级记忆重写。
 *
 * 背景：2026-09-16~09-23 提取瘫痪 7 天，期间入库的都是「任务: X 结果: Y」式降级产物。
 * 修好提取后要把它们**救回来**（不是清理）：交回提取器重新判断，产出正常结论并更新原条目。
 *
 * 本套件钉住：拆分正确、候选筛选正确（只认降级产物且排除已归档/太短）、
 * 预演不写库、重写走更新（旧文进世界线）。
 */
import { MemoryStore, VEC_DIM } from './lib/store.js'
import { RuleEmbedder } from './lib/embedder.js'
import { splitDegraded, degradedCandidates } from './lib/tools/rewrite.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const check = (name, ok) => { if (ok) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) } }

console.log('== 1. 拆分「任务/结果」 ==')
{
  const a = splitDegraded('任务: 把步距改成 12\n结果: 已改好，steady 即 12 步')
  check('两侧都拆出来', a.user === '把步距改成 12' && a.assistant === '已改好，steady 即 12 步')

  const b = splitDegraded('任务: (无显式用户消息)\n结果: 工作区干净')
  check('无用户消息形态也能拆', b.user === '(无显式用户消息)' && b.assistant === '工作区干净')

  const c = splitDegraded('任务: 只有任务没有结果')
  check('无分隔符时整段当用户侧、助手侧为空（交给模型自己读）', c.user === '只有任务没有结果' && c.assistant === '')

  const d = splitDegraded('任务: 多段结果\n结果: 第一段\n结果: 第二段')
  check('多个「结果:」只按第一个切分', d.user === '多段结果' && d.assistant.startsWith('第一段'))

  check('空输入不炸', splitDegraded('').user === '' && splitDegraded(null).assistant === '')
}

console.log('== 2. 候选筛选（只认降级产物） ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rw-'))
  const store = new MemoryStore(join(dir, 'r.db'), { embedder: new RuleEmbedder(VEC_DIM) })
  // 注意：正文必须真的超过 minChars，否则候选为空、断言会"空数组假通过"
  const LONG_A = '任务: 把注入步距改成 12 步，另外把 reranker 的 rrfWeight 从 0.7 调到 0.6，实测 top1 相关性下降\n结果: 已改好，steady 档即每 12 步一检，rrfWeight 保持不变'
  const LONG_SHORT_TAIL = '任务: 短\n结果: 短'
  const LONG_ARCHIVED = '任务: 这条是降级产物但已被归档，用来验证候选筛选会排除已归档的条目，正文写得足够长\n结果: 内容也足够长可以通过长度门槛检查'
  await store.add({ layer: 'ep', scope: 't', content: LONG_A })
  await store.add({ layer: 'ep', scope: 't', content: LONG_SHORT_TAIL })
  const good = await store.add({ layer: 'sm', scope: 't', content: LONG_ARCHIVED })
  store.archiveMemories([good], '测试排除')
  await store.add({ layer: 'sm', scope: 't', content: '这是正常的记忆，不该被重写碰到' })

  const all = degradedCandidates(store, { minChars: 80, limit: 20 })
  check('候选择金确实非空（防止空数组假通过）', all.length >= 1)
  check('只取「任务:」开头的条目', all.every((m) => m.content.startsWith('任务:')))
  check('已归档的被排除', !all.some((m) => m.id === good))
  check('太短的被 minChars 过滤', !all.some((m) => m.content === LONG_SHORT_TAIL))
  check('普通记忆不受影响', !all.some((m) => m.content.includes('这是正常的记忆')))

  const epOnly = degradedCandidates(store, { minChars: 80, limit: 20, layer: 'ep' })
  check('layer 过滤生效', epOnly.every((m) => m.layer === 'ep') && epOnly.length >= 1)
  check('limit 生效', degradedCandidates(store, { minChars: 80, limit: 1 }).length === 1)
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log('== 3. 重写走「更新既有条目」而不是新建（旧文进世界线） ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rw2-'))
  const store = new MemoryStore(join(dir, 'r2.db'), { embedder: new RuleEmbedder(VEC_DIM) })
  const id = await store.add({ layer: 'ep', scope: 't', content: '任务: 把注入步距改成 12 步\n结果: 已改好，steady 档即每 12 步一检' })
  const before = store.versions(id).length
  await store.update(id, { content: '注入步距定为每 12 步一检（steady 档）', strengthDelta: 0.2 })
  check('同一条记忆被更新（id 不变）', store.get(id).content.includes('每 12 步一检'))
  check('旧文进了世界线（可回滚）', store.versions(id).length > before && store.versions(id).some((v) => String(v.content).includes('任务:')))
  check('更新后不再以「任务:」开头 → 天然可续跑', !store.get(id).content.startsWith('任务:'))
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
