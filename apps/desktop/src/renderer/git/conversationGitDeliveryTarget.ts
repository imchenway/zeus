import type { NativeConversationChoice } from '../session/sessionTypes.js';

/** 会话按钮与快捷键共用原生交付窗口的范围类型。 */
type ConversationGitDeliveryTarget = Parameters<NonNullable<Window['zeus']>['openTaskGitDeliveryWindow']>[0];

/** 当前目录保留会话身份与项目仓库范围，任务工作树继续使用任务定位。 */
export function conversationGitDeliveryTarget(
  conversation: Pick<NativeConversationChoice, 'id' | 'projectId' | 'taskId' | 'workspaceMode' | 'workspaceId' | 'deliverySourceConversationId'>,
  workspaceId = conversation.workspaceId,
): ConversationGitDeliveryTarget {
  if (conversation.deliverySourceConversationId) return { projectId: conversation.projectId, conversationId: conversation.deliverySourceConversationId };
  // 同步创建任务的会话仍拥有自己的工作树，不冒充任务工作区。
  if (conversation.workspaceMode === 'worktree' && !workspaceId) return { projectId: conversation.projectId, conversationId: conversation.id };
  if (conversation.taskId && conversation.workspaceMode !== 'direct') return { taskId: conversation.taskId, workspaceId };
  return { projectId: conversation.projectId, conversationId: conversation.id };
}
