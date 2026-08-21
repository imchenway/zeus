import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { ModelConnectionRecord, ProjectModelSelection } from '../packages/ai-runtime/src/index.js';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import { ArtifactStore, CommandDeliveryRepository, createZeusDatabase, type AppendAuditLogInput } from '../packages/storage/src/index.js';
import {
  IntegrationCommandApplication,
  integrationCommandInputSha256,
  integrationCommandRoutePolicy,
  integrationCommandTypes,
  type IntegrationCommandPayload,
  type IntegrationCommandRequest,
  type IntegrationCommandScopeKind,
  type IntegrationCommandType,
} from '../packages/local-server/src/integrationCommandApplication.js';
import { registerIntegrationCommandRoutes } from '../packages/local-server/src/integrationCommandRoutes.js';
import type { ModelConnectionService, SaveModelConnectionRequest } from '../packages/local-server/src/modelConnectionService.js';
import type { ZentaoCredentialService } from '../packages/local-server/src/zentaoCredentialService.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-integration-command-probe-'));
const observed: Record<string, unknown> = {};
const secretSentinel = 'probe-secret-value-never-persist';
let clockMs = Date.parse('2026-08-21T18:00:00.000Z');

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const server = Fastify({ logger: false });
  try {
    db.execute(`CREATE TABLE integration_probe_selection (project_id TEXT PRIMARY KEY, selection_json TEXT NOT NULL)`);
    const deliveries = new CommandDeliveryRepository(db);
    const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), () => now().toISOString(), { minimumFreeBytes: 0 });
    const application = new IntegrationCommandApplication({ db, deliveries, artifacts, redactSensitiveText, now, maximumProbeEntries: 4, probeReplayTtlMs: 1_000 });
    const auditEntries: AppendAuditLogInput[] = [];
    const secrets = new Map<string, string>();
    let modelCreateInvocations = 0;
    let modelUpdateInvocations = 0;
    let runtimeRefreshInvocations = 0;
    let diagnoseInvocations = 0;
    let selectionWrites = 0;
    let secretWrites = 0;

    const modelConnections = fakeModelConnectionService({
      onCreate: (id) => {
        modelCreateInvocations += 1;
        return modelRecord(id, 'x'.repeat(1_100_000));
      },
      onUpdate: (_id, input) => {
        modelUpdateInvocations += 1;
        throw Object.assign(new Error(`provider lost response for ${String(input.apiKey)}`), { code: 'ZEUS_PROBE_PROVIDER_LOST' });
      },
      onDiagnose: async () => {
        diagnoseInvocations += 1;
        return { ok: true, stage: 'catalog' as const, code: 'ZEUS_PROBE_OK', message: 'probe ok', checkedAt: now().toISOString(), discoveredModelCount: 1 };
      },
      onSaveSelection: (selection) => {
        selectionWrites += 1;
        db.execute(`INSERT INTO integration_probe_selection (project_id, selection_json) VALUES (?, ?)`, [selection.projectId, JSON.stringify(selection)]);
        return selection;
      },
    });

    registerIntegrationCommandRoutes({
      server,
      application,
      modelConnections,
      zentaoCredentials: fakeZentaoService(),
      projects: { getById: (projectId) => (projectId === 'project-probe' ? ({} as never) : undefined) },
      secretStore: {
        getSecret: async (account) => secrets.get(account),
        setSecret: async (account, value) => {
          secretWrites += 1;
          secrets.set(account, value);
        },
        deleteSecret: async (account) => {
          secrets.delete(account);
        },
      },
      refreshModelRuntime: async () => {
        runtimeRefreshInvocations += 1;
      },
      readSecuritySecrets: async () => ({
        telegramBotToken: presence(secrets.has('telegram.botToken')),
        externalApiKey: presence(secrets.has('external.apiKey')),
      }),
      appendAuditLog: (input) => auditEntries.push({ ...input, createdAt: input.createdAt ?? now().toISOString() }),
      redactSensitiveText,
    });

    const acceptedCreate = commandRequest({
      label: 'model-create-accepted',
      commandType: integrationCommandTypes.modelConnectionCreate,
      scopeKind: 'provider_configuration',
      scopeId: 'model_connection_probe_accepted',
      operationIdentity: 'model_connection_probe_accepted',
      input: { name: 'Probe', baseUrl: 'https://example.invalid/v1', apiKey: secretSentinel },
    });
    const acceptedFirst = await inject('POST', '/api/model-connections', acceptedCreate.body);
    const acceptedReplay = await inject('POST', '/api/model-connections', acceptedCreate.body);
    const acceptedAttempt = requiredAttempt(deliveries, acceptedCreate.commandId);
    const acceptedEvidence = JSON.parse(acceptedAttempt.receipt.evidenceJson) as { resultArtifact?: { contentByteLength?: number; generationId?: string } };
    observed.acceptedExternal = {
      firstStatus: acceptedFirst.statusCode,
      replayStatus: acceptedReplay.statusCode,
      invocations: modelCreateInvocations,
      runtimeRefreshInvocations,
      immutableReplay: acceptedFirst.body.name === acceptedReplay.body.name,
      receiptBytes: Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8'),
      artifactContentBytes: acceptedEvidence.resultArtifact?.contentByteLength,
      artifactGeneration: acceptedEvidence.resultArtifact?.generationId,
    };

    const unknownUpdate = commandRequest({
      label: 'model-update-unknown',
      commandType: integrationCommandTypes.modelConnectionUpdate,
      scopeKind: 'provider_configuration',
      scopeId: 'model_connection_probe_accepted',
      operationIdentity: 'model_connection_update_probe_unknown',
      input: { name: 'Probe update', baseUrl: 'https://example.invalid/v1', apiKey: secretSentinel },
    });
    const unknownFirst = await inject('PUT', '/api/model-connections/model_connection_probe_accepted', unknownUpdate.body);
    const unknownReplay = await inject('PUT', '/api/model-connections/model_connection_probe_accepted', unknownUpdate.body);
    const unknownAttempt = requiredAttempt(deliveries, unknownUpdate.commandId);
    observed.unknownExternal = {
      firstCode: unknownFirst.body.error,
      replayCode: unknownReplay.body.error,
      invocations: modelUpdateInvocations,
      outcome: unknownAttempt.receipt.outcome,
      writeMarker: unknownAttempt.attempt.providerWriteStartedAt !== null,
      evidenceRedacted: !unknownAttempt.receipt.evidenceJson.includes(secretSentinel),
    };

    const secretPut = commandRequest({
      label: 'telegram-token-put',
      commandType: integrationCommandTypes.telegramBotTokenPut,
      scopeKind: 'provider_account',
      scopeId: 'telegram.botToken',
      operationIdentity: 'telegram_token_put_probe',
      input: { token: secretSentinel },
    });
    const secretFirst = await inject('PUT', '/api/security/secrets/telegram-bot-token', secretPut.body);
    const secretReplay = await inject('PUT', '/api/security/secrets/telegram-bot-token', secretPut.body);
    observed.secretExternal = { firstStatus: secretFirst.statusCode, replayStatus: secretReplay.statusCode, writes: secretWrites, configured: secretReplay.body.telegramBotToken };

    const selection = commandRequest({
      label: 'project-model-selection',
      commandType: integrationCommandTypes.projectModelSelectionSave,
      scopeKind: 'settings',
      scopeId: 'project_model_selection:project-probe',
      operationIdentity: 'project_model_selection_probe',
      input: { allowedModelRefs: ['connection:model'], defaultModelRef: 'connection:model' },
    });
    const selectionFirst = await inject('PUT', '/api/projects/project-probe/model-selection', selection.body);
    const selectionReplay = await inject('PUT', '/api/projects/project-probe/model-selection', selection.body);
    observed.coreSelection = {
      firstStatus: selectionFirst.statusCode,
      replayStatus: selectionReplay.statusCode,
      writes: selectionWrites,
      receiptOutcome: requiredAttempt(deliveries, selection.commandId).receipt.outcome,
      businessRows: db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM integration_probe_selection`)?.count ?? -1,
    };

    const diagnose = commandRequest({
      label: 'diagnose-probe',
      commandType: integrationCommandTypes.modelConnectionDiagnose,
      scopeKind: 'provider_configuration',
      scopeId: 'model_connection_probe_accepted',
      operationIdentity: 'model_connection_diagnose_probe',
      input: {},
    });
    const diagnoseFirst = await inject('POST', '/api/model-connections/model_connection_probe_accepted/diagnose', diagnose.body);
    const diagnoseReplay = await inject('POST', '/api/model-connections/model_connection_probe_accepted/diagnose', diagnose.body);
    const diagnoseInboxRows = countInbox([diagnose.commandId]);
    clockMs += 2_000;
    const diagnoseAfterTtl = await inject('POST', '/api/model-connections/model_connection_probe_accepted/diagnose', diagnose.body);
    let releaseHeldProbes: ((value: { ok: true }) => void) | undefined;
    const heldProbeResult = new Promise<{ ok: true }>((resolve) => {
      releaseHeldProbes = resolve;
    });
    let heldProbeInvocations = 0;
    const heldProbes = Array.from({ length: 3 }, (_, index) => {
      const request = commandRequest({
        label: `diagnose-capacity-${index}`,
        commandType: integrationCommandTypes.modelConnectionDiagnose,
        scopeKind: 'provider_configuration',
        scopeId: `model_connection_capacity_${index}`,
        operationIdentity: `model_connection_capacity_${index}`,
        input: {},
      });
      const parsed = application.parse<Record<string, never>>({
        value: request.body,
        commandType: integrationCommandTypes.modelConnectionDiagnose,
        scopeKind: 'provider_configuration',
        expectedScopeId: () => `model_connection_capacity_${index}`,
      });
      return application.executeReadOnlyProbe({
        parsed,
        invoke: () => {
          heldProbeInvocations += 1;
          return heldProbeResult;
        },
      });
    });
    const overflowRequest = commandRequest({
      label: 'diagnose-capacity-overflow',
      commandType: integrationCommandTypes.modelConnectionDiagnose,
      scopeKind: 'provider_configuration',
      scopeId: 'model_connection_capacity_overflow',
      operationIdentity: 'model_connection_capacity_overflow',
      input: {},
    });
    const overflowParsed = application.parse<Record<string, never>>({
      value: overflowRequest.body,
      commandType: integrationCommandTypes.modelConnectionDiagnose,
      scopeKind: 'provider_configuration',
      expectedScopeId: () => 'model_connection_capacity_overflow',
    });
    let overflowCode: unknown = null;
    try {
      await application.executeReadOnlyProbe({
        parsed: overflowParsed,
        invoke: async () => {
          heldProbeInvocations += 1;
          return { ok: true as const };
        },
      });
    } catch (error) {
      overflowCode = (error as { code?: unknown }).code;
    }
    const capacityBeforeRelease = application.probeSnapshot();
    releaseHeldProbes?.({ ok: true });
    await Promise.all(heldProbes);
    const capacityAfterRelease = application.probeSnapshot();
    observed.readOnlyProbe = {
      firstStatus: diagnoseFirst.statusCode,
      replayStatus: diagnoseReplay.statusCode,
      afterTtlStatus: diagnoseAfterTtl.statusCode,
      invocations: diagnoseInvocations,
      inboxRows: diagnoseInboxRows,
      policy: integrationCommandRoutePolicy.probeReplay,
      capacity: { overflowCode, heldProbeInvocations, beforeRelease: capacityBeforeRelease, afterRelease: capacityAfterRelease },
    };

    const durableText = db
      .select<{ value: string }>(
        `SELECT envelope_json AS value FROM command_inbox
         UNION ALL SELECT evidence_json AS value FROM command_delivery_receipts`,
      )
      .map((row) => row.value)
      .join('\n');
    const acceptedArtifacts = await Promise.all(
      db.select<{ command_id: string; evidence_json: string }>(`SELECT command_id, evidence_json FROM command_delivery_receipts WHERE outcome = 'accepted'`).flatMap((row) => {
        const evidence = JSON.parse(row.evidence_json) as { resultArtifact?: { sha256?: unknown } };
        return typeof evidence.resultArtifact?.sha256 === 'string'
          ? [
              artifacts
                .readAuthorized({ sha256: evidence.resultArtifact.sha256, owner: { kind: 'command_delivery_result', id: row.command_id }, maximumContentBytes: 8 * 1024 * 1024 })
                .then((stored) => new TextDecoder().decode(stored.bytes)),
            ]
          : [];
      }),
    );
    observed.plaintextPersistence = {
      commandTablesContainSecret: durableText.includes(secretSentinel),
      auditContainsSecret: JSON.stringify(auditEntries).includes(secretSentinel),
      artifactContainsSecret: acceptedArtifacts.some((value) => value.includes(secretSentinel)),
    };
    observed.routeCounts = {
      external: integrationCommandRoutePolicy.externalOperations.length,
      core: integrationCommandRoutePolicy.coreApplications.length,
      readOnlyProbe: integrationCommandRoutePolicy.readOnlyExternalProbes.length,
      total: integrationCommandRoutePolicy.externalOperations.length + integrationCommandRoutePolicy.coreApplications.length + integrationCommandRoutePolicy.readOnlyExternalProbes.length,
    };
    observed.quickCheck = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? null;
    observed.realExternalServicesStarted = false;

    assertProbe(acceptedFirst.statusCode === 201 && acceptedReplay.statusCode === 200 && modelCreateInvocations === 1 && runtimeRefreshInvocations === 1, 'accepted external replay 必须返回不可变结果且不得二次刷新 Provider runtime。');
    assertProbe(
      (acceptedEvidence.resultArtifact?.contentByteLength ?? 0) > 1_000_000 && acceptedEvidence.resultArtifact?.generationId === 'integration-command-result-v1' && Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8') < 16_384,
      '大型结果必须进入 ArtifactRef，receipt 只保留有界引用。',
    );
    assertProbe(unknownFirst.body.error === 'ZEUS_INTEGRATION_COMMAND_OUTCOME_UNKNOWN' && unknownReplay.body.error === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' && modelUpdateInvocations === 1, 'write marker 后未知必须阻断自动重发。');
    assertProbe(
      unknownAttempt.receipt.outcome === 'outcome_unknown_after_write' && unknownAttempt.attempt.providerWriteStartedAt !== null && !unknownAttempt.receipt.evidenceJson.includes(secretSentinel),
      'unknown 回执必须保留 marker 且对本轮明文做精确脱敏。',
    );
    assertProbe(secretFirst.statusCode === 200 && secretReplay.statusCode === 200 && secretWrites === 1, 'Keychain fake port 的 accepted replay 不得二次写入。');
    assertProbe(
      selectionFirst.statusCode === 200 && selectionReplay.statusCode === 200 && selectionWrites === 1 && (observed.coreSelection as { businessRows: number }).businessRows === 1,
      '项目模型选择与 accepted receipt 必须原子提交且 replay 不重做 mutation。',
    );
    assertProbe(
      diagnoseFirst.statusCode === 200 && diagnoseReplay.statusCode === 200 && diagnoseAfterTtl.statusCode === 200 && diagnoseInvocations === 2 && diagnoseInboxRows === 0,
      '只读外部探针必须有界 TTL replay，且不得写 Command WAL。',
    );
    assertProbe(
      overflowCode === 'ZEUS_INTEGRATION_PROBE_CAPACITY_EXCEEDED' && heldProbeInvocations === 3 && capacityBeforeRelease.active === 3 && capacityBeforeRelease.replayEntries === 1 && capacityAfterRelease.active === 0,
      '只读外部探针必须在访问网络前以 active+replay 的共同硬上限拒绝新 identity。',
    );
    assertProbe(
      !durableText.includes(secretSentinel) && !JSON.stringify(auditEntries).includes(secretSentinel) && acceptedArtifacts.every((value) => !value.includes(secretSentinel)),
      'API key/token/password 明文不得进入 Inbox、Receipt、Audit 或 Artifact。',
    );
    assertProbe((observed.routeCounts as { total: number }).total === 16, 'Integration Credentials/Model Configuration 清单必须精确覆盖 16 个入口。');
    assertProbe(observed.quickCheck === 'ok', '临时 SQLite quick_check 必须通过。');

    console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

    async function inject(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown): Promise<{ statusCode: number; body: Record<string, unknown> }> {
      const response = await server.inject({ method, url: path, payload: body });
      return { statusCode: response.statusCode, body: response.body ? (JSON.parse(response.body) as Record<string, unknown>) : {} };
    }

    function countInbox(commandIds: string[]): number {
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

function fakeModelConnectionService(options: {
  onCreate(id: string, input: SaveModelConnectionRequest): ModelConnectionRecord;
  onUpdate(id: string, input: SaveModelConnectionRequest): ModelConnectionRecord;
  onDiagnose(): ReturnType<ModelConnectionService['diagnose']>;
  onSaveSelection(selection: ProjectModelSelection): ProjectModelSelection;
}): ModelConnectionService {
  return {
    listMetadata: () => [],
    list: async () => [],
    get: async (id) => modelRecord(id, 'Probe'),
    create: async (input) => options.onCreate('model_connection_legacy_probe', input),
    createWithId: async (id, input) => options.onCreate(id, input),
    update: async (id, input) => options.onUpdate(id, input),
    remove: async () => undefined,
    clearApiKey: async (id) => modelRecord(id, 'Probe'),
    refreshModels: async (id) => ({ connection: modelRecord(id, 'Probe'), discoveredModelIds: [], addedModelIds: [], checkedAt: now().toISOString() }),
    diagnose: async () => options.onDiagnose(),
    listSelectableModels: async () => [],
    getProjectSelection: async (projectId) => ({ projectId, allowedModelRefs: [], defaultModelRef: null }),
    prepareProjectSelection: async (projectId, value) => {
      const candidate = value as { allowedModelRefs?: unknown; defaultModelRef?: unknown };
      const allowedModelRefs = Array.isArray(candidate.allowedModelRefs) ? candidate.allowedModelRefs.filter((entry): entry is string => typeof entry === 'string') : [];
      return { projectId, allowedModelRefs, defaultModelRef: typeof candidate.defaultModelRef === 'string' ? candidate.defaultModelRef : null };
    },
    savePreparedProjectSelectionInCurrentTransaction: options.onSaveSelection,
    saveProjectSelection: async (projectId, value) => {
      const selection = await fakeModelConnectionService(options).prepareProjectSelection(projectId, value);
      return options.onSaveSelection(selection);
    },
    loadRuntimeConnections: async () => [],
  };
}

function fakeZentaoService(): ZentaoCredentialService {
  const record = (id: string) => ({ id, host: 'https://zentao.invalid', basePath: '', account: 'probe', passwordConfigured: true, createdAt: now().toISOString(), updatedAt: now().toISOString() });
  return {
    list: async () => [],
    get: async (id) => record(id),
    create: async () => record('zentao_instance_legacy_probe'),
    createWithId: async (id) => record(id),
    update: async (id) => record(id),
    remove: async () => undefined,
    clearPassword: async (id) => ({ ...record(id), passwordConfigured: false }),
    verify: async () => ({ ok: true, code: 'verified', checkedAt: now().toISOString(), message: 'probe verified' }),
  };
}

function modelRecord(id: string, name: string): ModelConnectionRecord {
  return { id, name, templateId: 'custom', baseUrl: 'https://example.invalid/v1', modelsPath: '/models', enabled: true, apiKeyConfigured: true, models: [], createdAt: now().toISOString(), updatedAt: now().toISOString() };
}

function commandRequest<TInput extends object>(input: {
  label: string;
  commandType: IntegrationCommandType;
  scopeKind: IntegrationCommandScopeKind;
  scopeId: string;
  operationIdentity: string;
  input: TInput;
}): { commandId: string; body: IntegrationCommandRequest<TInput> } {
  const commandId = `command_integration_probe_${input.label}`;
  const payload: IntegrationCommandPayload = { operationIdentity: input.operationIdentity, inputSha256: integrationCommandInputSha256(input.input) };
  const command: CommandEnvelope<IntegrationCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'integration-command-probe' },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: now().toISOString(),
    payload,
  };
  return { commandId, body: { command, input: input.input } };
}

function requiredAttempt(deliveries: CommandDeliveryRepository, commandId: string) {
  const attempt = deliveries.get(commandId)?.attempts.at(-1);
  if (!attempt?.receipt) throw new Error(`Missing durable attempt for ${commandId}.`);
  return { attempt, receipt: attempt.receipt };
}

function presence(configured: boolean) {
  return { configured, label: configured ? ('已安全保存' as const) : ('未配置' as const) };
}

function now(): Date {
  return new Date(clockMs);
}

function redactSensitiveText(value: string): { text: string } {
  return { text: value.replaceAll(secretSentinel, '[REDACTED]') };
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Integration command verifier failed: ${message}`);
}
