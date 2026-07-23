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
    - 新增模型推送弹窗、任务正文只读预览、完整附件列表和补充信息输入；2026-07-20 已移除内部创建步骤展示。
  - 新增项目级成功选择记忆；不支持的旧模型自动回退到项目首选/服务端首选模型，并使用新模型默认 effort。
- `apps/desktop/src/renderer/App.tsx`
    - `run` 路由改为 `model_push`；2026-07-20 起确认后先进入会话并显示乐观消息，再等待后台接受结果。
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
- 定向回归：
  `pnpm vitest run packages/local-server/test/codex-native-conversation-api.test.ts packages/local-server/test/codex-native-conversation-coordinator.test.ts apps/desktop/test/app-task-controls-rendering.test.tsx apps/desktop/test/app-task-events-rendering.test.tsx apps/desktop/test/task-workspace-model.test.ts apps/desktop/test/app-shell-layout.test.tsx`
    - 结果：6 个测试文件、357 个用例通过。
  - 覆盖能力读取零 provider 写、托管附件真实输入、附件缺失整单失败、旧并发满仍直接推送、项目选择记忆、首轮失败保留 thread、模型完成后任务不自动完成。
- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx`：视觉收口前 169 个用例通过；新增“推送弹窗不得横向溢出”防回归后为
  170 个用例通过。
- 全量 `pnpm test` 当前仅剩 `packages/graph-engine/test/graph.test.ts` 的 1 个真实仓库扫描顺序断言失败；该测试按当前脏工作树扫描 `createLocalServer` 的前两个控制流节点，新增业务源码后基准发生变化，与本次推送链路的定向测试无失败关联。

### 正式包与真实运行验收

- 已先退出旧 Zeus 进程，再执行 `pnpm package:mac`；`dist/mac-arm64/Zeus.app` 构建成功。
- `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app`：通过，产物 `valid on disk` 且满足 Designated
  Requirement。
- 正式包内 `app.asar` 已检出 `codex-task-push-capabilities` 与 `source=task_push` 新服务端链路；正式窗口 URL 指向
  `dist/mac-arm64/Zeus.app/Contents/Resources/app.asar/dist/renderer/index.html`，不是源码开发页。
- 在正式包 `Zeus E2E / ZEU-000001` 任务详情中确认：主按钮为“推送到模型”；点击后原地打开临时弹窗，模型为 `GPT-5.6-Sol`
  、effort 为 `low`、工作模式为 `Default`；项目无成功记忆时权限真实回退为“只读”；补充信息、标准任务正文和完整附件计数均可见。
- 首次视觉验收发现表单控件的 content-box 宽度导致弹窗底部出现横向滚动条；已将弹窗控件统一为
  border-box、正文限制为只纵向滚动，并在再次退出、重打 `pnpm package:mac`、重启正式包后确认横向滚动条消失。
- 使用补充信息 `MODEL_PUSH_OK` 执行真实首发后，Renderer 创建并选中了新原生会话；数据库会话为
  `conversation_161b00b442b53b1322dd29ad`，provider thread 为 `019f6f04-a83e-7611-8ff7-cd5c1a788f37`，
  `provider_state=ready`、`permission_mode=read-only`、`provider_model=gpt-5.6-sol`。
- 首轮真实输入包含标准任务正文以及独立的“本次推送补充信息”段落，模型返回完成；app-server 启动期仍出现既有的
  `Secret-like provider field rejected: snapshot.openai-api-key-local-confirmation` 诊断项，但未阻断
  turn，最终会话从短暂错误态转为“已就绪”。
- 首轮完成后任务仍为 `running`、`completed_at IS NULL`，并记录两条 `task.model_push.started` 事件；没有自动标记完成，符合人工验收口径。
- Chromium Local Storage 已写入项目级成功选择：`gpt-5.6-sol / low / default / read-only`；`PRAGMA quick_check=ok`。

## 2026-07-20 MCP 服务标识误报修复

### 真实根因

- 正式包推送后的当前会话出现 `Secret-like provider field rejected: snapshot.openai-api-key-local-confirmation`
  ，但同一页面仍显示“运行时状态正常”。
- app-server 的 `mcpServer/startupStatus/updated` 事件把 `params.name` 作为 MCP 服务标识；已安装 OpenAI Developers 插件的
  `.mcp.json` 确实注册了名为 `openai-api-key-local-confirmation` 的 MCP 服务。
- Coordinator 将该名称规范化为 MCP 启动状态映射的顶层键；Storage 原校验递归检查所有键名，因名称含 `api-key` 将服务标识误判为凭据字段。
- Provider 事件兜底错误处理又把该校验异常写成当前执行轮次的持久化 `error` item，因此用户看到红色“本轮错误”；这不是模型生成或
  app-server 连接失败。
- 当前正式数据库存在多条同文本误报，`PRAGMA quick_check=ok`；既有 MCP 状态快照因对应事件被拒绝而未包含该服务。

### 已确认的领域与安全边界

- `MCP 服务标识` 是状态映射的身份标签，不是 provider 负载字段；服务名可以合法包含 `api-key` 等文本。
- 只停止对 MCP 状态映射顶层服务标识应用敏感字段名规则；每个服务的状态内容仍执行 secret-like 递归校验和严格结构校验。
- Rate limits、provider settings、token usage 以及 MCP 状态对象内部的 `apiKey`、`token`、`cookie`、`credential` 等规则均不放宽。
- 历史修复只删除 `item_type=error`、`provider_item_id` 为 provider event error、且文本与本误报完全相等的记录；诊断设置也只移除
  method 和 error message 同时精确匹配的条目，其他真实错误保留。

### 实现与回归

- `packages/storage/src/index.ts`：MCP 快照按“服务标识 → 状态”分层校验；新增
  `20260720_0005_mcp_server_identifier_false_positive_cleanup` 幂等迁移清理历史误报。
- `packages/storage/test/storage.test.ts`：覆盖合法服务名持久化、状态内部 secret 继续拒绝、迁移精确清理以及真实错误保留。
- `packages/local-server/test/codex-native-conversation-coordinator.test.ts`：覆盖真实单服务事件合并、snapshot/broadcast
  持久化且不生成 `conversation.native.error` 或错误 item。
- RED：修改实现前两个相关测试文件共 85 个用例中 4 个失败，分别锁定服务名误拒绝、Coordinator 未更新、迁移未登记和历史误报未清理。
- GREEN：实现后两个相关测试文件共 85 个用例全部通过。

### 质量门禁与正式包验收

- `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`git diff --check`：通过。
-
`pnpm vitest run packages/storage/test/storage.test.ts packages/local-server/test/codex-native-conversation-coordinator.test.ts packages/local-server/test/codex-native-conversation-api.test.ts`
：3 个测试文件、127 个用例全部通过。
- `pnpm verify:acceptance-matrix`：12 sections / 139 items 通过。
- 全量 `pnpm test`：1441 passed / 4 skipped；仅仓库既有的 2 个真实仓库控制流顺序断言失败，失败仍位于 `graph.test.ts` 与
  `graph-view-api.test.ts`，与 MCP snapshot、provider event 和迁移无关。
