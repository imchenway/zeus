# ZEUS-0426 低版本无法升级到最新 Zeus

## 任务目标

修复 Zeus 应用内 Homebrew 升级被执行宿主协议号阻断的问题：无论目标版本是否切换执行宿主协议，已具备本修复的 Zeus 都应能直接下载、安装并切换到最新版本，同时不允许新旧不兼容宿主并发访问同一数据目录。

## 现场与根因

- 截图中的旧版是 `0.3.11`，其 `executionHostProtocolVersion` 为 `1`。
- 2026-09-01 的公开最新 Release 是 `0.3.92`，公开 manifest 的协议号为 `2`。
- `v0.3.28` 仍使用协议 `1`，`v0.3.29` 起使用协议 `2`。
- Homebrew 升级服务在下载前要求 manifest 协议号与当前 App 完全相等，不相等就抛出“新版 Zeus 与当前执行宿主协议不兼容，不能继续升级”。

协议号描述的是新 App 能否继续使用旧 Core，不是 Homebrew 能否安装新 App。原逻辑在安装层拒绝跨协议升级，将两个不同职责错误绑定，造成协议切换后的永久升级断层。

## 实现

1. 移除 Homebrew 预取前的协议号严格相等门禁。平台、当前 App 版本、CPU 架构、Homebrew receipt、Cask 路径、版本、文件大小与 SHA-256 校验全部保留。
2. Homebrew 安装完成后，更新控制器将目标协议号传给退出编排。
3. 目标协议相同时继续使用 `upgrade_handoff`：旧 Main 只解除租约，新 App 复用原 Core。
4. 目标协议不同时使用新的 `upgrade_shutdown`：先停止活动工作，再有界关闭旧 Core；超时时仅对已验证进程身份执行强制收口。
5. 原生更新 helper 仍等待旧 Main PID 退出，并复验安装路径、bundle ID 和目标版本后才打开新 App。跨协议清理失败时保留旧 Main，helper 不会越过它启动新版本。

## 取舍

优点：复用现有 Homebrew Cask 下载、SHA-256 复验、安装和原生 helper 链路；只在 Main/Core 交接语义上区分同协议与跨协议，不引入新升级器或动态更新服务。

缺点：跨协议升级不能保留正在运行的旧 Core；若存在活动工作，仍需用户确认停止后才安装。这是避免不兼容宿主并发写数据的必要边界，不能为“无感”升级而删除。

## 已发布旧版的不可追溯边界

`0.3.11` 本身已包含硬阻断代码，新版源码无法远程改写用户已安装的旧二进制。因此：

- 本修复进入正式版本后，该版本及之后不会再因未来协议切换而被卡住。
- 已经停留在 `v0.3.28` 及更早版本的用户，仍必须完成这一次外部 `brew upgrade --cask imchenway/tap/zeus`，或用最新 DMG 覆盖安装。
- 将公开静态 manifest 临时改回协议 `1` 会同时阻断协议 `2` 存量客户端，且仍无法保证旧 Core 安全关闭，因此不采用。

## 验证记录

- `pnpm typecheck`：通过，包含架构治理检查。
- `pnpm lint`：通过。
- `pnpm exec tsx scripts/verify-main-command-ledger-behavior.ts`：通过，退出清理的重试、错误聚合和只读验收语义未退化。
- `pnpm verify:execution-host-legacy-lock`：通过，旧宿主锁、数据根身份与并发启动收敛未退化。
- 跨协议升级源码不变量检查：通过，确认 Homebrew 不再硬阻断、目标协议已传入退出编排，且 `upgrade_shutdown` 会关闭旧 Core。
- `pnpm package:mac`：通过，仅生成 `dist/test/mac-arm64/Zeus Test.app`；其 bundle ID 为 `dev.hypha.zeus.test`，版本 `0.3.92`，`codesign --verify --deep --strict` 通过。
- `pnpm verify:detached-host`：未通过，在进入本次修改的 `close(mode)` 路径前，既有“跨版本 Main 连接活动旧宿主时必须显示 `draining_previous`”断言失败；单独重跑仍失败，不计入本任务通过证据。
- 未执行真实 Homebrew 替换验收：该动作会修改日常正式 `/Applications/Zeus.app`，不属于任务 worktree 安全验证范围。

## 阶段记录

- 2026-09-01：完成当前 worktree、公开 Release、公开 Homebrew Cask、`0.3.11` 源码和协议切换标签的取证。
- 2026-09-01：完成 Homebrew 跨协议下载放行、目标协议传递、旧 Core 安全关闭与失败保护。
- 2026-09-01：完成静态检查、构建、辅助行为验证与独立测试身份打包；未执行 commit、push、merge 或发布。
