# dsh-memory

> **dsh-memory** — Advanced auto-memory plugin for DSH (DeepSeek Harness): layered memory (episodic / semantic / profile), knowledge graph, worldline versioning, vector + RAG retrieval, and incremental graph building. Local SQLite, MIT-licensed. (Body of this README is in Chinese.)

DSH（DeepSeek Harness）进阶自动记忆插件——**用户每条消息都触发一次检索注入**（v0.16.0，可按需关掉），agent 自主工作的其余步骤按节奏补充相关记忆，并在每个轮次结束时自动沉淀新记忆。

> 核心诉求：记忆不只是"清单"，而是会生长的知识网络：分层 + 图谱 + 世界线（时间维度）+ 向量语义检索。

## ✨ 功能总览

| 能力 | 说明 |
|---|---|
| **用户消息触发检索 (v0.16.0)** | **每条用户消息（文本变了）必检一次，不受步距节流限制**。修的是这个缺口：步距按"步"计，而一轮用户消息通常只走几步——平稳档（12 步）下用户连问几句新问题，整段都在吃几句之前那次检索的结果。工具步与自主轮次仍按步距节奏，两条触发源共用下游的检索/预算/去抖（日志 `trigger: user-message \| interval` 可逐条对账） |
| **写入侧决策门 (v0.16.0)** | **只在写入侧**：轮次结束时问一次本机决策模型（StartLux-Decision 9B，HTTP 8090，输出 0 token，实测 0.3~0.9 秒）「这段对话值得记吗」，答"不值得"就省掉那次几十秒的 LLM 提取（改落一条 ep 快照，记录不丢）。**非对称采信**——只有它高把握说"不值得"（门槛默认 0.9）才起作用；服务没起 / 超时 / 返回形状不对 / 没把握 / 本轮被取消一律照常提取，失败后冷却 5 分钟。**检索路径上没有决策门**（2026-10-06 定）：用户消息来了就直接查库，不问"要不要查"——查库是本职，加一道判断只会在关键路径上多花 0.4~1.2 秒，还要承担"判错就漏检索"的风险 |
| **自动注入** | `agent/pre-step` 检索相关记忆并**并入本步 decision**（不额外占一个回合）；常驻块 + 检索块 token 预算独立 + 块 hash 去抖 + 防循环窗口 |
| **常驻注入粒度 (v0.18.0)** | 钉选记忆的注入时机可配（`pinnedInjection`，默认 **session**）：**session** = 会话首轮带一次完整清单，之后只在「新钉选 / 取消钉选 / 已钉内容被改」时补一条**增量**（只报变化了什么，块尾声明"未列出的条目仍然有效"），不重复发整份；**step** = 旧行为（每步随注入块抵达），一键退回便于对照。两种档位下常驻的语义完全一样——**不看相关性、不看得分、不受节流**，改的只是时机与去重。增量那一步不受步距节流（否则平稳档下钉完要等十来步才看得见），且不发检索。长会话被压缩/清空（步号倒退）时自动重发整份兜底 |
| **自动沉淀** | `turn/end` 写入 + 价值门过滤 + Jaccard 去重合并（相似记忆更新而非新建） |
| **分层记忆** | `ep`（情景，turn 快照）/ `sm`（语义，长期知识），**scope 项目隔离**：按会话工作目录自动分层（workspaceRegistry fallback），画像跨项目公共层 |
| **时间维度（世界线）** 🐛 | 更新追加版本，旧版本保留但隐藏（不参与检索/注入）；`maxVersions` 滚动裁旧 + 回滚链 |
| **向量语义检索** | `sqlite-vec` KNN 余弦 + FTS5 BM25 + 关键词三路 **RRF 融合**；扩展加载失败优雅降级；**reranker 后置精排**（RRF 候选 → 融合分 `w×RRF+(1-w)×rerank`，失败降级 RRF 零损失） |
| **记忆图谱** | 实体节点 + 边（共现/因果/时间演化…）、k-hop 邻域扩散、BFS 最短路径、社区自动聚类；**力导向参数（弹簧/场强/平衡间距/远场引力上限/限速/阻尼/邻域半径）settings 可调、live 生效**（**v0.15.1 起没有"中心引力"这个东西**：模型是每个点自带半径的邻域场，布局的远近由**种子**决定，力只管推开与贴合）；**记忆级边独立表（memory_links）**——GUI 投影直读、记忆级 BFS/邻域、旧实体边自动迁移；**时间维度可视化**：更新过的节点有金色年轮（环数=更新次数）、新旧色温（库内相对映射）、时间窗筛选、hover 时间标签 |
| **增量构建 (v0.9.8)** | 主题聚类持久化簇（theme_clusters + cluster_id）+ 事件检测水位线（meta.event_scan_at）——启动/巡检不再全量重建派生数据，O(新增+尾部) 而非 O(全量) |
| **联系显性化 (v0.9.11)** | 记忆级图谱显示多种联系：8 型边各配颜色/线型 + hover 边类型 + mentions 强共现（共享≥2 实体）；before 演化收紧（稀有实体+同主题），beforeAudit 审计清理假演化 |
| **记忆管家** | 自动巡检（与对话轮数解耦：每沉淀 20 条记忆 或 距上次超 24h 触发，时间戳持久化）：全局去重扫描（余弦近重复）+ 老化报告（长期闲置低价值）。**v0.12.1 真治理**：不再只报告不动手——近乎重复择优保留一条、其余**归档**（不删除、可恢复），陈旧情景快照归档，**LLM 归并**把讲同一件事的一团记忆合成一条更完整的结论（取代原来的横线拼接）；治理动作在工具报告、日志面板、会话预热三处可见 |
| **事件分类** | 时间连续 + 因果相关（同主题/共享实体）的记忆聚簇——"这段记忆属于哪件事"（区别于 theme 的"在讲什么"）；时间线扫描纯 rule 算法，管家自动维护；`memory_events` 工具 + 图谱事件筛选/高亮 |
| **画像分类** | 关于用户本人的稳定信息（身份/偏好/习惯/背景/沟通方式）单独分类：type=profile + aspect 子域；refiner 自动识别；**会话预热画像优先注入**（"用户是谁"优先于"最近干了啥"）；`memory_profile_distill` 画像蒸馏 |
| **运行日志** | 背后运行了什么完全透明可见：写入/注入/检索/巡检/蒸馏/错误全链路埋点；GUI「记忆日志」面板（侧边栏入口 + 3s 轮询 + 筛选）+ `memory_logs` 工具 + `/dsh-memory/logs` API |
| **LLM 蒸馏（refiner）** | 独立模型把高噪声轮次提取为自包含结论（决策/偏好/教训分类）+ **双输出（v0.10.0）**：`abstract` 抽象层级（principle=可复用原则/方法 / event=一次性事件产出）+ `theme` 名词标签（如"四级备考"）；失败自动降级规则路径；**v0.12.0 重做提取**：**不设 token 上限**（`maxTokens: 0`）+ **2 分钟时间预算，掐断后带已写内容续跑**（断点续思）+ 先写 `analysis` 判断再产出 **0-3 条** items + 寒暄/空转轮次直接不记；**v0.16.0 起默认不思考**（`reasoningEffort: off`，实测关掉后同一次请求 2593ms→957ms、`reasoning_tokens` 47→0——省时省钱，提取本身不受影响） |
| **注入加权（v0.10.0）** | 检索双维 boost：画像 ×3 + principle ×1.5（方法优先）/ event ×0.7（强相关才注入）——"我怎么看待设计"优先于"设计了什么"；预热同序 |
| **降级记忆重写 (v0.12.6)** | 提取瘫痪期间写下的「任务/结果」式降级产物，用修好的提取器**重新处理成正常记忆**（更新原条目、旧文进世界线可回滚；判定无价值的则归档）。工具 `memory_reprocess` 默认只预演，可分批续跑（**v0.14.0 从 `memory_rewrite` 改名**：那名字与 DSH 内核自带的 `memory_rewrite` 撞车，同进程里互相遮蔽） |
| **会话级汇总 (v0.12.2)** | 逐轮提取之外再补一层："整段会话最后落在哪里"——攒够 N 轮把这段对话交回模型总结成 0-3 条结论（同一个决定被反复修改过，只写最后落定的那个）；与逐轮碎片互补 |
| **纠正既有记忆 (v0.12.2)** | 提取时把库里已有的相关记忆一并交给模型判断：若这轮是在推翻/更正旧记，走**更新**分支（旧内容进世界线、可回滚），而不是新建一条与它并存的矛盾记忆；id 白名单校验，模型编的 id 改不动无关记忆 |
| **遗忘曲线** | 24h 后指数衰减 + 访问加成，惰性批量执行 |
| **会话预热** | 会话开场先把最近语义记忆（用户画像/项目背景）喂给模型。**v0.14.0 双通道**：0.2.0-rc.2 走 `agent/created` + `systemPrompt.section()`（每步重算、不占对话回合）；0.1.x 走老的 `agent/session-start` + `agent.inject()`（消息级）。按能力自动择一，可用 `features.preheatRoute` 强制 |
| **KV 缓存友好注入** | 稳定块头 + 确定性排序 + append-only 尾部 + 溯源锚点（`#mem-id`） |
| **GUI 设置面板** | 设置侧边栏「记忆」入口，全量参数 + 7 个功能开关 + 供应商/模型**动态预设下拉** + 密钥输入，改动 **live 生效** |

