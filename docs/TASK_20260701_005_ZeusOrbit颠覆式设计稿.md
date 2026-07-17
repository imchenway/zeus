# TASK_20260701_005 Zeus Orbit 颠覆式整体设计稿

## 目标

回应用户对上一版设计稿的反馈：

1. 不喜欢很多卡片和边缘线。
2. 希望更大胆指出当前设计不足。
3. 允许颠覆创新，重新设计最适合 Zeus 的整体交互动线和样式。

本轮输出一个更激进的整体产品设计稿：Zeus Orbit。

## 核心批评

当前 Zeus 最大的问题不是视觉不够精致，而是缺少强产品隐喻和主路径：

- 任务、代码、会话、设置像功能页集合，不像一个本地项目作战系统。
- 代码图谱是最强 Aha Moment，却被放成普通功能页。
- 大面积空白没有承载状态、证据或下一步，看起来像没内容。
- 过多卡片和边线让界面更像后台管理系统。

## 新方向

Zeus Orbit：把原来并列的页面重构为一个本机项目作战系统。

核心层名：Command Rail、Mission Spine、Project Star Map、Evidence Rail、Command Deck。

- 左侧：Command Rail，全局命令脊柱。
- 旁侧：Mission Spine，当前项目研发闭环。
- 中央：Project Star Map，真实代码图谱作为主舞台。
- 右侧：Evidence Rail，当前对象证据和下一步。
- 底部：Command Deck，对当前证据发命令。
- 横向：Evidence River，从项目、图谱、命令、任务、运行、Diff 到验证闭环。

## 设计原则

- 少卡片，更多层：用空间层级组织，不用重复容器证明结构。
- 少边线，更多焦点：边线只用于窗口边界、面板分区和焦点状态。
- 命令优先，不是聊天优先：输入框是对当前证据发命令，不是孤立聊天。
- 设置不是终点：AI CLI、Telegram、签名、Git 风险作为当前 mission 的本机能力面板。

## 依据

- `PRODUCT.md:7`：Zeus 是本地优先 macOS AI 研发工作台。
- `PRODUCT.md:17`：Aha Moment 是真实仓库扫描后的代码图谱。
- `PRODUCT.md:42-48`：本地优先、无真实来源不展示业务数据、外部工具缺失时显示需要配置。
- `DESIGN.md:5-17`：克制、清晰、可信，适合长时间使用。
- `DESIGN.md:30-45`：空态、控件状态、危险操作和表单状态要求。
- `DESIGN.md:65-69`：页面必须一眼看出当前对象、状态和主操作。
- `DESIGN.md:146-213`：source-list、object-toolbar、composer、decision-rail、mode-rail、graph-canvas 组件语义。
- `apps/desktop/src/renderer/App.tsx:8436-8503`：新会话 zero state 与 composer。
- `apps/desktop/src/renderer/App.tsx:9859-10214`：CodeMapView 状态入口、主画布与 inspector。
- `apps/desktop/src/renderer/App.tsx:11200-11320`：GraphCanvas 布局与画布逻辑。
- `apps/desktop/src/renderer/task/TaskWorkspace.tsx:177-260`：任务工作区状态和 view model。
- `apps/desktop/src/renderer/task/TaskWorkspace.tsx:520-566`：任务行渲染区域。

## 修改范围

- 新增 HTML 颠覆式设计稿：`docs/TASK_20260701_005_ZeusOrbit颠覆式设计稿.html`
- 新增本文档：`docs/TASK_20260701_005_ZeusOrbit颠覆式设计稿.md`
- 未修改 Zeus 源码、测试或构建配置。

## 验证

已执行本轮设计稿自检：

- HTML 内容检查：`doctype`、内联 CSS、无外部 URL/CDN、关键文案与证据锚点存在。
- 文件格式检查：HTML/MD 无行尾空白。
- Chrome headless 渲染检查：桌面 1440×1100 与窄屏 390×1200 均无横向溢出。
- 结构检查：4 个 Orbit 星体、4 条批评项、6 步证据河流、4 条状态规则均存在。
- 视觉抽检：已查看桌面渲染截图，主画面从卡片/边框式布局改为 Orbit 工作台布局。
