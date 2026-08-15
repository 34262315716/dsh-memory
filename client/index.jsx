/**
 * dsh-memory 客户端设置面板（浏览器端）。
 *
 * 注册到设置页侧边栏导航（`settings.section` 插槽，与"通用设置/模型/插件"同级）：
 * 点击"记忆"打开完整设置菜单。用 ctx.settingsScope 读写 settings.yaml 的
 * `memory` 命名空间，与 host 端插件（ctx.settings.register）读写同一文档，改动 live 生效。
 *
 * 构建：esbuild 打包为 __ModuleLoader__.load({id, factory}) 格式（见 lib/client.js）。
 */

import { useEffect, useState } from 'react'

export const name = 'dsh-memory-client'
export const inject = ['slots', 'settingsScope', 'connection', 'remote']

/** 表单字段定义：数值字段（顶层）。 */
const NUMBER_FIELDS = [
  ['injectMaxTokens', '注入最大 token/次', '每次自动注入的 token 预算'],
  ['stepInterval', '步距节流', '每 N 步做一次全量检索'],
  ['injectMinScore', '注入最低相关分', '低于该分数的记忆不注入'],
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
  const invalid = Object.entries(drafts).some(([k, v]) => !k.includes('.') && v !== '' && Number.isNaN(Number(v)))

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

/** 浏览器端 apply：注册设置侧边栏导航项 + 完整设置面板。 */
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
}
