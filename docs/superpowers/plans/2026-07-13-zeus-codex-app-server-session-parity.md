# Zeus 会话页与 Codex App Server 对齐实施计划

> **面向 agentic workers：** 实施时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务推进；每个任务先读当前项目及受影响子目录的 `AGENTS.md` 和上级规约。步骤使用复选框追踪。

**目标：** 将 Zeus 的 Codex 会话从 `codex exec` / PTY / 最近消息重放，升级为真实 native app-server thread / turn / item 连续对话，并让会话页的布局、状态、交互和动效对齐当前 Codex App。

**架构：** `@zeus/ai-runtime` 提供无业务状态的 stdio JSON-RPC transport；Electron Main 的 `DesktopLocalServerRuntime` 拥有一个应用级 `CodexAppServerManager` 并跨 Fastify 换端口复用；`@zeus/local-server` 的 coordinator 负责 Task / conversation / thread / turn / item / request / queue / idempotency 映射；Renderer 通过 REST 快照和结构化 WebSocket 增量事件驱动纯状态机。

**技术栈：** TypeScript、Node.js child_process、Fastify、WebSocket、sql.js、Electron、React 19、Vitest、CSS/WAAPI、macOS Codex CLI app-server。

## 全局约束

- 用户已于 2026-07-13 明确确认进入 develop；本文现作为实施与 verification 记录。未完成的真实运行、可访问性与打包验收继续保持未勾选，不以自动化测试替代。
- 不执行 `git commit/push/merge/revert`；即使任务步骤通过，也只记录验证证据并请求 review。
- 当前工作树已有大量未提交修改；每个任务开始前记录真实 Git 根、分支、`git status --short` 和目标文件 diff，不覆盖、不回退用户改动。
- Codex 写路径只能使用 native app-server；禁止将 `codex exec`、PTY stdin、最近 12 条消息重放作为 Codex 续接或回滚方案。
- Claude、Gemini、Generic shell adapter 保留当前 CLI/PTY 路径。
- 一个 Zeus 应用实例只托管一个私有 stdio app-server；不连接、不复用、不接管 Codex Desktop 自己的 app-server。
- 一个 Task 可以拥有多个 conversation/thread；已有历史时必须让用户显式选择 resume/new/reference legacy，不能静默选择最新。
- legacy conversation 保留只读；引用历史必须创建新的 native thread，并记录来源，绝不伪装 `thread/resume`。
- `turn/completed` 只让 native thread 回 idle；Task 只有用户显式“标记完成”才进入 completed。
- app-server 的 server request 必须按 generationId + provider requestId 防重；未知权限或协议形状 fail-closed。
- 不新增外部运行依赖；会话动效使用 CSS/WAAPI。Desktop 仅新增内部 workspace 依赖 `@zeus/ai-runtime`，会更新 `apps/desktop/package.json` 与 `pnpm-lock.yaml`，用户确认本计划进入 develop 即视为确认该内部依赖变更。
- 视觉按用户决策逐项对齐 Codex App；task-scoped precedence 已写入 `DESIGN.md:216-225`，只在 `.session-codex-parity-v1` 覆盖通用外部品牌限制。不复制 bundle 专有源码；图标使用仓库已有或系统等价图标，未确认授权的专有资产不进入仓库。
- 页面主端为 macOS Desktop；响应式仍需覆盖 360/480/768/1240/1440，键盘和 VoiceOver 满足 WCAG 2.2 AA。
- 所有动效提供 `prefers-reduced-motion` 降级；关闭 opacity/scale/shimmer/spring/smooth-scroll/展开折叠动画。
- 实施收尾前必须运行 `superpowers:requesting-code-review`；最终声明前必须运行 `superpowers:verification-before-completion`。

---

## 文件结构锁定

### 新建

- `packages/ai-runtime/src/codexAppServerProtocol.ts`：wire 类型、逐行 decoder、响应/通知/server request 判别。
- `packages/ai-runtime/src/codexAppServerManager.ts`：应用级 manager、请求关联、thread/turn API、generation、重启与关闭。
- `packages/ai-runtime/test/codex-app-server-protocol.test.ts`
- `packages/ai-runtime/test/codex-app-server-manager.test.ts`
- `packages/ai-runtime/test/codex-app-server-live.test.ts`
- `packages/ai-runtime/test/fixtures/fake-codex-app-server.mjs`
- `packages/local-server/src/codexNativeConversationContracts.ts`：REST/WS/coordinator tagged union。
- `packages/local-server/src/codexNativeConversationCoordinator.ts`：native 会话、queue/steer、request 和恢复编排。
- `packages/local-server/test/codex-native-conversation-coordinator.test.ts`
- `packages/local-server/test/codex-native-conversation-api.test.ts`
- `apps/desktop/src/renderer/session/sessionTypes.ts`
- `apps/desktop/src/renderer/session/sessionReducer.ts`
- `apps/desktop/src/renderer/session/sessionSelectors.ts`
- `apps/desktop/src/renderer/session/useSessionController.ts`
- `apps/desktop/src/renderer/session/useThreadScrollController.ts`
- `apps/desktop/src/renderer/session/SessionWorkspace.tsx`
- `apps/desktop/src/renderer/session/ProjectConversationTree.tsx`
- `apps/desktop/src/renderer/session/ConversationTranscript.tsx`
- `apps/desktop/src/renderer/session/ThreadItemView.tsx`
- `apps/desktop/src/renderer/session/ConversationComposer.tsx`
- `apps/desktop/src/renderer/session/PendingRequestSurface.tsx`
- `apps/desktop/src/renderer/session/LegacyConversationBanner.tsx`
- `apps/desktop/src/renderer/session/session.css`
- `apps/desktop/test/session-reducer.test.ts`
- `apps/desktop/test/session-scroll-controller.test.ts`
- `apps/desktop/test/session-controller.test.tsx`
- `apps/desktop/test/session-workspace.test.tsx`

### 修改

- `packages/ai-runtime/src/index.ts:76-149,498-639`
- `packages/ai-runtime/test/session.test.ts:246-299`
- `packages/storage/src/index.ts:251-316,596-930,1797-1965`
- `packages/storage/test/storage.test.ts`
- `packages/local-server/src/index.ts:20-35,91-115,902-973,1080-1094,1247-1535,2267-2308,6450-6561,7194-7550,7584-7629,7818-7848`
- `packages/local-server/test/task-control-api.test.ts:334-430,700-840`
- `packages/local-server/test/events-ws.test.ts`
- `apps/desktop/src/main/localServerRuntime.ts:1-112`
- `apps/desktop/src/main/main.ts:587-619`
- `apps/desktop/test/main-runtime.test.ts:188-358`
- `apps/desktop/package.json`
- `pnpm-lock.yaml`
- `apps/desktop/src/renderer/apiClient.ts:670-698,1129-1169,1355-1361,1515-1525`
- `apps/desktop/src/renderer/main.tsx:160-186,300-318`
- `apps/desktop/src/renderer/App.tsx:5626-5760,7576-7604,8383-8838,12743-12906`
- `apps/desktop/src/renderer/styles.css:7963-8502,10273-10457`
- `apps/desktop/test/api-client.test.ts:47-75,1964-2005`
- `apps/desktop/test/app-shell-layout.test.tsx:1179-1679`
- `DESIGN.md:209-225`
- `docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md`

