import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { MOONSHOTAI_MODELS } from '@earendil-works/pi-ai/providers/moonshotai.models';
import { OPENCODE_MODELS } from '@earendil-works/pi-ai/providers/opencode.models';
import { QWEN_TOKEN_PLAN_CN_MODELS } from '@earendil-works/pi-ai/providers/qwen-token-plan-cn.models';
import { ZAI_MODELS } from '@earendil-works/pi-ai/providers/zai.models';

export type ModelConnectionTemplateId = 'custom' | 'deepseek' | 'bailian' | 'kimi' | 'zai';

export type ModelCapabilityState = 'supported' | 'unsupported' | 'unverified';

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type OpenAiThinkingFormat = 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling';

export type ModelProtocolFamily = 'openai_responses' | 'openai_completions' | 'anthropic_messages';

export type ModelAuthenticationScheme = 'protocol_default' | 'bearer' | 'x_api_key';

export interface ModelCapabilityEvidence {
  source: 'template' | 'catalog' | 'manual' | 'probe';
  state: ModelCapabilityState;
  checkedAt: string | null;
  reason: string;
}

export interface ConfiguredModelCapability {
  reasoning: {
    state: ModelCapabilityState;
    levels: PiThinkingLevel[];
    defaultLevel: PiThinkingLevel;
    thinkingFormat: OpenAiThinkingFormat;
    levelMap: Partial<Record<PiThinkingLevel, string | null>>;
    source: ModelCapabilityEvidence['source'];
    checkedAt: string | null;
    reason: string;
  };
  tools: ModelCapabilityEvidence;
  imageInput: ModelCapabilityEvidence;
  streaming: ModelCapabilityEvidence;
  usage: ModelCapabilityEvidence;
}

export interface ConfiguredModelDefinition {
  id: string;
  displayName: string;
  enabled: boolean;
  supports1MContext: boolean;
  contextWindow: number;
  maxTokens: number;
  speedLabel: 'standard' | 'high_speed' | 'flash' | 'turbo';
  runtimeAdapter: 'codex_app_server' | 'pi_sdk';
  protocolFamily: ModelProtocolFamily;
  authenticationScheme: ModelAuthenticationScheme;
  capability: ConfiguredModelCapability;
}

export interface ModelConnectionRecord {
  id: string;
  name: string;
  templateId: ModelConnectionTemplateId;
  baseUrl: string;
  modelsPath: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
  models: ConfiguredModelDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface SaveModelConnectionInput {
  id?: string;
  name: string;
  templateId?: ModelConnectionTemplateId;
  baseUrl: string;
  modelsPath?: string;
  enabled?: boolean;
  models?: ConfiguredModelDefinition[];
}

export interface ProjectModelSelection {
  projectId: string;
  allowedModelRefs: string[];
  defaultModelRef: string | null;
}

export interface SelectableConnectionModel {
  id: string;
  model: string;
  displayName: string;
  sourceId: string;
  sourceName: string;
  agentKind: 'codex' | 'pi';
  enabled: boolean;
  available: boolean;
  availabilityReason: string;
  supportedReasoningEfforts: PiThinkingLevel[];
  defaultReasoningEffort: PiThinkingLevel | null;
  serviceTiers: [];
  defaultServiceTier: null;
  speedLabel: ConfiguredModelDefinition['speedLabel'];
  tools: ModelCapabilityState;
  imageInput: ModelCapabilityState;
  runtimeAdapter: ConfiguredModelDefinition['runtimeAdapter'];
  protocolFamily: ConfiguredModelDefinition['protocolFamily'];
  authenticationScheme: ConfiguredModelDefinition['authenticationScheme'];
  supports1MContext: boolean;
  contextWindow: number;
}

const thinkingLevels = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const thinkingFormats = new Set<OpenAiThinkingFormat>(['openai', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'qwen-chat-template', 'string-thinking', 'ant-ling']);
const capabilityStates = new Set<ModelCapabilityState>(['supported', 'unsupported', 'unverified']);
const speedLabels = new Set<ConfiguredModelDefinition['speedLabel']>(['standard', 'high_speed', 'flash', 'turbo']);
const automaticModelCatalogs: Record<ModelConnectionTemplateId, Readonly<Record<string, Model<Api>>>> = {
  custom: normalizeModelCatalog(OPENCODE_MODELS),
  deepseek: normalizeModelCatalog(DEEPSEEK_MODELS),
  bailian: normalizeModelCatalog(QWEN_TOKEN_PLAN_CN_MODELS),
  kimi: normalizeModelCatalog(MOONSHOTAI_MODELS),
  zai: normalizeModelCatalog(ZAI_MODELS),
};

export const modelConnectionTemplates: Record<Exclude<ModelConnectionTemplateId, 'custom'>, { name: string; baseUrl: string; modelsPath: string; thinkingFormat: OpenAiThinkingFormat }> = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelsPath: '/models',
    thinkingFormat: 'deepseek',
  },
  bailian: {
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelsPath: '/models',
    thinkingFormat: 'qwen',
  },
  kimi: {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelsPath: '/models',
    thinkingFormat: 'openai',
  },
  zai: {
    name: 'Z.AI / GLM',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    modelsPath: '/models',
    thinkingFormat: 'zai',
  },
};

