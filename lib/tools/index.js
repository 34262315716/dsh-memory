/**
 * 工具注册总入口（原 registerTools，v0.10 拆分为分域注册器）。
 * 逐域注册：任一域失败不影响其他（防崩溃原则）。
 */
import { registerTimeTools } from './time.js'
import { registerMemoryTools } from './memory.js'
import { registerHousekeepingTools } from './housekeeping.js'
import { registerGraphTools } from './graph.js'

export function registerTools(ctx, store, getCfg) {
  registerTimeTools(ctx, store, getCfg)
  registerMemoryTools(ctx, store, getCfg)
  registerHousekeepingTools(ctx, store, getCfg)
  registerGraphTools(ctx, store, getCfg)
}
