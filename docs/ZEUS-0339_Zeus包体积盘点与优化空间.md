# ZEUS-0339 Zeus 包体积盘点与优化空间

## 结论

Zeus 当前包有明确且较大的无损缩小空间。主要问题不是业务构建产物本身，而是生产包同时携带了大量已经被 Vite 打进 Renderer 的原始前端依赖、source map、TypeScript 源文件、类型声明、文档、调试变体和跨平台二进制。

在不更换 Electron、不删除业务能力的前提下，第一阶段预计可把安装后的 App 从约 `460.95 MiB` 降到约 `290 MiB`，减少约 `37%`。这是根据现包内容计算的未压缩 App 目标；DMG 压缩后的真实结果必须重新打包称重，不能按相同比例外推。

第二轮从“用户真正得到什么功能”深审后，结论进一步收敛：前端编辑器、看板、会话、Markdown、图谱和设置等全部 Renderer 成品合计只有约 `4.38 MiB`，砍这些功能不会显著缩小 App。更大的第二阶段空间在外部模型功能背后的 Pi 通用 SDK 依赖面：保留外部模型会话、压缩、重试、工具审批和用量能力，但改为真正的无界面运行内核后，App 有机会继续降到约 `260–275 MiB`。这是工程目标，必须用改造后的依赖图和真实 Pi 会话回归确认。

## 盘点对象与口径

- 盘点时间：2026-08-18。
- 已安装对象：`/Applications/Zeus.app`。
- 应用版本：`0.3.23`，与当前源码 `apps/desktop/package.json` 一致。
- Bundle ID：`dev.hypha.zeus`。
- 架构：arm64。
- 当前 GitHub Release：`v0.3.23`。
- DMG 文件：`Zeus-0.3.23-arm64.dmg`，逻辑大小 `152.05 MiB`。
- App 口径：使用 `du -sk` 统计实际目录占用，结果为 `460.95 MiB`。文件系统分配、Finder 显示和单文件逻辑大小可能存在少量差异。
- 本次只读取已安装正式 App，没有启动、改写或重新生成生产身份应用。
- 包内健康检查通过：Renderer 入口 20 个资源、Main、两个 Preload 和更新辅助程序均存在；Codex 仍使用用户本机安装，不随包分发。

## App 一级分类，按体积降序

| 排名 | 分类 | 大小 | App 占比 | 说明 |
| ---: | --- | ---: | ---: | --- |
| 1 | `Contents/Frameworks` | `271.84 MiB` | `58.97%` | Electron/Chromium 运行时、语言包、图形与媒体库、Helper |
| 2 | `Contents/Resources` | `188.96 MiB` | `40.99%` | `app.asar`、原生解包依赖、图标 |
| 3 | `_CodeSignature` | `0.09 MiB` | `0.02%` | 签名资源 |
| 4 | `MacOS` | `0.05 MiB` | `0.01%` | Zeus 启动入口 |
| 5 | `Info.plist` 与 `PkgInfo` | `<0.01 MiB` | `<0.01%` | 应用元数据 |

## 主要对象，按体积降序

| 排名 | 对象 | 大小 | App 占比 | 判断 |
| ---: | --- | ---: | ---: | --- |
| 1 | Electron Framework | `270.13 MiB` | `58.60%` | 大部分是 Electron 固定成本，但语言包可安全收敛 |
| 2 | `app.asar` | `179.29 MiB` | `38.90%` | 最大的 Zeus 自有优化区 |
| 3 | `app.asar.unpacked` | `9.03 MiB` | `1.96%` | 原生模块及被 smart-unpack 连带展开的文件 |
| 4 | 其他 Framework 与 Helper | `1.72 MiB` | `0.37%` | Electron 正常运行所需，收益很小 |
| 5 | 图标与默认资源 | `0.63 MiB` | `0.14%` | 不值得优先处理 |

## Electron Framework 内部主要来源

| 排名 | 分类 | 大小 | 说明 |
| ---: | --- | ---: | --- |
| 1 | Electron 主二进制 | `179.33 MiB` | arm64 Chromium/Electron 核心，不能用文件删除方式优化 |
| 2 | 全部本地化目录 | `47.70 MiB` | 当前包含约 220 个 `.lproj` 目录 |
| 3 | SwiftShader Vulkan | `15.76 MiB` | 软件图形后备，不建议直接删除 |
| 4 | ICU 数据 | `10.38 MiB` | 国际化与文本处理基础数据 |
| 5 | Chromium 资源包 | `6.55 MiB` | 浏览器运行资源 |
| 6 | OpenGL ES 库 | `5.91 MiB` | GPU/Canvas/WebGL 路径 |
| 7 | FFmpeg | `2.12 MiB` | 媒体能力 |
| 8 | Crashpad | `1.17 MiB` | 崩溃处理 |

