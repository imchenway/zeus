# Codex App Server、Pi 与 Claude Agent SDK 技术选型评价

## 任务口径

用户原句为：“只要去模仿 Codex，体验就不会差；底层只要用 PI 或者 Claude Code 的 SDK，那功能就不会差。”

本次只评价技术选型，并将“功能不会差”明确为产品级能力：同时覆盖功能、稳定性、状态一致性、权限与安全、异常恢复和可运维性。可检验命题是：

> 采用 Pi 或 Claude Agent SDK，本身足以保证编码智能体达到产品级能力。

## 结论

该命题不成立。Pi 或 Claude Agent SDK 可以显著抬高智能体运行内核的下限，但不是产品级能力的充分条件。

更准确的说法是：

> 采用成熟的智能体运行内核，可以让基础代理能力较快达到可用水平；最终产品能力仍由会话生命周期、状态一致性、安全边界、客户端编排、异常恢复和运维交付共同决定。

## 分层判断

| 能力层     | SDK 通常可以提供                        | 产品仍需负责                       |
|---------|-----------------------------------|------------------------------|
| 智能体运行内核 | 模型调用、工具循环、文件与终端工具、流式事件、上下文压缩、扩展机制 | 模型与提示策略的真实效果、版本兼容、降级策略       |
| 会话与执行   | 基础会话、恢复或分支能力、事件订阅                 | 权威状态源、幂等、重连、后台宿主、并发写入、失败恢复   |
| 安全与权限   | 工具白名单、权限回调、hooks 或可扩展策略           | 操作系统沙箱、项目边界、敏感信息治理、审批审计、企业策略 |
| 产品客户端   | 可供界面消费的事件或直接状态                    | 状态投影、交互请求、差异展示、空态与错误态、跨窗口一致性 |
| 生产运维    | 部分用量、诊断或事件能力                      | 认证接入、限额与账单、遥测、升级回滚、签名公证、支持体系 |

SDK 主要解决第一层，并覆盖第二、三层的一部分。后面几层做得不好，产品仍会出现重复执行、状态错乱、无法恢复、越权操作或升级中断等产品级缺陷。

## Pi 的技术取舍

### 优点

- SDK 可直接嵌入 Node.js 应用，也提供 RPC 模式，适合自定义桌面端、Web 或自动化工作流。
- `AgentSession` 已覆盖消息历史、模型状态、上下文压缩和事件流；会话管理支持持久化、继续、分支和树形导航。
- 工具、扩展、skills、上下文文件和自定义 UI 的可塑性强；项目公开提供 fork 与 rebrand 配置，许可证为 MIT。

### 缺点

- 高自由度意味着产品方承担更多运行时治理责任。其 SDK 文档能证明工具选择、会话和扩展能力，但不能据此推定已经拥有完整的产品级沙箱、审批、审计和宿主恢复闭环。
- 自定义越深，后续升级、行为兼容和问题归因成本越高。

适合：强调多模型或运行时可塑性，并愿意自行拥有产品级安全、状态和运维层的团队。

## Claude Agent SDK 的技术取舍

### 优点

- 官方能力面较完整，包含内置工具、hooks、子智能体、MCP、权限和会话。
- TypeScript 与 Python SDK 随包提供原生 Claude Code 二进制，基础接入路径较短。
- 官方同时提供权限、checkpoint、成本、OpenTelemetry、托管和安全部署文档，生产化起点高于只提供基础工具循环的库。

### 缺点

- 产品行为、模型能力和发布节奏与 Claude 生态绑定，不能因此获得 Codex 的 thread、turn、审批、diff 或配置语义。
- 第三方产品的认证存在明确边界：未经批准，不能向用户提供 claude.ai 登录或其用量额度，需要使用 API Key 等官方支持方式。
- 即使 SDK 提供权限与会话，宿主生命周期、状态投影、幂等恢复、升级回滚和客户端体验仍由产品方负责。

适合：以 Claude 运行语义为产品基础，希望快速获得较完整代理能力，并接受供应商边界的团队。

## 为什么不能由此推导 Codex 功能对齐

Codex 官方将完整 harness 描述为多个组成部分：thread 生命周期与持久化、配置与认证、沙箱中的工具执行与扩展，以及承载多个 core
thread 的长生命周期 App Server。客户端还要处理双向请求、审批、输入和细粒度事件。

