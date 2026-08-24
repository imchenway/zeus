# TASK_20260824_002 统一多 Provider 会话恢复与任务推送修复

## 当前阶段

源码修复、完整正式门禁、独立测试包和隔离历史库 GUI 回归已完成。真实 Provider 网络续发尚未在本轮隔离桌面回归中执行，因此不能写成“正式版历史会话发送已验收”。用户已授权提交与正式发布；公开发布、安装版升级和发布后核验结果在本文末尾按实际证据追加。

## 问题范围

1. 重启后向历史 Codex 会话发送消息时，`account/read` 预检超时被误记为 Provider 已写入后的未知结果，消息无法安全重试。
2. 任务推送在 Codex CLI 从 `0.149.0` 升级到 `0.149.1` 后，因模型窗口精确版本表失配而在 Provider 写入前失败。
3. 任务推送首条提示词已落入本地 submission，但预检失败后没有进入会话时间线，界面只显示“正在思考”。
4. Provider 尚未接纳任何 turn 时，任务推送仍把任务/推送运行标成失败，混淆预检失败与模型执行失败。
5. Codex、Pi 与外部模型已经分别拥有部分持久化、幂等和恢复实现，但公共会话协调器尚未成为唯一派发水位与恢复语义来源。
6. 继续核对并收口此前反馈的 PLAN 卡片/进度恢复、非 PLAN 内容误标、会话状态噪音、运行指标分组布局和历史会话首帧。

## 统一设计

### 产品会话与 Provider 运行身份分层

- Zeus 产品会话是用户可见的长期身份。
- 执行段记录一次稳定的 Provider、模型、协议、版本与工作区路由。
- Provider 原生 session/thread 和 run/turn 只属于执行段，不能反向决定产品会话是否存在。
- Codex 使用原生 thread/turn 对账；Pi 使用 session/run 对账；无原生会话能力的普通模型使用 Zeus 可移植上下文重建。

### 派发水位

统一使用以下耐久状态：本地接纳、预检完成、Provider 写入开始、Provider 接纳、终态。鉴权、账号读取、模型能力读取、上下文编译和工作区准备都属于写入前阶段；只有适配器即将执行真实模型网络请求时，才能标记 Provider 写入开始。

### 恢复语义

- 写入前失败可以使用同一稳定命令身份安全重试。
- 已取得原生 turn/run 身份时恢复观察，不重放输入。
- 写入后结果未知时先通过 Provider 历史、同步游标或命令身份对账；不能证明未接纳时不自动重发。
- Provider 没有原生对账能力时，保留原消息并进入显式恢复，不伪装成原生续接。

### 显示与业务事实分离

- 本地 submission 一经接纳就以稳定 `clientUserMessageId` 投影用户消息；Provider 回显只做身份对账与补充，不能决定首条消息是否存在。
- 历史会话先显示本地权威投影或受控显示缓存，Provider 能力、目标和实时连接在后台渐进补齐。
- PLAN、请求、队列和发送能力必须等待最新交互权威层；正文可读性不被附属状态阻断。

## 方案优缺点

优点：

- Codex、Pi 和外部模型获得一致的不丢消息、不重复执行和可解释恢复语义。
- Codex CLI 小版本变化不再要求继续扩充精确版本硬编码。
- 用户消息、历史正文和 PLAN 显示不再依赖 Provider 当前是否可用。

缺点：

- 需要迁移 Codex/Pi 协调器中重复的水位和失败分类逻辑，改动跨 Core、Provider Adapter 与 Renderer。
- 普通无状态模型只能恢复 Zeus 可见上下文，无法恢复供应商内部未公开的推理状态。
- 旧的写入后未知回执必须继续保留审计，不能通过升级自动重放。

## 验证边界

- 不新增、恢复或执行单元测试体系。
- 执行目标格式检查、`git diff --check`、`pnpm lint`、`pnpm typecheck`、`pnpm build` 和 `pnpm package:mac`。
- GUI 只使用 `dev.hypha.zeus.test` 的独立 `Zeus Test.app` 与独立用户数据目录。
- 真实回归至少覆盖：未缓存历史首次打开、重启后发送、任务推送首条消息、预检失败可恢复、PLAN 切换/重启、多 Provider 路由与无连接失败噪音。
- 静态、构建、测试包和隔离 GUI 证据分别报告，不替代正式安装版或公开发布结论。

## 实现结果

### 写出水位与历史续发

- `ConversationDispatchCommandApplication` 支持由 Provider 适配器精确回报“真实写出开始”。账号读取、上下文预算、会话恢复和工作区准备失败统一归类为 `failed_before_write`，不再误报 `outcome_unknown_after_write`。
- Codex 只在真实 thread/turn RPC 前标记写出；Pi 只在 `openSession` / `startRun` / `steerRun` 前标记写出；旧 Runtime 输入和重连也保留精确边界。
- 写出前失败可使用同一稳定命令身份重试；写出后未知继续禁止自动重放。

### 任务推送首屏与模型预算

- submission 持久接纳后立即以 `clientUserMessageId` 投影用户消息，任务推送正文、附件、来源与布局元数据同步保留。
- Provider 回显按 `conversation_id + client_message_id` 对账同一条本地消息；多个 Provider item 身份写入独立别名表，不再覆盖逻辑消息主键或生成重复首条消息。
- 别名表迁移只创建结构和索引，不在应用冷启动时同步扫描历史消息。新消息即时登记，旧消息在再次对账时惰性登记，避免 5GB 历史库被迁移全表扫描阻塞。
- Codex Core 依次使用 app-server 实时目录、当前 CLI 受控 `models_cache.json` 和精确静态目录。缓存必须版本精确匹配、新鲜、为常规非符号链接文件且不超过 8 MiB。
- 当前 `0.149.1 + gpt-5.6-sol` 已从真实 CLI 缓存解析出 `272000` Token 窗口；伪造为 `0.149.0` 时精确返回不可用。

