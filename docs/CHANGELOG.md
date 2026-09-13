# 开发历程（CHANGELOG）

## v0.10.8 — 主题区域去抖：默认圆形 + 凸包钉顶点 + 时间平滑（2026-09-13）

用户实拍：选中某主题后，画出的区域**不断跳动、多面圈反复扩大缩小**。定位与修复：

### 根因（量化实测，非猜测）
- **默认形状是凸包**——凸包顶点由节点位置决定，节点微动就会有点进出凸包：实测真实数据（主题「用户/荣格」45 成员、300 帧）**顶点数变化 72 次**（约每 4 帧一次）。少顶点时每次换位都是轮廓突变 → 视觉上"多面圈不断扩大缩小"。
- 次要因素：区域**尺度参数每 45 帧刷新**（阈值一跳，整批区域重划，实测 300 帧内区域数量变化 1 次、抖动 0.12%）；以及力导向 0.02 活跃度地板使节点持续微动，凸包顶点会把单点微动放大到外轮廓。

### 三刀
1. **默认形状改 `circle`**（最小外接圆）：轮廓由 cx/cy/r 连续变化，无顶点概念 → 实测尺寸抖动 0.06%（vs 凸包 0.33+）。
2. **凸包改为"钉住顶点"**：重建计划时把凸包顶点**固定到具体节点**，之后每帧只移动这些顶点 → **顶点数变化 0 次**（原 72 次）、面积抖动 0.05%。凸包选项现在也可用了。
3. **成员划分缓存**：聚簇 + 密度核心是离散判定（节点微动即换团），改为只在离散事件（数据量 / 主题切换 / 模式变化）重建；每帧只按实时坐标重算形状。
4. **时间平滑**（指数滤波 α=0.22，滞后约 4 帧≈67ms）：把残余微抖抹平——抖动 0.06% → **0.02%**。尺度参数改为只在重建计划时计算一次（不再定期刷新）。

### 验证
- 抖动量化脚本（真实快照 + 真几何模块 + 同款力导向，300 帧对照）：区域数量变化 0 次、尺寸抖动 0.02%（含平滑）。
- 几何/缓存守护测试 66 项全绿；`test.mjs` 52 项全绿；bundle 127357 B；版本 0.10.7 → 0.10.8；副本 `lib/client.js` + `lib/config.js` + package.json md5 同步。
- ⚠️ 前端刷新生效。设置面板「主题圈形状」默认已切到「圆形（推荐，轮廓稳定）」。

> 从"一条注入插件的想法"到"带图谱与向量检索的长期记忆子系统"的完整轨迹。技术方案演进见 [`memory-plugin-proposal.md`](memory-plugin-proposal.md)。

## v0.10.7 — 图谱三点整改：打开即全局平衡 + 主题筛选高亮 + 收紧散乱（2026-09-13）

用户实拍反馈三条，逐一处理：

### 1. 每次打开都从零迁移 → **打开即在全局平衡位置**
- **收敛判据修正**：旧逻辑用 `alpha > 0.006` 判收敛——alpha 是固定衰减（≈165 步就到底），根本不代表平衡。改为**最大节点位移**判据：位移 <0.02 即视作全局平衡，上限 1500 步兜底。实测真实数据（490 节点/374 边）**220 步、76ms** 收敛——"把平衡跑在打开之前"几乎没有成本。
- **布局落盘（新模块 `client/layout-cache.js`）**：收敛坐标写进 localStorage（`[id,x,y]`，坐标 1 位小数），关闭面板与运行中每 ~5s 各存一次；下次打开直接落位到上次的平衡形态。
- **按 id 复用而非严格拓扑匹配**：记忆中几乎每次会话都在长新节点（写一条记忆拓扑就变），若"签名不符即作废"缓存等于永远失效。现改为按 id 取交集复用（≥85% 命中即直接落位；新节点落在**同主题已恢复节点的质心**附近再由力导向微调），既保平衡又平滑接纳新记忆。
- 仍保留实时物理（alpha 地板 0.02 的缓慢律动），不影响"实时运算渲染"。

### 2. 新增：主题筛选高亮（图谱内）
- 工具栏新增「全部主题 / 某主题（N 条）」下拉：选中后**该主题节点与边保留、其余变灰降透明**（与事件高亮可叠加），并把**视口自动收拢到该主题**（边距 130px、上限放大 2.4×），同时按 `themeScope` 显示该主题的区域与标签。
- 空集合防护：该主题在当前时间窗内没有节点时不启用筛选（否则空 Set 会把整图变灰）。

### 3. 节点太散乱 → 度感知回中力
- 零连接记忆被斥力推到外围结成"光环"是散乱主因：孤立节点回中力 ×3.2、单连接 ×1.8（成片区域内部结构不受影响）。

### 验证
- 几何/缓存守护测试扩到 **66 项**（新增 layout-cache 10 项：编解码往返、1 位小数、复用率、坏数据不抛、签名对顺序不敏感/对边的变化敏感）；关键套件 52/10/31 全绿。
- 离线渲染台同步新物理复核；bundle 125279 B；版本 0.10.6 → 0.10.7；副本 `lib/client.js` + package.json md5 同步。
- ⚠️ 前端刷新（重开图谱面板）生效。**首次**打开会跑一次约 80ms 的收敛并落盘（无感），之后每次打开直接落在平衡位置。

## v0.10.6 — 主题圈第二次重做：从"全局凸包"到"密集团 + 按需显示"（2026-09-13）

用户实拍验收：v0.10.5 的效果是**一堆巨大半透明多边形互相叠、糊住整张图**（"很明显不行"）。复盘根因——**不是"贴合算法"不够好，而是问题定义错了**：

- 主题是**语义**分组，在力导向布局里往往摊得很开（实测：`dsh-memory/dsh` 96 条成员横跨半个画布）。对全部成员取凸包，凸边必然把中间**别家的节点**一并兜进来 → 巨大多边形 + 相互叠加 + 文字打架。
- 实测标定（真实快照 490 节点/34 主题离线复现）：聚簇门槛与密度半径必须跟随**实测邻边中位长度**；门槛放松→大圈糊图，收紧→一个圈都画不出。这印证了"同主题在空间上不聚拢"是数据事实，不是渲染瑕疵。

### 三个改动（`graph.jsx` + `graph-geometry.js`）
1. **只圈"密集团"**：新增 `densityCore(points, {eps, minNeighbors, minSize})`——邻居数 ≥2（半径 eps 内）才算核心成员，滤掉链状/条状的稀疏末端；核心不足 minSize 就**不画**（稀疏同主题本就成不了一片区域）。配合 `clusterByDistance` 先拆局部团：一个主题可以画成若干个**紧圈**，而不是一个兜住半个画布的大圈。
2. **层序修正**：区域用 `destination-over` 画到**边与节点之下**——之前半透明填充盖在网络上，像蒙了一层彩色塑料膜（"糊"感的另一半来源）。标签改到节点之上（避免被节点压住），并做碰撞避让 + 每主题至多 1 个。
3. **显示策略可配**（`graphView.themeScope`，默认 `focus`）：
   - **focus（默认）**：只在悬停/选中节点时，显示该节点所属主题的密集团（零干扰；标签标"主题总数"）；
   - **always**：为所有主题的密集团画圈（最多 8 片，常显）；
   - **off**：不画。
   形状仍由 `themeShape`（hull 贴合凸包 / circle 最小外接圆）决定。设置面板「记忆图谱」新增下拉。

### 验证
- 离线渲染台复现（真实快照 + 真实几何模块 + 同款力导向 + 无头 Chrome 出图），逐档对比后才定标：聚簇 1.6×邻边中位长度、密度核心 1.0×；聚焦模式下目标主题画成 3 个紧圈（18/9/9），bbox 占比从 v0.10.5 的"糊满画布"降到 17.8%。
- 守护测试：`test-graph-geometry.mjs` 扩到 **56 项**（新增 `densityCore` 11 项 + `boundsBox` 3 项 + 聚簇 12 项）；关键套件全绿。
- ⚠️ 前端刷新（重开图谱面板）生效；「设置 → 记忆 → 记忆图谱」可切显示策略与形状。

## v0.10.5 — 主题圈重做：贴合形状 + 逐帧跟随（v0.10.1 粗圆修正）（2026-09-13）

用户验收指出 v0.10.1 没做到"**圈刚刚好圈住同主题内容、并随主题中心移动**"。旧实现是「质心 + 最远点距离 + 固定 26px」的粗圆：同主题节点在力导向下常被拉成弧状/条状，粗圆半径由最远点决定，会圈进大片不属于该主题的空白（甚至别组节点），观感糊且不随组形变化。

### 新几何模块（`client/graph-geometry.js`，纯函数）
- `convexHull`：Andrew monotone chain，剔除重复点/共线中间点，按有向面积归正为逆时针（外法线方向才有确定含义）。
- `padConvexPolygon`：凸包沿各边外法线外扩 pad（相邻偏移线求交）——保证原成员全部落在包围区内，且外扩量精确等于 pad。
- `minimalEnclosingCircle`：确定性 Welzl（固定种子洗牌）——逐帧调用无抖动，与暴力最优解对拍一致。
- `themeBounds`：统一入口，返回 `{kind:'hull', points, hull, cx, cy, topY}` 或 `{kind:'circle', cx, cy, r, topY}`。

### 画布接线（`client/graph.jsx`）
- 主题圈改为**每帧**按成员实时坐标算 `themeBounds`（绘制循环本就每帧 step+draw，alpha 有地板不冻结）→ 圈随主题中心与组形实时移动。
- padding 跟随节点视觉半径（与节点绘制同口径 `/√k`）+ 10px 屏幕留白——大节点不再戳出圈外，任意缩放倍率都贴合。
- 描边 `lineJoin='round'` 柔化转角，但**不圆滑顶点**（顶点内切会切进节点，违背"刚好圈住"）。
- 标签锚点取包围区顶部 `topY`，随圈移动。

### 形状可选（`graphView.themeShape`，默认 hull）
- 新配置项 `themeShape`：`hull`（默认，贴合凸包＝"刚好圈住"）| `circle`（最小外接圆，仍是正圆盘但已是同点集最紧的圆——保留 v0.10.1 拍板的圆盘形态）。
- 设置面板「记忆图谱」区块新增下拉；字符串枚举不走 NUMERIC_SUB 的 Number 分支，单独保存。

### 守护测试（新套件 `test-graph-geometry.mjs`，31 项）
- 凸包顶点/共线剔除/重复点/退化/非法坐标/逆时针；
- 外扩：包含性、面积增长、外扩距离精确、pad=0 原样；
- 最小外接圆：两点严格最紧、与暴力最优解一致、确定性、共线退化；
- themeBounds：包含性、**贴合度量化断言**（条状点集凸包面积 < 最小外接圆面积 ×0.9）、**平移跟随断言**（整组平移 → 包围盒等量位移）、circle 模式 = 最小外接圆 + pad、单点/两点/空集/非法输入。

### 验证
- 14 套测试全绿（新增 31 项几何专项）；版本 0.10.4 → 0.10.5；副本 `lib/client.js`/`lib/config.js` + package.json md5 同步。
- ⚠️ 前端刷新（或重开图谱面板）后生效；「设置 → 记忆 → 记忆图谱」可切换形状。

## v0.10.4 — 存量主题治理（LLM 簇级重命名）+ 嵌入切换风险提示（2026-09-10）

用户验收时发现：存量 110 条 theme 是**旧向量聚类的残留**（`theme_clusters` 表已空、577 条记忆全未归簇，theme 没清）——巨型糊团 `eac/dsh×100` + 碎片词标签。按两个方向整改：

### 1. memory_theme_relabel 工具（存量主题治理）
- **方案**：先全量重聚类（复用 `themeMemories(incremental:false)`，清簇重归 + 覆写残留 theme），再**簇级 LLM 重命名**——1 簇 1 次调用（比逐条重打便宜几十倍）。
- `store.themeClusterList(minMembers)`：读簇与成员 id；`store.retagTheme(clusterId, label)`：写回簇标签 + 全成员 theme（不动 cluster_id，增量聚类不会覆写）。
- 参数：`dryRun`（默认 true 只报告建议）/ `limit`（默认 20 簇控成本）/ `minMembers`（默认 2，单成员簇标签本就为空）/ `recluster`（true=先全量重聚类）。
- 提示词：给最多 8 条成员内容样本 → LLM 打 2-8 字名词标签（与蒸馏 theme 同一风格）；清洗（去空白/压空格/截 30）；失败保留旧标签不崩。
- **成本**：重聚类 ≈19 次嵌入调用（577 条，真嵌入 4096 维）+ 重命名 = 簇数 × 1 次 LLM 调用（用户控制 limit）。

### 2. GUI 嵌入切换风险提示（P3-3 落地）
- 设置面板嵌入区块：检测 provider/model draft 变化 → 显示风险横幅（切换不即时生效、重启时可能**清空向量表全量重嵌入**、远程失败进降级态）+ **确认勾选门禁**（勾选前保存按钮禁用）；保存后提示"需重启 DSH 生效"；reset 清除确认态。
- 依据：`applies: 'live'` 但 store 只在 apply 创建一次——嵌入改动确实要重启才生效，重启时才触发迁移。

### 守护测试（test.mjs 第 12 节，10 项）
- 重聚类产生多成员簇 / dryRun 返回建议且不写库 / apply 更新簇标签与全成员 theme / LLM 失败保留旧标签。

### 验证
- 13 套 **295 项全绿**（新增 10 项）；版本 0.10.3 → 0.10.4；副本 `lib/store.js`/`lib/tools/housekeeping.js`/`lib/client.js` + package.json md5 同步。
- ⚠️ 重启生效。生效后模型可调 `memory_theme_relabel`（先 dryRun 看建议 → 再 apply）；GUI 切换嵌入模型会看到风险横幅。

## v0.10.3 — 设置面板去掉自带滚动条（消除双滚动条）（2026-09-10）

用户反馈：「设置界面有两个侧边滚动条，只保留设置界面自己的」。

- 根因：`client/settings.jsx` 主视图容器带了 `overflowY: 'auto' + maxHeight: 'calc(100vh - 24px)'`——设置对话框自身已是滚动容器，插件再套一层就出现**双滚动条**。
- 修复：去掉插件容器的 `overflowY` 与 `maxHeight`，仅保留 `padding: 16` + `maxWidth: 680` + `boxSizing`（内容随外层设置面板统一滚动）。
- 范围：只动设置面板；`logs.jsx`（日志面板）与 `graph.jsx`（全视口图谱面板的详情栏）的滚动是各自面板的合法滚动容器，保持不动。
- bundle 重建（102129 B）→ 双副本 `client.js` md5 同步。
- ⚠️ 前端刷新（或重启 EAC）后双滚动条消失。

## v0.10.2 — 设置面板全面适配：补齐落后于 schema 的配置项（2026-09-10）

用户指出设置面板大多数选项落后于版本。全面盘点 `lib/config.js` schema vs `client/settings.jsx` 渲染项，补齐全部脱节点：

- **基础配置（新块）**：插件总开关 `enabled`、`dbFile`、默认 `scope`（此前顶层三项完全不可配置）。
- **检索与注入**：补 `maxRecentPerAgent`（防循环窗口）；修正 `injectMinScore` 提示（旧文案写默认 0.015，实际 v0.9.4 起为 0.02）。
- **refiner**：补 `reasoningEffort`（推理档位，off=关思维链，防 v0.9.25 教训重演：推理吃光 maxTokens 致蒸馏 100% 失败）、`maxTokens`（输出预算）。
- **事件分类（新块）**：`events.enabled` + `gapHours` 归并窗口（v0.9.0 的功能此前无 GUI）。
- **运行日志（新块）**：`logging.enabled` + `maxRows` 保留条数（v0.9.5 的功能此前无 GUI）。
- save 管线：新增 events/logging 整体保存、顶层 enabled/dbFile/scope 保存（空串 → unset）；`NUMERIC_SUB` 补 maxTokens/gapHours/maxRows；invalid 校验排除顶层文本字段；refiner maxTokens 按数字保存。

