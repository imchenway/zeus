export function buildTaskConflictAiConversationTitle(input: { taskTitle: string }): string {
  return `冲突处理：${input.taskTitle.trim()}`.slice(0, 80);
}

export function matchesTaskConflictAiConversationTitle(input: { title: string; taskTitle?: string | null; sourceBranch: string; taskBranch: string }): boolean {
  const legacyTitles = [`冲突处理：${input.taskBranch} 合入来源分支 ${input.sourceBranch}`, `冲突处理：本地合入 ${input.taskBranch} → ${input.sourceBranch}`, `本地合入：${input.taskBranch} → ${input.sourceBranch}`].map((title) =>
    title.slice(0, 80),
  );
  const taskTitle = input.taskTitle?.trim();
  return (taskTitle ? input.title === buildTaskConflictAiConversationTitle({ taskTitle }) : false) || legacyTitles.includes(input.title);
}

export function buildTaskConflictAiPrompt(input: { sourceBranch: string; taskBranch: string; conflictBranch: string; mode: 'merge' | 'squash'; commitMessage: string }): string {
  return [
    `请完成这次代码交付：将当前任务分支 ${input.taskBranch} 本地合入它的来源分支 ${input.sourceBranch}。不要把任务理解为只修改当前冲突文件。`,
    `合入方式：${input.mode === 'squash' ? 'squash' : 'merge'}。`,
    `当前目录是持久命名分支 ${input.conflictBranch} 的独立 Worktree。该分支从来源分支 ${input.sourceBranch} 创建，Git 已经执行合入 ${input.taskBranch} 并停在冲突状态。请处理仓库内全部冲突，不要只处理打开会话时选中的文件。`,
    '请直接读取仓库真实上下文、修改冲突文件，并用 git add 暂存每个已解决文件。必须保留两个分支中互不冲突的有效修改，并依据真实代码做业务判断；不要只给建议、补丁说明或 JSON。',
    '全部冲突解决后只需暂存所有已解决文件，保留当前 MERGE_HEAD，不要自行创建提交。用户会在本会话通过“代码交付”统一提交并合入来源分支。',
    `不要 checkout、reset、rebase、切换分支、直接更新来源分支 ${input.sourceBranch}，也绝对不要执行 git push。当前命名分支和 Worktree 会继续保留，供本会话后续对话与再次交付。`,
    '结束前请确认 git diff --name-only --diff-filter=U 没有输出。如果无法安全解决，保留未解决现场并在会话中说明真实原因，不要猜测、提交残留冲突的结果或伪装成功。',
  ].join('\n\n');
}
