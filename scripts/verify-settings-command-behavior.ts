import assert from 'node:assert/strict';
import { createSettingsApiClient } from '../apps/desktop/src/renderer/features/settings/settingsApiClient.js';
import { settingsPage } from '../apps/desktop/src/renderer/settings/SettingsPagination.js';
import type { LocalApiTransport } from '../apps/desktop/src/renderer/transport/localApiTransport.js';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { registerGlobalAgentSettingsRoutes } from '../packages/local-server/src/globalAgentSettings.js';
import type { GlobalAgentSettingsSnapshot } from '@zeus/shared';
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

/** 同一客户端跨设置页面保存也必须顺序执行；某次失败不能堵住下一次。 */
const savedAppearances: string[] = [];
/** 延迟首个请求、拒绝第二个请求，观察第三个请求仍能按顺序保存。 */
const settingsClient = createSettingsApiClient({
  /** 只模拟设置传输，不涉及宿主或真实用户数据。 */
  async request(_path, init) {
    /** 只读取本检查所需的外观字段。 */
    const appearance = JSON.parse(String(init?.body)).input.appearance;
    if (appearance === 'dark') await new Promise((resolve) => setTimeout(resolve, 15));
    if (appearance === 'system') throw new Error('预期的保存失败');
    savedAppearances.push(appearance);
    return { appearance };
  },
} as LocalApiTransport);
await Promise.allSettled([settingsClient.saveAppShellSettings({ appearance: 'dark' }), settingsClient.saveAppShellSettings({ appearance: 'system' }), settingsClient.saveAppShellSettings({ appearance: 'light' })]);
assert.deepEqual(savedAppearances, ['dark', 'light']);
assert.equal(settingsPage(0, 4), 1);
assert.equal(settingsPage(21, 3), 3);
assert.equal(settingsPage(20, 3), 2);
observed.settingsInteraction = { saveOrder: true, failureRecovery: true, pageBoundary: true };

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  try {
    db.execute(`CREATE TABLE settings_probe (id TEXT PRIMARY KEY, value_json TEXT NOT NULL)`);
    const deliveries = new CommandDeliveryRepository(db);
    const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), () => now().toISOString(), { minimumFreeBytes: 0 });
    const application = new SettingsCommandApplication({ db, deliveries, artifacts, redactSensitiveText, now });

    /** 真实文件与设置路由检查，全部限定在临时目录内。 */
    const agentsRoot = join(probeRoot, 'agents');
    /** 独立路由实例复用当前命令数据库。 */
    const agentsServer = Fastify();
    /** 成功回执和审计都不应保存正文。 */
    const agentsAudit: unknown[] = [];
    registerGlobalAgentSettingsRoutes({
      server: agentsServer,
      codexHome: agentsRoot,
      commands: application,
      redactSensitiveText,
      recordSaved: (metadata) => {
        agentsAudit.push(metadata);
      },
    });
    /** 每个用户保存意图创建独立命令，重放时复用返回的请求对象。 */
    const agentsRequest = (label: string, content: string, baseRevision: string | null) =>
      commandRequest({ label: `agents-${label}`, commandType: settingsCommandTypes.agentsPut, scopeKind: 'settings', scopeId: 'agents', operationIdentity: `agents_${label}`, input: { content, baseRevision } });
    /** 使用接口读取作为页面基线。 */
    const readAgents = async (): Promise<GlobalAgentSettingsSnapshot> => {
      /** 本检查必须通过真实路由状态码。 */
      const response = await agentsServer.inject({ method: 'GET', url: '/api/settings/agents' });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<GlobalAgentSettingsSnapshot>();
    };
    try {
      /** 缺失读取不得创建文件或目录。 */
      const missingAgents = await readAgents();
      assert.equal(missingAgents.exists, false);
      assert.equal(missingAgents.revision, null);
      await assert.rejects(lstat(agentsRoot), { code: 'ENOENT' });
      /** 空白内容也可显式创建。 */
      const createAgents = await agentsServer.inject({ method: 'PUT', url: '/api/settings/agents', payload: agentsRequest('create', '', null) });
      assert.equal(createAgents.statusCode, 200, createAgents.body);
      assert.equal((await readAgents()).content, '');
      /** 正文包含敏感哨兵，验证命令证据不落正文。 */
      const editAgentsBody = agentsRequest('edit', `# 全局规则\n${secretSentinel}\n`, createAgents.json().revision);
      const editedAgents = await agentsServer.inject({ method: 'PUT', url: '/api/settings/agents', payload: editAgentsBody });
      assert.equal(editedAgents.statusCode, 200, editedAgents.body);
      assert.equal(await readFile(missingAgents.path, 'utf8'), editAgentsBody.input.content);
      assert.equal('content' in editedAgents.json(), false);
      /** 外部编辑后重放旧的已成功命令，只返回回执，不覆盖新文件。 */
      await writeFile(missingAgents.path, '外部修改\n');
      const agentsReplay = await agentsServer.inject({ method: 'PUT', url: '/api/settings/agents', payload: editAgentsBody });
      assert.deepEqual(agentsReplay.json(), editedAgents.json());
      assert.equal(await readFile(missingAgents.path, 'utf8'), '外部修改\n');
      assert.equal(agentsAudit.length, 2);
      /** 新保存携带旧摘要，必须报告冲突。 */
      const agentsConflict = await agentsServer.inject({ method: 'PUT', url: '/api/settings/agents', payload: agentsRequest('conflict', '不应覆盖', editedAgents.json().revision) });
      assert.equal(agentsConflict.statusCode, 409);
      assert.equal(await readFile(missingAgents.path, 'utf8'), '外部修改\n');
      /** 两个并发窗口使用同一基线，最多一个保存成功。 */
      const concurrentAgentsBase = await readAgents();
      const concurrentAgents = await Promise.all(['first', 'second'].map((label) => agentsServer.inject({ method: 'PUT', url: '/api/settings/agents', payload: agentsRequest(label, label, concurrentAgentsBase.revision) })));
      assert.deepEqual(concurrentAgents.map((response) => response.statusCode).sort(), [200, 409]);
      /** 清空已有文件保留普通文件身份。 */
      const beforeEmptyAgents = await readAgents();
      const emptiedAgents = await agentsServer.inject({ method: 'PUT', url: '/api/settings/agents', payload: agentsRequest('empty', '', beforeEmptyAgents.revision) });
      assert.equal(emptiedAgents.statusCode, 200, emptiedAgents.body);
      assert.equal((await readAgents()).content, '');
      /** 目录不可写使临时文件创建失败，原文件必须保持完整。 */
      await chmod(agentsRoot, 0o500);
      try {
        const failedAgents = await agentsServer.inject({ method: 'PUT', url: '/api/settings/agents', payload: agentsRequest('failure', '不应保存', emptiedAgents.json().revision) });
        assert.equal(failedAgents.statusCode, 409, failedAgents.body);
        assert.equal(await readFile(missingAgents.path, 'utf8'), '');
      } finally {
        await chmod(agentsRoot, 0o700);
      }
      /** 链接目标不能被读取或写入，外部文件不受影响。 */
      const agentsOutside = join(probeRoot, 'outside-agents.md');
      await writeFile(agentsOutside, '保留外部文件');
      await rm(missingAgents.path);
      await symlink(agentsOutside, missingAgents.path);
      assert.equal((await agentsServer.inject({ method: 'GET', url: '/api/settings/agents' })).statusCode, 409);
      assert.equal((await agentsServer.inject({ method: 'PUT', url: '/api/settings/agents', payload: agentsRequest('symlink', '不应写入', null) })).statusCode, 409);
      assert.equal(await readFile(agentsOutside, 'utf8'), '保留外部文件');
      assert.equal(JSON.stringify(agentsAudit).includes(secretSentinel), false);
      observed.globalAgents = {
        readWithoutCreate: true,
        createAndEdit: true,
        empty: true,
        conflict: true,
        concurrentSave: true,
        replayWithoutWrite: true,
        failedWritePreservesOriginal: true,
        symlinksRejected: true,
        auditWithoutContent: true,
      };
    } finally {
      await agentsServer.close();
    }

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
      commandRequest({ label: 'core-rollback', commandType: settingsCommandTypes.appShellSettingsPut, scopeKind: 'settings', scopeId: 'app-shell', operationIdentity: 'app_shell_rollback_probe', input: { value: 'invalid-late' } }),
    );
    let rollbackFailed = false;
    try {
      application.executeCore({
        parsed: rollback,
        destinationId: 'app_shell_settings',
        resourceId: 'app-shell',
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
      commandRequest({ label: 'explicit-reject', commandType: settingsCommandTypes.runtimeSettingsPut, scopeKind: 'settings', scopeId: 'runtime', operationIdentity: 'retention_rejected_probe', input: { logRetentionDays: 30 } }),
    );
    try {
      await application.executeExternal({
        parsed: explicit,
        destinationId: 'runtime_log_retention',
        resourceId: 'runtime-log-retention',
        externalOperationId: 'retention_rejected_probe:retention',
        invoke: async () => {
          throw new SettingsExternalOperationRejectedError('日志保留设置已明确拒绝本次操作');
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
    assertProbe((observed.routeCounts as { total: number }).total === 9, '设置命令清单必须覆盖全局规则在内的九条路由。');
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
