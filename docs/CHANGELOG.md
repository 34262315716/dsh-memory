# 开发历程（CHANGELOG）

> 从"一条注入插件的想法"到"带图谱与向量检索的长期记忆子系统"的完整轨迹。技术方案演进见 [`memory-plugin-proposal.md`](memory-plugin-proposal.md)。

## v0.9.0 — 事件分类（ROADMAP 阶段 A）：时间+因果的记忆聚簇（2026-08-16）

按 ROADMAP 阶段 A 落地用户提出的"事件分类"——区别于 theme（语义相似）的时间性分类（"这段记忆属于哪件事"）。

### 数据与算法
- 新表 `events`（id/label/start_at/end_at/representative）+ `event_members`（记忆删除级联）
- **时间线扫描（纯 rule，无 LLM）**：sm 按 created_at 排序，相邻两条「间隔 < gapHours（默认 2h）**且**（同 theme 非空 **或** 共享实体 label 交集）」→ 同一事件；否则切新事件（单记忆自成一事件）
- 全量重建 + 事件 id 确定性（`ev-首成员记忆id`，重建稳定）；label = 成员 theme 众数（无 → 首成员 type）
- **踩坑**：共享实体判定初版比 node_id 交集——但 graphLink 的实体节点是记忆私有的（id 含 memoryId），不同记忆同 label 是不同节点 → 改为 **label 集合交集**（node_memories 与 nodes.memory_id 双源合并）
- store 方法：`detectEvents(gapMs)` / `events(limit)` / `eventMap()`

### 接线
- settings 新增 `events` 段（enabled/gapHours）；启动初始化 + 管家巡检（双驱动）自动重建事件；派生数据，不碰记忆本体
- **`memory_events` 工具**：列出事件（label/时间段/成员摘要），detect=true 强制重检测
- **图谱快照**：nodes 加 eventId + events 列表；**GUI 事件筛选下拉**（与时间筛选并列）——选中事件成员高亮、其余降透明度（经 ref 通知画布，不重建模拟）

### 验证
- 新测试 test-events.mjs 14 项（组内聚合/组间切分/同主题/共享实体/孤立记忆/幂等/级联/gap 敏感/空库）
- 七套测试 113 项全过；client bundle 重建（71KB）；部署副本同步（md5 一致）
- 版本号 0.8.9 → 0.9.0

## v0.8.9 — 图谱打开动画：预热模拟 + 立即全景 + 中心扩散显现（2026-08-16）

用户反馈：点开图谱会抖动（环形布局展开），再突然跳变成全景图；期望"一开始就是全景图，从中间向两边平滑快速显现"。

- **预热模拟**：初始化时离线跑 40 步力导向（首帧即接近收敛的稳定布局，消除"环形展开抖动"）
- **立即全景**：fit-to-view 从"模拟收敛后跳变"改为"预热后立即执行"——打开第一帧就是全景，不再有突然缩放
- **中心扩散显现动画**：节点按距视口中心距离延迟显现（中心先亮，向两边扩散，延迟占 0~55% 动画时长），easeOutCubic 淡入 + 半径从 0 放大（700ms）；边整体淡入（350ms）——"从中间向两边平滑快速显现"的预期效果
- 初始 α 0.7 → 0.45（首帧运动更温和）
- 移除 loop 中过时的延迟 fit 条件；client bundle 重建（69KB）并同步部署副本；版本号 0.8.8 → 0.8.9

## v0.8.8 — 图谱面板毛玻璃质感 + 左下角退出键（2026-08-16）

用户反馈 v0.8.7 的 top:56 避让方案露出硬边界，要求：退出键放左下角、背景改毛玻璃、点阵保留。

- **面板回到全屏**（inset: 0）+ **毛玻璃背景**：`rgba(16,16,18,0.72)` + `backdrop-filter: blur(22px) saturate(1.2)`（含 Webkit 前缀）——没有硬边界，下层内容模糊透出，遮挡观感统一
- **退出键移到左下角**（absolute left:16 bottom:16）：彻底远离顶栏不被遮挡；毛玻璃风按钮（半透明白 + blur(10px) + 阴影），文字"退出图谱（Esc）"；Esc 监听保留双路径
- **标题栏简化**：移除右上关闭按钮，只留"记忆图谱"标题，padding-top 44px 避开顶栏（标题不被原生层切掉）
- **点阵保留**：Canvas 内 Obsidian 定位网格不动
- **图例移到右下角**（right:14 bottom:10）：避免与左下角退出键重叠
- client bundle 重建（69KB）并同步部署副本（md5 一致）；版本号 0.8.7 → 0.8.8

## v0.8.7 — 图谱面板避开应用顶栏（关闭按钮被遮修复）（2026-08-16）

用户定位：应用界面顶端栏（EAC 标题栏/顶栏）遮住全视口面板顶部的关闭按钮（v0.8.6 提高 z-index 仍被遮，说明是层叠/原生层问题，光提层级不够）。

- **面板整体下移**：`inset: 0` → `top: 56`（left/right/bottom 仍为 0）——面板从顶栏下方开始，顶栏区域保持应用原样（可点击），关闭按钮与标题栏不再被遮
- **z-index 3000 → 9999**：防其他 DOM 覆盖层（双保险）
- 连带受益：图谱画布内部元素（时间筛选工具栏 top:10、图例 bottom:10）随面板下移自然避开顶栏
- client bundle 重建（68KB）并同步部署副本（md5 一致）；版本号 0.8.6 → 0.8.7

## v0.8.6 — GUI 修复：设置面板滚动 + 图谱 Esc 退出（2026-08-16）

