import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CodexChatGptLogin, CodexRemoteControlClient, CodexRemoteControlPairing, CodexRemoteControlStatus } from '@zeus/ai-runtime';
import type { ZeusCodexLegacyImportRecord } from '@zeus/storage';
import type { CodexConfigImportResult, CodexConfigImportService } from './codexConfigImportService.js';
import type { CodexLegacyImportService } from './codexLegacyImportService.js';
import { ZeusSkillServiceError, type ZeusSkillInstallSource, type ZeusSkillService } from './zeusSkillService.js';
import { CodexPublicCommandApplicationService, codexPublicCommandHttpError, codexPublicCommandScopeIds, codexPublicCommandTypes, type CodexPublicMutationRequest } from './codexPublicCommandApplication.js';

export interface CodexRemoteControlSnapshot {
  enabled: boolean;
  status: CodexRemoteControlStatus;
  clients: CodexRemoteControlClient[];
  managedStandalone: { available: boolean; commandPath: string | null; installCommand: string };
}

export interface CodexRemoteControlPairingSnapshot extends CodexRemoteControlPairing {
  claimed: boolean;
}

export const codexPublicReadOnlyRoutes = {
  remoteControlPairingStatus: {
    method: 'POST',
    path: '/api/codex/remote-control/pairing/status',
    applicationMethod: 'readRemoteControlPairingStatus',
    classification: 'read_only',
    writesBusinessState: false,
    commandLedger: 'not_applicable',
  },
} as const;

type EmptyInput = Record<string, never>;
interface CancelLoginInput {
  loginId: string;
}
interface RevokeClientInput {
  environmentId: string;
  clientId: string;
}
interface LegacyImportInput {
  sourceConversationIds: string[];
}
interface SkillInstallInput {
  projectId: string | null;
  source: ZeusSkillInstallSource;
}
interface SkillRemoveInput {
  projectId: string | null;
  skillId: string;
}

interface CodexConfigImportApiResult extends CodexConfigImportResult {
  runtimeReloaded: false;
  runtimeGenerationId: null;
  runtimeError: null;
}

