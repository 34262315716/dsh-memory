# dsh-memory 嵌入模型 + 重排模型设计

> 立项依据：用户要求插件加入嵌入模型与重排模型；对齐提案 §2.7（Embedding Seam：rule | onnx | remote 三级）与阶段三④「真 embedding」。
> 现状：rule 哈希 embedding（FNV-1a，256 维，确定性但弱语义）+ 三路 RRF 融合，无重排。
> 原则：离线可用不牺牲（降级链）、Windows 无编译依赖、配置 live 生效、迁移自动化。

## ✅ 决策已定（2026-08-15，实测通过）

| 项 | 决策 | 实测 |
|---|---|---|
| 服务 | 硅基流动 https://api.siliconflow.cn/v1（OpenAI 兼容） | ✅ 连通 |
| 嵌入模型 | Qwen/Qwen3-VL-Embedding-8B | ✅ **4096 维** |
| 重排模型 | Qwen/Qwen3-VL-Reranker-8B | ✅ 排序正确（KNN 文档 0.548 > 相关 0.028 > 无关 0.0005） |
| 密钥 | 已写 ~/.dsh/.credentials.yaml（MEMORY_EMBEDDING_API_KEY / MEMORY_RERANK_API_KEY，不进 settings/记忆库） | ✅ |
| 路线 | remote 优先（本轮落地）；onnx 本地后置（期 3）；模型文件策略仅 onnx 路线需要 | — |
| 4096 维含义 | vec0 表重建为 4096 维；1000 条记忆 ≈ 16MB 向量存储，可接受；如需降维可后试 MRL dimensions 参数 | — |

## 0. 关键事实（设计依据）

- **DeepSeek 官方 API 没有 embedding 端点**（github issue #806 确认）——remote 路线必须走第三方 OpenAI 兼容服务（如硅基流动 bge-m3 / 阿里百炼 / 智谱）
- bge-small-zh-v1.5：512 维，int8 量化 ~24MB，中文语义嵌入的轻量标准选择
- bge-m3：1024 维多语言，remote API 场景的常用模型
- bge-reranker-v2-m3：cross-encoder 重排模型，fp32 ~2.3GB / onnx int8 ~200MB（大，本地部署成本高）
- onnxruntime-node：官方 Windows prebuilt，无编译 ✅；但 **onnx 路线需要自己解决 tokenizer**（BERT WordPiece）——这是本地路线的最大复杂度
- transformers.js（@huggingface/xenova 转换管道）：tokenizer 内置、模型经 HF 下载缓存，本地离线的更省事路线，但包体积大

## 1. 总体架构

    检索管线（写入侧 embed(content) → vec0 向量表；查询侧 embed(query) → KNN）
      路1 FTS5 BM25 ─┐
      路2 关键词交集 ─┼─ RRF 融合排序 ──▶ topK 候选（20 条）
      路3 vec0 KNN  ◀┘
                            │
                 ┌──────────▼───────────┐
                 │ reranker（可开关）     │
                 │ (query, doc) 对打相关分 │
                 └──────────┬───────────┘
                            ▼
                    RRF×rerank 融合分 → 最终排序
                    （reranker 失败/关闭 → 直接用 RRF 顺序，零损失）

Embedder 与 Reranker 均为**可插拔 provider**，所有调用点收敛到统一接口，store 不感知具体实现。

## 2. Embedder seam（接口 + 三实现 + 降级链）

**接口**：

    interface Embedder {
      name: string                 // 'rule' | 'onnx' | 'remote'
      dim: number                  // 向量维度（决定 vec0 表结构）
      ready: Promise<void>         // 初始化（模型加载 / 连通性探测）
      embed(texts: string[]): Promise<number[][]>   // 批量嵌入
    }

**三实现**：

| provider | 实现 | 维度 | 特点 |
|---|---|---|---|
| rule | 现有 FNV-1a 双哈希（零改动复用） | 256 | 离线确定性、零依赖、弱语义——**永久兜底** |
| remote | OpenAI 兼容 /v1/embeddings（baseUrl + apiKeyEnv 密钥跟随；批量 ≤32/请求） | 模型决定（bge-m3=1024） | 零部署、质量最高、需外网 |
| onnx | 本地 ONNX 推理（bge-small-zh-v1.5 int8，onnxruntime-node / transformers.js + tokenizer） | 512 | 完全离线、隐私、CPU 推理 ~10-50ms/条 |

**降级链**（初始化时按序尝试，启动日志记录实际生效项）：

    onnx 加载失败 → remote 连通失败 → rule（永不失败）
    （配置顺序可调：默认 remote → onnx → rule，离线场景自动落到 rule）

**接入点收敛**：store.js 现在 4 处硬编码 ruleEmbed（add / update / search / rollback）→ 改为 this.embed()，store 构造时注入 embedder 实例；index.js 在 apply() 里按配置初始化。

**LRU 缓存**：embed 结果按文本哈希缓存（1024 条）——注入管线有签名去抖，同一 query 重复 embed 是常态；写入侧 content 不变不重嵌。

## 3. Reranker（后置精排）

**接口**：

    interface Reranker {
      name: string                 // 'remote' | 'onnx'
      rerank(query: string, docs: string[]): Promise<{ index: number, score: number }[]>
    }

**位置**：search() 的 RRF 融合排序完成后，取 topK（20）候选 → rerank → 融合。

**两实现**：
- remote：rerank API（Jina AI r.jina.ai 免费额度 / 硅基流动 bge-reranker-v2-m3），单次 POST 批量 ≤100 对
- onnx：本地 bge-reranker-v2-m3 int8（~200MB，模型大，列为后期可选）

