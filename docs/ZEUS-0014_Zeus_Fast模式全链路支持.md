# ZEUS-0014 Zeus Fast 模式全链路支持

## 目标

Zeus 以 Codex app-server `model/list` 返回的 `serviceTiers[].id = "priority"` 作为 Fast 的唯一能力事实，把用户请求、实际下发和 Provider 实际采用的服务档位分开记录。用户的显式选择按项目和模型身份持久化；不支持 Fast 时会话继续按 Standard 运行，并在会话内留下明确、可恢复的系统提示。

Fast 不改变模型，也不改变 reasoning effort。Standard 固定下发 `serviceTier: null`，Fast 固定下发 `serviceTier: "priority"`。

## 当前差异

- 现有运行链路已经解析 `model/list.serviceTiers`，并在 `thread/start`、`turn/start`、Provider 设置与用量快照中携带 `serviceTier`。
- 现有界面仍会根据 `fast` ID 或显示名称猜测 Fast，未严格限定为 `priority`。
- 速度偏好混在按项目和会话类型划分的 `localStorage` 中，且 Standard 可能在用户未操作时被自动写入。
- 已知不支持的服务档位会被静默归一化为 Standard，没有可持久化的会话提示。
- 下一轮选择和 Provider 实际采用的档位尚未形成独立、完整的历史事实。

## 已确认决策

- 偏好粒度为项目和模型身份；同名模型使用模型来源 ID 区分。
- 偏好保存在后端项目配置中，只有用户显式选择 Standard 或 Fast 时才写入。
- 不迁移旧 `localStorage` 速度值；既有会话已经持久化的下一轮设置继续兼容。
- 自动降级不改写 Fast 偏好；每次实际降级都追加一条与提交绑定的持久系统提示。
- 新模型没有偏好时使用 Standard，但不因此产生偏好记录。
- 不新增数据库列，不新增或恢复单元测试体系。

## 实施记录

### 2026-08-15 需求与现状核对

- 本机 `codex-cli 0.147.0` 的生成协议包含 `model/list.serviceTiers`、`thread/start.serviceTier`、`turn/start.serviceTier`、线程恢复响应与设置通知中的 `serviceTier`。
- 隔离 `model/list` 探针显示当前支持 Fast 的 Codex 模型声明目录 ID `priority`，不支持模型的 `serviceTiers` 为空。
- 项目配置当前保存在本地服务端设置 JSON 中，适合扩展项目模型速度偏好，无需数据库迁移。

### 2026-08-15 实现

- 项目配置新增 `serviceTierPreferences`，记录模型来源 ID、模型 ID 与用户显式选择；专用接口按单模型原子覆盖并写入审计。普通项目配置保存主动忽略这张表，避免旧界面快照误覆盖。
- Renderer 的任务推送、项目会话、既有会话、冲突处理和代码审查统一读取项目模型偏好。旧 `localStorage` 速度值不再读取或写入，模型、推理强度、权限和工作模式等旧偏好继续兼容。
- 恢复会话时 Provider 原有设置只作为历史实际事实展示；没有项目偏好和旧下一轮速度记录时，下一轮固定回到 Standard，不会把上一轮实际 `priority` 反向当成用户意图。
- Fast 能力与下发只接受精确 `priority`；Standard 始终为 `null`。模型目录名称、`fast` 别名和其他速度字段不参与判断，服务档位不会修改模型或 reasoning effort。
- 提交输入 JSON 保存 `requestedServiceTier`，调度上下文保存实际下发的 `serviceTier`，Provider 设置与用量快照保存 app-server 实际档位；未新增数据库列。
- 明确的 service-tier 不支持错误只允许按同一提交、同一客户端消息和同一正文以 `null` 重试一次。超时、断线、进程退出和不明确错误不进入该分支。
- 已知不支持、app-server 明确拒绝、Provider 实际采用 Standard 三类降级都记录到提交 JSON，并在对应用户消息落库后追加系统提示。提示使用提交 ID 与原因生成稳定 Provider item ID，刷新和恢复时去重，不冒充智能体回答。
- 模型设置界面把下一轮意图与 Provider 实际档位、计费用量档位分开。已记住 Fast 但模型失去能力时显示“Fast（已记住，当前不可用）”，实际继续按 Standard，下层偏好不被自动改写。

## 验收记录

### 静态门禁与构建

