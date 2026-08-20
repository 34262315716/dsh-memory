# compaction-smart × dsh-memory 集成设计

> 立项依据：[compaction-smart-proposal.md](compaction-smart-proposal.md)（502 行，六维度精妙压缩方案）。
> 本文把六维度落到 dsh-memory 现状：模块划分、表 DDL、事件流、转移协议、图谱接线、配置/开关、工具面、GUI、分期路线图。
> 现状核对基于 lib/index.js / lib/store.js / client/index.jsx（v0.4.1）。

## 0. 六维度 → 现状映射（一页速览）

| 提案维度 | dsh-memory 现状可复用 | 需新增 |
|---|---|---|
| ① 内容感知分层价值判定 | 价值门（规则）、turn/end 事件流、decayExpired 强度 | turn_values 价值信号表、ValueClass 判定函数 |
| ② 压缩=记忆转移闭环 | store.add/update/forget、世界线版本、事务（BEGIN IMMEDIATE） | summary_anchors 锚点表、转移函数、幂等查重 |
| ③ 结构化摘要 | refiner 的 LLM 调用模式（ctx.llm.stream + 失败降级） | SummaryDocument 校验、摘要 prompt |
| ④ 渐进式多级压缩 | 世界线 update（再压缩=追加版本） | summary_level 字段、层级上限 |
| ⑤ 自适应阈值 | 无（最缺） | turn_values.tokens 累积、成本-收益判定 |
| ⑥ 压缩世界线可展开 | memory_versions 完整保留旧版、#mem-id 溯源 | memory_expand 工具、锚点→源记忆读取 |

## 1. 架构决策：内部模块 lib/compactor.js（推荐）

**结论：作为 dsh-memory 内部模块，不做独立插件。**

理由：
1. **转移协议需要共享 MemoryStore**。独立插件拿不到 dsh-memory 的 store 实例（DSH 插件间没有共享 store 的正式 seam；ctx.provide('memory') 已暴露 search/add/stats，但没有 update/forget/versions——压缩「先进库再消失」无法跨插件原子完成）。
2. **价值信号表与记忆同库**：turn_values 查询、阈值判定、候选选择都在一个 SQLite 连接内，独立插件要么开第二个连接（写冲突），要么经事件总线来回传 id 列表（无原子性）。
3. **配置/GUI 复用**：settings 命名空间 memory 已进 apiproxy 白名单（harness 改一行）。独立插件要新命名空间，又得改 harness 白名单；内部模块直接用 memory.compaction 段。
4. **未来可拆分**：compactor.js 保持纯函数 + 依赖注入（{ store, getCfg, llm }），若以后要独立成 dsh-compaction-smart 包，文件级即可抽走。

**模块划分**：

    lib/compactor.js    ← 新增：createCompactor({ store, getCfg, llm })
      ├─ classifyValue(turn)            → ValueClass（core/useful/noise，规则判定）
      ├─ recordTurn(sessionId, turn)    → 写 turn_values
      ├─ shouldCompact(sessionId)       → 自适应阈值判定（成本-收益）
      ├─ buildSummary(inputs)           → LLM 摘要（失败降级规则截断合并）
      ├─ transferProtocol(summaryId, sourceIds) → 转移协议（先入库后删除 + 锚点）
      └─ expandSummary(memoryId)        → 展开（锚点 → 源记忆世界线）
    lib/index.js        ← 接线：turn/end 后调用、注册 3 个新工具、settings schema 加 compaction 段
    client/index.jsx    ← GUI 加「压缩」区块

导出草案：

    export function createCompactor({ store, getCfg, llm }) {
      return {
        onTurnEnd(session, { userPart, assistantPart, scope }), // 信号记录 + 触发检查
        maybeCompact(sessionId, scope),                          // 同步执行一次压缩（供手动/工具调用）
        expandSummary(memoryId),                                 // 展开数据源
        preview(scope),                                          // 预览候选（不改库）
      }
    }

