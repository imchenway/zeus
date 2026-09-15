/** 兼容已保存的冲突会话名称，显示时使用当前语言。 */
const taskConflictConversationPrefixes = ['冲突处理：', '冲突处理:', '本地合入：', '本地合入:'];

/** 普通任务会话显示任务名称，专用冲突会话额外保留用途标识。 */
export function conversationDisplayTitle(conversationTitle: string, taskTitle?: string | null, language: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  const normalizedTaskTitle = taskTitle?.trim();
  if (normalizedTaskTitle && taskConflictConversationPrefixes.some((prefix) => conversationTitle.startsWith(prefix))) {
    return language === 'zh-CN' ? `冲突处理：${normalizedTaskTitle}` : `Resolve conflicts: ${normalizedTaskTitle}`;
  }
  return normalizedTaskTitle || conversationTitle.trim() || (language === 'zh-CN' ? '未命名会话' : 'Untitled conversation');
}
