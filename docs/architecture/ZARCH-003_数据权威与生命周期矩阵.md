# ZARCH-003 数据权威与生命周期矩阵

## 结论

Zeus 的恢复边界必须拆成五个互不冒充的事实域：Zeus 业务 SQLite、受管资产、Provider 原生历史、项目 `/docs`、长期 Memory。代码索引、rollout 摘要、Electron 缓存和运行目录都是派生物或运行态，不得反向覆盖事实。Provider Home 只允许对应 Runtime Adapter 通过 Provider 正式接口写入、归档或删除；备份管理器只能接收 Adapter 在一致性边界内生成的允许清单或导出物，不能自行移动、改写、清理或在运行中扫描原生会话文件。

本文是目标治理契约，也是 ZARCH-042、ZARCH-060 和 ZARCH-061 的输入；它不表示当前代码已经实现数字化保留期、自动归档、一致性恢复包或远程备份。缺少已批准的数字期限时，一律不自动物理删除非缓存数据。

### 收益与代价

- 收益：同一份数据只有一个可执行 owner；备份可以区分核心、资产、Provider、文档与可重建层；任一层缺失时都有保守降级，而不是互相覆盖或伪装恢复成功。
- 收益：索引、缓存和冷摘要可以独立淘汰，业务启动与恢复不再被全部历史线性拖慢；秘密和浏览器登录状态也不会被整目录备份意外带走。
- 代价：SQLite 仍是混合物理容器时，逻辑备份分层和按表保留不能完全兑现；拆库前需要接受全库快照包含派生表的空间成本。
- 代价：Provider 的导出、归档和删除能力不一致，同一产品动作会出现 `unsupported`、`unknown` 或部分完成状态，UI、审计和运维必须真实呈现这些差异。
- 代价：引用感知 GC、墓碑、摘要校验和隔离恢复增加实现复杂度与短期磁盘占用，但这是避免误删和不可验证恢复的必要成本。

## 判定语言

### 事实级别

| 级别 | 含义 | 权威边界 |
| --- | --- | --- |
| `Z` | Zeus 业务事实 | 项目、任务、产品会话、提交、状态、授权和交付由 Zeus 决定 |
| `E` | Zeus 持久证据 | 接纳、顺序、幂等、审计、恢复和迁移证据；不等于业务聚合本身，但不得随意重建 |
| `P` | Provider 原生事实 | 原生 session/thread/turn/item 及 Provider 是否可续接由 Provider 决定 |
| `A` | 受管完整资产 | 附件、工具结果、diff、脚本等完整内容；SQLite 只保存引用、摘要和状态 |
| `M` | 长期偏好记忆 | 仅限用户偏好、安全边界和稳定工作流；不拥有当前任务、代码或运行事实 |
| `D` | 派生投影或索引 | 可由更高层事实生成；不得回写覆盖 `Z`、`E` 或 `P` |
| `R` | 运行态或缓存 | 进程、租约、下载缓存和临时文件；缺失时重新建立 |
| `Doc` | 项目文档事实 | 某个仓库的任务阶段、架构决定和验收证据，以该仓库当前 `/docs` 和 Git 历史为准 |

`Z` 与 `P` 不是同一条高低排序：Provider 决定原生历史，Zeus 决定产品会话与任务归属。冲突时保存双方证据并进入显式降级，任何一方都不能静默覆盖另一方。

### 保留期

| 代码 | 保留规则 |
| --- | --- |
| `T0` | 仅进程、租约或短 TTL；异常退出后可按恢复协议清理 |
| `T1` | 缓存期；可按容量淘汰并重新生成 |
| `T2` | 被业务对象引用期间保留；解除引用后进入可审计 GC 等待期 |
| `T3` | 随业务对象及其审计/恢复窗口保留；归档不等于删除 |
| `T4` | 随用户资料保留，直到用户明确导出、重置或永久删除 |
| `TM` | 迁移、导入或回滚窗口；窗口关闭必须留下审计结论后才能清理 |
| `TP` | 由 Provider 能力和 Provider 保留政策决定，Zeus 只记录观察结果 |

数字天数由后续容量与合规策略配置。在该策略落地前，`T2`～`T4`、`TM` 和 `TP` 都禁止无提示自动物理删除。

### 备份方式

| 代码 | 方式 |
| --- | --- |
| `B-DB` | SQLite Backup API，或停止写入并受控 checkpoint 后生成一致性快照；禁止只复制运行中的 `zeus.db` |
| `B-BUNDLE` | `B-DB` 加受管资产清单、大小和内容摘要；数据库与资产使用同一逻辑截止点 |
| `B-PROVIDER` | Runtime Adapter 调用 Provider 支持的导出，或在 Provider 已安全停写时生成允许清单快照；远程副本必须端到端加密 |
| `B-GIT` | 由项目 Git/远程仓库保存；设备恢复包仅记录仓库身份、版本和文档摘要 |
| `B-LOCAL` | 仅本机迁移回滚或诊断，不进入递归备份 |
| `B-NONE` | 不进入最低可恢复备份；缺失后重建或重新配置 |
| `B-SECRET` | 不进入普通或云端恢复包；在目标设备重新生成或由系统凭据设施恢复 |

## SQLite 逐表矩阵

下面列出当前代码创建的 88 张表。`不可`表示不能从其他本地事实无损重建；`条件`表示只有保留了指定 Provider 历史、资产或源仓库才能重建。SQLite 全库快照会物理包含全部表；标为 `B-NONE` 的表在逻辑导出、分层备份和未来拆库中可以排除。

### 存储平台、集成与运行适配器

