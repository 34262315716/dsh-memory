# dsh-memory 架构文档（v0.9.7）

> 本文描述 dsh-memory 的**当前**实现构造：模块划分、依赖关系、数据流、三条核心管线（写入/检索/注入）、图谱、时间维度、GUI 与工程约定。
> **目标：读本文件即可理解构造，无需逐个翻源码；需要改哪里、新需求放哪，见 §11 扩展指南。**
> 演进历史见 [`CHANGELOG.md`](CHANGELOG.md)；交互式架构图见 [`architecture.html`](architecture.html)。

---

## 1. 模块构造总览（v0.9.7 解耦重构后）

v0.9.7 把原来"一个 1778 行的 index.js + 单文件 client"重组成 **装配壳 + 单一职责模块**：`lib/index.js` 只剩装配，业务拆到 `config/util/store/embedder/refiner/graph-snapshot/pipelines/tools`；client 拆为设置/图谱/日志三个视图。**零行为改动**，依赖严格单向、无循环。

### 1.1 模块树

```
dsh-memory/
├── lib/
│   ├── index.js            ← 装配壳（apply 入口，253 行）
│   ├── config.js           配置 schema + 默认值（Config）
│   ├── util.js             纯函数与常量（无项目依赖，最底层）
│   ├── store.js            MemoryStore 存储层（唯一数据访问口）
│   ├── embedder.js         Embedder / Reranker seam（降级链）
│   ├── refiner.js          LLM 蒸馏提取
│   ├── graph-snapshot.js   记忆级图谱快照投影（GUI 数据源）
│   ├── pipelines/
│   │   ├── write.js        turn/end 沉淀管线（价值门 + 去重 + 管家）
│   │   └── inject.js       pre-step 注入管线 + session-start 预热（同一模块两个工厂）
│   └── tools/              工具注册器（按域拆分）
│       ├── index.js        汇总入口 registerTools
│       ├── shared.js       safeRegister / logStore 共享助手
│       ├── time.js         system_now
│       ├── memory.js       add/search/forget/list/stats/merge/purge/reembed
│       ├── housekeeping.js housekeeping/events/logs/profile_distill
│       └── graph.js        communities/neighbors/versions/rollback/path/link/unlink/node
│   └── client.js           ← 构建产物（esbuild bundle，勿手改）
├── client/
│   ├── index.jsx           客户端壳：name/inject/apply（插槽装配）
│   ├── settings.jsx        设置面板（settings.section）
│   ├── graph.jsx           记忆图谱（sidebar.footer.action）
│   └── logs.jsx            记忆日志（sidebar.footer.action）
├── build-client.mjs        esbuild 构建 client bundle → lib/client.js
└── docs/                   本文档 + CHANGELOG + ROADMAP + 设计文档
```

### 1.2 模块职责与导出契口

| 模块 | 行数 | 导出 | 职责（一句话） |
|---|---|---|---|
| `lib/index.js` | 253 | `apply(ctx, config)`、`name`、`inject`、再导出 `Config`/`scopeOf` | 装配：settings 注册 → store/embedder 初始化 → Web API → 挂三条管线 → 注册工具 → `ctx.memory` 门面 → dispose；内含 `migrateLegacy` |
| `lib/config.js` | 103 | `Config` | 全部参数/开关/子对象的 z.object schema 与默认值（唯一真源） |
| `lib/util.js` | 114 | `scopeOf` `formatNow` `estimateTokens` `renderInjection` `extractUserText` `messageText` `truncate` `OUTCOME_RE` `readCredential` | 纯函数与常量；无项目内依赖；`scopeOf(session, registry)` 是三态 scope 分层核心 |
| `lib/store.js` | 1494 | `MemoryStore` `tokenize` `jaccard` `cosine` `ruleEmbed` `VEC_DIM` `EDGE_TYPES` `GRAPH_STOP_WORDS` | 全部数据访问：SQLite/迁移、CRUD、世界线版本、三路 RRF 检索+rerank、图谱、社区、事件、日志、遗忘、管家 |
| `lib/embedder.js` | 231 | `createEmbeddingServices` `RuleEmbedder` `RemoteEmbedder` `RemoteReranker` | 向量/重排 seam；降级链 onnx→remote→rule（rule 永不失败） |
| `lib/refiner.js` | 62 | `extractWithLlm(ctx, cfg, userPart, assistantPart)` | 独立 LLM 把一轮对话蒸馏为自包含记忆（JSON 输出 + 坏 JSON 容错） |
| `lib/graph-snapshot.js` | 56 | `buildGraphSnapshot(store)` | 记忆级图谱快照投影（一记忆一节点 + 边 + 主题 + 事件），只消费 store 实例 |
| `lib/pipelines/write.js` | 213 | `attachWritePipeline(ctx, deps)` | turn/end 沉淀：回合缓存、价值门、Jaccard 去重合并（含 `upsertMemory`）、refiner 分支、管家触发 |
| `lib/pipelines/inject.js` | 127 | `attachInjectPipeline(ctx, deps)` `attachPreheatPipeline(ctx, deps)` | pre-step 检索注入（节流/去抖/预算/防循环）；session-start 预热（画像优先 + scope 隔离） |
| `lib/tools/*.js` | — | `registerTime/Memory/Housekeeping/GraphTools(ctx, store, getCfg)` + `registerTools` | 工具注册，按域隔离，单个失败不影响其他 |

