/**
 * 插件配置（原 lib/index.js Config，v0.10 拆分独立）——参数 + 功能开关矩阵（§16）。
 * imports 由 lib/tools 与 lib/index.js 复用。
 */
import z from '@deepseek-ai/schemastery'

/** 插件配置：参数 + 功能开关矩阵（§16）。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 数据库文件；留空默认 ~/.dsh/memory.db */
  dbFile: z.string().default(''),
  /** 默认作用域（跨会话默认收窄到当前工作目录名，避免全局泄漏） */
  scope: z.string().default(''),
  /** 每次注入最大 token 估算 */
  injectMaxTokens: z.number().min(100).max(4000).default(800),
  /** 注入最低分数（RRF 融合量纲：三路全中 ~0.049、单路 rank1 ~0.016；0.02 ≈ 至少一路排前 10，
   *  跨领域弱命中更少混入——v0.9.4 由 0.015 上调） */
  injectMinScore: z.number().min(0).max(1).default(0.02),
  /** 步距节流：每 N 步全量重检索 */
  stepInterval: z.number().min(1).max(10).default(2),
  /** 每个 agent 最近注入窗口（防循环） */
  maxRecentPerAgent: z.number().min(1).max(50).default(6),
  /** 每条记忆最多保留版本数（世界线长度） */
  maxVersionsPerMemory: z.number().min(1).max(50).default(8),
  /** 独立提取模型（refiner）：用 LLM 从会话中蒸馏有效记忆，替代原始高噪声文本入库。 */
  refiner: z.object({
    /** 开关：开启后 turn/end 走 LLM 提取（失败自动降级规则路径）。 */
    enabled: z.boolean().default(false),
    /** 提取用的 provider（如 opencode-go / deepseek-official / 自建独立供应商）。 */
    provider: z.string().default('opencode-go'),
    /** 提取用的模型（如 deepseek-v4-flash / deepseek-v4-pro）。 */
    model: z.string().default('deepseek-v4-flash'),
    /**
     * 独立密钥引用名（凭据文件 ~/.dsh/.credentials.yaml 中的键）。
     * 该 provider 的 adapter 通过此引用解析 API key；密钥绝不进入 settings 文档/记忆库。
     * 使用自建供应商时，在「设置→模型」添加 provider 并把 apiKeyEnv 设为同名。
     */
    apiKeyEnv: z.string().default('MEMORY_REFINER_API_KEY'),
    /** 提取输出最大 token。 */
    maxTokens: z.number().min(100).max(4000).default(800),
  }),
  features: z.object({
    /** 自动写入（turn/end 沉淀） */
    autoWrite: z.boolean().default(true),
    /** 价值门（噪音过滤） */
    valueGate: z.boolean().default(true),
    /** 去重合并（相似记忆更新而非新建） */
    dedupMerge: z.boolean().default(true),
    /** pre-step 自动注入 */
    preStepInject: z.boolean().default(true),
    /** 管理工具集 */
    manageTools: z.boolean().default(true),
    /** 时间维度（版本化世界线） */
    time: z.boolean().default(true),
    /** 图谱骨架（节点+共现边） */
    graph: z.boolean().default(false),
  }),
  /** 嵌入模型（阶段三④）：rule 哈希兜底 | remote OpenAI 兼容 API | onnx 本地（预留） */
  embedding: z.object({
    provider: z.string().default('remote'),
    model: z.string().default('Qwen/Qwen3-VL-Embedding-8B'),
    baseUrl: z.string().default('https://api.siliconflow.cn/v1'),
    apiKeyEnv: z.string().default('MEMORY_EMBEDDING_API_KEY'),
    cacheSize: z.number().min(64).max(8192).default(1024),
  }),
  /** 重排模型（阶段三④）：RRF 融合后精排（失败降级 RRF 顺序） */
  reranker: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default('remote'),
    model: z.string().default('Qwen/Qwen3-VL-Reranker-8B'),
    baseUrl: z.string().default(''),
    apiKeyEnv: z.string().default('MEMORY_RERANK_API_KEY'),
    topK: z.number().min(5).max(50).default(20),
    minCandidates: z.number().min(2).max(20).default(3),
    rrfWeight: z.number().min(0).max(1).default(0.7),
  }),
  /** 图谱力导向参数（GUI 记忆图谱物理手感；改后重开图谱面板生效） */
  graphView: z.object({
    spring: z.number().min(0.02).max(0.5).default(0.13),
    repulsion: z.number().min(0.2).max(2).default(1),
    damping: z.number().min(0.05).max(0.9).default(0.3),
    gravity: z.number().min(0).max(0.05).default(0.005),
    // v0.9.9 纵深拖尾（纯视觉）：每节点沿同一方向延伸的渐变"延长"，角度可调
    depthAngle: z.number().min(-180).max(180).default(20),     // 度；正 = 向右上纵深（越远越往上）
    trailSegments: z.number().min(0).max(12).default(4),       // 每节点延长段数（0 = 关闭纵深）
    trailGap: z.number().min(2).max(120).default(26),          // 每段间距（world px）
    trailShrink: z.number().min(0.4).max(0.95).default(0.78),  // 每段缩放
    trailFade: z.number().min(0.3).max(1).default(0.82),       // 每段淡化
  }),
  /** 管家（阶段三⑥）：低频自动巡检（去重/老化，只读报告不擅改数据）。
   *  触发策略（与对话轮数解耦）：每写入 interval 条记忆 或 距上次巡检超 maxIntervalHours 小时。 */
  housekeeping: z.object({
    enabled: z.boolean().default(true),
    interval: z.number().min(5).max(500).default(20),   // 每沉淀 N 条记忆巡检一次
    maxIntervalHours: z.number().min(1).max(720).default(24),  // 时间兜底（小时）
    dedupThreshold: z.number().min(0.8).max(0.99).default(0.92),
    agingDays: z.number().min(7).max(365).default(30),
  }),
  /** 事件分类（阶段四 v0.9.0）：时间连续 + 因果相关的记忆聚簇（区别于主题语义聚类） */
  events: z.object({
    enabled: z.boolean().default(true),
    gapHours: z.number().min(0.5).max(48).default(2),  // 时间线扫描间隔阈值（小时）
  }),
  /** 运行日志（阶段四 v0.9.5）：背后运行了什么完全透明可见 */
  logging: z.object({
    enabled: z.boolean().default(true),
    maxRows: z.number().min(100).max(10000).default(2000),  // 日志保留条数（惰性裁剪）
  }),
})
