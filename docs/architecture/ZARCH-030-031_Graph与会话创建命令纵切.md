# ZARCH-030～031 Graph 与会话创建命令纵切

## 结论

本纵切精确接管 6 个公开副作用入口：Project/Task 首次创建会话、Project Graph scan、Graph views generate、Project Graph ask 和当前项目 Graph scan。六条入口都通过公开、不可变的 `{ command, input }` 进入 `external_operation`，不再依赖无身份的 HTTP Body 或临时 `Idempotency-Key`。

Renderer 在一次用户意图开始时只构造一个 Envelope；相同重连身份只能复用完全相同的正文。Local Server 重算 canonical input SHA-256，在外部写出前落耐久 marker，并只允许 `failed_before_write`、`explicitly_rejected`、`outcome_unknown_after_write` 和 `accepted` 四态。写出后结果不明时禁止自动重发；accepted 重放只读取经 owner、字节数和 SHA-256 校验的 `ArtifactRef`，不会再次创建会话、调用 Provider 或启动扫描。

本轮没有接管相邻的 project database/config/secret、settings/import、Telegram/security、Work Management、Git、Runtime 或 Integration 路由。

## 精确入口清单

| # | 公开入口 | 稳定命令 / scope | 外部子身份 | 主要收益 | 缺点与代价 |
|---:|---|---|---|---|---|
| 1 | `POST /api/projects/:projectId/conversations` | `conversation.project.create` / `project` | 父 operation identity 作为既有 conversation acceptance 的稳定幂等身份 | 网络重连或重复点击不会二次创建首次 submission 或二次派发 Provider | 每次创建增加 Command WAL、write marker、Artifact 和 receipt I/O |
| 2 | `POST /api/tasks/:taskId/conversations` | `conversation.task.create` / `task` | 稳定 conversation/submission/provider 子链 | Task 首次对话与既有接纳状态机共用同一外层命令身份 | 外层 external receipt 与内部会话派发证据形成更长的诊断链 |
| 3 | `POST /api/projects/:projectId/scan` | `graph.project.scan` / `project` | `commandType + projectId + operationIdentity` 派生 Worker operation | 同进程重复命令折叠为一个扫描；accepted replay 不重新扫盘 | 扫描与 SQLite 无法物理原子；unknown 必须人工或恢复流程对账 |
| 4 | `POST /api/projects/:projectId/graph/views/generate` | `graph.project.views.generate` / `project` | 与 scan 相同的稳定 Worker operation 规则，但命令类型独立 | views generate 不再与普通 scan 共用模糊幂等语义 | 同一项目仍由显式 single-flight 串行，忙时返回冲突而不排无界队列 |
| 5 | `POST /api/projects/:projectId/ask` | `graph.project.ask` / `project` | 稳定 conversation、submission、Runtime session、Provider idempotency 与 client message ID | Provider/Runtime 写出后丢响应不会用新随机身份盲问第二次 | Provider 无原生可查证据时，unknown 会保守阻断；恢复速度让位于不重复执行 |
| 6 | `POST /api/graph/scan-current` | `graph.current.scan` / `project(current-project-root)` | 稳定 current-project Worker operation | 当前项目扫描也具备同一 Envelope、四态和重放边界 | synthetic scope 代表本机当前代码根；跨安装同步时不能冒充云端共享项目身份 |

## 事务、Artifact 与数据边界

