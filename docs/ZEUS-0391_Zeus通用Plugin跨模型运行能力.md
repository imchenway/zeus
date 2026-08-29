# ZEUS-0391 Zeus 通用 Plugin 跨模型运行能力

## 已确认需求

- Zeus 自有 Plugin 注册表与运行宿主兼容当前公开的 `.codex-plugin/plugin.json`，覆盖 Skill、Hook、`.mcp.json`、`.app.json`、展示资产与 MCP App UI。
- 安装来源为本地目录、Git 仓库及本地/Git Marketplace；不预装 Ponytail 或任何第三方 Plugin/Skill，不代理 OpenAI 官方公共目录。
- 安装后默认启用并从新会话开始生效；现有会话冻结 Plugin 修订。所有 Zeus Runtime Adapter 消费同一个 Plugin 身份、版本与能力快照。
- Hook 信任完全对齐 Codex：信任当前 Hook 定义哈希，定义变化后重新审查；被引用脚本内容变化但定义不变时不重新确认。
- 浏览器扩展与定时任务模板不在本任务范围；不创建 Zeus 私有清单字段。
- 一次性交付，不在 Skill、Hook、MCP/Connector、MCP App UI、Codex/Pi 投影和管理入口全部完成前开放半成品。

## 领域边界

- **Plugin**：由 Zeus 安装并持有不可变修订的能力包；Manifest 只声明公开字段，不拥有项目、任务或产品会话。
- **Plugin 安装**：把受检来源复制到 Zeus 缓存并登记稳定身份、来源、版本和内容摘要；安装不执行 Plugin 内容。
- **Plugin 启用**：使某个安装修订进入新会话的能力快照；不热更新既有会话。
- **Plugin 激活快照**：新会话冻结的 Plugin 身份、版本、摘要、组件路径和连接策略；模型切换、恢复与 Runtime Adapter 变化不得漂移。
- **Hook 信任**：对规范化 Hook 定义哈希的显式授权；它不是对整个 Plugin 内容摘要的授权。
- **Connector**：由 Plugin 引用、由 Zeus 绑定到本地或远程 MCP 连接的外部能力；认证与 Plugin 安装分离，密钥只进入 Keychain。
- **Provider legacy Plugin**：仅存在于 Provider 自己目录的历史 Plugin；Zeus 不删除、不自动启停，同名通用 Plugin 不得与它双重执行。

## 产品语义

- “安装一次、所有模型可用”表示 Codex App Server 与 Pi SDK 会话都从 Zeus Plugin Host 获取同一目录、Skill、Hook 与 MCP 工具；模型或 Provider 真实拒绝工具调用时保留原错误与能力证据，不提前猜测、不自动重发。
- Plugin 安装成功与 Connector 已连接是不同状态。无法解析的 `.app.json` 显示“需要连接”，不伪装成安装失败或工具可用。
- Plugin 可隐式使用，也可通过 `@Plugin` 或 `@Skill` 明确选择；Renderer 只提交稳定身份，Core 在接纳边界解析并冻结真实修订。
- 同名 Plugin 或组件不静默覆盖；跨来源冲突必须明确选择。卸载不自动删除可复用 Connector 授权。

## 实现阶段记录

### 2026-08-29 需求冻结与现场核对

- 当前 Zeus 已有跨 Codex/Pi 的 Zeus Skill Catalog 与单 Skill 运行时投影，但没有 Plugin 注册表、Marketplace、Hook Host 或通用 MCP Broker。
- Codex 会话已有 dynamic tools；Pi SDK 当前只注册固定文件/命令工具，且 ResourceLoader 明确不加载扩展。跨模型 Plugin 必须由 Zeus 统一投影，不能依赖两个 Provider 分别读取 Plugin。
- MCP 现状主要是 Codex 原生事件与审批投影；Pi 没有任意 MCP 工具注册入口。内置 Browser dynamic tools 也只注入 Codex。
- Zeus 已有 Keychain 抽象和数字员工调度器，但本任务不复用调度器导入未公开的定时任务模板格式。
- OpenAI 当前公开打包入口为 `.codex-plugin/plugin.json`，可引用 Skills、Hooks、`.mcp.json`、`.app.json` 与资产；UI 和认证属于 MCP 集成。
- 当前工作树为 `zeus/ZEUS-0391-skill-zeus-01`，开始实施前无未提交改动。

### 2026-08-29 Plugin 数据与安装边界

