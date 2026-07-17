# TASK_20260701_004 Zeus 共享 Shell 细化设计稿

## 目标

在 `TASK_20260701_003_Zeus最新页面设计重构建议.html` 的基础上，继续细化已认可的“共享 Shell”方向，输出可评审的多屏页面设计稿。

## 本轮设计 brief

- 产品：Zeus 本地优先 macOS AI 研发工作台。
- 视觉来源：用户本轮提供的最新截图、`PRODUCT.md`、`DESIGN.md`。
- 交互级别：静态细化稿，包含关键状态与响应式口径，暂不进入源码实现。
- 不发散候选：用户要求继续细化已认可方向，因此本稿不做 A/B/C 视觉方向。

## 三张 Artboard

1. Project Workspace Shell：Code Map 成为项目作战室主舞台，主路径是“扫描结果 → 选节点 → 创建任务”。
2. Work Queue Shell：Tasks 与 Sessions 合成执行线，主路径是“选任务 → 看证据 → 推送到 CLI”。
3. Configuration Shell：Settings 状态化，主路径是“看状态 → 配置缺项 → 保存反馈”。

## 组件细化

- object-toolbar：统一展示当前项目、当前对象、真实状态、主操作。
- context-inspector：统一承载选中节点、任务、配置组的证据与二级动作。
- decision-rail：统一任务运行、Git 写操作、取消任务和保存反馈。
- composer：会话、任务续写、图谱问答共用底部输入语法。

## 依据

- `PRODUCT.md:7`：Zeus 是本地优先 macOS AI 研发工作台。
- `PRODUCT.md:17`：Aha Moment 是真实仓库扫描后的代码图谱。
- `PRODUCT.md:42-48`：本地优先、无真实来源不展示业务数据、外部工具缺失时显示需要配置。
- `DESIGN.md:5-9`：克制、清晰、可信的 macOS 产品 UI。
- `DESIGN.md:65-69`：页面必须一眼看出当前对象、状态和主操作。
- `DESIGN.md:146-213`：source-list、object-toolbar、composer、decision-rail、mode-rail、graph-canvas 组件语义。
- `apps/desktop/src/renderer/App.tsx:8436-8503`：新会话 zero state 与 composer。
- `apps/desktop/src/renderer/App.tsx:9859-10214`：CodeMapView 状态入口、主画布与 inspector。
- `apps/desktop/src/renderer/App.tsx:11200-11320`：GraphCanvas 布局与画布逻辑。
- `apps/desktop/src/renderer/task/TaskWorkspace.tsx:177-260`：任务工作区状态和 view model。
- `apps/desktop/src/renderer/task/TaskWorkspace.tsx:520-566`：任务行渲染区域。

## 修改范围

- 新增 HTML 细化设计稿：`docs/TASK_20260701_004_Zeus共享Shell细化设计稿.html`
- 新增本文档：`docs/TASK_20260701_004_Zeus共享Shell细化设计稿.md`
- 未修改 Zeus 源码、测试或构建配置。

## 验证

已执行本轮设计稿自检：

- HTML 内容检查：`doctype`、内联 CSS、无外部 URL/CDN、关键文案与证据锚点存在。
- 文件格式检查：HTML/MD 无行尾空白。
- Chrome headless 渲染检查：桌面 1440×1100 与窄屏 390×1200 均无横向溢出。
- 结构检查：3 个 artboard、3 个 app window、5 个关键状态均存在。
