# 代码地图引擎

代码地图引擎由 `@zeus/code-indexer` 与 `@zeus/graph-engine` 组成。它只从真实项目目录、源码、SQL、DDL、SQLite schema、Git diff 和用户导入的真实文件生成 facts，不生成无来源节点、无来源边或假图表。

## 扫描原则

- 默认忽略 `.git`、`node_modules`、`dist`、`.tmp`、构建产物和缓存目录。
- 扫描必须保留文件路径、行号、source hash 或其他可追溯来源。
- 当前支持 TypeScript/JavaScript/JSON/Markdown/Java/XML/SQL/DDL 等事实抽取；当前仓库无某类语言时不得伪造对应节点。
- `pnpm test:real-scan` 必须扫描 `/Users/david/hypha/zeus` 当前真实仓库并断言图谱非空。

## 扫描阶段

扫描阶段包括目录发现、语言/构建识别、源码解析、SQL/DDL 解析、图谱 facts 写入、视图生成。

1. 目录发现：基于真实项目路径、扫描范围和忽略规则枚举文件。
2. 语言/构建识别：识别 pnpm/npm/yarn、Maven/Gradle、Spring Boot、多模块、源码目录、测试目录、资源目录和配置文件。
3. 源码解析：抽取 TypeScript/JavaScript/Java 类、方法、字段、imports、API route、Controller、Service、Repository、Mapper、Job、MQ consumer、remote client。
4. SQL/DDL 解析：抽取 MyBatis XML、SQL id、select/insert/update/delete、表、字段、JOIN、DDL 表、列、索引、主键、外键。
5. 图谱 facts 写入：写入 code_symbols、project_nodes、project_edges、graph_views 等 SQLite 表。
6. 视图生成：由 graph-engine 从真实 facts 生成可缓存视图。

## 图谱模型

图谱模型包含 project_node、project_edge、metadata、sourceRef、confidence。

- 节点类型覆盖 project、module、package、file、class、method、api_endpoint、table、column、sql_statement、task、runtime_session、control_flow 等。
- 边类型覆盖 contains、imports、calls、exposes_api、reads_table、writes_table、uses_column、depends_on、next_control_flow、throws、awaits_call、task_relates_to_node 等。
- metadata 只能保存真实可追溯信息，例如 aiSummary、recentTasks、riskTags、SQL、DDL、source path、line range。
- sourceRef 必须指向真实源码、SQL、DDL、Git、Runtime、Telegram update 或用户明确创建的记录。
- confidence 区分明确语法事实、DDL 外键事实、命名推断、JOIN 推断和 AI 辅助摘要；推断关系不得伪装成确定事实。

## 视图类型

必须支持系统架构图、表关系图、模块图、模块详情图、接口时序图、模块流程图、方法逻辑图。

- 系统架构图：展示模块、包、入口、外部依赖和核心关系。
- 表关系图：优先使用 DDL 外键；JOIN/命名推断需要低置信度标注。
- 模块图/模块详情图：展示模块、Service、Mapper、表、接口、任务历史、风险标签和来源。
- 接口时序图：从 API route 到 handler、内部函数、Repository/Mapper、SQL 和表影响。
- 模块流程图：聚合真实接口和调用链，不编造业务流程。
- 方法逻辑图：展示 if/else、loop、try/catch/finally、return、SQL、字段影响、await、promise then/catch 等真实控制流。

## 交互与性能

交互与性能覆盖搜索、过滤、节点详情、边详情、一跳/二跳、视图缓存、后台布局、节点聚合、边聚合。

- 搜索必须基于真实节点 label/type/source/metadata，不搜索假数据。
- 过滤支持节点、边、模块、接口、表、任务、置信度。
- 节点详情和边详情必须展示来源、置信度、关联任务和可执行操作。
- 一跳/二跳邻居用于局部分析，不一次性展开全图导致卡顿。
- 视图缓存和后台布局属于可重建缓存，可清理后从真实 facts 重建。
- 大图 WebGL 与局部 React Flow 已按设计书目标接入；渲染运行时只消费真实图谱节点、边和来源。

## AI 与图谱联动

AI 与图谱联动要求回答必须带来源，从图谱节点/问答创建任务，任务完成后回写图谱。

- 图谱问答必须带入真实项目、模块、接口、表、调用链、源码片段和 SQL 片段。
- 回答必须列出来源；没有来源时必须说明无法回答，不生成无来源 AI 摘要。
- 从模块/接口/表/方法/调用链创建任务时，任务上下文必须包含 sourceRef、源码位置、SQL/表和影响范围。
- 任务完成后只能回写真实任务结果、事件、关联节点和用户确认的摘要。

## 开源方案评估

Zeus 代码图谱优先接入成熟开源能力，只有当真实源码追溯、离线本地运行、许可证或包体边界不满足时才在 `@zeus/code-indexer` / `@zeus/graph-engine` 内补齐自研转换层。

| 领域 | 优先方案 | 当前决策 | 风险与回滚 |
| --- | --- | --- | --- |
| Java / TypeScript / Python 源码解析 | Tree-sitter / AST 工具，TypeScript Compiler API，JavaParser 或 javac AST，Python ast | 当前已落地 TypeScript/JavaScript/Java/XML/SQL/DDL 的真实事实抽取；Python 暂按文件与 symbol 边界等待后续真实项目驱动，不伪造调用图 | 新 parser 只作为可替换 extractor 接入；若包体、性能或许可证不满足，回滚到现有正则/AST 混合 extractor，并保留 sourceRef、line、confidence |
| UML 与时序图 | Mermaid sequence / PlantUML / SequenceDiagram 类开源实现 | Mermaid/PlantUML 只导出真实来源文本，不把导出能力扩展成主路径；接口时序和方法逻辑仍由 graph-engine 基于真实调用边生成 | 导出链失败时只影响本机文件导出，不影响主画布；回滚为禁用导出按钮并保留源码图谱 |
| 图布局与运行时 | Graphviz / Dagre / ELK / React Flow / Sigma WebGL | 大图使用 Sigma WebGL 思路，局部图使用 React Flow 思路；graph-engine 仍保留确定性坐标，避免运行时不可复现 | 大项目下先节点裁剪、聚合、搜索、局部展开；若某运行时包体或兼容性不满足，可回滚到 SVG GraphCanvas 与服务端布局缓存 |

许可证、包体、风险与回滚边界：

- 只接受与 Zeus Apache-2.0 发布边界兼容的依赖；不接受会污染开源授权或要求上传源码的图谱库。
- 不新增未经评估的生产依赖；新增前必须记录替代方案、包体影响、离线可用性和 macOS 打包影响。
- 所有图谱节点和边必须保留 `sourceRef`、行号或可追溯 symbol、`confidence`；成熟库只能负责解析、布局或渲染，不能成为事实来源。
- 大项目默认启用节点裁剪、聚合、搜索、一跳/二跳局部展开和低置信度过滤，禁止一次性把所有节点塞进不可读画布。

## 等待项与禁止项

- React Flow / Sigma 已作为设计书指定的大图/局部图渲染依赖接入。
- Postgres / MySQL driver 是可选连接器：未批准或未配置时只记录安全连接意图和等待状态，不伪造外部 schema introspection 成功，也不阻塞本地代码图谱。
- 不生成无来源节点、无来源边、假图表或假 AI 摘要。
- 不把缓存当事实源；缓存丢失后必须能从真实源码、SQL、DDL 和用户记录重建。
