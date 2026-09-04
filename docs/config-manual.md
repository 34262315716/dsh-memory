# dsh-memory 配置文件直改手册（面向 AI 助手）

适用范围：EAC 5.3.6 / dsh 内核 0.1.2-alpha.1 / dsh-memory v0.9.21。
本手册写给**任何 AI 实例**：不依赖 GUI（设置面板可能空白/损坏），直接在配置文件里改，改完实时生效。

---

## 1. 配置存在哪（两个文件，三个层级）

| 层级 | 位置 | 作用 |
|---|---|---|
| 1 默认值 | 插件内 `lib/config.js`（schemastery schema） | 未写任何配置时生效 |
| 2 组合层（挂载默认） | `C:\Users\28643\.dsh\profiles\web-desktop\cordis.patch.yml` → `- insert: - id: dsh-memory` 段的 `config:` | 插件默认配置（当前含 enabled/injectMaxTokens 等） |
| 3 用户层（**改这里**） | `C:\Users\28643\.dsh\settings.yaml` → `memory:` 段 | 覆盖层，优先于层级 2 |

合并规则：**字段级合并**，用户层（settings.yaml）覆盖组合层（patch config），组合层覆盖 schema 默认值。只写想改的键，其余自动继承。

> ⚠️ 层级 3 是唯一推荐修改点。层级 2 仅在「恢复出厂默认」或 EAC 升级重写 patch 后需要复查。

---

## 2. 生效时机（重要）

- 插件注册 settings 用了 `applies: 'live'`（`lib/index.js`）：**用户层配置改动实时生效，无需重启**。
- **例外（启动时固化，改后必须重启 EAC/dsh web）**：
  - `dbFile`（数据库路径）
  - `embedding.*`（嵌入模型：provider/model/baseUrl/apiKeyEnv/cacheSize）
  - `reranker.*`（模型端点类参数）
  - `enabled`（开关）
- 原因：embedder/reranker/store 在 `apply()` 时一次性初始化（`lib/index.js` 70-83 行），之后只读。

---

## 3. 全部配置键速查

### 3.1 基础参数

| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `enabled` | `true` | bool | 总开关。false = 插件不启动（改后重启） |
| `dbFile` | `''` | string | 留空 = `~/.dsh/memory.db`（改后重启） |
| `scope` | `''` | string | 留空 = global；可收窄到工作目录名 |
| `injectMaxTokens` | `800` | 100–4000 | 每次自动注入 token 预算 |
| `injectMinScore` | `0.02` | 0–1 | 注入最低相关分（RRF 量纲：0.02 ≈ 至少一路排前 10）。**想更少打扰调大到 0.05** |
| `stepInterval` | `10` | 1–10 | 每 N 步全量重检索（步距按 agent 会话真实步数计；到点必检，同 query 也重检，重复注入由内容 hash 去抖） |
| `maxRecentPerAgent` | `6` | 1–50 | 每个 agent 最近注入窗口（防循环） |
| `maxVersionsPerMemory` | `8` | 1–50 | 每条记忆世界线版本数 |

### 3.2 `features`（功能开关矩阵）

| 键 | 默认 | 说明 |
|---|---|---|
| `autoWrite` | `true` | turn/end 自动沉淀记忆。**临时任务不想入库时调 false** |
| `valueGate` | `true` | 价值门噪音过滤（强烈建议保持 true） |
| `dedupMerge` | `true` | 相似记忆更新而非新建 |
| `preStepInject` | `true` | pre-step 自动注入检索结果 |
| `manageTools` | `true` | 管理工具集（memory_store/search 等暴露给 agent） |
| `time` | `true` | 时间维度版本化世界线 |
| `graph` | `true` | 图谱骨架构建（关闭则图谱面板空） |

### 3.3 `refiner`（LLM 蒸馏提取）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | **当前用户已开 true**。开启后走 LLM 提取，失败自动降级规则路径 |
| `provider` | `opencode-go` | **当前为 `deepseek-official`**（商务模型路由） |
| `model` | `deepseek-v4-flash` | 提取模型 |
| `apiKeyEnv` | `MEMORY_REFINER_API_KEY` | 凭据文件 `~/.dsh/.credentials.yaml` 中的键名，**只读键名不读值** |
| `maxTokens` | `800` | 提取输出上限 |

> 已知问题（待修，不影响降级）：refiner 若返回空 JSON，日志报 `LLM 提取失败，降级规则路径: Unexpected end of JSON input`，此时自动走规则提取，**功能不中断**。

### 3.4 `embedding`（嵌入，改后重启）

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `remote` | `rule`（离线哈希兜底，无密钥）/ `remote`（OpenAI 兼容 API）/ `onnx`（预留） |
| `model` | `Qwen/Qwen3-VL-Embedding-8B` | 硅基流动实测 4096 维 |
| `baseUrl` | `https://api.siliconflow.cn/v1` | |
| `apiKeyEnv` | `MEMORY_EMBEDDING_API_KEY` | 密钥键名 |
| `cacheSize` | `1024` | 64–8192 |

> 本机现状：未配置 embedding 密钥 → 日志 `已降级到 rule embedder`（dim 256，离线可用）。

