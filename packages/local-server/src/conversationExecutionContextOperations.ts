import { buildTaskEnvironmentRootPath, cleanupPreparedTaskWorktree, prepareTaskWorktree } from '@zeus/git-core';
import {
  ConversationRepository,
  ConversationSubmissionRepository,
  ProjectRepository,
  ProjectRepositoryRegistrationRepository,
  ProjectSharedPathRepository,
  TaskEnvironmentRepository,
  TaskIntegrationAttemptRepository,
  TaskIntegrationRepository,
  TaskRepository,
  TaskWorkspaceRepository,
  type ZeusConversationRecord,
  type ZeusDatabase,
  type ZeusProjectRecord,
  type ZeusProjectRepositoryRecord,
  type ZeusProjectSharedPathRecord,
  type ZeusTaskIntegrationRecord,
  type ZeusTaskRecord,
  type ZeusTaskWorkspaceRecord,
} from '@zeus/storage';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseJsonObject } from './localServerPlatformSupport.js';
import { isPathInsideRoot } from './conversationResourcePreview.js';
import { matchesTaskConflictAiConversationTitle } from './taskConflictAi.js';
export { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor, type ReadOnlyValidationApplicationIdentity } from './readOnlyValidation.js';
// 拆分期间保留结构化工厂依赖，后续按领域端口继续收窄。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConversationExecutionContextDependencies = Record<string, any> & {
  conversationSubmissions: ConversationSubmissionRepository;
  conversations: ConversationRepository;
  db: ZeusDatabase;
  isNativeApiRecord(value: unknown): value is Record<string, unknown>;
  projectRepositories: ProjectRepositoryRegistrationRepository;
  projectSharedPaths: ProjectSharedPathRepository;
  projects: ProjectRepository;
  taskEnvironments: TaskEnvironmentRepository;
  taskIntegrationAttempts: TaskIntegrationAttemptRepository;
  taskIntegrations: TaskIntegrationRepository;
  taskWorkspaces: TaskWorkspaceRepository;
  tasks: TaskRepository;
};

