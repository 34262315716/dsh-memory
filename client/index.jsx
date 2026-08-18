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
import { MemoryLogLauncher } from './logs.jsx'

export const name = 'dsh-memory-client'
export const inject = ['slots', 'settingsScope', 'connection', 'remote']

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
  // 记忆日志：背后运行了什么完全透明可见（v0.9.5）
  try {
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'memory-logs',
      order: 11,
      inject: () => ({}),
    }, MemoryLogLauncher))
  } catch (err) {
    console.warn('[dsh-memory-client] 侧边栏日志入口注册失败: ' + (err?.message ?? err))
  }
}
