/**
 * v0.12 提取器专项：思考档 + 不设 token 上限 + 时间预算掐断 + 断点续思。
 *
 * 背景（2026-09-21 事故复盘）：pi-ai 适配器把 `reasoningEffort:'off'` 翻译成「省略参数」，
 * 上游 deepseek-v4.1-flash 默认强制思考，把 maxTokens=800 全部吃成 reasoning_tokens，
 * 正文 0 字 → JSON.parse('') → 自 2026-09-16 起蒸馏 100% 失败、全部静默降级。
 *
 * 本套件把"修好之后必须一直成立"的行为钉住：不设上限、思考流要收、掐断要能接上、
 * 空输出要能救回来、接不上要停、条目要能多条、寒暄要挡住。
 */
import { llmStrictJson, extractWithLlm, normalizeItems, pickKeywords } from './lib/refiner.js'
import { isTrivialTurn } from './lib/pipelines/write.js'

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) }
}

/** 造一个可控的假 LLM：按调用次序脚本化吐块，可模拟"吐到一半被掐断"。 */
function mkLlm(script) {
  const self = {
    calls: 0,
    seen: [],
    async *stream(opts) {
      const idx = self.calls++
      self.seen.push(opts)
      const step = script[idx] ?? script[script.length - 1]
      for (const chunk of step.chunks ?? []) yield chunk
      if (step.waitForAbort) {
        await new Promise((resolve) => {
          if (opts.signal?.aborted) return resolve()
          opts.signal?.addEventListener('abort', resolve, { once: true })
          setTimeout(resolve, 500)
        })
        if (opts.signal?.aborted) { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e }
      }
    },
  }
  return self
}
const delta = (text) => ({ type: 'text-delta', text })
const think = (text) => ({ type: 'reasoning-delta', text })

console.log('== 1. token 上限：0 = 不传（不设上限），正数 = 透传（向后兼容） ==')
{
  const llm = mkLlm([{ chunks: [delta('{"ok":1}')] }])
  await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm', maxTokens: 0 } }, 'x')
  check('maxTokens=0 → 不传 maxTokens（思考想多久都行）', llm.seen[0].maxTokens === undefined)

  const llm2 = mkLlm([{ chunks: [delta('{"ok":1}')] }])
  await llmStrictJson({ llm: llm2 }, { refiner: { provider: 'p', model: 'm', maxTokens: 2000 } }, 'x')
  check('maxTokens=2000 → 透传（旧配置不受影响）', llm2.seen[0].maxTokens === 2000)

  const llm3 = mkLlm([{ chunks: [delta('{"ok":1}')] }])
  await llmStrictJson({ llm: llm3 }, { refiner: { provider: 'p', model: 'm' } }, 'x')
  check('maxTokens 缺省 → 同样不传（不设上限是默认行为）', llm3.seen[0].maxTokens === undefined)
}

console.log('== 1b. 必须显式清空工具表（否则模型改用 tool_calls，正文为空） ==')
{
  // 根因（2026-09-23 实测对照）：DSH 调用时会带上会话的工具清单，模型看到有工具可用
  // 就改用 tool_calls 而不输出正文——带 tools 时 finish=tool_calls、正文 0 字；
  // 同一请求去掉 tools 后正常输出 265 字。所以提取/归并/汇总都必须传 tools: []。
  const llm = mkLlm([{ chunks: [delta('{"ok":1}')] }])
  await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm' } }, 'x')
  check('提取调用传了 tools: []（关掉工具，逼模型写正文）', Array.isArray(llm.seen[0].tools) && llm.seen[0].tools.length === 0)

  const seen = []
  const ctx = { llm: { async *stream(o) { seen.push(o); yield { type: 'text-delta', text: '{"analysis":"a","items":[]}' } } } }
  await extractWithLlm(ctx, { refiner: { provider: 'p', model: 'm' } }, 'u', 'a')
  check('extractWithLlm 同样清空工具表', Array.isArray(seen[0].tools) && seen[0].tools.length === 0)
}

