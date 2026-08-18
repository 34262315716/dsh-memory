/**
 * LLM 蒸馏提取（原 lib/index.js extractWithLlm，v0.10 拆分独立）。
 */
import { truncate } from './util.js'
import { tokenize } from './store.js'

/**
 * LLM 蒸馏提取：用独立配置的模型从一轮会话中提炼有效记忆（去噪、自包含）。
 * 输出严格 JSON：{ content, type, layer, keywords }。
 * @returns {Promise<{content: string, type: string, layer: string, keywords: string[]}>}
 */
export async function extractWithLlm(ctx, cfg, userPart, assistantPart) {
  const prompt = `你是记忆提取器。从以下一轮对话中提取值得长期记忆的信息。

规则：
1. 只提取有价值内容：决策、结论、偏好、教训、关键事实；忽略寒暄、过程噪音、工具中间输出
2. content 用简洁、自包含的一句话或段落，不包含"用户说/助手说"等元信息
3. type ∈ note | decision | preference | lesson | profile
   - profile = 关于用户本人的稳定信息（身份/习惯/长期偏好/沟通方式/背景），
     例如"用户偏好 X""用户习惯 Y""用户是 Z 背景"——与一次性决策（decision）区分
4. aspect ∈ identity | preference | habit | background | communication_style
   （仅 type=profile 时填写；其他类型填空字符串）
5. layer ∈ sm（长期语义知识）| ep（一次性情景快照）
6. keywords：3-10 个关键词（中英文均可，用于检索）
7. 没有值得记的内容时输出 {"content": ""}

输出严格 JSON（无其他文字、无 markdown 围栏）：
{"content": "...", "type": "decision", "layer": "sm", "keywords": ["..."], "aspect": ""}

对话：
[用户]
${truncate(userPart, 4000)}

[助手]
${truncate(assistantPart, 4000)}`

  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: cfg.refiner.provider,
    model: cfg.refiner.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    system: '你是严格的 JSON 输出器，只输出合法 JSON。',
    maxTokens: cfg.refiner.maxTokens,
  })) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
  }
  const text = chunks.join('').trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = (fence ? fence[1] : text).trim()
  const parsed = JSON.parse(jsonText)
  if (typeof parsed?.content !== 'string') throw new Error('LLM 输出缺少 content')
  const types = ['note', 'decision', 'preference', 'lesson', 'profile']
  const aspects = ['identity', 'preference', 'habit', 'background', 'communication_style']
  const type = types.includes(parsed.type) ? parsed.type : 'note'
  return {
    content: parsed.content,
    type,
    layer: parsed.layer === 'ep' ? 'ep' : 'sm',
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k) => typeof k === 'string').slice(0, 40) : [],
    aspect: type === 'profile' && aspects.includes(parsed.aspect) ? parsed.aspect : '',
  }
}
