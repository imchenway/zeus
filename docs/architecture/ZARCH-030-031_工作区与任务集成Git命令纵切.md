# ZARCH-030～031 工作区与任务集成 Git 命令纵切

## 结论

本纵切接管 16 个 Project Workbench、Task Workspace、Task Integration 与 task-push Git 公开 mutation。16 个入口全部归类为 `external_operation`：即使 snapshot/patch 主要读取 Git，其公开调用仍会写 SQLite snapshot/audit；stop-sessions 会调用 Provider；其余入口会触及 Git、文件系统、进程或远端。

公开请求统一为 `{ command, input }`。Renderer 在一次用户动作开始时只生成一次不可变 Envelope；重连身份只能复用相同正文。Local Server 在任何 Git、文件、进程或 Provider 动作前先持久化 external write marker；结果只允许进入 `accepted`、`explicitly_rejected`、`failed_before_write`、`outcome_unknown_after_write` 四态。`outcome_unknown_after_write` 永不自动重发，必须由恢复或人工核对实际 Git/Provider 状态。

accepted 的大结果写入内容寻址 `ArtifactRef`，receipt 只保存 SHA-256、字节数和 generation，重放上限为 32 MiB。错误先脱敏，再按 UTF-8 截断到 2 KiB。可延迟的 SQLite 投影通过 `commitAccepted` 与 accepted receipt 放入同一耐久事务；集成候选的 `preparing/conflicted/pending_local_sync` 中间记录仍是外部流程恢复证据，不冒充 Git 本身的权威事实。

## 精确路由清单

| # | 公开入口 | 稳定命令 / scope | 主要收益 | 缺点与代价 | 本轮未验证边界 |
|---:|---|---|---|---|---|
| 1 | `POST /api/projects/:projectId/git/workbench/repositories/:repositoryId/actions` | `git.workbench.repository.action` / `git_repository` | Workbench 动作有统一外部身份，丢响应不会盲重做 | HTTP fallback 需写 Command WAL 与结果 Artifact；原生 Main bridge 仍是独立边界 | 未运行真实 branch/checkout/stash/fetch/push |
| 2 | `POST /api/tasks/:taskId/git-workspaces/commit-all` | `git.task_workspace.commit_all` / `task` | 多仓共享一个用户动作身份；成功项仍逐仓记录事件与审计 | 无跨仓原子性；任一已尝试 Git 的异常使整批进入 unknown，不再伪装为确定失败 | 未在真实多仓、嵌套仓与 merge HEAD 上运行 |
| 3 | `POST /api/tasks/:taskId/git-workspaces/push-all` | `git.task_workspace.push_all` / `task` | 非强制推送与远端 SHA 校验置于 durable marker 之后 | 网络丢响应时整批 recovery-required；不能自动重推 | 未访问真实远端或验证认证失败 |
| 4 | `POST /api/tasks/:taskId/git-workspaces/:workspaceId/commit` | `git.task_workspace.commit` / `task_workspace` | workspace 真身份与选中文件 hash 绑定；replay 不重复提交 | 结果 Artifact 与账本增加少量 I/O | 未创建真实提交，也未覆盖格式化工具现场 |
| 5 | `POST /api/tasks/:taskId/git-workspaces/:workspaceId/push` | `git.task_workspace.push` / `task_workspace` | 保留远端领先/分叉保护和 post-push SHA 校验 | unknown 必须人工查远端 HEAD | 未访问真实远端 |
| 6 | `POST /api/tasks/:taskId/git-workspaces/:workspaceId/stop-sessions` | `git.task_workspace.stop_sessions` / `task_workspace` | Provider interrupt 与本地 submission 取消共享一个外部命令身份 | 多会话中途失败时整条命令 unknown，本地取消不会被盲目补写 | 未调用真实 Codex/Pi Provider；Pi 兼容性仍需运行核对 |
| 7 | `POST /api/tasks/:taskId/git-workspaces/:workspaceId/reclaim` | `git.task_workspace.reclaim` / `task_workspace` | 回收、嵌套父 Worktree 补收与环境状态均位于 marker 之后 | 物理目录和 SQLite 无法形成单个原子事务，崩溃后只能对账 | 未删除真实 worktree/目录 |
| 8 | `POST /api/tasks/:taskId/git-workspaces/:workspaceId/discard` | `git.task_workspace.discard` / `task_workspace` | 继续要求独立危险确认文本；不把 Command Envelope 当二次确认 | 放弃本地分支不可逆；确认拒绝需额外 receipt | 未执行真实丢弃；远端分支保留仅由现有 Git core 保证 |
| 9 | `POST /api/tasks/:taskId/git-workspaces/:workspaceId/integrate` | `git.task_workspace.integrate` / `task_workspace` | 来源分支、task HEAD、target HEAD 和 operation identity 一起持久化；冲突候选可恢复 | 集成 worktree 与 SQLite 中间态无法原子提交；需保留 recovery-required 对账 | 未运行真实 merge/squash、冲突或 pending-local-sync |
| 10 | `POST /api/tasks/:taskId/integrations/:integrationId/conflict/ai-session` | `git.task_integration.conflict_ai_session` / `task_integration` | 外层命令与既有 Provider 接纳共用同一个 `operationIdentity`，避免双账本身份漂移 | 同时存在 Workspace Git 外部账本和 Provider 子账本，排障链更长 | 未调用真实 Provider；未验证大冲突草稿的模型限制 |
| 11 | `PUT /api/tasks/:taskId/integrations/:integrationId/conflict` | `git.task_integration.conflict_resolve` / `task_integration` | 写文件前持久化 marker，并重新核对 task/target HEAD | 文件写与 SQLite conflictFiles 不能物理原子 | 未写真实冲突文件 |
| 12 | `POST /api/tasks/:taskId/integrations/:integrationId/finalize` | `git.task_integration.finalize` / `task_integration` | 保留来源分支脏检查、HEAD CAS、非强制最终化与回收语义 | finalize 后丢响应会 unknown，不能自动再次合入 | 未运行真实 finalize/回收 |
| 13 | `POST /api/tasks/:taskId/integrations/:integrationId/push` | `git.task_integration.push` / `task_integration` | 只允许已合入记录的来源分支，继续禁止隐式 force | 远端不确定结果需人工核对 | 未访问真实远端 |
| 14 | `POST /api/projects/:projectId/git/snapshot` | `git.project.snapshot.create` / `git_repository(project)` | Git 读取结果与 SQLite snapshot/audit 的公开 mutation 有可重放结果 | diff 较大时增加 Artifact 写入；超过 32 MiB 会失败关闭 | 未对真实大型仓库测量性能 |
| 15 | `POST /api/projects/:projectId/git/patch` | `git.project.patch.export` / `git_repository(project)` | patch 导出结果可精确重放，receipt 不内联正文 | 32 MiB 硬上限；极大 patch 需后续流式 artifact 方案 | 未导出真实 patch |
| 16 | `POST /api/projects/:projectId/codex-task-push-capabilities/repositories/:repositoryId/refresh-remote` | `git.task_push.repository.refresh_remote` / `git_repository` | 显式 refresh 才允许访问远端；GET 继续只读本地已知事实 | fetch 丢响应会 unknown；额外 WAL/Artifact I/O | 未访问真实远端 |

