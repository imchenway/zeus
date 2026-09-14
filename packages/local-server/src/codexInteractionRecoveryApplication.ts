import type { CodexThreadSnapshot } from '@zeus/ai-runtime';
import type { ZeusConversationServerRequestRecord, ZeusConversationSubmissionRecord, ZeusConversationTurnRecord, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import type { CreateCodexNativeConversationCoordinatorOptions, NativeConversationRunState, NativeTurnCommandExecutor, NativeTurnResult, NativeTurnResultWaiter, WaitForNativeTurnResultInput } from './codexNativeConversationContracts.js';
import { coordinatorError, failedTurnErrorFromRecord, parseJsonRecord, requireString, serializeError } from './codexNativeConversationPolicy.js';
import { createCodexProviderStopRecoveryApplication, providerStopPendingError } from './codexProviderStopRecoveryApplication.js';
import type { CodexExternalRequestAnswerRecovery } from './codexExternalRequestAnswerRecovery.js';

interface CodexInteractionRecoveryDependencies {
  options: CreateCodexNativeConversationCoordinatorOptions;
  runStates: Map<string, NativeConversationRunState>;
  completedTurnResults: Map<string, NativeTurnResult>;
  failedTurnResults: Map<string, Error & { code: string }>;
  turnResultWaiters: Map<string, NativeTurnResultWaiter[]>;
  providerStopRecovery: ReturnType<typeof createCodexProviderStopRecoveryApplication>;
  /** 恢复前核对已落盘的真实答案，避免重新询问已在其他客户端回答的问题。 */
  recoverExternalRequestAnswer: CodexExternalRequestAnswerRecovery['recover'];

  now(): string;

  isClosed(): boolean;

  persist(): Promise<void>;

  readyGenerationId(): string | null;

  enqueueProviderTurnReconciliation(
    conversation: ZeusConversationWithMessagesRecord,
    input?: {
      priority?: 'control';
    },
  ): Promise<void>;

  executeTurnCommand: NativeTurnCommandExecutor;

  isPendingInteractionAuthority(request: ZeusConversationServerRequestRecord): boolean;

  projectedProviderThreadSnapshot(conversationId: string, metadata: CodexThreadSnapshot): CodexThreadSnapshot;

  reconcileConversationSnapshot(
    conversation: ZeusConversationWithMessagesRecord,
    snapshot: CodexThreadSnapshot,
    generationId: string,
    input?: {
      preserveUnsentQueue?: boolean;
    },
  ): void;

  closeEphemeralConversation(conversationId: string, providerTurnId: string | null, submissionStatus: 'cancelled' | 'failed', error: unknown, interrupt: boolean): Promise<void>;

  rejectTurnResultWaiters(key: string, error: Error): void;

  resolveTurnResult(result: NativeTurnResult): void;
}

/** 只恢复连接切换或退出造成的失败，不重开用户已拒绝、取消或正常结束的请求。 */
function isDisconnectedInteractionFailure(request: ZeusConversationServerRequestRecord): boolean {
  if (request.status !== 'failed' || !request.responseJson) return false;
  try {
    /** 退出与旧连接事件使用相同的错误编号，但保存字段可能不同。 */
    const failure = parseJsonRecord(request.responseJson);
    return ['ZEUS_CODEX_REQUEST_GENERATION_STALE', 'ZEUS_FORCED_QUIT_INTERRUPTED', 'ZEUS_CODEX_FINAL_QUIT_OUTCOME_UNCONFIRMED'].includes(String(failure.code ?? failure.error));
  } catch {
    return false;
  }
}

export function isInteractionRecoveryCheckpointRequest(request: ZeusConversationServerRequestRecord): boolean {
  if (!request.responseJson) return false;
  try {
    const response = parseJsonRecord(request.responseJson);
    return response.interactionRecoveryCheckpoint === true || response.handoffCheckpoint === true;
  } catch {
    return false;
  }
}

export function createCodexInteractionRecoveryApplication(dependencies: CodexInteractionRecoveryDependencies) {
  const {
    closeEphemeralConversation,
    completedTurnResults,
    enqueueProviderTurnReconciliation,
    executeTurnCommand,
    failedTurnResults,
    isClosed,
    isPendingInteractionAuthority,
    now,
    options,
    persist,
    projectedProviderThreadSnapshot,
    providerStopRecovery,
    readyGenerationId,
    recoverExternalRequestAnswer,
    reconcileConversationSnapshot,
    rejectTurnResultWaiters,
    resolveTurnResult,
    runStates,
    turnResultWaiters,
  } = dependencies;
  const reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 启动调度与恢复操作共用筛选，不因会话已回到空闲状态而遗漏未答卡片。 */
  function recoverableInteractionRequests(conversationId: string): ZeusConversationServerRequestRecord[] {
    /** 只在原会话绑定的线程中核对答案和最后一个待处理请求。 */
    const conversation = options.conversations.getRecordById(conversationId);
    if (!conversation?.providerThreadId || conversation.archived || conversation.providerState === 'archived' || conversation.providerState === 'closed') return [];
    /** 请求列表按创建顺序排列，失败历史只有最后一项允许重新恢复。 */
    const requests = options.requests.listByConversation(conversationId) as ZeusConversationServerRequestRecord[];
    /** 后续请求已经出现时，不复活更早的失败请求。 */
    const latestRequest = requests.at(-1);
    // 普通已完成会话不加载轮次和正文；只有未决交互需要参与启动恢复。
    if (!latestRequest || (!requests.some((request) => request.status === 'pending') && !isDisconnectedInteractionFailure(latestRequest))) return [];
    /** 后续轮次或正常完成说明旧问题已被取代。 */
    const latestTurn = options.turns
      .listByConversation(conversationId)
      .filter((turn) => turn.providerThreadId === conversation.providerThreadId)
      .at(-1);
    return requests.filter((request) => {
      if (options.manager.hasGeneration(request.transportGenerationId)) return false;
      /** 失败请求需同时属于最新请求与未正常完成的最新轮次。 */
      const recoverableFailure = request.id === latestRequest?.id && request.turnId === latestTurn?.id && latestTurn?.status !== 'completed' && isDisconnectedInteractionFailure(request);
      return request.status === 'pending' || recoverableFailure;
    });
  }

  /** 所有持久交互共用显式续接入口；旧连接编号始终不能重新作为实时请求发送。 */
  async function recoverStaleInteractionRequests(conversationId: string, currentGenerationId: string): Promise<void> {
    /** 同一批恢复使用相同时间，保持请求与恢复标记一致。 */
    const timestamp = now();
    /** 只读取原会话绑定的模型历史。 */
    const conversation = options.conversations.getById(conversationId);
    if (!conversation?.providerThreadId) return;
    for (const request of recoverableInteractionRequests(conversationId)) {
      if (request.requestKind === 'request_user_input') {
        /** 已回答的真实记录优先；退出写入的中止提示不等于用户回答。 */
        const recovered = await recoverExternalRequestAnswer(conversation, request, timestamp);
        if (isClosed() || readyGenerationId() !== currentGenerationId) return;
        if (recovered.recovery.status === 'found') continue;
        /** 读取历史期间若收到用户回复或取消，以最新持久状态为准。 */
        const currentRequest = options.requests.getById(request.id);
        if (currentRequest?.status !== request.status || currentRequest.responseJson !== request.responseJson) continue;
      }
      if (isInteractionRecoveryCheckpointRequest(request)) continue;
      options.requests.restorePendingAfterTransportRecovery(request.id, {
        recoveryReason: 'app_server_generation_changed',
        sourceGenerationId: request.transportGenerationId,
        currentGenerationId,
        restoredAt: timestamp,
      });
    }
  }

  async function failInvalidInteractionAuthority(input: {
    conversation: ZeusConversationWithMessagesRecord;
    threadId: string;
    providerTurnId: string | null;
    turn: ZeusConversationTurnRecord | undefined;
    request: Pick<ZeusConversationServerRequestRecord, 'id' | 'status' | 'createdAt' | 'transportGenerationId'>;
    error: Record<string, unknown>;
    timestamp: string;
  }): Promise<Record<string, unknown>> {
    const interactionError: Record<string, unknown> = { ...input.error, recoveryRequired: false };
    if (input.request.status === 'pending') options.requests.fail(input.request.id, { error: interactionError, resolvedAt: input.timestamp });
    let interruptFailed = false;
    if (input.providerTurnId) {
      try {
        const providerTurnId = input.providerTurnId;
        await executeTurnCommand({
          operation: 'turn_interrupt',
          conversationId: input.conversation.id,
          threadId: input.threadId,
          turnId: providerTurnId,
          commandKey: `turn-interrupt:${providerTurnId}`,
          requestIdentity: { threadId: input.threadId, turnId: providerTurnId },
          issuedAt: input.request.createdAt,
          providerGenerationId: input.request.transportGenerationId,
          invoke: (traceIdentity) =>
            options.manager.interruptTurn({
              threadId: input.threadId,
              turnId: providerTurnId,
              traceIdentity,
            }),
        });
      } catch (error) {
        interruptFailed = true;
        interactionError.interruptError = serializeError(error);
      }
    }
    if (input.turn) {
      options.turns.upsert({ ...input.turn, status: 'failed', error: interactionError, completedAt: input.timestamp, updatedAt: input.timestamp });
      const activeSubmission = input.turn.clientSubmissionId ? options.submissions.getById(input.turn.clientSubmissionId) : undefined;
      if (activeSubmission && (activeSubmission.status === 'dispatching' || activeSubmission.status === 'active')) {
        options.submissions.updateStatus(activeSubmission.id, 'failed', {
          providerTurnId: input.providerTurnId,
          error: interactionError,
          resolvedAt: input.timestamp,
          updatedAt: input.timestamp,
        });
      }
    }
    options.conversations.bindProvider(input.conversation.id, {
      providerId: 'codex',
      providerThreadId: input.threadId,
      providerModel: input.conversation.providerModel,
      providerState: interruptFailed ? 'failed' : 'ready',
    });
    runStates.set(input.conversation.id, { type: 'idle' });
    options.broadcast('conversation.queue.changed', { conversationId: input.conversation.id });
    return interactionError;
  }

  function scheduleProviderThreadStatusReconciliation(threadId: string, generationId: string, reportsWaitingOnUserInput: boolean): void {
    const existing = reconciliationTimers.get(threadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(
      () => {
        reconciliationTimers.delete(threadId);
        void reconcileProviderThreadRuntimeStatus(threadId, generationId).catch((error) => {
          const conversation = options.conversations.getByProviderThreadId(threadId);
          if (!conversation) return;
          options.execution.persistWarning({
            conversationId: conversation.id,
            warningKind: 'provider_reconciliation_deferred',
            payload: { providerThreadId: threadId, generationId, source: 'thread_status_changed', error: serializeError(error) },
            occurredAt: now(),
          });
          void persist().catch(() => undefined);
          options.broadcast('conversation.warning.changed', { conversationId: conversation.id, warningKind: 'provider_reconciliation_deferred' });
        });
      },
      reportsWaitingOnUserInput ? 750 : 200,
    );
    timer.unref();
    reconciliationTimers.set(threadId, timer);
  }

  async function reconcileProviderThreadRuntimeStatus(threadId: string, eventGenerationId: string): Promise<void> {
    if (isClosed()) return;
    const conversation = options.conversations.getByProviderThreadId(threadId);
    if (!conversation || conversation.providerThreadId !== threadId) return;
    const metadata = await options.manager.readThread({ threadId, priority: 'control' });
    if (metadata.id !== threadId) throw coordinatorError('ZEUS_CODEX_THREAD_IDENTITY_MISMATCH', 'Codex returned a different thread while reconciling runtime status.');
    await enqueueProviderTurnReconciliation(conversation, { priority: 'control' });
    const current = options.conversations.getById(conversation.id);
    if (!current?.providerThreadId || current.providerThreadId !== threadId) return;
    const generationId = options.manager.generationForThread(threadId) ?? (options.manager.hasGeneration(eventGenerationId) ? eventGenerationId : readyGenerationId());
    if (!generationId) throw coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread status has no authoritative runtime generation.');
    reconcileConversationSnapshot(current, projectedProviderThreadSnapshot(current.id, metadata), generationId, { preserveUnsentQueue: true });

    const waitingOnUserInput = metadata.status?.type === 'active' && metadata.status.activeFlags.includes('waitingOnUserInput');
    const turns = options.turns.listByConversation(current.id);
    const providerTurn = [...turns].reverse().find((turn) => turn.providerTurnId && (turn.status === 'running' || turn.status === 'waiting' || isInteractionAuthorityMissingTurnRecord(turn)));
    if (waitingOnUserInput && providerTurn?.providerTurnId) {
      const pending = options.requests.listByConversation(current.id).find((request: ZeusConversationServerRequestRecord) => request.turnId === providerTurn.id && isPendingInteractionAuthority(request));
      if (pending) restoreInteractionAuthority(current, providerTurn, pending.id, pending.requestKind === 'request_user_input' ? 'user_input' : 'approval', generationId);
      else markInteractionAuthorityMissing(current, providerTurn, generationId);
    } else if (!waitingOnUserInput) {
      restoreProviderActivityAfterMissingInteraction(current, providerTurn, metadata.status?.type === 'active');
    }
    options.execution.resolveWarning(current.id, 'provider_reconciliation_deferred', now());
    await persist();
  }

  function isInteractionAuthorityMissingTurnRecord(turn: ZeusConversationTurnRecord): boolean {
    return parseJsonRecord(turn.errorJson ?? '{}').code === 'ZEUS_PROVIDER_INTERACTION_AUTHORITY_MISSING';
  }

  function markInteractionAuthorityMissing(conversation: ZeusConversationWithMessagesRecord, turn: ZeusConversationTurnRecord, generationId: string): void {
    const timestamp = now();
    const error = {
      code: 'ZEUS_PROVIDER_INTERACTION_AUTHORITY_MISSING',
      message: 'Provider 正在等待用户输入，但问题通道未能恢复。请停止当前任务后重新发送。',
      recoveryRequired: true,
      retryable: false,
      providerThreadId: conversation.providerThreadId,
      providerTurnId: turn.providerTurnId,
      generationId,
    };
    options.turns.upsert({ ...turn, status: 'waiting', error, completedAt: null, updatedAt: timestamp });
    const submission = turn.clientSubmissionId
      ? options.submissions.getById(turn.clientSubmissionId)
      : options.submissions.listByConversation(conversation.id).find((candidate: ZeusConversationSubmissionRecord) => candidate.providerTurnId === turn.providerTurnId);
    if (submission && (submission.status === 'active' || submission.status === 'dispatching' || (submission.status === 'paused' && submission.pausedReason === 'recovery_required'))) {
      options.submissions.updateStatus(submission.id, 'paused', { providerTurnId: turn.providerTurnId, pausedReason: 'recovery_required', error, updatedAt: timestamp });
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
      providerModel: conversation.providerModel,
      providerState: 'paused',
    });
    runStates.set(conversation.id, { type: 'paused', reason: 'interaction_authority_missing' });
    options.execution.persistWarning({ conversationId: conversation.id, warningKind: 'provider_interaction_authority_missing', payload: error, occurredAt: timestamp });
    options.broadcast('conversation.warning.changed', { conversationId: conversation.id, warningKind: 'provider_interaction_authority_missing' });
    options.broadcast('conversation.thread.changed', { conversationId: conversation.id, providerThreadId: conversation.providerThreadId, providerState: 'paused' });
    options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId: conversation.providerThreadId, providerTurnId: turn.providerTurnId, waitReason: 'interaction_authority_missing' });
  }

  function restoreInteractionAuthority(conversation: ZeusConversationWithMessagesRecord, turn: ZeusConversationTurnRecord, requestId: string, reason: 'user_input' | 'approval', generationId: string): void {
    const timestamp = now();
    const restoredTurn = isInteractionAuthorityMissingTurnRecord(turn) ? options.turns.upsert({ ...turn, status: 'waiting', completedAt: null, updatedAt: timestamp }) : turn;
    const submission = restoredTurn.clientSubmissionId ? options.submissions.getById(restoredTurn.clientSubmissionId) : undefined;
    if (submission?.status === 'paused' && submission.pausedReason === 'recovery_required' && parseJsonRecord(submission.errorJson ?? '{}').code === 'ZEUS_PROVIDER_INTERACTION_AUTHORITY_MISSING') {
      options.submissions.updateStatus(submission.id, 'active', { providerTurnId: restoredTurn.providerTurnId, updatedAt: timestamp });
    }
    options.execution.resolveWarning(conversation.id, 'provider_interaction_authority_missing', timestamp);
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
      providerModel: conversation.providerModel,
      providerState: 'waiting',
    });
    runStates.set(conversation.id, { type: 'waiting', turnId: requireString(restoredTurn.providerTurnId, 'provider turn id'), requestId, reason });
    options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId: conversation.providerThreadId, providerTurnId: restoredTurn.providerTurnId, waitReason: reason, generationId });
  }

  function restoreProviderActivityAfterMissingInteraction(conversation: ZeusConversationWithMessagesRecord, turn: ZeusConversationTurnRecord | undefined, providerStillActive: boolean): void {
    if (!turn || !isInteractionAuthorityMissingTurnRecord(turn)) {
      if (!providerStillActive) options.execution.resolveWarning(conversation.id, 'provider_interaction_authority_missing', now());
      return;
    }
    const timestamp = now();
    options.execution.resolveWarning(conversation.id, 'provider_interaction_authority_missing', timestamp);
    if (!providerStillActive || !turn.providerTurnId) return;
    const restoredTurn = options.turns.upsert({ ...turn, status: 'running', completedAt: null, updatedAt: timestamp });
    const submission = restoredTurn.clientSubmissionId ? options.submissions.getById(restoredTurn.clientSubmissionId) : undefined;
    if (submission?.status === 'paused' && submission.pausedReason === 'recovery_required' && parseJsonRecord(submission.errorJson ?? '{}').code === 'ZEUS_PROVIDER_INTERACTION_AUTHORITY_MISSING') {
      options.submissions.updateStatus(submission.id, 'active', { providerTurnId: restoredTurn.providerTurnId, updatedAt: timestamp });
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
      providerModel: conversation.providerModel,
      providerState: 'active',
    });
    runStates.set(conversation.id, { type: 'active', turnId: turn.providerTurnId, phase: 'prework' });
  }

  function resolveTurnResultFromDurableTurn(
    conversationId: string,
    turn: {
      providerThreadId: string;
      providerTurnId: string | null;
      status: string;
    },
  ): void {
    if (!turn.providerTurnId || (turn.status !== 'completed' && turn.status !== 'interrupted')) return;
    const conversation = options.conversations.getById(conversationId);
    if (!conversation || conversation.providerThreadId !== turn.providerThreadId) return;
    const answer = [...conversation.messages].reverse().find((message) => message.providerTurnId === turn.providerTurnId && message.role === 'assistant')?.content ?? '';
    resolveTurnResult({
      conversationId,
      providerThreadId: turn.providerThreadId,
      providerTurnId: turn.providerTurnId,
      status: turn.status,
      answer,
    });
  }

  async function timeoutTurnResult(input: WaitForNativeTurnResultInput, key: string): Promise<void> {
    if (!turnResultWaiters.has(key)) return;
    const conversation = options.conversations.getById(input.conversationId);
    if (conversation?.providerThreadId && !isClosed()) {
      try {
        await enqueueProviderTurnReconciliation(conversation, { priority: 'control' });
      } catch (error) {
        options.broadcast('conversation.native.turn_result_reconciliation_deferred', {
          conversationId: input.conversationId,
          providerThreadId: conversation.providerThreadId,
          providerTurnId: input.providerTurnId,
          error: serializeError(error),
        });
      }
    }
    if (!turnResultWaiters.has(key)) return;
    const persistedTurn = options.turns.listByConversation(input.conversationId).find((turn) => turn.providerTurnId === input.providerTurnId);
    if (persistedTurn?.status === 'completed' || persistedTurn?.status === 'interrupted') {
      resolveTurnResultFromDurableTurn(input.conversationId, persistedTurn);
      return;
    }
    if (persistedTurn?.status === 'failed') {
      const failure = failedTurnErrorFromRecord(persistedTurn);
      failedTurnResults.set(key, failure);
      rejectTurnResultWaiters(key, failure);
      return;
    }
    const error = coordinatorError('ZEUS_CODEX_TURN_RESULT_TIMEOUT', 'Codex native turn did not complete before the timeout.');
    await closeEphemeralConversation(input.conversationId, input.providerTurnId, 'cancelled', serializeError(error), true);
    rejectTurnResultWaiters(key, error);
  }

  async function reconcileInterruptedTurnUntilSettled(conversationId: string, providerTurnId: string): Promise<void> {
    for (const delayMs of [0, 150, 400, 900, 1_800] as const) {
      if (delayMs > 0) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
      const key = `${conversationId}:${providerTurnId}`;
      if (completedTurnResults.has(key) || failedTurnResults.has(key) || isClosed()) return;
      const conversation = options.conversations.getById(conversationId);
      if (!conversation?.providerThreadId) return;
      try {
        await enqueueProviderTurnReconciliation(conversation, { priority: 'control' });
      } catch (error) {
        options.broadcast('conversation.native.turn_result_reconciliation_deferred', {
          conversationId,
          providerThreadId: conversation.providerThreadId,
          providerTurnId,
          error: serializeError(error),
        });
      }
    }
  }

  async function markInterruptedTurnProviderStopPending(conversationId: string, providerThreadId: string, providerTurnId: string, cause: unknown): Promise<void> {
    const turn = options.turns.listByConversation(conversationId).find((candidate) => candidate.providerTurnId === providerTurnId);
    if (!turn || turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed') return;
    const timestamp = now();
    const stopCommandId = `turn-interrupt:${providerTurnId}`;
    const error = providerStopPendingError({
      providerThreadId,
      providerTurnId,
      stopCommandId,
      requestedAt: timestamp,
      cause: serializeError(cause),
    });
    options.turns.upsert({ ...turn, status: 'interrupted', error, completedAt: timestamp, updatedAt: timestamp });
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (!submission.providerTurnId && submission.status === 'queued') {
        options.submissions.updateStatus(submission.id, 'paused', {
          pausedReason: 'provider_stop_pending',
          error,
          updatedAt: timestamp,
        });
      }
    }
    const currentConversation = options.conversations.getById(conversationId);
    if (currentConversation?.providerThreadId === providerThreadId) {
      options.conversations.bindProvider(conversationId, {
        providerId: 'codex',
        providerThreadId,
        providerModel: currentConversation.providerModel,
        providerState: 'paused',
      });
    }
    runStates.set(conversationId, { type: 'paused', reason: 'provider_stop_pending' });
    await persist();
    options.broadcast('conversation.native.provider_stop_pending', {
      conversationId,
      providerThreadId,
      providerTurnId,
      stopCommandId,
      error,
    });
    options.broadcast('conversation.queue.changed', {
      conversationId,
      providerThreadId,
      providerTurnId,
      waitReason: 'provider_stop_pending',
    });
    void providerStopRecovery.retry(conversationId).catch(() => undefined);
  }

  function close(): void {
    for (const timer of reconciliationTimers.values()) clearTimeout(timer);
    reconciliationTimers.clear();
  }

  return {
    close,
    /** 未答卡片主动参与启动恢复，无需等界面周期同步或用户先发一条消息。 */
    hasRecoverableInteraction: (conversationId: string) => recoverableInteractionRequests(conversationId).length > 0,
    failInvalidInteractionAuthority,
    markInterruptedTurnProviderStopPending,
    reconcileInterruptedTurnUntilSettled,
    recoverStaleInteractionRequests,
    scheduleProviderThreadStatusReconciliation,
    timeoutTurnResult,
  };
}
