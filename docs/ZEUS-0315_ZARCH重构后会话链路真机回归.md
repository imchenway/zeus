# ZEUS-0315 ZARCH 重构后会话链路真机回归

## 当前阶段

修复与真机回归中。已把 `8346d704886bce369b58ef5f51dada570c651289`（`feat: 完成 ZARCH 架构收尾与在线验收`）确定为回归起点。External
Command 写出边界、派生 operation identity、Codex 二进制版本证据、终态恢复竞态、重复错误归属、用户消息双投影、工具分页、Plan
实时事件、Renderer 重载对账与统一队列队首派发均已修复；真实 Codex 新建、同线程续聊、冷启动恢复、在线发送、工具、Plan、交互请求、审批、活动切换和
Renderer 重载已通过，当前重新打包并回归原队列失败现场。

## 用户要求

- 真机验证该重构开始造成的所有会话链路问题。
- 发现的问题直接修复，并在最新测试包上重新回归。
- 验收必须覆盖真实 macOS 窗口和真实 Provider，不以静态检查、构建或打包代替。

## 回归边界

- 起点提交：`8346d704886bce369b58ef5f51dada570c651289`。
- 当前候选：`main` `c32873fc9a460cf9df6df933e8e256b2c568d46f` 加工作树中尚未提交的计划确认恢复修复。
- 既有问题主链：
    - `TASK_20260822_001`：冷开水合、耐久事件游标、WebSocket 身份、重连闪烁和重复错误弹窗。
    - `TASK_20260822_003`：工具调用误进正文、精确模型上下文窗口。
    - `TASK_20260822_004`：会话切换、历史自动加载、长句柄正文、空闲连接、配置与计划恢复、Core 交接。
    - `TASK_20260822_005`：待处理计划确认未随 Snapshot V2 恢复，导致后续消息永久排队。
- 正式 `/Applications/Zeus.app`、正式用户数据和正式 Provider 凭据只作为只读来源；运行验收只允许 `dev.hypha.zeus.test`
  和独立数据根。

## 真机回归矩阵

1. 应用冷启动、Core 附着、首个项目和会话树显示。
2. 大历史会话冷开、Snapshot V2 水合、历史正文与工具结构投影。
3. 多会话快速切换、返回原会话、侧栏运行态不残留假转圈。
4. 顶部自动续载更早历史、滚动锚点和长正文/工具结果按需展开。
5. 空闲历史不建立实时连接；发送消息时自动建立唯一连接。
6. 真实 Codex 新轮次的发送、排队、流式过程、工具调用、最终答复和空闲释放。
7. PLAN 模式计划持久恢复、计划确认卡片、实施/修订动作和被门禁的后续消息。
8. `request_user_input`、审批/权限请求及处理后的会话继续能力。
9. 活动时断开/恢复、连续事件水位、重复弹窗去重和页面不闪烁。
10. 退出、重启、同一会话恢复和 Provider 原生身份连续性。

## 方案取舍

- 使用隔离可写 Test 根连接真实 Provider。
    - 优点：能覆盖真实命令接纳、Provider 输出、耐久事件和重启恢复。
    - 缺点：会产生少量真实模型调用；不能代表正式安装版已经发布。
- 对正式历史使用经过身份绑定的只读副本，另建少量可写验收会话。
    - 优点：大历史与真实交互都能覆盖，同时不写正式库。
    - 缺点：只读历史会话本身不能执行写请求，写链路必须在独立新会话验证。
- 对无法稳定人工制造的异常同时保留产品行为探针和真机可见结果。
    - 优点：能确定性覆盖事件缺口、缓冲溢出等低概率边界。
    - 缺点：探针只作为补充，不能替代窗口证据。

## 操作边界

- 不新增或恢复单元测试体系，不采用 TDD。
- 未经用户明确要求，不执行 git commit、push、merge、revert 或正式发布。
- 只生成和启动 `Zeus Test.app`；不生成、启动或登记仓库内生产身份 `Zeus.app`。

## 阶段证据

