# TASK_20260725_002 Zeus 会话输入框 Codex 自适应对齐

## 任务状态

已完成代码实施与构建样式浏览器验收；现有打包 App 正在运行，未中断用户现场重打包或重启 Electron。

## 原始要求

1. 输入框宽度与上方会话区一致。
2. 移除输入框蓝色线条。
3. 宽度随窗口、侧栏、工作区和内容区域自适应，输入内容只驱动高度增长。
4. 可见表现参考当前 Codex App。

## 澄清与决策

- 用户确认 composer 与完整会话内容列共享同一响应式宽度；不是随文字长度左右收缩。
- 输入内容只改变 textarea 高度，达到既有视口上限后改为内部滚动。
- 用户指定以当前 Codex App 为视觉基准，不保留 Zeus 自造的蓝色 textarea 焦点内框。
- 内部按钮继续保留键盘焦点提示；系统强制颜色模式仍保留必要轮廓。
- 本任务没有新增业务领域术语或难以回滚的架构决策，不修改 `CONTEXT.md`，不新增 ADR。

## 取证

### Codex App

- 本机安装版本：`26.721.41059`。
- 安装包样式把桌面端 `--thread-content-max-width` 设为 `48rem`。
- Electron composer 表面使用无显式边框的稳定轻量阴影；未发现随 textarea 聚焦出现的蓝色 composer 外环。
- composer 使用内容列宽度变量和容器规则响应工作区变化，文本编辑区域保持纵向增长。

### Zeus 当前实现

- `apps/desktop/src/renderer/session/session.css`：
  - 会话内容列上限为 `--session-thread-max: 48rem`；
  - composer 另设 `--session-composer-max: 650px`，因此桌面宽窗口下比会话列窄；
  - 最近未提交的 `.ai-workspace textarea:focus-visible` 选择器提高了优先级，使 composer textarea 再次出现蓝色 outline。
- `ConversationComposer.tsx` 已使用 `autosizeTextarea()` 随正文增长。
- `SessionWorkspace.tsx` 的新建对话 textarea 尚未调用同一自动增高逻辑。

## 实施范围

- 让会话 composer 最大宽度直接跟随会话内容列变量，并取消会让 thread 单边偏移的稳定滚动条预留。
- 为 composer textarea 增加足够明确的聚焦覆盖，移除蓝色内框，不影响内部按钮焦点。
- 补齐新建对话 textarea 的内容自动增高。
- 更新本任务记录及必要的会话页设计契约。

## 非目标

- 不修改 thread / turn / item、权限、队列、附件或持久化协议。
- 不修改任务页、代码页、设置页的输入框焦点规则。
- 不新增或恢复 Vitest、组件测试、DOM/CSS 契约测试。
- 不执行 git commit、push、merge 或 revert。

## 验收清单

- [x] 宽窗口下 composer 与上方完整会话内容列左右边界一致。
- [x] 调整窗口或侧栏宽度时，composer 与内容列同步收放且不横向溢出。
- [x] 进行中对话与新建对话共用正文自动增高逻辑，达到上限后内部滚动。
- [x] textarea 聚焦时不出现蓝色内框或蓝色 composer 边线。
- [x] composer 内部按钮的键盘焦点仍可见；强制颜色模式保留系统轮廓。
- [x] `pnpm lint`、`pnpm typecheck`、`pnpm build` 通过。
- [x] 完成基于生产构建样式的浏览器渲染检查，并记录未覆盖的打包 Electron 现场。

## 验证记录

### 静态与构建门禁

- `pnpm lint`：退出码 0。
- `pnpm typecheck`：退出码 0。
- `pnpm build`：退出码 0；Vite 仍报告既有的大 chunk 提示，不影响构建结果。
- 未新增或执行 Vitest、组件测试、DOM/CSS 契约测试。

### 浏览器渲染检查

使用最终生产构建 CSS 和与会话页相同的 DOM class 结构，在隔离临时页面内检查实际 Chromium 计算样式：

- `1280 × 720`：thread 与 composer 均为 `768px`，左右边界误差 `0px`。
- `800 × 720`：thread 为 `484.8125px`，composer 为 `484.796875px`，仅有 `0.015625px` 亚像素舍入差。
- `520 × 720`：thread 与 composer 均为 `418.125px`，左右边界误差 `0px`。
- 三种宽度均无页面横向溢出。
- textarea 聚焦后的计算样式为 `border-width: 0`、`box-shadow: none`、`outline: none`；外层仍保持 `1px` 中性描边和既有轻阴影。
- composer 按钮获得焦点后仍有 `2px` 可见轮廓。
- 短内容高度为 `49px` 且隐藏内部滚动条；长内容在 `720px` 视口高时封顶 `244px`，在 `480px` 视口高时重算为 `163px`，两者均转为 textarea 内部滚动。
- 浏览器控制台无 warning 或 error。

### 未覆盖项

- `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 正在运行；`package:mac` 脚本会主动拒绝覆盖运行中的 App。为避免中断当前 Zeus 会话，本次没有退出、重打包或重启该 App，因此没有宣称完成打包 Electron 的运行态验收。
