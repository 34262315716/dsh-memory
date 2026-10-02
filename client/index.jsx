/**
 * dsh-memory 客户端（浏览器端）入口壳。
 *
 * v0.10 拆分：设置面板（settings.jsx）/ 记忆图谱（graph.jsx）/ 记忆日志（logs.jsx）
 * 各自独立成模块，本文件只做插槽装配（不再承载组件逻辑）。
 *
 * 注册：
 *   - 设置侧边栏「记忆」导航项（settings.section 插槽）
 *   - 侧边栏底部「记忆图谱 / 记忆日志」入口（sidebar.footer.action 插槽）
 *
 * 构建：esbuild 打包为 __ModuleLoader__.load({id, factory}) 格式（见 lib/client.js）。
 */
import { MemorySettingsSection } from './settings.jsx'
import { MemoryGraphLauncher } from './graph.jsx'
// MemoryLogLauncher 保留导出但不再使用：日志已并入图谱面板（v0.12.8）

// 排障探针（v0.12.7）：刻意放在**模块顶层**——若控制台里连这一行都没有，
// 说明 bundle 压根没被加载（问题在插件树/加载阶段），而不是 apply 里出的错。
console.log('[dsh-memory-client] bundle 已加载')

export const name = 'dsh-memory-client'
/**
 * 依赖声明（v0.14.0 跨内核适配重写）。
 *
 * 这里**只声明 slots**；设置读写改成"能力探测 + 惰性绑定"，不再硬声明。
 *
 * 为什么把 `settingsScope` 拿掉：0.1.x 的客户端设置服务叫 `settingsScope`，
 * 0.2.0-rc.2 已把它整个删掉，换成 `ctx.configForms`（唯一注册点
 * `dsh-client-ui-settings/lib/client.js:1284 super(ctx, "configForms");`；
 * 旧契约文件 `lib/types/client/settings-scope.d.ts` 在 rc2 里根本不存在）。
 * cordis 的 inject 是**就绪保证**：声明的服务永不出现，apply 就永不被调用——
 * 结果不是"设置面板降级"，而是**三个入口全部消失**。所以跨版本的插件绝不能把
 * 某一代的服务名写死在 inject 里。
 *
 * 那为什么不干脆硬声明 `configForms`？同理：0.1.2 上没有它，硬声明等于把老内核
 * 上的入口全砍掉。两个版本都要活，只能软取 + 惰性解析（见下面 resolveScope）：
 *   - 0.2.0-rc.2：`ctx.inject(['configForms'], …)` 迟到绑定 + `get(<entry id>)`
 *   - 0.1.2：`ctx.get('settingsScope').bind({ namespace })`
 *   - 两个都没有：万能桩（面板显示"不可用"，但入口还在）
 *
 * 当年硬声明 settingsScope 的理由是"2026-09-26 面板整片不可用，因为 apply 那一刻
 * 没取到服务"——那个时序窗口现在由**惰性绑定**解决：每次访问实时解析一次，
 * 服务迟到就自然接上，绑好才缓存。所以硬声明这条腿可以撤掉了。
 *
 * connection 仍软获取：2026-09-23「入口全消失」的元凶是它（裸解构 `ctx.get('connection')`
 * 拿不到就抛 TypeError，整个 apply 中断）。取不到就降级，不连累注册。
 */
export const inject = ['slots']

