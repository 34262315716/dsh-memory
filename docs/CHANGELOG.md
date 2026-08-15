# 开发历程（CHANGELOG）

> 从"一条注入插件的想法"到"带图谱与向量检索的长期记忆子系统"的完整轨迹。技术方案演进见 [`memory-plugin-proposal.md`](memory-plugin-proposal.md)。

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

## 下一步（方案已备）

- 阶段三：真 embedding（onnx/remote seam）、8 型边全量、Leiden 聚类、世界线 rollback 工具、深度管家子代理
- compaction-smart 实现（依赖 ctx.memory 的价值信号表）
