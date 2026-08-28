import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import { CommandDeliveryRepository, CommandDeliveryStoreError } from '../packages/storage/src/commandDeliveryStore.js';
import { createZeusDatabase } from '../packages/storage/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-command-delivery-probe-'));
const databasePath = join(probeRoot, 'probe.db');
const observed: Record<string, unknown> = {};

try {
  const db = await createZeusDatabase(databasePath);
  try {
    db.execute(`CREATE TABLE probe_business_state (command_id TEXT PRIMARY KEY, state TEXT NOT NULL)`);
    await db.save();
    const repository = new CommandDeliveryRepository(db);

    const coreCommand = envelope('probe-command-core', 'probe-idempotency-core');
    let coreMutationCount = 0;
    const coreAccepted = repository.executeCoreApplication({
      envelope: coreCommand,
      requestSha256: digest('core-request'),
      destinationId: 'task-application-service',
      resourceId: 'probe-core-resource',
      operationIdentity: 'task:probe-core-resource:revision:1',
      occurredAt: '2026-08-21T00:00:00.000Z',
      mutateBusinessState: () => {
        coreMutationCount += 1;
        db.execute(`INSERT INTO probe_business_state (command_id, state) VALUES (?, 'core-accepted')`, [coreCommand.commandId]);
      },
    });
    const coreReplay = repository.executeCoreApplication({
      envelope: coreCommand,
      requestSha256: digest('core-request'),
      destinationId: 'task-application-service',
      resourceId: 'probe-core-resource',
      operationIdentity: 'task:probe-core-resource:revision:1',
      occurredAt: '2026-08-21T00:00:00.000Z',
      mutateBusinessState: () => {
        coreMutationCount += 1;
      },
    });
    observed.coreAtomicAccepted = coreAccepted.receipt.outcome;
    observed.coreReplayCreated = coreReplay.created;
    observed.coreMutationCount = coreMutationCount;
    observed.coreOperationIdentity = coreReplay.receipt.operationIdentity;
    const conflictingCoreCommand = envelope('probe-command-core-same-operation', 'probe-idempotency-core-same-operation');
    let conflictingCoreMutationCount = 0;
    observed.coreOperationIdentityConflict = captureCode(() =>
      repository.executeCoreApplication({
        envelope: conflictingCoreCommand,
        requestSha256: digest('core-same-operation-request'),
        destinationId: 'task-application-service',
        resourceId: 'probe-core-resource-second-command',
        operationIdentity: 'task:probe-core-resource:revision:1',
        occurredAt: '2026-08-21T00:00:00.250Z',
        mutateBusinessState: () => {
          conflictingCoreMutationCount += 1;
          db.execute(`INSERT INTO probe_business_state (command_id, state) VALUES (?, 'must-roll-back')`, [conflictingCoreCommand.commandId]);
        },
      }),
    );
    observed.coreConflictingMutationCount = conflictingCoreMutationCount;
    observed.coreConflictingInboxCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [conflictingCoreCommand.commandId])?.count ?? -1;
    observed.coreLookupByOperationIdentity = repository.getByOperationIdentity('task:probe-core-resource:revision:1')?.inbox.commandId ?? null;

    const coreRollbackCommand = envelope('probe-command-core-rollback', 'probe-idempotency-core-rollback');
    observed.coreAtomicRollback = captureSqlFailure(() =>
      repository.executeCoreApplication({
        envelope: coreRollbackCommand,
        requestSha256: digest('core-rollback-request'),
        destinationId: 'task-application-service',
        resourceId: 'probe-core-rollback-resource',
        operationIdentity: 'task:probe-core-rollback-resource:revision:1',
        occurredAt: '2026-08-21T00:00:00.500Z',
        mutateBusinessState: () => {
          db.execute(`INSERT INTO probe_business_state (command_id, state) VALUES (?, 'core-rollback')`, [coreRollbackCommand.commandId]);
          throw new Error('probe core rollback');
        },
      }),
    );
    observed.coreRollbackInboxCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [coreRollbackCommand.commandId])?.count ?? -1;
    observed.coreRollbackOutboxCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_outbox WHERE command_id = ?`, [coreRollbackCommand.commandId])?.count ?? -1;
    observed.coreRollbackBusinessCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM probe_business_state WHERE command_id = ?`, [coreRollbackCommand.commandId])?.count ?? -1;

    const unknownCommand = envelope('probe-command-unknown', 'probe-idempotency-unknown');
    const unknown = repository.acceptAndPrepare({
      envelope: unknownCommand,
      requestSha256: digest('unknown-request'),
      destinationKind: 'provider_runtime',
      destinationId: 'probe-provider',
      resourceId: 'probe-submission-unknown',
      occurredAt: '2026-08-21T00:00:00.000Z',
      mutateBusinessState: () => db.execute(`INSERT INTO probe_business_state (command_id, state) VALUES (?, 'dispatching')`, [unknownCommand.commandId]),
    });
    repository.markProviderWriteStarted({ outboxId: unknown.outbox.id, occurredAt: '2026-08-21T00:00:01.000Z' });
    repository.recordOutcome({
      outboxId: unknown.outbox.id,
      outcome: 'outcome_unknown_after_write',
      evidence: { source: 'probe', writeMayHaveReachedProvider: true },
      providerId: 'probe-provider',
      occurredAt: '2026-08-21T00:00:02.000Z',
    });
    observed.unknownReplayBlocked = captureCode(() =>
      repository.acceptAndPrepare({
        envelope: unknownCommand,
        requestSha256: digest('unknown-request'),
        destinationKind: 'provider_runtime',
        destinationId: 'probe-provider',
        resourceId: 'probe-submission-unknown',
        occurredAt: '2026-08-21T00:00:03.000Z',
      }),
    );

    const rejectedCommand = envelope('probe-command-rejected', 'probe-idempotency-rejected');
    const rejectedFirst = repository.acceptAndPrepare({
      envelope: rejectedCommand,
      requestSha256: digest('rejected-request'),
      destinationKind: 'provider_runtime',
      destinationId: 'probe-provider',
      resourceId: 'probe-submission-rejected',
      occurredAt: '2026-08-21T00:01:00.000Z',
    });
    repository.recordOutcome({
      outboxId: rejectedFirst.outbox.id,
      outcome: 'explicitly_rejected',
      evidence: { code: 'PROBE_EXPLICIT_REJECTION' },
      providerId: 'probe-provider',
      occurredAt: '2026-08-21T00:01:01.000Z',
    });
    const rejectedRetry = repository.acceptAndPrepare({
      envelope: rejectedCommand,
      requestSha256: digest('rejected-request'),
      destinationKind: 'provider_runtime',
      destinationId: 'probe-provider',
      resourceId: 'probe-submission-rejected',
      occurredAt: '2026-08-21T00:01:02.000Z',
    });
    repository.markProviderWriteStarted({ outboxId: rejectedRetry.outbox.id, occurredAt: '2026-08-21T00:01:03.000Z' });
    repository.recordOutcome({
      outboxId: rejectedRetry.outbox.id,
      outcome: 'accepted',
      evidence: { responseReceived: true },
      providerId: 'probe-provider',
      nativeSessionId: 'probe-session',
      occurredAt: '2026-08-21T00:01:04.000Z',
    });
    const rejectedSnapshot = repository.get(rejectedCommand.commandId)!;
    observed.safeRetryAttempts = rejectedSnapshot.attempts.map((attempt) => attempt.outcome);
    observed.acceptedReplayBlocked = captureCode(() =>
      repository.acceptAndPrepare({
        envelope: rejectedCommand,
        requestSha256: digest('rejected-request'),
        destinationKind: 'provider_runtime',
        destinationId: 'probe-provider',
        resourceId: 'probe-submission-rejected',
        occurredAt: '2026-08-21T00:01:05.000Z',
      }),
    );

    const crashCommand = envelope('probe-command-crash', 'probe-idempotency-crash');
    const crash = repository.acceptAndPrepare({
      envelope: crashCommand,
      requestSha256: digest('crash-request'),
      destinationKind: 'provider_runtime',
      destinationId: 'probe-provider',
      resourceId: 'probe-submission-crash',
      occurredAt: '2026-08-21T00:02:00.000Z',
    });
    repository.markProviderWriteStarted({ outboxId: crash.outbox.id, occurredAt: '2026-08-21T00:02:01.000Z' });
    observed.startupUnknownSealed = repository.sealUnreceiptedProviderWritesAsUnknown('2026-08-21T00:02:02.000Z');
    observed.startupOutcome = repository.get(crashCommand.commandId)?.attempts.at(-1)?.outcome ?? null;
    observed.unknownListedForRecovery = repository.listRecoveryRequired().some((snapshot) => snapshot.inbox.commandId === crashCommand.commandId);
    repository.reconcileUnknownAsAccepted({
      outboxId: crash.outbox.id,
      evidence: { source: 'provider_history_probe', nativeTurnListed: true },
      providerId: 'probe-provider',
      nativeSessionId: 'probe-crash-session',
      occurredAt: '2026-08-21T00:02:03.000Z',
    });
    observed.reconciledOutcome = repository.get(crashCommand.commandId)?.attempts.at(-1)?.outcome ?? null;
    observed.reconciliationReceiptCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_delivery_receipts WHERE outbox_id = ?`, [crash.outbox.id])?.count ?? 0;

    const externalCommand = envelope('probe-command-external', 'probe-idempotency-external');
    const external = repository.acceptAndPrepare({
      envelope: externalCommand,
      requestSha256: digest('external-request'),
      destinationKind: 'external_operation',
      destinationId: 'git-application-service',
      resourceId: 'probe-external-resource',
      externalOperationId: 'git:probe-external-resource:attempt:1',
      occurredAt: '2026-08-21T00:02:10.000Z',
    });
    repository.markExternalWriteStarted({ outboxId: external.outbox.id, occurredAt: '2026-08-21T00:02:11.000Z' });
    repository.recordOutcome({
      outboxId: external.outbox.id,
      outcome: 'outcome_unknown_after_write',
      evidence: { source: 'external_probe', writeMayHaveReachedTarget: true },
      occurredAt: '2026-08-21T00:02:12.000Z',
    });
    observed.externalOperationIdentity = repository.get(externalCommand.commandId)?.attempts.at(-1)?.externalOperationId ?? null;
    const conflictingExternalCommand = envelope('probe-command-external-same-operation', 'probe-idempotency-external-same-operation');
    observed.externalOperationIdentityConflict = captureCode(() =>
      repository.acceptAndPrepare({
        envelope: conflictingExternalCommand,
        requestSha256: digest('external-same-operation-request'),
        destinationKind: 'external_operation',
        destinationId: 'git-application-service',
        resourceId: 'probe-external-resource-second-command',
        externalOperationId: 'git:probe-external-resource:attempt:1',
        occurredAt: '2026-08-21T00:02:12.500Z',
      }),
    );
    observed.externalConflictingInboxCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [conflictingExternalCommand.commandId])?.count ?? -1;
    observed.externalLookupByOperationIdentity = repository.getByExternalOperationIdentity('git-application-service', 'git:probe-external-resource:attempt:1')?.inbox.commandId ?? null;
    observed.externalUnknownReplayBlocked = captureCode(() =>
      repository.acceptAndPrepare({
        envelope: externalCommand,
        requestSha256: digest('external-request'),
        destinationKind: 'external_operation',
        destinationId: 'git-application-service',
        resourceId: 'probe-external-resource',
        externalOperationId: 'git:probe-external-resource:attempt:1',
        occurredAt: '2026-08-21T00:02:13.000Z',
      }),
    );

    observed.idempotencyConflict = captureCode(() =>
      repository.acceptAndPrepare({
        envelope: { ...rejectedCommand, commandId: 'probe-command-conflicting', payload: { changed: true } },
        requestSha256: digest('different-request'),
        destinationKind: 'provider_runtime',
        destinationId: 'probe-provider',
        resourceId: 'probe-submission-rejected',
        occurredAt: '2026-08-21T00:03:00.000Z',
      }),
    );
    const rollbackCommand = envelope('probe-command-rollback', 'probe-idempotency-rollback');
    observed.businessAndOutboxRollback = captureSqlFailure(() =>
      repository.acceptAndPrepare({
        envelope: rollbackCommand,
        requestSha256: digest('rollback-request'),
        destinationKind: 'provider_runtime',
        destinationId: 'probe-provider',
        resourceId: 'probe-submission-rollback',
        occurredAt: '2026-08-21T00:04:00.000Z',
        mutateBusinessState: () => {
          db.execute(`INSERT INTO probe_business_state (command_id, state) VALUES (?, 'dispatching')`, [rollbackCommand.commandId]);
          throw new Error('probe rollback');
        },
      }),
    );
    observed.rolledBackInboxCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [rollbackCommand.commandId])?.count ?? -1;
    observed.rolledBackOutboxCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_outbox WHERE command_id = ?`, [rollbackCommand.commandId])?.count ?? -1;
    observed.rolledBackBusinessCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM probe_business_state WHERE command_id = ?`, [rollbackCommand.commandId])?.count ?? -1;
    observed.immutableReceipt = captureSqlFailure(() => db.execute(`UPDATE command_delivery_receipts SET outcome = 'failed_before_write' WHERE outbox_id = ?`, [rejectedRetry.outbox.id]));
    observed.businessStateCommitted = db.get<{ state: string }>(`SELECT state FROM probe_business_state WHERE command_id = ?`, [unknownCommand.commandId])?.state ?? null;
    observed.quickCheck = db.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check ?? null;

    assertProbe(observed.unknownReplayBlocked === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', 'unknown 必须阻断重放');
    assertProbe(observed.coreAtomicAccepted === 'accepted' && observed.coreReplayCreated === false && observed.coreMutationCount === 1, 'Core Application accepted 与业务 mutation 必须同事务且重放不重复 mutation');
    assertProbe(observed.coreOperationIdentity === 'task:probe-core-resource:revision:1', 'Core Application 必须使用独立 operation identity');
    assertProbe(
      observed.coreOperationIdentityConflict === 'ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT' &&
        observed.coreConflictingMutationCount === 0 &&
        observed.coreConflictingInboxCount === 0 &&
        observed.coreLookupByOperationIdentity === coreCommand.commandId,
      '不同 CommandId 不得复用 Core operationIdentity，且必须在 mutation 前失败关闭',
    );
    assertProbe(observed.coreAtomicRollback === true && observed.coreRollbackInboxCount === 0 && observed.coreRollbackOutboxCount === 0 && observed.coreRollbackBusinessCount === 0, 'Core Application 任一步失败必须整体回滚');
    assertProbe(observed.acceptedReplayBlocked === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', 'accepted 必须阻断重放');
    assertProbe(JSON.stringify(observed.safeRetryAttempts) === JSON.stringify(['explicitly_rejected', 'accepted']), '明确拒绝后只能建立下一 attempt');
    assertProbe(observed.startupUnknownSealed === 1 && observed.startupOutcome === 'outcome_unknown_after_write', '无回执写出标记必须在启动恢复时收口为 unknown');
    assertProbe(observed.unknownListedForRecovery === true, 'unknown 必须进入显式恢复清单而不是被当作普通终态隐藏');
    assertProbe(observed.reconciledOutcome === 'accepted' && observed.reconciliationReceiptCount === 2, 'Provider 原生证据必须通过追加回执把 unknown 收敛为 accepted');
    assertProbe(observed.externalOperationIdentity === 'git:probe-external-resource:attempt:1' && observed.externalUnknownReplayBlocked === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', 'External operation 必须保存独立身份且 unknown 禁止重放');
    assertProbe(
      observed.externalOperationIdentityConflict === 'ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT' && observed.externalConflictingInboxCount === 0 && observed.externalLookupByOperationIdentity === externalCommand.commandId,
      '不同 CommandId 不得复用同 destination/externalOperationId',
    );
    assertProbe(observed.idempotencyConflict === 'ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT', '幂等身份冲突必须失败关闭');
    assertProbe(observed.businessAndOutboxRollback === true && observed.rolledBackInboxCount === 0 && observed.rolledBackOutboxCount === 0 && observed.rolledBackBusinessCount === 0, '业务写与 Inbox/Outbox 任一步失败时必须整体回滚');
    assertProbe(observed.immutableReceipt === true, '回执必须不可变');
    assertProbe(observed.businessStateCommitted === 'dispatching', '业务状态与首个 Outbox 必须共同提交');
    assertProbe(observed.quickCheck === 'ok', '临时数据库 quick_check 必须通过');
  } finally {
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

function envelope(commandId: string, idempotencyKey: string): CommandEnvelope {
  return {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType: 'conversation.submission.dispatch',
    actor: { kind: 'local_api', id: 'command-delivery-probe' },
    scope: { kind: 'submission', id: commandId.replace('probe-command-', 'probe-submission-') },
    expectedRevision: null,
    idempotencyKey,
    issuedAt: '2026-08-21T00:00:00.000Z',
    payload: { commandId },
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function captureCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof CommandDeliveryStoreError ? error.code : error instanceof Error ? error.name : String(error);
  }
}

function captureSqlFailure(operation: () => unknown): boolean {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
}

function assertProbe(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Command Delivery 行为探针失败：${message}`);
}
