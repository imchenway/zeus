import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ModelConnectionRecord, ProjectModelSelection } from '@zeus/ai-runtime';
import type { SecretPresenceLabel, SecretStore } from '@zeus/security-core';
import type { SaveZentaoInstanceRequest, ZentaoInstanceRecord } from '@zeus/shared';
import type { AppendAuditLogInput, ProjectRepository } from '@zeus/storage';
import { IntegrationCommandApplication, integrationCommandHttpError, integrationCommandTypes, type IntegrationCommandRequest, type ParsedIntegrationCommand } from './integrationCommandApplication.js';
import type { ModelCatalogRefreshResult, ModelConnectionDiagnostic, ModelConnectionService, SaveModelConnectionRequest } from './modelConnectionService.js';
import type { ZentaoCredentialService } from './zentaoCredentialService.js';

type EmptyInput = Record<string, never>;
interface SaveTelegramTokenInput {
  token?: string;
}
interface SaveExternalApiKeyInput {
  key?: string;
}
interface ProjectModelSelectionInput {
  allowedModelRefs?: unknown;
  defaultModelRef?: unknown;
}
interface SecuritySecretsSnapshot {
  telegramBotToken: SecretPresenceLabel;
  externalApiKey: SecretPresenceLabel;
}

/** 仅注册凭据、集成账号和模型配置的 16 个公开 mutation；GET 与其他设置域不在此模块。 */
export function registerIntegrationCommandRoutes(options: {
  server: FastifyInstance;
  application: IntegrationCommandApplication;
  modelConnections: ModelConnectionService;
  zentaoCredentials: ZentaoCredentialService;
  projects: Pick<ProjectRepository, 'getById'>;
  secretStore: Pick<SecretStore, 'getSecret' | 'setSecret' | 'deleteSecret'>;
  refreshModelRuntime(): Promise<void>;
  readSecuritySecrets(): Promise<SecuritySecretsSnapshot>;
  appendAuditLog(input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }): void;
  redactSensitiveText(value: string): { text: string };
}): void {
  const { server, application } = options;

  server.post('/api/model-connections', async (request: FastifyRequest<{ Body: IntegrationCommandRequest<SaveModelConnectionRequest> }>, reply) => {
    try {
      const parsed = application.parse<SaveModelConnectionRequest>({
        value: request.body,
        commandType: integrationCommandTypes.modelConnectionCreate,
        scopeKind: 'provider_configuration',
        expectedScopeId: ({ operationIdentity }) => operationIdentity,
      });
      assertModelConnectionInput(parsed.input);
      requireIdentityPrefix(parsed.operationIdentity, 'model_connection_');
      const mutation = await application.executeExternal({
        parsed,
        destinationId: 'model_connection',
        resourceId: parsed.operationIdentity,
        externalOperationId: externalOperationId(parsed),
        sensitiveValues: sensitiveValues(parsed.input.apiKey),
        invoke: async () => {
          const connection = await options.modelConnections.createWithId(parsed.operationIdentity, parsed.input);
          await options.refreshModelRuntime();
          return connection;
        },
        mutateAcceptedBusinessState: (connection) => appendModelConnectionAudit(options, 'model.connection.created', connection, parsed.input.allowInsecureHttp === true),
      });
      return reply.code(mutation.replayed ? 200 : 201).send(mutation.result);
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '模型连接操作失败。');
    }
  });

  server.put('/api/model-connections/:connectionId', async (request: FastifyRequest<{ Params: { connectionId: string }; Body: IntegrationCommandRequest<SaveModelConnectionRequest> }>, reply) => {
    try {
      const parsed = parseResourceCommand<SaveModelConnectionRequest>(application, request.body, integrationCommandTypes.modelConnectionUpdate, 'provider_configuration', request.params.connectionId);
      assertModelConnectionInput(parsed.input);
      const mutation = await application.executeExternal({
        parsed,
        destinationId: 'model_connection',
        resourceId: request.params.connectionId,
        externalOperationId: externalOperationId(parsed),
        sensitiveValues: sensitiveValues(parsed.input.apiKey),
        invoke: async () => {
          const connection = await options.modelConnections.update(request.params.connectionId, parsed.input);
          await options.refreshModelRuntime();
          return connection;
        },
        mutateAcceptedBusinessState: (connection) => appendModelConnectionAudit(options, 'model.connection.updated', connection, parsed.input.allowInsecureHttp === true),
      });
      return mutation.result;
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '模型连接操作失败。');
    }
  });

  server.delete('/api/model-connections/:connectionId', async (request: FastifyRequest<{ Params: { connectionId: string }; Body: IntegrationCommandRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseResourceCommand<EmptyInput>(application, request.body, integrationCommandTypes.modelConnectionDelete, 'provider_configuration', request.params.connectionId);
      assertExactKeys(parsed.input, [], parsed.command.commandType);
      await application.executeExternal({
        parsed,
        destinationId: 'model_connection',
        resourceId: request.params.connectionId,
        externalOperationId: externalOperationId(parsed),
        invoke: async () => {
          await options.modelConnections.remove(request.params.connectionId);
          await options.refreshModelRuntime();
          return { deleted: true, connectionId: request.params.connectionId };
        },
        mutateAcceptedBusinessState: () => {
          options.appendAuditLog({ actorType: 'local_api', action: 'model.connection.deleted', resourceType: 'model_connection', resourceId: request.params.connectionId, payload: {} });
        },
      });
      return reply.code(204).send();
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '模型连接操作失败。');
    }
  });

  server.delete('/api/model-connections/:connectionId/api-key', async (request: FastifyRequest<{ Params: { connectionId: string }; Body: IntegrationCommandRequest<EmptyInput> }>, reply) => {
    try {
      const scopeId = modelApiKeyScope(request.params.connectionId);
      const parsed = parseResourceCommand<EmptyInput>(application, request.body, integrationCommandTypes.modelConnectionApiKeyClear, 'provider_account', scopeId);
      assertExactKeys(parsed.input, [], parsed.command.commandType);
      const mutation = await application.executeExternal({
        parsed,
        destinationId: 'provider_credential',
        resourceId: scopeId,
        externalOperationId: externalOperationId(parsed),
        invoke: async () => {
          const connection = await options.modelConnections.clearApiKey(request.params.connectionId);
          await options.refreshModelRuntime();
          return connection;
        },
        mutateAcceptedBusinessState: (connection) => {
          options.appendAuditLog({ actorType: 'local_api', action: 'model.connection.api_key.cleared', resourceType: 'model_connection', resourceId: connection.id, payload: {} });
        },
      });
      return mutation.result;
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '模型连接操作失败。');
    }
  });

  server.post('/api/model-connections/:connectionId/models/refresh', async (request: FastifyRequest<{ Params: { connectionId: string }; Body: IntegrationCommandRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseResourceCommand<EmptyInput>(application, request.body, integrationCommandTypes.modelConnectionModelsRefresh, 'provider_configuration', request.params.connectionId);
      assertExactKeys(parsed.input, [], parsed.command.commandType);
      const mutation = await application.executeExternal({
        parsed,
        destinationId: 'model_catalog',
        resourceId: request.params.connectionId,
        externalOperationId: externalOperationId(parsed),
        invoke: async (): Promise<ModelCatalogRefreshResult> => {
          const result = await options.modelConnections.refreshModels(request.params.connectionId);
          await options.refreshModelRuntime();
          return result;
        },
        mutateAcceptedBusinessState: (result) => {
          options.appendAuditLog({
            actorType: 'local_api',
            action: 'model.connection.catalog.refreshed',
            resourceType: 'model_connection',
            resourceId: result.connection.id,
            payload: { discoveredModelCount: result.discoveredModelIds.length, addedModelCount: result.addedModelIds.length, checkedAt: result.checkedAt },
          });
        },
      });
      return mutation.result;
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '模型目录刷新失败。');
    }
  });

  server.post('/api/model-connections/:connectionId/diagnose', async (request: FastifyRequest<{ Params: { connectionId: string }; Body: IntegrationCommandRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseResourceCommand<EmptyInput>(application, request.body, integrationCommandTypes.modelConnectionDiagnose, 'provider_configuration', request.params.connectionId);
      assertExactKeys(parsed.input, [], parsed.command.commandType);
      const probe = await application.executeReadOnlyProbe({ parsed, invoke: (): Promise<ModelConnectionDiagnostic> => options.modelConnections.diagnose(request.params.connectionId) });
      return probe.result;
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '模型连接诊断失败。');
    }
  });

  server.post('/api/zentao-instances', async (request: FastifyRequest<{ Body: IntegrationCommandRequest<SaveZentaoInstanceRequest> }>, reply) => {
    try {
      const parsed = application.parse<SaveZentaoInstanceRequest>({
        value: request.body,
        commandType: integrationCommandTypes.zentaoInstanceCreate,
        scopeKind: 'integration_account',
        expectedScopeId: ({ operationIdentity }) => operationIdentity,
      });
      assertZentaoInput(parsed.input);
      requireIdentityPrefix(parsed.operationIdentity, 'zentao_instance_');
      const mutation = await application.executeExternal({
        parsed,
        destinationId: 'zentao_account',
        resourceId: parsed.operationIdentity,
        externalOperationId: externalOperationId(parsed),
        sensitiveValues: sensitiveValues(parsed.input.password),
        invoke: (): Promise<ZentaoInstanceRecord> => options.zentaoCredentials.createWithId(parsed.operationIdentity, parsed.input),
        mutateAcceptedBusinessState: (instance) => appendZentaoAudit(options, 'zentao.instance.created', instance),
      });
      return reply.code(mutation.replayed ? 200 : 201).send(mutation.result);
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '禅道实例操作失败。');
    }
  });

  server.put('/api/zentao-instances/:instanceId', async (request: FastifyRequest<{ Params: { instanceId: string }; Body: IntegrationCommandRequest<SaveZentaoInstanceRequest> }>, reply) => {
    try {
      const parsed = parseResourceCommand<SaveZentaoInstanceRequest>(application, request.body, integrationCommandTypes.zentaoInstanceUpdate, 'integration_account', request.params.instanceId);
      assertZentaoInput(parsed.input);
      const mutation = await application.executeExternal({
        parsed,
        destinationId: 'zentao_account',
        resourceId: request.params.instanceId,
        externalOperationId: externalOperationId(parsed),
        sensitiveValues: sensitiveValues(parsed.input.password),
        invoke: (): Promise<ZentaoInstanceRecord> => options.zentaoCredentials.update(request.params.instanceId, parsed.input),
        mutateAcceptedBusinessState: (instance) => appendZentaoAudit(options, 'zentao.instance.updated', instance),
      });
      return mutation.result;
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '禅道实例操作失败。');
    }
  });

  server.delete('/api/zentao-instances/:instanceId', async (request: FastifyRequest<{ Params: { instanceId: string }; Body: IntegrationCommandRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseResourceCommand<EmptyInput>(application, request.body, integrationCommandTypes.zentaoInstanceDelete, 'integration_account', request.params.instanceId);
      assertExactKeys(parsed.input, [], parsed.command.commandType);
      await application.executeExternal({
        parsed,
        destinationId: 'zentao_account',
        resourceId: request.params.instanceId,
        externalOperationId: externalOperationId(parsed),
        invoke: async () => {
          await options.zentaoCredentials.remove(request.params.instanceId);
          return { deleted: true, instanceId: request.params.instanceId };
        },
        mutateAcceptedBusinessState: () => {
          options.appendAuditLog({ actorType: 'local_api', action: 'zentao.instance.deleted', resourceType: 'zentao_instance', resourceId: request.params.instanceId, payload: {} });
        },
      });
      return reply.code(204).send();
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '禅道实例操作失败。');
    }
  });

  server.delete('/api/zentao-instances/:instanceId/password', async (request: FastifyRequest<{ Params: { instanceId: string }; Body: IntegrationCommandRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseResourceCommand<EmptyInput>(application, request.body, integrationCommandTypes.zentaoInstancePasswordClear, 'integration_account', request.params.instanceId);
      assertExactKeys(parsed.input, [], parsed.command.commandType);
      const mutation = await application.executeExternal({
        parsed,
        destinationId: 'zentao_account',
        resourceId: request.params.instanceId,
        externalOperationId: externalOperationId(parsed),
        invoke: (): Promise<ZentaoInstanceRecord> => options.zentaoCredentials.clearPassword(request.params.instanceId),
        mutateAcceptedBusinessState: (instance) => {
          options.appendAuditLog({ actorType: 'local_api', action: 'zentao.instance.password.cleared', resourceType: 'zentao_instance', resourceId: instance.id, payload: {} });
        },
      });
      return mutation.result;
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '禅道实例操作失败。');
    }
  });

  server.post('/api/zentao-instances/:instanceId/verify', async (request: FastifyRequest<{ Params: { instanceId: string }; Body: IntegrationCommandRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseResourceCommand<EmptyInput>(application, request.body, integrationCommandTypes.zentaoInstanceVerify, 'integration_account', request.params.instanceId);
      assertExactKeys(parsed.input, [], parsed.command.commandType);
      const probe = await application.executeReadOnlyProbe({ parsed, invoke: () => options.zentaoCredentials.verify(request.params.instanceId) });
      return probe.result;
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '禅道实例验证失败。');
    }
  });

  server.put('/api/projects/:projectId/model-selection', async (request: FastifyRequest<{ Params: { projectId: string }; Body: IntegrationCommandRequest<ProjectModelSelectionInput> }>, reply) => {
    try {
      if (!options.projects.getById(request.params.projectId)) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
      const scopeId = projectModelSelectionScope(request.params.projectId);
      const parsed = parseResourceCommand<ProjectModelSelectionInput>(application, request.body, integrationCommandTypes.projectModelSelectionSave, 'settings', scopeId);
      assertExactKeys(parsed.input, ['allowedModelRefs', 'defaultModelRef'], parsed.command.commandType);
      const replay = application.replayAcceptedCore<ProjectModelSelectionInput, ProjectModelSelection>({ parsed, destinationId: 'settings', resourceId: scopeId });
      if (replay) return replay.result;
      const selection = await options.modelConnections.prepareProjectSelection(request.params.projectId, parsed.input);
      const mutation = application.executeCore({
        parsed,
        destinationId: 'settings',
        resourceId: scopeId,
        mutateBusinessState: () => {
          const saved = options.modelConnections.savePreparedProjectSelectionInCurrentTransaction(selection);
          options.appendAuditLog({
            actorType: 'local_api',
            action: 'project.model_selection.updated',
            resourceType: 'project',
            resourceId: request.params.projectId,
            payload: { modelCount: saved.allowedModelRefs.length, defaultModelRef: saved.defaultModelRef },
          });
          return saved;
        },
      });
      return mutation.result;
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '项目模型选择保存失败。');
    }
  });

  registerSecretPutRoute(options, {
    path: '/api/security/secrets/telegram-bot-token',
    commandType: integrationCommandTypes.telegramBotTokenPut,
    account: 'telegram.botToken',
    inputKey: 'token',
    action: 'security.secret.telegram_bot_token.saved',
  });
  registerSecretDeleteRoute(options, {
    path: '/api/security/secrets/telegram-bot-token',
    commandType: integrationCommandTypes.telegramBotTokenDelete,
    account: 'telegram.botToken',
    action: 'security.secret.telegram_bot_token.deleted',
  });
  registerSecretPutRoute(options, {
    path: '/api/security/secrets/external-api-key',
    commandType: integrationCommandTypes.externalApiKeyPut,
    account: 'external.apiKey',
    inputKey: 'key',
    action: 'security.secret.external_api_key.saved',
  });
  registerSecretDeleteRoute(options, {
    path: '/api/security/secrets/external-api-key',
    commandType: integrationCommandTypes.externalApiKeyDelete,
    account: 'external.apiKey',
    action: 'security.secret.external_api_key.deleted',
  });
}