| 表 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `schema_migrations` | 存储平台 | `E` | 不可 | `T4` | `B-DB` | 仅迁移框架；禁止用户清理 | 无法证明结构代次，停止写入并要求受控迁移/恢复 |
| `settings` | 集成与平台 | `Z` | 不可 | `T4` | `B-DB`；秘密字段不得入表或须另行脱敏 | 用户经校验的设置操作 | 使用安全默认值；Provider/远程能力保持未配置，不猜测凭据 |
| `audit_logs` | 集成与平台 | `E` | 不可 | `T3` | `B-DB` | 审计保留策略；禁止普通 UI 直接删 | 审计链出现缺口并显式标记，不能宣称操作已证明 |
| `event_log` | 集成与平台 | `E` | 不可 | `T3` | `B-DB` | 事件保留策略 | 历史投影可能不完整；业务表仍是当前状态权威 |
| `idempotency_requests` | 集成与平台 | `E` | 不可 | `T3`，至少覆盖客户端重试窗口 | `B-DB` | 幂等 GC 在无活动请求且过窗口后 | 缺失时禁止自动重放未知结果请求，要求新幂等键或人工确认 |
| `command_inbox` | 集成与平台 | `Z/E` 命令接纳与幂等身份 | 不可；不能从业务终态反推原 actor、scope 或请求摘要 | `T3`，至少覆盖命令恢复与审计窗口 | `B-DB`，随核心一致性组 | 仅命令保留策略在所有 attempt 终态且过恢复窗口后 | 缺失时停止该命令的自动派发与重放，要求新命令或人工对账 |
| `command_outbox` | 集成与平台 | `E` Provider 派发水位与 attempt | 不可；不能从 Provider 当前状态猜测是否曾写出 | `T3`，随 Inbox 与回执 | `B-DB`，随核心一致性组 | 仅 Outbox 策略在终态、无活动 lease 且过恢复窗口后 | 写出水位缺失时按 unknown 失败关闭，禁止自动新建 attempt |
| `command_delivery_receipts` | 集成与平台 | `E` 追加式四态 Provider 证据 | 条件；只有 Provider 仍保留精确原生身份时可追加对账，既有回执不可重建 | `T3`，至少覆盖命令恢复与审计窗口 | `B-DB`，随核心一致性组 | 追加写；普通更新/删除由 trigger 拒绝，过期清理由命令 owner 成组执行 | 缺失或冲突时保持 unknown 并暂停；不得用 HTTP 成功或日志冒充接纳 |
| `provider_event_receipts` | Agent Runtime | `E` | 条件；Provider 可完整重放时才可 | `T3`，至少覆盖同步/恢复窗口 | `B-DB` | Runtime Adapter 的有界 GC | 重新对账；无法证明重复时保守去重并标记历史缺口 |
| `conversation_provider_item_states` | Agent Runtime | `D/E` 有界摄取与幂等状态 | 条件；需 Provider 事件与稳定原生身份 | `TM/T3`，旧投影回滚窗口后按 Provider 水位淘汰 | `B-DB`，完整正文不进入此表 | Runtime Adapter 按已确认同步水位清理 | 摄取预览缺失但统一时间线仍可读；不得反向用此表重建 UI 正文 |
| `agent_capability_snapshots` | Agent Runtime | `D` | 可，由能力探测重建 | `T1` | `B-NONE` | Runtime Adapter 可淘汰 | 能力状态为未知，重新探测前禁用未经证明的功能 |
| `codex_usage_ledger` | Agent Runtime | `E` | 不可假定可重放 | `T3` | `B-DB` | 用量保留策略 | 用量统计显示不完整区间，不据缺失值作计费或配额结论 |
| `codex_legacy_imports` | Agent Runtime/迁移器 | `E` | 不可 | `TM` | `B-DB` + 对应本机导入备份 | 仅迁移器在验收和回滚窗口结束后 | 不重复猜测导入；要求原来源或人工确认重新导入 |
| `long_term_memories` | Memory 治理层 | `M` | 不可；禁止从任务文档或会话自动猜测重建 | `T4`，到 `review_after` 仅待核对不物理删除 | `B-DB`；远端包必须端到端加密 | 用户或 Memory Application Service 通过 supersede/tombstone；禁止普通 SQL 硬删 | 仅失去个性化偏好、安全边界和稳定工作流；任务、会话与 Provider 历史不受影响 |

### 工作管理

| 表 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `projects` | 工作管理 | `Z` | 不可 | `T4` | `B-DB` | 用户确认永久删除 | 项目元数据丢失；不得从目录名自动创建并冒充原项目 |
| `project_repositories` | 工作管理 | `Z` | 不可；路径可重新发现但归属不可猜 | `T4` | `B-DB` | 用户项目配置操作 | 仓库显示未定位，要求重新绑定并核对 Git 身份 |
| `project_shared_paths` | 工作管理 | `Z` | 不可 | `T4` | `B-DB` | 用户项目配置操作 | 共享路径不可用；不扩大到父目录或相似路径 |
| `tasks` | 工作管理 | `Z` | 不可 | `T4` | `B-DB` | 用户确认，优先软删/归档 | 任务关系与会话不得凭标题重建 |
| `task_relations` | 工作管理 | `Z` | 不可 | `T3` | `B-DB` | 用户任务关系操作 | 关系缺口显式展示，不按编号或名称推断 |
| `task_templates` | 工作管理 | `Z` | 不可 | `T4` | `B-DB` | 用户模板管理 | 不能创建新任务模板实例；已有任务不受影响 |
| `task_events` | 工作管理 | `E` | 不可 | `T3` | `B-DB` | 审计保留策略 | 当前任务仍可读，但历史变化链标记不完整 |
| `task_event_file_projection_outbox` | 工作管理 | `E` 文件投影派发水位 | 不可；不能从文件现状证明最近一次写出是否完成 | `T3`，随任务事件与投影恢复窗口 | `B-DB`；诊断文件本身为 `B-NONE` | 仅投影消费者在幂等写出并登记 accepted 后推进水位；随任务级联删除 | 缺失或 `write_started` 时从 `task_events` 整体重建文件；不得把 JSONL 反升格为事实 |
| `task_board_views` | 工作管理 | `Z` | 不可 | `T4` | `B-DB` | 用户看板设置操作 | 回退默认布局，不修改任务字段 |
| `task_board_positions` | 工作管理 | `Z` | 不可 | `T3` | `B-DB` | 用户排序操作或删除对应任务后的 GC | 使用稳定默认排序；不能把默认顺序写回为用户事实 |
| `task_environments` | 工作管理 | `Z` | 不可 | `T3` | `B-DB` | 用户环境删除；活动环境禁止直接删 | 环境进入未定位/需对账，不自动接管相似 worktree |
| `task_workspaces` | 工作管理 | `Z` | 不可 | `T3` | `B-DB` | 用户工作区回收流程 | 工作区进入缺失或孤立状态，需核对路径、分支和来源 |
| `task_integrations` | 工作管理 | `Z` | 不可 | `T3` | `B-DB` | 交付/归档流程；活动 integration 禁删 | 交付状态未知时不得重做 merge/push，要求 Git 证据对账 |
| `task_integration_attempts` | 工作管理 | `E` | 不可 | `T3` | `B-DB` | integration 审计策略 | 冲突处理链不完整；不得复用无法证明来源的现场 |

### 会话编排