用户反馈两个 GUI 问题：
- **设置面板显示不全**：内容超高（检索注入/功能开关/refiner/嵌入重排/图谱手感/管家共 6 区块）且面板无滚动——根 div 加 `overflowY: auto + maxHeight: calc(100vh - 24px)`
- **图谱全视口面板看不见关闭按钮**：zIndex 1200 → 3000（防覆盖层遮挡）；关闭按钮强化（加大 padding、提亮、加"（Esc）"提示）
- **新增 Esc 关闭**：面板打开时挂 window keydown 监听，Escape → 关闭（关闭按钮被遮挡时的键盘兜底路径），关闭时移除监听
- client bundle 重建（68KB）并同步部署副本（md5 一致）；版本号 0.8.5 → 0.8.6

## v0.8.5 — system_now 时间工具 + 会话预热带时间戳（2026-08-16）

用户需求："让你可以看见现在的实时时间"（模型无系统时钟感知，此前只能靠 bash date）。

- **`system_now` 工具**：模型按需调用获取当前系统时间（local/date/time/weekday/tz/iso/unix），零注入开销、永远新鲜——主方案
- **会话预热加时间戳**：`agent/session-start` 预热块头行带"当前时间：YYYY-MM-DD HH:mm:ss 周X"——会话开始即有时间锚点
- **设计取舍**：不在 pre-step 注入块里加时间——时间每步变化会破坏"稳定块头 + append-only 尾部"的 KV 缓存友好注入原则（去抖失效）；按需工具 + 会话锚点两条路足够
- `formatNow()` 模块级 helper（导出，可测）；test-crash-safety 工具清单扩至 18 项（守护测试 10/10 全过）
- 版本号 0.8.4 → 0.8.5；部署副本已同步

## 起源：需求（2026-08-14 上午）

用户原话："我一直想要做一个插件可以自动注入当前 agent 在做的事情相关的记忆，不需要用户的消息就可以触发注入。"

DSH 提供的原生机制恰好匹配：`agent/pre-step` 每步触发（不依赖用户消息）+ `agent.inject()` 排队模型可见上下文。当天即完成第一版原型并跑通闭环。

## v0.1.0 — dsh-auto-memory（原型，同日）

- 关键词匹配 + JSON 文件存储（`~/.dsh/auto-memory.json`）
- turn/end 无条件沉淀整轮、pre-step 内存遍历注入
- **验证了核心闭环**：写入（turn/end 落盘）→ 检索（关键词命中）→ 注入（agent.inject）全链路工作

## 设计期（同日，pro 模型协作）

- 用 DSH workflow 子代理 + `deepseek-v4-pro` 产出 1406 行完整方案：分层记忆（ep/sm）、SQLite 底座、记忆图谱（节点三型 + 边八型）、功能开关矩阵（§16）、**时间维度世界线**（§17，"四维虫子"比喻）
- 关键设计决策（评审阶段追加）：KV 缓存友好注入、中文检索（trigram + 子串兜底）、评测与注入审计、权威性闭环、settings 白名单、写冲突语义

## v0.2.0 — dsh-memory 阶段一（SQLite 基线）

- `node:sqlite` 单库（WAL + STRICT）：memories / memory_versions / memories_fts(FTS5 trigram) / nodes / edges
- 分层数据模型 + 价值门 + Jaccard 去重合并
- 注入侧：步距节流 + 签名去抖 + 注入块 hash 去抖 + 防循环窗口 + token 预算
- 工具面：memory_add/search/forget/list/stats
- 存量 auto-memory.json 一键迁移（17 条）
- **踩坑 1**：`ctx.tools` 访问需 `export const inject = ['tools']`（"cannot get property tools without inject"）
- **踩坑 2**：defineTool 的 JSON schema 每个 object 节点必须显式 `additionalProperties`

## v0.3.0 — settings 驱动 + refiner + GUI

- 配置改为 `ctx.settings.register('memory', …)` 三源合一（默认 ← base ← 用户层，**live 生效**）
- refiner：独立 LLM 蒸馏提取（turn/end 异步调 `ctx.llm.stream`，失败降级规则路径）——解决"原始高噪声信息注入回去"
- GUI：client 双面插件（`dsh.client` 声明 + esbuild 构建 `__ModuleLoader__` bundle）
- **踩坑 3（最大坑）**：设置面板一直"不可用"——根因是 apiproxy 的 `WEB_SETTINGS_NAMESPACES` 白名单把 `memory` 命名空间从 `settings.describe` 过滤掉了（DSH 官方安全边界，插件无法自行声明暴露）。修复：harness 源码加一行白名单
- **踩坑 4**：HMR 只监视 patch 文件、不重载插件代码——改插件必须重启 dsh web
- UI 演进：深埋卡片（plugin.item）→ 按用户要求改为**侧边栏导航项**（settings.section）+ 整页设置面板

## v0.3.1 — 密钥与供应商预设

- 供应商/模型**动态预设下拉**（`api.llm.providers()` / `api.llm.models()`，级联 + 自定义兜底 + 已保存值回填）
- **密钥自动跟随供应商**：读 `llm-pi-ai` 命名空间选中供应商的 `apiKeyEnv`（credential-ref 不被 redact 剥离），密钥目标 ref 动态切换；自建场景回退独立槽
- 密钥保密四层：写凭据文件（`.credentials.yaml`）→ 不进 settings 文档 → 不进记忆库 → UI password 不回显（只显示"已配置"徽标）

## v0.4.0 — 阶段二（向量 + 图遍历 + 遗忘）

