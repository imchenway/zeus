import {
    type ConversationExecutionRepository,
    type ConversationRepository,
    type ConversationServerRequestRepository,
    type ConversationSubmissionRepository,
    type ConversationTurnRepository,
    type ZeusConversationWithMessagesRecord,
    type ZeusDatabase,
} from '@zeus/storage';

interface UnboundConversationArchivePorts {
    db: ZeusDatabase;
    conversations: ConversationRepository;
    turns: ConversationTurnRepository;
    submissions: ConversationSubmissionRepository;
    requests: ConversationServerRequestRepository;
    execution: ConversationExecutionRepository;

    broadcast(type: string, payload: Record<string, unknown>): void;

    now?: () => string;
}

/** 只收口从未建立 Provider 身份的本地队列；任何已外发迹象都交回常规 Provider 归档链路。 */
export async function archiveUnboundConversationLocally(ports: UnboundConversationArchivePorts, conversation: ZeusConversationWithMessagesRecord, onArchived: () => void): Promise<boolean> {
    if (conversation.providerThreadId || conversation.providerState !== 'unbound') return false;
    if (ports.requests.listByConversation(conversation.id).some((request) => request.status === 'pending')) return false;
    if (ports.turns.listByConversation(conversation.id).some((turn) => turn.status === 'dispatching' || turn.status === 'running' || turn.status === 'waiting')) return false;
    const submissions = ports.submissions.listByConversation(conversation.id);
    const locallyCancellable = submissions.every((submission) => {
        if (submission.status === 'completed' || submission.status === 'resolved' || submission.status === 'cancelled' || submission.status === 'deleted') return true;
        return !submission.providerTurnId && (submission.status === 'queued' || submission.status === 'paused' || submission.status === 'failed');
    });
    if (!locallyCancellable) return false;

    const archivedAt = ports.now?.() ?? new Date().toISOString();
    ports.db.transaction(() => {
        for (const submission of submissions) {
            if ((submission.status !== 'queued' && submission.status !== 'paused' && submission.status !== 'failed') || submission.providerTurnId) continue;
            ports.execution.cancelOpenSwitchForSubmission({
                conversationId: conversation.id,
                submissionId: submission.id,
                reason: 'submission_cancelled',
                occurredAt: archivedAt
            });
            ports.submissions.updateStatus(submission.id, 'cancelled', {resolvedAt: archivedAt, updatedAt: archivedAt});
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
    if (!conversation.archived || conversation.providerThreadId || conversation.providerState !== 'unbound') return false;
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
