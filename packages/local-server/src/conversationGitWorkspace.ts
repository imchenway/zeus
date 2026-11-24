import { discoverGitRepositories, discoverGitRepositoryRoots, projectGitRepositoryId, readGitBranchSource, readGitBranchSourceHead, withLocalGitObjects } from '@zeus/git-core';
import type { GitEnvironmentSummary } from '@zeus/shared';
import type { ConversationRepository, ConversationSubmissionRepository, ConversationWorktreeRecovery, ConversationWorktreeRecoveryRepository, ZeusProjectRecord } from '@zeus/storage';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mapWithConcurrency } from './localServerPlatformSupport.js';

/** Git 目录身份查询使用只读子进程，不执行仓库修改。 */
const execute = promisify(execFile);

/** 普通仓库与工作树通过真实公共 Git 目录核对归属。 */
async function commonGitDirectory(cwd: string): Promise<string> {
  const result = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 15_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return realpath(result.stdout.trim());
}

/** 会话 Git 范围的持久仓库身份前缀。 */
export const conversationGitRepositoryPrefix = 'conversation:';

/** 读取第一次持久提交的执行目录，归档、恢复与 Git 查询使用同一来源。 */
export function conversationExecutionWorkspace(conversationId: string, submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>) {
  for (const submission of submissions.listByConversation(conversationId)) {
    try {
      const context = JSON.parse(submission.inputJson).context as { projectLocalPath?: unknown; executionWorkspaceMode?: unknown } | undefined;
      if (typeof context?.projectLocalPath === 'string' && (context.executionWorkspaceMode === 'worktree' || context.executionWorkspaceMode === 'direct' || context.executionWorkspaceMode === undefined)) return context;
    } catch {
      /* 非执行提交不含目录信息。 */
    }
  }
  return undefined;
}

