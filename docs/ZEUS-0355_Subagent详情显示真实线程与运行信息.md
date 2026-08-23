# ZEUS-0355 Subagent 详情显示真实线程与运行信息

## 任务目标

- Subagent 详情只展示当前子线程自身的工作过程，不再把 `fork_turns=all` 继承的父会话消息当成子智能体提示词。
- 在子线程标题下显示与主会话同结构的运行摘要和详情，所有数值来自 Codex 线程或 Provider JSONL 真实事实。
- 保持 Subagent 详情只读，不新增输入、模型切换或续聊能力，不新增存储表或数据迁移。

## 根因与现场证据

- 当前服务端对 `thread/read(includeTurns=true)` 返回的所有 turns 无差别投影，Renderer 又无差别展示这些 turns。
- Banach 历史线程 `01a0217e-90d7-7200-a1a1-4b729a39b4c8` 共返回 18 个 turns：13 个 `startedAt` 早于子线程 `createdAt`，只有之后的 5 个 turns 属于 Banach。
- Codex 将派发任务作为 inter-agent 输入交给子智能体，它不是子线程里的普通用户消息。Zeus 不尝试解密或重建该输入。
- 子线程自身 `turn_context` 中已有模型、推理强度、工作目录与运行策略，部分版本还会返回服务层级；`token_count` 中已有真实累计和最近请求用量。现有 Subagent 查询接口没有投影这些事实。

## 已确认方案

1. 以 `thread.createdAt` 与 `turn.startedAt` 确认自身历史边界；没有可靠时间的 turn 安全隐藏，不使用标题、preview 或父会话消息补位。
2. 对 Provider JSONL 使用路径受限、身份复核、单行和总大小有界的流式扫描；在首个自身 `turn_context` 之前只记录用量基线，之后才投影子线程运行事实。
3. 首次打开做一次有界扫描；进行中线程轮询只扫描文件新增尾部，路径、文件身份、线程身份或历史边界改变时失效缓存。
4. 运行详情统一使用 `available / unavailable` 事实值；历史没有完整请求时序时，输出速率和首段响应延迟保持不可用。
5. 主会话和 Subagent 共用一个只读运行详情展示组件；主会话继续使用现有快照与聚合，Subagent 使用同一次详情请求返回的 timeline 与 runtime。

## 方案取舍

- 优点：恢复 Codex 独立 agent thread 语义；旧历史不需迁移；不伪造提示词、模型、价格或性能数值；轮询不引入 Renderer 请求瀑布。
- 缺点：首次打开大型历史需要一次文件扫描；旧记录没有精确时序时，部分性能指标只能显示“暂无数据”。
- 取舍：优先真实和失败关闭，不直读 Codex 私有 SQLite，不在 GET 路径调用 `thread/resume`，不用轮次总耗时反推模型速率。

## 实施阶段

当前阶段：代码、行为探针、历史副本、打包与真实 Test 运行链路已完成；受 Computer Use 原生通道不可用阻塞，本轮不宣称完成 GUI 视觉交互全量验收。

- [x] 自身历史边界与安全降级
- [x] Provider JSONL 运行事实投影与增量缓存
- [x] 共享运行详情组件与 Subagent 接入
- [x] 独立行为探针
- [x] lint、typecheck、build、package:mac
- [x] 隔离 `Zeus Test.app` 启动、首窗位置、真实服务端详情接口与优雅退出验证
- [ ] 分栏、全宽、窄窗口、长路径、进行中刷新与空数据状态的 GUI 视觉交互验收（Computer Use 原生通道不可用）

## 实现记录