function registerSecretPutRoute(
  options: Parameters<typeof registerIntegrationCommandRoutes>[0],
  route: {
    path: '/api/security/secrets/telegram-bot-token' | '/api/security/secrets/external-api-key';
    commandType: typeof integrationCommandTypes.telegramBotTokenPut | typeof integrationCommandTypes.externalApiKeyPut;
    account: 'telegram.botToken' | 'external.apiKey';
    inputKey: 'token' | 'key';
    action: string;
  },
): void {
  options.server.put(route.path, async (request: FastifyRequest<{ Body: IntegrationCommandRequest<SaveTelegramTokenInput | SaveExternalApiKeyInput> }>, reply) => {
    try {
      const parsed = parseResourceCommand<SaveTelegramTokenInput | SaveExternalApiKeyInput>(options.application, request.body, route.commandType, 'provider_account', route.account);
      assertExactKeys(parsed.input, [route.inputKey], parsed.command.commandType);
      const rawSecret = (parsed.input as Record<string, unknown>)[route.inputKey];
      const secret = typeof rawSecret === 'string' ? rawSecret.trim() : '';
      if (!secret) throw routeError('ZEUS_INVALID_SECRET', 'Secret value is required.', 400);
      const mutation = await options.application.executeExternal({
        parsed,
        destinationId: 'secret_store',
        resourceId: route.account,
        externalOperationId: externalOperationId(parsed),
        sensitiveValues: sensitiveValues(rawSecret, secret),
        invoke: async () => {
          await options.secretStore.setSecret(route.account, secret);
          return options.readSecuritySecrets();
        },
        mutateAcceptedBusinessState: () => {
          options.appendAuditLog({ actorType: 'local_api', action: route.action, resourceType: 'secret', resourceId: route.account, payload: { configured: true, secretValueStored: false } });
        },
      });
      return mutation.result;
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '凭据保存失败。');
    }
  });
}

