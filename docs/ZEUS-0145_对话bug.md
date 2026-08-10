# ZEUS-0145 对话中断后无法继续对话

## 问题

- 任务类型：缺陷
- 现象：用户停止当前会话后再次发送消息，消息短暂显示后回到输入框，会话无法继续。
- 预期：保留原会话和历史，在同一 Provider 线程或会话中开启新的执行轮次。

## 根因

Codex 收到 `turn/completed` 且状态为 `interrupted` 后，无论是否存在未发送内容，都把会话和运行状态保留为 `paused/interrupted`。后续发送只会自动处理 `recovery_required`，因此没有未发送队列时新提交会停在队列中。

Pi/DeepSeek 的中断路径还会把已经绑定 `providerTurnId` 的历史提交保存为 `paused/interrupted`。这类提交已经进入 Provider 轮次，不应再次作为未发送内容，也不应阻塞下一轮。

## 实施规则

- 停止操作等待匹配轮次返回 `turn/completed: interrupted`；超时、自然完成或状态不明时保持恢复保护，不启动新的 Provider 写入。
- 只有 `queued/paused` 且没有 `providerTurnId` 的提交才属于未发送内容。
- 中断后没有未发送内容时，Codex 与 Pi/DeepSeek 都恢复为 `providerState=ready`，允许同一线程或会话创建新的 turn/run。
- 中断前已经存在未发送队列时，继续保持 `paused/interrupted`，不自动重放；Codex 仍通过显式恢复队列发送。
- 真实发送失败时继续由 Renderer 恢复草稿；不通过删除 `send_failed` 来掩盖 Provider 状态错误。
- 中断终态后发送权威 `conversation.queue.changed`，使界面同步最新队列状态。

## 变更范围

- `packages/local-server/src/codexNativeConversationCoordinator.ts`：等待中断终态，统一中断队列判断、重启对账和运行状态，补发队列事件。
- `packages/local-server/src/piNativeConversationCoordinator.ts`：统一异步结束和直接停止的中断收口，完成已绑定提交并恢复 Provider 状态。
- `packages/local-server/src/index.ts`：共享会话快照只按无 Provider 轮次绑定的暂停提交推断队列状态。
- 不新增接口、数据库字段或迁移；不修改输入框真实失败恢复逻辑。

## 验证记录

- `pnpm install --frozen-lockfile`：通过，补齐本新 worktree 的依赖。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `pnpm package:mac`：通过，生成独立测试身份应用 `dist/test/mac-arm64/Zeus Test.app`，其 Bundle ID 为 `dev.hypha.zeus.test`；签名和 DMG 产物校验通过。
- `node scripts/verify-packaged-app-health.mjs 'dist/test/mac-arm64/Zeus Test.app'`：通过，Renderer、Main、Preload 和 Browser Page Preload 资源完整。
- GUI/Provider 真实验收：未完成。使用隔离数据目录启动本次打包应用时，机器上已有多个同 Bundle ID 的 `Zeus Test.app` 实例，应用停在单实例启动模态框，无法安全接管；因此未将 Codex、Pi/DeepSeek 的真实发送-停止-再次发送结果冒充为已验收。
