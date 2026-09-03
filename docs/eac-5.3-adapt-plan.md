# dsh-memory × EAC 5.3.6 更新适配计划

> 状态：**已执行完毕（2026-08-31 提交 4ae0f24，v0.9.21）**，待重启 EAC 做运行期验证。
> 范围：让 dsh-memory（当前 v0.9.19/v0.9.20）在最新 EAC 桌面端（web-desktop profile）完整恢复并稳定运行。
> 执行结果摘要：挂载已恢复（cordis.patch.yml）；`lib/settings-expose.js` 已删除；client 注入清单 5→3 包；settings.jsx 供应商目录改由 llm-pi-ai + llm-deepseek 命名空间推导；write.js 轮次号兜底；refiner.provider 迁移 deepseek-official；11 套测试全绿；两副本已同步（md5 一致）；settings.yaml 与 agent-default-model 供应商已迁移。

## 一、现状诊断（已核实的事实）

### 1.1 环境
| 项 | 值 |
|---|---|
| EAC 桌面客户端 | v5.3.6（2026-09-03 更新，`dsh-desktop` 目录） |
| 内核 dsh | `@deepseek-ai/dsh@0.1.2-alpha.1`（kernel tgz 同版本） |
| cordis | **4.0.1**（dsh-memory 曾在 cordis 3.x 上开发/运行） |
| dsh-llm / dsh-settings / dsh-tools | 均为 0.1.2-alpha.1 |
| Node | v24.19.0（EAC 内置 vendor/node） |
| EAC 实际 profile | `~/.dsh/profiles/web-desktop`（`~/.dsh/profiles/web` 为旧 web 副本） |
| 插件部署副本 | `~/.dsh/profiles/web-desktop/node_modules/dsh-memory`（v0.9.19，lib 三文件 md5 与工作区一致） |
| sqlite-vec | 已随副本部署（sqlite-vec + sqlite-vec-windows-x64 嵌套 node_modules），Node 24 可加载 |
| 数据 | `~/.dsh/memory.db`（27MB + WAL）完好，无需迁移 |

### 1.2 EAC 5.3.x 新插件体系（与旧版的关键差异）
- 引入**扩展注册表** `~/.dsh/extensions/registry.json`（schema v1）：每个插件有档案（kind/risk/source/state/enabled/crashStreak/…）。
- 引入**插件保护中心**（plugin-guard：快照/回滚/事故/体检）+ **Supervisor 状态机**（installed→running→retrying→quarantined）+ **Extension SDK V1**（isolated 子进程插件，新格式）。
- 插件分两轨：**isolated（SDK V1，独立进程）** 与 **legacy（cordis in-core 注入）**。dsh-memory 当前登记为 `market / legacy-cordis / legacy / enabled=true / crashStreak=0`（风险标签为 legacy-cordis，仍受 guard 保护）。
- legacy 插件继续走 Core（cordis profile）注入——**Extension Host 明确跳过非 isolated 插件**（manager.js: "Legacy 走 Core 注入"）。

### 1.3 ⚠️ 关键问题：当前 EAC 未加载 dsh-memory
- `web-desktop/cordis.patch.yml` 于 **2026-09-03 21:34 被重写**（EAC 5.3.6 更新后），dsh-memory 的 `insert` 条目被移除（9 月 1 日备份 `cordis.patch.yml.bak-dvr-20260901-195809` 中仍存在完整条目，含 `enabled: true / injectMaxTokens: 800 / injectMinScore: 0.02 / stepInterval: 2 / maxVersionsPerMemory: 8 / features(graph: false)` —— graph 以 settings.yaml 用户层 `graph: true` 为准）。
- 但 registry.json 中 dsh-memory 仍 `enabled: true` → **登记与挂载状态不一致**。
- memory.db 日志证实：写入/注入活动止于 9 月 2~3 日更新前后，之后无新沉淀；当前 EAC 重启后插件将不会加载。

