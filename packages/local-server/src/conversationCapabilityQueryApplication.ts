import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { buildAiRuntimePrompt, type CodexAccountSnapshot, type CodexCapabilitiesSnapshot, type CodexTransportState, type ProjectModelSelection, type SelectableConnectionModel } from '@zeus/ai-runtime';
import { buildTaskBranchName, buildTaskBranchPrefix, type GitRepositoryContext } from '@zeus/git-core';
import type {
  ConversationRepository,
  ConversationSubmissionRepository,
  ProjectRepository,
  ProjectRepositoryRegistrationRepository,
  ProjectSharedPathRepository,
  TaskEnvironmentRepository,
  TaskRepository,
  TaskWorkspaceRepository,
  ZeusConversationWithMessagesRecord,
  ZeusProjectRecord,
  ZeusProjectRepositoryRecord,
  ZeusTaskRecord,
} from '@zeus/storage';

interface TaskPushContextProjection {
  revision: string;
  current: { options: unknown[] };
  parent: { options: unknown[] };
  related: { options: unknown[] };
}

export interface ExistingProviderCapabilityReadPort {
  /** 只观察既有 transport；GET 路径禁止 ensureReady/activateFreshGeneration。 */
  getState(): CodexTransportState;
  /** 仅 transport 已 ready 时允许读取既有账户快照，不得刷新 token。 */
  readAccount(): Promise<CodexAccountSnapshot>;
}

export interface TaskPushGitReadPort {
  /** 只读 Git 上下文；不得 fetch 或改变 refs/index/worktree。 */
  readRepositoryContext(localPath: string): Promise<GitRepositoryContext>;
  readWorktreeClean(localPath: string, ignoredPaths: string[]): Promise<boolean>;
}

interface ConversationCapabilityQueryPorts {
  projects: Pick<ProjectRepository, 'getById'>;
  tasks: Pick<TaskRepository, 'getById'>;
  repositories: Pick<ProjectRepositoryRegistrationRepository, 'listByProject'>;
  sharedPaths: Pick<ProjectSharedPathRepository, 'listByProject'>;
  environments: Pick<TaskEnvironmentRepository, 'listByTask'>;
  workspaces: Pick<TaskWorkspaceRepository, 'getByRepositoryBranch' | 'listByEnvironment'>;
  conversations: Pick<ConversationRepository, 'listByProject' | 'listByEnvironment'>;
  submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>;
  provider: ExistingProviderCapabilityReadPort;
  modelCatalog: {
    getProjectSelection(projectId: string): Promise<ProjectModelSelection>;
    listSelectableModels(): Promise<SelectableConnectionModel[]>;
  };
  git: TaskPushGitReadPort;
  taskContext: {
    read(project: ZeusProjectRecord, task: ZeusTaskRecord): TaskPushContextProjection;
    readAttachmentOptions(project: ZeusProjectRecord, task: ZeusTaskRecord): unknown[];
  };
  readConfiguredModel(projectId: string): string | null;
  codexNativeEnabled(): boolean;
  now(): Date;
}

export interface ConversationCapabilityModel {
  id: string;
  model: string;
  displayName?: string;
  agentKind: 'codex' | 'pi';
  sourceId: string;
  sourceName: string;
  available: boolean;
  availabilityReason: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string | null;
  serviceTiers: Array<{ id: string; name?: string; description?: string }>;
  defaultServiceTier?: string | null;
  supports1MContext: boolean;
  contextWindow: number | null;
  speedLabel?: unknown;
  tools?: unknown;
  imageInput?: unknown;
  runtimeAdapter?: unknown;
  protocolFamily?: unknown;
  authenticationScheme?: unknown;
}

export interface ConversationCapabilitiesSnapshot {
  generationId: string;
  initializedAt: string;
  projectId: string;
  preferredModel: string | null;
  models: ConversationCapabilityModel[];
  codexAccount: CodexAccountSnapshot | UnavailableCodexAccount;
  goals: CodexCapabilitiesSnapshot['goals'];
  available?: false;
  availabilityReason?: string;
}

export interface DigitalEmployeeCapabilitiesSnapshot {
  generationId: string;
  initializedAt: string;
  models: ConversationCapabilityModel[];
  available?: false;
  availabilityReason?: string;
}

