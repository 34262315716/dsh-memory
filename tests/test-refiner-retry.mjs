/**
 * v0.16.1 瞬时故障重试专项。
 *
 * 背景（2026-10-12 线上实测）：提取切到官方路由（deepseek-official）后批量失败——
 * 一天 0 成功 / 16 失败，其中 30 次是 `event precedes message_start`
 * （上游 SSE 流在 message_start 之前就发了内容块，见 dsh-llm-deepseek/lib/index.js:1937）。
 * 插件原本对**任何**适配器失败都是**一次就整条丢弃**，而丢弃不可逆——这段对话永远不进库。
 *
 * 本套件钉住三件事：
 *   ① 瞬时类错误（流畸形 / 网络 / 5xx）必须自动重发
 *   ② 配额与请求格式类错误**不许**重发（429 要等额度、400 是确定性失败，重发只烧配额与时间）
 *   ③ 重试用尽后仍抛错（不能把失败吞成"成功但内容为空"），且取消时立即停手
 */
import { llmStrictJson, isTransientAdapterError, transientBackoffMs } from '../lib/refiner.js'

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) }
}

const delta = (text) => ({ type: 'text-delta', text })

/** 假 LLM：前 N 次抛指定错误，之后吐 JSON。 */
function mkFlakyLlm(failTimes, errFactory) {
  const self = {
    calls: 0,
    async *stream() {
      const i = self.calls++
      if (i < failTimes) throw errFactory(i)
      yield delta('{"analysis":"恢复成功","items":[]}')
    },
  }
  return self
}

