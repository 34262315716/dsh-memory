# dsh-memory

DSH（DeepSeek Harness）进阶自动记忆插件。

## 功能（阶段一已落地）

- **SQLite 存储**：`node:sqlite`（零编译，WAL + STRICT + FTS5 trigram 中文检索）
- **分层记忆**：`ep`（情景，turn 快照）/ `sm`（语义，长期知识），带 scope 隔离
- **时间维度（世界线）**：更新追加版本，旧版本保留但隐藏（不参与检索/注入），回滚链 + 滚动裁旧
- **自动写入**：`turn/end` 沉淀 + 价值门 + Jaccard 去重合并
- **自动注入**：`agent/pre-step` 每步触发（不依赖用户消息）+ 步距节流 + 签名去抖 + 注入块 hash 去抖 + KV 缓存友好格式（稳定块头/确定性排序/append-only 尾部）
- **工具面**：`memory_add` / `memory_search` / `memory_forget` / `memory_list` / `memory_stats`
- **功能开关矩阵**：`autoWrite` / `valueGate` / `dedupMerge` / `preStepInject` / `manageTools` / `time` / `graph`
- **迁移**：存量 `auto-memory.json` 自动导入

## 安装

1. 复制本包到 profile：`C:\Users\<user>\.dsh\profiles\web\node_modules\dsh-memory\`
2. `cordis.patch.yml` 添加：

```yaml
- insert:
    - id: dsh-memory
      name: dsh-memory
      config:
        enabled: true
        features:
          autoWrite: true
          valueGate: true
          dedupMerge: true
          preStepInject: true
          manageTools: true
          time: true
          graph: false
```

3. 重启 `dsh web`（或依赖 HMR 热加载）

## 测试

```bash
node test.mjs
```

## 设计文档

[memory-plugin-proposal.md](docs/memory-plugin-proposal.md) — 1400+ 行完整架构方案（分层记忆 / 立体图谱 / SQLite 底座 / 功能开关 / 时间世界线）。

## 经验备忘

- 访问 `ctx` 上的外部 service（如 `tools`）必须声明 `export const inject = ['tools']`
- `defineTool` 的 JSON schema 中每个 object 节点必须显式 `additionalProperties: true/false`
- 修改插件后需同步源码与 profile 副本两份文件，再重启 `dsh web`