| 表 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `conversations` | 会话编排 | `Z` | 不可 | `T4` | `B-DB` | 用户归档/永久删除 | Provider session 不能自动升格为产品会话 |
| `conversation_submissions` | 会话编排 | `Z` | 不可 | `T3` | `B-DB` | 只随会话永久删除；载荷不可原地改写 | 队列和未知结果不可证明，禁止自动重发 |
| `conversation_turns` | 会话编排 | `Z` | 不可 | `T3` | `B-DB` | 只随会话永久删除 | 轮次边界缺失；仅展示可证明历史，不拼接 Provider item 猜测轮次 |
| `conversation_goals` | 会话编排 | `Z` | 不可 | `T3` | `B-DB` | 用户目标操作或会话删除 | 目标模式不可恢复，回退为无活动目标而非伪造完成 |
| `conversation_goal_events` | 会话编排 | `E` | 不可 | `T3` | `B-DB` | 目标审计策略 | 目标当前态可读时仍标记事件链缺口 |
| `conversation_plan_actions` | 会话编排 | `Z/E` | 不可 | `T3` | `B-DB` | 计划动作状态机；禁止直接删未决动作 | 未决动作暂停，要求用户确认，不自动继续 |
| `conversation_execution_snapshots` | 会话编排 | `E` | 不可 | `T3` | `B-DB` | 仅随会话保留策略 | 无法证明模型、权限、工作区和路由，禁止续派发 |
| `conversation_runtime_segments` | 会话编排 | `Z/E`；保存 `P` 身份绑定而非原生内容 | 不可 | `T3` | `B-DB` | 会话状态机；原生删除另走 Provider Adapter | 无绑定则不能 native resume；可在确认后新建分段 |
| `conversation_switch_operations` | 会话编排 | `Z/E` | 不可 | `T3` | `B-DB` | 切换状态机；未决操作禁删 | 未知结果保持暂停，禁止自动重试或静默回旧分段 |
| `conversation_timeline_events` | 会话编排 | `E` | 条件；需完整来源事件 | `T3` | `B-DB` | 只随会话保留策略 | 时间线显示缺口；不影响仍可证明的业务当前态 |
| `conversation_model_history` | 会话编排 | `E` | 不可假定 Provider 可重放 | `T3` | `B-DB` | 只随会话永久删除 | Context Compiler 只能使用完整边界前的历史，并报告能力损失 |
| `cold_evidence_sources` | 会话编排/冷索引器 | `D` 来源目录 | 条件；原始 docs、rollout/history 或运行证据仍在时可重建 | `T1/T2`，按来源 owner 和引用 | `B-NONE` | 冷索引器按来源身份替换或淘汰；无权删除原始来源 | 普通会话不受影响；显式冷查前重建，不能用摘要冒充原文 |
| `cold_evidence_anchors` | 会话编排/冷索引器 | `D` 字节位置索引 | 条件；需原始来源 | `T1/T2`，随 source | `B-NONE` | 随 source 由冷索引器替换/删除 | 精确 turn/event 分页不可用；禁止退化为启动时全目录全文扫描 |
| `conversation_process_items` | 会话编排 | `D` | 条件；需原生事件和相同投影规则 | `T2/T3` | 当前随 `B-DB`；可重放后可排除 | 投影 GC，不得删除来源事实 | 仅处理过程详情不可用；消息/提交事实保持可读 |
| `conversation_portable_contexts` | 会话编排 | `D/E` | 条件；需完整模型历史 | `T2/T3` | 当前 `B-DB`；资产化后 `B-BUNDLE` | Context Compiler 的引用感知 GC | 不能跨 Provider 续接；要求重新编译或新会话 |
| `conversation_context_checkpoints` | 会话编排 | `D/E` | 条件 | `T2/T3` | `B-DB` | Context Compiler 的引用感知 GC | 从更早已证实边界重编译；不可用时禁止假装连续 |
| `conversation_tool_results` | 执行与资产 | `A` 的索引/完整性证据 | 条件；必须有对应资产 | `T2/T3` | `B-BUNDLE` | 会话删除后由资产 GC；活动引用禁删 | 保留占位和摘要，标记完整结果不可用 |
| `conversation_model_requests` | 会话编排 | `E` | 不可 | `T3` | `B-DB` | 用量/会话保留策略 | 请求和 token 统计显示缺口，不推断缺失用量 |
| `conversation_config_evidence` | 会话编排 | `E` | 不可 | `T3` | `B-DB` | 会话审计策略 | 无法证明该轮配置，恢复前重新探测且不回填旧证据 |
| `conversation_persistent_warnings` | 会话编排 | `E` | 不可 | `T3` | `B-DB` | 仅状态机解决；历史随会话保留 | 默认保守阻断相关危险操作，直到重新核验 |
| `conversation_recovery_events` | 会话编排 | `E` | 不可 | `T3` | `B-DB` | 恢复审计策略 | 恢复链标记不完整，不宣称已经安全续接 |
| `conversation_resources` | 会话编排/执行与资产 | `A` 引用与授权投影 | 条件；需来源 item 和目标资产 | `T2/T3` | `B-DB`；仅 Zeus 受管目标进入 `B-BUNDLE`，外部资源只记清单 | 引用 GC；真实目标由其 owner 删除 | 资源显示不可用或需重新授权，不扩大访问范围 |
| `conversation_sequence_counters` | 会话编排 | `D/E` 协调水位 | 可，由各有序账本最大值校验重建 | `T3` | `B-DB` | 仅仓储事务维护 | 写入前重算并校验；禁止从零继续造成序号复用 |
| `conversation_server_requests` | 会话编排 | `Z/E` | 不可 | `T3` | `B-DB` | 请求状态机；未决请求禁删 | 未决审批/工具请求保持暂停，不自动批准或拒绝 |
| `conversation_session_file_edit_grants` | 执行与资产 | `Z` 安全授权 | 不可 | `T3`，随会话；跨设备恢复须重置为禁用 | `B-DB` 但恢复时按设备安全策略失效 | 用户显式授权/撤销 | 缺失或跨设备一律视为未授权，不继承旧权限 |
| `conversation_provider_sync_checkpoints` | 会话编排 | `E/D` 同步水位 | 条件；需 Provider 完整历史 | `T3` | `B-DB` | Runtime Adapter 对账后更新 | 从已证实边界重扫；Provider 缺失则冻结为历史缺口 |
| `conversation_sync_event_streams` | Zeus Core/存储平台 | `E` 协议代次 baseline/latest 元数据 | 不可；不得从 Provider 最新状态猜测 | `T3`，覆盖同步与恢复窗口 | `B-DB`，随核心一致性组 | 同步协议状态机在无活动 consumer 且过恢复窗口后 | 无法证明 baseline、generation 与最新序号，停止增量续接并要求全量对账 |
| `conversation_sync_events` | Zeus Core/存储平台 | `E` 耐久增量事件 | 不可；Provider 原始事件不能自动等同为 Zeus 增量账本 | `T3`，随 stream 和恢复窗口 | `B-DB`，随核心一致性组 | 同步协议按已确认 consumer 水位受控 GC | 断线 consumer 无法续传；必须重新建立 baseline，禁止猜测缺失事件 |
| `conversation_store_metadata` | 会话编排/存储平台 | `E` | 不可 | `T4` | `B-DB` | 仅迁移框架 | 结构代次不可证明，停止会话写入 |
| `execution_host_handoffs` | Zeus Core/存储平台 | `E` 升级交接状态与派发闸门 | 不可 | `TM/T3`，至少覆盖交接恢复与审计窗口 | `B-DB` | 仅 Core 交接状态机；活动或 `recovery_required` 禁删 | 缺失时无法证明旧 Core 已完成排空，保持派发关闭并要求恢复 |
| `execution_host_handoff_requests` | Zeus Core/存储平台 | `E` Codex 待回复请求 CAS 快照 | 不可 | `TM/T3`，随交接账本 | `B-DB` | 仅 Core 交接状态机；恢复完成前禁删 | 任一身份、turn 或 updatedAt 不匹配都不续接，相关会话转 `paused/recovery_required` |
| `conversation_migration_mappings` | 存储平台/会话迁移器 | `E` | 不可 | `TM`，至少覆盖降级与审计期 | `B-DB` | 仅迁移器在验收后清理 | 禁止重复迁移；要求来源哈希或人工对账 |
| `conversation_legacy_write_fence` | 存储平台/会话迁移器 | `E` | 不可安全猜测 | `TM` | `B-DB` | 仅迁移框架 | 默认关闭旧 writer，拒绝降级写入 |
| `conversation_legacy_cutover_metadata` | 存储平台/会话迁移器 | `E` 候选迁移回执 | 不可；来源摘要、映射摘要和回退身份必须共同证明 | `TM`，至少覆盖旧结构回退窗口 | `B-LOCAL/B-DB`，只存在候选或已提升代次 | 仅切换管理器在回退窗口关闭后清理 | 回执缺失或摘要不符则拒绝提升，继续使用已核验回退库 |
| `conversation_items` | 会话编排旧兼容层 | `D` | 条件 | `TM`，统一时间线验收后退役 | 当前随 `B-DB`；不得作为独立恢复源 | 仅迁移器退役 | 新结构可用时忽略；不得用旧投影覆盖统一账本 |
| `conversation_messages` | 会话编排旧兼容层 | `D` | 条件 | `TM`，统一模型历史验收后退役 | 当前随 `B-DB`；不得作为独立恢复源 | 仅迁移器退役 | 新结构可用时忽略；缺失不触发 Provider 历史改写 |
| `conversation_message_provider_aliases` | 会话编排旧兼容层 | `D/E` 用户逻辑消息与 Provider item 别名 | 条件；需客户端消息身份或 Provider item 身份 | `TM/T3`，随对应会话消息 | `B-DB`；不得脱离消息行单独恢复 | 只随会话/消息保留策略；禁止为满足唯一索引破坏性去重 | 缺失时仍显示逻辑消息，但重复 Provider 回显可能无法稳定并入同一条；重建只允许按已存原生身份追加别名 |

