# TASK_20260710_001 Zeus 任务创建、推送与 App Server 连续对话全场景盘点

## 1. 文档定位

本文件承接 `/Users/david/hypha/zeus/docs/TASK_20260709_003_Zeus任务通过app_server创建会话实现记录.md`，用于审计以下完整目标：

1. 任务创建的所有入口、成功路径、异常路径与幂等边界；
2. 将任务推送为会话的创建、排队、失败、重试、暂停、取消与恢复；
3. 通过 app-server 进行真实连续多轮对话；
4. 形成可自动化、可运行、可打包验收的证据链。

本文第 3-9 节保留进入开发前的基线、决策和取证，不能再作为当前源码状态引用。用户已于 2026-07-13 明确确认开发；当前实施与 verification 结论以第 10 节为准。

## 2. 项目规约与现场

- 已读取 `/Users/david/hypha/zeus/DESIGN.md:1-69`。
- 仓库内未发现 `AGENTS.md`、`PROJECT-STYLE.md`、`CODE-GUIDELINES.md`；本任务遵循会话注入的全局 AGENTS 规约。
- Git 根目录：`/Users/david/hypha/zeus`。
- 分支：`main`。
- 当前工作树已有大量未提交修改，且本任务涉及的 Runtime、local-server、storage、Renderer 和测试均已在修改列表中。本轮不覆盖、不回退、不清理这些既有改动。
- 本机 Codex 路径：`/opt/homebrew/bin/codex`。6.3、6.4 两份真实 probe 执行时版本为 `codex-cli 0.143.0`；2026-07-10 09:37:55 +0800 后该路径已漂移为 `0.144.0`。两版证据必须按各自 artifact 记录，不得混写成同一协议版本。

## 3. 已确认的关键语义冲突

### 3.1 Zeus 文档里的 app-server

当前仓库将 Zeus 自己的 Fastify HTTP/WebSocket 服务称为本地 app-server：

- 服务构造与 Runtime 注入：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:902-973`；
- 仅监听 `127.0.0.1`：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:8091-8106`；
- Electron 启动及异常重启：`/Users/david/hypha/zeus/apps/desktop/src/main/main.ts:587-604`、`/Users/david/hypha/zeus/apps/desktop/src/main/localServerRuntime.ts:55-112`。

### 3.2 Codex native app-server

本机 Codex 0.143.0 同时提供另一套 native app-server：

```text
codex app-server --listen stdio://
codex app-server --listen unix://PATH
codex app-server --listen ws://IP:PORT
codex app-server daemon ...
codex app-server proxy ...
```

`codex app-server generate-ts --experimental` 在本机生成 668 个 TypeScript 文件；`generate-json-schema --experimental` 生成 337 个 JSON schema 文件。其中包含：

- `initialize` 请求与 `initialized` 通知；
- `thread/start`、`thread/resume`、`thread/read`；
- `turn/start`、`turn/steer`、`turn/interrupt`；
- `thread/status/changed`、`turn/started`、`turn/completed`；
- `item/started`、`item/completed`、`item/agentMessage/delta`；
- 命令审批、文件修改审批、权限审批、`request_user_input`、MCP elicitation 等 server request。

本轮只读 smoke probe 还确认：

- stdio wire 为逐行 JSON，形状为 JSON-RPC，但 0.143.0 当前 schema 与实际响应均不含 `jsonrpc` 字段：请求为 `{id,method,params}`，成功响应为 `{id,result}`，失败响应为 `{id,error:{code,message,data?}}`，通知为 `{method,params}`；
- stdout 是协议帧，stderr 是运行日志，客户端必须分离，不能将 stderr 送入协议 parser；
- `initialize -> initialized -> thread/start` 可在不发起模型 turn 的前提下成功，并返回 UUIDv7 threadId 与 path；
- 仅 `thread/start` 后就终止 app-server 时，没有 rollout 物化；新进程的 `thread/read` 返回 `thread not loaded`，`thread/resume` 返回 `no rollout found`。因此“thread/start 成功”不等于“已可跨进程恢复”，首个真实 turn 后的持久化仍待验证；
- schema 虽包含 `historyMode: "paginated"`，当前运行时以 `-32601 paginated_threads is not supported yet` 拒绝，现阶段只能使用 legacy/default 历史模式。

以上仅是本机 0.143.0 schema 与最初无模型 turn smoke probe 的事实；单凭这些证据不得声称连续对话或重启恢复已验证。后续真实模型 turn 的独立补证见 6.3、6.4。

### 3.3 实施前基线：Zeus 并未连接 Codex native app-server

- Codex adapter 构造的是 `codex exec <prompt>`：`/Users/david/hypha/zeus/packages/ai-runtime/src/index.ts:135-149`；
- Runtime 是通用子进程/PTY 的 stdout、stderr、write、interrupt、kill 状态机：`/Users/david/hypha/zeus/packages/ai-runtime/src/index.ts:498-639`；
- 当前仓库源码与测试中没有 native `initialize`、`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt` 或 JSON-RPC 客户端实现；
- 活跃会话第二轮只是向 `codex exec` 进程写入 `${content}\n`：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:1455-1489`；
- 旧进程丢失后，Zeus 取最近 12 条 conversation message 拼 prompt，并新建另一个 `codex exec`：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:7218-7353`。

因此，“现有测试通过”只能证明 Zeus 自有编排与可写假进程契约，不证明真实 Codex 连续多轮成立。

## 4. 实施前真实链路

### 4.1 手工创建任务

```text
TaskWorkspace 新任务按钮
  -> App 打开创建弹窗
  -> 标题/说明 trim、标签去重、附件持久化
  -> Renderer apiClient POST /api/tasks
  -> Zeus Fastify Bearer 鉴权
  -> TaskRepository.create
  -> task_events + audit_logs + timeline 文件
  -> db.save()
  -> 刷新 dashboard 并打开任务详情
```

证据：

- 手工入口：`/Users/david/hypha/zeus/apps/desktop/src/renderer/task/TaskWorkspace.tsx:475-477`；
- 弹窗与提交：`/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx:6265-6298,6496-6505,8473-8531`；
- Renderer 请求：`/Users/david/hypha/zeus/apps/desktop/src/renderer/main.tsx:101-113`、`/Users/david/hypha/zeus/apps/desktop/src/renderer/apiClient.ts:1129-1165,1413-1417`；
- 服务端创建：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:2164-2205`；
- 存储：`/Users/david/hypha/zeus/packages/storage/src/index.ts:646-690,1269-1321`。

### 4.2 任务推送为会话

```text
READY/DRAFT 任务点击“创建 app-server 会话”
  -> POST /api/tasks/:taskId/run
  -> 先创建 Zeus conversation + task_prompt
  -> 检查项目/全局并发
  -> 创建 AI Runtime
  -> 当前 Codex adapter spawn: codex exec <prompt>
  -> 回填 conversation.sessionId
  -> stdout/stderr 镜像为 conversation message
  -> Renderer 导航到 Sessions 并选中新会话
```

证据：

- Renderer 控制入口：`/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx:6550-6590`；
- API：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:2267-2308`；
- conversation-first：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:7360-7502`；
- Runtime 日志镜像：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:6508-6561,7997-8036`。

### 4.3 当前所谓“连续对话”

```text
用户发送 follow-up
  -> 先写 user_followup
  -> 当前 Runtime 仍在 running：向 PTY stdin 写一行
  -> 当前 Runtime 不可写：最近 12 条消息拼新 prompt，spawn 新 Runtime
  -> 新 Runtime ID 覆盖 conversation.sessionId
```

这不是 Codex native thread/turn 语义，无法证明上下文、审批、工具调用、turn 完成、resume 或 interrupt 的真实性。

## 5. 实施前全场景验收矩阵

状态含义：`已覆盖` 表示当前实现和本轮测试已有直接证据；`部分` 表示存在实现但证据或语义不完整；`缺失` 表示当前实现中没有目标能力。

### 5.1 任务创建

| 编号 | 场景 | 当前状态 | 证据或缺口 |
| --- | --- | --- | --- |
| C01 | 点击新任务只打开弹窗，不直接写库 | 已覆盖 | `/Users/david/hypha/zeus/apps/desktop/test/app-task-controls-rendering.test.tsx:1883-2024` |
| C02 | 取消、Esc、点击遮罩不创建任务 | 部分 | 有源码/契约测试，缺真实 Electron E2E |
| C03 | 标题为空、trim、标签去重 | 已覆盖 | `App.tsx:4313-4343,6496-6505` |
| C04 | 空说明创建 | 已覆盖 | `task-control-api.test.ts:113-167` |
| C05 | 图片、文件、Finder/Paste.app 附件 | 部分 | 解析和 API 有测试，缺真实窗口端到端 |
| C06 | 模板、图谱节点、图谱问答、Runtime 派生任务 | 部分 | 路由存在，未与后续推送组成完整 E2E |
| C07 | 不存在的 projectId | 缺失 | `/api/tasks` 未查项目存在；schema 无外键，可能产生孤儿任务 |
| C08 | 空白标题绕过 Renderer | 缺失 | API 只做 truthy 校验，未 trim |
| C09 | POST 成功但响应/刷新失败后的重试幂等 | 缺失 | 无 idempotency key；HTTP 自动重试可能重放 POST |
| C10 | 并发创建编号唯一性 | 缺失 | 未发现并发编号竞争测试 |
| C11 | 附件写入失败、磁盘满、db.save 失败 | 缺失 | task/event/audit/文件保存无统一事务回滚证据 |

### 5.2 任务推送到会话

| 编号 | 场景 | 当前状态 | 证据或缺口 |
| --- | --- | --- | --- |
| P01 | READY/DRAFT 首次 run 创建 conversation | 已覆盖 | `task-control-api.test.ts:334-430` |
| P02 | conversation 首条消息为完整 task_prompt | 已覆盖 | 同上 |
| P03 | Runtime 同步启动失败仍保留 failed conversation | 已覆盖 | `task-control-api.test.ts:770-840` |
| P04 | 并发满返回 queued conversation | 部分 | 返回 202 且不启动 Runtime，但没有自动出队消费者 |
| P05 | 重复点击/跨窗口/API 重放幂等 | 缺失 | 每次 run/continue 都先建新 conversation，无幂等键 |
| P06 | running task 再次 run | 缺失 | 并发分支可能尝试非法 `running -> ready` |
| P07 | continue 复用原 conversation | 缺失 | `/continue` 当前总是新建 conversation |
| P08 | failed/null-session conversation 原地恢复 | 缺失 | follow-up 只落消息，不启动 Runtime，也不返回执行错误 |
| P09 | Pause/Cancel 同步 conversation 终态 | 部分 | 有进程控制，API 测试未直接断言 conversation 状态 |
| P10 | Retry 恢复原 conversation | 缺失 | retry 只把 task 改 READY，后续 run 新建 conversation |
| P11 | Runtime 自然退出/异步失败同步 task 与 UI | 部分 | conversation 有同步；task 和当前画布终态刷新不完整 |
| P12 | local-server 异常重启后 HTTP 恢复 | 已覆盖 | Main 刷新配置并重试一次 |
| P13 | local-server 异常重启后 WebSocket 恢复 | 缺失 | `connectEvents` 固定旧 options，无 close/error 重连 |
| P14 | 会话附件真正发送到 Runtime | 缺失 | UI 可预览附件，但 API 只传 content，随后清空附件 |
| P15 | queued 原因与重试动作在主会话画布可见 | 缺失 | Renderer 边界丢弃 queued/reason 的结构化结果 |

### 5.3 Codex native app-server 连续对话

| 编号 | 场景 | 当前状态 | 目标证据 |
| --- | --- | --- | --- |
| N01 | 启动专属 stdio app-server 或连接受管 daemon | 缺失 | 独立 live probe 已证明 stdio 原生进程可用；Zeus 仍需真实进程/transport 集成测试 |
| N02 | initialize -> initialized 握手 | 缺失 | 独立 probe 已证明 wire 和握手；Zeus 仍需请求关联、通知顺序、stderr 隔离和超时测试 |
| N03 | thread/start 创建持久 thread | 缺失 | 必须持久化真实 `thread.id`、cwd、model、权限配置；空 thread 不产生可 resume rollout |
| N04 | turn/start 发送任务首轮 | 缺失 | 持久化真实 `turn.id`，收到 started/completed |
| N05 | agent message delta 流式显示 | 缺失 | itemId 去重、delta 拼接、completed 收口 |
| N06 | 同一 thread 的第二轮、第三轮 | 缺失 | 独立 live probe 已证明 native 能力；Zeus 集成仍需多次 `turn/start` 使用同一 threadId |
| N07 | turn 正在运行时再次发送 | 缺失 | 明确选择 steer、排队或拒绝，不得静默写 stdin |
| N08 | turn/interrupt | 缺失 | 独立 live probe 已证明必须先收到 `turn/started` 再 interrupt，终态为 `interrupted`；Zeus 集成仍缺失 |
| N09 | Zeus/local-server 重启后 thread/resume | 缺失 | 独立 live probe 已证明首 turn 物化后可在新进程以 threadId resume；Zeus 仍不得重放最近 12 条伪历史 |
| N10 | app-server 进程崩溃与重连 | 缺失 | pending request 失败、transport 重启、thread resume |
| N11 | command/file/permissions approval | 缺失 | 0.143.0 已证明 command approval accept；0.144.0 已证明 file approval accept、`waitingOnApproval` 与 `serverRequest/resolved`；permissions 仅 schema，Zeus 风险确认映射仍缺失 |
| N12 | request_user_input | 缺失 | 独立 live probe 已证明 Plan mode 请求/回答闭环；Default mode 明确不可用；Zeus 仍需问题、选项、autoResolution、超时映射 |
| N13 | MCP elicitation/dynamic tool request | 缺失 | 明确支持、拒绝或降级，不能悬挂 turn |
| N14 | auth 未登录、模型不可用、配置错误 | 缺失 | 错误通知、turn failed、可恢复提示 |
| N15 | cwd、workspace roots、sandbox、approval policy | 缺失 | thread/turn 参数与 Zeus 项目/安全设置一致 |
| N16 | 同项目/跨项目并发 thread | 缺失 | 独立 live probe 已证明单 stdio 连接可同时运行两 thread 且 delta 不串线；Zeus 仍需以 thread/turn 状态为事实 |
| N17 | thread/turn/item 与 Zeus conversation/message 映射 | 缺失 | 唯一约束、幂等事件处理、重放不重复 |
| N18 | native app-server 协议版本升级 | 缺失 | 记录 binary/schema 版本并做未知方法容错；0.143→0.144 已现场漂移，且 0.144 同次生成 TS/JSON 对 permissions 必填性冲突，不能只信单一生成物 |

### 5.4 最终运行验收

| 编号 | 场景 | 当前状态 | 目标证据 |
| --- | --- | --- | --- |
| E01 | 单元：协议编码、解码、请求关联、通知归一 | 缺失 | Vitest 全绿 |
| E02 | 集成：假 app-server 覆盖所有确定性分支 | 缺失 | 不调用外网的协议测试 |
| E03 | 本机真实 app-server：首轮 + 至少两轮连续追问 | 部分 | 独立 live probe 已证明 threadId 不变、3 个 turnId 不同且 nonce 可回忆；尚未进入 Zeus 源码/自动测试 |
| E04 | 本机真实 app-server：interrupt + resume | 部分 | 独立 live probe 已证明两者；Zeus 持久化、UI 与重启编排仍缺失 |
| E05 | Electron UI：创建任务 -> 推送 -> 连续发送 -> 实时回复 | 缺失 | 真实窗口/可访问性树/日志/数据库联合证据 |
| E06 | app-server/local-server/Electron 分别重启后的恢复 | 部分 | 独立 live probe 已证明 app-server 新进程 resume；Zeus local-server/Electron 重启与 DB 一致性仍缺失 |
| E07 | 回到原始需求逐项验收并反向扫描旧模式 | 缺失 | 禁止 `codex exec` 冒充 native、多轮不得只写 stdin、不得只重放 12 条历史 |
| E08 | 退出运行应用后 `pnpm package:mac` | 待实施 | Zeus 代码变更后的最终硬门禁 |