### 3.5 `reranker`（精排，改后重启）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | **当前用户已开 true** |
| `provider` / `model` | `remote` / `Qwen/Qwen3-VL-Reranker-8B` | |
| `baseUrl` | `''` | 留空 = 跟随嵌入端点 |
| `apiKeyEnv` | `MEMORY_RERANK_API_KEY` | |
| `topK` / `minCandidates` / `rrfWeight` | `20` / `3` / `0.7` | 精排候选数 / 候选不足不重排 / final = w×RRF + (1-w)×重排分 |

### 3.6 `graphView`（图谱力导向手感，改后重开图谱面板生效）

| 键 | 默认 | 范围 |
|---|---|---|
| `spring` | `0.13` | 0.02–0.5 |
| `repulsion` | `1` | 0.2–2 |
| `damping` | `0.3` | 0.05–0.9 |
| `gravity` | `0.005` | 0–0.05 |

### 3.7 `housekeeping`（管家自动巡检，只读报告）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | |
| `interval` | `20` | 每沉淀 N 条记忆巡检一次（5–500） |
| `maxIntervalHours` | `24` | 时间兜底（1–720） |
| `dedupThreshold` | `0.92` | 近重复合并阈值（0.8–0.99） |
| `agingDays` | `30` | 老化报告天数（7–365） |

### 3.8 其余

| 键 | 默认 | 说明 |
|---|---|---|
| `events.enabled` / `gapHours` | `true` / `2` | 事件分类（时间+因果聚簇）；gapHours 0.5–48 |
| `logging.enabled` / `maxRows` | `true` / `2000` | 运行日志（100–10000，惰性裁剪） |

---

## 4. 标准修改流程

1. **备份**（每次必做）：
   ```bash
   cp "C:/Users/28643/.dsh/settings.yaml" "C:/Users/28643/.dsh/settings.yaml.bak-$(date +%Y%m%d-%H%M%S)"
   ```
2. **编辑** `settings.yaml` 的 `memory:` 段。示例——把注入分数调严 + 关自动写入：
   ```yaml
   memory:
     injectMinScore: 0.05
     features:
       autoWrite: false
   ```
   > ⚠️ **YAML 缩进警告**：`memory:` 顶格，子键统一 2 空格缩进，嵌套再 +2。曾因缩进错误导致 EAC 启动崩溃（`BLOCK_AS_IMPLICIT_KEY at line 458`）。改完可先 `node -e "require('js-yaml')..."` 或用任意 YAML 校验器验证。
3. **生效**：仅改参数类键（§3 除「改后重启」标注者）→ **立即生效**，无需重启。改 embedding/reranker/dbFile/enabled → 托盘完全退出 EAC 再启动。（提示：关窗 ≠ 退出，须托盘右键退出。）
4. **验证**（三选一）：
   - 日志：`C:/Users/28643/AppData/Roaming/Deepseek Harness EAC/logs/dsh-web.log` 里 `[dsh-memory]` 行（启动段 + 每次 LLM 提取失败降级提示）。
   - 运行期 RPC（需 Cookie，见下）：
     ```
     POST http://127.0.0.1:10012/api/settings/describe
     Body: {"type":"client-request","rpcId":"<uuid>","method":"settings/describe","payload":{"args":{}}}
     → value.namespaces 应含 "memory"
     ```
   - 记忆库直查（只读）：`node --experimental-sqlite -e "..."` 打开 `~/.dsh/memory.db`，看 `logs` 表最近写入（preheat/inject 事件）。

---

## 5. 常见任务速查

| 想要的效果 | 改哪里 |
|---|---|
| 关掉自动记忆 | `memory.features.autoWrite: false`（或 `memory.enabled: false` + 重启） |
| 注入更少打扰 | `injectMinScore: 0.05` 或 `0.08` |
| 注入更多上下文 | `injectMaxTokens: 1200`、`injectMinScore: 0.015` |
| 换提取模型 | `refiner.provider` / `refiner.model` |
| 开图谱 | `features.graph: true` + `graphView` 微调 |
| 关图谱（省资源） | `features.graph: false` |
| 换嵌入（需密钥） | `embedding.provider: remote` + 在 `~/.dsh/.credentials.yaml` 提供 `MEMORY_EMBEDDING_API_KEY` + **重启** |
| 关重排 | `reranker.enabled: false` |
| 关管家巡检 | `housekeeping.enabled: false` |

---

## 6. 运维提醒（踩坑记录）

- **EAC 升级会重写 `cordis.patch.yml`**，`dsh-memory` insert 条目可能被清除（2026-09-03 实测，registry 仍显示 enabled 但实际未挂载）。升级后必须复查该文件是否还有 `- id: dsh-memory` 条目；被清则按 `docs/CHANGELOG.md` 恢复。
- **包名必须匹配** `dsh-memory`（目录名/挂载名），否则 GUI 客户端静默消失（nearestPackage 匹配失败无日志）。改包名后需同步 `package-lock.json` 根 name。
- 改动插件 `lib/` 后需同步部署副本 `~/.dsh/profiles/web-desktop/node_modules/dsh-memory`（md5 校验），重启生效。
- 数据安全：`~/.dsh/memory.db`（WAL）含全部记忆，千万别提交进版本库。