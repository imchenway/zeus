# Zeus 会话中栏布局恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复“项目导航 + 会话列表 + 当前对话”的会话页结构，同时保留现有 Codex native app-server、legacy 只读历史和任务级新建会话能力。

**Architecture:** `SidebarNav` 只负责项目与“任务 / 代码 / 会话”导航，不再消费或渲染 `ProjectConversationTree`。`workspace-view-project-sessions` 新增独立 `session-list-pane`，按当前项目渲染同一棵真实会话树；右侧继续使用现有 `SessionWorkspace` / `ConnectedSessionWorkspace`。窄屏下只把 `session-list-pane` 转为焦点受控抽屉，不再把整个项目主侧栏当作会话抽屉。

**Tech Stack:** React 19、TypeScript、CSS、Vitest、React DOM server rendering。

## Global Constraints

- 不修改数据库、app-server 协议、native/legacy 会话语义或历史选择门禁。
- 不新增依赖，不修改构建与迁移。
- 项目主侧栏不得渲染任务下的历史会话树。
- 桌面会话页必须是中栏会话列表加右侧当前对话；当前项目过滤必须保持。
- 窄屏会话列表必须可键盘打开、关闭和恢复焦点，并尊重 reduced-motion。
- 所有测试先红后绿；完成后执行聚焦回归、lint、typecheck、打包和真实 GUI 验收。
- 不执行 git commit、push、merge 或 revert。

---

### Task 1: 用失败测试锁定会话中栏信息架构

**Files:**
- Modify: `apps/desktop/test/app-shell-layout.test.tsx`
- Test: `apps/desktop/test/app-shell-layout.test.tsx`

**Interfaces:**
- Consumes: `App` 的 `initialMainNavTarget="conversations"` SSR 输出。
- Produces: 会话页存在 `session-list-pane`、项目主侧栏不含会话树、主工作区含会话树的回归契约。

- [x] **Step 1: 修改会话页结构断言**

  将“只有一个全局 source rail、禁止 `session-list-pane`”改为：`workspace-view-project-sessions` 同时包含 `session-list-pane` 与 `conversation-detail-pane`；截取 `project-first-sidebar` 片段并断言其不含 `session-project-conversation-tree`；会话页整体仍包含 `session-project-conversation-tree`。

- [x] **Step 2: 运行测试确认红灯**

  Run: `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "conversation page|session source|native session canvas" --reporter=verbose`

  Expected: FAIL，原因是当前 DOM 不存在 `session-list-pane`，且项目主侧栏仍包含会话树。

### Task 2: 把真实会话树迁回主工作区中栏

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/test/app-shell-layout.test.tsx`

**Interfaces:**
- Consumes: `nativeConversationGroups`、`nativeConversationRuntimeStates`、`selectedNativeConversationId`、`selectNativeConversation`、`prepareNativeConversationForTask`。
- Produces: `session-list-pane`，其中只渲染 `activeProjectId` 对应的 `ProjectConversationGroup`。

- [x] **Step 1: 从 SidebarNav 移除会话数据与抽屉职责**

  删除 `conversationGroups`、`conversationStates`、`selectedConversationId`、`onSelectConversation`、`onStartTaskConversation`、`sessionDrawerOpen`、`sessionDrawerMode`、`onCloseSessionDrawer` props 及 `ProjectConversationTree` 分支；保留项目展开与二级菜单。

- [x] **Step 2: 在 sessions workspace 添加中栏**

  在 `conversation-detail-pane` 前渲染 `aside.session-list-pane`。中栏使用当前项目组调用 `ProjectConversationTree`；选择会话后关闭窄屏抽屉，新建任务会话继续调用 `prepareNativeConversationForTask`。

- [x] **Step 3: 修正移动端触发器的 aria-controls**

  `SessionMobileSourceTrigger` 指向新的 `session-project-conversation-list`；backdrop 与 Escape 只控制会话中栏，不再让项目主侧栏进入 `dialog/inert` 状态。

- [x] **Step 4: 运行聚焦结构测试确认绿灯**

  Run: `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "conversation page|session source|native session canvas" --reporter=verbose`

  Expected: PASS。

### Task 3: 恢复桌面双栏与窄屏会话抽屉样式

**Files:**
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/src/renderer/session/session.css`
- Modify: `apps/desktop/test/app-shell-layout.test.tsx`

