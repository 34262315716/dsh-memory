/**
 * LLM 蒸馏提取（原 lib/index.js extractWithLlm，v0.10 拆分独立）。
 */
import { truncate } from './util.js'
import { tokenize } from './store.js'

/**
 * LLM 严格 JSON 输出（共享给自动沉淀提取与画像蒸馏）。
 *
 * - 透传 `reasoningEffort`（默认配置 off=关思维链，防推理吞 maxTokens——v0.9.25）
 * - markdown fence 剥除后 JSON.parse
 * - 首次输出非 JSON（部分模型在关推理后爱写叙述而非 JSON）→ 用强化指令
 *   「只输出 JSON 本体 + 附上上次解析错误」重试一次；仍失败才抛错（v0.9.27）
 *
 * @param ctx 宿主上下文（ctx.llm.stream）
 * @param cfg 完整插件配置（读 cfg.refiner.provider/model/reasoningEffort/maxTokens）
 * @param prompt 用户侧提示（内含任务与数据）
 * @param system 系统提示（默认严格 JSON）
 * @returns {Promise<{ text: string, json: any }>} 成功解析的文本与 JSON
 */
export async function llmStrictJson(ctx, cfg, prompt, system = '你是严格的 JSON 输出器，只输出合法 JSON。') {
  const ref = cfg.refiner ?? {}
  const effort = ref.reasoningEffort
  const call = async (sys, extra) => {
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: ref.provider,
      model: ref.model,
      ...(effort ? { reasoningEffort: effort } : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text: extra ? `${prompt}\n\n${extra}` : prompt }] }],
      system: sys,
      maxTokens: ref.maxTokens,
    })) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
    }
    return chunks.join('').trim()
  }
  const parse = (text) => {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    return JSON.parse((fence ? fence[1] : text).trim())
  }
  const text = await call(system)
  try {
    return { text, json: parse(text) }
  } catch (err) {
    // 跑题重试一次：附上解析错误让模型知道问题所在
    const retry = await call(
      '你只输出合法 JSON 本体。任何解释、前言、后语、散文、列表或代码块标记都会导致输出被整体丢弃。',
      `你上一次的输出不是合法 JSON（错误: ${err.message.slice(0, 160)}）。请重新输出，只给 JSON 本体。`,
    )
    return { text: retry, json: parse(retry) }
  }
}

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
6. keywords：3-8 个**具体名词实体**（技术栈/模块名/类名/文件名/版本号/专有名词），用于检索与图谱实体。
   **禁止**：完成/修复/实现/使用/优化/更新 等动作泛词；禁止 本项目名/记忆系统/图谱/插件/DSH 等话题词；禁止 2 字碎片词。
   宁可 3 个精准实体，也不要 10 个泛词
7. 没有值得记的内容时输出 {"content": ""}

输出严格 JSON（无其他文字、无 markdown 围栏）：
{"content": "...", "type": "decision", "layer": "sm", "keywords": ["..."], "aspect": ""}

对话：
[用户]
${truncate(userPart, 4000)}

[助手]
${truncate(assistantPart, 4000)}`

  const { json: parsed } = await llmStrictJson(ctx, cfg, prompt)
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
