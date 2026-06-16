# Changelog

## 0.1.0 - 2026-06-15

### 已验证产物

- `pnpm verify:release` 已通过：63 test files / 548 tests passed。
- 真实代码扫描已通过：163 files / 16327 nodes / 32021 edges / 7 views。
- macOS unsigned DMG/ZIP 已生成并通过发布门禁：
  - `dist/mac-arm64/Zeus.app`
  - `dist/Zeus-0.1.0-arm64.dmg`
  - `dist/Zeus-0.1.0-arm64.zip`
- 包内 Electron 可执行文件已由发布门禁加载验证：`electron=36.9.5;node=22.19.0;arch=arm64`。
- AI CLI adapter 探针已纳入发布门禁：`ai-cli-adapters=checked;codex=available@0.139.0;claude=available@2.1.152;gemini=available@0.32.1;authStatus=real-probe-or-unknown`，只检测真实命令/版本/登录输出，不伪造已登录状态。
- Homebrew cask sha256：`0610d3b917feb0db9e285efd51d4b3dfc602669776152f0252b4993ff9465c4d`。

### 主要能力

- 本地优先 Electron + React + TypeScript macOS 桌面应用。
- 本地 Fastify API、SQLite 持久化、真实代码扫描、图谱视图、图谱问答、任务管理、AI Runtime、Git Diff、Telegram long polling、安全 Keychain、审计日志。
- `pnpm dev`、Codex Run 按钮、`script/build_and_run.sh` 已对齐到同一 macOS 启动链路。
- `pnpm verify:release` 已覆盖 lint、typecheck、全量测试、真实扫描、构建、打包、Homebrew cask 生成和包内 App 可执行加载。

### 外部配置等待项

- Apple signing certificate：等待用户配置；当前仅验证 unsigned DMG/ZIP。
- notarization：等待用户配置；当前不伪造 notarization 成功。
- Telegram Bot Token / 白名单：等待用户按真实账号配置。
- AI CLI 登录状态：等待用户在本机完成 Codex/Claude/Gemini 等 CLI 安装与登录。
- Homebrew tap token：等待用户配置。
- `node-pty` / `xterm`、Sigma/WebGL、React Flow 已接入；Postgres/MySQL 驱动仅作为可选连接器，非 Zeus 本地核心依赖。

- GitHub Release workflow 保留签名、notarization、Homebrew tap token 输入，并支持已有 tag 创建 draft Release。
