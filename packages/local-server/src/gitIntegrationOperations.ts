import { createAiRuntimeSessionManager, parseModelRef } from '@zeus/ai-runtime';
import {
  buildGitPatchExport,
  buildTaskBranchName,
  buildTaskEnvironmentRootPath,
  cleanupPreparedTaskWorktree,
  cleanupTaskIntegrationWorktree,
  commitTaskWorkspace,
  completeTaskIntegrationCommit,
  discardTaskWorktree,
  executeProjectGitAction,
  fetchGitRemote,
  finalizeTaskBranchIntegration,
  getGitBranchHead,
  getGitRepositoryContext,
  getGitWorktreeClean,
  getProjectGitRepositorySnapshot,
  getRemoteTrackingBranchHead,
  getTaskBranchComparison,
  getTaskWorkspaceReview,
  type GitRepositoryContext,
  prepareTaskWorktree,
  pushLocalBranch,
  pushTaskWorkspace,
  readTaskIntegrationConflict,
  reclaimDeliveredTaskWorktree,
  reclaimTaskWorktree,
  refreshConflictTaskWorkspace,
  removeTaskWorktreeForTerminalStatus,
  startTaskBranchIntegration,
  startTaskIntegrationAttempt,
  writeTaskIntegrationDraft,
  writeTaskIntegrationResolution,
} from '@zeus/git-core';
import { buildTaskCommitMessageSuggestion } from '@zeus/shared';
import {
  ConversationRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  ProjectRepository,
  ProjectRepositoryRegistrationRepository,
  ProjectSharedPathRepository,
  RuntimeSessionRepository,
  TaskEnvironmentRepository,
  TaskIntegrationAttemptRepository,
  TaskIntegrationRepository,
  TaskRepository,
  TaskWorkspaceRepository,
  type ZeusConversationWithMessagesRecord,
  type ZeusDatabase,
  type ZeusProjectRecord,
  type ZeusProjectRepositoryRecord,
  type ZeusTaskEnvironmentRecord,
  type ZeusTaskIntegrationRecord,
  type ZeusTaskRecord,
  type ZeusTaskWorkspaceRecord,
} from '@zeus/storage';
import { type FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseJsonObject } from './codeIntelligenceGraphStore.js';
import { createCodexNativeConversationCoordinator } from './codexNativeConversationCoordinator.js';
import { isNativeApiRecord, nativeApiError } from './conversationApplicationOperations.js';
import { isPathInsideRoot } from './conversationResourcePreview.js';
import type { BatchTaskWorkspaceResult, WorkspaceGitExplicitRejection, WorkspaceGitPreparedOpaque } from './index.js';
import { ProjectGitQueryApplication } from './projectGitQueryApplication.js';
import { runtimeSessionIsConfirmedTerminal } from './runtimeQueryApplication.js';
import { buildTaskConflictAiConversationTitle, buildTaskConflictAiPrompt } from './taskConflictAi.js';
import { type WorkspaceGitCommandType, workspaceGitCommandTypes } from './workspaceGitCommandApplication.js';
import { type PreparedWorkspaceGitCommand, type WorkspaceGitRouteExecution } from './workspaceGitCommandRoutes.js';
export { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor, type ReadOnlyValidationApplicationIdentity } from './readOnlyValidation.js';
// 拆分期间保留结构化工厂依赖，后续按领域端口继续收窄。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GitIntegrationOperationDependencies = Record<string, any> & {
  aiRuntimeManager: ReturnType<typeof createAiRuntimeSessionManager>;
  codexNativeCoordinator: ReturnType<typeof createCodexNativeConversationCoordinator>;
  conversationSubmissions: ConversationSubmissionRepository;
  conversationTurns: ConversationTurnRepository;
  conversations: ConversationRepository;
  db: ZeusDatabase;
  getProjectGitQueries(): ProjectGitQueryApplication;
  projectRepositories: ProjectRepositoryRegistrationRepository;
  projectSharedPaths: ProjectSharedPathRepository;
  projects: ProjectRepository;
  runtimeSessions: RuntimeSessionRepository;
  taskEnvironments: TaskEnvironmentRepository;
  taskIntegrationAttempts: TaskIntegrationAttemptRepository;
  taskIntegrations: TaskIntegrationRepository;
  taskWorkspaces: TaskWorkspaceRepository;
  tasks: TaskRepository;
};

