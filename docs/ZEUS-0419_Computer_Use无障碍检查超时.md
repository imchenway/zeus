# ZEUS-0419 Computer Use 无障碍检查超时

## 1. 现象

2026-08-31 的 ZEUS-0399 独立实例验收中，代理调用：

```text
zeus_computer.get_app_state(
  app=<ZEUS-0399 的 Zeus Test.app>,
  disableDiff=true,
  include_screenshot=true,
  max_elements=800
)
```

调用从 06:01:31 开始，经历三段约 30 秒的主动等待后仍没有工具结果，代理于 06:03:28 终止外层检查。提示中的“90 秒”是代理累计主动等待时间，不是 Zeus 返回的超时；从发起到终止的实际墙钟时间约为 117 秒。

## 2. 原因

当前实现存在两层 120 秒超时：

- `ZeusToolBroker` 的原生工具默认超时为 120 秒；
- `ComputerHost` 等待 Swift Helper 响应的超时也为 120 秒。

因此代理在约 117 秒时终止外层检查，早于产品超时返回。

更根本的问题在 Swift Helper 的 AX 树采集：

- `get_app_state` 深度优先遍历最多 800 个元素；
- 每个元素分别同步读取 role、subrole、title、description、identifier、enabled、focused、value、frame、actions 和 children，最坏会产生数千次跨进程 AX 请求；
- 当前没有 AX messaging timeout、整次采集的时间预算、批量属性读取、阶段进度或可取消边界；
- Helper 的标准输入循环串行等待当前请求结束，一个 AX 请求长时间不返回时，后续 Helper 请求也无法处理；
- TypeScript 两层超时只拒绝等待中的 Promise，没有中断本次 AX 遍历或立即重启 Helper。

现有证据可以确认 Computer Use Helper 卡在 `get_app_state` 链路，但由于没有元素级耗时和最后成功属性的诊断记录，不能进一步声称是某一个确定的 AX 属性调用永久阻塞。被测 Electron 应用仍在运行、调试端口仍可响应，只能证明目标应用没有整体退出，不能证明其 AX 响应链正常。

## 3. CDP 旁路的验收边界

连接该独立测试实例显式开放的本机调试端口，确实仍然操作同一个 Electron renderer，不是拿普通网页或其他应用实例替代。优点是可以继续核对 DOM、渲染状态和 renderer 内交互；缺点是完全绕过 macOS Accessibility、AX 快照代次、语义动作、TCC、目标 PID 虚拟输入和 Computer 截图链路。

因此 CDP 只能作为 renderer 诊断旁证，不能据此声明 Computer Use 通过，也不能视为这次超时已经恢复。

## 4. 后续修复边界

修复应放在共享 Computer Use 链路，而不是降低验收参数或继续依赖 CDP：

1. 给 AX 请求设置有界 messaging timeout，并把 `cannotComplete` 投影为明确错误或有界截断；
2. 用批量属性读取和整次快照时间预算限制最坏耗时；
3. 任一宿主超时时终止并回收卡住的 Helper，使下一次调用能够重建干净进程；
4. 增加不含敏感值的阶段、元素数和最后成功步骤诊断，区分 AX 遍历与 ScreenCaptureKit 超时。

仅把 120 秒改短的优点是更快失败，缺点是仍会留下卡住的 Helper，也没有解决 AX 枚举成本，因此不是完整修复。

## 5. 当前 Codex/ChatGPT Computer Use 对照

### 5.1 现场版本与公开边界

2026-08-31 本机当前安装为：

- ChatGPT 桌面应用 `26.825.51511`，bundle ID 为 `com.openai.codex`；
- Computer Use 插件 `1.0.1000919`；
- 独立 Computer Use 服务 `26.828.1000919`，bundle ID 为 `com.openai.sky.CUAService`。