### 验证
- bundle 重建（102233 B）；双副本 `client.js` md5 一致；test.mjs / test-crash-safety 回归全绿。
- ⚠️ 前端刷新（或重启 EAC）后进「设置 → 记忆」可见全部区块与字段。

## v0.10.1 — P2 GUI 主题圈 + 设置面板新维度说明（2026-09-10）

ROADMAP P2 主题圈落地（图工具记忆级升级已在 v0.9.33 完成）：
- **主题圈**：图谱画布上，同主题节点（成员 ≥3、非"未归类"）每帧按实时质心/半径绘制**半透明淡色圆盘** + 主题名标签（`成员数 · 主题`）；圆盘跟随力导向节点移动，hover/选中/事件高亮时与节点同透明度。样式按拍板：**半透明圆盘**（非虚线椭圆）。
- **设置面板**：「检索与注入」区块补 v0.10 维度说明（画像 ×3 / principle ×1.5 / event ×0.7 注入加权 + theme 打标仅新记忆）。
- bundle 重建（92968 B）→ 双副本 `client.js` md5 同步。
- ⚠️ 前端刷新（或重启 EAC）后点「记忆」tab 可见主题圈；设置 → 记忆可见说明。

## v0.10.0 — P1 蒸馏双输出：abstraction（principle/event）+ theme 打标 + 注入加权（2026-09-10）

## v0.10.0 — P1 蒸馏双输出：abstraction（principle/event）+ theme 打标 + 注入加权（2026-09-10）

ROADMAP v0.10 阶段一核心落地。一次手术切两个病灶：abstraction 与 theme 同属**蒸馏输出 schema 改造**，外加注入加权联动。

### abstraction：抽象层级（principle/event）
- `memories` 新增 `abstract` 列（幂等迁移，老库自动补列；白名单 principle|event，越界回落空串不落非法标记）。
- **语义**：principle = 可复用的方法/原则/经验/看法（"怎么看待设计"）；event = 一次性具体事件/产出（"设计了什么"）。判断标准写进蒸馏 prompt：「能抽成通用原则的记 principle，纯事实记录是 event」。
- 蒸馏 prompt 规则 7 + 输出 schema 增加 `abstract` 字段；`extractWithLlm` 白名单校验返回。
- `store.add` 支持 abstract/theme 参数透传；`list/get`（SELECT *）自动带出新列。

### theme：LLM 打标（替代补向量聚类标签）
- 蒸馏 prompt 规则 8 + 输出 schema 增加 `theme` 字段：**简短稳定的名词标签**（2-8 字，如"四级备考"/"AI绘画"/"dsh-memory 开发"，不用句子/动词短语/标点）。
- LLM 输出清洗：去空白/压空格/截 30 字；空串=未归类。**存量记忆不重打**（设计拍板：新机制仅应用新记忆）。

### 注入加权联动（principle 优先、event 降权）
- `store.search` boost 升级为**双维加权**：`权重 = typeBoost × abstractBoost`（原 P0.1 profile×3 保持）。
- 注入路径（pre-step）传 `{ profile: 3, principle: 1.5, event: 0.7 }`——principle 弱命中被抬升能进注入门槛，event 弱相关被压低（强相关才注入），实现"我怎么看待设计"优先于"设计了什么"。
- **预热同步**：非画像种子按 abstract 排序（principle 排前），预热时间认知同样原则优先。

### 守护测试（test.mjs 新增 10/11 节，共 11 项）
- 第 10 节 abstraction 存储层：越界回落空串 / 合法落库 / theme 落库 / 列存在 / 重开不重复加列 / principle×1.5 / event×0.7。
- 第 11 节蒸馏双输出（mock LLM）：abstract=principle / theme / 越界回落 / 非字符串回落。

### 验证
- 13 套 **285 项全绿**（新增 11 项）；版本 0.9.33 → 0.10.0；副本 `lib/store.js`/`lib/refiner.js`/`lib/pipelines/inject.js`/`lib/pipelines/write.js` + package.json md5 同步。
- ⚠️ 重启生效。生效后新写入记忆自动带 abstract/theme；注入日志可观察 principle 命中占比提升（P1 验证项）。

## v0.9.33 — 阶段 C：图工具记忆级升级（neighbors/path 走 memory_links）（2026-09-10）

ROADMAP 阶段 C 落地：`memory_graph_neighbors` / `memory_graph_path` 从**实体节点级**升级为**记忆级**——沿 `memory_links` 活跃语义边扩散/寻路（底层 `memoryLinkNeighbors`/`memoryPath` 早已就绪，本次才接线）。

### 变更
- **`memory_graph_neighbors`**：不再返回实体节点（nodes/kind/label），改返回相邻**记忆**（`id` + 边 `type` + `depth` 跳数 + `snippet` 内容摘要 50 字）——模型直接看到"这条记忆和谁有关、什么关系"，不用再绕道实体层。
- **`memory_graph_path`**：`store.path`（实体边）→ `store.memoryPath`（记忆边 BFS），输入输出全为记忆 id，边类型链语义不变（causes/before/supports…）。
- 兼容性：参数名（`fromId`/`toId`/`memoryId`/`hops`/`maxLen`）不变，仅语义从节点改为记忆；`memory_graph_node` 保留实体级（查节点详情仍有用）。

### 验证
- 冒烟实测：`a -causes- c -before- b` 链 → neighbors(a) 返回 `[c@1跳 causes, b@2跳 before]`；path(a,b) 返回 `[a,c,b] + [causes,before]`。
- 13 套 **274 项全绿**（工具清单校验覆盖注册无缺无多）；版本 0.9.32 → 0.9.33；副本 `lib/tools/graph.js` + package.json md5 同步。
- ⚠️ 重启生效。模型侧可直接问「mem-A 和哪些记忆关联」/「这两条记忆之间怎么连起来的」。

## v0.9.32 — 注入块时间戳：长会话时间认知不断锚（2026-09-10）

用户提需求「让 DSH 实时感知当前时间，集成到记忆插件」。盘点现状发现两件事：① `system_now` 工具（v0.8.5 注册）已存在——本地+ISO+Unix+星期+时区，模型可随时主动查询；② 会话预热（session-start）已带时间锚点。**真正的断档**：pre-step 检索注入块不带时间，且 v0.8.5 曾刻意不加（时间每步变化会破坏 KV 缓存复用与 hash 去抖）。

### 方案：时间戳分离——"注入带时间，去抖用指纹"
- `renderInjection(hits, scope, opts)` 新增 `opts.withTime`：块头附加 `当前时间：YYYY-MM-DD HH:MM:SS 周X`（复用 `formatNow`，与预热格式一致）。
- `inject.js` 去抖 hash 改用**不带时间**的渲染（内容指纹），注入文本用**带时间**版本——两头都占：
  - **去抖语义不变**：检索内容未变 → 不重复注入（v0.8.5 KV 友好原则不破）；
  - **时间认知常在**：每次真正注入时模型都拿到当前时间，长会话/自主轮次不再只靠会话开始时的锚点。
- 预热时间戳保持原样（本就直接带）。

### 守护测试（test-inject-pipeline.mjs 新增第 8 节 2 项）
- 注入块头匹配 `当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 周X`；
- 同 hits 跨轮（间隔 ≥ stepInterval）时间流逝下第三轮仍不重复注入（去抖不破）。

### 验证
- 13 套 **274 项全绿**（新增 2 项）；版本 0.9.31 → 0.9.32；副本 `lib/util.js` + `lib/pipelines/inject.js` + package.json md5 同步。
- ⚠️ 重启生效。生效后观察：日志注入事件不变；注入块头多出「当前时间」前缀。

## v0.9.31 — 向量库防事故加固：降级态禁迁移 + 重嵌入批次重试（2026-09-10）

9/9 实测大事故复盘出的两道防护（事故现场：网络抖动致 embedder 落到 rule → 4096→256→4096 反复 DROP+迁移，208 条向量悬空，语义检索一度瘫痪）。本次把「一次性网络故障不该毁掉向量库」变成结构性保证：

### 防事故-1：降级态禁止破坏性迁移（degraded）
- `store.js` 新增 `degraded` 构造标记：**配置了远程嵌入但初始化失败落到 rule 时**，若向量表维度与 rule 维度不一致 → **禁止 DROP 迁移**，保留现有表与全部向量，向量路暂停（`vecEnabled=false`，FTS/关键词检索照常），日志明确警告；网络恢复、真嵌入器回来后自动恢复向量路。
- `index.js` 自动判定降级态：`embedder.name === 'rule' && 配置显式要求远程` → 传 `degraded: true`。
- **顺手修复自检发现的覆盖 bug**：初始化的统一收尾 `this.vecEnabled = true` 会无条件覆盖降级分支刚设的 `false`，导致暂停形同虚设——改为 `degradedMismatch` 标志联合判断（v0.9.31 守护测试第一版就抓出来了）。

### 防事故-2：reembedMissing 批次失败自动重试
- 失败批次进入重试队列，最多 `retryRounds` 轮（默认 3 轮，指数退避 800/1600/3200ms），尽可能在**一次会话**内把网络抖动造成的欠账补完，而不是留到下次启动。
- `index.js` 启动后台补跑再叠一层整体重试（最多 3 轮 × 5s 间隔，`vecEnabled` 时），网络短暂不通自动续跑。
- **顺手修复返回谎报 bug**：最后一轮失败的批次此前不保留在 `pending` 里（直接 `continue` 且不进 `next`），返回 `pending: 0` 谎称全部完成——失败条目被静默吞掉。现在失败批次恒进 `next`，最后一轮作为 `pending` 如实上报。

### 配套
- `embedder.js` 远程嵌入超时 8s → **30s**（8s 在慢网络下高频误判失败，是 9/9 事故的直接诱因之一）。

### 守护测试（test-housekeeping.mjs 新增 12/13 节）
- 降级态：`vecEnabled=false` + 表不 DROP（2 行数据保留）+ `reembedMissing` 直接跳过；非降级对照路径迁移照常。
- 重试：首轮失败后补完（done=3/pending=0）+ 实际发生重试 + 库内无缺失向量；重试耗尽如实上报 pending=3。

### 验证
- 13 套 **272 项全绿**（新增 8 项）；版本 0.9.30 → 0.9.31；副本 `lib/store.js`/`lib/embedder.js`/`lib/index.js` + package.json md5 同步。
- ⚠️ 重启生效（require 后 plugin 代码不热载）。生效后可观察：日志不再出现「向量维度迁移」反复刷屏；启动日志出现「重嵌入 N 条」即补写完毕。

## v0.9.30 — 设置页空白根治：KeyInput 误用 React 保留属性 ref（#290）+ credentials 官方形态（2026-09-09）

用户报告「GUI 设置里有『记忆』标签但点进去无任何配置项」（9/3 至今一直未真正解决）。两个子代理并行调查，A 子代理**无头 Chrome 实机复现 + 内核源码双重定案**：

### 根因：React #290（`Element ref was specified as a string`）
- `client/settings.jsx` 的 `KeyInput` 组件把 **React 保留属性 `ref` 当普通 prop** 传字符串（`ref='MEMORY_EMBEDDING_API_KEY'`）→ 元素创建即抛 #290。
- 内核 `dsh-client-ui-renderer` 的 SlotErrorBoundary 把崩溃的 settings.section entry **abdicate 永久退休**（导航列表用 raw entries 不排除 abdicated）→ 「标签还在、内容区永久空白 `<div data-slot-error>`」，直到整页重载重新注册。**每次点开都崩**，故重启依旧。
- 实机 console：`slot entry crashed in 'settings.section': Minified React error #290 (args[]=MEMORY_EMBEDDING_API_KEY)`。
- **修复**：`KeyInput` 的 `ref` prop 改名 `keyRef`（定义 + 函数体 + embedding/reranker 两处调用点）。教训：自定义组件永远不要用 `ref`/`key` 当 JSX prop 名。

### 附带修复（调查发现，密钥功能从未生效）
- **credentials API 形态全错**：官方为 `describe([ref])` / `set(ref, value)`（返回 `{ok, value:{[ref]:{configured,writable}}}`）；dsh-memory 此前用 `describe({refs:[ref]})` / `set({ref,value})` + 多层 `result.…` 解包 → 被 try/catch 兜住不崩但**密钥永远显示未配置、保存从未成功**。4 处调用全部改为官方形态（KeyInput×2 + refiner 密钥区×2）。
- **ErrorBoundary 兜底**：给 `MemorySettingsSection` 外包自家 `SettingsErrorBoundary`（显示具体错误 + 重试按钮）——即使未来再有渲染异常，也不再静默空白/abdicate，且错误可读。

### 验证
- client bundle 重建（90801 B）；双副本 md5 同步；版本 0.9.29 → 0.9.30。
- ⚠️ 生效方式：前端刷新页面（或重启 EAC）后点「设置 → 记忆」，应能看到完整表单；密钥卡片应显示真实「已配置」状态。
- 遗留（未处理，待单独评估）：`~/.dsh/.credentials.yaml` 的 `version:` 是数字而官方期望字符串，dsh-credentials-local 持续报 TypeError——不影响本修复，但可能让 credentials RPC 行为异常，后续单独跟进。

## v0.9.29 — 交叉审查修复批（v0.9.25~28）：minScore 量纲失配复发 + 凭据段状态机注释边界 + rerank 熔断（2026-09-08）

子代理交叉审查（范围 4d445b0..834d93f）结论「可发布、无 P0」，P1×2 + P2×1 全部修复：

### P1-1：rerank 激活后 minScore 量纲失配复发（v0.8.3 教训镜像）
- **现象**：rerank 融合分尺度 [0,1]，而 `injectMinScore` 0.02 是 RRF 量纲（~0.05）——按融合分后置过滤时，rr=0.05 的噪音候选融合后 ~0.69，**把 minScore 调到 0.3 都滤不掉**，质量旋钮失灵。
- **修复**：minScore 门槛**前移**到 rerank 之前，按（加权）RRF 分过滤一次；rerank 只负责精排不再承担召回过滤（门槛语义 = 召回证据量）。rerank topK 候选与融合（含 boost norm）全部基于过滤后的 `passGate`。
- **守护**：test-embedder 新增——rerank 全给低分 + minScore 0.05 → 结果为空且不触发 rerank；minScore=0 仍走融合（2 项）。

### P1-2：readCredential records 段状态机被顶格注释行提前关闭
- **现象**：records 段内的顶格 `#` 注释行被当作「顶格新键」→ 段提前退出 → records 字段（secret 等）进入键匹配；键名与 records 字段名相同时（apiKeyEnv 可任意命名）会把浏览器会话凭据当 API key 发出。真实文件无注释未触发。
- **修复**：注释行（顶格/缩进）直接跳过，不扰动段状态机、不参与匹配。
- **守护**：test.mjs 新增 records 内顶格注释场景 2 项（secret 仍不泄漏 / refs 键读取正常）。

### P2-1：rerank 失败无熔断
- 失败后每次检索全量重试（最长 8s 超时挂起 + warn 刷屏）→ 置 `rerankCooldownUntil` **5 分钟冷却**，期间跳过 rerank 直接 RRF 顺序；警告注明熔断。
- **守护**：test-embedder 新增熔断用例 2 项（失败置冷却 / 冷却期内不再调用且结果非空）。

### P3 顺手
- embedder.js rerank 判定补 `enabled !== false` 防御（存在即启用契约下显式禁用仍被尊重）。
- store.js boost 加权补 NaN/非数防御（视为不加权）。

### 验证
- 13 套 264 项全绿（新增 8 项）；版本 0.9.28 → 0.9.29；副本 `lib/store.js`/`lib/util.js`/`lib/embedder.js` + package.json md5 同步。
- ⚠️ 与 v0.9.27/0.9.28 一同重启生效。

## v0.9.28 — P0.1 画像召回加权：store.search 类型 boost，注入路径画像弱命中不再被碾压（2026-09-08）

ROADMAP v0.10 P0.1（画像类记忆注入加权）落地——8/23 排查注入问题时定位的已知缺陷（mem-433c7806）：「查丹道记录」注入回图谱治理记录这类答非所问，根因是画像类 content 短/关键词少，RRF 里被含泛词的长记忆靠多路命中碾压。

