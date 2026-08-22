# ZARCH-050～052 Memory 与上下文治理

## 结论与实施状态

P5 已建立三个彼此独立的核心能力：Zeus 可治理的稳定长期记忆、确定性的 Context Compiler，以及 `/docs` 优先且不复制原文的冷证据目录。它们遵守 Provider 与 Zeus 双层事实源：Provider 继续拥有原生 session、turn、item 和 raw rollout，Zeus 只保存业务事实、受控长期记忆与可重建冷索引；本实现没有新增第三份完整会话 JSONL。

当前完成的是存储、领域规则、文件边界、纯编译器、受本机鉴权保护的 Memory 管理 API、桌面端真实“设置 → 长期记忆”入口，以及 Codex/Pi submission 派发接线。UI 以独立 Memory client/query store/controller 接入 `/api/memory*`，支持 global/project keyset 分页、显式新增、supersede 修正和 tombstone 停用/删除，并展示 review_due、superseded、tombstone、来源、确认等级与置信度。三个写入口直接接收统一 Command Envelope，并把业务 mutation 与 accepted receipt 放进同一 SQLite 耐久事务；Context preview 仍是明确的只读端口。每次真实 Provider 写出前由 `ContextDispatchApplicationService` 编译并审计上下文指纹，Codex 使用 application/untrusted additional context，Pi 使用 SDK application/untrusted context。2026-08-22 已在独立 `Zeus Test` 根中使用用户授权的正式 1xm 配置与 Keychain 凭据副本完成真实 Pi 回复及原生 JSONL 冷索引；正式数据库和正式 Provider Home 没有被迁移、改写或索引。

## 所有权与事实优先级

| 对象 | Owner | 事实等级 | 默认进入上下文 | 缺失或冲突处理 |
| --- | --- | --- | --- | --- |
| `/docs` 当前主任务文档 | 当前项目/任务 | `Doc` | 是，受任务文档预算限制 | 报告 `primary_task_document_missing/excluded`；不用 Memory 或 rollout 猜测 |
| `long_term_memories` | Zeus Memory 治理层 | `M` | 仅未过核对期且确定选中的 head | 到达 `review_after` 后保留但不注入；项目 scope 覆盖全局 scope |
| Zeus 已证实模型历史/便携上下文 | 会话编排 | `E/D` | 按会话历史预算，以不可信载荷交给 Adapter | 水位不完整时只使用已证实边界，不伪装连续 |
| Provider raw rollout/history | Provider | `P` | 否 | 只有显式冷查才按锚点读取；索引摘要不能证明接纳或完成 |
| `cold_evidence_sources/anchors` | Zeus 冷索引器 | `D` | 否，除非调用方显式允许且分配预算 | 原文件仍在时重建；hash 不符则拒绝读取并要求重建 |

固定选择优先级为：安全边界、当前主任务文档、稳定工作流/偏好、项目代码、已证实会话历史、运行证据、显式冷证据。Provider 原生历史、Zeus 便携上下文和派生冷证据一律进入 `untrusted` 分区，不会因为片段自称“安全规则”而升格为应用级指令。

## ZARCH-050：稳定长期记忆

### 数据模型

迁移 `20260821_0501_long_term_memory_governance` 创建 `long_term_memories`。每个版本记录：

- 稳定的 `memory_key` 与 `global/project` scope；全局 scope ID 固定为 `*`，项目 scope 只保存稳定项目 ID，不保存绝对路径。
- 仅允许 `preference`、`safety_boundary`、`stable_workflow`；`task_fact`、`one_off_result`、`runtime_evidence` 在 Repository 入口直接返回拒绝结果，不落库。
- 原文及 SHA-256、来源种类/引用/观察时间、确认等级、置信度、`review_after`、`supersedes_id` 和 tombstone 审计字段。
- `external_state` 规则只接受 `user_explicit/project_instruction` 来源和 `explicit` 确认；数据库 CHECK 与 Repository 双重约束。

### 版本与过时治理

同一 scope 和 key 只能有一个未被 supersede 的 head。修正必须显式引用当前 head；复用 ID 但内容不同、跳过当前 head 或出现多个 head 时均拒绝静默选择。解析上下文时，项目 scope 的有效 head 覆盖同 key 的全局 head；墓碑 head 不注入，项目墓碑移除该项目版本后可以回退到仍有效的全局规则。

`review_after <= as_of` 只把记录放入 `reviewRequired`，不会物理删除，也不会继续作为确定当前事实注入。用户停用/删除使用墓碑，保留来源和版本链供审计；物理清理必须由后续明确保留策略处理。

