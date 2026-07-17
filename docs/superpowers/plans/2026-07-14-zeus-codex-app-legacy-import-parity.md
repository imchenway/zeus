# Zeus Codex App Legacy Import Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task in the current workspace. Steps use checkbox (`- [ ]`) syntax for tracking. 当前系统指令禁止派发 subagent；用户未授权 git commit/push/merge/revert，因此所有 commit 步骤替换为 diff/review checkpoint。

**Goal:** 让 Zeus 随包分发固定版本 Rust app-server，并按 Codex App 的显式 `externalAgentConfig/detect/import` 流程把无 threadId 的旧 Zeus 聊天导入为可直接续接的原生 thread。

**Architecture:** Electron/TypeScript 负责设置入口、Zeus 数据映射和导入状态投影；固定到 OpenAI Codex `rust-v0.144.2` commit `a6645b6b8a656360fa16fb7e1c6721d0697d3d6a` 的 Rust app-server 负责 records 转换、ThreadStore、rollout、metadata、ledger 和 import lifecycle。Zeus 通过绝对路径环境变量把官方 external-agent importer 指向 Application Support 私有根，沿用官方 Claude-compatible session records；`zeus-legacy` 仅作为 import source 标识，不新增 parser、rollout writer 或 per-conversation 模式选择器。

**Tech Stack:** Rust/Cargo、OpenAI Codex app-server 0.144.2、TypeScript、Electron 42.4.0、Fastify、sql.js、React、Vitest、electron-builder。

## Global Constraints

- 仅在用户再次明确确认 develop 后执行本计划；当前 PLAN 不得修改源码、测试、构建、依赖或数据。
- 上游固定到完整 commit `a6645b6b8a656360fa16fb7e1c6721d0697d3d6a`；禁止 floating branch、系统 Codex fallback 或读取 `/Applications/Codex.app` 资源。
- Rust app-server 是 thread/turn/item、rollout、metadata/state 和 import ledger 的唯一所有者。
- Zeus 不写 `~/.codex/sessions`，不写用户真实 `~/.claude/projects`，不使用 `additionalContext` 冒充历史导入。
- 已有真实 `providerThreadId` 的 3 条 native conversation 不进入 legacy import。
- legacy source 只有在 import completed success、`thread/read` 验证和 Zeus mapping 事务都成功后才归档。
- 同一 source conversation + canonical snapshot path + SHA-256 必须幂等；任何歧义、越权路径或部分失败都 fail-closed。
- 会话页删除“新建 / 续接 / 引用”单选面板；新建入口首发即 start，native 历史发送即 resume，legacy 只读记录引导到 Settings import。
- 所有前端变更执行 `frontend-skill`、`impeccable`、`accessibility`，保持键盘、focus-visible、live region、reduced-motion 和中英文 copy。
- 不覆盖当前 dirty worktree 中的用户修改；每个 task 前后记录受影响 Git 工作区、branch、status 和 scoped diff。
- 不执行 git commit/push/merge/revert。

---

## File Map

> **2026-07-14 implementation correction:** Upstream source inspection and the real bundled-binary probe proved that no custom `zeus-legacy-session-v1` parser is required. The Task 2 custom-schema/provider steps below are superseded by the implemented minimal patch: `ZEUS_CODEX_EXTERNAL_AGENT_HOME` selects an absolute Zeus-private external-agent root; relative overrides fail closed; snapshots use the official Claude-compatible `custom-title` plus user/assistant JSONL records. This correction is authoritative wherever the older checklist conflicts.

### Pinned Rust runtime supply

- Create `third_party/openai-codex/runtime.lock.json`: upstream tag/commit、source URL、binary version、supported arches、patch list、license。
- Create `third_party/openai-codex/NOTICE.md`: Apache-2.0 attribution 与 Zeus patch 说明。
- Create `third_party/openai-codex/patches/0001-zeus-legacy-session-source.patch`: 只增加私有 external-agent home 的绝对路径覆盖与 fail-closed 测试，复用官方 detect/parser/importer/ThreadStore。
- Create `scripts/build-codex-runtime.mjs`: checkout/verify/apply/build/copy/checksum。
- Create `scripts/build-codex-runtime.test.ts`: lock、commit、patch、arch、checksum 和 fail-closed 测试。

