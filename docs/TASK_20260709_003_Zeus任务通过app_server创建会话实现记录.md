# TASK_20260709_003 Zeus 任务通过 app-server 创建会话实现记录

## 目标

将任务运行入口调整为 app-server 会话优先：用户点击任务运行时，前端仍只请求本机 app-server；app-server 先创建持久化 conversation 并写入首条任务 prompt，再启动 Runtime/CLI 执行引擎并回填 Runtime session。

## 实现范围

- `packages/local-server/src/index.ts`
  - 新增任务 Runtime prompt 生成与任务会话创建步骤。
  - `/api/tasks/:taskId/run`、`/api/tasks/:taskId/continue` 复用 `startTaskRuntimeSession`，现在返回 `conversation`。
  - Runtime 启动成功后，conversation 绑定 `runtimeSession.id` 并标记 `running`。
  - Runtime 启动同步异常时，conversation 标记 `failed`、追加 `task_runtime_error` 系统消息，并将任务状态从 `running` 转为 `failed`；HTTP 仍返回已创建的 app-server 会话结果，不再把“执行引擎不可用”当成本机 API 创建会话失败。
  - 新增 `POST /api/projects/:projectId/conversations/:conversationId/messages`，后续消息先追加为 `user_followup` conversation message，再转发到该 conversation 绑定的 Runtime session。
  - Runtime 输入失败时保留用户消息，并追加 `task_runtime_input_error` 系统消息，避免界面“无反应”。
  - 当 conversation 绑定的旧 Runtime 已退出、丢失或当前 app-server 进程内找不到时，后续消息不再直接报 `AI Runtime session not found`；app-server 会基于同一个 conversation 的历史消息自动续接一个新的 Runtime session，回填新的 `sessionId`，并追加 `task_runtime_reconnected` 系统消息。
  - Runtime 退出、失败、停止或 app-server 重启恢复为 `lost` / `orphan_detected` 时，同步把绑定 conversation 从 `running` 修正为对应真实状态，避免 UI 长期显示“运行中”但后续输入已经无可写 Runtime。
  - Runtime stdout/stderr 现在会同步镜像到绑定任务 conversation：stdout 作为 `assistant/runtime_stdout` 消息展示，stderr 作为 `system/runtime_stderr` 消息展示；消息 metadata 记录 `sessionId`、`runtimeLogId`、`stream`，原始来源仍是 `runtime_logs`。
  - Runtime 启动或自动续接时会分页补镜像该 session 的全部既有日志，避免启动早期输出先于 conversation 绑定而丢失；实时日志写入时也会立即镜像，且按 `runtimeLogId` 去重。

- `packages/storage/src/index.ts`
  - 新增 `UpdateConversationRuntimeStateInput`。
  - 新增 `ConversationRepository.updateRuntimeState()`，用于回填 `sessionId`、`status`、`summary`。

- `apps/desktop/src/renderer/App.tsx`
  - 将会话页主操作文案从“推送到 CLI 对话”改为“创建 app-server 会话”。
  - 空事件提示改为 app-server 会话语义，避免把 CLI 暴露成用户交互入口。
  - 任务详情抽屉主按钮也改为“创建 app-server 会话”语义。
  - `run` / `continue` 收到 app-server 返回的 `conversation` 后，自动切到当前项目 Sessions，并选中对应任务会话，避免用户停留在任务抽屉里。
  - 修复 Sessions 已有会话输入框输入/删除后触发错误边界的问题：`onChange` 先同步读取 `event.currentTarget.value`，再进入 React functional updater，避免 updater 延迟执行时 `currentTarget` 已被清空。
  - Sessions 已有会话 composer 不再调用 `updateTask()`；发送按钮改为 `sendTaskConversationMessage()`，通过 `onSendConversationMessage` 调用 app-server 会话消息 API。
  - 会话页进入 Sessions 时会从 app-server 加载 conversation 列表；任务 run/continue 返回 conversation 后会写入前端会话列表并选中。
  - 后续输入使用独立的 `conversationFollowUpDraft`，不再复用任务描述字段，避免把“任务要求编辑”和“会话追问”混成同一个动作。

