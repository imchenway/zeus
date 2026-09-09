import {
  type CommandDeliveryRepository,
  type ConversationExecutionRepository,
  type ConversationRepository,
  type ConversationServerRequestRepository,
  type ConversationSubmissionRepository,
  type ConversationTurnRepository,
  type ZeusConversationSubmissionRecord,
  type ZeusConversationWithMessagesRecord,
  type ZeusDatabase,
} from '@zeus/storage';

/** 本地归档同时核对业务记录与真实写出账本。 */
interface UnboundConversationArchivePorts {
  db: ZeusDatabase;
  conversations: ConversationRepository;
  turns: ConversationTurnRepository;
  submissions: ConversationSubmissionRepository;
  requests: ConversationServerRequestRepository;
  execution: ConversationExecutionRepository;
  /** 真实 Provider 子命令证据，避免把丢失身份当作从未发送。 */
  commandDeliveries: CommandDeliveryRepository;

  broadcast(type: string, payload: Record<string, unknown>): void;

  now?: () => string;
}

/** 归档与续发共用完整外发证据，不能把缺少 Provider 身份当作从未发送。 */
export function hasUnwrittenConversationEvidence(ports: UnboundConversationArchivePorts, conversation: ZeusConversationWithMessagesRecord): boolean {
  if (conversation.providerThreadId || conversation.nativeSessionId || conversation.providerThreadPath || conversation.nativeSessionPath || !['unbound', 'failed', 'paused'].includes(conversation.providerState)) return false;
  if (ports.requests.listByConversation(conversation.id).length > 0) return false;
  if (ports.turns.listByConversation(conversation.id).some((turn) => turn.providerThreadId || turn.providerTurnId || turn.status === 'dispatching' || turn.status === 'running' || turn.status === 'waiting')) return false;
  if (ports.execution.listSegments(conversation.id).some((segment) => segment.nativeSessionId)) return false;
  if (ports.commandDeliveries.providerWriteStatus(conversation.id) === 'written_or_unknown') return false;
  return ports.submissions.listByConversation(conversation.id).every((submission) => hasUnwrittenSubmissionEvidence(ports.commandDeliveries, submission));
}

/** 归档和各模型的队列恢复共用写前证据，派发时间不能单独证明是否已发送。 */
export function hasUnwrittenSubmissionEvidence(deliveries: CommandDeliveryRepository, submission: ZeusConversationSubmissionRecord): boolean {
  if (submission.providerTurnId || submission.targetProviderTurnId || submission.acceptedAt || submission.submissionOutcome === 'outcome_unknown' || submission.pausedReason === 'outcome_unknown') return false;
  /** 派发租约也会写 dispatchedAt，必须用对应提交的真实命令回执区分发送前失败。 */
  const writeStatus = deliveries.providerWriteStatus(submission.id);
  if (writeStatus === 'written_or_unknown' || (submission.dispatchedAt && writeStatus !== 'unwritten')) return false;
  return ['queued', 'paused', 'failed', 'cancelled', 'deleted'].includes(submission.status);
}

/** 只收口从未建立 Provider 身份的本地队列；任何已外发迹象都交回常规 Provider 归档链路。 */
export async function archiveUnboundConversationLocally(ports: UnboundConversationArchivePorts, conversation: ZeusConversationWithMessagesRecord, onArchived: () => void): Promise<boolean> {
  if (!hasUnwrittenConversationEvidence(ports, conversation)) return false;

  /** 本次归档与确定未发送内容的收口使用同一时间。 */
  const archivedAt = ports.now?.() ?? new Date().toISOString();
  /** 检查与本地写入之间不让出执行权，避免新派发穿过归档边界。 */
  const submissions = ports.submissions.listByConversation(conversation.id);
  ports.db.transaction(() => {
    for (const submission of submissions) {
      if ((submission.status !== 'queued' && submission.status !== 'paused' && submission.status !== 'failed') || submission.providerTurnId) continue;
      ports.execution.cancelOpenSwitchForSubmission({
        conversationId: conversation.id,
        submissionId: submission.id,
        reason: 'submission_cancelled',
        occurredAt: archivedAt,
      });
      ports.submissions.updateStatus(submission.id, 'cancelled', { resolvedAt: archivedAt, updatedAt: archivedAt, preserveError: true });
    }
    ports.conversations.archive(conversation.id);
  });
  onArchived();
  await ports.db.save();
  ports.broadcast('conversation.thread.archived', {
    conversationId: conversation.id,
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    providerState: conversation.providerState,
  });
  return true;
}

/** 未绑定会话没有 Provider 或 worktree 恢复动作；只恢复本地归档标记，避免伪造外部写入。 */
export async function restoreUnboundConversationLocally(ports: UnboundConversationArchivePorts, conversation: ZeusConversationWithMessagesRecord, onRestored: () => void): Promise<boolean> {
  if (!conversation.archived || !hasUnwrittenConversationEvidence(ports, conversation)) return false;
  ports.conversations.restore(conversation.id);
  onRestored();
  await ports.db.save();
  ports.broadcast('conversation.thread.unarchived', {
    conversationId: conversation.id,
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    providerState: conversation.providerState,
  });
  return true;
}
