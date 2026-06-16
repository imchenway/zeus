# 本地优先原则

Zeus 的默认运行模型是 local-first：用户代码、任务、Runtime、Git diff、图谱、Telegram 日志和发布产物都优先保留在本机。外部服务缺失时展示未配置或等待项，不用假数据补齐体验。

## 本机事实源

事实源必须来自真实本地目录、SQLite、Git diff、Runtime 会话、Telegram update、Keychain、DMG/ZIP 产物或用户明确创建的记录。

- 项目：真实存在且可读的本地目录、manifest、Git root、用户保存的项目配置。
- 任务：SQLite task records、task events、Runtime sessions、graph context、Git diff 和用户明确创建的模板。
- 图谱：真实源码、SQL、DDL、SQLite schema、源码行号、source hash、Git 变更和用户导入的真实 schema 文件。
- Runtime：真实 AI CLI / Generic shell 会话、stdout/stderr、normalized logs、中断、输入、resize 和摘要。
- Telegram：真实 getUpdates、白名单匹配、命令分发、消息日志和通知设置。
- 发布：真实 Zeus.app、DMG、ZIP、Homebrew cask、sha256、包内 Electron 加载结果。

## 本机存储边界

- SQLite/sql.js 是当前本地事实存储，保存项目、配置、任务、事件、Runtime、Git、代码索引、图谱、Telegram 和安全审计。
- macOS Keychain 保存 Bot Token、API Key、数据库密码等敏感值；SQLite/API/UI 只保存或展示配置状态。
- 任务日志、Runtime normalized logs、导出的 patch / Mermaid / settings snapshot 都写入本机文件。
- 本地 API 仅监听 `127.0.0.1`，通过 Bearer token 保护，不默认暴露公网。

## 可重建缓存

代码索引、图谱视图、布局缓存属于可重建缓存。

- 清理缓存不得删除项目、任务、Runtime 日志、Git 快照、Telegram 日志或安全审计。
- 重新扫描必须回到真实源码、SQL、DDL 和配置路径，不从旧缓存伪造新事实。
- 图谱节点、边和视图必须保留来源信息；无法追溯来源时不得展示为真实图谱。

## 导入导出边界

- 导出设置和业务数据必须脱敏，不能包含明文 token、API Key、数据库密码、Bot Token 或完整密钥输出。
- 导入设置只能恢复允许的本机偏好，例如 app shell、默认模型、默认模板、Runtime 安全偏好、Code Map 显示/缓存设置、Telegram 通知设置和 Telegram 白名单；不得导入 Bot Token、API Key、数据库密码或任意密钥明文。
- 导入业务数据必须来自 schemaVersion 匹配的本机快照，不能绕过真实路径校验创建不存在的项目。
- Runtime 日志、patch、Mermaid 和业务数据导出默认写入本机文件；Telegram 只返回摘要或本机文件路径。

## 外部等待项

AI CLI、Telegram、Apple signing、notarization、Homebrew tap 是外部等待项；Postgres/MySQL driver 是可选连接器等待项，不是 Zeus 本地核心依赖。

- AI CLI 未安装或未登录时，只显示安装/登录/版本检测状态，不生成假 AI 回复。
- Telegram Bot Token 或 whitelist 未配置时，long polling 和通知保持未启用。
- Apple signing / notarization 未配置时，只声明 unsigned DMG/ZIP。
- Homebrew tap token 未配置时，只生成本地 cask 文件，不声明已发布远端 tap。
- Postgres/MySQL driver 未安装或用户未配置外部数据库时，不执行外部数据库 introspection；这不影响 Zeus 本地 SQLite、代码扫描和图谱核心能力。包含密码的 URI 必须拒绝并要求进入 Keychain。

## 禁止项

- 不上传源码、终端日志、Git diff、SQLite 数据或 Telegram 消息，除非用户显式选择外部操作。
- 不使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点。
- 不把外部配置等待项写成已完成。
- 不把 unsigned DMG/ZIP 伪装成已签名或已公证产物。
