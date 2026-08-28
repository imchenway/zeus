import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '../packages/shared/src/index.js';
import { ArtifactStore, CommandDeliveryRepository, createZeusDatabase, type AppendAuditLogInput } from '../packages/storage/src/index.js';
import { GitCommandApplication, gitCommandInputSha256, gitCommandTypes, type GitCommandMutationRequest, type GitCommandPayload, type GitCommandType } from '../packages/local-server/src/gitCommandApplication.js';
import { GitConfirmationCapabilityService, registerGitCommandRoutes } from '../packages/local-server/src/gitCommandRoutes.js';
import type { ExecuteHighRiskGitOperationInput, ExecutedGitOperationResult, HighRiskGitOperation } from '../packages/git-core/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-git-command-probe-'));
const observed: Record<string, unknown> = {};
const gitProcessStarted = false;
let clockMs = Date.parse('2026-08-21T16:00:00.000Z');

interface ProbeHttpBody extends Record<string, unknown> {
  error?: string;
  id?: string;
  recoveryRequired?: boolean;
  status?: string;
  stdout?: string;
}

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const server = Fastify({ logger: false });
  try {
    const deliveries = new CommandDeliveryRepository(db);
    const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), () => now().toISOString(), { minimumFreeBytes: 0 });
    const application = new GitCommandApplication({ db, deliveries, artifacts, redactSensitiveText, now });
    const auditEntries: AppendAuditLogInput[] = [];
    let saveCalls = 0;
    let executionInvocations = 0;
    let unknownInvocations = 0;

    registerGitCommandRoutes({
      server,
      application,
      projectRoot: join(probeRoot, 'repository-that-must-not-be-opened'),
      projects: { getById: () => undefined },
      tasks: { getById: () => undefined },
      executeOperation: async (input) => {
        executionInvocations += 1;
        if (input.message === 'force-unknown') {
          unknownInvocations += 1;
          throw Object.assign(new Error(`/secret/repository: ${'sensitive-output '.repeat(512)}`), { code: 'ZEUS_GIT_PROBE_UNKNOWN' });
        }
        return fakeGitResult(input, 'x'.repeat(1_250_000));
      },
      redactSensitiveText,
      appendAuditLog: (input) => auditEntries.push({ ...input, createdAt: input.createdAt ?? now().toISOString() }),
      publishRealtimeEvent: () => undefined,
      save: async () => {
        saveCalls += 1;
        await db.save();
      },
      now,
      maximumConfirmations: 4,
      maximumConfirmationCommandReplays: 32,
      confirmationTtlMs: 10 * 60 * 1_000,
    });

    const confirmationCommandIds: string[] = [];
    const acceptedCapability = await createAndConfirm('accepted', 'commit', confirmationCommandIds);
    const acceptedExecution = commandRequest({
      label: 'accepted-execution',
      commandType: gitCommandTypes.operationExecute,
      scopeKind: 'git_repository',
      scopeId: 'primary',
      operationIdentity: 'git-operation-accepted',
      input: { confirmationId: acceptedCapability.id, operation: 'commit', message: 'probe accepted' },
    });
    const acceptedFirst = await post('/api/git/operations', acceptedExecution.body);
    const acceptedReplay = await post('/api/git/operations', acceptedExecution.body);
    const acceptedAttempt = requiredAttempt(deliveries, acceptedExecution.commandId);
    const acceptedArtifactEvidence = requireArtifactEvidence(acceptedAttempt.receipt.evidenceJson);
    observed.accepted = {
      firstStatus: acceptedFirst.statusCode,
      replayStatus: acceptedReplay.statusCode,
      immutableReplay: acceptedFirst.body.stdout === acceptedReplay.body.stdout,
      invocations: executionInvocations,
      receiptEvidenceBytes: Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8'),
      receiptOutcome: acceptedAttempt.receipt.outcome,
      artifactObjects: countRows('artifact_objects'),
      artifactContentBytes: acceptedArtifactEvidence.contentByteLength,
      artifactGeneration: acceptedArtifactEvidence.generationId,
    };

    const unknownCapability = await createAndConfirm('unknown', 'commit', confirmationCommandIds);
    const unknownExecution = commandRequest({
      label: 'unknown-execution',
      commandType: gitCommandTypes.operationExecute,
      scopeKind: 'git_repository',
      scopeId: 'primary',
      operationIdentity: 'git-operation-unknown',
      input: { confirmationId: unknownCapability.id, operation: 'commit', message: 'force-unknown' },
    });
    const unknownFirst = await post('/api/git/operations', unknownExecution.body);
    const unknownReplay = await post('/api/git/operations', unknownExecution.body);
    const unknownAttempt = requiredAttempt(deliveries, unknownExecution.commandId);
    const unknownEvidence = JSON.parse(unknownAttempt.receipt.evidenceJson) as { error?: { message?: string } };
    observed.unknown = {
      firstCode: unknownFirst.body.error,
      firstRecoveryRequired: unknownFirst.body.recoveryRequired,
      replayCode: unknownReplay.body.error,
      replayRecoveryRequired: unknownReplay.body.recoveryRequired,
      invocations: unknownInvocations,
      outcome: unknownAttempt.receipt.outcome,
      writeMarker: unknownAttempt.attempt.providerWriteStartedAt !== null,
      evidenceMessageBytes: Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8'),
      evidenceRedacted: !(unknownEvidence.error?.message ?? '').includes('/secret/repository'),
    };

    const consumedCapability = await createAndConfirm('consumed-before-marker', 'commit', confirmationCommandIds);
    const invalidExecution = commandRequest({
      label: 'invalid-before-marker',
      commandType: gitCommandTypes.operationExecute,
      scopeKind: 'git_repository',
      scopeId: 'primary',
      operationIdentity: 'git-operation-invalid-before-marker',
      input: { confirmationId: consumedCapability.id, operation: 'commit' },
    });
    const invocationCountBeforeInvalid = executionInvocations;
    const invalidFirst = await post('/api/git/operations', invalidExecution.body);
    const invalidFirstAttempt = requiredAttempt(deliveries, invalidExecution.commandId);
    const invalidReplay = await post('/api/git/operations', invalidExecution.body);
    const invalidSnapshot = deliveries.get(invalidExecution.commandId);
    observed.consumedBeforeMarker = {
      firstStatus: invalidFirst.statusCode,
      firstOutcome: invalidFirstAttempt.receipt.outcome,
      firstWriteMarker: invalidFirstAttempt.attempt.providerWriteStartedAt,
      replayCode: invalidReplay.body.error,
      attempts: invalidSnapshot?.attempts.length ?? 0,
      externalInvocations: executionInvocations - invocationCountBeforeInvalid,
    };

    const rejectedCreate = commandRequest({
      label: 'rejected-create',
      commandType: gitCommandTypes.confirmationCreate,
      scopeKind: 'approval',
      scopeId: 'git-confirmation-rejected',
      operationIdentity: 'git-confirmation-rejected',
      input: { operation: 'stash', reason: 'probe rejection' },
    });
    confirmationCommandIds.push(rejectedCreate.commandId);
    const rejectedCreated = await post('/api/git/confirmations', rejectedCreate.body);
    const rejectCommand = commandRequest({
      label: 'rejected-reject',
      commandType: gitCommandTypes.confirmationReject,
      scopeKind: 'approval',
      scopeId: rejectedCreated.body.id,
      operationIdentity: 'git-confirmation-reject-operation',
      input: { reason: 'operator declined' },
    });
    confirmationCommandIds.push(rejectCommand.commandId);
    const rejected = await post(`/api/git/confirmations/${encodeURIComponent(rejectedCreated.body.id)}/reject`, rejectCommand.body);
    const rejectedReplay = await post(`/api/git/confirmations/${encodeURIComponent(rejectedCreated.body.id)}/reject`, rejectCommand.body);
    observed.rejectedCapability = { status: rejected.body.status, replayStatus: rejectedReplay.body.status };

    const capacityCreate = commandRequest({
      label: 'capacity-create',
      commandType: gitCommandTypes.confirmationCreate,
      scopeKind: 'approval',
      scopeId: 'git-confirmation-capacity',
      operationIdentity: 'git-confirmation-capacity',
      input: { operation: 'push', reason: 'must fail closed at capacity' },
    });
    confirmationCommandIds.push(capacityCreate.commandId);
    const capacityRejected = await post('/api/git/confirmations', capacityCreate.body);
    observed.capacity = { status: capacityRejected.statusCode, code: capacityRejected.body.error };

    const boundedCapability = new GitConfirmationCapabilityService({ now, maximumConfirmations: 2, maximumRecentCommands: 2, replayTtlMs: 1_000 });
    for (let index = 0; index < 3; index += 1) {
      const parsed = application.parse({
        value: commandRequest({
          label: `bounded-${index}`,
          commandType: gitCommandTypes.confirmationCreate,
          scopeKind: 'approval',
          scopeId: `git-confirmation-bounded-${index}`,
          operationIdentity: `git-confirmation-bounded-${index}`,
          input: { operation: 'stash', reason: `bounded ${index}` },
        }).body,
        commandType: gitCommandTypes.confirmationCreate,
        scopeKind: 'approval',
        expectedScopeId: ({ operationIdentity }) => operationIdentity,
      });
      boundedCapability.execute(parsed, () => index);
    }
    const boundedBeforeExpiry = boundedCapability.snapshot();
    clockMs += 2_000;
    const boundedAfterExpiry = boundedCapability.snapshot();
    observed.boundedCapability = { beforeExpiry: boundedBeforeExpiry, afterExpiry: boundedAfterExpiry };

    observed.confirmationInboxRows = countInbox(confirmationCommandIds);
    observed.confirmationCommands = confirmationCommandIds.length;
    observed.auditEntries = auditEntries.length;
    observed.saveCalls = saveCalls;
    observed.gitProcessStarted = gitProcessStarted;
    observed.quickCheck = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? null;

    assertProbe(acceptedFirst.statusCode === 200 && acceptedReplay.statusCode === 200, 'accepted Git operation 与 replay 都必须成功。');
    assertProbe(typeof acceptedFirst.body.stdout === 'string' && acceptedFirst.body.stdout === acceptedReplay.body.stdout && acceptedFirst.body.stdout.length === 1_250_000, 'accepted replay 必须返回完整不可变大型结果。');
    assertProbe(executionInvocations === 2 && (observed.accepted as { invocations: number }).invocations === 1, 'accepted replay 不得二次执行，unknown 只允许一次调用。');
    assertProbe(Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8') < 16_384 && acceptedArtifactEvidence.contentByteLength > 1_000_000, '大型 Git 输出不得内联 receipt evidence。');
    assertProbe(countRows('artifact_objects') >= 1 && acceptedArtifactEvidence.generationId === 'git-command-result-v1', 'accepted Git 结果必须落内容寻址 ArtifactRef。');
    assertProbe(unknownFirst.body.error === 'ZEUS_GIT_COMMAND_OUTCOME_UNKNOWN' && unknownFirst.body.recoveryRequired === true, 'write marker 后异常必须返回 outcome unknown。');
    assertProbe(unknownReplay.body.error === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' && unknownReplay.body.recoveryRequired === true && unknownInvocations === 1, 'unknown Command 必须阻断自动重发。');
    assertProbe(unknownAttempt.receipt.outcome === 'outcome_unknown_after_write' && unknownAttempt.attempt.providerWriteStartedAt !== null, 'unknown 回执必须保留 write marker。');
    assertProbe(
      (unknownEvidence.error?.message ?? '').length > 0 && Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8') <= 2_048 && !(unknownEvidence.error?.message ?? '').includes('/secret/repository'),
      '错误 evidence 必须有界并脱敏。',
    );
    assertProbe(invalidFirstAttempt.receipt.outcome === 'failed_before_write' && invalidFirstAttempt.attempt.providerWriteStartedAt === null, '参数预检失败必须发生在 write marker 前。');
    assertProbe(invalidReplay.body.error === 'ZEUS_GIT_CONFIRMATION_ALREADY_CONSUMED' && executionInvocations === invocationCountBeforeInvalid, '确认必须在 marker 前一次消费，预检失败后也不得复用。');
    assertProbe(rejected.body.status === 'rejected' && rejectedReplay.body.status === 'rejected', '拒绝确认的同 Command replay 必须稳定。');
    assertProbe(capacityRejected.statusCode === 429 && capacityRejected.body.error === 'ZEUS_GIT_CONFIRMATION_CAPACITY_EXCEEDED', '确认能力达到容量时必须 fail closed。');
    assertProbe(boundedBeforeExpiry.recentCommands === 2 && boundedAfterExpiry.recentCommands === 0, '确认 Command replay 必须同时受容量与 TTL 限制。');
    assertProbe(countInbox(confirmationCommandIds) === 0, 'create/confirm/reject confirmation 不能写 Command Inbox/WAL。');
    assertProbe(gitProcessStarted === false, '行为 verifier 不得启动真实 Git 进程。');
    assertProbe(observed.quickCheck === 'ok', '临时 SQLite quick_check 必须通过。');

    console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

    async function createAndConfirm(label: string, operation: HighRiskGitOperation, commandIds: string[]): Promise<{ id: string }> {
      const confirmationId = `git-confirmation-${label}`;
      const create = commandRequest({
        label: `${label}-create`,
        commandType: gitCommandTypes.confirmationCreate,
        scopeKind: 'approval',
        scopeId: confirmationId,
        operationIdentity: confirmationId,
        input: { operation, reason: `probe ${label}` },
      });
      commandIds.push(create.commandId);
      const created = await post('/api/git/confirmations', create.body);
      assertProbe(created.statusCode === 201 && created.body.id === confirmationId, `${label} confirmation create 必须成功。`);
      const createReplay = await post('/api/git/confirmations', create.body);
      assertProbe(createReplay.statusCode === 200 && createReplay.body.id === confirmationId, `${label} confirmation create replay 必须稳定。`);

      const confirm = commandRequest({
        label: `${label}-confirm`,
        commandType: gitCommandTypes.confirmationConfirm,
        scopeKind: 'approval',
        scopeId: confirmationId,
        operationIdentity: `git-confirmation-${label}-confirm-operation`,
        input: {},
      });
      commandIds.push(confirm.commandId);
      const confirmed = await post(`/api/git/confirmations/${encodeURIComponent(confirmationId)}/confirm`, confirm.body);
      assertProbe(confirmed.statusCode === 200 && confirmed.body.status === 'confirmed', `${label} confirmation confirm 必须成功。`);
      const confirmReplay = await post(`/api/git/confirmations/${encodeURIComponent(confirmationId)}/confirm`, confirm.body);
      assertProbe(confirmReplay.statusCode === 200 && confirmReplay.body.status === 'confirmed', `${label} confirmation confirm replay 必须稳定。`);
      return { id: confirmationId };
    }

    async function post(path: string, body: unknown): Promise<{ statusCode: number; body: ProbeHttpBody }> {
      const response = await server.inject({ method: 'POST', url: path, payload: body });
      return { statusCode: response.statusCode, body: JSON.parse(response.body) as ProbeHttpBody };
    }

    function countRows(table: 'artifact_objects'): number {
      return db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? -1;
    }

    function countInbox(commandIds: string[]): number {
      if (commandIds.length === 0) return 0;
      const placeholders = commandIds.map(() => '?').join(', ');
      return db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id IN (${placeholders})`, commandIds)?.count ?? -1;
    }
  } finally {
    await server.close();
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

function now(): Date {
  return new Date(clockMs);
}

function redactSensitiveText(value: string): { text: string; redacted: boolean } {
  const text = value.replaceAll('/secret/repository', '[REDACTED_PATH]');
  return { text, redacted: text !== value };
}

function commandRequest<TInput extends object>(input: {
  label: string;
  commandType: GitCommandType;
  scopeKind: Extract<CommandScopeKind, 'approval' | 'git_repository'>;
  scopeId: string;
  operationIdentity: string;
  input: TInput;
}): { commandId: string; body: GitCommandMutationRequest<TInput> } {
  const commandId = `command_git_probe_${input.label}`;
  const payload: GitCommandPayload = { operationIdentity: input.operationIdentity, inputSha256: gitCommandInputSha256(input.input) };
  const command: CommandEnvelope<GitCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'git-command-probe' },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: now().toISOString(),
    payload,
  };
  assertProbe(gitCommandInputSha256(input.input) === createInputSha256(input.input), 'probe 与产品必须使用相同 canonical input SHA-256。');
  return { commandId, body: { command, input: input.input } };
}

function createInputSha256(value: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(value)).digest('hex');
}

function fakeGitResult(input: ExecuteHighRiskGitOperationInput, stdout: string): ExecutedGitOperationResult {
  return {
    operation: input.operation,
    cwd: input.confirmation.cwd,
    args: [input.operation, ...(input.message ? [input.message] : [])],
    stdout,
    stderr: '',
  };
}

function requiredAttempt(deliveries: CommandDeliveryRepository, commandId: string) {
  const snapshot = deliveries.get(commandId);
  const attempt = snapshot?.attempts.at(-1);
  const receipt = attempt?.receipt;
  assertProbe(snapshot && attempt && receipt, `Command ${commandId} 必须存在耐久 attempt/receipt。`);
  return { snapshot, attempt, receipt };
}

function requireArtifactEvidence(evidenceJson: string): { sha256: string; contentSha256: string; contentByteLength: number; generationId: string } {
  const evidence = JSON.parse(evidenceJson) as { resultArtifact?: Record<string, unknown> };
  const artifact = evidence.resultArtifact;
  assertProbe(
    artifact && typeof artifact.sha256 === 'string' && typeof artifact.contentSha256 === 'string' && typeof artifact.contentByteLength === 'number' && typeof artifact.generationId === 'string',
    'accepted receipt 必须只引用完整 ArtifactRef evidence。',
  );
  return artifact as { sha256: string; contentSha256: string; contentByteLength: number; generationId: string };
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
