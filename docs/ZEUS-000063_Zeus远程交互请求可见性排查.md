# ZEUS-000063 Zeus 远程交互请求可见性排查

## 任务问题

Zeus 发起的 Codex 原生会话可以在 iOS 的 Remote 中阅读并收发普通消息，但执行轮次出现 `request_user_input` 选项框时，手机端看不到该交互；由 Codex 桌面端原生发起的会话可以显示同类交互。还需说明用户从 Codex 桌面端向 Zeus 发起的会话回复时会发生什么。

## 已确认产品目标

用户确认目标是“远程接管”：iOS 不只是显示选项，而是要直接回答 Zeus 当前正在等待的阻塞交互请求，并让同一执行轮次继续。把选项文字作为一条普通消息发送不算完成目标。

## 当前事实

1. 修改前，当前任务对应的 Codex thread 来源为 `originator=zeus`，Zeus 使用自己的 `codex app-server --listen stdio://` 进程；Codex 桌面端同时运行另一套独立 app-server。
2. `request_user_input` 在协议中是 app-server 发给客户端的 server request，不是普通 transcript 消息。回答必须携带原请求身份返回给仍持有该请求的运行时世代。
3. Zeus 已把 pending request 持久化到 `conversation_server_requests`，但真正向 Codex 返回答案时仍校验 `transportGenerationId`，并路由到持有该 generation 的 app-server；失去该 generation 会进入恢复必需状态，不允许向另一进程近似回填。
4. 修改前 Zeus 只启动普通 stdio app-server，没有对该进程调用 Codex Remote Control API。官方 Remote 的完整问答、审批和 steer 能力依赖已连接的执行宿主现场；只让另一客户端发现相同 thread/rollout，并不等于它接管了 Zeus 的 pending server request。
5. 因此手机能看到历史和普通消息，却看不到 Zeus 进程持有的选项框，是“会话内容可见”和“当前交互请求回答权”分属两条链路造成的，不是 iOS 单纯漏画一个组件。

## 在 Codex 中回复的当前影响

### 从 Zeus 自己的输入链路回复

Zeus 协调器发现当前轮次仍在 active 或 waiting 时，会把普通消息持久化为 queued submission，等待当前轮结束后再派发。当前现场已经观察到这一结果：阻塞请求被跳过后，随后输入的普通回复处于 `queued`，没有被当成选项答案。

优点：不会伪造选项答案，也不会立即开启竞争轮次。

代价：用户若以为普通文字已经回答选项，当前轮仍可能停留、跳过或按超时规则处理；下一条消息何时执行也容易产生误解。

### 从 Codex 桌面端的独立执行链路回复

该输入不经过 Zeus 的 pending-request 响应 API，不能天然完成 Zeus 当前请求。若 Codex 端把它作为新 turn 或 steer 发送，会形成两个客户端争夺同一 provider thread 的控制权；Zeus 当前 request 仍绑定原 generation，后续可能表现为等待未解除、外部新轮次不被 Zeus 实时投影，或在重新读取时进入冲突/恢复边界。

优点：普通会话内容可能继续追加到同一个 provider thread。

代价：无法保证回答当前选项，且存在状态分叉和轮次竞争风险。因此在补齐统一远程接管前，不应把 Codex 端普通回复描述成安全续接方式。

## 官方能力边界

OpenAI 当前 Remote 文档说明：远程设备通过保持运行的本机宿主继续会话、回答问题、steer 和批准动作。面向用户的标准入口由 Codex App 提供；当前 Codex app-server 的实验性协议同时公开 `remoteControl/enable`、状态、配对、客户端清单和撤销方法。App Server 文档还说明 `item/tool/requestUserInput` 是需要客户端按请求返回结果的 server request，处理后才会发出 `serverRequest/resolved`。

## Codex App 自身的处理机制

