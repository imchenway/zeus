---
status: accepted
---

# Responses 兼容证据驱动新会话运行内核路由

Zeus 对内置模型供应源不按品牌固定运行内核，而是在新建会话时依据“接入渠道、模型、端点和 App Server 版本”的 Responses 兼容证据自动选择 App Server 或 Pi，并把结果固化为该会话身份。这样可以让完整兼容 Responses 的 DeepSeek 官方 V4 模型使用 App Server，同时保留 Pi 对其他协议和渠道的覆盖；代价是需要维护兼容证据和双运行内核，且既有会话不能静默迁移或在失败后跨内核重放。

## ZEUS-0311 修订

路由不再固化为产品会话身份，而是固化到每个不可变 submission 的执行快照与目标运行分段。官方 DeepSeek V4 Pro/Flash 继续使用 `codex_app_server + openai_responses`，其他外部模型使用 `pi_sdk + openai_completions`。同凭据槽位换 Key 可读取最新密钥；端点、协议、route 或可识别账号身份变化必须暂停旧提交并创建改路由 replacement，禁止静默跨内核重放。