---

### Task 1：Native app-server wire 协议与反向防回归

**文件：**
- 新建：`packages/ai-runtime/src/codexAppServerProtocol.ts`
- 新建：`packages/ai-runtime/test/codex-app-server-protocol.test.ts`
- 新建：`packages/ai-runtime/test/fixtures/fake-codex-app-server.mjs`
- 修改：`packages/ai-runtime/src/index.ts:135-149`
- 修改：`packages/ai-runtime/test/session.test.ts:246-299`

**接口：**
- 产出 `CodexWireResponse | CodexWireNotification | CodexWireServerRequest`。
- 产出 `CodexJsonLineDecoder.push(chunk): CodexDecodedFrame[]`；每帧是 message 或独立 protocol_error。
- `createAiCliAdapterInvocation('codex', ...)` 必须抛出 `CODEX_NATIVE_APP_SERVER_REQUIRED`，其他 adapter 参数保持现状。

- [x] **步骤 1：先写协议分帧失败测试**

```ts
it('decodes split UTF-8 JSON lines and keeps the next valid frame after malformed input', () => {
  const decoder = new CodexJsonLineDecoder();
  const bytes = Buffer.from('{"id":1,"result":{"ok":"好"}}\r\nnot-json\n{"method":"thread/started","params":{}}\n');
  const chineseByte = bytes.indexOf(Buffer.from('好'));
  const frames = [
    ...decoder.push(bytes.subarray(0, chineseByte + 1)),
    ...decoder.push(bytes.subarray(chineseByte + 1)),
  ];
  expect(frames[0]).toEqual({ type: 'message', message: { id: 1, result: { ok: '好' } } });
  expect(frames[1]).toMatchObject({ type: 'protocol_error', error: { code: 'MALFORMED_JSON' } });
  expect(frames[2]).toEqual({ type: 'message', message: { method: 'thread/started', params: {} } });
});
```

- [x] **步骤 2：运行失败测试并确认不存在实现**

```bash
pnpm vitest run packages/ai-runtime/test/codex-app-server-protocol.test.ts --reporter=verbose
```

预期：FAIL，原因是 `codexAppServerProtocol.ts` 或导出不存在，而不是环境问题。

- [x] **步骤 3：实现最小 wire 类型和 decoder**

```ts
export type CodexWireId = string | number;
export type CodexWireResponse = { id: CodexWireId; result?: unknown; error?: { code: number; message: string; data?: unknown } };
export type CodexWireNotification = { method: string; params: unknown };
export type CodexWireServerRequest = { id: CodexWireId; method: string; params: unknown };
export type CodexWireMessage = CodexWireResponse | CodexWireNotification | CodexWireServerRequest;
export type CodexDecodedFrame =
  | { type: 'message'; message: CodexWireMessage }
  | { type: 'protocol_error'; error: { code: 'MALFORMED_JSON' | 'FRAME_TOO_LARGE'; detail: string } };

export class CodexJsonLineDecoder {
  private static readonly maxPendingBytes = 4 * 1024 * 1024;
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): CodexDecodedFrame[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: CodexDecodedFrame[] = [];
    for (let lf = this.pending.indexOf(0x0a); lf >= 0; lf = this.pending.indexOf(0x0a)) {
      let line = this.pending.subarray(0, lf);
      this.pending = this.pending.subarray(lf + 1);
      if (line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      if (line.length > CodexJsonLineDecoder.maxPendingBytes) {
        frames.push({ type: 'protocol_error', error: { code: 'FRAME_TOO_LARGE', detail: `${line.length} bytes` } });
        continue;
      }
      try {
        frames.push({ type: 'message', message: JSON.parse(line.toString('utf8')) as CodexWireMessage });
      } catch (error) {
        frames.push({ type: 'protocol_error', error: { code: 'MALFORMED_JSON', detail: error instanceof Error ? error.message : 'invalid JSON' } });
      }
    }
    if (this.pending.length > CodexJsonLineDecoder.maxPendingBytes) {
      frames.push({ type: 'protocol_error', error: { code: 'FRAME_TOO_LARGE', detail: `${this.pending.length} pending bytes` } });
      this.pending = Buffer.alloc(0);
    }
    return frames;
  }
}
```

实现必须在 Buffer 完整取到 LF 后才执行 UTF-8 decode，不能对半个多字节字符先 `toString()` 再回编码。每行单独 try/catch，malformed 帧不能阻断后续合法帧；未结束帧和单帧上限均为 4 MiB。不把 stderr 输入 decoder；错误文本执行 token、Authorization、private key 脱敏。

- [x] **步骤 4：补齐 wire 分类、数字/字符串 requestId、CRLF、timeout/exit 和 stderr 隔离用例**

预期覆盖：半行、多行、UTF-8 分片、未知 notification 保留 method、malformed 帧不吞下一合法帧、wire 不强制 `jsonrpc` 字段。

- [x] **步骤 5：删除生产 Codex `exec` invocation**

```ts
if (adapter.id === 'codex') {
  throw Object.assign(new Error('Codex requires the native app-server transport.'), {
    code: 'CODEX_NATIVE_APP_SERVER_REQUIRED',
  });
}
```

把原 `session.test.ts` 的 `codex exec` 正向断言改为反向断言；Claude/Gemini/Generic 原断言保持。

- [x] **步骤 6：运行协议与旧 adapter 回归**

```bash
pnpm vitest run packages/ai-runtime/test/codex-app-server-protocol.test.ts packages/ai-runtime/test/session.test.ts packages/ai-runtime/test/detect.test.ts --reporter=verbose
```

预期：PASS；生产 Codex invocation 不再返回 `exec`。

---

### Task 2：应用级 CodexAppServerManager

**文件：**
- 新建：`packages/ai-runtime/src/codexAppServerManager.ts`
- 新建：`packages/ai-runtime/test/codex-app-server-manager.test.ts`
- 新建：`packages/ai-runtime/test/codex-app-server-live.test.ts`
- 修改：`packages/ai-runtime/src/index.ts`

**接口：**

```ts
export interface CodexAppServerManager {
  ensureReady(input: { commandPath: string }): Promise<CodexCapabilitiesSnapshot>;
  startThread(input: CodexThreadStartInput): Promise<CodexThreadSnapshot>;
  resumeThread(input: { threadId: string; cwd?: string }): Promise<CodexThreadSnapshot>;
  readThread(input: { threadId: string }): Promise<CodexThreadSnapshot>;
  startTurn(input: CodexTurnStartInput): Promise<CodexTurnSnapshot>;
  steerTurn(input: CodexTurnSteerInput): Promise<{ turnId: string }>;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<void>;
  respondToServerRequest(input: CodexServerRequestResponse): Promise<void>;
  subscribe(listener: (event: CodexAppServerEvent) => void): () => void;
  getState(): CodexTransportState;
  prepareForShutdown(): Promise<void>;
  close(): Promise<void>;
}
```