- `apps/desktop/src/renderer/task/TaskDetailDrawerContent.tsx`
  - 修复旧门禁：READY/DRAFT 任务创建 app-server 会话不再因为 `AI CLI 未配置` 被禁用；忙碌态仍会禁用，避免重复点击。
  - 任务详情里的事件时间改用本地墙钟时间展示到秒，不再直接显示 `2026-07-09T05:51:27.347Z` 这类 UTC ISO 文本。

- `apps/desktop/src/renderer/task/taskWorkspaceModel.ts`
  - `formatTaskUpdatedAt()` 从 UTC ISO 存储值格式化为本机本地时间，继续保持 `YYYY-MM-DD HH:mm:ss` 的紧凑产品 UI 格式。

- `packages/ai-runtime/src/index.ts`
  - 修复 packaged macOS App 从 Finder/Dock 启动时 `PATH=/usr/bin:/bin:/usr/sbin:/sbin` 导致检测不到 `/opt/homebrew/bin/codex` 的问题。
  - 新增 `expandCliSearchPath()`，检测和 Runtime spawn 环境都会补入常见本机 CLI 路径：`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/bin`。
  - 新增动态 `allowedRoots` 支持：Runtime cwd 仍会被限制在允许目录内，但允许注册项目的真实 `localPath`，避免 packaged App 的 `projectRoot=app.asar` 把真实项目目录误判为越界。

- `apps/desktop/src/renderer/apiClient.ts`
  - `TaskRuntimeControlResult` 显式包含 `conversation`。
  - 新增 `SendConversationMessageResult` 与 `sendConversationMessage(projectId, conversationId, content)`，明确 Sessions 后续输入走 app-server。

- `packages/local-server/test/task-control-api.test.ts`
  - 覆盖正常运行：任务运行返回并持久化 app-server conversation，首条消息来源为 `task_prompt`。
  - 覆盖异常恢复：Runtime 启动失败时 conversation 保留为 `failed`，任务状态也变为 `failed`，并通过 201 响应返回 `runtimeError`。
  - 覆盖 packaged App 场景：本地服务根目录为 `app.asar` 时，注册项目 `localPath` 仍可作为 Runtime cwd 启动。
  - 覆盖后续输入：`/api/projects/:projectId/conversations/:conversationId/messages` 会追加 `user_followup`，并把文本写入绑定 Runtime session。
  - 覆盖旧 Runtime 丢失后的续接：第一次 Runtime 退出并重启 app-server 后，继续在同一 conversation 发送消息会自动创建新的 Runtime session、更新 conversation.sessionId，并把续接 prompt 带上历史 `user_followup`。
  - 覆盖 Runtime 输出桥接：任务 Runtime stdout 会被镜像进绑定 conversation，用户在 Sessions 页能看到真实 AI/CLI 输出，而不是只看到“Runtime 已自动续接”。

- `apps/desktop/test/app-shell-layout.test.tsx`
  - 反向防回归：英文界面要求 `Create app-server session`，并禁止旧的 `Send to conversation` / `推送到 CLI 对话` 泄漏。
  - 反向防回归：Sessions 已有会话 composer 禁止在 `setTaskEditForm((current) => ...)` 内延迟读取 `event.currentTarget.value`。
  - 反向防回归：Sessions 已有会话发送按钮必须出现 `onSendConversationMessage` 与 `sendTaskConversationMessage(selectedTask)`，禁止回到 `updateTask(selectedTask.id)`。
  - 反向防回归：当前选中会话收到匹配 `sessionId` 的 Runtime 输出事件时必须重新加载 app-server conversation；其他 session 的事件不能误刷新当前画布。

- `apps/desktop/test/app-task-controls-rendering.test.tsx`
  - 覆盖 `AI CLI 未配置` 时任务详情抽屉的 app-server 会话按钮仍可点击。
  - 覆盖 app-server 返回 conversation 后应解析为 `#project-sessions` 目标，并选中对应任务。

- `apps/desktop/test/app-task-events-rendering.test.tsx`、`apps/desktop/test/task-workspace-model.test.ts`
  - 覆盖 UTC ISO 时间会转为本地墙钟时间展示到秒，且事件流不泄漏原始 ISO 字符串。

- `packages/ai-runtime/test/detect.test.ts`
  - 覆盖 Finder/Dock 受限 PATH 场景下常见 macOS CLI 路径会被补入。

## 已执行验证

- `pnpm vitest run packages/local-server/test/task-control-api.test.ts --reporter=verbose`
  - 结果：8 passed。
- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "selected app language" --reporter=verbose`
  - 结果：10 passed，165 skipped。
- `pnpm vitest run packages/ai-runtime/test/detect.test.ts packages/local-server/test/task-control-api.test.ts apps/desktop/test/app-task-controls-rendering.test.tsx apps/desktop/test/app-shell-layout.test.tsx -t "selected app language|keeps the app-server session action enabled|keeps a failed app-server conversation|adds common macOS|runs, pauses" --reporter=verbose`
  - 结果：14 passed，234 skipped。
- `pnpm vitest run packages/ai-runtime/test/session.test.ts packages/ai-runtime/test/detect.test.ts packages/local-server/test/task-control-api.test.ts --reporter=verbose`
  - 结果：27 passed。
- `pnpm vitest run apps/desktop/test/task-workspace-model.test.ts apps/desktop/test/app-task-events-rendering.test.tsx apps/desktop/test/app-task-controls-rendering.test.tsx --reporter=verbose`
  - 结果：86 passed。
- `pnpm typecheck`
  - 结果：通过。
- `pnpm lint`
  - 结果：通过。
- `pnpm format:check`
  - 结果：通过。
- `git diff --check -- <本任务相关文件>`
  - 结果：通过。
- `pnpm package:mac`
  - 结果：通过；`dist/mac-arm64/Zeus.app` 重新打包并通过本机签名校验。

### 2026-07-09 输入框崩溃补充验证

- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "matches the Codex chat workspace" --reporter=verbose`
  - 红灯：新增防回归断言先失败，命中 Sessions composer 内 `setTaskEditForm((current) => ...)` 延迟读取 `event.currentTarget.value` 的旧模式。
  - 绿灯：修复后结果为 1 passed，174 skipped。

### 2026-07-09 会话发送补充验证

- `pnpm vitest run packages/local-server/test/task-control-api.test.ts -t "appends task conversation follow-up" --reporter=verbose`
  - 红灯：新增接口契约先得到 404，证明后续消息还没有 app-server endpoint。
  - 绿灯：修复后结果为 1 passed，9 skipped；断言 conversation messages 为 `task_prompt` + `user_followup`，Runtime input 收到 `继续检查任务发送链路\n`。
- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "lands Codex active conversation internal tools" --reporter=verbose`
  - 红灯：新增前端契约先失败，缺少 `onSendConversationMessage`。
  - 绿灯：修复后结果为 1 passed，174 skipped；断言发送按钮不再调用 `updateTask(selectedTask.id)`。
- `pnpm typecheck`
  - 结果：通过。

### 2026-07-09 会话发送最终收口验证

- `pnpm vitest run packages/local-server/test/task-control-api.test.ts apps/desktop/test/app-shell-layout.test.tsx apps/desktop/test/app-task-controls-rendering.test.tsx apps/desktop/test/app-task-events-rendering.test.tsx apps/desktop/test/task-workspace-model.test.ts --reporter=verbose`
  - 结果：5 个测试文件通过，271 passed。
- `pnpm lint`
  - 结果：通过。
- `pnpm typecheck`
  - 结果：通过。
- `pnpm format:check`
  - 结果：通过。
- `git diff --check -- <本任务相关文件>`
  - 结果：通过。
- 已先退出运行中的 Zeus，再执行 `pnpm package:mac`。
  - 结果：通过；`/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 重新打包，`valid on disk` 且满足本机 Designated Requirement。

### 2026-07-09 旧 Runtime 丢失后自动续接验证

- `pnpm vitest run packages/local-server/test/task-control-api.test.ts -t "reconnects task conversation follow-up" --reporter=verbose`
  - 红灯：旧实现返回 `runtimeError.message = AI Runtime session not found: ...`，后续消息虽然写入 conversation，但没有新的 Runtime 接管执行。
  - 绿灯：修复后结果为 1 passed，10 skipped；断言同一 conversation 追加 `user_followup` + `task_runtime_reconnected`，新的 `runtimeSession.id` 不等于旧 session，且 conversation.sessionId 已更新为新 session。
- `pnpm vitest run packages/local-server/test/task-control-api.test.ts -t "appends task conversation follow-up|reconnects task conversation follow-up" --reporter=verbose`
  - 结果：2 passed，9 skipped；同时覆盖“活跃 Runtime 直接 input”和“旧 Runtime 丢失自动续接”两条路径。
