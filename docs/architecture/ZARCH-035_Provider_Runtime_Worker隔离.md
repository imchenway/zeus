# ZARCH-035 Provider Runtime Worker 隔离

## 结论

Pi SDK 已从 Zeus Core 进程迁入独立、惰性启动且受监督的 Provider Worker。Core 通过 `zeus.pi-runtime-worker.v1` 版本化 IPC 实现 `AgentRuntimeDriver`，继续独占产品会话编排、SQLite 持久化与工具授权。Worker 崩溃不会自动重启并重放原命令，也不会创建替代 Pi 会话；显式恢复只按既有 `nativeSessionId` 与 `nativeSessionPath` 打开新运行代次。

Codex app-server 原本已经是子进程。本切片没有改写其成熟世代管理器，而是增加统一的只读 health/circuit 投影：Codex 仍可自动启动新 app-server 世代，但不自动重发旧代次中结果未确认的 turn；Pi 则只能显式恢复。

当前代码、本机假 Provider 行为探针与公开 API 的临时命令账本探针已通过。`GET /api/diagnostics/provider-runtimes` 已提供 Codex/Pi 只读健康，`POST /api/provider-runtimes/pi/recover` 已提供显式恢复；尚未使用真实外部模型、账号或额度做运行验收，也尚未接入产品 UI。

## 故障域与所有权

```text
Renderer / Main
       |
       v
Zeus Core（唯一业务写入者）
  |-- Conversation Coordinator
  |-- SQLite / Outbox / 接纳事务
  |-- Tool Broker / 审批 / 文件与命令权限
  |-- Provider Supervisor
       |-- Codex app-server generation
       `-- Pi Runtime Worker generation
              `-- Pi SDK / ModelRuntime / 原生 session JSONL
```

- Core 拥有产品会话、提交、轮次、运行分段、授权和业务数据库。
- Pi Worker 拥有 SDK 内存、Provider 连接适配和当前运行代次事件，不打开 Zeus SQLite。
- Pi 原生 JSONL 仍是 Provider 原生历史；没有新增第三份 Zeus 完整会话 JSONL。
- API Key 只由 Core 的既有 SecretStore 加载，经私有 IPC 回应 Worker 的按需 `load_connections`；不进入 argv、环境变量、诊断或业务库。
- Pi 工具在 Worker 内只生成请求，实际 `read/write/edit/bash` 等仍反向 RPC 到 Core broker，并携带可取消信号。

## 版本化 IPC

协议版本固定为 `zeus.pi-runtime-worker.v1`，每帧同时携带 `generationId`。主要消息分为：

| 方向 | 消息 | 作用 |
| --- | --- | --- |
| Worker → Core | `hello` | 核对 PID、generation 与协议版本 |
| Core → Worker | `request` | 代理 `AgentRuntimeDriver` 方法 |
| Worker → Core | `response`、`event` | 返回结果和原生运行事件 |
| Worker → Core | `reverse_request` | 加载连接、执行工具、持久接纳、请求体证据 |
| Core → Worker | `reverse_response` | 允许或拒绝反向操作 |
| Worker → Core | `reverse_cancel` | 中止仍在 Core broker 执行的工具调用 |

未知帧、错误 generation、错误 PID 和协议版本不匹配均失败关闭并打开 `protocol_incompatible` 熔断。IPC 错误只序列化稳定 `code/message`，不传 stack；stderr 只有显式诊断回调可接收最多 1,000 字符的脱敏摘要。

## 持久接纳与 Provider 写入门

Pi 0.83.0 的 `preflightResult` 是同步回调，但认证、压缩和扩展预处理本身可能异步发生。普通异步 IPC 无法在该同步回调中等待 Core，因此实现采用两段式边界：

1. Worker 启动 `session.prompt()` 并等待 SDK 真实 `preflightResult`。
2. 预检成功后，Worker 通过反向 `run_acceptance` 把 `nativeRunId/acceptedAt` 交给 Core。
3. Core 同步执行现有 `durableTransactionSync`，记录接纳、运行分段和 Outbox 结果，再执行 `providerWriteMayStart`。
4. Core 先解析 `startRun` Promise，让 Coordinator 登记活动轮次；到下一事件循环阶段才回执 Worker。
5. Worker 的 Provider transport 在最终请求体 `onPayload` 边界等待该回执；回执失败时中止 run，网络写入不会开始。
6. 脱敏请求体指纹再通过 `provider_payload_observed` 回到 Core，随后才允许真实 Provider 传输。