- `pnpm install --frozen-lockfile --offline`：通过，未修改锁文件。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、本次变更文件 Prettier 检查和 `git diff --check`：通过。构建只有既有的大分块提示。
- 没有新增或恢复单元测试、组件测试、DOM/CSS 契约测试或测试依赖。

### 当前 app-server 协议探针

探针直接启动本机 `codex-cli 0.147.0` app-server，使用临时 cwd 与临时 thread：

- `model/list` 中 `gpt-5.6-sol` 精确声明 `serviceTiers=["priority"]`；`gpt-5.4-mini`、`gpt-5.3-codex-spark` 返回空列表。
- Standard 的 `thread/start` 与 `turn/start` 均存在 `serviceTier: null`，Provider 初始实际档位为 `default`。
- Fast 的 `thread/start` 与 `turn/start` 均为 `serviceTier: "priority"`，Provider 初始实际档位为 `priority`。
- 两轮都使用 `gpt-5.6-sol` 和 `medium` reasoning，没有通过换模型或降低 reasoning 冒充 Fast。

### 真实 Local Server、真实 Provider 与持久化

使用本轮构建的 Local Server、真实 app-server、独立临时数据库与临时项目执行：

| 场景 | 结果 |
| --- | --- |
| 项目模型偏好 | 模型甲保存 Fast、模型乙保存 Standard；专用审计 2 条；未操作模型无记录；普通配置保存无法清空偏好表 |
| 重启恢复 | 关闭并用同一隔离数据库重建 Local Server 后，两条偏好原样恢复 |
| Fast | 正常回答；提交请求 `priority`、调度下发 `priority`、Provider 设置与用量均为 `priority` |
| Standard | 正常回答；提交请求 `null`、`turn/start` 下发 `null`、Provider 设置与用量均为 `default` |
| 已知不支持 | `gpt-5.4-mini` 请求 `priority`，`thread/start` 与 `turn/start` 均下发 `null`；正常回答；设置与用量均为 `default` |
| 降级提示顺序 | 真实不支持场景中持久顺序为用户消息、系统提示、智能体回答；系统提示时间严格晚于对应用户消息 1 毫秒 |
| 刷新去重 | 同一提交多次读取仍只有一条 `model_unsupported` 系统提示 |
| 模型与推理强度 | 三种真实场景均保持请求模型；Fast 与 Standard 均保持 `medium` reasoning |

SQLite 只读复核确认提交输入的三层事实：Fast 为请求 `priority`/下发 `priority`，Standard 为请求 `null`/下发 `null`，已知不支持为请求 `priority`/下发 `null`。

### 隔离拒绝与实际降档探针

这两种边界不能要求真实 Provider 稳定制造，因此使用实现同一 app-server Manager 契约的隔离假 Provider 驱动完整 Local Server、提交仓储和会话投影，不写测试文件：

- 明确拒绝：首次 `thread/start(priority)` 返回 `-32602` 且明确指出 service tier 不支持；Zeus 只追加一次 `thread/start(null)`，`turn/start` 只执行一次并为 `null`，客户端消息 ID 与原正文保持唯一，轮次正常完成。提示原因是 `app_server_rejected`，刷新后仍为一条。
- Provider 实际降档：`thread/start(priority)` 与 `turn/start(priority)` 均只执行一次，Provider 设置返回 `default`；Zeus 不重试，轮次正常完成，设置与用量均记录 `default`。提示原因是 `provider_reported_standard`，刷新后仍为一条。
- 两个场景的模型均为原模型、reasoning 均为 `medium`，没有发生替换或降低。

### 测试包与真实桌面边界

- 最终源码重新执行 `pnpm package:mac`：通过，只生成 `dist/test/mac-arm64/Zeus Test.app` 与测试 DMG；`CFBundleIdentifier=dev.hypha.zeus.test`。
- 包健康检查输出 `rendererAssets=19`、Main、两个 Preload、更新助手均存在；当前打包策略为 `codex=user-installed`。严格 codesign 校验通过，属于本机 ad-hoc 签名，不等于 Developer ID 或 Apple 公证。
- 在最终恢复默认与提示顺序收紧前，曾使用独立 `ZEUS_USER_DATA_DIR` 启动本任务测试包；首帧真实窗口边界为 `x=-1196, y=-269, 1100×820`，完整位于非主外接竖屏 ID 3。这条证据只证明隔离身份、独立资料目录和外接屏首帧，不作为最终源码的功能 GUI 证据。
- 启动后发现系统中同时运行其他任务的多个同 bundle ID `Zeus Test` 实例。为避免界面操作归属失真，已只关闭本任务 PID 46319，没有继续点击或截图。因此 Fast 控件、跨入口切换和应用重启后的真实 GUI 恢复未宣称通过。
- 最终源码测试包生成后再次确认仍有 3 个其他任务的同身份实例运行，因此没有启动最终包，也没有干扰这些实例。
- 新建测试资料目录没有可复用的 Zeus Test Provider 登录；正式包内的 Provider 实际采用链路未验。真实 Provider 设置与用量链路由前述隔离 Local Server 探针覆盖，不能替代打包应用身份验收。

