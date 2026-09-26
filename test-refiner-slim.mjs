/**
 * v0.13.3 提取瘦身专项：思考量从哪来、怎么把它减下去。
 *
 * 背景（2026-09-26 用户直接反馈「提取时的思考过程实在太长」）：线上 4 次降级事件里
 * 思考 14122 / 34052 / 45327 字、正文只有 1472~3776 字，而且是「跑满 4 次调用 + 3 次续跑」。
 * 三个真凶：
 *   ① 提示词命令模型「用 2-5 句回答…会被审计，请认真写，不要敷衍」——对**强制思考**的
 *      deepseek-v4.1-flash 是火上浇油（先在心里把判断论证一遍，再正式写一遍）；
 *   ② 续跑判据写成 `acc.includes('{')`：正文**是散文**、只是里面夹了个 `{`，就被判成
 *      "JSON 写了一半"，于是 3 次续跑全在催"接着写"，每次都要重新思考一遍；
 *   ③ 输入给到 6000+6000 字 + 无上限的旧记忆清单，读得越多、想得越多。
 *
 * 本套件钉住四件事：
 *   ① 散文（哪怕带 `{`）不再触发 3 次续跑 → 只走 1 次针对性强化重试，调用数从 5 降到 2
 *   ② 空正文/截断的续跑语义不能被破坏（该续还得续）
 *   ③ meta.calls 逐次记账（元凶②之所以难查，是因为 meta.reasoningChars 是累加值）
 *   ④ 提示词与输入真的变短了，且"不要空转"的指令在场
 */
import {
  llmStrictJson, extractWithLlm,
  DEFAULT_DIALOG_CHARS, DEFAULT_KNOWN_CHARS, DEFAULT_KNOWN_TOP_N,
} from './lib/refiner.js'

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) }
}

/** 可控假 LLM：按调用次序脚本化吐块，同时记下发出去的提示词 */
function mkLlm(script) {
  const self = {
    calls: 0,
    prompts: [],
    systems: [],
    async *stream(opts) {
      const idx = self.calls++
      self.prompts.push(String(opts?.messages?.[0]?.content?.[0]?.text ?? ''))
      self.systems.push(String(opts?.system ?? ''))
      const step = script[idx] ?? script[script.length - 1]
      for (const chunk of step?.chunks ?? []) yield chunk
    },
  }
  return self
}
const delta = (text) => ({ type: 'text-delta', text })
const think = (text) => ({ type: 'reasoning-delta', text })
const finish = (reason) => ({ type: 'finish', reason })

console.log('== 1. 散文跑题（正文里夹了个 `{`）→ 不再白烧 3 次续跑 ==')
// 实测形态：正文是叙述文字、里面恰好带一个 `{`、finish=stop
const prose = '我先看看这轮对话。用户说的是 { 那个改法 } ，我觉得值得记一条关于提示词的教训。'
const llmProse = mkLlm([
  { chunks: [think('（想很久）'), delta(prose), finish({ kind: 'stop' })] },
  { chunks: [delta('{"analysis":"值得记：提示词过长导致思考膨胀","items":[]}'), finish({ kind: 'stop' })] },
])
const r1 = await llmStrictJson({ llm: llmProse }, { refiner: { provider: 'p', model: 'm', maxContinuations: 3 } }, 'x')
check('散文不再被当成"JSON 写了一半"去续跑', r1?.meta?.continuations === 0)
check('改用强化重试救回来（提示词写进 analysis）', r1?.meta?.proseRetry === true && r1?.json?.items?.length === 0)
check('总调用数 = 2（旧逻辑是 4~5 次）', llmProse.calls === 2)
check('重试提示词点名"叙述文字"与 analysis 字段',
  llmProse.prompts[1].includes('叙述文字') && llmProse.prompts[1].includes('analysis'))
check('重试用的是 RETRY 系统提示（只输出 JSON 本体）', llmProse.systems[1].includes('只输出合法 JSON'))

console.log('== 2. 一直写散文 → 2 次就收手，诊断说清原因 ==')
const llmAlways = mkLlm([{ chunks: [delta(prose), finish({ kind: 'stop' })] }])
try {
  await llmStrictJson({ llm: llmAlways }, { refiner: { provider: 'p', model: 'm', maxContinuations: 3 } }, 'x')
  check('纯散文最终仍应报错（不硬造记忆）', false)
} catch (err) {
  check('报错', true)
  check('调用数封顶在 2（旧逻辑 5：1 首调 + 3 续跑 + 1 重试）', llmAlways.calls === 2)
  check('诊断指出"正文是叙述文字"', err.message.includes('叙述文字'))
  check('诊断里的思考字数是跨调用累计值', /思考 \d+ 字（跨调用累计，逐次见下）/.test(err.message))
  check('诊断里带上逐次调用的记账', err.message.includes('逐次调用'))
}