### Electron packaging/runtime path

- Create `apps/desktop/src/main/codexRuntimePath.ts`: packaged/dev runtime path 和 integrity manifest 解析。
- Create `apps/desktop/test/codex-runtime-path.test.ts`: packaged/dev/no-binary/checksum/version cases。
- Modify `apps/desktop/src/main/main.ts`: 将固定 runtime path 和 Application Support import root 传入 local server。
- Modify `apps/desktop/src/main/localServerRuntime.ts`: 新增 `codexRuntimeCommandPath`、`codexLegacyImportRoot` options。
- Modify `apps/desktop/electron-builder.yml`: `extraResources` 装配 `.tmp/codex-runtime/${arch}`。
- Modify `scripts/package-mac.mjs`、`scripts/package-mac.test.ts`: 先构建/校验 Rust runtime，再打包、签名和 health check。

### App-server protocol and import service

- Modify `packages/ai-runtime/src/codexAppServerManager.ts`: detect/import/read histories 与 progress/completed listener。
- Modify `packages/ai-runtime/src/codexAppServerProtocol.ts`: exact 0.144.2 wire types/parsers。
- Modify `packages/ai-runtime/test/codex-app-server-manager.test.ts`、`codex-app-server-protocol.test.ts`、`codex-app-server-live.test.ts`: protocol lifecycle and live probe。
- Create `packages/local-server/src/codexLegacyImportService.ts`: eligibility、snapshot、import/recovery、mapping transaction。
- Create `packages/local-server/test/codex-legacy-import-service.test.ts`: happy path、partial failure、timeout、crash recovery、idempotency、path security。
- Modify `packages/local-server/src/index.ts`: fixed runtime path、startup recovery、REST endpoints、realtime event mapping。
- Modify `packages/local-server/test/codex-native-conversation-api.test.ts`: end-to-end import and direct resume。

### Storage

- Modify `packages/storage/src/index.ts`: import run/source mapping migration and repositories。
- Modify `packages/storage/test/storage.test.ts`: schema、unique key、state transitions、transaction rollback。

### Renderer

- Create `apps/desktop/src/renderer/settings/LegacyChatImportSettings.tsx`: Settings import row/progress/failures/retry。
- Create `apps/desktop/test/legacy-chat-import-settings.test.tsx`: UI states and accessibility。
- Modify `apps/desktop/src/renderer/apiClient.ts`: detect/start/read import API types。
- Modify `apps/desktop/src/renderer/App.tsx`: Settings integration, onboarding eligibility, refresh conversations。
- Modify `apps/desktop/src/renderer/session/SessionWorkspace.tsx`: direct create/resume, remove mode/reference UI。
- Modify `apps/desktop/src/renderer/session/sessionTypes.ts`: remove `reference_legacy` start payload。
- Modify `apps/desktop/src/renderer/session/session.css`: remove obsolete mode-radio styles; add only import link/banner states required in session scope。
- Modify `apps/desktop/test/session-workspace.test.tsx`、`session-controller.test.tsx`、`app-shell-layout.test.tsx`: lock direct interaction and reverse-scan forbidden mode UI。

### Documentation/verification

- Modify `docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md`.
- Modify `docs/superpowers/specs/2026-07-14-zeus-codex-app-session-runtime-parity-design.md`.
- Modify `docs/TASK_20260714_002_Zeus与Codex会话持久化实现差异.html`.

---

### Task 1: Pin and reproduce the Codex 0.144.2 Rust runtime

