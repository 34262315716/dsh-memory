# dsh-memory 融合备忘：可抄开源架构 + 调研存档

> 状态：**备忘，未逐项评估是否纳入**（用户明确：先记录，暂不逐个思考必要性）。
> 来源：主会话调研（firecrawl 技能包，2026-08-18）。后续要排期时按 §四 逐项评估。

## 一、开源可抄蓝本对照表

| 开源项目 | License | 核心机制 | 与 dsh-memory 现状 | 抄法 / 缺口 |
|---|---|---|---|---|
| **Graphiti**（[repo](https://github.com/getzep/graphiti)，[论文 2501.13956](https://arxiv.org/abs/2501.13956)） | Apache-2.0 | 时间上下文图：边带有效性窗口（何时变真/被取代）；一切溯源到 episodes；增量更新不整图重算；混合检索 semantic+keyword+图遍历 | 咱 memory_links 已是 valid_from/valid_to；ep 层雏形；事件/主题是全量重建；图未进检索 | ①时间窗查询显式化 ②记忆溯源链 sm→来源 ep ③事件增量更新 ④**图遍历作为检索一路进 RRF** |
| **Mem0**（[repo](https://github.com/mem0ai/mem0)） | Apache-2.0 | 新算法（2026-04）：Single-pass ADD-only 提取（不 UPDATE/DELETE，只增不改）；agent 产出事实一等公民；entity linking；多信号检索（semantic+BM25+entity）并行融合；时间感知检索 | 咱是去重合并=update 路径；已有 memory_add/refiner；有实体节点但无 entity linking 检索加成 | ⑤append-only+时间感知反例对照 ⑥entity linking 跨记忆检索加成 ⑦（印证 ④） |
| **A-MEM**（[repo](https://github.com/discordant/amem)） | MIT | AgeMem 的 JS 落地；记忆操作=工具动作 | 咱 memory_* 工具已是此意 | 代码可读可仿（同 JS 栈） |
| **Letta/MemGPT**（[repo](https://github.com/letta-ai/letta)） | Apache-2.0 | 虚拟上下文分层 + 记忆自我编辑 | 咱 memory_add/search/忘掉 同类玩法 | 平台级偏重，借鉴分层思路即可 |
| **LangMem**（LangChain） | MIT | hot-path 记忆工具 + 后台记忆管理者自动提取/合并/检索 | 后台管理者 ≈ 咱 refiner + 管家自动巡检 | 已近似，可对照补"后台合并"细节 |

## 二、三个明确融合缺口（最值得先看）

1. **记忆级边进检索**：把 memory_links（图遍历）作为第四路并入 RRF——抄 Graphiti/Mem0 的混合检索方向。落点：`lib/store.js search()` + `lib/pipelines/inject.js`。
2. **记忆溯源链**：sm 记忆回链到产生它的 ep 来源（source_memory_id）——抄 Graphiti episode 溯源。
3. **事件/主题增量更新**：从每次全量重建改为增量 batch——抄 Graphiti 增量更新。

## 三、论文调研存档

- **主流可落地（分层+检索+蒸馏）**：MemGPT(2310.08560) · Generative Agents(2304.03442) · HippoRAG(2405.14831) · AgeMem(2601.01885) · HiMem(2601.06377) · Membox(2601.03785) · InfiniMemory(2606.10677) · GAM(2604.12285) · MemRefine(2606.13177) · rate-distortion 压缩(2607.08032) · MemArchitect(2603.18330) · Proactive Memory Agent(2607.08716) · InfiAgent(2601.03204) · NeuSymMS(2605.17596) · MSCE(2607.16621) · M⋆(2604.11811)
- **综述**：memor mechanism survey(2404.13501) · Memory for Autonomous LLM Agents(2603.07670) · Rethinking Memory(2505.00675) · From Storage to Experience(2605.06716)
- **另类/难落地（自训模型或硬件依赖，暂不纳入工程讨论）**：Titans/TTT(2501.00663, 2608.01672) · DNC(2016 Nature) · SNN/神经形态(EMBER 2604.12167, BrainTransformers 2410.14687) · Memory-R1(2508.19828, RL)
- 判定标准：**只要 "LLM API 调用 + 存储(向量/关系/图) + 规则/调度逻辑" 就能复刻 ⟶ 可落地；凡需改权重/RL/特殊硬件 ⟶ 不纳入**。

## 四、欠账（待办，未做）

- [ ] 对 §一 每个可抄点做**必要性评估**（是否真的需要、ROI、与既有功能重复度）——用户暂缓
- [ ] 将性价比高的缺口排入 `ROADMAP.md` v0.10
- [ ] 另见 `docs/agent-memory-papers.md`（若已建）等其他调研存档

> 归档说明：本文件为备忘性质，信息密度优先、论证从简；详细出处见各 repo/arxiv 链接。
