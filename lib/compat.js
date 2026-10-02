/**
 * dsh-memory — 内核跨版本兼容层（0.1.2 ↔ 0.2.0-rc.2）
 *
 * 为什么需要这一层：本插件最初按 0.1.2 内核写成，用到三处随内核演进消失的 API。
 * 顺序即严重度：
 *
 *   ① `@deepseek-ai/dsh-settings` 的命名导出 `settingsNamespace`
 *      —— **致命**。它被 0.1.2-alpha.1 删除。缺失的"命名导出"不是"缺失的服务"：
 *      `ctx.inject` 会安静降级，而 ESM 命名导入解析不到是**模块求值期 SyntaxError**，
 *      cordis loader 记为 entry 加载失败，**宿主直接 exit 1**。
 *      真实报错原文见 dshmarket/lib/settings.js:43-68
 *      （`SyntaxError: The requested module '@deepseek-ai/dsh-settings'
 *        does not provide an export named 'installSettingsSection'`）。
 *      ⇒ 本文件**绝不静态导入该包的命名导出**；只能用动态 import + 特性探测。
 *
 *   ② `ctx.settings.register(ns, Schema, opts)`
 *      —— 0.1.7（#677）起 `SettingsService` 改为 `describe/update/mutate`，
 *      命名空间不再"注册"，而是**由插件导出的 `Config` schema 推导**：
 *      系统枚举活着的 Loader entry → 取 `entry.fiber.runtime.Config` →
 *      只投影带 `meta.volatile` 的字段成表单。`ns` 参数也换了含义：
 *      从"命名空间字符串"变成 **profile entry id**。
 *
 *   ③ 会话预热事件 `agent/session-start`
 *      —— 0.2.0-rc.2 的事件表里没有它（只有 `agent/created`）。见 pipelines/inject.js。
 *
 * 设计原则：**按能力探测，不按版本号比较**。
 * 版本字符串要从外部来源拿（易错，且 alpha/rc 的排序规则麻烦）；
 * 能力探测直接问运行时"你会不会"。探测不到一律回落到 0.1.2 老路径，
 * 保证老内核上的行为与本层引入前**逐字节一致**。
 */

/** 本包名。必须与 profile patch 里那条 entry 的 `name` 相同。 */
export const PACKAGE_NAME = 'dsh-memory'

/**
 * 本插件设置对应的 profile entry id。
 * 0.2.x 的 `ctx.settings.update(ns, …)` 与客户端的 `configForms.get(ns)` 都要它，
 * 而它们都只认 entry id（不是包名、也不是命名空间字符串）。
 * 仓库自带的 cordis.patch.yml 就按这个 id 声明，因此约定即事实；
 * 若用户用了别的 id，`ownEntryId()` 会自己找出来（见下）。
 */
export const SETTINGS_ENTRY_ID = 'memory'

/* ============================================================
 * 一、cosmokit Volatile 引用
 * ============================================================ */

/**
 * 宽松识别 cosmokit 的 `Volatile` 引用（不依赖 `@deepseek-ai/cosmokit` —— 本插件不声明该依赖）。
 * 判据：同时具备 get/set 且没有自有可枚举属性（Volatile 的值藏在闭包里，
 * `JSON.stringify` 出来是 `{}`，实测见 _probe-volatile.mjs）。
 * @param {unknown} value 待判定的值
 * @returns {boolean} 是否像一个 Volatile 引用
 */
export function isVolatileLike(value) {
  if (typeof value !== 'object' || value === null) return false
  if (typeof value.get !== 'function' || typeof value.set !== 'function') return false
  return Object.keys(value).length === 0
}

/** 纵深上限：配置树就三五层，超过即视为异常数据，不再往里走。 */
const MAX_DEPTH = 6

/**
 * 判断子树里有没有 Volatile 引用（只读扫描，不分配对象）。
 * @param {unknown} value 子树根
 * @param {number} depth 当前深度
 * @returns {boolean} 是否含 Volatile
 */
function containsVolatile(value, depth) {
  if (depth > MAX_DEPTH || typeof value !== 'object' || value === null) return false
  if (isVolatileLike(value)) return true
  if (Array.isArray(value)) return value.some((item) => containsVolatile(item, depth + 1))
  for (const key of Object.keys(value)) {
    if (containsVolatile(value[key], depth + 1)) return true
  }
  return false
}