export function modelRef(sourceId: string, modelId: string): string {
  return `${encodeURIComponent(sourceId)}:${encodeURIComponent(modelId)}`;
}

export function parseModelRef(value: string): { sourceId: string; modelId: string } | null {
  const boundary = value.indexOf(':');
  if (boundary <= 0 || boundary >= value.length - 1) return null;
  try {
    const sourceId = decodeURIComponent(value.slice(0, boundary));
    const modelId = decodeURIComponent(value.slice(boundary + 1));
    return sourceId && modelId ? { sourceId, modelId } : null;
  } catch {
    return null;
  }
}

export function normalizeModelConnection(input: SaveModelConnectionInput, options: { id: string; apiKeyConfigured: boolean; createdAt: string; updatedAt: string }): ModelConnectionRecord {
  const templateId = normalizeTemplateId(input.templateId);
  const template = templateId === 'custom' ? null : modelConnectionTemplates[templateId];
  const name = normalizeSingleLine(input.name || template?.name || '', '供应商名称', 80);
  const baseUrl = normalizeModelBaseUrl(input.baseUrl || template?.baseUrl || '');
  const modelsPath = normalizeModelsPath(input.modelsPath ?? template?.modelsPath ?? '/models');
  const routeIdentity = { templateId, baseUrl };
  const models = normalizeConfiguredModels(input.models ?? [], template?.thinkingFormat ?? 'openai').map((model) => applyModelRoute(applyAutomaticCapabilityProfile(model, templateId), routeIdentity));
  return {
    id: normalizeIdentifier(options.id, '连接 ID'),
    name,
    templateId,
    baseUrl,
    modelsPath,
    enabled: input.enabled !== false,
    apiKeyConfigured: options.apiKeyConfigured,
    models,
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
  };
}

export function normalizeStoredModelConnections(value: unknown): ModelConnectionRecord[] {
  if (!Array.isArray(value)) return [];
  const records: ModelConnectionRecord[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    try {
      const id = normalizeIdentifier(candidate.id, '连接 ID');
      if (ids.has(id)) continue;
      const createdAt = normalizeIsoDate(candidate.createdAt) ?? new Date(0).toISOString();
      const updatedAt = normalizeIsoDate(candidate.updatedAt) ?? createdAt;
      records.push(
        normalizeModelConnection(candidate as unknown as SaveModelConnectionInput, {
          id,
          apiKeyConfigured: candidate.apiKeyConfigured === true,
          createdAt,
          updatedAt,
        }),
      );
      ids.add(id);
    } catch {
      // 单条损坏配置不应阻断其他连接读取；API 保存路径会返回明确校验错误。
    }
  }
  return records;
}

