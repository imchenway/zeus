import type {
  ConversationContextDraft,
  ConversationResource,
  NativeTokenUsageSnapshot as SharedNativeTokenUsageSnapshot,
  TaskPushParentContextOption,
  TaskPushParentContextSelection,
  TaskPushRelatedContextOption,
  TaskPushRelatedContextSelection,
  TurnChangeSet,
  ZeusBrowserComment,
  ZeusBrowserPreparedSubmission,
} from '@zeus/shared';

export type { ConversationResource, ConversationResourcePreview, TurnChangeSet, TurnChangeSetOperationResult } from '@zeus/shared';

export type TransportState = 'disconnected' | 'connecting' | 'hydrating' | 'ready' | 'reconnecting' | 'failed';

export type ConversationState =
  | 'legacy_readonly'
  | 'native_loading'
  | 'native_idle'
  | 'starting_turn'
  | 'active_prework'
  | 'active_final_answer'
  | 'waiting_approval'
  | 'waiting_user_input'
  | 'interrupt_confirm'
  | 'interrupting'
  | 'turn_failed';

export type ThreadFollowMode = 'static' | 'prework_watch' | 'prework_follow' | 'user_follow';
export type NativePermissionMode = 'read-only' | 'auto' | 'full-access';
export type NativeCollaborationMode = 'default' | 'plan';
export type NativeGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface NativeGoalSnapshot {
  conversationId: string;
  providerThreadId: string;
  objective: string;
  status: NativeGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  providerCreatedAt: number;
  providerUpdatedAt: number;
  updatedAt: string;
}

export interface NativeGoalTimelineEvent {
  id: string;
  conversationId: string;
  providerThreadId: string;
  providerTurnId: string | null;
  kind: 'created' | 'edited' | 'paused' | 'resumed' | 'blocked' | 'usage_limited' | 'budget_limited' | 'completed' | 'cleared';
  objective: string | null;
  status: NativeGoalStatus | null;
  tokenBudget: number | null;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
  occurredAt: string;
}

export interface NativeGoalCapability {
  supported: boolean;
  enabled: boolean;
  stage: 'beta' | 'underDevelopment' | 'stable' | 'deprecated' | 'removed' | null;
  reason: 'available' | 'disabled' | 'agent_unsupported' | 'app_server_unsupported' | 'unverified';
}

export interface NativeGoalResponse {
  goal: NativeGoalSnapshot | null;
  timeline: NativeGoalTimelineEvent[];
  capability: NativeGoalCapability;
}

export type NativeTurnPlanStepStatus = 'pending' | 'inProgress' | 'completed';

export interface NativeTurnPlanStep {
  step: string;
  status: NativeTurnPlanStepStatus;
}

export interface NativeTurnPlanSnapshot {
  explanation: string | null;
  steps: NativeTurnPlanStep[];
}

export type SessionConversationOwner = { kind: 'project'; projectId: string; projectName: string } | { kind: 'task'; projectId: string; projectName: string; taskId: string; taskTitle: string };

interface NativeConversationAttachmentBase {
  name: string;
  mime: string;
  size: number;
  kind?: 'image' | 'file' | 'directory' | 'pasted_text';
  source?: 'picker' | 'paste' | 'drop';
  characterCount?: number;
  /** 仅保留 Codex App 同级可恢复范围内的粘贴文本，不写入服务端持久化附件。 */
  restorableText?: string;
  taskPushAttachmentKey?: string;
}

export type NativeConversationAttachment = NativeConversationAttachmentBase & ({ localPath: string; uploadRef?: never } | { localPath?: never; uploadRef: string });

export type TaskPushSupplementalAttachmentDraft = NativeConversationAttachment & { taskPushAttachmentKey: string };

export type TaskPushSupplementalAttachmentInput = {
  taskPushAttachmentKey: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
} & ({ localPath: string; uploadRef?: never } | { localPath?: never; uploadRef: string });