## 🛠 工具面（暴露给模型）

```
memory_add               主动记录（决策/结论/偏好/教训）
memory_search            检索（语义 + 关键词混合）
memory_forget            删除指定记忆
memory_merge             合并两条相似记忆
memory_purge             清空作用域/全部
memory_list              浏览（可按 scope/layer/type 过滤）
memory_pin               钉选/取消钉选常驻记忆（不看相关性、恒定/会话级注入）
memory_stats             统计（含向量/图谱状态）
memory_reembed           维度迁移或嵌入失败后补写缺失向量
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
memory_reprocess         降级记忆重写（v0.12.6 起；v0.14.0 由 memory_rewrite 改名以避免与内核工具撞名：把提取瘫痪期的「任务/结果」产物交回修好的提取器重新处理成正常记忆；默认预演、可分批续跑）
memory_theme_relabel     存量主题治理（簇级 LLM 重命名；dryRun 只报告 / recluster 先全量重聚类）
memory_events            列出记忆事件（时间+因果聚簇；detect=true 强制重检测）
memory_profile_distill   画像蒸馏（偏好/决策聚合为用户画像；需 refiner 启用）
memory_logs               查看运行日志（写入/注入/检索/巡检/蒸馏/错误全透明）
memory_batch_status       批量提取状态（候选池攒了多少、哪些桶快够门槛、最近归纳了什么）
system_now               获取当前系统时间（本地 + ISO + Unix + 星期 + 时区）
```

