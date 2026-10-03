import { getGitRepositoryContext } from '@zeus/git-core';
import type { ConversationRepository, ConversationSubmissionRepository, ZeusProjectRecord } from '@zeus/storage';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

/** Git 目录身份查询使用只读子进程，不执行仓库修改。 */
const execute = promisify(execFile);

/** 普通仓库与工作树通过真实公共 Git 目录核对归属。 */
async function commonGitDirectory(cwd: string): Promise<string> {
  const result = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 15_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return realpath(result.stdout.trim());
}

/** 会话 Git 范围的持久仓库身份前缀。 */
export const conversationGitRepositoryPrefix = 'conversation:';

/** 只认服务端持久化的会话目录；命令 cwd 和客户端路径不能改变 Git 操作范围。 */
export async function resolveConversationGitWorkspace(
  project: ZeusProjectRecord,
  conversationId: string,
  conversations: Pick<ConversationRepository, 'getRecordById'>,
  submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>,
) {
  /** 错误身份保持稳定，文案适用于普通目录和独立工作树。 */
  const unavailable = () => Object.assign(new Error('会话工作目录不存在、已回收或不属于当前项目。'), { code: 'ZEUS_CONVERSATION_WORKTREE_UNAVAILABLE', statusCode: 409 });
  const conversation = conversations.getRecordById(conversationId);
  if (!conversation || conversation.projectId !== project.id || conversation.taskId) throw unavailable();
  const contexts = submissions.listByConversation(conversation.id).map((submission) => {
    try {
      return JSON.parse(submission.inputJson).context as { projectLocalPath?: unknown; executionWorkspaceMode?: unknown } | undefined;
    } catch {
      return undefined;
    }
  });
  /** 沿用最初持久提交的目录，不从最近命令的 cwd 或客户端路径推断操作范围。 */
  const context = contexts.find((item) => typeof item?.projectLocalPath === 'string' && (item.executionWorkspaceMode === 'worktree' || item.executionWorkspaceMode === 'direct' || item.executionWorkspaceMode === undefined));
  if (!context || typeof context.projectLocalPath !== 'string') throw unavailable();
  try {
    const [root, cwd] = await Promise.all([realpath(project.localPath), realpath(context.projectLocalPath)]);
    /** 普通模式只能复用所属项目的真实目录，不能借持久上下文指向其他目录。 */
    if (context.executionWorkspaceMode === 'direct' || (context.executionWorkspaceMode === undefined && cwd === root)) {
      if (cwd !== root) throw unavailable();
      return { id: `${conversationGitRepositoryPrefix}${conversation.id}`, name: conversation.title || '会话工作目录', relativePath: '.', localPath: cwd, workspaceMode: 'direct' as const };
    }
    const [repository, workspace] = await Promise.all([getGitRepositoryContext(root), getGitRepositoryContext(cwd)]);
    if (cwd === root || !repository.isRepository || !workspace.isRepository || (await realpath(workspace.topLevel)) !== cwd) throw unavailable();
    const registeredPaths = await Promise.all(repository.worktrees.filter((entry) => !entry.bare && !entry.prunable).map((entry) => realpath(entry.path).catch(() => null)));
    if (!registeredPaths.includes(cwd)) throw unavailable();
    const [projectGit, workspaceGit] = await Promise.all([commonGitDirectory(root), commonGitDirectory(cwd)]);
    if (projectGit !== workspaceGit) throw unavailable();
    return { id: `${conversationGitRepositoryPrefix}${conversation.id}`, name: conversation.title || '会话工作树', relativePath: '.', localPath: cwd, workspaceMode: 'worktree' as const };
  } catch {
    throw unavailable();
  }
}