### 正式候选校验

- `pnpm verify:release`：通过；发布前门禁、12 节 139 项验收矩阵、生产构建、临时正式候选结构、DMG、Homebrew cask、发布清单与包健康检查均完成。
- 当前环境没有配置 Developer ID，正式候选只完成本机 ad-hoc DMG 签名校验，没有 Apple 公证；这是校验脚本明确报告的发布环境限制。
- 临时正式候选没有启动，没有向 macOS 登记额外生产身份应用，也没有执行生产发布。

## 尚未完成的真实验收

- 需要在没有其他同 bundle ID 测试实例运行、并具备独立 Zeus Test Provider 登录的环境中，补做 Fast 控件真实点击、模型切换、不同会话入口、应用冷重启、会话恢复与打包身份下 Provider 实际档位检查。
- 该缺口不影响静态构建、真实 app-server 协议、真实 Local Server/Provider、持久化与降级重试结论，但本任务不因此宣称“测试包 GUI 全链路通过”。

## 2026-08-16 本地合入冲突处理

- 当前命名冲突开发线从本地 `main` 创建，并以 merge 方式合入 `zeus/ZEUS-0014-zeus-fast-01`；本阶段只解决并暂存冲突，保留 `MERGE_HEAD`，不创建提交、不更新来源分支、不推送远端。
- 会话运行详情同时保留本地 `main` 的缓存未命中与本轮费用字段，以及任务分支的 Provider 实际服务档位；用量归档继续保留模型来源身份，但计价使用 Provider 实际档位，不使用用户请求档位冒充实际事实。
- 会话条目分类同时保留助手交付图片与服务档位降级提示；Provider 用量快照校验同时接受 `serviceTier` 与 `lastApiEquivalentUsd`，并分别复验字符串和非负有限数。
- 合入后重新执行变更源码格式检查、`pnpm lint`、`pnpm typecheck`、`pnpm build` 与暂存差异空白错误检查，结果均通过；构建仅保留既有的大分块提示。本阶段没有重新打包或启动 GUI，不把静态检查与构建结果宣称为真实运行验收。
- 最终复核要求 `git diff --name-only --diff-filter=U` 与 `git ls-files -u` 均无输出、工作区不存在未暂存改动，并确认 `MERGE_HEAD` 仍指向任务分支待合入提交。

## 2026-08-28 合入 test 前的 main 重构适配

- 当前候选分支先合入本地最新 `main`。最新主线已把 Renderer、Local Server 与 Storage 拆成有边界的模块，本阶段按新边界重新移植项目模型速度偏好、各会话入口、请求/下发/Provider 实际档位、用量计费档位和降级提示，没有恢复旧巨型入口结构。
- 新增 `codexServiceTierDowngrade` 专属应用模块；协调器保持在 4000 行架构上限内。自动降级仍只接受明确的 service-tier 不支持证据，同一提交只回退一次，模型和推理强度不变，项目 Fast 偏好不被改写。
- 任务推送、项目新会话、既有会话、代码审查和冲突处理统一读取“项目 + 模型来源 + 模型”的偏好；Provider 上一轮实际档位不再反向成为下一轮意图。运行详情分别展示 Provider 实际档位与用量计费档位。
- 已执行 `pnpm install --frozen-lockfile --offline`，未修改锁文件；`pnpm lint`、`pnpm typecheck`、`pnpm build` 与本次变更文件 Prettier 检查通过。构建只保留既有的大分块提示。
- 本阶段尚未提交当前 merge、尚未合入 `test`、尚未重新打包或执行 Zeus Test GUI/Provider 验收，因此不把上述静态结果表述为 test 或桌面验收通过。

