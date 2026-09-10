# dsh-memory 执行计划（v0.10 系列 + 短板治理）

> 状态：2026-08-25 更新。v0.9.18 已部署（图谱配色重做 + 8/24 注入链路修复，inject 53 次/preheat 65 次）。
> 本文档把 ROADMAP 的 v0.10 部分升级为**可执行计划**，并入最新发现的两块短板（画像召回弱、reranker 未配）。
> 每阶段完成标准（沿用纪律）：实现 + 测试 + CHANGELOG + 部署副本 md5 同步 + 提交推送。

## 0. 现状基线（2026-08-25）

- 版本 **v0.9.18** 部署生效（web-desktop/web 双副本 + cordis.patch.yml `injectMinScore: 0.02`）
- 注入链路打通：pre-step 逐步注入 live（昨日 53 次），preheat 预热 65 次
- 三路 RRF 检索（向量/FTS/关键词）live；**reranker = null 未启用**
- **主题荒漠**：96% 记忆无主题（208/217 曾为 `(未归类)`，配色已按类型兜底）
- **画像召回弱**：profile 记忆 content 短/关键词少，被含泛词的长记忆在 RRF 中碾压（"查丹道记录"注入回图谱治理记录）
- 记忆库 194 sm + 53 ep

## 1. P0 快赢（各半天，互不依赖，可并行）

### 1.1 画像类记忆注入加权
- **目标**：注入命中分布里画像/短记忆不再被泛词长记忆碾压。
- **方案**：`store.search` 支持类型加权（`boost: {profile: n}` 或注入时对 profile 单独 recall 一段并入）；不破坏现有 RRF 分数语义，加权仅作用于注入路径（`pipelines/inject.js` 传参）。
- **验证**：回归——用 "查一下我上次的丹道修炼记录" 实测应命中丹道画像（mem-9e1190d1），而非图谱治理记录；对比加权前后命中分布中 profile 占比。
- **完成标准**：回归实测通过 + 守护测试 + CHANGELOG + 同步 + 提交。

### 1.2 reranker 真实接入（配置 + A/B）
- **现状**：`embedder.js` rerank seam 已就绪，settings 有 `reranker` 配置块，缺 API key 未启用。
- **方案**：凭据文件补 reranker 密钥（用户操作）→ 设置 `reranker.enabled: true`；logs 埋点输出重排前后排序。
- **验证**：A/B——同一 query 开/关重排，人工评分 10 条注入结果相关性（重排后 top1~3 是否更对口）。
- **完成标准**：端到端启用 + 埋点可观测 + 留存 A/B 对比记录。

## 2. P1 v0.10 阶段一：refiner 蒸馏双输出（abstraction + theme）

> ✅ **已完成（v0.10.0，2026-09-10）**：蒸馏输出 schema 双扩展（abstract 白名单 principle|event + theme LLM 打标）+ 注入加权联动（search boost 双维 type×abstract：注入路径 profile×3 / principle×1.5 / event×0.7 + 预热 principle 排序优先）；store.add 透传 + 幂等迁移。守护测试 11 项，13 套 285 项全绿。
> 剩余验证项（需运行观察）：蒸馏一致性抽查 ≥80%（新写入 20 条人工标注）＋注入实验 theme 匹配率——待重启生效后积累新记忆再抽查。

原计划（已交付）：
- **abstraction**：新列 `abstract: 'principle' | 'event'`（白名单校验）；principle=方法/原则/可复用经验，event=具体事件/产出。
- **theme**：`theme` 列复用现有（v0.8 主题聚类列），LLM 打简短稳定名词标签（如 "AI绘画" / "dsh-memory 开发"）；**存量不动**（拍板：新机制仅新记忆）。
- **注入加权联动**：pre-step/preheat 中 principle 优先注入、event 降权（强相关才注入）；theme 用于注入聚合与图谱着色。
- **GUI**：设置面板 + 图谱图例同步新维度说明（**未做**，并入 P2 主题圈 GUI 批次）。

## 3. P2 v0.10 阶段二：GUI 主题圈 + 图工具记忆级升级

- **主题圈** ✅ **已完成（v0.10.1）**：同主题节点（成员 ≥3、非"未归类"）每帧按实时质心/半径绘制**半透明淡色圆盘** + 主题名标签（`成员数 · 主题`），跟随力导向移动、随聚焦降透明；样式按拍板：半透明圆盘（非虚线椭圆）。设置面板「检索与注入」已补 v0.10 维度说明（P1 GUI 遗留一并结清）。
- **图工具升级**（阶段 C）✅ **已完成（v0.9.33）**：`memory_graph_path` / `memory_graph_neighbors` 从实体节点升级为记忆级（`memoryPath` / `memoryLinkNeighbors` 接线完成，沿 memory_links 活跃语义边；neighbors 附加边 type + snippet 摘要）；`memory_graph_node` 保留实体级；工具清单校验通过。

## 4. P3 维护小项（随时可捡）

1. 预热重复注入去抖（session-start 多次触发场景已有记录）
2. 存量 global 记忆迁移/老化策略
3. GUI 嵌入 provider 切换提示（维度迁移 UI）

## 5. 顺序与依赖

```
P0.1 画像加权 ──┐（独立）
P0.2 reranker ──┤（独立）
                ▼
P1 蒸馏双输出（abstraction + theme）── 依赖 refiner 管线一次改造
                ▼
P2 主题圈（依赖 P1 的 theme 数据）＋ 图工具记忆级升级（独立于 P1）
                ▼
P3 维护小项
```

- P0 两项不依赖任何东西，**建议先并行**；P0.1 半小时-1 小时，P0.2 取决于密钥配置。
- P1 是 v0.10 核心（用户核心诉求"我如何看待设计"），改完图谱主题维度才算真正闭环。
- P2 主题圈依赖 P1 数据；图工具升级随时可做。
- 每阶段收尾一律：测试全绿 + CHANGELOG + 部署副本同步 + 提交推送。

## 6. 拍板记录（2026-08-25 已定）

- ✅ **P0.1 权重形式**：search 层 boost 参数（用户拍板后实现）
- ✅ **P1 theme 风格**：LLM 自由打名词标签（不用白名单）
- ✅ **P2 主题圈样式**：**半透明淡色圆盘**（非虚线椭圆）
- ✅ **reranker**：供应商与嵌入一致（硅基流动），密钥 `MEMORY_RERANK_API_KEY` 已存在；settings.yaml 已开 `reranker.enabled: true`，重启生效后做 A/B