## 🏗 架构

```
DSH 运行时 ──pre-step──▶ 注入侧 ──查询──▶ 检索器 ──┬─▶ FTS5（BM25）
   ▲                                              ├─▶ sqlite-vec（KNN）
   └──decision.messages── 注入侧 ◀──RRF 结果── 检索器 ─┴─▶ 记忆图谱（邻域/社区）
DSH 运行时 ──session/event──▶ 写入侧 ──沉淀/去重──▶ MemoryStore ──SQL──▶ SQLite
                                └──轮次文本──▶ Refiner ──蒸馏──▶ LLM 服务
```

📄 交互式架构图：**[`docs/architecture.html`](docs/architecture.html)**（浏览器打开，或 DSH 右侧预览面板直接渲染）

📚 架构文档（**v0.20.0，按主题分 11 章**）：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)（总入口）→ [`docs/architecture/`](docs/architecture/README.md)（模块构造 / 数据模型 / 写入 / 检索 / 注入 / 图谱 / 遗忘与管家 / 配置与双内核 / 集成与工具面 / 工程约定 / 已知限制）· 开发历程：[`docs/CHANGELOG.md`](docs/CHANGELOG.md) · 原始设计方案（1406 行）：[`docs/memory-plugin-proposal.md`](docs/memory-plugin-proposal.md) · 路线图：[`docs/ROADMAP.md`](docs/ROADMAP.md)