Codex App 不是让手机另开一套运行时读取相同 rollout，而是让持有会话的官方 app-server 宿主开启 Remote Control。实机排查进一步确认，当前官方独立安装版使用受管理守护进程：`app-server --remote-control --listen unix://`，桌面客户端通过本机 Unix WebSocket 控制套接字连接它。

1. 官方独立版 Codex CLI 启动受管理 app-server 守护进程，由该进程持有 thread、active turn、工具调用和 pending server request。
2. 桌面端通过 `$CODEX_HOME/app-server-control/app-server-control.sock` 的 WebSocket 控制连接初始化同一守护进程，并调用实验性 `remoteControl/enable`，完成主机 enrollment，得到可供远程发现的 `environmentId`；配对流程把受权手机登记为该 environment 的 controller。
3. iOS Remote 通过 OpenAI 的安全中继连接这个桌面执行宿主。项目文件、凭据、权限、插件和工具仍留在宿主机，手机只提供远程界面和用户操作。
4. 模型调用 `request_user_input` 时，原 app-server 发出带 request id、thread id、turn id 和 item id 的 `item/tool/requestUserInput`。Codex App 把这条阻塞交互投影到本地和远程界面，而不是把它降级成普通 assistant 文本。
5. 用户在任一受权界面选择选项、填写 Other 或跳过后，客户端按原 request id 返回结构化结果；app-server 发出 `serverRequest/resolved`，原 active turn 从同一执行现场继续。
6. pending request 消失后，各界面继续消费同一 app-server 的 turn/item 事件，因此不会出现“手机回答了，但桌面仍等待”的双状态。

公开文档没有披露 ChatGPT 安全中继内部的全部消息路由实现；上述第 3 至第 6 步是由 Remote 产品合同、app-server Remote Control API 和 server request 生命周期共同确认的外部语义，不把未公开的内部服务结构当成已知事实。

这与修改前 Zeus 实现的核心差异是：Zeus app-server 已经声明 `experimentalApi: true`，却尚未调用 Remote Control API，也没有消费远端回答后的 `serverRequest/resolved` 回执。因此当时只有 thread/rollout 可见性，没有完整远程接管。

## 结论

根因已经定位为“Zeus 只复用了 Codex thread/rollout 身份，但没有进入 Codex Remote 所控制的同一执行宿主与交互请求通道”。修复目标不是在 iOS 复制一个选项框，而是让 Remote 的回答最终回到 Zeus 当前 generation 持有的原 request，或让 Zeus 改为由可远程控制的统一宿主持有该执行轮次。

## 已确认交互规则

用户确认：只要 Codex App 或手机端已经进入同一个会话，就必须投影同一个阻塞选项框。选项框存在期间不提供绕过它发送普通消息的入口：

1. 点击选项时，按原 request id 返回所选结构化答案。
2. 在“其他”中输入文字时，该文字仍是当前问题的自定义答案，不创建 user message，也不调用 `turn/start` 或 `turn/steer`。
3. 点击跳过、关闭或按 Escape 时，按 Codex App 语义返回空 `answers`，明确解决当前 request；不能只在本地隐藏选项框。
4. app-server 发出 `serverRequest/resolved` 后，本地与所有远程界面同时移除选项框，恢复普通 composer，原 active turn 继续。
5. 多端同时回答时采用同一 request id 的单次决议：第一个被权威宿主接受并持久化的答案生效；其他端收到 resolved 后关闭界面。迟到或不同答案不得覆盖已决议结果，也不得转成普通消息。
6. 手机重连时先向权威宿主恢复 pending request；请求仍 pending 就重新显示选项框，请求已 resolved 就不得恢复旧框。宿主 generation 已丢失时显示恢复失败，不能允许用户回答一个已经失效的请求。

该规则与 Zeus 当前桌面交互基础一致：`PendingRequestSurface` 已用 `{ type: 'userInput', answers: {} }` 表达跳过，服务端也明确允许空 `answers` 表达关闭、Escape、跳过和自动解决。当前缺口是把同一请求权威安全地扩展到 Codex Remote，而不是重新设计选项框本身。

