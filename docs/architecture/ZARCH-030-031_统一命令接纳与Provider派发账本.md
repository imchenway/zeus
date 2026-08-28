# ZARCH-030～031 统一命令接纳与 Provider 派发账本

## 结论

本轮已完成 Codex 全部已发现 Provider 变更调用、Pi Runtime 恢复、Pi 的五个 Provider 写点、Memory 三个 Core Application 写入口、Command Center 九个公开写路由、Codex 账号/远程控制/配置/旧版导入的九个公开变更路由、Work Management 的七个 Project、八个 Task 与九个看板/重试/模板/图谱 Core 公开写路由、12 个 Local Server Git 公开 mutation，以及 16 个 Project Workbench/Task Workspace/Task Integration/task-push Git mutation 纵切。Work Management 第二批又接管 status、management-status、task-board moves 与 run/pause/continue/cancel 共 7 个精确入口：纯事实与 accepted receipt 同事务，Runtime、清理、会话恢复与 Telegram 使用稳定外部身份和四态。新增 16 条 Git 全部按真实 Git、文件、进程、Provider 或 SQLite snapshot/audit 副作用归为 `external_operation`；accepted 大结果只存 ArtifactRef，unknown 不自动重发，独立危险确认继续保留。Conversation 配置/生命周期另有 11 个稳定命令；消息、side-chat、change-set、Queue、interrupt 与两类交互回复再由 15 个注册点覆盖 16 个稳定命令。会话提交在 Codex `turn/start` 前建立统一命令身份，`conversation_submissions.dispatching` 与待派发 Outbox 在同一 SQLite 耐久事务提交；调用 Provider 前先持久化“可能写出”，然后把业务接纳事实与 `accepted` 回执放进同一个事务。Codex 的 thread start/archive/unarchive、Goal、turn steer/interrupt、server-request response 和便携上下文压缩均通过独立 Application Service 形成 session 或 turn 回执；Pi Runtime 显式恢复由公开 HTTP 直接接收客户端 Command Envelope；Pi `openSession`、两处 `startRun`、`steerRun`、`interruptRun` 则从既有不可变会话、submission 或 turn 身份稳定派生命令并进入同一账本。Memory 的 candidate、supersede、tombstone 公开请求直接采用 `{ command, input }`，通过 `core_application` 在同一事务形成业务事实与 accepted receipt。Command Center 的全局/项目定义增删改与确认创建走 `core_application`，运行启动/停止走带稳定外部操作身份的 `external_operation`。Codex 公开控制命令也使用 `external_operation`，并以 `ArtifactRef` 保留可精确重放的大结果。Work Management 以真实 `project/task` scope 直接消费 `{ command, input }`，把 Project/Task/模板/图谱任务业务事实、事件投影 outbox、审计与 accepted receipt 原子提交。Work Management 第二批的逐路由收益、代价与未验边界见 `ZARCH-030-031_WorkManagement任务状态与运行命令纵切.md`；16 条 Git 清单见 `ZARCH-030-031_工作区与任务集成Git命令纵切.md`。

Runtime Session/Confirmation 纵切进一步接管 15 条公开 mutation：session start/interrupt/stop 使用带耐久 write marker 的 `external_operation`；summary/favorite/archive/restore/delete 使用 `core_application`；confirmation create/confirm/reject 与 input/resize 使用进程内、TTL 和容量有界的 `ephemeral_capability`，不会为每次短期确认、按键或尺寸变化同步写 Command WAL。confirmation 的审计行只是附随证据，不能替代进程内能力本身；能力重启或过期后必须重新取得。Telegram、安全与 polling 的 11 条 mutation 也已完成独立纵切，其中 10 条为 `external_operation`、通知开关为原子 `core_application`；逐路由分类、敏感数据边界和未验范围见 `ZARCH-030-031_Telegram安全与轮询命令纵切.md`。

设置、导入与缓存纵切精确接管 10 条公开 mutation：项目配置、App Shell、Code Map 共 3 条 `core_application`；项目数据库 Keychain、Runtime retention、两个缓存 alias、settings import 与 business data import 共 7 条 `external_operation`。设置与业务导入都在任何 mutation 前完成全量计划，大正文进入 ArtifactRef，两个缓存 URL 共享同一命令语义。逐路由收益、缺点和未验边界见 `ZARCH-030-031_设置导入与缓存命令纵切.md`。

Local Server Git 纵切把 confirmation create/confirm/reject 明确保留为进程内短期安全能力；其余 generic operation、七个 Project 操作和 Task rollback 共九条才进入 `external_operation`。确认能力重启即失效，不从 receipt 重建；九条 Git 写出以确认 ID 作为唯一外部操作身份，结果正文进入内容寻址 Artifact，receipt 只保存引用证据。

截至 2026-08-21，ZARCH-030/031 的机读公开入口分母已完整收口：203 项中 183 项为 `integrated`，其余 20 项均是已有证据的只读、短期能力、交接控制或诊断能力，`pending=0`。Electron Main 的独立分母也已收口：108 个 IPC、9 个原生 action、26 个只读入口与 91 个副作用边界均可分类，结果为 `26 integrated / 65 platform_capability_excluded / 0 pending`。后台事件、Worker 和 Core 内部调用不被错算进公开命令分母，它们另由 128 个内部副作用调用点、10 个状态机、8 项 CAS/并发策略和 38 类事件注册表失败关闭。TaskEvent JSONL 已降为 SQLite 权威事实后的可重建异步投影。这些结论证明边界和完整性，不能代替真实 Provider 崩溃窗口、正式大库副本或打包 GUI 验收。

## 领域边界

| 概念 | 权威含义 | 不能推导出的结论 |
| --- | --- | --- |
| Command Inbox | Core 已持久接纳命令身份、actor、scope、revision、幂等键和不可变请求摘要 | Provider 已收到、执行已完成 |
| Outbox attempt | 向一个明确 Provider 目的地派发该命令的一次有序尝试 | 同一命令可以任意重放 |
| Provider write marker | Core 在调用真实 Provider 写入口前已保守记录“请求可能写出” | Provider 已接纳 |
| Provider receipt | 对一次 attempt 追加的不可变证据 | HTTP 成功可以替代原生接纳证据 |

`command_delivery_receipts` 只接受四种结果：

| 结果 | 允许的前态 | 后续动作 |
| --- | --- | --- |
| `failed_before_write` | `prepared` | 可建立新 attempt；请求尚未交给 Provider |
| `explicitly_rejected` | `prepared` 或 `provider_write_started` | 可建立新 attempt；必须有明确拒绝语义 |
| `outcome_unknown_after_write` | `provider_write_started` | 禁止自动重放；只能查询 Provider 原生证据 |
| `accepted` | `provider_write_started`，或由 unknown 经原生证据对账 | 禁止重放；`provider_session` 必须是 session-only，`provider_turn` 必须同时携带真实 session 与 turn/run，Runtime 与 Core/外部操作使用各自证据字段 |

unknown 不是“失败”。启动时发现 `provider_write_started` 但没有回执，会追加 unknown 回执、进入显式恢复清单并关闭自动重放；以后若 Provider 历史按 `clientUserMessageId` 找到原生 turn，只追加第二条 `accepted` 回执，不修改或删除原 unknown 证据。SQL trigger 也会拒绝在 unknown/accepted 后插入新 attempt，避免绕过 Repository。

## 存储与事务边界

`packages/storage/src/commandDeliveryStore.ts` 新增：

- `command_inbox`：统一信封、请求 SHA-256、scope 幂等唯一键和当前交付结论。
- `command_outbox`：按 command 单调递增的 attempt、目的地、资源身份、写出水位和是否允许安全重试。
- `command_delivery_receipts`：按 attempt/sequence 追加的不可变四态证据、Provider/原生身份和证据 SHA-256。

目的地分为 `provider_session`、`provider_turn`、`provider_runtime`、`core_application` 和 `external_operation`。拆分 session 与 runtime 的收益是恢复时不会把 SDK session 冒充 Worker generation，也不会把 session 创建和首轮 run 合成无法精确判断的粗粒度 attempt；缺点是每次新会话多一组 Inbox/Outbox/receipt，恢复和诊断必须处理更多状态组合。

关键事务边界：

1. `acceptAndPrepare` 在一个 `BEGIN IMMEDIATE` 中写 Inbox、Outbox，并通过同步回调把 submission 切到 `dispatching`；任一步失败全部回滚。
2. `markProviderWriteStarted` 在调用 Codex `turn/start` 前完成耐久提交。它是保守安全水位，不依赖稍后才可能触发的 socket callback。
3. `ConversationExecutionRepository.acceptSwitchDurably` / `acceptOnCurrentSegmentDurably` 在原有业务接纳事务末尾追加 accepted receipt；回执失败会使整个接纳事务回滚。
4. `rejectBeforeAcceptance` 与 `fail` 把统一会话状态和相应 receipt 放入同一耐久事务。
5. 启动对账找到原生 turn 时，在提升 unknown 业务状态的同一个事务中追加 accepted reconciliation receipt。
6. `executeCoreApplication` 在一个 `BEGIN IMMEDIATE` 内接收 Inbox、创建 `core_application` Outbox、执行同步领域 mutation 并追加 accepted receipt；mutation、回执或提交任一步失败均整体回滚，已接纳重放只读取原 operation result，不再次调用 mutation。
7. `external_operation` 先原子建立 Inbox/Outbox 与 `starting`/`stopping` 业务中间态，再在首次文件、Realtime 或 Runtime 写出前持久化 write marker；外部操作返回后，运行业务状态、审计事实与 receipt 在同一事务收口。
8. 外部 operation identity 只能归属一个 command ID；同一 command 在 `failed_before_write` 或 `explicitly_rejected` 后仍可建立安全 attempt 2。v4 以跨 Command trigger 代替过强的全局唯一索引，unknown/accepted 仍由既有 trigger 禁止重放。

方案收益：已显式接入同步事务回调的 Core、session 与 turn 接纳事实会和对应回执共用提交，不再形成“accepted 已提交但该接纳投影缺失”的新窗口；Provider 返回到 Core 提交之间若崩溃，会由写出水位保守收敛为可对账的 unknown，重复点击和队列重入不会越过它。这不等于 Provider、SQLite、提交后广播和进程内缓存之间实现了跨系统 exactly-once。

方案缺点：每次关键状态都会增加同步 WAL 提交，单次派发延迟和写放大会略增；四态和追加回执让恢复代码更复杂；Provider 缺少可查询原生身份时，unknown 只能长期保守暂停，不能以可用性为由盲重放。

## 正式纵切

