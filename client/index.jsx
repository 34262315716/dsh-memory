/**
 * dsh-memory 客户端设置面板（浏览器端）。
 *
 * 注册到设置页侧边栏导航（`settings.section` 插槽，与"通用设置/模型/插件"同级）：
 * 点击"记忆"打开完整设置菜单。用 ctx.settingsScope 读写 settings.yaml 的
 * `memory` 命名空间，与 host 端插件（ctx.settings.register）读写同一文档，改动 live 生效。
 *
 * 构建：esbuild 打包为 __ModuleLoader__.load({id, factory}) 格式（见 lib/client.js）。
 */

import { useEffect, useMemo, useRef, useState, memo, useCallback } from 'react'

export const name = 'dsh-memory-client'
export const inject = ['slots', 'settingsScope', 'connection', 'remote']

/** 表单字段定义：数值字段（顶层）。 */
const NUMBER_FIELDS = [
  ['injectMaxTokens', '注入最大 token/次', '每次自动注入的 token 预算'],
  ['stepInterval', '步距节流', '每 N 步做一次全量检索'],
  ['injectMinScore', '注入最低相关分', 'RRF 融合量纲（三路全中 ~0.049）；默认 0.015 ≈ 至少一路排前 13，低于该分数的记忆不注入'],
  ['maxVersionsPerMemory', '版本上限（世界线长度）', '每条记忆最多保留的版本数'],
]

/** 布尔开关字段（features 子对象）。 */
const FEATURE_FIELDS = [
  ['autoWrite', '自动写入', 'turn/end 自动沉淀记忆'],
  ['valueGate', '价值门', '过滤低价值噪音'],
  ['dedupMerge', '去重合并', '相似记忆更新而非新建'],
  ['preStepInject', '自动注入', 'pre-step 每步自动注入相关记忆'],
  ['manageTools', '管理工具集', '暴露 memory_* 工具给模型'],
  ['time', '时间维度', '更新追加版本（世界线），关闭则直接覆盖'],
  ['graph', '图谱构建', '实体节点 + 共现边'],
]

/** 提取模型字段（refiner 子对象）。 */
const REFINER_FIELDS = [
  ['enabled', '启用 LLM 提取', '用独立模型蒸馏记忆，替代原始文本入库'],
  ['provider', '供应商 Provider', '已配置的 provider 路由（下拉预设；自建端点可选自定义）'],
  ['model', '模型', '选定供应商的模型目录（下拉预设；可自定义 id）'],
  ['apiKeyEnv', '独立密钥槽引用', '仅当选中供应商未声明 apiKeyEnv 时生效（自建供应商场景），默认 MEMORY_REFINER_API_KEY'],
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
  ['topK', '精排候选数', 'RRF 融合后取前 N 条重排（5~50，默认 20）'],
  ['minCandidates', '最少候选', '候选不足不触发重排（2~20，默认 3）'],
  ['rrfWeight', 'RRF 权重', '融合分 = w×RRF + (1-w)×重排分（0~1，默认 0.7）'],
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
  ['interval', '巡检间隔（沉淀条数）', '每沉淀 N 条记忆自动巡检一次（5~500，默认 20）'],
  ['maxIntervalHours', '时间兜底（小时）', '距上次巡检超 N 小时也触发（1~720，默认 24）'],
  ['dedupThreshold', '近重复阈值', '余弦相似度 ≥ 此值判为近重复（0.8~0.99，默认 0.92）'],
  ['agingDays', '老化报告天数', '闲置超 N 天的低价值记忆进报告（7~365，默认 30）'],
]

const NUMERIC_SUB = new Set(['cacheSize', 'topK', 'minCandidates', 'rrfWeight', 'spring', 'repulsion', 'damping', 'gravity', 'interval', 'maxIntervalHours', 'dedupThreshold', 'agingDays'])

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'block', margin: '8px 0' }}>
      <span style={{ fontWeight: 500, fontSize: 13 }}>{label}</span>
      {hint ? <span style={{ display: 'block', color: '#888', fontSize: 12 }}>{hint}</span> : null}
      {children}
    </label>
  )
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '4px 8px',
  fontSize: 13, borderRadius: 6, border: '1px solid #444',
  background: '#1e1e1e', color: '#eee',
}

function CheckboxRow({ label, hint, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: 13, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
      {hint ? <span style={{ color: '#888', fontSize: 12 }}>— {hint}</span> : null}
    </label>
  )
}