## 6. 进入开发前的测试与协议证据

版本边界：6.3、6.4 的脱敏 artifact 固定记录 `0.143.0`；其后本机 Codex 自动/外部更新为 `0.144.0`。后续 schema 或 live probe 必须另记版本，并把跨版本兼容作为 N18 验收项。

### 6.1 已执行

```bash
pnpm vitest run packages/local-server/test/task-control-api.test.ts --reporter=verbose
```

结果：`1 file / 13 tests passed`。

```bash
pnpm vitest run \
  apps/desktop/test/app-task-controls-rendering.test.tsx \
  apps/desktop/test/app-shell-layout.test.tsx \
  apps/desktop/test/main-runtime.test.ts \
  packages/local-server/test/task-control-api.test.ts \
  packages/storage/test/task-status.test.ts \
  --reporter=dot
```

结果：`5 files / 278 tests passed`。

```bash
pnpm vitest run \
  apps/desktop/test/api-client.test.ts \
  apps/desktop/test/task-clipboard.test.ts \
  packages/local-server/test/task-events-api.test.ts \
  packages/storage/test/storage.test.ts \
  --reporter=dot
```

结果：`4 files / 89 tests passed`。

```bash
pnpm vitest run \
  packages/ai-runtime/test/session.test.ts \
  packages/local-server/test/runtime-session-api.test.ts \
  apps/desktop/test/api-client.test.ts \
  --reporter=verbose
```

结果：`3 files / 109 tests passed`。其中 `api-client.test.ts` 与上一组重叠；不能简单相加为唯一测试总数。

### 6.2 证据边界

- 上述测试证明当前 dirty working tree 的既有 local-server、任务、附件、Runtime/PTY 与 Renderer API 契约没有立即回归。
- 上述 Vitest 没有启动 `codex app-server`。最初的无 turn smoke probe 只执行 initialize 和空 thread/start/read/resume；随后 6.3、6.4 另行执行了真实模型 turn，但仍是 Zeus 源码之外的独立现场 probe，不能替代仓库自动测试和 GUI 集成证据。
- `/Users/david/hypha/zeus/packages/local-server/test/task-control-api.test.ts:9-57,493-560` 使用自造可写 spawn 回显后续输入。
- `/Users/david/hypha/zeus/packages/ai-runtime/test/session.test.ts:246-299` 仍将 `codex exec` 作为正确 adapter 契约。

### 6.3 Codex 0.143.0 真实 native app-server live probe

本轮在 `/tmp` 空 Git 仓库、`sandbox=read-only`、`approvalPolicy=never` 下执行了真实 `turn/start`；没有修改 Zeus 源码或 probe 仓库内容。脱敏结果已保存为：

`/Users/david/hypha/zeus/docs/artifacts/TASK_20260710_001_codex_native_app_server_live_probe.json`

首次运行失败：

- 用户当前 Codex 配置模型为 `gpt-5.6-sol`；
- 0.143.0 `model/list` 当前只声明 `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex-spark`；
- stderr 明确记录 `Unknown model gpt-5.6-sol`，5 个 turn 均进入 `failed`；
- 因此 native client 必须先用 `model/list` 验证配置模型，不得将不受支持的模型静默当成成功连续对话。

第二次显式使用 `gpt-5.4-mini`后成功：

- thread `019f4995-ebaa-73a0-9319-92eb975cd311` 下连续执行 3 个不同 turn，结果依次为 `ACK-9JLTQLFRKA`、`RECALL-9JLTQLFRKA`、`RESUMED-9JLTQLFRKA`；
- 前两轮完成后关闭 app-server，全新进程以同一 threadId `thread/resume`，成功加载 2 个历史 turn 并回忆 nonce；
- 同一 stdio 连接上同时启动两个 thread，两个 `turn/started` 都早于首个 `turn/completed`，结果分别回到正确 thread/turn，未串线；
- 逐行 JSON parser 无解析错误。

该次 probe 当时仍未验证 command/file/permissions approval、`request_user_input`、`turn/interrupt`；其中 command approval、Plan mode `request_user_input` 与 `turn/interrupt` 已由下节 6.4 的后续 probe 补证。当前剩余 file/permissions approval、Zeus 持久化映射、真实 UI 与 packaged App。

环境性能风险：`codex doctor` 报告 Responses WebSocket 握手超时；live probe 可回退 HTTPS 并成功，但每组首次请求因 5 次 WebSocket 重试增加约 100 秒延迟。实现必须把 transport 重试/回退与模型不可用分类呈现，不能都折叠成“会话失败”。

### 6.4 native interrupt、command approval 与 request_user_input live probe

脱敏结果：

`/Users/david/hypha/zeus/docs/artifacts/TASK_20260710_001_codex_native_app_server_control_probe.json`

已确认：

- **interrupt 时序**：`turn/start` 响应后立即发 `turn/interrupt` 可返回 `-32600 no active turn to interrupt`；客户端必须先观察到匹配 threadId/turnId 的 `turn/started`，再发 interrupt。正确顺序下 `turn/completed.status=interrupted`；
- **command approval**：`approvalPolicy=untrusted` 下真实收到 `item/commandExecution/requestApproval`，请求同时携带 threadId、turnId、itemId、command、cwd、availableDecisions；客户端以同一 requestId 返回 `{decision:"accept"}` 后，命令执行且 turn 完成；
- **request_user_input 的 mode 边界**：Default mode 中 stderr 明确报 `request_user_input is unavailable in Default mode`，而模型仍可能生成看似已选择的文本，因此不得用自然语言结果伪造工具闭环；
- `turn/start.collaborationMode.mode=plan` 下真实收到 `item/tool/requestUserInput`，questions 含 id/header/question/isOther/isSecret/options/autoResolutionMs；回送 `{answers:{probe_choice:{answers:["ALPHA"]}}}` 后 turn 回复 `RUI-ALPHA` 并完成。

该次 0.143.0 probe 仍未验证 file change approval、permissions approval，以及审批的拒绝、取消、超时、重复回答和重启恢复。file change approval 已由下节 6.5 的 0.144.0 probe 补证。

### 6.5 Codex 0.144.0 file approval live probe 与 permissions schema

在前两组 probe 后，本机 `/opt/homebrew/bin/codex` 已漂移为 `0.144.0`。本节证据与 0.143.0 artifact 分开记录：

`/Users/david/hypha/zeus/docs/artifacts/TASK_20260710_001_codex_native_app_server_approval_probe_0_144.json`

在 `/tmp` 临时 Git 仓、`approvalPolicy=untrusted`、`sandbox=readOnly` 下已确认 file approval accept 的真实顺序：

1. `item/started(type=fileChange,status=inProgress)`；
2. `thread/status/changed(activeFlags=[waitingOnApproval])`；
3. server request `item/fileChange/requestApproval`，带 threadId、turnId、itemId、startedAtMs、reason、grantRoot；
4. 客户端以同 requestId 回送 `{decision:"accept"}`；
5. `serverRequest/resolved`，随后 activeFlags 清空；
6. `item/completed(type=fileChange,status=completed)`，thread 回 idle，turn completed；
7. 临时仓真实生成 `APPROVED.txt`，内容精确为 `FILE-APPROVAL-ACCEPTED\n`，协议 parser 无错误。

0.144.0 生成 schema 还确认 `item/permissions/requestApproval` 与 command/file approval 不是同一种响应：请求包含 cwd 和 `permissions.network/fileSystem`；响应是 `{permissions,scope:"turn"|"session",strictAutoReview?}`，没有 accept/decline/cancel decision。该分支不能复用普通 approval decision 状态机；真实 permissions round trip 尚未执行。

同一次 0.144.0 生成结果存在证据冲突：JSON Schema 将 `environmentId`、`reason` 视为非必填，并给 `scope` 默认值 `turn`；TypeScript binding 却把三者都生成为非 optional。真实 wire 补证前必须 fail-closed，不能任取一方作为协议事实。

第一次 0.144.0 尝试还因继承本地 effort `max` 失败，服务只接受 `none|minimal|low|medium|high|xhigh`；成功 probe 显式使用 `low`。Zeus 后续必须先用当前版本能力归一化 model/effort，而不是透传可能漂移的本地配置。

该 turn 因 Responses WebSocket 重试并回退 HTTP 耗时 122797 ms，再次证明 transport fallback 必须独立呈现。

### 6.6 Codex 旧会话停止后的原生续接机制

Codex 并不为每个旧会话保留一个长期模型子进程。原生连续对话依赖两个持久事实：provider threadId 与磁盘 rollout。

- thread 已加载且只是 turn completed/idle：客户端直接对同一 threadId 发新的 `turn/start`；
- app-server 已退出、重启或 thread 未加载：新 app-server initialize 后先调用 `thread/resume({threadId})`，由服务读取 `~/.codex/sessions/.../rollout-*.jsonl` 恢复历史，再对同一 threadId 发新的 `turn/start`；
- 每轮 turnId 不同，threadId 保持不变；`turn/completed` 后 thread 再次回 idle；
- 当前 0.144.0 schema 支持按 threadId、history 或 path resume，并明确普通客户端应优先 threadId；path 属于不稳定字段；
- 只有空 `thread/start`、尚未物化真实 turn 的 thread 可能没有 rollout，跨进程 resume 会得到 `no rollout found`；
- 本任务 0.143.0 live probe 已证明：关闭 app-server 后，新进程按同一 threadId 加载 2 个历史 turn，第三轮成功回忆 nonce。

图解：`/Users/david/hypha/zeus/docs/TASK_20260710_001_Codex旧会话续接机制.html`。

这也是现存 Zeus legacy conversation 无法原生续接的原因：它们只有 `ai-session-*` 或 null，没有 provider threadId，不能把最近消息重放或旧 sessionId 伪装成 `thread/resume`。

## 7. 当前候选范围决策

### 7.1 用户决策记录（2026-07-10）

用户已确认选项 1：

- Codex adapter 接入 Codex native app-server；
- Zeus Fastify 继续作为 Renderer 的本地 API 门面；
- Claude、Gemini、Generic shell adapter 保持现有 CLI/PTY 路径；
- 不把 `codex exec`、PTY stdin 或最近 12 条消息重放当作 Codex 连续对话的完成证据。

该决策已清除“app-server 产品语义”阻塞项，但尚需确认 native app-server 的运行拓扑，因为它会改变进程归属、并发边界、崩溃恢复、安全边界与打包验收。

### 7.2 选项 1：Codex adapter 接入 native app-server（已确认）

- Zeus Fastify 保留为 Renderer 的本地 API 门面；
- Codex adapter 使用 native thread/turn 协议；
- Claude、Gemini、Generic shell 暂保留现有 CLI/PTY adapter；
- 现有 Zeus conversation 继续作为产品对象，但必须持久化并映射 Codex thread/turn/item 身份；
- 完整覆盖本文件 N01-N18 和 E01-E08。

### 7.3 选项 2：仅收口 Zeus Fastify + `codex exec`（已否决）

- 修复创建、幂等、queue、WS、附件、null-session 等现有缺口；
- 不建立 native thread/turn；
- 不能证明“通过 Codex native app-server 跑通连续对话”。

### 7.4 选项 3：native 与 legacy Codex 模式都作为可选产品模式（已否决）

- 兼容面最广；
- 配置、状态、测试和迁移成本最高；
- 在没有明确 legacy 产品需求前不推荐。

## 8. native app-server 运行拓扑只读取证

已确认事实：

- 当前每个 `createLocalServer()` 实例自行创建 Runtime manager：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:902-973`；
- Electron Main 托管 `DesktopLocalServerRuntime`，Fastify 异常关闭后会换端口重建：`/Users/david/hypha/zeus/apps/desktop/src/main/localServerRuntime.ts:55-112`；
- Electron 退出当前只关闭通知桥和 Fastify，未管理 native app-server 进程：`/Users/david/hypha/zeus/apps/desktop/src/main/main.ts:587-619`；
- 本机 Codex daemon control socket 当前不存在；正在运行的 Codex.app stdio app-server 由 Codex.app 自己拥有，Zeus 不能接管；
- 当前打包不捆绑 Codex CLI，仍需使用用户配置/检测到的本机 Codex 可执行文件：`/Users/david/hypha/zeus/apps/desktop/electron-builder.yml:7-17`。

三种候选：

1. **Zeus 应用级单例 stdio（推荐）**：由 `DesktopLocalServerRuntime` 惰性托管一个 `codex app-server --listen stdio://`，每 conversation 映射独立 thread；thread idle/queue dispatch 创建新 turn，Steer 则追加到当前 active turn；
2. **每 conversation 独立 app-server**：隔离强，但进程、内存、FD、启动延迟和恢复逻辑线性增长；
3. **外部 daemon/proxy**：可跨 Zeus 存活，但引入 socket 发现、版本所有权、断连通知/审批和用户级服务管理。

当前证据边界：0.143.0 真实 probe 已证明 stdio 握手、首个 turn 物化、同一 thread 连续三轮、新 app-server 进程按原 threadId `thread/resume`、单 stdio 上双 thread 并发不串线、正确时序的 interrupt、command approval accept，以及 Plan mode `request_user_input` 回答闭环；0.144.0 已补证 file approval accept 与 `waitingOnApproval -> serverRequest/resolved`。仍未证明 permissions approval live、审批拒绝/取消/超时/重复回答/重启恢复；permissions 的 TS/JSON 必填性还互相冲突，也未完成 Zeus 源码、持久化和真实 UI 集成。

### 8.1 用户拓扑决策（2026-07-10）

用户确认“对齐 Codex 即可”，据此锁定选项 1：

- Zeus 在应用级惰性托管一个私有 stdio app-server；
- 所有 Codex conversation 在该连接内映射不同 native thread；
- thread idle 或 queued submission 被调度时，每条正常提交映射独立 turn；Steer 明确作为当前 active turn 的追加输入，不创建新 turn；
- manager 归属 Electron Main 的 `DesktopLocalServerRuntime`，跨 Fastify 换端口重建存活，并在 Zeus 退出时统一关闭；
- 不连接、不复用、不接管 Codex Desktop 自己的 app-server；
- 不引入外部 daemon/proxy，也不为每个 conversation 启动独立 app-server。

现场对齐证据：当前 Codex Desktop 由主进程直接托管一个 bundled `codex ... app-server --analytics-default-enabled` 子进程，未指定 listen 时默认 stdio；当前 daemon control socket 不存在。该 bundled binary 为 `codex-cli 0.144.0-alpha.4`。

该决策已清除运行拓扑阻塞项。

## 9. 历史 Readiness Gate 与用户决策

`READINESS: BLOCKED`

图解：`docs/TASK_20260714_002_Zeus与Codex会话持久化实现差异.html`。该图对照现有 native 直接 resume、Zeus 手写 rollout 的错误路径，以及在 Codex 内部复用 importer + ThreadStore 并新增窄 RPC 的实现级一致路径。

已明确：

- 目标、当前实现链路、主要数据关系、当前测试证据、关键缺口和最终验证类别；
- 当前实现没有 Codex native app-server；
- 用户已确认 Codex adapter 使用 native app-server，其他 adapter 保持原路径。
- 用户已确认对齐 Codex Desktop：Zeus 应用级单例 stdio app-server，多 conversation 映射多 thread。

阻塞未知：

- 迁移前已存在、但没有 native threadId 的 legacy conversation 被用户选中时，是只读展示、以显式引用历史创建新 native thread，还是继续走已否决的 legacy Codex CLI 路径。

### 9.1 任务与 turn 终态只读取证

- Codex native 语义是一个 thread 包含多个 turn；`turn/completed` 后 thread 回 idle，仍可在同一 thread 发下一轮。本任务 6.3 已用三轮和跨进程 resume 实证；
- Zeus 当前 `completed` 是不可逆终态，允许迁移列表为空：`/Users/david/hypha/zeus/packages/task-core/src/index.ts:3-25`；
- 当前任务完成由用户显式按钮触发：`/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx:8535-8545,8685-8692`；
- 服务端显式写入 `completed` 时还会触发图谱节点回写：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:2218-2262`；
- 当前 Runtime 退出只更新 conversation Runtime 状态，不自动完成 task：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:6478-6487`。

