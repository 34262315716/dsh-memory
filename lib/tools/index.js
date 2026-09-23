/**
 * 工具注册总入口（原 registerTools，v0.10 拆分为分域注册器）。
 * 逐域注册：任一域失败不影响其他（防崩溃原则）。
 */
import { registerTimeTools } from './time.js'
import { registerMemoryTools } from './memory.js'
import { registerHousekeepingTools } from './housekeeping.js'
import { registerGraphTools } from './graph.js'
import { registerRewriteTools } from './rewrite.js'

export function registerTools(ctx, store, getCfg) {
  registerTimeTools(ctx, store, getCfg)
  registerMemoryTools(ctx, store, getCfg)
  registerHousekeepingTools(ctx, store, getCfg)
  registerGraphTools(ctx, store, getCfg)
  // v0.12.6：降级记忆重写（提取瘫痪期间的「任务/结果」产物救回来）
  registerRewriteTools(ctx, store, getCfg)
}