**Files:**
- Create: `third_party/openai-codex/runtime.lock.json`
- Create: `third_party/openai-codex/NOTICE.md`
- Create: `scripts/build-codex-runtime.mjs`
- Test: `scripts/build-codex-runtime.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces `buildCodexRuntime({ arch, cacheDir, outputDir }): Promise<CodexRuntimeManifest>`.
- Produces `.tmp/codex-runtime/<arch>/codex` and `.tmp/codex-runtime/<arch>/manifest.json`.
- `CodexRuntimeManifest = { upstreamCommit, binaryVersion, arch, sha256, protocolSchemaSha256, patches }`.

- [ ] **Step 1: Record the clean source lock and attribution**

Create a lock with exact values:

```json
{
  "repository": "https://github.com/openai/codex.git",
  "tag": "rust-v0.144.2",
  "tagObject": "06eee5f70addf0b8cf331d5c6721f0414e7d2ae6",
  "commit": "a6645b6b8a656360fa16fb7e1c6721d0697d3d6a",
  "binaryVersion": "0.144.2",
  "arches": ["aarch64-apple-darwin", "x86_64-apple-darwin"],
  "patches": ["patches/0001-zeus-legacy-session-source.patch"],
  "license": "Apache-2.0"
}
```

`NOTICE.md` must link the upstream repository/release, include Apache-2.0 attribution, list the exact commit and state that Zeus adds only the `zeus-legacy` import source patch.

- [ ] **Step 2: Write RED tests for source and build integrity**

Tests must assert:

```ts
expect(lock.commit).toBe('a6645b6b8a656360fa16fb7e1c6721d0697d3d6a');
await expect(buildCodexRuntime({ ...input, resolvedHead: 'wrong' })).rejects.toThrow('upstream commit mismatch');
await expect(buildCodexRuntime({ ...input, patchExitCode: 1 })).rejects.toThrow('Codex patch did not apply cleanly');
expect(manifest.binaryVersion).toBe('0.144.2');
expect(manifest.arch).toBe(process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/u);
expect(manifest.protocolSchemaSha256).toMatch(/^[a-f0-9]{64}$/u);
```

- [ ] **Step 3: Run RED**

Run:

```bash
pnpm vitest run scripts/build-codex-runtime.test.ts --reporter=verbose
```

Expected: FAIL because the lock and builder do not exist.

- [ ] **Step 4: Implement the minimal reproducible builder**

The builder must:

1. use `.tmp/openai-codex/<commit>` as cache;
2. fetch only when the exact commit is absent;
3. verify `git rev-parse HEAD` equals the lock commit;
4. reset only its private `.tmp` checkout, never the Zeus worktree;
5. apply every locked patch with `git apply --check` then `git apply`;
6. run `cargo build --locked --release --bin codex --target <target>`;
7. copy the binary to `.tmp/codex-runtime/<arch>/codex`;
8. run `codex --version` and `codex app-server generate-ts`;
9. compute binary and normalized schema SHA-256;
10. write `manifest.json` atomically.

Do not download during `package:mac` if the private cache is missing and offline mode is enabled; fail with an actionable cache command.

- [ ] **Step 5: Run GREEN and inspect the manifest**

```bash
pnpm vitest run scripts/build-codex-runtime.test.ts --reporter=verbose
node scripts/build-codex-runtime.mjs --arch "$(uname -m)" --prepare
./.tmp/codex-runtime/"$(uname -m)"/codex --version
```

Expected: tests PASS; version output is `codex-cli 0.144.2`; manifest hashes are non-empty.

- [ ] **Step 6: Diff/review checkpoint**

```bash
git status --short
git diff -- .gitignore scripts/build-codex-runtime.mjs scripts/build-codex-runtime.test.ts third_party/openai-codex
```

Confirm no source checkout or binary is tracked. Do not commit.

### Task 2: Add the `zeus-legacy` source inside the pinned app-server

**Files:**
- Create: `third_party/openai-codex/patches/0001-zeus-legacy-session-source.patch`
- Test through patched upstream:
  - `codex-rs/external-agent-sessions/tests/zeus_records.rs`
  - `codex-rs/app-server/tests/suite/external_agent_config.rs`

**Interfaces:**
- Consumes snapshot schema `zeus-legacy-session-v1`.
- Reuses official `ExternalAgentConfigImportParams`, `ExternalAgentConfigImportResponse`, progress/completed notifications and `ThreadStore` importer.
- Provider id is exactly `zeus-legacy`.

- [ ] **Step 1: Define the strict source record schema in the patch**

Each JSONL source starts with one meta line and then message lines:

```json
{"type":"zeus_session_meta","schema":"zeus-legacy-session-v1","sourceConversationId":"conversation_123","projectId":"project_123","taskId":"task_123","cwd":"/allowed/project","title":"分析当前项目结构","exportedAt":"2026-07-14T00:00:00.000Z"}
{"type":"message","id":"message_1","role":"user","content":"原始用户消息","createdAt":"2026-07-09T05:44:08.000Z"}
{"type":"message","id":"message_2","role":"assistant","content":"原始助手消息","createdAt":"2026-07-09T05:44:10.000Z"}
```

Reject unknown types/roles, duplicate ids, blank content, invalid RFC3339 timestamps, multiple meta lines, message-before-meta, cwd outside declared allowed roots, symlink source, non-regular file and schema mismatch.

- [ ] **Step 2: Write upstream RED tests before provider code**

Tests must prove:

- detect returns only valid `.jsonl` files in the dedicated Zeus source root;
- import success creates a durable thread and completed success target equals the new threadId;
- `thread/read` returns imported user/assistant turns;
- same canonical path and hash is idempotent through the existing ledger;
- traversal/symlink/cwd escape/schema errors produce failure stage without creating a thread;
- Claude/Cowork providers remain unchanged.

- [ ] **Step 3: Run RED inside the private checkout**

```bash
cargo test --manifest-path .tmp/openai-codex/a6645b6b8a656360fa16fb7e1c6721d0697d3d6a/codex-rs/Cargo.toml -p codex-external-agent-sessions zeus_records
cargo test --manifest-path .tmp/openai-codex/a6645b6b8a656360fa16fb7e1c6721d0697d3d6a/codex-rs/Cargo.toml -p codex-app-server external_agent_config
```

Expected: FAIL because `zeus-legacy` source/parser is absent.

- [ ] **Step 4: Implement only the provider seam**

The patch must add a provider branch that:

```rust
pub const ZEUS_LEGACY_SOURCE: &str = "zeus-legacy";

