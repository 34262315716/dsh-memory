// 阶段四（v0.9.2）：画像分类专项——预热画像取用 / aspect 读写 / 画像蒸馏（mock LLM）
// 用法: node test-profile.mjs（需在部署副本或 harness 环境运行，依赖 @deepseek-ai 包）
import { apply, scopeOf } from './lib/index.js'
import { MemoryStore } from './lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) } }

console.log('== 0. scopeOf：cwd 优先 + workspaceRegistry fallback（v0.9.5） ==')
check('有 cwd 用 basename', scopeOf({ meta: { cwd: 'D:\\proj\\mecha' } }) === 'mecha')
check('无 cwd 回落 global', scopeOf({ id: 's1' }) === 'global')
const registry = { list: () => [{ path: 'D:/work/dsh-memory', sessionIds: ['s1'] }, { path: 'D:/work/mecha', sessionIds: ['s2'] }] }
check('无 cwd 走 workspaceRegistry 命中', scopeOf({ id: 's1' }, registry) === 'dsh-memory')
check('registry 无此会话回落 global', scopeOf({ id: 's9' }, registry) === 'global')

console.log('== 1. 预热画像取用：list type 过滤不受"最近 50 条"窗口挤压 ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prof0-'))
  const s = new MemoryStore(join(dir, 't.db'), {})
  // 60 条普通记忆（把画像挤出最近 50 窗口）+ 3 条画像（created_at 更早）
  for (let i = 0; i < 60; i++) await s.add({ layer: 'sm', type: 'note', scope: 'test', content: `普通记忆 ${i}`, keywords: ['n'] })
  const p1 = await s.add({ layer: 'sm', type: 'profile', scope: 'test', content: '画像一：用户偏好 A', keywords: ['pa'], aspect: 'preference' })
  const p2 = await s.add({ layer: 'sm', type: 'profile', scope: 'test', content: '画像二：用户背景 B', keywords: ['pb'], aspect: 'background' })
  // 画像更新时间为 30 天前（模拟长期稳定画像沉底）
  s.db.prepare('UPDATE memories SET updated_at = ? WHERE id IN (?, ?)').run(Date.now() - 30 * 24 * 3600 * 1000, p1, p2)
  const profiles = s.list({ layer: 'sm', type: 'profile', limit: 3 })
  check('type 过滤直取画像（不受窗口挤压）', profiles.length === 2 && profiles.every((m) => m.type === 'profile'))
  const window50 = s.list({ layer: 'sm', limit: 50 })
  check('画像确实沉出最近 50 窗口（修复前画像优先失效的场景）', !window50.some((m) => m.type === 'profile'))
  s.close(); rmSync(dir, { recursive: true, force: true })
}

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
  // 幂等：第二次蒸馏——源记忆已记录在 meta → 无候选 → 空结果
  const out2 = await distill.execute({ limit: 5 })
  check('重复蒸馏幂等（已蒸馏源跳过，返回空）', out2.profiles.length === 0)
  const s2 = new MemoryStore(dbFile, {})
  check('幂等后画像不重复累积', s2.list({ layer: 'sm', type: 'profile', limit: 20 }).length === 2)
  s1.close(); s2.close(); disposeFn?.(); rmSync(dir, { recursive: true, force: true })
}

console.log('== 4. 坏 JSON 容错（与 auto-write 降级路径一致） ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prof3-'))
  const dbFile = join(dir, 't.db')
  const s0 = new MemoryStore(dbFile, {})
  await s0.add({ layer: 'sm', type: 'preference', scope: 'test', content: '用户偏好坏JSON测试', keywords: ['坏'] })
  s0.close()
  const registeredTools = []
  let disposeFn = null
  const badLlm = { stream: async function* () { yield { type: 'text-delta', text: '这不是JSON{{{bad' } } }
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
    llm: badLlm,
  }
  await apply(ctx, { enabled: true, features: { autoWrite: true, valueGate: true, dedupMerge: true, preStepInject: true, manageTools: true, time: true, graph: true }, embedding: { provider: 'rule' }, refiner: { enabled: true }, reranker: { enabled: false }, housekeeping: { enabled: false }, dbFile })
  const distill = registeredTools.find((t) => t.name === 'memory_profile_distill')
  let threw = false
  let out = null
  try { out = await distill.execute({ limit: 5 }) } catch { threw = true }
  check('坏 JSON 不抛错（返回空结果）', !threw && out.profiles.length === 0)
  disposeFn?.(); rmSync(dir, { recursive: true, force: true })
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