### 执行、资产与命令

| 表 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `runtime_sessions` | 执行与资产 | `E` | 不可无损重建；活动进程可对账 | `T3` | `B-DB` | 运行状态机；历史按执行保留策略 | 恢复后所有非终态先标记待对账，不凭旧 PID 接管进程 |
| `runtime_logs` | 执行与资产 | `E` | 不可 | `T2/T3`，受日志容量策略约束 | `B-DB` 或诊断导出 | 日志保留策略 | 会话可恢复但日志区间标记缺失 |
| `terminal_events` | 执行与资产 | `E` | 不可 | `T2/T3` | `B-DB` 或诊断导出 | 终端事件保留策略 | 终端回放不完整；不改变命令终态 |
| `command_definitions` | 执行与资产 | `Z` | 不可 | `T4` | `B-DB` | 用户命令管理 | 命令不可运行；不得从历史命令文本自动恢复授权定义 |
| `command_aliases` | 执行与资产 | `Z` | 不可 | `T4` | `B-DB` | 用户命令管理 | 别名不可解析，要求选择完整命令定义 |
| `command_runs` | 执行与资产 | `E` | 不可 | `T3` | `B-DB` | 运行记录保留策略 | 未终态运行先对账；禁止自动重跑 |
| `command_artifacts` | 执行与资产 | `A` 引用 | 条件；需对应文件 | `T2/T3` | `B-BUNDLE` | 运行删除后资产 GC | 保留记录并标记产物不可用 |
| `git_snapshots` | 执行与资产 | `E/D`；某时点 Git 观察 | 条件；源仓库和对象仍在时可重扫 | `T2/T3` | `B-DB`；仓库本身不由 Zeus 备份 | Git 证据保留策略 | 当前仓库需重新扫描；历史 SHA 缺失时禁止宣称交付完成 |
| `git_changes` | 执行与资产 | `E/D`；某时点变更观察 | 条件 | `T2/T3` | `B-DB` | Git 证据保留策略 | 变更投影不可用；不得据此自动修改工作区 |
| `turn_change_sets` | 执行与资产 | `Z/E` + `A` 内容 | 条件；需 journal/diff 资产 | `T2/T3` | `B-BUNDLE` | 用户撤销/应用流程；会话删除后 GC | 仅审查/撤销能力降级，禁止用不完整 diff 进行恢复 |
| `turn_change_files` | 执行与资产 | `E/A` 文件级索引 | 条件；需变更集和资产 | `T2/T3` | `B-BUNDLE` | 随变更集 | 文件项标记不可用，不猜测前后镜像 |
| `artifact_objects` | 执行与资产 | `A/E` 内容身份、编码和状态证据 | 条件；需摘要匹配的对象文件 | `T2/T3` | `B-BUNDLE` | Artifact Store 状态机；活动 owner 禁删，GC 必须先隔离 | 保留对象元数据并标记 `damaged`/缺失；禁止用同名文件冒充原对象 |
| `artifact_owners` | 执行与资产 | `Z/E` 资产引用关系 | 不可；不能从目录或历史正文猜测 owner | `T2/T3`，随业务引用 | `B-DB`，并约束 `B-BUNDLE` 清单 | 仅业务 owner 生命周期或显式解除引用 | owner 关系未知时停止 GC，保留孤立对象等待对账 |
| `artifact_staging_operations` | 执行与资产 | `R/E` 提升与故障恢复证据 | 条件；需 staging 文件和对象摘要 | `T0/TM`，直至提升或隔离结论 | `B-DB`；在途文件仅本机恢复 | Artifact Store 恢复流程在摘要核对后收敛 | 重新核对 staging 与对象目录；无法证明时隔离，不自动发布 |
| `artifact_gc_manifests` | 执行与资产 | `E` 删除批次、策略和确认摘要 | 不可 | `T3`，至少覆盖资产恢复/审计窗口 | `B-DB` | 两阶段 GC 状态机；隔离期前禁止物理删除 | 缺失时取消删除流程并保留隔离对象，不重建清单后继续删 |
| `artifact_gc_manifest_items` | 执行与资产 | `E` 对象级 GC 审计与隔离状态 | 不可 | `T3`，随 GC 清单 | `B-DB` | 两阶段 GC 状态机逐项核对 owner 与摘要 | 无法证明逐项状态时停止整批删除，保留对象和隔离副本 |
| `artifact_retention_holds` | 执行与资产 | `Z/E` 资产保留约束 | 不可从对象目录猜测 | `T2/T4`，随业务 owner、导出或恢复窗口 | `B-DB`，约束 `B-BUNDLE` | 仅 owner 生命周期服务显式释放；活动 hold 禁止 GC | hold 缺失或状态不明时停止删除，保守保留对象等待对账 |
| `artifact_capacity_samples` | 执行与资产 | `D` 容量趋势采样 | 可，由当前对象与后续采样重建 | `T1`，有界滚动 | `B-NONE` | Artifact 诊断按容量窗口淘汰 | 仅增长速率不可用；配额、owner 和对象事实不受影响 |
| `artifact_storage_faults` | 执行与资产 | `E` 外部写入故障诊断 | 不可完整重建 | `T2/T3`，至少覆盖故障恢复审计窗口 | `B-DB` 或诊断导出 | 故障状态机解决后按审计策略清理 | 无法判断外部文件失败阶段；保持相关资产不可用并禁止冒充 SQLite 故障 |

