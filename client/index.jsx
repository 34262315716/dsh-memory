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
 * 依赖声明（v0.12.9 修正）。
 *
 * `settingsScope` **必须**写进 inject：cordis 的 inject 不只是"我用到它"的声明，
 * 它同时是**就绪保证**——声明的服务没就绪，apply 就不会被调用。所以声明了它，
 * apply 里取值必定拿得到；不声明，就只能靠 apply 的时机碰运气。
 *
 * 2026-09-26 的故障正是这个：设置面板整片「不可用（host 未注册 memory 命名空间）」，
 * 而宿主日志里一条注册失败都没有——命名空间其实好好的，是客户端在 apply 的那一刻
 * 没取到 settingsScope，被降级桩接手了。
 *
 * 对照实测：profile 里所有能正常显示设置项的插件（picturereader / computer-user /
 * dsh-soul-md）都声明了 `["slots","locale","settingsScope"]`，只有本插件只声明 slots。
 * 照抄能用的写法——这是唯一的差异项。
 *
 * 那 connection 为什么保持软获取？因为 2026-09-23「入口全消失」的元凶是它：
 * 裸解构 `ctx.get('connection')` 拿不到就抛 TypeError，整个 apply 中断。那次修复
 * 顺手把 settingsScope 也改软了——**修对了病、误伤了邻居**。现在各归各位：
 * settingsScope 硬声明（保证设置面板可用），connection 仍软获取（保证入口不消失）。
 */
export const inject = ['slots', 'settingsScope']

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
   * settingsScope：惰性绑定（v0.12.9）。
   *
   * 2026-09-26 故障：设置面板「记忆」整片显示「不可用（host 未注册 memory 命名空间）」，
   * 但宿主日志里**一条注册失败都没有**——命名空间其实注册成功了，是客户端拿错了东西。
   *
   * 机制：apply 执行的那一刻 settingsScope 未必就绪（它由 dsh-client-ui-settings 提供，
   * 与 slots 不是同一个提供方）。旧写法在 apply 里**一次性取值**，取到 undefined 就被
   * 万能桩永久接管；而桩的 subscribe 是空函数 → 镜子（mirror）加载完也通知不到组件 →
   * 面板永远停在「不可用」。**时序错一次，就永久错**。
   *
   * 修法：不在 apply 时取值，改成**每次访问属性时实时解析一次**，绑好即缓存。
   * 服务迟到 → 打开面板时自然接上；服务根本不存在 → 退回桩（功能降级，而不是崩）。
   *
   * 为什么不直接把 settingsScope 写回 inject：v0.12.7 的实测教训——硬依赖一旦在某环境
   * 缺失，整个插件不加载、三个入口全消失，比「面板降级」更糟。这里两个都要：
   * **不声明硬依赖（入口永不消失）+ 不在 apply 时取值（不再被时序打脸）**。
   */
  const boundScopes = new Map()
  const stubScopes = new Map()
  let scopeWarned = false
  const stubFor = (ns) => {
    if (!stubScopes.has(ns)) stubScopes.set(ns, makeStub())
    return stubScopes.get(ns)
  }
  const resolveScope = (ns) => {
    if (boundScopes.has(ns)) return boundScopes.get(ns)
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
    if (!real) return null          // 尚未就绪：不缓存，下次访问再试（自愈的来源）
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
  const lazyScope = (ns) => new Proxy({}, {
    get(_t, key) {
      if (typeof key === 'symbol') return undefined
      if (key === 'then') return undefined                  // 别被当成 thenable
      if (key === '__dshBound') return !!resolveScope(ns)   // 供设置面板就地诊断「服务连上没有」
      const bound = resolveScope(ns) ?? stubFor(ns)
      const v = bound[key]
      // 方法必须绑回 bound 本身：组件写的是 scope.getSnapshot()，
      // 只返回函数引用会脱开 this 调用。
      return typeof v === 'function' ? v.bind(bound) : v
    },
  })
  const scope = lazyScope('memory')
  const llmScope = lazyScope('llm-pi-ai')
  const deepseekScope = lazyScope('llm-deepseek')
  try {
    console.log('[dsh-memory-client] settingsScope：'
      + (ctx.get('settingsScope') ? '此刻已就绪' : '此刻未就绪 → 转惰性等待（打开面板时再解析）'))
  } catch (err) {
    console.warn('[dsh-memory-client] 探测 settingsScope 失败: ' + (err?.message ?? err))
  }
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