事件固定包含：

```ts
export interface CodexAppServerEvent {
  generationId: string;
  sequence: number;
  method: string;
  params: unknown;
  receivedAt: string;
}
```

- [x] **步骤 1：写 lazy singleton 与握手顺序测试**

断言多个 thread 操作只 spawn 一次，参数精确为 `app-server --listen stdio://`，请求顺序为 `initialize -> initialized -> model/list`。

- [x] **步骤 2：写 thread/turn 路由和跨 thread 隔离测试**

使用 fake server 创建两个 thread；同一 thread 连续三个 turn；乱序通知必须按 threadId/turnId/itemId 路由，不得串写。

- [x] **步骤 3：实现 manager 的 pending request map 与 generation**

```ts
type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

type ManagerState =
  | { type: 'idle' }
  | { type: 'starting'; generationId: string }
  | { type: 'ready'; generationId: string; capabilities: CodexCapabilitiesSnapshot }
  | { type: 'restarting'; generationId: string; attempt: number }
  | { type: 'closed' };
```

进程退出时拒绝当前 generation 的全部 pending RPC；新进程必须生成新的 generationId，provider requestId 不能跨 generation 复用。

- [x] **步骤 4：实现模型、sandbox 与 effort 能力校验**

configured model 必须存在于 `model/list`；不存在时返回 `ZEUS_CODEX_MODEL_UNAVAILABLE` 和真实 supported list，不静默 fallback。无独立 effort 设置时省略 effort；禁止把旧值 `max` 未校验透传。

- [x] **步骤 5：实现 turn/start、steer、interrupt intent 与 server request response**

`turn/interrupt` 只有在观察到匹配 turnId 的 `turn/started` 后发送；若用户提前中断，仅保存 intent。command/file/permissions/request_user_input/MCP 使用不同 tagged union，不把 permissions 塞进通用 approval decision。

- [x] **步骤 6：实现 crash backoff 与幂等 close**

重启退避使用 250ms、500ms、1000ms、2000ms、5000ms 上限；`close()` 取消退避并只终止子进程一次。日志只保留脱敏 stderr 摘要和 generation/sequence。

- [x] **步骤 7：运行 manager 测试**

```bash
pnpm vitest run packages/ai-runtime/test/codex-app-server-manager.test.ts --reporter=verbose
```

预期：PASS，覆盖 lazy spawn、握手、模型 fail-closed、三轮、双 thread、steer、延迟 interrupt、server request、崩溃 generation、close。

- [x] **步骤 8：增加互相隔离的 opt-in live tests**

安全连续对话 probe 默认 `skipIf(process.env.ZEUS_LIVE_CODEX_PROBE !== '1')`：使用 `/tmp` 空仓、`read-only`、`approvalPolicy:'never'`，只验证相同 thread 三个不同 turn、新 generation resume、双 thread 和 turn/started 后 interrupt；该场景不得声称验证了审批。

审批 probe 另用 `skipIf(process.env.ZEUS_LIVE_CODEX_APPROVAL_PROBE !== '1')`：每次创建独立 `/tmp/zeus-codex-approval-probe-*` Git 仓，启动 flags 包含 `--enable request_permissions_tool --enable exec_permission_approvals`，thread 使用 `approvalPolicy:'untrusted'`、`approvalsReviewer:'user'`、`sandbox:{type:'readOnly',networkAccess:false}`。命令只允许 `/bin/zsh -lc "python3 -c 'print(\"ZEUS-COMMAND-APPROVAL\")'"`；file approval 只允许在临时根创建 `APPROVED.txt`，路径越界或未知命令立即 decline。分别观察 command approval、file approval、`serverRequest/resolved` 和 Plan request_user_input，结束后删除临时仓并确认项目源码未变化。permissions 真实 round trip 未补证时必须单列未通过，不能归并成 approval 已通过。

---

### Task 3：Storage 增量迁移、唯一身份和本地幂等

**文件：**
- 修改：`packages/storage/src/index.ts:251-316,596-930,1797-1965`
- 修改：`packages/storage/test/storage.test.ts`

**接口：**
- 新增 conversation transport/provider 字段。
- 新增 turn、item、submission、server request、idempotency repository。
- 新 migration ID：`20260713_0002_codex_native_conversation`；不得改旧 migration checksum。

- [x] **步骤 1：先写旧 DB 无损迁移测试**

创建只含原 conversations/messages 的内存库；迁移后旧行必须是 `transport_kind='legacy_cli'`、`provider_thread_id IS NULL`，历史消息数量和内容不变。

- [x] **步骤 2：写唯一约束与 completed 覆盖 delta 测试**

同 provider thread/item 重复 upsert 不增加行；`item/completed` 的权威文本覆盖 delta 聚合；不同 conversation 不能绑定同一 provider threadId。

- [x] **步骤 3：写 task 级和 conversation 级 idempotency 测试**

同 scope/key/hash 返回相同 status/body/resource；同 key 不同 hash 返回 `ZEUS_IDEMPOTENCY_CONFLICT`。

- [x] **步骤 4：实现增量列和索引**

```sql
ALTER TABLE conversations ADD COLUMN transport_kind TEXT NOT NULL DEFAULT 'legacy_cli';
ALTER TABLE conversations ADD COLUMN provider_id TEXT;
ALTER TABLE conversations ADD COLUMN provider_thread_id TEXT;
ALTER TABLE conversations ADD COLUMN provider_thread_path TEXT;
ALTER TABLE conversations ADD COLUMN provider_model TEXT;
ALTER TABLE conversations ADD COLUMN provider_state TEXT NOT NULL DEFAULT 'unbound';
ALTER TABLE conversations ADD COLUMN provider_protocol_version TEXT;
ALTER TABLE conversations ADD COLUMN provider_binary_version TEXT;
ALTER TABLE conversations ADD COLUMN legacy_source_conversation_id TEXT;
ALTER TABLE conversations ADD COLUMN provider_settings_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN provider_token_usage_json TEXT NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_provider_thread_id
ON conversations(provider_thread_id) WHERE provider_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_task_updated_at
ON conversations(task_id, updated_at);
```

对 sql.js 不支持的重复 `ADD COLUMN` 使用与现有 migration 相同的可重复执行捕获方式。

- [x] **步骤 5：创建 native 运行表**

