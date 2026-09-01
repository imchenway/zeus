import { type CodexAppServerEvent, type CodexAppServerManager, type CodexResponsesRuntime, type CodexServerRequestResponse, type CodexThreadGoal, modelRef, parseModelRef, toCodexWireReasoningEffort } from '@zeus/ai-runtime';
import { buildTaskPushInputParts, type CodexAdditionalContextEntry, type CodexBootstrapAdditionalContext, type TaskPushMessageLayout } from '@zeus/shared';
import {
  CommandDeliveryRepository,
  type ConversationCollaborationMode,
  ConversationExecutionRepository,
  ConversationGoalRepository,
  type ConversationNextTurnSettings,
  ConversationPlanActionRepository,
  ConversationProviderItemRepository,
  ConversationProviderSyncCheckpointRepository,
  ConversationRepository,
  ConversationResourceRepository,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  ProviderEventReceiptRepository,
  SettingRepository,
  type ZeusConversationItemRecord,
  type ZeusConversationServerRequestRecord,
  type ZeusConversationSubmissionRecord,
  type ZeusConversationTurnRecord,
  type ZeusConversationWithMessagesRecord,
  type ZeusDatabase,
} from '@zeus/storage';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { BrowserAutomationPort } from './browserAutomation.js';
import { createCodexDynamicToolApplication } from './codexDynamicToolApplication.js';
import { createZeusToolBroker, type ZeusToolAuditEvent } from './zeusToolRegistry.js';
import { finalizeCodexPendingInteractionsForShutdown } from './codexFinalShutdownApplication.js';
import { codexGoalEventKind, createCodexGoalApplication, ensureInitialCodexGoal } from './codexGoalApplication.js';
import { createCodexInteractionRecoveryApplication, isInteractionRecoveryCheckpointRequest } from './codexInteractionRecoveryApplication.js';
import type {
  ArchiveConversationInput,
  CodexNativeConversationCoordinator,
  ConversationDispatchContext,
  InterruptNativeTurnInput,
  NativeAcceptedOperation,
  NativeConversationAttachmentInput,
  NativeConversationRunState,
  NativeConversationSkillInput,
  NativeProviderWriteLifecycle,
  NativeQuestionAnswerAttachmentInput,
  NativeQueueSnapshot,
  NativeQueueWaitReason,
  NativeSubmissionRecoveryKind,
  NativeTurnResult,
  NativeTurnResultWaiter,
  RecoverNativeQueueInput,
  RespondNativeRequestInput,
  RespondPlanImplementationRequestInput,
  RestoreArchivedConversationInput,
  SendQueuedNowInput,
  SnoozeNativeRequestInput,
  StartNativeEphemeralConversationInput,
  StartProjectConversationInput,
  StartTaskConversationInput,
  SteerNativeMessageInput,
  SubmitNativeMessageInput,
  WaitForNativeTurnResultInput,
} from './codexNativeConversationContracts.js';
import { projectLocallyAcceptedUserMessage } from './localUserSubmissionProjection.js';
import { projectNativeConversationTitle } from './nativeConversationTitle.js';
import {
  buildInteractionRecoveryContinuation,
  buildInteractionRecoveryDisplayText,
  conversationSubmissionDispatchEnvelope,
  coordinatorError,
  developerInstructionsFor,
  evaluateCommandApproval,
  existingDirectoryRealpath,
  failedTurnErrorFromRecord,
  hasAuditableFileApprovalTarget,
  invalidServerRequestResponse,
  isAdvertisedCommandDecision,
  isExecpolicyAmendmentDecision,
  isGrantDecision,
  isInsideRoot,
  isProviderThreadAlreadyAvailableError,
  isProviderThreadArchivedError,
  isProviderTurnAlreadyEndedSteerError,
  isRecord,
  isSupportedLocalImageAttachment,
  isSupportedPermissionGrant,
  isSupportedPermissionRequest,
  isValidMcpElicitationResponse,
  parseJsonRecord,
  parseStoredConversationSubmissionDispatchEnvelope,
  providerEventReceipt,
  providerPermissionProfile,
  providerTurnIdFrom,
  requestHash,
  requireString,
  serializeError,
  stripRequestTransport,
  submissionDeliveryConfirmedForTurn,
  submissionErrorSnapshot,
  toRecoverySubmissionError,
  validatePermissionGrant,
} from './codexNativeConversationPolicy.js';
import { parseCanonicalRequestUserInputQuestions, validateCanonicalRequestUserInputAnswers } from './codexNativeRuiValidation.js';
import { createCodexExternalRequestAnswerRecovery } from './codexExternalRequestAnswerRecovery.js';
import { createCodexModelRequestTimingTracker } from './codexModelRequestTiming.js';
import { assertCallerDoesNotOverrideCompiledContext, mergeCodexAdditionalContext } from './codexNativeContextProtocol.js';
import { contextFromPersistedConversation, contextFromPersistedSubmission, emitPluginCompactionHook, prepareRecoveredCodexPlugins } from './codexConversationDispatchContext.js';
import { createCodexNativeConversationAccess } from './codexNativeConversationAccess.js';
import { readNativeSubmissionRecoveryKind, readNativeSubmissionSkill, readNativeSubmissionTaskPushLayout, type PersistedSubmissionInput } from './nativeConversationSubmissionInputs.js';
import { inferNativeConversationRunState, interruptedQueueSubmissions } from './codexNativeRunStateProjection.js';
import { chooseNativeUserMessageContent, type ResolvedNativeUserMessageSubmission, resolveNativeUserMessageSubmission } from './codexNativeUserMessageProjection.js';
import { runCodexPortableContextCompaction } from './codexPortableContextCompaction.js';
import { CodexProviderCommandApplicationService, type CodexProviderCommandOperation } from './codexProviderCommandApplication.js';
import { codexProviderEventIdentity, createCodexProviderEventFlow } from './codexProviderEventFlow.js';
import { projectCodexProviderEvent } from './codexProviderEventProjection.js';
import { createCodexProviderHistoryProjection } from './codexProviderHistoryProjection.js';
import { createCodexProviderThreadAuthorityApplication } from './codexProviderThreadAuthority.js';
import { createCodexProviderStopRecoveryApplication, type CodexProviderStopRequestResult } from './codexProviderStopRecoveryApplication.js';
import { createCodexRemoteControlConversationSyncApplication } from './codexRemoteControlConversationSyncApplication.js';
import { createCodexRecoveryStateApplication } from './codexRecoveryStateApplication.js';
import { createCodexTurnResultRecoveryApplication } from './codexTurnResultRecoveryApplication.js';
import type { CodexUsageService } from './codexUsageService.js';
import type { ContextDispatchEnvelope } from './contextDispatchService.js';
import type { ConversationSegmentLifecycle } from './conversationExecutionCoordinator.js';
import { conversationToolResultDynamicTools, type ManagedConversationToolResultStore } from './conversationPortableContext.js';
import { ConversationQueueCoreMutationApplication } from './conversationQueueCoreMutationApplication.js';
import { createCodexRecoveredUnsentQueueApplication, hasRecoveredUnsentSubmission } from './codexRecoveredUnsentQueueApplication.js';
import { normalizeConversationResources, toConversationResource } from './conversationResources.js';
import { archiveUnboundConversationLocally, restoreUnboundConversationLocally } from './unboundConversationArchiveApplication.js';
import { persistThreadProviderSettings as persistProviderThreadMetadata, threadPath } from './codexThreadMetadataProjection.js';
import type { ConversationEventFlowControl } from './eventFlowControl.js';
import type { TurnChangeSetService } from './turnChangeSets.js';
import { TurnProcessProjector } from './turnProcessProjector.js';
import { createCodexServiceTierDowngrade, isServiceTierUnavailableError } from './codexServiceTierDowngrade.js';
import { createCodexPluginToolApprovalApplication } from './codexPluginToolApprovalApplication.js';
import type { ZeusConversationPluginRuntime } from './zeusConversationPluginRuntime.js';

export { filterCompatibilitySnapshotItemAliases } from './codexProviderHistoryProjection.js';

interface NativeConversationDispatchLease {
  submissionId: string;
  lifecycles: Set<NativeProviderWriteLifecycle>;
  rpcStartedResourceId: string | null;
  promise?: Promise<NativeAcceptedOperation>;
}

export interface CreateCodexNativeConversationCoordinatorOptions {
  manager: CodexAppServerManager;
  enabled?: boolean;
  commandPath: string | (() => string);
  externalAgentHome?: string;
  db: ZeusDatabase;
  conversations: ConversationRepository;
  turns: ConversationTurnRepository;
  providerItems: ConversationProviderItemRepository;
  resources?: ConversationResourceRepository;
  changeSets?: TurnChangeSetService;
  submissions: ConversationSubmissionRepository;
  requests: ConversationServerRequestRepository;
  planActions?: ConversationPlanActionRepository;
  goals?: ConversationGoalRepository;
  receipts?: ProviderEventReceiptRepository;
  syncCheckpoints?: ConversationProviderSyncCheckpointRepository;
  settings: SettingRepository;
  usage?: CodexUsageService;
  execution: ConversationExecutionRepository;
  commandDeliveries: CommandDeliveryRepository;
  toolResults: ManagedConversationToolResultStore;
  eventFlow?: ConversationEventFlowControl;
  broadcast: (type: string, payload: Record<string, unknown>) => void;
  now?: () => string;
  operationId?: () => string;
  turnResultTimeoutMs?: number;
  browserAutomation?: BrowserAutomationPort;
  plugins?: ZeusConversationPluginRuntime;
  auditNativeTool?: (event: ZeusToolAuditEvent) => void | Promise<void>;
  trustedAttachmentRoots?: string[];
  generatedImageRoot?: string;
  getProjectRoot?: (projectId: string) => string | null;
  ensureExecutionContext?: (input: {
    conversationId: string;
    mode: 'reconcile' | 'submit' | 'dispatch' | 'recover_queue' | 'restore';
  }) => Promise<{ projectLocalPath: string; writableRoots?: string[]; executionWorkspaceMode?: 'direct' | 'worktree' } | null>;
  resolveResponsesRuntime?: (input: { modelSourceId: string | null; model: string }) => Promise<CodexResponsesRuntime | null>;
  compileDispatchContext?: (input: {
    provider: 'codex';
    conversationId: string;
    submissionId: string;
    projectId: string;
    projectLocalPath: string;
    taskId: string | null;
    modelId: string;
    modelSourceId: string | null;
    operationRisk: 'read_only' | 'local_write';
    fixedRequestUtf8Bytes: number;
    providerBootstrapUtf8Bytes: number;
    providerHistoryMode: 'latest' | 'bootstrap';
    providerGenerationId: string | null;
  }) => Promise<ContextDispatchEnvelope>;
}

export interface CodexNativeConversationRuntime extends CodexNativeConversationCoordinator {
  startEphemeralConversation(input: StartNativeEphemeralConversationInput): Promise<NativeAcceptedOperation>;
  waitForTurnResult(input: WaitForNativeTurnResultInput): Promise<NativeTurnResult>;
  /** 仅依据已持久的终态轮次和精确消息身份收口历史提交，不连接 Provider。 */
  reconcilePersistedTerminalSubmissions(): Promise<number>;
  synchronizeOpenConversation(input: { conversationId: string }): Promise<void>;
  synchronizeConversations(input: { conversationIds: readonly string[] }): Promise<void>;
  /** 退出编排专用：中断写入统一 Provider 命令账本，并在有界窗口内只读确认精确 turn 终态。 */
  requestProviderTurnStop(input: { conversationId: string; providerThreadId: string; providerTurnId: string; stopCommandId: string; confirmationTimeoutMs: number }): Promise<CodexProviderStopRequestResult>;
  close(input?: { mode: 'handoff' | 'final' }): Promise<void>;
}

const providerEventErrorsSettingKey = 'codex.native.provider_event_errors';
const providerEventHotReceiptLimit = 10_000;

function isRuntimeRejected(error: unknown): boolean {
  return isRecord(error) && error.dispatchDisposition === 'runtime_rejected';
}