export function registerCodexPublicCommandRoutes(options: {
  server: FastifyInstance;
  application: CodexPublicCommandApplicationService;
  configImport?: CodexConfigImportService;
  legacyImport?: CodexLegacyImportService;
  skills?: ZeusSkillService;
  resolveSkillCwd(projectId: string | null): string;
  account: {
    ensureReady(): Promise<void>;
    startLogin(): Promise<CodexChatGptLogin>;
    cancelLogin(loginId: string): Promise<void>;
  };
  remoteControl: {
    ensureReady(enabled?: boolean): Promise<void>;
    readStatus(): Promise<CodexRemoteControlStatus>;
    enable(): Promise<CodexRemoteControlStatus>;
    disable(): Promise<CodexRemoteControlStatus>;
    startPairing(): Promise<CodexRemoteControlPairing>;
    readPairingStatus(input: { pairingCode?: string | null; manualPairingCode?: string | null }): Promise<{ claimed: boolean }>;
    revokeClient(input: RevokeClientInput): Promise<void>;
    buildSnapshot(status?: CodexRemoteControlStatus): Promise<CodexRemoteControlSnapshot>;
    persistEnabled(input: { enabled: boolean; status: CodexRemoteControlStatus; occurredAt: string }): void;
    adoptEnabled(enabled: boolean): void;
  };
  configuration: {
    activate(): Promise<{ runtimeReloaded: true; runtimeGenerationId: string; restartRequired: false }>;
    recordImported(result: CodexConfigImportApiResult): void;
  };
  now(): Date;
  sendNativeError(reply: FastifyReply, error: unknown): unknown;
}): void {
  const { server, application } = options;

  server.get('/api/skills', async (request: FastifyRequest<{ Querystring: { projectId?: string; forceReload?: string } }>, reply) => {
    if (!options.skills) return unavailable(reply, 'ZEUS_SKILLS_UNAVAILABLE', 'Zeus Skill 管理不可用。');
    try {
      const projectId = optionalProjectId(request.query.projectId);
      const forceReload = request.query.forceReload === 'true';
      if (request.query.forceReload !== undefined && request.query.forceReload !== 'true' && request.query.forceReload !== 'false') {
        return reply.code(400).send({ error: 'ZEUS_SKILL_INPUT_INVALID', message: 'forceReload 必须为 true 或 false。' });
      }
      return await options.skills.list({ cwd: options.resolveSkillCwd(projectId), forceReload });
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  server.post('/api/skills/install', async (request: FastifyRequest<{ Body: CodexPublicMutationRequest<SkillInstallInput> }>, reply) => {
    if (!options.skills) return unavailable(reply, 'ZEUS_SKILLS_UNAVAILABLE', 'Zeus Skill 管理不可用。');
    try {
      const parsed = application.parse<SkillInstallInput>({
        value: request.body,
        commandType: codexPublicCommandTypes.skillInstall,
        scopeKind: 'provider_configuration',
        scopeId: codexPublicCommandScopeIds.skills,
      });
      assertExactInputKeys(parsed.input, ['projectId', 'source'], parsed.command.commandType);
      const projectId = nullableProjectId(parsed.input.projectId);
      const executed = await application.executeExternal({
        parsed: { ...parsed, input: { projectId, source: parsed.input.source } },
        destinationId: 'filesystem:zeus-skills',
        resourceId: codexPublicCommandScopeIds.skills,
        invoke: () => options.skills!.install({ cwd: options.resolveSkillCwd(projectId), source: parsed.input.source }),
        isExplicitRejection: (error) => error instanceof ZeusSkillServiceError,
      });
      return executed.result;
    } catch (error) {
      return sendCommandError(reply, error, () => sendSkillError(reply, error));
    }
  });

  server.delete('/api/skills/:skillId', async (request: FastifyRequest<{ Params: { skillId: string }; Body: CodexPublicMutationRequest<SkillRemoveInput> }>, reply) => {
    if (!options.skills) return unavailable(reply, 'ZEUS_SKILLS_UNAVAILABLE', 'Zeus Skill 管理不可用。');
    try {
      const parsed = application.parse<SkillRemoveInput>({
        value: request.body,
        commandType: codexPublicCommandTypes.skillRemove,
        scopeKind: 'provider_configuration',
        scopeId: codexPublicCommandScopeIds.skills,
      });
      assertExactInputKeys(parsed.input, ['projectId', 'skillId'], parsed.command.commandType);
      const skillId = requiredMatchingIdentity(parsed.input.skillId, request.params.skillId, 'skillId');
      const projectId = nullableProjectId(parsed.input.projectId);
      const executed = await application.executeExternal({
        parsed: { ...parsed, input: { projectId, skillId } },
        destinationId: 'filesystem:zeus-skills',
        resourceId: skillId,
        invoke: () => options.skills!.remove({ cwd: options.resolveSkillCwd(projectId), skillId }),
        isExplicitRejection: (error) => error instanceof ZeusSkillServiceError,
      });
      return executed.result;
    } catch (error) {
      return sendCommandError(reply, error, () => sendSkillError(reply, error));
    }
  });

  server.get('/api/codex-native/import', async (_request, reply) => {
    if (!options.legacyImport) return unavailable(reply, 'ZEUS_CODEX_LEGACY_IMPORT_UNAVAILABLE', 'Codex legacy import is unavailable.');
    try {
      const snapshot = await options.legacyImport.detect();
      return { eligible: snapshot.eligible.map((entry) => ({ sourceConversationId: entry.sourceConversationId, title: entry.title, cwd: entry.cwd })), runs: snapshot.runs.map(toLegacyImportApiRun) };
    } catch (error) {
      return sendLegacyImportError(reply, error);
    }
  });

  server.get('/api/codex-config/import', async (_request, reply) => {
    if (!options.configImport) return unavailable(reply, 'ZEUS_CODEX_CONFIG_IMPORT_UNAVAILABLE', 'Codex configuration import is unavailable.');
    try {
      return await options.configImport.inspect();
    } catch (error) {
      return reply.code(500).send({ error: 'ZEUS_CODEX_CONFIG_IMPORT_FAILED', message: error instanceof Error ? error.message : 'Codex configuration inspection failed.' });
    }
  });

  server.post('/api/codex-config/import', async (request: FastifyRequest<{ Body: CodexPublicMutationRequest<EmptyInput> }>, reply) => {
    if (!options.configImport) return unavailable(reply, 'ZEUS_CODEX_CONFIG_IMPORT_UNAVAILABLE', 'Codex configuration import is unavailable.');
    try {
      const parsed = application.parse<EmptyInput>({
        value: request.body,
        commandType: codexPublicCommandTypes.configurationImport,
        scopeKind: 'provider_configuration',
        scopeId: codexPublicCommandScopeIds.configuration,
      });
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'filesystem:codex-configuration',
        resourceId: codexPublicCommandScopeIds.configuration,
        invoke: async (): Promise<CodexConfigImportApiResult> => {
          const result = await options.configImport!.import();
          return { ...result, runtimeReloaded: false, runtimeGenerationId: null, runtimeError: null };
        },
        mutateBusinessState: (result) => options.configuration.recordImported(result),
      });
      return executed.result;
    } catch (error) {
      return sendCommandError(reply, error, () => reply.code(500).send({ error: 'ZEUS_CODEX_CONFIG_IMPORT_FAILED', message: error instanceof Error ? error.message : 'Codex configuration import failed.' }));
    }
  });

  server.post('/api/codex-config/activate', async (request: FastifyRequest<{ Body: CodexPublicMutationRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = application.parse<EmptyInput>({
        value: request.body,
        commandType: codexPublicCommandTypes.configurationActivate,
        scopeKind: 'provider_configuration',
        scopeId: codexPublicCommandScopeIds.configuration,
      });
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'codex:configuration-runtime',
        resourceId: codexPublicCommandScopeIds.configuration,
        invoke: options.configuration.activate,
      });
      return executed.result;
    } catch (error) {
      return sendCommandError(reply, error, () => options.sendNativeError(reply, error));
    }
  });

  server.post('/api/codex-native/import', async (request: FastifyRequest<{ Body: CodexPublicMutationRequest<LegacyImportInput> }>, reply) => {
    if (!options.legacyImport) return unavailable(reply, 'ZEUS_CODEX_LEGACY_IMPORT_UNAVAILABLE', 'Codex legacy import is unavailable.');
    try {
      const parsed = application.parse<LegacyImportInput>({
        value: request.body,
        commandType: codexPublicCommandTypes.legacyImportStart,
        scopeKind: 'provider_import',
        scopeId: codexPublicCommandScopeIds.legacyImport,
      });
      assertExactInputKeys(parsed.input, ['sourceConversationIds'], parsed.command.commandType);
      const sourceConversationIds = uniqueNonBlankStrings(parsed.input.sourceConversationIds, 'sourceConversationIds');
      const executed = await application.executeExternal({
        parsed: { ...parsed, input: { sourceConversationIds } },
        destinationId: 'codex:legacy-import',
        resourceId: codexPublicCommandScopeIds.legacyImport,
        invoke: () => options.legacyImport!.start({ sourceConversationIds }),
      });
      const result = executed.result;
      return { importId: result.importId, status: result.status, runs: result.runs.map(toLegacyImportApiRun) };
    } catch (error) {
      return sendCommandError(reply, error, () => sendLegacyImportError(reply, error));
    }
  });

  server.get('/api/codex-native/import/:importId', async (request: FastifyRequest<{ Params: { importId: string } }>, reply) => {
    if (!options.legacyImport) return unavailable(reply, 'ZEUS_CODEX_LEGACY_IMPORT_UNAVAILABLE', 'Codex legacy import is unavailable.');
    try {
      const result = options.legacyImport.get(request.params.importId);
      return { importId: result.importId, status: result.status, runs: result.runs.map(toLegacyImportApiRun) };
    } catch (error) {
      return sendLegacyImportError(reply, error);
    }
  });

  server.post('/api/codex/account/login/chatgpt', async (request: FastifyRequest<{ Body: CodexPublicMutationRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = application.parse<EmptyInput>({
        value: request.body,
        commandType: codexPublicCommandTypes.accountLoginStart,
        scopeKind: 'provider_account',
        scopeId: codexPublicCommandScopeIds.account,
      });
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'codex:account',
        resourceId: codexPublicCommandScopeIds.account,
        invoke: async () => {
          await options.account.ensureReady();
          return options.account.startLogin();
        },
      });
      return executed.result;
    } catch (error) {
      return sendCommandError(reply, error, () => options.sendNativeError(reply, error));
    }
  });

  server.post('/api/codex/account/login/:loginId/cancel', async (request: FastifyRequest<{ Params: { loginId: string }; Body: CodexPublicMutationRequest<CancelLoginInput> }>, reply) => {
    try {
      const parsed = application.parse<CancelLoginInput>({
        value: request.body,
        commandType: codexPublicCommandTypes.accountLoginCancel,
        scopeKind: 'provider_account',
        scopeId: codexPublicCommandScopeIds.account,
      });
      assertExactInputKeys(parsed.input, ['loginId'], parsed.command.commandType);
      const loginId = requiredMatchingIdentity(parsed.input.loginId, request.params.loginId, 'loginId');
      const executed = await application.executeExternal({
        parsed: { ...parsed, input: { loginId } },
        destinationId: 'codex:account',
        resourceId: loginId,
        invoke: async () => {
          await options.account.ensureReady();
          await options.account.cancelLogin(loginId);
          return { cancelled: true as const };
        },
      });
      return executed.result;
    } catch (error) {
      return sendCommandError(reply, error, () => options.sendNativeError(reply, error));
    }
  });

  server.get('/api/codex/remote-control', async (): Promise<CodexRemoteControlSnapshot> => options.remoteControl.buildSnapshot());

  server.post('/api/codex/remote-control/enable', async (request: FastifyRequest<{ Body: CodexPublicMutationRequest<EmptyInput> }>, reply) => {
    return executeRemoteToggle(request.body, reply, true);
  });

  server.post('/api/codex/remote-control/disable', async (request: FastifyRequest<{ Body: CodexPublicMutationRequest<EmptyInput> }>, reply) => {
    return executeRemoteToggle(request.body, reply, false);
  });

  async function executeRemoteToggle(body: unknown, reply: FastifyReply, enabled: boolean) {
    try {
      const parsed = application.parse<EmptyInput>({
        value: body,
        commandType: enabled ? codexPublicCommandTypes.remoteControlEnable : codexPublicCommandTypes.remoteControlDisable,
        scopeKind: 'provider_remote_control',
        scopeId: codexPublicCommandScopeIds.remoteControl,
      });
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'codex:remote-control',
        resourceId: codexPublicCommandScopeIds.remoteControl,
        invoke: async () => {
          await options.remoteControl.ensureReady(enabled || undefined);
          return enabled ? options.remoteControl.enable() : options.remoteControl.disable();
        },
        mutateBusinessState: (status) => options.remoteControl.persistEnabled({ enabled, status, occurredAt: options.now().toISOString() }),
      });
      options.remoteControl.adoptEnabled(enabled);
      return options.remoteControl.buildSnapshot(executed.result);
    } catch (error) {
      return sendCommandError(reply, error, () => options.sendNativeError(reply, error));
    }
  }

  server.post('/api/codex/remote-control/pairing', async (request: FastifyRequest<{ Body: CodexPublicMutationRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = application.parse<EmptyInput>({
        value: request.body,
        commandType: codexPublicCommandTypes.remoteControlPairingStart,
        scopeKind: 'provider_remote_control',
        scopeId: codexPublicCommandScopeIds.remoteControl,
      });
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'codex:remote-control',
        resourceId: codexPublicCommandScopeIds.remoteControl,
        beforeWrite: async () => {
          await options.remoteControl.ensureReady();
          if ((await options.remoteControl.readStatus()).status === 'disabled') throw codedError('ZEUS_CODEX_REMOTE_CONTROL_DISABLED', 'Enable Codex Remote Control before pairing a device.');
        },
        invoke: options.remoteControl.startPairing,
      });
      return { ...executed.result, claimed: false } satisfies CodexRemoteControlPairingSnapshot;
    } catch (error) {
      return sendCommandError(reply, error, () => options.sendNativeError(reply, error));
    }
  });

  server.post('/api/codex/remote-control/pairing/status', async (request: FastifyRequest<{ Body: { pairingCode?: string | null; manualPairingCode?: string | null } }>, reply) => {
    const pairingCode = optionalNonBlank(request.body?.pairingCode);
    const manualPairingCode = optionalNonBlank(request.body?.manualPairingCode);
    if (!pairingCode && !manualPairingCode) return reply.code(400).send({ error: 'ZEUS_CODEX_REMOTE_PAIRING_CODE_REQUIRED', message: 'A pairing code is required.' });
    await options.remoteControl.ensureReady();
    return options.remoteControl.readPairingStatus(pairingCode ? { pairingCode } : { manualPairingCode });
  });

  server.delete('/api/codex/remote-control/clients/:clientId', async (request: FastifyRequest<{ Params: { clientId: string }; Querystring: { environmentId?: string }; Body: CodexPublicMutationRequest<RevokeClientInput> }>, reply) => {
    try {
      const parsed = application.parse<RevokeClientInput>({
        value: request.body,
        commandType: codexPublicCommandTypes.remoteControlClientRevoke,
        scopeKind: 'provider_remote_control',
        scopeId: codexPublicCommandScopeIds.remoteControl,
      });
      assertExactInputKeys(parsed.input, ['clientId', 'environmentId'], parsed.command.commandType);
      const environmentId = requiredMatchingIdentity(parsed.input.environmentId, request.query.environmentId, 'environmentId');
      const clientId = requiredMatchingIdentity(parsed.input.clientId, request.params.clientId, 'clientId');
      const executed = await application.executeExternal({
        parsed: { ...parsed, input: { environmentId, clientId } },
        destinationId: 'codex:remote-control',
        resourceId: `${environmentId}:${clientId}`,
        invoke: async () => {
          await options.remoteControl.ensureReady();
          await options.remoteControl.revokeClient({ environmentId, clientId });
          return { revoked: true as const };
        },
      });
      if (!executed.result.revoked) throw codedError('ZEUS_CODEX_REMOTE_CLIENT_REVOKE_UNCONFIRMED', 'Codex remote client revocation is unconfirmed.');
      return options.remoteControl.buildSnapshot();
    } catch (error) {
      return sendCommandError(reply, error, () => options.sendNativeError(reply, error));
    }
  });
}

