import type { ConversationFeatureCatalog, ConversationFeatureAvailability } from '@zeus/shared';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  readPiBuiltinToolCatalog,
  buildAiRuntimePrompt,
  modelRef,
  parseModelRef,
  type AntigravityModel,
  type CodexAccountSnapshot,
  type CodexCapabilitiesSnapshot,
  type CodexTransportState,
  type CopilotModelInfo,
  type SelectableConnectionModel,
} from '@zeus/ai-runtime';
import { buildTaskBranchName, buildTaskBranchPrefix, type GitRepositoryContext } from '@zeus/git-core';
import { mapWithConcurrency } from './localServerPlatformSupport.js';
import { readProjectRepositoryDiscovery } from './projectRepositoryDiscovery.js';
import type {
  ConversationRepository,
  ConversationSubmissionRepository,
  ProjectRepository,
  ProjectRepositoryRegistrationRepository,
  ProjectSharedPathRepository,
  SettingRepository,
  TaskEnvironmentRepository,
  TaskRepository,
  TaskWorkspaceRepository,
  ZeusConversationWithMessagesRecord,
  ZeusProjectRecord,
  ZeusProjectRepositoryRecord,
  ZeusTaskEnvironmentRecord,
  ZeusTaskRecord,
} from '@zeus/storage';

interface TaskPushContextProjection {
  revision: string;
  /** 任务检查结果中的独立图片预览来源，不写入布局或提示词。 */
  attachmentPreviewSources: unknown[];
  current: { options: unknown[] };
  parent: { options: unknown[] };
  related: { options: unknown[] };
}

export interface ExistingProviderCapabilityReadPort {
  /** 只观察既有 transport；GET 路径禁止 ensureReady/activateFreshGeneration。 */
  getState(): CodexTransportState;
  /** 只读取同代本地账户快照，不发送账户 RPC 或刷新 token。 */
  readAccount(input: { cachedOnly: true }): Promise<CodexAccountSnapshot>;
}

export interface TaskPushGitReadPort {
  /** 只读 Git 上下文；不得 fetch 或改变 refs/index/worktree。 */
  readRepositoryContext(localPath: string): Promise<GitRepositoryContext>;
  readWorktreeClean(localPath: string, ignoredPaths: string[]): Promise<boolean>;
}

interface ConversationCapabilityQueryPorts {
  /** 已存在的目录与运行验收证据只读投影，不为查询启动引擎。 */
  readContextCapacitySupport?: (model: ConversationCapabilityModel) => import('@zeus/shared').ContextCapacityCapability;
  /** 只读取本地仓库发现的持久状态，不启动扫描。 */
  settings: Pick<SettingRepository, 'getJson'>;
  projects: Pick<ProjectRepository, 'getById'>;
  tasks: Pick<TaskRepository, 'getById'>;
  repositories: Pick<ProjectRepositoryRegistrationRepository, 'listByProject'>;
  sharedPaths: Pick<ProjectSharedPathRepository, 'listByProject'>;
  environments: Pick<TaskEnvironmentRepository, 'listByTask'>;
  workspaces: Pick<TaskWorkspaceRepository, 'getByRepositoryBranch' | 'listByEnvironment'>;
  conversations: Pick<ConversationRepository, 'listByProject' | 'listByEnvironment'>;
  submissions: Pick<ConversationSubmissionRepository, 'listByConversation' | 'hasInFlightByConversation'>;
  provider: ExistingProviderCapabilityReadPort;
  modelCatalog: {
    /** 只读连接元数据，不重复读取钥匙串。 */
    hasConfiguredProvider(): boolean;
    /** 指定模型时只读取对应连接凭据，目录页面省略参数读取全部。 */
    listSelectableModels(selectedModelRef?: string): Promise<SelectableConnectionModel[]>;
  };
  /** Copilot GET 只读 SDK 已取回的账户与模型，不启动登录进程。 */
  copilotCatalog: {
    readAccount(): { authenticated: boolean } | null;
    readModels(): CopilotModelInfo[];
  };
  /** 项目会话只展示当前 Google 账号实际返回的模型。 */
  readAntigravityModels?: () => AntigravityModel[];
  git: TaskPushGitReadPort;
  taskContext: {
    read(project: ZeusProjectRecord, task: ZeusTaskRecord): TaskPushContextProjection;
    readAttachmentOptions(project: ZeusProjectRecord, task: ZeusTaskRecord): unknown[];
  };
  /** 读取全局默认模型；项目级默认模型已移除，新项目沿用该默认值。 */
  readDefaultModel(): string | null;
  /** 读取新任务当前使用的分支前缀。 */
  readTaskBranchPrefix(): string;
  codexNativeEnabled(): boolean;
  now(): Date;
}

