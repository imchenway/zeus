export type AgentKind = 'codex' | 'pi' | 'claude';

export type AgentTransportKind = 'app_server' | 'rpc' | 'sdk';

export type AgentSupportStatus = 'unavailable' | 'framework_only' | 'experimental' | 'verified';

export type AgentCapabilityState = 'supported' | 'unsupported' | 'unverified';

export type AgentCapabilityId = 'session' | 'streaming' | 'steer' | 'follow_up' | 'interrupt' | 'approval' | 'user_input' | 'model_catalog' | 'service_tier' | 'usage' | 'compaction' | 'retry';

export interface AgentCapabilityEvidence {
  state: AgentCapabilityState;
  checkedAt: string | null;
  adapterVersion: string | null;
  binaryVersion: string | null;
  reason: string;
}

export interface AgentDescriptor {
  kind: AgentKind;
  displayName: string;
  transport: AgentTransportKind;
  supportStatus: AgentSupportStatus;
  visibleToUsers: boolean;
  capabilities: Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>>;
}

export interface AgentModelIdentity {
  sourceId: string | null;
  modelId: string;
  displayName: string | null;
}

export interface AgentSessionIdentity {
  agentKind: AgentKind;
  nativeSessionId: string;
  nativeSessionPath: string | null;
  runtimeInstanceId: string;
}

export interface AgentRuntimeProbe {
  available: boolean;
  checkedAt: string;
  adapterVersion: string | null;
  binaryVersion: string | null;
  protocolVersion: string | null;
  reason: string;
}

export interface OpenAgentSessionInput {
  cwd: string;
  model: AgentModelIdentity;
  metadata?: Record<string, unknown>;
}

export interface ResumeAgentSessionInput {
  nativeSessionId: string;
  nativeSessionPath?: string | null;
  cwd?: string;
}

export interface AgentImageInput {
  data: string;
  mimeType: string;
}

export interface StartAgentRunInput {
  session: AgentSessionIdentity;
  content: string;
  clientRequestId: string;
  model?: AgentModelIdentity;
  thinkingLevel?: string;
  images?: AgentImageInput[];
  /** Pi 在进入 agent run 前同步返回预检结论；false 表示请求不会写给模型。 */
  preflightResult?: (accepted: boolean) => void;
  /** 只在预检成功时同步执行，回调抛错必须阻止 agent run。 */
  durableTransactionSync?: (acceptance: AcceptedAgentRun) => void;
  /** 同步持久接纳完成后、Pi 可能开始 Provider 写入前的边界通知。 */
  providerWriteMayStart?: () => void;
  /** Provider 适配器完成最终请求体序列化后的脱敏缓存证据。 */
  providerPayloadObserved?: (diagnostic: AgentProviderPayloadDiagnostic) => void;
}

export interface AgentProviderPayloadFingerprint {
  fingerprint: string;
  byteLength: number;
}

export interface AgentProviderPayloadMessageFingerprint extends AgentProviderPayloadFingerprint {
  index: number;
  role: string;
  cacheBreakpointCount: number;
  /** 忽略缓存控制元数据后的正文指纹，用于判断历史前缀是否真实变化。 */
  contentFingerprint: string;
}

export interface AgentProviderPayloadDiagnostic {
  schemaVersion: 1;
  api: string;
  modelId: string;
  request: AgentProviderPayloadFingerprint;
  sections: {
    system: AgentProviderPayloadFingerprint | null;
    tools: (AgentProviderPayloadFingerprint & { count: number }) | null;
    messages: AgentProviderPayloadFingerprint & { count: number; entries: AgentProviderPayloadMessageFingerprint[] };
  };
  cache: {
    promptCacheKey: { present: boolean; fingerprint: string | null; byteLength: number | null };
    retention: string | null;
    explicitMode: string | null;
    explicitTtl: string | null;
    breakpointCount: number;
    breakpointPaths: string[];
  };
}

export interface SteerAgentRunInput extends StartAgentRunInput {
  nativeRunId: string;
}

export type FollowUpAgentRunInput = StartAgentRunInput;

export interface InterruptAgentRunInput {
  session: AgentSessionIdentity;
  nativeRunId: string;
}

export interface RespondAgentInteractionInput {
  session: AgentSessionIdentity;
  requestId: string;
  response: unknown;
}

export interface ReadAgentSessionInput {
  session: AgentSessionIdentity;
}

export interface AcceptedAgentRun {
  nativeRunId: string;
  acceptedAt: string;
}

export interface CompactAgentSessionInput {
  session: AgentSessionIdentity;
  thinkingLevel?: string;
  customInstructions: string;
}

export interface CompactAgentSessionResult {
  summary: string;
  tokensBefore: number;
  estimatedTokensAfter: number | null;
  usage: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    outputTokens: number | null;
    reasoningOutputTokens: number | null;
    totalTokens: number | null;
  };
}

export interface AgentSessionSnapshot {
  session: AgentSessionIdentity;
  state: 'idle' | 'active' | 'waiting' | 'paused' | 'failed';
  raw: unknown;
}

export interface AgentRuntimeEvent {
  agentKind: AgentKind;
  runtimeInstanceId: string;
  nativeSessionId: string | null;
  nativeRunId: string | null;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

/**
 * Agent 驱动只描述 Zeus 需要的共同动作；每次调用前仍必须检查能力证据。
 * 当前公共框架没有提供 Pi 的实现，也不会启动 Pi 进程。
 */
export interface AgentRuntimeDriver {
  readonly kind: AgentKind;

  probe(): Promise<AgentRuntimeProbe>;

  readCapabilities(): Promise<AgentDescriptor>;

  openSession(input: OpenAgentSessionInput): Promise<AgentSessionIdentity>;

  resumeSession(input: ResumeAgentSessionInput): Promise<AgentSessionIdentity>;

  startRun(input: StartAgentRunInput): Promise<AcceptedAgentRun>;

  steerRun(input: SteerAgentRunInput): Promise<AcceptedAgentRun>;

  followUp(input: FollowUpAgentRunInput): Promise<AcceptedAgentRun>;

  compactSession(input: CompactAgentSessionInput): Promise<CompactAgentSessionResult>;

  interruptRun(input: InterruptAgentRunInput): Promise<void>;

  respondToInteraction(input: RespondAgentInteractionInput): Promise<void>;

  readSession(input: ReadAgentSessionInput): Promise<AgentSessionSnapshot>;

  recover(): Promise<void>;

  close(input: { mode: 'handoff' | 'final' }): Promise<void>;

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
}
