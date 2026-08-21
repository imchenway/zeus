# ZARCH-030/031 Pi Provider 命令纵切

## 结论

Pi 的 5 个真实 Provider 写点已统一进入 `provider_session` / `provider_turn` Command Delivery。动态审计此前把它们标成 pending，不是业务实现丢失，而是组合根加入正式数据只读验证分支后，审计仍只识别旧的单行 `createPiNativeConversationCoordinator` 写法。审计现已按完整组合块核对：只读验证使用禁用协调器，普通模式继续向真实 Pi 协调器注入同一个 `CommandDeliveryRepository`。

本文严格区分产品会话、提交、原生会话和原生 run。Provider session receipt 不能冒充产品会话事实，Provider turn receipt 也不能只保存 Zeus turn ID。

## 精确入口清单

| 入口 | Command type | destination | 稳定父资源 | accepted 原生身份 |
| --- | --- | --- | --- | --- |
| 新原生会话 `driver.openSession` | `provider.pi.session.open` | `provider_session` | 产品会话 | `nativeSessionId`，`nativeTurnId=null` |
| 新会话首轮 `driver.startRun` | `provider.pi.run.start` | `provider_turn` | 提交 | `nativeSessionId` + `nativeRunId` |
| 既有会话续轮 `driver.startRun` | `provider.pi.run.start` | `provider_turn` | 提交 | `nativeSessionId` + `nativeRunId` |
| 活动轮次插话 `driver.steerRun` | `provider.pi.run.steer` | `provider_turn` | 插话提交 | `nativeSessionId` + `nativeRunId` |
| 活动轮次中断 `driver.interruptRun` | `provider.pi.run.interrupt` | `provider_turn` | Zeus turn | `nativeSessionId` + `nativeRunId` |

Provider 子命令 ID 由 operation、真实 scope、scope ID 和既有不可变 command key 确定性派生；幂等键也按 operation 与原始幂等身份确定性派生。session 与 run 使用两个独立命令，不合并成无法判断崩溃位置的 composite attempt。

## 写出与回执协议

每个入口固定执行以下协议：

1. `acceptAndPrepare` 建立 Inbox 与对应 destination 的 Outbox。
2. 调用 Pi Driver 前耐久写入 `provider_write_started`。
3. 只允许 `failed_before_write`、`explicitly_rejected`、`outcome_unknown_after_write`、`accepted` 四种结论。
4. 写出后无法证明明确拒绝的异常一律记为 unknown；Repository 与数据库约束都禁止自动创建新 attempt。
5. 只有 Pi 预检拒绝、目标 run 不活动、目标 session 未载入这三类可证明结论可进入明确拒绝并安全重试。
6. 首轮和续轮在 Segment Lifecycle 中把会话接纳事实与 run receipt 放进同一耐久事务；不经过 Segment Lifecycle 的内部续派也在 Driver 放行 Provider 写出前原子提交 turn、submission 投影与 receipt。steer 和 interrupt 同样把业务投影与 receipt 放在一个事务中。
7. `openSession` 返回后，先完成产品会话或 provisional Segment 的本地预备，再在一个 `durableTransactionSync` 中同时写入原生 session 身份投影与 session accepted receipt。事务任一步失败会整体回滚，随后只能记录 `outcome_unknown_after_write`；进程内 attempt 也只有在 COMMIT 成功后才能标为 settled。后续 run 失败不得倒写或删除已经原子提交的真实 session 事实，也不得据此自动新建替代 session。

恢复只列出需要人工或原生证据核对的 unknown，不自动重发。只有取得同一原生 session/run 的确证后，才允许在原 attempt 上追加 accepted 收敛回执。

## 有界证据与敏感信息

Pi 命令的 request payload 只保存请求摘要，不复制 prompt、图片或凭据。accepted evidence 只包含 operation 和真实原生身份，当前没有需要 ArtifactRef 的大结果。

失败回执先使用 Local Server 的统一敏感文本清理，再把 code、name 限制为 256 bytes、message 限制为 2 KiB。未来若 Pi Provider 命令需要保存超过内联预算的完整响应，必须改用内容寻址 ArtifactRef，不能放宽 receipt 上限或把原始 Provider payload 写入 SQLite。

## 收益

- Renderer 重连、Core 重启和重复点击不会重复创建 Pi session、重复发起 run、重复插话或重复中断。
- session 与 run 分开记账，可以准确判断“session 已创建但首轮未知”，避免重新创建另一原生会话。
- Pi session accepted receipt 与产品会话/候选 Segment 的原生身份投影共用一次提交；run、steer、interrupt 的 accepted receipt 也与各自接纳投影共用事务。这里消除的是这些明确接纳边界的“accepted 已提交但本地身份缺失”窗口，不代表所有提交后广播、内存 context 或外部 Worker 生命周期都具备跨系统原子性。
- 回执只保存摘要、真实原生身份和有界脱敏错误，降低 SQLite 膨胀与秘密泄露风险。
- 只读验证分支与普通运行分支均被结构审计覆盖，后续组合根改形状不会静默把 5 个写点降级成未接管。

## 缺点与代价

- 新会话至少多一次 session 命令和一次 run 命令的同步 WAL 写入，首轮延迟与写放大高于直接调用 Driver。
- session 已 accepted 而 run unknown 是合法组合，恢复状态数量和运维判断复杂度增加。
- session 原子提交后、首轮 run 尚未建立时若进程退出，当前启动恢复不会再次调用 `openSession`，也不会把 session-only receipt 冒充 accepted turn；已投影的 provisional session 身份只作为后续显式对账或继续派发依据。该路径保证不重复创建，但尚不提供自动续跑可用性。
- `openSession` 已真实创建但本地原子提交回滚时只能记为 unknown，可能留下需要原生证据或人工核对的孤立 Provider session；为了避免重复创建，系统不会用自动重试换取表面可用性。
- unknown 禁止盲重试会降低瞬时故障下的表面可用性，必须等待 Provider 原生证据或用户显式处置。
- 事务内业务投影增加同步事务工作量；后续新增大结果时还需要 Artifact 生命周期、完整性与保留治理。
- Command identity 依赖不可变 submission/turn 身份；调用方若错误复用幂等键但更换正文，会失败关闭而不是“尽量执行”。

## 行为与结构核验

行为核验只使用临时数据库和模拟事实，不访问真实 Provider 或正式数据库：

```text
pnpm exec tsx scripts/verify-pi-provider-command-delivery.ts
```

该核验覆盖 session/turn destination、真实原生身份、稳定父子命令、session 本地投影与 receipt 原子提交、在两者均写入后注入事务回滚、回滚后仍可收敛 unknown 且 replay 被阻断，以及 run 投影原子回滚、四态、安全重试、unknown 单 attempt、2 KiB 脱敏错误和 `PRAGMA quick_check`。

动态结构审计：

```text
node scripts/audit-command-side-effect-entries.mjs --require-complete
```

Pi 子切片必须显示 5/5 integrated；`--require-complete` 同时会为其他尚未迁移的 Local Server 入口失败关闭，因此全仓完成状态以最终总门禁为准，不能用本文的 5/5 代替。
