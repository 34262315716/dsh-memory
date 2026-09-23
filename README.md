# dsh-memory

> **dsh-memory** — Advanced auto-memory plugin for DSH (DeepSeek Harness): layered memory (episodic / semantic / profile), knowledge graph, worldline versioning, vector + RAG retrieval, and incremental graph building. Local SQLite, MIT-licensed. (Body of this README is in Chinese.)

DSH（DeepSeek Harness）进阶自动记忆插件——**无需用户消息触发**，agent 自主工作时每一步自动注入与当前任务相关的历史记忆，并在每个轮次结束时自动沉淀新记忆。

> 核心诉求：记忆不只是"清单"，而是会生长的知识网络：分层 + 图谱 + 世界线（时间维度）+ 向量语义检索。

## ✨ 功能总览

| 能力 | 说明 |
|---|---|
| **自动注入** | `agent/pre-step` 每步检索相关记忆并 `agent.inject()`（不依赖用户消息）；节流 + 签名去抖 + 注入块 hash 去抖 + 防循环窗口 |
| **自动沉淀** | `turn/end` 写入 + 价值门过滤 + Jaccard 去重合并（相似记忆更新而非新建） |
| **分层记忆** | `ep`（情景，turn 快照）/ `sm`（语义，长期知识），**scope 项目隔离**：按会话工作目录自动分层（workspaceRegistry fallback），画像跨项目公共层 |
| **时间维度（世界线）** 🐛 | 更新追加版本，旧版本保留但隐藏（不参与检索/注入）；`maxVersions` 滚动裁旧 + 回滚链 |
| **向量语义检索** | `sqlite-vec` KNN 余弦 + FTS5 BM25 + 关键词三路 **RRF 融合**；扩展加载失败优雅降级；**reranker 后置精排**（RRF 候选 → 融合分 `w×RRF+(1-w)×rerank`，失败降级 RRF 零损失） |
| **记忆图谱** | 实体节点 + 边（共现/因果/时间演化…）、k-hop 邻域扩散、BFS 最短路径、社区自动聚类；**力导向参数（弹簧/斥力/阻尼/引力）settings 可调、live 生效**；**记忆级边独立表（memory_links）**——GUI 投影直读、记忆级 BFS/邻域、旧实体边自动迁移；**时间维度可视化**：更新过的节点有金色年轮（环数=更新次数）、新旧色温（库内相对映射）、时间窗筛选、hover 时间标签 |
| **增量构建 (v0.9.8)** | 主题聚类持久化簇（theme_clusters + cluster_id）+ 事件检测水位线（meta.event_scan_at）——启动/巡检不再全量重建派生数据，O(新增+尾部) 而非 O(全量) |
| **联系显性化 (v0.9.11)** | 记忆级图谱显示多种联系：8 型边各配颜色/线型 + hover 边类型 + mentions 强共现（共享≥2 实体）；before 演化收紧（稀有实体+同主题），beforeAudit 审计清理假演化 |
| **记忆管家** | 自动巡检（与对话轮数解耦：每沉淀 20 条记忆 或 距上次超 24h 触发，时间戳持久化）：全局去重扫描（余弦近重复）+ 老化报告（长期闲置低价值）。**v0.12.1 真治理**：不再只报告不动手——近乎重复择优保留一条、其余**归档**（不删除、可恢复），陈旧情景快照归档，**LLM 归并**把讲同一件事的一团记忆合成一条更完整的结论（取代原来的横线拼接）；治理动作在工具报告、日志面板、会话预热三处可见 |
| **事件分类** | 时间连续 + 因果相关（同主题/共享实体）的记忆聚簇——"这段记忆属于哪件事"（区别于 theme 的"在讲什么"）；时间线扫描纯 rule 算法，管家自动维护；`memory_events` 工具 + 图谱事件筛选/高亮 |
| **画像分类** | 关于用户本人的稳定信息（身份/偏好/习惯/背景/沟通方式）单独分类：type=profile + aspect 子域；refiner 自动识别；**会话预热画像优先注入**（"用户是谁"优先于"最近干了啥"）；`memory_profile_distill` 画像蒸馏 |
| **运行日志** | 背后运行了什么完全透明可见：写入/注入/检索/巡检/蒸馏/错误全链路埋点；GUI「记忆日志」面板（侧边栏入口 + 3s 轮询 + 筛选）+ `memory_logs` 工具 + `/dsh-memory/logs` API |
| **LLM 蒸馏（refiner）** | 独立模型把高噪声轮次提取为自包含结论（决策/偏好/教训分类）+ **双输出（v0.10.0）**：`abstract` 抽象层级（principle=可复用原则/方法 / event=一次性事件产出）+ `theme` 名词标签（如"四级备考"）；失败自动降级规则路径；**v0.12.0 重做提取**：思考档（默认 `low`）+ **不设 token 上限**（`maxTokens: 0`）+ **2 分钟时间预算，掐断后带已写内容续跑**（断点续思）+ 先写 `analysis` 判断再产出 **0-3 条** items + 寒暄/空转轮次直接不记 |
| **注入加权（v0.10.0）** | 检索双维 boost：画像 ×3 + principle ×1.5（方法优先）/ event ×0.7（强相关才注入）——"我怎么看待设计"优先于"设计了什么"；预热同序 |
| **降级记忆重写 (v0.12.6)** | 提取瘫痪期间写下的「任务/结果」式降级产物，用修好的提取器**重新处理成正常记忆**（更新原条目、旧文进世界线可回滚；判定无价值的则归档）。工具 `memory_rewrite` 默认只预演，可分批续跑 |
| **会话级汇总 (v0.12.2)** | 逐轮提取之外再补一层："整段会话最后落在哪里"——攒够 N 轮把这段对话交回模型总结成 0-3 条结论（同一个决定被反复修改过，只写最后落定的那个）；与逐轮碎片互补 |
| **纠正既有记忆 (v0.12.2)** | 提取时把库里已有的相关记忆一并交给模型判断：若这轮是在推翻/更正旧记，走**更新**分支（旧内容进世界线、可回滚），而不是新建一条与它并存的矛盾记忆；id 白名单校验，模型编的 id 改不动无关记忆 |
| **遗忘曲线** | 24h 后指数衰减 + 访问加成，惰性批量执行 |
| **会话预热** | `agent/session-start` 注入最近语义记忆（用户画像/项目背景） |
| **KV 缓存友好注入** | 稳定块头 + 确定性排序 + append-only 尾部 + 溯源锚点（`#mem-id`） |
| **GUI 设置面板** | 设置侧边栏「记忆」入口，全量参数 + 7 个功能开关 + 供应商/模型**动态预设下拉** + 密钥输入，改动 **live 生效** |