Zeus 产品内容语言目前是简体中文和英文。若 Electron 侧保留 `en`、`en_GB`、`zh_CN`、`zh_TW` 四组语言，语言目录从 `47.70 MiB` 降到约 `2.18 MiB`，可减少约 `45.52 MiB`。

## `app.asar` 分类

`app.asar` 共 `23,554` 个文件条目，归档大小 `179.29 MiB`。

| 排名 | 分类 | 大小 | 归档占比 | 说明 |
| ---: | --- | ---: | ---: | --- |
| 1 | 已打包的 `node_modules` 内容 | `167.21 MiB` | `93.26%` | 远高于真正的应用构建产物 |
| 2 | ASAR 目录头与元数据 | `5.92 MiB` | `3.30%` | 文件条目过多带来的额外成本 |
| 3 | `dist` | `5.63 MiB` | `3.14%` | Main、Preload、Renderer 与原生辅助程序索引 |
| 4 | `assets` | `0.52 MiB` | `0.29%` | 主要是 App 图标 |
| 5 | `package.json` | `<0.01 MiB` | `<0.01%` | 运行入口元数据 |

真正构建后的 Renderer 约 `4.38 MiB`，而原始 `node_modules` 占归档的九成以上。当前存在“Renderer 已经打包一份，生产依赖目录又原样带一份”的重复。

## `app.asar` 中最大的依赖，按体积降序

| 排名 | 依赖 | 大小 |
| ---: | --- | ---: |
| 1 | `sql.js` | `18.20 MiB` |
| 2 | `@phosphor-icons/react` | `15.91 MiB` |
| 3 | `@google/genai` | `11.83 MiB` |
| 4 | `@earendil-works/pi-coding-agent` | `10.65 MiB` |
| 5 | `web-streams-polyfill` | `8.54 MiB` |
| 6 | `@opentelemetry/semantic-conventions` | `7.91 MiB` |
| 7 | `@mistralai/mistralai` | `7.84 MiB` |
| 8 | `react-dom` | `6.98 MiB` |
| 9 | `openai` | `5.58 MiB` |
| 10 | `@xterm/xterm` | `5.56 MiB` |
| 11 | `@zeus/local-server` | `5.09 MiB` |
| 12 | `framer-motion` | `4.42 MiB` |
| 13 | `zod` | `4.03 MiB` |
| 14 | `@earendil-works/pi-ai` | `3.28 MiB` |
| 15 | `@anthropic-ai/sdk` | `3.12 MiB` |

## 可直接识别的冗余类型

下列数字存在交集，不能简单相加：

| 类型 | 大小 | 文件数 | 事实 |
| --- | ---: | ---: | --- |
| source map | `53.11 MiB` | 6,236 | 主要来自依赖包，随正式包分发 |
| TypeScript 源文件 | `12.61 MiB` | 2,283 | 运行入口实际指向编译后的 JS |
| 类型声明 | `3.27 MiB` | 1,182 | 生产运行不读取 |
| 文档、示例与 Markdown | `3.93 MiB` | 220 | 含 Pi 文档图片等内容 |
| 调试、开发、性能分析变体 | `18.59 MiB` | 94 | 与 source map、`sql.js` 调试文件有交集 |
| 非 macOS/非 arm64 的 `node-pty` 内容 | 约 `1.82 MiB` | 97 | 包括 Windows 二进制、WinPTY 源码和资料 |

`sql.js` 的默认生产入口是 `dist/sql-wasm.js`，并需要同目录的 `sql-wasm.wasm`；两者合计约 `0.67 MiB`。当前整个包为 `18.20 MiB`，其余主要是 asm、worker、browser、debug 与 memory-growth 变体。

## 功能内容维度深审

### 必须先修正的 Pi 产品语义

Pi 在公开 Agent 目录中被标记为 `framework_only`、`visibleToUsers: false`，但这不等于 Pi 没有用户功能。代码中的真实链路是：

