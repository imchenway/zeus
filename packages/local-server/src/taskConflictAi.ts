/** 生成稳定、简短的冲突处理会话标题。 */
export function buildTaskConflictAiConversationTitle(input: { taskTitle: string }): string {
  return `冲突处理：${input.taskTitle.trim()}`.slice(0, 80);
}

/** 同时识别当前标题和历史冲突会话标题。 */
export function matchesTaskConflictAiConversationTitle(input: { title: string; taskTitle?: string | null; sourceBranch: string; taskBranch: string }): boolean {
  /** 历史标题仍用于恢复已经存在的冲突会话。 */
  const legacyTitles = [`冲突处理：${input.taskBranch} 合入来源分支 ${input.sourceBranch}`, `冲突处理：本地合入 ${input.taskBranch} → ${input.sourceBranch}`, `本地合入：${input.taskBranch} → ${input.sourceBranch}`].map((title) =>
    title.slice(0, 80),
  );
  /** 新标题只依赖用户可见任务名称。 */
  const taskTitle = input.taskTitle?.trim();
  return (taskTitle ? input.title === buildTaskConflictAiConversationTitle({ taskTitle }) : false) || legacyTitles.includes(input.title);
}

/** 按真实冲突来源生成 AI 处理边界，避免颠倒 Git 两侧内容或误提交来源草稿。 */
export function buildTaskConflictAiPrompt(input: { sourceBranch: string; taskBranch: string; conflictBranch: string; mode: 'merge' | 'squash'; commitMessage: string; sourceLocalChanges?: boolean }): string {
  /** 来源草稿冲突与普通分支冲突的 Git 两侧含义不同。 */
  const conflictContext = input.sourceLocalChanges
    ? `当前目录是持久命名分支 ${input.conflictBranch} 的独立 Worktree。任务分支 ${input.taskBranch} 的已提交成果已经合入候选，Git 正在把来源分支 ${input.sourceBranch} 所在工作区的未提交草稿叠加到候选上并停在冲突状态。此时 Git 第 2 阶段（ours）是任务已提交成果，第 3 阶段（theirs）是来源工作区草稿；请勿颠倒。`
    : `当前目录是持久命名分支 ${input.conflictBranch} 的独立 Worktree。该分支从来源分支 ${input.sourceBranch} 创建，Git 已经执行合入 ${input.taskBranch} 并停在冲突状态。请处理仓库内全部冲突，不要只处理打开会话时选中的文件。`;
  /** 来源草稿只决定最终工作区内容，普通冲突则形成正式合入提交。 */
  const completionBoundary = input.sourceLocalChanges
    ? '全部冲突解决后只需暂存所有已解决文件，保留当前 MERGE_HEAD，不要自行创建提交。最终只会推进任务合入提交，来源工作区草稿仍保持未提交；用户会在本会话通过“代码交付”完成安全落地。'
    : '全部冲突解决后只需暂存所有已解决文件，保留当前 MERGE_HEAD，不要自行创建提交。用户会在本会话通过“代码交付”统一提交并合入来源分支。';
  return [
    `请完成这次代码交付：将当前任务分支 ${input.taskBranch} 本地合入它的来源分支 ${input.sourceBranch}。不要把任务理解为只修改当前冲突文件。`,
    `合入方式：${input.mode === 'squash' ? 'squash' : 'merge'}。`,
    conflictContext,
    '请直接读取仓库真实上下文、修改冲突文件，并用 git add 暂存每个已解决文件。必须保留两个分支中互不冲突的有效修改，并依据真实代码做业务判断；不要只给建议、补丁说明或 JSON。',
    completionBoundary,
    `不要 checkout、reset、rebase、切换分支、直接更新来源分支 ${input.sourceBranch}，也绝对不要执行 git push。当前命名分支和 Worktree 会继续保留，供本会话后续对话与再次交付。`,
    '结束前请确认 git diff --name-only --diff-filter=U 没有输出。如果无法安全解决，保留未解决现场并在会话中说明真实原因，不要猜测、提交残留冲突的结果或伪装成功。',
  ].join('\n\n');
}
