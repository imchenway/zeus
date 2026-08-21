import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiProviderCommandApplicationService } from '../packages/local-server/src/piProviderCommandDelivery.js';
import { CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-pi-provider-command-'));
const database = await createZeusDatabase(join(probeRoot, 'probe.db'));
const repository = new CommandDeliveryRepository(database);
let tick = 0;
const now = () => new Date(Date.UTC(2026, 7, 21, 11, 0, tick++)).toISOString();
const service = new PiProviderCommandApplicationService(repository, now, (value) => ({ text: value.replace(/secret-[A-Za-z0-9._-]+/gu, '[REDACTED]') }));
const providerTraceIdentity = '55555555-5555-4555-8555-555555555555';

try {
  database.execute('CREATE TABLE pi_provider_projection_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const session = prepareSession(service, 'session', 'conversation-1');
  session.markProviderWriteStarted();
  session.recordSessionAcceptedAtomically(
    { nativeSessionId: 'session-1', runtimeInstanceId: 'generation-1', nativeSessionPath: '/tmp/session-1.jsonl' },
    {
      durableTransactionSync: (operation) => {
        database.durableTransactionSync(operation);
      },
      projectNativeSession: () => database.execute('INSERT INTO pi_provider_projection_probe (id, value) VALUES (?, ?)', ['session-accepted', 'session-1']),
    },
  );
  const sessionSnapshot = repository.get(session.commandId)?.attempts.at(-1);
  assertBehavior(sessionSnapshot?.destinationKind === 'provider_session', 'openSession 必须使用 provider_session destination。');
  assertBehavior(sessionSnapshot.receipt?.nativeSessionId === 'session-1' && sessionSnapshot.receipt.nativeTurnId === null, 'session accepted 只能保存真实 session 身份。');
  assertBehavior(repository.get(session.commandId)?.inbox.scopeKind === 'product_conversation' && repository.get(session.commandId)?.inbox.scopeId === 'conversation-1', 'session 子命令必须稳定归属真实产品会话。');
  assertBehavior(database.get<{ value: string }>('SELECT value FROM pi_provider_projection_probe WHERE id = ?', ['session-accepted'])?.value === 'session-1', 'session receipt 必须与本地原生 session 投影一起提交。');
  assertProviderTrace(repository.get(session.commandId), providerTraceIdentity, 'Pi session');

  const sessionRolledBack = prepareSession(service, 'session-rollback', 'conversation-rollback');
  sessionRolledBack.markProviderWriteStarted();
  const sessionRollbackCode = captureCode(() =>
    sessionRolledBack.recordSessionAcceptedAtomically(
      { nativeSessionId: 'session-rollback', runtimeInstanceId: 'generation-1', nativeSessionPath: '/tmp/session-rollback.jsonl' },
      {
        durableTransactionSync: (operation) => {
          database.durableTransactionSync(() => {
            operation();
            throw Object.assign(new Error('injected session projection rollback'), { code: 'ZEUS_PI_SESSION_PROJECTION_ROLLBACK' });
          });
        },
        projectNativeSession: () => database.execute('INSERT INTO pi_provider_projection_probe (id, value) VALUES (?, ?)', ['session-rolled-back', 'must-not-survive']),
      },
    ),
  );
  assertBehavior(sessionRollbackCode === 'ZEUS_PI_SESSION_PROJECTION_ROLLBACK', 'session 投影与 accepted receipt 之后注入的回滚必须可观测。');
  assertBehavior(database.get('SELECT id FROM pi_provider_projection_probe WHERE id = ?', ['session-rolled-back']) === undefined, 'session 原生投影回滚后不得残留半条本地身份。');
  assertBehavior(repository.get(sessionRolledBack.commandId)?.attempts.at(-1)?.receipt === null, 'session 原生投影回滚时 accepted receipt 必须一起回滚。');
  sessionRolledBack.recordFailure(Object.assign(new Error('session projection commit failed after Provider write'), { code: 'ZEUS_PI_SESSION_PROJECTION_ROLLBACK' }), {
    explicitlyRejected: false,
    nativeSessionId: 'session-rollback',
  });
  const sessionRollbackReplay = captureCode(() => prepareSession(service, 'session-rollback', 'conversation-rollback'));
  assertBehavior(repository.get(sessionRolledBack.commandId)?.attempts.at(-1)?.outcome === 'outcome_unknown_after_write', 'session 原子提交回滚后必须能继续保守记录 unknown，不能被进程内 settled 假象吞掉。');
  assertBehavior(sessionRollbackReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', 'session 原子提交回滚后的 unknown 必须阻止再次 openSession。');

  const run = prepareRun(service, 'run-start', 'submission-run');
  run.markProviderWriteStarted();
  run.recordTurnAccepted({ nativeSessionId: 'session-1', nativeTurnId: 'run-1', acceptedAt: now() });
  const runSnapshot = repository.get(run.commandId)?.attempts.at(-1);
  assertBehavior(runSnapshot?.destinationKind === 'provider_turn', 'startRun 必须使用 provider_turn destination。');
  assertBehavior(runSnapshot.receipt?.nativeSessionId === 'session-1' && runSnapshot.receipt.nativeTurnId === 'run-1', 'turn accepted 必须同时保存真实 session 与 run 身份。');
  assertBehavior(repository.get(run.commandId)?.inbox.scopeKind === 'submission' && repository.get(run.commandId)?.inbox.scopeId === 'submission-run', 'run 子命令必须稳定归属父提交。');
  assertBehavior(session.commandId !== run.commandId, 'session 与 run 必须是可对账的独立父子命令，不能合并成 composite attempt。');
  assertProviderTrace(repository.get(run.commandId), providerTraceIdentity, 'Pi run');

  const atomic = prepareRun(service, 'run-atomic', 'submission-atomic');
  atomic.markProviderWriteStarted();
  atomic.recordTurnAcceptedAtomically(
    { nativeSessionId: 'session-1', nativeTurnId: 'run-atomic', acceptedAt: now() },
    {
      durableTransactionSync: (operation) => database.durableTransactionSync(operation),
      projectTurn: () => database.execute('INSERT INTO pi_provider_projection_probe (id, value) VALUES (?, ?)', ['accepted', 'run-atomic']),
    },
  );
  assertBehavior(database.get<{ value: string }>('SELECT value FROM pi_provider_projection_probe WHERE id = ?', ['accepted'])?.value === 'run-atomic', '业务投影必须与 accepted receipt 一起提交。');
  assertBehavior(repository.get(atomic.commandId)?.attempts.at(-1)?.receipt?.nativeTurnId === 'run-atomic', '原子事务必须同时形成真实 run receipt。');

  const rolledBack = prepareRun(service, 'run-rollback', 'submission-rollback');
  rolledBack.markProviderWriteStarted();
  const rollbackCode = captureCode(() =>
    rolledBack.recordTurnAcceptedAtomically(
      { nativeSessionId: 'session-1', nativeTurnId: 'run-rollback', acceptedAt: now() },
      {
        durableTransactionSync: (operation) =>
          database.durableTransactionSync(() => {
            operation();
            throw Object.assign(new Error('injected projection rollback'), { code: 'ZEUS_PI_ATOMIC_PROJECTION_ROLLBACK' });
          }),
        projectTurn: () => database.execute('INSERT INTO pi_provider_projection_probe (id, value) VALUES (?, ?)', ['rolled-back', 'must-not-survive']),
      },
    ),
  );
  assertBehavior(rollbackCode === 'ZEUS_PI_ATOMIC_PROJECTION_ROLLBACK', '注入的原子事务回滚必须可观测。');
  assertBehavior(database.get('SELECT id FROM pi_provider_projection_probe WHERE id = ?', ['rolled-back']) === undefined, '业务投影失败时不得残留半条投影。');
  assertBehavior(repository.get(rolledBack.commandId)?.attempts.at(-1)?.receipt === null, '业务投影回滚时 accepted receipt 也必须回滚。');
  rolledBack.recordFailure(Object.assign(new Error('turn projection commit failed after Provider write'), { code: 'ZEUS_PI_ATOMIC_PROJECTION_ROLLBACK' }), {
    explicitlyRejected: false,
    nativeSessionId: 'session-1',
    nativeTurnId: 'run-rollback',
  });
  const rollbackReplay = captureCode(() => prepareRun(service, 'run-rollback', 'submission-rollback'));
  assertBehavior(repository.get(rolledBack.commandId)?.attempts.at(-1)?.outcome === 'outcome_unknown_after_write', 'turn 原子提交回滚后必须立即持久化 unknown。');
  assertBehavior(rollbackReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', 'turn 原子提交回滚后的 unknown 必须阻止重放。');

  const unknown = prepareRun(service, 'run-unknown', 'submission-unknown');
  unknown.markProviderWriteStarted();
  unknown.recordFailure(Object.assign(new Error(`result unknown token=secret-visible ${'x'.repeat(4_096)}`), { code: 'ZEUS_PROVIDER_WORKER_RESULT_UNKNOWN' }), {
    explicitlyRejected: false,
    nativeSessionId: 'session-1',
  });
  const unknownReplay = captureCode(() => prepareRun(service, 'run-unknown', 'submission-unknown'));
  assertBehavior(unknownReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', '写出后 unknown 必须阻止自动重发。');
  assertBehavior(repository.get(unknown.commandId)?.attempts.length === 1, 'unknown 重连不得创建第二个 attempt。');
  const unknownEvidence = JSON.parse(repository.get(unknown.commandId)?.attempts.at(-1)?.receipt?.evidenceJson ?? '{}') as { error?: { message?: string } };
  assertBehavior(!unknownEvidence.error?.message?.includes('secret-visible'), '失败回执不得保留敏感值。');
  assertBehavior(Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8') <= 2 * 1024, '失败回执 message 必须限制为 2 KiB。');

  const rejected = prepareRun(service, 'run-rejected', 'submission-rejected');
  rejected.markProviderWriteStarted();
  rejected.recordFailure(Object.assign(new Error('not active'), { code: 'ZEUS_PI_RUN_NOT_ACTIVE' }), { explicitlyRejected: true, nativeSessionId: 'session-1', nativeTurnId: 'run-old' });
  const retry = prepareRun(service, 'run-rejected', 'submission-rejected');
  assertBehavior(retry.commandId === rejected.commandId, '明确拒绝后的安全重试必须复用稳定 Provider 子命令身份。');
  retry.markProviderWriteStarted();
  retry.recordTurnAccepted({ nativeSessionId: 'session-1', nativeTurnId: 'run-retry', acceptedAt: now() });
  const retryOutcomes = repository.get(rejected.commandId)?.attempts.map((attempt) => attempt.outcome) ?? [];
  assertBehavior(JSON.stringify(retryOutcomes) === '["explicitly_rejected","accepted"]', '只有明确拒绝才允许建立安全新 attempt。');

  const beforeWrite = prepareRun(service, 'run-before-write', 'submission-before-write');
  beforeWrite.recordFailure(new Error('local preparation failed'), { explicitlyRejected: false, nativeSessionId: 'session-1' });
  assertBehavior(repository.get(beforeWrite.commandId)?.attempts.at(-1)?.outcome === 'failed_before_write', '未落写出水位的失败必须保留 failed_before_write。');

  const quickCheck = database.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check;
  assertBehavior(quickCheck === 'ok', `临时数据库 quick_check 失败：${quickCheck ?? 'missing'}`);
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        session: { destination: sessionSnapshot.destinationKind, nativeSessionId: sessionSnapshot.receipt.nativeSessionId, nativeTurnId: sessionSnapshot.receipt.nativeTurnId },
        turn: { destination: runSnapshot.destinationKind, nativeSessionId: runSnapshot.receipt.nativeSessionId, nativeTurnId: runSnapshot.receipt.nativeTurnId },
        parentChild: { sessionCommandId: session.commandId, runCommandId: run.commandId, runScopeId: repository.get(run.commandId)?.inbox.scopeId ?? null },
        atomic: {
          sessionProjection: database.get<{ value: string }>('SELECT value FROM pi_provider_projection_probe WHERE id = ?', ['session-accepted'])?.value ?? null,
          sessionRollbackCode,
          sessionRollbackProjectionPresent: database.get('SELECT id FROM pi_provider_projection_probe WHERE id = ?', ['session-rolled-back']) !== undefined,
          sessionRollbackOutcome: repository.get(sessionRolledBack.commandId)?.attempts.at(-1)?.outcome ?? null,
          sessionRollbackReplay,
          projection: database.get<{ value: string }>('SELECT value FROM pi_provider_projection_probe WHERE id = ?', ['accepted'])?.value ?? null,
          receipt: repository.get(atomic.commandId)?.attempts.at(-1)?.receipt?.nativeTurnId ?? null,
          rollbackCode,
          rollbackProjectionPresent: database.get('SELECT id FROM pi_provider_projection_probe WHERE id = ?', ['rolled-back']) !== undefined,
          rollbackReceiptPresent: repository.get(rolledBack.commandId)?.attempts.at(-1)?.receipt !== null,
          rollbackOutcome: repository.get(rolledBack.commandId)?.attempts.at(-1)?.outcome ?? null,
          rollbackReplay,
        },
        unknown: { replay: unknownReplay, attempts: repository.get(unknown.commandId)?.attempts.length ?? 0 },
        boundedRedactedErrorBytes: Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8'),
        retryOutcomes,
        beforeWrite: repository.get(beforeWrite.commandId)?.attempts.at(-1)?.outcome ?? null,
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

function prepareRun(service: PiProviderCommandApplicationService, commandKey: string, submissionId: string) {
  return service.prepare({
    operation: 'run_start',
    commandKey,
    scope: { kind: 'submission', id: submissionId },
    idempotencyKey: `request-${commandKey}`,
    issuedAt: '2026-08-21T11:00:00.000Z',
    resourceId: submissionId,
    requestIdentity: { nativeSessionId: 'session-1', contentSha256: commandKey },
    providerGenerationId: 'generation-1',
    traceIdentity: providerTraceIdentity,
  });
}

function prepareSession(service: PiProviderCommandApplicationService, commandKey: string, conversationId: string) {
  return service.prepare({
    operation: 'session_open',
    commandKey: `submission-${commandKey}`,
    scope: { kind: 'product_conversation', id: conversationId },
    idempotencyKey: `request-${commandKey}`,
    issuedAt: '2026-08-21T11:00:00.000Z',
    resourceId: conversationId,
    requestIdentity: { cwd: '/tmp/project', model: 'model-1' },
    providerGenerationId: 'generation-1',
    traceIdentity: providerTraceIdentity,
  });
}

function assertProviderTrace(snapshot: ReturnType<CommandDeliveryRepository['get']>, expected: string, label: string): void {
  const envelope = JSON.parse(snapshot?.inbox.envelopeJson ?? '{}') as { traceIdentity?: unknown };
  const evidence = JSON.parse(snapshot?.attempts.at(-1)?.receipt?.evidenceJson ?? '{}') as { traceIdentity?: unknown };
  assertBehavior(envelope.traceIdentity === expected, `${label} CommandEnvelope 没有保留受控 trace identity。`);
  assertBehavior(evidence.traceIdentity === expected, `${label} Provider receipt 没有保留同一 trace identity。`);
}

function captureCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : null;
  }
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Pi Provider Command 行为核验失败：${message}`);
}