**Interfaces:**
- Consumes: `workspace-view-project-sessions`、`session-list-pane`、`data-session-source-rail`。
- Produces: 桌面 `minmax(236px, 280px) minmax(0, 1fr)`；小于 760px 时 `session-list-pane` 为左侧抽屉。

- [x] **Step 1: 写失败的 CSS 契约**

  断言桌面会话网格为两列；中栏有独立边界、滚动和最小宽度；窄屏抽屉由 `.session-list-pane` 响应 `data-session-source-rail`，不再移动 `.project-first-sidebar`。

- [x] **Step 2: 运行 CSS 契约确认红灯**

  Run: `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "session source|conversation page|responsive" --reporter=verbose`

  Expected: FAIL，原因是当前 CSS 强制 sessions 单列且移动整个项目侧栏。

- [x] **Step 3: 写最小样式实现**

  将会话页恢复为两列；为 `session-list-pane` 增加滚动、背景、分隔线与 focus-visible；在小于 760px 时固定定位抽屉，保留 backdrop、焦点恢复与 reduced-motion 降级。

- [x] **Step 4: 运行聚焦测试确认绿灯**

  Run: `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx apps/desktop/test/session-workspace.test.tsx --reporter=dot`

  Expected: 2 files 全部 PASS。

### Task 4: 回归、review、打包与真实界面验收

**Files:**
- Modify: `docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md`
- Modify: `docs/TASK_20260710_001_Zeus会话历史选择门禁与运行包错配排查.html`

**Interfaces:**
- Consumes: Tasks 1-3 的源码和测试结果。
- Produces: 可审计验证记录与新 `dist/mac-arm64/Zeus.app`。

- [x] **Step 1: 运行相关回归**

  Run: `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx apps/desktop/test/session-workspace.test.tsx apps/desktop/test/app-task-controls-rendering.test.tsx apps/desktop/test/task-workspace-model.test.ts --reporter=dot`

  Expected: 全部 PASS。

- [x] **Step 2: 运行静态门禁**

  Run: `pnpm lint && pnpm typecheck && git diff --check`

  Expected: 全部退出码 0。

- [x] **Step 3: 独立 code review**

  Reviewer 必须核对本计划、当前 `AGENTS.md` 规约、受影响文件、红绿证据和移动端可访问性；Critical/Important 必须修复后复审。

- [x] **Step 4: 安全退出 Zeus 并重新打包**

  Run: `pnpm package:mac`

  Expected: 退出码 0，`dist/mac-arm64/Zeus.app` 更新且 codesign 验证通过。

- [x] **Step 5: GUI 验收**

  启动新包，点击 `tc-app-core → 会话`。Expected: 项目侧栏只显示项目二级入口；会话历史只出现在独立中栏；选择 legacy/native 行后右侧显示对应内容；运行任务仍先进入历史/新会话选择门禁。

- [x] **Step 6: 回写任务文档**

  记录根因、修改点、验证命令、完整 release gate 的任何既有失败、打包结果、GUI 截图事实和回滚方式。

## Execution Record（2026-07-14）

- 两条首轮 TDD 契约均先红后绿：项目侧栏不再包含会话树；桌面会话页恢复 `minmax(236px, 280px) minmax(0, 1fr)`。
- 独立 review 首轮发现跨项目残留详情与空态移动抽屉焦点两个 Important；新增回归并修正后，第二轮结论为无 Critical/Important，Ready: Yes。
- 相关回归：4 files / 283 tests passed；补充完整 Renderer 契约：71 / 71 passed；lint、typecheck、desktop build、diff-check 通过。
- `pnpm verify:release` 运行到全量测试后未通过：修正 3 条与本需求冲突的旧 Renderer 契约后，剩余失败为 16 条既有 Graph Engine / Graph View 断言，未把它们误报为本次通过。
- `pnpm package:mac` 成功；新 `app.asar` 时间为 `2026-07-14 10:09:23 +0800`；codesign、包内入口健康检查及会话中栏/chooser 标记检查通过。
- 新包 GUI 已验证：`tc-app-core` 的历史只出现在中栏；选择 legacy 行后右侧显示只读详情；切换到 `Zeus E2E` 后旧项目详情清空；项目主侧栏不再展开历史树。
- 回滚方式：仅回滚本计划涉及的 `App.tsx`、`styles.css` 与对应测试/文档变更；不得回退服务端历史选择门禁、native/legacy 语义或其他用户未提交变更。
