# ZARCH-001 领域命名与依赖边界审计

## 结论

根级领域语言、六个上下文、跨上下文关系和五项不可逆架构决策已经固化。当前代码仍是物理上跨上下文的模块化单体，ZARCH-040～042 负责逐步收敛；在收敛前不得通过重命名掩盖真实兼容字段或一次性大范围搬移代码。

## 当前命名差异

| 当前名称 | 领域含义 | 收敛规则 |
| --- | --- | --- |
| `conversation` | 多数情况下为产品会话 | 公共 API 保留 `conversation`，Provider 专有位置必须使用 native/thread/session 限定词 |
| `native session` / `thread` | Provider 原生会话或运行分段身份 | 不得用于产品会话标题、任务归属或 UI 长期身份 |
| `NativeSessionState` | Renderer 的产品会话工作状态投影 | 后续改为明确的产品会话视图状态；迁移期间不改变持久语义 |
| `conversation_items` | 旧 Provider 顶层 UI 兼容投影 | 只允许迁移兼容使用，最终由统一时间线、模型历史和处理过程取代 |
| `message` | 可能是可见正文、排队输入或 Provider item | 排队与不可变意图使用 submission；运行时接纳后才形成 turn/时间线事实 |
| `session` | 可能指产品会话、Provider 原生会话或终端运行时会话 | 新接口必须加 `product`、`native` 或 `runtime` 语义限定 |
| `execution-host` | 当前本机业务服务进程 | 产品与架构语义统一为“本机执行核心”；现有协议名兼容保留到版本化迁移 |
| `projection` / `snapshot` | 可重建读取结果 | 不得作为 Provider 或 Zeus 权威事实的同义词 |

## 当前物理所有权差异

- `packages/local-server/src/index.ts` 同时装配六个上下文并承载大量业务流程；目标是只保留 composition root、生命周期和路由注册。
- `packages/storage/src/index.ts` 同时暴露多个上下文的 Repository 和数据库行；目标是保留基础设施并让各上下文拥有自己的端口与适配器。
- `apps/desktop/src/renderer/App.tsx` 同时承载 Shell、工作管理、会话、Git、设置和集成状态；目标是按 feature controller 与 query store 收敛。
- 会话旧兼容投影和统一结构仍并存；在 ZARCH-020/021 完成前，任何新功能不得继续依赖旧表作为事实源。
- 代码图谱当前仍与业务库存在同步写回关系；在写回改为可重放投影前，不允许直接物理拆库。

## 依赖边界

1. UI 与外部集成只能调用版本化命令和查询，不直接使用 Repository。
2. Application Service 可以协调本上下文事务；跨上下文只传稳定 ID、命令、查询结果和领域事件。
3. Domain 不依赖 HTTP、Renderer、SQLite 行、Provider 原始载荷或绝对路径。
4. Provider Adapter 不修改任务、产品会话或审批事实，只返回原生接纳与事件证据。
5. 可重建索引和 UI 投影不得反向覆盖业务事实。
6. 大型资产只通过 `ArtifactRef` 跨边界，完整内容不进入普通快照。
7. 新增跨上下文导入前必须在 `CONTEXT-MAP.md` 中存在对应关系；否则先更新架构决策。

## 后续门禁

- ZARCH-040：拆分 Local Server composition root 与应用服务。
- ZARCH-041：拆分 Renderer Shell、页面和会话控制器。
- ZARCH-042：建立表 owner、Repository 端口和静态依赖检查。
- ZARCH-020/021：移除旧 `conversation_items` 作为 UI 事实来源。