1. 模型连接支持自定义、DeepSeek、阿里云百炼、Kimi 和 Z.AI / GLM；除已单独验收的 DeepSeek 官方 Responses 模型外，默认路由到 `pi_sdk`。
2. 这些连接模型会与 Codex 模型合并，出现在新会话和任务推送的可选模型中。
3. 服务启动时会创建 Pi 会话协调器，并修复历史 Pi 会话身份与消息投影。
4. Pi 运行时只注册 `openai-completions`、`openai-responses` 和 `anthropic-messages` 三种协议，并把工具执行收口到 Zeus 审批代理。

因此，“整个移除 Pi”不是无损包优化，而是删除外部模型连接这项真实产品能力，还会影响已有配置和历史会话续接。本文后续将“保留 Pi 功能、缩小 Pi 实现”与“删除 Pi 功能”严格分开。

### 用户功能与体积责任

| 功能域 | 当前体积证据 | 产品判断 | 优缺点 |
| --- | ---: | --- | --- |
| Electron 窗口、Renderer、BrowserHost 和内置浏览器共享底座 | Electron Framework `270.13 MiB`；收敛语言后约 `224.61 MiB` | 必须保留，且不能把全部 Framework 都归因给内置浏览器 | 优点是多窗口、网页、Canvas 和图形链路共用；缺点是 Electron 固定成本极高，单独删浏览器功能也不会消失 |
| 任务、会话、编辑器、终端界面、图谱、Markdown、设置 | Renderer 全部编译成品约 `4.38 MiB` | 全部保留；这些不是大包的根因 | 优点是用户价值高；缺点是原始前端依赖又被重复收进生产 `node_modules`，应修正打包而不是删功能 |
| Zeus 后端核心：本地 API、存储、Git、终端、任务与会话编排 | 排除 Pi 后的生产依赖闭包当前约 `34.70 MiB`；清理非运行文件并精准保留 `sql.js` 后约 `10.17 MiB` | 全部保留；主要问题仍是包内容卫生 | 优点是无需改产品定位；缺点是 `sql.js`、`node-pty` 等需要精确白名单和真实运行验证 |
| 外部模型连接与 Pi 会话内核 | Pi 独占依赖闭包当前约 `92.26 MiB`；常规清理后仍约 `42.03 MiB` | 功能要保留，实现依赖面要重构 | 优点是保留多模型产品价值；缺点是当前引入了远超 Zeus 实际使用范围的 CLI、TUI、供应商 SDK 和原生工具 |
| Codex、Claude、Gemini 等外部 CLI | 运行二进制不随 Zeus 分发；Zeus 只携带适配器代码 | 不是包体积优化点 | 优点是无巨大二进制成本；缺点是依赖用户本机安装与登录，但删除适配器只能省极少代码 |
| 更新进度辅助程序 | 约 `0.15 MiB` | 保留 | 优点是体积很小、发布价值高；缺点是多一个签名和健康检查对象，但不值得删除 |

### 前端功能不应为体积背锅

Renderer 的编译产物按功能 chunk 汇总如下：

| 功能组 | 大小 |
| --- | ---: |
| 任务工作区（JS + CSS） | `0.846 MiB` |
| 代码编辑器 | `0.697 MiB` |
| 会话工作区（JS + CSS） | `0.683 MiB` |
| 通用 vendor | `0.670 MiB` |
| Renderer 核心 | `0.665 MiB` |
| 图标 | `0.272 MiB` |
| React 运行时 | `0.181 MiB` |
| Markdown | `0.147 MiB` |
| 动效 | `0.128 MiB` |
| 设置工作区 | `0.091 MiB` |

这意味着：

- 删掉代码编辑器，真正可省的编译成品不到 `0.7 MiB`；原始 CodeMirror 依赖本来就应在第一阶段从生产 `node_modules` 移除，不应用删功能的方式解决重复打包。
- 删掉看板拖拽、图谱、Markdown、动效和图标，损失的产品完整度远大于节省的体积。
- 删掉内置浏览器也不会让 Chromium 从 Electron 中消失；除非连整个技术栈一起迁移，否则体积收益很小。

### Pi 当前携带了哪些产品用不到的内容

Pi 闭包当前约 `93.84 MiB`，其中约 `92.26 MiB` 为排除 Zeus 其他运行时共用依赖后的独占内容。常规包卫生先会移除 Pi 闭包中约 `39.24 MiB` source map、`7.82 MiB` TypeScript 源文件和约 `5.06 MiB` 文档/示例/容器化资料；这些数字存在边界交叉，不应直接相加。保守清理后，Pi 独占闭包仍约 `42.03 MiB`，这才是功能实现层需要继续深挖的部分。

其中有两组最明确的过重内容：

