import { type AiRuntimeSession, createAiRuntimeSessionManager, modelConnectionCredentialSlotId, modelRef, parseModelRef, piRuntimeWorkerProtocolVersion, runWithCodexRpcRetryContext } from '@zeus/ai-runtime';
import { getGitBranchHead, getGitRepositoryContext, type ProjectGitAction } from '@zeus/git-core';
import {
  parseCanonicalRequestUserInputQuestions,
  renderTaskPushLayoutText,
  type TaskPushMessageLayout,
  type TaskPushPromptAttachment,
  type TaskPushPromptParentContext,
  type TaskPushPromptRelatedContext,
  type TaskPushSupplementalAttachment,
} from '@zeus/shared';
import {
  ArtifactStore,
  type ConversationCollaborationMode,
  ConversationExecutionRepository,
  type ConversationPermissionMode,
  ConversationPlanActionRepository,
  ConversationProviderItemRepository,
  ConversationRepository,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  IdempotencyRequestRepository,
  ProjectRepository,
  ProjectRepositoryRegistrationRepository,
  ProjectSharedPathRepository,
  TaskEnvironmentRepository,
  TaskIntegrationAttemptRepository,
  TaskIntegrationRepository,
  TaskRepository,
  TaskStageRepository,
  TaskWorkspaceRepository,
  type ZeusConversationRecord,
  type ZeusConversationWithMessagesRecord,
  type ZeusDatabase,
  type ZeusProjectRecord,
  type ZeusTaskRecord,
  type ZeusTaskStageRecord,
  type ZeusTaskWorkspaceRecord,
} from '@zeus/storage';
import { type FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseJsonObject } from './codeIntelligenceGraphStore.js';
import { createCodexNativeConversationCoordinator } from './codexNativeConversationCoordinator.js';
import { nativePendingRequestProjection } from './codexNativeConversationPolicy.js';
import type { ZeusSkillService } from './zeusSkillService.js';
import { resolveConversationAttachmentGrant } from './conversationAttachmentGrant.js';
import { type ConversationCapabilitiesSnapshot, ConversationCapabilityQueryApplication } from './conversationCapabilityQueryApplication.js';
import { ConversationChoiceQueryApplication } from './conversationChoiceQueryApplication.js';
import { ConversationExecutionCoordinator, type ConversationExecutionRoute } from './conversationExecutionCoordinator.js';
import type { NativeConversationSkillInput } from './codexNativeConversationContracts.js';
import { readNativeConversationSkill } from './nativeConversationSubmissionInputs.js';
import type { CreateConversationMessageBody, NativeConversationAttachment, ProjectConversationAcceptanceReservation, StartProjectConversationBody, StartTaskConversationBody, TaskConversationAcceptanceReservation } from './index.js';
import { createModelConnectionService } from './modelConnectionService.js';
import { resolveWritableNonCodexLegacyConversation, type WritableNonCodexLegacyConversationContext } from './nonCodexLegacyRuntime.js';
import { createPiNativeConversationCoordinator } from './piNativeConversationCoordinator.js';
import { type RuntimeSettingsSnapshot } from './runtimeQueryApplication.js';
import { buildTaskConflictAiConversationTitle, buildTaskConflictAiPrompt } from './taskConflictAi.js';

export { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor, type ReadOnlyValidationApplicationIdentity } from './readOnlyValidation.js';

// 拆分期间保留结构化工厂依赖，后续按领域端口继续收窄。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConversationApplicationOperationDependencies = Record<string, any> & {
  aiRuntimeManager: ReturnType<typeof createAiRuntimeSessionManager>;
  artifactStore: ArtifactStore;
  codexNativeCoordinator: ReturnType<typeof createCodexNativeConversationCoordinator>;
  zeusSkillService?: ZeusSkillService;
  conversationChoiceQueries: ConversationChoiceQueryApplication;
  conversationExecution: ConversationExecutionRepository;
  conversationExecutionCoordinator: ConversationExecutionCoordinator;
  conversationPlanActions: ConversationPlanActionRepository;
  conversationProviderItems: ConversationProviderItemRepository;
  conversationRequests: ConversationServerRequestRepository;
  conversationSubmissions: ConversationSubmissionRepository;
  conversationTurns: ConversationTurnRepository;
  conversations: ConversationRepository;
  db: ZeusDatabase;
  idempotencyRequests: IdempotencyRequestRepository;
  modelConnections: ReturnType<typeof createModelConnectionService>;
  piNativeCoordinator: ReturnType<typeof createPiNativeConversationCoordinator>;
  platformMutableState: { runtimeSettings: RuntimeSettingsSnapshot };
  projectRepositories: ProjectRepositoryRegistrationRepository;
  projectSharedPaths: ProjectSharedPathRepository;
  projects: ProjectRepository;
  resolveConversationCapabilities(project: ZeusProjectRecord, options?: { refreshCodexAccount?: boolean; allowPiWhenCodexUnavailable?: boolean }): ReturnType<ConversationCapabilityQueryApplication['buildConversationCapabilities']>;
  resolveTaskPushExecutionCapabilities(project: ZeusProjectRecord): Promise<ConversationCapabilitiesSnapshot>;
  resolveModelCapability<T extends { id: string; model: string }>(models: readonly T[], identity: string | null | undefined): T | null;
  normalizeTaskPushAttachments(task: ZeusTaskRecord, projectLocalPath: string): { attachments: NativeConversationAttachment[]; allowedRoots: string[]; promptAttachments: TaskPushPromptAttachment[] };
  normalizeTaskPushSupplementalAttachments(value: unknown, projectLocalPath: string): { attachments: NativeConversationAttachment[]; allowedRoots: string[]; promptAttachments: TaskPushSupplementalAttachment[] };
  mergeTaskPushAttachmentInputs(...inputs: Array<{ attachments: NativeConversationAttachment[]; allowedRoots: string[] }>): { attachments: NativeConversationAttachment[]; allowedRoots: string[] };
  buildTaskPushLayoutForTask(
    task: ZeusTaskRecord,
    supplementalInfo: string,
    promptAttachments: TaskPushPromptAttachment[],
    currentConversationPaths: string[],
    parentContexts: TaskPushPromptParentContext[],
    relatedContexts: TaskPushPromptRelatedContext[],
    supplementalAttachments: TaskPushSupplementalAttachment[],
  ): TaskPushMessageLayout;
  taskEnvironments: TaskEnvironmentRepository;
  taskIntegrationAttempts: TaskIntegrationAttemptRepository;
  taskIntegrations: TaskIntegrationRepository;
  taskStages: TaskStageRepository;
  taskWorkspaces: TaskWorkspaceRepository;
  tasks: TaskRepository;
};

export interface PreparedConversationQueueReroute {
  conversationId: string;
  originalId: string;
  originalUpdatedAt: string;
  originalInputJson: string;
  nextInput: Record<string, unknown>;
  route: {
    runtimeKind: 'codex' | 'pi';
    connectionId: string | null;
    credentialSlotId: string;
    endpointIdentity: string;
    protocolFamily: string;
    modelId: string;
    effort: string | null;
    serviceTier: string | null;
    permissionMode: ConversationPermissionMode;
    collaborationMode: ConversationCollaborationMode;
    executionRoot: string;
  };
}
export interface NativeTaskConversationStartPlan {
  agentKind: 'codex' | 'pi';
  conversationId: string;
  submissionId: string;
  projectId: string;
  taskId: string;
  taskTitle: string;
  conversationTitle?: string;
  cwd: string;
  prompt: string;
  model: { sourceId: string | null; modelId: string; displayName: string | null };
  effort?: string;
  serviceTier?: string | null;
  serviceTierPresent?: boolean;
  permissionMode: ConversationPermissionMode;
  workMode?: ConversationCollaborationMode;
  environmentId?: string;
  workspaceId?: string;
  executionWorkspaceMode?: 'direct' | 'worktree';
  writableRoots: string[];
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowGitCommit: boolean;
  attachments?: NativeConversationAttachment[];
  allowedAttachmentRoots?: string[];
  taskPushLayout?: TaskPushMessageLayout;
  legacyReference?: { conversationId: string; messageIds: string[] };
  deferInitialDispatch?: boolean;
  holdDispatch?: boolean;
  operationContext?: Record<string, unknown>;
  internalOperation?: boolean;
  idempotencyKey: string;
  clientUserMessageId: string;
  providerWriteLifecycle: { markPrepared(submissionId: string): Promise<void>; markRpcStarted(submissionId: string): void };
  goalObjective?: string;
  skill?: NativeConversationSkillInput;
}