因此，即使另一个 SDK 也有“会话、工具、权限、MCP”这些同名功能，它们的协议语义、状态机、持久化、事件粒度和异常边界仍可能不同。功能项同名不等于行为相同，更不等于产品级对齐。

如果目标是尽量复现 Codex 的行为，技术上更稳妥的路线是直接使用 Codex App Server，并按当前官方协议和真实客户端行为取证；如果目标是做独立产品，则应明确选择
Pi 或 Claude 的运行语义，不宜宣称因此获得 Codex parity。

## Codex App Server 与 Pi 的架构差异

### 先区分三个层次

| 层次       | 负责内容                  | 典型对象                           |
|----------|-----------------------|--------------------------------|
| 模型供应源    | 提供模型推理与账号额度           | OpenAI、Anthropic、Google、本地模型服务 |
| 智能体运行内核  | 负责提示、工具循环、上下文、会话与策略   | Codex core、Pi agent loop       |
| 智能体客户端协议 | 让桌面端、IDE 或其他客户端控制运行内核 | Codex App Server、Pi RPC        |

Pi 可以连接 OpenAI Codex、Claude 或其他模型供应源，但仍由 Pi agent loop 组织提示、工具和会话。使用相同模型不代表使用相同运行内核，更不代表获得
Codex App Server 的协议语义。

### 对位比较

| 维度      | Codex App Server                                                                          | Pi RPC                                                                | Pi 同进程 SDK                                  |
|---------|-------------------------------------------------------------------------------------------|-----------------------------------------------------------------------|---------------------------------------------|
| 定位      | 完整 Codex harness 的客户端协议                                                                   | Pi coding agent 的无头控制协议                                               | 直接创建和控制 `AgentSession`                      |
| 传输      | 双向 JSON-RPC 形状；默认 JSONL/stdio，也支持其他本机传输                                                   | JSONL/stdio 的 command、response、event，加扩展 UI 子协议                       | TypeScript 函数、对象和事件订阅，无进程协议                 |
| 运行内核    | Codex core，语义与 Codex 产品族同源                                                                | Pi agent loop                                                         | Pi agent loop                               |
| 模型      | 由 Codex 配置、账号和 `model/list` 提供                                                            | 原生支持多个供应商、订阅账号、API Key 与自定义模型                                         | 与 Pi RPC 相同，并可直接注入自定义 provider 和模型运行时       |
| 会话模型    | 一个 App Server 可管理多个 thread；thread 下有 turn 和 typed item，并支持 start、resume、fork、archive、list | 一个 RPC 进程围绕当前 session 工作；支持 new、switch、fork、clone 和树形 JSONL 会话        | 每个 `AgentSession` 是一个会话对象；多会话并发与生命周期由宿主自行编排 |
| 事件粒度    | 面向富客户端的 thread、turn、item 生命周期；diff、审批、工具和回答都有稳定归属标识                                       | 面向 agent loop 的 agent、turn、message、tool、queue、compaction 与 retry 事件   | 与 Pi 事件模型相同，但可直接读取内部状态                      |
| 权限与安全   | sandbox、approval policy、permissions profile 和带 thread/turn/item 身份的服务端审批是一等协议             | 工具选择、`tool_call` gate、扩展确认和 sandbox 示例可组合实现；产品策略主要由扩展与宿主拥有            | 最自由，也最需要宿主自己建立隔离、审批、审计和故障边界                 |
| 扩展      | MCP、skills、apps、动态工具及 Codex 配置体系                                                          | extensions 可注册工具、provider、命令、事件与 UI；另有 skills、上下文文件和 prompt templates | 可直接注入工具、extension factory、资源加载器和事件总线        |
| 认证      | 协议内提供账号读取、ChatGPT 登录、API Key、登出、额度与账号变化事件                                                 | 支持多个供应商的 OAuth、API Key、环境变量和 `auth.json`                              | 可直接替换 credential store 与模型运行时               |
| 隔离与故障范围 | 默认独立子进程，客户端与运行内核故障隔离，需处理重启和协议兼容                                                           | 独立子进程，隔离性相近；一个进程的当前 session 与进程生命周期绑定                                 | 集成最直接，但宿主进程与 agent loop 共享故障范围和依赖版本         |
| 可移植性    | 深度保留 Codex 原生能力，供应商耦合更强                                                                   | 跨模型与 provider 的自由度高                                                   | 自由度最高，但仅适合 Node.js/TypeScript 同进程集成         |