## 2. 数据模型扩展（DDL，对齐现有 SCHEMA 风格）

    -- ① 价值信号表：会话级累积（自适应阈值的原料）
    CREATE TABLE IF NOT EXISTS turn_values (
      session_id  TEXT NOT NULL,
      turn_idx    INTEGER NOT NULL,
      value_class TEXT NOT NULL CHECK (value_class IN ('core','useful','noise')),
      signals     TEXT NOT NULL,          -- JSON {toolUse, decisions, errors, planDelta, tokens}
      tokens      INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (session_id, turn_idx)
    ) STRICT;

    -- ② 摘要锚点表：压缩世界线的「覆盖关系」（8 型边 summarizes 的关系投影）
    CREATE TABLE IF NOT EXISTS summary_anchors (
      memory_id     TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      source_ids    TEXT NOT NULL,        -- JSON 数组：被压缩的源记忆 id
      summary_of    TEXT NOT NULL,        -- 会话段描述（展开时的标题）
      summary_level INTEGER NOT NULL DEFAULT 1,   -- ④ 渐进式压缩层级
      expandable    INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL
    ) STRICT;

    -- ③ 压缩运行审计：幂等 + 降级依据
    CREATE TABLE IF NOT EXISTS compaction_runs (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      level      INTEGER NOT NULL,
      input_ids  TEXT NOT NULL,           -- JSON 数组
      output_id  TEXT,                    -- 成功时的摘要记忆 id
      status     TEXT NOT NULL CHECK (status IN ('ok','fallback','failed')),
      cost_ms    INTEGER,
      created_at INTEGER NOT NULL
    ) STRICT;

**复用而非新建**：摘要记忆本体走现有 memories + memory_versions（time 开关下每次「再压缩」= update 追加世界线版本，旧摘要天然隐藏）；memory_vectors/memories_fts 自动参与三路检索，无需特殊处理。

## 3. 事件流与管线（触发点、先后关系、防循环）

    turn/end 事件（现有写入管线完成之后，同 handler 内追加）：
      ① classifyValue(轮次文本 + 工具使用信号) → turn_values 写入
      ② shouldCompact(sessionId)：
           会话累计 tokens ≥ triggerTokens（自适应阈值，见 §8）
           或 noise 占比恶化（近 20 轮 noise > 60%）
         → 不满足则结束（零成本）
      ③ 候选选择：该 scope 下按 [value_class, updated_at] 排序，排除
           - 最近 keepRecency 轮产生的记忆（内容感知分层保留）
           - 已有活跃锚点的源记忆（幂等）
           - core 类记忆（高价值不压，除非 level ≥ 2）
         数量 < minSourceMemories → 结束
      ④ buildSummary：LLM 生成 SummaryDocument（失败 → 降级：截断拼接）
      ⑤ transferProtocol：store.add(摘要) 成功 commit → 写锚点 → store.forget(源)
          任何一步失败：源记忆保留，compaction_runs 记 failed（无损失语义）
      ⑥ 图谱：graphLink(摘要, 实体)（graph 开关开启时）

**与现有管线的关系**：
- **写入管线（autoWrite）**：压缩产物也是记忆，但 add 时 type='summary' 且走独立路径（不经过 upsertMemory 的 Jaccard 合并，避免与普通记忆合并）；产物绝不进入 turn_values 原料（防循环：记录时按 type 过滤）。
- **refiner**：refiner = 轮次级蒸馏（turn → 一条自包含结论）；compactor = 会话段级压缩（多条记忆 → 一条摘要）。两级正交：refiner 开启时 compactor 输入更干净；refiner 关闭时 compactor 输入是规则沉淀的 ep 记忆。
- **注入管线（pre-step）**：摘要记忆自动参与检索/注入，无需改动；注入内容永不当压缩原料（沿用 source.kind==='user' 过滤）。
- **遗忘曲线**：被压缩源记忆在 forget 时删除，strength 不再有意义；摘要记忆正常参与 decay。

## 4. 转移协议落地（只用现有 API + 3 个新 store 方法）

现有 API 已足够覆盖主干：
- add({ content: 摘要, type: 'summary', layer: 'sm', keywords }) → **先入库**
- forget(id) → 逐个删除源（锚点已持久化，可回溯）
- update(id, …) → 多级再压缩（走世界线版本，旧摘要隐藏）
- graphLink(summaryId, entities) → 实体节点

**新增 store 方法（3 个，签名草案）**：

    // store.js 新增
    addSummaryAnchor({ memoryId, sourceIds, summaryOf, level })  // 转移后写锚点
    getSummaryAnchor(memoryId)        // → { sourceIds, summaryOf, level } | undefined
    findAnchorBySource(memoryId)      // → 该源记忆是否已被某摘要覆盖（幂等查重）
    runInTransaction(fn)              // BEGIN IMMEDIATE 包装（add+锚点+forget 的原子性）