/** 假 LLM：前 N 次用 finish 块报错（适配器的另一种失败形态），之后吐 JSON。 */
function mkFinishErrLlm(failTimes, failure) {
  const self = {
    calls: 0,
    async *stream() {
      const i = self.calls++
      if (i < failTimes) {
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      yield delta('{"analysis":"恢复成功","items":[]}')
    },
  }
  return self
}

/** 让退避等待不拖慢测试：退避基数设为 0。 */
const FAST = { provider: 'p', model: 'm', transientBackoffMs: 0 }

console.log('== 1. 瞬时类判定：该重发的 ==')
{
  const transient = [
    '提取调用被适配器判为失败：DeepSeek Messages stream: event precedes message_start（MALFORMED_RESPONSE）',
    '提取调用被适配器判为失败：DeepSeek Messages transport failed（TRANSPORT）',
    '提取调用被适配器判为失败：terminated（TRANSPORT）',
    '提取调用被适配器判为失败：Connection error.（TRANSPORT）',
    '提取调用被适配器判为失败：socket hang up',
    '提取调用被适配器判为失败：502 "acp-proxy failure"（SERVER）',
  ]
  for (const m of transient) check(`瞬时：${m.slice(-46)}`, isTransientAdapterError(new Error(m)) === true)

  const permanent = [
    '提取调用被适配器判为失败：429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}（QUOTA）',
    'format v4 message requires a producer-owned source kind',
    'DeepSeek Messages does not support reasoning effort high（UNSUPPORTED_REASONING_EFFORT）',
    '提取调用被适配器判为失败：400 invalid request（INVALID_REQUEST）',
  ]
  for (const m of permanent) check(`不重发：${m.slice(-40)}`, isTransientAdapterError(new Error(m)) === false)

  check('空错误 → 不重发（不猜）', isTransientAdapterError(new Error('')) === false && isTransientAdapterError(null) === false)
}

console.log('== 2. 退避时长：指数增长且封顶 8 秒 ==')
{
  check('第 1 次退避 = 基数', transientBackoffMs(0, 800) === 800)
  check('第 2 次翻倍', transientBackoffMs(1, 800) === 1600)
  check('第 3 次再翻倍', transientBackoffMs(2, 800) === 3200)
  check('封顶 8 秒（不会无限涨）', transientBackoffMs(10, 800) === 8000)
  check('基数为 0 时退避也是 0（测试与"不等待"配置可用）', transientBackoffMs(3, 0) === 0)
}

console.log('== 3. 抛错型瞬时失败：自动重发并成功 ==')
{
  const llm = mkFlakyLlm(2, () => new Error('提取调用被适配器判为失败：DeepSeek Messages stream: event precedes message_start（MALFORMED_RESPONSE）'))
  const out = await llmStrictJson({ llm }, { refiner: { ...FAST } }, 'x')
  check('重发后拿到 JSON（不再整条丢弃）', out?.json?.analysis === '恢复成功')
  check('一共发了 3 次请求（首调 + 2 次重试）', llm.calls === 3)
  check('meta.transientRetries 记为 2', out?.meta?.transientRetries === 2)
  check('meta.transientErrors 留痕（可审计）', Array.isArray(out?.meta?.transientErrors) && out.meta.transientErrors.length === 2)
}

console.log('== 4. finish 块型瞬时失败：同样自动重发 ==')
{
  // 适配器的失败**不在中途抛异常**，而是编码进 finish 块——这条路径必须一并覆盖
  const llm = mkFinishErrLlm(1, { message: 'event precedes message_start', code: 'MALFORMED_RESPONSE' })
  const out = await llmStrictJson({ llm }, { refiner: { ...FAST } }, 'x')
  check('finish 块报错也重发并恢复', out?.json?.analysis === '恢复成功')
  check('发了 2 次请求', llm.calls === 2)
}

console.log('== 5. 不可重发类：一次就抛（不白烧配额） ==')
{
  const llm = mkFlakyLlm(9, () => new Error('提取调用被适配器判为失败：429: Go usage limit exceeded（QUOTA）'))
  try {
    await llmStrictJson({ llm }, { refiner: { ...FAST } }, 'x')
    check('配额错应当抛错', false)
  } catch (err) {
    check('配额错抛出（不重发）', err.message.includes('429') || err.message.includes('QUOTA'))
    check('只发了 1 次请求（没有白烧配额）', llm.calls === 1)
  }

  const llm2 = mkFlakyLlm(9, () => new Error('format v4 message requires a producer-owned source kind'))
  try {
    await llmStrictJson({ llm: llm2 }, { refiner: { ...FAST } }, 'x')
    check('格式错应当抛错', false)
  } catch {
    check('格式错只发 1 次（确定性失败不重发）', llm2.calls === 1)
  }
}

console.log('== 6. 重试用尽：仍然抛错（不把失败吞成空成功） ==')
{
  const llm = mkFlakyLlm(99, () => new Error('提取调用被适配器判为失败：terminated（TRANSPORT）'))
  try {
    await llmStrictJson({ llm }, { refiner: { ...FAST, transientRetries: 2 } }, 'x')
    check('应当抛错', false)
  } catch (err) {
    check('重试用尽后抛错', err.message.includes('terminated'))
    check('总共发了 3 次（1 + 2 重试）', llm.calls === 3)
  }

  // transientRetries: 0 = 回到 v0.16.0 的一次性行为（保留逃生阀）
  const llm0 = mkFlakyLlm(99, () => new Error('提取调用被适配器判为失败：terminated（TRANSPORT）'))
  try {
    await llmStrictJson({ llm: llm0 }, { refiner: { ...FAST, transientRetries: 0 } }, 'x')
    check('应当抛错', false)
  } catch {
    check('transientRetries=0 → 只发 1 次（旧行为可复现）', llm0.calls === 1)
  }
}

console.log('== 7. 正常路径不受影响 ==')
{
  const llm = mkFlakyLlm(0, () => new Error('不该发生'))
  const out = await llmStrictJson({ llm }, { refiner: { ...FAST } }, 'x')
  check('一次成功、不重发', llm.calls === 1 && out?.json?.analysis === '恢复成功')
  check('没有 transientRetries 记录', out?.meta?.transientRetries === undefined)
}

console.log('== 8. 重试路径绝不能碰 ctx 的受限属性（v0.16.1 自造事故） ==')
{
  /**
   * 2026-10-14 16:37 事故：我在重试循环里写了 `ctx?.signal?.aborted` 想感知取消，
   * 而 cordis 的 ctx 是**受限代理**——访问未声明属性直接抛
   * `cannot get property "signal" without inject`。后果是**每次走到重试就抛错**，
   * 重试功能等于没有，还往 write.fallback 里记了一条误导性的错误。
   *
   * 这个用例用**同构的假 ctx**（任何未声明属性访问都抛错）跑一遍完整重试路径：
   * 若将来有人在重试循环里再碰 ctx 的别的属性，这里会直接红。
   */
  /**
   * 造一个"只认声明过的服务、其余一律抛错"的假 ctx——与 cordis 受限代理的行为同构。
   * 注意服务值放在**闭包变量**里，不能挂回被代理对象（那样读取时又会触发抛错，是测试自身的坑）。
   */
  const makeStrictCtx = (services) => new Proxy({}, {
    get(_t, key) {
      if (typeof key === 'symbol') return undefined
      if (!(key in services)) throw new Error(`cannot get property "${String(key)}" without inject`)
      return services[key]
    },
  })

  // 先确认这个假 ctx 本身是"真严格"的——否则整个用例是空转（仪器必须能报错才可信）
  let probeThrew = false
  try { void makeStrictCtx({}).undefinedService } catch { probeThrew = true }
  check('假 ctx 本身够严格（未声明属性确实抛错）', probeThrew)

  // 抛错型瞬时失败 + 严格 ctx：重试循环必须正常走完，不能因碰 ctx 而变成 inject 错
  const ctx = makeStrictCtx({
    llm: { async *stream() { throw new Error('提取调用被适配器判为失败：terminated（TRANSPORT）') } },
  })
  let threw = null
  try {
    await llmStrictJson(ctx, { refiner: { ...FAST, transientRetries: 1 } }, 'x')
  } catch (err) {
    threw = err
  }
  check('重试路径不因访问 ctx 受限属性而抛 inject 错', !String(threw?.message ?? '').includes('without inject'))
  check('抛出的是上游那个错误（说明重试循环正常走完）', String(threw?.message ?? '').includes('terminated'))

  // 成功路径同样不能碰 ctx 的受限属性
  const ctx2 = makeStrictCtx({
    llm: { async *stream() { yield delta('{"analysis":"ok","items":[]}') } },
  })
  let ok = null
  try { ok = await llmStrictJson(ctx2, { refiner: { ...FAST } }, 'x') } catch { /* 交给断言 */ }
  check('成功路径也不碰 ctx 受限属性', ok?.json?.analysis === 'ok')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exitCode = 1