> **`attachWritePipeline`/`attachInjectPipeline`/`attachPreheatPipeline` 的 `deps`** = `{ store, getCfg, wsRegistry, logStore }`——显式依赖注入，管线绝不访问 `apply` 局部变量（这是 v0.9.6 教训的固化）。

### 1.3 依赖关系（严格单向，无循环）

```
最底层（无项目依赖）          lib/util.js        lib/config.js
                              │  ▲                │
数据访问口                   lib/store.js  ◀──────┘
                              │  ▲
能力 seam    lib/embedder.js  │  │            lib/refiner.js（依赖 util/store）
              │  ▲           │  │
逻辑层       ┌┴──┴───────────┴──┴──┐
            lib/pipelines/*    lib/tools/*     lib/graph-snapshot.js
                     │  ▲              │
装配壳         ┌─────┴──┴──────────────┴──►  lib/index.js（apply 组装一切）
              DSH 运行时（cordis 加载 apply/inject/事件/路由）
```

- `util.js`→(node:fs/path/os)；`config.js`→(schemastery)；`store.js`→(node:sqlite, sqlite-vec)
- `pipelines/*`→(util, store, refiner, dsh-llm)
- `tools/*`→(util, store, dsh-tools, shared)
- `index.js`→(config, util, store, embedder, graph-snapshot, pipelines, tools)
- 依赖 `@deepseek-ai/{cordis,schemastery,dsh-llm,dsh-tools,dsh-settings}` 由 DSH 宿主提供

### 1.4 代码路径 → 模块映射（"改这里去哪"）

| 想改什么 | 去哪个模块 |
|---|---|
| 配置项 / 默认值 | `lib/config.js`（+ `client/settings.jsx` 加 GUI 字段） |
| SQL / 表 / 增删改查 / 检索质量 | `lib/store.js` |
| 换嵌入/重排服务商 | `lib/embedder.js` |
| 蒸馏 prompt / 提取规则 | `lib/refiner.js` |
| 注入时机/去抖/预算/格式 | `lib/pipelines/inject.js` |
| 沉淀逻辑 / 价值门 / 去重 / 管家 | `lib/pipelines/write.js` |
| 图谱数据接口（快照字段） | `lib/graph-snapshot.js` |
| 工具增删 / schema | `lib/tools/*` 对应域 + `lib/tools/index.js` |
| 插件如何启动/装配 | `lib/index.js` 的 `apply` |
| GUI 面板 | `client/{settings,graph,logs}.jsx` + `client/index.jsx` 插槽 |

---

## 2. 数据模型（memory.db，WAL + STRICT）

```sql
memories          -- 记忆身份 + 活跃切片：id/layer(ep|sm)/type(含 profile)/scope/content/keywords/strength/last_access/created_at/updated_at/theme/profile_aspect/cluster_id（主题聚类归属标记，v0.9.8）
memory_versions   -- 世界线版本：memory_id/revision/content/keywords/valid_from/valid_to/superseded_by（活跃版唯一部分索引）
memories_fts      -- FTS5 虚拟表（trigram tokenizer，中文子串）
memory_vectors    -- sqlite-vec vec0（维度随 embedder，rowid 与 memories 对齐）
nodes / edges     -- 图谱实体节点（entity|event|state）+ 8 型边（mentions 共现骨架）
node_memories     -- 节点归一化后的多对多（rebuild-graph.mjs 归一化时写入）
memory_links      -- 记忆级语义边（一等存储：GUI 投影直读 + 记忆级 BFS/邻域；v0.8.0）
communities / community_members -- 社区聚类（label propagation）
events / event_members          -- 事件分类（时间线扫描产物；v0.9.0）
meta              -- 键值元数据（管家时间戳、蒸馏幂等记录）
logs              -- 运行日志（全链路埋点；v0.9.5）
theme_clusters    -- 主题簇持久化（质心/词频/成员数；v0.9.8 增量聚类）
```

