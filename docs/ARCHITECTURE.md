# dsh-memory 架构文档

> 本文描述 dsh-memory 的实现架构：模块划分、数据模型、三条核心管线（写入/检索/注入）、图谱、时间维度与 GUI。交互式架构图见 [`architecture.html`](architecture.html)。

## 1. 模块划分

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 主插件：配置（settings 驱动）、事件监听（写入侧/注入侧/预热）、工具注册、`ctx.memory` 门面 |
| `lib/store.js` | `MemoryStore` 存储层：SQLite schema、CRUD、三路检索、图谱操作、社区检测、遗忘曲线 |
| `client/index.jsx` | 浏览器端设置面板（`settings.section` 注册 + React 表单） |
| `lib/client.js` | client bundle（esbuild 构建，`__ModuleLoader__` 格式） |
| `build-client.mjs` | client bundle 构建脚本 |

依赖：`node:sqlite`（内置）、`sqlite-vec`（预编译 dll 随包分发）、`@deepseek-ai/{cordis,schemastery,dsh-llm,dsh-tools,dsh-settings}`（DSH seam）。

## 2. 数据模型（memory.db，WAL + STRICT）

```sql
memories          -- 记忆身份 + 活跃切片：id/layer(ep|sm)/type/scope/content/keywords/strength/last_access/时间戳
memory_versions   -- 世界线版本：memory_id/revision/content/keywords/valid_from/valid_to/superseded_by
memories_fts      -- FTS5 虚拟表（trigram tokenizer，中文子串）
memory_vectors    -- sqlite-vec vec0 虚拟表（256 维 float，rowid 与 memories 对齐）
nodes             -- 图谱节点：id/kind(entity|event|state)/label/memory_id
edges             -- 图谱边：type(8 型)/from_node/to_node/valid_from/valid_to/weight
communities       -- 社区：id/label/representative
community_members -- 社区成员（community_id, node_id）
```

关键设计：
- **rowid 对齐**：memories 隐式 rowid 同时作为 FTS5 与 vec0 的行键，三表同事务同步，删除时级联清理。
- **向量独立成表**：embedding 生命周期与主体解耦——`sqlite-vec` 加载失败时 `vecEnabled=false`，检索自动降级为 FTS/关键词路，其余功能不受影响。

## 3. 写入管线（`session/event` → 记忆）

```
turn/end 事件
  → 回合缓存（user/assistant 文本；只收 source.kind==='user' 的真实消息，防注入嵌套）
  → 价值门（规则：空/过短过滤）
  → refiner.enabled？
      ├─ 是 → extractWithLlm()：ctx.llm.stream 蒸馏 → JSON{content,type,layer,keywords}
      │        失败/超时 → 降级规则路径
      └─ 否 → 规则组装（"任务:…\n结果:…"）
  → upsertMemory：Jaccard ≥ 0.8 相似 → update（版本追加/内容合并 + strength 加成）；否则 add
  → add/update 同步写 FTS5 + vec0 + memory_versions（time 开关）
  → graph 开关开启 → graphLink：实体节点 + mentions 共现边
```

**世界线语义**：更新不销毁——旧版本 `valid_to` 置非空（隐藏），活跃版本唯一（部分唯一索引）；`maxVersionsPerMemory` 滚动裁旧；回滚 = 旧版重新激活。

## 4. 检索管线（三路 RRF）

```
query 归一化 → tokenize（英文词≥3 + 中文 bigram）
  路1 FTS5：BM25（trigram，词长 ≥3 才进 MATCH）
  路2 关键词：keywords JSON 交集计数 + 子串兜底（中文 2 字词）
  路3 向量：ruleEmbed(256 维哈希) → vec0 KNN 余弦（vecEnabled 时）
  融合：每路按 score 排序得 rank → RRF Σ 1/(60+rank)
  过滤：scope 匹配 + excludeIds（防循环窗口）+ minScore
  排序：score desc, id asc（确定性——KV 缓存友好的前提）
```

**rule embedding**：FNV-1a 双哈希把 token 投到两个槽位 + 归一化——离线零依赖、确定性；相似文本产生相近余弦向量。升级路径：`embedding-onnx` / `embedding-remote`（seam 预留）。

## 5. 注入管线（`agent/pre-step` → `agent.inject()`）

