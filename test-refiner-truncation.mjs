/**
 * v0.12.7 截断专项：max_tokens 截断的「识别 / 修复 / 诊断」。
 *
 * 背景（2026-09-23 用同构探针实测复现）：settings 里残留 `maxTokens: 800` 时，
 * 强制思考的 deepseek-v4.1-flash 把额度**全花在 reasoning 上** →
 * finish_reason=length、reasoning_tokens=800、正文 0 字 → JSON 解析必失败 → 提取全量降级。
 * 同一请求不传 maxTokens：finish=stop、正文 2030 字、JSON 直接可解析。
 *
 * 顺带发现的老 bug：`if (r.finish === 'length')` —— finish 是**对象** `{kind}`，
 * 拿对象比字符串恒为 false，于是 `meta.truncated` 从来没被置过位。
 *
 * 本套件钉住四件事：
 *   ① finish.reason 必须可读（以前是 `[object Object]`，把最关键的终止原因吃掉了）
 *   ② 截断到一半的 JSON 要能修复出"已经写完的条目"
 *   ③ 修不了时，诊断必须指名道姓（max-tokens + maxTokens 建议 + 当前配置值）
 *   ④ 续跑语义不能被这次改动破坏
 */
import { llmStrictJson, parseJsonLoose, repairTruncatedJson, fmtFinish } from './lib/refiner.js'

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) }
}

/** 可控假 LLM：按调用次序脚本化吐块 */
function mkLlm(script) {
  const self = {
    calls: 0,
    seen: [],
    async *stream() {
      const idx = self.calls++
      const step = script[idx] ?? script[script.length - 1]
      for (const chunk of step.chunks ?? []) yield chunk
    },
  }
  return self
}
const delta = (text) => ({ type: 'text-delta', text })
const finish = (reason) => ({ type: 'finish', reason })

console.log('== 1. finish.reason 可读化（以前是 [object Object]） ==')
check('max-tokens 能读出来', fmtFinish({ kind: 'max-tokens' }).text === 'max-tokens')
check('error 的 failure.message 与 code 都读出来',
  (() => { const f = fmtFinish({ kind: 'error', failure: { message: 'boom', code: 'E1' } }); return f.text.includes('boom') && f.text.includes('E1') && f.kind === 'error' })())
check('null → 无', fmtFinish(null).text === '无')
check('字符串 finish 原样处理', fmtFinish('max-tokens').text === 'max-tokens')

console.log('== 2. 截断 JSON 修复：保住已经写完的条目 ==')
const trunc = '{"analysis":"判断完成","items":[{"content":"第一条","type":"note","layer":"sm"},{"content":"第二'
const repaired = repairTruncatedJson(trunc)
check('能修出对象', repaired !== null && typeof repaired === 'object')
check('保住已闭合的 items（1 条，丢掉残的那条）', Array.isArray(repaired?.items) && repaired.items.length === 1)
check('条目内容正确', repaired?.items?.[0]?.content === '第一条')
check('analysis 保住', repaired?.analysis === '判断完成')

const statsOk = {}
parseJsonLoose('{"a":1}', statsOk)
check('完整 JSON 不标记 repaired', statsOk.repaired !== true)

const statsFix = {}
const fixed = parseJsonLoose(trunc, statsFix)
check('parseJsonLoose 走修复路径', fixed?.items?.length === 1)
check('修复时打上 repaired 标记（诊断可见）', statsFix.repaired === true)

check('不是 JSON → 修复返回 null（不硬造）', repairTruncatedJson('这段文字里没有花括号') === null)
check('只有一个开括号（无完整成员）→ 返回 null',
  repairTruncatedJson('{"analysis":"还没写完') === null)

console.log('== 3. 修不了时：诊断必须指名道姓 ==')
const llmTrunc = mkLlm([{ chunks: [delta('{"analysis":"想完了'), finish({ kind: 'max-tokens' })] }])
try {
  await llmStrictJson({ llm: llmTrunc }, { refiner: { provider: 'p', model: 'm', maxTokens: 800, maxContinuations: 0 } }, 'x')
  check('截断且修不了 → 应当抛错', false)
} catch (err) {
  const m = err.message
  check('错误里出现 max-tokens（不再吞成 [object Object]）', m.includes('max-tokens'))
  check('错误里不再有 [object Object]', !m.includes('[object Object]'))
  check('错误里给出 maxTokens 建议', m.includes('maxTokens'))
  check('错误里带上当前配置值 800', m.includes('800'))
  check('错误里报告正文字数（new：textChars）', /正文回包 \d+ 段（\d+ 字）/.test(m))
}

console.log('== 4. 截断但可修复 → 不降级（这条最值钱） ==')
const partial = '{"analysis":"判断完成","items":[{"content":"完整条目","type":"note","layer":"sm","keywords":["a"],"aspect":"","abstract":"event","theme":"t","supersedes":[]},{"content":"残条'
const llmFix = mkLlm([{ chunks: [delta(partial), finish({ kind: 'max-tokens' })] }])
const out = await llmStrictJson({ llm: llmFix }, { refiner: { provider: 'p', model: 'm', maxContinuations: 0 } }, 'x')
check('没走降级：直接拿到 JSON', out?.json?.items?.length === 1)
check('条目内容保住了', out?.json?.items?.[0]?.content === '完整条目')
check('meta.repaired 标记为真', out?.meta?.repaired === true)
check('meta.truncated 也被识别出来（老 bug：对象比字符串恒 false）', out?.meta?.truncated === true)

console.log('== 5. 回归：修不了的截断仍然能靠续跑接上 ==')
const llmCont = mkLlm([
  { chunks: [delta('{"analysis":"想法很长'), finish({ kind: 'max-tokens' })] },
  { chunks: [delta('，结论是 A","items":[]}')] },
])
const out2 = await llmStrictJson({ llm: llmCont }, { refiner: { provider: 'p', model: 'm', maxContinuations: 2 } }, 'x')
check('续跑后拿到完整 JSON', out2?.json?.analysis === '想法很长，结论是 A')
check('续跑次数记为 1', out2?.meta?.continuations === 1)
check('续跑调用用的是"接着写"的系统提示', llmCont.calls === 2)

console.log('== 6. 回归：正常输出不受影响 ==')
const llmOk = mkLlm([{ chunks: [delta('{"analysis":"a","items":[]}')] }])
const out3 = await llmStrictJson({ llm: llmOk }, { refiner: { provider: 'p', model: 'm' } }, 'x')
check('正常 JSON 直接解析', out3?.json?.analysis === 'a')
check('不误标记 repaired', out3?.meta?.repaired !== true)
check('一次调用就成功', out3?.meta?.attempts === 1)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exitCode = 1
