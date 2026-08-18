/**
 * 工具域：时间（system_now）。原 registerTools 拆分（v0.10 解耦）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatNow } from '../util.js'
import { makeSafeRegister } from './shared.js'

export function registerTimeTools(ctx, store, getCfg) {
  const safeRegister = makeSafeRegister(ctx)
  safeRegister(defineTool({
    name: 'system_now',
    description: '获取当前系统时间（本地时间 + ISO + Unix 毫秒 + 星期 + 时区）。需要知道"现在几点/今天几号"时调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          iso: { type: 'string', required: true },
          unix: { type: 'integer', required: true },
          local: { type: 'string', required: true },
          date: { type: 'string', required: true },
          time: { type: 'string', required: true },
          weekday: { type: 'string', required: true },
          tz: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `当前时间：${value.local} ${value.weekday}（${value.tz}）`,
      }],
    },
    execute() {
      return formatNow()
    },
  }))
}
