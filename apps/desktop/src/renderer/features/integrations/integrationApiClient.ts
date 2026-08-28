import type { SaveZentaoInstanceRequest, ZentaoInstanceRecord, ZentaoInstanceVerifyResult } from '@zeus/shared';
import type { ModelConnectionDiagnostic, ModelConnectionRecord, ProjectModelSelection, SaveModelConnectionRequest, SecuritySecretsSnapshot, SelectablePiModel } from './integrationContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildIntegrationCommandRequest, integrationClientCommandTypes } from './integrationCommandClient.js';

export interface IntegrationApiClient {
  loadModelConnections: () => Promise<ModelConnectionRecord[]>;
  createModelConnection: (input: SaveModelConnectionRequest) => Promise<ModelConnectionRecord>;
  updateModelConnection: (connectionId: string, input: SaveModelConnectionRequest) => Promise<ModelConnectionRecord>;
  deleteModelConnection: (connectionId: string) => Promise<void>;
  clearModelConnectionApiKey: (connectionId: string) => Promise<ModelConnectionRecord>;
  refreshModelConnectionModels: (connectionId: string) => Promise<{ connection: ModelConnectionRecord; discoveredModelIds: string[]; addedModelIds: string[]; checkedAt: string }>;
  diagnoseModelConnection: (connectionId: string) => Promise<ModelConnectionDiagnostic>;
  loadZentaoInstances: () => Promise<ZentaoInstanceRecord[]>;
  createZentaoInstance: (input: SaveZentaoInstanceRequest) => Promise<ZentaoInstanceRecord>;
  updateZentaoInstance: (instanceId: string, input: SaveZentaoInstanceRequest) => Promise<ZentaoInstanceRecord>;
  deleteZentaoInstance: (instanceId: string) => Promise<void>;
  clearZentaoInstancePassword: (instanceId: string) => Promise<ZentaoInstanceRecord>;
  verifyZentaoInstance: (instanceId: string) => Promise<ZentaoInstanceVerifyResult>;
  loadSelectablePiModels: () => Promise<SelectablePiModel[]>;
  loadProjectModelSelection: (projectId: string) => Promise<ProjectModelSelection>;
  saveProjectModelSelection: (projectId: string, input: ProjectModelSelection) => Promise<ProjectModelSelection>;
  loadSecuritySecrets: () => Promise<SecuritySecretsSnapshot>;
  saveTelegramBotToken: (token: string) => Promise<SecuritySecretsSnapshot>;
  clearTelegramBotToken: () => Promise<SecuritySecretsSnapshot>;
  saveExternalApiKey: (key: string) => Promise<SecuritySecretsSnapshot>;
  clearExternalApiKey: () => Promise<SecuritySecretsSnapshot>;
}