- 优雅退出旧 Zeus 后执行 `pnpm package:mac` 成功；`codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app`
  返回 `valid on disk` 且 `satisfies its Designated Requirement`。
- 新正式包启动后迁移 `20260720_0005_mcp_server_identifier_false_positive_cleanup` 已落库；误报 conversation item 数为 `0`
  、误报 provider diagnostics 数为 `0`，其他真实 provider error item 仍保留 `10` 条，`PRAGMA quick_check=ok`。
- 在用户原报错的 `tc-app-core / 分析当前项目结构` 会话中现场确认：红色“本轮错误”不再出现，页面显示“已就绪”“运行时状态正常”，运行时详情包含
  `Openai api key local confirmation status: ready`。
- 同一正式运行现场的持久化 MCP snapshot 为新 generation，服务 `openai-api-key-local-confirmation` 的状态为 `ready`、error
  为 `null`；证明真实 app-server 事件已通过新校验，不是只在 mock 测试中通过。
- 反向扫描 production 源码后，该历史错误文本只存在于一次性精确清理迁移中，不存在继续生成该误报的分支。

`VERIFICATION PASSED: ROOT CAUSE, SECURITY BOUNDARY, TESTS, OFFICIAL PACKAGE, LIVE PROVIDER SNAPSHOT, PACKAGED UI AND DATABASE CLEANUP`

