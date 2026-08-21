# ZARCH-040～042 模块化与 Storage 所有权门禁

## 结论

本轮完成 Local Server 全量结构收口：会话 Snapshot/耐久增量、Memory/Context、Project/Work Management/Runtime/代码智能查询，以及 Project/Task 命令、平台路由、Support、会话 Application、会话执行上下文、Task/Runtime、Git/Integration、Provider 事件投影和历史对账均已形成独立模块。`packages/local-server/src/index.ts` 为 3,590 行，`codexNativeConversationCoordinator.ts` 为 3,931 行；入口只保留对象装配、生命周期、持久 Runtime 回调和聚合路由注册。Storage Repository 通过最小 `ZeusDatabasePort` 取得数据库能力，`packages/storage/src/index.ts` 为 2,823 行 composition root；当前 87 张 Core schema 表和 11 张可重建独立派生表由机器清单逐表指定唯一 owner。Renderer 的 `App.tsx` 为窗口级 Shell，`apiClient.ts` 是稳定 facade，业务组合进入 feature controller/query store。

`grandfatheredSourceFiles` 当前为空；所有 TypeScript 源文件受统一 4,000 行上限，Renderer facade/composition 另有更严格上限。架构门禁同时核对新增 Local Server public subpath、聚合路由注册、跨包依赖循环、Storage owner 与 schema 来源。模块化完成指机器边界和实现所有权已闭合，不表示真实 Provider、正式历史副本、GUI 或性能自动通过。

## 当前纵切

| 边界 | 公开模块 | 所有者 | 入口只负责 | 模块负责 |
| --- | --- | --- | --- | --- |
| 会话首屏与重内容 | `conversationSnapshotV2Api.ts` | 会话查询 | 注入 Repository、访问检查、兼容度追踪与写入前 flush | 有界 Snapshot、游标分页、内容 handle 和错误映射 |
| 会话耐久增量 | `conversationSyncRoutes.ts` | 会话同步协议 | 注入协议、订阅者集合、鉴权、会话访问与 server identity | WebSocket replay、HTTP cursor 补页、代次与 baseline 处理 |
| Memory 与 Context | `memoryContextApi.ts` | Memory/Context | 注入 Repository、项目定位、提交与时钟 | 候选接纳、resolve、supersede、tombstone、任务文档优先的 Context 预览 |
| Context 编译 | `contextCompiler.ts`、`contextSourceCatalog.ts` | Context Compiler | 不掌握文件系统或 Provider Home | 预算、来源等级、截断解释、受控 `/docs` 和冷证据精确读取 |
| Project Git 查询 | `projectGitQueryApplication.ts`、`projectGitQueryRoutes.ts` | Project Git Query | 注入项目、已登记仓库、时钟及显式 Git/workspace 只读 effect ports | 项目级 scope、多仓限制、Workbench、status、commit、compare、diff 与 HTTP 兼容错误 |
| Codex 子智能体查询 | `codexSubagentQueryApplication.ts`、`codexSubagentQueryRoutes.ts` | Codex Subagent Query | 注入会话、Provider item 投影、既有 Provider transport 与时钟 | ready 闸机、活动投影、分页、缺口线程读取、turn/item 投影及 404/409 兼容语义 |
| 会话与任务推送能力查询 | `conversationCapabilityQueryApplication.ts`、`conversationCapabilityQueryRoutes.ts` | Conversation Capability Query | 注入复制库 Repository、模型目录、既有 Provider、只读 Git、任务上下文投影与时钟 | 模型能力聚合、Provider idle 降级、已登记仓库能力、任务上下文/环境/并发写入提示与 HTTP 兼容语义 |
| Project 配置与总览查询 | `projectQueryApplication.ts`、`projectQueryRoutes.ts` | Project Query | 注入项目/任务/共享路径、配置与图谱投影，并把 overview Git 读取声明为 effect port | 搜索、归档列表、详情、配置、扫描状态、总览和 workspace 配置；validation 下总览 Git 明确降级 |
| Work Management 查询 | `workManagementQueryApplication.ts`、`workManagementQueryRoutes.ts` | Work Management Query | 只注入项目、任务、看板、事件和模板 Repository | 任务详情/列表/归档、看板、事件和模板查询；不存在 hidden write、Git 或 Provider 能力 |
| Runtime 查询 | `runtimeQueryApplication.ts`、`runtimeQueryRoutes.ts` | Runtime Query | 注入持久 Runtime/终端投影、既有进程内会话、设置及时钟；CLI check 是显式 process effect port | adapter 清单/check、设置、会话合并、日志分页、终端快照和终端事件；查询不 spawn、不恢复、不保存 |
| Storage 数据库能力 | `databasePort.ts` | Storage 平台 | `ZeusDatabase` 实现端口并管理数据库生命周期 | Repository 只取得 query/transaction/after-commit 等最小能力 |
| 表所有权 | `tableOwnership.ts` | 各上下文 owner | composition root 只运行迁移与组装 Repository | 逐表唯一 owner、权威级别与文档标签 |
| Renderer Shell 与 feature | `App.tsx`、`WorkspacePage.tsx`、`dashboardClient.ts`、`features/*`、`transport/localApiTransport.ts` | 各 UI bounded context | Shell 只拥有路由、全局错误、窗口导航和单一 transport 组合 | 47 行 `apiClient.ts` 只保留稳定导出；项目、任务、会话、Git、设置、远控、Memory 由所属 controller/query store/API client 实现 |
| 会话高频投影 | `sessionStateSlices.ts`、`useSessionController.ts` | 会话 UI | controller 提供稳定外部 store 与 V2 权威恢复 | 正文、Composer、Queue、资源壳分别订阅所需 slice，普通 delta 不提交整个工作区 |

