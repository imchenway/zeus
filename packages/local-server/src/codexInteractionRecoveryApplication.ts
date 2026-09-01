import type { CodexThreadSnapshot } from '@zeus/ai-runtime';
import type { ZeusConversationServerRequestRecord, ZeusConversationSubmissionRecord, ZeusConversationTurnRecord, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import type { CreateCodexNativeConversationCoordinatorOptions, NativeConversationRunState, NativeTurnCommandExecutor, NativeTurnResult, NativeTurnResultWaiter, WaitForNativeTurnResultInput } from './codexNativeConversationContracts.js';
import { coordinatorError, failedTurnErrorFromRecord, parseJsonRecord, requireString, serializeError } from './codexNativeConversationPolicy.js';
import { createCodexProviderStopRecoveryApplication, providerStopPendingError } from './codexProviderStopRecoveryApplication.js';

interface CodexInteractionRecoveryDependencies {
  options: CreateCodexNativeConversationCoordinatorOptions;
  runStates: Map<string, NativeConversationRunState>;
  completedTurnResults: Map<string, NativeTurnResult>;
  failedTurnResults: Map<string, Error & { code: string }>;
  turnResultWaiters: Map<string, NativeTurnResultWaiter[]>;
  providerStopRecovery: ReturnType<typeof createCodexProviderStopRecoveryApplication>;

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

export function isRetiredGenerationFailure(request: ZeusConversationServerRequestRecord): boolean {
  if (request.status !== 'failed' || !request.responseJson) return false;
  try {
    return parseJsonRecord(request.responseJson).error === 'ZEUS_CODEX_REQUEST_GENERATION_STALE';
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
    reconcileConversationSnapshot,
    rejectTurnResultWaiters,
    resolveTurnResult,
    runStates,
    turnResultWaiters,
  } = dependencies;
  const reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function recoverStaleInteractionRequests(conversationId: string, currentGenerationId: string): void {
    const timestamp = now();
    const requests = options.requests.listByConversation(conversationId) as ZeusConversationServerRequestRecord[];
    const latestRequest = requests.at(-1);
    for (const request of requests) {
      if (options.manager.hasGeneration(request.transportGenerationId)) continue;
      // request_user_input 的提交权限严格绑定产生它的 app-server 世代。旧世代请求即使曾被
      // 标成恢复检查点，也只能由 rollout 补成只读历史；只有当前世代重放出的真实请求
      // 才能重新提供提交入口，避免中止或完成后的会话仍显示可交互问题通道。
      if (request.requestKind === 'request_user_input' && (request.status === 'pending' || isInteractionRecoveryCheckpointRequest(request) || isRetiredGenerationFailure(request))) {
        options.requests.fail(request.id, {
          error: {
            error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE',
            recoveryRequired: false,
            sourceGenerationId: request.transportGenerationId,
            currentGenerationId,
          },
          resolvedAt: timestamp,
        });
        continue;
      }
      if (isInteractionRecoveryCheckpointRequest(request)) continue;
      const recoverableFailure = request.id === latestRequest?.id && isRetiredGenerationFailure(request);
      if (request.status !== 'pending' && !recoverableFailure) continue;
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
    failInvalidInteractionAuthority,
    markInterruptedTurnProviderStopPending,
    reconcileInterruptedTurnUntilSettled,
    recoverStaleInteractionRequests,
    scheduleProviderThreadStatusReconciliation,
    timeoutTurnResult,
  };
}