export function normalizeProjectModelSelection(projectId: string, value: unknown, availableRefs?: ReadonlySet<string>): ProjectModelSelection {
  const source = isRecord(value) ? value : {};
  const allowedModelRefs = Array.isArray(source.allowedModelRefs)
    ? [...new Set(source.allowedModelRefs.filter((item): item is string => typeof item === 'string' && parseModelRef(item) !== null))].filter((item) => !availableRefs || availableRefs.has(item))
    : [];
  const requestedDefault = typeof source.defaultModelRef === 'string' ? source.defaultModelRef : null;
  return {
    projectId,
    allowedModelRefs,
    defaultModelRef: requestedDefault && allowedModelRefs.includes(requestedDefault) ? requestedDefault : (allowedModelRefs[0] ?? null),
  };
}

const officialDeepSeekResponsesModelIds = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

/** DeepSeek 模板只有指向官方 HTTPS 端点时，才能使用官方价格和能力证据。 */
export function isOfficialDeepSeekApiConnection(connection: Pick<ModelConnectionRecord, 'templateId' | 'baseUrl'>): boolean {
  if (connection.templateId !== 'deepseek') return false;
  try {
    const url = new URL(connection.baseUrl);
    const path = url.pathname.replace(/\/+$/u, '');
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && url.port === '' && (path === '' || path === '/v1');
  } catch {
    return false;
  }
}

/** 只有 DeepSeek 官方域名上的 V4 模型可以继承官方 Responses 兼容证据。 */
export function isOfficialDeepSeekResponsesModel(connection: Pick<ModelConnectionRecord, 'templateId' | 'baseUrl'>, modelId: string): boolean {
  return isOfficialDeepSeekApiConnection(connection) && officialDeepSeekResponsesModelIds.has(modelId.trim().toLowerCase());
}

export function modelConnectionAgentKind(connection: Pick<ModelConnectionRecord, 'templateId' | 'baseUrl'>, modelId: string): 'codex' | 'pi' {
  return isOfficialDeepSeekResponsesModel(connection, modelId) ? 'codex' : 'pi';
}

export function modelConnectionRoute(
  connection: Pick<ModelConnectionRecord, 'templateId' | 'baseUrl'>,
  modelId: string,
  configuredProtocol: ModelProtocolFamily = 'openai_completions',
): Pick<ConfiguredModelDefinition, 'runtimeAdapter' | 'protocolFamily'> {
  if (isOfficialDeepSeekResponsesModel(connection, modelId)) return { runtimeAdapter: 'codex_app_server', protocolFamily: 'openai_responses' };
  return {
    runtimeAdapter: 'pi_sdk',
    protocolFamily: configuredProtocol,
  };
}

export function listSelectableConnectionModels(connections: readonly ModelConnectionRecord[]): SelectableConnectionModel[] {
  return connections.flatMap((connection) =>
    connection.models.map((model) => {
      const agentKind = model.runtimeAdapter === 'codex_app_server' ? 'codex' : 'pi';
      const tools = agentKind === 'codex' ? 'supported' : model.capability.tools.state;
      const imageInput = agentKind === 'codex' ? 'unsupported' : model.capability.imageInput.state;
      const available = connection.enabled && connection.apiKeyConfigured && model.enabled;
      const availabilityReason = !connection.enabled
        ? '模型供应商已停用。'
        : !connection.apiKeyConfigured
          ? '模型供应商尚未配置 API Key。'
          : !model.enabled
            ? '模型已停用。'
            : tools === 'unsupported'
              ? '模型明确不支持工具调用，只能保存在诊断目录中。'
              : agentKind === 'codex'
                ? 'Zeus 已完成该 DeepSeek 官方 V4 模型的 Responses 兼容验收；新会话使用 Codex App Server。'
                : '模型已配置；真实外部能力仍以运行探针结果为准。';
      return {
        id: modelRef(connection.id, model.id),
        model: model.id,
        displayName: model.displayName,
        sourceId: connection.id,
        sourceName: connection.name,
        agentKind,
        enabled: connection.enabled && model.enabled,
        available: available && tools !== 'unsupported',
        availabilityReason,
        supportedReasoningEfforts: model.capability.reasoning.state === 'supported' ? [...model.capability.reasoning.levels] : [],
        defaultReasoningEffort: model.capability.reasoning.state === 'supported' ? model.capability.reasoning.defaultLevel : null,
        serviceTiers: [] as [],
        defaultServiceTier: null,
        speedLabel: model.speedLabel,
        tools,
        imageInput,
        runtimeAdapter: model.runtimeAdapter,
        protocolFamily: model.protocolFamily,
        authenticationScheme: model.authenticationScheme,
        supports1MContext: model.supports1MContext,
        contextWindow: model.contextWindow,
      };
    }),
  );
}

