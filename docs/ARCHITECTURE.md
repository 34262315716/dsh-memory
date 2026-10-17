# dsh-memory 架构文档（总入口）

> 对应 **v0.20.0**。完整文档已按主题拆成 11 章，放在 `docs/architecture/` 下。
> 本文件是总入口：**想知道这东西怎么运转，从这里进。**

## 快速导航

| 想了解 | 读这一章 |
|---|---|
| 有哪些模块、想改某功能去哪个文件 | [01 · 模块构造](architecture/01-模块构造.md) |
| 数据库表结构 / 世界线 / 归档语义 | [02 · 数据模型](architecture/02-数据模型.md) |
| 记忆怎么被自动记下来 | [03 · 写入管线](architecture/03-写入管线.md) |
| 检索怎么排序、为什么没查出来 | [04 · 检索管线](architecture/04-检索管线.md) |
| 记忆怎么进到模型上下文里 | [05 · 注入管线](architecture/05-注入管线.md) |
| 图谱 / 边 / 主题 / 事件 / GUI | [06 · 图谱与社区](architecture/06-图谱与社区.md) |
| 遗忘曲线、管家巡检与治理 | [07 · 遗忘与管家](architecture/07-遗忘与管家.md) |
| 配置项全表、两代内核差异、密钥、安全 | [08 · 配置与双内核](architecture/08-配置与双内核.md) |
| DSH 集成点、25 个工具、运维脚本 | [09 · 集成点与工具面](architecture/09-集成点与工具面.md) |
| 写代码要守的规矩 | [10 · 工程约定](architecture/10-工程约定.md) |
| 已知短板与教训 | [11 · 已知限制与演进](architecture/11-已知限制与演进.md) |

也可以直接进 [docs/architecture/README.md](architecture/README.md)——带阅读指引的索引页。

## 一句话理解它

**用户每条消息都触发一次检索注入**（可按需关掉），agent 自主工作的其余步骤按节奏补充；每个轮次结束时自动沉淀新记忆，写入前先问一次本机决策模型「值不值得记」。

记忆不是清单，而是会生长的知识网络：分层（情景 `ep` / 语义 `sm` / 画像 `profile`）+ 知识图谱 + 世界线（时间维度）+ 向量语义检索。本地 SQLite，零编译，MIT。

## 相关文档

| 文档 | 内容 |
|---|---|
| [README.md](../README.md) | 功能总览、安装、配置速查、测试清单 |
| [CHANGELOG.md](CHANGELOG.md) | 逐版本变更史（含每次故障与修法） |
| [ROADMAP.md](ROADMAP.md) | 路线图与阶段计划 |
| [config-manual.md](config-manual.md) | 配置手册 |
| [architecture.html](architecture.html) | 交互式架构图（浏览器打开，或侧边栏预览） |
| [memory-plugin-proposal.md](memory-plugin-proposal.md) | 最初的设计方案（1406 行） |

## 维护约定

- 改架构就改对应那一章，别让文档再次落后于实现——本文件曾长期停在 v0.9.7，而代码已经走到 v0.16.x。
- 文中的行数、默认值、表结构都取自当次实测；对不上时以代码为准，顺手把文档改过来。