/**
 * 把配置树里的 Volatile 引用换成它们的当前值。
 *
 * 为什么需要：`.volatile()` 字段在解析后不是普通值而是 cosmokit `Volatile` 引用
 * （实测：`parsed.pace === 'lazy'` 为 **false**，必须 `parsed.pace.get()`）。
 * 本插件的配置读取散落在各处、直接比较字符串，所以读取出口必须先解包一次。
 *
 * 快路径：子树里没有 Volatile 时**原样返回同一个对象**，不重建 —— 老内核
 * （schema 没有 `.volatile()`）上本函数等于恒等函数，零开销、零行为变化。
 *
 * @param {unknown} value 待解包的配置
 * @param {number} [depth] 内部递归深度
 * @returns {unknown} 解包后的配置（可能与入参同一对象）
 */
export function plainConfig(value, depth = 0) {
  if (depth > MAX_DEPTH || typeof value !== 'object' || value === null) return value
  if (isVolatileLike(value)) return plainConfig(value.get(), depth + 1)
  if (!containsVolatile(value, depth)) return value
  if (Array.isArray(value)) return value.map((item) => plainConfig(item, depth + 1))
  const out = {}
  for (const key of Object.keys(value)) out[key] = plainConfig(value[key], depth + 1)
  return out
}

/**
 * 防御性地调用 `.volatile()`。
 *
 * 两种流派二选一（不可混用，混用会抛
 * `volatile fields require a fixed object path without an enclosing volatile field`）：
 * 逐字段标，或整表标。本插件选**整表**：读取出口只调一次 `.get()` 就是全plain 配置。
 *
 * 老版 schemastery 若没有 `.volatile()`，原样返回 —— 即"老内核上不启用该特性"，
 * 这正是用户要的"加上判断，在别的版本上不冲突"。
 *
 * @param {unknown} schema schemastery schema
 * @returns {unknown} 标记了 volatile 的 schema，或原 schema
 */
export function volatileTable(schema) {
  const fn = schema?.volatile
  if (typeof fn !== 'function') return schema
  try {
    return fn.call(schema)
  } catch {
    // 已经被包过一层（"volatile schema is already wrapped"）等情形：保持原样即可
    return schema
  }
}

/* ============================================================
 * 二、内核能力探测
 * ============================================================ */

/**
 * 安全地软取一个服务，永不抛。
 * @param {any} ctx cordis Context（或 scoped ctx）
 * @param {string} name 服务名
 * @returns {any} 服务实例或 undefined
 */