该顺序保留了现有“持久接纳先于 Provider 副作用”的约束。它增加一次本机 IPC 往返和一个事件循环阶段，但不把数据库或事务回调搬进 Worker。

## 原生身份与恢复

Pi 默认要到首个 assistant 消息才真正创建原生 JSONL。若首轮 Provider 请求中途崩溃，过去的 `nativeSessionPath` 可能尚无 session header，恢复时 SDK 会生成另一 ID。现在新会话先让 `SessionManager` 在目标原生路径写入官方 session header，再创建 AgentSession；这仍是 Pi 自己的 JSONL，不是 Zeus 副本。

恢复规则：

- Core 只记忆已确认的 `nativeSessionId/nativeSessionPath/cwd`，不复制历史正文。
- Worker 退出后立即打开本 Provider 熔断，拒绝同一请求内部重试。
- 活动轮次发出 `ZEUS_PROVIDER_WORKER_RESULT_UNKNOWN`；会话编排把提交暂停为 `recovery_required`，保持产品会话 open，不继续自动派发队列。
- 显式 `recoverRuntime` 创建新 generation，逐一 `resumeSession` 并严格核对原 ID 与 path；缺 path 或身份不一致时再次熔断，不创建替代会话。
- 活动 Worker 仍有 run 时拒绝切换 generation；配置修改只可清除认证或限流熔断，不会顺带重发失败提交。

公开恢复入口直接接收 `provider.runtime.pi.recover` Command Envelope。Core 在 generation CAS 后建立 Inbox/Outbox、标记 Provider Runtime 写出，再调用 `recoverRuntime`；accepted 回执把新 generation 放在 `nativeSessionId`，并强制 `nativeTurnId=null`。busy/closed 是可证明的明确拒绝，其余写出后异常均为 unknown。accepted/unknown 的同命令重连不会再次调用 Worker。

Pi 的业务 Provider 写点另由 `PiProviderCommandApplicationService` 接管：`openSession` 使用 `provider_session`，只保存真实 session；两处 `startRun`、`steerRun` 与 `interruptRun` 使用 `provider_turn`，同时保存真实 session 与 run。这样不会把 SDK session 冒充 runtime generation，也不会把 session 创建与首轮 run 合并成语义过粗的回执；代价是多一类 destination、每个新会话多一次耐久账本写入，并增加恢复状态组合。

## Health 与熔断

公共 `AgentRuntimeHealthSnapshot` 包含 agent、transport、generation、lifecycle、protocol、PID、连续失败数、last failure 和 circuit。故障分类与恢复如下：

| 故障 | Pi 行为 | 结果语义 | 恢复 |
| --- | --- | --- | --- |
| 启动/握手 | 终止不完整 Worker，熔断 | 未开始的只读调用失败 | 显式恢复 |
| RPC 超时 | 终止 Worker，熔断 | 有副作用方法为 `result_unknown` | 显式恢复 |
| 认证失败 | 保留诊断，熔断新命令 | 当前模型请求失败 | 修正配置后刷新或显式恢复 |
| 限流 | 熔断新命令 | 当前模型请求失败 | 显式恢复；不自动重发 |
| 协议不兼容 | 立即终止，熔断 | 不猜测帧含义 | 升级兼容版本后显式恢复 |
| 进程退出 | Core 保持运行，停止该 Provider | 活动 run 为 `result_unknown` | 显式恢复原身份 |

Codex 的 `readCodexProviderRuntimeHealth` 把既有 `idle/starting/ready/restarting/closed` 世代状态映射到相同快照。Codex 的 `restarting` 表示监督器建立新 app-server generation，不代表旧 turn 被重放。

## 启动边界

