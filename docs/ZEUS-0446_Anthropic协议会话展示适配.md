# ZEUS-0446 Anthropic 协议会话展示适配

## 任务目标

梳理 Zeus 多供应商、多模型会话从输入、语义路由、Provider 执行、响应摄取、统一存储到 Renderer 展示的完整链路，定位中转 Opus 会话内容混排的根因，并实现与 Zeus 现有会话展示一致的 Anthropic 协议适配。

架构图交付物：`docs/ZEUS-0446_多供应商多模型会话完整设计.html`。

## 已确认事实

- 供应商、模型、协议和运行时是四个独立维度。会话提交会把 `runtimeKind`、`connectionId`、`endpointIdentity`、`protocolFamily`、`modelId`、`credentialSlotId` 与执行设置冻结到 execution snapshot。
- 用户附件包含 70 条 JSONL、236,328 字节。32 条 assistant 消息中有 16 个 `thinking` block、30 个 `text` block 和 33 个 `toolCall/tool_use` block。
- Anthropic 原始结构已被 Pi 正确解析为 `thinking/text/toolCall`；问题不是 JSON 解析失败，也没有证据表明中转改变了本样本的基本 content 结构。
- 修复前，`TurnProcessProjector.projectPiEvent()` 只记录 `provider: 'pi'` 和原始 block，没有保留 `protocolFamily` 或可用于展示归组的 `stageId`。
- 修复前，`piNativeConversationCoordinator.handleRuntimeEvent()` 在处理 assistant 文本摘要前先投影 process item；同一 native run 的多次 assistant `message_end` 又共用 `pi_message_${nativeRunId}`。
- 修复前，`ConversationTranscript` 按阶段摘要出现顺序递增 ordinal，并以此推断工具活动归属。该规则适配现有 Codex 事件顺序，但不能无损恢复 Anthropic 单次 message 中 `thinking + text + tool_use` 的关系。

## 根因结论

根因位于 **Pi 标准事件进入 Zeus 会话语义投影** 的边界：

1. Anthropic 协议身份和消息阶段身份没有进入 process、model history、Provider item 与 Snapshot V2 的共同展示契约；
2. assistant 消息使用 run 级身份，工具续接产生的多条 assistant message 可能覆盖或互相冒充；
3. thinking/tool 先于阶段摘要落库，Renderer 只能通过摘要顺序反推阶段，导致内容跨阶段串位；
4. 原始 thinking 与用户可见阶段说明没有独立展示层级，完成会话容易显得像把思考过程当作正文展开。

空 `thinkingSignature` 可能影响 Anthropic 工具续接时的协议重放，但不能解释当前 stage 归属、身份复用与落库顺序问题，不纳入本任务的展示优化方案。

## 已实施设计

- 在现有 Pi 投影中贯穿协议族与展示阶段，仅对 `protocolFamily === 'anthropic_messages'` 的 `thinking` 启用“思考详情”语义，不创建第二套 Transcript。
- 每条 assistant message 使用消息级稳定 `stageId/providerItemId`：优先 Provider message ID，缺失时回退 `nativeRunId + event.sequence`。
- Anthropic 内容映射：
  - `toolUse + text` → 阶段说明；
  - `thinking` → 同阶段“查看思考详情”，默认收起；
  - `tool_use/toolCall` → 同阶段工具活动；
  - 正常 terminal `text` → 唯一最终回答；
  - `error/aborted` → 错误过程，不生成最终回答。
- Pi process detail、Provider item payload、model history content 同时保留 `protocolFamily` 和 `stageId`。
- Snapshot V2 model-history、process、active-item 增加同名可选字段并刷新 structure generation；旧历史通过 segment 对应的 execution snapshot 推导协议，并为同一旧 message 的项目生成只读阶段回退，不重写数据库。
- Renderer 对带 `stageId` 的项目优先显式归组；旧记录和没有阶段语义的其他 Provider 沿用现有时序投影。
- 相邻阶段说明仅做规范化空白后的精确去重，不使用模糊相似度隐藏内容。

## 实施结果

