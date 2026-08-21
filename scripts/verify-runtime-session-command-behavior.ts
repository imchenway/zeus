import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import { CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import {
  RuntimeBoundedEphemeralReplayService,
  RuntimeEphemeralCapabilityService,
  RuntimeSessionCommandApplication,
  runtimeSessionCommandTypes,
  runtimeSessionInputSha256,
  type ParsedRuntimeSessionMutation,
  type RuntimeSessionCommandPayload,
  type RuntimeSessionCommandType,
} from '../packages/local-server/src/runtimeSessionCommandApplication.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-runtime-session-command-probe-'));
const observed: Record<string, unknown> = {};

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  try {
    const deliveries = new CommandDeliveryRepository(db);
    let clock = Date.parse('2026-08-21T04:00:00.000Z');
    const application = new RuntimeSessionCommandApplication({ db, deliveries, redactSensitiveText: (value) => ({ text: value.replaceAll('probe-secret', '[REDACTED]') }), now: () => new Date((clock += 1_000)) });

    db.execute(`CREATE TABLE runtime_command_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const core = parsedRequest({
      commandId: 'command_runtime_core_probe',
      commandType: runtimeSessionCommandTypes.sessionSummaryGenerate,
      scopeKind: 'runtime_segment',
      scopeId: 'runtime-session-probe',
      operationIdentity: 'runtime-summary-probe',
      input: {},
    });
    let coreInvocations = 0;
    const executeCore = () =>
      application.executeCore({
        parsed: core,
        destinationId: 'runtime-session-application',
        resourceId: core.command.scope.id,
        mutateBusinessState: () => {
          coreInvocations += 1;
          db.execute(`INSERT INTO runtime_command_probe (id, value) VALUES (?, ?)`, ['core', 'accepted']);
          return { summary: '不可变摘要' };
        },
      });
    executeCore();
    const coreReplay = executeCore();
    db.execute(`UPDATE runtime_command_probe SET value = 'later' WHERE id = 'core'`);
    const immutableCoreReplay = application.replayAcceptedCore<typeof core.input, { summary: string }>({
      parsed: core,
      destinationId: 'runtime-session-application',
      resourceId: core.command.scope.id,
    });
    observed.coreInvocations = coreInvocations;
    observed.coreReplay = coreReplay.replayed;
    observed.coreReplaySummary = immutableCoreReplay?.result.summary;
    observed.coreCurrentValue = db.get<{ value: string }>(`SELECT value FROM runtime_command_probe WHERE id = 'core'`)?.value;

    const accepted = externalRequest('accepted', { secret: 'secret-runtime-probe' });
    let acceptedInvocations = 0;
    const acceptedOnce = await application.executeExternal({
      parsed: accepted,
      destinationId: 'runtime-process-manager',
      resourceId: accepted.command.scope.id,
      externalOperationId: 'runtime-interrupt:accepted',
      invoke: async () => {
        acceptedInvocations += 1;
        return { status: 'running', signal: 'SIGINT' };
      },
      mutateAcceptedBusinessState: (result) => result,
    });
    const acceptedReplay = await application.executeExternal({
      parsed: accepted,
      destinationId: 'runtime-process-manager',
      resourceId: accepted.command.scope.id,
      externalOperationId: 'runtime-interrupt:accepted',
      invoke: async () => {
        acceptedInvocations += 1;
        return { status: 'must-not-run', signal: 'SIGINT' };
      },
      mutateAcceptedBusinessState: (result) => result,
    });
    const acceptedInbox = deliveries.get(accepted.command.commandId)!.inbox;
    observed.externalAccepted = acceptedOnce.result.status;
    observed.externalReplay = acceptedReplay.replayed;
    observed.externalInvocations = acceptedInvocations;
    observed.sensitiveBodyAbsentFromInbox = !acceptedInbox.envelopeJson.includes('secret-runtime-probe') && Object.keys(JSON.parse(acceptedInbox.envelopeJson).payload).sort().join(',') === 'inputSha256,operationIdentity';

    const beforeWrite = externalRequest('before-write', {});
    observed.failedBeforeWrite = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: beforeWrite,
        destinationId: 'runtime-process-manager',
        resourceId: beforeWrite.command.scope.id,
        externalOperationId: 'runtime-stop:before-write',
        beforeWrite: async () => {
          throw Object.assign(new Error('preflight rejected'), { code: 'ZEUS_RUNTIME_PROBE_PREFLIGHT' });
        },
        invoke: async () => ({ status: 'must-not-run' }),
        mutateAcceptedBusinessState: (result) => result,
      }),
    );
    const retriedBeforeWrite = await application.executeExternal({
      parsed: beforeWrite,
      destinationId: 'runtime-process-manager',
      resourceId: beforeWrite.command.scope.id,
      externalOperationId: 'runtime-stop:before-write',
      invoke: async () => ({ status: 'stopped' }),
      mutateAcceptedBusinessState: (result) => result,
    });
    observed.failedBeforeWriteOutcome = deliveries.get(beforeWrite.command.commandId)?.attempts[0]?.outcome;
    observed.failedBeforeWriteAttempts = deliveries.get(beforeWrite.command.commandId)?.attempts.length;
    observed.failedBeforeWriteRetry = retriedBeforeWrite.result.status;

    const explicit = externalRequest('explicit', {});
    observed.explicitError = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: explicit,
        destinationId: 'runtime-process-manager',
        resourceId: explicit.command.scope.id,
        externalOperationId: 'runtime-stop:explicit',
        invoke: async () => {
          throw Object.assign(new Error('process rejected signal'), { code: 'ZEUS_RUNTIME_PROBE_EXPLICIT' });
        },
        mutateAcceptedBusinessState: (result) => result,
        isExplicitRejection: (error) => errorCode(error) === 'ZEUS_RUNTIME_PROBE_EXPLICIT',
      }),
    );
    observed.explicitOutcome = deliveries.get(explicit.command.commandId)?.attempts.at(-1)?.outcome;

    const unknown = externalRequest('unknown', {});
    observed.unknownError = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: unknown,
        destinationId: 'runtime-process-manager',
        resourceId: unknown.command.scope.id,
        externalOperationId: 'runtime-interrupt:unknown',
        invoke: async () => {
          throw Object.assign(new Error('signal result unknown'), { code: 'ZEUS_RUNTIME_PROBE_UNKNOWN' });
        },
        mutateAcceptedBusinessState: (result) => result,
      }),
    );
    observed.unknownOutcome = deliveries.get(unknown.command.commandId)?.attempts.at(-1)?.outcome;
    observed.unknownReplay = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: unknown,
        destinationId: 'runtime-process-manager',
        resourceId: unknown.command.scope.id,
        externalOperationId: 'runtime-interrupt:unknown',
        invoke: async () => ({ status: 'must-not-run' }),
        mutateAcceptedBusinessState: (result) => result,
      }),
    );

    let ephemeralClock = Date.parse('2026-08-21T05:00:00.000Z');
    const boundedReplay = new RuntimeBoundedEphemeralReplayService({ nowMs: () => ephemeralClock, ttlMs: 1_000, maximumRecords: 2 });
    const confirmation = parsedRequest({
      commandId: 'command_runtime_confirmation_ephemeral_probe',
      commandType: runtimeSessionCommandTypes.confirmationCreate,
      scopeKind: 'approval',
      scopeId: 'runtime-confirmation-probe',
      operationIdentity: 'runtime-confirmation-probe',
      input: { reason: 'probe' },
    });
    let confirmationInvocations = 0;
    const ephemeralCreated = boundedReplay.execute(confirmation, () => ({ status: 'pending', nested: { value: 'original' } }));
    ephemeralCreated.result.nested.value = 'mutated-after-return';
    const ephemeralReplay = boundedReplay.execute(confirmation, () => {
      confirmationInvocations += 1;
      return { status: 'must-not-run', nested: { value: 'wrong' } };
    });
    observed.confirmationReplayValue = ephemeralReplay.result.nested.value;
    observed.confirmationReplayInvocations = confirmationInvocations;
    observed.confirmationInboxRows = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [confirmation.command.commandId])?.count;
    ephemeralClock += 1_001;
    const afterExpiry = boundedReplay.execute(confirmation, () => ({ status: 'renewed', nested: { value: 'new' } }));
    observed.confirmationAfterExpiry = afterExpiry.result.status;

    let leaseClock = Date.parse('2026-08-21T06:00:00.000Z');
    const ephemeral = new RuntimeEphemeralCapabilityService({ nowMs: () => leaseClock, leaseTtlMs: 1_000, maximumLeases: 2, maximumRecentResults: 2 });
    const lease = ephemeral.issue('runtime-session-lease-probe', { clientId: 'renderer-probe' });
    let writes = 0;
    const firstWrite = ephemeral.execute<{ input: string }, { accepted: number }>({
      sessionId: lease.sessionId,
      kind: 'input',
      value: { capability: { leaseId: lease.leaseId, clientId: lease.clientId, sequence: 1 }, input: { input: 'hello' } },
      invoke: () => ({ accepted: ++writes }),
    });
    const duplicateWrite = ephemeral.execute<{ input: string }, { accepted: number }>({
      sessionId: lease.sessionId,
      kind: 'input',
      value: { capability: { leaseId: lease.leaseId, clientId: lease.clientId, sequence: 1 }, input: { input: 'hello' } },
      invoke: () => ({ accepted: ++writes }),
    });
    observed.ephemeralWrites = writes;
    observed.ephemeralReplay = duplicateWrite.replayed;
    observed.ephemeralReplayResult = duplicateWrite.result.accepted;
    observed.ephemeralConflict = captureCode(() =>
      ephemeral.execute({
        sessionId: lease.sessionId,
        kind: 'input',
        value: { capability: { leaseId: lease.leaseId, clientId: lease.clientId, sequence: 1 }, input: { input: 'different' } },
        invoke: () => ({ accepted: 99 }),
      }),
    );
    observed.ephemeralGap = captureCode(() =>
      ephemeral.execute({
        sessionId: lease.sessionId,
        kind: 'resize',
        value: { capability: { leaseId: lease.leaseId, clientId: lease.clientId, sequence: 3 }, input: { cols: 80, rows: 24 } },
        invoke: () => ({ accepted: 99 }),
      }),
    );
    leaseClock += 1_001;
    observed.ephemeralExpired = captureCode(() =>
      ephemeral.execute({
        sessionId: lease.sessionId,
        kind: 'input',
        value: { capability: { leaseId: lease.leaseId, clientId: lease.clientId, sequence: 2 }, input: { input: 'late' } },
        invoke: () => ({ accepted: 99 }),
      }),
    );

    observed.quickCheck = db.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check;

    assertProbe(coreInvocations === 1 && coreReplay.replayed && observed.coreReplaySummary === '不可变摘要' && observed.coreCurrentValue === 'later', 'Core mutation 与 accepted receipt 必须原子且 replay 不重做业务写');
    assertProbe(acceptedInvocations === 1 && acceptedReplay.replayed && observed.sensitiveBodyAbsentFromInbox === true, 'external accepted replay 不能二次写出，敏感正文不能进入 Inbox');
    assertProbe(observed.failedBeforeWriteOutcome === 'failed_before_write' && observed.failedBeforeWriteAttempts === 2 && observed.failedBeforeWriteRetry === 'stopped', '写出前失败必须允许安全 attempt 2');
    assertProbe(observed.explicitOutcome === 'explicitly_rejected', '明确进程拒绝必须形成 explicitly_rejected');
    assertProbe(observed.unknownOutcome === 'outcome_unknown_after_write' && observed.unknownReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', '信号写出后未知必须禁止盲重放');
    assertProbe(
      observed.confirmationReplayValue === 'original' && observed.confirmationReplayInvocations === 0 && observed.confirmationInboxRows === 0 && observed.confirmationAfterExpiry === 'renewed',
      'Runtime confirmation 必须是有界短期能力而非伪造 durable Core',
    );
    assertProbe(writes === 1 && firstWrite.result.accepted === 1 && duplicateWrite.replayed, '相同 input sequence 必须有界去重');
    assertProbe(
      observed.ephemeralConflict === 'ZEUS_RUNTIME_EPHEMERAL_SEQUENCE_CONFLICT' && observed.ephemeralGap === 'ZEUS_RUNTIME_EPHEMERAL_SEQUENCE_GAP' && observed.ephemeralExpired === 'ZEUS_RUNTIME_EPHEMERAL_LEASE_EXPIRED',
      '租约必须拒绝冲突、跳号与过期写',
    );
    assertProbe(observed.quickCheck === 'ok', '临时数据库 quick_check 必须通过');
  } finally {
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

function parsedRequest<TInput extends object>(input: {
  commandId: string;
  commandType: RuntimeSessionCommandType;
  scopeKind: 'approval' | 'runtime_segment';
  scopeId: string;
  operationIdentity: string;
  input: TInput;
}): ParsedRuntimeSessionMutation<TInput> {
  const inputSha256 = runtimeSessionInputSha256(input.input);
  const command: CommandEnvelope<RuntimeSessionCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId: input.commandId,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'runtime-verifier' },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: '2026-08-21T04:00:00.000Z',
    payload: { operationIdentity: input.operationIdentity, inputSha256 },
  };
  return { command, input: input.input, inputSha256, operationIdentity: input.operationIdentity };
}

function externalRequest(suffix: string, input: Record<string, unknown>) {
  return parsedRequest({
    commandId: `command_runtime_external_${suffix}`,
    commandType: runtimeSessionCommandTypes.sessionInterrupt,
    scopeKind: 'runtime_segment',
    scopeId: `runtime-session-${suffix}`,
    operationIdentity: `runtime-operation-${suffix}`,
    input,
  });
}

function captureCode(callback: () => unknown): string | null {
  try {
    callback();
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

async function captureAsyncCode(callback: () => Promise<unknown>): Promise<string | null> {
  try {
    await callback();
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null;
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Runtime Session command behavior verifier failed: ${message}`);
}