- **store.search 新增 `boost` 参数**：`boost: { profile: 3 }` 按记忆 type 放大排序分。加权时机在 rerank 候选选取**之前**——被抬升的画像才有机会进精排 topK 与 minScore 门槛（弱命中 ×3 后 0.008~0.016 → 0.024~0.048，越过 0.02 注入门槛）；与 reranker norm 交互自洽（maxRrf 含加权分，融合公式归一化后权重自然传导）。类型批量查询走 `IN` 分块（≤200/批），无 N+1。
- **仅注入路径生效**：`pipelines/inject.js` pre-step 检索传 `boost: { profile: 3 }`（画像跨项目在 global scope，检索本就含 global 公共层）；`memory_search` 工具/预热直取等一律不传 → 零行为变化。
- **守护测试**：test.mjs 新增第 9 节 7 项（无 boost 长记忆排前基线 / boost 后画像升至首位 / 分数精确 ×3 / 其他类型不受影响 / 高门槛 0.05 无 boost 画像被滤 / boost 后过门槛 / 不相关类型 boost 不改排序）。
- **验证**：13 套 256 项全绿；副本 `lib/store.js` + `lib/pipelines/inject.js` + package.json md5 同步；版本 0.9.27 → 0.9.28。⚠️ 重启生效后可用注入日志观察画像命中占比（P0.1 验证项）。

## v0.9.27 — LLM 跑题输出加固：严格 JSON 抽取共享化 + 强化重试一次（2026-09-08）

v0.9.25/26 重启验证时实测画像蒸馏：**LLM 链路已通（reasoningEffort off 生效，模型有实质输出），但输出自由叙述而非 JSON**（`Unexpected token '）', ..."使用本地量化模型"...`）——关推理后部分模型不再自觉守 JSON 格式。

- **修复**：`refiner.js` 新增共享 `llmStrictJson(ctx, cfg, prompt, system?)`——fence 剥除 + JSON.parse，**首次非 JSON 用强化系统提示重试一次**（「只输出合法 JSON 本体」+ 附上上次解析错误），两次失败才抛错（调用方各自降级：提取→规则路径，蒸馏→空结果）。`extractWithLlm` 与画像蒸馏（housekeeping.js）统一走此函数，消灭两份重复的 stream/fence/parse 代码。
- **测试**：`test-profile.mjs` 新增第 6 节 4 项（跑题→重试成功两次调用 / 重试系统提示强化 / 附带解析错误上下文 / 两次失败抛错）；26 项全绿。
- **验证**：全量 14 套无回归；副本 `lib/refiner.js` + `lib/tools/housekeeping.js` + package.json md5 同步。

## v0.9.26 — reranker 装配 bug：index.js 组装丢 enabled + embedder.js 判定错位 → reranker 从未创建（2026-09-08）

v0.9.25 重启验证时发现：凭据修复后嵌入已恢复 remote 4096 维，但 init 仍 `reranker: null` 且无任何警告（enabled=true、key 可读、无降级 warning 三态并存）。

- **根因（比凭据更深的装配 bug，自 embedding seam 引入起就存在）**：`lib/index.js` 组装传给 `createEmbeddingServices` 的 `rerank` 参数时，在 `rkCfg.enabled ? {...}` 分支里**剥离了 enabled 字段**（只传 model/baseUrl/apiKey）；而 `lib/embedder.js` 的启用判定是 `if (cfg.rerank?.enabled)` → 对象上没有 enabled → **恒 false → reranker 永不创建**。与密钥、开关、GUI 均无关——v0.9.19 修 GUI 保存、v0.9.25 修凭据读取，都被这一层挡住。
- **修复**：`embedder.js` 判定改为「`cfg.rerank` 对象存在即启用」（调用方已把关开关，注释固化该契约）；`index.js` 组装对象补 `enabled: true` 透传（双保险）。
- **测试**：`test-embedder.mjs` 新增 2 项守护（rerank 对象不带 enabled 字段时也创建 reranker / 缺省不创建）；19 项全绿。
- **验证**：v0.9.25 全部 14 套 247 项基础上重跑相关套件无回归；副本 `lib/embedder.js` + `lib/index.js` + package.json md5 同步。
- ⚠️ 需再次重启 EAC：init 预期 `reranker: remote`（Qwen3-VL-Reranker-8B / 硅基流动），注入检索自此带后置精排。

## v0.9.25 — 双静默故障修复：凭据 refs 嵌套读不到 + 蒸馏推理吞 token（2026-09-08）

用户要求盘点项目现状，审计运行日志发现两个**长期静默**的链路故障（均无 GUI 提示、均不影响主流程存活，属"只有查实际链路才会发现"的第三例）：

### ① 凭据读取失效 → 嵌入/重排长期降级 rule
- **证据链**：`dsh-web.log` 持续 `未配置 embedding apiKey，跳过 remote` → `已降级到 rule embedder`；生产库 init 记录全部 `embedder: rule（dim 256）`、`memory_stats.rerank: false`；而 settings.yaml `reranker.enabled: true`、凭据文件 `MEMORY_EMBEDDING_API_KEY/MEMORY_RERANK_API_KEY` 都在。
- **根因**：EAC 新内核（0.1.2-alpha.1）把 `~/.dsh/.credentials.yaml` 改写为 `version:1` + `refs:`/`records:` 嵌套结构（密钥行二级缩进），插件 `readCredential()` 用"行首 `startsWith(键名:)`"只匹配顶格 → **全部返回 undefined**（node 复现三键全 undefined）。即语义检索这几周一直是 256 维哈希相似度。
- **修复**：`readCredential(name, filePath?)` 逐行 trim 匹配 + 跳过 `records:` 段（不误读非密钥凭据），兼容 refs 嵌套与旧平铺两种格式；顺手清理死代码；可选文件路径参数便于单测。
- **可见性修复**：`createEmbeddingServices` 的降级 warnings 并入 `store.log('info','init')` 事件 detail——以后嵌入/重排降级在 GUI 记忆日志直接可见，不再只躺 console。
- **同源修复**：`test-embedder.mjs` / `test-record.mjs` / `rebuild-graph.mjs` 三处读 key 的正则同样是顶格匹配 → 真实 API 测试**一直在静默跳过**；改为 `^\s*` 后实测 remote 连通（Qwen3-VL-Embedding-8B **4096 维**）。
- **测试**：`test.mjs` 新增第 8 节 6 项（refs 嵌套命中/reranker 键/records 段不误匹配/缺失键/旧平铺/空值）；全量 14 套 247 项绿。

### ② refiner 蒸馏 100% 失败 → LLM 提取从未成功
- **证据链**：`dsh-web.log` 自 v0.9.21 provider 迁移起全是 `LLM 提取失败，降级规则路径: Unexpected end of JSON input` / `LLM 未返回内容`，成功标记 0 条。
- **根因**：`refiner.js` / `housekeeping.js`（画像蒸馏）调 `ctx.llm.stream()` **未传 `reasoningEffort`** → deepseek-v4-flash（supportsReasoningEffort）走默认推理档位 → `maxTokens: 800` 被 reasoning_content 吃光 → 正文空或截断 → JSON.parse 必败。
- **修复**：schema 新增 `refiner.reasoningEffort`（默认 `'off'` = 关思维链直出 JSON，内核 `reasoningEfforts.off → null`）；`maxTokens` 默认 800 → 1200；两处 LLM 调用在配置含 effort 时透传（缺省不传，向后兼容旧配置/不支持 effort 的 provider）。
- **测试**：`test-profile.mjs` 新增第 5 节 4 项（extractWithLlm 传参：reasoningEffort=off / provider-model-maxTokens 透传 / 缺省不传）；画像蒸馏 mock 断言 stream opts（2 项）；22 项全绿。

### 验证与收尾
- 全量 14 套测试绿：test 22 + phase2 18 + phase3 21 + housekeeping 30 + events 21 + incremental 21 + update-append 9 + edge-types 15 + keyword-filter 8 + embedder 17 + profile 22 + crash-safety 10 + inject-pipeline 29 + record 8/0（含真实 remote 4096 维语义对比不弱于 rule）。
- 版本 0.9.24 → 0.9.25；副本 `util.js`/`index.js`/`config.js`/`refiner.js`/`tools/housekeeping.js` + package.json md5 同步（web + web-desktop 双副本）。
- ⚠️ 重启 EAC 后预期：init 日志 `embedder: remote（dim 4096）` + `reranker: remote` → 全库自动重嵌入迁移 + 主题聚类重跑（rule 时代 370+ 主题碎片化应回落）+ refiner 首次成功；随后可做 reranker A/B（ROADMAP P0.2 收尾）。

## v0.9.24 — 步距节流按 agent 真实步数：每 10 步必检，自主长任务按步注入（2026-09-04）

用户要求：插件自动检测 agent 运行，**每 10 步进行一次检索**（"这个会话 75 步，理论上应有约 7 次主动注入"）。改动：

- **步数来源改为 agent 会话真实步号**：弃用闭包计数器（插件重载清零、多 agent 混用一个计数、与界面步数对不上），改为 `agentStepCount()`——数 `agent.session.events` 里 `step/start` 事件数 + 1（pre-step 触发时当前步尚未 append）。与 GUI 显示的步数一致；插件热重载不清零；主 agent 与 subagent 各自独立计数，互不干扰。
- **stepInterval 默认 2 → 10**：`stepInterval=10` 即"步 1 首检 + 之后每满 10 步必检"（步 11/21/31…），75 步会话 → 8 个检索注入点 = 1 次首检 + 7 次满 10 步（≈ 用户的 75/10=7 次估算，多出的 1 次是首步立即注入）。
- **签名去抖退役，步距到必检**：原"query 相同即跳过"会挡住"每 10 步重检索"（自主轮次工作上下文不变时永不重检）；改为纯步距节流——步距到就重新检索（同 query 也查，因为库里可能刚涌进新记忆），重复注入由注入块 hash 去抖兜底（内容没变不刷屏）。
- **日志加 `step` 字段**：每次 inject 记录步号，用户可直接对账"75 步 → 注入点分布"。
- **测试**：`test-inject-pipeline.mjs` 23 → 29 项：mock 改为"同一 agent 实例 + 每步 push step/start"对齐真实时序；新增步距到同 query 必检注入、`stepInterval=10` 长任务节奏（75 步 → 注入于 1,11,21,31,41,51,61,71、日志 step 全对上）。
- **验证**：14 套测试全绿；副本 `lib/pipelines/inject.js` + `lib/config.js`（默认值）md5 同步；重启 EAC 生效。

## v0.9.23 — 自主轮次注入回归：不需要用户消息也能自动注入相关记忆（2026-09-04）

v0.9.22 修复"幽灵轮次"后用户指出原始设计意图：**注入不该依赖用户消息**——goal 长任务、后台自主轮次（AI 自己干活时）也应每走 N 步自动注入相关记忆。排查发现这条路从未走过：

- **历史事实**：`if (!text) return next()` 守卫（`text` 来自 `extractUserText`，只认 `source.kind === 'user'` 消息）一直存在，而 goal-round-driver 的自动轮次消息 `source.kind === 'goal'`、工具结果步无 user 消息——自主轮次 pre-step 的 query 恒为空，**缓存去抖链之外还有一堵隐形的"无用户文本即跳过"墙**。所有 inject 日志的 query 都是用户原文，佐证自主轮次从未注入过（与 v0.8.3 的 minScore 量纲失配同类：只能靠检查实际链路有没有触发发现）。
- **实现**：新增 `util.extractWorkText(agent, limit)`——query 兜底：从 `agent.session.events` 逆序取最近的 `user/message` 与 `assistant/message` 文本（跳过插件注入块，避免自引用）拼成工作上下文（≤800 字）。注入函数改为 `extractUserText(claimed) || extractWorkText(agent)`，两者皆空才跳过。
- **节流语义归位**：`currentStep++` 恢复为每次 pre-step 步进（count 所有步，含工具/自主步）——v0.9.22 修掉的"记忆块独立 step 虚增步数"已不存在，所以按真实步数计不虚增，`stepInterval=2` 恢复"每 N 步全量重检索"的原始语义（config-manual 记载）。连续两个用户轮次夹一个工具步 → 两轮都注入（3b 测试钉死）。
- **注入方式保持 decision 合并**（v0.9.22）：自主轮次注入块与 context 同一步生成，模型把记忆当上下文继续工作，**不会产生幽灵轮次**（next-step 队列始终为空，turn 正常收尾）——修复方案反而是自主注入变安全的必要条件。
- **测试**：`test-inject-pipeline.mjs` 15 → 23 项：新增自主轮次注入成功（query 含最近 assistant 工作内容+历史任务）、无 session 不注入、会话仅注入块不注入、无文本步计数。
- **验证**：13 套测试全绿；副本 `lib/pipelines/inject.js` + `lib/util.js` md5 同步；重启 EAC 生效。

## v0.9.22 — 注入"幽灵轮次"修复：记忆块不再让模型多答一轮（2026-09-04）

用户反馈：**每次 AI 回复完之后，记忆插件把记忆注入进来，AI 又接着回答一轮**。调查定位（先在引擎侧取证，再改插件侧）:

- **完整触发链**（dsh-agent-loop `turn()` 循环 + dsh-memory 注入方式共同导致）：
  1. 用户消息 → `agent/pre-step`（step 1）→ dsh-memory 检索命中 → 调用 `payload.agent.inject(记忆块)`；
  2. `agent.inject()` 实现为 `send(input, "next-step", false)`——把记忆块塞进 **next-step 队列**（不唤醒，因为 agent 正在跑）；
  3. step 1 的模型生成结束（`turnEnds` 已置位），但 turn 循环末尾 `if (turnEnds && inbox.nextStep.length === 0) break` 检查发现 **nextStep 队列非空 → 不结束**，`target = "next-step"` 继续循环；
  4. step 2 的 `agent/pre-step` claim 到记忆块——dsh-memory 的 `extractUserText` 只认 `source.kind === 'user'`（记忆块是 plugin）→ 不注入、`return next()` 原样放行；
  5. 记忆块被 append 进 session，模型**被迫再生成一轮**"接着回答"记忆块。
  - GUI 观感即"AI 回复完 → 记忆块冒出来 → AI 再答一遍"。注入日志只有一条（21:26:14，query=用户原文），佐证记忆块不是第二次检索注入，而是同一次注入被排到下一步消费。
- **修复**：弃用 `agent.inject()`，改为 **waterfall 链内合并**——`await next()` 拿到底层 decision 后 `return {...decision, messages: [...decision.messages, 记忆块]}`。记忆块与 claimed/context 同一 step 内 append + 生成，next-step 队列不再被塞东西，turn 正常结束，模型只答一轮。此模式与官方先行者 `dsh-agent-instructions` 的 pre-step 插入完全一致（它也是 `next()` 后改 `decision.messages`）。reject 决策原样透传。
- **节流语义微调**：`currentStep++` 从"每次 pre-step"移回"有真实用户文本的 step"——此前记忆块独立 step 虚增步数，让 `stepInterval=2` 形同虚设（几乎每轮都注入）；修复后按真实用户轮次计数，每 2 轮注入 1 次（可调 settings `stepInterval=1` 恢复每轮）。
- **新增专项测试** `test-inject-pipeline.mjs`（15 项）：decision 合并主行为（用户+context+记忆块同一步、溯源 form=recall）、签名去抖、步距节流+恢复、blockHash 去抖、无文本/空检索/reject 守卫、注入日志。agent mock 故意不提供 `inject` 方法——回归到 `agent.inject()` 会 TypeError 直接暴露。
- **验证**：全 12 套测试绿（含既有注入行为未破坏：test-crash-safety 10 项事件挂载、test-events 21 项等）；副本 `lib/pipelines/inject.js` md5 同步；重启 EAC 生效。

## v0.9.21 — EAC 5.3.6 适配：新内核（dsh 0.1.2-alpha.1 / cordis 4.0.1）兼容（2026-08-31）