export function safeGet(ctx, name) {
  try {
    if (typeof ctx?.get !== 'function') return undefined
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * 探测 settings 服务的 API 世代。
 * - `'register'`：0.1.x，有 `register(ns, Schema, opts)`
 * - `'forms'`：0.1.7+ / 0.2.x，只有 `describe/update/replace/mutate`，命名空间由 Config 推导
 * - `'absent'`：本次组装没挂 settings 服务
 * @param {any} ctx cordis Context
 * @returns {'register'|'forms'|'absent'} API 世代
 */
export function settingsApiOf(ctx) {
  const service = safeGet(ctx, 'settings')
  if (service === undefined || service === null) return 'absent'
  return typeof service.register === 'function' ? 'register' : 'forms'
}

/**
 * 动态取老内核的 `settingsNamespace()` 结果。
 *
 * **必须动态 import**：静态命名导入在 0.2.0-rc.2 上会让宿主 exit 1（见文件头 ①）。
 * 动态 import 拿到的是模块命名空间对象，取不到就是 `undefined`，不会抛。
 *
 * @param {string} key 命名空间键（老内核里就是本插件写死的 'memory'）
 * @returns {Promise<string>} 老内核下是 branded 字符串；取不到时回落为 key 本身
 */
export async function legacySettingsNamespace(key) {
  try {
    const mod = await import('@deepseek-ai/dsh-settings')
    const fn = mod?.settingsNamespace
    return typeof fn === 'function' ? fn(key) : key
  } catch {
    return key
  }
}

/**
 * 找出本插件在 profile 里的那条 entry id（0.2.x 的所有 settings API 都要它）。
 *
 * 实现照抄 `dsh-better-sidebar@0.24.1/lib/index.js:4081-4094 ownEntryId()`：
 * 优先认 `entry.fiber === ctx.fiber` 那条（就是自己），
 * 退化候选取第一个未禁用的同名 entry。
 *
 * @param {any} ctx cordis Context
 * @param {string} [packageName] 要匹配的 entry `name`（= 包名）
 * @returns {string|undefined} entry id
 */
export function ownEntryId(ctx, packageName = PACKAGE_NAME) {
  try {
    const loader = safeGet(ctx, 'loader')
    if (loader === undefined || typeof loader.entries !== 'function') return undefined
    let fallback
    for (const entry of loader.entries()) {
      const id = entry?.options?.id
      if (entry?.options?.name !== packageName) continue
      if (typeof id !== 'string' || id === '') continue
      if (entry.fiber === ctx?.fiber) return id
      if (entry.disabled !== true && fallback === undefined) fallback = id
    }
    return fallback
  } catch {
    return undefined
  }
}

/* ============================================================
 * 三、统一的设置读写面
 * ============================================================ */

/**
 * 建立一个跨版本统一的设置读写面。
 *
 * 老内核（`'register'`）：调 `ctx.settings.register(ns, Config, { base, applies:'live' })`，
 * 读走返回的 scope 的 `.get()` —— 与本层引入前的代码**完全一致**。
 *
 * 新内核（`'forms'`）：**不再"注册"**（导出 Config + 一条 id 唯一的 entry 就已经注册完成）。
 * 这里只做三件新事：① 找到自己的 entry id；② 声明"本插件自带设置页"（`configure({auto:false})`）；
 * ③ 提供写入通道 `ctx.settings.update(entryId, patch, revision)`。
 *
 * @param {any} ctx cordis Context
 * @param {{packageName?: string, legacyNs?: string, Config: unknown, base: unknown}} options
 *        配置：包名、老命名空间键、Config schema、组合层 base 配置
 * @returns {Promise<{mode: string, entryId?: string, legacyNs?: string, get: () => any,
 *                    update?: (patch: object, expectedRevision?: number) => Promise<void>,
 *                    revision?: () => number|undefined}|null>} 统一设置面；不可用时返回 null
 */
export async function createSettingsFace(ctx, options) {
  const { packageName = PACKAGE_NAME, legacyNs = SETTINGS_ENTRY_ID, Config, base } = options ?? {}
  const api = settingsApiOf(ctx)

  if (api === 'absent') return null

  if (api === 'register') {
    try {
      const ns = await legacySettingsNamespace(legacyNs)
      const scope = ctx.settings.register(ns, Config, { base, applies: 'live' })
      return {
        mode: 'register',
        legacyNs,
        get: () => (scope && typeof scope.get === 'function' ? scope.get() : base),
      }
    } catch (err) {
      console.warn(`[dsh-memory] settings 注册失败，用组合层配置兜底: ${err.message}`)
      return null
    }
  }

  // ---- forms 世代 ----
  const entryId = ownEntryId(ctx, packageName)
  const service = ctx.settings
  if (entryId !== undefined && entryId !== legacyNs) {
    console.warn(
      `[dsh-memory] profile entry id 是 "${entryId}"，而插件内置的设置键是 "${legacyNs}"；` +
        `客户端的设置页会按 "${legacyNs}" 取表单。建议把 cordis.patch.yml 里那条 entry 的 id 写成 "${legacyNs}"。`,
    )
  }
  try {
    // 自带设置页（lib/client.js 注册 settings.section）→ 不让内核自动生成页
    if (typeof service.configure === 'function') {
      ctx.effect(
        () => service.configure({ auto: false }, ctx.fiber),
        'dsh-memory: settings page policy',
      )
    }
  } catch (err) {
    console.warn(`[dsh-memory] settings.configure 失败（不影响配置读取）: ${err.message}`)
  }

  const describeOwn = () => {
    try {
      const list = service.describe?.({ redactSecrets: true }) ?? []
      return list.find((item) => item.ns === entryId)
    } catch {
      return undefined
    }
  }

  return {
    mode: 'forms',
    entryId,
    legacyNs,
    /**
     * 读生效配置。优先用内核给的投影（describe() 已经解过 Volatile）；
     * 拿不到时返回 undefined，由调用方回落到 `config.get()`。
     */
    get: () => describeOwn()?.value,
    update:
      entryId === undefined
        ? undefined
        : (patch, expectedRevision) => service.update(entryId, patch, expectedRevision),
    revision: () => describeOwn()?.revision,
  }
}
