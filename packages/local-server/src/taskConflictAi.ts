export function buildTaskConflictAiPrompt(input: { path: string; targetBranch: string; taskBranch: string; mode: 'merge' | 'squash'; conflictFiles: string[] }): string {
  return [
    `请将任务分支 ${input.taskBranch} 的代码本地合入 ${input.targetBranch}，并处理当前全部 Git 冲突。`,
    `合入方式：${input.mode === 'squash' ? 'squash' : 'merge'}。`,
    '当前目录是 Zeus 已经准备好的隔离合并工作区，Git 已停在冲突状态。请直接读取仓库上下文、修改冲突文件，并用 git add 暂存每个已解决文件。',
    '不要只给出建议或 JSON；需要真正修改当前工作区。必须保留两个分支中互不冲突的有效修改，并依据仓库真实代码做业务判断。',
    '你可以运行必要的非破坏性检查，但不要执行 git commit，不要直接更新目标分支，也绝对不要执行 git push。当你解决并暂存全部冲突后，Zeus 会复验分支 HEAD、生成本地合并提交并安全同步到目标分支。是否推送目标分支由用户之后单独决定。',
    '结束前请确认 git diff --name-only --diff-filter=U 没有输出；如果无法安全解决，保留未解决现场并在会话中说明真实原因，不要猜测或伪装成功。',
    `当前界面文件：${input.path}`,
    `待处理冲突文件：${input.conflictFiles.join('、')}`,
  ].join('\n\n');
}
