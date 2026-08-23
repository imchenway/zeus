import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexThreadSnapshot, CodexTransportState } from '../packages/ai-runtime/src/index.js';
import type { ZeusConversationRecord } from '../packages/storage/src/index.js';
import { CodexSubagentQueryApplication } from '../packages/local-server/src/codexSubagentQueryApplication.js';
import { createCodexSubagentRuntimeReader } from '../packages/local-server/src/codexSubagentRuntimeProjection.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-subagent-detail-probe-'));
const historyRoot = join(probeRoot, 'sessions');

try {
  await mkdir(historyRoot, { recursive: true });
  await verifyForkedHistoryBoundary();
  await verifyNoInheritedHistory();
  await verifyIncrementalActiveThread();
  await verifyMissingTimeBoundaries();
  await verifyJsonlIdentityAndBounds();
  await verifyMissingRuntimeFields();
  process.stdout.write('Subagent 详情行为探针通过：继承历史、无继承历史、增量刷新、时间边界、JSONL 身份与上限、缺失运行字段均符合安全投影契约。\n');
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

async function verifyForkedHistoryBoundary(): Promise<void> {
  const threadId = 'thread-forked';
  const path = join(historyRoot, `${threadId}.jsonl`);
  const parentTurn = turn('turn-parent', 90, '父会话问题不得进入子线程');
  const ownedTurn = turn('turn-owned', 101, '智能体自身第一条工作内容');
  const thread = threadSnapshot(threadId, path, 100, [parentTurn, ownedTurn]);
  await writeJsonl(path, [
    sessionMeta(threadId),
    turnContext('turn-parent', { model: 'parent-model', effort: 'low', cwd: '/tmp/parent' }),
    tokenCount(1_000, 900, 100, 20),
    turnContext('turn-owned', { model: 'gpt-5.6-sol', effort: 'ultra', service_tier: null, cwd: '/tmp/agent' }),
    tokenCount(1_300, 1_150, 150, 30),
  ]);
  const result = await queryThread(thread);
  assertBehavior(result.historyBoundary.state === 'confirmed', '可靠 fork 边界应标记为 confirmed。');
  assertBehavior(result.historyBoundary.hiddenInheritedTurnCount === 1, '父线程继承 turn 应被计入隐藏数量。');
  assertBehavior(result.turns.length === 1 && result.turns[0]?.id === 'turn-owned', '详情只能返回当前 Subagent 自身 turn。');
  assertBehavior(!JSON.stringify(result.turns).includes('父会话问题'), '父会话问题不得泄漏到 Subagent 时间线。');
  assertAvailable(result.runtime.model, 'gpt-5.6-sol', '模型必须来自首个自身 turn_context。');
  assertAvailable(result.runtime.effort, 'ultra', '推理强度必须来自首个自身 turn_context。');
  assertAvailable(result.runtime.usage.totalTokens, 300, '累计 Token 必须扣除继承历史基线。');
  assertAvailable(result.runtime.usage.inputTokens, 250, '输入 Token 必须扣除继承历史基线。');
  assertAvailable(result.runtime.usage.outputTokens, 50, '输出 Token 必须扣除继承历史基线。');
}

async function verifyNoInheritedHistory(): Promise<void> {
  const threadId = 'thread-clean';
  const path = join(historyRoot, `${threadId}.jsonl`);
  const ownedTurn = turn('turn-clean', 201, '首个自身内容');
  const thread = threadSnapshot(threadId, path, 200, [ownedTurn]);
  await writeJsonl(path, [sessionMeta(threadId), turnContext('turn-clean', { model: 'gpt-5.6-terra', effort: 'high', cwd: '/tmp/clean' }), tokenCount(120, 100, 20, 4)]);
  const result = await queryThread(thread);
  assertBehavior(result.historyBoundary.hiddenInheritedTurnCount === 0 && result.turns.length === 1, '无继承历史时应完整保留自身 turn。');
  assertAvailable(result.runtime.usage.totalTokens, 120, '无继承历史时累计 Token 应从 0 起算。');
}

async function verifyIncrementalActiveThread(): Promise<void> {
  const threadId = 'thread-active';
  const path = join(historyRoot, `${threadId}.jsonl`);
  const ownedTurn = turn('turn-active', 301, '进行中内容');
  const thread = threadSnapshot(threadId, path, 300, [ownedTurn], 'active');
  await writeJsonl(path, [sessionMeta(threadId), turnContext('turn-active', { model: 'gpt-5.6-sol', effort: 'max', cwd: '/tmp/active' })]);
  const reader = createCodexSubagentRuntimeReader({ providerHistoryRoot: historyRoot });
  const first = await reader.read({ thread, ownedTurns: [ownedTurn] });
  assertBehavior(first.usage.totalTokens.state === 'unavailable', '进行中线程尚无 token_count 时不得填零。');
  await appendFile(path, `${JSON.stringify(tokenCount(80, 65, 15, 3))}\n`, 'utf8');
  const second = await reader.read({ thread, ownedTurns: [ownedTurn] });
  assertAvailable(second.usage.totalTokens, 80, '后续轮询必须扫描新增尾部并更新运行快照。');
}

async function verifyMissingTimeBoundaries(): Promise<void> {
  const threadId = 'thread-no-created-at';
  const path = join(historyRoot, `${threadId}.jsonl`);
  const unknownTurn = turn('turn-unknown', 401, '归属不可确认');
  const noCreatedAt = { ...threadSnapshot(threadId, path, 400, [unknownTurn]), createdAt: undefined };
  await writeJsonl(path, [sessionMeta(threadId), turnContext('turn-unknown', { model: 'gpt-5.6-sol', effort: 'high', cwd: '/tmp/unknown' })]);
  const hidden = await queryThread(noCreatedAt);
  assertBehavior(hidden.historyBoundary.state === 'unavailable' && hidden.turns.length === 0, '缺少 thread.createdAt 时必须隐藏全部模糊历史。');

  const mixedThreadId = 'thread-missing-start';
  const mixedPath = join(historyRoot, `${mixedThreadId}.jsonl`);
  const ambiguous = { id: 'turn-ambiguous', status: 'completed', items: [] };
  const owned = turn('turn-timed', 502, '可靠自身内容');
  const mixed = threadSnapshot(mixedThreadId, mixedPath, 500, [ambiguous, owned]);
  await writeJsonl(mixedPath, [sessionMeta(mixedThreadId), turnContext('turn-timed', { model: 'gpt-5.6-luna', effort: 'medium', cwd: '/tmp/mixed' })]);
  const projected = await queryThread(mixed);
  assertBehavior(projected.historyBoundary.state === 'unavailable' && projected.historyBoundary.hiddenAmbiguousTurnCount === 1, '缺少 startedAt 的 turn 必须标记边界不可确认。');
  assertBehavior(projected.turns.length === 1 && projected.turns[0]?.id === 'turn-timed', '边界部分缺失时只能保留时间可靠的自身 turn。');
}

async function verifyJsonlIdentityAndBounds(): Promise<void> {
  const mismatchId = 'thread-mismatch';
  const mismatchPath = join(historyRoot, `${mismatchId}.jsonl`);
  const mismatchTurn = turn('turn-mismatch', 601, '身份不匹配');
  await writeJsonl(mismatchPath, [sessionMeta('another-thread'), turnContext('turn-mismatch', { model: 'should-not-leak', effort: 'low', cwd: '/tmp/mismatch' })]);
  const mismatchReader = createCodexSubagentRuntimeReader({ providerHistoryRoot: historyRoot });
  const mismatch = await mismatchReader.read({ thread: threadSnapshot(mismatchId, mismatchPath, 600, [mismatchTurn]), ownedTurns: [mismatchTurn] });
  assertUnavailableContains(mismatch.model, '身份', '首行线程身份不匹配时不得返回运行配置。');

  const lineId = 'thread-large-line';
  const linePath = join(historyRoot, `${lineId}.jsonl`);
  const lineTurn = turn('turn-large-line', 701, '单行超限');
  await writeJsonl(linePath, [sessionMeta(lineId), { type: 'event_msg', payload: { type: 'probe', content: 'x'.repeat(512) } }]);
  const lineReader = createCodexSubagentRuntimeReader({ providerHistoryRoot: historyRoot, maximumLineBytes: 128 });
  const lineResult = await lineReader.read({ thread: threadSnapshot(lineId, linePath, 700, [lineTurn]), ownedTurns: [lineTurn] });
  assertUnavailableContains(lineResult.model, '行超过', 'JSONL 单行超限时必须安全关闭运行事实。');

  const fileId = 'thread-large-file';
  const filePath = join(historyRoot, `${fileId}.jsonl`);
  const fileTurn = turn('turn-large-file', 801, '文件超限');
  await writeJsonl(filePath, [sessionMeta(fileId), turnContext('turn-large-file', { model: 'gpt-5.6-sol', effort: 'high', cwd: '/tmp/large' })]);
  const fileReader = createCodexSubagentRuntimeReader({ providerHistoryRoot: historyRoot, maximumBytes: 64 });
  const fileResult = await fileReader.read({ thread: threadSnapshot(fileId, filePath, 800, [fileTurn]), ownedTurns: [fileTurn] });
  assertUnavailableContains(fileResult.model, '扫描上限', 'JSONL 文件超限时必须安全关闭运行事实。');
}

async function verifyMissingRuntimeFields(): Promise<void> {
  const threadId = 'thread-missing-runtime';
  const path = join(historyRoot, `${threadId}.jsonl`);
  const ownedTurn = turn('turn-missing-runtime', 901, '缺失运行字段');
  const thread = threadSnapshot(threadId, path, 900, [ownedTurn]);
  await writeJsonl(path, [sessionMeta(threadId), turnContext('turn-missing-runtime', { cwd: '/tmp/missing-runtime' })]);
  const runtime = await createCodexSubagentRuntimeReader({ providerHistoryRoot: historyRoot }).read({ thread, ownedTurns: [ownedTurn] });
  assertBehavior(runtime.model.state === 'unavailable' && runtime.effort.state === 'unavailable', '缺少模型与推理强度时必须显示 unavailable。');
  assertAvailable(runtime.activity.turnCount, 1, '不依赖 JSONL 的轮次事实仍应可用。');
  assertBehavior(runtime.performance.latestOutputTokensPerSecond.state === 'unavailable', '缺少真实 timing 时输出速率不得填零或估猜。');
}

async function queryThread(thread: CodexThreadSnapshot) {
  const conversation = conversationRecord(thread.parentThreadId as string);
  const readyState = { type: 'ready', generationId: 'probe', capabilities: {} } as CodexTransportState;
  const application = new CodexSubagentQueryApplication({
    conversations: { getById: (id) => (id === conversation.id ? conversation : null) },
    providerItems: { listByConversation: () => [] },
    provider: {
      getState: () => readyState,
      listThreads: async () => ({ data: [thread], nextCursor: null }),
      readThread: async () => thread,
    },
    runtime: createCodexSubagentRuntimeReader({ providerHistoryRoot: historyRoot }),
    now: () => new Date('2026-08-23T00:00:00.000Z'),
  });
  return application.read(conversation.projectId, conversation.id, thread.id);
}

function conversationRecord(parentThreadId: string): ZeusConversationRecord {
  return {
    id: 'conversation-probe',
    projectId: 'project-probe',
    taskId: null,
    workspaceId: null,
    environmentId: null,
    sessionId: null,
    title: 'Subagent probe',
    summary: null,
    status: 'ready',
    stage: 'ready',
    stageUpdatedAt: '2026-08-23T00:00:00.000Z',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    archived: false,
    transportKind: 'codex_native',
    providerId: 'codex',
    providerThreadId: parentThreadId,
    providerThreadPath: null,
    providerModel: 'gpt-5.6-sol',
    providerState: 'ready',
    providerProtocolVersion: null,
    providerBinaryVersion: null,
    legacySourceConversationId: null,
    providerSettingsJson: '{}',
    providerTokenUsageJson: '{}',
    permissionMode: 'read-only',
    collaborationMode: 'default',
    nextTurnSettingsJson: '{}',
    attentionUnread: false,
    attentionKind: 'none',
    attentionRevision: 0,
    attentionTurnId: null,
    attentionUpdatedAt: null,
    agentKind: 'codex',
    agentTransport: 'app_server',
    modelSourceId: null,
    modelId: null,
    nativeSessionId: parentThreadId,
    nativeSessionPath: null,
    capabilitySnapshotId: null,
  };
}

function threadSnapshot(threadId: string, path: string, createdAt: number, turns: Record<string, unknown>[], statusType = 'idle'): CodexThreadSnapshot {
  return {
    id: threadId,
    parentThreadId: 'parent-thread',
    path,
    createdAt,
    updatedAt: createdAt + 10,
    name: threadId,
    status: { type: statusType, activeFlags: statusType === 'active' ? ['running'] : [] },
    cwd: '/tmp/thread',
    gitInfo: { branch: 'probe/branch' },
    turns,
  };
}

function turn(id: string, startedAt: number, text: string): Record<string, unknown> {
  return { id, status: 'completed', startedAt, completedAt: startedAt + 1, items: [{ id: `${id}-item`, type: 'agentMessage', text, status: 'completed' }] };
}

function sessionMeta(threadId: string): Record<string, unknown> {
  return { timestamp: '2026-08-23T00:00:00.000Z', type: 'session_meta', payload: { id: threadId } };
}

function turnContext(turnId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: '2026-08-23T00:00:01.000Z', type: 'turn_context', payload: { turn_id: turnId, ...fields } };
}

function tokenCount(totalTokens: number, inputTokens: number, outputTokens: number, reasoningOutputTokens: number): Record<string, unknown> {
  return {
    timestamp: '2026-08-23T00:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: totalTokens, input_tokens: inputTokens, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: outputTokens, reasoning_output_tokens: reasoningOutputTokens },
        last_token_usage: { total_tokens: totalTokens, input_tokens: inputTokens, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: outputTokens, reasoning_output_tokens: reasoningOutputTokens },
        model_context_window: 258_400,
      },
    },
  };
}

async function writeJsonl(path: string, rows: Record<string, unknown>[]): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

function assertAvailable<T>(fact: { state: 'available'; value: T } | { state: 'unavailable'; reason: string }, expected: T, message: string): void {
  assertBehavior(fact.state === 'available' && fact.value === expected, message);
}

function assertUnavailableContains<T>(fact: { state: 'available'; value: T } | { state: 'unavailable'; reason: string }, fragment: string, message: string): void {
  assertBehavior(fact.state === 'unavailable' && fact.reason.includes(fragment), message);
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Subagent 详情行为探针失败：${message}`);
}