## 2026-07-20 推送交互去过程化与乐观首发

### 产品口径

- “推送到模型”弹窗不再展示“连接 app-server / 创建新会话 / 发送任务与附件”三步过程；用户只需要确认模型、模型等级、工作模式、权限、补充信息和实际发送内容。
- 四个配置字段统一使用 `ZeusSelect`，保留明确的下拉箭头、当前值、选中勾选和键盘交互；短选项列表不显示搜索区。
- `ZeusSelect` 展开层固定从触发区下方出现，宽度与触发区严格相等；移除全局 `280px` 和任务工具栏 `210px` 的强制最小宽度，避免展开层左右越界。
- 用户点击“确认推送”后，Renderer 立即进入项目会话页并显示完整首条用户消息，不等待 `thread/start` 和首个 `turn/start` 返回。
- 后台接受成功后，用真实 conversation/thread 无闪退接管乐观消息；真实会话快照加载完成前继续保留已显示的首条消息，同时暂不开放下一条消息输入。
- 后台接受失败时不返回弹窗；当前会话原位显示失败原因和“重试发送”，重试复用原 `idempotencyKey` 与 `clientUserMessageId`，避免
  unknown outcome 创建重复 thread。

### 实现证据

- `apps/desktop/src/renderer/task/TaskModelPushModal.tsx`
    - 删除三步进度条；四个原生 `<select>` 全部替换为 `ZeusSelect`。
    - `buildTaskModelPushMessage()` 统一拼接服务端标准任务正文与本次补充信息，弹窗预览和乐观消息使用同一文本。
- `apps/desktop/src/renderer/task/TaskModelPushPendingWorkspace.tsx`
    - 通过 `sessionReducer(send_started)` 创建包含首条用户消息和附件的临时会话状态。
    - 提供提交中、失败、重试和真实接受桥接状态；失败消息留在会话页，不退回创建过程。
- `apps/desktop/src/renderer/App.tsx`
    - 提交事件先插入临时 conversation choice、选中会话并切换到 `#project-sessions`，随后才异步调用 `startTaskModelPush()`。
    - choices 协调器新增 `forget()`，真实 acceptance 到达后移除临时 choice 并保留真实 choice，防止并发历史刷新把当前选择覆盖掉。
- `apps/desktop/src/renderer/session/SessionWorkspace.tsx`
    - 真实会话快照加载期间使用乐观状态兜底，避免首条消息短暂消失；兜底期间隐藏 composer，避免在真实会话尚未可写时误发第二条消息。
- `packages/local-server/src/index.ts`
    - 能力读取接口增加任务身份校验并返回 `canonicalPrompt`；Renderer 因此可以在 provider 返回前显示与服务端实际发送一致的标准任务正文。
- `apps/desktop/src/renderer/styles.css`
    - `zeus-select-popover` 统一为 `inline-size / min-inline-size / max-inline-size: 100%`，并显式使用 `border-box`。

### 阶段性自动化验证

- `pnpm typecheck`：通过。
-
`pnpm vitest run apps/desktop/test/app-task-controls-rendering.test.tsx apps/desktop/test/app-shell-layout.test.tsx packages/local-server/test/codex-native-conversation-api.test.ts`
    - 结果：3 个测试文件、283 个用例通过。
    - 覆盖无三步过程、四个 `ZeusSelect`、展开层等宽、标准任务正文能力读取、先导航后请求、首条消息乐观展示、失败原位重试和临时
      choice 清理。
- `git diff --check`：通过。
- `pnpm lint`：通过。
- `pnpm format:check`：通过。
- `pnpm verify:acceptance-matrix`：通过，12 个章节、139 项。
- `pnpm test`：1441 passed、4 skipped、2 failed。
    - 两个失败分别为 `packages/graph-engine/test/graph.test.ts` 与 `packages/local-server/test/graph-view-api.test.ts`
      的当前真实仓库控制流顺序断言；两者都扫描当前脏工作树并假设 `createLocalServer` 的前两个控制流节点存在固定边，和本次任务推送、下拉框及乐观会话链路无关。