- **sqlite-vec 接入**：`allowExtension` + `loadExtension`（预编译 vec0.dll 随包分发），加载失败优雅降级
  - 踩坑：vec0 要求整数 rowid（node:sqlite 把 JS number 绑成 REAL → 用 BigInt）
  - 踩坑：trigram 对 2 字中文词零命中（trigram 需 ≥3 字符）→ 关键词 + 子串兜底
- **rule embedding**：FNV-1a 双哈希 256 维 + 归一化（离线零依赖、确定性）——用词不同的查询也能语义召回
- **三路 RRF 融合**：FTS5 BM25 + 关键词 + 向量 KNN → `1/(60+rank)`
- 图遍历：k-hop 递归 CTE、BFS 最短路径、记忆邻域
- 遗忘曲线：24h 指数衰减 + 访问加成（惰性，turn/end 低频）
- 新工具：memory_merge / memory_purge / memory_graph_neighbors

## v0.4.1 — 阶段二收尾

- 社区聚类：label propagation（轻量，小图适配）+ communities/community_members 表 + memory_graph_communities 工具
- 会话预热：agent/session-start 注入最近语义记忆

## 生态协同（同日）

- **compaction-smart 设计方案**（pro 产出，502 行）：六维度精妙压缩策略——内容感知分层保留、**压缩=记忆转移闭环**（与 dsh-memory 咬合）、结构化摘要、渐进式多级压缩、自适应阈值、压缩世界线可展开
- **archify 架构图**：GitNexus 索引（484 节点/694 边/15 流程）+ `context(MemoryStore)` 符号验证 → archify showcase 级交互式架构图（`docs/architecture.html`，4 视口视觉验收通过）
- GitNexus 生成本仓库 `AGENTS.md`（索引指令注入）

## 经验清单（血泪教训）

1. **访问 ctx 外部服务必须先 `export const inject`**，否则运行时 "cannot get property X without inject"
2. **defineTool schema 每个 object 节点显式 `additionalProperties`**（DSH 编译器硬性要求）
3. **settings 命名空间有 apiproxy 白名单**——第三方插件 GUI 设置需要 harness 源码加白名单（官方 deferred work）
4. **HMR 不重载插件代码**——改 lib/ 必须重启 dsh web；只有 cordis.patch.yml 变化触发 patch 热重载
5. **插件源码与 profile 副本双份同步**（部署 = 复制目录，含 sqlite-vec 的 dll）
6. **npm install 需 `--legacy-peer-deps`**（DSH 内部包不在 npm registry）
7. **vec0 行键要 BigInt；trigram 词长 ≥3**——中文字词检索要有兜底路
8. **注入块必须确定性排序 + 稳定格式**——KV 缓存前缀复用的前提
9. **写入侧只收 `source.kind==='user'`**——否则注入内容被当新记忆嵌套沉淀

## v0.4.2 — upsertMemory 致命崩溃修复

- **修复**：`upsertMemory` 相似合并路径对 `store.list()` 已解析的 keywords 数组再次 `JSON.parse` → `Unexpected token 'o', "now,have,en"...` 致命错误（触发条件：dedupMerge 开启 + 相似记忆合并——refiner 降级路径下的高频路径；错误信息即关键词数组被 toString 的开头）
- 顺带修复：图谱挂接按时间倒序取第一条可能挂错记忆 → 改用 add/update 返回值
- 补齐 `test-phase2.mjs`（18 项：向量/图遍历/遗忘/merge-purge/社区），版本号升至 0.4.1 并同步部署副本

## v0.4.3 — 写入质量 + 阶段三启动（世界线回滚）

- **价值门升级**：无用户消息的自主轮次 → 仅当输出含成果信号（✅/已完成/已修复/交付/结论等）才沉淀，过滤思考中间态噪音（此前「任务: (无显式用户消息)」快照照单全收）
- **refiner 价值预判**：过短（<40 字）或无实词（<3 关键词）的低价值轮次不再送 LLM，直接规则路径——省成本
- **阶段三① 世界线回滚**：`store.rollback(id, revision)`（当前活跃版 valid_to 置为 now、目标版本快照追加为新 revision、活跃切片/FTS/向量同步、世界线不断链）+ `memory_versions`/`memory_rollback` 工具
- 新增 `test-phase3.mjs`（7 项：回滚/二次回滚/检索见恢复内容/错误处理），三套测试共 41 项全过

## v0.5.0 — 阶段三② 8 型边全量（图谱语义化）

- **建图幂等化**：节点/边改为确定性 id（sha1(label+memory) / sha1(type+from+to)）——重复 graphLink 不再产生重复节点边；insertEdge 改 UPSERT（断边后再连 = 重新激活 + 更新权重）
- **记忆级连边**：`store.link(a, b, type, weight)` 跨记忆节点集连 8 型边；`unlink` 断开（valid_to 置位，历史保留）
- **自动建边**：similarTo（Jaccard 0.5~0.8 相似但未达合并阈值 → 去重候选边，权重=相似度）+ before（同 label 实体跨记忆按时间排序相邻连边，时间演化链）
- **新工具**：memory_graph_path（跨类型 BFS 最短路径）/ link / unlink / node（节点详情+邻域）
- edges 表 CHECK 约束本就含全部 8 型（mentions/partOf/similarTo/causes/solves/before/supports/contradicts）——schema 零改动，纯建边逻辑落地
- test-phase3 扩至 16 项，三套测试共 50 项全过

## v0.5.1 — 图谱实体过滤 + 记忆库瘦身