## 🛠 工具面（暴露给模型）

```
memory_add               主动记录（决策/结论/偏好/教训）
memory_search            检索（语义 + 关键词混合）
memory_forget            删除指定记忆
memory_merge             合并两条相似记忆
memory_purge             清空作用域/全部
memory_list              浏览
memory_stats             统计（含向量/图谱状态）
memory_graph_neighbors   记忆图谱邻域（记忆级 k-hop：相邻记忆 id+边类型+跳数）
memory_graph_communities 社区检测/查看
memory_graph_path        记忆最短路径（记忆 id 序列+边类型链）
memory_graph_link        手动连边（8 型语义关系）
memory_graph_unlink      断边（历史保留）
memory_graph_node        节点详情 + 邻域
memory_versions          世界线版本链（回滚前查看）
memory_rollback          回滚到历史版本（时间旅行）
memory_housekeeping      管家巡检与治理（dryRun=false 执行：合并近乎重复 + 归档陈旧情景快照；consolidate=true 再做 LLM 归并）
memory_archive           归档管理（查看被归档的记忆 / 一键恢复；归档不删除）
memory_rewrite           降级记忆重写（v0.12.6：把提取瘫痪期的「任务/结果」产物交回修好的提取器重新处理成正常记忆；默认预演、可分批续跑）
memory_theme_relabel     存量主题治理（簇级 LLM 重命名；dryRun 只报告 / recluster 先全量重聚类）
memory_events            列出记忆事件（时间+因果聚簇；detect=true 强制重检测）
memory_profile_distill   画像蒸馏（偏好/决策聚合为用户画像；需 refiner 启用）
memory_logs               查看运行日志（写入/注入/检索/巡检/蒸馏/错误全透明）
system_now               获取当前系统时间（本地 + ISO + Unix + 星期 + 时区）
```

