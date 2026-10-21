import type { SaveZentaoInstanceRequest, ZentaoInstanceRecord, ZentaoInstanceVerifyResult, ZentaoRemoteKind, ZentaoTaskSyncRequest, ZentaoTaskEffortRequest, ZentaoTaskEffortsResult } from '@zeus/shared';
import type {
  ModelCapabilityProbeSummary,
  ModelReasoningAuditResult,
  ModelReasoningOverrideOption,
  ModelConnectionDiagnostic,
  ModelConnectionRecord,
  SaveModelConnectionRequest,
  SecuritySecretsSnapshot,
  SelectablePiModel,
  ZentaoRemoteExecutionSummary,
  ZentaoRemoteItemDetail,
  ZentaoRemoteListResult,
  ZentaoRemoteProductSummary,
  ZentaoRemoteProjectSummary,
  ZentaoTaskSyncResult,
} from './integrationContracts.js';
import { jsonRequest, ZeusApiError, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildIntegrationCommandRequest, integrationClientCommandTypes } from './integrationCommandClient.js';

/** 禅道配置或认证结果变化后，工作区重新读取同一服务端状态。 */
export const zentaoInstancesChangedEvent = 'zeus-zentao-instances-changed';

export interface IntegrationApiClient {
  /** 自动识别整份价格页面，返回只读结果。 */
  refreshModelConnectionPricing: (connectionId: string) => Promise<ModelConnectionRecord>;
  loadModelConnections: () => Promise<ModelConnectionRecord[]>;
  createModelConnection: (input: SaveModelConnectionRequest) => Promise<ModelConnectionRecord>;
  updateModelConnection: (connectionId: string, input: SaveModelConnectionRequest) => Promise<ModelConnectionRecord>;
  deleteModelConnection: (connectionId: string) => Promise<void>;
  clearModelConnectionApiKey: (connectionId: string) => Promise<ModelConnectionRecord>;
  /** 用户主动查看当前连接的 API Key；不得用于列表加载或预取。 */
  revealModelConnectionApiKey: (connectionId: string) => Promise<{ apiKey: string | null }>;
  /** 该模型最近一次真实下发过的档位；没有记录时返回 null，不猜。 */
  loadModelConnectionLastSent: (connectionId: string, modelId: string) => Promise<{ effort: string | null; observedAt: string | null }>;
  /** 手工覆盖档位；传 null 表示恢复自动判定。 */
  saveModelConnectionReasoningOptions: (connectionId: string, modelId: string, input: { options: ModelReasoningOverrideOption[]; defaultId: string | null } | null) => Promise<ModelConnectionRecord>;
  /** 逐档体检：每个档位一次真实请求，只出证据不写配置。 */
  auditModelConnectionReasoningLevels: (connectionId: string, modelId: string) => Promise<ModelReasoningAuditResult>;
  refreshModelConnectionModels: (connectionId: string) => Promise<{ connection: ModelConnectionRecord; discoveredModelIds: string[]; addedModelIds: string[]; removedModelIds: string[]; checkedAt: string }>;
  probeModelConnectionModels: (connectionId: string) => Promise<ModelCapabilityProbeSummary>;
  diagnoseModelConnection: (connectionId: string) => Promise<ModelConnectionDiagnostic>;
  loadZentaoInstances: () => Promise<ZentaoInstanceRecord[]>;
  createZentaoInstance: (input: SaveZentaoInstanceRequest) => Promise<ZentaoInstanceRecord>;
  updateZentaoInstance: (instanceId: string, input: SaveZentaoInstanceRequest) => Promise<ZentaoInstanceRecord>;
  deleteZentaoInstance: (instanceId: string) => Promise<void>;
  clearZentaoInstancePassword: (instanceId: string) => Promise<ZentaoInstanceRecord>;
  /** 用户主动查看当前实例密码；不得用于列表加载或预取。 */
  revealZentaoInstancePassword: (instanceId: string) => Promise<{ password: string | null }>;
  verifyZentaoInstance: (instanceId: string) => Promise<ZentaoInstanceVerifyResult>;
  loadZentaoProjects: (instanceId: string) => Promise<ZentaoRemoteProjectSummary[]>;
  loadZentaoExecutions: (instanceId: string, projectId: string) => Promise<ZentaoRemoteExecutionSummary[]>;
  loadZentaoProducts: (instanceId: string) => Promise<ZentaoRemoteProductSummary[]>;
  loadZentaoItems: (instanceId: string, input: { kind: ZentaoRemoteKind; projectId: string; executionId?: string; productId?: string; query?: string; offset?: number; limit?: number }) => Promise<ZentaoRemoteListResult>;
  loadZentaoMyItems: (instanceId: string, input: { kind?: ZentaoRemoteKind; query?: string; offset?: number; limit?: number }) => Promise<ZentaoRemoteListResult>;
  loadZentaoItem: (instanceId: string, kind: ZentaoRemoteKind, objectId: string) => Promise<ZentaoRemoteItemDetail>;
  syncTaskToZentao: (instanceId: string, input: ZentaoTaskSyncRequest) => Promise<ZentaoTaskSyncResult>;
  /** 读取已关联任务的禅道工时，不传任意远端身份。 */
  loadZentaoTaskEfforts: (instanceId: string, taskId: string) => Promise<ZentaoTaskEffortsResult>;
  /** 当前账号显式提交一次工时登记。 */
  recordZentaoTaskEffort: (instanceId: string, input: ZentaoTaskEffortRequest) => Promise<Pick<ZentaoTaskEffortsResult, 'task'>>;
  loadSelectablePiModels: () => Promise<SelectablePiModel[]>;
  loadSecuritySecrets: () => Promise<SecuritySecretsSnapshot>;
  saveTelegramBotToken: (token: string) => Promise<SecuritySecretsSnapshot>;
  clearTelegramBotToken: () => Promise<SecuritySecretsSnapshot>;
  saveExternalApiKey: (key: string) => Promise<SecuritySecretsSnapshot>;
  clearExternalApiKey: () => Promise<SecuritySecretsSnapshot>;
}

