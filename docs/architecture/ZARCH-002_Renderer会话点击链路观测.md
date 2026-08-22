# ZARCH-002 端到端性能 trace 与有界观测

## 当前结论

会话行点击会创建一个不含标题或正文的短期 trace identity。只有目标会话的精确 Snapshot V2 pathname 可以继承该身份；公共 transport 把同一 ID 写入 `x-zeus-trace-id` 和 API 性能 span，V2 水合开放首帧门后，下一次 React Profiler commit 与双 `requestAnimationFrame` 首内容帧继续使用同一 ID。Core 只接受规范 UUID 或 32 位十六进制身份并统一为小写；其他输入由 Core 换成随机 UUID，避免调用方把邮箱、任务号等载荷编码进观测投影。并发活动请求复用同一身份时，后到请求也会取得新 UUID；客户端断连由 raw `aborted/close` 生命周期幂等释放身份，不依赖不会触发的 `onResponse`。Fastify `onRequest` 在当前请求的异步作用域内把校验后的身份传给 Storage，同一作用域内的 SQLite `select`、`execute`、`transaction`、`commit` 与 `checkpoint` 样本继承该身份。完成或 60 秒过期后 Renderer identity 被清除，不进入会话 JSONL、localStorage 或长期 Memory。

`window.__zeusPerformanceSnapshot()` 只读暴露 2,048 条有界内存样本，并直接返回 `conversationNavigationLatency.sampleCount/p50Ms/p95Ms/p99Ms`。Core API 与 SQLite 各自最多保留 4,096 条内存样本。API 样本只含路由模板、方法、状态、耗时与响应字节；SQLite 样本只含 trace ID、操作类型、schema 标识符、不可逆 SQL 指纹、耗时、返回/变更行数和成功状态，不保存 URL 参数、SQL 文本、SQL 参数、请求体、响应体、DOM、用户输入或会话正文。Node `node:sqlite` 没有公开 `sqlite3_stmt_status`，所以运行时扫描行数保持 `null`，由离线只读 `EXPLAIN QUERY PLAN` 门禁补充，禁止用返回行数冒充扫描行数。

## Provider 边界

Provider 命令、内部 RPC 与回执现已使用同一可选短期身份：

审计现场为 `packages/shared/src/commandEnvelope.ts`、`packages/storage/src/commandDeliveryStore.ts`、`packages/local-server/src/codexProviderCommandApplication.ts`、`packages/local-server/src/piProviderCommandDelivery.ts` 与 `packages/ai-runtime/src/codexAppServerManager.ts`。

- `CommandEnvelope.traceIdentity` 可缺失或为 `null`，非空时只接受规范 UUID 或 32 位十六进制并统一为小写；旧 v1 信封缺失该字段时继续可读。它不参与 command ID、幂等键或业务状态机，也不能携带用户可读标识。
- Codex/Pi Provider Application 优先使用调用方显式身份，否则读取当前 Fastify/SQLite 异步作用域；既有命令重放沿用最初持久身份，不把后来的 HTTP 请求误接到旧 attempt。
- Codex manager 把身份绑定到内部 pending RPC，但明确从 app-server params 删除；Codex wire `requestId` 仍是 Provider 身份。Pi Worker 请求、响应、反向接纳与 Provider 载荷回执逐帧携带并核对相同身份，串线时失败关闭。
- accepted、failed-before-write、explicitly-rejected 与 outcome-unknown receipt 的有界 evidence 均带同一字段；它只用于诊断关联，不能作为“Provider 只执行一次”的证明。

## 行为证据

内存 fake fetch + 真实 transport/collector 探针得到：点击 trace、Snapshot V2 请求头、API span、React commit 与 `conversation_first_frame` 的 trace ID 全部相等；单样本现场的 P50/P95/P99 均为 18ms。该数值只证明链路和分位数投影可读，不是正式 SLO 结论。

`pnpm exec tsx scripts/verify-performance-trace-behavior.ts` 使用临时 Fastify 和临时 SQLite：两个携规范 UUID 的异步交错请求各产生 2 条且只命中自身 schema target 的 SQLite 样本；请求外后台查询的 `traceId` 为 `null`。含邮箱形态载荷的不可信 header 会被替换，API/SQLite 投影均不保留原值；真实 `127.0.0.1` HTTP 请求在 handler 运行中断连后，同一 UUID 可再次使用，证明活动集合没有依赖 `onResponse` 泄漏。探针把容量压到 5 并写入更多查询后仍只保留 5 条；序列化样本没有出现探针 SQL 文本、SQL literal 或两个参数正文，字段集合固定为 trace、操作、schema 标识符、指纹和数值指标。该脚本已纳入 `pnpm verify:zarch-gates`，并先构建 Storage 以核对 Local Server 使用的真实包导出。

真实 P50/P95/P99 仍必须在独立 `Zeus Test.app`、独立 `ZEUS_USER_DATA_DIR` 下覆盖热会话、冷会话、100k 历史、长流与重连场景；本任务没有启动正式应用或读取正式数据。

## 收益与缺点

- 收益：一次点击可跨 API、SQLite、React commit 和首帧精确关联，能区分网络等待、数据库调用与 Renderer 提交，不靠正文或永久日志排障；AsyncLocal 传递不需要给每个 Repository 增加 trace 参数。
- 缺点：Core/Renderer 重启后样本丢失，无法做长期趋势分析；每次数据库操作增加一次高精度计时、指纹计算和有界数组维护，虽不随历史增长，仍有小幅 CPU 成本。
- 缺点：单一 active navigation trace 会让快速连续点击只保留最新目标，符合可见页面语义但不适合离线全量行为分析；后台任务按 `null` 聚合，不能追溯到触发它的历史请求；非规范第三方 trace header 不再端到端原样回显。
- 风险：Profiler commit 只说明 React 已提交，双 RAF 是首内容帧近似值；SQLite 返回行数不是扫描行数；短期 trace 能关联阶段但不能证明 Provider exactly-once。正式验收仍要结合真实 DOM 可见性、长任务、只读历史副本与 Provider 现场观察。
