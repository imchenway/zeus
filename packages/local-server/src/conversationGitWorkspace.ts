import { discoverGitRepositories, getGitRepositoryContext } from '@zeus/git-core';
import type { ConversationRepository, ConversationSubmissionRepository, ZeusProjectRecord } from '@zeus/storage';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

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
      const repositories = await discoverGitRepositories(cwd);
      return {
        id: conversationRepositoryId(conversation.id, '.'),
        name: conversation.title || '会话工作目录',
        relativePath: '.',
        localPath: cwd,
        workspaceMode: 'direct' as const,
        repositories: repositories.map((repository) => ({ ...repository, id: conversationRepositoryId(conversation.id, repository.relativePath) })),
      };
    }
    if (cwd === root) throw unavailable();
    /** 只纳入环境里实际存在的 Git 根，不把容器目录或共享符号链接当仓库。 */
    const [sources, members] = await Promise.all([discoverGitRepositories(root), discoverGitRepositories(cwd)]);
    if (!members.length) throw unavailable();
    for (const member of members) {
      /** 相对布局和公共 Git 身份必须同时属于原项目。 */
      const source = sources.find((entry) => entry.relativePath === member.relativePath);
      if (!source) throw unavailable();
      const [repository, workspace, memberPath] = await Promise.all([getGitRepositoryContext(source.localPath), getGitRepositoryContext(member.localPath), realpath(member.localPath)]);
      const child = relative(cwd, memberPath);
      if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`) || !workspace.isRepository || (await realpath(workspace.topLevel)) !== memberPath) throw unavailable();
      const registeredPaths = await Promise.all(repository.worktrees.filter((entry) => !entry.bare && !entry.prunable).map((entry) => realpath(entry.path).catch(() => null)));
      if (!registeredPaths.includes(memberPath) || memberPath === (await realpath(source.localPath))) throw unavailable();
      const [projectGit, workspaceGit] = await Promise.all([commonGitDirectory(source.localPath), commonGitDirectory(memberPath)]);
      if (projectGit !== workspaceGit) throw unavailable();
    }
    return {
      id: conversationRepositoryId(conversation.id, '.'),
      name: conversation.title || '会话工作树',
      relativePath: '.',
      localPath: cwd,
      workspaceMode: 'worktree' as const,
      repositories: members.map((repository) => ({ ...repository, id: conversationRepositoryId(conversation.id, repository.relativePath) })),
    };
  } catch {
    throw unavailable();
  }
}

/** 根仓沿用原身份；子仓身份同时绑定会话和项目内相对位置。 */
export function conversationRepositoryId(conversationId: string, relativePath: string): string {
  return `${conversationGitRepositoryPrefix}${conversationId}${relativePath && relativePath !== '.' ? `:${Buffer.from(relativePath).toString('base64url')}` : ''}`;
}

/** 文件和 Git 操作只接受环境内一个已验证仓库，不能向容器目录执行仓库命令。 */
export async function resolveConversationGitRepository(
  project: ZeusProjectRecord,
  repositoryKey: string,
  conversations: Pick<ConversationRepository, 'getRecordById'>,
  submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>,
) {
  /** 持久会话身份优先；成员后缀只参与身份匹配，绝不解码成磁盘路径。 */
  const conversationId = conversations.getRecordById(repositoryKey) ? repositoryKey : repositoryKey.slice(0, repositoryKey.lastIndexOf(':'));
  const workspace = await resolveConversationGitWorkspace(project, conversationId, conversations, submissions);
  const repository = workspace.repositories.find((member) => member.id === `${conversationGitRepositoryPrefix}${repositoryKey}`);
  if (!repository) throw Object.assign(new Error('仓库已不存在或不属于当前会话工作目录。'), { code: 'ZEUS_CONVERSATION_WORKTREE_UNAVAILABLE', statusCode: 409 });
  return repository;
}
