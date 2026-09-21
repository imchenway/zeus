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

export type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  runtimeAdapter: 'codex_app_server' | 'pi_sdk';
  protocolFamily: ModelProtocolFamily;
  authenticationScheme: ModelAuthenticationScheme;
  capability: {
    reasoning: {
      state: ModelCapabilityState;
      levels: ModelThinkingLevel[];
      defaultLevel: ModelThinkingLevel;
      thinkingFormat: ModelThinkingFormat;
      levelMap: Partial<Record<ModelThinkingLevel, string | null>>;
      source: ModelCapabilityEvidence['source'];
      checkedAt: string | null;
      reason: string;
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
  supportedReasoningEfforts: ModelThinkingLevel[];
  defaultReasoningEffort: ModelThinkingLevel | null;
  serviceTiers: [];
  defaultServiceTier: null;
  speedLabel: ModelConnectionModel['speedLabel'];
  tools: ModelCapabilityState;
  imageInput: ModelCapabilityState;
  runtimeAdapter: 'codex_app_server' | 'pi_sdk';
  protocolFamily: ModelProtocolFamily;
  authenticationScheme: ModelAuthenticationScheme;
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
