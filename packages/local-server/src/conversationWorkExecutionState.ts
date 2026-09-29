import { isProviderBlockingTurnFailure, type ZeusConversationRecord, type ZeusConversationSubmissionRecord } from '@zeus/storage';

/** 工作编排可消费的会话终态；blocked 表示外部服务暂不可继续，不等同于任务执行失败。 */
export type ConversationWorkExecutionState =
  | { type: 'running' }
  | { type: 'waiting' }
  | { type: 'completed' }
  | { type: 'blocked'; code: string; message: string }
  | { type: 'failed'; code: string; message: string }
  | { type: 'outcome_unknown'; code: string; message: string };

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
    return { type: isProviderBlockingTurnFailure(parseSubmissionErrorValue(current.errorJson)) ? 'blocked' : 'failed', ...error };
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

/** 按耐久更新时间选择当前有效提交。 */
function latest(submissions: readonly ZeusConversationSubmissionRecord[]): ZeusConversationSubmissionRecord | undefined {
  return [...submissions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
}

/** 解析提交错误的稳定码和可读说明，格式异常时使用调用方兜底。 */
function parseSubmissionError(
  errorJson: string | null,
  fallbackCode: string,
  fallbackMessage: string,
): {
  code: string;
  message: string;
} {
  const parsed = parseSubmissionErrorValue(errorJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { code: fallbackCode, message: fallbackMessage };
  const record = parsed as Record<string, unknown>;
  return {
    code: typeof record.code === 'string' && record.code.trim() ? record.code : fallbackCode,
    message: typeof record.message === 'string' && record.message.trim() ? record.message : fallbackMessage,
  };
}

/** 保留原始结构化错误供 Provider 阻塞判断使用，解析失败时返回空值。 */
function parseSubmissionErrorValue(errorJson: string | null): unknown {
  if (!errorJson) return null;
  try {
    return JSON.parse(errorJson) as unknown;
  } catch {
    return null;
  }
}