`packages/local-server/src/codexNativeConversationCoordinator.ts` 的正式路径为：

1. 已冻结执行快照的不可变 submission 到达队首。
2. 由 submission 稳定生成 `conversation.submission.dispatch` Command Envelope；payload 只保存身份和摘要，不复制用户正文。
3. 原子写 Command Inbox、Outbox attempt 和 `submission.status=dispatching`。
4. 完成本地/Provider 预备；在调用 `manager.startTurn` 前耐久标记 `provider_write_started`。
5. Provider 返回原生 turn 后，统一会话接纳和 accepted receipt 同事务提交，再广播已持久状态。
6. 明确拒绝允许安全的新 attempt；其他写出后异常进入 unknown，队列与 Repository 均不自动重放。

保留现有会话级 dispatch lease，因此同进程并发请求不会同时进入 Provider。持久 Outbox 负责跨崩溃边界，内存 lease 负责同进程互斥，两者不可互相替代。

### Codex Provider Session、Turn 与 Server Request 纵切

`CodexProviderCommandApplicationService` 把已发现的 Codex 变更入口统一到两个真实目的地：

1. `thread_start`、`thread_archive`、`thread_unarchive`、`goal_set`、`goal_clear` 使用 `provider_session`；accepted 只保存真实 thread ID，不能伪造 turn ID。新建 thread 的 generation 在 Provider 返回 thread 后按真实 owner 再解析，避免把请求前的候选 generation 当作接管事实。
2. `turn_steer`、`turn_interrupt`、`server_request_response` 和便携上下文压缩的 `turn_start` 使用 `provider_turn`；accepted 同时保存真实 thread 与 turn。正式 submission 的 `turn/start` 继续由 Segment Lifecycle 把业务接纳和回执放进同一事务。
3. 每个入口都先 `acceptAndPrepare`，再耐久标记写出，最后形成四态回执。普通异常在写出后只能进入 unknown；目前只有带 `runtime_rejected` 明确处置的 thread start，以及可证明 turn 已结束的 steer，允许归为明确拒绝。其他错误不因错误码看似可重试就降级为显式拒绝。
4. 同一个原生 turn 的所有 interrupt 来源共享稳定命令身份；用户中断、无效交互、敏感回答不可重放和关闭流程不会各自建立可绕过 unknown 的新命令。archive/unarchive 使用会话 stage epoch 区分不同归档周期，同时让同一周期的 unknown 重试保持被阻断。
5. 动态工具先完成本地只读或浏览器调用，再对同一个 Provider request 只写一次响应；缺少 native thread/turn 身份时失败关闭，不以无法审计的请求向 Provider 回写。已回答请求的 Provider 重投以新的入站 event identity 建立独立 replay 命令，敏感答案仍不持久化。
6. Goal、归档、请求解析等本地投影是 Provider 事实的派生视图；accepted receipt 先耐久成立，投影随后更新。若进程在两者之间中断，只允许由 Provider 事件或精确读取恢复投影，不能重发已经 accepted/unknown 的 Provider 命令。
7. 便携上下文压缩的新 thread accepted 后重新读取真实 owner generation，后续 `turn_start` 与 archive 都沿用该 generation，不把请求前候选世代写进审计链。`final_quit` 与升级 `handoff` 分离：handoff 不改变 `pending + waiting`；最终退出则在单个同步耐久事务内把 pending request、waiting/running turn、关联 submission 和 conversation 收敛为 `failed + recovery_required + paused`，并保留 `providerOutcomeUnconfirmed=true`，不能把未观察到的 Provider 终态伪装成正常中断。

收益：Codex session 与 turn 不再混用 Runtime generation 身份；任一入口写出后崩溃都能阻止盲重发；多个关闭/恢复来源无法绕过同一原生 turn 的中断账本；最终退出不再留下 `request=failed/turn=waiting` 的分叉；Goal、动态工具与关闭终态从超大 Coordinator 中拆成可独立审计的应用边界。

缺点：每个 Provider 变更增加同步持久水位和回执写放大；accepted 后本地派生投影失败时需要事件或只读对账恢复；Provider 没有可查询证据的 unknown 会保守阻断交互；最终退出需要额外同步事务，且无法确认 Provider 终态时会保守留下 recovery_required；归档周期、request replay 和 generation owner 引入了更多稳定身份设计与诊断状态。

### Codex 账号、远程控制、配置与旧版导入纵切

`CodexPublicCommandApplicationService` 和 `codexPublicCommandRoutes.ts` 接管九个真实公开变更：登录开始/取消、远程控制启用/停用、配对开始、客户端撤销、配置导入/激活和旧版导入开始：

1. Renderer 为每次用户操作生成一次 `{ command, input }`，Local transport 的两次尝试重用同一份序列化信封。协议使用 `provider_account`、`provider_remote_control`、`provider_configuration`和 `provider_import` 真实 scope；payload 只保存稳定 operation identity 与 canonical input SHA-256，不复制完整请求。
2. 九个变更都使用 `external_operation`：先建立 Inbox/Outbox，在首个真实 Runtime、文件或远程写入前耐久标记 write marker，再按 `failed_before_write`、`explicitly_rejected`、`outcome_unknown_after_write`和 `accepted` 收口。只有 manager 明确提供 `runtime_rejected` 处置证据时才允许安全新 attempt，普通异常不会被伪装成明确拒绝。
3. accepted 的完整结果写入内容寻址 Artifact，receipt 只保留有界证据和 `ArtifactRef`。已接纳重放按 owner、字节数和 SHA-256 重新校验 Artifact 后返回原始结果，不再调用外部操作；同进程并发重复命令共享一个活动 Promise。
4. 远程控制 enabled 设置与审计投影和 accepted receipt 在同一数据库事务提交；内存标志只在事务成功后采纳。配对状态端点仅读取 manager 的 `remoteControl/pairing/status`，没有设置、审计、账本或 Provider 变更，因此通过实现级证据归为 `read_only`。
5. 配置导入只写文件，配置激活使用独立显式命令；不再把“导入成功、激活结果未知”误报为一个 accepted composite。旧版检测 GET 只在内存中渲染快照和摘要；目录创建、快照写入、Provider 检测与真实导入全部移入已标记写出的 POST 命令。

收益：重复点击、Renderer 传输重试和 Core 重启不会重复登录、配对、撤销、文件导入或 Runtime 激活；大结果不膨胀 receipt/SQLite，同时仍能精确重放；旧版 GET 不再暗中写文件或启动 Provider。

缺点：每个外部操作增加同步 WAL 与 Artifact I/O；结果 Artifact 引入 owner、保留、GC 和敏感结果寿命治理；配置导入后需要额外的显式激活步骤；unknown 不能用自动重试换取表面可用性，必须由后续对账或操作员处理；四种新 scope 也增加了协议与权限治理成本。

### Pi Runtime 恢复纵切

`ProviderRuntimeRecoveryApplicationService` 固定执行顺序：

1. HTTP 直接解析 `provider.runtime.pi.recover` 信封，要求 `runtime_segment/provider:pi` scope、`expectedRevision=null`、预期 generation 和“不重放未知命令”确认。
2. 同一命令的并发重连共享一个 Promise；其他恢复命令在活动操作期间以 busy 失败关闭，不进入无界队列。
3. 在创建 Outbox 前核对当前 generation；stale 命令不写 Inbox。随后建立 `provider_runtime` attempt 并在调用 `recoverRuntime` 前耐久标记写出。
4. 新且健康的 generation 以 `nativeSessionId` 记录 accepted；它不是 turn，`nativeTurnId` 必须为空。`ZEUS_PI_WORKER_RECOVERY_BUSY/CLOSED` 是可证明的明确拒绝，其余写出后异常一律记 unknown。
5. accepted 重连只返回既有回执，unknown 重连只返回恢复门禁，两者都不会再次调用 Worker；明确拒绝才允许同一命令建立下一 attempt。

### Pi Provider Session 与 Run 纵切

`PiProviderCommandApplicationService` 为五个真实写点分别建立命令，不共享语义过粗的 composite attempt：

1. `openSession` 使用 `provider.pi.session.open` 与 `provider_session`；accepted 只保存真实 `nativeSessionId`，强制 `nativeTurnId=null`。
2. 两处 `startRun` 使用 `provider.pi.run.start`，`steerRun` 使用 `provider.pi.run.steer`，`interruptRun` 使用 `provider.pi.run.interrupt`；四者均使用 `provider_turn`，accepted 同时保存 session 与 native run/turn。
3. 每次调用前先 `acceptAndPrepare` 并落 `provider_write_started`；`openSession` 返回后把产品会话或 provisional Segment 的原生身份投影与 session receipt 放进同一耐久事务，Pi 预检接纳再通过同步回调把统一会话接纳与 run receipt 放进另一耐久事务。
4. 只有 `ZEUS_PI_PREFLIGHT_REJECTED`、`ZEUS_PI_RUN_NOT_ACTIVE`、`ZEUS_PI_SESSION_NOT_LOADED` 被视为可证明的明确拒绝；其他写出后异常一律 unknown。unknown 后 Repository 与 SQL trigger 都禁止新 attempt。
5. steer 与 interrupt 的 accepted receipt 和本地 submission/turn 变更同事务提交；session receipt 与本地原生 session/Segment 身份同事务提交，并独立于后续 run。session 原子提交失败时 attempt 不会提前标为 settled，而是保守收敛 unknown 并阻止再次 `openSession`。

收益：`session accepted` 不再能脱离本地原生 session/Segment 身份单独落盘，注入事务回滚后两者都不残留且同一命令被 unknown 门禁阻断；启动恢复也不会把 session-only receipt 错当成 accepted turn 或盲目再建 session。

缺点：session 原子提交后、首轮 run 尚未建立时发生进程退出，当前只保留可对账的 provisional session 身份，不自动续跑；这优先保证不重复创建 Provider session，但牺牲了该罕见窗口的自动恢复可用性。跨 Provider 与 SQLite 的 exactly-once 仍不存在。

### Memory Core Application 纵切

`MemoryContextApplicationService` 的三个真实写入口分别使用 `memory.candidate.record`、`memory.record.supersede`、`memory.record.tombstone`：

