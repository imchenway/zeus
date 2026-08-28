# ZARCH-030～031 Telegram、安全与轮询命令纵切

## 范围与分类

本纵切只接管 Local Server 已存在的 11 个公开 mutation；对应 GET 查询仍保持只读，不扩大到 Task status 的后台 Telegram 通知或其他 Provider 路由。

| 分类 | 公开路由 | 稳定命令类型 |
| --- | --- | --- |
| `external_operation` | `POST /api/security/reset` | `security.reset` |
| `core_application` | `PUT /api/telegram/notification-settings` | `telegram.notification_settings.update` |
| `external_operation` | `POST /api/telegram/test` | `telegram.connection.test` |
| `external_operation` | `PUT /api/telegram/security-settings` | `telegram.security_settings.update` |
| `external_operation` | `POST /api/telegram/dispatch-preview` | `telegram.dispatch_preview` |
| `external_operation` | `PATCH /api/telegram/settings` | `telegram.settings.update` |
| `external_operation` | `POST /api/telegram/start`、`POST /api/telegram/polling/start` | `telegram.polling.start` |
| `external_operation` | `POST /api/telegram/stop`、`POST /api/telegram/polling/stop` | `telegram.polling.stop` |
| `external_operation` | `POST /api/telegram/polling/poll-once` | `telegram.polling.poll_once` |

合计为 10 条 `external_operation` 和 1 条 `core_application`。所有公开写请求只接受 `{ command, input }`；Envelope 的 payload 只保存稳定 `operationIdentity` 和 canonical input SHA-256。Renderer 在一次用户意图开始时只创建一次不可变 Envelope，Local transport 重连复用同一份序列化 body。

## 接纳、写出与重放语义

通知开关属于纯 Core 设置：Inbox、Core Outbox、设置 mutation、审计事实和 `accepted` receipt 在一个 SQLite 耐久事务中提交；accepted replay 读取既有结果，不重复写设置。

安全重置、Telegram 网络访问、Keychain 与 poller 生命周期都属于外部操作。Application 先建立 Inbox/Outbox；预检失败形成 `failed_before_write`，允许同一不可变命令安全建立下一 attempt。首次 Keychain、Telegram 或 poller 写入前必须耐久提交 parent write marker，并为复合动作派生不含 token、chat id 或消息正文的稳定 child identity。写出后的结果只能收口为：

- Telegram API 返回明确拒绝时记 `explicitly_rejected`；
- 能证明完成时记 `accepted`；
- 网络超时、断链或其他无法证明结果的异常记 `outcome_unknown_after_write`，禁止自动重发；
- 只有尚未越过 write marker 的异常才记 `failed_before_write`。

连接测试按 chat 顺序执行单次发送，不再把普通 timeout 当作可重试失败。既有后台通知发送也改为单次调用；只有 Telegram 的明确响应才能证明拒绝，无法证明 before-write/rejected 的错误不会由 `sendTelegramNotificationWithRetry` 盲重放。

两组 start/stop 别名分别共享同一个稳定命令类型。`poll-once` 对相同命令使用 singleflight；不同命令共享最大 1 个 active operation 的硬容量，容量拒绝发生在写出前并留下 `failed_before_write` 回执，不进入无界队列。

## 敏感数据与审计边界

Bot token、External API Key、chat id 与消息正文不复制进 Command Envelope、Inbox、Outbox 或审计。安全重置审计只保留删除数量和动作类别；Telegram 设置审计不保留明文 token。错误先按本轮敏感值及通用规则脱敏，再限制为 2 KiB；receipt 限制为 64 KiB。真实 secret 只存在于当前 HTTP body、Keychain 调用和短期调用栈。

安全重置和安全设置更新是可审计复合命令：poller stop、缓存 sender 失效、Keychain 删除/读取与最终设置写入都挂在同一个 parent operation 下。若任一 child 越过写出边界后失去结果证据，parent 保守进入 unknown，不会继续用同一命令补发剩余动作。

## 收益、缺点与未验边界

收益：重复点击、Renderer 重连和 accepted replay 不会重复发送 Telegram、删除 Keychain secret 或启停 poller；unknown 不会被表面可用性掩盖；别名不能绕过同一语义身份；poll-once 有明确背压；命令账本和审计不持久化 token/plaintext。

缺点：每个外部操作至少增加 prepare、write marker 和 receipt 的同步 WAL 成本；poll-once 容量为 1 会降低并行吞吐；64 KiB 内联结果限制意味着未来更大结果需改用 `ArtifactRef`；复合命令目前只有 parent write marker，child identity 可稳定审计但没有逐 child 的独立完成账本，因此中途崩溃只能把 parent 判为 unknown 并人工对账。start 后每 30 秒的 poll tick 仍是 poller 内部后台事件，不是新的公开 Command；若以后要求逐 tick 可恢复审计，应单独设计事件账本，而不是扩大本纵切。

行为 verifier 只使用临时 SQLite、Fastify inject、假 poller 和假 Telegram 调用，不访问正式数据库、真实 Telegram、macOS Keychain、真实 Provider，也不启动 `Zeus Test.app`。已覆盖 accepted replay、四种结果、unknown 阻断重放、敏感数据脱敏、64 KiB 有界回执、poll-once singleflight/容量、两组别名共享命令类型和 `PRAGMA quick_check=ok`。真实 Keychain 权限、Telegram 网络明确拒绝/超时、Core 崩溃、后台 poll tick、正式数据库升级和 GUI 重试仍未运行验收。

可重复验证：

- `pnpm exec tsx scripts/verify-telegram-command-behavior.ts`
- `node scripts/audit-command-side-effect-entries.mjs --require-telegram-command-slice`
- `pnpm --filter @zeus/telegram-adapter build`
- `pnpm --filter @zeus/local-server build`
- `pnpm --filter @zeus/desktop exec tsc -p tsconfig.json --noEmit`
