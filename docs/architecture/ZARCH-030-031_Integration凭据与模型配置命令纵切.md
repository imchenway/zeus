# ZARCH-030～031 Integration 凭据与模型配置命令纵切

## 范围与分类

本纵切只接管 Local Server 中 16 个 Integration 公开 mutation，不扩大到 App Settings、Release、Execution Host、Conversation、Work Management 或 Git workspaces/integration；Telegram polling 已由独立的 Telegram/安全纵切接管：

- 13 个 `external_operation`：模型连接 create/update/delete/clear-api-key/refresh-models，禅道实例 create/update/delete/clear-password，以及 Telegram Bot Token、External API Key 的 put/delete。
- 1 个 `core_application`：Project model-selection 保存。
- 2 个 `read_only_external_probe`：模型连接 diagnose、禅道 verify。两者会读取 SecretStore 并访问网络，但实现级不写业务状态，因此不伪造 Command WAL；只使用进程内 30 秒 TTL、128 条 active+replay 共同硬容量、1 MiB 结果预算的有界重放能力。新 identity 在访问网络前检查共同容量，已存在的同身份 active/replay 仍可复用。

公开命令固定为 `{command,input}`。Renderer 每次用户动作只生成一次 Envelope，Local API 连接刷新或传输重试复用同一个序列化 Body。scope 按真实资源含义划分：

| 资源 | scope |
| --- | --- |
| 模型连接元数据、目录刷新与诊断 | `provider_configuration` |
| 模型连接 API Key、Telegram Token、External API Key | `provider_account` |
| 禅道实例与密码 | `integration_account` |
| Project model-selection | `settings` |

## 耐久与敏感数据边界

外部操作先建立 Inbox/Outbox，再在第一次 Keychain、网络、Provider Runtime refresh 或相关复合写入之前耐久记录 write marker。marker 后的普通异常一律保守收口为 `outcome_unknown_after_write`，同 Command 不自动重发；当前 adapter 没有可证明的外部明确拒绝证据，因此不会把普通异常伪装成 `explicitly_rejected`。accepted 重放只读取原结果，不再次访问 Keychain、网络或 Provider。

模型目录等结果统一压缩写入内容寻址 `ArtifactStore`；receipt 只保存 Artifact SHA-256、内容 SHA-256、解码长度与 generation。Application 在形成 accepted 前验证 8 MiB 解码预算，重放再次核对 owner、双哈希、长度、generation 与同一预算，避免 SQLite evidence 写放大。

API key、token、password 明文只存在于本轮 HTTP Body 和调用栈：Command Envelope/Inbox 只保存 input SHA-256 与 operation identity；receipt、audit 与 result artifact 都不保存请求正文。错误先按本轮敏感值精确替换，再走全局脱敏并限制为 2 KiB。Project model-selection 则在一个 `durableTransactionSync` 内同时写 settings 业务事实、审计与 accepted receipt；重放不重新读取当前模型目录，也不重复 mutation。

## 收益、缺点与未验边界

收益：Renderer 重试不会重复写 Keychain、刷新 Provider 或调用外部网络；崩溃后 unknown 会失败关闭；accepted 大结果可精确重放而不膨胀 receipt；凭据明文不进入命令账本、审计或 Artifact；Project 模型选择不再与接纳证据形成双写。

缺点：每个外部 mutation 增加至少 prepare、write marker、Artifact 与 receipt 的同步耐久成本；unknown 需要后续依赖 Keychain/远端/Provider 证据对账；结果超过 8 MiB 时即使外部动作可能已完成也只能进入 recovery required；diagnose/verify 的进程内 replay 不是高可用状态，Core 重启后会重新执行只读网络探针；复合的“配置写入 + Runtime refresh”仍可能在进程崩溃时留下需要人工核对的中间事实。

行为 verifier 只使用临时 SQLite、临时 Artifact 根、Fastify inject、假 SecretStore/模型/禅道/Provider refresh port 与受控时钟；不会访问正式数据库、macOS Keychain、真实网络、真实 Provider 或启动 `Zeus Test.app`。它已验证 1.1 MiB accepted 结果只调用一次并以 ArtifactRef 重放、unknown 只调用一次且阻断重发、Core 选择只写一次、探针 Inbox 行数为 0、active+replay 达到共同容量时新 identity 在网络调用前以 429 拒绝、明文不出现在命令表或 audit，以及 `PRAGMA quick_check=ok`。真实 Keychain 权限、网络超时、Provider reload、Core 崩溃和 GUI 重试仍需独立运行验收。

可重复命令：

- `pnpm exec tsx scripts/verify-integration-command-behavior.ts`
- `node scripts/audit-command-side-effect-entries.mjs --require-integration-command-slice`
- `pnpm --filter @zeus/local-server build`
- `pnpm exec tsc -p apps/desktop/tsconfig.json --noEmit`
