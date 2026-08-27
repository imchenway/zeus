# Agent Runtime

Agent Runtime 表达 Zeus 可调用的智能体运行能力及其原生身份；它不拥有项目、任务或产品会话的业务状态。

## Language

**Provider**：
提供原生智能体会话、模型调用和恢复协议的运行系统。
_避免：模型、连接、产品会话_

**Runtime Adapter**：
把统一运行命令和 Provider 专有协议互相转换的边界。
_避免：Provider、协调器、连接_

**运行代次**：
一次具有稳定事件身份空间和生命周期的 Runtime 实例。
_避免：应用版本、产品会话代次_

**Provider Worker**：
由 Zeus Core 监督、只承载一个 Provider Runtime Adapter 的独立进程故障域；它不拥有产品会话或业务数据库写权限。
_避免：Zeus Core、后台任务 Worker、模型供应源_

**原生身份**：
由 Provider 分配并用于读取、续接、归档和恢复原生会话或轮次的稳定身份。
_避免：Zeus 会话 ID、文件路径_

**能力快照**：
在特定运行代次和时间点确认的模型、协议、上下文窗口与交互能力集合。
_避免：永久权限、用户偏好_

**Skill**：
由 Zeus 安装、发现并按需交给 Runtime Adapter 的可复用执行说明与资源包，拥有可显式调用的名称和可审计来源。
_避免：提示词模板、Plugin、工具_

**已安装 Skill**：
已经进入 Zeus Skill 发现范围并通过结构校验的 Skill；它天然可由所有 Zeus Runtime Adapter 消费，只表示可被选择，不表示已经执行。
_避免：Codex Skill、Pi Skill、已启用 Skill、已调用 Skill_

**Skill 运行时投影**：
Runtime Adapter 为同一个已安装 Skill 生成的原生调用表达；投影差异不得改变 Skill 的身份、内容或用户选择。
_避免：Provider Skill、Skill 副本、兼容 Skill_

**接纳证据**：
足以证明 Provider 已接受某个提交或轮次的原生协议事实。
_避免：HTTP 成功、请求已写出、界面加载中_

**结果未知**：
命令可能已经越过 Provider 或工具副作用边界，但 Worker 在终态确认前退出；必须暂停核对，禁止自动重发或创建替代原生会话。
_避免：失败前无副作用、自动重试、已完成_

**运行时熔断**：
某一 Provider 代次因启动、超时、认证、限流、协议或进程故障停止接收新命令，并只通过其声明的受控恢复方式进入新代次。
_避免：产品会话失败、应用离线、模型能力不足_

**原生证据锚点**：
由 Provider 身份、原始文件相对路径、turn 或 event sequence 和字节位置组成的只读定位信息。
_避免：复制后的完整 JSONL、Zeus 产品会话事实、可执行指令_