function registerSecretDeleteRoute(
  options: Parameters<typeof registerIntegrationCommandRoutes>[0],
  route: {
    path: '/api/security/secrets/telegram-bot-token' | '/api/security/secrets/external-api-key';
    commandType: typeof integrationCommandTypes.telegramBotTokenDelete | typeof integrationCommandTypes.externalApiKeyDelete;
    account: 'telegram.botToken' | 'external.apiKey';
    action: string;
  },
): void {
  options.server.delete(route.path, async (request: FastifyRequest<{ Body: IntegrationCommandRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseResourceCommand<EmptyInput>(options.application, request.body, route.commandType, 'provider_account', route.account);
      assertExactKeys(parsed.input, [], parsed.command.commandType);
      const mutation = await options.application.executeExternal({
        parsed,
        destinationId: 'secret_store',
        resourceId: route.account,
        externalOperationId: externalOperationId(parsed),
        invoke: async () => {
          await options.secretStore.deleteSecret(route.account);
          return options.readSecuritySecrets();
        },
        mutateAcceptedBusinessState: () => {
          options.appendAuditLog({ actorType: 'local_api', action: route.action, resourceType: 'secret', resourceId: route.account, payload: { configured: false } });
        },
      });
      return mutation.result;
    } catch (error) {
      return sendIntegrationError(reply, error, options.redactSensitiveText, '凭据删除失败。');
    }
  });
}

