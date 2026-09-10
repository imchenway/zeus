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
  await verifySubagentInputs();
  process.stdout.write('Subagent 详情行为探针通过：历史隔离、输入原文与加密状态、消息去重与排序、并发增量读取、时间边界、JSONL 身份与上限、缺失运行字段。\n');
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
  assertBehavior(first.runtime.usage.totalTokens.state === 'unavailable', '进行中线程尚无 token_count 时不得填零。');
  await appendFile(path, `${JSON.stringify(tokenCount(80, 65, 15, 3))}\n`, 'utf8');
  const second = await reader.read({ thread, ownedTurns: [ownedTurn] });
  assertAvailable(second.runtime.usage.totalTokens, 80, '后续轮询必须扫描新增尾部并更新运行快照。');
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
  assertUnavailableContains(mismatch.runtime.model, '身份', '首行线程身份不匹配时不得返回运行配置。');

  const lineId = 'thread-large-line';
  const linePath = join(historyRoot, `${lineId}.jsonl`);
  const lineTurn = turn('turn-large-line', 701, '单行超限');
  await writeJsonl(linePath, [sessionMeta(lineId), { type: 'event_msg', payload: { type: 'probe', content: 'x'.repeat(512) } }]);
  const lineReader = createCodexSubagentRuntimeReader({ providerHistoryRoot: historyRoot, maximumLineBytes: 128 });
  const lineResult = await lineReader.read({ thread: threadSnapshot(lineId, linePath, 700, [lineTurn]), ownedTurns: [lineTurn] });
  assertUnavailableContains(lineResult.runtime.model, '行超过', 'JSONL 单行超限时必须安全关闭运行事实。');

  const fileId = 'thread-large-file';
  const filePath = join(historyRoot, `${fileId}.jsonl`);
  const fileTurn = turn('turn-large-file', 801, '文件超限');
  await writeJsonl(filePath, [sessionMeta(fileId), turnContext('turn-large-file', { model: 'gpt-5.6-sol', effort: 'high', cwd: '/tmp/large' })]);
  const fileReader = createCodexSubagentRuntimeReader({ providerHistoryRoot: historyRoot, maximumBytes: 64 });
  const fileResult = await fileReader.read({ thread: threadSnapshot(fileId, filePath, 800, [fileTurn]), ownedTurns: [fileTurn] });
  assertUnavailableContains(fileResult.runtime.model, '扫描上限', 'JSONL 文件超限时必须安全关闭运行事实。');
}

async function verifyMissingRuntimeFields(): Promise<void> {
  const threadId = 'thread-missing-runtime';
  const path = join(historyRoot, `${threadId}.jsonl`);
  const ownedTurn = turn('turn-missing-runtime', 901, '缺失运行字段');
  const thread = threadSnapshot(threadId, path, 900, [ownedTurn]);
  await writeJsonl(path, [sessionMeta(threadId), turnContext('turn-missing-runtime', { cwd: '/tmp/missing-runtime' })]);
  const { runtime } = await createCodexSubagentRuntimeReader({ providerHistoryRoot: historyRoot }).read({ thread, ownedTurns: [ownedTurn] });
  assertBehavior(runtime.model.state === 'unavailable' && runtime.effort.state === 'unavailable', '缺少模型与推理强度时必须显示 unavailable。');
  assertAvailable(runtime.activity.turnCount, 1, '不依赖 JSONL 的轮次事实仍应可用。');
  assertBehavior(runtime.performance.latestOutputTokensPerSecond.state === 'unavailable', '缺少真实 timing 时输出速率不得填零或估猜。');
}