- 新增 Zeus-owned Plugin 注册、不可变修订、Marketplace、Hook 定义哈希信任、Connector 绑定、MCP 工具策略和会话激活集合账本；空 Plugin 集合也有显式冻结证据，恢复时不会误吸收后来安装的 Plugin。
- Plugin bundle、Plugin 可写数据与安装/Hooks/MCP 临时现场分别进入 `data/plugins/bundles`、`data/plugins/data` 与 `runtime/plugins`，并同步更新 ZARCH-003 数据权威和生命周期矩阵。
- 安装器已实现本地、Git ref/Git 子目录与 Marketplace 来源隔离复制；拒绝根/内部符号链接、路径逃逸、特殊文件、体积/节点超限、来源复制竞态、无效 JSON、未知组件与重复名称。
- 当前公开 Manifest 组件已解析为统一快照：Plugin Skills、官方 Hook 事件与 command/mcp_tool handler、可解析但跳过的 prompt/agent handler、stdio/HTTP MCP、`.app.json` 注册连接和展示资产。
- Provider 原生同名 Plugin 只读识别为 legacy 冲突；Zeus 安装保持禁用并阻止重复启用，不删除或改写 Provider 内容。
- 本阶段架构门禁和 TypeScript 全量检查通过：105 张 Core 表均具有机器 owner 与文档生命周期记录。

### 2026-08-29 统一运行宿主与产品入口

- 新增 Zeus Plugin 生命周期事件总线与 Hook 命令执行器：安装/启用不授予信任，按 Hook 定义哈希审查，支持逐 Hook 禁用、官方事件与 Matcher、前台并发、后台上限、超时、阻断/改写/审批/继续语义，以及 `PLUGIN_ROOT`、`PLUGIN_DATA` 和兼容环境变量。危险绕过只能通过显式启动参数启用，并在扩展管理页持续警示。
- 新增同一 MCP Broker：本地 stdio、远程 HTTP、Keychain Bearer、Plugin/Server 工具命名空间、服务器及工具级审批、Tool Schema/元数据复验、Codex dynamic tools 与 Pi custom tools 均消费同一目录。Provider 真实拒绝工具时只记录能力证据，不自动重发或降级。
- 新增沙箱 MCP App 容器：只允许脚本沙箱、严格 CSP 与来源/权限白名单，通过受控 JSON-RPC Host Bridge 调用会话冻结快照内且对 App 可见的工具。
- Codex 与 Pi 已统一接入 Plugin Skill、Hook、MCP 与恢复/压缩生命周期；会话首发先校验结构化 Plugin/Skill 稳定 ID，再冻结修订、内容摘要、组件路径及策略。模型切换、恢复和跨 Adapter 续接不重新解析当前安装目录。
- “Skill 管理”升级为“扩展管理”，保留独立 Skill，并增加 Plugin、Marketplace、组件、Hook 信任、Connector、工具策略和更新/卸载入口；会话 `@` 选择器显示作用域、来源与安装身份。
- 同名 Plugin 的唯一约束已由名称改为“作用域 + 名称 + 来源身份”：相同来源阻止重复安装，不同来源允许并存；纯文本歧义会拒绝，选择器提交的稳定身份可明确选择其中一个来源。
- 本阶段再次通过 `pnpm typecheck` 与 `pnpm lint`；真实安装源、运行时、制品及 GUI 验收仍按下方门禁继续。

### 2026-08-29 隔离运行与制品验证