- 已优雅退出旧 Zeus 后执行 `pnpm package:mac`：通过。
- `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app`：通过，正式包 `valid on disk` 且满足 Designated
  Requirement。
- 正式包 `app.asar` 已核对包含任务级 `codex-task-push-capabilities?taskId`、`pending-task-push` 乐观会话、立即进入会话文案和原位重试逻辑；包内
  Renderer 不包含旧 `task-model-push-progress` 与 `210px/280px` 强制下拉宽度规则。
- 正式包已重新启动；用户后续现场已证实推送后立即进入会话并显示首条消息，本轮又在同一 packaged App 中确认 MCP 服务状态为
  ready 且历史红色误报消失。

### 2026-07-20 首条消息空快照交接竞态修复

- 现场会话 `conversation_05d1085d669817f02abdda10` 在 `10:49:31.006Z` 创建提交、`10:49:32.748Z` 开始执行；用户截图位于
  `10:49:39.130Z`，provider 确认的首条用户消息直到 `10:49:47.659Z` 才落库。截图正好位于“执行已开始、provider userMessage
  尚未确认”的窗口内，消息事实没有丢失。
- 真实根因不是后端延迟本身，而是 Renderer 把“任意真实快照已加载”误当成乐观状态交接完成：首个快照按 provider-confirmed
  契约合法返回空 `messages`，外层 `fallbackState` 却立即失效，导致首条消息短暂消失；provider item 到达后又重新出现。
- `apps/desktop/src/renderer/session/useSessionController.ts`：真实 controller 创建时只接管同 conversation 的乐观
  item；不继承临时快照、队列、错误或 transport 状态。首个空快照进入现有 `hydrateSnapshot()` 后，乐观 item 继续保留。
- `apps/desktop/src/renderer/session/sessionSelectors.ts`：新增 provider 确认选择器，只认非乐观 user item 且
  `clientUserMessageId` / `durableClientUserMessageId` 精确匹配。
- `apps/desktop/src/renderer/session/SessionWorkspace.tsx`：移除“整份 fallback 状态覆盖真实 controller”的双状态源；每个
  conversation 只在 controller 初始化时接管一次乐观状态，真实快照到达前继续隐藏 composer。
- `apps/desktop/src/renderer/App.tsx`：conversation 以真实 id 隔离 controller 生命周期；不再因 `state.snapshot` 存在或
  transport 失败就清理 task-push pending，只有匹配的 provider user item 确认后才清理。
- 后端 `conversation_messages` 的 provider-confirmed 持久化契约保持不变；没有为了消除闪烁提前伪造持久化用户消息。
- RED：新增 controller 回归后，首个空快照把 user item 清空，聚焦测试稳定得到 `1 failed / 34 passed`。
- GREEN：实现接管与身份确认后，`session-reducer.test.ts` 为 `35 passed`；结合 `app-task-controls-rendering.test.tsx` 共
  `106 passed`。
- 扩展回归：`session-workspace.test.tsx`、`app-task-events-rendering.test.tsx`、`api-client.test.ts` 共 `127 passed`；
  `pnpm typecheck`、`pnpm lint`、相关文件 Prettier 检查、`git diff --check` 均通过。
- `pnpm format:check`、`pnpm verify:acceptance-matrix` 通过，后者为 12 个章节、139 项；反向扫描确认 production 源码不再包含
  `fallbackState && !state.snapshot`、旧 `fallbackState=` 传递和“快照存在或 transport 失败即清理 pending”的分支。
- 全量 `pnpm test` 的本次运行只剩 `packages/graph-engine/test/graph.test.ts` 中“同一函数内控制流节点按源码顺序连接”的 1
  个当前真实仓库扫描断言失败；任务推送、Session controller 与 Workspace 相关测试均通过。
- 已优雅退出旧正式 App 并执行 `pnpm package:mac`：通过，生成 `dist/mac-arm64/Zeus.app`、`dist/Zeus-0.1.0-arm64.dmg` 和
  `dist/Zeus-0.1.0-arm64.zip`；正式 App 与 `app.asar` 构建时间为 `2026-07-20 19:14:05 +0800`。
