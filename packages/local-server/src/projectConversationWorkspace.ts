import { assertValidGitBranchName, buildTaskEnvironmentRootPath, discoverGitRepositories, projectGitRepositoryId, cleanupPreparedTaskWorktree, getGitRepositoryContext, prepareTaskWorktree, type GitRepositoryContext } from '@zeus/git-core';
import { defaultTaskBranchPrefix, isConversationWorktreeOptions, type ConversationWorktreeBranchOptions } from '@zeus/shared';
import type { ZeusProjectRecord, ZeusProjectRepositoryRecord, ZeusProjectSharedPathRecord } from '@zeus/storage';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mirrorTaskEnvironmentContainer, overlayTaskEnvironmentSharedPaths } from './conversationExecutionContextOperations.js';

/** 已通过来源、占用和目标分支校验的单仓准备参数。 */
interface ConversationRepositoryPreparation {
  /** 仓库实际目录。 */
  repositoryPath: string;
  /** 本次准备前读取的 Git 状态。 */
  context: GitRepositoryContext;
  /** 该仓独立的来源和新分支。 */
  selection: ConversationWorktreeBranchOptions;
  /** 环境内保持原相对位置的目标目录。 */
  worktreePath: string;
  /** 当前会话已经登记此工作树，重试时不创建或清理它。 */
  existingBranch: boolean;
  /** 尚无首次提交的来源需要沿用原文件初始化。 */
  sourceUnborn: boolean;
}

