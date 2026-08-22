---
status: accepted
---

# 采用 CQRS-lite 与事务性 Inbox/Outbox

Zeus 用显式状态机保存当前业务事实，用小型不可变审计记录解释关键迁移，并在同一 SQLite 事务内提交业务状态、Outbox、Inbox 回执和同步水位。相比完整 Event Sourcing，这避免永久重放全部 Provider 与流式事件的存储和迁移成本；代价是投影与状态机必须版本化、消费者必须幂等，而且 Provider 副作用结果未知时只能暂停核对，不能宣称 exactly-once 或自动重试。