export interface UnavailableCodexAccount {
  generationId: 'codex-unavailable';
  requiresOpenaiAuth: false;
  signedIn: false;
  accountType: null;
  planType: null;
}

/** 会话与任务推送能力查询拥有者：聚合复制库、既有 Provider 世代和只读 Git 端口。 */
export class ConversationCapabilityQueryApplication {
  constructor(private readonly ports: ConversationCapabilityQueryPorts) {}

  async readConversation(projectId: string): Promise<ConversationCapabilitiesSnapshot> {
    return this.readExisting(this.requireProject(projectId));
  }

  /** 全局模板只读取既有能力目录；不得为了展示配置而启动 Provider。 */
  async readDigitalEmployee(): Promise<DigitalEmployeeCapabilitiesSnapshot> {
    const transport = this.ports.provider.getState();
    const codexCapabilities = this.ports.codexNativeEnabled() && transport.type === 'ready' ? transport.capabilities : null;
    const models = mapConversationCapabilityModels(codexCapabilities, await this.ports.modelCatalog.listSelectableModels());
    const snapshot = {
      generationId: codexCapabilities?.generationId ?? 'pi-sdk',
      initializedAt: codexCapabilities?.initializedAt ?? this.ports.now().toISOString(),
      models,
    };
    return models.length > 0 ? snapshot : { ...snapshot, available: false, availabilityReason: '当前没有已就绪的 Provider 模型；GET 不会为了读取能力而启动 Provider。' };
  }

  async readTaskPush(projectId: string, rawTaskId: string | undefined): Promise<Record<string, unknown>> {
    const project = this.requireProject(projectId);
    const taskId = rawTaskId?.trim();
    if (!taskId) throw queryError('ZEUS_TASK_ID_REQUIRED', 'taskId is required', 400);
    const task = this.ports.tasks.getById(taskId);
    if (!task || task.projectId !== project.id) throw queryError('ZEUS_TASK_NOT_FOUND', 'Task not found', 404);
    const taskContext = this.ports.taskContext.read(project, task);
    const currentAttachmentOptions = this.ports.taskContext.readAttachmentOptions(project, task);
    // GET 只消费已登记仓库；仓库发现、登记、fetch 与工作区准备仍属于显式 Command。
    const registeredRepositories = this.ports.repositories.listByProject(project.id);
    // Git、任务上下文和 Worktree 选择不能等待 Provider 账户通道。账户状态由独立的
    // 会话能力请求在后台读取；真正提交时仍由服务端权威校验登录状态。
    const [capabilities, repositoryCapabilities] = await Promise.all([
      this.readExisting(project, { readProviderAccount: false }),
      mapWithConcurrency(registeredRepositories, (repository) => this.readRepositoryCapability(project, task, repository)),
    ]);
    const primaryRepository = repositoryCapabilities[0];
    const existingEnvironments = this.ports.environments.listByTask(task.id).flatMap((environment) => {
      if (environment.state === 'reclaimed') return [];
      const members = this.ports.workspaces.listByEnvironment(environment.id).filter((workspace) => workspace.kind === 'task');
      if (members.length === 0) return [];
      const hasClosedWorkspace = members.some((workspace) => workspace.state === 'merged' || workspace.state === 'discarded');
      const activeConversationIds = this.activeWritableEnvironmentConversationIds(environment.id);
      const hasActiveConversation = activeConversationIds.length > 0;
      return [
        {
          id: environment.id,
          available: !hasClosedWorkspace && !hasActiveConversation,
          unavailableReason: hasClosedWorkspace ? ('closed_workspace' as const) : hasActiveConversation ? ('active_conversation' as const) : null,
          activeConversationIds,
          repositories: members
            .map((workspace) => ({
              repositoryId: workspace.repositoryId,
              repositoryName: workspace.repositoryName,
              repositoryRelativePath: workspace.repositoryRelativePath,
              branchName: workspace.branchName,
              sourceBranch: workspace.sourceBranch,
            }))
            .sort((left, right) => left.repositoryRelativePath.localeCompare(right.repositoryRelativePath)),
          createdAt: environment.createdAt,
          updatedAt: environment.updatedAt,
        },
      ];
    });
    return {
      ...capabilities,
      taskId: task.id,
      canonicalPrompt: createTaskRuntimePrompt(task),
      taskContextRevision: taskContext.revision,
      parentContextRevision: taskContext.revision,
      currentConversationOptions: taskContext.current.options,
      parentContextOptions: taskContext.parent.options,
      relatedContextOptions: taskContext.related.options,
      currentAttachmentOptions,
      repositoryRevision: repositoryRevision(registeredRepositories),
      repositories: repositoryCapabilities,
      directWorkspace: {
        path: project.localPath,
        activeWritableConversationCount: this.countDirectProjectActiveWritableConversations(project.id),
      },
      existingEnvironments,
      sharedWritablePaths: this.ports.sharedPaths.listByProject(project.id),
      git: {
        primaryWorkspacePath: primaryRepository?.localPath ?? project.localPath,
        primaryBranch: primaryRepository?.branch ?? '',
        primaryHeadSha: primaryRepository?.headSha ?? '',
        primaryClean: primaryRepository?.clean ?? true,
        defaultRemoteName: primaryRepository?.defaultRemoteName ?? '',
        sourceRefs: primaryRepository?.sourceRefs ?? [],
        suggestedBranchName: buildTaskBranchName(task.taskCode, task.title, this.ports.environments.listByTask(task.id).length + 1),
        worktreeRoot: join(dirname(project.localPath), '.zeus-worktrees'),
      },
    };
  }