候选口径：

1. **turn 完成不等于 task 完成（推荐，且与 Codex 对齐）**：turn 完成后 conversation/thread 进入 idle，task 保持 running；用户仍可连续追问，只有显式“标记完成”才进入 task completed；
2. **首个 turn 完成即 task 完成**：与连续对话冲突，因为当前 completed task 不允许恢复 running；
3. **由模型完成信号或验收器自动完成 task**：需新增可信 completion contract、误判恢复与审计规则，首版复杂度和风险最高。

#### 用户终态决策（2026-07-10）

用户确认选项 1：

- `turn/completed` 只表示本轮结束，conversation/native thread 回 idle；
- Zeus task 保持 running，允许在同一 thread 连续追问；
- 只有用户显式“标记完成”才将 task 转为 completed，并触发通知、审计和图谱回写；
- 首版不根据模型文本或隐式完成信号自动完成 task。

该决策已清除 Task/Turn 终态阻塞项。

### 9.2 Task、conversation 与 native thread 的基数只读取证

- 当前 `conversations.task_id` 没有唯一约束，也没有 taskId 索引；同一 task 可存在任意多个 conversation：`/Users/david/hypha/zeus/packages/storage/src/index.ts:750-774,852-865`；
- `ConversationRepository.create()` 每次直接生成新 conversationId，没有按 task 查找或幂等键：`/Users/david/hypha/zeus/packages/storage/src/index.ts:1798-1821`；
- `/run` 与 `/continue` 都调用同一启动函数：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:2267-2308`；
- 该启动函数在检查并发、创建 Runtime 或判断失败之前就无条件创建新 conversation 和首条 task_prompt：`/Users/david/hypha/zeus/packages/local-server/src/index.ts:7360-7417`；
- 因此重复点击、HTTP 重放、continue、queued 后再试、failed 后 retry 都可能为同一 task 制造多个 conversation；当前测试只断言动作成功，未断言同 task 的 conversation 数量或幂等：`/Users/david/hypha/zeus/packages/local-server/test/task-control-api.test.ts:334-430`；
- 相反，已有 conversation 内发送 follow-up 会复用该 conversation；旧 Runtime 丢失时也覆盖同一 conversation 的 sessionId：`/Users/david/hypha/zeus/packages/local-server/test/task-control-api.test.ts:740-764`。

候选口径：

1. **一个 task 一个 canonical conversation/native thread（推荐，且与 Codex 对齐）**：首次 run 创建；重复 run、continue、retry、queued 恢复和 HTTP 重放都复用；只有显式“Fork/新建会话”才创建新 thread；
2. **一个 task 允许多个并列 conversation/thread**：保留当前自由度，但默认 run/continue 无法幂等，UI、状态和“当前 thread”归属不确定；
3. **每次 retry 自动新建 thread、其他动作复用**：保留失败现场，但需要 current/history 规则及跨 thread 上下文策略，复杂度更高。

#### 用户会话基数决策（2026-07-10）

用户确认采用“存在历史时显式选择”口径：

- Task 没有关联 conversation 时，首次 run 直接创建新 native conversation/thread；
- Task 已有关联 conversation 时，不能由 run/continue/retry 静默新建，也不能自动选最新；UI 必须列出可续接的历史会话，并同时提供“开启新会话”；
- 用户选择历史 native conversation 时，以其 provider threadId `thread/resume` 并继续新 turn；
- 用户选择“开启新会话”时，才创建新的 conversation/native thread，并保留与同一 task 的关系；
- 同一用户选择动作仍需 idempotency key，响应丢失或 HTTP 重放不能重复创建 conversation/thread/首 turn；
- 因此同一 Task 可以拥有多个 conversation/thread，但每次新增都必须来自用户显式选择，而不是隐式副作用。

该决策已清除 Task/Thread 基数阻塞项；实现不能为 `conversations.task_id` 添加全局唯一约束，而应增加可续接状态、provider threadId 唯一约束和显式选择契约。

### 9.3 Legacy conversation 迁移边界只读取证

2026-07-10 当前真实数据库只读快照：

- `/Users/david/Library/Application Support/@zeus/desktop/zeus.db` 中共有 4 个 conversation，关联 2 个 Task，每个 Task 已有 2 个 conversation；
- 这些 conversation 只保存 `ai-session-*` 或 null sessionId，消息 metadata 记录 `adapterId=codex`，但都没有 native provider threadId；
- 其中包含 failed、running、exited 以及 follow-up/reconnect 历史，不能从现有字段可靠推导 native threadId；
- 当前 schema 也没有 provider thread/turn/item 表：`/Users/david/hypha/zeus/packages/storage/src/index.ts:750-774`。

因此这些历史会话无法通过 `thread/resume` 变成真实 native 连续对话。候选口径：

1. **保留只读历史，并允许用户显式“引用历史开启新 native 会话”（推荐）**：新建真实 native thread，清楚标记“引用/迁移来源”，可将用户确认的历史消息或摘要作为首轮上下文，但绝不伪装成 resume；
2. **历史只读且不可引用**：最安全，但用户无法利用已有上下文；
3. **继续用 `codex exec` 续接 legacy conversation**：与已确认的 native-only Codex 范围冲突，并继续保留伪连续对话。

该决策会改变历史选择器、迁移 UI、首轮上下文、审计、敏感信息确认和回滚边界。在用户确认前，不进入 develop，不修改源码、测试、配置、依赖或数据库。

#### 用户 Legacy conversation 决策（2026-07-13）

用户确认采用选项 1：

- 没有 native provider threadId 的 legacy conversation 保留只读；
- 用户可以显式选择“引用历史开启新 native 会话”；
- 该动作必须创建新的真实 native thread，并记录来源 conversation、引用范围、确认时间与新旧关系；
- 可引用用户明确确认的历史消息或摘要作为新 thread 首轮上下文，但不得将旧 `ai-session-*`、null sessionId 或消息重放伪装成 `thread/resume`；
- legacy conversation 不再进入 `codex exec`、PTY stdin 或最近消息重放链路。

该决策已清除 Legacy conversation 迁移边界阻塞项。

### 9.4 会话页 Codex App 对齐范围决策（2026-07-13）

用户要求会话页的样式、对话细节、动画细节和交互逻辑全部参考当前 Codex App，并作出两项明确决策：

1. 当发送后 GUI 取证被 macOS 锁屏阻断时，选择继续以“已采集空态截图 + 当前 app-server 真实事件 + Codex App bundle 静态行为证据”定稿；发送后视觉动画保留实机复核项，但不继续阻塞设计；
2. 明确选择覆盖 `DESIGN.md:209-214` 的外部品牌限制，要求字体、颜色、图标和视觉表现也逐项对齐 Codex App。实现仍不得复制 Codex 专有源码；应以可观察行为、测量值、现有图标库等价图标和 Zeus 自有实现复现。

本轮已确认的 Codex App 行为基线：

- 会话内容区最大宽度约 `48rem`，Markdown 内文约 `40rem`；用户消息右对齐、最大宽度约 `77%`，助手消息采用正文流而非对称气泡；
- 空闲为 Send，提交中为 spinner/禁用态，响应中原位切换 Stop；输入框聚焦时首次 `Esc` 进入 2 秒确认态，第二次 `Esc` 才停止，mention、模板、审批等浮层优先消费 `Esc`；
- 响应中继续输入支持 Queue / Steer；队列支持排序、编辑、删除、立即 Steer、暂停和恢复；
- 流式阶段区分 `idle -> prework/commentary -> final_answer -> idle`，审批、用户提问、断线重连和错误恢复是流内一等状态；
- `thread/settings/updated`、`thread/tokenUsage/updated`、`account/rateLimits/updated` 和 `mcpServer/startupStatus/updated` 必须进入类型化 snapshot/事件，支持模型与强度、token/限额和 MCP 启动状态在重连后恢复；
- 自动滚动不是简单置底，而是 `static / prework_watch / prework_follow / user_follow` 状态机；用户主动上滚后不得抢回底部；
- 关键动效基线：新会话标题进入 `280ms`、退出 `180ms`，队列进退 `180ms`，Markdown 块淡入 `150ms`，图片进入 `180ms`，最新 turn 定位 `500ms` 无 bounce，Thinking 首次等待 `600ms`、扫光 `1000ms`、每 `4000ms` 重复；
- `prefers-reduced-motion` 必须同时关闭淡入、缩放、扫光、滚动弹簧和展开折叠动画，而不是只停止 CSS shimmer；
- 断线显示当前重连次数，429/服务器繁忙使用独立状态，可展开错误详情；
- 未发现 Codex App 存在统一“重新生成上一轮回复”行为，因此首版不能自行虚构通用 Retry，只实现已证实的渲染重试、队列重试、断线恢复和特定安全缓冲重试。

取证期间 Codex App 从 `26.707.41301` 自动更新到 `26.707.51957`；当前安装版本已重新检查，关键行为锚点仍存在。静态行为证据来自本机 `/Applications/Codex.app/Contents/Resources/app.asar` 内以下当前资产的只读检索：

- `webview/assets/local-conversation-thread-D0Cl2jBU.js`；
- `webview/assets/queued-message-list-C7IK6FfC.js`；
- `webview/assets/thread-scroll-layout-Drthomvq.js`；
- `webview/assets/thread-virtualizer-BoYpYSfN.js`；
- `webview/assets/thread-scroll-controller-context-value-1osjoNQc.js`；
- `webview/assets/app-CnsXMFE2.css`；
- `webview/assets/app-initial~app-main~page-opV5Hy6a.js`；
- `webview/assets/app-initial~app-main~onboarding-page-3kH05n45.js`；
- `webview/assets/app-initial~app-main~quick-chat-window-page~chatgpt-conversation-page-B0shAhmV.js`；
- `webview/assets/app-initial~app-main~quick-chat-window-page~chatgpt-conversation-page-BmiNbp0u.css`；
- `webview/assets/app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-k1satKyX.js`。

以上证据只用于确认可观察行为和测量值，不把 bundle 源码或品牌资产复制进 Zeus。

### 9.5 Codex App 当前版本 app-server 双轮 live probe（2026-07-13）

本轮使用 `/Applications/Codex.app/Contents/Resources/codex` 的 `app-server --listen stdio://` 在空目录 `/tmp/codex-ui-parity-probe` 发起安全、只读、无工具的真实双轮请求：

- initialize 成功，`model/list` 返回默认模型 `gpt-5.6-sol`；
- `thread/start` 创建 thread `019f58da-4c55-7462-857a-5a5f28d50e16`；
- 第一轮在同一 thread 返回精确文本 `UI-PARITY-ACK`，状态 `completed`；
- 第二轮继续同一 thread 返回精确文本 `UI-PARITY-SECOND`，状态 `completed`；
- 两轮均观察到 `thread/status/changed -> turn/started -> item/started -> item/agentMessage/delta* -> item/completed -> thread/tokenUsage/updated -> thread/status/changed -> turn/completed`；
- 第一轮约 `2814ms`，第二轮约 `2478ms`；未出现 stderr、审批、命令或文件写入请求；
- 原始探针证据位于 `/tmp/codex-ui-parity-live-probe.json`，属于临时取证，不作为项目交付附件。

该证据确认当前版本仍可用一个 app-server 连接承载同一 thread 的连续 turn，并给出 Renderer 状态机必须消费的真实事件顺序。

### 9.6 Readiness Gate 更新（进入开发前，2026-07-13）

`READINESS: READY FOR DESIGN CONFIRMATION`

已明确：

- 用户与场景：Zeus macOS 会话页；Telegram / 移动端只影响设计图交付方式，不改变桌面产品主端；
- 业务目标：获得与 Codex App 对齐的真实连续对话体验，并由真实 native app-server 驱动；
- 主流程：选择/新建会话 -> 发送 turn -> 消费 native 流事件 -> 连续追问、Queue/Steer、停止、审批或回答问题 -> 用户显式完成 Task；
- 业务规则：一个 Task 可有多个 conversation/thread，但新增必须显式选择且幂等；legacy 只读或显式引用创建新 thread；turn 完成不等于 Task 完成；
- 权限角色：本地单用户；命令、文件、网络与 request_user_input 必须按 native requestId 防重并显式决议；
- 边界异常：启动失败、协议不兼容、断线重连、app-server 崩溃、审批超时、重复提交、旧会话迁移、Fastify 换端口、应用退出；
- 多端差异：产品实现以 macOS 桌面端为主；交付说明 HTML 必须在 390px 移动端可读，并作为 Telegram `.html/.htm` 文件附件卡片发送，不需要 PNG，也不以 `file://` 为 Telegram 主入口；
- 兼容影响：Codex adapter 切到 native app-server；Claude/Gemini/Generic 保持现有 CLI/PTY；现有 REST/WS 客户端需要迁移期兼容；
- 验证方式：storage/local-server/ai-runtime/renderer 自动化测试、真实 app-server contract probe、桌面构建、真实 App 视觉与键盘回归、断线/恢复/重启/旧会话场景；
- 回滚方式：功能开关回退到原只读会话浏览，不允许回退到伪连续 `codex exec`；新表/字段采用增量兼容，不在回滚时破坏或删除 native thread 映射。

已接受的限制：发送后 GUI 动画尚未做当前机器实机视觉复验；用户已明确选择继续，实施后必须作为视觉验收项补测，未补测前不得声称“视觉完全一致”。

设计规约同步：用户确认的视觉覆盖已作为 task-scoped exception 追加到 `DESIGN.md` 的 `TASK_20260710_001 会话页任务级视觉例外`。该例外只在 `.session-codex-parity-v1` 生效，不改变其他 Zeus 页面。

该段是进入开发前的门禁结论；随后用户已明确确认进入 develop，最新状态见第 10 节。

## 10. 实施与 verification 最新状态（2026-07-13）

> 本节覆盖第 3-9 节中的“当前 / 缺失 / 待开发”旧口径。旧段落保留为实施前证据，不代表现有源码。

### 10.1 已落地的 native 垂直链路

1. **Wire 与应用级 manager**
   - `packages/ai-runtime/src/codexAppServerProtocol.ts` 的 `CodexJsonLineDecoder` 负责逐行 framing、CRLF、畸形 JSON 和帧大小错误；stdout 协议与 stderr 日志分离。
   - `packages/ai-runtime/src/codexAppServerManager.ts` 的 `createCodexAppServerManager` 惰性启动 `app-server --listen stdio://`，完成 initialize / initialized / model/list，并提供 thread start/resume、turn start/steer/interrupt、server request response、generation 和幂等 close。
   - `packages/ai-runtime/src/cliSearchPath.ts` 的 `expandCliSearchPath` 补齐 Finder 启动常缺失的 Homebrew / system PATH；受限 PATH 的真实 capability probe 返回 7 个模型，默认模型为 `gpt-5.6-sol`。

2. **持久化、幂等和恢复**
   - `packages/storage/src/index.ts` 的 `migrateCodexNativeConversationSchema` 增量增加 provider thread 身份、turn、item、submission、server request 与 HTTP idempotency 表/索引；provider thread/item/request identity 均有唯一约束。
   - `packages/local-server/src/codexNativeConversationCoordinator.ts` 的 `createCodexNativeConversationCoordinator` 负责一 conversation 单 active turn、Queue/Steer/Stop、legacy 引用新建、provider 事件落库后广播、generation 恢复和未知 dispatch window 的 `recovery_required` fail-closed。
   - manager 检测到 generation-scoped server request identity 冲突时，coordinator 会终止对应 durable pending authority，并将 turn、active/dispatching/queued submission、provider 与运行态统一置为 `recovery_required`；畸形 `request_user_input` canonical envelope 走同一暂停恢复边界，不能进入 Renderer pending authority。
   - provider `userMessage.clientId=null` 的 started → completed 重放会保留同一 provider item 已落库的 client message id、附件和 metadata；广播注入最终 durable client id，使 optimistic user bubble 能稳定收敛。
   - 当前 Codex 发出的逐个 `mcpServer/startupStatus/updated` 已按 `{threadId,name,status,error,failureReason}` 归并为快照；旧 `{statuses}` 形状仍兼容，畸形数据 fail-closed。

