# dsh-memory

DSH（DeepSeek Harness）进阶自动记忆插件——**无需用户消息触发**，agent 自主工作时每一步自动注入与当前任务相关的历史记忆，并在每个轮次结束时自动沉淀新记忆。

> 核心诉求：记忆不只是"清单"，而是会生长的知识网络：分层 + 图谱 + 世界线（时间维度）+ 向量语义检索。

## ✨ 功能总览

| 能力 | 说明 |
|---|---|
| **自动注入** | `agent/pre-step` 每步检索相关记忆并 `agent.inject()`（不依赖用户消息）；节流 + 签名去抖 + 注入块 hash 去抖 + 防循环窗口 |
| **自动沉淀** | `turn/end` 写入 + 价值门过滤 + Jaccard 去重合并（相似记忆更新而非新建） |
| **分层记忆** | `ep`（情景，turn 快照）/ `sm`（语义，长期知识），带 scope 隔离 |
| **时间维度（世界线）** 🐛 | 更新追加版本，旧版本保留但隐藏（不参与检索/注入）；`maxVersions` 滚动裁旧 + 回滚链 |
| **向量语义检索** | `sqlite-vec` KNN 余弦 + FTS5 BM25 + 关键词三路 **RRF 融合**；扩展加载失败优雅降级；**reranker 后置精排**（RRF 候选 → 融合分 `w×RRF+(1-w)×rerank`，失败降级 RRF 零损失） |
| **记忆图谱** | 实体节点 + 边（共现/因果/时间演化…）、k-hop 邻域扩散、BFS 最短路径、社区自动聚类；**力导向参数（弹簧/斥力/阻尼/引力）settings 可调、live 生效**；**记忆级边独立表（memory_links）**——GUI 投影直读、记忆级 BFS/邻域、旧实体边自动迁移；**时间维度可视化**：更新过的节点有金色年轮（环数=更新次数）、新旧色温（库内相对映射）、时间窗筛选、hover 时间标签 |
| **记忆管家** | 自动巡检（与对话轮数解耦：每沉淀 20 条记忆 或 距上次超 24h 触发，时间戳持久化）：全局去重扫描（余弦近重复）+ 老化报告（长期闲置低价值）；`memory_housekeeping` 工具 dryRun 默认只报告，可选自动合并几乎重复对 |
| **LLM 蒸馏（refiner）** | 独立模型把高噪声轮次提取为自包含结论（决策/偏好/教训分类）；失败自动降级规则路径 |
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
memory_graph_neighbors   图谱邻域（k-hop 扩散）
memory_graph_communities 社区检测/查看
memory_graph_path        图谱最短路径（节点序列+边类型链）
memory_graph_link        手动连边（8 型语义关系）
memory_graph_unlink      断边（历史保留）
memory_graph_node        节点详情 + 邻域
memory_versions          世界线版本链（回滚前查看）
memory_rollback          回滚到历史版本（时间旅行）
memory_housekeeping      管家巡检（去重扫描 + 老化报告；dryRun=false 自动合并近重复）
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

📚 详细设计：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · 开发历程：[`docs/CHANGELOG.md`](docs/CHANGELOG.md) · 原始设计方案（1406 行）：[`docs/memory-plugin-proposal.md`](docs/memory-plugin-proposal.md)

🏔 里程碑（compaction-smart，502 行六维度压缩方案）：[`D:\AItool\dsh-work\compaction-smart-proposal.md`](D:\AItool\dsh-work\compaction-smart-proposal.md)

## 📦 安装

```sh
# 方式一：官方插件命令（推荐）
dsh plugin --profile web add ./dsh-memory   # 本地路径，或发布到 npm 后按包名安装

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

### ⚠️ 必要前置：settings 命名空间白名单

GUI 设置面板依赖 `memory` 设置命名空间对 Web 客户端可见。DSH 的 apiproxy 有白名单机制（`packages/host/apiproxy/src/api-proxy.ts` 的 `WEB_SETTINGS_NAMESPACES`），需要添加一行：

```ts
const WEB_SETTINGS_NAMESPACES = [
  'agent-loop', 'shell', 'locale', 'permission', 'ui-conversation', 'ui-theme', 'web-search-deepseek',
  'memory',   // ← 添加
] as const
```

> 这是 DSH 官方设计的安全边界（插件无法自行声明暴露，官方注释标注 deferred work）。升级 DSH 版本后需重新添加。

## ⚙️ 配置（settings.yaml 的 `memory` 段）

```yaml
memory:
  dbFile: ''                # 留空 = ~/.dsh/memory.db
  scope: ''                 # 留空 = global
  injectMaxTokens: 800      # 每次注入 token 预算
  injectMinScore: 0.015     # 注入最低相关分（RRF 融合量纲，三路全中 ~0.049；0.015 ≈ 至少一路排前 13）
  stepInterval: 2           # 步距节流（每 N 步全量检索）
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
    provider: opencode-go   # 供应商（GUI 下拉预设）
    model: deepseek-v4-flash
    apiKeyEnv: MEMORY_REFINER_API_KEY  # 独立密钥槽（供应商未声明 apiKeyEnv 时生效）
    maxTokens: 800
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
    enabled: true           # 管家自动巡检（只读报告，不擅改数据）
    interval: 20            # 每沉淀 N 条记忆巡检一次
    maxIntervalHours: 24    # 时间兜底（距上次巡检超 N 小时）
    dedupThreshold: 0.92    # 近重复相似度阈值
    agingDays: 30           # 老化报告天数
```

**密钥自动跟随**：选中供应商后，GUI 密钥输入的目标引用自动切换为该供应商声明的 `apiKeyEnv`；密钥本体写入 `~/.dsh/.credentials.yaml`（私有文件），不进设置文档、不进记忆库、界面不回显。

## 🧪 测试

```bash
node test.mjs         # 阶段一回归（16 项）
node test-phase2.mjs  # 阶段二专项（18 项：向量/图遍历/遗忘/merge-purge/社区）
node test-phase3.mjs  # 阶段三专项（17 项：世界线回滚/8 型边/时间旅行）
node test-embedder.mjs # 嵌入/重排 seam 单测（14 项：rule/remote/缓存/降级链/rerank 融合与缓存/向量独有命中/真实 API）
node test-housekeeping.mjs # 管家专项（19 项：去重扫描/老化报告/自动合并/meta/触发条件/touch/迁移幂等）
node test-crash-safety.mjs # 防崩溃容错（10 项：settings 失败兜底/坏库停用/单工具跳过/正常路径）
                          # 注：依赖 @deepseek-ai 包，需在部署副本或 harness 环境运行
node test-record.mjs   # 记录质量自检入口（写入→语义召回→图谱全链路；--live 生产库只读）
node rebuild-graph.mjs # 图谱重建运维脚本（真嵌入归一化重建 + 语义边）
```

## 📄 License

MIT
