---
name: Bug report
about: Report a Zeus issue with real local evidence
---

## 现象

请用一句话说明用户实际看到的问题，例如页面状态、API 响应、Runtime 输出、Telegram 回复或打包结果。

## 影响

- 影响的入口：Dashboard / Projects / Tasks / Code Map / Runtime / Git / Telegram / Settings / Packaging
- 影响范围：单个项目 / 所有项目 / 单个任务 / 所有任务 / 仅本机配置
- 是否阻断继续使用：是 / 否

## 复现步骤

1. 打开或创建哪个真实本地项目。
2. 执行了哪个真实操作或命令。
3. 看到的实际结果是什么。

## 期望行为

说明 Zeus 应该展示什么真实状态、空态、失败态或等待项。不要把缺少外部配置的能力描述为应当成功。

## 真实数据来源

请列出用于复现的问题来源，例如本地代码库、SQLite、Git diff、Runtime 会话、Keychain、Telegram update、DMG/ZIP 产物或用户明确创建的记录。

> Zeus 不得用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点来复现或掩盖缺陷。

## 日志与脱敏

- 可以粘贴脱敏后的错误信息、request path、任务 ID、项目 ID、会话 ID、文件路径和时间点。
- 不得粘贴明文 token、API Key、数据库密码或完整终端密钥输出。
- 如果问题涉及 Telegram、Keychain、AI CLI 登录或 Apple signing / notarization，请只说明配置状态和等待项。

## 环境

- macOS 版本：
- CPU 架构：arm64 / x64
- Zeus 版本：
- 启动方式：`pnpm dev` / packaged app / DMG / ZIP / Homebrew cask
- 是否配置外部能力：AI CLI / Telegram Bot Token / Apple signing / Homebrew tap token

## 回归验证

- [ ] 已提供能复现现象的最小步骤。
- [ ] 已说明真实数据来源或外部配置等待项。
- [ ] 已说明期望的空态、失败态或成功态。
- [ ] 修复后需要补充聚焦测试。
- [ ] 发布前需要按影响范围运行 `pnpm verify:release` 或说明无法运行的原因。