### 接口

- `recordCandidate`：显式候选写入和稳定性闸机。
- `supersede`：修正当前版本，不原地覆盖。
- `tombstone`：停用/删除语义，保留审计链。
- `list`：按更新时间和 ID 的 keyset cursor 分页，可选择包含墓碑。
- `resolveForContext`：确定性返回 selected、reviewRequired 与逐条排除原因。

公开写协议不是裸 Memory JSON。candidate、supersede、tombstone 分别使用 `memory.candidate.record`、`memory.record.supersede`、`memory.record.tombstone`，Body 为 `{ command, input }`：

- `command.scope.kind` 固定为 `memory`；scope ID 对被寻址的 head/record 稳定。
- payload 只允许 `operationIdentity` 与 `inputSha256`，正文只出现于 `input`，避免在信封和账本重复保存敏感内容。
- 服务端重算 canonical input SHA-256；信封、scope、command type、摘要或幂等身份冲突时失败关闭。
- `executeCoreApplication` 在同一 `BEGIN IMMEDIATE` 内写 Inbox、Outbox、Memory 事实与 accepted receipt；候选被治理规则拒绝时四者全部回滚。
- accepted 重放不再次执行 Repository mutation，而是按同一 operation identity 返回不可变结果。公开响应保留 `commandId/operationIdentity/replayed/record`，Renderer client 只把 `record` 投影给 UI。

`POST /api/projects/:projectId/tasks/:taskId/context/preview` 不因为使用 POST 就被当作副作用，也不因为路由名包含 preview 就被硬编码豁免。`memoryContextPreviewSideEffectDeclaration` 明确声明 `read_only`、`writesBusinessState=false`、`commandLedger=not_applicable`；可执行审计还会核对路由确实调用 `previewContext`，且方法体没有 Memory mutation 或 Command Delivery 调用。任一结构证据消失，该入口会重新变为 `pending`。

优点是过时记忆不会随年月无条件累积进 prompt，冲突有确定规则，任务事实无法误入长期层。缺点是写入端必须先分类并取得来源；保守的 `review_after` 会降低无感个性化，且产品仍需提供用户核对入口。

### 桌面管理入口

Renderer 的 `features/memory` 是独立 bounded context：`memoryApiClient.ts` 独占路由映射，并在一次逻辑请求开始时生成稳定 command/operation identity 与 input SHA-256；Local API 因 Core 端口刷新而做一次网络重试时复用同一个序列化 Body，不会生成第二个命令。`MemoryQueryStore` 最多保留 500 条当前 scope 展示记录，命令成功后重新读取服务端，不把 UI store 当作第二事实源。`MemorySettingsPane` 不从会话自动抽取内容；所有新增和修正都来自用户显式表单。`external_state` 必须勾选明确确认，client 还会再次拒绝非 `explicit` 或非 `user_explicit/project_instruction` 来源。删除采用 tombstone 并要求原因，不执行静默物理删除。

收益是用户终于能直接看见来源、到期和版本链并主动纠错；缺点是治理操作多一步确认，500 条显示上限需要分页，而且 UI 上线不代表 Context Compiler 已接入真实模型派发。

## ZARCH-051：Context Compiler

### 纯函数与预算

`compileContext` 不读取文件、数据库或 wall clock。调用方必须显式提供 `asOf`、任务身份、操作风险、Provider 能力、上下文窗口、当前输入/预留输出、各来源水位和候选片段。相同输入与相同水位生成相同排序、选择清单和 SHA-256 指纹。

编译入口最多接纳 2,048 个候选和 32 Mi 个候选字符，单片段正文上限 4 Mi 字符；超限直接返回可解释参数错误，而不是让异常检索结果占满 Core 内存。去重键只有在候选真正进入结果后才被占用，预算拒绝或能力拒绝不会把后续有效候选误报成重复项。

默认分类预算如下；调用方可以逐类覆盖，但不能用一个总预算掩盖来源竞争：

| 分类 | 默认 token 预算 | 默认信任分区 |
| --- | ---: | --- |
| 安全边界 | 4,096 | `application`；不足以完整容纳时拒绝截断 |
| 任务文档 | 12,288 | 仅 `zeus_current` 来源进入 `application` |
| 长期记忆 | 2,048 | 仅已治理当前版本进入 `application` |
| 项目代码 | 8,192 | `untrusted` |
| 会话历史 | 12,288 | `untrusted` |
| 运行证据 | 2,048 | `untrusted` |
| 冷证据 | 0 | `untrusted`；必须显式开启并单独给预算 |