1. **Zeus 未注册的供应商协议 SDK**：`@google/genai`、`@mistralai/mistralai` 和 `@aws-sdk/client-bedrock-runtime` 及其当前依赖闭包合计约 `48.13 MiB`，清理 source map/源码/文档后仍约 `20.49 MiB`。Zeus 当前只注册 OpenAI Completions、OpenAI Responses 和 Anthropic Messages 三种协议，并不直接开放 Google、Mistral 或 Bedrock 协议。
2. **Pi 完整 CLI/TUI 与工具附带能力**：Pi Coding Agent 自身包含约 `3.77 MiB` `dist/core`、`3.05 MiB` `dist/modes` 和 `2.60 MiB` 文档。Pi TUI、图片处理、语法高亮、原生剪贴板及其依赖闭包当前约 `10.03 MiB`，常规清理后仍约 `8.56 MiB`，其中约 `4.65 MiB` 仍是解包的原生/资源文件。

Zeus 实际创建 Pi 会话时已明确关闭扩展、Skills、Prompt 模板、主题和 Pi 内置工具，只保留 Zeus 自己的工具代理。但当前从 `@earendil-works/pi-coding-agent` 根入口导入，根入口又静态重导出 CLI、交互模式、主题、剪贴板和图片工具。同时核心会话路径仍引用主题和内置工具格式化代码。所以这些内容不能靠打包黑名单直接删除，需要先拆出真正的无界面入口和协议级依赖。

### 功能层优化方案

#### 方案 A：保留全部用户功能，拆出 Pi 无界面运行内核（推荐）

目标是让 Zeus 仅引入会话、消息流、压缩、重试、使用量、会话持久化和 Zeus 工具代理所需的 Pi 代码。上游包或内部适配层需要提供明确的 headless 入口，不得从根入口连带加载 CLI、交互终端、主题、HTML 导出、剪贴板、扩展管理和内置工具界面。

- 优点：用户功能不变；可同时减少 ASAR 和 `app.asar.unpacked`；还会减少启动模块解析和原生模块风险。
- 缺点：需要上游配合或维护一层很窄的适配；Pi 升级时必须重新审查入口与依赖图；图片附件、手工压缩、重试和会话续接必须逐项真实回归。

#### 方案 B：把 Pi AI 收窄为协议级依赖（与方案 A 绑定实施）

仅保留 OpenAI 和 Anthropic 两组当前真实调用的传输实现；Google、Mistral、Bedrock 等协议的 SDK 改为可选依赖或独立协议包，不进入 Zeus Desktop 生产闭包。

- 优点：常规清理之后仍有约 `20.49 MiB` 的明确潜在收益，对现有五类模型连接的产品协议无需做减法。
- 缺点：不能只删 `node_modules` 目录；需要确保内置 provider 目录不会在初始化时强制解析这些 SDK。如果未来正式开放 Google、Mistral 或 Bedrock 直连，需要有意识地把相应协议包加回。

#### 方案 C：外部模型内核按需安装（备选，不作为首选）

基础 App 不携带 Pi，用户首次启用外部模型时再明示下载与校验。

- 优点：对只用 Codex 的用户，第一次下载和基础安装可再减少约 `42 MiB`（以第一阶段清理后口径计）。
- 缺点：完整安装后的总体积不会因此自动降低；会新增下载、签名/校验、断网、升级兼容、回滚和旧会话恢复问题，还会让“配好 API Key 即可用”变成两步。

### 功能删减决策表

| 候选动作 | 常规清理后的额外收益 | 用户损失 | 结论 |
| --- | ---: | --- | --- |
| 保留外部模型，改为 Pi headless + 协议级依赖 | 约 `20–29 MiB` 工程潜力 | 理论上无，但需以真实回归证明 | **推荐** |
| 完全删除外部模型/Pi | 约 `42.03 MiB` | 丢失自定义、百炼、Kimi、Z.AI 等模型会话，历史 Pi 会话无法原生续接 | 只能作为产品版本取舍，**不建议当包优化** |
| 删除内置浏览器 | 极小，Electron/Chromium 仍在 | 失去网页内嵌、会话资源浏览和 BrowserHost 链路 | **不建议** |
| 删除代码编辑器、图谱、Markdown、看板或动效 | 单项约 `0.1–0.7 MiB` 级别 | 直接伤害阅读、协作和任务管理体验 | **不建议** |
| 删除终端 | 主要是少量当前架构 `node-pty` 文件 | 丢失任务 Shell 和实时执行观察 | **不建议** |
| 删除 Claude/Gemini/通用 CLI 适配器 | 极小，因为外部二进制本来就不在 App 内 | 丢失已有兼容路径 | **不值得** |

