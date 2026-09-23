/**
 * dsh-memory 客户端：设置面板（侧边栏「记忆」导航项）。
 * 原 client/index.jsx 拆分（v0.10 解耦），注册到 settings.section 插槽。
 * 用 ctx.settingsScope 读写 settings.yaml 的 `memory` 命名空间，live 生效。
 */
import React, { useEffect, useMemo, useState } from 'react'

/** 命名空间快照容错：未注册/读取失败时返回空对象（供应商目录为空也不崩）。 */
const safeSnapshot = (scope) => {
  try { return scope.getSnapshot() } catch { return { value: {} } }
}
/** 注入节奏档位（v0.11.2）：[键, 标签, 生效步距, 说明]。
 *  ⚠ 数字与标签必须与 lib/config.js 的 INJECT_PACE_STEPS / INJECT_PACE_LABELS 同源——
 *  test-inject-pipeline.mjs 会读本文件比对，改一边忘另一边会被测试拦下。
 *  为什么做成档位：步距是"打扰频率"的直接体感，不该让用户先理解步数/RRF 语义再填数字。 */
const INJECT_PACE_OPTIONS = [
  ['aggressive', '激进', 4, '长任务里几乎每轮都有记忆跟上，适合探索/调试'],
  ['steady', '平稳', 12, '默认：长任务里有节奏地补充相关记忆'],
  ['lazy', '懒惰', 30, '几乎不打扰，只在长任务里偶尔回看一眼'],
  ['custom', '自定义', 0, '用下面的「步距节流」数字精确控制（1~60）'],
]

/** 表单字段定义：数值字段（顶层）。 */
const NUMBER_FIELDS = [
  ['injectMaxTokens', '注入最大 token/次', '每次自动注入的 token 预算'],
  ['stepInterval', '步距节流', '每 N 步做一次全量检索（1~60，默认 10；步距到必检——同 query 也重检，重复注入由内容 hash 去抖）'],
  ['injectMinScore', '注入最低相关分', 'RRF 融合量纲（三路全中 ~0.049、单路 rank1 ~0.016）；默认 0.02 ≈ 至少一路排前 10，低于该分数的记忆不注入'],
  ['maxRecentPerAgent', '防循环窗口（很最近注入）', '每个 agent 最近注入的记忆 id 窗口，窗口内不再重复注入（1~50，默认 6）'],
  ['maxVersionsPerMemory', '版本上限（世界线长度）', '每条记忆最多保留的版本数（需重启 DSH 生效）'],
]

/** 布尔开关字段（features 子对象）。 */
const FEATURE_FIELDS = [
  ['autoWrite', '自动写入', 'turn/end 自动沉淀记忆'],
  ['valueGate', '价值门', '过滤低价值噪音'],
  ['dedupMerge', '去重合并', '相似记忆更新而非新建'],
  ['preStepInject', '自动注入', 'pre-step 每步自动注入相关记忆'],
  ['manageTools', '管理工具集', '暴露 memory_* 工具给模型'],
  ['time', '时间维度', '更新追加版本（世界线），关闭则直接覆盖（需重启 DSH 生效）'],
  ['graph', '图谱构建', '实体节点 + 共现边'],
]

/** 提取模型字段（refiner 子对象）。 */
const REFINER_FIELDS = [
  ['enabled', '启用 LLM 提取', '用独立模型蒸馏记忆，替代原始文本入库'],
  ['provider', '供应商 Provider', '已配置的 provider 路由（下拉预设；自建端点可选自定义）'],
  ['model', '模型', '选定供应商的模型目录（下拉预设；可自定义 id）'],
  ['apiKeyEnv', '独立密钥槽引用', '仅当选中供应商未声明 apiKeyEnv 时生效（自建供应商场景），默认 MEMORY_REFINER_API_KEY'],
  ['reasoningEffort', '推理档位', 'low/medium/high = 明确思考档（推荐，提取质量优先）；off = 让上游用默认（思考型模型照样思考——off 不等于关思考）'],
  ['maxTokens', '输出上限（token）', '0 = 不限制（默认，由时间预算兜底）；只有需要硬性限长时才填正数'],
  ['timeBudgetMs', '单次时间预算（毫秒）', '到点掐断，把已写内容带回去续跑（默认 120000 = 2 分钟）'],
  ['maxContinuations', '续跑轮数上限', '掐断/空输出后最多再接着写几次（默认 3）'],
]

/** 嵌入模型字段（embedding 子对象，对应 settings schema）。 */
const EMBEDDING_FIELDS = [
  ['provider', '嵌入供应商', 'rule（离线哈希兜底，256 维）| remote（OpenAI 兼容 API，质量最高）| onnx（预留）'],
  ['model', '嵌入模型', 'remote 模型名，如 Qwen/Qwen3-VL-Embedding-8B（4096 维）'],
  ['baseUrl', 'API 端点', 'OpenAI 兼容 /v1/embeddings 端点，默认硅基流动'],
  ['apiKeyEnv', '密钥引用名', '凭据文件键名，默认 MEMORY_EMBEDDING_API_KEY'],
  ['cacheSize', '嵌入缓存条数', 'embed 结果 LRU 缓存（64~8192，默认 1024）'],
]

/** 重排模型字段（reranker 子对象）。 */
const RERANKER_FIELDS = [
  ['provider', '重排供应商', 'remote（/v1/rerank）| onnx（预留）'],
  ['model', '重排模型', '如 Qwen/Qwen3-VL-Reranker-8B'],
  ['baseUrl', 'API 端点', '留空 = 跟随嵌入端点'],
  ['apiKeyEnv', '密钥引用名', '凭据文件键名，默认 MEMORY_RERANK_API_KEY'],
  ['topK', '精排候选数', 'RRF 融合后取前 N 条重排（5~50，默认 20；需重启 DSH 生效）'],
  ['minCandidates', '最少候选', '候选不足不触发重排（2~20，默认 3；需重启 DSH 生效）'],
  ['rrfWeight', 'RRF 权重', '融合分 = w×RRF + (1-w)×重排分（0~1，默认 0.7；需重启 DSH 生效）'],
]

/** 图谱力导向字段（graphView 子对象）。 */
const GRAPH_VIEW_FIELDS = [
  ['spring', '弹簧强度', '连线牵引力（0.02~0.5，默认 0.13；越大团越紧）'],
  ['repulsion', '斥力倍率', '节点间斥力（0.2~2，默认 1；越大越松散）'],
  ['damping', '速度阻尼', '运动衰减（0.05~0.9，默认 0.3；越大越稳但更慢收敛）'],
  ['gravity', '中心引力', '孤立节点回中心拉力（0~0.05，默认 0.005）'],
]