function sendCommandError(reply: FastifyReply, error: unknown, fallback: () => unknown): unknown {
  const commandError = codexPublicCommandHttpError(error);
  return commandError ? reply.code(commandError.statusCode).send(commandError.payload) : fallback();
}

function unavailable(reply: FastifyReply, code: string, message: string) {
  return reply.code(503).send({ error: code, message });
}

function sendLegacyImportError(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string' ? String((error as Error & { code: string }).code) : 'ZEUS_CODEX_LEGACY_IMPORT_FAILED';
  const status = code === 'ZEUS_CODEX_LEGACY_IMPORT_NOT_FOUND' ? 404 : code.endsWith('_INVALID') || code.endsWith('_INELIGIBLE') || code.endsWith('_CONFLICT') ? 400 : 500;
  return reply.code(status).send({ error: code, message: error instanceof Error ? error.message : 'Codex legacy import failed.' });
}

function sendSkillError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZeusSkillServiceError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const statusCode =
      'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode <= 599
        ? error.statusCode
        : error.code === 'ZEUS_PROJECT_NOT_FOUND'
          ? 404
          : error.code === 'ZEUS_SKILL_INPUT_INVALID'
            ? 400
            : 500;
    return reply.code(statusCode).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({ error: 'ZEUS_SKILL_OPERATION_FAILED', message: error instanceof Error ? error.message : 'Zeus Skill 操作失败。' });
}