- **rowid 对齐**：memories 隐式 rowid = FTS5 与 vec0 行键，三表同事务同步，删除级联清理。
- **向量独立成表**：`sqlite-vec` 加载失败 → `vecEnabled=false`，检索自动降级 FTS/关键词路，主体功能不受影响（防崩溃原则）。
- **补列迁移**：旧库缺列（theme/profile_aspect）自动 `ALTER TABLE`；vec 维度变化时重建空表 + `reembedMissing` 重嵌入。
- **版本语义**：更新不销毁，旧版本 `valid_to` 置非空（隐藏不参与检索/注入），`maxVersionsPerMemory` 滚动裁旧；回滚 = 旧版重新激活为新 revision（世界线不断链）。

## 3. 写入管线（`lib/pipelines/write.js`）

```
turn/end 事件
  → turnCache（user/assistant 文本；只收 source.kind==='user' 真实消息，防注入嵌套）
  → 价值门（空 / 过短 / 无成果信号过滤）
  → refiner.enabled？
      ├─ 是 → refiner.js extractWithLlm() → JSON{content,type,layer,keywords,aspect}
      │        失败/超时 → 降级规则路径
      └─ 否 → 规则组装（"任务:…\n结果:…"）
  → upsertMemory(store, features, entry)：Jaccard ≥ 0.8 → update（版本追加 + strength 加成）；否则 add
  → add/update 同步写 FTS5 + vec0 + memory_versions（time 开关）
  → graph 开关开启 → graphLink + linkBefore（实体节点 / 记忆级时间链）
  → maybeHousekeeping()（写入量 + 时间双驱动触发管家巡检）
```

**scope 分层**（v0.9.4/0.9.5）：写入口 `writeScope(type)` = `type==='profile' ? 'global' : scopeOf(session, wsRegistry)`——项目会话按工作目录/工作区分层，画像固定公共层；注入检索按 `[项目 scope, global]` 双 scope 查（存量 global 兼容为公共层）。

## 4. 检索管线（`lib/store.js` → `search`）

```
query → tokenize（英文词≥3 + 中文 bigram）
  路1 FTS5：BM25（trigram，词长≥3 才 MATCH）
  路2 关键词：keywords JSON 交集计数 + 子串兜底（中文 2 字词）
  路3 向量：embedder（rule/remote）→ vec0 KNN 余弦（vecEnabled 时）
  融合：每路按 score 排序得 rank → RRF Σ 1/(60+rank)；三路并集（向量独有命中不丢）
  精排（可选 reranker）：RRF topK 候选 → RemoteReranker → final = w×norm(RRF)+(1-w)×rerank；失败降级 RRF
  过滤：scope 匹配 + excludeIds（防循环窗口）+ minScore（RRF 量纲，默认 0.02）
  排序：score desc, id asc（确定性——KV 缓存友好前提）
  命中 touch：刷新 last_access + strength×1.1（遗忘曲线语义）
```

## 5. 注入管线（`lib/pipelines/inject.js`）

**pre-step 检索注入**（`attachInjectPipeline`）：
```
① 只取 source.kind==='user' 文本（注入内容永不当查询）
② 签名去抖：query hash 相同 → 跳过
③ 步距节流：距上次全量检索 < stepInterval 步 → 跳过
④ store.search（[项目 scope, global]）→ token 预算贪心装入（injectMaxTokens）
⑤ 注入块 hash 去抖：与上次相同 → 不注入
⑥ agent.inject(createUserMessage(form:'recall')) + 运行日志
⑦ 防循环窗口（maxRecentPerAgent）
```

**会话预热**（`attachPreheatPipeline`，`agent/session-start`）：
- 画像全 scope 直取（type=profile，跨项目公共层）→ 非画像先当前项目 scope、不足补 global → 组装带时间戳的预热块注入。

