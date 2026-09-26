/**
 * 插件配置（原 lib/index.js Config，v0.10 拆分独立）——参数 + 功能开关矩阵（§16）。
 * imports 由 lib/tools 与 lib/index.js 复用。
 */
import z from '@deepseek-ai/schemastery'

/**
 * 注入节奏档位（v0.11.2）：把「多久检索注入一次」做成手感旋钮。
 *
 * 为什么做成档位而不是只留一个数字：步距是"打扰频率"的直接体感，但用户要先理解
 * "步"的含义、RRF 重检、去抖窗口才能填对数字——填 2 嫌吵、填 60 又像坏了。
 * 三档给出可预期的节奏，要精确再走「自定义」档 + stepInterval。
 *
 * 单一来源：inject.js 一律经 resolveStepInterval() 取值，不在别处再算。
 */
export const INJECT_PACE_STEPS = { aggressive: 4, steady: 12, lazy: 30 }
/** 档位中文标签（GUI 下拉与文档共用一份文案，避免两处漂移）。 */
export const INJECT_PACE_LABELS = { aggressive: '激进', steady: '平稳', lazy: '懒惰', custom: '自定义' }

/**
 * 解析当前生效步距：custom → stepInterval（夹到 1~60），档位 → 查表，未知值 → 平稳。
 * 档位用 z.string() 而非 z.union 是有意的：写错档位时静默回落「平稳」，
 * 而不是让 settings 校验抛错把整个 memory 命名空间带下水（本插件的第一原则：dsh 必须存活）。
 */
