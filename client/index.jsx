/**
 * dsh-memory 客户端设置卡片（浏览器端）。
 *
 * 注册到「设置 → 插件」区域的 `settings.plugin.item` 插槽：
 * 用 ctx.settingsScope 读写 settings.yaml 的 `memory` 命名空间，
 * 与 host 端插件（ctx.settings.register）读写同一文档，改动 live 生效。
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
  ['provider', 'Provider', '如 opencode-go / deepseek-official'],
  ['model', '模型', '如 deepseek-v4-flash / deepseek-v4-pro'],
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

/** 设置卡片主组件。 */
function MemorySettingsCard(props) {
  const { scope } = props
  const [snap, setSnap] = useState(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope])

  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const value = snap.value ?? {}
  const features = value.features ?? {}
  const refiner = value.refiner ?? {}
  const writable = snap.writable ?? false
  const status = snap.status

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
      // refiner 整体
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
    return <p style={{ color: '#888', fontSize: 13 }}>记忆插件设置{status === 'loading' ? '加载中…' : '不可用'}</p>
  }

  return (
    <div style={{ padding: '12px 0' }}>
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

      <div style={{ marginTop: 12, fontWeight: 600, fontSize: 13 }}>功能开关</div>
      {FEATURE_FIELDS.map(([field, label, hint]) => (
        <CheckboxRow
          key={field}
          label={label}
          hint={hint}
          checked={bool('features', field, features)}
          onChange={(e) => setBool('features', field, e.target.checked)}
        />
      ))}

      <div style={{ marginTop: 12, fontWeight: 600, fontSize: 13 }}>独立提取模型（refiner）</div>
      <CheckboxRow
        label="启用 LLM 提取"
        hint="用独立模型蒸馏记忆，替代原始文本入库"
        checked={bool('refiner', 'enabled', refiner)}
        onChange={(e) => setBool('refiner', 'enabled', e.target.checked)}
      />
      <Field label="Provider" hint="如 opencode-go / deepseek-official">
        <input
          style={inputStyle}
          type="text"
          value={drafts['refiner.provider'] ?? refiner.provider ?? ''}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'provider', e.target.value)}
        />
      </Field>
      <Field label="模型" hint="如 deepseek-v4-flash / deepseek-v4-pro">
        <input
          style={inputStyle}
          type="text"
          value={drafts['refiner.model'] ?? refiner.model ?? ''}
          disabled={!writable}
          onChange={(e) => setText('refiner', 'model', e.target.value)}
        />
      </Field>

      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
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

/** 浏览器端 apply：注册设置卡片。 */
export function apply(ctx) {
  const scope = ctx.settingsScope.bind({ namespace: 'memory' })
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'dsh-memory',
      order: 30,
      label: () => '记忆插件',
      inject: () => ({ scope }),
    }, MemorySettingsCard)
  })
}