1. Command Envelope 使用新增的 `memory` scope；candidate scope 对同一个 global/project memory head 稳定，supersede/tombstone scope 对被寻址记录稳定。
2. 公开 Body 把 `command` 与 `input` 分开；payload 只允许 `operationIdentity` 与 `inputSha256`，不会复制候选正文、来源或删除原因。服务端以确定性 canonical JSON 重算摘要，不匹配即拒绝。
3. candidate/supersede 的 operation identity 同时是新不可变 Memory record ID；tombstone 使用独立 operation identity 并保留目标 record ID。响应返回 `commandId`、`operationIdentity`、`replayed` 与同一业务记录。
4. 三者都通过 `executeCoreApplication` 把 Inbox、Outbox、Memory mutation 和 accepted receipt 放进同一耐久事务。候选治理拒绝会主动抛错，不能把未写入业务事实的请求误记为 accepted。
5. 相同信封与请求重放返回已有 operation result 且不再 mutation；同 scope 幂等键绑定不同信封或正文摘要时失败关闭。

Context preview 仍为 POST，是因为输入包含完整编译参数而不适合查询字符串；它只读项目、任务主文档、Cold Evidence 和 Memory。审计只有在 `memoryContextPreviewSideEffectDeclaration` 明确 `read_only/writesBusinessState=false/commandLedger=not_applicable`、路由确实调用该方法，且方法体没有 Repository 写入或 Command 调用时才把它标成 `read_only`。

收益是客户端重连不会重复创建、修正或墓碑同一条长期记忆，领域事实和接纳证据不存在崩溃双写窗口；缺点是每次治理写操作增加一次同步 WAL 提交，公开调用方必须生成稳定命令身份并计算 canonical SHA-256，协议复杂度与单次写延迟都高于裸 JSON 写入。

### Work Management Project/Task Core 纵切

`WorkManagementCommandApplication` 与 Renderer 的 `workManagementCommandClient` 已接管七个 Project 写路由（create/update/workspace-config/delete/archive/restore/default-template）和八个 Task 写路由（create/status/update/tags/relationships/delete/archive/restore）。本轮又通过独立 `workManagementCoreCommandRoutes` 与 `WorkManagementCoreOperations` 接管九个纯 Core 入口：看板设置、Task retry、模板创建、模板实例化、对话建任务、两个图谱节点建任务入口、图谱视图建任务和任务关联图谱节点：

1. 公开 Body 只接受精确 `{ command, input }`，不保留 legacy body fallback。Envelope 使用真实 `project` 或 `task` scope，payload 只包含稳定 `operationIdentity` 和 canonical `inputSha256`；Renderer 在输送重试前只构造一次不可变请求。
2. Project create 直接以 operation identity 生成稳定 Project ID；Task create 将既有 idempotency key 确定性哈希为稳定 Task ID，无需再维护第二套 HTTP header 幂等账本。
3. 每条路由均通过 `executeCoreApplication`/`durableTransactionSync` 将 Inbox、Core Outbox、Project/Task 业务写、Task event/审计事实与 accepted receipt 置于同一 SQLite 事务。注入的领域拒绝会把业务行和 Inbox/Outbox 一并回滚。
4. 路由在核对当前资源之前先尝试已接纳重放，因此 delete/archive 等已改变当前查询结果的命令仍能返回 receipt 中原始不可变结果，不再执行 mutation。
5. `POST /api/projects/:projectId/archive-confirmation` 只读取归档影响预览，以显式声明和实现级无写证据归为 `read_only`。`PATCH /api/tasks/:taskId/status` 把 Task、TaskEvent、文件投影 outbox、accepted receipt 和待发 Telegram 子命令同事务提交；Telegram 子命令有独立稳定身份、write marker、恢复扫描和 unknown 阻断，图谱仅是可重建投影，因此该路由已提升为 `integrated`。
6. 九个新增入口不在 `index.ts` 复制命令协议：抽离路由统一解析 `WorkManagementMutationRequest`、校验 route scope/operation identity、优先读取 accepted replay，再进入同一个 `executeCore`。Renderer 在第一次传输前构造一次不可变 `{command,input}`；Local transport 刷新连接时复用原 Body。
7. 模板正文、变量、对话问答、图谱节点/边和关联原因均按 UTF-8 字节及条目数限制；图谱任务只保存受控来源投影。receipt 的内联 replay 结果继续限制为 64 KiB，错误先脱敏再限制为 2 KiB，超限结果必须改用 `ArtifactRef`，不能把大图谱或 Provider 输出塞进 SQLite。
8. `task_events` 已固定为任务时间线权威事实。事务内同时写 `task_events` 与 `task_event_file_projection_outbox`，提交后异步消费者按 event cursor 幂等追加 `events.jsonl` 和 `timeline.normalized.log`；只有 `write_started` 或两文件 cursor 不一致才分批重建，不在 mutation 热路径同步写文件。
9. 文件投影启动分页补齐超过 256 个 Task 的 backlog；一万事件后的正常新事件只读取增量。目标目录/文件固定为 0700/0600，打开后再次用 fd metadata 拒绝 symlink、hardlink 和非普通文件；零字节 write 立即失败，timeline 控制符单行转义，受控 Task 目录只对自身命名的遗留临时文件做有界清理。两文件间崩溃保留 `write_started`，下一轮从 SQLite 重建。

收益：重复点击、Renderer 重连和 Core 重启不会重复创建、删除、归档或改写同一项目/任务；业务事实与命令证据没有新的崩溃双写窗口，审计可以按 route 结构动态判定是否真正接管。

缺点：每次业务写增加同步 WAL 与 SHA-256 成本，任务事件还增加一行同事务投影 outbox；文件与图谱投影是最终一致副本，提交后短时间内可能落后，磁盘持续故障时会保留 retry backlog；receipt 直接保留 64 KiB 内的 JSON 结果，未来的大结果必须改用 `ArtifactRef`；现有 Project/Task 模型尚无统一数值 revision，只能沿用现有 `expectedUpdatedAt` 等局部 CAS；外部操作 unknown 优先避免重复副作用，但会把对账责任显式暴露给恢复流程或人工处理。

第二批已迁移清单：`PATCH /api/tasks/:taskId/management-status`、task run/pause/continue/cancel 与 task board moves 均直接消费 `{command,input}`。普通事实走 Core 原子事务；management-status/worktree/会话恢复、看板联动清理和 Runtime 写出走稳定外部身份、write marker 与四态。Task integration 由独立 Workspace Git 纵切负责，不在本切片重复建立账本。

未验边界：本纵切只使用临时 SQLite、fake sender、动态审计与静态构建，没有访问正式数据库，没有启动真实 Runtime、Provider、Telegram 或 Git，也没有在独立 `Zeus Test.app` 中验收 Project/Task 表单、重连重放、部分送达或 status 提交后故障。

### Runtime Session/Confirmation 命令与瞬态能力纵切

`RuntimeSessionCommandApplication`、`runtimeSessionCommandRoutes` 与 Renderer 的 `runtimeSessionCommandClient` 接管当前发现的 15 条 Runtime Session/Confirmation mutation，并按真实写出代价分成三类：

1. session start/interrupt/stop 共 3 条进 `external_operation`。每个操作使用稳定的进程操作身份，先 prepare，再在 spawn、signal 或 stop 前提交 write marker，最后只按 `failed_before_write`、`explicitly_rejected`、`outcome_unknown_after_write`、`accepted` 四态收口；写出后结果未知禁止盲重发。session start 的 operation identity 同时是稳定 session ID，accepted replay 读取不可变 receipt 结果，不会再次启动进程。
2. summary/favorite/archive/restore/delete 共 5 条进 `core_application`，在一个 `durableTransactionSync` 中写 Runtime 业务事实、Inbox/Outbox 与 accepted receipt。session-task link 同时写 Task 事实、`task_events` 权威事件和文件投影 outbox；JSONL 只在提交后按 event ID 异步幂等投影，因此该第 15 条路由已从 `partial` 提升为 `integrated`，文件丢失可由 SQLite 重建。
3. confirmation create/confirm/reject 共 3 条仍消费稳定 `{ command, input }` 身份和 canonical SHA-256，但只进入进程内 capability registry 与有界 immutable replay：能力 TTL 为 10 分钟、最多 256 个，replay 最多 512 条；敏感 session 正文不进入 Command Inbox，审计仅是附随证据。确认只能消费一次，Generic shell 的 session start 在 write marker 前重新核对完整 session/security context 并消费能力。
4. capability issue/input/resize 共 3 条使用每 session lease：默认 TTL 60 秒、最多 128 个 lease、每个 lease 最多保留 64 个序列结果。Renderer 使用稳定 client identity、严格单调 sequence 与同一序列同一摘要重放；sequence gap、同序列不同输入、过期或错误 owner 均失败关闭。它们不为每个按键或 resize 同步写 Command WAL，避免把终端高频热路径变成 SQLite 同步写热点。
5. Renderer 对耐久 mutation 在第一次网络发送前只构造一次不可变 Envelope，传输重试沿用同一 command identity；旧裸 body 与 `Idempotency-Key` fallback 已移除。input/resize 在结果未知时丢弃本地 lease cursor，下一次重新读取服务端 `nextSequence`，不会猜测序列并盲目补发旧正文。

收益：耐久 session mutation 可区分写出前失败与写出后未知；interrupt/stop 不会因 Renderer 重试重复发送进程信号；input/resize 避免逐次同步 WAL；confirmation 不再用一张耐久 receipt 冒充重启后仍存在的进程内授权；Inbox 只保存输入摘要，不复制 shell 参数或终端正文。

缺点：confirmation 和 input/resize lease 都是单进程能力，Core 重启、TTL 到期或容量淘汰后必须重新获取；session start 在消费确认后若 write marker 提交失败，会保守丢失该确认并要求用户重新确认，以安全性换取可用性；瞬态序列只提供有界去重，不是跨重启 exactly-once；session-task link 的人工排障文件是最终一致投影，不保证响应返回时已落盘。

未验边界：行为验证器只使用临时 SQLite、假 Runtime 调用与受控时钟，尚未启动真实 PTY、发送真实 OS signal、访问正式数据库或在独立 `Zeus Test.app` 中验证终端输入、窗口 resize、Core 重启和 GUI 重试。现有 Runtime manager 仍会按其既有策略写运行日志或合并持久状态；本切片只证明 input/resize 不新增逐请求 Command WAL，不能据此宣称整条终端链路零磁盘写入。

### Command Center Core 与 Runtime 外部操作纵切

`CommandCenterCommandApplication` 以六种稳定命令接管九个公开写路由：`command_center.definition.create/update/delete` 覆盖全局与项目定义，`command_center.confirmation.create` 创建一次运行确认，`command_center.run.start/stop` 管理外部 Runtime 操作。

