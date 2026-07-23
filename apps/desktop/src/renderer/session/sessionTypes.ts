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
}

export type NativeConversationAttachment = NativeConversationAttachmentBase & ({ localPath: string; uploadRef?: never } | { localPath?: never; uploadRef: string });

export interface NativeTurnSnapshot {
  id: string;
  providerTurnId: string | null;
  submissionId: string | null;
  status: string;
    plan?: NativeTurnPlanSnapshot | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface NativeQueuedSubmission {
  id: string;
  conversationId?: string;
  content: string;
  status: string;
  delivery?: 'queue' | 'steer_now';
  attachments?: NativeConversationAttachment[];
  expectedTurnId?: string | null;
  clientUserMessageId?: string;
  position: number;
  providerTurnId?: string | null;
  pausedReason: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type NativeConversationRunState =
  | { type: 'idle' }
  | { type: 'dispatching'; submissionId: string }
  | { type: 'active'; turnId: string; phase: 'prework' | 'final_answer' }
  | { type: 'waiting'; turnId: string; requestId: string; reason: 'approval' | 'user_input' }
    | { type: 'paused'; reason: 'interrupted' | 'transport_unavailable' | 'provider_archived' | 'recovery_required' };

export interface NativeQueueSnapshot {
  state: NativeConversationRunState;
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

export interface NativeProviderSettingsSnapshot {
  generationId?: string;
  sequence?: number;
  model: string;
  effort?: string;
}

export interface NativeTokenUsageSnapshot {
  generationId?: string;
  sequence?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface NativeProviderValueSnapshot {
  generationId?: string;
  sequence?: number;
  value: Record<string, unknown>;
}

export interface NativeConversationSnapshot {
  id: string;
  projectId: string;
  taskId: string | null;
  sessionId: string | null;
  title: string;
  summary: string | null;
  status: string;
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
  createdAt: string;
  updatedAt: string;
  archived: boolean;
    hasUnreadCompletion: boolean;
    pendingRequestKind: 'approval' | 'user_input' | null;
  messages: NativeConversationMessage[];
  turns: NativeTurnSnapshot[];
  items: NativeItemSnapshot[];
  submissions: NativeQueuedSubmission[];
  queue: NativeQueueSnapshot;
  requests: NativePendingRequest[];
    planImplementationRequests: NativePlanImplementationRequest[];
  providerSettings?: NativeProviderSettingsSnapshot;
  tokenUsage?: NativeTokenUsageSnapshot;
  rateLimits?: NativeProviderValueSnapshot;
  mcpStartup?: NativeProviderValueSnapshot;
  permissionMode?: NativePermissionMode;
    collaborationMode?: NativeCollaborationMode;
}

export interface NativeConversationMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface NativeConversationChoice {
  id: string;
  projectId: string;
  taskId: string | null;
  title: string;
  summary: string | null;
  status: string;
  transportKind: string;
  providerId: string | null;
  providerThreadId: string | null;
  providerModel: string | null;
  providerState: string | null;
  legacySourceConversationId?: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
    hasUnreadCompletion: boolean;
    pendingRequestKind: 'approval' | 'user_input' | null;
  resumable: boolean;
  readOnly: boolean;
  permissionMode?: NativePermissionMode;
    collaborationMode?: NativeCollaborationMode;
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

export interface CodexTaskPushModelCapability {
  id: string;
  model: string;
  displayName?: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
}

export interface CodexTaskPushCapabilities {
    generationId: string;
    initializedAt: string;
    projectId: string;
    taskId: string;
    canonicalPrompt: string;
    preferredModel: string;
    models: CodexTaskPushModelCapability[];
}

export interface CodexConversationCapabilities {
  generationId: string;
  initializedAt: string;
  projectId: string;
  preferredModel: string;
  models: CodexTaskPushModelCapability[];
}

export interface NativeTurnSettingsSelection {
    model: string;
    effort?: string;
    collaborationMode: NativeCollaborationMode;
}

export interface StartTaskModelPushRequest {
  mode: 'create';
  source: 'task_push';
  model: string;
  effort?: string;
  workMode: 'default' | 'plan';
  permissionMode: NativePermissionMode;
  supplementalInfo?: string;
  idempotencyKey: string;
  clientUserMessageId: string;
}

export type StartNativeConversationRequest =
    | {
    mode: 'create';
    content?: string;
    attachments?: NativeConversationAttachment[];
    permissionMode: NativePermissionMode;
    collaborationMode: NativeCollaborationMode;
    idempotencyKey: string;
    clientUserMessageId: string
}
    | {
    mode: 'resume';
    conversationId: string;
    content: string;
    collaborationMode: NativeCollaborationMode;
    idempotencyKey: string;
    clientUserMessageId: string
}
    | {
    mode: 'reference_legacy';
    sourceConversationId: string;
    messageIds: string[];
    content: string;
    permissionMode: NativePermissionMode;
    collaborationMode: NativeCollaborationMode;
    idempotencyKey: string;
    clientUserMessageId: string
};

export interface StartProjectConversationRequest {
  mode: 'create';
  content: string;
  attachments: NativeConversationAttachment[];
  permissionMode: NativePermissionMode;
    collaborationMode: NativeCollaborationMode;
  idempotencyKey: string;
  clientUserMessageId: string;
}

export interface SendNativeMessageRequest {
  content: string;
  attachments: NativeConversationAttachment[];
  delivery: 'queue' | 'steer_now';
  expectedTurnId?: string;
    model?: string;
    effort?: string;
    collaborationMode: NativeCollaborationMode;
  idempotencyKey: string;
  clientUserMessageId: string;
}

export interface NativeOperationAcceptance {
  operation: Record<string, unknown> & { status: string };
  conversation: Record<string, unknown> & { id: string };
  submission?: Record<string, unknown> & { id: string };
}

export interface NativeRealtimeEventEnvelope {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface NativeEventIdentity extends Record<string, unknown> {
  projectId: string;
  conversationId: string;
  threadId?: string;
  generationId: string;
  sequence: number;
}

interface NativeEvent<Type extends string, Payload extends NativeEventIdentity> {
  id: string;
  type: Type;
  payload: Payload;
  createdAt: string;
}

type NativeTurnEventPayload = NativeEventIdentity & {
    turnId: string;
    status?: string;
    submissionId?: string;
    hasUnreadCompletion?: boolean
};
type NativeItemEventPayload = NativeEventIdentity & {
  turnId: string;
  itemId: string;
  itemType: string;
  itemPayload: Record<string, unknown>;
  status?: string;
  phase?: string;
  textContent?: string;
};

export type NativeConversationEvent =
  | NativeEvent<'conversation.transport.changed', NativeEventIdentity & { transportKind?: string; providerState?: string; providerThreadId?: string }>
  | NativeEvent<'conversation.thread.changed', NativeEventIdentity & { providerThreadId?: string; providerState?: string }>
  | NativeEvent<'conversation.turn.started', NativeTurnEventPayload>
  | NativeEvent<'conversation.turn.completed', NativeTurnEventPayload>
    | NativeEvent<'conversation.turn.plan.updated', NativeTurnEventPayload & { plan: NativeTurnPlanSnapshot }>
  | NativeEvent<'conversation.item.started', NativeItemEventPayload>
  | NativeEvent<'conversation.item.delta', NativeItemEventPayload & { textContent: string }>
  | NativeEvent<'conversation.item.completed', NativeItemEventPayload & { textContent: string }>
  | NativeEvent<'conversation.settings.changed', NativeEventIdentity & { model: string; effort?: string }>
  | NativeEvent<'conversation.tokenUsage.changed', NativeEventIdentity & { inputTokens: number; outputTokens: number; totalTokens: number }>
  | NativeEvent<'conversation.rateLimits.changed', NativeEventIdentity & { value: Record<string, unknown> }>
  | NativeEvent<'conversation.mcpStartup.changed', NativeEventIdentity & { value: Record<string, unknown> }>
  | NativeEvent<'conversation.queue.changed', NativeEventIdentity & { queue: NativeQueueSnapshot }>
  | NativeEvent<'conversation.request.created', NativeEventIdentity & { turnId?: string; requestId: string; requestKind: string }>
  | NativeEvent<'conversation.request.resolved', NativeEventIdentity & { turnId?: string; requestId: string; requestKind?: string }>
    | NativeEvent<'conversation.request.snoozed', NativeEventIdentity & { requestId: string }>
    | NativeEvent<
    'conversation.plan_implementation_request.changed',
    NativeEventIdentity & {
    requestId: string;
    turnId?: string;
    planItemId?: string;
    status: NativePlanImplementationRequest['status'];
    submissionId?: string;
    collaborationMode?: NativeCollaborationMode
}
>
    | NativeEvent<'conversation.collaboration_mode.changed', NativeEventIdentity & {
    collaborationMode: NativeCollaborationMode
}>
  | NativeEvent<'conversation.native.error', NativeEventIdentity & { turnId?: string; error?: string | Record<string, unknown>; message?: string; recoveryRequired?: boolean; retryable?: boolean }>;

export const nativeConversationEventTypes = new Set<NativeConversationEvent['type']>([
  'conversation.transport.changed',
  'conversation.thread.changed',
  'conversation.turn.started',
  'conversation.turn.completed',
    'conversation.turn.plan.updated',
  'conversation.item.started',
  'conversation.item.delta',
  'conversation.item.completed',
  'conversation.settings.changed',
  'conversation.tokenUsage.changed',
  'conversation.rateLimits.changed',
  'conversation.mcpStartup.changed',
  'conversation.queue.changed',
  'conversation.request.created',
  'conversation.request.resolved',
    'conversation.request.snoozed',
    'conversation.plan_implementation_request.changed',
    'conversation.collaboration_mode.changed',
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
  localItemId?: string;
  type: string;
  status: string;
  phase: string;
  text: string;
  payload: Record<string, unknown>;
  optimistic?: boolean;
  clientUserMessageId?: string;
  durableClientUserMessageId?: string;
  updatedAt?: string;
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
  terminalTurnIds: Record<string, 'completed' | 'interrupted' | 'failed'>;
  items: Record<string, NativeSessionItemBuffer>;
  itemOrder: string[];
  queue: NativeQueueSnapshot | null;
  pendingRequests: NativePendingRequest[];
    planImplementationRequests: NativePlanImplementationRequest[];
  providerSettings: NativeProviderSettingsSnapshot | null;
  tokenUsage: NativeTokenUsageSnapshot | null;
  rateLimits: NativeProviderValueSnapshot | null;
  mcpStartup: NativeProviderValueSnapshot | null;
  seenEventIds: Record<string, true>;
  lastSequenceByGeneration: Record<string, number>;
  lastEventId: string | null;
  draft: string;
  attachments: NativeConversationAttachment[];
  transcriptRevision: number;
  busyOperation: string | null;
  error: NativeSessionError | null;
}