3. **REST / WebSocket 与 Electron 生命周期**
   - `packages/local-server/src/index.ts` 的 native conversation 路由要求 `Idempotency-Key`，覆盖显式 create/resume/reference_legacy、消息、队列编辑/删除/排序/立即发送、interrupt、request response 和暂停队列恢复；Provider RPC 已进入不确定窗口时不会自动重放。
   - 本地图片附件会转换为 provider `localImage` 输入，其他本地文件会转换为 provider mention 输入；无法安全解析的路径及尚未实现的 `uploadRef` 直接返回类型化 400，不能在 UI 清空后静默丢附件。
   - `codexNativeConversationCoordinator` 在写回 provider 前以持久化 pending request 做第二次权威校验：command/file 决议必须属于 provider 可用集合且目标位于项目内；file 请求只要携带非空 `grantRoot` 就拒绝 grant，不能把目录授权伪装成 one-shot 文件授权；MCP 必须满足精确 canonical envelope、form / `openai/form` 子集、own-property 字段存在性和严格 RFC3339 date-time，畸形或越权 accept 均 fail-closed，仍允许 decline/cancel 安全收敛。
   - `apps/desktop/src/main/localServerRuntime.ts` 将 manager 提升到应用级所有权，Fastify 换端口时复用；应用最终退出统一收口。`ZEUS_CODEX_NATIVE_ENABLED` 可关闭新写入口，回滚只读，不回退到 `codex exec`。
   - MCP 外部地址不再使用 `target=_blank`；Renderer、preload IPC 与 Main 只允许无凭据 HTTPS，预览隐藏 userinfo/query/hash，Main 还校验调用窗口归属并保持全局 `window.open` deny。
   - `packages/ai-runtime/src/index.ts` 仍保留通用 `createAiCliAdapterInvocation` factory 供非 Codex adapter 使用；生产 Codex 写路径没有调用它。

4. **Codex App 对齐会话页**
   - `apps/desktop/src/renderer/session/useSessionController.ts` 通过 REST snapshot + typed WebSocket reducer 驱动 optimistic send、connection recovery、request/queue 和 durable client id 对账；只有匹配的 durable client id 才清除 optimistic 记录。WS resolved 与本地 respond success 会先写入 request tombstone，迟到 detail/full snapshot 或 created 事件不能复活已解决 authority。
   - `apps/desktop/src/renderer/session/SessionWorkspace.tsx`、`PendingRequestSurface.tsx` 与 `session.css` 实现 conversation tree、native/legacy 路径、流式 item、Queue/Steer/Stop、双 Esc、command/file/permissions/MCP/request_user_input、滚动状态机、深色主题和 reduced-motion。
   - `request_user_input` 仅接受 exact `{threadId, turnId, itemId, questions, autoResolutionMs}` envelope；file approval 支持 Codex 0.144 可省略的 `reason` / `grantRoot`，但永久过滤 file `acceptForSession`；`openai/form` enum 使用对象键顺序无关、数组顺序敏感的深 JSON 等价判断。
   - 移动端会话抽屉现在会把初始焦点送到“新对话”，`Esc` 关闭后焦点回到“会话列表”；320px 审批动作允许换行，侧栏禁止横向滚动。

### 10.2 自动化与构建证据

| 验证 | 结果 |
| --- | --- |
| native 核心与安全加固 17 文件分层测试 | `17 passed / 518 tests passed` |
| 最终综合审查修复 focused 回归 | `5 passed / 153 tests passed` |
| 迁移后的旧 Renderer 五文件回归 | `5 passed / 397 tests passed` |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm format:check` | 通过；三份新 JSON artifact 经 Prettier 后重跑成功 |
| `pnpm build` | 通过；仅 Vite chunk > 500 kB 警告 |
| `git diff --check` | 通过 |
| `pnpm test` | **未通过**：79 文件中 77 通过、2 失败；1301 通过、16 失败、3 跳过 |

全量测试的 16 个失败只位于：

- `packages/graph-engine/test/graph.test.ts`：10 个 real-repo self-scan 节点/边查找失败；
- `packages/local-server/test/graph-view-api.test.ts`：6 个同源 Graph method-logic/API 断言失败。

独立只读诊断已确认：目标事实和边存在于完整 `ProjectGraph`，失败发生在当前 Graph picker 先按仓库顺序做固定 cap、再裁掉端点不完整的边；本次合法的 session/native 源码增长暴露了这一既有/当前未提交选择算法与 real-repo 测试夹具的容量脆弱性。它不是会话 transport 或 UI 交互逻辑错误，但也不能表述为“完全与本次增量无关”。本任务不顺手修改 Graph 生产算法；在 Graph 使用受控夹具或另行修正 picker 前，全量测试仍必须记录为失败。

本轮还完成多轮独立安全复核并关闭已发现的重要问题：直接 API 绕过 Renderer 的 command/file/MCP accept、file `grantRoot` 扩权、畸形 canonical MCP/RUI schema 与 envelope、MCP 原型链字段偏差、外部 URL userinfo/query/hash 泄漏、lax date-time、server request identity 冲突、`clientId=null` 持久化收敛、file session scope，以及 resolved request 被迟到详情刷新复活，均已有 RED/GREEN 回归。最终综合审查结论为 **Approved**，当前审查范围无 Critical / Important / Minor；完整 Electron 默认浏览器点击仍属于未覆盖现场，不能以源码链路测试替代 OS live 证据。

### 10.3 渲染现场验证

通过本地真实渲染页而非静态 DOM 字符串验证：

- 1440×900、768×900、375×812、320×700 均无页面级水平溢出；
- 移动抽屉 focus-in / `Esc` close / focus-return 正常；
- 320px thread、composer、header 均在视口内，审批 action wrap；
- 深色主题文字与侧栏可读，project sidebar `overflow-x: hidden`；
- CDP 模拟 `prefers-reduced-motion: reduce` 后动画近即时、smooth scroll 关闭；
- 最终干净页面 console 无 error / warning。

验证截图只作为 `/tmp` 现场证据，不是 Telegram 主交付。Telegram 主交付仍为仓库内单文件 HTML：`docs/TASK_20260710_001_Zeus会话页与CodexAppServer对齐开发设计.html`。

### 10.4 仍未覆盖的发布验收

1. **当前模型 live probe 未稳定闭环。** 最新显式 opt-in 安全 probe 的 4 项本地 guardrail 通过，但真实三轮/resume/双 thread/延迟 interrupt 场景在 `180000ms` 超时，另有 2 项 approval/permissions probe 跳过；较早 probe 曾在同一 thread 观察到 3 个 completed turn 和不同 turnId，但关闭清理挂起。没有证据足以把最新 live contract 标记为通过。
2. **真实 Electron 主路径未完整验收。** 尚未在正式 Electron 窗口逐项完成新建、resume、新 thread、legacy reference、Queue/Steer、Stop、崩溃恢复、Fastify 换端口与显式完成 Task。
3. **可访问性与像素级对照未完成。** 键盘/focus/reduced-motion 已验证，但 VoiceOver 冒烟及当前 Codex GUI 同视口逐像素对照未执行，因此不能声称“视觉和所有交互细节完全一致”。
4. **发布与回滚演练未完成。** 未执行 `pnpm package:mac`、`codesign --verify` 和人工 kill-switch 演练；自动化已覆盖关闭写入口、fail-closed 与退出清理，但不能替代发布现场。
5. **Manager → coordinator 的真实事件集成测试仍缺一层。** 两端分别有 deterministic 回归，接口静态对齐；但 identity conflict 目前尚无 fake process stdout → manager event → coordinator durable recovery 的整链自动化，不能用分层测试替代该集成证据。

### 10.5 当前结论

`IMPLEMENTATION: NATIVE VERTICAL SLICE IMPLEMENTED; RELEASE VERIFICATION INCOMPLETE`

native app-server、连续 thread/turn、持久化、REST/WS、Renderer 主状态机和响应式会话 UI 已形成垂直实现，并通过针对性回归、静态检查、构建和渲染现场验证。由于全量 Graph 测试仍有 16 个失败，且最新 live provider、完整 Electron、VoiceOver、打包/codesign 与人工回滚未闭环，本轮不能宣称原始需求“全部完成”或“完全与 Codex App 一致”。

### 10.6 2026-07-14 真实运行包：会话历史选择门禁错配

#### 用户可见现象

当前运行的 `dist/mac-arm64/Zeus.app` 在 `tc-app-core` 项目会话页展示顶部错误：

```text
This task already has conversation history. Choose an exact conversation to resume, reference legacy history, or explicitly create a new conversation.
```

界面仅把它展示为“本地操作失败”，没有在当前动作处提供“续接 native 历史 / 引用 legacy 历史 / 显式新建”选择。

#### 运行现场与数据证据

1. 运行实例为 `dist/mac-arm64/Zeus.app`，主进程 PID `88605`，监听 `127.0.0.1:61113`；`app.asar` 修改时间为 `2026-07-13 17:52:42 +0800`。
2. 截图中的 `project_ek6ezGYuaqM_` 是 `tc-app-core` 项目 ID，不是 task/conversation ID。对应本地路径为 `/Users/david/cckg/tcapp/Back-End/tc-app-core`。
3. 截图时间和消息唯一对应 `task_p-vaz0t3C-OV`。该 Task 已有 `conversation_p6qPtZMdBjES` 与 `conversation_CdhngubagPXj` 两条历史；两者均为 `status=failed`、`transport_kind=legacy_cli`、`provider_state=unbound`，且 `session_id IS NULL`、`provider_thread_id IS NULL`。
4. 该 Task 对应的 native turn/item/submission/server-request 数量都是 `0`。因此当前错误不是“已存在 native thread 但 `thread/resume` 失败”。

#### 已确认故障链

1. 当前运行包的会话主画布仍使用旧 Renderer 动线；`app.asar` 中的 Renderer bundle 不包含 `/conversation-choices`、`session-start-surface`、`session-codex-parity-v1` 或“选择要引用的旧消息”。
2. 旧动线由 `apps/desktop/src/renderer/main.tsx:138-145` 调用 `client.runTask(taskId)`，`apps/desktop/src/renderer/apiClient.ts:1510-1513` 将它发送到 `POST /api/tasks/:taskId/run`。
3. 同一 `app.asar` 内的 local-server bundle 已包含新保护：`packages/local-server/src/index.ts:2912-2916` 只要看到任何未归档历史就返回 `409 ZEUS_CONVERSATION_CHOICE_REQUIRED`。
4. `apps/desktop/src/renderer/App.tsx:6760-6762,7790-7793` 把 API 错误收敛为顶部全局 banner，因而出现用户截图。

#### 根因裁决

- **已确认根因 R1：运行包内的 Renderer 与 local-server 会话启动契约错位。** 后端已正确强制显式历史选择，但当前打包 Renderer 还在调用不携带选择的兼容 `/run`。
- **已排除 H1：native `thread/resume` 失败。** 该 Task 没有 native provider thread 或 native 运行记录，请求在调用 provider 前已被 409 拒绝。
- **已排除 H2：旧的“工作目录不在允许目录”直接导致本次 banner。** 那是 2026-07-09 的 legacy Runtime 历史消息；本次 409 在 Runtime 启动前返回。
- **当前源码残余风险 H3：待开发验证。** 新 `SessionWorkspace` 已实现显式选择，但 Task 详情的“创建 app-server 会话”仍经 `TaskDetailDrawerContent.tsx:92-96,205-215` 调用 `controlTaskRuntime(..., 'run')`，必须在 develop 中用失败测试确认是否仍可绕过新选择器。

#### 本轮验证

```bash
pnpm vitest run packages/local-server/test/codex-native-conversation-api.test.ts apps/desktop/test/session-workspace.test.tsx --reporter=verbose
```

结果：`2 passed / 68 tests passed`。它证明当前源码中的后端门禁与新会话选择器各自符合契约，但不能代替打包 App 的真实端到端验收。

#### Readiness 与待确认开发边界

`READINESS: READY FOR DEVELOP CONFIRMATION`

推荐的最小修复边界是：

1. 任何“创建 app-server 会话”入口遇到历史时，先进入统一的显式选择界面，不再把预期分支降级为全局错误 banner；
2. 保留服务端 `409 ZEUS_CONVERSATION_CHOICE_REQUIRED` 作为最后一道 fail-closed 保护；
3. 重新生成打包产物，并在真实 Electron 中验收 legacy 只读、引用 legacy 新建 native thread、显式新建、精确 resume 与无全局错误 banner；
4. 回滚时关闭 native 写入只保留历史只读，不回退到静默选最新会话、`codex exec` 或最近消息重放。

#### 2026-07-14 develop 实施与验证结果

本轮已按确认范围实施，未修改服务端 `409 ZEUS_CONVERSATION_CHOICE_REQUIRED` 安全契约：

1. `apps/desktop/src/renderer/App.tsx:4488-4490` 新增纯路由决策：`run -> conversation_chooser`，其余控制动作继续走 `runtime_api`。
2. `apps/desktop/src/renderer/App.tsx:6608-6627` 的 Task 会话准备入口会定位目标 project/task、清空已选 conversation、打开统一 draft chooser、关闭 Task 抽屉并切换到 `#project-sessions`。
3. `apps/desktop/src/renderer/App.tsx:6738-6752` 在任何 Runtime handler 映射前拦截 `run`，因此 Task 详情的“创建 app-server 会话”不再调用兼容 `/run`；`pause/continue/cancel/retry` 保持原专用 API。
4. 独立 review 发现批量 `ready -> running` 仍是兼容 `/run` 旁路。现已在 `apps/desktop/src/renderer/task/taskWorkspaceModel.ts:11-17` 禁止该批量迁移，并在 `apps/desktop/src/renderer/App.tsx:6811-6818` 删除 ready task 的 `onRunTask` 执行分支；paused/waiting_confirmation 的 continue 语义保留。
5. 回归测试新增于 `apps/desktop/test/app-task-controls-rendering.test.tsx:2624-2651` 与 `apps/desktop/test/task-workspace-model.test.ts:133-160`。

TDD 证据：

- 第一次 RED：无 conversation 的 `run` 导航返回 `undefined`，`1 failed / 64 passed`；
- 第一次 GREEN：`65 / 65`；
- review 修正 RED：纯路由函数缺失、批量 ready task 仍可进入 running，共 `2 failed / 82 passed`；
- review 修正 GREEN：`84 / 84`；
- 扩大相关回归：`4 files / 152 tests passed`；
- `pnpm typecheck`、受影响文件 ESLint、Prettier 均通过；
- 独立 reviewer 第二轮结论：无 Critical/Important，`Ready to merge: Yes`。

发布与打包证据：

- `pnpm verify:acceptance-matrix`：`12 sections / 139 items` 通过；
- `pnpm lint`：通过；
- `pnpm verify:release`：未通过。全量 Vitest 为 `1302 passed / 3 skipped / 16 failed`，失败仍集中在已知的 `packages/graph-engine/test/graph.test.ts` 与 `packages/local-server/test/graph-view-api.test.ts` 图谱断言，本轮不能宣称完整 release gate 通过；
- 安全退出旧 Zeus 后单独执行 `pnpm package:mac`：成功；新 `app.asar` 修改时间为 `2026-07-14 09:29:24 +0800`，ad-hoc codesign 校验通过；
- 新包 Renderer `index-BgzdMIN6.js` 已确认包含 `/conversation-choices`、`session-start-surface`、`session-codex-parity-v1`、`conversation_chooser` 与“选择要引用的旧消息”；
- 包内 Electron 加载与 `scripts/verify-packaged-app-health.mjs` 均通过。

真实 GUI 验收尚未完成：Computer Use 返回“Mac is locked”，无法读取或点击 Zeus 窗口。当前状态为：

`IMPLEMENTED: SOURCE AND PACKAGE VERIFIED; GUI VERIFICATION BLOCKED BY LOCKED MAC`

### 10.7 2026-07-14 会话列表布局回归修复与真实 GUI 验收

#### 用户可见回归

点击项目“会话”后，任务与历史会话被直接展开在全局项目侧栏下方，右侧只剩“先选择一个真实任务”。这破坏了既有的“项目导航 + 会话列表 + 当前对话”三段信息架构。

