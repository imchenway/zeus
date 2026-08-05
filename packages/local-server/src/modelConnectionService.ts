import { randomUUID } from 'node:crypto';
import {
  buildModelsUrl,
  createConfiguredModelDefinition,
  listSelectablePiModels,
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
  type SelectablePiModel,
} from '@zeus/ai-runtime';
import type { SecretStore } from '@zeus/security-core';
import type { SettingRepository } from '@zeus/storage';

export interface SaveModelConnectionRequest extends SaveModelConnectionInput {
  apiKey?: string;
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
  list(): Promise<ModelConnectionRecord[]>;
  get(id: string): Promise<ModelConnectionRecord | undefined>;
  create(input: SaveModelConnectionRequest): Promise<ModelConnectionRecord>;
  update(id: string, input: SaveModelConnectionRequest): Promise<ModelConnectionRecord>;
  remove(id: string): Promise<void>;
  clearApiKey(id: string): Promise<ModelConnectionRecord>;
  refreshModels(id: string): Promise<ModelCatalogRefreshResult>;
  diagnose(id: string): Promise<ModelConnectionDiagnostic>;
  listSelectableModels(): Promise<SelectablePiModel[]>;
  getProjectSelection(projectId: string): Promise<ProjectModelSelection>;
  saveProjectSelection(projectId: string, value: unknown): Promise<ProjectModelSelection>;
  loadRuntimeConnections(): Promise<Array<ModelConnectionRecord & { apiKey?: string }>>;
}

const modelConnectionsSettingKey = 'models.connections';
const projectModelsSettingPrefix = 'project.models.';

/** 模型连接元数据进 SQLite settings，API Key 只进 SecretStore。 */
export function createModelConnectionService(options: {
  settings: SettingRepository;
  secretStore: SecretStore;
  save: () => Promise<void>;
  listProjectIds: () => string[];
  now?: () => string;
  fetch?: typeof fetch;
}): ModelConnectionService {
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
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.data)) throw serviceError('ZEUS_MODEL_CATALOG_RESPONSE_INVALID', '模型目录没有返回兼容的 data 数组。', 502);
      const ids = payload.data.flatMap((item) => (isRecord(item) && typeof item.id === 'string' && item.id.trim() ? [item.id.trim()] : []));
      return [...new Set(ids)].slice(0, 200);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw serviceError('ZEUS_MODEL_CATALOG_TIMEOUT', '模型目录请求在 15 秒内没有完成。', 504);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
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
      const models = mergeDiscoveredModels(connection.models, modelIds, thinkingFormat);
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
      return listSelectablePiModels(await hydrate());
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
  const templateId: ModelConnectionTemplateId = input.templateId === 'deepseek' || input.templateId === 'bailian' ? input.templateId : 'custom';
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
  const thinkingFormat = templateId === 'custom' ? 'openai' : modelConnectionTemplates[templateId].thinkingFormat;
  return createConfiguredModelDefinition(id, {}, thinkingFormat);
}

export function referencesForConnection(connection: ModelConnectionRecord): string[] {
  return connection.models.map((model) => modelRef(connection.id, model.id));
}

function serviceError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function readServiceCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'ZEUS_MODEL_CONNECTION_FAILED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