/** 管家字段（housekeeping 子对象）。 */
const HOUSEKEEPING_FIELDS = [
  ['autoMergeThreshold', '近乎重复自动合并阈值', 'v0.12.1：≥此值直接合并（择优保留一条、其余归档）；0.92~此值之间留给 LLM 归并，避免丢信息'],
  ['archiveEpAfterDays', '情景快照归档天数', 'v0.12.1：ep 层闲置多少天后归档（0 = 不归档）；判据含「从未被检索命中」与「强度 < 1.5」，被用过的不动'],
  ['interval', '巡检间隔（沉淀条数）', '每沉淀 N 条记忆自动巡检一次（5~500，默认 20）'],
  ['maxIntervalHours', '时间兜底（小时）', '距上次巡检超 N 小时也触发（1~720，默认 24）'],
  ['dedupThreshold', '近重复阈值', '余弦相似度 ≥ 此值判为近重复（0.8~0.99，默认 0.92）'],
  ['agingDays', '老化报告天数', '闲置超 N 天的低价值记忆进报告（7~365，默认 30）'],
]

/** 事件分类字段（events 子对象，v0.9.0）。 */
const EVENTS_FIELDS = [
  ['gapHours', '归并窗口（小时）', '时间线扫描：相邻间隔 ≤ N 小时且同主题/共享实体的记忆归为同一事件（0.5~48，默认 2）'],
]

/** 运行日志字段（logging 子对象，v0.9.5）。 */
const LOGGING_FIELDS = [
  ['maxRows', '日志保留条数', '惰性裁剪上限（100~10000，默认 2000）'],
]

const NUMERIC_SUB = new Set(['cacheSize', 'topK', 'minCandidates', 'rrfWeight', 'spring', 'repulsion', 'damping', 'gravity', 'interval', 'maxIntervalHours', 'dedupThreshold', 'agingDays', 'gapHours', 'maxRows', 'maxTokens', 'timeBudgetMs', 'maxContinuations'])

/**
 * 宿主设计令牌（主题包注入 :root 的 --dsw-alias-*）。
 * 设置面板属于宿主界面的一部分：不硬编码色值、不自己铺背景层。
 * 此前用 #1a1a1a 卡片 + #444 边框画「分区」，在浅色主题下等于贴了几块黑砖，
 * 也和原生设置页（纯分隔线 + 原生控件）对不上——v0.11.1 起全部改走令牌。
 */
const T = {
  label: 'var(--dsw-alias-label-primary)',
  sub: 'var(--dsw-alias-label-tertiary)',
  dim: 'var(--dsw-alias-label-dimmed)',
  line: 'var(--dsw-alias-border-l2)',
  fieldBg: 'var(--dsw-alias-bg-layer-1)',
  brand: 'var(--dsw-alias-brand-primary)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
  ok: 'var(--dsw-alias-state-success-primary)',
  warnBg: 'var(--dsw-alias-state-warn-tertiary)',
  warnLine: 'var(--dsw-alias-state-warn-primary)',
  warnText: 'var(--dsw-alias-state-warn-label)',
  err: 'var(--dsw-alias-state-error-primary)',
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'block', margin: '10px 0' }}>
      <span style={{ display: 'block', fontWeight: 500, fontSize: 13, color: T.label }}>{label}</span>
      {hint ? <span style={{ display: 'block', color: T.sub, fontSize: 12, lineHeight: '18px', marginTop: 2 }}>{hint}</span> : null}
      {children}
    </label>
  )
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box', marginTop: 4, height: 32, padding: '0 10px',
  fontSize: 14, lineHeight: '22px', borderRadius: 8,
  border: `1px solid ${T.line}`, background: T.fieldBg, color: T.label, outline: 'none',
}

function CheckboxRow({ label, hint, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: 13, color: T.label, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
      {hint ? <span style={{ color: T.sub, fontSize: 12 }}>— {hint}</span> : null}
    </label>
  )
}

/** 密钥输入卡片：password 写凭据文件（~/.dsh/.credentials.yaml），绝不回显；keyRef 为凭据键名。
 *  ⚠️ 不能命名为 ref——React 保留属性，传字符串会抛 #290（设置页永久空白的根因，v0.9.30）。
 *  credentials API 走官方形态：describe([ref]) / set(ref, value)（v0.9.30 修正，此前对象形态从未生效）。 */
function KeyInput({ api, keyRef, hint }) {
  const [state, setState] = useState({ checking: false, configured: false, writing: false })
  const [draft, setDraft] = useState('')
  const check = async () => {
    setState((s) => ({ ...s, checking: true }))
    try {
      const r = await api.credentials.describe([keyRef])
      setState((s) => ({
        ...s,
        configured: Boolean(r?.ok && r.value?.[keyRef]?.configured),
        checking: false,
      }))
    } catch {
      setState((s) => ({ ...s, checking: false }))
    }
  }
  useEffect(() => { void check() }, [keyRef])
  const save = async () => {
    if (!draft) return
    setState((s) => ({ ...s, writing: true }))
    try {
      await api.credentials.set(keyRef, draft)
      setDraft('')
      await check()
    } catch (err) {
      console.warn('[dsh-memory-client] 密钥保存失败: ' + err.message)
    } finally {
      setState((s) => ({ ...s, writing: false }))
    }
  }
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.line}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.label }}>
        <span style={{ fontWeight: 500 }}>API 密钥</span>
        {state.checking
          ? <span style={{ color: T.sub, fontSize: 12 }}>检查中…</span>
          : state.configured
            ? <span style={{ color: T.ok, fontSize: 12 }}>● 已配置（{keyRef}）</span>
            : <span style={{ color: T.warnText, fontSize: 12 }}>○ 未配置（{keyRef}）</span>}
      </div>
      {hint ? <p style={{ color: T.sub, fontSize: 12, margin: '6px 0' }}>{hint}</p> : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ ...inputStyle, marginTop: 0, flex: 1 }}
          type="password"
          placeholder={`粘贴密钥到 ${keyRef}（留空不改）`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          onClick={save}
          disabled={!draft || state.writing}
          style={{ padding: '0 14px', height: 32, borderRadius: 8, border: `1px solid ${T.line}`, background: 'transparent', color: T.label, cursor: draft ? 'pointer' : 'default' }}
        >
          {state.writing ? '保存中…' : '保存密钥'}
        </button>
      </div>
    </div>
  )
}

/**
 * 自家 ErrorBoundary（v0.9.30，审查发现）：内核 SlotErrorBoundary 会把渲染期抛错的
 * settings.section entry 标记 abdicate 永久退休——「标签还在、点开内容永久空白」且整页
 * 不刷新不恢复。这里兜一层：任何渲染/effect 异常显示具体错误 + 可重试，而不是静默空白。
 */
class SettingsErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) {
    console.error('[dsh-memory-client] 设置面板渲染出错:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16 }}>
          <p style={{ color: T.warnText, fontWeight: 500, fontSize: 13 }}>⚠ 设置面板渲染出错</p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: T.err, background: T.fieldBg, padding: 8, borderRadius: 8, margin: '8px 0' }}>{String(this.state.error?.message ?? this.state.error)}</pre>
          <button onClick={() => this.setState({ error: null })}
            style={{ padding: '0 14px', height: 32, borderRadius: 8, border: `1px solid ${T.line}`, background: 'transparent', color: T.label, cursor: 'pointer' }}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * 自检结果（v0.11.1）：每路一行——配置成什么、凭据在不在、真实请求通不通。
 * 关键区分：「● 已配置」= 凭据文件里有这个键；「可用」= 刚刚真的发了一次请求且成功。
 */
