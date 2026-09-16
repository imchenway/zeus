import { assertValidGitBranchName, buildTaskEnvironmentRootPath, getGitRepositoryContext, prepareTaskWorktree } from '@zeus/git-core';
import { isConversationWorktreeOptions } from '@zeus/shared';
import type { ZeusProjectRecord } from '@zeus/storage';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/** 路径绑定持久会话身份；自定义分支名不能用于接管其他会话的工作树。 */
export async function prepareProjectConversationWorkspace(project: ZeusProjectRecord, conversationId: string | undefined, mode: unknown, options?: unknown): Promise<string> {
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
  const selection = isConversationWorktreeOptions(options) ? options : { sourceKind: 'local' as const, sourceRef: context.branch, branchName: `zeus/conversation-${identity}` };
  const sourceRef = selection.sourceRef.trim();
  const branchName = await assertValidGitBranchName(context.topLevel, selection.branchName);
  const worktreePath = buildTaskEnvironmentRootPath(project.localPath, project.slug, 'conversation', identity.slice(-16));
  const registered = context.worktrees.find((entry) => resolve(entry.path) === resolve(worktreePath));
  const branchExists = context.localBranches.includes(branchName);
  if (registered && registered.branch !== branchName) throw workspaceError('此会话已创建了不同分支的工作树，请沿用原配置重试。');
  if (branchExists && registered?.branch !== branchName) throw workspaceError('该分支已存在，请为新工作树设置其他分支名。', 'ZEUS_TASK_BRANCH_ALREADY_EXISTS');
  if (context.worktrees.some((entry) => entry.branch === branchName && resolve(entry.path) !== resolve(worktreePath))) throw workspaceError('该分支已在其他工作目录使用。', 'ZEUS_TASK_BRANCH_ALREADY_EXISTS');
  const existingBranch = Boolean(branchExists && registered);
  if (!existingBranch && !(selection.sourceKind === 'local' ? context.localBranches : context.remoteBranches).includes(sourceRef)) throw workspaceError('来源分支已不可用，请刷新分支并重新选择。');
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
    sourceRef: existingContext?.headSha ?? sourceRef,
    ...(!existingBranch ? { sourceKind: selection.sourceKind } : {}),
    sourceBranch: selection.sourceKind === 'remote' ? sourceRef.slice(sourceRef.indexOf('/') + 1) : sourceRef,
    existingBranch,
    includeLocalChanges: false,
  });
  return prepared.worktreePath;
}

function workspaceError(message: string, code = 'ZEUS_INVALID_CONVERSATION_START'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
