# TASK_20260701_006 Zeus Command Flow 高级精简设计稿

## 任务目标

根据用户对 TASK_20260701_005 的反馈继续返修设计稿：

1. 去掉黑白相交、强戏剧化 Orbit 风格，改成更接近 Codex / Apple 的高级、精简、有质感、低疲劳产品 UI。
2. 修正信息架构判断：代码库问答和制图只服务“理解项目”，Zeus 的主线应是多项目之间高效工作，包括创建任务、推送到本地 app-server / Runtime / CLI 对话、连续补充需求、修改任务状态、沉淀证据。

## 本轮设计结论

推荐方向：**Zeus Command Flow**。

- 左侧仍是 macOS / Codex 风格 source-list，但项目行显示当前可行动任务数量。
- 中间主舞台从“代码星图 / 页面功能集合”改成跨项目任务 Lane。
- 顶部使用全局命令入口，服务创建任务、切项目、继续 CLI 对话、查看等待确认。
- 任务 Lane 展示项目、任务、最近对话、状态、Runtime / 证据摘要和主操作。
- 底部 composer 固定在当前任务上，承担连续对话和后续变更输入。
- 右侧 Context Lens 只展示代码图谱、问答和从理解结果创建任务的入口，不再作为主路径。

## 证据锚点

- `PRODUCT.md:7-13`：Zeus 是本地优先 macOS AI 研发工作台，覆盖项目管理、真实代码扫描、AI CLI 执行、Git Diff 审查和 Telegram 远程控制。
- `PRODUCT.md:17`：代码图谱是 Aha Moment，证明真实扫描和本地优先，但不等于全部主路径。
- `DESIGN.md:5-17`：Zeus 需要低疲劳、可读、项目/任务/代码图谱/会话真实状态。
- `DESIGN.md:20-35`：偏冷中性色、避免纯白纯黑，卡片只用于分组，不做重复卡片网格。
- `DESIGN.md:145-180`：source-list、object-toolbar、composer、decision-rail、mode-rail、graph-canvas 的组件语义。
- `apps/desktop/src/main/localServerRuntime.ts:55-83`：Electron Main 启动本地服务，只把 baseUrl 和临时 token 暴露给 Renderer。
- `apps/desktop/src/renderer/apiClient.ts:1072-1098`：任务创建、加载、运行、继续、取消、重试、状态更新和任务事件 API 已存在。
- `apps/desktop/src/renderer/App.tsx:6238-6274`：前端状态更新和 Runtime 控制会刷新真实快照与任务事件。
- `apps/desktop/src/renderer/App.tsx:8311-8358`：会话页已有推送到 CLI 对话、暂停、继续、标记完成和取消任务的动作基础。

## 样式原则

- 不用黑白块相交，不用强暗色主视觉。
- 大面积使用珍珠白、雾灰、冷中性色，强调色只用于当前项目、主按钮、可行动状态。
- 少完整边框，更多 hairline 分隔、材质层级和轻阴影。
- 少卡片，任务以 lane / row / rail 呈现。
- 不复制外部品牌资产、字体、色名或 token，只借鉴 Codex / Apple 的结构原则和精致度。

## 后续实现建议

1. 先把 App Shell 信息架构调整为：项目 source-list + Command Flow workspace + Context Lens。
2. 任务页以跨项目任务 Lane 和当前任务 composer 为主，不再让表格成为唯一主角。
3. 会话页与任务页合并心智：推送到 app-server 后，任务就是可连续对话的工作对象。
4. 代码图谱页降级为 Context Lens 或 project understanding mode，输出可以引用回任务上下文。
5. 所有状态必须继续遵守 loading / empty / error / permission denied / external wait。

## 验证

已执行本轮设计稿静态自检：

- HTML 内容检查：doctype、内联 CSS、无外部 URL/CDN、无纯黑/纯白色值、关键文案与证据锚点存在。
- 文件格式检查：HTML/MD 无行尾空白。
- 结构检查：主交互动线 5 步、3 条纠偏原则、3 条任务 Lane、Context Lens 均存在。
- 未执行浏览器渲染截图检查；本轮只确认静态文件结构与内容。

## 影响范围

- 新增：`docs/TASK_20260701_006_ZeusCommandFlow高级精简设计稿.html`
- 新增：`docs/TASK_20260701_006_ZeusCommandFlow高级精简设计稿.md`
- 未修改 Zeus 源码。