**顺序保证（先进库再消失）**：
1. store.add(摘要) commit 成功（此刻源记忆仍在，双份存在是安全的中间态）
2. addSummaryAnchor（摘要 → 源 id 列表持久化）
3. 逐个 store.forget(源)
4. compaction_runs 记 ok

任何一步异常 → 回滚到「只有摘要、源全在」或「源全在」的状态，绝不出现「源没了摘要也没了」。**幂等**：同一 session 的候选集合若已有活跃锚点（findAnchorBySource 命中）则跳过。

## 5. 图谱接线（summarizes 边）

- **现状**：graphLink(memoryId, entityLabels) 只建 entity 节点 + mentions 全连接。
- **接线**：压缩后调用 store.link(summaryId, sourceId, 'summarizes')（新增）：

    // store.js 新增：记忆级连边（内部取两记忆的节点集，跨集连 type 边）
    link(fromMemoryId, toMemoryId, type, weight = 1)
    // 摘要的每个实体节点 --summarizes--> 每个源记忆的实体节点

- 效果：memoryNeighbors(源记忆) 沿 summarizes 反边可达摘要；memory_expand 用锚点表（关系投影，快路径），图路径给「知识溯源」慢路径。
- **依赖**：summarizes 是 8 型边的第一条落地边，不依赖阶段三 8 型边全量；link() 实现与 mentions 同构，可先行。

## 6. 配置与开关（settings schema 扩展）

    // Config 新增段（z = schemastery，与现有风格一致）
    compaction: z.object({
      enabled: z.boolean().default(false),            // 总开关（默认关，省成本，与 refiner 同策略）
      provider: z.string().default('opencode-go'),
      model: z.string().default('deepseek-v4-flash'),
      apiKeyEnv: z.string().default('MEMORY_COMPACTOR_API_KEY'),
      triggerTokens: z.number().min(1000).max(200000).default(24000),  // ⑤ 会话预算阈值
      minSourceMemories: z.number().min(2).max(50).default(4),          // 候选最少条数
      keepRecency: z.number().min(0).max(20).default(4),                // ① 最近 N 轮不压
      maxLevel: z.number().min(1).max(3).default(2),                    // ④ 渐进式上限
      summarizeMaxTokens: z.number().min(200).max(4000).default(800),
      fallbackTruncate: z.boolean().default(true),                      // LLM 失败降级规则路径
    }),

**开关矩阵新增项**：features.compaction: false（默认关）。与 refiner.enabled 独立可关；graph 开启时压缩自动建 summarizes 边。GUI 改动 applies:'live' 已有，事件回调内 getCfg() 每次读最新值，无需额外工作。

## 7. 工具面（defineTool 草案，遵守「每个 object 节点显式 additionalProperties」）

    // ① 展开压缩摘要（六维度之⑥的 agent 入口）
    defineTool({
      name: 'memory_expand',
      description: '展开一条压缩摘要：返回摘要内容与其覆盖的源记忆（世界线旧版本）。',
      parameters: { id: { type: 'string', required: true, description: '摘要记忆 id（如 mem-xxxx）' } },
      execute(args) {
        const anchor = store.getSummaryAnchor(args.id)
        if (!anchor) return { summary: store.get(args.id)?.content ?? '', sources: [], note: '该记忆不是压缩摘要' }
        return {
          summary: store.get(args.id)?.content ?? '',
          sources: anchor.sourceIds.map((sid) => {
            const mem = store.get(sid)
            const vers = store.versions(sid, 3)   // 世界线：被压缩前的旧版本仍可读
            return { id: sid, current: mem?.content ?? '(已删除)', versions: vers.map((v) => ({ revision: v.revision, content: v.content })) }
          }),
        }
      },
    })

    // ② 手动触发压缩（force 用于调试/即时瘦身）
    defineTool({
      name: 'memory_compact',
      description: '手动触发一次上下文压缩：把低价值历史记忆合并为摘要。',
      parameters: { scope: { type: 'string', description: '作用域（默认当前）' }, force: { type: 'boolean', description: '跳过阈值检查强制执行' } },
      execute(args) { const r = compactor.maybeCompact(sessionId, scope, { force: args.force }); return { created: r.created, removed: r.removed, summaryId: r.summaryId } },
    })

    // ③ 预览（不改库，先看再压）
    defineTool({
      name: 'memory_compact_preview',
      description: '预览哪些记忆会被压缩（只读，不改库）。',
      parameters: { scope: { type: 'string', description: '作用域（默认当前）' } },
      execute(args) { return { candidates: compactor.preview(scope).map((c) => ({ id: c.id, valueClass: c.valueClass, content: c.content.slice(0, 120) })), estimateTokens: 0 } },
    })