- `codexSubagentQueryApplication.ts` 在详情读取时先按 `createdAt / startedAt` 投影自身 turns，并同时返回 `historyBoundary` 与 `runtime`；缺失边界的内容只隐藏，不回退到父消息或列表 preview。
- `codexSubagentRuntimeProjection.ts` 只允许读取 Provider `sessions` 根内的普通 JSONL 文件，校验首行线程 ID、512 MiB 文件上限和 16 MiB 单行上限；缓存按线程、真实路径、设备号、inode、offset 和自身边界签名失效，后续读取只处理新增尾部。
- 运行投影从首个自身 `turn_context` 开始读取模型配置，以此前最后一个累计 `token_count` 作为继承历史基线；性能 timing 缺失时返回带原因的 `unavailable`，不填零。
- `RuntimeDetails.tsx` 成为主会话与 Subagent 共用的只读展示组件；Subagent 在标题下依次展示摘要、使用与费用、性能与活动、环境和自身时间线。长路径可断行，边界不可确认时显示安全隐藏提示。
- `verify-subagent-detail-behavior.ts` 覆盖 `fork_turns=all`、无继承历史、进行中尾部追加、缺少线程/turn 时间、首行身份不匹配、单行与文件超限、运行字段缺失。

## Banach 历史副本核验

- 使用 `state_5.sqlite` 的一致性备份和 Banach JSONL 副本建立隔离 `CODEX_HOME`，在副本内把 `rollout_path` 重写到隔离路径；只执行 `initialize` 与 `thread/read(includeTurns=true)`，没有调用 `thread/resume` 或产生新 turn。
- Provider 副本仍返回 18 个 turns；实现边界确认 13 个继承 turns、5 个自身 turns。首个自身 turn 为 `01a0217e-9158-7620-9303-75c885ba03a9`，首条可见内容以“我先把这五项按现状审计……”开始，父问题未出现。
- 运行投影结果：`gpt-5.6-sol / ultra`；累计 `142,788,269 Token`，输入 `142,207,766`、输出 `580,503`、推理 `165,324`；最近上下文 `184,639 / 258,400 Token`；缓存命中率约 `97.8%`；模型请求 `998`、工具/命令 `226`、失败轮次 `0`。
- 工作目录、Git 分支、线程 ID 与隔离 JSONL 路径均和 Provider 副本一致。该历史的 `turn_context` 没有 `service_tier`，因此服务层级按契约显示“暂无数据”；输出速率也因没有完整 timing 保持不可用。

## 当前验证记录

- `pnpm verify:subagent-detail`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过，包含架构依赖门禁。
- `pnpm build`：通过；Vite 仅报告仓库既有的大 chunk 提示。
- `pnpm package:mac`：通过，产物为 `dist/test/mac-arm64/Zeus Test.app`，实际 bundle ID 为 `dev.hypha.zeus.test`，签名与 designated requirement 检查通过。

## 隔离 Test 运行核验

- 使用本任务独立可写资料根 `/private/tmp/zeus-0355-gui.UP9beJ`，历史数据库通过 SQLite 一致性备份生成，Provider 仅保留 Banach 副本；未续接、未修改正式线程。
- 启动前检测到三块显示器；首窗实际命中非主外接屏 `displayId=3`，无二次纠正，窗口边界为 `x=-1268, y=268, width=1240, height=820`。
- 真实打包应用的同一 Subagent 详情响应同时返回 timeline 与 runtime：5 个自身 turns、13 个已隐藏继承 turns、0 个模糊 turns；首条为 Banach 自身工作内容，父问题不在响应中。
- 真实运行响应中的模型、推理强度、Token、上下文、活动、工作目录、分支、线程 ID 与 JSONL 路径和独立 Provider 核验一致；缺失的服务层级与 timing 按契约不可用。
- 验证结束时通过 Execution Host 本机控制面的 `/shutdown` 正常退出，再通过隔离 `CODEX_HOME` 的官方 `codex remote-control stop --json` 停止 app-server backend；未强杀进程或删除锁。副本库 `PRAGMA quick_check` 为 `ok`；正式库与副本 inode 不同，Banach JSONL 源文件与副本 SHA-256 一致。
- 官方 stop 返回 `status=stopped`，但 Codex 0.149.0 仍保留隔离根下的 `app-server daemon pid-update-loop` 更新辅助进程；它不再打开历史库或 app-server 控制套接字。本轮不用信号强制结束该官方持久组件，并保留隔离资料根以避免其引用失效。

## GUI 验收缺口

