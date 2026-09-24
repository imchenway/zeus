import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { MOONSHOTAI_MODELS } from '@earendil-works/pi-ai/providers/moonshotai.models';
import { OPENCODE_MODELS } from '@earendil-works/pi-ai/providers/opencode.models';
import { QWEN_TOKEN_PLAN_CN_MODELS } from '@earendil-works/pi-ai/providers/qwen-token-plan-cn.models';
import { ZAI_MODELS } from '@earendil-works/pi-ai/providers/zai.models';
import { readOfficialModelVersion } from './modelVersionNames.js';

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

/** 推理档位清单的来源；同时决定界面标签和这份清单有多可信。 */
export type ReasoningProfileBasis =
  /** 官方端点声明：按厂商文档核对过的清单，最可信。 */
  | 'official_endpoint'
  /** 内置目录明确声明了档位映射。 */
  | 'catalog'
  /** 目录只标了「会思考」、没给档位映射，档位是 Pi 自己推出来的默认假设。 */
  | 'catalog_default'
  /** 已核对的厂商文档档位表，适用于该厂商的同族模型（第三方渠道）。 */
  | 'vendor_docs'
  /** 按模型名推断出所属家族（第三方中转场景），未验证。 */
  | 'model_name'
  /** 用户在模型配置里手工指定。 */
  | 'user'
  /** 认不出：没有档位清单，界面不给下拉，请求不发任何档位字段。 */
  | 'unidentified';

/**
 * 推理档位清单里的一项，三个字段是三件不同的事：
 * 用户看到并存储在配置里的词（id）、Zeus 内部交给 Pi 的中转词（piLevel）、
 * 以及真正写进请求发给厂商的取值（wire）。
 */
export interface ConfiguredReasoningOption {
  /** 用户词，也是存储值；用厂商口径，例如 low / high / max / ultra。 */
  id: string;
  /** 可选的本地化显示名；缺省时界面直接显示 id。 */
  label?: string | null;
  /** Zeus 内部中转词，必须是 Pi 认识的七个之一。 */
  piLevel: PiThinkingLevel;
  /** 真正写进请求的取值；null 表示这个档位不发送任何取值字段。 */
  wire: string | null;
}

/**
 * 一个模型的推理档位清单。
 * 喂给 Pi 的档位集合（levels）、默认档、线上取值映射全部由它派生，不再单独维护，避免两边漂移。
 */
export interface ConfiguredReasoningProfile {
  state: ModelCapabilityState;
  /** 用户可见的档位清单，顺序即界面顺序；为空表示未识别。 */
  options: ConfiguredReasoningOption[];
  /** 默认档位的 id；未识别时为 null。 */
  defaultId: string | null;
  thinkingFormat: OpenAiThinkingFormat;
  basis: ReasoningProfileBasis;
  /** 真机观测时间；只有能力探测会写，档位清单的重算不会覆盖它。 */
  checkedAt: string | null;
}

export interface ConfiguredModelCapability {
  reasoning: ConfiguredReasoningProfile;
  tools: ModelCapabilityEvidence;
  imageInput: ModelCapabilityEvidence;
  streaming: ModelCapabilityEvidence;
  usage: ModelCapabilityEvidence;
}

export interface ConfiguredModelDefinition {
  id: string;
  displayName: string;
  /**
   * 能力探测时服务端在响应里回报的实际服务模型标识，可能带版本日期。
   * 只记录真机观测结果；没探测过或服务端不回报时为空，不用供应商文档猜测。
   */
  servedModelId?: string | null;
  /**
   * 厂商官方文档里登记的版本名（人工维护表），只用于展示，不参与请求。
   * 未登记时为 null，界面退回显示目录名或模型 ID。
   */
  officialVersion?: string | null;
  enabled: boolean;
  supports1MContext: boolean;
  contextWindow: number;
  /** 已知模型采用原生目录容量，自定义接入保留连接声明。 */
  contextWindowSource?: 'catalog';
  maxTokens: number;
  speedLabel: 'standard' | 'high_speed' | 'flash' | 'turbo';
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
  /** 可选价格清单页面；空值使用内置来源。 */
  pricingUrl?: string;
  /** 仅用于展示的价格读取状态，不参与连接配置存储。 */
  pricingCatalog?: import('@zeus/shared').ModelPricingCatalog | null;
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
  /** 自定义供应商只需提供一个价格清单页面。 */
  pricingUrl?: string;
  enabled?: boolean;
  models?: ConfiguredModelDefinition[];
}

