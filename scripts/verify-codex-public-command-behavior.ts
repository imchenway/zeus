import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/index.js';
import { CodexPublicCommandApplicationService, codexPublicCommandScopeIds, codexPublicCommandTypes, type CodexPublicCommandPayload } from '../packages/local-server/src/codexPublicCommandApplication.js';
import { ArtifactStore, CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-codex-public-command-'));
const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
const deliveries = new CommandDeliveryRepository(db);
const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), () => clock());
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 7, 21, 15, 0, tick++)).toISOString();
const application = new CodexPublicCommandApplicationService({ db, deliveries, artifacts, now: () => new Date(clock()) });
const observed: Record<string, unknown> = {};

try {
  db.execute(`CREATE TABLE codex_public_probe_projection (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await db.save();

  const accepted = parseRequest('accepted', codexPublicCommandTypes.accountLoginStart, {});
  let acceptedInvocations = 0;
  const largeResult = { loginId: 'login-artifact-result', payload: 'x'.repeat(1_250_000) };
  const executeAccepted = () =>
    application.executeExternal({
      parsed: accepted,
      destinationId: 'codex:account',
      resourceId: codexPublicCommandScopeIds.account,
      invoke: async () => {
        acceptedInvocations += 1;
        return largeResult;
      },
    });
  const acceptedFirst = await executeAccepted();
  const acceptedReplay = await executeAccepted();
  const acceptedAttempt = requiredAttempt(accepted.command.commandId);
  observed.accepted = {
    replayed: acceptedReplay.replayed,
    invocations: acceptedInvocations,
    exactLargeResult: acceptedFirst.result.payload.length === acceptedReplay.result.payload.length,
    evidenceBytes: Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8'),
    artifactObjects: db.countRows('artifact_objects'),
  };

  const concurrent = parseRequest('concurrent', codexPublicCommandTypes.accountLoginStart, {});
  let concurrentInvocations = 0;
  let releaseConcurrent!: () => void;
  const concurrentGate = new Promise<void>((resolve) => {
    releaseConcurrent = resolve;
  });
  const concurrentExecute = () =>
    application.executeExternal({
      parsed: concurrent,
      destinationId: 'codex:account',
      resourceId: codexPublicCommandScopeIds.account,
      invoke: async () => {
        concurrentInvocations += 1;
        await concurrentGate;
        return { loginId: 'concurrent-login' };
      },
    });
  const concurrentOne = concurrentExecute();
  const concurrentTwo = concurrentExecute();
  releaseConcurrent();
  await Promise.all([concurrentOne, concurrentTwo]);
  observed.concurrentInvocations = concurrentInvocations;

  const unknown = parseRequest('unknown', codexPublicCommandTypes.remoteControlEnable, {});
  let unknownInvocations = 0;
  const executeUnknown = () =>
    application.executeExternal({
      parsed: unknown,
      destinationId: 'codex:remote-control',
      resourceId: codexPublicCommandScopeIds.remoteControl,
      invoke: async () => {
        unknownInvocations += 1;
        throw Object.assign(new Error('transport disconnected after request write'), { code: 'ZEUS_CODEX_RPC_TIMEOUT' });
      },
    });
  const unknownFirstCode = await captureCode(executeUnknown);
  const unknownReplayCode = await captureCode(executeUnknown);
  observed.unknown = { firstCode: unknownFirstCode, replayCode: unknownReplayCode, invocations: unknownInvocations, outcome: requiredAttempt(unknown.command.commandId).receipt.outcome };

  const explicit = parseRequest('explicit', codexPublicCommandTypes.remoteControlDisable, {});
  let explicitInvocations = 0;
  const explicitFirstCode = await captureCode(() =>
    application.executeExternal({
      parsed: explicit,
      destinationId: 'codex:remote-control',
      resourceId: codexPublicCommandScopeIds.remoteControl,
      invoke: async () => {
        explicitInvocations += 1;
        throw Object.assign(new Error('runtime rejected operation'), { code: -32602, dispatchDisposition: 'runtime_rejected' });
      },
    }),
  );
  const explicitFirst = requiredAttempt(explicit.command.commandId);
  const explicitRetry = await application.executeExternal({
    parsed: explicit,
    destinationId: 'codex:remote-control',
    resourceId: codexPublicCommandScopeIds.remoteControl,
    invoke: async () => {
      explicitInvocations += 1;
      return { status: 'disabled' };
    },
  });
  observed.explicit = {
    firstCode: explicitFirstCode,
    firstOutcome: explicitFirst.receipt.outcome,
    firstWriteMarker: explicitFirst.attempt.providerWriteStartedAt !== null,
    retryAccepted: explicitRetry.result.status,
    invocations: explicitInvocations,
    attempts: deliveries.get(explicit.command.commandId)?.attempts.length,
  };

  const beforeWrite = parseRequest('before-write', codexPublicCommandTypes.remoteControlPairingStart, {});
  let preflightAttempts = 0;
  const executeBeforeWrite = () =>
    application.executeExternal({
      parsed: beforeWrite,
      destinationId: 'codex:remote-control',
      resourceId: codexPublicCommandScopeIds.remoteControl,
      beforeWrite: async () => {
        preflightAttempts += 1;
        if (preflightAttempts === 1) throw Object.assign(new Error('remote control disabled'), { code: 'ZEUS_CODEX_REMOTE_CONTROL_DISABLED' });
      },
      invoke: async () => ({ pairingCode: 'pairing-code' }),
    });
  const beforeWriteCode = await captureCode(executeBeforeWrite);
  const beforeWriteFirst = requiredAttempt(beforeWrite.command.commandId);
  const beforeWriteRetry = await executeBeforeWrite();
  observed.beforeWrite = {
    code: beforeWriteCode,
    firstOutcome: beforeWriteFirst.receipt.outcome,
    firstWriteMarker: beforeWriteFirst.attempt.providerWriteStartedAt,
    retryResult: beforeWriteRetry.result.pairingCode,
    attempts: deliveries.get(beforeWrite.command.commandId)?.attempts.length,
  };

  const rollback = parseRequest('projection-rollback', codexPublicCommandTypes.configurationImport, {});
  const rollbackCode = await captureCode(() =>
    application.executeExternal({
      parsed: rollback,
      destinationId: 'filesystem:codex-configuration',
      resourceId: codexPublicCommandScopeIds.configuration,
      invoke: async () => ({ imported: ['config.toml'] }),
      mutateBusinessState: () => {
        db.execute(`INSERT INTO codex_public_probe_projection (id, value) VALUES ('rollback', 'must-not-commit')`);
        throw Object.assign(new Error('projection failed'), { code: 'ZEUS_CODEX_CONFIG_AUDIT_FAILED' });
      },
    }),
  );
  observed.rollback = {
    code: rollbackCode,
    outcome: requiredAttempt(rollback.command.commandId).receipt.outcome,
    projectionRows: db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM codex_public_probe_projection WHERE id = 'rollback'`)?.count ?? -1,
  };

  observed.quickCheck = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? null;
  assertBehavior(acceptedReplay.replayed && acceptedInvocations === 1 && acceptedReplay.result.payload === largeResult.payload, 'accepted 重试必须从 Artifact 返回完整不可变结果且不重复写出。');
  assertBehavior(acceptedAttempt.receipt.evidenceJson.length < 16_384, '大型结果不能内联进入 receipt evidence。');
  assertBehavior(concurrentInvocations === 1, '同进程并发重复 Command 必须合并为一次外部调用。');
  assertBehavior(unknownFirstCode === 'ZEUS_CODEX_RPC_TIMEOUT' && unknownReplayCode === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' && unknownInvocations === 1, 'write marker 后未知结果必须阻断重发。');
  assertBehavior(
    explicitFirst.receipt.outcome === 'explicitly_rejected' && explicitFirst.attempt.providerWriteStartedAt !== null && explicitInvocations === 2 && explicitRetry.result.status === 'disabled',
    '只有 Runtime 明确拒绝才可安全建立下一 attempt。',
  );
  assertBehavior(beforeWriteFirst.receipt.outcome === 'failed_before_write' && beforeWriteFirst.attempt.providerWriteStartedAt === null && beforeWriteRetry.result.pairingCode === 'pairing-code', '写出前失败必须可安全重试。');
  assertBehavior(
    observed.rollback && (observed.rollback as { outcome: string }).outcome === 'outcome_unknown_after_write' && (observed.rollback as { projectionRows: number }).projectionRows === 0,
    '业务投影与 accepted receipt 必须原子回滚，并保守进入 unknown。',
  );
  assertBehavior(observed.quickCheck === 'ok', '临时数据库 quick_check 必须通过。');
  console.log(JSON.stringify({ status: 'passed', observed }, null, 2));
} finally {
  await db.close();
  await rm(probeRoot, { recursive: true, force: true });
}