### 模块结构（v0.20.0）

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
# 方式一（推荐，0.2.0-rc.2 与 0.1.x 都适用）：官方插件命令
# 本包声明了 dsh.bundle.patch（见 package.json），安装时自动把本包追加进 profile 的
# dsh.profile.bundles —— 不需要手改 profile 的任何文件。
dsh plugin --profile web add ./dsh-memory

# 方式二：手工挂载（老内核/老流程；0.2.x 上也能用，但**绝不能与方式一同时存在**）
# 1) 复制本目录到 <profile>/node_modules/dsh-memory/
# 2) 在 profile 的 cordis.patch.yml 里加一条 insert（见下）
```

> ⚠️ **先读：npm 上的名字与仓库对不上**
> `dsh-memory` = 0.1.0（旧物）、`dsh-advanced-memory` = 0.9.17（落后仓库四个 minor），**本仓库这份 0.19.0 从未发布**。
> 想装本仓库的版本，只能用本地路径（上面的 `add ./dsh-memory`）或先自己 `npm publish`。
> 另外：方式一用的 entry id 是 `memory`（随包 patch 里写死的），方式二手工行历史上用的是 `dsh-memory`——**客户端两个 id 都认**，所以换挂载方式时设置面板不会掉，但两条挂载行同时存在会让 loader 报 duplicate，切换前请先删旧行。

`cordis.patch.yml` 条目示例（仓库根的随包 patch 只有 `disabled` 守卫 + 这一条；手工挂载照抄 `insert` 部分即可）：

```yaml
- insert:
    - id: memory
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

### ℹ️ 设置面板可见性（两代内核的机制不一样，v0.14.0 起两条都走通）

设置面板出不出内容，取决于**内核那一代怎么"注册"设置**：

| 内核 | 机制 | 本插件怎么适配 |
|---|---|---|
| **0.1.x**（≤0.1.7） | `ctx.settings.register(namespace, Config, {base, applies})`，命名空间是自由字符串 | 探测到服务上有 `register` 就照老样子调用（`ns = 'memory'`） |
| **0.2.0-rc.2** | **没有 `register` 了**。entry 的 `Config` 就是注册；`describe()` 按 **profile entry id** 列出表单，且**只有标了 `.volatile()` 的字段会出现** | `Config` 整表标 `.volatile()`；entry id 取自己那条挂载行的 id（`memory`，兜底 `dsh-memory`）；客户端改走 `ctx.configForms.get(entryId)` |

这就是 `lib/config.js` 里 `Config = volatileTable(z.object(...))` 和 `lib/compat.js` 存在的原因——**同一个包在两条内核线上都要能显示、能改**。仍然：0.2.0-rc.2 上**没有 volatile 标记的 entry 在设置页里根本不出现**（不是显示成灰）。

### 🔁 开发期部署（改完仓库 ≠ 线上生效）

三种形态，**先认清楚跑的是哪一份**再动手：