**分数融合**（保留多路信号，重排只做微调）：

    final = 0.7 × norm(rrfScore) + 0.3 × rerankScore

权重进配置（rrfWeight 0.0~1.0，0.3 默认）。

**触发与保护**：
- enabled 总开关 + 候选数 ≥ minCandidates（3）才重排（2 条以内重排无意义）
- 超时 800ms / 失败 → 降级 RRF 顺序（零损失）
- 缓存 (queryHash, docHash) → score：注入签名去抖场景下命中率高

## 4. 模型与依赖决策

| 决策点 | 推荐 | 理由 |
|---|---|---|
| onnx 路线 tokenizer | transformers.js（内置管道）或 remote 优先 | 手写 WordPiece 是坑；remote 零部署质量最高 |
| 模型文件分发 | **首用下载缓存到 ~/.dsh/models/** + 失败降级 + 手动放置兜底 | 插件包不膨胀；下载失败自动落 rule |
| remote 服务商 | 硅基流动（bge-m3 embedding + reranker）或 Jina（rerank 免费额度） | DeepSeek 官方无 embedding 端点 |
| 嵌入模型 | remote: bge-m3；onnx: bge-small-zh-v1.5 int8 | 中文质量/体积平衡 |
| 重排模型 | remote 优先；本地 onnx 后置 | reranker 模型大（~200MB），本地部署收益/成本比低 |

## 5. 数据迁移（维度切换自动化）

provider 切换（rule 256 ↔ onnx 512 ↔ remote 1024）导致 vec0 维度变化：

    启动/配置变化时检测：embedder.dim ≠ vec0 表实际维度 → 迁移模式
      1. DROP memory_vectors → 按新 dim CREATE（rowid 对齐不变）
      2. 后台队列逐条重嵌入（每批 16 条，让出事件循环不阻塞启动）
      3. 迁移期 vecEnabled = false（向量路自动退出 RRF；FTS5 + 关键词照常服务）
      4. 完成 → vecEnabled = true；stats 增加 { embeddingProvider, dim, migration: {done, pending} }
      5. 中断恢复：启动时检测「vec0 空表 + memories 有数据」→ 续跑迁移

**手动工具**：memory_reembed（触发全量重嵌入 + 返回进度）。

## 6. 配置 schema + GUI

    // Config 新增两段
    embedding: z.object({
      provider: z.string().default('remote'),            // rule | remote | onnx
      model: z.string().default('BAAI/bge-m3'),          // remote 模型名 / onnx 本地模型名
      baseUrl: z.string().default(''),                    // remote 端点（OpenAI 兼容）
      apiKeyEnv: z.string().default('MEMORY_EMBEDDING_API_KEY'),
      cacheSize: z.number().min(64).max(8192).default(1024),
    }),
    reranker: z.object({
      enabled: z.boolean().default(false),
      provider: z.string().default('remote'),            // remote | onnx
      model: z.string().default('bge-reranker-v2-m3'),
      baseUrl: z.string().default(''),
      apiKeyEnv: z.string().default('MEMORY_RERANK_API_KEY'),
      topK: z.number().min(5).max(50).default(20),
      minCandidates: z.number().min(2).max(20).default(3),
      rrfWeight: z.number().min(0).max(1).default(0.7),
    }),

GUI：「记忆」面板「检索与注入」区块下加两组（沿用现有 provider 下拉 + 模型输入 + 密钥跟随 + 徽标模式）；provider/dim 变化 → live 触发热迁移。

## 7. 影响面清单

- store.js：构造注入 embedder/reranker；4 处 ruleEmbed → this.embed；search() 后置 rerank；维度迁移逻辑
- index.js：embedder/reranker 工厂 + 降级链初始化；settings schema；memory_reembed 工具；后台迁移队列
- client/index.jsx + build-client：GUI 两组控件
- package.json：按最终路线加依赖（onnxruntime-node 或 @huggingface/transformers）
- 测试：embedder 接口 mock 单测 / 维度迁移（256→512 重建+重嵌）/ 降级链 / rerank 融合与降级
- 部署：模型缓存目录说明 + 离线场景指引

## 8. 分期路线

| 期 | 内容 | 验收 | 风险 |
|---|---|---|---|
| 期 1 | embedder seam 抽象 + rule 实现迁移（零行为变化） | 51 项测试不回归 + 接口单测 | 低 |
| 期 2 | remoteEmbedder + 配置/GUI + 维度迁移 + memory_reembed | 真语义召回 A/B 对比（rule vs remote） | 中（网络） |
| 期 3 | onnxEmbedder（tokenizer 路线定夺）+ 模型缓存策略 | 断网可用 + 下载失败降级 | 中（tokenizer） |
| 期 4 | reranker remote + 融合公式 + 缓存 + 超时降级 | 重排后注入命中率提升可测 | 低 |
| 期 5（可选） | onnxReranker 本地重排；Jaccard 去重升级为余弦相似去重 | — | 高（模型大） |

## 9. 待拍板决策点

1. **嵌入 provider 优先级**：remote 优先（质量高、零部署，默认推荐）还是 onnx 优先（离线隐私）？
2. **嵌入模型**：remote 用 bge-m3（1024 维多语言）还是 bge-small-zh（512 维中文轻量）？
3. **模型文件分发**：首用下载缓存（推荐）vs 随包分发 vs 手动放置？
4. **reranker 路线**：先 remote（Jina/硅基，推荐）够用？本地 onnx reranker（~200MB）后置？
5. **融合权重**：RRF 0.7 + rerank 0.3（保守，推荐）还是重排主导（0.5/0.5）？
