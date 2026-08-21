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
  enabled: boolean;
  supports1MContext: boolean;
  contextWindow: number;
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

export interface ModelConnectionDiagnostic {
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

export interface ProjectModelSelection {
  projectId: string;
  allowedModelRefs: string[];
  defaultModelRef: string | null;
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