### 深审后的体积目标

| 阶段 | App 未压缩占用 | 功能边界 |
| --- | ---: | --- |
| 当前 `0.3.23` | `460.95 MiB` | 当前全量功能 |
| 包内容卫生与语言收敛 | 约 `290 MiB` | 不删任何用户功能 |
| Pi headless + 协议级依赖 | 约 `260–275 MiB` | 保留外部模型；移除未暴露的通用 Pi CLI/TUI/多协议负担 |
| 基础 App 不包含外部模型内核 | 约 `245–255 MiB` | 只能通过按需组件或删除外部模型实现，不是默认推荐 |

这个目标也说明了一个底线：Electron 收敛语言后仍约 `224.61 MiB`，在不更换技术栈的前提下，Zeus 无法仅靠删几个页面变成几十 MiB 的应用。

## 删除建议清单与累计效果

下列 App 减少量都是按顺序去重后的增量，不能再彼此叠加重复项。DMG 使用现包候选内容的 gzip 高压缩结果作为可压缩性代理，再扩成区间；它不是 electron-builder/DMG 真实压缩结果，最终数字仍必须重新打包称重。

### 绿色清单：不删用户功能，可作为第一批

| 顺序 | 删除/收敛内容 | 实施边界 | App 增量减少 | DMG 预估减少 |
| ---: | --- | --- | ---: | ---: |
| 1 | Electron 多余语言目录 | 使用 `electronLanguages`，仅保留 `en`、`en_GB`、`zh_CN`、`zh_TW`，不做签名后手工删除 | 约 `45.52 MiB` | 约 `10–12 MiB` |
| 2 | Renderer 在生产 `node_modules` 中的重复依赖 | 从打包运行依赖中移除 CodeMirror、DnD Kit、Phosphor Icons、Xterm、XYFlow、React、Framer Motion、Graphology、Sigma、Markdown 等及其仅 Renderer 使用的传递依赖；保留 Vite 编译产物 | 约 `48.63 MiB` | 约 `8–11 MiB` |
| 3 | 生产不读取的 source map、TypeScript/类型文件、文档、示例、测试资料 | 在第 2 项后计算；使用精确打包白名单，保留 License、`package.json`、wasm、JSON 模型目录和运行时动态读取资源；Zeus source map 改为发布流水线独立产物 | 约 `56.33 MiB` | 约 `9–12 MiB` |
| 4 | `sql.js` 未使用构建变体 | 仅保留 `package.json`、License、`dist/sql-wasm.js`、`dist/sql-wasm.wasm`；删除 asm、worker、browser、debug 和 memory-growth 变体 | 约 `17.52 MiB` | 约 `3–5 MiB` |
| 5 | 非目标平台原生文件与 ASAR 目录头 | arm64 包删除 `node-pty` Windows 预编译件、WinPTY 资料和 darwin-x64 后备；保留实际加载的 darwin-arm64/`build/Release` 路径；ASAR 目录头随文件数自然缩小 | 约 `3–6 MiB` | 约 `1–3 MiB` |

第一批合计：

- 前四项去重后约为 `168 MiB`；第五项受原生加载路径和 ASAR 目录头实际收缩影响。合计按 `168–174 MiB` 估算，App 从 `460.95 MiB` 降到约 `287–293 MiB`，对外目标可取整为约 `290 MiB`。
- DMG 预计减少约 `33–39 MiB`，从 `152.05 MiB` 降到约 `113–119 MiB`。
- 优点：不删用户功能，收益最稳定，也能阻止后续新增 UI 依赖继续放大包。
- 缺点：打包白名单会成为新的升级维护责任；数据库、终端、图标、编辑器、图谱和内置浏览器都必须用打包后真实 App 验证。

### 黄色清单：先改造依赖边界，再删除

| 顺序 | 删除/收敛内容 | 前置改造 | App 额外减少 | DMG 预估额外减少 |
| ---: | --- | --- | ---: | ---: |
| 6 | Google、Mistral、Bedrock 协议 SDK 及其独占传递依赖 | Pi AI 拆成协议级入口；Zeus 生产闭包仅保留 OpenAI Completions、OpenAI Responses 和 Anthropic Messages | 约 `20.49 MiB` | 约 `2.5–4 MiB` |
| 7 | Pi CLI/TUI、交互模式、主题、原生剪贴板、非必需图片处理和语法高亮依赖 | 提供 Pi headless 入口，核心会话不得静态引用 CLI/TUI/主题/内置工具格式化代码；图片附件仍需保留真正需要的转换链路 | 最多约 `8.56 MiB` | 约 `2.5–4 MiB` |

