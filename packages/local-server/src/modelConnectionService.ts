import { randomUUID } from 'node:crypto';
import {
  buildModelsUrl,
  createTemplateConfiguredModelDefinition,
  listSelectableConnectionModels,
  mergeDiscoveredModels,
  modelConnectionSecretAccount,
  modelConnectionTemplates,
  modelRef,
  normalizeModelConnection,
  normalizeProjectModelSelection,
  normalizeStoredModelConnections,
  type ConfiguredModelDefinition,
  type ModelConnectionRecord,
  type ModelConnectionTemplateId,
  type ProjectModelSelection,
  type SaveModelConnectionInput,
  type SelectableConnectionModel,
} from '@zeus/ai-runtime';
import type { SecretStore } from '@zeus/security-core';
import type { SettingRepository } from '@zeus/storage';

export interface SaveModelConnectionRequest extends SaveModelConnectionInput {
  apiKey?: string;
  allowInsecureHttp?: boolean;
}

export interface ModelCatalogRefreshResult {
  connection: ModelConnectionRecord;
  discoveredModelIds: string[];
  addedModelIds: string[];
  checkedAt: string;
}

export interface ModelConnectionDiagnostic {
  ok: boolean;
  stage: 'configuration' | 'credential' | 'catalog';
  code: string;
  message: string;
  checkedAt: string;
  discoveredModelCount: number | null;
}

export interface ModelConnectionService {
  listMetadata(): ModelConnectionRecord[];
  list(): Promise<ModelConnectionRecord[]>;
  get(id: string): Promise<ModelConnectionRecord | undefined>;
  create(input: SaveModelConnectionRequest): Promise<ModelConnectionRecord>;
  update(id: string, input: SaveModelConnectionRequest): Promise<ModelConnectionRecord>;
  remove(id: string): Promise<void>;
  clearApiKey(id: string): Promise<ModelConnectionRecord>;
  refreshModels(id: string): Promise<ModelCatalogRefreshResult>;
  diagnose(id: string): Promise<ModelConnectionDiagnostic>;
  listSelectableModels(): Promise<SelectableConnectionModel[]>;
  getProjectSelection(projectId: string): Promise<ProjectModelSelection>;
  saveProjectSelection(projectId: string, value: unknown): Promise<ProjectModelSelection>;
  loadRuntimeConnections(): Promise<Array<ModelConnectionRecord & { apiKey?: string }>>;
}

const modelConnectionsSettingKey = 'models.connections';
const projectModelsSettingPrefix = 'project.models.';

