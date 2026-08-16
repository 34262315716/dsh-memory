// 防崩溃容错实测：mock ctx 驱动 apply()，验证 4 个失败场景不致命
// 用法: node test-crash-safety.mjs
import { apply } from './lib/index.js'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) } }

/** 构造 mock ctx：settings 可配置抛错；tools 对指定工具名抛错；on 收集事件；inject 立即回调。 */
function makeCtx({ settingsThrow = false, failTool = null, dbFile } = {}) {
  const registeredTools = []
  const events = {}
  const scopeMock = {
    get: () => ({ enabled: true, features: { autoWrite: true, valueGate: true, dedupMerge: true, preStepInject: true, manageTools: true, time: true, graph: true }, embedding: { provider: 'rule' }, refiner: { enabled: false }, reranker: { enabled: false }, housekeeping: { enabled: true }, dbFile }),
  }
  return {
    settings: {
      register: () => {
        if (settingsThrow) throw new Error('settings 注册失败（模拟）')
        return scopeMock
      },
    },
    tools: {
      register: (tool) => {
        if (failTool && tool?.name === failTool) throw new Error(`schema 非法（模拟 ${tool.name}）`)
        registeredTools.push(tool?.name)
      },
    },
    on: (ev, fn) => { events[ev] = fn },
    provide: (_name, _value) => {},   // ctx.memory 门面注册
    inject: (_names, cb) => {
      // 模拟 host 注入：webServer.register 立即返回 dispose
      const host = { webServer: { register: () => () => {} } }
      host.effect = (fn) => fn()
      cb(host)
    },
    llm: { stream: async () => { throw new Error('no llm') } },
    _registeredTools: registeredTools,
    _events: events,
  }
}

const baseCfg = (dbFile) => ({
  enabled: true,
  features: { autoWrite: true, valueGate: true, dedupMerge: true, preStepInject: true, manageTools: true, time: true, graph: true },
  embedding: { provider: 'rule' },
  refiner: { enabled: false },
  reranker: { enabled: false },
  housekeeping: { enabled: true },
  dbFile,
})

console.log('== A. settings 注册失败 → 配置兜底，不 throw ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crash-a-'))
  const ctx = makeCtx({ settingsThrow: true, dbFile: join(dir, 't.db') })
  let threw = false
  try { await apply(ctx, baseCfg(join(dir, 't.db'))) } catch (e) { threw = true; console.log('  ❌ 抛错: ' + e.message) }
  check('settings 失败不抛错（兜底 config 继续初始化）', !threw)
  check('store 初始化成功（工具已注册）', ctx._registeredTools.length > 5)
  ctx._events['dispose']?.()
  rmSync(dir, { recursive: true, force: true })
}

console.log('== B. 库文件不可打开（dbFile 指向目录）→ 记忆停用，不 throw ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crash-b-'))
  const badDir = join(dir, 'not-a-file')   // 不存在且父目录是目录名 → DatabaseSync 打开失败
  mkdirSync(badDir)
  const ctx = makeCtx({ dbFile: badDir })
  let threw = false
  try { await apply(ctx, baseCfg(badDir)) } catch (e) { threw = true; console.log('  ❌ 抛错: ' + e.message) }
  check('坏库路径不抛错（记忆功能停用，dsh 存活）', !threw)
  check('坏库路径下工具不注册（功能停用）', ctx._registeredTools.length === 0)
  ctx._events['dispose']?.()
  rmSync(dir, { recursive: true, force: true })
}

console.log('== C. 单个工具 schema 非法 → 只跳过该工具 ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crash-c-'))
  const ctx = makeCtx({ failTool: 'memory_stats', dbFile: join(dir, 't.db') })
  let threw = false
  try { await apply(ctx, baseCfg(join(dir, 't.db'))) } catch (e) { threw = true }
  check('单个工具失败不抛错', !threw)
  check('失败工具被跳过', !ctx._registeredTools.includes('memory_stats'))
  check('其余工具正常注册', ctx._registeredTools.length > 10 && ctx._registeredTools.includes('memory_add') && ctx._registeredTools.includes('memory_housekeeping'))
  ctx._events['dispose']?.()
  rmSync(dir, { recursive: true, force: true })
}

console.log('== D. 正常路径：全部工具注册 + 事件监听挂载 ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crash-d-'))
  const ctx = makeCtx({ dbFile: join(dir, 't.db') })
  let threw = false
  try { await apply(ctx, baseCfg(join(dir, 't.db'))) } catch (e) { threw = true; console.log('  ❌ 抛错: ' + e.message) }
  check('正常路径不抛错', !threw)
  const expected = ['system_now', 'memory_add', 'memory_search', 'memory_forget', 'memory_list', 'memory_stats', 'memory_merge', 'memory_purge', 'memory_housekeeping', 'memory_graph_neighbors', 'memory_graph_path', 'memory_graph_link', 'memory_graph_unlink', 'memory_graph_node', 'memory_graph_communities', 'memory_versions', 'memory_rollback', 'memory_reembed']
  const missing = expected.filter((n) => !ctx._registeredTools.includes(n))
  check(`全部 ${expected.length} 个工具注册（缺: ${missing.join(',') || '无'}）`, missing.length === 0)
  check('事件监听挂载（session/event + pre-step + session-start）', Boolean(ctx._events['session/event']) && Boolean(ctx._events['agent/pre-step']) && Boolean(ctx._events['agent/session-start']))
  ctx._events['dispose']?.()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
