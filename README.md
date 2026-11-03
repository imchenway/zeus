<div align="center">

# Zeus

**把任务、代码和 AI 团队放在一起。**

本地优先的 AI 研发工作台 · macOS / Windows

[官网](https://zeus-ai-workbench.imchenway.chatgpt.site/) · [下载](https://github.com/imchenway/zeus/releases/latest) · [产品导览](https://zeus-ai-workbench.imchenway.chatgpt.site/tour.html) · [问题反馈](https://github.com/imchenway/zeus/issues)

[![Latest release](https://img.shields.io/github/v/release/imchenway/zeus?style=flat-square&color=7560D8&label=release)](https://github.com/imchenway/zeus/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-7560D8?style=flat-square)](LICENSE)

<a href="https://zeus-ai-workbench.imchenway.chatgpt.site/">
  <img src=".github/assets/zeus-hero.png" width="420" alt="Zeus 品牌插画：坐在云上使用电脑的宙斯">
</a>

</div>

Zeus 将项目任务、AI 会话、源码编辑、Git 和自动化协作整合在同一个桌面工作空间。从拆解需求、讨论方案，到修改代码、检查差异与交付，让工作围绕项目持续展开。

## 项目里的事，在一个地方完成

| 工作区 | 可以做什么 |
| --- | --- |
| **任务管理** | 在列表与看板之间切换，管理状态、优先级、标签和截止时间，关联任务会话。 |
| **源码** | 浏览目录、搜索文件、多标签编辑与保存，在查看改动时定位到对应源码。 |
| **Git** | 查看多仓库状态、Diff 和提交历史，管理分支、比较改动并处理合并。 |
| **自定义命令** | 配置全局或项目命令，设置参数与超时，查看运行日志、生成文件和执行历史。 |

需要隔离开发时，可以为会话创建独立的 Git 工作树。多仓库项目支持分别选择各仓库的来源分支和工作树分支，并按仓库查看与交付改动。

## 让 AI 接着往下做

- **AI 会话**：带上项目上下文讨论、规划和执行，选择模型与推理级别，查看执行过程。
- **数字员工**：为员工配置工作方式、模型、技能和记忆，复用不同角色的工作设置。
- **可视化团队**：把员工拖入画布、连接依赖、配置节点，在运行视图中查看分工进度与交付。
- **自动化**：按时间或任务事件触发工作，在通知中心查看结果。
- **Skills 与插件**：从本地目录或 Git 仓库安装扩展，按工作类型配置默认技能，管理插件提供的 MCP 工具与应用连接。

还可以按需连接 **Telegram 私聊机器人**，绑定项目与执行角色，并配置远程审批。

想先了解操作方式，可以打开[产品导览](https://zeus-ai-workbench.imchenway.chatgpt.site/tour.html)。导览使用示例内容；实际项目操作在 Zeus 桌面应用中完成。

## 下载与安装

从 [GitHub 最新发布](https://github.com/imchenway/zeus/releases/latest) 获取安装包，无需从源码构建。

| 系统 | 架构 | 选择的安装包 |
| --- | --- | --- |
| macOS 13 或更高版本 | Apple Silicon | `Zeus-<版本>-arm64.dmg` |
| Windows 10 22H2 / Windows 11 | Intel / AMD x64 | `Zeus-<版本>-win32-x64.exe` |
| Windows 10 22H2 / Windows 11 | ARM64 | `Zeus-<版本>-win32-arm64.exe` |

Windows 可在「设置 → 系统 → 关于」中确认系统类型。双击 EXE 安装包即可安装，无需 WSL。

**macOS 也可以通过 Homebrew 安装：**

```bash
brew install --cask imchenway/tap/zeus
```

<details>
<summary><strong>macOS 首次打开出现安全提示</strong></summary>

签名与公证状态以对应版本的发布清单为准。如果 macOS 提示无法验证 Zeus：

1. 确认安装包来自本仓库的正式发布页。
2. 关闭提示，打开「系统设置 → 隐私与安全性」。
3. 在安全性区域找到 Zeus，点击「仍要打开」，再按系统提示确认。

如果没有看到该选项，请先再次尝试启动 Zeus，再返回设置页面。可参考 [Apple 官方说明](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)。

</details>

<details>
<summary><strong>如何升级</strong></summary>

Homebrew 用户：

```bash
brew upgrade --cask imchenway/tap/zeus
```

手动安装用户：先退出 Zeus，再从[最新发布](https://github.com/imchenway/zeus/releases/latest)下载对应系统与架构的安装包，完成升级。更新内容与签名状态请查看该版本的发布说明和清单。

</details>

## 开始使用

1. **添加项目**：选择你的本地项目目录，让任务、会话和代码围绕同一个项目组织。
2. **配置模型接入**：在设置中完成所选服务的登录或凭据配置，选择要使用的模型。
3. **创建任务并开始工作**：新建会话，或选择已配置的数字员工、团队处理任务。
4. **检查与交付**：阅读源码和 Git 差异，运行项目命令验证结果，再完成相应的提交与合并操作。

Zeus 采用本地优先的工作方式。使用外部模型、插件或集成时，相关内容会按配置与相应服务通信；模型能力与可用选项取决于所选接入方式。

## 本地开发

开发环境使用 **Node.js 24.x** 和 **pnpm 10.31.0**。

```bash
git clone https://github.com/imchenway/zeus.git
cd zeus
pnpm install --frozen-lockfile
pnpm dev
```

开发模式默认使用独立数据目录，与安装版数据隔离。

<details>
<summary><strong>原生构建与验证</strong></summary>

桌面构建包含原生组件，除 Node.js 与 pnpm 外，还需要相应的平台工具链：

- macOS：Xcode Command Line Tools、Rust / Cargo。
- Windows：MSVC、Rust MSVC 工具链、.NET 8 SDK；可参考仓库的 [CI 配置](.github/workflows/ci.yml)。

提交前运行仓库统一检查：

```bash
pnpm verify:publish
```

该命令覆盖冲突与空白检查、变更文件格式、lint、架构边界、类型检查和生产构建。完整贡献与发布约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

</details>

## 参与贡献

欢迎报告问题、讨论需求和提交改进。

- **问题与建议**：[创建 Issue](https://github.com/imchenway/zeus/issues/new/choose)，附上版本、系统和复现步骤。
- **代码与文档贡献**：先阅读[贡献指南](CONTRIBUTING.md)。
- **安全问题**：按[安全政策](SECURITY.md)私下报告，请勿在公开 Issue 中粘贴凭据或私有项目内容。

## 许可证

Zeus 使用 [Apache-2.0](LICENSE) 许可证。