- 既有记忆只覆盖隔离 Provider 的 device authorization 与 app-server handshake，且当时测试包仍在重建；该证据不计为本轮真机回归通过。
- 当前工作树已有 `TASK_20260822_005` 的计划确认恢复修复，尚未提交；本轮将保留并在真实会话链路中一并验证。
- Renderer 事件流行为探针通过：计划请求 `plan-request` 随首屏恢复，队列保持 `plan_confirmation`
  ，只建立一次实时连接；空闲历史零连接、发送时唯一建连、活动水位 `483` 订阅、空闲释放、缺口补偿和溢出恢复均通过。
- Conversation Command、Dispatch Command、Codex Provider Delivery、Runtime Command 与三级事件耐久探针通过，`unknown`
  路径保持禁止自动重放。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm verify:zarch-gates` 全部通过；ZARCH `failedCheckIds=[]`。
- `pnpm package:mac` 通过，只生成 `dist/test/mac-arm64/Zeus Test.app` 与测试 DMG；包为 `0.3.34`、`dev.hypha.zeus.test`
  ，严格代码签名结构验证通过，ad-hoc 签名且未公证。

## 第一轮真机故障证据

- 未登录时，无 Provider RPC 发生，但 Graph/Conversation 外层命令在进入内部会话协调器前就记录了 External Write Marker，导致明确的
  `ZEUS_CODEX_LOGIN_REQUIRED` 被错误升级为 `outcome_unknown_after_write`，同一草稿随后被禁止重试。
- 登录后真实会话与 submission 已持久创建，submission 因 `ZEUS_CONTEXT_MODEL_WINDOW_UNAVAILABLE` 安全暂停。运行中的
  app-server `initialize` 没有返回版本，现有精确版本目录因此无法命中；`/api/agents` 也显示 `adapterVersion=null`。
- 会话创建的 Graph 命令把原始重连 id 派生为新的 `graph_conversation_operation_*`，服务端 acceptance 正确回传派生
  identity；普通会话创建器却仍拿原始 idempotency key 比较，因而把真实 `status=accepted` 判成“不存在持久接纳”。任务推送路径已经显式携带
  operation identity，不受此错误影响。
- 一次项目会话创建失败同时被创建器、本地 choice load state 与全局 `recordLocalError`
  三个出口上报，真机连续出现“新会话创建失败”“会话读取失败”“本地操作失败”三个弹窗。

## 本轮修复取舍

- 会话首发使用手动 External Write Marker，只在内部幂等层即将发起真实 Provider RPC 时标记。
    - 优点：登录、参数、上下文预检等 RPC 前失败会准确记录为 `failed_before_write`，可以安全修正后重试。
    - 缺点：会话创建命令需要把写出生命周期显式贯通到 Graph 外层，接口比统一的“调用前标记”更复杂。
- Renderer 显式接收 Graph 命令派生 operation identity，并同时校验原始本地 envelope 与服务端 acceptance。
    - 优点：不伪造服务端 identity，也不改变已经发布的派生算法，避免旧 pending envelope 升级后生成第二个外部操作。
    - 缺点：会话创建 client 的返回值从裸 acceptance 变为带 identity 的 dispatch result。
- app-server 未报告版本时，以同一真实可执行文件的 `--version` 输出作为后备证据。
    - 优点：继续保持“精确 CLI 版本 + 精确模型”匹配，不用系列名猜窗口。
    - 缺点：每个新运行世代增加一次最长 5 秒、通常瞬时完成的只读进程探测；探测失败仍会关闭派发。
- 创建失败由创建器唯一上报，choice 列表恢复 ready 且保留草稿。
    - 优点：一次事实只出现一个可查看详情的弹窗，不把创建失败伪装成历史读取失败。
    - 缺点：后台创建入口仍需保留自己的非创建器错误出口，不能全局删除错误记录。

## 第二轮真机故障证据

- 修复后的 `Zeus Test.app` 使用真实 Codex 新建会话成功，Graph/Conversation acceptance 不再被误判；Provider 原生线程
  `01a027e6-e0c7-7cf3-991e-f0677295aa0c` 和原生轮次 `01a027e6-e120-7a53-a8c7-565f71ba1f73` 均已持久绑定。
- Provider 原生 JSONL 在 `2026-08-22T05:17:51Z` 明确记录助手答案 `ZEUS-0315-FIXED-NEW-OK` 与 `task_complete`；Zeus 本地
  `conversation_turns` 也记录为 `completed`，用户和助手消息均已入库。
- 同一 submission 却在 Provider 完成前四秒的 `05:17:47.544Z` 被 `thread/turns/list` 的 30 秒超时改成
  `paused/recovery_required`。终态事件到达后，现有收口只扫描 `dispatching/active`，没有纠正同一 `provider_turn_id`
  上已经被辅助同步误暂停的 submission；会话状态因此保持 paused，真机界面隐藏已入库正文并显示运行失败。

## 第二轮修复取舍

- Provider turn 已有精确接纳身份后，历史分页同步属于可恢复的投影补充，不能覆盖实时 turn 事件的更强终态证据。
    - 优点：辅助读取超时不会把仍在运行或已经完成的真实 Provider 写入伪装成派发未知。
    - 缺点：同步失败仍需保留持久 warning，历史补投影要等后续重连或重启继续，不能静默丢失诊断证据。
- 终态收口允许纠正同一 `provider_turn_id` 且先前仅因 `recovery_required` 暂停的提交，但仍要求首提交身份或精确 Provider
  用户消息身份成立。
    - 优点：迟到的 `turn/completed` 可以把更早、较弱的超时判断收敛为真实完成。
    - 缺点：不能把所有 paused submission 一概完成；缺少精确送达证据的引导消息仍保持人工恢复门禁。
- 第一次带终态恢复的新包启动时，数据库修复已经执行，但恢复函数在 Core 发布控制面之前广播队列事件，调用了尚未初始化的
  `toNativeQueueApiSnapshot`，Execution Host 以 `ReferenceError` 退出。
    - 修复：启动恢复只提交持久状态，不发送尚无 Renderer 可以消费的实时事件；首次窗口统一从 Snapshot 读取修复结果。
    - 优点：消除初始化时序依赖，持久事实与首屏结果一致。
    - 缺点：启动恢复不再保留一条无人消费的瞬时队列广播；诊断仍由启动日志和持久状态承担。

## 第三轮真机故障证据

- 同一现场重启后，原失败会话无需 Provider 重放即自动恢复：侧栏失败标识消失，正文显示原用户消息与 `ZEUS-0315-FIXED-NEW-OK`
  ，submission、turn、conversation 分别收敛为 `completed`、`completed`、`ready`。
- 在同一真实 Provider 线程续聊只执行一次并返回 `ZEUS-0315-CONTINUE-OK`，但用户消息永久显示两个气泡。数据库只有一个
  submission、一个 turn、一条用户 model history 和一条旧消息投影，证明是 Renderer 合并重复而非 Provider 或 Core 双写。
- 实时 Provider user item 带 `clientId`，能接管乐观气泡；随后 Snapshot V2 model history 只有 `submissionId`，Adapter
  没有把该身份写进条目 payload，Snapshot 水合无法关联现有气泡并新建第二条。实时接管时的 payload 合并还会丢失原有
  `submissionId`，进一步切断关联。

## 第三轮修复取舍

- Snapshot V2 用户历史条目显式携带已有 DTO 中的 durable `submissionId`，Renderer 同时按 client id 或 submission id
  复用已有用户气泡；实时 user item 接管时保留 submission id。
    - 优点：不改数据库、不按文本或时间猜重，排队、实时 Provider item、Snapshot 历史三种投影共享稳定身份。
    - 缺点：迁移历史若本来没有 submission id，仍只能使用其既有 model-history 身份；这种数据没有当前乐观气泡，不会触发本次重复。
- 新 generation 冷开时 Provider 会重放历史 user item；事件携带 client id，原 Snapshot V2 历史却只有 submission
  id，首次修复仍无法让两种投影相认。
    - 修复：Snapshot V2 通过 model history 已有 `submission_id` 只读关联 submission 的 `client_message_id`
      ，同时返回两种耐久身份；Adapter 把 client id 投影为用户条目的稳定身份。
    - 优点：实时发送、后台 Snapshot 和 Provider 重放都按事实身份合并，不受事件到达顺序影响。
    - 缺点：纯迁移历史没有 submission 关联时 client id 仍为空，但它也没有对应的实时本地发送态。

## 第三轮修复后真机结果

- 最新 `Zeus Test.app` 冷开同一真实 Provider 线程后，首发与续聊各只有一条用户气泡和一条助手气泡，Provider 历史重放没有再复制用户消息。
- 在同一窗口继续发送 `只回复 ZEUS-0315-LIVE-DEDUPE-OK，不调用工具。`，运行中与完成后用户消息始终各只有一条；Provider 只返回一次
  `ZEUS-0315-LIVE-DEDUPE-OK`，会话回到 `ready`。
- 运行详情正常刷新为 `61,857 Token`、缓存命中率 `65.4%`，上下文占用显示 `20,827 / 258,400 Token`
  ；这只证明当前真实轮次的运行数据与精确模型窗口投影，不代表所有交互链路已经完成回归。

## 第四轮代码审计发现

- 新建会话与消息发送都在本地持久保存业务幂等身份，但 Renderer 的 Graph/Conversation 和 Conversation Dispatch 外层 Command
  Envelope 仅缓存在进程内 `Map`。
- 页面重载或 Renderer 重启后，同一待恢复业务动作会复用原 `idempotencyKey`，却重新生成 `commandId` 与 `issuedAt`。Core 的
  `command_inbox` 正确要求同一 scope 幂等键必须对应字节级相同 Envelope，因此这种跨进程恢复会被判为
  `ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT`。
- 这不会造成 Provider 自动重放，但会让本应安全恢复的待接纳创建或待确认发送在重启后永久卡在外层幂等冲突；下一步把不含正文的完整
  Command Envelope 与 reconnect identity 一起落入 Test/正式各自的本地存储，并保持相同正文哈希校验。

## 第四轮修复取舍

- Graph/Conversation 与 Conversation Dispatch 在存在 reconnect identity 时，先把不含业务正文的完整 Command Envelope 写入
  Renderer 的本地存储；同一身份再次构造时校验 canonical input SHA-256，并逐字节复用原 `commandId`、`issuedAt` 与 payload。
    - 优点：业务 envelope 与外层 Command Envelope 都能跨 Renderer 重启保持一致，不改变 Core 对 scope 幂等冲突的严格拒绝语义。
    - 缺点：每条尚未被权威 Snapshot 确认的发送多一条小型本地记录；确认耐久或明确恢复到输入框后才清理，不能在 HTTP 返回瞬间提前删除。
- 新建会话的业务 envelope 先删除成功，再释放对应外层信封；消息发送则在权威 submission/Provider user fact 到达后释放。
    - 优点：任何崩溃点都只会留下可安全复用的旧信封，不会留下“业务待恢复但外层身份已丢”的窗口。
    - 缺点：极端的本地存储删除失败会残留无正文旧信封，但其 identity 不会复用，不影响新动作。

## 第五轮真机故障证据

- 真实 Codex 在同一线程调用 `/bin/pwd`，Provider JSONL 只有一个 `custom_tool_call`，Zeus 数据库也只有一个
  `conversation_process_items`；最终答复 `ZEUS-0315-TOOL-OK` 与 turn completed 均已耐久。
- 首次真机展开“查看处理过程”后，界面却出现两条“运行了命令”，最终答复消失，会话从 `ready` 被降回“正在处理”。根因是按需
  process 页基于较早的 active Snapshot 构建，却使用普通 `snapshot_hydrated` 全量重置 Renderer；这张页不拥有后来实时到达的
  turn terminal 与 final answer 事实。
- 同一工具的实时 Provider item 使用 Provider item id，process 页使用本地 process id，Adapter 没有携带 `source_event_id`
  中已有的 Provider item identity，因此两种投影无法合并。
- 最新 Test 包修复后，冷开会话仍显示最终答复，展开过程后保持 `ready`，命令活动只剩一条；完整命令与输出只在按需详情中出现，没有进入助手正文。
- 同一轮第一次从“查看轮次详情”加载 process 页后，行结构会从普通最终答复变成 `turn_work`，展开状态原先绑定旧 render
  key，导致加载完成立即自动折叠，需要第二次点击。
- Model History 没有直接返回 `conversation_messages.metadata_json.phase` 与 Provider item id，冷开后 commentary
  `我现在运行 /bin/pwd。` 被 Adapter 默认当成 `final_answer`，错误显示复制、赞踩等最终答复动作。

## 第五轮修复取舍

- 新增专用 `snapshot_v2_page_merged`：分页只合并展示条目和游标，保留较强的实时终态、最终答复、队列、交互请求和运行状态；同
  Provider item identity 的实时项与 process 项合成一条。
    - 优点：历史/过程/资源按需加载不会回退事件水位或覆盖新事实；工具行不再双投影。
    - 缺点：分页不是权威删除边界，不能借分页清掉当前实时项；真正删除仍由完整 Snapshot 或明确事件负责。
- Process DTO 从 `source_event_id` 返回 Provider item id；Model History 通过同轮次、同确认时间和同正文只读关联已有
  `conversation_messages`，恢复 Provider item id 与 phase。
    - 优点：不用猜文本角色，现有历史也能恢复 commentary/final 语义；新旧投影共享稳定 Provider 身份。
    - 缺点：极旧迁移数据若没有对应 `conversation_messages`，phase 仍为空，Adapter 只能沿用保守默认。
- 过程展开状态统一绑定 `turn-process:<providerTurnId>`，不再绑定加载前后会变化的 transcript render key。
    - 优点：第一次点击加载完成后继续保持展开。
    - 缺点：同一轮只允许一个共享的过程/详情展开状态，这是当前一轮一个 disclosure 的界面约束。

## 第六轮真机故障证据

- 最新 Test 包冷开工具会话后，commentary 已折叠进处理过程，不再显示为第二条最终答复；一次点击即可稳定展开，结构化命令只有一条，
  `ZEUS-0315-TOOL-OK` 与 `ready` 状态均保留。
- 真实 Plan 模式会话成功生成两步只读计划，数据库已经持久创建 `conversation_plan_actions.status=pending`
  ；但同一窗口的实时界面没有出现“实施此计划”确认卡，切到其他会话再返回后才从首屏恢复确认卡。
- 终态投影先发布 `conversation.turn.completed`，Renderer 立即判定会话空闲并释放 WebSocket；
  `conversation.plan_implementation_request.changed` 在后面才发布，实时窗口存在错过确认动作的竞态。冷恢复能显示，证明持久事实正确，缺口仅在实时事件顺序。

## 第六轮修复取舍

- Plan 轮次终态持久化完成后，先发布计划确认请求，再发布轮次完成与队列变化。
    - 优点：实时 Renderer 在收到 idle 终态前已经持有阻塞交互，不会提前释放连接；冷恢复与实时路径共享同一耐久请求。
    - 缺点：界面会先观察到确认请求、随后观察到轮次完成，两个事件之间存在极短的“计划待确认且轮次仍 active”过渡态，但不会触发
      Provider 执行或自动排空队列。
- 完整退出并重启 `Zeus Test.app` 后，原 Plan pending 首屏恢复且普通 Composer 被阻断；修订动作也真实生成新 Plan 轮次与下一张
  pending 确认卡。
- 修订/实施动作解除旧 pending 后，Renderer 的空闲释放会关闭原 WebSocket；动作成功回调只读取并应用一次 active Snapshot，没有像
  approval/RUI 回答路径一样重新建立事件流。Core 的工具、最终答复和 `turn completed` 共 36 个后续增量都已经耐久，界面仍永久停在“正在处理”。
- 计划动作成功水合后，若权威 Snapshot 仍有 active/queued/waiting 轮次或新的 pending 计划确认，则强制从该 Snapshot
  水位重建实时订阅。
    - 优点：implement、refine 和新确认卡都不依赖旧连接是否仍存活，补拉只接收权威水位之后的事件。
    - 缺点：需要继续实时跟踪的计划动作会多一次 Snapshot 水合与 WebSocket 握手；纯 dismiss 的空闲结果不重连。

## 第七轮真机结果与故障证据

- 修复包的新 Plan 终态实时显示确认卡；实施后 `/bin/pwd` 只执行一次、退出码为 0，最终正文即时显示，会话回到 `ready`，协作模式固定切回
  Default。
- `request_user_input` 在 Plan 模式真实显示 A/B 选择卡，选择 A 后同轮继续并只返回 `ZEUS-0315-RUI-A`；只读权限模式下 `/tmp`
  写命令真实显示审批卡，“允许一次”后只返回 `ZEUS-0315-APPROVAL-OK`。
- 发送 `ZEUS-0315-RENDERER-RELOAD-OK` 后 15 毫秒执行 Renderer 重载，Provider 用户消息与最终答复都只有一条，未出现
  `ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT`；证明业务身份和外层 Command Envelope 已跨 Renderer 复用。
- 重载发生在 HTTP acceptance 返回前时，本地 pending envelope 仍是 `sending`。启动水合只对账 `accepted` envelope，虽然
  Snapshot 已经存在同 client identity 的 submission/Provider 消息，Composer 仍残留原正文并保持发送按钮可用。

## 第七轮修复取舍

- 启动对账覆盖所有 pending envelope；权威 Snapshot 已有同 client identity 时，从耐久 submission 派生 acceptance，再清空
  Composer、删除 pending 记录并释放外层 Command Envelope。
    - 优点：HTTP 返回前崩溃与返回后崩溃都能收敛到同一耐久事实，不给用户留下误重发入口。
    - 缺点：启动水合需对 pending envelope 多做一次 submission/Provider user identity 查找。
- Snapshot 仍没有耐久事实时保持 pending 输入和原信封，不自动调用 Provider。
    - 优点：继续遵守未知写出禁止自动重放，用户可在看见原草稿后显式重试。
    - 缺点：真正发生在 Core 接纳前的崩溃不会自动继续，必须由用户再次发送。

## 第八轮真机结果与故障证据

- Renderer 重载修复包再次在发送后 15 毫秒重载，`ZEUS-0315-RELOAD-FIXED-OK` 的用户消息和最终答复均只有一条；Composer
  没有残留草稿，发送按钮保持禁用，数据库没有外层命令幂等冲突。
- 活动轮次发送 `ZEUS-0315-SWITCH-ACTIVE-OK` 后 30 毫秒切走，900 毫秒后返回；最终答复只有一条、会话回到 `ready`
  ，切换期间没有重复派发或假运行态。
- Default 模式正确阻止 `request_user_input`；Plan 模式真实显示 A/B 选择卡并在选择 A 后只返回 `ZEUS-0315-RUI-A`。只读权限真实显示
  `/usr/bin/touch` 审批卡，允许一次后只返回 `ZEUS-0315-APPROVAL-OK`，临时文件已精确删除，权限恢复为自动。
- 真实队列测试先发送带 `/bin/sleep 4` 的首条消息，活动期间追加第二条；界面正确显示一条等待消息，首条只返回一次
  `ZEUS-0315-QUEUE-FIRST`，但第二条没有自动派发，被暂停为 `recovery_required`。
- 数据库证明第二条 submission 已在首次接受时耐久创建，身份为 `conversation_submission_IA-JO_YGOHL-`，idempotency key 为
  `bf5dd2d9-44d7-422f-a916-1ca68debe2ac`，且带统一执行快照。队首排空又调用普通 `submitMessage`，该入口重新构造 payload
  并尝试以相同 idempotency key 创建提交；请求哈希不同，存储层在 Provider 写入前明确拒绝，错误为 `Idempotency key conflict`。

## 第八轮修复取舍

- Codex 协调器新增窄范围的 `dispatchQueuedMessage` 内部入口：只接受已存在、状态为 queued 且具有冻结执行快照的
  submission；统一队首排空直接复用原 submission、原 request hash 和原 client identity。
    - 优点：排队接受、执行快照和 Provider 派发保持同一条不可变审计链，不再把旧队首伪装成新提交，也不会放宽存储层幂等冲突门禁。
    - 缺点：协调器公开端口多一个仅供统一队列使用的内部方法；调用方必须先构造与冻结快照一致的 segment lifecycle。
- 没有采用“让 `createOrGet` 忽略 payload 哈希差异”或“排空时生成新 idempotency key”。
    - 优点：保留相同身份不同正文必须拒绝的安全约束，也不会让同一用户消息产生第二个 Provider 操作。
    - 缺点：修复不会在应用启动时擅自重放已经暂停的提交；明确写入前失败的旧队首会恢复到 Composer，必须由用户显式再次发送并获得新身份。

## 第九轮真机回归结果

- 修复包冷启动没有自动重放旧失败队首；原 submission 保留审计后变为 `deleted`，正文恢复到 Composer。显式点击发送后创建新
  submission、新 idempotency key 和新 Provider turn，只返回一次 `ZEUS-0315-QUEUE-SECOND`，会话回到 `ready`。
- 全新自动队列使用 `/bin/sleep 4` 建立活动轮次，再加入第二条：界面先显示“后续消息（1）/当前回复结束后按顺序自动发送”，随后只返回一次
  `ZEUS-0315-QUEUE-FRESH-FIRST` 与一次 `ZEUS-0315-QUEUE-FRESH-SECOND`；两条 submission 均 completed、各自绑定不同 Provider
  turn，队列自动清空且无幂等冲突。
- Steer 边界回归覆盖两种时序：较短窗口中 Provider 已产生基础答复但 turn 尚未终态，补充引导仍绑定同一个 provider turn 并追加
  `ZEUS-0315-STEER-OK`；20 秒活动窗口内引导在命令执行中送达，同一 provider turn 最终只返回 `ZEUS-0315-STEER-LIVE-OK`。
- 数据库交叉验证：20 秒活动轮次的主 submission `conversation_submission_e2ksAluukevR` 与补充 submission
  `conversation_submission_lo0n6fD-fRO0` 均绑定 `01a02829-654f-7112-aadc-dae5055b0719`，不存在第二个 turn；两者随该 turn
  一起收敛为 completed。

## 第十轮冷启动故障证据与修复取舍

- 完整退出并重启 Test 应用后，20 秒 Steer 轮次的两条 Codex 可读思考摘要被显示成带复制、赞踩操作的独立助手正文；实时阶段没有这些错误气泡，数据库
  `conversation_messages` 也只包含用户消息、commentary 和最终答复。
- `conversation_model_history.content_json` 保存了 `provenance=Codex 可读思考摘要`，`reasoning_source_json` 同时保存
  `readableSummary=true` 与 Provider item id；但 Snapshot V2 为限制首屏体积只投影 `content_json.text`，原有 Adapter 再从纯文本猜
  `provenance` 必然失败，于是冷启动把摘要默认归类为 `agentMessage/final_answer`。
- Snapshot V2 Model History DTO 现在显式返回 `reasoningSummary`，Provider item id 优先使用已有消息关联，缺失时从
  `reasoning_source_json.itemId/providerItemId` 补齐；Renderer 以该耐久语义字段归类为 `reasoning/prework`，仅保留旧结构化正文的
  provenance 识别作为兼容兜底。
    - 优点：分页截断、纯文本投影、冷启动和过程页合并都不再依赖正文格式猜测；同一 reasoning item 仍可按 Provider identity
      与过程投影合并。
    - 缺点：Model History DTO 增加一个布尔字段，旧服务端与新 Renderer 必须继续依赖 provenance 兼容路径；该路径只覆盖旧服务端仍返回结构化正文的情况。
- Renderer 行为探针已覆盖“纯文本摘要 + 显式 reasoning 身份”：摘要投影为 `reasoning/prework`，工具内部 JSON 不进入正文，最终答复仍为唯一
  `agentMessage/final_answer`。该探针只证明代码路径，仍需下方重新打包后的冷启动窗口验收闭环。

## 第十轮冷启动真机结果

- 最新 `Zeus Test.app` 使用同一独立 Test 数据目录完整退出后冷启动，进入原真实 Provider 会话后状态为“已就绪”；
  `Implementing non-blocking wait intervals` 与 `Waiting for command completion` 在主正文中的可见计数均为 0，
  `ZEUS-0315-STEER-LIVE-OK` 仍作为最终答复保留。
- 第一次点击同轮“查看处理过程”后保持展开且会话仍为“已就绪”；过程区只有一条“运行了命令”，详情为 `/bin/sleep 20`、
  `exitCode=0`、`durationMs=19876`，没有生成第二个命令条目或吞掉最终答复。
- 可见 commentary `正在执行指定的等待命令；若期间收到补充引导，将据此调整最终答复。`
  正确归入过程区；两条可读思考摘要不再获得复制、赞踩和“展开消息”等正式答案操作。
- 因此本轮新发现的冷历史语义丢失已完成代码、行为探针、重新打包、完整退出冷启动和真实历史 UI 五层闭环；正式安装版仍未发布，也未被本次验收启动或覆盖。

## 最终门禁补充

- 首次最终 `verify:zarch-gates` 报告唯一失败项 `internal-side-effect-coverage`：精确 Codex 版本后备探测新增的
  `codexRuntimeGenerationManager.ts:nodeSpawn` 没有进入内部副作用 capability 清单。该失败不改变已观察到的 Provider
  结果，但证明架构治理尚未闭环，因此未按“全通过”处理。
- 已把该 generation-scoped、只读、最长 5 秒的 `nodeSpawn` 及其超时 `child.kill` 一并登记到 `provider_process_generation`
  policy；同时扩展动态发现规则，使以后该文件新增任意 `kill` 调用也必须有精确 capability，未知调用继续失败关闭。
    - 优点：不是为了消掉单条错误而只登记 spawn，超时终止边界也进入同一身份、恢复和回执治理。
    - 缺点：现有 `provider_process_generation` policy 同时覆盖 Provider 生命周期与只读版本探测，语义范围较宽；后续若增加更多只读二进制探测，可再拆成专用只读
      probe policy。

## 最终交付核验

- 完整 ZARCH 门禁在补登记后重跑通过：`status=passed`、`failedCheckIds=[]`；其中内部副作用审计发现 137 个调用点、74 项
  capability，`violations=[]`。
- 最终 `pnpm typecheck`、`pnpm lint`、Renderer 会话事件行为探针与 `git diff --check` 均通过。行为探针同时确认：纯文本
  reasoning 身份保留、工具内部 payload 不进入正文、process 页不回退终态、Plan/请求恢复、空闲零订阅、活动水位续订、空闲释放、事件缺口与双重缓冲溢出恢复。
- 最后一次包含运行时代码的 `pnpm package:mac` 已完成完整 workspace build、Test 应用与 Test DMG 生成；`Zeus Test.app` 为
  `0.3.34`、bundle ID `dev.hypha.zeus.test`，`codesign --verify --deep --strict` 通过，签名仍为 ad-hoc 且未公证。
- 独立 Test 数据库 `PRAGMA quick_check=ok`。主验收会话共有 19 条 completed submission、1 条为保留旧失败审计而 deleted，17 个
  turn 全部 completed；unresolved submission、unresolved turn、pending plan action、pending server request 均为 0。
- 队列最终答复 `ZEUS-0315-QUEUE-FRESH-FIRST`、`ZEUS-0315-QUEUE-FRESH-SECOND` 和活动 Steer 最终答复
  `ZEUS-0315-STEER-LIVE-OK` 在 assistant messages 中均精确为 1；活动 Steer turn 只有 1 条 completed command process，2 条
  completed reasoning process。
- 最终冷启动日志没有 `ReferenceError`、未处理异常、执行宿主启动失败或 Command Delivery 幂等冲突；仅有 Test 包无权设置 macOS
  登录项的系统错误，不影响窗口、Core 或 Provider，会话仍显示“已就绪”。
- 最终 `Zeus Test.app` 已通过菜单安全退出；隔离 `CODEX_HOME` 已从“Logged in using ChatGPT”执行 logout，复核为“Not logged
  in”且 `auth.json` 已删除。
- 正式 `/Applications/Zeus.app` 及其 Execution Host 的 PID 从本轮开始到结束保持 `60684/60694`，没有被覆盖、重启或用于验收。未执行
  commit、push、merge、revert，也未生成正式发布候选。

## 结论与边界

- 从 `8346d704886bce369b58ef5f51dada570c651289` 重构边界开始，本轮在代码审计、真实 Provider、真实工具、真实交互卡、Renderer
  重载、会话切换、自动队列、Steer、完整退出冷启动和耐久数据库交叉验证中发现的会话链路问题均已修复并回归通过。
- 旧的未登录、未绑定或故意失败的负向验收会话仍保留原 paused/failed 审计事实，没有被伪造为成功；它们不属于当前已就绪主验收会话的未完成队列。
- 当前完成层级为“源码修复 + 静态/架构门禁 + 本地 Test 构建 + 独立 Test 真机/真实 Provider 回归”。正式安装版尚未发布、Apple
  Developer ID 签名和公证尚未执行，因此不能把本轮结果表述为正式用户安装版已经修复。
