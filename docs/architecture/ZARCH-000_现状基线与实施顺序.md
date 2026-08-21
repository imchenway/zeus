# ZARCH-000 现状基线与实施顺序

## 审计口径

- 审计日期：2026-08-21。
- `已完成` 只表示实现、迁移、静态检查、运行验证和任务验收均已有证据。
- `部分实现` 只表示存在可复用底座，不能据此宣称目标已通过。
- 正式资料只做只读核验；正式 Zeus 保持运行且未操作其界面，正式数据库未被迁移、提升或执行 `VACUUM`，仅由 Backup API 读取活动 WAL 一致快照；未读取云盘内容。
- 规划编号本来就是非连续集合：001～003、010～014、020～024、030～036、040～042、050～052、060～063；不存在 ZARCH-004～009、015～019、025～029、037～039、043～049、053～059。

## 30 项基线

| ID | 基线状态 | 已有底座 | 首要差距 |
| --- | --- | --- | --- |
| ZARCH-001 | 已完成文档契约 | 根词汇表、六个上下文、关系图、五项 ADR | 静态依赖门禁归 ZARCH-042 |
| ZARCH-002 | 进行中 | Renderer→HTTP→SQLite→Provider Command/Worker/receipt 贯穿同一受控 trace；API/SQLite/React/paint/long-task 有界采样已接入；打包合成库启动时序已取得 | 正式大历史、重连、持续输出与 Provider 的真实 P50/P95/P99 尚未验收 |
| ZARCH-003 | 已完成文档契约 | 87 张 Core 表、11 张派生表与目录/Provider/Memory/docs/rollout 权威生命周期已登记；数据根持久身份已接入 | 可执行保留、GC、备份策略由对应任务实施；正式自定义根迁移仍须离线 adoption 现场 |
| ZARCH-010 | 进行中 | 单一索引来源、候选副本维护、只读 EXPLAIN 与 11 条零全表扫描预算门禁已完成 | 最大正式历史一致副本的建索引时间、空间和真实查询时延待验 |
| ZARCH-011 | 产品纵切完成 | Snapshot V2、稳定游标、页/字节预算及 Renderer 首屏水合已接管 | 最大历史候选副本、真实 GUI 长历史与 V1 退役观察待验 |
| ZARCH-012 | 产品纵切完成 | 过程/资源/变更集按需读取、授权重内容 handle 与 Renderer 最小展开已接入 | 缺失资产产品降级、最大历史副本及真实 GUI 待验 |
| ZARCH-013 | 核心实现 | 严格视口窗口、前插锚点、稳定身份与三重缓存预算已接入 | 正式长历史 GUI 手感与进程 heap 趋势待验 |
| ZARCH-014 | 核心实现 | 有界向后分页、同步检查点，以及 provider/version/protocol/generation/thread/session/waterline 追加审计链 | 尚未用正式 Provider 大历史现场验证 gap 预算与代次切换；显式用户查看子代理详情仍可按需读取正文，但自动恢复不全量读取 |
| ZARCH-020 | 产品读路完成 | Snapshot V2 已接管 Renderer 水合、分页与 mutation 后重读，V1 GET 统一返回 410 | 全 Provider/GUI 现场验收待完成 |
| ZARCH-021 | 运行时退役完成 | 旧 Repository reader/writer blocker 为 0，离线候选迁移与 write fence 已实施 | 正式库未改；旧表物理删除须等待维护切换和回退窗口关闭 |
| ZARCH-022 | 核心实现 | 内容寻址 Artifact、staging、引用提交和提升协议已接管当前大内容写入者 | 正式恢复包与最大历史资产现场待验 |
| ZARCH-023 | 核心实现 | 去重、版本化压缩、hold、配额、容量诊断和两阶段 GC 已实施 | 自动物理删除故意不默认启用；真实容量压力待验 |
| ZARCH-024 | 核心实现 | `index.db/cache.db` 独立 generation、写队列、候选提升/回退和后台重建已接入 | 大仓持续压力和真实损坏恢复 SLO 待验 |
| ZARCH-030 | 核心治理完成 | 203 个公开入口、128 个内部副作用、10 个状态机、8 项 CAS 策略与 Electron Main 独立分母均有失败关闭机器清单；打包 Test 只读 Fence/拒写切片已通过 | 真实 Provider 崩溃窗口、OS 能力、正式大库和可视交互待验；不宣称外部 exactly-once |
| ZARCH-031 | 公开核心完成 | 通用 Inbox/Outbox/追加式 receipt、unknown 封口和 Core/External 四态已覆盖 183 个耐久公开入口，`pending=0` | 真实 Provider 崩溃窗口与打包现场待验；短期 capability 明确保留进程内 |
| ZARCH-032 | 核心实现 | 三级耐久事件；Provider/SQLite/WebSocket/Renderer 条目与字节预算、高水位、合并及失败关闭降级；可重复假 transport 探针已纳入架构门禁 | 真实长流、慢网络和休眠唤醒压力下的端到端延迟 SLO 尚未验收 |
| ZARCH-033 | 核心实现 | 版本化耐久流、WS cursor replay、HTTP 有界补页、Renderer `last + 1` gap recovery 与 Snapshot V2 回退；可重复缺口恢复探针已纳入架构门禁 | 真实断网重连、长缺口和旧客户端兼容期仍待运行验收 |
| ZARCH-034 | 核心实现 | 正式 Main 使用 detached Execution Host；锁、rendezvous、startup、generation 与单写入者交接已接入；隔离探针验证 detach、活动阻断、等待恢复和不兼容维护；打包 Test Host 启停/清理已通过 | 活动真实 Provider 轮次升级交接、打包跨版本和大库长期运行仍待验收 |
| ZARCH-035 | 核心实现 | Pi Worker、版本化 IPC、原生身份、health/circuit、unknown 不重发；Codex/Pi 诊断 API 与带 Command 账本的显式恢复 API | 产品 UI、真实 Provider 认证/限流与打包应用运行验收仍待完成 |
| ZARCH-036 | 核心实现 | 代码地图、图谱投影、大型 Git diff 与仓库统计已进入有界 Heavy Worker；支持 cancel/timeout/V8 预算/结果引用 | 持续大仓压力的 Core 事件延迟 SLO 与 Worker 强杀产品现场仍待验收 |
| ZARCH-040 | 结构与机器门禁完成 | Local Server `index.ts` 3,590 行、Codex coordinator 3,931 行；平台路由、Support、会话、Task/Runtime、Git/Integration、Provider 事件与历史投影均已拆分，grandfather 清空 | 新工厂装配和显式端口数量增加；最终仍需真实 Provider、GUI 与性能现场，不以行数门禁代替运行验收 |
| ZARCH-041 | 核心物理拆分完成 | `App.tsx` 106 行、`apiClient.ts` 47 行稳定 facade、100 行组合根及 feature/slice/统一 transport 已接入；打包 Renderer bootstrap 与 Snapshot/Memory API 已通过 | `WorkspaceView.tsx` 与宽兼容契约仍大；真实 React commit、heap 和可视交互待验 |
| ZARCH-042 | 实施完成 | Storage composition root 当前 2,815 行；87+11 张表唯一 owner、最小数据库端口和依赖门禁已接入 | 适配层维护成本增加；正式大库迁移/恢复现场待验 |
| ZARCH-050 | 核心实现 | 可治理长期记忆、冲突/tombstone、本机管理 UI 与 Codex/Pi 派发已接入；打包只读 API 已读取合成 stable_workflow 并拒绝写入 | 正式 Provider 与管理 UI 可视交互待验 |
| ZARCH-051 | 核心实现 | memory/docs/code/rollout 多来源确定性预算编译与两类 Provider 派发已接入 | 无完整同步 tokenizer/preflight RPC，正式模型 usage 校准待验 |
| ZARCH-052 | 核心实现 | 受控 `/docs` 解析、主文档 preview、任务/session/sequence 冷索引与有界分页已完成 | 产品触发、容量治理和真实 Provider 文件现场待验 |
| ZARCH-060 | 基础实现与正式只读副本通过 | 一致 Backup API、客户端加密恢复包、候选/回退/原子提升、静止 v2、在线活动 WAL v3 及离线候选迁移 v4 已接入；2,000 次并发写和正式 4.66GB 历史副本通过 | 正式停机提升、真实 Provider 续接和含资产候选待验 |
| ZARCH-061 | 核心实现 | 关键写故障全局只读；事务/WAL/quick-check/首条 FK/Command Ledger/Artifact 空间与 staging 闸机已接入；打包只读 Fence 拒写已通过 | 真实 Provider 写出窗口、跨版本升级、故障 UI 和正式大库副本待验 |
| ZARCH-062 | 核心实现与监督恢复通过 | 正式链使用 detached host；durable handoff、Core 崩溃监督、Main 保持/重连、Pi Worker recover、窗口/后台/停止全部任务退出和正式副本 Host 清理均已通过 | 真实 Provider 活动轮次和打包跨版本 handoff 待验 |
| ZARCH-063 | 需求暂缓且负向边界通过 | 已明确它是设置、任务等用户数据的多设备同步，不是恢复包复制；静态门禁与打包外部 TCP=0 已证明未误接云 | 同步范围、权威、冲突、删除、离线和密钥语义未定义；按用户决定不在本轮猜测实现 |