function parseRequest<TInput extends object>(label: string, commandType: (typeof codexPublicCommandTypes)[keyof typeof codexPublicCommandTypes], input: TInput) {
  const operationIdentity = `codex-public-${label}`;
  const inputSha256 = createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
  const scope = commandType.startsWith('codex.account.')
    ? ({ kind: 'provider_account', id: codexPublicCommandScopeIds.account } as const)
    : commandType.startsWith('codex.remote_control.')
      ? ({ kind: 'provider_remote_control', id: codexPublicCommandScopeIds.remoteControl } as const)
      : ({ kind: 'provider_configuration', id: codexPublicCommandScopeIds.configuration } as const);
  const command: CommandEnvelope<CodexPublicCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId: `command_codex_public_probe_${label}`,
    commandType,
    actor: { kind: 'local_api', id: 'codex-public-command-probe' },
    scope,
    expectedRevision: null,
    idempotencyKey: `${commandType}:${operationIdentity}`,
    issuedAt: '2026-08-21T15:00:00.000Z',
    payload: { operationIdentity, inputSha256 },
  };
  return application.parse<TInput>({ value: { command, input }, commandType, scopeKind: scope.kind, scopeId: scope.id });
}

function requiredAttempt(commandId: string) {
  const snapshot = deliveries.get(commandId);
  const attempt = snapshot?.attempts.at(-1);
  const receipt = attempt?.receipt;
  assertBehavior(snapshot && attempt && receipt, `缺少 Command ${commandId} 的耐久 attempt/receipt。`);
  return { snapshot, attempt, receipt };
}

async function captureCode(operation: () => Promise<unknown>): Promise<string | number | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : error instanceof Error ? error.name : null;
  }
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