EAC 桌面端升级 v5.3.6（内核 dsh 0.1.2-alpha.1 + cordis 4.0.1 + dsh-llm/settings/tools 0.1.2-alpha.1）后全面适配。全过程与对照见 [`eac-5.3-adapt-plan.md`](eac-5.3-adapt-plan.md)。

- **挂载恢复（运维行为）**：EAC 更新后 `web-desktop/cordis.patch.yml` 重写，dsh-memory 的 insert 条目被移除（登记与挂载状态不一致）；按 09-01 备份补回条目（config 只放稳定默认，运行时以 settings.yaml 用户层为准）。**升级 EAC 后需检查挂载点是否还在**（registry 只记安装档案，patch 行是 cordis 加载依据）。
- **settings 暴露机制换代**：删除 `lib/settings-expose.js`（apiproxy `WEB_SETTINGS_NAMESPACES` 白名单自愈 hack）。0.1.2-alpha.1 内核已官方暴露全部已注册命名空间（`dsh-api-settings-controller` describe()），hack 的目标包 `dsh-host-apiproxy` 已不存在；README「必要前置」章节改写。
- **client 注入清单精简**：`dsh.client.inject` 从 5 包减为 3 包——`@deepseek-ai/dsh-client-runtime` 在新内核已不存在（client 注册表对 missing bundle 会整体 FAILED，属必须修项）；`@deepseek-ai/dsh-api-remotes` 已变为 host BFF 包且 client 端未使用，一并移除。client 端 `inject` 数组同步去掉未用的 `remote`。
- **供应商目录数据源适配（GUI）**：旧 `api.llm.providers/models` Remote 端点已移除（新内核为 `remoteDiscoverModels` 单方法）；settings.jsx 改为从 `llm-pi-ai`（providers 字典）+ `llm-deepseek`（deepseek-official 单路由）两个命名空间推导供应商/模型预设；密钥引用自动跟随选中路由的 `apiKeyEnv`（deepseek-official → `DEEPSEEK_API_KEY`）；命名空间快照加容错（未注册不崩）。
- **refiner 供应商迁移（配置）**：用户配置 `refiner.provider: opencode-go` 在新内核无对应 route（蒸馏每次失败静默降级规则路径）；迁移为 `deepseek-official`（llm-deepseek 路由，模型 `deepseek-v4-flash` 在其目录内，凭据 `DEEPSEEK_API_KEY` 已存在，零新增配置）。
- **session/event 轮次兼容（后端）**：0.1.2 内核 `user/message` 事件 data 直接是 UserMessage（无 turn 字段），write 管线按轮次聚合会全部并入同一桶；新增每会话 `lastTurn` 兜底（turn/start / assistant/message / turn/end 携带的显式 turn）。
- **声明与契约**：`package.json` 增加 `engines.dsh: >=0.1.2-alpha.1`（EAC 市场/更新器门槛）；peerDependencies `>=0.1.0` 对 `0.1.2-alpha.1` 满足 semver（同 major.minor 才比较 pre-release），无需改动。其余核对兼容项（零改动）：cordis 4 的 ctx.on/inject/provide、`agent/pre-step` waterfall（全路径 return next()）、`createUserMessage`（`form:'recall'` 运行时无校验）、`ctx.llm.stream`、`settings.register`、`webServer.register`、`workspaceRegistry`、`defineTool` 形状、插槽名 `settings.section`/`sidebar.footer.action`。
- **测试环境（开发备忘）**：仓库 node_modules 的 `@deepseek-ai`/`schemastery`/`cosmokit` 用 junction 指向 EAC 内核依赖（dsh-desktop/node_modules）后，11 套测试全绿（含需副本环境的 test-profile 16 项 / test-crash-safety 10 项，验证 21 个工具与三个事件钩子在 0.1.2-alpha.1 下注册成功）。
- **client 收录根因修复（追加）**：重启后设置项不出现——client 注册表（`dsh-client-modules`）的 `nearestPackage()` 要求 **package.json 的 `name` 字段 === loader 条目名**，本包名是 npm 发布名 `dsh-advanced-memory` 而目录/挂载名是 `dsh-memory` → 校验失败被**静默跳过**（无任何日志），boot graph（`__DSH_BOOT__.entries`）里第三方插件都在唯独缺 dsh-memory。修复：本地包名改为 `dsh-memory`（package.json + package-lock）并同步副本。⚠️ 教训：**本地复制式安装的 DSH 插件，包名必须与目录名/挂载名一致**，否则 client 端（设置面板等 GUI）静默消失；若走 npm 市场发布则需保持包名=挂载名一致再发布。

## v0.9.19 — reranker 启用开关保存 bug 修复：GUI 点开关终于能落盘（2026-08-25）

用户反馈"重排模型和嵌入模型供应商一致，我记得已经配置好了"但日志 `reranker: null`。排查：
- **根因**：settings GUI 已有「启用重排」开关渲染，但保存逻辑只写 `RERANKER_FIELDS`（provider/model/baseUrl/apiKeyEnv/topK/minCandidates/rrfWeight），**漏了 `enabled` 分支**——用户点开关，改动被静默丢弃（与 8/24 patch.yml 固化 0.2 同类的"配置链路静默断点"）。
- **修复**：reranker 保存块补 `drafts['reranker.enabled']` 分支（照 housekeeping.enabled 先例）；GUI 点「启用重排」即 live 生效（applies: 'live'，无需重启）。
- **顺带**：用户侧 settings.yaml 已补 `reranker.enabled: true`；密钥 `MEMORY_RERANK_API_KEY` 早已存在于凭据文件。重启或 GUI 点开后，init 日志将由 `reranker: null` 变为 `reranker: remote`（Qwen3-VL-Reranker-8B / 硅基流动 / baseUrl 跟随嵌入端点 / RRF+重排融合 w=0.7）。

### 验证
- bundle 重建 87501 B，web-desktop 副本 md5 同步；10 套测试不受影响（纯 client 改动）。
- 版本 0.9.18 → 0.9.19；重开记忆设置面板生效（开关状态即当前生效值）。

## v0.9.18 — 图谱节点配色重做：告别"深蓝灰一坨"，类型色 + 色相抖动 + HSL 年龄压暗（2026-08-23）

用户反馈图谱节点"很多都是深蓝色，不好看、缺乏辨认度"。根因：**96% 的记忆无主题（208/217）**，前端 `colorOf('')` 全部落到灰色 `#888`，再经 RGB 乘法压暗 55% → 深色背景上一整片同色节点。

- **无主题节点按类型上色**（高区分度第一维）：note=天青蓝 / decision=琥珀 / preference=紫 / lesson=珊瑚红 / profile=翠绿 / legacy 兜底蓝灰；实测 169 节点分布：decision 114、note 25、lesson 16、profile 6 各归其色。
- **同类型色相抖动**：无主题节点按 id 哈希确定性 ±12° 色相微移——114 个 decision 不再同色一坨，琥珀↔橙间渐变；同 id 永远同色。
- **strength 明度微调**（次级维度）：strength 0.1~1.3 → 明度 ±10，节点再有层次。
- **年龄压暗重写为 HSL 明度压缩**（原 RGB 乘法会扭曲色相感知）：色相/饱和度永不失真，压暗上限 55% → 40%，"色浅新 · 色深旧"语义保留但旧节点依然认得出是什么颜色。
- **主题色板升级**：手工 12 色（含棕灰暗色）→ 程序生成色相均匀 14 色 + 相邻明度交替，环形布局相邻扇区天然亮暗错开；`pickColor` 统一两处逻辑（画布 + 详情面板标题）。
- **底部图例**：新增类型色图例（仅显示库中实际存在的类型），提示"无主题默认按类型上色"。

### 验证
- 10 套测试 165 项全过（纯前端渲染改动，后端零改动）。
- 真实库数据模拟：169 节点最终色从 1 种 → **84 种**；10° 色相桶覆盖 20°~210° 多点。
- 版本 0.9.17 → 0.9.18；bundle 87366 B；部署副本 md5 同步；**重开图谱面板生效**。

## v0.9.17 — 图谱实时持续物理（永不冻结），取代 idle 呼吸（2026-08-20）

用户澄清核心诉求：**要整个图谱的力导向动画实时持续进行**（像活系统），而不是"物理收敛 1 秒后冻结 + 只留微呼吸"（idle 浮动被多轮修正仍"只有拖动才动"）。

- **实时持续物理**：`loop` 每帧都 `step()`（不再冷却停帧），alpha 低活跃度地板 **0.02** 保底——力导向永不停止、缓慢弹性律动。
- **打开即收敛**（保留 warmup 收敛）：打开瞬间已在平衡位，之后从低温平滑律动，**无 v0.9.13 的高频抖动**（那次是未收敛+0.028 地板导致）。
- **移除 idle 呼吸机制**：删 IDLE_SCREEN/相位频率/sx/sy 显示坐标，渲染与命中回到物理坐标（消除"两层坐标"复杂度）。
- 拖动/缩放照常（拖动时 alpha 抬升、阻尼 0.11），松手回到持续律动。

### 验证
- 12 套测试 202 项全过（纯前端渲染）。
- 版本 0.9.16 → 0.9.17；bundle 85496 B；重开图谱面板生效。规模提醒：实时物理每帧 O(n²)，数百节点流畅，数千节点建议后续加稀疏化。

## v0.9.16 — idle 呼吸改为"屏幕恒定幅度"（任意缩放都可见）（2026-08-20）

v0.9.15 反馈仍"只有拖动才觉得在动"——根因：idle 浮动加在**世界坐标**，而全景 fit 后缩放 k 常 <1，3.2 世界 px × k ≈ 1~2 屏像素，肉眼无感。

- **屏幕恒定幅度**：`IDLE_SCREEN = 6`，实际浮动量 = `6 / transform.k`（世界单位）——不管缩小到全景还是放大到局部，屏上都恒定 ±6px 的缓慢蠕动。
- **频率放慢**：0.18~0.42 rad/s——慢而优雅，无高频抖。
- 打开即平衡（v0.9.15 的收敛预热）保留。

### 验证
- 12 套测试 202 项全过（纯前端渲染）。
- 版本 0.9.15 → 0.9.16；bundle 85941 B；重开面板生效。

## v0.9.15 — before 存量改判落库 + 图谱打开即平衡/常驻动效可见（2026-08-20）

### ① before 存量改判落库（沿用 reclassifyBefore）
- 生产执行 `reclassifyBefore({apply:true})`：活跃 before 141 → **保留真演化 43 / 改判 mentions 54 / 真无关停用 44**（valid_to 置位、历史可查）。假演化不再以 before 形式存在：有稀有实体共现的变**灰点 mentions**、纯泛词沾边的**停用**。
- 结果已记入记忆 mem-2a016ceb（评估哨兵续接）。

### ② 图谱动效修正（用户两轮反馈收敛）
- **打开即平衡**：预热由"固定 140 步"改为**跑到力导向真正收敛**（`alpha<0.006` 或 800 步封顶）——点开面板瞬间节点已在平衡位，fit 全览=最终布局，不再从固定位置慢移到平衡。
- **常驻运动"看得见"**：idle 呼吸浮动幅度 ±1.2 → **±3.2 px**、频率放缓（0.22~0.52 rad/s）——有清晰的缓慢蠕动感，仍平滑无高频抖动；拖动时物理重新发热、浮动归零。

### 验证
- 12 套测试 202 项全过（数据层除外仅前端渲染改动）。
- 版本 0.9.14 → 0.9.15；client bundle 重建（85903 B）；⚠️ 重开图谱面板生效。

## v0.9.14 — 图谱"活而不抖"：idle 低频呼吸浮动（2026-08-20）

v0.9.13 的 alpha 地板持续运动实测反馈：**每个节点高频轻微抖动，视觉不佳**（力导向持续"热"的固有 micro-jitter）。重构动效：

- **物理照常收敛停帧**：去掉 alpha 地板（不再持续加热物理），力导向在 alpha<0.008 后停止 O(n²) 步进（省 CPU）。
- **idle 呼吸浮动接管**：冷却后节点围绕各自的平衡位做**低频正弦浮动**（幅度 ±1.2px、频率 0.30~0.64 rad/s、每节点随机相位），画面永远在动但**平滑无抖动**。
- **显示坐标 = 物理坐标 + 浮动**：边/节点/徽标/标签/命中(hitTest)全部用显示坐标；物理活跃（alpha>0.05，如拖动）时浮动权重趋零，物理主导。
- 拖动/点击/缩放照常加热量，松手冷却后回到呼吸态。

### 验证
- 12 套测试 202 项全过（纯前端渲染逻辑，与数据层无关）。
- 版本 0.9.13 → 0.9.14；client bundle 重建（85852 B）；⚠️ 重开图谱面板生效。

## v0.9.13 — 假演化"归类"而非删除 + 图谱持续运动/打开即布局（2026-08-20）

### ① before 假演化 → 归类到正确类型（不再是"删"）
- 新增 `reclassifyBefore({rareMax, apply})`：把活跃 before 边按真实关系**改判**——
  - 共享 ≥1 稀有实体 → **mentions**（实体共现，weight=共享稀有实体数；UPSERT 幂等，before 停用保留历史）
  - 零稀有实体共享 → 真·无关 → before 停用
  - 真演化（共享 ≥2 或同主题）→ before 保留
- 生产 dryRun：141 条 → 保留 before 43 / 改判 mentions 54（弱共现 weight=1）/ 真无关停用 44。改判后图谱的联系类型更真实（黄色 before 大幅减少，灰点 mentions 承接）。

### ② GUI 图谱：持续运动 + 打开即自动布局
- **打开即自动布局**：预热 40 → 140 步 + fitToView，进面板时节点已在力导向平衡位附近，入场只做淡入放大，不再"从初始位置慢慢爬"。
- **持续运动**：移除"冷却停帧"逻辑，alpha 地板保底（0.028）——图谱一直保持轻呼吸/缓慢移动（如活的一样），不再"定时截止就停死"；拖动照常。

### 验证
- test-edge-types.mjs 扩至 15 项（新增 reclassifyBefore 改判/落库/真演化保留）；**12 套测试 202 项全过**。
- 版本 0.9.12 → 0.9.13；client bundle 重建（85446 B）；⚠️ 需重启 EAC / 重开图谱面板生效；存量改判 await 用户确认后 `reclassifyBefore({apply:true})`。

## v0.9.12 — 关键词→实体治理：refiner 软引导 + 稀有实体硬过滤（2026-08-20）

承接 v0.9.11（假演化 98/140）。根因分账：**连边是规则代码，LLM 是泛词帮凶**（refiner 产出 dsh-memory×21/图谱×7 等话题词当关键词 → graphLink 当实体 → 共享泛标签乱串）。本轮双管齐下治"泛词喂养"：

- **A 卡源头（软引导）**：refiner prompt 收紧——keywords 必须为**具体名词实体**（技术栈/模块/文件名/版本号/专有名词），明令禁止动作泛词、项目话题词、2 字碎片；"宁可 3 个精准实体，不要 10 个泛词"。
- **B 卡下游（硬兜底）**：`pickRareEntities({k=8, rareMax=RARE_MAX})`——剔除停用词/碎片、剔除已被 >8 条记忆共享的高频泛词、按稀有度升序取前 k；`graphLink` 建图统一走此口径（写入管线传全量关键词，由内部稀有化，不再预先 slice 截断导致稀有词被挤掉）。
- 与 v0.9.11 的 before 收紧同口径（RARE_MAX 常量），linkBefore/mentions 自动受益（节点清干净后共享标签自然变稀有）。
- **评估哨兵已入记忆**：基线=假演化 98/140（70%）/涉及 76 记忆；过 1~2 周或 +50 条记忆后重跑 `beforeAudit` 看新写入误报占比是否显著下降。

### 验证
- 新增 `test-keyword-filter.mjs` 8 项（剔泛词/稀有升序/graphLink 硬过滤/单实体与停用词不建）；**12 套测试 196 项全过**。
- 版本 0.9.11 → 0.9.12；⚠️ 需重启 EAC 生效（refiner 改 prompt + store 改逻辑）。

## v0.9.11 — 图谱「多种联系方式」显性化 + before 演化收紧治理（2026-08-20）

