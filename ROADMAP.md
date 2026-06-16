# Zeus Roadmap

本路线图按设计书目标模式维护：已经由真实命令验证的能力放入“当前已验证能力”，依赖用户凭据或尚未批准依赖的能力放入“外部配置等待项”。不得把等待项写成已完成。

## 当前已验证能力

- 本地优先 macOS 桌面应用：Electron + React + TypeScript、macOS 菜单、Menu Bar、首次使用引导、多窗口开关、WebView 调试开关、后台运行偏好、错误边界与本地日志/缓存入口。
- 本地服务：Fastify app-server 仅监听 `127.0.0.1`，提供 token 保护 API、WebSocket 实时事件、健康检查、异常自动重启与退出清理。
- 本地存储：SQLite / sql.js schema、自动初始化、项目/任务/会话/Git/代码索引/图谱/Telegram/审计等核心表与可重建缓存清理。
- 项目与任务：真实本地目录校验、Git Root 检测、项目类型识别、项目配置、任务状态机、模板、筛选、归档、事件时间线与本地日志文件。
- AI Runtime：adapter 检测、AI CLI adapter 发布门禁探针、会话生命周期、Generic shell 高风险确认、Runtime 日志导出、不可用/未登录状态展示；不伪造 AI 回复。
- Git / Diff：只读 status/diff/snapshot/patch export，确认后白名单 Git 写操作接口；不提供任意 Git 子命令入口。
- 代码扫描与图谱：真实扫描 TypeScript/Electron/SQLite 代码，并通过轻量规则支持 Java/Spring/MyBatis/SQL/DDL 事实提取；生成系统架构图、表关系图、模块图、模块详情图、接口时序图、模块流程图、方法逻辑图。
- 图谱联动：图谱搜索、节点详情、边详情、邻居、图谱问答、问答历史、从图谱节点/问答创建任务、任务完成后回写图谱。
- Telegram：Bot Token Keychain 保存、白名单、long polling、命令分发、消息日志、通知设置和脱敏日志导出；未配置 token 时保持未启用。
- 安全与发布：Keychain、API token、日志脱敏、安全审计、DMG、ZIP、Homebrew cask、GitHub CI/Release workflow、README、CHANGELOG、CONTRIBUTING、Issue/PR 模板与实现报告。

## 最新验证基线

- `pnpm verify:release`：通过。
- 单元/集成测试：63 test files / 548 tests passed。
- 真实扫描：163 files / 16327 nodes / 32021 edges / 7 views。
- App 产物：unsigned DMG/ZIP、`dist/mac-arm64/Zeus.app`、`dist/homebrew/zeus.rb`。
- 包内 Electron 加载：`electron=36.9.5;node=22.19.0;arch=arm64`。
- AI CLI adapter 探针：`ai-cli-adapters=checked;codex=available@0.139.0;claude=available@2.1.152;gemini=available@0.32.1;authStatus=real-probe-or-unknown`。

## 外部配置等待项

- AI CLI 登录：等待用户在本机完成 Codex / Claude / Gemini 等 CLI 安装与登录。
- Telegram Bot Token 与 whitelist：等待用户提供真实 token 和允许的 Telegram user id。
- Apple signing / notarization：等待用户提供 Apple Developer 证书、App Store Connect / notarization 凭据。
- Homebrew tap token：等待用户提供发布到远端 tap 的凭据。
- Postgres / MySQL driver：可选连接器，不属于 Zeus 本地核心依赖；仅在用户项目显式配置外部数据库 introspection 时启用，当前只允许安全记录连接意图和拒绝明文密码 URI。

## 后续增强边界

- 大图 Sigma/WebGL 与局部 React Flow 已接入；Postgres/MySQL 真实连接扫描作为可选连接器按用户项目配置单独启用。
- 在用户提供外部凭据后完成签名、公证、GitHub Release 发布和远端 Homebrew tap 发布。
- 持续增强复杂 Java/Spring/MyBatis/SQL/TypeScript AST 精度；当前 Java/Spring/MyBatis fixture 已纳入 release gate，所有图谱节点和边仍必须可追溯到真实源码、SQL、DDL、Git 或用户明确创建的记录。

## 不做的降级

- 不使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点。
- 不把外部配置等待项写成已完成。
- 不把 unsigned DMG/ZIP 伪装成已签名或已公证产物。
- 不把缺少驱动的外部数据库连接伪装成扫描成功。
