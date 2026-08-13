const taskConflictConversationPrefixes = ['冲突处理：', '冲突处理:', '本地合入：', '本地合入:'];

/** 普通任务会话显示任务名称，专用冲突会话额外保留用途标识。 */
export function conversationDisplayTitle(conversationTitle: string, taskTitle?: string | null): string {
  const normalizedTaskTitle = taskTitle?.trim();
  if (normalizedTaskTitle && taskConflictConversationPrefixes.some((prefix) => conversationTitle.startsWith(prefix))) {
    return `冲突处理：${normalizedTaskTitle}`;
  }
  return taskTitle ?? conversationTitle;
}