```sql
CREATE TABLE IF NOT EXISTS conversation_turns (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
  provider_turn_id TEXT, client_submission_id TEXT NOT NULL, status TEXT NOT NULL,
  error_json TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turn_provider
ON conversation_turns(provider_thread_id, provider_turn_id) WHERE provider_turn_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_items (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, provider_item_id TEXT NOT NULL,
  item_type TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, text_content TEXT NOT NULL,
  payload_json TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_item_provider
ON conversation_items(provider_thread_id, provider_item_id);
```

同时创建 `conversation_submissions`、`conversation_server_requests`、`idempotency_requests`：submission 以 `(conversation_id,idempotency_key)` 唯一，server request 以 `(transport_generation_id,provider_request_id_json)` 唯一，task-level request 以 `(scope,idempotency_key)` 为主键。

```sql
CREATE TABLE IF NOT EXISTS conversation_submissions (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, client_message_id TEXT NOT NULL, kind TEXT NOT NULL,
  requested_delivery TEXT NOT NULL, status TEXT NOT NULL, queue_position INTEGER,
  input_json TEXT NOT NULL, target_provider_turn_id TEXT, provider_turn_id TEXT,
  paused_reason TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  dispatched_at TEXT, resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_submission_idempotency
ON conversation_submissions(conversation_id, idempotency_key);

CREATE TABLE IF NOT EXISTS conversation_server_requests (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT, item_id TEXT,
  transport_generation_id TEXT NOT NULL, provider_request_id_json TEXT NOT NULL,
  request_kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
  response_json TEXT, contains_secret INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_server_request_provider
ON conversation_server_requests(transport_generation_id, provider_request_id_json);

CREATE TABLE IF NOT EXISTS idempotency_requests (
  scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  status TEXT NOT NULL, http_status INTEGER, response_json TEXT, resource_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, idempotency_key)
);
```

`provider_request_id_json` 必须保存 JSON 标量原文，使数字 `1` 与字符串 `"1"` 不会被错误合并。所有 `kind/status/requested_delivery` 在 repository 层用显式 union 校验，未知值拒绝写入。

`thread/settings/updated` 和 `thread/tokenUsage/updated` 分别 upsert 到 conversation 的两个 JSON snapshot；`account/rateLimits/updated` 与 `mcpServer/startupStatus/updated` 通过现有 `settings` repository 保存到 `codex.native.rate_limits`、`codex.native.mcp_startup_status`。JSON 只保存 provider 返回的非 secret 状态；Renderer 重连 snapshot 必须能在没有新 delta 时恢复这些值。

- [x] **步骤 6：给 conversation_messages 增加 provider/client 身份**

新增 `provider_thread_id`、`provider_turn_id`、`provider_item_id`、`client_message_id`，并建立 conversation + provider_item 的 partial unique index。queued submission 不提前进入 transcript；只在 provider userMessage item 到达后 upsert 正式消息。

- [x] **步骤 7：实现 secret fail-closed**

`isSecret=true` 的 request_user_input 回答只存在于发送内存；DB、message、audit、response_json 只保存 questionId、答案数量与 `[REDACTED]`。测试通过全库导出反向搜索秘密值。

- [x] **步骤 8：写 provider 可见状态 snapshot 测试**

重复/乱序 settings、tokenUsage、rateLimits、MCP startup 事件按 generation/sequence 幂等更新；重开数据库后读取 conversation snapshot，模型/effort、token usage、account rate limits 和 MCP 状态必须与最后权威事件一致。

- [x] **步骤 9：运行 storage 测试**

```bash
pnpm vitest run packages/storage/test/storage.test.ts --reporter=verbose
```

预期：旧库无损、唯一约束、幂等、queue 状态、request generation、secret 脱敏和 legacy source 关系全部 PASS。

---

### Task 4：Native conversation coordinator 与恢复状态机

**文件：**
- 新建：`packages/local-server/src/codexNativeConversationContracts.ts`
- 新建：`packages/local-server/src/codexNativeConversationCoordinator.ts`
- 新建：`packages/local-server/test/codex-native-conversation-coordinator.test.ts`
- 修改：`packages/local-server/src/index.ts:902-973,6450-6561,7194-7550,7584-7629,7818-7848`

**接口：**

```ts
export interface CodexNativeConversationCoordinator {
  startTaskConversation(input: StartTaskConversationInput): Promise<NativeAcceptedOperation>;
  submitMessage(input: SubmitNativeMessageInput): Promise<NativeAcceptedOperation>;
  editQueuedSubmission(input: EditQueuedSubmissionInput): Promise<NativeQueueSnapshot>;
  deleteQueuedSubmission(input: DeleteQueuedSubmissionInput): Promise<NativeQueueSnapshot>;
  reorderQueue(input: ReorderNativeQueueInput): Promise<NativeQueueSnapshot>;
  sendQueuedNow(input: SendQueuedNowInput): Promise<NativeAcceptedOperation>;
  resumeInterruptedQueue(input: ResumeNativeQueueInput): Promise<NativeQueueSnapshot>;
  interruptTurn(input: InterruptNativeTurnInput): Promise<NativeAcceptedOperation>;
  respondToRequest(input: RespondNativeRequestInput): Promise<NativeAcceptedOperation>;
  recover(): Promise<void>;
  close(): void;
}
```

- [x] **步骤 1：写首次创建、连续三轮与 Task 不自动完成测试**

首次 run 创建一个 native conversation/thread/turn；第二、三轮复用同一 thread；三个 provider turnId 不同；turn completed 后 Task 仍 running。

- [x] **步骤 2：写 queue / steer / interrupt / resume 测试**

active turn 默认 queue；send-now 调用 `turn/steer` 且不 interrupt；completed 自动出队；interrupt 后剩余 queue paused，只有显式 resume 才继续。

- [x] **步骤 3：实现每 conversation 单活跃 turn 调度器**

```ts
type NativeConversationRunState =
  | { type: 'idle' }
  | { type: 'dispatching'; submissionId: string }
  | { type: 'active'; turnId: string; phase: 'prework' | 'final_answer' }
  | { type: 'waiting'; turnId: string; requestId: string; reason: 'approval' | 'user_input' }
  | { type: 'paused'; reason: 'interrupted' | 'transport_unavailable' | 'recovery_required' };
```

项目/全局并发按 active native turn + running legacy Runtime 计数；steer 不新增并发位。并发满只排 submission，不提前建 provider thread。

- [x] **步骤 4：实现 provider 事件幂等落库后广播**

事件键为 generationId/sequence/threadId/turnId/itemId；先 upsert turn/item/request，再发 Zeus event。`item/completed` 覆盖 delta buffer；WS 不是唯一事实源。把 `thread/settings/updated`、`thread/tokenUsage/updated`、`account/rateLimits/updated`、`mcpServer/startupStatus/updated` 映射为独立 typed snapshot/event，不能降级为日志或未知通知。

- [x] **步骤 5：实现 legacy 引用**

只允许用户显式选择的 messageIds；把内容作为 `turn/start.additionalContext` 的 `kind:'untrusted'` 发送；新 conversation 写 `legacy_source_conversation_id`；旧 conversation 保持只读且不复制 provider threadId。