- `TurnProcessProjector` 现在把冻结的 `protocolFamily`、消息级 `stageId` 与 Anthropic thinking 的 `reasoningPresentation` 写入过程详情；`error/aborted` 文本只生成失败过程，不生成最终回答。
- `piNativeConversationCoordinator` 以 Provider `responseId/message.id` 生成消息级身份，缺失时回退 `nativeRunId + event.sequence`；工具调用通过 `toolCallId` 继承所属阶段。阶段摘要、Provider item、conversation message、model history 和实时事件使用同一身份。
- Snapshot V2 的 model-history、process、active-item 已增加可选 `protocolFamily/stageId`，结构 generation 更新为 `2026-09-03-conversation-stage-identity`。旧 Anthropic 历史只从 execution snapshot 和完全相等的事件时间推导，不迁移数据库。
- Renderer reducer 同时接纳快照与实时字段；Transcript 优先按 `stageId` 归组。Anthropic 思考保留在同阶段“查看思考详情”中，使用原生 `details` 默认收起，只有用户展开截断详情时才读取全文。
- 相邻阶段摘要只做规范化空白后的严格相等去重；Codex、OpenAI-compatible Pi 与 DeepSeek 的 reasoning 展示规则未全局改变。

## 方案取舍

优点：在协议边界一次修复根因；实时与冷启动历史共享语义；不影响 Codex、OpenAI-compatible Pi 和 DeepSeek；不需要历史数据迁移。

代价：Snapshot V2 需要增加两个可选字段并同步结构 generation、Storage/Renderer 类型和 adapter；Anthropic 分支需要维护明确内容映射。

明确不采用：CSS 隐藏 thinking、全局折叠所有 Pi reasoning、传输层空签名开关、模糊文本去重或并行 Transcript。

## 架构图验证记录

- `vibe_diagram_lint.py`：通过，状态为 `artifact-static-valid`。
- `git diff --check`：通过。
- Zeus 内置浏览器：设计阶段与代码实施后再次打开 `file://` 均在原生工具层超时；此前的 localhost、`list_tabs` 与高级 catalog 也未返回，尚未取得布局、缩放、详情弹窗或三视口证据。
- 产品阅读审查：需在浏览器恢复后关闭全部技术详情，仅凭摘要和主图回答输入路由、响应回流、根因与推荐修复四个问题。
- Client runtime：推荐代码已经实现并完成静态与构建验证；尚未进行真实 Anthropic Provider 与 Zeus Test.app 运行验收。

## 实现验证记录

- `pnpm install --frozen-lockfile --offline`：成功；仅出现本地 workspace CLI 尚未构建的临时 bin 警告，随后完整构建已生成对应产物。
- `pnpm exec prettier --check ...` 与 `git diff --check`：通过。
- `pnpm typecheck`：通过，包含架构治理检查与全仓 TypeScript 构建图检查。
- `pnpm lint`：通过。
- `pnpm build`：通过；Renderer 构建只报告既有第三方 `markstream-react` PURE 注释与大 chunk 警告。
- `pnpm exec tsx scripts/verify-renderer-event-flow.ts`：通过，既有 Snapshot、分页、实时事件、队列与重连行为未回归。
- 内存 SQLite Snapshot 探针：通过；新记录的 model-history/process 均返回显式 `stage-new`，旧 Anthropic 记录均返回相同的 `legacy:segment:timestamp`，验证新增 SQL 与只读回退可实际执行。
- 附件 JSONL 只读探针：32 条 assistant message 中，31 条正常消息均有唯一 Provider 消息身份；16 个 thinking 阶段、31 个工具阶段，最后 1 条 error 消息按新规则不会冒充最终回答。
- 未执行：真实 Anthropic 中转请求、Provider 续接、`Zeus Test.app` 打包与 GUI 验收；因此本次完成状态不宣称运行层已验收。

## 本地 main 合入记录

- 2026-09-04 按用户授权，将任务提交 `87785993` 定向合入本地 `main`，未执行 push 或 stash。
- 合入前本地 `main` 与 `origin/main` 同为 `0fbb4dfa`，工作区干净且没有未完成的合并。
- 三方合并仅在 QA 页面产生冲突：保留 `main` 已收缩的 `session-core-qa.tsx`，并保留 `main` 对旧 `session-recovery-qa.tsx` 的删除。任务分支在这两处仅更新已被淘汰夹具的结构代际常量，运行时、存储和 Renderer 修复均完整保留。
- 合并态重新通过 `pnpm typecheck`、`pnpm lint`、`pnpm build`、Renderer 事件流探针、Prettier、未解决冲突检查与双重 diff 检查；构建仍只有既有第三方 PURE 注释和大 chunk 警告。
- 真实 Anthropic Provider 与 `Zeus Test.app` GUI 运行验收仍未执行，不随本地合入状态扩大结论。