export function resolveStepInterval(cfg = {}) {
  if (cfg.injectPace === 'custom') {
    const n = Number(cfg.stepInterval)
    // 非法值（非数/小于 1）不猜：回落「平稳」，而不是夹到 1 变成"每步都检"——
    // 用户调步距的意图永远是"少打扰一点"，猜错方向最刺眼。上限则夹到 60。
    if (!Number.isFinite(n) || n < 1) return INJECT_PACE_STEPS.steady
    return Math.min(60, n)
  }
  return INJECT_PACE_STEPS[cfg.injectPace] ?? INJECT_PACE_STEPS.steady
}

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
  /** 注入节奏档位（v0.11.2）：aggressive=4 步 / steady=12 步 / lazy=30 步 / custom=用 stepInterval。
   *  取值经 resolveStepInterval 解析；写错档位回落 steady，不抛错。 */
  injectPace: z.string().default('steady'),
  /** 步距节流（**仅 injectPace=custom 时生效**）：每 N 步全量重检索（到点必检，同 query 也重检；
   *  重复注入由内容 hash 去抖）。上限 v0.11.2 由 10 放宽到 60——用户要 12 步一检，
   *  而旧上限 10 会把 12 判成非法值（schemastery 报 `expected number <= 10 but got 12`）。 */
  stepInterval: z.number().min(1).max(60).default(10),
  /** 常驻（pinned）记忆每次注入最多几条（v0.13.0）。常驻 = **恒定注入**：
   *  被钉选的记忆不走检索、不看得分、每步都随注入块抵达——用于珍贵教训与铁律，
   *  回答"要一直在场，而不是讲到相关内容才冒出来"（见 pipelines/inject.js buildPinned）。 */
  pinnedLimit: z.number().min(1).max(50).default(8),
  /** 常驻块的独立 token 预算（v0.13.0）：常驻内容不与被检索到的记忆抢 injectMaxTokens。 */
  pinnedMaxTokens: z.number().min(100).max(4000).default(600),
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
    /**
     * 推理档位（随 provider route 透传）。
     *
     * v0.12 默认改为 'low'（明确要思考）。理由——两次同源事故：
     * v0.9.25 曾用「显式传 off」压住"推理吞掉 maxTokens"，但 pi-ai 适配器把 off 翻译成
     * **省略 reasoning 参数**，于是上游模型默认说了算；2026-09-16 换成默认强制思考的
     * deepseek-v4.1-flash 后立刻复发：reasoning_tokens 吃满 800、正文 0 字、蒸馏 100% 降级。
     * 结论：不要试图关掉思考去省预算，而是**给足预算 + 让思考发生**（时间预算兜底）。
     */
    reasoningEffort: z.string().default('low'),
    /**
     * 输出 token 上限：**0 = 不限制**（v0.12 默认）。
     * 不传上限时思考可以想多久就多久，约束只剩 timeBudgetMs；到点掐断后带已写内容续跑，
     * 因此"预算不够导致正文为空"这一类故障从根上消失。
     */
    maxTokens: z.number().min(0).max(200000).default(0),
    /**
     * 单次调用时间预算（毫秒，v0.12）：到点主动掐断 → 把已写内容带回去续跑（断点续思）。
     * 默认 120000 = 2 分钟。0 = 不限时（不推荐，长会话可能长时间占住队列）。
     */
    timeBudgetMs: z.number().min(0).max(600000).default(120000),
    /** 续跑轮数上限（v0.12）：掐断/截断/空输出后最多再发起几次，防止无限续写。 */
    maxContinuations: z.number().min(0).max(8).default(3),
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
    /** 主题区域形状（v0.10.8）：circle=最小外接圆（默认，轮廓连续不抖，同点集最紧的圆）；
     *  hull=贴合凸包（更紧，但凸包顶点会随节点进出而增减 → 轮廓本就易抖，故实现里钉住顶点削弱）。
     *  非法值回落 circle。 */
    themeShape: z.string().default('circle'),
    /** 主题区域显示策略（v0.10.6）：focus=仅显示当前聚焦节点所属主题的完整范围（默认，零干扰）；
     *  always=为每个主题的密集团画（滤掉稀疏末端，最多 8 片）；off=不画。非法值回落 focus。 */
    themeScope: z.string().default('focus'),
  }),
  /** 管家（阶段三⑥ / v0.12.1 真治理）：低频自动巡检。
   *  触发策略（与对话轮数解耦）：每写入 interval 条记忆 或 距上次巡检超 maxIntervalHours 小时。
   *  v0.12.1 起不再"只报告"——见 autoApply。 */
  housekeeping: z.object({
    enabled: z.boolean().default(true),
    interval: z.number().min(5).max(500).default(20),   // 每沉淀 N 条记忆巡检一次
    maxIntervalHours: z.number().min(1).max(720).default(24),  // 时间兜底（小时）
    dedupThreshold: z.number().min(0.8).max(0.99).default(0.92),
    agingDays: z.number().min(7).max(365).default(30),
    /**
     * 自动执行治理（v0.12.1）：开启后巡检不再只报告——近乎重复（≥autoMergeThreshold）
     * 择优保留一条并归档其余，陈旧情景快照归档。**只归档不删除**（memory_archive 可恢复）。
     * 默认 true 是用户 2026-09-21 拍板的「进取档」：他明确说"维护和整合我没有明显感觉"，
     * 而"只报告不动手"正是没感觉的根源。
     */
    autoApply: z.boolean().default(true),
    /** 近乎重复的自动合并阈值（≥此值直接合并；0.92~此值区间留给 LLM 归并，避免丢信息） */
    autoMergeThreshold: z.number().min(0.9).max(0.99).default(0.95),
    /** 情景快照（ep）闲置多少天后归档（0 = 不归档）。ep 是"任务/结果"式过程噪音，会越堆越多 */
    archiveEpAfterDays: z.number().min(0).max(365).default(45),
  }),
  /** 事件分类（阶段四 v0.9.0）：时间连续 + 因果相关的记忆聚簇（区别于主题语义聚类） */
  events: z.object({
    enabled: z.boolean().default(true),
    gapHours: z.number().min(0.5).max(48).default(2),  // 时间线扫描间隔阈值（小时）
  }),
  /**
   * 会话级汇总（v0.12.2）：逐轮提取记的是"这一轮发生了什么"，
   * 它记不了"整段会话最后落在哪里"——这一层专门补那个缺口。
   */
  sessionSummary: z.object({
    enabled: z.boolean().default(true),
    /** 累积多少轮对话后做一次汇总（5~100） */
    rounds: z.number().min(5).max(100).default(12),
  }),
  /** 运行日志（阶段四 v0.9.5）：背后运行了什么完全透明可见 */
  logging: z.object({
    enabled: z.boolean().default(true),
    maxRows: z.number().min(100).max(10000).default(2000),  // 日志保留条数（惰性裁剪）
  }),
})