- [x] **步骤 6：实现 transport 恢复和未知窗口 fail-closed**

新 generation ready 后对已有 provider threadId 执行 resume/read 对账；未 dispatch submission 保留。若进程在 provider 已创建 thread 但 Zeus 未持久化 threadId 的窗口退出，operation 标记 `recovery_required`，不盲目再建 thread。`clientUserMessageId` 只作关联键，不宣称 provider exactly-once。

- [x] **步骤 7：实现 approval / RUI / permissions**

thread activeFlags 只用于展示；真实 request 以 provider requestId 为实体。把 Task 权限字段完整映射进 repository/API：`allowCodeChanges=false -> read-only`；`allowCodeChanges=true -> workspace-write` 且 writable roots 仅 project.localPath；首版永不自动使用 `danger-full-access`。`allowGitCommit=false` 时拒绝匹配 Git 历史修改动作的 approval，并保留 developer instruction 双重约束。permissions grant 必须是 requested permissions 子集，workspace root 不得越出 project localPath；未知 schema 返回 `ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED`、不授权并 interrupt。RUI secret 不落库。

- [x] **步骤 8：Graph 问答移除 `codex exec` 旁路**

`packages/local-server/src/index.ts:7818-7848` 的 Codex 分支改为 native ephemeral thread/turn；非 Codex 继续当前 invocation。反向扫描必须不再发现生产 Codex `exec`。

- [x] **步骤 9：运行 coordinator 测试**

```bash
pnpm vitest run packages/local-server/test/codex-native-conversation-coordinator.test.ts --reporter=verbose
```

预期：首次/多轮、queue/steer、并发、重放、crash reconcile、Task 终态、审批、RUI secret、unknown tool 全部 PASS。

---

### Task 5：REST、WebSocket 和旧入口兼容

**文件：**
- 修改：`packages/local-server/src/index.ts:1080-1094,1247-1535,2267-2308`
- 新建：`packages/local-server/test/codex-native-conversation-api.test.ts`
- 修改：`packages/local-server/test/task-control-api.test.ts:334-430,700-840`
- 修改：`packages/local-server/test/events-ws.test.ts`

**契约：**

```http
GET  /api/tasks/:taskId/conversation-choices
POST /api/tasks/:taskId/conversations
POST /api/projects/:projectId/conversations/:conversationId/messages
POST /api/projects/:projectId/conversations/:conversationId/turns/:turnId/interrupt
POST /api/projects/:projectId/conversations/:conversationId/requests/:requestId/respond
PATCH  /api/projects/:projectId/conversations/:conversationId/queue/:submissionId
DELETE /api/projects/:projectId/conversations/:conversationId/queue/:submissionId
POST   /api/projects/:projectId/conversations/:conversationId/queue/:submissionId/send-now
POST   /api/projects/:projectId/conversations/:conversationId/queue/reorder
POST   /api/projects/:projectId/conversations/:conversationId/queue/resume
```

- [x] **步骤 1：写 conversation choice 和 idempotency API 失败测试**

无历史 `mode:create` 返回 202；有历史但未选择返回 409 `ZEUS_CONVERSATION_CHOICE_REQUIRED`；resume 精确使用选中的 conversation；显式 new 创建第二条；相同 Idempotency-Key/body 返回完全相同的 202 body，不同 body 返回 409。

- [x] **步骤 2：实现 tagged create body**

```ts
type StartTaskConversationBody =
  | { mode: 'create'; content?: string }
  | { mode: 'resume'; conversationId: string; content: string }
  | { mode: 'reference_legacy'; sourceConversationId: string; messageIds: string[]; content: string };
```

202 表示 Zeus 本地 durable acceptance，不等待慢模型：

```ts
type NativeAcceptedOperation = {
  operation: { id: string; status: 'accepted'; idempotencyKey: string };
  conversation: NativeConversationSummary;
  submission: NativeSubmission;
};
```

- [x] **步骤 3：改造消息 endpoint**

Body 增加 attachments、delivery `queue|steer_now`、expectedTurnId；legacy 返回 409 `ZEUS_LEGACY_CONVERSATION_READ_ONLY`。附件固定包含 name/mime/size/localPath-or-uploadRef，不再在 Renderer 清空后丢失。

- [x] **步骤 4：实现 queue、interrupt 和 request response 路由**

queue 只有 queued/paused/failed 可编辑删除重排；send-now 对 active turn steer；interrupt 使用 stable operation；request response 是 command/file/permissions/userInput/MCP tagged union，同 payload 重放幂等、不同 payload 冲突。

- [x] **步骤 5：实现结构化 WS 事件**

```ts
type NativeConversationEvent = {
  id: string;
  type:
    | 'conversation.transport.changed'
    | 'conversation.thread.changed'
    | 'conversation.turn.started'
    | 'conversation.turn.completed'
    | 'conversation.item.started'
    | 'conversation.item.delta'
    | 'conversation.item.completed'
    | 'conversation.queue.changed'
    | 'conversation.request.created'
    | 'conversation.request.resolved'
    | 'conversation.settings.changed'
    | 'conversation.tokenUsage.changed'
    | 'conversation.rateLimits.changed'
    | 'conversation.mcpStartup.changed'
    | 'conversation.native.error';
  payload: {
    projectId: string;
    conversationId: string;
    threadId?: string;
    turnId?: string;
    itemId?: string;
    generationId: string;
    sequence: number;
  } & Record<string, unknown>;
  createdAt: string;
};
```

conversation snapshot 必须同时包含 provider settings/model/effort、token usage、account rate limits 与 MCP startup status。断线后 Renderer 必须 GET snapshot；不要求 replay 每个 delta，completed item/message 和上述持久化 snapshot 是权威事实。

- [x] **步骤 6：收口旧 run/continue**

无历史的 Codex `/run` 可转发 `mode:create`；有历史时 `/run` 和 `/continue` 返回 409 choice required；不能自动取最新。非 Codex 原路径不变，测试显式选择 Generic/Claude。

- [x] **步骤 7：运行 API 与 WS 测试**

```bash
pnpm vitest run packages/local-server/test/codex-native-conversation-api.test.ts packages/local-server/test/events-ws.test.ts packages/local-server/test/task-control-api.test.ts --reporter=verbose
```

预期：创建/续接/引用/幂等/queue/interrupt/request/WS/restart snapshot/非 Codex 回归全部 PASS。

---

### Task 6：Electron Main 单例所有权与退出清理

**文件：**
- 修改：`apps/desktop/src/main/localServerRuntime.ts:1-112`
- 修改：`apps/desktop/package.json`
- 修改：`pnpm-lock.yaml`
- 修改：`apps/desktop/test/main-runtime.test.ts:188-358`

