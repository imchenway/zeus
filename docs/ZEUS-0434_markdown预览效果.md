# ZEUS-0434 Markdown 预览效果

## 当前阶段

- 状态：实现完成；静态、类型与构建验证通过，浏览器 DOM 现场通过，截图和流式性能现场存在既有验收缺口。
- 日期：2026-09-01。
- 分支：`zeus/ZEUS-0434-markdown-01`。
- 工作区：`/Users/david/hypha/.zeus-worktrees/zeus-e2e-oBLuqT/16fa6c583d4a6452352c/ZEUS-0434`，任务开始时干净。

## 用户现场

会话最终回答包含五列表格。当前表格在正文窄列中按内容硬撑，中文出现逐字换行，最右列又被会话视口直接裁掉；底部输入区与“返回最新消息”浮层进一步遮住长表格的阅读位置。

截图来源：
`/Users/david/.zeus/artifacts/task-attachments/command-1aea38c399ef08346b068c67-1-668e639facb74c26-pasted-task-screenshot-1788225705312.png`。

## 已确认事实

1. 会话 Markdown 统一由 `ConversationMarkdown.tsx` 的 `markstream-react@2.0.6` 渲染，不是 Excel 专用预览。
2. 现有表格样式把 `table` 设为 `display: block`、`inline-size: max-content`、`max-inline-size: 100%` 和 `overflow-x: auto`。
3. 会话正文宽度上限为 `--session-markdown-max: 40rem`，会话行宽度上限为 `--session-thread-max: 48rem`。
4. 外层 `.session-transcript` 使用 `overflow-x: hidden`。当上游表格内部宽度没有被自身滚动容器完整接住时，超出正文/会话行的列会被直接裁掉。
5. ZEUS-0412 只修复了表头列宽拖动手柄被工作区按钮样式污染，未处理宽表格的布局、横向滚动和阅读密度。

## 根因

`markstream-react` 已提供 `.table-node-wrapper` 作为横向滚动容器，内部 `.table-node` 保持标准表格布局与 `width: 100%`。Zeus 后加的通用表格规则再次把内部 `<table>` 改成 `display: block`、`inline-size: max-content`、`max-inline-size: 100%` 和独立滚动容器。

这组覆盖同时造成三个结果：

1. 标准表格自动分配列宽的能力被破坏，长文本列按最大内容宽度争抢空间，短列被压到中文逐字换行。
2. 上游 wrapper 和内部 table 形成两个竞争的横向溢出边界；内部滚动条位于整张长表最底部，当前视口没有完整内容或明显滚动提示，看起来就是生硬裁切。
3. 含表格的助手正文仍受 `40rem` 正文行长限制，没有利用外层会话行已经提供的 `48rem`，桌面宽度被白白浪费。

根因不在 Markdown 原文、Provider 或 Excel 文件预览，也不需要新增自有 React 表格组件。

## 实施方向

- 删除 Zeus 对内部 `<table>` 的 block/max-content/独立滚动覆盖，恢复标准 table 布局。
- 复用上游 `.table-node-wrapper` 作为唯一滚动边界，并在该节点增加圆角外框和清晰但克制的滚动条。
- 含表格的 `.session-markdown` 使用父级全部可用宽度；普通回答仍保持 `40rem` 阅读行长。
- 表格改为外框加轻分隔线，弱化 Excel 网格感；列保留合理最小宽度，桌面五列表格优先完整铺开，窄窗口才横向滚动。
- 在已有 Markdown 流式 QA 页面默认展示与用户截图同类的五列长文本表格；不增加新路由、状态观察器或测试体系。

## 待核对

- 输入区是正常的独立底部布局还是覆盖正文的定位层；若只是截图停在非底部位置，不扩大本任务范围。
- 真实渲染下五列完整性、横向滚动、窄视口与既有 20KB/100KB 流式场景。

## 方案取舍

- 优先方案：复用上游表格节点，只在共享会话 Markdown 作用域修正宽度、换行、滚动条和表头/行视觉。优点是改动最小、所有会话入口一起生效；缺点是仍依赖上游 class/DOM 契约。
- 备选方案：为表格提供 Zeus 自有滚动容器。优点是溢出边界完全受控、可加滚动提示；缺点是需要自定义表格节点或 DOM 包装，React 改动和流式渲染风险更高。
- 不采用：扩大整条会话正文或允许整个会话横向滚动。前者会破坏普通回答的行长，后者会让整个会话页面产生横向滚动陷阱。

## 边界

- 不修改 Markdown 原文，不把宽表格转成图片或 Excel 附件。
- 不新增依赖，不创建 Vitest/单元测试。
- 未经用户要求，不执行 Git 提交、推送、合并或其他历史操作。

## 实施结果

### 生产样式

`apps/desktop/src/renderer/session/session.css`：

- 含 `.table-node-wrapper` 的 Markdown 正文使用父级全部宽度；普通回答仍保持既有 `40rem` 阅读行长。
- `.table-node-wrapper` 成为唯一横向滚动边界，补齐最大/最小宽度、overscroll、细滚动条、圆角外框和轻量背景。
- 内部 `.table-node` 恢复标准 table 布局，不再使用 `display: block`、`max-content` 或内部独立滚动。
- 单元格最小宽度提高到 `8rem`，长内容正常换行；表头不拆字，第一列轻量强调。
- 全格强边框改为外框、行分隔和较弱的列分隔，斑马纹减淡，降低 Excel 网格感。
- ZEUS-0412 的四个列宽拖动手柄及其焦点语义继续保留。

### QA 现场

- `apps/desktop/qa/markdown-streaming-qa.tsx`：已有 Markdown QA 页面默认展示与用户截图同类的五列长文本表格；夹具为模块级静态常量，没有给生产组件或流式路径增加状态、effect 或 observer。
- `apps/desktop/qa/session-styles.css`：QA 表格舞台补齐 `min-inline-size: 0`，避免夹具自身的 grid item 最小内容宽度干扰判断。

## 验证结果

### 通过

- `git diff --check`：通过。
- 目标文件 `pnpm exec prettier --check`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过；架构治理同时通过，126 张 Core 表和 11 张可重建辅助表均保持单一 owner。
- `pnpm build`：通过；生产 CSS 产物 `session-workspace-D6QDu8M6.css` 已包含最终 `.table-node-wrapper` 与标准 `.table-node` 覆盖。构建只保留既有的 Markstream PURE 注释和大 chunk 警告。
- Zeus 内置浏览器打开 `http://127.0.0.1:4179/qa/session-styles.html?markdown-stream`：标题和页面身份正确，无 Vite/React 错误覆盖；五个表头、四行长文本及四个 `Resize columns …` 按钮均进入真实 DOM，当前浏览器宽度下五列完整排入表格，初始内部横向偏移为 `0`。
- 浏览器运行期间 Vite 没有新增运行错误。

### 未通过或未验

- Zeus 内置浏览器截图接口连续生成 `0` 字节 PNG，因此没有可交付的 after 截图，不能声称完成像素级视觉验收。
- 点击既有 `100KB` 场景后仍停在 `0 / 100000`，与 ZEUS-0412 记录的历史现场一致；这不是本次表格 CSS 引入，但 20KB/100KB 流式性能门禁不能报告通过。
- 当前 Zeus 浏览器没有提供视口尺寸切换，本轮没有独立窄视口截图；窄宽度的内部横向滚动依靠真实 wrapper/CSS 契约和构建产物确认，尚缺手势与可见滚动条的像素证据。
- 未生成或启动 `Zeus Test.app`，未执行真实 Electron 会话 GUI 验收；浏览器 QA、静态检查和构建均不替代该层证据。
