import { getGitRepositoryContext } from '@zeus/git-core';
import type { ConversationRepository, ConversationSubmissionRepository, ZeusProjectRecord } from '@zeus/storage';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

const execute = promisify(execFile);

async function commonGitDirectory(cwd: string): Promise<string> {
  const result = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 15_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return realpath(result.stdout.trim());
}

export const conversationGitRepositoryPrefix = 'conversation:';

/** 只认服务端持久化的会话目录；命令 cwd 和客户端路径不能改变 Git 操作范围。 */
export async function resolveConversationGitWorkspace(
  project: ZeusProjectRecord,
  conversationId: string,
  conversations: Pick<ConversationRepository, 'getRecordById'>,
  submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>,
) {
  const unavailable = () => Object.assign(new Error('会话工作树不存在、已回收或不属于当前项目。'), { code: 'ZEUS_CONVERSATION_WORKTREE_UNAVAILABLE', statusCode: 409 });
  const conversation = conversations.getRecordById(conversationId);
  if (!conversation || conversation.projectId !== project.id || conversation.taskId) throw unavailable();
  const contexts = submissions.listByConversation(conversation.id).map((submission) => {
    try {
      return JSON.parse(submission.inputJson).context as { projectLocalPath?: unknown; executionWorkspaceMode?: unknown } | undefined;
    } catch {
      return undefined;
    }
  });
  const context = contexts.find((item) => item?.executionWorkspaceMode === 'worktree' && typeof item.projectLocalPath === 'string');
  if (!context || typeof context.projectLocalPath !== 'string') throw unavailable();
  try {
    const [root, cwd] = await Promise.all([realpath(project.localPath), realpath(context.projectLocalPath)]);
    const [repository, workspace] = await Promise.all([getGitRepositoryContext(root), getGitRepositoryContext(cwd)]);
    if (cwd === root || !repository.isRepository || !workspace.isRepository || (await realpath(workspace.topLevel)) !== cwd) throw unavailable();
    const registeredPaths = await Promise.all(repository.worktrees.filter((entry) => !entry.bare && !entry.prunable).map((entry) => realpath(entry.path).catch(() => null)));
    if (!registeredPaths.includes(cwd)) throw unavailable();
    const [projectGit, workspaceGit] = await Promise.all([commonGitDirectory(root), commonGitDirectory(cwd)]);
    if (projectGit !== workspaceGit) throw unavailable();
    return { id: `${conversationGitRepositoryPrefix}${conversation.id}`, name: conversation.title || '会话工作树', relativePath: '.', localPath: cwd };
  } catch {
    throw unavailable();
  }
}
