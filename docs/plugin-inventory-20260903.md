# 插件状态盘点（EAC 5.3.6 / dsh web-desktop profile）

盘点时间：2026-09-03；运行内核：dsh 0.1.2-alpha.1（dsh-desktop 树，`node.exe` 进程确认）+ cordis 4.0.1。
数据源：`~/.dsh/extensions/registry.json`（85 项）+ `profiles/web-desktop/cordis.patch.yml` + `profiles/web-desktop/package.json`（bundles）+ 运行期 `settings/describe` RPC（19 namespaces）+ boot graph（58 client entries）。

---

## 1. 总览：85 项安装态 → 三种实际状态

| 状态 | 数量 | 说明 |
|---|---|---|
| ✅ 运行中（已挂载） | 19 个入口 | patch insert 12（10 启用 + 2 禁用）+ bundle 7 |
| 🚫 已装未挂载（不运行） | 66 个 | market 27 + builtin 39（其中数枚由 EAC 本体跑，见 §3） |
| 🗑️ 显式 disabled | 3 个 | sample-sdk-plugin / plugin-package-inventory-deepseek / ui-effort-slider |

## 2. ✅ 运行中清单（19 入口）

**【patch insert，10 启用】**
`balance`、`file-changes`、`client-file-changes`、`terminal`、`plugin-shield`、`plugin-manager`、`plugin-wizard`、`compact`、`eac-locale-compat`、`dsh-memory`

**【bundle，7】**
`dsh-base`、`dsh-web-app`（核心）、`dsh-bash-win`（含 tool-bashx）、`dsh-effort-slider`、`dsh-vision-router`、`dshmarket`、`dsh-raw-html`

**【patch insert disabled，2】** `plugin-package-inventory-deepseek`、`ui-effort-slider`

**前端可见性**：boot graph 58 个 client 条目 = 45 官方核心 + 13 插件（bash-win / vision-router / dshmarket / raw-html / balance / client-file-changes / plugin-shield / plugin-manager / plugin-wizard / compact / eac-locale-compat / **dsh-memory** / directory-picker-native）。设置页 describe 实测 19 个命名空间，含 `memory`（dsh-memory 后端与前端均正常挂载；设置面板空白是渲染层问题，见 `docs/config-manual.md` 的文件直改通道）。

## 3. 🚫 已装未挂载（registry `enabled:true` 但组合树无条目）

**market 27**（包在 `~/.dsh/plugin-artifact-cache`，从未插条：`file-drop`、`tool-vision`、外观皮肤 11（ui-skin-blue-fantasy/dragon-heir/maid-atelier/miku/minecraft/qq98/ths/trading/whale-song/xp）、@linxin666 web-ui 组件 13（community-plugins/compat/describe-image/dsh-aionui-panel/git-graph/liangshen/live-stats/pet/remote-web-ui/settings/skin-center/ssh/task-board）、`dsh-bell-notify`。
（注：tool-bashx 由 dsh-bash-win bundle 内嵌，实为运行。）

**builtin 39**（`~/.dsh/profiles/web-desktop/.dsh-builtin-plugins.json` 候选 + registry 记录；包体在 profile node_modules）：其中 `picturereader`、`computer-user`、`dsh-third-party-thinking`、`openclaw-bridge`、`dsh-pet`、`better-sidebar`（0.15.3-eac.1）等由 EAC 桌面壳（companion-sync，见 `dsh-desktop/lib/desktop/companion-sync.js` `COMPANION_PLUGINS`）管理——有运行日志证据；其余为「内置候选未启用」（unified-market / skin-switch / easy-setup / soul-md / mobile-fix / meow-smooth / viewport-lock / message-rewind / dsh-undo / dsh-dafeiyu / offpeak / image-paste / settings-groups / agent-teams 等）。

## 4. 候选安装目标（2026-09-03 用户指定）与兼容性

| 目标 | 来源 | 包名 | 版本 | engines.dsh 要求 | 内核 0.1.2-alpha.1 匹配 |
|---|---|---|---|---|---|
| better-sidebar | 本地 zip `DSH-better-sidebar-0.17.1.zip` | `dsh-better-sidebar` | 0.17.1（现存内置 0.15.3-eac.1） | 无（node>=20 ✓） | ✅ **匹配** |
| task-board | github zhu1090093659/dsh-web → npm | `@linxin666/dsh-client-ui-task-board` | 0.3.13 | >=0.1.2-alpha.4 | ⚠️ **不匹配**（alpha.1 < alpha.4） |
| git-graph | 同上 | `@linxin666/dsh-client-ui-git-graph` | 0.3.13 | >=0.1.2-alpha.4 | ⚠️ **不匹配** |
| remote-web-ui | 同上（npm 未发布） | `@linxin666/dsh-remote-web-ui` | 0.3.13（源码） | >=0.1.2-alpha.4 | ⚠️ **不匹配** |

兼容性判断依据：
- 内核加载器（cordis-plugin-loader / dsh）**无 engines 硬校验**，发布声明不符只会风险自负；
- 三件套 client.inject 依赖模块（dsh-client-ui-sidebar、dsh-api-session-controller、dsh-api-workspace-controller 等）在 alpha.1 的 boot graph 中均存在 → 大概率可运行，但 API 差异无保证；
- 旧版 @linxin666 组件（0.1.x，artifact cache 内的 0.1.20）无 engines 要求 → 若要绝对稳妥可回退 0.1.x。

**✅ 安装结果（2026-09-03 23:2x 已生效）**：`dsh plugin --profile web-desktop add`（转发 pnpm，带代理）直装成功——dependencies 5 新依赖、bundles 7→11、pnpm-lock 更新、pnpm-workspace.yaml 放行 node-pty/cloudflared（rebuild 出 conpty.dll/cloudflared.exe）、dump-config 组合树 4 新 entry 无错；重启后 boot rev 758eb5a7c4c1 含 4 个新 client 条目，settings/describe 21 ns（+dsh-better-sidebar、+git-graph；task-board/remote-web-ui 走 slots/侧边栏 UI 呈现）。网关说明：排队标记（.dsh-market-pending.json）因桌面壳进程存活期未重新扫描而无产物，实际安装以直接 CLI 为准。

**重复项处理（用户指示"有重复的就另外装，把已经有的删掉"）**：
- better-sidebar：删内置 companion（patch 行 + node_modules/dsh-better-sidebar@0.15.3-eac.1 + registry better-sidebar 记录 + removed 名单），再装 0.17.1（bundle 通道，避免双挂载——zip 内 cordis.patch.yml 有显式警告）。
- web-ui-task-board / web-ui-git-graph / web-ui-remote-web-ui：删 registry 旧记录（0.1.x 时代安装态），装 0.3.13 新版。
- 安装网络：本机直连外网被 fake-ip（198.18.0.0/24, Clash TUN）拦截，需经 `http://127.0.0.1:7890` 代理；EAC 安装进程默认不注入代理（childEnv 无 HTTPS_PROXY），CLI 手动安装需 `HTTPS_PROXY` env、或写入 profile .npmrc。

## 5. 运维备忘
- 升级 EAC 会重写 cordis.patch.yml（dsh-memory 曾因此失挂载）——升级后校验。
- registry.json 编辑需谨慎；改动后由 desktop `plugin-manager-state` 读取，格式 schema v1。
- 市场安装排队机制：`.dsh-market-pending.json` 标记 → 桌面壳在无 web 进程持锁窗口用 `dsh plugin --profile <p> add <target>` 执行。