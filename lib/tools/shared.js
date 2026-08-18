/**
 * 工具注册共享助手（原 lib/index.js registerTools 内的局部 helper，v0.10 拆分独立）。
 * 防崩溃原则：单个工具注册失败绝不影响 dsh；日志失败绝不影响工具。
 */

/**
 * 单工具注册隔离（safeRegister）：schema 非法只跳过该工具，不炸插件树。
 * @param {object} ctx 插件上下文（需已 inject 'tools'）
 * @returns {(tool: object) => boolean}
 */
export function makeSafeRegister(ctx) {
  return (tool) => {
    try {
      ctx.tools.register(tool)
      return true
    } catch (err) {
      console.warn('[dsh-memory] 工具 ' + (tool?.name ?? '(匿名)') + ' 注册失败（已跳过）: ' + err.message)
      return false
    }
  }
}

/**
 * 运行日志 helper（v0.9.5）：registerTools 时代的教训——注册器是模块级函数，
 * 不能访问 apply 局部变量，所以每个注册器自备一份（getCfg().logging 控制 + store.log）。
 */
export function makeLogStore(store, getCfg) {
  return (level, event, detail, sc) => {
    try {
      const lg = getCfg().logging ?? {}
      if (lg.enabled === false) return
      store.log(level, event, detail, sc ?? '')
    } catch { /* 日志失败不影响工具 */ }
  }
}