**接口：**
- `StartDesktopLocalServerOptions` 增加可注入 `codexAppServerManagerFactory` 供测试。
- `StartDesktopLocalServerOptions` 增加 `codexNativeEnabled`；Electron Main 从 `ZEUS_CODEX_NATIVE_ENABLED !== '0'` 读取 kill switch。
- `startZeusLocalServer()` options 增加同一 `codexAppServerManager` 实例。

- [x] **步骤 1：写 Fastify 重启不重启 app-server 测试**

断言首次 native 操作 spawn 一次；模拟 Fastify `close` 和新端口 launch 后 spawn 次数仍为 1，旧 coordinator 已 unsubscribe，新 coordinator 使用同一 manager。

- [x] **步骤 2：增加内部 workspace 依赖**

```json
"@zeus/ai-runtime": "workspace:*"
```

仅更新 desktop importer；不新增第三方包。

- [x] **步骤 3：接入可审计 kill switch**

`apps/desktop/src/main/main.ts:587-597` 启动本地服务时传入：

```ts
codexNativeEnabled: process.env.ZEUS_CODEX_NATIVE_ENABLED !== '0',
```

关闭时 Codex 写入口返回 `ZEUS_CODEX_NATIVE_DISABLED`，会话历史保持只读；Claude/Gemini/Generic 不受影响。测试分别覆盖默认开启和显式 `0`。

- [x] **步骤 4：把 manager 生命周期提升到 DesktopLocalServerRuntime**

```ts
const codexManager = createCodexAppServerManager();

async function launchServer(): Promise<RunningZeusLocalServer> {
  return startZeusLocalServer({
    ...serverOptions,
    codexAppServerManager: codexManager,
  });
}
```

Fastify close 只解除订阅；`DesktopLocalServerRuntime.close()` 依次停止接收新请求、关闭 Fastify、`prepareForShutdown()`、`close()`。

- [x] **步骤 5：实现退出时未决请求收口**

pending approval 尝试 cancel；RUI/MCP 未解决 turn interrupt；保存 DB 后关闭进程。close 多次调用只执行一次。

- [x] **步骤 6：运行 Main 生命周期测试与构建**

```bash
pnpm vitest run apps/desktop/test/main-runtime.test.ts --reporter=verbose
pnpm --filter @zeus/desktop build
```

预期：单 spawn、换端口复用、退出单 close、无残留进程，Desktop build PASS。

---

### Task 7：Renderer typed API、事件 reducer 与滚动状态机

**文件：**
- 新建：`apps/desktop/src/renderer/session/sessionTypes.ts`
- 新建：`apps/desktop/src/renderer/session/sessionReducer.ts`
- 新建：`apps/desktop/src/renderer/session/sessionSelectors.ts`
- 新建：`apps/desktop/src/renderer/session/useSessionController.ts`
- 新建：`apps/desktop/src/renderer/session/useThreadScrollController.ts`
- 新建：`apps/desktop/test/session-reducer.test.ts`
- 新建：`apps/desktop/test/session-scroll-controller.test.ts`
- 修改：`apps/desktop/src/renderer/apiClient.ts`
- 修改：`apps/desktop/src/renderer/main.tsx`
- 修改：`apps/desktop/test/api-client.test.ts`

**状态：**

```ts
type TransportState = 'disconnected' | 'connecting' | 'hydrating' | 'ready' | 'reconnecting' | 'failed';
type ConversationState =
  | 'legacy_readonly'
  | 'native_loading'
  | 'native_idle'
  | 'starting_turn'
  | 'active_prework'
  | 'active_final_answer'
  | 'waiting_approval'
  | 'waiting_user_input'
  | 'interrupt_confirm'
  | 'interrupting'
  | 'turn_failed';
type ThreadFollowMode = 'static' | 'prework_watch' | 'prework_follow' | 'user_follow';
```

- [x] **步骤 1：写 reducer 乱序、重复和跨 thread 隔离测试**

key 固定为 conversationId/threadId/turnId/itemId；eventId/sequence 去重；`item/started` 创建 shell；delta 只 append 同 item；`item/completed` 用权威 payload 覆盖 buffer；turn completed 只回 native idle。settings/tokenUsage/rateLimits/MCP startup 事件更新各自 snapshot，不能触发 transcript refetch 或丢失 active turn。

- [x] **步骤 2：写 optimistic send、重连和 attachment 恢复测试**

发送使用稳定 idempotencyKey/client message id；HTTP 失败恢复 draft 和附件；WS 断线按 afterEventId 连接，重连后先 GET snapshot 再接受增量；同 thread 第二轮不新建 conversation。

- [x] **步骤 3：实现 typed API，不扩展 GraphConversation 类型**

新增 `NativeConversationSnapshot`、`NativeTurnSnapshot`、`NativeItemSnapshot`、`NativePendingRequest`、`NativeConversationEvent` 和对应 client 方法。所有 native 写请求同时发送 `Idempotency-Key` header 和 body client id。

- [x] **步骤 4：实现 reducer/selectors/controller**

唯一写 item buffer 的位置是 reducer；selector 决定 composer action、状态文案和可用操作；controller 负责 hydration、event subscription、draft/attachment persistence 和 reconnect，不把状态合并逻辑放进 `main.tsx`。

- [x] **步骤 5：实现滚动状态机**

距底 ≤24px 才 follow；用户滚离 >24px 立即 static；新 turn 仅在距底 ≤300px 时定位；spacer 目标为可视区约 2/3 且至少预留 240px；500ms 无 bounce；用户上滚不得被 delta 抢回底部。

- [x] **步骤 6：实现 Esc 优先级**

mention/template/审批/终端浮层先消费 Esc；输入框聚焦且响应中首次 Esc 进入 2000ms confirm，第二次才 interrupt；键盘 repeat 忽略；在收到匹配 `turn/started` 前禁用直接 interrupt。

- [x] **步骤 7：运行 reducer、scroll、API 测试**

```bash
pnpm vitest run apps/desktop/test/session-reducer.test.ts apps/desktop/test/session-scroll-controller.test.ts apps/desktop/test/api-client.test.ts --reporter=verbose
```

预期：重复/乱序/重连/权威 completed/跨 thread/阈值/Esc/idempotency 全部 PASS。

---

### Task 8：Codex App 对齐的会话页组件与视觉状态

**文件：**
- 新建：`apps/desktop/src/renderer/session/SessionWorkspace.tsx`
- 新建：`apps/desktop/src/renderer/session/ProjectConversationTree.tsx`
- 新建：`apps/desktop/src/renderer/session/ConversationTranscript.tsx`
- 新建：`apps/desktop/src/renderer/session/ThreadItemView.tsx`
- 新建：`apps/desktop/src/renderer/session/ConversationComposer.tsx`
- 新建：`apps/desktop/src/renderer/session/PendingRequestSurface.tsx`
- 新建：`apps/desktop/src/renderer/session/LegacyConversationBanner.tsx`
- 新建：`apps/desktop/src/renderer/session/session.css`
- 新建：`apps/desktop/test/session-controller.test.tsx`
- 新建：`apps/desktop/test/session-workspace.test.tsx`
- 修改：`apps/desktop/src/renderer/App.tsx`
- 修改：`apps/desktop/src/renderer/styles.css`
- 修改：`apps/desktop/test/app-shell-layout.test.tsx`