export function nativeApiError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function isNativeApiRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createConversationApplicationOperations(dependencies: ConversationApplicationOperationDependencies) {
  const {
    aiRuntimeManager,
    appendAuditLog,
    artifactStore,
    assertCodexAccountReady,
    buildTaskPushLayoutForTask,
    codexAppServerManager,
    codexExternalAgentHome,
    codexNativeCoordinator,
    zeusSkillService,
    codexNativeEnabled,
    conversationChoiceQueries,
    conversationExecution,
    conversationExecutionCoordinator,
    conversationPlanActions,
    conversationProviderItems,
    conversationRequests,
    conversationSubmissions,
    conversationTurns,
    conversations,
    countDirectProjectActiveWritableConversations,
    createTaskCodeReviewPrompt,
    createTaskRuntimePrompt,
    currentCodexRuntimeCommandPath,
    db,
    dispatchUnifiedConversationQueueHead,
    idempotencyRequests,
    isPathInsideProjectRoot,
    mergeTaskPushAttachmentInputs,
    modelConnections,
    moveTaskToPushedManagementStatus,
    moveTaskTowardRunning,
    nativeIdempotentInFlight,
    normalizeServiceTierForCapability,
    normalizeTaskPushAttachments,
    normalizeTaskPushSupplementalAttachments,
    now,
    options,
    piNativeCoordinator,
    platformMutableState,
    prepareTaskIntegrationAiAttempt,
    projects,
    publishNativeConversationEvent,
    readProjectConfig,
    readServiceTierOverride,
    readTaskWorkspaceReview,
    reconnectNonCodexLegacyConversationRuntime,
    recordTaskEvent,
    redactSensitiveText,
    resolveConversationCapabilities,
    resolveModelCapability,
    resolveNonCodexLiveSession,
    resolveSelectedTaskPushContext,
    resolveTaskIntegrationRequest,
    resolveTaskPushEnvironment,
    resolveTaskPushExecutionCapabilities,
    shouldReconnectTaskConversationRuntime,
    taskConflictAiOperations,
    taskIntegrationAttempts,
    taskManagementStatusIsTerminal,
    resolveNativeConversationExecutionRoot,
    taskStages,
    taskWorkspaces,
    tasks,
    toGraphConversationHistoryItem,
    trustedConversationAttachmentRoots,
  } = dependencies;
  async function archiveNativeConversation(conversation: ZeusConversationRecord): Promise<void> {
    if (conversation.agentKind === 'pi') {
      await piNativeCoordinator.archiveConversation({ conversationId: conversation.id });
      return;
    }
    if (conversation.agentKind !== null && conversation.agentKind !== 'codex') {
      throw nativeApiError('ZEUS_AGENT_NOT_AVAILABLE', `Agent ${conversation.agentKind} does not support native conversation archive.`);
    }
    await codexNativeCoordinator.archiveConversation({ conversationId: conversation.id });
  }

  async function restoreNativeConversation(conversation: ZeusConversationRecord): Promise<void> {
    if (conversation.agentKind === 'pi') {
      await piNativeCoordinator.restoreArchivedConversation({ conversationId: conversation.id });
      return;
    }
    if (conversation.agentKind !== null && conversation.agentKind !== 'codex') {
      throw nativeApiError('ZEUS_AGENT_NOT_AVAILABLE', `Agent ${conversation.agentKind} does not support native conversation restore.`);
    }
    await codexNativeCoordinator.restoreArchivedConversation({ conversationId: conversation.id });
  }

  function toNativeSubmission(submission: NonNullable<ReturnType<ConversationSubmissionRepository['getById']>>, options: { includeRecoveryPayload?: boolean } = {}) {
    const input = parseJsonObject(submission.inputJson);
    return {
      id: submission.id,
      conversationId: submission.conversationId,
      content: typeof input.displayText === 'string' && input.displayText.trim() ? input.displayText : typeof input.text === 'string' ? input.text : '',
      ...(options.includeRecoveryPayload && typeof input.composerDraft === 'string' ? { composerDraft: input.composerDraft } : {}),
      status: submission.status,
      delivery: input.delivery === 'steer_now' ? 'steer_now' : 'queue',
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      ...(options.includeRecoveryPayload && Array.isArray(input.browserComments) && input.browserComments.length ? { browserComments: input.browserComments } : {}),
      ...(options.includeRecoveryPayload && typeof input.browserCommentContent === 'string' ? { browserCommentContent: input.browserCommentContent } : {}),
      ...(isNativeApiRecord(input.conversationContext) ? { conversationContext: input.conversationContext } : {}),
      expectedTurnId: typeof input.expectedTurnId === 'string' ? input.expectedTurnId : null,
      clientUserMessageId: submission.clientMessageId,
      position: submission.queuePosition,
      providerTurnId: submission.providerTurnId,
      pausedReason: submission.pausedReason,
      error: toNativeSubmissionError(submission.errorJson),
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
    };
  }

  function toNativeSubmissionError(errorJson: string | null): { code: string; message: string; recoveryRequired: boolean } | null {
    if (!errorJson) return null;
    const parsed = parseJsonObject(errorJson);
    const code = typeof parsed.code === 'string' && parsed.code.trim() ? parsed.code : 'ZEUS_NATIVE_SUBMISSION_FAILED';
    const message = typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message : 'Native message submission failed.';
    return {
      code,
      message,
      recoveryRequired: parsed.recoveryRequired === true || code.includes('RECOVERY') || code.includes('WORKTREE_UNAVAILABLE'),
    };
  }

  function toNativeServerRequest(request: NonNullable<ReturnType<ConversationServerRequestRepository['getById']>>) {
    const conversation = conversations.getRecordById(request.conversationId);
    const projectRoot = conversation ? resolveNativeConversationExecutionRoot(conversation) : null;
    return nativePendingRequestProjection(
      request,
      conversation
        ? {
            conversation,
            projectRoot,
            providerItems: conversationProviderItems,
          }
        : undefined,
    );
  }

  function conversationGoalCapability(conversation: ZeusConversationRecord) {
    if (conversation.agentKind !== 'codex' && conversation.providerId !== 'codex') {
      return { supported: false, enabled: false, stage: null, reason: 'agent_unsupported' as const };
    }
    const state = codexAppServerManager.getState();
    if (state.type !== 'ready') return { supported: false, enabled: false, stage: null, reason: 'unverified' as const };
    const goals = state.capabilities.goals;
    return {
      ...goals,
      reason: goals.supported && goals.enabled ? ('available' as const) : goals.supported ? ('disabled' as const) : ('app_server_unsupported' as const),
    };
  }

  function toNativeQueueApiSnapshot(conversation: ZeusConversationRecord, submissions = conversationSubmissions.listQueueByConversation(conversation.id)) {
    const state = inferNativeConversationSnapshotState(conversation);
    const queuedSubmissions = submissions.filter((submission) => (submission.status === 'queued' || submission.status === 'paused') && !submission.providerTurnId);
    return {
      state,
      waitReason: inferNativeQueueWaitReason(conversation, state, queuedSubmissions),
      submissions: queuedSubmissions.map((submission) => toNativeSubmission(submission, { includeRecoveryPayload: true })),
    };
  }

  function inferNativeQueueWaitReason(conversation: ZeusConversationRecord, state: ReturnType<typeof inferNativeConversationSnapshotState>, submissions: ReturnType<ConversationSubmissionRepository['listQueueByConversation']>) {
    if (state.type === 'active') return 'current_turn' as const;
    if (state.type === 'dispatching') return 'dispatching' as const;
    if (state.type === 'waiting') return state.reason;
    if (state.type === 'paused') return state.reason;
    if (conversationPlanActions.listByConversation(conversation.id).some((request) => request.status === 'pending')) return 'plan_confirmation' as const;
    if (
      submissions.some((submission) => {
        const input = parseJsonObject(submission.inputJson);
        return isNativeApiRecord(input.context) && input.context.holdDispatch === true;
      })
    ) {
      return 'execution_context_preparing' as const;
    }
    if (submissions.length > 0 && submissions.every((submission) => submission.pausedReason === 'user_confirmation')) return 'user_confirmation' as const;
    return 'dispatch_pending' as const;
  }

  function inferNativeConversationSnapshotState(conversation: ZeusConversationRecord) {
    const conflictAttempt = taskIntegrationAttempts.getByConversationId(conversation.id);
    if (conflictAttempt?.state === 'preparing') return { type: 'paused' as const, reason: 'conflict_preparing' as const };
    if (conflictAttempt?.state === 'failed') return { type: 'paused' as const, reason: 'conflict_preparation_failed' as const };
    if (conversation.providerState === 'archived')
      return {
        type: 'paused' as const,
        reason: 'provider_archived' as const,
      };
    const active = conversationTurns.getLatestActiveByConversation(conversation.id);
    if (active?.providerTurnId) {
      if (active.status === 'waiting') {
        const pending = conversationRequests
          .listPendingByConversation(conversation.id)
          .find((request) => request.turnId === active.id && (conversation.agentKind === 'pi' || codexAppServerManager.hasGeneration(request.transportGenerationId)));
        if (pending) {
          return {
            type: 'waiting' as const,
            turnId: active.providerTurnId,
            requestId: pending.id,
            reason: pending.requestKind === 'request_user_input' ? ('user_input' as const) : ('approval' as const),
          };
        }
      }
      return { type: 'active' as const, turnId: active.providerTurnId, phase: 'prework' as const };
    }
    const dispatching = conversationSubmissions.listByConversation(conversation.id).find((submission) => submission.status === 'dispatching' && !submission.providerTurnId);
    if (dispatching) return { type: 'dispatching' as const, submissionId: dispatching.id };
    const paused = conversationSubmissions.listByConversation(conversation.id).filter((submission) => submission.status === 'paused' && !submission.providerTurnId);
    if (paused.some((submission) => submission.pausedReason === 'runtime_rejected')) return { type: 'paused' as const, reason: 'runtime_rejected' as const };
    if (paused.some((submission) => submission.pausedReason === 'recovery_required')) return { type: 'paused' as const, reason: 'recovery_required' as const };
    if (paused.some((submission) => submission.pausedReason === 'interrupted')) return { type: 'paused' as const, reason: 'interrupted' as const };
    if (paused.some((submission) => submission.pausedReason === 'transport_unavailable')) return { type: 'paused' as const, reason: 'transport_unavailable' as const };
    if (conversation.providerState === 'paused') return { type: 'paused' as const, reason: 'recovery_required' as const };
    if (paused.length > 0 && paused.every((submission) => submission.pausedReason === 'user_confirmation')) return { type: 'idle' as const };
    if (paused.length > 0) return { type: 'paused' as const, reason: 'recovery_required' as const };
    return { type: 'idle' as const };
  }

  function requireNativeQueueConversation(params: { projectId: string; conversationId: string }) {
    const conversation = conversations.getById(params.conversationId);
    if (!conversation || conversation.projectId !== params.projectId || conversation.transportKind !== 'codex_native') {
      throw Object.assign(nativeApiError('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Native conversation not found'), { statusCode: 404 });
    }
    return conversation;
  }

  async function executeConversationDispatchMessage(input: {
    params: { projectId: string; conversationId: string };
    body: Record<string, unknown>;
    operationIdentity: string;
    providerWriteLifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void };
  }) {
    const project = projects.getById(input.params.projectId);
    if (!project) throw Object.assign(nativeApiError('ZEUS_PROJECT_NOT_FOUND', 'Project not found'), { statusCode: 404 });
    const conversation = conversations.getById(input.params.conversationId);
    if (!conversation || conversation.projectId !== project.id) throw Object.assign(nativeApiError('ZEUS_CONVERSATION_NOT_FOUND', 'Conversation not found'), { statusCode: 404 });
    if (conversation.taskId) {
      const task = tasks.getById(conversation.taskId);
      if (task && taskManagementStatusIsTerminal(task)) {
        throw Object.assign(nativeApiError('ZEUS_TASK_REOPEN_REQUIRED', 'This task is completed or cancelled. Reopen the task and restore one archived conversation before continuing.'), { statusCode: 409 });
      }
    }
    assertRequestedAgentKind(input.body);
    if (conversation.agentKind === 'claude') throw Object.assign(nativeApiError('ZEUS_AGENT_NOT_AVAILABLE', 'Claude Agent 当前尚未开放。'), { statusCode: 409 });
    const idempotencyKey = typeof input.body.idempotencyKey === 'string' ? input.body.idempotencyKey.trim() : '';
    if (!idempotencyKey) throw Object.assign(nativeApiError('ZEUS_IDEMPOTENCY_KEY_REQUIRED', 'input.idempotencyKey is required.'), { statusCode: 400 });
    const content = typeof input.body.content === 'string' ? input.body.content.trim() : '';
    const hasNativeResourceInput =
      conversation.transportKind === 'codex_native' &&
      ((Array.isArray(input.body.attachments) && input.body.attachments.length > 0) || (Array.isArray(input.body.browserComments) && input.body.browserComments.length > 0) || isNativeApiRecord(input.body.conversationContext));
    if (!content && !hasNativeResourceInput) throw Object.assign(nativeApiError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'Conversation message content, attachments, or browser comments are required'), { statusCode: 400 });
    if (conversation.transportKind === 'codex_native') {
      const body = input.body as CreateConversationMessageBody;
      const accepted = await acceptNativeConversationMessage(conversation, content, body, idempotencyKey, input.operationIdentity, input.providerWriteLifecycle);
      return { statusCode: 202, body: accepted };
    }

    const legacyContext = resolveWritableNonCodexLegacyConversation(conversation, {
      configuredCommands: {
        claude: platformMutableState.runtimeSettings.adapterCliPaths.claude,
        gemini: platformMutableState.runtimeSettings.adapterCliPaths.gemini,
        generic: platformMutableState.runtimeSettings.adapterCliPaths.generic,
      },
    });
    if (!legacyContext) throw Object.assign(nativeApiError('ZEUS_LEGACY_CONVERSATION_READ_ONLY', 'Legacy CLI conversations are read-only. Create a native conversation with an explicit legacy reference instead.'), { statusCode: 409 });
    const liveResolution = resolveNonCodexLiveSession(project, legacyContext);
    if (liveResolution.type === 'mismatch') throw Object.assign(nativeApiError('ZEUS_LEGACY_RUNTIME_IDENTITY_MISMATCH', liveResolution.reason), { statusCode: 409 });
    const createdAt = now().toISOString();
    conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content,
      source: 'user_followup',
      metadata: { projectId: project.id, taskId: conversation.taskId, sessionId: conversation.sessionId },
      createdAt,
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'conversation.message.created',
      resourceType: 'conversation',
      resourceId: conversation.id,
      payload: { projectId: project.id, conversationId: conversation.id, taskId: conversation.taskId, sessionId: conversation.sessionId, contentLength: content.length },
    });
    let runtimeSession: AiRuntimeSession | undefined;
    let runtimeError: { message: string } | undefined;
    const conversationAfterUserMessage = conversations.getById(conversation.id);
    if (!conversationAfterUserMessage) throw new Error(`Zeus conversation not found: ${conversation.id}`);
    const refreshedLegacyContext: WritableNonCodexLegacyConversationContext = { ...legacyContext, conversation: conversationAfterUserMessage };
    if (liveResolution.type === 'writable') {
      try {
        input.providerWriteLifecycle.markRpcStarted(conversation.id);
        runtimeSession = aiRuntimeManager.inputSession(liveResolution.session.id, `${content}\n`);
        appendAuditLog({
          actorType: 'local_api',
          action: 'runtime.session.input',
          resourceType: 'runtime_session',
          resourceId: runtimeSession.id,
          payload: { sessionId: runtimeSession.id, projectId: runtimeSession.projectId, taskId: runtimeSession.taskId, conversationId: conversation.id, inputLength: content.length, source: 'conversation.message' },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!shouldReconnectTaskConversationRuntime(message)) runtimeError = { message: boundedConversationDispatchError(message) };
      }
    }
    if (!runtimeSession && !runtimeError) {
      input.providerWriteLifecycle.markRpcStarted(conversation.id);
      const reconnectResult = await reconnectNonCodexLegacyConversationRuntime(project, refreshedLegacyContext, conversation.sessionId ?? 'missing-runtime-session');
      if ('runtimeSession' in reconnectResult) runtimeSession = reconnectResult.runtimeSession;
      else runtimeError = { message: boundedConversationDispatchError(reconnectResult.runtimeError.message) };
    }
    if (runtimeError) {
      conversations.appendMessage({
        conversationId: conversation.id,
        role: 'system',
        content: `Runtime 输入失败：${runtimeError.message}`,
        source: 'task_runtime_input_error',
        metadata: { projectId: project.id, taskId: conversation.taskId, sessionId: conversation.sessionId },
        createdAt: now().toISOString(),
      });
    }
    await db.save();
    const updatedConversation = conversations.getById(conversation.id);
    if (!updatedConversation) throw new Error(`Zeus conversation not found: ${conversation.id}`);
    return {
      statusCode: 201,
      body: {
        conversation: toGraphConversationHistoryItem(updatedConversation),
        ...(runtimeSession ? { runtimeSession } : {}),
        ...(runtimeError ? { runtimeError } : {}),
      },
    };
  }

  async function executeConversationDispatchSideChat(input: { params: { projectId: string; conversationId: string }; selectedText: string; question: string; operationIdentity: string }) {
    const project = projects.getById(input.params.projectId);
    const conversation = conversations.getById(input.params.conversationId);
    if (!project) throw Object.assign(nativeApiError('ZEUS_PROJECT_NOT_FOUND', 'Project not found'), { statusCode: 404 });
    if (!conversation || conversation.projectId !== project.id) throw Object.assign(nativeApiError('ZEUS_CONVERSATION_NOT_FOUND', 'Conversation not found'), { statusCode: 404 });
    if (conversation.transportKind !== 'codex_native') throw Object.assign(nativeApiError('ZEUS_SIDE_CHAT_UNAVAILABLE', 'Side chat requires a Codex native conversation.'), { statusCode: 409 });
    const cwd = resolveNativeConversationExecutionRoot(conversation) ?? project.localPath;
    const prompt = ['你是 Zeus 会话中的临时侧边聊天。', '只回答用户围绕所选文字提出的问题；保持简洁，并在信息不足时明确说明。', `主会话：${conversation.title}`, `所选文字：\n${input.selectedText}`, `用户问题：\n${input.question}`].join(
      '\n\n',
    );
    const operation = await codexNativeCoordinator.startEphemeralConversation({
      projectId: project.id,
      projectLocalPath: cwd,
      title: `侧边聊天：${input.question.slice(0, 48)}`,
      prompt,
      model: conversation.providerModel ?? (await resolveCodexModel(project)),
      idempotencyKey: input.operationIdentity,
      clientUserMessageId: `side-chat-client:${input.operationIdentity}`,
    });
    if (operation.status !== 'active' || !operation.providerTurnId) throw nativeApiError('ZEUS_SIDE_CHAT_DISPATCH_FAILED', 'Temporary side chat could not start.');
    const result = await codexNativeCoordinator.waitForTurnResult({
      conversationId: operation.conversationId,
      providerTurnId: operation.providerTurnId,
      timeoutMs: platformMutableState.runtimeSettings.executionTimeoutSeconds * 1_000,
    });
    return { answer: result.answer, status: result.status };
  }

  async function prepareConversationQueueReroute(input: {
    params: { projectId: string; conversationId: string; submissionId: string };
    settings: { model?: unknown; effort?: unknown; serviceTier?: unknown; permissionMode?: unknown; collaborationMode?: unknown };
  }): Promise<PreparedConversationQueueReroute> {
    const project = projects.getById(input.params.projectId);
    const conversation = requireNativeQueueConversation(input.params);
    if (!project) throw Object.assign(nativeApiError('ZEUS_PROJECT_NOT_FOUND', 'Project not found'), { statusCode: 404 });
    const original = conversationSubmissions.getById(input.params.submissionId);
    const queueHead = conversationSubmissions.listByConversation(conversation.id).find((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
    if (!original || original.conversationId !== conversation.id || !queueHead || queueHead.id !== original.id) throw nativeApiError('ZEUS_NATIVE_QUEUE_HEAD_REQUIRED', '只能改路由替换当前暂停的队首提交。');
    if ((original.status !== 'paused' && original.status !== 'failed') || original.providerTurnId) throw nativeApiError('ZEUS_NATIVE_SUBMISSION_NOT_REROUTABLE', '只有 Provider 写入前失败且未产生 turn 的队首可以改路由。');
    if (original.pausedReason === 'outcome_unknown' || original.submissionOutcome === 'outcome_unknown') throw nativeApiError('ZEUS_NATIVE_SUBMISSION_OUTCOME_UNKNOWN', '接纳结果未知的提交禁止改路由，必须先完成恢复核对或取消。');
    const requestedModel = typeof input.settings.model === 'string' ? input.settings.model.trim() : '';
    if (!requestedModel) throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', '改路由必须指定输入框当前模型。');
    const capabilities = await resolveConversationCapabilities(project);
    const selectedModel = resolveModelCapability(capabilities.models, requestedModel);
    if (!selectedModel || selectedModel.available === false) throw nativeApiError('ZEUS_MODEL_NOT_READY', selectedModel?.availabilityReason || '所选模型当前不可运行。');
    const effort = typeof input.settings.effort === 'string' && input.settings.effort.trim() ? input.settings.effort.trim() : (selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? null);
    if (effort && !selectedModel.supportedReasoningEfforts.some((candidate) => candidate === effort)) throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', '所选模型不支持该推理级别。');
    const requestedServiceTier = readServiceTierOverride(input.settings);
    const serviceTier = normalizeServiceTierForCapability(requestedServiceTier, selectedModel) ?? null;
    const permissionMode = input.settings.permissionMode === undefined ? conversation.permissionMode : parseConversationPermissionMode(input.settings.permissionMode);
    const collaborationMode = input.settings.collaborationMode === undefined ? conversation.collaborationMode : parseConversationCollaborationMode(input.settings.collaborationMode);
    if (!permissionMode || !collaborationMode) throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', '改路由的权限或工作模式无效。');
    const modelSourceId = selectedModel.sourceId ?? (selectedModel.agentKind === 'codex' ? 'codex' : conversation.modelSourceId);
    const connection = modelSourceId && modelSourceId !== 'codex' ? await modelConnections.get(modelSourceId) : undefined;
    if (modelSourceId && modelSourceId !== 'codex' && !connection) throw nativeApiError('ZEUS_MODEL_CONNECTION_NOT_FOUND', '目标模型连接已经不存在。');
    const configuredModel = connection?.models.find((model) => model.id === selectedModel.model);
    const previousInput = parseJsonObject(original.inputJson);
    const previousContext = isNativeApiRecord(previousInput.context) ? previousInput.context : {};
    return {
      conversationId: conversation.id,
      originalId: original.id,
      originalUpdatedAt: original.updatedAt,
      originalInputJson: original.inputJson,
      nextInput: {
        ...previousInput,
        context: { ...previousContext, model: selectedModel.model, modelSourceId, agentKind: selectedModel.agentKind === 'pi' ? 'pi' : 'codex', thinkingLevel: effort, permissionMode, collaborationMode },
      },
      route: {
        runtimeKind: selectedModel.agentKind === 'pi' ? 'pi' : 'codex',
        connectionId: connection?.id ?? null,
        credentialSlotId: connection && configuredModel ? modelConnectionCredentialSlotId(connection.id, configuredModel.authenticationScheme) : 'codex-managed-account',
        endpointIdentity: connection?.baseUrl ?? 'codex://managed-account',
        protocolFamily: configuredModel?.protocolFamily ?? (selectedModel.agentKind === 'pi' ? 'openai_completions' : 'openai_responses'),
        modelId: selectedModel.model,
        effort,
        serviceTier,
        permissionMode,
        collaborationMode,
        executionRoot: resolveNativeConversationExecutionRoot(conversation) ?? project.localPath,
      },
    };
  }

  function applyConversationQueueReroute(params: { projectId: string; conversationId: string; submissionId: string }, prepared: PreparedConversationQueueReroute) {
    const conversation = requireNativeQueueConversation(params);
    const current = conversationSubmissions.getById(prepared.originalId);
    if (
      prepared.conversationId !== conversation.id ||
      !current ||
      current.id !== params.submissionId ||
      current.updatedAt !== prepared.originalUpdatedAt ||
      current.inputJson !== prepared.originalInputJson ||
      (current.status !== 'paused' && current.status !== 'failed') ||
      current.providerTurnId
    ) {
      throw Object.assign(nativeApiError('ZEUS_NATIVE_QUEUE_REROUTE_STALE', '队首提交在改路由准备后已经变化，请刷新后重试。'), { statusCode: 409 });
    }
    const replacedAt = now().toISOString();
    const replacement = conversationSubmissions.createReplacement(current.id, {
      requestHash: createHash('sha256').update(JSON.stringify(prepared.nextInput)).digest('hex'),
      input: prepared.nextInput,
      reason: 'reroute',
      inheritExecutionSnapshot: false,
      updatedAt: replacedAt,
    });
    const snapshot = conversationExecution.createExecutionSnapshot({
      conversationId: conversation.id,
      runtimeKind: prepared.route.runtimeKind,
      connectionId: prepared.route.connectionId,
      credentialSlotId: prepared.route.credentialSlotId,
      endpointIdentity: prepared.route.endpointIdentity,
      protocolFamily: prepared.route.protocolFamily as 'codex_app_server' | 'openai_responses' | 'openai_completions' | 'anthropic_messages',
      modelId: prepared.route.modelId,
      effort: prepared.route.effort,
      serviceTier: prepared.route.serviceTier,
      permissionMode: prepared.route.permissionMode,
      collaborationMode: prepared.route.collaborationMode,
      workspaceIdentity: {
        projectId: conversation.projectId,
        taskId: conversation.taskId,
        workspaceId: conversation.workspaceId,
        environmentId: conversation.environmentId,
        executionRoot: prepared.route.executionRoot,
      },
      createdAt: replacedAt,
    });
    conversationExecution.freezeSubmissionExecutionSnapshot({ conversationId: conversation.id, submissionId: replacement.id, executionSnapshotId: snapshot.id });
    return toNativeQueueApiSnapshot(conversation);
  }

  async function executeConversationDispatchRequestResponse(input: { params: { projectId: string; conversationId: string; requestId: string }; response: Record<string, unknown>; operationIdentity: string }) {
    const conversation = requireNativeQueueConversation(input.params);
    const providerRequest = conversationRequests.getById(input.params.requestId);
    if (!providerRequest || providerRequest.conversationId !== conversation.id) throw Object.assign(nativeApiError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request not found'), { statusCode: 404 });
    const response = normalizeNativeServerRequestResponse(providerRequest.requestKind, input.response);
    const project = projects.getById(conversation.projectId);
    if (!project) throw Object.assign(nativeApiError('ZEUS_PROJECT_NOT_FOUND', 'Conversation project not found.'), { statusCode: 404 });
    const answerAttachmentInput = normalizeRequestUserInputAnswerAttachments(providerRequest, input.response, project.localPath);
    if (conversation.agentKind === 'pi') {
      if (answerAttachmentInput.groups.length > 0) throw nativeApiError('ZEUS_REQUEST_ANSWER_ATTACHMENTS_UNSUPPORTED', 'Pi request answers do not support structured attachments.');
      await piNativeCoordinator.respondToRequest({ requestId: providerRequest.id, response });
    } else {
      await codexNativeCoordinator.respondToRequest({
        requestId: providerRequest.id,
        response,
        ...(answerAttachmentInput.groups.length ? { answerAttachments: answerAttachmentInput.groups } : {}),
        ...(Object.keys(answerAttachmentInput.presentation).length ? { answerAttachmentPresentation: answerAttachmentInput.presentation } : {}),
      });
    }
    const resolved = conversationRequests.getById(providerRequest.id);
    if (!resolved) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native request response was not persisted.');
    return { operation: { id: input.operationIdentity, status: 'accepted' as const, idempotencyKey: providerRequest.id }, request: toNativeServerRequest(resolved) };
  }

  function boundedConversationDispatchError(value: string): string {
    const redacted = redactSensitiveText(value).text;
    const bytes = Buffer.from(redacted, 'utf8');
    if (bytes.byteLength <= 2 * 1024) return redacted;
    return `${bytes
      .subarray(0, 2 * 1024 - 3)
      .toString('utf8')
      .replace(/\uFFFD$/u, '')}...`;
  }

  async function acceptNativeConversationMessage(
    conversation: ZeusConversationWithMessagesRecord,
    content: string,
    body: CreateConversationMessageBody,
    idempotencyKey: string,
    stableOperationId: string,
    providerWriteLifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void },
  ) {
    const delivery = body.delivery ?? 'queue';
    if (delivery !== 'queue' && delivery !== 'steer_now') throw nativeApiError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'Message delivery must be queue or steer_now.');
    const project = projects.getById(conversation.projectId);
    if (!project) throw nativeApiError('ZEUS_PROJECT_NOT_FOUND', 'Conversation project was not found.');
    const attachments = normalizeNativeConversationAttachments(body.attachments, project.localPath);
    const browserComments = normalizeNativeBrowserComments(body.browserComments);
    const composerDraft =
      body.composerDraft === undefined
        ? undefined
        : typeof body.composerDraft === 'string' && body.composerDraft.length <= 100_000
          ? body.composerDraft
          : (() => {
              throw nativeApiError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'composerDraft must be a string no longer than 100000 characters.');
            })();
    const browserCommentContent =
      body.browserCommentContent === undefined
        ? undefined
        : typeof body.browserCommentContent === 'string' && body.browserCommentContent.length <= 1_000_000
          ? body.browserCommentContent
          : (() => {
              throw nativeApiError('ZEUS_INVALID_BROWSER_COMMENTS', 'browserCommentContent must be a string no larger than 1 MB.');
            })();
    const conversationContext = normalizeNativeConversationContext(body.conversationContext);
    if (!content && attachments.length === 0 && browserComments.length === 0 && !conversationContext) {
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'Conversation message content, attachments, comments, or annotations are required.');
    }
    const displayText =
      body.displayText === undefined
        ? undefined
        : typeof body.displayText === 'string' && body.displayText.trim() && body.displayText.length <= 100_000
          ? body.displayText.trim()
          : (() => {
              throw nativeApiError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'displayText must be a non-empty string no longer than 100000 characters.');
            })();
    const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    const requestedEffort = typeof body.effort === 'string' && body.effort.trim() ? body.effort.trim() : null;
    const requestedServiceTier = readServiceTierOverride(body);
    const permissionMode = body.permissionMode === undefined ? undefined : parseConversationPermissionMode(body.permissionMode);
    if (body.permissionMode !== undefined && !permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
    const collaborationMode = body.collaborationMode === undefined ? undefined : parseConversationCollaborationMode(body.collaborationMode);
    if (body.collaborationMode !== undefined && !collaborationMode) throw nativeApiError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.');
    const expectedTurnId = typeof body.expectedTurnId === 'string' && body.expectedTurnId.trim() ? body.expectedTurnId.trim() : null;
    if (delivery === 'steer_now') {
      if (requestedModel || requestedEffort || requestedServiceTier.present || body.permissionMode !== undefined) {
        throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', 'Model, reasoning effort, service tier, and permission mode can change only when starting a queued turn.');
      }
      const activeTurn = [...conversationTurns.listByConversation(conversation.id)].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching');
      if (!expectedTurnId || activeTurn?.providerTurnId !== expectedTurnId) {
        throw nativeApiError('ZEUS_NATIVE_TURN_MISMATCH', 'steer_now requires the exact currently active provider turn id.');
      }
    }
    let selectedModel: string | null = null;
    let selectedModelSourceId: string | null = conversation.modelSourceId;
    let selectedAgentKind: 'codex' | 'pi' = conversation.agentKind === 'pi' ? 'pi' : 'codex';
    let selectedEffort: string | null = null;
    let selectedServiceTier: string | null | undefined;
    let selectedContextWindow: number | null = null;
    if (requestedModel || requestedEffort || requestedServiceTier.present) {
      const capabilities = await resolveConversationCapabilities(project);
      const model = requestedModel ?? conversation.providerModel ?? capabilities.preferredModel;
      const capability = resolveModelCapability(capabilities.models, model);
      if (!capability) throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', 'Selected Codex model is not available in the current app-server generation.');
      if (capability.available === false) throw nativeApiError('ZEUS_MODEL_NOT_READY', capability.availabilityReason || '所选模型当前不可运行。');
      if (requestedEffort && !capability.supportedReasoningEfforts.some((effort) => effort === requestedEffort)) {
        throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', 'Selected reasoning effort is not supported by the selected Codex model.');
      }
      selectedModel = capability.model;
      selectedModelSourceId = capability.sourceId ?? null;
      selectedAgentKind = capability.agentKind ?? 'codex';
      selectedEffort = requestedEffort ?? capability.defaultReasoningEffort ?? capability.supportedReasoningEfforts[0] ?? null;
      selectedServiceTier = normalizeServiceTierForCapability(requestedServiceTier, capability);
      selectedContextWindow = capability.contextWindow;
    }
    const clientUserMessageId = normalizeNativeClientUserMessageId(body.clientUserMessageId, `native-client-${createHash('sha256').update(`${conversation.id}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`);
    const effectiveModel = selectedModel ?? conversation.modelId ?? conversation.providerModel;
    if (!effectiveModel) throw nativeApiError('ZEUS_MODEL_UNAVAILABLE', '当前会话没有可冻结的目标模型。');
    const effectiveModelSourceId = selectedModelSourceId ?? (selectedAgentKind === 'codex' ? 'codex' : conversation.modelSourceId);
    if (delivery === 'steer_now' && selectedAgentKind === 'pi' && (attachments.length > 0 || browserComments.length > 0 || Boolean(browserCommentContent) || Boolean(conversationContext))) {
      throw nativeApiError('ZEUS_PI_STEER_RESOURCES_UNSUPPORTED', 'Pi 当前执行轮次的插话只支持纯文本；附件、浏览器批注与结构化上下文请进入下一轮队列。');
    }
    const executionRoot = resolveNativeConversationExecutionRoot(conversation) ?? project.localPath;
    const resolvedExecutionRoute = await resolveConversationExecutionRoute({
      agentKind: selectedAgentKind,
      modelSourceId: effectiveModelSourceId,
      modelId: effectiveModel,
      effort: selectedEffort,
      serviceTier: selectedServiceTier ?? null,
      permissionMode: permissionMode ?? conversation.permissionMode,
      collaborationMode: collaborationMode ?? conversation.collaborationMode,
      projectId: conversation.projectId,
      taskId: conversation.taskId,
      workspaceId: conversation.workspaceId,
      environmentId: conversation.environmentId,
      executionRoot,
    });
    const executionRoute = resolvedExecutionRoute.route;
    const selectedConfiguredModel = resolvedExecutionRoute.configuredModel;
    const segmentLifecycle =
      delivery === 'queue'
        ? conversationExecutionCoordinator.createLifecycle({
            conversationId: conversation.id,
            route: executionRoute,
            targetCapabilities: {
              readableReasoningSummary: true,
              media: selectedConfiguredModel?.capability.imageInput.state !== 'unsupported',
              contextWindow: selectedConfiguredModel?.contextWindow ?? selectedContextWindow,
              currentInputCharacters: content.length + JSON.stringify({ attachments, browserComments, conversationContext }).length,
            },
            userHistoryContent: {
              text: content,
              ...(displayText ? { displayText } : {}),
              attachments,
              browserComments,
              ...(conversationContext ? { conversationContext } : {}),
            },
          })
        : null;
    const conversationSkill = segmentLifecycle?.requiresNewSegment ? readNativeConversationSkill(conversationSubmissions.listByConversation(conversation.id)) : null;
    const conflictAttempt = taskIntegrationAttempts.getByConversationId(conversation.id);
    const conflictPreparationHeld = conflictAttempt?.state === 'preparing' || conflictAttempt?.state === 'failed';
    const executionBusy =
      conversationTurns.listByConversation(conversation.id).some((turn) => turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching') ||
      conversationSubmissions.listByConversation(conversation.id).some((submission) => submission.status === 'dispatching' || submission.status === 'active');
    if (conflictPreparationHeld && delivery === 'steer_now') {
      throw nativeApiError('ZEUS_CONFLICT_PREPARATION_NOT_ACTIVE', '冲突现场尚未准备完成，补充消息只能进入当前会话队列。');
    }
    const nativeOperation = await (async () => {
      if (selectedAgentKind === 'pi') {
        if (delivery === 'queue' && executionBusy && !conflictPreparationHeld) {
          return piNativeCoordinator.queueHeldMessage({
            conversation,
            submissionId: `conversation_submission_${createHash('sha256').update(`${stableOperationId}\0pi-queued`).digest('hex').slice(0, 24)}`,
            content,
            model: { sourceId: effectiveModelSourceId, modelId: effectiveModel, displayName: null },
            ...(selectedEffort ? { thinkingLevel: selectedEffort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            idempotencyKey,
            clientUserMessageId,
            attachments,
            browserComments,
            ...(browserCommentContent ? { browserCommentContent } : {}),
            ...(conversationContext ? { conversationContext } : {}),
            ...(conversationSkill ? { skill: conversationSkill } : {}),
            holdDispatch: false,
            ...(segmentLifecycle ? { segmentLifecycle } : {}),
          });
        }
        if (conflictPreparationHeld) {
          return piNativeCoordinator.queueHeldMessage({
            conversation,
            submissionId: `conversation_submission_${createHash('sha256').update(`${stableOperationId}\0pi-held`).digest('hex').slice(0, 24)}`,
            content,
            model: { sourceId: effectiveModelSourceId, modelId: effectiveModel, displayName: null },
            ...(selectedEffort ? { thinkingLevel: selectedEffort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            idempotencyKey,
            clientUserMessageId,
            attachments,
            browserComments,
            ...(browserCommentContent ? { browserCommentContent } : {}),
            ...(conversationContext ? { conversationContext } : {}),
            ...(conversationSkill ? { skill: conversationSkill } : {}),
          });
        }
        if (delivery === 'steer_now') {
          return piNativeCoordinator.steerMessage({
            conversation,
            submissionId: `conversation_submission_${createHash('sha256').update(`${stableOperationId}\0pi-steer`).digest('hex').slice(0, 24)}`,
            content,
            expectedTurnId: expectedTurnId!,
            idempotencyKey,
            clientUserMessageId,
            providerWriteLifecycle,
          });
        }
        const submissionId = `conversation_submission_${createHash('sha256').update(`${stableOperationId}\0pi-submission`).digest('hex').slice(0, 24)}`;
        if (segmentLifecycle?.requiresNewSegment) {
          return piNativeCoordinator.startConversation({
            conversationId: conversation.id,
            submissionId,
            projectId: conversation.projectId,
            ...(conversation.taskId ? { taskId: conversation.taskId } : {}),
            ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
            ...(conversation.environmentId ? { environmentId: conversation.environmentId } : {}),
            conversationTitle: conversation.title,
            cwd: executionRoot,
            prompt: content,
            model: { sourceId: effectiveModelSourceId, modelId: effectiveModel, displayName: null },
            ...(selectedEffort ? { thinkingLevel: selectedEffort } : {}),
            permissionMode: permissionMode ?? conversation.permissionMode,
            idempotencyKey,
            clientUserMessageId,
            attachments,
            allowedAttachmentRoots: trustedConversationAttachmentRoots,
            browserComments,
            ...(browserCommentContent ? { browserCommentContent } : {}),
            ...(conversationContext ? { conversationContext } : {}),
            ...(conversationSkill ? { skill: conversationSkill } : {}),
            providerWriteLifecycle,
            segmentLifecycle,
          });
        }
        return piNativeCoordinator.submitMessage({
          conversation,
          submissionId,
          content,
          model: { sourceId: effectiveModelSourceId, modelId: effectiveModel, displayName: null },
          ...(selectedEffort ? { thinkingLevel: selectedEffort } : {}),
          idempotencyKey,
          clientUserMessageId,
          attachments,
          allowedAttachmentRoots: trustedConversationAttachmentRoots,
          browserComments,
          ...(browserCommentContent ? { browserCommentContent } : {}),
          ...(conversationContext ? { conversationContext } : {}),
          providerWriteLifecycle,
          ...(segmentLifecycle ? { segmentLifecycle } : {}),
        });
      }
      if (delivery === 'steer_now') {
        return codexNativeCoordinator.steerMessage({
          conversationId: conversation.id,
          content,
          ...(displayText ? { displayText } : {}),
          ...(typeof composerDraft === 'string' ? { composerDraft } : {}),
          attachments,
          browserComments,
          ...(browserCommentContent ? { browserCommentContent } : {}),
          ...(conversationContext ? { conversationContext } : {}),
          expectedTurnId: expectedTurnId!,
          idempotencyKey,
          clientUserMessageId,
          providerWriteLifecycle,
        });
      }
      if (executionBusy) {
        return codexNativeCoordinator.submitMessage({
          conversationId: conversation.id,
          content,
          ...(displayText ? { displayText } : {}),
          ...(typeof composerDraft === 'string' ? { composerDraft } : {}),
          attachments,
          browserComments,
          ...(browserCommentContent ? { browserCommentContent } : {}),
          ...(conversationContext ? { conversationContext } : {}),
          ...(conversationSkill ? { skill: conversationSkill } : {}),
          model: effectiveModel,
          modelSourceId: effectiveModelSourceId,
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          ...(requestedServiceTier.present ? { serviceTier: selectedServiceTier ?? null } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
          idempotencyKey,
          clientUserMessageId,
          providerWriteLifecycle,
          ...(segmentLifecycle ? { segmentLifecycle } : {}),
        });
      }
      if (segmentLifecycle?.requiresNewSegment) {
        if (conversation.taskId) {
          const task = tasks.getById(conversation.taskId);
          if (!task) throw nativeApiError('ZEUS_TASK_NOT_FOUND', 'Conversation task was not found.');
          return codexNativeCoordinator.startTaskConversation({
            conversationId: conversation.id,
            submissionId: `conversation_submission_${createHash('sha256').update(`${stableOperationId}\0codex-segment`).digest('hex').slice(0, 24)}`,
            projectId: conversation.projectId,
            projectLocalPath: executionRoot,
            taskId: task.id,
            ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
            ...(conversation.environmentId ? { environmentId: conversation.environmentId } : {}),
            conversationTitle: conversation.title,
            taskTitle: task.title,
            prompt: content,
            model: effectiveModel,
            modelSourceId: effectiveModelSourceId,
            ...(selectedEffort ? { effort: selectedEffort } : {}),
            ...(requestedServiceTier.present ? { serviceTier: selectedServiceTier ?? null } : {}),
            allowCodeChanges: (permissionMode ?? conversation.permissionMode) !== 'read-only',
            allowTests: (permissionMode ?? conversation.permissionMode) !== 'read-only',
            allowGitCommit: false,
            permissionMode: permissionMode ?? conversation.permissionMode,
            idempotencyKey,
            clientUserMessageId,
            attachments,
            allowedAttachmentRoots: trustedConversationAttachmentRoots,
            workMode: collaborationMode ?? conversation.collaborationMode,
            ...(conversationSkill ? { skill: conversationSkill } : {}),
            applyLegacyTaskGuards: false,
            providerWriteLifecycle,
            segmentLifecycle,
          });
        }
        return codexNativeCoordinator.startProjectConversation({
          conversationId: conversation.id,
          submissionId: `conversation_submission_${createHash('sha256').update(`${stableOperationId}\0codex-segment`).digest('hex').slice(0, 24)}`,
          projectId: conversation.projectId,
          projectLocalPath: executionRoot,
          prompt: content,
          model: effectiveModel,
          modelSourceId: effectiveModelSourceId,
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          ...(requestedServiceTier.present ? { serviceTier: selectedServiceTier ?? null } : {}),
          permissionMode: permissionMode ?? conversation.permissionMode,
          collaborationMode: collaborationMode ?? conversation.collaborationMode,
          idempotencyKey,
          clientUserMessageId,
          attachments,
          ...(conversationSkill ? { skill: conversationSkill } : {}),
          providerWriteLifecycle,
          segmentLifecycle,
        });
      }
      return codexNativeCoordinator.submitMessage({
        conversationId: conversation.id,
        content,
        ...(displayText ? { displayText } : {}),
        ...(typeof composerDraft === 'string' ? { composerDraft } : {}),
        attachments,
        browserComments,
        ...(browserCommentContent ? { browserCommentContent } : {}),
        ...(conversationContext ? { conversationContext } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedModel ? { modelSourceId: selectedModelSourceId } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
        ...(requestedServiceTier.present ? { serviceTier: selectedServiceTier ?? null } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
        idempotencyKey,
        clientUserMessageId,
        providerWriteLifecycle,
        ...(segmentLifecycle ? { segmentLifecycle } : {}),
      });
    })();
    const persisted = conversationSubmissions.getById(nativeOperation.submissionId);
    if (!persisted) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native message submission was not persisted.');
    if (persisted.providerTurnId) {
      db.execute('UPDATE conversation_messages SET metadata_json = ? WHERE conversation_id = ? AND client_message_id = ?', [
        JSON.stringify({
          clientUserMessageId,
          delivery,
          attachments,
          browserComments,
          ...(conversationContext ? { conversationContext } : {}),
          expectedTurnId,
          ...(displayText ? { displayText } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          ...(requestedServiceTier.present ? { serviceTier: selectedServiceTier ?? null } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
        }),
        conversation.id,
        clientUserMessageId,
      ]);
    }
    await db.save();
    const updatedConversation = conversations.getById(conversation.id);
    const updatedSubmission = conversationSubmissions.getById(persisted.id);
    if (!updatedConversation || !updatedSubmission) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native message acceptance was not persisted.');
    await db.save();
    if (delivery === 'queue') {
      publishNativeConversationEvent('conversation.queue.changed', {
        conversationId: updatedConversation.id,
        queue: toNativeQueueApiSnapshot(updatedConversation),
      });
    }
    void nativeOperation;
    return toNativeDurableAcceptance(stableOperationId, idempotencyKey, updatedConversation, updatedSubmission);
  }

  function normalizeNativeConversationAttachments(value: unknown, projectLocalPath: string): NativeConversationAttachment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT', 'attachments must be an array.');
    return value.map((attachment, index) => {
      if (
        !isNativeApiRecord(attachment) ||
        typeof attachment.name !== 'string' ||
        !attachment.name.trim() ||
        typeof attachment.mime !== 'string' ||
        !attachment.mime.trim() ||
        typeof attachment.size !== 'number' ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 0
      ) {
        throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT', `Attachment ${index} must include name, mime, and a non-negative integer size.`);
      }
      const localPath = typeof attachment.localPath === 'string' && attachment.localPath.trim() ? attachment.localPath.trim() : undefined;
      const uploadRef = typeof attachment.uploadRef === 'string' && attachment.uploadRef.trim() ? attachment.uploadRef.trim() : undefined;
      if ((localPath ? 1 : 0) + (uploadRef ? 1 : 0) !== 1) {
        throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT', `Attachment ${index} requires exactly one of localPath or uploadRef.`);
      }
      let canonicalLocalPath: string | undefined;
      let authorizedPath: string | undefined;
      if (uploadRef) {
        const grantedPath = options.conversationAttachmentGrantSecret ? resolveConversationAttachmentGrant(uploadRef, options.conversationAttachmentGrantSecret) : null;
        if (!grantedPath) {
          throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT_GRANT', `Attachment ${index} path grant is invalid or expired.`);
        }
        try {
          canonicalLocalPath = realpathSync(grantedPath);
          const pathStat = statSync(canonicalLocalPath);
          if (canonicalLocalPath !== grantedPath || (!pathStat.isFile() && !pathStat.isDirectory())) {
            throw new Error('Granted attachment path changed or is not a file/directory.');
          }
          authorizedPath = canonicalLocalPath;
        } catch {
          throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT_GRANT', `Attachment ${index} granted path is no longer available.`);
        }
      }
      if (localPath) {
        if (!isAbsolute(localPath)) throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT', `Attachment ${index} localPath must be absolute.`);
        try {
          const projectRealPath = realpathSync(projectLocalPath);
          canonicalLocalPath = realpathSync(localPath);
          const allowedRoots = [projectRealPath, ...trustedConversationAttachmentRoots];
          const pathStat = statSync(canonicalLocalPath);
          if (!allowedRoots.some((root) => isPathInsideProjectRoot(canonicalLocalPath!, root)) || (!pathStat.isFile() && !pathStat.isDirectory())) {
            throw new Error('Attachment path is outside trusted roots or is not a file/directory.');
          }
        } catch {
          throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT', `Attachment ${index} localPath must resolve inside a trusted Zeus attachment root.`);
        }
      }
      return {
        name: attachment.name.trim(),
        mime: attachment.mime.trim(),
        size: attachment.size,
        ...(canonicalLocalPath ? { localPath: canonicalLocalPath } : {}),
        ...(authorizedPath ? { authorizedPath } : {}),
      };
    });
  }

  function normalizeNativeBrowserComments(value: unknown): Record<string, unknown>[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 200) {
      throw nativeApiError('ZEUS_INVALID_BROWSER_COMMENTS', 'browserComments must be an array with no more than 200 entries.');
    }
    value.forEach((comment, index) => {
      const anchor = isNativeApiRecord(comment) && isNativeApiRecord(comment.anchor) ? comment.anchor : null;
      if (
        !isNativeApiRecord(comment) ||
        typeof comment.id !== 'string' ||
        !comment.id.trim() ||
        comment.id.length > 200 ||
        typeof comment.number !== 'number' ||
        !Number.isSafeInteger(comment.number) ||
        comment.number < 1 ||
        typeof comment.body !== 'string' ||
        !comment.body.trim() ||
        comment.body.length > 20_000 ||
        !anchor ||
        typeof anchor.pageUrl !== 'string' ||
        !anchor.pageUrl ||
        anchor.pageUrl.length > 20_000
      ) {
        throw nativeApiError('ZEUS_INVALID_BROWSER_COMMENTS', `Browser comment ${index} has invalid identity, body, page URL, or anchor metadata.`);
      }
    });
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > 1_000_000) {
      throw nativeApiError('ZEUS_INVALID_BROWSER_COMMENTS', 'browserComments must be no larger than 1 MB.');
    }
    return JSON.parse(serialized) as Record<string, unknown>[];
  }

  function normalizeNativeConversationContext(value: unknown): Record<string, unknown> | null {
    if (value === undefined) return null;
    if (!isNativeApiRecord(value) || !Array.isArray(value.responseAnnotations) || !Array.isArray(value.codeComments)) {
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_CONTEXT', 'conversationContext must contain responseAnnotations and codeComments arrays.');
    }
    if (value.responseAnnotations.length > 100 || value.codeComments.length > 200) {
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_CONTEXT', 'conversationContext contains too many annotations or comments.');
    }
    value.responseAnnotations.forEach((entry, index) => {
      const anchor = isNativeApiRecord(entry) && isNativeApiRecord(entry.anchor) ? entry.anchor : null;
      if (
        !isNativeApiRecord(entry) ||
        typeof entry.id !== 'string' ||
        !entry.id.trim() ||
        entry.id.length > 200 ||
        !anchor ||
        typeof anchor.itemId !== 'string' ||
        !anchor.itemId.trim() ||
        typeof anchor.startOffset !== 'number' ||
        !Number.isSafeInteger(anchor.startOffset) ||
        anchor.startOffset < 0 ||
        typeof anchor.endOffset !== 'number' ||
        !Number.isSafeInteger(anchor.endOffset) ||
        anchor.endOffset <= anchor.startOffset ||
        typeof anchor.selectedText !== 'string' ||
        !anchor.selectedText.trim() ||
        anchor.selectedText.length > 20_000 ||
        (entry.note !== undefined && (typeof entry.note !== 'string' || entry.note.length > 20_000))
      ) {
        throw nativeApiError('ZEUS_INVALID_CONVERSATION_CONTEXT', `Response annotation ${index} is invalid.`);
      }
    });
    value.codeComments.forEach((entry, index) => {
      const position = isNativeApiRecord(entry) && isNativeApiRecord(entry.position) ? entry.position : null;
      if (
        !isNativeApiRecord(entry) ||
        typeof entry.id !== 'string' ||
        !entry.id.trim() ||
        entry.id.length > 200 ||
        typeof entry.body !== 'string' ||
        !entry.body.trim() ||
        entry.body.length > 20_000 ||
        !position ||
        typeof position.path !== 'string' ||
        !position.path.trim() ||
        position.path.length > 20_000 ||
        typeof position.line !== 'number' ||
        !Number.isSafeInteger(position.line) ||
        position.line < 1 ||
        (position.side !== 'left' && position.side !== 'right') ||
        (position.startLine !== undefined && (typeof position.startLine !== 'number' || !Number.isSafeInteger(position.startLine) || position.startLine < 1)) ||
        (position.startSide !== undefined && position.startSide !== 'left' && position.startSide !== 'right') ||
        (entry.diffHunk !== undefined && (typeof entry.diffHunk !== 'string' || entry.diffHunk.length > 100_000))
      ) {
        throw nativeApiError('ZEUS_INVALID_CONVERSATION_CONTEXT', `Code comment ${index} is invalid.`);
      }
    });
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > 1_000_000) {
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_CONTEXT', 'conversationContext must be no larger than 1 MB.');
    }
    return JSON.parse(serialized) as Record<string, unknown>;
  }

  function normalizeNativeClientUserMessageId(value: unknown, legacyFallback: string): string {
    if (value === undefined) return legacyFallback;
    if (typeof value !== 'string' || !value.trim() || value.length > 200) {
      throw nativeApiError('ZEUS_INVALID_CLIENT_USER_MESSAGE_ID', 'clientUserMessageId must be a non-empty string no longer than 200 characters.');
    }
    return value;
  }

  function normalizeRequestUserInputAnswerAttachments(
    providerRequest: NonNullable<ReturnType<ConversationServerRequestRepository['getById']>>,
    body: Record<string, unknown>,
    projectLocalPath: string,
  ): {
    groups: Array<{ questionId: string; attachments: NativeConversationAttachment[] }>;
    presentation: Record<string, Array<Record<string, unknown>>>;
  } {
    if (body.answerAttachments === undefined) return { groups: [], presentation: {} };
    if (providerRequest.requestKind !== 'request_user_input' || !isNativeApiRecord(body.answerAttachments)) {
      throw nativeApiError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', 'answerAttachments must be a question-keyed object for request_user_input.');
    }
    const canonical = parseCanonicalRequestUserInputQuestions(parseJsonObject(providerRequest.payloadJson));
    if (!canonical.ok) throw nativeApiError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', canonical.message);
    const questions = new Map(canonical.questions.map((question) => [question.id, question]));
    const groups: Array<{ questionId: string; attachments: NativeConversationAttachment[] }> = [];
    const presentation: Record<string, Array<Record<string, unknown>>> = {};
    let total = 0;
    for (const [questionId, rawAttachments] of Object.entries(body.answerAttachments)) {
      const question = questions.get(questionId);
      if (!question) throw nativeApiError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', `Answer attachments do not belong to canonical question ${questionId}.`);
      if (question.isSecret) throw nativeApiError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', `Sensitive question ${questionId} cannot include attachments.`);
      if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
        throw nativeApiError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', `Answer attachment group ${questionId} must be a non-empty array.`);
      }
      total += rawAttachments.length;
      if (total > 100) throw nativeApiError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', 'A request answer cannot include more than 100 attachments.');
      const normalized = normalizeNativeConversationAttachments(rawAttachments, projectLocalPath);
      groups.push({ questionId, attachments: normalized });
      presentation[questionId] = normalized.map((attachment, index) => {
        const raw = rawAttachments[index] as Record<string, unknown>;
        const kind = raw.kind === 'image' || raw.kind === 'file' || raw.kind === 'directory' || raw.kind === 'pasted_text' ? raw.kind : undefined;
        const source = raw.source === 'picker' || raw.source === 'paste' || raw.source === 'drop' ? raw.source : undefined;
        const characterCount = typeof raw.characterCount === 'number' && Number.isSafeInteger(raw.characterCount) && raw.characterCount >= 0 ? raw.characterCount : undefined;
        const uploadRef = typeof raw.uploadRef === 'string' && raw.uploadRef.trim() ? raw.uploadRef.trim() : undefined;
        return {
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.size,
          ...(kind ? { kind } : {}),
          ...(source ? { source } : {}),
          ...(characterCount !== undefined ? { characterCount } : {}),
          ...(uploadRef ? { uploadRef } : attachment.localPath ? { localPath: attachment.localPath } : {}),
        };
      });
    }
    return { groups, presentation };
  }

  function normalizeNativeServerRequestResponse(requestKind: 'command' | 'file' | 'permissions' | 'request_user_input' | 'mcp', body: Record<string, unknown>): Parameters<typeof codexNativeCoordinator.respondToRequest>[0]['response'] {
    type NativeResponse = Parameters<typeof codexNativeCoordinator.respondToRequest>[0]['response'];
    const commandDecisions = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
    const fileDecisions = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
    if (requestKind === 'command' && body.type === requestKind && typeof body.decision === 'string' && commandDecisions.has(body.decision)) {
      return { type: requestKind, decision: body.decision as 'accept' | 'acceptForSession' | 'decline' | 'cancel' };
    }
    if (requestKind === 'command' && body.type === requestKind && isNativeApiRecord(body.decision) && Object.keys(body.decision).length === 1) {
      const rawAmendment = body.decision.acceptWithExecpolicyAmendment;
      if (
        isNativeApiRecord(rawAmendment) &&
        Object.keys(rawAmendment).length === 1 &&
        Array.isArray(rawAmendment.execpolicy_amendment) &&
        rawAmendment.execpolicy_amendment.length > 0 &&
        rawAmendment.execpolicy_amendment.every((entry) => typeof entry === 'string' && entry.length > 0)
      ) {
        return {
          type: 'command',
          decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: rawAmendment.execpolicy_amendment as string[] } },
        } as Extract<NativeResponse, { type: 'command' }>;
      }
    }
    if (requestKind === 'file' && body.type === requestKind && typeof body.decision === 'string' && fileDecisions.has(body.decision)) {
      return { type: requestKind, decision: body.decision as 'accept' | 'acceptForSession' | 'decline' | 'cancel' };
    }
    if (requestKind === 'permissions' && body.type === 'permissions' && isNativeApiRecord(body.permissions) && (body.scope === 'turn' || body.scope === 'session')) {
      return {
        type: 'permissions',
        permissions: body.permissions as Extract<NativeResponse, { type: 'permissions' }>['permissions'],
        scope: body.scope,
        ...(typeof body.strictAutoReview === 'boolean' ? { strictAutoReview: body.strictAutoReview } : {}),
      };
    }
    if (requestKind === 'request_user_input' && body.type === 'userInput' && isNativeApiRecord(body.answers)) {
      const answers = Object.fromEntries(
        Object.entries(body.answers).map(([questionId, answer]) => {
          if (!isNativeApiRecord(answer) || !Array.isArray(answer.answers) || answer.answers.some((value) => typeof value !== 'string')) {
            throw nativeApiError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', `Invalid answers for user input question ${questionId}.`);
          }
          return [questionId, { answers: answer.answers as string[] }];
        }),
      );
      return { type: 'request_user_input', answers };
    }
    if (requestKind === 'mcp' && body.type === 'MCP' && (body.action === 'accept' || body.action === 'decline' || body.action === 'cancel')) {
      return {
        type: 'mcp',
        action: body.action,
        content: (body.content ?? null) as Extract<NativeResponse, { type: 'mcp' }>['content'],
        _meta: (body._meta ?? null) as Extract<NativeResponse, { type: 'mcp' }>['_meta'],
      };
    }
    throw nativeApiError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', `Response type does not match pending ${requestKind} request.`);
  }

  async function executeProjectConversationIdempotent(project: ZeusProjectRecord, body: StartProjectConversationBody | Record<string, unknown>, idempotencyKey: string, markExternalWriteStarted?: () => void) {
    assertRequestedAgentIsCodex(body);
    const scope = `project-conversation:${project.id}`;
    const requestHash = nativeIdempotencyRequestHash(body);
    const stableOperationId = nativeStableOperationId(scope, idempotencyKey, requestHash);
    const reservation = createTaskConversationAcceptanceReservation(scope, requestHash, stableOperationId, body);
    const resourceId = encodeProjectConversationAcceptanceReservation(reservation);
    return runWithCodexRpcRetryContext({ operationIdentity: idempotencyKey, projectId: project.id }, () =>
      executeIdempotentJson(
        scope,
        idempotencyKey,
        body,
        202,
        async (ownedOperationId, lifecycle) => {
          if (ownedOperationId !== reservation.operationId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Stable operation identity changed while accepting a project conversation.');
          const accepted = await acceptProjectConversation(project, body, idempotencyKey, ownedOperationId, reservation, lifecycle);
          await checkpointInProgressIdempotentResponse(scope, idempotencyKey, 202, accepted);
          return accepted;
        },
        (_ownedOperationId, persistedResourceId) => recoverProjectConversationAcceptance(project, idempotencyKey, reservation, persistedResourceId),
        resourceId,
        markExternalWriteStarted,
      ),
    );
  }

  function encodeProjectConversationAcceptanceReservation(reservation: ProjectConversationAcceptanceReservation): string {
    return `project-acceptance:${Buffer.from(JSON.stringify(reservation), 'utf8').toString('base64url')}`;
  }

  function decodeProjectConversationAcceptanceReservation(value: string | null): ProjectConversationAcceptanceReservation | null {
    if (!value?.startsWith('project-acceptance:')) return null;
    try {
      const decoded: unknown = JSON.parse(Buffer.from(value.slice('project-acceptance:'.length), 'base64url').toString('utf8'));
      if (
        !isNativeApiRecord(decoded) ||
        typeof decoded.scope !== 'string' ||
        typeof decoded.requestHash !== 'string' ||
        typeof decoded.operationId !== 'string' ||
        typeof decoded.conversationId !== 'string' ||
        typeof decoded.submissionId !== 'string'
      ) {
        return null;
      }
      return decoded as unknown as ProjectConversationAcceptanceReservation;
    } catch {
      return null;
    }
  }

  async function acceptProjectConversation(
    project: ZeusProjectRecord,
    body: StartProjectConversationBody | Record<string, unknown>,
    idempotencyKey: string,
    stableOperationId: string,
    reservation: ProjectConversationAcceptanceReservation,
    providerWriteLifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void },
  ) {
    if (!isNativeApiRecord(body) || body.mode !== 'create') throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Project conversations require mode create.');
    if (body.content !== undefined && typeof body.content !== 'string') throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Project conversation content must be a string.');
    const permissionMode = body.permissionMode === undefined ? 'auto' : parseConversationPermissionMode(body.permissionMode);
    if (!permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
    const collaborationMode = body.collaborationMode === undefined ? 'default' : parseConversationCollaborationMode(body.collaborationMode);
    if (!collaborationMode) throw nativeApiError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.');
    const attachments = normalizeNativeConversationAttachments(body.attachments, project.localPath);
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content && attachments.length === 0) {
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Project conversation content or attachments are required.');
    }
    const capabilities = await resolveConversationCapabilities(project);
    const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : capabilities.preferredModel;
    const selectedModel = resolveModelCapability(capabilities.models, requestedModel) ?? capabilities.models[0]!;
    if (selectedModel.available === false) throw nativeApiError('ZEUS_MODEL_NOT_READY', selectedModel.availabilityReason || '所选模型当前不可运行。');
    const requestedEffort = typeof body.effort === 'string' && body.effort.trim() ? body.effort.trim() : null;
    if (requestedEffort && !selectedModel.supportedReasoningEfforts.some((effort) => effort === requestedEffort)) {
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', 'Selected reasoning effort is not supported by the selected Codex model.');
    }
    const requestedServiceTier = readServiceTierOverride(body);
    const serviceTier = normalizeServiceTierForCapability(requestedServiceTier, selectedModel);
    if (selectedModel.agentKind === 'pi') throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', '项目首发当前只接受 Codex App Server 模型。');
    const effectiveEffort = requestedEffort ?? selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? null;
    const goalObjective = parseGoalObjective(body.goalObjective);
    if (goalObjective && (selectedModel.agentKind !== 'codex' || capabilities.goals?.enabled !== true)) {
      throw nativeApiError('ZEUS_CODEX_GOALS_UNAVAILABLE', '当前 Agent 或 app-server 不支持原生目标。');
    }
    const clientUserMessageId = normalizeNativeClientUserMessageId(body.clientUserMessageId, `native-client-${createHash('sha256').update(`${project.id}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`);
    const resourceId = encodeProjectConversationAcceptanceReservation(reservation);
    const reservedLifecycle = {
      markPrepared: (submissionId: string) => {
        if (submissionId !== reservation.submissionId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Prepared submission does not match the reserved project acceptance resource.');
        return providerWriteLifecycle.markPrepared(resourceId);
      },
      markRpcStarted: (submissionId: string) => {
        if (submissionId !== reservation.submissionId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Provider submission does not match the reserved project acceptance resource.');
        return providerWriteLifecycle.markRpcStarted(resourceId);
      },
    };
    const resolvedRoute = await resolveConversationExecutionRoute({
      agentKind: 'codex',
      modelSourceId: selectedModel.sourceId ?? null,
      modelId: selectedModel.model,
      effort: effectiveEffort,
      serviceTier: requestedServiceTier.present ? (serviceTier ?? null) : null,
      permissionMode,
      collaborationMode,
      projectId: project.id,
      taskId: null,
      executionRoot: project.localPath,
    });
    const segmentLifecycle = conversationExecutionCoordinator.createLifecycle({
      conversationId: reservation.conversationId,
      route: resolvedRoute.route,
      targetCapabilities: {
        readableReasoningSummary: true,
        media: resolvedRoute.configuredModel?.capability.imageInput.state !== 'unsupported',
        contextWindow: resolvedRoute.configuredModel?.contextWindow ?? selectedModel.contextWindow,
        currentInputCharacters: content.length + JSON.stringify(attachments).length,
      },
      userHistoryContent: { text: content, ...(attachments.length ? { attachments } : {}) },
    });
    const nativeOperation = await codexNativeCoordinator.startProjectConversation({
      conversationId: reservation.conversationId,
      submissionId: reservation.submissionId,
      projectId: project.id,
      projectLocalPath: project.localPath,
      prompt: content,
      attachments,
      model: selectedModel.model,
      modelSourceId: selectedModel.sourceId ?? null,
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      ...(requestedServiceTier.present ? { serviceTier } : {}),
      permissionMode,
      collaborationMode,
      idempotencyKey,
      clientUserMessageId,
      providerWriteLifecycle: reservedLifecycle,
      segmentLifecycle,
      ...(goalObjective ? { goalObjective } : {}),
    });
    const conversation = conversations.getById(nativeOperation.conversationId);
    const submission = conversationSubmissions.getById(nativeOperation.submissionId);
    if (
      !conversation ||
      !submission ||
      conversation.id !== reservation.conversationId ||
      conversation.projectId !== project.id ||
      conversation.taskId !== null ||
      submission.id !== reservation.submissionId ||
      submission.conversationId !== conversation.id
    ) {
      throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Project conversation acceptance did not persist the exact reserved resources.');
    }
    return toNativeDurableAcceptance(stableOperationId, idempotencyKey, conversation, submission);
  }

  function recoverProjectConversationAcceptance(project: ZeusProjectRecord, idempotencyKey: string, expected: ProjectConversationAcceptanceReservation, persistedResourceId: string | null) {
    const persisted = decodeProjectConversationAcceptanceReservation(persistedResourceId);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(expected)) return undefined;
    const conversation = conversations.getById(persisted.conversationId);
    const submission = conversationSubmissions.getById(persisted.submissionId);
    if (
      !conversation ||
      !submission ||
      conversation.projectId !== project.id ||
      conversation.taskId !== null ||
      submission.conversationId !== conversation.id ||
      submission.idempotencyKey !== idempotencyKey ||
      persisted.scope !== `project-conversation:${project.id}` ||
      persisted.operationId !== expected.operationId ||
      persisted.requestHash !== expected.requestHash
    ) {
      return undefined;
    }
    // acceptance checkpoint 缺失时不能从可变会话快照伪造原响应。
    return undefined;
  }

  async function executeTaskConversationIdempotent(project: ZeusProjectRecord, task: ZeusTaskRecord, body: StartTaskConversationBody | Record<string, unknown>, idempotencyKey: string, markExternalWriteStarted?: () => void) {
    assertRequestedAgentKind(body);
    const scope = `task-conversation:${task.id}`;
    const requestHash = nativeIdempotencyRequestHash(body);
    const stableOperationId = nativeStableOperationId(scope, idempotencyKey, requestHash);
    const reservation = createTaskConversationAcceptanceReservation(scope, requestHash, stableOperationId, body);
    const resourceId = encodeTaskConversationAcceptanceReservation(reservation);
    return runWithCodexRpcRetryContext({ operationIdentity: idempotencyKey, projectId: project.id, taskId: task.id }, () =>
      executeIdempotentJson(
        scope,
        idempotencyKey,
        body,
        202,
        async (ownedOperationId, lifecycle) => {
          if (ownedOperationId !== reservation.operationId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Stable operation identity changed while accepting a task conversation.');
          const accepted = await acceptTaskConversation(project, task, body, idempotencyKey, ownedOperationId, reservation, lifecycle);
          await checkpointInProgressIdempotentResponse(scope, idempotencyKey, 202, accepted);
          return accepted;
        },
        (_ownedOperationId, persistedResourceId) => recoverTaskConversationAcceptance(project, task, idempotencyKey, reservation, persistedResourceId),
        resourceId,
        markExternalWriteStarted,
      ),
    );
  }

  function createTaskConversationAcceptanceReservation(scope: string, requestHash: string, operationId: string, body: unknown): TaskConversationAcceptanceReservation {
    const selectedConversationId = isNativeApiRecord(body) && body.mode === 'resume' && typeof body.conversationId === 'string' && body.conversationId ? body.conversationId : null;
    return {
      scope,
      requestHash,
      operationId,
      conversationId: selectedConversationId ?? `conversation_${createHash('sha256').update(`${operationId}\0conversation`).digest('hex').slice(0, 24)}`,
      submissionId: `conversation_submission_${createHash('sha256').update(`${operationId}\0submission`).digest('hex').slice(0, 24)}`,
    };
  }

  function encodeTaskConversationAcceptanceReservation(reservation: TaskConversationAcceptanceReservation): string {
    return `task-acceptance:${Buffer.from(JSON.stringify(reservation), 'utf8').toString('base64url')}`;
  }

  function decodeTaskConversationAcceptanceReservation(value: string | null): TaskConversationAcceptanceReservation | null {
    if (!value?.startsWith('task-acceptance:')) return null;
    try {
      const decoded: unknown = JSON.parse(Buffer.from(value.slice('task-acceptance:'.length), 'base64url').toString('utf8'));
      if (
        !isNativeApiRecord(decoded) ||
        typeof decoded.scope !== 'string' ||
        typeof decoded.requestHash !== 'string' ||
        typeof decoded.operationId !== 'string' ||
        typeof decoded.conversationId !== 'string' ||
        typeof decoded.submissionId !== 'string'
      ) {
        return null;
      }
      return decoded as unknown as TaskConversationAcceptanceReservation;
    } catch {
      return null;
    }
  }

  async function resolveConversationExecutionRoute(input: {
    agentKind: 'codex' | 'pi';
    modelSourceId: string | null;
    modelId: string;
    effort: string | null;
    serviceTier: string | null;
    permissionMode: ConversationPermissionMode;
    collaborationMode: ConversationCollaborationMode;
    projectId: string;
    taskId: string | null;
    workspaceId?: string | null;
    environmentId?: string | null;
    executionRoot: string;
  }) {
    const connectionId = input.modelSourceId && input.modelSourceId !== 'codex' ? input.modelSourceId : null;
    const connection = connectionId ? await modelConnections.get(connectionId) : undefined;
    if (connectionId && !connection) throw nativeApiError('ZEUS_MODEL_CONNECTION_NOT_FOUND', '目标模型连接已经不存在。');
    const configuredModel = connection?.models.find((model) => model.id === input.modelId);
    if (connection && !configuredModel) throw nativeApiError('ZEUS_MODEL_NOT_READY', '目标模型已经不在连接目录中。');
    const configuredRuntimeKind = configuredModel?.runtimeAdapter === 'codex_app_server' ? 'codex' : configuredModel?.runtimeAdapter === 'pi_sdk' ? 'pi' : null;
    if (configuredRuntimeKind && configuredRuntimeKind !== input.agentKind) {
      throw nativeApiError('ZEUS_CONVERSATION_ROUTE_CHANGED', '目标模型的运行适配器与已选择路由不一致。');
    }
    const route: ConversationExecutionRoute = {
      runtimeKind: input.agentKind,
      connectionId,
      credentialSlotId: connection && configuredModel ? modelConnectionCredentialSlotId(connection.id, configuredModel.authenticationScheme) : 'codex-managed-account',
      endpointIdentity: connection?.baseUrl ?? 'codex://managed-account',
      protocolFamily: configuredModel?.protocolFamily ?? (input.agentKind === 'codex' ? 'openai_responses' : 'openai_completions'),
      modelId: input.modelId,
      effort: input.effort,
      serviceTier: input.serviceTier,
      permissionMode: input.permissionMode,
      collaborationMode: input.collaborationMode,
      workspaceIdentity: {
        projectId: input.projectId,
        taskId: input.taskId,
        workspaceId: input.workspaceId ?? null,
        environmentId: input.environmentId ?? null,
        executionRoot: input.executionRoot,
      },
      providerId: input.agentKind === 'codex' ? 'codex' : `pi:${connectionId ?? 'custom'}`,
      providerModel: connectionId ? modelRef(connectionId, input.modelId) : input.modelId,
      providerProtocolVersion: input.agentKind === 'codex' ? 'app-server' : piRuntimeWorkerProtocolVersion,
      providerBinaryVersion: input.agentKind === 'pi' ? 'pi-sdk-0.83.0' : null,
    };
    return { route, configuredModel };
  }

  /** 专用入口只生成计划；首发可见正文与实际提示词同源，Provider 分流和持久接受生命周期统一在此执行。 */
  async function startNativeTaskConversationFromPlan(plan: NativeTaskConversationStartPlan) {
    const resolvedRoute = await resolveConversationExecutionRoute({
      agentKind: plan.agentKind,
      modelSourceId: plan.model.sourceId,
      modelId: plan.model.modelId,
      effort: plan.effort ?? null,
      serviceTier: plan.serviceTierPresent ? (plan.serviceTier ?? null) : null,
      permissionMode: plan.permissionMode,
      collaborationMode: plan.workMode ?? 'default',
      projectId: plan.projectId,
      taskId: plan.taskId,
      workspaceId: plan.workspaceId,
      environmentId: plan.environmentId,
      executionRoot: plan.cwd,
    });
    const segmentLifecycle = conversationExecutionCoordinator.createLifecycle({
      conversationId: plan.conversationId,
      route: resolvedRoute.route,
      targetCapabilities: {
        readableReasoningSummary: true,
        media: resolvedRoute.configuredModel?.capability.imageInput.state !== 'unsupported',
        contextWindow: resolvedRoute.configuredModel?.contextWindow ?? null,
        currentInputCharacters: plan.prompt.length + JSON.stringify({ attachments: plan.attachments ?? [], taskPushLayout: plan.taskPushLayout ?? null, legacyReference: plan.legacyReference ?? null }).length,
      },
      userHistoryContent: {
        text: plan.prompt,
        ...(plan.attachments?.length ? { attachments: plan.attachments } : {}),
        ...(plan.taskPushLayout ? { taskPushLayout: plan.taskPushLayout } : {}),
        ...(plan.legacyReference ? { legacyReference: plan.legacyReference } : {}),
      },
    });
    if (plan.agentKind === 'pi') {
      const operation = await piNativeCoordinator.startConversation({
        conversationId: plan.conversationId,
        submissionId: plan.submissionId,
        projectId: plan.projectId,
        taskId: plan.taskId,
        taskTitle: plan.taskTitle,
        ...(plan.conversationTitle ? { conversationTitle: plan.conversationTitle } : {}),
        cwd: plan.cwd,
        prompt: plan.prompt,
        model: plan.model,
        ...(plan.effort ? { thinkingLevel: plan.effort } : {}),
        ...(plan.attachments ? { attachments: plan.attachments } : {}),
        ...(plan.allowedAttachmentRoots ? { allowedAttachmentRoots: plan.allowedAttachmentRoots } : {}),
        ...(plan.taskPushLayout ? { taskPushLayout: plan.taskPushLayout } : {}),
        ...(plan.skill ? { skill: plan.skill } : {}),
        ...(plan.holdDispatch ? { holdDispatch: true } : {}),
        ...(plan.operationContext ? { operationContext: plan.operationContext } : {}),
        ...(plan.internalOperation ? { internalOperation: true } : {}),
        permissionMode: plan.permissionMode,
        idempotencyKey: plan.idempotencyKey,
        clientUserMessageId: plan.clientUserMessageId,
        ...(plan.environmentId ? { environmentId: plan.environmentId } : {}),
        ...(plan.workspaceId ? { workspaceId: plan.workspaceId } : {}),
        providerWriteLifecycle: plan.providerWriteLifecycle,
        segmentLifecycle,
      });
      if (plan.deferInitialDispatch) queueMicrotask(() => void dispatchUnifiedConversationQueueHead?.(plan.conversationId).catch(() => undefined));
      return operation;
    }
    const operation = await codexNativeCoordinator.startTaskConversation({
      conversationId: plan.conversationId,
      submissionId: plan.submissionId,
      projectId: plan.projectId,
      projectLocalPath: plan.cwd,
      taskId: plan.taskId,
      ...(plan.environmentId ? { environmentId: plan.environmentId } : {}),
      ...(plan.workspaceId ? { workspaceId: plan.workspaceId } : {}),
      ...(plan.executionWorkspaceMode ? { executionWorkspaceMode: plan.executionWorkspaceMode } : {}),
      writableRoots: plan.writableRoots,
      taskTitle: plan.taskTitle,
      ...(plan.conversationTitle ? { conversationTitle: plan.conversationTitle } : {}),
      prompt: plan.prompt,
      ...(plan.attachments ? { attachments: plan.attachments } : {}),
      ...(plan.allowedAttachmentRoots ? { allowedAttachmentRoots: plan.allowedAttachmentRoots } : {}),
      ...(plan.taskPushLayout ? { taskPushLayout: plan.taskPushLayout } : {}),
      model: plan.model.modelId,
      ...(plan.skill ? { skill: plan.skill } : {}),
      modelSourceId: plan.model.sourceId,
      ...(plan.effort ? { effort: plan.effort } : {}),
      ...(plan.serviceTierPresent ? { serviceTier: plan.serviceTier ?? null } : {}),
      allowCodeChanges: plan.allowCodeChanges,
      allowTests: plan.allowTests,
      allowGitCommit: plan.allowGitCommit,
      permissionMode: plan.permissionMode,
      ...(plan.workMode ? { workMode: plan.workMode } : {}),
      applyLegacyTaskGuards: false,
      ...(plan.deferInitialDispatch ? { deferInitialDispatch: true } : {}),
      ...(plan.holdDispatch ? { holdDispatch: true } : {}),
      ...(plan.operationContext ? { operationContext: plan.operationContext } : {}),
      ...(plan.internalOperation ? { internalOperation: true } : {}),
      idempotencyKey: plan.idempotencyKey,
      clientUserMessageId: plan.clientUserMessageId,
      ...(plan.legacyReference ? { legacyReference: plan.legacyReference } : {}),
      providerWriteLifecycle: plan.providerWriteLifecycle,
      ...(plan.goalObjective ? { goalObjective: plan.goalObjective } : {}),
      segmentLifecycle,
    });
    if (plan.deferInitialDispatch) queueMicrotask(() => void dispatchUnifiedConversationQueueHead?.(plan.conversationId).catch(() => undefined));
    return operation;
  }

  function requestedTaskStage(body: Record<string, unknown>, task: ZeusTaskRecord, allowedKinds: readonly ZeusTaskStageRecord['kind'][]): ZeusTaskStageRecord | null {
    if (body.stageId === undefined) return null;
    if (typeof body.stageId !== 'string' || !body.stageId.trim()) throw nativeApiError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', 'stageId must be a non-empty string.');
    const stage = taskStages.getStage(body.stageId.trim());
    if (!stage || stage.taskId !== task.id) throw nativeApiError('ZEUS_TASK_STAGE_NOT_FOUND', 'The requested stage does not belong to this task.');
    if (!allowedKinds.includes(stage.kind)) throw nativeApiError('ZEUS_TASK_STAGE_SOURCE_MISMATCH', `Stage ${stage.stageKey} cannot start from this conversation source.`);
    return stage;
  }

  function assertTaskStageExecutionMatches(
    stage: ZeusTaskStageRecord,
    input: {
      agentKind: 'codex' | 'pi';
      modelRef: string;
      effort: string | null;
      serviceTier: string | null;
      workMode: ConversationCollaborationMode;
      permissionMode: ConversationPermissionMode;
    },
  ): void {
    const matches =
      stage.agentKind === input.agentKind &&
      stage.modelRef === input.modelRef &&
      stage.effort === input.effort &&
      stage.serviceTier === input.serviceTier &&
      stage.workMode === input.workMode &&
      stage.permissionMode === input.permissionMode;
    if (!matches) throw nativeApiError('ZEUS_TASK_STAGE_CONFIGURATION_MISMATCH', 'The selected model, effort, service tier, work mode, or permission no longer matches the frozen stage configuration.');
  }

  function taskStageHandoffText(stage: ZeusTaskStageRecord): string {
    const acceptedInputs = taskStages.acceptedInputDeliverables(stage);
    const sections = acceptedInputs.map((deliverable) => {
      try {
        const stored = artifactStore.readAuthorizedSync({
          sha256: deliverable.artifactSha256,
          owner: { kind: 'task_stage_deliverable', id: deliverable.id },
          maximumContentBytes: 16 * 1024 * 1024,
        });
        const content = Buffer.from(stored.bytes).toString('utf8');
        const boundedContent = content.length <= 60_000 ? content : `${content.slice(0, 60_000)}\n\n[交接输入已在 60000 字符处截断；完整版本仍保存在交付物 ${deliverable.id} 中。]`;
        return `### ${deliverable.title}（版本 ${deliverable.version}）\n\n交付物 ID：${deliverable.id}\n内容 SHA-256：${deliverable.contentSha256}\n\n${boundedContent}`;
      } catch (error) {
        const redacted = redactSensitiveText(error instanceof Error ? error.message : '交付物正文读取失败');
        throw nativeApiError('ZEUS_TASK_STAGE_INPUT_UNAVAILABLE', `已验收上游交付物 ${deliverable.id} 无法完整读取，阶段启动已停止：${redacted.text}`);
      }
    });
    const outputContract = parseJsonObject(stage.outputContractJson);
    return [
      `## 当前任务阶段：${stage.title}`,
      stage.description,
      `阶段类型：${stage.kind}`,
      `阶段指令：\n${stage.prompt || '按任务要求完成本阶段。'}`,
      `交付物契约：\n\`\`\`json\n${JSON.stringify(outputContract, null, 2)}\n\`\`\``,
      sections.length > 0 ? `## 已验收的上游阶段交付物\n\n${sections.join('\n\n')}` : '## 已验收的上游阶段交付物\n\n无；这是首个阶段。',
      '完成后请在最终回复中给出可独立阅读、可沉淀为 Markdown 的正式阶段交付物。不要输出隐藏推理或思维链。',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  function validateReviewStageSource(stage: ZeusTaskStageRecord, inheritConversationId: string): void {
    const workflow = taskStages.getWorkflowByTask(stage.taskId);
    const implementation = workflow?.stages.filter((candidate) => candidate.sequence < stage.sequence && candidate.kind === 'implementation').sort((left, right) => right.sequence - left.sequence)[0];
    const accepted = implementation?.deliverables.filter((deliverable) => deliverable.status === 'accepted').sort((left, right) => right.version - left.version)[0];
    const sourceAttempt = accepted ? implementation?.attempts.find((attempt) => attempt.id === accepted.attemptId) : null;
    if (!sourceAttempt?.conversationId || sourceAttempt.conversationId !== inheritConversationId) {
      throw nativeApiError('ZEUS_TASK_STAGE_CONVERSATION_CONFLICT', 'Code review must inherit the exact conversation that produced the accepted implementation deliverable.');
    }
  }

  async function startTaskStageConversation(stage: ZeusTaskStageRecord | null, plan: NativeTaskConversationStartPlan, input: { operationIdentity: string; modelRef: string }) {
    if (!stage) return startNativeTaskConversationFromPlan(plan);
    const actual = {
      agentKind: plan.agentKind,
      modelRef: input.modelRef,
      effort: plan.effort ?? null,
      serviceTier: plan.serviceTierPresent ? (plan.serviceTier ?? null) : null,
      workMode: plan.workMode ?? 'default',
      permissionMode: plan.permissionMode,
    };
    assertTaskStageExecutionMatches(stage, actual);
    const acceptedInputs = taskStages.acceptedInputDeliverables(stage);
    const attempt = taskStages.prepareAttempt({
      stageId: stage.id,
      operationIdentity: input.operationIdentity,
      sourceSnapshot: {
        stageRevision: stage.revision,
        inputDeliverables: acceptedInputs.map((deliverable) => ({ id: deliverable.id, version: deliverable.version, contentSha256: deliverable.contentSha256 })),
      },
    });
    await db.save();
    let rpcStarted = false;
    try {
      const nativeOperation = await startNativeTaskConversationFromPlan({
        ...plan,
        providerWriteLifecycle: {
          markPrepared: plan.providerWriteLifecycle.markPrepared,
          markRpcStarted: (submissionId) => {
            rpcStarted = true;
            plan.providerWriteLifecycle.markRpcStarted(submissionId);
          },
        },
      });
      const conversation = conversations.getById(nativeOperation.conversationId);
      const submission = conversationSubmissions.getById(nativeOperation.submissionId);
      taskStages.bindAttempt({
        attemptId: attempt.id,
        conversationId: nativeOperation.conversationId,
        submissionId: nativeOperation.submissionId,
        segmentId: submission?.segmentId ?? null,
        workspaceId: conversation?.workspaceId ?? plan.workspaceId ?? null,
        environmentId: conversation?.environmentId ?? plan.environmentId ?? null,
        ...actual,
      });
      recordTaskEvent({
        taskId: stage.taskId,
        eventType: 'task.stage.attempt.started',
        title: `阶段已启动：${stage.title}`,
        payload: {
          stageId: stage.id,
          attemptId: attempt.id,
          attemptNumber: attempt.attemptNumber,
          conversationId: nativeOperation.conversationId,
          submissionId: nativeOperation.submissionId,
          agentKind: actual.agentKind,
          modelRef: actual.modelRef,
          effort: actual.effort,
          serviceTier: actual.serviceTier,
          workMode: actual.workMode,
          permissionMode: actual.permissionMode,
          inputDeliverableIds: acceptedInputs.map((deliverable) => deliverable.id),
        },
      });
      await db.save();
      return nativeOperation;
    } catch (error) {
      const redacted = redactSensitiveText(error instanceof Error ? error.message : 'Task stage conversation start failed.');
      taskStages.failAttempt(attempt.id, { outcomeUnknown: rpcStarted, error: { message: redacted.text, redacted: redacted.redacted } });
      recordTaskEvent({
        taskId: stage.taskId,
        eventType: rpcStarted ? 'task.stage.attempt.outcome_unknown' : 'task.stage.attempt.failed',
        title: rpcStarted ? `阶段启动结果未知：${stage.title}` : `阶段启动失败：${stage.title}`,
        payload: { stageId: stage.id, attemptId: attempt.id, message: redacted.text },
      });
      await db.save();
      throw error;
    }
  }

  async function acceptTaskConversation(
    project: ZeusProjectRecord,
    task: ZeusTaskRecord,
    body: StartTaskConversationBody | Record<string, unknown>,
    idempotencyKey: string,
    stableOperationId: string,
    reservation: TaskConversationAcceptanceReservation,
    providerWriteLifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void },
  ) {
    const history = conversationChoiceQueries.listTaskHistory(task.id, project.id);
    if (!isNativeApiRecord(body) || typeof body.mode !== 'string') {
      if (history.length > 0) throw nativeApiError('ZEUS_CONVERSATION_CHOICE_REQUIRED', 'Existing task conversations require an explicit create, resume, or reference_legacy choice.');
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Conversation mode is required.');
    }
    if (body.mode !== 'create' && (body as Record<string, unknown>).stageId !== undefined) throw nativeApiError('ZEUS_TASK_STAGE_SOURCE_MISMATCH', 'Only a newly created independent conversation can be bound to a task stage attempt.');

    const clientUserMessageId = normalizeNativeClientUserMessageId(body.clientUserMessageId, `native-client-${createHash('sha256').update(`${task.id}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`);
    const resourceId = encodeTaskConversationAcceptanceReservation(reservation);
    const reservedLifecycle = {
      markPrepared: (submissionId: string) => {
        if (submissionId !== reservation.submissionId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Prepared submission does not match the reserved task acceptance resource.');
        return providerWriteLifecycle.markPrepared(resourceId);
      },
      markRpcStarted: (submissionId: string) => {
        if (submissionId !== reservation.submissionId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Provider submission does not match the reserved task acceptance resource.');
        return providerWriteLifecycle.markRpcStarted(resourceId);
      },
    };
    let nativeOperation: { conversationId: string; submissionId: string; providerThreadId: string | null; providerTurnId: string | null; status: string };
    if (body.mode === 'create') {
      if (body.source !== undefined && body.source !== 'task_push' && body.source !== 'code_review' && body.source !== 'conflict_resolution') {
        throw nativeApiError('ZEUS_UNSUPPORTED_CONVERSATION_SOURCE', 'The current execution service does not support this conversation source.');
      }
      if (body.stageId !== undefined && body.source !== 'task_push' && body.source !== 'code_review') {
        throw nativeApiError('ZEUS_TASK_STAGE_SOURCE_MISMATCH', 'A task stage can only start through task_push or code_review.');
      }
      if (body.source === 'task_push') {
        if (body.content !== undefined || body.attachments !== undefined) {
          throw nativeApiError('ZEUS_INVALID_TASK_PUSH', 'Task push content and attachments are assembled by the server from the canonical task record.');
        }
        const modelName = typeof body.model === 'string' ? body.model.trim() : '';
        const effort = typeof body.effort === 'string' ? body.effort.trim() : '';
        const workMode = body.workMode === 'plan' || body.workMode === 'default' ? body.workMode : null;
        const supplementalInfo = typeof body.supplementalInfo === 'string' ? body.supplementalInfo.trim() : '';
        const taskStage = requestedTaskStage(body, task, ['plan', 'implementation']);
        if (!modelName) throw nativeApiError('ZEUS_INVALID_TASK_PUSH', 'Task push model is required.');
        if (!workMode) throw nativeApiError('ZEUS_INVALID_TASK_PUSH', 'Task push workMode must be default or plan.');
        if (supplementalInfo.length > 20_000) throw nativeApiError('ZEUS_INVALID_TASK_PUSH', 'Task push supplementalInfo must be no longer than 20000 characters.');
        const permissionMode = body.permissionMode === undefined ? 'read-only' : parseConversationPermissionMode(body.permissionMode);
        if (!permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
        // 提交阶段只需要复验模型、账户和附件能力；仓库发现与远端刷新由
        // resolveTaskPushEnvironment 在冻结工作区引用时统一完成，不能在这里重复执行。
        const capabilities = await resolveTaskPushExecutionCapabilities(project);
        const selectedModel = resolveModelCapability(capabilities.models, modelName);
        if (!selectedModel) throw nativeApiError('ZEUS_CODEX_MODEL_UNAVAILABLE', `Configured Codex model is unavailable: ${modelName}`);
        if (selectedModel.available === false) throw nativeApiError('ZEUS_MODEL_NOT_READY', selectedModel.availabilityReason || '所选模型当前不可运行。');
        const requestedServiceTier = readServiceTierOverride(body);
        const serviceTier = normalizeServiceTierForCapability(requestedServiceTier, selectedModel);
        const selectedEffort = taskStage ? effort || taskStage.effort || '' : effort || selectedModel.defaultReasoningEffort || selectedModel.supportedReasoningEfforts[0] || '';
        if (selectedEffort && !selectedModel.supportedReasoningEfforts.some((candidate) => candidate === selectedEffort)) {
          throw nativeApiError('ZEUS_CODEX_EFFORT_UNAVAILABLE', `Configured Codex effort is unavailable: ${selectedEffort}`);
        }
        if (!isNativeApiRecord(body.workspace) || (body.workspace.mode !== 'create' && body.workspace.mode !== 'existing' && body.workspace.mode !== 'direct')) {
          throw nativeApiError('ZEUS_TASK_PUSH_WORKSPACE_MODE_REQUIRED', 'Choose the project directory or a worktree for this task push.');
        }
        const directWorkspace = body.workspace.mode === 'direct';
        const activeDirectWrites = directWorkspace && permissionMode !== 'read-only' ? countDirectProjectActiveWritableConversations(project.id) : 0;
        if (activeDirectWrites > 0 && body.workspace.confirmConcurrentWrites !== true) {
          throw nativeApiError('ZEUS_DIRECT_WORKSPACE_CONCURRENCY_CONFIRMATION_REQUIRED', `${activeDirectWrites} writable conversation(s) already use this project directory. Confirm concurrent writes before continuing.`);
        }
        const taskContextInput = resolveSelectedTaskPushContext(project, task, (body as Record<string, unknown>).taskContext) as {
          attachmentInput: { attachments: NativeConversationAttachment[]; allowedRoots: string[] };
          currentConversationPaths: string[];
          parentContexts: TaskPushPromptParentContext[];
          relatedContexts: TaskPushPromptRelatedContext[];
        };
        const currentAttachmentInput = normalizeTaskPushAttachments(task, project.localPath);
        const supplementalAttachmentInput = normalizeTaskPushSupplementalAttachments(body.supplementalAttachments, project.localPath);
        const attachmentInput = mergeTaskPushAttachmentInputs(currentAttachmentInput, taskContextInput.attachmentInput, supplementalAttachmentInput);
        const includedAttachmentKeys = new Set(attachmentInput.attachments.flatMap((attachment) => (attachment.taskPushAttachmentKey ? [attachment.taskPushAttachmentKey] : [])));
        const filterContextAttachments = <T extends TaskPushPromptParentContext | TaskPushPromptRelatedContext>(contexts: T[]): T[] =>
          contexts.map((context) => ({ ...context, attachments: context.attachments?.filter((attachment) => includedAttachmentKeys.has(attachment.key)) ?? [] }));
        const stageSupplementalInfo = taskStage ? [taskStageHandoffText(taskStage), supplementalInfo].filter(Boolean).join('\n\n## 本次补充信息\n\n') : supplementalInfo;
        const taskPushLayout = buildTaskPushLayoutForTask(
          task,
          stageSupplementalInfo,
          currentAttachmentInput.promptAttachments.filter((attachment) => includedAttachmentKeys.has(attachment.key)),
          taskContextInput.currentConversationPaths,
          filterContextAttachments(taskContextInput.parentContexts),
          filterContextAttachments(taskContextInput.relatedContexts),
          supplementalAttachmentInput.promptAttachments.filter((attachment) => includedAttachmentKeys.has(attachment.key)),
        );
        const taskPushAttachmentKeys = new Set([...taskPushLayout.blocks.flatMap((block) => block.attachments.map((attachment) => attachment.key)), ...(taskPushLayout.supplementalAttachments ?? []).map((attachment) => attachment.key)]);
        const taskPushAttachments = attachmentInput.attachments.filter((attachment) => attachment.taskPushAttachmentKey && taskPushAttachmentKeys.has(attachment.taskPushAttachmentKey));
        const taskPushPrompt = renderTaskPushLayoutText(taskPushLayout);
        if (selectedModel.agentKind !== 'pi') await assertCodexAccountReady(selectedModel.sourceId ?? null, selectedModel.model);
        // 先在用户实际选择 Skill 的项目目录复验身份，避免失效选择在创建 Worktree 后才失败；
        // Worktree 就绪后再按相同稳定 ID 解析一次，确保 repo Skill 使用该工作目录中的真实文件。
        const projectSkill = await resolveWorkflowSkill(body.skillId, project.localPath);
        const taskEnvironment = directWorkspace ? null : await resolveTaskPushEnvironment(project, task, body.workspace, stableOperationId);
        const executionCwd = taskEnvironment?.cwd ?? project.localPath;
        const skill = taskEnvironment && projectSkill ? await resolveWorkflowSkill(projectSkill.id, executionCwd) : projectSkill;
        moveTaskToPushedManagementStatus(task.id);
        await db.save();
        nativeOperation = await startTaskStageConversation(
          taskStage,
          {
            agentKind: selectedModel.agentKind === 'pi' ? 'pi' : 'codex',
            conversationId: reservation.conversationId,
            submissionId: reservation.submissionId,
            projectId: project.id,
            taskId: task.id,
            taskTitle: task.title,
            ...(taskStage ? { conversationTitle: `${taskStage.title}：${task.title}` } : {}),
            cwd: executionCwd,
            prompt: taskPushPrompt,
            taskPushLayout,
            model: { sourceId: selectedModel.sourceId ?? null, modelId: selectedModel.model, displayName: selectedModel.displayName ?? null },
            ...(selectedEffort ? { effort: selectedEffort } : {}),
            serviceTier,
            serviceTierPresent: requestedServiceTier.present,
            permissionMode,
            workMode,
            ...(taskEnvironment
              ? {
                  environmentId: taskEnvironment.environment.id,
                  ...(taskEnvironment.workspaces[0] ? { workspaceId: taskEnvironment.workspaces[0].id } : {}),
                }
              : {}),
            executionWorkspaceMode: directWorkspace ? 'direct' : 'worktree',
            writableRoots: taskEnvironment?.writableRoots ?? [project.localPath],
            allowCodeChanges: false,
            allowTests: false,
            allowGitCommit: false,
            attachments: taskPushAttachments,
            allowedAttachmentRoots: attachmentInput.allowedRoots,
            idempotencyKey,
            clientUserMessageId,
            providerWriteLifecycle: reservedLifecycle,
            ...(skill ? { skill } : {}),
          },
          { operationIdentity: stableOperationId, modelRef: modelName },
        );
      } else if (body.source === 'code_review') {
        if (body.attachments !== undefined) throw nativeApiError('ZEUS_INVALID_CODE_REVIEW', 'Code review attachments are not accepted; the server reviews the persisted workspace directly.');
        if (body.collaborationMode !== undefined && body.collaborationMode !== 'default') {
          throw nativeApiError('ZEUS_INVALID_CODE_REVIEW', 'Code review collaborationMode must be default.');
        }
        const inheritConversationId = typeof body.inheritConversationId === 'string' ? body.inheritConversationId.trim() : '';
        const modelName = typeof body.model === 'string' ? body.model.trim() : '';
        const effort = typeof body.effort === 'string' ? body.effort.trim() : '';
        const taskStage = requestedTaskStage(body, task, ['code_review']);
        if (!inheritConversationId) throw nativeApiError('ZEUS_TASK_EXECUTION_CONTEXT_REQUIRED', 'Code review requires a source conversation with a persisted execution workspace.');
        if (!modelName) throw nativeApiError('ZEUS_INVALID_CODE_REVIEW', 'Code review model is required.');

        const sourceConversation = conversations.getById(inheritConversationId);
        if (!sourceConversation || sourceConversation.projectId !== project.id || sourceConversation.taskId !== task.id) {
          throw nativeApiError('ZEUS_TASK_EXECUTION_CONTEXT_INVALID', 'The code review source conversation does not belong to this task.');
        }
        if (!sourceConversation.workspaceId || !sourceConversation.environmentId) {
          throw nativeApiError('ZEUS_TASK_EXECUTION_CONTEXT_REQUIRED', 'The code review source conversation has no exact persisted task environment and repository workspace.');
        }
        const sourceWorkspace = taskWorkspaces.getById(sourceConversation.workspaceId);
        if (!sourceWorkspace || sourceWorkspace.projectId !== project.id || sourceWorkspace.taskId !== task.id || sourceWorkspace.environmentId !== sourceConversation.environmentId) {
          throw nativeApiError('ZEUS_TASK_EXECUTION_CONTEXT_INVALID', 'The code review repository workspace is not part of the source conversation environment.');
        }
        if (taskStage) validateReviewStageSource(taskStage, inheritConversationId);

        const permissionMode = body.permissionMode === undefined ? 'read-only' : parseConversationPermissionMode(body.permissionMode);
        if (!permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
        if (permissionMode !== 'read-only') {
          throw nativeApiError('ZEUS_CODE_REVIEW_PERMISSION_MISMATCH', 'Code review permission is fixed to read-only.');
        }

        const capabilities = await resolveConversationCapabilities(project);
        const selectedModel = resolveModelCapability(capabilities.models, modelName);
        if (!selectedModel) throw nativeApiError('ZEUS_MODEL_UNAVAILABLE', `Configured review model is unavailable: ${modelName}`);
        if (selectedModel.available === false) throw nativeApiError('ZEUS_MODEL_NOT_READY', selectedModel.availabilityReason || '所选模型当前不可运行。');
        const selectedAgentKind = selectedModel.agentKind === 'pi' ? 'pi' : 'codex';
        if (body.agentKind !== undefined && body.agentKind !== selectedAgentKind) {
          throw nativeApiError('ZEUS_INVALID_AGENT_KIND', 'The requested review agent does not match the selected model.');
        }
        const selectedEffort = taskStage ? effort || taskStage.effort || '' : effort || selectedModel.defaultReasoningEffort || selectedModel.supportedReasoningEfforts[0] || '';
        if (selectedEffort && !selectedModel.supportedReasoningEfforts.some((candidate) => candidate === selectedEffort)) {
          throw nativeApiError('ZEUS_CODEX_EFFORT_UNAVAILABLE', `Configured review effort is unavailable: ${selectedEffort}`);
        }
        const requestedServiceTier = readServiceTierOverride(body);
        const serviceTier = normalizeServiceTierForCapability(requestedServiceTier, selectedModel);
        const projectSkill = await resolveWorkflowSkill(body.skillId, project.localPath);
        const inheritedEnvironment = await resolveTaskPushEnvironment(project, task, { mode: 'existing', environmentId: sourceConversation.environmentId }, stableOperationId);
        const reviewWorkspace = inheritedEnvironment.workspaces.find((workspace: ZeusTaskWorkspaceRecord) => workspace.id === sourceWorkspace.id);
        if (!reviewWorkspace) throw nativeApiError('ZEUS_TASK_EXECUTION_CONTEXT_INVALID', 'The exact review repository could not be restored in the source environment.');
        const reviewCwd = reviewWorkspace.worktreePath?.trim();
        if (!reviewCwd || !existsSync(reviewCwd)) throw nativeApiError('ZEUS_TASK_EXECUTION_CONTEXT_REQUIRED', 'The exact code review worktree is unavailable.');
        const prompt = taskStage ? `${taskStageHandoffText(taskStage)}\n\n${createTaskCodeReviewPrompt(task, reviewWorkspace)}` : createTaskCodeReviewPrompt(task, reviewWorkspace);
        const skill = projectSkill ? await resolveWorkflowSkill(projectSkill.id, reviewCwd) : undefined;
        if (selectedAgentKind === 'codex') await assertCodexAccountReady(selectedModel.sourceId ?? null, selectedModel.model);

        nativeOperation = await startTaskStageConversation(
          taskStage,
          {
            agentKind: selectedAgentKind,
            conversationId: reservation.conversationId,
            submissionId: reservation.submissionId,
            projectId: project.id,
            taskId: task.id,
            taskTitle: task.title,
            conversationTitle: taskStage ? `${taskStage.title}：${task.title}` : `代码审查：${task.title}`,
            cwd: reviewCwd,
            prompt,
            model: { sourceId: selectedModel.sourceId ?? null, modelId: selectedModel.model, displayName: selectedModel.displayName ?? null },
            ...(selectedEffort ? { effort: selectedEffort } : {}),
            serviceTier,
            serviceTierPresent: requestedServiceTier.present,
            permissionMode,
            workMode: 'default',
            environmentId: inheritedEnvironment.environment.id,
            workspaceId: reviewWorkspace.id,
            executionWorkspaceMode: 'worktree',
            writableRoots: [],
            allowCodeChanges: false,
            allowTests: false,
            allowGitCommit: false,
            // 本地接纳和阶段尝试绑定完成后立即切入审查会话；首次 Provider 派发由统一队列异步执行。
            deferInitialDispatch: true,
            idempotencyKey,
            clientUserMessageId,
            providerWriteLifecycle: reservedLifecycle,
            ...(skill ? { skill } : {}),
          },
          { operationIdentity: stableOperationId, modelRef: modelName },
        );
      } else if (body.source === 'conflict_resolution') {
        const integrationId = typeof body.integrationId === 'string' ? body.integrationId.trim() : '';
        const conflictPath = typeof body.conflictPath === 'string' ? body.conflictPath.trim() : '';
        const conflictContent = typeof body.conflictContent === 'string' ? body.conflictContent : null;
        const conflictFingerprintValue = (body as Record<string, unknown>).conflictFingerprint;
        const conflictFingerprint = typeof conflictFingerprintValue === 'string' ? conflictFingerprintValue.trim() : '';
        if (!integrationId || !conflictPath || conflictContent === null || !conflictFingerprint) {
          throw nativeApiError('ZEUS_INVALID_CONFLICT_AI_START', 'Conflict resolution requires integrationId, conflictPath, conflictContent, and conflictFingerprint.');
        }
        if (conflictContent.length > 2_000_000) throw nativeApiError('ZEUS_TASK_CONFLICT_TOO_LARGE', '当前冲突草稿过大，无法交给 AI 处理。');
        const resolved = resolveTaskIntegrationRequest(task.id, integrationId);
        if ('error' in resolved) throw nativeApiError(resolved.error.error, resolved.error.message);
        if (resolved.project.id !== project.id || resolved.integration.state !== 'conflicted' || !resolved.integration.conflictFiles.includes(conflictPath)) {
          throw nativeApiError('ZEUS_TASK_INTEGRATION_NOT_CONFLICTED', '当前合入没有这项待 AI 处理的冲突。');
        }
        const permissionMode = parseConversationPermissionMode(body.permissionMode);
        if (!permissionMode || permissionMode === 'read-only') {
          throw nativeApiError('ZEUS_CONFLICT_AI_WRITE_PERMISSION_REQUIRED', '冲突处理需要修改并暂存隔离合并工作区，请选择自动或完全访问。');
        }
        if (!resolved.integration.taskHeadSha) throw nativeApiError('ZEUS_TASK_HEAD_CHANGED', 'The integration does not contain a frozen task HEAD. Rebuild it before starting AI conflict resolution.');

        const modelConversation = conversations
          .listByTask(task.id)
          .filter((conversation) => (conversation.agentKind === 'codex' || conversation.agentKind === 'pi') && Boolean(conversation.modelId ?? conversation.providerModel))
          .sort((left, right) => Number(right.workspaceId === resolved.workspace.id) - Number(left.workspaceId === resolved.workspace.id))[0];
        if (!modelConversation || (modelConversation.agentKind !== 'codex' && modelConversation.agentKind !== 'pi')) {
          throw nativeApiError('ZEUS_CONFLICT_AI_MODEL_SELECTION_REQUIRED', '这条任务开发线没有可沿用的 AI 模型，请先选择模型。');
        }
        const modelId = modelConversation.modelId ?? modelConversation.providerModel;
        if (!modelId) throw nativeApiError('ZEUS_CONFLICT_AI_MODEL_SELECTION_REQUIRED', '这条任务开发线没有可沿用的 AI 模型，请先选择模型。');
        const settings = conversations.getNextTurnSettings(modelConversation.id);
        const attemptId = `task_integration_attempt_${createHash('sha256').update(`${stableOperationId}\0${integrationId}`).digest('hex').slice(0, 20)}`;
        const repositoryPath = resolved.workspace.repositoryPath || project.localPath;
        const conflictWorkspaceId = `task_workspace_${createHash('sha256').update(`${stableOperationId}\0conflict-workspace`).digest('hex').slice(0, 24)}`;
        let conflictWorkspace = taskWorkspaces.getById(conflictWorkspaceId);
        if (conflictWorkspace) {
          if (conflictWorkspace.kind !== 'conflict' || conflictWorkspace.baseWorkspaceId !== resolved.workspace.id) {
            throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'The persisted conflict workspace does not match the reserved operation.');
          }
        } else {
          const repository = await getGitRepositoryContext(repositoryPath);
          if (!repository.isRepository) throw nativeApiError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The task repository is unavailable.');
          const baseName = `${resolved.workspace.branchName}-merge`;
          const usedBranchNames = new Set([
            ...repository.localBranches,
            ...taskWorkspaces
              .listByTask(task.id)
              .filter((candidate) => candidate.repositoryPath === resolved.workspace.repositoryPath)
              .map((candidate) => candidate.branchName),
          ]);
          let conflictBranch = baseName;
          for (let suffix = 2; usedBranchNames.has(conflictBranch); suffix += 1) conflictBranch = `${baseName}-${suffix}`;
          const sourceHeadSha = (await getGitBranchHead(repositoryPath, resolved.integration.targetBranch).catch(() => null)) ?? resolved.integration.targetHeadSha;
          conflictWorkspace = taskWorkspaces.create({
            id: conflictWorkspaceId,
            projectId: project.id,
            taskId: task.id,
            kind: 'conflict',
            baseWorkspaceId: resolved.workspace.id,
            ...(resolved.workspace.repositoryId ? { repositoryId: resolved.workspace.repositoryId } : {}),
            repositoryName: resolved.workspace.repositoryName,
            repositoryRelativePath: resolved.workspace.repositoryRelativePath,
            repositoryPath: resolved.workspace.repositoryPath,
            branchName: conflictBranch,
            sourceBranch: resolved.integration.targetBranch,
            sourceHeadSha,
            remoteName: resolved.workspace.remoteName,
            remoteBranch: conflictBranch,
            state: 'ready',
          });
        }
        const existingAttempt = taskIntegrationAttempts.getById(attemptId);
        if (existingAttempt) {
          if (existingAttempt.integrationId !== integrationId || existingAttempt.conversationId !== reservation.conversationId || existingAttempt.submissionId !== reservation.submissionId) {
            throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'The persisted conflict attempt does not match the reserved conversation resources.');
          }
        }
        const conflictCommitMessage = `${task.taskCode}: 合入 ${resolved.workspace.branchName}`;
        const prompt = buildTaskConflictAiPrompt({
          sourceBranch: resolved.integration.targetBranch,
          taskBranch: resolved.workspace.branchName,
          conflictBranch: conflictWorkspace.branchName,
          mode: resolved.integration.mode,
          commitMessage: conflictCommitMessage,
        });
        const selectedAgentKind = modelConversation.agentKind;
        const skill = await resolveWorkflowSkill(body.skillId, project.localPath);
        if (selectedAgentKind === 'codex') await assertCodexAccountReady(modelConversation.modelSourceId, modelId);
        nativeOperation = await startNativeTaskConversationFromPlan({
          agentKind: selectedAgentKind,
          conversationId: reservation.conversationId,
          submissionId: reservation.submissionId,
          projectId: project.id,
          taskId: task.id,
          taskTitle: task.title,
          conversationTitle: buildTaskConflictAiConversationTitle({ taskTitle: task.title }),
          cwd: repositoryPath,
          prompt,
          model: { sourceId: modelConversation.modelSourceId, modelId, displayName: null },
          ...(settings?.effort ? { effort: settings.effort } : {}),
          ...(settings && Object.prototype.hasOwnProperty.call(settings, 'serviceTier') ? { serviceTier: settings.serviceTier, serviceTierPresent: true } : {}),
          permissionMode,
          workMode: 'default',
          workspaceId: conflictWorkspace.id,
          executionWorkspaceMode: 'worktree',
          writableRoots: [],
          allowCodeChanges: true,
          allowTests: true,
          allowGitCommit: false,
          holdDispatch: true,
          operationContext: {
            conflictPreparation: {
              attemptId,
              integrationId,
              conflictPath,
              conflictContent,
              conflictFingerprint,
              repositoryPath,
              conflictWorkspaceId: conflictWorkspace.id,
              skill: skill ?? null,
            },
          },
          idempotencyKey,
          clientUserMessageId,
          providerWriteLifecycle: reservedLifecycle,
          ...(skill ? { skill } : {}),
        });
        if (!existingAttempt) {
          taskIntegrationAttempts.create({
            id: attemptId,
            integrationId,
            conversationId: nativeOperation.conversationId,
            submissionId: nativeOperation.submissionId,
            worktreePath: '',
            targetHeadSha: resolved.integration.targetHeadSha,
            taskHeadSha: resolved.integration.taskHeadSha,
            state: 'preparing',
          });
        } else {
          taskIntegrationAttempts.update(attemptId, { state: 'preparing', lastError: null });
        }
        taskConflictAiOperations.set(attemptId, {
          conversationId: nativeOperation.conversationId,
          submissionId: nativeOperation.submissionId,
          running: false,
          finalizing: false,
        });
        recordTaskEvent({
          taskId: task.id,
          eventType: 'task.git_integration.ai_accepted',
          title: '冲突处理：已进入会话，正在准备最新合入现场',
          payload: {
            integrationId,
            attemptId,
            workspaceId: conflictWorkspace.id,
            baseWorkspaceId: resolved.workspace.id,
            conversationId: nativeOperation.conversationId,
            targetBranch: resolved.integration.targetBranch,
            taskBranch: resolved.workspace.branchName,
            conflictBranch: conflictWorkspace.branchName,
          },
        });
        await db.save();
        setImmediate(() => {
          void prepareTaskIntegrationAiAttempt({
            attemptId,
            integrationId,
            conflictPath,
            conflictContent,
            conflictFingerprint,
            idempotencyKey,
            clientUserMessageId,
            agentKind: selectedAgentKind,
            model: { sourceId: modelConversation.modelSourceId, modelId, displayName: null },
            ...(skill ? { skill } : {}),
          });
        });
      } else {
        if (body.content !== undefined && typeof body.content !== 'string') throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Create content must be a string.');
        const collaborationMode = body.collaborationMode === undefined ? 'default' : parseConversationCollaborationMode(body.collaborationMode);
        if (!collaborationMode) throw nativeApiError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.');
        const permissionMode = body.permissionMode === undefined ? (task.allowCodeChanges ? 'auto' : 'read-only') : parseConversationPermissionMode(body.permissionMode);
        if (!permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
        const explicitAttachments = normalizeNativeConversationAttachments(body.attachments, project.localPath);
        const explicitContent = typeof body.content === 'string' ? body.content.trim() : '';
        const canonicalAttachmentInput = body.attachments === undefined && !explicitContent ? normalizeTaskPushAttachments(task, project.localPath) : null;
        const attachments = canonicalAttachmentInput?.attachments ?? explicitAttachments;
        const content = explicitContent || createTaskRuntimePrompt(task);
        const explicitModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
        const capabilities = await resolveConversationCapabilities(project, {
          allowPiWhenCodexUnavailable: body.agentKind === 'pi' || Boolean(explicitModel && parseModelRef(explicitModel)?.sourceId !== 'codex'),
        });
        const selectedModel = resolveModelCapability(capabilities.models, explicitModel ?? capabilities.preferredModel) ?? capabilities.models[0]!;
        if (selectedModel.available === false) throw nativeApiError('ZEUS_MODEL_NOT_READY', selectedModel.availabilityReason || '所选模型当前不可运行。');
        const selectedAgentKind = selectedModel.agentKind === 'pi' ? 'pi' : 'codex';
        if (body.agentKind !== undefined && body.agentKind !== selectedAgentKind) {
          throw nativeApiError('ZEUS_INVALID_AGENT_KIND', 'The requested agent does not match the selected model.');
        }
        const goalObjective = parseGoalObjective(body.goalObjective);
        if (goalObjective && (selectedModel.agentKind !== 'codex' || capabilities.goals?.enabled !== true)) {
          throw nativeApiError('ZEUS_CODEX_GOALS_UNAVAILABLE', '当前 Agent 或 app-server 不支持原生目标。');
        }
        const requestedServiceTier = readServiceTierOverride(body);
        const serviceTier = normalizeServiceTierForCapability(requestedServiceTier, selectedModel);
        const selectedEffort = selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? null;
        const inheritConversationId = typeof body.inheritConversationId === 'string' ? body.inheritConversationId.trim() : '';
        let inheritedEnvironment: Awaited<ReturnType<typeof resolveTaskPushEnvironment>> | null = null;
        if (inheritConversationId) {
          const sourceConversation = conversations.getById(inheritConversationId);
          if (!sourceConversation || sourceConversation.projectId !== project.id || sourceConversation.taskId !== task.id) {
            throw nativeApiError('ZEUS_TASK_EXECUTION_CONTEXT_INVALID', 'The source conversation does not belong to this task.');
          }
          if (!sourceConversation.environmentId && !sourceConversation.workspaceId) {
            throw nativeApiError('ZEUS_TASK_EXECUTION_CONTEXT_REQUIRED', 'The source task conversation has no persisted execution workspace.');
          }
          inheritedEnvironment = await resolveTaskPushEnvironment(
            project,
            task,
            sourceConversation.environmentId ? { mode: 'existing', environmentId: sourceConversation.environmentId } : { mode: 'existing', workspaceId: sourceConversation.workspaceId },
            stableOperationId,
          );
        }
        nativeOperation = await startNativeTaskConversationFromPlan({
          agentKind: selectedAgentKind,
          conversationId: reservation.conversationId,
          submissionId: reservation.submissionId,
          projectId: project.id,
          taskId: task.id,
          taskTitle: task.title,
          cwd: inheritedEnvironment?.cwd ?? project.localPath,
          prompt: content,
          model: { sourceId: selectedModel.sourceId ?? null, modelId: selectedModel.model, displayName: selectedModel.displayName ?? null },
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          serviceTier,
          serviceTierPresent: requestedServiceTier.present,
          permissionMode,
          workMode: collaborationMode,
          ...(inheritedEnvironment
            ? {
                environmentId: inheritedEnvironment.environment.id,
                ...(inheritedEnvironment.workspaces[0] ? { workspaceId: inheritedEnvironment.workspaces[0].id } : {}),
              }
            : {}),
          executionWorkspaceMode: inheritedEnvironment ? 'worktree' : 'direct',
          writableRoots: inheritedEnvironment?.writableRoots ?? [project.localPath],
          allowCodeChanges: task.allowCodeChanges,
          allowTests: task.allowTests,
          allowGitCommit: task.allowGitCommit,
          attachments,
          ...(canonicalAttachmentInput?.allowedRoots.length ? { allowedAttachmentRoots: canonicalAttachmentInput.allowedRoots } : {}),
          idempotencyKey,
          clientUserMessageId,
          providerWriteLifecycle: reservedLifecycle,
          ...(goalObjective ? { goalObjective } : {}),
        });
      }
    } else if (body.mode === 'resume') {
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      const selected = conversations.getById(conversationId);
      if (!selected || selected.projectId !== project.id || selected.taskId !== task.id || selected.archived) {
        throw nativeApiError('ZEUS_CONVERSATION_CHOICE_INVALID', 'Selected conversation does not belong to this task.');
      }
      if (selected.transportKind !== 'codex_native') throw nativeApiError('ZEUS_LEGACY_CONVERSATION_READ_ONLY', 'Legacy conversations are read-only and cannot be resumed as native threads.');
      if (!content) throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Resume content is required.');
      if (selected.id !== reservation.conversationId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Selected resume conversation does not match the reserved task acceptance resource.');
      const collaborationMode = body.collaborationMode === undefined ? selected.collaborationMode : parseConversationCollaborationMode(body.collaborationMode);
      if (!collaborationMode) throw nativeApiError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.');
      const nextSettings = conversations.getNextTurnSettings(selected.id);
      const selectedAgentKind = selected.agentKind === 'pi' ? 'pi' : 'codex';
      const piModelRef = selectedAgentKind === 'pi' && nextSettings?.model ? parseModelRef(nextSettings.model) : null;
      const modelSourceId = piModelRef?.sourceId ?? selected.modelSourceId ?? null;
      const modelId = piModelRef?.modelId ?? selected.modelId ?? selected.providerModel ?? '';
      if (!modelId) throw nativeApiError('ZEUS_MODEL_UNAVAILABLE', '当前会话没有可恢复的目标模型。');
      const resolvedRoute = await resolveConversationExecutionRoute({
        agentKind: selectedAgentKind,
        modelSourceId,
        modelId,
        effort: nextSettings?.effort ?? null,
        serviceTier: nextSettings && Object.prototype.hasOwnProperty.call(nextSettings, 'serviceTier') ? (nextSettings.serviceTier ?? null) : null,
        permissionMode: nextSettings?.permissionMode ?? selected.permissionMode,
        collaborationMode,
        projectId: project.id,
        taskId: task.id,
        workspaceId: selected.workspaceId,
        environmentId: selected.environmentId,
        executionRoot: resolveNativeConversationExecutionRoot(selected) ?? project.localPath,
      });
      const segmentLifecycle = conversationExecutionCoordinator.createLifecycle({
        conversationId: selected.id,
        route: resolvedRoute.route,
        targetCapabilities: {
          readableReasoningSummary: true,
          media: resolvedRoute.configuredModel?.capability.imageInput.state !== 'unsupported',
          contextWindow: resolvedRoute.configuredModel?.contextWindow ?? null,
          currentInputCharacters: content.length,
        },
        userHistoryContent: { text: content },
      });
      const conversationSkill = segmentLifecycle.requiresNewSegment ? readNativeConversationSkill(conversationSubmissions.listByConversation(selected.id)) : null;
      if (selectedAgentKind === 'pi') {
        nativeOperation = segmentLifecycle.requiresNewSegment
          ? await piNativeCoordinator.startConversation({
              conversationId: selected.id,
              submissionId: reservation.submissionId,
              projectId: project.id,
              taskId: task.id,
              taskTitle: task.title,
              conversationTitle: selected.title,
              cwd: resolveNativeConversationExecutionRoot(selected) ?? project.localPath,
              prompt: content,
              model: { sourceId: modelSourceId, modelId, displayName: null },
              ...(nextSettings?.effort ? { thinkingLevel: nextSettings.effort } : {}),
              ...(conversationSkill ? { skill: conversationSkill } : {}),
              permissionMode: nextSettings?.permissionMode ?? selected.permissionMode,
              idempotencyKey,
              clientUserMessageId,
              providerWriteLifecycle: reservedLifecycle,
              segmentLifecycle,
            })
          : await piNativeCoordinator.submitMessage({
              conversation: selected,
              submissionId: reservation.submissionId,
              content,
              model: { sourceId: modelSourceId, modelId, displayName: null },
              ...(nextSettings?.effort ? { thinkingLevel: nextSettings.effort } : {}),
              idempotencyKey,
              clientUserMessageId,
              segmentLifecycle,
            });
      } else {
        nativeOperation = segmentLifecycle.requiresNewSegment
          ? await codexNativeCoordinator.startTaskConversation({
              conversationId: selected.id,
              submissionId: reservation.submissionId,
              projectId: project.id,
              projectLocalPath: resolveNativeConversationExecutionRoot(selected) ?? project.localPath,
              taskId: task.id,
              taskTitle: task.title,
              conversationTitle: selected.title,
              prompt: content,
              model: modelId,
              modelSourceId,
              ...(nextSettings?.effort ? { effort: nextSettings.effort } : {}),
              ...(conversationSkill ? { skill: conversationSkill } : {}),
              ...(nextSettings && Object.prototype.hasOwnProperty.call(nextSettings, 'serviceTier') ? { serviceTier: nextSettings.serviceTier ?? null } : {}),
              allowCodeChanges: task.allowCodeChanges,
              allowTests: task.allowTests,
              allowGitCommit: task.allowGitCommit,
              permissionMode: nextSettings?.permissionMode ?? selected.permissionMode,
              workMode: collaborationMode,
              applyLegacyTaskGuards: false,
              idempotencyKey,
              clientUserMessageId,
              providerWriteLifecycle: reservedLifecycle,
              segmentLifecycle,
            })
          : await codexNativeCoordinator.submitMessage({
              conversationId: selected.id,
              submissionId: reservation.submissionId,
              content,
              collaborationMode,
              idempotencyKey,
              clientUserMessageId,
              providerWriteLifecycle: reservedLifecycle,
              segmentLifecycle,
            });
      }
    } else if (body.mode === 'reference_legacy') {
      const sourceConversationId = typeof body.sourceConversationId === 'string' ? body.sourceConversationId : '';
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      const messageIds = Array.isArray(body.messageIds) && body.messageIds.every((messageId) => typeof messageId === 'string') ? body.messageIds : [];
      const selected = conversations.getById(sourceConversationId);
      if (!selected || selected.projectId !== project.id || selected.taskId !== task.id || selected.transportKind !== 'legacy_cli') {
        throw nativeApiError('ZEUS_CONVERSATION_CHOICE_INVALID', 'Selected legacy conversation does not belong to this task.');
      }
      if (!content || messageIds.length === 0) throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Legacy reference content and explicit messageIds are required.');
      const permissionMode = body.permissionMode === undefined ? (task.allowCodeChanges ? 'auto' : 'read-only') : parseConversationPermissionMode(body.permissionMode);
      if (!permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
      const collaborationMode = body.collaborationMode === undefined ? 'default' : parseConversationCollaborationMode(body.collaborationMode);
      if (!collaborationMode) throw nativeApiError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.');
      const capabilities = await resolveConversationCapabilities(project);
      const selectedModelId = await resolveCodexModel(project);
      const selectedModel = resolveModelCapability(capabilities.models, selectedModelId);
      if (!selectedModel || selectedModel.agentKind === 'pi') throw nativeApiError('ZEUS_MODEL_NOT_READY', '旧会话引用需要可用的 Codex App Server 模型。');
      nativeOperation = await startNativeTaskConversationFromPlan({
        agentKind: 'codex',
        conversationId: reservation.conversationId,
        submissionId: reservation.submissionId,
        projectId: project.id,
        taskId: task.id,
        taskTitle: task.title,
        cwd: project.localPath,
        prompt: content,
        model: { sourceId: selectedModel.sourceId ?? null, modelId: selectedModel.model, displayName: selectedModel.displayName ?? null },
        ...(selectedModel.defaultReasoningEffort ? { effort: selectedModel.defaultReasoningEffort } : {}),
        allowCodeChanges: task.allowCodeChanges,
        allowTests: task.allowTests,
        allowGitCommit: task.allowGitCommit,
        permissionMode,
        workMode: collaborationMode,
        executionWorkspaceMode: 'direct',
        writableRoots: [project.localPath],
        idempotencyKey,
        clientUserMessageId,
        legacyReference: { conversationId: selected.id, messageIds },
        providerWriteLifecycle: reservedLifecycle,
      });
    } else {
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', `Unsupported conversation mode: ${String(body.mode)}`);
    }

    const conversation = conversations.getById(nativeOperation.conversationId);
    const submission = conversationSubmissions.getById(nativeOperation.submissionId);
    if (!conversation || !submission || conversation.id !== reservation.conversationId || submission.id !== reservation.submissionId || submission.conversationId !== conversation.id) {
      throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native conversation acceptance did not persist the exact reserved resources.');
    }
    if (body.mode === 'create' && body.source === 'task_push') {
      const environmentWorkspaces = conversation.environmentId
        ? taskWorkspaces.listByEnvironment(conversation.environmentId)
        : conversation.workspaceId
          ? [taskWorkspaces.getById(conversation.workspaceId)].filter((workspace): workspace is ZeusTaskWorkspaceRecord => Boolean(workspace))
          : [];
      for (const taskWorkspace of environmentWorkspaces) {
        if (!taskWorkspace.worktreePath) continue;
        try {
          const review = await readTaskWorkspaceReview(taskWorkspace);
          taskWorkspaces.update(taskWorkspace.id, { headSha: review.headSha, state: 'ready', lastError: null });
        } catch (error) {
          taskWorkspaces.update(taskWorkspace.id, { state: 'failed', lastError: error instanceof Error ? error.message : 'Task workspace review failed.' });
        }
      }
      if (nativeOperation.status === 'active') {
        const runningTask = moveTaskTowardRunning(task.id, 'task.model_push.started');
        recordTaskEvent({
          taskId: runningTask.id,
          eventType: 'task.model_push.started',
          title: '任务已推送到模型',
          payload: {
            conversationId: conversation.id,
            providerThreadId: nativeOperation.providerThreadId,
            providerTurnId: nativeOperation.providerTurnId,
            model: conversation.providerModel,
            permissionMode: conversation.permissionMode,
            workMode: body.workMode,
          },
        });
      } else if (nativeOperation.providerThreadId) {
        recordTaskEvent({
          taskId: task.id,
          eventType: 'task.model_push.turn_not_started',
          title: '会话已创建，首轮尚未被模型接纳',
          payload: {
            conversationId: conversation.id,
            providerThreadId: nativeOperation.providerThreadId,
            operationStatus: nativeOperation.status,
          },
        });
      }
      await db.save();
    }
    return toNativeDurableAcceptance(stableOperationId, idempotencyKey, conversation, submission);
  }

  async function resolveWorkflowSkill(value: unknown, cwd: string): Promise<NativeConversationSkillInput | undefined> {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !/^[a-f0-9]{32}$/u.test(value)) throw nativeApiError('ZEUS_SKILL_INPUT_INVALID', 'Skill ID 无效，请重新选择。');
    if (!zeusSkillService) throw nativeApiError('ZEUS_SKILLS_UNAVAILABLE', '当前执行宿主不支持 Zeus Skill。');
    return zeusSkillService.resolve({ cwd, skillId: value });
  }

  function recoverTaskConversationAcceptance(project: ZeusProjectRecord, task: ZeusTaskRecord, idempotencyKey: string, expected: TaskConversationAcceptanceReservation, persistedResourceId: string | null) {
    const persisted = decodeTaskConversationAcceptanceReservation(persistedResourceId);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(expected)) return undefined;
    const conversation = conversations.getById(persisted.conversationId);
    const submission = conversationSubmissions.getById(persisted.submissionId);
    if (
      !conversation ||
      !submission ||
      conversation.projectId !== project.id ||
      conversation.taskId !== task.id ||
      submission.conversationId !== conversation.id ||
      submission.idempotencyKey !== idempotencyKey ||
      persisted.scope !== `task-conversation:${task.id}` ||
      persisted.operationId !== expected.operationId ||
      persisted.requestHash !== expected.requestHash
    ) {
      return undefined;
    }
    // response_json 是 acceptance 的唯一不可变 checkpoint；缺失时即便 provider turn 已存在也不能从可变 snapshot 伪造原响应。
    return undefined;
  }

  function toNativeDurableAcceptance(stableOperationId: string, idempotencyKey: string, conversation: ZeusConversationWithMessagesRecord, submission: NonNullable<ReturnType<ConversationSubmissionRepository['getById']>>) {
    const conversationSummary = conversationChoiceQueries.toSummary(conversation);
    const submissionSummary = toNativeSubmission(submission);
    return {
      operation: { id: stableOperationId, status: 'accepted' as const, idempotencyKey },
      conversation: { ...conversationSummary, updatedAt: conversationSummary.createdAt },
      submission: { ...submissionSummary, updatedAt: submissionSummary.createdAt },
    };
  }

  function toNativeInterruptAcceptance(stableOperationId: string, idempotencyKey: string, conversation: ZeusConversationWithMessagesRecord, submission: ReturnType<ConversationSubmissionRepository['getById']>) {
    const conversationSummary = conversationChoiceQueries.toSummary(conversation);
    const submissionSummary = submission ? toNativeSubmission(submission) : undefined;
    return {
      operation: { id: stableOperationId, status: 'accepted' as const, idempotencyKey },
      conversation: { ...conversationSummary, updatedAt: conversationSummary.createdAt },
      ...(submissionSummary ? { submission: { ...submissionSummary, updatedAt: submissionSummary.createdAt } } : {}),
    };
  }

  async function executeIdempotentJson<T>(
    scope: string,
    idempotencyKey: string,
    requestBody: unknown,
    statusCode: number,
    execute: (stableOperationId: string, lifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void }) => Promise<T>,
    recover?: (stableOperationId: string, persistedResourceId: string | null) => { statusCode: number; body: T } | undefined | Promise<{ statusCode: number; body: T } | undefined>,
    preparedResourceId?: string,
    markExternalWriteStarted?: () => void,
  ): Promise<{ statusCode: number; body: T }> {
    if (!codexNativeEnabled) throw nativeApiError('ZEUS_CODEX_NATIVE_DISABLED', 'Codex native conversation writes are disabled by ZEUS_CODEX_NATIVE_ENABLED.');
    const hash = nativeIdempotencyRequestHash(requestBody);
    const stableOperationId = nativeStableOperationId(scope, idempotencyKey, hash);
    const inFlightKey = `${scope}\0${idempotencyKey}`;
    const inFlight = nativeIdempotentInFlight.get(inFlightKey);
    if (inFlight) {
      if (inFlight.requestHash !== hash) throw nativeApiError('ZEUS_IDEMPOTENCY_CONFLICT', `Idempotency-Key ${idempotencyKey} was already used with a different request body.`);
      return (await inFlight.promise) as { statusCode: number; body: T };
    }
    const promise = Promise.resolve().then(() => executeOwnedIdempotentJson(scope, idempotencyKey, hash, stableOperationId, statusCode, execute, recover, preparedResourceId, markExternalWriteStarted));
    nativeIdempotentInFlight.set(inFlightKey, { requestHash: hash, promise: promise as Promise<{ statusCode: number; body: unknown }> });
    try {
      return await promise;
    } finally {
      if (nativeIdempotentInFlight.get(inFlightKey)?.promise === promise) nativeIdempotentInFlight.delete(inFlightKey);
    }
  }

  async function executeOwnedIdempotentJson<T>(
    scope: string,
    idempotencyKey: string,
    hash: string,
    stableOperationId: string,
    statusCode: number,
    execute: (stableOperationId: string, lifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void }) => Promise<T>,
    recover: ((stableOperationId: string, persistedResourceId: string | null) => { statusCode: number; body: T } | undefined | Promise<{ statusCode: number; body: T } | undefined>) | undefined,
    initialPreparedResourceId: string | undefined,
    markExternalWriteStarted: (() => void) | undefined,
  ): Promise<{ statusCode: number; body: T }> {
    const existing = db.get<{ request_hash: string; status: string; http_status: number | null; response_json: string | null; resource_id: string | null }>(
      'SELECT request_hash, status, http_status, response_json, resource_id FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?',
      [scope, idempotencyKey],
    );
    let preparedResourceId = initialPreparedResourceId ?? stableOperationId;
    if (existing) {
      if (existing.request_hash !== hash) throw nativeApiError('ZEUS_IDEMPOTENCY_CONFLICT', `Idempotency-Key ${idempotencyKey} was already used with a different request body.`);
      if (existing.status === 'completed' && existing.response_json) {
        return { statusCode: existing.http_status ?? statusCode, body: JSON.parse(existing.response_json) as T };
      }
      if (existing.status === 'in_progress' && existing.response_json) {
        db.execute(`UPDATE idempotency_requests SET status = 'completed', updated_at = ? WHERE scope = ? AND idempotency_key = ?`, [now().toISOString(), scope, idempotencyKey]);
        await db.save();
        return { statusCode: existing.http_status ?? statusCode, body: JSON.parse(existing.response_json) as T };
      }
      if (existing.status === 'in_progress') {
        const marker = parseNativeIdempotencyMarker(existing.resource_id);
        if (marker.phase === 'rpc_started') {
          const recovered = recover ? await recover(stableOperationId, marker.resourceId) : undefined;
          if (recovered !== undefined) {
            await checkpointCompletedIdempotentResponse(scope, idempotencyKey, recovered.statusCode, recovered.body);
            return recovered;
          }
          const recoveryRequired = createNativeIdempotencyRecoveryRequired(stableOperationId, idempotencyKey, marker.resourceId) as T;
          await checkpointCompletedIdempotentResponse(scope, idempotencyKey, 409, recoveryRequired);
          return { statusCode: 409, body: recoveryRequired };
        }
        preparedResourceId = marker.resourceId ?? preparedResourceId;
      }
      db.execute('DELETE FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?', [scope, idempotencyKey]);
      await db.save();
    }
    idempotencyRequests.createOrGet({
      scope,
      idempotencyKey,
      requestHash: hash,
      status: 'in_progress',
      resourceId: `prepared:${preparedResourceId}`,
      createdAt: now().toISOString(),
    });
    await db.save();
    let phase: 'prepared' | 'rpc_started' = 'prepared';
    let resourceId = preparedResourceId;
    const updateMarker = (nextPhase: 'prepared' | 'rpc_started', nextResourceId: string): void => {
      db.execute(`UPDATE idempotency_requests SET resource_id = ?, updated_at = ? WHERE scope = ? AND idempotency_key = ?`, [`${nextPhase}:${nextResourceId}`, now().toISOString(), scope, idempotencyKey]);
      phase = nextPhase;
      resourceId = nextResourceId;
    };
    try {
      const body = await execute(stableOperationId, {
        markPrepared: async (nextResourceId) => {
          updateMarker('prepared', nextResourceId);
          await db.save();
        },
        markRpcStarted: (nextResourceId) => {
          updateMarker('rpc_started', nextResourceId);
          markExternalWriteStarted?.();
        },
      });
      await checkpointCompletedIdempotentResponse(scope, idempotencyKey, statusCode, body);
      return { statusCode, body };
    } catch (error) {
      if (phase === 'prepared') {
        db.execute('DELETE FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?', [scope, idempotencyKey]);
        await db.save();
      } else {
        db.execute(`UPDATE idempotency_requests SET resource_id = ?, updated_at = ? WHERE scope = ? AND idempotency_key = ?`, [`rpc_started:${resourceId}`, now().toISOString(), scope, idempotencyKey]);
        await db.save();
      }
      throw error;
    }
  }

  function parseNativeIdempotencyMarker(value: string | null): { phase: 'prepared' | 'rpc_started'; resourceId: string | null } {
    if (value?.startsWith('prepared:')) return { phase: 'prepared', resourceId: value.slice('prepared:'.length) || null };
    if (value?.startsWith('rpc_started:')) return { phase: 'rpc_started', resourceId: value.slice('rpc_started:'.length) || null };
    return { phase: 'rpc_started', resourceId: value };
  }

  function createNativeIdempotencyRecoveryRequired(stableOperationId: string, idempotencyKey: string, resourceId: string | null) {
    return {
      error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED',
      message: 'The provider write may have started, but Zeus has no durable proof of its outcome. The RPC was not replayed.',
      recoveryRequired: true,
      operation: { id: stableOperationId, status: 'recovery_required' as const, idempotencyKey },
      ...(resourceId ? { resourceId } : {}),
    };
  }

  async function checkpointCompletedIdempotentResponse(scope: string, idempotencyKey: string, statusCode: number, body: unknown): Promise<void> {
    db.execute(`UPDATE idempotency_requests SET http_status = ?, response_json = ?, updated_at = ? WHERE scope = ? AND idempotency_key = ?`, [statusCode, JSON.stringify(body), now().toISOString(), scope, idempotencyKey]);
    await db.save();
    db.execute(`UPDATE idempotency_requests SET status = 'completed', updated_at = ? WHERE scope = ? AND idempotency_key = ?`, [now().toISOString(), scope, idempotencyKey]);
    await db.save();
  }

  async function checkpointInProgressIdempotentResponse(scope: string, idempotencyKey: string, statusCode: number, body: unknown): Promise<void> {
    db.execute(`UPDATE idempotency_requests SET http_status = ?, response_json = ?, updated_at = ? WHERE scope = ? AND idempotency_key = ? AND status = 'in_progress'`, [
      statusCode,
      JSON.stringify(body),
      now().toISOString(),
      scope,
      idempotencyKey,
    ]);
    await db.save();
  }

  function sendNativeConversationApiError(reply: FastifyReply, error: unknown) {
    const code = isNativeApiRecord(error) && typeof error.code === 'string' ? error.code : 'ZEUS_NATIVE_CONVERSATION_API_ERROR';
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = code.endsWith('_NOT_FOUND')
      ? 404
      : code.includes('CONFLICT') ||
          code.includes('LOGIN_REQUIRED') ||
          code.includes('CHOICE_REQUIRED') ||
          code.includes('READ_ONLY') ||
          code.includes('NOT_EDITABLE') ||
          code.includes('NOT_QUEUED') ||
          code.includes('NOT_ACTIVE') ||
          code.includes('NOT_INTERRUPTED') ||
          code.includes('IN_PROGRESS') ||
          code.includes('MISMATCH') ||
          code.includes('EXCEEDS_POLICY') ||
          code.includes('EXCEEDS_REQUEST') ||
          code.includes('ATTACHMENT_UNAVAILABLE') ||
          code.includes('CONTEXT_CHANGED') ||
          code.includes('NATIVE_DISABLED') ||
          code.includes('NOT_AVAILABLE') ||
          code.includes('STALE')
        ? 409
        : code.startsWith('ZEUS_INVALID_') || code.endsWith('_INVALID') || code.endsWith('_REQUIRED') || code.includes('_UNSUPPORTED')
          ? 400
          : 500;
    return reply.code(statusCode).send({ error: code, message, ...(code.includes('STALE') || code.includes('RECOVERY_REQUIRED') ? { recoveryRequired: true } : {}) });
  }

  function parseProjectGitAction(value: unknown): ProjectGitAction {
    if (!isNativeApiRecord(value) || typeof value.type !== 'string') throw nativeApiError('ZEUS_GIT_ACTION_INVALID', 'A supported Git action is required.');
    const stringValue = (key: string): string | undefined => (typeof value[key] === 'string' ? value[key].trim() || undefined : undefined);
    const paths = (): string[] => {
      const candidate = value.paths;
      if (!Array.isArray(candidate) || candidate.some((path) => typeof path !== 'string')) throw nativeApiError('ZEUS_GIT_PATH_INVALID', 'Git paths must be a string array.');
      return candidate;
    };
    switch (value.type) {
      case 'fetch':
        return { type: 'fetch', remote: stringValue('remote') };
      case 'stage':
        return { type: 'stage', paths: paths() };
      case 'unstage':
        return { type: 'unstage', paths: paths() };
      case 'commit':
        return { type: 'commit', message: stringValue('message') ?? '' };
      case 'push':
        return {
          type: 'push',
          remote: stringValue('remote'),
          targetBranch: stringValue('targetBranch'),
          forceWithLease: value.forceWithLease === true,
          pushTags: value.pushTags === true,
        };
      case 'pull': {
        const strategy = value.strategy;
        if (strategy !== 'rebase' && strategy !== 'merge') throw nativeApiError('ZEUS_GIT_PULL_STRATEGY_INVALID', 'Pull strategy must be rebase or merge.');
        return { type: 'pull', remote: stringValue('remote'), targetBranch: stringValue('targetBranch'), strategy };
      }
      case 'update': {
        const strategy = value.strategy;
        if (strategy !== 'merge' && strategy !== 'rebase' && strategy !== 'reset') throw nativeApiError('ZEUS_GIT_UPDATE_STRATEGY_INVALID', 'Update strategy must be merge, rebase, or reset.');
        return { type: 'update', strategy, smart: value.smart === true };
      }
      case 'checkout':
        return { type: 'checkout', branchName: stringValue('branchName') ?? '', smart: value.smart === true };
      case 'checkout_revision':
        return { type: 'checkout_revision', revision: stringValue('revision') ?? '', smart: value.smart === true };
      case 'create_branch':
        return { type: 'create_branch', branchName: stringValue('branchName') ?? '', baseRef: stringValue('baseRef'), trackRemote: value.trackRemote === true, smart: value.smart === true };
      case 'delete_branch':
        return { type: 'delete_branch', branchName: stringValue('branchName') ?? '' };
      case 'merge':
        return { type: 'merge', branchName: stringValue('branchName') ?? '' };
      case 'rebase':
        return { type: 'rebase', branchName: stringValue('branchName') ?? '' };
      case 'stash':
        return { type: 'stash', message: stringValue('message'), includeUntracked: value.includeUntracked === true };
      case 'apply_stash':
        return { type: 'apply_stash', stashRef: stringValue('stashRef') ?? '', pop: value.pop === true };
      case 'drop_stash':
        return { type: 'drop_stash', stashRef: stringValue('stashRef') ?? '' };
      default:
        throw nativeApiError('ZEUS_GIT_ACTION_UNSUPPORTED', `Unsupported project Git action: ${value.type}`);
    }
  }

  function assertRequestedAgentIsCodex(value: unknown): void {
    if (!isNativeApiRecord(value) || value.agentKind === undefined || value.agentKind === 'codex') return;
    if (value.agentKind === 'pi' || value.agentKind === 'claude') {
      throw nativeApiError('ZEUS_AGENT_NOT_AVAILABLE', `${value.agentKind === 'pi' ? 'Pi' : 'Claude'} Agent 当前尚未开放。`);
    }
    throw nativeApiError('ZEUS_INVALID_AGENT_KIND', 'agentKind must be codex, pi, claude, or omitted.');
  }

  function assertRequestedAgentKind(value: unknown): void {
    if (!isNativeApiRecord(value) || value.agentKind === undefined || value.agentKind === 'codex' || value.agentKind === 'pi') return;
    if (value.agentKind === 'claude') throw nativeApiError('ZEUS_AGENT_NOT_AVAILABLE', 'Claude Agent 当前尚未开放。');
    throw nativeApiError('ZEUS_INVALID_AGENT_KIND', 'agentKind must be codex, pi, claude, or omitted.');
  }

  function parseConversationPermissionMode(value: unknown): ConversationPermissionMode | null {
    return value === 'read-only' || value === 'auto' || value === 'full-access' ? value : null;
  }

  function parseConversationCollaborationMode(value: unknown): ConversationCollaborationMode | null {
    return value === 'default' || value === 'plan' ? value : null;
  }

  function parseGoalObjective(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw nativeApiError('ZEUS_CODEX_GOAL_OBJECTIVE_INVALID', '目标必须是文本。');
    const objective = value.trim();
    if (!objective || [...objective].length > 4_000) throw nativeApiError('ZEUS_CODEX_GOAL_OBJECTIVE_INVALID', '目标必须为 1 到 4000 个字符。');
    return objective;
  }

  function providerTurnClientMessageId(turn: Record<string, unknown>): string | null {
    if (typeof turn.clientUserMessageId === 'string') return turn.clientUserMessageId;
    if (typeof turn.clientMessageId === 'string') return turn.clientMessageId;
    if (!Array.isArray(turn.items)) return null;
    for (const candidate of turn.items) {
      if (!isNativeApiRecord(candidate) || candidate.type !== 'userMessage') continue;
      if (typeof candidate.clientId === 'string') return candidate.clientId;
      const metadata = isNativeApiRecord(candidate.metadata) ? candidate.metadata : {};
      if (typeof metadata.clientUserMessageId === 'string') return metadata.clientUserMessageId;
    }
    return null;
  }

  function canonicalNativeApiJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalNativeApiJson).join(',')}]`;
    if (isNativeApiRecord(value)) {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalNativeApiJson(value[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  function nativeIdempotencyRequestHash(value: unknown): string {
    return createHash('sha256').update(canonicalNativeApiJson(value)).digest('hex');
  }

  function nativeStableOperationId(scope: string, idempotencyKey: string, requestHash: string): string {
    return `native_operation_${createHash('sha256').update(`${scope}\0${idempotencyKey}\0${requestHash}`).digest('hex').slice(0, 24)}`;
  }

  async function resolveCodexModel(project: ZeusProjectRecord): Promise<string> {
    if (!codexNativeEnabled) throw nativeApiError('ZEUS_CODEX_NATIVE_DISABLED', 'Codex native conversation writes are disabled by ZEUS_CODEX_NATIVE_ENABLED.');
    const projectConfig = readProjectConfig(project.id);
    const configured = projectConfig.defaultModel ?? platformMutableState.runtimeSettings.adapterModels.codex;
    if (configured?.trim()) return configured.trim();
    const capabilities = await codexAppServerManager.ensureReady({ commandPath: currentCodexRuntimeCommandPath(), ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}) });
    const firstSupported = capabilities.supportedModels[0];
    if (!firstSupported) {
      throw Object.assign(new Error('Codex app-server did not report an available model.'), { code: 'ZEUS_CODEX_MODEL_UNAVAILABLE' });
    }
    return firstSupported;
  }

  return {
    archiveNativeConversation,
    restoreNativeConversation,
    toNativeSubmission,
    toNativeSubmissionError,
    toNativeServerRequest,
    conversationGoalCapability,
    toNativeQueueApiSnapshot,
    inferNativeQueueWaitReason,
    inferNativeConversationSnapshotState,
    requireNativeQueueConversation,
    executeConversationDispatchMessage,
    executeConversationDispatchSideChat,
    prepareConversationQueueReroute,
    applyConversationQueueReroute,
    executeConversationDispatchRequestResponse,
    boundedConversationDispatchError,
    acceptNativeConversationMessage,
    normalizeNativeConversationAttachments,
    normalizeNativeBrowserComments,
    normalizeNativeConversationContext,
    normalizeNativeClientUserMessageId,
    normalizeRequestUserInputAnswerAttachments,
    normalizeNativeServerRequestResponse,
    executeProjectConversationIdempotent,
    encodeProjectConversationAcceptanceReservation,
    decodeProjectConversationAcceptanceReservation,
    acceptProjectConversation,
    recoverProjectConversationAcceptance,
    executeTaskConversationIdempotent,
    createTaskConversationAcceptanceReservation,
    encodeTaskConversationAcceptanceReservation,
    decodeTaskConversationAcceptanceReservation,
    resolveConversationExecutionRoute,
    startNativeTaskConversationFromPlan,
    acceptTaskConversation,
    recoverTaskConversationAcceptance,
    toNativeDurableAcceptance,
    toNativeInterruptAcceptance,
    executeIdempotentJson,
    executeOwnedIdempotentJson,
    parseNativeIdempotencyMarker,
    createNativeIdempotencyRecoveryRequired,
    checkpointCompletedIdempotentResponse,
    checkpointInProgressIdempotentResponse,
    sendNativeConversationApiError,
    parseProjectGitAction,
    assertRequestedAgentIsCodex,
    assertRequestedAgentKind,
    parseConversationPermissionMode,
    parseConversationCollaborationMode,
    parseGoalObjective,
    providerTurnClientMessageId,
    canonicalNativeApiJson,
    nativeIdempotencyRequestHash,
    nativeStableOperationId,
    resolveCodexModel,
  };
}