- `pnpm vitest run packages/local-server/test/task-control-api.test.ts --reporter=verbose`
  - 结果：11 passed。
- `pnpm vitest run packages/local-server/test/task-control-api.test.ts apps/desktop/test/app-shell-layout.test.tsx apps/desktop/test/app-task-controls-rendering.test.tsx apps/desktop/test/app-task-events-rendering.test.tsx apps/desktop/test/task-workspace-model.test.ts --reporter=verbose`
  - 结果：5 个测试文件通过，272 passed。
- `pnpm typecheck`
  - 结果：通过。
- `pnpm lint`
  - 结果：通过。
- `pnpm format:check`
  - 结果：通过。
- `git diff --check -- packages/local-server/src/index.ts packages/storage/src/index.ts packages/local-server/test/task-control-api.test.ts apps/desktop/src/renderer/App.tsx docs/TASK_20260709_003_Zeus任务通过app_server创建会话实现记录.md docs/TASK_20260709_002_Zeus任务会话优先交互动线.html`
  - 结果：通过。
- 已先退出运行中的 Zeus，再执行 `pnpm package:mac`。
  - 结果：通过；`/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 重新打包，`valid on disk` 且满足本机 Designated Requirement。

### 2026-07-09 Runtime 输出桥接到会话验证

- 现场根因：本机 DB 中 `runtime_sessions` 与 `runtime_logs` 已有运行中的 Codex Runtime 输出，但 `conversation_messages` 只包含 `task_prompt`、`user_followup`、`task_runtime_reconnected` 等事件消息；前端 Sessions 页只渲染 conversation messages，因此用户能确认消息已发出，却看不到模型回复。
- 修复口径：
  - `persistRuntimeLog()` 写入 `runtime_logs` 后，会把 stdout/stderr 镜像到绑定该 `sessionId` 的任务 conversation。
  - Runtime 启动或自动续接后，会补镜像启动过程中已经落库的 stdout/stderr，避免输出先于 conversation 绑定而丢失。
  - 镜像消息用 `runtimeLogId` 去重，避免补镜像和实时镜像重复写入。
  - 会话页把 `assistant` 消息标题显示为“AI 回复 / AI response”，不再误标成“等待下一步”。
  - 会话页订阅 app-server 实时事件；当前选中的 conversation 绑定 session 收到 `runtime.session.output` / `runtime.session.error` 后，会重新加载该 conversation 并 upsert 到前端状态，避免输出只进 DB、需要手动刷新后才可见。
- 红灯验证：`pnpm vitest run packages/local-server/test/task-control-api.test.ts -t "mirrors task Runtime stdout" --reporter=verbose`
  - 结果：先失败；conversation messages 只有 `task_prompt`，证明 Runtime stdout 尚未进入 app-server 会话消息。
- 绿灯验证：`pnpm vitest run packages/local-server/test/task-control-api.test.ts -t "mirrors task Runtime stdout" --reporter=verbose`
  - 结果：1 passed，11 skipped；断言 `assistant/runtime_stdout` 写入 conversation，metadata 包含 `sessionId` 与 `stream=stdout`。
- 关联回归：`pnpm vitest run packages/local-server/test/task-control-api.test.ts -t "appends task conversation follow-up|reconnects task conversation follow-up|mirrors task Runtime stdout" --reporter=verbose`
  - 结果：3 passed，9 skipped；同时覆盖活跃 Runtime 输入、旧 Runtime 自动续接、Runtime 输出桥接三条路径。
- 全量任务控制回归：`pnpm vitest run packages/local-server/test/task-control-api.test.ts --reporter=verbose`
  - 结果：12 passed。
- 受影响前后端回归：`pnpm vitest run packages/local-server/test/task-control-api.test.ts apps/desktop/test/app-shell-layout.test.tsx apps/desktop/test/app-task-controls-rendering.test.tsx apps/desktop/test/app-task-events-rendering.test.tsx apps/desktop/test/task-workspace-model.test.ts --reporter=verbose`
  - 结果：5 个测试文件通过，273 passed。
- `pnpm typecheck`
  - 结果：通过。
- `pnpm lint`
  - 结果：通过。
- `pnpm format:check`
  - 结果：通过。
- `git diff --check -- packages/local-server/src/index.ts packages/local-server/test/task-control-api.test.ts apps/desktop/src/renderer/App.tsx packages/storage/src/index.ts docs/TASK_20260709_003_Zeus任务通过app_server创建会话实现记录.md docs/TASK_20260709_002_Zeus任务会话优先交互动线.html`
  - 结果：通过。
- 已先退出运行中的 Zeus，再执行 `pnpm package:mac`。
  - 结果：通过；`/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 重新打包，`valid on disk` 且满足本机 Designated Requirement。


