---
status: accepted
---

# 不新增第三份 Zeus 完整会话 JSONL

Codex、Pi 等 Provider 已拥有原生会话记录，Zeus 继续以 SQLite 保存业务事实和有界投影，不再复制一份完整原始会话 JSONL。这个决定避免 Provider 原生日志、Zeus JSONL 和 Zeus SQLite 三份事实之间的跨文件补偿、删除与隐私不一致；代价是 Zeus 的诊断与恢复继续依赖 Provider 正式读取协议，协议不可用时必须降级而不能自行重放猜测。