### 1.4 API 兼容性逐项核对（dsh-memory 使用面 → 内核 0.1.2-alpha.1）
| 使用面 | 结论 |
|---|---|
| `ctx.on / ctx.inject / ctx.provide / ctx.effect / dispose` | ✅ cordis 4.0.1 保留（Events/Registry/Reflect 服务混入 ctx） |
| 事件 `agent/pre-step`、`agent/session-start`、`session/event`（含 turn/end） | ✅ 事件名与 payload 存在；**注意** `agent/pre-step` 现为 waterfall（`next()` 返回 `PreStepDecision`，可 reject/replace messages）——现有实现所有路径 `return next()`，需按新契约复核 |
| `createUserMessage`（@deepseek-ai/dsh-llm） | ✅ 保留 |
| `ctx.llm.stream({provider, model, messages, system, maxTokens})` | ✅ `stream(options: GenerateOptions)` 保留，静态签名吻合 |
| `ctx.settings.register(settingsNamespace('memory'), Config, {base, applies})` | ✅ dsh-settings 签名一致 |
| `ctx.webServer.register({kind:'exact'\|'prefix', path, handler})` | ✅ dsh-host-webserver 签名一致（route 注册/dispose） |
| `ctx.workspaceRegistry` | ✅ dsh-workspace 提供 |
| `ctx.tools.register(defineTool({name,description,parameters,output,execute}))` | ✅ dsh-tools 0.1.2 `DefineToolOptions` 形状一致（execute 第二参为 `ToolRunContext`，`exec.agent` 待运行期确认） |
| `session/event` data 字段（`data.source.kind/turn/message`） | ⚠️ 与新版 SessionEvent 结构基本吻合，运行期验证 |
| `settings-expose.js` 的 apiproxy 白名单 self-heal | ❌ **目标包 `dsh-host-apiproxy` 已不在 0.1.2-alpha.1 内核**（新内核为 dsh-api-gateway / dsh-api-settings-controller / dsh-client-ui-settings）。该 hack 当前静默失效；需确认新内核下第三方命名空间在 GUI 的暴露机制 |
| client 注入 `dsh.client.inject` 5 包（client-connection/client-runtime/client-ui-settings/api-remotes/client-ui-slots） | ⚠️ 包都存在，但 dsh-api-remotes 0.1.2 已变为 host BFF 包；client/index.jsx 的 `slots.inject('settings.section'/'sidebar.footer.action')` + `settingsScope.bind` + `connection` 用法需在真实 Web UI 验证 |
| `dsh.client.platform: 'web'` | ✅ 与 EAC 配套插件（soul-md/web-mobile-fix/picturereader）一致，不用改 |
| peerDependencies `>=0.1.0` | ⚠️ 与 `0.1.2-alpha.1` 的 semver pre-release 边界可能被宿主兼容性校验拒绝，视 EAC 行为调整（建议 `^0.1.2-alpha.1` 或参照 EAC 校验规则） |

## 二、适配需求与改动清单

### P0 — 恢复挂载（不改代码）
1. `web-desktop/cordis.patch.yml` 补回 dsh-memory `insert` 条目（以 09-01 备份为基准；config 只放稳定默认，运行时以 settings.yaml 用户层为准）。
2. 核对 registry.json 状态一致（enabled、source=market、kind=legacy 保留）。
3. 之后插件才会被 cordis 加载——**所有后续验证都以此为前置**。

### P1 — 后端代码适配（lib/）
1. **agent/pre-step 新契约复核**（`lib/pipelines/inject.js`）：
   - 确认不注入路径 `return next()` 即“保留当前 messages”的语义；出错路径不吞异常导致 waterfall 悬挂。
   - 评估是否利用新能力（如 payload.signal 取消、替换 messages）增强注入（可选，默认零行为改动）。
2. **session/event payload 核对**（`lib/pipelines/write.js`）：user/message、assistant/message、turn/end 的 data 字段与新版 SessionEvent 对照，必要时调整取值路径；运行期日志验证 turn/end 沉淀。
3. **settings 命名空间暴露**（`lib/settings-expose.js`）：
   - 先验证新内核 GUI 设置面板是否自动展示所有已注册命名空间（dsh-api-settings-controller / dsh-client-ui-settings 机制）。
   - 若自动暴露 → 删除/禁用失效 hack；若仍需声明 → 改写到新内核的等效机制（或保留自愈但更名不报错）。
4. **peerDependencies 声明**：评估 EAC 兼容性校验行为后调整版本区间；同时核对 `package.json` 其它元数据（`dsh.client.inject` 列表按需精简）。
5. **工具/LLM 面运行期验证**：`defineTool.execute(args, exec)` 的 `exec.agent`/`exec.workspaceRegistry` 字段存在性；`ctx.llm.stream` 产出的 chunk 形状（text-delta）。

