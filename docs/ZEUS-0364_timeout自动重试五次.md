# ZEUS-0364 timeout 自动重试五次

## 任务目标

- 仅对显式列入白名单的 Codex app-server 幂等只读 RPC，在返回 `ZEUS_CODEX_RPC_TIMEOUT` 时自动重试五次；首次请求加五次重试，共最多六次尝试。
- 单次尝试最多约四秒，指数退避约为 200、400、800、1600、3200ms，并加入正负 10% 抖动；整条逻辑读取使用约三十秒硬截止时间。
- 重试中按 Codex 的信息层级显示“正在重试… n/5”，五次耗尽后继续显示最终原始错误。
- 修复创建失败错误被压成逐词换行、重试按钮被拉伸占满剩余宽度的问题。

## 已确认边界

- 只读 RPC 使用显式白名单和精确错误码双闸门，不能按方法名猜测，也不能把进程重启或其他传输错误混入本任务。
- `account/read` 只有 `refreshToken !== true` 时允许重试；显式刷新、`initialize` 以及 start、resume、archive、set、clear、enable、disable、import、revoke、turn 和 server response 等写入或控制操作禁止自动重发。
- 现有同世代缓存、账户与用量请求合并、stdout 全双工读取窗口和唯一 RPC request id 保持不变；旧尝试的迟到回包不能接管新尝试。
- 任务推送能力查询继续与 Provider 账户读取解耦，不能因本任务重新把 `account/read` 放回 Git/Worktree 热路径。
- 最终失败继续遵守全应用“错误码 + 原始消息”单行直出，不新增友好摘要或技术详情层。

## 实施设计

- AI Runtime 新增 `CodexRpcRetryProgress` 与可选操作上下文。安全读取每次 timeout 后广播 retryAttempt 1 到 5、maxRetries、方法、延迟和上下文。
- Local Server 只把不含凭据的重试进度投影为临时 `codex.rpc.retrying` 实时事件。
- Renderer 在请求 body 准备完成、真正发出前保存命令 `operationIdentity`；只有实时事件与当前 pending 操作身份一致时才更新重试进度。
- 创建状态新增 `retrying`：使用礼貌 live region，不显示错误和按钮；耗尽后切到 assertive error，并显示紧凑手动重试按钮。
- 失败布局使用可换行弹性行：原始错误优先获得整行宽度，按钮保持内容宽度；窄容器中按钮换到下一行右对齐。

## 方案取舍

- 优点：瞬时只读 timeout 可以自动恢复，用户看到真实次数，总等待时间有界。
- 代价：真正慢的只读调用可能被四秒单次窗口提前判定为 timeout，并产生最多六个安全重复请求；写入 timeout 仍必须按未知结果保守处理。

## 阶段记录

- 2026-08-28：确认 worktree `/Users/david/hypha/.zeus-worktrees/zeus-e2e-oBLuqT/d1fa961463c3f628a5a0/ZEUS-0364`、分支 `zeus/ZEUS-0364-timeout-01`、基线 `46e96f79da88351cac93f3ec45716ff5e0c61921`，工作区干净。
- 2026-08-28：完成历史任务文档、AI Runtime RPC、Local Server 实时事件与 Renderer 创建失败夹具的只读核对，进入实现阶段。
- 2026-08-28：完成白名单重试器、跨世代进度订阅、Local Server 临时事件、任务推送操作身份匹配与 `retrying` UI；写操作仍只经过原始 RPC。
- 2026-08-28：完成错误栏弹性换行、紧凑按钮和桌面/320px 窄容器 QA 场景，并增加独立 `?timeout-retry=1` 入口。
- 2026-08-28：完成运行探针、工程门禁与测试身份打包，进入本地合入阶段；唯一 `main` 工作树 `/Users/david/hypha/zeus` 基线为 `cbbfb63a4b12898bcbc25fe5c636390bf1d955df`，核对时工作区、索引和合并状态均干净。

## 验收记录

- 仓库外手工 app-server stub 探针：前五次 timeout、第六次成功时恰好六次 `account/read`，进度完整覆盖 `1/5` 到 `5/5`，首个请求的迟到回包未命中后续请求。
- 同一探针：六次均 timeout 时恰好六次请求，实测 `30000ms` 返回 `ZEUS_CODEX_RPC_TIMEOUT: Codex app-server request timed out: account/read`；非 timeout 错误 `1ms` 内单次失败。
- 同一探针：`thread/start`、`turn/start`、`account/read { refreshToken: true }` 都只发送一次；两个并发非刷新型账户读取共享一条重试链，总请求数仍为六。
- 工程门禁：`pnpm lint`、`pnpm typecheck`、`pnpm build` 均通过；`pnpm package:mac` 通过并生成 ad-hoc 签名、bundle ID 为 `dev.hypha.zeus.test` 的 `dist/test/mac-arm64/Zeus Test.app`。
- 浏览器真实 DOM 首次快照已看到“正在重试… 3/5”和宽/窄两组最终原始错误；重试节点正向检查为 `role=status`。其后 Zeus 内置浏览器控制通道持续无响应，交互、截图及完整 `aria-live` 正向选择器尚未闭环，未以外部 Playwright 替代。
- 真实 GUI 尚未启动：现场已有 ZEUS-0327 与 ZEUS-0352 两个其他任务的 `Zeus Test.app`，本任务按隔离约束排队，不关闭、不复用；启动时将使用独立 `ZEUS_USER_DATA_DIR` 和 `ZEUS_TEST_DISPLAY_ID=3`，确保首窗直接创建在非主外接屏。