#### 根因与修正

1. 根因：此前 Codex app-server 对齐改动把 `ProjectConversationTree` 从会话页中栏迁入 `SidebarNav`，并让移动端 source rail 直接移动整个项目侧栏；桌面 `.workspace-view-project-sessions` 同时被强制成单列。
2. `SidebarNav` 现只保留项目与“任务 / 代码 / 会话”二级导航，不再接收或渲染会话树。
3. `workspace-view-project-sessions` 恢复独立 `session-list-pane + conversation-detail-pane`；中栏只渲染 `activeProjectId` 的真实任务/会话。
4. `selectedNativeConversation` 增加项目归属 fail-closed 约束，切换项目后旧项目会话不能继续驱动右侧详情。
5. 小于 760px 时只把 `session-list-pane` 变为抽屉；空项目时抽屉自身可获得焦点，Tab 不会逃逸，Escape 关闭后恢复到触发器。
6. native app-server、legacy 只读历史、引用 legacy 新建和服务端 `ZEUS_CONVERSATION_CHOICE_REQUIRED` 门禁均未改动。

#### TDD、review 与验证证据

- RED 1：结构测试确认项目主侧栏仍包含 `session-project-conversation-tree`；GREEN 后树只存在于会话页中栏。
- RED 2：CSS 契约确认 desktop sessions 仍为单列；GREEN 后为 `minmax(236px, 280px) minmax(0, 1fr)`，窄屏仅移动 `.session-list-pane`。
- 首轮独立 review 发现两个 Important：跨项目残留详情、空态移动抽屉无焦点目标；补回归并修正后，二审无 Critical/Important，`Ready: Yes`。
- 相关回归：`4 files / 283 tests passed`；完整 `renderer.test.tsx`：`71 / 71 passed`；`pnpm lint`、`pnpm typecheck`、desktop production build、受影响文件 `git diff --check` 均通过。
- 完整 `pnpm verify:release` 未通过：本次同步 3 条过期 Renderer 布局断言后，剩余为 16 条既有 Graph Engine / Graph View 断言，因此不宣称完整 release gate 通过。

#### 打包与真实 GUI

- 安全退出旧 Zeus 后执行 `pnpm package:mac` 成功；新 `app.asar` 时间为 `2026-07-14 10:09:23 +0800`。
- `codesign --verify --deep --strict`、`scripts/verify-packaged-app-health.mjs`、包内 `session-project-conversation-list` / `session-list-pane` / `conversation_chooser` / `/conversation-choices` 标记检查均通过。
- 新包真实 GUI：全局项目侧栏只显示项目和二级入口；`tc-app-core` 的任务/历史显示在独立中栏；选择 legacy 行后右侧显示“旧会话记录为只读”及真实消息；切换到 `Zeus E2E` 后旧详情清空。

当前状态：

`VERIFIED: SESSION MIDDLE COLUMN RESTORED IN PACKAGED GUI`

回滚只限本次 `App.tsx`、`styles.css` 与对应测试/文档；不得回退历史选择门禁、native/legacy 会话边界或覆盖工作区其他未提交改动。

### 10.8 2026-07-14 旧 Codex Runtime thread 一对一迁移

#### 用户确认口径

用户确认“和 Codex 一致”：历史会话的稳定身份必须是真实 provider `threadId`；跨进程通过 `thread/resume` 恢复，同一 thread 后续只追加新的 turn。禁止把旧消息重新拼成 prompt 后冒充续接。

#### 新发现的真实证据

此前文档把 4 条 legacy conversation 都归类为“没有 provider threadId，无法真实 resume”。本轮继续检查本机 Runtime 事实源后发现：

1. `task_9O3wWTaDPe6k` 的 3 个旧 `codex exec` Runtime 日志分别保存了真实 Codex UUID：
   - `019f456e-599f-7872-a6f8-3a4bd0937c44`
   - `019f461b-9a85-7983-9779-e4bd0fff6676`
   - `019f463f-5e6f-75c0-b168-34b375e54be2`
2. 三个 UUID 都存在对应 `~/.codex/sessions/.../rollout-*.jsonl`。
3. 使用当前 `/opt/homebrew/bin/codex`（`codex-cli 0.144.1`）逐个执行只读 `thread/resume + thread/read`，3/3 成功且返回相同 threadId；每个 snapshot 含 1 个真实 turn。
4. 旧 Zeus 的 `conversation_J6csTLig505N` 实际聚合了两个不同 Codex thread。因此不能把它原地绑定到“最新一个”；与 Codex 一致的唯一安全模型是一个 provider thread 对应一个 native conversation。

#### 实现

1. 新增 `packages/local-server/src/legacyCodexThreadMigration.ts`：
   - 只依据 `task_events.payloadJson` 中明确的 `conversationId + runtimeSessionId` 关联，不按标题、cwd 或时间猜测；
   - 只接受 `codex exec` Runtime 日志中的唯一合法 UUID；0 个或多个不同 UUID 均 fail-closed；
   - 先调用 `thread/resume + thread/read` 验证相同 threadId 和 idle snapshot，再创建 native conversation；
   - 每个 thread 单独持久化 provider path/model/version、turn、item、provider user message 和 legacy source；
   - 使用稳定导入键和 `provider_thread_id` 唯一索引保证重复启动幂等；
   - 同一 legacy 来源的全部已发现 thread 成功导入后才归档来源，任何部分失败都保留来源只读可见。
2. `packages/local-server/src/index.ts` 在 native coordinator 创建后、恢复现有 native conversation 前执行迁移；审计日志只记录数量和跳过原因，不记录 prompt、token 或 provider payload。
3. 会话页布局和交互未新增展开树、卡片或迁移弹窗。迁移成功的记录直接进入现有两栏列表，`transportKind=codex_native`、`resumable=true`；发送时复用原 threadId 调用 `turn/start`。

#### TDD 与回归证据

- RED 1：迁移模块不存在，`legacy-codex-thread-migration.test.ts` 因 `ERR_MODULE_NOT_FOUND` 失败。
- GREEN 1：一对多拆分、幂等、部分失败不归档、歧义日志 fail-closed，`3 / 3 passed`。
- RED 2：local-server 尚未接入迁移，启动级 API 测试只返回 1 条 legacy choice，期望 2 条 native choice。
- GREEN 2：启动后返回两个 resumable native choice；选择其中一个发送时 `threadStarts=[]`，`turnStarts` 使用所选旧 threadId。
- 迁移与 native API：`2 files / 33 tests passed`。
- 会话迁移、coordinator、API、Renderer workspace/controller：`5 files / 143 tests passed`。
- 完整 `packages/local-server/test`：`20 files / 271 tests passed`。
- `pnpm typecheck`：通过。
- 受影响文件 ESLint：通过。

收尾 review 又识别并关闭 3 个 Important fail-closed 边界：

1. task event 指向其他项目或任务的 Runtime 时拒绝迁移；
2. Runtime 日志缺失真实 provider model 时拒绝迁移，避免下一次 `turn/start` 使用伪造模型；
3. provider snapshot 的 turn 缺少真实 user message 文本时整条候选事务回滚，不再生成任何占位 submission 文本。

三项均先写失败测试，RED 为 `3 failed / 3 passed`，修正后 `6 / 6 passed`。扩大后的迁移、native API、coordinator 与任务控制回归为 `4 files / 101 tests passed`；`pnpm typecheck`、全量 `pnpm lint`、全量 `pnpm format:check` 与 `git diff --check` 均通过。

完整 `packages/local-server/test` 当前为 1 条与本次迁移无关的既有 Graph View 失败：`returns try-to-finally cleanup branch edges in the method logic view` 在 `packages/local-server/test/graph-view-api.test.ts:738` 找不到 `selectTryNode`；单独重跑仍失败。本次未修改 Graph 扫描或该测试，因此不得把完整 local-server suite 报为全绿。

#### 真实数据库副本验收

开发验证阶段先不修改用户数据库：使用 SQLite `.backup` 创建临时副本，并在副本上通过真实 app-server 执行迁移：

- active `codex_native`：3 条，threadId 与上述 3 个 UUID 完全一致，`provider_state=ready`；
- archived `legacy_cli`：2 条，分别为 `conversation_d72B1AnJpAmd` 与 `conversation_J6csTLig505N`；
- active `legacy_cli`：2 条，均为没有真实 thread 的失败历史，继续只读；
- 导入 3 turns、13 items、3 submissions；
- 临时副本验收后已删除，真实用户数据库保持未修改。

用户确认方案 1 且新包完成后，先生成可回滚备份：

`~/Library/Application Support/@zeus/desktop/zeus.db.pre-codex-thread-migration-20260714-1108.bak`

随后启动新包对真实数据库执行同一迁移，现场结果与副本一致：active `codex_native=3`、archived `legacy_cli=2`、active `legacy_cli=2`，并持久化 `3 turns / 13 items / 3 submissions`。3 条 native conversation 的 `providerThreadId` 与已验证 UUID 完全一致，`providerModel=gpt-5.5`、`providerState=ready`。

#### 打包与真实 GUI 验收

- 安全退出旧 Zeus 后执行 `pnpm package:mac` 成功；新 `app.asar` 时间为 `2026-07-14 11:07:30 +0800`。
- `codesign --verify --deep --strict` 与 `scripts/verify-packaged-app-health.mjs` 均通过；包内存在迁移审计、`missing_provider_model`、`runtime_ownership_conflict` 标记，且不存在被禁止的 `Imported provider turn` 占位文本。
- 新包真实 GUI 的项目侧栏保持原有结构，会话仍位于独立中栏，没有回退为项目下方展开列表。
- `tc-app-core` 中栏显示 3 条“会话就绪”的 native 历史与 2 条“旧会话，只读”的无 thread 失败历史；点击任一迁移后的历史，右侧直接显示真实 provider 对话记录与“发送消息给 Codex”输入框，不再显示“开始 native 会话 / 引用旧会话”表单。

当前状态：

`VERIFIED: THREE REAL CODEX THREADS MIGRATED AND RESUMABLE IN PACKAGED GUI`

#### 回滚

- 停止 startup migration 即可阻止新增迁移；已导入的 native conversation 仍绑定真实 Codex thread，不删除、不改 rollout。
- 如需恢复旧列表，可 restore 被归档的 legacy source；native conversation 继续保留，避免破坏已经发生的原生续接。
- 任一候选出现归属冲突、多个 UUID、provider 无法 resume 或 snapshot 非 idle 时，迁移器不归档来源。

### 10.9 2026-07-14 “无法创建新会话”运行现场诊断

#### 现象与候选根因

用户在已迁移出 3 条 native 历史的任务上认为无法创建新会话。只读诊断先区分两个候选：

1. H1：任务标题右侧“＋”点击事件失效，没有进入创建状态；
2. H2：点击只打开草稿表单，但显式历史选择和首条消息门禁让提交按钮保持 disabled，因此视觉上像“无法创建”。

#### 真实复现与裁决

- 通过真实打包 Zeus 的可访问性树点击 `新建会话: 分析当前项目结构`，右侧稳定切换到“开始 native 会话”表单，H1 排除。
- 当前任务已有 3 条 native 历史；`initialSessionStartMode(...)` 对“已有 choices、没有 initialChoice”的返回值是 `null`，所以“新建会话”和三条“续接此会话”默认全部未选。
- `SessionWorkspace.tsx` 的提交按钮同时要求：已选择 mode、首条消息非空、续接时已选具体 conversation、引用 legacy 时已选消息。未满足时“开始并发送”保持 disabled。
- 真实界面中选择“新建会话”并输入未发送诊断草稿后，“开始并发送”立即启用；清空草稿并返回原历史会话后，数据库 active conversation 数仍为 3，没有产生空 thread。
- local-server 的 `mode=create` 会在请求被接受时创建 durable conversation/provider thread；单击“＋”本身不写数据库。这个“首条消息发送时才创建 thread”的生命周期与 Codex 原生语义一致。

#### 根因

当前不是 provider、迁移或 API 创建失败，而是两步式创建门禁的可发现性不足：

1. “＋”只打开创建草稿，不会立即生成空会话行；
2. 已存在历史时为防止静默 fork，必须再次显式选择“新建会话”；
3. 必须输入第一条消息后才能提交；界面没有在 disabled 按钮附近解释缺失条件。

本轮只完成诊断，未修改源码。若进入 develop，需先确认是保留严格显式选择并增强引导，还是让任务级“＋”直接预选 create；不得改成单击即创建没有首条消息的空 provider thread。

### 10.10 2026-07-14 新建会话选择行视觉方案确认

用户确认采用方案 1：把被全局 input 样式拉伸的模式 radio 修正为 macOS source-list 风格紧凑选择行。范围只包含 `StartConversationSurface` 的 radio JSX 标识、会话页局部 CSS 和对应测试；保留显式历史选择、首条消息门禁和 provider thread 在首次发送时创建的现有语义。

设计书：`docs/superpowers/specs/2026-07-14-session-start-choice-row-design.md`。

实施计划：`docs/superpowers/plans/2026-07-14-session-start-choice-row-visual-fix.md`。

故障排查图：`docs/TASK_20260710_001_会话模式单选项样式污染故障排查.html`。该图按真实截图与源码锚点串起“现象 → 全局 CSS 覆盖 → 局部未复位 → 根因 R1 → 修法 F1 → 验证与回滚”，并同步自动验证、打包证据与待解锁 GUI 验收状态。

#### 实施与验证证据