1. Renderer 与 Telegram 都提交 `{ command, input }`。Envelope payload 只保留 `operationIdentity` 和 `inputSha256`，敏感运行参数只存在于当前请求与进程内确认对象，不复制进 Inbox、Outbox 或 receipt。
2. 定义 create/update/delete 与确认 create 使用 `command_definition`、`command_run` scope。更新和删除执行 revision CAS；create 以 operation identity 作为新定义或 run 的稳定 ID。accepted 重放从不可变 receipt evidence 返回原结果，不再次执行 Repository mutation、审计追加或 Realtime 广播。
3. 确认创建把 run 的 `pending_confirmation` 事实、审计、Inbox、Outbox 和 accepted receipt 放进同一事务；进程内确认仍保存敏感值并按原安全边界在重启后失效，receipt 只保存公开确认投影。
4. 运行启动先把 run 切到 `starting`，运行停止先切到 `stopping`，并与 external Outbox 同事务提交。`command_run` scope 只接受路径安全的 run identity，不能借客户端身份逃逸 `commandRunsDirectory`；write marker 在创建运行目录、广播阶段事件、启动或停止 Runtime 之前耐久成立，且没有该 marker 时 Application Service 拒绝记录 accepted。成功后 `running/cancelled`、审计与 accepted receipt 同事务收口。
5. 启动参数失效、确认过期或权限不满足时，以 `explicitly_rejected` 回执和 run rejection 同事务收口；外部写出后普通异常只能记 `outcome_unknown_after_write`，HTTP 返回 503 且保留 `starting/stopping`，不能伪装成安全失败或自动重试。
6. `command-run-start:<runId>`、`command-run-stop:<runId>` 是稳定外部操作身份。不同 command ID 复用同一身份会被 Repository 与 SQL trigger 拒绝；同一 command 在确证写出前失败后可安全创建下一 attempt，unknown/accepted 后仍失败关闭。
7. 副作用审计不维护 Command Center URL 白名单。它从每条路由动态解析实际调用的 Application method，再核对该 method 是否消费 `CommandCenterMutationRequest`、解析稳定 command type，并调用 Core 原子边界或完整 External prepare/marker/resolve 协议。

收益：重复点击、Renderer 重连和 Telegram 内部转发共享同一套公开协议；定义 mutation 不再与接纳证据形成双写；Runtime 启停在崩溃后能区分安全拒绝与结果未知；`starting/stopping` 不再让 UI 把写出中的操作误报为“待确认/运行中”。

缺点：每次命令中心写操作增加同步 WAL 提交与 SHA-256；客户端必须携带 revision 和稳定身份；外部操作 unknown 可能长期停在中间态，必须由 Runtime/进程证据人工或后续恢复流程收敛；确认中的敏感参数不持久化，因此重启后的旧确认不会被自动恢复。

未验边界：本切片没有启动真实 shell、Telegram 或正式数据库；运行自然退出、超时、启动时中断恢复、Core close 强杀和 Runtime 日志产物登记属于后台/Runtime 事件审计，仍需独立迁移与 `Zeus Test.app` 故障注入，不能从九个 HTTP 路由已接管推导为完成。

### Conversation 配置与生命周期纵切

`ConversationCommandApplication`、`conversationCommandRoutes` 与 Renderer 的 `conversationCommandClient` 接管 10 个真实路由注册点，对应 11 个稳定命令类型：next-turn settings、permission mode、collaboration mode、Goal set/pause/resume/clear、attention acknowledgement、Provider thread restore、conversation archive/restore。Goal pause/resume 共用一个参数化注册点，因此注册点数与命令类型数不同。

1. 公开 Body 精确为 `{ command, input }`，Envelope 使用 `product_conversation` scope，payload 只保存稳定 `operationIdentity` 与 canonical `inputSha256`。Renderer 在一次用户操作中只构造一次不可变 Body，Transport 重连必须复用原身份。
2. next-turn settings、permission/collaboration mode、attention acknowledgement，以及 legacy conversation archive/restore 使用 `core_application`；业务 mutation、Inbox/Outbox 与 accepted receipt 在同一 `durableTransactionSync` 中提交，领域拒绝整体回滚，accepted replay 只读取原始结果。
3. Goal mutation、Provider thread restore 和 native conversation archive/restore 使用 `external_operation`。Provider 或文件动作前先提交 write marker，随后只允许 `failed_before_write`、`explicitly_rejected`、`outcome_unknown_after_write`、`accepted` 四态；unknown 返回 `recoveryRequired` 并由账本阻断同一命令自动重放。
4. 外部回执只保存有界业务投影：Goal record 的 objective 已限 4,000 字符，thread restore 只保存 conversation/thread/provider identity，lifecycle 只保存 conversation ID、archived 与 updatedAt。统一 receipt evidence 上限为 64 KiB UTF-8；未来大结果必须改用 `ArtifactRef`，不能放宽 SQLite 回执。
5. 耐久错误先经产品脱敏器处理，再按 2 KiB UTF-8 截断；同进程相同 command/hash 的并发请求折叠为一次外部写出。写出后发生结果序列化超限也保守进入 unknown，不能因回执过大盲目重做 Provider/文件动作。
6. messages、queue、interrupt、request-response、side-chat 与 change-set 已由下一节的 Dispatch/Queue 纵切接管；Git 和全局 settings 不属于本纵切。Goal GET 保持只读协调入口，不建立伪 Command 账本。

收益：配置写入与接纳证据不再存在崩溃双写窗口；重复点击、Renderer 重连和 Core 重启不会重复归档、恢复或改变 Goal；Provider 结果未知有明确恢复语义；回执大小与敏感错误不会无界膨胀 Core SQLite。

缺点：每次配置 mutation 增加一次同步 WAL 与 canonical SHA-256；Provider/文件 unknown 不能自动恢复可用性，必须由后续对账或人工确认收敛；当前会话模型除 attention revision 外没有统一数值 revision，多数命令仍使用现有资源身份与领域预检，后续引入统一 CAS 时需要协议升级。

验证边界：`verify-conversation-command-behavior.ts` 只使用临时 SQLite 与假外部调用，证明 Core 原子回滚/不可变 replay、并发重复折叠、四态、failed-before-write 安全 attempt 2、unknown 阻断、错误脱敏/限长及 `quick_check=ok`；没有调用真实 Provider、正式数据库或独立 `Zeus Test.app`，不能据此宣称真实归档/恢复和 GUI 重连已验收。

### Conversation Dispatch 与 Queue 纵切

`ConversationDispatchCommandApplication`、`conversationDispatchCommandRoutes`、`ConversationQueueCoreMutationApplication` 与 Renderer 的 `conversationDispatchCommandClient` 接管 15 个真实注册点、16 个稳定命令类型。change-set 的 undo/reapply 共用一个参数化注册点；其余范围为 messages、side-chat、Queue update/retry/reroute/delete/send-now/resume/recover/reorder、turn interrupt、server request respond、plan implementation respond 与 request snooze。

1. 公开 Body 精确为 `{ command, input }`，Envelope 使用 `product_conversation`、`submission`、`turn` 或 `approval` 真实资源 scope，payload 只保留 `operationIdentity` 与 canonical `inputSha256`。Renderer 首次发送前只构造一次不可变 Body；message 与 change-set 用现有 idempotency key 作为 reconnect identity，同一 key 换正文会失败关闭。
2. Queue update/retry/reroute/delete/reorder 与 request snooze 是六个纯 Core 注册点。领域 mutation、Inbox/Outbox 与 accepted receipt 由 `executeCoreApplication` 在同一 SQLite 耐久事务提交；`ConversationQueueCoreMutationApplication` 自身不 save、不广播、不调用 Provider。成功后的 Realtime 通知和队首调度只在事务提交后执行，accepted replay 不再触发。
3. change-set 文件操作、message、side-chat、send-now、resume/recover、interrupt 与两类 request response 是九个 External 注册点、十个命令类型。Application 不再把进入外层 handler 当作 Provider 写出；由 Codex/Pi/旧 Runtime 适配器在真实 RPC 之前精确触发 `external_operation` write marker。账号读取、模型预算、上下文编译、工作区准备和会话恢复仍处于 marker 之前；只允许 `failed_before_write`、`explicitly_rejected`、`outcome_unknown_after_write`、`accepted` 四态，unknown 明确阻断自动重发。
4. 外层公开 Command 不取代既有 Provider Command 账本，而是以稳定父子身份调用它：message 的公开 operation identity 稳定派生 submission，side-chat、change-set、send-now、interrupt 和 request 使用各自资源 identity，plan implementation 把公开 operation identity 传给 coordinator。这样两层账本可以对账，不会因重连生成另一 submission 或把同一次 Provider 写出绑定到随机子命令。
5. submission 持久接纳后立即以 `clientUserMessageId` 投影本地用户消息；Provider 回显使用同一身份升级已有行并补齐 thread/turn/item，不允许首条提示词等待 Provider 回显或生成重复消息。Codex 和 Pi 初始会话、历史续发、暂存队列与 steer 全部共用该投影；无原生续接协议的外部模型仍只能恢复 Zeus 可移植上下文。
5. External accepted 结果使用 gzip 内容寻址 `ArtifactStore`，receipt 只保存双哈希、内容长度和 `conversation-dispatch-command-result-v1` generation；重放按 command owner 与 32 MiB 解码预算复核。Core receipt 上限为 256 KiB，耐久错误先脱敏再按 2 KiB UTF-8 限长。同进程相同 command/hash/外部操作的并发重复折叠成一次写出。
6. `index.ts` 的旧 inline mutation handler 已删除，组合根只注入 Application、领域 port 和提交后 hook；行为门禁逐项核对 15 个 registration、16 个 command、Renderer 15 次构造调用、两处 reconnect reuse、稳定父子 identity 与纯 Core 无外部副作用。

收益：消息从 `partial` 提升为 `integrated`；Renderer 重连、重复点击和 Core accepted replay 不会再次创建 submission、写文件或调用 Provider；Queue 事实与接纳证据不再存在双写窗口；大结果和敏感异常不会放大 SQLite receipt。

缺点：每个公开 mutation 增加 canonical SHA-256 与至少一次同步 WAL；External 成功还增加 Artifact I/O。write marker 后发生结果超限、Artifact 写入失败或连接中断时必须保守进入 recovery required，可能牺牲即时可用性。plan implementation 的 dismiss 仍和 implement/refine 共用 External 边界，虽然 dismiss 本身通常只改 Core 事实，但统一请求路由避免在解析后再分裂账本语义，代价是多一次外部操作 marker。

验证边界：`verify-conversation-dispatch-command-behavior.ts` 只使用临时 SQLite、临时 ArtifactStore 与注入的假外部操作，已证明 Core 原子回滚/不可变 replay、1.25 MB ArtifactRef 重放、并发折叠、四态、unknown 禁止重发、2 KiB 脱敏错误、结构数量及 `quick_check=ok`。它没有调用真实 Codex/Pi、写真实项目文件、访问正式数据库或启动独立 `Zeus Test.app`，因此真实 Provider 双账本对账、change-set 文件结果与 GUI 重连仍未做运行验收。