## 2026-08-28 test 合入与隔离测试包验收阻塞

- 重构适配候选以 merge commit `a3746b58ab4b9ca9ae5dc013c394a95a0c2585d6` 固化，并本地合入 `test`，生成 merge commit `ee05a10bf5ca2d00e07e5a57448125efea1893e9`；没有推送远端。
- 在 `test` 工作树重新执行 `pnpm install --frozen-lockfile --offline`、`pnpm typecheck` 与 `pnpm package:mac`，结果均通过。测试产物为 `dist/test/mac-arm64/Zeus Test.app` 与 `dist/test/Zeus-Test-0.3.67-arm64.dmg`；反读 bundle ID 为 `dev.hypha.zeus.test`，严格 codesign 结构校验通过，签名仍为本机 ad-hoc。
- 启动前确认没有其他同 bundle ID 测试实例。最终包使用独立资料根 `/tmp/zeus-0014-test-0XmQ7PTu` 启动，并通过 `ZEUS_TEST_DISPLAY_ID=3` 指定非主外接屏；进程树、独立 profile、执行宿主 ready 与 UI attached 均确认来自本轮测试包和资料根。
- Computer Use 在读取窗口状态前被可信服务门禁拒绝，错误为 `sky requires node_repl; configure NODE_REPL_TRUSTED_SERVICES`。因此没有执行 Fast 控件点击、Provider 登录、真实会话发送或截图，不把隔离启动和宿主就绪表述为 GUI/Provider 验收通过。验收停止后只向本任务主进程 PID 24128 发送 TERM，并确认该进程及其执行宿主均已退出；隔离资料根保留用于后续续验。
- 本地 `main` 当前还存在另一项工作的 4 个已修改文件和 2 个未跟踪文件。为避免覆盖或夹带并发改动，在 GUI/Provider 验收补齐且 `main` 工作树归属明确之前，不执行最终 main merge。

## 2026-08-28 同步 v0.3.68 后复验

- 本地最新 `main` 已推进至 `5f015c3b8f59e542edc34fb72905797d267b1363`（`v0.3.68`）。该提交以 merge commit `2aed38e` 无冲突合入 `test`；合入只读取已提交的 `main` ref，没有读取、暂存或夹带主工作树的并发未提交改动。
- 最终合并态重新执行 `pnpm install --frozen-lockfile --offline`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、Renderer 事件流、设置命令行为和 Subagent 详情专项探针，结果全部通过；架构门禁仍满足 97 张 Core 表、11 张可重建辅助表及源码尺寸约束，构建只有既有的大分块提示。
- `pnpm package:mac` 重新生成 `0.3.68` 测试包。包健康检查确认 54 个 Renderer assets、Main、两个 Preload 与更新助手完整；bundle ID 为 `dev.hypha.zeus.test`，严格 codesign 与 `Zeus-Test-0.3.68-arm64.dmg` 校验均通过。该包仍是本机 ad-hoc 签名且未公证。
- 启动前确认没有其他 Zeus Test 实例，外接竖屏 ID 3 可用。最终包使用独立资料根 `/tmp/zeus-0014-v0368-OM6Lla` 启动，真实 Renderer、`0.3.68` execution host ready、UI attached、测试 profile 和 bundle 身份均成立；验收后只向本任务主进程 PID 73944 发送 TERM，所有本任务子进程均已退出。
- Computer Use 对应用完整路径读取窗口仍被可信服务门禁拒绝，错误保持为 `sky requires node_repl; configure NODE_REPL_TRUSTED_SERVICES`。因此 Fast 控件、跨入口、冷重启恢复、Provider 登录与实际档位截图仍未完成，不能把本轮隔离启动表述为 GUI/Provider 验收通过。
- 当前本地 `main` 工作树仍有另一项任务的未提交文档与源码改动。最终 main merge 继续等待 GUI/Provider 验收通过且主工作树归属收口；没有 push。

## 2026-08-28 同步 v0.3.69 后续验