### 代码智能

| 表 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `code_symbols` | 代码智能 | `D` | 可，由源代码重扫 | `T1` | `B-NONE` | 索引器按项目/代次淘汰 | 标记索引缺口并后台重扫；无结果不等于无符号 |
| `project_nodes` | 代码智能 | `D` | 可 | `T1` | `B-NONE` | 索引器 | 图谱不可查询，业务项目不受影响 |
| `project_edges` | 代码智能 | `D` | 可 | `T1` | `B-NONE` | 索引器 | 关系查询降级并重建 |
| `graph_views` | 代码智能 | `D` | 可；当前扫描会整体重写 | `T1` | `B-NONE` | 索引器 | 视图重新生成；不得解释为用户项目被删除 |

## 独立派生数据库逐表矩阵

下列 11 张表创建在 create-only `*.index.candidate.db` / `*.cache.candidate.db`，通过核验后可由独立 runtime 提升为活动 `index.db/cache.db`。它们不计入上面 88 张 Core 表，也不属于 `B-DB` 核心一致性组。每个库必须携带 source identity、generation、publication state 和 event waterline；校验失败、来源漂移、损坏或丢失时整库丢弃并后台重建，绝不能反向覆盖 Core。

| 表 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `projection_metadata` | 投影索引器 | `D` 候选身份 | 可，由 Core 身份和构建参数重建 | `T1` | `B-NONE` | 投影索引器；仅候选文件整体淘汰 | 索引候选作废，回退 Core 有界查询并重建 |
| `conversation_search_documents` | 投影索引器 | `D` 会话检索投影 | 可，由 Core 会话表重建 | `T1` | `B-NONE` | 投影索引器按 generation 整体替换 | 会话搜索降级，不改变会话事实 |
| `conversation_search_fts` | 投影索引器 | `D` 全文索引 | 可，由 `conversation_search_documents` 重建 | `T1` | `B-NONE` | 投影索引器 | 全文搜索暂不可用或回退受限前缀查询 |
| `conversation_turn_documents` | 投影索引器 | `D` 轮次检索投影 | 可，由 Core 轮次表重建 | `T1` | `B-NONE` | 投影索引器按 generation 整体替换 | 轮次搜索/筛选降级，不拼写替代轮次 |
| `conversation_projection_watermarks` | 投影索引器 | `D` 来源水位副本 | 可，由 Core 序列账本读取 | `T1` | `B-NONE` | 投影索引器 | 无法证明新鲜度时整个投影不可发布 |
| `graph_node_documents` | 投影索引器 | `D` 图节点搜索文档 | 可，由 Core 派生图重建 | `T1` | `B-NONE` | 投影索引器 | 图搜索降级；项目和源代码事实不受影响 |
| `graph_edge_documents` | 投影索引器 | `D` 图边搜索文档 | 可，由 Core 派生图重建 | `T1` | `B-NONE` | 投影索引器 | 关系搜索降级并异步重建 |
| `code_symbol_documents` | 投影索引器 | `D` 符号搜索文档 | 可，由 Core 代码索引重建 | `T1` | `B-NONE` | 投影索引器 | 符号检索显示索引缺口，不解释为无符号 |
| `projection_gaps` | 投影索引器 | `D` 候选覆盖缺口 | 可，由本次构建能力探测重建 | `T1`，随候选 | `B-NONE` | 投影索引器随候选整体删除 | 缺失时不得发布候选，重新执行全量构建核对 |
| `cache_metadata` | 缓存管理器 | `R` 候选身份 | 可 | `T0/T1` | `B-NONE` | 缓存管理器 | cache 候选整体作废并重建 |
| `cache_entries` | 缓存管理器 | `R` 有 TTL 的缓存 | 可，由权威查询重新填充 | `T0/T1` | `B-NONE` | 缓存管理器按 TTL/容量或 generation 整体清理 | 缓存未命中并回源；不得把缺失解释为业务数据不存在 |

## `.zeus` 分层目录矩阵

路径均相对 `<ZEUS_ROOT>`。当前 canonical 布局在根身份标记 `.zeus-root-identity.json` 之外，一级目录只有 `data/`、`artifacts/`、`providers/`、`backups/`、`runtime/`、`profile/`。旧平铺布局只用于升级期间识别和连接旧宿主，不能初始化新资料目录，也不能成为新备份清单的路径来源。

### 一级目录

| 目录 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `.zeus-root-identity.json` | Desktop 启动/数据根治理 | 持久运行身份 | 不可根据目录内容猜测重建 | 数据根生命周期 | 本机恢复清单记录身份与目标采用决策；不作为多设备同步数据 | 只有显式离线 adoption/重置流程 | 缺失且数据根非空时失败关闭；不按路径或同 UID 猜测 profile |
| `data/` | Zeus/存储平台 | `Z/E` | 不可 | `T4` | `B-DB` + 配置允许清单 | 仅业务删除、迁移和受控重置 | 核心只读或停止启动；不得用 Provider 历史自动造库 |
| `artifacts/` | 执行与资产/Browser | `A` | 多数不可 | `T2/T3` | `B-BUNDLE` | 引用感知 GC 或用户高影响删除 | 保留元数据和缺失状态，按摘要恢复 |
| `providers/` | 各 Provider Runtime Adapter | `P/M` 及 Provider 配置 | 原生历史不可 | `TP/T4` | `B-PROVIDER` 允许清单 | Provider 正式接口；Zeus 禁止直接移动/删原生会话 | Provider 能力降级，Zeus 业务库仍可只读 |
| `backups/` | 备份/迁移管理器 | 回滚副本，不是新事实源 | 取决于来源 | `TM` 或配置的备份保留期 | `B-LOCAL`；新备份必须排除自身 | 备份管理器 + 用户确认 | 无本机回滚点；不影响当前事实但提高恢复风险 |
| `runtime/` | 本机执行核心 | `R` | 可 | `T0/T1` | `B-NONE` | owner 在租约核对后清理 | 重建运行态；未决副作用先对账 |
| `profile/` | Electron/Browser | `R` 或浏览器设备状态 | 缓存可；登录状态不可 | `T1/T4` | 默认 `B-NONE`；浏览器状态仅独立、明确授权的加密设备迁移 | 缓存可清；登录/授权须高影响确认 | 重新登录或重新建立缓存，不影响 Zeus 业务事实 |

