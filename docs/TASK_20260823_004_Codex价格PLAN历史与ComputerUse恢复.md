# TASK_20260823_004 Codex 价格、PLAN 历史与 Computer Use 恢复

## 目标

在既有 v0.3.37 会话过程、切换与加载回归修复基础上，继续收口用户现场发现的三类问题：

1. 原生 Codex 会话错误显示 DeepSeek 价格来源，费用字段不可用；
2. PLAN 确认进入开发阶段后，已批准计划从正文和历史轮次消失；
3. Zeus 真机验收长期无法使用 Computer Use，同时运行详情铺出大量没有真实证据的“不可用”字段。

本任务与 `TASK_20260823_002_Zeus会话过程与升级重启九项修复.md`、`TASK_20260823_003_历史会话纯记录视图修复.md` 同批发布。历史会话只读取本地持久记录，不自动恢复连接；用户在历史会话发送新消息时，才原地继续该会话。

## 根因

### Codex 被错误路由到 DeepSeek 定价

- 会话事实为 `transport_kind=codex_native`、`provider_id=codex`、模型 `gpt-5.6-sol`。
- 早期任务推送把原生 Codex 的保留来源写为 `modelSourceId=codex`；用量服务把任意非空来源都当作第三方连接，生成 `provider_id=api:codex` 并调用 DeepSeek 定价。
- 已执行过的旧迁移同样把 `model_source_id=codex` 迁为 `api:codex`，导致账本冻结了 DeepSeek 价格快照，费用覆盖率为 0。

### PLAN 只存在于摄取状态

- Provider 已完成计划保存在 `conversation_provider_item_states`，但部分事件没有 `turn/plan/updated`，所以 `conversation_turns.plan_json` 为空。
- 计划没有进入 `conversation_model_history`。确认实施后活动态内存清理，首屏短期补偿也只覆盖最近两个轮次；轮次继续增加后计划仍会再次消失。
- 正确语义是把已批准计划保留为原轮次正式历史产物，后续开发轮次不能替换或删除它。

### Computer Use 与“不可用”指标

- 仓库内没有 Zeus 自建 Computer Use 传输实现；历史失败来自 Codex 桌面环境的 Computer Use/Node REPL 桥接运行时，现场曾出现 `nodeRepl.createElicitation` 缺失、`process is not defined` 和原生管道启动超时。
- 当前桥接运行时已经可以加载 `@oai/sky` 并读取应用列表，说明该外部运行时已恢复；本任务用它验收独立身份的 `Zeus Test.app`，不把外部桥故障伪装成 Zeus 业务代码修复。
- 输出速率与首段延迟需要 Provider 请求时间点。现有历史只有精确 Token，没有完整 request id、首字节和完成时间，不能推测或用零补齐。

## 实现

### 定价身份和历史修复

- 把空来源和保留来源 `codex` 都归为原生 Codex；仅真实第三方连接 ID 使用 DeepSeek Responses 与定价。
- 新迁移排除 `model_source_id=codex`，避免再次生成 `api:codex`。
- 启动时幂等修复旧 `api:codex` 账本：保留模型、Token、Provider turn 与发生时间，按官方 Codex 价格重建估算并修复会话费用快照。
- 修复入口在只读验证模式禁用，不突破验证副本写保护。

优点：历史费用来源和覆盖率随账本事实一起恢复，不需要修改数据库公开结构。代价：这是 API 等价费用估算，不等于 ChatGPT 订阅实际扣款。

### PLAN 持久历史

- Provider 实时完成计划时，同时写入 `turn.plan_json` 和 `conversation_model_history`；历史快照恢复也走相同幂等投影。
- 对已有完成计划执行一次幂等回填，保持原 turn、submission、segment 和确认时间；计划分页身份追加，但 Renderer 按真实确认时间放回原轮次。
- Snapshot V2 仍兼容只收到 Provider item 或旧统一条目的历史；Renderer 将持久计划恢复为 `plan` 正式产物。
- 普通会话和历史会话统一投影持久计划，PLAN 确认后不再出现正文空档。

优点：计划与后续开发正文都保留，符合 Codex/OpenCode 的持久上下文语义。代价：旧数据库首次升级会新增一条计划模型历史投影，但不会修改 Provider 原始记录。

### 指标与 Computer Use

- 运行详情只展示有真实来源的输出速率、首段延迟和费用；缺失 timing 的字段不再铺“不可用”。
- Token、上下文占用、缓存命中、累计耗时、轮次、模型请求、工具/命令和失败轮次继续按真实持久数据展示。
- Computer Use 作为外部真机控制桥进行独立探测和 Test App 验收；正式 `/Applications/Zeus.app` 不启动、不替换、不安装。