### Local Server Git 外部操作与瞬态确认纵切

`GitCommandApplication`、`gitCommandRoutes` 与 Renderer 的 `gitCommandClient` 接管 12 个公开 mutation：confirmation create/confirm/reject、generic operation、Project branch/checkout/commit/stash/apply-stash/pull/push，以及 Task rollback。该范围不包含 Electron Main IPC Git、Project Workbench action、task git-workspaces/integration 或 settings。

1. 三个 confirmation 路由是 `ephemeral_capability`，不写 Command Inbox/Outbox。能力默认 TTL 10 分钟、最多 128 个活动确认和 256 个近期 Command replay；达到容量时以 429 失败关闭，不驱逐仍有效的确认。Core 重启、TTL 到期或确认被一次消费后都不能靠 receipt 恢复授权，审计行也不等于仍有可执行能力。
2. confirmation 请求仍使用稳定 `{ command, input }` 身份和 canonical SHA-256；同一 Command 可在有界内存中重放原结果，复用 command ID 但改变类型或输入会冲突。确认在 durable write marker 之前完成核对并一次消费；随后白名单参数预检若失败，该确认也保持已消费，调用方必须重新取得确认。这降低了确认被换参复用的风险，代价是一次输入错误会要求用户再次确认。
3. 其余九个执行入口使用 `external_operation`，以 `git-confirmation:<confirmationId>` 作为跨 Command 唯一外部操作身份。Application 先建立 Inbox/Outbox，再消费确认和完成纯参数预检，然后落 write marker，最后才调用真实 Git port；同一确认不能被另一 command 再执行。
4. Git adapter 使用通用四态模型，但当前没有可证明的“外部明确拒绝”证据：marker 前错误只记 `failed_before_write`，marker 后任何进程、网络、序列化或 Artifact 故障都保守记 `outcome_unknown_after_write`；不会把普通异常伪装成 `explicitly_rejected`。unknown 与 accepted 都阻断自动重发。
5. accepted 结果以 gzip JSON 写入内容寻址 `ArtifactStore`，receipt 只保存 artifact SHA-256、内容 SHA-256、解码长度与 generation。重放按 command owner、32 MiB 解码预算、双哈希、长度和 generation 重新验证，且不再次调用 Git。Application 在记录 accepted 前先验证结果可落入同一 32 MiB replay 预算；超限发生在 Git 写出之后，只能进入 unknown，不能形成首次成功但自身无法重放的 accepted。
6. 错误 message 先走产品脱敏器，再按 2 KiB UTF-8 上限保存和返回。Renderer 每次操作只构造一次 Envelope；`LocalApiTransport` 刷新连接时复用同一个已序列化 Body，不生成新的 command 或 confirmation identity。
7. 静态审计不会豁免 Git 目录：五个直接 `server.post` 注册按 handler 解析，七个 Project route 则逐项解析其静态 `path + commandType + operation` 注册三元组；只有 Application、Renderer、composition、Artifact/unknown/confirmation marker 和行为 verifier 同时成立时，九条执行才标记 `integrated`、三条确认才标记 `ephemeral_capability`。

收益：Renderer 重连和重复点击不会重复 Git 写出；同一确认不能换 Command 二次消费；崩溃后 unknown 不会被盲重发；大型 stdout/stderr 不再放大或泄漏进 SQLite receipt，同时 accepted 仍可精确重放。

缺点：confirmation 不是高可用业务状态，Core 重启后用户必须重新确认；每个真实 Git 操作增加 Inbox/Outbox、同步 write marker、Artifact I/O 与 accepted receipt；unknown 需要人工或后续仓库证据对账；结果超出 32 MiB 时即使 Git 已完成也只能保守进入 recovery required。临时行为 verifier 只注入 fake Git port，没有执行真实 Git、访问正式仓库/数据库或启动 `Zeus Test.app`，因此真实凭据、网络 remote、Hook、冲突和 GUI 重试仍未验收。

### Graph 与会话创建 External 纵切

`GraphConversationCommandApplication` 与独立路由模块接管 Project/Task conversation create、Project scan、Graph views generate、Project ask 和 current scan 共 6 条公开 mutation。六条都使用公开不可变 `{ command, input }`、真实 project/task scope、耐久 external write marker、四态回执、32 MiB ArtifactRef 重放与 2 KiB 脱敏错误；Renderer 在一次用户意图中只构造一个 Envelope，相同重连身份不能换正文。

Project scan 的 `completed` Core 状态与 accepted receipt 同事务收口；扫描和问答的外部 Worker/Provider 子身份由父 operation identity 稳定派生。并发重复命令共享活动 Promise，accepted 只读 Artifact，unknown 禁止盲重试。公开扫描结果不会暴露 Worker 内部 `heavyWorkerResultRef`。收益、缺点、六条路由及 fake-port 验证边界见 `ZARCH-030-031_Graph与会话创建命令纵切.md`。

### Execution Host stop-active 外部命令纵切

`POST /api/execution-host/stop-active` 已从无身份的终止请求改为 `execution_host.stop_active` 稳定公开命令：

1. Electron Main 在一次“停止活动工作并退出”动作开始时只创建一份不可变 `{ command, input }`。scope 固定为 `execution_host/local-core`，表示本机逻辑 Core，不绑定短命 PID 或 generation；Detached 控制面在网络恢复后重用同一对象，Embedded 路径只序列化一次。`/work/stop` 和 Execution Host 内层转发都原样传递该正文，不会在中途重建 command ID 或 operation identity。
2. Core Application 重算 canonical input SHA-256，精确校验公开正文与 payload 字段，然后以 `external_operation` 建立 Inbox/Outbox。首个 Provider、Runtime 或进程信号之前必须耐久提交 write marker；后续只允许 `failed_before_write`、`explicitly_rejected`、`outcome_unknown_after_write` 和 `accepted` 四态。同进程并发重复命令共享一个活动 Promise；accepted replay 只读耐久回执，unknown 必须返回 recovery required 并禁止自动重发。
3. write marker 前先生成待停止计划，对 `conversationId + providerTurnId` 去重。Codex 与 Pi 的 interrupt RPC 及 Goal pause 以 `Promise.allSettled` 并行发出，每个原生 turn 最多一次；该路径只等待 RPC 返回，不等待远程 turn 终态，回执始终标记 `providerOutcomeUnconfirmed=true`。
4. 中断请求发出后，Core 把本机进行中 turn 收口为 `interrupted`、可恢复 submission 收口为 `cancelled`、pending server request 收口为 failed，停止活动 Runtime/Command run，并在 `save()` 完成后才记 accepted。Main 仅在该命令成功后进入 `force_quit`；无法耐久收口时保持应用打开，不冒充停止成功。升级 handoff/prepare 继续使用独立 `handoff_control_capability`，本纵切没有改变交接语义。
5. accepted receipt 总量限制为 64 KiB，失败错误先经产品脱敏再限制为 2 KiB；Provider 中断失败明细最多 16 条、每条 message 最多 512 字节，同时保留未截断的失败总数。

收益：Main、control socket 和 Core 共享同一命令身份，网络重试、重复点击与并发进入不会二次中断同一 turn；本机终态与 accepted 证据先于强制退出成立；写出后结果不明时保守阻断，不以盲重发换取表面可用性。

缺点：每次停止增加 Inbox/Outbox、write marker 与 receipt 的同步 WAL 写放大；复合操作可能已部分发出 Provider interrupt 却在本地保存前中断，此时只能保守 unknown 并保持 Main 打开；逻辑 `local-core` scope 仍依赖已鉴权的当前 Execution Host 通道；失败明细有界意味着完整大规模错误需通过指标/日志进一步排查。

验证边界：`scripts/verify-execution-host-stop-command-behavior.ts` 只使用临时 SQLite、注入的 fake Codex/Pi/Runtime 与临时 HTTP control server，已验证单 turn 单次并行 interrupt、本地终态收口、accepted replay 不二次执行、四态、unknown 阻断、有界脱敏回执、Main 控制面两次发送字节相同正文及 `quick_check=ok`。它没有触发真实 Provider、正式数据库或 OS 进程，也没有验收 detached Core 在断电/崩溃窗口、跨版本升降级、大库延迟、真实 Provider 终态或打包 `Zeus Test.app` GUI。

### 发布说明的一次性短期能力

`POST /api/command-runs/:runId/release-notes` 只为 Command Center 子进程提供一次短期的 DeepSeek 生成能力，不创建 Zeus 业务事实，也没有可供崩溃后恢复的结果，因此明确归类为 `ephemeral_capability`，不能伪装成 durable Command：

1. bearer token 与 `runId + projectId` 绑定，授权在全局 API token 之前按精确路径核验；同一未消费 run 的重复创建只返回原 token，不允许重置或换项目，成功核验即标记已消费，同一 token 不能并发或二次使用；畸形 percent-encoding 直接拒绝，不把鉴权解析异常升级成 500。
2. 能力 TTL 为 10 分钟、活动表硬上限 256；达到上限时失败关闭，不驱逐仍有效能力。命令完成或请求结束后主动撤销，过期项在创建和鉴权时惰性清理。
3. Provider 请求只允许固定模型，prompt 上限 400,000 字符；API Key 只从 SecretStore 读取，不进入命令环境、receipt 或响应。该路由没有 Command Inbox/Outbox、业务 Repository 写入、审计写入或 durable replay。
4. 静态门禁同时核对 policy、容量、TTL、一次消费、WeakSet 请求绑定、项目校验、`finally` 撤销、prompt 上限及无 Command WAL；任何 marker 漂移都会重新归为 `pending`。

收益：发布脚本不获得全局 Local API token；短期能力不会向 SQLite 制造无恢复价值的同步写热点；泄漏 token 的有效时间、作用对象和可消费次数均有界。

缺点：Core 在 Provider 已收到请求后崩溃时无法精确重放结果，也无法证明是否已产生第三方费用；调用方只能重新创建命令并接受可能的重复生成。进程重启会丢失所有未用能力，这正是安全边界，不属于高可用业务状态。

### GET/HEAD 读路径纯度门禁

副作用清单不能只扫描 `POST/PUT/PATCH/DELETE`。旧实现曾在 GET 中恢复 Project scan、保存 Git diff snapshot、写导出审计、发布 graph/git mutation 事件，并在读取 Agent/Codex 账号时隐式启动 Provider；这些写入会绕过 Command admission fence，也会让页面刷新放大 SQLite、进程和 Provider 开销。

