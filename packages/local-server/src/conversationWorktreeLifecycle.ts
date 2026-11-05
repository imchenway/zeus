import { discoverGitRepositories, getGitRepositoryContext, getGitWorktreeClean, prepareTaskWorktree, removeTaskWorktreeForTerminalStatus } from '@zeus/git-core';
import {
  ConversationWorktreeRecoveryRepository,
  type ConversationRepository,
  type ConversationSubmissionRepository,
  type ConversationWorktreeRecovery,
  type ProjectRepository,
  type ZeusConversationRecord,
  type ZeusDatabase,
} from '@zeus/storage';
import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { conversationExecutionWorkspace, resolveConversationGitWorkspace } from './conversationGitWorkspace.js';

/** detached HEAD 恢复使用固定 Git 参数，不通过 shell 拼接。 */
const execute = promisify(execFile);

/** 只处理会话自有目录，任务环境继续由任务工作区仓储管理。 */
export interface ConversationWorktreeLifecyclePorts {
  /** 原有业务数据库。 */
  db: ZeusDatabase;
  /** 来源仓库所属项目。 */
  projects: ProjectRepository;
  /** 查询仍使用目录的会话。 */
  conversations: ConversationRepository;
  /** 读取服务端持久执行目录。 */
  conversationSubmissions: ConversationSubmissionRepository;
}

/** 清理前固定 Git 身份及是否需要用户确认丢弃未提交内容。 */
export interface ConversationWorktreeCleanup extends ConversationWorktreeRecovery {
  /** true 表示存在未提交或未跟踪内容。 */
  force: boolean;
}

/** 只把明确不存在视为已经回收，权限和磁盘错误继续上报。 */
async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

/** 归档与任务终态共用检查；其他未归档会话仍使用的目录保留。 */
export async function inspectConversationWorktrees(ports: ConversationWorktreeLifecyclePorts, closing: ZeusConversationRecord[]): Promise<ConversationWorktreeCleanup[]> {
  /** 同一环境只扫描一次，专家子会话可能复用父会话目录。 */
  const inspected = new Set<string>();
  /** 当前操作允许关闭的会话集合。 */
  const closingIds = new Set(closing.map((conversation) => conversation.id));
  /** 经过目录归属验证的清理计划。 */
  const result: ConversationWorktreeCleanup[] = [];
  for (const conversation of closing) {
    if (conversation.workspaceId || conversation.environmentId) continue;
    /** 直接目录会话不拥有项目目录的删除权。 */
    const context = conversationExecutionWorkspace(conversation.id, ports.conversationSubmissions);
    if (context?.executionWorkspaceMode === 'direct' || typeof context?.projectLocalPath !== 'string') continue;
    /** 旧提交可能没有模式字段，仍须排除项目目录，再由 Git 登记确认工作树身份。 */
    const project = ports.projects.getById(conversation.projectId);
    if (!project) throw new Error('会话所属项目不存在，工作树已保留。');
    /** 按物理执行根合并同一批归档的会话。 */
    const rootPath = resolve(context.projectLocalPath);
    if (rootPath === resolve(project.localPath)) continue;
    if (inspected.has(rootPath)) continue;
    inspected.add(rootPath);
    /** 未归档的使用者决定是否保留目录，不按当前是否运行推测归属。 */
    const shared = ports.conversations.listRecordsByProject(conversation.projectId).some((other) => {
      if (closingIds.has(other.id)) return false;
      const otherContext = conversationExecutionWorkspace(other.id, ports.conversationSubmissions);
      return typeof otherContext?.projectLocalPath === 'string' && resolve(otherContext.projectLocalPath) === rootPath;
    });
    if (shared || !(await pathExists(rootPath))) continue;
    /** 多仓容器可在 Git 成员全部回收后继续存在，重复归档不把空容器当故障。 */
    const recovered = new ConversationWorktreeRecoveryRepository(ports.db).list(conversation.projectId, rootPath);
    if (recovered.length && !(await Promise.all(recovered.map((entry) => pathExists(entry.worktreePath)))).some(Boolean)) continue;
    /** 恢复行只由验证过 Git 公共目录与项目归属的会话产生。 */
    const workspace = await resolveConversationGitWorkspace(project, conversation.id, ports.conversations, ports.conversationSubmissions);
    const sources = await discoverGitRepositories(project.localPath);
    for (const member of workspace.repositories) {
      const source = sources.find((repository) => repository.relativePath === member.relativePath);
      if (!source) throw new Error('来源仓库不可用，工作树已保留。');
      const [git, clean] = await Promise.all([getGitRepositoryContext(member.localPath), getGitWorktreeClean(member.localPath)]);
      result.push({ projectId: project.id, rootPath, repositoryPath: source.localPath, worktreePath: member.localPath, branchName: git.detached ? '' : git.branch, headSha: git.headSha, force: !clean });
    }
  }
  return result;
}

