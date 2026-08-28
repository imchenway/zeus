import type {
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  ZeusConversationServerRequestRecord,
  ZeusConversationSubmissionRecord,
  ZeusConversationWithMessagesRecord,
} from '@zeus/storage';
import type { NativeConversationRunState } from './codexNativeConversationContracts.js';
import { isProviderStopPendingTurn } from './codexProviderStopRecoveryApplication.js';

export function interruptedQueueSubmissions(submissions: readonly ZeusConversationSubmissionRecord[]): ZeusConversationSubmissionRecord[] {
  return submissions.filter((submission) => !submission.providerTurnId && (submission.status === 'queued' || (submission.status === 'paused' && submission.pausedReason === 'interrupted')));
}

export function inferNativeConversationRunState(
  conversation: ZeusConversationWithMessagesRecord,
  repositories: {
    submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>;
    turns: Pick<ConversationTurnRepository, 'listByConversation'>;
    requests: Pick<ConversationServerRequestRepository, 'listByConversation'>;
  },
  isPendingInteractionAuthority: (request: ZeusConversationServerRequestRecord) => boolean,
): NativeConversationRunState {
  const submissions = repositories.submissions.listByConversation(conversation.id);
  if (conversation.providerState === 'archived') return { type: 'paused', reason: 'provider_archived' };
  if (conversation.providerState === 'paused' && repositories.turns.listByConversation(conversation.id).some(isProviderStopPendingTurn)) {
    return { type: 'paused', reason: 'provider_stop_pending' };
  }
  if (interruptedQueueSubmissions(submissions).some((submission) => submission.status === 'paused')) {
    return { type: 'paused', reason: 'interrupted' };
  }
  const activeTurn = [...repositories.turns.listByConversation(conversation.id)].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching');
  if (activeTurn?.providerTurnId) {
    if (activeTurn.status === 'waiting') {
      const pending = repositories.requests.listByConversation(conversation.id).find((request) => request.turnId === activeTurn.id && isPendingInteractionAuthority(request));
      if (pending) {
        return {
          type: 'waiting',
          turnId: activeTurn.providerTurnId,
          requestId: pending.id,
          reason: pending.requestKind === 'request_user_input' ? 'user_input' : 'approval',
        };
      }
    }
    return { type: 'active', turnId: activeTurn.providerTurnId, phase: 'prework' };
  }
  if (submissions.some((submission) => submission.status === 'paused' && !submission.providerTurnId && submission.pausedReason === 'recovered_unsent')) {
    return { type: 'paused', reason: 'recovered_unsent' };
  }
  return conversation.providerState === 'paused' ? { type: 'paused', reason: 'recovery_required' } : { type: 'idle' };
}
