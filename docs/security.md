# 安全设计

Zeus 的安全目标是：默认本机可用、默认不暴露公网、默认不泄露密钥、默认不执行高风险动作。所有安全状态必须来自真实配置、Keychain、审计记录或运行时事实，不用假成功状态掩盖缺口。

## 本地 API 边界

本地 API 边界覆盖 127.0.0.1、随机端口、Bearer token、preload token bridge、CORS。

- 本地服务默认只监听 `127.0.0.1`，禁止默认监听 `0.0.0.0`。
- 端口应由本机运行时分配或配置，Renderer 通过受控 bridge 获取地址和 token，不从任意网页读取。
- API 使用 Bearer token；token 不写入页面文案、日志或导出文件。
- CORS 仅允许本地应用 origin；不得让任意网页访问本机 API。
- `/health` 可用于本机健康检查，但不得泄露 token、路径、密钥或用户项目详情。

## Keychain 与密钥状态

Keychain 存储范围包括 Telegram Bot Token、外部 API Key、本地 API token、数据库连接密码。

- UI/API 只展示密钥是否已配置、更新时间、风险提示和清理/重置入口。
- 不回显明文 token、API Key、数据库密码、Bot Token 或完整密钥输出。
- 数据库 URI 中若包含 password，必须拒绝保存并要求密码进入 Keychain 字段。
- 安全重置必须清理可控密钥、停止 Telegram polling、关闭通知，并写入审计事件。

## 执行目录限制

AI Runtime、Git 操作、文件操作必须限制在项目路径内。

- Runtime cwd 必须位于允许的项目目录内；项目外 cwd 应拒绝或进入高风险确认。
- 文件读取、写入、patch export、source open、Runtime log export 必须校验路径边界。
- 写入项目外目录、访问敏感目录、读取疑似密钥文件属于高风险场景。
- 任何路径跳出项目目录时，不得静默执行。

## 高风险二次确认

高风险二次确认覆盖删除文件、执行 shell 命令、Git commit、Git push、Git reset、写入项目外目录、读取疑似密钥文件。

- Git commit、push、reset、stash、apply stash、branch、pull、rollback 等写操作必须通过白名单 confirmation。
- Generic shell 默认需要风险分类；危险命令需要明确确认短语。
- 用户拒绝确认时不得启动 Runtime 或 Git 写操作，并必须写入安全审计和实时事件。
- Telegram 远程触发 Runtime、Git diff、日志导出等操作必须受白名单和确认策略限制。

## 敏感日志脱敏

敏感日志脱敏范围包括 API key、Bot token、Authorization header、Cookie、SSH key、数据库密码、.env 中敏感值。

- Runtime normalized logs、Telegram `/logs --full`、patch export、Mermaid export、设置导出和业务数据导出都必须脱敏或只写入本机文件。
- Telegram 不发送完整长日志正文；只发送摘要、计数、状态和本机文件路径。
- 错误面板可以说明失败原因和恢复方式，但普通 UI 不展示堆栈、密钥或完整终端密钥输出。
- 审计日志记录动作、对象、结果和时间，不记录明文密钥。

## 审计与恢复

- 安全相关动作必须写入审计：密钥保存/清理、安全重置、高风险确认创建/确认/拒绝、Git 写操作、Runtime 高风险启动、Telegram 拒绝访问。
- 审计记录只保存必要排障字段，不保存明文 token 或密钥。
- 用户应能通过 Settings / Security 查看配置状态、风险提示、审计时间线和重置入口。
- 重置后应显示真实未配置状态，不保留假成功标记。

## 远程入口与发布等待项

远程入口与发布等待项包括 Telegram 白名单、Apple signing / notarization、Homebrew tap token。

- Telegram Bot Token 未配置时，long polling 与通知保持未启用。
- 非白名单 Telegram user id 必须拒绝，不能返回项目、任务、日志或 diff 详情。
- Apple signing / notarization 未配置时，只能声明 unsigned DMG/ZIP；不得伪装成已签名或已公证。
- Homebrew tap token 未配置时，只生成本地 cask，不声明已发布远端 tap。
- 外部等待项必须在 README、CHANGELOG、ROADMAP、实现报告和 PR 模板中保持一致。
