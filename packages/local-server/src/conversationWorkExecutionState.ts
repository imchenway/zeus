import type { ZeusConversationRecord, ZeusConversationSubmissionRecord } from '@zeus/storage';

export type ConversationWorkExecutionState = { type: 'running' } | { type: 'waiting' } | { type: 'completed' } | { type: 'failed'; code: string; message: string } | { type: 'outcome_unknown'; code: string; message: string };

/** 工作编排只消费会话的耐久提交结果，不再从旧 stage 字段反猜 Provider 是否接纳。 */
export function conversationWorkExecutionState(conversation: ZeusConversationRecord, submissions: readonly ZeusConversationSubmissionRecord[]): ConversationWorkExecutionState {
  // 只判定当前最后一次有效提交；已经被后续人工重试并完成的历史失败不能永久污染工作项。
  const current = latest(submissions.filter((submission) => !['resolved', 'cancelled', 'deleted'].includes(submission.status)));
  if (current?.status === 'paused' && current.pausedReason === 'runtime_rejected') {
    const error = parseSubmissionError(current.errorJson, 'ZEUS_CONVERSATION_RUNTIME_REJECTED', 'Provider 明确拒绝了会话启动。');
    return { type: 'failed', ...error };
  }
  if (current?.status === 'failed' || current?.pausedReason === 'preflight_failed') {
    const error = parseSubmissionError(current.errorJson, 'ZEUS_CONVERSATION_FAILED', '会话执行失败，请查看会话详情。');
    return { type: 'failed', ...error };
  }
  if (
    current &&
    (current.submissionOutcome === 'outcome_unknown' || current.pausedReason === 'outcome_unknown' || current.pausedReason === 'recovery_required' || (current.status === 'paused' && current.pausedReason !== 'user_confirmation'))
  ) {
    const error = parseSubmissionError(current.errorJson, 'ZEUS_CONVERSATION_OUTCOME_UNKNOWN', '会话派发结果未知，需要核对 Provider 现场后再处置。');
    return { type: 'outcome_unknown', ...error };
  }
  if (conversation.stage === 'failed' || conversation.providerState === 'failed') {
    const error = parseSubmissionError(current?.errorJson ?? null, 'ZEUS_CONVERSATION_FAILED', '会话执行失败，请查看会话详情。');
    return { type: 'failed', ...error };
  }
  if (conversation.stage === 'waiting_user' || conversation.stage === 'waiting_approval' || conversation.providerState === 'waiting') return { type: 'waiting' };
  if (conversation.stage === 'completed') return { type: 'completed' };
  return { type: 'running' };
}

function latest(submissions: readonly ZeusConversationSubmissionRecord[]): ZeusConversationSubmissionRecord | undefined {
  return [...submissions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
}

function parseSubmissionError(
  errorJson: string | null,
  fallbackCode: string,
  fallbackMessage: string,
): {
  code: string;
  message: string;
} {
  if (!errorJson) return { code: fallbackCode, message: fallbackMessage };
  try {
    const parsed: unknown = JSON.parse(errorJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {
        code: fallbackCode,
        message: fallbackMessage,
      };
    const record = parsed as Record<string, unknown>;
    return {
      code: typeof record.code === 'string' && record.code.trim() ? record.code : fallbackCode,
      message: typeof record.message === 'string' && record.message.trim() ? record.message : fallbackMessage,
    };
  } catch {
    return { code: fallbackCode, message: fallbackMessage };
  }
}
