/**
 * 插件配置（原 lib/index.js Config，v0.10 拆分独立）——参数 + 功能开关矩阵（§16）。
 * imports 由 lib/tools 与 lib/index.js 复用。
 */
import z from '@deepseek-ai/schemastery'
import { volatileTable } from './compat.js'

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

/**
 * 插件配置：参数 + 功能开关矩阵（§16）。
 *
 * v0.14.0 跨内核适配：整表标 `volatile`（`volatileTable()` 是防御性包装，老版 schemastery
 * 没有 `.volatile()` 时原样返回 = 老内核行为不变）。
 *
 * 为什么必须标：0.1.7（#677）起内核不再"注册命名空间"，设置页的表单是从
 * **插件导出的 Config schema** 反推出来的——`dsh-settings/lib/index.js:122-131 volatileForm()`
 * + `:419 if (form === void 0) return [];`。**一个 volatile 字段都没有的 Config
 * 连 descriptor 都不产生**，用户在设置页看到的是空白（同代活样本：`@nanmicoder/dsh-agent-teams`
 * 就是零 volatile，它在设置页里没有任何字段）。
 *
 * 为什么选"整表"而不是"逐字段"：逐字段时每个 volatile 字段在解析后是 cosmokit `Volatile`
 * 引用而不是值（实测 `parsed.injectPace === 'steady'` 为 **false**，必须 `.get()`），
 * 本插件数十处读取都会静默读到对象。整表 volatile 时 `config.get()` 一次就是全 plain 配置
 * （实测 `w.get() → {"a":"y","b":1}`），读取出口只多一次方法调用。
 * 两种流派不可混用（混用会抛 `volatile fields require a fixed object path without an
 * enclosing volatile field`），所以这里**只在最外层标一次**。
 */