## 正式数据只读基线

- 正式 SQLite：`/Users/david/.zeus/data/zeus.db`，在线验收时 device `16777229`、inode `91733185`；正式 writer 合法前进，大小不是冻结身份。
- `conversation_items` 审计时约 128,443 行；`WHERE conversation_id = ? ORDER BY updated_at, id` 的查询计划为全表扫描并建立临时排序 B-tree。
- 该结果只用于确认风险；索引必须先在一致副本上测量磁盘增量、建索引耗时、查询计划和回退，再进入受控维护提升。
- 最终正式历史验收采用 `online_backup_snapshot` manifest v4：正式 `Zeus.app` 保持运行，来源绑定规范路径和 device/inode，SQLite Backup API 纳入活动 WAL 已提交事实；关闭来源连接后只在未发布候选上离线迁移并记录零运行时 writer、前后 schema/ledger/页数。来源合法前进只记录，不要求 SHA-256、mtime 或 WAL/SHM 不变。它证明最终候选源自一致时间点快照且迁移回退不触碰正式源，不证明正式资料树零写。

## 打包只读运行基线

- `Zeus Test.app` bundle ID 为 `dev.hypha.zeus.test`，使用独立 strict validation run；首窗从创建起位于非主外接屏 ID 3。
- 正式 run `418ad6c5-15d5-4969-a75a-5aedd85fe499` 使用 4.66GB v4 目标；103 个历史会话两轮 Snapshot V2 全部成功，运行和退出后目标/manifest 哈希不变且无 WAL/SHM/journal。
- health/diagnostics、Project、Conversation、Snapshot V2、Memory 读链通过；写命令与外部 Git 能力返回 503，14 项外部能力跳过，对正式资料根打开路径数为 0、外部 established TCP 为 0。
- Test Main/Host 最终退出且 lock/startup/rendezvous 清理。Computer Use 缺少审批接口，辅助功能树、截图与点击未验；真实 Provider、跨版本和完整 GUI 仍保持未验。