function parseResourceCommand<TInput extends object>(
  application: IntegrationCommandApplication,
  value: unknown,
  commandType: Parameters<IntegrationCommandApplication['parse']>[0]['commandType'],
  scopeKind: Parameters<IntegrationCommandApplication['parse']>[0]['scopeKind'],
  scopeId: string,
): ParsedIntegrationCommand<TInput> {
  return application.parse<TInput>({ value, commandType, scopeKind, expectedScopeId: () => scopeId });
}

function externalOperationId(parsed: ParsedIntegrationCommand<object>): string {
  return `${parsed.command.commandType}:${parsed.operationIdentity}`;
}

function modelApiKeyScope(connectionId: string): string {
  return `model_connection:${connectionId}:api_key`;
}

function projectModelSelectionScope(projectId: string): string {
  return `project_model_selection:${projectId}`;
}

function appendModelConnectionAudit(
  options: Pick<Parameters<typeof registerIntegrationCommandRoutes>[0], 'appendAuditLog'>,
  action: 'model.connection.created' | 'model.connection.updated',
  connection: ModelConnectionRecord,
  insecureHttpAcknowledged: boolean,
): void {
  options.appendAuditLog({
    actorType: 'local_api',
    action,
    resourceType: 'model_connection',
    resourceId: connection.id,
    payload: {
      name: connection.name,
      templateId: connection.templateId,
      baseUrl: connection.baseUrl,
      modelCount: connection.models.length,
      apiKeyConfigured: connection.apiKeyConfigured,
      transportProtocol: new URL(connection.baseUrl).protocol.replace(':', ''),
      insecureHttpAcknowledged: connection.baseUrl.startsWith('http://') && insecureHttpAcknowledged,
    },
  });
}