这些模块通过 `@zeus/local-server` 的显式 subpath 和 `@zeus/storage` 的公开导出暴露。路由模块不得读取 Provider JSONL，不得直接拼写跨上下文 SQL；Application 只可经声明过的 effect port 读取 Git、workspace 或既有 Provider，GET 不得通过 `ensureReady`、仓库发现、fetch 或 `db.save()` 偷做刷新；Storage peer module 不得 import `./index.js` 取得数据库生命周期能力。

## 可执行门禁

`scripts/verify-architecture-governance.ts` 由根级 `pnpm typecheck` 前置执行，当前检查：

1. 扫描 `apps/**` 与 `packages/**` 的 TypeScript 源文件；全部文件上限 4,000 行，不再保留历史巨型文件例外。
2. 禁止 Storage peer module 反向导入 `packages/storage/src/index.ts`；Storage 只允许依赖 `@zeus/shared` 这一 workspace 包。
3. 对首批及本轮 Local Server 独立模块使用逐文件依赖允许清单；Query Route 只能依赖 Fastify、所属 Application 和公共错误映射，Application 不能反向依赖 Fastify 或 composition root。
4. 读取 workspace package manifest，拒绝新增 `@zeus/*` 包循环依赖。
5. 从机器配置核对 Local Server public subpath、入口与 `localServerPlatformRoutes.ts` 的路由装配，以及已搬迁路由清单；业务路由回流到 `index.ts` 会失败。
6. 从所有 Storage 与 Local Server schema 源码提取 `CREATE TABLE`/`CREATE VIRTUAL TABLE`，分别核对 Core 与独立候选数据库，再与 `tableOwnership.ts`、ZARCH-003 生命周期矩阵三方对账：表集合相等、每表只有一个 owner、文档 owner 标签一致。

4,000 行是失败关闭上限，不是目标规模或新增额度；新增职责仍需按真实变化轴进入现有领域模块，不能靠建立多个 3,999 行文件规避内聚性审查。

HTTP 读取副作用另由 `audit-http-read-side-effects.mjs --require-clean` 扫描 Route 到显式 Application effect port 的声明；`verify-http-read-purity.ts` 以临时 SQLite、临时 Git 仓库、持久 Runtime/终端事件和不会启动的 Provider 假端口组合真实 Fastify，共覆盖 32 个 GET：保留首批 9 个，并增加 Project 7 个、Work Management 6 个、Runtime 10 个普通/筛选/分页变体。探针同时毒化“复制库已有 child activity、Provider 仍 idle”的子智能体补齐路径，证明 SQLite `data_version` 不变、Provider 调用为空，并核对 404/409 和关键响应字段。

## Storage owner 契约

机器清单把 87 张 Core 表归入八个 owner：存储平台、集成与平台、Agent Runtime、Memory 治理层、工作管理、会话编排、执行与资产、代码智能；另把 9 张 index candidate 表交给投影索引器、2 张 cache candidate 表交给缓存管理器。候选表全部是 `D/R`，不进入核心备份，也不得因同名或内容相似升格为业务事实。完整的可重建性、保留期、备份、删除权限和缺失降级仍由 ZARCH-003 矩阵负责。

owner 表示谁有权改变表语义和组织跨表事务，不表示谁可以任意删除数据：

- 其他上下文只能经该 owner 的查询端口、命令端口或领域事件使用数据，不能新增跨上下文 SQL。
- 多表流程由拥有用例的 Application Service 组织；Repository 不拥有 HTTP、Renderer 或 Provider 生命周期。
- `ZeusDatabasePort` 故意不暴露打开、关闭、迁移、备份和数据库路径，防止 Repository 越权取得 composition root 能力。
- 新迁移若增加表，必须在同一变更补齐机器 owner 和生命周期矩阵，否则 `typecheck` 直接失败。

## 后续治理顺序