## 本次实现

### 执行宿主

1. `codexAppServerManager` 在远程模式下先通过官方 `codex remote-control start --json` 启动或复用受管理守护进程，再用不启用压缩的 Unix WebSocket 连接其控制套接字；WebSocket 文本帧被适配回 Zeus 现有 JSON-RPC 处理链。
2. `codexAppServerManager` 接入官方 `remoteControl/status/read`、启用、关闭、配对、配对状态、客户端清单和撤销方法，并按当前 Codex CLI 返回结构做严格校验。
3. 运行时世代管理器只允许在没有活动轮次和 pending request 时从普通 stdio 宿主切换到远程守护进程，避免把进行中的 request 强行搬到另一执行宿主；远程已启用时，新世代继续连接同一受管理宿主。
4. Local Server 持久化 `codex.remote_control.enabled`，启动后直接恢复远程守护进程控制连接；同时提供状态、启停、配对和撤销设备接口。配对码不写日志、不写设置库。

优点：远端加入的就是 Zeus 持有原请求的执行现场，选项、Other 和跳过都能按原 request id 回答。

代价：该能力依赖当前 Codex CLI 的实验性 Remote Control 协议；CLI 版本不兼容、账号未登录或网络异常时，设置页会显示真实错误，Zeus 不伪造连接成功。

### 请求决议回流

1. app-server 收到 `serverRequest/resolved` 后，先从内存 pending 表移除原请求，运行时世代不再被错误固定。
2. Zeus 协调器再按 `generationId + provider request id` 找到持久请求，将其标记为“由 provider 外部解决”；它不保存 Zeus 未看到的远端答案正文。
3. 本地广播同一个 `conversation.request.resolved`，关闭桌面选项框；若没有其他 pending request，轮次回到 running，普通输入框才恢复。
4. 本地先回答时，原有响应路径先完成持久化；随后到达的 provider resolved 回执会幂等忽略，不重复改写结果。

优点：手机回答后不会出现“模型已继续、Zeus 仍显示等待”的双状态，也不会把远端答案变成普通消息。

代价：官方 resolved 通知只含 request id，不回传答案正文；Zeus 只能可靠记录“原请求已解决”，不能在本地历史中重放手机填写的秘密或自由文本。

### 桌面设置

运行环境设置新增“Codex 远程接管”：显示真实连接状态、本机名称、远程环境、配对码和已授权设备，并支持启用、关闭、刷新、配对与撤销。点击“配对新设备”会在用户明确操作后启用 Remote Control 并申请手动配对码，不会在后台自行配对设备。官方服务固定显示 macOS 系统机器名，所以 Zeus 与 Codex App 的宿主可能同名；设置页明确提示用 Zeus 项目名或会话标题区分，不尝试修改全局系统主机名。

### 变更落点

- `packages/ai-runtime/src/codexAppServerManager.ts`：协议调用、返回值校验、进程重启恢复和 resolved 内存收口。
- `packages/ai-runtime/src/codexRuntimeGenerationManager.ts`：跨运行时世代启停与 pending 世代排空。
- `packages/local-server/src/codexNativeConversationCoordinator.ts`、`packages/storage/src/index.ts`：远端决议持久化、轮次状态恢复和桌面广播。
- `packages/local-server/src/index.ts`：持久开关、启动恢复、状态/配对/设备接口和审计。
- `apps/desktop/src/renderer/settings/CodexRemoteControlSettings.tsx`、`apiClient.ts`、`App.tsx`：运行环境设置入口。
- `CONTEXT.md`：补充“阻塞交互请求”和“远程接管”领域术语。

### 经授权处理的历史合并残留