  unavailableCodexAccount(): UnavailableCodexAccount {
    return { generationId: 'codex-unavailable', requiresOpenaiAuth: false, signedIn: false, accountType: null, planType: null };
  }

  async buildConversationCapabilities(project: ZeusProjectRecord, codexCapabilities: CodexCapabilitiesSnapshot | null, codexAccount: CodexAccountSnapshot | UnavailableCodexAccount): Promise<ConversationCapabilitiesSnapshot> {
    const connectionSelection = await this.ports.modelCatalog.getProjectSelection(project.id);
    const connectionCatalog = await this.ports.modelCatalog.listSelectableModels();
    const allowedConnectionModels = connectionCatalog.filter((model) => connectionSelection.allowedModelRefs.includes(model.id));
    const models = mapConversationCapabilityModels(codexCapabilities, allowedConnectionModels);
    if (models.length === 0) throw queryError('ZEUS_MODEL_UNAVAILABLE', '当前项目没有可用的 Codex 或 Pi 模型。');
    const configuredModel = this.ports.readConfiguredModel(project.id);
    const preferredModel =
      models.find((candidate) => candidate.id === connectionSelection.defaultModelRef && candidate.available !== false)?.id ??
      resolveModelCapability(
        models.filter((candidate) => candidate.available !== false),
        configuredModel,
      )?.id ??
      models.find((candidate) => candidate.available !== false)?.id ??
      models[0]!.id;
    return {
      generationId: codexCapabilities?.generationId ?? 'pi-sdk',
      initializedAt: codexCapabilities?.initializedAt ?? this.ports.now().toISOString(),
      projectId: project.id,
      preferredModel,
      models,
      codexAccount,
      goals: codexCapabilities?.goals ?? { supported: false, enabled: false, stage: null },
    };
  }

  private async readExisting(project: ZeusProjectRecord, options: { readProviderAccount?: boolean } = {}): Promise<ConversationCapabilitiesSnapshot> {
    const transport = this.ports.provider.getState();
    const codexCapabilities = this.ports.codexNativeEnabled() && transport.type === 'ready' ? transport.capabilities : null;
    const codexAccount = codexCapabilities && options.readProviderAccount !== false ? await this.ports.provider.readAccount() : this.unavailableCodexAccount();
    try {
      return await this.buildConversationCapabilities(project, codexCapabilities, codexAccount);
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ZEUS_MODEL_UNAVAILABLE') throw error;
      return {
        generationId: codexCapabilities?.generationId ?? 'provider-unavailable',
        initializedAt: codexCapabilities?.initializedAt ?? this.ports.now().toISOString(),
        projectId: project.id,
        preferredModel: null,
        models: [],
        codexAccount,
        goals: codexCapabilities?.goals ?? { supported: false, enabled: false, stage: null },
        available: false,
        availabilityReason: '当前没有已就绪的 Provider 模型；GET 不会为了读取能力而启动 Provider。',
      };
    }
  }

