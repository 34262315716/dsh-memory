# dsh-memory

DSH（DeepSeek Harness）进阶自动记忆插件：分层记忆（情景/语义/画像）+ 知识图谱 + 世界线版本化 + 向量 RAG 检索 + 增量构建。

## 开发须知

- **测试**：`node test.mjs` 等（套件清单与说明见 `README.md` §测试）。改动 `lib/` 后需跑全量套件。
- **前端构建**：改动 `client/*.jsx` 后执行 `node build-client.mjs` 重建 `lib/client.js`（bundle 勿手改）。
- **数据安全**：记忆库默认 `~/.dsh/memory.db`（WAL，可能在运行时生成 `.db-wal/.db-shm/.bak-*`）。任何数据库、凭据、备份文件**绝不入版本库**（见 `.gitignore`）。
- **文档纪律**：禁止在文档/代码中出现本地绝对路径、真实凭据或密钥。
- **部署**：DSH web 插件的 `lib/` 改动需同步到部署副本（md5 校验），重启生效。