### 2026-07-09 Code review 后实时可见性补修

- review 阻塞点：只在服务端把 Runtime stdout/stderr 镜像进 conversation 仍不够；已打开的 Sessions 页如果没有订阅实时事件，用户仍可能需要刷新页面才看到模型回复。
- 修复口径：
  - `apps/desktop/src/renderer/main.tsx` 将 `client.connectEvents()` 注入 `App`。
  - `apps/desktop/src/renderer/App.tsx` 新增 `shouldRefreshConversationForRuntimeEvent()`，只接受当前 conversation 绑定 session 的 `runtime.session.output` / `runtime.session.error`。
  - 事件命中后调用 `onLoadGraphConversation(projectId, conversation.id)` 重新加载 app-server conversation，并通过 `upsertGraphConversation()` 更新当前会话画布；同一 conversation 的并发刷新用 `pendingRealtimeConversationRefreshIdsRef` 去重。
  - 服务端补镜像改为分页读取全部 Runtime 日志，不再受默认 200 条日志页限制；镜像内容保留原始 `log.text`，不再 trim 掉输出前后空白。
- 红灯验证：`pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "refreshes the selected app-server conversation" --reporter=verbose`
  - 初始结果：失败，`shouldRefreshConversationForRuntimeEvent is not a function`，证明前端没有针对 Runtime 输出事件刷新当前会话的契约。
- 绿灯验证：`pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx -t "refreshes the selected app-server conversation" --reporter=basic`
  - 结果：1 passed，175 skipped。
- 边界验证：`pnpm vitest run packages/local-server/test/task-control-api.test.ts -t "appends task conversation follow-up|reconnects task conversation follow-up|mirrors task Runtime stdout|backfills every startup Runtime stdout" --reporter=verbose`
  - 结果：4 passed，9 skipped；覆盖活跃 Runtime 输入、旧 Runtime 自动续接、stdout/stderr 镜像、启动期 205 条输出分页补镜像。
- 全量任务控制回归：`pnpm vitest run packages/local-server/test/task-control-api.test.ts --reporter=verbose`
  - 结果：13 passed。
- 受影响前后端回归：`pnpm vitest run packages/local-server/test/task-control-api.test.ts apps/desktop/test/app-shell-layout.test.tsx apps/desktop/test/app-task-controls-rendering.test.tsx apps/desktop/test/app-task-events-rendering.test.tsx apps/desktop/test/task-workspace-model.test.ts --reporter=basic`
  - 结果：5 个测试文件通过，275 passed。
- `pnpm typecheck`
  - 结果：通过。
- `pnpm lint`
  - 结果：通过。
- `pnpm format:check`
  - 结果：通过。
- `git diff --check -- packages/local-server/src/index.ts packages/local-server/test/task-control-api.test.ts apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/main.tsx apps/desktop/test/app-shell-layout.test.tsx docs/TASK_20260709_003_Zeus任务通过app_server创建会话实现记录.md docs/TASK_20260709_002_Zeus任务会话优先交互动线.html`
  - 结果：通过。