1. `beforeWrite` 只做项目/任务存在性、终态、请求 agent、扫描根安全性和 single-flight reservation 等预备。预备失败发生在 marker 前，记为 `failed_before_write`，不会冒充外部写出。
2. 首次创建会话、Graph ask 和扫描都在真实 Provider、Runtime、Worker 或持久业务写入前调用 `markExternalWriteStarted`。普通写出后异常只能进入 `outcome_unknown_after_write`；只有带显式拒绝语义的错误才可安全建立新 attempt。
3. Project scan 的 `completed`/`failed` Core 状态分别在收口回调中处理；`completed` 与 accepted receipt 共享一个耐久事务。扫描产出的图谱继续是可重建投影，不被 receipt 冒充为权威业务正文。
4. accepted 完整结果最多 32 MiB，写入内容寻址 Artifact；receipt 只保存 `ArtifactRef` 和有界元数据。外部 Worker 的内部 `heavyWorkerResultRef` 不投影进公开 HTTP 结果，避免把内部路径或大引用写进命令证据。
5. 错误先经过产品级脱敏，再按 UTF-8 截断到 2 KiB。receipt 不保存请求正文、用户问题、密钥、文件内容或 Provider 大响应。
6. 同一进程内相同 command/scope 的并发请求共享一个活动 Promise；Renderer 的稳定重连缓存硬上限为 256 项，同一重连身份若正文改变则失败关闭。

## 代码边界

- `graphConversationCommandApplication.ts`：严格 Envelope/hash、Command Inbox/Outbox、external marker、四态、并发折叠、ArtifactRef 重放和有界脱敏。
- `graphConversationCommandRoutes.ts`：仅注册上述 6 个入口，验证真实 scope，并把业务操作委托到组合根端口。
- `graphConversationCommandClient.ts`：Renderer 一次用户意图只构造一个 Envelope，并为 transport 重连保留稳定正文。
- `index.ts`：保留项目、任务、会话、Provider/Runtime、Graph Worker 与扫描状态的真实组合，不再内联注册这 6 个路由。

## 行为与结构验证

`pnpm exec tsx scripts/verify-graph-conversation-command-behavior.ts` 只使用临时 SQLite、临时 ArtifactStore 和 fake 外部端口，已验证：

- 六条路由均接收公开 Envelope；会话入口返回 202，Graph scan/ask 返回 200；
- 同一命令并发与 accepted replay 都只调用一次外部操作；
- 1.25 MiB 结果通过 ArtifactRef 完整重放，receipt 不内联大正文；
- marker 后异常落 `outcome_unknown_after_write`，同一命令重放返回 recovery-required；
- marker 前项目不存在落 `failed_before_write`，不会产生 write marker；
- Project scan accepted Core 回调与 receipt 各执行一次；
- 错误经脱敏后不超过 2 KiB，临时 SQLite `quick_check=ok`。

`node scripts/audit-command-side-effect-entries.mjs --require-graph-conversation-create-command-slice` 动态发现恰好 6 个注册点，要求全部归为 integrated `external_operation`，并检查 Renderer 单 Envelope、旧 inline handler 删除、稳定子身份、ArtifactRef 和 unknown 禁盲重试。两类 verifier 都没有启动真实 Provider、Runtime、扫描 Worker、正式数据库或 `Zeus Test.app`，因此不能作为真实大仓扫描、模型问答、崩溃恢复、性能或 GUI 验收。

## 长期收益与缺点

收益：HTTP 重连、重复点击和同进程并发不再重复创建会话、向 Provider 提问或扫描磁盘；每个子系统可由一个父 operation identity 追踪；accepted 大结果精确重放但不膨胀 SQLite；扫描完成状态与 accepted 证据不再留下新的 Core 双写窗口；内部 Worker 引用与敏感错误不会泄漏进公开回执。

缺点：每个入口增加同步 SQLite WAL、Artifact I/O 和 SHA-256 计算，短请求会有少量固定延迟与写放大；32 MiB 上限会拒绝极大结果；unknown 主动牺牲自动恢复速度，必须通过原生证据或人工对账；外层命令与内部 conversation/provider 账本让诊断关系更完整，也更复杂；Renderer 需要异步构造 hash 并维护有界重连缓存；Graph Worker、Provider/Runtime 与 SQLite 天生不能共享物理事务，仍需保守恢复而不能承诺 exactly-once 外部执行。