export function createConfiguredModelDefinition(id: string, input: Partial<ConfiguredModelDefinition> = {}, thinkingFormat: OpenAiThinkingFormat = 'openai'): ConfiguredModelDefinition {
  const normalizedId = normalizeSingleLine(id, '模型 ID', 200);
  return normalizeConfiguredModel(
    {
      id: normalizedId,
      displayName: input.displayName ?? normalizedId,
      enabled: input.enabled ?? true,
      supports1MContext: input.supports1MContext ?? false,
      contextWindow: input.contextWindow ?? 256_000,
      maxTokens: input.maxTokens ?? 8_192,
      speedLabel: input.speedLabel ?? inferSpeedLabel(normalizedId),
      runtimeAdapter: input.runtimeAdapter ?? 'pi_sdk',
      protocolFamily: input.protocolFamily ?? 'openai_completions',
      authenticationScheme: input.authenticationScheme ?? 'protocol_default',
      capability:
        input.capability ??
        ({
          reasoning: {
            state: 'unverified',
            levels: ['off'],
            defaultLevel: 'off',
            thinkingFormat,
            levelMap: { off: null },
            source: 'catalog',
            checkedAt: null,
            reason: '模型目录只证明 ID 存在，待 Zeus 自动识别能力。',
          },
          tools: evidence('unverified', 'catalog', '模型目录未提供工具能力证据，等待真实工具闭环探针。'),
          imageInput: evidence('unverified', 'catalog', '模型目录未提供图片能力证据，等待真实图片输入探针。'),
          streaming: evidence('unverified', 'catalog', '等待真实流式输出探针。'),
          usage: evidence('unverified', 'catalog', '等待真实用量字段探针。'),
        } satisfies ConfiguredModelCapability),
    },
    thinkingFormat,
  );
}

export function mergeDiscoveredModels(existing: readonly ConfiguredModelDefinition[], modelIds: readonly string[], thinkingFormat: OpenAiThinkingFormat, templateId: ModelConnectionTemplateId = 'custom'): ConfiguredModelDefinition[] {
  const byId = new Map(existing.map((model) => [model.id, model]));
  for (const rawId of modelIds) {
    const id = rawId.trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, applyAutomaticCapabilityProfile(createConfiguredModelDefinition(id, {}, thinkingFormat), templateId));
  }
  return [...byId.values()].map((model) => applyAutomaticCapabilityProfile(model, templateId));
}

export function createTemplateConfiguredModelDefinition(id: string, templateId: ModelConnectionTemplateId): ConfiguredModelDefinition {
  const thinkingFormat = templateId === 'custom' ? 'openai' : modelConnectionTemplates[templateId].thinkingFormat;
  return applyAutomaticCapabilityProfile(createConfiguredModelDefinition(id, {}, thinkingFormat), templateId);
}

export function modelConnectionSecretAccount(connectionId: string): string {
  return `model.connection.${normalizeIdentifier(connectionId, '连接 ID')}.api-key`;
}