export function createGitIntegrationOperations(dependencies: GitIntegrationOperationDependencies) {
  const {
    aiRuntimeManager,
    appendAuditLog,
    codexNativeCoordinator,
    conversationSubmissions,
    conversationTurns,
    conversations,
    db,
    executeTaskConversationIdempotent,
    getProjectGitQueries,
    mirrorTaskEnvironmentContainer,
    now,
    overlayTaskEnvironmentSharedPaths,
    parseConversationPermissionMode,
    parseProjectGitAction,
    persistReadonlyGitDiffSnapshot,
    projectRepositories,
    projectSharedPaths,
    projects,
    publishGitDiffUpdatedEvent,
    publishRealtimeEvent,
    readGitDiff,
    recordTaskEvent,
    resolveConversationCapabilities,
    resolveTaskEnvironmentWritableRoots,
    runtimeSessions,
    sendNativeConversationApiError,
    startNativeTaskConversationFromPlan,
    taskConflictAiOperations,
    taskEnvironments,
    taskIntegrationAttempts,
    taskIntegrations,
    taskWorkspaces,
    tasks,
  } = dependencies;
  function taskPushRepositoryRevision(repositories: ZeusProjectRepositoryRecord[]): string {
    return createHash('sha256')
      .update(
        repositories
          .map((repository) => `${repository.id}\0${repository.relativePath}\0${repository.localPath}`)
          .sort()
          .join('\0'),
      )
      .digest('hex');
  }

  async function mapTaskRepositoriesWithConcurrency<Input, Output>(items: Input[], operation: (item: Input, index: number) => Promise<Output>, concurrency = 4): Promise<Output[]> {
    const results = new Array<Output>(items.length);
    let nextIndex = 0;
    let firstError: unknown;
    const worker = async (): Promise<void> => {
      while (true) {
        if (firstError) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          results[index] = await operation(items[index]!, index);
        } catch (error) {
          firstError ??= error;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()));
    if (firstError) throw firstError;
    return results;
  }

  function countDirectProjectActiveWritableConversations(projectId: string): number {
    let offset = 0;
    let count = 0;
    while (true) {
      const page = conversations.listByProject(projectId, { limit: 100, offset });
      count += page.items.filter((conversation) => {
        if (conversation.workspaceId || conversation.environmentId || conversation.permissionMode === 'read-only') return false;
        return taskConversationHasActiveWork(conversation);
      }).length;
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) return count;
    }
  }

  async function resolveTaskPushRepositoryCapability(
    project: ZeusProjectRecord,
    task: ZeusTaskRecord,
    registeredRepository: ZeusProjectRepositoryRecord,
    refreshRemote: boolean,
    observed?: { context: GitRepositoryContext; clean: boolean },
  ) {
    let repository = observed?.context ?? (await getGitRepositoryContext(registeredRepository.localPath));
    let clean = observed?.clean ?? (await getGitWorktreeClean(registeredRepository.localPath, projectRepositoryIgnoredPaths(project.id, registeredRepository.id, registeredRepository.localPath)));
    if (!repository.isRepository) throw nativeApiError('ZEUS_PROJECT_REPOSITORY_UNAVAILABLE', `Project repository is unavailable: ${registeredRepository.relativePath}`);
    const defaultRemoteName = repository.remotes.includes('origin') ? 'origin' : (repository.remotes[0] ?? '');
    let remoteRefreshError: string | null = null;
    let remoteRefreshStatus: 'not_requested' | 'succeeded' | 'failed' = 'not_requested';
    if (refreshRemote && repository.remotes.length > 0) {
      // 同一仓库的多个 fetch 串行执行，避免并发写 FETCH_HEAD 或远端跟踪引用互相抢锁。
      const refreshResults: Array<string | null> = [];
      for (const remoteName of repository.remotes) {
        try {
          await fetchGitRemote(registeredRepository.localPath, remoteName);
          refreshResults.push(null);
        } catch (error) {
          refreshResults.push(taskGitErrorCode(error));
        }
      }
      repository = await getGitRepositoryContext(registeredRepository.localPath);
      clean = await getGitWorktreeClean(registeredRepository.localPath, projectRepositoryIgnoredPaths(project.id, registeredRepository.id, registeredRepository.localPath));
      remoteRefreshError = refreshResults.find((result): result is string => Boolean(result)) ?? null;
      remoteRefreshStatus = remoteRefreshError ? 'failed' : 'succeeded';
    }
    const sourceRefs = [
      ...repository.localBranches.map((branch) => ({
        ref: `refs/heads/${branch}`,
        label: branch,
        kind: 'local' as const,
        group: 'local',
        current: branch === repository.branch,
      })),
      ...repository.remoteBranches.map((ref) => {
        const separator = ref.indexOf('/');
        const remoteName = separator > 0 ? ref.slice(0, separator) : defaultRemoteName;
        const branch = separator > 0 ? ref.slice(separator + 1) : ref;
        return {
          ref: `refs/remotes/${ref}`,
          label: branch,
          kind: 'remote' as const,
          group: remoteName || 'remote',
          current: false,
        };
      }),
    ];
    return {
      ...registeredRepository,
      branch: repository.branch,
      headSha: repository.headSha,
      clean,
      defaultRemoteName,
      remoteRefreshStatus,
      remoteRefreshError,
      sourceRefs,
      suggestedBranchName: buildTaskBranchName(task.taskCode, task.title, taskEnvironments.listByTask(task.id).length + 1),
    };
  }

  /**
   * 任务推送提交的轻量能力复验，不读取 Git 仓库或刷新远端。
   * 弹窗读取能力时已经需要完整 Git 快照；真正创建工作区时还会再次刷新远端并冻结来源提交。
   * 提交阶段只复验模型和运行能力，避免在工作区准备前再做一次完整仓库扫描。
   */
  async function resolveTaskPushExecutionCapabilities(project: ZeusProjectRecord) {
    return resolveConversationCapabilities(project);
  }

  async function resolveTaskPushEnvironment(
    project: ZeusProjectRecord,
    task: ZeusTaskRecord,
    selection: unknown,
    stableOperationId: string,
  ): Promise<{ environment: ZeusTaskEnvironmentRecord; workspaces: ZeusTaskWorkspaceRecord[]; cwd: string; writableRoots: string[] }> {
    if (!isNativeApiRecord(selection) || (selection.mode !== 'create' && selection.mode !== 'existing')) {
      throw nativeApiError('ZEUS_TASK_ENVIRONMENT_CHOICE_REQUIRED', 'Choose a new task environment or an existing task environment.');
    }

    if (selection.mode === 'existing') {
      const requestedEnvironmentId = typeof selection.environmentId === 'string' ? selection.environmentId.trim() : '';
      const legacyWorkspaceId = typeof selection.workspaceId === 'string' ? selection.workspaceId.trim() : '';
      const legacyWorkspace = legacyWorkspaceId ? taskWorkspaces.getById(legacyWorkspaceId) : undefined;
      const environment = taskEnvironments.getById(requestedEnvironmentId || legacyWorkspace?.environmentId || '');
      if (!environment || environment.projectId !== project.id || environment.taskId !== task.id) {
        throw nativeApiError('ZEUS_TASK_ENVIRONMENT_INVALID', 'Selected task environment does not belong to this task.');
      }
      if (environment.state === 'reclaimed') throw nativeApiError('ZEUS_TASK_ENVIRONMENT_CLOSED', 'Reclaimed task environments cannot be selected again.');
      assertTaskEnvironmentWritable(environment);
      const members = taskWorkspaces.listByEnvironment(environment.id);
      const restored: Array<{ workspace: ZeusTaskWorkspaceRecord; prepared: Awaited<ReturnType<typeof prepareTaskWorktree>> }> = [];
      try {
        for (const workspace of members) {
          if (workspace.state === 'merged' || workspace.state === 'discarded') throw nativeApiError('ZEUS_TASK_WORKSPACE_CLOSED', `Task repository workspace is closed: ${workspace.repositoryRelativePath}`);
          const repositoryPath = workspace.repositoryPath || project.localPath;
          const prepared = await prepareTaskWorktree({
            repositoryPath,
            projectSlug: project.slug,
            taskCode: task.taskCode,
            taskTitle: task.title,
            workspaceId: workspace.id,
            branchName: workspace.branchName,
            sourceRef: workspace.sourceHeadSha,
            existingBranch: true,
            ...(workspace.remoteName ? { existingRemoteRef: `${workspace.remoteName}/${workspace.remoteBranch}` } : {}),
            ...(environment.rootPath && workspace.repositoryRelativePath ? { worktreePath: join(environment.rootPath, workspace.repositoryRelativePath) } : {}),
          });
          restored.push({ workspace, prepared });
        }
      } catch (error) {
        for (const entry of [...restored].reverse()) {
          if (entry.prepared.reused) continue;
          await cleanupPreparedTaskWorktree({
            repositoryPath: entry.workspace.repositoryPath || project.localPath,
            worktreePath: entry.prepared.worktreePath,
            branchName: entry.workspace.branchName,
            removeBranch: false,
          }).catch(() => undefined);
        }
        throw error;
      }
      const updated = restored.map(({ workspace, prepared }) => taskWorkspaces.update(workspace.id, { worktreePath: prepared.worktreePath, headSha: prepared.headSha, state: 'ready', lastError: null }));
      await db.save();
      const cwd = environment.rootPath ?? project.localPath;
      return { environment, workspaces: updated, cwd, writableRoots: resolveTaskEnvironmentWritableRoots(project, updated) };
    }

    const registeredRepositories = projectRepositories.listByProject(project.id);
    if (registeredRepositories.length === 0) {
      throw nativeApiError('ZEUS_WORKTREE_REPOSITORY_REQUIRED', 'No Git repository was found in the project directory. Initialize a repository or use the project directory directly.');
    }
    const requestedRepositoryRevision = typeof selection.repositoryRevision === 'string' ? selection.repositoryRevision.trim() : '';
    if (!requestedRepositoryRevision || requestedRepositoryRevision !== taskPushRepositoryRevision(registeredRepositories)) {
      throw nativeApiError('ZEUS_TASK_REPOSITORY_SNAPSHOT_CHANGED', 'Project repositories changed after the task push form was opened. Refresh the repository selection and try again.');
    }
    const requestedRepositories = Array.isArray(selection.repositories) ? selection.repositories : [];
    if (registeredRepositories.length !== requestedRepositories.length) {
      throw nativeApiError('ZEUS_TASK_REPOSITORY_SELECTION_INCOMPLETE', 'Every registered project repository requires an explicit source branch.');
    }
    const requestedById = new Map<string, Record<string, unknown>>();
    for (const requested of requestedRepositories) {
      if (!isNativeApiRecord(requested) || typeof requested.repositoryId !== 'string' || requestedById.has(requested.repositoryId)) {
        throw nativeApiError('ZEUS_TASK_REPOSITORY_SELECTION_INVALID', 'Task repository selections must be explicit and unique.');
      }
      requestedById.set(requested.repositoryId, requested);
    }

    const reservedEnvironmentId = `task_environment_${createHash('sha256').update(`${stableOperationId}\0environment`).digest('hex').slice(0, 24)}`;
    const existingReserved = taskEnvironments.getById(reservedEnvironmentId);
    if (existingReserved) {
      return resolveTaskPushEnvironment(project, task, { mode: 'existing', environmentId: existingReserved.id }, stableOperationId);
    }
    const environmentRoot = registeredRepositories.length > 0 ? buildTaskEnvironmentRootPath(project.localPath, project.slug, task.taskCode, reservedEnvironmentId) : project.localPath;
    const preparedMembers: Array<{
      repository: ZeusProjectRepositoryRecord;
      prepared: Awaited<ReturnType<typeof prepareTaskWorktree>>;
      remoteName: string;
    }> = [];
    try {
      if (registeredRepositories.length > 0) {
        mkdirSync(environmentRoot, { recursive: true });
        mirrorTaskEnvironmentContainer(project, environmentRoot, registeredRepositories, projectSharedPaths.listByProject(project.id));
      }
      const repositoryContexts = await mapTaskRepositoriesWithConcurrency(registeredRepositories, async (registeredRepository) => {
        const projectRelativePath = relative(project.localPath, registeredRepository.localPath);
        if (projectRelativePath === '..' || projectRelativePath.startsWith(`..${sep}`) || isAbsolute(projectRelativePath)) {
          throw nativeApiError('ZEUS_PROJECT_REPOSITORY_UNAVAILABLE', `Project repository path is outside the project directory: ${registeredRepository.relativePath}`);
        }
        const repository = await getGitRepositoryContext(registeredRepository.localPath);
        if (!repository.isRepository || resolve(repository.topLevel) !== resolve(registeredRepository.localPath)) {
          throw nativeApiError('ZEUS_PROJECT_REPOSITORY_UNAVAILABLE', `Project repository is unavailable: ${registeredRepository.relativePath}`);
        }
        return repository;
      });
      const sequence = taskEnvironments.listByTask(task.id).length + 1;
      const preparations = registeredRepositories.map((registeredRepository, index) => ({
        registeredRepository,
        repository: repositoryContexts[index]!,
        targetPath: join(environmentRoot, registeredRepository.relativePath),
      }));
      const preparationLanes: (typeof preparations)[] = [];
      for (const preparation of preparations) {
        const targetPath = resolve(preparation.targetPath);
        const lane = preparationLanes.find((candidate) =>
          candidate.some((other) => {
            const otherPath = resolve(other.targetPath);
            return targetPath === otherPath || targetPath.startsWith(`${otherPath}${sep}`) || otherPath.startsWith(`${targetPath}${sep}`);
          }),
        );
        if (lane) lane.push(preparation);
        else preparationLanes.push([preparation]);
      }
      await mapTaskRepositoriesWithConcurrency(preparationLanes, async (lane) => {
        lane.sort((left, right) => resolve(left.targetPath).length - resolve(right.targetPath).length);
        for (const { registeredRepository, repository, targetPath } of lane) {
          const requested = requestedById.get(registeredRepository.id);
          if (!requested) throw nativeApiError('ZEUS_TASK_REPOSITORY_SELECTION_INCOMPLETE', `Choose a source branch for ${registeredRepository.relativePath}.`);
          const requestedSourceRef = typeof requested.sourceRef === 'string' ? requested.sourceRef.trim() : '';
          const localPrefix = 'refs/heads/';
          const remotePrefix = 'refs/remotes/';
          const sourceKind = requestedSourceRef.startsWith(remotePrefix) ? ('remote' as const) : ('local' as const);
          const sourceRef = requestedSourceRef.startsWith(localPrefix) ? requestedSourceRef.slice(localPrefix.length) : requestedSourceRef.startsWith(remotePrefix) ? requestedSourceRef.slice(remotePrefix.length) : '';
          const sourceExists = sourceKind === 'remote' ? repository.remoteBranches.includes(sourceRef) : repository.localBranches.includes(sourceRef);
          if (!sourceRef || !sourceExists) {
            throw nativeApiError('ZEUS_TASK_SOURCE_BRANCH_INVALID', `Choose an available local or locally known remote branch for ${registeredRepository.relativePath}.`);
          }
          const sourceRemoteSeparator = sourceKind === 'remote' ? sourceRef.indexOf('/') : -1;
          const sourceRemoteName = sourceRemoteSeparator > 0 ? sourceRef.slice(0, sourceRemoteSeparator) : '';
          const sourceBranch = sourceRemoteSeparator > 0 ? sourceRef.slice(sourceRemoteSeparator + 1) : sourceRef;
          const remoteName = sourceRemoteName || (repository.remotes.includes('origin') ? 'origin' : (repository.remotes[0] ?? ''));
          const branchName = typeof requested.branchName === 'string' && requested.branchName.trim() ? requested.branchName.trim() : buildTaskBranchName(task.taskCode, task.title, sequence);
          if (taskWorkspaces.getByRepositoryBranch(registeredRepository.id, branchName)) {
            throw nativeApiError('ZEUS_TASK_BRANCH_ALREADY_MANAGED', `Task branch is already managed in ${registeredRepository.relativePath}: ${branchName}`);
          }
          const workspaceId = `task_workspace_${createHash('sha256').update(`${stableOperationId}\0${registeredRepository.id}`).digest('hex').slice(0, 24)}`;
          if (resolve(targetPath) !== resolve(environmentRoot) && existsSync(targetPath)) {
            // 父仓 worktree 可能先还原出嵌套仓占位目录；这里只清理本次临时任务环境里的占位内容，再挂载真实子仓 worktree。
            rmSync(targetPath, { recursive: true, force: true });
          }
          const prepared = await prepareTaskWorktree({
            repositoryPath: registeredRepository.localPath,
            repositoryContext: repository,
            projectSlug: project.slug,
            taskCode: task.taskCode,
            taskTitle: task.title,
            workspaceId,
            branchName,
            sourceRef,
            sourceKind,
            sourceBranch,
            existingBranch: false,
            worktreePath: targetPath,
            includeLocalChanges: sourceKind === 'local' && requested.includeLocalChanges === true,
            ignoredPaths: projectRepositoryIgnoredPaths(project.id, registeredRepository.id, registeredRepository.localPath),
          });
          preparedMembers.push({ repository: registeredRepository, prepared, remoteName });
        }
      });
      preparedMembers.sort((left, right) => registeredRepositories.findIndex((repository) => repository.id === left.repository.id) - registeredRepositories.findIndex((repository) => repository.id === right.repository.id));
      overlayTaskEnvironmentSharedPaths(environmentRoot, projectSharedPaths.listByProject(project.id));
    } catch (error) {
      for (const member of [...preparedMembers].sort((left, right) => right.prepared.worktreePath.length - left.prepared.worktreePath.length)) {
        await cleanupPreparedTaskWorktree({ repositoryPath: member.repository.localPath, worktreePath: member.prepared.worktreePath, branchName: member.prepared.branchName, removeBranch: true }).catch(() => undefined);
      }
      if (registeredRepositories.length > 0) rmSync(environmentRoot, { recursive: true, force: true });
      throw error;
    }

    let environment: ZeusTaskEnvironmentRecord;
    let workspaces: ZeusTaskWorkspaceRecord[];
    try {
      ({ environment, workspaces } = db.transaction(() => {
        const createdEnvironment = taskEnvironments.create({ id: reservedEnvironmentId, projectId: project.id, taskId: task.id, rootPath: environmentRoot, state: 'ready' });
        const createdWorkspaces = preparedMembers.map(({ repository, prepared, remoteName }) =>
          taskWorkspaces.create({
            id: `task_workspace_${createHash('sha256').update(`${stableOperationId}\0${repository.id}`).digest('hex').slice(0, 24)}`,
            projectId: project.id,
            taskId: task.id,
            environmentId: createdEnvironment.id,
            repositoryId: repository.id,
            repositoryName: repository.name,
            repositoryRelativePath: repository.relativePath,
            repositoryPath: repository.localPath,
            branchName: prepared.branchName,
            sourceBranch: prepared.sourceBranch,
            sourceHeadSha: prepared.sourceHeadSha,
            remoteName,
            remoteBranch: prepared.branchName,
            worktreePath: prepared.worktreePath,
            headSha: prepared.headSha,
            state: 'ready',
          }),
        );
        return { environment: createdEnvironment, workspaces: createdWorkspaces };
      }));
    } catch (error) {
      for (const member of [...preparedMembers].sort((left, right) => right.prepared.worktreePath.length - left.prepared.worktreePath.length)) {
        await cleanupPreparedTaskWorktree({ repositoryPath: member.repository.localPath, worktreePath: member.prepared.worktreePath, branchName: member.prepared.branchName, removeBranch: true }).catch(() => undefined);
      }
      if (registeredRepositories.length > 0) rmSync(environmentRoot, { recursive: true, force: true });
      throw error;
    }
    recordTaskEvent({
      taskId: task.id,
      eventType: 'task.environment.created',
      title: registeredRepositories.length > 0 ? '多仓任务环境已创建' : '非 Git 任务环境已创建',
      payload: {
        environmentId: environment.id,
        rootPath: environment.rootPath,
        repositories: workspaces.map((workspace) => ({
          workspaceId: workspace.id,
          repositoryId: workspace.repositoryId,
          relativePath: workspace.repositoryRelativePath,
          branchName: workspace.branchName,
          sourceBranch: workspace.sourceBranch,
          localChangesApplied: preparedMembers.find((member) => member.repository.id === workspace.repositoryId)?.prepared.localChangesApplied ?? false,
        })),
      },
    });
    await db.save();
    return { environment, workspaces, cwd: environmentRoot, writableRoots: resolveTaskEnvironmentWritableRoots(project, workspaces) };
  }

  function assertTaskEnvironmentWritable(environment: ZeusTaskEnvironmentRecord): void {
    if (taskEnvironmentHasActiveWritableConversation(environment.id)) {
      throw nativeApiError('ZEUS_TASK_ENVIRONMENT_BUSY', 'The selected task environment already has an active writable Codex turn.');
    }
  }

  function taskEnvironmentHasActiveWritableConversation(environmentId: string): boolean {
    return conversations.listByEnvironment(environmentId).some((conversation) => conversation.providerState === 'binding' || conversation.providerState === 'active' || conversation.providerState === 'waiting');
  }

  /** 父子仓库的代码交付互不联动，但物理目录回收必须先子后父。 */
  function assertNestedTaskWorktreesReclaimed(workspace: ZeusTaskWorkspaceRecord): void {
    const nested = nestedTaskWorkspacesWithWorktree(workspace);
    if (nested.length === 0) return;
    throw nativeApiError('ZEUS_TASK_WORKSPACE_NESTED_BUSY', `请先回收嵌套仓库的 Worktree：${nested.map((entry) => entry.repositoryRelativePath).join('、')}`);
  }

  function nestedTaskWorkspacesWithWorktree(workspace: ZeusTaskWorkspaceRecord): ZeusTaskWorkspaceRecord[] {
    if (!workspace.environmentId || !workspace.worktreePath) return [];
    return taskWorkspaces.listByEnvironment(workspace.environmentId).filter((candidate) => candidate.id !== workspace.id && Boolean(candidate.worktreePath) && isPathInsideRoot(candidate.worktreePath!, workspace.worktreePath!));
  }

  /** 任务分支本地合入来源分支后回收干净任务目录；清理失败不能反写成合入失败。 */
  async function markTaskWorkspaceDelivered(workspace: ZeusTaskWorkspaceRecord): Promise<boolean> {
    if (workspace.kind === 'conflict') {
      taskWorkspaces.update(workspace.id, { state: 'ready', lastError: null });
      return false;
    }
    if (!workspace.worktreePath) {
      taskWorkspaces.update(workspace.id, { state: 'merged', lastError: null });
      reconcileTaskEnvironmentState(workspace.environmentId);
      return false;
    }
    const nested = nestedTaskWorkspacesWithWorktree(workspace);
    if (nested.length > 0) {
      taskWorkspaces.update(workspace.id, {
        state: 'merged',
        lastError: `来源分支已完成本地合入；等待嵌套仓库 Worktree 先回收：${nested.map((entry) => entry.repositoryRelativePath).join('、')}`,
      });
      return false;
    }
    try {
      const reclaimed = await reclaimDeliveredTaskWorktree({
        repositoryPath: workspace.repositoryPath || projects.getById(workspace.projectId)?.localPath || '',
        worktreePath: workspace.worktreePath,
        ignoredPaths: taskWorkspaceIgnoredPaths(workspace),
      });
      taskWorkspaces.update(workspace.id, {
        worktreePath: null,
        headSha: reclaimed.headSha,
        state: 'merged',
        lastError: null,
      });
      await reclaimDeferredDeliveredAncestors(workspace.environmentId);
      reconcileTaskEnvironmentState(workspace.environmentId);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Task worktree cleanup failed.';
      taskWorkspaces.update(workspace.id, {
        state: 'merged',
        lastError: `来源分支已交付，但任务 worktree 回收失败：${message}`,
      });
      return false;
    }
  }

  /** 子仓库回收后，自动补收已经交付但此前因目录嵌套而保留的父仓库。 */
  async function reclaimDeferredDeliveredAncestors(environmentId: string | null): Promise<void> {
    if (!environmentId) return;
    const candidates = taskWorkspaces
      .listByEnvironment(environmentId)
      .filter((workspace) => workspace.state === 'merged' && workspace.worktreePath)
      .sort((left, right) => right.repositoryRelativePath.split('/').length - left.repositoryRelativePath.split('/').length);
    for (const candidate of candidates) {
      if (!candidate.worktreePath || nestedTaskWorkspacesWithWorktree(candidate).length > 0) continue;
      try {
        const reclaimed = await reclaimDeliveredTaskWorktree({
          repositoryPath: candidate.repositoryPath || projects.getById(candidate.projectId)?.localPath || '',
          worktreePath: candidate.worktreePath,
          ignoredPaths: taskWorkspaceIgnoredPaths(candidate),
        });
        taskWorkspaces.update(candidate.id, { worktreePath: null, headSha: reclaimed.headSha, lastError: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Task worktree cleanup failed.';
        taskWorkspaces.update(candidate.id, { lastError: `来源分支已交付，但任务 worktree 回收失败：${message}` });
      }
    }
  }

  /** 仅当环境内所有仓库都完成交付、放弃或无变化回收后，才回收聚合目录。 */
  function reconcileTaskEnvironmentState(environmentId: string | null): void {
    if (!environmentId) return;
    const environment = taskEnvironments.getById(environmentId);
    if (!environment) return;
    const members = taskWorkspaces.listByEnvironment(environment.id);
    if (members.length === 0 || members.some((workspace) => workspace.worktreePath || !['reclaimed', 'merged', 'discarded'].includes(workspace.state))) return;
    const project = projects.getById(environment.projectId);
    if (environment.rootPath && project && resolve(environment.rootPath) !== resolve(project.localPath)) {
      rmSync(environment.rootPath, { recursive: true, force: true });
    }
    taskEnvironments.update(environment.id, { rootPath: null, state: 'reclaimed', lastError: null });
  }

  function countTaskWorkspaceActiveConversations(workspace: ZeusTaskWorkspaceRecord): number {
    let count = 0;
    for (const conversation of listTaskWorkspaceConversations(workspace)) {
      const hasPendingWrite = conversationSubmissions.listByConversation(conversation.id).some((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active');
      const providerBusy = conversation.providerState === 'binding' || conversation.providerState === 'active' || conversation.providerState === 'waiting';
      if (hasPendingWrite || providerBusy) count += 1;
    }
    return count;
  }

  /** 共享目录直接引用真实路径，不应作为所属仓库 worktree 的代码变化进入提交与回收门禁。 */
  function taskWorkspaceIgnoredPaths(workspace: ZeusTaskWorkspaceRecord): string[] {
    const repositoryPath = workspace.repositoryPath;
    if (!repositoryPath) return [];
    return projectRepositoryIgnoredPaths(workspace.projectId, workspace.repositoryId, repositoryPath);
  }

  function projectRepositoryIgnoredPaths(projectId: string, repositoryId: string | null, repositoryPath: string): string[] {
    const nestedRepositories = projectRepositories
      .listByProject(projectId)
      .filter((entry) => entry.id !== repositoryId && isPathInsideRoot(entry.localPath, repositoryPath))
      .map((entry) => entry.localPath);
    const sharedPaths = projectSharedPaths
      .listByProject(projectId)
      .filter((entry) => isPathInsideRoot(entry.localPath, repositoryPath))
      .map((entry) => entry.localPath);
    return Array.from(new Set([...nestedRepositories, ...sharedPaths].map((localPath) => relative(repositoryPath, localPath).split(sep).join('/')).filter((path) => Boolean(path) && path !== '.')));
  }

  function readTaskWorkspaceReview(workspace: ZeusTaskWorkspaceRecord, repositoryContext?: GitRepositoryContext) {
    if (!workspace.worktreePath) throw nativeApiError('ZEUS_TASK_WORKTREE_UNAVAILABLE', 'Task worktree is not available.');
    return getTaskWorkspaceReview(workspace.worktreePath, taskWorkspaceIgnoredPaths(workspace), repositoryContext);
  }

  function summarizeBatchTaskWorkspaceResults(items: BatchTaskWorkspaceResult[]): { succeeded: number; skipped: number; failed: number } {
    return items.reduce(
      (summary, item) => {
        summary[item.status] += 1;
        return summary;
      },
      { succeeded: 0, skipped: 0, failed: 0 },
    );
  }

  async function readTaskWorkspaceSnapshot(project: ZeusProjectRecord, workspace: ZeusTaskWorkspaceRecord): Promise<Record<string, unknown>> {
    const repositoryPath = workspace.repositoryPath || project.localPath;
    const repository = await getGitRepositoryContext(repositoryPath);
    if (!repository.isRepository) throw nativeApiError('ZEUS_PROJECT_REPOSITORY_UNAVAILABLE', `Project repository is unavailable: ${workspace.repositoryRelativePath}`);
    const capture = async <Value>(promise: Promise<Value>): Promise<{ value: Value | null; error?: string }> => {
      try {
        return { value: await promise };
      } catch (error) {
        return { value: null, error: error instanceof Error ? error.message : 'Git state read failed.' };
      }
    };
    const closed = !workspace.worktreePath || workspace.state === 'reclaimed' || workspace.state === 'merged' || workspace.state === 'discarded';
    const [comparison, review, remoteHeadSha, sourceLocalHeadSha, sourceRemoteHeadSha] = await Promise.all([
      capture(getTaskBranchComparison(repositoryPath, workspace.sourceBranch, workspace.branchName, workspace.sourceHeadSha, repository)),
      closed ? capture(Promise.resolve(null)) : capture(readTaskWorkspaceReview(workspace)),
      workspace.remoteName ? getRemoteTrackingBranchHead(repositoryPath, workspace.remoteName, workspace.remoteBranch) : Promise.resolve(null),
      getGitBranchHead(repositoryPath, workspace.sourceBranch, repository).catch(() => null),
      workspace.remoteName ? getRemoteTrackingBranchHead(repositoryPath, workspace.remoteName, workspace.sourceBranch) : Promise.resolve(null),
    ]);
    const expectedHeadSha = comparison.value?.taskHeadSha ?? workspace.headSha;
    return {
      ...workspace,
      activeConversationCount: countTaskWorkspaceActiveConversations(workspace),
      review: review.value,
      branchComparison: comparison.value,
      remoteHeadSha,
      remoteVerified: Boolean(expectedHeadSha && remoteHeadSha === expectedHeadSha),
      remoteRefreshError: null,
      sourceLocalHeadSha,
      sourceRemoteHeadSha,
      sourceRemoteVerified: Boolean(sourceLocalHeadSha && sourceRemoteHeadSha === sourceLocalHeadSha),
      primaryBranch: repository.branch || null,
      localBranches: repository.localBranches,
      targetBranches: repository.localBranches,
      ...(review.error ? { reviewError: review.error } : {}),
      ...(comparison.error ? { comparisonError: comparison.error } : {}),
    };
  }

  function unavailableTaskWorkspaceSnapshot(workspace: ZeusTaskWorkspaceRecord, error: unknown): Record<string, unknown> {
    const message = error instanceof Error ? error.message : 'Task workspace repository is unavailable.';
    return {
      ...workspace,
      activeConversationCount: countTaskWorkspaceActiveConversations(workspace),
      review: null,
      branchComparison: null,
      remoteHeadSha: null,
      remoteVerified: false,
      remoteRefreshError: null,
      sourceLocalHeadSha: null,
      sourceRemoteHeadSha: null,
      sourceRemoteVerified: false,
      primaryBranch: null,
      localBranches: [],
      targetBranches: [],
      reviewError: message,
      comparisonError: message,
    };
  }

  function listTaskWorkspaceConversations(workspace: ZeusTaskWorkspaceRecord): ZeusConversationWithMessagesRecord[] {
    return workspace.environmentId ? conversations.listByEnvironment(workspace.environmentId) : conversations.listByWorkspace(workspace.id);
  }

  async function inspectTaskTerminalCleanup(taskId: string, fallbackRepositoryPath: string) {
    const workspacePlans = await Promise.all(
      taskWorkspaces
        .listByTask(taskId)
        .filter((workspace) => workspace.kind !== 'conflict')
        .map(async (workspace) => {
          if (!workspace.worktreePath) return { workspace, repositoryPath: workspace.repositoryPath || fallbackRepositoryPath, headSha: workspace.headSha, force: false };
          try {
            const review = await readTaskWorkspaceReview(workspace);
            return {
              workspace,
              repositoryPath: workspace.repositoryPath || fallbackRepositoryPath,
              headSha: review.headSha,
              force: !review.clean,
            };
          } catch {
            // 无法读取的任务目录不能被当作干净目录；只有用户确认后才允许强制移除。
            return { workspace, repositoryPath: workspace.repositoryPath || fallbackRepositoryPath, headSha: workspace.headSha, force: true };
          }
        }),
    );
    const taskConversations = conversations.listByTask(taskId);
    const activeConversationCount = taskConversations.filter((conversation) => taskConversationHasActiveWork(conversation)).length;
    const taskRuntimeSessions = runtimeSessions.list({ taskId, archived: false });
    const activeRuntimeSessionCount = taskRuntimeSessions.filter((session) => !runtimeSessionIsConfirmedTerminal(session)).length;
    return {
      workspaces: workspacePlans,
      conversations: taskConversations,
      runtimeSessions: taskRuntimeSessions,
      activeConversationCount,
      activeRuntimeSessionCount,
      requiresConfirmation: workspacePlans.some((entry) => entry.force) || activeConversationCount > 0 || activeRuntimeSessionCount > 0,
    };
  }

  function taskConversationHasActiveWork(conversation: ZeusConversationWithMessagesRecord): boolean {
    const hasPendingWrite = conversationSubmissions.listByConversation(conversation.id).some((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active');
    const providerBusy = conversation.providerState === 'binding' || conversation.providerState === 'active' || conversation.providerState === 'waiting';
    return hasPendingWrite || providerBusy;
  }

  async function closeTaskResourcesForTerminalStatus(taskId: string, cleanup: Awaited<ReturnType<typeof inspectTaskTerminalCleanup>>): Promise<void> {
    const activeRuntimeSessions = cleanup.runtimeSessions.filter((session) => !runtimeSessionIsConfirmedTerminal(session));
    if (activeRuntimeSessions.length > 0) {
      const persistedOnly: string[] = [];
      for (const session of activeRuntimeSessions) {
        const managed = aiRuntimeManager.getSession(session.id);
        if (!managed) {
          persistedOnly.push(session.id);
          continue;
        }
        if (managed.status === 'running') {
          aiRuntimeManager.stopSession(session.id);
          aiRuntimeManager.killSession(session.id, 'SIGKILL');
        } else if (managed.status === 'orphan_detected') {
          aiRuntimeManager.stopSession(session.id);
        } else {
          aiRuntimeManager.killSession(session.id, 'SIGKILL');
        }
      }
      const persistedHint = persistedOnly.length > 0 ? `；以下跨重启会话需先在 Runtime 中单独停止：${persistedOnly.join('、')}` : '';
      throw nativeApiError('ZEUS_TASK_RUNTIME_CLEANUP_BUSY', `已向活动 Runtime 发出终止请求，请等待进程树进入确认终态后重试任务状态变更${persistedHint}`);
    }

    let interrupted = 0;
    let cancelled = 0;
    for (const conversation of cleanup.conversations) {
      const activeTurn = [...conversationTurns.listByConversation(conversation.id)].reverse().find((turn) => (turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching') && turn.providerTurnId);
      if (activeTurn?.providerTurnId) {
        try {
          await codexNativeCoordinator.interruptTurn({ conversationId: conversation.id, providerTurnId: activeTurn.providerTurnId });
          interrupted += 1;
        } catch (error) {
          const code = error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string' ? String((error as Error & { code: string }).code) : '';
          if (code !== 'ZEUS_NATIVE_TURN_NOT_ACTIVE') throw error;
        }
      }
      for (const submission of conversationSubmissions.listByConversation(conversation.id)) {
        const cancellable = submission.status === 'queued' || submission.status === 'paused' || submission.status === 'failed' || ((submission.status === 'dispatching' || submission.status === 'active') && !submission.providerTurnId);
        if (!cancellable) continue;
        conversationSubmissions.updateStatus(submission.id, 'cancelled', { resolvedAt: new Date().toISOString() });
        cancelled += 1;
      }
    }

    let removedWorktrees = 0;
    const environmentIds = new Set<string>();
    const workspacePlans = [...cleanup.workspaces].sort((left, right) => right.workspace.repositoryRelativePath.split('/').length - left.workspace.repositoryRelativePath.split('/').length);
    for (const plan of workspacePlans) {
      if (plan.workspace.worktreePath) {
        const result = await removeTaskWorktreeForTerminalStatus({
          repositoryPath: plan.repositoryPath,
          worktreePath: plan.workspace.worktreePath,
          force: plan.force || taskWorkspaceIgnoredPaths(plan.workspace).length > 0,
        });
        if (result.removed) removedWorktrees += 1;
      }
      const terminalState = plan.workspace.state === 'merged' || plan.workspace.state === 'discarded' ? plan.workspace.state : 'reclaimed';
      taskWorkspaces.update(plan.workspace.id, {
        worktreePath: null,
        headSha: plan.headSha,
        state: terminalState,
        lastError: null,
      });
      if (plan.workspace.environmentId) environmentIds.add(plan.workspace.environmentId);
    }
    for (const environmentId of environmentIds) reconcileTaskEnvironmentState(environmentId);

    for (const conversation of cleanup.conversations) conversations.archive(conversation.id);
    for (const session of cleanup.runtimeSessions) {
      const latest = runtimeSessions.getById(session.id);
      if (!latest) continue;
      if (!runtimeSessionIsConfirmedTerminal(latest)) throw new Error(`Runtime 会话 ${latest.id} 的进程树尚未确认退出，不能归档任务资源。`);
      runtimeSessions.archive(session.id);
    }
    recordTaskEvent({
      taskId,
      eventType: 'task.terminal_resources.cleaned',
      title: '任务终态资源已清理',
      payload: {
        removedWorktrees,
        archivedConversations: cleanup.conversations.length,
        archivedRuntimeSessions: cleanup.runtimeSessions.length,
        interrupted,
        cancelled,
      },
    });
  }

  function resolveTaskWorkspaceRequest(taskId: string, workspaceId: string): { task: ZeusTaskRecord; project: ZeusProjectRecord; workspace: ZeusTaskWorkspaceRecord } | { status: 404; error: { error: string; message: string } } {
    const task = tasks.getById(taskId);
    if (!task) return { status: 404, error: { error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' } };
    const project = projects.getById(task.projectId);
    if (!project) return { status: 404, error: { error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' } };
    const workspace = taskWorkspaces.getById(workspaceId);
    if (!workspace || workspace.taskId !== task.id || workspace.projectId !== project.id) {
      return { status: 404, error: { error: 'ZEUS_TASK_WORKSPACE_NOT_FOUND', message: 'Task workspace not found' } };
    }
    return { task, project, workspace };
  }

  function resolveTaskIntegrationRequest(
    taskId: string,
    integrationId: string,
  ): { task: ZeusTaskRecord; project: ZeusProjectRecord; workspace: ZeusTaskWorkspaceRecord; integration: ZeusTaskIntegrationRecord } | { status: 404; error: { error: string; message: string } } {
    const task = tasks.getById(taskId);
    if (!task) return { status: 404, error: { error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' } };
    const project = projects.getById(task.projectId);
    if (!project) return { status: 404, error: { error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' } };
    const integration = taskIntegrations.getById(integrationId);
    if (!integration || integration.taskId !== task.id || integration.projectId !== project.id) {
      return { status: 404, error: { error: 'ZEUS_TASK_INTEGRATION_NOT_FOUND', message: 'Task integration not found' } };
    }
    const workspace = taskWorkspaces.getById(integration.workspaceId);
    if (!workspace) return { status: 404, error: { error: 'ZEUS_TASK_WORKSPACE_NOT_FOUND', message: 'Task workspace not found' } };
    return { task, project, workspace, integration };
  }

  async function prepareWorkspaceGitCommand(input: {
    commandType: WorkspaceGitCommandType;
    operationIdentity: string;
    projectId?: string;
    taskId?: string;
    repositoryId?: string;
    workspaceId?: string;
    integrationId?: string;
    value: Record<string, unknown>;
  }): Promise<PreparedWorkspaceGitCommand> {
    const opaque: WorkspaceGitPreparedOpaque = {};
    let resourceId = '';
    if (input.commandType === workspaceGitCommandTypes.workbenchAction || input.commandType === workspaceGitCommandTypes.taskPushRepositoryRefreshRemote) {
      const projectId = requireWorkspaceGitIdentity(input.projectId, 'projectId');
      const repositoryId = requireWorkspaceGitIdentity(input.repositoryId, 'repositoryId');
      const project = projects.getById(projectId);
      if (!project) workspaceGitReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
      const repository = projectRepositories.getById(repositoryId);
      if (!repository || repository.projectId !== project.id) workspaceGitReject(404, 'ZEUS_PROJECT_REPOSITORY_NOT_FOUND', 'Project repository not found');
      opaque.projectId = project.id;
      opaque.repositoryId = repository.id;
      resourceId = `git_repository:${repository.id}`;
      if (input.commandType === workspaceGitCommandTypes.workbenchAction) {
        try {
          parseProjectGitAction(input.value);
        } catch (error) {
          workspaceGitReject(400, taskGitErrorCode(error), error instanceof Error ? error.message : 'A supported Git action is required.');
        }
      }
      if (input.commandType === workspaceGitCommandTypes.taskPushRepositoryRefreshRemote) {
        const taskId = requireWorkspaceGitIdentity(input.value.taskId, 'taskId');
        const task = tasks.getById(taskId);
        if (!task || task.projectId !== project.id) workspaceGitReject(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found');
        opaque.taskId = task.id;
      }
    } else if (input.commandType === workspaceGitCommandTypes.taskWorkspaceCommitAll || input.commandType === workspaceGitCommandTypes.taskWorkspacePushAll) {
      const taskId = requireWorkspaceGitIdentity(input.taskId, 'taskId');
      const task = tasks.getById(taskId);
      if (!task) workspaceGitReject(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found');
      if (!projects.getById(task.projectId)) workspaceGitReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
      opaque.taskId = task.id;
      resourceId = `task:${task.id}`;
    } else if (
      input.commandType === workspaceGitCommandTypes.taskWorkspaceCommit ||
      input.commandType === workspaceGitCommandTypes.taskWorkspacePush ||
      input.commandType === workspaceGitCommandTypes.taskWorkspaceStopSessions ||
      input.commandType === workspaceGitCommandTypes.taskWorkspaceReclaim ||
      input.commandType === workspaceGitCommandTypes.taskWorkspaceDiscard ||
      input.commandType === workspaceGitCommandTypes.taskWorkspaceIntegrate
    ) {
      const taskId = requireWorkspaceGitIdentity(input.taskId, 'taskId');
      const workspaceId = requireWorkspaceGitIdentity(input.workspaceId, 'workspaceId');
      const resolved = resolveTaskWorkspaceRequest(taskId, workspaceId);
      if ('error' in resolved) workspaceGitReject(resolved.status, resolved.error.error, resolved.error.message);
      opaque.taskId = resolved.task.id;
      opaque.workspaceId = resolved.workspace.id;
      resourceId = `task_workspace:${resolved.workspace.id}`;
    } else if (
      input.commandType === workspaceGitCommandTypes.taskIntegrationConflictAiSession ||
      input.commandType === workspaceGitCommandTypes.taskIntegrationConflictResolve ||
      input.commandType === workspaceGitCommandTypes.taskIntegrationFinalize ||
      input.commandType === workspaceGitCommandTypes.taskIntegrationPush
    ) {
      const taskId = requireWorkspaceGitIdentity(input.taskId, 'taskId');
      const integrationId = requireWorkspaceGitIdentity(input.integrationId, 'integrationId');
      const resolved = resolveTaskIntegrationRequest(taskId, integrationId);
      if ('error' in resolved) workspaceGitReject(resolved.status, resolved.error.error, resolved.error.message);
      opaque.taskId = resolved.task.id;
      opaque.integrationId = resolved.integration.id;
      resourceId = `task_integration:${resolved.integration.id}`;
    } else if (input.commandType === workspaceGitCommandTypes.projectSnapshotCreate || input.commandType === workspaceGitCommandTypes.projectPatchExport) {
      const projectId = requireWorkspaceGitIdentity(input.projectId, 'projectId');
      const project = projects.getById(projectId);
      if (!project) workspaceGitReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
      opaque.projectId = project.id;
      resourceId = `git_repository:project:${project.id}`;
      if (input.commandType === workspaceGitCommandTypes.projectSnapshotCreate) {
        const taskId = requireWorkspaceGitIdentity(input.value.taskId, 'taskId');
        const task = tasks.getById(taskId);
        if (!task || task.projectId !== project.id) workspaceGitReject(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found for this project');
        opaque.taskId = task.id;
      }
    } else {
      workspaceGitReject(400, 'ZEUS_WORKSPACE_GIT_COMMAND_INVALID', `Unsupported Workspace Git command: ${input.commandType}`);
    }
    const externalOperationId = `workspace_git_${createHash('sha256').update(`${input.commandType}\0${resourceId}\0${input.operationIdentity}`).digest('hex')}`;
    return { destinationId: 'workspace-git-command-application', resourceId, externalOperationId, opaque };
  }

  async function executeWorkspaceGitCommand(input: { commandType: WorkspaceGitCommandType; operationIdentity: string; prepared: PreparedWorkspaceGitCommand; value: Record<string, unknown> }): Promise<WorkspaceGitRouteExecution> {
    const opaque = input.prepared.opaque as WorkspaceGitPreparedOpaque;
    switch (input.commandType) {
      case workspaceGitCommandTypes.workbenchAction:
        return executeWorkspaceGitWorkbenchAction(opaque, input.value);
      case workspaceGitCommandTypes.taskWorkspaceCommitAll:
        return executeWorkspaceGitCommitAll(opaque, input.value);
      case workspaceGitCommandTypes.taskWorkspacePushAll:
        return executeWorkspaceGitPushAll(opaque);
      case workspaceGitCommandTypes.taskWorkspaceCommit:
        return executeSingleTaskWorkspaceCommit(opaque, input.value);
      case workspaceGitCommandTypes.taskWorkspacePush:
        return executeSingleTaskWorkspacePush(opaque);
      case workspaceGitCommandTypes.taskWorkspaceStopSessions:
        return executeTaskWorkspaceStopSessions(opaque);
      case workspaceGitCommandTypes.taskWorkspaceReclaim:
        return executeTaskWorkspaceReclaim(opaque);
      case workspaceGitCommandTypes.taskWorkspaceDiscard:
        return executeTaskWorkspaceDiscard(opaque, input.value);
      case workspaceGitCommandTypes.taskWorkspaceIntegrate:
        return executeTaskWorkspaceIntegration(opaque, input.value, input.operationIdentity);
      case workspaceGitCommandTypes.taskIntegrationConflictAiSession:
        return executeTaskIntegrationConflictAiSession(opaque, input.value, input.operationIdentity);
      case workspaceGitCommandTypes.taskIntegrationConflictResolve:
        return executeTaskIntegrationConflictResolve(opaque, input.value);
      case workspaceGitCommandTypes.taskIntegrationFinalize:
        return executeTaskIntegrationFinalize(opaque);
      case workspaceGitCommandTypes.taskIntegrationPush:
        return executeTaskIntegrationPush(opaque);
      case workspaceGitCommandTypes.projectSnapshotCreate:
        return executeProjectGitSnapshotCommand(opaque);
      case workspaceGitCommandTypes.projectPatchExport:
        return executeProjectGitPatchCommand(opaque);
      case workspaceGitCommandTypes.taskPushRepositoryRefreshRemote:
        return executeTaskPushRepositoryRefreshRemoteCommand(opaque);
    }
  }

  function requireWorkspaceGitIdentity(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) workspaceGitReject(400, 'ZEUS_WORKSPACE_GIT_COMMAND_INVALID', `${field} is required`);
    return value.trim();
  }

  function workspaceGitReject(statusCode: number, code: string, message: string): never {
    throw Object.assign(new Error(message), {
      workspaceGitExplicitRejection: true as const,
      statusCode,
      payload: { error: code, message },
    }) satisfies WorkspaceGitExplicitRejection;
  }

  function isWorkspaceGitExplicitRejection(error: unknown): error is WorkspaceGitExplicitRejection {
    return Boolean(error) && typeof error === 'object' && (error as { workspaceGitExplicitRejection?: unknown }).workspaceGitExplicitRejection === true;
  }

  function sendWorkspaceGitCommandError(reply: FastifyReply, error: unknown): unknown {
    if (isWorkspaceGitExplicitRejection(error)) return reply.code(error.statusCode).send(error.payload);
    return sendNativeConversationApiError(reply, error);
  }

  function workspaceGitResponse(body: unknown, statusCode = 200, commitAccepted?: () => void): WorkspaceGitRouteExecution {
    return { response: { statusCode, body }, ...(commitAccepted ? { commitAccepted } : {}) };
  }

  function requirePreparedProject(opaque: WorkspaceGitPreparedOpaque): ZeusProjectRecord {
    const project = opaque.projectId ? projects.getById(opaque.projectId) : null;
    if (!project) workspaceGitReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
    return project;
  }

  function requirePreparedTask(opaque: WorkspaceGitPreparedOpaque): ZeusTaskRecord {
    const task = opaque.taskId ? tasks.getById(opaque.taskId) : null;
    if (!task) workspaceGitReject(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found');
    return task;
  }

  function requirePreparedWorkspace(opaque: WorkspaceGitPreparedOpaque) {
    const resolved = resolveTaskWorkspaceRequest(requireWorkspaceGitIdentity(opaque.taskId, 'taskId'), requireWorkspaceGitIdentity(opaque.workspaceId, 'workspaceId'));
    if ('error' in resolved) workspaceGitReject(resolved.status, resolved.error.error, resolved.error.message);
    return resolved;
  }

  function requirePreparedIntegration(opaque: WorkspaceGitPreparedOpaque) {
    const resolved = resolveTaskIntegrationRequest(requireWorkspaceGitIdentity(opaque.taskId, 'taskId'), requireWorkspaceGitIdentity(opaque.integrationId, 'integrationId'));
    if ('error' in resolved) workspaceGitReject(resolved.status, resolved.error.error, resolved.error.message);
    return resolved;
  }

  async function executeWorkspaceGitWorkbenchAction(opaque: WorkspaceGitPreparedOpaque, value: Record<string, unknown>): Promise<WorkspaceGitRouteExecution> {
    const project = requirePreparedProject(opaque);
    const repository = opaque.repositoryId ? projectRepositories.getById(opaque.repositoryId) : null;
    if (!repository || repository.projectId !== project.id) workspaceGitReject(404, 'ZEUS_PROJECT_REPOSITORY_NOT_FOUND', 'Project repository not found');
    const action = parseProjectGitAction(value);
    const result = await executeProjectGitAction(repository.localPath, action);
    return workspaceGitResponse({
      projectId: project.id,
      repositoryId: repository.id,
      repositoryName: repository.name,
      result,
      snapshot: await getProjectGitRepositorySnapshot(repository.localPath),
    });
  }

  async function executeWorkspaceGitCommitAll(opaque: WorkspaceGitPreparedOpaque, value: Record<string, unknown>): Promise<WorkspaceGitRouteExecution> {
    const task = requirePreparedTask(opaque);
    const requestedMessage = value.message;
    if (requestedMessage !== undefined && typeof requestedMessage !== 'string') workspaceGitReject(400, 'ZEUS_GIT_COMMIT_MESSAGE_INVALID', 'message must be a string');
    const commitMessage =
      (typeof requestedMessage === 'string' ? requestedMessage.trim() : '') ||
      buildTaskCommitMessageSuggestion({
        taskType: task.taskType,
        taskCode: task.taskCode,
        taskTitle: task.title,
      });
    const operationResults = await mapTaskRepositoriesWithConcurrency(taskWorkspaces.listByTask(task.id), async (workspace) => {
      const base = { workspaceId: workspace.id, repositoryName: workspace.repositoryName, repositoryRelativePath: workspace.repositoryRelativePath };
      if (!workspace.worktreePath || workspace.state === 'discarded' || workspace.state === 'reclaimed') {
        return { publicResult: { ...base, status: 'skipped' as const, message: '任务工作区已关闭或不可用。' } };
      }
      try {
        assertNestedTaskWorktreesReclaimed(workspace);
      } catch (error) {
        return { publicResult: { ...base, status: 'failed' as const, message: error instanceof Error ? error.message : '嵌套仓库尚未回收。' } };
      }
      const review = await readTaskWorkspaceReview(workspace);
      if (review.clean) return { publicResult: { ...base, status: 'skipped' as const, message: '工作区没有可提交的变化。' } };
      const selectedPaths = [...new Set([...review.stagedFiles, ...review.unstagedFiles, ...review.untrackedFiles].map((file) => file.path))];
      const result = await commitTaskWorkspace({ cwd: workspace.worktreePath, ignoredPaths: taskWorkspaceIgnoredPaths(workspace), message: commitMessage, selectedPaths });
      return { publicResult: { ...base, status: 'succeeded' as const, message: '已提交。', headSha: result.headSha }, result, selectedPaths };
    });
    const items: BatchTaskWorkspaceResult[] = operationResults.map((operation) => operation.publicResult);
    return workspaceGitResponse({ taskId: task.id, items, summary: summarizeBatchTaskWorkspaceResults(items) }, 200, () => {
      for (const operation of operationResults) {
        if (operation.publicResult.status !== 'succeeded' || !operation.result) continue;
        const workspace = taskWorkspaces.getById(operation.publicResult.workspaceId);
        if (!workspace) continue;
        taskWorkspaces.update(workspace.id, { headSha: operation.result.headSha, state: 'ready', lastError: null });
        recordTaskEvent({ taskId: task.id, eventType: 'task.git_workspace.committed', title: '任务分支已提交', payload: { workspaceId: workspace.id, branchName: workspace.branchName, batch: true, ...operation.result } });
        appendAuditLog({
          actorType: 'local_api',
          action: 'task.git_workspace.commit',
          resourceType: 'task_workspace',
          resourceId: workspace.id,
          payload: { taskId: task.id, projectId: task.projectId, branchName: workspace.branchName, batch: true, selectedPaths: operation.selectedPaths, ...operation.result },
          createdAt: new Date().toISOString(),
        });
      }
    });
  }

  async function executeWorkspaceGitPushAll(opaque: WorkspaceGitPreparedOpaque): Promise<WorkspaceGitRouteExecution> {
    const task = requirePreparedTask(opaque);
    const operationResults = await mapTaskRepositoriesWithConcurrency(taskWorkspaces.listByTask(task.id), async (workspace) => {
      const base = { workspaceId: workspace.id, repositoryName: workspace.repositoryName, repositoryRelativePath: workspace.repositoryRelativePath };
      if (!workspace.worktreePath || workspace.state === 'discarded' || workspace.state === 'reclaimed') {
        return { publicResult: { ...base, status: 'skipped' as const, message: '任务工作区已关闭或不可用。' } };
      }
      if (!workspace.remoteName) return { publicResult: { ...base, status: 'skipped' as const, message: '仓库没有可用远端。' } };
      const result = await pushTaskWorkspace({ cwd: workspace.worktreePath, ignoredPaths: taskWorkspaceIgnoredPaths(workspace), remoteName: workspace.remoteName, remoteBranch: workspace.remoteBranch });
      return { publicResult: { ...base, status: 'succeeded' as const, message: '已推送并校验远端提交。', headSha: result.headSha }, result };
    });
    const items: BatchTaskWorkspaceResult[] = operationResults.map((operation) => operation.publicResult);
    return workspaceGitResponse({ taskId: task.id, items, summary: summarizeBatchTaskWorkspaceResults(items) }, 200, () => {
      for (const operation of operationResults) {
        if (operation.publicResult.status !== 'succeeded' || !operation.result) continue;
        const workspace = taskWorkspaces.getById(operation.publicResult.workspaceId);
        if (!workspace) continue;
        taskWorkspaces.update(workspace.id, { headSha: operation.result.headSha, state: 'ready', lastError: null });
        recordTaskEvent({ taskId: task.id, eventType: 'task.git_workspace.pushed', title: '任务分支已推送', payload: { workspaceId: workspace.id, branchName: workspace.branchName, batch: true, ...operation.result } });
        appendAuditLog({
          actorType: 'local_api',
          action: 'task.git_workspace.push',
          resourceType: 'task_workspace',
          resourceId: workspace.id,
          payload: { taskId: task.id, projectId: task.projectId, branchName: workspace.branchName, batch: true, ...operation.result },
          createdAt: new Date().toISOString(),
        });
      }
    });
  }

  async function executeSingleTaskWorkspaceCommit(opaque: WorkspaceGitPreparedOpaque, value: Record<string, unknown>): Promise<WorkspaceGitRouteExecution> {
    const { task, workspace } = requirePreparedWorkspace(opaque);
    try {
      assertNestedTaskWorktreesReclaimed(workspace);
    } catch (error) {
      workspaceGitReject(409, taskGitErrorCode(error), error instanceof Error ? error.message : '嵌套仓库尚未回收。');
    }
    if (!workspace.worktreePath) workspaceGitReject(409, 'ZEUS_TASK_WORKTREE_UNAVAILABLE', 'Task worktree is not available.');
    if (value.message !== undefined && typeof value.message !== 'string') workspaceGitReject(400, 'ZEUS_GIT_COMMIT_MESSAGE_INVALID', 'message must be a string');
    if (value.selectedPaths !== undefined && (!Array.isArray(value.selectedPaths) || !value.selectedPaths.every((path) => typeof path === 'string'))) {
      workspaceGitReject(400, 'ZEUS_GIT_PATH_INVALID', 'selectedPaths must be an array of strings');
    }
    const selectedPaths = (value.selectedPaths as string[] | undefined) ?? [];
    const result = await commitTaskWorkspace({
      cwd: workspace.worktreePath,
      ignoredPaths: taskWorkspaceIgnoredPaths(workspace),
      message: (typeof value.message === 'string' ? value.message.trim() : '') || buildTaskCommitMessageSuggestion({ taskType: task.taskType, taskCode: task.taskCode, taskTitle: task.title }),
      selectedPaths,
    });
    const review = await readTaskWorkspaceReview(workspace);
    return workspaceGitResponse({ workspace: { ...workspace, headSha: result.headSha, state: 'ready', lastError: null }, result, review }, 200, () => {
      taskWorkspaces.update(workspace.id, { headSha: result.headSha, state: 'ready', lastError: null });
      recordTaskEvent({ taskId: task.id, eventType: 'task.git_workspace.committed', title: '任务分支已提交', payload: { workspaceId: workspace.id, branchName: workspace.branchName, ...result } });
      appendAuditLog({
        actorType: 'local_api',
        action: 'task.git_workspace.commit',
        resourceType: 'task_workspace',
        resourceId: workspace.id,
        payload: { taskId: task.id, projectId: task.projectId, branchName: workspace.branchName, selectedPaths, ...result },
        createdAt: new Date().toISOString(),
      });
    });
  }

  async function executeSingleTaskWorkspacePush(opaque: WorkspaceGitPreparedOpaque): Promise<WorkspaceGitRouteExecution> {
    const { task, workspace } = requirePreparedWorkspace(opaque);
    if (!workspace.worktreePath) workspaceGitReject(409, 'ZEUS_TASK_WORKTREE_UNAVAILABLE', 'Task worktree is not available.');
    if (!workspace.remoteName) workspaceGitReject(409, 'ZEUS_TASK_GIT_REMOTE_UNAVAILABLE', 'This repository has no Git remote. Configure a remote before pushing.');
    const result = await pushTaskWorkspace({ cwd: workspace.worktreePath, ignoredPaths: taskWorkspaceIgnoredPaths(workspace), remoteName: workspace.remoteName, remoteBranch: workspace.remoteBranch });
    const review = await readTaskWorkspaceReview(workspace);
    return workspaceGitResponse({ workspace: { ...workspace, headSha: result.headSha, state: 'ready', lastError: null }, result, review }, 200, () => {
      taskWorkspaces.update(workspace.id, { headSha: result.headSha, state: 'ready', lastError: null });
      recordTaskEvent({ taskId: task.id, eventType: 'task.git_workspace.pushed', title: '任务分支已推送', payload: { workspaceId: workspace.id, branchName: workspace.branchName, ...result } });
      appendAuditLog({
        actorType: 'local_api',
        action: 'task.git_workspace.push',
        resourceType: 'task_workspace',
        resourceId: workspace.id,
        payload: { taskId: task.id, projectId: task.projectId, branchName: workspace.branchName, ...result },
        createdAt: new Date().toISOString(),
      });
    });
  }

  async function executeTaskWorkspaceStopSessions(opaque: WorkspaceGitPreparedOpaque): Promise<WorkspaceGitRouteExecution> {
    const { task, workspace } = requirePreparedWorkspace(opaque);
    let interrupted = 0;
    const cancellableSubmissionIds: string[] = [];
    for (const conversation of listTaskWorkspaceConversations(workspace)) {
      const activeTurn = [...conversationTurns.listByConversation(conversation.id)].reverse().find((turn) => (turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching') && turn.providerTurnId);
      if (activeTurn?.providerTurnId) {
        await codexNativeCoordinator.interruptTurn({ conversationId: conversation.id, providerTurnId: activeTurn.providerTurnId });
        interrupted += 1;
      }
      for (const submission of conversationSubmissions.listByConversation(conversation.id)) {
        if (submission.status === 'queued' || submission.status === 'paused' || submission.status === 'failed') cancellableSubmissionIds.push(submission.id);
      }
    }
    return workspaceGitResponse({ workspaceId: workspace.id, interrupted, cancelled: cancellableSubmissionIds.length }, 200, () => {
      const resolvedAt = new Date().toISOString();
      for (const submissionId of cancellableSubmissionIds) conversationSubmissions.updateStatus(submissionId, 'cancelled', { resolvedAt });
      recordTaskEvent({ taskId: task.id, eventType: 'task.git_workspace.sessions_stopped', title: '任务分支上的活动会话已停止', payload: { workspaceId: workspace.id, interrupted, cancelled: cancellableSubmissionIds.length } });
    });
  }

  async function executeTaskWorkspaceReclaim(opaque: WorkspaceGitPreparedOpaque): Promise<WorkspaceGitRouteExecution> {
    const { task, project, workspace } = requirePreparedWorkspace(opaque);
    if (!workspace.worktreePath) {
      if (workspace.state === 'reclaimed') return workspaceGitResponse({ workspace });
      workspaceGitReject(409, 'ZEUS_TASK_WORKTREE_UNAVAILABLE', 'Task worktree is not available.');
    }
    const result = await reclaimTaskWorktree({
      repositoryPath: workspace.repositoryPath || project.localPath,
      worktreePath: workspace.worktreePath,
      remoteName: workspace.remoteName,
      remoteBranch: workspace.remoteBranch,
      sourceHeadSha: workspace.sourceHeadSha,
      ignoredPaths: taskWorkspaceIgnoredPaths(workspace),
    });
    const deferredAncestors = await reclaimPredictedDeliveredAncestors(workspace);
    const projected = { ...workspace, worktreePath: null, headSha: result.headSha, state: 'reclaimed' as const, lastError: null };
    return workspaceGitResponse({ workspace: projected, result }, 200, () => {
      taskWorkspaces.update(workspace.id, { worktreePath: null, headSha: result.headSha, state: 'reclaimed', lastError: null });
      applyDeferredAncestorReclaims(deferredAncestors);
      reconcileTaskEnvironmentState(workspace.environmentId);
      recordTaskEvent({ taskId: task.id, eventType: 'task.git_workspace.reclaimed', title: '任务 worktree 已回收', payload: { workspaceId: workspace.id, branchName: workspace.branchName, ...result } });
    });
  }

  async function executeTaskWorkspaceDiscard(opaque: WorkspaceGitPreparedOpaque, value: Record<string, unknown>): Promise<WorkspaceGitRouteExecution> {
    const { task, project, workspace } = requirePreparedWorkspace(opaque);
    try {
      assertNestedTaskWorktreesReclaimed(workspace);
    } catch (error) {
      workspaceGitReject(409, taskGitErrorCode(error), error instanceof Error ? error.message : '嵌套仓库尚未回收。');
    }
    if (value.confirmationText !== undefined && typeof value.confirmationText !== 'string') workspaceGitReject(400, 'ZEUS_GIT_CONFIRMATION_INVALID', 'confirmationText must be a string');
    const result = await discardTaskWorktree({
      repositoryPath: workspace.repositoryPath || project.localPath,
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
      confirmationText: typeof value.confirmationText === 'string' ? value.confirmationText.trim() : '',
    });
    const deferredAncestors = await reclaimPredictedDeliveredAncestors(workspace);
    const projected = { ...workspace, worktreePath: null, state: 'discarded' as const, lastError: null };
    return workspaceGitResponse({ workspace: projected, result }, 200, () => {
      taskWorkspaces.update(workspace.id, { worktreePath: null, state: 'discarded', lastError: null });
      applyDeferredAncestorReclaims(deferredAncestors);
      reconcileTaskEnvironmentState(workspace.environmentId);
      recordTaskEvent({ taskId: task.id, eventType: 'task.git_workspace.discarded', title: '任务本地分支已放弃', payload: { workspaceId: workspace.id, remoteBranchPreserved: true, ...result } });
    });
  }

  async function reclaimPredictedDeliveredAncestors(closingWorkspace: ZeusTaskWorkspaceRecord): Promise<Array<{ workspaceId: string; headSha?: string; lastError?: string }>> {
    if (!closingWorkspace.environmentId) return [];
    const members = taskWorkspaces.listByEnvironment(closingWorkspace.environmentId);
    const removedWorkspaceIds = new Set([closingWorkspace.id]);
    const results: Array<{ workspaceId: string; headSha?: string; lastError?: string }> = [];
    const candidates = members
      .filter((workspace) => workspace.id !== closingWorkspace.id && workspace.state === 'merged' && workspace.worktreePath)
      .sort((left, right) => right.repositoryRelativePath.split('/').length - left.repositoryRelativePath.split('/').length);
    for (const candidate of candidates) {
      if (!candidate.worktreePath) continue;
      const nestedStillOpen = members.some((member) => member.id !== candidate.id && !removedWorkspaceIds.has(member.id) && Boolean(member.worktreePath) && isPathInsideRoot(member.worktreePath!, candidate.worktreePath!));
      if (nestedStillOpen) continue;
      try {
        const reclaimed = await reclaimDeliveredTaskWorktree({
          repositoryPath: candidate.repositoryPath || projects.getById(candidate.projectId)?.localPath || '',
          worktreePath: candidate.worktreePath,
          ignoredPaths: taskWorkspaceIgnoredPaths(candidate),
        });
        removedWorkspaceIds.add(candidate.id);
        results.push({ workspaceId: candidate.id, headSha: reclaimed.headSha });
      } catch (error) {
        results.push({ workspaceId: candidate.id, lastError: `来源分支已交付，但任务 worktree 回收失败：${error instanceof Error ? error.message : 'Task worktree cleanup failed.'}` });
      }
    }
    return results;
  }

  function applyDeferredAncestorReclaims(results: Array<{ workspaceId: string; headSha?: string; lastError?: string }>): void {
    for (const result of results) {
      if (result.headSha) taskWorkspaces.update(result.workspaceId, { worktreePath: null, headSha: result.headSha, lastError: null });
      else if (result.lastError) taskWorkspaces.update(result.workspaceId, { lastError: result.lastError });
    }
  }

  async function executeProjectGitSnapshotCommand(opaque: WorkspaceGitPreparedOpaque): Promise<WorkspaceGitRouteExecution> {
    const project = requirePreparedProject(opaque);
    const task = requirePreparedTask(opaque);
    if (task.projectId !== project.id) workspaceGitReject(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found for this project');
    const gitScope = getProjectGitQueries().resolveProjectScope(project);
    if ('limitation' in gitScope) workspaceGitReject(409, 'ZEUS_PROJECT_GIT_SCOPE_UNSUPPORTED', gitScope.limitation);
    const diff = await readGitDiff(gitScope.path);
    const body = {
      projectId: project.id,
      taskId: task.id,
      snapshotType: 'readonly_diff',
      isRepository: diff.isRepository,
      fileCount: diff.files.length,
      diffTextLength: diff.diffText.length,
    };
    return workspaceGitResponse(body, 201, () => {
      publishGitDiffUpdatedEvent(diff, project.id);
      persistReadonlyGitDiffSnapshot({ projectId: project.id, taskId: task.id, diff, graphRoot: project.localPath });
      publishRealtimeEvent('git.snapshot.created', { projectId: project.id, taskId: task.id, snapshotType: 'readonly_diff', fileCount: diff.files.length });
    });
  }

  async function executeProjectGitPatchCommand(opaque: WorkspaceGitPreparedOpaque): Promise<WorkspaceGitRouteExecution> {
    const project = requirePreparedProject(opaque);
    const gitScope = getProjectGitQueries().resolveProjectScope(project);
    if ('limitation' in gitScope) workspaceGitReject(409, 'ZEUS_PROJECT_GIT_SCOPE_UNSUPPORTED', gitScope.limitation);
    const patch = buildGitPatchExport(await readGitDiff(gitScope.path));
    return workspaceGitResponse(patch, 200, () => {
      appendAuditLog({
        actorType: 'local_api',
        action: 'git.patch.exported',
        resourceType: 'git_patch',
        resourceId: patch.fileName,
        payload: { projectId: project.id, fileCount: patch.files.length, patchTextLength: patch.patchText.length, readonly: true },
        createdAt: patch.createdAt,
      });
    });
  }

  async function executeTaskPushRepositoryRefreshRemoteCommand(opaque: WorkspaceGitPreparedOpaque): Promise<WorkspaceGitRouteExecution> {
    const project = requirePreparedProject(opaque);
    const task = requirePreparedTask(opaque);
    if (task.projectId !== project.id) workspaceGitReject(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found');
    const repository = opaque.repositoryId ? projectRepositories.getById(opaque.repositoryId) : null;
    if (!repository || repository.projectId !== project.id) workspaceGitReject(404, 'ZEUS_PROJECT_REPOSITORY_NOT_FOUND', 'Project repository not found');
    const projectRelativePath = relative(project.localPath, repository.localPath);
    if (projectRelativePath === '..' || projectRelativePath.startsWith(`..${sep}`) || isAbsolute(projectRelativePath)) {
      workspaceGitReject(409, 'ZEUS_PROJECT_REPOSITORY_UNAVAILABLE', 'Project repository path is outside the project directory.');
    }
    const repositoryContext = await getGitRepositoryContext(repository.localPath);
    if (!repositoryContext.isRepository || resolve(repositoryContext.topLevel) !== resolve(repository.localPath)) {
      workspaceGitReject(409, 'ZEUS_PROJECT_REPOSITORY_UNAVAILABLE', 'Project repository is unavailable.');
    }
    const clean = await getGitWorktreeClean(repository.localPath, projectRepositoryIgnoredPaths(project.id, repository.id, repository.localPath));
    return workspaceGitResponse(await resolveTaskPushRepositoryCapability(project, task, repository, true, { context: repositoryContext, clean }));
  }

  async function executeTaskWorkspaceIntegration(opaque: WorkspaceGitPreparedOpaque, value: Record<string, unknown>, operationIdentity: string): Promise<WorkspaceGitRouteExecution> {
    const { task, project, workspace } = requirePreparedWorkspace(opaque);
    if (workspace.state === 'discarded') workspaceGitReject(409, 'ZEUS_TASK_WORKSPACE_CLOSED', 'Discarded task branches cannot be merged.');
    if (value.targetBranch !== undefined && typeof value.targetBranch !== 'string') workspaceGitReject(400, 'ZEUS_TARGET_BRANCH_INVALID', 'targetBranch must be a string');
    if (value.mode !== undefined && value.mode !== 'merge' && value.mode !== 'squash') workspaceGitReject(400, 'ZEUS_TASK_INTEGRATION_MODE_INVALID', 'mode must be merge or squash');
    if (value.prepareOnly !== undefined && typeof value.prepareOnly !== 'boolean') workspaceGitReject(400, 'ZEUS_TASK_INTEGRATION_PREPARE_ONLY_INVALID', 'prepareOnly must be a boolean');
    const repositoryPath = workspace.repositoryPath || project.localPath;
    const repository = await getGitRepositoryContext(repositoryPath);
    if (!repository.isRepository) workspaceGitReject(409, 'ZEUS_TARGET_BRANCH_UNAVAILABLE', 'Project repository is unavailable.');
    if (workspace.worktreePath) {
      const taskReview = await readTaskWorkspaceReview(workspace);
      if (taskReview.conflictFiles.length > 0) workspaceGitReject(409, 'ZEUS_TASK_WORKSPACE_CONFLICTED', 'Resolve task workspace conflicts before merging.');
      if (!taskReview.clean) workspaceGitReject(409, 'ZEUS_TASK_WORKSPACE_DIRTY', 'Commit or discard every task workspace change before merging.');
    } else if (workspace.state !== 'reclaimed' && workspace.state !== 'merged') {
      workspaceGitReject(409, 'ZEUS_TASK_WORKTREE_UNAVAILABLE', 'Task worktree is unavailable before delivery preparation completed.');
    }
    if (workspace.kind === 'conflict') {
      const baseWorkspace = workspace.baseWorkspaceId ? taskWorkspaces.getById(workspace.baseWorkspaceId) : undefined;
      if (!baseWorkspace || baseWorkspace.taskId !== task.id || baseWorkspace.projectId !== project.id) {
        workspaceGitReject(409, 'ZEUS_CONFLICT_BASE_WORKSPACE_UNAVAILABLE', '冲突处理开发线对应的原任务分支不可用。');
      }
      if (!workspace.worktreePath) workspaceGitReject(409, 'ZEUS_TASK_WORKTREE_UNAVAILABLE', '冲突处理开发线的 Worktree 不可用。');
      const refreshed = await refreshConflictTaskWorkspace({ cwd: workspace.worktreePath, sourceBranch: workspace.sourceBranch, taskBranch: baseWorkspace.branchName });
      taskWorkspaces.update(workspace.id, { headSha: refreshed.headSha, state: 'ready', lastError: null });
      if (refreshed.conflictFiles.length > 0) {
        recordTaskEvent({
          taskId: task.id,
          eventType: 'task.git_workspace.refresh_conflicted',
          title: '冲突处理开发线追赶后出现新冲突',
          payload: { workspaceId: workspace.id, baseWorkspaceId: baseWorkspace.id, conflictFiles: refreshed.conflictFiles },
        });
        await db.save();
        return workspaceGitResponse(
          {
            error: 'ZEUS_TASK_WORKSPACE_CONFLICTED',
            message: '来源分支或任务分支已推进并产生新冲突，请回到原冲突处理会话继续处理。',
            conflictFiles: refreshed.conflictFiles,
          },
          409,
        );
      }
      await db.save();
    }
    const requestedTargetBranch = typeof value.targetBranch === 'string' ? value.targetBranch.trim() : '';
    const targetBranch = workspace.sourceBranch;
    if (requestedTargetBranch && requestedTargetBranch !== targetBranch) workspaceGitReject(400, 'ZEUS_TARGET_BRANCH_INVALID', 'Code delivery can only merge into the recorded source branch.');
    if (!targetBranch || targetBranch === 'detached') workspaceGitReject(409, 'ZEUS_TARGET_BRANCH_UNAVAILABLE', 'The recorded source branch is unavailable.');
    try {
      await assertTaskIntegrationTargetWorktreeClean(project, workspace, targetBranch);
    } catch (error) {
      if (taskGitErrorCode(error) === 'ZEUS_TARGET_BRANCH_DIRTY') workspaceGitReject(409, taskGitErrorCode(error), error instanceof Error ? error.message : 'Target branch is dirty.');
      throw error;
    }
    const mode = value.mode === 'squash' ? 'squash' : 'merge';
    const taskHeadSha = await getGitBranchHead(repositoryPath, workspace.branchName);
    const localTargetHeadSha = await getGitBranchHead(repositoryPath, targetBranch).catch(() => null);
    const targetHeadSha = localTargetHeadSha ?? workspace.sourceHeadSha;
    const targetRef = localTargetHeadSha ? undefined : targetHeadSha;
    const active = taskIntegrations.findActive(workspace.id, targetBranch);
    if (active) return workspaceGitResponse({ integration: active }, active.state === 'conflicted' ? 202 : 409);
    const integrationId = `task_integration_${createHash('sha256').update(`workspace_git_integration\0${workspace.id}\0${targetBranch}\0${operationIdentity}`).digest('hex').slice(0, 24)}`;
    const integration = taskIntegrations.create({ id: integrationId, projectId: project.id, taskId: task.id, workspaceId: workspace.id, targetBranch, targetHeadSha, taskHeadSha, mode, state: 'preparing' });
    await db.save();
    try {
      const started = await startTaskBranchIntegration({
        repositoryPath,
        projectSlug: project.slug,
        integrationId: integration.id,
        targetBranch,
        ...(targetRef ? { targetRef } : {}),
        taskBranch: workspace.branchName,
        mode,
        commitMessage: `${task.taskCode}: 合入 ${workspace.branchName}`,
      });
      if (started.targetHeadSha !== targetHeadSha) throw nativeApiError('ZEUS_TARGET_HEAD_CHANGED', 'Target branch changed while the integration candidate was being created.');
      if (started.taskHeadSha !== taskHeadSha) throw nativeApiError('ZEUS_TASK_HEAD_CHANGED', 'Task branch changed while the integration candidate was being created.');
      let updated = taskIntegrations.update(integration.id, {
        integrationPath: started.integrationPath,
        resultHeadSha: started.resultHeadSha,
        state: started.state === 'conflicted' ? 'conflicted' : 'preparing',
        conflictFiles: started.conflictFiles,
        lastError: null,
      });
      await db.save();
      if (started.state === 'conflicted') {
        recordTaskEvent({
          taskId: task.id,
          eventType: 'task.git_integration.conflicted',
          title: '任务分支合入需要处理冲突',
          payload: { integrationId: integration.id, workspaceId: workspace.id, targetBranch, conflictFiles: started.conflictFiles },
        });
        await db.save();
        return workspaceGitResponse({ integration: updated }, 202);
      }
      if (value.prepareOnly === true) {
        updated = taskIntegrations.update(integration.id, { state: 'conflicted', conflictFiles: [], lastError: null });
        recordTaskEvent({
          taskId: task.id,
          eventType: 'task.git_integration.rebuilt_for_confirmation',
          title: '合入候选已按最新来源分支重建，等待重新确认',
          payload: { integrationId: integration.id, workspaceId: workspace.id, targetBranch, targetHeadSha: started.targetHeadSha },
        });
        await db.save();
        return workspaceGitResponse({ integration: updated }, 202);
      }
      await assertTaskIntegrationTargetWorktreeClean(project, workspace, targetBranch);
      const finalized = await finalizeTaskBranchIntegration({ repositoryPath, integrationPath: started.integrationPath, targetBranch, targetHeadSha: started.targetHeadSha, resultHeadSha: started.resultHeadSha! });
      const pendingLocalSync = finalized.localSyncStatus === 'pending';
      updated = taskIntegrations.update(integration.id, {
        integrationPath: pendingLocalSync ? started.integrationPath : null,
        resultHeadSha: finalized.resultHeadSha,
        state: pendingLocalSync ? 'pending_local_sync' : 'merged',
        localSyncStatus: finalized.localSyncStatus,
        localHeadSha: finalized.localHeadSha,
        localWorktreePath: finalized.localWorktreePath,
        conflictFiles: [],
        lastError: null,
      });
      if (pendingLocalSync) {
        recordTaskEvent({
          taskId: task.id,
          eventType: 'task.git_integration.local_sync_pending',
          title: '合入结果等待同步到本地来源分支',
          payload: { integrationId: integration.id, workspaceId: workspace.id, targetBranch, resultHeadSha: finalized.resultHeadSha },
        });
        await db.save();
        return workspaceGitResponse({ integration: updated, result: finalized }, 202);
      }
      const taskWorktreeReclaimed = targetBranch === workspace.sourceBranch ? await markTaskWorkspaceDelivered(workspace) : false;
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.git_integration.merged',
        title: targetBranch === workspace.sourceBranch ? '任务分支已合入来源分支' : `任务分支已合入 ${targetBranch}`,
        payload: { integrationId: integration.id, workspaceId: workspace.id, mode, sourceDelivered: targetBranch === workspace.sourceBranch, taskWorktreeReclaimed, ...finalized },
      });
      await db.save();
      return workspaceGitResponse({ integration: updated, result: finalized });
    } catch (error) {
      taskIntegrations.update(integration.id, { state: 'failed', lastError: error instanceof Error ? error.message : 'Task branch integration failed.' });
      await db.save();
      throw error;
    }
  }

  async function executeTaskIntegrationConflictAiSession(opaque: WorkspaceGitPreparedOpaque, value: Record<string, unknown>, operationIdentity: string): Promise<WorkspaceGitRouteExecution> {
    const resolved = requirePreparedIntegration(opaque);
    const path = typeof value.path === 'string' ? value.path.trim() : '';
    if (!path) workspaceGitReject(400, 'ZEUS_GIT_PATH_REQUIRED', 'path is required');
    if (typeof value.content !== 'string') workspaceGitReject(400, 'ZEUS_TASK_CONFLICT_CONTENT_REQUIRED', 'Conflict draft content is required.');
    const fingerprint = typeof value.fingerprint === 'string' ? value.fingerprint.trim() : '';
    if (!fingerprint) workspaceGitReject(400, 'ZEUS_TASK_CONFLICT_FINGERPRINT_REQUIRED', 'Conflict fingerprint is required.');
    const permissionMode = parseConversationPermissionMode(value.permissionMode);
    if (!permissionMode) workspaceGitReject(400, 'ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
    const accepted = await executeTaskConversationIdempotent(
      resolved.project,
      resolved.task,
      {
        mode: 'create',
        source: 'conflict_resolution',
        integrationId: resolved.integration.id,
        conflictPath: path,
        conflictContent: value.content,
        conflictFingerprint: fingerprint,
        permissionMode,
      },
      operationIdentity,
    );
    const acceptance = accepted.body;
    if (!isNativeApiRecord(acceptance) || !isNativeApiRecord(acceptance.conversation) || typeof acceptance.conversation.id !== 'string') {
      throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Conflict conversation acceptance did not return the reserved conversation.');
    }
    const conversation = conversations.getById(acceptance.conversation.id);
    if (!conversation) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Conflict conversation acceptance was not persisted.');
    return workspaceGitResponse(
      {
        path,
        agentKind: conversation.agentKind === 'pi' ? 'pi' : 'codex',
        modelSourceId: conversation.modelSourceId,
        modelId: conversation.modelId ?? conversation.providerModel ?? '',
        conversationId: conversation.id,
        status: conversation.status,
      },
      accepted.statusCode,
    );
  }

  async function executeTaskIntegrationConflictResolve(opaque: WorkspaceGitPreparedOpaque, value: Record<string, unknown>): Promise<WorkspaceGitRouteExecution> {
    const resolved = requirePreparedIntegration(opaque);
    if (!resolved.integration.integrationPath) workspaceGitReject(409, 'ZEUS_TASK_INTEGRATION_PATH_UNAVAILABLE', 'Integration worktree is unavailable.');
    const path = typeof value.path === 'string' ? value.path.trim() : '';
    if (!path) workspaceGitReject(400, 'ZEUS_GIT_PATH_REQUIRED', 'path is required');
    if (typeof value.content !== 'string') workspaceGitReject(400, 'ZEUS_TASK_CONFLICT_CONTENT_REQUIRED', 'Resolved content is required.');
    try {
      await assertTaskIntegrationStillCurrent(resolved.project, resolved.workspace, resolved.integration);
    } catch (error) {
      if (isStaleTaskIntegrationError(error)) workspaceGitReject(409, taskGitErrorCode(error), error instanceof Error ? error.message : 'Task integration became stale.');
      throw error;
    }
    const result = await writeTaskIntegrationResolution(resolved.integration.integrationPath, path, value.content);
    const projected = { ...resolved.integration, conflictFiles: result.remainingConflictFiles, state: 'conflicted' as const, lastError: null };
    return workspaceGitResponse({ integration: projected, result }, 200, () => {
      taskIntegrations.update(resolved.integration.id, { conflictFiles: result.remainingConflictFiles, state: 'conflicted', lastError: null });
    });
  }

  async function executeTaskIntegrationFinalize(opaque: WorkspaceGitPreparedOpaque): Promise<WorkspaceGitRouteExecution> {
    const { task, project, integration, workspace } = requirePreparedIntegration(opaque);
    if (!integration.integrationPath) workspaceGitReject(409, 'ZEUS_TASK_INTEGRATION_PATH_UNAVAILABLE', 'Integration worktree is unavailable.');
    try {
      await assertTaskIntegrationStillCurrent(project, workspace, integration);
      await assertTaskIntegrationTargetWorktreeClean(project, workspace, integration.targetBranch);
    } catch (error) {
      if (isStaleTaskIntegrationError(error) || taskGitErrorCode(error) === 'ZEUS_TARGET_BRANCH_DIRTY') {
        workspaceGitReject(409, taskGitErrorCode(error), error instanceof Error ? error.message : 'Task integration is no longer current.');
      }
      throw error;
    }
    const commit = await completeTaskIntegrationCommit({ integrationPath: integration.integrationPath, mode: integration.mode, commitMessage: `${task.taskCode}: 合入 ${workspace.branchName}` });
    const finalized = await finalizeTaskBranchIntegration({
      repositoryPath: workspace.repositoryPath || project.localPath,
      integrationPath: integration.integrationPath,
      targetBranch: integration.targetBranch,
      targetHeadSha: integration.targetHeadSha,
      resultHeadSha: commit.resultHeadSha,
    });
    const pendingLocalSync = finalized.localSyncStatus === 'pending';
    const updated = taskIntegrations.update(integration.id, {
      integrationPath: pendingLocalSync ? integration.integrationPath : null,
      resultHeadSha: finalized.resultHeadSha,
      state: pendingLocalSync ? 'pending_local_sync' : 'merged',
      localSyncStatus: finalized.localSyncStatus,
      localHeadSha: finalized.localHeadSha,
      localWorktreePath: finalized.localWorktreePath,
      conflictFiles: [],
      lastError: null,
    });
    if (pendingLocalSync) {
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.git_integration.local_sync_pending',
        title: '合入结果等待同步到本地来源分支',
        payload: { integrationId: integration.id, workspaceId: workspace.id, targetBranch: integration.targetBranch, resultHeadSha: finalized.resultHeadSha },
      });
      await db.save();
      return workspaceGitResponse({ integration: updated, result: finalized }, 202);
    }
    const taskWorktreeReclaimed = integration.targetBranch === workspace.sourceBranch ? await markTaskWorkspaceDelivered(workspace) : false;
    recordTaskEvent({
      taskId: task.id,
      eventType: 'task.git_integration.merged',
      title: integration.targetBranch === workspace.sourceBranch ? '任务分支已合入来源分支' : `任务分支已合入 ${integration.targetBranch}`,
      payload: { integrationId: integration.id, workspaceId: workspace.id, mode: integration.mode, sourceDelivered: integration.targetBranch === workspace.sourceBranch, taskWorktreeReclaimed, ...finalized },
    });
    await db.save();
    return workspaceGitResponse({ integration: updated, result: finalized });
  }

  async function executeTaskIntegrationPush(opaque: WorkspaceGitPreparedOpaque): Promise<WorkspaceGitRouteExecution> {
    const { task, project, integration, workspace } = requirePreparedIntegration(opaque);
    if (integration.state !== 'merged' || integration.targetBranch !== workspace.sourceBranch) {
      workspaceGitReject(409, 'ZEUS_TASK_INTEGRATION_NOT_MERGED', 'Merge the task branch into its source branch before pushing.');
    }
    if (!workspace.remoteName) workspaceGitReject(409, 'ZEUS_TASK_GIT_REMOTE_UNAVAILABLE', 'This repository has no Git remote. Configure a remote before pushing.');
    const result = await pushLocalBranch({ repositoryPath: workspace.repositoryPath || project.localPath, remoteName: workspace.remoteName, branchName: integration.targetBranch });
    return workspaceGitResponse({ integration, workspace, result }, 200, () => {
      recordTaskEvent({ taskId: task.id, eventType: 'task.git_integration.source_pushed', title: '来源分支已推送', payload: { integrationId: integration.id, workspaceId: workspace.id, ...result } });
      appendAuditLog({
        actorType: 'local_api',
        action: 'task.git_integration.push_source',
        resourceType: 'task_integration',
        resourceId: integration.id,
        payload: { taskId: task.id, projectId: task.projectId, workspaceId: workspace.id, ...result },
        createdAt: new Date().toISOString(),
      });
    });
  }

  /** 保存冲突草稿或完成本地合入前重新校验候选使用的任务与来源精确提交。 */
  async function assertTaskIntegrationStillCurrent(project: ZeusProjectRecord, workspace: ZeusTaskWorkspaceRecord, integration: ZeusTaskIntegrationRecord): Promise<void> {
    const repositoryPath = workspace.repositoryPath || project.localPath;
    const taskHeadSha = await getGitBranchHead(repositoryPath, workspace.branchName);
    if (!integration.taskHeadSha || integration.taskHeadSha !== taskHeadSha) {
      throw nativeApiError('ZEUS_TASK_HEAD_CHANGED', 'Task branch changed after the integration candidate was created. Rebuild from the current task HEAD.');
    }
    const targetHeadSha = await getGitBranchHead(repositoryPath, integration.targetBranch).catch(() => (integration.targetBranch === workspace.sourceBranch ? workspace.sourceHeadSha : null));
    if (targetHeadSha !== integration.targetHeadSha) throw nativeApiError('ZEUS_TARGET_HEAD_CHANGED', 'Local target branch advanced while the integration was being prepared.');
  }

  async function assertTaskIntegrationTargetWorktreeClean(project: ZeusProjectRecord, workspace: ZeusTaskWorkspaceRecord, targetBranch: string): Promise<void> {
    const repositoryPath = workspace.repositoryPath || project.localPath;
    const repository = await getGitRepositoryContext(repositoryPath);
    if (!repository.isRepository) throw nativeApiError('ZEUS_TARGET_BRANCH_UNAVAILABLE', 'The recorded source branch is unavailable.');
    const targetWorktree = repository.worktrees.find((entry) => entry.branch === targetBranch);
    if (!targetWorktree) return;
    const ignoredPaths = projectRepositoryIgnoredPaths(workspace.projectId, workspace.repositoryId, repositoryPath);
    if (!(await getGitWorktreeClean(targetWorktree.path, ignoredPaths))) {
      throw nativeApiError('ZEUS_TARGET_BRANCH_DIRTY', '来源分支所在工作区存在未提交代码，请先处理后再合入。');
    }
  }

  function isStaleTaskIntegrationError(error: unknown): boolean {
    const code =
      error instanceof Error &&
      typeof (
        error as Error & {
          code?: unknown;
        }
      ).code === 'string'
        ? String((error as Error & { code: string }).code)
        : '';
    return code === 'ZEUS_TARGET_HEAD_CHANGED' || code === 'ZEUS_TASK_HEAD_CHANGED';
  }

  function sendTaskGitApiError(reply: FastifyReply, error: unknown) {
    const code = taskGitErrorCode(error);
    const status = code.endsWith('_NOT_FOUND')
      ? 404
      : code.endsWith('_INVALID') || code.endsWith('_REQUIRED')
        ? 400
        : /_(?:DIRTY|CONFLICTED|FAILED|BUSY|CHANGED|UNAVAILABLE|ALREADY_EXISTS|ALREADY_MANAGED|CLOSED|VERIFICATION_FAILED|DIVERGED)$/u.test(code)
          ? 409
          : 500;
    return reply.code(status).send({ error: code, message: error instanceof Error ? error.message : 'Task Git operation failed.' });
  }

  function taskGitErrorCode(error: unknown): string {
    return error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string' ? String((error as Error & { code: string }).code) : 'ZEUS_TASK_GIT_OPERATION_FAILED';
  }

  async function prepareTaskIntegrationAiAttempt(input: {
    attemptId: string;
    integrationId: string;
    conflictPath: string;
    conflictContent: string;
    conflictFingerprint: string;
    idempotencyKey: string;
    clientUserMessageId: string;
    agentKind: 'codex' | 'pi';
    model: { sourceId: string | null; modelId: string; displayName: string | null };
    dispatchSubmissionId?: string;
    dispatchIdempotencyKey?: string;
    dispatchClientUserMessageId?: string;
  }): Promise<void> {
    const attempt = taskIntegrationAttempts.getById(input.attemptId);
    const integration = taskIntegrations.getById(input.integrationId);
    if (!attempt || !integration || attempt.integrationId !== integration.id || attempt.state === 'completed') return;
    const resolved = resolveTaskIntegrationRequest(integration.taskId, integration.id);
    if ('error' in resolved) return failTaskIntegrationAiPreparation(input, resolved.error.message);
    const { project, task, workspace } = resolved;
    const repositoryPath = workspace.repositoryPath || project.localPath;
    const conversation = conversations.getById(attempt.conversationId);
    const conflictWorkspace = conversation?.workspaceId ? taskWorkspaces.getById(conversation.workspaceId) : undefined;
    if (!conflictWorkspace || conflictWorkspace.kind !== 'conflict' || conflictWorkspace.baseWorkspaceId !== workspace.id) {
      return failTaskIntegrationAiPreparation(input, '冲突处理会话没有绑定有效的命名冲突开发线。');
    }
    try {
      const [targetHeadSha, taskHeadSha] = await Promise.all([getGitBranchHead(repositoryPath, integration.targetBranch), getGitBranchHead(repositoryPath, workspace.branchName)]);
      const started = await startTaskIntegrationAttempt({
        repositoryPath,
        projectSlug: project.slug,
        integrationId: integration.id,
        attemptId: input.attemptId,
        conflictBranch: conflictWorkspace.branchName,
        targetBranch: integration.targetBranch,
        targetHeadSha,
        taskBranch: workspace.branchName,
        taskHeadSha,
        mode: integration.mode,
        commitMessage: `${task.taskCode}: 合入 ${workspace.branchName}`,
      });

      if (started.state === 'conflicted' && started.conflictFiles.includes(input.conflictPath)) {
        const latestConflict = await readTaskIntegrationConflict(started.integrationPath, input.conflictPath);
        if (latestConflict.fingerprint === input.conflictFingerprint) {
          await writeTaskIntegrationDraft(started.integrationPath, input.conflictPath, input.conflictContent);
        }
      }
      taskIntegrationAttempts.update(input.attemptId, {
        worktreePath: started.integrationPath,
        targetHeadSha: started.targetHeadSha,
        taskHeadSha: started.taskHeadSha,
        state: 'active',
        lastError: null,
      });
      taskWorkspaces.update(conflictWorkspace.id, {
        worktreePath: started.integrationPath,
        headSha: started.resultHeadSha ?? started.targetHeadSha,
        state: 'ready',
        lastError: null,
      });
      const settings = conversations.getNextTurnSettings(attempt.conversationId);
      const selectedPiModelRef = input.agentKind === 'pi' && settings?.model ? parseModelRef(settings.model) : null;
      const selectedModel =
        input.agentKind === 'pi'
          ? selectedPiModelRef
            ? { sourceId: selectedPiModelRef.sourceId, modelId: selectedPiModelRef.modelId, displayName: null }
            : input.model
          : settings?.model
            ? { sourceId: null, modelId: settings.model, displayName: null }
            : input.model;
      const prompt = buildTaskConflictAiPrompt({
        sourceBranch: integration.targetBranch,
        taskBranch: workspace.branchName,
        conflictBranch: conflictWorkspace.branchName,
        mode: integration.mode,
        commitMessage: `${task.taskCode}: 合入 ${workspace.branchName}`,
      });
      const operation = await startNativeTaskConversationFromPlan({
        agentKind: input.agentKind,
        conversationId: attempt.conversationId,
        submissionId: input.dispatchSubmissionId ?? attempt.submissionId,
        projectId: project.id,
        taskId: task.id,
        taskTitle: task.title,
        conversationTitle: buildTaskConflictAiConversationTitle({ taskTitle: task.title }),
        cwd: started.integrationPath,
        prompt,
        model: selectedModel,
        ...(settings?.effort ? { effort: settings.effort } : {}),
        ...(settings && Object.prototype.hasOwnProperty.call(settings, 'serviceTier') ? { serviceTier: settings.serviceTier, serviceTierPresent: true } : {}),
        permissionMode: settings?.permissionMode ?? conversations.getById(attempt.conversationId)?.permissionMode ?? 'auto',
        workMode: settings?.collaborationMode ?? 'default',
        workspaceId: conflictWorkspace.id,
        writableRoots: [started.integrationPath],
        allowCodeChanges: true,
        allowTests: true,
        allowGitCommit: false,
        deferInitialDispatch: true,
        idempotencyKey: input.dispatchIdempotencyKey ?? input.idempotencyKey,
        clientUserMessageId: input.dispatchClientUserMessageId ?? input.clientUserMessageId,
        providerWriteLifecycle: { markPrepared: async () => undefined, markRpcStarted: () => undefined },
        ...(input.dispatchSubmissionId ? { internalOperation: true } : {}),
      });
      const tracked = taskConflictAiOperations.get(input.attemptId);
      if (tracked) tracked.running = operation.status === 'active' || operation.status === 'queued';
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.git_integration.ai_started',
        title: '冲突处理：最新合入现场已准备，AI 开始处理',
        payload: {
          integrationId: integration.id,
          attemptId: input.attemptId,
          workspaceId: conflictWorkspace.id,
          baseWorkspaceId: workspace.id,
          conversationId: attempt.conversationId,
          conflictBranch: conflictWorkspace.branchName,
          targetHeadSha: started.targetHeadSha,
          taskHeadSha: started.taskHeadSha,
        },
      });
      await db.save();
    } catch (error) {
      taskWorkspaces.update(conflictWorkspace.id, { state: 'failed', lastError: error instanceof Error ? error.message : '无法准备冲突处理开发线。' });
      await failTaskIntegrationAiPreparation(input, error instanceof Error ? error.message : '无法准备冲突处理现场。');
    }
  }

  async function retryTaskIntegrationAiPreparation(conversation: ZeusConversationWithMessagesRecord, attempt: NonNullable<ReturnType<TaskIntegrationAttemptRepository['getByConversationId']>>): Promise<void> {
    const submission = conversationSubmissions.getById(attempt.submissionId);
    if (!submission || submission.conversationId !== conversation.id) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', '冲突处理首条消息不存在。');
    const persistedInput = parseJsonObject(submission.inputJson);
    const context = isNativeApiRecord(persistedInput.context) ? persistedInput.context : {};
    const operationContext = isNativeApiRecord(context.operationContext) ? context.operationContext : {};
    const envelope = isNativeApiRecord(operationContext.conflictPreparation) ? operationContext.conflictPreparation : {};
    const required = (key: string): string => {
      const value = envelope[key];
      if (typeof value !== 'string' || !value) throw nativeApiError('ZEUS_CONFLICT_PREPARATION_ENVELOPE_INVALID', `冲突处理准备信封缺少 ${key}。`);
      return value;
    };
    const integrationId = required('integrationId');
    const conflictPath = required('conflictPath');
    const conflictContent = required('conflictContent');
    const conflictFingerprint = required('conflictFingerprint');
    if (integrationId !== attempt.integrationId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', '冲突处理准备信封与业务操作身份不一致。');
    taskIntegrationAttempts.update(attempt.id, { state: 'preparing', lastError: null });
    taskConflictAiOperations.set(attempt.id, { conversationId: conversation.id, submissionId: submission.id, running: false, finalizing: false });
    await db.save();
    const originalSubmissionTerminal = submission.status === 'completed' || submission.status === 'resolved' || submission.status === 'cancelled' || submission.status === 'deleted';
    const generationIdentity = originalSubmissionTerminal ? createHash('sha256').update(`${attempt.id}\0${attempt.targetHeadSha}\0${attempt.taskHeadSha}\0${now().toISOString()}`).digest('hex').slice(0, 24) : null;
    setImmediate(() => {
      void prepareTaskIntegrationAiAttempt({
        attemptId: attempt.id,
        integrationId,
        conflictPath,
        conflictContent,
        conflictFingerprint,
        idempotencyKey: submission.idempotencyKey,
        clientUserMessageId: submission.clientMessageId,
        agentKind: conversation.agentKind === 'pi' ? 'pi' : 'codex',
        model: { sourceId: conversation.modelSourceId, modelId: conversation.modelId ?? conversation.providerModel ?? '', displayName: null },
        ...(generationIdentity
          ? {
              dispatchSubmissionId: `conversation_submission_${generationIdentity}`,
              dispatchIdempotencyKey: `conflict-generation:${generationIdentity}`,
              dispatchClientUserMessageId: `conflict-generation-client:${generationIdentity}`,
            }
          : {}),
      });
    });
  }

  async function failTaskIntegrationAiPreparation(input: { attemptId: string; integrationId: string }, message: string): Promise<void> {
    const attempt = taskIntegrationAttempts.getById(input.attemptId);
    const integration = taskIntegrations.getById(input.integrationId);
    if (!attempt) return;
    taskIntegrationAttempts.update(attempt.id, { state: 'failed', lastError: message });
    if (integration) {
      recordTaskEvent({
        taskId: integration.taskId,
        eventType: 'task.git_integration.ai_prepare_failed',
        title: '冲突处理：准备失败，可在当前会话重试',
        payload: { integrationId: integration.id, attemptId: attempt.id, conversationId: attempt.conversationId, error: message },
      });
    }
    await db.save();
    if (integration) publishRealtimeEvent('task.git_delivery.changed', { taskId: integration.taskId, integrationId: integration.id, conversationId: attempt.conversationId });
  }

  function scheduleTaskIntegrationAiFinalization(operationId: string, conversationId: string): void {
    const operation = taskConflictAiOperations.get(operationId);
    if (!operation || operation.conversationId !== conversationId || operation.finalizing) return;
    operation.finalizing = true;
    void finalizeTaskIntegrationAfterAi(operationId, conversationId).finally(() => {
      const current = taskConflictAiOperations.get(operationId);
      if (!current || current.conversationId !== conversationId) return;
      const attempt = taskIntegrationAttempts.getById(operationId);
      if (attempt && (attempt.state === 'completed' || attempt.state === 'failed' || attempt.state === 'stale')) {
        taskConflictAiOperations.delete(operationId);
        return;
      }
      const integration = taskIntegrations.getById(operationId);
      if (!attempt && (!integration || integration.state !== 'conflicted')) {
        taskConflictAiOperations.delete(operationId);
        return;
      }
      current.finalizing = false;
    });
  }

  async function finalizeTaskIntegrationAfterAi(operationId: string, conversationId: string): Promise<void> {
    const attempt = taskIntegrationAttempts.getById(operationId);
    if (attempt) return finalizeTaskIntegrationAttemptAfterAi(attempt.id, conversationId);
    return finalizeLegacyTaskIntegrationAfterAi(operationId, conversationId);
  }

  async function finalizeTaskIntegrationAttemptAfterAi(attemptId: string, conversationId: string): Promise<void> {
    const attempt = taskIntegrationAttempts.getById(attemptId);
    if (!attempt || attempt.conversationId !== conversationId || attempt.state === 'completed' || attempt.state === 'failed') return;
    const integration = taskIntegrations.getById(attempt.integrationId);
    if (attempt.state === 'stale') {
      if (integration) await cleanupTaskIntegrationAttemptWorktree(attempt.worktreePath, integration).catch(() => undefined);
      return;
    }
    if (!integration || integration.state !== 'conflicted') {
      taskIntegrationAttempts.update(attempt.id, { state: 'stale', lastError: '目标合入已经由其他尝试完成或失效。' });
      await db.save();
      return;
    }
    try {
      const resolved = resolveTaskIntegrationRequest(integration.taskId, integration.id);
      if ('error' in resolved) throw nativeApiError(resolved.error.error, resolved.error.message);
      const { task, project, workspace } = resolved;
      const repositoryPath = workspace.repositoryPath || project.localPath;
      const [latestTargetHeadSha, latestTaskHeadSha] = await Promise.all([getGitBranchHead(repositoryPath, integration.targetBranch), getGitBranchHead(repositoryPath, workspace.branchName)]);
      if (attempt.targetHeadSha !== latestTargetHeadSha || attempt.taskHeadSha !== latestTaskHeadSha) {
        throw nativeApiError('ZEUS_TASK_INTEGRATION_ATTEMPT_STALE', '来源分支或任务分支已推进，继续准备最新执行代次。');
      }
      await assertTaskIntegrationTargetWorktreeClean(project, workspace, integration.targetBranch);
      const commit = await completeTaskIntegrationCommit({
        integrationPath: attempt.worktreePath,
        mode: integration.mode,
        commitMessage: `${task.taskCode}: 合入 ${workspace.branchName}`,
      });
      const finalized = await finalizeTaskBranchIntegration({
        repositoryPath,
        integrationPath: attempt.worktreePath,
        targetBranch: integration.targetBranch,
        targetHeadSha: attempt.targetHeadSha,
        resultHeadSha: commit.resultHeadSha,
      });
      const pendingLocalSync = finalized.localSyncStatus === 'pending';
      if (integration.integrationPath && resolve(integration.integrationPath) !== resolve(attempt.worktreePath)) {
        await cleanupTaskIntegrationWorktree({ repositoryPath: workspace.repositoryPath || project.localPath, integrationPath: integration.integrationPath });
      }
      taskIntegrationAttempts.update(attempt.id, { state: 'completed', resultHeadSha: finalized.resultHeadSha, lastError: null });
      taskIntegrations.update(integration.id, {
        integrationPath: pendingLocalSync ? attempt.worktreePath : null,
        resultHeadSha: finalized.resultHeadSha,
        state: pendingLocalSync ? 'pending_local_sync' : 'merged',
        localSyncStatus: finalized.localSyncStatus,
        localHeadSha: finalized.localHeadSha,
        localWorktreePath: finalized.localWorktreePath,
        conflictFiles: [],
        lastError: null,
      });
      for (const other of taskIntegrationAttempts.listByIntegration(integration.id)) {
        if (other.id === attempt.id || other.state === 'completed' || other.state === 'failed' || other.state === 'stale') continue;
        taskIntegrationAttempts.update(other.id, { state: 'stale', lastError: '另一条冲突处理尝试已先完成安全落地。' });
      }
      if (pendingLocalSync) {
        recordTaskEvent({
          taskId: task.id,
          eventType: 'task.git_integration.local_sync_pending',
          title: '冲突处理：AI 已解决冲突，合入结果等待同步到本地来源分支',
          payload: { integrationId: integration.id, attemptId: attempt.id, workspaceId: workspace.id, conversationId, targetBranch: integration.targetBranch, resultHeadSha: finalized.resultHeadSha },
        });
        await db.save();
        publishRealtimeEvent('task.git_delivery.changed', { taskId: task.id, integrationId: integration.id, conversationId });
        return;
      }
      const taskWorktreeReclaimed = integration.targetBranch === workspace.sourceBranch ? await markTaskWorkspaceDelivered(workspace) : false;
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.git_integration.ai_merged',
        title: `冲突处理：AI 已完成本地合入 ${integration.targetBranch}`,
        payload: {
          integrationId: integration.id,
          attemptId: attempt.id,
          workspaceId: workspace.id,
          conversationId,
          mode: integration.mode,
          sourceDelivered: integration.targetBranch === workspace.sourceBranch,
          taskWorktreeReclaimed,
          remotePushed: false,
          ...finalized,
        },
      });
      await db.save();
      publishRealtimeEvent('task.git_delivery.changed', { taskId: task.id, integrationId: integration.id, conversationId });
    } catch (error) {
      const stale = isStaleTaskIntegrationError(error) || taskGitErrorCode(error) === 'ZEUS_TASK_INTEGRATION_ATTEMPT_STALE';
      taskIntegrationAttempts.update(attempt.id, {
        state: stale ? 'preparing' : 'active',
        lastError: error instanceof Error ? error.message : 'AI 本地合入未完成。',
      });
      const latestIntegration = taskIntegrations.getById(attempt.integrationId);
      if (latestIntegration) {
        recordTaskEvent({
          taskId: latestIntegration.taskId,
          eventType: stale ? 'task.git_integration.ai_generation_advanced' : 'task.git_integration.ai_failed',
          title: stale ? '冲突处理：分支已推进，继续当前会话的下一执行代次' : '冲突处理：AI 本地合入未完成',
          payload: { integrationId: latestIntegration.id, attemptId: attempt.id, workspaceId: latestIntegration.workspaceId, conversationId, error: error instanceof Error ? error.message : 'AI 本地合入未完成。' },
        });
      }
      await db.save();
      if (latestIntegration) publishRealtimeEvent('task.git_delivery.changed', { taskId: latestIntegration.taskId, integrationId: latestIntegration.id, conversationId });
      if (stale && latestIntegration) {
        await cleanupTaskIntegrationAttemptWorktree(attempt.worktreePath, latestIntegration).catch(() => undefined);
        const conversation = conversations.getById(conversationId);
        const currentAttempt = taskIntegrationAttempts.getById(attempt.id);
        if (conversation && currentAttempt) await retryTaskIntegrationAiPreparation(conversation, currentAttempt);
      }
    }
  }

  async function cleanupTaskIntegrationAttemptWorktree(worktreePath: string, integration: ZeusTaskIntegrationRecord): Promise<void> {
    const workspace = taskWorkspaces.getById(integration.workspaceId);
    const project = projects.getById(integration.projectId);
    if (!workspace || !project || !existsSync(worktreePath)) return;
    await cleanupTaskIntegrationWorktree({ repositoryPath: workspace.repositoryPath || project.localPath, integrationPath: worktreePath });
  }

  async function finalizeLegacyTaskIntegrationAfterAi(integrationId: string, conversationId: string): Promise<void> {
    try {
      const currentIntegration = taskIntegrations.getById(integrationId);
      if (!currentIntegration || currentIntegration.state !== 'conflicted') return;
      const resolved = resolveTaskIntegrationRequest(currentIntegration.taskId, currentIntegration.id);
      if ('error' in resolved) throw nativeApiError(resolved.error.error, resolved.error.message);
      const { task, project, integration, workspace } = resolved;
      if (!integration.integrationPath) throw nativeApiError('ZEUS_TASK_INTEGRATION_PATH_UNAVAILABLE', 'Integration worktree is unavailable.');
      await assertTaskIntegrationStillCurrent(project, workspace, integration);
      await assertTaskIntegrationTargetWorktreeClean(project, workspace, integration.targetBranch);
      const commit = await completeTaskIntegrationCommit({
        integrationPath: integration.integrationPath,
        mode: integration.mode,
        commitMessage: `${task.taskCode}: 合入 ${workspace.branchName}`,
      });
      const finalized = await finalizeTaskBranchIntegration({
        repositoryPath: workspace.repositoryPath || project.localPath,
        integrationPath: integration.integrationPath,
        targetBranch: integration.targetBranch,
        targetHeadSha: integration.targetHeadSha,
        resultHeadSha: commit.resultHeadSha,
      });
      const pendingLocalSync = finalized.localSyncStatus === 'pending';
      taskIntegrations.update(integration.id, {
        integrationPath: pendingLocalSync ? integration.integrationPath : null,
        resultHeadSha: finalized.resultHeadSha,
        state: pendingLocalSync ? 'pending_local_sync' : 'merged',
        localSyncStatus: finalized.localSyncStatus,
        localHeadSha: finalized.localHeadSha,
        localWorktreePath: finalized.localWorktreePath,
        conflictFiles: [],
        lastError: null,
      });
      if (pendingLocalSync) {
        recordTaskEvent({
          taskId: task.id,
          eventType: 'task.git_integration.local_sync_pending',
          title: '冲突处理：AI 已解决冲突，合入结果等待同步到本地来源分支',
          payload: { integrationId: integration.id, workspaceId: workspace.id, conversationId, targetBranch: integration.targetBranch, resultHeadSha: finalized.resultHeadSha },
        });
        await db.save();
        publishRealtimeEvent('task.git_delivery.changed', { taskId: task.id, integrationId: integration.id, conversationId });
        return;
      }
      const taskWorktreeReclaimed = integration.targetBranch === workspace.sourceBranch ? await markTaskWorkspaceDelivered(workspace) : false;
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.git_integration.ai_merged',
        title: `冲突处理：AI 已完成本地合入 ${integration.targetBranch}`,
        payload: {
          integrationId: integration.id,
          workspaceId: workspace.id,
          conversationId,
          mode: integration.mode,
          sourceDelivered: integration.targetBranch === workspace.sourceBranch,
          taskWorktreeReclaimed,
          remotePushed: false,
          ...finalized,
        },
      });
      await db.save();
      publishRealtimeEvent('task.git_delivery.changed', { taskId: task.id, integrationId: integration.id, conversationId });
    } catch (error) {
      const integration = taskIntegrations.getById(integrationId);
      if (integration && integration.state !== 'merged') {
        taskIntegrations.update(integration.id, {
          state: isStaleTaskIntegrationError(error) ? 'failed' : 'conflicted',
          lastError: error instanceof Error ? error.message : 'AI 本地合入未完成。',
        });
        recordTaskEvent({
          taskId: integration.taskId,
          eventType: 'task.git_integration.ai_failed',
          title: '冲突处理：AI 本地合入未完成',
          payload: {
            integrationId: integration.id,
            workspaceId: integration.workspaceId,
            conversationId,
            error: error instanceof Error ? error.message : 'AI 本地合入未完成。',
          },
        });
        await db.save();
        publishRealtimeEvent('task.git_delivery.changed', { taskId: integration.taskId, integrationId: integration.id, conversationId });
      }
    }
  }

  return {
    taskPushRepositoryRevision,
    mapTaskRepositoriesWithConcurrency,
    countDirectProjectActiveWritableConversations,
    resolveTaskPushRepositoryCapability,
    resolveTaskPushExecutionCapabilities,
    resolveTaskPushEnvironment,
    assertTaskEnvironmentWritable,
    taskEnvironmentHasActiveWritableConversation,
    assertNestedTaskWorktreesReclaimed,
    nestedTaskWorkspacesWithWorktree,
    markTaskWorkspaceDelivered,
    reclaimDeferredDeliveredAncestors,
    reconcileTaskEnvironmentState,
    countTaskWorkspaceActiveConversations,
    taskWorkspaceIgnoredPaths,
    projectRepositoryIgnoredPaths,
    readTaskWorkspaceReview,
    summarizeBatchTaskWorkspaceResults,
    readTaskWorkspaceSnapshot,
    unavailableTaskWorkspaceSnapshot,
    listTaskWorkspaceConversations,
    inspectTaskTerminalCleanup,
    taskConversationHasActiveWork,
    closeTaskResourcesForTerminalStatus,
    resolveTaskWorkspaceRequest,
    resolveTaskIntegrationRequest,
    prepareWorkspaceGitCommand,
    executeWorkspaceGitCommand,
    requireWorkspaceGitIdentity,
    workspaceGitReject,
    isWorkspaceGitExplicitRejection,
    sendWorkspaceGitCommandError,
    workspaceGitResponse,
    requirePreparedProject,
    requirePreparedTask,
    requirePreparedWorkspace,
    requirePreparedIntegration,
    executeWorkspaceGitWorkbenchAction,
    executeWorkspaceGitCommitAll,
    executeWorkspaceGitPushAll,
    executeSingleTaskWorkspaceCommit,
    executeSingleTaskWorkspacePush,
    executeTaskWorkspaceStopSessions,
    executeTaskWorkspaceReclaim,
    executeTaskWorkspaceDiscard,
    reclaimPredictedDeliveredAncestors,
    applyDeferredAncestorReclaims,
    executeProjectGitSnapshotCommand,
    executeProjectGitPatchCommand,
    executeTaskPushRepositoryRefreshRemoteCommand,
    executeTaskWorkspaceIntegration,
    executeTaskIntegrationConflictAiSession,
    executeTaskIntegrationConflictResolve,
    executeTaskIntegrationFinalize,
    executeTaskIntegrationPush,
    assertTaskIntegrationStillCurrent,
    assertTaskIntegrationTargetWorktreeClean,
    isStaleTaskIntegrationError,
    sendTaskGitApiError,
    taskGitErrorCode,
    prepareTaskIntegrationAiAttempt,
    retryTaskIntegrationAiPreparation,
    failTaskIntegrationAiPreparation,
    scheduleTaskIntegrationAiFinalization,
    finalizeTaskIntegrationAfterAi,
    finalizeTaskIntegrationAttemptAfterAi,
    cleanupTaskIntegrationAttemptWorktree,
    finalizeLegacyTaskIntegrationAfterAi,
  };
}
