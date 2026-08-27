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
  /** 请求发出前是否存在 Provider/Runtime 自己提供的精确 token count；不可用时不得用字符估算冒充。 */
  preflightTokenCount: AgentPreflightTokenCountCapability;
}

export type AgentPreflightTokenCountCapability =
  | {
      state: 'available';
      exact: true;
      source: 'provider_api' | 'runtime_rpc' | 'runtime_sdk';
      checkedAt: string;
      reason: string;
    }
  | {
      state: 'unavailable';
      exact: false;
      source: null;
      checkedAt: string | null;
      reason: string;
    };

export interface AgentPreflightTokenCountInput {
  model: AgentModelIdentity;
  /** 必须是即将发送给 Provider 的完整序列化请求；只数正文会低估 system、tools 与媒体开销。 */
  serializedRequest: unknown;
}

export interface AgentPreflightTokenCountResult {
  inputTokens: number;
  exact: true;
  source: Exclude<AgentPreflightTokenCountCapability, { state: 'unavailable' }>['source'];
  countedAt: string;
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
  traceIdentity?: string | null;
}

export interface ResumeAgentSessionInput {
  nativeSessionId: string;
  nativeSessionPath?: string | null;
  cwd?: string;
  traceIdentity?: string | null;
}

export interface AgentImageInput {
  data: string;
  mimeType: string;
}

/** Core 已编译并审计的应用级上下文；只有 Runtime 的正式 system/application 通道可以消费。 */
export interface AgentRunApplicationContext {
  fingerprint: string;
  manifest: string;
  content: string;
}

/** Core 已编译的不可信上下文；必须留在当前 user/custom message，禁止升格为 system。 */
export interface AgentRunUntrustedContext {
  fingerprint: string;
  content: string;
}

/** Core 已解析的 Zeus Skill；Runtime Adapter 必须把同一份内容投影到自己的原生 Skill 通道。 */
export interface AgentRunSkillActivation {
  id: string;
  name: string;
  description: string;
  path: string;
}

export interface StartAgentRunInput {
  session: AgentSessionIdentity;
  content: string;
  clientRequestId: string;
  model?: AgentModelIdentity;
  thinkingLevel?: string;
  images?: AgentImageInput[];
  applicationContext?: AgentRunApplicationContext;
  untrustedContext?: AgentRunUntrustedContext;
  skill?: AgentRunSkillActivation;
  /** 仅用于 Zeus 内部 Command/Worker/RPC/回执性能关联，不进入 Provider 正文。 */
  traceIdentity?: string | null;
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
  traceIdentity?: string | null;
}

export interface RespondAgentInteractionInput {
  session: AgentSessionIdentity;
  requestId: string;
  response: unknown;
  traceIdentity?: string | null;
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
  traceIdentity?: string | null;
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

export type AgentRuntimeLifecycleState = 'stopped' | 'starting' | 'healthy' | 'degraded' | 'circuit_open' | 'recovering' | 'closing';

export type AgentRuntimeFailureKind = 'startup' | 'timeout' | 'authentication' | 'rate_limit' | 'protocol_incompatible' | 'process_exit' | 'unknown';

export interface AgentRuntimeFailureSnapshot {
  kind: AgentRuntimeFailureKind;
  code: string;
  message: string;
  occurredAt: string;
  resultUnknown: boolean;
}

export interface AgentRuntimeCircuitSnapshot {
  state: 'closed' | 'open' | 'half_open';
  openedAt: string | null;
  reason: AgentRuntimeFailureKind | null;
  /** 熔断后只能由明确恢复动作进入新代次；不得在原请求内部自动重发。 */
  recovery: 'explicit' | 'automatic_supervised';
}

/** Provider 进程的统一只读运行态；业务会话状态仍由会话编排拥有。 */
export interface AgentRuntimeHealthSnapshot {
  agentKind: AgentKind;
  transport: AgentTransportKind;
  generationId: string | null;
  lifecycle: AgentRuntimeLifecycleState;
  protocolVersion: string | null;
  processId: number | null;
  checkedAt: string;
  consecutiveFailures: number;
  circuit: AgentRuntimeCircuitSnapshot;
  lastFailure: AgentRuntimeFailureSnapshot | null;
}

/**
 * Agent 驱动只描述 Zeus 需要的共同动作；每次调用前仍必须检查能力证据。
 * 具体 Provider 可在 Core 内代理受监督的独立运行代次，但不得把业务状态所有权交给 Worker。
 */
export interface AgentRuntimeDriver {
  readonly kind: AgentKind;

  probe(): Promise<AgentRuntimeProbe>;

  readCapabilities(): Promise<AgentDescriptor>;

  /** 仅在 descriptor.preflightTokenCount.state=available 时存在；无真实端口的 Adapter 必须省略。 */
  countInputTokens?(input: AgentPreflightTokenCountInput): Promise<AgentPreflightTokenCountResult>;

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

export interface SupervisedAgentRuntimeDriver extends AgentRuntimeDriver {
  getRuntimeHealth(): AgentRuntimeHealthSnapshot;

  /** 只创建新运行代次并恢复原生身份；绝不重放导致故障的上一条命令。 */
  recoverRuntime(input: { reason: 'explicit_user_action' | 'explicit_runtime_need' }): Promise<AgentRuntimeHealthSnapshot>;
}