编译器会排除 scope/task/Provider 不匹配、review due、stale、missing、未请求冷证据、外部状态确认不足和 Provider 能力不支持的片段。安全边界不能完整放入预算或 Provider 不支持应用级上下文时，编译器直接失败，不能降级成不可信历史后继续执行。

### 可解释输出

每个纳入片段保留 category、authority、`zeus_current/provider_native/zeus_portable/derived_cold` provenance、项目/任务/Provider/原生会话身份、source ref、source version、内容摘要、请求/纳入 token 和截断原因。每个排除片段也产生 decision，说明 duplicate、预算耗尽、scope 不匹配、核对期到达或能力不支持等原因。

`renderCompiledContext` 分别输出 manifest、application 和 untrusted 三段。Adapter 后续必须将三段映射到 Provider 正式协议，不得把 untrusted 内容拼进 system/application 指令。

优点是 token 成本有上限、过时信息和来源冲突可诊断、跨 Provider 时仍保留 provenance。缺点是当前上游只提供字符数，派发按一字符一 token 作为保守上界；Codex app-server 与 Pi SDK 都没有完整待发请求的同步精确 tokenizer/preflight 端口，故 `preflightTokenCount` 明确为 `unavailable`，运行后 usage 不能替代请求前精确计数。预算或检索策略过保守也可能遗漏必要资料。

2026-08-22 的真实 Codex 验收补充了一条模型窗口兼容边界：若 app-server `model/list` 直接给出 context/output 字段，优先使用
Provider 原始证据；若 Codex CLI `0.149.0` 缺少这些字段，只允许完整模型 ID 使用已核验的 OpenAI 官方模型目录数值：
`gpt-5.4-mini` 为 400,000 context / 128,000 max output，`gpt-5.6-sol` 为 1,050,000 context / 128,000 max output。该回退按
CLI 版本和完整模型 ID 双键匹配并保留来源，不做家族推断；任一键变化就恢复 `ZEUS_CONTEXT_MODEL_WINDOW_UNAVAILABLE`
。这解决的是模型总窗口安全边界，不会把字符估算升级为精确 tokenizer。

## ZARCH-052：`/docs` 与冷证据

### `/docs` 主文档

`ContextSourceCatalog` 只在显式调用时枚举单个受控项目根的 `/docs` 一级目录，不递归扫描仓库或历史目录。它按任务号做文件名边界匹配，排除带“设计图、方案图、原型、可视化、截图、附录、补充”标记的展示/补充材料，并在主资料中优先 Markdown、再按修改时间与大小稳定排序。

目录项数超过调用方上限时会停止枚举，不会因已读部分看似匹配就猜一个主文档，而是返回 `truncatedDirectory=true` 且不选择 primary。文档正文使用 UTF-8 字节 cursor 有界分页；读取前后校验 inode、大小和修改时间，变化时要求重新定位。主文档只把当前页交给编译器，并显式记录 `source_page_limit`，不会把“读到第一页”伪装成完整读取。

### 冷索引 schema

迁移 `20260821_0521_cold_evidence_metadata_index` 创建：

- `cold_evidence_sources`：来源 kind、受控 root ID、POSIX 相对路径、项目/任务、Provider/原生 session、摘要、ready/partial/stale/missing、版本、已索引字节、原文件长度/时间、前缀 hash、事件时间范围和锚点数。
- `cold_evidence_anchors`：source、ordinal、line number、byte offset/length、line hash、event kind、turn ID、event sequence 和发生时间。

两张表都不保存原始 JSONL 正文。原始文件仍由 Provider 或运行证据 owner 持有，索引可以在原始来源存在时重建。Provider rollout/history 索引必须携带 provider ID；任务文档索引必须携带 project ID 和 task code。

### 索引与精确读取

JSONL 索引只能由 Provider/运行 owner 对一个明确的受控相对路径显式触发；构造目录、普通启动和 Context Compiler 都不会遍历 Provider sessions。索引采用流式读取，默认最多 512 MiB、单行最多 16 MiB、单来源最多 250,000 个锚点；到达字节或锚点上限时保存完整行边界前的 `partial` 索引。

正式结构兼容不能只假设 Codex rollout。Codex 使用 `session_meta/turn_context`，Pi SDK 原生文件首行使用 `type=session`、正文使用 `type=message`。索引器会从两类首行提取并核对 native session ID；Pi 的 user/assistant message 分别形成锚点，保证真实回复可被精确分页读取，而不是只锚定首行后误称文件已可查询。

