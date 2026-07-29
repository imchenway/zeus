# Zeus Product Context

register: product

## 产品定位

Zeus 是一款 AI 研发工作台，将项目与任务管理、Coding Agent 会话、代码理解、Git 变更审查和自动化协作整合在同一个工作空间中。

## 用户与场景

- 个人开发者：统一调度 AI 编程任务，并串联任务、会话、Git diff 和运行验收结果。
- 技术负责人：快速理解陌生项目的模块、接口、表和调用链，基于真实源码和 SQL/DDL 判断影响范围。
- 开源维护者：把 issue、任务、终端日志、代码变更、图谱上下文和远程通知串成一个闭环。

## Aha Moment

用户第一次添加真实项目并完成扫描后，看到可追溯到源码的系统架构图、表关系图、模块详情图、接口时序图、模块流程图和方法逻辑图，并能从代码上下文继续创建任务或进入 Coding Agent 会话。

## 当前已验证边界

- Zeus 当前已覆盖 Electron 桌面应用、app-server、SQLite 存储、真实代码扫描、代码图谱、图谱问答、Sigma/WebGL 大图、React Flow 局部图、任务管理、AI Runtime（node-pty + xterm.js）、Git Diff、Telegram long polling、安全与发布打包。当前公开安装包为 Apple Silicon macOS 版本，这是发布边界，不是产品平台定位。
- 当前发布证据链包含 lint、typecheck、build、package:mac、DMG/ZIP、Homebrew cask、包内 Electron 可执行文件加载及必要的真实运行验收；各阶段证据不得互相替代。
- 当前真实扫描基线为 162 files / 15984 nodes / 31536 edges / 7 views，扫描的是 `/Users/david/hypha/zeus` 真实代码库。
- 缺少真实数据时，产品展示空态、失败态、未配置态或外部配置等待项，不用 seed 数据伪造繁荣度。

## 非目标

- 不是云端 SaaS，不默认上传源码、终端日志、Git diff、SQLite 数据或 Telegram 消息。
- 不是通用数据库管理工具；外部数据库 introspection 只服务代码地图，不替代专业 DBA 工具。
- 不是任意 shell / Git 执行器；高风险 shell、Git 写操作、文件删除和远程触发 Runtime 必须保留二次确认与审计。
- 不是 AI 回复模拟器；AI CLI 未安装、未登录或不可用时，只展示配置原因，不生成假回复。
- 不使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点。

## 外部配置等待项

- AI CLI 登录状态：等待用户在本机完成 Codex / Claude / Gemini 等 CLI 安装与登录。
- Telegram Bot Token / whitelist：等待用户提供真实 bot token 和允许的 Telegram user id。
- Apple signing / notarization：等待用户提供 Apple Developer 证书和 notarization 凭据；当前只验证 unsigned DMG/ZIP。
- Homebrew tap token：等待用户提供远端 tap 发布凭据；当前只生成本地 cask 文件。
- Postgres / MySQL driver：可选连接器，不属于 Zeus 本地核心依赖；仅在用户项目显式配置外部数据库 introspection 时才需要。

## 产品原则

- 用户拥有项目数据、执行权限和外部集成的明确控制权。
- 无真实来源不展示业务数据。
- 外部工具缺失时清楚显示“需要配置”，不伪造结果。
- 高风险 Git、Shell、文件操作默认二次确认。
- 所有图谱节点、边、摘要和任务上下文都必须能追溯到真实源码、SQL、DDL、Git、Runtime、Telegram update 或用户明确创建的记录。
