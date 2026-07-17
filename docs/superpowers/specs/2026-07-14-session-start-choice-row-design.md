# Zeus 新建会话选择行视觉修复设计

状态：用户已确认方案 1；源码、测试与打包已完成，处于 verification，等待解锁 Mac 后验收真实 packaged GUI。

## 1. 背景与真实依据

`StartConversationSurface` 使用原生 radio 表达“新建会话、续接 native 会话、引用 legacy 会话”。当前全局控件规则 `.macos-ai-app :where(input, select, textarea)` 对 radio 同样应用了 `appearance: none`、`inline-size: 100%`、输入框边框和 padding；会话页局部样式只设计外层 label，没有把 radio 恢复为单选圆点。因此 radio 被渲染为横向空白输入框，文本被挤到右侧。

真实打包窗口已复现该状态。问题发生在 Renderer 样式层，不涉及 provider、迁移、数据库或 app-server。

## 2. 目标

将创建会话模式选择器收敛为 macOS source-list 风格的紧凑选择行：信息密度高、层级克制、整行可点击、选择状态明确，并保留原生 radio 的键盘和辅助技术语义。

视觉命题：像 macOS 工具中的安静选择列表，而不是输入框、卡片或大按钮。

## 3. 非目标

- 不改变“已有历史时必须显式选择 create/resume/reference”的门禁。
- 不默认预选“新建会话”。
- 不取消首条消息必填规则。
- 不创建空 provider thread。
- 不修改 conversation API、Codex app-server、迁移或数据库。
- 不重构会话页其他区域，不引入新依赖或动效库。

## 4. 组件结构

保留现有 `fieldset > label > input[type=radio] + span` 语义结构。仅为会话开始模式的 radio 增加局部、可测试的类名，避免依赖宽泛的元素选择器，也避免影响 legacy 消息复选框和其他页面控件。

每条选择行包含：

1. 左侧 14px 单选圆点；
2. 右侧文本区；
3. create 只显示“新建会话”；
4. resume/reference 显示动作名称和真实会话标题。

不增加图标、徽章、卡片边框或重复说明。

## 5. 视觉规格

- 行高：最小 42px，满足现有 macOS 产品密度并超过 WCAG 2.2 的 24px 最小点击目标。
- 布局：`grid-template-columns: 18px minmax(0, 1fr)`，左右间距 8px。
- 默认：透明背景、无外框。
- hover：使用现有 `--session-selected` 的轻量背景。
- selected：同一轻量背景，radio 使用现有会话强调色绘制实心圆点；选中状态不能只依赖背景色。
- focus-visible：在整行外缘显示高对比焦点环，不改变布局尺寸。
- disabled：保留可读文字，降低整体对比但不隐藏选项；鼠标与键盘均不可激活。
- 文本：标题使用现有会话正文色和字重；历史标题使用 muted 小字号，可换行，不横向溢出。
- 深色模式：只使用现有 `--session-*` token，不写死纯黑、纯白或新品牌色。
- reduced-motion：选择器不新增动画；状态变化只使用现有短时颜色过渡或完全静态。

## 6. 交互与数据流

交互和数据流保持不变：

1. 点击任务标题右侧“＋”只打开 `StartConversationSurface`；
2. 点击任一整行由原生 label 选择对应 radio；
3. `mode`、`selectedChoiceId`、`legacyMessageIds` 和 `content` 继续由现有 React state 管理；
4. “开始并发送”仍按现有条件启用；
5. 提交仍调用现有 `onStartConversation`，没有新的网络请求或状态分支。

## 7. 可访问性

- 保留 `fieldset` 和隐藏 `legend`，让辅助技术读取同一组选项。
- 保留原生 radio 的 Name、Role、Value 和单选互斥行为。
- label 为完整点击目标，尺寸不小于 42px 高。
- `:focus-visible` 必须清晰，不能只依靠颜色或 hover。
- 选中态同时由 radio 圆点、checked 状态和背景表达。
- 400% 缩放和窄屏下文本允许换行，radio 不拉伸、不被压缩。

## 8. 影响文件

- `apps/desktop/src/renderer/session/SessionWorkspace.tsx`
- `apps/desktop/src/renderer/session/session.css`
- `apps/desktop/test/session-workspace.test.tsx`
- 必要时补充现有 CSS 契约测试，但不扩大到其他页面。
- 主任务文档记录实现、验证、风险和回滚证据。

## 9. 验收标准

1. 新建、续接和引用选项均显示为左侧圆点加右侧文本，不再出现横向空白输入框。
2. 整行可点击，radio checked 值与 React `mode` 一致。
3. 默认、hover、focus-visible、selected、disabled 状态均可辨认。
4. 有历史时仍不默认选择任何模式；无历史时仍按现有逻辑默认 create。
5. “开始并发送”的启用条件和 payload 完全不变。
6. legacy 消息 checkbox、全局输入框、设置页和任务页控件不受影响。
7. 中文、英文、深浅色、窄屏和 reduced-motion 下无溢出或状态丢失。
8. 真实打包 Zeus 截图中不再出现大块空白按钮。

## 10. 测试与验证

实施阶段按 TDD 执行：

1. 先增加失败测试，证明会话开始 radio 缺少局部类名和局部尺寸契约；
2. 实施最小 JSX/CSS 修正；
3. 运行 `session-workspace` 与会话页布局相关测试；
4. 运行 typecheck、lint、format、diff check；
5. 安全退出 Zeus 后执行 `pnpm package:mac`；
6. 在真实打包窗口验收默认、hover、focus、selected 和 disabled 状态。

## 11. 风险与回滚

风险集中在 CSS 优先级：全局 `input` 规则可能再次覆盖局部 radio。实现必须使用 `.session-codex-parity-v1 .session-start-mode` 范围内的明确选择器，并用测试反向锁定 radio 不得为 `inline-size: 100%`。

回滚仅撤销本次局部 JSX 类名、`session.css` 规则和对应测试；不得回滚历史选择门禁、native thread 续接、legacy 只读或数据库迁移。

## 12. 已确认假设

- 本轮只修视觉和可访问性，不调整创建流程。
- 继续使用现有 restrained cool-neutral 会话 token。
- 不需要视觉伴随页或新图片资产；用户提供的真实打包截图已经足以验收差异。
- 不执行 git commit，除非用户另行明确要求。