```
每步触发（不依赖用户消息）：
  ① 只取 source.kind==='user' 的文本（注入内容永不当查询）
  ② 签名去抖：query hash 与上次相同 → 跳过
  ③ 步距节流：距上次全量检索 < stepInterval 步 → 跳过
  ④ 检索 → token 预算贪心装入（injectMaxTokens）
  ⑤ 注入块 hash 去抖：与上次相同 → 不注入
  ⑥ agent.inject(createUserMessage({source:{kind:'plugin',plugin:'dsh-memory',form:'recall'}, content:[text]}))
  ⑦ 防循环窗口（maxRecentPerAgent）记录注入 id
```

**KV 缓存友好**（注入不破坏前缀复用）：
- 只 append 消息流尾部（DSH inject 机制保证），永不重排历史
- 注入块稳定格式（固定块头 + 固定字段）+ 确定性排序（score desc, id asc）
- 相同命中集 → 相同文本 → 注入块自身成为可复用前缀
- 溯源锚点 `#mem-id` + 分层标记，模型可要求"展开/忘掉"

## 6. 图谱与社区

- **建边**：`graphLink` 为每条记忆建 entity 节点 + 全连接 mentions 边（骨架）；方案预留 8 型边（mentions/partOf/similarTo/causes/solves/before/supports/contradicts）
- **遍历**：`neighborsK` 递归 CTE（k-hop，去重）；`path` BFS 最短路径（正向+反向边）；`memoryNeighbors` 记忆 → 关联节点 → 邻域并集
- **聚类**：`detectCommunities` label propagation（轻量适配小图），重写 communities/community_members，社区 label 取成员高频词

## 7. 遗忘曲线

- 惰性衰减：`decayExpired()`（turn/end 低频触发）——超过 24h 未访问的记忆 `strength *= exp(-0.15×天数)`，下限 0.1
- 访问加成：检索命中时 `strength = min(strength × 1.1, 5)`（touch）

## 8. 配置（settings 驱动，live 生效）

```
schema 默认值 ← 组合层（cordis.patch.yml config = base）← 用户层（GUI 写入 settings.yaml memory 段）
```

- host 端：`ctx.settings.register(settingsNamespace('memory'), Config, { base, applies: 'live' })`——事件回调内 `getCfg()` 每次读最新值
- client 端：`ctx.settingsScope.bind({ namespace: 'memory' })` 读写同一文档
- **供应商/模型预设**：`api.llm.providers()` / `api.llm.models()` 动态拉取目录，下拉选择 + 自定义兜底；已保存值回填
- **密钥跟随**：读取 `llm-pi-ai` 命名空间选中供应商的 `apiKeyEnv`（credential-ref 不被 redact 剥离），密钥输入/状态检查目标 ref 动态切换；供应商未声明时回退 `refiner.apiKeyEnv` 独立槽。密钥本体写 `~/.dsh/.credentials.yaml`（`api.credentials.set`），describe 只回"已配置"布尔
- **开关矩阵**：`autoWrite/valueGate/dedupMerge/preStepInject/manageTools/time/graph` + `refiner.enabled`——每项可关，关闭即降级路径

## 9. DSH 集成点

| 机制 | 用法 |
|---|---|
| `session/event` | 写入侧原料（user/message、assistant/message、turn/end） |
| `agent/pre-step`（waterfall） | 注入侧触发（每步，不阻塞主流程） |
| `agent/session-start` | 会话预热 seed |
| `agent.inject()` | 注入（form: 'recall'，append-only） |
| `ctx.settings` + `settingsScope` | 配置三源合一（live） |
| `ctx.tools`（defineTool） | 9 个工具 |
| `ctx.llm.stream()` | refiner 蒸馏调用 |
| `ctx.credentials` | 密钥保密（引用 + 凭据文件） |
| client `settings.section` 插槽 | GUI 侧边栏导航项 |
| `exports["./client"]` + `dsh.client` | 双面插件（host + browser） |

## 10. 已知限制（阶段三及以后）

- embedding 为规则哈希（无真语义模型）——seam 已预留 onnx/remote 升级
- 图谱边仅 mentions 骨架（8 型边、时间区间边未全量落地）
- Leiden 级聚类未实现（label propagation 代替）；社区检测为全量重写（无增量）
- 世界线 rollback 工具未暴露（数据模型已支持）
- `agent/session-start` 预热用最近 sm 而非画像蒸馏
- 多进程并发写依赖 SQLite busy_timeout 串行化（无应用层乐观锁）
