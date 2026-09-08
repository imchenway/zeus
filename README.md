# Zeus

Zeus 是一款 AI 研发工作台，将项目与任务管理、Coding Agent 会话、代码理解、Git 变更审查和自动化协作整合在同一个工作空间中。

## 功能

- 管理项目、任务和 Coding Agent 会话。
- 扫描真实代码，生成架构、模块、接口和数据关系图。
- 基于代码图谱、源码和 SQL 进行检索与问答。
- 接入 Codex、Claude、Gemini 等 Coding Agent，并保存执行日志。
- 查看 Git 状态与 Diff，重要写操作保留确认步骤。
- 可选接入 Telegram，接收通知和执行受控命令。

## 安装

当前 Homebrew 安装包支持 Apple Silicon Mac，要求 macOS 13 或更高版本。

```bash
brew install --cask imchenway/tap/zeus
```

安装完成后，可从“应用程序”打开 Zeus。升级使用：

```bash
brew upgrade --cask imchenway/tap/zeus
```

彻底卸载 Zeus（包括 Homebrew Cask 已登记的本地配置）使用：

```bash
brew uninstall --cask --zap imchenway/tap/zeus
```

如需保留本地项目、会话和配置，请去掉 `--zap`，使用 `brew uninstall --cask imchenway/tap/zeus`。

也可以前往 [GitHub Releases](https://github.com/imchenway/zeus/releases) 下载安装包。

## 首次打开

当前公开版本尚未经过 Apple 公证。首次打开时，如果 macOS 提示无法验证 Zeus：

1. 关闭提示窗口。
2. 打开“系统设置”。
3. 进入“隐私与安全性”。
4. 在安全性区域找到 Zeus，点击“仍要打开”。
5. 根据系统提示再次确认打开。

即：**系统设置 → 隐私与安全性 → 仍要打开**。

如果没有看到“仍要打开”，请先再次尝试启动 Zeus，然后返回该页面。此操作只会为当前 Mac 添加一次例外，具体说明见
[Apple 官方帮助](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)。

未配置 Apple Developer 凭据时，公开包仍采用 ad-hoc 签名且不做公证；发布清单会如实标记该状态。生产 ad-hoc 包包含稳定的代码
requirement，用于减少升级后因代码身份变化而重复询问“文稿”“下载”等隐私权限。用户主动选择项目、附件或导出位置时，macOS 仍可能
按真实目录访问边界请求授权。配置 Developer ID 与公证凭据后，仍可显式启用严格 Apple 分发。

版本更新内容见 [GitHub Releases](https://github.com/imchenway/zeus/releases)。

## 开发与验证

使用 Node.js 24–25 和 pnpm 10，首次运行 `pnpm install --frozen-lockfile`。

- `pnpm dev`：构建后直接运行 Electron 源码，不生成安装包；开发数据使用当前仓库的 `.tmp/electron-development-data`，与 DMG 安装版分开。
- `pnpm verify:publish`：本地与 CI 共用的检查入口，执行冲突、格式、Lint、架构边界、类型和构建检查，不发布。
- `pnpm package:mac`：默认只生成独立身份 `Zeus Test.app`，输出到 `dist/test/mac-arm64/`（Intel 为 `dist/test/mac/`）；运行验收使用独立用户数据目录。
- `pnpm package:mac:release`：生成正式 DMG；仅在明确需要安装包或发布时执行。
- `pnpm verify:release`：正式发布候选的检查、打包和产物校验；不自动安装或发布。

日常改动按影响范围执行检查；行为变化补充真实运行证据。既有专项探针按需使用，不默认全量运行。
开启 Computer Use 后可控制另一个独立的 Zeus Test 实例，无需额外 QA 模式；当前宿主、控制服务和正式 Zeus 实例仍禁止控制，敏感操作仍需用户确认。多个 Test 同时运行时使用应用绝对路径指定目标。
发布正文由发布准备流程写入 `releases/v<版本>.md`。任务记录可保留在本地 `docs/ZEUS-*` 或 `docs/TASK_*`，这些文件已加入 Git 忽略规则，不随源码提交。旧记录可从 Git 历史查阅，不维护新旧两套发布文档路径。