export function buildModelsUrl(connection: Pick<ModelConnectionRecord, 'baseUrl' | 'modelsPath'>): string {
  const catalogBaseUrl = connection.baseUrl.replace(/\/(?:v1\/messages|chat\/completions|responses)$/u, '');
  return new URL(connection.modelsPath.replace(/^\/+/, ''), `${catalogBaseUrl.replace(/\/+$/u, '')}/`).toString();
}

/**
 * Pi 的协议适配器负责追加最终请求路径；这里统一把用户可能填写的标准完整端点还原为适配器需要的 Base URL。
 */
export function modelConnectionRuntimeBaseUrl(baseUrl: string, protocolFamily: ModelProtocolFamily): string {
  const normalized = baseUrl.replace(/\/+$/u, '');
  if (protocolFamily === 'anthropic_messages') return normalized.replace(/\/v1\/messages$/u, '').replace(/\/v1$/u, '');
  if (protocolFamily === 'openai_completions') return normalized.replace(/\/chat\/completions$/u, '');
  return normalized.replace(/\/responses$/u, '');
}

/** 返回不含密钥的最终 HTTP 端点，供运行证据和诊断展示使用。 */
export function modelConnectionRequestEndpoint(baseUrl: string, protocolFamily: ModelProtocolFamily): string {
  const runtimeBaseUrl = modelConnectionRuntimeBaseUrl(baseUrl, protocolFamily);
  const requestPath = protocolFamily === 'anthropic_messages' ? 'v1/messages' : protocolFamily === 'openai_responses' ? 'responses' : 'chat/completions';
  return new URL(requestPath, `${runtimeBaseUrl.replace(/\/+$/u, '')}/`).toString();
}

/**
 * 认证摆放方式属于语义路由。默认方式保持旧快照身份；显式覆盖后使用新的凭据槽身份，避免排队任务静默改头。
 */
export function modelConnectionCredentialSlotId(connectionId: string, authenticationScheme: ModelAuthenticationScheme): string {
  const base = `model-connection:${normalizeIdentifier(connectionId, '连接 ID')}`;
  return authenticationScheme === 'protocol_default' ? base : `${base}:${authenticationScheme}`;
}

function normalizeConfiguredModels(value: readonly ConfiguredModelDefinition[], fallbackThinkingFormat: OpenAiThinkingFormat): ConfiguredModelDefinition[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('模型列表必须是数组且不能超过 200 项。');
  const ids = new Set<string>();
  return value.map((candidate) => {
    const model = normalizeConfiguredModel(candidate, fallbackThinkingFormat);
    if (ids.has(model.id)) throw new Error(`模型 ID 重复：${model.id}`);
    ids.add(model.id);
    return model;
  });
}

function normalizeConfiguredModel(value: ConfiguredModelDefinition, fallbackThinkingFormat: OpenAiThinkingFormat): ConfiguredModelDefinition {
  if (!isRecord(value)) throw new Error('模型配置必须是对象。');
  const id = normalizeSingleLine(value.id, '模型 ID', 200);
  const displayName = normalizeSingleLine(value.displayName || id, '模型名称', 200);
  const legacyDeclared1M = value.supports1MContext === undefined && typeof value.contextWindow === 'number' && value.contextWindow >= 1_000_000;
  const supports1MContext = value.supports1MContext === true || legacyDeclared1M;
  const contextWindow = supports1MContext ? 1_000_000 : normalizePositiveInteger(value.contextWindow ?? 256_000, '上下文窗口', 1_000, 10_000_000);
  const maxTokens = normalizePositiveInteger(value.maxTokens, '最大输出 Token', 1, contextWindow);
  const speedLabel = speedLabels.has(value.speedLabel) ? value.speedLabel : inferSpeedLabel(id);
  const capability = normalizeCapability(value.capability, fallbackThinkingFormat);
  const runtimeAdapter = value.runtimeAdapter === 'codex_app_server' ? 'codex_app_server' : 'pi_sdk';
  const protocolFamily: ModelProtocolFamily = value.protocolFamily === 'openai_responses' ? 'openai_responses' : value.protocolFamily === 'anthropic_messages' ? 'anthropic_messages' : 'openai_completions';
  const requestedAuthenticationScheme: ModelAuthenticationScheme = value.authenticationScheme === 'bearer' ? 'bearer' : value.authenticationScheme === 'x_api_key' ? 'x_api_key' : 'protocol_default';
  const authenticationScheme: ModelAuthenticationScheme = protocolFamily === 'anthropic_messages' || requestedAuthenticationScheme !== 'x_api_key' ? requestedAuthenticationScheme : 'protocol_default';
  return { id, displayName, enabled: value.enabled !== false, supports1MContext, contextWindow, maxTokens, speedLabel, runtimeAdapter, protocolFamily, authenticationScheme, capability };
}