同一 source ID 一旦绑定非空的项目、任务、Provider 或原生 session 身份，后续重索引只能补充此前为空的身份，不能静默清空或换绑；文件在索引期间被替换、截短或跨 inode 变化时也拒绝写入新索引。

精确读取先按 project/task/provider/native session 定位有限 source 页，再按 source ID 加 turn、event sequence 和 ordinal cursor 查询锚点。读取原文件的精确字节范围并核对逐行 SHA-256；授权回调拒绝、受控根 owner 不匹配、符号链接/越界、stale/missing 或 hash 变化都会失败。冷查不会退化成目录全文搜索。

不同来源类型有不同保留所有权：任务文档随项目/Git，Provider rollout/history 由 Provider API 管理，运行证据由有界运行保留策略管理。当前只把差异固化为可执行 policy 元数据和 owner 边界，不自动物理删除任何原始来源。

优点是多年历史不会增加普通启动和默认 prompt 成本，仍可按原生身份精确回溯。缺点是首次显式索引仍需对单个来源做线性流式读取；原文件缺失时索引不能替代事实，hash 变化后必须重建。

## 迁移与公开边界

- Storage 启动迁移已登记两项 schema，Repository 从 `@zeus/storage` 公开。
- Context Compiler 和 Context Source Catalog 通过 `@zeus/local-server/context-compiler`、`@zeus/local-server/context-source-catalog` 子路径公开，避免继续扩大 `local-server/src/index.ts` 的跨上下文表面积。
- `MemoryContextApplicationService` 与路由通过 `@zeus/local-server/memory-context-api` 公开；Local Server 入口只注入 Memory/Cold Evidence Repository、统一 Command Delivery Repository、项目定位与时钟。Memory 写入由 `core_application` 耐久事务直接提交，不再从 Application Service 回调异步 `db.save()`。preview 目前只覆盖主任务文档和 Memory，并在响应中列明未接入来源。
- 产品实现不会自行读取、导入、改写或索引当前正式 `~/.zeus` Memory、Provider Home、正式数据库和正式 rollout。2026-08-22 验收只在用户明确授权后只读取得正式 1xm 配置与 Keychain API Key，并临时写入按独立数据根派生的 Test Keychain 身份；冷索引对象仅为 Test 新建 Pi 会话文件。验收完成后 Test 凭据副本已删除，正式 Keychain 原件保持存在。

## 后续接入门禁

以下事项仍需独立任务完成，不能从核心模块存在推断为全部现场验收通过：

1. 来源扩展：在当前主任务文档和 Memory 基础上，只有在权威与预算明确后才接入已证实模型历史、代码和运行证据；不能为提高召回而自动扫描 rollout。
2. 精确 token 预检：Provider 未来提供正式同步 tokenizer/count RPC 时再接入；接入前继续保留 `unavailable` 与保守上界，禁止把估算改名为 exact。
3. 冷索引调度：仅在明确任务/会话或用户查询触发，增加容量、重建、stale 标记和保留期可见性；禁止启动时全量扫描。
4. 剩余真实运行验收：真实 Pi 与 Codex 请求、终态、原生文件以及 Pi 冷索引已通过；仍需在 Computer Use 宿主恢复强制确认回调后补齐 Memory 可见性和冷证据产品交互的 GUI 证据，不接触正式应用与正式 Provider Home。

## 代码证据

- 长期记忆：`packages/storage/src/longTermMemoryStore.ts`。
- 冷证据元数据与 keyset 分页：`packages/storage/src/coldEvidenceStore.ts`。
- Context Compiler：`packages/local-server/src/contextCompiler.ts`。
- `/docs` 与精确原文读取边界：`packages/local-server/src/contextSourceCatalog.ts`。
- Memory 管理与 Context preview Application Service：`packages/local-server/src/memoryContextApi.ts`。
- Memory 桌面管理：`apps/desktop/src/renderer/features/memory/`；真实设置入口位于 `features/workspace/WorkspaceView.tsx`。
- Memory Command 行为证据：`scripts/verify-memory-command-behavior.ts`；副作用结构清单：`scripts/audit-command-side-effect-entries.mjs`。
- 真实 Pi Provider 文件证据：`scripts/probe-writable-test-provider-sessions.ts` 与 `scripts/probe-writable-test-cold-evidence.ts`。
- 双层事实源 ADR：`docs/adr/0002-provider-and-zeus-dual-authority.md`。
- 禁止第三份完整会话 JSONL ADR：`docs/adr/0003-no-third-zeus-session-jsonl.md`。
