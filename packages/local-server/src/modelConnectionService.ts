import { createModelPricingService } from './modelPricingService.js';
import { userFacingErrorCause, type UserFacingErrorCause } from '@zeus/shared';
import { randomUUID } from 'node:crypto';
import {
  buildModelsUrl,
  createTemplateConfiguredModelDefinition,
  listSelectableConnectionModels,
  modelConnectionSecretAccount,
  modelConnectionTemplates,
  modelRef,
  normalizeModelConnection,
  normalizeStoredModelConnections,
  auditConfiguredModelReasoningLevels,
  probeConfiguredModel,
  generateConfiguredModelText,
  syncDiscoveredModels,
  isPiThinkingLevel,
  type ConfiguredModelDefinition,
  type ModelConnectionRecord,
  type ModelConnectionTemplateId,
  type ConfiguredReasoningOption,
  type ModelProbeResult,
  type ReasoningLevelAuditResult,
  type SaveModelConnectionInput,
  type SelectableConnectionModel,
} from '@zeus/ai-runtime';
import type { SecretStore } from './securityCore.js';
import type { SettingRepository } from '@zeus/storage';

export interface SaveModelConnectionRequest extends SaveModelConnectionInput {
  apiKey?: string;
  allowInsecureHttp?: boolean;
}

/** 用户手工覆盖某个模型档位清单的输入。 */
export interface ModelReasoningOverrideInput {
  options: Array<{ id: string; label?: string | null; piLevel: string; wire: string | null }>;
  defaultId: string | null;
}

export interface ModelCatalogRefreshResult {
  connection: ModelConnectionRecord;
  discoveredModelIds: string[];
  addedModelIds: string[];
  removedModelIds: string[];
  checkedAt: string;
}

/** 能力探测回执：每个模型一条结论，未探测的模型单独列出原因。 */
export interface ModelCapabilityProbeSummary {
  connection: ModelConnectionRecord;
  results: ModelProbeResult[];
  /** 本次没有探测的已启用模型，界面需要如实说明，不能假装全部探测过。 */
  skippedModelIds: string[];
  checkedAt: string;
}

export interface ModelConnectionDiagnostic {
  /** 检查失败保留底层原因，不改变检查结果或错误码。 */
  cause?: UserFacingErrorCause;
  ok: boolean;
  stage: 'configuration' | 'credential' | 'catalog';
  code: string;
  message: string;
  checkedAt: string;
  discoveredModelCount: number | null;
}

export interface ModelConnectionService {
  /** 公开价格服务，与密钥和模型配置隔离。 */
  pricing: ReturnType<typeof createModelPricingService>;
  /** 手工读取价格后返回连接展示状态。 */
  refreshPricing(id: string): Promise<ModelConnectionRecord>;
  listMetadata(): ModelConnectionRecord[];
  list(): Promise<ModelConnectionRecord[]>;
  get(id: string): Promise<ModelConnectionRecord | undefined>;
  create(input: SaveModelConnectionRequest): Promise<ModelConnectionRecord>;
  createWithId(id: string, input: SaveModelConnectionRequest): Promise<ModelConnectionRecord>;
  update(id: string, input: SaveModelConnectionRequest): Promise<ModelConnectionRecord>;
  remove(id: string): Promise<void>;
  clearApiKey(id: string): Promise<ModelConnectionRecord>;
  /** 读取当前连接的 API Key；只在用户主动点开时调用，绝不用于列表加载或预取。 */
  revealApiKey(id: string): Promise<string | null>;
  /** 覆盖某个模型的推理档位清单；传 null 表示清除覆盖、回到自动判定。 */
  saveModelReasoningOptions(id: string, modelId: string, input: ModelReasoningOverrideInput | null): Promise<ModelConnectionRecord>;
  /** 逐档体检：对清单里每个档位各发一次真实请求并比较思考用量；只出证据，不写配置。 */
  auditModelReasoningLevels(id: string, modelId: string): Promise<ReasoningLevelAuditResult>;
  refreshModels(id: string): Promise<ModelCatalogRefreshResult>;
  /** 对已启用模型真实探测一次，用观测结果替换静态能力声明。 */
  probeModels(id: string): Promise<ModelCapabilityProbeSummary>;
  diagnose(id: string): Promise<ModelConnectionDiagnostic>;
  listSelectableModels(): Promise<SelectableConnectionModel[]>;
  loadRuntimeConnections(): Promise<Array<ModelConnectionRecord & { apiKey?: string }>>;
}

