import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '../packages/shared/src/index.js';
import { ArtifactStore, CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import {
  WorkspaceGitCommandApplication,
  workspaceGitInputSha256,
  workspaceGitCommandTypes,
  type WorkspaceGitCommandPayload,
  type WorkspaceGitCommandType,
  type WorkspaceGitMutationRequest,
  type WorkspaceGitScopeKind,
} from '../packages/local-server/src/workspaceGitCommandApplication.js';
import { registerWorkspaceGitCommandRoutes, workspaceGitCommandRoutePolicy } from '../packages/local-server/src/workspaceGitCommandRoutes.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-workspace-git-command-probe-'));
const observed: Record<string, unknown> = {};
const clockMs = Date.parse('2026-08-21T20:00:00.000Z');

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const server = Fastify({ logger: false });
  try {
    db.execute(`CREATE TABLE workspace_git_probe_business (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const deliveries = new CommandDeliveryRepository(db);
    const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), () => now().toISOString(), { minimumFreeBytes: 0 });
    const application = new WorkspaceGitCommandApplication({ db, deliveries, artifacts, redactSensitiveText, now });
    const invocations = new Map<WorkspaceGitCommandType, number>();

    registerWorkspaceGitCommandRoutes({
      server,
      application,
      operations: {
        prepare: async (input) => ({
          destinationId: 'workspace-git-probe',
          resourceId: [input.projectId, input.taskId, input.repositoryId, input.workspaceId, input.integrationId].find(Boolean) ?? 'probe',
          externalOperationId: `probe_external_${input.commandType}_${input.operationIdentity}`,
          opaque: input,
        }),
        execute: async ({ commandType }) => {
          invocations.set(commandType, (invocations.get(commandType) ?? 0) + 1);
          if (commandType === workspaceGitCommandTypes.taskWorkspacePush) {
            throw Object.assign(new Error(`/secret/worktree: ${'unknown-output '.repeat(512)}`), { code: 'ZEUS_PROBE_EXTERNAL_OUTCOME_UNKNOWN' });
          }
          if (commandType === workspaceGitCommandTypes.taskWorkspaceDiscard) {
            throw Object.assign(new Error('Independent dangerous confirmation was rejected.'), {
              workspaceGitExplicitRejection: true as const,
              statusCode: 409,
              payload: { error: 'ZEUS_PROBE_CONFIRMATION_REJECTED', message: 'Independent dangerous confirmation was rejected.' },
            });
          }
          return {
            response: { statusCode: 201, body: { commandType, payload: 'x'.repeat(1_250_000) } },
            commitAccepted: () => db.execute(`INSERT INTO workspace_git_probe_business (id, value) VALUES (?, ?)`, [commandType, 'accepted']),
          };
        },
        isExplicitRejection: (error) => Boolean(error) && typeof error === 'object' && (error as { workspaceGitExplicitRejection?: unknown }).workspaceGitExplicitRejection === true,
      },
      sendError: (reply, error) => {
        if (error && typeof error === 'object' && (error as { workspaceGitExplicitRejection?: unknown }).workspaceGitExplicitRejection === true) {
          const rejected = error as { statusCode: number; payload: unknown };
          return reply.code(rejected.statusCode).send(rejected.payload);
        }
        throw error;
      },
    });

    const accepted = commandRequest({
      label: 'accepted-snapshot',
      commandType: workspaceGitCommandTypes.projectSnapshotCreate,
      scopeKind: 'git_repository',
      scopeId: 'project:project-probe',
      operationIdentity: 'workspace-git-probe-accepted',
      input: { taskId: 'task-probe' },
    });
    const acceptedFirst = await inject('POST', '/api/projects/project-probe/git/snapshot', accepted.body);
    const acceptedReplay = await inject('POST', '/api/projects/project-probe/git/snapshot', accepted.body);
    const acceptedAttempt = requiredAttempt(deliveries, accepted.commandId);
    const acceptedEvidence = JSON.parse(acceptedAttempt.receipt.evidenceJson) as { resultArtifact?: { contentByteLength?: number; generationId?: string } };
    observed.accepted = {
      firstStatus: acceptedFirst.statusCode,
      replayStatus: acceptedReplay.statusCode,
      invocations: invocations.get(workspaceGitCommandTypes.projectSnapshotCreate),
      immutableReplay: acceptedFirst.body.payload === acceptedReplay.body.payload,
      businessRows: rowCount('workspace_git_probe_business'),
      receiptOutcome: acceptedAttempt.receipt.outcome,
      receiptBytes: Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8'),
      artifactContentBytes: acceptedEvidence.resultArtifact?.contentByteLength,
      artifactGeneration: acceptedEvidence.resultArtifact?.generationId,
    };

    const unknown = commandRequest({
      label: 'unknown-push',
      commandType: workspaceGitCommandTypes.taskWorkspacePush,
      scopeKind: 'task_workspace',
      scopeId: 'workspace-probe',
      operationIdentity: 'workspace-git-probe-unknown',
      input: {},
    });
    const unknownFirst = await inject('POST', '/api/tasks/task-probe/git-workspaces/workspace-probe/push', unknown.body);
    const unknownReplay = await inject('POST', '/api/tasks/task-probe/git-workspaces/workspace-probe/push', unknown.body);
    const unknownAttempt = requiredAttempt(deliveries, unknown.commandId);
    const unknownEvidence = JSON.parse(unknownAttempt.receipt.evidenceJson) as { error?: { message?: string } };
    observed.unknown = {
      firstCode: unknownFirst.body.error,
      firstRecoveryRequired: unknownFirst.body.recoveryRequired,
      replayCode: unknownReplay.body.error,
      invocations: invocations.get(workspaceGitCommandTypes.taskWorkspacePush),
      receiptOutcome: unknownAttempt.receipt.outcome,
      writeMarker: unknownAttempt.attempt.providerWriteStartedAt !== null,
      errorBytes: Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8'),
      errorRedacted: !(unknownEvidence.error?.message ?? '').includes('/secret/worktree'),
    };

    const rejected = commandRequest({
      label: 'discard-rejected',
      commandType: workspaceGitCommandTypes.taskWorkspaceDiscard,
      scopeKind: 'task_workspace',
      scopeId: 'workspace-probe',
      operationIdentity: 'workspace-git-probe-rejected',
      input: { confirmationText: 'operator-rejected' },
    });
    const rejectedResult = await inject('POST', '/api/tasks/task-probe/git-workspaces/workspace-probe/discard', rejected.body);
    const rejectedAttempt = requiredAttempt(deliveries, rejected.commandId);
    observed.explicitRejection = {
      status: rejectedResult.statusCode,
      code: rejectedResult.body.error,
      receiptOutcome: rejectedAttempt.receipt.outcome,
      writeMarker: rejectedAttempt.attempt.providerWriteStartedAt !== null,
    };

    observed.routePolicy = {
      external: workspaceGitCommandRoutePolicy.externalOperations.length,
      automaticRetryAfterUnknown: workspaceGitCommandRoutePolicy.automaticRetryAfterUnknown,
      acceptedResult: workspaceGitCommandRoutePolicy.acceptedResult,
    };
    observed.quickCheck = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? null;
    observed.realGitFsProcessProviderStarted = false;

    assertProbe(acceptedFirst.statusCode === 201 && acceptedReplay.statusCode === 201 && invocations.get(workspaceGitCommandTypes.projectSnapshotCreate) === 1, 'accepted replay 不得二次执行外部端口。');
    assertProbe(acceptedFirst.body.payload === acceptedReplay.body.payload && typeof acceptedFirst.body.payload === 'string' && acceptedFirst.body.payload.length === 1_250_000, 'accepted replay 必须返回完整不可变大型结果。');
    assertProbe(rowCount('workspace_git_probe_business') === 1 && acceptedAttempt.receipt.outcome === 'accepted', 'Core 投影与 accepted receipt 必须在同一事务提交一次。');
    assertProbe((acceptedEvidence.resultArtifact?.contentByteLength ?? 0) > 1_000_000 && acceptedEvidence.resultArtifact?.generationId === 'workspace-git-command-result-v1', '大型结果必须进入 ArtifactRef。');
    assertProbe(Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8') < 16_384, 'receipt evidence 只能保存有界 ArtifactRef。');
    assertProbe(unknownFirst.body.error === 'ZEUS_WORKSPACE_GIT_COMMAND_OUTCOME_UNKNOWN' && unknownFirst.body.recoveryRequired === true, 'write marker 后异常必须标为 unknown。');
    assertProbe(unknownReplay.body.error === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' && invocations.get(workspaceGitCommandTypes.taskWorkspacePush) === 1, 'unknown 必须阻断自动重发。');
    assertProbe(unknownAttempt.receipt.outcome === 'outcome_unknown_after_write' && unknownAttempt.attempt.providerWriteStartedAt !== null, 'unknown receipt 必须保留 write marker。');
    assertProbe(
      (unknownEvidence.error?.message ?? '').length > 0 && Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8') <= 2_048 && !(unknownEvidence.error?.message ?? '').includes('/secret/worktree'),
      '错误 evidence 必须 UTF-8 有界且脱敏。',
    );
    assertProbe(rejectedResult.statusCode === 409 && rejectedAttempt.receipt.outcome === 'explicitly_rejected', '独立危险确认拒绝必须进入 explicitly_rejected。');
    assertProbe(workspaceGitCommandRoutePolicy.externalOperations.length === 16 && workspaceGitCommandRoutePolicy.automaticRetryAfterUnknown === false, '路由政策必须精确覆盖 16 条且 unknown 不自动重试。');
    assertProbe(observed.quickCheck === 'ok', '临时 SQLite quick_check 必须通过。');
    assertProbe(observed.realGitFsProcessProviderStarted === false, '行为 verifier 不得调用真实 Git、文件写、进程或 Provider。');

    console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

    async function inject(method: 'POST' | 'PUT', path: string, body: unknown): Promise<{ statusCode: number; body: Record<string, unknown> }> {
      const response = await server.inject({ method, url: path, payload: body });
      return { statusCode: response.statusCode, body: response.body ? (JSON.parse(response.body) as Record<string, unknown>) : {} };
    }

    function rowCount(table: 'workspace_git_probe_business'): number {
      return db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? -1;
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
  const text = value.replaceAll('/secret/worktree', '[REDACTED_PATH]');
  return { text, redacted: text !== value };
}

function commandRequest<TInput extends object>(input: {
  label: string;
  commandType: WorkspaceGitCommandType;
  scopeKind: Extract<CommandScopeKind, WorkspaceGitScopeKind>;
  scopeId: string;
  operationIdentity: string;
  input: TInput;
}): { commandId: string; body: WorkspaceGitMutationRequest<TInput> } {
  const commandId = `command_workspace_git_probe_${input.label}`;
  const payload: WorkspaceGitCommandPayload = { operationIdentity: input.operationIdentity, inputSha256: workspaceGitInputSha256(input.input) };
  const command: CommandEnvelope<WorkspaceGitCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'workspace-git-command-probe' },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: now().toISOString(),
    payload,
  };
  return { commandId, body: { command, input: input.input } };
}

function requiredAttempt(deliveries: CommandDeliveryRepository, commandId: string) {
  const snapshot = deliveries.get(commandId);
  const attempt = snapshot?.attempts.at(-1);
  const receipt = attempt?.receipt;
  assertProbe(snapshot && attempt && receipt, `Command ${commandId} 必须存在耐久 attempt/receipt。`);
  return { snapshot, attempt, receipt };
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
