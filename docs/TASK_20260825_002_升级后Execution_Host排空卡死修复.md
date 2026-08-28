# TASK_20260825_002 升级后 Execution Host 排空卡死修复

## 任务目标

修复正式 Zeus 从 0.3.52 升级到 0.3.53 后，旧 Core 已进入持久化交接但新版 Renderer 把短暂的 `ZEUS_EXECUTION_HOST_DRAINING` 当成致命启动失败，最终同时显示业务错误卡和 macOS“Zeus 无法启动”系统弹窗的问题。

## 正式现场证据

- `/Applications/Zeus.app` 已是 0.3.53；新版 Main PID `63750` 于 2026-08-25 12:49 启动。
- 当时仍由 0.3.52 Core PID `58113` 持有正式数据根唯一宿主租约；`host.lock`、`rendezvous.json` 与 `startup.json` 均指向同一 generation `9b5905b2-8d35-46f7-83a0-cb27c2cc9dd1`。
- 交接账本 `execution_host_handoff_815ab13b-58b5-49c8-b592-0980207654e5` 于 12:49:05 创建、12:49:24 进入 `prepared`，请求数为 0；说明正式 15 GB 数据库的安全冻结和持久化准备真实耗时约 19 秒。
- 0.3.53 Main 对 prepare 只等待 10 秒，Renderer 刷新连接只等待 8 秒。旧 Core 已关闸但新宿主尚未发布时，Dashboard/Settings 首屏读取收到 `ZEUS_EXECUTION_HOST_DRAINING`，Renderer 随即上报 fatal startup。
- fatal 路径调用同步系统错误弹窗，Electron Main 事件循环被弹窗阻塞，1 秒心跳停止；旧 Core 在 30 秒后记录 `ui_lease_expired`，再于 12:50:04 进入 `detached_idle` 关闭。
- 旧 Core 的关闭在 30 秒后记录 `execution_host.close_failed` 并退出，OS 已释放唯一 writer 租约；但 0.3.53 Main 已处于 fatal 状态，不会在旧进程退出后恢复。旧关闭日志只保留聚合错误标题，无法判断具体失败阶段。
- 正式数据库只做 immutable/只读查询，没有由诊断命令写入；本阶段未删除锁、账本或发现文件，也未强杀活动宿主。

## 实现取舍

- 新 Main 在把业务配置交给 Renderer 之前主动完成一次“旧版本且无执行工作”的安全交接。优点是首屏不会与关闸窗口竞争；缺点是大库升级时启动页会多等待持久化准备所需时间。
- durable handoff prepare 的 Main 等待上限从 10 秒调整为 60 秒，仍保留 SQLite journal、单飞 promise、45 秒退出和 120 秒新宿主发布等既有边界。优点是覆盖正式大库的 19 秒现场；缺点是交接底层真实故障会更晚返回，但不会无限等待。
- `refreshConfig` 等待当前有界 handoff 真正收口，不再以更短的 8 秒窗口返回 draining 旧端口。Renderer 仍对实际收到的 `ZEUS_EXECUTION_HOST_DRAINING` 做最多 120 秒的有界水合恢复，且不进入 Main 的 fatal 系统弹窗路径。
- Execution Host 关闭聚合错误增加阶段名与递归原因摘要。优点是下次能区分 Runtime、HTTP 控制面、发现身份或 kernel lease 失败；缺点是日志略长，因此统一截断到 2000 字符。

## 阶段记录

- 2026-08-25：完成正式现场只读取证，确认问题是“交接真实耗时超过 Main/Renderer 短等待窗口 + fatal 同步弹窗阻断心跳”的闭环竞态，不是安装包损坏，也不是第二数据库写入者。
- 2026-08-25：完成 Main 交接顺序、持久化 prepare 上限、Renderer draining 恢复与关闭阶段诊断的源码修改，进入静态门禁、隔离宿主和 `Zeus Test.app` 真实运行验证。

## 验证记录