- **实体过滤（治假多）**：`GRAPH_STOP_WORDS` 停用词表（英文虚词 + 中文 bigram 泛词 + LLM 输出泛词，140+ 词）——关键词 ≠ 实体，泛词不成节点；graphLink 过滤后 <2 实体不建图
- **ep 快照不建图**：只有语义记忆（sm）进知识图谱，ep 过程快照只留文本不建节点/边
- **修复 list() 忽略 layer 参数**（session-start 预热取 sm 实际取全部——潜伏 bug）
- **生产库清理**（备份后执行）：60 → 23 条记忆（删 21 ep 快照 + 16 legacy 冗余，保留 23 条 sm 精炼 + 用户原始需求 mem-7582b496）；105 → 79 节点（删 11 泛词节点）；236 → 155 边；VACUUM 瘦身
- test-phase3 扩至 17 项（含停用词过滤专项），三套测试共 51 项全过

## v0.6.0-期1 — 真 embedding（remote 落地启动）

- **决策已定 + 实测通过**：硅基流动 https://api.siliconflow.cn/v1；嵌入 Qwen/Qwen3-VL-Embedding-8B（**4096 维**）；重排 Qwen/Qwen3-VL-Reranker-8B（排序质量实测正确）；密钥进凭据文件（MEMORY_EMBEDDING_API_KEY / MEMORY_RERANK_API_KEY）
- **期 1 交付 lib/embedder.js**（Embedder/Reranker seam）：RuleEmbedder（兜底）+ RemoteEmbedder（批量 ≤32/LRU 缓存/超时/维度自学习）+ RemoteReranker + createEmbeddingServices 降级链（onnx→remote→rule）
- 设计文档：docs/embedding-rerank-design.md（含图谱×向量四结合点：节点归一化/similarTo 余弦/边权重/图内语义检索）
- test-embedder.mjs 7 项全过（mock 批量/缓存/降级链 + 真实 API 4096 维验证）

## v0.6.0-期2 — store 真嵌入接入 + 图谱重建 + 自检入口

- **store.js async 化**：add/update/search/rollback 改 async（嵌入在事务外，不持写锁）；embedder 注入 + embedTexts 统一入口 + reembedMissing 批量补写；维度迁移加保护（无 embedder 不重建，防误清生产库向量）
- **index.js 接线**：apply async 初始化 embedder/reranker（密钥凭据文件读取）；settings schema 加 embedding/reranker 段（默认硅基流动 + Qwen3-VL 系列）；新增 memory_reembed 工具；全调用点 await 化
- **生产库迁移**：vec0 256 → 4096 维，28 条记忆重嵌入
- **图谱重建**（rebuild-graph.mjs 运维脚本，真嵌入归一化）：节点大小写归一化（label 向量余弦 0.9 复用）+ node_memories 多对多表 + 语义 similarTo（116 条，权重=余弦）+ before 时间链（32 条）；新增 linkMemories 记忆级单边（修复边爆炸 6237 → 812）
- **测试入口 test-record.mjs**：端到端记录质量自检（8/8 通过，语义查询命中验证；--live 生产库只读）
- 四套测试 58 项全过（async 化零回归）；已同步部署，需重启 dsh web
- 期 2 待做：store.js 注入 embedder + add/update/search/rollback async 化 + vec0 重建 4096 维 + 后台重嵌入迁移 + GUI 区块

## 里程碑：compaction-smart（2026-08-15 立项）

> 里程碑文档：[`D:\AItool\dsh-work\compaction-smart-proposal.md`](D:\AItool\dsh-work\compaction-smart-proposal.md)（502 行，六维度设计）。

六维度：① 内容感知分层价值判定（ValueClass）② **压缩 = 记忆转移闭环**（核心差异化：先进库再消失，与 dsh-memory 咬合）③ 结构化摘要（SummaryDocument schema）④ 渐进式多级压缩 ⑤ 自适应阈值（成本-收益平衡）⑥ 压缩世界线（非销毁、可展开）。

- 集成设计文档：[`docs/compaction-smart-integration.md`](compaction-smart-integration.md)（已产出：内部模块 lib/compactor.js 决策 + 三张新表 DDL + 转移协议落地 + 工具面草案 + 四期路线图）
- 前置依赖：ctx.memory 价值信号表、8 型边（`summarizes` 等）——与阶段三交叉

## 下一步（方案已备）

- 阶段三（进行中，顺序已定）：① 世界线 rollback 工具 ✅ → ② 8 型边全量 ✅（causes/solves/supports/contradicts 四型自动建边需 LLM 判断，留待 refiner 增强/管家子代理）→ ③ Leiden 聚类 + 增量 → ④ 真 embedding（onnx/remote）→ ⑤ 深度管家子代理 → ⑥ 规模/高级按需（KuzuDB/LanceDB、retriever 重排、skill 注册、画像预热、乐观锁）

## v0.6.0-GUI — Web 记忆图谱视图（Obsidian 风格力导向 + 侧边栏入口）

- **数据通道**：`/dsh-memory/graph` HTTP 路由（`ctx.inject(['webServer'], …)` + `webServer.register`，dsh-market 同款机制）——返回**记忆级图谱快照**（一记忆一节点投影：nodes=sm 记忆 + theme、edges=similarTo/before 映射记忆对、themes 列表）
- **渲染演进**：SVG 主题环形（初版）→ **Obsidian 风格力导向 Canvas**（终版）：
  - 自写物理模拟：斥力（截断 2.2k + 软化核心 22px + 限幅）+ 度感知弹簧 + 中心引力 + 阻尼；力随 alpha 缩放（d3-force 式）
  - 拖节点（拖动期间爬行模式：强阻尼 + 斥力减半——邻居平滑跟随不抖动）、拖空白平移、滚轮以鼠标为中心缩放、hover 高亮邻居、点击看详情
  - **fit-to-view**：模拟收敛后自动缩放居中到全部节点；初始 alpha 0.7 温和展开
  - 点阵背景（Obsidian 定位网格）、节点尺寸按度数、标签缩放自适应隐藏
  - 性能：单 Canvas 每帧整绘、alpha 冷却停帧（静止零 CPU）、选中/hover 走 ref 零 React 重渲染