### Pi 与外部模型恢复

- Pi 初始会话先持久产品会话、submission 和本地用户消息，再编译上下文并打开 Provider session。
- Pi 历史续发、暂存队列和恢复共用同一本地投影与精确写出边界；带附件或浏览器上下文的 steer 会被明确拒绝并要求进入下一轮，不再静默丢弃资源。预检失败保留本地事实，不伪造 Provider 已接纳。
- 无原生恢复协议的外部模型继续使用 Zeus 持久上下文重建，不宣称能恢复供应商未公开的内部状态。

### PLAN、历史首屏与界面

- Renderer 不再把所有 `item_type=plan`、`final_answer` 或 `hasPlan` 过程记录猜成 PLAN 计划书。正式 PLAN 必须由 `conversation_plan_actions` 与 Provider plan item 精确关联，或携带明确 `formalPlan=true`；旧 Snapshot 只在存在精确“实施此计划”请求时重建。
- 保留 Snapshot V2、尾部水合、显示缓存和 PLAN 回退选择；切换会话后返回仍使用该 turn 最新正式 PLAN。
- 运行详情保持“一个分组一行、组内指标横向排列”，分组名称使用独立层级、字重和间距。
- 会话顶部不再显示历史“连接失败”运输状态；只保留需要用户处理的错误详情。

## 验证证据

### 机器门禁与行为探针

- 定向 Prettier、`git diff --check`、`pnpm lint`、`pnpm typecheck`、`pnpm build` 全部通过；只有已存在的 Vite 大分块提示。
- `pnpm package:mac` 通过，只生成 `/dist/test/mac-arm64/Zeus Test.app` 和测试 DMG；bundle ID 为 `dev.hypha.zeus.test`，ad-hoc 签名，没有 TeamIdentifier 与 Apple 公证。
- `pnpm verify:conversation-dispatch-command`、`pnpm verify:conversation-command`、Codex/Pi Provider command delivery、Renderer event flow、会话查询计划和 Test 启动快照探针全部通过：写出前失败可以建立 attempt 2，unknown 禁止重放，明确拒绝可重试，SQLite `quick_check=ok`。
- 独立数据库行为探针确认：同一 `client_message_id` 绑定两个 Provider item 后仍只有一条逻辑用户消息、两条别名，且 `conversations.updated_at` 单调递增。
- 没有新增、恢复或执行单元测试体系。

### 独立 `Zeus Test.app` 桌面回归

- 使用项目提供的一致性备份流程，把既有 Test QA 数据复制到 `/private/tmp/zeus-unified-recovery-provisioned.uyaCTh`；源库与目标库 `quick_check=ok`，目标身份固定为 `dev.hypha.zeus.test`。目标数据库为 5,080,981,504 字节，共 507 个会话。
- 首次真实冷启动发现同步回填别名会扫描大库并阻塞启动，已删除该回填。最终包重启后，桌面状态读取在 558ms 内得到完整工作台；这包含桌面控制采样，不等同于应用内部 FCP，但可确认没有“正在加载会话”空白壳。
- 打开正式 PLAN 历史会话后，正文、正式“计划”卡和输入框同时存在；切到另一会话再返回，三者仍完整，且两次切换均未出现“正在加载会话”。
- 打开普通过程计划历史会话时，仅保留 PLAN 模式开关，没有“计划”卡、计划操作或反馈按钮；正式 PLAN 会话则存在明确的“计划”卡及计划操作，证明分类不再依赖宽泛文本猜测。
- 展开运行详情后的可访问性结构中，“使用与费用”、“性能与活动”、“环境”分别拥有独立定义列表，组名与组内指标结构分离；组内视觉横排此前已在同一测试包中核对。
- 测试包退出后只读检查确认新迁移存在、别名行为表为空、507 个会话未被全量回填，数据库 `quick_check=ok`。
- 桌面回归显式禁用 Provider Runtime。尝试输入历史消息时不会绕过模型/Provider 可用性门禁，因此本轮不把它写成真实 Codex/Pi/外部模型网络续发已验收；写出边界和恢复语义由行为探针覆盖，真实 Provider 续发仍需单独隔离回归。
- 已准备通过“新建隔离 Codex 会话 → 首次发送 → 退出重启 → 同会话续发”补齐真实 Provider 证据；首次启动可用 Provider 的 Test 包时 macOS 会话锁屏，后续发布环境又检测到三块在线显示器，自动化无法保证测试窗口从一开始位于非主屏且全程不抢焦点。按发布桌面保护规则跳过新的点击验收，该项保持未验收，不以日志或行为探针冒充 GUI 结果。

## 遗留边界

- 无原生续接协议的模型无法保证恢复供应商内部推理状态，只能保证 Zeus 产品会话、消息与可移植上下文的一致。
- 正式升级发布前仍需在隔离 Provider 身份下完成一次“重启后向历史会话发送新消息”的真实端到端回归；当前代码与测试包证据不足以替代该项。
- 正式发布前没有对正式安装版和正式数据做任何变更。Apple Developer ID 签名与公证未配置；即使公开发布成功，也必须继续标记 `signed=false`、`notarized=false`。

## 正式发布证据

待发布完成后追加，不预填提交、标签、Workflow、公开资产或正式安装版结论。
