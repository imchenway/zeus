import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import { CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import {
  ConversationCommandApplication,
  conversationCommandTypes,
  conversationInputSha256,
  type ConversationCommandPayload,
  type ConversationCommandType,
  type ParsedConversationMutation,
} from '../packages/local-server/src/conversationCommandApplication.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-conversation-command-probe-'));
const observed: Record<string, unknown> = {};

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  try {
    const deliveries = new CommandDeliveryRepository(db);
    let clock = Date.parse('2026-08-21T08:00:00.000Z');
    const application = new ConversationCommandApplication({ db, deliveries, redactSensitiveText: redactProbeText, now: () => new Date((clock += 1_000)) });
    db.execute(`CREATE TABLE conversation_command_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);

    const core = parsedRequest(application, {
      commandId: 'command_conversation_core_probe',
      commandType: conversationCommandTypes.permissionModeUpdate,
      conversationId: 'conversation-core-probe',
      operationIdentity: 'conversation-operation-core-probe',
      input: { permissionMode: 'auto' },
    });
    let coreInvocations = 0;
    const executeCore = () =>
      application.executeCore({
        parsed: core,
        destinationId: 'conversation-settings-application',
        resourceId: core.command.scope.id,
        mutateBusinessState: () => {
          coreInvocations += 1;
          db.execute(`INSERT INTO conversation_command_probe (id, value) VALUES (?, ?)`, ['core', core.input.permissionMode]);
          return { acknowledged: true, permissionMode: core.input.permissionMode };
        },
      });
    const coreAccepted = executeCore();
    db.execute(`UPDATE conversation_command_probe SET value = 'later' WHERE id = 'core'`);
    const coreReplay = executeCore();
    observed.coreInvocations = coreInvocations;
    observed.coreReplay = coreReplay.replayed;
    observed.coreReplayPermissionMode = coreReplay.result.permissionMode;
    observed.coreCurrentValue = db.get<{ value: string }>(`SELECT value FROM conversation_command_probe WHERE id = 'core'`)?.value ?? null;

    const rollback = parsedRequest(application, {
      commandId: 'command_conversation_rollback_probe',
      commandType: conversationCommandTypes.collaborationModeUpdate,
      conversationId: 'conversation-rollback-probe',
      operationIdentity: 'conversation-operation-rollback-probe',
      input: { collaborationMode: 'plan' },
    });
    observed.rollbackError = captureCode(() =>
      application.executeCore({
        parsed: rollback,
        destinationId: 'conversation-settings-application',
        resourceId: rollback.command.scope.id,
        mutateBusinessState: () => {
          db.execute(`INSERT INTO conversation_command_probe (id, value) VALUES (?, ?)`, ['rollback', rollback.input.collaborationMode]);
          throw Object.assign(new Error('domain rejected'), { code: 'ZEUS_CONVERSATION_PROBE_REJECTED' });
        },
      }),
    );
    observed.rollbackBusinessRows = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM conversation_command_probe WHERE id = 'rollback'`)?.count ?? -1;
    observed.rollbackInboxRows = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [rollback.command.commandId])?.count ?? -1;
    const acceptedAfterRollback = application.executeCore({
      parsed: rollback,
      destinationId: 'conversation-settings-application',
      resourceId: rollback.command.scope.id,
      mutateBusinessState: () => {
        db.execute(`INSERT INTO conversation_command_probe (id, value) VALUES (?, ?)`, ['rollback', rollback.input.collaborationMode]);
        return { collaborationMode: rollback.input.collaborationMode };
      },
    });
    observed.acceptedAfterRollback = acceptedAfterRollback.result.collaborationMode;

    const rawCore = commandRequest({
      commandId: 'command_conversation_tampered_probe',
      commandType: conversationCommandTypes.permissionModeUpdate,
      conversationId: 'conversation-tampered-probe',
      operationIdentity: 'conversation-operation-tampered-probe',
      input: { permissionMode: 'read-only' },
    });
    observed.tamperedInput = captureCode(() =>
      application.parse({
        value: { ...rawCore, input: { permissionMode: 'full-access' } },
        commandType: conversationCommandTypes.permissionModeUpdate,
        conversationId: 'conversation-tampered-probe',
      }),
    );

    const concurrent = parsedRequest(application, {
      commandId: 'command_conversation_external_concurrent_probe',
      commandType: conversationCommandTypes.providerThreadRestore,
      conversationId: 'conversation-external-concurrent-probe',
      operationIdentity: 'conversation-operation-external-concurrent-probe',
      input: {},
    });
    let releaseConcurrent = (): void => undefined;
    const concurrentBarrier = new Promise<void>((resolve) => {
      releaseConcurrent = resolve;
    });
    let concurrentInvocations = 0;
    const concurrentInput = {
      parsed: concurrent,
      destinationId: 'conversation-provider-thread',
      resourceId: concurrent.command.scope.id,
      invoke: async () => {
        concurrentInvocations += 1;
        await concurrentBarrier;
        return { state: 'restored' };
      },
    };
    const firstConcurrent = application.executeExternal(concurrentInput);
    const duplicateConcurrent = application.executeExternal(concurrentInput);
    releaseConcurrent();
    const [concurrentAccepted, concurrentDuplicate] = await Promise.all([firstConcurrent, duplicateConcurrent]);
    observed.concurrentInvocations = concurrentInvocations;
    observed.concurrentResults = [concurrentAccepted.result.state, concurrentDuplicate.result.state];

    const accepted = externalRequest(application, 'accepted');
    let acceptedInvocations = 0;
    const acceptedOnce = await application.executeExternal({
      parsed: accepted,
      destinationId: 'conversation-provider-goal',
      resourceId: accepted.command.scope.id,
      invoke: async () => {
        acceptedInvocations += 1;
        return { status: 'active', objective: '不可变目标' };
      },
    });
    const acceptedReplay = await application.executeExternal({
      parsed: accepted,
      destinationId: 'conversation-provider-goal',
      resourceId: accepted.command.scope.id,
      invoke: async () => {
        acceptedInvocations += 1;
        return { status: 'must-not-run', objective: '错误目标' };
      },
    });
    observed.externalAccepted = acceptedOnce.result.objective;
    observed.externalReplay = acceptedReplay.replayed;
    observed.externalReplayObjective = acceptedReplay.result.objective;
    observed.externalAcceptedInvocations = acceptedInvocations;

    const beforeWrite = externalRequest(application, 'before-write');
    observed.failedBeforeWrite = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: beforeWrite,
        destinationId: 'conversation-provider-goal',
        resourceId: beforeWrite.command.scope.id,
        beforeWrite: async () => {
          throw Object.assign(new Error('preflight rejected'), { code: 'ZEUS_CONVERSATION_PROBE_PREFLIGHT' });
        },
        invoke: async () => ({ status: 'must-not-run' }),
      }),
    );
    const beforeWriteRetry = await application.executeExternal({
      parsed: beforeWrite,
      destinationId: 'conversation-provider-goal',
      resourceId: beforeWrite.command.scope.id,
      invoke: async () => ({ status: 'active' }),
    });
    observed.failedBeforeWriteOutcome = deliveries.get(beforeWrite.command.commandId)?.attempts[0]?.outcome ?? null;
    observed.failedBeforeWriteAttempts = deliveries.get(beforeWrite.command.commandId)?.attempts.length ?? 0;
    observed.failedBeforeWriteRetry = beforeWriteRetry.result.status;

    const explicit = externalRequest(application, 'explicit');
    observed.explicitFailure = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: explicit,
        destinationId: 'conversation-provider-goal',
        resourceId: explicit.command.scope.id,
        invoke: async () => {
          throw Object.assign(new Error(`provider rejected token=secret-probe ${'x'.repeat(4_096)}`), { code: 'ZEUS_CONVERSATION_PROBE_EXPLICIT', dispatchDisposition: 'runtime_rejected' as const });
        },
      }),
    );
    observed.explicitOutcome = deliveries.get(explicit.command.commandId)?.attempts.at(-1)?.outcome ?? null;
    const explicitEvidence = JSON.parse(deliveries.get(explicit.command.commandId)?.attempts.at(-1)?.receipt?.evidenceJson ?? '{}') as { error?: { message?: unknown } };
    const explicitErrorMessage = typeof explicitEvidence.error?.message === 'string' ? explicitEvidence.error.message : '';
    observed.explicitErrorRedacted = explicitErrorMessage.includes('[REDACTED]') && !explicitErrorMessage.includes('secret-probe');
    observed.explicitErrorBytes = Buffer.byteLength(explicitErrorMessage, 'utf8');

    const unknown = externalRequest(application, 'unknown');
    observed.unknownFailure = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: unknown,
        destinationId: 'conversation-provider-lifecycle',
        resourceId: unknown.command.scope.id,
        invoke: async () => {
          throw Object.assign(new Error('connection lost'), { code: 'ZEUS_CONVERSATION_PROBE_CONNECTION_LOST' });
        },
      }),
    );
    observed.unknownOutcome = deliveries.get(unknown.command.commandId)?.attempts.at(-1)?.outcome ?? null;
    observed.unknownReplay = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: unknown,
        destinationId: 'conversation-provider-lifecycle',
        resourceId: unknown.command.scope.id,
        invoke: async () => ({ status: 'must-not-run' }),
      }),
    );
    observed.quickCheck = db.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check ?? null;

    assertProbe(
      coreAccepted.replayed === false && coreInvocations === 1 && coreReplay.replayed && coreReplay.result.permissionMode === 'auto' && observed.coreCurrentValue === 'later',
      'Core mutation 与 accepted receipt 必须同事务，replay 返回不可变结果且不重做业务写',
    );
    assertProbe(
      observed.rollbackError === 'ZEUS_CONVERSATION_PROBE_REJECTED' && observed.rollbackBusinessRows === 0 && observed.rollbackInboxRows === 0 && observed.acceptedAfterRollback === 'plan',
      '领域拒绝必须整体回滚业务事实与命令账本，随后仍可首次接纳',
    );
    assertProbe(observed.tamperedInput === 'ZEUS_CONVERSATION_COMMAND_INVALID', '公开正文摘要不匹配必须在写入前拒绝');
    assertProbe(concurrentInvocations === 1 && concurrentAccepted.result.state === 'restored' && concurrentDuplicate.result.state === 'restored', '同进程并发重复 external command 必须折叠为一次写出');
    assertProbe(acceptedInvocations === 1 && acceptedReplay.replayed && acceptedReplay.result.objective === '不可变目标', 'accepted external replay 必须返回不可变结果且不得二次写出');
    assertProbe(
      observed.failedBeforeWrite === 'ZEUS_CONVERSATION_PROBE_PREFLIGHT' && observed.failedBeforeWriteOutcome === 'failed_before_write' && observed.failedBeforeWriteAttempts === 2 && observed.failedBeforeWriteRetry === 'active',
      'failed_before_write 必须允许安全 attempt 2',
    );
    assertProbe(
      observed.explicitFailure === 'ZEUS_CONVERSATION_PROBE_EXPLICIT' && observed.explicitOutcome === 'explicitly_rejected' && observed.explicitErrorRedacted === true && observed.explicitErrorBytes === 2_048,
      'Provider 明确拒绝必须形成 explicitly_rejected，且耐久错误脱敏并按 UTF-8 限长',
    );
    assertProbe(
      observed.unknownFailure === 'ZEUS_CONVERSATION_COMMAND_OUTCOME_UNKNOWN' && observed.unknownOutcome === 'outcome_unknown_after_write' && observed.unknownReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED',
      '写出后未知必须明确要求恢复并禁止自动重放',
    );
    assertProbe(observed.quickCheck === 'ok', '临时数据库 quick_check 必须通过');
  } finally {
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

function parsedRequest<TInput extends object>(
  application: ConversationCommandApplication,
  input: {
    commandId: string;
    commandType: ConversationCommandType;
    conversationId: string;
    operationIdentity: string;
    input: TInput;
  },
): ParsedConversationMutation<TInput> {
  const request = commandRequest(input);
  return application.parse<TInput>({ value: request, commandType: input.commandType, conversationId: input.conversationId });
}

function commandRequest<TInput extends object>(input: { commandId: string; commandType: ConversationCommandType; conversationId: string; operationIdentity: string; input: TInput }) {
  const command: CommandEnvelope<ConversationCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId: input.commandId,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'conversation-command-probe' },
    scope: { kind: 'product_conversation', id: input.conversationId },
    expectedRevision: null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: '2026-08-21T08:00:00.000Z',
    payload: { operationIdentity: input.operationIdentity, inputSha256: conversationInputSha256(input.input) },
  };
  return { command, input: input.input };
}

function externalRequest(application: ConversationCommandApplication, label: string) {
  return parsedRequest(application, {
    commandId: `command_conversation_external_${label}_probe`,
    commandType: conversationCommandTypes.goalSet,
    conversationId: `conversation-external-${label}-probe`,
    operationIdentity: `conversation-operation-external-${label}-probe`,
    input: { objective: `目标-${label}` },
  });
}

function captureCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

async function captureAsyncCode(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return error instanceof Error ? error.name : String(error);
}

function redactProbeText(value: string): { text: string } {
  return { text: value.replace(/(token=)[^\s]+/giu, '$1[REDACTED]') };
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Conversation Command 行为探针失败：${message}`);
}
