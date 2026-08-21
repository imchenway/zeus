# ZARCH-041 Renderer API 物理拆分

## 结论

Renderer 的本机 API 入口已从单个 `apiClient.ts` 物理拆为 bounded-context contracts、领域 client、统一 transport 和一个短小组合根。原有 `./apiClient.js` 导入路径、`createDashboardClient`、`DashboardClient`、`ZeusApiError`、公共 contracts 与运行行为保持兼容；未改视觉、产品语义、正式 Provider、正式数据库或云同步。

## 实施清单

- [x] 将 `apiClient.ts` 从 2,910 行收敛为 47 行稳定兼容入口，只做公共再导出。
- [x] 新增 100 行 `dashboardClient.ts` 作为唯一 DashboardClient 组合根。
- [x] 将 contracts 按 Dashboard、Codex、Conversation、Git、Graph、Integration、Project、Release、Remote、Runtime、Settings、Task、Telegram 与 Transport 归属拆分；单文件最大 230 行。
- [x] 保留原有 291 个 `DashboardClient` 唯一属性，包括 7 个嵌套领域入口、`connectEvents` 与 `subscribeEvents`。
- [x] 将旧门面剩余实现拆到 Dashboard、Codex、Command Center、Graph、Runtime 五个 client；新增 client 最大 374 行。
- [x] 既有 Conversation、Project、Task、Git、Settings、Remote、Integration、Telegram client 改为直接依赖自有 contracts，不再反向依赖兼容门面。
- [x] 所有领域 client 继续消费唯一 `LocalApiTransport`；没有新增 `fetch`、重试、token、trace 或 WebSocket 协议实现。
- [x] 将事件重连退避移入 `localApiEventSubscription.ts`，仍复用 transport 的连接与 token。
- [x] 架构治理增加硬门禁：兼容门面最多 80 行、组合根最多 160 行、领域 client 最多 500 行；领域 client 禁止导入兼容门面或直接调用 `fetch`。
- [x] 命令副作用审计改为读取新的物理实现集合，203 个入口继续完整覆盖。

## 依赖方向

允许方向：

`页面/旧调用者 -> apiClient 兼容入口 -> dashboardClient 组合根 -> bounded-context client -> LocalApiTransport`

领域 client 的类型依赖只指向本领域 contracts 或明确的上游值对象，不再通过 `DashboardClient` 的 `Pick` 反向推导。这样避免 `apiClient -> feature client -> apiClient` 的类型环，也避免拆出第二个巨型 facade。

## 收益

- 修改一个领域的 API contract 或 HTTP 映射时，不再触发 2,910 行共享文件的冲突与审阅噪声。
- 依赖方向可由脚本验证，后续新增领域调用无法悄悄把 `fetch`、重试或鉴权复制到页面层。
- 小模块降低 TypeScript/ESLint 增量分析和人工定位成本；稳定入口让现有调用者无需大规模迁移。
- 运行时代码仍由一个组合根创建一个 transport，不增加请求层级、网络往返或状态副本。
- 按 React bundle 规范，叶子实现直接导入所属 contracts/transport；兼容 barrel 只承担稳定 API，并未成为领域实现的反向依赖。

## 缺点与代价

- 文件数增加，首次查找某个类型或方法需要按 bounded context 导航；通过稳定入口与一致命名降低该成本。
- `DashboardClient` 仍是兼容性较宽的聚合接口，不能直接带来按页面动态加载；若未来要进一步缩小 bundle，需要调用方逐步改为直接领域 import，此次不擅自扩大范围。
- contracts 之间仍存在少量单向跨领域类型引用，例如 Task 的运行结果引用 Runtime/Graph 值对象；门禁保证没有回到兼容 facade，但后续领域模型变化仍需审阅这些显式依赖。
- 物理拆分本身不证明真实 GUI 每个工作流均无回归；本阶段只有静态、构建与结构审计证据。

## 验证证据

- `pnpm lint`：通过。
- `pnpm typecheck`：通过，包含 architecture governance 与全仓 TypeScript project references。
- `pnpm --filter @zeus/desktop build`：通过；Vite 转换 1,249 个模块，Preload/Main TypeScript 构建通过。
- `pnpm verify:architecture`：通过；同时确认 87 个 Core 表和 11 个可重建辅助表治理未回退。
- `node scripts/audit-command-side-effect-entries.mjs --require-complete`：通过，203/203，`complete=true`。
- TypeScript compiler API 解析 `DashboardClient`：291 个属性、291 个唯一属性；7 个嵌套 client、`connectEvents`、`subscribeEvents` 均存在。
- `git diff --check`：通过。

## 残余验收边界

- 未执行独立 `Zeus Test.app` 的真实 GUI 回归，因此不能宣称 Dashboard、Task、Graph、Runtime、设置与实时事件的可视交互已经全部验收。
- 未对正式 Provider 或正式数据库执行任何读写；本改造不需要也不授权这些动作。
- 未实施 iCloud/Google 多设备同步；该用户功能需求仍因产品语义未明确而延后。
