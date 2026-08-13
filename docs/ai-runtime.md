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

## Codex 服务档位

Codex native 会话的服务档位以当前 app-server `model/list` 目录为能力事实源。Zeus 不把模型、推理强度或模型名称中的速度描述推断为 Fast。

- 新 thread 的“跟随 Codex”省略 `serviceTier`；“标准”传递 `serviceTier: null`；目录档位传递目录原始 ID。
- 已有 thread 的后续 `turn/start` 只允许“标准”或当前模型目录档位；`thread/resume` 不携带档位覆盖。
- `thread/start`、`thread/resume` 响应和 `thread/settings/updated` 返回的 `serviceTier` 是实际生效状态，按 Runtime 世代与事件顺序写入同一 provider settings 快照。
- 当前模型不支持项目记忆中的目录档位时，保留模型并回退为标准；目录仍声明支持但 provider 拒绝时保留失败现场，不自动重放或伪造降级成功。
- 缺少实际档位时显示“未同步”；未知实际档位保留原始 ID，不猜测为 Fast。

目录驱动的优点是 UI 与 Runtime 能力自动同步；缺点是必须处理目录缺失、过期与异常响应，不能把缓存目录当作永久能力。

## Responses 兼容模型路由

模型连接不是天然属于 Pi。Zeus 在“接入渠道、模型、服务端点和当前 App Server 版本”已经形成真实兼容证据时，才把新会话交给 App Server；其他模型连接继续由 Pi 运行。当前已验收的范围仅包括 DeepSeek 模板、`https://api.deepseek.com` 官方端点以及 `deepseek-v4-flash`、`deepseek-v4-pro` 两个模型。百炼、代理地址、自定义渠道和其他模型不能继承这份证据。

- 新建会话持久化实际 `agentKind`、模型来源和模型 ID；已经建立的 Pi 会话不迁移。
- App Server 使用 `wire_api = "responses"` 的自定义模型供应商配置，API Key 只从 Zeus 安全存储注入专属子进程环境，不进入 thread config。
- 自定义 Responses 供应商不要求 OpenAI 账号登录，也不能使用 Codex service tier。
- 同一会话不能切换 App Server 模型渠道；失败后保留原会话错误，不跨内核自动重放。
- 当前 DeepSeek Responses 路由支持文本和工具，不声明图片或文件输入能力。

优点是兼容模型可以复用 App Server 的会话恢复、工具和状态闭环，用户不必手选运行内核。缺点是 Zeus 必须随供应商接口和 App Server 版本变化重新验收并维护精确边界，新旧会话也可能在一段时间内由不同内核运行。

## Prompt 生成

正式任务首发的用户输入只包含任务标题、任务描述和任务附件：

- 正文固定为“任务标题”和“任务描述”；任务描述为空时写“未提供”。
- 本次推送补充信息合并进任务描述，不新增第四类字段。
- Codex 附件通过结构化 input 发送，正文不复制附件路径、MIME、大小或 `sourceContext` JSON。
- cwd、工作模式、权限、sandbox、审批策略、模型、推理强度和服务档位通过 Runtime 或 app-server 结构化参数传递，不伪装成用户输入。
- 非 Codex Adapter 没有真实附件能力时明确拒绝带附件任务，不静默丢失附件。
- 项目默认模型优先于全局默认模型；任务选择优先于项目默认。

图谱问答不是正式任务首发。它可以携带来自真实 `node / edge / sourceRef` 的图谱上下文，并必须保留来源不足时的明确降级说明。

## 浏览器能力路由

新建 Codex thread 注册 `zeus_browser` 动态工具后，用户未明确指定其他浏览器时，网页打开、导航、点击、输入、页面检查和截图必须优先使用 Zeus 浏览器工具。Codex Browser 插件的浏览器列表为空只表示该插件没有可用实例，不能据此判定 Zeus 内置浏览器不可用，也不能因此绕过边界改用外部 Playwright。用户明确点名 Chrome 或其他浏览器时，必须尊重该选择并如实报告其可用性。

该路由属于 Runtime 开发者指令和动态工具声明，不进入任务首发用户正文。上线前创建、未注册动态工具的旧 provider thread 不自动替换；旧会话保持历史连续性，并引导用户创建浏览器可用的新会话。

优点是用户不需要识别两套 Browser，且继续复用 BrowserHost 的会话归属和安全审批。缺点是旧会话存在一次性迁移成本，模型是否真实选择 Zeus 工具仍必须通过 provider 回合验证，不能只凭静态声明判断完成。

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
