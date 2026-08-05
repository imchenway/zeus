import type { ConversationResource, TurnChangeSet, ZeusBrowserComment, ZeusBrowserPreparedSubmission } from '@zeus/shared';

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
  resources?: ConversationResource[];
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
  serviceTier?: string | null;
}

export interface NativeNextTurnSettings {
  model: string;
  effort?: string;
  serviceTier?: string | null;
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
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

export interface NativeConversationExecutionContext {
  cwd: string | null;
  branch: string | null;
  isGitRepository: boolean | null;
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
  agent?: NativeAgentIdentity;
  model?: NativeModelIdentity;
  nativeSession?: NativeSessionIdentity;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  hasUnreadCompletion: boolean;
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
  rateLimits?: NativeProviderValueSnapshot;
  mcpStartup?: NativeProviderValueSnapshot;
  executionContext?: NativeConversationExecutionContext;
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
  resources?: ConversationResource[];
  createdAt: string;
}

export interface NativeConversationChoice {
  id: string;
  projectId: string;
  taskId: string | null;
  workspaceId?: string | null;
  environmentId?: string | null;
  workspace?: TaskWorkspaceRecord | null;
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
  availabilityReason?: string;
  speedLabel?: 'standard' | 'high_speed' | 'flash' | 'turbo';
  tools?: 'supported' | 'unsupported' | 'unverified';
  imageInput?: 'supported' | 'unsupported' | 'unverified';
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
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
  sourceRefs: Array<{ ref: string; label: string; kind: 'local' | 'remote'; current: boolean }>;
  suggestedBranchName: string;
}

export interface CodexTaskPushCapabilities {
  generationId: string;
  initializedAt: string;
  projectId: string;
  taskId: string;
  canonicalPrompt: string;
  preferredModel: string;
  models: CodexTaskPushModelCapability[];
  repositories: CodexTaskRepositoryCapability[];
  repositoryRegistrationRequired: boolean;
  discoveredRepositories: Array<{
    name: string;
    relativePath: string;
    localPath: string;
    branch: string;
    clean: boolean;
  }>;
  sharedWritablePaths: ProjectSharedPathRecord[];
  git: {
    primaryWorkspacePath: string;
    primaryBranch: string;
    primaryHeadSha: string;
    primaryClean: boolean;
    defaultRemoteName: string;
    sourceRefs: Array<{ ref: string; label: string; kind: 'local' | 'remote'; current: boolean }>;
    suggestedBranchName: string;
    worktreeRoot: string;
  };
}

export interface TaskWorkspaceRecord {
  id: string;
  projectId: string;
  taskId: string;
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
  review: TaskWorkspaceReview | null;
  branchComparison: TaskBranchComparison | null;
  remoteHeadSha: string | null;
  remoteVerified: boolean;
  reviewError?: string;
  comparisonError?: string;
}

export interface TaskWorkspacesSnapshot {
  taskId: string;
  projectId: string;
  primaryBranch: string | null;
  localBranches: string[];
  items: TaskWorkspaceSnapshot[];
  workspaces: TaskWorkspaceSnapshot[];
}

export interface TaskWorkspaceCommitResult {
  workspace: TaskWorkspaceRecord;
  result: {
    branch: string;
    headSha: string;
    committed: boolean;
    pushed: boolean;
    remoteName: string;
    remoteBranch: string;
    remoteHeadSha: string | null;
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

export interface TaskIntegrationRecord {
  id: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  targetBranch: string;
  targetHeadSha: string;
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
  base: string;
  source: string;
  task: string;
  result: string;
}

export interface TaskIntegrationConflictAiDraft {
  path: string;
  agentKind: 'codex' | 'pi';
  modelSourceId: string | null;
  modelId: string;
  conversationId: string;
  suggestions: Array<{ index: number; content: string; explanation: string }>;
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
  agentKind?: 'codex' | 'pi';
  effort?: string;
  serviceTier?: string | null;
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
}

export interface StartTaskModelPushRequest {
  agentKind?: 'codex' | 'pi' | 'claude';
  mode: 'create';
  source: 'task_push';
  model: string;
  effort?: string;
  serviceTier?: string | null;
  workMode: 'default' | 'plan';
  permissionMode: NativePermissionMode;
  workspace: { mode: 'create'; repositories: Array<{ repositoryId: string; sourceRef: string; branchName: string }> };
  supplementalInfo?: string;
  idempotencyKey: string;
  clientUserMessageId: string;
}

export type StartNativeConversationRequest =
  | {
      mode: 'create';
      content?: string;
      attachments?: NativeConversationAttachment[];
      inheritConversationId?: string;
      permissionMode: NativePermissionMode;
      collaborationMode: NativeCollaborationMode;
      serviceTier?: string | null;
      idempotencyKey: string;
      clientUserMessageId: string;
      agentKind?: 'codex' | 'pi' | 'claude';
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
  idempotencyKey: string;
  clientUserMessageId: string;
}

export interface SendNativeMessageRequest {
  agentKind?: 'codex' | 'pi' | 'claude';
  content: string;
  displayText?: string;
  attachments: NativeConversationAttachment[];
  browserComments?: ZeusBrowserComment[];
  delivery: 'queue' | 'steer_now';
  expectedTurnId?: string;
  model?: string;
  effort?: string;
  serviceTier?: string | null;
  permissionMode?: NativePermissionMode;
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
  hasUnreadCompletion?: boolean;
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
        collaborationMode?: NativeCollaborationMode;
      }
    >
  | NativeEvent<
      'conversation.collaboration_mode.changed',
      NativeEventIdentity & {
        collaborationMode: NativeCollaborationMode;
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
  resources: ConversationResource[];
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
  changeSetsByProviderId: Record<string, TurnChangeSet>;
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
  browserSubmission: ZeusBrowserPreparedSubmission | null;
  transcriptRevision: number;
  feedbackEpoch: number;
  visibleFeedbackEpoch: number;
  busyOperation: string | null;
  error: NativeSessionError | null;
}
