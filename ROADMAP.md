# Zeus Roadmap

本路线图按设计书目标模式维护：已经由真实命令验证的能力放入“当前已验证能力”，依赖用户凭据或尚未批准依赖的能力放入“外部配置等待项”。不得把等待项写成已完成。

## 当前已验证能力

- 本地优先 macOS 桌面应用：Electron + React + TypeScript、macOS 菜单、Menu Bar、首次使用引导、多窗口开关、WebView 调试开关、后台运行偏好、错误边界与本地日志/缓存入口。
- 本地服务：Fastify app-server 仅监听 `127.0.0.1`，提供 token 保护 API、WebSocket 实时事件、健康检查、异常自动重启与退出清理。
- 本地存储：原生 SQLite 存储结构、自动初始化、项目/任务/会话/Git/Telegram/审计等核心表与可重建缓存清理。
- 项目与任务：真实本地目录校验、Git Root 检测、项目类型识别、项目配置、任务状态机、模板、筛选、归档、事件时间线与本地日志文件。
- AI Runtime：adapter 检测、AI CLI adapter 发布门禁探针、会话生命周期、Generic shell 高风险确认、Runtime 日志导出、不可用/未登录状态展示；不伪造 AI 回复。
- Git / Diff：只读 status/diff/snapshot/patch export，确认后白名单 Git 写操作接口；不提供任意 Git 子命令入口。
- Telegram：Bot Token Keychain 保存、白名单、long polling、命令分发、消息日志、通知设置和脱敏日志导出；未配置 token 时保持未启用。
- 安全与发布：Keychain、API token、日志脱敏、安全审计、DMG、ZIP、Homebrew cask、GitHub CI/Release workflow、README、CHANGELOG、CONTRIBUTING、Issue/PR 模板与实现报告。

## 最新验证基线

- `pnpm verify:release`：通过。
- 自动化测试体系已经退役；当前交付证据来自静态检查、生产构建、正式打包和真实运行验收。
- App 产物：ad-hoc 签名且未公证的 DMG/ZIP、`dist/mac-arm64/Zeus.app`、`dist/homebrew/zeus.rb`。
- 包内 Electron 加载：`electron=36.9.5;node=22.19.0;arch=arm64`。
- AI CLI adapter 探针：`ai-cli-adapters=checked;codex=available@0.145.0;claude=available@2.1.198;gemini=available@0.32.1;authStatus=real-probe-or-unknown`。
- GitHub Release `v0.1.0` 与 `imchenway/homebrew-tap` 已公开；标准 Homebrew 命令已完成真实下载、安装和启动验收。

## 外部配置等待项

- AI CLI 登录：等待用户在本机完成 Codex / Claude / Gemini 等 CLI 安装与登录。
- Telegram Bot Token 与 whitelist：等待用户提供真实 token 和允许的 Telegram user id。
- Apple signing / notarization：可选增强；用于改善 Gatekeeper 首次启动体验和启用严格 Apple 分发。
- Homebrew tap token：Actions 自动同步 Tap 时需要；不再是当前版本人工授权发布的阻塞项。

## 后续增强边界

- 在用户提供 Apple 凭据后补齐 Developer ID 签名与公证，并评估启用可信自动更新。

## 不做的降级

- 不使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复。
- 不把外部配置等待项写成已完成。
- 不把 unsigned DMG/ZIP 伪装成已签名或已公证产物。
