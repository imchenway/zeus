import type { ZeusConversationServerRequestRecord, ZeusConversationSubmissionRecord, ZeusConversationTurnRecord, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import { coordinatorError, parseJsonRecord, requireString, serializeError } from './codexNativeConversationPolicy.js';

// 协调器仍是组合根；此处只拥有“Provider 报告等待交互，但 Zeus 未持有交互权限”这一恢复边界。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodexInteractionRecoveryDependencies = Record<string, any>;

export function isRetiredGenerationFailure(request: ZeusConversationServerRequestRecord): boolean {
  if (request.status !== 'failed' || !request.responseJson) return false;
  try {
    return parseJsonRecord(request.responseJson).error === 'ZEUS_CODEX_REQUEST_GENERATION_STALE';
  } catch {
    return false;
  }
}

export function createCodexInteractionRecoveryApplication(dependencies: CodexInteractionRecoveryDependencies) {
  const { enqueueProviderTurnReconciliation, executeTurnCommand, isClosed, isPendingInteractionAuthority, now, options, persist, projectedProviderThreadSnapshot, readyGenerationId, reconcileConversationSnapshot, runStates } = dependencies;
  const reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
          invoke: (traceIdentity: Record<string, unknown>) => options.manager.interruptTurn({ threadId: input.threadId, turnId: providerTurnId, traceIdentity }),
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

  function close(): void {
    for (const timer of reconciliationTimers.values()) clearTimeout(timer);
    reconciliationTimers.clear();
  }

  return { close, failInvalidInteractionAuthority, scheduleProviderThreadStatusReconciliation };
}
