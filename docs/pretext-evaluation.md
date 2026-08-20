# PreText 评估报告（记忆图谱 GUI 用途）

> 调研时间：2026-08-15 傍晚。用户提出「用开源项目 pretext 看看有没有用处」，本文给出结论。

## 1. PreText 是什么

- 项目：github.com/chenglou/pretext，npm 包 @chenglou/pretext（v0.0.8，MIT）
- 作者：Cheng Lou（React 圈大佬，Preact 作者之一），2026 年 3 月爆火（"无 DOM 文本引擎"，声称比 DOM 文本测量快 500 倍）
- 本质：**纯 JS/TS 多行文本测量与布局引擎**——用自己的测量逻辑（以浏览器字体引擎为 ground truth）替代 getBoundingClientRect/offsetHeight 这类触发布局回流（reflow）的 DOM 测量
- 支持：DOM / **Canvas** / SVG 渲染路径；全语言（中文断行、阿拉伯文 RTL、emoji）

## 2. API 形态（两段式，性能设计的关键）

    // ① prepare：一次性预处理（规范化/分段/glue 规则/canvas 测量段）→ 句柄
    const prepared = prepareWithSegments(text, '12px sans-serif')
    // ② layout：热路径纯算术（缓存宽度上计算），可反复调用
    const { lines } = layoutWithLines(prepared, 100, 18)   // 100px 宽 → 每行文本
    ctx.fillText(lines[i].text, x, y)                      // 直接画进 Canvas

    // 只测高度/行数（不做字符串构建，更快）：
    const { height, lineCount } = layout(prepared, 320, 20)
    measureLineStats / walkLineRanges                       // 行宽/光标级信息

## 3. 实测（本机 POC 目录，未随仓库分发）

| 验证项 | 结果 |
|---|---|
| npm 安装 | ✅ 单包零依赖，2 秒装完 |
| esbuild 打进 cjs bundle（我们的 build-client 链路） | ✅ 成功，+102KB（client.js 40KB → ~140KB） |
| 纯 Node 运行 | ⚠️ 报错「requires OffscreenCanvas or DOM canvas」——**预期行为**：测量阶段需要 Canvas；我们的 GUI 跑在浏览器，天然满足 |
| 中文断行/keep-all/高度计算 | 逻辑 API 完整（浏览器内可直接用） |

## 4. 对记忆图谱 GUI 的用处评估

### 当前场景：收益有限
- 30-100 节点，标签 = label.slice(0, 9) 硬截断 + 固定 10px 字号，Canvas fillText 直接画——**没有测量需求，也没有性能瓶颈**
- PreText 的核心卖点（避免 DOM reflow）对纯 Canvas 渲染场景意义不大

### 未来增强场景：PreText 是正解（价值点）
1. **节点气泡多行标签**：theme 标签如「compaction/结构化摘要」（12 字）现在被截成 9 字丢信息；PreText 按气泡宽度自动换行 + 画气泡背景
2. **Canvas 内富文本卡片**：hover 时把记忆摘要（多行、中文断行、截断省略号）直接画进 Canvas（目前详情在 React 侧栏）
3. **千级节点标签**：prepare 预计算 + layout 纯算术——测量缓存模式天然适合每帧大量文本
4. **中文排版正确性**：断行/禁则（keep-all）现成，不用自己写

### 风险
- v0.0.8 早期版本，API 可能变（集成要封装一层 adapter）
- bundle +102KB（对 40KB 的 client.js 是 2.5 倍——但对浏览器运行时无感知）

## 5. 结论与建议

- **当前不集成**：现有标签场景 ROI 低，102KB 换不了什么
- **列入图谱增强备选**：触发条件 = 做「节点气泡多行标签」或「Canvas 详情卡片」时引入，封装 adapter（prepare 缓存 Map<text+font, handle> + layoutWithLines → 绘制）
- POC 目录保留于本机，决策后可直接复用（未随仓库分发）

## 附：另外两个同名项目（排除）

- PreTeXtBook/pretext：数学教科书标记语言，与图谱无关
- q-qp-p/pretext：文本测量 CLI 工具，方向相近但不是用户所指的热门项目
