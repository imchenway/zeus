# ZEUS-0392 IM 接入

## 用户需求

把现有 Telegram 设置升级为统一“IM 机器人”入口。首期只真实接入 Telegram，一个 Bot 固定绑定一个 Zeus 项目、一个 Telegram 私聊用户和一个 Agent Preset，并提供任务与对话的端到端核心闭环。

视觉目标来自用户提供的“机器人接入”截图；截图中的微信等渠道只用于表达统一入口结构，不表示本期已经拥有对应 Provider 能力。

## 已确认产品语义

1. 渠道目录展示微信、飞书、钉钉、企业微信、QQ、Slack、Telegram、Discord、WhatsApp、AI Office；只有 Telegram 可接入，其余均明确显示“暂未支持”，Grok 不在本期范围。
2. 一个 Telegram Bot 只绑定一个 Zeus 项目和首次扫码的一个私聊用户；群聊、第二用户和跨项目访问全部失败关闭。
3. 接入时选择“跟随 Zeus 默认”或项目内已启用的数字员工。数字员工只提供创建新会话和任务推送时冻结的模型、Skill、提示词、权限和工作模式配置，不自动创建数字员工执行或改变阶段协作事实。
4. 普通消息进入 Zeus 权威会话；忙碌时走耐久队列，并支持新建、切换、引导、停止和继续。
5. 任务首期覆盖列表、详情、创建、编辑、状态、附件、推送到会话、运行、暂停、继续、取消和结果通知；归档删除、批量、关系/阶段、数字员工接力、Git 工作区和外部集成治理仍在桌面端完成。
6. Provider 审批、`request_user_input` 和计划实施请求可以映射到 Telegram 交互；远程审批能力默认关闭，用户必须在桌面设置中显式开启。
7. Token 只进入连接专属 Keychain 槽位；SQLite、命令信封、审计、日志和错误均不得持久化 Token、配对明文或附件正文。

## 方案与取舍

### 采用 Zeus 权威链路

Telegram 只作为受认证的远程入口。入站消息、任务操作和交互回答必须调用既有会话、工作管理和命令账本应用边界；模型输出从 Snapshot V2 / 会话同步事件读取，不复制 Vibego 的 tmux 与 JSONL watcher。

优点：会话、队列、审批、任务和副作用继续只有一个权威事实源，重启恢复与重复请求可复用现有 operation identity 和四态回执。代价：改造范围大于命令机器人，需要新增连接、游标、回执和交互能力持久化。

### 单项目、单用户、固定预设

优点：工作区、可信主体和审计责任明确，容易证明没有跨项目泄露。代价：一个 Bot 不能同时服务多个项目或团队成员；更换预设只影响后续新会话。

### 外部投递不盲重发

同一 Telegram update 使用稳定入站身份；同一聊天和会话串行处理。外发消息在写出前建立稳定外部操作身份，Telegram 返回明确拒绝时可安全报告，响应丢失时收口为 `outcome_unknown_after_write`，禁止自动重发。

优点：避免重复消息、重复审批和重复副作用。代价：极端网络故障可能需要用户手动检查连接或重新发起，而不是追求表面上的“至少送达一次”。

## 初始现场（2026-08-29）

- 工作区：`/Users/david/hypha/.zeus-worktrees/zeus-e2e-oBLuqT/76c9857d8711dec66777/ZEUS-0392`
- 分支：`zeus/ZEUS-0392-im-01`
- 基线：`2b32aca`，初始工作树干净。
- 现有 `@zeus/telegram-adapter` 只规范化文字命令和 callback，并支持 `sendMessage`、`editMessageText`、`sendDocument` 与 `getUpdates`；没有 `getMe`、附件下载、配对或自然语言会话桥。
- Local Server 已有 Telegram Token Keychain、白名单、通知、polling 与任务运行命令，但普通文字会被当作未知命令；项目列表还会远程返回本地路径，不符合新的单项目边界。
- Zeus 已有项目/任务会话、耐久消息队列、steer、interrupt、server request response、计划实施 response、任务推送附件和 Snapshot V2 增量协议，可作为 IM 的权威应用能力。
- 现有设置页已有独立 Telegram 分类与设置行，本次在原设置壳层内替换为统一 IM 页面，不复制截图中的独立应用外壳。
- 本机 Vibego 参考链路证明需要覆盖：业务消息统一排队、同一 chat/session 串行投递、图文聚合、附件失败可见、长正文附件化、`request_user_input`/计划确认按钮化，以及网络未知结果不盲目重发。

## 实施阶段