  private async readRepositoryCapability(project: ZeusProjectRecord, task: ZeusTaskRecord, registered: ZeusProjectRepositoryRecord) {
    const repository = await this.ports.git.readRepositoryContext(registered.localPath);
    const clean = await this.ports.git.readWorktreeClean(registered.localPath, this.repositoryIgnoredPaths(project.id, registered.id, registered.localPath));
    if (!repository.isRepository) throw queryError('ZEUS_PROJECT_REPOSITORY_UNAVAILABLE', `Project repository is unavailable: ${registered.relativePath}`);
    const defaultRemoteName = repository.remotes.includes('origin') ? 'origin' : (repository.remotes[0] ?? '');
    const sourceRefs = [
      ...repository.localBranches.map((branch) => ({ ref: `refs/heads/${branch}`, label: branch, kind: 'local' as const, group: 'local', current: branch === repository.branch })),
      ...repository.remoteBranches.map((ref) => {
        const separator = ref.indexOf('/');
        const remoteName = separator > 0 ? ref.slice(0, separator) : defaultRemoteName;
        const branch = separator > 0 ? ref.slice(separator + 1) : ref;
        return { ref: `refs/remotes/${ref}`, label: branch, kind: 'remote' as const, group: remoteName || 'remote', current: false };
      }),
    ];
    const localTaskBranches = repository.localBranches
      .filter((branchName) => branchName.startsWith(buildTaskBranchPrefix(task.taskCode)))
      .map((branchName) => {
        const managed = this.ports.workspaces.getByRepositoryBranch(registered.id, branchName);
        const checkedOut = repository.worktrees.find((worktree) => worktree.branch === branchName);
        return {
          branchName,
          available: !managed && !checkedOut,
          unavailableReason: managed ? ('managed_environment' as const) : checkedOut ? ('checked_out' as const) : null,
          worktreePath: checkedOut?.path ?? null,
        };
      });
    return {
      ...registered,
      branch: repository.branch,
      headSha: repository.headSha,
      clean,
      defaultRemoteName,
      remoteRefreshStatus: 'not_requested' as const,
      remoteRefreshError: null,
      sourceRefs,
      localTaskBranches,
      suggestedBranchName: buildTaskBranchName(task.taskCode, task.title, this.ports.environments.listByTask(task.id).length + 1),
    };
  }

  private repositoryIgnoredPaths(projectId: string, repositoryId: string, repositoryPath: string): string[] {
    const nestedRepositories = this.ports.repositories
      .listByProject(projectId)
      .filter((entry) => entry.id !== repositoryId && isPathInsideRoot(entry.localPath, repositoryPath))
      .map((entry) => entry.localPath);
    const sharedPaths = this.ports.sharedPaths
      .listByProject(projectId)
      .filter((entry) => isPathInsideRoot(entry.localPath, repositoryPath))
      .map((entry) => entry.localPath);
    return [...new Set([...nestedRepositories, ...sharedPaths].map((localPath) => relative(repositoryPath, localPath).split(sep).join('/')).filter((path) => Boolean(path) && path !== '.'))];
  }

  private activeWritableEnvironmentConversationIds(environmentId: string): string[] {
    return this.ports.conversations
      .listByEnvironment(environmentId)
      .filter((conversation) => conversation.providerState === 'binding' || conversation.providerState === 'active' || conversation.providerState === 'waiting')
      .map((conversation) => conversation.id);
  }

