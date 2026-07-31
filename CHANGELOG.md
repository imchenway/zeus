# Changelog

## 0.1.3 - 2026-07-31

### 任务筛选

- 在“全部”右侧新增“未完成”快捷筛选，并作为没有历史偏好时的默认选项。
- “未完成”包含待开始、开发中、测试中、待验收和已阻塞，排除已完成与已取消。
- 用户显式切换筛选后按项目记忆选择，切换项目或重新启动 Zeus 后仍会恢复。
- 创建任务、从图谱创建任务和打开新对话不再覆盖项目已经保存的筛选偏好。
- App Shell 设置导入、导出、审计与旧设置迁移同步支持项目筛选偏好。

## 0.1.0 - 2026-07-29

### 已验证产物

- `pnpm verify:release` 已通过；当前自动化测试体系已经退役，发布证据来自静态检查、生产构建、正式打包和真实运行。
- 真实代码扫描已通过：163 files / 16327 nodes / 32021 edges / 7 views。
- macOS ad-hoc 签名且未公证的 DMG/ZIP 已生成并通过发布门禁：
  - `dist/mac-arm64/Zeus.app`
  - `dist/Zeus-0.1.0-arm64.dmg`
  - `dist/Zeus-0.1.0-arm64.zip`
- 包内 Electron 可执行文件已由发布门禁加载验证：`electron=36.9.5;node=22.19.0;arch=arm64`。
- AI CLI adapter 探针已纳入发布门禁：`ai-cli-adapters=checked;codex=available@0.145.0;claude=available@2.1.198;gemini=available@0.32.1;authStatus=real-probe-or-unknown`，只检测真实命令/版本/登录输出，不伪造已登录状态。
- Homebrew cask sha256：`5ba434a0c71b4e8140eb065df6b16e839cf5f17b97c0a4adcbd7d6f07f3a52a9`。
- GitHub Release 已公开：`https://github.com/imchenway/zeus/releases/tag/v0.1.0`。
- Homebrew Tap 已同步，`brew install --cask imchenway/tap/zeus` 已完成真实下载、安装和启动验收。
- Homebrew 安装版 `/health` 返回 `ok=true`、`version=0.1.0`、`database=ok`、`runtime=ok`。

### 主要能力

- 本地优先 Electron + React + TypeScript macOS 桌面应用。
- 本地 Fastify API、SQLite 持久化、真实代码扫描、图谱视图、图谱问答、任务管理、AI Runtime、Git Diff、Telegram long polling、安全 Keychain、审计日志。
- `pnpm dev`、Codex Run 按钮、`script/build_and_run.sh` 已对齐到同一 macOS 启动链路。
- 该版本发布时 `pnpm verify:release` 曾覆盖 lint、typecheck、自动化测试、真实扫描、构建、打包、Homebrew cask 生成和包内 App 可执行加载；当前门禁以静态检查、生产构建、正式打包和真实运行验收为准。

### 可选增强与外部配置

- Apple signing certificate：后续可选增强；当前公开产物使用 ad-hoc 签名。
- notarization：后续可选增强；当前 manifest 明确记录 `notarized=false`。
- Telegram Bot Token / 白名单：等待用户按真实账号配置。
- AI CLI 登录状态：等待用户在本机完成 Codex/Claude/Gemini 等 CLI 安装与登录。
- Homebrew tap token：仅 Actions 自动同步需要；当前版本已在明确授权下完成 Tap 发布。
- `node-pty` / `xterm`、Sigma/WebGL、React Flow 已接入；Postgres/MySQL 驱动仅作为可选连接器，非 Zeus 本地核心依赖。

- GitHub Release workflow 支持已有 tag 创建非草稿 Release、同步 Tap，并可按需启用 Developer ID 与 Apple 公证严格门禁。