- [x] 需求、截图、仓库、Vibego 参考实现与安全边界已收口。
- [x] 通用 IM 数据模型、共享契约和 Telegram Bot API 能力。
- [x] 配对、可信用户、会话/任务/审批/附件桥与恢复。
- [x] IM 机器人设置页、接入向导、状态卡与旧配置兼容。
- [x] 静态检查、构建与测试身份打包。
- [ ] 真实行为验证（待独立 GUI / Telegram 现场）。
- [ ] 独立 `Zeus Test.app` 的真实 GUI / Telegram 验收和设计 QA。

## 实际实现记录（2026-08-29）

### 协议与持久化

- 新增通用共享类型与 8 张 Core 表：连接、可信端点、配对会话、聊天绑定、入站 receipt、投递 cursor、一次性交互 capability 和脱敏连接日志；架构治理清单同步到 105 张 Core 表。
- 连接 Token 使用 `im.connection.<connectionId>.telegram.bottoken` 专属 Keychain 槽位。配对明文只保存在当前进程内，SQLite 只保存 SHA-256；进程重启后必须重新生成配对码。
- 所有公开 mutation 继续使用 `{ command, input }`、稳定 operation identity 和命令投递账本；入站 update 以 `connectionId + updateId` 幂等，外发消息、图片和文档复用 Telegram External Outbox 四态，并按 chat 串行化真实网络写入。
- 旧 `/api/telegram/*` 接口与 `telegram.botToken` 兼容读取保留；旧 Token 只进入“待迁移”入口，不继承历史 allowlist/chat ID，不自动形成可信身份。

### Telegram 适配与安全边界

- `getMe`、富媒体 update、`getFile`/受限下载、callback answer、安全 HTML、图片/文档发送和消息编辑已进入适配器。
- 32 字节随机配对参数使用 43 字符 base64url，10 分钟有效且单次消费；只允许 `private` 且 `chat_id === user_id`，第二用户、群聊和错误端点全部失败关闭。
- 相册使用 `media_group_id` 与 1.5 秒 quiet window 聚合；入站单文件 20 MiB、每次 10 个、总量 100 MiB，并在下载前后校验声明大小和实际大小。相同 update 在进程中断后以稳定 receipt 身份恢复，已落盘附件必须逐字节身份一致才可继续。
- 文件名经过 basename、NFKC 和字符白名单处理；会话与任务附件都进入各自授权根下的 connection/intent 独立受控目录，并再次校验绝对路径身份。MIME 由魔数优先识别，不直接信任 Telegram 文件名或声明。
- 在线仅在 Token 已验证、poller 正在运行且最近 90 秒有成功轮询时成立；`getMe` 成功本身不会制造在线状态。

### 对话、任务与交互

- 普通消息、新会话、历史切换、耐久排队、`/steer`、`/stop`、`/continue` 已桥接现有 Graph Conversation / Conversation Dispatch 应用边界。
- Agent Preset 在新会话/任务推送时冻结模型、Skill、提示词、权限和工作模式；已有会话不追溯改变。数字员工停用或删除后连接标为需要重新配置，新消息失败关闭。
- 当前项目普通会话权威入口只支持 Codex Provider，因此 IM 设置只展示项目内已启用的 Codex 数字员工。现有 Pi 任务会话不作为统一 IM 普通对话 Preset，避免把“仅任务链路可用”误报为完整预设支持。
- 任务列表、详情、创建、编辑、项目状态、附件、新建/既有会话推送、运行/暂停/继续/取消已桥接 Work Management 命令账本；所有查找和 mutation 都再次校验绑定项目。被推送任务使用持久 task cursor 订阅状态通知，切换聊天会话或重启不会丢失订阅。
- 助手输出从 Snapshot V2 `model_history` 读取；截断正文必须按 `contentHandle` 分页，并校验会话身份、offset、总字节数和完整结束。超过 3900 字符时发送有界摘要及完整 `.md`。
- 图片和文档只接受与 assistant provider item 精确关联的 Conversation Resource，并在发送前校验 `absolutePath + allowedRoot + realpath + regular file`；模型文本中的任意路径不具备发送权威。资源未通过文件身份、授权根或大小校验时失败关闭并给出 Telegram 可见通知，不静默丢弃。
- `request_user_input` 支持多题、单选、多选、Other 和自由文本；敏感问题强制回桌面。Provider 审批默认关闭；开启后 command/file 只展示 Provider 明确声明的一次性批准，permissions/MCP 在 Telegram 仍只允许失败关闭的拒绝。按钮 capability 过期或被安全消费后，后续提示使用新的投递身份，避免生成数据库里有效但聊天中不可见的按钮。
- 计划实施支持实施、提出修改和暂不实施。所有按钮同时绑定 connection、endpoint、target、expected revision 和单次 capability token；错误用户、过期、revision 变化及重复点击均拒绝。

### 设置页

