# ZEUS-0337 Zeus 启动反复弹出代码审查恢复错误

## 任务信息

- 类型：缺陷。
- 用户现象：每次打开 Zeus 都弹出“本地操作失败”，错误来源为 `native-code-review-recovery`，原始信息为 `The code review source conversation does not belong to this task.`。
- Git 边界：未经用户明确要求，不执行 commit、push、merge 或 revert。
- 运行边界：不修改或启动正式身份 `Zeus.app`；如需真实运行，只使用独立身份 `Zeus Test.app` 和独立用户数据目录。

## 根因

代码审查创建前会把完整启动信封写入 `localStorage`，只有收到持久接受结果后才删除。这个机制用于在网络中断或响应丢失时复用同一幂等身份，避免重复创建会话。

本次历史信封中的来源会话已不属于信封记录的任务。Local Server 以 HTTP 400 和 `ZEUS_TASK_EXECUTION_CONTEXT_INVALID` 明确拒绝请求，证明本次创建没有发生；Renderer 却没有区分“服务端明确拒绝”和“结果未知”，仍永久保留信封。应用启动恢复逻辑随后每次读取并重发同一请求，于是每次打开都产生同一个全局错误弹窗。

## 修复决策与取舍

### 采用方案

1. 保留 Local Server 的来源会话、任务、项目、环境和工作区归属校验，不放宽安全边界。
2. HTTP 4xx 且 `recoveryRequired=false` 视为确定性拒绝，删除对应待启动信封；用户下一次显式操作会生成新的幂等身份。
3. 自动恢复遇到历史确定性拒绝时静默收敛任务加载态，不再把旧操作失败提升为本次启动的全局错误。
4. 网络错误、HTTP 5xx 和 `recoveryRequired=true` 继续保留原信封，避免在结果未知时创建重复会话。
5. 代码审查入口在 Renderer 再次核对当前会话与当前任务、项目归属，避免页面切换期间把错位对象写成新的恢复信封；服务端仍是最终权威。

### 优点

- 旧的无效代码审查请求只收敛一次，不再污染后续每次启动。
- 结果未知场景继续复用原幂等身份，不牺牲防重复创建能力。
- 不修改正式业务数据库、会话归属或 Provider 线程。

### 代价

- 确定性拒绝后不会自动重试；用户修正现场后需要重新点击“开始代码审查”。这是有意行为，因为旧请求的来源身份已经失效。
- 自动恢复不再为历史 4xx 弹全局错误；诊断依赖原始显式操作反馈和本任务记录，而不是每次启动重复提醒。

## 实现范围

- `apps/desktop/src/renderer/App.tsx`
  - 增加确定性启动拒绝判定。
  - 显式创建失败时清理确定性拒绝对应的信封，同时保留当次错误反馈。
  - 启动自动恢复失败时清理历史确定性拒绝并静默结束，不再记录 `native-code-review-recovery` 全局错误。
- `apps/desktop/src/renderer/session/SessionWorkspace.tsx`
  - 启动代码审查前复验当前会话与当前任务、项目一致。

## 验证记录

- `pnpm exec prettier --check apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/session/SessionWorkspace.tsx docs/ZEUS-0337_Zeus启动反复弹出代码审查恢复错误.md`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过；Vite 仅报告仓库既有的大 chunk 提示。
- `pnpm package:mac`：通过，生成独立测试身份 `dist/test/mac-arm64/Zeus Test.app`。
- 包身份复验：`CFBundleIdentifier=dev.hypha.zeus.test`，`CFBundleName=Zeus Test`，`codesign --verify --deep --strict` 通过。
- 未启动正式 `Zeus.app`，未读取或修改正式用户数据，未执行真实 Provider 任务。
- 本次没有把打包成功表述为真实 GUI 已验收；“带历史失效信封启动一次后不弹错且信封被删除”的完整动态证据仍需在独立测试数据目录中构造该历史状态后验证。