## 代码边界

- `workspaceGitCommandApplication.ts`：严格 Envelope/hash、Command Inbox/Outbox、external marker、四态、ArtifactRef 与有界脱敏错误。
- `workspaceGitCommandRoutes.ts`：16 个公开注册点、真实 scope、统一 prepare/execute 委托；旧 `index.ts` inline mutation 已删除。
- `workspaceGitCommandClient.ts`：Renderer 一次构造 Envelope；最多缓存 256 个重连身份，相同身份换正文时失败关闭。
- `index.ts`：只保留产品端口组合和真实业务操作，不再注册这 16 个路由。

## 验证证据

`pnpm verify:workspace-git-command` 只使用临时 SQLite、临时 ArtifactStore 和 fake 外部端口，证明：

- 16 条路由政策精确为 `external_operation`；
- 1.25 MiB accepted 结果只执行一次，并通过 ArtifactRef 完整重放；
- Core 投影与 accepted receipt 同事务只写一次；
- marker 后异常落 `outcome_unknown_after_write`，同 Command replay 被阻断；
- 错误脱敏且 UTF-8 不超过 2 KiB；
- 独立危险确认拒绝落 `explicitly_rejected`；
- 临时 SQLite `quick_check=ok`；
- 没有启动真实 Git、文件写、进程或 Provider。

`node scripts/audit-command-side-effect-entries.mjs --require-workspace-git-command-slice` 另外以 exact marker 验证 16 个注册点全部为 integrated，并确认旧 inline handler 已删除。该证据不是生产 Git、真实远端、Provider 或 GUI 验收。

## 长期收益与代价

收益是“丢响应后是否可以重试”不再由 HTTP 客户端猜测；重放不需要重新运行 Git/Provider；任务工作区与集成使用真实资源 scope，审计与恢复可定位到精确对象；大结果不会膨胀 Command receipt。

代价是每次 mutation 多出 SQLite marker/receipt 和 Artifact I/O；unknown 会主动牺牲自动恢复速度换取不重复 commit/push/discard/finalize；32 MiB 结果上限会拒绝极大 patch；Git/文件系统/Provider 与 SQLite 天生不能共享事务，因此中间态仍需恢复对账，不能把 `quick_check` 或 fake port 探针夸大成真实运行完成。