export function createIntegrationApiClient(transport: LocalApiTransport): IntegrationApiClient {
  /** 尚未确认结果的任务写入保留原 Envelope，重新打开窗口也不会生成第二次写入。 */
  // ponytail: 此缓存限定在客户端生命周期；跨重启恢复原命令时应读取既有耐久回执，不新增重试队列。
  const pendingZentaoWrites = new Map<string, { signature: string; body: Promise<object> }>();
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
    /** 只对远端业务写入保留命令；设置操作沿用既有机制。 */
    const key = 'taskId' in value ? `${instanceId}:${operation}:${String(value.taskId)}` : null;
    /** 操作内容绑定原命令身份，未知结果不能靠修改表单重新发送。 */
    const signature = JSON.stringify(value);
    const previous = key ? pendingZentaoWrites.get(key) : undefined;
    if (previous && previous.signature !== signature) throw new ZeusApiError({ status: 409, error: 'ZEUS_INTEGRATION_COMMAND_OUTCOME_UNKNOWN', recoveryRequired: true, message: '前次禅道写入结果尚未确认，请先到禅道核对，勿重复提交。' });
    /** 同一操作在传输恢复和显式重读时始终复用原命令。 */
    const pending = previous ?? {
      signature,
      body: buildIntegrationCommandRequest({
        commandType,
        scopeKind: 'integration_account',
        scopeId: () => instanceId,
        operationPrefix: `zentao_${operation}`,
        value,
      }),
    };
    if (key) pendingZentaoWrites.set(key, pending);
    try {
      /** 传输成功后才能解除本次写入保护。 */
      const result = await transport.request(`${zentaoInstancePath(instanceId)}${suffix}`, jsonRequest(method, await pending.body));
      if (key) pendingZentaoWrites.delete(key);
      return result;
    } catch (error) {
      if (key && error instanceof ZeusApiError && error.status < 500 && !error.recoveryRequired && error.error !== 'ZEUS_INTEGRATION_COMMAND_OUTCOME_UNKNOWN') pendingZentaoWrites.delete(key);
      throw error;
    } finally {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(zentaoInstancesChangedEvent));
    }
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

  /** 读取时发现认证失效也通知所有入口重新核对服务端状态。 */
  async function zentaoRead<T>(path: string): Promise<T> {
    try {
      return await transport.request<T>(path);
    } catch (error) {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(zentaoInstancesChangedEvent));
      throw error;
    }
  }

  return {
    refreshModelConnectionPricing: (connectionId) =>
      modelConnectionCommand(connectionId, integrationClientCommandTypes.modelConnectionPricingRefresh, 'pricing_refresh', 'POST', '/pricing/refresh', {}) as ReturnType<IntegrationApiClient['refreshModelConnectionPricing']>,
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
    revealModelConnectionApiKey: (connectionId) => transport.request<{ apiKey: string | null }>(`${modelConnectionPath(connectionId)}/api-key`),
    loadModelConnectionLastSent: (connectionId, modelId) => transport.request<{ effort: string | null; observedAt: string | null }>(`${modelConnectionPath(connectionId)}/models/${encodeURIComponent(modelId)}/last-sent`),
    saveModelConnectionReasoningOptions: (connectionId, modelId, input) =>
      transport.request<ModelConnectionRecord>(`${modelConnectionPath(connectionId)}/models/${encodeURIComponent(modelId)}/reasoning-options`, jsonRequest('PUT', input === null ? { reset: true } : input)),
    auditModelConnectionReasoningLevels: (connectionId, modelId) => transport.request<ModelReasoningAuditResult>(`${modelConnectionPath(connectionId)}/models/${encodeURIComponent(modelId)}/reasoning-audit`, jsonRequest('POST', {})),
    clearModelConnectionApiKey: (connectionId) =>
      modelConnectionCommand(connectionId, integrationClientCommandTypes.modelConnectionApiKeyClear, 'api_key_clear', 'DELETE', '/api-key', {}) as ReturnType<IntegrationApiClient['clearModelConnectionApiKey']>,
    refreshModelConnectionModels: (connectionId) =>
      modelConnectionCommand(connectionId, integrationClientCommandTypes.modelConnectionModelsRefresh, 'models_refresh', 'POST', '/models/refresh', {}) as ReturnType<IntegrationApiClient['refreshModelConnectionModels']>,
    probeModelConnectionModels: (connectionId) =>
      modelConnectionCommand(connectionId, integrationClientCommandTypes.modelConnectionModelsProbe, 'models_probe', 'POST', '/models/probe', {}) as ReturnType<IntegrationApiClient['probeModelConnectionModels']>,
    diagnoseModelConnection: (connectionId) => modelConnectionCommand(connectionId, integrationClientCommandTypes.modelConnectionDiagnose, 'diagnose', 'POST', '/diagnose', {}) as ReturnType<IntegrationApiClient['diagnoseModelConnection']>,
    loadZentaoInstances: async () => (await transport.request<{ items: Awaited<ReturnType<IntegrationApiClient['loadZentaoInstances']>> }>('/api/zentao-instances')).items,
    // 密码响应由服务端禁止缓存，前端只在当前编辑器内短暂保留。
    revealZentaoInstancePassword: (instanceId) => transport.request(`${zentaoInstancePath(instanceId)}/password`),
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
    loadZentaoProjects: async (instanceId) => (await zentaoRead<{ items: ZentaoRemoteProjectSummary[] }>(`${zentaoInstancePath(instanceId)}/projects`)).items,
    loadZentaoExecutions: async (instanceId, projectId) => (await zentaoRead<{ items: ZentaoRemoteExecutionSummary[] }>(`${zentaoInstancePath(instanceId)}/projects/${encodeURIComponent(projectId)}/executions`)).items,
    loadZentaoProducts: async (instanceId) => (await zentaoRead<{ items: ZentaoRemoteProductSummary[] }>(`${zentaoInstancePath(instanceId)}/products`)).items,
    loadZentaoItems: (instanceId, input) => {
      const query = new URLSearchParams({ kind: input.kind, projectId: input.projectId });
      if (input.executionId) query.set('executionId', input.executionId);
      if (input.productId) query.set('productId', input.productId);
      if (input.query?.trim()) query.set('query', input.query.trim());
      if (input.offset !== undefined) query.set('offset', String(input.offset));
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      return zentaoRead<ZentaoRemoteListResult>(`${zentaoInstancePath(instanceId)}/items?${query.toString()}`);
    },
    loadZentaoMyItems: (instanceId, input) => {
      const query = new URLSearchParams();
      if (input.kind) query.set('kind', input.kind);
      if (input.query?.trim()) query.set('query', input.query.trim());
      if (input.offset !== undefined) query.set('offset', String(input.offset));
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      return zentaoRead<ZentaoRemoteListResult>(`${zentaoInstancePath(instanceId)}/my-items?${query.toString()}`);
    },
    loadZentaoItem: (instanceId, kind, objectId) => zentaoRead(`${zentaoInstancePath(instanceId)}/items/${encodeURIComponent(kind)}/${encodeURIComponent(objectId)}`),
    syncTaskToZentao: (instanceId, input) => zentaoCommand(instanceId, integrationClientCommandTypes.zentaoTaskSync, 'task_sync', 'POST', '/sync-task', input) as ReturnType<IntegrationApiClient['syncTaskToZentao']>,
    loadZentaoTaskEfforts: (instanceId, taskId) => zentaoRead(`${zentaoInstancePath(instanceId)}/tasks/${encodeURIComponent(taskId)}/efforts`),
    recordZentaoTaskEffort: (instanceId, input) =>
      zentaoCommand(instanceId, integrationClientCommandTypes.zentaoTaskEffortRecord, 'task_effort_record', 'POST', `/tasks/${encodeURIComponent(input.taskId)}/efforts`, input) as ReturnType<IntegrationApiClient['recordZentaoTaskEffort']>,
    loadSelectablePiModels: async () => (await transport.request<{ items: Awaited<ReturnType<IntegrationApiClient['loadSelectablePiModels']>> }>('/api/models/catalog')).items,
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