- 设置分类已改为“IM 机器人”，`#settings-telegram` 在初始加载和运行中导航时均替换为 `#settings-im`。
- 页面使用现有 Zeus 设置壳层，展示真实安全条、10 个已确认渠道、Telegram 三步接入向导、真实二维码、配对倒计时、连接健康、可信端点、Agent Preset、远程审批显式确认、检查/日志/移除操作。
- 配对状态每 2 秒读取本机权威连接快照；完成 Start 后自动切换为已接入卡。已配对连接每 10 秒刷新真实健康，不把一次 `getMe` 成功长期冒充在线。
- 微信、飞书、钉钉、企业微信、QQ、Slack、Discord、WhatsApp、AI Office 均明确显示“暂未支持”；Grok 未加入页面或协议。

### 当前验证

- `pnpm lint`：通过。
- `pnpm typecheck`：通过；同时通过 105 张 Core 表和 11 张辅助表的 architecture governance。
- `pnpm --filter @zeus/telegram-adapter build`：通过。
- IM 内存诊断：通过安全 HTML 可见长度、`getMe` 明确拒绝分类、相册聚合、8 表迁移、私聊配对、received receipt 恢复、带转义前缀的交互 capability 恢复、单次消费拒绝重复、任务订阅恢复，以及重新配对撤销旧端点。
- `git diff --check`：通过。
- `pnpm build`：通过；仅出现既有 `markstream-react` Rolldown 注解与大 chunk 警告。
- `pnpm package:mac`：通过，产物为 `dist/test/mac-arm64/Zeus Test.app`；`CFBundleIdentifier=dev.hypha.zeus.test`、显示名为 `Zeus Test`，deep/strict codesign 校验通过，`dist` 未生成生产身份 `Zeus.app`。
- 使用无效占位 Token 发起的真实 `getMe` 网络探针返回中性错误 `Telegram getMe network request failed.`，证明错误不会把含 Token 的 URL 带入上层；当前网络未能连接 Telegram，不能据此冒充 Bot API 的无效 Token 拒绝验收。
- 独立 Test app GUI 与真实 Telegram 场景尚待执行，不能提前记为完成。当前检测到另一任务 `ZEUS-0393` 正占用 `Zeus Test.app` 真实 GUI 槽位，且 `ZEUS-0352-test` 已在其后排队；本任务未关闭、借用、抢占或冒充这些应用。

## 本地 merge 交付记录（2026-08-30）

- 合入现场为持久分支 `zeus/ZEUS-0392-im-01-merge`；目标侧 `HEAD=d4f328b9`，任务侧 `MERGE_HEAD=ead9fdde`。本轮只解决、暂存并验证 merge 结果，不创建提交、不切换分支、不更新 `main`、不 push。
- 已处理仓库内全部 6 个冲突文件：生命周期矩阵、架构治理清单、Local Server 组合根与平台路由、Storage 组合根与表所有权；同时审计了双方共同修改的桌面依赖、Workspace 设置导航和 lockfile，没有按 ours/theirs 整侧覆盖。
- 数据治理采用联合事实：当前 `main` 相对共同基线新增 12 张 Core 表，IM 分支新增 8 张且无重名，合并后为 117 张 Core 表和 11 张辅助表；Plugin、task-work、数字员工能力迁移与 IM 的表、迁移、导出和生命周期说明全部保留。
- Local Server 同时保留主线 `conversationExecution`、task-work repositories 与 IM 的耐久 conversation dispatch、附件根和恢复注册。共同修改审计补齐了 `taskAttachmentRoot` 向平台路由的传递，并把只读验证世代的附件根收窄为可选、在真正读写附件时显式失败关闭，避免用非空断言掩盖缺失授权根。
- 合并态验证通过：`pnpm lint`、`pnpm typecheck`（含 117/11 architecture governance）、`pnpm --filter @zeus/telegram-adapter build`、`pnpm build`、相关文件 Prettier、`git diff --check` 与 `git diff --cached --check`。
- `pnpm package:mac` 通过；仅生成 `dist/test/mac-arm64/Zeus Test.app`，`CFBundleIdentifier=dev.hypha.zeus.test`、显示名 `Zeus Test`，deep/strict codesign 通过，`dist` 内没有生产身份 `Zeus.app`。本轮未启动 GUI，也未重新执行真实 Telegram / Provider 验收，原缺口继续保留。

## v0.3.80 发布门禁恢复（2026-08-30）