**KV 缓存友好**：稳定块头 + 确定性排序 + append-only 尾部 + 溯源锚点 `#mem-id`；相同命中集 → 相同块 → 注入块自身成为可复用前缀。

## 6. 图谱与社区（`lib/store.js`）

- **记忆级边**（memory_links，一等存储）：`link/unlink`（8 型，幂等 UPSERT/valid_to 置位历史保留）、`linkSimilar`（去重候选）、`linkBefore`（同 label 记忆时间链，方向自愈 see v0.9.1）
- **实体骨架**（nodes/edges）：`graphLink` 建 entity 节点 + mentions 全连接；停用词过滤（`GRAPH_STOP_WORDS`，泛词不成节点）；ep 快照不建图
- **遍历**：`memoryLinkNeighbors`/`memoryPath`（记忆级双向 BFS）/ `neighborsK`（k-hop CTE）/ `path`（节点级 BFS）
- **聚类/分类维度**：`detectCommunities`（label propagation）· 记忆级主题聚类 `themeMemories`（向量凝聚，label=高频词）· 事件分类 `detectEvents`（时间线扫描，见 §2 events 表）
- **v0.9.8 增量**：主题聚类持久化到 `theme_clusters`（质心/词频/成员数）+ `memories.cluster_id`，只归未归簇新记忆（跨重启续跑；维度迁移自动清簇重聚）；事件检测走 `detectEventsIncremental`（meta `event_scan_at` 水位线，无新增跳过、只重建尾部窗口）——启动/巡检不再全量重算。
- **GUI 数据**：`/dsh-memory/graph` → `lib/graph-snapshot.js` 投影（节点含 theme/type/versions/eventId/aspect，即"四维蠕虫"的时间痕迹）

## 7. 遗忘曲线

- 惰性衰减：`decayExpired()`（turn/end 低频触发）——超 24h 未访问 `strength *= exp(-0.15×天数)`，下限 0.1
- 访问加成：检索命中 `strength = min(strength × 1.1, 5)`（touch）
- 管家巡检：`housekeeping()` = 去重扫描（余弦 ≥ 阈值）+ 老化报告（闲置超天数）；dryRun 默认只报告，`dryRun=false` 自动合并 sim ≥ 0.95 几乎重复对

## 8. 配置（settings 驱动，live 生效）

```
schema 默认值 ← 组合层（cordis.patch.yml config = base）← 用户层（GUI 写入 settings.yaml memory 段）
```

- host 端：`apply` 内 `ctx.settings.register(settingsNamespace('memory'), Config, { base, applies:'live' })`——管线/工具统一经 `getCfg()` 每次读最新值
- client 端：`ctx.settingsScope.bind({ namespace:'memory' })` 读写同一文档；`api.llm.providers()/models()` 动态预设下拉
- 密钥：引用 + 凭据文件（`~/.dsh/.credentials.yaml`，`api.credentials.set`）——不进 settings 文档、不进记忆库、界面只回"已配置"布尔
- 开关矩阵：`autoWrite/valueGate/dedupMerge/preStepInject/manageTools/time/graph` + refiner/reranker/housekeeping/events/logging 各自开关——每项可关，关闭即降级路径
- ⚠️ 前置：`memory` 命名空间需在 harness `apiproxy` 的 `WEB_SETTINGS_NAMESPACES` 白名单（升级 DSH 后重新添加，见 README）

## 9. 集成点与工具面

**DSH 集成点**：`session/event`（写入原料）· `agent/pre-step`（waterfall 注入）· `agent/session-start`（预热）· `agent.inject()`（form:'recall' append-only）· `ctx.settings`/`settingsScope` · `ctx.tools`（defineTool）· `ctx.llm.stream()`（refiner）· `ctx.credentials` · `ctx.workspaceRegistry`（scope fallback）· webServer 路由（`/dsh-memory/graph`、`/dsh-memory/logs`）· client `settings.section` / `sidebar.footer.action` 插槽 · `exports["./client"]` 双面插件。

**工具面（21 个，按域注册）**：

| 域 | 工具 |
|---|---|
| time | `system_now` |
| memory | `memory_add` `memory_search` `memory_forget` `memory_list` `memory_stats` `memory_merge` `memory_purge` `memory_reembed` |
| housekeeping | `memory_housekeeping` `memory_events` `memory_logs` `memory_profile_distill` |
| graph | `memory_graph_communities` `memory_graph_neighbors` `memory_graph_path` `memory_graph_link` `memory_graph_unlink` `memory_graph_node` `memory_versions` `memory_rollback` |

