/**
 * 设置命名空间白名单自愈补丁（v0.9.20 新增，机制对齐 DSH 官方插件 soul-md/picturereader 的 dsh-settings-expose）。
 *
 * 背景：DSH 的 Web 设置客户端对第三方插件命名空间有 apiproxy 白名单
 * （WEB_SETTINGS_NAMESPACES）——不在名单里的命名空间，设置侧边栏的对应
 * section 不会出现（settings-not-exposed）。上游显式拒绝了"插件自行声明暴露"
 * （注释标注 deferred work），README 的旧做法是升级 DSH 后手动改宿主文件；
 * 本模块改为幂等自动补丁：插件启动时把 `memory` 写进名单（已存在则跳过），
 * DSH 升级覆盖文件后，下次插件启动自动补回。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'

/**
 * 确保记忆命名空间在 WEB_SETTINGS_NAMESPACES 白名单里（幂等；失败仅警告，不影响主流程）。
 * @param {object} _ctx 插件上下文（soul-md 签名保留，未使用）
 * @param {string} nsName 命名空间短名（本插件 'memory'）
 * @param {{warn?: Function, info?: Function}} logger 日志器（console 即可）
 */
export function ensureSettingsNamespaceExposed(_ctx, nsName, logger) {
  try {
    const target = findApiproxyIndex()
    if (!target) {
      logger?.warn?.(`[dsh-memory] 未定位到 dsh-host-apiproxy——如需 Web 设置面板，请手动把 "${nsName}" 加入宿主 WEB_SETTINGS_NAMESPACES（见 README「必要前置」）`)
      return
    }
    let src
    try {
      src = readFileSync(target, 'utf8')
    } catch (error) {
      logger?.warn?.(`[dsh-memory] 无法读取 apiproxy 白名单 ${target}: ${String(error)}`)
      return
    }
    const body = src.match(/const WEB_SETTINGS_NAMESPACES = \[([\s\S]*?)\];/)?.[1] ?? ''
    if (body.includes(`"${nsName}"`)) return // 已在名单（手动加过或之前补过）
    const patched = src.replace(/(const WEB_SETTINGS_NAMESPACES = \[[\s\S]*?)(\n\s*\];)/, (_match, pre, post) => {
      const trailingComma = /,\s*$/.test(pre) ? '' : ','
      const sep2 = pre.trimEnd().endsWith('[') ? '' : trailingComma
      return `${pre}${sep2}\n\t"${nsName}"${post}`
    })
    if (patched === src) {
      logger?.warn?.(`[dsh-memory] 白名单模式未匹配 ${target}——请手动添加（README「必要前置」）`)
      return
    }
    writeFileSync(target, patched, 'utf8')
    logger?.info?.(`[dsh-memory] 已将 "${nsName}" 加入 WEB_SETTINGS_NAMESPACES（${target}）——重启 dsh web 后设置面板出现`)
  } catch (error) {
    logger?.warn?.(`[dsh-memory] 设置白名单自愈失败: ${String(error)}`)
  }
}

/** 定位宿主实际加载的 dsh-host-apiproxy/lib/index.js（先查模块缓存，再查嵌套布局）。 */
function findApiproxyIndex() {
  try {
    const Module = createRequire(import.meta.url)('module')
    const cache = Module._cache ?? {}
    for (const key of Object.keys(cache)) {
      if (key.includes(`${sep}dsh-host-apiproxy${sep}`) && key.endsWith(`${sep}index.js`)) return key
    }
  } catch {
    /* 继续走兜底路径 */
  }
  try {
    const require = createRequire(import.meta.url)
    const settingsEntry = require.resolve('@deepseek-ai/dsh-settings')
    const candidate = join(dirname(dirname(dirname(settingsEntry))), 'dsh-host-apiproxy', 'lib', 'index.js')
    if (existsSync(candidate)) return candidate
  } catch {
    /* 兜底也失败 → 返回空 */
  }
  return ''
}