/** 模型连接元数据进 SQLite settings，API Key 只进 SecretStore。 */
export function createModelConnectionService(options: { settings: SettingRepository; secretStore: SecretStore; save: () => Promise<void>; listProjectIds: () => string[]; now?: () => string; fetch?: typeof fetch }): ModelConnectionService {
  const now = options.now ?? (() => new Date().toISOString());
  const fetcher = options.fetch ?? fetch;

  function readStored(): ModelConnectionRecord[] {
    return normalizeStoredModelConnections(options.settings.getJson<unknown>(modelConnectionsSettingKey));
  }

  async function hydrate(records = readStored()): Promise<ModelConnectionRecord[]> {
    return Promise.all(
      records.map(async (record) => ({
        ...record,
        apiKeyConfigured: Boolean(await options.secretStore.getSecret(modelConnectionSecretAccount(record.id))),
      })),
    );
  }

  async function write(records: readonly ModelConnectionRecord[]): Promise<void> {
    // apiKeyConfigured 只是展示快照；读取时始终以 Keychain 为准。
    options.settings.setJson(
      modelConnectionsSettingKey,
      records.map((record) => ({ ...record, apiKeyConfigured: false })),
    );
    await options.save();
  }

  async function requireConnection(id: string): Promise<ModelConnectionRecord> {
    const connection = (await hydrate()).find((candidate) => candidate.id === id);
    if (!connection) throw serviceError('ZEUS_MODEL_CONNECTION_NOT_FOUND', '模型连接不存在。', 404);
    return connection;
  }

  async function saveConnection(id: string, input: SaveModelConnectionRequest, existing?: ModelConnectionRecord): Promise<ModelConnectionRecord> {
    const timestamp = now();
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (input.apiKey !== undefined && !apiKey) throw serviceError('ZEUS_MODEL_API_KEY_INVALID', 'API Key 不能为空。', 400);
    const record = normalizeModelConnection(input, {
      id,
      apiKeyConfigured: Boolean(apiKey || existing?.apiKeyConfigured),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    const requiresInsecureHttpConfirmation = record.baseUrl.startsWith('http://') && record.baseUrl !== existing?.baseUrl;
    if (requiresInsecureHttpConfirmation && input.allowInsecureHttp !== true) {
      throw serviceError('ZEUS_MODEL_CONNECTION_INSECURE_HTTP_CONFIRMATION_REQUIRED', 'HTTP 不会加密传输 API Key、请求内容或模型回复，请确认风险后再保存。', 409);
    }
    const records = readStored();
    const index = records.findIndex((candidate) => candidate.id === id);
    if (index >= 0) records[index] = record;
    else records.push(record);
    if (apiKey) await options.secretStore.setSecret(modelConnectionSecretAccount(id), apiKey);
    await write(records);
    return { ...record, apiKeyConfigured: Boolean(apiKey || existing?.apiKeyConfigured) };
  }

  async function fetchModelIds(connection: ModelConnectionRecord): Promise<string[]> {
    const apiKey = await options.secretStore.getSecret(modelConnectionSecretAccount(connection.id));
    if (!apiKey) throw serviceError('ZEUS_MODEL_API_KEY_REQUIRED', '请先为该连接配置 API Key。', 409);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetcher(buildModelsUrl(connection), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) throw serviceError('ZEUS_MODEL_CATALOG_REQUEST_FAILED', `模型目录请求失败，HTTP ${response.status}。`, 502);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw serviceError('ZEUS_MODEL_CATALOG_RESPONSE_INVALID', '模型目录没有返回有效的 JSON。', 502);
      }
      if (!isRecord(payload) || !Array.isArray(payload.data)) throw serviceError('ZEUS_MODEL_CATALOG_RESPONSE_INVALID', '模型目录没有返回兼容的 data 数组。', 502);
      const ids = payload.data.flatMap((item) => (isRecord(item) && typeof item.id === 'string' && item.id.trim() ? [item.id.trim()] : []));
      return [...new Set(ids)].slice(0, 200);
    } catch (error) {
      if (isServiceError(error)) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw serviceError('ZEUS_MODEL_CATALOG_TIMEOUT', '模型目录请求在 15 秒内没有完成。', 504);
      throw normalizeModelCatalogFetchError(error, connection);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    listMetadata() {
      // 用量汇总只需要供应源身份，不应为展示名称触发钥匙串读取。
      return readStored();
    },
    async list() {
      return hydrate();
    },
    async get(id) {
      return (await hydrate()).find((candidate) => candidate.id === id);
    },
    async create(input) {
      const id = `model_connection_${randomUUID().replace(/-/gu, '')}`;
      return saveConnection(id, withTemplateDefaults(input));
    },
    async update(id, input) {
      const existing = await requireConnection(id);
      return saveConnection(id, withTemplateDefaults(input), existing);
    },
    async remove(id) {
      await requireConnection(id);
      const references = [];
      for (const projectId of options.listProjectIds()) {
        const selection = await this.getProjectSelection(projectId);
        if (selection.allowedModelRefs.some((reference) => reference.startsWith(`${encodeURIComponent(id)}:`))) references.push(projectId);
      }
      if (references.length > 0) throw serviceError('ZEUS_MODEL_CONNECTION_IN_USE', `该连接仍被 ${references.length} 个项目使用，请先移除项目模型。`, 409);
      await options.secretStore.deleteSecret(modelConnectionSecretAccount(id));
      await write(readStored().filter((candidate) => candidate.id !== id));
    },
    async clearApiKey(id) {
      const existing = await requireConnection(id);
      await options.secretStore.deleteSecret(modelConnectionSecretAccount(id));
      return { ...existing, apiKeyConfigured: false, updatedAt: now() };
    },
    async refreshModels(id) {
      const connection = await requireConnection(id);
      const modelIds = await fetchModelIds(connection);
      const previousIds = new Set(connection.models.map((model) => model.id));
      const thinkingFormat = connection.templateId === 'custom' ? 'openai' : modelConnectionTemplates[connection.templateId].thinkingFormat;
      const models = mergeDiscoveredModels(connection.models, modelIds, thinkingFormat, connection.templateId);
      const updated = await saveConnection(connection.id, { ...connection, models }, connection);
      return {
        connection: updated,
        discoveredModelIds: modelIds,
        addedModelIds: modelIds.filter((modelId) => !previousIds.has(modelId)),
        checkedAt: now(),
      };
    },
    async diagnose(id) {
      const checkedAt = now();
      let connection: ModelConnectionRecord;
      try {
        connection = await requireConnection(id);
      } catch (error) {
        return { ok: false, stage: 'configuration', code: readServiceCode(error), message: error instanceof Error ? error.message : '连接配置无效。', checkedAt, discoveredModelCount: null };
      }
      if (!connection.apiKeyConfigured) return { ok: false, stage: 'credential', code: 'ZEUS_MODEL_API_KEY_REQUIRED', message: '连接配置有效，但尚未配置 API Key。', checkedAt, discoveredModelCount: null };
      try {
        const modelIds = await fetchModelIds(connection);
        return { ok: true, stage: 'catalog', code: 'ZEUS_MODEL_CATALOG_AVAILABLE', message: `连接成功并发现 ${modelIds.length} 个模型 ID；这不代表工具调用等能力已经通过。`, checkedAt, discoveredModelCount: modelIds.length };
      } catch (error) {
        return { ok: false, stage: 'catalog', code: readServiceCode(error), message: error instanceof Error ? error.message : '模型目录请求失败。', checkedAt, discoveredModelCount: null };
      }
    },
    async listSelectableModels() {
      return listSelectableConnectionModels(await hydrate());
    },
    async getProjectSelection(projectId) {
      const models = await this.listSelectableModels();
      return normalizeProjectModelSelection(projectId, options.settings.getJson<unknown>(projectModelsSettingPrefix + projectId), new Set(models.map((model) => model.id)));
    },
    async saveProjectSelection(projectId, value) {
      const models = await this.listSelectableModels();
      const availableRefs = new Set(models.map((model) => model.id));
      const selection = normalizeProjectModelSelection(projectId, value, availableRefs);
      const requested = isRecord(value) && Array.isArray(value.allowedModelRefs) ? value.allowedModelRefs : [];
      if (requested.some((reference) => typeof reference !== 'string' || !availableRefs.has(reference))) throw serviceError('ZEUS_PROJECT_MODEL_SELECTION_INVALID', '项目选择包含不存在的模型。', 400);
      options.settings.setJson(projectModelsSettingPrefix + projectId, selection);
      await options.save();
      return selection;
    },
    async loadRuntimeConnections() {
      const connections = await hydrate();
      return Promise.all(
        connections.map(async (connection) => ({
          ...connection,
          ...(connection.apiKeyConfigured ? { apiKey: await options.secretStore.getSecret(modelConnectionSecretAccount(connection.id)) } : {}),
        })),
      );
    },
  };
}

function withTemplateDefaults(input: SaveModelConnectionRequest): SaveModelConnectionRequest {
  const templateId: ModelConnectionTemplateId = input.templateId === 'deepseek' || input.templateId === 'bailian' || input.templateId === 'kimi' || input.templateId === 'zai' ? input.templateId : 'custom';
  const template = templateId === 'custom' ? null : modelConnectionTemplates[templateId];
  return {
    ...input,
    templateId,
    name: input.name || template?.name || '',
    baseUrl: input.baseUrl || template?.baseUrl || '',
    modelsPath: input.modelsPath ?? template?.modelsPath ?? '/models',
  };
}

export function createManualModel(id: string, templateId: ModelConnectionTemplateId): ConfiguredModelDefinition {
  return createTemplateConfiguredModelDefinition(id, templateId);
}

export function referencesForConnection(connection: ModelConnectionRecord): string[] {
  return connection.models.map((model) => modelRef(connection.id, model.id));
}

function serviceError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function isServiceError(error: unknown): error is Error & { code: string; statusCode: number } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('ZEUS_') && 'statusCode' in error && typeof error.statusCode === 'number';
}

function readServiceCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'ZEUS_MODEL_CONNECTION_FAILED';
}

function normalizeModelCatalogFetchError(error: unknown, connection: Pick<ModelConnectionRecord, 'baseUrl'>): Error & { code: string; statusCode: number } {
  const signals = collectErrorSignals(error);
  const codes = new Set(signals.map((signal) => signal.code).filter((code): code is string => Boolean(code)));
  const details = signals.map((signal) => signal.message.toLowerCase()).join('\n');

  if (connection.baseUrl.startsWith('https://') && (codes.has('ERR_SSL_PACKET_LENGTH_TOO_LONG') || codes.has('ERR_SSL_WRONG_VERSION_NUMBER') || details.includes('packet length too long') || details.includes('wrong version number'))) {
    return serviceError('ZEUS_MODEL_CATALOG_HTTPS_PROTOCOL_MISMATCH', '服务地址使用了 HTTPS，但目标端口没有提供可兼容的 HTTPS 服务。请先核对端口；如果该服务只支持明文 HTTP，请将服务地址改为 http:// 并重新保存。', 502);
  }

  if (
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].some((code) => codes.has(code)) ||
    details.includes('self-signed certificate') ||
    details.includes('unable to verify the first certificate')
  ) {
    return serviceError('ZEUS_MODEL_CATALOG_CERTIFICATE_UNTRUSTED', '服务端的 HTTPS 证书无法被本机信任。请为服务配置完整的可信证书链后重试。', 502);
  }

  if (codes.has('ERR_TLS_CERT_ALTNAME_INVALID') || details.includes('hostname/ip does not match certificate')) {
    return serviceError('ZEUS_MODEL_CATALOG_CERTIFICATE_HOST_MISMATCH', '服务端 HTTPS 证书与当前主机名或 IP 不匹配。请使用证书包含的服务地址，或更换匹配的证书。', 502);
  }

  if (codes.has('CERT_HAS_EXPIRED') || details.includes('certificate has expired')) {
    return serviceError('ZEUS_MODEL_CATALOG_CERTIFICATE_EXPIRED', '服务端 HTTPS 证书已过期。请更新证书后重试。', 502);
  }

  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
    return serviceError('ZEUS_MODEL_CATALOG_HOST_NOT_FOUND', '无法解析模型服务主机。请检查服务地址、DNS 和当前网络后重试。', 502);
  }

  if (codes.has('ECONNREFUSED')) {
    return serviceError('ZEUS_MODEL_CATALOG_CONNECTION_REFUSED', '模型服务拒绝连接。请检查服务是否已启动，以及主机、端口和防火墙配置。', 502);
  }

  if (codes.has('UND_ERR_CONNECT_TIMEOUT') || codes.has('ETIMEDOUT')) {
    return serviceError('ZEUS_MODEL_CATALOG_CONNECT_TIMEOUT', '在限定时间内无法连接模型服务。请检查服务地址、网络路由和防火墙后重试。', 504);
  }

  if (codes.has('ECONNRESET') || codes.has('UND_ERR_SOCKET')) {
    return serviceError('ZEUS_MODEL_CATALOG_CONNECTION_RESET', '模型服务在请求期间中断了连接。请检查服务或网关状态后重试。', 502);
  }

  if ([...codes].some((code) => code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) || details.includes('ssl routines') || details.includes('tls')) {
    return serviceError('ZEUS_MODEL_CATALOG_TLS_FAILED', '与模型服务的 HTTPS 握手失败。请检查服务端 TLS 配置、证书和协议版本后重试。', 502);
  }

  return serviceError('ZEUS_MODEL_CATALOG_NETWORK_FAILED', '无法连接模型目录。请检查服务地址和当前网络后重试。', 502);
}

function collectErrorSignals(error: unknown): Array<{ code: string | null; message: string }> {
  const signals: Array<{ code: string | null; message: string }> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { cause?: unknown; code?: unknown; message?: unknown };
    signals.push({
      code: typeof candidate.code === 'string' ? candidate.code : null,
      message: typeof candidate.message === 'string' ? candidate.message : '',
    });
    current = candidate.cause;
  }
  return signals;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