function appendZentaoAudit(options: Pick<Parameters<typeof registerIntegrationCommandRoutes>[0], 'appendAuditLog'>, action: 'zentao.instance.created' | 'zentao.instance.updated', instance: ZentaoInstanceRecord): void {
  options.appendAuditLog({
    actorType: 'local_api',
    action,
    resourceType: 'zentao_instance',
    resourceId: instance.id,
    payload: { host: instance.host, basePath: instance.basePath, accountConfigured: Boolean(instance.account), passwordConfigured: instance.passwordConfigured },
  });
}

function assertModelConnectionInput(input: SaveModelConnectionRequest): void {
  assertAllowedKeys(input, ['name', 'templateId', 'baseUrl', 'modelsPath', 'enabled', 'models', 'apiKey', 'allowInsecureHttp'], 'model connection input');
}

function assertZentaoInput(input: SaveZentaoInstanceRequest): void {
  assertAllowedKeys(input, ['baseUrl', 'account', 'password'], 'Zentao instance input');
}

function assertAllowedKeys(value: object, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw routeError('ZEUS_INTEGRATION_COMMAND_INVALID', `${label} contains unsupported fields: ${unexpected.join(', ')}.`, 400);
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const normalized = [...expected].sort();
  if (actual.length === normalized.length && actual.every((key, index) => key === normalized[index])) return;
  throw routeError('ZEUS_INTEGRATION_COMMAND_INVALID', `${label} input must contain exactly: ${normalized.join(', ')}.`, 400);
}