非空无 marker 的自定义根不属于自动恢复：只能使用 `data-root:adopt-offline`，显式提供 canonical root、production/Test profile 与固定 distribution label，经 plan token 二次确认后发布 marker。该流程保留既有业务目录，但要求单一 Zeus 布局证据、全树无 symlink/hardlink/特殊文件、Execution Host 目录为空、SQLite sidecar 缺席且未观察到打开句柄；不删除或修复任何残留。收益是旧自定义根有了可审计迁移出口；缺点是全树 inventory/`lsof` 随文件数增长，且观察结果不是抵抗同 UID 竞态的排他证明。

### `data/` 与 `artifacts/`

| 路径 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `data/zeus.db` 及活动 `-wal`/`-shm` | 存储平台 | `Z/E/D` 混合容器 | 核心不可 | `T4` | `B-DB`；绝不单拷活动主文件 | 数据库恢复/迁移流程 | `quick_check`、schema 代次或清单失败则隔离且只读，不覆盖原库 |
| `data/zeus.config.json` | 集成与平台 | `Z` 配置 | 不可 | `T4` | 加密允许清单；秘密字段排除 | 用户设置/受控重置 | 使用安全默认值并要求重新配置 |
| `data/projections/index.db` / `cache.db` 及 active/previous/candidate | 投影索引器/缓存管理器 | `D/R` | 可，由 Core 水位与项目事实重建 | `T0/T1` | `B-NONE` | 投影 runtime 按 generation 切换/回退/清理 | 读取安全返回空/缺口并后台重建，Core 任务和会话继续可用 |
| `data/logs/local-server/` | 本机执行核心 | `E/R` 诊断日志 | 不可但非业务权威 | `T2`，容量有界 | 默认不进核心恢复包；诊断导出可选 | 日志策略 | 诊断证据缺口，不影响业务表当前态 |
| `data/conversation-attachment-grant.secret` | 安全平台 | 设备秘密 | 不应跨设备重建原值 | 设备资料生命周期 | `B-SECRET` | 安全重置流程 | 重新生成，既有附件 grant 全部失效并要求重新授权 |
| `artifacts/task-attachments/` | 工作管理/执行与资产 | `A` | 不可 | `T2/T3` | `B-BUNDLE` | 任务永久删除后引用 GC | 附件标记缺失，任务正文仍可读 |
| `artifacts/conversation-attachments/` | 会话编排/执行与资产 | `A` | 不可 | `T2/T3` | `B-BUNDLE` | 会话永久删除后引用 GC | 附件不可读；不删除对应提交/消息 |
| `artifacts/conversation-tool-results/` | 执行与资产 | `A` | 不可假定 Provider 可重放 | `T2/T3` | `B-BUNDLE` | 工具结果引用 GC | 仅投影可读，完整结果明确不可用 |
| `artifacts/browser-comments/` | Browser | `A/Z` 用户批注 | 不可 | `T2/T3` | `B-BUNDLE` | 用户删除或引用 GC | 批注缺失；目标页面本身不受影响 |
| `artifacts/browser-downloads/` | Browser | `A` | 不可保证原站可重下 | `T2`，按容量且须用户可见 | 默认可选 `B-BUNDLE` | 用户下载管理；禁止静默清空 | 标记本地文件缺失，可提示重新下载但不自动访问外站 |
| `artifacts/turn-change-sets/` | 执行与资产 | `A/E` | 不可 | `T2/T3` | `B-BUNDLE` | 变更集 GC | 撤销/重应用禁用，保留审计占位 |
| `artifacts/runtime-sessions/` | 执行与资产 | `A/E` 运行现场 | 不可无损重建 | `T2/T3` | 按恢复需求 `B-BUNDLE`，大日志可分层 | 执行保留策略 | 历史回放降级；活动会话先做进程对账 |
| `artifacts/command-scripts/` | 执行与资产 | `A/E` 已授权脚本 | 不可 | `T2/T3` | `B-BUNDLE` | 运行记录和授权策略 | 不允许从日志拼回脚本并执行 |
| `artifacts/command-runs/` | 执行与资产 | `R/E` 运行派生物 | 当前登记表标记可重建 | `T2` | 默认 `B-NONE`，诊断可选 | 执行保留策略 | 运行详情缺失；绝不自动重跑命令 |

### Provider Home 与 Memory/rollout

| 路径 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `providers/codex/` | Codex Runtime Adapter / Codex | `P/M/R` 混合容器 | 不可整体重建 | `TP/T4` | 只能按子项允许清单 `B-PROVIDER`，禁止整目录盲备 | Codex 正式接口；Zeus 只管理启动参数和绑定 | Codex 不可用时产品会话仍可只读，派发暂停 |
| `providers/codex/sessions/**/rollout-*.jsonl` | Codex | `P` 原生事件日志 | 不可 | `TP` | Codex 安全停写/支持导出后的 `B-PROVIDER` | Codex 归档/删除接口；Zeus 禁止直接改文件 | 不能 native resume；仅可用 Zeus 已证实历史新建分段 |
| `providers/codex/archived_sessions/` | Codex | `P` 归档历史 | 不可 | `TP` | 同上 | Codex | 归档会话原生回看/恢复不可用 |
| `providers/codex/memories/memory_summary.md` 与显式记忆载荷 | Codex；作为 Provider 专属候选而非 Zeus 长期记忆权威 | `P/M` | 不可完全从会话重建 | `TP/T4`，由 Codex 能力与用户操作决定 | 经 Codex 一致性边界的 `B-PROVIDER` 允许清单，不与原生会话混为一份 | Codex/用户；Zeus 禁止直接改写或从当前任务自动扩写 | Codex 个性化能力下降；`long_term_memories`、任务、会话和 Provider 历史本身不受影响 |
| `providers/codex/memories/skills/`、`extensions/` | Memory 治理层 | `M` 稳定工作流/显式扩展 | 不可 | `T4` | 独立加密允许清单 | 用户明确安装、更新或撤销 | 对应工作流不可用，回退项目当前指令和内置能力 |
| `providers/codex/memories/MEMORY.md` | Memory 治理层 | `D` 导航注册表 | 条件；可从记忆载荷重建但顺序/注释可能丢失 | `T4` | 可随 Memory 允许清单 | Memory 索引器；不得删除被索引载荷 | 降级为直接检索记忆载荷，启动/检索可能变慢 |
| `providers/codex/memories/rollout_summaries/` | Memory 冷索引器 | `D` 冷摘要/证据定位，不是 raw rollout | 条件；需原生 JSONL 且摘要器可用 | `T2/T3` | 可选；最低恢复包可排除 | 冷索引器引用感知 GC | 有 raw rollout 时异步重建；没有 raw 时保持缺口，不伪造摘要 |
| `providers/codex` 下配置、rules、prompts、skills、plugins | Codex | Provider 配置/扩展 | 部分不可 | `T4` 或版本生命周期 | 非秘密配置可进加密允许清单；凭据、OAuth token、私钥排除 | Codex 或用户显式管理 | 重新配置/安装；不得从日志恢复秘密 |
| `providers/codex` 下 cache、tmp、locks、daemon/control、shell snapshots 等 | Codex | `R` | 可 | `T0/T1` | `B-NONE` | Codex 在租约核对后清理 | 重建；旧锁不能当活动会话事实 |
| `providers/pi/config/` | Pi Runtime Adapter / Pi | Provider 配置 | 部分不可 | `T4` | 非秘密允许清单 `B-PROVIDER`；凭据排除 | Pi/用户显式配置 | Pi 暂停派发并要求重新配置 |
| `providers/pi/sessions/` | Pi | `P` | 不可 | `TP` | Pi 安全停写/支持导出后的 `B-PROVIDER` | Pi 正式接口；Zeus 禁止直接删 | 不能 Pi native resume；可在确认后新建分段 |