## 🏗 架构

```
DSH 运行时 ──pre-step──▶ 注入侧 ──查询──▶ 检索器 ──┬─▶ FTS5（BM25）
   ▲                                              ├─▶ sqlite-vec（KNN）
   └──agent.inject()── 注入侧 ◀──RRF 结果── 检索器 ─┴─▶ 记忆图谱（邻域/社区）
DSH 运行时 ──session/event──▶ 写入侧 ──沉淀/去重──▶ MemoryStore ──SQL──▶ SQLite
                                └──轮次文本──▶ Refiner ──蒸馏──▶ LLM 服务
```

📄 交互式架构图：**[`docs/architecture.html`](docs/architecture.html)**（浏览器打开，或 DSH 右侧预览面板直接渲染）

📚 详细设计：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · 开发历程：[`docs/CHANGELOG.md`](docs/CHANGELOG.md) · 原始设计方案（1406 行）：[`docs/memory-plugin-proposal.md`](docs/memory-plugin-proposal.md) · 路线图（v0.9 系列执行计划）：[`docs/ROADMAP.md`](docs/ROADMAP.md)

### 模块结构（v0.9.8：增量构建；v0.9.7 解耦重构后）

```
lib/index.js           装配壳：settings/init/Web API/管线/工具/ctx.memory（253 行）
lib/config.js          配置 schema + 默认值
lib/util.js            纯函数：scopeOf / formatNow / 注入渲染 / 消息提取 / 凭据读取
lib/store.js           存储层（sqlite + 检索 + 图谱 + 世界线 + 事件 + 日志）
lib/embedder.js        Embedder/Reranker seam（降级链）
lib/refiner.js         LLM 蒸馏提取
lib/graph-snapshot.js  记忆级图谱快照投影
lib/pipelines/        write（沉淀）/ inject（注入）/ preheat（预热）——工厂化，依赖显式注入
lib/tools/            工具注册（time / memory / housekeeping / graph 分域 + shared + index）
client/index.jsx       客户端插槽装配壳
client/settings.jsx    GUI 设置面板
client/graph.jsx       GUI 记忆图谱（力导向画布）
client/graph-geometry.js 主题区域几何（贴合凸包/最小外接圆/就地聚簇/密度核心；纯函数，与守护测试共用）
client/layout-cache.js  布局落盘（收敛坐标存 localStorage，按 id 复用；打开即全局平衡）
client/layout-policy.js 布局计划（质量档位/时间预算/步数上限/自动降档；纯函数，与守护测试共用）
client/logs.jsx        GUI 记忆日志面板
```

🏔 里程碑（compaction-smart，502 行六维度压缩方案）：[docs/compaction-smart-proposal.md](docs/compaction-smart-proposal.md)

## 📦 安装

```sh
# 方式一：官方插件命令（推荐）
dsh plugin --profile web add dsh-advanced-memory   # 已发布到 npm，按包名安装
# 开发期也可用本地路径：
#   dsh plugin --profile web add ./dsh-memory

# 方式二：手动
# 1) 复制本目录到 C:\Users\<user>\.dsh\profiles\web\node_modules\dsh-memory\
# 2) cordis.patch.yml 添加 insert 条目
```

`cordis.patch.yml` 条目示例：

```yaml
- insert:
    - id: dsh-memory
      name: dsh-memory
      config:
        enabled: true
        features:
          autoWrite: true
          valueGate: true
          dedupMerge: true
          preStepInject: true
          manageTools: true
          time: true
          graph: true
```

### ℹ️ 设置面板可见性