- 已启动真实 `Zeus Test.app`，并通过实际窗口恢复记录和打包应用内的真实 API 返回核验屏幕归属与数据语义。
- Computer Use 按规定方式启动后返回 `Sky Computer Use native pipe is unavailable`，无法对窗口进行点击、改宽或截图。内置 Browser 补充验证只能打开无 Electron preload 的 Renderer，明确显示本地桥接未就绪，因此不冒充 GUI 证据。
- 本轮未完成分栏、全宽、窄窗口、长路径、进行中刷新与空数据状态的可视化交互验收，该部分保留为环境能力缺口。

## 验收边界

- 验证使用 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac` 和必要的独立行为探针，不引入新的测试体系。
- GUI 只允许使用 `Zeus Test.app`（`dev.hypha.zeus.test`）和本任务独立 `ZEUS_USER_DATA_DIR`。
- 历史数据使用副本；如需新建 Provider 会话，使用与历史副本不同的隔离资料根，不续接或修改正式 Provider 线程。
- 如存在外接屏，窗口必须从首次创建起位于非主外接屏；无法保证时停止 GUI 验收并记录缺口。
- 实施与验收阶段未执行 commit、push、merge、revert 等 Git 历史或远端动作；后续交付动作以用户新的明确授权为准。

## 交付与发布阶段

- 2026-08-23，用户明确要求“提交并合入 main，然后升级发布”，因此本阶段授权任务提交、本地 main 合入以及正式发布编排所需的 main push、标签、GitHub Release 和 Homebrew Tap 更新。
- 交付前任务分支为 `zeus/ZEUS-0355-subagent-01`，工作区仅包含本任务 12 个变更条目；真实 main worktree 为 `/Users/david/hypha/zeus`，预合入 HEAD 为 `8400cea9873ed96a1c8f9d4e89b8c9bea4285e79`，与 `origin/main` 一致且工作区干净。
- 发布使用仓库唯一正式入口 `pnpm release` / `scripts/release-all.mjs`，由编排器基于最新公开稳定版自动选择下一个补丁版本，不在任务提交中手工预改版本。
- 任务提交为 `b088b04`。合并预演发现 `SessionWorkspace.tsx` 与 v0.3.40 的会话运行详情降噪改动同区冲突；解决时保留共享 `RuntimeDetails` 的单一展示实现，同时保留主会话对缺失的输出速率、延迟、费用摘要、代码改动和环境项的低噪音隐藏语义；Subagent 仍按本任务契约显示带原因的“暂无数据”。

## 合入与正式发布结果

- 任务提交 `b088b04c2af84933bea211f4c21733ecca2665e9` 已通过 merge 提交 `ed6bda79903d4b5c9401c785a676f75059d7070e` 合入真实 `main`。合并态下 `pnpm verify:subagent-detail`、`pnpm lint`、`pnpm typecheck`、`pnpm build` 和 `pnpm package:mac` 均通过。
- 正式 `pnpm release` 基于 v0.3.40 自动生成发布提交 `3f3e597b4ef43bc7f8e75410a631710418cf65a5` 与不可变标签 `v0.3.41`，并将 `main` 安全推送到 `origin/main`。发布说明能力令牌不可用时，编排器按约定使用确定性模板，没有伪造模型结果或中断发布。
- Release Workflow `32641935399` 的 `preflight`、`typecheck`、`package-mac` 和 `publish` 全部成功：<https://github.com/imchenway/zeus/actions/runs/32641935399>。GitHub Release 已公开且非草稿/预发布：<https://github.com/imchenway/zeus/releases/tag/v0.3.41>。
- 公开 DMG `Zeus-0.3.41-arm64.dmg` 为 `112184753` 字节，SHA-256 为 `06c1e6b5843e5c3928878696e1a48bcd3cfbaa83117cffd7d1894b7db82d2efc`；发布后使用 `DEEP_VERIFY_PUBLIC_DMG=true` 完整回下载，大小、服务端摘要和 `hdiutil verify` 均通过。
- 公开 manifest SHA-256 为 `5a0f8b3bbfeef6e476687aba981aa19a0183d6025cefcccd3c901863d3b92af5`；Homebrew Cask 已同步为 `0.3.41` 并使用同一 DMG SHA-256。manifest 如实记录 `signed: false` 和 `notarized: false`，本版本不声称 Developer ID 签名或 Apple 公证。
