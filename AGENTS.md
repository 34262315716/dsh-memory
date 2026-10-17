# dsh-memory

DSH（DeepSeek Harness）进阶自动记忆插件：分层记忆（情景/语义/画像）+ 知识图谱 + 世界线版本化 + 向量 RAG 检索 + 增量构建。

## 开发须知

- **测试与收尾检查**：测试统一放在 `tests/`。任何改动完成后跑 `node tools/check.mjs`（语法 + 全量测试 + 文档版本/工具清单 + 生产库只读体检）；`--offline` 跳过需要 @deepseek-ai 私有 peer 包的套件。
- **前端构建**：改动 `client/*.jsx` 后执行 `node build-client.mjs` 重建 `lib/client.js`（bundle 勿手改）。
- **数据安全**：记忆库默认 `~/.dsh/memory.db`（WAL，可能在运行时生成 `.db-wal/.db-shm/.bak-*`）。任何数据库、凭据、备份文件**绝不入版本库**（见 `.gitignore`）。
- **文档纪律**：禁止在文档/代码中出现本地绝对路径、真实凭据或密钥；`tools/check.mjs` 会扫描文档里的本机路径。
- **发布前**：改了 `client/*.jsx` 先 `node build-client.mjs`；改了数据结构先跑对应迁移脚本的 `--dry-run`；版本号、CHANGELOG、架构文档的版本标注放同一条提交。
- **部署**：先确认**跑的是哪一份**再动手（形态不同，动作不同）。profile 的 `node_modules/dsh-memory` 若是 Junction/符号链接（`Get-Item … | Select LinkType,Target` 可查），改仓库即改线上代码，**只需重启实例**；若是真实目录副本，用 `node tools/deploy.mjs`（自动复验 md5；`--check` 只比对，有漂移退出码 1），重启生效，客户端改动刷新页面即可。
  ⚠️ `deploy.mjs` 默认取 `DSH_HOME`（未设置时回落 `~/.dsh`）；两者不一致时它会检查错误的副本。先按端口查进程命令行确认 DSH_HOME 与 profile。
  2026-09-17 实测漂移一次：部署副本落后到缺 v0.9.31 降级护栏，代价是向量表被 rule 兜底迁移成 256 维、向量路停摆。**真正的副本形态**下收工前务必 `--check`。

## 环境与工具坑（实测，别重复踩）

- **符号链接会随 .dsh-runtime 升级断裂**：`node_modules/@deepseek-ai/*` 是指向 `.dsh-runtime/dsh/node_modules/.pnpm/...` 的软链，升级后 pnpm 目录哈希变了、链接仍指旧路径。表现为 `tools/check.mjs` 里一批测试套件加载失败（`ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools`）。**先查链接，不要据此排查业务代码**。修法：按新哈希目录逐个重建（`ls -d .pnpm/@deepseek-ai+dsh-agent-inst_*` 找到真实路径再 `ln -s`），或重跑 `pnpm install`。
- **`defineTool` 的 schema 比看起来严**：① `required: false` 不被允许——要么省略该字段、要么写 `true`；② array 的 `items` 若是 object，必须显式写 `additionalProperties: false` 与完整 `properties` 表，否则 `compileValueSchema` 抛 `JsonSchemaError`。
- **工具注册失败是静默的**：`safeRegister` 会吞掉异常并打一行 warn。表现为「工具没注册上但没有任何报错」，只有对照 `test-crash-safety.mjs` 的「源码提取名 vs 实际注册名」断言才看得出来。加新工具后**必跑那套测试**。
- **CRLF 混用会吃掉 replace**：仓库部分文件是 CRLF，用字符串 replace 时若匹配串没带 `\r`，会静默不命中（返回值看着像成功）。改这类文件优先用行号操作，或先 `split('\n')` 再处理。
- **会话累积必须落盘**：批量提取的静置计时器活在内存里，进程重启就没了。`lib/session-persist.js` 把它存在 meta 表的 `batch:turns:<sid>`；改动这块时别把落盘/读回拆掉，否则「2 小时内重启过一次 = 那段会话永远不提取」。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **dsh-memory** (3328 symbols, 11429 relationships, 172 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/dsh-memory/context` | Codebase overview, check index freshness |
| `gitnexus://repo/dsh-memory/clusters` | All functional areas |
| `gitnexus://repo/dsh-memory/processes` | All execution flows |
| `gitnexus://repo/dsh-memory/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