/** 只认服务端持久化的会话目录；命令 cwd 和客户端路径不能改变 Git 操作范围。 */
export async function resolveConversationGitWorkspace(
  project: ZeusProjectRecord,
  conversationId: string,
  conversations: Pick<ConversationRepository, 'getRecordById' | 'getDeliveryConflictOrigin'>,
  submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>,
  allowPartialRead = false,
) {
  /** 会话目录的业务错误码供交付、归档和恢复识别。 */
  const unavailableCode = 'ZEUS_CONVERSATION_WORKTREE_UNAVAILABLE';
  /** HTTP 409 保留失败原因，供既有私有故障上报链路采集。 */
  const unavailable = (cause?: unknown) => Object.assign(new Error('会话工作目录不存在、已回收或不属于当前项目。', { cause }), { code: unavailableCode, statusCode: 409 });
  const conversation = conversations.getRecordById(conversationId);
  if (!conversation || conversation.projectId !== project.id || conversation.workspaceId || conversation.environmentId) throw unavailable();
  /** 沿用最初持久提交的目录，不从最近命令的 cwd 或客户端路径推断操作范围。 */
  const context = conversationExecutionWorkspace(conversation.id, submissions);
  if (!context || typeof context.projectLocalPath !== 'string') throw unavailable();
  /** 只读工作台保留可用仓库，并返回发现的失效仓库相对路径。 */
  const unavailableRepositories = new Set<string>();
  const discover = (path: string) => discoverGitRepositories(path, undefined, undefined, allowPartialRead ? (relativePath) => unavailableRepositories.add(relativePath) : undefined);
  try {
    const [root, cwd] = await Promise.all([realpath(project.localPath), realpath(context.projectLocalPath)]);
    /** 交付隔离目录按持久步骤校验，不能用项目相对目录布局判定归属。 */
    const conflict = conversations.getDeliveryConflictOrigin(conversation.id);
    if (conflict) {
      if ((await realpath(conflict.integrationPath)) !== cwd) throw unavailable();
      const original: { repositories: Array<{ id: string; relativePath: string; localPath: string; repositoryPath: string }> } = await resolveConversationGitWorkspace(
        project,
        conflict.conversationId,
        conversations,
        submissions,
        allowPartialRead,
      );
      /** 普通目录交付还可使用服务端登记身份，路径必须属于原会话的已验证成员。 */
      const registeredPath = conflict.repositoryPath ? await realpath(conflict.repositoryPath) : null;
      const source = original.repositories.find(
        (member) => matchesConversationRepositoryId(conflict.repositoryId, conflict.conversationId, member) || projectGitRepositoryId(project.id, member.relativePath) === conflict.repositoryId || member.localPath === registeredPath,
      );
      const member = (await discover(cwd)).find((entry) => entry.localPath === cwd);
      if (!source || !member || (await commonGitDirectory(source.localPath)) !== (await commonGitDirectory(cwd))) throw unavailable();
      const registered = await Promise.all(member.context.worktrees.filter((entry) => !entry.bare && !entry.prunable).map((entry) => realpath(entry.path).catch(() => null)));
      if (!registered.includes(cwd) || cwd === (await realpath(source.localPath))) throw unavailable();
      return {
        id: conversationRepositoryId(conversation.id, '.'),
        name: conversation.title || '冲突工作目录',
        relativePath: '.',
        localPath: cwd,
        workspaceMode: 'worktree' as const,
        sourceBranches: [],
        unavailableRepositories: [...unavailableRepositories].sort(),
        repositories: [{ ...member, id: conversationRepositoryId(conversation.id, '.'), repositoryPath: source.repositoryPath, managedWorktree: false }],
      };
    }
    /** 普通模式只能复用所属项目的真实目录，不能借持久上下文指向其他目录。 */
    if (context.executionWorkspaceMode === 'direct' || (context.executionWorkspaceMode === undefined && cwd === root)) {
      if (cwd !== root) throw unavailable();
      const repositories = await discover(cwd);
      if (!repositories.length && unavailableRepositories.size) throw unavailable();
      return {
        id: conversationRepositoryId(conversation.id, '.'),
        name: conversation.title || '会话工作目录',
        relativePath: '.',
        localPath: cwd,
        workspaceMode: 'direct' as const,
        sourceBranches: [],
        unavailableRepositories: [...unavailableRepositories].sort(),
        repositories: repositories.map((repository) => ({ ...repository, repositoryPath: repository.localPath, managedWorktree: false, id: conversationRepositoryId(conversation.id, repository.relativePath) })),
      };
    }
    if (cwd === root) throw unavailable();
    /** 只纳入环境里实际存在的 Git 根，不把容器目录或共享符号链接当仓库。 */
    const [sources, members] = await Promise.all([discover(root), discover(cwd)]);
    if (!members.length) throw unavailable();
    /** 来源项目登记的工作树决定环境身份；新增仓库可操作，但不自动获得回收权限。 */
    const managedPaths = new Set<string>();
    /** 各仓独立核验并行执行，返回顺序仍与发现顺序一致。 */
    const sourceBranches: NonNullable<GitEnvironmentSummary['sourceBranches']> = await Promise.all(
      members.map(async (member) => {
        /** 新增仓库也必须是会话真实目录中的独立 Git 根。 */
        const source = sources.find((entry) => entry.relativePath === member.relativePath);
        /** 仓库发现已核对 Git 根、分支和工作树，当前请求复用同一份身份。 */
        const workspace = member.context;
        const memberPath = await realpath(member.localPath);
        const child = relative(cwd, memberPath);
        if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`) || !workspace.isRepository || (await realpath(workspace.topLevel)) !== memberPath) throw unavailable();
        if (source) {
          /** 原项目成员仍须匹配相对布局、工作树登记和公共 Git 身份，不能被新增仓库替换。 */
          /** 原项目的登记列表也来自本轮发现，不重复启动整组 Git 查询。 */
          const repository = source.context;
          const registeredPaths = await Promise.all(repository.worktrees.filter((entry) => !entry.bare && !entry.prunable).map((entry) => realpath(entry.path).catch(() => null)));
          if (!registeredPaths.includes(memberPath) || memberPath === (await realpath(source.localPath))) throw unavailable();
          const [projectGit, workspaceGit] = await Promise.all([commonGitDirectory(source.localPath), commonGitDirectory(memberPath)]);
          if (projectGit !== workspaceGit) throw unavailable();
          managedPaths.add(member.localPath);
        }
        return { repositoryRelativePath: member.relativePath, branch: workspace.detached ? null : await readGitBranchSource(member.localPath, workspace.branch) };
      }),
    );
    /** 新增仓库不能单独证明一个任意目录属于当前项目的会话工作树。 */
    if (!managedPaths.size) throw unavailable();
    return {
      id: conversationRepositoryId(conversation.id, '.'),
      name: conversation.title || '会话工作树',
      relativePath: '.',
      localPath: cwd,
      workspaceMode: 'worktree' as const,
      sourceBranches,
      unavailableRepositories: [...unavailableRepositories].sort(),
      repositories: members.map((repository) => ({
        ...repository,
        repositoryPath: sources.find((source) => source.relativePath === repository.relativePath)?.localPath ?? repository.localPath,
        managedWorktree: managedPaths.has(repository.localPath),
        id: conversationRepositoryId(conversation.id, repository.relativePath),
      })),
    };
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === unavailableCode) throw cause;
    throw unavailable(cause);
  }
}

/** 保留可路由的仓库身份，过长子仓使用定长摘要。 */
export function conversationRepositoryId(conversationId: string, relativePath: string): string {
  const prefix = `${conversationGitRepositoryPrefix}${conversationId}`;
  if (!relativePath || relativePath === '.') return prefix;
  const existingId = `${prefix}:${Buffer.from(relativePath).toString('base64url')}`;
  /** Fastify 的默认单参数上限为 100，按 URL 编码后的长度保守判断。 */
  return encodeURIComponent(existingId).length <= 100 ? existingId : `${prefix}:.${createHash('sha256').update(relativePath).digest('hex').slice(0, 24)}`;
}

/** 已保存的交付和冲突记录仍可匹配原仓库；旧后缀只与已核验路径比较。 */
export function matchesConversationRepositoryId(repositoryId: string, conversationId: string, repository: { id: string; relativePath: string }): boolean {
  return repository.id === repositoryId || (repository.relativePath !== '.' && repositoryId === `${conversationGitRepositoryPrefix}${conversationId}:${Buffer.from(repository.relativePath).toString('base64url')}`);
}

/** 恢复引用按项目与原工作树隔离。 */
export function recoveryReferencePrefix(plan: ConversationWorktreeRecovery): string {
  return `refs/zeus/conversation-recovery/${createHash('sha256')
    .update(JSON.stringify([plan.projectId, plan.worktreePath]))
    .digest('hex')}/`;
}

/** 比较起点绑定本次回收记录的分支和提交，避免同一目录的其他快照复用。 */
export function recoverySourceHeadReference(plan: ConversationWorktreeRecovery): string {
  const snapshot = createHash('sha256')
    .update(JSON.stringify([plan.branchName, plan.headSha]))
    .digest('hex');
  return `${recoveryReferencePrefix(plan)}source-head/${snapshot}`;
}

/** 优先使用已保护的起点，旧记录只查询仍指向原提交的分支创建记录。 */
async function readRecoveredSourceHead(plan: ConversationWorktreeRecovery): Promise<string | null> {
  if (!plan.branchName) return null;
  /** 成果提交引用存在时，本次比较只使用同一快照固定的起点。 */
  const headReference = `${recoveryReferencePrefix(plan)}${plan.headSha}`;
  const sourceHeadReference = recoverySourceHeadReference(plan);
  const branchReference = `refs/heads/${plan.branchName}`;
  const { stdout } = await execute('git', ['for-each-ref', '--format=%(refname) %(objectname)', headReference, sourceHeadReference, branchReference], {
    cwd: plan.repositoryPath,
    timeout: 15_000,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  const refs = stdout.trim().split(/\r?\n/);
  /** 精确匹配完整引用，避免把同一前缀下的其他分支当作来源。 */
  const readRef = (reference: string): string | undefined => refs.find((line) => line.startsWith(`${reference} `))?.slice(reference.length + 1);
  if (readRef(headReference) === plan.headSha) return readRef(sourceHeadReference) ?? null;
  if (readRef(branchReference) !== plan.headSha) return null;
  return withLocalGitObjects(() => readGitBranchSourceHead(plan.repositoryPath, plan.branchName));
}

/** 回收记录仅为 Git 只读比较指向项目来源仓库，执行与清理仍要求真实工作树。 */
export async function resolveRecoveredConversationGitRepositories(
  project: ZeusProjectRecord,
  conversationKey: { conversationId: string } | { repositoryKey: string },
  conversations: Pick<ConversationRepository, 'getRecordById'>,
  submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>,
  recovery: Pick<ConversationWorktreeRecoveryRepository, 'list'>,
) {
  const conversation = 'conversationId' in conversationKey ? conversations.getRecordById(conversationKey.conversationId) : conversationForRepositoryKey(conversationKey.repositoryKey, conversations);
  if (!conversation || conversation.projectId !== project.id || conversation.workspaceId || conversation.environmentId) return [];
  const context = conversationExecutionWorkspace(conversation.id, submissions);
  if (typeof context?.projectLocalPath !== 'string' || context.executionWorkspaceMode === 'direct') return [];
  const rootPath = resolve(context.projectLocalPath);
  if (rootPath === resolve(project.localPath)) return [];
  const plans = recovery.list(project.id, rootPath);
  if (!plans.length) return [];
  /** 恢复记录先于物理删除落库，仅当保存的工作树均已移除时使用历史。 */
  const removed = await Promise.all(
    plans.map((plan) =>
      lstat(join(plan.worktreePath, '.git')).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      ),
    ),
  );
  if (!removed.every(Boolean)) return [];
  const sources = await discoverGitRepositoryRoots(project.localPath);
  const repositories = plans.flatMap((plan) => {
    const source = sources.find((candidate) => candidate.localPath === plan.repositoryPath && resolve(rootPath, candidate.relativePath) === plan.worktreePath);
    if (!source || !plan.headSha) return [];
    const id = conversationRepositoryId(conversation.id, source.relativePath);
    if ('repositoryKey' in conversationKey && !matchesConversationRepositoryId(`${conversationGitRepositoryPrefix}${conversationKey.repositoryKey}`, conversation.id, { id, relativePath: source.relativePath })) return [];
    return [{ source, id, plan }];
  });
  /** 单个仓库无法核对起点时，交付窗口仍可读取其他仓库。 */
  return mapWithConcurrency(repositories, async ({ source, id, plan }) => ({
    ...source,
    id,
    branchName: plan.branchName,
    headSha: plan.headSha,
    sourceHeadSha: await readRecoveredSourceHead(plan).catch(() => null),
  }));
}

/** 先匹配持久会话 ID，成员后缀只用于匹配仓库身份。 */
function conversationForRepositoryKey(repositoryKey: string, conversations: Pick<ConversationRepository, 'getRecordById'>) {
  return conversations.getRecordById(repositoryKey) ?? conversations.getRecordById(repositoryKey.slice(0, repositoryKey.lastIndexOf(':')));
}

/** 文件和 Git 操作只接受环境内一个已验证仓库，不能向容器目录执行仓库命令。 */
export async function resolveConversationGitRepository(
  project: ZeusProjectRecord,
  repositoryKey: string,
  conversations: Pick<ConversationRepository, 'getRecordById' | 'getDeliveryConflictOrigin'>,
  submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>,
  allowPartialRead = false,
) {
  const conversationId = conversationForRepositoryKey(repositoryKey, conversations)?.id ?? repositoryKey;
  const workspace = await resolveConversationGitWorkspace(project, conversationId, conversations, submissions, allowPartialRead);
  const repository = workspace.repositories.find((member) => matchesConversationRepositoryId(`${conversationGitRepositoryPrefix}${repositoryKey}`, conversationId, member));
  if (!repository) throw Object.assign(new Error('仓库已不存在或不属于当前会话工作目录。'), { code: 'ZEUS_CONVERSATION_WORKTREE_UNAVAILABLE', statusCode: 409 });
  return repository;
}
