/** 新建会话工作树的来源和目标分支；项目目录模式不消费此配置。 */
export interface ConversationWorktreeOptions {
  sourceKind: 'local' | 'remote';
  sourceRef: string;
  branchName: string;
}

export function isConversationWorktreeOptions(value: unknown): value is ConversationWorktreeOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (entry.sourceKind === 'local' || entry.sourceKind === 'remote') && typeof entry.sourceRef === 'string' && Boolean(entry.sourceRef.trim()) && typeof entry.branchName === 'string' && Boolean(entry.branchName.trim());
}