/**
 * 判定推理档位清单需要的连接身份。
 * 模型 ID 和协议形态由调用方按每个模型补齐，因为同一个连接里可以混着不同协议族的模型。
 */
export interface ModelReasoningRoute {
  templateId: ModelConnectionTemplateId;
  baseUrl: string;
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
  /** 用户可见的推理档位（厂商口径的 id），界面直接显示这些词。 */
  supportedReasoningEfforts: string[];
  /** 默认档位的 id；未识别时为 null。 */
  defaultReasoningEffort: string | null;
  serviceTiers: [];
  defaultServiceTier: null;
  speedLabel: ConfiguredModelDefinition['speedLabel'];
  tools: ModelCapabilityState;
  imageInput: ModelCapabilityState;
  /** 模型连接一律由 Zeus 内核（Pi SDK）执行；Codex App Server 只服务订阅目录里的模型。 */
  runtimeAdapter: 'pi_sdk';
  protocolFamily: ConfiguredModelDefinition['protocolFamily'];
  authenticationScheme: ConfiguredModelDefinition['authenticationScheme'];
  supports1MContext: boolean;
  contextWindow: number;
}

const thinkingLevels = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const thinkingFormats = new Set<OpenAiThinkingFormat>(['openai', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'qwen-chat-template', 'string-thinking', 'ant-ling']);
const capabilityStates = new Set<ModelCapabilityState>(['supported', 'unsupported', 'unverified']);
/** 档位清单来源的合法取值，非法值一律当未识别处理。 */
const reasoningProfileBases = new Set<ReasoningProfileBasis>(['official_endpoint', 'vendor_docs', 'catalog', 'catalog_default', 'model_name', 'user', 'unidentified']);
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
  const models = normalizeConfiguredModels(input.models ?? [], template?.thinkingFormat ?? 'openai').map((model) => applyAutomaticCapabilityProfile(model, { templateId, baseUrl, protocolFamily: model.protocolFamily }));
  return {
    id: normalizeIdentifier(options.id, '连接 ID'),
    name,
    templateId,
    baseUrl,
    modelsPath,
    ...(input.pricingUrl?.trim() ? { pricingUrl: normalizePricingPageUrl(input.pricingUrl) } : {}),
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

export function listSelectableConnectionModels(connections: readonly ModelConnectionRecord[]): SelectableConnectionModel[] {
  return connections.flatMap((connection) =>
    connection.models.map((model) => {
      // 模型连接没有第二条链路可切换：订阅目录以外的模型一律由 Zeus 内核执行，界面不需要再解释路由。
      const agentKind = 'pi' as const;
      const tools = model.capability.tools.state;
      const imageInput = model.capability.imageInput.state;
      const available = connection.enabled && connection.apiKeyConfigured && model.enabled;
      const availabilityReason = !connection.enabled
        ? '模型供应商已停用。'
        : !connection.apiKeyConfigured
          ? '模型供应商尚未配置 API Key。'
          : !model.enabled
            ? '模型已停用。'
            : tools === 'unsupported'
              ? '模型明确不支持工具调用，只能保存在诊断目录中。'
              : '模型已配置，由 Zeus 内核执行；真实外部能力仍以运行探针结果为准。';
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
        supportedReasoningEfforts: model.capability.reasoning.options.map((option) => option.id),
        defaultReasoningEffort: model.capability.reasoning.defaultId,
        serviceTiers: [] as [],
        defaultServiceTier: null,
        speedLabel: model.speedLabel,
        tools,
        imageInput,
        runtimeAdapter: 'pi_sdk',
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
      servedModelId: input.servedModelId ?? null,
      enabled: input.enabled ?? true,
      supports1MContext: input.supports1MContext ?? false,
      contextWindow: input.contextWindow ?? 256_000,
      maxTokens: input.maxTokens ?? 8_192,
      speedLabel: input.speedLabel ?? inferSpeedLabel(normalizedId),
      protocolFamily: input.protocolFamily ?? 'openai_completions',
      authenticationScheme: input.authenticationScheme ?? 'protocol_default',
      capability:
        input.capability ??
        ({
          reasoning: {
            state: 'unverified',
            // 未识别：没有档位清单，界面不给下拉，请求也不发任何档位字段。
            options: [],
            defaultId: null,
            thinkingFormat,
            basis: 'unidentified',
            checkedAt: null,
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

/** 模型目录同步结果：候选池以接口返回为准，同时回传新增与移除的模型 ID 供界面和审计展示。 */
export interface DiscoveredModelSyncResult {
  models: ConfiguredModelDefinition[];
  addedModelIds: string[];
  removedModelIds: string[];
}

/**
 * 以接口返回的模型 ID 同步候选池，不再只增不删。
 *
 * 已存在的模型保留原有启用状态与手动配置；新发现的模型只进入候选池、默认停用，
 * 等待用户在分组下拉中显式勾选启用；接口不再返回的模型从候选池移除。
 */
export function syncDiscoveredModels(
  existing: readonly ConfiguredModelDefinition[],
  modelIds: readonly string[],
  thinkingFormat: OpenAiThinkingFormat,
  route: ModelReasoningRoute = { templateId: 'custom', baseUrl: '' },
): DiscoveredModelSyncResult {
  const previousById = new Map(existing.map((model) => [model.id, model]));
  const normalizedIds = [...new Set(modelIds.map((rawId) => rawId.trim()).filter((id) => id.length > 0))].slice(0, 200);
  const nextIds = new Set(normalizedIds);
  const addedModelIds: string[] = [];
  const models = normalizedIds.map((id) => {
    const previous = previousById.get(id);
    if (previous) return applyAutomaticCapabilityProfile(previous, { ...route, protocolFamily: previous.protocolFamily });
    addedModelIds.push(id);
    const created = createConfiguredModelDefinition(id, { enabled: false }, thinkingFormat);
    return applyAutomaticCapabilityProfile(created, { ...route, protocolFamily: created.protocolFamily });
  });
  const removedModelIds = existing.filter((model) => !nextIds.has(model.id)).map((model) => model.id);
  return { models, addedModelIds, removedModelIds };
}

export function createTemplateConfiguredModelDefinition(id: string, route: ModelReasoningRoute): ConfiguredModelDefinition {
  const thinkingFormat = route.templateId === 'custom' ? 'openai' : modelConnectionTemplates[route.templateId].thinkingFormat;
  const created = createConfiguredModelDefinition(id, {}, thinkingFormat);
  return applyAutomaticCapabilityProfile(created, { ...route, protocolFamily: created.protocolFamily });
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
  // 服务端回报的模型标识按原样保留；为空即为“未观测到”，不猜测。
  const servedModelId = typeof value.servedModelId === 'string' ? value.servedModelId.trim().slice(0, 200) || null : null;
  // 官方版本名由人工表决定，保存时重算，避免界面把过期值写回配置。
  const officialVersion = readOfficialModelVersion(id);
  const supports1MContext = value.supports1MContext === true;
  const contextWindow = normalizePositiveInteger(value.contextWindow, '上下文容量', 1, 10_000_000);
  // 有效窗口是权威值：历史配置可能保留超过 256K 的 maxTokens，取消 1M 后不应让整条连接不可保存。
  const requestedMaxTokens = normalizePositiveInteger(value.maxTokens, '最大输出 Token', 1, 10_000_000);
  const maxTokens = Math.min(requestedMaxTokens, contextWindow);
  const speedLabel = speedLabels.has(value.speedLabel) ? value.speedLabel : inferSpeedLabel(id);
  const capability = normalizeCapability(value.capability, fallbackThinkingFormat);
  const protocolFamily: ModelProtocolFamily = value.protocolFamily === 'openai_responses' ? 'openai_responses' : value.protocolFamily === 'anthropic_messages' ? 'anthropic_messages' : 'openai_completions';
  const requestedAuthenticationScheme: ModelAuthenticationScheme = value.authenticationScheme === 'bearer' ? 'bearer' : value.authenticationScheme === 'x_api_key' ? 'x_api_key' : 'protocol_default';
  const authenticationScheme: ModelAuthenticationScheme = protocolFamily === 'anthropic_messages' || requestedAuthenticationScheme !== 'x_api_key' ? requestedAuthenticationScheme : 'protocol_default';
  return { id, displayName, servedModelId, officialVersion, enabled: value.enabled !== false, supports1MContext, contextWindow, maxTokens, speedLabel, protocolFamily, authenticationScheme, capability };
}

/** 档位清单的判定入参：连接身份 + 模型 ID + 协议形态。 */
interface ReasoningRoute {
  templateId: ModelConnectionTemplateId;
  baseUrl: string;
  modelId: string;
  protocolFamily: ModelProtocolFamily;
  thinkingFormat: OpenAiThinkingFormat;
}

/** 内置家族预设：模型 ID 里出现任一关键字即命中，先到先得。 */
interface ReasoningPreset {
  keywords: readonly string[];
  levels: readonly PiThinkingLevel[];
  defaultLevel: PiThinkingLevel;
}

/**
 * 已按官方文档核对过档位表的厂商。
 *
 * 它排在模型目录之前：目录是第三方维护的，会过期——DeepSeek 就是活例，
 * 目录把 `low` 标成不可用，而官方文档写明档位就是 low/high/max。
 * 厂商文档与目录冲突时以文档为准，但依据要如实标成「厂商文档」而不是「官方端点」。
 */
const verifiedVendorReasoningProfiles: readonly { keywords: readonly string[]; levels: readonly PiThinkingLevel[]; defaultLevel: PiThinkingLevel }[] = [{ keywords: ['deepseek'], levels: ['low', 'high', 'max'], defaultLevel: 'high' }];

/**
 * 首批内置家族预设。加一行就支持一个新厂商；
 * 用户看到的档位词默认与 Pi 的中转词同名，需要发别的取值时给该档位单独写 wire。
 */
const reasoningPresets: readonly ReasoningPreset[] = [
  { keywords: ['deepseek'], levels: ['low', 'high', 'max'], defaultLevel: 'high' },
  { keywords: ['kimi', 'moonshot'], levels: ['low', 'high', 'max'], defaultLevel: 'high' },
  { keywords: ['qwen', 'tongyi'], levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'medium' },
  { keywords: ['glm', 'zhipu', 'zai'], levels: ['high', 'max'], defaultLevel: 'high' },
  { keywords: ['gpt-', 'codex'], levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], defaultLevel: 'medium' },
  { keywords: ['claude', 'fable'], levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'medium' },
  { keywords: ['gemini', 'gemma'], levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'medium' },
  { keywords: ['grok'], levels: ['low', 'medium', 'high'], defaultLevel: 'medium' },
];

/**
 * 明显不是对话/推理模型的品类关键字：图像、视频、语音、向量、检索等。
 * 这些模型本来就没有推理档位，绝不能因为名字里有某个厂商关键字就硬套一份家族清单。
 */
const nonChatModelKeywords = ['image', 'imagine', 'video', 'veo', 'seedance', 'vidu', 'hailuo', 'kling', 'sora', 'tts', 'asr', 'whisper', 'audio', 'embedding', 'embed', 'rerank', 'ocr', 'flux', 'nano_banana'];

/** 把一组 Pi 档位词变成「同名直传」的档位清单：用户词、Pi 中转词、线上取值三者相同。 */
function sameNameReasoningOptions(levels: readonly PiThinkingLevel[]): ConfiguredReasoningOption[] {
  return levels.map((level) => ({ id: level, label: null, piLevel: level, wire: level }));
}

/** 官方 DeepSeek 端点档案：依据官方 Thinking Mode 文档（2026-09-21 核对），档位就是 low/high/max。 */
const officialDeepSeekReasoningOptions = sameNameReasoningOptions(['low', 'high', 'max']);

/**
 * 判定一个模型该用哪份推理档位清单，命中即止：
 * 用户手工指定 → 官方端点档案 → 内置目录 → 家族预设 → 未识别。
 */
function resolveReasoningProfile(model: ConfiguredModelDefinition, route: ReasoningRoute): ConfiguredReasoningProfile {
  const stored = model.capability.reasoning;
  // 真机观测时间不参与档位判定，只跟着走：档位清单可以重算，观测事实不能被抹掉。
  const observedAt = stored.checkedAt;
  if (stored.basis === 'user' && stored.options.length > 0) return { ...stored, state: 'supported' };
  const normalizedId = route.modelId.toLowerCase();
  if (isOfficialDeepSeekApiConnection(route)) {
    return {
      state: 'supported',
      options: officialDeepSeekReasoningOptions.map((option) => ({ ...option })),
      defaultId: 'high',
      thinkingFormat: 'deepseek',
      basis: 'official_endpoint',
      checkedAt: observedAt,
    };
  }
  // 图像、视频、语音这类模型没有推理档位，不参与任何按名字来的推断（厂商文档档位表和家族预设都不参与）。
  const nonChat = nonChatModelKeywords.some((keyword) => normalizedId.includes(keyword));
  // 已核对过厂商文档的家族优先于目录：目录里的档位表可能是过期的。
  for (const vendor of nonChat ? [] : verifiedVendorReasoningProfiles) {
    if (!vendor.keywords.some((keyword) => normalizedId.includes(keyword))) continue;
    return {
      state: 'supported',
      options: sameNameReasoningOptions(vendor.levels),
      defaultId: vendor.defaultLevel,
      thinkingFormat: route.thinkingFormat,
      basis: 'vendor_docs',
      checkedAt: observedAt,
    };
  }
  const catalogProfile = catalogReasoningProfile(automaticModelCatalogs[route.templateId][normalizedId], normalizedId, route, observedAt);
  if (catalogProfile) return catalogProfile;
  for (const preset of nonChat ? [] : reasoningPresets) {
    if (!preset.keywords.some((keyword) => normalizedId.includes(keyword))) continue;
    return {
      state: 'supported',
      options: sameNameReasoningOptions(preset.levels),
      defaultId: preset.defaultLevel,
      thinkingFormat: route.thinkingFormat,
      basis: 'model_name',
      checkedAt: observedAt,
    };
  }
  // 认不出就不编：空清单表示界面不给下拉、请求不发任何档位字段，由服务端按自己的默认跑。
  return { state: 'unverified', options: [], defaultId: null, thinkingFormat: route.thinkingFormat, basis: 'unidentified', checkedAt: observedAt };
}

/** 内置目录命中的档位清单；目录没声明推理能力时返回「不支持」，没命中返回 null。 */
function catalogReasoningProfile(catalogModel: Model<Api> | undefined, normalizedId: string, route: ReasoningRoute, observedAt: string | null): ConfiguredReasoningProfile | null {
  if (!catalogModel) return null;
  if (!catalogModel.reasoning) return { state: 'unsupported', options: [], defaultId: null, thinkingFormat: route.thinkingFormat, basis: 'catalog', checkedAt: observedAt };
  const declared = catalogModel.thinkingLevelMap ?? {};
  const options: ConfiguredReasoningOption[] = [];
  for (const level of getSupportedThinkingLevels(catalogModel) as PiThinkingLevel[]) {
    const declaredWire = declared[level];
    // off 在 Anthropic 协议上是真的关闭思考；其它协议只有在目录给了明确取值时才算数。
    const offIsReal = typeof declaredWire === 'string' || route.protocolFamily === 'anthropic_messages';
    if (level === 'off' && !offIsReal) continue;
    const wire = typeof declaredWire === 'string' ? declaredWire : level === 'off' ? null : level;
    options.push({ id: level, label: null, piLevel: level, wire });
  }
  if (options.length === 0) return { state: 'unsupported', options: [], defaultId: null, thinkingFormat: route.thinkingFormat, basis: 'catalog', checkedAt: observedAt };
  const preferredLevel = preferredCatalogReasoningLevel(
    normalizedId,
    options.map((option) => option.piLevel),
  );
  const defaultOption = options.find((option) => option.piLevel === preferredLevel) ?? options[0]!;
  return {
    state: 'supported',
    options,
    defaultId: defaultOption.id,
    thinkingFormat: catalogThinkingFormat(catalogModel, route.thinkingFormat),
    // 目录没给任何档位映射时，档位是 Pi 自己推出来的默认假设，可信度要降一档。
    basis: Object.keys(declared).length > 0 ? 'catalog' : 'catalog_default',
    checkedAt: observedAt,
  };
}

/** 目录命中时的默认档偏好：优先中档，gpt-5.6-sol 例外取 low。 */
function preferredCatalogReasoningLevel(modelId: string, levels: readonly PiThinkingLevel[]): PiThinkingLevel {
  const preferences: PiThinkingLevel[] = modelId === 'gpt-5.6-sol' ? ['low', 'medium', 'high', 'off'] : ['medium', 'high', 'low', 'off'];
  return preferences.find((level) => levels.includes(level)) ?? levels[0]!;
}

/** 判断是不是 Pi 认识的档位词；用户手工覆盖档位时用它校验输入。 */
export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return thinkingLevels.has(value as PiThinkingLevel);
}

/** 清单 → 喂给 Pi 的档位集合；两边同源，界面能给出来的档位 Pi 一定认识。 */
export function reasoningPiLevels(profile: ConfiguredReasoningProfile): PiThinkingLevel[] {
  return profile.options.map((option) => option.piLevel);
}

/** 清单 → Pi 的档位取值映射；不在清单里的档位一律 null，Pi 会当成不可用。 */
export function reasoningLevelMap(profile: ConfiguredReasoningProfile): Partial<Record<PiThinkingLevel, string | null>> {
  const map: Partial<Record<PiThinkingLevel, string | null>> = {};
  for (const level of thinkingLevels) map[level] = null;
  const seen = new Set<PiThinkingLevel>();
  for (const option of profile.options) {
    // 同一清单里 piLevel 必须唯一：Pi 的映射表按档位索引，重复会互相覆盖，重复时以先出现的为准。
    if (seen.has(option.piLevel)) continue;
    seen.add(option.piLevel);
    map[option.piLevel] = option.wire;
  }
  return map;
}

/** 清单 → 默认档的 Pi 词；未识别时为 null。 */
export function reasoningDefaultPiLevel(profile: ConfiguredReasoningProfile): PiThinkingLevel | null {
  const preferred = profile.options.find((option) => option.id === profile.defaultId) ?? profile.options[0];
  return preferred?.piLevel ?? null;
}

/**
 * 用户词 → Pi 档位词。
 * 认不出或没传时回落到清单默认档；清单为空（未识别）返回 null，调用方不要设置档位。
 */
export function resolvePiThinkingLevel(profile: ConfiguredReasoningProfile, requestedId?: string | null): PiThinkingLevel | null {
  const requested = typeof requestedId === 'string' ? requestedId.trim() : '';
  if (requested) {
    const hit = profile.options.find((option) => option.id === requested);
    if (hit) return hit.piLevel;
  }
  return reasoningDefaultPiLevel(profile);
}

/** 按连接身份和模型重新判定档位清单，同时保留目录给出的窗口等非档位信息。 */
function applyAutomaticCapabilityProfile(model: ConfiguredModelDefinition, route: Pick<ReasoningRoute, 'templateId' | 'baseUrl' | 'protocolFamily'>): ConfiguredModelDefinition {
  const baseModel = discardManualCapabilityClaims(model);
  const reasoning = resolveReasoningProfile(baseModel, { ...route, modelId: baseModel.id, thinkingFormat: baseModel.capability.reasoning.thinkingFormat });
  const catalogModel = automaticModelCatalogs[route.templateId][baseModel.id.toLowerCase()];
  if (!catalogModel) return { ...baseModel, capability: { ...baseModel.capability, reasoning } };
  const catalogEvidence = (state: ModelCapabilityState, reason: string): ModelCapabilityEvidence => ({ source: 'catalog', state, checkedAt: null, reason });
  return {
    ...baseModel,
    displayName: catalogModel.name,
    // 已知模型采用 Pi 自带目录的窗口，清除旧界面统一生成的 256K 假定。
    contextWindow: catalogModel.contextWindow,
    contextWindowSource: 'catalog',
    maxTokens: Math.min(baseModel.maxTokens, catalogModel.contextWindow),
    supports1MContext: catalogModel.contextWindow >= 1_000_000,
    capability: {
      ...baseModel.capability,
      reasoning,
      imageInput:
        baseModel.capability.imageInput.source === 'probe'
          ? baseModel.capability.imageInput
          : catalogEvidence(catalogModel.input.includes('image') ? 'supported' : 'unsupported', `模型目录声明${catalogModel.input.includes('image') ? '支持' : '不支持'}图片输入；当前接入渠道待真实运行验证。`),
    },
  };
}

/**
 * 旧版界面留下的手工能力声明不再参与运行；工具、图片等证据只有目录、模板或真实探针可以形成。
 * 推理档位不在这里清除：用户手工指定的清单优先级最高，由 resolveReasoningProfile 保留。
 */
function discardManualCapabilityClaims(model: ConfiguredModelDefinition): ConfiguredModelDefinition {
  const resetEvidence = (value: ModelCapabilityEvidence, reason: string): ModelCapabilityEvidence => (value.source === 'manual' ? evidence('unverified', 'catalog', reason) : value);
  return {
    ...model,
    capability: {
      ...model.capability,
      tools: resetEvidence(model.capability.tools, '旧版手工声明已停用，等待真实工具闭环探针。'),
      imageInput: resetEvidence(model.capability.imageInput, '旧版手工声明已停用，等待真实图片输入探针。'),
      streaming: resetEvidence(model.capability.streaming, '旧版手工声明已停用，等待真实流式输出探针。'),
      usage: resetEvidence(model.capability.usage, '旧版手工声明已停用，等待真实用量字段探针。'),
    },
  };
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
  return {
    reasoning: normalizeReasoningProfile(capabilitySource.reasoning, fallbackThinkingFormat),
    tools: normalizeEvidence(capabilitySource.tools, '等待真实工具闭环探针。'),
    imageInput: normalizeEvidence(capabilitySource.imageInput, '等待真实图片输入探针。'),
    streaming: normalizeEvidence(capabilitySource.streaming, '等待真实流式输出探针。'),
    usage: normalizeEvidence(capabilitySource.usage, '等待真实用量字段探针。'),
  };
}

/**
 * 归一推理档位清单，只做结构与合法性检查。
 * 「这个模型该用哪份清单」由 resolveReasoningProfile 判定；这里不许编造档位，读不出来就是未识别。
 */
function normalizeReasoningProfile(value: unknown, fallbackThinkingFormat: OpenAiThinkingFormat): ConfiguredReasoningProfile {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const thinkingFormat = thinkingFormats.has(source.thinkingFormat as OpenAiThinkingFormat) ? (source.thinkingFormat as OpenAiThinkingFormat) : fallbackThinkingFormat;
  const options = normalizeReasoningOptions(source);
  const basis = reasoningProfileBases.has(source.basis as ReasoningProfileBasis) ? (source.basis as ReasoningProfileBasis) : 'unidentified';
  const defaultId = typeof source.defaultId === 'string' && options.some((option) => option.id === source.defaultId) ? source.defaultId : (options[0]?.id ?? null);
  const storedState = normalizeCapabilityState(source.state);
  return {
    state: options.length > 0 ? 'supported' : storedState === 'unsupported' ? 'unsupported' : 'unverified',
    options,
    defaultId,
    thinkingFormat,
    basis,
    checkedAt: normalizeIsoDate(source.checkedAt),
  };
}

/** 档位清单：新形状直接读；旧形状（levels + levelMap）迁移成「同名直传」清单，等下一次判定覆盖。 */
function normalizeReasoningOptions(source: Record<string, unknown>): ConfiguredReasoningOption[] {
  const options: ConfiguredReasoningOption[] = [];
  const push = (candidate: unknown): void => {
    if (!isRecord(candidate)) return;
    const id = typeof candidate.id === 'string' ? candidate.id.trim().slice(0, 60) : '';
    const piLevel = candidate.piLevel;
    // 同一清单里 piLevel 必须唯一，否则 Pi 的映射表会互相覆盖。
    if (!id || !thinkingLevels.has(piLevel as PiThinkingLevel) || options.some((option) => option.id === id || option.piLevel === piLevel)) return;
    options.push({
      id,
      label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim().slice(0, 40) : null,
      piLevel: piLevel as PiThinkingLevel,
      wire: candidate.wire === null || typeof candidate.wire === 'string' ? (candidate.wire as string | null) : null,
    });
  };
  if (Array.isArray(source.options)) {
    for (const candidate of source.options.slice(0, thinkingLevels.size)) push(candidate);
    return options;
  }
  const legacyMap = isRecord(source.levelMap) ? source.levelMap : {};
  if (Array.isArray(source.levels)) {
    for (const item of source.levels.slice(0, thinkingLevels.size)) {
      if (!thinkingLevels.has(item as PiThinkingLevel)) continue;
      const legacyWire = legacyMap[item as string];
      push({ id: item, piLevel: item, wire: typeof legacyWire === 'string' ? legacyWire : item === 'off' ? null : item });
    }
  }
  return options;
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

/** 价格页面独立于模型接口，不接受凭据及非网页协议。 */
function normalizePricingPageUrl(value: string): string {
  const url = new URL(value.trim());
  if (value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('价格页面必须是无凭据的 HTTP 或 HTTPS 地址。');
  return url.href;
}
