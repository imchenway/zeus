const taskConflictConversationPrefix = '冲突处理：';

/** 普通任务会话沿用任务标题，专用冲突会话保留自身用途标识。 */
export function conversationDisplayTitle(conversationTitle: string, taskTitle?: string | null): string {
  return conversationTitle.startsWith(taskConflictConversationPrefix) ? conversationTitle : (taskTitle ?? conversationTitle);
}
