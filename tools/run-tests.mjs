/**
 * 全量测试入口（v0.19.0）。
 *
 * 发现 tests/ 下的 test-*.mjs（含 test.mjs），逐个用当前 Node 跑，汇总结果。
 * 用法：
 *   node tools/run-tests.mjs            # 全部（需要 @deepseek-ai peer 包）
 *   node tools/run-tests.mjs --offline  # 只跑不依赖私有 peer 包的套件
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const testsDir = join(root, 'tests')
const offline = process.argv.includes('--offline')

// 需要 @deepseek-ai 私有 peer 包的套件：直接或间接到 lib/tools（tools 依赖 dsh-tools）。
const NEEDS_PEER = new Set([
  'test.mjs',
  'test-inject-pipeline.mjs',
  'test-profile.mjs',
  'test-tool-add.mjs',
  'test-crash-safety.mjs',
  'test-governance.mjs',
  'test-rewrite.mjs',
])

const files = readdirSync(testsDir)
  .filter((f) => f === 'test.mjs' || /^test-.*\.mjs$/.test(f))
  .sort()
  .filter((f) => !(offline && NEEDS_PEER.has(f)))

let pass = 0
let fail = 0
const failed = []
for (const file of files) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [join(testsDir, file)], { cwd: root, encoding: 'utf8' })
  const ms = Date.now() - t0
  if (r.status === 0) {
    pass++
    console.log(`✅ ${file}（${ms}ms）`)
  } else {
    fail++
    failed.push(file)
    const tail = ((r.stdout ?? '') + (r.stderr ?? '')).split('\n').slice(-8).join('\n')
    console.log(`❌ ${file}（exit ${r.status}，${ms}ms）\n${tail}`)
  }
}
console.log(`\n结果: ${pass} 套通过, ${fail} 套失败${failed.length ? ' → ' + failed.join(', ') : ''}`)
process.exit(fail === 0 ? 0 : 1)
