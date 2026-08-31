# ZEUS-0407 遇到网络问题时 Zeus 会卡死

## 当前阶段

现场证据、调用链和修复已经收口。静态检查、构建、Test 打包与隔离 Detached Core 恢复现场通过；由于 ZEUS-0408 正占用唯一 Test 应用身份，本任务未启动 GUI，不能把以下证据描述为真实界面验收。

## 用户现场

- 2026-08-31 10:55 的截图中，会话正文和输入框仍可见，但顶部长期显示“正在同步会话状态”。
- 同一时刻环境信息中的 Git、本地目录与分支也无法读取，说明不是单个会话组件卡住。
- 用户将问题描述为网络异常后 Zeus 卡死。网络异常是触发条件；现有采样不足以把 Main 高 CPU 的具体 JavaScript 回调归因到某个外部请求。

## 只读证据

正式数据根的 `execution-host/host.log` 给出了同一故障窗口：

- 10:53:22，旧 Execution Host 的 UI 租约过期；随后控制面健康检查连续 `fetch failed`。
- 10:54:14，Main 成功连接新 Host；10:54:34，新 Host 的 UI 租约再次过期。
- 10:55:07，Renderer 记录 `GET /api/projects` 与 `GET /api/tasks` 的本地服务读取超时。
- 10:57:36 后才出现最终退出和重新启动，和用户截图中的持续不可用一致。

macOS 同期诊断报告记录正式 Zeus Main 在 10:53:20 至 10:54:56 的平均 CPU 约为 94%，并判定为真实的 Main CPU hang。最重栈位于 Electron Main 的 Node/uv 回调；报告未提供可定位到源码函数的 JavaScript 符号。

## 根因

1. Main 每秒给 Detached Core 续租，但一次心跳失败后，`maintainLease` 会同步等待完整恢复流程。
2. 恢复流程包含控制请求、重新发现或启动 Host、注册 Browser bridge，以及 `onRestarted`。这些步骤可能远长于单次心跳，并在此期间阻止下一轮续租。
3. 因此新 Host 即使已经 attach，也可能在 Main 仍等待恢复尾部时再次失去租约，形成“恢复后再次过期”的放大循环。
4. Renderer 的会话状态同步失败后会无限后台重试，但状态一直保留为 `syncing`，把可恢复故障呈现成永久加载。

本地 GET 已有 8 秒超时和一次连接刷新；问题不在缺少单次请求超时，而在上层生命周期把续租与慢恢复串行化，以及失败状态没有降级表达。

## 修复边界与取舍

采用最小根因修复：

- 心跳失败只触发一个并发去重的恢复任务，不再让后续心跳等待恢复完成；attach 更新连接后，下一轮心跳可以立即续租新 Host。
- 初次会话快照同步失败时保留缓存内容，进入“暂未同步、后台重试”状态；成功后自动回到已连接。
- 复用现有 GET 超时、连接刷新、恢复单飞和后台重试，不新增网络层、队列或依赖。

不单独依赖“延长租约”掩盖问题。延长租约实现最小，但会推迟真正孤儿 Host 的自动清理，且不能解除恢复流程对下一次心跳的阻塞。把心跳搬到 Worker 能进一步隔离 Main 事件循环抖动，但会新增协议、进程生命周期与打包复杂度；当前现场不需要这一层。

## 数据与安全边界

- 不自动重放可能已写入的命令，不改变写请求恢复语义。
- 不结束或借用正式应用、其他任务的 Test app 或 Execution Host。
- 不改变 SQLite 单写者、kernel lease、数据根身份和跨版本交接闸机。

## 待完成

无待实现代码。真实 GUI 的网络中断回归仍待 Test 身份空闲后补验。

## 实现结果

- `localServerRuntime.ts`：心跳失败后只触发既有单飞恢复，不再等待完整恢复流程；attach 更新连接后，后续心跳可以立即给新 Host 续租。
- `executionHost.ts`：UI 租约容忍度由 15 秒调整为 120 秒，覆盖本次观测到的约 96 秒 Main 高 CPU 窗口；正常退出、升级交接和活动工作保活不依赖该兜底。
- `useWorkspaceDomainActions.tsx`、`useWorkspaceQueryState.tsx`、`WorkspaceView.tsx`：首次快照失败后保留缓存内容并进入 `stale`，显示“会话状态暂未同步，正在后台重试”；后续重试不再反复切回旋转中的 `syncing`，成功后自动恢复为已连接。

## 验证结果

通过：

- 受影响文件 Prettier 检查与 `git diff --check`。
- `pnpm lint`。
- `pnpm typecheck`，包含架构治理检查。
- `pnpm build`；随后最终改动再次通过 `pnpm --filter @zeus/desktop build`。
- `pnpm package:mac`，生成 `dist/test/mac-arm64/Zeus Test.app`；Info.plist 确认为 `dev.hypha.zeus.test`，应用及内嵌组件通过签名结构校验。
- 隔离临时 Test 数据根的真实 Detached Core 恢复现场：主动结束旧 Host，等待 Main 发现并 attach 新 Host，再让 `onRestarted` 保持未完成 21 秒；结果为旧 PID 已退出、新 generation 已发布且 `uiLease.connected=true`。临时数据根和 Host 已正常收口。

未通过但不隐瞒：

- 完整 `pnpm verify:detached-host` 在后续既有“活动任务跨版本应保持 `draining_previous`”断言失败。移除本任务新增的慢恢复场景后，该失败仍可复现；因此未把完整探针计为通过，也未在本任务中扩展范围修改跨版本交接。
- 真实 GUI 未启动。只读进程检查发现 ZEUS-0408 的 `Zeus Test.app` 正使用 `/private/tmp/zeus-0408-gui...` 独立数据根运行；本机同时存在非主外接屏，但 Test 身份仍被占用。为避免竞争，本任务没有关闭、借用或启动第二实例。

## 剩余边界

- 120 秒租约是针对真实硬件现场的校准值。优点是短时 Main 高 CPU 或网络恢复不再误清理仍被界面使用的 Core；缺点是 Main 异常崩溃且未走正常退出时，空闲 Core 最多比原来晚约 105 秒进入回收。
- 修复阻断了已确认的“慢恢复导致新 Host 再次过期”放大链，但 macOS 报告没有 JavaScript 符号，不能据此宣称已经定位造成 Main 94% CPU 的具体回调。
- 未新增写请求自动重放；结果未知的 Provider 写操作仍沿用现有恢复闸机。