Pi RPC 也支持由扩展发起 `select`、`confirm`、`input` 和 `editor` 请求，因此它并非只能单向输出。不过这些请求属于通用扩展 UI
子协议；Codex 的命令、文件、权限、MCP 和用户询问则拥有 thread、turn、item 与请求生命周期语义。两者都能“问用户”，但不是同一个领域协议。

### 各自优缺点

#### Codex App Server

优点：

- 直接获得 Codex 原生 thread、turn、item、审批、diff、账号、模型发现和配置语义。
- 协议为富客户端设计，一个进程可承载多个 thread，适合桌面端和 IDE 的并行会话。
- 官方明确以稳定、向后兼容的客户端协议为目标，实验能力有显式 opt-in。

缺点：

- 与 Codex core、账号体系和发布节奏深度绑定。
- 客户端需要维护完整 JSON-RPC binding、事件投影、进程重启和协议兼容。
- 若产品追求统一的多模型运行语义，Codex 特有能力不容易无损抽象成公共最小集合。

#### Pi RPC

优点：

- 保留子进程隔离，同时支持多个 provider、模型和开放扩展机制。
- 命令、事件和扩展 UI 协议足以构建自定义桌面端或 IDE。
- 会话 JSONL、树形分支、压缩、重试和工具事件对自定义产品较透明。

缺点：

- RPC 以当前 session 为中心；多会话并行通常需要多个进程或产品方再建调度层。
- 原生事件更接近 agent loop，产品方需要自行归一化为稳定的消息、审批、diff 和恢复状态。
- 安全策略可组合但不等于 Codex 的一等 sandbox/approval 协议，产品方承担更多政策设计与验证责任。

#### Pi 同进程 SDK

优点：

- 无协议映射成本，可直接读取状态、注入工具、provider、资源加载器和事件总线。
- 适合 Node.js 产品快速实现深度定制和多个独立 `AgentSession`。

缺点：

- agent loop 与产品宿主共享进程、内存和依赖，故障隔离较弱。
- 会话并发、资源回收、升级排空和崩溃恢复全部由宿主拥有。
- 语言与运行时耦合更强，不适合作为跨语言稳定边界。

## Zeus 当前适配性

Zeus 当前不是简单执行一条 Codex CLI 命令，而是已经按 Codex App Server 语义实现：

- `codexAppServerManager.ts` 启动用户本机 `codex app-server --listen stdio://`，完成 `initialize` 与 `model/list`，并直接调用
  `thread/start`、`thread/resume`、`thread/read`、`turn/start`、`turn/steer` 和 `turn/interrupt`。
- `codexRuntimeGenerationManager.ts` 以 thread 为路由单位，同时管理多个 app-server 世代；活动 turn 或待交互请求固定在原世代，空闲
  thread 才迁移到当前世代。
- Coordinator 已处理命令、文件、权限、用户询问、MCP 与动态工具请求，并把 provider thread/turn 状态投影到 Zeus 持久化与界面。

### Codex 开源边界与 Zeus 职责

“Codex core 无法参考”这一前提不成立。OpenAI 已将 Codex CLI、Codex core 所在的 Rust 实现与 Codex App Server 放在
`openai/codex` 仓库中，并以 Apache-2.0 许可证开放；其中 `codex-rs/core` 承载主要 agent loop，`codex-rs/app-server` 托管
core thread 并向客户端暴露协议。因此 Zeus 可以直接阅读、跟踪和验证这两层实现。

这个开源范围不等于整个 Codex 产品栈均已开放。模型权重、Codex cloud、账号和托管服务端行为不能从本地 core 源码推出；OpenAI
当前也明确将 IDE extension 与 Codex cloud 列为非开源组件。Zeus 的 parity 结论仍必须区分开源 core、公开协议、实际安装的
Codex CLI 版本与未公开产品行为。

从当前代码看，Zeus 没有重写 Codex 的内层智能体 harness：

