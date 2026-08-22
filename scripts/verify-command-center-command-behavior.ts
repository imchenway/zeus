import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, CommandDefinitionRepository, CommandDeliveryRepository, CommandDeliveryStoreError, ProjectRepository, RuntimeSessionRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import { createCommandCenter } from '../packages/local-server/src/commandCenter.js';
import { CommandCenterCommandApplication, commandCenterCommandTypes, createCommandCenterCommandRequest } from '../packages/local-server/src/commandCenterCommandApplication.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-command-center-command-probe-'));
const observed: Record<string, unknown> = {};
let applicationReference: CommandCenterCommandApplication | undefined;

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  try {
    db.execute(`CREATE TABLE command_center_probe_events (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const deliveries = new CommandDeliveryRepository(db);
    const definitions = new CommandDefinitionRepository(db);
    let clock = Date.parse('2026-08-21T02:00:00.000Z');
    const application = new CommandCenterCommandApplication({ db, deliveries, now: () => new Date((clock += 1_000)) });
    applicationReference = application;

    const definitionId = 'command_definition_probe_create';
    const definitionInput = {
      name: 'probe-command',
      title: 'Command Center probe',
      command: 'printf probe',
      timeoutSeconds: 30,
      enabled: true,
      telegramEnabled: false,
    };
    const createRequest = createCommandCenterCommandRequest({
      commandType: commandCenterCommandTypes.definitionCreate,
      actor: { kind: 'local_api', id: 'command-center-probe' },
      scope: { kind: 'command_definition', id: `global:${definitionId}` },
      expectedRevision: null,
      operationIdentity: definitionId,
      value: definitionInput,
    });
    const parsedCreate = application.parse<typeof definitionInput>({
      value: createRequest,
      commandType: commandCenterCommandTypes.definitionCreate,
      scopeKind: 'command_definition',
      expectedScopeId: ({ operationIdentity }) => `global:${operationIdentity}`,
    });
    const create = () =>
      application.executeCore({
        parsed: parsedCreate,
        destinationId: 'command-center-definition-application',
        resourceId: definitionId,
        mutateBusinessState: () => definitions.create({ ...definitionInput, id: definitionId, scope: 'global', projectId: null }),
      });
    const created = create();
    const createReplay = create();
    observed.coreCreatedId = created.result.id;
    observed.coreReplay = createReplay.replayed;
    observed.coreDefinitionRows = db.countRows('command_definitions');
    observed.coreLedger = ledgerCounts(db);

    const operationCollisionRequest = createCommandCenterCommandRequest({
      commandType: commandCenterCommandTypes.definitionUpdate,
      actor: { kind: 'local_api', id: 'command-center-probe' },
      scope: { kind: 'command_definition', id: definitionId },
      expectedRevision: 1,
      operationIdentity: definitionId,
      value: { title: 'must not apply' },
    });
    const operationCollision = application.parse<{ title: string }>({
      value: operationCollisionRequest,
      commandType: commandCenterCommandTypes.definitionUpdate,
      scopeKind: 'command_definition',
      expectedScopeId: () => definitionId,
    });
    observed.sameOperationDifferentCommand = captureCode(() =>
      application.executeCore({
        parsed: operationCollision,
        destinationId: 'command-center-definition-application',
        resourceId: definitionId,
        mutateBusinessState: () => definitions.update(definitionId, { ...definitionInput, title: 'must not apply', revision: 2 }),
      }),
    );
    observed.titleAfterOperationCollision = definitions.getById(definitionId)?.title ?? null;

    const rejectedOperationIdentity = 'command_definition_probe_rejected';
    const rejectedRequest = createCommandCenterCommandRequest({
      commandType: commandCenterCommandTypes.definitionCreate,
      actor: { kind: 'local_api', id: 'command-center-probe' },
      scope: { kind: 'command_definition', id: `global:${rejectedOperationIdentity}` },
      expectedRevision: null,
      operationIdentity: rejectedOperationIdentity,
      value: { reason: 'domain rejection' },
    });
    const parsedRejected = application.parse<{ reason: string }>({
      value: rejectedRequest,
      commandType: commandCenterCommandTypes.definitionCreate,
      scopeKind: 'command_definition',
      expectedScopeId: ({ operationIdentity }) => `global:${operationIdentity}`,
    });
    observed.domainRejection = captureCode(() =>
      application.executeCore({
        parsed: parsedRejected,
        destinationId: 'command-center-definition-application',
        resourceId: rejectedOperationIdentity,
        mutateBusinessState: () => {
          db.execute(`INSERT INTO command_center_probe_events (id, value) VALUES (?, ?)`, ['domain-rejection-write', 'must rollback']);
          throw Object.assign(new Error('domain rejected'), { code: 'ZEUS_COMMAND_CENTER_DOMAIN_REJECTED' });
        },
      }),
    );
    observed.domainRejectionBusinessRows = countEvent(db, 'domain-rejection-write');
    observed.domainRejectionInboxRows = countInbox(db, parsedRejected.command.commandId);

    const unsafeRunScopeRequest = createCommandCenterCommandRequest({
      commandType: commandCenterCommandTypes.runStart,
      actor: { kind: 'local_api', id: 'command-center-probe' },
      scope: { kind: 'command_run', id: '../../command-run-escape' },
      expectedRevision: null,
      operationIdentity: 'command_run_operation_unsafe_scope',
      value: { runId: '../../command-run-escape' },
    });
    observed.unsafeRunScope = captureCode(() =>
      application.parse({
        value: unsafeRunScopeRequest,
        commandType: commandCenterCommandTypes.runStart,
        scopeKind: 'command_run',
      }),
    );

    const acceptedBeforeMarker = externalRequest('accepted-before-marker', 'command_run_probe_marker_required');
    const acceptedBeforeMarkerPreparation = application.prepareExternal<{ runId: string }, { status: string }>({
      parsed: acceptedBeforeMarker.parsed,
      destinationId: 'command-center-runtime',
      resourceId: acceptedBeforeMarker.runId,
      externalOperationId: acceptedBeforeMarker.externalOperationId,
    });
    assertProbe(acceptedBeforeMarkerPreparation.state === 'prepared', 'write marker 探针首次必须 prepared');
    observed.acceptedBeforeWriteMarker = captureCode(() =>
      application.resolveExternal({
        preparation: acceptedBeforeMarkerPreparation,
        outcome: 'accepted',
        evidence: { invalidBoundary: true },
        mutateBusinessState: () => {
          insertEvent(db, 'accepted-before-marker-must-not-mutate');
          return { status: 'running' };
        },
      }),
    );
    observed.acceptedBeforeWriteMarkerMutationRows = countEvent(db, 'accepted-before-marker-must-not-mutate');

    const acceptedExternal = externalRequest('accepted', 'command_run_probe_accepted');
    const acceptedPreparation = application.prepareExternal<{ runId: string }, { status: string }>({
      parsed: acceptedExternal.parsed,
      destinationId: 'command-center-runtime',
      resourceId: acceptedExternal.runId,
      externalOperationId: acceptedExternal.externalOperationId,
      mutatePreparedBusinessState: () => insertEvent(db, 'accepted-prepared'),
    });
    assertProbe(acceptedPreparation.state === 'prepared', '首次 external command 必须进入 prepared');
    application.markExternalWriteStarted(acceptedPreparation);
    const acceptedResult = application.resolveExternal({
      preparation: acceptedPreparation,
      outcome: 'accepted',
      evidence: { nativeRuntimeSessionId: 'runtime-probe-accepted' },
      mutateBusinessState: () => {
        insertEvent(db, 'accepted-business');
        return { status: 'running' };
      },
    });
    const acceptedReplay = application.prepareExternal<{ runId: string }, { status: string }>({
      parsed: acceptedExternal.parsed,
      destinationId: 'command-center-runtime',
      resourceId: acceptedExternal.runId,
      externalOperationId: acceptedExternal.externalOperationId,
      mutatePreparedBusinessState: () => insertEvent(db, 'accepted-replay-must-not-mutate'),
    });
    observed.externalAccepted = acceptedResult.result.status;
    observed.externalAcceptedReplay = acceptedReplay.state === 'accepted_replay' ? acceptedReplay.acceptedReplayResult.status : null;
    observed.externalAcceptedMutationRows = countEvent(db, 'accepted-business');
    observed.externalAcceptedReplayMutationRows = countEvent(db, 'accepted-replay-must-not-mutate');

    const externalIdentityCollision = externalRequest('accepted-collision', 'command_run_probe_accepted_collision');
    observed.sameExternalOperationDifferentCommand = captureCode(() =>
      application.prepareExternal({
        parsed: externalIdentityCollision.parsed,
        destinationId: 'command-center-runtime',
        resourceId: externalIdentityCollision.runId,
        externalOperationId: acceptedExternal.externalOperationId,
      }),
    );

    const beforeWrite = externalRequest('before-write', 'command_run_probe_before_write');
    const beforeWriteAttemptOne = application.prepareExternal<{ runId: string }, { status: string }>({
      parsed: beforeWrite.parsed,
      destinationId: 'command-center-runtime',
      resourceId: beforeWrite.runId,
      externalOperationId: beforeWrite.externalOperationId,
    });
    assertProbe(beforeWriteAttemptOne.state === 'prepared', '写出前失败探针首次必须 prepared');
    application.resolveExternal({
      preparation: beforeWriteAttemptOne,
      outcome: 'failed_before_write',
      evidence: { boundary: 'before_write_marker' },
      mutateBusinessState: () => ({ status: 'retryable' }),
    });
    const beforeWriteAttemptTwo = application.prepareExternal<{ runId: string }, { status: string }>({
      parsed: beforeWrite.parsed,
      destinationId: 'command-center-runtime',
      resourceId: beforeWrite.runId,
      externalOperationId: beforeWrite.externalOperationId,
    });
    observed.beforeWriteRetryAttempt = beforeWriteAttemptTwo.outbox.attempt;
    observed.beforeWriteRetryCreated = beforeWriteAttemptTwo.state === 'prepared' && !beforeWriteAttemptTwo.replayedPreparation;

    const explicitRejection = externalRequest('explicit-rejection', 'command_run_probe_explicit_rejection');
    const explicitPreparation = application.prepareExternal<{ runId: string }, { status: string }>({
      parsed: explicitRejection.parsed,
      destinationId: 'command-center-runtime',
      resourceId: explicitRejection.runId,
      externalOperationId: explicitRejection.externalOperationId,
    });
    assertProbe(explicitPreparation.state === 'prepared', '明确拒绝探针首次必须 prepared');
    application.resolveExternal({
      preparation: explicitPreparation,
      outcome: 'explicitly_rejected',
      evidence: { reason: 'domain rejected before external write' },
      mutateBusinessState: () => ({ status: 'rejected' }),
    });
    const explicitSnapshot = deliveries.get(explicitRejection.parsed.command.commandId)?.attempts.at(-1);
    observed.explicitRejectionOutcome = explicitSnapshot?.outcome ?? null;
    observed.explicitRejectionWriteMarker = explicitSnapshot?.providerWriteStartedAt ?? null;

    const unknownExternal = externalRequest('unknown', 'command_run_probe_unknown');
    const unknownPreparation = application.prepareExternal<{ runId: string }, { status: string }>({
      parsed: unknownExternal.parsed,
      destinationId: 'command-center-runtime',
      resourceId: unknownExternal.runId,
      externalOperationId: unknownExternal.externalOperationId,
    });
    assertProbe(unknownPreparation.state === 'prepared', 'unknown 探针首次必须 prepared');
    application.markExternalWriteStarted(unknownPreparation);
    application.resolveExternal({
      preparation: unknownPreparation,
      outcome: 'outcome_unknown_after_write',
      evidence: { boundary: 'after_write_marker' },
      mutateBusinessState: () => ({ status: 'starting' }),
    });
    observed.unknownReplay = captureCode(() =>
      application.prepareExternal({
        parsed: unknownExternal.parsed,
        destinationId: 'command-center-runtime',
        resourceId: unknownExternal.runId,
        externalOperationId: unknownExternal.externalOperationId,
      }),
    );
    db.execute(
      `INSERT INTO command_runs
        (id, command_id, project_id, runtime_session_id, trigger, status, command_snapshot_json, parameter_snapshot_json, cwd, timeout_seconds, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ui', 'running', '{}', '{}', ?, 30, ?, ?)`,
      ['command_run_read_only_close_probe', 'command_read_only_close_probe', 'project_read_only_close_probe', 'runtime_formal_history_must_not_be_killed', probeRoot, '2026-08-21T02:30:00.000Z', '2026-08-21T02:30:00.000Z'],
    );
    const forbiddenValidationRuntimeCalls: string[] = [];
    const forbiddenValidationCapabilityRevocations: string[] = [];
    const fakeServer = new Proxy(
      {},
      {
        get: () => () => fakeServer,
      },
    );
    const readOnlyCommandCenter = createCommandCenter({
      server: fakeServer as never,
      db,
      commandDeliveries: deliveries,
      artifactStore: new ArtifactStore(db, join(probeRoot, 'read-only-artifacts'), () => '2026-08-21T02:30:00.000Z', { minimumFreeBytes: 0 }),
      projects: new ProjectRepository(db),
      runtimeSessions: new RuntimeSessionRepository(db),
      aiRuntimeManager: new Proxy(
        {},
        {
          get:
            (_target, property) =>
            () => {
              forbiddenValidationRuntimeCalls.push(String(property));
              throw new Error(`只读关闭触发了禁止的 Runtime 调用：${String(property)}`);
            },
        },
      ) as never,
      commandScriptsDirectory: join(probeRoot, 'read-only-command-scripts'),
      commandRunsDirectory: join(probeRoot, 'read-only-command-runs'),
      readProjectSecurity: () => ({ allowShell: false, allowGitWrite: false }),
      buildRuntimeProcessEnv: () => ({}),
      revokeReleaseNotesCapability: (runId) => forbiddenValidationCapabilityRevocations.push(runId),
      appendAuditLog: () => undefined,
      publishRealtimeEvent: () => undefined,
      save: () => db.save(),
      now: () => new Date('2026-08-21T02:30:00.000Z'),
      readOnlyValidation: true,
    });
    readOnlyCommandCenter.close();
    observed.readOnlyCloseRuntimeCalls = forbiddenValidationRuntimeCalls;
    observed.readOnlyCloseCapabilityRevocations = forbiddenValidationCapabilityRevocations;
    observed.readOnlyClosePreservedCopiedRun = db.get<{ status: string }>(`SELECT status FROM command_runs WHERE id = 'command_run_read_only_close_probe'`)?.status ?? null;
    observed.quickCheck = db.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check ?? null;

    assertProbe(created.result.id === definitionId && createReplay.replayed && observed.coreDefinitionRows === 1, 'Core create replay 必须返回同一结果且只 mutation 一次');
    assertProbe(observed.sameOperationDifferentCommand === 'ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT' && observed.titleAfterOperationCollision === definitionInput.title, '同 operation identity 的不同 Command 必须冲突且不修改业务事实');
    assertProbe(observed.domainRejection === 'ZEUS_COMMAND_CENTER_DOMAIN_REJECTED' && observed.domainRejectionBusinessRows === 0 && observed.domainRejectionInboxRows === 0, '领域拒绝必须整体回滚 Inbox/Outbox/业务 mutation');
    assertProbe(observed.unsafeRunScope === 'ZEUS_COMMAND_CENTER_COMMAND_INVALID', 'Command run scope 必须拒绝可逃逸运行目录的身份');
    assertProbe(observed.acceptedBeforeWriteMarker === 'ZEUS_COMMAND_DELIVERY_STATE_CONFLICT' && observed.acceptedBeforeWriteMarkerMutationRows === 0, '外部操作不得在耐久 write marker 前记录 accepted 或修改业务事实');
    assertProbe(
      observed.externalAccepted === 'running' && observed.externalAcceptedReplay === 'running' && observed.externalAcceptedMutationRows === 1 && observed.externalAcceptedReplayMutationRows === 0,
      '外部 accepted replay 必须返回不可变结果且不二次写出',
    );
    assertProbe(observed.sameExternalOperationDifferentCommand === 'ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT', '不同 Command 不能复用稳定 external operation identity');
    assertProbe(observed.beforeWriteRetryAttempt === 2 && observed.beforeWriteRetryCreated === true, '确证写出前失败必须允许同一 Command 创建安全 attempt 2');
    assertProbe(observed.explicitRejectionOutcome === 'explicitly_rejected' && observed.explicitRejectionWriteMarker === null, '明确领域拒绝必须在外部 write marker 前形成显式回执');
    assertProbe(observed.unknownReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', '外部写出后结果未知必须阻断自动重放');
    assertProbe(
      forbiddenValidationRuntimeCalls.length === 0 && forbiddenValidationCapabilityRevocations.length === 0 && observed.readOnlyClosePreservedCopiedRun === 'running',
      '只读验证关闭不得让复制库中的历史 command run 驱动 Runtime kill、能力撤销或业务投影收口',
    );
    assertProbe(observed.quickCheck === 'ok', '临时数据库 quick_check 必须通过');
  } finally {
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

function externalRequest(label: string, runId: string) {
  const externalOperationId = `command-run-${label}:${runId}`;
  const request = createCommandCenterCommandRequest({
    commandType: commandCenterCommandTypes.runStart,
    actor: { kind: 'local_api', id: 'command-center-probe' },
    scope: { kind: 'command_run', id: runId },
    expectedRevision: null,
    operationIdentity: `command_run_operation_${label}`,
    value: { runId },
  });
  const application = activeApplication();
  return {
    runId,
    externalOperationId,
    parsed: application.parse<{ runId: string }>({
      value: request,
      commandType: commandCenterCommandTypes.runStart,
      scopeKind: 'command_run',
      expectedScopeId: ({ input }) => input.runId,
    }),
  };
}

function activeApplication(): CommandCenterCommandApplication {
  if (!applicationReference) throw new Error('Command Center probe application is unavailable.');
  return applicationReference;
}

function insertEvent(db: { execute(sql: string, params?: Array<string | number | null>): unknown }, id: string): void {
  db.execute(`INSERT INTO command_center_probe_events (id, value) VALUES (?, ?)`, [id, id]);
}

function countEvent(db: { get<T>(sql: string, params?: Array<string | number | null>): T | undefined }, id: string): number {
  return db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_center_probe_events WHERE id = ?`, [id])?.count ?? -1;
}

function countInbox(db: { get<T>(sql: string, params?: Array<string | number | null>): T | undefined }, commandId: string): number {
  return db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [commandId])?.count ?? -1;
}

function ledgerCounts(db: { countRows(tableName: string): number }) {
  return {
    inbox: db.countRows('command_inbox'),
    outbox: db.countRows('command_outbox'),
    receipts: db.countRows('command_delivery_receipts'),
  };
}

function captureCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    if (error instanceof CommandDeliveryStoreError) return error.code;
    if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
    return error instanceof Error ? error.name : String(error);
  }
}

function assertProbe(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Command Center Command 行为探针失败：${message}`);
}