export interface ConversationCapabilityModel {
  /** 服务端可验证的指定预算与不可用原因。 */
  contextCapacity?: import('@zeus/shared').ContextCapacityCapability;
  id: string;
  model: string;
  displayName?: string;
  agentKind: 'codex' | 'pi' | 'copilot' | 'antigravity';
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
  /** 同一界面按接入能力显示入口，不按供应商品牌判断。 */
  features?: ConversationFeatureCatalog;
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
  /** 与任务推送共用当前默认模型。 */
  preferredModel?: string | null;
  /** 只公布宿主已就绪的原生目标能力。 */
  goals?: CodexCapabilitiesSnapshot['goals'];
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

  /** 项目能力读取共用既有目录；内部模型预检可以跳过账号查询。 */
  async readConversation(projectId: string, options: { readProviderAccount?: boolean; selectedModelRef?: string } = {}): Promise<ConversationCapabilitiesSnapshot> {
    return this.readExisting(this.requireProject(projectId), options);
  }

  /** 全局模板只读取既有能力目录；不得为了展示配置而启动 Provider。 */
  async readDigitalEmployee(): Promise<DigitalEmployeeCapabilitiesSnapshot> {
    const transport = this.ports.provider.getState();
    const codexCapabilities = this.ports.codexNativeEnabled() && transport.type === 'ready' ? transport.capabilities : null;
    const models = mapConversationCapabilityModels(
      codexCapabilities,
      await this.ports.modelCatalog.listSelectableModels(),
      this.ports.copilotCatalog.readAccount()?.authenticated ? this.ports.copilotCatalog.readModels() : [],
      this.ports.readAntigravityModels?.(),
    ).map((model) => ({ ...model, contextCapacity: this.ports.readContextCapacitySupport?.(model) }));
    const preferred = this.ports.readDefaultModel();
    const snapshot = {
      preferredModel: preferred ? (resolveModelCapability(models, preferred)?.id ?? preferred) : (models.find((model) => model.available !== false)?.id ?? null),
      goals: codexCapabilities?.goals ?? { supported: false, enabled: false, stage: null },
      generationId: codexCapabilities?.generationId ?? 'pi-sdk',
      initializedAt: codexCapabilities?.initializedAt ?? this.ports.now().toISOString(),
      models,
    };
    return models.length > 0 ? snapshot : { ...snapshot, available: false, availabilityReason: '当前没有已就绪的 Provider 模型；GET 不会为了读取能力而启动 Provider。' };
  }

  /** 返工和重试只读取原环境及其仓库与会话状态，不重新查询模型或 Git 引用。 */
  readTaskEnvironmentAvailability(projectId: string, taskId: string, environmentId: string): 'available' | 'busy' | 'closed' | 'invalid' {
    /** 原运行只能继续使用同项目、同任务的环境。 */
    const environment = this.ports.environments.listByTask(taskId).find((candidate) => candidate.id === environmentId && candidate.projectId === projectId);
    if (!environment) return 'invalid';
    /** 合入或放弃任一仓库，会使原环境不能整体继续使用。 */
    const { workspaces, activeConversationIds, closed } = this.readEnvironmentMembers(environment);
    if (closed) return 'closed';
    if (!workspaces.length) return 'invalid';
    return activeConversationIds.length ? 'busy' : 'available';
  }