- Codex core 负责模型调用、提示与上下文处理、工具决策循环、原生 thread/turn 状态和协议事件。
- Zeus 启动用户本机 `codex app-server`，调用 `thread/*` 与 `turn/*`，并响应其工具、审批和用户输入请求。
- Zeus 自研的是产品编排层，包括项目与工作区、多个运行时世代、产品会话投影、界面、安全交互、恢复与运维闭环。

Zeus 即使承接命令、文件、MCP 或动态工具调用，也只是实现运行内核请求的产品侧执行与治理，不代表 Zeus 自己拥有决定“何时调用哪个工具”的
agent loop。

因此，把 Codex App Server 换成 Pi 不是“替换一个可执行文件”，而是更换智能体运行内核和客户端协议。至少需要重新设计：

1. Pi session entry 与 Zeus conversation、submission、turn item 的身份映射；
2. 多会话并行、进程世代、活动会话固定与排空策略；
3. 命令、文件、权限、用户询问和 MCP 的统一请求模型；
4. sandbox、审批记忆、敏感回答与审计边界；
5. 模型、thinking、服务档位、账号和额度的能力映射；
6. 既有 Codex thread 的保留、只读展示或迁移策略。

### 选型结论

如果 Zeus 的目标仍是“与 Codex App 保持实现和行为一致”，应继续使用 Codex App Server。

优点是保留现有语义和真实 Codex parity，迁移风险最低；缺点是继续承担 Codex 供应商耦合。

如果 Zeus 的目标改为“统一承载多个模型供应商的独立智能体产品”，Pi 更适合作为新增运行内核，但建议作为独立 adapter 接入，而不是伪装成
Codex App Server 或直接替换现有实现。

优点是保留 Codex 原生能力，同时逐步验证 Pi 的多模型价值；缺点是 Zeus 必须明确拥有公共领域模型，并为两套运行时分别维护协议、恢复、安全和真实端到端验收。

Zeus 后续产品战略现已明确转向多模型供应源，但这不改变“不替换 Codex App Server”的结论。后续应启动 Pi adapter 的独立架构设计，让
Codex 保留原生 harness，同时让 Pi 承载通用多模型能力。

## 已确认的 Zeus 多运行内核方向

### 目标分层

| 运行内核适配器        | 原生运行内核                              | 首期模型供应源                    | 定位              |
|----------------|-------------------------------------|----------------------------|-----------------|
| Codex adapter  | Codex core，经 Codex App Server 托管和暴露 | Codex 支持的 OpenAI 模型与账号     | 保留完整 Codex 原生语义 |
| Pi adapter     | Pi agent core 与 coding-agent        | Grok、Kimi、DeepSeek、ZAI/GLM | 通用多模型主扩展路径      |
| Claude adapter | Claude Code / Claude Agent SDK      | Claude                     | 后续可选，优先级最低      |

“Grok、Kimi、DeepSeek、GLM 走统一模型内核”在本任务中正式更正为“走统一的 Pi 智能体运行内核”：Zeus 不直接为每个模型重写工具循环，而是由
Pi 统一提供工具、会话、上下文压缩、事件和扩展能力，再由 provider 层选择模型供应源。

因此，后续多模型扩展仍不应让 Zeus 自研一套通用 agent loop：Codex 路径复用 Codex core，通用模型路径复用 Pi agent core，Zeus
只统一适配器契约、产品会话、能力界面与跨内核承接。优点是能够继承两个成熟内核的行为与安全更新；缺点是 Zeus
需要承担双内核版本兼容和能力差异治理。若改为自研统一
harness，优点是控制权更集中，缺点是必须重新承担上下文压缩、工具循环、权限、安全、恢复、扩展生态和长期回归成本，当前没有足够收益支撑该路线。

Pi 当前官方 provider 文档已经列出 xAI、DeepSeek、Kimi For Coding 与 ZAI Coding Plan。ZAI 条目不能自动证明所有 GLM 型号均可用；GLM
必须在接入阶段以真实模型目录、账号区域、API 协议和运行结果单独验证，必要时使用 Pi 自定义 provider。

### 能力呈现

Zeus 采用能力驱动界面，不采用最低公共功能，也不为每个运行内核复制整套页面：

