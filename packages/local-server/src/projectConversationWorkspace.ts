import { assertValidGitBranchName, buildTaskEnvironmentRootPath, getGitRepositoryContext, prepareTaskWorktree } from '@zeus/git-core';
import { defaultTaskBranchPrefix, isConversationWorktreeOptions } from '@zeus/shared';
import type { ZeusProjectRecord } from '@zeus/storage';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/** 路径绑定持久会话身份；自定义分支名不能用于接管其他会话的工作树。 */
export async function prepareProjectConversationWorkspace(project: ZeusProjectRecord, conversationId: string | undefined, mode: unknown, options?: unknown, taskBranchPrefix = defaultTaskBranchPrefix): Promise<string> {
  if (mode === undefined || mode === 'direct') return project.localPath;
  if (mode !== 'worktree') throw workspaceError('工作位置必须是项目目录或新建工作树。');
  if (!conversationId) throw workspaceError('创建工作树前必须保留会话身份。');
  if (options !== undefined && !isConversationWorktreeOptions(options)) throw workspaceError('请选择来源分支并填写工作树分支名。');
  const context = await getGitRepositoryContext(project.localPath);
  if (!context.isRepository || resolve(context.topLevel) !== resolve(project.localPath)) {
    throw workspaceError('新建工作树需要项目根目录是 Git 仓库。', 'ZEUS_GIT_REPOSITORY_REQUIRED');
  }
  const identity = createHash('sha256').update(conversationId).digest('hex').slice(0, 20);
  // 兼容升级前已保留的首发请求；新界面始终提交完整配置。
  const selection = isConversationWorktreeOptions(options) ? options : { sourceKind: 'local' as const, sourceRef: context.branch, branchName: `${taskBranchPrefix}/conversation-${identity}` };
  const sourceRef = selection.sourceRef.trim();
  const worktreePath = buildTaskEnvironmentRootPath(project.localPath, project.slug, 'conversation', identity.slice(-16));
  const registered = context.worktrees.find((entry) => resolve(entry.path) === resolve(worktreePath));
  /** 已登记会话允许恢复旧前缀；新建和接管仍严格使用当前设置。 */
  const requestedBranchName = selection.branchName.trim();
  const branchExists = context.localBranches.includes(requestedBranchName);
  const existingBranch = Boolean(branchExists && registered?.branch === requestedBranchName);
  const branchName = await assertValidGitBranchName(context.topLevel, requestedBranchName, existingBranch ? null : taskBranchPrefix);
  if (registered && registered.branch !== branchName) throw workspaceError('此会话已创建了不同分支的工作树，请沿用原配置重试。');
  if (branchExists && registered?.branch !== branchName) throw workspaceError('该分支已存在，请为新工作树设置其他分支名。', 'ZEUS_TASK_BRANCH_ALREADY_EXISTS');
  if (context.worktrees.some((entry) => entry.branch === branchName && resolve(entry.path) !== resolve(worktreePath))) throw workspaceError('该分支已在其他工作目录使用。', 'ZEUS_TASK_BRANCH_ALREADY_EXISTS');
  /** git init 后的当前分支在首次提交前没有 refs/heads 引用，但仍能作为工作树来源。 */
  const sourceUnborn = selection.sourceKind === 'local' && !context.detached && !context.headSha && sourceRef === context.branch;
  if (!existingBranch && !(selection.sourceKind === 'local' ? context.localBranches.includes(sourceRef) || sourceUnborn : context.remoteBranches.includes(sourceRef))) throw workspaceError('来源分支已不可用，请刷新分支并重新选择。');
  const existingContext = existingBranch ? await getGitRepositoryContext(worktreePath) : null;
  const prepared = await prepareTaskWorktree({
    repositoryPath: project.localPath,
    repositoryContext: context,
    projectSlug: project.slug,
    taskCode: 'conversation',
    taskTitle: '会话',
    workspaceId: identity,
    worktreePath,
    branchName,
    branchPrefix: existingBranch ? null : taskBranchPrefix,
    sourceRef: existingContext?.headSha ?? sourceRef,
    ...(!existingBranch ? { sourceKind: selection.sourceKind } : {}),
    sourceBranch: selection.sourceKind === 'remote' ? sourceRef.slice(sourceRef.indexOf('/') + 1) : sourceRef,
    existingBranch,
    includeLocalChanges: sourceUnborn,
  });
  return prepared.worktreePath;
}

function workspaceError(message: string, code = 'ZEUS_INVALID_CONVERSATION_START'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