第二批合计：

- 在第一批之后，App 还可减少约 `20–29 MiB`，达到约 `260–275 MiB`。
- DMG 还可减少约 `5–8 MiB`，预计达到约 `106–114 MiB`。实测 gzip 代理值为 `6.25 MiB`。
- 优点：保留外部模型的真实用户能力，几乎达到删除整个 Pi 在 DMG 上的主要收益。
- 缺点：它不是简单打包排除，需要 Pi 入口和依赖声明的实质改造。

### 红色清单：会删产品功能，不建议进入默认方案

| 删除项 | 第一批后的额外收益 | 最终体积预估 | 产品代价 |
| --- | ---: | ---: | --- |
| 完全删除 Pi/外部模型内核 | App 约 `42.03 MiB`；DMG 约 `7–11 MiB`（gzip 代理 `9.12 MiB`） | App 约 `245–255 MiB`；DMG 约 `102–111 MiB` | 删除自定义、百炼、Kimi、Z.AI 等模型会话，已有 Pi 会话无法原生续接 |
| 删除内置浏览器 | App/DMG 都很小 | 无法绕过 Electron `224.61 MiB` 左右的收敛后底座 | Chromium 仍在，但网页内嵌、BrowserHost 和资源浏览功能消失 |
| 删除编辑器、看板、图谱、Markdown、动效 | 单项只有约 `0.1–0.7 MiB` 编译成品 | 总体积几乎不改变 | 直接降低任务管理、代码阅读和会话表达能力 |

从 DMG 角度看，Pi headless 已经能删掉约 `6.25 MiB` 的可压缩内容，整个移除 Pi 约为 `9.12 MiB`。为了额外约 `3 MiB` DMG 体积就删掉外部模型能力，收益与产品代价明显不对等。

## 推荐优化顺序

### 一、限制 Electron 语言包

在 electron-builder 配置中使用 `electronLanguages`，只保留 Zeus 真正支持的 Electron 语言。

- 预计收益：约 `45.52 MiB` App 占用。
- 优点：不改业务代码，收益稳定，风险最低。
- 缺点：其他系统语言下 Electron 自带菜单会回退到保留语言，实施前需要确认产品是否接受。

### 二、把 Renderer 专用依赖改为构建依赖

CodeMirror、DnD Kit、Phosphor Icons、Xterm、XYFlow、React、Framer Motion、Sigma 等只在 Renderer 源码中使用，并已由 Vite 打入 `dist/renderer`。它们不应再作为 Electron 生产运行依赖被完整复制。

按当前依赖闭包计算，Renderer 专用包及其仅 Renderer 使用的传递依赖约 `48.63 MiB`。

- 优点：修正依赖语义，后续新增界面库也不再自动放大生产包。
- 缺点：必须检查是否存在按模块名进行的运行时动态加载；完成后需要通过包内入口检查和真实 App 页面回归。

### 三、生产包采用窄文件范围

生产包排除依赖 source map、TypeScript 源文件、类型声明、构建缓存、文档和示例。Zeus 自有 source map 若需要用于现场诊断，可作为发布流水线独立产物保存，不必放入用户 App。

在先移除 Renderer 重复依赖后，这一项仍可继续减少约 `56.33 MiB` 的 ASAR payload。

- 优点：收益大，同时显著减少 ASAR 文件数和约 `5.92 MiB` 目录头。
- 缺点：直接在用户机器上查看源码映射的能力下降；过宽的排除规则可能误删运行时读取的资源，因此应优先使用包级白名单和精确路径，而不是粗暴删除所有非 JS 文件。

### 四、精确裁剪 `sql.js`

保留 `package.json`、License、`dist/sql-wasm.js` 和 `dist/sql-wasm.wasm`，排除当前运行路径不会读取的其他构建变体。

在前述两项之后仍可继续减少约 `17.52 MiB`。

- 优点：运行入口和必需 wasm 已由包元数据与 Zeus 实际调用共同确认，单项收益高。
- 缺点：规则与 `sql.js` 包目录结构绑定，升级依赖时必须由打包门禁重新验证入口和 wasm。

### 五、最后处理原生模块平台文件

`node-pty` 当前还携带 Windows arm64/x64 预编译文件、WinPTY 内容和 macOS x64 后备文件。arm64 DMG 可以按平台精确收敛。