## 决定后的关键顺序

1. 完成 ZARCH-003、002、010，建立权威、测量和当前热路径止损。
2. 先建设 ZARCH-030～033 的 Command/Inbox/Outbox/耐久增量可靠性脊柱。
3. 在可靠增量之上交付 ZARCH-011～014，再让 ZARCH-020 统一读模型接管。
4. 影子对账归零后才执行 ZARCH-021；不得把删旧表当作首步优化。
5. ZARCH-022 先于 023；任何删除型 GC 必须等 ZARCH-060 恢复演练通过。
6. ZARCH-024 与 036 联动，先事件化图谱写回，再拆可重建索引库和 Heavy Worker。
7. ZARCH-042 的 owner/端口门禁先于 040/041 的大规模物理拆分。
8. ZARCH-050、052 先建立治理事实和冷索引，ZARCH-051 再做多来源按预算编译。
9. ZARCH-060/061 通过后，两阶段恢复独立 Core：先给当前 owner 独占 generation 锁，再迁进程边界。
10. ZARCH-063 等待独立产品需求；在数据范围、各对象权威和冲突语义确定前，不接入 iCloud 或 Google Drive，也不把通用恢复包复制误报为多设备同步。

## ZARCH-062 覆盖旧决策的条件

2026-08-15 为解决独立宿主持锁但长时间不发布 rendezvous 的启动故障，正式链曾主动切回内嵌 Local Server，并把日常重启降到约 1.096 秒。当前用户已采纳新的独立 Core 目标，因此新决策可以覆盖旧决策，但必须先满足：阶段化启动状态、持锁启动发现、超时与卡死区分、唯一写者证明、大库冷启动预算、活动轮次与待回复交接、Main 崩溃和升级验收。禁止直接切换旧调用路径。

## 恢复包与多设备同步边界

- 恢复包是用于从一个不可变快照恢复单机数据的灾备产物；多设备同步是在多个可编辑副本间传播设置、任务等事实的产品能力，两者不共用完成语义。
- 通用恢复只允许把加密包复制到用户明确选择的本机目录；不自动发现、绑定或判定任何云提供方。
- 不把运行中的 `zeus.db` 或整个 `.zeus` 目录放进同步盘；恢复包必须先由本地 staging 生成一致数据库快照、清单与哈希，再客户端认证加密。
- iCloud / Google Drive 多设备同步本轮不实现、不验收功能，仅验收没有误接入或触碰云端数据。