本轮把 scan 恢复固定在 Core 启动阶段；Git diff/patch、graph view、settings/data export 改成纯读取，真实 Git snapshot 继续由显式 POST 创建；Snapshot V2 不再为了读取强制 flush/save，允许依赖耐久增量的正常批量落盘；Agent catalog 和 Codex account 只读取既有 transport，不在 GET 中 `ensureReady`。导出成功审计应由未来实际保存文件的 Main Command 边界记录，不能把“生成内存快照”冒充“文件已成功导出”。

`scripts/audit-http-read-side-effects.mjs` 现在使用 TypeScript Program 与 symbol checker 动态发现 Local Server 的 GET/HEAD handler，并沿同文件、相对 import 的真实 symbol 做传递调用图；跨 package、依赖注入或无法静态唯一解析的端口由 `scripts/http-read-effect-policy.mjs` 明确声明。机读 effect port 至少区分 `copied_db`、`filesystem_workspace`、`git`、`provider_network`、`keychain`、`process_runtime`、`bounded_observability`、`subscription` 与 `unknown_external`。未知 external callee 不会因“名称不在规则表”降成复制库读取，`--require-clean` 必须失败关闭。

每个在只读验证中可触达的非 `copied_db` 外部读取都必须同时命中 route policy、`isReadOnlyValidationExternalRead` 的实际正则和 `verify-read-only-validation-fence.ts` 的阻断路径；构造期禁用、只读投影或 validation-root confined 例外也必须提供可机读源码/行为 marker。conversation resource 与 turn-change file 的 open-intent/preview 四路使用精确 operation、四条毒化路径和 `copiedPathReadsBlockedBeforeRecordResolution` 证据，证明在查询 record、解析路径或触碰正式 workspace 前已经返回 503。普通模式另由 `verify-http-read-purity.ts` 对七条历史问题路由证明 SQLite `data_version` 不变且 Provider 调用为零。

本次动态清单发现 138 条 GET/HEAD：78 条复制库或纯内存读取、54 条只读验证外部端口失败关闭、5 条有界观测、1 条 WebSocket 订阅能力；九类 effect 的计数、`externalTotal=54`、`unknownExternalTotal=0`、`policyComplete=true`、`evidenceComplete=true` 均直接进入 JSON summary，`--require-clean` 通过。路由数量和 effect 计数随源码动态变化，不作为手写总数白名单。

原有七条真实传递副作用已收口：subagents 与两个 Codex capability GET 只消费既有 ready transport，未就绪返回明确 unavailable/capability false，不再 `ensureReady`；三个 Git workbench GET 与 task-push capability 只读取已登记 repository，不再通过发现同步调用 `replaceForProject`/`db.save`。仓库发现、远端刷新和登记必须进入已有显式 mutation/启动恢复边界；当前没有对应产品 Command 的部分保留为后续能力缺口，不能退回 GET 偷写。

收益：刷新页面不会建立业务事实、启动 Provider 或制造 WAL fsync；读流量更适合横向扩展、缓存和压测；只读验证不再依赖两个手写 helper guard，新增深层 helper 或新 external port 会在门禁中自动暴露；四路复制路径即使携带正式 workspace 毒化值也不能越过 fence。

缺点：effect 声明和 route/evidence marker 会增加维护成本，重命名端口或调整验证路径时必须同步策略；静态调用图无法完整推导动态注入、反射和运行期分派，因此这些边界仍需明确声明与行为 verifier 共同兜底。Workbench 和 task-push 不再自动发现仓库后，未登记或已过期的 repository 会显示为空、失败或旧快照，用户必须通过未来的显式刷新 Command 更新；Codex transport 未启动时 subagents/能力目录不会再用 GET 隐式预热。

## 副作用入口清单与门禁

`scripts/audit-command-side-effect-entries.mjs` 每次从当前源码生成 JSON 清单，不依赖手写行号或总数快照。并行纵切会持续增删注册点、改变 `integrated/pending/partial` 分母，因此全局数量以每次 JSON 的 `summary` 为准；文档只固定已经具备精确结构门禁的子清单。Conversation Dispatch/Queue 当前必须精确发现 15 个注册点且全部 `integrated`，覆盖 16 个命令类型；少一条或结构 marker 漂移都会使 `--require-conversation-dispatch-command-slice` 退出 2。当前源码可发现的 Codex/Pi Provider 变更调用也继续逐点扫描，不按旧行号豁免。

Runtime 子清单不使用 URL 整段豁免：15 条已发现路由中 9 条为 `integrated`、6 条为 `ephemeral_capability`。`ephemeral_capability` 只在结构证据同时证明 TTL、容量、单调序列或有界 replay 且没有逐请求 Command WAL 时成立；它不是 durable command 的别名，也不计入待迁移副作用。

Git 子清单同样不使用 URL 或目录豁免：12 条已发现公开 mutation 中 9 条真实执行为 `integrated`、3 条 confirmation 为 `ephemeral_capability`。七个 Project route 虽由 helper 注册，审计仍要求逐条发现静态 path、command type 与 Git operation 三元组；漏掉任何一条都会使 `--require-git-command-slice` 失败。

Conversation Dispatch/Queue 子清单不按 URL 白名单放行。每个 route 必须真实消费 `ConversationDispatchMutationRequest`，进入 Core 原子事务或 External marker/四态/Artifact 边界；全局 marker 还同时核对 Renderer 不变 Envelope、reconnect cache、旧 inline handler 删除、稳定 Provider 子操作 identity、纯 Core Queue 无外部副作用和行为 verifier 已进入总门禁。

`--require-conversation-slice` 同时核对公开路由、Application Helper、会话 Segment Lifecycle、Codex Coordinator 和耐久派发标记仍连成一条路径。Runtime durable 条目只有在路由直接消费信封、应用服务包含 Core 原子事务或 External prepare/write/四态回执/单写入者且 composition 注入同一账本时才标记 integrated；Runtime confirmation 还必须证明进程内 TTL/容量/有界 replay 且没有 `executeCore`，input/resize 则必须证明 lease、单调 sequence 与有界去重。Memory 条目还要求三条路由分别消费 `{command,input}`、使用各自稳定 command type、调用 `executeCoreApplication` 并把 operation result 原样返回。Command Center 条目不按 URL 放行，而是动态跟随 route → application method，并核对公开 Envelope、Core/External 协议、Renderer 请求构造与行为探针。Codex 公开控制条目还要求真实 scope、正文/摘要分离、Renderer 不变命令重试、External 四态、可证明明确拒绝、Artifact 精确重放、composition 接线与行为探针同时成立。Work Management 既有条目动态跟随 handler；九个抽离 Core 入口与本批 7 个任务状态/运行入口分别逐项核对公开 Envelope、稳定 command type、统一 Application、composition/Renderer 接线、64 KiB replay、External 四态、Telegram 子 outbox 与耐久 TaskEvent 投影。Task status 的 Telegram 已有可恢复子操作，图谱明确为可重建投影；Runtime session-task link 也由 SQLite 事实加投影 outbox 覆盖，两者均为 integrated。只读项必须同时具备声明、路由调用和实现级无写证据。`--require-complete` 在任何 partial/pending 再出现时以退出码 2 失败；当前 203 项动态分母已是 `183 integrated / 20 明确非耐久能力或只读分类 / 0 pending / 0 partial`，门禁退出 0。

HTTP/Provider 清单仍不把 Electron Main IPC 混入自己的分母；Main 已由下述独立机器清单接管。Git Core 没有独立公开 adapter 的内部调用、除下述隔离副本启动路径外的后台任务和没有公开边界的 Worker 内部 API 仍保留后续审计。排除表示审计范围不同，不表示安全或已迁移。

### Electron Main IPC、OS 与 Git 独立机器清单

`scripts/audit-electron-main-side-effect-entries.mjs` 使用 TypeScript AST 递归发现 `apps/desktop/src/main` 下所有 literal `ipcMain.handle/on`，并从 `appShellPolicy.ts` 动态发现原生菜单/Tray action。每个发现项必须命中一个精确 channel/action 声明；新增、移动、重复、删除或实现 marker 漂移都会让清单退出 1。清单不使用目录或 channel 前缀豁免。

当前源码事实为：

- 发现 108 个 IPC 注册和 9 个原生 action；其中 26 个是实现级只读入口，不进入副作用分母。
- 其余 91 个副作用边界中，`integrated=26`、`platform_capability_excluded=65`、`pending=0`。平台能力排除项逐条记录理由、用户确认来源和重试/幂等语义；它不是“Main 全部可信”的宽泛豁免。
- BrowserHost、迁移/恢复、Git/项目源码、发布更新、会话与任务资源等原 26 个 pending 已逐项进入 Main Command Ledger；精确 channel、文件、稳定清单 ID 与语义 marker 继续由脚本动态核对。
- Main Command 请求通过稳定信封、Main 单写账本及 external/core 四态接管；平台能力排除项仍按 OS 语义独立失败关闭，不能因 `pending=0` 推导为外部 exactly-once。
- Keychain 只有 ZenTao 链接解析中的一个限定 `getSecret` 读取点，归为只读；`setSecret/deleteSecret` 调用为 0。`shell.openExternal/openPath`、Finder、对话框和剪贴板能力按具体入口分类，并不因为是 Electron API 就自动免审。

收益：IPC 或原生菜单新增副作用时会在同一提交中暴露；平台动作的确认与重放边界可逐项复核；HTTP 与 Main 两套分母互不污染。缺点：声明表需要随实现同步维护，静态 marker 只能证明结构，不证明真实 OS、Git 或崩溃行为；`platform_capability_excluded` 仍需独立安全校验，不能替代 Command Envelope。

### 正式数据库隔离副本的启动风险

仅用 SQLite Backup API 生成一致副本并不等于安全启动。当前 `Zeus Test` 启动仍会消费副本中的 durable 状态，机器清单固定跟踪 14 条路径：