pub struct ZeusSessionRecord {
    pub id: String,
    pub role: ZeusMessageRole,
    pub content: String,
    pub created_at: DateTime<Utc>,
}
```

It converts validated Zeus records into the same internal external-message representation consumed by the existing exporter. It must not duplicate ThreadStore creation, append, persistence, ledger, progress or completed code. The source root arrives through an app-server config/env field owned by Zeus and is canonicalized once.

- [ ] **Step 5: Run upstream GREEN and regression**

Run the two focused commands above, then:

```bash
cargo test --manifest-path .tmp/openai-codex/a6645b6b8a656360fa16fb7e1c6721d0697d3d6a/codex-rs/Cargo.toml -p codex-external-agent-sessions
cargo test --manifest-path .tmp/openai-codex/a6645b6b8a656360fa16fb7e1c6721d0697d3d6a/codex-rs/Cargo.toml -p codex-app-server external_agent
```

Expected: all selected Rust tests PASS.

- [ ] **Step 6: Store and verify the patch**

Regenerate the single patch from the private checkout, remove timestamps/absolute paths, then prove:

```bash
node scripts/build-codex-runtime.mjs --verify-patches
rg -n "zeus-legacy|zeus-legacy-session-v1" third_party/openai-codex/patches/0001-zeus-legacy-session-source.patch
```

Expected: patch applies cleanly to the pinned commit and contains no unrelated upstream changes. Do not commit.

### Task 3: Type the external import lifecycle in `CodexAppServerManager`

**Files:**
- Modify: `packages/ai-runtime/src/codexAppServerProtocol.ts`
- Modify: `packages/ai-runtime/src/codexAppServerManager.ts`
- Test: `packages/ai-runtime/test/codex-app-server-protocol.test.ts`
- Test: `packages/ai-runtime/test/codex-app-server-manager.test.ts`
- Test: `packages/ai-runtime/test/codex-app-server-live.test.ts`

**Interfaces:**
- Produces:

```ts
detectExternalAgentConfig(input: { source: 'zeus-legacy' }): Promise<ExternalAgentConfigDetectResult>;
startExternalAgentImport(input: { source: 'zeus-legacy'; sessions: SessionMigration[] }): Promise<{ importId: string }>;
readExternalAgentImportHistories(): Promise<ExternalAgentImportHistory[]>;
subscribeExternalAgentImport(listener: (event: ExternalAgentImportEvent) => void): () => void;
```

- `SessionMigration = { path: string; cwd: string; title: string | null }`.
- Completed success requires `{ itemType: 'SESSIONS', source, target: threadId, cwd }`.

- [ ] **Step 1: Write protocol RED tests**

Cover exact request methods, `importId` validation, progress/completed parsing, unknown item type preservation, malformed success target rejection, listener unsubscribe and app-server restart generation isolation.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run packages/ai-runtime/test/codex-app-server-protocol.test.ts packages/ai-runtime/test/codex-app-server-manager.test.ts --reporter=verbose
```

