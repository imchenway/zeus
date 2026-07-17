# Zeus 会话记录与权限模式对齐实施计划

> 状态：2026-07-15 用户已确认进入 develop。实现以 `docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md` 的 10.18、10.19 与 `docs/TASK_20260715_004_Zeus会话记录悬浮控件与权限模式故障排查.html` 为准。

## 目标

让 Zeus 的 Codex native 会话在展示、审批和权限模式上保持与 Codex App 一致的交互语义：没有内容的 reasoning 不渲染空壳；首个真实事件到达前展示真实运行态占位；工具调用按类型展示；“回到最新消息”固定在滚动视口；会话可选择只读、自动和完全访问模式，且审批决定不再被隐藏任务字段静默改写。

## 约束

- 保留现有 provider 原始事件与持久化 item，不迁移或伪造历史消息。
- 权限模式必须持久化到会话；旧会话默认按原任务能力映射，确保升级兼容。
- `full-access` 必须显式确认；运行中的 turn 不允许切换模式。
- provider 未声明的审批决定不展示、不转发；畸形请求继续 fail-closed。
- 不执行 git commit、push、merge、revert。
- 任何行为变更完成后必须退出 Zeus，执行官方 `pnpm build && pnpm package:mac`，启动 `dist/mac-arm64/Zeus.app` 后做真实 UI 验证。

## Task 1：建立红灯测试

**文件：**

- 修改 `apps/desktop/test/session-workspace.test.tsx`
- 修改 `apps/desktop/test/session-controller.test.tsx`
- 修改 `packages/storage/test/storage.test.ts`
- 修改 `packages/ai-runtime/test/codex-app-server-manager.test.ts`
- 修改 `packages/local-server/test/codex-native-conversation-coordinator.test.ts`

**验收：**

1. 空 reasoning 不出现在对话记录；active 且无可见 provider item 时出现“正在思考”状态。
2. command execution 渲染命令、工作目录、状态和可折叠输出，不直接展示原始 JSON。
3. 返回最新消息控件位于 transcript overlay，而不是滚动内容流。
4. 会话权限模式可持久化并进入 native snapshot。
5. `read-only`、`auto`、`full-access` 分别映射到 Codex App 对应的 sandbox / approval policy。
6. 用户明确接受 provider 已声明的审批决定时，服务端按原决定转发，不静默改写为拒绝。

## Task 2：会话展示投影与视觉修复

**文件：**

- 修改 `apps/desktop/src/renderer/session/ConversationTranscript.tsx`
- 修改 `apps/desktop/src/renderer/session/ThreadItemView.tsx`
- 修改 `apps/desktop/src/renderer/styles/session.css`

**实现：**

1. 在展示层过滤空 reasoning/commentary/analysis/plan item，数据层保持不变。
2. 根据 typed `ConversationState` 和 active turn 内容派生非持久化“正在思考”行。
3. 为 command execution / tool call 提供紧凑的类型化摘要和输出详情。
4. 增加 transcript shell，将“回到最新消息”改为绝对定位 overlay，移除 `bottom: 118px` 魔数和 sticky 布局。
5. 保留 reduced-motion、键盘焦点与 `aria-live` 语义。

## Task 3：持久化会话权限模式

**文件：**

- 修改 `packages/storage/src/index.ts`
- 修改 `packages/local-server/src/codexNativeConversationContracts.ts`
- 修改 `packages/local-server/src/index.ts`
- 修改 `apps/desktop/src/renderer/session/sessionTypes.ts`
- 修改 `apps/desktop/src/renderer/apiClient.ts`
- 修改 `apps/desktop/src/renderer/session/useSessionController.ts`

**实现：**

1. 新增会话字段 `permission_mode`，允许 `read-only | auto | full-access`。
2. 旧会话迁移默认 `read-only`；native 会话在创建时按任务能力映射默认值。
3. snapshot 返回真实权限模式；增加空闲态更新接口。
4. start 请求携带权限模式并纳入幂等指纹；模式更新写入 SQLite 后再返回。

## Task 4：按 Codex App 语义下发权限与审批

**文件：**

- 修改 `packages/ai-runtime/src/codexAppServerManager.ts`
- 修改 `packages/local-server/src/codexNativeConversationCoordinator.ts`
- 修改 `apps/desktop/src/renderer/session/PendingRequestSurface.tsx`

**实现：**

1. `read-only`：read-only sandbox、`on-request`、user reviewer。
2. `auto`：workspace-write sandbox、`on-request`、user reviewer。
3. `full-access`：danger-full-access sandbox、`never`、user reviewer。
4. thread/start 与 turn/start 使用同一会话权限事实源。
5. 审批响应只验证请求身份、生命周期和 provider 声明决定；不再由 task `allowCodeChanges` 静默改写用户决定。
6. 审批 UI 显示当前模式和触发原因，并只呈现 provider 声明的操作。

## Task 5：会话权限交互

**文件：**

- 新增 `apps/desktop/src/renderer/session/PermissionModeControl.tsx`
- 修改 `apps/desktop/src/renderer/session/ConversationComposer.tsx`
- 修改 `apps/desktop/src/renderer/session/SessionWorkspace.tsx`
- 修改 `apps/desktop/src/renderer/styles/session.css`

**实现：**

1. 新建会话和已有会话都显示紧凑权限模式入口。
2. `full-access` 使用二次确认，不用隐式切换。
3. active / waiting turn 禁用切换并说明原因；空闲后允许更新。
4. 使用原生语义控件、可见焦点和简体中文标签，不引入卡片堆叠。

## Task 6：验证、审查、正式打包

1. 运行目标单测、相关包测试、TypeScript 类型检查与 lint。
2. 按原始需求反向搜索：空 `工作记录`、`.session-return-latest` sticky/魔数、硬编码 `untrusted`、task 隐式审批 veto。
3. 按 `requesting-code-review` 检查变更范围、兼容性、权限边界和测试证据。
4. 按 `verification-before-completion` 重新执行交付验证。
5. 优雅退出 Zeus，运行 `pnpm build && pnpm package:mac`，启动正式包并通过真实 UI 检查：思考状态、工具行、返回最新消息、权限切换、审批响应。
6. 回写主任务文档的实现、验证、风险与回滚记录。

## 回滚

- 展示层可分别回滚 empty-item projection、typed tool row 和 overlay CSS，不影响 provider 数据。
- 权限模式字段保留也不会改变旧会话内容；若需降级，服务端固定按 `read-only` 读取即可。
- 若 provider 不接受 `danger-full-access`，隐藏该选项并保持数据库值不变，禁止自动降级成更高权限或伪装成功。