### P2 — 客户端（client/）适配
1. `client/index.jsx`：验证 `slots.inject('settings.section')` / `'sidebar.footer.action'` 在新 Web UI 的插槽名与注册形态；`settingsScope.bind({namespace})`、`ctx.get('connection').api` 可用性。
2. settings.jsx / graph.jsx / logs.jsx：依赖 `/dsh-memory/graph`、`/dsh-memory/logs` API 与 `memory` 命名空间读写的部分，验证 Web 端 API 路径与新版网络层（connection）兼容。
3. 重建 `lib/client.js`（`node build-client.mjs`）并同步副本。
4. `dsh.client.inject` 列表按实际加载行为精简（尤其 dsh-api-remotes 的归属变化）。

### P3 — 新插件体系的适配姿态（决策：保持 legacy，不迁 SDK V1）
- **不迁移** Extension SDK V1 的原因：SDK 面只有 registerTool / on（只读事件）/ provideContext / 私有 settings / 权限门，**无 agent hooks（pre-step/session-start）、无 webServer、无 workspaceRegistry、无 ctx.llm 服务、无 ctx.memory seam**——dsh-memory 的核心能力（自动注入、预热、Web GUI、refiner、图谱 API）全部依赖这些面，迁移即功能腰斩。
- 保持 legacy 轨的运行纪律：任何异常不得抛出到 cordis 层（现有“防崩溃原则”继续执行），避免 supervisor 计 crashStreak/隔离；启动不 crash 是硬指标。
- 可选：向 registry 条目补充元数据（packageSha256、permissions 空表）以消除档案缺口。
- 关注 guard 对 legacy 插件的快照/回滚不影响插件本体（guard 只动声明性配置）。

### P4 — 文档与沉淀
1. README「必要前置：settings 命名空间白名单」段落改写为面向 0.1.2-alpha.1 的说明（apiproxy hack 已过时）。
2. CHANGELOG 记录 v0.9.21「EAC 5.3.6 适配」。
3. 适配完成后沉淀 lesson/decision 入记忆库（用户偏好：结论入长期语义层）。

## 三、验证与部署流程

### 3.1 测试
- 后端改动后跑全量套件（README §测试 12 个文件：test / phase2 / phase3 / embedder / housekeeping / events / incremental / update-append / edge-types / keyword-filter / profile / crash-safety / record）。
- 关键回归：`node test-crash-safety.mjs`（防崩溃原则在本环境的直接回归）。

### 3.2 构建与同步
- 改 `client/*.jsx` → `node build-client.mjs` 重建 `lib/client.js`（bundle 勿手改）。
- 同步部署副本（`web-desktop/node_modules/dsh-memory` 为主；`web/node_modules/dsh-memory` 视用户是否仍用 web profile 决定），md5 校验 lib 文件一致。

### 3.3 挂载与重启
- 恢复 cordis.patch.yml insert → 重启 EAC 桌面端。
- 验证清单（以 memory.db 日志 + GUI 为准）：
  1. 启动日志出现 `[dsh-memory] embedder: …（init 事件入库）`；
  2. 会话开始出现 preheat、对话中出现 inject / write.refined 事件；
  3. 设置侧边栏出现「记忆」入口（P2 验证项）；
  4. 记忆图谱/记忆日志面板可打开（/dsh-memory/graph、/dsh-memory/logs 200）；
  5. 工具面可用（memory_search 等调用成功）；
  6. registry 中 crashStreak 不增长、state 保持 installed/enabled。

### 3.4 风险与回退
- 任何一步失败按 guard 快照回滚（guard 会自备份 cordis.patch.yml/package.json 等声明面）。
- 插件本体改动前先备份副本（lib_backup 目录已有先例）。

## 四、待用户确认的决策点
1. **web profile 副本**：`~/.dsh/profiles/web/node_modules/dsh-memory` 是否一并同步（若 web profile 已不再使用可只留 desktop 副本）。
2. **配置口径**：insert config 用 09-01 备份的稳定默认（features.graph 等以 settings.yaml 用户层为准，不做请求）。
3. **注入行为增强**（可选）：是否利用新 pre-step 的 reject/replace 能力做注入块替换（默认零行为改动，只做兼容）。
4. **文档交付**：计划执行完成后是否需要额外沉淀（lesson / decision / README 章节）。

## 五、执行顺序（建议）
1. P0 恢复挂载 → 重启 → 采集基线日志（确认当前是否只有挂载问题）。
2. P1 后端逐项适配 + 全量测试。
3. P2 客户端适配 + build + 同步。
4. P3 运行纪律核查（crashStreak、异常路径）。
5. P4 文档 + 记忆沉淀；回归验证清单全绿后收尾。