# Zeus 架构

Zeus 采用 pnpm monorepo：`apps/desktop` 是 Electron/React 桌面应用，`packages/*` 拆分本地服务、存储、任务、扫描、图谱、Runtime、Git、Telegram、发布与安全能力。架构目标是本地优先：真实数据保留在用户 Mac 上，外部能力缺失时显示未配置或等待项，不伪造成功。

## 当前真实进程模型

- Electron Main、Preload、Renderer、Local Server、SQLite/sql.js、CLI 脚本共同组成当前运行链路。
- Electron Main 负责窗口、菜单、Menu Bar Tray、多窗口开关、DevTools 开关、退出清理、系统通知桥和本机文件导入/导出。
- Preload 只暴露受控桥接能力，例如设置导入导出、Runtime 日志导出、Patch 导出、Mermaid 导出和源文件打开。
- Renderer 负责 Dashboard、Projects、Tasks、Code Map、Sessions、Git Changes、Telegram、Settings 等界面状态；无真实来源时展示空态或等待项。
- Local Server 使用 Fastify app factory，仅监听 `127.0.0.1`，通过 Bearer token 保护本机 API，并提供 WebSocket 实时事件。
- SQLite/sql.js 是本地事实存储；代码索引、图谱视图和布局缓存属于可重建缓存，不替代真实源码、Git、Runtime 或 Telegram 记录。
- CLI 脚本包括 code-indexer、graph-engine、test-real-scan、package:mac、verify:release 等，只读取真实仓库或真实产物。

## 数据流与事实源

事实源必须来自真实本地目录、SQLite、Git diff、Runtime 会话、Telegram update、Keychain、DMG/ZIP 产物或用户明确创建的记录。

- 项目事实来自真实本地目录、manifest、Git root、项目配置和用户明确创建的记录。
- 任务事实来自 SQLite task records、task events、Runtime sessions、graph node/context 和 Git diff。
- 图谱事实来自真实源码、SQL、DDL、SQLite schema、Git diff、Runtime 会话、Telegram update、Keychain、DMG/ZIP 产物等可追溯来源；不得生成无来源节点。
- Runtime 事实来自真实 AI CLI / Generic shell 会话、stdout/stderr、normalized terminal logs、用户输入、中断和 resize 事件；AI CLI 未安装或未登录时只展示不可用原因。
- Telegram 事实来自真实 getUpdates、白名单、命令分发、消息日志和通知设置；Bot Token 未配置时保持未启用。
- 发布事实来自 DMG/ZIP、Homebrew cask、sha256、包内 Electron 可执行文件加载和 `pnpm verify:release` 输出。

## API 与事件边界

本地 API 覆盖 /health、项目/任务、Runtime、Git、Code Map、AI + Graph、Telegram、WebSocket。

- 本地 API 覆盖 `/health`、项目/任务、Runtime、Git、Code Map、AI + Graph、Telegram、WebSocket。
- API 只接受 token 保护的本机请求，不默认暴露公网。
- 项目 API 负责真实路径校验、项目 CRUD、归档/恢复、项目配置、数据库连接意图和 DDL/SQLite schema 导入。
- 任务 API 负责状态机、事件时间线、模板、筛选、归档、图谱节点/问答创建任务和任务完成回写图谱。
- Runtime API 负责 adapter 检测、会话启动/停止/输入/中断/resize、日志导出和高风险 Generic shell 确认。
- Git API 默认只读 status/diff/snapshot/patch export；写操作必须走白名单 confirmation。
- Code Map / AI + Graph API 负责真实扫描、视图生成、搜索、节点/边详情、问答、问答历史和任务创建。
- Telegram API 负责 token 状态、白名单、long polling、命令、通知设置和日志。
- WebSocket 只推送本地事件，例如 scan、graph view、task、runtime、telegram、security 和 notification 变化。

## 模块边界

核心模块包括 @zeus/code-indexer、@zeus/graph-engine、@zeus/local-server、@zeus/ai-runtime、@zeus/storage。

- `@zeus/storage`：SQLite/sql.js schema、项目、任务、事件、Runtime、会话、Git、图谱、Telegram、安全审计和导入/导出。
- `@zeus/local-server`：Fastify API、WebSocket、本地 token、跨模块编排、真实路径校验、安全错误与运行时状态。
- `@zeus/code-indexer`：真实代码扫描、Java/Spring/MyBatis/SQL/DDL/TypeScript 事实抽取。
- `@zeus/graph-engine`：project nodes/edges/views 生成，系统架构图、表关系图、模块图、模块详情图、接口时序图、模块流程图、方法逻辑图。
- `@zeus/ai-runtime`：adapter 检测、会话生命周期、Generic shell 风险判断和运行时事件。
- `@zeus/git-core`：Git status/diff/confirmation/白名单写操作参数校验。
- `@zeus/telegram-adapter`：Telegram 命令解析、sendMessage、getUpdates 和 long polling 服务。
- `@zeus/security-core`：Keychain account 约束、密钥状态和安全重置辅助。
- `@zeus/release-core`：release 状态、自动更新预留和签名/公证等待项表达。

## 安全与发布边界

安全与发布边界覆盖 127.0.0.1、Bearer token、Keychain、高风险二次确认、unsigned DMG/ZIP、Homebrew cask。

- 本地服务固定 `127.0.0.1`，API 使用 Bearer token，敏感字段只返回配置状态。
- Keychain 保存 Bot Token、API Key、数据库密码等敏感值；UI/API/日志不得回显明文。
- 高风险二次确认覆盖 Generic shell、Git 写操作、删除文件、项目外路径访问和远程触发 Runtime。
- 日志、patch、Mermaid、Runtime 导出必须脱敏或写入本机文件，不把长敏感正文发到 Telegram。
- 发布当前支持 unsigned DMG/ZIP、Homebrew cask、sha256 和包内 Electron 加载校验；Apple signing / notarization 只保留等待项，不伪装成已完成。

## 外部等待项

- React Flow / Sigma 与 node-pty / xterm.js 已接入本地核心；AI CLI 登录、Telegram Token、Apple signing / notarization 仍依赖用户提供真实外部凭据，pg / mysql2 仅作为可选数据库连接器，不属于 Zeus 本地核心依赖。
- 在等待项未满足前，Zeus 只能展示空态、未配置态、失败态或等待项，不使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点。
