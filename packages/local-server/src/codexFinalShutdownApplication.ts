import type { ConversationRepository, ConversationServerRequestRepository, ConversationSubmissionRepository, ConversationTurnRepository, ZeusDatabase } from '@zeus/storage';

export interface CodexFinalShutdownTerminalizationResult {
  requestIds: string[];
  turnIds: string[];
  submissionIds: string[];
  conversationIds: string[];
  pausedConversationIds: string[];
}

interface CodexFinalShutdownApplicationOptions {
  db: ZeusDatabase;
  conversations: ConversationRepository;
  turns: ConversationTurnRepository;
  submissions: ConversationSubmissionRepository;
  requests: ConversationServerRequestRepository;
}

/**
 * 最终退出不再等待已关闭的 Provider 事件链，而是在一个同步耐久事务内收口交互投影。
 * Provider 的真实 turn 终态仍未确认，因此本地使用 failed + recovery_required，禁止伪装成正常中断或自动重发。
 */
export function finalizeCodexPendingInteractionsForShutdown(
  options: CodexFinalShutdownApplicationOptions,
  input: { requestIds: readonly string[]; occurredAt: string; providerActionEvidence?: ReadonlyMap<string, Record<string, unknown>> },
): CodexFinalShutdownTerminalizationResult {
  return options.db.durableTransactionSync(() => {
    const requestIds = new Set<string>();
    const turnIds = new Set<string>();
    const submissionIds = new Set<string>();
    const conversationIds = new Set<string>();
    const pausedConversationIds = new Set<string>();

    for (const requestId of new Set(input.requestIds)) {
      const request = options.requests.getById(requestId);
      // Provider 事件链已 drain；仍保留条件更新，避免未来调用方把已解决请求重新终态化。
      if (!request || request.status !== 'pending') continue;
      const shutdownError = {
        code: 'ZEUS_CODEX_FINAL_QUIT_OUTCOME_UNCONFIRMED',
        error: 'ZEUS_CODEX_FINAL_QUIT_OUTCOME_UNCONFIRMED',
        message: 'Zeus 最终退出时终止了待处理 Codex 交互；Provider turn 的真实终态尚未确认。',
        providerOutcomeUnconfirmed: true,
        recoveryRequired: true,
        terminalization: 'final_quit',
        ...(input.providerActionEvidence?.get(request.id) ? { providerAction: input.providerActionEvidence.get(request.id) } : {}),
      };

      options.requests.fail(request.id, { error: shutdownError, resolvedAt: input.occurredAt });
      requestIds.add(request.id);
      conversationIds.add(request.conversationId);

      const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
      if (turn && (turn.status === 'dispatching' || turn.status === 'running' || turn.status === 'waiting')) {
        options.turns.upsert({
          ...turn,
          status: 'failed',
          error: shutdownError,
          completedAt: input.occurredAt,
          updatedAt: input.occurredAt,
        });
        turnIds.add(turn.id);
      }

      for (const submission of options.submissions.listByConversation(request.conversationId)) {
        if (submission.status !== 'dispatching' && submission.status !== 'active') continue;
        const belongsToTurn = !turn || submission.id === turn.clientSubmissionId || (Boolean(turn.providerTurnId) && submission.providerTurnId === turn.providerTurnId);
        if (!belongsToTurn) continue;
        options.submissions.updateStatus(submission.id, 'paused', {
          providerTurnId: submission.providerTurnId ?? turn?.providerTurnId ?? null,
          pausedReason: 'recovery_required',
          error: shutdownError,
          updatedAt: input.occurredAt,
        });
        submissionIds.add(submission.id);
      }
    }

    for (const conversationId of conversationIds) {
      const conversation = options.conversations.getById(conversationId);
      if (!conversation?.providerThreadId || conversation.providerState === 'archived' || conversation.providerState === 'closed' || conversation.providerState === 'failed') {
        continue;
      }
      options.conversations.bindProvider(conversation.id, {
        providerId: 'codex',
        providerThreadId: conversation.providerThreadId,
        providerModel: conversation.providerModel,
        providerState: 'paused',
      });
      pausedConversationIds.add(conversation.id);
    }

    return {
      requestIds: [...requestIds],
      turnIds: [...turnIds],
      submissionIds: [...submissionIds],
      conversationIds: [...conversationIds],
      pausedConversationIds: [...pausedConversationIds],
    };
  });
}