export function createConversationExecutionContextOperations(dependencies: ConversationExecutionContextDependencies) {
  const {
    conversationSubmissions,
    conversations,
    db,
    isNativeApiRecord,
    nativeApiError,
    projectRepositories,
    projectRoot,
    projectSharedPaths,
    projects,
    recordTaskEvent,
    resolveTaskManagementStatusConfigForProject,
    taskConflictAiOperations,
    taskConversationExecutionContextPromises,
    taskConversationReopenInProgressIds,
    taskEnvironments,
    taskIntegrationAttempts,
    taskIntegrations,
    taskWorkspaces,
    tasks,
  } = dependencies;
  function taskManagementStatusIsTerminal(task: Pick<ZeusTaskRecord, 'projectId' | 'managementStatus'>): boolean {
    const config = resolveTaskManagementStatusConfigForProject(task.projectId);
    return task.managementStatus === config.roles.completedStatusId || task.managementStatus === config.roles.cancelledStatusId;
  }
  function taskConflictExecutionForConversation(conversation: ZeusConversationRecord): { operationId: string; integration: ZeusTaskIntegrationRecord; worktreePath: string } | null {
    const persistedAttempt = taskIntegrationAttempts.getByConversationId(conversation.id);
    if (persistedAttempt) {
      const integration = taskIntegrations.getById(persistedAttempt.integrationId);
      return integration ? { operationId: persistedAttempt.id, integration, worktreePath: persistedAttempt.worktreePath } : null;
    }
    const tracked = [...taskConflictAiOperations.entries()].find(([, operation]) => operation.conversationId === conversation.id);
    if (tracked) {
      const attempt = taskIntegrationAttempts.getById(tracked[0]);
      const integration = taskIntegrations.getById(attempt?.integrationId ?? tracked[0]);
      const worktreePath = attempt?.worktreePath ?? integration?.integrationPath;
      if (integration && worktreePath) return { operationId: tracked[0], integration, worktreePath };
    }
    if (!conversation.taskId || !conversation.workspaceId) return null;
    const workspace = taskWorkspaces.getById(conversation.workspaceId);
    if (!workspace) return null;
    const taskTitle = tasks.getById(conversation.taskId)?.title;
    const integration = taskIntegrations.listByTask(conversation.taskId).find(
      (candidate) =>
        candidate.workspaceId === conversation.workspaceId &&
        candidate.state === 'conflicted' &&
        Boolean(candidate.integrationPath) &&
        matchesTaskConflictAiConversationTitle({
          title: conversation.title,
          taskTitle,
          taskBranch: workspace.branchName,
          sourceBranch: candidate.targetBranch,
        }),
    );
    return integration?.integrationPath ? { operationId: integration.id, integration, worktreePath: integration.integrationPath } : null;
  }

  function taskConversationExecutionWorkspaceMode(conversation: ZeusConversationRecord, project: ZeusProjectRecord | undefined): 'direct' | 'worktree' | null {
    const submissions = [...conversationSubmissions.listByConversation(conversation.id)].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    for (const submission of submissions) {
      const input = parseJsonObject(submission.inputJson);
      const context = isNativeApiRecord(input.context) ? input.context : null;
      if (context?.executionWorkspaceMode === 'direct' || context?.executionWorkspaceMode === 'worktree') {
        return context.executionWorkspaceMode;
      }
    }
    // 旧 Worktree 会话已有精确工作区身份，可以安全沿用并在后续复验真实目录。
    if (conversation.workspaceId || conversation.environmentId) return 'worktree';
    if (!project) return null;
    const initialSubmission = submissions.at(-1);
    const initialInput = initialSubmission ? parseJsonObject(initialSubmission.inputJson) : {};
    const initialContext = isNativeApiRecord(initialInput.context) ? initialInput.context : null;
    const taskPushLayout = isNativeApiRecord(initialInput.taskPushLayout) ? initialInput.taskPushLayout : null;
    const persistedPath = typeof initialContext?.projectLocalPath === 'string' ? resolve(initialContext.projectLocalPath) : null;
    if (taskPushLayout?.kind === 'task_push' && persistedPath === resolve(project.localPath)) {
      // 兼容修复前已经持久接受的直接目录首发；仅凭缺少 workspace 记录不能获得此身份。
      return 'direct';
    }
    return null;
  }

  function resolveNativeConversationExecutionRoot(conversation: ZeusConversationRecord): string | null {
    const contextualSubmission = conversationSubmissions.listByConversation(conversation.id).find((submission) => {
      const context = parseJsonObject(submission.inputJson).context;
      return isNativeApiRecord(context) && typeof context.projectLocalPath === 'string' && Boolean(context.projectLocalPath.trim());
    });
    const persistedContext = contextualSubmission ? parseJsonObject(contextualSubmission.inputJson).context : undefined;
    const workspace = conversation.workspaceId ? taskWorkspaces.getById(conversation.workspaceId) : undefined;
    /** 旧会话可能仅由工作区关联环境；路径查询与实际恢复必须读取同一身份。 */
    const environmentId = conversation.environmentId ?? workspace?.environmentId;
    const environment = environmentId ? taskEnvironments.getById(environmentId) : undefined;
    const project = projects.getById(conversation.projectId);
    if (conversation.taskId) {
      const conflictExecution = taskConflictExecutionForConversation(conversation);
      if (conflictExecution) return existsSync(conflictExecution.worktreePath) ? resolve(conflictExecution.worktreePath) : null;
      const executionMode = taskConversationExecutionWorkspaceMode(conversation, project);
      if (executionMode === 'direct') {
        const projectPath = project?.localPath ? resolve(project.localPath) : null;
        return projectPath && existsSync(projectPath) && statSync(projectPath).isDirectory() ? projectPath : null;
      }
      /** 目录暂时不存在仍保留隔离身份，不能把排队快照冻结到项目主目录。 */
      const task = tasks.getById(conversation.taskId);
      if (!project || !task || !workspace || executionMode !== 'worktree') return null;
      /** 和实际恢复采用同一原路径或确定性重建路径。 */
      const executionRoot = resolve(environment?.rootPath || (!environment ? workspace.worktreePath : null) || buildTaskEnvironmentRootPath(project.localPath, project.slug, task.taskCode, environment?.id ?? workspace.id));
      return executionRoot !== resolve(project.localPath) && isPathInsideRoot(executionRoot, join(dirname(resolve(project.localPath)), '.zeus-worktrees')) ? executionRoot : null;
    }
    return isNativeApiRecord(persistedContext) && typeof persistedContext.projectLocalPath === 'string' && persistedContext.projectLocalPath.trim()
      ? persistedContext.projectLocalPath
      : workspace?.worktreePath
        ? workspace.worktreePath
        : environment?.rootPath
          ? environment.rootPath
          : conversation.taskId
            ? null
            : (project?.localPath ?? projectRoot);
  }

  async function ensureNativeConversationExecutionContext(input: {
    conversationId: string;
    mode: 'reconcile' | 'submit' | 'dispatch' | 'recover_queue' | 'restore';
  }): Promise<{ projectLocalPath: string; writableRoots: string[]; executionWorkspaceMode?: 'direct' | 'worktree' } | null> {
    const lockConversation = conversations.getById(input.conversationId);
    if (!lockConversation) return null;
    // 共用目录准备可以合并，但各会话自己的归档边界不能被另一条会话的并发恢复绕过。
    if (lockConversation.archived) {
      if (input.mode !== 'restore') throw nativeApiError('ZEUS_NATIVE_QUEUE_PROVIDER_ARCHIVED', '会话已归档，请先恢复会话再继续。');
      /** 已归档会话仍沿用任务重新打开流程。 */
      const task = lockConversation.taskId ? tasks.getById(lockConversation.taskId) : undefined;
      if (task && taskManagementStatusIsTerminal(task) && !taskConversationReopenInProgressIds.has(lockConversation.id)) {
        throw nativeApiError('ZEUS_TASK_REOPEN_REQUIRED', '请先重新打开任务并恢复这条已归档会话。');
      }
    }
    const lockKey = `${lockConversation?.projectId ?? 'conversation'}:${lockConversation?.environmentId ?? lockConversation?.workspaceId ?? input.conversationId}`;
    const existing = taskConversationExecutionContextPromises.get(lockKey);
    if (existing) return existing;
    const promise = (async () => {
      const conversation = conversations.getById(input.conversationId);
      if (!conversation) return null;
      // 归档是产品会话的继续边界；Provider 内部归档和任务状态不代替这个判断。
      if (conversation.archived && input.mode !== 'restore') throw nativeApiError('ZEUS_NATIVE_QUEUE_PROVIDER_ARCHIVED', '会话已归档，请先恢复会话再继续。');
      if (!conversation.taskId) {
        /** 项目会话同样使用所属项目或已记录的路径，Pi 重启后不能退回宿主启动目录。 */
        const executionRoot = resolveNativeConversationExecutionRoot(conversation);
        if (!executionRoot || !existsSync(executionRoot) || !statSync(executionRoot).isDirectory()) throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', '会话工作目录不存在或不可用。');
        return { projectLocalPath: resolve(executionRoot), writableRoots: [resolve(executionRoot)] };
      }
      const project = projects.getById(conversation.projectId);
      const task = tasks.getById(conversation.taskId);
      const workspace = conversation.workspaceId ? taskWorkspaces.getById(conversation.workspaceId) : undefined;
      const environmentId = conversation.environmentId ?? workspace?.environmentId ?? null;
      const environment = environmentId ? taskEnvironments.getById(environmentId) : undefined;
      if (!project || !task) {
        throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', 'The task conversation no longer has a recoverable task workspace.');
      }
      const executionMode = taskConversationExecutionWorkspaceMode(conversation, project);
      if (executionMode === 'direct') {
        if (workspace || environment) {
          throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', 'The direct-directory conversation conflicts with a persisted task workspace.');
        }
        const projectPath = resolve(project.localPath);
        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', 'The direct project directory is unavailable for this conversation.');
        }
        return {
          projectLocalPath: projectPath,
          writableRoots: [projectPath],
          executionWorkspaceMode: 'direct' as const,
        };
      }
      if (!workspace || executionMode !== 'worktree') {
        throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', 'The task conversation no longer has a recoverable task workspace.');
      }
      const conflictExecution = taskConflictExecutionForConversation(conversation);
      if (conflictExecution && !existsSync(conflictExecution.worktreePath)) {
        throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', 'The isolated conflict attempt is no longer writable.');
      }
      if (conflictExecution) {
        const latestSubmission = conversationSubmissions.listByConversation(conversation.id).at(-1);
        const operation = taskConflictAiOperations.get(conflictExecution.operationId);
        if (!operation) {
          taskConflictAiOperations.set(conflictExecution.operationId, {
            conversationId: conversation.id,
            submissionId: latestSubmission?.id ?? '',
            running:
              conversation.providerState === 'binding' ||
              conversation.providerState === 'active' ||
              conversation.providerState === 'waiting' ||
              latestSubmission?.status === 'queued' ||
              latestSubmission?.status === 'dispatching' ||
              latestSubmission?.status === 'active',
            finalizing: false,
          });
        }
        return {
          projectLocalPath: resolve(conflictExecution.worktreePath),
          writableRoots: [resolve(conflictExecution.worktreePath)],
          executionWorkspaceMode: 'worktree' as const,
        };
      }
      if (workspace.state === 'discarded' || environment?.state === 'failed') {
        throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', 'The task workspace was discarded and cannot be restored for this conversation.');
      }
      const members = environment ? taskWorkspaces.listByEnvironment(environment.id) : [workspace];
      if (members.length === 0 || members.some((member) => member.state === 'discarded')) {
        throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', 'The task environment has no recoverable repository workspace.');
      }
      const projectRoot = resolve(project.localPath);
      const worktreeContainerRoot = resolve(join(dirname(projectRoot), '.zeus-worktrees'));
      /** 与入队时冻结的路径一致，旧式单仓会话也优先沿用登记的工作区。 */
      const environmentRoot = resolveNativeConversationExecutionRoot(conversation);
      if (!environmentRoot || environmentRoot === projectRoot || !isPathInsideRoot(environmentRoot, worktreeContainerRoot)) {
        throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', 'The recorded task workspace path is unsafe; Zeus will not use the project root as a fallback.');
      }

      const registeredRepositories = projectRepositories.listByProject(project.id);
      const sharedPaths = projectSharedPaths.listByProject(project.id);
      const needsEnvironmentContainer = members.length > 1 || members.some((member) => member.repositoryRelativePath !== '.') || sharedPaths.length > 0;
      const createdEnvironmentRoot = needsEnvironmentContainer && !existsSync(environmentRoot);
      const prepared: Array<{ workspace: ZeusTaskWorkspaceRecord; prepared: Awaited<ReturnType<typeof prepareTaskWorktree>> }> = [];
      try {
        if (createdEnvironmentRoot) {
          mkdirSync(environmentRoot, { recursive: true });
          mirrorTaskEnvironmentContainer(project, environmentRoot, registeredRepositories, sharedPaths);
        } else if (needsEnvironmentContainer) {
          mkdirSync(environmentRoot, { recursive: true });
        }
        for (const member of members) {
          const repositoryPath = resolve(member.repositoryPath || project.localPath);
          const memberRelativePath = member.repositoryRelativePath || '.';
          const memberWorktreePath = resolve(join(environmentRoot, memberRelativePath));
          if (memberWorktreePath === projectRoot || !isPathInsideRoot(memberWorktreePath, worktreeContainerRoot)) {
            throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', `Task workspace path is outside the isolated worktree root: ${memberRelativePath}`);
          }
          const sourceRef = member.sourceHeadSha || member.headSha;
          if (!sourceRef) throw nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', `Task workspace has no recoverable source commit: ${member.branchName}`);
          const restored = await prepareTaskWorktree({
            repositoryPath,
            projectSlug: project.slug,
            taskCode: task.taskCode,
            taskTitle: task.title,
            workspaceId: member.id,
            branchName: member.branchName,
            sourceRef,
            sourceBranch: member.sourceBranch,
            existingBranch: true,
            // 只处理已结束工作区在原登记位置留下的回收残留；普通工作区仍拒绝目录占用。
            preserveUnregisteredDirectory: (member.state === 'merged' || member.state === 'reclaimed') && member.worktreePath !== null && resolve(member.worktreePath) === memberWorktreePath,
            ...(member.remoteName && member.remoteBranch ? { existingRemoteRef: `${member.remoteName}/${member.remoteBranch}` } : {}),
            worktreePath: memberWorktreePath,
          });
          prepared.push({ workspace: member, prepared: restored });
          if (restored.preservedDirectory) {
            recordTaskEvent({
              taskId: task.id,
              eventType: 'task.conversation.worktree.preserved',
              title: `任务工作区按分支恢复，原目录已保留：${restored.preservedDirectory}`,
              payload: { conversationId: conversation.id, workspaceId: member.id, worktreePath: restored.worktreePath, preservedDirectory: restored.preservedDirectory },
            });
          }
        }
        if (needsEnvironmentContainer) overlayTaskEnvironmentSharedPaths(environmentRoot, sharedPaths);
      } catch (error) {
        for (const entry of [...prepared].reverse()) {
          if (entry.prepared.reused) continue;
          await cleanupPreparedTaskWorktree({
            repositoryPath: entry.workspace.repositoryPath || project.localPath,
            worktreePath: entry.prepared.worktreePath,
            branchName: entry.workspace.branchName,
            removeBranch: false,
          }).catch(() => undefined);
        }
        if (createdEnvironmentRoot) rmSync(environmentRoot, { recursive: true, force: true });
        const detail = error instanceof Error ? error.message : String(error);
        throw Object.assign(nativeApiError('ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE', `The task conversation worktree could not be restored: ${detail}`), { cause: error });
      }

      const updatedWorkspaces = db.transaction(() => {
        if (environment) taskEnvironments.update(environment.id, { rootPath: environmentRoot, state: 'ready', lastError: null });
        return prepared.map(({ workspace, prepared: restored }) => taskWorkspaces.update(workspace.id, { worktreePath: restored.worktreePath, headSha: restored.headSha, state: 'ready', lastError: null }));
      });
      await db.save();
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.conversation.worktree.rehydrated',
        title: '任务会话工作区已恢复',
        payload: {
          conversationId: conversation.id,
          environmentId: environment?.id ?? null,
          workspaces: updatedWorkspaces.map((entry) => ({ workspaceId: entry.id, branchName: entry.branchName, worktreePath: entry.worktreePath })),
        },
      });
      const writableRoots = environment ? resolveTaskEnvironmentWritableRoots(project, updatedWorkspaces) : updatedWorkspaces.flatMap((entry) => (entry.worktreePath ? [entry.worktreePath] : []));
      return {
        projectLocalPath: environment ? environmentRoot : resolve(updatedWorkspaces[0]?.worktreePath ?? environmentRoot),
        writableRoots,
        executionWorkspaceMode: 'worktree' as const,
      };
    })();
    taskConversationExecutionContextPromises.set(lockKey, promise);
    try {
      return await promise;
    } finally {
      if (taskConversationExecutionContextPromises.get(lockKey) === promise) taskConversationExecutionContextPromises.delete(lockKey);
    }
  }

  function resolveTaskEnvironmentWritableRoots(project: ZeusProjectRecord, workspaces: ZeusTaskWorkspaceRecord[]): string[] {
    const repositoryRoots = workspaces.flatMap((workspace) => (workspace.worktreePath ? [workspace.worktreePath] : []));
    const sharedRoots = projectSharedPaths.listByProject(project.id).map((entry) => entry.localPath);
    return Array.from(new Set(workspaces.length === 0 ? [project.localPath, ...sharedRoots] : [...repositoryRoots, ...sharedRoots]));
  }

  /**
   * 在任务环境中保留项目容器的相对布局：仓库位置留给 Git worktree，
   * 共享可写目录和其他非 Git 内容使用符号链接保持单一真实来源。
   */
  function mirrorTaskEnvironmentContainer(project: ZeusProjectRecord, environmentRoot: string, repositories: ZeusProjectRepositoryRecord[], sharedPaths: ZeusProjectSharedPathRecord[]): void {
    const repositoryPaths = new Set(repositories.map((entry) => entry.relativePath));
    const sharedByPath = new Map(sharedPaths.map((entry) => [entry.relativePath, entry]));
    const memberPaths = [...repositoryPaths, ...sharedByPath.keys()];

    const visit = (sourcePath: string, targetPath: string, relativePath: string): void => {
      const normalizedRelativePath = relativePath.split(sep).join('/') || '.';
      if (repositoryPaths.has(normalizedRelativePath)) return;
      const shared = sharedByPath.get(normalizedRelativePath);
      if (shared) {
        mkdirSync(dirname(targetPath), { recursive: true });
        symlinkSync(shared.localPath, targetPath, 'dir');
        return;
      }
      const prefix = normalizedRelativePath === '.' ? '' : `${normalizedRelativePath}/`;
      const containsMember = memberPaths.some((memberPath) => prefix === '' || memberPath.startsWith(prefix));
      if (normalizedRelativePath !== '.' && !containsMember) {
        mkdirSync(dirname(targetPath), { recursive: true });
        const entry = lstatSync(sourcePath);
        symlinkSync(sourcePath, targetPath, entry.isDirectory() ? 'dir' : 'file');
        return;
      }
      mkdirSync(targetPath, { recursive: true });
      for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === '.zeus-worktrees') continue;
        const childRelativePath = normalizedRelativePath === '.' ? entry.name : `${normalizedRelativePath}/${entry.name}`;
        visit(join(sourcePath, entry.name), join(targetPath, entry.name), childRelativePath);
      }
    };

    visit(project.localPath, environmentRoot, '.');
  }

  /** 共享目录覆盖任务 worktree 中的同名路径，始终指向项目里的持久真实目录。 */
  function overlayTaskEnvironmentSharedPaths(environmentRoot: string, sharedPaths: ZeusProjectSharedPathRecord[]): void {
    for (const sharedPath of sharedPaths) {
      const targetPath = join(environmentRoot, sharedPath.relativePath);
      rmSync(targetPath, { recursive: true, force: true });
      mkdirSync(dirname(targetPath), { recursive: true });
      symlinkSync(sharedPath.localPath, targetPath, 'dir');
    }
  }

  return {
    resolveTaskEnvironmentWritableRoots,
    mirrorTaskEnvironmentContainer,
    overlayTaskEnvironmentSharedPaths,
    taskManagementStatusIsTerminal,
    taskConflictExecutionForConversation,
    taskConversationExecutionWorkspaceMode,
    resolveNativeConversationExecutionRoot,
    ensureNativeConversationExecutionContext,
  };
}