export interface NativeTurnSnapshot {
  id: string;
  providerTurnId: string | null;
  submissionId: string | null;
  status: string;
  error?: NativeTurnFailureSnapshot | null;
  plan?: NativeTurnPlanSnapshot | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NativeTurnFailureCategory = 'authentication' | 'rate_limit' | 'network' | 'configuration' | 'permission' | 'unknown';

export interface NativeTurnFailureSnapshot {
  category: NativeTurnFailureCategory;
  code: string | null;
  message: string;
  providerStatus: string | null;
  additionalDetails: string[];
}

export interface NativeItemSnapshot {
  id: string;
  turnId: string;
  providerItemId: string | null;
  type: string;
  status: string;
  phase: string;
  text: string;
  payload: Record<string, unknown>;
  resources?: ConversationResource[];
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type NativeSubagentStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed' | 'unknown';

export interface NativeSubagentSummary {
  id: string;
  parentThreadId: string | null;
  title: string;
  nickname: string | null;
  role: string | null;
  path: string | null;
  preview: string;
  status: NativeSubagentStatus;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface NativeSubagentListSnapshot {
  conversationId: string;
  parentThreadId: string;
  items: NativeSubagentSummary[];
}

export interface NativeSubagentThreadTurn {
  id: string;
  status: string;
  items: NativeItemSnapshot[];
}

export type NativeRuntimeFact<T> = { state: 'available'; value: T } | { state: 'unavailable'; reason: string };

export interface NativeRuntimeDetailsSnapshot {
  model: NativeRuntimeFact<string>;
  effort: NativeRuntimeFact<string>;
  serviceTier: NativeRuntimeFact<string | null>;
  usage: {
    serviceTier: NativeRuntimeFact<string | null>;
    totalTokens: NativeRuntimeFact<number>;
    inputTokens: NativeRuntimeFact<number>;
    outputTokens: NativeRuntimeFact<number>;
    reasoningOutputTokens: NativeRuntimeFact<number>;
    contextTokens: NativeRuntimeFact<number>;
    contextWindow: NativeRuntimeFact<number>;
    cacheHitRate: NativeRuntimeFact<number>;
    apiEquivalentUsd: NativeRuntimeFact<number>;
    priceCoverage: NativeRuntimeFact<number>;
    pricingCatalogDate: NativeRuntimeFact<string>;
    pricingSourceUrls: NativeRuntimeFact<string[]>;
    historyComplete: NativeRuntimeFact<boolean>;
  };
  performance: {
    latestOutputTokensPerSecond: NativeRuntimeFact<number>;
    latestFirstVisibleResponseMs: NativeRuntimeFact<number>;
    cumulativeProcessedDurationMs: NativeRuntimeFact<number>;
  };
  activity: {
    turnCount: NativeRuntimeFact<number>;
    modelRequestCount: NativeRuntimeFact<number>;
    toolOrCommandCount: NativeRuntimeFact<number>;
    retryCount: NativeRuntimeFact<number>;
    failedTurnCount: NativeRuntimeFact<number>;
  };
  changeSummary: NativeRuntimeFact<{ fileCount: number; addedLines: number; deletedLines: number; complete: boolean }>;
  environment: {
    cwd: NativeRuntimeFact<string>;
    branch: NativeRuntimeFact<string>;
    nativeSessionId: NativeRuntimeFact<string>;
    nativeSessionPath: NativeRuntimeFact<string>;
  };
}

export interface NativeSubagentHistoryBoundary {
  state: 'confirmed' | 'unavailable';
  createdAt: string | null;
  ownedTurnCount: number;
  hiddenInheritedTurnCount: number;
  hiddenAmbiguousTurnCount: number;
  reason: string | null;
}

export interface NativeSubagentThreadSnapshot {
  conversationId: string;
  parentThreadId: string;
  agent: NativeSubagentSummary;
  taskInstruction: NativeSubagentPromptFact;
  inheritedContext: NativeSubagentPromptFact;
  historyBoundary: NativeSubagentHistoryBoundary;
  runtime: NativeRuntimeDetailsSnapshot;
  turns: NativeSubagentThreadTurn[];
}

export interface NativeSubagentPromptFact {
  state: 'available' | 'unavailable';
  text: string | null;
  source: 'collaboration_prompt' | 'provider_thread_source' | 'provider_thread_preview' | null;
  reason: string | null;
}

export interface NativeQueuedSubmission {
  id: string;
  conversationId?: string;
  content: string;
  composerDraft?: string;
  status: string;
  delivery?: 'queue' | 'steer_now';
  attachments?: NativeConversationAttachment[];
  browserComments?: ZeusBrowserComment[];
  browserCommentContent?: string;
  conversationContext?: ConversationContextDraft;
  expectedTurnId?: string | null;
  clientUserMessageId?: string;
  controlAction?: 'implement_plan' | 'refine_plan';
  recoveryKind?: 'interaction_response';
  position: number;
  providerTurnId?: string | null;
  pausedReason: string | null;
  error?: {
    code: string;
    message: string;
    recoveryRequired: boolean;
  } | null;
  createdAt?: string;
  updatedAt?: string;
}

export type NativeConversationRunState =
  | { type: 'idle' }
  | { type: 'dispatching'; submissionId: string }
  | { type: 'active'; turnId: string; phase: 'prework' | 'final_answer' }
  | { type: 'waiting'; turnId: string; requestId: string; reason: 'approval' | 'user_input' }
  | {
      type: 'paused';
      reason:
        | 'interrupted'
        | 'transport_unavailable'
        | 'provider_archived'
        | 'provider_stop_pending'
        | 'interaction_authority_missing'
        | 'recovered_unsent'
        | 'recovery_required'
        | 'runtime_rejected'
        | 'conflict_preparing'
        | 'conflict_preparation_failed';
    };

export type NativeQueueWaitReason =
  | 'current_turn'
  | 'dispatching'
  | 'user_input'
  | 'approval'
  | 'plan_confirmation'
  | 'execution_context_preparing'
  | 'interrupted'
  | 'transport_unavailable'
  | 'provider_archived'
  | 'provider_stop_pending'
  | 'interaction_authority_missing'
  | 'recovered_unsent'
  | 'recovery_required'
  | 'runtime_rejected'
  | 'conflict_preparing'
  | 'conflict_preparation_failed'
  | 'user_confirmation'
  | 'dispatch_pending';

export interface NativeQueueSnapshot {
  state: NativeConversationRunState;
  waitReason?: NativeQueueWaitReason;
  submissions: NativeQueuedSubmission[];
}

export interface NativePendingRequest {
  id: string;
  conversationId: string;
  turnId: string | null;
  itemId: string | null;
  generationId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  containsSecret: boolean;
  expiresAt: string | null;
  autoResolutionState?: 'none' | 'scheduled' | 'snoozed';
  createdAt: string;
  resolvedAt: string | null;
  fileApproval?: {
    status: 'auditable' | 'outside_project' | 'provider_root_scope' | 'unavailable';
    paths: string[];
  };
}

export interface NativePlanImplementationRequest {
  id: string;
  conversationId: string;
  turnId: string;
  planItemId: string;
  status: 'pending' | 'dismissed' | 'implemented' | 'refinement_requested' | 'superseded';
  submissionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface NativePendingInteractionsSnapshot {
  conversationId: string;
  requests: NativePendingRequest[];
  planImplementationRequests?: NativePlanImplementationRequest[];
}

export interface NativeProviderSettingsSnapshot {
  generationId?: string;
  sequence?: number;
  model: string;
  effort?: string;
  serviceTier?: string | null;
}

export interface NativeNextTurnSettings {
  model: string;
  effort?: string;
  serviceTier?: string | null;
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
}

export type NativeTokenUsageSnapshot = SharedNativeTokenUsageSnapshot;

export interface NativeNullableUsageBreakdown {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  estimatedUsd: number | null;
  complete: boolean;
}

export interface NativeModelRequestUsageObservation extends Omit<NativeNullableUsageBreakdown, 'complete'> {
  id: string;
  turnId: string | null;
  segmentId: string;
  requestKind: 'inference' | 'tool_continuation' | 'retry' | 'context_compaction';
  requestSequence: number;
  modelId: string;
  contextWindow: number | null;
  usageComplete: boolean;
  providerRequestId: string | null;
  firstVisibleOutputAt: string | null;
  firstTextOutputAt: string | null;
  completedAt: string | null;
  measurementComplete: boolean;
  occurredAt: string;
}

export interface NativeUnifiedUsageSnapshot {
  conversationTotal: NativeNullableUsageBreakdown;
  turnTotal: NativeNullableUsageBreakdown;
  latestModelRequest: NativeModelRequestUsageObservation | null;
  preflightEstimate: null;
}

export interface NativeSessionMetricsSnapshot {
  usage: NativeUnifiedUsageSnapshot;
  cost: {
    apiEquivalentUsd: number | null;
    priceCoverage: number | null;
    pricingCatalogDate: string | null;
    pricingSourceUrls: string[];
    historyComplete: boolean;
    complete: boolean;
  };
  performance: {
    latestOutputTokensPerSecond: number | null;
    latestFirstVisibleResponseMs: number | null;
    cumulativeProcessedDurationMs: number | null;
    complete: boolean;
  };
  activity: {
    turnCount: number;
    modelRequestCount: number;
    toolOrCommandCount: number;
    retryCount: number;
    failedTurnCount: number;
    complete: boolean;
  };
  changeSummary: {
    available: boolean;
    fileCount: number | null;
    addedLines: number | null;
    deletedLines: number | null;
    complete: boolean;
  };
  updatedAt: string | null;
}

export interface NativeProviderValueSnapshot {
  generationId?: string;
  sequence?: number;
  value: Record<string, unknown>;
}

export interface NativeConversationExecutionContext {
  cwd: string | null;
  branch: string | null;
  isGitRepository: boolean | null;
}

export type NativeConversationStage = 'created' | 'connecting' | 'queued' | 'running' | 'waiting_user' | 'waiting_approval' | 'completed' | 'failed' | 'paused' | 'ready' | 'archived';

export interface NativeConversationSnapshot {
  conversationSchemaGeneration: '2026-08-16-unified-conversation-segments';
  syncStreamGeneration: 'zeus-conversation-sync-v2';
  throughEventSeq: number;
  productConversation: Record<string, unknown>;
  openSegment: Record<string, unknown> | null;
  segments: Record<string, unknown>[];
  composerPreset: Record<string, unknown>;
  executionQueue: NativeQueueSnapshot;
  process: Record<string, unknown>[];
  usage: NativeUnifiedUsageSnapshot;
  contextState: Record<string, unknown>;
  persistentWarnings: Record<string, unknown>[];
  configurationEvidence: Record<string, unknown>[];
  id: string;
  projectId: string;
  taskId: string | null;
  sessionId: string | null;
  title: string;
  summary: string | null;
  status: string;
  stage: NativeConversationStage;
  stageUpdatedAt: string;
  transportKind: 'codex_native' | 'legacy_cli' | string;
  providerId: string | null;
  providerThreadId: string | null;
  providerModel: string | null;
  providerState: string | null;
  legacySourceConversationId?: string | null;
  provider: {
    id: string | null;
    threadId: string | null;
    model: string | null;
    state: string | null;
  };
  agent?: NativeAgentIdentity;
  model?: NativeModelIdentity;
  nativeSession?: NativeSessionIdentity;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  hasUnreadAttention: boolean;
  attentionKind: NativeConversationAttentionKind;
  attentionRevision: number;
  attentionTurnId: string | null;
  attentionUpdatedAt: string | null;
  pendingRequestKind: 'approval' | 'user_input' | null;
  messages: NativeConversationMessage[];
  turns: NativeTurnSnapshot[];
  items: NativeItemSnapshot[];
  changeSets?: TurnChangeSet[];
  submissions: NativeQueuedSubmission[];
  queue: NativeQueueSnapshot;
  requests: NativePendingRequest[];
  planImplementationRequests: NativePlanImplementationRequest[];
  providerSettings?: NativeProviderSettingsSnapshot;
  nextTurnSettings?: NativeNextTurnSettings;
  tokenUsage?: NativeTokenUsageSnapshot;
  sessionMetrics?: NativeSessionMetricsSnapshot;
  rateLimits?: NativeProviderValueSnapshot;
  mcpStartup?: NativeProviderValueSnapshot;
  executionContext?: NativeConversationExecutionContext;
  permissionMode?: NativePermissionMode;
  collaborationMode?: NativeCollaborationMode;
  goal?: NativeGoalSnapshot | null;
  goalTimeline?: NativeGoalTimelineEvent[];
  goalCapability?: NativeGoalCapability;
  /** V2 首屏与按需页的客户端游标状态；旧 V1 快照不存在该字段。 */
  snapshotV2?: NativeConversationSnapshotV2;
  v2Paging?: NativeConversationV2PagingState;
}

export interface NativeBoundedContentProjection {
  preview: string;
  byteLength: number;
  truncated: boolean;
  redacted: boolean;
  contentHandle: string | null;
  refreshRequired: boolean;
}

export interface NativeConversationSnapshotV2Turn {
  id: string;
  providerTurnId: string | null;
  submissionId: string | null;
  status: string;
  hasError: boolean;
  hasPlan: boolean;
  plan: NativeTurnPlanSnapshot | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentKind: string | null;
  openingUserMessage: NativeConversationModelHistoryV2Item | null;
  activeItems?: NativeConversationActiveItemV2[];
  activeItemsTruncated?: boolean;
  process: { available: boolean; latestSequence: number };
  resourcesAvailable: boolean;
  changeSetAvailable: boolean;
}

export interface NativeConversationActiveItemV2 {
  id: string;
  order: number;
  turnId: string;
  providerItemId: string;
  itemType: string;
  status: 'in_progress';
  phase: 'prework' | 'final_answer';
  text: NativeBoundedContentProjection;
  payload: NativeBoundedContentProjection;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface NativeConversationSnapshotV2 {
  schemaVersion: 2;
  structureGeneration: '2026-08-29-conversation-snapshot-v2-recovered-request-input';
  conversationSchemaGeneration: '2026-08-16-unified-conversation-segments';
  throughEventSeq: number;
  eventStreamGeneration: string | null;
  conversation: {
    id: string;
    projectId: string;
    taskId: string | null;
    title: string;
    titleRedacted: boolean;
    status: string;
    stage: NativeConversationStage;
    stageUpdatedAt: string;
    archived: boolean;
    transportKind: string;
    providerState: string;
    providerModel: string | null;
    providerSettings: NativeProviderSettingsSnapshot | null;
    nextTurnSettings: NativeNextTurnSettings | null;
    agentKind: string | null;
    createdAt: string;
    updatedAt: string;
  };
  openSegment: {
    id: string;
    runtimeKind: string;
    state: string;
    nativeSessionId: string | null;
    providerModel: string | null;
    openedAt: string;
    acceptedAt: string | null;
    updatedAt: string;
  } | null;
  activeTurn: NativeConversationSnapshotV2Turn | null;
  recentClosedTurns: NativeConversationSnapshotV2Turn[];
  sessionMetrics: NativeSessionMetricsSnapshot | null;
  collections: {
    timeline: { throughSequence: number };
    modelHistory: { throughSequence: number };
    process: { throughSequence: number };
    resources: { available: boolean; assistantDeliverablesAvailable?: boolean };
  };
  limits: { closedTurnLimit: number; byteLimit: number; returnedTurnCount: number; responseBytes: number };
}

export interface NativeConversationSnapshotV2Page<T> {
  schemaVersion: 2;
  structureGeneration: '2026-08-29-conversation-snapshot-v2-recovered-request-input';
  conversationId: string;
  kind: 'timeline' | 'model_history' | 'process' | 'commands' | 'resources' | 'change_files';
  throughEventSeq: number;
  throughSequence: number;
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
  limits: { entryLimit: number; byteLimit: number; returnedItems: number; responseBytes: number };
}

export interface NativeConversationModelHistoryV2Item {
  id: string;
  sequence: number;
  turnId: string;
  submissionId: string | null;
  clientUserMessageId: string | null;
  providerItemId: string | null;
  reasoningSummary: boolean;
  phase: string | null;
  formalPlan?: boolean;
  segmentId: string;
  role: string;
  toolPairId: string | null;
  confirmedAt: string;
  content: NativeBoundedContentProjection;
  toolResult: {
    handle: string;
    sha256: string;
    byteLength: number;
    mimeType: string;
    projection: string;
    projectionTruncated: boolean;
    redacted: boolean;
  } | null;
}

export interface NativeConversationProcessV2Item {
  id: string;
  sequence: number;
  turnId: string;
  segmentId: string;
  providerItemId: string | null;
  kind: 'reasoning' | 'tool' | 'command' | 'retry' | 'context_compaction' | 'waiting' | 'warning';
  status: string;
  title: string;
  sourceEventId: string | null;
  startedAt: string;
  completedAt: string | null;
  presentation: Record<string, unknown> | null;
  detail: NativeBoundedContentProjection;
  toolResult: NativeConversationModelHistoryV2Item['toolResult'];
}

export interface NativeConversationResourceV2Item {
  id: string;
  turnId: string;
  itemId: string;
  sourceIndex: number;
  kind: string;
  presentation: string;
  displayName: string;
  mimeType: string | null;
  previewKind: string | null;
  iconKind: string | null;
  attachmentRef?: string | null;
  taskPushAttachmentKey?: string | null;
  origin?: string | null;
  /** 旧 Snapshot V2 缓存可能没有该字段；缺失必须按普通过程资源处理。 */
  delivery?: 'assistant' | null;
  createdAt: string;
  updatedAt: string;
  accessPolicy: 'authorized_open_intent_or_preview';
}

export interface NativeConversationChangeSetV2Summary {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  providerTurnId: string;
  state: string;
  preImageDigest: string | null;
  postImageDigest: string | null;
  hasConflict: boolean;
  unavailableReason: string | null;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  addedLines: number;
  deletedLines: number;
  diffBytes: number;
}

export interface NativeConversationChangeFileV2Item {
  id: string;
  changeSetId: string;
  sourceItemId: string | null;
  sourceIndex: number;
  oldPath: string | null;
  newPath: string | null;
  changeType: string;
  addedLines: number;
  deletedLines: number;
  preHash: string | null;
  postHash: string | null;
  preExists: boolean;
  postExists: boolean;
  reversible: boolean;
  unavailableReason: string | null;
  diffBytes: number;
  diffHandle: string | null;
  detailState: 'available' | 'transitioning';
  createdAt: string;
  updatedAt: string;
}

export interface NativeConversationContentV2Page {
  schemaVersion: 2;
  structureGeneration: '2026-08-29-conversation-snapshot-v2-recovered-request-input';
  conversationId: string;
  kind: 'timeline_payload' | 'model_content' | 'process_detail' | 'change_file_diff';
  mimeType: string;
  text: string;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
  totalBytes: number;
  contentByteLimit: number;
  redacted: boolean;
}

export interface NativeConversationToolResultPage {
  text: string;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
  sha256: string;
}

export interface NativeConversationV2PagingState {
  history: {
    nextCursor: string | null;
    hasMore: boolean;
    loading: boolean;
    error: string | null;
    /** 当前连续显示缓存拥有的模型历史最高序列；null 表示旧缓存无法证明范围。 */
    loadedThroughSequence: number | null;
    /** 当前连续显示缓存拥有的模型历史最低序列；空历史为 null。 */
    oldestLoadedSequence: number | null;
  };
  /** 旧 Renderer 快照在升级后的首次导航中可能尚未携带该字段。 */
  historyByTurn?: Record<string, { nextCursor: string | null; hasMore: boolean; loading: boolean; loaded: boolean; error: string | null }>;
  processByTurn: Record<string, { nextCursor: string | null; hasMore: boolean; loading: boolean; loaded: boolean; error: string | null }>;
  resources: { nextCursor: string | null; hasMore: boolean; loading: boolean; loaded: boolean; error: string | null; items: NativeConversationResourceV2Item[] };
  changeSetsByTurn: Record<
    string,
    {
      loading: boolean;
      loaded: boolean;
      error: string | null;
      summary: NativeConversationChangeSetV2Summary | null;
      files: NativeConversationChangeFileV2Item[];
      nextCursor: string | null;
      hasMore: boolean;
    }
  >;
}

export interface NativeConversationMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  providerItemId?: string | null;
  resources?: ConversationResource[];
  createdAt: string;
}

export interface NativeConversationChoice {
  id: string;
  /** Renderer 的稳定导航身份；真实会话接管本地首发工作面时保持不变。 */
  navigationId?: string;
  /** 只表示本地首发工作面，禁止用该身份调用真实会话接口。 */
  taskPushCreating?: boolean;
  projectId: string;
  taskId: string | null;
  workspaceId?: string | null;
  environmentId?: string | null;
  workspace?: TaskWorkspaceRecord | null;
  title: string;
  summary: string | null;
  status: string;
  stage: NativeConversationStage;
  stageUpdatedAt: string;
  transportKind: string;
  providerId: string | null;
  providerThreadId: string | null;
  providerModel: string | null;
  providerState: string | null;
  legacySourceConversationId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** 最近一次真实会话活动；不包含打开、水合、统计刷新等维护写入。 */
  activityAt?: string;
  archived: boolean;
  hasUnreadAttention: boolean;
  attentionKind: NativeConversationAttentionKind;
  attentionRevision: number;
  attentionTurnId: string | null;
  attentionUpdatedAt: string | null;
  pendingRequestKind: 'approval' | 'user_input' | null;
  /** 服务端基于队列、轮次和请求元数据计算的列表状态，避免列表刷新读取完整会话。 */
  listRuntimeState?: 'connecting' | 'reconnecting' | 'paused' | 'queued' | 'ready' | 'streaming' | 'pending_approval' | 'pending_user_input' | 'error' | 'legacy_readonly';
  /** 与列表状态同源的任务运行状态，避免客户端从不完整元数据重复猜测。 */
  taskRunStatus?: 'not_started' | 'connecting' | 'reconnecting' | 'running' | 'waiting_user' | 'waiting_approval' | 'paused' | 'idle' | 'failed' | 'legacy_readonly';
  resumable: boolean;
  readOnly: boolean;
  /** v2 工作项会话只能下钻查看；回复、授权和验收统一返回任务管理驾驶舱。 */
  managedByTaskWorkItem?: boolean;
  permissionMode?: NativePermissionMode;
  collaborationMode?: NativeCollaborationMode;
  agent?: NativeAgentIdentity;
  model?: NativeModelIdentity;
  nativeSession?: NativeSessionIdentity;
}

export interface NativeAgentIdentity {
  kind: 'codex' | 'pi' | 'claude' | null;
  transport: 'app_server' | 'rpc' | 'sdk' | null;
  supportStatus: 'unavailable' | 'framework_only' | 'experimental' | 'verified';
  capabilitySnapshotId: string | null;
}

export interface NativeModelIdentity {
  sourceId: string | null;
  id: string | null;
}

export interface NativeSessionIdentity {
  id: string | null;
  path: string | null;
}

export interface AgentCatalogItem {
  kind: 'codex' | 'pi' | 'claude';
  displayName: string;
  transport: 'app_server' | 'rpc' | 'sdk';
  supportStatus: 'unavailable' | 'framework_only' | 'experimental' | 'verified';
  visibleToUsers: boolean;
  capabilities: Record<
    string,
    {
      state: 'supported' | 'unsupported' | 'unverified';
      checkedAt: string | null;
      adapterVersion: string | null;
      binaryVersion: string | null;
      reason: string;
    }
  >;
}

export interface AgentCatalogSnapshot {
  items: AgentCatalogItem[];
}

export interface NativeConversationChoicesSnapshot {
  taskId: string;
  projectId: string;
  hasHistory: boolean;
  requiresChoice: boolean;
  choices: NativeConversationChoice[];
  items: NativeConversationChoice[];
}

export interface NativeProjectConversationChoicesSnapshot {
  projectId: string;
  choices: NativeConversationChoice[];
  items: NativeConversationChoice[];
}

export interface ArchivedConversationChoicesSnapshot {
  choices: NativeConversationChoice[];
  items: NativeConversationChoice[];
}

export interface CodexTaskPushModelCapability {
  id: string;
  model: string;
  displayName?: string;
  agentKind?: 'codex' | 'pi';
  sourceId?: string;
  sourceName?: string;
  available?: boolean;
  supports1MContext?: boolean;
  availabilityReason?: string;
  speedLabel?: 'standard' | 'high_speed' | 'flash' | 'turbo';
  tools?: 'supported' | 'unsupported' | 'unverified';
  imageInput?: 'supported' | 'unsupported' | 'unverified';
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string | null;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier?: string | null;
}

export type NativeServiceTierSelection = { type: 'follow' } | { type: 'standard' } | { type: 'catalog'; id: string };

export interface ProjectRepositoryRecord {
  id: string;
  projectId: string;
  name: string;
  relativePath: string;
  localPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSharedPathRecord {
  id: string;
  projectId: string;
  relativePath: string;
  localPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexTaskRepositoryCapability extends ProjectRepositoryRecord {
  branch: string;
  headSha: string;
  clean: boolean;
  defaultRemoteName: string;
  remoteRefreshStatus: 'not_requested' | 'succeeded' | 'failed';
  remoteRefreshError: string | null;
  sourceRefs: Array<{ ref: string; label: string; kind: 'local' | 'remote'; group: string; current: boolean }>;
  suggestedBranchName: string;
}

export interface CodexAccountSnapshot {
  generationId: string;
  requiresOpenaiAuth: boolean;
  signedIn: boolean;
  accountType: string | null;
  planType: string | null;
}

export interface CodexChatGptLogin {
  generationId: string;
  loginId: string;
  authUrl: string;
}

export interface CodexTaskPushCapabilities {
  generationId: string;
  initializedAt: string;
  projectId: string;
  taskId: string;
  canonicalPrompt: string;
  taskContextRevision: string;
  parentContextRevision: string;
  repositoryRevision: string;
  currentAttachmentOptions: TaskPushParentContextOption['attachments'];
  currentConversationOptions: TaskPushParentContextOption['conversations'];
  parentContextOptions: TaskPushParentContextOption[];
  relatedContextOptions: TaskPushRelatedContextOption[];
  preferredModel: string;
  models: CodexTaskPushModelCapability[];
  codexAccount: CodexAccountSnapshot;
  repositories: CodexTaskRepositoryCapability[];
  directWorkspace: {
    path: string;
    activeWritableConversationCount: number;
  };
  existingEnvironments?: Array<{
    id: string;
    available: boolean;
    unavailableReason: 'active_conversation' | 'closed_workspace' | null;
    repositories: Array<{
      repositoryId: string | null;
      repositoryName: string;
      repositoryRelativePath: string;
      branchName: string;
      sourceBranch: string;
    }>;
    createdAt: string;
    updatedAt: string;
  }>;
  sharedWritablePaths: ProjectSharedPathRecord[];
  git: {
    primaryWorkspacePath: string;
    primaryBranch: string;
    primaryHeadSha: string;
    primaryClean: boolean;
    defaultRemoteName: string;
    sourceRefs: Array<{ ref: string; label: string; kind: 'local' | 'remote'; group: string; current: boolean }>;
    suggestedBranchName: string;
    worktreeRoot: string;
  };
}

export interface TaskWorkspaceRecord {
  id: string;
  projectId: string;
  taskId: string;
  kind: 'task' | 'conflict';
  baseWorkspaceId: string | null;
  environmentId: string | null;
  repositoryId: string | null;
  repositoryName: string;
  repositoryRelativePath: string;
  repositoryPath: string;
  branchName: string;
  sourceBranch: string;
  sourceHeadSha: string;
  remoteName: string;
  remoteBranch: string;
  worktreePath: string | null;
  headSha: string | null;
  state: 'ready' | 'reclaimed' | 'merged' | 'discarded' | 'failed';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskGitFileStatus {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
  category: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'other';
}

export interface TaskGitDiffLine {
  type: 'context' | 'addition' | 'deletion' | 'metadata';
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface TaskGitFileDiff {
  oldPath: string;
  newPath: string;
  changeType: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
  addedLines: number;
  deletedLines: number;
  hunks: Array<{ header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: TaskGitDiffLine[] }>;
}

export interface TaskGitDiffSummary {
  isRepository: boolean;
  files: string[];
  diffText: string;
  fileDiffs: TaskGitFileDiff[];
}

export interface TaskBranchFileChange {
  path: string;
  originalPath?: string;
  changeType: TaskGitFileDiff['changeType'];
  additions: number;
  deletions: number;
}

export interface TaskBranchComparison {
  sourceBranch: string;
  taskBranch: string;
  sourceHeadSha: string;
  taskHeadSha: string;
  mergeBaseSha: string;
  ahead: number;
  behind: number;
  files: TaskBranchFileChange[];
}

export interface TaskWorkspaceReview {
  cwd: string;
  branch: string;
  headSha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  conflictFiles: string[];
  stagedFiles: TaskGitFileStatus[];
  unstagedFiles: TaskGitFileStatus[];
  untrackedFiles: TaskGitFileStatus[];
  stagedDiff: TaskGitDiffSummary;
  unstagedDiff: TaskGitDiffSummary;
}

export interface TaskWorkspaceSnapshot extends TaskWorkspaceRecord {
  activeConversationCount: number;
  primaryBranch: string | null;
  localBranches: string[];
  targetBranches: string[];
  review: TaskWorkspaceReview | null;
  branchComparison: TaskBranchComparison | null;
  remoteHeadSha: string | null;
  remoteVerified: boolean;
  sourceLocalHeadSha: string | null;
  sourceRemoteHeadSha: string | null;
  sourceRemoteVerified: boolean;
  remoteRefreshError: string | null;
  reviewError?: string;
  comparisonError?: string;
}

export interface TaskWorkspaceIndexSnapshot extends TaskWorkspaceRecord {
  activeConversationCount: number;
}

export interface TaskWorkspaceIndexCollection {
  taskId: string;
  projectId: string;
  items: TaskWorkspaceIndexSnapshot[];
  workspaces: TaskWorkspaceIndexSnapshot[];
}

export interface TaskWorkspaceSnapshotResponse {
  workspace: TaskWorkspaceSnapshot;
}

export interface TaskWorkspacesSnapshot {
  taskId: string;
  projectId: string;
  primaryBranch: string | null;
  localBranches: string[];
  targetBranches: string[];
  items: TaskWorkspaceSnapshot[];
  workspaces: TaskWorkspaceSnapshot[];
}

export interface TaskWorkspaceCommitResult {
  workspace: TaskWorkspaceRecord;
  result: {
    branch: string;
    headSha: string;
    committed: boolean;
    formattedPaths: string[];
  };
  review: TaskWorkspaceReview;
}

export interface TaskWorkspacePushResult {
  workspace: TaskWorkspaceRecord;
  result: {
    branch: string;
    headSha: string;
    remoteName: string;
    remoteBranch: string;
    remoteHeadSha: string;
  };
  review: TaskWorkspaceReview;
}

export interface BatchTaskWorkspaceResult {
  workspaceId: string;
  repositoryName: string;
  repositoryRelativePath: string;
  status: 'succeeded' | 'skipped' | 'failed';
  message: string;
  headSha?: string;
}

export interface BatchTaskWorkspaceResponse {
  taskId: string;
  items: BatchTaskWorkspaceResult[];
  summary: {
    succeeded: number;
    skipped: number;
    failed: number;
  };
}

export interface TaskIntegrationPushResult {
  integration: TaskIntegrationRecord;
  workspace: TaskWorkspaceRecord;
  result: {
    branch: string;
    headSha: string;
    remoteName: string;
    remoteBranch: string;
    remoteHeadSha: string;
  };
}

export interface TaskIntegrationRecord {
  id: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  targetBranch: string;
  targetHeadSha: string;
  taskHeadSha: string | null;
  mode: 'merge' | 'squash';
  integrationPath: string | null;
  resultHeadSha: string | null;
  state: 'preparing' | 'conflicted' | 'pending_local_sync' | 'merged' | 'failed';
  localSyncStatus: 'synced' | 'pending' | null;
  localHeadSha: string | null;
  localWorktreePath: string | null;
  conflictFiles: string[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskIntegrationResult {
  targetBranch: string;
  targetHeadSha: string;
  resultHeadSha: string;
  remoteName: string;
  remoteHeadSha: string | null;
  localSyncStatus: 'synced' | 'pending';
  localHeadSha: string;
  localWorktreePath: string | null;
}

export interface TaskIntegrationConflictFile {
  path: string;
  fingerprint: string;
  base: string;
  source: string;
  task: string;
  result: string;
}

export interface TaskIntegrationConflictAiSession {
  path: string;
  agentKind: 'codex' | 'pi';
  modelSourceId: string | null;
  modelId: string;
  conversationId: string;
  status: string;
}

export type TaskIntegrationConflictPermissionMode = Exclude<NativePermissionMode, 'read-only'>;

export interface CodexConversationCapabilities {
  generationId: string;
  initializedAt: string;
  projectId: string;
  preferredModel: string;
  models: CodexTaskPushModelCapability[];
  codexAccount: CodexAccountSnapshot;
  /** 长任务执行宿主可能来自升级前版本，旧能力响应没有目标字段。 */
  goals?: {
    supported: boolean;
    enabled: boolean;
    stage: 'beta' | 'underDevelopment' | 'stable' | 'deprecated' | 'removed' | null;
  };
}

export interface NativeTurnSettingsSelection {
  model: string;
  agentKind?: 'codex' | 'pi';
  effort?: string;
  serviceTier?: string | null;
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  pluginReferences?: PluginSkillReference[];
}

export interface PluginSkillReference {
  kind: 'plugin' | 'skill';
  id: string;
}

export interface StartTaskModelPushRequest {
  agentKind?: 'codex' | 'pi' | 'claude';
  mode: 'create';
  source: 'task_push';
  stageId?: string;
  model: string;
  effort?: string;
  serviceTier?: string | null;
  workMode: 'default' | 'plan';
  permissionMode: NativePermissionMode;
  skillId?: string;
  workspace:
    | { mode: 'direct'; confirmConcurrentWrites: boolean }
    | { mode: 'existing'; environmentId: string }
    | {
        mode: 'create';
        repositoryRevision: string;
        repositories: Array<{
          repositoryId: string;
          sourceRef: string;
          branchName: string;
          includeLocalChanges?: boolean;
        }>;
      };
  supplementalInfo?: string;
  supplementalAttachments?: TaskPushSupplementalAttachmentInput[];
  taskContext?: {
    revision: string;
    currentConversationIds: string[];
    parentSelections: TaskPushParentContextSelection[];
    relatedSelections: TaskPushRelatedContextSelection[];
  };
  idempotencyKey: string;
  clientUserMessageId: string;
}

export type StartNativeConversationRequest =
  | {
      mode: 'create';
      source?: 'code_review';
      stageId?: string;
      content?: string;
      skillId?: string;
      attachments?: NativeConversationAttachment[];
      inheritConversationId?: string;
      permissionMode: NativePermissionMode;
      collaborationMode: NativeCollaborationMode;
      serviceTier?: string | null;
      model?: string;
      effort?: string;
      idempotencyKey: string;
      clientUserMessageId: string;
      agentKind?: 'codex' | 'pi' | 'claude';
      goalObjective?: string;
      pluginReferences?: PluginSkillReference[];
    }
  | {
      mode: 'resume';
      conversationId: string;
      content: string;
      collaborationMode: NativeCollaborationMode;
      idempotencyKey: string;
      clientUserMessageId: string;
      agentKind?: 'codex' | 'pi' | 'claude';
    }
  | {
      mode: 'reference_legacy';
      sourceConversationId: string;
      messageIds: string[];
      content: string;
      permissionMode: NativePermissionMode;
      collaborationMode: NativeCollaborationMode;
      idempotencyKey: string;
      clientUserMessageId: string;
      agentKind?: 'codex' | 'pi' | 'claude';
    };

export interface StartProjectConversationRequest {
  agentKind?: 'codex' | 'pi' | 'claude';
  mode: 'create';
  content: string;
  attachments: NativeConversationAttachment[];
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  serviceTier?: string | null;
  model?: string;
  effort?: string;
  idempotencyKey: string;
  clientUserMessageId: string;
  goalObjective?: string;
  pluginReferences?: PluginSkillReference[];
}

export interface SendNativeMessageRequest {
  agentKind?: 'codex' | 'pi' | 'claude';
  content: string;
  displayText?: string;
  composerDraft?: string;
  attachments: NativeConversationAttachment[];
  browserComments?: ZeusBrowserComment[];
  browserCommentContent?: string;
  conversationContext?: ConversationContextDraft;
  delivery: 'queue' | 'steer_now';
  expectedTurnId?: string;
  model?: string;
  effort?: string;
  serviceTier?: string | null;
  permissionMode?: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  pluginReferences?: PluginSkillReference[];
  idempotencyKey: string;
  clientUserMessageId: string;
}

export interface NativeOperationAcceptance {
  operation: Record<string, unknown> & { status: string };
  conversation: Record<string, unknown> & { id: string };
  submission?: Record<string, unknown> & { id: string };
}

export interface NativePlanImplementationResponseAcceptance {
  operation: NativeOperationAcceptance['operation'];
  request: NativePlanImplementationRequest;
  queue: NativeQueueSnapshot;
  acknowledged: true;
}

/** Graph Command 会把本地重连 id 派生为外部 operation identity；两者必须同时保留并分别校验。 */
export interface NativeConversationStartDispatchResult {
  acceptance: NativeOperationAcceptance;
  operationIdentity: string;
}

export interface NativeRealtimeEventEnvelope {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface NativeConversationEventPage {
  conversationId: string;
  conversationSchemaGeneration: '2026-08-16-unified-conversation-segments';
  syncStreamGeneration: 'zeus-conversation-sync-v2';
  baseSequence: number | null;
  throughEventSeq: number;
  nextCursor: number;
  hasMore: boolean;
  requestedBeforeBaseline: boolean;
  events: NativeRealtimeEventEnvelope[];
}

interface NativeEventIdentity extends Record<string, unknown> {
  projectId: string;
  conversationId: string;
  threadId?: string;
  generationId: string;
  conversationSchemaGeneration: '2026-08-16-unified-conversation-segments';
  syncStreamGeneration: 'zeus-conversation-sync-v2';
  entityRevision: number | string;
  sequence: number;
}

interface NativeEvent<Type extends string, Payload extends NativeEventIdentity> {
  id: string;
  type: Type;
  payload: Payload;
  createdAt: string;
}

export type NativeConversationAttentionKind = 'none' | 'unread' | 'completed' | 'failed' | 'interrupted';

type NativeTurnEventPayload = NativeEventIdentity & {
  turnId: string;
  status?: string;
  severity?: 'warning' | 'error';
  submissionId?: string;
  startedAt?: string;
  completedAt?: string;
  hasUnreadAttention?: boolean;
};
type NativeItemEventPayload = NativeEventIdentity & {
  turnId: string;
  itemId: string;
  itemType: string;
  itemPayload: Record<string, unknown>;
  status?: string;
  phase?: string;
  textContent?: string;
  itemResources?: ConversationResource[];
};

export type NativeConversationEvent =
  | NativeEvent<'conversation.transport.changed', NativeEventIdentity & { transportKind?: string; providerState?: string; providerThreadId?: string }>
  | NativeEvent<'conversation.thread.changed', NativeEventIdentity & { providerThreadId?: string; providerState?: string }>
  | NativeEvent<'conversation.turn.started', NativeTurnEventPayload>
  | NativeEvent<'conversation.turn.completed', NativeTurnEventPayload>
  | NativeEvent<'conversation.turn.plan.updated', NativeTurnEventPayload & { plan: NativeTurnPlanSnapshot }>
  | NativeEvent<'conversation.turn.change_set.changed', NativeTurnEventPayload & { changeSetId: string; changeSet: TurnChangeSet }>
  | NativeEvent<'conversation.item.started', NativeItemEventPayload>
  | NativeEvent<'conversation.item.delta', NativeItemEventPayload & { textContent: string }>
  | NativeEvent<'conversation.item.completed', NativeItemEventPayload & { textContent: string }>
  | NativeEvent<'conversation.settings.changed', NativeEventIdentity & { model: string; effort?: string }>
  | NativeEvent<'conversation.tokenUsage.changed', NativeEventIdentity & SharedNativeTokenUsageSnapshot>
  | NativeEvent<'conversation.sessionMetrics.changed', NativeEventIdentity & { sessionMetrics: NativeSessionMetricsSnapshot }>
  | NativeEvent<'conversation.rateLimits.changed', NativeEventIdentity & { value: Record<string, unknown> }>
  | NativeEvent<'conversation.mcpStartup.changed', NativeEventIdentity & { value: Record<string, unknown> }>
  | NativeEvent<'conversation.queue.changed', NativeEventIdentity & { queue: NativeQueueSnapshot }>
  | NativeEvent<'conversation.submission.steering', NativeEventIdentity & { submission: NativeQueuedSubmission; queue: NativeQueueSnapshot }>
  | NativeEvent<
      'conversation.request.created',
      NativeEventIdentity & {
        turnId?: string;
        requestId: string;
        requestKind: string;
        request?: NativePendingRequest;
      }
    >
  | NativeEvent<
      'conversation.request.changed',
      NativeEventIdentity & {
        turnId?: string;
        requestId: string;
        requestKind: string;
        request: NativePendingRequest;
      }
    >
  | NativeEvent<
      'conversation.request.resolved',
      NativeEventIdentity & {
        turnId?: string;
        requestId: string;
        requestKind?: string;
        resolvedBy?: string;
        answerAvailability?: 'complete' | 'unavailable' | 'not_applicable';
        request?: NativePendingRequest;
      }
    >
  | NativeEvent<'conversation.request.snoozed', NativeEventIdentity & { requestId: string }>
  | NativeEvent<
      'conversation.plan_implementation_request.changed',
      NativeEventIdentity & {
        requestId: string;
        turnId?: string;
        planItemId?: string;
        status: NativePlanImplementationRequest['status'];
        submissionId?: string;
        collaborationMode?: NativeCollaborationMode;
      }
    >
  | NativeEvent<
      'conversation.collaboration_mode.changed',
      NativeEventIdentity & {
        collaborationMode: NativeCollaborationMode;
      }
    >
  | NativeEvent<'conversation.goal.updated', NativeEventIdentity & { goal: NativeGoalSnapshot; timeline?: NativeGoalTimelineEvent[]; eventKind?: string | null; notificationEligible?: boolean }>
  | NativeEvent<'conversation.goal.cleared', NativeEventIdentity & { cleared: boolean; timeline?: NativeGoalTimelineEvent[] }>
  | NativeEvent<
      'conversation.plugin_app.created',
      NativeEventIdentity & {
        providerTurnId?: string;
        callId: string;
        pluginId: string;
        pluginRevisionId: string;
        serverId: string;
        toolName: string;
        app: Record<string, unknown>;
        toolResult?: { text: string; structuredContent?: unknown; isError: boolean };
      }
    >
  | NativeEvent<'conversation.native.error', NativeEventIdentity & { turnId?: string; error?: string | Record<string, unknown>; message?: string; recoveryRequired?: boolean; retryable?: boolean }>;

export const nativeConversationEventTypes = new Set<NativeConversationEvent['type']>([
  'conversation.transport.changed',
  'conversation.thread.changed',
  'conversation.turn.started',
  'conversation.turn.completed',
  'conversation.turn.plan.updated',
  'conversation.turn.change_set.changed',
  'conversation.item.started',
  'conversation.item.delta',
  'conversation.item.completed',
  'conversation.settings.changed',
  'conversation.tokenUsage.changed',
  'conversation.sessionMetrics.changed',
  'conversation.rateLimits.changed',
  'conversation.mcpStartup.changed',
  'conversation.queue.changed',
  'conversation.submission.steering',
  'conversation.request.created',
  'conversation.request.changed',
  'conversation.request.resolved',
  'conversation.request.snoozed',
  'conversation.plan_implementation_request.changed',
  'conversation.collaboration_mode.changed',
  'conversation.goal.updated',
  'conversation.goal.cleared',
  'conversation.plugin_app.created',
  'conversation.native.error',
]);

export function isNativeConversationEvent(event: NativeRealtimeEventEnvelope): event is NativeConversationEvent {
  return nativeConversationEventTypes.has(event.type as NativeConversationEvent['type']);
}

export interface NativeSessionItemBuffer {
  key: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  providerItemId?: string;
  localItemId?: string;
  type: string;
  status: string;
  phase: string;
  text: string;
  payload: Record<string, unknown>;
  resources: ConversationResource[];
  optimistic?: boolean;
  clientUserMessageId?: string;
  durableClientUserMessageId?: string;
  /** 条目首次进入会话顺序的稳定时间，后续流式更新不得覆盖。 */
  timelineAt?: string;
  updatedAt?: string;
}

/** 明确交付给用户的资源必须脱离工具过程折叠，刷新后也保持在会话正文中。 */
export function isAssistantDeliverableItem(item: Pick<NativeSessionItemBuffer, 'resources'>): boolean {
  return item.resources.some((resource) => resource.delivery === 'assistant');
}

export interface NativeSessionError {
  message: string;
  code: string | null;
  recoveryRequired: boolean;
  retryable: boolean;
  status?: number;
}

export interface NativeSessionState {
  transportState: TransportState;
  reconnectAttempt: number;
  conversationState: ConversationState;
  projectId: string | null;
  conversationId: string | null;
  providerThreadId: string | null;
  activeTurnId: string | null;
  startedTurnId: string | null;
  snapshot: NativeConversationSnapshot | null;
  turnsByProviderId: Record<string, NativeTurnSnapshot>;
  changeSetsByProviderId: Record<string, TurnChangeSet>;
  terminalTurnIds: Record<string, 'completed' | 'interrupted' | 'failed'>;
  items: Record<string, NativeSessionItemBuffer>;
  itemOrder: string[];
  queue: NativeQueueSnapshot | null;
  pendingRequests: NativePendingRequest[];
  planImplementationRequests: NativePlanImplementationRequest[];
  providerSettings: NativeProviderSettingsSnapshot | null;
  tokenUsage: NativeTokenUsageSnapshot | null;
  unifiedUsage: NativeUnifiedUsageSnapshot | null;
  sessionMetrics: NativeSessionMetricsSnapshot | null;
  rateLimits: NativeProviderValueSnapshot | null;
  mcpStartup: NativeProviderValueSnapshot | null;
  seenEventIds: Record<string, true>;
  lastSequenceByGeneration: Record<string, number>;
  lastEventId: string | null;
  draft: string;
  attachments: NativeConversationAttachment[];
  browserSubmission: ZeusBrowserPreparedSubmission | null;
  contextDraft: ConversationContextDraft;
  transcriptRevision: number;
  feedbackEpoch: number;
  visibleFeedbackEpoch: number;
  busyOperation: string | null;
  error: NativeSessionError | null;
}