- TDD RED：新增 DOM/CSS 契约后，聚焦测试为 `2 failed / 39 skipped`；失败分别指向 `session-start-radio` 缺失和选择行仍为 `display:flex`。
- 最小修复：只在 create 与 choices map 两处 radio 增加 `session-start-radio`；局部 CSS 将选择行改为 `18px minmax(0, 1fr)` 两列 grid，radio 固定 14px，并补 selected、focus-visible、disabled 与长标题换行。
- TDD GREEN：首轮聚焦 `3 passed / 38 skipped`；结构化 review 发现长无空格历史标题可能溢出，补充契约后再次得到预期 RED，再以 `min-inline-size:0 + overflow-wrap:anywhere` 修正并 GREEN。
- 相关回归：`apps/desktop/test/session-workspace.test.tsx + app-shell-layout.test.tsx` 为 `2 files / 201 tests passed`。
- 静态门禁：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check` 均 exit 0。
- 结构化 review：长标题窄窗溢出 Important 已关闭；未发现剩余 Critical / Important。legacy checkbox 未获得 radio 类，`mode`、`selectedChoiceId`、首条消息门禁与提交 payload 未修改。
- 安全退出旧 Zeus 后执行 `pnpm package:mac` exit 0；新 `app.asar` 时间为 `2026-07-14 11:48:32 +0800`，DMG/ZIP 时间为 `2026-07-14 11:48:41 +0800`。
- `codesign --verify --deep --strict` 与 `scripts/verify-packaged-app-health.mjs` 均 exit 0；生产 CSS 和 `app.asar` 均包含 `session-start-radio` 与两列 grid 标记。
- 真实 GUI 验收待完成：启动新包时 Mac 处于锁屏状态，Computer Use 明确返回无法自动解锁；因此当前不宣称 packaged GUI 已验收。

当前状态：

`VERIFICATION BLOCKED: UNLOCK MAC FOR PACKAGED GUI CHECK`

回滚只限 `SessionWorkspace.tsx` 的两个局部类名、`session.css` 的选择行/radio/focus/disabled/换行规则及对应测试；不得触碰会话选择门禁、provider thread、legacy 归档或数据库。

### 10.11 2026-07-14 Codex 0.144.1 外部旧会话导入与原生续接取证

#### 用户最新口径

用户要求旧会话交互与 Codex 的真实实现一致：用户选中已有会话后直接发送即续接；进入新建会话后发送即创建，不再要求在正文上方重复选择“新建 / 续接 / 引用”模式。

#### 官方源码版本与真实实现

本轮将本机 `codex-cli 0.144.1` 对齐到 OpenAI 官方仓库标签 `rust-v0.144.1`，对应 commit `44918ea10c0f99151c6710411b4322c2f5c96bea`。源码证明 Codex 对没有既有 native threadId 的外部会话采用一次性、持久化迁移，不采用 Zeus 当前的首轮 `additionalContext` 近似：

1. `external-agent-sessions/src/records.rs:110-210` 读取外部 JSONL，保留符合条件的 user/assistant 消息；meta、sidechain 和 thinking 不进入对话历史，工具调用与结果转换为有长度上限的文本说明。
2. `external-agent-sessions/src/export.rs:73-159` 按 user 消息切分 synthetic turn，生成 user/assistant `ResponseItem` 以及 turn started/completed 事件；assistant 消息只有位于已开始的 user turn 内才导入。
3. `app-server/src/request_processors/external_agent_session_import.rs:163-289` 生成新的 `ThreadId`，以 `ThreadHistoryMode::Legacy` 创建 durable thread，将转换后的 rollout items 追加到 thread store，写入标题、preview、cwd 等 metadata，持久化并关闭该 thread。
4. `external-agent-sessions/src/ledger.rs:15-100` 以 canonical source path、内容 SHA-256 和 imported threadId 记录幂等账本。
5. 导入完成以后，该记录已经是普通 native thread；后续打开并发送使用 `thread/resume` / `turn/start`，不再次重放旧消息，也不再展示每条会话的续接模式选择器。

因此，Codex 的两类“旧会话”必须分开：

- 本来就有真实 threadId 和 rollout 的 Codex 会话：直接 `thread/resume`。Zeus 10.8 已完成此类 3 条历史的迁移。
- 只有外部消息、没有 threadId 的 legacy 会话：先导入为一个新的 durable native thread，再按普通会话续接。不能把 legacy id 当作 threadId，也不能在用户第一次发送时把整段历史塞入 `additionalContext` 冒充同一 thread。

#### Zeus 当前差异

1. `packages/ai-runtime/src/codexAppServerManager.ts:515-599` 目前只暴露 `thread/start`、`thread/resume`、`thread/read` 和 `turn/start`，没有 `externalAgentConfig/import` 请求与 completed notification 的类型化封装。
2. `packages/local-server/src/legacyCodexThreadMigration.ts:84-200` 只迁移 Runtime 日志里已经存在、且可以真实 resume 的 provider thread；没有 threadId 的 legacy 会话仍会跳过。
3. `packages/local-server/src/codexNativeConversationCoordinator.ts:252-293,366-378,468-509` 当前“引用旧会话”会创建新 thread，并在首个 `turn/start` 通过 `additionalContext.kind=untrusted` 注入用户选择的历史；该语义与 Codex 0.144.1 的持久化导入不同，后续方案必须替换，不能继续把 radio 样式修复当作最终行为。

#### 官方 API 的兼容边界

Codex 0.144.1 虽暴露实验性 `externalAgentConfig/import`，但不是任意历史注入 API：

- schema 要求 `SESSIONS` migration item 内提供 `{path,cwd,title}`，完成通知的 success `target` 才返回新 threadId；
- `external_agent_config_processor.rs:374-437` 在导入前调用 source-path 验证；
- `external_agent_config.rs:218-236,1266-1271` 只接受 `~/.claude/projects` 目录下的 `.jsonl`；
- `external-agent-sessions/src/detect.rs:13-108` 的自动检测还限制最近 30 天、最多 50 条。

所以 Zeus 不能把 SQLite 里的 legacy messages 原样调用该 API，也不能未经用户授权向真实 `~/.claude` 写伪造来源文件。若要达到同一持久化语义，需要先确认导入触发方式与兼容策略，再进入设计和 develop。

#### Readiness Gate

已确认：目标交互、Codex native resume 语义、外部历史导入语义、Zeus 当前差异、公开 API 的输入与目录限制。

阻塞项：没有 threadId 的 Zeus legacy 会话是采用与 Codex 产品一致的“用户显式执行一次全局导入”，还是由 Zeus 启动时自动迁移。两者会改变用户授权、外部目录写入、失败恢复与回滚边界，不能静默假设。

`READINESS: BLOCKED`

### 10.12 2026-07-14 Codex App 对齐的长期默认决策

用户明确要求：Zeus 会话系统的内部实现逻辑不再逐项询问；只要当前 Codex App 存在可验证实现，默认答案一律是“与 Codex App 保持一致”。

该长期决策适用于：

- Electron 与 Rust app-server 的职责边界；
- thread / turn / item 生命周期；
- 新建、恢复、分叉、归档、导入与持久化语义；
- rollout、metadata、状态索引与幂等账本的所有权；
- 崩溃恢复、失败回滚、版本兼容和用户可见交互；
- Rust app-server 的随包分发、版本固定与升级策略。

后续执行规则：

1. 先检查当前安装的 Codex App、其内置 `codex` 二进制以及对应版本的 OpenAI 官方源码，取得真实行为和实现边界；
2. 能够确认的内部技术选择直接按 Codex App 落地，不再要求用户从多个内部方案中选择；
3. 不得把“接近 Codex”或 Zeus 自造的兼容逻辑写成“与 Codex App 一致”；无法验证时必须标注待确认；
4. 只有当精确对齐需要新的外部授权、破坏性数据迁移、不可逆远端动作，或 Codex App 行为本身无法取得证据时，才把最小必要阻塞提交给用户；
5. 本节取代 10.11 中“显式全局导入或启动时自动迁移由用户选择”的阻塞项。导入触发方式应通过 Codex App 真实行为取证后直接采用，不再作为内部实现问题询问用户。

当前已经确认的架构方向：Zeus 继续保持 Electron 产品层，并随应用内置固定版本的 Codex Rust app-server；会话的运行时状态和持久化由 Rust 边界统一拥有。是否需要最小扩展以及扩展形状，必须以对应版本 Codex App / 官方源码的真实导入实现为依据。

`READINESS: CONTINUE CODEX APP EVIDENCE COLLECTION; NO INTERNAL-CHOICE QUESTION`

### 10.13 2026-07-14 当前 Codex App 的真实旧会话导入交互与目标架构

#### 现场版本与协议证据

本轮只读取证确认当前安装的 `/Applications/Codex.app` 构建号为 `5263`，包版本为 `26.707.71524`；应用内置 `/Applications/Codex.app/Contents/Resources/codex`，版本为 `codex-cli 0.144.2`。运行中的 Codex App 直接启动该 bundle 内二进制的 `app-server`，不是读取 Homebrew 或用户 PATH 中的 Codex CLI。

使用内置二进制执行 `app-server generate-ts` 后，0.144.2 的真实协议包含：

- `externalAgentConfig/detect`；
- `externalAgentConfig/import`，返回 `importId`；
- `externalAgentConfig/import/progress`；
- `externalAgentConfig/import/completed`；
- `externalAgentConfig/import/readHistories`；
- `SessionMigration = { path, cwd, title }`；
- 会话导入成功项的 `target` 为新建的 native `threadId`。

当前 App bundle 的调用链进一步确认：导入入口位于 onboarding 和 Settings 的 “Import from other AI apps”，用户显式选择 “Chat sessions” 后才执行 import；App 按 `importId` 等待 completed，选择会话导入时超时为 120 秒，成功后刷新 recent conversations。它不是启动时自动迁移，也不是旧会话第一次发送消息时再迁移。

#### 对当前 UX 争议的直接结论

会话正文上方的“新建会话 / 续接此会话 / 引用旧会话”单选项没有必要，也不符合 Codex App：

1. 新建入口发送第一条消息即 `thread/start` + `turn/start`；
2. 已有 native thread 的会话发送即 `thread/resume` + `turn/start`；
3. 无 threadId 的 legacy 会话先在 Settings/onboarding 显式导入一次，成功后已经是普通 native thread；
4. 尚未导入或导入失败的 legacy 记录保持只读，并只提供前往导入入口的动作，不在正文里建立另一套模式状态机。

因此，当前 `additionalContext` 引用历史、per-thread mode radio、启动时自动迁移和首发懒迁移都退出最终方案。

#### 最终采用的内部架构

Zeus 采用 Codex App 同一产品边界和同一协议形状：

1. Zeus Electron 负责 Settings/onboarding、legacy eligibility、不可变 source snapshot、进度展示和 source → native thread 映射；
2. Zeus 随包分发固定版本、按架构装配并签名的 Rust `codex app-server`，不依赖系统 CLI，也不读取另一个 App bundle；
3. 在 pinned app-server 内增加窄范围 `zeus-legacy` source provider，复用官方 `externalAgentConfig/detect/import`、records/export、ThreadStore 和 ledger，不新增此前图中假设的 `thread/import` RPC；
4. Zeus 不伪造 `~/.claude/projects`，不手写 `~/.codex/sessions`；导入源位于 Zeus Application Support 专用目录并执行路径、schema、hash、cwd 和 symlink 校验；
5. success.target 返回后，Zeus 必须再以 `thread/read` 验证可发现、可读，才在数据库事务内写回 mapping 并归档 legacy source；失败或部分失败均保留 legacy 只读记录；
6. import history + Rust ledger + Zeus mapping 共同支持幂等和崩溃恢复。

完整职责、数据、错误、打包、验收和回滚设计见：

`docs/superpowers/specs/2026-07-14-zeus-codex-app-session-runtime-parity-design.md`

#### 版本证据边界

OpenAI 官方 release `rust-v0.144.2` 已确认存在，annotated tag object 为 `06eee5f70addf0b8cf331d5c6721f0414e7d2ae6`，指向完整 commit `a6645b6b8a656360fa16fb7e1c6721d0697d3d6a`。该 release 的公开 diff 只回滚 Guardian prompting 并把 workspace version 更新为 0.144.2；会话导入实现沿用已核对的 0.144.1 边界。后续实现必须 pin 完整 commit 并记录 Zeus patch，禁止依赖 floating branch 或把临时目录当供应链来源。

#### Readiness Gate

目标、真实 App 交互、协议、现状差异、架构边界、数据一致性、错误恢复、打包成本、验收与回滚均已明确。逐文件 TDD implementation plan 已写入 `docs/superpowers/plans/2026-07-14-zeus-codex-app-legacy-import-parity.md`；仍不得在未获用户明确 develop 确认前修改源码、测试、构建、依赖或数据。

`READINESS: READY FOR DEVELOP CONFIRMATION; DEVELOP NOT AUTHORIZED`

### 10.14 2026-07-14 Codex App 一致性实现与真实 Rust 验证

用户已明确确认 develop。本轮按 10.13 的已确认架构完成实现，且纠正了计划中的一个过度设计：不新增 Zeus 自定义 Rust JSONL parser，而是用最小补丁把官方 external-agent importer 的 home 指向 Zeus Application Support 私有目录，继续使用官方 Claude-compatible records/export、ThreadStore 与 ledger。

#### 已实现

1. 固定并构建 Codex `0.144.2` / commit `a6645b6b8a656360fa16fb7e1c6721d0697d3d6a`；manifest 校验版本、架构、SHA-256、协议 schema 与补丁清单。
2. Rust patch 只增加绝对路径 `ZEUS_CODEX_EXTERNAL_AGENT_HOME`；相对路径 fail-closed，不回退用户真实 `~/.claude`。
3. app-server manager 类型化封装 `detect/import/readHistories` 及 progress/completed；启动后固定 import root，禁止中途切换。
4. local server 写入 `custom-title` + user/assistant 的官方兼容 JSONL，执行 canonical root/cwd、0600、原子 rename、SHA-256、幂等、失败重试与启动恢复。
5. import success 必须先 `thread/read` 验证，再在 SQLite 事务内建立 native conversation、复制消息并归档 legacy source；任何失败保留旧记录只读。
6. Electron 打包路径固定使用随包 Rust runtime，不再读取用户 Runtime 设置里的 CLI 路径作为 native conversation engine。
7. 会话页删除“新建 / 续接 / 引用”模式单选：空白入口首发创建；已存在 native 会话继续使用 composer 自动 resume；legacy 只读记录跳转设置导入。
8. Runtime 设置增加旧会话导入区，支持候选选择、真实进度、失败原因、重新检查与失败后重试。

#### 真实验证证据

- UI/存储/导入服务聚焦回归：`4 files / 71 tests passed`。
- TypeScript project references：`pnpm typecheck` exit 0。
- 真实 bundled Rust 探针：
  - 命令：`ZEUS_LIVE_CODEX_IMPORT_PROBE=1 ZEUS_CODEX_COMMAND_PATH="$PWD/.tmp/codex-runtime/arm64/codex" pnpm vitest run packages/ai-runtime/test/codex-app-server-live.test.ts -t "detects and imports a Zeus legacy JSONL session" --reporter=verbose`
  - 结果：`1 passed / 7 skipped`，真实完成 `detect -> import/completed -> success.target(threadId) -> thread/read -> readHistories`。
  - 探针同时确认 sessions detection 必须使用 `includeHome: true`；由于 external-agent home 已固定到 Zeus 私有根，这不会扫描用户真实 Claude 数据。

#### 尚待 verification

- 本次会话导入、native session 与打包相关测试：`15 files / 305 passed / 4 skipped`。
- 收尾审查补出并修复了导入状态可见性缺口：`detect` 现在返回最近的 `prepared/waiting/completed/failed` 真实记录；对应仓储与服务用例先红后绿，`2 files / 29 passed`。
- 静态门禁：`pnpm lint && pnpm typecheck && pnpm format:check && git diff --check` exit 0。
- 反向扫描 renderer 源码未发现 `session-start-mode`、`session-start-radio`、“引用旧会话”或“续接此会话”等已删除 UI 模式。
- `pnpm build` exit 0；仅保留 Vite 已有的单 chunk 大于 500 kB 警告。
- `pnpm package:mac` exit 0，产出 App/DMG/ZIP；`codesign --verify --deep --strict` 通过，包内 runtime 执行 `codex-cli 0.144.2`，`verify-packaged-app-health.mjs` 返回 `rendererAssets=2;main=dist/main/main.js`。
- Gatekeeper `spctl --assess` 对本地 ad-hoc 签名包返回 `rejected`；当前没有 Apple Developer ID 签名和公证，因此不能把该结果表述为正式分发验证通过。
- `pnpm test` 未全绿：`82 files passed / 2 failed`，`1333 passed / 19 failed / 4 skipped`。单独复跑两文件仍为同一 19 个图谱断言失败，集中在 500 节点/边截断后的真实仓库特定节点不可见；该问题不在本次会话导入实现范围，本轮未修改图谱行为或测试以掩盖失败。
- packaged GUI 视觉与点击验收未执行；当前只完成无窗口 bundle health、真实 Rust RPC 与 renderer 组件测试。

`DEVELOP COMPLETE; VERIFICATION PARTIAL: SESSION IMPORT GATES PASS, REPOSITORY FULL TEST AND DISTRIBUTION GATE REMAIN RED`

### 10.15 2026-07-15 全仓图谱回归收口与 Codex v2 状态通知兼容

本节继续完成 10.14 的剩余 verification，并记录用户在真实打包 App 中新增发现的 provider 事件解析缺陷。完整故障链与验收账本见：

`docs/TASK_20260715_001_Codex会话设置与Token用量事件解析故障排查.html`

#### 图谱回归根因与修复

10.14 的 19 个图谱失败不是会话导入回归，而是多类图谱在大型真实仓库中按原始扫描顺序硬截断：后出现的 package/file、API 直接调用、try/catch 与字段影响证据会被普通声明或控制流挤出视图。修复保持 Electron payload 上限，不用扩大上限掩盖问题：

1. module view 在截断前按 package/file/class/interface/type 排优先级；
2. API sequence 先保留 API、handler、已解析直接调用与目标，再展开递归调用；
3. method logic 先保留真实语义边两端、来源文件、owner function、小函数完整控制链与 evidence owner 的前导控制节点；无语义边的孤立 SQL 只保留有界样本；
4. 测试文件共享一次不可变真实仓库扫描，并用 Set 做 view membership 判断，避免 28 次重复扫描及 `Array.includes` 在 26 万级 edge 集合上造成 15 秒超时和 Vitest worker RPC timeout。

对应新增回归覆盖：6200 个无关控制节点后 try/catch 仍完整、1200 声明后 module file 仍可见、2100 递归调用后 API 直接 handler call 仍优先。

#### 新增现场 Bug：合法 Codex v2 通知被判 invalid

用户现场错误：

- `ZEUS_NATIVE_PROVIDER_EVENT_INVALID: Invalid inputTokens.`
- `ZEUS_NATIVE_PROVIDER_EVENT_INVALID: Missing provider settings model.`

已用 pinned Codex `0.144.2` / commit `a6645b6b8a656360fa16fb7e1c6721d0697d3d6a` 的真实 Rust/生成 TS 协议确认根因：

- `ThreadSettingsUpdatedNotification` 是 `{ threadId, threadSettings }`，模型位于 `params.threadSettings.model`；
- `ThreadTokenUsageUpdatedNotification` 是 `{ threadId, turnId, tokenUsage }`，累计 token 位于 `params.tokenUsage.total`；
- Zeus coordinator 此前错误读取 `params.model` 与 `params.tokenUsage.inputTokens`，所以把合法事件隔离成会话内 native error。

修复在 coordinator 边界先归一化当前 v2 嵌套形状，再持久化 settings/token snapshot；同时保留既有扁平事件兼容，malformed 事件仍 fail-closed。新增测试以真实 v2 形状先红后绿，并断言不产生 `conversation.native.error`。

#### 2026-07-15 重新验证

- native coordinator/API/WebSocket 聚焦回归：`3 files / 89 passed`；
- 全仓：`84 files passed`，`1356 passed / 4 skipped`，共 `1360 tests`；
- 图引擎完整文件：`38 / 38 passed`，从约 237 秒且伴随超时降到 1.48 秒且无 unhandled worker error；
- `pnpm lint && pnpm typecheck && pnpm format:check && git diff --check`：exit 0；
- `pnpm build`：exit 0，仅保留既有 Vite 大 chunk warning；
- 用户确认可直接退出 Zeus 后，已优雅终止旧正式 App，并执行官方 `pnpm build && pnpm package:mac`：exit 0，正式覆盖 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`，同时产出 DMG/ZIP；
- 正式 dist 的 ad-hoc `codesign --verify --deep --strict` 通过，bundle health 返回 `rendererAssets=2;main=dist/main/main.js`，包内 runtime 为 `codex-cli 0.144.2`；
- 正式 dist `app.asar` 已检出 `params.threadSettings` 与 `tokenUsage.total` 归一化，且不再检出旧 `requireString(params.model` 读取；新正式 App 已从该绝对路径重启，进程 PID 为 26575；
- `security find-identity -v -p codesigning` 返回 `0 valid identities found`，`spctl --assess` 仍 rejected；Developer ID / notarization 是外部发布阻塞，不得表述为正式分发通过；
- 当前 macOS 处于锁屏，自动化无法读取或操作 Zeus 窗口；正式 dist 覆盖、重启与静态包验证已完成，解锁后仍需在真实会话中触发一次 v2 settings/token 通知，确认不再新增上述两类错误。