  /** 读取一次推送确认所需的模型、上下文和工作区快照；是否附带账号由调用入口决定。 */
  async readTaskPush(projectId: string, rawTaskId: string | undefined, options: { readProviderAccount?: boolean } = {}): Promise<Record<string, unknown>> {
    const project = this.requireProject(projectId);
    const taskId = rawTaskId?.trim();
    if (!taskId) throw queryError('ZEUS_TASK_ID_REQUIRED', 'taskId is required', 400);
    const task = this.ports.tasks.getById(taskId);
    if (!task || task.projectId !== project.id) throw queryError('ZEUS_TASK_NOT_FOUND', 'Task not found', 404);
    /** 同一次能力快照冻结当前设置，避免仓库并发读取时出现多个分支前缀。 */
    const taskBranchPrefix = this.ports.readTaskBranchPrefix();
    const taskContext = this.ports.taskContext.read(project, task);
    const currentAttachmentOptions = this.ports.taskContext.readAttachmentOptions(project, task);
    // GET 只消费已登记仓库；仓库发现、登记、fetch 与工作区准备仍属于显式 Command。
    const registeredRepositories = this.ports.repositories.listByProject(project.id).filter((repository) => isPathInsideRoot(repository.localPath, project.localPath));
    // 状态与仓库清单在同一同步读取段冻结，避免扫描完成后拼出前后不一致的能力。
    const repositoryDiscovery = readProjectRepositoryDiscovery(this.ports.settings, project);
    // GUI 查询把账号与 Git 并行读取；服务端内部调用继续跳过账号通道，避免增加命令路径延迟。
    const [capabilities, repositoryCapabilities] = await Promise.all([
      this.readExisting(project, { readProviderAccount: options.readProviderAccount === true }),
      mapWithConcurrency(registeredRepositories, (repository) => this.readRepositoryCapability(project, task, repository, taskBranchPrefix)),
    ]);
    const primaryRepository = repositoryCapabilities[0];
    const existingEnvironments = this.ports.environments.listByTask(task.id).flatMap((environment) => {
      if (environment.state === 'reclaimed') return [];
      const { workspaces, activeConversationIds, closed: hasClosedWorkspace } = this.readEnvironmentMembers(environment);
      const members = workspaces.filter((workspace) => workspace.kind === 'task');
      if (members.length === 0) return [];
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
      hasConfiguredProvider: this.ports.modelCatalog.hasConfiguredProvider(),
      taskId: task.id,
      canonicalPrompt: createTaskRuntimePrompt(task),
      taskContextRevision: taskContext.revision,
      parentContextRevision: taskContext.revision,
      currentConversationOptions: taskContext.current.options,
      parentContextOptions: taskContext.parent.options,
      relatedContextOptions: taskContext.related.options,
      currentAttachmentOptions,
      attachmentPreviewSources: taskContext.attachmentPreviewSources,
      repositoryRevision: repositoryRevision(registeredRepositories),
      repositoryDiscovery,
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
        suggestedBranchName: primaryRepository?.suggestedBranchName ?? buildTaskBranchName(task.taskCode, task.title, this.ports.environments.listByTask(task.id).length + 1, taskBranchPrefix),
        worktreeRoot: join(dirname(project.localPath), '.zeus-worktrees'),
      },
    };
  }

  unavailableCodexAccount(): UnavailableCodexAccount {
    return { generationId: 'codex-unavailable', requiresOpenaiAuth: false, signedIn: false, accountType: null, planType: null };
  }

  /** 组装统一模型能力；调用方已开始目录读取时直接复用，避免串行等待账号。 */
  async buildConversationCapabilities(
    project: ZeusProjectRecord,
    codexCapabilities: CodexCapabilitiesSnapshot | null,
    codexAccount: CodexAccountSnapshot | UnavailableCodexAccount,
    preloadedConnectionCatalog?: SelectableConnectionModel[],
    antigravityModels: AntigravityModel[] = [],
  ): Promise<ConversationCapabilitiesSnapshot> {
    const connectionCatalog = preloadedConnectionCatalog ?? (await this.ports.modelCatalog.listSelectableModels());
    // 项目不再维护模型白名单；供应商中启用的模型全局可用，真实能力以运行探针结果为准。
    const models = mapConversationCapabilityModels(codexCapabilities, connectionCatalog, this.ports.copilotCatalog.readAccount()?.authenticated ? this.ports.copilotCatalog.readModels() : [], antigravityModels).map((model) => ({
      ...model,
      contextCapacity: this.ports.readContextCapacitySupport?.(model),
    }));
    if (models.length === 0) throw queryError('ZEUS_MODEL_UNAVAILABLE', '当前项目没有可用模型。');
    const defaultModel = this.ports.readDefaultModel();
    // 新项目沿用 Zeus 全局默认模型；会话/推送模型由各入口的“记住上次选择”覆盖。
    const preferredModel = defaultModel ? (resolveModelCapability(models, defaultModel)?.id ?? defaultModel) : (models.find((candidate) => candidate.available !== false)?.id ?? null);
    return {
      goals: codexCapabilities?.goals ?? { supported: false, enabled: false, stage: null },
      generationId: codexCapabilities?.generationId ?? 'pi-sdk',
      initializedAt: codexCapabilities?.initializedAt ?? this.ports.now().toISOString(),
      projectId: project.id,
      preferredModel,
      models,
      codexAccount,
    };
  }