1. 收窄新工厂的结构化依赖集合，以领域端口替换宽 `Record` 组合类型；不得改变现有 HTTP、IPC、Provider 或数据库语义。
2. Renderer 的兼容 facade 已收口；新增 UI 必须直接消费所属 context client 和 query store，291 个兼容属性只允许由组合门禁维持，不得向 `apiClient.ts` 回填实现。正文、Composer、Queue 与资源 slice 已完成物理接管，不得重新汇总成全量 session 订阅。
3. Storage Repository 已按 owner 搬入 `workManagementStore.ts`、`conversationStore.ts`、`runtimeSessionStore.ts`、`turnChangeStore.ts`、`auditStore.ts`；后续只在出现真实变化轴时继续细分，禁止为拆而拆。
4. index/cache 已由独立 runtime 接管；后续门禁是保持 Core 业务事实不反向依赖派生库，并对每个新投影保留 source identity、generation、waterline、后台重建和切换回退证据。

## 本轮保留边界

- Runtime 持久回调、启动/退出序列和跨域对象装配仍由 `index.ts` 作为 composition root 负责；平台 HTTP 注册集中在 `localServerPlatformRoutes.ts`，不是第二个业务 owner。
- 任务上下文选择、附件可信路径检查及显式远端刷新仍由既有任务推送命令拥有；Capability Application 只通过只读投影端口消费结果，不接管 mutation。
- `resolveConversationCapabilities` 的命令路径仍可显式 `ensureReady`，只复用 Capability Application 的模型投影；GET 只能观察既有 transport。该差异是有意的读写分离，不应合并成一个会隐式启动 Provider 的“通用能力函数”。

## 收益与缺点

### 收益

- 新代码不能继续无成本扩大三个巨型文件，架构退化会在本地和 CI 的常规 typecheck 路径即时失败。
- 路由只看公开端口，Snapshot、同步和 Memory/Context 可分别演进，Provider 原生历史也不会被 HTTP 层随意扫描。
- 表 owner 同时存在于代码和生命周期文档，并由 schema 自动交叉校验，新增表不再成为无人负责的隐性事实源。
- 最小数据库端口降低循环依赖与越权能力，为未来按 owner 拆 Repository、索引库和资产状态打下边界。
- 六组高频 GET 不再把仓库选择、Provider 分页、任务推送能力、Project 总览、工作管理和 Runtime 日志聚合藏在 18k 行入口中；外部 effect 可被静态策略定位，也可用组合探针验证零写。
- Provider idle 时 capability/subagent 查询明确降级或 unavailable，页面刷新不会启动 Provider；Workbench 只读已登记仓库，页面刷新不会把发现结果写回 SQLite。
- Runtime GET 只合并已存在的进程内会话和持久投影；adapter check 虽仍会显式探测进程，但不会启动会话、Provider 或写数据库，validation 下由全局 fence 失败关闭。

### 缺点与风险

- 行数门禁只能阻止继续恶化，不能证明模块内聚；若只把代码搬到 3,999 行文件或制造空转发层，仍需人工架构审查拒绝。
- 首批依赖允许清单是手工维护的；公开端口变化必须同步更新，否则会产生合理变更的短期摩擦。
- 显式 ports 与 Route/Application 配对增加了装配代码和类型维护成本；对小查询而言文件数会增加，只有真实变化轴和副作用边界明确时才应继续拆分。
- 静态审计看不到动态注入的真实实现，只能验证调用点声明和依赖方向；因此必须保留 Fastify 组合行为探针，不能把“端口名是 read”当成零副作用证据。
- Project overview 的 Git 状态与 Runtime live session 都来自运行现场，和 SQLite 投影可能存在瞬时差异；拆分只让 effect 可见，并不创造跨源事务一致性。
- GET 不再自动发现仓库或预热 Provider，首次页面可能显示不可用或过期投影；需要刷新时必须走显式 Command，这提高了安全性，也增加一次用户可见操作与对应命令建设成本。
- 新增模块和显式端口降低了单文件复杂度，但装配参数显著增加，部分延迟绑定是为打破现有循环；后续错误地提前调用 owner 尚未装配的端口会失败，因此启动顺序仍需行为门禁保护。
- Renderer 已完成物理拆分和高频 slice 接管，但尚未用独立 `Zeus Test.app` 对真实长流执行 React commit 数、焦点与内存趋势验收；静态门禁和内存探针不能代替 GUI 现场。

## 验证口径

- 静态门禁：`pnpm verify:architecture`。
- HTTP effect 门禁：`node scripts/audit-http-read-side-effects.mjs --require-clean`，必须为 `unknownExternalTotal=0`、`policyEvidenceComplete=true`。
- HTTP 组合行为：`pnpm exec tsx scripts/verify-http-read-purity.ts`，覆盖 32 个 GET 的状态码、关键响应、SQLite 零写和 Provider 零调用。
- Renderer slice 行为：内存探针确认普通正文 delta 不改变工作区壳、Composer、Queue slice 身份，资源/草稿/队列变化分别只命中自己的投影。
- 常规门禁：`pnpm typecheck` 会先运行架构检查，再运行 TypeScript project references。
- 依赖闭包：`pnpm --filter @zeus/local-server... build`。
- 真实运行仍需独立 `Zeus Test.app`、独立 `ZEUS_USER_DATA_DIR` 验证 Snapshot/事件/Memory API、Renderer 增量和旧协议兼容；构建通过不能替代 GUI 或 Provider 验收。
