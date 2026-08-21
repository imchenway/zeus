import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeCodexPendingInteractionsForShutdown } from '../packages/local-server/src/codexFinalShutdownApplication.js';
import { CodexProviderCommandApplicationService } from '../packages/local-server/src/codexProviderCommandApplication.js';
import { CommandDeliveryRepository, ConversationRepository, ConversationServerRequestRepository, ConversationSubmissionRepository, ConversationTurnRepository, ProjectRepository, createZeusDatabase } from '../packages/storage/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-codex-provider-command-'));
const database = await createZeusDatabase(join(probeRoot, 'probe.db'));
const repository = new CommandDeliveryRepository(database);
let tick = 0;
const now = () => new Date(Date.UTC(2026, 7, 21, 12, 0, tick++)).toISOString();
const service = new CodexProviderCommandApplicationService(database, repository, now);
const providerTraceIdentity = '44444444-4444-4444-8444-444444444444';

try {
  database.execute(`CREATE TABLE probe_projection (id TEXT PRIMARY KEY, state TEXT NOT NULL)`);

  await service.executeSession({
    operation: 'thread_start',
    commandKey: 'thread-start-1',
    scope: { kind: 'submission', id: 'submission-session' },
    idempotencyKey: 'thread-start-1',
    issuedAt: '2026-08-21T12:00:00.000Z',
    resourceId: 'submission-session',
    requestIdentity: { model: 'model-1', cwd: '/tmp/project' },
    providerGenerationId: 'generation-before-start',
    traceIdentity: providerTraceIdentity,
    invoke: async () => ({ id: 'thread-1' }),
    nativeSessionId: (thread) => thread.id,
    acceptedProviderGenerationId: () => 'generation-owning-thread',
  });
  const session = requiredSnapshot('submission', 'submission-session');
  assertBehavior(session.attempt.destinationKind === 'provider_session', 'thread/start 必须使用 provider_session destination。');
  assertBehavior(session.receipt.nativeSessionId === 'thread-1' && session.receipt.nativeTurnId === null, 'session accepted 只能携带真实 thread 身份。');
  assertBehavior(session.receipt.providerGenerationId === 'generation-owning-thread', 'thread/start 必须记录真正接管新 thread 的 generation。');
  assertProviderTrace(session.snapshot, providerTraceIdentity, 'Codex session');

  await executeTurn('turn-accepted', 'turn-accepted-command', async () => undefined);
  const accepted = requiredSnapshot('turn', 'turn-accepted');
  assertBehavior(accepted.attempt.destinationKind === 'provider_turn', 'turn 写操作必须使用 provider_turn destination。');
  assertBehavior(accepted.receipt.nativeSessionId === 'thread-1' && accepted.receipt.nativeTurnId === 'native-turn-accepted', 'turn accepted 必须同时携带真实 thread 与 turn 身份。');
  assertProviderTrace(accepted.snapshot, providerTraceIdentity, 'Codex turn');

  let unknownProviderCalls = 0;
  const unknownCode = await captureAsyncCode(() =>
    executeTurn('turn-unknown', 'turn-unknown-command', async () => {
      unknownProviderCalls += 1;
      throw Object.assign(new Error('transport disconnected after write'), { code: 'ZEUS_CODEX_RESULT_UNKNOWN' });
    }),
  );
  assertBehavior(unknownCode === 'ZEUS_CODEX_RESULT_UNKNOWN', '首次普通写后异常必须向调用方保留原始错误。');
  const unknownReplay = await captureAsyncCode(() => executeTurn('turn-unknown', 'turn-unknown-command', async () => void (unknownProviderCalls += 1)));
  const unknown = requiredSnapshot('turn', 'turn-unknown');
  assertBehavior(unknown.receipt.outcome === 'outcome_unknown_after_write', '普通写后异常必须收口为 outcome_unknown_after_write。');
  assertBehavior(unknownReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' && unknownProviderCalls === 1 && unknown.snapshot.attempts.length === 1, 'unknown 重放必须在 Provider 调用前被阻止。');

  let rejectedProviderCalls = 0;
  const rejection = Object.assign(new Error('turn already ended'), { code: 'ZEUS_CODEX_TURN_ALREADY_ENDED', dispatchDisposition: 'explicit_rejection' });
  await captureAsyncCode(() =>
    executeTurn(
      'turn-rejected',
      'turn-rejected-command',
      async () => {
        rejectedProviderCalls += 1;
        throw rejection;
      },
      (error) => error === rejection,
    ),
  );
  await executeTurn(
    'turn-rejected',
    'turn-rejected-command',
    async () => void (rejectedProviderCalls += 1),
    (error) => error === rejection,
  );
  const retried = requiredSnapshot('turn', 'turn-rejected');
  assertBehavior(JSON.stringify(retried.snapshot.attempts.map((attempt) => attempt.outcome)) === '["explicitly_rejected","accepted"]' && rejectedProviderCalls === 2, '只有明确拒绝才允许安全创建新 attempt。');

  const markProviderWriteStarted = repository.markProviderWriteStarted.bind(repository);
  repository.markProviderWriteStarted = () => {
    throw Object.assign(new Error('local durable marker failed'), { code: 'ZEUS_DURABLE_MARKER_FAILED' });
  };
  const beforeWriteCode = await captureAsyncCode(() => executeTurn('turn-before-write', 'turn-before-write-command', async () => undefined));
  repository.markProviderWriteStarted = markProviderWriteStarted;
  const beforeWrite = requiredSnapshot('turn', 'turn-before-write');
  assertBehavior(beforeWriteCode === 'ZEUS_DURABLE_MARKER_FAILED' && beforeWrite.receipt.outcome === 'failed_before_write', '耐久写出水位尚未形成时必须记录 failed_before_write。');

  const rollbackCode = await captureAsyncCode(() =>
    service.executeTurn({
      operation: 'turn_steer',
      commandKey: 'turn-projection-rollback-command',
      scope: { kind: 'turn', id: 'turn-projection-rollback' },
      idempotencyKey: 'turn-projection-rollback-command',
      issuedAt: '2026-08-21T12:00:00.000Z',
      resourceId: 'turn-projection-rollback',
      requestIdentity: { contentSha256: 'projection-rollback' },
      providerGenerationId: 'generation-1',
      nativeSessionId: 'thread-1',
      nativeTurnId: () => 'native-turn-projection-rollback',
      invoke: async () => undefined,
      mutateBusinessState: () => {
        database.execute(`INSERT INTO probe_projection (id, state) VALUES ('projection-rollback', 'must-roll-back')`);
        throw Object.assign(new Error('projection failed'), { code: 'ZEUS_PROJECTION_FAILED' });
      },
    }),
  );
  const rollback = requiredSnapshot('turn', 'turn-projection-rollback');
  const projectionRows = database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM probe_projection WHERE id = 'projection-rollback'`)?.count ?? -1;
  assertBehavior(rollbackCode === 'ZEUS_PROJECTION_FAILED' && rollback.receipt.outcome === 'outcome_unknown_after_write', 'accepted 投影失败不能伪造 accepted，必须保守进入 unknown。');
  assertBehavior(projectionRows === 0, 'accepted 回执事务失败时业务投影必须一并回滚。');

  const conversations = new ConversationRepository(database);
  const submissions = new ConversationSubmissionRepository(database);
  const turns = new ConversationTurnRepository(database);
  const requests = new ConversationServerRequestRepository(database);
  const project = new ProjectRepository(database).create({ name: 'Codex final quit probe', localPath: probeRoot });
  const shutdownTimestamp = '2026-08-21T12:30:00.000Z';
  const conversation = conversations.create({
    id: 'codex-final-quit-conversation',
    projectId: project.id,
    title: 'Codex final quit probe',
    transportKind: 'codex_native',
    providerId: 'codex',
    providerThreadId: 'thread-final-quit',
    providerModel: 'model-1',
    providerState: 'waiting',
    agentKind: 'codex',
    agentTransport: 'app_server',
    nativeSessionId: 'thread-final-quit',
  });
  const shutdownSubmission = submissions.createOrGet({
    id: 'codex-final-quit-submission',
    conversationId: conversation.id,
    idempotencyKey: 'codex-final-quit-submission-v1',
    requestHash: 'f'.repeat(64),
    clientMessageId: 'codex-final-quit-client-message',
    kind: 'message',
    requestedDelivery: 'queue',
    status: 'active',
    input: { content: 'temporary final quit probe' },
    providerTurnId: 'turn-final-quit',
    createdAt: shutdownTimestamp,
    dispatchedAt: shutdownTimestamp,
  });
  const shutdownTurn = turns.upsert({
    id: 'codex-final-quit-turn',
    conversationId: conversation.id,
    providerThreadId: 'thread-final-quit',
    providerTurnId: 'turn-final-quit',
    clientSubmissionId: shutdownSubmission.id,
    status: 'waiting',
    startedAt: shutdownTimestamp,
    completedAt: null,
    createdAt: shutdownTimestamp,
    updatedAt: shutdownTimestamp,
    agentKind: 'codex',
    nativeRunId: 'turn-final-quit',
  });
  const shutdownRequest = requests.upsert({
    conversationId: conversation.id,
    turnId: shutdownTurn.id,
    transportGenerationId: 'generation-final-quit',
    providerRequestId: 'request-final-quit',
    requestKind: 'request_user_input',
    payload: { questions: [] },
    status: 'pending',
    createdAt: shutdownTimestamp,
  });
  await database.save();

  const updateSubmissionStatus = submissions.updateStatus.bind(submissions);
  submissions.updateStatus = () => {
    throw Object.assign(new Error('injected final quit projection failure'), { code: 'ZEUS_FINAL_QUIT_PROJECTION_FAILED' });
  };
  const finalQuitRollbackCode = captureSyncCode(() => finalizeCodexPendingInteractionsForShutdown({ db: database, conversations, turns, submissions, requests }, { requestIds: [shutdownRequest.id], occurredAt: shutdownTimestamp }));
  submissions.updateStatus = updateSubmissionStatus;
  assertBehavior(finalQuitRollbackCode === 'ZEUS_FINAL_QUIT_PROJECTION_FAILED', 'final_quit 任一投影失败必须整体回滚。');
  assertBehavior(
    requests.getById(shutdownRequest.id)?.status === 'pending' &&
      turns.getById(shutdownTurn.id)?.status === 'waiting' &&
      submissions.getById(shutdownSubmission.id)?.status === 'active' &&
      conversations.getById(conversation.id)?.providerState === 'waiting',
    'final_quit 回滚后 request/turn/submission/conversation 必须全部保持原状态。',
  );

  const finalQuit = finalizeCodexPendingInteractionsForShutdown(
    { db: database, conversations, turns, submissions, requests },
    {
      requestIds: [shutdownRequest.id],
      occurredAt: shutdownTimestamp,
      providerActionEvidence: new Map([[shutdownRequest.id, { turnInterrupt: 'outcome_unconfirmed' }]]),
    },
  );
  const finalRequest = requests.getById(shutdownRequest.id);
  const finalTurn = turns.getById(shutdownTurn.id);
  const finalSubmission = submissions.getById(shutdownSubmission.id);
  const finalConversation = conversations.getById(conversation.id);
  const finalEvidence = finalRequest?.responseJson ? (JSON.parse(finalRequest.responseJson) as Record<string, unknown>) : {};
  assertBehavior(finalRequest?.status === 'failed' && finalTurn?.status === 'failed', 'final_quit 必须同时结束 pending request 与 waiting turn。');
  assertBehavior(finalSubmission?.status === 'paused' && finalSubmission.pausedReason === 'recovery_required', 'Provider 终态未知的 active submission 必须进入 recovery_required。');
  assertBehavior(finalConversation?.providerState === 'paused', 'Provider 终态未知的 conversation 必须离开 waiting 并进入 paused。');
  assertBehavior(finalEvidence.providerOutcomeUnconfirmed === true && finalEvidence.recoveryRequired === true, 'final_quit 必须保留 Provider 结果未知与显式恢复证据。');

  const quickCheck = database.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check;
  assertBehavior(quickCheck === 'ok', `临时数据库 quick_check 失败：${quickCheck ?? 'missing'}`);
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        session: { destination: session.attempt.destinationKind, generation: session.receipt.providerGenerationId, nativeSessionId: session.receipt.nativeSessionId, nativeTurnId: session.receipt.nativeTurnId },
        turn: { destination: accepted.attempt.destinationKind, nativeSessionId: accepted.receipt.nativeSessionId, nativeTurnId: accepted.receipt.nativeTurnId },
        unknown: { outcome: unknown.receipt.outcome, replay: unknownReplay, providerCalls: unknownProviderCalls, attempts: unknown.snapshot.attempts.length },
        explicitRetry: { outcomes: retried.snapshot.attempts.map((attempt) => attempt.outcome), providerCalls: rejectedProviderCalls },
        beforeWrite: { outcome: beforeWrite.receipt.outcome, error: beforeWriteCode },
        projectionRollback: { outcome: rollback.receipt.outcome, rows: projectionRows },
        finalQuit: {
          rollback: finalQuitRollbackCode,
          request: finalRequest?.status,
          turn: finalTurn?.status,
          submission: finalSubmission?.status,
          pausedReason: finalSubmission?.pausedReason,
          conversation: finalConversation?.providerState,
          providerOutcomeUnconfirmed: finalEvidence.providerOutcomeUnconfirmed,
          recoveryRequired: finalEvidence.recoveryRequired,
          terminalized: {
            requests: finalQuit.requestIds.length,
            turns: finalQuit.turnIds.length,
            submissions: finalQuit.submissionIds.length,
            conversations: finalQuit.pausedConversationIds.length,
          },
        },
        quickCheck,
        providerTraceIdentity,
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
  await rm(probeRoot, { recursive: true, force: true });
}

async function executeTurn(scopeId: string, commandKey: string, invoke: () => Promise<void>, isExplicitRejection?: (error: unknown) => boolean): Promise<void> {
  await service.executeTurn({
    operation: 'turn_steer',
    commandKey,
    scope: { kind: 'turn', id: scopeId },
    idempotencyKey: commandKey,
    issuedAt: '2026-08-21T12:00:00.000Z',
    resourceId: scopeId,
    requestIdentity: { contentSha256: commandKey },
    providerGenerationId: 'generation-1',
    traceIdentity: providerTraceIdentity,
    nativeSessionId: 'thread-1',
    nativeTurnId: () => `native-${scopeId}`,
    invoke,
    ...(isExplicitRejection ? { isExplicitRejection } : {}),
  });
}

function assertProviderTrace(snapshot: ReturnType<CommandDeliveryRepository['get']>, expected: string, label: string): void {
  const envelope = JSON.parse(snapshot?.inbox.envelopeJson ?? '{}') as { traceIdentity?: unknown };
  const evidence = JSON.parse(snapshot?.attempts.at(-1)?.receipt?.evidenceJson ?? '{}') as { traceIdentity?: unknown };
  assertBehavior(envelope.traceIdentity === expected, `${label} CommandEnvelope 没有保留受控 trace identity。`);
  assertBehavior(evidence.traceIdentity === expected, `${label} Provider receipt 没有保留同一 trace identity。`);
}

function requiredSnapshot(scopeKind: 'submission' | 'turn', scopeId: string) {
  const snapshot = repository.getByScope(scopeKind, scopeId);
  const attempt = snapshot?.attempts.at(-1);
  const receipt = attempt?.receipt;
  assertBehavior(snapshot && attempt && receipt, `缺少 ${scopeKind}:${scopeId} 的耐久命令快照。`);
  return { snapshot, attempt, receipt };
}

async function captureAsyncCode(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : null;
  }
}

function captureSyncCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : null;
  }
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Codex Provider Command 行为核验失败：${message}`);
}