**视觉基线：**
- source rail 单列；不在会话页内部再嵌 Task 列表。
- thread content max 48rem；Markdown max 40rem；用户消息右对齐 max 77%；助手使用正文流。
- composer `min(48rem, 100%-gutter)`，底部悬浮/粘性；active 时主按钮从 Send 原位变 Stop。
- 当前截图测得 canvas `rgb(255,255,255)`、sidebar `rgb(252,252,252)`、正文近 `rgb(34,37,41)`、selected surface 近 `rgb(241,242,242)`。

- [x] **步骤 1：先写页面结构和主状态失败测试**

覆盖空态、loading、reconnecting、legacy readonly、native idle、prework、final、approval、RUI、error；断言只有一个 source rail，无内层 Task list 和 environment 大卡；同 Task 多 conversation 可独立选择。

- [x] **步骤 2：把 sessions 路由替换为 SessionWorkspace**

`App.tsx` 只保留路由、全局对象选择和 callbacks；会话 DOM 迁入新目录。`SidebarNav` 接收按 project 分组的 conversation summary，不再在 sessions 页面重复渲染左列。

- [x] **步骤 3：实现 transcript 与 item renderer**

`role="log" aria-live="polite" aria-relevant="additions text"`；不播报每个小 delta，按批或 item completed 播报。用户长消息展开/收起、复制、末条编辑；assistant item 支持 commentary/final/tool/request/error，不虚构统一 Retry。

- [x] **步骤 4：实现 composer、Queue/Steer 与附件**

IME composing 时 Enter 不提交；Shift+Enter 换行；空闲 Send、pending spinner/disabled、active Stop；active draft 按偏好 queue/steer；队列可拖动排序（6px 阈值）、编辑、删除、send-now、暂停和 Resume。Voice 尚无真实实现，不放假麦克风。

- [x] **步骤 5：实现 approval 与 request_user_input**

审批 inline group 出现时聚焦首个决策，resolve 后恢复 composer；决策包含影响说明且防重复。RUI 用 fieldset/legend + radio/checkbox/freeform，secret 输入遮罩；颜色不是唯一状态信号。

- [x] **步骤 6：实现 scoped 视觉和动画**

根类固定 `.session-codex-parity-v1`；新标题 enter 280ms/exit 180ms，queue 180ms，Markdown block 150ms，image 180ms，latest turn 500ms 无 bounce，Thinking 600ms 首次/1000ms 扫光/4000ms 间隔。首 delta 只做 block reveal，后续 token 直接更新，不逐 token 闪烁。

- [x] **步骤 7：实现 reduced-motion、键盘和响应式**

`prefers-reduced-motion` 关闭 fade/scale/shimmer/spring/smooth scroll/折叠。断点：≥1024 source rail 约 274px；760-1023 为 236-248px 可折叠；<760 使用 drawer 或紧凑 thread switcher，composer 加 safe-area 和 16px gutter；<560 收纳模型/effort 可见文字但保留 accessible name。

- [x] **步骤 8：删除迁移后的旧会话 CSS override**

从 `styles.css:7963-8502,10273-10457` 删除已被 session.css 接管的规则，不能在文件尾追加“最终覆盖”继续掩盖旧结构。保留壳层 token 和共享控件。

- [x] **步骤 9：运行组件、键盘与布局测试**

```bash
pnpm vitest run apps/desktop/test/session-controller.test.tsx apps/desktop/test/session-workspace.test.tsx apps/desktop/test/app-shell-layout.test.tsx --reporter=verbose
```

预期：主状态、Queue/Steer/Stop/Esc、approval/RUI、单 rail、legacy/native、响应式语义和 a11y PASS。

---

### Task 9：垂直集成、真实 app-server、视觉 QA 与发布回滚

**文件：**
- 修改：`docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md`
- 更新：本计划复选框和验证证据

- [x] **步骤 1：运行分层自动化测试**

```bash
pnpm vitest run \
  packages/ai-runtime/test/codex-app-server-protocol.test.ts \
  packages/ai-runtime/test/codex-app-server-manager.test.ts \
  packages/storage/test/storage.test.ts \
  packages/local-server/test/codex-native-conversation-coordinator.test.ts \
  packages/local-server/test/codex-native-conversation-api.test.ts \
  packages/local-server/test/events-ws.test.ts \
  apps/desktop/test/session-reducer.test.ts \
  apps/desktop/test/session-scroll-controller.test.ts \
  apps/desktop/test/session-controller.test.tsx \
  apps/desktop/test/session-workspace.test.tsx \
  apps/desktop/test/api-client.test.ts \
  apps/desktop/test/main-runtime.test.ts \
  --reporter=verbose
```

- [x] **步骤 2：运行反向防回归扫描**

```bash
rg -n "codex:\s*\['exec'|codex exec|createTaskConversationContinuationPrompt|slice\(-12\).*message|inputSession\(.*conversation" packages apps
```

预期：生产 Codex 写路径无命中；测试只允许出现“旧模式必须被拒绝”的反向断言。若 Graph 问答仍命中 `codex exec`，不得进入验收。