- **方式一（`dsh plugin add`）**：包作为 pnpm 依赖装在 profile 里，改仓库**不会**影响线上，要重新 `add`（或让 pnpm 走本地链接）。
- **方式二（Junction / 符号链接）**：profile 的 `node_modules/dsh-memory` 指向仓库，**改仓库即改线上代码**——只需重启该实例（客户端改动再刷新页面）。查法：`Get-Item "<profile>\node_modules\dsh-memory" | Select LinkType,Target`。2026-10-06 实测本机 `web-2` 就是这种（Junction → 开发目录），所以那次改动根本不需要同步副本。
- **方式三（手工副本）**：包是 profile `node_modules` 里的真实目录，改完仓库必须同步进去——用仓库自带脚本（它只认默认 `~/.dsh` 下的那份副本）：

```bash
node tools/deploy.mjs                     # 同步 lib/ 与 package.json 并复验 md5
node tools/deploy.mjs --check             # 只比对（有漂移退出码 1，可用于收尾自检）
node tools/deploy.mjs --profile <name>    # 换 profile（默认 web-desktop）
```

> ⚠️ `deploy.mjs` 的目标写死为 `~/.dsh/profiles/<profile>/node_modules/dsh-memory`。**DSH_HOME 不在默认位置时，它认不出真正在跑的那个实例**：2026-10-06 实测 `DSH_HOME` 指向别处的 `web-2` 走 Junction，而脚本默认指向默认家目录下一份停在 0.13.3 的旧副本。先按端口查进程命令行（`Get-NetTCPConnection -LocalPort <port> | Select OwningProcess` → `Get-CimInstance Win32_Process`）确认 DSH_HOME 与 profile，再决定要不要同步。

> 2026-09-17 抓到一次真实漂移：仓库已含 v0.9.31 的降级保护（`degraded` 禁破坏性维度迁移 + 30s 超时），部署副本还停在 9/8 的旧版——于是向量表被 rule 兜底迁移成 256 维，**向量路实际已瘫**，日志里只有一行 warning。改 `lib/` 后先 `--check` 再收工。重启 DSH 才生效（客户端 `lib/client.js` 改动只需刷新页面 + 重建产物 `node build-client.mjs`）。

## ⚙️ 配置（settings.yaml 的 `memory` 段）

