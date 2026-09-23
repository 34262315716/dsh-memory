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
// v0.12.7：只硬依赖 slots。settingsScope / connection 改为运行时软获取——
// 上游任何一个服务缺失时，以前是【整个插件不加载、入口全消失】，现在只是对应功能降级。
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
  // settingsScope 软获取：拿不到就用万能桩，保证三个入口照样注册（功能降级而非整体消失）
  let settingsScope
  try {
    settingsScope = ctx.get('settingsScope')
    console.log('[dsh-memory-client] settingsScope：' + (settingsScope ? '可用' : '不可用（配置读写将退化）'))
  } catch (err) {
    console.warn('[dsh-memory-client] 取 settingsScope 失败: ' + (err?.message ?? err))
  }
  const scope = settingsScope ? settingsScope.bind({ namespace: 'memory' }) : makeStub()
  const llmScope = settingsScope ? settingsScope.bind({ namespace: 'llm-pi-ai' }) : makeStub()
  const deepseekScope = settingsScope ? settingsScope.bind({ namespace: 'llm-deepseek' }) : makeStub()
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
