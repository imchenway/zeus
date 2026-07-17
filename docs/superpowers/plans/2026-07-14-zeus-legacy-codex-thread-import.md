# Zeus Legacy Codex Thread Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本任务按用户约束在当前会话内执行，不派发 subagent，不执行 git commit。

**Goal:** 将旧 Zeus `codex exec` Runtime 中可验证的真实 Codex thread 按 `threadId` 一对一导入为可原生续接的 `codex_native` conversation，并把已完整迁移的旧聚合 conversation 归档为审计记录。

**Architecture:** 新增独立迁移器，从 `task_events` 建立 legacy conversation 与 Runtime session 的真实关联，从 `runtime_logs` 提取 Codex UUID，使用当前 app-server 执行 `thread/resume` 与 `thread/read` 验证并读取 provider snapshot。每个 provider thread 创建一条带 `legacySourceConversationId` 的 native conversation，同时导入真实 turn/item/user message；全部候选成功后才归档 legacy 来源。迁移幂等依赖 `provider_thread_id` 唯一索引与稳定导入键，任何不可验证候选都 fail-closed，保留旧记录可见且只读。

**Tech Stack:** TypeScript、sql.js、Codex app-server JSON-RPC、Fastify、Vitest。

## Global Constraints

- 只迁移 `task_events.payloadJson` 明确关联到 legacy conversation 的 Runtime session，不按时间、标题或 cwd 猜测归属。
- 只接受 Runtime 日志中唯一、格式合法的 Codex UUID；0 个或多个 UUID 都不迁移该 Runtime。
- 只接受 `thread/resume` 和 `thread/read` 返回相同 threadId 且 snapshot 为 idle 的 provider thread。
- 每个真实 threadId 对应一个 native conversation；旧 Zeus 一个 conversation 对应多个 thread 时必须拆分。
- 导入内容只能来自 provider snapshot；不得用旧消息重放、摘要拼接或模型生成补齐历史。
- legacy 来源只有在全部已发现 thread 都成功导入或已存在时才归档；失败、歧义、无 thread 的来源保持只读可见。
- 不新增外部依赖，不修改 Codex rollout，不向旧 thread 发送 turn。
- UI 继续使用现有两栏会话列表和 native composer，不新增展开列表、迁移卡片或模态框。
- 所有变更保留现有工作树修改，不执行 git commit/push/merge/revert。

---

### Task 1: Legacy Codex 迁移发现与快照映射

**Files:**
- Create: `packages/local-server/src/legacyCodexThreadMigration.ts`
- Create: `packages/local-server/test/legacy-codex-thread-migration.test.ts`

**Interfaces:**
- Produces: `migrateLegacyCodexThreads(input: LegacyCodexThreadMigrationInput): Promise<LegacyCodexThreadMigrationReport>`。
- Consumes: `TaskEventRepository`、`RuntimeSessionRepository`、conversation/turn/item/submission repositories、`CodexAppServerManager`、`ZeusDatabase`。

- [x] **Step 1: Write failing discovery tests**

覆盖以下行为：

1. 从 task event 的 `conversationId + runtimeSessionId` 建立归属，不使用标题或时间推断。
2. 同一 legacy conversation 的两个 Runtime 各含一个不同 UUID 时，输出两个独立 provider thread candidate。
3. 日志无 UUID、UUID 重复不计多条、含两个不同 UUID 时 fail-closed。

- [x] **Step 2: Run the discovery tests and verify RED**

Run:

```bash
pnpm vitest run packages/local-server/test/legacy-codex-thread-migration.test.ts --reporter=verbose
```

Expected: FAIL because `legacyCodexThreadMigration.ts` or its exported migration function does not exist.

- [x] **Step 3: Implement minimal candidate discovery**

实现稳定 UUID 解析、task event payload 校验、Runtime command 校验和 candidate 去重。返回明确的 `skipped` reason，不抛弃 legacy 来源。

- [x] **Step 4: Add failing provider snapshot import tests**

使用 fake manager 返回两个真实 thread snapshot，断言：

- 每个 threadId 创建独立 `codex_native` conversation；
- `legacySourceConversationId` 指向旧 conversation；
- provider path/model/version、turn、item、user message 来自真实 snapshot/log；
- completed、interrupted、failed turn 状态按 provider 状态持久化；
- 未知 item type 降级为可审计 `error` item，不伪造文本。

- [x] **Step 5: Run the import tests and verify RED**

Run:

```bash
pnpm vitest run packages/local-server/test/legacy-codex-thread-migration.test.ts --reporter=verbose
```

Expected: discovery tests pass; import assertions fail because native rows and provider snapshot records are not created.

- [x] **Step 6: Implement minimal snapshot import**

为每个 provider turn 建立稳定 imported submission，再 upsert turn/items，并把 provider `userMessage` 同步为 conversation message。时间使用 provider epoch，文本使用 provider item content，payload 保留 provider 原始结构。

