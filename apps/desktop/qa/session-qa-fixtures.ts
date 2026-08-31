import type {NativeConversationChoice} from '../src/renderer/session/sessionTypes.js';

export function conversation(id: string, taskId: string, updatedAt: string, hasUnreadAttention = false): NativeConversationChoice {
    return {
        id,
        projectId: 'project-zeus',
        taskId,
        title: id,
        summary: null,
        status: 'active',
        stage: 'ready',
        stageUpdatedAt: updatedAt,
        transportKind: 'codex_native',
        providerId: 'codex',
        providerThreadId: `thread-${id}`,
        providerModel: 'gpt-5.6-sol',
        providerState: 'ready',
        createdAt: updatedAt,
        updatedAt,
        archived: false,
        hasUnreadAttention,
        attentionKind: hasUnreadAttention ? 'unread' : 'none',
        attentionRevision: hasUnreadAttention ? 1 : 0,
        attentionTurnId: null,
        attentionUpdatedAt: hasUnreadAttention ? updatedAt : null,
        pendingRequestKind: null,
        resumable: true,
        readOnly: false,
    };
}

export const taskPushAttachmentKey = 'task-current:defectCurrentState:screenshot';
