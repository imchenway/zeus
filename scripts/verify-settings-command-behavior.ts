import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import { ArtifactStore, CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import {
  SettingsCommandApplication,
  SettingsExternalOperationRejectedError,
  settingsCommandInputSha256,
  settingsCommandRoutePolicy,
  settingsCommandTypes,
  type SettingsCommandPayload,
  type SettingsCommandRequest,
  type SettingsCommandScopeKind,
  type SettingsCommandType,
} from '../packages/local-server/src/settingsCommandApplication.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-settings-command-probe-'));
const secretSentinel = 'settings-probe-secret-never-persist';
const observed: Record<string, unknown> = {};
let clockMs = Date.parse('2026-08-21T20:00:00.000Z');

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  try {
    db.execute(`CREATE TABLE settings_probe (id TEXT PRIMARY KEY, value_json TEXT NOT NULL)`);
    const deliveries = new CommandDeliveryRepository(db);
    const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), () => now().toISOString(), { minimumFreeBytes: 0 });
    const application = new SettingsCommandApplication({ db, deliveries, artifacts, redactSensitiveText, now });

    let coreWrites = 0;
    const core = parse(
      application,
      commandRequest({ label: 'core-accepted', commandType: settingsCommandTypes.projectConfigPut, scopeKind: 'project', scopeId: 'project-probe', operationIdentity: 'project_config_probe', input: { language: 'zh-CN' } }),
    );
    const coreFirst = application.executeCore({
      parsed: core,
      destinationId: 'project_config',
      resourceId: 'project-probe',
      mutateBusinessState: () => {
        coreWrites += 1;
        db.execute(`INSERT INTO settings_probe (id, value_json) VALUES (?, ?)`, ['core', JSON.stringify(core.input)]);
        return { saved: true };
      },
    });
    const coreReplay = application.executeCore({
      parsed: core,
      destinationId: 'project_config',
      resourceId: 'project-probe',
      mutateBusinessState: () => {
        throw new Error('accepted Core replay must not mutate');
      },
    });
    observed.coreAcceptedReplay = { writes: coreWrites, replayed: coreReplay.replayed, immutableResult: JSON.stringify(coreFirst.result) === JSON.stringify(coreReplay.result) };

    const rollback = parse(
      application,
      commandRequest({ label: 'core-rollback', commandType: settingsCommandTypes.codeMapSettingsPut, scopeKind: 'settings', scopeId: 'code-map', operationIdentity: 'code_map_rollback_probe', input: { value: 'invalid-late' } }),
    );
    let rollbackFailed = false;
    try {
      application.executeCore({
        parsed: rollback,
        destinationId: 'code_map_settings',
        resourceId: 'code-map',
        mutateBusinessState: () => {
          db.execute(`INSERT INTO settings_probe (id, value_json) VALUES (?, ?)`, ['rollback', '{}']);
          throw new Error('planned mutation failure');
        },
      });
    } catch {
      rollbackFailed = true;
    }
    observed.atomicRollback = {
      failed: rollbackFailed,
      businessRows: db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM settings_probe WHERE id = 'rollback'`)?.count ?? -1,
      inboxRows: db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [rollback.command.commandId])?.count ?? -1,
    };

    let importInvocations = 0;
    const largeImportInput = { schemaVersion: 2, redaction: { secretsRedacted: true }, records: 'x'.repeat(1_100_000) };
    const importCommand = parse(
      application,
      commandRequest({ label: 'import-accepted', commandType: settingsCommandTypes.dataImport, scopeKind: 'settings', scopeId: 'local-business-data-import', operationIdentity: 'business_import_probe', input: largeImportInput }),
    );
    const importFirst = await application.executeExternal({
      parsed: importCommand,
      destinationId: 'business_data_import_artifact',
      resourceId: 'local-business-data-import',
      externalOperationId: 'business_import_probe:artifact-and-core-import',
      invoke: async () => {
        importInvocations += 1;
        const sourceArtifact = await application.stageImportArtifact({ parsed: importCommand, value: importCommand.input, kind: 'business_data' });
        return { publicResult: { imported: true, count: 1 }, sourceArtifact };
      },
      mutateAcceptedBusinessState: (result) => db.execute(`INSERT INTO settings_probe (id, value_json) VALUES (?, ?)`, ['import', JSON.stringify(result.publicResult)]),
    });
    const importReplay = await application.executeExternal({
      parsed: importCommand,
      destinationId: 'business_data_import_artifact',
      resourceId: 'local-business-data-import',
      externalOperationId: 'business_import_probe:artifact-and-core-import',
      invoke: async () => {
        throw new Error('accepted external replay must not invoke');
      },
      mutateAcceptedBusinessState: () => {
        throw new Error('accepted external replay must not mutate');
      },
    });
    const importAttempt = requiredAttempt(deliveries, importCommand.command.commandId);
    observed.importArtifactReplay = {
      invocations: importInvocations,
      replayed: importReplay.replayed,
      immutableResult: importFirst.result.publicResult.imported === importReplay.result.publicResult.imported && importFirst.result.publicResult.count === importReplay.result.publicResult.count,
      sourceBytes: importReplay.result.sourceArtifact.contentByteLength,
      receiptBytes: Buffer.byteLength(importAttempt.receipt.evidenceJson, 'utf8'),
    };

    let secretWrites = 0;
    const secret = parse(
      application,
      commandRequest({ label: 'secret-accepted', commandType: settingsCommandTypes.projectDatabaseSecretPut, scopeKind: 'project', scopeId: 'project-probe', operationIdentity: 'secret_put_probe', input: { password: secretSentinel } }),
    );
    await application.executeExternal({
      parsed: secret,
      destinationId: 'project_database_secret',
      resourceId: 'project-probe:database',
      externalOperationId: 'secret_put_probe:keychain-put',
      sensitiveValues: [secretSentinel],
      invoke: async () => {
        secretWrites += 1;
        return { configured: true };
      },
      mutateAcceptedBusinessState: () => undefined,
    });
    await application.executeExternal({
      parsed: secret,
      destinationId: 'project_database_secret',
      resourceId: 'project-probe:database',
      externalOperationId: 'secret_put_probe:keychain-put',
      sensitiveValues: [secretSentinel],
      invoke: async () => {
        throw new Error('secret replay must not invoke');
      },
      mutateAcceptedBusinessState: () => undefined,
    });

    const failedBefore = parse(
      application,
      commandRequest({ label: 'failed-before', commandType: settingsCommandTypes.runtimeSettingsPut, scopeKind: 'settings', scopeId: 'runtime', operationIdentity: 'retention_failed_before_probe', input: { retentionDays: 30 } }),
    );
    let failedBeforeInvocations = 0;
    try {
      await application.executeExternal({
        parsed: failedBefore,
        destinationId: 'runtime_log_retention',
        resourceId: 'runtime',
        externalOperationId: 'retention_failed_before_probe:retention',
        beforeWrite: async () => {
          throw new Error('preflight rejected before filesystem write');
        },
        invoke: async () => {
          failedBeforeInvocations += 1;
          return { ok: true };
        },
        mutateAcceptedBusinessState: () => undefined,
      });
    } catch {
      // expected
    }

    const explicit = parse(
      application,
      commandRequest({ label: 'explicit-reject', commandType: settingsCommandTypes.projectionCacheClear, scopeKind: 'settings', scopeId: 'projection-cache', operationIdentity: 'cache_rejected_probe', input: {} }),
    );
    try {
      await application.executeExternal({
        parsed: explicit,
        destinationId: 'projection_database_cache',
        resourceId: 'code-graph-cache',
        externalOperationId: 'cache_rejected_probe:projection-clear',
        invoke: async () => {
          throw new SettingsExternalOperationRejectedError('projection writer explicitly rejected operation');
        },
        mutateAcceptedBusinessState: () => undefined,
      });
    } catch {
      // expected
    }

    let unknownInvocations = 0;
    const unknown = parse(
      application,
      commandRequest({ label: 'unknown', commandType: settingsCommandTypes.projectDatabaseSecretPut, scopeKind: 'project', scopeId: 'project-unknown', operationIdentity: 'secret_unknown_probe', input: { password: secretSentinel } }),
    );
    let unknownCode: unknown = null;
    let replayCode: unknown = null;
    try {
      await application.executeExternal({
        parsed: unknown,
        destinationId: 'project_database_secret',
        resourceId: 'project-unknown:database',
        externalOperationId: 'secret_unknown_probe:keychain-put',
        sensitiveValues: [secretSentinel],
        invoke: async () => {
          unknownInvocations += 1;
          throw new Error(`Keychain response lost for ${secretSentinel}`);
        },
        mutateAcceptedBusinessState: () => undefined,
      });
    } catch (error) {
      unknownCode = (error as { code?: unknown }).code;
    }
    try {
      await application.executeExternal({
        parsed: unknown,
        destinationId: 'project_database_secret',
        resourceId: 'project-unknown:database',
        externalOperationId: 'secret_unknown_probe:keychain-put',
        sensitiveValues: [secretSentinel],
        invoke: async () => {
          unknownInvocations += 1;
          return { configured: true };
        },
        mutateAcceptedBusinessState: () => undefined,
      });
    } catch (error) {
      replayCode = (error as { code?: unknown }).code;
    }

    const failedAttempt = requiredAttempt(deliveries, failedBefore.command.commandId);
    const explicitAttempt = requiredAttempt(deliveries, explicit.command.commandId);
    const unknownAttempt = requiredAttempt(deliveries, unknown.command.commandId);
    observed.fourOutcomes = {
      accepted: importAttempt.receipt.outcome,
      failedBeforeWrite: failedAttempt.receipt.outcome,
      explicitlyRejected: explicitAttempt.receipt.outcome,
      unknown: unknownAttempt.receipt.outcome,
      failedBeforeInvocations,
      unknownInvocations,
      unknownCode,
      replayCode,
      unknownWriteMarker: unknownAttempt.attempt.providerWriteStartedAt !== null,
    };
    const durableText = db
      .select<{ value: string }>(`SELECT envelope_json AS value FROM command_inbox UNION ALL SELECT evidence_json AS value FROM command_delivery_receipts`)
      .map((row) => row.value)
      .join('\n');
    observed.secretPersistence = { writes: secretWrites, durableContainsPlaintext: durableText.includes(secretSentinel), unknownEvidenceRedacted: !unknownAttempt.receipt.evidenceJson.includes(secretSentinel) };
    observed.routeCounts = {
      core: settingsCommandRoutePolicy.coreApplications.length,
      external: settingsCommandRoutePolicy.externalOperations.length,
      total: settingsCommandRoutePolicy.coreApplications.length + settingsCommandRoutePolicy.externalOperations.length,
    };
    observed.quickCheck = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? null;
    observed.realExternalServicesStarted = false;

    assertProbe(coreWrites === 1 && coreReplay.replayed, 'Core accepted replay must not repeat mutation.');
    assertProbe(
      rollbackFailed && (observed.atomicRollback as { businessRows: number; inboxRows: number }).businessRows === 0 && (observed.atomicRollback as { businessRows: number; inboxRows: number }).inboxRows === 0,
      'Core failure must roll back business facts and Inbox together.',
    );
    assertProbe(
      importInvocations === 1 && importReplay.replayed && importReplay.result.sourceArtifact.contentByteLength > 1_000_000 && Buffer.byteLength(importAttempt.receipt.evidenceJson, 'utf8') < 16_384,
      'Import body/result must replay through bounded ArtifactRef evidence.',
    );
    assertProbe(
      failedAttempt.receipt.outcome === 'failed_before_write' && explicitAttempt.receipt.outcome === 'explicitly_rejected' && unknownAttempt.receipt.outcome === 'outcome_unknown_after_write',
      'External operation four-state outcomes must remain distinct.',
    );
    assertProbe(unknownInvocations === 1 && unknownCode === 'ZEUS_SETTINGS_COMMAND_OUTCOME_UNKNOWN' && replayCode === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', 'Unknown after write must block automatic resend.');
    assertProbe(secretWrites === 1 && !durableText.includes(secretSentinel) && !unknownAttempt.receipt.evidenceJson.includes(secretSentinel), 'Secret plaintext must not enter durable command evidence.');
    assertProbe((observed.routeCounts as { total: number }).total === 10, 'Settings command inventory must cover exactly ten routes.');
    assertProbe(observed.quickCheck === 'ok', 'Temporary SQLite quick_check must pass.');
    console.log(JSON.stringify({ status: 'passed', observed }, null, 2));
  } finally {
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

function commandRequest<TInput extends object>(input: { label: string; commandType: SettingsCommandType; scopeKind: SettingsCommandScopeKind; scopeId: string; operationIdentity: string; input: TInput }): SettingsCommandRequest<TInput> {
  const payload: SettingsCommandPayload = { operationIdentity: input.operationIdentity, inputSha256: settingsCommandInputSha256(input.input) };
  const command: CommandEnvelope<SettingsCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId: `command_settings_probe_${input.label}`,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'settings-command-probe' },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: now().toISOString(),
    payload,
  };
  return { command, input: input.input };
}

function parse<TInput extends object>(application: SettingsCommandApplication, request: SettingsCommandRequest<TInput>) {
  return application.parse<TInput>({ value: request, commandType: request.command.commandType as SettingsCommandType, scopeKind: request.command.scope.kind as SettingsCommandScopeKind, expectedScopeId: () => request.command.scope.id });
}

function requiredAttempt(deliveries: CommandDeliveryRepository, commandId: string) {
  const attempt = deliveries.get(commandId)?.attempts.at(-1);
  if (!attempt?.receipt) throw new Error(`Missing durable attempt for ${commandId}.`);
  return { attempt, receipt: attempt.receipt };
}

function now(): Date {
  return new Date(clockMs++);
}

function redactSensitiveText(value: string): { text: string } {
  return { text: value.replaceAll(secretSentinel, '[REDACTED]') };
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Settings command verifier failed: ${message}`);
}