/** 路径绑定持久会话身份，所有仓库先校验再准备，失败只清理本次新建成员。 */
export async function prepareProjectConversationWorkspace(
  project: ZeusProjectRecord,
  conversationId: string | undefined,
  mode: unknown,
  options?: unknown,
  taskBranchPrefix = defaultTaskBranchPrefix,
  members?: { repositories: ZeusProjectRepositoryRecord[]; sharedPaths: ZeusProjectSharedPathRecord[] },
): Promise<string> {
  if (mode === undefined || mode === 'direct') return project.localPath;
  if (mode !== 'worktree') throw workspaceError('工作位置必须是项目目录或新建工作树。');
  if (!conversationId) throw workspaceError('创建工作树前必须保留会话身份。');
  if (options !== undefined && !isConversationWorktreeOptions(options)) throw workspaceError('请选择来源分支并填写工作树分支名。');
  /** 重试同一首发请求仍指向同一环境。 */
  const identity = createHash('sha256').update(conversationId).digest('hex').slice(0, 20);
  /** 整个环境的路径不接受客户端输入。 */
  const environmentRoot = buildTaskEnvironmentRootPath(project.localPath, project.slug, 'conversation', identity.slice(-16));
  /** 项目模式要求完整仓库选择，避免漏仓后悄悄使用原项目目录。 */
  const selections = isConversationWorktreeOptions(options) && 'repositories' in options ? options.repositories : null;
  /** 所有分支检查完成前不创建任何工作树。 */
  const preparations: ConversationRepositoryPreparation[] = [];
  /** 准备和镜像容器必须使用同一份已核对目录。 */
  let repositories: Array<Pick<ZeusProjectRepositoryRecord, 'id' | 'localPath' | 'relativePath'>> = [];
  if (selections) {
    /** 桌面 Git 直接发现仓库，不要求先登记为任务仓库。 */
    const discovered = (await discoverGitRepositories(project.localPath)).map((repository) => ({ ...repository, id: projectGitRepositoryId(project.id, repository.relativePath) }));
    /** 桌面发现身份和网页登记身份是两个现有入口，不能将前者与数据库 ID 比较。 */
    repositories = selections.some((selection) => discovered.some((repository) => repository.id === selection.repositoryId)) ? discovered : (members?.repositories ?? []);
    if (!repositories.length || selections.length !== repositories.length || repositories.some((repository) => !selections.some((selection) => selection.repositoryId === repository.id)))
      throw workspaceError('项目仓库已变化，请刷新并为每个仓库选择来源分支。');
    for (const repository of [...repositories].sort((left, right) => left.relativePath.split('/').length - right.relativePath.split('/').length || left.relativePath.localeCompare(right.relativePath))) {
      /** 仓库相对路径只允许落在当前环境内部。 */
      const target = resolve(environmentRoot, repository.relativePath);
      const child = relative(environmentRoot, target);
      if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw workspaceError('仓库相对路径不属于当前项目。');
      preparations.push(
        await prepareSelection(
          repository.localPath,
          target,
          selections.find((selection) => selection.repositoryId === repository.id)!,
          taskBranchPrefix,
        ),
      );
    }
  } else {
    /** 单根仓历史请求继续恢复原有环境和分支身份。 */
    const context = await getGitRepositoryContext(project.localPath);
    if (!context.isRepository || resolve(context.topLevel) !== resolve(project.localPath)) throw workspaceError('请为项目内各 Git 仓库选择来源分支。', 'ZEUS_GIT_REPOSITORY_REQUIRED');
    const selection = isConversationWorktreeOptions(options) && !('repositories' in options) ? options : { sourceKind: 'local' as const, sourceRef: context.branch, branchName: `${taskBranchPrefix}/conversation-${identity}` };
    preparations.push(await prepareSelection(project.localPath, environmentRoot, selection, taskBranchPrefix, context));
  }
  /** 只有本次新环境才允许整理父仓内的嵌套仓目录。 */
  const newEnvironment = !existsSync(environmentRoot);
  /** 已登记成员在失败时保持原样。 */
  const created: ConversationRepositoryPreparation[] = [];
  /** 底层创建中断时核对 Git 登记，避免其清理失败后误删整个环境。 */
  let preparing: ConversationRepositoryPreparation | undefined;
  try {
    if (selections && newEnvironment) mirrorTaskEnvironmentContainer(project, environmentRoot, repositories, members?.sharedPaths ?? []);
    for (const preparation of preparations) {
      const { context, selection, existingBranch, sourceUnborn, worktreePath, repositoryPath } = preparation;
      /** 新父仓可能带有嵌套仓占位；恢复已有环境时不能删除该目录中的用户文件。 */
      if (!existingBranch && newEnvironment && resolve(worktreePath) !== resolve(environmentRoot) && existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
      /** 嵌套仓和共享目录由环境准备负责，空仓初始化不能再复制它们。 */
      const ignoredPaths = [...preparations.map((member) => member.worktreePath), ...(members?.sharedPaths ?? []).map((shared) => resolve(environmentRoot, shared.relativePath))]
        .map((memberPath) => relative(worktreePath, memberPath))
        .filter((memberPath) => memberPath && !isAbsolute(memberPath) && memberPath !== '..' && !memberPath.startsWith(`..${sep}`))
        .map((memberPath) => memberPath.split(sep).join('/'));
      /** 恢复只使用目标仓当前 HEAD，不重新检出来源分支。 */
      const existingContext = existingBranch ? await getGitRepositoryContext(worktreePath) : null;
      preparing = preparation;
      await prepareTaskWorktree({
        repositoryPath,
        repositoryContext: context,
        projectSlug: project.slug,
        taskCode: 'conversation',
        taskTitle: '会话',
        workspaceId: identity,
        worktreePath,
        branchName: selection.branchName,
        branchPrefix: existingBranch ? null : taskBranchPrefix,
        sourceRef: existingContext?.headSha ?? selection.sourceRef,
        ...(!existingBranch ? { sourceKind: selection.sourceKind } : {}),
        sourceBranch: selection.sourceKind === 'remote' ? selection.sourceRef.slice(selection.sourceRef.indexOf('/') + 1) : selection.sourceRef,
        existingBranch,
        includeLocalChanges: sourceUnborn,
        ignoredPaths,
      });
      if (!existingBranch) created.push(preparation);
      preparing = undefined;
    }
    if (selections && members && newEnvironment) overlayTaskEnvironmentSharedPaths(environmentRoot, members.sharedPaths);
    return environmentRoot;
  } catch (error) {
    /** 清理失败时保留环境及错误，不能把仍登记的工作树目录直接删除。 */
    const cleanupErrors: unknown[] = [];
    if (preparing && !preparing.existingBranch) {
      try {
        /** 仅回收本次已创建并仍登记为预期分支的失败成员。 */
        const failedContext = await getGitRepositoryContext(preparing.repositoryPath);
        if (failedContext.worktrees.some((entry) => resolve(entry.path) === resolve(preparing!.worktreePath) && entry.branch === preparing!.selection.branchName)) created.push(preparing);
      } catch (inspectionError) {
        cleanupErrors.push(inspectionError);
      }
    }
    for (const member of cleanupErrors.length ? [] : created.reverse()) {
      try {
        await cleanupPreparedTaskWorktree({ repositoryPath: member.repositoryPath, worktreePath: member.worktreePath, branchName: member.selection.branchName, removeBranch: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
        // 子仓清理失败后保留父目录，避免父仓回收再删除该子仓。
        break;
      }
    }
    if (newEnvironment && !cleanupErrors.length) rmSync(environmentRoot, { recursive: true, force: true });
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], '创建工作树失败，部分新建目录未能清理，请检查后重试。');
    throw error;
  }
}

/** 复用单仓工作树的引用和占用检查，不在校验阶段修改仓库。 */
async function prepareSelection(repositoryPath: string, worktreePath: string, requested: ConversationWorktreeBranchOptions, prefix: string, loaded?: GitRepositoryContext): Promise<ConversationRepositoryPreparation> {
  const context = loaded ?? (await getGitRepositoryContext(repositoryPath));
  if (!context.isRepository || resolve(context.topLevel) !== resolve(repositoryPath)) throw workspaceError('仓库目录已不可用，请刷新后重试。');
  const selection = { ...requested, sourceRef: requested.sourceRef.trim(), branchName: requested.branchName.trim() };
  const registered = context.worktrees.find((entry) => resolve(entry.path) === resolve(worktreePath));
  const branchExists = context.localBranches.includes(selection.branchName);
  const existingBranch = Boolean(registered?.branch === selection.branchName && !registered.prunable && !registered.bare);
  if (registered && (!existingBranch || !existsSync(join(worktreePath, '.git')))) throw workspaceError('会话工作树登记已失效，请检查目录后重试。');
  await assertValidGitBranchName(context.topLevel, selection.branchName, existingBranch ? null : prefix);
  if (registered && registered.branch !== selection.branchName) throw workspaceError('此会话已创建了不同分支的工作树，请沿用原配置重试。');
  if (branchExists && !existingBranch) throw workspaceError('该分支已存在，请为新工作树设置其他分支名。', 'ZEUS_TASK_BRANCH_ALREADY_EXISTS');
  if (context.worktrees.some((entry) => entry.branch === selection.branchName && resolve(entry.path) !== resolve(worktreePath))) throw workspaceError('该分支已在其他工作目录使用。', 'ZEUS_TASK_BRANCH_ALREADY_EXISTS');
  const sourceUnborn = selection.sourceKind === 'local' && !context.detached && !context.headSha && selection.sourceRef === context.branch;
  if (!existingBranch && !(selection.sourceKind === 'local' ? context.localBranches.includes(selection.sourceRef) || sourceUnborn : context.remoteBranches.includes(selection.sourceRef)))
    throw workspaceError('来源分支已不可用，请刷新分支并重新选择。');
  return { repositoryPath, worktreePath, context, selection, existingBranch, sourceUnborn };
}

/** 工作位置校验错误沿用首发流程的可编辑失败分类。 */
function workspaceError(message: string, code = 'ZEUS_INVALID_CONVERSATION_START'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