- 在 `/tmp/zeus-0391-validation.m8BAqq` 创建不随产品交付的安全 Plugin 与 Marketplace，真实完成本地目录、Git 根、Git ref、Git 子目录、个人本地 Marketplace 和项目 Git Marketplace 安装；同来源重复安装被拒绝，同名不同来源可并存且要求稳定身份选择。
- Hook 验证覆盖：未信任跳过、信任后执行、`PLUGIN_ROOT`/`PLUGIN_DATA`、上下文注入、工具阻断和输入改写、PostToolUse 结果阻断、停止语义、超时、SessionEnd；仅脚本内容变化时沿用定义信任，Hook 定义变化时重新进入审查。
- MCP 验证覆盖：本地 stdio 与本机远程 HTTP 工具调用、Bearer 凭据从 SecretStore 投影、服务器/工具级拒绝策略、断连 Connector 显式故障及 MCP App HTML/元数据读取；卸载 Plugin 后 Connector 授权仍保留。
- 生命周期验证覆盖：更新后活动会话继续引用旧修订；卸载活动 Plugin 后冻结修订和安装路径仍可恢复；Provider legacy 同名安装被标记为不兼容并保持禁用。
- 安全失败验证覆盖：未知 Manifest 字段、目录逃逸、符号链接、失效 Git ref 和非法 SessionEnd Hook 超时均返回明确错误，不静默忽略。
- MCP App Host Bridge 不从 `file://` Renderer 直接拼接相对 API，而是经 Zeus 现有的 Bearer transport 调用；历史只读态和没有交互端口时拒绝工具调用，避免绕过认证或把失败伪装成可交互。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`git diff --check` 与 `pnpm package:mac` 均通过。打包只生成测试身份 `dist/test/mac-arm64/Zeus Test.app` 和测试 DMG；`CFBundleIdentifier=dev.hypha.zeus.test`，包体健康检查、严格签名结构校验和 `hdiutil verify` 通过。构建仅保留既有 Markstream Rolldown annotation 与大 chunk 警告。
- 在独立 `/tmp/zeus-0391-gui.uppVy7` 数据根真实启动测试包，首窗日志确认 `targetDisplayId=3` 且 `actualDisplayId=3`。GUI 已完成本地 Plugin 安装、组件展开、Hook 定义信任、Connector“需要连接”、MCP 策略、Plugin 内 Skill 合并目录、Marketplace 入口以及新会话 Plugin/Skill 稳定身份选择器检查；未读取、复制或覆盖正式 Zeus 认证和业务数据。
- GUI 检查完成后发现并修正了 MCP App Bridge 的认证 transport 缺口；修订后的最终包已重新通过全部静态、构建和制品门禁。准备二次启动最终包时，ZEUS-0385 再次持续占用相同测试身份；本任务没有关闭、复用或接管该实例，因此最终修订的二次 GUI 启动仍待该身份释放。
- 独立数据根没有可复用的 Provider 登录，且本任务没有复制正式凭据；因此“当前每个已启用模型”的真实 Provider 回复矩阵、Provider 拒绝工具 Schema 的现场错误及最终 MCP App iframe 工具回调仍保留为现场未验，已有结论仅覆盖 Zeus Host、Adapter、Broker、Renderer 与隔离协议场景。

### 2026-08-29 本地合入冲突处理

- 在来源分支 `main` 创建的持久合入 Worktree 中，以 merge 方式合入 `zeus/ZEUS-0391-skill-zeus-01`；完整索引冲突清单仅包含 `SessionWorkspace.tsx`，同时审计了两分支共同修改且由 Git 自动合并的会话 Renderer、Reducer、类型与 Codex Coordinator。
- `SessionWorkspace` 同时保留 main 对 `interaction_authority_missing` 的输入只读门禁，以及本任务为 Composer 增加的项目作用域与 Plugin/Skill 目录加载入口；共同修改文件继续同时承载 main 的交互恢复/思考态校正与本任务的 Plugin、MCP App 事件和工具链路。
- 合入候选通过冲突文件与任务文档 Prettier、`pnpm lint`、架构治理、全量 TypeScript、`pnpm build` 与 `pnpm package:mac`；测试包 bundle ID 为 `dev.hypha.zeus.test`，严格深层签名和 DMG 校验通过，仅保留既有 Markstream annotation 与大 chunk 警告。
- 最终 Git 门禁确认 50 个合入文件全部暂存、未暂存文件为 0、未合并文件和未合并索引项均为 0，且候选基线仍等于当前本地 `main`；`MERGE_HEAD` 保留为任务分支提交。本阶段不创建提交、不更新来源分支、不切换分支且不推送远端。
- 本阶段没有重新启动 GUI 或执行真实 Provider 回复矩阵；任务分支原有 GUI 隔离证据和已明确保留的现场未验边界不因静态、构建或制品通过而升级。

## 验收门禁

- 静态与制品：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`。
- 使用独立临时目录创建不随产品交付的安全 Plugin，覆盖本地、Git、Git 子目录、个人 Marketplace 和项目 Marketplace。
- 验证 Hook 未信任跳过、信任后执行、定义变化重新审查、工具阻断/改写、审批、超时与结束事件。
- 验证本地/远程 MCP、Connector 绑定、工具审批、MCP App UI、修订冻结、更新、卸载和错误边界。
- 使用 `dev.hypha.zeus.test` 的独立 `Zeus Test.app` 与独立 `ZEUS_USER_DATA_DIR` 做真实 GUI 验收；不读取、复制或覆盖正式 Zeus 认证和业务数据。