OpenAI 官方 [Computer Use 文档](https://learn.chatgpt.com/docs/computer-use)确认 Codex/ChatGPT 桌面端在 macOS 上通过独立 Computer Use 插件使用 Screen Recording 与 Accessibility。文档还明确区分能力边界：本地 Web 应用优先使用内置 Browser；结构化插件、API 或 CLI 可完成时优先使用结构化入口；Computer Use 用于必须读取或操作桌面 GUI 的场景。

官方文档没有公开 AX 或截图调用的具体超时值、Helper 崩溃恢复算法或实现代码。下述实现对照来自本机当前安装包的公开插件契约、进程边界和符号级只读检查，不应表述为 OpenAI 对所有版本的稳定承诺。

### 5.2 当前 Codex 的处理方式

| 维度 | 当前 Codex/ChatGPT | Zeus 现状 |
| --- | --- | --- |
| 进程边界 | MCP Client 与独立 `SkyComputerUseService` | Electron Main 管理独立 Swift Helper |
| 状态采集参数 | 模型只传 `app`、可选 `disableDiff`；不能把元素上限调到 800，也不能拆分控制截图 | 暴露 `max_elements` 和 `include_screenshot` |
| AX 状态模型 | 默认增量 diff；服务维护 `lastAXTree`、TreeCache、失效监控和可重新抓取元素 | 每次从应用根节点同步深度优先遍历 |
| 截止时间 | IPC 元数据包含 `deadlineUnixMilliseconds`，服务存在 `Request deadline exceeded` 失败路径 | 两层 120 秒只在调用方拒绝 Promise |
| 取消 | MCP 支持取消通知、请求任务取消和断连时取消 pending request | 没有从 Broker 传到 Helper 的取消协议 |
| 生命周期 | 存在无客户端终止判断、服务 idle timeout 与 IPC/XPC 失效处理 | 超时不立即回收；仅后续 idle stop 或手动停止 |
| AX 不完整时 | 同一 Computer Use 内可改用截图、坐标点击和目标应用按键 | 当前也可使用截图/坐标，但本次整块 `get_app_state` 未返回，模型拿不到截图 |
| Browser 关系 | 本地 Web 应用可在任务开始时优先选内置 Browser，不把它声明为 Desktop Computer Use 证据 | CDP 可诊断同一 renderer，但不能替代 Computer Use 验收 |

因此 Codex 确实把“目标应用 AX/截图响应缓慢、请求需要取消、服务需要回收”视为正常故障类别，并提供了显式机制。它的优点是状态采集增量化、截止时间进入服务协议且失败后生命周期可恢复；缺点是实现复杂度更高，缓存与元素重抓取必须处理失效和歧义。

当前只读证据不能证明 Codex 能强制中断任意已经阻塞在 macOS 内核/AX 同步调用中的执行线程，也没有复现当前版本出现与 Zeus 相同的 90 秒无返回。因此可借鉴的是有界协议、取消传播、增量树和服务回收，不应声称 Codex 已从根本上消灭 macOS AX 卡死。

## 6. 优化清单与优缺点

### 6.1 P0：本轮故障必须收口

| 优化项 | 最小实现 | 优点 | 缺点与风险 | 验收条件 |
| --- | --- | --- | --- | --- |
| 宿主超时即回收 Helper | `ComputerHost.callService` 超时时，按当前子进程代次原子清空 pending 与快照，先 `SIGTERM`，短暂宽限后仍未退出则 `SIGKILL`；确认旧 PID 退出后，下一次请求再拉起新 Helper | 即使 Swift 卡在不可取消的同步 AX 调用，也不会污染后续请求；改动集中在进程所有者 | 丢失内存快照，下一次调用有冷启动成本；必须防止旧进程退出事件误伤新代次 | 超时调用在预算内失败；旧 PID 消失、无孤儿进程；下一次 `status`/`get_app_state` 由新 PID 正常响应 |
| 给 AX 调用设置 messaging timeout | Helper 启动时对 system-wide AX 对象调用 `AXUIElementSetMessagingTimeout`，让该专用进程中的子元素读取也受限；将 `cannotComplete` 记为明确 AX 失败 | 直接限制单次跨进程 AX 消息，不再无限等待某个属性 | 设置过短会把正常慢应用误判为不完整；它不能约束 ScreenCaptureKit，因此不能替代宿主 watchdog | 单个失联 AX 调用先于整次请求预算返回明确错误；正常大应用仍能取得可用树 |
| 增加整次快照预算 | `ComputerHost` 为 `get_app_state` 注入内部截止时间；Helper 在阶段、元素和属性组边界检查剩余预算；宿主 watchdog 略晚于 Helper 截止时间，Broker 的 120 秒仅保留为最后保护 | 同时限制“很多次都不算特别慢”的累计耗时；错误归属清晰 | 无法单独打断已进入系统的同步调用，仍依赖 AX timeout 和进程回收；预算需要依据真实大应用耗时校准 | 用户可见结果目标不超过 30 秒：返回完整快照、显式部分快照，或明确超时，不再等待约 90 秒 |
| 批量读取 AX 属性 | 用系统原生 `AXUIElementCopyMultipleAttributeValues` 一次读取 role、subrole、title、description、identifier、enabled、focused、value、position、size；children 与 actions 仍按需单独读取 | 原生 API 已存在，可显著减少跨进程往返；直接处理当前数千次同步请求的根因 | 返回值可能混有 `CFNull`/逐属性 `AXError`，需要逐项映射；children、actions 仍可能慢 | 同一真实大应用、同一元素上限下，AX 调用数和快照耗时明显下降，字段语义不变 |
| 明确部分结果和动作超时语义 | 读操作可返回 `complete: false`、`truncated_reason`、阶段和已取得元素；点击、输入、粘贴、按键等动作超时统一返回 `ZEUS_COMPUTER_EFFECT_UNKNOWN`，清空旧快照且绝不自动重试 | 保留可用读结果，同时避免超时后重放动作造成双击、重复输入或重复提交 | 调用方必须理解“部分结果”和“动作结果未知”，不能继续使用旧 `element_index` | 部分快照不可被表述为完整通过；动作超时后不会自动重发，下一步必须重新观察应用状态 |
| 移除审批前的隐藏完整扫描 | 当前敏感审批在缺少缓存时会暗中调用 `get_app_state(max_elements: 1000)`；改为直接查询 focused element/命中点元素，查询失败时按未知目标走通用审批，安全字段仍由 Helper 端拒绝 | 修复所有共享调用方，不只修用户显式调用；避免一次操作前再触发最重扫描 | 定点查询仍可能超时；未知目标的审批文案会少一些语义信息 | 无缓存的坐标操作、输入或按键不再触发 1000 元素全树扫描；安全字段保护和敏感确认不降级 |
| 增加稀疏阶段诊断 | 只记录 request ID、Helper PID/代次、阶段、已完成元素数、属性组和耗时，不记录标题、文本或输入值 | 下次可区分 AX 遍历、截图、序列化、进程回收，无需猜测卡点 | 需要控制频率；逐元素日志会反过来拖慢采集并带来隐私风险 | 每个超时都能指出最后阶段、已完成元素数、持续时间和是否完成 Helper 回收 |

建议首批一次完成上述 P0 项。单独只做其中的“缩短超时”，只能改善等待时间，不能保证后续调用恢复。

### 6.2 P1：P0 稳定后增强可用性

| 优化项 | 优点 | 缺点与启用条件 |
| --- | --- | --- |
| AX 失败后的截图降级 | Helper 回收后可复用现有 `captureWindow` 做一次只读截图请求；仍是同一 Computer Use、同一目标应用，不是 CDP 替代 | 必须显式标记 `AX unavailable`，不生成可用于语义动作的快照代次；截图也可能超时，因此只能尝试一次 |
| 上游取消传播 | 用户停止、会话取消或 Provider 取消时可立刻结束等待并回收 Helper，体验接近 Codex 的取消模型 | 只有上游确实提供取消信号时才实现；Swift 同步 AX 不保证协作取消，最终边界仍是进程终止 |
| 分操作预算 | `status`、只读快照、截图和动作使用不同预算，轻操作可更快失败 | 预算矩阵会增加维护成本；应先用 P0 诊断数据确定，而不是凭空加入大量配置 |
| 收紧公开采集参数 | 将 `max_elements` 作为服务端安全上限而非鼓励模型主动调大，可减少 800/1000 元素请求的波动 | 会降低复杂界面的可见范围，且不能解决单次 AX 调用卡死；只能作为保护栏，不是根因修复 |

### 6.3 P2：有数据证明仍需要时再做

| 优化项 | 优点 | 缺点与启用条件 |
| --- | --- | --- |
| 真正的增量 AX 树与失效监控 | 重复观察时只重抓变化区域，长期延迟最低 | 当前 `previous_snapshot_generation` 只是完整重扫后的输出 diff，并未减少 AX 读取；真正缓存需要处理元素失效、窗口切换、索引稳定和漏事件，复杂度最高。只有 P0/P1 后实测仍以重复全树扫描为主瓶颈时再做 |
| 按目标应用拆分 Helper | 单个应用的 AX 卡顿不会阻塞其他目标应用 | 增加进程、权限、生命周期和资源管理成本；当前一次只操作一个明确目标，暂无证据需要 |

### 6.4 明确不采用的伪修复

| 做法 | 表面优点 | 实际缺点 |
| --- | --- | --- |
| 只把 120 秒改成更短 | 更快看到错误 | 卡住的 Helper 和排队请求仍在，下一次调用继续失败 |
| 只降低 `max_elements` 或关闭截图 | 平均工作量下降 | 任意一次 AX 或截图调用仍可能卡住，并且牺牲验收覆盖范围 |
| 超时后自动重试点击、输入等动作 | 瞬时故障可能自行恢复 | 首次动作可能已生效，重试会产生双重外部影响 |
| 用 CDP/普通 Browser 宣称恢复 | 可继续检查 Electron renderer | 绕过 Accessibility、TCC、语义动作和目标 PID 输入，不是 Computer Use 验收证据 |
| 第一阶段直接照搬 Codex 的完整缓存模型 | 理论上重复调用最快 | 在失败边界尚未收口时引入缓存失效与索引歧义，改动大且难判断收益 |

推荐实施边界：第一批做到 P0 即停止，不新增真正增量缓存或多 Helper 架构；P1、P2 只由真实运行数据触发。

## 7. P0 实施记录

### 7.1 已实现

- Swift Helper 对 system-wide AX 对象设置 2 秒 messaging timeout，使该专用进程内的后代元素调用统一有界；
- `get_app_state` 使用 30 秒内部截止时间，Helper 在阶段、元素和属性组边界检查预算；`ComputerHost` 使用 35 秒 watchdog，Broker 的 120 秒保留为最终保护；
- AX 基础属性改用 `AXUIElementCopyMultipleAttributeValues` 批量读取；目标不支持批量 API 时才回退逐属性读取；安全文本字段仍先根据 role/subrole 判定，确认非安全字段后才单独读取 value；
- 快照达到元素、深度、AX 或时间边界时返回 `complete: false` 和 `truncated_reason`；部分快照不参与 diff，避免把未采集元素误报为已删除；
- 截图失败不再丢弃已经取得的 AX 树；剩余预算不足 5 秒时明确返回 `screenshot_status: skipped_deadline`；
- Helper 通过 stderr 输出不含应用文本的稀疏进度，Host 超时错误包含 Helper PID、阶段、元素数和耗时；
- `ComputerHost` 超时后清空全部 pending 与旧快照，终止当前 Helper；1 秒内未退出则发送 `SIGKILL`，再等待 2 秒，确认回收完成后下一次请求才能拉起新 Helper；
- 点击、拖拽、输入、粘贴、按键等动作在 Helper 中断时返回 `ZEUS_COMPUTER_EFFECT_UNKNOWN`，明确禁止自动重试；
- 敏感审批不再暗中执行 `get_app_state(max_elements: 1000)`，改用内部 `describe_target` 对 focused element 或坐标命中元素做单元素查询；目标无法确认时保持通用敏感审批，安全字段仍由 Helper 二次拒绝；
- 公共 `get_app_state` 描述已声明有界部分快照语义。

### 7.2 当前验证

- Swift `ComputerService.swift` 独立 typecheck 通过；
- `pnpm lint` 通过；
- `pnpm typecheck` 通过，架构治理检查通过；
- `pnpm build` 通过，原有 `markstream-react` pure annotation 与 chunk size 警告不影响产物；
- `pnpm package:mac` 通过，只生成独立身份 `dist/test/mac-arm64/Zeus Test.app` 与 Test DMG；应用 bundle ID 为 `dev.hypha.zeus.test`，签名和 Helper 校验通过；
- 构建后的 Test 身份 Computer Service 已通过真实子进程协议执行 `status` 与 `list_apps`，确认 JSON 请求、响应和系统权限状态正常；
- 独立 `Zeus Test.app` 使用 mode 700 的独立数据根启动成功；首次窗口按要求落在非主外接屏 display ID `3`，运行日志记录 `targetDisplayId=3`、`actualDisplayId=3`，隔离数据库 `PRAGMA quick_check` 返回 `ok`；
- 对运行中的同一 Test 实例执行 `get_app_state(disableDiff=true, include_screenshot=true, max_elements=800)`：进程墙钟约 454 ms，AX 阶段约 128 ms，取得 131 个元素，返回 `complete=true`、`screenshot_status=captured`；截图经人工查看为正常 Zeus Test 空任务界面；
- 内部 `describe_target` 坐标命中只返回单个“搜索”按钮及非敏感语义，没有触发完整树扫描；将快照截止时间设为已过期时约 30 ms 返回 `complete=false`、`truncated_reason=deadline` 和空部分快照；
- 没有为验收故意制造 macOS AX 长时间失联，因此 35 秒 Host watchdog、`SIGTERM` 到 `SIGKILL` 的真实回收过程，以及动作中断后的 `ZEUS_COMPUTER_EFFECT_UNKNOWN`，本轮只有代码审查、类型检查和构建证据，不能表述为已完成故障注入验收。

验收结束后已正常退出该 Test 实例；运行证据和两次数据根安全门禁探针已以可恢复方式移至 `~/.Trash/zeus-0419-gui.7RfXoO-final-evidence` 与 `~/.Trash/zeus-0419-gui.LX8M67-startup-probe`。