- 预计收益：约 `1.5–2 MiB`，另有少量 source map 会在第三项一并移除。
- 优点：进一步清理 `app.asar.unpacked`。
- 缺点：收益小，原生加载失败会直接破坏终端能力；应放在主要优化完成之后。

## 不建议优先做的方向

### 直接删除 SwiftShader、GLES、FFmpeg 或 Crashpad

这些对象合计看起来可观，但 Zeus 有内置浏览器、Canvas/图谱、图片与页面渲染路径。直接裁掉图形后备和 Chromium 基础库，可能在无 GPU、远程桌面、驱动异常或特定网页下出现黑屏和崩溃。

- 优点：理论上还能减少二十多 MiB。
- 缺点：回归面大、问题机器难复现，不符合当前收益风险比。

### 为体积更换 Electron 技术栈

- 优点：长期可能显著降低运行时固定成本。
- 缺点：需要重写窗口、Preload、BrowserHost、内置浏览器、更新、签名和原生模块链路，属于产品架构迁移，不应作为本次包体积治理手段。

### 只把压缩级别改成 maximum

electron-builder 官方说明 `maximum` 通常不会带来明显体积差异，却会增加打包时间。当前应先移除不该进入包的内容，而不是压缩冗余。

## 第一阶段体积目标

以下为未压缩 App 的保守目标，不是 DMG 承诺：

| 项目 | 当前 | 第一阶段目标 |
| --- | ---: | ---: |
| App 总占用 | `460.95 MiB` | 约 `290 MiB` |
| Electron 本地化目录 | `47.70 MiB` | 约 `2.18 MiB` |
| `app.asar` | `179.29 MiB` | 约 `53–56 MiB` |
| DMG | `152.05 MiB` | 重新打包后实测，不做线性估算 |

`app.asar` 的三组主要收敛项去重后，payload 可减少约 `122.47 MiB`，并同时缩小 ASAR 目录头。加上语言包约 `45.52 MiB`，App 总体减少约 `168–172 MiB` 是合理目标。

## 实施后的验证边界

若进入实现阶段，必须分别报告：

- `pnpm lint`、`pnpm typecheck`、`pnpm build`；
- `pnpm package:mac` 生成独立身份 `Zeus Test.app`；
- 包内 Main、Preload、Renderer、wasm、原生辅助程序和签名检查；
- `app.asar`、`app.asar.unpacked`、Frameworks、App 和 DMG 的前后同口径体积；
- 使用独立 `ZEUS_USER_DATA_DIR` 的真实运行检查，重点覆盖数据库初始化、终端、剪贴板、Pi 运行内核、代码编辑器、图谱和内置浏览器；
- Pi 无界面化需额外覆盖 OpenAI Completions、OpenAI Responses、Anthropic Messages 三种协议，以及新会话、历史会话续接、图片附件、流式输出、工具审批、中断/插话、手工压缩、失败重试、用量记录、归档和恢复；
- 打包门禁应证明 Google、Mistral、Bedrock SDK、Pi 交互模式、主题、剪贴板原生包和非必需图片处理内容已从生产依赖闭包消失，不能只看 `package.json` 声明；
- 建立按功能组的包体积预算，至少单独跟踪 Electron 语言、Renderer 成品、Zeus 后端核心、Pi 独占闭包、`app.asar.unpacked` 和 ASAR 文件数；
- 不启动、不覆盖 `/Applications/Zeus.app`，正式发布候选与 GUI 验收继续分开。

## 一次性实施结果（2026-08-18）

本轮按绿色清单和黄色清单一次性完成，没有删除用户可见功能，也没有拆成多批交付。实现后的 arm64 `Zeus Test.app` 已重新打包称重。

### 已实施内容