function applyModelRoute(model: ConfiguredModelDefinition, connection: Pick<ModelConnectionRecord, 'templateId' | 'baseUrl'>): ConfiguredModelDefinition {
  return { ...model, ...modelConnectionRoute(connection, model.id, model.protocolFamily) };
}

/** 根据渠道和已知模型档案自动生成能力，未知能力保持未验证。 */
function applyAutomaticCapabilityProfile(model: ConfiguredModelDefinition, templateId: ModelConnectionTemplateId): ConfiguredModelDefinition {
  const normalizedId = model.id.toLowerCase();
  const baseModel = discardManualCapabilityClaims(model);
  const catalogModel = automaticModelCatalogs[templateId][normalizedId];
  if (catalogModel) {
    const levels = getSupportedThinkingLevels(catalogModel) as PiThinkingLevel[];
    const reasoningState: ModelCapabilityState = catalogModel.reasoning ? 'supported' : 'unsupported';
    const effectiveLevels: PiThinkingLevel[] = reasoningState === 'supported' ? levels : ['off'];
    const defaultLevel = preferredCatalogReasoningLevel(normalizedId, effectiveLevels);
    const levelMap: Partial<Record<PiThinkingLevel, string | null>> = {};
    for (const level of effectiveLevels) levelMap[level] = catalogModel.thinkingLevelMap?.[level] ?? level;
    const catalogEvidence = (state: ModelCapabilityState, reason: string): ModelCapabilityEvidence => ({ source: 'catalog', state, checkedAt: null, reason });
    return {
      ...baseModel,
      displayName: catalogModel.name,
      // 连接中持久化的窗口与输出限制属于该路由的执行配置；内置目录只补全能力证据，不能静默覆盖用户已经确认的限制。
      capability: {
        ...baseModel.capability,
        reasoning:
          baseModel.capability.reasoning.source === 'probe'
            ? baseModel.capability.reasoning
            : {
                state: reasoningState,
                levels: effectiveLevels,
                defaultLevel,
                thinkingFormat: catalogThinkingFormat(catalogModel, baseModel.capability.reasoning.thinkingFormat),
                levelMap,
                source: 'catalog',
                checkedAt: null,
                reason: '由 Zeus 内置模型目录自动识别；当前第三方接入渠道仍需真实运行验证。',
              },
        imageInput:
          baseModel.capability.imageInput.source === 'probe'
            ? baseModel.capability.imageInput
            : catalogEvidence(catalogModel.input.includes('image') ? 'supported' : 'unsupported', `模型目录声明${catalogModel.input.includes('image') ? '支持' : '不支持'}图片输入；当前接入渠道待真实运行验证。`),
      },
    };
  }
  return baseModel;
}