- 创建 `PiRuntimeWorkerDriver` 不启动进程。
- 只读 health 查询不启动进程。
- 只有显式 `probe/readCapabilities/recoverRuntime` 或真实 `openSession/resumeSession` 等运行调用才启动。
- Worker 环境只允许 PATH、locale、时区、临时目录、代理与证书等运行必需项；模型凭据不进入环境。
- 模型连接列表与 Keychain 访问继续只在既有显式能力探测或真实运行需要时发生。

## 行为探针

命令：

```bash
pnpm --filter @zeus/ai-runtime build
node scripts/probe-pi-runtime-worker.mjs
```

探针只创建临时目录和 `127.0.0.1` 假 Provider，不读取正式数据、不使用真实密钥或额度。它在首轮请求到达本机端点后 `SIGKILL` Pi Worker，并验证：

- Core 进程继续运行；Codex health 投影仍为原健康 generation。
- 持久接纳、Provider 写入边界和最终请求体观察各执行一次。
- 活动 run 收到 `ZEUS_PROVIDER_WORKER_RESULT_UNKNOWN`。
- 显式恢复后 `nativeSessionId/nativeSessionPath` 不变、Worker generation 改变。
- 假 Provider 总请求数仍为 1，没有自动重发。

本次 Worker 输出：

```json
{"ok":true,"providerRequestCount":1,"durableAcceptanceCount":1,"providerWriteBoundaryCount":1,"providerPayloadCount":1,"unknownRuntimeEvent":true,"nativeSessionIdPreserved":true,"nativeSessionPathPreserved":true,"generationChanged":true,"otherProviderHealthy":true,"applicationContextInSystem":true,"untrustedContextInUser":true}
```

`pnpm exec tsx scripts/verify-provider-runtime-recovery.ts` 使用临时 SQLite + 假 Runtime 可重复验证：accepted 重连不增加恢复调用；unknown 首次与重连均返回 `ZEUS_PROVIDER_RECOVERY_OUTCOME_UNKNOWN` 且只有一个 attempt；busy 后为 `explicitly_rejected → accepted` 两个 attempt；stale generation 不建立 Inbox；同命令并发合并、其他命令有界拒绝；`quick_check=ok`。该脚本已纳入 `pnpm verify:zarch-gates`，不访问正式 Provider 或正式数据库。

`pnpm exec tsx scripts/verify-pi-provider-command-delivery.ts` 使用临时 SQLite 验证 session-only 与 session+run 身份约束、unknown 不重发、明确拒绝后安全新 attempt、写出前失败和 `quick_check=ok`；同样已纳入架构门禁。

## 收益与缺点

收益：Pi SDK 崩溃、卡死或协议异常不再直接带走 Core、SQLite 和 Codex；Provider 副作用边界可审计；恢复沿原生身份且不重放未知结果；凭据和工具权限继续留在 Core。

缺点：每个 Pi 调用增加 IPC 序列化，首次运行增加进程启动成本；当前一个 Pi generation 仍承载多个 Pi 会话，同一 Worker 故障会暂停这些 Pi 会话；同步预检与异步进程间事务之间需要 Provider transport gate；恢复命令多一次 Inbox/Outbox WAL 提交；真实认证、限流和长时间运行仍需外部模型现场验收；产品尚无 health/circuit UI 与显式恢复按钮。

## 实现位置

- `packages/ai-runtime/src/piRuntimeWorkerProtocol.ts`
- `packages/ai-runtime/src/piSdkRuntimeWorker.ts`
- `packages/ai-runtime/src/piRuntimeWorkerDriver.ts`
- `packages/ai-runtime/src/providerRuntimeHealth.ts`
- `packages/ai-runtime/src/piSdkRuntimeDriver.ts`
- `packages/local-server/src/piNativeConversationCoordinator.ts`
- `packages/local-server/src/providerRuntimeRecoveryService.ts`
- `packages/local-server/src/providerRuntimeControlApi.ts`
- `packages/local-server/src/piProviderCommandDelivery.ts`
- `scripts/probe-pi-runtime-worker.mjs`
- `scripts/verify-provider-runtime-recovery.ts`
- `scripts/verify-pi-provider-command-delivery.ts`
