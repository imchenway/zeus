# Zeus

Zeus 是一个本地优先的 macOS AI 研发工作台，把本地项目管理、真实代码扫描、代码图谱、AI CLI 执行、终端日志、Git Diff 审查与 Telegram 远程入口连接成一个桌面应用。默认不上传代码，不用假数据填充界面。

## 当前能力

- Electron + React + TypeScript macOS 桌面应用。
- 本地 Fastify API，默认只允许 `127.0.0.1`，不监听公网。
- SQLite 本地存储，项目、任务、会话、终端事件、Git 快照、对话、审计日志均来自真实操作。
- 真实代码扫描：直接扫描用户选择的本地仓库，抽取带来源的 symbols、SQL、表、字段、API route 与调用关系。
- 代码图谱：系统架构图、表关系图、模块详情图、接口时序图、模块流程图、方法逻辑图均由真实扫描事实生成。
- 图谱问答：基于真实图谱上下文、源码片段和 SQL 片段回答，并保留来源和历史。
- 任务管理：创建、筛选、归档、状态流转、模板、从图谱节点或 Runtime 会话创建任务。
- Runtime：检测 AI CLI，可启动真实本地 CLI 会话并保存日志；CLI 不可用时只显示等待配置，不伪造输出。
- Git Diff：只读读取当前仓库状态和 diff，高风险 Git 操作只创建确认记录，不自动执行提交、stash 或 reset。
- Telegram：支持 Bot Token、long polling、白名单、命令、通知、消息日志、安全确认和未配置状态。
- 安全：Token 存 macOS Keychain，日志/API/UI 不回显明文；支持清理密钥、安全审计和泄露风险重置。
- 发布：Electron Builder 可生成 DMG/ZIP，Homebrew cask 文件位于 `Casks/zeus.rb`；签名和 notarization 已预留但不伪造成已完成。

## 安装

本机打包后会生成以下安装物，路径随版本和架构变化；当前版本为 `0.1.0`，Apple Silicon 产物为：

```text
dist/Zeus-0.1.0-arm64.dmg
dist/Zeus-0.1.0-arm64.zip
dist/mac-arm64/Zeus.app
```

新用户可以从 GitHub Release 安装，也可以直接打开 DMG/ZIP。本地开发时可用 Homebrew cask 验证安装契约：

```bash
curl -fsSL https://github.com/imchenway/zeus/releases/latest/download/install.sh | bash
brew install --cask imchenway/zeus/zeus
```

```bash
brew install --cask ./Casks/zeus.rb
```

如在 Intel Mac 上打包，产物后缀会使用 `x64`。

## 快速验证

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:real-scan
pnpm build
pnpm package:mac
```

发布级门禁使用：

```bash
pnpm verify:release
```

该命令会串联 lint、typecheck、test、真实扫描、build 和 package:mac，并检查 DMG/ZIP/Homebrew cask、SHA256SUMS、install.sh 与更新 manifest 是否存在。未配置 Apple 证书时会明确报告 `unsigned DMG/ZIP`，不会声明签名或公证成功。

## 本地运行

Codex App 可使用 Run 按钮，入口为：

```bash
./script/build_and_run.sh
```

也可以只构建桌面应用：

```bash
pnpm --filter @zeus/desktop build
```

## 使用流程

1. 打开 Zeus。
2. 选择真实本地代码库。
3. 扫描真实代码并生成系统架构图、表关系图、模块详情图、接口时序图、模块流程图、方法逻辑图。
4. 在 Code Map 中搜索节点、查看来源、查看边详情，或从节点创建任务。
5. 在 Tasks 中创建、筛选、归档、恢复任务，必要时从模板创建真实任务。
6. 在 Runtime 中检测 AI CLI；CLI 可用时启动真实会话并查看终端日志，不可用时按设置页提示配置。
7. 在 Git Diff 中查看只读 diff；需要高风险 Git 操作时先生成确认记录。
8. 在 Telegram 中配置真实 Bot Token、白名单和通知目标，再启动 long polling。
9. 在 Settings 中管理 Keychain、通知、审计日志、泄露风险重置、签名和发布等待项。

## 外部配置等待项

Zeus 会实现检测、设置页和等待状态，但以下外部条件需要用户提供，不能在本仓库中伪造：

| 等待项 | 用途 | 未配置时行为 |
|---|---|---|
| AI CLI 登录状态 | Codex/Claude/Gemini 等本地 Runtime 执行 | 显示不可用原因，不生成假 AI 回复 |
| Telegram Bot Token | Telegram long polling、命令与通知 | 显示未配置，不伪造消息 |
| Telegram 白名单用户 ID | 限制远程入口 | 非白名单 update 被拒绝并记录日志 |
| Apple signing certificate | macOS 签名 | 只生成 unsigned DMG/ZIP |
| Apple notarization 凭据 | notarization | 显示等待配置，不伪造公证成功 |
| Homebrew tap token | 自动发布到 tap | 保留 cask 文件，本地可验证 |

## 数据原则

Zeus 不写入假项目、假任务、假图谱、假终端输出、假 Telegram 消息或假 AI 回复。没有真实来源时，界面展示空状态或等待配置状态。图谱节点和边必须能追溯到真实文件路径、源码行、SQL、DDL、Git 信息或用户明确创建的真实记录。

## 安全原则

- 本地服务默认绑定 `127.0.0.1`。
- 本地 API 使用 Bearer token。
- Bot Token 存 macOS Keychain。
- 日志、API 响应和 UI 不展示明文 token。
- Git 提交、stash、reset、shell、删除文件等高风险操作必须走确认或明确等待状态。
- 安全审计展示真实操作时间线，不展示 fake 样例。
- 泄露风险场景可使用“重置安全设置”清理密钥并关闭远程通知。

## 文档入口

- 架构：`docs/architecture.md`
- 本地优先：`docs/local-first.md`
- 安全：`docs/security.md`
- Runtime：`docs/ai-runtime.md`
- Telegram：`docs/telegram.md`
- 代码地图：`docs/code-map-engine.md`
- 发布：`docs/release.md`
- 测试：`docs/testing.md`
- 设计书：`docs/zeus_development_design.md`

## 更新日志

- 版本变更与发布证据见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 最终执行报告

目标模式完成时，报告必须列出：

- 完成摘要和设计书覆盖项。
- 运行过的真实命令，至少包含 `pnpm verify:release`。
- 测试结果、真实扫描结果、构建结果、打包结果。
- 生成的安装包路径，例如 `dist/Zeus-0.1.0-arm64.dmg` 与 `dist/Zeus-0.1.0-arm64.zip`。
- 外部配置等待项，包括 AI CLI 登录状态、Telegram Bot Token、Apple signing certificate、notarization 凭据和 Homebrew tap token。
- Release workflow 支持输入已有 tag 后创建 draft GitHub Release，并上传 DMG、ZIP、SHA256SUMS、install.sh、更新 manifest 与 Homebrew cask；没有 tag 时只上传 artifact，不伪造远端发布。
- 若未配置签名证书，必须明确说明产物是 unsigned DMG/ZIP，未 notarized。