  private countDirectProjectActiveWritableConversations(projectId: string): number {
    let offset = 0;
    let count = 0;
    while (true) {
      const page = this.ports.conversations.listByProject(projectId, { limit: 100, offset });
      count += page.items.filter((conversation) => {
        if (conversation.workspaceId || conversation.environmentId || conversation.permissionMode === 'read-only') return false;
        return this.conversationHasActiveWork(conversation);
      }).length;
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) return count;
    }
  }

  private conversationHasActiveWork(conversation: ZeusConversationWithMessagesRecord): boolean {
    const hasPendingWrite = this.ports.submissions.listByConversation(conversation.id).some((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active');
    return hasPendingWrite || conversation.providerState === 'binding' || conversation.providerState === 'active' || conversation.providerState === 'waiting';
  }

  private requireProject(projectId: string): ZeusProjectRecord {
    const project = this.ports.projects.getById(projectId);
    if (!project) throw queryError('ZEUS_PROJECT_NOT_FOUND', 'Project not found', 404);
    return project;
  }
}

function mapConversationCapabilityModels(codexCapabilities: CodexCapabilitiesSnapshot | null, connectionCatalog: SelectableConnectionModel[]): ConversationCapabilityModel[] {
  const codexModels: ConversationCapabilityModel[] = (codexCapabilities?.models ?? []).map((model) => ({
    id: model.id,
    model: model.model,
    ...(model.displayName ? { displayName: model.displayName } : {}),
    agentKind: 'codex',
    supports1MContext: false,
    sourceId: 'codex',
    sourceName: 'Codex',
    available: true,
    availabilityReason: 'Codex app-server 已报告该模型。',
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
    ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    serviceTiers: model.serviceTiers.map((tier) => ({ ...tier })),
    ...(model.defaultServiceTier !== undefined ? { defaultServiceTier: model.defaultServiceTier } : {}),
    // app-server 目录与同代际预算快照必须对外呈现同一个模型窗口，避免交接预检和真实派发各用一套数字。
    contextWindow: positiveIntegerOrNull(model.raw.contextWindow ?? model.raw.context_window ?? model.raw.modelContextWindow ?? model.raw.model_context_window) ?? codexCapabilities?.modelBudgets[model.model]?.contextWindowTokens ?? null,
  }));
  const connectionModels: ConversationCapabilityModel[] = connectionCatalog.map((model) => ({
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    agentKind: model.agentKind,
    sourceId: model.sourceId,
    sourceName: model.sourceName,
    available: model.available,
    availabilityReason: model.availabilityReason,
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
    defaultReasoningEffort: model.defaultReasoningEffort,
    serviceTiers: [],
    defaultServiceTier: null,
    speedLabel: model.speedLabel,
    tools: model.tools,
    imageInput: model.imageInput,
    runtimeAdapter: model.runtimeAdapter,
    protocolFamily: model.protocolFamily,
    authenticationScheme: model.authenticationScheme,
    supports1MContext: model.supports1MContext,
    contextWindow: model.contextWindow,
  }));
  return [...codexModels, ...connectionModels];
}

function createTaskRuntimePrompt(task: ZeusTaskRecord): string {
  return buildAiRuntimePrompt({
    taskTitle: task.title,
    taskType: task.taskType,
    taskDescription: task.description,
    defectCurrentState: task.defectCurrentState,
    defectExpectedOutcome: task.defectExpectedOutcome,
    defectReproductionSteps: task.defectReproductionSteps,
    optimizationCurrentState: task.optimizationCurrentState,
    optimizationExpectedOutcome: task.optimizationExpectedOutcome,
  });
}

function repositoryRevision(repositories: ZeusProjectRepositoryRecord[]): string {
  return createHash('sha256')
    .update(
      repositories
        .map((repository) => `${repository.id}\0${repository.relativePath}\0${repository.localPath}`)
        .sort()
        .join('\0'),
    )
    .digest('hex');
}

function resolveModelCapability<T extends { id: string; model: string }>(models: readonly T[], identity: string | null | undefined): T | null {
  const normalized = identity?.trim();
  if (!normalized) return null;
  const exact = models.find((candidate) => candidate.id === normalized);
  if (exact) return exact;
  const legacyMatches = models.filter((candidate) => candidate.model === normalized);
  return legacyMatches.length === 1 ? legacyMatches[0]! : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

async function mapWithConcurrency<Input, Output>(items: Input[], operation: (item: Input, index: number) => Promise<Output>, concurrency = 4): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await operation(items[index]!, index);
      } catch (error) {
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const candidateRelative = relative(root, candidate);
  return candidateRelative === '' || (candidateRelative !== '..' && !candidateRelative.startsWith(`..${sep}`) && !isAbsolute(candidateRelative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queryError(code: string, message: string, statusCode?: number): Error & { code: string; statusCode?: number } {
  return Object.assign(new Error(message), { code, ...(statusCode ? { statusCode } : {}) });
}