Expected: FAIL because the methods/types do not exist.

- [ ] **Step 3: Implement exact 0.144.2 types and manager methods**

Use the generated 0.144.2 schema names and wire fields verbatim. Correlate completed events by `importId`; never treat timeout as provider failure. Listener exceptions must not crash the transport.

- [ ] **Step 4: Run GREEN and a bundled live probe**

```bash
pnpm vitest run packages/ai-runtime/test/codex-app-server-protocol.test.ts packages/ai-runtime/test/codex-app-server-manager.test.ts --reporter=verbose
ZEUS_CODEX_LIVE=1 ZEUS_CODEX_RUNTIME_PATH="$PWD/.tmp/codex-runtime/$(uname -m)/codex" pnpm vitest run packages/ai-runtime/test/codex-app-server-live.test.ts -t "detects and imports a Zeus legacy session" --reporter=verbose
```

Expected: mock tests PASS; live probe returns an importId, completed target threadId and readable imported thread.

- [ ] **Step 5: Diff/review checkpoint**

Review only the two manager/protocol source files and three test files. Confirm existing start/resume/turn behavior and restart recovery remain unchanged. Do not commit.

### Task 4: Persist snapshots, import runs and source mappings transactionally

**Files:**
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/storage.test.ts`
- Create: `packages/local-server/src/codexLegacyImportService.ts`
- Test: `packages/local-server/test/codex-legacy-import-service.test.ts`

**Interfaces:**
- Produces `CodexLegacyImportRepository` with `createRun`, `markStarted`, `markCompleted`, `markFailed`, `getByImportId`, `listRecoverable`, `bindThreadAndArchiveSource`.
- Produces `createCodexLegacyImportService({ manager, db, repositories, sourceRoot, allowedProjectRoots, commandPath })`.
- Service methods: `detect()`, `start({ sourceConversationIds })`, `get(importId)`, `recover()`.

- [ ] **Step 1: Write storage migration RED tests**

Schema must store run id, provider import id, source conversation id, canonical path, SHA-256, status, target thread id, failure stage/message, binary version and timestamps. Add unique key on `(source_conversation_id, snapshot_sha256)` and partial uniqueness for non-null target thread id.

Tests must prove duplicate source/hash reuses the record, state transitions reject completed→running, and transaction rollback leaves the source unarchived.

- [ ] **Step 2: Run storage RED**

```bash
pnpm vitest run packages/storage/test/storage.test.ts -t "Codex legacy import" --reporter=verbose
```

Expected: FAIL because schema/repository are absent.

- [ ] **Step 3: Implement schema and repository GREEN**

Use the existing migration ledger and repository transaction patterns. Never store message content in the import table; content exists only in the private snapshot and original conversation messages.

- [ ] **Step 4: Write service RED tests**

Cover:

1. eligible means unarchived `legacy_cli`, no providerThreadId, at least one user message and cwd inside a real project root;
2. snapshot is atomically written with mode `0600`, canonicalized and hashed;
3. manager import success → `thread/read` → one database transaction binds native conversation and archives source;
4. completed failure, malformed target, read failure, DB rollback and partial multi-source failure preserve each affected legacy source;
5. timeout status remains `waiting`, not `failed`;
6. restart `recover()` uses `import/readHistories`, then idempotently completes binding;
7. same source/hash does not start a second Rust import.

- [ ] **Step 5: Run service RED**

```bash
pnpm vitest run packages/local-server/test/codex-legacy-import-service.test.ts --reporter=verbose
```

Expected: FAIL because the service is absent.

- [ ] **Step 6: Implement minimal service**

Snapshot writing order is temp file → fsync → chmod 0600 → rename → canonicalize → SHA-256. Completed processing order is validate target → `thread/read(includeTurns=true)` → database transaction → archive source. Sanitize provider error text before persistence/logging.

- [ ] **Step 7: Run GREEN and regression**

```bash
pnpm vitest run packages/storage/test/storage.test.ts packages/local-server/test/codex-legacy-import-service.test.ts packages/local-server/test/legacy-codex-thread-migration.test.ts --reporter=verbose
```

Expected: all selected tests PASS; the existing real-thread migration still handles only sources that already contain provider thread IDs.

### Task 5: Expose Settings import APIs and force the bundled runtime path

**Files:**
- Modify: `apps/desktop/src/main/codexRuntimePath.ts`
- Test: `apps/desktop/test/codex-runtime-path.test.ts`
- Modify: `apps/desktop/src/main/localServerRuntime.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `packages/local-server/src/index.ts`
- Test: `packages/local-server/test/codex-native-conversation-api.test.ts`
- Test: `apps/desktop/test/main-runtime.test.ts`