export function apply(ctx) {
  // 探针：能看到这行说明依赖注入通过、apply 真的跑了
  console.log('[dsh-memory-client] apply 开始执行（依赖注入已通过）')
  /**
   * 万能降级桩（v0.12.7）：上游服务缺失时，任何属性访问、调用、构造都安全返回自身，绝不抛错。
   *
   * 为什么不手写具体空对象：2026-09-23 的教训——第一版桩只写了 getSnapshot/set/get 三个方法，
   * 结果组件用到 `scope.subscribe`（还有 unset、api.credentials、api.llm）时当场抛
   * "scope.subscribe is not a function"，整片设置面板渲染失败。漏一个方法就崩一次，
   * 所以改成"永远不会失败"的桩。
   */
  const makeStub = () => {
    const stub = new Proxy(function () {}, {
      get(_t, key) {
        if (typeof key === 'symbol') return undefined
        if (key === 'then') return undefined            // 别被当成 thenable
        if (key === 'getSnapshot') return () => ({ value: {} })   // 组件要读 .value
        if (key === 'subscribe') return () => () => {}  // 返回退订函数
        return stub
      },
      apply() { return stub },
      construct() { return stub },
    })
    return stub
  }
  /**
   * 设置读写面：跨内核惰性绑定（v0.14.0）。
   *
   * 两代运行时的服务名不同，但**对外形状相同**，所以组件一行都不用改：
   *   - 0.2.0-rc.2：`ctx.configForms.get(<profile entry id>)` → `ConfigForm`
   *     （`lib/types/client/config-form-types.d.ts`：getSnapshot / subscribe / set / unset / mutate）
   *   - 0.1.2：`ctx.get('settingsScope').bind({ namespace })` → `SettingsScopeController`
   *
   * 三个必须知道的差异：
   *   1. rc2 的 `get()` **不再接受 decode**（spec 由 get 单方面给定，走 namespace 自己的
   *      wire schema 校验）；老代码里的 `decode` 在 rc2 没有对应物，传了也是白传。
   *   2. rc2 的 namespace 语义变成了 profile **entry id**（即 `cordis.patch.yml` 里的
   *      `- id: memory`），不是包名。我们随包发的那份 patch 就用 `id: memory`，
   *      与宿主侧 `lib/compat.js` 的 SETTINGS_ENTRY_ID 对齐。
   *   3. rc2 的 set/unset 返回 `Promise<boolean>`（老版是 void）；组件不接返回值，无影响。
   *
   * 解析时机：**每次访问属性时实时解析一次，绑好才缓存**（v0.12.9 的老修法，继续沿用）。
   * 服务迟到 → 打开面板时自然接上；服务根本不存在 → 退回桩（功能降级，而不是崩）。
   */
  const boundScopes = new Map()
  const stubScopes = new Map()
  let scopeWarned = false
  let configForms = null
  // 迟到绑定：rc2 上这个回调会触发；0.1.2 上 configForms 永远不出现、回调不触发，
  // 于是自然走老通道。用**嵌套** inject 而不是写进模块级 inject——见文件顶部说明。
  try {
    ctx.inject(['configForms'], (cfCtx) => {
      configForms = cfCtx.configForms ?? null
      if (configForms) console.log('[dsh-memory-client] configForms 服务已就绪（0.2.0-rc.2 设置通道）')
    })
  } catch (err) {
    console.warn('[dsh-memory-client] configForms 注入失败（将退回老通道）: ' + (err?.message ?? err))
  }
  const stubFor = (ns) => {
    if (!stubScopes.has(ns)) stubScopes.set(ns, makeStub())
    return stubScopes.get(ns)
  }
  /**
   * 解析某个设置面的读写句柄。
   * @param {string} ns 0.1.x 的 namespace（也是候选 entry id 的第一个）
   * @param {string[]} ids rc2 的候选 profile entry id（按优先级）
   */
  const resolveScope = (ns, ids) => {
    if (boundScopes.has(ns)) return boundScopes.get(ns)
    // 通道 1（0.2.0-rc.2）：configForms.get(entryId)
    let cf = configForms
    if (!cf) {
      try { cf = ctx.get('configForms') } catch { cf = null }
    }
    if (cf && typeof cf.get === 'function') {
      // 为什么要试多个 id：随包发的 cordis.patch.yml 用 `id: memory`，而**老的手工挂载**
      // （README 早期版本教的那种）用 `id: dsh-memory`。用户从手工挂载迁过来、又没删旧行时，
      // 我们的 bundle 行会自动退位、插件由旧行挂载 —— 此时 entry id 就是 dsh-memory。
      // 两个都试一遍，谁的状态是 ready 就用谁（见下面"为什么不能只看 loading"）。
      let pending = null
      for (const id of ids) {
        try {
          const form = cf.get(id)
          if (!form || typeof form.getSnapshot !== 'function') continue
          let status
          try { status = form.getSnapshot()?.status } catch { status = undefined }
          if (status === 'ready') {
            boundScopes.set(ns, form)
            return form
          }
          // 镜子里还没加载完（loading）时先用着，但**不缓存**：
          // 缓存了就会把"还没加载完"钉成"就是它"，而它随后可能变成 unavailable，
          // 于是明明有另一个可用 id 也永远轮不到。下次访问继续找 ready。
          if (status !== 'unavailable' && !pending) pending = form
        } catch (err) {
          if (!scopeWarned) {
            scopeWarned = true
            console.warn(`[dsh-memory-client] configForms.get("${id}") 失败: ` + (err?.message ?? err))
          }
        }
      }
      if (pending) return pending
    }
    // 通道 2（0.1.2）：settingsScope.bind({ namespace })
    let real
    try {
      real = ctx.get('settingsScope')
    } catch (err) {
      real = undefined
      if (!scopeWarned) {
        scopeWarned = true
        console.warn('[dsh-memory-client] 取 settingsScope 失败: ' + (err?.message ?? err))
      }
    }
    if (!real || typeof real.bind !== 'function') return null   // 尚未就绪：不缓存，下次访问再试（自愈的来源）
    try {
      const bound = real.bind({ namespace: ns })
      boundScopes.set(ns, bound)
      return bound
    } catch (err) {
      if (!scopeWarned) {
        scopeWarned = true
        console.warn('[dsh-memory-client] settingsScope.bind 失败（配置读写退化）: ' + (err?.message ?? err))
      }
      return null
    }
  }
  const lazyScope = (ns, ids = [ns]) => new Proxy({}, {
    get(_t, key) {
      if (typeof key === 'symbol') return undefined
      if (key === 'then') return undefined                  // 别被当成 thenable
      if (key === '__dshBound') return !!resolveScope(ns, ids)   // 供设置面板就地诊断「服务连上没有」
      const bound = resolveScope(ns, ids) ?? stubFor(ns)
      const v = bound[key]
      // 方法必须绑回 bound 本身：组件写的是 scope.getSnapshot()，
      // 只返回函数引用会脱开 this 调用。
      return typeof v === 'function' ? v.bind(bound) : v
    },
  })
  // entry id（rc2）/ namespace（0.1.2）：本插件主设置面的两种叫法。
  // 'memory' 与宿主侧 lib/compat.js 的 SETTINGS_ENTRY_ID、以及随包 cordis.patch.yml 的
  // `- id: memory` 三处对齐；'dsh-memory' 是**老的手工挂载**时期的 entry id（历史 README
  // 教的写法），留作兜底候选 —— 用户没删旧挂载行时，插件就是那个 id 挂的。
  const ENTRY_ID = 'memory'
  const ENTRY_ID_ALIASES = ['memory', 'dsh-memory']
  const scope = lazyScope(ENTRY_ID, ENTRY_ID_ALIASES)
  const llmScope = lazyScope('llm-pi-ai')        // 两代同名；该代没有这个 entry 时退化为"不可用"
  const deepseekScope = lazyScope('llm-deepseek')
  let channelLabel
  try {
    if (configForms) channelLabel = `configForms（0.2.0-rc.2，entry id: ${ENTRY_ID}）`
    else if (ctx.get('settingsScope')) channelLabel = `settingsScope（0.1.x，namespace: ${ENTRY_ID}）`
    else channelLabel = '两代设置服务都未就绪 → 惰性等待（打开面板时再解析）'
  } catch (err) {
    channelLabel = '探测失败: ' + (err?.message ?? err)
  }
  console.log('[dsh-memory-client] 设置通道：' + channelLabel)
  // v0.12.7 加固：以前这里是裸解构 `const { api } = ctx.get('connection')`——
  // 一旦 connection 服务取不到就抛 TypeError，**整个 apply 当场中断，三个入口一个都注册不上**
  // （2026-09-23 实测的故障形态正是"入口全消失、服务端却一切正常"）。现在取不到就降级，不再连累注册。
  let api
  try {
    const conn = ctx.get('connection')
    api = conn?.api ?? makeStub()   // 取不到就用万能桩：api.credentials / api.llm 访问不会崩
    console.log('[dsh-memory-client] connection 服务：' + (conn ? (api ? '可用' : '存在但无 api') : '不可用'))
  } catch (err) {
    console.warn('[dsh-memory-client] 取 connection 失败（图谱面板的实时接口将退化）: ' + (err?.message ?? err))
  }
  console.log('[dsh-memory-client] scope 就绪，开始注册三个入口')
  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'memory',
      order: 25,
      label: () => '记忆',
      inject: () => ({ scope, api, llmScope, deepseekScope }),
    }, MemorySettingsSection))
    console.log('[dsh-memory-client] ✅ settings.section 注册成功（设置里的「记忆」入口）')
  } catch (err) {
    console.error('[dsh-memory-client] ❌ settings.section 注册失败: ' + (err?.message ?? err))
  }
  // 记忆图谱：主界面可收起侧边栏的底部入口（sidebar.footer.action，与任务看板同槽）
  try {
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'memory-graph',
      order: 10,
      inject: () => ({ scope }),
    }, MemoryGraphLauncher))
    console.log('[dsh-memory-client] ✅ 侧边栏「记忆图谱」入口注册成功')
  } catch (err) {
    console.error('[dsh-memory-client] ❌ 侧边栏图谱入口注册失败: ' + (err?.message ?? err))
  }
  // v0.12.8：日志不再单独占侧边栏入口，已并入记忆图谱面板的「日志」标签页
  console.log('[dsh-memory-client] 日志已并入图谱面板（不再单独注册入口）')
  console.log('[dsh-memory-client] apply 执行完毕')
}