- `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app`：通过，产物 `valid on disk` 且满足 Designated
  Requirement；包内检出新 controller 接管和 provider 确认逻辑，旧 fallback gate 与旧 pending 清理模式计数均为 `0`。
- 正式包真实验收使用 `Zeus E2E / ZEU-000002 / 乐观消息空快照交接验收 20260720`：确认推送后首条用户消息立即显示；2.5
  秒后页面已经进入真实 conversation、运行时详情与真实 composer 已加载，但 provider 尚未确认的首条消息仍保持可见并显示“发送中”，准确覆盖原故障窗口。
- 最终页面显示“已就绪”，首条用户消息只出现 1 次、`发送中` 消失，模型回复 `OPTIMISTIC_HANDOFF_OK` 只出现 1 次，没有消息消失或重复。
- 正式数据库进一步确认：submission 在 `11:17:29.138Z` 创建、`11:17:30.682Z` 派发，provider user message 到 `11:17:45.601Z`
  才持久化，确认窗口长达约 16.5 秒；最终 submission 与 turn 均为 `completed`，同一 conversation 仅持久化 1 条 user message
  和 1 条 assistant message，user message 的 `client_message_id=f42c2617-e8c7-4693-894f-755982e20c49` 与 submission 精确一致，
  `PRAGMA quick_check=ok`。

`VERIFICATION PASSED: EMPTY SNAPSHOT HANDOFF, PROVIDER IDENTITY CONFIRMATION, TESTS, OFFICIAL PACKAGE, TEMPORAL UI CHECK AND DATABASE CONVERGENCE`

## 2026-07-21 Codex App 归档导致旧会话待发送卡住修复

### 现场事实与真实根因

- 用户现场会话 `conversation_05d1085d669817f02abdda10` 绑定 provider thread `019f7f25-32a2-7a63-8f59-a433f245ab2b`；Codex
  App 已将该 thread 移入 `archived_sessions`，但 Zeus 数据库仍记录 `provider_state=ready`。
- app-server 对该 thread 执行 `thread/resume` 返回：
  `session ... is archived. Run codex unarchive ... to unarchive it first.`；这不是并发队列、模型繁忙或普通网络失败。
- 原 Coordinator 将所有 resume 失败统一记为 `recovery_required`，且只暂停 `dispatching/active` submission，没有处理仍为
  `queued` 的消息；REST 快照又把“只有 queued submission”的会话推断为 `idle`，因此 UI 同时显示“会话就绪”和“待发送”，形成无出口假状态。
- 新正式包启动后的权威快照确认该会话为 `providerState=archived`、队列为 `paused/provider_archived`，原消息“画图给我看”为
  `paused/provider_archived`，没有丢失或重复发送。

### 领域边界与产品口径

- Zeus 业务归档与 Codex provider thread 归档是两个不同状态；本次新增的是 provider 状态 `archived`，不会把 Zeus
  会话主记录设为业务归档。
- 检出 Codex App 归档后，所有 queued/dispatching/active submission 转为 `paused/provider_archived`，队列不再自动重试，也不再显示
  ready。
- Zeus 不静默撤销用户在 Codex App 中做出的归档操作。只有用户点击“恢复并继续”后才调用 `thread/unarchive`，随后 resume/read
  同一 thread，并按原队列顺序续发已有消息。
- 恢复失败时继续保持 archived 和原队列，不把未知结果伪装成成功，也不创建新 thread。

### 实现证据

- `packages/ai-runtime/src/codexAppServerManager.ts`
    - 新增 typed `unarchiveThread()`，严格调用 app-server `thread/unarchive`。
- `packages/storage/src/index.ts`
    - `ConversationProviderState` 新增 `archived`，沿用现有 TEXT 字段，无需破坏性迁移；provider-archived binding
      仍参与启动恢复，以便识别用户从其他 Codex 客户端取消归档后的真实状态。
- `packages/local-server/src/codexNativeConversationCoordinator.ts`
    - 精确识别 app-server archived 错误，持久化 `archived/provider_archived`，暂停原队列并广播 thread/queue 权威变化。
    - 新增显式 `restoreArchivedConversation()`：unarchive → resume → read → 恢复原 paused submission 为 queued → 按既有队列调度。