## 8. GUI 设置面板新增区块

「记忆」整页面板追加第三区块「压缩（compaction）」：
- 总开关 compaction.enabled（toggle，live）
- triggerTokens（数字输入 + 说明「会话累计 token 超过后自动压缩」）
- keepRecency（数字，保留最近 N 轮）
- maxLevel（1-3 选择，渐进式层级）
- 供应商下拉（api.llm.providers() 动态）+ 模型级联（api.llm.models()）+ 密钥输入（apiKeyEnv 跟随供应商声明，写 ~/.dsh/.credentials.yaml，UI 只显示「已配置」徽标）——**完全复用现有 refiner 区块的交互模式**
- 「预览压缩」按钮 → 调 memory_compact_preview 渲染候选表格（id/valueClass/内容截断/预计 token）

## 9. 测试与分期路线图（对应提案 §12）

| 期 | 内容 | 验收标准 | 与阶段三关系 |
|---|---|---|---|
| **期 1：存储 + 信号** | turn_values / summary_anchors / compaction_runs 建表；store 新增 4 方法；classifyValue 规则判定 | test-compaction.mjs：信号写入、锚点查重、事务回滚、runInTransaction 原子性 | 无依赖，立即可开工 |
| **期 2：压缩执行** | shouldCompact 自适应阈值；buildSummary（LLM + 规则降级）；转移协议全链路；防循环 | 集成测试：超阈值触发 → 摘要入库 → 源删除 → 锚点可查 → 失败降级源保留 | 无依赖 |
| **期 3：工具 + GUI** | memory_expand/compact/compact_preview 工具；面板「压缩」区块；供应商/密钥跟随 | 工具可展开被压记忆的世界线旧版；GUI live 生效 | 无依赖，与阶段三（真 embedding）**可并行** |
| **期 4：图谱 + 多级** | store.link + summarizes 边；maxLevel ≥ 2 再压缩走世界线 | 图遍历经 summarizes 反向可达摘要；二级摘要可见版本链 | summarizes 边与 8 型边合流（8 型边落地第一条） |

## 10. 风险落地检查（对照提案 §11）

| 提案风险 | 落地对策 |
|---|---|
| LLM 成本失控 | enabled 默认关 + triggerTokens 上限 + 每会话最多 1 次/阈值区间 + preview 先看再压 |
| 压缩丢关键信息 | ① keepRecency 保留最近轮；core 类不压；展开工具兜底；世界线不销毁（memory_versions 保留源记忆旧版，forget 只删活跃切片） |
| 循环压缩（产物再入原料） | type='summary' 过滤 + 锚点幂等 + compaction_runs 审计 |
| 转移中途崩溃 | 先进库再消失顺序 + BEGIN IMMEDIATE 事务 + failed 状态源保留 |
| 多进程并发写 | 沿用 busy_timeout + BEGIN IMMEDIATE 串行化（与现状一致） |
| 提案假设与现状不符处 | ① 提案假设「8 型边已就绪」——现状仅 mentions 骨架，summarizes 需随期 4 落地；② 提案假设真语义 embedding——现状 rule 哈希，摘要检索质量受益于阶段三真 embedding 但**非前置** |

## 实施检查清单

- [ ] 期 1：三张新表 DDL 进 store.js SCHEMA；addSummaryAnchor/getSummaryAnchor/findAnchorBySource/runInTransaction 实现
- [ ] 期 1：test-compaction.mjs（信号/锚点/事务回滚 ≥ 6 项）
- [ ] 期 2：lib/compactor.js（classifyValue/shouldCompact/buildSummary/transferProtocol）
- [ ] 期 2：index.js turn/end 接线（压缩产物 type='summary' 防循环）
- [ ] 期 2：LLM 失败降级路径 + compaction_runs 审计写入
- [ ] 期 3：memory_expand / memory_compact / memory_compact_preview 工具注册（additionalProperties 规范）
- [ ] 期 3：client/index.jsx「压缩」区块 + build-client.mjs 重建 bundle
- [ ] 期 4：store.link(memoryA, memoryB, type) + 压缩后建 summarizes 边
- [ ] 期 4：maxLevel ≥ 2 再压缩走 update 世界线
- [ ] 全期：README/ARCHITECTURE.md 更新 + 部署副本同步 + 重启 dsh web 验证
