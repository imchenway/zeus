# OpenAI Codex runtime attribution

Zeus 的原生会话运行时基于 [OpenAI Codex](https://github.com/openai/codex)，按照 Apache License 2.0 使用和分发。

- 上游 release：`rust-v0.144.2`
- 上游 commit：`a6645b6b8a656360fa16fb7e1c6721d0697d3d6a`
- 上游 tag object：`06eee5f70addf0b8cf331d5c6721f0414e7d2ae6`
- 官方 commit archive SHA-256：`a18d8d1ab77fa7dab9636ce679f812f884dfaddfad9a3ee830bf9ff64a4594e7`
- 上游许可证：Apache License 2.0

Zeus 只维护 `runtime.lock.json` 中列出的补丁。当前补丁用于增加 `zeus-legacy` 会话导入来源；thread、turn、item、rollout、metadata、状态索引、导入账本和崩溃恢复仍由 Codex Rust app-server 负责。

构建和分发产物必须同时包含上游 `LICENSE`、本文件、完整 commit 标识、补丁列表和产物 SHA-256。不得从用户 PATH 或另一个应用包复制未知版本的 Codex 二进制。