/** 旧版界面留下的手工能力声明不再参与运行；只有目录、模板或真实探针可以形成能力证据。 */
function discardManualCapabilityClaims(model: ConfiguredModelDefinition): ConfiguredModelDefinition {
  const reasoning = model.capability.reasoning;
  const resetEvidence = (value: ModelCapabilityEvidence, reason: string): ModelCapabilityEvidence => (value.source === 'manual' ? evidence('unverified', 'catalog', reason) : value);
  return {
    ...model,
    capability: {
      ...model.capability,
      reasoning:
        reasoning.source === 'manual'
          ? {
              state: 'unverified',
              levels: ['off'],
              defaultLevel: 'off',
              thinkingFormat: reasoning.thinkingFormat,
              levelMap: { off: null },
              source: 'catalog',
              checkedAt: null,
              reason: '旧版手工声明已停用，待 Zeus 自动识别推理能力。',
            }
          : reasoning,
      tools: resetEvidence(model.capability.tools, '旧版手工声明已停用，等待真实工具闭环探针。'),
      imageInput: resetEvidence(model.capability.imageInput, '旧版手工声明已停用，等待真实图片输入探针。'),
      streaming: resetEvidence(model.capability.streaming, '旧版手工声明已停用，等待真实流式输出探针。'),
      usage: resetEvidence(model.capability.usage, '旧版手工声明已停用，等待真实用量字段探针。'),
    },
  };
}

function preferredCatalogReasoningLevel(modelId: string, levels: readonly PiThinkingLevel[]): PiThinkingLevel {
  const preferences: PiThinkingLevel[] = modelId === 'gpt-5.6-sol' ? ['low', 'medium', 'high', 'off'] : ['medium', 'high', 'low', 'off'];
  return preferences.find((level) => levels.includes(level)) ?? levels[0]!;
}

function normalizeModelCatalog(catalog: object): Readonly<Record<string, Model<Api>>> {
  const models = Object.values(catalog as Record<string, Model<Api>>);
  return Object.fromEntries(models.map((model) => [model.id.toLowerCase(), model]));
}

function catalogThinkingFormat(model: Model<Api>, fallback: OpenAiThinkingFormat): OpenAiThinkingFormat {
  const compat = isRecord(model.compat) ? model.compat : {};
  return thinkingFormats.has(compat.thinkingFormat as OpenAiThinkingFormat) ? (compat.thinkingFormat as OpenAiThinkingFormat) : fallback;
}

function normalizeCapability(value: ConfiguredModelCapability, fallbackThinkingFormat: OpenAiThinkingFormat): ConfiguredModelCapability {
  const capabilitySource: Record<string, unknown> = isRecord(value) ? value : {};
  const reasoningSource: Record<string, unknown> = isRecord(capabilitySource.reasoning) ? capabilitySource.reasoning : {};
  const reasoningState = normalizeCapabilityState(reasoningSource.state);
  const levels: PiThinkingLevel[] = [];
  if (Array.isArray(reasoningSource.levels)) {
    for (const item of reasoningSource.levels) {
      if (thinkingLevels.has(item as PiThinkingLevel) && !levels.includes(item as PiThinkingLevel)) levels.push(item as PiThinkingLevel);
    }
  }
  const effectiveLevels: PiThinkingLevel[] = reasoningState === 'supported' && levels.length > 0 ? levels : ['off'];
  const requestedDefault = thinkingLevels.has(reasoningSource.defaultLevel as PiThinkingLevel) ? (reasoningSource.defaultLevel as PiThinkingLevel) : effectiveLevels[0]!;
  const defaultLevel = effectiveLevels.includes(requestedDefault) ? requestedDefault : effectiveLevels[0]!;
  const thinkingFormat = thinkingFormats.has(reasoningSource.thinkingFormat as OpenAiThinkingFormat) ? (reasoningSource.thinkingFormat as OpenAiThinkingFormat) : fallbackThinkingFormat;
  const levelMapSource = isRecord(reasoningSource.levelMap) ? reasoningSource.levelMap : {};
  const levelMap: Partial<Record<PiThinkingLevel, string | null>> = {};
  for (const level of thinkingLevels) {
    const mapped = levelMapSource[level];
    if (mapped === null || typeof mapped === 'string') levelMap[level] = mapped;
    else if (effectiveLevels.includes(level)) levelMap[level] = level;
  }
  const reasoningEvidenceSource = reasoningSource.source === 'template' || reasoningSource.source === 'catalog' || reasoningSource.source === 'probe' ? reasoningSource.source : 'manual';
  return {
    reasoning: {
      state: reasoningState,
      levels: effectiveLevels,
      defaultLevel,
      thinkingFormat,
      levelMap,
      source: reasoningEvidenceSource,
      checkedAt: normalizeIsoDate(reasoningSource.checkedAt),
      reason: typeof reasoningSource.reason === 'string' && reasoningSource.reason.trim() ? reasoningSource.reason.trim().slice(0, 500) : '待 Zeus 自动识别推理能力。',
    },
    tools: normalizeEvidence(capabilitySource.tools, '等待真实工具闭环探针。'),
    imageInput: normalizeEvidence(capabilitySource.imageInput, '等待真实图片输入探针。'),
    streaming: normalizeEvidence(capabilitySource.streaming, '等待真实流式输出探针。'),
    usage: normalizeEvidence(capabilitySource.usage, '等待真实用量字段探针。'),
  };
}