console.log('== 1c. 必须传 sessionId（缺它上游 400，且表现为"模型没输出正文"） ==')
{
  // 根因（2026-09-23，有代码依据）：dsh-llm-pi-ai 的 opencodeSessionHeaders 只在
  // options.sessionId 存在时才给 opencode* 路由加 x-opencode-session 头；缺了它上游
  // 直接 400 MissingSessionID。而该失败被适配器转成 usage+finish 两块且**不抛错**，
  // 于是插件的表现永远是"模型返回空正文"——查了整整一晚。
  const llm = mkLlm([{ chunks: [delta('{"ok":1}')] }])
  await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm' } }, 'x', undefined, 'session-abc')
  check('sessionId 透传到 stream 调用', llm.seen[0].sessionId === 'session-abc')

  const llm2 = mkLlm([{ chunks: [delta('{"ok":1}')] }])
  await llmStrictJson({ llm: llm2 }, { refiner: { provider: 'p', model: 'm' } }, 'x')
  check('不传时不下发该字段（不污染其他 provider 的调用）', !('sessionId' in llm2.seen[0]))

  const seen = []
  const ctx = { llm: { async *stream(o) { seen.push(o); yield { type: 'text-delta', text: '{"analysis":"a","items":[]}' } } } }
  await extractWithLlm(ctx, { refiner: { provider: 'p', model: 'm' } }, 'u', 'a', { sessionId: 'session-xyz' })
  check('extractWithLlm 同样透传 sessionId', seen[0].sessionId === 'session-xyz')
}

console.log('== 1d. finish=error 必须显式抛错（适配器的"静默失败"形态） ==')
{
  // pi-ai 从不 mid-stream 抛错：失败以 error 事件到达，被转成 error/aborted 的 finish 块。
  // 以前只存了 chunk.reason 却从没读过它，于是"上游 400"看起来就像"模型没输出"。
  const llm = mkLlm([{ chunks: [
    { type: 'usage', usage: {} },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'MissingSessionID', code: 'PI_AI_ERROR' } } },
  ] }])
  let msg = ''
  try { await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm' } }, 'x') } catch (e) { msg = e.message }
  check('抛出带原因的错误（不再是"空正文"）', /MissingSessionID/.test(msg))
  check('错误里带错误码', /PI_AI_ERROR/.test(msg))

  const llm2 = mkLlm([{ chunks: [{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }] }])
  let msg2 = ''
  try { await llmStrictJson({ llm: llm2 }, { refiner: { provider: 'p', model: 'm', maxContinuations: 0 } }, 'x') } catch (e) { msg2 = e.message }
  check('aborted（时间预算掐断）不被当成硬失败——续跑逻辑不受影响', !/适配器判为失败/.test(msg2))
}

console.log('== 2. 思考流（reasoning-delta）不再被丢掉 ==')
{
  const llm = mkLlm([{ chunks: [think('先判断：这轮有决策，值得记……'), delta('{"ok":1}')] }])
  const r = await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm' } }, 'x')
  check('正文正常解析', r.json.ok === 1)
  check('思考字数被记录（meta.reasoningChars）', r.meta.reasoningChars > 0)
}

console.log('== 3. 时间预算掐断 → 带已写内容接着写（断点续思） ==')
{
  const llm = mkLlm([
    { chunks: [delta('{"analysis":"有决策","items":[{"content":"闸值必须对齐')], waitForAbort: true },
    { chunks: [delta('量纲","type":"lesson"}]}')] },
  ])
  const r = await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm', timeBudgetMs: 60, maxContinuations: 3 } }, '原始提问')
  check('掐断后没有被丢弃，续跑把 JSON 补完整', r.json?.items?.[0]?.type === 'lesson')
  check('meta 记录：曾被掐断 + 续跑 1 次', r.meta.timedOut === true && r.meta.continuations === 1)
  check('续跑调用了第二次', llm.calls === 2)
  const contPrompt = llm.seen[1].messages[0].content[0].text
  check('续跑提示带上了已写内容（断点）', contPrompt.includes('闸值必须对齐'))
  check('续跑提示明确要求"接着写"', contPrompt.includes('接着写'))
  check('续跑系统提示是续写器（不是原始 JSON 指令）', llm.seen[1].system.includes('续写'))
}

console.log('== 4. 空输出（思考吃光预算的真实事故形态）→ 续跑救回 ==')
{
  const llm = mkLlm([
    { chunks: [think('这里是很长的思考，把预算吃光了，正文一个字都没写出来')] },
    { chunks: [delta('{"analysis":"补上","items":[{"content":"救回来了"}]}')] },
  ])
  const r = await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm' } }, 'x')
  check('空输出不再直接失败，续跑后拿到正文', r.json?.items?.[0]?.content === '救回来了')
  check('思考仍在（说明确实是"想了但没写"）', r.meta.reasoningChars > 0)
  check('续跑提示点明"想完了没落笔"这个真实形态',
    llm.seen[1].messages[0].content[0].text.includes('正文一个字都没输出') && llm.seen[1].messages[0].content[0].text.includes('JSON 正文'))
}

