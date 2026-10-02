/**
 * Web 路由信任围栏（v0.14.0 新增）。
 *
 * 背景（0.2.0-rc.2 上实测的框架契约）：DSH 的 WebServer 路由**不继承** Connection 的认证体系。
 * `@nanmicoder/dsh-agent-teams/lib/web-routes.js:61` 的头注释就是原话——
 *   "Raw WebServer routes do not inherit Connection's authentication fence."
 * 框架既不鉴权也不替插件发 CORS：跨站请求会被浏览器拦掉"读响应"，但**请求本身照样执行**。
 *
 * 对本插件这意味着：任何能触达端口的页面，都能让 `/dsh-memory/health?llm=1` 真发一次模型请求
 * （要花钱），或者把整个记忆图谱 / 运行日志读走。这三个端点原先谁都能调。
 *
 * 所以这里按生态既定做法加一道围栏——逐条对齐
 * `dsh-config-manager/src/routes/kit.ts:146-167` 的 "dsh-ssh fence"：
 *   1. `socket.remoteAddress` 必须是 127.0.0.1 / ::1 / ::ffff:127.0.0.1
 *   2. `Host` 头必须是本机名字（127.0.0.1 / localhost / [::1]）
 *   3. `sec-fetch-site` 不能是 cross-site（现代浏览器的跨站标记；DNS rebinding 也吃这条）
 *   4. 带 `Origin` 时，其 host 必须与 `Host` **完全相同**（同源）
 *
 * 手机 / 局域网 / 反向代理访问怎么办：那种场景下 remoteAddress 是局域网地址，本围栏会拒。
 * 把 `features.webFence` 设成 `'off'` 即关闭（默认 `'loopback'`）。
 * 这是有意的取舍：**默认安全，需要时显式关**，而不是默认敞开。
 */

/** 所有端点共用的响应头：内容不可缓存、不可嗅探类型、不泄漏来源页。 */
export const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

/** 本机回环的三种写法（IPv4 / IPv6 / IPv4-mapped-IPv6）。 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * 请求是否来自本机回环、且是同源浏览器请求。
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  if (address !== undefined && !LOOPBACK_ADDRESSES.has(address)) return false
  // 说明：address === undefined 时（部分非 TCP/测试环境）不据此拒绝，交给下面 Host/Origin 判断。
  const host = request?.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * 在 handler 开头调用：先挂安全响应头，再判围栏。
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {object} cfg 插件配置（读 `features.webFence`）
 * @returns {boolean} true = 放行；false = 已写入 403，handler 必须直接 return
 */
export function fenceWebRoute(request, response, cfg) {
  try {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(key, value)
  } catch { /* 头已发出等异常情况：不因安全头失败而中断端点 */ }
  if ((cfg?.features?.webFence ?? 'loopback') === 'off') return true
  if (isLoopbackRequest(request)) return true
  try {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('dsh-memory: 该端点只对本机回环开放（如需局域网/反代访问，把 features.webFence 设为 "off"）')
  } catch { /* 响应已发出：忽略 */ }
  return false
}