- **入口演进**：顶部 conversation.view tab → **主界面可收起侧边栏底部入口**（`sidebar.footer.action`，任务看板同槽）——点开全视口面板（标题栏+关闭按钮），无底部输入框
- **过程中修的 bug**：DetailPanel 的 nodeById 解构遗漏（点击白屏）、fit-to-view 拖动中误触发（乱跳）、alpha 冷却循环停止不重绘（拖 1 秒冻结）、斥力核心 5px 爆炸（邻居剧烈抖动）
- 构建 lib/client.js（45KB）+ 部署同步；测试全过

## v0.6.0-主题聚类 — 记忆自动归类

- **记忆级主题聚类**：4096 维向量凝聚聚类（阈值 0.78）——30 条记忆 → 12 个主题（compaction/图谱工具链/嵌入选型等，语义归组准确）；memories 表加 theme 列（旧库自动补列）；启动重嵌入后自动聚类；memory_list 输出带主题标签
- **图谱边审计**：similarTo 116 条合理（top 0.91 近重复对）；before 32 条经 node_memories 正确映射后 32/32 时间方向全对；mentions 92.2% 同记忆共现合理；linkBefore 改为记忆级时间链（归一化节点时间错位修复）
- 图社区（label propagation）在密集图上收敛成巨社区——记忆级主题聚类是更合适的归类机制（Leiden 标记暂缓）

## v0.6.0-热修复2 — 凭据读取根因 + 防崩溃加固（2026-08-15）

### 修复 3：readCredential 正则转义丢失（remote 恒降级 rule 的根因）
- **现象**：启动日志 `embedder: rule（dim 256）`——远程嵌入永远初始化失败，生产库被误迁移回 256 维
- **根因**：`readCredential` 的字符串正则 `new RegExp('^' + name + ':\s*(\S+)', 'm')` 经多层传输后反斜杠丢失（\s → s、\S → S），正则失效 → apiKey 恒 undefined
- **修复**：改用零反斜杠的逐行解析（replaceAll(CRLF) + split(LF) + startsWith + slice），凭据读取不再依赖正则转义

### 加固：防崩溃防护（用户要求——插件出问题不能让 dsh 崩，agent 才能回来修）
- **apply() 整体隔离**：settings 注册失败 → 组合层配置兜底（不再 throw）；embedder/store 初始化失败 → 记忆功能停用但 dsh 正常运行（不再 fatal）
- **registerTools 逐工具隔离**：新增 safeRegister 包装——16 个工具逐一注册，单个 schema 非法只跳过该工具（正是热修复 1 的教训：一个 schema 非法曾炸整个插件树）
- **写入管线隔离**：turn/end 分支整体 try/catch——upsertMemory/refiner 异常不再变成 unhandled rejection
- **向量写入三处保护**（热修复 1 已做）：add/update/rollback 的 vecInsert 失败仅 warn 跳过，记忆本体照常 COMMIT，缺失向量由 reembedMissing 补写
- 验证：五套测试 66 项全过；已同步部署

## v0.6.0-热修复 — schema 校验 + 向量写入加固（2026-08-15）

> 用户反馈 dsh web profile 启动即崩，两类错误并存：

### 修复 1：memory_stats 输出 schema 违反编译器严格校验
- **现象**：`JsonSchemaError: unsupported JSON schema: schema.properties.stats.properties.layers.additionalProperties must be explicitly true or false`，插件树加载失败（registerTools 阶段），dsh 退出码 1
- **根因**：`lib/index.js` memory_stats 工具 output schema 中 `layers` 对象节点未声明 `additionalProperties`，DSH 核心 tools 编译器（deepseek-harness/packages/core/tools）要求每个 object 节点显式 true/false
- **修复**：`layers` 补齐 `additionalProperties: false` 及 `properties: { ep: integer, sm: integer }`（与 `store.stats()` 实际返回结构一致）；全文件 24 处 object schema 复查无其他遗漏

### 修复 2：向量维度不匹配导致记忆写入致命失败
- **现象**：`Error: Dimension mismatch for inserted vector for the "embedding" column. Expected 4096 dimensions but received 256.`，`MemoryStore.add` 抛出后整个事务回滚、dsh 启动 fatal
- **根因**：`lib/store.js` 中 `vecInsert.run` 在事务内裸调用，embedding 维度与 vec0 表不匹配（rule 256 维 vs 旧 4096 维表，或 remote 切换后维度变化）时异常冒泡，阻断记忆落库与启动
- **修复**：`add()`/`update()`/`rollback()` 三处 `vecInsert.run` 包 try/catch——向量写入失败仅 `console.warn` 跳过，记忆本体照常 COMMIT，缺失向量由 `reembedMissing` 补写；`reembedMissing` 自身补偿路径保持原语义
- **配套**：构造期维度迁移逻辑（4096→256 重建空表 + 重嵌入）不变，已自动处理旧表