/** 删除前保存恢复身份；复用任务完成时的 Git 清理，保留本地分支。 */
export async function removeConversationWorktrees(db: ZeusDatabase, plans: ConversationWorktreeCleanup[], beforeExternalWrite?: () => void): Promise<number> {
  if (!plans.length) return 0;
  /** 进程停止后重新冻结提交，保留其最后写出的提交与当前检出分支。 */
  const snapshots = await Promise.all(
    plans.map(async (plan) => {
      if (!(await pathExists(plan.worktreePath))) return plan;
      const git = await getGitRepositoryContext(plan.worktreePath);
      if (!git.isRepository || resolve(git.topLevel) !== resolve(plan.worktreePath)) throw new Error('工作树身份已变化，目录已保留。');
      return { ...plan, branchName: git.detached ? '' : git.branch, headSha: git.headSha };
    }),
  );
  new ConversationWorktreeRecoveryRepository(db).save(snapshots);
  /** 子仓先于父仓回收，避免父工作树含有仍登记的子仓目录。 */
  const ordered = [...plans].sort((left, right) => right.worktreePath.length - left.worktreePath.length);
  /** 只豁免本轮已成功回收的子仓，不能用待删除计划跳过文件保护。 */
  const removedPaths: string[] = [];
  let removed = 0;
  for (const plan of ordered) {
    /** 子模块删除会使父仓出现 Git 删除状态，路径按系统边界判断后转为 Git 路径。 */
    const removedChildren = removedPaths
      .map((path) => relative(plan.worktreePath, path))
      .filter((path) => path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
      .map((path) => path.split(sep).join('/'));
    if (!plan.force && removedChildren.length && !(await getGitWorktreeClean(plan.worktreePath, removedChildren))) {
      throw Object.assign(new Error('工作树仍有未经确认的本地改动，目录已保留。'), { code: 'ZEUS_TASK_WORKSPACE_DIRTY' });
    }
    beforeExternalWrite?.();
    if ((await removeTaskWorktreeForTerminalStatus({ ...plan, force: plan.force || removedChildren.length > 0 })).removed) {
      removedPaths.push(plan.worktreePath);
      removed += 1;
    }
  }
  return removed;
}

/** 恢复会话或续发时重建已回收的 Git 成员，已有目录交回原有身份校验。 */
export async function restoreConversationWorktrees(ports: ConversationWorktreeLifecyclePorts, conversation: ZeusConversationRecord): Promise<void> {
  if (conversation.workspaceId || conversation.environmentId) return;
  const context = conversationExecutionWorkspace(conversation.id, ports.conversationSubmissions);
  if (context?.executionWorkspaceMode === 'direct' || typeof context?.projectLocalPath !== 'string') return;
  const recovery = new ConversationWorktreeRecoveryRepository(ports.db);
  const plans = recovery.list(conversation.projectId, resolve(context.projectLocalPath));
  if (!plans.length) return;
  const project = ports.projects.getById(conversation.projectId);
  if (!project) throw new Error('会话所属项目不存在，无法恢复工作树。');
  /** 项目目录变更后必须重新验证来源，不能凭历史快照恢复到其他项目仓库。 */
  const sources = await discoverGitRepositories(project.localPath);
  if (plans.some((plan) => !sources.some((source) => resolve(source.localPath) === resolve(plan.repositoryPath)))) throw new Error('来源仓库已变化，无法恢复会话工作树。');
  for (const plan of plans) {
    if (await pathExists(plan.worktreePath)) {
      /** 已存在目录必须仍是该 Git 根，普通目录不能冒充恢复成功。 */
      const repository = await getGitRepositoryContext(plan.worktreePath);
      if (!repository.isRepository || resolve(repository.topLevel) !== resolve(plan.worktreePath)) throw new Error('原工作树目录已被其他内容占用，恢复记录已保留。');
      continue;
    }
    if (plan.branchName) {
      const source = await getGitRepositoryContext(plan.repositoryPath);
      await prepareTaskWorktree({
        repositoryPath: plan.repositoryPath,
        repositoryContext: source,
        projectSlug: project.slug,
        taskCode: 'conversation',
        taskTitle: conversation.title,
        workspaceId: conversation.id,
        branchPrefix: null,
        worktreePath: plan.worktreePath,
        branchName: plan.branchName,
        sourceBranch: source.branch,
        sourceRef: plan.headSha || source.branch,
        existingBranch: true,
      });
    } else {
      await execute('git', ['worktree', 'add', '--detach', plan.worktreePath, plan.headSha], { cwd: plan.repositoryPath, timeout: 30_000 });
    }
  }
  await resolveConversationGitWorkspace(project, conversation.id, ports.conversations, ports.conversationSubmissions);
  recovery.clear(conversation.projectId, resolve(context.projectLocalPath));
}
