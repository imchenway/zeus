# AI Runtime

AI Runtime 负责把任务、项目配置、图谱上下文、Git 状态和安全要求转换为真实本机 CLI 会话。未检测到命令、未登录或外部依赖缺失时必须返回不可用状态和设置提示，不生成假终端输出、假 AI 回复或伪摘要。

## Adapter 契约

Zeus 目标 adapter 覆盖 Codex、Claude Code、Gemini、Generic CLI。

每个 adapter 必须支持本机命令检测、版本检测、登录/认证状态检测、模型配置、工作目录配置、prompt 输入、输出解析、等待输入识别、完成识别和错误识别。

- Codex / Claude Code / Gemini adapter 只能在本机命令存在且状态可识别时展示可用能力。
- Generic CLI adapter 只能执行用户明确输入并通过风险判断的命令。
- Adapter detection 结果必须在 UI 中区分 available、missing、unknown、login-required、misconfigured。
- 不得把“命令存在”直接推断成“已登录”或“模型可用”。

## 会话生命周期

Runtime 会话状态必须覆盖 created、running、waiting、ended、failed、orphan_detected、lost。

- start：校验 projectId、cwd、adapter、并发限制和高风险确认后启动。
- write：只对支持输入的会话生效，不支持输入时返回明确错误。
- interrupt：用于 Ctrl-C / 中断当前进程，必须写入事件。
- resize：校验 cols/rows 为正整数，记录真实终端尺寸变化。
- stop：终止会话并写入 reason。
- restore：App 重启后读取 runtime_sessions；PID 存在时标记 orphan_detected，PID 不存在时标记 lost，不得伪造恢复成功。

## Prompt 生成

任务 prompt 必须包含任务标题、任务描述、项目路径、图谱上下文、源码路径和行号、SQL/表、Git 状态摘要、测试要求、安全要求。

- 项目默认模型优先于全局默认模型；任务选择优先于项目默认。
- 工作模式、允许改代码、是否运行测试、是否允许 Git 写操作必须进入 prompt 或执行前检查。
- 图谱上下文必须来自真实 node/edge/sourceRef；缺少来源时不写入 prompt。
- Git 状态摘要必须来自真实 status/diff，不得编造 clean 或 dirty 状态。
- 安全要求必须明确禁止泄露 token、API Key、数据库密码、Bot Token 和 `.env` 敏感值。

## 并发与队列

- 默认每个项目最多 1 个运行中 AI 会话。
- 全局默认最多 2 个运行中 AI 会话。
- 超出限制的任务进入 READY 或等待状态，不静默丢弃。
- 用户修改并发配置时，只影响后续调度，不伪造当前会话状态。

## 日志与导出

每个 session 的本机日志目录应包含 terminal.raw.log、terminal.normalized.log、metadata.json、chunks/。

- SQLite 保存事件索引，文件保存大文本。
- normalized log 用于 UI 搜索、导出、Telegram 摘要和排障。
- Runtime 日志导出必须脱敏，并默认写入本机文件。
- Telegram `/logs --full` 只返回本机文件路径、行数和摘要，不发送完整长日志正文。
- 会话摘要必须由真实会话内容生成；摘要失败或 AI 不可用时显示“未生成摘要”。

## 终端视图目标

设计书目标终端为 xterm.js：实时输出、自动滚动、搜索、复制、折叠、错误高亮、命令高亮、AI 回复高亮、原始输出查看、导出。

当前已接入 `node-pty / xterm.js`：后端优先使用真实 PTY，前端在 PTY 可用时挂载 xterm 终端；AI CLI 未安装或未登录时仍只展示真实等待状态。

## 降级与等待项

- node-pty / xterm.js 已接入；AI CLI adapter 探针已纳入 `pnpm verify:release`，用于非侵入式检测 Codex / Claude / Gemini 命令、版本和真实登录状态输出；剩余外部等待项是 AI CLI 登录、Telegram Token、Apple signing / notarization、Homebrew tap token。
- AI CLI 未安装、未登录或不可用时，不生成假终端输出、假 AI 回复或伪摘要。
- Generic shell 高风险命令未确认时，不启动进程。
- 项目路径不存在、cwd 跳出项目、疑似密钥文件访问或敏感目录访问时，必须拒绝或进入高风险确认。
- Runtime 失败应展示错误状态、事件和恢复方式，不用成功态覆盖失败。