function HealthReport({ data }) {
  const stateOf = (live) => (live == null ? 'skip' : live.ok ? 'ok' : 'fail')
  const dot = { ok: T.ok, fail: T.err, skip: T.dim }
  const tag = { ok: '可用', fail: '不可用', skip: '未检测' }

  const active = data.embedding.active ?? {}
  const rows = [
    {
      key: 'embedding',
      title: '嵌入',
      live: data.embedding.live,
      cfg: `${data.embedding.provider} · ${data.embedding.model} → ${data.embedding.endpoint}`,
      okText: `返回 ${data.embedding.live?.dim ?? '?'} 维 · ${data.embedding.live?.ms ?? '?'}ms`,
      tail: `向量路实况：${active.embedder ?? '?'} · ${active.dim ?? '?'} 维 · ${active.rows ?? 0} 条`
        + (active.degraded ? '（降级态：远端不可用，哈希兜底且向量路暂停）' : '')
        + (data.embedding.live?.ok && active.embedder === 'rule' ? '——远端现在通了，重启 DSH 后才会切回' : ''),
    },
    {
      key: 'reranker',
      title: '重排',
      live: data.reranker.enabled ? data.reranker.live : null,
      cfg: `${data.reranker.enabled ? '启用' : '未启用'} · ${data.reranker.model} → ${data.reranker.endpoint}`,
      okText: `打分 ${JSON.stringify(data.reranker.live?.scores ?? [])} · ${data.reranker.live?.ms ?? '?'}ms`,
      tail: `密钥引用 ${data.reranker.keyRef}：${data.reranker.keyConfigured ? '已配置' : '未配置'}`,
    },
    {
      key: 'refiner',
      title: '提取',
      live: data.refiner.enabled ? data.refiner.live : null,
      cfg: `${data.refiner.enabled ? '启用' : '未启用'} · ${data.refiner.provider} / ${data.refiner.model}`,
      okText: `回包 ${JSON.stringify(data.refiner.live?.text ?? '')} · ${data.refiner.live?.ms ?? '?'}ms`,
      tail: `密钥引用 ${data.refiner.keyRef}：${data.refiner.keyConfigured ? '已配置' : '未配置'}`,
    },
  ]

  return (
    <div style={{ marginTop: 12 }}>
      {rows.map((r) => {
        const st = stateOf(r.live)
        return (
          <div key={r.key} style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.line}` }}>
            <div style={{ fontSize: 13, color: T.label }}>
              <span style={{ color: dot[st] }}>●</span> {r.title}
              <span style={{ color: dot[st], fontSize: 12, marginLeft: 6 }}>{tag[st]}</span>
              <span style={{ color: T.sub, fontSize: 12, marginLeft: 8 }}>{r.cfg}</span>
            </div>
            {r.live?.ok ? <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>{r.okText}</div> : null}
            {r.live && !r.live.ok ? <div style={{ fontSize: 12, color: T.err, marginTop: 2 }}>{r.live.error}</div> : null}
            {r.tail ? <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>{r.tail}</div> : null}
          </div>
        )
      })}
      <div style={{ fontSize: 12, color: T.dim, marginTop: 8 }}>检测时间 {data.checkedAt}</div>
    </div>
  )
}

/** 设置面板主组件（侧边栏"记忆"导航项的完整设置菜单）。 */
export function MemorySettingsSection(props) {
  return <SettingsErrorBoundary><MemorySettingsSectionInner {...props} /></SettingsErrorBoundary>
}

function MemorySettingsSectionInner({ scope, api, llmScope, deepseekScope }) {
  const [snap, setSnap] = useState(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope])

  // 供应商配置目录（llm-pi-ai 命名空间）：每个供应商自己的密钥引用（apiKeyEnv）与端点
  const [llmSnap, setLlmSnap] = useState(() => safeSnapshot(llmScope))
  useEffect(() => llmScope.subscribe(() => setLlmSnap(safeSnapshot(llmScope))), [llmScope])
  // llm-deepseek 命名空间（deepseek-official 单路由）：EAC 5.3 起内核的官方 DeepSeek 适配器
  const [deepseekSnap, setDeepseekSnap] = useState(() => safeSnapshot(deepseekScope))
  useEffect(() => deepseekScope.subscribe(() => setDeepseekSnap(safeSnapshot(deepseekScope))), [deepseekScope])

  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  // 连通性自检状态（v0.11.1）：{ running, data, error }
  const [health, setHealth] = useState({ running: false, data: null, error: '' })

  /** 跑一次自检。失败只把错误写进面板，不抛（面板必须还能用）。 */
  const runHealth = async () => {
    setHealth((h) => ({ running: true, data: h.data, error: '' }))
    try {
      const res = await fetch('/dsh-memory/health?llm=1')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      setHealth({ running: false, data, error: '' })
    } catch (err) {
      setHealth({ running: false, data: null, error: String(err?.message ?? err) })
    }
  }

  // 供应商配置集：llm-pi-ai 的 providers 字典 + llm-deepseek 的 deepseek-official 单路由
  const value = snap.value ?? {}
  const providersCfg = (llmSnap?.value?.providers ?? {})
  const deepseekCfg = (deepseekSnap?.value ?? {})

  // 供应商/模型预设（EAC 5.3 适配：旧 api.llm.providers/models 端点已移除，
  // 改为从 llm-pi-ai + llm-deepseek 两个命名空间推导）
  const providers = useMemo(() => {
    const list = []
    if (deepseekCfg && typeof deepseekCfg === 'object') {
      list.push({
        provider: 'deepseek-official',
        displayName: 'DeepSeek 官方',
        apiKeyEnv: deepseekCfg.apiKeyEnv || 'DEEPSEEK_API_KEY',
        baseURL: deepseekCfg.baseURL || '',
        active: true,
      })
    }
    for (const [route, prof] of Object.entries(providersCfg ?? {})) {
      list.push({
        provider: route,
        displayName: prof?.displayName || route,
        apiKeyEnv: prof?.apiKeyEnv,
        baseURL: prof?.baseURL,
        active: true,
      })
    }
    return list
  }, [deepseekCfg, providersCfg])

  const modelGroups = useMemo(() => {
    const groups = []
    const dsModels = deepseekCfg?.models
    if (Array.isArray(dsModels) && dsModels.length > 0) groups.push({ id: 'deepseek-official', models: dsModels })
    for (const [route, prof] of Object.entries(providersCfg ?? {})) {
      if (Array.isArray(prof?.models) && prof.models.length > 0) groups.push({ id: route, models: prof.models })
    }
    return groups
  }, [deepseekCfg, providersCfg])

  // 独立密钥状态：只报告"已配置/未配置"，绝不含密钥本身
  const [keyState, setKeyState] = useState({ ref: '', configured: false, checking: false, writing: false })
  const [keyDraft, setKeyDraft] = useState('')

  const features = value.features ?? {}
  const refiner = value.refiner ?? {}
  const embedding = value.embedding ?? {}
  // 嵌入模型切换风险（v0.10.4）：改动不 live 生效，重启 DSH 时触发向量库维度迁移
  // （DROP 向量表 + 全量重嵌入；远程嵌入失败则进入降级态暂停向量路）。确认勾选才能保存。
  const embChanging = (drafts['embedding.provider'] !== undefined && drafts['embedding.provider'] !== (embedding.provider ?? 'remote'))
    || (drafts['embedding.model'] !== undefined && drafts['embedding.model'] !== (embedding.model ?? ''))
  const [embedAck, setEmbedAck] = useState(false)
  const reranker = value.reranker ?? {}
  const graphView = value.graphView ?? {}
  const housekeeping = value.housekeeping ?? {}
  const sessionSummary = value.sessionSummary ?? {}
  const events = value.events ?? {}
  const logging = value.logging ?? {}
  const writable = snap.writable ?? false
  const status = snap.status

  // 供应商/模型预设选择状态（先于密钥逻辑，keyRef 依赖 providerValue）
  const providerValue = drafts['refiner.provider'] ?? refiner.provider ?? ''
  const providerIsPreset = providers.some((p) => p.provider === providerValue)
  const providerModels = modelGroups.find((g) => g.id === providerValue)?.models ?? []
  const modelValue = drafts['refiner.model'] ?? refiner.model ?? ''
  const modelIsPreset = providerModels.some((m) => m.id === modelValue)

  // 选中供应商的完整画像（密钥引用跟随其 apiKeyEnv）
  const selectedProfile = providers.find((p) => p.provider === providerValue) ?? {}

  /** 密钥目标引用：跟随选中供应商自己的 apiKeyEnv；供应商未声明时回退 refiner.apiKeyEnv（独立槽）。 */
  const keyRef = () => {
    const declared = typeof selectedProfile?.apiKeyEnv === 'string' && selectedProfile.apiKeyEnv !== ''
    const d = drafts['refiner.apiKeyEnv']
    const fallback = (d !== undefined && d !== '' ? d : refiner.apiKeyEnv) || 'MEMORY_REFINER_API_KEY'
    return declared ? selectedProfile.apiKeyEnv : fallback
  }

  const checkKey = async () => {
    const ref = keyRef()
    setKeyState((s) => ({ ...s, ref, checking: true }))
    try {
      const response = await api.credentials.describe([ref])
      const configured = Boolean(response?.ok && response.value?.[ref]?.configured)
      setKeyState((s) => ({ ...s, configured, checking: false }))
    } catch {
      setKeyState((s) => ({ ...s, checking: false }))
    }
  }
  useEffect(() => { void checkKey() }, [drafts['refiner.apiKeyEnv'], refiner.apiKeyEnv, providerValue, llmSnap, deepseekSnap])

  const saveKey = async () => {
    if (!keyDraft) return
    const ref = keyRef()
    setKeyState((s) => ({ ...s, writing: true }))
    try {
      await api.credentials.set(ref, keyDraft)
      setKeyDraft('')
      setMsg(`✅ 密钥已保存到凭据文件（${ref}，不回显不落 settings）`)
      await checkKey()
    } catch (err) {
      setMsg(`❌ 密钥保存失败: ${err.message}`)
    } finally {
      setKeyState((s) => ({ ...s, writing: false }))
    }
  }

  const num = (field) => {
    const raw = drafts[field]
    if (raw !== undefined) return raw
    return value[field] !== undefined ? String(value[field]) : ''
  }
  const bool = (group, field, base) => {
    const key = `${group}.${field}`
    if (drafts[key] !== undefined) return drafts[key]
    return base[field] ?? false
  }
  /** 注入节奏（v0.11.2）：档位值 / 该档生效步距（custom 时为 0，表示以数字为准）/ 档位标签。 */
  const paceValue = drafts['injectPace'] ?? value.injectPace ?? 'steady'
  const paceOption = INJECT_PACE_OPTIONS.find(([k]) => k === paceValue) ?? INJECT_PACE_OPTIONS[1]
  const paceSteps = paceOption[2]
  const paceLabel = paceOption[1]

  const setNum = (field, text) => setDrafts((d) => ({ ...d, [field]: text }))
  const setBool = (group, field, v) => setDrafts((d) => ({ ...d, [`${group}.${field}`]: v }))
  const setText = (group, field, text) => setDrafts((d) => ({ ...d, [`${group}.${field}`]: text }))

  const dirty = Object.keys(drafts).length > 0
  // 数值字段（顶层数值声明 + 子对象中 NUMERIC_SUB 声明项）填了非数字 → 禁止保存；
  // 顶层文本字段（dbFile/scope/injectPace 等，TEXT_TOP 声明）不参与数值校验
  const TEXT_TOP = new Set(['dbFile', 'scope', 'injectPace'])
  const invalid = Object.entries(drafts).some(([k, v]) => {
    if (v === '' || TEXT_TOP.has(k)) return false
    const field = k.includes('.') ? k.split('.')[1] : k
    const isNumeric = !k.includes('.') || NUMERIC_SUB.has(field)
    return isNumeric && Number.isNaN(Number(v))
  })

  const save = async () => {
    setSaving(true)
    setMsg('')
    try {
      // 顶层数值字段
      for (const [field] of NUMBER_FIELDS) {
        const raw = drafts[field]
        if (raw === undefined) continue
        if (raw === '') await scope.unset(field)
        else await scope.set(field, Number(raw))
      }
      if (drafts['enabled'] !== undefined) await scope.set('enabled', drafts['enabled'])
      if (drafts['dbFile'] !== undefined) {
        if (drafts['dbFile'] === '') await scope.unset('dbFile')
        else await scope.set('dbFile', drafts['dbFile'])
      }
      if (drafts['scope'] !== undefined) {
        if (drafts['scope'] === '') await scope.unset('scope')
        else await scope.set('scope', drafts['scope'])
      }
      // 注入节奏档位（v0.11.2）：字符串枚举，live 生效
      if (drafts['injectPace'] !== undefined) await scope.set('injectPace', drafts['injectPace'])
      // features 整体
      const featKeys = FEATURE_FIELDS.map(([f]) => f)
      if (featKeys.some((f) => drafts[`features.${f}`] !== undefined)) {
        const next = { ...features }
        for (const [f] of FEATURE_FIELDS) {
          const v = drafts[`features.${f}`]
          if (v !== undefined) next[f] = v
        }
        await scope.set('features', next)
      }
      {/* refiner 整体 */}
      const refKeys = REFINER_FIELDS.map(([f]) => f)
      if (refKeys.some((f) => drafts[`refiner.${f}`] !== undefined)) {
        const next = { ...refiner }
        for (const [f] of REFINER_FIELDS) {
          const v = drafts[`refiner.${f}`]
          if (v !== undefined) {
            next[f] = f === 'enabled' ? v : NUMERIC_SUB.has(f) ? Number(v) : String(v)
          }
        }
        await scope.set('refiner', next)
      }
      {/* embedding 整体 */}
      const embKeys = EMBEDDING_FIELDS.map(([f]) => f)
      if (embKeys.some((f) => drafts[`embedding.${f}`] !== undefined)) {
        const next = { ...embedding }
        for (const [f] of EMBEDDING_FIELDS) {
          const v = drafts[`embedding.${f}`]
          if (v !== undefined) next[f] = NUMERIC_SUB.has(f) ? Number(v) : String(v)
        }
        await scope.set('embedding', next)
      }
      {/* reranker 整体 */}
      const rkKeys = RERANKER_FIELDS.map(([f]) => f)
      if (rkKeys.some((f) => drafts[`reranker.${f}`] !== undefined) || drafts['reranker.enabled'] !== undefined) {
        const next = { ...reranker }
        for (const [f] of RERANKER_FIELDS) {
          const v = drafts[`reranker.${f}`]
          if (v !== undefined) next[f] = NUMERIC_SUB.has(f) ? Number(v) : String(v)
        }
        if (drafts['reranker.enabled'] !== undefined) next.enabled = drafts['reranker.enabled']
        await scope.set('reranker', next)
      }
      {/* graphView 整体 */}
      const gvKeys = GRAPH_VIEW_FIELDS.map(([f]) => f)
      if (gvKeys.some((f) => drafts[`graphView.${f}`] !== undefined) || drafts['graphView.themeShape'] !== undefined || drafts['graphView.themeScope'] !== undefined) {
        const next = { ...graphView }
        for (const [f] of GRAPH_VIEW_FIELDS) {
          const v = drafts[`graphView.${f}`]
          if (v !== undefined) next[f] = Number(v)
        }
        // themeShape/themeScope 是字符串枚举（hull|circle / focus|always|off）——不走 NUMERIC_SUB 的 Number 分支
        if (drafts['graphView.themeShape'] !== undefined) next.themeShape = String(drafts['graphView.themeShape'])
        if (drafts['graphView.themeScope'] !== undefined) next.themeScope = String(drafts['graphView.themeScope'])
        await scope.set('graphView', next)
      }
      {/* housekeeping 整体 */}
      const hkKeys = HOUSEKEEPING_FIELDS.map(([f]) => f)
      if (hkKeys.some((f) => drafts[`housekeeping.${f}`] !== undefined) || drafts['housekeeping.enabled'] !== undefined) {
        const next = { ...housekeeping }
        for (const [f] of HOUSEKEEPING_FIELDS) {
          const v = drafts[`housekeeping.${f}`]
          if (v !== undefined) next[f] = Number(v)
        }
        if (drafts['housekeeping.enabled'] !== undefined) next.enabled = drafts['housekeeping.enabled']
        if (drafts['housekeeping.autoApply'] !== undefined) next.autoApply = drafts['housekeeping.autoApply']
        await scope.set('housekeeping', next)
      }
      {/* sessionSummary 整体（v0.12.2 会话级汇总） */}
      if (drafts['sessionSummary.enabled'] !== undefined || drafts['sessionSummary.rounds'] !== undefined) {
        const next = { ...(sessionSummary ?? {}) }
        if (drafts['sessionSummary.enabled'] !== undefined) next.enabled = drafts['sessionSummary.enabled']
        if (drafts['sessionSummary.rounds'] !== undefined) next.rounds = Number(drafts['sessionSummary.rounds'])
        await scope.set('sessionSummary', next)
      }
      {/* events 整体（v0.9.0 事件分类） */}
      const evKeys = EVENTS_FIELDS.map(([f]) => f)
      if (evKeys.some((f) => drafts[`events.${f}`] !== undefined) || drafts['events.enabled'] !== undefined) {
        const next = { ...events }
        for (const [f] of EVENTS_FIELDS) {
          const v = drafts[`events.${f}`]
          if (v !== undefined) next[f] = Number(v)
        }
        if (drafts['events.enabled'] !== undefined) next.enabled = drafts['events.enabled']
        await scope.set('events', next)
      }
      {/* logging 整体（v0.9.5 运行日志） */}
      const lgKeys = LOGGING_FIELDS.map(([f]) => f)
      if (lgKeys.some((f) => drafts[`logging.${f}`] !== undefined) || drafts['logging.enabled'] !== undefined) {
        const next = { ...logging }
        for (const [f] of LOGGING_FIELDS) {
          const v = drafts[`logging.${f}`]
          if (v !== undefined) next[f] = Number(v)
        }
        if (drafts['logging.enabled'] !== undefined) next.enabled = drafts['logging.enabled']
        await scope.set('logging', next)
      }
      setDrafts({})
      setEmbedAck(false)
      setMsg('✅ 已保存' + (embChanging ? '；嵌入模型改动需重启 DSH 生效' : '') + '；其余标注「需重启」的字段重启后生效，未标注的即时生效（live）')
    } catch (err) {
      setMsg(`❌ 保存失败: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setDrafts({})
    setEmbedAck(false)
    setMsg('')
  }

  if (status !== 'ready') {
    return (
      <div style={{ padding: 16, maxWidth: 680, boxSizing: 'border-box' }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16, color: T.label }}>记忆</h3>
        <p style={{ color: T.sub, fontSize: 13 }}>
          记忆插件设置{status === 'loading' ? '加载中…' : '不可用（host 未注册 memory 命名空间）'}
        </p>
      </div>
    )
  }

  // 分区：原生设置页是「标题 + 分隔线」，不是卡片。marginTop/paddingTop 造出节奏，
  // border-top 与宿主的分隔线同色同粗——不再自铺背景层（v0.11.1）。
  const blockStyle = { marginTop: 22, paddingTop: 16, borderTop: `1px solid ${T.line}` }
  const blockTitle = { margin: '0 0 4px', fontWeight: 600, fontSize: 14, color: T.label }
  const ghostBtn = {
    padding: '0 16px', height: 32, borderRadius: 8, border: `1px solid ${T.line}`,
    background: 'transparent', color: T.label,
  }
  const primaryBtn = {
    padding: '0 16px', height: 32, borderRadius: 8, border: '1px solid transparent',
    background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)',
  }

  return (
    <div style={{ padding: 16, maxWidth: 680, boxSizing: 'border-box' }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, color: T.label }}>记忆</h3>
      <p style={{ margin: '0 0 12px', color: T.sub, fontSize: 13 }}>
        dsh-memory 自动记忆插件——多数改动即时生效（live），写入 settings.yaml 的 memory 段；
        标注「需重启」的字段要重启 DSH 才生效。
      </p>

      {/* 连通性自检（v0.11.1）：「● 已配置」只证明凭据文件里有这个键，不证明服务能用。
          真事故：硅基流动余额 402 → 嵌入静默降级到 rule 哈希、重排每次白等，界面上一切正常。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={() => void runHealth()} disabled={health.running} style={ghostBtn}>
          {health.running ? '检测中…' : '连通性自检'}
        </button>
        <span style={{ color: T.sub, fontSize: 12 }}>
          对嵌入 / 重排 / 提取各发一次真实最小请求（提取探针会产生一次极小的 LLM 调用）
        </span>
      </div>
      {health.error ? <p style={{ color: T.err, fontSize: 12, margin: '8px 0 0' }}>自检请求失败：{health.error}</p> : null}
      {health.data ? <HealthReport data={health.data} /> : null}

      <div style={blockStyle}>
        <div style={blockTitle}>基础配置</div>
        <CheckboxRow
          label="启用插件"
          hint="总开关；关闭后插件不初始化（改动需重启 DSH 生效，不是 live）"
          checked={drafts['enabled'] ?? Boolean(value.enabled ?? true)}
          onChange={(e) => setDrafts((d) => ({ ...d, enabled: e.target.checked }))}
        />
        <Field label="数据库文件（dbFile）" hint="留空默认 ~/.dsh/memory.db；改动需重启生效">
          <input
            style={inputStyle}
            type="text"
            value={drafts['dbFile'] ?? value.dbFile ?? ''}
            disabled={!writable}
            onChange={(e) => setDrafts((d) => ({ ...d, dbFile: e.target.value }))}
          />
        </Field>
        <Field label="默认作用域（scope）" hint="跨会话默认收窄到当前工作目录名；留空自动按工作区（v0.9.4 分层）">
          <input
            style={inputStyle}
            type="text"
            value={drafts['scope'] ?? value.scope ?? ''}
            disabled={!writable}
            onChange={(e) => setDrafts((d) => ({ ...d, scope: e.target.value }))}
          />
        </Field>
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>检索与注入</div>
        <p style={{ color: T.sub, fontSize: 12, margin: '0 0 10px 0' }}>
          v0.10 注入加权：画像 ×3 · principle（方法/原则）×1.5 优先 · event（事件/产出）×0.7 降权（强相关才注入）；
          蒸馏输出自动打 theme 名词标签（仅新记忆）。
        </p>
        {/* 注入节奏档位（v0.11.2）：三档 + 自定义。生效步距由 lib/config.js 的
            resolveStepInterval 解析（custom 才读 stepInterval），这里只做选择与展示。 */}
        <Field
          label="注入节奏"
          hint={paceSteps
            ? `当前生效：每 ${paceSteps} 步重新检索一次并把相关记忆注入（步距到必检；内容没变则不重复注入）`
            : '自定义档：按下面的「步距节流」数字执行，取值 1~60'}
        >
          <select
            style={inputStyle}
            value={paceValue}
            disabled={!writable}
            onChange={(e) => setDrafts((d) => ({ ...d, injectPace: e.target.value }))}
          >
            {INJECT_PACE_OPTIONS.map(([key, label, steps, desc]) => (
              <option key={key} value={key}>{steps ? `${label}（每 ${steps} 步）` : label} — {desc}</option>
            ))}
          </select>
        </Field>
        {NUMBER_FIELDS.map(([field, label, hint]) => (
          <Field
            key={field}
            label={label}
            hint={field === 'stepInterval' && paceSteps
              ? `当前「注入节奏」选的是${paceLabel}档（每 ${paceSteps} 步），此数字暂不生效——切到「自定义」档才用它`
              : hint}
          >
            <input
              style={inputStyle}
              type="text"
              value={num(field)}
              disabled={!writable}
              onChange={(e) => setNum(field, e.target.value)}
            />
          </Field>
        ))}
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>功能开关</div>
        {FEATURE_FIELDS.map(([field, label, hint]) => (
          <CheckboxRow
            key={field}
            label={label}
            hint={hint}
            checked={bool('features', field, features)}
            onChange={(e) => setBool('features', field, e.target.checked)}
          />
        ))}
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>独立提取模型（refiner）</div>
        <CheckboxRow
          label="启用 LLM 提取"
          hint="用独立模型蒸馏记忆，替代原始文本入库"
          checked={bool('refiner', 'enabled', refiner)}
          onChange={(e) => setBool('refiner', 'enabled', e.target.checked)}
        />
      <Field label="供应商 Provider" hint="从已配置的供应商预设中选择（自建端点选自定义）">
        <select
          style={inputStyle}
          value={providerIsPreset ? providerValue : '__custom__'}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'provider', e.target.value === '__custom__' ? '' : e.target.value)}
        >
          <option value="">— 未选择 —</option>
          {providers.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.displayName || p.provider}（{p.provider}）{p.active ? '' : ' · 未启用'}
            </option>
          ))}
          <option value="__custom__">自定义…</option>
        </select>
        {!providerIsPreset && (
          <input
            style={{ ...inputStyle, marginTop: 6 }}
            type="text"
            placeholder="自定义供应商路由名"
            value={providerValue}
            disabled={!writable}
            onChange={(e) => setText('refiner', 'provider', e.target.value)}
          />
        )}
      </Field>
      <Field
        label="模型"
        hint={providerModels.length > 0
          ? `"${providerValue}" 的模型目录（${providerModels.length} 个）`
          : '选择供应商后显示其模型目录（自定义模型 id 可选"自定义"）'}
      >
        <select
          style={inputStyle}
          value={modelIsPreset ? modelValue : '__custom__'}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'model', e.target.value === '__custom__' ? '' : e.target.value)}
        >
          <option value="">— 未选择 —</option>
          {providerModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id}
            </option>
          ))}
          <option value="__custom__">自定义…</option>
        </select>
        {!modelIsPreset && (
          <input
            style={{ ...inputStyle, marginTop: 6 }}
            type="text"
            placeholder="自定义模型 id"
            value={modelValue}
            disabled={!writable}
            onChange={(e) => setText('refiner', 'model', e.target.value)}
          />
        )}
      </Field>
      <Field label="密钥引用名（apiKeyEnv）" hint="凭据文件键名，自建供应商时与模型设置的 apiKeyEnv 一致">
        <input
          style={inputStyle}
          type="text"
          value={drafts['refiner.apiKeyEnv'] ?? refiner.apiKeyEnv ?? 'MEMORY_REFINER_API_KEY'}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'apiKeyEnv', e.target.value)}
        />
      </Field>
      <Field label="推理档位（reasoningEffort）" hint="low/medium/high = 明确思考档（默认 low：先判断再写）。注意 off 不等于关思考——适配器把 off 当「不传参数」，思考型模型（如 deepseek-v4.1-flash）照样思考；仅适配器声明 supportsReasoningEffort 时透传">
        <input
          style={inputStyle}
          type="text"
          value={drafts['refiner.reasoningEffort'] ?? refiner.reasoningEffort ?? 'low'}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'reasoningEffort', e.target.value)}
        />
      </Field>
      <Field label="输出上限（maxTokens）" hint="0 = 不限制（默认）。不设上限时思考想多久都行，约束只剩时间预算；填正数才会透传给模型">
        <input
          style={inputStyle}
          type="text"
          value={drafts['refiner.maxTokens'] ?? String(refiner.maxTokens ?? 0)}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'maxTokens', e.target.value)}
        />
      </Field>
      <Field label="单次时间预算（timeBudgetMs）" hint="毫秒，默认 120000（2 分钟）。到点主动掐断，把已经写出来的内容原样带回去续跑（断点续思）——「预算不够」不会再导致整条记忆丢失；0 = 不限时">
        <input
          style={inputStyle}
          type="text"
          value={drafts['refiner.timeBudgetMs'] ?? String(refiner.timeBudgetMs ?? 120000)}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'timeBudgetMs', e.target.value)}
        />
      </Field>
      <Field label="续跑轮数上限（maxContinuations）" hint="被掐断/截断/空输出后最多再接着写几次（默认 3，0 = 不续跑）。续跑时一个字都没写出来会自动停止，不空烧配额">
        <input
          style={inputStyle}
          type="text"
          value={drafts['refiner.maxContinuations'] ?? String(refiner.maxContinuations ?? 3)}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'maxContinuations', e.target.value)}
        />
      </Field>

      {/* 独立密钥：password 输入，写凭据文件，绝不回显；目标引用自动跟随选中供应商 */}
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.line}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <span style={{ fontWeight: 500 }}>API 密钥</span>
          {keyState.checking
            ? <span style={{ color: T.sub, fontSize: 12 }}>检查中…</span>
            : keyState.configured
              ? <span style={{ color: T.ok, fontSize: 12 }}>● 已配置（{keyState.ref}）</span>
              : <span style={{ color: T.warnText, fontSize: 12 }}>○ 未配置（{keyState.ref}）</span>}
        </div>
        <p style={{ color: T.sub, fontSize: 12, margin: '6px 0' }}>
          {selectedProfile?.apiKeyEnv
            ? <>密钥引用<b>自动跟随供应商</b>：{providerValue} → <code>{selectedProfile.apiKeyEnv}</code>（host 调用时按此引用解析）</>
            : <>该供应商未声明密钥引用，使用独立密钥槽 <code>{keyRef()}</code>（自建端点场景）</>}
          {' '}密钥仅写入 <code>~/.dsh/.credentials.yaml</code>（私有文件），不进入设置文档、不进入记忆库、不在界面回显。
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...inputStyle, marginTop: 0, flex: 1 }}
            type="password"
            placeholder={`粘贴密钥到 ${keyRef()}（留空不改）`}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <button
            onClick={saveKey}
            disabled={!keyDraft || keyState.writing}
            style={{ ...ghostBtn, cursor: keyDraft ? 'pointer' : 'default' }}
          >
            {keyState.writing ? '保存中…' : '保存密钥'}
          </button>
        </div>
        <p style={{ color: T.sub, fontSize: 12, margin: '6px 0 0' }}>
          换供应商后此处自动切换到新供应商的密钥引用（已配置则显示 ●）；自建独立供应商：在「设置 → 模型」添加 provider（npm: <code>@ai-sdk/openai-compatible</code>），apiKeyEnv 填 <code>MEMORY_REFINER_API_KEY</code>，baseURL 填你的端点。
        </p>
      </div>
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>嵌入与重排模型</div>
        <p style={{ margin: '0 0 4px', color: T.sub, fontSize: 12 }}>
          嵌入决定向量路质量（remote 失败自动降级 rule 哈希，永久兜底）；重排对 RRF 候选精排（失败降级 RRF 顺序，零损失）。本区全部字段在插件初始化时读取：改动需重启 DSH 生效。
        </p>

        <div style={{ fontWeight: 500, fontSize: 13, marginTop: 10 }}>嵌入（embedding）</div>
        {EMBEDDING_FIELDS.map(([field, label, hint]) =>
          field === 'provider' ? (
            <Field key={field} label={label} hint={hint}>
              <select
                style={inputStyle}
                value={drafts['embedding.provider'] ?? embedding.provider ?? 'remote'}
                disabled={!writable}
                onChange={(e) => setText('embedding', 'provider', e.target.value)}
              >
                <option value="remote">remote（OpenAI 兼容 API，推荐）</option>
                <option value="rule">rule（离线哈希兜底，256 维）</option>
                <option value="onnx">onnx（本地推理，预留）</option>
              </select>
            </Field>
          ) : (
            <Field key={field} label={label} hint={hint}>
              <input
                style={inputStyle}
                type="text"
                value={drafts[`embedding.${field}`] ?? embedding[field] ?? ''}
                disabled={!writable}
                onChange={(e) => setText('embedding', field, e.target.value)}
              />
            </Field>
          ),
        )}
        <KeyInput
          api={api}
          keyRef={drafts['embedding.apiKeyEnv'] ?? embedding.apiKeyEnv ?? 'MEMORY_EMBEDDING_API_KEY'}
          hint="硅基流动控制台创建密钥；写入 ~/.dsh/.credentials.yaml（私有文件），不进设置/记忆库、界面不回显。"
        />

        {embChanging && (
          <div style={{ marginTop: 10, padding: 10, border: `1px solid ${T.warnLine}`, borderRadius: 8, background: T.warnBg }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.warnText }}>⚠ 切换嵌入模型会触发向量库重建</div>
            <p style={{ color: T.warnText, fontSize: 12, margin: '6px 0' }}>
              嵌入供应商/模型的改动<b>不会立即生效</b>——DSH 下次启动时才按新配置重建：
              若向量维度变化，会<b>清空向量表并全量重嵌入</b>（期间语义检索暂弱，FTS/关键词照常）；
              若远程嵌入初始化失败，会进入<b>降级态暂停向量路</b>（v0.9.31 保护，不破坏现有向量）。
            </p>
            <CheckboxRow
              label="我已了解：切换嵌入模型需重启 DSH 并可能全量重建向量库"
              hint="勾选后才能保存本页改动"
              checked={embedAck}
              onChange={(e) => setEmbedAck(e.target.checked)}
            />
          </div>
        )}

        <div style={{ fontWeight: 500, fontSize: 13, marginTop: 14 }}>重排（reranker）</div>
        <CheckboxRow
          label="启用重排"
          hint="RRF 融合后对候选精排（需已配置重排密钥；需重启 DSH 生效）"
          checked={bool('reranker', 'enabled', reranker)}
          onChange={(e) => setBool('reranker', 'enabled', e.target.checked)}
        />
        {RERANKER_FIELDS.filter(([f]) => f !== 'enabled').map(([field, label, hint]) =>
          field === 'provider' ? (
            <Field key={field} label={label} hint={hint}>
              <select
                style={inputStyle}
                value={drafts['reranker.provider'] ?? reranker.provider ?? 'remote'}
                disabled={!writable}
                onChange={(e) => setText('reranker', 'provider', e.target.value)}
              >
                <option value="remote">remote（/v1/rerank）</option>
                <option value="onnx">onnx（本地，预留）</option>
              </select>
            </Field>
          ) : (
            <Field key={field} label={label} hint={hint}>
              <input
                style={inputStyle}
                type="text"
                value={drafts[`reranker.${field}`] ?? reranker[field] ?? ''}
                disabled={!writable}
                onChange={(e) => setText('reranker', field, e.target.value)}
              />
            </Field>
          ),
        )}
        <KeyInput
          api={api}
          keyRef={drafts['reranker.apiKeyEnv'] ?? reranker.apiKeyEnv ?? 'MEMORY_RERANK_API_KEY'}
          hint="与嵌入可共用同一密钥；写入凭据文件，不进设置/记忆库、界面不回显。"
        />
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>记忆图谱（力导向手感）</div>
        <p style={{ margin: '0 0 4px', color: T.sub, fontSize: 12 }}>
          打开「记忆图谱」面板时读取；改动后重开面板生效。
        </p>
        <Field label="主题圈显示" hint="聚焦时=只在悬停/选中节点时显示它所属主题的完整范围（默认，零干扰）| 常显=为每个主题的密集团画圈（滤掉稀疏末端，最多 8 片）| 关闭=不画">
          <select
            style={inputStyle}
            value={drafts['graphView.themeScope'] ?? graphView.themeScope ?? 'focus'}
            disabled={!writable}
            onChange={(e) => setText('graphView', 'themeScope', e.target.value)}
          >
            <option value="focus">聚焦时显示（推荐）</option>
            <option value="always">常显（密集团）</option>
            <option value="off">关闭</option>
          </select>
        </Field>
        <Field label="主题圈形状" hint="圆形=最小外接圆（推荐：轮廓连续平滑，不会随节点微动抖动）| 凸包=更贴合组形（顶点已钉住，比裸凸包稳定得多）">
          <select
            style={inputStyle}
            value={drafts['graphView.themeShape'] ?? graphView.themeShape ?? 'circle'}
            disabled={!writable}
            onChange={(e) => setText('graphView', 'themeShape', e.target.value)}
          >
            <option value="circle">圆形（推荐，轮廓稳定）</option>
            <option value="hull">贴合凸包（更紧，略欠平滑）</option>
          </select>
        </Field>
        {GRAPH_VIEW_FIELDS.map(([field, label, hint]) => (
          <Field key={field} label={label} hint={hint}>
            <input
              style={inputStyle}
              type="text"
              value={drafts[`graphView.${field}`] ?? graphView[field] ?? ''}
              disabled={!writable}
              onChange={(e) => setText('graphView', field, e.target.value)}
            />
          </Field>
        ))}
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>记忆管家（自动巡检）</div>
        <p style={{ margin: '0 0 4px', color: T.sub, fontSize: 12 }}>
          v0.12.1 起是真治理：近乎重复择优保留一条、其余归档，陈旧情景快照归档（只归档不删除，可用 memory_archive 恢复）。
          触发与对话轮数解耦：每沉淀 N 条记忆 或 距上次巡检超 N 小时。
        </p>
        <CheckboxRow
          label="启用自动巡检"
          hint="沉淀记忆时低频检查"
          checked={bool('housekeeping', 'enabled', housekeeping)}
          onChange={(e) => setBool('housekeeping', 'enabled', e.target.checked)}
        />
        <CheckboxRow
          label="自动执行治理（推荐）"
          hint="开启后巡检真动手：近乎重复合并、陈旧情景快照归档。只归档不删除，memory_archive 可查看与恢复；关闭则退回只报告"
          checked={bool('housekeeping', 'autoApply', { ...housekeeping, autoApply: housekeeping.autoApply ?? true })}
          onChange={(e) => setBool('housekeeping', 'autoApply', e.target.checked)}
        />
        {HOUSEKEEPING_FIELDS.map(([field, label, hint]) => (
          <Field key={field} label={label} hint={hint}>
            <input
              style={inputStyle}
              type="text"
              value={drafts[`housekeeping.${field}`] ?? housekeeping[field] ?? ''}
              disabled={!writable}
              onChange={(e) => setText('housekeeping', field, e.target.value)}
            />
          </Field>
        ))}
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>会话级汇总（v0.12.2）</div>
        <p style={{ margin: '0 0 4px', color: T.sub, fontSize: 12 }}>
          逐轮提取记的是"这一轮发生了什么"；这一层攒够轮次后总结一次"整段会话最后落在哪里"——一晚上的讨论定了什么、改成了什么、否掉了什么。
        </p>
        <CheckboxRow
          label="启用会话汇总"
          hint="累积到设定轮数后，把这段对话交回模型做一次结论汇总（与逐轮提取互补，不是替代）"
          checked={bool('sessionSummary', 'enabled', { ...sessionSummary, enabled: sessionSummary.enabled ?? true })}
          onChange={(e) => setBool('sessionSummary', 'enabled', e.target.checked)}
        />
        <Field label="汇总轮数（rounds）" hint="累积多少轮对话后做一次汇总（5~100，默认 12）">
          <input
            style={inputStyle}
            type="text"
            value={drafts['sessionSummary.rounds'] ?? sessionSummary?.rounds ?? 12}
            disabled={!writable}
            onChange={(e) => setText('sessionSummary', 'rounds', e.target.value)}
          />
        </Field>
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>事件分类（v0.9.0）</div>
        <p style={{ margin: '0 0 4px', color: T.sub, fontSize: 12 }}>
          时间连续 + 因果相关的记忆聚簇——"这段记忆属于哪件事"（区别于 theme 的"在讲什么"）；纯 rule 时间线扫描，管家/启动自动维护。
        </p>
        <CheckboxRow
          label="启用事件分类"
          hint="按时间线与主题/实体相似度把记忆归为事件（图谱可筛选）"
          checked={bool('events', 'enabled', events)}
          onChange={(e) => setBool('events', 'enabled', e.target.checked)}
        />
        {EVENTS_FIELDS.map(([field, label, hint]) => (
          <Field key={field} label={label} hint={hint}>
            <input
              style={inputStyle}
              type="text"
              value={drafts[`events.${field}`] ?? String(events[field] ?? 2)}
              disabled={!writable}
              onChange={(e) => setText('events', field, e.target.value)}
            />
          </Field>
        ))}
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>运行日志（v0.9.5）</div>
        <p style={{ margin: '0 0 4px', color: T.sub, fontSize: 12 }}>
          背后运行了什么完全透明可见：写入/注入/检索/巡检/蒸馏/错误全链路埋点；GUI「记忆日志」面板 + memory_logs 工具。
        </p>
        <CheckboxRow
          label="启用运行日志"
          hint="记录插件内部事件（诊断与审计用）"
          checked={bool('logging', 'enabled', logging)}
          onChange={(e) => setBool('logging', 'enabled', e.target.checked)}
        />
        {LOGGING_FIELDS.map(([field, label, hint]) => (
          <Field key={field} label={label} hint={hint}>
            <input
              style={inputStyle}
              type="text"
              value={drafts[`logging.${field}`] ?? String(logging[field] ?? 2000)}
              disabled={!writable}
              onChange={(e) => setText('logging', field, e.target.value)}
            />
          </Field>
        ))}
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={!dirty || invalid || saving || !writable || (embChanging && !embedAck)}
          style={{ ...primaryBtn, cursor: dirty ? 'pointer' : 'default' }}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button onClick={reset} disabled={!dirty}
          style={{ ...ghostBtn, cursor: dirty ? 'pointer' : 'default' }}>
          重置
        </button>
      </div>
      {invalid ? <p style={{ color: T.warnText, fontSize: 12, margin: '6px 0 0' }}>⚠ 数值字段必须填数字</p> : null}
      {msg ? <p style={{ fontSize: 12, margin: '6px 0 0' }}>{msg}</p> : null}
    </div>
  )
}