用户两点质疑，均为实锤：① 黄线太多=假演化泛滥 ② 记忆间"多种联系方式"在 GUI 根本没体现。

### ① 联系显性化（8 型边真正画出来）
- **EDGE_STYLE 映射表**：8 型边各配颜色/线型（similarTo 蓝实、before 橙、mentions 灰点线、partOf 绿、causes 红、solves 青、supports 黄、contradicts 紫虚）——不再"非蓝即橙"二分。
- **hover 边显示类型**：鼠标悬停在边上显示类型徽标（similarTo 带权重、mentions 带共享实体数）。
- **动态图例**：按当前数据实际出现的边类型列图例（有数据才显示）。
- **mentions 强共现边**：`graph-snapshot` 把"共享 ≥2 个实体 label 的记忆对"投影为记忆级 `mentions` 边（weight=共享实体数）——最大宗的"联系"（生产 2515 条实体共现 → 记忆级 ~29 条强共现）终于可见，阈值过滤防糊。

### ② before 演化收紧（治理假演化）
- **linkBefore 重写**：不再是"共享任意词就串链"——实体须为**稀有实体**（被 ≤8 条记忆共享，超高频泛词如 dsh-memory/记忆图谱 不算演化载体），候选须**共享 ≥2 稀有实体 或 同主题（非空）**；聚合后每方向至多连 1 条（取代 per-label 重复链）。
- **beforeAudit 审计/清理**：逐条评估活跃 before 边（同门槛），dryRun 默认只报告，apply 时把不合格边 valid_to 置位（历史保留）。
- **生产 dryRun 实测**：活跃 before 140 条 → **真演化仅 41 / 假演化 99**（用户怀疑成立）。存量清理待用户确认后 apply。

### 验证
- 新增 `test-edge-types.mjs` 9 项（mentions 快照 / before 真演化 / 单共享/泛词/跨主题不连 / audit dryRun+apply+历史保留）；**11 套测试 188 项全过**。
- 版本 0.9.10 → 0.9.11；client bundle 重建（85457 B）；部署副本 md5 同步；⚠️ 重开图谱面板生效。

## v0.9.10 — 撤销纵深拖尾 + 「+N 更新徽标」+ 更新内容无条件接末尾（2026-08-20）

v0.9.9 拖尾实机观感反馈：太花（每节点一撮右上小点）、延长首段与本体贴太近、纵深观感不达预期。用户拍板：放弃拖尾视觉，改「更新次数徽标」；并明确记忆更新机制——**新内容接在旧内容末尾**。

### ① 撤销纵深拖尾
- graph.jsx 拖尾渲染/配置/视界扩展全部删除；config.js `graphView` 深度字段（depthAngle/trailSegments/trailGap/trailShrink/trailFade）移除；settings.jsx 对应滑块与 NUMERIC_SUB 移除（git 历史可回滚）。

### ② +N 更新徽标
- `versions > 1` 节点右上角画深底金边徽章 `+N`（N = 更新次数，金色呼应年轮）；未更新节点不画；hover/焦点/事件高亮同步；textBaseline 局部设置后复位，不影响后续标签。

### ③ 更新机制：新内容无条件接末尾
- write.js `upsertMemory` 更新分支由「旧的更长则保留旧」改为**无条件把新内容接在旧内容末尾**（`
---
` 分隔，世界线 revision+1 → 徽标 +N 步进）。
- **防重复刷屏**：内容与整条相同、或与上一条已追加片段相同 → 无操作（不追加、不升版本）。
- `upsertMemory` 导出供单测；新增 `test-update-append.mjs`（9 项：短内容也接末尾 / 持续追加 / 重复片段去重 / 无关主题新建）。

### 验证
- 10 套测试 179 项全过；版本 0.9.9 → 0.9.10；client bundle 重建（82385 B）；部署副本 md5 同步；⚠️ 重开图谱面板 / 重启 EAC 生效。

## v0.9.9 — 图谱纵深拖尾视觉（GUI 时间维度三维化）（2026-08-20）※ 已由 v0.9.10 推翻（实测太花）

用户需求：营造视觉纵深——**顶层 = 完整主图谱（所有记忆节点），往下一层层 = 单个节点的"时间延长"**（同方向错开、逐段缩小淡化），多条延长带平行指向同一纵深方向，形成"记忆走廊"。

- **分层语义**：不再是"每层一张完整图谱"——只有顶层是完整图谱；深层每层是**单节点的延长**（每个节点沿同一纵深方向延伸的渐变拖尾，不断缩小淡化）。
- **零联动拖动**：拖尾坐标由节点坐标派生（`node.x + dir * s * gap`）——拖动顶层节点，它的整条延长带天然同向移动（"倒影同向"），无需任何联动手写。
- **新参数**（`graphView` 子对象，GUI 设置面板可调、live 生效）：
  - `depthAngle` 纵深角度（默认 20°；正 = 向右上纵深，越远越往上）
  - `trailSegments` 拖尾段数（默认 4；0 = 关闭纵深）
  - `trailGap` 段间距（默认 26）/ `trailShrink` 逐段缩放（默认 0.78）/ `trailFade` 逐段淡化（默认 0.82）
- **渲染顺序**：先画全部拖尾（深→浅）→ 边 → 节点本体（顶层盖在最前）；焦点/事件高亮/入场动画对拖尾同步生效。
- **fitToView**：全景视界把拖尾最远端纳入，避免光带溢出被裁切。
- 命中/交互不变：拖尾段不参与 hitTest（天然"只能拖顶层节点"）。

### 验证
- 9 套测试 170 项全过（config 扩展纯增量 default，无行为破坏）。
- 版本 0.9.8 → 0.9.9；client bundle 重建（85131 B）；部署副本 md5 同步；⚠️ **需重启 EAC / 重开图谱面板生效**（GUI 参数改动重开面板即生效）。

## v0.9.8 — 图谱派生数据增量构建 + 真向量检索实证（2026-08-19）

用户三连需求：① 记忆库有过期结论需更新 ② 向量语义检索"今天做完" ③ 图谱每次启动全量重建不优雅，要增量。

### ① 记忆库更新（scope 分层旧待办实锤作废）
- 旧的「132 条 100% global、分层从未生效」待办已过时：实测生产库 **162 条**记忆 global 136 / **dsh-memory 23** / **金花的秘密 2**；预热日志 23:28/23:31 正确切到项目 scope（workspaceRegistry fallback 生效）。相关过时记忆已删除，替换为今日实锤决策。
- **真向量语义检索确认为已在生产在线**（非本次新做）：config 默认 `embedding.provider: 'remote'`，生产 embedder=remote（硅基流动 Qwen3-VL-Embedding-8B）**dim 4096**，162/162 记忆全有向量；本次用「无词面重合的语义查询」实测命中 Git 路径/预设类记忆，实证向量路真实生效。

### ② 图谱增量构建（本轮核心改动）
- **主题聚类增量**：新表 `theme_clusters`（簇质心/词频/成员数持久化）+ `memories.cluster_id` 归属标记；`themeMemories({ incremental })` 只处理未归簇新记忆，可跨重启续跑——不再每次启动对全部记忆重聚 + 全量重嵌入。`incremental=false` 保留全量重建（维度迁移/手动）；簇质心维度与当前 embedder 失配（rule↔remote）时自动清簇重聚（含"全部已归簇但维度失效"场景）。
- **事件检测增量**：新增 `detectEventsIncremental`，meta `event_scan_at` 水位线——无新增记忆直接跳过、事件表保持现状；有新增只重建**尾部窗口**（tailFrom = 最早新增时刻 − gapMs 起），旧事件保留。全量 `detectEvents` 保留（测试 / memory_events detect=true 强制重建用）。
- 启动（`lib/index.js`）与管家（`lib/pipelines/write.js`）事件路径切到增量版。
- 备注：升级后首次启动做一次性 onboarding（全量归簇 + 建事件水位线），此后恒为增量。

### 验证
- 9 套测试 **170 项**全过：8 套老回归 149 项 + 新增 `test-incremental.mjs` 21 项（增量主题/事件、水位线跳过、尾部合并、旧事件保留、维度迁移自愈、全量 vs 增量对齐）。
- 版本 0.9.7 → 0.9.8；README/ROADMAP/ARCHITECTURE 已同步；部署副本 md5 校验同步；⚠️ **需重启 EAC 生效**。

## v0.9.7 — 模块结构解耦重构（零行为改动）（2026-08-18）

用户打开代码后提问"是否过于集中、有没有解耦"，经确认做了纯文件级重组（无引入框架、无行为改动）：

- **lib/ 拆分为装配壳 + 单一职责模块**：`index.js` 1778 行 → 253 行，只做装配（settings/init/Web API/管线/工具/ctx.memory）
  - `config.js`（Config schema）/ `util.js`（纯函数：scopeOf/formatNow/注入渲染/消息提取/凭据读取，抽出死代码线）
  - `refiner.js`（LLM 蒸馏）/ `graph-snapshot.js`（图谱快照投影，原直摸 `store.db` 的封装修复点已隔离到该投影模块）
  - `pipelines/`：write（turn/end 沉淀+价值门+去重+管家）、inject（pre-step 检索注入）、preheat（会话预热）——工厂化，依赖（store/getCfg/wsRegistry/logStore）显式注入
  - `tools/`：registerTools 900 行 → 按域拆分为 time / memory / housekeeping / graph + shared（safeRegister/logStore）+ index
- **client/ 拆三文件**：settings.jsx（设置面板）/ graph.jsx（图谱画布）/ logs.jsx（日志面板），`index.jsx` 只留插槽装配
- **顺带**：部署副本陈旧的 embedder.js（缺 v0.8.4 rerank LRU/部分缓存修复）随本次同步为最新
- 验证：8 套测试 149 项全过（与基线一致）；client bundle 重建（81KB 同量级）；git 有提交锚点可回退

## v0.9.6 — 热修复：v0.9.5 埋点作用域 bug（memory_add 等工具 ReferenceError）（2026-08-17）

重启验证时业务发现 `memory_add` 报 "wsRegistry is not defined"——v0.9.5 埋点把 apply 局部变量（`wsRegistry`、`logStore`）用进了**模块级 `registerTools` 函数**的工具闭包，工具 execute 运行时 ReferenceError。

- **wsRegistry**：apply 局部变量 → registerTools 内改用 `ctx?.workspaceRegistry`（inject 已声明）
- **logStore**：apply 局部 helper → registerTools 内自备（`getCfg().logging` 控制 + store.log）
- 影响工具：memory_add / memory_search / memory_housekeeping / memory_events / memory_profile_distill（tool.* 埋点路径全部修复）
- 深挖：v0.9.5 的 tool.* 埋点 + scope 分层依赖 apply 闭包，注册后脱离 apply 作用域——**教训：registerTools 是模块级函数，工具内不可依赖 apply 局部变量，要么传参要么自备**
- 验证：test-profile 16 项（含蒸馏不再崩）+ crash-safety 10/10 + 全量本地回归
- 版本号 0.9.5 → 0.9.6；⚠️ **需重启 EAC 生效**（当前运行中的还是会报错的原版）

## v0.9.5 — 运行日志全透明 + scope 分层根治（workspaceRegistry fallback）（2026-08-17）

用户两个需求：
1. **日志**——"在背后运行了什么我们都要透明地完全看见"
2. 预热仍注入跨项目记忆——查证 v0.9.4 分层**从未生效**：生产库 134 条 100% global（含 v0.9.4 部署后写入的）——根因：**EAC/web 会话没有 cwd**（SessionHeader.cwd 为 undefined），scopeOf 恒返回 global

### 日志系统（背后运行全透明）
- **logs 表**（ts/level/event/scope/detail，惰性裁剪至 maxRows 2000）+ store.log/listLogs
- **全链路埋点**：init（embedder 状态）、preheat（预热种子）、inject（检索 query/hits/picked/分数/scope）、write（沉淀/refiner 蒸馏/降级/valueGate 拦截原因）、housekeeping（去重/老化）、events.detect、links.fix、tool.add/search/housekeeping/events/distill、错误路径
- **`/dsh-memory/logs` API**（limit/level/event 过滤）+ **`memory_logs` 工具**（模型可查）
- **GUI「记忆日志」面板**：侧边栏底部入口（与图谱同槽）→ 全视口毛玻璃面板，3s 轮询实时刷新、级别/事件筛选、暂停/继续、自动滚动、退出键左下角 + Esc
- settings logging 段（enabled/maxRows）

### scope 分层根治
- session.meta.cwd 缺失时 **fallback `ctx.workspaceRegistry`**（会话 → 所属工作区 path basename）——EAC 会话通过 workspaceRegistry 定位项目
- scopeOf(sessionOrAgent, registry)：cwd 优先 → workspaceRegistry → global
- 插件 inject 声明加 'workspaceRegistry'

### 验证
- test-housekeeping 扩至 30 项（日志读写/倒序/过滤/裁剪）；test-profile 加 scopeOf 三态（cwd/registry fallback/global）
- 全部测试通过；client bundle 重建（81KB）；部署副本已同步（md5 校验）；版本号 0.9.4 → 0.9.5
- 注意：重启 EAC 加载 v0.9.5 后，新记忆才会按工作区分层；存量 134 条 global 保持为公共层

## v0.9.4 — 会话工作目录分层（根治跨项目记忆串味）（2026-08-17）

用户实证问题：在 dsh-memory 开发会话里，预热注入的却是机甲 AI 绘画记忆。查证根因：
- 预热在 session-start 执行，此时**没有用户消息**，无法知道会话主题，只能注入"最近记忆"（最近=机甲）
- **画像库 0 条**（profile 类型从未产生）——"画像优先"无画像可优
- **121 条记忆全部 global scope**——无项目隔离
- DSH 会话自带 **cwd**（SessionHeader.cwd 已查证，工具 exec 也有 agent）

### 修复：scope 自动绑定会话工作目录
- **`scopeOf(sessionOrAgent)`**：cwd basename → scope（无 cwd → global）
- **写入分层**：turn/end 沉淀、memory_add 工具按当前会话 cwd 写 scope；**画像（profile）固定 global**（"用户是谁"跨项目适用）
- **检索双 scope**：pre-step 注入、memory_search/list 按 `[当前项目 scope, global]` 查（存量 global 兼容为公共层）
- **预热收窄**：画像全 scope 直取；非画像先取当前项目 scope，不足补 global（存量兼容）
- **存量说明**：global 旧记忆无法自动归属项目（无 cwd 历史），随时间老化/手动清理；**新记忆立即分层**
- **minScore 0.015 → 0.02**：跨领域弱命中更少混入
- 顺手修复存量 bug：**向量路从未做 scope 过滤**（分层后必须）——vecSearch 结果补 scopeMatch

### 验证
- test-housekeeping 扩至 24 项（多 scope 检索/列表互不可见 + 双 scope 公共层）；全部测试 131 项全过
- 部署副本已同步（md5 校验）；版本号 0.9.3 → 0.9.4

## v0.9.3 — 子代理审查修复批（画像 aspect 读回路 / 预热窗口挤压 / 蒸馏幂等）（2026-08-16）

子代理对 v0.9.0~v0.9.2 深度审查（P0 无 / P1×1 / P2×5 / P3×6），全部修复：

### P1-1 aspect「只写不回」→ 补读回路
- memory_list / memory_search 输出加 aspect 字段（渲染展示子域）；图谱快照 nodes 加 aspect
- 删除 updateAspect 死代码；画像维度对模型/GUI 可见可用

### P2 修复
- **P2-1 预热画像被窗口挤压**：画像改为 `list({type:'profile'})` 直取（不再经"最近 50 条"窗口——画像 updated_at 恒为创建时刻，会被近期活跃记忆整体挤出）
- **P2-2 蒸馏无去重幂等**：meta 表 `profile_distilled_sources` 记录已蒸馏源记忆 id，重复调用跳过（画像不重复累积）
- **P2-3 蒸馏坏 JSON 无容错**：与 auto-write 降级路径对齐——解析失败 warn + 返回空结果
- **P2-4 事件筛选陈旧 id 全图灰暗**：effect 检测选中事件已不存在（detectEvents 重建后 id 变更）→ 自动重置 "all"
- **P2-5 events() N+1**：成员单条 JOIN 预取 + 内存分组（快照加载 51 条 SQL → 2 条）
- 顺带：store.list 加 type 过滤参数（预热/工具复用）