- `pnpm release` 已实际执行，并生成本地发布提交 `a801a046`；命令随后停在“本地阻塞级 TypeScript 检查”，没有推送 `main`、创建标签或完成公开发布。
- 原始错误为 `ImRobotSettingsPane.tsx` 无法解析 `qrcode`，并连带报告 `toDataURL()` 回调参数为隐式 `any`。`qrcode@1.5.4` 与 `@types/qrcode@1.5.6` 已同时存在于桌面包依赖声明和冻结 lockfile，源码与依赖声明不缺失。
- 现场检查确认主工作区的 `apps/desktop/node_modules` 没有链接上述两个包；根因是 IM 改动合入后，本地主工作区依赖目录没有同步到新的 lockfile，而不是 React 实现或发布编排拒绝执行。
- 使用 `CI=true pnpm install --frozen-lockfile` 按现有 lockfile 重建依赖目录；没有改动 lockfile，也没有升级依赖范围。随后重新执行 `pnpm typecheck` 通过，architecture governance 同时通过 126 张 Core 表和 11 张辅助表检查。
- 当前只恢复了本地发布门禁条件；本轮诊断没有继续执行发布命令，因此仍不得声称 `v0.3.80` 已推送、已打标签或已公开发布。

## v0.3.80 公开发布完成（2026-08-30）

- 远端 `main` 已精确推进到发布提交 `a801a046c5c2c97da2c21d10698b01a271a25c95`；既有 Release Workflow `33294008276` 随后完成，preflight、typecheck、正式 macOS 打包、致命产物校验、产物上传、不可变标签、GitHub Release 与 Homebrew Cask 同步全部成功。
- 独立 CI Workflow `33293999451` 对同一提交完成且结论为 `success`。`v0.3.80` 是 annotated tag，peeled commit 精确为 `a801a046c5c2c97da2c21d10698b01a271a25c95`；GitHub Release 已于 2026-08-30 13:10:54（Asia/Shanghai）公开，非草稿、非预发布。
- Release 包含 `Zeus-0.3.80-arm64.dmg` 与 `zeus-release-manifest.json`。DMG 大小为 `115058663` 字节，GitHub 服务端摘要、manifest 和 Homebrew Cask 的 SHA-256 均为 `95445140f76becab54e811130577eeee61789ccb53d472587231d30e50fd87fb`，Cask 版本已更新为 `0.3.80`。
- 重新下载公开 DMG 后，实体文件大小仍为 `115058663` 字节，`shasum -a 256` 得到同一摘要，`hdiutil verify` 返回磁盘映像 checksum valid；本轮没有挂载、安装或启动生产身份应用。
- 当前 checkout 的本地发布恢复状态最初仍停在失败时的 `release_committed`；已根据上述公开 Workflow、CI、标签、资产与 Cask 证据补齐 gate/publish 结果并收口为 `completed`，避免下一次发布误恢复旧版本。该收口只写 `.git/zeus-release/v0.3.80`，没有修改提交、分支、标签或远端。
- 发布 manifest 明确记录 `signed=false`、`notarized=false`，因此本次发布不得描述为 Apple 签名或公证版本。公开发布完成不改变前述验收边界：真实 Telegram Bot API、独立 Test app GUI 与多 Provider 交互仍未在本任务中完成。

## 验收边界

