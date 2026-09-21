import type { UserFacingErrorCause, ZentaoRemoteItemSummary } from '@zeus/shared';
import type { TaskRecord } from '../tasks/taskContracts.js';

export type { ZentaoRemoteExecutionSummary, ZentaoRemoteItemDetail, ZentaoRemoteItemSummary, ZentaoRemoteListResult, ZentaoRemoteProductSummary, ZentaoRemoteProjectSummary, ZentaoTaskSyncRequest } from '@zeus/shared';

export interface ZentaoTaskSyncResult {
  mode: 'created' | 'updated';
  task: TaskRecord;
  remote: ZentaoRemoteItemSummary;
}

export interface SecretPresence {
  configured: boolean;
  label: '已安全保存' | '未配置';
}

export interface SecuritySecretsSnapshot {
  telegramBotToken: SecretPresence;
  externalApiKey: SecretPresence;
}

export type ModelConnectionTemplateId = 'custom' | 'deepseek' | 'bailian' | 'kimi' | 'zai';

export type ModelCapabilityState = 'supported' | 'unsupported' | 'unverified';

/** Pi 认识的七个档位词，只作为 Zeus 内部的中转词；界面显示的是用户词。 */
export type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 档位清单的来源，决定界面标签和这份清单有多可信。 */
export type ModelReasoningBasis = 'official_endpoint' | 'catalog' | 'catalog_default' | 'model_name' | 'user' | 'unidentified';

export type ModelThinkingFormat = 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling';

export type ModelProtocolFamily = 'openai_responses' | 'openai_completions' | 'anthropic_messages';

export type ModelAuthenticationScheme = 'protocol_default' | 'bearer' | 'x_api_key';

export interface ModelCapabilityEvidence {
  source: 'template' | 'catalog' | 'manual' | 'probe';
  state: ModelCapabilityState;
  checkedAt: string | null;
  reason: string;
}

export interface ModelConnectionModel {
  id: string;
  displayName: string;
  /** 能力探测时服务端回报的实际服务模型标识；未探测或未回报时为空。 */
  servedModelId?: string | null;
  /** 厂商官方文档登记的版本名（人工维护表）；未登记时为空。 */
  officialVersion?: string | null;
  enabled: boolean;
  supports1MContext: boolean;
  contextWindow: number;
  /** 目录容量为只读事实，用户通过会话设置选择实际使用的容量。 */
  contextWindowSource?: 'catalog';
  maxTokens: number;
  speedLabel: 'standard' | 'high_speed' | 'flash' | 'turbo';
  protocolFamily: ModelProtocolFamily;
  authenticationScheme: ModelAuthenticationScheme;
  capability: {
    /**
     * 推理档位清单：用户词（id）、Pi 中转词（piLevel）、线上取值（wire）三件事分开记，
     * 界面显示 id，Pi 收到 piLevel，厂商收到 wire。
     */
    reasoning: {
      state: ModelCapabilityState;
      options: { id: string; label?: string | null; piLevel: ModelThinkingLevel; wire: string | null }[];
      defaultId: string | null;
      thinkingFormat: ModelThinkingFormat;
      basis: ModelReasoningBasis;
      checkedAt: string | null;
    };
    tools: ModelCapabilityEvidence;
    imageInput: ModelCapabilityEvidence;
    streaming: ModelCapabilityEvidence;
    usage: ModelCapabilityEvidence;
  };
}

export interface ModelConnectionRecord {
  id: string;
  name: string;
  templateId: ModelConnectionTemplateId;
  baseUrl: string;
  modelsPath: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
  models: ModelConnectionModel[];
  createdAt: string;
  updatedAt: string;
}

export interface SaveModelConnectionRequest {
  name: string;
  templateId: ModelConnectionTemplateId;
  baseUrl: string;
  modelsPath: string;
  enabled: boolean;
  models: ModelConnectionModel[];
  apiKey?: string;
  allowInsecureHttp?: boolean;
}

/** 单个模型的探测结论，字段与后端回执一致。 */
export interface ModelCapabilityProbeItem {
  modelId: string;
  ok: boolean;
  servedModelId: string | null;
  capability: ModelConnectionModel['capability'];
  message: string;
}

/** 一次能力探测的回执；未探测的模型单独列出，界面必须如实说明。 */
export interface ModelCapabilityProbeSummary {
  connection: ModelConnectionRecord;
  results: ModelCapabilityProbeItem[];
  skippedModelIds: string[];
  checkedAt: string;
}

export interface ModelConnectionDiagnostic {
  /** 保留连接检查的底层原因，供中英文错误摘要与详情使用。 */
  cause?: UserFacingErrorCause;
  ok: boolean;
  stage: 'configuration' | 'credential' | 'catalog';
  code: string;
  message: string;
  checkedAt: string;
  discoveredModelCount: number | null;
}

export interface SelectablePiModel {
  id: string;
  model: string;
  displayName: string;
  sourceId: string;
  sourceName: string;
  agentKind: 'pi';
  enabled: boolean;
  available: boolean;
  supports1MContext: boolean;
  availabilityReason: string;
  /** 用户可见的档位（厂商口径的词），界面直接显示这些。 */
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  serviceTiers: [];
  defaultServiceTier: null;
  speedLabel: ModelConnectionModel['speedLabel'];
  tools: ModelCapabilityState;
  imageInput: ModelCapabilityState;
  /** 模型连接一律由 Zeus 内核执行；Codex App Server 只服务订阅目录里的模型。 */
  runtimeAdapter: 'pi_sdk';
  protocolFamily: ModelProtocolFamily;
  authenticationScheme: ModelAuthenticationScheme;
}

/** 用户手工覆盖档位时提交的一项。 */
export interface ModelReasoningOverrideOption {
  id: string;
  label?: string | null;
  piLevel: ModelThinkingLevel;
  wire: string | null;
}

/** 逐档体检的单条观测结果。 */
export interface ModelReasoningAuditEntry {
  id: string;
  piLevel: ModelThinkingLevel;
  wire: string | null;
  ok: boolean;
  failure: string | null;
  thinkingSeen: boolean;
  reasoningTokens: number | null;
}

export interface ModelReasoningAuditResult {
  modelId: string;
  entries: ModelReasoningAuditEntry[];
  verdict: string;
}

export interface SecurityAuditLogEntry {
  id: string;
  actorType: string;
  actorRef: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}
