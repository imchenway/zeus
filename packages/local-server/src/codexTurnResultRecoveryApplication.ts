import type { ZeusConversationTurnRecord } from '@zeus/storage';
import type { WaitForNativeTurnResultInput } from './codexNativeConversationContracts.js';
import { coordinatorError, failedTurnErrorFromRecord, serializeError } from './codexNativeConversationPolicy.js';
import { providerStopPendingError } from './codexProviderStopRecoveryApplication.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodexTurnResultRecoveryDependencies = Record<string, any>;

export function createCodexTurnResultRecoveryApplication(dependencies: CodexTurnResultRecoveryDependencies) {
  const {
    closeEphemeralConversation,
    completedTurnResults,
    enqueueProviderTurnReconciliation,
    failedTurnResults,
    isClosed,
    now,
    options,
    persist,
    providerStopRecovery,
    rejectTurnResultWaiters,
    resolveTurnResult,
    runStates,
    turnResultWaiters,
  } = dependencies;

  function resolveTurnResultFromDurableTurn(conversationId: string, turn: { providerThreadId: string; providerTurnId: string | null; status: string }): void {
    if (!turn.providerTurnId || (turn.status !== 'completed' && turn.status !== 'interrupted')) return;
    const conversation = options.conversations.getById(conversationId);
    if (!conversation || conversation.providerThreadId !== turn.providerThreadId) return;
    const answer = [...conversation.messages].reverse().find((message) => message.providerTurnId === turn.providerTurnId && message.role === 'assistant')?.content ?? '';
    resolveTurnResult({ conversationId, providerThreadId: turn.providerThreadId, providerTurnId: turn.providerTurnId, status: turn.status, answer });
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
    const persistedTurn = options.turns.listByConversation(input.conversationId).find((turn: ZeusConversationTurnRecord) => turn.providerTurnId === input.providerTurnId);
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
    const turn = options.turns.listByConversation(conversationId).find((candidate: ZeusConversationTurnRecord) => candidate.providerTurnId === providerTurnId);
    if (!turn || turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed') return;
    const timestamp = now();
    const stopCommandId = `turn-interrupt:${providerTurnId}`;
    const error = providerStopPendingError({ providerThreadId, providerTurnId, stopCommandId, requestedAt: timestamp, cause: serializeError(cause) });
    options.turns.upsert({ ...turn, status: 'interrupted', error, completedAt: timestamp, updatedAt: timestamp });
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (!submission.providerTurnId && submission.status === 'queued') {
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'provider_stop_pending', error, updatedAt: timestamp });
      }
    }
    const currentConversation = options.conversations.getById(conversationId);
    if (currentConversation?.providerThreadId === providerThreadId) {
      options.conversations.bindProvider(conversationId, { providerId: 'codex', providerThreadId, providerModel: currentConversation.providerModel, providerState: 'paused' });
    }
    runStates.set(conversationId, { type: 'paused', reason: 'provider_stop_pending' });
    await persist();
    options.broadcast('conversation.native.provider_stop_pending', { conversationId, providerThreadId, providerTurnId, stopCommandId, error });
    options.broadcast('conversation.queue.changed', { conversationId, providerThreadId, providerTurnId, waitReason: 'provider_stop_pending' });
    void providerStopRecovery.retry(conversationId).catch(() => undefined);
  }

  return { markInterruptedTurnProviderStopPending, reconcileInterruptedTurnUntilSettled, timeoutTurnResult };
}