### P3 落实
- fixBeforeDirections 保留原权重 + fixed 计数只算真实重建（正确方向已存在时不再虚报）；注释说明逆语义 before 边约束
- node_memories 注释澄清（仅 rebuild-graph 写入）；事件 id 稳定性约定注释
- 预热行展示画像子域（`画像·preference`）

### 验证
- test-profile 扩至 12 项（窗口挤压场景/蒸馏幂等/坏 JSON 容错）；全部测试 130+ 项全过；client bundle 重建（71KB）；部署副本已同步
- 版本号 0.9.2 → 0.9.3

## v0.9.2 — 画像分类（ROADMAP 阶段 B）：记忆的"人物"维度（2026-08-16）

按 ROADMAP 阶段 B 落地用户提出的"画像分类"——关于用户本人的稳定信息（身份/偏好/习惯/背景/沟通方式）单独分类管理。

### 数据模型
- `type` 枚举新增 **`profile`**；memories 表新增 **`profile_aspect`** 列（旧库自动补列，theme 同款模式）
- aspect 子域：identity / preference / habit / background / communication_style
- store.add 支持 aspect 参数（insertMemory 11 列）；get/list 自动带出

### 识别与写入
- **refiner 蒸馏识别**：extractWithLlm prompt 加规则——"关于用户本人的稳定信息 → type=profile + aspect"（与一次性 decision 区分）；输出校验类型白名单
- **memory_add 工具**：type enum 加 profile + aspect 参数（模型可主动记录画像）
- upsertMemory 透传 aspect（merge 路径保留 target 画像子域）

### 会话预热画像优先
- 预热 seed 从"最近 3 条"改为**画像优先**：画像 3 条 + 非画像 2 条（"用户是谁"优先于"最近干了啥"）
- `pickPreheatSeeds()` 纯函数导出可测

### 画像蒸馏（管家期 2）
- **`memory_profile_distill` 工具**：refiner 启用时把散落的 preference/decision 记忆经 LLM 聚合为画像条目（相同属性合并、一次性事件忽略），写入 type=profile + aspect
- refiner 未启用时报错提示（开启独立提取模型）

### 验证
- 新测试 test-profile.mjs 12 项（预热画像优先/aspect 读写/蒸馏 mock LLM 全链路）
- 守护测试工具清单扩至 20 个；全部测试 130+12 项全过；部署副本已同步
- 版本号 0.9.1 → 0.9.2

## v0.9.1 — 图谱关系质量修复（before 方向自愈 + similarTo 收紧 + 主题碎片过滤）（2026-08-16）

生产库图谱审计（104 记忆 / 163 条记忆级边）发现 4 类问题，本轮修复 3 项：

### 修复 1：before 边方向自动修正（4/84 方向倒挂）
- 新增 `store.fixBeforeDirections()`：from 应早于 to；倒挂边断开并重建正确方向；同时间戳无法判定方向的保持不动
- 接管家巡检自动执行（派生数据，重建安全）；生产库验证：**4 条倒挂全部修正，重扫 0 倒挂**
- 根因：历史边（v0.5.x 旧实现）+ linkBefore 边界

### 修复 2：similarTo 建边阈值收紧（0.5 → 0.6）
- 0.5 的 Jaccard 阈值过宽，"同主题≠相似"的记忆大量连边（89 条非孤立记忆平均 3.7 条边，图谱糊团）
- 写入管线（upsertMemory → linkSimilar）阈值收紧，减少糊团边

### 修复 3：主题 label 频次过滤（碎片词不入选）
- 主题 label 生成只取**频次 ≥2** 的关键词——单成员簇的 bigram 碎片（"但这"/"个插"）频次恒为 1，自然过滤
- label 为空 → 图谱节点/事件 label 兜底 type；生产库副本重聚类验证：31 个主题，碎片 label 清零（只剩"热修"这类正常 2 字词）；事件 label 变为有意义主题词（"dsh/dsh-memory""记忆图谱/dsh-memory"）或 type 兜底
- 重启 dsh 后启动流程自动重聚类覆盖旧碎片 theme

### 验证
- test-events 扩至 21 项（倒挂修正/幂等/同时间戳保持/主题频次过滤）；七套测试 120 项全过
- 部署副本已同步（md5 一致）；版本号 0.9.0 → 0.9.1

## v0.9.0 — 事件分类（ROADMAP 阶段 A）：时间+因果的记忆聚簇（2026-08-16）

按 ROADMAP 阶段 A 落地用户提出的"事件分类"——区别于 theme（语义相似）的时间性分类（"这段记忆属于哪件事"）。

### 数据与算法
- 新表 `events`（id/label/start_at/end_at/representative）+ `event_members`（记忆删除级联）
- **时间线扫描（纯 rule，无 LLM）**：sm 按 created_at 排序，相邻两条「间隔 < gapHours（默认 2h）**且**（同 theme 非空 **或** 共享实体 label 交集）」→ 同一事件；否则切新事件（单记忆自成一事件）
- 全量重建 + 事件 id 确定性（`ev-首成员记忆id`，重建稳定）；label = 成员 theme 众数（无 → 首成员 type）
- **踩坑**：共享实体判定初版比 node_id 交集——但 graphLink 的实体节点是记忆私有的（id 含 memoryId），不同记忆同 label 是不同节点 → 改为 **label 集合交集**（node_memories 与 nodes.memory_id 双源合并）
- store 方法：`detectEvents(gapMs)` / `events(limit)` / `eventMap()`

### 接线
- settings 新增 `events` 段（enabled/gapHours）；启动初始化 + 管家巡检（双驱动）自动重建事件；派生数据，不碰记忆本体
- **`memory_events` 工具**：列出事件（label/时间段/成员摘要），detect=true 强制重检测
- **图谱快照**：nodes 加 eventId + events 列表；**GUI 事件筛选下拉**（与时间筛选并列）——选中事件成员高亮、其余降透明度（经 ref 通知画布，不重建模拟）

### 验证
- 新测试 test-events.mjs 14 项（组内聚合/组间切分/同主题/共享实体/孤立记忆/幂等/级联/gap 敏感/空库）
- 七套测试 113 项全过；client bundle 重建（71KB）；部署副本同步（md5 一致）
- 版本号 0.8.9 → 0.9.0

## v0.8.9 — 图谱打开动画：预热模拟 + 立即全景 + 中心扩散显现（2026-08-16）

用户反馈：点开图谱会抖动（环形布局展开），再突然跳变成全景图；期望"一开始就是全景图，从中间向两边平滑快速显现"。

- **预热模拟**：初始化时离线跑 40 步力导向（首帧即接近收敛的稳定布局，消除"环形展开抖动"）
- **立即全景**：fit-to-view 从"模拟收敛后跳变"改为"预热后立即执行"——打开第一帧就是全景，不再有突然缩放
- **中心扩散显现动画**：节点按距视口中心距离延迟显现（中心先亮，向两边扩散，延迟占 0~55% 动画时长），easeOutCubic 淡入 + 半径从 0 放大（700ms）；边整体淡入（350ms）——"从中间向两边平滑快速显现"的预期效果
- 初始 α 0.7 → 0.45（首帧运动更温和）
- 移除 loop 中过时的延迟 fit 条件；client bundle 重建（69KB）并同步部署副本；版本号 0.8.8 → 0.8.9

## v0.8.8 — 图谱面板毛玻璃质感 + 左下角退出键（2026-08-16）

用户反馈 v0.8.7 的 top:56 避让方案露出硬边界，要求：退出键放左下角、背景改毛玻璃、点阵保留。

- **面板回到全屏**（inset: 0）+ **毛玻璃背景**：`rgba(16,16,18,0.72)` + `backdrop-filter: blur(22px) saturate(1.2)`（含 Webkit 前缀）——没有硬边界，下层内容模糊透出，遮挡观感统一
- **退出键移到左下角**（absolute left:16 bottom:16）：彻底远离顶栏不被遮挡；毛玻璃风按钮（半透明白 + blur(10px) + 阴影），文字"退出图谱（Esc）"；Esc 监听保留双路径
- **标题栏简化**：移除右上关闭按钮，只留"记忆图谱"标题，padding-top 44px 避开顶栏（标题不被原生层切掉）
- **点阵保留**：Canvas 内 Obsidian 定位网格不动
- **图例移到右下角**（right:14 bottom:10）：避免与左下角退出键重叠
- client bundle 重建（69KB）并同步部署副本（md5 一致）；版本号 0.8.7 → 0.8.8

## v0.8.7 — 图谱面板避开应用顶栏（关闭按钮被遮修复）（2026-08-16）

用户定位：应用界面顶端栏（EAC 标题栏/顶栏）遮住全视口面板顶部的关闭按钮（v0.8.6 提高 z-index 仍被遮，说明是层叠/原生层问题，光提层级不够）。

- **面板整体下移**：`inset: 0` → `top: 56`（left/right/bottom 仍为 0）——面板从顶栏下方开始，顶栏区域保持应用原样（可点击），关闭按钮与标题栏不再被遮
- **z-index 3000 → 9999**：防其他 DOM 覆盖层（双保险）
- 连带受益：图谱画布内部元素（时间筛选工具栏 top:10、图例 bottom:10）随面板下移自然避开顶栏
- client bundle 重建（68KB）并同步部署副本（md5 一致）；版本号 0.8.6 → 0.8.7

## v0.8.6 — GUI 修复：设置面板滚动 + 图谱 Esc 退出（2026-08-16）

用户反馈两个 GUI 问题：
- **设置面板显示不全**：内容超高（检索注入/功能开关/refiner/嵌入重排/图谱手感/管家共 6 区块）且面板无滚动——根 div 加 `overflowY: auto + maxHeight: calc(100vh - 24px)`
- **图谱全视口面板看不见关闭按钮**：zIndex 1200 → 3000（防覆盖层遮挡）；关闭按钮强化（加大 padding、提亮、加"（Esc）"提示）
- **新增 Esc 关闭**：面板打开时挂 window keydown 监听，Escape → 关闭（关闭按钮被遮挡时的键盘兜底路径），关闭时移除监听
- client bundle 重建（68KB）并同步部署副本（md5 一致）；版本号 0.8.5 → 0.8.6

## v0.8.5 — system_now 时间工具 + 会话预热带时间戳（2026-08-16）

用户需求："让你可以看见现在的实时时间"（模型无系统时钟感知，此前只能靠 bash date）。

- **`system_now` 工具**：模型按需调用获取当前系统时间（local/date/time/weekday/tz/iso/unix），零注入开销、永远新鲜——主方案
- **会话预热加时间戳**：`agent/session-start` 预热块头行带"当前时间：YYYY-MM-DD HH:mm:ss 周X"——会话开始即有时间锚点
- **设计取舍**：不在 pre-step 注入块里加时间——时间每步变化会破坏"稳定块头 + append-only 尾部"的 KV 缓存友好注入原则（去抖失效）；按需工具 + 会话锚点两条路足够
- `formatNow()` 模块级 helper（导出，可测）；test-crash-safety 工具清单扩至 18 项（守护测试 10/10 全过）
- 版本号 0.8.4 → 0.8.5；部署副本已同步

## 起源：需求（2026-08-14 上午）

用户原话："我一直想要做一个插件可以自动注入当前 agent 在做的事情相关的记忆，不需要用户的消息就可以触发注入。"

DSH 提供的原生机制恰好匹配：`agent/pre-step` 每步触发（不依赖用户消息）+ `agent.inject()` 排队模型可见上下文。当天即完成第一版原型并跑通闭环。

## v0.1.0 — dsh-auto-memory（原型，同日）

- 关键词匹配 + JSON 文件存储（`~/.dsh/auto-memory.json`）
- turn/end 无条件沉淀整轮、pre-step 内存遍历注入
- **验证了核心闭环**：写入（turn/end 落盘）→ 检索（关键词命中）→ 注入（agent.inject）全链路工作

## 设计期（同日，pro 模型协作）

- 用 DSH workflow 子代理 + `deepseek-v4-pro` 产出 1406 行完整方案：分层记忆（ep/sm）、SQLite 底座、记忆图谱（节点三型 + 边八型）、功能开关矩阵（§16）、**时间维度世界线**（§17，"四维虫子"比喻）
- 关键设计决策（评审阶段追加）：KV 缓存友好注入、中文检索（trigram + 子串兜底）、评测与注入审计、权威性闭环、settings 白名单、写冲突语义

## v0.2.0 — dsh-memory 阶段一（SQLite 基线）

- `node:sqlite` 单库（WAL + STRICT）：memories / memory_versions / memories_fts(FTS5 trigram) / nodes / edges
- 分层数据模型 + 价值门 + Jaccard 去重合并
- 注入侧：步距节流 + 签名去抖 + 注入块 hash 去抖 + 防循环窗口 + token 预算
- 工具面：memory_add/search/forget/list/stats
- 存量 auto-memory.json 一键迁移（17 条）
- **踩坑 1**：`ctx.tools` 访问需 `export const inject = ['tools']`（"cannot get property tools without inject"）
- **踩坑 2**：defineTool 的 JSON schema 每个 object 节点必须显式 `additionalProperties`

## v0.3.0 — settings 驱动 + refiner + GUI

- 配置改为 `ctx.settings.register('memory', …)` 三源合一（默认 ← base ← 用户层，**live 生效**）
- refiner：独立 LLM 蒸馏提取（turn/end 异步调 `ctx.llm.stream`，失败降级规则路径）——解决"原始高噪声信息注入回去"
- GUI：client 双面插件（`dsh.client` 声明 + esbuild 构建 `__ModuleLoader__` bundle）
- **踩坑 3（最大坑）**：设置面板一直"不可用"——根因是 apiproxy 的 `WEB_SETTINGS_NAMESPACES` 白名单把 `memory` 命名空间从 `settings.describe` 过滤掉了（DSH 官方安全边界，插件无法自行声明暴露）。修复：harness 源码加一行白名单
- **踩坑 4**：HMR 只监视 patch 文件、不重载插件代码——改插件必须重启 dsh web
- UI 演进：深埋卡片（plugin.item）→ 按用户要求改为**侧边栏导航项**（settings.section）+ 整页设置面板

## v0.3.1 — 密钥与供应商预设

- 供应商/模型**动态预设下拉**（`api.llm.providers()` / `api.llm.models()`，级联 + 自定义兜底 + 已保存值回填）
- **密钥自动跟随供应商**：读 `llm-pi-ai` 命名空间选中供应商的 `apiKeyEnv`（credential-ref 不被 redact 剥离），密钥目标 ref 动态切换；自建场景回退独立槽
- 密钥保密四层：写凭据文件（`.credentials.yaml`）→ 不进 settings 文档 → 不进记忆库 → UI password 不回显（只显示"已配置"徽标）

## v0.4.0 — 阶段二（向量 + 图遍历 + 遗忘）

- **sqlite-vec 接入**：`allowExtension` + `loadExtension`（预编译 vec0.dll 随包分发），加载失败优雅降级
  - 踩坑：vec0 要求整数 rowid（node:sqlite 把 JS number 绑成 REAL → 用 BigInt）
  - 踩坑：trigram 对 2 字中文词零命中（trigram 需 ≥3 字符）→ 关键词 + 子串兜底
- **rule embedding**：FNV-1a 双哈希 256 维 + 归一化（离线零依赖、确定性）——用词不同的查询也能语义召回
- **三路 RRF 融合**：FTS5 BM25 + 关键词 + 向量 KNN → `1/(60+rank)`
- 图遍历：k-hop 递归 CTE、BFS 最短路径、记忆邻域
- 遗忘曲线：24h 指数衰减 + 访问加成（惰性，turn/end 低频）
- 新工具：memory_merge / memory_purge / memory_graph_neighbors

## v0.4.1 — 阶段二收尾

- 社区聚类：label propagation（轻量，小图适配）+ communities/community_members 表 + memory_graph_communities 工具
- 会话预热：agent/session-start 注入最近语义记忆