- `main` 已推进至干净的 `56eb31f`（发布结果对应 `v0.3.69`）。合入 `test` 时只有 `codexNativeConversationCoordinator.ts` 一处冲突：保留 ZEUS-0014 已拆出的 contracts、持久提交输入和 service-tier 降级模块，同时接入主线新增的 Codex 恢复状态应用；协调器最终为 3938 行。合并提交为 `58af95c`。
- 最终合并态重新执行离线依赖安装、`pnpm lint`、`pnpm typecheck`、架构门禁、`pnpm build`、Renderer 事件流、设置命令行为与 Subagent 详情专项探针，结果全部通过。`pnpm package:mac`、包健康、`dev.hypha.zeus.test` 身份、`0.3.69` 版本、严格 codesign 和测试 DMG 校验均通过。
- 启动前没有其他 Zeus Test 实例，外接竖屏 ID 3 可用。最终包使用独立资料根 `/tmp/zeus-0014-v0369-RjvwsP` 启动；真实 Renderer、`0.3.69` execution host ready、UI attached 与测试数据根身份成立。验收停止后只向本任务 PID 16569 发送 TERM，相关进程已全部退出。
- Computer Use 仍在读取窗口前返回 `sky requires node_repl; configure NODE_REPL_TRUSTED_SERVICES`。只读核对确认来源 `/Users/david/.codex/config.toml` 已声明受信服务，而当前正式 Zeus Provider 配置缺少 `NODE_REPL_TRUSTED_SERVICES`，目标 Computer Use 支撑 App 也不存在；这与 TASK_20260827_003 记录的“需要重新执行官方配置导入并重启会话”边界一致。
- 本任务不修改正式 Zeus Provider 配置或复制正式认证。因而 Fast 控件点击、跨入口、冷重启恢复和打包身份下 Provider 实际档位截图仍未完成；在官方配置导入与新会话恢复 Computer Use 前，不宣称 GUI/Provider 验收通过，也不合入 `main`。没有 push。

## 2026-08-28 官方配置导入授权与运行代切换

- 用户明确授权通过正式 Zeus 的官方接口导入 Codex 配置并续验。执行前的只读预览确认来源为 `/Users/david/.codex`、目标为 `/Users/david/.zeus/providers/codex`，只导入配置、AGENTS、rules、prompts、skills、Computer Use 支撑 App 和 Browser/Chrome/Computer Use 三个精确插件目录；生成缓存继续排除。
- 导入使用 `codex.configuration.import` 的幂等命令信封与正式 execution host API 完成，返回 `restartRequired=true`。可恢复备份位于 `/Users/david/.zeus/backups/imports/codex/2026-08-28T09-02-27-112Z-05f7c513-4f92-411c-bc36-ce787d35b025`，manifest 完整记录 9 个导入条目和 8 个被替换条目。
- 导入后确认目标配置已包含改写到 Zeus 资料根的 `NODE_REPL_TRUSTED_SERVICES` 与 `SKY_CUA_SERVICE_PATH`，Browser service、Computer Use 插件及支撑 App 均存在，支撑 App 严格 codesign 校验通过。随后通过 `codex.configuration.activate` 建立新运行代 `1fe30068-119d-4027-9c15-986054dc11e0`，返回 `runtimeReloaded=true`、`restartRequired=false`。
- 当前正在执行的 Provider turn 创建于导入前，其 node_repl 可信服务清单不会在 turn 内热更新；重置内核后仍返回同一缺失配置错误。后续必须由新运行代创建下一轮或新会话，再继续 Computer Use GUI/Provider 验收。当前仍不合入 `main`，没有 push。

## 2026-08-28 新 turn 复核

- 官方导入后的同一 Zeus 会话新 turn 仍复用原生 Provider session `01a045f5-7aed-7151-b615-ea3b1632212d`，Computer Use 继续报告缺少 `NODE_REPL_TRUSTED_SERVICES`。因此上一节“下一轮或新会话”的口径收紧为：必须新建任务会话，单纯在当前会话发送下一条消息不足以切换 Provider session。
- 当前还有另一任务 `ZEUS-0358` 的同 bundle ID `Zeus Test.app` 使用独立资料根运行。本任务不关闭、借用、复用或操作该实例；新任务会话恢复 Computer Use 后仍需等待该实例自然退出，再启动 ZEUS-0014 的最终测试包。
- `test` 已包含干净 `main` 的 `v0.3.69`，两边工作树均干净。GUI/Provider 验收与最终 main merge 仍未完成，没有 push。

## 2026-08-28 独立 Zeus Test GUI 与真实 Provider 验收

