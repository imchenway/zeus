# ZARCH-030/031 Work Management 任务状态与运行命令纵切

## 范围与结论

本切片只接管以下 7 个 Local Server 公开写入口，不包含 Task Integration、Git、Settings、Security、Provider 配置或 Conversation 公开路由：

| 公开入口 | 稳定命令 | 分类 | 核心边界 |
| --- | --- | --- | --- |
| `PATCH /api/tasks/:taskId/status` | `work_management.task.status.update` | `core_application` + 子 External Outbox | Task、TaskEvent、文件投影 outbox、accepted receipt 与待发 Telegram 子命令同事务 |
| `PATCH /api/tasks/:taskId/management-status` | `work_management.task.management_status.update` | 条件式 Core/External | 无清理时 Core；worktree、会话或 Runtime 清理/恢复时先写 durable marker |
| `POST /api/projects/:projectId/task-board/moves` | `work_management.task_board.move` | 条件式 Core/External | 普通排序为 Core；联动管理状态清理/恢复时进入 External 四态 |
| `POST /api/tasks/:taskId/run` | `work_management.task.runtime.run` | `external_operation` | Provider/Runtime 写出前 marker；成功后 Task/TaskEvent/accepted receipt 同事务 |
| `POST /api/tasks/:taskId/pause` | `work_management.task.runtime.pause` | `external_operation` | 停止 Runtime 前 marker；成功后 Task 状态与 accepted receipt 同事务 |
| `POST /api/tasks/:taskId/continue` | `work_management.task.runtime.continue` | `external_operation` | 与 run 相同；Codex 历史会话仍要求显式选择，不在本入口猜测恢复对象 |
| `POST /api/tasks/:taskId/cancel` | `work_management.task.runtime.cancel` | `external_operation` | 停止 Runtime 前 marker；成功后取消事实与 accepted receipt 同事务 |

Renderer 对每次用户动作只构造一次不可变 `{ command, input }`。重连或 HTTP 重试复用同一 `commandId`、`idempotencyKey`、scope 与 input；服务端重新计算正文摘要并拒绝身份相同但正文不同的请求。旧的裸 body handler 与 fallback 已删除。

## 事务与外部写协议

`WorkManagementCommandApplication` 是唯一公开接纳入口：

1. Core 路径在一个 `durableTransactionSync` 中写 Inbox/Outbox、Task 或 TaskBoard 事实、`task_events`、TaskEvent 文件投影 outbox、审计和 accepted receipt。任一写入失败会整体回滚。
2. External 路径以稳定 `operationIdentity` 派生 attempt 和子操作身份，在真实 Runtime、Provider、worktree、会话恢复或 Telegram 网络写之前提交 `write_started`。
3. 外部结果只允许 `failed_before_write`、`explicitly_rejected`、`outcome_unknown_after_write`、`accepted` 四态。普通异常在 marker 后保守归为 unknown；accepted 与 unknown 都禁止盲目重放。
4. run/continue 的模型、附件和命令行只在 marker 前做只读预检；Provider/PTY 返回后，Task 状态、TaskEvent、会话投影与 accepted receipt 才在同一个事务收口。稳定外部身份使用命令身份的 SHA-256，不把用户正文塞入 Inbox。
5. status 的 Telegram 通知是父命令事务内创建的稳定子 External Outbox。后台服务按 destination 恢复 `prepared` 项并先写 marker；成功只发一次，网络结果不明则保留 unknown，重启后不会自动补发。
6. `task_events` 是权威事件。`events.jsonl` 与 `timeline.normalized.log` 是可重建排障投影；图谱完成状态也是可重建投影，不参与 Task Core accepted 的权威判断。

External receipt 的 JSON 结果上限为 64 KiB，错误证据先脱敏再限制为 2 KiB UTF-8。超过预算时失败关闭并按写出位置归类，不允许无界 Runtime、Telegram 或异常正文进入 SQLite；本切片尚未为 Task Runtime 结果增加 ArtifactRef。

## 收益

- 重复点击、Renderer 重连和并发请求不再重复启动/停止 Runtime、清理 worktree 或发送 Telegram。
- Task、TaskEvent、投影 outbox与 accepted receipt 不再形成可见双写窗口；JSONL 丢失可从 SQLite 重建。
- Telegram 从不可对账的提交后 callback 变为有稳定子身份、可恢复扫描和 unknown 阻断的 outbox。
- 看板普通移动不承担外部协议成本；只有真实联动清理或恢复时才进入同步 WAL 与四态状态机。
- `index.ts` 的旧 inline handler 被独立 route/application/operations/effect 模块替换，公开边界可由动态审计逐条验证。

## 缺点与剩余边界

- 每条耐久命令增加 SQLite WAL、摘要与 receipt 成本；Runtime/清理类操作还需要两次以上耐久状态推进。
- unknown 优先避免重复副作用，但会要求人工或后续对账能力确认 Runtime、worktree、会话或 Telegram 的真实结果；当前没有公开的 Work Management reconcile 入口。
- management-status 和看板联动清理是复合外部操作。marker 能阻止盲重发，但若多个 worktree/会话子步骤中途失败，只能将整个 attempt 保守标为 unknown，尚无逐子资源进度账本。
- Telegram 多收件人仍是批次操作；部分收件人成功后连接中断会使整批 unknown，系统不会自动补发剩余收件人，以免已送达者收到重复消息。
- 64 KiB 结果预算会使异常大的 Runtime 成功结果转为需对账的保守失败；后续若结果规模增长，应改用 ArtifactRef，而不是提高 SQLite 上限。
- 图谱与 JSONL 是最终一致投影，提交后短时间内可能落后；持续磁盘故障会积累有界恢复 backlog，但不会反向覆盖 SQLite 权威事实。

## 验证证据与未验范围

- `pnpm exec tsx scripts/verify-work-management-command-behavior.ts`：临时 SQLite 与 fake sender 验证 Core 原子提交/回滚、不可变 replay、Telegram accepted 单发、marker 后 unknown 禁止重放、1.1 MiB 敏感错误脱敏有界，以及 TaskEvent 投影 backlog、增量、崩溃与文件安全边界。
- `node scripts/audit-command-side-effect-entries.mjs --require-work-management-task-command-slice`：动态发现上述 7 个精确路由，要求统一 Application、稳定命令、Renderer 不变 Envelope、Core/External marker、旧 handler 删除与行为 verifier 接入同时成立。
- `pnpm --filter @zeus/storage build` 与 `pnpm --filter @zeus/desktop build` 已验证本切片依赖闭包；Local Server 构建结果需与共享工作树中的并行模块错误分开报告。

本轮没有启动真实 Runtime、PTY、Codex/Pi Provider、Telegram、Git、正式数据库或 GUI，也没有生成或启动 `Zeus Test.app`。因此静态构建、临时 SQLite 和 fake port 证据不能替代真实进程信号、Provider 历史对账、Telegram 部分送达、断电窗口与独立应用验收。
