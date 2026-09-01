# Zeus Context Map

## Contexts

- [工作管理](./docs/contexts/work-management/CONTEXT.md) — 管理项目、环境、任务、工作区与交付关系。
- [会话编排](./docs/contexts/conversation-orchestration/CONTEXT.md) — 管理产品会话、提交、轮次、运行分段、队列与恢复决策。
- [Agent Runtime](./docs/contexts/agent-runtime/CONTEXT.md) — 管理 Provider 能力、原生会话、运行代次与协议适配。
- [执行与资产](./docs/contexts/execution-assets/CONTEXT.md) — 管理命令、终端、工具结果、附件、变更集与大型内容资产。
- [代码智能](./docs/contexts/code-intelligence/CONTEXT.md) — 管理代码索引、符号、图谱、视图与可重建 generation。
- [集成与平台](./docs/contexts/integration-platform/CONTEXT.md) — 管理远程入口、凭据槽位、安全、升级和本机运行边界。

根级 [CONTEXT.md](./CONTEXT.md) 定义所有上下文共享的产品语言；上下文文档只补充各自拥有的特定概念。

## Relationships

- **工作管理 → 会话编排**：工作管理只提供项目数字员工的稳定 ID 与版本化身份配置；会话编排拥有其会话专家参与投影和会话内部状态，禁止工作管理直接写会话表，也不得因会话点名创建工作项。
- **会话编排 → Agent Runtime**：会话编排提交带幂等身份的运行命令；Agent Runtime 返回带原生身份与 generation 的接纳、事件和恢复证据。
- **会话编排 → 执行与资产**：会话编排只保存稳定资产引用、授权和展示投影；执行与资产拥有完整内容及其生命周期。
- **工作管理 → 执行与资产**：任务可引用工作区、变更集和交付结果；文件系统与 Git 副作用必须通过执行命令发生。
- **工作管理 → 代码智能**：工作管理发布项目或任务事实；代码智能生成可重建投影，不同步反写工作管理事实。
- **集成与平台 → 其他上下文**：远程入口和桌面入口只提交公开命令、执行查询和接收领域事件；不得绕过应用服务直接写业务表。
- **所有上下文 → 集成与平台**：只以凭据槽位 ID、授权 ID 和受控能力描述引用安全事实，不读取或复制明文密钥。

## Boundary Contract

跨上下文只允许以下四种载荷：稳定 ID、版本化命令、版本化查询结果、带顺序与幂等身份的领域事件。数据库行类型、Provider 原始载荷、绝对文件路径和 Renderer 状态均不得成为跨上下文契约。

当前物理包尚未完全符合本图：`@zeus/local-server`、`@zeus/storage` 和 Desktop Renderer 仍同时承载多个上下文。差异与收敛任务记录在 [ZARCH-001 领域命名与依赖边界审计](./docs/architecture/ZARCH-001_领域命名与依赖边界审计.md)。