export const Config = volatileTable(z.object({
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
  /**
   * 常驻（钉选）记忆的**注入粒度**（v0.18.0）：`session`（默认）/ `step`。
   *
   *  - `step`（旧行为）：每一步都随注入块抵达。长会话里同一段文本在每一步的 prompt 里重复，
   *    既烧 token，也让模型每一步都被同一批内容拽住。
   *  - `session`（默认）：会话首轮注入一次，之后只在**清单发生变化**时补一条增量
   *    （新增钉选 / 取消钉选 / 已钉内容被修改），不再重复发整份。见 pipelines/inject.js。
   *
   * 两种模式下常驻的语义完全一样——不看相关性、不看得分、不受节流；改的只是时机与去重。
   * 用 z.string() 而非 z.union：写错时静默回落默认档，而不是让 settings 校验抛错把整个命名空间带下水。
   */
  pinnedInjection: z.string().default('session'),
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
     * 推理档位（随 provider route 透传）。**默认 'off' = 不思考**（2026-10-06 主人定）。
     *
     * ⚠️ 这个字段的**翻译方式按协议分两种，且正好相反**（2026-10-13 实测修正）——
     * 改代码前先读 lib/refiner.js 文件头 ①：
     *   - pi-ai 路由（opencode-go 等）：'off' 翻译成"**不传**该字段"。pi-ai 的 deepseek 格式里
     *     只要这个字段**存在**（哪怕值是 'off'）就会发 `thinking: { type: 'enabled' }`；
     *     真正关闭要根本不带它。另外还需 provider 侧给该模型声明非 null 的 off 映射。
     *   - 官方 Messages 路由（deepseek-official 等）：'off' **原样显式传**。它的回落链在
     *     没配 reasoningEffort/thinking 时落到 'high'（打开高思考），只有显式传 off 才关得掉。
     *     2026-10-12 切到官方路由后提取批量失败（一天 0 成功 / 16 失败、思考 5.7 万字正文 2 千字）
     *     就是踩在这里。
     * 该按哪种姿势由 reasoningParam() 按 provider 决定，本字段只表达"想不想要思考"。
     *
     * 想要思考就填 low / high / max（两种协议都原样透传）。
     */
    reasoningEffort: z.string().default('off'),
    /**
     * 哪些路由走官方 Messages 协议（v0.16.1，用于决定"关思考"的写法）。
     *
     * 数组里每项是**路由名片段**（子串匹配，大小写不敏感）。默认 ['deepseek-official']。
     * 为什么要它：DSH 的调用配置里拿不到适配器身份，只能按路由名认；而路由名由用户在 profile
     * 里自起，别人可能叫 `deepseek`、`deepseek-api`——所以做成可配，认错了能直接改。
     * 留空数组 = 一律按 pi-ai 姿势处理（v0.16.0 的旧行为）。
     */
    messagesProviders: z.array(z.string()).default(['deepseek-official']),
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
    /**
     * 瞬时故障重试次数（v0.16.1，0~5，默认 2）。
     *
     * 修的是这个缺口：适配器的失败**不在中途抛异常**，而是编码进 finish 块；插件原本对任何
     * 失败都是**一次就整条丢弃**——而丢弃不可逆（这段对话永远不进库，只剩一条规则快照）。
     * 2026-10-12 官方路由一天 0 成功 / 16 失败，其中 30 次是上游 SSE 流畸形
     * （event precedes message_start），这类抖动重发一次就可能好。
     *
     * **只有瞬时类错误会重发**（网络中断/5xx/流畸形）；配额（429）与请求格式错（400）不重发
     * ——前者要等额度恢复、后者是确定性失败，重试只会白烧配额与时间。
     * 填 0 = 关掉重试，回到 v0.16.0 的一次性行为。
     */
    transientRetries: z.number().min(0).max(5).default(2),
    /** 瞬时重试的基础退避（毫秒，0~60000，默认 800）：第 n 次等 base × 2^(n-1)，封顶 8 秒。 */
    transientBackoffMs: z.number().min(0).max(60000).default(800),
    /**
     * 单侧对话截断字数（v0.13.3，默认 4000）。
     *
     * 提取是**压缩**任务：把整段对话原文（旧值 6000+6000）全塞进去，只会让模型的通读成本
     * 与思考量一起涨——线上实测思考 14122 / 34052 / 45327 字，达到单次输入的 1~3.4 倍。
     * 值得记的信息几乎总在最近几千字里，调小即更省、更快；调大则更全但也更慢。
     */
    dialogChars: z.number().min(500).max(20000).default(4000),
    /** 【库里已有记忆】每条截断字数（v0.13.3，默认 120）：只留判断"是否推翻"所需的骨架。 */
    knownChars: z.number().min(40).max(500).default(120),
    /** 【库里已有记忆】最多给几条（v0.13.3，默认 5）：防检索结果变多后把输入撑爆。 */
    knownTopN: z.number().min(1).max(20).default(5),
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
    /**
     * 用户消息触发检索（v0.16.0）：每条用户消息都重新检索一次，**不受步距节流限制**。
     *
     * 修的是这个缺口：步距按「步」计，而一轮用户消息通常只走几步——平稳档（12 步）下，
     * 用户连问几句新问题，整段都在吃几句之前那次检索的结果。关掉即回到 v0.15.x 的纯步距节奏。
     */
    userMessageTrigger: z.boolean().default(true),
    /**
     * 写入侧预筛（v0.16.0，**v0.16.1 默认改为 false**）：轮次结束时先问一次决策模型
     * 「这段对话值得记吗」。只有它**高把握说"不值得"**（门槛见 decision.writeMinConfidence，
     * 默认 0.9）才省掉这次 LLM 提取，改走规则路径落一条 ep 快照（记录不丢，只是不花 LLM）；
     * 其余一律照常提取。实测：LLM 提取一轮几十秒，这一问本地 0.3~0.9 秒。
     *
     * **为什么默认关掉（2026-10-14 实测）**：它依赖本机决策服务（默认 127.0.0.1:8090）常驻，
     * 而实际使用中决策服务一般不开——上线至今累计 496 次调用：380 次 fetch failed、
     * 116 次 service-down、**成功 0 次**。也就是说这个开关从未省下过一次 LLM，反而每轮写入前
     * 都白等几十毫秒去撞一个没起的服务，还往日志里刷满 warn。
     * 需要它时把决策服务起起来（决策模型技能里有启动脚本）再打开即可。
     */
    writeGate: z.boolean().default(false),
    /**
     * 会话预热通道（v0.14.0 跨内核适配）：
     *  - `auto`（默认）：内核有 systemPrompt 服务 → 走"系统提示段落"（0.2.0-rc.2 的官方路径）；
     *    否则回落老的 `agent/session-start` + `agent.inject()`
     *  - `prompt-section`：强制系统提示段落（老内核上会静默不预热）
     *  - `message`：强制老的消息注入路径（0.2.0-rc.2 上也能用，但对首步为空的情形可见性差）
     * 用 z.string() 而非 z.union：写错时静默回落 auto，而不是让 settings 校验抛错把整个命名空间带下水。
     */
    preheatRoute: z.string().default('auto'),
    /**
     * Web 端点的信任围栏档位（v0.14.0）。
     *
     * DSH 的 WebServer 路由**不继承** Connection 的认证体系（框架原话见 lib/web-fence.js 头注释），
     * 所以 `/dsh-memory/{graph,logs,health}` 得自己挡。默认 `loopback`：只认本机回环 + 同源请求。
     *
     *  - `loopback`（默认）：remoteAddress 必须是 127.0.0.1/::1，Host 必须是本机名字，
     *    且非跨站、Origin 与 Host 同源。
     *  - `off`：不挡。**只有在手机/局域网/反向代理访问 Web GUI 时才该用**——
     *    那种场景 remoteAddress 是局域网地址，默认档会把图谱与健康检查一起拒掉。
     *    关掉之后这三个端点对任何能触达端口的人开放（含 `/health?llm=1` 会真发模型请求）。
     *
     * 同样用 z.string() 而不是 z.union：写错时按默认档（安全侧）走，而不是让校验抛错。
     */
    webFence: z.string().default('loopback'),
    /** 管理工具集 */
    manageTools: z.boolean().default(true),
    /** 时间维度（版本化世界线） */
    time: z.boolean().default(true),
    /** 图谱骨架（节点+共现边） */
    graph: z.boolean().default(false),
  }),
  /**
   * 写入侧决策门（v0.16.0）：本机 StartLux-Decision 9B 的接入参数。
   * 只用于**省掉不必要的 LLM 提取**（见 lib/write-gate.js）；检索路径上不用决策模型，
   * 它出任何问题都不影响检索与提取本身。
   */
  decision: z.object({
    /** 决策服务端点。默认本机 8090，与技能文档里的 DECISION_ENDPOINT 一致 */
    endpoint: z.string().default('http://127.0.0.1:8090/v1/systemone'),
    /** 单次判断超时（毫秒，200~10000，默认 2000）：到点即放弃、照常提取，不让它拖住这一轮 */
    timeoutMs: z.number().min(200).max(10000).default(2000),
    /**
     * 写入侧采信门槛（0.5~0.99，**默认 0.9**）。
     * 定得严是因为代价不对称：判错一次就少记一条（不可逆），放宽门槛省下的只是"多花一次 LLM"。
     */
    writeMinConfidence: z.number().min(0.5).max(0.99).default(0.9),
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
    damping: z.number().min(0.05).max(0.9).default(0.3),
    /** 邻域场强度（v0.15.0）：整场倍率。**没有中心引力这个东西** —— 位置归中改用整体平移
     *  （graph-force.js 的 recenter，等价于 d3-force 的 forceCenter）。0 = 关掉场内力，只剩弹簧。 */
    field: z.number().min(0).max(3).default(1),
    /** 平衡间距（v0.15.0，×k）：力曲线的**唯一零点** —— 比它近就互相排斥、比它远就互相吸引。
     *  取代了旧的 repulsion（斥力系数）与 attract（引力系数）：那两个必须一起调才能让零点落在
     *  想要的位置，而且很容易配出一个"引力永远赢不过斥力"的死参数（v0.14.5 首版就踩过）。
     *  现在平衡距离 = k×此值，直观、可预测。调大 = 更松散；调小 = 更紧密。
     *  ★ 默认 1.2（v0.15.1 从 1.6 下调）：857 点的记忆库按 1.6 排布，面积是画布的 4.8 倍 →
     *  打开时 fit-to-view 只能缩到 0.33×，点细到看不清。1.2 实测缩放到 0.45×，且平衡间距仍有
     *  53px（节点半径 3.5~9.5px + 碰撞间隙 6px 不会互相打架）。还要更大就调这个值。 */
    spacing: z.number().min(1).max(4).default(1.2),
    /** 远场引力峰值（v0.15.1）：越过平衡距离（k×spacing）之后，力的幅度在这里**封顶**，
     *  并随距离线性衰减到邻域半径处归零。**必须小** —— 引力是累加的、斥力是封顶的：
     *  一个点周围壳层里 ~25 个邻居各给一点引力，其和会压过核心斥力 → 整个盘塌成密实圆盘
     *  并持续沸腾（实测：0.25 沸腾 / 0.06 稳定，表见 client/graph-force.js 文件头）。
     *  0 = 只剩斥力（孤立点会更散）；调大 = 小团之间互相靠拢，更容易聚成一片。 */
    attract: z.number().min(0).max(1).default(0.06),
    /** 单帧速度上限（v0.15.1）：数值安全网。近场斥力 ∝ 1/u²，两点贴到一起时单帧冲量极大；
     *  上限让"乱飞"在物理上不可能发生，且**不改变平衡位置**（只截断瞬态，不截断稳态）。
     *  调小 = 更稳、但拖动与回弹更钝；调大 = 更弹、瞬态更猛。 */
    maxSpeed: z.number().min(1).max(20).default(4),
    /** 邻域半径（v0.14.5）：每个节点以自己为中心划出的影响半径 = k×此值。
     *  **半径内的每一对节点**之间才有引/斥力，半径外互不影响（力在边界处平滑归零）。
     *  斥力与引力共用这一个半径（v0.15.0 起由同一条公式给出）。
     *  默认 4.5（按 1200 节点 / 1400×1200 画布，k≈37px → R≈168px）。
     *  调大 = 影响更远、整体更"黏"；调小 = 更局部、更容易分成互不相干的小团。 */
    range: z.number().min(0.5).max(12).default(4.5),
    /** 常活微动（v0.14.4）：收敛后每个节点的净力都归零 → 图会彻底静止。这项给每个节点加一层
     *  **零均值**的低频扰动（相位由 id 哈希决定，周期 16s/22s），节点绕平衡点缓慢游走 ±10~20px，
     *  时间平均为 0 所以布局不会被带偏；只在"冷静"时生效（拖动与回弹期间自动关闭）。
     *  0 = 完全静止；越大越"活"。 */
    wobble: z.number().min(0).max(0.2).default(0.04),
    /** 主题区域形状（v0.10.8）：circle=最小外接圆（默认，轮廓连续不抖，同点集最紧的圆）；
     *  hull=贴合凸包（更紧，但凸包顶点会随节点进出而增减 → 轮廓本就易抖，故实现里钉住顶点削弱）。
     *  非法值回落 circle。 */
    themeShape: z.string().default('circle'),
    /** 主题区域显示策略（v0.10.6）：focus=仅显示当前聚焦节点所属主题的完整范围（默认，零干扰）；
     *  always=为每个主题的密集团画（滤掉稀疏末端，最多 8 片）；off=不画。非法值回落 focus。 */
    themeScope: z.string().default('focus'),
    /**
     * 图谱节点上限（v0.17.1）：超过此数的记忆**按主题折叠成容器节点**，不再逐个画。
     *
     * 为什么加：图谱加载慢的根因是节点数——浏览器端力导向的开销随节点数增长，
     * 真库 1970 条时打开明显变慢。服务端生成只要 ~50ms，瓶颈全在前端。
     * 上限本身不影响数据：被折叠的记忆仍可点开容器查看，一条都不丢。
     *
     * 原来的实现是 store.list({limit:1000}) 硬取前 1000 条、**静默丢弃**其余
     * （最旧那批画不出来）。这里保留上限的收益，去掉丢数据的问题。
     * 1000 = 历史值；调大 = 一次看到更多、更慢；调小 = 更快。
     */
    maxNodes: z.number().min(100).max(5000).default(850),
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
    /**
     * **主题合并**（v0.17.0）：把同一主题下讲同一件事的多条记忆合成一条更完整的结论。
     *
     * 要解决的缺口：注入配额是「6 条 + 800 token」，而记忆平均 227 字——条数配额根本没用满，
     * 瓶颈是 token。合并提高的是**单位 token 的信息密度**，让同样条数覆盖更多内容。
     *
     * 与既有 dedupScan 的分工（本功能存在的理由）：dedupScan 找「几乎一模一样」（余弦 ≥ 0.92），
     * 真实库里几乎不触发；本功能找「同一类、讲同一件事」（同主题 + 余弦 ≥ 阈值，默认 0.75）。
     *
     * 分组规则：**按主题**（2026-10-15 定）。无主题的记忆不参与——占 37%，硬凑会把不相关的并到一起。
     *
     * 源记忆的去向：**保留 + 归档**（archived=1，默认不检索、不注入、不进图谱顶层），
     * 通过 merged_into 指回父记忆；父记忆用 merged_from 记下自己由哪几条合来。
     * 两者在图谱里都看得到：父节点是「容器」，点开侧栏看它装了什么。
     */
    merge: z.object({
      /** 是否启用主题合并。默认关——它会改写记忆库结构，先让用户显式打开。 */
      enabled: z.boolean().default(false),
      /** 组内相似度门槛（0.5~0.95，默认 0.75）。低 = 合得多但可能凑错，高 = 只合几乎重复的。 */
      threshold: z.number().min(0.5).max(0.95).default(0.75),
      /**
       * 单组最多合并几条（2~30，默认 8）。
       * 从 12 降到 8（2026-10-15 预演后调整）：一组 12 条会让模型读很久，且一次丢太多细节的风险更高。
       * 8 条仍能覆盖绝大多数"同类碎片"，合并质量与耗时更平衡。
       */
      maxGroup: z.number().min(2).max(30).default(8),
      /**
       * 每轮巡检最多处理几组（1~50，默认 4）。
       * 从 8 降到 4（同上）：一次合并要几十秒到几分钟，8 组会把单轮巡检拖到 20 分钟以上。
       * 4 组配合 20 条/24h 的巡检节拍，增量消化、不阻塞。
       */
      maxGroupsPerRun: z.number().min(1).max(50).default(4),
      /** 合并产物至少要合几条（2~10，默认 2 = 至少两条才值得合）。 */
      minGroup: z.number().min(2).max(10).default(2),
    }),
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
  /**
   * 批量提取（v0.20.0）：会话静置一段时间后，整段读取、分批提取、候选池整合后才入库。
   *
   * 目的：杜绝"每轮一提、提了就入库"造成的碎片（实测 749 条里 420 条写入后从未被检索）。
   * 开启后 turn/end 不再直接写 sm 层，改为把轮次累积起来等静置后批量处理。
   */
  batchExtract: z.object({
    enabled: z.boolean().default(false),
    /** 静置多少小时后触发（默认 12） */
    idleHours: z.number().min(1).max(168).default(12),
    /** 单段最多几轮（控制单次 LLM 输入长度） */
    segmentTurns: z.number().min(4).max(60).default(12),
    /** 归纳门槛：同桶至少来自几个不同会话才归纳 */
    minSessions: z.number().min(1).max(10).default(2),
    /** 每轮最多归纳几个桶 */
    maxBucketsPerRun: z.number().min(1).max(30).default(8),
    /** 扫描间隔（分钟）：多久检查一次有没有会话该提取了 */
    scanIntervalMin: z.number().min(1).max(240).default(30),
  }),
  /** 运行日志（阶段四 v0.9.5）：背后运行了什么完全透明可见 */
  logging: z.object({
    enabled: z.boolean().default(true),
    maxRows: z.number().min(100).max(10000).default(2000),  // 日志保留条数（惰性裁剪）
  }),
}))
