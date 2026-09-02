# ZEUS-0447 内置浏览器打开 HTML 卡在加载态

## 当前阶段

- 状态：已完成现场取证、最小根因修复、静态检查、构建与测试身份打包；真实 GUI 点击验收受当前 Zeus 原生浏览器工具超时阻塞，未宣称通过。
- 分支：`zeus/ZEUS-0447-html-01`；开始处理时工作树干净。
- 本阶段未执行 Git commit、push、merge、revert 或发布动作。

## 用户现象

从会话交付物或文件资源点击 HTML 后，右侧工作面一直显示“正在打开内置浏览器…”，看不到标签栏、地址栏和已经加载的 HTML 内容。重复点击仍停在相同状态。

## 现场证据与根因

- 正式版 `v0.3.97` 的 BrowserHost 持久状态显示，截图二对应的 `ZEUS-0446_多供应商多模型会话完整设计.html` 已多次在约 100ms 内完成 `file://` 导航并取得正确页面标题。
- 同一会话因重复点击累计建立 8 个相同 HTML 标签，证明资源授权、文件实路径、URL 编码、`WebContentsView` 创建和 Chromium HTML 加载均已成功；故障不在 HTML 内容或 `file://` 导航。
- `BrowserHost.openTab()` 的既有正确顺序是先发送 `snapshot`，再由 `openConversationResource()` 发送 `open_requested`。右侧 `BrowserWorkspace` 只在收到后一个事件后才挂载，因此必然错过前一个快照。
- 子组件原本在挂载后再调用 `getBrowserSnapshot()` 补取状态。截图现场中这次额外 IPC 没有及时回到 Renderer，子组件的本地 `snapshot` 一直为 `null`，于是永久停留在加载占位页；重复点击只会在 Main 中继续创建已成功加载、但界面不可见的新标签。

## 修复决策

`SessionWorkspace` 本来就持续订阅 BrowserHost 事件。本次直接保留同一会话最近收到的权威 `snapshot`，在 `open_requested` 打开右侧工作面时作为 `BrowserWorkspace` 的初始状态传入。子组件仍保留原有事件订阅和 `getBrowserSnapshot()` 兜底，用于用户手动打开一个尚无标签的浏览器工作面。

优点：复用现有事件和快照类型，不改 Main、preload、持久化或资源安全边界；HTML 标签可以在首次渲染时直接出现，不依赖第二次 IPC。

代价：父工作面在当前会话生命周期内多保留一份很小的浏览器快照引用；它不进入 React 持久状态，也不会额外触发渲染。

未采用只给加载页加超时或错误文案：这只能暴露卡住，不能显示 Main 已经成功打开的页面。未放宽任意本机路径或 Agent 的 `file://` 权限。

## 验证结果

- 受影响文件 Prettier 检查与 `git diff --check`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过；仅有既有的 `markstream-react` 注解和大分块警告。
- `pnpm package:mac`：通过；产物为 `dist/test/mac-arm64/Zeus Test.app`，`CFBundleIdentifier` 为 `dev.hypha.zeus.test`，深度签名校验通过。
- 本地 Vite 验收页能够正常提供，但 Zeus 原生 `zeus_browser.open` 与随后的 `zeus_browser.list_tabs` 均超过 60 秒无返回；BrowserHost 持久状态中也没有新增该验收 URL，说明本轮调用没有抵达可观测的标签创建阶段。
- 当前轮次未启用 Computer Use，按约束未用 AppleScript、直接 CDP 或外部 Playwright 冒充真实 Zeus GUI 验收；因此尚缺少修复后“首次点击 HTML 即展示内容”的真实窗口证据。

后续真实 GUI 验收应在启用受控窗口通道后，使用上述 `Zeus Test.app` 和独立 `ZEUS_USER_DATA_DIR`：从会话资源首次点击本机 HTML，确认标签、地址和页面内容立即出现且只创建一个标签；随后核对首次无标签时手动打开浏览器和已有标签恢复。