- `pnpm lint`、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 通过；架构门禁仍为 88 张 Core 表和 11 张可重建辅助表。
- `pnpm verify:detached-host` 通过：跨版本持久化交接、旧宿主退出、Pi waiting 预检阻断、Codex waiting 恢复、未来协议维护和数据库 `quick_check=ok` 全部收敛。探针同时修正了旧断言：Pi waiting 在 durable journal 与副作用闸门之前阻断，因此不会凭空新增 `aborted` 账本。
- `pnpm package:mac` 通过，生成 `dev.hypha.zeus.test` 的独立 `Zeus Test.app`；严格签名结构检查通过。测试包为 ad-hoc 签名且未公证，不作为正式签名证据。
- 使用正式 15 GB SQLite 的 APFS 隔离副本、测试数据根和两个独立测试包复现跨版本现场：旧 Core 为 `0.3.52`，新 Main/Core 为 `0.3.53`。旧 Core 于 13:05:46 完成 `upgrade_handoff` 并退出，新 Core 于 13:06:07 才发布 `ready`，完整切换约 21 秒，真实超过旧版 8/10 秒窗口。
- 上述 21 秒交接期间新 Renderer 保持启动页，交接完成后任务工作台、侧栏和完整数据正常出现；没有 `ZEUS_EXECUTION_HOST_DRAINING` 错误卡、没有 macOS“Zeus 无法启动”弹窗、没有停止按钮假死。随后正常退出时新 Core 记录 `final_quit/closed`。
- 隔离测试结束后，测试应用、测试数据根和 APFS 数据库副本已移入 `/Users/david/.Trash/Zeus-upgrade-regression-20260825-1307`，可恢复；正式数据库未被测试写入。
- 正式 v0.3.53 现场通过正常关闭旧错误弹窗、退出并重新打开恢复：原 `prepared` 交接账本被精确完成，新正式 Core PID `72144` 写入 `ready/ui_attached`，正式任务工作台恢复可用。恢复未删除锁、未手工改账本、未强杀正式 Core。
- 本补丁只调整 Execution Host 启动交接、Renderer 暂态恢复和关闭诊断，不改动上一主任务的移动端水位同步、完成态投影、任务历史、环境卡、代码审查、RPC 全双工和图片持久化逻辑；完整 12 项复核矩阵继续以 `TASK_20260825_001_会话同步完成态任务历史与审查启动修复.md` 为主记录。

## 发布记录

- 修复提交：`67de2aa3556f10ea8bde82f8b767e2c17e43e065`；发布提交：`a85ea99be5862d3b5eb4fc6a89b7dae35f8db890`。
- `v0.3.54` Release Workflow `32811731804` 完成且结论为 `success`；`preflight`、`typecheck`、`package-mac`、`publish` 四个作业全部通过。
- 远程标签 `v0.3.54`、正式 GitHub Release、公开 DMG、manifest、Release notes 与 Homebrew Tap Cask 已完成一致性对账。
- 公开 DMG `Zeus-0.3.54-arm64.dmg` 为 `112353132` 字节，SHA-256 为 `c0ffd307c6629568dea77b17e859a714fd79af22acab41d2765a22ac95ff0dbb`；manifest SHA-256 为 `7f8259a953420c0f695d2d1e036b4e26b52f7696175e10629ab2cf47ed7ea33f`。
- manifest 如实标记 `signed=false`、`notarized=false`，因此不宣称 Developer ID 签名或 Apple 公证；正式 DMG 在上传前已通过 `hdiutil verify`。
- 已通过 Homebrew 把日常正式安装从 0.3.53 升级为 0.3.54。Homebrew 正常退出旧应用、替换 `/Applications/Zeus.app` 并重新打开；新正式 Core PID `28628` 在大库初始化约 26 秒后记录 `ready/ui_attached`，正式任务工作台完整可操作，没有 `DRAINING` 错误卡、系统“无法启动”弹窗或持续转圈。