GUI 设置面板依赖 `memory` 设置命名空间对 Web 客户端可见。**EAC 5.3 / 内核 0.1.2-alpha.1 起已官方支持**：`dsh-api-settings-controller` 的 `describe()` 自动暴露所有已注册命名空间（含第三方插件），无需任何白名单配置。

> 旧版（<0.1.2-alpha.1）需要把 `memory` 加入宿主 apiproxy 的 `WEB_SETTINGS_NAMESPACES` 白名单（插件侧曾内置自愈 hack，v0.9.21 起已移除，见 `docs/CHANGELOG.md`）。

### 🔁 开发期部署（改完仓库 ≠ 线上生效）

本插件是**手工挂载的 insert 插件**（在 profile 的 `node_modules` 里，不走 pnpm），所以改完仓库必须同步到部署副本：

```bash
node tools/deploy.mjs           # 同步 lib/ 并复验 md5
node tools/deploy.mjs --check   # 只比对（有漂移退出码 1，可用于收尾自检）
```

> 2026-09-17 抓到一次真实漂移：仓库已含 v0.9.31 的降级保护（`degraded` 禁破坏性维度迁移 + 30s 超时），部署副本还停在 9/8 的旧版——于是向量表被 rule 兜底迁移成 256 维，**向量路实际已瘫**，日志里只有一行 warning。改 `lib/` 后先 `--check` 再收工。重启 DSH 才生效（客户端 `lib/client.js` 改动只需刷新页面）。

## ⚙️ 配置（settings.yaml 的 `memory` 段）

```yaml
memory:
  dbFile: ''                # 留空 = ~/.dsh/memory.db
  scope: ''                 # 留空 = global
  injectMaxTokens: 800      # 每次注入 token 预算
  injectMinScore: 0.015     # 注入最低相关分（RRF 融合量纲，三路全中 ~0.049；0.015 ≈ 至少一路排前 13）
  injectPace: steady        # 注入节奏档位：aggressive 激进=每 4 步 / steady 平稳=每 12 步（默认）/ lazy 懒惰=每 30 步 / custom 自定义
  stepInterval: 12          # 仅 injectPace=custom 时生效（1~60）
  maxRecentPerAgent: 6      # 防循环窗口
  maxVersionsPerMemory: 8   # 世界线长度
  features:
    autoWrite: true         # 自动写入（turn/end 沉淀）
    valueGate: true         # 价值门（噪音过滤）
    dedupMerge: true        # 去重合并
    preStepInject: true     # pre-step 自动注入
    manageTools: true       # 管理工具集
    time: true              # 时间维度（版本化世界线）
    graph: true             # 图谱构建
  refiner:
    enabled: false          # LLM 蒸馏提取（默认关，省成本）
    provider: deepseek-official  # 供应商（GUI 下拉预设）
    model: deepseek-v4-flash
    apiKeyEnv: MEMORY_REFINER_API_KEY  # 独立密钥槽（供应商未声明 apiKeyEnv 时生效）
    reasoningEffort: low    # 推理档位（v0.12.0 由 off 改为 low）。注意 off ≠ 关思考：
                            # 适配器把 off 当「不传参数」，思考型模型照样思考、照样吃预算
    maxTokens: 0            # v0.12.0：0 = 不限制（不传该参数）。约束交给下面的时间预算
    timeBudgetMs: 120000    # v0.12.0：单次调用时间预算（2 分钟）；到点掐断并带已写内容续跑
    maxContinuations: 3     # v0.12.0：续跑轮数上限（续跑写不出东西会自动停）
  embedding:
    provider: remote        # rule（离线哈希兜底）| remote（OpenAI 兼容 API）| onnx（预留）
    model: Qwen/Qwen3-VL-Embedding-8B  # 4096 维（硅基流动实测）
    baseUrl: https://api.siliconflow.cn/v1
    apiKeyEnv: MEMORY_EMBEDDING_API_KEY
    cacheSize: 1024
  reranker:
    enabled: false          # RRF 融合后精排（需配置密钥；失败降级 RRF 顺序）
    provider: remote
    model: Qwen/Qwen3-VL-Reranker-8B
    baseUrl: ''             # 留空 = 跟随嵌入端点
    apiKeyEnv: MEMORY_RERANK_API_KEY
    topK: 20                # 精排候选数
    minCandidates: 3        # 候选不足不重排
    rrfWeight: 0.7          # final = w×RRF + (1-w)×重排分
  graphView:
    spring: 0.13            # 图谱力导向：弹簧强度
    repulsion: 1            # 斥力倍率
    damping: 0.3            # 速度阻尼
    gravity: 0.005          # 中心引力
  housekeeping:
    enabled: true           # 管家自动巡检
    interval: 20            # 每沉淀 N 条记忆巡检一次
    maxIntervalHours: 24    # 时间兜底（距上次巡检超 N 小时）
    dedupThreshold: 0.92    # 近重复相似度阈值
    agingDays: 30           # 老化报告天数
    autoApply: true         # v0.12.1：真治理（false = 只报告不动手）
    autoMergeThreshold: 0.95 # 近乎重复的自动合并阈值（0.92~此值留给 LLM 归并）
    archiveEpAfterDays: 45  # 情景快照闲置多少天后归档（0 = 不归档）
  events:
    enabled: true           # 事件分类（时间+因果聚簇，管家自动检测）
    gapHours: 2             # 时间线扫描间隔阈值（相邻记忆间隔 < 2h 且同主题/共享实体 → 同一事件）
  sessionSummary:
    enabled: true           # v0.12.2 会话级汇总（"整段会话最后落在哪里"）
    rounds: 12              # 累积多少轮后汇总一次
  logging:
    enabled: true           # 运行日志（背后做了什么全透明）
    maxRows: 2000           # 日志保留条数（惰性裁剪）
```

