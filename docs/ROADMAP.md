# dsh-memory 路线图（v0.9 系列）

> 状态：v0.8.9（2026-08-16）。检索/注入/图谱/管家/时间维度/防崩溃已就绪，99+10 项测试全过。
> 本文档承接 CHANGELOG「下一步」，是后续开发的执行计划。每阶段完成标准：实现 + 测试 + CHANGELOG + 部署副本同步 + 提交推送（沿用 v0.8.x 流程）。

## 背景：两个新的分类维度

用户提出记忆库的两种新分类，与现有维度互补：

| 维度 | 依据 | 回答的问题 | 现状 |
|---|---|---|---|
| theme（已有） | 向量语义相似 | "这些记忆在讲什么" | 4096 维凝聚聚类 |
| type（已有） | 内容性质 | "这是什么类型的记忆" | note/decision/preference/lesson |
| **event（新）** | 时间连续 + 因果/共享实体 | "这段记忆属于哪件事" | 缺 |
| **profile（新）** | 关于用户本人的稳定信息 | "用户是谁" | 混在 preference 里 |

## 阶段 A：事件分类（记忆的"过程"维度）⭐ 最优先

**动机**：插件自身开发记忆占库大头，形成明显的时间性聚簇（每个版本/每个会话一件"事"），当前只能按语义主题归组，无法回顾"过程"。

**设计**：
- 新表：
  ```sql
  events (id TEXT PK, label TEXT, start_at INTEGER, end_at INTEGER,
          representative TEXT REFERENCES memories(id) ON DELETE SET NULL, created_at INTEGER)
  event_members (event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
                 memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE, PRIMARY KEY(event_id, memory_id))
  ```
- **检测算法（纯 rule，不依赖 LLM）——时间线扫描**：
  1. sm 记忆按 created_at 排序
  2. 相邻两条若「时间间隔 < gapThreshold（默认 2h）」**且**「同 theme 或共享实体（node_memories 交集）」→ 归入同一事件
  3. 否则切新事件（单条记忆自成一事件，保证"每记忆必属一事件"）
  4. label = 成员 theme 众数（无 theme 用代表记忆 type）；start/end = 首/末成员时间
- **增量维护**：接管家巡检（housekeeping 双驱动已有）——每次巡检调用 `detectEvents()`（增量：只处理上次检测后新增/变动的记忆，meta 表存 `last_events_detect_at`）
- **工具**：`memory_events`——参数 limit；输出事件列表 [{id, label, startAt, endAt, count, members:[{id, content 摘要}]}]；`memory_event_members` 可合并进前者
- **GUI**：图谱顶部加「事件」筛选下拉（全部/最近 N 个事件），选中后事件成员高亮、其余降透明度；事件色板与主题色板区分（虚线外圈或角标）
- **验收**：生产库副本跑 detectEvents → 得到合理里程碑（如"v0.7.0 交付""v0.8.x 系列开发""防崩溃核查"）；新增 test-events.mjs（构造时间聚簇验证切分/合并/label）

## 阶段 B：画像分类（记忆的"人物"维度）⭐

**动机**：用户个人信息（身份/偏好/习惯/背景）散落在 preference 里，预热注入按"最近时间"取而不是按"重要性"取；用户要求正式的分类。

**设计**：
- `type` 枚举加 **`profile`**（memories.type 无 CHECK 约束，工具 schema enum 扩即可）；新增列 `profile_aspect TEXT DEFAULT ''`（identity/preference/habit/background/communication_style，旧库 ALTER 补列，有 theme 先例）
- **refiner 蒸馏识别**：extractWithLlm 的 prompt 加规则——"关于用户本人的稳定信息（身份/习惯/长期偏好/沟通方式）→ type=profile + aspect 标注"；降级规则路径不产 profile（防误标）
- **`memory_add` 工具**：type enum 加 profile + 可选 aspect 参数
- **会话预热改造**：seeds 从"最近 3 条 sm"改为"**画像优先**：最近画像 3 条 + 最近非画像 2 条"——"用户是谁"优先于"最近干了啥"
- **画像蒸馏（管家期 2）**：housekeeping 增加 profileDistill（refiner 启用时）——把散落 preference/decision 聚合为画像条目（"用户偏好自建端点 + 密钥走凭据文件"），重复画像合并去重（dedupScan 复用）
- **GUI（可选）**：图谱 profile 记忆特殊标记（金色星角标）；memory_list 输出显示 aspect
- **验收**：写入画像记忆 → 预热注入画像优先可测；refiner prompt 单测；test 扩展

## 阶段 C：图工具记忆级升级（③ 收尾）

- `memory_graph_path`：fromId/toId 语义从实体节点 id → **记忆 id**（底层调 memoryPath，已就绪）；maxLen 默认 6
- `memory_graph_neighbors`：输出从实体节点列表 → **记忆级邻域**（memoryLinkNeighbors 返回 {id, type, depth}，已就绪）；schema 输出改 memories 数组
- `memory_graph_node` 保留（实体节点详情，nodes 表仍在）
- **兼容性**：工具 schema 输出结构变化（破坏性）——CHANGELOG 标注；守护测试工具数不变（18）
- **验收**：test-phase3 相关断言更新 + 新断言（记忆级 path/neighbors）

## 阶段 D：修复与小项

1. **预热重复注入去抖**：session-start 可能多次触发（GUI 重连）→ 预热块重复 3 遍；给 session-start 加签名去抖（同 seed 集合 + 时间窗内跳过）
2. **reranker 真实 API A/B**：开启 reranker 后对比注入命中率（与关闭时）；记录结论
3. **GUI 嵌入 provider 切换提示**：切换 provider 会触发向量维度迁移（live），UI 加提示文案
4. 图谱 hover 标签质量观察：v0.8.3 后 pre-step 注入实际召回质量评估（0.015 阈值是否合适，可能需要微调）

## 阶段 E（远期/搁置）

- compaction-smart（用户定：记忆系统之后再看——里程碑文档已立）
- Leiden/图社区（被记忆级主题聚类替代，暂缓）
- 规模/高级按需：KuzuDB/LanceDB、skill 注册、乐观锁、onnx 本地嵌入

## 顺序与依赖

```
A 事件分类 ──┐
             ├──▶ C 图工具升级 ──▶ D 小项 ──▶ E 远期
B 画像分类 ──┘
```
- A/B 相互独立，A 优先（rule 算法、收益直观）
- C 依赖 memory_links（✅ 已就绪，v0.8.0）
- 每阶段独立可发版（v0.9.0 = A，v0.9.1 = B，v0.9.2 = C，v0.9.3 = D）