- [ ] **步骤 3：运行静态、格式、全量测试和构建**

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test
pnpm --filter @zeus/desktop build
git diff --check
```

每条命令必须记录 exit code 和失败测试；不能用“其余同类通过”代替证据。

- [ ] **步骤 4：运行显式 opt-in live contract probe**

```bash
ZEUS_LIVE_CODEX_PROBE=1 pnpm vitest run packages/ai-runtime/test/codex-app-server-live.test.ts --reporter=verbose
```

该命令仅验证 read-only/never 的同一 thread 三轮、新 generation resume、双 thread 并发和 interrupt，不得归并为审批证据。

在再次确认临时写入范围后单独执行：

```bash
ZEUS_LIVE_CODEX_APPROVAL_PROBE=1 pnpm vitest run packages/ai-runtime/test/codex-app-server-live.test.ts --reporter=verbose
```

审批 probe 只允许在 `/tmp/zeus-codex-approval-probe-*` 执行已列白的纯输出命令并创建 `APPROVED.txt`；验证 command/file approval、Plan request_user_input、request 防重和 resolved，再清理临时仓。permissions round trip 没有真实成功证据时必须保持未覆盖。

- [ ] **步骤 5：真实 Electron 主路径验收**

使用真实项目和真实 conversation，依次验证：无历史创建、同 thread 第二轮、有历史显式 resume、显式新建第二 thread、legacy 只读引用、Queue/Steer、Stop/双 Esc、断线重连、Fastify 换端口、app-server 崩溃恢复、用户显式完成 Task。

- [ ] **步骤 6：Codex App 同视口视觉与可访问性验收**

在用户已解锁并允许 GUI 取证后，以 360/480/768/1240/1440 视口比较空态、active、approval、RUI、error、long-thread；检查 spacing、颜色、字体、边界、composer、scroll、动画时长。再开启系统“减少动态效果”与 VoiceOver，完成 send/stop/approval/RUI 纯键盘冒烟。未执行该步骤前不能声称视觉完全一致。

- [x] **步骤 7：请求代码 review**

使用 `superpowers:requesting-code-review`，reviewer 必须读取本任务文档、本计划、根目录与受影响子项目 AGENTS；输入需包含需求、全部变更范围、Git diff、测试输出、live probe、视觉证据、反向扫描与剩余未覆盖点。

- [x] **步骤 8：按 review 结果修正后重新验证**

任何源码修正都回到相应任务的 failing test；不得只改测试期待绕过问题。重新运行受影响分层测试和步骤 2-6。

已按 RED → GREEN 关闭最终 review 的 request identity、RUI、file/MCP authority、外部 URL、durable client association、request refresh 竞态等 findings；最新综合复审为 Approved。review 相关分层、反向扫描和静态 gate 已重跑；步骤 4-6 的真实 live / Electron / VoiceOver 与像素验收仍按各自复选框保持未完成，本步骤勾选不代表它们通过。

- [ ] **步骤 9：打包验收**

先退出运行中的 Zeus，再执行：

```bash
pnpm package:mac
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app
```

打包 App 必须能发现受支持 Codex CLI，且不能连接 Codex Desktop 自有 app-server。

- [ ] **步骤 10：验证回滚**

关闭 `codexNativeEnabled` 后停止接受新 submission、收口 pending request、interrupt 未解决 turn、保存 DB 并关闭 manager；Codex UI 进入只读不可写。新表、provider threadId、turn/item、审计与 Codex rollout 均保留；严禁回退到 `codex exec` 或消息重放。

- [ ] **步骤 11：完成前总验收**

使用 `superpowers:verification-before-completion` 回到原始需求逐条签收 AC01-AC16；明确列出验证命令、成功输出、视觉证据、未覆盖 permissions/动画边界和回滚演练结果。只有全部必需 AC 有证据时才能标记完成。

---

## 实施与验证状态（2026-07-13）

### 已完成

- Task 1-8 已按 native-only 方向实现：Codex 写路径使用私有 stdio app-server，Storage / coordinator / REST / WS / Electron Main / Renderer 会话状态机已经串联；Claude、Gemini、Generic 仍保留原 CLI/PTY adapter。
- 分层核心与安全加固回归：17 个测试文件、518 个测试通过；最终综合审查修复 focused 回归：5 个测试文件、153 个测试通过；旧 Renderer 迁移回归：5 个测试文件、397 个测试通过。
- `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm build`、`git diff --check` 均成功。
- 生产反向扫描未发现 Codex 写路径调用 `createAiCliAdapterInvocation`、`codex exec` 或最近消息重放；`packages/ai-runtime/src/index.ts` 仅保留通用 adapter factory 声明供非 Codex adapter 使用。
- 已在本地渲染页面验证 1440×900、768×900、375×812、320×700；验证移动会话抽屉焦点进入/`Esc` 返回、无水平页面溢出、深色主题、320px 审批按钮换行及 reduced-motion 降级。
- 多轮独立 review 已关闭 Renderer 绕过 authority、canonical MCP/RUI schema/envelope/date-time、file `grantRoot` 扩权、MCP 原型链字段偏差、MCP URL 安全预览与 audited HTTPS 外开链路、server request identity 冲突、`clientId=null` 收敛、file session scope 以及 resolved request 详情刷新竞态；最终综合复审为 Approved，当前审查范围无 Critical / Important / Minor。真实 Electron 默认浏览器点击不在该结论内。

### 未完成 / 不能据此声称全部完成

- 当前 Codex 模型的最新 live probe 未稳定等到 assistant 输出；旧 probe 曾在同一 thread 完成 3 个不同 turn，但清理阶段挂起，因此不能把 Task 9 步骤 4 标记为完整通过。
- 未执行完整 Electron 真实主路径、VoiceOver 冒烟、与当前 Codex GUI 逐像素对照、`pnpm package:mac` / `codesign`、人工 kill-switch 回滚演练。
- 全量 `pnpm test` 为 79 个文件中 77 通过、2 失败；1301 个测试通过、16 个失败、3 个跳过。失败仅位于 Graph 自扫描的节点/边上限断言（`packages/graph-engine/test/graph.test.ts`、`packages/local-server/test/graph-view-api.test.ts`），会话核心分层测试通过；独立诊断已确认这是当前固定 cap picker 与 real-repo 夹具被合法源码增长暴露的容量脆弱性，不是会话 transport/UI 逻辑错误，但全量测试仍未通过，因此 Task 9 步骤 3 与总验收保持未勾选。

---

## 已知风险与 fail-closed 口径

1. `thread/start` 没有已证实的 provider idempotency key。若 provider 已创建 thread 但 Zeus 尚未持久化 threadId 时进程崩溃，operation 必须进入 `recovery_required`，禁止自动创建第二个 thread。
2. `clientUserMessageId` 已用于关联，但“重复值能阻止重复 provider turn”尚未 live 证明。Zeus 本地 HTTP 可 exactly-once；跨 provider 崩溃边界只能显式暴露 at-least-once 风险。
3. permissions approval 的真实 round trip 尚未通过，且历史 schema 证据有冲突；未知字段必须不授权并 interrupt。
4. Codex App 在取证期间从 26.707.41301 更新到 26.707.51957；hash 资产会漂移。实现以公开可观察行为与协议能力协商为准，不依赖固定 hash 文件名。
5. 当前发送后 GUI 动画未实机观看；bundle 静态数值不是逐像素验收。真实 App 对照是发布前必需步骤。
6. Task 表已有 `allow_code_changes/allow_tests/allow_git_commit` 列，但现有 record 映射未完整落实。native sandbox 首版固定：`allowCodeChanges=false -> read-only`；`true -> workspace-write` 且 writable roots 仅项目目录；永不自动使用 `danger-full-access`。
7. `allowGitCommit=false` 不能只靠文本提示，必须结合 approval 和命令策略；无法形成硬边界时 fail-closed 拒绝提交命令。
8. Voice 当前没有真实实现；视觉对齐不能放置无行为麦克风。
9. Manager identity conflict 与 coordinator durable recovery 分别已有 deterministic 回归，但仍缺 fake process stdout → manager event → coordinator 的真集成测试；发布前应补齐，不能把分层接口对齐等同于整链证据。

## 实施交接

用户已经确认开发，当前处于 verification / 待补真实运行验收阶段。没有创建 worktree，也没有执行任何 Git 历史或远端动作。下一轮只应补齐 Task 9 的未勾选验收，或先处理独立复核确认的 Graph 全量测试阻塞；不得重新引入 `codex exec` 或消息重放作为回滚。
