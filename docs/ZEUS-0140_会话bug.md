# ZEUS-0140 会话用户消息气泡消失

## 当前状态

- 阶段：已实施，静态检查、构建和测试包验证通过。
- 处理口径：已接受的用户消息不能无声消失；排队、Provider 确认、失败和结果不确定都必须保留可恢复内容。
- 真实 GUI、真实 Provider 往返和隔离数据库双消息验收：本轮未完成，原因见“真实运行边界”。
- Git 边界：本任务未执行 commit、push、merge 或 revert。

## 证据与根因

前端原先把乐观用户项、队列 submission、Provider 用户项和 `conversation_messages` 分开投影：

1. 快照只跳过 Provider 用户项并渲染持久消息，快照、实时 Provider 事件和乐观项没有使用同一套客户端消息身份对账。
2. Provider 用户事件只查找乐观项；如果持久消息已经先到，事件会再创建一个用户项。
3. 队列中的乐观项转换为 Provider 项时，旧逻辑把正式项追加到末尾；两条连续消息在队列移除或轮次开始窗口可能发生顺序跳变。
4. `sendNativeMessage` 抛错后，Renderer 原先直接进入 `send_failed`，无条件删除乐观项；如果服务端已经按幂等键写入 submission 或 Provider 用户项，消息会在权威事实尚未读取前消失。
5. 服务端 Provider 用户项映射虽然已有同轮 submission 回退，但没有阻止 Provider 返回的客户端 ID被另一条 Provider item 重复占用。

## 状态边界

- 发送开始：创建一条带 `clientUserMessageId` 的乐观用户气泡；不能按正文、最新项或全局发送状态合并。
- 排队期间：队列只改变这条消息的发送状态和队列位置，不能删除视觉消息。
- Provider 确认：优先用 Provider 返回的客户端 ID，其次使用已绑定的 Provider item ID；在原消息位置把乐观项替换为正式项，一条消息只保留一次。
- 快照重建：Provider 用户项和 `conversation_messages` 按 `clientUserMessageId`、`providerItemId` 合并；已经进入权威 submission、Provider 用户项或持久消息的消息不再被误判为未发送。
- 明确失败：只有权威快照确认没有 submission、Provider 用户项或持久用户消息时，才删除乐观项并恢复草稿。
- 结果不确定：权威快照读取失败或连接状态不足时，保留气泡为恢复态并恢复可编辑草稿；不得静默删除或自动重发。

## 实施内容

### Renderer 会话投影

- `NativeSessionItemBuffer` 和会话消息快照复用并携带 `providerItemId`。
- 快照同时读取 Provider 用户项和持久用户消息，按客户端消息 ID及 Provider item ID合并；重复客户端 ID只保留一条。
- Provider `started/delta/completed` 事件可匹配已有正式用户项或乐观项，替换时保留原 `itemOrder` 位置，不再追加到队列底部。
- 快照会保留仍未出现在持久消息表中的已接受乐观消息；明确存在的 Provider 用户项也作为权威事实参与对账。
- `queue.changed`、`turn.started` 继续只更新队列和会话状态，不删除视觉消息。

### 发送异常与服务端映射

- 发送异常后先按同一个 `clientUserMessageId` 读取权威快照；发现 submission 或 Provider 用户项已存在时转为已接受结果。
- 快照读取失败时进入 `send_uncertain`，保留气泡、草稿和附件；只有快照明确证明不存在持久事实时才走 `send_failed`。
- `persistProviderUserMessage` 对同一 Provider item 保留既有绑定；新项优先使用 Provider 返回且未被其他 item 占用的客户端 ID，缺失时只从当前轮次的未绑定 submission 回退，冲突 ID不再错绑其他消息。
- 未新增 HTTP 接口、数据库字段或迁移；持久化仍使用现有 submission、`clientUserMessageId`、`providerItemId` 和 Provider item 幂等更新。
- 未修改截图中另一个会话完成时间同步问题。

## 验证结果

### 已完成

| 检查 | 结果 |
| --- | --- |
| `git diff --check` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过；Renderer、local-server 及工作区包均完成编译 |
| `pnpm package:mac` | 通过；生成 `dist/test/mac-arm64/Zeus Test.app` 及测试 DMG |
| 测试包身份 | `CFBundleIdentifier=dev.hypha.zeus.test`，名称为 `Zeus Test` |
| 包体健康检查 | 通过；Renderer、Main、Preload、Browser Page Preload 和用户安装 Codex runtime 均存在 |
| 代码签名结构校验 | 通过；测试包为 ad-hoc 签名，未执行 Apple 公证 |

### 真实运行边界

按约束只尝试启动本 worktree 生成的 `Zeus Test.app`，并使用临时 `ZEUS_USER_DATA_DIR`。Computer Use 发现本机已有多个其他 worktree 的同 bundle ID `dev.hypha.zeus.test` 实例；本任务包的界面读取超时，直启进程也未建立可用窗口或隔离数据库。为避免关闭或复用其他任务实例，本轮没有继续点击、发送消息或切换会话，随后只结束了本任务自己启动且未建窗的进程。

因此以下六项不能标记为真实通过：

1. 回复期间连续发送两条消息并确认气泡出现及顺序。
2. 队列移除、轮次开始、Provider 用户项延迟到达期间不消失。
3. Provider 确认后只转换一次且不回到队列底部。
4. 刷新、重连、切换会话后的权威快照恢复。
5. 明确失败、恢复失败和写入结果不确定时的恢复内容。
6. 隔离数据库中两条独立客户端消息及 Provider item 绑定的现场记录。

静态检查、TypeScript 编译和测试包健康检查证明代码边界与产物完整性，不等同于真实 Provider、GUI 或隔离数据库验收；待有不影响现有测试实例的运行窗口后，应按以上六项补验。