长期 Memory 只保存用户偏好、安全边界和稳定工作流。任务编号、阶段事实、当前路径、代码结构、运行状态和验收结论必须回到项目 `/docs`、代码、Git 或 Zeus 业务库；Memory 中的旧内容与这些当前事实冲突时必须降权为“可能过时的提示”，不能进入 Context Compiler 的权威层。

### 备份、运行与 Profile

| 路径 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `backups/imports/codex-legacy/` | Codex 迁移器 | 导入来源副本 | 不可 | `TM` | `B-LOCAL`；恢复包记录摘要即可 | 迁移验收和回滚窗口后由迁移器 + 用户确认 | 不能回滚/复核旧导入，禁止自动再导入 |
| `backups/imports/codex/` | Zeus/Codex 迁移器 | 配置导入回滚副本 | 不可 | `TM` | `B-LOCAL` | 迁移器 + 用户确认 | 不能回滚导入配置，要求重新配置 |
| `backups/database/` | 备份管理器 | 既有 DB 回滚点 | 不可 | 配置的备份保留期 | 不递归收入新备份；每份单独清单 | 备份管理器按保留策略 + 用户可见 | 可恢复点减少；当前 DB 不受影响 |
| `backups/database/zeus.db.pre-native-sqlite.bak` | 存储迁移器 | 迁移前回滚点 | 不可 | `TM` | `B-LOCAL` | 迁移验收并关闭回滚窗口后 | 无法回退原格式，后续迁移必须另建新快照 |
| `runtime/migrations/` | 迁移器 | `R/E` 在途状态 | 条件 | `T0/TM` | `B-NONE`；完成结论写入 DB/清单 | 迁移器 | 检查 DB 与备份清单后恢复或隔离，禁止猜测完成 |
| `runtime/quarantine/` | 迁移/恢复管理器 | 隔离证据 | 不可假定可丢 | `TM` | `B-LOCAL` | 用户确认或恢复验收后 | 丢失隔离样本会降低诊断/人工恢复能力 |
| `runtime/execution-host/` | 本机执行核心 | `R` | 可 | `T0` | `B-NONE` | 当前 owner 核对租约后 | 重新建立 socket/lease；业务写入前做未决操作对账 |
| `runtime/updates/` | 发布更新器 | `R` 下载/候选缓存 | 可重新下载 | `T1` | `B-NONE` | 更新器 | 重新下载并重新验签，不影响当前安装 |
| `profile/browser/state.json` | Browser | 设备浏览状态 | 部分不可 | `T4` | 默认 `B-NONE`；设备迁移需单独授权和加密 | Browser/用户高影响重置 | 标签/状态重建或丢失；不影响 Zeus 业务事实 |
| `profile/electron/Cache/` | Electron | `R` | 可 | `T1` | `B-NONE` | 系统/用户普通清缓存 | 重新下载网页与接口缓存，不退出登录 |
| `profile/electron/Partitions/` | Browser | 站点登录、cookie、授权等设备状态 | 不可 | `T4` | 默认 `B-NONE`；不得混入业务恢复包 | 独立高影响确认 | 网站退出登录、站点授权丢失；要求重新认证 |

## 项目 `/docs` 边界

| 路径/对象 | Owner | 级别 | 可重建性 | 保留期 | 备份 | 删除权限 | 恢复或缺失降级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `<PROJECT_ROOT>/docs/` | 当前项目/任务 owner | `Doc` | 不可从 Memory 或 Provider 历史无损重建 | 随项目 Git 历史 | `B-GIT`；设备恢复包只记录 repo、commit、dirty 状态和摘要 | 项目 Git/用户；Zeus Memory 禁止修改其权威性 | 从 Git 恢复；缺失时任务阶段和决定标记未知，不用 Memory 猜测 |
| `<PROJECT_ROOT>/CONTEXT.md`、`docs/contexts/**` | 领域模型 owner | `Doc` | 不可 | 随项目 Git 历史 | `B-GIT` | 架构变更流程 | 回退代码中的当前契约与人工审查，禁止用旧 rollout 覆盖 |
| 仓库外代码、worktree 与 Git objects | 用户/Git | 外部事实 | Zeus 不负责重建 | 由用户/Git 策略决定 | 不进 `.zeus` 恢复包；只记录稳定身份和待处理 dirty 证据 | 用户/Git | 重新定位或克隆；脏工作区缺失时必须报告不可恢复 |

项目文档可以引用 rollout ID、Provider 原生身份或资产摘要，但不得复制整份原生日志作为文档事实。相反，rollout 摘要可以索引 `/docs`，但不能覆盖其最新版本。

## 一致性组与恢复顺序

1. **Zeus 核心一致性组**：用 `B-DB` 固定逻辑截止点，并把该截止点引用的 `artifacts/` 生成内容清单、大小和摘要。缺任一必要资产时恢复为“部分可用”，不删除数据库引用。
2. **Provider 一致性组**：分别对 Codex、Pi 执行 `B-PROVIDER`。Provider 未能停写、无导出能力或清单校验失败时，核心备份仍可完成，但必须标记 `provider_history_incomplete`。
3. **Memory 一致性组**：仅导出长期偏好记忆允许清单；不自动打包 task docs、raw rollout、Provider credential 或缓存。远程副本必须端到端加密。
4. **项目文档一致性组**：记录各 repo 的远程身份、commit、分支和 dirty 状态；实际 `/docs` 由 Git 恢复。未提交文档必须作为未覆盖风险显式列出，不能假装已备份。
5. **派生层**：代码索引、图谱、rollout 摘要、能力快照、Electron cache 和 `runtime/` 不阻塞最低恢复包；恢复后异步重建，并在完成前展示明确降级。

恢复必须进入新的隔离资料目录，依次校验恢复包清单与摘要、数据库 `quick_check`、schema 代次、资产引用、Provider 身份可用性，最后才允许提升为可写资料。任何校验失败都不能覆盖现有正式资料目录。

