import type { ConversationSubmissionRepository, ZeusConversationSubmissionRecord } from '@zeus/storage';
import type { NativeConversationRunState, NativeQueueSnapshot } from './codexNativeConversationContracts.js';
import type { ConversationQueueCoreMutationApplication } from './conversationQueueCoreMutationApplication.js';

export function hasRecoveredUnsentSubmission(submissions: readonly ZeusConversationSubmissionRecord[]): boolean {
  return submissions.some((submission) => submission.status === 'paused' && !submission.providerTurnId && submission.pausedReason === 'recovered_unsent');
}

/** 多条恢复消息的逐条 retry/cancel 编排；Provider 写入仍由原队列排空器独占。 */
export function createCodexRecoveredUnsentQueueApplication(options: {
  transaction<T>(operation: () => T): T;
  mutations: Pick<ConversationQueueCoreMutationApplication, 'delete' | 'retry'>;
  submissions: Pick<ConversationSubmissionRepository, 'getById' | 'listByConversation'>;
  runStates: Map<string, NativeConversationRunState>;
  snapshot(conversationId: string): NativeQueueSnapshot;
  queueChanged(conversationId: string): void;
  persist(): Promise<void>;
  broadcast(type: string, payload: Record<string, unknown>): void;
  requestQueueDrain(): void;
}): {
  deleteQueuedSubmission(input: { conversationId: string; submissionId: string }): Promise<NativeQueueSnapshot>;
  retryQueuedSubmission(input: { conversationId: string; submissionId: string }): Promise<NativeQueueSnapshot>;
} {
  async function deleteQueuedSubmission(input: { conversationId: string; submissionId: string }): Promise<NativeQueueSnapshot> {
    const recoveredUnsent = options.submissions.getById(input.submissionId)?.pausedReason === 'recovered_unsent';
    let snapshot = options.transaction(() => options.mutations.delete(input)) as NativeQueueSnapshot;
    const currentState = options.runStates.get(input.conversationId);
    if (recoveredUnsent && (!currentState || (currentState.type === 'paused' && currentState.reason === 'recovered_unsent') || currentState.type === 'idle')) {
      options.runStates.set(input.conversationId, hasRecoveredUnsentSubmission(options.submissions.listByConversation(input.conversationId)) ? { type: 'paused', reason: 'recovered_unsent' } : { type: 'idle' });
      snapshot = options.snapshot(input.conversationId);
    }
    options.queueChanged(input.conversationId);
    await options.persist();
    options.broadcast('conversation.queue.changed', { conversationId: input.conversationId });
    if (recoveredUnsent && snapshot.state.type === 'idle') options.requestQueueDrain();
    return snapshot;
  }

  async function retryQueuedSubmission(input: { conversationId: string; submissionId: string }): Promise<NativeQueueSnapshot> {
    const recoveredUnsent = options.submissions.getById(input.submissionId)?.pausedReason === 'recovered_unsent';
    let snapshot = options.transaction(() => options.mutations.retry(input)) as NativeQueueSnapshot;
    const currentState = options.runStates.get(input.conversationId);
    if (recoveredUnsent && (!currentState || (currentState.type === 'paused' && currentState.reason === 'recovered_unsent') || currentState.type === 'idle')) {
      // 用户只确认了当前这一条；其 replacement 可以派发，其余恢复消息继续保持 paused。
      options.runStates.set(input.conversationId, { type: 'idle' });
      snapshot = options.snapshot(input.conversationId);
    }
    await options.persist();
    options.broadcast('conversation.queue.changed', { conversationId: input.conversationId });
    options.requestQueueDrain();
    return snapshot;
  }

  return { deleteQueuedSubmission, retryQueuedSubmission };
}