**Interfaces:**
- `CreateLocalServerOptions` gains required native fields when native is enabled: `codexRuntimeCommandPath`, `codexLegacyImportRoot`.
- REST:
  - `GET /api/codex-native/import` → eligibility + active/history snapshot;
  - `POST /api/codex-native/import` body `{ sourceConversationIds: string[] }` → `{ importId, status }`;
  - `GET /api/codex-native/import/:importId` → current progress/results.
- Realtime event type `codex.legacy_import.updated` carries ids/counts/status only, never prompt content.

- [ ] **Step 1: Write RED path and API tests**

Assert packaged path is `process.resourcesPath/codex/codex`; development path comes only from the explicit build manifest; missing/checksum/version mismatch fails. API rejects unknown/duplicate/cross-project source ids and never reads `runtimeSettings.adapterCliPaths.codex` for native conversations.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run apps/desktop/test/codex-runtime-path.test.ts apps/desktop/test/main-runtime.test.ts packages/local-server/test/codex-native-conversation-api.test.ts -t "legacy import|bundled Codex runtime" --reporter=verbose
```

Expected: FAIL because the resolver/options/routes do not exist.

- [ ] **Step 3: Implement fixed runtime injection, recovery and APIs**

At startup: resolve/verify bundled runtime → construct manager/coordinator/import service → recover import histories → recover native submissions. Existing legacy real-thread migration runs before import eligibility and continues to skip no-thread sources.

- [ ] **Step 4: Run GREEN and endpoint security regression**

```bash
pnpm vitest run apps/desktop/test/codex-runtime-path.test.ts apps/desktop/test/main-runtime.test.ts packages/local-server/test/codex-native-conversation-api.test.ts packages/local-server/test/server.test.ts --reporter=verbose
```

Expected: all selected tests PASS; native runtime path cannot be overridden by Settings/PATH.

### Task 6: Replace mode selection with Codex App interaction

**Files:**
- Create: `apps/desktop/src/renderer/settings/LegacyChatImportSettings.tsx`
- Test: `apps/desktop/test/legacy-chat-import-settings.test.tsx`
- Modify: `apps/desktop/src/renderer/apiClient.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/session/SessionWorkspace.tsx`
- Modify: `apps/desktop/src/renderer/session/sessionTypes.ts`
- Modify: `apps/desktop/src/renderer/session/session.css`
- Test: `apps/desktop/test/session-workspace.test.tsx`
- Test: `apps/desktop/test/session-controller.test.tsx`
- Test: `apps/desktop/test/app-shell-layout.test.tsx`

**Interfaces:**
- Settings component consumes `snapshot`, `onImport(sourceIds)`, `onRetry(importId)`, `onOpenConversation(conversationId)`.
- New-session submit payload is only `{ mode: 'create', content }`.
- Existing native conversation uses the existing composer `onSend`; no start-choice payload is created.
- Legacy banner receives `onOpenImportSettings` and stays read-only.

- [ ] **Step 1: Load frontend skills and capture current baseline**

Read `frontend-skill`, `impeccable`, `accessibility`; capture the current Settings and session screens before editing. Do not introduce cards, radio rows or duplicated headings.

- [ ] **Step 2: Write Settings import RED tests**

Cover eligible count, empty/hidden state, explicit Import button, in-progress disable/live region, partial failure rows, 120s waiting timeout copy, retry, completed count, keyboard focus and bilingual labels.

- [ ] **Step 3: Write session interaction RED tests**

Assert:

```ts
expect(newSessionHtml).not.toContain('session-start-mode');
expect(newSessionHtml).not.toContain('session-start-radio');
expect(newSessionHtml).not.toContain('引用旧会话');
expect(nativeHistoryHtml).toContain('aria-label="发送消息给 Codex"');
expect(legacyHtml).toContain('前往设置导入');
expect(legacyHtml).not.toContain('name="session-start-mode"');
```

Controller tests prove new draft submit calls create exactly once, native history submit resumes the selected conversation, and legacy has no send path.

- [ ] **Step 4: Run RED**

```bash
pnpm vitest run apps/desktop/test/legacy-chat-import-settings.test.tsx apps/desktop/test/session-workspace.test.tsx apps/desktop/test/session-controller.test.tsx --reporter=verbose
```

Expected: FAIL on missing Settings component and obsolete mode UI.

- [ ] **Step 5: Implement the minimal Codex App flow**

Add a single Settings preference row with secondary metadata and one Import/Import again action. New session surface becomes task context + composer only. Delete `SessionStartMode`, `reference_legacy` request construction, message checkbox selection, radio CSS and App.tsx legacy-message preloading used only for reference injection. Preserve read-only transcript rendering and route its action to Settings.

- [ ] **Step 6: Run GREEN and reverse scans**

```bash
pnpm vitest run apps/desktop/test/legacy-chat-import-settings.test.tsx apps/desktop/test/session-workspace.test.tsx apps/desktop/test/session-controller.test.tsx apps/desktop/test/app-shell-layout.test.tsx --reporter=verbose
rg -n "reference_legacy|session-start-mode|session-start-radio|选择要引用的旧消息|Select legacy messages to reference" apps/desktop/src apps/desktop/test packages/local-server/src packages/local-server/test
```

Expected: tests PASS; reverse scan returns no production behavior and only explicit negative assertions/migration documentation if retained.

- [ ] **Step 7: Visual and accessibility verification**

Run the packaged/dev UI with real detect data and capture Settings states at desktop and narrow widths. Verify focus order, visible focus, no overflow, status text independent of color, reduced motion and direct send in imported conversation.

### Task 7: Package, migrate a real-data copy, review and verify

**Files:**
- Modify: `apps/desktop/electron-builder.yml`
- Modify: `scripts/package-mac.mjs`
- Modify: `scripts/package-mac.test.ts`
- Modify: `scripts/verify-packaged-app-health.mjs`
- Modify: task/spec/diagram docs listed in File Map.

**Interfaces:**
- electron-builder copies `.tmp/codex-runtime/${arch}/codex` and manifest into `Contents/Resources/codex/`.
- Packaged health returns nonzero if binary, checksum, version, schema fingerprint, app-server handshake or import methods are missing.

- [ ] **Step 1: Write RED packaging tests**

Assert `packageMac()` invokes runtime build before Electron build; config has arch-specific `extraResources`; health check executes the bundled path and checks `externalAgentConfig/detect/import` in generated schema; codesign runs after resources are present.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run scripts/package-mac.test.ts --reporter=verbose
```