- 会话列表、消息主干、输入、停止、错误和恢复等共享产品结构保持一致；
- adapter 必须报告经过真实验证的会话、steer、审批、文件变更、MCP、skills、分支、账号、额度、服务档位等能力；
- Codex 专有能力只在 Codex adapter 下出现，Pi 或未来 Claude 只有在原生支持并完成产品映射后才展示同名功能；
- 模型名称和供应商不能作为能力证据，界面不得因为选择 Grok、Kimi、DeepSeek 或 GLM 就推测其工具或会话能力。

优点：保留统一产品心智模型，同时不牺牲 Codex 等原生运行内核的高级能力；新增 provider 不必复制整个会话产品。

缺点：Zeus 需要维护明确的 capability contract、组合状态和跨 adapter 验收矩阵；不同运行内核下的可用操作会存在真实差异。

### 会话与跨运行内核切换

Zeus 采用双层会话身份：产品会话身份由 Zeus 持有，Codex thread、Pi session 或未来 Claude session 的原生身份由对应 adapter
保留并与产品会话绑定。

已有 Codex 会话改用 Grok 时，不在原会话中静默更换 harness。Zeus 创建新的 Pi/Grok 会话，明确展示来源会话，并只带入用户确认的必要上下文；原
Codex thread、历史、审批和恢复能力保持不变。

优点：原生恢复语义可验证，不会把历史转换或摘要冒充 Codex/Pi 原生续接；失败时可回到原会话。

缺点：用户会看到两个会话；上下文承接需要定义选择、摘要、附件、代码状态和敏感内容边界，不能承诺无损迁移。

### 明确不采用

- 不把 Codex、Grok、Kimi、DeepSeek、GLM 和 Claude Code 当成同一层对象；前四类主要是模型供应源，Codex 与 Claude Code
  还包含原生智能体运行内核。
- 不让全部模型统一经过 Pi 后再宣称保持 Codex parity。
- 不在同一个原生会话身份上切换运行内核。
- 不用最低公共功能压平所有 adapter，也不使用未实现的功能占位制造一致性。
- 不因 Pi provider 列表存在条目就宣称 Zeus 已支持对应模型；必须经过凭据、目录、真实会话、工具、安全和恢复验证。

本次架构决策另见 `docs/adr/0004-多运行内核采用原生适配器与能力驱动界面.md`。

## 最终评价

原句作为“快速做出演示”的经验判断，有一定合理性；作为“产品级功能有保证”的技术判断，则过度乐观。

最核心的错误是把“成熟运行内核能抬高下限”偷换成“SDK 能兜底整个产品”。SDK 决定发动机的起点，产品级能力取决于整车系统。

## 资料来源

- [Pi SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi RPC 文档](https://pi.dev/docs/latest/rpc)
- [Pi Provider 文档](https://pi.dev/docs/latest/providers)
- [Pi Extension 文档](https://pi.dev/docs/latest/extensions)
- [Pi 会话格式](https://pi.dev/docs/latest/session-format)
- [Pi 开发与 fork 文档](https://pi.dev/docs/latest/development)
- [Claude Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Codex 开源仓库](https://github.com/openai/codex)
- [Codex 开源组件说明](https://learn.chatgpt.com/docs/open-source)
- [Codex App Server 协议](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [OpenAI：Codex App Server 与 harness](https://openai.com/index/unlocking-the-codex-harness/)

## 本次交付边界

- 已完成：命题澄清、官方资料核对、技术分层、Codex App Server 与 Pi RPC/SDK 对位比较、Zeus 现状核验、多运行内核方向确认、能力驱动界面与跨内核会话承接决策。
- 未执行：业务代码修改、运行时接入、真实 SDK 原型或端到端验证。

## 后续开发设计确认

后续澄清进一步确认：

- Codex 与 Pi 作为两套 Agent 明确区分；Pi 不冒充 Grok、Kimi、DeepSeek 或 GLM 的官方 Coding Agent。
- Pi 采用独立 RPC 子进程，故障不能直接影响 Zeus 执行宿主与 Codex 会话。
- 首个开发里程碑只搭公共框架，不接真实模型；Pi 默认对普通用户隐藏。
- 产品、接口与存储必须区分 Agent、模型供应源与具体模型，不能继续用一个 `provider` 表示三件事。

完整实施设计见 `docs/TASK_20260803_005_Zeus多运行内核公共框架开发设计.md`，补充架构决策见
`docs/adr/0005-Pi采用独立进程且公共框架默认隐藏.md`。