#### 回滚

- 图谱修复可独立回滚 `packages/graph-engine/src/index.ts` 的视图选择优先级和对应测试，不涉及持久化 schema；
- provider 通知修复可独立回滚 coordinator 两处 shape normalization 与对应测试，不涉及 SQLite migration、threadId 或 rollout；
- 会话导入与 Codex runtime pin 不需要回滚。

`VERIFICATION PARTIAL: SOURCE, FULL TESTS, STATIC GATES AND OFFICIAL PACKAGE PASS; GUI EVENT REPLAY IS LOCK-SCREEN BLOCKED, DEVELOPER ID NOTARIZATION REMAINS EXTERNALLY BLOCKED`

### 10.16 2026-07-15 用户确认：代码变更后的正式重打包无需再次询问

用户明确授权：Zeus 发生任何代码行为变更后，agent 可以直接优雅退出正在运行的 Zeus，重新执行构建和正式 `pnpm package:mac`，覆盖 `dist/mac-arm64/Zeus.app`，随后重启正式打包 App 并完成真实运行验收。不得再把“Zeus 正在运行”作为等待用户确认的阻塞项，也不能只用源码测试或隔离临时包代替正式 dist 验收。

该授权不扩展到 git commit、push、merge 或其他修改历史/远端动作。

### 10.17 2026-07-15 新建 native 会话触发 commandPath 漂移

用户在正式重打包 App 中点击“开始并发送”后稳定出现：

`Codex command path cannot change while the manager is active.`

故障证据与方案裁决见：

`docs/TASK_20260715_002_CodexManager命令路径漂移故障排查.html`

已确认事实：

1. Electron Main 在 `apps/desktop/src/main/main.ts:601-608` 解析、校验并传入正式包内绝对路径；真实进程也从 `dist/mac-arm64/Zeus.app/Contents/Resources/codex/codex` 启动。
2. local-server 在 `packages/local-server/src/index.ts:1082-1097` 把该路径交给 coordinator、migration 与 import service，manager 因而已绑定正式包绝对路径。
3. 本机 SQLite 的 `runtime.settings.adapterCliPaths` 是空对象，排除用户配置了另一条 Codex 绝对路径的候选根因。
4. 缺少显式 model 时，`packages/local-server/src/index.ts:9064` 仍从旧 CLI settings 取路径并回退为字符串 `codex`；`packages/ai-runtime/src/codexAppServerManager.ts:563-565` 正确拒绝同一活跃 manager 切换路径。

根因 R1：native app-server 已改为随包固定 runtime，但缺省模型查询遗漏迁移，仍保留旧可配置 CLI 路径来源且未携带冻结的 `externalAgentHome`，导致一个 manager 同时收到两套 runtime identity。首次把 commandPath 统一后，正式 GUI 复测继续暴露 `Codex external-agent home cannot change while the manager is active.`，证实必须统一完整身份而不是只修路径字符串。

候选方案：

- A（已实施）：缺省 model capability 查询统一使用创建 local-server 时冻结的 `codexRuntimeCommandPath` 与 `codexExternalAgentHome`，保留 manager 的 runtime identity 不可变安全约束；
- B（排除）：在 manager 中规范化或放宽路径比较，会掩盖真实 binary 来源漂移；
- C（排除）：恢复使用 runtime settings 启动 native manager，破坏 pinned runtime/checksum/版本一致性。

验收证据：

- 第一轮测试先以 bundled path + 空 model/空 CLI settings 复现路径不一致，RED 后统一 commandPath；
- 正式 GUI 首轮复测越过路径错误后真实暴露 externalAgentHome 不一致；第二轮测试扩展为完整 runtime identity，再次 RED 后统一两个字段；
- 聚焦 `3 files / 100 passed`；全仓 `84 files / 1357 passed / 4 skipped`；lint、typecheck、format、`git diff --check` 均 exit 0；
- 优雅退出 Zeus 后 `pnpm build` 与正式 `pnpm package:mac` exit 0；codesign strict、bundle health 与包内 `codex-cli 0.144.2` 通过；
- 正式 App 新建 native 会话成功，thread/turn 完成，Codex 返回 `ZEUS_RUNTIME_IDENTITY_FIX_OK`，会话恢复“已就绪”，未再出现两类 identity changed 错误。

无 DB migration、依赖、配置格式或 UI 变更；回滚只撤销一处完整 runtime identity 来源修改和对应测试。

`VERIFICATION PASSED: SOURCE, TESTS, OFFICIAL PACKAGE AND REAL GUI NATIVE THREAD/TURN`

### 10.18 2026-07-15 Turn 已开始但对话区没有“正在思考”反馈

用户在正式打包 App 中发送 `？？？` 后，顶部显示“正在处理”、会话列表显示“正在响应”、停止按钮也已出现，但消息区在用户气泡之后保持空白，无法就近判断 Codex 是否已经开始思考。

故障证据与方案裁决见：

`docs/TASK_20260715_003_Codex思考状态可见性故障排查.html`

已确认事实：

1. SQLite 中本轮 turn `019f64b6-4927-7372-9d48-6d45fe11c28f` 于 `2026-07-15T07:38:15.735Z` 启动、`07:40:11.772Z` 完成；用户截图时间 `07:39:46` 位于真实 active 区间，所以不是请求未启动。
2. 用户 item 于 `07:38:30.679Z` 入库，首个 reasoning item 直到 `07:40:09.239Z` 才开始，assistant item 于 `07:40:10.821Z` 开始，首个非用户 item 之前存在约 113 秒可见空窗。
3. `apps/desktop/src/renderer/session/ConversationTranscript.tsx:24,88-100` 只遍历已有 `itemOrder`；`apps/desktop/src/renderer/session/ThreadItemView.tsx:94-96` 只有在空 assistant item 已经存在且未完成时才渲染“正在思考”。turn active 但尚无 provider item 时没有任何近场占位。
4. 当前 Codex App `26.707.71524` 包仍有 working dots / loading shimmer，并对 `prefers-reduced-motion` 禁用动画；9.4 节既有取证也记录 Thinking 首次等待反馈。Zeus 当前行为属于 Codex App 对齐缺口。

候选根因裁决：

- H1“Renderer 漏掉首 item 前的 turn 级反馈”成立，由 E1、E2、E3 共同确认；
- H2“provider 没有开始或事件没有持久化”排除，因为 turn 和后续 reasoning / assistant item 均有完整持久化时间线。

推荐方案：仅在 Renderer 视图层，根据 active turn 与当前 turn 的真实可见 item 状态显示一个非持久化的 inline thinking 占位；首个真实 provider 内容到达后立即移除。不得由服务端合成 assistant item，避免污染 Codex-native thread / turn / item 证据链。

验收边界：

- `starting_turn / active_prework / active_final_answer` 的首 item 空窗显示“Codex 正在思考”；
- 已有真实 reasoning、assistant、tool 或 request 后不重复显示；
- idle、waiting、failed、interrupting、legacy read-only 不显示；
- 使用 `role="status"`、`aria-live="polite"`，并遵守 reduced-motion；
- 先补 Renderer 失败测试，再做最小实现；代码变更后按 10.16 授权退出 Zeus、正式构建打包、重启真实 App 验收。

无数据库迁移、依赖、协议、服务端状态或权限变更。回滚只撤销 Renderer 占位、样式和对应测试。

#### 2026-07-15 Develop 与验证结果

用户已确认进入 develop，现已完成以下变更：

1. Renderer 只投影有真实文本的 reasoning；active turn 的首个真实 provider item 前显示非持久化“正在思考”。真实历史中的 52 条空 reasoning 不再形成“工作记录”空行。
2. commandExecution 改为紧凑 typed row：命令、工作目录、状态、耗时、退出码和可折叠输出；不再重复“工具调用 / 技术详情”标题或默认输出 raw JSON。
3. “返回最新消息”移到 transcript shell overlay，使用 `position:absolute`；正式包滚离底部后出现，回到底部后消失。
4. conversation 新增持久化 `permission_mode`，并由同一事实源驱动 UI、thread/start 与 turn/start。支持 `read-only / auto / full-access`；full-access 使用 `dangerFullAccess + never` 且必须二次确认。
5. provider 已 advertised 的 command grant 决定按用户选择转发，不再先读取 task `allowCodeChanges` 静默改写。新增 `/bin/zsh -lc "rg --files docs"`、`allowCodeChanges=false + permissionMode=auto` 回归测试。
6. 已完成空闲态权限 PATCH API、Controller 状态回灌、审批当前 mode 展示与切换锁定；active / waiting / busy 时不能切换。

真实验证：

