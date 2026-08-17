# dsh-memory 路线图（v0.9/v0.10 系列）

> 状态：v0.9.6（2026-08-17）。检索/注入/图谱/管家/时间维度/防崩溃/日志/scope 分层已就绪。
> 本文档承接 CHANGELOG「下一步」，是后续开发的执行计划。每阶段完成标准：实现 + 测试 + CHANGELOG + 部署副本同步 + 提交推送。

## 已完成（v0.9 系列）

| 版本 | 内容 |
|---|---|
| v0.9.0 | 阶段 A **事件分类**（events 表 + 时间线扫描 + 管家维护 + memory_events + 图谱事件筛选/高亮） |
| v0.9.1 | 图谱关系质量修复（before 方向自愈 / similarTo 阈值 0.6 / 主题碎片过滤） |
| v0.9.2 | 阶段 B **画像分类**（type=profile + aspect + refiner 识别 + 预热画像优先 + 画像蒸馏） |
| v0.9.3 | 子代理审查修复批（aspect 读回路 / 预热窗口挤压 / 蒸馏幂等 / 事件陈旧 id / N+1） |
| v0.9.4 | **scope 分层**（会话工作目录 → 项目隔离，检索双 scope [项目, global]） |
| v0.9.5 | **运行日志全透明**（logs 表 + 全链路埋点 + GUI「记忆日志」面板 + memory_logs 工具）+ scope 分层根治（workspaceRegistry fallback——EAC web 会话无 cwd） |
| v0.9.6 | 热修复（v0.9.5 埋点作用域 bug——registerTools 是模块级函数，工具内不可依赖 apply 局部变量 wsRegistry/logStore） |

## 分类维度全景

| 维度 | 依据 | 回答的问题 | 现状 |
|---|---|---|---|
| theme | 向量语义相似（v0.10 改 refiner 打标） | "在讲什么" | 已有 |
| type | 内容性质 | "什么类型" | note/decision/preference/lesson/profile |
| event | 时间连续 + 因果 | "属于哪件事" | ✅ v0.9.0 |
| profile | 用户本人稳定信息 | "用户是谁" | ✅ v0.9.2 |
| scope | 会话工作目录/工作区 | "属于哪个项目" | ✅ v0.9.4/0.9.5 |
| **abstraction** | 抽象层级 | "可复用原则 or 具体事件" | 待 v0.10 |
| **refiner theme** | LLM 打主题 | "哪个主题（如 AI绘画）" | 待 v0.10 |

## 阶段 C：图工具记忆级升级（待做）

- `memory_graph_path`：fromId/toId 语义实体节点 → 记忆 id（memoryPath 已就绪）
- `memory_graph_neighbors`：输出实体节点 → 记忆级邻域（memoryLinkNeighbors 已就绪）
- `memory_graph_node` 保留；守护测试工具清单同步

## v0.10 系列（用户需求已提，待拍板细节）

### ① 抽象层级 abstraction —— 用户核心诉求："我如何看待设计"而非"设计了什么"
- refiner 输出 `abstract: 'principle' | 'event'`
  - principle：方法/原则/可复用经验（跨项目资产）
  - event：具体事件/产出/状态（参考价值低）
- 新列 abstraction + 白名单校验
- **注入加权**：pre-step/预热 principle 优先，event 降权（强相关才注入）

### ② 主题打标（refiner theme）
- 蒸馏输出 theme（LLM 打简短稳定名词标签："AI绘画" / "dsh-memory 开发"）
- 落 theme 列；向量聚类降级兜底；存量不动

### ③ GUI 主题圈
- 同主题节点画包围圈/凸包 + 主题名（与主题着色协同）

### 待拍板
- category 与 abstraction 的关系（abstraction 是否足够，还是需要 category 领域维度）
- 主题圈样式（虚线椭圆 vs 淡色圆盘）
- 注入加权幅度

## 阶段 D 残余小项
1. 预热重复注入去抖（session-start 多次触发）
2. reranker 真实 API A/B 验证
3. GUI 嵌入 provider 切换提示（维度迁移）
4. 存量 global 记忆迁移/老化策略

## 阶段 E（远期/搁置）
- compaction-smart（用户定：记忆系统之后再看）
- Leiden/图社区（被主题聚类替代）；规模/高级（KuzuDB/LanceDB 等）
