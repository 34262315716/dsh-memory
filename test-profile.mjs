// 阶段四（v0.9.2）：画像分类专项——预热画像优先 / aspect 读写 / 画像蒸馏（mock LLM）
// 用法: node test-profile.mjs（需在部署副本或 harness 环境运行，依赖 @deepseek-ai 包）
import { apply, pickPreheatSeeds } from './lib/index.js'
import { MemoryStore } from './lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) } }

console.log('== 1. 预热 seed：画像优先（画像 3 + 非画像 2，画像在前） ==')
const sm = [
  { type: 'decision', content: 'd1' },
  { type: 'profile', content: 'p1' },
  { type: 'note', content: 'n1' },
  { type: 'profile', content: 'p2' },
  { type: 'preference', content: 'pr1' },
  { type: 'profile', content: 'p3' },
  { type: 'profile', content: 'p4' },
]
const seeds = pickPreheatSeeds(sm)
check('种子数 = 5（画像 3 + 非画像 2）', seeds.length === 5)
check('画像在前（前 3 条全是 profile）', seeds.slice(0, 3).every((s) => s.type === 'profile'))
check('画像取最近 3 条（p4 溢出被截）', seeds.slice(0, 3).map((s) => s.content).join(',') === 'p1,p2,p3')
check('非画像取 2 条', seeds.slice(3).length === 2 && seeds.slice(3).every((s) => s.type !== 'profile'))
check('空列表安全', pickPreheatSeeds([]).length === 0)

console.log('== 2. aspect 读写（store 层） ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prof-'))
  const s = new MemoryStore(join(dir, 't.db'), {})
  const p = await s.add({ layer: 'sm', type: 'profile', scope: 'test', content: '用户偏好 SQLite', keywords: ['sqlite'], aspect: 'preference' })
  const n = await s.add({ layer: 'sm', type: 'note', scope: 'test', content: '普通笔记', keywords: ['note'] })
  check('profile+aspect 写入并读回', s.get(p).profile_aspect === 'preference' && s.get(p).type === 'profile')
  check('非 profile 无 aspect（空串）', s.get(n).profile_aspect === '')
  s.close(); rmSync(dir, { recursive: true, force: true })
}

console.log('== 3. 画像蒸馏（mock LLM 返回画像 JSON） ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prof2-'))
  const dbFile = join(dir, 't.db')
  // 先铺 2 条源记忆（preference/decision）
  const s0 = new MemoryStore(dbFile, {})
  await s0.add({ layer: 'sm', type: 'preference', scope: 'test', content: '用户偏好自建端点', keywords: ['端点'] })
  await s0.add({ layer: 'sm', type: 'decision', scope: 'test', content: '用户决定密钥走凭据文件', keywords: ['密钥'] })
  s0.close()

  const registeredTools = []
  let disposeFn = null
  const mockLlm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"items": [{"content": "用户偏好自建端点与密钥走凭据文件", "aspect": "preference"}, {"content": "用户是深度插件开发爱好者", "aspect": "background"}]}' }
    },
  }
  const scopeMock = {
    get: () => ({
      enabled: true,
      features: { autoWrite: true, valueGate: true, dedupMerge: true, preStepInject: true, manageTools: true, time: true, graph: true },
      embedding: { provider: 'rule' },
      refiner: { enabled: true, provider: 'mock', model: 'mock', maxTokens: 800 },
      reranker: { enabled: false },
      housekeeping: { enabled: false },
      dbFile,
    }),
  }
  const ctx = {
    settings: { register: () => scopeMock },
    tools: { register: (tool) => { registeredTools.push(tool) } },
    on: (ev, fn) => { if (ev === 'dispose') disposeFn = fn },
    provide: () => {},
    inject: (_names, cb) => { const host = { webServer: { register: () => () => {} } }; host.effect = (fn) => fn(); cb(host) },
    llm: mockLlm,
  }
  await apply(ctx, { enabled: true, features: { autoWrite: true, valueGate: true, dedupMerge: true, preStepInject: true, manageTools: true, time: true, graph: true }, embedding: { provider: 'rule' }, refiner: { enabled: true }, reranker: { enabled: false }, housekeeping: { enabled: false }, dbFile })
  const distill = registeredTools.find((t) => t.name === 'memory_profile_distill')
  check('memory_profile_distill 工具已注册', Boolean(distill))
  const out = await distill.execute({ limit: 5 })
  check('蒸馏返回 2 条画像', out.profiles.length === 2)
  check('画像 aspect 正确', out.profiles[0].aspect === 'preference' && out.profiles[1].aspect === 'background')
  const s1 = new MemoryStore(dbFile, {})
  const profs = s1.list({ layer: 'sm', limit: 20 }).filter((m) => m.type === 'profile')
  check('画像已写入库（type=profile）', profs.length === 2)
  const prefer = profs.find((m) => m.profile_aspect === 'preference')
  check('写入的画像 aspect 持久化', prefer && prefer.content.includes('自建端点'))
  s1.close(); disposeFn?.(); rmSync(dir, { recursive: true, force: true })
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