| 启动路径 | 当前行为 | 对隔离副本/外部世界的影响 |
| --- | --- | --- |
| Core 数据库启动对账 | 自动本地写 | schema/附件/投影、未回执 Provider write 封存、handoff 和扫描恢复均可能改写副本；当前不是 query-only 启动 |
| Codex Remote Control 恢复 | 可能自动外部动作 | 副本设置为 enabled 时 `ensureReady` 并启用真实远程控制 |
| Codex 旧线程迁移 | 可能自动外部动作 | 可调用 Provider 列表/读取并写迁移结果 |
| Codex 旧版导入恢复 | 可能自动外部动作 | 可访问 Provider/文件并推进导入状态 |
| Codex Native 恢复 | 可能自动外部动作 | 原生绑定或 recoverable submission 会触发 coordinator recovery |
| Codex 用量后台刷新 | 条件性自动外部动作 | 冷启动不单独拉起 Codex；其他恢复使 manager ready 后，每 60 秒访问真实用量端口 |
| `preparing` 集成尝试恢复 | 可能自动外部动作 | `listByState('preparing') → retryTaskIntegrationAiPreparation` 会读真实分支、建立 integration worktree、写冲突草稿并启动 Codex/Pi |
| Runtime 会话恢复 | 自动 OS 检查与本地写 | 按复制的 PID/PGID/token 检查当前真实进程并写 `orphan_detected/lost`；本函数当前不自动 spawn/kill |
| Pi accepted turn 恢复 | 自动本地写 | 把运行中轮次收敛为 interrupted 并暂停队列；实现明确不自动重发，也不启动 Pi Worker |
| Command Center 启动恢复 | 自动本地写 | 构造时创建目录，把 active run 改成 rejected/failed 并异步保存；不自动恢复或停止 Runtime |
| Heavy Worker 激活 | 只武装能力 | 只重开进程内有界队列；队列不持久化，`activate` 本身不 pump、不创建 Worker |
| Telegram | 只武装能力 | polling/start timer 只在显式 POST 中创建，单纯启动不发送；后续任务/Runtime/Command 事件仍可通知真实 Chat |
| Release/Update | Test 默认门禁 | 普通 `Zeus Test` 不建自动 scheduler；`ZEUS_ALLOW_UNTRUSTED_UPDATE_TEST=1` 会重新开启检查/预取，显式更新入口仍 pending |
| BrowserHost | 只恢复元数据 | 构造只读 snapshot/origin/tab JSON 并配置 session；不创建 View、不 `loadURL`，后续显式动作仍可导航/下载/打开系统浏览器 |

分类合计仍为：6 条 `automatic_external_effect_possible`、4 条 `automatic_local_copy_mutation`、3 条 `capability_armed_without_startup_execution`、1 条 `test_distribution_gated_unless_override`。这些是普通可写组合必须保留的风险说明；截至 2026-08-21，专用 `read_only_validation` 组合已把 14/14 条 startup risk 全部接入硬 Fence，正式大库副本运行已经通过；完整可视 GUI 仍待验收。

### Test distribution 专用只读验证 Fence

已建立显式 `read_only_validation` 组合，不复用普通 `Zeus Test`，也不把 `ZEUS_CODEX_NATIVE_ENABLED=0` 当作安全边界。当前接线面是：

1. Main 在 `app.setPath`、single-instance lock、BrowserHost/Core 和任何 Electron profile 写入前同步核对打包身份 `dev.hypha.zeus.test`、可执行名 `Zeus Test` 和显式 validation manifest。验证根必须精确位于该 Test 可执行身份派生的 `<Test data root>/read-only-validation/<UUID>`，`runId` 等于末级 UUID；它不得等于、包含或位于正式/legacy 数据根、`~/.zeus` 或来源数据库树。普通环境变量、任意可写临时根、数据库内设置或仅自签的 manifest 摘要都不能单独授权。
2. 工具明确区分 v2 `required_quiescent`、原始在线快照 v3 与正式验收使用的 v4 `online_backup_snapshot + offline_candidate_schema_migration`。在线模式的计划/确认绑定来源规范路径、device/inode、目标路径、Test bundle ID 和 run ID；Backup API 以 `readOnly + query_only` 纳入活动 WAL 已提交事实，记录备份窗口、页数、页大小、schema 摘要和 `sourceAdvancedAfterBackup`，允许来源合法前进。来源连接关闭后，v4 只迁移未发布候选并记录零运行时 writer、前后 schema/ledger/页数及只丢弃候选的回退窗口。目标仍必须是独立 device/inode、`nlink=1`、0600，并通过 SHA-256、schema、页边界和 `quick_check`。Test 启动/退出不再要求实时来源 SHA-256、mtime 或 WAL/SHM 不变，也不在运行时继续读取正式数据库；只复核来源仍是原规范路径和原文件身份、两树不重叠，以及目标与 manifest 自身完整。该自签摘要用于发现误操作和观察窗口内竞态，不是抵抗同 UID 恶意进程的密码学信任根。
3. 以类型化 descriptor 贯穿 `StartDesktopLocalServerOptions → ExecutionHostBootstrap → Execution Host capability/lease identity → startOwnedDesktopLocalServer → CreateLocalServerOptions`。bootstrap 在任何目录、lock、unlink、startup log 写入前，把 user-data、database、execution-host、project/task/browser/conversation attachments、grant secret、Codex home/legacy/config import source、Keychain service、Provider/Telegram/release 开关全部约束到 validation root；bootstrap JSON 使用 `O_NOFOLLOW` 打开同一 fd，核对 owner/权限/普通文件/256 KiB 上限并做有界读取及前后 dev/inode/size/mtime/ctime 复验。无效 bootstrap 失败时不向未受信路径写诊断日志。Main 不得附着到未声明相同 mode/manifest hash 的既有 Core；协议不支持时进入诊断页，不能降级成普通可写启动。
4. Core 必须在 `createZeusDatabase` 和所有 repair/recovery 之前选用 query-only 数据库/Application port；Storage 把完整 descriptor 传到实际 SQLite open，在摘要后、open 前后复验目标 path 的 dev/inode/size/mtime/ctime，关闭数据库后再次复验 path、全库 SHA-256 和 WAL/SHM/journal 缺席。任何 rename-swap、内容漂移或伴随文件出现都抛错，不能伪报验证成功。schema 不兼容时失败关闭；公开 `POST/PUT/PATCH/DELETE` 统一由 admission fence 拒绝，并跳过上表全部自动恢复、Provider manager、usage timer、集成 retry、Runtime PID 检查、Command Center 恢复、Telegram、Heavy Worker 和 update。
5. Main 与 BrowserHost 共用默认拒绝的 IPC Fence：只允许连接配置、窗口内存投影和 Browser 静态 snapshot/settings；拒绝文件/Git 读取、Browser WebContents 导航/下载/自动化、`shell.openExternal`、剪贴板写、导出/物化/删除、项目源码/Git 写和更新安装。Core HTTP 只允许复制库查询和诊断；即使是 `GET/HEAD`，只要可能访问 Provider、Keychain、Git、Runtime、Telegram、更新服务器、Worker 或网页，也统一返回 `ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED`。conversation resource 与 turn-change file 的 open-intent/preview 四路在查询 record 或解析复制路径前即返回 503，避免复制库中的正式 workspace 路径被当成当前文件能力。
6. 不向 Core/子进程传 Telegram token、正式 `CODEX_HOME`、Provider/API 凭据或更新 override。只读诊断端点和 UI banner 返回 run ID、manifest hash、数据库 hash、Core generation 与每条被跳过路径的理由，但不返回凭据或复制正文。

收益：可查看正式历史的一致副本，而不会联系真实 Provider、仓库/worktree、OS Runtime、Telegram、更新服务器或网页；受控 Test 根、规范 bootstrap 和数据库 open/close 身份复验会在写入替代目录、符号链接、过宽权限、超预算 JSON、生产根冒充和常见 rename-swap 上失败关闭；Fence 与 Detached Core generation 同一身份，不会在重连时静默丢失。

缺点：该模式不能验收迁移、恢复完成、写路径、Provider 续接或端到端 mutation 性能；Main、Core 与 Storage 会反复核验目标副本摘要，启动和退出成本随数据库大小线性增长。在线复制不能证明来源目录零写或来源内容哈希不变，外部只读 SQLite 连接还可能更新既有 SHM reader metadata；结论只能是“副本为一致时间点快照”。旧的任意临时 validation root/manifest 会被拒绝，无效 bootstrap 也不向未受信目录写 startup log。新增协议字段、只读 composition 和逐能力拒绝面增加维护成本；同 UID 恶意进程仍可能在观察点之间精确换回路径，最终更强边界仍应由正式 Core 持有租约并交付不可变副本。

当前行为证据：严格 v2 模式继续验证静止来源；在线 v4 模式已用约 48MB 活动 WAL 合成源在 2,000 次并发提交下证明来源前进、Backup API 目标一致、离线候选迁移及复制后新增写入不混入副本，并覆盖目标不可覆盖、空间不足、异常中断和计划后来源 inode 替换。正式 run `418ad6c5-15d5-4969-a75a-5aedd85fe499` 又完成 4.66GB 活动库备份、10 项候选迁移、最终打包产物 103/103 Snapshot V2、7,233 条 model history 完整 73 页、1,593 条单 turn process 完整 16 页、外接屏 ID 3 首窗、只读拒写、退出后独立哈希和无 companions 复核；全部冻结 sequence 无重复或缺口。独立可写 Test 根用正式 1xm 隔离凭据完成三次 Haiku 新会话，直接网络失败只产生一次请求，活动 Worker 崩溃以 `resultUnknown=true` 收口且 Provider 计数不增长；显式 recovery 切换新 generation、`replayedCommandCount=0`，恢复后真实会话再次成功。另一独立 Codex device-auth Test 身份用 CLI `0.149.0` 与 `gpt-5.4-mini` 完成新会话，6,029 ms 返回精确 `ZARCH-ISOLATED-CODEX-OK`，submission 与 Provider turn 均完成，原生 session JSONL 可按身份对账；验收后 Test 登录已注销，正式凭据未变。`verify-read-only-validation-bootstrap-security.ts`、`verify-read-only-validation-fence.ts` 与 IPC Fence 探针继续证明 Test descriptor/bootstrap、全局拒写、14 项启动跳过及 Provider/Browser 零调用。仍未通过的是 Computer Use 可视交互、双打包版本 handoff 和接近 2,000-turn 上限的真实 Provider resume 校准，不能由 HTTP/日志证据替代。

### Codex app-server 版本与模型预算兼容边界

Codex app-server initialize 同时兼容旧版 `serverInfo.version` 与新版顶层 `userAgent`；新版 `Codex Desktop/0.149.0` 可解析为 `0.149.0`，但缺字段仍保持未知版本，不伪造 ready。CLI `0.149.0` 的 `model/list` 不再给出 `contextWindow` 时，Core 先尝试 Provider 原始字段；只有精确命中 `providerVersion=0.149.0 + modelId=gpt-5.4-mini`，才使用 OpenAI 官方模型目录在本次验收日核对的 400,000 context / 128,000 max output，并把来源、版本与核对时间写入预算证据。CLI 或模型任一变化都返回不可用，要求重新取得官方证据后显式更新；禁止按 `gpt-5.4-*` 家族或名称前缀猜预算。

