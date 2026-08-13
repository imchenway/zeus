# ZEUS-0256：DeepSeek 官方 V4 模型接入 App Server

## 任务目标

DeepSeek 官方最新版 Responses API 已同时支持 `deepseek-v4-flash` 与 `deepseek-v4-pro`。Zeus 应让这两款官方直连模型在完成兼容验收后，新建会话默认使用 App Server 运行内核；不具备对应兼容证据的渠道和模型继续使用 Pi。

## 已确认事实

- DeepSeek 官方 Responses API 端点为 `/responses`，当前模型枚举同时包含 `deepseek-v4-flash` 与 `deepseek-v4-pro`。
- 官方 Responses API 是无状态接口，多轮请求需要客户端回传完整历史。
- 官方接口当前支持文本、函数工具、流式语义事件、推理强度、结构化输出和服务端网页搜索；不支持图片与文件输入，图片内容会被替换为占位文本。
- 当前 Zeus 实现尚未走这条路径：模型连接统一进入 Pi，Pi provider 固定使用 `openai-completions`。当前代码事实不能冒充此前设计已经交付。
- 历史讨论已经提出“完整兼容 Responses 的模型优先 App Server”，但当时停在兼容验收方式，没有完成产品路由或真实验收。

## 已确认产品边界

- DeepSeek 官方直连的 V4-Flash 与 V4-Pro 是本次 App Server 自动路由对象。
- 新会话只有在“接入渠道 + 模型 ID + 官方端点 + App Server 版本”的兼容证据有效时才自动走 App Server。
- 已经建立的 Pi 会话继续由 Pi 续接，不迁移、不改原生会话身份。
- 阿里云百炼、代理地址和自定义渠道不能复用 DeepSeek 官方直连证据；没有自身证据时继续走 Pi。
- App Server 会话失败后在原会话显示真实错误，不静默切到 Pi 重放，避免重复扣费、重复消息和重复工具副作用。
- DeepSeek Key 只通过 Zeus 安全存储进入隔离运行环境，不进入任务正文、SQLite 明文字段、日志或文档。
- 用户已允许本任务使用 Zeus 已配置的 DeepSeek Key，在独立测试数据目录和 `Zeus Test.app` 身份下产生少量真实请求完成验收；不得扰动生产应用、生产数据或用户日常 Codex 配置。

## 已实施

1. 模型连接目录按精确渠道边界识别 Responses 兼容证据：仅 DeepSeek 模板、官方 HTTPS 域名、空端口、根路径或 `/v1` 路径，以及 V4-Flash、V4-Pro 两个模型进入 App Server；其余连接仍进入 Pi。
2. Zeus 为 App Server 生成 `wire_api = "responses"` 的自定义供应商配置。连接 ID 先哈希再形成供应商 ID 和环境变量名，Key 只从 SecretStore 加载到专属子进程环境。
3. Runtime 世代管理器把供应商环境变化视为受控换代。新会话使用当前世代，正在执行或等待交互的旧会话固定在原世代，恢复时携带已持久化的模型来源重新建立供应商配置。
4. 任务会话、项目会话、后续消息、归档恢复和启动恢复都传递模型来源；同一 App Server 会话禁止切换模型渠道。
5. DeepSeek 官方 Responses 模型不再依赖 OpenAI 登录；界面只对 Codex 官方模型触发 Codex 登录交接。
6. 失败不切换到 Pi，也不自动重放。已经建立的 Pi 会话仍按原 `agentKind` 续接。

## 方案取舍

优点：用户无需理解两套运行内核；支持 Responses 的官方模型可以使用 App Server 更完整的会话、工具和恢复能力；不兼容渠道仍由 Pi 承载。

缺点：Zeus 需要长期维护按渠道、模型、端点和 App Server 版本划分的兼容证据；新旧会话会在一段时间内使用不同运行内核；真实验收会产生少量供应商费用。

## 验收结果