- 已先退出运行中的 Zeus，再执行 `pnpm package:mac`。
  - 结果：通过；`/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 重新打包，`valid on disk` 且满足本机 Designated Requirement。

## 2026-07-17 “推送到模型”原生首发改造

### 产品口径

- 任务详情主按钮统一改为“推送到模型”；点击后先弹出临时 composer，不再只跳转 Sessions。
- 弹窗打开时只连接 app-server 并读取 `model/list` 能力，不创建 thread/turn；用户确认后才执行 `thread/start` 与首个 `turn/start`。
- 每次任务首发都创建一个新原生会话，不自动续接历史。历史续接继续留在 Sessions 内显式选择。
- 弹窗可选择真实模型、该模型支持的 reasoning effort、Default/Plan 工作模式、只读/自动/完全访问权限，并可填写仅影响本次推送的补充信息。
- 模型、effort、工作模式、权限仅在首个 turn 成功后按项目记住；取消、附件预检失败、thread/turn 失败都不写记忆。项目没有记忆时权限固定为只读。
- 任务附件由服务端从 `source_context_json` 读取，Renderer 不能自报附件路径；项目目录和 Electron Main 管理的 `userData/task-attachments` 是唯一信任根。
- 所有附件必须在创建 thread 前通过真实文件预检；任一附件缺失、损坏或越界时整次推送失败，不允许部分发送。
- 新任务推送不再读取 `allowCodeChanges`、`allowTests`、`allowGitCommit` 兼容字段，也不经过旧 CLI Runtime 的项目/全局并发队列。
- `thread/start` 成功但首个 `turn/start` 失败时保留真实 thread、打开 Sessions 并把任务标为失败，用户可在同一会话恢复，避免重复建 thread。
- 首轮或后续 turn 完成不会自动把任务标为完成；任务保持运行，等待人工验收后点击“标记完成”。

### 实现证据

- `apps/desktop/src/renderer/task/TaskModelPushModal.tsx`
  - 新增模型推送弹窗、三阶段进度、任务正文只读预览、完整附件列表和补充信息输入。
  - 新增项目级成功选择记忆；不支持的旧模型自动回退到项目首选/服务端首选模型，并使用新模型默认 effort。
- `apps/desktop/src/renderer/App.tsx`
  - `run` 路由改为 `model_push`；确认成功前不切换 tab。
  - 首轮 active 时保存项目记忆；已有 provider thread 的恢复态仍导航到真实会话，无 thread 时留在弹窗并显示错误。
- `packages/local-server/src/index.ts`
  - 新增项目级 Codex 推送能力读取 API。
  - `source=task_push` 时由服务端构建标准任务 prompt，在末尾追加“本次推送补充信息”，并从任务记录解析/预检附件。
  - 模型、effort、工作模式、权限在 provider 写入前二次校验；成功后任务转为 running，首轮失败且 thread 已存在时任务转为 failed。
- `packages/local-server/src/codexNativeConversationCoordinator.ts`
  - 显式任务推送支持 `bypassConcurrency`、`workMode`、附件信任根和关闭旧 allow* developer guards。
  - `workMode` 通过 app-server `collaborationMode` 进入首轮 turn；附件作为 `localImage` / `mention` 真实输入项发送。
- `apps/desktop/src/main/main.ts`、`apps/desktop/src/main/localServerRuntime.ts`
  - Electron Main 将实际 `task-attachments` 目录作为本地服务配置传入，Renderer 无权扩大信任边界。

### 自动化验证

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- 定向回归：`pnpm vitest run packages/local-server/test/codex-native-conversation-api.test.ts packages/local-server/test/codex-native-conversation-coordinator.test.ts apps/desktop/test/app-task-controls-rendering.test.tsx`
  - 结果：3 个测试文件、166 个用例通过。
  - 覆盖能力读取零 provider 写、托管附件真实输入、附件缺失整单失败、旧并发满仍直接推送、项目选择记忆、首轮失败保留 thread、模型完成后任务不自动完成。
- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx`：169 个用例通过。
- 全量 `pnpm test` 当前仅剩 `packages/graph-engine/test/graph.test.ts` 的 1 个真实仓库扫描顺序断言失败；该测试按当前脏工作树扫描 `createLocalServer` 的前两个控制流节点，新增业务源码后基准发生变化，与本次推送链路的定向测试无失败关联。

## 风险与回滚

- 风险：当前 Sessions 主画布仍以任务为主展示；本次已补 app-server 会话列表加载、前端 upsert、实时事件刷新当前会话，但没有彻底重构 Sessions 数据模型。
- 风险：Runtime stdout/stderr 已同步镜像到绑定任务 conversation，但原始事实源仍是 `runtime_logs`；如果 CLI 输出很长或包含进度噪声，会按真实输出进入会话，需要后续再做可审计折叠，而不能伪造摘要。
- 风险：如果 CLI 安装在非常规路径，仍需在 Runtime 设置中配置显式 CLI path 或终端环境变量。
- 回滚：回退 `packages/local-server/src/index.ts` 中 conversation-first 创建逻辑、`packages/storage/src/index.ts` 的 `updateRuntimeState()`、前端文案和对应测试即可恢复旧 Runtime-first 行为。