Expected: FAIL because runtime packaging/integrity checks are absent.

- [ ] **Step 3: Implement packaging and health gate**

Do not copy from `/Applications/Codex.app` and do not package a PATH-resolved binary. The generated manifest travels beside the binary; main-process runtime path verification and health script use the same manifest parser.

- [ ] **Step 4: Run affected suites and static gates**

```bash
pnpm vitest run scripts/build-codex-runtime.test.ts scripts/package-mac.test.ts packages/ai-runtime/test/codex-app-server-protocol.test.ts packages/ai-runtime/test/codex-app-server-manager.test.ts packages/local-server/test/codex-legacy-import-service.test.ts packages/local-server/test/codex-native-conversation-api.test.ts packages/storage/test/storage.test.ts apps/desktop/test/codex-runtime-path.test.ts apps/desktop/test/legacy-chat-import-settings.test.tsx apps/desktop/test/session-workspace.test.tsx apps/desktop/test/session-controller.test.tsx apps/desktop/test/app-shell-layout.test.tsx --reporter=basic
pnpm typecheck
pnpm lint
pnpm format:check
git diff --check
```

Expected: all commands exit 0. Record any unrelated pre-existing failure separately; do not rename it as success.

- [ ] **Step 5: Request code review**

Use `superpowers:requesting-code-review`. Reviewer must read the current AGENTS instructions, `DESIGN.md`, the design spec, this plan, every affected Git root/status/diff, Rust patch, source lock, tests and verification output. Resolve all Critical/Important findings with a new RED/GREEN cycle.