## 生态协同（同日）

- **compaction-smart 设计方案**（pro 产出，502 行）：六维度精妙压缩策略——内容感知分层保留、**压缩=记忆转移闭环**（与 dsh-memory 咬合）、结构化摘要、渐进式多级压缩、自适应阈值、压缩世界线可展开
- **archify 架构图**：GitNexus 索引（484 节点/694 边/15 流程）+ `context(MemoryStore)` 符号验证 → archify showcase 级交互式架构图（`docs/architecture.html`，4 视口视觉验收通过）
- GitNexus 生成本仓库 `AGENTS.md`（索引指令注入）

## 经验清单（血泪教训）

1. **访问 ctx 外部服务必须先 `export const inject`**，否则运行时 "cannot get property X without inject"
2. **defineTool schema 每个 object 节点显式 `additionalProperties`**（DSH 编译器硬性要求）
3. **settings 命名空间有 apiproxy 白名单**——第三方插件 GUI 设置需要 harness 源码加白名单（官方 deferred work）
4. **HMR 不重载插件代码**——改 lib/ 必须重启 dsh web；只有 cordis.patch.yml 变化触发 patch 热重载
5. **插件源码与 profile 副本双份同步**（部署 = 复制目录，含 sqlite-vec 的 dll）
6. **npm install 需 `--legacy-peer-deps`**（DSH 内部包不在 npm registry）
7. **vec0 行键要 BigInt；trigram 词长 ≥3**——中文字词检索要有兜底路
8. **注入块必须确定性排序 + 稳定格式**——KV 缓存前缀复用的前提
9. **写入侧只收 `source.kind==='user'`**——否则注入内容被当新记忆嵌套沉淀

## v0.4.2 — upsertMemory 致命崩溃修复

- **修复**：`upsertMemory` 相似合并路径对 `store.list()` 已解析的 keywords 数组再次 `JSON.parse` → `Unexpected token 'o', "now,have,en"...` 致命错误（触发条件：dedupMerge 开启 + 相似记忆合并——refiner 降级路径下的高频路径；错误信息即关键词数组被 toString 的开头）
- 顺带修复：图谱挂接按时间倒序取第一条可能挂错记忆 → 改用 add/update 返回值
- 补齐 `test-phase2.mjs`（18 项：向量/图遍历/遗忘/merge-purge/社区），版本号升至 0.4.1 并同步部署副本

## v0.4.3 — 写入质量 + 阶段三启动（世界线回滚）

- **价值门升级**：无用户消息的自主轮次 → 仅当输出含成果信号（✅/已完成/已修复/交付/结论等）才沉淀，过滤思考中间态噪音（此前「任务: (无显式用户消息)」快照照单全收）
- **refiner 价值预判**：过短（<40 字）或无实词（<3 关键词）的低价值轮次不再送 LLM，直接规则路径——省成本
- **阶段三① 世界线回滚**：`store.rollback(id, revision)`（当前活跃版 valid_to 置为 now、目标版本快照追加为新 revision、活跃切片/FTS/向量同步、世界线不断链）+ `memory_versions`/`memory_rollback` 工具
- 新增 `test-phase3.mjs`（7 项：回滚/二次回滚/检索见恢复内容/错误处理），三套测试共 41 项全过

## v0.5.0 — 阶段三② 8 型边全量（图谱语义化）

- **建图幂等化**：节点/边改为确定性 id（sha1(label+memory) / sha1(type+from+to)）——重复 graphLink 不再产生重复节点边；insertEdge 改 UPSERT（断边后再连 = 重新激活 + 更新权重）
- **记忆级连边**：`store.link(a, b, type, weight)` 跨记忆节点集连 8 型边；`unlink` 断开（valid_to 置位，历史保留）
- **自动建边**：similarTo（Jaccard 0.5~0.8 相似但未达合并阈值 → 去重候选边，权重=相似度）+ before（同 label 实体跨记忆按时间排序相邻连边，时间演化链）
- **新工具**：memory_graph_path（跨类型 BFS 最短路径）/ link / unlink / node（节点详情+邻域）
- edges 表 CHECK 约束本就含全部 8 型（mentions/partOf/similarTo/causes/solves/before/supports/contradicts）——schema 零改动，纯建边逻辑落地
- test-phase3 扩至 16 项，三套测试共 50 项全过

## v0.5.1 — 图谱实体过滤 + 记忆库瘦身

- **实体过滤（治假多）**：`GRAPH_STOP_WORDS` 停用词表（英文虚词 + 中文 bigram 泛词 + LLM 输出泛词，140+ 词）——关键词 ≠ 实体，泛词不成节点；graphLink 过滤后 <2 实体不建图
- **ep 快照不建图**：只有语义记忆（sm）进知识图谱，ep 过程快照只留文本不建节点/边
- **修复 list() 忽略 layer 参数**（session-start 预热取 sm 实际取全部——潜伏 bug）
- **生产库清理**（备份后执行）：60 → 23 条记忆（删 21 ep 快照 + 16 legacy 冗余，保留 23 条 sm 精炼 + 用户原始需求 mem-7582b496）；105 → 79 节点（删 11 泛词节点）；236 → 155 边；VACUUM 瘦身
- test-phase3 扩至 17 项（含停用词过滤专项），三套测试共 51 项全过

## v0.6.0-期1 — 真 embedding（remote 落地启动）

- **决策已定 + 实测通过**：硅基流动 https://api.siliconflow.cn/v1；嵌入 Qwen/Qwen3-VL-Embedding-8B（**4096 维**）；重排 Qwen/Qwen3-VL-Reranker-8B（排序质量实测正确）；密钥进凭据文件（MEMORY_EMBEDDING_API_KEY / MEMORY_RERANK_API_KEY）
- **期 1 交付 lib/embedder.js**（Embedder/Reranker seam）：RuleEmbedder（兜底）+ RemoteEmbedder（批量 ≤32/LRU 缓存/超时/维度自学习）+ RemoteReranker + createEmbeddingServices 降级链（onnx→remote→rule）
- 设计文档：docs/embedding-rerank-design.md（含图谱×向量四结合点：节点归一化/similarTo 余弦/边权重/图内语义检索）
- test-embedder.mjs 7 项全过（mock 批量/缓存/降级链 + 真实 API 4096 维验证）

## v0.6.0-期2 — store 真嵌入接入 + 图谱重建 + 自检入口

- **store.js async 化**：add/update/search/rollback 改 async（嵌入在事务外，不持写锁）；embedder 注入 + embedTexts 统一入口 + reembedMissing 批量补写；维度迁移加保护（无 embedder 不重建，防误清生产库向量）
- **index.js 接线**：apply async 初始化 embedder/reranker（密钥凭据文件读取）；settings schema 加 embedding/reranker 段（默认硅基流动 + Qwen3-VL 系列）；新增 memory_reembed 工具；全调用点 await 化
- **生产库迁移**：vec0 256 → 4096 维，28 条记忆重嵌入
- **图谱重建**（rebuild-graph.mjs 运维脚本，真嵌入归一化）：节点大小写归一化（label 向量余弦 0.9 复用）+ node_memories 多对多表 + 语义 similarTo（116 条，权重=余弦）+ before 时间链（32 条）；新增 linkMemories 记忆级单边（修复边爆炸 6237 → 812）
- **测试入口 test-record.mjs**：端到端记录质量自检（8/8 通过，语义查询命中验证；--live 生产库只读）
- 四套测试 58 项全过（async 化零回归）；已同步部署，需重启 dsh web
- 期 2 待做：store.js 注入 embedder + add/update/search/rollback async 化 + vec0 重建 4096 维 + 后台重嵌入迁移 + GUI 区块

## 里程碑：compaction-smart（2026-08-15 立项）

> 里程碑文档：[`compaction-smart-proposal.md`](compaction-smart-proposal.md)（502 行，六维度设计）。

六维度：① 内容感知分层价值判定（ValueClass）② **压缩 = 记忆转移闭环**（核心差异化：先进库再消失，与 dsh-memory 咬合）③ 结构化摘要（SummaryDocument schema）④ 渐进式多级压缩 ⑤ 自适应阈值（成本-收益平衡）⑥ 压缩世界线（非销毁、可展开）。

- 集成设计文档：[`docs/compaction-smart-integration.md`](compaction-smart-integration.md)（已产出：内部模块 lib/compactor.js 决策 + 三张新表 DDL + 转移协议落地 + 工具面草案 + 四期路线图）
- 前置依赖：ctx.memory 价值信号表、8 型边（`summarizes` 等）——与阶段三交叉

## 下一步（方案已备）

- 阶段三（进行中，顺序已定）：① 世界线 rollback 工具 ✅ → ② 8 型边全量 ✅（causes/solves/supports/contradicts 四型自动建边需 LLM 判断，留待 refiner 增强/管家子代理）→ ③ Leiden 聚类 + 增量 → ④ 真 embedding（onnx/remote）→ ⑤ 深度管家子代理 → ⑥ 规模/高级按需（KuzuDB/LanceDB、retriever 重排、skill 注册、画像预热、乐观锁）

## v0.6.0-GUI — Web 记忆图谱视图（Obsidian 风格力导向 + 侧边栏入口）

- **数据通道**：`/dsh-memory/graph` HTTP 路由（`ctx.inject(['webServer'], …)` + `webServer.register`，dsh-market 同款机制）——返回**记忆级图谱快照**（一记忆一节点投影：nodes=sm 记忆 + theme、edges=similarTo/before 映射记忆对、themes 列表）
- **渲染演进**：SVG 主题环形（初版）→ **Obsidian 风格力导向 Canvas**（终版）：
  - 自写物理模拟：斥力（截断 2.2k + 软化核心 22px + 限幅）+ 度感知弹簧 + 中心引力 + 阻尼；力随 alpha 缩放（d3-force 式）
  - 拖节点（拖动期间爬行模式：强阻尼 + 斥力减半——邻居平滑跟随不抖动）、拖空白平移、滚轮以鼠标为中心缩放、hover 高亮邻居、点击看详情
  - **fit-to-view**：模拟收敛后自动缩放居中到全部节点；初始 alpha 0.7 温和展开
  - 点阵背景（Obsidian 定位网格）、节点尺寸按度数、标签缩放自适应隐藏
  - 性能：单 Canvas 每帧整绘、alpha 冷却停帧（静止零 CPU）、选中/hover 走 ref 零 React 重渲染
- **入口演进**：顶部 conversation.view tab → **主界面可收起侧边栏底部入口**（`sidebar.footer.action`，任务看板同槽）——点开全视口面板（标题栏+关闭按钮），无底部输入框
- **过程中修的 bug**：DetailPanel 的 nodeById 解构遗漏（点击白屏）、fit-to-view 拖动中误触发（乱跳）、alpha 冷却循环停止不重绘（拖 1 秒冻结）、斥力核心 5px 爆炸（邻居剧烈抖动）
- 构建 lib/client.js（45KB）+ 部署同步；测试全过

## v0.6.0-主题聚类 — 记忆自动归类

- **记忆级主题聚类**：4096 维向量凝聚聚类（阈值 0.78）——30 条记忆 → 12 个主题（compaction/图谱工具链/嵌入选型等，语义归组准确）；memories 表加 theme 列（旧库自动补列）；启动重嵌入后自动聚类；memory_list 输出带主题标签
- **图谱边审计**：similarTo 116 条合理（top 0.91 近重复对）；before 32 条经 node_memories 正确映射后 32/32 时间方向全对；mentions 92.2% 同记忆共现合理；linkBefore 改为记忆级时间链（归一化节点时间错位修复）
- 图社区（label propagation）在密集图上收敛成巨社区——记忆级主题聚类是更合适的归类机制（Leiden 标记暂缓）

## v0.6.0-热修复2 — 凭据读取根因 + 防崩溃加固（2026-08-15）

### 修复 3：readCredential 正则转义丢失（remote 恒降级 rule 的根因）
- **现象**：启动日志 `embedder: rule（dim 256）`——远程嵌入永远初始化失败，生产库被误迁移回 256 维
- **根因**：`readCredential` 的字符串正则 `new RegExp('^' + name + ':\s*(\S+)', 'm')` 经多层传输后反斜杠丢失（\s → s、\S → S），正则失效 → apiKey 恒 undefined
- **修复**：改用零反斜杠的逐行解析（replaceAll(CRLF) + split(LF) + startsWith + slice），凭据读取不再依赖正则转义

### 加固：防崩溃防护（用户要求——插件出问题不能让 dsh 崩，agent 才能回来修）
- **apply() 整体隔离**：settings 注册失败 → 组合层配置兜底（不再 throw）；embedder/store 初始化失败 → 记忆功能停用但 dsh 正常运行（不再 fatal）
- **registerTools 逐工具隔离**：新增 safeRegister 包装——16 个工具逐一注册，单个 schema 非法只跳过该工具（正是热修复 1 的教训：一个 schema 非法曾炸整个插件树）
- **写入管线隔离**：turn/end 分支整体 try/catch——upsertMemory/refiner 异常不再变成 unhandled rejection
- **向量写入三处保护**（热修复 1 已做）：add/update/rollback 的 vecInsert 失败仅 warn 跳过，记忆本体照常 COMMIT，缺失向量由 reembedMissing 补写
- 验证：五套测试 66 项全过；已同步部署

## v0.6.0-热修复 — schema 校验 + 向量写入加固（2026-08-15）

> 用户反馈 dsh web profile 启动即崩，两类错误并存：

### 修复 1：memory_stats 输出 schema 违反编译器严格校验
- **现象**：`JsonSchemaError: unsupported JSON schema: schema.properties.stats.properties.layers.additionalProperties must be explicitly true or false`，插件树加载失败（registerTools 阶段），dsh 退出码 1
- **根因**：`lib/index.js` memory_stats 工具 output schema 中 `layers` 对象节点未声明 `additionalProperties`，DSH 核心 tools 编译器（deepseek-harness/packages/core/tools）要求每个 object 节点显式 true/false
- **修复**：`layers` 补齐 `additionalProperties: false` 及 `properties: { ep: integer, sm: integer }`（与 `store.stats()` 实际返回结构一致）；全文件 24 处 object schema 复查无其他遗漏

### 修复 2：向量维度不匹配导致记忆写入致命失败
- **现象**：`Error: Dimension mismatch for inserted vector for the "embedding" column. Expected 4096 dimensions but received 256.`，`MemoryStore.add` 抛出后整个事务回滚、dsh 启动 fatal
- **根因**：`lib/store.js` 中 `vecInsert.run` 在事务内裸调用，embedding 维度与 vec0 表不匹配（rule 256 维 vs 旧 4096 维表，或 remote 切换后维度变化）时异常冒泡，阻断记忆落库与启动
- **修复**：`add()`/`update()`/`rollback()` 三处 `vecInsert.run` 包 try/catch——向量写入失败仅 `console.warn` 跳过，记忆本体照常 COMMIT，缺失向量由 `reembedMissing` 补写；`reembedMissing` 自身补偿路径保持原语义
- **配套**：构造期维度迁移逻辑（4096→256 重建空表 + 重嵌入）不变，已自动处理旧表