  /** 目录查询只读本地账户缓存，单一供应商账号故障不能阻断其他来源。 */
  private async readExisting(project: ZeusProjectRecord, options: { readProviderAccount?: boolean; selectedModelRef?: string } = {}): Promise<ConversationCapabilitiesSnapshot> {
    const transport = this.ports.provider.getState();
    const codexCapabilities = this.ports.codexNativeEnabled() && transport.type === 'ready' ? transport.capabilities : null;
    /** 缓存缺失属于未知状态，只有其他读取异常才将 Codex 标记为不可用。 */
    let codexAccountReadFailed = false;
    /** 账户信息只补充展示；无缓存或世代切换时保留未知状态，不影响其他供应商。 */
    const [codexAccount, connectionCatalog] = await Promise.all([
      codexCapabilities && options.readProviderAccount !== false
        ? this.ports.provider.readAccount({ cachedOnly: true }).catch((error: unknown) => {
            codexAccountReadFailed = !isRecord(error) || error.code !== 'ZEUS_CODEX_ACCOUNT_SNAPSHOT_UNAVAILABLE';
            return this.unavailableCodexAccount();
          })
        : Promise.resolve(this.unavailableCodexAccount()),
      this.ports.modelCatalog.listSelectableModels(options.selectedModelRef),
    ]);
    try {
      /** 账号故障只影响 Codex，独立供应商仍使用自己的目录与可用性证据。 */
      const snapshot = await this.buildConversationCapabilities(project, codexCapabilities, codexAccount, connectionCatalog, this.ports.readAntigravityModels?.());
      if (codexAccountReadFailed) {
        return {
          ...snapshot,
          models: snapshot.models.map((model) => (model.sourceId === 'codex' ? { ...model, available: false, availabilityReason: 'Codex 账号状态暂时无法读取，请重新读取或选择其他供应商模型。' } : model)),
        };
      }
      return snapshot;
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

  private async readRepositoryCapability(project: ZeusProjectRecord, task: ZeusTaskRecord, registered: ZeusProjectRepositoryRecord, taskBranchPrefix: string) {
    try {
      const repository = await this.ports.git.readRepositoryContext(registered.localPath);
      const clean = await this.ports.git.readWorktreeClean(registered.localPath, this.repositoryIgnoredPaths(project.id, registered.id, registered.localPath));
      if (!repository.isRepository) throw queryError('ZEUS_PROJECT_REPOSITORY_UNAVAILABLE', `Project repository is unavailable: ${registered.relativePath}`);
      const defaultRemoteName = repository.remotes.includes('origin') ? 'origin' : (repository.remotes[0] ?? '');
      /** unborn 当前分支没有 refs/heads 记录，但已经是 Git 确认的本地来源。 */
      const localSourceBranches = !repository.detached && !repository.headSha && repository.branch && !repository.localBranches.includes(repository.branch) ? [repository.branch, ...repository.localBranches] : repository.localBranches;
      const sourceRefs = [
        ...localSourceBranches.map((branch) => ({ ref: `refs/heads/${branch}`, label: branch, kind: 'local' as const, group: 'local', current: branch === repository.branch })),
        ...repository.remoteBranches.map((ref) => {
          const separator = ref.indexOf('/');
          const remoteName = separator > 0 ? ref.slice(0, separator) : defaultRemoteName;
          const branch = separator > 0 ? ref.slice(separator + 1) : ref;
          return { ref: `refs/remotes/${ref}`, label: branch, kind: 'remote' as const, group: remoteName || 'remote', current: false };
        }),
      ];
      const localTaskBranches = repository.localBranches
        .filter((branchName) => branchName.startsWith(buildTaskBranchPrefix(task.taskCode, taskBranchPrefix)))
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
        unavailableReason: null,
        sourceRefs,
        localTaskBranches,
        // 已删除任务的工作区仍保留分支占用，不能仅按当前任务的环境数量生成建议。
        suggestedBranchName: buildTaskBranchName(
          task.taskCode,
          task.title,
          this.ports.environments.listByTask(task.id).length + 1,
          taskBranchPrefix,
          (branchName) => repository.localBranches.includes(branchName) || repository.worktrees.some((worktree) => worktree.branch === branchName) || Boolean(this.ports.workspaces.getByRepositoryBranch(registered.id, branchName)),
        ),
      };
    } catch {
      // 单仓被移除或失去访问权限时，其他仓库和任务表单仍可读取；不得伪造可选分支。
      return {
        ...registered,
        branch: '',
        headSha: '',
        clean: false,
        defaultRemoteName: '',
        remoteRefreshStatus: 'not_requested' as const,
        remoteRefreshError: null,
        unavailableReason: '仓库暂时无法读取，请检查项目目录或刷新本地仓库。',
        sourceRefs: [],
        localTaskBranches: [],
        suggestedBranchName: buildTaskBranchName(task.taskCode, task.title, this.ports.environments.listByTask(task.id).length + 1, taskBranchPrefix),
      };
    }
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

  /** 与实际继续环境的校验一致，关闭状态检查所有仓库成员。 */
  private readEnvironmentMembers(environment: ZeusTaskEnvironmentRecord) {
    /** 仓库状态与会话占用分别决定关闭和暂时占用。 */
    const workspaces = this.ports.workspaces.listByEnvironment(environment.id);
    return {
      workspaces,
      closed: environment.state === 'reclaimed' || workspaces.some((workspace) => workspace.state === 'merged' || workspace.state === 'discarded'),
      activeConversationIds: this.activeWritableEnvironmentConversationIds(environment.id),
    };
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
    const hasPendingWrite = this.ports.submissions.hasInFlightByConversation(conversation.id);
    return hasPendingWrite || conversation.providerState === 'binding' || conversation.providerState === 'active' || conversation.providerState === 'waiting';
  }

  private requireProject(projectId: string): ZeusProjectRecord {
    const project = this.ports.projects.getById(projectId);
    if (!project) throw queryError('ZEUS_PROJECT_NOT_FOUND', 'Project not found', 404);
    return project;
  }
}

function mapConversationCapabilityModels(
  codexCapabilities: CodexCapabilitiesSnapshot | null,
  connectionCatalog: SelectableConnectionModel[],
  copilotCatalog: CopilotModelInfo[],
  antigravityCatalog: AntigravityModel[] = [],
): ConversationCapabilityModel[] {
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
  /** GitHub 策略和上下文上限由当前登录账号的 SDK 目录提供。 */
  const copilotModels: ConversationCapabilityModel[] = copilotCatalog.map((model) => ({
    id: modelRef('copilot', model.id),
    model: model.id,
    displayName: model.name,
    agentKind: 'copilot',
    sourceId: 'copilot',
    sourceName: 'GitHub Copilot',
    available: model.policy?.state !== 'disabled' && model.policy?.state !== 'unconfigured',
    availabilityReason: model.policy?.state === 'disabled' ? 'GitHub 策略禁用了该模型。' : model.policy?.state === 'unconfigured' ? 'GitHub 账号尚未配置该模型。' : 'Copilot SDK 已报告该模型。',
    supportedReasoningEfforts: [...(model.supportedReasoningEfforts ?? [])],
    defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    serviceTiers: [],
    defaultServiceTier: null,
    supports1MContext: model.capabilities.limits.max_context_window_tokens >= 1_000_000,
    contextWindow: model.capabilities.limits.max_context_window_tokens,
    imageInput: model.capabilities.supports.vision ? 'supported' : 'unsupported',
    runtimeAdapter: 'copilot_sdk',
    protocolFamily: 'copilot_sdk',
    authenticationScheme: 'github_oauth',
  }));
  /** ACP 目录保留 Google 分配的模型 ID 和名称。 */
  const antigravityModels: ConversationCapabilityModel[] = antigravityCatalog.map((model) => ({
    id: modelRef('antigravity', model.id),
    model: model.id,
    displayName: model.name,
    agentKind: 'antigravity',
    sourceId: 'antigravity',
    sourceName: 'Google Antigravity',
    available: true,
    availabilityReason: 'Antigravity CLI 已返回该模型。',
    supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
    defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    serviceTiers: [],
    supports1MContext: false,
    contextWindow: null,
    runtimeAdapter: 'antigravity_acp',
    protocolFamily: 'antigravity_acp',
    authenticationScheme: 'google_oauth',
  }));
  const piTools = new Set(readPiBuiltinToolCatalog().map((tool) => tool.name));
  return [...codexModels, ...connectionModels, ...copilotModels, ...antigravityModels].map((model) => ({ ...model, features: conversationFeatureCatalog(model, piTools, codexCapabilities) }));
}

/** 执行内核、模型接口和会话工具分别提供事实，不能把看图能力当成生图能力。 */
function conversationFeatureCatalog(model: ConversationCapabilityModel, piTools: Set<string>, native: CodexCapabilitiesSnapshot | null): ConversationFeatureCatalog {
  const available = (reason: string): ConversationFeatureAvailability => ({ state: 'available', reason });
  const unknown = (reason: string): ConversationFeatureAvailability => ({ state: 'unknown', reason });
  const unavailable = (reason: string): ConversationFeatureAvailability => ({ state: 'unsupported', reason });
  if (model.agentKind === 'antigravity') {
    /** agy 自己提供工具和上下文，Zeus 展示 ACP 实际请求的权限。 */
    const localOnly = unavailable('此功能在 Antigravity 会话中不可用。');
    return {
      skills: localOnly,
      imageInput: unknown('是否支持图片以 Antigravity 会话为准。'),
      imageGeneration: localOnly,
      questions: available('通过 Antigravity 原生提问收集本轮回答。'),
      plan: unknown('是否支持计划模式以 Antigravity 会话公布的模式为准。'),
      processes: localOnly,
      steering: localOnly,
      goals: localOnly,
      subagents: localOnly,
      autoReview: unknown('优先使用当前 Antigravity 会话公布的 Auto 审查，需确认时转人工。'),
      mcp: localOnly,
      search: localOnly,
      browser: localOnly,
    };
  }
  const nativeKernel = model.runtimeAdapter !== 'pi_sdk' && model.agentKind === 'codex';
  const tools = (name: string): ConversationFeatureAvailability =>
    model.tools === 'unsupported'
      ? unavailable('当前模型接口明确不支持工具调用。')
      : nativeKernel
        ? unknown('app-server 未逐项报告本轮工具目录；实际可用性还取决于工作模式，允许正常尝试。')
        : piTools.has(name)
          ? available('已注册 Zeus 共用工具。')
          : unknown('当前执行内核尚未报告该工具，允许正常尝试。');
  const external = unknown('以本轮已启用的 MCP 和实际工具目录为准；调用时返回具体配置或接口错误。');
  const result: ConversationFeatureCatalog = {
    skills: tools('read'),
    imageInput: model.imageInput === 'supported' ? available('模型接口已声明支持图片输入。') : unknown('图片正常发送，是否支持由模型接口实际返回。'),
    imageGeneration: { ...external, reason: '按模型接口或 MCP 实际返回的图片开放使用，不按模型名称或看图能力推断。' },
    questions: tools('request_user_input'),
    plan: tools('submit_plan'),
    processes: tools('process'),
    steering: available('使用共用提交身份、队列和安全插话位置。'),
    goals: nativeKernel ? (native?.goals.supported && native.goals.enabled ? available('原生目标控制已启用。') : unavailable('当前 app-server 未启用原生目标控制。')) : tools('create_goal'),
    subagents: tools('spawn_agent'),
    autoReview: model.agentKind === 'copilot' ? unavailable('Copilot 独立权限审查尚未接入；工具审批需人工处理。') : nativeKernel ? unknown('原生接口支持请求独立审批审查；是否启用以实际调用回报为准，允许正常尝试。') : tools('bash'),
    mcp: external,
    search: { ...external, reason: '搜索通过当前已启用 MCP 提供；未注册搜索服务时明确报告。' },
    browser: unknown('以本轮 Zeus 浏览器工具注册和浏览器状态为准。'),
  };
  if (!model.available) for (const key of Object.keys(result) as Array<keyof ConversationFeatureCatalog>) result[key] = { state: 'needs_configuration', reason: model.availabilityReason };
  return result;
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

/** 优先使用目录 ID；带来源的 Codex 引用只匹配 Codex 模型，裸模型名须唯一。 */
export function resolveModelCapability<T extends { id: string; model: string; sourceId?: string }>(models: readonly T[], identity: string | null | undefined): T | null {
  /** 设置与会话输入允许模型 ID 带首尾空白。 */
  const normalized = identity?.trim();
  if (!normalized) return null;
  /** 现有目录 ID 包括完整的外部连接身份。 */
  const exact = models.find((candidate) => candidate.id === normalized);
  if (exact) return exact;

  /** 操作设置和子代理继承使用来源引用，Codex 目录保留 Provider 返回的原始 ID。 */
  const reference = parseModelRef(normalized);
  /** 裸模型名按原有规则消歧，Codex 引用按原始 ID 或模型名匹配。 */
  const matches =
    reference?.sourceId === 'codex'
      ? models.filter((candidate) => candidate.sourceId === 'codex' && (candidate.id === reference.modelId || candidate.model === reference.modelId))
      : models.filter((candidate) => candidate.model === normalized);
  return matches.length === 1 ? matches[0]! : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
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
