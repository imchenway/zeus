# ZEUS-0314 iOS 选择答案同步回 Zeus

## 任务状态

- 阶段：代码修复与本地验证完成，待新的真实 iOS 双端回归。
- 类型：远程接管会话事实缺失。
- 用户现象：用户在 ChatGPT iOS 的 `request_user_input` 中选择答案后，Zeus 只结束等待状态，看不到具体选择；从 Zeus 会话记录角度等同于没有回答。

## 已确认根因

OpenAI App Server 的 `serverRequest/resolved` 当前只携带 `threadId` 与 `requestId`，并且用户回答、轮次结束或中断导致的请求清理都会使用同一通知。Zeus 旧实现收到该通知后只持久化 `external_resolution`，没有答案正文，却仍把请求投影为普通“已回答”历史。

官方 `ThreadItem` 历史没有公开 `request_user_input` 答案条目，但真实 iOS 主路径对应的 Codex rollout 已确认包含同一 `call_id` 下的结构化 `function_call_output.answers`。因此本任务采用 rollout 权威回填，不根据模型后续文本、时间邻近或选项顺序猜测答案。

## 修复约束

1. 仅使用 app-server 明确返回并已绑定当前会话的绝对 `.jsonl` 路径，不扫描其他 Codex 目录。
2. 回填必须同时校验 Provider thread、turn、item/call 身份与完整问题结构；存在多个候选时拒绝猜测。
3. 回填答案继续走现有 canonical 校验；敏感答案只保存脱敏摘要，不写入普通会话正文、错误详情或日志。
4. `serverRequest/resolved` 只表示 Provider 已解除阻塞。拿不到权威答案时必须显示同步失败，不能声称“已回答”或伪造选中项。
5. 不新增或恢复单元测试体系；验证使用静态检查、构建、独立身份 `Zeus Test.app` 和必要的真实 iOS 双端操作。
6. iOS 完成选择后，Zeus 必须依靠同一远程轮次的主动事件更新界面，不能要求用户再发送一条 Zeus 消息、手动刷新或切换会话。答案已落盘时随 `serverRequest/resolved` 立即投影；若存在短暂落盘时序差，则由 `turn/completed` 自动补偿。

## 实施记录

- 已确认历史真实 iOS 固定选项答案在 rollout 中表现为：`request_user_input` 的 `function_call.call_id` 对应 `function_call_output.call_id`，输出正文为结构化 `answers`。
- 新增只读 rollout 答案恢复器：校验保存路径、会话 ID、turn ID、item/call ID、问题全文和唯一输出，再解析结构化答案；路径、身份、候选或正文不满足条件时返回明确原因，不降级猜测。
- `serverRequest/resolved` 收到远端结束通知时立即尝试回填；如果通知早于 rollout 答案落盘，会在 `turn/completed` 再尝试一次；应用启动恢复及显式恢复归档会话时也会回填历史 `external_resolution`。
- 仅当首次结果为 `answer_output_missing` 时，Zeus 还会在约 0.2 秒、1 秒和 5 秒形成三个自动补抓检查点；找到答案后立即停止。路径、身份、格式或歧义错误不会启动轮询，永久失败仍明确显示同步失败。
- 找到答案后继续使用现有 canonical 校验与请求仓储：普通选择保存原答案，敏感问题只保存脱敏摘要与非敏感公开答案。
- Renderer 的 resolved 事件现在携带并保留完整请求投影，用户无需等待下一次 HTTP hydrate 就能看到答案历史。
- 拿不到权威答案时保留 `external_resolution.answerRecovery` 审计原因，界面显示红色“答案同步失败”，不显示选中项，也不再显示“回答已提交”或“历史内容已脱敏”。

## 方案权衡

- 优点：恢复的是 Provider 本地权威结构化输出，能够还原精确选择；匹配失败即拒绝，避免模型文本推断造成错误审计；无需修改 OpenAI 协议或扫描用户的其他会话目录。
- 缺点：依赖当前会话保存的 rollout 路径和 Codex 继续写入 `function_call_output`；文件缺失、旧格式无身份字段或结果存在歧义时无法恢复，只能诚实显示同步失败。当前实现会在恢复时顺序读取该会话 rollout；瞬时缺失最多额外读取三次，因此极长会话的读取成本高于只处理 resolved 通知。

## 验证记录

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过；仅有既有的大分块提示。
- `pnpm package:mac`：通过，只生成测试身份 `dist/test/mac-arm64/Zeus Test.app`、测试 DMG 与 blockmap。
- 包身份与结构：`CFBundleIdentifier=dev.hypha.zeus.test`；`codesign --verify --deep --strict` 和 `verify-packaged-app-health.mjs` 通过。
- 真实历史 iOS rollout 只读回放：严格身份匹配时恢复出 `手机可见 (Recommended)`；将 item ID 改成错误值时返回 `request_call_missing`，未退化为按相似问题猜答案。
- 历史样本中，结构化 `function_call_output` 与 iOS 回答时间相同，原轮次在约 3.5 秒后完成。这个样本证明不需要下一条 Zeus 消息才能产生答案记录，但不构成 OpenAI 对所有网络环境的固定延迟承诺；最终桌面可见耗时仍需新的真实双端回归测量。
- 隔离桌面运行：最终重打包后，使用独立 `ZEUS_USER_DATA_DIR=/tmp/zeus-0314-final-runtime.AZGxV0` 且显式设置 `ZEUS_CODEX_NATIVE_ENABLED=0` 启动当前测试包；Main、Renderer 和本地服务正常，`/health` 返回数据库与运行时均为 `ok`，没有启动 Codex app-server。退出后进程和监听端口消失，SQLite `PRAGMA quick_check` 为 `ok`，隔离目录已移入废纸篓。
- 尚未执行新的 ChatGPT iOS 选项点击与 Zeus 同屏验收；该步骤需要真实登录设备和 Provider 远程接管链路，不能由历史回放、构建或空数据测试包代替。