```yaml
memory:
  dbFile: ''                # 留空 = ~/.dsh/memory.db
  scope: ''                 # 留空 = global
  injectMaxTokens: 800      # 每次注入 token 预算
  injectMinScore: 0.02      # 注入最低相关分（RRF 融合量纲，三路全中 ~0.049；0.02 ≈ 至少一路排前 10）
  injectPace: steady        # 注入节奏档位：aggressive 激进=每 4 步 / steady 平稳=每 12 步（默认）/ lazy 懒惰=每 30 步 / custom 自定义
  stepInterval: 12          # 仅 injectPace=custom 时生效（1~60）
  pinnedLimit: 8            # 常驻（钉选）记忆每次注入最多带几条
  pinnedMaxTokens: 600      # 常驻块的独立 token 预算（不与被检索到的记忆抢 injectMaxTokens）
  pinnedInjection: session  # v0.18.0 常驻注入粒度：session 会话级（默认，首轮一次+变化时增量）/ step 每步（旧行为）
  maxRecentPerAgent: 6      # 防循环窗口
  maxVersionsPerMemory: 8   # 世界线长度
  features:
    autoWrite: true         # 自动写入（turn/end 沉淀）
    valueGate: true         # 价值门（噪音过滤）
    dedupMerge: true        # 去重合并
    preStepInject: true     # pre-step 自动注入
    userMessageTrigger: true # v0.16.0 每条用户消息都重新检索一次（不看步距）；关掉则回到纯步距节奏
    writeGate: true         # v0.16.0 轮次结束先预筛"这段对话值得记吗"（只有高把握说不值得才省 LLM）
    manageTools: true       # 管理工具集
    time: true              # 时间维度（版本化世界线）
    graph: true             # 图谱构建
  decision:                 # v0.16.0 写入侧决策门（本机 StartLux-Decision 的接入参数；检索路径不用它）
    endpoint: http://127.0.0.1:8090/v1/systemone
    timeoutMs: 2000         # 单次判断超时（200~10000）；到点即放弃、照常提取
    writeMinConfidence: 0.9 # 采信门槛（0.5~0.99）：只有把握度不低于它才采信"不值得记"
  refiner:
    enabled: false          # LLM 蒸馏提取（默认关，省成本）
    provider: deepseek-official  # 供应商（GUI 下拉预设）
    model: deepseek-v4-flash
    apiKeyEnv: MEMORY_REFINER_API_KEY  # 独立密钥槽（供应商未声明 apiKeyEnv 时生效）
    reasoningEffort: off    # v0.16.0 默认不思考。⚠️ 这里的 off 由插件翻译成「不带该参数」——
                            # pi-ai 的 deepseek 格式下，只要该字段存在（哪怕是 'off'）就会发出
                            # thinking:{type:'enabled'}；不带它才会按模型的 off 映射发 disabled。
                            # 还要求 provider 侧给该模型声明非 null 的 off 映射（本机已声明，
                            # 见 README §开发期部署 同级的 profile 配置）。改回思考就填 low/high/max
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
    field: 1                # 邻域场强度倍率
    spacing: 1.2            # 平衡间距（×k）：比它近互相排斥、比它远互相吸引
    attract: 0.06           # 远场引力峰值（必须小：引力是累加的、斥力是封顶的）
    maxSpeed: 4             # 单帧速度上限（"拖动乱飞"的物理护栏）
    damping: 0.3            # 速度阻尼
    range: 4.5              # 邻域半径（×k）：每个节点自己的影响范围
    wobble: 0.04            # 常活微动幅度（收敛后仍缓慢游走）
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
| **即时生效（live，读配置时才取值）** | `scope`、`injectMaxTokens`、`injectMinScore`、`injectPace`、`stepInterval`、`pinnedLimit`、`pinnedMaxTokens`、`pinnedInjection`、`maxRecentPerAgent`、`features.*`（`time` 除外）、`refiner.*`、`housekeeping.*`、`events.*`、`logging.*`、`graphView.*` |
| **需重启 DSH（初始化期构造）** | `enabled`、`dbFile`、`maxVersionsPerMemory`、`features.time`、`embedding.*`、`reranker.*`（含 `topK`/`minCandidates`/`rrfWeight`） |
| **需刷新页面** | 客户端面板与图谱/日志面板（`lib/client.js` 产物） |

> 切换嵌入模型会在**重启后**触发向量库重建：维度变了就清空向量表并全量重嵌入（期间语义检索暂弱，FTS/关键词照常）；远程嵌入初始化失败则进入降级态暂停向量路（v0.9.31 保护，不破坏现有向量）。

## 🧪 测试

```bash
node tools/run-tests.mjs            # 全量：发现 tests/ 下全部套件，逐条汇总
node tools/run-tests.mjs --offline  # 离线：跳过需要 @deepseek-ai 私有 peer 包的套件
```

28 套 / 约 980 项断言。按域分：

| 方向 | 套件 |
|---|---|
| 存储与检索 | test、test-phase2、test-phase3、test-embedder、test-semantic-links、test-link-suggest |
| 写入与提取 | test-refiner-thinking / slim / truncation / retry、test-conversation-flow、test-write-gate、test-rewrite |
| 注入 | test-inject-pipeline（会话级常驻 / 用户消息触发 / 节流 / 去抖） |
| 图谱与布局 | test-graph-geometry、test-graph-field、test-edge-types、test-keyword-filter |
| 治理与派生 | test-housekeeping、test-governance、test-events、test-incremental、test-profile |
| 可靠性与运维 | test-crash-safety、test-health、test-record（--live 只读） |

注：test.mjs、test-inject-pipeline、test-profile、test-tool-add、test-crash-safety、test-governance、test-rewrite 依赖 @deepseek-ai 私有 peer 包，在部署副本或 harness 环境运行；CI 只跑离线白名单。

## 📄 License

MIT