**密钥自动跟随**：选中供应商后，GUI 密钥输入的目标引用自动切换为该供应商声明的 `apiKeyEnv`；密钥本体写入 `~/.dsh/.credentials.yaml`（私有文件），不进设置文档、不进记忆库、界面不回显。

### 🩺 连通性自检（v0.11.1）

设置面板顶部的「连通性自检」按钮打 `GET /dsh-memory/health?llm=1`，对**嵌入 / 重排 / 提取**各发一次真实最小请求，并同时报出配置值、凭据存在性、以及向量路的实况（谁在算向量、几维、多少条、是否降级）。

为什么要它：「● 已配置」只证明凭据文件里有这个键，不证明它**能用**。本机真实事故——硅基流动余额 402 → 嵌入静默降级到 rule 哈希、重排每次白等，界面上却一切正常；`memory_stats` 也只回一个 `vector: true`。现在 `stats()` 一并返回 `vecDim / vecRows / embedder / degraded`：`embedder: "rule"` 就是那句一直没被说出口的实话。

| 字段改动后的生效时机 | 字段 |
|---|---|
| **即时生效（live，读配置时才取值）** | `scope`、`injectMaxTokens`、`injectMinScore`、`injectPace`、`stepInterval`、`maxRecentPerAgent`、`features.*`（`time` 除外）、`refiner.*`、`housekeeping.*`、`events.*`、`logging.*`、`graphView.*` |
| **需重启 DSH（初始化期构造）** | `enabled`、`dbFile`、`maxVersionsPerMemory`、`features.time`、`embedding.*`、`reranker.*`（含 `topK`/`minCandidates`/`rrfWeight`） |
| **需刷新页面** | 客户端面板与图谱/日志面板（`lib/client.js` 产物） |

> 切换嵌入模型会在**重启后**触发向量库重建：维度变了就清空向量表并全量重嵌入（期间语义检索暂弱，FTS/关键词照常）；远程嵌入初始化失败则进入降级态暂停向量路（v0.9.31 保护，不破坏现有向量）。

## 🧪 测试