- 不新增、恢复或依赖 Vitest、组件测试、DOM/CSS 契约测试。
- 静态与构建门禁为 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`。
- 真实运行只允许独立身份 `Zeus Test.app`（`dev.hypha.zeus.test`）和本任务独立 `ZEUS_USER_DATA_DIR`；构建、打包、SQLite 探针或 fake Telegram 不能替代真实 GUI / Provider / Telegram 结果。
- 如果没有可用于验收的测试 Bot Token 或测试身份被其他任务占用，必须保留真实 Telegram / GUI 未验缺口，不得冒充完成。

## 真实 Telegram 配对回执修复（2026-08-30）

- 用户首次通过手机相机扫描二维码并在 `@HyphaZeusBot` 私聊点击 Start 后，Telegram 收到“这条 Telegram 请求未能完成”与“未知 IM 命令”两条提示。对正式库只读核对确认：配对已于 14:16:33 成功消费并建立可信端点，连接状态已经是 `active`；失败的是配对成功回执的 `sendMessage`，其网络结果为 `ZEUS_TELEGRAM_COMMAND_OUTCOME_UNKNOWN`。随后 Telegram 发送的不带参数 `/start` 被普通命令解析器拒绝，重复打开原深链则命中“端点已绑定”。本轮未修改正式数据，也未关闭或替换正在运行的正式应用。
- 根因是配对状态变更与成功回执投递处于同一异常边界：可信端点已经耐久建立后，回执网络结果未知仍向上抛出，导致入站 receipt 被误记为失败并尝试发送通用失败提示。该提示不代表配对失败，但会让用户得到相反结论。
- 修复后，配对成功状态不再被欢迎回执的投递失败反向覆盖；回执失败只写入脱敏连接日志 `pairing.welcome_delivery_unconfirmed`，继续保留外发结果未知时不自动重试的边界。同一可信私聊重复打开含参数深链按已完成配对幂等处理，其他用户仍失败关闭；可信私聊中的无参数 `/start` 返回绑定状态与帮助，不再进入未知命令。
- 配对页提示从“使用手机 Telegram 扫码”改为“使用手机相机扫码，在 Telegram 中打开”，避免误导用户寻找 Telegram 内部扫码入口。
- 验证通过：相关文件 Prettier、`git diff --check`、`pnpm lint`、`pnpm typecheck`（126 张 Core 表、11 张辅助表架构治理通过）、`pnpm build` 和 `pnpm package:mac`。打包仅生成测试身份 `Zeus Test.app`，bundle ID 为 `dev.hypha.zeus.test`，deep/strict codesign 通过；构建仍只有既有 `markstream-react` Rolldown 注解与大 chunk 警告。本轮没有启动测试包、没有把修复安装进正式应用，也没有重新执行修复后的真实 Telegram / GUI 往返，因此运行复验缺口继续保留。

## 配对回执修复本地合入 main（2026-08-30）

- 合入前本地 `main=1551239e`，其中保留 ZEUS-0387 冷会话恢复修复；任务来源为 `zeus/ZEUS-0392-im-03@e904207e`。两侧均从已公开发布的 `a801a046` 分叉，提交级共同修改文件为空，`git merge-tree --write-tree` 预演无冲突。
- 任务合并提交 `da005f13` 创建后的最终审计中，`origin/main` 被外部发布流程线性推进为 `d446f215`（`chore(release): v0.3.81`）→ `ffe5ac26`（发布证据）→ `dce0c3b6`（引用校正），共同父提交为 `1551239e`。版本提交只修改桌面包/根版本并新增 v0.3.81 发布说明，后两笔只修改 ZEUS-0387 任务文档；与 IM 修复共同修改文件为空。每次引用推进都重新执行 `git merge-tree --write-tree`，最终链路已完整本地合入，未留下 ahead/behind 分叉。
- `main` 工作区原有本任务文档的未提交 v0.3.80 发布记录。合入时只对该文件建立可恢复的命名 stash，完成 `--no-commit` 合并后恢复并逐段核对；最终文档同时保留发布门禁、公开发布、真实 Telegram 配对回执修复和本次合入记录，没有按 ours/theirs 整侧覆盖。
- 实际 `main` 合并态验证通过：`pnpm lint`、`pnpm typecheck`（126 张 Core 表、11 张辅助表）、`pnpm build`、`pnpm package:mac`、`git diff --check` 与 `git diff --cached --check`。产物仅为 `dist/test/mac-arm64/Zeus Test.app`，bundle ID 为 `dev.hypha.zeus.test`，deep/strict codesign 通过，未生成生产身份 `Zeus.app`。
- 本次授权只执行本地合入，不 push；没有启动测试包、替换正式应用或重新执行修复后的真实 Telegram / GUI 往返，运行复验缺口继续保留。

## 真实 Telegram 命令交互审计与修复（2026-08-30）

- 用户在真实 Telegram 私聊中依次发送 `/task`、`/tasks`、`/start`，结果在约 30 秒后集中返回两份 20 条任务长列表，最后再返回整本帮助。截图上的两份列表不是同一 update 被重复发送：正式库只读证据显示 update `943614963`、`943614964`、`943614965` 均只有一条 processed receipt 和一次 accepted `telegram-send-message`；两份列表分别是裸 `/task` 与 `/tasks` 的回复。本轮只读核对正式库，未修改正式数据或运行中应用。
- 根因一是命令语义重叠：`/task` 缺省 action 被实现为 `list`，与 `/tasks` 完全同义；根因二是 long polling 被外层 `setInterval(30s)` 错误调度，一次 `getUpdates` 因收到消息立即返回后，下一次仍要等待固定时钟，因此会把后续命令积压成一批。
- 截图审计还确认了信息层级问题：`/start` 同时承担状态页和完整手册，首屏没有“当前项目 / 当前会话 / 下一步”；任务列表一次展开 20 条长标题并暴露英文内部状态，用户无法快速区分是响应重复还是两个命令各自生效。截图可以证明可读性与反馈时序问题，但不能单独证明读屏、动态字号或焦点的完整可访问性。
- 修复后，IM 连接改为自调度的连续 long polling：成功轮询在 50 ms 后续接，网络失败才按 2/4/8/16/30 秒上限指数退避；每一代 poller 与自身 timer 绑定，关闭或重建后的旧轮询不会继续排队。优点是收到 update 后可立即续接下一次 long poll；代价是必须显式维护退避与 poller generation，避免网络故障时热循环或旧实例复活。
- 命令层改为单一责任：`/start` 只返回绑定项目、当前会话和下一步；`/help` 按对话/任务分组；裸 `/task` 只显示任务命令用法；只有 `/tasks [页码]` 列任务。任务列表改为每页 8 条，显示总数、页码、中文项目/运行状态、详情与下一页命令。优点是回复可预期且单屏可读；代价是长任务集需要显式翻页。本轮不把普通导航改成一组一次性 capability 按钮，避免与审批、`request_user_input` 和计划确认的安全按钮语义混淆。
- 验证通过相关文件 Prettier、`git diff --check`、`pnpm lint`、`pnpm typecheck`、`pnpm --filter @zeus/telegram-adapter build`、`pnpm build` 和 `pnpm package:mac`；architecture governance 同时通过 126 张 Core 表和 11 张辅助表检查。打包仅生成 `dist/test/mac-arm64/Zeus Test.app`，`CFBundleIdentifier=dev.hypha.zeus.test`、显示名为 `Zeus Test`，deep/strict codesign 通过，`dist` 中没有生产身份 `Zeus.app`；构建仍只有既有 `markstream-react` Rolldown 注解与大 chunk 警告。静态检查、构建和打包不等于真实 Telegram 时序验收；本轮没有替换或关闭正在运行的正式应用，也没有把正式 Bot Token/配对数据复制到独立测试根，因此修复后的真实 `/task` → `/tasks` → `/start` 往返仍待安全安装后复验。

## Telegram 任务原生交互闭环（2026-08-30）

- 用户进一步指出“看到了任务，然后呢”：上一阶段虽然消除了重复语义、延迟批量返回和长列表，但仍把任务当作只读文本打印，要求用户记住任务编号和二级命令，没有形成手机端可发现的操作闭环。上一节“不把普通导航改成 capability 按钮”的取舍因此被本节替代；安全按钮机制本身不是审批专属，关键是 action kind、目标、revision 和副作用确认必须严格区分。
- `/tasks [页码]` 现改为每页 8 个任务按钮与上一页/下一页导航。点击任务后在同一条 Bot 消息中切换为详情卡，提供推送到新会话、存在有效绑定时推送到当前会话、启动/暂停/继续、取消、编辑标题、编辑描述、修改非终态项目状态和返回列表；任务创建与 `/task show` 也直接返回同一详情卡。优点是无需抄任务编号、不会连续刷出多屏正文；代价是按钮 10 分钟有效，过期后需重新发送 `/tasks`。
- 标题或描述编辑采用“点按钮后直接回复文本”，等待输入 capability 可在进程恢复后从 Core 表重建；发送任意命令或点击取消会撤销本次编辑。任务 `updatedAt` 会转换为 expected revision，列表到详情、详情到 mutation 的每一步都重新校验绑定项目和最新 revision；任务已变化时不执行旧操作，只刷新最新详情。
- 取消任务增加二次确认。项目管理状态只允许在 Telegram 选择非终态状态；完成/取消类项目终态可能停止会话、归档资源或清理脏工作区，仍要求回到桌面端完成。优点是保留移动端高频闭环且避免误触清理；代价是终态治理不能完全脱离桌面端。
- Codex 任务已有历史会话时，通用 Runtime `run/continue` 不能替用户猜测要恢复哪一条会话；详情卡不展示一个必然失败的“继续”按钮，而是明确要求回桌面端选择精确会话，同时仍提供“推送到新会话”。优点是不会把新建上下文冒充为恢复旧上下文；代价是“选择历史会话并原地继续”的 Telegram 子流程尚未覆盖。
- callback 后优先使用 Telegram `editMessageText` 更新原消息，新增 `im.telegram.message.edit` External Outbox 命令类型；消息正文、chat 和 message 身份只以摘要进入命令账本，随机 capability token 不进入命令输入。编辑写出后结果未知时继续禁止盲目重放；不具备编辑能力或缺失原消息身份时才降级为发送新卡片。
- 验证通过相关文件 Prettier、`git diff --check`、Local Server 局部 TypeScript 检查、`pnpm lint`、`pnpm typecheck`、`pnpm --filter @zeus/telegram-adapter build`、`pnpm build` 和 `pnpm package:mac`；architecture governance 同时通过 126 张 Core 表和 11 张辅助表检查。构建仍只有既有 `markstream-react` Rolldown 注解与大 chunk 警告。打包仅生成 `dist/test/mac-arm64/Zeus Test.app`，`CFBundleIdentifier=dev.hypha.zeus.test`、显示名为 `Zeus Test`，deep/strict codesign 通过，`dist` 中没有生产身份 `Zeus.app`。本轮没有启动测试包、替换正式应用或操作正式 Telegram 数据，按钮布局、原消息编辑和真实 mutation 往返仍需在独立测试身份中验收，不能以静态或打包结果冒充完成。

## v0.3.83 发布候选任务创建交互修复（2026-08-30）

- `pnpm release` 已在本地创建格式修复提交 `04e9eadd` 和发布提交 `d860bb34`，随后停在本地阻塞级 TypeScript 检查；没有证据表明
  `main`、`v0.3.83` 或公开资产已推送。
- 直接编译错误是任务 capability 解析类型中没有 `await_create`，但恢复逻辑已按该 action 收窄；进一步链路审计发现同一解析器也没有接受首页按钮已生成的
  `task.create.<page>`，因此只增加 TypeScript 联合成员会留下“新建任务”按钮必然失败的运行问题。
- 修复后 `create` 与 `await_create` 使用同一受限解析契约；点击新建后先撤销旧列表 capability，再创建 10 分钟有效的等待输入
  capability，并显示可取消的标题输入提示；进程恢复后可从 Core 表重建该等待状态，返回任务列表会同步清理内存态。
- 优点是同时恢复发布类型门禁和真实新建任务交互；代价是 v0.3.83 必须包含这笔新修复后重新建立候选，不能把已失败的 `d860bb34`
  原样作为最终发布候选。
- 本地验证已通过相关文件 Prettier、`git diff --check`、`pnpm lint`、`pnpm typecheck`、`pnpm build` 和 `pnpm package:mac`
  ；architecture governance 通过 126 张 Core 表和 11 张辅助表检查。打包仅生成 `dist/test/mac-arm64/Zeus Test.app`，bundle
  ID 为 `dev.hypha.zeus.test`，deep/strict codesign 通过；本轮未启动 GUI、未使用真实 Telegram 按钮往返、未提交修复，也未重新执行发布。

## Vibego 源码对照后的任务会话闭环（2026-08-30）

- 用户要求回到 `/Users/david/hypha/tools/vibego` 的真实源码核对交互，而不是继续按命令机器人思路补按钮。Vibego 的有效链路是：任务列表消息直接承载筛选、分页、任务入口和创建入口（`bot.py:19243-19325`）；点击“推送到模型”后先选择现有会话或新建并行会话（`bot.py:24807-24889`）；任务详情通过视图栈恢复原列表/搜索位置（`bot.py:26891-27045`）。它的 `/start` 命令描述写成“打开任务概览”，实际处理器却只发送欢迎语（`bot.py:27442-27454`），因此只采用有源码闭环支撑的任务与会话语义，不照搬这处漂移。
- 对照截图和 Zeus 代码后确认三个结构问题：第一，入口虽已缩短正文，但仍没有可见主动作；第二，任务列表虽可点进详情，却仍要求通过命令创建任务；第三，详情卡的“推送到当前会话”允许任意当前项目会话，随后只改 Telegram binding 的 `taskId`，没有证明目标会话本身属于该任务，存在把 A 任务投递到 B 任务会话并制造错误上下文标识的风险。
- `/start` 和配对成功欢迎页改为同一操作首页：展示绑定项目、当前会话和可识别的任务上下文，并提供“任务列表 / 新建任务 / 会话列表 / 新建会话”四个按钮。优点是用户完成配对后立即知道下一步，不需要先阅读整本命令手册；代价是普通导航也使用 10 分钟一次性 capability，过期后需重新发送 `/start`。
- 任务列表增加“新建任务”。点击后在同一条消息进入标题输入态，可附带任务附件；等待输入 capability 支持进程恢复，发送其他命令或点击取消会清除待办。优点是列表到创建到详情形成手机端连续闭环；代价是首期仍只用标题创建，复杂类型、关系和阶段继续由桌面端治理。
- 详情页把两个立即推送按钮收口为“处理此任务”。下一步先选择“新建任务会话”或该任务自己的、未归档的精确历史会话；任意项目会话和其他任务会话不再作为候选，旧 `/task push-current` 也增加相同身份校验。优点是任务、会话和 Telegram binding 三者身份一致，不会静默污染其他上下文；代价是推送多一步目标选择，且最多展示最近 8 个可用任务会话。
- 本轮以用户提供的真实 Telegram 截图和 Vibego 源码完成交互审计；截图能确认入口层级、操作不可发现和长消息问题，不能单独证明 Telegram 客户端的读屏顺序、焦点或动态字号表现。真实按钮渲染、进程恢复和任务/会话往返仍必须由独立 `Zeus Test.app` 与测试 Bot 验收。
- 验证通过相关文件 Prettier、`git diff --check`、`pnpm lint`、`pnpm typecheck`、`pnpm --filter @zeus/telegram-adapter build`、`pnpm build` 和 `pnpm package:mac`；architecture governance 同时通过 126 张 Core 表和 11 张辅助表检查。打包仅生成 `dist/test/mac-arm64/Zeus Test.app`，`CFBundleIdentifier=dev.hypha.zeus.test`、显示名为 `Zeus Test`，deep/strict codesign 通过，`dist` 中没有生产身份 `Zeus.app`。构建仍只有既有 `markstream-react` Rolldown 注解与大 chunk 警告；本轮没有启动应用、替换正式应用或操作正式 Telegram 数据，运行验收缺口继续保留。

## 正式版本首页按钮故障复盘（2026-08-31）

- 用户在真实 Telegram 中发送 `/start` 后能看到“任务列表 / 新建任务 / 会话列表 / 新建会话”四个首页按钮，但点击“任务列表”立即同时出现系统弹窗和聊天消息“该交互已不再受支持”。只读现场确认正式进程运行 `/Applications/Zeus.app` 0.3.84；其 `app.asar` 已包含 `home.tasks`、`home.new_conversation` 等首页 capability token，却不包含当前实现的“已打开任务列表”处理分支文本。因此这不是用户误操作或单纯按钮过期，而是正式包只带入口、没有带齐 callback 处理器的版本撕裂。
- 当前任务分支 `e6f76ecb` 已包含首页 callback、任务创建和任务精确会话选择的完整处理器，但该提交没有安装到正在运行的正式应用；代码存在不等于线上已修复，仍需进入正式发布、安装与真实 Telegram 复验链路。
- 同一句错误出现两次来自异常路径自身：callback 失败时先发送普通聊天错误，再调用 `answerCallbackQuery(showAlert=true)` 弹窗。现改为 callback 优先只弹一次；只有 callback 回答自身失败时才降级发送普通聊天消息。优点是避免重复噪声，同时保留 Telegram 无法显示 callback 弹窗时的可见兜底；代价是 callback 错误不再永久留在聊天历史中，需要依赖脱敏连接日志排障。

## 正式发布集成（2026-08-31）

- 用户明确授权“提交并发布”。发布集成以最新 `origin/main=4c83e3c9`（v0.3.84 发布记录）为基线，没有直接发布落后于主线的任务分支，也没有把共享测试分支的其他任务带入候选。
- 主线已包含半成品入口提交 `5a3fa813`，并在 v0.3.83 阶段补过 `create/await_create` 解析与恢复；任务分支新增完整首页 callback、任务会话精确选择和单次错误反馈。`git merge-tree --write-tree` 预演准确报告服务文件与本文档冲突，集成时保留主线任务创建恢复和格式治理，并联合加入 `home.*`、`task.push_menu`、`task.push_existing` 与任务/会话身份校验，没有按任一侧整文件覆盖。
- 首轮集成 `verify:publish` 发现两侧各自定义 `taskCreatePromptView`，TypeScript 以 `TS2393` 阻断候选。语义审计后保留支持附件、与“新建任务”交互文案一致的实现，移除被替代的旧实现；重新执行完整 `pnpm verify:publish` 通过，包括冲突残留、Git 空白、只读网络重试探针、Prettier、ESLint、126/11 架构治理、TypeScript 和生产构建。构建仍仅有既有 `markstream-react` Rolldown 注解与大 chunk 警告。
- 上述门禁是集成候选的静态与构建证据，不等于真实 Telegram 已恢复；只有公开发布、安装新版本并重新发送 `/start` 生成新按钮后，才能复验首页、任务创建、精确会话选择与异常单次反馈。

## v0.3.85 公开发布完成（2026-08-31）

- `pnpm release` 从干净隔离 `main@a05a3d9a` 完成端到端发布，生成发布提交 `fe6b1c4c7701824be332ccd45d2bafad25429933`。`origin/main`、annotated tag `v0.3.85` 和 Release Workflow `33343277201` 的固定候选 SHA 完全一致；Workflow 的 preflight、typecheck、package-mac 与 publish 作业全部为 `success`。
- GitHub Release `v0.3.85` 已公开，非草稿、非预发布。公开资产为 `Zeus-0.3.85-arm64.dmg`（115166670 字节，SHA-256 `76095c862e4cd9380fefc6a3cc728ffb18a08841971a210223723b8ee8a5f92f`）和 `zeus-release-manifest.json`（1047 字节，SHA-256 `9d62bc3623d3eb83da370869164276767d9152dcf46993ad79fa0b7940436d18`）；GitHub 服务端摘要、manifest 和 Homebrew Cask 已完成一致性对账。
- manifest 明确记录 `signed=false`、`notarized=false`，因此本版本仍不能描述为 Developer ID 签名或 Apple 公证版本。快速发布模式未重新下载完整公开 DMG，但正式 DMG 在上传前已通过 `hdiutil verify`。
- 本轮没有替换或重启正在运行的 `/Applications/Zeus.app` 0.3.84，也没有操作正式 Telegram 数据。真实 Bot 仍需安装 v0.3.85、重启 Zeus，并重新发送 `/start` 生成新 capability 后复验；旧消息中的一次性按钮不会因发布自动变成新版处理器的有效按钮。