## 归档、导出与永久删除协议

### 归档

- Zeus 先在业务库记录产品对象归档状态；归档不触发资产 GC，也不等同于 Provider 原生归档。
- 若 Provider 支持归档，由 Runtime Adapter 使用正式接口执行并保存接纳证据。Provider 失败或结果未知时，Zeus 保留 `provider_archive_pending`/`provider_archive_unknown` 降级，不直接移动 JSONL。
- `/docs` 和 Memory 不随产品会话归档：任务文档按项目 Git 管理，长期偏好按用户资料管理。

### 导出与备份

- 导出先冻结逻辑截止点，再生成数据库快照、资产清单和 Provider 子清单；每个子清单独立声明完整、缺失或不支持。
- 任何远程目的地只接收端到端加密后的恢复包；明文凭据、OAuth token、私钥、授权 secret、cache、locks 和递归 `backups/` 永不进入恢复包。
- “备份完成”只表示清单内项目已校验，不得把 Provider 未导出、Git dirty 文档或缺失资产隐藏为成功。

### 永久删除

- 用户必须分别确认 Zeus 业务对象、受管资产、Provider 原生历史、Memory 和项目文档的范围；一个范围的确认不外溢到另一个范围。
- 先在 Zeus 事务中写删除意图/墓碑，再等待引用检查和恢复窗口，最后由 owner 执行物理删除。资产 GC 只能删除引用计数为零且超过等待期的内容。
- Provider 历史只能由 Runtime Adapter 调用 Provider 删除接口。Provider 不支持、拒绝或结果未知时记录 `provider_retained`/`provider_delete_unknown`，不能通过删目录伪装成功。
- 删除索引、cache 和已核对的过期 runtime 可以自动进行；删除日志、备份、浏览器登录状态、迁移隔离区和任何 `Z/E/P/A/M/Doc` 数据都需要对应策略或明确确认。

## 关键缺失组合的降级规则

| 现场 | 必须行为 | 禁止行为 |
| --- | --- | --- |
| DB 在，Provider 原生历史缺失 | 产品任务和会话可读；分段标记 `native_history_missing`；仅用已证实模型历史/便携上下文在用户确认后开新分段 | 假装 native resume 成功；自动重发未知提交 |
| Provider 原生历史在，DB 缺失 | 提供受控“导入为新产品会话”流程，并要求选择项目/任务和核对原生身份 | 扫描 Provider Home 后自动造项目、任务或覆盖新 DB |
| DB 在，资产缺失 | 保留引用、摘要和缺失状态；按清单从备份恢复 | 把空内容当真实结果；清理引用掩盖缺失 |
| raw rollout 在，rollout summary 缺失 | 冷索引异步重建；热路径只读取有界窗口 | 把 summary 当原生历史；启动时全量扫描所有 JSONL |
| rollout summary 在，raw rollout 缺失 | 摘要只作可能过时的只读提示，并标记无法回溯 | 用摘要声称 Provider 已接纳、完成或可续接 |
| `/docs` 缺失，Memory 仍在 | 从 Git 定位；任务阶段标记未知 | 用长期偏好记忆重建任务事实或当前路径 |
| Memory 缺失，DB/docs/raw rollout 在 | 正常工作，仅失去个性化偏好和稳定工作流提示 | 把 Memory 缺失解释为会话或任务丢失 |
| 索引或 cache 缺失 | 异步重建并展示索引缺口 | 以“零结果”表示源代码没有内容 |
| 磁盘满或恢复校验失败 | 切到只读、停止新派发和副作用，保留现场并报告可释放的 `R/D` 类空间 | 自动删 `Z/E/P/A/M/Doc` 或旧备份来腾空间 |

## 当前实现差距与后续门禁

- `zeusDataLayout` 已固定六个一级目录、owner、粗粒度 lifecycle 和可重建性；Artifact Store、核心恢复包和故障只读态已覆盖首批可执行策略。Provider 导出允许清单、精确数字保留期和全部历史附件迁移仍需按真实产品数据迭代。
- 产品代码图谱和缓存读写已迁入独立 `index.db/cache.db`；Core 仍保留同名可重建表作回退窗口/候选初始来源，但它们不再是产品图读写的运行时依赖。全库物理备份在旧表窗口关闭前仍会携带这些 `D` 表。
- `conversation_items`、`conversation_messages` 与统一会话账本并存；它们只属于迁移兼容层，不能再成为新 UI 或恢复流程的事实源。
- 新写入的完整工具结果、命令日志、大 diff 和大型便携上下文已统一为可校验 `ArtifactRef`；数据库只保留有界投影/摘要/授权句柄。恢复包仍必须同时携带 owner 账本和摘要匹配的 CAS 对象，不能只备份任一侧。
- Codex Provider Memory 当前物理位于 Provider Home；Zeus 自有 `long_term_memories` schema 已建立，但桌面管理 UI、显式导入/核对和真实派发接入尚未完成。两者不能静默互相覆盖，备份器也不能因 Provider memory、导航索引、rollout 冷摘要与 raw rollout 同目录就整树复制。
- 长期 Memory 墓碑、Artifact 两阶段 GC、客户端加密恢复包和用户选择目录副本已有基础实现；数字保留期、容量上限、自动调度和全量业务 owner 接入仍待完成。真实云端账号、上传、冲突与删除协议属于已暂停的 ZARCH-063 多设备同步产品能力，不再列作本轮恢复任务。此前仍只允许自动清理明确的 `R/D` 缓存，且必须先核对 owner 与活动租约。

## 证据入口

- 分层目录与登记表：`packages/local-server/src/zeusDataLayout.ts:17-78`、`:84-131`、`:134-177`、`:192-226`。
- Storage 主 schema：`packages/storage/src/index.ts:1780-3053`。
- 统一会话 schema：`packages/storage/src/conversationExecutionStore.ts:239-454`。
- 长期记忆治理：`packages/storage/src/longTermMemoryStore.ts`。
- 冷证据目录与锚点：`packages/storage/src/coldEvidenceStore.ts`、`packages/local-server/src/contextSourceCatalog.ts`。
- 耐久同步事件：`packages/storage/src/conversationSyncEventStore.ts`。
- 内容寻址资产与两阶段 GC：`packages/storage/src/artifactStore.ts`。
- 一致性恢复包与客户端加密副本：`packages/storage/src/recoveryBackup.ts`、`packages/storage/src/recoveryBackupReplication.ts`。
- 命令 schema：`packages/storage/src/commands.ts:114-173`。
- 可重建代码图谱 cache：`packages/local-server/src/index.ts:22318-22373`。
- 上下文所有权：`docs/contexts/*/CONTEXT.md`。
- 2026-08-21 只读核对的当前 Codex Home 目录事实：存在 `sessions/**/rollout-*.jsonl`、`archived_sessions/`、`memories/` 与 `memories/rollout_summaries/*.md`；本次只核对路径和文件类型，未读取或修改正式 Provider 会话内容。
