#!/usr/bin/env node
/**
 * 改动后的收尾检查（v0.19.0）。
 *
 * 一条命令做四件事：
 *   1. 语法检查（lib/**、tools/、根目录脚本）
 *   2. 全量测试（tools/run-tests.mjs；--offline 跳过需要私有 peer 包的套件）
 *   3. 文档/版本一致性（package / CHANGELOG / README / ARCHITECTURE、工具清单、本机绝对路径）
 *   4. 生产库体检（只读：规模、归档、簇、单成员簇、WAL、索引）
 *
 * 用法：
 *   node tools/check.mjs
 *   node tools/check.mjs --offline --no-test
 *   node tools/check.mjs --db <path>
 * 退出码：有 FAIL 返回 1；只有 WARN 返回 0。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const offline = args.includes('--offline')
const noTest = args.includes('--no-test')
const dbIdx = args.indexOf('--db')
const dbFile = dbIdx >= 0 ? args[dbIdx + 1] : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memory.db')

let pass = 0, warn = 0, fail = 0
const ok = (name, detail = '') => { pass++; console.log(`  ✅ ${name}${detail ? '：' + detail : ''}`) }
const wa = (name, detail = '') => { warn++; console.log(`  ⚠️  ${name}${detail ? '：' + detail : ''}`) }
const no = (name, detail = '') => { fail++; console.log(`  ❌ ${name}${detail ? '：' + detail : ''}`) }
const read = (p) => readFileSync(join(root, p), 'utf8')

console.log('== 1. 语法检查 ==')
function walkJs(dir) {
  const out = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'node_modules' || d.name === '.git') continue
    const full = join(dir, d.name)
    if (d.isDirectory()) out.push(...walkJs(full))
    else if (d.name.endsWith('.js') || d.name.endsWith('.mjs')) out.push(full)
  }
  return out
}
const sources = [...walkJs(join(root, 'lib')), ...walkJs(join(root, 'tools')),
  join(root, 'build-client.mjs'), join(root, 'rebuild-graph.mjs')]
let syntaxBad = 0
for (const file of sources) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (r.status !== 0) { syntaxBad++; no('语法', relative(root, file)) }
}
if (syntaxBad === 0) ok('语法', `${sources.length} 个文件`)

console.log('== 2. 测试 ==')
if (noTest) {
  wa('测试', '--no-test 跳过')
} else {
  const r = spawnSync(process.execPath, [join(root, 'tools', 'run-tests.mjs')].concat(offline ? ['--offline'] : []), {
    cwd: root, encoding: 'utf8',
  })
  const tail = ((r.stdout ?? '') + (r.stderr ?? '')).trim().split('\n').slice(-1)[0]
  if (r.status === 0) ok('测试', tail)
  else no('测试', tail || `exit ${r.status}`)
}

console.log('== 3. 文档与版本一致性 ==')
const pkg = JSON.parse(read('package.json'))
const changelog = read('docs/CHANGELOG.md')
const changelogVer = changelog.match(/^## v(\d+\.\d+\.\d+)/m)?.[1]
const arch = read('docs/ARCHITECTURE.md').match(/对应 \*\*v(\d+\.\d+\.\d+)\*\*/)?.[1]
const readme = read('README.md')
const readmeArch = readme.match(/\*\*v(\d+\.\d+\.\d+)，按主题分/)?.[1]
const readmeStruct = readme.match(/### 模块结构（v(\d+\.\d+\.\d+)）/)?.[1]
if (changelogVer === pkg.version) ok('CHANGELOG 版本', pkg.version)
else no('CHANGELOG 版本', `package=${pkg.version} changelog=${changelogVer}`)
if (arch === pkg.version) ok('ARCHITECTURE 版本', pkg.version)
else no('ARCHITECTURE 版本', `package=${pkg.version} doc=${arch}`)
if (readmeArch === pkg.version && readmeStruct === pkg.version) ok('README 版本', pkg.version)
else no('README 版本', `package=${pkg.version} arch=${readmeArch} struct=${readmeStruct}`)

const toolNames = new Set()
for (const file of readdirSync(join(root, 'lib', 'tools'))) {
  if (!file.endsWith('.js')) continue
  for (const m of read('lib/tools/' + file).matchAll(/name: '(memory_[a-z_]+|system_now)'/g)) toolNames.add(m[1])
}
const readmeTools = new Set()
for (const m of readme.matchAll(/^(memory_[a-z_]+|system_now)\s/gm)) readmeTools.add(m[1])
const missing = [...toolNames].filter((n) => !readmeTools.has(n))
const extra = [...readmeTools].filter((n) => !toolNames.has(n))
if (missing.length === 0 && extra.length === 0) ok('README 工具清单', `${toolNames.size} 个`)
else no('README 工具清单', `漏 ${missing.join(',') || '-'}；多 ${extra.join(',') || '-'}`)

const absPathRe = /[A-Za-z]:[\\/](?:Users|AItool|Program|word)/
const docFiles = ['README.md', 'AGENTS.md', 'CLAUDE.md', ...readdirSync(join(root, 'docs'))
  .filter((f) => f.endsWith('.md') && f !== 'CHANGELOG.md')
  .map((f) => 'docs/' + f), ...readdirSync(join(root, 'docs', 'architecture'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => 'docs/architecture/' + f)]
const absHits = []
for (const f of docFiles) {
  const text = read(f)
  text.split('\n').forEach((line, i) => { if (absPathRe.test(line)) absHits.push(`${f}:${i + 1}`) })
}
if (absHits.length === 0) ok('文档无本机绝对路径')
else no('文档含本机绝对路径', absHits.slice(0, 6).join(', '))

console.log('== 4. 生产库体检（只读） ==')
try {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const fileBytes = statSync(dbFile).size
  let walBytes = 0
  try { walBytes = statSync(dbFile + '-wal').size } catch { /* 无 WAL */ }
  const total = db.prepare('SELECT COUNT(*) c FROM memories').get().c
  const archived = db.prepare('SELECT COUNT(*) c FROM memories WHERE archived = 1').get().c
  const emptyTheme = db.prepare("SELECT COUNT(*) c FROM memories WHERE theme = ''").get().c
  const clusters = db.prepare('SELECT COUNT(*) c FROM theme_clusters').get().c
  const solo = db.prepare('SELECT COUNT(*) c FROM theme_clusters c WHERE (SELECT COUNT(*) FROM memories m WHERE m.cluster_id = c.id) <= 1').get().c
  const centroidBytes = db.prepare('SELECT SUM(LENGTH(centroid)) c FROM theme_clusters').get().c ?? 0
  const emptyLabels = db.prepare("SELECT COUNT(*) c FROM theme_clusters WHERE label = ''").get().c
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memories_%'").all().map((r) => r.name))
  const need = ['idx_memories_archived', 'idx_memories_theme', 'idx_memories_cluster', 'idx_memories_updated', 'idx_memories_active', 'idx_memories_pinned']
  db.close()
  ok('库规模', `${(fileBytes / 1048576).toFixed(1)}MB + WAL ${(walBytes / 1048576).toFixed(1)}MB`)
  ok('记忆', `${total} 条（归档 ${archived}，${((archived / Math.max(total, 1)) * 100).toFixed(0)}%）`)
  ok('主题簇', `${clusters} 个，单成员 ${solo}，空标签 ${emptyLabels}`)
  if (solo > Math.max(5, clusters * 0.05)) wa('单成员簇占比过高', `${solo}/${clusters}`)
  if (walBytes > 50 * 1048576) wa('WAL 偏大', `${(walBytes / 1048576).toFixed(0)}MB`)
  if (centroidBytes > 30 * 1048576) wa('质心总体积偏大', `${(centroidBytes / 1048576).toFixed(0)}MB`)
  if (emptyTheme > total * 0.6) wa('theme 空值率', `${emptyTheme}/${total}`)
  const missingIdx = need.filter((n) => !indexes.has(n))
  if (missingIdx.length === 0) ok('热路径索引', `${indexes.size} 个`)
  else no('缺少索引', missingIdx.join(', '))
} catch (err) {
  wa('库体检', `跳过（${err.message}）`)
}

console.log(`\n结果: PASS ${pass} / WARN ${warn} / FAIL ${fail}`)
process.exit(fail > 0 ? 1 : 0)