```bash
node test.mjs         # 阶段一回归（16 项）
node test-phase2.mjs  # 阶段二专项（18 项：向量/图遍历/遗忘/merge-purge/社区）
node test-phase3.mjs  # 阶段三专项（17 项：世界线回滚/8 型边/时间旅行）
node test-embedder.mjs # 嵌入/重排 seam 单测（24 项：rule/remote/缓存/降级链/rerank 融合与缓存/向量独有命中/真实 API 验「当前配置的模型」）
node test-health.mjs  # 连通性自检专项（26 项：探针真发请求/402 原文透传/降级态显形/未启用不假检/不抛错/端点日志行字段名对齐）
node test-refiner-thinking.mjs # 提取器专项（50 项：不设 token 上限/思考流收集/时间预算掐断+断点续跑/空输出救回/不接话即停/续跑上限/跑题重试/多条目与旧格式/items 空不写库/价值门/关键词泛词过滤）
node test-housekeeping.mjs # 管家/存储专项（30 项：去重/老化/meta/触发/touch/迁移幂等/多 scope/日志）
node test-events.mjs    # 事件分类专项（21 项：时间线扫描/聚合切分/幂等/级联/gap 敏感/before 方向修正/主题过滤/空库）
node test-tool-add.mjs  # 工具写入专项（20 项：memory_add 必走图谱连边/关图与 ep 不连/abstract+theme 透传/2-gram 碎片过滤/content 归一化/写后可检索）
node test-governance.mjs # 管家治理专项（53 项：归档退出检索且可恢复/归并是合成不是堆叠/源记忆归档不删除/并查集成团/dryRun 与 apply 边界/陈旧 ep 判据/stats 分开计数/memory_archive list+restore/归并器）
node test-rewrite.mjs   # 降级记忆重写专项（15 项：任务/结果拆分 / 候选筛选防空数组假通过 / 重写走更新且旧文进世界线）
node test-conversation-flow.mjs # 对话流程专项（27 项：纠正走更新既有记忆而非新建/旧内容进世界线可回滚/模型编的 id 改不动无关记忆/混合一轮/supersedes 清洗/提取时可见已知记忆/会话级汇总只收结论）
node test-incremental.mjs # 增量构建专项（21 项：主题聚类增量/事件水位线增量/尾部合并/旧事件保留/维度迁移自愈/全量对齐）
node test-update-append.mjs # 更新拼接专项（9 项：更新内容无条件接末尾/持续追加/重复片段去重/+N 版本步进）
node test-edge-types.mjs   # 边类型专项（9 项：mentions 共现快照/before 收紧/泛词与跨主题不连/beforeAudit dryRun+apply）
node test-keyword-filter.mjs # 关键词稀有化专项（8 项：pickRareEntities 剔泛词/稀缺升序/graphLink 硬过滤/单实体与停用词不建）
node test-profile.mjs   # 画像分类专项（16 项：scopeOf 三态/预热画像/aspect 读写/蒸馏 mock LLM；需副本环境）
node test-crash-safety.mjs # 防崩溃容错（10 项：settings 失败兜底/坏库停用/单工具跳过/正常路径）
node test-link-suggest.mjs    # 语义连边判定专项（18 项：四道闸门/去重/上限/层级/确定性；纯函数）
node test-semantic-links.mjs  # 语义连边集成专项（11 项：真实 store + 构造向量，覆盖 KNN/MNN/落边/回滚口径）
node test-graph-geometry.mjs # 主题区域几何 + 布局缓存 + 布局策略专项（66 项：凸包贴合/外扩精度/最小外接圆最优性与确定性/就地聚簇/密度核心/平移跟随；纯函数，无需副本环境）
node test-inject-pipeline.mjs # 注入管线专项（55 项：decision 合并注入/步距必检/三档节奏（激进 4·平稳 12·懒惰 30）/自定义档/档位表与 UI 同源/日志 interval/去抖/兜底/守卫/reject）
                          # 注：依赖 @deepseek-ai 包，需在部署副本或 harness 环境运行
node test-record.mjs   # 记录质量自检入口（写入→语义召回→图谱全链路；--live 生产库只读）
node rebuild-graph.mjs # 图谱重建运维脚本（真嵌入归一化重建 + 语义边）
```

## 📄 License

MIT
