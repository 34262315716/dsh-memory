/**
 * 应用「人工/Agent 撰写」的记忆改写计划（默认只预演，--apply 才写库）。
 *
 * 背景：`memory_rewrite` 工具是让**插件自己的提取器**重写降级记忆；本脚本是它的
 * 姊妹工具——由**外部（人/主 Agent/子代理）写好正文**，再走插件的正规更新路径落库。
 * 两条路都保留世界线版本，旧文可回滚。
 *
 * 用法：
 *   node tools/apply-rewrite.mjs --plan <plan.json>            # 预演（默认）
 *   node tools/apply-rewrite.mjs --plan <plan.json> --apply    # 写库（写前自动备份）
 *   node tools/apply-rewrite.mjs --plan <plan.json> --apply --no-backup
 *
 * 计划文件格式：
 *   {
 *     "items": [
 *       { "id": "mem-xxxx", "action": "rewrite", "content": "自包含的结论…",
 *         "theme": "记忆插件维护", "abstract": "principle", "keywords": ["a","b"],
 *         "layer": "sm", "type": "lesson" },
 *       { "id": "mem-yyyy", "action": "archive", "reason": "rewrite-no-value" },
 *       { "id": "mem-zzzz", "action": "skip" }
 *     ]
 *   }
 *   · action 缺省 = skip（宁可不动，不误伤）
 *   · layer/type 只在给出时才改（缺省沿用原值）
 *
 * 安全设计：
 *   · 默认只预演，打印每条 before → after 摘要与统计，不写库
 *   · 写库前 `VACUUM INTO` 做一致性快照（WAL 库直接 copy 会漏数据）
 *   · 内容更新走 store.update()：世界线版本 + FTS 均由**插件自己的语句**处理，不手抄 SQL
 *   · 归档走 store.archiveMemories()：归档≠删除，memory_archive 可恢复
 *   · **向量必须作废重算**：脚本没有嵌入凭据，store.embedTexts() 在无 embedder 时会用
 *     ruleEmbed 造一个兜底向量并成功写入 —— 那是个**假向量**（不在远程嵌入空间里），
 *     且 reembedMissing 只看"行是否存在"，不会修它。所以写完正文后**主动删掉向量行**，
 *     交给 memory_reembed 用真嵌入重算。收尾务必跑一次 memory_reembed。
 *   · 每条写后立即回读校验，任何一条失败都会明确报出并停止后续写入
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { MemoryStore } from '../lib/store.js'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const bool = (n) => argv.includes(`--${n}`)

const planFile = arg('plan', null)
const apply = bool('apply')
const noBackup = bool('no-backup')
const dbPath = arg('db', join(homedir(), '.dsh', 'memory.db'))
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)

if (!planFile) {
  console.error('缺少 --plan <plan.json>。用 --help 看用法（见本文件头部注释）。')
  process.exit(2)
}

const plan = JSON.parse(readFileSync(planFile, 'utf8'))
const items = Array.isArray(plan) ? plan : (plan.items ?? [])
const rewrites = items.filter((i) => i.action === 'rewrite')
const archives = items.filter((i) => i.action === 'archive')
const skips = items.filter((i) => !i.action || i.action === 'skip')

console.log(`===== 改写计划：${planFile} =====`)
console.log(`共 ${items.length} 条 → 改写 ${rewrites.length} · 归档 ${archives.length} · 跳过 ${skips.length}`)
console.log(apply ? '模式：**写库**' : '模式：预演（不写库）')
console.log()

// 预演：用只读连接看现状，绝不碰库
if (!apply) {
  const ro = new DatabaseSync(dbPath, { readOnly: true })
  const get = ro.prepare('SELECT id, layer, type, theme, abstract, length(content) n, substr(content,1,80) head, archived FROM memories WHERE id = ?')
  let missing = 0
  for (const it of [...rewrites, ...archives, ...skips]) {
    const m = get.get(it.id)
    if (!m) { console.log(`❗ ${it.id} 不存在`); missing++; continue }
    const act = it.action ?? 'skip'
    const tail = act === 'rewrite'
      ? `→ ${String(it.content ?? '').length} 字符【${it.theme ?? '-'} · ${it.abstract ?? '-'} · ${it.layer ?? m.layer}/${it.type ?? m.type}】`
      : act === 'archive' ? `→ 归档（${it.reason ?? 'no-value'}）` : '→ 保持原样'
    console.log(`· [${act}] ${it.id} [${m.layer}/${m.type}] ${m.n}字符  ${JSON.stringify(m.head)}`)
    console.log(`  ${tail}`)
  }
  ro.close()
  console.log()
  console.log(missing > 0 ? `⚠️ 有 ${missing} 条 id 不存在（写库时会被跳过）` : '✅ 全部 id 均存在')
  console.log('\n预演结束。确认无误后加 --apply 写库。')
  process.exit(0)
}

// ---------- 写库 ----------
if (!noBackup) {
  const dir = join(homedir(), '.dsh')
  const backup = join(dir, `memory.db.bak-rewrite-${stamp}`)
  const bdb = new DatabaseSync(dbPath, { allowExtension: true })
  bdb.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
  bdb.close()
  console.log(`已备份：${backup}`)
  console.log()
}

// 注意：**不传 embedder**。这样构造函数会「沿用现有向量表维度」（4096），
// 绝不触发 DROP TABLE 的维度迁移；向量留待 memory_reembed 补写。
const store = new MemoryStore(dbPath, {})
const before = store.archivedStat()
console.log(`写前：总计 ${before.total} · 活跃 ${before.active} · 归档 ${before.archived}`)
console.log()

let okRewrite = 0; let okArchive = 0; const failed = []

for (const it of rewrites) {
  const m = store.get(it.id)
  if (!m) { failed.push({ id: it.id, why: '不存在' }); continue }
  const content = String(it.content ?? '').trim()
  if (!content) { failed.push({ id: it.id, why: 'content 为空' }); continue }
  try {
    // 1) 正文 + 关键词（世界线版本 / FTS 由 store 自己的语句处理）
    const r = await store.update(it.id, {
      content,
      keywords: Array.isArray(it.keywords) ? it.keywords : m.keywords,
    })
    // 2) 维度字段与分层/类型（update() 不覆盖这些，按需补齐）
    const sets = []; const vals = []
    if (it.theme !== undefined) { sets.push('theme = ?'); vals.push(String(it.theme)) }
    if (it.abstract !== undefined) { sets.push('abstract = ?'); vals.push(String(it.abstract)) }
    if (it.layer !== undefined) { sets.push('layer = ?'); vals.push(String(it.layer)) }
    if (it.type !== undefined) { sets.push('type = ?'); vals.push(String(it.type)) }
    if (sets.length > 0) {
      vals.push(it.id)
      store.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    }
    // 3) **作废向量**：store.update() 在无 embedder 时用 ruleEmbed 写了一个兜底向量，
    //    那是假向量（不在远程嵌入空间里），且 reembedMissing 只看行是否存在、不会修它。
    //    删掉这一行，交给 memory_reembed 用真嵌入重算。store 的构造函数已 loadExtension，
    //    所以这里可以直接操作 memory_vectors 这个 vec0 虚拟表。
    const rowid = store.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(it.id)?.rowid
    if (rowid !== undefined) store.db.prepare('DELETE FROM memory_vectors WHERE rowid = ?').run(BigInt(rowid))
    // 4) 回读校验
    const after = store.get(it.id)
    if (after.content.trim() !== content) throw new Error('回读内容不一致')
    okRewrite++
    console.log(`✅ ${it.id} rev${r.revision ?? '?'} ${m.content.length}→${after.content.length} 字符  [${after.layer}/${after.type}] ${after.theme || '-'}（向量已作废待重算）`)
  } catch (err) {
    failed.push({ id: it.id, why: err.message })
    console.error(`❌ ${it.id} 改写失败：${err.message}`)
  }
}

for (const it of archives) {
  const m = store.get(it.id)
  if (!m) { failed.push({ id: it.id, why: '不存在' }); continue }
  try {
    const n = store.archiveMemories([it.id], it.reason ?? 'rewrite-no-value')
    okArchive += n
    console.log(`🗄 ${it.id} 已归档（${it.reason ?? 'rewrite-no-value'}）`)
  } catch (err) {
    failed.push({ id: it.id, why: err.message })
    console.error(`❌ ${it.id} 归档失败：${err.message}`)
  }
}

const after = store.archivedStat()
console.log()
console.log(`===== 完成 =====`)
console.log(`改写 ${okRewrite}/${rewrites.length} · 归档 ${okArchive}/${archives.length} · 跳过 ${skips.length}`)
console.log(`写后：总计 ${after.total} · 活跃 ${after.active} · 归档 ${after.archived}（写前归档 ${before.archived}）`)
if (failed.length > 0) {
  console.log(`\n失败 ${failed.length} 条：`)
  for (const f of failed) console.log(`  · ${f.id}：${f.why}`)
  process.exitCode = 1
}
console.log('\n⚠️ 向量未在本脚本内重算 —— 收尾请调用 memory_reembed 补写缺失向量。')
store.db.close()