/** 使用原生协作信封检查输入归属、不可读正文、补齐与去重。 */
async function verifySubagentInputs(): Promise<void> {
  /** 每次探针使用独立文件，不读取或修改真实会话。 */
  const threadId = 'thread-inputs';
  /** 已确认的子线程路径。 */
  const agentPath = '/root/worker';
  /** 输入对应的真实轮次。 */
  const turnId = 'turn-inputs';
  /** 原生线程给出的首条明文优先于磁盘加密版本。 */
  const firstInput = { type: 'agent_message', id: 'input-first', author: '/root', recipient: agentPath, content: [{ type: 'input_text', text: '第一条指令\n\n保留完整换行。' }] };
  /** 原生过程与最终答复提供可核对的时间顺序。 */
  const ownedTurn = {
    ...turn(turnId, 1_001, '最终答复'),
    completedAt: 1_010,
    items: [firstInput, { id: 'command', type: 'commandExecution', startedAt: 1_003, command: ['pwd'] }, { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '最终答复' }],
  };
  /** 文件来自本次临时历史根。 */
  const path = join(historyRoot, `${threadId}.jsonl`);
  /** 主线程继承内容只能成为明确隐藏的历史。 */
  const thread = { ...threadSnapshot(threadId, path, 1_000, [turn('parent-turn', 900, '父线程内容'), ownedTurn]), agentPath, preview: '继承上下文不得冒充任务输入' };
  /** 生成与实际记录一致的信封，只在测试数据中使用无敏感意义的加密标记。 */
  const message = (id: string, targetTurn: string, recipient: string, text: string | null, timestamp = 1_004) => ({
    timestamp: new Date(timestamp * 1_000).toISOString(),
    type: 'response_item',
    payload: {
      type: 'agent_message',
      id,
      author: '/root',
      recipient,
      content: [{ type: 'input_text', text: `Message Type: MESSAGE\nTask name: ${recipient}\nSender: /root\nPayload:\n${text ?? ''}` }, ...(text === null ? [{ type: 'encrypted_content', encrypted_content: '不可展示的加密测试块' }] : [])],
      internal_chat_message_metadata_passthrough: { turn_id: targetTurn, create_time: timestamp },
    },
  });
  await writeJsonl(path, [
    { ...sessionMeta(threadId), payload: { id: threadId, agent_path: agentPath } },
    message('parent-input', 'parent-turn', agentPath, '父线程输入'),
    turnContext(turnId, { model: 'gpt-5.6-sol', effort: 'high' }),
    message('input-first', turnId, agentPath, null, 1_002),
    message('input-secret', turnId, agentPath, null),
    message('input-readable', turnId, agentPath, '补充指令\n第二行。', 1_005),
    message('input-readable', turnId, agentPath, '补充指令\n第二行。', 1_005),
    message('other-agent', turnId, '/root/other', '另一个智能体的输入'),
    message('unknown-turn', 'unknown-turn', agentPath, '归属未知'),
  ]);
  /** 查询结果必须只包含自身轮次的输入，首条原生明文不能被磁盘覆盖。 */
  const result = await queryThread(thread);
  /** 单个输入只保留一次，不通过正文相似度判断身份。 */
  const items = result.turns[0]!.items;
  assertBehavior(items.map((item) => item.id).join(',') === 'input-first,command,input-secret,input-readable,answer', '输入应按身份去重并按消息时间排在过程和答复之间。');
  assertBehavior(items[0]?.text === '第一条指令\n\n保留完整换行。', '原生线程明文应优先且保留换行。');
  assertBehavior(items[0]?.startedAt === new Date(1_002_000).toISOString(), '原生输入缺少时间时必须保留同身份历史的真实消息时间。');
  assertBehavior(items[2]?.text === '' && (items[2]?.payload.subagentInput as { contentState?: string }).contentState === 'unavailable', '加密正文必须成为明确不可读输入。');
  assertBehavior(!JSON.stringify(result.turns).includes('不可展示的加密测试块') && !JSON.stringify(result.turns).includes('继承上下文'), '输入集合不得暴露密文或替代为继承上下文。');
  assertBehavior(result.turns[0]?.startedAt === new Date(1_001_000).toISOString() && result.turns[0]?.completedAt === new Date(1_010_000).toISOString(), '消息补齐不能改变真实轮次耗时。');
  /** 已归一化的原生输入仍须补上发送方，不能重复添加磁盘版本。 */
  const normalized = await queryThread({ ...thread, turns: [{ ...ownedTurn, items: [{ id: 'input-first', type: 'userMessage', text: '原生输入全文' }] }] });
  assertBehavior(
    normalized.turns[0]?.items.filter((item) => item.id === 'input-first').length === 1 &&
      normalized.turns[0]?.items[0]?.text === '原生输入全文' &&
      (normalized.turns[0]?.items[0]?.payload.subagentInput as { fromParent?: boolean }).fromParent === true,
    '原生普通输入必须保留明文和来源且只显示一次。',
  );
  /** 旧协议已有明确首发指令时，在可靠首轮补入消息，不制造时间或原生编号。 */
  const explicit = await queryThread({ ...thread, taskInstruction: '明确首发指令', turns: [turn('turn-explicit', 1_001, '答复')] });
  assertBehavior(explicit.turns[0]?.items[0]?.text === '明确首发指令' && explicit.turns[0]?.items[0]?.providerItemId === null && explicit.turns[0]?.items[0]?.startedAt === null, '明确首发指令应进入消息流且保留未知时间。');
  /** 并发刷新与新消息到达共享增量游标，不能重复或漏读。 */
  const reader = createCodexSubagentRuntimeReader({ providerHistoryRoot: historyRoot });
  await reader.read({ thread, ownedTurns: [ownedTurn] });
  await appendFile(path, `${JSON.stringify(message('input-later', turnId, agentPath, '后续指令', 1_006))}\n`);
  /** 同时请求两个快照，验证原生输入集合稳定。 */
  const refreshed = await Promise.all([reader.read({ thread, ownedTurns: [ownedTurn] }), reader.read({ thread, ownedTurns: [ownedTurn] })]);
  assertBehavior(
    refreshed.every((entry) => entry.inputMessages.length === 4 && entry.inputMessages.at(-1)?.text === '后续指令'),
    '并发增量读取必须保留一份后续输入。',
  );
  /** 边界收缩后不得继续暴露旧缓存消息。 */
  const hidden = await reader.read({ thread, ownedTurns: [] });
  assertBehavior(hidden.inputMessages.length === 0, '失去归属的轮次必须清除输入缓存。');
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