- `packages/local-server/src/index.ts`
    - 新增 `POST /api/projects/:projectId/conversations/:conversationId/provider-thread/restore`。
    - 会话快照优先把 provider archived 映射为 `paused/provider_archived`；conversation choice 不再把 archived 会话标为
      resumable。
- `apps/desktop/src/renderer/session/*`
    - 当前会话显示“已归档”和“此会话已在 Codex App 中归档”，composer 只读，并提供“恢复并继续”。
    - 左侧 source tree 显示“会话已归档”，不再误报“会话就绪”；恢复响应使用权威快照重新 hydrate，同一页面继续工作。

### 自动化验证

- RED：
    - manager 测试稳定失败为 `manager.unarchiveThread is not a function`。
    - Coordinator 重启恢复测试稳定失败为 provider state 仍是 `ready`。
    - REST 测试稳定失败为恢复端点 `404`。
    - Renderer 测试稳定失败为无恢复动作、无归档提示，仍显示通用“此会话已不能继续”。
- GREEN 聚焦回归：
    - ai-runtime 22 个用例通过。
    - storage provider-archived binding 用例通过。
    - local-server Coordinator/API 103 个用例通过。
    - desktop controller/workspace/API client 197 个用例通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check`：通过。
- 全量 `pnpm test`：全部通过；本次运行覆盖 70 余个测试文件，Codex live 测试按既有条件跳过 4 个，无失败。
- `pnpm build`：通过。

### 正式包与运行现场验收

- 已正常退出旧 Zeus，执行 `pnpm package:mac` 成功；产物为 `dist/mac-arm64/Zeus.app`、`dist/Zeus-0.1.0-arm64.dmg`、
  `dist/Zeus-0.1.0-arm64.zip`，最终构建时间为 `2026-07-21 13:47:45 +0800` 起。
- `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app`：通过，正式 App `valid on disk` 且满足
  Designated Requirement。
- 正式包 `app.asar` 已检出 `thread/unarchive`、`ZEUS_CODEX_THREAD_ARCHIVED` 和 `/provider-thread/restore`，证明不是只改源码未进包。
- 新正式包通过 Electron 调试现场确认：`tc-app-core` 左侧多条由 Codex App
  归档的会话均显示“会话已归档”；原问题会话标题状态为“已归档”，正文提示真实原因，按钮为“恢复并继续”，composer 为 disabled。
- 同一运行现场通过本地权威 API 确认原问题会话仍保留 submission “画图给我看”，状态为 `paused/provider_archived`。
- 为遵守“只有显式用户操作才撤销 Codex App 归档”的边界，本次验收没有代替用户点击真实会话的“恢复并继续”；unarchive 和原消息续发已由
  manager、Coordinator、REST 与 Renderer 分层测试覆盖。

`VERIFICATION PASSED: PROVIDER ARCHIVE CLASSIFICATION, DURABLE QUEUE PAUSE, EXPLICIT UNARCHIVE, ORIGINAL MESSAGE RESUME, FULL TESTS, OFFICIAL PACKAGE AND PACKAGED ELECTRON UI`

## 2026-07-22 会话可继续性透明化收口

### 用户确认的产品语义

- 用户只需知道消息是否待发送、发送中或暂时无法发送，不需要知道 provider thread 是否归档。
- “归档”、“恢复并继续”和 `thread/unarchive` 均是内部存储与运行机制，不再投影成会话页用户术语。
- 已有待发送消息时，Zeus 自动执行 `unarchive → resume/read → 原队列续发`；没有待发送消息时，在用户下一次发送前透明执行同一链路。
- 透明恢复失败时保留原始 submission 和排队顺序，界面只显示“待发送”与“重试发送”，技术原因继续留在内部状态与日志中。
- 本节覆盖上一节“必须显式点击恢复”的 UI 决策；provider 状态仍持久化，用于日志、幂等与失败诊断。

### 实现收口

- `packages/local-server/src/codexNativeConversationCoordinator.ts`
    - 启动恢复完成后自动查找带有待发送 submission 的内部归档 thread，恢复后交给现有公平队列调度。
    - 新消息提交时若已知底层状态，先透明恢复再派发；若 `turn/start` 现场才发现状态变化，则恢复后只重试一次，防止循环写入。
    - 自动恢复失败依旧标记 `paused/provider_archived`，不丢失、不重复发送、不新建 thread。
- `packages/local-server/src/index.ts`
    - provider 归档不再把 native conversation choice 标记为不可续接；业务归档、`closed` 和 `failed` 仍保持原边界。
- `apps/desktop/src/renderer/session/*`
    - source tree 只显示“会话就绪”或“待发送”，会话标题区不再显示“已归档”。
    - 移除顶部归档说明和“恢复并继续”按钮，composer 保持可写；自动恢复失败时，待发送区提供不暴露内部状态的“重试发送”。

### 验证证据

- RED：Coordinator 新用例在旧实现下稳定得到 `manager.unarchives=[]`；Renderer 新用例稳定读到“会话已归档”、“恢复并继续”与
  disabled composer。
- GREEN 聚焦回归：Coordinator/API/Workspace/Reducer/Controller 共 `239 passed`；另有 renderer API client `71 passed`。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm format:check`：通过。
- `pnpm verify:acceptance-matrix`：通过，12 个章节、139 项。
- `pnpm test`：`1496 passed`、`4 skipped`，共 90 个测试文件，无失败。
- `pnpm build`：通过；Vite 仅保留现有大 chunk 告警，不影响构建成功。
- `git diff --check`：通过。
- 经用户授权正常退出旧 Zeus 后，`pnpm package:mac`：通过；正式产物已更新为 `dist/mac-arm64/Zeus.app`、
  `dist/Zeus-0.1.0-arm64.dmg`、`dist/Zeus-0.1.0-arm64.zip`，`app.asar` 构建时间为 `2026-07-22 14:38:43 +0800`。
- `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app`：通过，App `valid on disk` 且满足 Designated
  Requirement；当前为 arm64 ad-hoc 签名，未做 Developer ID 分发签名和 notarization，不把本地验签等同于可对外分发。
- 正式包 `app.asar` 只检出新降级文案“重试发送”，未检出“恢复并继续”、“此会话已在 Codex App 中归档”和“会话已归档”。
- 新正式包已从 `dist/mac-arm64/Zeus.app` 拉起，主进程与 Renderer 进程均真实运行，macOS 可访问性树确认存在 1 个标题为
  `Zeus` 的窗口。
- 打开 `tc-app-core → 会话 → 了解发货链路` 后，原待发送消息“画图给我看”已自动成为 14:40 的用户消息，原会话进入“正在处理”；页面未显示
  provider 归档或恢复提示，证明“启动恢复 → 原队列续发”在正式包真实运行现场闭环。
- 运行现场截图：
  `/Users/david/.codex/visualizations/2026/07/22/019f8875-c2c2-7771-aad1-4f2e780f5ea0/zeus-auto-continue-runtime.png`。
- macOS 统一日志未发现本次 Zeus 业务链路的崩溃、未处理异常或 fatal；仅出现系统 StoreKit 远端队列查询错误，与本次会话恢复链路无关。

`VERIFICATION PASSED: TRANSPARENT PROVIDER RECOVERY, ORIGINAL QUEUE RESUME, FULL TESTS, OFFICIAL PACKAGE AND PACKAGED ELECTRON UI`

## 风险与回滚

- 风险：当前 Sessions 主画布仍以任务为主展示；本次已补 app-server 会话列表加载、前端 upsert、实时事件刷新当前会话，但没有彻底重构 Sessions 数据模型。
- 风险：Runtime stdout/stderr 已同步镜像到绑定任务 conversation，但原始事实源仍是 `runtime_logs`；如果 CLI 输出很长或包含进度噪声，会按真实输出进入会话，需要后续再做可审计折叠，而不能伪造摘要。
- 风险：如果 CLI 安装在非常规路径，仍需在 Runtime 设置中配置显式 CLI path 或终端环境变量。
- 回滚：回退 `packages/local-server/src/index.ts` 中 conversation-first 创建逻辑、`packages/storage/src/index.ts` 的 `updateRuntimeState()`、前端文案和对应测试即可恢复旧 Runtime-first 行为。
