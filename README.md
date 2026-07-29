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

更多技术信息参见[发布说明](docs/release.md)和[架构文档](docs/architecture.md)。