- 工程门禁：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac` 均通过。
- 测试包：已生成 `dist/test/mac-arm64/Zeus Test.app`；Info.plist 的 bundle ID 为 `dev.hypha.zeus.test`，应用名为 `Zeus Test`，使用临时签名。
- App Server 协议探针：当前 Codex CLI `0.147.0` 接受结构化 `modelProvider` 与 `wire_api = "responses"` 配置，返回的 thread 保留自定义供应商身份。
- 真实供应商调用：V4-Flash 与 V4-Pro 均通过 App Server 完成流式输出并返回精确哨兵文本；V4-Pro 额外完成一次动态工具调用并在工具结果回传后结束。
- 模型目录闭环：隔离数据库副本中的官方 DeepSeek V4-Flash、V4-Pro 都投影为 `agentKind = codex`、可用、工具支持、图片不支持。
- 完整本地服务路由：在隔离数据副本创建 V4-Pro 项目会话后，SQLite 记录为 `agent_kind = codex`、`agent_transport = app_server`，模型来源和模型 ID 均正确；重启同一隔离服务后恢复原 thread，并能读到真实 DeepSeek 响应。
- 密钥边界：所有探针只从 Zeus 安全存储读取 Key，输出只保留模型、供应商、流式、工具调用和结果布尔值，未输出或写入文档明文 Key。

## 未覆盖与阻断

- 本轮真实调用覆盖了流式文本、单次动态工具调用、服务重启后的原 thread 恢复；没有完整覆盖连续两次工具调用、中断、上下文整理、审批、文件工具、内置浏览器、错误展示和无状态长历史重放。因此这些能力不能宣称已经完成真实验收。
- 完整本地服务探针结束时主动关闭测试服务，所以恢复后的产品会话状态为 `paused`；这表示测试宿主已停止，不是供应商失败。

## GUI 验收

- 首次准备验收时，另一任务的 `Zeus Test.app` 正使用相同 bundle ID，本任务没有关闭、接管或复用该实例。待它自然退出后才继续。
- 最终只启动本任务 `dist/test/mac-arm64/Zeus Test.app`，使用独立数据根 `/tmp/zeus-0256-full-route.1l7QLY`；数据来自既有测试数据库的隔离副本，没有读取或修改生产 Zeus 数据。
- 当前三屏环境中，ID 5 是非主外接竖屏。主进程首次显示日志为 `matchKind=exact-id`、`targetDisplayId=5`、`actualDisplayId=5`、`corrected=false`，窗口首次出现即位于该外接屏。
- Computer Use 确认窗口标题为 `Zeus Test`，Renderer URL 来自本任务包内 `app.asar/dist/renderer/index.html`，不是生产应用或其他 worktree 实例。
- 隔离副本中的既有 V4-Pro 会话真实打开，模型控件显示 `DeepSeek / DeepSeek V4 Pro`；展开模型菜单后同时可见 `DeepSeek / DeepSeek V4 Flash` 与 `DeepSeek / DeepSeek V4 Pro`，且没有触发 Codex 登录交接。
- 本轮没有在 GUI 中发送新消息，避免重复请求、增加费用或改变既有结果；因此 GUI 只证明测试身份、外接屏首帧、模型目录和会话路由投影，不替代真实 Provider 调用证据。
- 验收结束时选择停止隔离副本中的待处理现场并正常退出，本任务主进程退出码为 `0`；其他 Zeus 实例未处理。

## 当前阶段

实现、工程门禁、独立测试包、真实 DeepSeek/App Server 调用、本地服务路由闭环和有限 GUI 验收已经完成。连续工具调用、中断、上下文整理、审批、文件工具、内置浏览器、错误展示和长历史仍是明确未覆盖项，不能随本次基础接入一并宣称完成。

## 官方资料

- DeepSeek Responses API：<https://api-docs.deepseek.com/zh-cn/api/create-response/>
- DeepSeek 模型列表：<https://api-docs.deepseek.com/zh-cn/api/list-models/>