1. Electron 仅保留 `en`、`en_GB`、`zh_CN`、`zh_TW` 四组本地化资源。
2. CodeMirror、DnD Kit、Phosphor Icons、Xterm、XYFlow、React、Framer Motion、Graphology、Sigma 和 Markdown 等 Renderer 依赖改为构建依赖；Vite 成品继续进入包，原始依赖不再重复分发。
3. 生产包排除 source map、TypeScript/类型文件、顶层文档、示例、测试和变更说明。首次反向导入检查发现宽泛 `docs` 规则会误伤 `yaml/dist/doc` 运行代码，因此最终规则只删除依赖包顶层文档，没有保留该隐患。
4. `sql.js` 仅保留 `sql-wasm.js` 和 `sql-wasm.wasm` 两个实际运行文件。
5. `node-pty` 根据 `${arch}` 只保留当前 macOS 架构预编译件；arm64 包中已只剩 `darwin-arm64`，Windows、源码、测试和 x64 预编译件均未进入包。
6. Pi 增加无界面入口，Zeus 改用最小资源加载器。项目级 `AGENTS.md`/`CLAUDE.md` 继承、会话、模型、压缩、重试和 Zeus 工具代理仍保留；扩展、技能、主题、Pi CLI/TUI、HTML 导出和内置工具实现不再进入生产运行链路。
7. 通过 pnpm 精确覆盖移除 Zeus 不支持的 Google、Mistral、Bedrock 协议 SDK，以及 Pi TUI、原生剪贴板、终端图片处理和语法高亮依赖。Anthropic、OpenAI Completions 和 OpenAI Responses 仍保留。

### 实测缩减结果

| 对象 | 优化前 | 优化后 | 实际减少 | 降幅 |
| --- | ---: | ---: | ---: | ---: |
| App 目录占用（`du -sk`） | `460.95 MiB` | `252.18 MiB` | `208.77 MiB` | `45.29%` |
| DMG 逻辑大小 | `152.05 MiB` | `106.53 MiB` | `45.52 MiB` | `29.94%` |
| `app.asar` | `179.29 MiB` | `23.22 MiB` | `156.07 MiB` | `87.05%` |

优化后的 App 表观文件大小为 `250.61 MiB`；表格继续使用与基线一致的目录占用口径。最终结果比原先 `260–275 MiB` 的 headless 目标还低约 `8–23 MiB`，DMG 位于预估 `106–114 MiB` 区间的下沿。

### 最终包内容门禁

- Renderer 原始生产依赖命中数：`0`。
- Google、Mistral、Bedrock SDK 和 Pi TUI/剪贴板/Photon/highlight.js 命中数：`0`。
- source map、TypeScript、类型声明命中数：`0`。
- Pi 文档、交互模式、RPC 入口和 HTML 导出内容命中数：`0`。
- `sql.js` 仅有 `sql-wasm.js` 与 `sql-wasm.wasm`。
- `node-pty` 仅有 `darwin-arm64/pty.node` 与 `darwin-arm64/spawn-helper`。
- Electron 本地化目录准确为四组。

### 验证记录

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过；Renderer 仍完整生成 1179 个模块对应的成品资源，仅有既有的大 chunk 提示。
- `pnpm package:mac`：通过，生成独立身份 `Zeus Test.app` 和 DMG。
- Bundle ID：`dev.hypha.zeus.test`。
- `codesign --verify --deep --strict`：通过；测试包是 ad-hoc 签名且不做公证，不能冒充正式发布签名。
- 从最终 `app.asar` 解包后直接导入 Pi headless，并创建无模型、无内置工具的真实 Pi 会话：通过；会话为空闲态，且仍读取当前项目 `AGENTS.md`。
- 完整 GUI 启动未作为通过项：机器上已有 ZEUS-0338 的隔离 `Zeus Test.app` 正在运行，同 Bundle ID 的单实例锁会让本任务实例退出。本轮没有关闭、复用或扰动该实例，也没有启动或改写 `/Applications/Zeus.app`。
- 按项目规则未新增或执行单元测试。

### 优缺点与剩余边界

- 优点：App 减少约 `45%`、DMG 减少约 `30%`，外部模型和全部 Renderer 用户功能仍保留；未来新增前端库不会自动把原始依赖复制进生产包。
- 缺点：打包过滤、架构宏和两个上游补丁成为升级维护点；升级 Electron、`sql.js`、`node-pty` 或 Pi 时必须重新执行 ASAR 反向导入和包内容门禁。
- 剩余风险：没有三种真实付费模型协议的在线请求证据，也没有本任务包的完整 GUI 页面回归。发布前仍需在没有其他 `Zeus Test.app` 占用单实例锁的环境中，使用独立数据目录覆盖数据库、终端、编辑器、图谱、内置浏览器、Pi 新建/续接、图片、工具审批、中断、压缩、重试和用量链路。

## 参考

- electron-builder `electronLanguages`、`files`、`asarUnpack` 与压缩配置：<https://www.electron.build/docs/configuration/>
- electron-builder 应用内容与精确排除示例：<https://www.electron.build/docs/contents/>
- 当前 Release：<https://github.com/imchenway/zeus/releases/tag/v0.3.23>
