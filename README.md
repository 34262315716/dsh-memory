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
| **向量语义检索** | `sqlite-vec` KNN 余弦 + FTS5 BM25 + 关键词三路 **RRF 融合**；扩展加载失败优雅降级 |
| **记忆图谱** | 实体节点 + 边（共现/因果/时间演化…）、k-hop 邻域扩散、BFS 最短路径、社区自动聚类 |
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
  injectMinScore: 0.2       # 注入最低相关分
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
```

**密钥自动跟随**：选中供应商后，GUI 密钥输入的目标引用自动切换为该供应商声明的 `apiKeyEnv`；密钥本体写入 `~/.dsh/.credentials.yaml`（私有文件），不进设置文档、不进记忆库、界面不回显。

## 🧪 测试

```bash
node test.mjs         # 阶段一回归（16 项）
node test-phase2.mjs  # 阶段二专项（14 项：向量/图遍历/遗忘/merge-purge）
```

## 📄 License

MIT