console.log('== 4b. 正文空但思考里有完整 JSON → 直接捞回（不白跑一轮） ==')
{
  const llm = mkLlm([
    { chunks: [think('判断过程：这轮定了注入步距。\n{"analysis":"有决策","items":[{"content":"注入步距定为 12 步","type":"decision"}]}')] },
  ])
  const r = await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm' } }, 'x')
  check('从思考流里捞回 JSON', r.json?.items?.[0]?.content === '注入步距定为 12 步')
  check('标记为 salvaged（可审计：这条结论是从思考里救回来的）', r.meta.salvaged === true)
  check('只调用了一次（没白跑续跑）', llm.calls === 1)
  check('返回的 text 是思考内容（下游能看到原委）', r.text.includes('判断过程'))

  const llm2 = mkLlm([{ chunks: [think('只是纯粹的思考，没有任何 JSON 结构')] }, { chunks: [delta('{"ok":1}')] }])
  const r2 = await llmStrictJson({ llm: llm2 }, { refiner: { provider: 'p', model: 'm' } }, 'x')
  check('思考里没有 JSON 时不误捞（正常续跑）', r2.meta.salvaged === false && r2.json?.ok === 1)
}

console.log('== 4c. 失败诊断信息要够定位（正文段数/思考字数/其他块/finish） ==')
{
  const llm = mkLlm([{ chunks: [think('想了很久'), { type: 'block-end', block: {} }] }])
  let msg = ''
  try { await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm', maxContinuations: 0 } }, 'x') } catch (e) { msg = e.message }
  check('诊断含正文回包段数', /正文回包 0 段/.test(msg))
  check('诊断含思考字数', /思考 \d+ 字/.test(msg))
  check('诊断含其他块数量（区分"没吐正文"与"映射成了别的类型"）', /其他块 [1-9]d* 个/.test(msg))
}

console.log('== 5. 收敛：模型不肯接话就停，不空转烧配额 ==')
{
  const llm = mkLlm([
    { chunks: [delta('{"items": [')] },
    { chunks: [] }, // 续跑一个字都没写
  ])
  let threw = false
  try { await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm', maxContinuations: 5 } }, 'x') } catch { threw = true }
  check('仍解析不出来 → 抛错（上层降级）', threw)
  check('续跑一次后就停（没有把 5 轮配额烧完）', llm.calls === 2)
}

console.log('== 6. 续跑轮数上限生效 ==')
{
  const llm = mkLlm([{ chunks: [delta('{"items": [')] }])
  let threw = false
  try { await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm', maxContinuations: 2 } }, 'x') } catch { threw = true }
  check('maxContinuations=2 → 最多 1 次首调 + 2 次续跑', threw && llm.calls === 3)
}

console.log('== 7. 跑题（纯叙述）仍走强化重试（v0.9.27 行为不回归） ==')
{
  const llm = mkLlm([
    { chunks: [delta('根据这些记录，用户似乎偏好本地量化模型……')] },
    { chunks: [delta('{"content":"用户偏好本地量化模型","type":"preference"}')] },
  ])
  const r = await llmStrictJson({ llm }, { refiner: { provider: 'p', model: 'm' } }, 'x')
  check('叙述后重试一次拿到 JSON', r.json?.type === 'preference' && llm.calls === 2)
  check('重试用强化 JSON 系统提示', llm.seen[1].system.includes('只输出合法 JSON 本体'))
  check('重试不冒充续写（不把叙述当断点）', !llm.seen[1].messages[0].content[0].text.includes('接着写'))
}

console.log('== 8. 多条目：一轮对话可产出多条，顶层字段兼容旧调用点 ==')
{
  const payload = JSON.stringify({
    analysis: '两个不同性质的东西：定了参数，也纠正了一个偏好',
    items: [
      { content: 'tile_count=6 时显存峰值 7.4GB', type: 'decision', layer: 'sm', keywords: ['tile_count'], abstract: 'event', theme: 'ComfyUI 调优' },
      { content: '用户不接受把过程写进记忆', type: 'profile', layer: 'sm', keywords: ['记忆写法'], aspect: 'preference', abstract: 'principle', theme: '记忆偏好' },
    ],
  })
  const llm = mkLlm([{ chunks: [delta(payload)] }])
  const r = await extractWithLlm({ llm }, { refiner: { provider: 'p', model: 'm' } }, '[用户] a', '[助手] b')
  check('items 返回 2 条', r.items.length === 2)
  check('顶层字段 = 第一条（旧调用点不破）', r.content.includes('tile_count=6') && r.type === 'decision')
  check('analysis 一并带出（判断过程可审计）', r.analysis.includes('纠正了一个偏好'))
  check('第二条 profile 的 aspect 保留', r.items[1].aspect === 'preference')
  check('非 profile 条目不保留 aspect（aspect 只对画像有意义）', r.items[0].aspect === '')

  // 旧格式（v0.11 及以前）兼容
  const llm2 = mkLlm([{ chunks: [delta('{"content":"旧格式","type":"lesson","layer":"sm","keywords":["x"]}')] }])
  const r2 = await extractWithLlm({ llm: llm2 }, { refiner: { provider: 'p', model: 'm' } }, 'u', 'a')
  check('旧格式仍解析（顶层 content → 单条 items）', r2.items.length === 1 && r2.content === '旧格式' && r2.type === 'lesson')

  // 模型判断"不值得记"
  const llm3 = mkLlm([{ chunks: [delta('{"analysis":"只是打招呼，没有信息量","items":[]}')] }])
  const r3 = await extractWithLlm({ llm: llm3 }, { refiner: { provider: 'p', model: 'm' } }, '早上好啊', '早上好～')
  check('items 为空时不写库（content 空 + items 空）', r3.items.length === 0 && r3.content === '')
  check('空条目时 analysis 仍带出（便于查"为什么没记"）', r3.analysis.includes('打招呼'))
}

console.log('== 9. normalizeItems 白名单与上限 ==')
{
  const out = normalizeItems({ items: [
    { content: 'A', type: 'weird', layer: 'ep', keywords: ['k', 42, ''], aspect: 'bad', abstract: 'zzz', theme: 7 },
    { content: 'B', type: 'profile', aspect: 'habit' },
    { content: 'C' }, { content: 'D' }, { content: 'E' },
  ] })
  check('越界 type 回落 note', out[0].type === 'note')
  check('layer=ep 保留', out[0].layer === 'ep')
  check('keywords 过滤非字符串/空串', out[0].keywords.length === 1 && out[0].keywords[0] === 'k')
  check('aspect 非白名单回落空串', out[0].aspect === '')
  check('abstract 越界回落空串', out[0].abstract === '')
  check('theme 非字符串回落空串', out[0].theme === '')
  check('最多 3 条（防一轮炸出十条）', out.length === 3)
  check('profile + habit 正确保留', out[1].type === 'profile' && out[1].aspect === 'habit')
}

console.log('== 10. 价值门：寒暄/空转挡在门外，短偏好必须留下 ==')
{
  check('纯寒暄 + 无输出 → 判定无价值', isTrivialTurn('早上好啊', '(无输出)') === true)
  check('纯确认（继续）→ 判定无价值', isTrivialTurn('继续', '(无输出)') === true)
  check('谢谢 → 判定无价值', isTrivialTurn('谢谢', '') === true)
  check('极短口语（嗯嗯）→ 判定无价值', isTrivialTurn('嗯嗯', '') === true)
  check('无用户消息且无输出 → 无价值', isTrivialTurn('', '(无输出)') === true)
  check('短偏好"不要堆代码" → 必须留下', isTrivialTurn('不要堆代码', '(无输出)') === false)
  check('短纠正"不对，改成 12 步" → 必须留下', isTrivialTurn('不对，改成 12 步', '') === false)
  check('"我认" 之类断言 → 必须留下', isTrivialTurn('我认', '(无输出)') === false)
  check('助手有实质输出 → 不算空转', isTrivialTurn('继续', '好的，已经把注入步距改成 12 了') === false)
  check('长用户消息 → 不按寒暄处理', isTrivialTurn('这里是一段很长的说明，讲了很多要求，超过四十个字符的判断阈值，需要认真对待', '(无输出)') === false)
}

console.log('== 11. 关键词兜底：泛词/虚词不再进库 ==')
{
  const kw = pickKeywords('现在这个用户的问题是什么，我们需要把 tile_count 从 4 改成 6，重叠 overlap 降到 0.2，显存峰值降到 7.4GB')
  check('口语虚词被滤掉（现在/这个/用户/什么/问题）', !kw.some((k) => ['现在', '这个', '用户', '什么', '问题', '需要'].includes(k)))
  check('保留具体实体', kw.includes('tile_count') && kw.includes('overlap'))
  check('数量有上限（默认 8）', pickKeywords('a1 b2 c3 d4 e5 f6 g7 h8 i9 j10', 8).length <= 8)
  check('纯数字碎片被滤掉', !pickKeywords('1234 5.6% 7').includes('1234'))
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