- [ ] **Step 6: Verify a real database copy**

Copy the real Zeus DB and required legacy records into a private temp directory. Never point the test at the live DB. Verify:

- 3 existing native threads remain unchanged and resumable;
- 2 no-thread legacy rows are eligible before explicit import;
- explicit import creates readable target threads and binds native conversations;
- App restart recovers import history;
- a second import is idempotent;
- injected partial failure leaves the affected legacy row unarchived;
- no prompt content leaks into import diagnostics.

- [ ] **Step 7: Package and verify the real App**

Safely quit the running packaged Zeus, then run:

```bash
pnpm package:mac
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app
node scripts/verify-packaged-app-health.mjs dist/mac-arm64/Zeus.app
```

Expected: package, codesign and health commands exit 0; health reports bundled `codex-cli 0.144.2`, expected commit manifest and import capabilities.

- [ ] **Step 8: GUI acceptance and original-requirement audit**

With the newly packaged App: open Settings, explicitly import one legacy conversation, wait for success, open the imported conversation and send a follow-up. Confirm no mode buttons appear. Then reverse-scan the original rejected patterns and update the task doc/diagram with exact commands, outputs, remaining gaps and rollback evidence.

- [ ] **Step 9: Completion gate**

Use `superpowers:verification-before-completion`. Re-run the full required command set fresh before any completion claim. Do not commit.

## Rollback

1. Set the import kill switch off to stop new imports while preserving existing native threads.
2. Restore the previous bundled runtime manifest/binary pair; never fallback to PATH.
3. Remove Settings import entry/API wiring without deleting ThreadStore rollout or completed mappings.
4. Restore archived legacy source records from the pre-migration database backup; keep imported native rows marked with their source mapping.
5. Retain snapshots and ledger for audit until the user explicitly authorizes deletion.

## Execution Handoff

本计划只允许在当前 workspace 内由 `superpowers:executing-plans` 分批执行并设置 review checkpoints。由于系统禁止 subagent 且用户未授权 Git 历史操作，不提供 subagent/commit 选项。

`READINESS: READY FOR DEVELOP CONFIRMATION`