const modelConnectionsSettingKey = 'models.connections';

/** 单次能力探测的模型上限；探测会产生真实用量，必须有明确上限。 */
const maximumProbeModelCount = 12;
/** 探测并发上限：兼顾墙钟时间与供应商限流，避免一次点击把并发全部打满。 */
const probeConcurrency = 3;

/** 模型连接元数据进 SQLite settings，API Key 只进 SecretStore。 */
export function createModelConnectionService(options: {
  settings: SettingRepository;
  secretStore: SecretStore;
  save: () => Promise<void>;
  now?: () => string;
  fetch?: typeof fetch;
  readPricingPage?: (input: { url: string }) => Promise<string>;
}): ModelConnectionService {
  const now = options.now ?? (() => new Date().toISOString());
  const fetcher = options.fetch ?? fetch;

  function readStored(): ModelConnectionRecord[] {
    return normalizeStoredModelConnections(options.settings.getJson<unknown>(modelConnectionsSettingKey));
  }

  /** 使用现有连接的模型能力读取价格，页面内容不进入任何用户会话。 */
  const pricing = createModelPricingService({
    readPricingPage: options.readPricingPage,
    settings: options.settings,
    connections: readStored,
    save: options.save,
    now,
    async extract(connection, text, system, signal) {
      const model = connection.models.find((candidate) => candidate.enabled);
      const apiKey = await options.secretStore.getSecret(modelConnectionSecretAccount(connection.id));
      if (!model || !apiKey) throw new Error('页面需要自动识别，请先启用此连接的模型并配置密钥。');
      return generateConfiguredModelText({ connection, model, apiKey, text, system, signal });
    },
  });

  async function hydrate(records = readStored()): Promise<ModelConnectionRecord[]> {
    return Promise.all(
      records.map(async (record) => ({
        ...record,
        pricingCatalog: pricing.read(record),
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
    return { ...record, apiKeyConfigured: Boolean(apiKey || existing?.apiKeyConfigured), pricingCatalog: pricing.read(record) };
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
      if (!response.ok)
        throw Object.assign(serviceError('ZEUS_MODEL_CATALOG_REQUEST_FAILED', `模型目录请求失败，HTTP ${response.status}。`, 502), { cause: { code: `ZEUS_MODEL_HTTP_${response.status}`, message: `HTTP ${response.status}` } });
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
      throw Object.assign(normalizeModelCatalogFetchError(error, connection), { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    pricing,
    async refreshPricing(id) {
      const connection = await requireConnection(id);
      return { ...connection, pricingCatalog: await pricing.refresh(connection) };
    },
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
    async createWithId(id, input) {
      if (!/^model_connection_[a-zA-Z0-9_-]{8,200}$/u.test(id)) throw serviceError('ZEUS_MODEL_CONNECTION_ID_INVALID', '模型连接身份无效。', 400);
      if (readStored().some((candidate) => candidate.id === id)) throw serviceError('ZEUS_MODEL_CONNECTION_ALREADY_EXISTS', '模型连接已存在。', 409);
      return saveConnection(id, withTemplateDefaults(input));
    },
    async update(id, input) {
      const existing = await requireConnection(id);
      return saveConnection(id, withTemplateDefaults(input), existing);
    },
    async remove(id) {
      await requireConnection(id);
      await options.secretStore.deleteSecret(modelConnectionSecretAccount(id));
      await write(readStored().filter((candidate) => candidate.id !== id));
    },
    async clearApiKey(id) {
      const existing = await requireConnection(id);
      await options.secretStore.deleteSecret(modelConnectionSecretAccount(id));
      return { ...existing, apiKeyConfigured: false, updatedAt: now() };
    },
    async saveModelReasoningOptions(id, modelId, input) {
      const connection = await requireConnection(id);
      const model = requireModel(connection, modelId);
      /** 清除覆盖时不写任何档位，下一次读取会按官方档案/目录/家族重新判定。 */
      const reasoning =
        input === null
          ? { ...model.capability.reasoning, state: 'unverified' as const, options: [], defaultId: null, basis: 'unidentified' as const }
          : (() => {
              const options = normalizeReasoningOverrides(input.options);
              const defaultId = input.defaultId && options.some((option) => option.id === input.defaultId) ? input.defaultId : (options[0]?.id ?? null);
              return { ...model.capability.reasoning, state: 'supported' as const, options, defaultId, basis: 'user' as const };
            })();
      const models = connection.models.map((candidate) => (candidate.id === model.id ? { ...candidate, capability: { ...candidate.capability, reasoning } } : candidate));
      return saveConnection(connection.id, { ...connection, models }, connection);
    },
    async auditModelReasoningLevels(id, modelId) {
      const connection = await requireConnection(id);
      const model = requireModel(connection, modelId);
      if (model.capability.reasoning.options.length === 0) throw serviceError('ZEUS_MODEL_REASONING_UNAVAILABLE', '这个模型还没有档位清单，先设置档位再体检。', 409);
      const apiKey = await options.secretStore.getSecret(modelConnectionSecretAccount(id));
      if (!apiKey) throw serviceError('ZEUS_MODEL_API_KEY_REQUIRED', '请先为该连接配置 API Key。', 409);
      return auditConfiguredModelReasoningLevels({ connection, model, apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) });
    },
    async revealApiKey(id) {
      // 先确认连接存在，避免用一个不存在的 ID 去探测钥匙串里有没有别的条目。
      await requireConnection(id);
      return (await options.secretStore.getSecret(modelConnectionSecretAccount(id))) ?? null;
    },
    async refreshModels(id) {
      const connection = await requireConnection(id);
      const modelIds = await fetchModelIds(connection);
      const thinkingFormat = connection.templateId === 'custom' ? 'openai' : modelConnectionTemplates[connection.templateId].thinkingFormat;
      const sync = syncDiscoveredModels(connection.models, modelIds, thinkingFormat, { templateId: connection.templateId, baseUrl: connection.baseUrl });
      const updated = await saveConnection(connection.id, { ...connection, models: sync.models }, connection);
      return {
        connection: updated,
        discoveredModelIds: modelIds,
        addedModelIds: sync.addedModelIds,
        removedModelIds: sync.removedModelIds,
        checkedAt: now(),
      };
    },
    async probeModels(id) {
      const connection = await requireConnection(id);
      const apiKey = await options.secretStore.getSecret(modelConnectionSecretAccount(id));
      if (!apiKey) throw serviceError('ZEUS_MODEL_API_KEY_REQUIRED', '请先为该连接配置 API Key。', 409);
      const enabledModels = connection.models.filter((model) => model.enabled);
      // ponytail: 单次点击最多探测前 12 个已启用模型、最多 3 路并发，避免几十个模型时一次点击打爆
      // 额度和连接；需要更多就再点一次，或只启用要用的模型。
      const targets = enabledModels.slice(0, maximumProbeModelCount);
      const results: ModelProbeResult[] = [];
      /** 探测游标与并行度；单模型要发 1～2 次真实请求，纯串行会让十几个模型跑到分钟级。 */
      let cursor = 0;
      const runWorker = async (): Promise<void> => {
        while (cursor < targets.length) {
          const model = targets[cursor];
          cursor += 1;
          if (!model) return;
          results.push(await probeConfiguredModel({ connection, model, apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) }));
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(probeConcurrency, targets.length)) }, runWorker));
      const probedById = new Map(results.map((result) => [result.modelId, result]));
      const models = connection.models.map((model) => {
        const result = probedById.get(model.id);
        return result ? { ...model, servedModelId: result.servedModelId, capability: result.capability } : model;
      });
      const updated = await saveConnection(connection.id, { ...connection, models }, connection);
      return { connection: updated, results, skippedModelIds: enabledModels.slice(maximumProbeModelCount).map((model) => model.id), checkedAt: now() };
    },
    async diagnose(id) {
      const checkedAt = now();
      let connection: ModelConnectionRecord;
      try {
        connection = await requireConnection(id);
      } catch (error) {
        return { ok: false, stage: 'configuration', code: readServiceCode(error), cause: userFacingErrorCause(error), message: error instanceof Error ? error.message : '连接配置无效。', checkedAt, discoveredModelCount: null };
      }
      if (!connection.apiKeyConfigured) return { ok: false, stage: 'credential', code: 'ZEUS_MODEL_API_KEY_REQUIRED', message: '连接配置有效，但尚未配置 API Key。', checkedAt, discoveredModelCount: null };
      try {
        const modelIds = await fetchModelIds(connection);
        return { ok: true, stage: 'catalog', code: 'ZEUS_MODEL_CATALOG_AVAILABLE', message: `连接成功并发现 ${modelIds.length} 个模型 ID；这不代表工具调用等能力已经通过。`, checkedAt, discoveredModelCount: modelIds.length };
      } catch (error) {
        return { ok: false, stage: 'catalog', code: readServiceCode(error), cause: userFacingErrorCause(error), message: error instanceof Error ? error.message : '模型目录请求失败。', checkedAt, discoveredModelCount: null };
      }
    },
    async listSelectableModels() {
      return listSelectableConnectionModels(await hydrate());
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
  // 手工新增的模型没有独立地址，用模板自带的官方地址参与档位判定；自定义连接没有地址可依据。
  const baseUrl = templateId === 'custom' ? '' : modelConnectionTemplates[templateId].baseUrl;
  return createTemplateConfiguredModelDefinition(id, { templateId, baseUrl });
}

export function referencesForConnection(connection: ModelConnectionRecord): string[] {
  return connection.models.map((model) => modelRef(connection.id, model.id));
}

/** 在连接里取出指定模型；不存在时给出明确的 404，而不是静默改别的模型。 */
function requireModel(connection: ModelConnectionRecord, modelId: string): ConfiguredModelDefinition {
  const model = connection.models.find((candidate) => candidate.id === modelId);
  if (!model) throw serviceError('ZEUS_MODEL_NOT_FOUND', '模型不存在于该连接中。', 404);
  return model;
}

/**
 * 校验用户手工填写的档位清单：
 * 档位词必须是 Pi 认识的七个之一、同一个 Pi 档位不能出现两次（否则映射会互相覆盖）、最多七项。
 */
function normalizeReasoningOverrides(value: unknown): ConfiguredReasoningOption[] {
  if (!Array.isArray(value)) throw serviceError('ZEUS_MODEL_REASONING_INVALID', '档位清单必须是数组。', 400);
  if (value.length === 0) throw serviceError('ZEUS_MODEL_REASONING_INVALID', '档位清单至少要有一项；不想要档位就恢复自动判定。', 400);
  if (value.length > 7) throw serviceError('ZEUS_MODEL_REASONING_INVALID', 'Pi 只认识七个档位词，最多只能配置七项。', 400);
  const options: ConfiguredReasoningOption[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') throw serviceError('ZEUS_MODEL_REASONING_INVALID', '档位项必须是对象。', 400);
    const id = typeof candidate.id === 'string' ? candidate.id.trim().slice(0, 60) : '';
    if (!id) throw serviceError('ZEUS_MODEL_REASONING_INVALID', '档位名不能为空。', 400);
    if (!isPiThinkingLevel(candidate.piLevel)) throw serviceError('ZEUS_MODEL_REASONING_INVALID', `Pi 不认识档位词：${String(candidate.piLevel)}。`, 400);
    if (options.some((option) => option.id === id)) throw serviceError('ZEUS_MODEL_REASONING_INVALID', `档位名重复：${id}。`, 400);
    if (options.some((option) => option.piLevel === candidate.piLevel)) throw serviceError('ZEUS_MODEL_REASONING_INVALID', `同一个 Pi 档位只能配置一次：${candidate.piLevel}。`, 400);
    const wire = candidate.wire === null ? null : typeof candidate.wire === 'string' ? candidate.wire.trim().slice(0, 60) : null;
    const label = typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim().slice(0, 40) : null;
    options.push({ id, label, piLevel: candidate.piLevel, wire });
  }
  return options;
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