/** 密钥输入卡片：password 写凭据文件（~/.dsh/.credentials.yaml），绝不回显；ref 为凭据键名。 */
function KeyInput({ api, ref, hint }) {
  const [state, setState] = useState({ checking: false, configured: false, writing: false })
  const [draft, setDraft] = useState('')
  const check = async () => {
    setState((s) => ({ ...s, checking: true }))
    try {
      const r = await api.credentials.describe({ refs: [ref] })
      setState((s) => ({
        ...s,
        configured: Boolean(r?.result?.ok && r.result.value?.credentials?.[ref]?.configured),
        checking: false,
      }))
    } catch {
      setState((s) => ({ ...s, checking: false }))
    }
  }
  useEffect(() => { void check() }, [ref])
  const save = async () => {
    if (!draft) return
    setState((s) => ({ ...s, writing: true }))
    try {
      await api.credentials.set({ ref, value: draft })
      setDraft('')
      await check()
    } catch (err) {
      console.warn('[dsh-memory-client] 密钥保存失败: ' + err.message)
    } finally {
      setState((s) => ({ ...s, writing: false }))
    }
  }
  return (
    <div style={{ marginTop: 8, padding: 10, border: '1px solid #3a3a3a', borderRadius: 8, background: '#1a1a1a' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <span style={{ fontWeight: 500 }}>API 密钥</span>
        {state.checking
          ? <span style={{ color: '#888', fontSize: 12 }}>检查中…</span>
          : state.configured
            ? <span style={{ color: '#4caf50', fontSize: 12 }}>● 已配置（{ref}）</span>
            : <span style={{ color: '#e67e22', fontSize: 12 }}>○ 未配置（{ref}）</span>}
      </div>
      {hint ? <p style={{ color: '#888', fontSize: 12, margin: '6px 0' }}>{hint}</p> : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ ...inputStyle, marginTop: 0, flex: 1 }}
          type="password"
          placeholder={`粘贴密钥到 ${ref}（留空不改）`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          onClick={save}
          disabled={!draft || state.writing}
          style={{ padding: '4px 14px', borderRadius: 6, border: '1px solid #555', background: '#2a2a2a', color: '#eee', cursor: draft ? 'pointer' : 'default' }}
        >
          {state.writing ? '保存中…' : '保存密钥'}
        </button>
      </div>
    </div>
  )
}

/** 设置面板主组件（侧边栏"记忆"导航项的完整设置菜单）。 */
function MemorySettingsSection({ scope, api, llmScope }) {
  const [snap, setSnap] = useState(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope])

  // 供应商配置目录（llm-pi-ai 命名空间）：每个供应商自己的密钥引用（apiKeyEnv）与端点
  const [llmSnap, setLlmSnap] = useState(() => llmScope.getSnapshot())
  useEffect(() => llmScope.subscribe(() => setLlmSnap(llmScope.getSnapshot())), [llmScope])

  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  // 供应商/模型预设：从 DSH 的 LLM 目录动态获取（已配置 providers + 各 provider 的模型目录）
  const [providers, setProviders] = useState([])
  const [modelGroups, setModelGroups] = useState([])
  useEffect(() => {
    let alive = true
    api.llm.providers({}).then((r) => {
      if (alive && r?.result?.ok) setProviders(r.result.value.providers ?? [])
    }).catch(() => {})
    api.llm.models({}).then((r) => {
      if (alive && r?.result?.ok) setModelGroups(r.result.value.groups ?? [])
    }).catch(() => {})
    return () => { alive = false }
  }, [api])

  // 独立密钥状态：只报告"已配置/未配置"，绝不含密钥本身
  const [keyState, setKeyState] = useState({ ref: '', configured: false, checking: false, writing: false })
  const [keyDraft, setKeyDraft] = useState('')

  const value = snap.value ?? {}
  const features = value.features ?? {}
  const refiner = value.refiner ?? {}
  const embedding = value.embedding ?? {}
  const reranker = value.reranker ?? {}
  const graphView = value.graphView ?? {}
  const housekeeping = value.housekeeping ?? {}
  const writable = snap.writable ?? false
  const status = snap.status

  // 供应商/模型预设选择状态（先于密钥逻辑，keyRef 依赖 providerValue）
  const providerValue = drafts['refiner.provider'] ?? refiner.provider ?? ''
  const providerIsPreset = providers.some((p) => p.provider === providerValue)
  const providerModels = modelGroups.find((g) => g.id === providerValue)?.models ?? []
  const modelValue = drafts['refiner.model'] ?? refiner.model ?? ''
  const modelIsPreset = providerModels.some((m) => m.id === modelValue)

  // llm-pi-ai 命名空间的供应商配置（providers 字典，profile 含 apiKeyEnv/baseURL）
  const providersCfg = (llmSnap?.value?.providers ?? {})
  const selectedProfile = providersCfg[providerValue] ?? {}

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
      const response = await api.credentials.describe({ refs: [ref] })
      const configured = Boolean(response?.result?.ok && response.result.value?.credentials?.[ref]?.configured)
      setKeyState((s) => ({ ...s, configured, checking: false }))
    } catch {
      setKeyState((s) => ({ ...s, checking: false }))
    }
  }
  useEffect(() => { void checkKey() }, [drafts['refiner.apiKeyEnv'], refiner.apiKeyEnv, providerValue, llmSnap])

  const saveKey = async () => {
    if (!keyDraft) return
    const ref = keyRef()
    setKeyState((s) => ({ ...s, writing: true }))
    try {
      await api.credentials.set({ ref, value: keyDraft })
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

  const setNum = (field, text) => setDrafts((d) => ({ ...d, [field]: text }))
  const setBool = (group, field, v) => setDrafts((d) => ({ ...d, [`${group}.${field}`]: v }))
  const setText = (group, field, text) => setDrafts((d) => ({ ...d, [`${group}.${field}`]: text }))

  const dirty = Object.keys(drafts).length > 0
  // 数值字段（顶层全部 + 子对象中 NUMERIC_SUB 声明项）填了非数字 → 禁止保存
  const invalid = Object.entries(drafts).some(([k, v]) => {
    if (v === '') return false
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
            next[f] = f === 'enabled' ? v : String(v)
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
      if (rkKeys.some((f) => drafts[`reranker.${f}`] !== undefined)) {
        const next = { ...reranker }
        for (const [f] of RERANKER_FIELDS) {
          const v = drafts[`reranker.${f}`]
          if (v !== undefined) next[f] = NUMERIC_SUB.has(f) ? Number(v) : String(v)
        }
        await scope.set('reranker', next)
      }
      {/* graphView 整体 */}
      const gvKeys = GRAPH_VIEW_FIELDS.map(([f]) => f)
      if (gvKeys.some((f) => drafts[`graphView.${f}`] !== undefined)) {
        const next = { ...graphView }
        for (const [f] of GRAPH_VIEW_FIELDS) {
          const v = drafts[`graphView.${f}`]
          if (v !== undefined) next[f] = Number(v)
        }
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
        await scope.set('housekeeping', next)
      }
      setDrafts({})
      setMsg('✅ 已保存，改动即时生效')
    } catch (err) {
      setMsg(`❌ 保存失败: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setDrafts({})
    setMsg('')
  }

  if (status !== 'ready') {
    return (
      <div style={{ padding: 16, maxWidth: 680 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>记忆</h3>
        <p style={{ color: '#888', fontSize: 13 }}>
          记忆插件设置{status === 'loading' ? '加载中…' : '不可用（host 未注册 memory 命名空间）'}
        </p>
      </div>
    )
  }

  const blockStyle = {
    marginTop: 16, padding: 14, border: '1px solid #3a3a3a', borderRadius: 10, background: '#1a1a1a',
  }
  const blockTitle = { margin: '0 0 4px', fontWeight: 600, fontSize: 14 }

  return (
    <div style={{ padding: 16, maxWidth: 680 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>记忆</h3>
      <p style={{ margin: '0 0 8px', color: '#888', fontSize: 13 }}>
        dsh-memory 自动记忆插件——改动即时生效（live），写入 settings.yaml 的 memory 段。
      </p>

      <div style={blockStyle}>
        <div style={blockTitle}>检索与注入</div>
        {NUMBER_FIELDS.map(([field, label, hint]) => (
          <Field key={field} label={label} hint={hint}>
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

      {/* 独立密钥：password 输入，写凭据文件，绝不回显；目标引用自动跟随选中供应商 */}
      <div style={{ marginTop: 8, padding: 10, border: '1px solid #3a3a3a', borderRadius: 8, background: '#1a1a1a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <span style={{ fontWeight: 500 }}>API 密钥</span>
          {keyState.checking
            ? <span style={{ color: '#888', fontSize: 12 }}>检查中…</span>
            : keyState.configured
              ? <span style={{ color: '#4caf50', fontSize: 12 }}>● 已配置（{keyState.ref}）</span>
              : <span style={{ color: '#e67e22', fontSize: 12 }}>○ 未配置（{keyState.ref}）</span>}
        </div>
        <p style={{ color: '#888', fontSize: 12, margin: '6px 0' }}>
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
            style={{ padding: '4px 14px', borderRadius: 6, border: '1px solid #555', background: '#2a2a2a', color: '#eee', cursor: keyDraft ? 'pointer' : 'default' }}
          >
            {keyState.writing ? '保存中…' : '保存密钥'}
          </button>
        </div>
        <p style={{ color: '#777', fontSize: 12, margin: '6px 0 0' }}>
          换供应商后此处自动切换到新供应商的密钥引用（已配置则显示 ●）；自建独立供应商：在「设置 → 模型」添加 provider（npm: <code>@ai-sdk/openai-compatible</code>），apiKeyEnv 填 <code>MEMORY_REFINER_API_KEY</code>，baseURL 填你的端点。
        </p>
      </div>
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>嵌入与重排模型</div>
        <p style={{ margin: '0 0 4px', color: '#888', fontSize: 12 }}>
          嵌入决定向量路质量（remote 失败自动降级 rule 哈希，永久兜底）；重排对 RRF 候选精排（失败降级 RRF 顺序，零损失）。改动 live 生效。
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
          ref={drafts['embedding.apiKeyEnv'] ?? embedding.apiKeyEnv ?? 'MEMORY_EMBEDDING_API_KEY'}
          hint="硅基流动控制台创建密钥；写入 ~/.dsh/.credentials.yaml（私有文件），不进设置/记忆库、界面不回显。"
        />

        <div style={{ fontWeight: 500, fontSize: 13, marginTop: 14 }}>重排（reranker）</div>
        <CheckboxRow
          label="启用重排"
          hint="RRF 融合后对候选精排（需已配置重排密钥）"
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
          ref={drafts['reranker.apiKeyEnv'] ?? reranker.apiKeyEnv ?? 'MEMORY_RERANK_API_KEY'}
          hint="与嵌入可共用同一密钥；写入凭据文件，不进设置/记忆库、界面不回显。"
        />
      </div>

      <div style={blockStyle}>
        <div style={blockTitle}>记忆图谱（力导向手感）</div>
        <p style={{ margin: '0 0 4px', color: '#888', fontSize: 12 }}>
          打开「记忆图谱」面板时读取；改动后重开面板生效。
        </p>
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
        <p style={{ margin: '0 0 4px', color: '#888', fontSize: 12 }}>
          自动检查近重复与老化记忆（只报告不删数据，可调 memory_housekeeping 处理）。触发与对话轮数解耦：每沉淀 N 条记忆 或 距上次巡检超 N 小时。
        </p>
        <CheckboxRow
          label="启用自动巡检"
          hint="沉淀记忆时低频检查（发现候选写日志提示）"
          checked={bool('housekeeping', 'enabled', housekeeping)}
          onChange={(e) => setBool('housekeeping', 'enabled', e.target.checked)}
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

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={!dirty || invalid || saving || !writable}
          style={{ padding: '4px 16px', borderRadius: 6, border: '1px solid #555', background: '#2a2a2a', color: '#eee', cursor: dirty ? 'pointer' : 'default' }}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button onClick={reset} disabled={!dirty}
          style={{ padding: '4px 16px', borderRadius: 6, border: '1px solid #555', background: 'transparent', color: '#aaa', cursor: dirty ? 'pointer' : 'default' }}>
          重置
        </button>
      </div>
      {invalid ? <p style={{ color: '#e67e22', fontSize: 12, margin: '6px 0 0' }}>⚠ 数值字段必须填数字</p> : null}
      {msg ? <p style={{ fontSize: 12, margin: '6px 0 0' }}>{msg}</p> : null}
    </div>
  )
}

// ============ 记忆图谱视图（conversation.view 顶部 tab「记忆」） ============

const THEME_COLORS = [
  '#5b9bd5', '#70ad47', '#ffc000', '#e07b39', '#9e6fc2', '#d65c5c',
  '#4db6ac', '#a1887f', '#7986cb', '#f06292', '#26a69a', '#8d6e63',
]

/** 新旧色温（四维蠕虫的时间维度）：按创建时间把主题色压暗——新=原色亮，旧=暗。
 *  库内相对映射（minCreatedAt=库内最早创建时间）：任意时间跨度下新旧对比都明显。 */
function ageShade(hex, createdAt, minCreatedAt, now = Date.now()) {
  const span = Math.max(1, now - (minCreatedAt ?? now))
  const ratio = 1 - Math.max(0, Math.min(1, (now - (createdAt ?? now)) / span)) * 0.55
  const n = parseInt(String(hex).slice(1), 16)
  if (Number.isNaN(n)) return hex
  const r = Math.round(((n >> 16) & 255) * ratio)
  const g = Math.round(((n >> 8) & 255) * ratio)
  const b = Math.round((n & 255) * ratio)
  return `rgb(${r},${g},${b})`
}

/** 记忆时间筛选窗口。 */
const AGE_WINDOWS = [
  ['all', '全部'],
  ['7d', '近 7 天'],
  ['30d', '近 30 天'],
  ['90d', '近 90 天'],
  ['old', '90 天以上'],
]

/** 相对时间文案（中文）。 */
function agoText(ts, now = Date.now()) {
  const d = Math.max(0, Math.floor((now - ts) / (24 * 3600 * 1000)))
  if (d <= 0) return '今天'
  if (d < 30) return `${d} 天前`
  if (d < 365) return `${Math.floor(d / 30)} 个月前`
  return `${Math.floor(d / 365)} 年前`
}

/** 主题环形布局：每个主题一个扇区，组内节点均匀分布；返回 id → [x, y]。 */
function layoutNodes(data, W, H) {
  const cx = W / 2, cy = H / 2
  const themes = data.themes.length > 0 ? data.themes : ['(未归类)']
  const groups = new Map()
  for (const n of data.nodes) {
    const t = n.theme || '(未归类)'
    if (!groups.has(t)) groups.set(t, [])
    groups.get(t).push(n)
  }
  const positions = new Map()
  let idx = 0
  for (const [theme, members] of groups) {
    const ti = themes.indexOf(theme)
    const base = ti >= 0 ? (ti / themes.length) * 2 * Math.PI : (idx / groups.size) * 2 * Math.PI
    const spread = ((2 * Math.PI) / themes.length) * 0.88
    const R = 200
    members.forEach((n, i) => {
      const ang = members.length === 1
        ? base
        : base - spread / 2 + (spread * i) / (members.length - 1)
      const r = R + (i % 4) * 24
      positions.set(n.id, [cx + r * Math.cos(ang), cy + r * Math.sin(ang)])
    })
    idx++
  }
  return { positions, groups }
}

/** Obsidian 风格力导向图谱（Canvas 渲染）：
 *  物理：斥力 + 弹簧 + 中心引力 + 速度阻尼；alpha 冷却到阈值后停帧（省 CPU）
 *  交互：拖节点（固定 + 重新加热）、拖背景平移、滚轮以鼠标为中心缩放、hover 高亮邻居、点击选中
 *  性能：单 Canvas 每帧整绘（数百节点 <5ms）；选中/hover 经 ref 传入，组件零重渲染
 */
const ObsidianGraph = memo(function ObsidianGraph({ data, onSelect, selectedRef, drawRef, physics }) {
  const canvasRef = useRef(null)
  const hoverRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    const dpr = window.devicePixelRatio || 1
    const P = physics ?? { spring: 0.13, repulsion: 1, damping: 0.3, gravity: 0.005 }
    const resize = () => {
      const rect = canvas.parentElement.getBoundingClientRect()
      canvas.width = Math.max(1, rect.width) * dpr
      canvas.height = Math.max(1, rect.height) * dpr
      canvas.style.width = rect.width + "px"
      canvas.style.height = rect.height + "px"
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener("resize", resize)
    const W = () => canvas.width / dpr, H = () => canvas.height / dpr

    // ---- 模拟状态 ----
    const colorOf = (theme) => {
      const i = data.themes.indexOf(theme)
      return i >= 0 ? THEME_COLORS[i % THEME_COLORS.length] : "#888"
    }
    const degree = new Map()
    for (const e of data.edges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1) }
    // 初始位置：主题环形布局（力导向从有序起点自然展开，观感优雅）
    const init = layoutNodes(data, W(), H())
    const now = Date.now()
    const minCreated = Math.min(...data.nodes.map((n) => n.createdAt ?? now), now)
    const nodes = data.nodes.map((n) => {
      const p = init.positions.get(n.id) ?? [W() / 2 + (Math.random() - 0.5) * 60, H() / 2 + (Math.random() - 0.5) * 60]
      // 新旧色温：新记忆亮、旧记忆暗（时间作为第四维的视觉编码；库内相对映射）
      return { ...n, x: p[0], y: p[1], vx: 0, vy: 0, degree: degree.get(n.id) ?? 0, color: ageShade(colorOf(n.theme), n.createdAt, minCreated, now) }
    })
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    const edges = data.edges.map((e) => ({ ...e, a: nodeById.get(e.from), b: nodeById.get(e.to) })).filter((e) => e.a && e.b)
    const neighbors = new Map()
    for (const e of edges) {
      if (!neighbors.has(e.a.id)) neighbors.set(e.a.id, new Set())
      neighbors.get(e.a.id).add(e.b.id)
      if (!neighbors.has(e.b.id)) neighbors.set(e.b.id, new Set())
      neighbors.get(e.b.id).add(e.a.id)
    }

    // ---- 力导向（平衡设计：连线多不挤团、连线少不漂远） ----
    //  斥力：Fruchterman k²/d + 距离截断 2.2k（远距零斥力 → 孤立节点不被无限推远）
    //  弹簧：目标长度度感知（枢纽节点周围留更大空间）+ 强度 0.07（更紧）
    //  中心引力：0.005 线性（孤立节点回归中心；被拖拽节点豁免）
    let alpha = 0.7, raf = 0
    const k = Math.sqrt((W() * H()) / Math.max(nodes.length, 1))
    const maxDeg = Math.max(...nodes.map((n) => n.degree), 1)
    let dragNode = null
    const transform = { x: 0, y: 0, k: 1 }
    const heat = (a) => { alpha = Math.max(alpha, a) }
    const step = () => {
      alpha += (0 - alpha) * 0.028
      // 拖动期间维持模拟活跃（alpha 地板）：弹簧持续牵引，邻居弹性跟随拖点
      if (dragNode) alpha = Math.max(alpha, 0.15)
      // 斥力（带截断与最小距离钳制）
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          let dx = a.x - b.x, dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1e-6) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
          const d = Math.sqrt(d2)
          if (d >= 2.2 * k) continue   // 远距截断：太远的节点互不影响
          const dd = Math.max(d, 22)   // 软化核心：22px 内斥力不再增长（拖点压邻居不爆炸）
          // 拖动期间斥力减半：跟随交给弹簧，斥力只做让位——防团内连锁推挤振荡
          const f = Math.min((k * k) / dd, k * 0.6) * alpha * P.repulsion * (dragNode ? 0.45 : 1)
          a.vx += (dx / d) * f; a.vy += (dy / d) * f
          b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
        }
      }
      // 弹簧（度感知目标长度：连线越多间距越大，防挤团）
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const degFactor = 1 + 0.5 * Math.sqrt(((e.a.degree + e.b.degree) / 2) / maxDeg)
        const target = k * 1.15 * degFactor
        const f = (d - target) * P.spring * alpha
        e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f
        e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f
      }
      // 中心引力（增强，孤立节点不漂远）
      // 拖动期间强阻尼爬行：邻居缓慢平滑漂向拖点（无惯性回摆 = 无抖动）；松手恢复弹性
      const damp = dragNode ? 0.11 : P.damping
      for (const n of nodes) {
        if (n === dragNode) { n.vx = 0; n.vy = 0; continue }
        n.vx += (W() / 2 - n.x) * P.gravity * alpha
        n.vy += (H() / 2 - n.y) * P.gravity * alpha
        n.vx *= damp; n.vy *= damp
        n.x += n.vx * 1.5; n.y += n.vy * 1.5
      }
    }

    // ---- 自适应视野（fit-to-view：力导向冷却后自动缩放居中到全部节点） ----
    let fitted = false
    const fitToView = () => {
      if (nodes.length === 0) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of nodes) {
        if (n.x < minX) minX = n.x
        if (n.y < minY) minY = n.y
        if (n.x > maxX) maxX = n.x
        if (n.y > maxY) maxY = n.y
      }
      const pad = 70
      const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1)
      const kFit = Math.min((W() - pad * 2) / bw, (H() - pad * 2) / bh, 1.5)
      transform.k = Math.max(0.28, kFit)
      transform.x = (W() - bw * transform.k) / 2 - minX * transform.k
      transform.y = (H() - bh * transform.k) / 2 - minY * transform.k
      fitted = true
    }

    // ---- 绘制 ----
    const draw = () => {
      ctx.clearRect(0, 0, W(), H())
      ctx.save()
      ctx.translate(transform.x, transform.y)
      ctx.scale(transform.k, transform.k)
      // 点阵背景（Obsidian 风格定位网格：随平移/缩放跟随）
      ctx.fillStyle = "rgba(255,255,255,0.16)"
      const grid = 44
      const gx0 = Math.floor(-transform.x / transform.k / grid) * grid
      const gy0 = Math.floor(-transform.y / transform.k / grid) * grid
      const gx1 = gx0 + W() / transform.k + grid
      const gy1 = gy0 + H() / transform.k + grid
      for (let wx = gx0; wx <= gx1; wx += grid) {
        for (let wy = gy0; wy <= gy1; wy += grid) {
          ctx.fillRect(wx, wy, 1.4, 1.4)
        }
      }
      const selId = selectedRef.current
      const hovId = hoverRef.current
      const focusId = selId || hovId
      for (const e of edges) {
        const on = !focusId || e.a.id === focusId || e.b.id === focusId
        ctx.globalAlpha = focusId ? (on ? 0.9 : 0.1) : 0.45
        ctx.strokeStyle = e.type === "similarTo" ? "#5b9bd5" : "#e07b39"
        ctx.lineWidth = (e.type === "similarTo" ? 0.7 : 1.3) / transform.k
        ctx.beginPath()
        ctx.moveTo(e.a.x, e.a.y)
        ctx.lineTo(e.b.x, e.b.y)
        ctx.stroke()
      }
      for (const n of nodes) {
        const isFocus = n.id === focusId
        const isNbr = focusId && neighbors.get(focusId)?.has(n.id)
        ctx.globalAlpha = focusId ? (isFocus || isNbr ? 1 : 0.2) : 1
        ctx.beginPath()
        const r = (4 + Math.min(n.degree, 14) * 0.55) / Math.sqrt(transform.k)
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = n.color
        ctx.fill()
        // 版本环（四维蠕虫的时间痕迹）：更新过几次 = 几圈年轮（封顶 3 圈）
        if (n.versions > 1) {
          const rings = Math.min(n.versions - 1, 3)
          const step = 3.2 / Math.sqrt(transform.k)
          for (let ri = 0; ri < rings; ri++) {
            ctx.beginPath()
            ctx.arc(n.x, n.y, r + 3 + ri * step, 0, Math.PI * 2)
            ctx.strokeStyle = "#ffd54f"
            ctx.lineWidth = 1.3 / Math.sqrt(transform.k)
            ctx.stroke()
          }
        }
        if (isFocus) {
          ctx.strokeStyle = "#fff"
          ctx.lineWidth = 1.5 / transform.k
          ctx.stroke()
          // 悬浮/选中标签：创建时间 + 更新次数（四维蠕虫的时间信息）
          const tag = `${agoText(n.createdAt)}${(n.versions ?? 1) > 1 ? ` · 更新 ${(n.versions ?? 1) - 1} 次` : ''}`
          ctx.font = (10 / transform.k) + "px sans-serif"
          ctx.textAlign = "center"
          ctx.fillStyle = "#ddd"
          ctx.fillText(tag, n.x, n.y - r - 10 / transform.k)
        }
        if (transform.k > 0.65 || isFocus) {
          ctx.globalAlpha = isFocus || !focusId ? 1 : 0.3
          ctx.fillStyle = "#ccc"
          ctx.font = (10 / transform.k) + "px sans-serif"
          ctx.textAlign = "center"
          ctx.fillText(n.label.slice(0, 9), n.x, n.y + r + 11 / transform.k)
        }
      }
      ctx.globalAlpha = 1
      ctx.restore()
    }
    drawRef.current = draw

    const loop = () => {
      step()
      // 模拟接近收敛且无人拖动时，自适应一次视野（全部节点可见）
      if (!fitted && !dragNode && (alpha < 0.06 || nodes.every((n) => Math.abs(n.vx) < 0.02))) fitToView()
      draw()
      // 拖动期间循环永续（节点跟随不冻结）；冷却且无拖动时停帧省 CPU
      if (alpha > 0.008 || dragNode) raf = requestAnimationFrame(loop)
      else raf = 0
    }
    raf = requestAnimationFrame(loop)

    // ---- 交互 ----
    const hitTest = (mx, my) => {
      const wx = (mx - transform.x) / transform.k, wy = (my - transform.y) / transform.k
      let best = null, bestD = (14 * 14) / (transform.k * transform.k)
      for (const n of nodes) {
        const dx = n.x - wx, dy = n.y - wy
        const d2 = dx * dx + dy * dy
        if (d2 < bestD) { bestD = d2; best = n }
      }
      return best
    }
    let panStart = null, downPos = null, moved = false
    const getPos = (ev) => {
      const rect = canvas.getBoundingClientRect()
      return [ev.clientX - rect.left, ev.clientY - rect.top]
    }
    const onDown = (ev) => {
      downPos = [ev.clientX, ev.clientY]
      moved = false
      const [mx, my] = getPos(ev)
      const n = hitTest(mx, my)
      if (n) { dragNode = n; heat(0.35); if (!raf) raf = requestAnimationFrame(loop) }
      else panStart = { x: ev.clientX, y: ev.clientY, tx: transform.x, ty: transform.y }
    }
    const onMove = (ev) => {
      if (downPos && (Math.abs(ev.clientX - downPos[0]) > 4 || Math.abs(ev.clientY - downPos[1]) > 4)) moved = true
      const [mx, my] = getPos(ev)
      if (dragNode) {
        dragNode.x = (mx - transform.x) / transform.k
        dragNode.y = (my - transform.y) / transform.k
        // 兜底：拖动中循环若意外停止，立即重启（防画面冻结）
        if (!raf) raf = requestAnimationFrame(loop)
      } else if (panStart) {
        transform.x = panStart.tx + (ev.clientX - panStart.x)
        transform.y = panStart.ty + (ev.clientY - panStart.y)
        if (!raf) { draw() }
      } else {
        const n = hitTest(mx, my)
        if ((n?.id ?? null) !== hoverRef.current) {
          hoverRef.current = n?.id ?? null
          if (!raf) { raf = requestAnimationFrame(() => { draw(); raf = 0 }) }
        }
      }
    }
    const onUp = () => { dragNode = null; panStart = null; downPos = null }
    const onClick = (ev) => {
      if (moved) return
      const [mx, my] = getPos(ev)
      const n = hitTest(mx, my)
      onSelect(n ?? null)
    }
    const onWheel = (ev) => {
      ev.preventDefault()
      const [mx, my] = getPos(ev)
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12
      const nk = Math.min(4, Math.max(0.25, transform.k * factor))
      transform.x = mx - ((mx - transform.x) / transform.k) * nk
      transform.y = my - ((my - transform.y) / transform.k) * nk
      transform.k = nk
      draw()
    }
    canvas.addEventListener("mousedown", onDown)
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    canvas.addEventListener("click", onClick)
    canvas.addEventListener("wheel", onWheel, { passive: false })

    return () => {
      cancelAnimationFrame(raf)
      drawRef.current = null
      window.removeEventListener("resize", resize)
      canvas.removeEventListener("mousedown", onDown)
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      canvas.removeEventListener("click", onClick)
      canvas.removeEventListener("wheel", onWheel)
    }
  }, [data, onSelect, selectedRef, drawRef, physics])

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", cursor: "grab" }} />
})

/** 详情面板（memo：仅选中变化时重渲染）。 */
const DetailPanel = memo(function DetailPanel({ selected, data }) {
  const { colorOf, adj, nodeById } = useMemo(() => {
    const co = (theme) => {
      const i = data.themes.indexOf(theme)
      return i >= 0 ? THEME_COLORS[i % THEME_COLORS.length] : "#888"
    }
    const nodeById = new Map(data.nodes.map((n) => [n.id, n]))
    const a = new Map()
    for (const e of data.edges) {
      if (!a.has(e.from)) a.set(e.from, [])
      a.get(e.from).push({ other: e.to, type: e.type, weight: e.weight })
      if (!a.has(e.to)) a.set(e.to, [])
      a.get(e.to).push({ other: e.from, type: e.type, weight: e.weight })
    }
    return { colorOf: co, adj: a, nodeById }
  }, [data])
  if (!selected) return null
  return (
    <div style={{ width: 280, borderLeft: "1px solid #333", padding: 14, overflowY: "auto", background: "#161616" }}>
      <h4 style={{ margin: "0 0 8px", color: colorOf(selected.theme) }}>{selected.theme || "(未归类)"}</h4>
      <p style={{ fontSize: 12, color: "#888", margin: "0 0 10px" }}>
        {selected.type} · {selected.layer} · strength {selected.strength} · {new Date(selected.createdAt).toLocaleString("zh-CN", { hour12: false })}
      </p>
      <p style={{ fontSize: 12, margin: "0 0 10px" }}>
        {(selected.versions ?? 1) > 1
          ? <span style={{ color: "#ffd54f" }}>◉ 更新过 {(selected.versions ?? 1) - 1} 次（世界线保留最近 {(selected.versions ?? 1)} 段）</span>
          : <span style={{ color: "#777" }}>○ 未更新过（单版本）</span>}
        <span style={{ color: "#888" }}> · 创建于 {agoText(selected.createdAt)}</span>
        {selected.updatedAt && selected.updatedAt !== selected.createdAt
          ? <span style={{ color: "#888" }}> · 最后更新 {agoText(selected.updatedAt)}</span>
          : null}
      </p>
      <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{selected.content}</p>
      <h5 style={{ margin: "14px 0 6px", fontSize: 12, color: "#aaa" }}>关联记忆</h5>
      {(adj.get(selected.id) ?? []).length === 0 ? (
        <p style={{ fontSize: 12, color: "#777" }}>暂无关联</p>
      ) : (
        (adj.get(selected.id) ?? []).map((a, i) => {
          const other = nodeById.get(a.other)
          return (
            <div key={i} style={{ fontSize: 12, margin: "4px 0", color: "#bbb" }}>
              <span style={{ color: a.type === "similarTo" ? "#5b9bd5" : "#e07b39" }}>[{a.type}]</span>
              {a.type === "similarTo" ? " 相似 " + a.weight.toFixed(2) + " " : " "}
              {other ? other.label.slice(0, 12) : a.other}
            </div>
          )
        })
      )}
    </div>
  )
})

/** 记忆图谱视图组件（容器：数据加载 + 选中态；画布与面板均 memo 隔离）。
 *  scope：memory 设置命名空间（读 graphView 力导向参数，live 生效）。 */
function MemoryGraphView({ scope }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState(null)
  const selectedRef = useRef(null)
  const drawRef = useRef(null)

  // 力导向物理参数：settings.graphView（缺省回落默认手感）；scope 变化 → physics 引用变化 → 重建模拟
  const [gv, setGv] = useState(() => {
    try { return scope?.getSnapshot()?.value?.graphView ?? {} } catch { return {} }
  })
  useEffect(() => {
    if (!scope) return
    const sub = scope.subscribe(() => {
      try { setGv(scope.getSnapshot()?.value?.graphView ?? {}) } catch { /* 快照异常忽略 */ }
    })
    return sub
  }, [scope])
  const physics = useMemo(() => ({
    spring: Number(gv.spring) || 0.13,
    repulsion: Number(gv.repulsion) || 1,
    damping: Number(gv.damping) || 0.3,
    gravity: Number(gv.gravity) || 0.005,   // || 而非 ??：Number(undefined)=NaN，NaN??x 仍是 NaN 会击穿力导向
  }), [gv.spring, gv.repulsion, gv.damping, gv.gravity])

  const load = useCallback(() => {
    setError("")
    fetch("/dsh-memory/graph")
      .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json() })
      .then(setData)
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])
  useEffect(load, [load])

  // 选中态经 ref 通知画布重绘（零组件重渲染；Canvas 绘制循环读取 selectedRef）
  useEffect(() => {
    selectedRef.current = selected?.id ?? null
    drawRef.current?.()
  }, [selected])

  // 时间筛选（四维蠕虫：只看某时间窗内的记忆）
  const [ageWindow, setAgeWindow] = useState("all")
  const filtered = useMemo(() => {
    if (!data) return data
    if (ageWindow === "all") return data
    const now = Date.now()
    const cutoffOld = now - 90 * 24 * 3600 * 1000
    const inWindow = (ts) => {
      if (ageWindow === "old") return (ts ?? 0) < cutoffOld
      const days = Number(ageWindow.replace("d", ""))
      return (ts ?? 0) >= now - days * 24 * 3600 * 1000
    }
    const ids = new Set(data.nodes.filter((n) => inWindow(n.createdAt)).map((n) => n.id))
    const nodes = data.nodes.filter((n) => ids.has(n.id))
    return {
      ...data,
      nodes,
      edges: data.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      themes: [...new Set(nodes.map((n) => n.theme).filter(Boolean))],   // 筛选后主题数口径一致
    }
  }, [data, ageWindow])
  const updatedCount = (filtered?.nodes ?? []).filter((n) => (n.versions ?? 1) > 1).length

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <h3 style={{ margin: "0 0 12px" }}>记忆图谱</h3>
        <p style={{ color: "#e07b39" }}>加载失败：{error}</p>
        <button onClick={load} style={{ padding: "4px 16px", borderRadius: 6, border: "1px solid #555", background: "transparent", color: "#aaa", cursor: "pointer" }}>重试</button>
      </div>
    )
  }
  if (!data) {
    return <div style={{ padding: 24, color: "#888" }}>加载记忆图谱中…</div>
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 560, gap: 0 }}>
      <div style={{ flex: 1, minWidth: 0, position: "relative", minHeight: 560 }}>
        <div style={{ position: "absolute", top: 10, left: 14, fontSize: 12, color: "#aaa", zIndex: 2, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>
            记忆 {filtered.nodes.length} · 更新过 {updatedCount} · 主题 {filtered.themes.length} · 关系 {filtered.edges.length}
          </span>
          <select
            value={ageWindow}
            onChange={(e) => setAgeWindow(e.target.value)}
            style={{ padding: "1px 6px", fontSize: 12, borderRadius: 5, border: "1px solid #555", background: "#1a1a1a", color: "#ccc" }}
            title="按创建时间筛选记忆（时间维度）"
          >
            {AGE_WINDOWS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <button onClick={load} style={{ padding: "1px 10px", borderRadius: 5, border: "1px solid #555", background: "transparent", color: "#aaa", cursor: "pointer", fontSize: 12 }}>刷新</button>
        </div>
        <ObsidianGraph data={filtered} onSelect={setSelected} selectedRef={selectedRef} drawRef={drawRef} physics={physics} />
        <div style={{ position: "absolute", left: 14, bottom: 10, fontSize: 11, color: "#777", zIndex: 2 }}>
          <span style={{ color: "#5b9bd5" }}>— similarTo 语义相似</span>
          <span style={{ marginLeft: 10, color: "#e07b39" }}>→ before 时间演化</span>
          <span style={{ marginLeft: 10, color: "#ffd54f" }}>◎ 外环 = 更新过（环数 = 更新次数）</span>
          <span style={{ marginLeft: 10 }}>色浅新 · 色深旧</span>
          <span style={{ marginLeft: 10 }}>拖节点 · 平移 · 缩放 · 点击看详情</span>
        </div>
      </div>
      <DetailPanel selected={selected} data={filtered} />
    </div>
  )
}

/**
 * 侧边栏底部入口（sidebar.footer.action，与任务看板同槽）：
 * 点开渲染全视口面板（fixed 覆盖层，含标题栏与关闭按钮），面板内是完整图谱页面。
 */
function MemoryGraphLauncher({ wide, scope }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="记忆图谱"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
          padding: '5px 8px', borderRadius: 6, border: 'none',
          background: open ? 'rgba(91,155,213,0.18)' : 'transparent',
          color: '#ccc', cursor: 'pointer', fontSize: 12,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="3" cy="3" r="1.8" fill="#5b9bd5" />
          <circle cx="11" cy="3" r="1.8" fill="#e07b39" />
          <circle cx="7" cy="11" r="1.8" fill="#70ad47" />
          <line x1="3.8" y1="4.2" x2="9.8" y2="4.2" stroke="#777" strokeWidth="0.8" />
          <line x1="3.6" y1="4.6" x2="6.4" y2="9.6" stroke="#777" strokeWidth="0.8" />
          <line x1="10.4" y1="4.6" x2="7.6" y2="9.6" stroke="#777" strokeWidth="0.8" />
        </svg>
        {wide ? <span>记忆图谱</span> : null}
      </button>
      {open ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1200, background: '#121212', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid #2a2a2a', flex: 'none' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#ddd' }}>记忆图谱</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{ padding: '3px 12px', borderRadius: 6, border: '1px solid #444', background: 'transparent', color: '#aaa', cursor: 'pointer', fontSize: 13 }}
            >
              关闭
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <MemoryGraphView scope={scope} />
          </div>
        </div>
      ) : null}
    </>
  )
}

/** 浏览器端 apply：注册设置侧边栏导航项 + 侧边栏底部「记忆图谱」入口（全视口面板）。 */
export function apply(ctx) {
  const scope = ctx.settingsScope.bind({ namespace: 'memory' })
  const llmScope = ctx.settingsScope.bind({ namespace: 'llm-pi-ai' })
  const { api } = ctx.get('connection')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 25,
    label: () => '记忆',
    inject: () => ({ scope, api, llmScope }),
  }, MemorySettingsSection))
  // 记忆图谱：主界面可收起侧边栏的底部入口（sidebar.footer.action，与任务看板同槽）
  try {
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'memory-graph',
      order: 10,
      inject: () => ({ scope }),
    }, MemoryGraphLauncher))
  } catch (err) {
    console.warn('[dsh-memory-client] 侧边栏图谱入口注册失败: ' + (err?.message ?? err))
  }
}