用户授权继续后，一并清理了任务开始前已经提交在当前分支中的重复拼接和冲突标记。`ConversationComposer`、`ConversationTranscript`、`SessionWorkspace`、`taskWorkspaceModel`、`codexNativeConversationContracts` 与 coordinator 的队列快照恢复为单套实现；队列管理、运行权限切换和运行状态跳转能力均保留。`CONTEXT.md` 也恢复为单份领域文档并保留本任务新增术语。该清理是完整类型检查和打包的必要前提，不包含 Git 提交、推送或合并动作。

## 本次验证边界

- 本机 Homebrew Codex CLI `0.145.0` 的登录、HTTPS 与 WebSocket 网络诊断均成功，但官方 `remote-control start --json` 明确失败，原因是缺少 `$CODEX_HOME/packages/standalone/current/codex`；这解释了旧实现为何可以生成并认领配对码，宿主状态却始终为 `errored`。
- 经用户授权安装官方独立版 Codex CLI `0.146.1` 后，官方 `remote-control start --json` 返回 `connected`、受管理守护进程和真实控制套接字。单独启动普通 stdio app-server 或第二个 `--remote-control` 进程仍会得到 `errored`，只有连接受管理守护进程的 Unix WebSocket 才返回 `connected`。
- 修复后的隔离 `Zeus Test.app` 启动后读取到官方独立版 `0.146.1`，设置页真实显示 `已连接`，远程环境为 `env_e_6a067239dd608330a4684efcd657f647`。手机使用新环境手动码完成配对，Zeus 回读到 `iOS 26.3 iPhone` 授权设备。
- 已完成 iOS 实机主路径 E2E：隔离项目 `ZEUS-REMOTE-E2E` 新建会话，Zeus 桌面显示 `request_user_input` 的“手机可见 / 手机不可见 / 其他 / 跳过”原始选项框；用户在 iOS Remote 看到完整同一选项框并点击“手机可见”；Zeus 桌面选项框随后自动消失，会话由“需要回答”恢复为“已就绪”，原轮次完成。
- 实机同时观察到 Zeus 与 Codex App 远程宿主使用相同系统机器名，iOS 出现两个同名入口。当前官方协议从系统 `gethostname()` 生成该名称，没有单独的 Zeus 命名参数；本次用项目名 `ZEUS-REMOTE-E2E` 和会话标题识别正确入口。
- 最新代码已完整通过：`pnpm typecheck`、`pnpm lint`、`pnpm build` 与 `pnpm package:mac`。测试包仍为 `dist/test/mac-arm64/Zeus Test.app`，没有生成或启动任务工作树中的生产身份 `Zeus.app`。
- 尚未覆盖：iOS 自由输入、跳过、关闭、两端同时作答的竞态，以及从旧普通宿主存在进行中轮次时尝试开启远程的用户提示。代码对切换时的活动轮次和 pending request 采用拒绝切换，不能把主路径成功扩大为这些分支也已实机通过。

## 可视化交付

1. [远程接管设计实现图](./ZEUS-000063_远程接管设计实现图.html)：说明 Zeus 如何保留真实执行宿主、判断远端授权、向 iPhone 投影同一阻塞请求，并按 `generationId + requestId` 收口答案。
2. [远程接管用户操作指南](./ZEUS-000063_远程接管用户操作指南.html)：说明首次启用与配对、已授权设备复用、选项/Other/跳过的正确操作，以及普通消息不能替代选项答案的边界。

两张图都保留 75%、90%、100% 与 Auto 缩放，节点可点击查看说明，并将“已观察实现”“主链已验证”“分支待验证”分开标记。最终文件已通过当前 Vibe Diagram `0.1.16` 正式静态契约检查。此前内容版本曾在 1440×900、1280×800 与 390×844 三档浏览器视口通过 `VibeDiagramQuality.auditAll()`；本次仅更新证据措辞后，当前浏览器环境拒绝直接访问本地文件，因此没有把旧的浏览器结果冒充最终文字版本的重新审计结果。

可视化只改变任务说明与操作指引，不扩大验收结论：iPhone 真实选项显示与单选回答主路径已通过；Other、跳过、关闭和多端首答仍需分别做实机验证。
