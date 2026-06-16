# Telegram 入口

Telegram 是 Zeus 的远程入口，但不是公网服务。Zeus 通过本机 long polling 主动拉取 Telegram Bot API update；未配置真实 Bot Token 和白名单时保持未启用，不生成假 Telegram 消息或假远程命令结果。

## 接入方式

Telegram Bot API long polling，本地 Zeus 主动轮询，不需要公网服务。

- Bot Token 存入 macOS Keychain，UI/API 只展示配置状态。
- polling 由本机服务启动/停止，状态、offset、最近错误和消息日志写入本机状态。
- 网络错误、Telegram API 错误和 token 失效必须展示失败态，不伪造在线。
- 所有 update 处理结果必须可追溯到真实 Telegram update。

## 安全策略

Bot Token 存 Keychain、allowed user id 白名单、不在 UI 明文显示 token、远程高风险操作二次确认。

- 必须配置 Bot Token。
- 必须配置 allowed user id 白名单。
- 非白名单用户不得读取项目、任务、日志、diff 或触发 Runtime。
- 默认禁止远程执行任意 shell 命令。
- 远程任务默认不允许自动提交 Git。
- `/run`、`/stop`、`/continue`、`/diff`、`/logs --full` 等高风险或高信息量操作必须受安全策略约束。
- 所有命令写入审计日志和消息日志，且不记录明文 token。

## 命令集合

支持命令：/start、/help、/projects、/tasks、/run、/status、/stop、/continue、/logs、/diff、/ask。

- `/start` / `/help`：返回可用命令、安全限制和当前配置状态。
- `/projects`：列出真实项目摘要，不返回本机敏感路径细节以外的密钥内容。
- `/tasks`：列出真实任务状态、更新时间和可执行下一步。
- `/run <project> <task>`：创建或触发真实任务；缺少项目、任务或安全确认时返回等待项。
- `/status <task>`：返回真实任务状态、Runtime 状态和最近事件。
- `/stop <task>` / `/continue <task>`：受白名单和确认策略保护。
- `/logs <task>`：默认返回摘要；`--full` 只导出本机脱敏文件并返回路径。
- `/diff <task>`：大 diff 只发摘要，必要时导出本机 patch。
- `/ask <project> <question>`：基于真实图谱上下文回答，回答必须带来源。

## 通知与静默模式

通知覆盖任务开始、阶段变化、等待确认、完成、失败、代码变更摘要、测试失败、安全确认。

- 长任务可以发送阶段摘要，但必须避免刷屏。
- 静默模式下只发送失败、等待确认和安全风险等关键通知。
- 通知内容必须脱敏，不发送 token、API key、数据库密码、环境变量或完整终端密钥输出。
- 通知必须来自真实任务事件、Runtime 事件、Git diff、测试结果或安全审计。

## 消息限制与脱敏

长日志自动截断、大 diff 只发摘要、完整日志导出为本机文件、不发送密钥、token、环境变量。

- Telegram 消息长度受限时必须截断并说明已截断。
- 大 diff 默认只发送文件列表、增删行数、风险摘要和本机导出路径。
- 错误信息必须脱敏，不能包含 Authorization header、Cookie、SSH key、Bot token、API key、数据库密码或 `.env` 敏感值。
- 完整 Runtime 日志和 patch 只写入本机文件，Telegram 只返回文件路径、行数和摘要。

## 降级与等待项

- Telegram Bot Token 未配置时显示“Telegram Bot Token 未配置”，long polling 和通知保持未启用。
- allowed user id 未配置时不处理远程命令。
- Telegram API 网络不可用或 token 失效时显示失败态和最近错误。
- AI CLI、图谱或 Git diff 不可用时，相关命令返回等待项或失败态，不伪造结果。
- 不生成假 Telegram 消息或假远程命令结果。