function normalizeEvidence(value: unknown, fallbackReason: string): ModelCapabilityEvidence {
  if (!isRecord(value)) return evidence('unverified', 'manual', fallbackReason);
  const source = value.source === 'template' || value.source === 'catalog' || value.source === 'probe' ? value.source : 'manual';
  return {
    source,
    state: normalizeCapabilityState(value.state),
    checkedAt: normalizeIsoDate(value.checkedAt),
    reason: typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim().slice(0, 500) : fallbackReason,
  };
}

function evidence(state: ModelCapabilityState, source: ModelCapabilityEvidence['source'], reason: string): ModelCapabilityEvidence {
  return { state, source, checkedAt: null, reason };
}

function normalizeCapabilityState(value: unknown): ModelCapabilityState {
  return capabilityStates.has(value as ModelCapabilityState) ? (value as ModelCapabilityState) : 'unverified';
}

function normalizeTemplateId(value: unknown): ModelConnectionTemplateId {
  return value === 'deepseek' || value === 'bailian' || value === 'kimi' || value === 'zai' ? value : 'custom';
}

function normalizeModelBaseUrl(value: unknown): string {
  const raw = normalizeSingleLine(value, '服务地址', 500);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('服务地址必须是完整 URL。');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('服务地址只支持 HTTP 或 HTTPS。');
  if (url.username || url.password || url.hash || url.search) throw new Error('服务地址不能包含账号、密码、查询参数或片段。');
  return url.toString().replace(/\/+$/u, '');
}

function normalizeModelsPath(value: unknown): string {
  const raw = normalizeSingleLine(value || '/models', '模型目录路径', 200);
  if (!raw.startsWith('/') || raw.includes('..') || raw.includes('?') || raw.includes('#')) throw new Error('模型目录路径必须是站内绝对路径。');
  return raw;
}

function normalizeSingleLine(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\r') || normalized.includes('\n') || normalized.includes(String.fromCharCode(0))) throw new Error(`${label}不能为空、不能换行且不能超过 ${maxLength} 个字符。`);
  return normalized;
}

function normalizeIdentifier(value: unknown, label: string): string {
  const normalized = normalizeSingleLine(value, label, 100);
  if (!/^[a-z0-9_-]+$/iu.test(normalized)) throw new Error(`${label}只能包含字母、数字、下划线和短横线。`);
  return normalized;
}

function normalizePositiveInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  return Number(value);
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function inferSpeedLabel(modelId: string): ConfiguredModelDefinition['speedLabel'] {
  const normalized = modelId.toLowerCase();
  if (normalized.includes('highspeed') || normalized.includes('high-speed') || normalized.includes('fast')) return 'high_speed';
  if (normalized.includes('flash')) return 'flash';
  if (normalized.includes('turbo')) return 'turbo';
  return 'standard';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
