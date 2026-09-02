# ZARCH-030/031 Electron Main 命令纵切

## 范围与结论

2026-08-21 的动态清单覆盖 108 个 Electron Main IPC 和 9 个原生菜单/Tray action。26 个真实副作用入口已进入 Main Command ledger，65 个入口按精确 channel 保留为有用户确认、幂等语义和禁盲重试证据的 `platform_capability_excluded`，26 个入口为真正只读，pending 为 0。本纵切不修改 Local Server HTTP Command，不实现云同步。

## 26 个 Main Command 入口

1. Browser Host（6）：`zeus:browser:command` → `desktop.browser.command`、`zeus:browser:mark-comments-sent` → `desktop.browser.mark_comments_sent`、`zeus:browser:respond-approval` → `desktop.browser.respond_approval`、`zeus:browser:update-settings` → `desktop.browser.update_settings`、`zeus:browser:clear-data` → `desktop.browser.clear_data`、`zeus:browser-page:save-comment` → `desktop.browser.save_comment`。
2. 恢复/重启（2）：`zeus:conversation-store-migration:retry` → `desktop.conversation_store_migration.retry`；`zeus:storage-recovery:preflight-and-restart` → `desktop.storage_recovery.preflight_restart`。
3. Git（1）：`zeus:project-git:execute-action` → `desktop.project_git.execute_action`。
4. 项目源码（4）：`zeus:project-source:save-file/create-entry/move-entry/trash-entry` 分别映射 `desktop.project_source.save_file/create_entry/move_entry/trash_entry`。
5. 更新/发布（5）：`zeus:release:download-update/install-update` → `desktop.release.download_update/install_update`；`zeus:automatic-update-indicator:open/record-manual-check` → `desktop.automatic_update.open/record_manual_check`；原生 `checkForUpdates` → `desktop.automatic_update.menu_check`。
6. 会话资源（3）：`zeus:materialize-conversation-resources`、`zeus:read-conversation-clipboard-resources`、`zeus:discard-conversation-resources` 分别映射 `desktop.conversation_resources.materialize/read_clipboard/discard`。
7. 任务资源（6）：`zeus:choose-task-attachments`、`zeus:store-task-resource-paths`、`zeus:materialize-task-resources`、`zeus:save-task-clipboard-attachments`、`zeus:save-task-pasted-attachments`、`zeus:zentao:parse-link` 分别映射 `desktop.task_resources.choose/store_paths/materialize/save_clipboard/save_pasted/import_zentao`。

`zeus:read-task-clipboard-resources` 不在上述 26 个写入入口中。它只返回文件引用、附件载荷或文字，不复制、不物化、不落盘；Renderer 只在确实需要物化时生成一个新的不可变 Envelope。

## 账本与故障语义

- Renderer/原生菜单每次用户意图只构造一个 Envelope，包含稳定 command ID、actor、scope、expected revision、idempotency key、issued time 和无敏感传输元数据。
- 不可变 Envelope 只保存稳定请求 SHA-256，`acceptedAt` 只属于 Outcome；同 command ID 并发时必须再比对 type/Envelope/body 身份，不同请求立即冲突。
- Outcome 为 `accepted`、`failed_before_write`、`unknown_after_write`、`receipted` 四态。只有 write marker 文件和父目录都 fsync 成功后才允许调用 Git、更新、Browser/OS 或文件写入；marker 后失败一律保守 unknown，禁止自动重试。
- Envelope 成功但 initial Outcome 未落盘的崩溃窗口会在启动或同进程 replay 时封口为 `failed_before_write`；带 marker 的中断状态封口为 `unknown_after_write`。
- Envelope/Outcome/Artifact 使用内容分片路径、`O_NOFOLLOW`、当前用户 owner、目录 0700、文件 0600、临时文件 fsync、原子 rename 和目录 fsync。读取使用同一 fd 的 fstat + `max+1` 分块读，再比对 inode、size 和时间，拒绝符号链接、并发替换/增长、越界路径、非精确 schema 和破损 JSON。
- receipt 结果默认 64 KiB 内联，更大的 JSON 使用最多 64 MiB 的内容寻址 ArtifactRef。超过 64 MiB 只保存摘要、字节数和 `result_omitted`；之后的 replay 明确返回不可重放，不用摘要冒充原结果。

## 只读验收与退出边界

- Main IPC Fence 在任何 handler 前安装，对 `handle`、`handleOnce`、`on`、`addListener`、`once`、`prependListener`、`prependOnceListener` 默认拒绝；Browser Host 仍保留内层拒绝。
- 只读验收存在 descriptor 时，退出决策直接为 `final_quit`，不使用副本中的历史 active count 弹出停止对话框；关闭阶段跳过正式 App 旁边的旧备份扫描/清理。
- 通知桥、恢复目的地、更新调度器、电源监听、Homebrew、Browser Host、Detached Core 和备份清理逐项独立尝试，前序失败不能跳过 Core close，最后用 `AggregateError` 统一报告。`closeLocalServer` 抛错时不再在 `finally` 中 `exit(0)`。只读验收以错误码 1 退出；普通模式必须由用户明确选择重试安全退出或强制退出。只有 cleanup 真正成功后才允许错误码 0。

## 验证证据

- `pnpm exec tsx scripts/verify-main-command-ledger-behavior.ts`：临时目录行为探针覆盖稳定 replay、同/异 identity 并发、marker 持久失败、marker 后 unknown 阻断、Envelope 孤儿启动/replay 封口、receipt 严格 schema、JSON 损坏、Artifact 篡改/路径越界、超限结果、分块有界读、并发增长、脱敏、0600/0700、符号链接、资源文件原子 no-replace/CAS、剪贴板只读、前序清理失败后仍关闭 Core、`AggregateError`、只读退出和 cleanup 错误码。
- `node scripts/audit-electron-main-side-effect-entries.mjs --require-complete`：108 IPC、9 native action、26 只读、26 integrated、65 platform capability excluded、0 pending，所有账本和只读护栏条件通过。
- 目标 Desktop TypeScript、全仓 lint/build 及打包/GUI 分层验收必须分别报告；行为探针不能替代真实 Git、更新、Browser、OS 或打包 `Zeus Test.app` 现场。

## 收益

- 同一用户意图只有一个可审计身份，重连、双击和 Renderer 重放不会无证据重复执行真实副作用。
- 崩溃窗口不再永久 `IN_PROGRESS`；写出后无法证明结果时保守 unknown，避免 Git、更新或 OS 操作被盲重试。
- 大结果和失败证据有界，降低 IPC、内存和敏感路径/凭据扩散风险。
- 只读验收的开始、IPC 和关闭全生命周期都失败关闭，不因历史投影或 cleanup 错误伪造成功。

## 缺点与剩余风险

- 每个写意图至少增加 Envelope、Outcome 和目录 fsync，比不记账的直接 IPC 成本更高；需要后续以真实磁盘和长期账本规模测量 P95，并设计保留/归档策略。
- 平台能力无法与文件账本做跨系统事务；marker 后崩溃只能标记 unknown，仍需外部稳定身份、用户核对或特定能力的恢复协议。
- 启动崩溃恢复当前需扫描 Main ledger 分片，历史长期增长后应引入可恢复的 pending index/保留水位，否则启动成本会随命令数增长。
- 超过 64 MiB 的已完成结果不可原样 replay；呼叫方必须将这类结果重构为业务 Artifact 或只返回稳定句柄。
- 本轮只有临时文件系统和 fake effect 的行为证据；真实 Git/更新/Browser/OS、打包身份、Core PID/租约退出和关闭后哈希仍须最终 GUI harness 验收。