## 10. 工程约定（防崩溃 / 依赖注入 / 日志 / 测试）

1. **防崩溃隔离（最高原则，插件问题绝不能炸 dsh）**：
   - `apply` 顶层逐段 try/catch——settings 注册失败兜底、初始化失败停用记忆功能、Web API 失败仅 warn
   - 工具注册 `safeRegister`：单个工具 schema 非法只跳过该工具（v0.6.0 教训；test-crash-safety 守护）
   - 写入管线整体 try/catch；向量写入失败仅 warn 跳过（reembedMissing 补写）
   - **工具/注册器是模块级函数，绝不依赖 apply 局部变量**——依赖一律参数/注入传入（v0.9.6 教训）
2. **依赖注入**：pipelines 与 tools 只通过 `deps`/参数拿 `store/getCfg/wsRegistry/logStore`；`lib/tools/shared.js` 提供统一 `makeSafeRegister`/`makeLogStore`。
3. **运行日志**：所有关键动作（init/preheat/inject/write/refined/fallback/housekeeping/events.detect/links.fix/tool.*）走 `store.log`，级别 + 事件 + scope + 详情，惰性裁剪至 maxRows；日志失败绝不影响主流程。
4. **scope 三态**：`cwd → workspaceRegistry → global`（`lib/util.js scopeOf`），唯一判据，禁止散布重复逻辑。
5. **测试**：9 套 170 项（含 test-incremental 21 项）（README §测试）——`test-profile`/`test-crash-safety` 依赖 `@deepseek-ai`，需在部署副本环境或在 `node_modules` 挂 junction 指向 harness 的 `@deepseek-ai` 后于源码目录运行。`lib/store.js`/`lib/embedder.js` 有独立 seam 单测，改动尊重测试。
6. **版本与部署纪律**：每次改动 = 实现 + 测试 + CHANGELOG + 部署副本同步（md5 校验）+ 提交推送；改 `lib/` 或 client bundle 需重启 dsh web 生效。

## 11. 扩展指南（新需求"改这里"）

| 需求 | 动手位置 | 附带 |
|---|---|---|
| 加一个配置项 | `lib/config.js` 加字段 | `client/settings.jsx` 加 GUI 字段 + 数值白名单 `NUMERIC_SUB` |
| 加一个工具 | 按域放 `lib/tools/<域>.js`，`safeRegister(defineTool({…}))` | `lib/tools/index.js` 挂进 `registerTools`；守护测试工具清单同步 |
| 改检索策略 | `lib/store.js search()`（路/RRF/rerank/过滤） | test-embedder/test-housekeeping |
| 改注入策略 | `lib/pipelines/inject.js` | test-crash-safety（监听挂载断言） |
| 改沉淀/价值门/去重 | `lib/pipelines/write.js` | test-profile（蒸馏/预热） |
| 改蒸馏 prompt | `lib/refiner.js` | test-profile（mock LLM） |
| 新数据表 | `lib/store.js SCHEMA` + 补列/迁移 | 老库兼容用"补列检测"模式 |
| 新 GUI 视图 | `client/<view>.jsx` + `client/index.jsx` 插槽 | 重建 `node build-client.mjs` |
| 图谱快照加字段 | `lib/graph-snapshot.js` | — |
| 换嵌入/重排服务 | `lib/embedder.js createEmbeddingServices` | 密钥走凭据引用 |

> 新增模块时保持**单向依赖**：底层（util/store）永不 import 上层（pipelines/tools/index）；高层只 import 它真正消费的东西。

## 12. 已知限制 / 待办

- `lib/graph-snapshot.js` 仍直接读 `store.db`（原 index.js 遗留的封装修复点）——后续可在 `store.js` 补 `versionCounts()`/`activeLinks()` 访问器彻底关闭（v0.9.7 为保零行为未动）
- 社区检测为全量重写（无增量）；`trade 8 型边`中 causes/solves/supports/contradicts 四型自动建边需 LLM 判断（待 refiner 增强）
- 迭代路线见 [`ROADMAP.md`](ROADMAP.md)：阶段 C 图工具记忆级升级、v0.10 抽象层级 abstraction / refiner 主题打标 / GUI 主题圈、阶段 D 残余小项