- [x] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run packages/local-server/test/legacy-codex-thread-migration.test.ts --reporter=verbose
```

Expected: all migration discovery and snapshot import tests pass.

### Task 2: 幂等、拆分和归档安全

**Files:**
- Modify: `packages/local-server/src/legacyCodexThreadMigration.ts`
- Modify: `packages/local-server/test/legacy-codex-thread-migration.test.ts`

**Interfaces:**
- `LegacyCodexThreadMigrationReport` exposes imported/existing/skipped/archived source ids for startup diagnostics and tests.

- [x] **Step 1: Write failing idempotency and partial-failure tests**

覆盖：重复运行不创建重复 conversation/turn/item/message；一个来源的两个 thread 只有一个成功时不得归档；两个都成功后只归档一次；已经存在同 providerThreadId 时视为成功导入但验证项目、任务和 legacy source 归属，冲突则 fail-closed。

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run packages/local-server/test/legacy-codex-thread-migration.test.ts --reporter=verbose
```

Expected: duplicate or partial-failure assertions fail for the missing transactional/idempotent behavior.

- [x] **Step 3: Implement idempotent archive rules**

用 `provider_thread_id` 唯一事实识别已导入 thread；所有候选完成后归档来源；任何 provider、ownership 或 persistence failure 都记录为 skipped，并保留来源未归档。

- [x] **Step 4: Run focused tests and verify GREEN**

Run the same focused test command. Expected: all tests pass with stable row counts after the second migration run.

### Task 3: Local server 启动接入与会话 API 验收

**Files:**
- Modify: `packages/local-server/src/index.ts`
- Modify: `packages/local-server/test/codex-native-conversation-api.test.ts`
- Modify: `docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md`

**Interfaces:**
- Startup calls migration after repositories/manager/coordinator exist and before native recovery.
- Migration failure never falls back to prompt replay and never blocks non-native Zeus startup; affected legacy rows remain read-only.

- [x] **Step 1: Write failing startup/API test**

构造 legacy conversation、两个关联 Runtime log UUID 和 fake provider snapshots，启动 local server 后断言 conversation choices 只显示两个 resumable native rows，legacy 来源已归档；向其中一个 choice 发送 `mode: resume` 时，manager 在同一 threadId 上收到 `turn/start`。

- [x] **Step 2: Run the API test and verify RED**

Run:

```bash
pnpm vitest run packages/local-server/test/codex-native-conversation-api.test.ts -t "imports legacy Codex threads as resumable native choices" --reporter=verbose
```

Expected: FAIL because startup does not call the migration.

- [x] **Step 3: Wire migration into startup**

在 native coordinator 创建后、`recover()` 前执行迁移；command path 使用当前 runtime settings；迁移报告写入本机审计日志，不输出 prompt、token 或完整 provider payload。

- [x] **Step 4: Run focused API and migration tests**

```bash
pnpm vitest run packages/local-server/test/legacy-codex-thread-migration.test.ts packages/local-server/test/codex-native-conversation-api.test.ts --reporter=verbose
```

Expected: both files pass.

- [x] **Step 5: Update task evidence**

在主任务文档记录新事实：旧日志存在真实 threadId、3/3 live resume probe 成功、迁移为 thread 一对一、legacy 聚合记录归档、失败保持只读、回滚只需停止迁移并 restore archived source。

### Task 4: Regression, review, verification, and package

**Files:**
- Verify all affected files from Tasks 1-3.

- [x] **Step 1: Run affected suites**

```bash
pnpm vitest run packages/local-server/test/legacy-codex-thread-migration.test.ts packages/local-server/test/codex-native-conversation-api.test.ts packages/local-server/test/codex-native-conversation-coordinator.test.ts apps/desktop/test/session-workspace.test.tsx apps/desktop/test/session-controller.test.tsx --reporter=basic
```

- [x] **Step 2: Run static gates**

```bash
pnpm typecheck
pnpm lint
pnpm format:check
git diff --check
```

- [x] **Step 3: Request code review and fix findings**

使用 `superpowers:requesting-code-review`，reviewer 必须读取用户提供的 AGENTS.md、`DESIGN.md`、本计划和受影响 diff；由于本轮禁止 subagent，执行当前会话内的结构化自审并记录证据。

- [x] **Step 4: Verify the real database migration on a copy**

复制真实 `zeus.db` 与必要 Runtime logs 到临时目录，使用真实 app-server 运行迁移，断言 3 个可 resume native thread、旧聚合来源归档、2 个无 thread 的失败历史保持只读；不得直接把测试迁移写入用户真实数据库。

- [x] **Step 5: Run completion verification and package gate**

使用 `superpowers:verification-before-completion` 复核原始需求。安全退出运行中的 Zeus 后执行：

```bash
pnpm package:mac
```

Expected: package succeeds and rebuilt app contains the migration implementation. If packaging fails, report not complete and keep the real user database untouched.

## Rollback

- 代码回滚：移除 startup migration 调用，保留已创建 native conversation；它们仍是有效 Codex thread 绑定，不删除 providerThreadId。
- 数据回滚：restore 被归档的 legacy source conversation；不删除 native rows，不修改 Codex rollout。
- 失败回滚：迁移器在任何歧义或 provider 失败时不归档来源，用户仍可只读查看原记录。
