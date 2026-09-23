#!/usr/bin/env node
/**
 * 部署同步：仓库 lib/ → DSH profile 里的 dsh-memory 部署副本。
 *
 * 为什么需要它：dsh-memory 是手工放进 profile/node_modules 的 insert 插件（不走 pnpm，
 * pnpm 甚至会 prune 掉游离目录），**改完仓库 ≠ 线上生效**。2026-09-17 抓到一次真实漂移：
 * 仓库已含 v0.9.31 的降级保护（degraded 禁破坏性迁移 + 30s 超时），部署副本还停在 9/8 的
 * 旧版——结果向量表被 rule 兜底迁移成 256 维，向量路实际已瘫，而日志里只有一行 warning。
 *
 * 用法：
 *   node tools/deploy.mjs                  # 同步 lib/ 并打印 md5 对比
 *   node tools/deploy.mjs --check          # 只校验不写入（有漂移退出码 1）
 *   node tools/deploy.mjs --profile desktop  # 换 profile（默认 web-desktop）
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const profileIdx = args.indexOf('--profile')
const profile = profileIdx >= 0 ? args[profileIdx + 1] : 'web-desktop'
if (!profile) {
  console.error('用法: node tools/deploy.mjs [--check] [--profile <name>]')
  process.exit(2)
}

const srcRoot = join(root, 'lib')
const dstPkgRoot = join(homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-memory')
const dstRoot = join(dstPkgRoot, 'lib')

if (!existsSync(dstPkgRoot)) {
  console.error(`❌ 部署副本不存在：${dstPkgRoot}\n   该插件是手工挂载的 insert 插件，请先确认 profile 目录。`)
  process.exit(2)
}

const md5 = (file) => createHash('md5').update(readFileSync(file)).digest('hex')

/** 递归列出目录下的相对路径（只含文件）。 */
function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full))
  }
  return out
}

const files = walk(srcRoot).map((rel) => join('lib', rel)).sort()
// package.json 也一起同步：`dsh.client` / exports 决定宿主怎么加载客户端半边，版本号也要对得上
files.push('package.json')
const same = [], changed = [], added = []
for (const rel of files) {
  const src = join(root, rel)
  const dst = join(dstPkgRoot, rel)
  if (!existsSync(src)) continue
  if (!existsSync(dst)) added.push(rel)
  else if (md5(src) !== md5(dst)) changed.push(rel)
  else same.push(rel)
}

console.log(`仓库: ${srcRoot}`)
console.log(`部署: ${dstRoot}`)
console.log(`一致 ${same.length} 个文件` + (changed.length ? `，漂移 ${changed.length} 个：${changed.join(', ')}` : '') + (added.length ? `，缺失 ${added.length} 个：${added.join(', ')}` : ''))

if (changed.length === 0 && added.length === 0) {
  console.log('✅ 部署副本与仓库一致（md5 全等）')
  process.exit(0)
}
if (checkOnly) {
  console.error('❌ 部署副本已漂移——跑 `node tools/deploy.mjs` 同步，并重启 DSH 生效')
  process.exit(1)
}

for (const rel of [...changed, ...added]) {
  const dst = join(dstPkgRoot, rel)
  mkdirSync(dirname(dst), { recursive: true })
  writeFileSync(dst, readFileSync(join(root, rel)))
}
// 同步后复验：不靠"我刚写过"这句话，靠 md5
const bad = [...changed, ...added].filter((rel) => md5(join(root, rel)) !== md5(join(dstPkgRoot, rel)))
if (bad.length) {
  console.error(`❌ 同步后仍不一致（写入失败？）：${bad.join(', ')}`)
  process.exit(1)
}
console.log(`✅ 已同步 ${changed.length + added.length} 个文件并复验 md5 一致——重启 DSH 生效（客户端改动刷新页面即可）`)