## 行为探针

- 在正式数据库的 SQLite 备份副本上运行迁移与用量服务：`api:codex` 清零，原生 Codex 两轮保留，价格来源恢复为 OpenAI 官方页面，API 等价费用为 59.448769 美元，覆盖率为 100%。
- 同一副本的 Snapshot V2 同时恢复结构化轮次计划和可分页 `phase=plan` 历史产物，计划正文 2005 字符，仍属于原始 PLAN 轮次。
- 正式数据库未被探针修改。

## 验收记录

- 静态与构建：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`git diff --check`、`pnpm package:mac` 均通过；仅保留既有的大分块告警。测试产物为 `dev.hypha.zeus.test` 的 `Zeus Test.app`，版本 0.3.39，ad-hoc 结构签名且未公证。
- 数据边界：使用 4.7 GB 的正式数据迁移副本和只读验证清单；副本 `PRAGMA quick_check=ok`、SHA-256 与清单一致，Test App 不连接外部服务、不写副本。正式数据库和 `/Applications/Zeus.app` 未被测试实例打开或修改。
- 定价：真实 Codex 会话 `gpt-5.6-sol` 的摘要显示 API 等价费用，详情覆盖率 100%，来源只包含 OpenAI 官方 pricing、prompt caching、ChatGPT pricing 与 speed 页面；DeepSeek 来源和没有请求时序证据的速率/首段延迟行均消失。
- PLAN：原 PLAN 正文在确认实施后的历史中保持为正式计划产物；重新打包后展开该 PLAN 轮次，首个询问的 3 个选择、自定义“参考市面同类软件放出的指标”和第二次自定义“重要指标都需要，可以分为摘要和详情，部分放入详情”均只位于思考过程。
- 过程与切换：历史过程首次打开保持收起；打开后活动按“读取文件、搜索文件、运行了命令”以顿号分组，单条命令仍收起。从“推送任务后，报错”切到“做个 skill 管理…”再切回，标题、正文、PLAN 与展开状态都属于最终选中会话。
- 历史纯浏览：可访问性树中不存在“后续消息”“连接失败”“重新加载”“重新连接”“会话暂时未加载”和“实施此计划”；打开历史没有自动恢复实时连接。
- Computer Use：当前 Codex 桌面桥已能稳定加载 `@oai/sky`、列出应用、读取 Zeus Test 可访问性树、点击、滚动、切换会话、展开思考过程和正常退出。由此确认长期故障属于旧桥接运行时，当前现场已经恢复，不需要在 Zeus 仓库伪造一套替代实现。
- 启动性能：只读验证启动完成后窗口、Renderer 与本地服务正常；关闭时 Test Main 和独立执行宿主均正常退出。只读模式阻止附件预览 IPC 属于验证隔离能力，不是正式历史浏览错误。
- 未覆盖：隔离 Test 根没有独立 Codex runtime / 登录态，因此没有真实发送一条 Provider 第二轮消息；代码路径会在用户首次发送时从 lazy 历史态切到 required 水合并复用原 conversation/provider thread，类型、构建和同会话身份已验证，但真实 Provider 续接仍需有独立认证的 Test 根。

## 发布边界

- 用户已明确授权提交、推送和发布下一补丁版本。
- 发布后复核 `origin/main`、不可变标签、Release Workflow、GitHub Release、DMG、manifest、Homebrew Cask、SHA-256 与签名/公证字段。
- 不替用户安装升级，不启动或替换正式 Zeus。

## v0.3.40 发布结果

- 功能提交：`5c934f2db100`；候选格式提交：`b066420669a3`；发布提交和不可变标签 `v0.3.40`：`60f63bfb394db353d09cdcbefa31cda34e3aa04c`。
- `origin/main`、标签、GitHub Release 和 Release Workflow 已独立回查；Workflow <https://github.com/imchenway/zeus/actions/runs/32638564206> 的四个作业均为成功。
- 从公开 Release 重新下载的 DMG `Zeus-0.3.40-arm64.dmg` 为 112178044 字节，SHA-256 `d02d6c0750cdcbfba68493bbeb18dfbaca3dd49d6ade60bf51160e547c31c73e`，`hdiutil verify` 通过；manifest 与 Homebrew Cask 的版本、下载地址和摘要一致。
- 公开 manifest 为 1047 字节，SHA-256 `e6569975de8f4f2ab4a65fdb5b5ce364523ad57e413be197652c806cb3b1682d`，字段为 `signed=false`、`notarized=false`。
- GitHub Release：<https://github.com/imchenway/zeus/releases/tag/v0.3.40>。本次没有安装升级，也没有启动或替换 `/Applications/Zeus.app`。