export function createIntegrationApiClient(transport: LocalApiTransport): IntegrationApiClient {
  const modelConnectionCommand = async <TInput extends object>(
    connectionId: string,
    commandType: Parameters<typeof buildIntegrationCommandRequest>[0]['commandType'],
    operation: string,
    method: 'POST' | 'PUT' | 'DELETE',
    suffix: string,
    value: TInput,
  ) => {
    const body = await buildIntegrationCommandRequest({
      commandType,
      scopeKind: commandType === integrationClientCommandTypes.modelConnectionApiKeyClear ? 'provider_account' : 'provider_configuration',
      scopeId: () => (commandType === integrationClientCommandTypes.modelConnectionApiKeyClear ? `model_connection:${connectionId}:api_key` : connectionId),
      operationPrefix: `model_connection_${operation}`,
      value,
    });
    return transport.request(`${modelConnectionPath(connectionId)}${suffix}`, jsonRequest(method, body));
  };

  const zentaoCommand = async <TInput extends object>(
    instanceId: string,
    commandType: Parameters<typeof buildIntegrationCommandRequest>[0]['commandType'],
    operation: string,
    method: 'POST' | 'PUT' | 'DELETE',
    suffix: string,
    value: TInput,
  ) => {
    const body = await buildIntegrationCommandRequest({
      commandType,
      scopeKind: 'integration_account',
      scopeId: () => instanceId,
      operationPrefix: `zentao_${operation}`,
      value,
    });
    return transport.request(`${zentaoInstancePath(instanceId)}${suffix}`, jsonRequest(method, body));
  };

  const secretCommand = async <TInput extends object>(
    account: 'telegram.botToken' | 'external.apiKey',
    commandType: Parameters<typeof buildIntegrationCommandRequest>[0]['commandType'],
    operation: string,
    method: 'PUT' | 'DELETE',
    path: string,
    value: TInput,
  ) => {
    const body = await buildIntegrationCommandRequest({ commandType, scopeKind: 'provider_account', scopeId: () => account, operationPrefix: `provider_account_${operation}`, value });
    return transport.request(path, jsonRequest(method, body));
  };

  return {
    loadModelConnections: async () => (await transport.request<{ items: Awaited<ReturnType<IntegrationApiClient['loadModelConnections']>> }>('/api/model-connections')).items,
    createModelConnection: async (input) => {
      const body = await buildIntegrationCommandRequest({
        commandType: integrationClientCommandTypes.modelConnectionCreate,
        scopeKind: 'provider_configuration',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'model_connection',
        value: input,
      });
      return transport.request('/api/model-connections', jsonRequest('POST', body));
    },
    updateModelConnection: (connectionId, input) => modelConnectionCommand(connectionId, integrationClientCommandTypes.modelConnectionUpdate, 'update', 'PUT', '', input) as ReturnType<IntegrationApiClient['updateModelConnection']>,
    deleteModelConnection: (connectionId) => modelConnectionCommand(connectionId, integrationClientCommandTypes.modelConnectionDelete, 'delete', 'DELETE', '', {}) as ReturnType<IntegrationApiClient['deleteModelConnection']>,
    clearModelConnectionApiKey: (connectionId) =>
      modelConnectionCommand(connectionId, integrationClientCommandTypes.modelConnectionApiKeyClear, 'api_key_clear', 'DELETE', '/api-key', {}) as ReturnType<IntegrationApiClient['clearModelConnectionApiKey']>,
    refreshModelConnectionModels: (connectionId) =>
      modelConnectionCommand(connectionId, integrationClientCommandTypes.modelConnectionModelsRefresh, 'models_refresh', 'POST', '/models/refresh', {}) as ReturnType<IntegrationApiClient['refreshModelConnectionModels']>,
    diagnoseModelConnection: (connectionId) => modelConnectionCommand(connectionId, integrationClientCommandTypes.modelConnectionDiagnose, 'diagnose', 'POST', '/diagnose', {}) as ReturnType<IntegrationApiClient['diagnoseModelConnection']>,
    loadZentaoInstances: async () => (await transport.request<{ items: Awaited<ReturnType<IntegrationApiClient['loadZentaoInstances']>> }>('/api/zentao-instances')).items,
    createZentaoInstance: async (input) => {
      const body = await buildIntegrationCommandRequest({
        commandType: integrationClientCommandTypes.zentaoInstanceCreate,
        scopeKind: 'integration_account',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'zentao_instance',
        value: input,
      });
      return transport.request('/api/zentao-instances', jsonRequest('POST', body));
    },
    updateZentaoInstance: (instanceId, input) => zentaoCommand(instanceId, integrationClientCommandTypes.zentaoInstanceUpdate, 'instance_update', 'PUT', '', input) as ReturnType<IntegrationApiClient['updateZentaoInstance']>,
    deleteZentaoInstance: (instanceId) => zentaoCommand(instanceId, integrationClientCommandTypes.zentaoInstanceDelete, 'instance_delete', 'DELETE', '', {}) as ReturnType<IntegrationApiClient['deleteZentaoInstance']>,
    clearZentaoInstancePassword: (instanceId) =>
      zentaoCommand(instanceId, integrationClientCommandTypes.zentaoInstancePasswordClear, 'password_clear', 'DELETE', '/password', {}) as ReturnType<IntegrationApiClient['clearZentaoInstancePassword']>,
    verifyZentaoInstance: (instanceId) => zentaoCommand(instanceId, integrationClientCommandTypes.zentaoInstanceVerify, 'verify', 'POST', '/verify', {}) as ReturnType<IntegrationApiClient['verifyZentaoInstance']>,
    loadSelectablePiModels: async () => (await transport.request<{ items: Awaited<ReturnType<IntegrationApiClient['loadSelectablePiModels']>> }>('/api/models/catalog')).items,
    loadProjectModelSelection: (projectId) => transport.request(`/api/projects/${encodeURIComponent(projectId)}/model-selection`),
    saveProjectModelSelection: async (projectId, input) => {
      const value = { allowedModelRefs: input.allowedModelRefs, defaultModelRef: input.defaultModelRef };
      const body = await buildIntegrationCommandRequest({
        commandType: integrationClientCommandTypes.projectModelSelectionSave,
        scopeKind: 'settings',
        scopeId: () => `project_model_selection:${projectId}`,
        operationPrefix: 'project_model_selection',
        value,
      });
      return transport.request(`/api/projects/${encodeURIComponent(projectId)}/model-selection`, jsonRequest('PUT', body));
    },
    loadSecuritySecrets: () => transport.request('/api/security/secrets'),
    saveTelegramBotToken: (token) =>
      secretCommand('telegram.botToken', integrationClientCommandTypes.telegramBotTokenPut, 'telegram_token_put', 'PUT', '/api/security/secrets/telegram-bot-token', { token }) as ReturnType<IntegrationApiClient['saveTelegramBotToken']>,
    clearTelegramBotToken: () =>
      secretCommand('telegram.botToken', integrationClientCommandTypes.telegramBotTokenDelete, 'telegram_token_delete', 'DELETE', '/api/security/secrets/telegram-bot-token', {}) as ReturnType<IntegrationApiClient['clearTelegramBotToken']>,
    saveExternalApiKey: (key) =>
      secretCommand('external.apiKey', integrationClientCommandTypes.externalApiKeyPut, 'external_api_key_put', 'PUT', '/api/security/secrets/external-api-key', { key }) as ReturnType<IntegrationApiClient['saveExternalApiKey']>,
    clearExternalApiKey: () =>
      secretCommand('external.apiKey', integrationClientCommandTypes.externalApiKeyDelete, 'external_api_key_delete', 'DELETE', '/api/security/secrets/external-api-key', {}) as ReturnType<IntegrationApiClient['clearExternalApiKey']>,
  };
}

function modelConnectionPath(connectionId: string): string {
  return `/api/model-connections/${encodeURIComponent(connectionId)}`;
}

function zentaoInstancePath(instanceId: string): string {
  return `/api/zentao-instances/${encodeURIComponent(instanceId)}`;
}