- `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`git diff --check`：通过。
- `pnpm test`：84 个测试文件，1368 passed、4 skipped。
- `pnpm build && pnpm package:mac`：通过；正式 `dist/mac-arm64/Zeus.app` 完成磁盘签名校验与 Designated Requirement 校验。
- 正式包 packaged Renderer 实测：权限选择器三项齐全；full-access 只打开风险确认层，取消后保持 `read-only` 且焦点返回选择器；真实会话 95 条 command row、0 条空 reasoning、0 个“工作记录”、0 个重复“工具调用”标题；返回按钮计算样式为 `position:absolute`。
- macOS 当时处于锁屏，Computer Use 无法抓取系统窗口；改用同一正式包的 remote debugging target 执行 DOM 交互和截图，不以源码预览代替正式包验收。

未执行 git commit、push、merge、revert 或其他历史修改。构建仍存在既有单 chunk 超过 500 kB 警告，不属于本次修复。

`VERIFICATION PASSED: SOURCE, TESTS, OFFICIAL PACKAGE AND PACKAGED UI`

### 10.19 2026-07-15 会话记录空行、漂移控件与权限模式事实源分裂

用户在正式打包 App 的 native 会话中继续发现四类问题：空白“工作记录”、低信息密度“工具调用 / 技术详情”、随滚动内容漂移的“返回最新消息”，以及审批按钮与真正权限策略不一致。完整 before/after 故障链、Codex App permission profile 映射、验收与回滚见：

`docs/TASK_20260715_004_Zeus会话记录悬浮控件与权限模式故障排查.html`

#### 现场与源码证据

1. SQLite 会话 `conversation_f6f2cd95664f2efa257b1b80` 中，多条 reasoning item 的 `text_content` 长度为 0，payload 为 `summary:[] / content:[]`；这不是 Zeus 持久化丢字，而是 provider 合法空壳。
2. 同一会话的 commandExecution item 虽然 `text_content` 为 0，但 payload 已含 command、cwd、status、commandActions、aggregatedOutput、exitCode 和 durationMs；低信息展示发生在 Renderer 投影层。
3. `apps/desktop/src/renderer/session/ThreadItemView.tsx:65-117,315-390` 对所有 item 无条件生成 article/header；空 reasoning 因而只留下“工作记录”，tool 又统一退化为“工具调用 + 技术详情 + raw payload”。
4. `apps/desktop/src/renderer/session/ConversationTranscript.tsx:72-127` 把 `session-return-latest` 放在滚动内容内部；`apps/desktop/src/renderer/session/session.css:655-667` 使用 `position: sticky; bottom:118px`，所以按钮位置会随消息、spacer 和 pending request 内容流改变。
5. 当前任务 `task_p-vaz0t3C-OV` 的 `allow_code_changes / allow_tests / allow_git_commit` 均为 0。`packages/local-server/src/codexNativeConversationCoordinator.ts:469-510,1793-1795` 又把每个 thread/turn 固定为 `approvalPolicy:'untrusted'`、`approvalsReviewer:'user'`，sandbox 只由 allowCodeChanges 二值派生。
6. 截图中的 `rg --files ... 2>/dev/null | sed ...` 审批请求真实落库后被回复为 `{"type":"command","decision":"decline"}`；`codexNativeConversationCoordinator.ts:2276-2285` 对 read-only task 先天拒绝 grant，且 shell/meta command 也不在 allowlist。UI 展示“允许一次”，服务端却会改写为拒绝，属于伪可操作审批。
7. 设置页 `apps/desktop/src/renderer/App.tsx:9414-9428` 的“默认权限 / 自动审查 / 完全访问”目前只是 `<span>` 状态文字，没有任何可修改控件。
8. 本机 Codex App `26.707.71524` bundle 的真实 permission profile 映射包含 `read-only / auto / granular / guardian-approvals / full-access`；thread/turn 根据 mode 发送 approvalPolicy、approvalsReviewer 与 sandbox/permissions，而不是固定 untrusted。

#### 候选根因裁决

- H1“provider 文本在持久化时丢失”排除：reasoning upstream payload 本身为空，command payload 则完整。
- R1“Renderer 缺少 item 可见性与 typed presentation 投影”成立：空壳无条件生成可见行，command 的结构化字段没有形成专用行。
- R2“返回按钮的 DOM/CSS 锚点错误”成立：它参与 transcript 内容流而不是锚定 viewport/composer overlay。
- H2“允许按钮只是前端 click 失效”排除：请求与响应均真实落库，但 hidden task gate 与 coordinator guard 将 accept 改写为 decline。
- R3“权限事实源分裂”成立：设置页是假状态、Renderer 使用 provider advertised decisions、coordinator 使用固定 untrusted 和 task 二值 veto，三者没有共享同一 permission profile。

#### Codex App 对齐方案

1. native 会话以 conversation permission profile 为单一事实源；composer 显示并切换当前 Codex Agent Mode，thread/start、恢复会话与每次 turn/start 使用同一映射。
2. `read-only = readOnly + on-request + user`；`auto = workspaceWrite(project root) + on-request + user`；`full-access = dangerFullAccess + never + user`。granular / guardian 仅在 pinned app-server capability/config requirements 真实允许时显示，不由 Zeus 模拟。
3. 旧 task allow 字段只用于初始化 native conversation 默认 mode 和兼容非 native runtime，不再作为用户已经明确选择 mode 后的隐藏二次否决。
4. UI 仅展示 app-server advertised decisions；coordinator 继续做 schema、路径和响应形状校验，但不得把合法用户 accept 静默改写成 decline。Full access 必须显式选择、醒目标注风险且不能作为静默默认。
5. transcript view 保留所有 provider item 的真实持久化，但空 reasoning 不渲染；有摘要的连续 reasoning 合并为一个轻量工作进度；commandExecution 使用动作、状态、耗时、按需输出的 typed row，raw JSON 只进入诊断入口。
6. “返回最新消息”移出消息内容流，锚定 transcript viewport / composer 上沿；只在离开底部阈值时出现，回到底部立即消失，不遮挡 pending request、composer 或消息操作。

#### 验收与回滚

- 先补 Renderer 空 reasoning、typed command row、overlay 定位、权限 mode 交互和 coordinator policy mapping 的失败测试，再做最小实现。
- 聚焦验证覆盖 `session-workspace`、`pending-request-surface`、`codex-native-conversation-coordinator`；随后执行 lint、typecheck、format、全仓 test 与 `git diff --check`。
- 按 10.16 授权，任何源码行为变更后直接优雅退出 Zeus，执行正式 `pnpm build && pnpm package:mac`，重启 `dist/mac-arm64/Zeus.app`，以真实 read-only / auto / full-access 会话复验。
- item 投影、command row、scroll overlay 与 permission profile 分四个独立切片回滚；不迁移、不清洗、不改写既有 conversation_items / rollout。

`READINESS: READY FOR DEVELOP CONFIRMATION; SOURCE NOT MODIFIED`

### 10.20 2026-07-15 会话页视觉与项目侧栏交互收敛

用户确认实施“最左项目侧栏可拖动、会话入口替换为单气泡 SVG、输入框移除双层蓝色焦点框”，中间会话列表宽度保持不变。本轮未修改后端、数据库、会话协议、公开 API 或依赖。

#### 实现与边界

1. `apps/desktop/src/renderer/App.tsx` 新增版本化本机偏好 `zeus.shell.project-sidebar-width:v1`。默认 `248px`、全局范围 `200–420px`，计算窗口上限时同时扣除 `1px` 分隔条，为主工作区保留至少 `520px`。
2. 已保存的 preferred width 与当前窗口可渲染 width 分离：窄窗只临时收敛显示值，不覆盖较宽窗口下的用户偏好；窗口恢复后自动恢复 preferred width。非法、越界或不可读存储值回退 `248px`。
3. 分隔条支持鼠标拖动、双击复位、方向键、Shift 加速、Home/End；使用 `role="separator"`、`aria-orientation`、`aria-valuemin/max/now/text`。设置页与小于 `760px` 的单列布局不显示分隔条。
4. 拖动生命周期通过纯状态机按 `pointerId` 隔离；`pointercancel`、窗口失焦、`lostpointercapture` 和拖动重入均恢复最后已提交偏好并清除 resizing。无有效位移、窄窗向外拖动或键盘边界无效操作不会误写本机偏好。
5. 项目二级“会话”入口改为 `13px`、`1.35px` 圆角单线气泡 SVG，`aria-hidden=true`、`focusable=false`，源码不再使用 `◌`。
6. `apps/desktop/src/renderer/session/session.css` 将 composer `focus-within` 收敛为主题适配的单层中性边界，textarea 显式 `box-shadow:none`；内部按钮和模式控件的键盘焦点规则保留。

#### TDD 与独立审查

- 首轮 RED：宽度/存储/键盘 helper、分隔条、会话 SVG 和 composer 焦点测试共 4 项按预期失败；最小实现后目标测试转绿。
- 首轮 review 发现窄窗双击会保存收敛值、拖动取消生命周期不完整、`1px` 分隔条未计入工作区保护；补失败测试并修正。
- 二轮 review 又发现 React 异步状态下的拖动重入、多 pointer 干扰、窄窗键盘无效写入；新增 committed preference ref 与可测试拖动状态机后修正。
- 最终独立 review：`0 Critical / 0 Important`，`Ready: Yes`。仅保留一个不阻塞的极端边界：若 Electron 拒绝 pointer capture，且指针移出仍保持焦点的窗口后释放，同时宿主未发送 pointerup/blur，则只能等待下一次交互清理；正常 capture、cancel、blur 和 lostcapture 路径均已覆盖。

#### 自动验证

- `pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx apps/desktop/test/session-workspace.test.tsx`：2 个文件、214 passed。
- `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`git diff --check`：通过。
- `pnpm test`：84 个测试文件，1375 passed、4 skipped。
- `pnpm build && pnpm package:mac`：通过；构建仍有既有单 chunk 超过 500 kB 警告。
- `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app`：`valid on disk` 且 `satisfies its Designated Requirement`。

#### 正式包 UI 验收

macOS 当时处于锁屏，Computer Use 无法读取系统窗口；因此连接本轮刚生成并启动的 `dist/mac-arm64/Zeus.app` remote-debugging target，在同一 packaged Renderer 上执行真实 DOM、输入、键盘、拖动、重载、应用重启和截图验证，不使用源码预览替代正式包。

- 基线：项目侧栏 `248px`；separator 的 ARIA 为 `200 / 420 / 248`；会话 SVG 计算尺寸 `13px`、描边 `1.35px`、不可聚焦。
- 鼠标拖动 `248 → 320`，localStorage 与 `aria-valuenow` 同步为 `320`；方向键后为 `328`；双击恢复 `248`。
- 再拖到 `312` 后刷新仍为 `312`；退出并重新启动正式 Zeus 后仍恢复 `312`。验收结束后已双击复位，最终本机偏好为 `248`。
- 740px 视口下 separator `display:none`；760px 下显示宽度自动收敛为 `239px`，保存偏好仍为 `312`；恢复 1240px 视口后侧栏恢复 `312px`。
- 设置页 separator 数量为 0。浅色、深色、跟随系统三种主题逐一保存并返回真实会话聚焦 textarea：frame 均为单层主题中性边界，textarea 计算样式均为 `box-shadow:none`；最终已恢复“跟随系统”。
- 正式包截图中“会话”为单线气泡图标，composer 不再出现双层蓝色外环；中间会话列表宽度未被本次 CSS 变量改变。

#### 回滚

回滚仅删除项目侧栏 width state/ref/状态机、separator DOM/CSS、版本化 localStorage 写入、会话 SVG、composer 焦点样式和对应测试；遗留存储键可安全忽略。不得回滚现有 native 会话、legacy 只读边界、权限模式或覆盖工作区其他未提交变更。

`VERIFICATION PASSED: SOURCE, TESTS, OFFICIAL PACKAGE AND PACKAGED UI`

### 10.21 2026-07-15 会话消息可见角色文字收敛

用户确认：自己发送的消息和 Codex 回复不需要在正文上方重复显示“你 / You / Codex”。消息归属继续由用户气泡右对齐、Codex 正文流左对齐表达；无障碍树仍必须保留发送者名称，不能只靠颜色区分。

#### 实现与边界

1. `apps/desktop/src/renderer/session/ThreadItemView.tsx` 将 accessible label 与 visible role label 分离：`user / assistant / commentary` 不再渲染可见角色名，`article[aria-label]` 仍分别保留“你 / You / Codex”。
2. optimistic 用户消息仍显示“发送中 / Sending”；工具、文件、审批、错误和未知 provider 项继续显示各自类别标签，command execution 的既有 typed row 不变。
3. 本轮未修改 CSS、消息内容、thread / turn / item 协议、持久化、权限、队列、滚动、composer、依赖或数据库。

#### TDD 与独立审查

- RED：新增行为测试后，目标用例按预期失败，失败现场明确仍存在 `<strong>You</strong>`，不是测试拼写或环境错误。
- GREEN：最小增加 `showVisibleRoleLabel / showMeta` 条件后，目标测试转绿；完整 `session-workspace.test.tsx` 为 `50 / 50 passed`。
- 首轮独立 review 为 `0 Critical / 0 Important / 1 Minor`；Minor 指出测试只锁英文 `<strong>`，未显式保护中文和非对话类别标签。
- 补充双语 meta 缺失、`aria-label`、optimistic 状态，以及 tool / file / request / error / unknown 双语可见标签的表驱动断言后，复审为 `0 Critical / 0 Important / 0 Minor`，`Ready: Yes`。

#### 验证与正式包现场

- `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`git diff --check`、`git diff --cached --check`：exit 0。
- `pnpm test`：84 个测试文件，`1377 passed / 4 skipped`，共 1381 tests，exit 0。
- 优雅退出旧 Zeus 后执行 `pnpm build && pnpm package:mac`：exit 0；只保留既有单 chunk 超过 500 kB warning。
- `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app`：`valid on disk` 且 `satisfies its Designated Requirement`；bundle health 为 `rendererAssets=2;main=dist/main/main.js`；包内 runtime 为 `codex-cli 0.144.2`。
- 新正式 App 从 `dist/mac-arm64/Zeus.app` 以 remote debugging 启动；真实页面 URL 位于该包 `app.asar/dist/renderer/index.html#project-sessions`。packaged DOM 中最后 12 条 user / assistant item 的 `aria-label` 保持“你 / Codex”，`.session-thread-item-meta` 均为 null。
- packaged Renderer 截图 `/tmp/zeus-session-role-labels-message-boundary.png` 显示用户气泡仍右对齐、Codex 正文仍左对齐，两者均不再显示可见角色文字；视觉层级和消息边界清楚，未发现由本轮修改引入的间距、对齐或对比度问题。
- `spctl --assess` 仍因当前包没有 Developer ID 签名和 notarization 返回 rejected；这是既有外部分发阻塞，不影响本轮本机正式包行为验收，也不得表述为正式分发通过。

#### 回滚

回滚仅撤销 `ThreadItemView.tsx` 的可见角色条件和 `session-workspace.test.tsx` 对应测试；不得移除无障碍发送者名称，也不得触碰现有 native 会话、权限模式或工作区其他未提交改动。

`VERIFICATION PASSED: SOURCE, FULL TESTS, OFFICIAL PACKAGE, PACKAGED DOM AND VISUAL QA`

### 10.22 2026-07-17 新对话自由输入与项目级会话

#### 领域定义

1. 正式任务继续由 `tasks` 与 `task_events` 表达，任务分组旁的 `+` 创建任务所有者会话，`conversations.task_id` 指向真实任务。
2. 全局“新对话”和 `Cmd+N` 创建项目所有者会话。第一条自由输入是会话消息，不创建 ZEU 正式任务，不写任务事件，也不绑定任何已有任务；持久化事实为 `conversations.task_id IS NULL`。
3. 新增 `SessionConversationOwner`，显式区分 `project` 与 `task`。两类所有者共享 thread/turn、队列、审批、恢复、附件、权限模式和幂等机制，但使用不同首发作用域与列表结构。

#### 实现边界

- local-server 新增 `GET /api/projects/:projectId/conversation-choices` 与 `POST /api/projects/:projectId/conversations`。项目 choices 只返回未归档、`task_id IS NULL`、非临时图谱问答的会话。
- Coordinator 新增持久项目对话入口：标题来自首个非空行，连续空白压缩后按 48 个 Unicode 字符截断；摘要保留原始输入前 240 个字符；默认权限为 `auto`，`allowGitCommit` 始终为 false。
- 项目首发使用 `project-conversation:<projectId>` 幂等作用域和项目级本机 envelope。durable acceptance 到达后先写入对应项目缓存，再按当前项目决定是否导航；迟到的 A 项目响应不能抢占 B 项目画布。
- Renderer 会话树把项目对话直接显示在项目下，不伪造任务分组。零任务项目仍加载项目 choices，并显示固定在底部的自由输入 composer。
- composer 复用既有输入框、附件、权限与发送控件语言；Enter 发送、Shift+Enter 换行、IME 合成期间不发送。首发期间正文、附件、权限和发送控件共享一个冻结 envelope；失败保留本地输入。
- 已删除旧的居中任务 picker、`session-start-empty`、`session-start-task-picker` 及“先选择一个真实任务”等实现导向文案；工作区可访问名称收敛为“会话工作区”。

#### TDD 与自动验证

- API/Coordinator 覆盖项目不存在、空正文、非法权限、附件越过项目目录、重复幂等、同 key 不同 body、并发相同请求、重启恢复、并发排队、多轮续接、Unicode 标题，以及任务表和任务事件计数不变。
- Renderer 覆盖零任务 composer、项目会话直接分组、项目级 durable acceptance、乱序 choices、项目级 envelope 隔离、键盘语义、自动聚焦接线、列表失败不阻止显式新建，以及任务分组 `+` 不回归。
- 聚焦命令覆盖 6 个相关测试文件，结果为 `415 passed`。
- `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`：exit 0；全仓 `88` 个测试文件，`1431 passed / 4 skipped`，共 1435 tests。
- `git diff --check && pnpm verify:acceptance-matrix`：exit 0；验收矩阵为 `12 sections / 139 items`。
- 反向扫描 production 源码确认不再包含 `session-start-*`、两条旧中英文任务 picker 文案或“Codex native 会话工作区”等实现术语。
- 优雅退出旧 Zeus 后执行 `pnpm package:mac`：exit 0；`dist/mac-arm64/Zeus.app` 为 `valid on disk` 且 `satisfies its Designated Requirement`。构建仅保留既有的单 chunk 超过 500 kB warning。

#### 正式包运行时验收

1. 从 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 启动的真实 packaged Renderer 中，空白会话页底部直接显示自由输入 composer；可访问名称为“会话工作区”，旧两条文案和任务按钮 picker 均不存在，截图未发现横向溢出。
2. `Cmd+N` 从已连接会话返回新对话页后，焦点真实落在“发送消息” textarea；任务分组旁的“新建会话”入口仍存在。
3. 正式发送 `Zeus 20260717 PROJECT_CONVERSATION_OK` 后，durable acceptance 完成即在项目下直接出现项目会话并导航到该会话；Runtime 最终返回 `PROJECT CONVERSATION OK`。
4. SQLite 前后取证：项目任务数保持 `39`，任务事件保持 `97`，项目会话从 `0` 增为 `1`；新增会话 `conversation_d1654432adecc57da2bf88a1` 的 `task_id IS NULL`、`permission_mode=auto`、`provider_state=ready`，数据库 `PRAGMA quick_check=ok`。
5. 退出并重新启动同一正式 App 后，项目会话仍直接显示在项目下。重新选择后继续发送 `Reply only CONTINUATION_OK. Do not use tools.`，同一 `provider_thread_id=019f6e35-47ef-7c83-ba50-5c4f2dfae523` 的 turn 数由 `1` 增为 `2`，Runtime 返回 `CONTINUATION_OK`；任务与任务事件计数仍未变化。
6. 真实 provider rollout 中仍出现既有的 `Secret-like provider field rejected: snapshot.openai-api-key-local-confirmation` 错误 item，但首轮和续接轮均继续完成并返回预期文本；该错误不阻塞项目会话创建、持久化、重启恢复或同 thread 续接，本轮未扩大范围修改 provider 安全过滤。

零正式任务项目的页面条件由 Renderer 零任务用例和 API 任务计数不变用例覆盖；正式包现场使用现有 Zeus E2E 项目验证了同一无任务绑定路径（`task_id IS NULL`），未为验收额外创建或删除用户项目。

`VERIFICATION PASSED: SOURCE, FOCUSED AND FULL TESTS, ACCEPTANCE MATRIX, OFFICIAL PACKAGE, PACKAGED UI, DATABASE FACTS AND RESTART CONTINUATION`
