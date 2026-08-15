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
  ['provider', '供应商 Provider', '已注册的 provider 路由（opencode-go / deepseek-official / 自建）'],
  ['model', '模型', '如 deepseek-v4-flash / deepseek-v4-pro / mimo-v2.5'],
  ['apiKeyEnv', '密钥引用名', '凭据文件中的键名（默认 MEMORY_REFINER_API_KEY），自建供应商时与模型设置的 apiKeyEnv 保持一致'],
]

/** 常用模型建议。 */
const MODEL_SUGGESTIONS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'mimo-v2.5']
const PROVIDER_SUGGESTIONS = ['opencode-go', 'deepseek-official', 'memory-refiner', 'deepseek']

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
function MemorySettingsSection({ scope, api }) {
  const [snap, setSnap] = useState(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope])

  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  // 独立密钥状态：只报告"已配置/未配置"，绝不含密钥本身
  const [keyState, setKeyState] = useState({ ref: '', configured: false, checking: false, writing: false })
  const [keyDraft, setKeyDraft] = useState('')

  const value = snap.value ?? {}
  const features = value.features ?? {}
  const refiner = value.refiner ?? {}
  const writable = snap.writable ?? false
  const status = snap.status

  const keyRef = () => {
    const d = drafts['refiner.apiKeyEnv']
    return (d !== undefined && d !== '' ? d : refiner.apiKeyEnv) || 'MEMORY_REFINER_API_KEY'
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
  useEffect(() => { void checkKey() }, [drafts['refiner.apiKeyEnv'], refiner.apiKeyEnv])

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
      <Field label="供应商 Provider" hint="opencode-go / deepseek-official / 自建独立供应商">
        <input
          style={inputStyle}
          type="text"
          list="dsh-memory-providers"
          value={drafts['refiner.provider'] ?? refiner.provider ?? ''}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'provider', e.target.value)}
        />
        <datalist id="dsh-memory-providers">
          {PROVIDER_SUGGESTIONS.map((p) => <option key={p} value={p} />)}
        </datalist>
      </Field>
      <Field label="模型" hint="deepseek-v4-flash / deepseek-v4-pro / mimo-v2.5">
        <input
          style={inputStyle}
          type="text"
          list="dsh-memory-models"
          value={drafts['refiner.model'] ?? refiner.model ?? ''}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'model', e.target.value)}
        />
        <datalist id="dsh-memory-models">
          {MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
        </datalist>
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

      {/* 独立密钥：password 输入，写凭据文件，绝不回显 */}
      <div style={{ marginTop: 8, padding: 10, border: '1px solid #3a3a3a', borderRadius: 8, background: '#1a1a1a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <span style={{ fontWeight: 500 }}>独立 API 密钥</span>
          {keyState.checking
            ? <span style={{ color: '#888', fontSize: 12 }}>检查中…</span>
            : keyState.configured
              ? <span style={{ color: '#4caf50', fontSize: 12 }}>● 已配置（{keyState.ref}）</span>
              : <span style={{ color: '#e67e22', fontSize: 12 }}>○ 未配置（{keyState.ref}）</span>}
        </div>
        <p style={{ color: '#888', fontSize: 12, margin: '6px 0' }}>
          密钥仅写入 <code>~/.dsh/.credentials.yaml</code>（私有文件），不进入设置文档、不进入记忆库、不在界面回显。
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...inputStyle, marginTop: 0, flex: 1 }}
            type="password"
            placeholder="粘贴密钥（留空不改）"
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
          自建独立供应商：在「设置 → 模型」添加 provider（npm: <code>@ai-sdk/openai-compatible</code>），apiKeyEnv 填上面的引用名，baseURL 填你的端点。
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
  const { api } = ctx.get('connection')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 25,
    label: () => '记忆',
    inject: () => ({ scope, api }),
  }, MemorySettingsSection))
}