function toLegacyImportApiRun(run: ZeusCodexLegacyImportRecord) {
  return {
    id: run.id,
    importId: run.providerImportId,
    sourceConversationId: run.sourceConversationId,
    targetConversationId: run.targetConversationId,
    status: run.status,
    targetThreadId: run.targetThreadId,
    failureStage: run.failureStage,
    failureMessage: run.failureMessage,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

function assertExactInputKeys(input: object, expected: readonly string[], commandType: string): void {
  const actual = Object.keys(input).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.length !== normalizedExpected.length || actual.some((key, index) => key !== normalizedExpected[index]))
    throw codedError('ZEUS_CODEX_PUBLIC_COMMAND_INVALID', `${commandType} input must contain exactly: ${normalizedExpected.join(', ')}.`);
}

function uniqueNonBlankStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || !entry.trim())) throw codedError('ZEUS_CODEX_LEGACY_IMPORT_SELECTION_INVALID', `${field} must contain nonblank conversation ids.`);
  const normalized = value.map((entry) => String(entry));
  if (new Set(normalized).size !== normalized.length) throw codedError('ZEUS_CODEX_LEGACY_IMPORT_SELECTION_INVALID', `${field} must contain unique conversation ids.`);
  return normalized;
}

function requiredMatchingIdentity(value: unknown, addressed: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== addressed) throw codedError('ZEUS_CODEX_PUBLIC_COMMAND_INVALID', `${field} must match the addressed resource.`);
  return value;
}

function optionalNonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalProjectId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new ZeusSkillServiceError('ZEUS_CODEX_SKILL_INPUT_INVALID', 'projectId 无效。');
  return value.trim();
}

function nullableProjectId(value: unknown): string | null {
  if (value === null) return null;
  return optionalProjectId(value);
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