### 部署与验证
- 修复文件：`lib/index.js`、`lib/store.js`；同步部署到 `C:\Users\28643\.dsh\profiles\web\node_modules\dsh-memory\lib\`（覆盖前原文件备份于同目录 `lib_backup_20250416/`）
- 验证：`node --check` 语法通过；`node test-record.mjs` 临时库端到端 8/8 通过（写入→向量→语义检索闭环）；`node --import tsx/esm apps/cli/src/bin.ts --profile web` 启动成功——`[dsh-memory] embedder: rule（dim 256）`，无 UNSUPPORTED_SCHEMA、无 fatal load failure，web 服务就绪
- 建议：下次发版将 package.json 版本由 0.4.1 提升（本次未改版本号，避免连带依赖变更；schema 修复属兼容性变更，不破坏既有数据）

## v0.6.0-运维 — 自愈启动 + 生态清理 + 调研

- **start-dsh.ps1 自愈 preflight**（保证 DSH 更新后启动脚本仍可用）：① pnpm 版本动态读 package.json 的 packageManager；② package.json+pnpm-lock 哈希变化或 node_modules 缺失 → 自动 pnpm install --frozen-lockfile；③ apiproxy 白名单 memory 命名空间被 git 更新覆盖 → 自动补丁（副本演练验证通过）。经验：run_code/edit 传输层吞字符串反斜杠（路径一律正斜杠）、PowerShell -replace 拼接要先算 replacement 变量
- **移除 tdai-memory**：8/16 凌晨被另一会话批量安装（非用户本意），已从 cordis.patch.yml 删除 + 插件文件清除（原生模块残留待重启后清）
- **PreText 调研**（docs/pretext-evaluation.md）：@chenglou/pretext（无 DOM 文本测量/布局引擎，MIT）——当前图谱场景 ROI 低暂不集成，列为「节点气泡多行标签 / Canvas 详情卡片 / 千级标签」的备选方案（esbuild 打包 +102KB 实测通过）

## v0.7.0 — reranker 接线 + GUI 嵌入/重排区块 + 图谱参数可调（2026-08-16）

按「下一步（方案已备，按优先级）」清单推进 ① ② ⑦：

### ① reranker 接入 search（RRF 融合后精排，设计文档 §3 落地）
- **store.search() 后置精排**：RRF 三路融合排序后取 topK（20）候选 → `reranker.rerank(query, docs)` → 融合分 `final = rrfWeight × norm(rrf) + (1-rrfWeight) × rerankScore`（rrfWeight 默认 0.7，可配置）→ 重排序
- 触发与保护：候选 ≥ minCandidates（3）才重排；reranker 抛错/超时 → 静默降级 RRF 顺序（零损失，console.warn 记录）；配置开关全走 settings（reranker.enabled/topK/minCandidates/rrfWeight）
- **RemoteReranker 加 LRU 缓存**（(query, doc) → score，1024 条）：注入签名去抖场景同 query 重复 rerank 命中率高；部分命中只发增量请求；全命中零请求
- **修复隐藏 bug：向量独有命中丢失**——scored 此前只覆盖 FTS+关键词路，仅向量路命中的记忆不进入结果（RRF 分已算但被丢弃）；改为三路并集
- memory_stats 增加 `rerank` 字段；启动日志显示 reranker 模型

### ② GUI 嵌入/重排设置区块（settings schema 已备，client 补上）
- 「记忆」设置面板新增「嵌入与重排模型」区块：embedding（provider 下拉 rule/remote/onnx + model/baseUrl/apiKeyEnv/cacheSize）+ reranker（enabled 开关 + provider/model/baseUrl/apiKeyEnv/topK/minCandidates/rrfWeight）
- 通用 **KeyInput 密钥卡片**组件（password 写凭据文件、●已配置/○未配置徽标、不留空改）——嵌入/重排密钥走独立槽（MEMORY_EMBEDDING_API_KEY / MEMORY_RERANK_API_KEY），refiner 密钥 UI 不动
- 数值校验扩展到子对象数值字段（cacheSize/topK/minCandidates/rrfWeight 等非数字禁止保存）

### ⑦ 图谱力导向参数进 settings（不再改代码调手感）
- settings schema 新增 `graphView` 段：spring（弹簧强度 0.13）/ repulsion（斥力倍率 1）/ damping（阻尼 0.3）/ gravity（中心引力 0.005），范围校验
- 图谱面板 live 读取：MemoryGraphView 订阅 memory 命名空间 → physics 引用变化 → ObsidianGraph 重建模拟（改参数即刻重排，无需重开面板）
- 设置面板新增「记忆图谱（力导向手感）」区块，四参数可调

### 验证与收尾
- test-embedder.mjs 扩至 14 项：rerank 缓存（全/部分命中）、store 集成（融合升序/失败降级/候选不足不触发）、向量独有命中回归
- 五套测试 73 项全过；client bundle 重建（59KB）
- 版本号 0.6.0 → 0.7.0

## v0.8.0 — 图模型简化（memory_links）+ 管家子代理（2026-08-16）

按「下一步」清单推进 ③ ④（决策：③ 实体图保留为共现骨架，记忆级边独立成表）。

### ③ 图模型简化：记忆级边独立表
- **新表 `memory_links`**（from_memory/to_memory/type/weight/valid_from/valid_to，8 型 CHECK，记忆删除级联）：记忆级语义边的一等存储，不再绕「实体代表节点」
- **link/linkSimilar/linkMemories/linkBefore/unlink 迁移**：写 memory_links（幂等 UPSERT 重新激活 + 更新权重；unlink valid_to 置位历史保留）；link 语义从「节点集全连接」（边爆炸源头）收敛为「记忆对单边」；无实体节点（停用词过滤后）也能连边——修复原依赖实体节点的隐性缺陷
- **buildGraphSnapshot 直读 memory_links**：删除 node_memories memOf 回查复杂度，GUI 投影更简单可靠
- **新方法 memoryPath / memoryLinkNeighbors**：记忆级 BFS（双向）——后续图工具升级的基础
- **启动迁移（幂等）**：旧库 edges 表 similarTo/before 活跃边 → memory_links（生产库副本验证：149 条迁移成功，原库不动）；实体图 nodes/edges/node_memories/communities 保留（mentions 共现 + graph 工具向后兼容）
- test-phase3 扩至 21 项（memory_links 断言 + 记忆级路径/邻域 + 级联删除 + 迁移专项）

### ④ 管家子代理（rule 优先，不擅自删数据）
- **store 方法**：`dedupScan`（sm 两两余弦近重复扫描，嵌入缓存命中）/ `agingReport`（创建超 N 天且闲置的低价值候选）/ `housekeeping`（组合巡检；dryRun=false 自动合并 sim ≥ 0.95 的几乎重复对——强度高者保留，source 并入删除）
- **memory_housekeeping 工具**：dryRun 默认 true（只报告）；参数 minSimilarity/agingDays；输出近重复对 + 老化清单 + 合并数
- **自动巡检**：turn/end 每 housekeeping.interval（默认 50）轮跑一次只读巡检 → 发现候选写日志（提示调工具处理），不注入不擅改
- settings 新增 housekeeping 段（enabled/interval/dedupThreshold/agingDays）
- 新测试 test-housekeeping.mjs（8 项）；六套测试 85 项全过；生产库副本验证通过（73 记忆 / 361 实体节点 / memory_links 149 条，无近重复无老化候选）
- 版本号 0.7.0 → 0.8.0

## v0.8.1 — 管家巡检策略重构（写入量 + 时间双驱动）（2026-08-16）

用户反馈：真实会话通常跑不满 50 轮（几步对话即换会话），「每 N 轮巡检」策略几乎永不触发。

- **触发条件重构**：与对话轮数解耦——
  - 写入量驱动：每沉淀 `interval`（默认 20）条记忆巡检一次（去重价值随库增长）
  - 时间兜底：距上次巡检超 `maxIntervalHours`（默认 24h）即触发（跨会话、跨重启）
- **meta 键值表**：`last_housekeeping_at` 持久化到库（`getMeta`/`setMeta`）——重启后不会因内存清零误触发，也不会永远丢时间基线
- settings housekeeping 段更新：`interval` 语义改为沉淀条数（5~500，默认 20）、新增 `maxIntervalHours`（1~720，默认 24）
- **GUI「记忆管家」区块**：设置面板可调（enabled 开关 + interval/maxIntervalHours/dedupThreshold/agingDays）
- test-housekeeping 扩至 15 项（meta 往返/UPSERT/触发条件四象限）；六套测试 92 项全过；client bundle 重建（62KB）
- 版本号 0.8.0 → 0.8.1

## v0.8.2 — 图谱时间维度可视化（四维蠕虫落地）（2026-08-16）

用户反馈：记忆图谱完全体现不出「四维蠕虫」（时间作为第四维）——看不出哪些记忆更新过、哪些是旧记忆。

- **快照增强**（/dsh-memory/graph）：节点新增 `versions`（世界线版本数，memory_versions 一次 GROUP BY 统计）与 `updatedAt`
- **版本年轮**：更新过的记忆节点外画金色同心环（环数 = 更新次数，封顶 3 圈）——"时间痕迹"直接可见
- **新旧色温**：节点颜色按创建时间压暗——**库内相对映射**（最早=45% 亮度，最新=原色），任意时间跨度对比明显（初版用 180 天绝对封顶，生产库记忆集中近 3 天时亮度差仅 1.7% 肉眼不可辨，改为相对映射）
- **时间筛选**：图谱顶部下拉（全部/近 7 天/近 30 天/近 90 天/90 天以上），只看某时间窗内的记忆（边两端都命中才保留）；统计栏显示"更新过 N 条"
- **hover/选中时间标签**：节点上方显示"X 天前 · 更新 N 次"；详情面板加"◉ 更新过 N 次（世界线 N 段）· 创建于 · 最后更新于"
- 图例更新：金色环=更新过、色浅新色深旧
- 生产库副本验证：70 条 sm 记忆，1 条多版本（mem-4fbe4905 versions=2，去重合并路径产生）——版本统计准确
- 六套测试 92 项全过（无逻辑回归，纯快照字段 + GUI）；client bundle 重建（67KB）
- 版本号 0.8.1 → 0.8.2

## v0.8.3 — 热修复：pre-step 自动注入从未触发的根因（injectMinScore 量纲失配）（2026-08-16）

用户问"这几轮对话里有没有记忆被注入进来"→ 检查对话历史只有会话预热、无 pre-step recall 块 → 模拟检索定位根因：

- **根因**：`injectMinScore` 默认 0.2，而 RRF 融合分数理论上限仅 ~0.049（三路全中 3/61）——**任何命中都过不了 0.2 门槛，pre-step 自动注入实际上从未触发过**（只有不走分数门槛的会话预热在工作）
- **修复**：默认值 0.2 → **0.015**（≈ 单路 rank1 1/61，至少一路排前 13；向量独有命中也能注入，语义召回不丢）；schema 范围 0~10 → 0~1（对齐量纲）
- GUI hint 更新说明量纲；test-embedder 新增阈值语义测试（0.2 过滤一切 / 0.015 放行）扩至 16 项
- **生产库副本验证**：新阈值下 4 类真实查询全部命中 6 条（score 0.0154~0.0462），旧阈值 0.2 下全部被滤——修复生效
- 六套测试 93 项全过；client bundle 重建（67KB）；版本号 0.8.2 → 0.8.3
- 用户层无 injectMinScore 覆盖，默认值改动直接生效

## v0.8.4 — 子代理代码审查修复批（2026-08-16）

用户安排独立子代理对 v0.7.0~v0.8.3 全部改动做深度审查（5 套测试自跑 86 项全绿、最小脚本复现验证），修复审查发现的全部 P1/P2 问题：

### P1 修复
- **rerank 部分缓存命中丢 doc**（embedder.js）：缓存命中与 API 结果合并时，未缓存 doc 的输出掩盖了缓存 doc——部分命中返回条数 < 输入。统一按 docs 原始顺序返回全部（缓存回填 + API 回填 + 未覆盖补 0），store 融合不再出现"缓存命中项不参与重排"的排序标准不一致。顺带严格 LRU（读取刷新位置）
- **link() 语义修正**（store.js）：docstring 明确"返回 1 = 边已活跃（新建或重新激活）"；exists 判定合并为单条 COUNT（原 4 次查询）

### P2 修复
- **touchMemory 从未被调用**（store.js）：search() 命中后批量 touch（last_access 刷新 + strength ×1.1 加成，上限 5）——遗忘曲线/老化报告语义落地：last_access 此前冻结在创建时间，老化报告实为"创建年龄"，热门旧记忆会被误报
- **管家计数器按轮次而非沉淀条数**（index.js）：maybeHousekeeping 抽为独立函数，仅在真实沉淀（add/update 成功）后计数；inFlight 防并发双巡检；refiner 三条写入路径全部接入
- **迁移早退缺陷**（store.js）：#migrateMemoryLinks 由"行数 n>0 早退"改为**增量迁移**（每条检查 memory_links 同三元组，已有跳过）——部分迁移/后续旧式边写入也能补迁，重复启动零重复
- **physics.gravity NaN 击穿**（client）：`?? 0.005` 改 `|| 0.005`——`Number(undefined)=NaN`，`NaN ?? x` 仍为 NaN，力导向坐标全 NaN 图谱渲染崩溃（其余三项本就是 `||`）
- **时间筛选后 themes 口径**（client）：filtered 基于筛选后 nodes 重算主题数

### P3 落实
- DetailPanel 版本文案注明"世界线保留最近 N 段"（滚动裁减上限）；reranker 保存死分支删除

### 测试与验证
- test-embedder 扩至 17 项（部分缓存命中返回全部 doc 回归 + 第 4 项断言对齐新语义）
- test-housekeeping 扩至 19 项（search touch 生效/未命中不 touch/迁移幂等重开不重复）
- 六套测试 99 项全过；client bundle 重建（67KB）；版本号 0.8.3 → 0.8.4

## v0.8.4+ — 防崩溃机制实测守护测试（2026-08-16 凌晨）

用户要求核查"插件防崩溃（不让插件问题阻塞 dsh 启动）"功能是否仍完整——v0.6.0-热修复2 的加固经受住 v0.7.0~v0.8.4 七轮改动后：

- **静态核查**：apply 顶层隔离（settings 兜底/初始化停用）、safeRegister 逐工具隔离、写入管线 try/catch、向量写入三处保护、新代码 8 处"不影响主流程"隔离点全部在位
- **实测验证**（新增 `test-crash-safety.mjs`，mock ctx 驱动真实 apply）：4 场景 10 项全过——
  - A. settings 注册抛错 → 配置兜底继续初始化，不 throw
  - B. dbFile 不可打开 → 记忆功能停用、工具不注册，dsh 存活
  - C. 单个工具 schema 非法 → 只跳过该工具，其余 16 个正常注册
  - D. 正常路径 → 17 个工具全部注册 + 3 个事件监听挂载
- 该测试依赖 @deepseek-ai 包，在部署副本环境运行（md5 与源码一致），此后防崩溃能力有守护测试防回归

## 下一步（方案已备，按优先级）

> 详细执行计划见 **[`docs/ROADMAP.md`](ROADMAP.md)**（v0.9 系列：A 事件分类 → B 画像分类 → C 图工具升级 → D 小项 → E 远期）。

- ① reranker 接入 search ✅（v0.7.0）→ 待办：真实 API 端到端 A/B（开启重排对比注入命中率）→ ROADMAP 阶段 D2
- ② GUI 嵌入/重排设置区块 ✅（v0.7.0）→ 待办：provider 切换热迁移 UI 提示 → ROADMAP 阶段 D3
- ③ 图模型简化 ✅（v0.8.0：memory_links 独立表 + 投影直读 + 迁移）→ 待办：memory_graph_path/neighbors 工具升级为记忆级（memoryPath/memoryLinkNeighbors 已就绪）→ ROADMAP 阶段 C
- ④ 管家子代理 ✅（v0.8.0 期1：去重扫描/老化报告/自动合并；v0.8.1 巡检策略重构）→ 待办：画像蒸馏 → ROADMAP 阶段 B
- **事件分类（新需求）** ✅（v0.9.0：events 表 + 时间线扫描 + 管家增量维护 + memory_events 工具 + 图谱事件筛选/高亮）→ 待办：事件 GUI 视觉增强（成员连线强调、事件时间轴视图）
- **画像分类（新需求）** ✅（v0.9.2：type=profile + aspect + refiner 识别 + 预热画像优先注入 + 画像蒸馏）→ 待办：GUI 图谱 profile 特殊标记（可选）
- **预热重复注入去抖（新发现）** → ROADMAP 阶段 D1
- ⑤ compaction-smart（用户定：记忆系统之后再看——里程碑文档已立）→ ROADMAP 阶段 E
- ⑥ Leiden 聚类暂缓（被记忆级主题聚类替代）；规模/高级按需（KuzuDB/LanceDB 等）→ ROADMAP 阶段 E
- ⑦ 图谱力导向参数进 settings ✅（v0.7.0：spring/repulsion/damping/gravity live 生效）