function requireIdentityPrefix(value: string, prefix: string): void {
  if (!value.startsWith(prefix)) throw routeError('ZEUS_INTEGRATION_COMMAND_INVALID', `Create operationIdentity must start with ${prefix}.`, 400);
}

function sensitiveValues(...values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => (typeof value === 'string' && value ? [value, value.trim()] : [])).filter(Boolean))];
}

function routeError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function sendIntegrationError(reply: FastifyReply, error: unknown, redactSensitiveText: (value: string) => { text: string }, fallback: string) {
  const commandError = integrationCommandHttpError(error);
  if (commandError) return reply.code(commandError.statusCode).send(commandError.payload);
  const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  const code = typeof candidate?.code === 'string' ? candidate.code : 'ZEUS_INTEGRATION_COMMAND_FAILED';
  const statusCode = typeof candidate?.statusCode === 'number' && candidate.statusCode >= 400 && candidate.statusCode <= 599 ? candidate.statusCode : code.endsWith('_NOT_FOUND') ? 404 : 400;
  const rawMessage = typeof candidate?.message === 'string' && candidate.message.trim() ? candidate.message : fallback;
  const message = boundUtf8(redactSensitiveText(rawMessage).text, 2048);
  return reply.code(statusCode).send({ error: code, message });
}

function boundUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maximumBytes) return value;
  return `${bytes
    .subarray(0, maximumBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}