### 部署与验证
- 修复文件：`lib/index.js`、`lib/store.js`；同步部署到 `C:\Users\28643\.dsh\profiles\web\node_modules\dsh-memory\lib\`（覆盖前原文件备份于同目录 `lib_backup_20250416/`）
- 验证：`node --check` 语法通过；`node test-record.mjs` 临时库端到端 8/8 通过（写入→向量→语义检索闭环）；`node --import tsx/esm apps/cli/src/bin.ts --profile web` 启动成功——`[dsh-memory] embedder: rule（dim 256）`，无 UNSUPPORTED_SCHEMA、无 fatal load failure，web 服务就绪
- 建议：下次发版将 package.json 版本由 0.4.1 提升（本次未改版本号，避免连带依赖变更；schema 修复属兼容性变更，不破坏既有数据）

## v0.6.0-运维 — 自愈启动 + 生态清理 + 调研

- **start-dsh.ps1 自愈 preflight**（保证 DSH 更新后启动脚本仍可用）：① pnpm 版本动态读 package.json 的 packageManager；② package.json+pnpm-lock 哈希变化或 node_modules 缺失 → 自动 pnpm install --frozen-lockfile；③ apiproxy 白名单 memory 命名空间被 git 更新覆盖 → 自动补丁（副本演练验证通过）。经验：run_code/edit 传输层吞字符串反斜杠（路径一律正斜杠）、PowerShell -replace 拼接要先算 replacement 变量
- **移除 tdai-memory**：8/16 凌晨被另一会话批量安装（非用户本意），已从 cordis.patch.yml 删除 + 插件文件清除（原生模块残留待重启后清）
- **PreText 调研**（docs/pretext-evaluation.md）：@chenglou/pretext（无 DOM 文本测量/布局引擎，MIT）——当前图谱场景 ROI 低暂不集成，列为「节点气泡多行标签 / Canvas 详情卡片 / 千级标签」的备选方案（esbuild 打包 +102KB 实测通过）

## v0.7.0 — reranker 接线 + GUI 嵌入/重排区块 + 图谱参数可调（2026-08-16）

按「下一步（方案已备，按优先级）」清单推进 ① ② ⑦：

### ① reranker 接入 search（RRF 融合后精排，设计文档 §3 落地）
- **store.search() 后置精排**：RRF 三路融合排序后取 topK（20）候选 → `reranker.rerank(query, docs)` → 融合分 `final = rrfWeight × norm(rrf) + (1-rrfWeight) × rerankScore`（rrfWeight 默认 0.7，可配置）→ 重排序
- 触发与保护：候选 ≥ minCandidates（3）才重排；reranker 抛错/超时 → 静默降级 RRF 顺序（零损失，console.warn 记录）；配置开关全走 settings（reranker.enabled/topK/minCandidates/rrfWeight）
- **RemoteReranker 加 LRU 缓存**（(query, doc) → score，1024 条）：注入签名去抖场景同 query 重复 rerank 命中率高；部分命中只发增量请求；全命中零请求
- **修复隐藏 bug：向量独有命中丢失**——scored 此前只覆盖 FTS+关键词路，仅向量路命中的记忆不进入结果（RRF 分已算但被丢弃）；改为三路并集
- memory_stats 增加 `rerank` 字段；启动日志显示 reranker 模型

### ② GUI 嵌入/重排设置区块（settings schema 已备，client 补上）
- 「记忆」设置面板新增「嵌入与重排模型」区块：embedding（provider 下拉 rule/remote/onnx + model/baseUrl/apiKeyEnv/cacheSize）+ reranker（enabled 开关 + provider/model/baseUrl/apiKeyEnv/topK/minCandidates/rrfWeight）
- 通用 **KeyInput 密钥卡片**组件（password 写凭据文件、●已配置/○未配置徽标、不留空改）——嵌入/重排密钥走独立槽（MEMORY_EMBEDDING_API_KEY / MEMORY_RERANK_API_KEY），refiner 密钥 UI 不动
- 数值校验扩展到子对象数值字段（cacheSize/topK/minCandidates/rrfWeight 等非数字禁止保存）

### ⑦ 图谱力导向参数进 settings（不再改代码调手感）
- settings schema 新增 `graphView` 段：spring（弹簧强度 0.13）/ repulsion（斥力倍率 1）/ damping（阻尼 0.3）/ gravity（中心引力 0.005），范围校验
- 图谱面板 live 读取：MemoryGraphView 订阅 memory 命名空间 → physics 引用变化 → ObsidianGraph 重建模拟（改参数即刻重排，无需重开面板）
- 设置面板新增「记忆图谱（力导向手感）」区块，四参数可调

### 验证与收尾
- test-embedder.mjs 扩至 14 项：rerank 缓存（全/部分命中）、store 集成（融合升序/失败降级/候选不足不触发）、向量独有命中回归
- 五套测试 73 项全过；client bundle 重建（59KB）
- 版本号 0.6.0 → 0.7.0

## v0.8.0 — 图模型简化（memory_links）+ 管家子代理（2026-08-16）

按「下一步」清单推进 ③ ④（决策：③ 实体图保留为共现骨架，记忆级边独立成表）。

### ③ 图模型简化：记忆级边独立表
- **新表 `memory_links`**（from_memory/to_memory/type/weight/valid_from/valid_to，8 型 CHECK，记忆删除级联）：记忆级语义边的一等存储，不再绕「实体代表节点」
- **link/linkSimilar/linkMemories/linkBefore/unlink 迁移**：写 memory_links（幂等 UPSERT 重新激活 + 更新权重；unlink valid_to 置位历史保留）；link 语义从「节点集全连接」（边爆炸源头）收敛为「记忆对单边」；无实体节点（停用词过滤后）也能连边——修复原依赖实体节点的隐性缺陷
- **buildGraphSnapshot 直读 memory_links**：删除 node_memories memOf 回查复杂度，GUI 投影更简单可靠
- **新方法 memoryPath / memoryLinkNeighbors**：记忆级 BFS（双向）——后续图工具升级的基础
- **启动迁移（幂等）**：旧库 edges 表 similarTo/before 活跃边 → memory_links（生产库副本验证：149 条迁移成功，原库不动）；实体图 nodes/edges/node_memories/communities 保留（mentions 共现 + graph 工具向后兼容）
- test-phase3 扩至 21 项（memory_links 断言 + 记忆级路径/邻域 + 级联删除 + 迁移专项）

### ④ 管家子代理（rule 优先，不擅自删数据）
- **store 方法**：`dedupScan`（sm 两两余弦近重复扫描，嵌入缓存命中）/ `agingReport`（创建超 N 天且闲置的低价值候选）/ `housekeeping`（组合巡检；dryRun=false 自动合并 sim ≥ 0.95 的几乎重复对——强度高者保留，source 并入删除）
- **memory_housekeeping 工具**：dryRun 默认 true（只报告）；参数 minSimilarity/agingDays；输出近重复对 + 老化清单 + 合并数
- **自动巡检**：turn/end 每 housekeeping.interval（默认 50）轮跑一次只读巡检 → 发现候选写日志（提示调工具处理），不注入不擅改
- settings 新增 housekeeping 段（enabled/interval/dedupThreshold/agingDays）
- 新测试 test-housekeeping.mjs（8 项）；六套测试 85 项全过；生产库副本验证通过（73 记忆 / 361 实体节点 / memory_links 149 条，无近重复无老化候选）
- 版本号 0.7.0 → 0.8.0

## v0.8.1 — 管家巡检策略重构（写入量 + 时间双驱动）（2026-08-16）

用户反馈：真实会话通常跑不满 50 轮（几步对话即换会话），「每 N 轮巡检」策略几乎永不触发。

- **触发条件重构**：与对话轮数解耦——
  - 写入量驱动：每沉淀 `interval`（默认 20）条记忆巡检一次（去重价值随库增长）
  - 时间兜底：距上次巡检超 `maxIntervalHours`（默认 24h）即触发（跨会话、跨重启）
- **meta 键值表**：`last_housekeeping_at` 持久化到库（`getMeta`/`setMeta`）——重启后不会因内存清零误触发，也不会永远丢时间基线
- settings housekeeping 段更新：`interval` 语义改为沉淀条数（5~500，默认 20）、新增 `maxIntervalHours`（1~720，默认 24）
- **GUI「记忆管家」区块**：设置面板可调（enabled 开关 + interval/maxIntervalHours/dedupThreshold/agingDays）
- test-housekeeping 扩至 15 项（meta 往返/UPSERT/触发条件四象限）；六套测试 92 项全过；client bundle 重建（62KB）
- 版本号 0.8.0 → 0.8.1

## v0.8.2 — 图谱时间维度可视化（四维蠕虫落地）（2026-08-16）

用户反馈：记忆图谱完全体现不出「四维蠕虫」（时间作为第四维）——看不出哪些记忆更新过、哪些是旧记忆。

- **快照增强**（/dsh-memory/graph）：节点新增 `versions`（世界线版本数，memory_versions 一次 GROUP BY 统计）与 `updatedAt`
- **版本年轮**：更新过的记忆节点外画金色同心环（环数 = 更新次数，封顶 3 圈）——"时间痕迹"直接可见
- **新旧色温**：节点颜色按创建时间压暗——**库内相对映射**（最早=45% 亮度，最新=原色），任意时间跨度对比明显（初版用 180 天绝对封顶，生产库记忆集中近 3 天时亮度差仅 1.7% 肉眼不可辨，改为相对映射）
- **时间筛选**：图谱顶部下拉（全部/近 7 天/近 30 天/近 90 天/90 天以上），只看某时间窗内的记忆（边两端都命中才保留）；统计栏显示"更新过 N 条"
- **hover/选中时间标签**：节点上方显示"X 天前 · 更新 N 次"；详情面板加"◉ 更新过 N 次（世界线 N 段）· 创建于 · 最后更新于"
- 图例更新：金色环=更新过、色浅新色深旧
- 生产库副本验证：70 条 sm 记忆，1 条多版本（mem-4fbe4905 versions=2，去重合并路径产生）——版本统计准确
- 六套测试 92 项全过（无逻辑回归，纯快照字段 + GUI）；client bundle 重建（67KB）
- 版本号 0.8.1 → 0.8.2

## v0.8.3 — 热修复：pre-step 自动注入从未触发的根因（injectMinScore 量纲失配）（2026-08-16）

用户问"这几轮对话里有没有记忆被注入进来"→ 检查对话历史只有会话预热、无 pre-step recall 块 → 模拟检索定位根因：

- **根因**：`injectMinScore` 默认 0.2，而 RRF 融合分数理论上限仅 ~0.049（三路全中 3/61）——**任何命中都过不了 0.2 门槛，pre-step 自动注入实际上从未触发过**（只有不走分数门槛的会话预热在工作）
- **修复**：默认值 0.2 → **0.015**（≈ 单路 rank1 1/61，至少一路排前 13；向量独有命中也能注入，语义召回不丢）；schema 范围 0~10 → 0~1（对齐量纲）
- GUI hint 更新说明量纲；test-embedder 新增阈值语义测试（0.2 过滤一切 / 0.015 放行）扩至 16 项
- **生产库副本验证**：新阈值下 4 类真实查询全部命中 6 条（score 0.0154~0.0462），旧阈值 0.2 下全部被滤——修复生效
- 六套测试 93 项全过；client bundle 重建（67KB）；版本号 0.8.2 → 0.8.3
- 用户层无 injectMinScore 覆盖，默认值改动直接生效

## v0.8.4 — 子代理代码审查修复批（2026-08-16）

用户安排独立子代理对 v0.7.0~v0.8.3 全部改动做深度审查（5 套测试自跑 86 项全绿、最小脚本复现验证），修复审查发现的全部 P1/P2 问题：

### P1 修复
- **rerank 部分缓存命中丢 doc**（embedder.js）：缓存命中与 API 结果合并时，未缓存 doc 的输出掩盖了缓存 doc——部分命中返回条数 < 输入。统一按 docs 原始顺序返回全部（缓存回填 + API 回填 + 未覆盖补 0），store 融合不再出现"缓存命中项不参与重排"的排序标准不一致。顺带严格 LRU（读取刷新位置）
- **link() 语义修正**（store.js）：docstring 明确"返回 1 = 边已活跃（新建或重新激活）"；exists 判定合并为单条 COUNT（原 4 次查询）

### P2 修复
- **touchMemory 从未被调用**（store.js）：search() 命中后批量 touch（last_access 刷新 + strength ×1.1 加成，上限 5）——遗忘曲线/老化报告语义落地：last_access 此前冻结在创建时间，老化报告实为"创建年龄"，热门旧记忆会被误报
- **管家计数器按轮次而非沉淀条数**（index.js）：maybeHousekeeping 抽为独立函数，仅在真实沉淀（add/update 成功）后计数；inFlight 防并发双巡检；refiner 三条写入路径全部接入
- **迁移早退缺陷**（store.js）：#migrateMemoryLinks 由"行数 n>0 早退"改为**增量迁移**（每条检查 memory_links 同三元组，已有跳过）——部分迁移/后续旧式边写入也能补迁，重复启动零重复
- **physics.gravity NaN 击穿**（client）：`?? 0.005` 改 `|| 0.005`——`Number(undefined)=NaN`，`NaN ?? x` 仍为 NaN，力导向坐标全 NaN 图谱渲染崩溃（其余三项本就是 `||`）
- **时间筛选后 themes 口径**（client）：filtered 基于筛选后 nodes 重算主题数

### P3 落实
- DetailPanel 版本文案注明"世界线保留最近 N 段"（滚动裁减上限）；reranker 保存死分支删除

### 测试与验证
- test-embedder 扩至 17 项（部分缓存命中返回全部 doc 回归 + 第 4 项断言对齐新语义）
- test-housekeeping 扩至 19 项（search touch 生效/未命中不 touch/迁移幂等重开不重复）
- 六套测试 99 项全过；client bundle 重建（67KB）；版本号 0.8.3 → 0.8.4

## v0.8.4+ — 防崩溃机制实测守护测试（2026-08-16 凌晨）

用户要求核查"插件防崩溃（不让插件问题阻塞 dsh 启动）"功能是否仍完整——v0.6.0-热修复2 的加固经受住 v0.7.0~v0.8.4 七轮改动后：

- **静态核查**：apply 顶层隔离（settings 兜底/初始化停用）、safeRegister 逐工具隔离、写入管线 try/catch、向量写入三处保护、新代码 8 处"不影响主流程"隔离点全部在位
- **实测验证**（新增 `test-crash-safety.mjs`，mock ctx 驱动真实 apply）：4 场景 10 项全过——
  - A. settings 注册抛错 → 配置兜底继续初始化，不 throw
  - B. dbFile 不可打开 → 记忆功能停用、工具不注册，dsh 存活
  - C. 单个工具 schema 非法 → 只跳过该工具，其余 16 个正常注册
  - D. 正常路径 → 17 个工具全部注册 + 3 个事件监听挂载
- 该测试依赖 @deepseek-ai 包，在部署副本环境运行（md5 与源码一致），此后防崩溃能力有守护测试防回归

## 下一步（方案已备，按优先级）

> 详细执行计划见 **[`docs/ROADMAP.md`](ROADMAP.md)**（v0.9 系列：A 事件分类 → B 画像分类 → C 图工具升级 → D 小项 → E 远期）。

- ① reranker 接入 search ✅（v0.7.0）→ 待办：真实 API 端到端 A/B（开启重排对比注入命中率）→ ROADMAP 阶段 D2
- ② GUI 嵌入/重排设置区块 ✅（v0.7.0）→ 待办：provider 切换热迁移 UI 提示 → ROADMAP 阶段 D3
- ③ 图模型简化 ✅（v0.8.0：memory_links 独立表 + 投影直读 + 迁移）→ 待办：memory_graph_path/neighbors 工具升级为记忆级（memoryPath/memoryLinkNeighbors 已就绪）→ ROADMAP 阶段 C
- ④ 管家子代理 ✅（v0.8.0 期1：去重扫描/老化报告/自动合并；v0.8.1 巡检策略重构）→ 待办：画像蒸馏 → ROADMAP 阶段 B
- **事件分类（新需求）** ✅（v0.9.0：events 表 + 时间线扫描 + 管家增量维护 + memory_events 工具 + 图谱事件筛选/高亮）→ 待办：事件 GUI 视觉增强（成员连线强调、事件时间轴视图）
- **画像分类（新需求）** → ROADMAP 阶段 B：type=profile + aspect + refiner 识别 + 预热画像优先注入
- **预热重复注入去抖（新发现）** → ROADMAP 阶段 D1
- ⑤ compaction-smart（用户定：记忆系统之后再看——里程碑文档已立）→ ROADMAP 阶段 E
- ⑥ Leiden 聚类暂缓（被记忆级主题聚类替代）；规模/高级按需（KuzuDB/LanceDB 等）→ ROADMAP 阶段 E
- ⑦ 图谱力导向参数进 settings ✅（v0.7.0：spring/repulsion/damping/gravity live 生效）
