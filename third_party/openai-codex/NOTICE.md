# OpenAI Codex runtime attribution

Zeus 的原生会话运行时基于 [OpenAI Codex](https://github.com/openai/codex)，按照 Apache License 2.0 使用和分发。

- 上游 release：`rust-v0.145.0-alpha.30`
- 上游 commit：`3b61fac9b7d7b003183ff1b73c28df6abeb062a4`
- 上游 tag object：`104fc3cff2250d78f38ddbbfbc7a6cf405e5f5e5`
- 官方 commit archive SHA-256：`7c7c9fea10e45553a2c4b143a6df9fa7a5e52a7cca57d7216ebe4e0c3eceef62`
- 上游许可证：Apache License 2.0

Zeus 只维护 `runtime.lock.json` 中列出的补丁。当前补丁用于增加 `zeus-legacy` 会话导入来源；thread、turn、item、rollout、metadata、状态索引、导入账本和崩溃恢复仍由 Codex Rust app-server 负责。

构建和分发产物必须同时包含上游 `LICENSE`、本文件、完整 commit 标识、补丁列表和产物 SHA-256。不得从用户 PATH 或另一个应用包复制未知版本的 Codex 二进制。
