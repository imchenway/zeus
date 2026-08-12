export function buildTaskConflictAiConversationTitle(input: { sourceBranch: string; taskBranch: string }): string {
  return `冲突处理：${input.taskBranch} 合入来源分支 ${input.sourceBranch}`.slice(0, 80);
}

export function matchesTaskConflictAiConversationTitle(input: { title: string; sourceBranch: string; taskBranch: string }): boolean {
  const legacyTitles = [`冲突处理：本地合入 ${input.taskBranch} → ${input.sourceBranch}`, `本地合入：${input.taskBranch} → ${input.sourceBranch}`].map((title) => title.slice(0, 80));
  return input.title === buildTaskConflictAiConversationTitle(input) || legacyTitles.includes(input.title);
}

export function buildTaskConflictAiPrompt(input: { sourceBranch: string; taskBranch: string; mode: 'merge' | 'squash'; commitMessage: string }): string {
  return [
    `请完成这次代码交付：将当前任务分支 ${input.taskBranch} 本地合入它的来源分支 ${input.sourceBranch}。不要把任务理解为只修改当前冲突文件。`,
    `合入方式：${input.mode === 'squash' ? 'squash' : 'merge'}。`,
    `当前目录是 Zeus 基于来源分支 ${input.sourceBranch} 冻结提交创建的 detached 隔离合并工作区，Git 已经执行合入 ${input.taskBranch} 并停在冲突状态。请处理仓库内全部冲突，不要只处理打开会话时选中的文件。`,
    '请直接读取仓库真实上下文、修改冲突文件，并用 git add 暂存每个已解决文件。必须保留两个分支中互不冲突的有效修改，并依据真实代码做业务判断；不要只给建议、补丁说明或 JSON。',
    `全部冲突解决并暂存后，请在当前隔离工作区生成合入候选提交：${input.mode === 'merge' ? '保留现有 MERGE_HEAD 并执行 git commit --no-edit' : `执行 git commit -m ${JSON.stringify(input.commitMessage)}`}。不要停留在只有工作区修改或暂存区修改、但没有提交的状态。`,
    `不要 checkout、reset、rebase 或直接更新来源分支 ${input.sourceBranch}，也绝对不要执行 git push。你生成候选提交后，Zeus 会复验任务分支和来源分支 HEAD，再把该提交安全同步到本地来源分支 ${input.sourceBranch}；是否推送由用户之后单独决定。`,
    '结束前请确认 git diff --name-only --diff-filter=U 没有输出，并报告候选提交 SHA。如果无法安全解决，保留未解决现场并在会话中说明真实原因，不要猜测、提交残留冲突的结果或伪装成功。',
  ].join('\n\n');
}