- 等待其他任务的同 bundle ID 实例自然退出后，使用最终 `0.3.69` 测试包、独立资料根 `/tmp/zeus-0014-final.MI1v2x` 和 `ZEUS_TEST_DISPLAY_ID=3` 启动。主进程日志两次确认首窗均以 `matchKind=first-launch` 创建在非主外接屏 ID 3，实际边界为 `x=-1268, y=268, 1240×820`，`corrected=false`。
- 在独立资料根中新建项目 `ZEUS-0014 验收`。项目新会话初始为 `Codex / GPT-5.6-Sol`、`low`、Standard；真实点击 Fast 后界面显示 `速度：Fast`。SQLite 只读复核确认项目配置写入 `gpt-5.6-sol -> priority`，且只产生一条 `project.service_tier_preference.updated` 审计记录。
- 将模型切换到 `GPT-5.6-Luna` 后界面回到 Standard，再切回 `GPT-5.6-Sol` 后恢复 Fast，证明偏好按模型身份隔离。使用同一资料根冷重启后，项目与 Sol/Fast 选择均恢复；首窗仍位于外接屏 ID 3。
- 从任务 `ZEUS-0001 Fast 模式任务入口验收` 执行“推送到新会话”，生成独立会话 `conversation_e1d1123b2794f3b5ef9ac02d`。持久提交 `conversation_submission_d861e14343e4dd3c8de5f244` 的请求档位、冻结调度上下文和实际下发档位均为 `priority`，模型保持 `gpt-5.6-sol`，reasoning effort 保持 `low`。
- 配置证据的 `selected`、`frozen`、`adapter_serialized`、`runtime_acknowledged` 各层均无 mismatch，档位均为 `priority`。真实 Provider 产生完整用量记录：`codex_usage_ledger.model=gpt-5.6-sol`、`service_tier=priority`、`usage_complete=1`；这证明打包应用实际采用 Fast，不是只验证界面选择或请求字段。
- Provider 随后请求通过 shell 执行 `screencapture`。该请求违反本轮只允许使用 Computer Use 操作 GUI 的验收边界，因此通过正式会话请求响应接口明确取消；请求已解析且当前无 pending request。对应 turn 标记为 `interrupted` 是拒绝非合规截图命令的预期结果，不改变此前已完成的真实推理、实际 `priority` 档位和完整用量证据。
- 验收结束后只关闭本任务测试包进程，并确认独立资料根对应的主进程与 execution host 已退出；没有读取、复制或覆盖正式 Zeus、日常 Codex 或其他任务的认证资料。

## 2026-08-28 最终并发主线同步与组合态复核

- 验收后 `test` 又合入 ZEUS-0327，本地 `main` 同时推进了 ZEUS-0358 与 ZEUS-0359。为避免把旧共同基线结果冒充最终组合结果，先将干净 `main@11c70f4` 无冲突合入 `test`，生成 merge commit `cd41df3`。
- 最终组合态重新执行 `pnpm lint`、`pnpm typecheck`（含架构门禁）、`pnpm build`、会话命令、会话调度命令与 Subagent 详情行为探针，全部通过；架构门禁仍为 97 张 Core 表和 11 张可重建辅助表，构建仅有既有的大分块提示。
- 最终组合态重新执行 `pnpm package:mac`，生成 `dist/test/mac-arm64/Zeus Test.app` 与 `Zeus-Test-0.3.69-arm64.dmg`。包健康检查确认 54 个 Renderer assets、Main、两个 Preload 与更新助手完整；反读 bundle ID 为 `dev.hypha.zeus.test`、版本为 `0.3.69`，严格 deep codesign 与 DMG 校验均通过；签名仍为本机 ad-hoc 且未公证。
- 新增组合差异只涉及 ZEUS-0327 的环境弹层层级/浏览器暂停、ZEUS-0359 的待处理请求投影和本地服务导出，以及独立菜单栏状态 UI；没有改变 Fast 偏好、能力判定、请求档位、调度档位或 Provider 用量链路。逐文件差异审计、最终组合态类型/构建/行为探针和当前包检查均通过，因此沿用前一节已经在同一 `test`、同一 `0.3.69` 测试身份上完成的 Fast GUI 冷重启与真实 Provider `priority` 证据，不因随后无关合入重复启动第二个同 bundle ID 实例。
- 另一任务的独立 `Zeus Test` 实例仍在运行；本任务没有关闭、借用或操作该实例。ZEUS-0014 的独立实例已清理，最终验收结论为通过，可以执行本地 `main` 合入；全程不 push。
