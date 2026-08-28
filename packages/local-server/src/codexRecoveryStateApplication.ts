import type { ConversationExecutionRepository, ConversationRepository, ConversationSubmissionRepository, ConversationTurnRepository, ZeusConversationSubmissionRecord } from '@zeus/storage';
import type { NativeConversationRunState } from './codexNativeConversationContracts.js';
import { serializeError, toRecoverySubmissionError } from './codexNativeConversationPolicy.js';
import { interruptUnconfirmedConversationTurns } from './codexRecoveryTurnState.js';

interface CodexRecoveryStateApplicationOptions {
  conversations: ConversationRepository;
  submissions: ConversationSubmissionRepository;
  turns: ConversationTurnRepository;
  execution: ConversationExecutionRepository;
  runStates: Map<string, NativeConversationRunState>;
  broadcast: (type: string, payload: Record<string, unknown>) => void;
  now: () => string;
}

/**
 * 会话恢复失败的一致状态转换边界：提交、回合、Provider 和内存运行态必须同步收口，
 * 不能由协调器的多个调用点分别拼接。
 */
export function createCodexRecoveryStateApplication(options: CodexRecoveryStateApplicationOptions) {
  function markSubmissionRecoveryRequired(submission: ZeusConversationSubmissionRecord, error: unknown): void {
    options.submissions.updateStatus(submission.id, 'paused', {
      pausedReason: 'recovery_required',
      error: toRecoverySubmissionError(error),
    });
    options.runStates.set(submission.conversationId, { type: 'paused', reason: 'recovery_required' });
  }

  function markConversationRecoveryRequired(conversationId: string, error: unknown): boolean {
    const submissions = options.submissions.listByConversation(conversationId);
    const acceptedInFlight = submissions.find((submission) => submission.status === 'active' && Boolean(submission.providerTurnId));
    if (acceptedInFlight) {
      // 精确 Provider turn 已接纳时，辅助恢复读取失败不得覆盖实时写入事实。
      options.execution.persistWarning({
        conversationId,
        warningKind: 'provider_reconciliation_deferred',
        payload: {
          submissionId: acceptedInFlight.id,
          providerTurnId: acceptedInFlight.providerTurnId,
          error: serializeError(error),
        },
        occurredAt: options.now(),
      });
      return false;
    }
    for (const submission of submissions) {
      if (submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active') markSubmissionRecoveryRequired(submission, error);
    }
    interruptUnconfirmedConversationTurns({
      conversationId,
      cause: serializeError(error),
      interruptedAt: options.now(),
      turns: options.turns,
    });
    const conversation = options.conversations.getById(conversationId);
    if (conversation?.providerThreadId && conversation.providerState !== 'archived' && conversation.providerState !== 'closed' && conversation.providerState !== 'failed') {
      options.conversations.bindProvider(conversation.id, {
        providerId: 'codex',
        providerThreadId: conversation.providerThreadId,
        providerModel: conversation.providerModel,
        providerState: 'paused',
      });
    }
    options.runStates.set(conversationId, { type: 'paused', reason: 'recovery_required' });
    return true;
  }

  function markConversationProviderArchived(conversationId: string, error: unknown): void {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation?.providerThreadId) return;
    const archivedError = {
      code: 'ZEUS_CODEX_THREAD_ARCHIVED',
      message: 'The Codex provider thread is archived.',
      cause: serializeError(error),
    };
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (submission.status !== 'queued' && submission.status !== 'dispatching' && submission.status !== 'active') continue;
      options.submissions.updateStatus(submission.id, 'paused', {
        pausedReason: 'provider_archived',
        error: archivedError,
      });
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId: conversation.providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'archived',
    });
    options.runStates.set(conversationId, { type: 'paused', reason: 'provider_archived' });
    options.broadcast('conversation.thread.changed', {
      conversationId,
      providerThreadId: conversation.providerThreadId,
      providerState: 'archived',
    });
    options.broadcast('conversation.queue.changed', { conversationId });
  }

  return {
    markConversationProviderArchived,
    markConversationRecoveryRequired,
    markSubmissionRecoveryRequired,
  };
}