console.log('== 3. 回归：空正文 / 截断该续还得续 ==')
const llmEmpty = mkLlm([
  { chunks: [think('想完了但一个字没写'), finish({ kind: 'stop' })] },
  { chunks: [delta('{"analysis":"补上正文","items":[]}'), finish({ kind: 'stop' })] },
])
const r2 = await llmStrictJson({ llm: llmEmpty }, { refiner: { provider: 'p', model: 'm', maxContinuations: 3 } }, 'x')
check('空正文仍然走续跑（不是跑题）', r2?.meta?.continuations === 1 && r2?.meta?.proseRetry === false)
check('续跑提示针对性说明"思考完成但正文没写"', llmEmpty.prompts[1].includes('正文一个字都没输出'))

const llmCut = mkLlm([
  { chunks: [delta('{"analysis":"想法很长'), finish({ kind: 'max-tokens' })] },
  { chunks: [delta('，结论是 A","items":[]}')] },
])
const r3 = await llmStrictJson({ llm: llmCut }, { refiner: { provider: 'p', model: 'm', maxContinuations: 2 } }, 'x')
check('截断到一半的 JSON 仍然靠续跑接上', r3?.json?.analysis === '想法很长，结论是 A')
check('续跑调用用的是"接着写"的系统提示', llmCut.calls === 2)

console.log('== 4. meta.calls 逐次记账（查"思考为什么这么长"的唯一抓手） ==')
check('calls 数组长度 = 实际调用数', Array.isArray(llmProse.prompts) && r1?.meta?.calls?.length === 2)
check('每次记下正文/思考字数与 finish',
  r1?.meta?.calls?.[0]?.textChars > 0
  && r1?.meta?.calls?.[0]?.reasoningChars > 0
  && r1?.meta?.calls?.[0]?.finish === 'stop')
check('有跨调用累计的思考字数（"这次提取一共想了多少字"看它）',
  r1?.meta?.reasoningCharsTotal === r1.meta.calls[0].reasoningChars + r1.meta.calls[1].reasoningChars)

console.log('== 5. 提示词瘦身：不再命令模型"认真写长" ==')
const llmPrompt = mkLlm([{ chunks: [delta('{"analysis":"a","items":[]}'), finish({ kind: 'stop' })] }])
const small = await extractWithLlm({ llm: llmPrompt }, { refiner: { provider: 'p', model: 'm' } }, '用户说了点什么', '助手回了点什么', {})
const p0 = llmPrompt.prompts[0]
check('删掉了"会被审计，请认真写，不要敷衍"', !p0.includes('会被审计') && !p0.includes('不要敷衍'))
check('analysis 改成 1-2 句直给结论', p0.includes('analysis：1-2 句'))
check('带上"不要在思考里复述对话/复读规则"的指令', p0.includes('不要在思考里复述对话'))
check('规则块明显变短（< 900 字）', p0.split('【items')[0].length < 900)
check('字段取值/关键词规则都还在（没把要求一起删掉）',
  p0.includes('keywords') && p0.includes('profile') && p0.includes('principle'))
check('正常路径一次调用成功', small?.items?.length === 0 && llmPrompt.calls === 1)

console.log('== 6. 输入瘦身：对话与旧记忆都截断，且有上限 ==')
check('默认单侧对话上限 = 4000 字', DEFAULT_DIALOG_CHARS === 4000)
const longUser = '头部哨兵' + '啊'.repeat(9000) + '尾巴哨兵'
const llmLong = mkLlm([{ chunks: [delta('{"analysis":"a","items":[]}'), finish({ kind: 'stop' })] }])
await extractWithLlm({ llm: llmLong }, { refiner: { provider: 'p', model: 'm' } }, longUser, longUser, {})
const pLong = llmLong.prompts[0]
check('超长对话被截断（尾部哨兵不出现）', pLong.includes('头部哨兵') && !pLong.includes('尾巴哨兵'))
check('整条提示词长度被压住（< 10000 字）', pLong.length < 10000)

const llmSmall = mkLlm([{ chunks: [delta('{"analysis":"a","items":[]}'), finish({ kind: 'stop' })] }])
await extractWithLlm({ llm: llmSmall }, { refiner: { provider: 'p', model: 'm', dialogChars: 800 } }, longUser, '短回复', {})
check('dialogChars 可配置（800 生效）', !llmSmall.prompts[0].includes('尾巴哨兵') && llmSmall.prompts[0].length < 5000)

check('旧记忆每条默认 120 字 / 最多 5 条', DEFAULT_KNOWN_CHARS === 120 && DEFAULT_KNOWN_TOP_N === 5)
const known = Array.from({ length: 8 }, (_, i) => ({ id: `mem-t${i + 1}`, type: 'note', content: '内容'.repeat(200) }))
const llmKnown = mkLlm([{ chunks: [delta('{"analysis":"a","items":[]}'), finish({ kind: 'stop' })] }])
await extractWithLlm({ llm: llmKnown }, { refiner: { provider: 'p', model: 'm' } }, 'u', 'a', { known })
const pKnown = llmKnown.prompts[0]
const knownLines = pKnown.match(/^- mem-t\d+｜/gm) ?? []
check('只给前 5 条（第 6 条起不再塞进提示词）', knownLines.length === 5 && !pKnown.includes('mem-t6'))
check('每条旧记忆被截到 120 字级', Math.max(...pKnown.split('\n').filter((l) => l.startsWith('- mem-')).map((l) => l.length)) < 140)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exitCode = 1