优点：当前已安装 CLI 与便宜模型能够真实派发，同时 Context Compiler 仍有可审计硬预算。缺点：兼容表需要随 CLI/官方模型目录变化维护；在更新前新版本会安全暂停，不能无感放行。

### Zeus Test Keychain service 隔离

该项已完成最小产品接线，但不代表上节完整只读验证 fence 已实现。Electron Main 以已准备完成的规范数据根（显式 `ZEUS_USER_DATA_DIR` 会先经 `resolve`）派生身份：正式 distribution 无论数据根为何都严格使用历史 service `Zeus`；Test distribution 使用 `Zeus Test <SHA-256(规范数据根) 前 16 位>`。派生值作为必填字段贯穿 `StartDesktopLocalServerOptions → ExecutionHostBootstrap → Execution Host → CreateLocalServerOptions`，bootstrap 对空值失败关闭；Main 的 ZenTao 凭据读取与 Core 的统一 SecretStore 因而消费同一个 service，Detached Core 不再自行回退到生产 service。

收益：不同 Test 数据根、任务 worktree 与正式 Zeus 不再共享 Keychain namespace；Owned/Detached Core 切换不会静默改变 namespace。缺点：更换 Test 数据根会表现为“凭据未配置”，旧 Test namespace 中的 Keychain 项不会自动迁移或删除，需要独立生命周期治理；service 隔离只缩小凭据串用风险，不能阻止 Provider、Git、Browser、Runtime 或其他启动副作用。

`pnpm exec tsx scripts/verify-keychain-service-isolation.ts` 只调用纯身份 helper 并检查接线 marker，输出 `keychainAccessAttempted=false`；它不会读取、写入或枚举真实钥匙串。该验证能证明确定性派生和参数贯穿，不能替代真实 Keychain 权限、升级兼容或 GUI 验收。

## 剩余现场验收与持续治理

1. 用真实 Provider 对写出前崩溃、写出后断开、明确拒绝和原生历史对账分别做故障注入；自动化 fake port 只证明本地协议。
2. 用在线 SQLite Backup API 正式历史副本和独立 `Zeus Test.app` 验证大库启动、读取、退出、目标哈希不变与所有 mutation/外部能力拒绝；来源只复核规范路径和文件身份。
3. 把两套公开清单、内部副作用清单、状态矩阵和事件注册表保持在默认失败关闭门禁中；任何新入口必须显式归类，不允许回到默认豁免。

收益：新入口会被机器清单立即截获，Core 重启、客户端重连与 Worker 故障使用同一套恢复语言，现场验收又能专注于自动化无法证明的真实边界。

缺点：全量清单与故障注入增加 CI 时间和治理成本；真实 Provider/打包验收需要隔离资料根、账号与明确窗口，不能在每次本地变更中无条件自动执行。

## 验证证据

- `pnpm exec tsx scripts/verify-command-delivery-behavior.ts`：临时数据库验证 unknown/accepted 阻断重放、明确拒绝后第二 attempt、启动封存 unknown、unknown 进入恢复清单并追加 accepted 对账、幂等冲突、回执不可变、业务状态同事务、注入异常时业务与 Inbox/Outbox 整体回滚，以及 `quick_check=ok`。
- `pnpm exec tsx scripts/verify-provider-runtime-recovery.ts`：临时 SQLite 与假 Runtime 可重复验证 accepted 重连不增加恢复调用；unknown 首次与重连均失败关闭且只有一个 attempt；busy 后只建立一个安全新 attempt；stale generation 不建立 Inbox；同命令并发合并、其他命令有界拒绝；accepted 只保存 generation `nativeSessionId`，`nativeTurnId=null`；`quick_check=ok`。
- `pnpm exec tsx scripts/verify-pi-provider-command-delivery.ts`：临时 SQLite 验证 `provider_session` 的 session-only 回执、`provider_turn` 的 session+run 回执；另在 session 身份投影和 accepted receipt 均已执行后注入事务回滚，证明两者都不残留、同一 attempt 仍能收敛 unknown 且 replay 被阻断；同时覆盖 run 投影回滚、明确拒绝后安全新 attempt、写出前失败及 `quick_check=ok`。
- `pnpm exec tsx scripts/verify-codex-provider-command-delivery.ts`：临时 SQLite 验证 Codex session/turn 原生身份、真实 owner generation、unknown 不重发、明确拒绝安全重试、写出前失败和业务投影回滚；另注入 final_quit 投影故障，证明 request/turn/submission/conversation 四者整体回滚，正常路径收敛为 `failed/failed/recovery_required/paused` 并保留 Provider 结果未知证据。
- `pnpm exec tsx scripts/verify-codex-public-command-behavior.ts`：临时 SQLite、临时 Artifact 根和假 external ports 验证 accepted 精确重放、同进程并发只调用一次、1.25 MiB 结果只存 Artifact 而回执证据保持有界、unknown 不重发、`runtime_rejected` 后安全 attempt 2、写出前失败、配置审计事务回滚及 `quick_check=ok`。
- `pnpm exec tsx scripts/verify-memory-command-behavior.ts`：临时 SQLite 验证 candidate/supersede/tombstone 幂等重放、operation identity、幂等冲突、候选治理拒绝整体回滚、成功 preview 不写账本及 `quick_check=ok`。
- `pnpm exec tsx scripts/verify-command-center-command-behavior.ts`：临时 SQLite 验证 Core accepted/replay、不同 Command 复用 operation identity 冲突、领域拒绝整体回滚、External accepted replay、同 Command 写出前失败后的安全 attempt 2、跨 Command external identity 冲突、明确拒绝无 write marker、unknown 禁止重发及 `quick_check=ok`。
- `pnpm exec tsx scripts/verify-work-management-command-behavior.ts`：临时 SQLite 验证 Core accepted 与不可变重放、领域拒绝整体回滚、External 四态与 unknown 禁止重放；status 另验证 Task/TaskEvent/投影 outbox/receipt/Telegram 子命令原子提交与回滚、Telegram accepted replay 单发、1.1 MiB 敏感异常脱敏有界。TaskEvent 投影覆盖 257 个 Task backlog、一万事件后的 4 行增量读取、并发 enqueue 高水位、两文件间崩溃重建无重复、0700/0600、硬链接/符号链接拒绝、底层零字节 write 失败、timeline 控制符单行转义、遗留临时文件有界清理及 `quick_check=ok`。
- `pnpm exec tsx scripts/verify-runtime-session-command-behavior.ts`：临时 SQLite、假外部 Runtime 与受控时钟验证 Core mutation/receipt 原子回滚和不可变 replay、External accepted 单次调用、四态边界、敏感正文不进入 Inbox、confirmation replay 不写 Inbox 且 TTL 后可重新取得，以及 input/resize lease 的单调序列、同序列去重、冲突/gap/过期失败关闭，最终 `quick_check=ok`。
- `pnpm exec tsx scripts/verify-git-command-behavior.ts`：临时 SQLite、临时 Artifact 根、Fastify inject 与 fake Git port 验证 confirmation 9 个请求的 Inbox 行为 0、容量/TTL/replay 有界、确认在 marker 前一次消费、accepted 1.25 MiB 结果只调用一次且 receipt 430 bytes、unknown 只调用一次并阻断重放、错误 2 KiB/脱敏及 `quick_check=ok`；输出明确 `gitProcessStarted=false`。
- `node scripts/audit-command-side-effect-entries.mjs --require-git-command-slice`：当前 203 项清单中 Git 12 条逐项被发现，9 条 external operation 为 integrated、3 条 confirmation 为 ephemeral_capability，全部 Application/Renderer/composition/Artifact/unknown marker 成立。
- `node scripts/audit-command-side-effect-entries.mjs --require-work-management-task-command-slice`：动态发现本批 7 个精确入口且全部 `integrated`；全局快照为 203 项，`183 integrated / 6 read_only / 1 handoff_control_capability / 10 ephemeral_capability / 2 read_only_external_probe / 1 diagnostic_capability / 0 pending / 0 partial`。并行纵切会改变总数，后续以脚本实时 JSON 为准。
- `node scripts/audit-command-side-effect-entries.mjs --require-complete`：当前退出 0，全部 203 项均有显式分类与所需证据；`read_only`、`ephemeral_capability`、`diagnostic_capability` 与 `handoff_control_capability` 是受治理的非耐久副作用边界，不会被误报为 integrated Command。
- `node scripts/audit-electron-main-side-effect-entries.mjs`：发现 108 个 IPC、9 个原生 action、26 个只读入口和 91 个副作用边界；普通运行为 `26 integrated / 65 platform_capability_excluded / 0 pending`，14/14 条隔离副本 startup Fence 均是 `integrated_requires_runtime_acceptance`。普通 Main Command 迁移与只读验证 Fence 是两个独立维度，不能互相冒充完成。
- `node scripts/audit-electron-main-side-effect-entries.mjs --require-complete`：当前退出 0，Main 不再有未分类 pending；平台能力排除项只因明确不适用 Command WAL 而排除，仍由动态清单约束。
- `pnpm exec tsx scripts/verify-read-only-validation-fence.ts` 与 `pnpm exec tsx scripts/verify-read-only-validation-ipc-fence.ts`：分别验证 Core 全链路只读、外部能力零调用和 Main 默认拒绝 IPC；均只使用临时数据库和假端口，不访问正式资料或外部服务。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`：静态与依赖闭包；构建通过不等于真实 Provider 故障注入已完成。
- `pnpm verify:zarch-gates` 已包含上述 Runtime 恢复、Codex/Pi Provider Command、Memory Command、Command Center Command、Codex Public Command、Work Management、Conversation、Git Command、Electron Main inventory、内部副作用、状态矩阵与事件注册表；任一动态清单出现 pending/partial/unknown，全门禁必须失败关闭。
- `pnpm verify:detached-host`：只使用临时资料根和禁用的假 Codex Provider，验证升级交接仍保持 `pending + waiting`；显式 `final_quit` 后同一请求与 turn 均为 `failed`、conversation 为 `paused`，且 `providerOutcomeUnconfirmed/recoveryRequired=true`，最终 `quick_check=ok`。该探针不替代正式 Provider 或 `Zeus Test.app` 验收。

本轮没有启动正式应用，没有访问正式数据库或 Provider，也没有创建单元测试。真实验收仍需独立 `Zeus Test.app`、独立用户数据目录，并对写出前崩溃、写出后断电、明确拒绝和 Provider 历史对账分别做故障注入。
