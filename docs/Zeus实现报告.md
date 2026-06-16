# Zeus 实现报告

## 完成摘要

Zeus 已实现为本地优先的 macOS AI 研发工作台。当前仓库包含 Electron + React + TypeScript 桌面端、本地 Fastify API、SQLite 持久化、真实代码扫描、代码图谱、图谱问答、任务管理、AI Runtime、Git Diff、Telegram long polling、安全与 Keychain、审计日志、发布脚本、DMG/ZIP 打包、Homebrew cask、README 与工程文档。

本报告基于 2026-06-15 在 `/Users/david/hypha/zeus` 的真实执行结果生成。未配置外部证书或 token 的能力均以“等待用户配置”呈现，不伪造成功状态。

## 运行命令

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm install` | 已由现有工作区依赖与 lockfile 支撑 | `pnpm verify:release` 可完整执行依赖命令 |
| `pnpm lint` | 通过 | `pnpm verify:release` 内执行成功 |
| `pnpm typecheck` | 通过 | `tsc -b` 成功 |
| `pnpm test` | 通过 | 63 test files / 548 tests passed |
| `pnpm test:real-scan` | 通过 | 扫描 `/Users/david/hypha/zeus` 真实代码库 |
| `pnpm build` | 通过 | workspace build 与 desktop build 成功 |
| `pnpm package:mac` | 通过 | 生成 Zeus.app、DMG、ZIP |
| `node scripts/verify-ai-cli-adapters.mjs` | 通过 | AI CLI adapter 非侵入式探针输出 `ai-cli-adapters=checked;codex=available@0.139.0;claude=available@2.1.152;gemini=available@0.32.1;authStatus=real-probe-or-unknown`；只检测真实命令/版本/登录输出，不启动任务、不伪造已登录 |
| `ELECTRON_RUN_AS_NODE=1 dist/mac-arm64/Zeus.app/Contents/MacOS/Zeus -e ...` | 通过 | 非 GUI 模式加载包内 Electron 可执行文件，输出 electron 36.9.5 / node 22.19.0 / arm64；该校验已纳入 `pnpm verify:release` |
| `ELECTRON_RUN_AS_NODE=1 dist/mac-arm64/Zeus.app/Contents/MacOS/Zeus scripts/verify-packaged-app-health.mjs dist/mac-arm64/Zeus.app` | 通过 | 非 GUI 模式校验 app.asar 内 renderer 首页资源与 main 入口，输出 `packaged-health=Zeus;rendererAssets=2;main=dist/main/main.js`；不打开窗口、不抢焦点 |
| `pnpm verify:release` | 通过 | 完整门禁执行成功，最后提示 unsigned DMG/ZIP |

## 真实代码扫描结果

- 扫描路径：/Users/david/hypha/zeus
- 项目名：Zeus
- 文件数：163
- symbol 数：16327
- node 数：16327
- edge 数：32021
- view 数：7

已生成并验证的图谱视图：

- 系统架构图
- 表关系图
- 模块图
- 模块详情图
- 接口时序图
- 模块流程图
- 方法逻辑图

## App 产物

- Zeus.app：`dist/mac-arm64/Zeus.app`
- DMG：`dist/Zeus-0.1.0-arm64.dmg`
- ZIP：`dist/Zeus-0.1.0-arm64.zip`
- 非 GUI 可执行文件加载：Electron 36.9.5 / Node 22.19.0 / arm64
- 更新日志已补齐：`CHANGELOG.md` 记录 0.1.0 的发布证据、真实扫描、unsigned 状态和外部配置等待项。
- Homebrew cask 模板：`Casks/zeus.rb`
- Release Homebrew cask：`dist/homebrew/zeus.rb`
- Homebrew cask sha256：`0610d3b917feb0db9e285efd51d4b3dfc602669776152f0252b4993ff9465c4d`

当前 Apple signing certificate 未配置，因此产物是 unsigned DMG/ZIP，未 notarized。发布脚本和 GitHub Release workflow 已预留签名、notarization 与 Homebrew tap token 输入；仅在用户提供已有 tag 时创建 draft GitHub Release。

## 功能完成项

### 桌面应用与本地服务

- Electron + React + TypeScript 桌面应用已构建。
- 根 `pnpm dev` 已对齐到 macOS Run 脚本：经 `@zeus/desktop dev` 调用 `script/build_and_run.sh`，保持开发启动、Codex Run 按钮和打包验证入口一致。
- macOS 菜单栏与 Menu Bar 常驻入口已接入 Main 进程：应用菜单提供 Settings、Show Zeus、New Window、DevTools 与 Quit，Settings 使用标准 `CommandOrControl+,` 快捷键并跳转到设置区；Menu Bar Tray 提供 Show Zeus、New Window 和 Quit；New Window 会跟随多窗口开关禁用，避免绕过用户设置。
- 本地 API 默认绑定 `127.0.0.1`。
- 本地服务异常关闭后会自动重启，并通知 Electron Main 重建依赖旧 WebSocket 的系统通知桥；Renderer token 保持稳定，主动退出不会触发重启。
- App 退出前会同步拦截 `before-quit`，先关闭系统通知桥与本地服务，再显式退出，避免 async 清理未完成导致残留进程或旧事件连接。
- Dashboard 顶部补齐启动页：启动后先展示本地服务、真实项目、代码图谱与外部工具配置状态；缺少真实来源时只显示等待项，不展示假项目、假任务或假终端输出。
- Dashboard 展示真实项目、任务、Git、Runtime、Telegram 与图谱状态。
- Dashboard 新增执行统计、代码地图统计和风险统计，全部从真实 snapshot、graph view、runtime session 派生；无图谱时显示 0，不填充假数据。
- Dashboard 新增最近动态区，统一展示最近任务、最近 Runtime 会话和最近 Git 变更；全部来自当前真实内存状态和快照，不创建示例数据。
- 设置页缓存清理会真实清理可重建的代码索引、图谱视图与布局缓存，并更新最后清理时间；不删除项目、任务、Runtime 日志或 Git 快照。
- 通用设置支持应用语言偏好；默认简体中文，可预留 English，只保存界面语言偏好，不翻译或改写真实代码、任务、终端日志。
- 通用设置支持开发者模式偏好；只启用本机诊断入口，不自动打开 DevTools、不上传日志、不显示密钥。
- 通用设置支持默认模型偏好；用于新建项目时预填默认 AI 模型，不声明模型一定可用。
- 通用设置支持默认项目偏好；只能选择真实已连接项目，未知或已删除项目 ID 会规范化为未设置，不创建占位项目。
- 通用设置支持默认任务模板偏好；只能引用真实存在的任务模板，未知模板 ID 会规范化为未设置，不创建占位模板或任务。
- Settings 页面补齐设计书九分区入口：General、AI Runtime、Security、Storage、Code Map、Git、Telegram、Developer、About；分区只重组真实设置与状态，不新增假数据。
- Renderer 顶层接入错误边界；渲染异常时展示安全恢复说明，不把堆栈、token 或终端输出写入界面。
- 无真实数据时展示空状态，不写入 seed 假数据。

### 项目、任务与模板

- 支持创建、更新、删除、归档、恢复项目。
- 创建项目时会基于真实 manifest 自动识别 TypeScript/Java 语言、pnpm/npm/yarn/maven/gradle 包管理器和清单路径，写入项目默认配置。
- 创建项目前可设置默认 AI 模型、默认工作模式和默认任务提示词；这些偏好会随项目创建一起保存，并与真实文件检测结果合并，不声明外部 CLI 已可用。
- 创建项目时服务端会校验 `localPath` 必须是真实存在且可读的本地目录；不存在或不可读路径会返回 `ZEUS_INVALID_PROJECT_PATH`，不会创建假项目记录。
- 创建项目时会从真实本地目录向上检测 Git Root，并写入项目配置 `vcs`；保存可编辑偏好时会保留该检测事实，界面只读展示 Git Root，不伪造 Git 仓库。
- 支持创建、更新、删除、归档、恢复任务。
- 支持任务状态流转、任务事件时间线、任务模板、从模板创建任务。
- 任务事件除写入 SQLite 时间线外，同步落盘到本机 `*.db.logs/tasks/<taskId>/timeline.normalized.log` 与 `events.jsonl`，用于任务级排障和离线证据链。
- 支持从图谱节点、图谱视图、图谱问答、Runtime 会话创建任务，并支持把既有任务关联到真实图谱节点。

### 代码扫描与图谱

- Java 方法调用图会过滤日志、工具类和 getter/setter 噪声，保留 Mapper/Repository/Service 主链路；Java 扫描还会结构化识别 Feign remote client、Kafka MQ consumer、Scheduled job 入口，以及 Java import 的本地文件依赖和外部包依赖。

- 扫描真实 TypeScript/Electron/SQLite 项目结构。
- Java/Spring/MyBatis 解析器支持真实类、接口、Controller、Service、Repository、Mapper、Spring Mapping、Maven/Gradle、MyBatis XML、SQL 表字段事实，并补齐方法级 `@Transactional` / `@Async` 结构化元数据；当前 Zeus 仓库无 Java 文件时不会伪造 Java 图谱节点。
- 节点和边包含文件路径、源码行、SQL、DDL 或 Git 来源。
- 支持代码图谱搜索、过滤、边详情、节点邻居、图谱问答历史。
- 支持项目级 Code Map view 列表、view 读取、view 生成、搜索、节点详情和节点邻居 API 别名。
- 支持项目级 APIs、Modules、Tables、Method Logic 语义 Code Map API，全部从真实图谱视图派生。
- API sequence 视图会优先保留跨导入调用链证据，并按最终节点集合裁剪边，避免大项目视图出现悬空边。
- 项目配置中的数据库 Schema/DDL 路径会作为真实 DDL/SQL 文件并入项目扫描；即使 Code Map 使用 src 范围，也不会漏掉用户导入的 schema 文件。
- DDL 表事实包含 schema 名、版本缓存、字段详情、索引和真实外键；表关系图优先使用 DDL 声明的外键关系，命名推断关系保持较低置信度。
- 数据库连接密码可保存到本机安全存储；界面、API 和审计只返回配置状态，不回显明文密码。项目配置的 `database.connectionName` 若显式使用 `sqlite:<项目内相对路径>`，扫描会只读 introspect 该真实 SQLite 文件，生成本地 schema cache 并提取表、字段、索引和外键；若显式使用 Postgres/MySQL/MariaDB URI 且包含 password，服务端会在保存前返回 `ZEUS_DATABASE_CONNECTION_SECRET_IN_URI`，要求密码进入 Keychain 字段；无密码外部 URI 会作为真实连接意图在驱动未安装时明确失败，不伪造连接成功。
- 节点详情支持展示真实图谱 metadata 中的 `aiSummary`、recentTasks 与 riskTags；缺少 metadata 时保持空态，不生成或伪造摘要。
- 支持项目级 AI + Graph 任务闭环：从项目级图谱节点/视图创建任务，以及把任务关联到真实图谱节点。
- 支持方法逻辑图中的控制流、异常分支、Promise 分支、await 调用、SQL 与字段影响关系。
- 方法逻辑图视图上限调整为 8000 个真实节点，避免大型项目新增配置代码后把小型核心包的守卫分支证据挤出视图。

### AI Runtime

- 支持 Runtime adapter 注册、可用性检测、默认 adapter 设置。
- Runtime adapter 检测结果在 UI 中明确展示版本、登录状态、模型配置和能力列表；未读取或未知时保持未知状态，不把命令存在推断为已登录。
- AI CLI adapter 探针已纳入 `pnpm verify:release`，当前本机检测到 Codex/Claude/Gemini 命令和版本，但仍不把版本存在推断为已登录或模型可用。
- 项目配置中的默认 AI 模型、默认工作模式和默认任务提示词已进入任务 Runtime 与图谱问答 Runtime：项目默认模型优先于全局 Runtime 模型；工作模式和项目默认提示词进入真实 prompt，不伪造外部 CLI 可用状态。
- 支持 Runtime 执行设置中的 CLI 路径、默认参数、自动确认策略、执行超时、并发、Shell、终端环境变量和日志保留策略；CLI 路径只保存 Codex/Claude/Gemini 专用 adapter 的本机绝对路径，不声明该 CLI 已安装或已登录，并会用于 Zeus 生成的任务 Runtime 与图谱问答 Runtime 启动命令；默认参数只追加到 Zeus 生成的 AI CLI 任务命令，不用于 Generic shell 或手动 Runtime 会话；自动确认策略仅保存 `never` / `low_risk_only` 偏好，不绕过 Generic shell、Git 写入、删除文件等高风险确认；执行超时会注入真实 Runtime 环境变量，日志保留策略仅保存本机偏好，不自动删除历史日志。
- 支持 Runtime 会话启动、停止、输入、中断、resize、终端快照、摘要、收藏、归档、恢复、删除。
- 支持 Generic shell 一次性高风险确认的创建、确认、拒绝和消费；拒绝后不会启动 Runtime 子进程，并写入通用安全审计与实时事件。
- AI CLI 不可用时显示明确配置状态，不伪造 AI 回复或终端输出。

### Git Diff 与高风险操作

- 支持只读 Git status/diff。
- 支持项目级只读 Git status/diff/snapshot/patch export，其中 patch export 只生成补丁文本并记录审计，不执行 Git 写操作。
- 支持 Git confirmation 创建和确认记录。
- 支持确认后受控执行 commit、stash、apply_stash、branch、pull、push、rollback 等白名单 Git 写操作；测试通过注入 runner 验证参数，不在当前仓库执行 Git 写命令。
- 不提供任意 git 子命令入口。
- Git 快照和变更可进入本地持久化证据链。

### Telegram

- 支持 Bot Token Keychain 保存、清理和安全重置。
- 支持 long polling、白名单、状态、消息日志、命令分发、通知设置。
- 支持 `/projects`、`/tasks`、`/run`、`/status`、`/stop`、`/continue`、`/logs`、`/diff`、`/ask`、`/help` 等命令链路。
- `/diff` 远程命令对大 diff 只发送摘要、文件列表和长度，不发送完整正文；小 diff 预览也会先脱敏，避免 token/API key 泄露到 Telegram。
- `/logs <taskId> --full` 支持把完整 Runtime 日志导出到本机脱敏 `.log` 文件；Telegram 只返回会话数、日志行数和本机文件路径，不发送长日志正文。
- Token 未配置时显示未启用，不伪造 Telegram 消息。

### 安全与发布

- 本地服务不暴露公网。
- API 使用 Bearer token。
- Telegram Bot Token 存 macOS Keychain。
- 外部 API Key 可存 macOS Keychain；UI、API 和审计只显示配置状态，不声明任何外部 AI 服务已可用。
- 日志、API、UI 不回显明文 token。
- 支持安全审计时间线和 `security.reset.completed` 审计记录。
- Generic shell 对项目外 `cwd`、项目外写入路径、敏感目录访问、疑似密钥文件名访问进行 API 层拒绝；对用户拒绝确认写入 `security.confirmation.rejected` 审计和实时事件。
- 支持泄露风险重置：清理密钥、停止轮询、关闭通知。
- 支持 DMG、ZIP、Homebrew cask、release workflow、tag 输入创建 draft GitHub Release 与 unsigned 验证。
- Issue/PR 协作模板已补齐真实数据原则：Bug Report、Feature Request 和 Pull Request 均要求说明真实数据来源、外部配置等待项、脱敏要求、验证命令和回滚/回归口径。

## 外部配置等待项

- AI CLI 登录状态：发布门禁已验证 adapter 探针链路；真实登录与模型可用性仍等待用户在本机完成 Codex/Claude/Gemini 等 CLI 配置，未配置时 Zeus 只显示不可用原因。
- Telegram Bot Token：等待用户提供真实 token；未配置时 long polling 和通知保持未启用。
- Telegram 白名单用户 ID：等待用户按实际账号配置；非白名单 update 会被拒绝。
- Apple signing certificate：等待用户配置；当前仅验证 unsigned DMG/ZIP。
- Apple notarization 凭据：等待用户配置；当前未 notarized。
- Homebrew tap token：等待用户配置；当前已提供本地 `Casks/zeus.rb` 文件。

## 风险与后续建议

- Java/Spring/MyBatis/Maven/Gradle 解析已通过临时真实源码与构建文件测试，并新增 release gate fixture：`java-spring-fixture=verified;files=6;symbols=42`；当前仓库自扫描仍以 TypeScript/Electron/SQLite 为主要真实样本。
- 当前图谱解析以轻量源码规则为主，不等价于完整 TypeScript AST 或 SQL parser；复杂动态 import、复杂 SQL、跨行 Promise 链仍建议后续增强。
- 大型项目图谱需要继续增强分页、聚焦查询、缓存和 WebGL 大图交互。
- 完整签名、公证和自动 Homebrew tap 发布需要用户提供外部账号与凭据后再执行。
