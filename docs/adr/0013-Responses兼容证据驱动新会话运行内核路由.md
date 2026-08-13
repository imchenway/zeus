---
status: accepted
---

# Responses 兼容证据驱动新会话运行内核路由

Zeus 对内置模型供应源不按品牌固定运行内核，而是在新建会话时依据“接入渠道、模型、端点和 App Server 版本”的 Responses 兼容证据自动选择 App Server 或 Pi，并把结果固化为该会话身份。这样可以让完整兼容 Responses 的 DeepSeek 官方 V4 模型使用 App Server，同时保留 Pi 对其他协议和渠道的覆盖；代价是需要维护兼容证据和双运行内核，且既有会话不能静默迁移或在失败后跨内核重放。