export function createCodexNativeConversationCoordinator(options: CreateCodexNativeConversationCoordinatorOptions): CodexNativeConversationRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const operationId = options.operationId ?? randomUUID;
  const { requireConversation, requireProductConversation, requireOwnedSubmission } = createCodexNativeConversationAccess(options);
  const planActions = options.planActions ?? new ConversationPlanActionRepository(options.db);
  const goals = options.goals ?? new ConversationGoalRepository(options.db);
  const resources = options.resources ?? new ConversationResourceRepository(options.db);
  const receipts = options.receipts ?? new ProviderEventReceiptRepository(options.db);
  const syncCheckpoints = options.syncCheckpoints ?? new ConversationProviderSyncCheckpointRepository(options.db);
  const runStates = new Map<string, NativeConversationRunState>();
  const { markConversationProviderArchived, markConversationRecoveryRequired, markSubmissionRecoveryRequired } = createCodexRecoveryStateApplication({
    conversations: options.conversations,
    submissions: options.submissions,
    turns: options.turns,
    execution: options.execution,
    runStates,
    broadcast: options.broadcast,
    now,
  });
  const contexts = new Map<string, ConversationDispatchContext>();
  const executionContextPromises = new Map<string, Promise<void>>();
  const dispatchLeases = new Map<string, NativeConversationDispatchLease>();
  const hotReceiptIdentities = new Set<string>();
  const maintainedReceiptGenerations = new Set<string>();
  const completedTurnResults = new Map<string, NativeTurnResult>();
  const failedTurnResults = new Map<string, Error & { code: string }>();
  const turnResultWaiters = new Map<string, NativeTurnResultWaiter[]>();
  const autoResolutionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // 敏感回答不能落入 submission JSON；仅在当前宿主内存中保留到新 turn 被 app-server 接受。
  const volatileSubmissionText = new Map<string, string>();
  let closing = false;
  let closed = false;
  let generationReconcileChain = Promise.resolve();
  let reconciledGenerationId: string | null = null;
  const reconciledConversationIds = new Set<string>();
  const completedPlanRecoverySettingKey = 'codex.native.completed_plan_recovery';
  const completedPlanRecoveryRevision = '20260815_completed_plan_projection';
  const providerHistoryReconcilePageLimit = 20;
  const providerHistoryReconcileTurnLimit = 2_000;
  let hotReceiptGenerationId: string | null = null;
  let queueDrainPromise: Promise<void> | null = null;
  let handoffPromise: Promise<void> | null = null;
  let finalizationPromise: Promise<void> | null = null;
  const processProjector = new TurnProcessProjector(options.execution);
  const providerCommands = new CodexProviderCommandApplicationService(options.db, options.commandDeliveries, now);
  const pluginToolApprovals = createCodexPluginToolApprovalApplication({
    conversations: options.conversations,
    turns: options.turns,
    requests: options.requests,
    now,
    operationId,
    persist,
    broadcast: options.broadcast,
    setRunState: (conversationId, state) => runStates.set(conversationId, state),
  });
  const zeusToolBroker = options.browserAutomation ? createZeusToolBroker(options.browserAutomation, { audit: options.auditNativeTool }) : undefined;
  const handleDynamicToolRequest = createCodexDynamicToolApplication({
    manager: options.manager,
    providerCommands,
    toolResults: options.toolResults,
    ...(options.plugins ? { plugins: options.plugins } : {}),
    ...(zeusToolBroker ? { toolBroker: zeusToolBroker } : {}),
    findConversation: (threadId) => options.conversations.getByProviderThreadId(threadId),
    turns: options.turns,
    execution: options.execution,
    pluginContext: (conversationId) => {
      const conversation = options.conversations.getById(conversationId);
      if (!conversation) return null;
      const context = contexts.get(conversationId) ?? contextFromConversation(conversation);
      return { cwd: context.projectLocalPath, model: context.model, permissionMode: context.permissionMode };
    },
    requestPluginApproval: pluginToolApprovals.requestApproval,
    broadcast: options.broadcast,
    now,
  });
  let scheduledPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledPersistDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledPersistDirty = false;
  let persistenceChain = Promise.resolve();
  const modelRequestTiming = createCodexModelRequestTimingTracker();
  const providerEvents = createCodexProviderEventFlow({
    manager: options.manager,
    flowControl: options.eventFlow,
    isKnown(event) {
      const identity = codexProviderEventIdentity(event);
      return hotReceiptGenerationId === event.generationId && hotReceiptIdentities.has(identity) ? true : receipts.has(identity);
    },
    handleEvent: handleProviderEvent,
    handleEventError: safelyHandleProviderEventError,
    handleDynamicToolCall: (event) => (closed ? Promise.resolve() : handleDynamicToolRequest(event)),
  });
  const externalAnswerRecovery = createCodexExternalRequestAnswerRecovery({
    conversations: options.conversations,
    requests: options.requests,
    turns: options.turns,
    now,
    persist,
    broadcast: options.broadcast,
    enqueueBarrier: (work) => providerEvents.enqueueBarrier(work),
    isClosed: () => closing || closed,
  });
  const enqueueProviderTurnReconciliation = (conversation: ZeusConversationWithMessagesRecord, input: { priority?: 'control' } = {}): Promise<void> =>
    providerEvents.enqueueBarrier(() => reconcileProviderTurnsSinceCheckpoint(conversation, input));
  function assertOpen(): void {
    if (closing || closed) throw coordinatorError('ZEUS_CODEX_COORDINATOR_CLOSED', 'Codex native conversation coordinator is closed.');
    if (options.enabled === false) throw coordinatorError('ZEUS_CODEX_NATIVE_DISABLED', 'Codex native conversation writes are disabled by ZEUS_CODEX_NATIVE_ENABLED.');
  }
  async function persist(): Promise<void> {
    await options.db.save();
  }
  function clearScheduledPersistTimers(): void {
    if (scheduledPersistTimer) clearTimeout(scheduledPersistTimer);
    if (scheduledPersistDeadlineTimer) clearTimeout(scheduledPersistDeadlineTimer);
    scheduledPersistTimer = null;
    scheduledPersistDeadlineTimer = null;
  }
  function enqueuePersist(): Promise<void> {
    const run = persistenceChain.then(() => persist());
    // 单次失败由当前调用者处理；后续保存仍需能够继续尝试。
    persistenceChain = run.catch(() => undefined);
    return run;
  }
  async function flushScheduledPersist(): Promise<void> {
    clearScheduledPersistTimers();
    if (!scheduledPersistDirty) {
      await persistenceChain;
      return;
    }
    scheduledPersistDirty = false;
    await enqueuePersist();
  }

  function reportScheduledPersistFailure(error: unknown): void {
    options.broadcast('codex.native.error', {
      error: 'ZEUS_CODEX_PERSIST_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * 过程事件先更新内存与界面，再在安静窗口合并落盘；持续输出最长十秒必须形成一次持久检查点。
   * 询问、审批和轮次边界不走这里，由事件处理器立即 flush。
   */
  function schedulePersist(): void {
    scheduledPersistDirty = true;
    if (scheduledPersistTimer) clearTimeout(scheduledPersistTimer);
    scheduledPersistTimer = setTimeout(() => {
      scheduledPersistTimer = null;
      void flushScheduledPersist().catch(reportScheduledPersistFailure);
    }, 2_000);
    if (!scheduledPersistDeadlineTimer) {
      scheduledPersistDeadlineTimer = setTimeout(() => {
        scheduledPersistDeadlineTimer = null;
        void flushScheduledPersist().catch(reportScheduledPersistFailure);
      }, 10_000);
    }
  }

  function requiresImmediatePersist(event: CodexAppServerEvent, createdPlanImplementationRequest: unknown): boolean {
    return (
      event.requestId !== undefined ||
      event.method === 'turn/started' ||
      event.method === 'turn/completed' ||
      event.method === 'thread/goal/updated' ||
      event.method === 'thread/goal/cleared' ||
      event.method === 'serverRequest/resolved' ||
      event.method === 'rawResponse/completed' ||
      createdPlanImplementationRequest !== null
    );
  }

  function syncItemResources(
    conversation: ZeusConversationWithMessagesRecord,
    turn: ZeusConversationTurnRecord,
    item: ReturnType<ConversationProviderItemRepository['getByProvider']> extends infer RecordType ? Exclude<RecordType, undefined> : never,
    payload: Record<string, unknown>,
    text: string,
    timestamp: string,
  ) {
    const projectRoot = contexts.get(conversation.id)?.projectLocalPath ?? options.getProjectRoot?.(conversation.projectId) ?? null;
    if (!projectRoot) return [];
    const submission = item.itemType === 'userMessage' ? submissionForProviderUserItem(conversation.id, turn, payload) : undefined;
    const resourcePayload = submission ? { ...payload, attachments: submissionAttachments(submission) } : payload;
    const normalized = normalizeConversationResources({
      projectId: conversation.projectId,
      projectRoot,
      conversationId: conversation.id,
      turnId: turn.id,
      item,
      payload: resourcePayload,
      text,
      trustedAttachmentRoots: options.trustedAttachmentRoots ?? [],
      generatedImageRoot: options.generatedImageRoot,
      now: timestamp,
    });
    return resources
      .replaceForItem(item.id, normalized, timestamp)
      .map(toConversationResource)
      .filter((resource): resource is NonNullable<typeof resource> => resource !== null);
  }

  function projectProcessItem(input: {
    conversationId: string;
    turnId: string;
    threadId: string;
    providerItemId: string;
    itemType: string;
    status: 'in_progress' | 'completed' | 'failed';
    payload: Record<string, unknown>;
    text: string;
    occurredAt: string;
  }): void {
    const segment = options.execution.segmentByNativeSession(input.threadId, input.conversationId);
    if (!segment || segment.state === 'sealed') return;
    processProjector.projectNativeItem({
      conversationId: input.conversationId,
      turnId: input.turnId,
      segment,
      providerItemId: input.providerItemId,
      itemType: input.itemType,
      status: input.status,
      payload: input.payload,
      text: input.text,
      occurredAt: input.occurredAt,
    });
  }

  function commandPath(): string {
    return typeof options.commandPath === 'function' ? options.commandPath() : options.commandPath;
  }

  function executeSessionCommand<T>(input: {
    operation: Extract<CodexProviderCommandOperation, 'goal_set' | 'goal_clear' | 'thread_archive' | 'thread_unarchive'>;
    conversationId: string;
    threadId: string;
    commandKey: string;
    requestIdentity: unknown;
    invoke(traceIdentity: string | null): Promise<T>;
    recoverAccepted?(nativeSessionId: string): Promise<T>;
    mutateBusinessState?(result: T): void;
  }): Promise<T> {
    return providerCommands.executeSession({
      ...input,
      scope: { kind: 'product_conversation', id: input.conversationId },
      idempotencyKey: input.commandKey,
      issuedAt: now(),
      resourceId: input.conversationId,
      providerGenerationId: options.manager.generationForThread(input.threadId),
      nativeSessionId: () => input.threadId,
    });
  }

  function executeTurnCommand<T>(input: {
    operation: Extract<CodexProviderCommandOperation, 'turn_steer' | 'turn_interrupt' | 'server_request_response'>;
    conversationId: string;
    threadId: string;
    turnId: string;
    commandKey: string;
    requestIdentity: unknown;
    issuedAt?: string;
    providerGenerationId?: string | null;
    invoke(traceIdentity: string | null): Promise<T>;
    isExplicitRejection?(error: unknown): boolean;
    mutateBusinessState?(result: T): void;
  }): Promise<T> {
    const turnScopeId = options.turns.listByConversation(input.conversationId).find((turn) => turn.providerTurnId === input.turnId)?.id ?? input.turnId;
    return providerCommands.executeTurn({
      ...input,
      scope: { kind: 'turn', id: turnScopeId },
      idempotencyKey: input.commandKey,
      issuedAt: input.issuedAt ?? now(),
      resourceId: input.conversationId,
      providerGenerationId: input.providerGenerationId === undefined ? options.manager.generationForThread(input.threadId) : input.providerGenerationId,
      nativeSessionId: input.threadId,
      nativeTurnId: () => input.turnId,
    });
  }

  function hasPendingPlanImplementationRequest(conversationId: string): boolean {
    return planActions.listByConversation(conversationId).some((request) => request.status === 'pending');
  }

  const contextFromSubmission = (submission: ZeusConversationSubmissionRecord): ConversationDispatchContext => contextFromPersistedSubmission(submission, options.conversations.getById(submission.conversationId));

  async function ensureConversationExecutionContext(conversationId: string, mode: 'reconcile' | 'submit' | 'dispatch' | 'recover_queue' | 'restore', allowProductConversation = false): Promise<void> {
    if (!options.ensureExecutionContext) return;
    const existing = executionContextPromises.get(conversationId);
    if (existing) return existing;
    const promise = (async () => {
      const resolved = await options.ensureExecutionContext!({ conversationId, mode });
      if (!resolved) return;
      const conversation = allowProductConversation ? requireProductConversation(conversationId) : requireConversation(conversationId);
      const current = contexts.get(conversationId) ?? contextFromConversation(conversation);
      const next: ConversationDispatchContext = {
        ...current,
        projectLocalPath: resolve(resolved.projectLocalPath),
        ...(resolved.writableRoots ? { writableRoots: resolved.writableRoots.map((root) => resolve(root)) } : {}),
        ...(resolved.executionWorkspaceMode ? { executionWorkspaceMode: resolved.executionWorkspaceMode } : {}),
      };
      contexts.set(conversationId, next);
      await persist();
    })();
    executionContextPromises.set(conversationId, promise);
    try {
      await promise;
    } finally {
      if (executionContextPromises.get(conversationId) === promise) executionContextPromises.delete(conversationId);
    }
  }

  function submissionText(submission: ZeusConversationSubmissionRecord): string {
    const text = parseJsonRecord(submission.inputJson).text;
    if (typeof text !== 'string') throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted submission text is invalid.');
    return text;
  }

  function submissionGoalObjective(submission: ZeusConversationSubmissionRecord): string | null {
    const value = parseJsonRecord(submission.inputJson).goalObjective;
    if (value === undefined) return null;
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 4_000) {
      throw coordinatorError('ZEUS_CODEX_GOAL_OBJECTIVE_INVALID', '目标必须为 1 到 4000 个字符。');
    }
    return value.trim();
  }

  function submissionAttachments(submission: ZeusConversationSubmissionRecord): NativeConversationAttachmentInput[] {
    const value = parseJsonRecord(submission.inputJson).attachments;
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment input is invalid.');
    return value.map((attachment) => {
      if (
        !isRecord(attachment) ||
        typeof attachment.name !== 'string' ||
        !attachment.name ||
        typeof attachment.mime !== 'string' ||
        !attachment.mime ||
        typeof attachment.size !== 'number' ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 0
      ) {
        throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment metadata is invalid.');
      }
      const localPath = typeof attachment.localPath === 'string' && attachment.localPath ? attachment.localPath : undefined;
      const uploadRef = typeof attachment.uploadRef === 'string' && attachment.uploadRef ? attachment.uploadRef : undefined;
      if ((localPath ? 1 : 0) + (uploadRef ? 1 : 0) !== 1) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment identity is invalid.');
      const authorizedPath = typeof attachment.authorizedPath === 'string' && attachment.authorizedPath ? attachment.authorizedPath : undefined;
      if (authorizedPath && (!localPath || uploadRef)) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment path authority is invalid.');
      const taskPushAttachmentKey = typeof attachment.taskPushAttachmentKey === 'string' && attachment.taskPushAttachmentKey.trim() ? attachment.taskPushAttachmentKey.trim() : undefined;
      return {
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        ...(localPath ? { localPath } : {}),
        ...(uploadRef ? { uploadRef } : {}),
        ...(authorizedPath ? { authorizedPath } : {}),
        ...(taskPushAttachmentKey ? { taskPushAttachmentKey } : {}),
      };
    });
  }

  function submissionBrowserComments(submission: ZeusConversationSubmissionRecord): Record<string, unknown>[] {
    const value = parseJsonRecord(submission.inputJson).browserComments;
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(isRecord)) {
      throw coordinatorError('ZEUS_NATIVE_BROWSER_COMMENTS_INVALID', 'Durable browser comment metadata is invalid.');
    }
    return value;
  }

  function submissionConversationContext(submission: ZeusConversationSubmissionRecord): Record<string, unknown> | null {
    const value = parseJsonRecord(submission.inputJson).conversationContext;
    if (value === undefined) return null;
    if (!isRecord(value) || !Array.isArray(value.responseAnnotations) || !Array.isArray(value.codeComments)) {
      throw coordinatorError('ZEUS_NATIVE_CONVERSATION_CONTEXT_INVALID', 'Durable conversation context metadata is invalid.');
    }
    return value;
  }

  function submissionProviderInput(submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext): Array<Record<string, unknown>> {
    const text = volatileSubmissionText.get(submission.id) ?? submissionText(submission);
    const attachments = submissionAttachments(submission);
    const allowedRoots = [...(context.allowedAttachmentRoots?.length ? context.allowedAttachmentRoots : [context.projectLocalPath]), ...(options.trustedAttachmentRoots ?? [])]
      .map(existingDirectoryRealpath)
      .filter((root, index, roots): root is string => Boolean(root) && roots.indexOf(root) === index);
    if (allowedRoots.length === 0 && attachments.length > 0) {
      throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_PROJECT_UNAVAILABLE', 'No trusted attachment root can be resolved.');
    }
    const providerAttachment = (attachment: NativeConversationAttachmentInput): Array<Record<string, unknown>> => {
      if (attachment.uploadRef) {
        throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_UPLOAD_UNSUPPORTED', 'Native attachment uploadRef has no provider resolver.');
      }
      const localPath = attachment.localPath;
      if (!localPath || !isAbsolute(localPath)) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Native attachment localPath must be absolute.');
      let canonicalPath: string;
      let attachmentKind: 'file' | 'directory';
      try {
        canonicalPath = realpathSync(localPath);
        const pathStat = statSync(canonicalPath);
        const exactlyAuthorized = Boolean(attachment.authorizedPath) && realpathSync(attachment.authorizedPath!) === canonicalPath;
        if ((!exactlyAuthorized && !allowedRoots.some((root) => isInsideRoot(canonicalPath, root))) || (!pathStat.isFile() && !pathStat.isDirectory())) {
          throw new Error('outside trusted roots or not a file/directory');
        }
        attachmentKind = pathStat.isDirectory() ? 'directory' : 'file';
      } catch {
        throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_PATH_UNAVAILABLE', 'Native attachment must resolve to an authorized file or directory.');
      }
      if (isSupportedLocalImageAttachment(attachment, canonicalPath)) return [{ type: 'localImage', path: canonicalPath }];
      return [
        {
          type: 'text',
          text: `<zeus_attachment>\n${JSON.stringify({ kind: attachmentKind, name: attachment.name, path: canonicalPath })}\n</zeus_attachment>`,
        },
        { type: 'mention', name: attachment.name, path: canonicalPath },
      ];
    };
    const taskPushLayout = readNativeSubmissionTaskPushLayout(submission);
    const skill = readNativeSubmissionSkill(submission);
    const inputs: Array<Record<string, unknown>> = skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : [];
    if (taskPushLayout) {
      const attachmentsByKey = new Map(attachments.flatMap((attachment) => (attachment.taskPushAttachmentKey ? [[attachment.taskPushAttachmentKey, attachment] as const] : [])));
      for (const part of buildTaskPushInputParts(taskPushLayout)) {
        if (part.type === 'text') {
          if (part.text) inputs.push({ type: 'text', text: part.text });
          continue;
        }
        const attachment = attachmentsByKey.get(part.attachmentKey);
        if (!attachment) throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', `Task push attachment placement is missing: ${part.attachmentKey}`);
        inputs.push(...providerAttachment(attachment));
      }
    } else {
      if (text.trim()) inputs.push({ type: 'text', text });
      for (const attachment of attachments) inputs.push(...providerAttachment(attachment));
    }
    if (inputs.length === 0) throw coordinatorError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'Native submission requires text or attachments.');
    return inputs;
  }

  function toQueueSnapshot(conversationId: string): NativeQueueSnapshot {
    const entries = options.submissions.listByConversation(conversationId).filter((submission) => (submission.status === 'queued' || submission.status === 'paused') && !submission.providerTurnId);
    const state = runStates.get(conversationId) ?? { type: 'idle' as const };
    return {
      conversationId,
      state,
      waitReason: queueWaitReason(conversationId, state, entries),
      submissions: entries.map((submission, index) => {
        const input = parseJsonRecord(submission.inputJson);
        const error = submissionErrorSnapshot(submission.errorJson);
        const recoveryKind = readNativeSubmissionRecoveryKind(submission, input);
        return {
          id: submission.id,
          conversationId: submission.conversationId,
          content:
            (typeof input.displayText === 'string' ? input.displayText.trim() : '') ||
            submissionText(submission) ||
            submissionAttachments(submission)
              .map((attachment) => attachment.name)
              .join('、'),
          ...(typeof input.composerDraft === 'string' ? { composerDraft: input.composerDraft } : {}),
          status: submission.status as 'queued' | 'paused',
          delivery: input.delivery === 'steer_now' ? ('steer_now' as const) : ('queue' as const),
          attachments: submissionAttachments(submission),
          ...(submissionBrowserComments(submission).length ? { browserComments: submissionBrowserComments(submission) } : {}),
          ...(typeof input.browserCommentContent === 'string' ? { browserCommentContent: input.browserCommentContent } : {}),
          ...(submissionConversationContext(submission) ? { conversationContext: submissionConversationContext(submission)! } : {}),
          expectedTurnId: typeof input.expectedTurnId === 'string' ? input.expectedTurnId : null,
          clientUserMessageId: submission.clientMessageId,
          ...(input.origin === 'implement_plan' || input.origin === 'refine_plan' ? { controlAction: input.origin } : {}),
          ...(recoveryKind ? { recoveryKind } : {}),
          position: submission.queuePosition ?? index + 1,
          providerTurnId: null,
          pausedReason: submission.pausedReason,
          error,
          createdAt: submission.createdAt,
          updatedAt: submission.updatedAt,
        };
      }),
    };
  }

  function queueWaitReason(conversationId: string, state: NativeConversationRunState, entries: readonly ZeusConversationSubmissionRecord[]): NativeQueueWaitReason {
    if (state.type === 'active') return 'current_turn';
    if (state.type === 'dispatching') return 'dispatching';
    if (state.type === 'waiting') return state.reason;
    if (state.type === 'paused') return state.reason;
    if (hasPendingPlanImplementationRequest(conversationId)) return 'plan_confirmation';
    if (
      entries.some((submission) => {
        const input = parseJsonRecord(submission.inputJson);
        return isRecord(input.context) && input.context.holdDispatch === true;
      })
    ) {
      return 'execution_context_preparing';
    }
    if (entries.length > 0 && entries.every((submission) => submission.pausedReason === 'user_confirmation')) return 'user_confirmation';
    return 'dispatch_pending';
  }

  function createSubmission(
    conversationId: string,
    content: string,
    input: {
      submissionId?: string;
      idempotencyKey: string;
      clientUserMessageId: string;
      composerDraft?: string;
      attachments?: NativeConversationAttachmentInput[];
      browserComments?: Record<string, unknown>[];
      browserCommentContent?: string;
      conversationContext?: Record<string, unknown>;
      displayText?: string;
      taskPushLayout?: TaskPushMessageLayout;
      origin?: 'implement_plan' | 'refine_plan';
      planItemId?: string;
      requestAnswerId?: string;
      internalOperation?: boolean;
      recoveryKind?: NativeSubmissionRecoveryKind;
      goalObjective?: string;
      skill?: NativeConversationSkillInput;
      requestedServiceTier?: string | null;
    },
    context: ConversationDispatchContext,
  ): ZeusConversationSubmissionRecord {
    const queuedCount = options.submissions.listByConversation(conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed').length;
    const payload: PersistedSubmissionInput = {
      text: content,
      ...(Object.prototype.hasOwnProperty.call(input, 'requestedServiceTier') ? { requestedServiceTier: input.requestedServiceTier } : {}),
      ...(typeof input.composerDraft === 'string' ? { composerDraft: input.composerDraft } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.browserComments?.length ? { browserComments: input.browserComments } : {}),
      ...(input.browserCommentContent ? { browserCommentContent: input.browserCommentContent } : {}),
      ...(input.conversationContext ? { conversationContext: input.conversationContext } : {}),
      context,
      ...(input.displayText ? { displayText: input.displayText } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.planItemId ? { planItemId: input.planItemId } : {}),
      ...(input.taskPushLayout ? { taskPushLayout: input.taskPushLayout } : {}),
      ...(input.requestAnswerId ? { requestAnswerId: input.requestAnswerId } : {}),
      ...(input.internalOperation ? { internalOperation: true } : {}),
      ...(input.recoveryKind ? { recoveryKind: input.recoveryKind } : {}),
      ...(input.goalObjective ? { goalObjective: input.goalObjective } : {}),
      ...(input.skill ? { skill: input.skill } : {}),
    };
    const existing = input.submissionId ? options.submissions.getById(input.submissionId) : undefined;
    if (existing) {
      if (existing.conversationId !== conversationId || existing.idempotencyKey !== input.idempotencyKey) {
        throw coordinatorError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Reserved submission id is already owned by another conversation operation.');
      }
      if (existing.requestHash !== requestHash(payload)) {
        throw coordinatorError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Reserved submission content is immutable and does not match this operation.');
      }
      projectLocallyAcceptedUserMessage({ conversations: options.conversations, submission: existing, broadcast: options.broadcast });
      return existing;
    }
    const submission = options.submissions.createOrGet({
      ...(input.submissionId ? { id: input.submissionId } : {}),
      conversationId,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash(payload),
      clientMessageId: input.clientUserMessageId,
      kind: 'message',
      requestedDelivery: 'queue',
      status: 'queued',
      queuePosition: queuedCount + 1,
      input: payload,
      createdAt: now(),
    });
    projectLocallyAcceptedUserMessage({ conversations: options.conversations, submission, broadcast: options.broadcast });
    return submission;
  }

  const {
    flushNotice: flushServiceTierDowngradeNotice,
    persistProviderReported: persistProviderReportedServiceTierDowngrade,
    persistSubmissionDispatchContext,
    record: recordServiceTierDowngrade,
  } = createCodexServiceTierDowngrade({
    db: options.db,
    conversations: options.conversations,
    submissions: options.submissions,
    broadcast: options.broadcast,
    now,
    contextFromSubmission,
    conversationMessageClientId,
  });

  function nextTurnSettingsFromContext(context: ConversationDispatchContext): ConversationNextTurnSettings {
    return {
      model: context.modelSourceId && context.modelSourceId !== 'codex' ? modelRef(context.modelSourceId, context.model) : context.model,
      ...(context.effort ? { effort: context.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? { serviceTier: context.serviceTier } : {}),
      permissionMode: context.permissionMode,
      collaborationMode: context.workMode,
    };
  }

  function contextWithLatestNextTurnSettings(conversationId: string, context: ConversationDispatchContext): ConversationDispatchContext {
    const settings = options.conversations.getNextTurnSettings(conversationId);
    if (!settings) return context;
    const selectedModelRef = parseModelRef(settings.model);
    const latest: ConversationDispatchContext = {
      ...context,
      model: selectedModelRef?.modelId ?? settings.model,
      modelSourceId: selectedModelRef?.sourceId ?? (settings.model === context.model ? context.modelSourceId : null),
      permissionMode: settings.permissionMode,
      workMode: settings.collaborationMode,
    };
    delete latest.effort;
    delete latest.serviceTier;
    if (settings.effort) latest.effort = settings.effort;
    if (Object.prototype.hasOwnProperty.call(settings, 'serviceTier')) latest.serviceTier = settings.serviceTier;
    return latest;
  }

  function planControlModeForSubmission(submission: ZeusConversationSubmissionRecord): ConversationCollaborationMode | null {
    const origin = parseJsonRecord(submission.inputJson).origin;
    if (origin === 'implement_plan') return 'default';
    if (origin === 'refine_plan') return 'plan';
    return null;
  }

  function dispatchContextForSubmission(submission: ZeusConversationSubmissionRecord): ConversationDispatchContext {
    const latest = contextWithLatestNextTurnSettings(submission.conversationId, contextFromSubmission(submission));
    const controlMode = planControlModeForSubmission(submission);
    if (!controlMode) return latest;
    // 计划控制动作的模式属于动作语义，排队期间不能被下一轮设置覆盖。
    return {
      ...latest,
      workMode: controlMode,
    };
  }

  async function startTaskConversation(input: StartTaskConversationInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    if (!input.holdDispatch) await assertCodexAccountReady(input.modelSourceId ?? null, input.model);
    const legacyContext = resolveLegacyReference(input);
    const additionalContext = mergeCodexAdditionalContext(input.additionalContext, legacyContext ? { zeus_legacy_reference: legacyContext } : undefined);
    const existingConversation = input.conversationId ? options.conversations.getById(input.conversationId) : undefined;
    const permissionMode = existingConversation?.permissionMode ?? input.permissionMode ?? (input.allowCodeChanges ? 'auto' : 'read-only');
    const context: ConversationDispatchContext = {
      projectId: input.projectId,
      projectLocalPath: resolve(input.projectLocalPath),
      taskId: input.taskId,
      ...(input.executionWorkspaceMode ? { executionWorkspaceMode: input.executionWorkspaceMode } : {}),
      model: input.model,
      modelSourceId: input.modelSourceId ?? null,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'serviceTier') ? { serviceTier: input.serviceTier } : {}),
      allowCodeChanges: input.allowCodeChanges,
      allowTests: input.allowTests,
      allowGitCommit: input.allowGitCommit,
      permissionMode,
      ...(input.allowedAttachmentRoots?.length ? { allowedAttachmentRoots: input.allowedAttachmentRoots.map((root) => resolve(root)) } : {}),
      ...(input.writableRoots?.length ? { writableRoots: input.writableRoots.map((root) => resolve(root)) } : {}),
      workMode: input.workMode ?? existingConversation?.collaborationMode ?? 'default',
      ...(input.applyLegacyTaskGuards === false ? { applyLegacyTaskGuards: false } : {}),
      ...(input.ephemeral ? { ephemeral: true } : {}),
      ...(additionalContext ? { additionalContext } : {}),
      ...(input.operationContext ? { operationContext: input.operationContext } : {}),
      ...(input.holdDispatch ? { holdDispatch: true } : {}),
    };
    if (
      existingConversation &&
      (existingConversation.projectId !== input.projectId ||
        existingConversation.taskId !== input.taskId ||
        existingConversation.workspaceId !== (input.workspaceId ?? null) ||
        existingConversation.environmentId !== (input.environmentId ?? null) ||
        existingConversation.transportKind !== 'codex_native')
    ) {
      throw coordinatorError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Reserved native conversation id is already owned by another resource.');
    }
    const conversation =
      existingConversation ??
      options.conversations.create({
        ...(input.conversationId ? { id: input.conversationId } : {}),
        projectId: input.projectId,
        taskId: input.taskId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        title: input.conversationTitle?.trim().slice(0, 80) || `任务会话：${input.taskTitle.slice(0, 48)}`,
        summary: input.prompt.slice(0, 240),
        status: 'starting',
        transportKind: 'codex_native',
        providerId: 'codex',
        providerModel: input.model,
        modelSourceId: input.modelSourceId ?? undefined,
        modelId: input.model,
        providerState: 'unbound',
        legacySourceConversationId: input.legacyReference?.conversationId,
        permissionMode,
        collaborationMode: context.workMode,
      });
    if (conversation.collaborationMode !== context.workMode) options.conversations.updateCollaborationMode(conversation.id, context.workMode);
    options.conversations.updateNextTurnSettings(conversation.id, nextTurnSettingsFromContext(context));
    contexts.set(conversation.id, context);
    runStates.set(conversation.id, { type: 'idle' });
    const releasedSubmissions = input.holdDispatch ? new Map<string, ZeusConversationSubmissionRecord>() : releaseHeldSubmissions(conversation.id, context);
    const submission = (input.submissionId ? releasedSubmissions.get(input.submissionId) : undefined) ?? createSubmission(conversation.id, input.prompt, input, context);
    await input.segmentLifecycle?.prepare(submission);
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    if (input.holdDispatch) return accepted(submission, 'queued', null, null);
    if (input.deferInitialDispatch) {
      // 冲突会话先把稳定身份和用户消息交给界面，Provider 启动失败由会话队列继续呈现和恢复。
      requestQueueDrain();
      return accepted(submission, 'queued', null, null);
    }
    return dispatchSubmission(conversation, submission, input.providerWriteLifecycle, false, input.segmentLifecycle);
  }

  async function startProjectConversation(input: StartProjectConversationInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    await assertCodexAccountReady(input.modelSourceId ?? null, input.model);
    const title = projectNativeConversationTitle(input.prompt, input.attachments);
    const existingConversation = input.conversationId ? options.conversations.getById(input.conversationId) : undefined;
    const permissionMode = existingConversation?.permissionMode ?? input.permissionMode ?? 'auto';
    const context: ConversationDispatchContext = {
      projectId: input.projectId,
      projectLocalPath: resolve(input.projectLocalPath),
      taskId: null,
      model: input.model,
      modelSourceId: input.modelSourceId ?? null,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'serviceTier') ? { serviceTier: input.serviceTier } : {}),
      allowCodeChanges: permissionMode !== 'read-only',
      allowTests: permissionMode !== 'read-only',
      allowGitCommit: false,
      permissionMode,
      workMode: input.collaborationMode ?? existingConversation?.collaborationMode ?? 'default',
    };
    if (existingConversation && (existingConversation.projectId !== input.projectId || existingConversation.taskId !== null || existingConversation.transportKind !== 'codex_native')) {
      throw coordinatorError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Reserved project conversation id is already owned by another resource.');
    }
    const conversation =
      existingConversation ??
      options.conversations.create({
        ...(input.conversationId ? { id: input.conversationId } : {}),
        projectId: input.projectId,
        title,
        summary: [...input.prompt].slice(0, 240).join('') || input.attachments?.[0]?.name || '',
        status: 'starting',
        transportKind: 'codex_native',
        providerId: 'codex',
        providerModel: input.model,
        modelSourceId: input.modelSourceId ?? undefined,
        modelId: input.model,
        providerState: 'unbound',
        permissionMode,
        collaborationMode: context.workMode,
      });
    if (conversation.collaborationMode !== context.workMode) options.conversations.updateCollaborationMode(conversation.id, context.workMode);
    options.conversations.updateNextTurnSettings(conversation.id, nextTurnSettingsFromContext(context));
    contexts.set(conversation.id, context);
    runStates.set(conversation.id, { type: 'idle' });
    const submission = createSubmission(conversation.id, input.prompt, input, context);
    await input.segmentLifecycle?.prepare(submission);
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    if (input.deferInitialDispatch) return accepted(submission, 'queued', null, null);
    return dispatchSubmission(conversation, submission, input.providerWriteLifecycle, false, input.segmentLifecycle);
  }

  /** 创建任何产品会话前复验账号，避免先持久化一条必然失败的占位会话。 */
  async function assertCodexAccountReady(modelSourceId: string | null, model: string): Promise<void> {
    if (options.resolveResponsesRuntime && (await options.resolveResponsesRuntime({ modelSourceId, model }))) return;
    const account = await options.manager.readAccount({ cachedOnly: true }).catch((error: unknown) => {
      // 无本地快照时由真实 thread/turn RPC 权威认证，账号探测不再成为派发门禁。
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ZEUS_CODEX_ACCOUNT_SNAPSHOT_UNAVAILABLE') return null;
      throw error;
    });
    if (!account || !account.requiresOpenaiAuth || account.signedIn) return;
    throw coordinatorError('ZEUS_CODEX_LOGIN_REQUIRED', 'Zeus 专属 Codex 尚未登录。请先完成登录，再创建会话。');
  }

  async function responsesRuntimeFor(context: Pick<ConversationDispatchContext, 'modelSourceId' | 'model'>): Promise<CodexResponsesRuntime | null> {
    return options.resolveResponsesRuntime?.({ modelSourceId: context.modelSourceId, model: context.model }) ?? null;
  }

  function projectGoal(conversationId: string, goal: CodexThreadGoal, providerTurnId: string | null, occurredAt: string) {
    const previous = goals.get(conversationId);
    if (previous && previous.providerUpdatedAt > goal.updatedAt) return previous;
    const eventKind = codexGoalEventKind(previous, goal);
    const projected = goals.upsert(
      {
        conversationId,
        providerThreadId: goal.threadId,
        objective: goal.objective,
        status: goal.status,
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        providerCreatedAt: goal.createdAt,
        providerUpdatedAt: goal.updatedAt,
      },
      { ...(eventKind ? { eventKind } : {}), providerTurnId, occurredAt },
    );
    const terminalAttention = goal.status === 'complete' || goal.status === 'blocked' || goal.status === 'usageLimited' || goal.status === 'budgetLimited';
    if (eventKind && terminalAttention) {
      options.conversations.markAttentionUnread(conversationId, {
        kind: goal.status === 'complete' ? 'completed' : 'unread',
        turnId: providerTurnId,
        occurredAt,
      });
    }
    options.broadcast('conversation.goal.updated', {
      conversationId,
      goal: projected,
      timeline: goals.listEvents(conversationId),
      eventKind: eventKind ?? null,
      notificationEligible: Boolean(eventKind && terminalAttention),
    });
    return projected;
  }

  async function requireGoalConversation(conversationId: string) {
    assertOpen();
    await ensureGenerationReconciled([conversationId]);
    const conversation = requireConversation(conversationId);
    if (!conversation.providerThreadId) throw coordinatorError('ZEUS_CODEX_GOAL_THREAD_REQUIRED', '创建目标前必须先建立原生会话。');
    const capabilities = options.manager.getState();
    if (capabilities.type !== 'ready' || !capabilities.capabilities.goals.supported || !capabilities.capabilities.goals.enabled) {
      throw coordinatorError('ZEUS_CODEX_GOALS_UNAVAILABLE', '当前 Agent 或 app-server 不支持原生目标。');
    }
    return { conversation, threadId: conversation.providerThreadId };
  }

  const { setGoal, readGoal, pauseGoal, resumeGoal, clearGoal } = createCodexGoalApplication({
    manager: options.manager,
    goals,
    providerCommands,
    prepareConversation: requireGoalConversation,
    projectGoal,
    persist,
    broadcast: options.broadcast,
    now,
  });

  async function startEphemeralConversation(input: StartNativeEphemeralConversationInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    await assertCodexAccountReady(null, input.model);
    const context: ConversationDispatchContext = {
      projectId: input.projectId,
      projectLocalPath: resolve(input.projectLocalPath),
      taskId: null,
      model: input.model,
      modelSourceId: null,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'serviceTier') ? { serviceTier: input.serviceTier } : {}),
      allowCodeChanges: false,
      allowTests: false,
      allowGitCommit: false,
      permissionMode: 'read-only',
      workMode: 'default',
      ephemeral: true,
    };
    const conversation = options.conversations.create({
      ...(input.conversationId ? { id: input.conversationId } : {}),
      projectId: input.projectId,
      title: input.title,
      summary: input.prompt.slice(0, 240),
      status: 'starting',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerModel: input.model,
      providerState: 'unbound',
      permissionMode: 'read-only',
      collaborationMode: 'default',
    });
    contexts.set(conversation.id, context);
    runStates.set(conversation.id, { type: 'idle' });
    const submission = createSubmission(conversation.id, input.prompt, input, context);
    await persist();
    const operation = await dispatchSubmission(conversation, submission);
    if (operation.status === 'queued') {
      await closeEphemeralConversation(conversation.id, null, 'cancelled', { code: 'ZEUS_CODEX_EPHEMERAL_DISPATCH_PENDING' }, false);
      throw coordinatorError('ZEUS_CODEX_EPHEMERAL_DISPATCH_PENDING', 'Codex native Graph question did not start immediately.');
    }
    if (operation.status === 'recovery_required') {
      throw coordinatorError('ZEUS_CODEX_EPHEMERAL_DISPATCH_FAILED', 'Codex native Graph provider dispatch failed.');
    }
    return operation;
  }

  function waitForTurnResult(input: WaitForNativeTurnResultInput): Promise<NativeTurnResult> {
    assertOpen();
    const key = `${input.conversationId}:${input.providerTurnId}`;
    const completed = completedTurnResults.get(key);
    if (completed) return Promise.resolve(completed);
    const failed = failedTurnResults.get(key);
    if (failed) return Promise.reject(failed);
    const persistedTurn = options.turns.listByConversation(input.conversationId).find((turn) => turn.providerTurnId === input.providerTurnId);
    if (persistedTurn?.status === 'failed') return Promise.reject(failedTurnErrorFromRecord(persistedTurn));
    const timeoutMs = input.timeoutMs ?? options.turnResultTimeoutMs ?? 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(coordinatorError('ZEUS_CODEX_TURN_RESULT_TIMEOUT_INVALID', 'Native turn result timeout must be a positive number.'));
    return new Promise((resolveResult, rejectResult) => {
      const waiters = turnResultWaiters.get(key) ?? [];
      const deadlineAt = Date.now() + timeoutMs;
      const scheduleSegment = (): ReturnType<typeof setTimeout> =>
        setTimeout(
          () => {
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs > 0) {
              waiter.timer = scheduleSegment();
              return;
            }
            void turnResultRecovery.timeoutTurnResult(input, key).catch((error) => rejectResult(error instanceof Error ? error : new Error(String(error))));
          },
          Math.min(Math.max(1, deadlineAt - Date.now()), 24 * 60 * 60 * 1_000),
        );
      const waiter: NativeTurnResultWaiter = {
        resolve: resolveResult,
        reject: rejectResult,
        timer: scheduleSegment(),
      };
      waiters.push(waiter);
      turnResultWaiters.set(key, waiters);
    });
  }

  function resolveLegacyReference(input: StartTaskConversationInput): CodexAdditionalContextEntry | undefined {
    if (!input.legacyReference) return undefined;
    const legacy = options.conversations.getById(input.legacyReference.conversationId);
    if (!legacy || legacy.transportKind !== 'legacy_cli') throw coordinatorError('ZEUS_LEGACY_CONVERSATION_NOT_FOUND', 'Selected legacy conversation was not found.');
    const selected = new Set(input.legacyReference.messageIds);
    if (selected.size !== input.legacyReference.messageIds.length) throw coordinatorError('ZEUS_LEGACY_MESSAGE_SELECTION_INVALID', 'Legacy message ids must be explicit and unique.');
    const messages = input.legacyReference.messageIds.map((messageId) => {
      const message = legacy.messages.find((candidate) => candidate.id === messageId);
      if (!message) throw coordinatorError('ZEUS_LEGACY_MESSAGE_SELECTION_INVALID', `Legacy message does not belong to selected conversation: ${messageId}`);
      return { messageId: message.id, role: message.role, content: message.content };
    });
    return { kind: 'untrusted', value: JSON.stringify({ conversationId: legacy.id, items: messages }) };
  }

  async function submitMessage(input: SubmitNativeMessageInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const requiresNewSegment = input.segmentLifecycle?.requiresNewSegment === true;
    const conversation = requiresNewSegment ? requireProductConversation(input.conversationId) : requireConversation(input.conversationId);
    if (!requiresNewSegment && hasRecoveredUnsentSubmission(options.submissions.listByConversation(conversation.id))) {
      throw coordinatorError('ZEUS_RECOVERED_UNSENT_CONFIRMATION_REQUIRED', '恢复后有多条尚未发送的消息，请先逐条重试或取消。');
    }
    const previousContext = contextWithLatestNextTurnSettings(conversation.id, contexts.get(conversation.id) ?? contextFromConversation(conversation));
    const context: ConversationDispatchContext = {
      ...previousContext,
      permissionMode: input.permissionMode ?? previousContext.permissionMode,
      workMode: input.collaborationMode ?? conversation.collaborationMode,
      ...(input.model ? { model: input.model } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'modelSourceId') ? { modelSourceId: input.modelSourceId ?? null } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'serviceTier') ? { serviceTier: input.serviceTier } : {}),
    };
    if (input.model && input.model !== previousContext.model && !input.effort) delete context.effort;
    options.conversations.updateNextTurnSettings(conversation.id, nextTurnSettingsFromContext(context));
    const submission = createSubmission(conversation.id, input.content, input, context);
    await input.segmentLifecycle?.prepare(submission);
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    if (input.deferDispatch) return accepted(submission, 'queued', conversation.providerThreadId, null);
    if (!requiresNewSegment && providerStopRecovery.hasPendingEvidence(conversation.id)) {
      const recovery = await providerStopRecovery.recoverForNewSubmission(conversation.id);
      if (recovery === 'pending') return accepted(options.submissions.getById(submission.id) ?? submission, 'queued', conversation.providerThreadId, null);
      if (recovery === 'recovery_required') return accepted(options.submissions.getById(submission.id) ?? submission, 'recovery_required', conversation.providerThreadId, null);
    }
    if (context.holdDispatch) return accepted(submission, 'queued', conversation.providerThreadId, null);
    if (hasPendingPlanImplementationRequest(conversation.id)) return accepted(submission, 'queued', conversation.providerThreadId, null);
    try {
      if (!requiresNewSegment) await ensureGenerationReconciled([conversation.id]);
    } catch (error) {
      return pauseQueueAfterDispatchFailure(conversation, submission, error);
    }
    let refreshed = requiresNewSegment ? requireProductConversation(conversation.id) : requireConversation(conversation.id);
    if (!requiresNewSegment && refreshed.providerState === 'archived') {
      try {
        await restoreArchivedProviderThread(refreshed.id);
        refreshed = requireConversation(refreshed.id);
      } catch {
        return accepted(submission, 'provider_archived', refreshed.providerThreadId, null);
      }
    }
    try {
      await ensureConversationExecutionContext(refreshed.id, 'submit', requiresNewSegment);
      const recoveryState = runStates.get(refreshed.id) ?? inferRunState(refreshed);
      if (!requiresNewSegment && recoveryState.type === 'paused' && recoveryState.reason === 'recovery_required') {
        refreshed = await recoverPausedConversation(refreshed.id, 'submit');
      }
    } catch (error) {
      if (!requiresNewSegment && refreshed.providerThreadId) return pauseQueueAfterDispatchFailure(refreshed, submission, error);
      const failure = serializeError(error);
      options.submissions.updateStatus(submission.id, 'failed', {
        error: failure,
        resolvedAt: now(),
      });
      await persist();
      options.broadcast('conversation.native.error', {
        conversationId: refreshed.id,
        providerThreadId: refreshed.providerThreadId,
        error: { ...failure, recoveryRequired: false },
      });
      options.broadcast('conversation.queue.changed', { conversationId: refreshed.id });
      throw error;
    }
    let state = runStates.get(conversation.id) ?? inferRunState(refreshed);
    if (state.type === 'idle' || state.type === 'paused') {
      let pausedStaleSubmission = false;
      for (const staleSubmission of options.submissions.listByConversation(conversation.id)) {
        if (staleSubmission.id === submission.id || staleSubmission.providerTurnId || staleSubmission.status !== 'queued') continue;
        options.submissions.updateStatus(staleSubmission.id, 'paused', {
          pausedReason: 'interrupted',
          updatedAt: now(),
        });
        pausedStaleSubmission = true;
      }
      if (pausedStaleSubmission) await persist();
      if (state.type === 'paused') {
        // 旧失败、恢复或中断内容只保留在审计账本；用户此刻的新消息拥有明确意图，直接续接原会话。
        state = { type: 'idle' };
      }
    }
    runStates.set(conversation.id, state);
    if (state.type !== 'idle') {
      if (state.type === 'active' && refreshed.providerThreadId) providerThreadAuthority.observe(conversation.id, refreshed.providerThreadId);
      return accepted(submission, 'queued', refreshed.providerThreadId, null);
    }
    return dispatchSubmission(refreshed, submission, input.providerWriteLifecycle, false, input.segmentLifecycle);
  }

  async function dispatchQueuedMessage(input: { conversationId: string; submissionId: string; segmentLifecycle: ConversationSegmentLifecycle }): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = input.segmentLifecycle.requiresNewSegment ? requireProductConversation(input.conversationId) : requireConversation(input.conversationId);
    const submission = requireOwnedSubmission(input.conversationId, input.submissionId);
    if (submission.status !== 'queued') {
      throw coordinatorError('ZEUS_NATIVE_SUBMISSION_NOT_QUEUED', 'Only a queued native submission can be dispatched.');
    }
    if (!submission.executionSnapshotId) {
      throw coordinatorError('ZEUS_CONVERSATION_EXECUTION_SNAPSHOT_REQUIRED', 'Queued submission does not have a frozen execution snapshot.');
    }

    // 统一队列排空必须沿用首次接受时的提交和请求哈希。再次调用 submitMessage 会重建 payload，
    // 既破坏不可变审计身份，也会让相同 idempotency key 被存储层判定为冲突。
    await input.segmentLifecycle.prepare(submission);
    await persist();
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    runStates.set(conversation.id, state);
    if (state.type !== 'idle') {
      if (state.type === 'active' && conversation.providerThreadId) providerThreadAuthority.observe(conversation.id, conversation.providerThreadId);
      return accepted(submission, 'queued', conversation.providerThreadId, null);
    }
    return dispatchSubmission(conversation, submission, undefined, false, input.segmentLifecycle);
  }

  async function steerMessage(input: SteerNativeMessageInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const context = contextWithLatestNextTurnSettings(conversation.id, contexts.get(conversation.id) ?? contextFromConversation(conversation));
    const queuedCount = options.submissions.listByConversation(conversation.id).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed').length;
    const payload: PersistedSubmissionInput = {
      text: input.content,
      ...(typeof input.composerDraft === 'string' ? { composerDraft: input.composerDraft } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.browserComments?.length ? { browserComments: input.browserComments } : {}),
      ...(input.browserCommentContent ? { browserCommentContent: input.browserCommentContent } : {}),
      ...(input.conversationContext ? { conversationContext: input.conversationContext } : {}),
      context,
      ...(input.displayText ? { displayText: input.displayText } : {}),
      delivery: 'steer_now',
      expectedTurnId: input.expectedTurnId,
      ...(input.requestAnswerId ? { requestAnswerId: input.requestAnswerId } : {}),
    };
    const existingSubmission = input.requestAnswerId ? options.submissions.listByConversation(conversation.id).find((candidate) => candidate.idempotencyKey === input.idempotencyKey) : undefined;
    const submission = options.submissions.createOrGet({
      conversationId: conversation.id,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash(payload),
      clientMessageId: input.clientUserMessageId,
      kind: 'steer',
      requestedDelivery: 'send_now',
      status: 'dispatching',
      queuePosition: queuedCount + 1,
      input: payload,
      targetProviderTurnId: input.expectedTurnId,
      providerTurnId: input.expectedTurnId,
      createdAt: now(),
      dispatchedAt: now(),
    });
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);

    if (existingSubmission) {
      if (existingSubmission.status === 'dispatching' || existingSubmission.status === 'active') {
        return accepted(existingSubmission, 'steering', conversation.providerThreadId, input.expectedTurnId);
      }
      if (existingSubmission.status === 'resolved' || existingSubmission.status === 'completed') {
        return accepted(existingSubmission, 'steered', conversation.providerThreadId, input.expectedTurnId);
      }
      if (existingSubmission.status === 'queued') return accepted(existingSubmission, 'queued', conversation.providerThreadId, null);
      throw coordinatorError('ZEUS_REQUEST_ANSWER_ATTACHMENT_DELIVERY_UNCERTAIN', 'The request answer attachment delivery result is uncertain and will not be repeated automatically.');
    }

    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if ((state.type !== 'active' && state.type !== 'waiting') || state.turnId !== input.expectedTurnId) {
      const requeued = options.submissions.requeueRejectedSteer(submission.id, now());
      await persist();
      options.broadcast('conversation.queue.changed', {
        conversationId: conversation.id,
        queue: toQueueSnapshot(conversation.id),
      });
      requestQueueDrain();
      return accepted(requeued, 'queued', conversation.providerThreadId, null);
    }

    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    input.providerWriteLifecycle?.markRpcStarted(submission.id);
    try {
      await executeTurnCommand({
        operation: 'turn_steer',
        conversationId: conversation.id,
        threadId: providerThreadId,
        turnId: input.expectedTurnId,
        commandKey: submission.id,
        requestIdentity: { submissionId: submission.id, clientUserMessageId: submission.clientMessageId, requestHash: submission.requestHash },
        issuedAt: submission.createdAt,
        invoke: (traceIdentity) =>
          options.manager.steerTurn({
            threadId: providerThreadId,
            turnId: input.expectedTurnId,
            clientUserMessageId: submission.clientMessageId,
            input: submissionProviderInput(submission, context),
            traceIdentity,
          }),
        isExplicitRejection: isProviderTurnAlreadyEndedSteerError,
      });
    } catch (error) {
      if (isProviderTurnAlreadyEndedSteerError(error)) {
        options.submissions.requeueRejectedSteer(submission.id, now());
        await persist();
        await providerEvents.waitForIdle();
        try {
          const metadata = await options.manager.readThread({ threadId: providerThreadId });
          await enqueueProviderTurnReconciliation(requireConversation(conversation.id));
          const snapshot = projectedProviderThreadSnapshot(conversation.id, metadata);
          const generationId = options.manager.generationForThread(providerThreadId) ?? readyGenerationId();
          if (generationId) reconcileConversationSnapshot(requireConversation(conversation.id), snapshot, generationId);
        } catch (reconcileError) {
          options.broadcast('conversation.native.steer_requeued', {
            conversationId: conversation.id,
            providerThreadId,
            providerTurnId: input.expectedTurnId,
            submissionId: submission.id,
            reconciliationError: serializeError(reconcileError),
          });
        }
        const confirmedQueued = options.submissions.requeueRejectedSteer(submission.id, now());
        await persist();
        options.broadcast('conversation.queue.changed', {
          conversationId: conversation.id,
          queue: toQueueSnapshot(conversation.id),
        });
        requestQueueDrain();
        return accepted(confirmedQueued, 'queued', providerThreadId, null);
      }
      options.submissions.updateStatus(submission.id, 'paused', {
        providerTurnId: input.expectedTurnId,
        pausedReason: 'recovery_required',
        error: toRecoverySubmissionError(error),
        updatedAt: now(),
      });
      await persist();
      options.broadcast('conversation.submission.steering', {
        conversationId: conversation.id,
        submissionId: submission.id,
        providerThreadId,
        providerTurnId: input.expectedTurnId,
      });
      throw error;
    }

    // turn/steer 成功只证明 Provider 接受了请求，不证明对应用户消息已经进入轮次。
    const steering = options.submissions.getById(submission.id) ?? submission;
    options.broadcast('conversation.submission.steering', {
      conversationId: conversation.id,
      submissionId: submission.id,
      providerThreadId,
      providerTurnId: input.expectedTurnId,
    });
    return accepted(steering, 'steering', providerThreadId, input.expectedTurnId);
  }

  const contextFromConversation = (conversation: ZeusConversationWithMessagesRecord): ConversationDispatchContext =>
    contextFromPersistedConversation({ conversation, submissions: options.submissions.listByConversation(conversation.id), turns: options.turns.listByConversation(conversation.id) });

  const inferRunState = (conversation: ZeusConversationWithMessagesRecord): NativeConversationRunState =>
    inferNativeConversationRunState(conversation, { submissions: options.submissions, turns: options.turns, requests: options.requests }, isPendingInteractionAuthority);

  async function recoverPausedConversation(conversationId: string, mode: 'submit' | 'dispatch' | 'recover_queue' | 'restore'): Promise<ZeusConversationWithMessagesRecord> {
    let conversation = requireConversation(conversationId);
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (state.type !== 'paused' || state.reason !== 'recovery_required') return conversation;
    await ensureConversationExecutionContext(conversation.id, mode);
    const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
    if (!conversation.providerThreadId) {
      const recoverableBeforeProviderStart =
        context.executionWorkspaceMode === 'direct' &&
        options.submissions.listByConversation(conversation.id).some((submission) => {
          if (submission.status !== 'paused' || submission.providerTurnId || submission.pausedReason !== 'recovery_required') return false;
          return submission.errorJson ? parseJsonRecord(submission.errorJson).code === 'ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE' : false;
        });
      if (!recoverableBeforeProviderStart) {
        throw coordinatorError('ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', 'The paused conversation has no provider thread that can be safely resumed.');
      }
      // 该错误发生在 Provider RPC 之前；恢复原提交是安全重试，不会重复创建线程或重复发送。
      runStates.set(conversation.id, { type: 'idle' });
      return conversation;
    }
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    const authority = await providerThreadAuthority.inspect(conversation, context);
    if (authority.type === 'active') {
      await persist();
      options.broadcast('conversation.thread.changed', {
        conversationId: conversation.id,
        providerThreadId,
        providerState: 'active',
      });
      options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId, providerState: 'active' });
      return requireConversation(conversation.id);
    }
    conversation = options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'ready',
    });
    runStates.set(conversation.id, { type: 'idle' });
    await persist();
    options.broadcast('conversation.thread.changed', {
      conversationId: conversation.id,
      providerThreadId,
      providerState: 'ready',
    });
    options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId, providerState: 'ready' });
    return conversation;
  }

  function readyGenerationId(): string | null {
    const state = options.manager.getState();
    return state.type === 'ready' ? state.generationId : null;
  }

  function dispatchSubmission(
    conversationInput: ZeusConversationWithMessagesRecord | ReturnType<ConversationRepository['create']>,
    submission: ZeusConversationSubmissionRecord,
    providerWriteLifecycle?: NativeProviderWriteLifecycle,
    providerArchiveRecoveryAttempted = false,
    segmentLifecycle?: ConversationSegmentLifecycle,
  ): Promise<NativeAcceptedOperation> {
    // 接口直派和后台队列排空共享会话级派发租约；同一提交只能启动一次 Provider 轮次。
    const activeLease = dispatchLeases.get(conversationInput.id);
    if (activeLease) {
      if (activeLease.submissionId !== submission.id) {
        const conversation = options.conversations.getById(conversationInput.id);
        return Promise.resolve(accepted(submission, 'queued', conversation?.providerThreadId ?? null, null));
      }
      attachDispatchLifecycle(activeLease, providerWriteLifecycle);
      if (activeLease.promise) return activeLease.promise;
    }

    const lease: NativeConversationDispatchLease = {
      submissionId: submission.id,
      lifecycles: new Set(),
      rpcStartedResourceId: null,
    };
    attachDispatchLifecycle(lease, providerWriteLifecycle);
    const promise = dispatchSubmissionWithLease(conversationInput, submission, lease, providerArchiveRecoveryAttempted, segmentLifecycle).finally(() => {
      if (dispatchLeases.get(conversationInput.id) === lease) dispatchLeases.delete(conversationInput.id);
    });
    lease.promise = promise;
    dispatchLeases.set(conversationInput.id, lease);
    return promise;
  }

  async function dispatchSubmissionWithLease(
    conversationInput: ZeusConversationWithMessagesRecord | ReturnType<ConversationRepository['create']>,
    submission: ZeusConversationSubmissionRecord,
    lease: NativeConversationDispatchLease,
    providerArchiveRecoveryAttempted: boolean,
    segmentLifecycle?: ConversationSegmentLifecycle,
    serviceTierFallbackAttempted = false,
  ): Promise<NativeAcceptedOperation> {
    let conversation = options.conversations.getById(conversationInput.id);
    if (!conversation) throw coordinatorError('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Native conversation was not found.');
    if (!serviceTierFallbackAttempted) await segmentLifecycle?.beginDispatch();
    try {
      await ensureConversationExecutionContext(conversation.id, 'dispatch', segmentLifecycle?.requiresNewSegment === true);
      const recoveryState = runStates.get(conversation.id) ?? inferRunState(conversation);
      if (!segmentLifecycle?.requiresNewSegment && recoveryState.type === 'paused' && recoveryState.reason === 'provider_stop_pending') {
        return accepted(submission, 'queued', conversation.providerThreadId, null);
      }
      if (!segmentLifecycle?.requiresNewSegment && recoveryState.type === 'paused' && recoveryState.reason === 'recovery_required') {
        conversation = await recoverPausedConversation(conversation.id, 'dispatch');
      }
    } catch (error) {
      options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'recovery_required', error: toRecoverySubmissionError(error), updatedAt: now() });
      runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      await persist();
      options.broadcast('conversation.native.recovery_failed', {
        conversationId: conversation.id,
        providerThreadId: conversation.providerThreadId,
        submissionId: submission.id,
        error: serializeError(error),
      });
      return accepted(submission, 'recovery_required', conversation.providerThreadId, null);
    }
    const context = dispatchContextForSubmission(submission);
    if (conversation.permissionMode !== context.permissionMode) options.conversations.updatePermissionMode(conversation.id, context.permissionMode);
    if (conversation.collaborationMode !== context.workMode) options.conversations.updateCollaborationMode(conversation.id, context.workMode);
    conversation = segmentLifecycle?.requiresNewSegment ? conversation : requireConversation(conversation.id);
    contexts.set(conversation.id, context);
    let candidateProviderThreadId: string | null = null;
    let commandOutboxId: string | null = null;
    let commandTraceIdentity: string | null = null;
    let commandProviderGenerationId: string | null = null;
    let providerWriteStarted = false;
    let threadStartedForSubmission = false;
    try {
      if (!segmentLifecycle?.requiresNewSegment) await ensureGenerationReconciled([conversation.id]);
      conversation = options.conversations.getById(conversation.id) ?? conversation;
      if (!segmentLifecycle?.requiresNewSegment && conversation.providerThreadId) {
        const reconciledState = runStates.get(conversation.id) ?? inferRunState(conversation);
        if (reconciledState.type === 'active') {
          providerThreadAuthority.observe(conversation.id, conversation.providerThreadId);
          return accepted(submission, 'queued', conversation.providerThreadId, null);
        }
        if (reconciledState.type === 'waiting' || reconciledState.type === 'dispatching') {
          return accepted(submission, 'queued', conversation.providerThreadId, null);
        }
        if (reconciledState.type !== 'idle') {
          return accepted(submission, 'recovery_required', conversation.providerThreadId, null);
        }
        const authority = await providerThreadAuthority.inspect(conversation, context);
        if (authority.type === 'active') return accepted(submission, 'queued', conversation.providerThreadId, null);
        conversation = requireConversation(conversation.id);
      }
      if (hasPendingPlanImplementationRequest(conversation.id) && !planControlModeForSubmission(submission)) {
        return accepted(submission, 'queued', conversation.providerThreadId, null);
      }
      const freshDispatchEnvelope = conversationSubmissionDispatchEnvelope(submission);
      const existingDelivery = options.commandDeliveries.get(freshDispatchEnvelope.commandId);
      const dispatchEnvelope = existingDelivery ? parseStoredConversationSubmissionDispatchEnvelope(existingDelivery.inbox.envelopeJson, freshDispatchEnvelope) : freshDispatchEnvelope;
      const preparedDelivery = options.commandDeliveries.acceptAndPrepare({
        envelope: dispatchEnvelope,
        requestSha256: submission.requestHash,
        destinationKind: 'provider_turn',
        destinationId: 'codex:turn',
        resourceId: submission.id,
        occurredAt: now(),
        mutateBusinessState: () => options.submissions.updateStatus(submission.id, 'dispatching', { dispatchedAt: now() }),
      });
      commandOutboxId = preparedDelivery.outbox.id;
      commandTraceIdentity = dispatchEnvelope.traceIdentity ?? null;
      segmentLifecycle?.bindCommandDelivery({ outboxId: preparedDelivery.outbox.id, providerId: 'codex' });
      runStates.set(conversation.id, { type: 'dispatching', submissionId: submission.id });
      const responsesRuntime = await responsesRuntimeFor(context);
      if (responsesRuntime) {
        // 外部 Responses thread 在 app-server 重启后仍需先安装进程级 Provider 配置，再恢复原生 thread。
        await options.manager.ensureReady({
          commandPath: commandPath(),
          ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}),
          providerEnvironment: responsesRuntime.environment,
          responsesProvider: responsesRuntime.provider,
        });
      }
      let providerThreadId = segmentLifecycle?.requiresNewSegment ? null : conversation.providerThreadId;
      // Plugin Runtime 的会话上下文只存在于当前 Execution Host 进程。冷重启后的已有
      // Provider thread 不会再经过 thread/start，仍必须先按持久化身份恢复冻结的 Plugin
      // 激活集，否则 UserPromptSubmit 会在任何 Provider 写入前拒绝本次续聊。
      const pluginPreparation = await options.plugins?.prepare({
        conversationId: conversation.id,
        projectId: context.projectId,
        cwd: context.projectLocalPath,
        model: context.model,
        source: providerThreadId ? 'resume' : 'startup',
        ...(providerThreadId ? {} : { prompt: submissionText(submission) }),
      });
      const developerInstructions = [developerInstructionsFor(context, options.browserAutomation !== undefined), pluginPreparation?.developerInstructions ?? ''].filter(Boolean).join('\n');
      const dynamicTools = [...conversationToolResultDynamicTools(), ...(zeusToolBroker ? zeusToolBroker.registry.codexTools : []), ...(pluginPreparation?.codexDynamicTools ?? [])];
      const providerBootstrapUtf8Bytes = Buffer.byteLength(JSON.stringify({ developerInstructions, dynamicTools }), 'utf8');
      if (!providerThreadId) {
        const profile = providerPermissionProfile(context);
        const threadRequest = {
          model: context.model,
          ...(Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? { serviceTier: context.serviceTier } : {}),
          cwd: context.projectLocalPath,
          sandbox: profile.sandbox,
          approvalPolicy: profile.approvalPolicy,
          approvalsReviewer: profile.approvalsReviewer,
          developerInstructions,
          ephemeral: context.ephemeral,
          dynamicTools,
          ...(responsesRuntime ? { responsesRuntime } : {}),
        };
        // thread/start 是本次父派发可能发生的第一笔 Provider 写；必须先推进父命令水位。
        markDispatchRpcStarted(lease, submission.id);
        const thread = await providerCommands.executeSession({
          operation: 'thread_start',
          commandKey: submission.id,
          scope: { kind: 'submission', id: submission.id },
          idempotencyKey: `thread-start:${submission.id}`,
          issuedAt: submission.createdAt,
          resourceId: submission.id,
          requestIdentity: {
            conversationId: conversation.id,
            model: context.model,
            modelSourceId: context.modelSourceId,
            serviceTier: Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? context.serviceTier : null,
            cwd: context.projectLocalPath,
            sandbox: profile.sandbox,
            approvalPolicy: profile.approvalPolicy,
            approvalsReviewer: profile.approvalsReviewer,
            ephemeral: context.ephemeral === true,
            developerInstructionsSha256: requestHash(developerInstructions),
            dynamicToolsSha256: requestHash(dynamicTools),
          },
          providerGenerationId: readyGenerationId(),
          invoke: (traceIdentity) => options.manager.startThread({ ...threadRequest, traceIdentity }),
          recoverAccepted: (nativeSessionId) => options.manager.readThread({ threadId: nativeSessionId }),
          isExplicitRejection: isRuntimeRejected,
          nativeSessionId: (acceptedThread) => acceptedThread.id,
          acceptedProviderGenerationId: (acceptedThread) => options.manager.generationForThread(acceptedThread.id),
        });
        providerThreadId = thread.id;
        threadStartedForSubmission = true;
        providerThreadAuthority.markSubscribed(thread.id);
        candidateProviderThreadId = thread.id;
        segmentLifecycle?.nativeSessionReady({
          nativeSessionId: thread.id,
          nativeSessionPath: typeof thread.path === 'string' ? thread.path : null,
          providerId: 'codex',
          providerModel: context.model,
          providerProtocolVersion: 'app-server',
          observedAt: now(),
        });
        if (!segmentLifecycle?.requiresNewSegment) {
          conversation = options.conversations.bindProvider(conversation.id, {
            providerId: 'codex',
            providerThreadId: thread.id,
            providerModel: context.model,
            providerState: 'ready',
          });
          persistProviderThreadMetadata(options.conversations, conversation.id, thread);
        }
        await persist();
        if (!segmentLifecycle?.requiresNewSegment) {
          options.broadcast('conversation.transport.changed', {
            conversationId: conversation.id,
            transportKind: 'codex_native',
            providerState: conversation.providerState,
            providerThreadId: conversation.providerThreadId,
          });
          options.broadcast('conversation.thread.changed', {
            conversationId: conversation.id,
            providerThreadId: conversation.providerThreadId,
            providerState: conversation.providerState,
          });
        }
      } else if (segmentLifecycle) {
        segmentLifecycle.nativeSessionReady({ nativeSessionId: providerThreadId, nativeSessionPath: conversation.providerThreadPath, observedAt: now() });
      }
      providerThreadId = requireString(providerThreadId, 'provider thread id');
      commandProviderGenerationId = options.manager.generationForThread(providerThreadId);
      if (segmentLifecycle && commandOutboxId) {
        segmentLifecycle.bindCommandDelivery({ outboxId: commandOutboxId, providerId: 'codex', providerGenerationId: commandProviderGenerationId });
      }
      const providerInput = submissionProviderInput(submission, context);
      const pluginPromptContext = await options.plugins?.beforeUserPrompt({ conversationId: conversation.id, prompt: providerInput, permissionMode: context.permissionMode });
      const profile = providerPermissionProfile(context);
      const serializedAt = now();
      const wireEffort = toCodexWireReasoningEffort(context.effort) ?? null;
      segmentLifecycle?.adapterSerialized(
        {
          model: context.model,
          effort: wireEffort,
          serviceTier: Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? context.serviceTier : null,
          collaborationMode: context.workMode,
          permissionMode: context.permissionMode,
        },
        { adapter: 'codex_app_server', method: 'turn/start', protocol: 'openai_responses' },
        serializedAt,
      );
      let pluginCompactContext: CodexBootstrapAdditionalContext | undefined;
      if (segmentLifecycle?.contextCompactionPlan) {
        await emitPluginCompactionHook({ plugins: options.plugins, event: 'PreCompact', conversationId: conversation.id, cwd: context.projectLocalPath, model: context.model });
        await segmentLifecycle.beginContextCompaction(now());
        try {
          // portable compaction 会创建临时 thread/turn，同样属于父派发的外部写边界。
          markDispatchRpcStarted(lease, submission.id);
          const compacted = await runCodexPortableContextCompaction({
            manager: options.manager,
            providerCommands,
            providerGenerationId: commandProviderGenerationId,
            conversationId: conversation.id,
            plan: segmentLifecycle.contextCompactionPlan,
            model: context.model,
            effort: wireEffort,
            serviceTier: Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? (context.serviceTier ?? null) : null,
            cwd: context.projectLocalPath,
            responsesRuntime,
            issuedAt: submission.createdAt,
          });
          await segmentLifecycle.completeContextCompaction({
            summary: compacted.summary,
            usage: compacted.usage,
            evidence: compacted.evidence,
            completedAt: now(),
          });
          pluginCompactContext = await emitPluginCompactionHook({ plugins: options.plugins, event: 'PostCompact', conversationId: conversation.id, cwd: context.projectLocalPath, model: context.model });
        } catch (error) {
          await segmentLifecycle.failContextCompaction(error, now());
          throw error;
        }
      }
      const fixedAdditionalContext = mergeCodexAdditionalContext(segmentLifecycle?.codexBootstrapAdditionalContext, context.additionalContext, pluginPromptContext, pluginCompactContext);
      const fixedRequestUtf8Bytes = Buffer.byteLength(JSON.stringify({ input: providerInput, ...(fixedAdditionalContext ? { additionalContext: fixedAdditionalContext } : {}) }), 'utf8');
      const compiledDispatchContext = options.compileDispatchContext
        ? await options.compileDispatchContext({
            provider: 'codex',
            conversationId: conversation.id,
            submissionId: submission.id,
            projectId: context.projectId,
            projectLocalPath: context.projectLocalPath,
            taskId: context.taskId,
            modelId: context.model,
            modelSourceId: context.modelSourceId,
            operationRisk: context.permissionMode === 'read-only' && !context.allowCodeChanges ? 'read_only' : 'local_write',
            fixedRequestUtf8Bytes,
            providerBootstrapUtf8Bytes,
            providerHistoryMode: threadStartedForSubmission ? 'bootstrap' : 'latest',
            providerGenerationId: commandProviderGenerationId,
          })
        : null;
      if (compiledDispatchContext) assertCallerDoesNotOverrideCompiledContext(context.additionalContext);
      const initialGoalObjective = submissionGoalObjective(submission);
      if (initialGoalObjective) {
        const goalConversationId = conversation.id;
        await ensureInitialCodexGoal({
          conversationId: goalConversationId,
          providerThreadId,
          objective: initialGoalObjective,
          goals,
          manager: options.manager,
          markProviderWriteStarted: () => markDispatchRpcStarted(lease, submission.id),
          execute: ({ objective, invoke, recoverAccepted }) =>
            executeSessionCommand({
              operation: 'goal_set',
              conversationId: goalConversationId,
              threadId: providerThreadId,
              commandKey: `initial-goal:${submission.id}`,
              requestIdentity: { objective, status: 'active' },
              invoke,
              recoverAccepted,
            }),
          project: (goal) => projectGoal(goalConversationId, goal, null, now()),
          persist,
        });
      }
      const additionalContext = mergeCodexAdditionalContext(segmentLifecycle?.codexBootstrapAdditionalContext, compiledDispatchContext?.codexAdditionalContext, context.additionalContext, pluginPromptContext, pluginCompactContext);
      // turn/start 调用前先耐久记录“可能写出”；宁可保守进入 unknown，也不能在进程崩溃后盲重放。
      if (segmentLifecycle) segmentLifecycle.markProviderWriteStarted();
      else options.commandDeliveries.markProviderWriteStarted({ outboxId: requireString(commandOutboxId, 'command outbox id'), occurredAt: now() });
      providerWriteStarted = true;
      markDispatchRpcStarted(lease, submission.id);
      const turn = await options.manager.startTurn({
        threadId: providerThreadId,
        traceIdentity: commandTraceIdentity,
        ...(responsesRuntime ? { responsesRuntime } : {}),
        clientUserMessageId: submission.clientMessageId,
        input: providerInput,
        ...(additionalContext ? { additionalContext } : {}),
        ...(segmentLifecycle ? { requestWritten: () => segmentLifecycle.markProviderWriteStarted() } : {}),
        model: context.model,
        ...(wireEffort ? { effort: wireEffort } : {}),
        ...(Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? { serviceTier: context.serviceTier } : {}),
        summary: 'auto',
        ...(context.workMode
          ? {
              collaborationMode: {
                mode: context.workMode,
                settings: {
                  model: context.model,
                  reasoning_effort: wireEffort,
                  developer_instructions: null,
                },
              },
            }
          : {}),
        cwd: context.projectLocalPath,
        approvalPolicy: profile.approvalPolicy,
        approvalsReviewer: profile.approvalsReviewer,
        sandboxPolicy: profile.sandbox,
      });
      volatileSubmissionText.delete(submission.id);
      const timestamp = now();
      const acceptedTurnId = segmentLifecycle?.acceptSynchronously({
        providerTurnId: turn.id,
        acceptedAt: timestamp,
        runtimeEvidence: { method: 'turn/start', turnId: turn.id, responseReceived: true },
        providerEcho: turn,
      });
      if (segmentLifecycle?.requiresNewSegment) {
        conversation = options.conversations.getById(conversation.id) ?? conversation;
      }
      const existingProviderTurn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === turn.id);
      options.turns.upsert({
        ...(existingProviderTurn ? { id: existingProviderTurn.id } : acceptedTurnId ? { id: acceptedTurnId } : {}),
        conversationId: conversation.id,
        providerThreadId,
        providerTurnId: turn.id,
        clientSubmissionId: submission.id,
        status: 'running',
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const syncCheckpoint = syncCheckpoints.getByConversation(conversation.id);
      if (syncCheckpoint) {
        if (syncCheckpoint.providerThreadId === providerThreadId) {
          syncCheckpoints.advance({ conversationId: conversation.id, providerThreadId, lastSyncedTurnId: turn.id, timestamp });
        } else {
          // 新分段已在同一事务中成为 current；旧线程已经 sealed，检查点必须跟随当前线程重建。
          syncCheckpoints.rebind({ conversationId: conversation.id, providerThreadId, baselineTurnId: turn.id, timestamp });
        }
      } else {
        syncCheckpoints.initialize({ conversationId: conversation.id, providerThreadId, baselineTurnId: turn.id, timestamp });
      }
      options.submissions.updateStatus(submission.id, 'active', { providerTurnId: turn.id, dispatchedAt: timestamp });
      options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId, providerModel: context.model, providerState: 'active' });
      if (!segmentLifecycle && commandOutboxId) {
        options.commandDeliveries.recordOutcomeInCurrentTransaction({
          outboxId: commandOutboxId,
          outcome: 'accepted',
          evidence: { method: 'turn/start', traceIdentity: commandTraceIdentity, turnId: turn.id, responseReceived: true },
          providerId: 'codex',
          providerGenerationId: commandProviderGenerationId,
          nativeSessionId: providerThreadId,
          nativeTurnId: turn.id,
          occurredAt: timestamp,
        });
      }
      runStates.set(conversation.id, { type: 'active', turnId: turn.id, phase: 'prework' });
      if (!serviceTierFallbackAttempted && parseJsonRecord(submission.inputJson).requestedServiceTier === 'priority' && context.serviceTier !== 'priority') {
        recordServiceTierDowngrade(conversation.id, submission, context, 'model_unsupported');
      }
      const providerSettings = options.conversations.getProviderSettingsSnapshot(conversation.id);
      if (threadStartedForSubmission && providerSettings && Object.prototype.hasOwnProperty.call(providerSettings, 'serviceTier')) {
        persistProviderReportedServiceTierDowngrade(conversation.id, submission, context, providerSettings.serviceTier ?? null);
      }
      await persist();
      // submission 已进入 provider 轮次后必须同步清出队列表面，避免其他窗口继续展示旧快照。
      options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId, providerTurnId: turn.id, submissionId: submission.id });
      if (!existingProviderTurn) {
        options.broadcast('conversation.turn.started', {
          conversationId: conversation.id,
          providerThreadId,
          providerTurnId: turn.id,
          submissionId: submission.id,
          status: 'running',
          startedAt: timestamp,
        });
      }
      return accepted(submission, 'active', providerThreadId, turn.id);
    } catch (error) {
      if (!serviceTierFallbackAttempted && context.serviceTier === 'priority' && isServiceTierUnavailableError(error)) {
        const standardContext: ConversationDispatchContext = { ...context, serviceTier: null };
        persistSubmissionDispatchContext(submission, standardContext);
        options.conversations.updateNextTurnSettings(conversation.id, nextTurnSettingsFromContext(standardContext));
        contexts.set(conversation.id, standardContext);
        options.submissions.updateStatus(submission.id, 'queued', { providerTurnId: null, updatedAt: now() });
        runStates.set(conversation.id, { type: 'idle' });
        await persist();
        const retrySubmission = options.submissions.getById(submission.id) ?? submission;
        const retryConversation = options.conversations.getById(conversation.id) ?? conversation;
        const result = await dispatchSubmissionWithLease(retryConversation, retrySubmission, lease, providerArchiveRecoveryAttempted, segmentLifecycle, true);
        if (result.status !== 'recovery_required' && result.status !== 'provider_archived') {
          recordServiceTierDowngrade(conversation.id, retrySubmission, standardContext, 'app_server_rejected');
          await persist();
        }
        return result;
      }
      const providerArchived = isProviderThreadArchivedError(error);
      const explicitlyRejected = isRuntimeRejected(error) || providerArchived;
      const runtimeRejected = segmentLifecycle !== undefined && isRuntimeRejected(error);
      if (segmentLifecycle) {
        if (explicitlyRejected) await segmentLifecycle.rejectBeforeAcceptance(error, now());
        else await segmentLifecycle.fail(error, now());
      } else if (commandOutboxId) {
        options.commandDeliveries.recordOutcome({
          outboxId: commandOutboxId,
          outcome: explicitlyRejected ? 'explicitly_rejected' : providerWriteStarted ? 'outcome_unknown_after_write' : 'failed_before_write',
          evidence: serializeError(error),
          providerId: 'codex',
          providerGenerationId: commandProviderGenerationId,
          nativeSessionId: candidateProviderThreadId ?? conversation.providerThreadId,
          occurredAt: now(),
        });
      }
      if (runtimeRejected) {
        runStates.set(conversation.id, { type: 'paused', reason: 'runtime_rejected' });
        options.broadcast('conversation.queue.changed', { conversationId: conversation.id, submissionId: submission.id });
        return accepted(submission, 'queued', segmentLifecycle.requiresNewSegment ? candidateProviderThreadId : conversation.providerThreadId, null);
      }
      if (segmentLifecycle?.requiresNewSegment) {
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
        options.broadcast('conversation.queue.changed', { conversationId: conversation.id, submissionId: submission.id });
        return accepted(submission, 'recovery_required', candidateProviderThreadId, null);
      }
      const current = options.conversations.getById(conversation.id);
      const providerThreadId = current?.providerThreadId ?? null;
      if (context.ephemeral) {
        options.submissions.updateStatus(submission.id, 'failed', { resolvedAt: now(), error: serializeError(error) });
        if (current?.providerThreadId) {
          options.conversations.bindProvider(current.id, {
            providerId: 'codex',
            providerThreadId: current.providerThreadId,
            providerModel: current.providerModel,
            providerState: 'closed',
          });
        } else if (current) {
          options.conversations.updateRuntimeState(current.id, { status: 'failed', summary: 'Codex native ephemeral dispatch failed.' });
          options.conversations.archive(current.id);
        }
        runStates.delete(conversation.id);
        contexts.delete(conversation.id);
      } else if (providerThreadId === null && options.manager.getState().type !== 'ready') {
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'transport_unavailable', error: serializeError(error) });
        runStates.set(conversation.id, { type: 'paused', reason: 'transport_unavailable' });
      } else if (providerArchived) {
        markConversationProviderArchived(conversation.id, error);
        await persist();
        if (!providerArchiveRecoveryAttempted) {
          try {
            await restoreArchivedProviderThread(conversation.id);
            const retrySubmission = options.submissions.getById(submission.id);
            const retryConversation = options.conversations.getById(conversation.id);
            if (retrySubmission && retryConversation) return dispatchSubmissionWithLease(retryConversation, retrySubmission, lease, true, segmentLifecycle, serviceTierFallbackAttempted);
          } catch {
            // 恢复函数已保留原始消息与可重试状态。
          }
        }
        return accepted(submission, 'provider_archived', providerThreadId, null);
      } else {
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'recovery_required', error: serializeError(error) });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      }
      await persist();
      options.broadcast('conversation.queue.changed', { conversationId: conversation.id, submissionId: submission.id });
      requestQueueDrain();
      return accepted(submission, 'recovery_required', providerThreadId, null);
    }
  }

  function attachDispatchLifecycle(lease: NativeConversationDispatchLease, lifecycle: NativeProviderWriteLifecycle | undefined): void {
    if (!lifecycle || lease.lifecycles.has(lifecycle)) return;
    lease.lifecycles.add(lifecycle);
    if (lease.rpcStartedResourceId) lifecycle.markRpcStarted(lease.rpcStartedResourceId);
  }

  function markDispatchRpcStarted(lease: NativeConversationDispatchLease, resourceId: string): void {
    lease.rpcStartedResourceId = resourceId;
    for (const lifecycle of lease.lifecycles) lifecycle.markRpcStarted(resourceId);
  }

  async function closeEphemeralConversation(conversationId: string, providerTurnId: string | null, submissionStatus: 'cancelled' | 'failed', error: unknown, interrupt: boolean): Promise<void> {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation) return;
    const context = contexts.get(conversationId) ?? contextFromConversation(conversation);
    if (!context.ephemeral) return;
    if (interrupt && providerTurnId && conversation.providerThreadId) {
      try {
        const providerThreadId = conversation.providerThreadId;
        await executeTurnCommand({
          operation: 'turn_interrupt',
          conversationId,
          threadId: providerThreadId,
          turnId: providerTurnId,
          commandKey: `turn-interrupt:${providerTurnId}`,
          requestIdentity: { threadId: providerThreadId, turnId: providerTurnId },
          invoke: (traceIdentity) => options.manager.interruptTurn({ threadId: providerThreadId, turnId: providerTurnId, traceIdentity }),
        });
      } catch (interruptError) {
        options.broadcast('conversation.native.ephemeral_interrupt_failed', {
          conversationId,
          providerThreadId: conversation.providerThreadId,
          providerTurnId,
          error: serializeError(interruptError),
        });
      }
    }
    markEphemeralConversationClosed(conversationId, providerTurnId, submissionStatus, error);
    await persist();
    requestQueueDrain();
  }

  function markEphemeralConversationClosed(conversationId: string, providerTurnId: string | null, submissionStatus: 'cancelled' | 'failed', error: unknown): void {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation) return;
    const context = contexts.get(conversationId) ?? contextFromConversation(conversation);
    if (!context.ephemeral) return;
    const timestamp = now();
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active' || submission.status === 'paused') {
        options.submissions.updateStatus(submission.id, submissionStatus, { resolvedAt: timestamp, error });
      }
    }
    const turn = providerTurnId ? options.turns.listByConversation(conversationId).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    if (turn) {
      options.turns.upsert({
        ...turn,
        status: submissionStatus === 'cancelled' ? 'interrupted' : 'failed',
        error,
        completedAt: timestamp,
        updatedAt: timestamp,
      });
    }
    options.conversations.updateRuntimeState(conversationId, {
      status: submissionStatus === 'failed' ? 'failed' : 'closed',
      summary: submissionStatus === 'failed' ? 'Codex native ephemeral conversation failed.' : 'Codex native ephemeral conversation closed.',
    });
    if (conversation.providerThreadId) {
      options.conversations.bindProvider(conversationId, {
        providerId: 'codex',
        providerThreadId: conversation.providerThreadId,
        providerModel: conversation.providerModel,
        providerState: 'closed',
      });
    } else {
      options.conversations.updateRuntimeState(conversationId, { status: submissionStatus === 'failed' ? 'failed' : 'closed' });
      options.conversations.archive(conversationId);
    }
    runStates.delete(conversationId);
    contexts.delete(conversationId);
  }

  function rejectTurnResultWaiters(key: string, error: Error): void {
    const waiters = turnResultWaiters.get(key) ?? [];
    turnResultWaiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function resolveTurnResult(result: NativeTurnResult): void {
    const key = `${result.conversationId}:${result.providerTurnId}`;
    completedTurnResults.set(key, result);
    for (const waiter of turnResultWaiters.get(key) ?? []) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    turnResultWaiters.delete(key);
  }

  interface NativeUserMessageProjection extends ResolvedNativeUserMessageSubmission {
    content: string;
  }

  function projectProviderUserMessage(
    conversation: ZeusConversationWithMessagesRecord,
    turn: ZeusConversationTurnRecord,
    itemPayload: Record<string, unknown>,
    providerContent: string,
    providerItemId: string,
  ): NativeUserMessageProjection | null {
    const existingProviderMessage = conversation.messages.find((message) => message.providerItemId === providerItemId);
    const existingClientIds = new Set(
      conversation.messages
        .filter((message) => message.providerItemId !== providerItemId)
        .map(conversationMessageClientId)
        .filter((value): value is string => Boolean(value)),
    );
    const submissions = options.submissions.listByConversation(conversation.id);
    const resolved = resolveNativeUserMessageSubmission({
      submissions,
      providerClientId: typeof itemPayload.clientId === 'string' ? itemPayload.clientId : null,
      clientSubmissionId: turn.clientSubmissionId,
      providerTurnId: turn.providerTurnId,
      existingMessage: existingProviderMessage ? { clientMessageId: conversationMessageClientId(existingProviderMessage) } : undefined,
      existingClientMessageIds: existingClientIds,
    });
    const submissionInput = resolved.submission ? parseJsonRecord(resolved.submission.inputJson) : {};
    if (submissionInput.internalOperation === true) return null;
    return {
      ...resolved,
      content: chooseNativeUserMessageContent({
        displayText: itemPayload.displayText,
        submissionDisplayText: submissionInput.displayText,
        submissionText: resolved.submission ? submissionText(resolved.submission) : undefined,
        existingContent: existingProviderMessage?.content,
        providerContent,
      }),
    };
  }

  function persistProviderUserMessage(
    conversation: ZeusConversationWithMessagesRecord,
    itemPayload: Record<string, unknown>,
    projection: NativeUserMessageProjection,
    providerTurnId: string,
    providerThreadId: string,
    providerItemId: string,
    createdAt: string,
  ): string | null {
    const existingProviderMessage = conversation.messages.find((message) => message.providerItemId === providerItemId);
    const projectedSubmission = projection.submission;
    const providerClientId = typeof itemPayload.clientId === 'string' && itemPayload.clientId.trim() ? itemPayload.clientId : null;
    const exactSteeringIdentity = !projectedSubmission || !isSteeringSubmission(projectedSubmission) || providerClientId === projectedSubmission.clientMessageId;
    const clientMessageId = exactSteeringIdentity ? projection.clientMessageId : null;
    const submission = exactSteeringIdentity ? projectedSubmission : undefined;
    const existingMetadata = existingProviderMessage ? parseJsonRecord(existingProviderMessage.metadataJson) : {};
    const stableMetadata = { ...existingMetadata };
    const taskPushLayout = submission ? readNativeSubmissionTaskPushLayout(submission) : null;
    delete stableMetadata.inputOrigin;
    options.conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: projection.content,
      source: 'codex_native',
      metadata: {
        ...stableMetadata,
        inputOrigin: submission ? 'zeus_local' : 'remote_device',
        ...(clientMessageId ? { clientUserMessageId: clientMessageId } : {}),
        ...(submission ? { attachments: submissionAttachments(submission) } : {}),
        ...(taskPushLayout ? { taskPushLayout } : {}),
        ...(submission && submissionBrowserComments(submission).length ? { browserComments: submissionBrowserComments(submission) } : {}),
        ...(submission && submissionConversationContext(submission) ? { conversationContext: submissionConversationContext(submission) } : {}),
        ...(typeof itemPayload.origin === 'string' ? { origin: itemPayload.origin } : {}),
        ...(typeof itemPayload.planItemId === 'string' ? { planItemId: itemPayload.planItemId } : {}),
        ...(submission && typeof parseJsonRecord(submission.inputJson).requestAnswerId === 'string' ? { requestAnswerId: parseJsonRecord(submission.inputJson).requestAnswerId } : {}),
      },
      createdAt,
      providerThreadId,
      providerTurnId,
      providerItemId,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    flushServiceTierDowngradeNotice(submission);
    resolveExactSteeringSubmission(conversation.id, itemPayload, providerThreadId, providerTurnId);
    return clientMessageId;
  }

  function resolveExactSteeringSubmission(conversationId: string, itemPayload: Record<string, unknown>, providerThreadId: string, providerTurnId: string): void {
    const providerClientId = typeof itemPayload.clientId === 'string' && itemPayload.clientId.trim() ? itemPayload.clientId : null;
    if (!providerClientId) return;
    const submission = options.submissions
      .listByConversation(conversationId)
      .find(
        (candidate) =>
          candidate.kind === 'steer' &&
          candidate.requestedDelivery === 'send_now' &&
          candidate.clientMessageId === providerClientId &&
          candidate.providerTurnId === providerTurnId &&
          (candidate.status === 'dispatching' || (candidate.status === 'paused' && candidate.pausedReason === 'recovery_required')),
      );
    if (!submission) return;
    options.submissions.updateStatus(submission.id, 'resolved', { providerTurnId, resolvedAt: now() });
    options.broadcast('conversation.submission.steered', {
      conversationId,
      submissionId: submission.id,
      providerThreadId,
      providerTurnId,
      clientUserMessageId: providerClientId,
    });
  }

  function conversationMessageClientId(message: { clientMessageId: string | null; metadataJson: string }): string | null {
    if (message.clientMessageId?.trim()) return message.clientMessageId;
    const metadata = parseJsonRecord(message.metadataJson);
    return typeof metadata.clientUserMessageId === 'string' && metadata.clientUserMessageId.trim() ? metadata.clientUserMessageId : null;
  }

  function isSteeringSubmission(submission: ZeusConversationSubmissionRecord): boolean {
    return submission.kind === 'steer' && submission.requestedDelivery === 'send_now';
  }

  function hasExactProviderUserMessage(conversation: ZeusConversationWithMessagesRecord, submission: ZeusConversationSubmissionRecord, providerTurnId: string): boolean {
    const current = options.conversations.getById(conversation.id) ?? conversation;
    return current.messages.some((message) => message.role === 'user' && message.providerTurnId === providerTurnId && conversationMessageClientId(message) === submission.clientMessageId);
  }

  /**
   * Provider 一个轮次可以承载多条用户消息；轮次终止时必须收口全部已精确送达的提交。
   * 只有轮次首提交身份或 Provider 用户消息身份能够对上时才判定送达，其余保留为需要恢复。
   */
  function reconcileTerminalTurnSubmissions(conversation: ZeusConversationWithMessagesRecord, turn: ZeusConversationTurnRecord, timestamp: string, failure?: unknown) {
    const providerTurnId = requireString(turn.providerTurnId, 'provider turn id');
    const candidates = options.submissions
      .listByConversation(conversation.id)
      .filter((submission) => submission.providerTurnId === providerTurnId && (submission.status === 'dispatching' || submission.status === 'active' || (submission.status === 'paused' && submission.pausedReason === 'recovery_required')));
    let primarySubmission: ZeusConversationSubmissionRecord | undefined;
    const recoveryRequired: ZeusConversationSubmissionRecord[] = [];
    let reconciledCount = 0;

    for (const submission of candidates) {
      const exactProviderMessage = hasExactProviderUserMessage(conversation, submission, providerTurnId);
      const delivered = submissionDeliveryConfirmedForTurn(submission, turn, exactProviderMessage);
      if (!delivered) {
        markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_SUBMISSION_DELIVERY_UNCONFIRMED', 'The provider turn ended without exact evidence that this user message was received.'));
        recoveryRequired.push(submission);
        reconciledCount += 1;
        continue;
      }
      if (!primarySubmission && !isSteeringSubmission(submission) && submission.id === turn.clientSubmissionId) primarySubmission = submission;
      if (isSteeringSubmission(submission)) {
        options.submissions.updateStatus(submission.id, 'resolved', { providerTurnId, resolvedAt: timestamp, updatedAt: timestamp });
      } else {
        options.submissions.updateStatus(submission.id, turn.status === 'failed' ? 'failed' : 'completed', {
          providerTurnId,
          resolvedAt: timestamp,
          updatedAt: timestamp,
          ...(turn.status === 'failed' ? { error: failure ?? failedTurnErrorFromRecord(turn) } : {}),
        });
      }
      reconciledCount += 1;
    }

    if (recoveryRequired.length === 0 && candidates.length > 0) {
      options.execution.resolveWarning(conversation.id, 'provider_reconciliation_deferred', timestamp);
    }

    return { primarySubmission, recoveryRequired, reconciledCount };
  }

  function submissionForProviderUserItem(conversationId: string, turn: ZeusConversationTurnRecord, itemPayload: Record<string, unknown>): ZeusConversationSubmissionRecord | undefined {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation) return undefined;
    const providerItemId = typeof itemPayload.id === 'string' && itemPayload.id.trim() ? itemPayload.id : null;
    const existingProviderMessage = providerItemId ? conversation.messages.find((message) => message.providerItemId === providerItemId) : undefined;
    const existingClientMessageIds = new Set(
      conversation.messages
        .filter((message) => message.providerItemId !== providerItemId)
        .map(conversationMessageClientId)
        .filter((value): value is string => Boolean(value)),
    );
    // 同一轮可以有首发消息和多条引导。缺少 Provider clientId 时，只有尚未被其他用户项占用的首发提交可以回退关联。
    // 否则会把后续引导套上首发任务的展示正文、附件和布局，形成一条重复的首发消息。
    return resolveNativeUserMessageSubmission({
      submissions: options.submissions.listByConversation(conversation.id),
      providerClientId: typeof itemPayload.clientId === 'string' ? itemPayload.clientId : null,
      clientSubmissionId: turn.clientSubmissionId,
      providerTurnId: turn.providerTurnId,
      existingMessage: existingProviderMessage ? { clientMessageId: conversationMessageClientId(existingProviderMessage) } : undefined,
      existingClientMessageIds,
    }).submission;
  }

  function submissionPresentation(conversationId: string, turn: ZeusConversationTurnRecord, itemPayload: Record<string, unknown>): Record<string, unknown> {
    const submission = submissionForProviderUserItem(conversationId, turn, itemPayload);
    if (!submission) return { inputOrigin: 'remote_device' };
    const input = parseJsonRecord(submission.inputJson);
    return {
      inputOrigin: 'zeus_local',
      ...(typeof input.displayText === 'string' && input.displayText.trim() ? { displayText: input.displayText } : {}),
      ...(isRecord(input.taskPushLayout) && input.taskPushLayout.kind === 'task_push' ? { taskPushLayout: input.taskPushLayout } : {}),
      ...(input.origin === 'implement_plan' ? { origin: input.origin } : {}),
      ...(typeof input.planItemId === 'string' ? { planItemId: input.planItemId } : {}),
      ...(typeof input.requestAnswerId === 'string' ? { requestAnswerId: input.requestAnswerId } : {}),
      ...(isRecord(input.conversationContext) ? { conversationContext: input.conversationContext } : {}),
    };
  }

  const queueCoreMutations = new ConversationQueueCoreMutationApplication({
    submissions: options.submissions,
    execution: options.execution,
    requests: options.requests,
    now,
    snapshot: toQueueSnapshot,
  });

  async function editQueuedSubmission(input: { conversationId: string; submissionId: string; content: string }): Promise<NativeQueueSnapshot> {
    const snapshot = options.db.transaction(() => queueCoreMutations.update(input)) as NativeQueueSnapshot;
    await persist();
    return snapshot;
  }

  const { deleteQueuedSubmission, retryQueuedSubmission } = createCodexRecoveredUnsentQueueApplication({
    transaction: (operation) => options.db.transaction(operation),
    mutations: queueCoreMutations,
    submissions: options.submissions,
    runStates,
    snapshot: toQueueSnapshot,
    queueChanged: (conversationId) => providerThreadAuthority.queueChanged(conversationId),
    persist,
    broadcast: options.broadcast,
    requestQueueDrain,
  });

  async function reorderQueue(input: { conversationId: string; orderedSubmissionIds: string[] }): Promise<NativeQueueSnapshot> {
    const snapshot = options.db.transaction(() => queueCoreMutations.reorder(input)) as NativeQueueSnapshot;
    await persist();
    return snapshot;
  }
  async function sendQueuedNow(input: SendQueuedNowInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const submission = requireOwnedSubmission(input.conversationId, input.submissionId);
    if (planControlModeForSubmission(submission)) {
      throw coordinatorError('ZEUS_PLAN_CONTROL_SUBMISSION_IMMUTABLE', 'Plan control submissions cannot steer an active turn.');
    }
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (state.type !== 'active' && state.type !== 'waiting') throw coordinatorError('ZEUS_NATIVE_TURN_NOT_ACTIVE', 'send-now requires a current active Codex native turn.');
    if (submission.status !== 'queued') throw coordinatorError('ZEUS_NATIVE_SUBMISSION_NOT_QUEUED', 'Submission is not queued.');
    const queueHead = options.submissions.listByConversation(input.conversationId).find((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
    if (!queueHead || queueHead.id !== submission.id) {
      throw coordinatorError('ZEUS_NATIVE_QUEUE_HEAD_REQUIRED', '只能立即发送当前队首，不能绕过更早的提交。');
    }
    const turnId = state.turnId;
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    const context = { ...contextFromSubmission(submission), permissionMode: conversation.permissionMode };
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    input.providerWriteLifecycle?.markRpcStarted(submission.id);
    options.submissions.updateStatus(submission.id, 'dispatching', { providerTurnId: turnId, dispatchedAt: now() });
    providerThreadAuthority.queueChanged(conversation.id);
    await persist();
    try {
      await executeTurnCommand({
        operation: 'turn_steer',
        conversationId: conversation.id,
        threadId: providerThreadId,
        turnId,
        commandKey: submission.id,
        requestIdentity: { submissionId: submission.id, clientUserMessageId: submission.clientMessageId, requestHash: submission.requestHash },
        issuedAt: submission.createdAt,
        invoke: (traceIdentity) => options.manager.steerTurn({ threadId: providerThreadId, turnId, clientUserMessageId: submission.clientMessageId, input: submissionProviderInput(submission, context), traceIdentity }),
        isExplicitRejection: isProviderTurnAlreadyEndedSteerError,
      });
    } catch (error) {
      if (isProviderTurnAlreadyEndedSteerError(error)) {
        let requeued = options.submissions.requeueRejectedSteer(submission.id, now());
        await persist();
        // 先让已经到达的 turn/completed 事件收敛旧轮次，再尝试读取一次权威快照；两者失败都不能把明确未发送的输入升级成未知副作用。
        await providerEvents.waitForIdle();
        const currentConversation = requireConversation(conversation.id);
        try {
          const metadata = await options.manager.readThread({ threadId: providerThreadId });
          await enqueueProviderTurnReconciliation(currentConversation);
          const snapshot = projectedProviderThreadSnapshot(conversation.id, metadata);
          const generationId = options.manager.generationForThread(providerThreadId) ?? readyGenerationId();
          if (generationId) reconcileConversationSnapshot(currentConversation, snapshot, generationId);
        } catch (reconcileError) {
          options.broadcast('conversation.native.steer_requeued', {
            conversationId: conversation.id,
            providerThreadId,
            providerTurnId: turnId,
            submissionId: submission.id,
            reconciliationError: serializeError(reconcileError),
          });
        }
        // 恢复对账可能按“重启后的未发送内容”暂停队列；本次输入来自当前用户动作，应继续作为普通下一轮排队。
        requeued = options.submissions.requeueRejectedSteer(submission.id, now());
        await persist();
        options.broadcast('conversation.queue.changed', {
          conversationId: conversation.id,
          queue: toQueueSnapshot(conversation.id),
        });
        requestQueueDrain();
        return accepted(requeued, 'queued', providerThreadId, null);
      }
      options.submissions.updateStatus(submission.id, 'paused', {
        providerTurnId: turnId,
        pausedReason: 'recovery_required',
        error: toRecoverySubmissionError(error),
        updatedAt: now(),
      });
      await persist();
      options.broadcast('conversation.submission.steering', { conversationId: conversation.id, submissionId: submission.id, providerThreadId, providerTurnId: turnId });
      throw error;
    }
    const steering = options.submissions.getById(submission.id) ?? submission;
    options.broadcast('conversation.submission.steering', { conversationId: conversation.id, submissionId: submission.id, providerThreadId, providerTurnId: turnId });
    return accepted(steering, 'steering', providerThreadId, turnId);
  }

  async function interruptTurn(input: InterruptNativeTurnInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    const recoverableMissingInteraction = state.type === 'paused' && state.reason === 'interaction_authority_missing';
    if (state.type !== 'active' && state.type !== 'waiting' && !recoverableMissingInteraction) throw coordinatorError('ZEUS_NATIVE_TURN_NOT_ACTIVE', 'No active Codex native turn to interrupt.');
    const stateTurnId =
      state.type === 'active' || state.type === 'waiting' ? state.turnId : options.turns.listByConversation(conversation.id).find((turn) => turn.providerTurnId === input.providerTurnId && turn.status === 'waiting')?.providerTurnId;
    if (stateTurnId !== input.providerTurnId) throw coordinatorError('ZEUS_NATIVE_TURN_MISMATCH', 'Interrupt target is not the current active provider turn.');
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    await input.providerWriteLifecycle?.markPrepared(input.providerTurnId);
    input.providerWriteLifecycle?.markRpcStarted(input.providerTurnId);
    await persist();
    await executeTurnCommand({
      operation: 'turn_interrupt',
      conversationId: conversation.id,
      threadId: providerThreadId,
      turnId: input.providerTurnId,
      commandKey: `turn-interrupt:${input.providerTurnId}`,
      requestIdentity: { threadId: providerThreadId, turnId: input.providerTurnId },
      invoke: (traceIdentity) => options.manager.interruptTurn({ threadId: providerThreadId, turnId: input.providerTurnId, traceIdentity }),
    });
    const terminalResultPromise = waitForTurnResult({ conversationId: conversation.id, providerTurnId: input.providerTurnId });
    void turnResultRecovery.reconcileInterruptedTurnUntilSettled(conversation.id, input.providerTurnId);
    let terminalResult: NativeTurnResult;
    try {
      terminalResult = await terminalResultPromise;
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'ZEUS_CODEX_TURN_RESULT_TIMEOUT') {
        await turnResultRecovery.markInterruptedTurnProviderStopPending(conversation.id, providerThreadId, input.providerTurnId, error);
      }
      throw error;
    }
    if (terminalResult.status !== 'interrupted') {
      throw coordinatorError('ZEUS_NATIVE_INTERRUPT_OUTCOME_UNKNOWN', 'Codex did not confirm a terminal outcome for the interrupted turn.');
    }
    const submission = options.submissions.listByConversation(conversation.id).find((entry) => entry.providerTurnId === input.providerTurnId);
    return {
      operationId: operationId(),
      conversationId: conversation.id,
      submissionId: submission?.id ?? '',
      status: 'interrupted',
      providerThreadId,
      providerTurnId: input.providerTurnId,
    };
  }

  async function resumeInterruptedQueue(input: { conversationId: string }): Promise<NativeQueueSnapshot> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (state.type !== 'paused' || state.reason !== 'interrupted') throw coordinatorError('ZEUS_NATIVE_QUEUE_NOT_INTERRUPTED', 'Queue is not paused by an interrupted turn.');
    const paused = options.submissions.listByConversation(conversation.id).filter((entry) => entry.status === 'paused' && entry.pausedReason === 'interrupted' && !entry.providerTurnId);
    for (const submission of paused) options.submissions.updateStatus(submission.id, 'queued');
    runStates.set(conversation.id, { type: 'idle' });
    await persist();
    const next = options.submissions.listByConversation(conversation.id).find((entry) => entry.status === 'queued' && !entry.providerTurnId);
    if (next) await dispatchSubmission(conversation, next);
    return toQueueSnapshot(conversation.id);
  }

  async function recoverQueue(input: RecoverNativeQueueInput): Promise<NativeQueueSnapshot> {
    assertOpen();
    let conversation = requireConversation(input.conversationId);
    if (conversation.archived || conversation.providerState === 'archived') {
      throw coordinatorError('ZEUS_NATIVE_QUEUE_PROVIDER_ARCHIVED', 'The provider conversation must be restored explicitly before its queue can be recovered.');
    }
    if (providerStopRecovery.hasPendingEvidence(conversation.id)) {
      const stopRecovery = await providerStopRecovery.retry(conversation.id);
      if (stopRecovery === 'pending' || stopRecovery === 'recovery_required') return toQueueSnapshot(conversation.id);
    }
    await ensureGenerationReconciled([conversation.id]);
    conversation = requireConversation(input.conversationId);
    const deliveryUnconfirmed = options.submissions.listByConversation(conversation.id).find((submission) => submission.status === 'paused' && submission.pausedReason === 'recovery_required' && Boolean(submission.providerTurnId));
    if (deliveryUnconfirmed) {
      // 已进入终态轮次但缺少送达证据的内容不能由普通队列恢复自动重发，否则可能造成重复用户消息。
      throw coordinatorError('ZEUS_NATIVE_SUBMISSION_DELIVERY_UNCONFIRMED', 'A user message has an unconfirmed delivery result and cannot be resent automatically.');
    }
    try {
      await ensureConversationExecutionContext(conversation.id, 'recover_queue');
      const state = runStates.get(conversation.id) ?? inferRunState(conversation);
      if (state.type === 'paused' && state.reason === 'recovery_required') {
        conversation = await recoverPausedConversation(conversation.id, 'recover_queue');
      }
    } catch (error) {
      markConversationRecoveryRequired(conversation.id, error);
      await persist();
      options.broadcast('conversation.native.recovery_failed', {
        conversationId: conversation.id,
        providerThreadId: conversation.providerThreadId,
        error: serializeError(error),
      });
      throw error;
    }
    for (const submission of options.submissions.listByConversation(conversation.id)) {
      if (submission.status === 'paused' && submission.pausedReason === 'recovery_required' && !submission.providerTurnId) {
        options.submissions.updateStatus(submission.id, 'queued');
      }
    }
    const recoveredState = runStates.get(conversation.id) ?? inferRunState(requireConversation(conversation.id));
    if (recoveredState.type === 'active' || recoveredState.type === 'waiting') {
      runStates.set(conversation.id, recoveredState);
      if (recoveredState.type === 'active' && conversation.providerThreadId) providerThreadAuthority.observe(conversation.id, conversation.providerThreadId);
      await persist();
      options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId: conversation.providerThreadId });
      return toQueueSnapshot(conversation.id);
    }
    if (recoveredState.type !== 'idle') {
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Recovered provider thread is not at a safe dispatch boundary.');
    }
    runStates.set(conversation.id, { type: 'idle' });
    await persist();
    await drainQueuedSubmissions();
    return toQueueSnapshot(conversation.id);
  }

  async function archiveConversation(input: ArchiveConversationInput): Promise<NativeQueueSnapshot> {
    assertOpen();
    let conversation = requireConversation(input.conversationId);
    if (conversation.archived) return toQueueSnapshot(conversation.id);
    if (await archiveUnboundConversationLocally(options, conversation, () => (runStates.delete(conversation.id), contexts.delete(conversation.id)))) return toQueueSnapshot(conversation.id);
    assertConversationCanBeArchived(conversation);
    await ensureGenerationReconciled([conversation.id]);
    conversation = requireConversation(input.conversationId);
    if (conversation.archived) return toQueueSnapshot(conversation.id);
    assertConversationCanBeArchived(conversation);
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    if (conversation.providerState !== 'archived') {
      await executeSessionCommand({
        operation: 'thread_archive',
        conversationId: conversation.id,
        threadId: providerThreadId,
        commandKey: `archive:${providerThreadId}:${conversation.stageUpdatedAt}`,
        requestIdentity: { threadId: providerThreadId },
        invoke: (traceIdentity) => options.manager.archiveThread({ threadId: providerThreadId, traceIdentity }),
      });
    }
    let archivedThreadPath: string | undefined;
    try {
      archivedThreadPath = threadPath(await options.manager.readThread({ threadId: providerThreadId }));
    } catch {
      // 旧版 app-server 可能不允许读取已归档线程；此时保留上次已确认路径，不自行猜测。
    }
    if (archivedThreadPath) {
      options.conversations.updateProviderThreadPath(conversation.id, {
        providerThreadId,
        providerThreadPath: archivedThreadPath,
      });
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'archived',
    });
    options.conversations.archive(conversation.id);
    runStates.set(conversation.id, { type: 'paused', reason: 'provider_archived' });
    providerThreadAuthority.stopObserver(conversation.id);
    providerThreadAuthority.markUnsubscribed(providerThreadId);
    contexts.delete(conversation.id);
    await persist();
    options.broadcast('conversation.thread.archived', {
      conversationId: conversation.id,
      projectId: conversation.projectId,
      taskId: conversation.taskId,
      providerThreadId,
      providerState: 'archived',
    });
    return toQueueSnapshot(conversation.id);
  }

  function assertConversationCanBeArchived(conversation: ZeusConversationWithMessagesRecord): void {
    const pendingRequest = options.requests.listByConversation(conversation.id).find((request) => request.status === 'pending');
    const unfinishedTurn = options.turns.listByConversation(conversation.id).find((turn) => turn.status === 'dispatching' || turn.status === 'running' || turn.status === 'waiting');
    const pendingSubmission = options.submissions
      .listByConversation(conversation.id)
      .find((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active' || (submission.status === 'paused' && !submission.providerTurnId));
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (
      pendingRequest ||
      unfinishedTurn ||
      pendingSubmission ||
      conversation.providerState === 'binding' ||
      conversation.providerState === 'active' ||
      conversation.providerState === 'waiting' ||
      state.type === 'dispatching' ||
      state.type === 'active' ||
      state.type === 'waiting'
    ) {
      throw coordinatorError('ZEUS_NATIVE_CONVERSATION_IN_PROGRESS', 'The conversation still has an active turn, queued message, or pending request and cannot be archived.');
    }
  }

  async function restoreArchivedConversation(input: RestoreArchivedConversationInput): Promise<NativeQueueSnapshot> {
    assertOpen();
    let conversation = requireConversation(input.conversationId);
    if (await restoreUnboundConversationLocally(options, conversation, () => (runStates.set(conversation.id, { type: 'idle' }), contexts.delete(conversation.id)))) return toQueueSnapshot(conversation.id);
    if (conversation.providerState === 'archived') {
      await ensureGenerationReconciled([conversation.id]);
      conversation = requireConversation(input.conversationId);
      if (conversation.providerState === 'archived') await restoreArchivedProviderThread(conversation.id);
    }
    if (conversation.archived) await ensureConversationExecutionContext(conversation.id, 'restore');
    if (conversation.archived) {
      options.conversations.restore(conversation.id);
      await persist();
      options.broadcast('conversation.thread.unarchived', {
        conversationId: conversation.id,
        projectId: conversation.projectId,
        taskId: conversation.taskId,
        providerThreadId: conversation.providerThreadId,
        providerState: conversation.providerState,
      });
    }
    await drainQueuedSubmissions();
    return toQueueSnapshot(conversation.id);
  }
  async function restoreArchivedProviderThread(conversationId: string): Promise<NativeQueueSnapshot> {
    let conversation = requireConversation(conversationId);
    if (conversation.providerState !== 'archived') return toQueueSnapshot(conversation.id);
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    await ensureConversationExecutionContext(conversation.id, 'restore');
    conversation = requireConversation(conversation.id);
    const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
    contexts.set(conversation.id, context);
    try {
      await options.plugins?.prepare({
        conversationId: conversation.id,
        projectId: context.projectId,
        cwd: context.projectLocalPath,
        model: context.model,
        source: 'resume',
      });
      const responsesRuntime = await responsesRuntimeFor(context);
      if (responsesRuntime) {
        await options.manager.ensureReady({
          commandPath: commandPath(),
          ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}),
          providerEnvironment: responsesRuntime.environment,
        });
      }
      try {
        await executeSessionCommand({
          operation: 'thread_unarchive',
          conversationId: conversation.id,
          threadId: providerThreadId,
          commandKey: `unarchive:${providerThreadId}:${conversation.stageUpdatedAt}`,
          requestIdentity: { threadId: providerThreadId },
          invoke: (traceIdentity) => options.manager.unarchiveThread({ threadId: providerThreadId, traceIdentity }),
        });
      } catch (error) {
        if (!isProviderThreadAlreadyAvailableError(error)) throw error;
      }
      const resumed = await options.manager.resumeThread({ threadId: providerThreadId, cwd: context.projectLocalPath, ...(responsesRuntime ? { responsesRuntime } : {}) });
      if (resumed.id !== providerThreadId) {
        throw coordinatorError('ZEUS_CODEX_THREAD_IDENTITY_MISMATCH', 'Codex returned a different thread while restoring the archived conversation.');
      }
      providerThreadAuthority.markSubscribed(providerThreadId);
      persistProviderThreadMetadata(options.conversations, conversation.id, resumed);
      await enqueueProviderTurnReconciliation(requireConversation(conversation.id));
      const metadata = await options.manager.readThread({ threadId: providerThreadId });
      const snapshot = projectedProviderThreadSnapshot(conversation.id, metadata);
      if (snapshot.id !== providerThreadId) {
        throw coordinatorError('ZEUS_CODEX_THREAD_IDENTITY_MISMATCH', 'Codex returned a different thread snapshot while restoring the archived conversation.');
      }
      for (const submission of options.submissions.listByConversation(conversation.id)) {
        if (submission.status === 'paused' && submission.pausedReason === 'provider_archived' && !submission.providerTurnId) failSubmissionBeforeProviderDispatch(submission);
      }
      conversation = options.conversations.bindProvider(conversation.id, {
        providerId: 'codex',
        providerThreadId,
        providerModel: conversation.providerModel,
        providerState: 'ready',
      });
      runStates.set(conversation.id, { type: 'idle' });
      reconcileConversationSnapshot(conversation, snapshot, requireString(readyGenerationId(), 'transport generation id'));
      await externalAnswerRecovery.recoverAll(requireConversation(conversation.id));
      await persist();
      options.broadcast('conversation.thread.changed', {
        conversationId: conversation.id,
        providerThreadId,
        providerState: 'ready',
      });
      options.broadcast('conversation.queue.changed', {
        conversationId: conversation.id,
        providerThreadId,
        providerState: 'ready',
      });
      return toQueueSnapshot(conversation.id);
    } catch (error) {
      markConversationProviderArchived(conversation.id, error);
      await persist();
      throw error;
    }
  }

  async function respondToRequest(input: RespondNativeRequestInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const request = options.requests.getById(input.requestId);
    if (!request) throw coordinatorError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request is not pending.');
    if (request.status !== 'pending') throw coordinatorError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request is not pending.');
    clearAutoResolutionTimer(request.id);
    const conversation = requireConversation(request.conversationId);
    const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
    const providerRequestId = JSON.parse(request.providerRequestIdJson) as string | number;
    const response = input.response;
    const payload = parseJsonRecord(request.payloadJson);
    const pluginToolResponse = await pluginToolApprovals.tryRespond(request, response);
    if (pluginToolResponse) return pluginToolResponse;
    let wireResponse = { ...response, generationId: request.transportGenerationId, requestId: providerRequestId } as CodexServerRequestResponse;
    const grantSessionFileEdits = request.requestKind === 'file' && response.type === 'file' && response.decision === 'acceptForSession';

    if (request.requestKind === 'command') {
      if (response.type !== 'command') throw invalidServerRequestResponse('Response type does not match the pending command approval.');
      if (isExecpolicyAmendmentDecision(response.decision)) {
        if (!isAdvertisedCommandDecision(payload, response.decision)) {
          throw invalidServerRequestResponse('The provider did not advertise the requested execpolicy amendment.');
        }
      } else if (isGrantDecision(response.decision)) {
        if (!isAdvertisedCommandDecision(payload, response.decision)) {
          const policy = evaluateCommandApproval(payload, context);
          if (!policy.allowed) wireResponse = { type: 'command', decision: 'decline', generationId: request.transportGenerationId, requestId: providerRequestId };
          else throw invalidServerRequestResponse('The provider did not advertise the requested command approval decision.');
        }
      }
    }
    if (request.requestKind === 'file') {
      if (response.type !== 'file') throw invalidServerRequestResponse('Response type does not match the pending file approval.');
      if (isGrantDecision(response.decision) && payload.grantRoot !== undefined && payload.grantRoot !== null) {
        throw invalidServerRequestResponse('File approvals cannot grant provider-requested root scope.');
      } else if (isGrantDecision(response.decision) && !hasAuditableFileApprovalTarget(payload, conversation, context, options.providerItems)) {
        throw invalidServerRequestResponse('The pending file approval does not identify an auditable project-local target.');
      }
    }
    if (request.requestKind === 'permissions') {
      if (response.type !== 'permissions' || !isSupportedPermissionRequest(payload) || !isSupportedPermissionGrant(response.permissions)) {
        await failPermissionRequest(conversation, request, payload, coordinatorError('ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', 'Codex permission request or grant schema is unsupported.'));
      }
      if (response.type !== 'permissions') throw coordinatorError('ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', 'Codex permission response type is unsupported.');
      try {
        validatePermissionGrant(payload, response.permissions, context);
      } catch (error) {
        await failPermissionRequest(conversation, request, payload, error);
      }
    }
    if (request.requestKind === 'mcp') {
      if (response.type !== 'mcp' || !isValidMcpElicitationResponse(payload, response)) {
        throw invalidServerRequestResponse('MCP elicitation response does not satisfy the pending request mode and schema.');
      }
    }
    if (request.requestKind === 'request_user_input') {
      if (response.type !== 'request_user_input') throw invalidServerRequestResponse('Response type does not match the pending request_user_input request.');
      const validationError = validateCanonicalRequestUserInputAnswers(payload, response.answers);
      if (validationError) throw invalidServerRequestResponse(validationError);
      validateRequestAnswerAttachments(request, payload, input.answerAttachments ?? []);
    } else if (input.answerAttachments?.length) {
      throw invalidServerRequestResponse('Only request_user_input responses can include answer attachments.');
    }
    const currentGenerationId = readyGenerationId();
    if (!options.manager.hasGeneration(request.transportGenerationId)) {
      if (!isInteractionRecoveryCheckpointRequest(request)) {
        options.requests.restorePendingAfterTransportRecovery(request.id, {
          recoveryReason: 'app_server_generation_changed',
          sourceGenerationId: request.transportGenerationId,
          currentGenerationId,
          restoredAt: now(),
        });
      }
      const recoveredRequest = options.requests.getById(request.id) ?? request;
      const recovered = await respondAfterInteractionRecovery({
        request: recoveredRequest,
        conversation,
        response: stripRequestTransport(wireResponse),
        input,
      });
      if (grantSessionFileEdits) {
        options.conversations.setSessionFileEditGrant(conversation.id, conversation.projectId, true);
        await persist();
      }
      return recovered;
    }
    if (input.answerAttachments?.length) {
      await deliverRequestAnswerAttachments(request, conversation, input.answerAttachments);
    }
    await input.providerWriteLifecycle?.markPrepared(request.id);
    input.providerWriteLifecycle?.markRpcStarted(request.id);
    await persist();
    const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
    const providerTurnId = requireString(turn?.providerTurnId, 'server request provider turn id');
    const providerThreadId = requireString(turn?.providerThreadId, 'server request provider thread id');
    await executeTurnCommand({
      operation: 'server_request_response',
      conversationId: conversation.id,
      threadId: providerThreadId,
      turnId: providerTurnId,
      commandKey: `server-request:${request.id}`,
      requestIdentity: wireResponse,
      issuedAt: request.createdAt,
      providerGenerationId: request.transportGenerationId,
      invoke: (traceIdentity) => options.manager.respondToServerRequest({ ...wireResponse, traceIdentity }),
    });
    if (grantSessionFileEdits) options.conversations.setSessionFileEditGrant(conversation.id, conversation.projectId, true);
    const effectiveResponse = stripRequestTransport(wireResponse);
    const secret = request.containsSecret && effectiveResponse.type === 'request_user_input';
    options.requests.resolve(request.id, {
      response: requestResponseWithAttachmentPresentation(effectiveResponse, input.answerAttachmentPresentation),
      isSecret: secret,
      ...(secret && effectiveResponse.type === 'request_user_input'
        ? { questionIds: Object.keys(effectiveResponse.answers), answerCount: Object.values(effectiveResponse.answers).reduce((total, answer) => total + answer.answers.length, 0) }
        : {}),
      resolvedAt: now(),
    });
    if (turn?.providerTurnId) {
      const pending = options.requests.listByConversation(conversation.id).find((candidate) => candidate.turnId === turn.id && candidate.status === 'pending' && options.manager.hasGeneration(candidate.transportGenerationId));
      if (pending) {
        options.turns.upsert({ ...turn, status: 'waiting', updatedAt: now() });
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: 'waiting',
        });
        runStates.set(conversation.id, {
          type: 'waiting',
          turnId: turn.providerTurnId,
          requestId: pending.id,
          reason: pending.requestKind === 'request_user_input' ? 'user_input' : 'approval',
        });
      } else {
        options.turns.upsert({ ...turn, status: 'running', updatedAt: now() });
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: 'active',
        });
        runStates.set(conversation.id, { type: 'active', turnId: turn.providerTurnId, phase: 'prework' });
      }
    }
    await persist();
    options.broadcast('conversation.request.resolved', {
      conversationId: conversation.id,
      requestId: request.id,
      requestKind: request.requestKind,
      ...('decision' in effectiveResponse ? { effectiveDecision: effectiveResponse.decision } : {}),
    });
    const submission = request.turnId ? options.submissions.listByConversation(conversation.id).find((entry) => entry.providerTurnId === options.turns.getById(request.turnId ?? '')?.providerTurnId) : undefined;
    return {
      operationId: operationId(),
      conversationId: conversation.id,
      submissionId: submission?.id ?? '',
      status: 'responded',
      providerThreadId: conversation.providerThreadId,
      providerTurnId: request.turnId ? (options.turns.getById(request.turnId)?.providerTurnId ?? null) : null,
    };
  }

  function validateRequestAnswerAttachments(request: ZeusConversationServerRequestRecord, payload: Record<string, unknown>, groups: NativeQuestionAnswerAttachmentInput[]): void {
    if (groups.length === 0) return;
    if (request.containsSecret) throw invalidServerRequestResponse('Sensitive request_user_input questions cannot include attachments.');
    const canonical = parseCanonicalRequestUserInputQuestions(payload);
    if (!canonical.ok) throw invalidServerRequestResponse(canonical.message);
    const questions = new Map(canonical.questions.map((question) => [question.id, question]));
    const seen = new Set<string>();
    let attachmentCount = 0;
    for (const group of groups) {
      if (!group.questionId || seen.has(group.questionId)) throw invalidServerRequestResponse('Answer attachment question ids must be explicit and unique.');
      const question = questions.get(group.questionId);
      if (!question) throw invalidServerRequestResponse(`Answer attachments do not belong to canonical question ${group.questionId}.`);
      if (question.isSecret) throw invalidServerRequestResponse(`Sensitive question ${group.questionId} cannot include attachments.`);
      if (!Array.isArray(group.attachments) || group.attachments.length === 0) throw invalidServerRequestResponse(`Answer attachment group ${group.questionId} must not be empty.`);
      seen.add(group.questionId);
      attachmentCount += group.attachments.length;
    }
    if (attachmentCount > 100) throw invalidServerRequestResponse('A request_user_input response cannot include more than 100 attachments.');
  }

  async function deliverRequestAnswerAttachments(request: ZeusConversationServerRequestRecord, conversation: ZeusConversationWithMessagesRecord, groups: NativeQuestionAnswerAttachmentInput[]): Promise<void> {
    const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
    const providerTurnId = turn?.providerTurnId;
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (!providerTurnId || state.type !== 'waiting' || state.turnId !== providerTurnId || state.requestId !== request.id) {
      throw coordinatorError('ZEUS_REQUEST_ANSWER_ATTACHMENT_TURN_UNAVAILABLE', 'The current waiting turn is unavailable for request answer attachments.');
    }
    const attachments = flattenQuestionAnswerAttachments(groups);
    const mapping = groups.map((group) => `- ${group.questionId}: ${group.attachments.map((attachment) => attachment.name).join('、')}`).join('\n');
    const acceptance = await steerMessage({
      conversationId: conversation.id,
      content: `以下附件属于当前 request_user_input 的对应问题，请与随后提交的文字答案共同理解：\n${mapping}`,
      displayText: '已提交询问回答附件',
      attachments,
      expectedTurnId: providerTurnId,
      idempotencyKey: `request-answer-attachments:${request.id}`,
      clientUserMessageId: `request-answer-attachments:${request.id}`,
      requestAnswerId: request.id,
    });
    if (acceptance.status === 'steering' || acceptance.status === 'steered') return;
    if (acceptance.submissionId) {
      options.submissions.updateStatus(acceptance.submissionId, 'cancelled', { resolvedAt: now() });
      await persist();
    }
    throw coordinatorError('ZEUS_REQUEST_ANSWER_ATTACHMENT_NOT_DELIVERED', 'Request answer attachments were not accepted by the current turn.');
  }

  function flattenQuestionAnswerAttachments(groups: NativeQuestionAnswerAttachmentInput[]): NativeConversationAttachmentInput[] {
    const byIdentity = new Map<string, NativeConversationAttachmentInput>();
    for (const attachment of groups.flatMap((group) => group.attachments)) {
      const identity = attachment.authorizedPath ?? attachment.localPath ?? attachment.uploadRef ?? `${attachment.name}:${attachment.size}`;
      if (!byIdentity.has(identity)) byIdentity.set(identity, attachment);
    }
    return [...byIdentity.values()];
  }

  function requestResponseWithAttachmentPresentation(response: RespondNativeRequestInput['response'], presentation: RespondNativeRequestInput['answerAttachmentPresentation']): unknown {
    return presentation && Object.keys(presentation).length > 0 ? { ...response, answerAttachments: presentation } : response;
  }

  function isPendingInteractionAuthority(request: ZeusConversationServerRequestRecord): boolean {
    return request.status === 'pending' && (options.manager.hasGeneration(request.transportGenerationId) || isInteractionRecoveryCheckpointRequest(request));
  }

  async function respondAfterInteractionRecovery(inputValue: {
    request: ZeusConversationServerRequestRecord;
    conversation: ZeusConversationWithMessagesRecord;
    response: RespondNativeRequestInput['response'];
    input: RespondNativeRequestInput;
  }): Promise<NativeAcceptedOperation> {
    const { request, conversation, response } = inputValue;
    await inputValue.input.providerWriteLifecycle?.markPrepared(request.id);
    const secret = request.containsSecret && response.type === 'request_user_input';
    options.requests.resolve(request.id, {
      response: requestResponseWithAttachmentPresentation(response, inputValue.input.answerAttachmentPresentation),
      isSecret: secret,
      ...(secret && response.type === 'request_user_input' ? { questionIds: Object.keys(response.answers), answerCount: Object.values(response.answers).reduce((total, answer) => total + answer.answers.length, 0) } : {}),
      resolvedAt: now(),
    });

    const previousTurn = request.turnId ? options.turns.getById(request.turnId) : undefined;
    if (previousTurn && previousTurn.status !== 'completed') {
      options.turns.upsert({ ...previousTurn, status: 'interrupted', completedAt: now(), updatedAt: now() });
      const previousSubmission = previousTurn.clientSubmissionId ? options.submissions.getById(previousTurn.clientSubmissionId) : undefined;
      if (previousSubmission && (previousSubmission.status === 'active' || previousSubmission.status === 'dispatching' || previousSubmission.status === 'paused')) {
        options.submissions.updateStatus(previousSubmission.id, 'completed', { resolvedAt: now() });
      }
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
      providerModel: conversation.providerModel,
      providerState: 'ready',
    });
    runStates.set(conversation.id, { type: 'idle' });

    const actualContent = buildInteractionRecoveryContinuation(request, response);
    const displayText = buildInteractionRecoveryDisplayText(request, response);
    const persistedContent = secret
      ? buildInteractionRecoveryContinuation(
          request,
          {
            type: 'request_user_input',
            answers: {},
          },
          '敏感回答仅在本次恢复执行的内存中传递，未写入本地记录。',
        )
      : actualContent;
    const context = contextWithLatestNextTurnSettings(conversation.id, contexts.get(conversation.id) ?? contextFromConversation(conversation));
    const submission = createSubmission(
      conversation.id,
      persistedContent,
      {
        idempotencyKey: `interaction-recovery-response:${request.id}`,
        clientUserMessageId: `interaction-recovery-response:${request.id}`,
        displayText,
        recoveryKind: 'interaction_response',
        ...(inputValue.input.answerAttachments?.length ? { attachments: flattenQuestionAnswerAttachments(inputValue.input.answerAttachments) } : {}),
        ...(inputValue.input.answerAttachments?.length ? { requestAnswerId: request.id } : {}),
      },
      context,
    );
    if (secret) volatileSubmissionText.set(submission.id, actualContent);
    await persist();
    options.broadcast('conversation.request.resolved', {
      conversationId: conversation.id,
      requestId: request.id,
      requestKind: request.requestKind,
      resumedAfterTransportRecovery: true,
    });
    // 回答已经耐久接纳后立即结束 HTTP 操作；慢 thread/resume 由统一队列在后台执行，
    // 不能再把 Provider 加载耗时误报成“回答失败”。后台派发仍只使用原 submission，
    // 并由既有 Provider command/outbox 保证一次恢复尝试只产生一次写入。
    requestQueueDrain();
    return accepted(submission, 'queued', conversation.providerThreadId, null);
  }

  async function snoozeRequest(input: SnoozeNativeRequestInput): Promise<void> {
    assertOpen();
    const request = options.requests.getById(input.requestId);
    if (!request) throw coordinatorError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex user input request is not pending.');
    clearAutoResolutionTimer(request.id);
    options.db.transaction(() => queueCoreMutations.snooze({ conversationId: request.conversationId, requestId: request.id }));
    await persist();
    options.broadcast('conversation.request.snoozed', { conversationId: request.conversationId, requestId: request.id });
  }
  function clearAutoResolutionTimer(requestId: string): void {
    const timer = autoResolutionTimers.get(requestId);
    if (timer) clearTimeout(timer);
    autoResolutionTimers.delete(requestId);
  }

  function scheduleAutoResolution(request: ZeusConversationServerRequestRecord): void {
    clearAutoResolutionTimer(request.id);
    if (request.requestKind !== 'request_user_input' || request.status !== 'pending' || request.autoResolutionState !== 'scheduled' || !request.expiresAt) return;
    const deadline = Date.parse(request.expiresAt);
    const current = Date.parse(now());
    if (!Number.isFinite(deadline) || !Number.isFinite(current)) return;
    const delay = Math.max(0, Math.min(2_147_000_000, deadline - current));
    autoResolutionTimers.set(
      request.id,
      setTimeout(() => {
        autoResolutionTimers.delete(request.id);
        void autoResolveRequest(request.id).catch((error) =>
          options.broadcast('conversation.native.error', {
            conversationId: request.conversationId,
            requestId: request.id,
            error: serializeError(error),
          }),
        );
      }, delay),
    );
  }

  async function autoResolveRequest(requestId: string): Promise<void> {
    const request = options.requests.getById(requestId);
    if (!request || request.status !== 'pending' || request.autoResolutionState !== 'scheduled') return;
    await respondToRequest({ requestId, response: { type: 'request_user_input', answers: {} } });
    options.requests.expire(requestId, { response: { type: 'request_user_input', answers: {} }, resolvedAt: now() });
    await persist();
  }

  async function respondToPlanImplementationRequest(input: RespondPlanImplementationRequestInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const request = planActions.getById(input.requestId);
    if (!request || request.conversationId !== conversation.id) {
      throw coordinatorError('ZEUS_PLAN_IMPLEMENTATION_REQUEST_NOT_FOUND', 'Plan implementation request was not found.');
    }
    const planItem = options.providerItems.listByConversation(conversation.id).find((item) => item.id === request.planItemId);
    if (!planItem || planItem.itemType !== 'plan' || planItem.status !== 'completed' || !planItem.textContent.trim()) {
      throw coordinatorError('ZEUS_PLAN_IMPLEMENTATION_REQUEST_INVALID', 'Plan implementation request does not reference a completed non-empty plan.');
    }
    const timestamp = now();
    if (input.action === 'dismiss') {
      planActions.resolveLatestPending(request.id, conversation.id, { status: 'dismissed', resolvedAt: timestamp });
      await persist();
      options.broadcast('conversation.plan_implementation_request.changed', {
        conversationId: conversation.id,
        requestId: request.id,
        status: 'dismissed',
        providerPlanItemId: planItem.providerItemId,
      });
      requestQueueDrain();
      return {
        operationId: operationId(),
        conversationId: conversation.id,
        submissionId: '',
        status: 'responded',
        providerThreadId: conversation.providerThreadId,
        providerTurnId: null,
      };
    }

    const refinement = input.action === 'refine';
    const feedback = input.feedback?.trim() ?? '';
    if (refinement && !feedback) throw coordinatorError('ZEUS_PLAN_REFINEMENT_REQUIRED', 'Plan refinement feedback is required.');
    const previousContext = contextWithLatestNextTurnSettings(conversation.id, contexts.get(conversation.id) ?? contextFromConversation(conversation));
    const nextMode: ConversationCollaborationMode = refinement ? 'plan' : 'default';
    const context: ConversationDispatchContext = {
      ...previousContext,
      permissionMode: conversation.permissionMode,
      workMode: nextMode,
    };
    const content = refinement ? feedback : `请实施以下已确认计划。严格按计划执行，并在完成后报告验证结果。\n\n${planItem.textContent}`;
    const submissionIdentity = input.operationIdentity ?? operationId();
    const submission = options.db.transaction(() => {
      options.conversations.updateCollaborationMode(conversation.id, nextMode);
      const created = createSubmission(
        conversation.id,
        content,
        {
          submissionId: `conversation_submission_${submissionIdentity}`,
          idempotencyKey: `plan-action:${request.id}:${input.action}`,
          clientUserMessageId: `plan-action-client:${request.id}:${input.action}`,
          origin: refinement ? ('refine_plan' as const) : ('implement_plan' as const),
          planItemId: planItem.id,
          ...(refinement ? {} : { displayText: '是，实施此计划' }),
        },
        context,
      );
      planActions.resolveLatestPendingInCurrentTransaction(request.id, conversation.id, {
        status: refinement ? 'refinement_requested' : 'implemented',
        submissionId: created.id,
        resolvedAt: timestamp,
      });
      const queuedIds = options.submissions
        .listByConversation(conversation.id)
        .filter((candidate) => candidate.status === 'queued' || candidate.status === 'paused' || candidate.status === 'failed')
        .map((candidate) => candidate.id);
      if (queuedIds[0] !== created.id) {
        options.submissions.reorderQueued(conversation.id, [created.id, ...queuedIds.filter((id) => id !== created.id)], timestamp);
      }
      return created;
    });
    contexts.set(conversation.id, context);
    options.conversations.updateNextTurnSettings(conversation.id, nextTurnSettingsFromContext(context));
    await persist();
    options.broadcast('conversation.plan_implementation_request.changed', {
      conversationId: conversation.id,
      requestId: request.id,
      status: refinement ? 'refinement_requested' : 'implemented',
      submissionId: submission.id,
      providerPlanItemId: planItem.providerItemId,
      collaborationMode: nextMode,
      // 确认卡消失与用户消息进入时间线必须是同一个投影事件；否则队列事件稍晚到达时，
      // PLAN -> 开发模式切换会短暂只剩一片空白。
      queue: toQueueSnapshot(conversation.id),
    });
    const refreshed = requireConversation(conversation.id);
    const state = runStates.get(conversation.id) ?? inferRunState(refreshed);
    runStates.set(conversation.id, state);
    if (state.type !== 'idle') return accepted(submission, 'queued', refreshed.providerThreadId, null);
    return dispatchSubmission(refreshed, submission);
  }

  async function failPermissionRequest(conversation: ZeusConversationWithMessagesRecord, request: ReturnType<ConversationServerRequestRepository['getById']> & {}, payload: Record<string, unknown>, failure: unknown): Promise<never> {
    const turn = request?.turnId ? options.turns.getById(request.turnId) : undefined;
    const serialized: { message: string; code?: string; interruptError?: { message: string; code?: string } } = serializeError(failure);
    try {
      if (turn?.providerTurnId && conversation.providerThreadId) {
        const providerThreadId = conversation.providerThreadId;
        const providerTurnId = turn.providerTurnId;
        await executeTurnCommand({
          operation: 'turn_interrupt',
          conversationId: conversation.id,
          threadId: providerThreadId,
          turnId: providerTurnId,
          commandKey: `turn-interrupt:${providerTurnId}`,
          requestIdentity: { threadId: providerThreadId, turnId: providerTurnId },
          issuedAt: request.createdAt,
          providerGenerationId: request.transportGenerationId,
          invoke: (traceIdentity) => options.manager.interruptTurn({ threadId: providerThreadId, turnId: providerTurnId, traceIdentity }),
        });
      }
    } catch (interruptError) {
      serialized.interruptError = serializeError(interruptError);
    }
    options.requests.upsert({
      conversationId: conversation.id,
      turnId: request?.turnId,
      itemId: request?.itemId,
      transportGenerationId: request!.transportGenerationId,
      providerRequestId: JSON.parse(request!.providerRequestIdJson) as string | number,
      requestKind: 'permissions',
      payload,
      status: 'failed',
      response: { error: serialized.code ?? 'ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', message: serialized.message },
      createdAt: request!.createdAt,
      resolvedAt: now(),
    });
    await persist();
    throw coordinatorError(serialized.code ?? 'ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', serialized.message);
  }

  async function recover(): Promise<void> {
    assertOpen();
    await reconcilePersistedTerminalSubmissions();
    await providerStopRecovery.recoverPersisted();
    const automaticRecoveryConversationIds = new Set(
      options.conversations
        .listNativeBoundRecords('codex')
        .filter((conversation) => conversation.providerState === 'binding' || conversation.providerState === 'active' || conversation.providerState === 'waiting')
        .map((conversation) => conversation.id),
    );
    for (const submission of options.submissions.listRecoverable()) {
      const conversation = options.conversations.getRecordById(submission.conversationId);
      if (conversation?.agentKind === 'codex' && (submission.status === 'dispatching' || submission.status === 'active')) automaticRecoveryConversationIds.add(submission.conversationId);
    }
    try {
      await ensureGenerationReconciled([...automaticRecoveryConversationIds]);
      await prepareRecoveredCodexPlugins({ plugins: options.plugins, conversationIds: automaticRecoveryConversationIds, conversations: options.conversations, submissions: options.submissions, turns: options.turns, contexts });
    } catch (error) {
      const recoveryError = { code: 'ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', cause: serializeError(error) };
      const affectedConversationIds = new Set(
        options.submissions
          .listRecoverable()
          .filter((submission) => options.conversations.getById(submission.conversationId)?.agentKind === 'codex' && (submission.status === 'dispatching' || submission.status === 'active'))
          .map((submission) => submission.conversationId),
      );
      for (const conversationId of affectedConversationIds) {
        markConversationRecoveryRequired(conversationId, recoveryError);
      }
      await persist();
      return;
    }
    const completedPlanRecoveryState = options.settings.getJson<{ revision?: string }>(completedPlanRecoverySettingKey);
    if (completedPlanRecoveryState?.revision !== completedPlanRecoveryRevision) {
      const existingPlanActionCount = options.db.countRows('conversation_plan_actions');
      // 旧版已经在每次启动执行过计划收口；已有操作记录就是历史投影完成证据，不再重扫大体量消息表。
      if (existingPlanActionCount === 0) recoverCompletedPlanImplementationRequests();
      options.settings.setJson(completedPlanRecoverySettingKey, {
        revision: completedPlanRecoveryRevision,
        completedAt: now(),
        projectedPlanActionCount: options.db.countRows('conversation_plan_actions'),
        adoptedExistingProjection: existingPlanActionCount > 0,
      });
    }
    await persist();
    for (const request of options.requests.listPending()) scheduleAutoResolution(request);
    await drainQueuedSubmissions();
  }

  function recoverCompletedPlanImplementationRequests(): void {
    const turns = options.turns.listCompletedPlanRecoveryCandidates('codex');
    const planItemsByTurn = new Map(options.providerItems.listLatestCompletedPlansByTurns(turns.map((turn) => turn.id)).map((item) => [item.turnId, item]));
    for (const turn of turns) {
      if (!turn.clientSubmissionId) continue;
      const submission = options.submissions.getById(turn.clientSubmissionId);
      ensurePlanImplementationRequest(turn.conversationId, turn, submission, turn.completedAt ?? turn.updatedAt, planItemsByTurn.get(turn.id) ?? null);
    }
  }

  async function reconcilePersistedTerminalSubmissions(): Promise<number> {
    assertOpen();
    await providerEvents.waitForIdle();
    const reconciledCount = reconcilePersistedTerminalTurnSubmissions();
    if (reconciledCount > 0) await persist();
    return reconciledCount;
  }

  function requestQueueDrain(): void {
    queueMicrotask(() => {
      void drainQueuedSubmissions().catch((error) => {
        options.broadcast('conversation.native.queue_dispatch_failed', { error: serializeError(error) });
      });
    });
  }

  function drainQueuedSubmissions(): Promise<void> {
    if (queueDrainPromise) return queueDrainPromise;
    const drain = (async () => {
      while (!closing && !closed) {
        const candidates = nextQueuedSubmissionPerConversation();
        let dispatched = false;
        for (const submission of candidates) {
          try {
            let conversation = options.conversations.getById(submission.conversationId);
            if (!conversation || conversation.archived || conversation.providerState === 'archived' || conversation.providerState === 'closed') continue;
            // 计划结果等待用户决策时，普通后续消息不能抢先开启下一轮。
            if (hasPendingPlanImplementationRequest(conversation.id)) continue;
            let state = runStates.get(conversation.id) ?? inferRunState(conversation);
            if (state.type === 'paused' && state.reason === 'recovery_required') {
              try {
                conversation = await recoverPausedConversation(conversation.id, 'dispatch');
                state = runStates.get(conversation.id) ?? inferRunState(conversation);
              } catch (error) {
                markConversationRecoveryRequired(conversation.id, error);
                await persist();
                options.broadcast('conversation.native.recovery_failed', {
                  conversationId: conversation.id,
                  providerThreadId: conversation.providerThreadId,
                  submissionId: submission.id,
                  error: serializeError(error),
                });
                continue;
              }
            }
            const context = { ...contextFromSubmission(submission), permissionMode: conversation.permissionMode };
            if (context.holdDispatch) continue;
            contexts.set(conversation.id, context);
            runStates.set(conversation.id, state);
            if (state.type !== 'idle') {
              if (state.type === 'active' && conversation.providerThreadId) providerThreadAuthority.observe(conversation.id, conversation.providerThreadId);
              continue;
            }
            if (closing || closed) return;
            const result = await dispatchSubmission(conversation, submission);
            if (result.status === 'active') dispatched = true;
          } catch (error) {
            const conversation = options.conversations.getById(submission.conversationId);
            if (conversation) await pauseQueueAfterDispatchFailure(conversation, submission, error);
          }
        }
        if (!dispatched) return;
      }
    })();
    queueDrainPromise = drain.finally(() => {
      queueDrainPromise = null;
    });
    return queueDrainPromise;
  }

  function nextQueuedSubmissionPerConversation(): ZeusConversationSubmissionRecord[] {
    const heads = new Map<string, ZeusConversationSubmissionRecord>();
    for (const submission of options.submissions.listRecoverable()) {
      if (submission.status !== 'queued') continue;
      if (submission.executionSnapshotId) continue;
      if (options.conversations.getRecordById(submission.conversationId)?.agentKind !== 'codex') continue;
      const current = heads.get(submission.conversationId);
      if (!current || compareConversationQueueOrder(submission, current) < 0) heads.set(submission.conversationId, submission);
    }
    return [...heads.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  function releaseHeldSubmissions(conversationId: string, context: ConversationDispatchContext): Map<string, ZeusConversationSubmissionRecord> {
    const replacements = new Map<string, ZeusConversationSubmissionRecord>();
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (submission.providerTurnId || (submission.status !== 'queued' && submission.status !== 'paused' && submission.status !== 'failed')) continue;
      const input = parseJsonRecord(submission.inputJson) as unknown as PersistedSubmissionInput;
      if (!isRecord(input.context) || input.context.holdDispatch !== true) continue;
      const nextInput: PersistedSubmissionInput = { ...input, context: { ...input.context, ...context } };
      delete nextInput.context.holdDispatch;
      replacements.set(
        submission.id,
        options.submissions.createReplacement(submission.id, {
          requestHash: requestHash(nextInput),
          input: nextInput,
          reason: 'release_hold',
          clientMessageId: submission.clientMessageId,
          updatedAt: now(),
        }),
      );
    }
    return replacements;
  }

  function compareConversationQueueOrder(left: ZeusConversationSubmissionRecord, right: ZeusConversationSubmissionRecord): number {
    return (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  }

  async function ensureGenerationReconciled(conversationIds: readonly string[]): Promise<void> {
    const requestedConversationIds = [...new Set(conversationIds)];
    if (requestedConversationIds.length === 0) return;
    const capabilities = await options.manager.ensureReady({ commandPath: commandPath(), ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}) });
    if (reconciledGenerationId === capabilities.generationId && requestedConversationIds.every((conversationId) => reconciledConversationIds.has(conversationId))) return;
    const initialGenerationId = capabilities.generationId;
    const reconcile = generationReconcileChain
      .catch(() => undefined)
      .then(async () => {
        let targetGenerationId = initialGenerationId;
        for (let pass = 0; pass < 3; pass += 1) {
          if (reconciledGenerationId !== targetGenerationId) {
            reconciledGenerationId = targetGenerationId;
            reconciledConversationIds.clear();
          }
          const pendingConversationIds = requestedConversationIds.filter((conversationId) => !reconciledConversationIds.has(conversationId));
          if (pendingConversationIds.length > 0) await reconcileBoundConversations(targetGenerationId, new Set(pendingConversationIds));
          const current = options.manager.getState();
          if (current.type !== 'ready') throw coordinatorError('ZEUS_CODEX_GENERATION_CHANGED_DURING_RECOVERY', 'Codex app-server generation changed during native conversation recovery.');
          if (current.generationId === targetGenerationId) {
            for (const conversationId of requestedConversationIds) reconciledConversationIds.add(conversationId);
            return;
          }
          targetGenerationId = current.generationId;
        }
        throw coordinatorError('ZEUS_CODEX_GENERATION_CHANGED_DURING_RECOVERY', 'Codex app-server generation did not stabilize during native conversation recovery.');
      });
    generationReconcileChain = reconcile.catch(() => undefined);
    await reconcile;
  }

  async function reconcileBoundConversations(generationId: string, requestedConversationIds: ReadonlySet<string>): Promise<void> {
    const boundConversations = options.conversations.listNativeBoundRecords('codex');
    const boundConversationIds = new Set(boundConversations.map((conversation) => conversation.id));
    for (const record of boundConversations) {
      if (!requestedConversationIds.has(record.id)) continue;
      const conversation = options.conversations.getById(record.id);
      if (!conversation) continue;
      // 已归档 Provider 会话只能由用户显式恢复，启动恢复不得触碰其线程。
      if (conversation.archived || conversation.providerState === 'archived') continue;
      try {
        interactionRecovery.recoverStaleInteractionRequests(conversation.id, generationId);
        await ensureConversationExecutionContext(conversation.id, 'reconcile');
        const contextual = options.submissions.listByConversation(conversation.id).find((submission) => isRecord(parseJsonRecord(submission.inputJson).context));
        if (contextual && !contexts.has(conversation.id)) contexts.set(conversation.id, contextFromSubmission(contextual));
        const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
        contexts.set(conversation.id, context);
        await providerThreadAuthority.inspect(conversation, context);
        await externalAnswerRecovery.recoverAll(requireConversation(conversation.id));
        restoreRecoverableInteractionState(conversation.id);
      } catch (error) {
        const providerArchived = isProviderThreadArchivedError(error);
        const recoveryPaused = providerArchived ? (markConversationProviderArchived(conversation.id, error), true) : markConversationRecoveryRequired(conversation.id, error);
        options.broadcast(providerArchived ? 'conversation.thread.archived' : recoveryPaused ? 'conversation.native.recovery_failed' : 'conversation.warning.changed', {
          conversationId: conversation.id,
          providerThreadId: conversation.providerThreadId,
          generationId,
          error: serializeError(error),
          ...(recoveryPaused ? {} : { warningKind: 'provider_reconciliation_deferred' }),
        });
      }
      await persist();
    }
    for (const submission of options.submissions.listRecoverable()) {
      if (options.conversations.getById(submission.conversationId)?.agentKind !== 'codex') continue;
      if ((submission.status !== 'dispatching' && submission.status !== 'active') || boundConversationIds.has(submission.conversationId)) continue;
      markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', 'Native submission has no recoverable provider thread.'));
    }
  }

  function restoreRecoverableInteractionState(conversationId: string): void {
    const request = options.requests.listByConversation(conversationId).find((candidate) => isPendingInteractionAuthority(candidate));
    if (!request?.turnId) return;
    const turn = options.turns.getById(request.turnId);
    const conversation = options.conversations.getById(conversationId);
    if (!turn?.providerTurnId || !conversation?.providerThreadId) return;
    options.turns.upsert({ ...turn, status: 'waiting', completedAt: null, updatedAt: now() });
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId: conversation.providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'waiting',
    });
    runStates.set(conversation.id, {
      type: 'waiting',
      turnId: turn.providerTurnId,
      requestId: request.id,
      reason: request.requestKind === 'request_user_input' ? 'user_input' : 'approval',
    });
  }

  const { reconcilePersistedTerminalTurnSubmissions, reconcileProviderTurnsSinceCheckpoint, projectedProviderThreadSnapshot, reconcileConversationSnapshot } = createCodexProviderHistoryProjection({
    failedTurnResults,
    goals,
    hasExactProviderUserMessage,
    interruptedQueueSubmissions,
    isSteeringSubmission,
    markConversationRecoveryRequired,
    markSubmissionRecoveryRequired,
    now,
    options,
    failUnsentSubmissionsBeforeProviderDispatch,
    persistProviderUserMessage,
    projectProviderUserMessage,
    processProjector,
    providerHistoryReconcilePageLimit,
    providerHistoryReconcileTurnLimit,
    reconcileTerminalTurnSubmissions,
    rejectTurnResultWaiters,
    resolveTurnResult,
    runStates,
    submissionPresentation,
    syncCheckpoints,
    syncItemResources,
    threadPath,
    turnResultWaiters,
    upsertRecoveredTurn,
  });

  const interactionRecovery = createCodexInteractionRecoveryApplication({
    enqueueProviderTurnReconciliation,
    executeTurnCommand,
    isClosed: () => closing || closed,
    isPendingInteractionAuthority,
    now,
    options,
    persist,
    projectedProviderThreadSnapshot,
    readyGenerationId,
    reconcileConversationSnapshot,
    runStates,
  });

  const providerThreadAuthority = createCodexProviderThreadAuthorityApplication({
    manager: options.manager,
    submissions: options.submissions,
    runStates,
    getConversation: (conversationId) => options.conversations.getById(conversationId),
    requireConversation,
    prepareContext: async (conversationId) => {
      await ensureConversationExecutionContext(conversationId, 'dispatch');
      const conversation = requireConversation(conversationId);
      const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
      contexts.set(conversation.id, context);
      return context;
    },
    inferRunState,
    responsesRuntimeFor,
    enqueueProviderTurnReconciliation,
    projectedProviderThreadSnapshot,
    reconcileConversationSnapshot,
    readyGenerationId,
    persistThreadProviderSettings: (conversationId, thread) => persistProviderThreadMetadata(options.conversations, conversationId, thread),
    persist,
    markConversationRecoveryRequired,
    broadcast: options.broadcast,
    requestQueueDrain,
  });

  const providerStopRecovery = createCodexProviderStopRecoveryApplication({
    manager: options.manager,
    providerCommands,
    conversations: options.conversations,
    submissions: options.submissions,
    turns: options.turns,
    requests: options.requests,
    runStates,
    ensureProviderReady: () => options.manager.ensureReady({ commandPath: commandPath(), ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}) }),
    persist,
    broadcast: options.broadcast,
    requestQueueDrain,
    now,
  });

  const turnResultRecovery = createCodexTurnResultRecoveryApplication({
    closeEphemeralConversation,
    completedTurnResults,
    enqueueProviderTurnReconciliation,
    failedTurnResults,
    isClosed: () => closing || closed,
    now,
    options,
    persist,
    providerStopRecovery,
    rejectTurnResultWaiters,
    resolveTurnResult,
    runStates,
    turnResultWaiters,
  });

  const remoteControlConversationSync = createCodexRemoteControlConversationSyncApplication({
    isClosed: () => closing || closed,
    manager: options.manager,
    syncCheckpoints,
    submissions: options.submissions,
    turns: options.turns,
    getConversation: (conversationId) => options.conversations.getById(conversationId),
    ensureGenerationReconciled,
    reconcile: (conversation) => enqueueProviderTurnReconciliation(conversation, { priority: 'control' }),
    persist,
  });

  async function synchronizeOpenConversation(input: { conversationId: string }): Promise<void> {
    if (providerStopRecovery.hasPendingEvidence(input.conversationId)) {
      await providerStopRecovery.recoverForNewSubmission(input.conversationId);
      return;
    }
    await remoteControlConversationSync.synchronizeOpenConversation(input);
  }

  async function synchronizeConversations(input: { conversationIds: readonly string[] }): Promise<void> {
    const ordinaryConversationIds: string[] = [];
    for (const conversationId of [...new Set(input.conversationIds)]) {
      if (providerStopRecovery.hasPendingEvidence(conversationId)) {
        await providerStopRecovery.recoverForNewSubmission(conversationId);
      } else {
        ordinaryConversationIds.push(conversationId);
      }
    }
    await remoteControlConversationSync.synchronizeConversations({ conversationIds: ordinaryConversationIds });
  }

  function failSubmissionBeforeProviderDispatch(submission: ZeusConversationSubmissionRecord): void {
    const timestamp = now();
    options.submissions.updateStatus(submission.id, 'failed', {
      pausedReason: null,
      resolvedAt: timestamp,
      updatedAt: timestamp,
      ...(submission.errorJson
        ? { preserveError: true }
        : {
            error: serializeError(coordinatorError('ZEUS_NATIVE_SUBMISSION_NOT_DISPATCHED', 'The submission was not dispatched to the provider.')),
          }),
      // 写入结果未知时必须保留 outcome_unknown，禁止 retry API 把同一提交重放给 Provider。
      preserveSubmissionOutcome: true,
    });
  }

  function failUnsentSubmissionsBeforeProviderDispatch(conversationId: string): void {
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if ((submission.status !== 'queued' && submission.status !== 'paused') || submission.providerTurnId) continue;
      failSubmissionBeforeProviderDispatch(submission);
    }
  }

  function upsertRecoveredTurn(
    existing: ZeusConversationTurnRecord | undefined,
    input: {
      conversationId: string;
      providerThreadId: string;
      providerTurnId: string;
      clientSubmissionId: string | null;
      status: ZeusConversationTurnRecord['status'];
      timestamp: string;
    },
  ): ZeusConversationTurnRecord {
    return options.turns.upsert({
      ...(existing ? { id: existing.id } : {}),
      conversationId: input.conversationId,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
      clientSubmissionId: input.clientSubmissionId,
      status: input.status,
      startedAt: existing?.startedAt ?? input.timestamp,
      completedAt: input.status === 'completed' || input.status === 'interrupted' || input.status === 'failed' ? input.timestamp : null,
      createdAt: existing?.createdAt ?? input.timestamp,
      updatedAt: input.timestamp,
    });
  }

  async function pauseQueueAfterDispatchFailure(conversation: ZeusConversationWithMessagesRecord, submission: ZeusConversationSubmissionRecord, error: unknown): Promise<NativeAcceptedOperation> {
    markConversationRecoveryRequired(conversation.id, error);
    await persist();
    const failure = serializeError(error);
    options.broadcast('conversation.native.queue_dispatch_failed', {
      conversationId: conversation.id,
      providerThreadId: conversation.providerThreadId,
      submissionId: submission.id,
      error: failure,
    });
    options.broadcast('conversation.queue.changed', {
      conversationId: conversation.id,
      submissionId: submission.id,
    });
    return accepted(options.submissions.getById(submission.id) ?? submission, 'recovery_required', conversation.providerThreadId, null);
  }

  function ensurePlanImplementationRequest(conversationId: string, turn: ZeusConversationTurnRecord, submission: ZeusConversationSubmissionRecord | undefined, timestamp: string, recoveredPlanItem?: ZeusConversationItemRecord | null) {
    if (!submission || contextFromSubmission(submission).workMode !== 'plan') return null;
    const planItem = recoveredPlanItem === undefined ? options.providerItems.getLatestCompletedPlanByTurn(turn.id) : recoveredPlanItem;
    if (!planItem) return null;
    return planActions.createPending({
      conversationId,
      turnId: turn.id,
      planItemId: planItem.id,
      createdAt: timestamp,
    });
  }

  async function handleProviderEvent(event: CodexAppServerEvent, receiptEvents: readonly CodexAppServerEvent[] = [event]): Promise<void> {
    const eventParams = isRecord(event.params) ? event.params : {};
    const eventThreadId = typeof eventParams.threadId === 'string' ? eventParams.threadId : null;
    if (eventThreadId) {
      providerThreadAuthority.markSubscribed(eventThreadId);
      const eventConversation = options.conversations.getByProviderThreadId(eventThreadId);
      if (eventConversation) providerThreadAuthority.stopObserver(eventConversation.id);
    }
    await projectCodexProviderEvent(
      {
        clearAutoResolutionTimer,
        closed,
        contextFromConversation,
        contextFromSubmission,
        contexts,
        drainQueuedSubmissions,
        ensurePlanImplementationRequest,
        executeTurnCommand,
        failInvalidInteractionAuthority: interactionRecovery.failInvalidInteractionAuthority,
        failedTurnResults,
        flushScheduledPersist,
        goals,
        hasProcessedProviderEvent,
        interruptedQueueSubmissions,
        maintainProviderReceiptGenerations,
        markScheduledPersistDirty: () => {
          scheduledPersistDirty = true;
        },
        options,
        modelRequestTiming,
        persist,
        persistProviderUserMessage,
        persistProviderReportedServiceTierDowngrade,
        projectGoal,
        projectProcessItem,
        projectProviderUserMessage,
        readyGenerationId,
        receipts,
        reconcileTerminalTurnSubmissions,
        recoverExternalRequestUserInputAnswer: (conversation: ZeusConversationWithMessagesRecord, request: ZeusConversationServerRequestRecord, resolvedAt: string) => externalAnswerRecovery.recover(conversation, request, resolvedAt),
        recoverExternallyResolvedRequestUserInputAnswers: (conversation: ZeusConversationWithMessagesRecord, providerTurnId?: string) => externalAnswerRecovery.recoverAll(conversation, providerTurnId),
        rejectTurnResultWaiters,
        resolveTurnResult,
        rememberProcessedProviderEvent,
        requiresImmediatePersist,
        respondToRequest,
        runStates,
        scheduleAutoResolution,
        scheduleExternalAnswerRecovery: (conversationId: string, requestId: string, attempt?: number) => externalAnswerRecovery.schedule(conversationId, requestId, attempt),
        schedulePersist,
        submissionPresentation,
        syncCheckpoints,
        syncItemResources,
      },
      event,
      receiptEvents,
    );
    if (event.method === 'thread/status/changed' && eventThreadId) {
      const status = isRecord(eventParams.status) ? eventParams.status : {};
      const activeFlags = Array.isArray(status.activeFlags) ? status.activeFlags.filter((flag): flag is string => typeof flag === 'string') : [];
      interactionRecovery.scheduleProviderThreadStatusReconciliation(eventThreadId, event.generationId, status.type === 'active' && activeFlags.includes('waitingOnUserInput'));
    }
  }

  async function safelyHandleProviderEventError(event: CodexAppServerEvent, error: unknown, receiptEvents: readonly CodexAppServerEvent[] = [event]): Promise<void> {
    try {
      const params = isRecord(event.params) ? event.params : {};
      const threadId = typeof params.threadId === 'string' ? params.threadId : null;
      const conversation = threadId ? options.conversations.getByProviderThreadId(threadId) : undefined;
      const serialized = serializeError(error);
      const errorEntry = {
        generationId: event.generationId,
        sequence: event.sequence,
        method: event.method,
        receivedAt: event.receivedAt,
        error: serialized,
        ...(conversation ? { conversationId: conversation.id } : {}),
        ...(threadId ? { providerThreadId: threadId } : {}),
      };
      const currentErrors = options.settings.getJson<Array<typeof errorEntry>>(providerEventErrorsSettingKey) ?? [];
      options.settings.setJson(providerEventErrorsSettingKey, [...currentErrors, errorEntry].slice(-1_000));
      if (conversation && threadId) {
        const providerTurnId = providerTurnIdFrom(params) ?? [...options.turns.listByConversation(conversation.id)].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting')?.providerTurnId ?? null;
        const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
        if (providerTurnId && turn) {
          options.providerItems.upsertCompleted({
            conversationId: conversation.id,
            turnId: turn.id,
            providerThreadId: threadId,
            providerTurnId,
            providerItemId: `native-provider-event-error-${event.generationId}-${event.sequence}`,
            itemType: 'error',
            phase: 'prework',
            payload: errorEntry,
            textContent: `${serialized.code ? `${serialized.code}: ` : ''}${serialized.message}`,
            status: 'failed',
            completedAt: event.receivedAt,
            updatedAt: event.receivedAt,
          });
        }
      }
      for (const receiptEvent of receiptEvents) {
        const identity = codexProviderEventIdentity(receiptEvent);
        receipts.record(providerEventReceipt(receiptEvent, identity));
        maintainProviderReceiptGenerations(receiptEvent.generationId);
        rememberProcessedProviderEvent(receiptEvent, identity);
      }
      await persist();
      options.broadcast(conversation ? 'conversation.native.error' : 'codex.native.error', errorEntry);
    } catch (diagnosticError) {
      try {
        options.broadcast('codex.native.error', {
          generationId: event.generationId,
          sequence: event.sequence,
          method: event.method,
          error: serializeError(error),
          diagnosticError: serializeError(diagnosticError),
        });
      } catch {
        // Provider 监听器异常不得污染 manager 的后续事件链。
      }
    }
  }

  function hasProcessedProviderEvent(event: CodexAppServerEvent, identity: string): boolean {
    if (hotReceiptGenerationId === event.generationId && hotReceiptIdentities.has(identity)) return true;
    if (!receipts.has(identity)) return false;
    rememberProcessedProviderEvent(event, identity);
    return true;
  }

  function rememberProcessedProviderEvent(event: CodexAppServerEvent, identity: string): void {
    if (hotReceiptGenerationId !== event.generationId) {
      hotReceiptGenerationId = event.generationId;
      hotReceiptIdentities.clear();
    }
    hotReceiptIdentities.add(identity);
    while (hotReceiptIdentities.size > providerEventHotReceiptLimit) {
      const oldestIdentity = hotReceiptIdentities.values().next().value;
      if (typeof oldestIdentity !== 'string') break;
      hotReceiptIdentities.delete(oldestIdentity);
    }
  }

  function maintainProviderReceiptGenerations(generationId: string): void {
    if (maintainedReceiptGenerations.has(generationId)) return;
    maintainedReceiptGenerations.add(generationId);
    const retiredGenerationIds = receipts.listGenerationIds().filter((candidate) => candidate !== generationId && !options.manager.hasGeneration(candidate));
    receipts.deleteGenerations(retiredGenerationIds);
  }

  function beginHandoff(waiterError: Error): Promise<void> {
    if (handoffPromise) return handoffPromise;
    closing = true;
    providerStopRecovery.close();
    interactionRecovery.close();
    const providerAuthorityClose = providerThreadAuthority.close();
    for (const requestId of [...autoResolutionTimers.keys()]) clearAutoResolutionTimer(requestId);
    externalAnswerRecovery.close();
    // unsubscribe 后冻结已接收链；这些 handler 仍可完整持久化和广播，closed 只能在 drain 之后设置。
    const acceptedProviderEventChain = providerEvents.beginHandoff();
    const activeQueueDrain = queueDrainPromise;
    handoffPromise = (async () => {
      await Promise.all([acceptedProviderEventChain, activeQueueDrain, providerAuthorityClose]);
      await flushScheduledPersist();
      closed = true;
      for (const key of [...turnResultWaiters.keys()]) rejectTurnResultWaiters(key, waiterError);
    })();
    return handoffPromise;
  }

  return {
    startTaskConversation,
    startProjectConversation,
    startEphemeralConversation,
    waitForTurnResult,
    submitMessage,
    dispatchQueuedMessage,
    steerMessage,
    editQueuedSubmission,
    retryQueuedSubmission,
    deleteQueuedSubmission,
    reorderQueue,
    sendQueuedNow,
    resumeInterruptedQueue,
    recoverQueue,
    archiveConversation,
    restoreArchivedConversation,
    interruptTurn,
    respondToRequest,
    snoozeRequest,
    respondToPlanImplementationRequest,
    reconcilePersistedTerminalSubmissions,
    setGoal,
    readGoal,
    pauseGoal,
    resumeGoal,
    clearGoal,
    synchronizeOpenConversation,
    synchronizeConversations,
    requestProviderTurnStop: (input) => providerStopRecovery.requestStop(input),
    recover,
    close(input = { mode: 'final' }) {
      if (input.mode === 'handoff') {
        if (finalizationPromise) return finalizationPromise;
        return beginHandoff(coordinatorError('ZEUS_CODEX_SERVER_RESTARTING', 'The local server is restarting; retry the Graph request after reconnecting.'));
      }
      if (finalizationPromise) return finalizationPromise;
      finalizationPromise = (async () => {
        const error = coordinatorError('ZEUS_CODEX_COORDINATOR_CLOSED', 'Codex native conversation coordinator is closed.');
        pluginToolApprovals.close();
        for (const requestId of [...autoResolutionTimers.keys()]) clearAutoResolutionTimer(requestId);
        externalAnswerRecovery.close();
        await beginHandoff(error);
        const providerShutdownActions: Promise<void>[] = [];
        const interruptedTurns = new Set<string>();
        const pendingRequestIds: string[] = [];
        const providerActionEvidence = new Map<string, Record<string, unknown>>();
        // Ephemeral terminalization moves providerState to closed, so snapshot bound conversations before that transition.
        const nativeBoundConversations = options.conversations.listNativeBound('codex');

        for (const [conversationId, context] of [...contexts]) {
          if (!context.ephemeral) continue;
          const conversation = options.conversations.getById(conversationId);
          if (!conversation) continue;
          const state = runStates.get(conversationId);
          const providerTurnId = state?.type === 'active' || state?.type === 'waiting' ? state.turnId : null;
          markEphemeralConversationClosed(conversationId, providerTurnId, 'failed', serializeError(error));
          if (providerTurnId && conversation.providerThreadId) {
            const providerThreadId = conversation.providerThreadId;
            const interruptKey = `${providerThreadId}\0${providerTurnId}`;
            if (interruptedTurns.has(interruptKey)) continue;
            interruptedTurns.add(interruptKey);
            try {
              providerShutdownActions.push(
                executeTurnCommand({
                  operation: 'turn_interrupt',
                  conversationId,
                  threadId: providerThreadId,
                  turnId: providerTurnId,
                  commandKey: `turn-interrupt:${providerTurnId}`,
                  requestIdentity: { threadId: providerThreadId, turnId: providerTurnId },
                  invoke: (traceIdentity) => options.manager.interruptTurn({ threadId: providerThreadId, turnId: providerTurnId, traceIdentity }),
                }).catch((interruptError) => {
                  options.broadcast('conversation.native.ephemeral_interrupt_failed', {
                    conversationId,
                    providerThreadId,
                    providerTurnId,
                    error: serializeError(interruptError),
                  });
                }),
              );
            } catch (interruptError) {
              options.broadcast('conversation.native.ephemeral_interrupt_failed', {
                conversationId,
                providerThreadId: conversation.providerThreadId,
                providerTurnId,
                error: serializeError(interruptError),
              });
            }
          }
        }
        for (const key of [...turnResultWaiters.keys()]) rejectTurnResultWaiters(key, error);

        for (const conversation of nativeBoundConversations) {
          for (const request of options.requests.listByConversation(conversation.id)) {
            if (request.status !== 'pending') continue;
            pendingRequestIds.push(request.id);
            const providerRequestId = JSON.parse(request.providerRequestIdJson) as string | number;
            const requestTurn = request.turnId ? options.turns.getById(request.turnId) : undefined;
            const requestProviderTurnId = requestTurn?.providerTurnId ?? null;
            const requestProviderThreadId = conversation.providerThreadId;
            if (request.requestKind === 'command' || request.requestKind === 'file') {
              const response = {
                type: request.requestKind,
                decision: 'cancel',
                generationId: request.transportGenerationId,
                requestId: providerRequestId,
              } as CodexServerRequestResponse;
              providerShutdownActions.push(
                (requestProviderTurnId && requestProviderThreadId
                  ? executeTurnCommand({
                      operation: 'server_request_response',
                      conversationId: conversation.id,
                      threadId: requestProviderThreadId,
                      turnId: requestProviderTurnId,
                      commandKey: `server-request:${request.id}`,
                      requestIdentity: response,
                      issuedAt: request.createdAt,
                      providerGenerationId: request.transportGenerationId,
                      invoke: (traceIdentity) =>
                        options.manager.respondToServerRequest({
                          ...response,
                          traceIdentity,
                        }),
                    })
                  : Promise.reject(coordinatorError('ZEUS_CODEX_SERVER_REQUEST_TURN_REQUIRED', 'Pending Codex request lacks auditable native turn identity.'))
                )
                  .then(() => {
                    providerActionEvidence.set(request.id, { requestCancellation: 'accepted' });
                  })
                  .catch((cancelError) => {
                    providerActionEvidence.set(request.id, {
                      requestCancellation: 'outcome_unconfirmed',
                      cause: serializeError(cancelError),
                    });
                  }),
              );
              continue;
            }

            if (!requestProviderTurnId || !requestProviderThreadId) continue;
            const interruptKey = `${requestProviderThreadId}\0${requestProviderTurnId}`;
            if (interruptedTurns.has(interruptKey)) continue;
            interruptedTurns.add(interruptKey);
            providerShutdownActions.push(
              executeTurnCommand({
                operation: 'turn_interrupt',
                conversationId: conversation.id,
                threadId: requestProviderThreadId,
                turnId: requestProviderTurnId,
                commandKey: `turn-interrupt:${requestProviderTurnId}`,
                requestIdentity: { threadId: requestProviderThreadId, turnId: requestProviderTurnId },
                issuedAt: request.createdAt,
                providerGenerationId: request.transportGenerationId,
                invoke: (traceIdentity) => options.manager.interruptTurn({ threadId: requestProviderThreadId, turnId: requestProviderTurnId, traceIdentity }),
              })
                .then(() => {
                  providerActionEvidence.set(request.id, { turnInterrupt: 'accepted' });
                })
                .catch((interruptError) => {
                  providerActionEvidence.set(request.id, { turnInterrupt: 'outcome_unconfirmed', cause: serializeError(interruptError) });
                  options.broadcast('conversation.native.shutdown_interrupt_failed', {
                    conversationId: conversation.id,
                    providerThreadId: requestProviderThreadId,
                    providerTurnId: requestProviderTurnId,
                    error: serializeError(interruptError),
                  });
                }),
            );
          }
        }
        // 退出时所有 Provider 收口动作并行等待；逐个等待会把多个 30 秒超时串成数分钟，
        // 触发 Main 的安全退出失败弹窗，而对应结果本来就会按 outcome_unconfirmed 审计。
        await Promise.all(providerShutdownActions);
        const terminalized = finalizeCodexPendingInteractionsForShutdown(
          {
            db: options.db,
            conversations: options.conversations,
            turns: options.turns,
            submissions: options.submissions,
            requests: options.requests,
          },
          { requestIds: pendingRequestIds, occurredAt: now(), providerActionEvidence },
        );
        for (const conversationId of terminalized.pausedConversationIds) runStates.set(conversationId, { type: 'paused', reason: 'recovery_required' });
      })();
      return finalizationPromise;
    },
  };

  function accepted(submission: ZeusConversationSubmissionRecord, status: NativeAcceptedOperation['status'], providerThreadId: string | null, providerTurnId: string | null): NativeAcceptedOperation {
    return { operationId: operationId(), conversationId: submission.conversationId, submissionId: submission.id, status, providerThreadId, providerTurnId };
  }
}
