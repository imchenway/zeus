import { checkAiCliAdapter, type CodexRemoteControlStatus, createAgentCapabilityCatalog, createAiRuntimeSessionManager, isNonCodexAiCliAdapterId, listAiCliAdapters } from '@zeus/ai-runtime';
import {
  buildGitPatchExport,
  getGitRepositoryContext,
  getGitWorktreeClean,
  getProjectGitCommitDetail,
  getProjectGitComparisonDiff,
  getProjectGitRepositorySnapshot,
  getTaskBranchFileDiff,
  getTaskWorkspaceFileDiff,
  type GitDiffSummary,
  type GitPatchExport,
  readTaskIntegrationConflict,
} from '@zeus/git-core';
import { type ProjectGraph } from '@zeus/graph-engine';
import { normalizeProjectConfig, type ProjectConfigSnapshot, type UpdateProjectConfigBody } from '@zeus/project-core';
import { getSecretPresenceLabel } from '@zeus/security-core';
import { cloneTaskManagementStatusConfig, type TaskPushParentAttachmentOption } from '@zeus/shared';
import {
  ConversationProviderItemRepository,
  ConversationRepository,
  ConversationResourceRepository,
  ConversationServerRequestRepository,
  ConversationTurnRepository,
  ProjectionDatabaseRuntimeManager,
  ProjectRepository,
  runtimeSessionMayOwnProcess,
  SettingRepository,
  TaskBoardRepository,
  TaskEventRepository,
  type TaskManagementStatus,
  TaskRepository,
  TaskWorkspaceRepository,
  TerminalEventRepository,
  type ZeusConversationRecord,
  type ZeusProjectRecord,
  type ZeusTaskIntegrationAttemptRecord,
  type ZeusTaskRecord,
} from '@zeus/storage';
import { type TaskStatus } from '@zeus/task-core';
import { createTelegramBotMessageClient, dispatchTelegramUpdate, getTelegramConfigurationState, type TelegramMessageSender, type TelegramPollingService } from '@zeus/telegram-adapter';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clearAllPersistedGraphCaches } from './codeIntelligenceGraphCache.js';
import { type GraphViewSnapshot, hasDatabaseUriPassword, resolveCodeMapScanRoot } from './codeIntelligenceGraphStore.js';
import { CodeIntelligenceQueryApplication } from './codeIntelligenceQueryApplication.js';
import { registerCodeIntelligenceQueryRoutes } from './codeIntelligenceQueryRoutes.js';
import { isUnsafeCodeMapScanRoot } from './codeMapScanBoundary.js';
import { type CodexRemoteControlSnapshot, registerCodexPublicCommandRoutes } from './codexPublicCommandRoutes.js';
import { CodexSubagentQueryApplication } from './codexSubagentQueryApplication.js';
import { registerCodexSubagentQueryRoutes } from './codexSubagentQueryRoutes.js';
import { createCodexSubagentRuntimeReader } from './codexSubagentRuntimeProjection.js';
import { createCommandCenter } from './commandCenter.js';
import { ConversationCapabilityQueryApplication } from './conversationCapabilityQueryApplication.js';
import { registerConversationCapabilityQueryRoutes } from './conversationCapabilityQueryRoutes.js';
import { ConversationChoiceQueryApplication } from './conversationChoiceQueryApplication.js';
import { registerConversationChoiceQueryRoutes } from './conversationChoiceQueryRoutes.js';
import { registerConversationCommandRoutes } from './conversationCommandRoutes.js';
import { registerConversationDispatchCommandRoutes } from './conversationDispatchCommandRoutes.js';
import { isPathInsideRoot, readConversationResourcePreview } from './conversationResourcePreview.js';
import { type ConversationFileOpenGrant, createConversationFileOpenGrant, toConversationResource, toConversationResourceOpenIntent } from './conversationResources.js';
import { registerConversationSnapshotV2Api } from './conversationSnapshotV2Api.js';
import { registerConversationSyncRoutes } from './conversationSyncRoutes.js';
import { registerExecutionHostControlApi } from './executionHostControlApi.js';
import { createPollingAdmissionPause, registerExecutionHostHandoffApi } from './executionHostHandoffApi.js';
import { registerGitCommandRoutes } from './gitCommandRoutes.js';
import { graphConversationReject, isExplicitGraphConversationRejection, registerGraphConversationCommandRoutes } from './graphConversationCommandRoutes.js';
import { closeHeavyWorkerJobs, heavyWorkerPoolSnapshot } from './heavyWorkerPool.js';
import type {
  DashboardSnapshot,
  GraphConversationHistoryItem,
  GraphConversationHistoryPage,
  ProjectDatabaseSecretSnapshot,
  ReleaseStatusSnapshot,
  RuntimeStatusSnapshot,
  SaveProjectDatabaseSecretBody,
  SecurityAuditLogEntry,
  SecurityResetResult,
  SecuritySecretsSnapshot,
  TelegramDispatchPreviewBody,
  TelegramNotificationSettingsSnapshot,
  TelegramSecuritySettingsSnapshot,
  TelegramSettingsSnapshot,
  TelegramStatusSnapshot,
  TelegramTestConnectionResult,
  UpdateTelegramNotificationSettingsBody,
  UpdateTelegramSecuritySettingsBody,
  UpdateTelegramSettingsBody,
} from './index.js';
import { registerIntegrationCommandRoutes } from './integrationCommandRoutes.js';
import {
  exportLocalBusinessData,
  findInvalidPortableProjectPaths,
  importLocalBusinessData,
  type ImportLocalDataResult,
  type LocalDataExportSnapshot,
  plannedLocalBusinessDataImportCounts,
  validateLocalBusinessDataImport,
} from './localDataTransfer.js';
import {
  type AppShellSettingsSnapshot,
  type ClearCacheResult,
  codeMapSettingsKey,
  type CodeMapSettingsSnapshot,
  codexRemoteControlEnabledSettingKey,
  type ImportLocalSettingsBody,
  type ImportLocalSettingsResult,
  type LocalSettingsExportSnapshot,
  normalizeCodeMapSettings,
  normalizeImportedRuntimeSettings,
  patchAppShellSettings,
  projectConfigSettingsPrefix,
  runtimeSettingsKey,
  type UpdateAppShellSettingsBody,
  type UpdateCodeMapSettingsBody,
  type UpdateRuntimeSettingsBody,
} from './localServerSettingsNormalization.js';
import { MemoryContextApplicationService, registerMemoryContextApi } from './memoryContextApi.js';
import { ProjectGitQueryApplication } from './projectGitQueryApplication.js';
import { registerProjectGitQueryRoutes } from './projectGitQueryRoutes.js';
import { ProjectQueryApplication } from './projectQueryApplication.js';
import { registerProjectQueryRoutes } from './projectQueryRoutes.js';
import { generateReleaseNotesWithDeepSeek } from './releaseNotesGeneration.js';
import { registerReleaseUpdateApi } from './releaseUpdateApi.js';
import { parseRuntimeArgs, RuntimeQueryApplication, runtimeSessionIsConfirmedTerminal, type RuntimeSettingsSnapshot, toAiRuntimeLogEntry, toAiRuntimeSession } from './runtimeQueryApplication.js';
import { registerRuntimeQueryRoutes } from './runtimeQueryRoutes.js';
import { registerRuntimeSessionCommandRoutes } from './runtimeSessionCommandRoutes.js';
import { type ParsedSettingsCommand, SettingsCommandApplication, settingsCommandHttpError, type SettingsCommandRequest, settingsCommandTypes } from './settingsCommandApplication.js';
import { registerStorageRecoveryPreflightApi } from './storageRecoveryPreflightApi.js';
import { telegramChildOperation, TelegramCommandApplication, telegramCommandHttpError, type TelegramCommandRequest, telegramCommandTypes } from './telegramCommandApplication.js';
import { registerTelegramPollingApi } from './telegramPollingApi.js';
import { changeSetErrorStatus, errorCode as turnChangeSetErrorCode } from './turnChangeSets.js';
import { WorkManagementCommandApplication } from './workManagementCommandApplication.js';
import { registerWorkManagementCoreCommandRoutes } from './workManagementCoreCommandRoutes.js';
import { WorkManagementCoreOperations } from './workManagementCoreOperations.js';
import { registerWorkManagementProjectCommandRoutes } from './workManagementProjectCommandRoutes.js';
import { WorkManagementProjectOperations } from './workManagementProjectOperations.js';
import { WorkManagementQueryApplication } from './workManagementQueryApplication.js';
import { registerWorkManagementQueryRoutes } from './workManagementQueryRoutes.js';
import { registerWorkManagementTaskCommandRoutes } from './workManagementTaskCommandRoutes.js';
import { WorkManagementTaskEffectService } from './workManagementTaskEffectService.js';
import { WorkManagementTaskOperations } from './workManagementTaskOperations.js';
import { registerWorkspaceGitCommandRoutes } from './workspaceGitCommandRoutes.js';

export { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor, type ReadOnlyValidationApplicationIdentity } from './readOnlyValidation.js';

// 拆分期间保留结构化工厂依赖，后续按领域端口继续收窄。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LocalServerPlatformRouteDependencies = Record<string, any> & {
  server: FastifyInstance;
  aiRuntimeManager: ReturnType<typeof createAiRuntimeSessionManager>;
  conversationChoiceQueries: ConversationChoiceQueryApplication;
  conversationProviderItems: ConversationProviderItemRepository;
  conversationRequests: ConversationServerRequestRepository;
  conversationResources: ConversationResourceRepository;
  conversationTurns: ConversationTurnRepository;
  conversations: ConversationRepository;
  isNativeApiRecord(value: unknown): value is Record<string, unknown>;
  mapTaskRepositoriesWithConcurrency<Input, Output>(items: Input[], operation: (item: Input, index: number) => Promise<Output>, concurrency?: number): Promise<Output[]>;
  platformMutableState: {
    appShellSettings: AppShellSettingsSnapshot;
    codeMapSettings: CodeMapSettingsSnapshot;
    codexRemoteControlEnabled: boolean;
    memoryGraphCache: ProjectGraph | null;
    nativeEventSaveTimer: ReturnType<typeof setTimeout> | null;
    removeStorageWriteFaultListener: (() => void) | null;
    runtimeSettings: RuntimeSettingsSnapshot;
    telegramMessageSender: TelegramMessageSender | undefined;
    telegramNotificationSettings: TelegramNotificationSettingsSnapshot;
    telegramPollingService: TelegramPollingService | undefined;
    telegramPollingTimer: ReturnType<typeof setInterval> | undefined;
    telegramSecuritySettings: TelegramSecuritySettingsSnapshot;
    usageRefreshTimer: ReturnType<typeof setInterval> | undefined;
  };
  projectionDatabases: ProjectionDatabaseRuntimeManager;
  projects: ProjectRepository;
  settings: SettingRepository;
  settingsCommands: SettingsCommandApplication;
  taskBoards: TaskBoardRepository;
  taskEvents: TaskEventRepository;
  taskWorkspaces: TaskWorkspaceRepository;
  tasks: TaskRepository;
  telegramCommands: TelegramCommandApplication;
  terminalEvents: TerminalEventRepository;
  workManagementCommands: WorkManagementCommandApplication;
};

export async function registerLocalServerPlatformRoutes(dependencies: LocalServerPlatformRouteDependencies): Promise<{
  close(): Promise<void>;
  projectGitQueries: ProjectGitQueryApplication;
  conversationCapabilityQueries: ConversationCapabilityQueryApplication;
  commandCenter: ReturnType<typeof createCommandCenter>;
}> {
  const {
    server,
    zeusLocalServerHost,
    archiveNativeConversation,
    buildRuntimeProcessEnv,
    coldEvidence,
    commandDeliveries,
    createReleaseNotesCapability,
    publishRuntimeSessionEvent,
    resolveExistingRuntimeSessionAdapter,
    resolveRegisteredRuntimeAdapter,
    runtimeSessions,
    stopPersistedOrphanRuntimeSession,
    taskBoardGroupValues,
    taskBoards,
    taskEvents,
    taskStatusEventTitle,
    terminalEvents,
    activateCurrentCodexConfiguration,
    activeProjectGraphScanIds,
    aiRuntimeManager,
    answerProjectGraphQuestion,
    apiPerformance,
    appShellSettingsKey,
    appendAuditLog,
    applyConversationQueueReroute,
    applyLocalCorsHeaders,
    artifactStore,
    assertRequestedAgentIsCodex,
    assertRequestedAgentKind,
    assertTelegramCommandInputKeys,
    attachGraphViewPerformance,
    auditLogs,
    authorizeReleaseNotesRequest,
    getBoundPort,
    buildReleaseStatusSnapshot,
    buildReleaseUpdateStatus,
    closeTaskResourcesForTerminalStatus,
    codexAppServerManager,
    codexConfigImportService,
    codexExternalAgentHome,
    codexLegacyImportService,
    codexNativeCoordinator,
    codexNativeEnabled,
    codexPublicCommands,
    codexUsageService,
    commandRuns,
    configuredCodexRuntimeCommandPath,
    conversationChoiceQueries,
    conversationCommands,
    conversationDispatchCommands,
    conversationEventFlow,
    conversationGoalCapability,
    conversationGoals,
    conversationPlanActions,
    conversationProviderItems,
    conversationQueueCoreMutations,
    conversationRequests,
    conversationResources,
    conversationSnapshotCompatibility,
    conversationSnapshotV2,
    conversationSubmissions,
    conversationSyncProtocol,
    conversationToolResults,
    conversationTurns,
    conversations,
    countTaskWorkspaceActiveConversations,
    currentCodexRuntimeCommandPath,
    dataLayout,
    db,
    dispatchUnifiedConversationQueueHead,
    eventSubscribers,
    executeConversationDispatchMessage,
    executeConversationDispatchRequestResponse,
    executeConversationDispatchSideChat,
    executeProjectConversationIdempotent,
    executeTaskConversationIdempotent,
    executeWorkspaceGitCommand,
    executionHostAppVersion,
    executionHostHandoffs,
    executionHostInstanceId,
    executionHostMutationFence,
    executionHostStopCommands,
    executionHostWork,
    finalizeWorkManagementRuntimeStart,
    flushPendingNativeDeltaEvents,
    flushRuntimeLogFileWrites,
    flushRuntimePersistenceWrites,
    formatProjectScopedGraphViewTitle,
    getProjectDatabasePasswordSecretKey,
    getTelegramPollingService,
    gitCommands,
    graphConversationCommands,
    graphScanCommandOwners,
    inferNativeConversationSnapshotState,
    inspectTaskPushAttachments,
    inspectTaskTerminalCleanup,
    integrationCommands,
    invokeWorkManagementRuntimeStart,
    isAllowedLocalAppOrigin,
    isAuthorizedRealtimeRequest,
    isConfiguredTaskManagementStatus,
    isCriticalTelegramTaskStatus,
    isExplicitTelegramApiRejection,
    isNativeApiRecord,
    isReadOnlyValidationExternalRead,
    isWorkspaceGitExplicitRejection,
    longTermMemories,
    mapTaskRepositoriesWithConcurrency,
    mapWorkManagementTaskDomainError,
    modelConnections,
    nativeApiError,
    normalizeHeaderValue,
    normalizeImportedTelegramNotificationSettings,
    normalizeImportedTelegramSecuritySettings,
    now,
    options,
    ownsCodexAppServerManager,
    parseTelegramDispatchPreviewInput,
    parseTelegramNotificationSettingsInput,
    parseTelegramSecuritySettingsInput,
    persistGraphQuestionConversation,
    piNativeCoordinator,
    prepareConversationQueueReroute,
    prepareWorkManagementRuntimeStart,
    prepareWorkspaceGitCommand,
    projectRepositories,
    projectRoot,
    projectSharedPaths,
    projectionDatabases,
    projects,
    publishNativeConversationEvent,
    publishRealtimeEvent,
    readCodexRemoteControlStandalone,
    readCurrentGraphEdgeDetail,
    readCurrentGraphEdgesByNodeId,
    readCurrentGraphNeighborhood,
    readCurrentGraphNodeById,
    readCurrentGraphNodeByIdForProject,
    readCurrentGraphSummary,
    readCurrentGraphSummaryByProject,
    readCurrentGraphView,
    readCurrentGraphViewForProject,
    readGitDiff,
    readGitStatus,
    readOnlyValidation,
    readOnlyValidationSkippedCapabilities,
    readProjectConfig,
    readProjectDatabaseSecretSnapshot,
    readProjectVersion,
    readTaskWorkspaceSnapshot,
    readTelegramToken,
    recordTaskEvent,
    redactSensitiveText,
    releaseNotesAuthorizedRequests,
    releaseNotesCapabilities,
    requireCodexRemoteControlCommandPath,
    requireNativeQueueConversation,
    requireTelegramPollingService,
    resolveGraphProjectName,
    resolveNativeConversationExecutionRoot,
    resolveTaskIntegrationRequest,
    resolveTaskManagementStatusConfigForProject,
    resolveTaskPushContextState,
    resolveTaskWorkspaceRequest,
    restoreNativeConversation,
    retryTaskIntegrationAiPreparation,
    revokeReleaseNotesCapability,
    runCodeMapScan,
    runRuntimeLogRetention,
    runtimeEphemeralCapabilities,
    runtimeSessionCommands,
    runtimeSessionDataDirectory,
    runtimeTerminalStatus,
    searchCurrentGraphNodes,
    secretStore,
    sendNativeConversationApiError,
    sendTaskGitApiError,
    sendWorkspaceGitCommandError,
    settings,
    settingsCommands,
    settingsIdentityCatalog,
    settleCodexPendingOnClose,
    stopRunningTaskRuntimeSessions,
    taskConflictAiOperations,
    taskConversationReopenInProgressIds,
    taskEnvironments,
    taskEventFileProjection,
    taskIntegrationAttempts,
    taskIntegrations,
    taskManagementStatusIsTerminal,
    taskTemplates,
    taskWorkspaces,
    tasks,
    telegramCommandRouteError,
    telegramCommands,
    telegramConfirmationTtlMs,
    platformMutableState,
    telegramNotificationSettingsKey,
    telegramSecuritySettingsKey,
    telegramTaskNotificationTitle,
    toGraphConversationHistoryItem,
    toNativeDurableAcceptance,
    toNativeInterruptAcceptance,
    toNativeQueueApiSnapshot,
    toNativeServerRequest,
    toPassiveRuntimeStatus,
    toSecurityAuditLogEntry,
    turnChangeFiles,
    turnChangeSetService,
    turnChangeSets,
    unavailableTaskWorkspaceSnapshot,
    usageOverviewService,
    usageRefreshInFlight,
    workManagementCommands,
    workspaceGitCommands,
    writeTaskCompletionToGraphNode,
    zentaoCredentials,
  } = dependencies;
  let closeLocalServerResources: () => Promise<void>;
  server.get('/health', async () => {
    const storage = db.storageHealthSnapshot();
    const boundPort = getBoundPort();
    return {
      // Core 在只读故障态仍可服务读取和诊断；status/database 单独表达写入不可用，不能伪装为全健康。
      ok: true,
      app: 'Zeus',
      host: zeusLocalServerHost,
      port: boundPort,
      status: storage.state === 'read_only_validation' ? 'read_only_validation' : storage.writesAllowed ? 'ok' : 'degraded',
      appName: 'Zeus',
      version: readProjectVersion(projectRoot),
      database: storage.state === 'read_only_validation' ? 'read_only_validation' : storage.writesAllowed ? 'ok' : 'read_only_fault',
      runtime: readOnlyValidation ? 'blocked_by_read_only_validation' : 'ok',
      storage,
    };
  });

  server.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const origin = normalizeHeaderValue(request.headers.origin);
    if (!isAllowedLocalAppOrigin(origin)) {
      await reply.code(403).send({
        error: 'ZEUS_FORBIDDEN_ORIGIN',
        message: 'Zeus local API only accepts local app origins',
      });
      return;
    }
    applyLocalCorsHeaders(reply, origin);
    if (request.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  server.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.method === 'OPTIONS') return;
    const requestPath = request.url.split('?', 1)[0] ?? request.url;
    if (request.method === 'GET' && requestPath === '/api/events' && isAuthorizedRealtimeRequest(request)) return;
    if (!readOnlyValidation && authorizeReleaseNotesRequest(request)) return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${options.apiToken}`) {
      await reply.code(401).send({
        error: 'ZEUS_UNAUTHORIZED',
        message: 'Missing or invalid Zeus local API token',
      });
      return;
    }
    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (readOnlyValidation && (isMutation || isReadOnlyValidationExternalRead(requestPath))) {
      await reply.code(503).send({
        error: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
        message: '该能力在正式数据只读验证中已失败关闭；不会写副本，也不会访问 Provider、Keychain、Git、Runtime、Telegram、更新服务器或网页。',
        limitation: '复制库中的路径只作历史投影；只读验证不解析记录、不生成打开意图，也不读取目标文件。',
        mode: readOnlyValidation.mode,
        runId: readOnlyValidation.runId,
        manifestHash: readOnlyValidation.manifestHash,
        databaseSha256: readOnlyValidation.database.sha256,
        recoveryRequired: false,
      });
      return;
    }
    const isRecoveryPreflight = request.url.split('?', 1)[0] === '/api/diagnostics/storage/recovery-preflight';
    const storage = db.storageHealthSnapshot();
    if (isMutation && !isRecoveryPreflight && !storage.writesAllowed) {
      await reply.code(503).send({
        error: 'ZEUS_STORAGE_READ_ONLY_FAULT',
        message: 'Zeus 存储已进入只读保护；现有数据仍可读取，新的消息、任务、Git/终端命令与其他副作用已停止。请先恢复磁盘空间或权限，再执行恢复核验并重启 Zeus Core。',
        recoveryRequired: true,
        storage,
      });
      return;
    }
  });

  server.get('/api/diagnostics/storage', async () => db.storageHealthSnapshot());

  server.get('/api/diagnostics/read-only-validation', async (_request, reply) => {
    if (!readOnlyValidation) return reply.code(404).send({ error: 'ZEUS_READ_ONLY_VALIDATION_NOT_ACTIVE', message: '当前 Core 不是只读验证世代。' });
    return {
      mode: readOnlyValidation.mode,
      runId: readOnlyValidation.runId,
      manifestHash: readOnlyValidation.manifestHash,
      databaseSha256: readOnlyValidation.database.sha256,
      databaseBytes: readOnlyValidation.database.bytes,
      coreGeneration: executionHostInstanceId,
      skipped: readOnlyValidationSkippedCapabilities(),
    };
  });

  server.get('/api/diagnostics/storage/projections', async () => ({
    ...projectionDatabases.snapshot(),
    boundary: 'index.db/cache.db 可丢失并后台重建；其故障不会改变 Core SQLite 的可写状态。',
  }));

  server.get('/api/diagnostics/storage/artifacts', async (_request, reply) => {
    try {
      return {
        state: 'ready',
        health: artifactStore.health(),
        capacity: await artifactStore.capacityDiagnostic(),
        databaseReadOnlyFault: db.storageHealthSnapshot(),
      };
    } catch (error) {
      return reply.code(503).send({
        state: 'degraded',
        error: 'ZEUS_ARTIFACT_STORAGE_DIAGNOSTIC_FAILED',
        message: error instanceof Error ? error.message : 'Artifact 存储诊断失败。',
        health: artifactStore.health(),
        databaseReadOnlyFault: db.storageHealthSnapshot(),
        boundary: 'Artifact staging 的 ENOSPC/EIO/EROFS/EACCES 会进入 Core 统一只读保护；纯业务配额拒绝只返回明确业务错误。',
      });
    }
  });

  registerStorageRecoveryPreflightApi({ server, db, artifacts: artifactStore });

  const projectGitQueries = new ProjectGitQueryApplication({
    projects,
    repositories: projectRepositories,
    effects: {
      workspaceHasGitDirectory: (localPath) => existsSync(join(localPath, '.git')),
      readStatus: readGitStatus,
      readDiff: readGitDiff,
      readRepositorySnapshot: (localPath) => getProjectGitRepositorySnapshot(localPath),
      readCommit: (localPath, commitHash) => getProjectGitCommitDetail(localPath, commitHash),
      readComparison: (localPath, ref, mode) => getProjectGitComparisonDiff(localPath, ref, mode),
    },
    now,
  });
  registerProjectGitQueryRoutes({ server, application: projectGitQueries });

  const projectQueries = new ProjectQueryApplication({
    projects,
    tasks,
    sharedPaths: projectSharedPaths,
    readConfig: readProjectConfig,
    readGraphSummary: (project) => readCurrentGraphSummaryByProject(resolveGraphProjectName(project)),
    git: {
      readOverviewStatus: (project) => (readOnlyValidation ? Promise.resolve(projectGitQueries.unsupportedStatus('只读验证模式不访问正式项目 Git；仅展示复制库中的项目与任务投影。')) : projectGitQueries.readStatus(project.id)),
    },
  });
  registerProjectQueryRoutes({ server, application: projectQueries });

  const workManagementQueries = new WorkManagementQueryApplication({ projects, tasks, taskBoards, taskEvents, taskTemplates });
  registerWorkManagementQueryRoutes({ server, application: workManagementQueries });

  const runtimeQueries = new RuntimeQueryApplication({
    runtimeSessions,
    terminalEvents,
    liveRuntime: {
      listSessions: () => aiRuntimeManager.listSessions(),
      getSession: (sessionId) => aiRuntimeManager.getSession(sessionId),
    },
    adapters: {
      listAdapters: () => listAiCliAdapters(),
      checkAdapter: (adapterId, configuredCommandPath) => checkAiCliAdapter(adapterId, { commandPath: configuredCommandPath }),
    },
    readSettings: () => platformMutableState.runtimeSettings,
    now,
  });
  registerRuntimeQueryRoutes({ server, application: runtimeQueries });

  const codexSubagentQueries = new CodexSubagentQueryApplication({
    conversations,
    providerItems: conversationProviderItems,
    provider: {
      getState: () => codexAppServerManager.getState(),
      listThreads: (input) => codexAppServerManager.listThreads(input),
      readThread: (input) => codexAppServerManager.readThread(input),
    },
    runtime: createCodexSubagentRuntimeReader({ providerHistoryRoot: join(dataLayout.codexHome, 'sessions') }),
    now,
  });
  registerCodexSubagentQueryRoutes({ server, application: codexSubagentQueries });

  const conversationCapabilityQueries = new ConversationCapabilityQueryApplication({
    projects,
    tasks,
    repositories: projectRepositories,
    sharedPaths: projectSharedPaths,
    environments: taskEnvironments,
    workspaces: taskWorkspaces,
    conversations,
    submissions: conversationSubmissions,
    provider: {
      getState: () => codexAppServerManager.getState(),
      readAccount: () => codexAppServerManager.readAccount(),
    },
    modelCatalog: {
      getProjectSelection: (projectId) => modelConnections.getProjectSelection(projectId),
      listSelectableModels: () => modelConnections.listSelectableModels(),
    },
    git: {
      readRepositoryContext: (localPath) => getGitRepositoryContext(localPath),
      readWorktreeClean: (localPath, ignoredPaths) => getGitWorktreeClean(localPath, ignoredPaths),
    },
    taskContext: {
      read: (project, task) => resolveTaskPushContextState(project, task),
      readAttachmentOptions: (project, task) => inspectTaskPushAttachments(task, project.localPath).inspected.map((attachment: { option: TaskPushParentAttachmentOption }) => attachment.option),
    },
    readConfiguredModel: (projectId) => readProjectConfig(projectId).defaultModel ?? platformMutableState.runtimeSettings.adapterModels.codex ?? null,
    codexNativeEnabled: () => codexNativeEnabled,
    now,
  });
  registerConversationCapabilityQueryRoutes({ server, application: conversationCapabilityQueries });

  registerConversationSnapshotV2Api({
    server,
    repository: conversationSnapshotV2,
    compatibility: conversationSnapshotCompatibility,
    projectExists: (projectId) => Boolean(projects.getById(projectId)),
    getConversation: (conversationId) => conversations.getRecordById(conversationId),
    readQueueState: (conversationId) => {
      const conversation = conversations.getRecordById(conversationId);
      if (!conversation) throw new Error('Conversation not found');
      return toNativeQueueApiSnapshot(conversation);
    },
  });

  registerMemoryContextApi(
    server,
    new MemoryContextApplicationService({
      memory: longTermMemories,
      coldEvidence,
      commandDeliveries,
      getProject: (projectId) => {
        const project = projects.getById(projectId);
        return project ? { id: project.id, localPath: project.localPath } : undefined;
      },
      now,
    }),
  );

  registerConversationSyncRoutes({
    server,
    protocol: conversationSyncProtocol,
    flowControl: conversationEventFlow,
    subscribers: eventSubscribers,
    isAuthorizedRealtimeRequest,
    isNativeConversation: (conversationId, projectId) => {
      const conversation = conversations.getRecordById(conversationId);
      return Boolean(conversation && conversation.transportKind === 'codex_native' && (projectId === undefined || conversation.projectId === projectId));
    },
    synchronizeConversation: async (conversationId) => {
      if (readOnlyValidation) return;
      await codexNativeCoordinator.synchronizeOpenConversation({ conversationId });
    },
    serverIdentity: () => {
      const boundPort = getBoundPort();
      if (boundPort === null) throw new Error('Zeus local-server 尚未完成监听，不能发布实时连接身份。');
      return { app: 'Zeus', host: zeusLocalServerHost, port: boundPort };
    },
  });

  server.get(
    '/api/diagnostics/performance',
    async (
      request: FastifyRequest<{
        Querystring: { route?: string; recentLimit?: string };
      }>,
    ) => {
      const recentLimit = request.query.recentLimit !== undefined ? Number(request.query.recentLimit) : undefined;
      return {
        api: apiPerformance.snapshot({
          ...(request.query.route ? { route: request.query.route } : {}),
          ...(recentLimit !== undefined ? { recentLimit } : {}),
        }),
        database: db.databasePerformanceSnapshot({
          ...(recentLimit !== undefined ? { recentLimit } : {}),
        }),
        eventFlow: conversationEventFlow.snapshot(),
      };
    },
  );
  server.get('/api/diagnostics/heavy-workers', async () => heavyWorkerPoolSnapshot());

  server.post(
    '/api/command-runs/:runId/release-notes',
    async (
      request: FastifyRequest<{
        Params: { runId: string };
        Body: { model?: unknown; prompt?: unknown };
      }>,
      reply,
    ) => {
      const capability = releaseNotesCapabilities.get(request.params.runId);
      const run = commandRuns.getById(request.params.runId);
      if (!releaseNotesAuthorizedRequests.has(request) || !capability?.used || !run || run.projectId !== capability.projectId) {
        return reply.code(403).send({
          error: 'ZEUS_RELEASE_NOTES_CAPABILITY_REQUIRED',
          message: '发布说明能力无效、已使用或与命令不匹配。',
        });
      }
      try {
        const model = typeof request.body?.model === 'string' ? request.body.model : '';
        const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt : '';
        return await generateReleaseNotesWithDeepSeek(modelConnections, { model, prompt });
      } catch (error) {
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
        const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'ZEUS_RELEASE_NOTES_GENERATION_FAILED';
        return reply.code(statusCode).send({
          error: code,
          message: error instanceof Error ? error.message : '发布说明生成失败。',
        });
      } finally {
        revokeReleaseNotesCapability(request.params.runId);
      }
    },
  );

  const commandCenter = createCommandCenter({
    server,
    db,
    commandDeliveries,
    artifactStore,
    projects,
    runtimeSessions,
    aiRuntimeManager,
    commandScriptsDirectory: dataLayout.commandScripts,
    commandRunsDirectory: dataLayout.commandRuns,
    readProjectSecurity: (projectId) => readProjectConfig(projectId).security,
    buildRuntimeProcessEnv,
    createReleaseNotesCapability,
    revokeReleaseNotesCapability,
    resolveRuntimeSessionLogFiles: (sessionId) => {
      const sessionDirectory = runtimeSessionDataDirectory(sessionId);
      return [
        { relativePath: 'logs/terminal.raw.log', sourcePath: join(sessionDirectory, 'terminal.raw.log'), mimeType: 'text/plain; charset=utf-8' },
        { relativePath: 'logs/terminal.normalized.log', sourcePath: join(sessionDirectory, 'terminal.normalized.log'), mimeType: 'text/plain; charset=utf-8' },
      ].filter((descriptor) => existsSync(descriptor.sourcePath));
    },
    appendAuditLog,
    publishRealtimeEvent,
    save: () => db.save(),
    now,
    confirmationTtlMs: telegramConfirmationTtlMs,
    readOnlyValidation: Boolean(readOnlyValidation),
  });

  const executionHostControl = registerExecutionHostControlApi({
    server,
    host: options.executionHost,
    work: executionHostWork,
    codexManager: codexAppServerManager,
    codexCoordinator: codexNativeCoordinator,
    piCoordinator: piNativeCoordinator,
    goals: conversationGoals,
    conversations,
    turns: conversationTurns,
    submissions: conversationSubmissions,
    requests: conversationRequests,
    commandCenter,
    runtimeManager: aiRuntimeManager,
    stopCommands: executionHostStopCommands,
    redactSensitiveText,
    publish: publishNativeConversationEvent,
    save: () => db.save(),
    now,
    readOnlyValidation: Boolean(readOnlyValidation),
  });

  const pauseTelegramAdmission = createPollingAdmissionPause(
    executionHostMutationFence,
    getTelegramPollingService,
    () => platformMutableState.telegramPollingTimer,
    (timer) => (platformMutableState.telegramPollingTimer = timer),
  );

  registerExecutionHostHandoffApi({
    server,
    repository: executionHostHandoffs,
    fence: executionHostMutationFence,
    sourceInstanceId: executionHostInstanceId,
    sourceAppVersion: executionHostAppVersion,
    save: () => db.save(),
    pauseBackgroundAdmission: pauseTelegramAdmission,
    readBackgroundMutationBlockers: () => {
      const workers = heavyWorkerPoolSnapshot();
      const activeTaskIntegrationOperationIds = new Set(taskIntegrationAttempts.listByState('preparing').map((attempt: ZeusTaskIntegrationAttemptRecord) => attempt.id));
      for (const [operationId, operation] of taskConflictAiOperations) {
        if (operation.running || operation.finalizing) activeTaskIntegrationOperationIds.add(operationId);
      }
      return {
        activeProjectGraphScans: activeProjectGraphScanIds.size,
        activeHeavyWorkerJobs: workers.activeJobs,
        queuedHeavyWorkerJobs: workers.queuedJobs,
        // active 冲突交付在等待用户继续时只有持久化身份，不持有进程或写事务；
        // 仅 preparation、Provider 运行和最终合入属于必须排空的后台写入。
        taskIntegrationOperations: activeTaskIntegrationOperationIds.size,
      };
    },
    freezeBackgroundMutationSources: async () => {
      if (platformMutableState.usageRefreshTimer) clearInterval(platformMutableState.usageRefreshTimer);
      platformMutableState.usageRefreshTimer = undefined;
      await usageRefreshInFlight?.catch(() => undefined);
      await closeHeavyWorkerJobs();
      commandCenter.close();
      await codexLegacyImportService?.close();
      await codexNativeCoordinator.close({ mode: 'handoff' });
      if (platformMutableState.nativeEventSaveTimer) clearTimeout(platformMutableState.nativeEventSaveTimer);
      platformMutableState.nativeEventSaveTimer = null;
      flushPendingNativeDeltaEvents();
      await flushRuntimePersistenceWrites();
    },
    freezeBusinessMutationAdmission: () => db.freezeBusinessMutationAdmission(),
    prepareJournal: (handoffId, preparedAt) => db.runExecutionHostHandoffWrite(() => executionHostHandoffs.prepare(handoffId, preparedAt)),
    requireRecoveryJournal: (handoffId, reason, occurredAt) => db.runExecutionHostHandoffWrite(() => executionHostHandoffs.requireRecovery(handoffId, { reason, occurredAt })),
    publishPrepared: (prepared) => publishRealtimeEvent('execution_host.handoff.prepared', prepared),
    now,
  });

  server.get('/api/dashboard', async (): Promise<DashboardSnapshot> => {
    const currentProjects = projects.list();
    const boundPort = getBoundPort();
    return {
      app: 'Zeus',
      localServer: { host: zeusLocalServerHost, port: boundPort },
      projects: currentProjects,
      tasks: currentProjects.flatMap((project) => tasks.listByProject(project.id)),
      conversationAttentionByProject: conversationChoiceQueries.attentionByProject(currentProjects.map((project) => project.id)),
      conversationUnreadCountByProject: conversationChoiceQueries.unreadCountByProject(currentProjects.map((project) => project.id)),
      runtime: {
        aiCli: toPassiveRuntimeStatus(platformMutableState.runtimeSettings),
        telegram: readOnlyValidation ? getTelegramConfigurationState(undefined, []) : getTelegramConfigurationState(await readTelegramToken(), platformMutableState.telegramSecuritySettings.allowedUserIds),
      },
      git: readOnlyValidation ? projectGitQueries.unsupportedStatus('只读验证模式不访问仓库或启动 Heavy Worker；仅展示复制库中的持久投影。') : await readGitStatus(projectRoot),
      graph: readCurrentGraphSummary(),
    };
  });

  registerCodexPublicCommandRoutes({
    server,
    application: codexPublicCommands,
    configImport: codexConfigImportService,
    legacyImport: codexLegacyImportService,
    account: {
      ensureReady: () =>
        codexAppServerManager
          .ensureReady({
            commandPath: currentCodexRuntimeCommandPath(),
            ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}),
          })
          .then(() => undefined),
      startLogin: () => codexAppServerManager.startChatGptLogin(),
      cancelLogin: (loginId) => codexAppServerManager.cancelChatGptLogin({ loginId }),
    },
    remoteControl: {
      ensureReady: ensureCodexRemoteControlReady,
      readStatus: () => codexAppServerManager.readRemoteControlStatus(),
      enable: () => codexAppServerManager.enableRemoteControl(),
      disable: () => codexAppServerManager.disableRemoteControl(),
      startPairing: () => codexAppServerManager.startRemoteControlPairing({ manualCode: true }),
      readPairingStatus: (input) => codexAppServerManager.readRemoteControlPairingStatus(input),
      revokeClient: (input) => codexAppServerManager.revokeRemoteControlClient(input),
      buildSnapshot: buildCodexRemoteControlSnapshot,
      persistEnabled: ({ enabled, status, occurredAt }) => {
        settings.setJson(codexRemoteControlEnabledSettingKey, enabled);
        auditLogs.append({
          actorType: 'user',
          action: enabled ? 'codex.remote_control.enabled' : 'codex.remote_control.disabled',
          resourceType: 'settings',
          ...(status.environmentId ? { resourceId: status.environmentId } : {}),
          payload: { status: status.status, serverName: status.serverName },
          createdAt: occurredAt,
        });
      },
      adoptEnabled: (enabled) => {
        platformMutableState.codexRemoteControlEnabled = enabled;
      },
    },
    configuration: {
      activate: activateCurrentCodexConfiguration,
      recordImported: (result) => {
        auditLogs.append({
          actorType: 'user',
          action: 'settings.codex_config.imported',
          resourceType: 'settings',
          payload: {
            imported: result.imported,
            skipped: result.skipped.map((entry) => ({ path: entry.path, reason: entry.reason })),
            backupCreated: result.backupRoot !== null,
            restartRequired: result.restartRequired,
            runtimeReloaded: result.runtimeReloaded,
            runtimeGenerationId: result.runtimeGenerationId,
          },
          createdAt: result.importedAt,
        });
      },
    },
    now,
    sendNativeError: sendNativeConversationApiError,
  });

  server.get(
    '/api/projects/:projectId/conversations',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Querystring: {
          query?: string;
          limit?: string;
          offset?: string;
          archived?: string;
        };
      }>,
      reply,
    ): Promise<GraphConversationHistoryPage | unknown> => {
      const projectId = String(request.params.projectId);
      const project = projects.getById(projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const limit = Number.parseInt(String(request.query.limit ?? ''), 10);
      const offset = Number.parseInt(String(request.query.offset ?? ''), 10);
      const page = conversations.listByProject(project.id, {
        query: typeof request.query.query === 'string' ? request.query.query : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
        archived: String(request.query.archived ?? '') === 'true',
      });
      return {
        ...page,
        items: page.items.map(toGraphConversationHistoryItem),
      };
    },
  );

  registerConversationCommandRoutes({
    server,
    application: conversationCommands,
    projects,
    tasks,
    conversations,
    goals: conversationGoals,
    codex: codexNativeCoordinator,
    archiveNativeConversation,
    restoreNativeConversation,
    isConversationIdle: (conversation) => inferNativeConversationSnapshotState(conversation).type === 'idle',
    isTaskTerminal: taskManagementStatusIsTerminal,
    goalCapability: conversationGoalCapability,
    toConversationChoice: (conversation) => conversationChoiceQueries.toChoice(conversation),
    toConversationHistoryItem: toGraphConversationHistoryItem,
    appendAuditLog,
    publishNativeEvent: publishNativeConversationEvent,
    sendNativeError: sendNativeConversationApiError,
  });

  registerConversationDispatchCommandRoutes({
    server,
    application: conversationDispatchCommands,
    operations: {
      changeSet: async ({ params, action, changeSetId, expectedState, operationIdentity }) =>
        turnChangeSetService.operate({
          projectId: params.projectId,
          conversationId: params.conversationId,
          turnId: conversationTurns.listByConversation(params.conversationId).find((candidate) => candidate.id === params.turnId || candidate.providerTurnId === params.turnId)?.id ?? params.turnId,
          action,
          request: { changeSetId, expectedState, idempotencyKey: operationIdentity },
        }),
      message: executeConversationDispatchMessage,
      sideChat: executeConversationDispatchSideChat,
      queueUpdate: ({ params, content }) => {
        requireNativeQueueConversation(params);
        return conversationQueueCoreMutations.update({ conversationId: params.conversationId, submissionId: params.submissionId, content });
      },
      queueRetry: ({ params }) => {
        requireNativeQueueConversation(params);
        return conversationQueueCoreMutations.retry({ conversationId: params.conversationId, submissionId: params.submissionId });
      },
      prepareQueueReroute: prepareConversationQueueReroute,
      queueReroute: ({ params, prepared }) => applyConversationQueueReroute(params, prepared as Parameters<typeof applyConversationQueueReroute>[1]),
      queueDelete: ({ params }) => {
        requireNativeQueueConversation(params);
        return conversationQueueCoreMutations.delete({ conversationId: params.conversationId, submissionId: params.submissionId });
      },
      queueSendNow: async ({ params, operationIdentity }) => {
        const conversation = requireNativeQueueConversation(params);
        const operation = await codexNativeCoordinator.sendQueuedNow({ conversationId: conversation.id, submissionId: params.submissionId });
        const updatedConversation = conversations.getById(conversation.id);
        const submission = conversationSubmissions.getById(params.submissionId);
        if (!updatedConversation || !submission) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native send-now acceptance was not persisted.');
        void operation;
        return toNativeDurableAcceptance(operationIdentity, params.submissionId, updatedConversation, submission);
      },
      turnInterrupt: async ({ params, operationIdentity }) => {
        const conversation = requireNativeQueueConversation(params);
        const turn = conversationTurns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === params.turnId);
        if (!turn) throw Object.assign(nativeApiError('ZEUS_NATIVE_TURN_NOT_FOUND', 'Native provider turn not found'), { statusCode: 404 });
        const operation =
          conversation.agentKind === 'pi'
            ? await piNativeCoordinator.interruptTurn({ conversation, providerTurnId: params.turnId })
            : await codexNativeCoordinator.interruptTurn({ conversationId: conversation.id, providerTurnId: params.turnId });
        const updatedConversation = conversations.getById(conversation.id);
        const submission = operation.submissionId ? conversationSubmissions.getById(operation.submissionId) : undefined;
        if (!updatedConversation) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native interrupt acceptance was not persisted.');
        return toNativeInterruptAcceptance(operationIdentity, params.turnId, updatedConversation, submission);
      },
      serverRequestRespond: executeConversationDispatchRequestResponse,
      planImplementationRespond: async ({ params, action, feedback, operationIdentity }) => {
        const conversation = requireNativeQueueConversation(params);
        const operation = await codexNativeCoordinator.respondToPlanImplementationRequest({
          conversationId: conversation.id,
          requestId: params.requestId,
          action,
          operationIdentity,
          ...(feedback !== undefined ? { feedback } : {}),
        });
        const planRequest = conversationPlanActions.getById(params.requestId);
        const updatedConversation = conversations.getById(conversation.id);
        if (!planRequest || !updatedConversation) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Plan implementation response was not persisted.');
        return { operation, request: planRequest, queue: toNativeQueueApiSnapshot(updatedConversation), acknowledged: true };
      },
      requestSnooze: ({ params }) => {
        const conversation = requireNativeQueueConversation(params);
        const providerRequest = conversationRequests.getById(params.requestId);
        if (!providerRequest || providerRequest.conversationId !== conversation.id) throw Object.assign(nativeApiError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request not found'), { statusCode: 404 });
        conversationQueueCoreMutations.snooze({ conversationId: conversation.id, requestId: providerRequest.id });
        return { request: toNativeServerRequest(conversationRequests.getById(providerRequest.id)!) };
      },
      queueResume: async ({ params }) => {
        const conversation = requireNativeQueueConversation(params);
        return codexNativeCoordinator.resumeInterruptedQueue({ conversationId: conversation.id });
      },
      queueRecover: async ({ params }) => {
        const conversation = requireNativeQueueConversation(params);
        const conflictAttempt = taskIntegrationAttempts.getByConversationId(conversation.id);
        if (conflictAttempt?.state === 'failed') {
          await retryTaskIntegrationAiPreparation(conversation, conflictAttempt);
          return toNativeQueueApiSnapshot(conversation);
        }
        return codexNativeCoordinator.recoverQueue({ conversationId: conversation.id });
      },
      queueReorder: ({ params, orderedSubmissionIds }) => {
        const conversation = requireNativeQueueConversation(params);
        return conversationQueueCoreMutations.reorder({ conversationId: conversation.id, orderedSubmissionIds });
      },
      afterCoreAccepted: ({ kind, params }) => {
        if (kind === 'request_snooze') {
          if ('requestId' in params) {
            publishNativeConversationEvent('conversation.request.snoozed', { conversationId: params.conversationId, requestId: String(params.requestId) });
          }
          return;
        }
        publishNativeConversationEvent('conversation.queue.changed', { conversationId: params.conversationId });
        if (kind === 'queue_retry' || kind === 'queue_reroute' || kind === 'queue_delete') {
          queueMicrotask(() => void dispatchUnifiedConversationQueueHead?.(params.conversationId).catch(() => undefined));
        }
      },
    },
    sendNativeError: sendNativeConversationApiError,
    sendChangeSetError: (reply, error) =>
      reply.code(changeSetErrorStatus(error)).send({
        error: turnChangeSetErrorCode(error),
        message: error instanceof Error ? error.message : 'Turn change set operation failed.',
        ...(error instanceof Error && 'paths' in error && Array.isArray((error as Error & { paths?: unknown }).paths) ? { paths: (error as Error & { paths: unknown[] }).paths } : {}),
      }),
  });

  type PreparedGraphProject = { kind: 'project'; project: ZeusProjectRecord; scanKey?: string };
  type PreparedGraphTask = { kind: 'task'; project: ZeusProjectRecord; task: ZeusTaskRecord };
  type PreparedCurrentGraph = { kind: 'current'; scanKey: string };

  registerGraphConversationCommandRoutes({
    server,
    application: graphConversationCommands,
    operations: {
      prepareProjectConversation: async ({ projectId, value }) => {
        const project = projects.getById(projectId);
        if (!project) graphConversationReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
        assertRequestedAgentIsCodex(value);
        if (value.mode !== 'create') graphConversationReject(400, 'ZEUS_INVALID_CONVERSATION_START', 'Project conversations require mode create.');
        return { kind: 'project', project } satisfies PreparedGraphProject;
      },
      startProjectConversation: ({ prepared, value, operationIdentity, markExternalWriteStarted }) => {
        const { project } = requirePreparedGraphProject(prepared);
        return executeProjectConversationIdempotent(project, value, operationIdentity, markExternalWriteStarted);
      },
      prepareTaskConversation: async ({ taskId, value }) => {
        const task = tasks.getById(taskId);
        if (!task) graphConversationReject(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found');
        if (taskManagementStatusIsTerminal(task)) {
          graphConversationReject(409, 'ZEUS_TASK_REOPEN_REQUIRED', 'This task is completed or cancelled. Reopen the task and restore one archived conversation before continuing.');
        }
        const project = projects.getById(task.projectId);
        if (!project) graphConversationReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
        assertRequestedAgentKind(value);
        return { kind: 'task', project, task } satisfies PreparedGraphTask;
      },
      startTaskConversation: ({ prepared, value, operationIdentity, markExternalWriteStarted }) => {
        const { project, task } = requirePreparedGraphTask(prepared);
        return executeTaskConversationIdempotent(project, task, value, operationIdentity, markExternalWriteStarted);
      },
      prepareProjectScan: async ({ projectId, operationIdentity }) => {
        const project = projects.getById(projectId);
        if (!project) graphConversationReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
        assertSafeGraphScanRoot(project.localPath);
        reserveGraphScan(project.id, operationIdentity);
        return { kind: 'project', project, scanKey: project.id } satisfies PreparedGraphProject;
      },
      runProjectScan: async ({ prepared }) => {
        const { project } = requirePreparedGraphProject(prepared);
        projects.updateScanStatus(project.id, 'scanning');
        await db.save();
        return toPublicGraphScanResult(
          await runCodeMapScan({
            projectName: project.name,
            graphProjectName: resolveGraphProjectName(project),
            rootPath: project.localPath,
            projectConfig: readProjectConfig(project.id),
          }),
        );
      },
      commitProjectScanAccepted: ({ prepared }) => {
        const { project } = requirePreparedGraphProject(prepared);
        projects.updateScanStatus(project.id, 'completed');
      },
      commitProjectScanFailure: ({ prepared, error }) => {
        const { project } = requirePreparedGraphProject(prepared);
        projects.updateScanStatus(project.id, 'failed');
        const message = redactSensitiveText(error instanceof Error ? error.message : String(error)).text;
        db.afterCommit(() => {
          publishRealtimeEvent('project.scan.failed', { projectName: project.name, rootPath: project.localPath, message });
        });
      },
      releaseProjectScan: ({ prepared, operationIdentity }) => {
        const value = requirePreparedGraphProject(prepared);
        if (value.scanKey) releaseGraphScan(value.scanKey, operationIdentity);
      },
      prepareGraphAsk: async ({ projectId }) => {
        const project = projects.getById(projectId);
        if (!project) graphConversationReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
        return { kind: 'project', project } satisfies PreparedGraphProject;
      },
      askGraph: async ({ prepared, question, operationIdentity }) => {
        const { project } = requirePreparedGraphProject(prepared);
        const answer = await answerProjectGraphQuestion(project, question, operationIdentity);
        persistGraphQuestionConversation(answer);
        await db.save();
        return answer;
      },
      prepareCurrentScan: async ({ operationIdentity }) => {
        assertSafeGraphScanRoot(projectRoot);
        const scanKey = `current:${projectRoot}`;
        reserveGraphScan(scanKey, operationIdentity);
        return { kind: 'current', scanKey } satisfies PreparedCurrentGraph;
      },
      runCurrentScan: async () =>
        toPublicGraphScanResult(
          await runCodeMapScan({
            projectName: 'Zeus',
            rootPath: projectRoot,
          }),
        ),
      releaseCurrentScan: ({ prepared, operationIdentity }) => releaseGraphScan(requirePreparedCurrentGraph(prepared).scanKey, operationIdentity),
      isExplicitRejection: isExplicitGraphConversationRejection,
    },
    sendNativeError: sendNativeConversationApiError,
  });

  function requirePreparedGraphProject(value: unknown): PreparedGraphProject {
    if (!isNativeApiRecord(value) || value.kind !== 'project' || !isNativeApiRecord(value.project)) {
      graphConversationReject(500, 'ZEUS_GRAPH_CONVERSATION_PREPARE_MISSING', 'Prepared project command context is unavailable.');
    }
    return value as unknown as PreparedGraphProject;
  }

  function requirePreparedGraphTask(value: unknown): PreparedGraphTask {
    if (!isNativeApiRecord(value) || value.kind !== 'task' || !isNativeApiRecord(value.project) || !isNativeApiRecord(value.task)) {
      graphConversationReject(500, 'ZEUS_GRAPH_CONVERSATION_PREPARE_MISSING', 'Prepared task conversation context is unavailable.');
    }
    return value as unknown as PreparedGraphTask;
  }

  function requirePreparedCurrentGraph(value: unknown): PreparedCurrentGraph {
    if (!isNativeApiRecord(value) || value.kind !== 'current' || typeof value.scanKey !== 'string') {
      graphConversationReject(500, 'ZEUS_GRAPH_CONVERSATION_PREPARE_MISSING', 'Prepared current graph context is unavailable.');
    }
    return value as unknown as PreparedCurrentGraph;
  }

  function assertSafeGraphScanRoot(rootPath: string): void {
    if (isUnsafeCodeMapScanRoot(resolveCodeMapScanRoot(rootPath, platformMutableState.codeMapSettings))) {
      graphConversationReject(400, 'ZEUS_UNSAFE_GRAPH_SCAN_ROOT', 'Refusing to scan an unsafe filesystem root.');
    }
  }

  function reserveGraphScan(scanKey: string, operationIdentity: string): void {
    const owner = graphScanCommandOwners.get(scanKey);
    if (activeProjectGraphScanIds.has(scanKey) && owner !== operationIdentity) {
      graphConversationReject(409, 'ZEUS_GRAPH_SCAN_ALREADY_RUNNING', 'Graph scan is already running for this project.');
    }
    graphScanCommandOwners.set(scanKey, operationIdentity);
    activeProjectGraphScanIds.add(scanKey);
  }

  function releaseGraphScan(scanKey: string, operationIdentity: string): void {
    if (graphScanCommandOwners.get(scanKey) !== operationIdentity) return;
    graphScanCommandOwners.delete(scanKey);
    activeProjectGraphScanIds.delete(scanKey);
  }

  function toPublicGraphScanResult(result: Record<string, unknown>): Record<string, unknown> {
    const publicResult = { ...result };
    delete publicResult.heavyWorkerResultRef;
    return publicResult;
  }

  server.get('/api/projects/:projectId/conversations/:conversationId/goal', async (request: FastifyRequest<{ Params: { projectId: string; conversationId: string } }>, reply) => {
    const conversation = conversations.getById(request.params.conversationId);
    if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
      return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
    }
    if (readOnlyValidation) {
      return {
        goal: conversation.agentKind === 'codex' ? (conversationGoals.get(conversation.id) ?? null) : null,
        timeline: conversationGoals.listEvents(conversation.id),
        capability: { supported: false, enabled: false, stage: null, reason: 'unverified' as const },
        projection: {
          source: 'copied_database' as const,
          refreshBlocked: true,
          limitation: '只读验证只展示复制时已持久化的目标投影，不访问 Provider，也不把它描述为最新状态。',
        },
      };
    }
    try {
      const goal = conversation.agentKind === 'codex' ? await codexNativeCoordinator.readGoal({ conversationId: conversation.id }) : null;
      return { goal, timeline: conversationGoals.listEvents(conversation.id), capability: conversationGoalCapability(conversation) };
    } catch (error) {
      return sendNativeConversationApiError(reply, error);
    }
  });

  server.get(
    '/api/projects/:projectId/conversations/:conversationId/choice',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
      const conversation = conversations.getRecordById(request.params.conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        return reply.code(404).send({ error: 'ZEUS_CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
      }
      return conversationChoiceQueries.toChoice(conversation, conversationChoiceQueries.buildContext(project.id));
    },
  );

  server.get(
    '/api/projects/:projectId/conversations/:conversationId/pending-requests',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
      const conversation = conversations.getRecordById(request.params.conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        return reply.code(404).send({ error: 'ZEUS_CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
      }
      const pendingPlanAction = conversationPlanActions.getLatestPending(conversation.id);
      // 询问回答是用户参与会话的正文历史，不是一次性 pending UI。只补回已经解决的
      // request_user_input；命令审批等协议请求仍由处理过程承载，避免扩大首屏载荷。
      const visibleRequests = conversationRequests.listByConversation(conversation.id).filter((request) => request.status === 'pending' || (request.requestKind === 'request_user_input' && request.status === 'resolved'));
      return {
        conversationId: conversation.id,
        // 先保留存储层本地身份；Renderer 会使用当前快照已知的映射统一为 Provider
        // 身份。这样超出最近轮次窗口的旧正文和旧回答仍共同使用本地 turnId，
        // 不会因为只有回答被提前转换而拆散到两个轮次。
        requests: visibleRequests.map(toNativeServerRequest),
        planImplementationRequests: pendingPlanAction ? [pendingPlanAction] : [],
      };
    },
  );

  server.get(
    '/api/projects/:projectId/conversations/:conversationId',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
      }>,
      reply,
    ): Promise<GraphConversationHistoryItem | unknown> => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        return reply.code(404).send({
          error: 'ZEUS_CONVERSATION_NOT_FOUND',
          message: 'Conversation not found',
        });
      }
      conversationSnapshotCompatibility.recordV1(request);
      reply.header('deprecation', 'true');
      reply.header('link', `</api/projects/${encodeURIComponent(project.id)}/conversations/${encodeURIComponent(conversation.id)}/snapshot-v2>; rel="successor-version"`);
      return reply.code(410).send({
        error: 'ZEUS_CONVERSATION_SNAPSHOT_V1_RETIRED',
        message: '会话 V1 快照已经退役；请使用 Snapshot V2。',
        successor: `/api/projects/${encodeURIComponent(project.id)}/conversations/${encodeURIComponent(conversation.id)}/snapshot-v2`,
      });
    },
  );

  server.get('/api/projects/:projectId/conversations/:conversationId/resources', async (request: FastifyRequest<{ Params: { projectId: string; conversationId: string } }>, reply) => {
    const conversation = conversations.getById(request.params.conversationId);
    if (!conversation || conversation.projectId !== request.params.projectId) {
      return reply.code(404).send({ error: 'ZEUS_CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
    }
    return {
      items: conversationResources
        .listByConversation(conversation.id)
        .map(toConversationResource)
        .filter((resource): resource is NonNullable<typeof resource> => resource !== null),
    };
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/resources/:resourceId/open-intent', async (request: FastifyRequest<{ Params: { projectId: string; conversationId: string; resourceId: string } }>, reply) => {
    const record = conversationResources.getById(request.params.resourceId);
    if (!record || record.projectId !== request.params.projectId || record.conversationId !== request.params.conversationId) {
      return reply.code(404).send({ error: 'ZEUS_CONVERSATION_RESOURCE_NOT_FOUND', message: 'Conversation resource not found' });
    }
    return toConversationResourceOpenIntent(record);
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/resources/:resourceId/preview', async (request: FastifyRequest<{ Params: { projectId: string; conversationId: string; resourceId: string } }>, reply) => {
    const record = conversationResources.getById(request.params.resourceId);
    if (!record || record.projectId !== request.params.projectId || record.conversationId !== request.params.conversationId) {
      return reply.code(404).send({ error: 'ZEUS_CONVERSATION_RESOURCE_NOT_FOUND', message: 'Conversation resource not found' });
    }
    const resource = toConversationResource(record);
    if (!resource || resource.kind === 'website') {
      return reply.code(400).send({ error: 'ZEUS_CONVERSATION_RESOURCE_NOT_PREVIEWABLE', message: 'This resource is not a local previewable file' });
    }
    try {
      return readConversationResourcePreview(resource, toConversationResourceOpenIntent(record));
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code ?? '') : '';
      const status = code === 'ZEUS_CONVERSATION_RESOURCE_FORBIDDEN' ? 403 : code === 'ZEUS_CONVERSATION_RESOURCE_TOO_LARGE' ? 413 : 409;
      return reply.code(status).send({
        error: code || 'ZEUS_CONVERSATION_RESOURCE_PREVIEW_FAILED',
        message: error instanceof Error ? error.message : 'Conversation resource preview failed',
      });
    }
  });

  type TurnChangeFileOpenParams = { projectId: string; conversationId: string; turnId: string; changeSetId: string; fileId: string };

  function turnChangeFileOpenError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
    return Object.assign(new Error(message), { code, statusCode });
  }

  function resolveTurnChangeFileOpenGrant(params: TurnChangeFileOpenParams): ConversationFileOpenGrant {
    const conversation = conversations.getById(params.conversationId);
    if (!conversation || conversation.projectId !== params.projectId) {
      throw turnChangeFileOpenError('ZEUS_CONVERSATION_NOT_FOUND', 'Conversation not found.', 404);
    }
    const turn = conversationTurns.listByConversation(conversation.id).find((candidate) => candidate.id === params.turnId || candidate.providerTurnId === params.turnId);
    if (!turn) throw turnChangeFileOpenError('ZEUS_CONVERSATION_TURN_NOT_FOUND', 'Conversation turn not found.', 404);
    const changeSet = turnChangeSets.getByTurn(conversation.id, turn.id);
    if (!changeSet || changeSet.id !== params.changeSetId || changeSet.projectId !== params.projectId) {
      throw turnChangeFileOpenError('ZEUS_TURN_CHANGE_SET_NOT_FOUND', 'Turn change set not found.', 404);
    }
    const file = turnChangeFiles.getById(params.fileId);
    if (!file || file.changeSetId !== changeSet.id) {
      throw turnChangeFileOpenError('ZEUS_TURN_CHANGE_FILE_NOT_FOUND', 'Turn change file not found.', 404);
    }
    if (changeSet.state === 'capturing' || changeSet.state === 'undoing' || changeSet.state === 'reapplying') {
      throw turnChangeFileOpenError('ZEUS_TURN_CHANGE_FILE_TRANSITIONING', 'The changed file is currently being updated. Try again after the operation finishes.', 409);
    }
    const currentPath = changeSet.state === 'undone' ? file.oldPath : file.newPath;
    if (!currentPath) {
      throw turnChangeFileOpenError('ZEUS_TURN_CHANGE_FILE_NOT_PRESENT', 'The changed file does not exist in the current workspace state.', 409);
    }
    const executionRoot = resolveNativeConversationExecutionRoot(conversation);
    if (!executionRoot) {
      throw turnChangeFileOpenError('ZEUS_TURN_CHANGE_FILE_ROOT_UNAVAILABLE', 'The current workspace for this conversation is unavailable.', 409);
    }
    const grant = createConversationFileOpenGrant({
      id: `turn_change_file_open_${file.id}`,
      projectId: params.projectId,
      projectRoot: executionRoot,
      conversationId: conversation.id,
      turnId: turn.id,
      itemId: file.sourceItemId ?? file.id,
      projectRelativePath: currentPath,
      now: now().toISOString(),
    });
    if (!grant) {
      throw turnChangeFileOpenError('ZEUS_TURN_CHANGE_FILE_PATH_FORBIDDEN', 'The changed file path is outside the current workspace.', 403);
    }
    const absolutePath = typeof grant.intent.target.absolutePath === 'string' ? grant.intent.target.absolutePath : '';
    const allowedRoot = typeof grant.intent.authority.allowedRoot === 'string' ? grant.intent.authority.allowedRoot : '';
    let rootRealPath: string;
    let fileRealPath: string;
    try {
      rootRealPath = realpathSync(allowedRoot);
    } catch {
      throw turnChangeFileOpenError('ZEUS_TURN_CHANGE_FILE_ROOT_UNAVAILABLE', 'The current workspace for this conversation is unavailable.', 409);
    }
    try {
      fileRealPath = realpathSync(absolutePath);
    } catch {
      throw turnChangeFileOpenError('ZEUS_TURN_CHANGE_FILE_NOT_PRESENT', 'The changed file does not exist in the current workspace state.', 409);
    }
    if (!isPathInsideRoot(fileRealPath, rootRealPath) || fileRealPath === rootRealPath) {
      throw turnChangeFileOpenError('ZEUS_TURN_CHANGE_FILE_PATH_FORBIDDEN', 'The changed file resolves outside the current workspace.', 403);
    }
    if (!statSync(fileRealPath).isFile()) {
      throw turnChangeFileOpenError('ZEUS_TURN_CHANGE_FILE_NOT_FILE', 'The changed path is not a regular file.', 409);
    }
    return grant;
  }

  function sendTurnChangeFileOpenError(reply: FastifyReply, error: unknown) {
    const code = error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code ?? '') : '';
    const explicitStatus = error instanceof Error && 'statusCode' in error && typeof (error as Error & { statusCode?: unknown }).statusCode === 'number' ? (error as Error & { statusCode: number }).statusCode : null;
    const status = explicitStatus ?? (code === 'ZEUS_CONVERSATION_RESOURCE_FORBIDDEN' ? 403 : code === 'ZEUS_CONVERSATION_RESOURCE_TOO_LARGE' ? 413 : 409);
    return reply.code(status).send({
      error: code || 'ZEUS_TURN_CHANGE_FILE_OPEN_FAILED',
      message: error instanceof Error ? error.message : 'Turn change file open failed.',
    });
  }

  server.get('/api/projects/:projectId/conversations/:conversationId/turns/:turnId/change-set/:changeSetId/files/:fileId/open-intent', async (request: FastifyRequest<{ Params: TurnChangeFileOpenParams }>, reply) => {
    try {
      return resolveTurnChangeFileOpenGrant(request.params).intent;
    } catch (error) {
      return sendTurnChangeFileOpenError(reply, error);
    }
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/turns/:turnId/change-set/:changeSetId/files/:fileId/preview', async (request: FastifyRequest<{ Params: TurnChangeFileOpenParams }>, reply) => {
    try {
      const grant = resolveTurnChangeFileOpenGrant(request.params);
      return readConversationResourcePreview(grant.resource, grant.intent);
    } catch (error) {
      return sendTurnChangeFileOpenError(reply, error);
    }
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/turns/:turnId/change-set', async (request: FastifyRequest<{ Params: { projectId: string; conversationId: string; turnId: string } }>, reply) => {
    const conversation = conversations.getById(request.params.conversationId);
    if (!conversation || conversation.projectId !== request.params.projectId) {
      return reply.code(404).send({ error: 'ZEUS_CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
    }
    const turn = conversationTurns.listByConversation(conversation.id).find((candidate) => candidate.id === request.params.turnId || candidate.providerTurnId === request.params.turnId);
    if (!turn) return reply.code(404).send({ error: 'ZEUS_CONVERSATION_TURN_NOT_FOUND', message: 'Conversation turn not found' });
    const changeSet = turnChangeSetService.getByTurn(conversation.id, turn.id);
    if (!changeSet) return reply.code(404).send({ error: 'ZEUS_TURN_CHANGE_SET_NOT_FOUND', message: 'Turn change set not found' });
    return changeSet;
  });

  const readConversationToolResult = async (
    request: FastifyRequest<{
      Params: { projectId: string; conversationId: string; handle?: string };
      Querystring: { handle?: string; offset?: string; limit?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const conversation = conversations.getRecordById(request.params.conversationId);
    if (!conversation || conversation.projectId !== request.params.projectId)
      return reply.code(404).send({
        error: 'ZEUS_CONVERSATION_NOT_FOUND',
        message: 'Conversation not found',
      });
    const handle = request.query.handle ?? request.params.handle;
    if (!handle)
      return reply.code(400).send({
        error: 'ZEUS_CONVERSATION_TOOL_RESULT_INVALID_HANDLE',
        message: '工具结果句柄不能为空。',
      });
    try {
      return await conversationToolResults.readPage({
        conversationId: conversation.id,
        handle,
        offset: request.query.offset === undefined ? undefined : Number(request.query.offset),
        limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
      });
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? String(
              (
                error as Error & {
                  code?: unknown;
                }
              ).code ?? '',
            )
          : 'ZEUS_CONVERSATION_TOOL_RESULT_READ_FAILED';
      return reply.code(code === 'ZEUS_CONVERSATION_TOOL_RESULT_NOT_FOUND' ? 404 : 409).send({
        error: code,
        message: error instanceof Error ? error.message : '工具结果读取失败。',
      });
    }
  };

  // 工具结果句柄与正文句柄同样可能超过路径参数上限；查询参数入口为当前协议，旧路径仅保留兼容。
  server.get('/api/projects/:projectId/conversations/:conversationId/tool-results', readConversationToolResult);
  server.get(
    '/api/projects/:projectId/conversations/:conversationId/tool-results/:handle',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string; handle: string };
        Querystring: { handle?: string; offset?: string; limit?: string };
      }>,
      reply,
    ) => readConversationToolResult(request, reply),
  );

  server.get('/api/conversations/archived', async () => {
    const choices = conversationChoiceQueries.listArchivedChoices();
    return { choices, items: choices };
  });

  server.get('/api/projects/:projectId/database/secret', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply): Promise<ProjectDatabaseSecretSnapshot | unknown> => {
    const project = projects.getById(request.params.projectId);
    if (!project)
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    return readProjectDatabaseSecretSnapshot(project.id);
  });

  server.put(
    '/api/projects/:projectId/database/secret',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: SettingsCommandRequest<SaveProjectDatabaseSecretBody>;
      }>,
      reply,
    ): Promise<ProjectDatabaseSecretSnapshot | unknown> => {
      try {
        const parsed = settingsCommands.parse<SaveProjectDatabaseSecretBody>({
          value: request.body,
          commandType: settingsCommandTypes.projectDatabaseSecretPut,
          scopeKind: 'project',
          expectedScopeId: () => request.params.projectId,
        });
        const project = projects.getById(request.params.projectId);
        if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
        const secretKey = getProjectDatabasePasswordSecretKey(project.id);
        if (!secretKey) return reply.code(400).send({ error: 'ZEUS_DATABASE_CONNECTION_NOT_CONFIGURED', message: 'Project database connection name is required before saving a password' });
        const password = parsed.input.password?.trim();
        if (!password) return reply.code(400).send({ error: 'ZEUS_INVALID_SECRET', message: 'Database connection password is required' });
        const mutation = await settingsCommands.executeExternal({
          parsed,
          destinationId: 'project_database_secret',
          resourceId: secretKey.key,
          externalOperationId: `${parsed.operationIdentity}:keychain-put`,
          sensitiveValues: [password],
          invoke: async () => {
            await secretStore.setSecret(secretKey.key, password);
            return { connectionName: secretKey.connectionName, password: getSecretPresenceLabel(password) };
          },
          mutateAcceptedBusinessState: () => {
            appendAuditLog({
              actorType: 'local_api',
              action: 'security.secret.database_connection_password.saved',
              resourceType: 'secret',
              resourceId: secretKey.key,
              payload: { projectId: project.id, connectionName: secretKey.connectionName, configured: true, secretValueStored: false },
            });
          },
        });
        return mutation.result;
      } catch (error) {
        const mapped = settingsCommandHttpError(error, redactSensitiveText);
        return reply.code(mapped.statusCode).send(mapped.body);
      }
    },
  );

  server.delete(
    '/api/projects/:projectId/database/secret',
    async (request: FastifyRequest<{ Params: { projectId: string }; Body: SettingsCommandRequest<Record<string, never>> }>, reply): Promise<ProjectDatabaseSecretSnapshot | unknown> => {
      try {
        const parsed = settingsCommands.parse<Record<string, never>>({
          value: request.body,
          commandType: settingsCommandTypes.projectDatabaseSecretDelete,
          scopeKind: 'project',
          expectedScopeId: () => request.params.projectId,
        });
        if (Object.keys(parsed.input).length !== 0) return reply.code(400).send({ error: 'ZEUS_SETTINGS_COMMAND_INVALID', message: 'Database secret delete input must be empty.' });
        const project = projects.getById(request.params.projectId);
        if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
        const secretKey = getProjectDatabasePasswordSecretKey(project.id);
        const mutation = await settingsCommands.executeExternal({
          parsed,
          destinationId: 'project_database_secret',
          resourceId: secretKey?.key ?? `project:${project.id}:database-secret`,
          externalOperationId: `${parsed.operationIdentity}:keychain-delete`,
          invoke: async () => {
            if (secretKey) await secretStore.deleteSecret(secretKey.key);
            return { connectionName: secretKey?.connectionName ?? null, password: getSecretPresenceLabel(undefined) };
          },
          mutateAcceptedBusinessState: () => {
            appendAuditLog({
              actorType: 'local_api',
              action: 'security.secret.database_connection_password.deleted',
              resourceType: 'secret',
              resourceId: secretKey?.key ?? `project:${project.id}:database-secret`,
              payload: { projectId: project.id, connectionName: secretKey?.connectionName ?? null, configured: false },
            });
          },
        });
        return mutation.result;
      } catch (error) {
        const mapped = settingsCommandHttpError(error, redactSensitiveText);
        return reply.code(mapped.statusCode).send(mapped.body);
      }
    },
  );

  server.put(
    '/api/projects/:projectId/config',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: SettingsCommandRequest<UpdateProjectConfigBody>;
      }>,
      reply,
    ): Promise<ProjectConfigSnapshot | unknown> => {
      try {
        const parsed = settingsCommands.parse<UpdateProjectConfigBody>({
          value: request.body,
          commandType: settingsCommandTypes.projectConfigPut,
          scopeKind: 'project',
          expectedScopeId: () => request.params.projectId,
        });
        const project = projects.getById(request.params.projectId);
        if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
        const nextConfig = normalizeProjectConfig(project.id, parsed.input, readProjectConfig(project.id));
        if (!nextConfig) return reply.code(400).send({ error: 'ZEUS_INVALID_PROJECT_CONFIG', message: 'Project config must use safe single-line values and supported options' });
        if (hasDatabaseUriPassword(nextConfig.database.connectionName)) {
          return reply.code(400).send({ error: 'ZEUS_DATABASE_CONNECTION_SECRET_IN_URI', message: 'Database connection URI must not include a password; save the password in the project Keychain field.' });
        }
        const mutation = settingsCommands.executeCore({
          parsed,
          destinationId: 'project_config',
          resourceId: project.id,
          mutateBusinessState: () => {
            settings.setJson(projectConfigSettingsPrefix + project.id, nextConfig);
            appendAuditLog({
              actorType: 'local_api',
              action: 'project.config.updated',
              resourceType: 'project',
              resourceId: project.id,
              payload: { defaultWorkMode: nextConfig.defaultWorkMode, indexScope: nextConfig.scan.indexScope, language: nextConfig.language.primary },
            });
            return nextConfig;
          },
        });
        return mutation.result;
      } catch (error) {
        const mapped = settingsCommandHttpError(error, redactSensitiveText);
        return reply.code(mapped.statusCode).send(mapped.body);
      }
    },
  );

  server.get('/api/tasks/:taskId/git-workspaces', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    const project = projects.getById(task.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    let items: Array<Record<string, unknown>>;
    try {
      items = await mapTaskRepositoriesWithConcurrency(taskWorkspaces.listByTask(task.id), async (workspace) => {
        try {
          return await readTaskWorkspaceSnapshot(project, workspace);
        } catch (error) {
          return unavailableTaskWorkspaceSnapshot(workspace, error);
        }
      });
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
    return {
      taskId: task.id,
      projectId: project.id,
      primaryBranch: items[0]?.primaryBranch ?? null,
      localBranches: items[0]?.localBranches ?? [],
      targetBranches: items[0]?.targetBranches ?? [],
      items,
      workspaces: items,
    };
  });

  server.get('/api/tasks/:taskId/git-workspaces/index', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    const project = projects.getById(task.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    const items = taskWorkspaces.listByTask(task.id).map((workspace) => ({
      ...workspace,
      activeConversationCount: countTaskWorkspaceActiveConversations(workspace),
    }));
    return { taskId: task.id, projectId: project.id, items, workspaces: items };
  });

  server.get('/api/tasks/:taskId/git-workspaces/:workspaceId/snapshot', async (request: FastifyRequest<{ Params: { taskId: string; workspaceId: string } }>, reply) => {
    const resolved = resolveTaskWorkspaceRequest(request.params.taskId, request.params.workspaceId);
    if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
    try {
      return { workspace: await readTaskWorkspaceSnapshot(resolved.project, resolved.workspace) };
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
  });

  server.get(
    '/api/tasks/:taskId/git-workspaces/:workspaceId/file-diff',
    async (
      request: FastifyRequest<{
        Params: { taskId: string; workspaceId: string };
        Querystring: { path?: string; scope?: string };
      }>,
      reply,
    ) => {
      const resolved = resolveTaskWorkspaceRequest(request.params.taskId, request.params.workspaceId);
      if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
      const path = request.query.path?.trim();
      if (!path) return reply.code(400).send({ error: 'ZEUS_GIT_PATH_REQUIRED', message: 'path is required' });
      try {
        if (request.query.scope === 'committed') {
          return await getTaskBranchFileDiff(resolved.workspace.repositoryPath || resolved.project.localPath, resolved.workspace.sourceBranch, resolved.workspace.branchName, path, resolved.workspace.sourceHeadSha);
        }
        if (!resolved.workspace.worktreePath)
          return reply.code(409).send({
            error: 'ZEUS_TASK_WORKTREE_UNAVAILABLE',
            message: 'Task worktree is not available.',
          });
        return await getTaskWorkspaceFileDiff(resolved.workspace.worktreePath, path);
      } catch (error) {
        return sendTaskGitApiError(reply, error);
      }
    },
  );

  server.get('/api/tasks/:taskId/integrations', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    return { taskId: task.id, items: taskIntegrations.listByTask(task.id), integrations: taskIntegrations.listByTask(task.id) };
  });

  server.get('/api/tasks/:taskId/integrations/:integrationId/conflict', async (request: FastifyRequest<{ Params: { taskId: string; integrationId: string }; Querystring: { path?: string } }>, reply) => {
    const resolved = resolveTaskIntegrationRequest(request.params.taskId, request.params.integrationId);
    if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
    if (!resolved.integration.integrationPath) return reply.code(409).send({ error: 'ZEUS_TASK_INTEGRATION_PATH_UNAVAILABLE', message: 'Integration worktree is unavailable.' });
    const path = request.query.path?.trim();
    if (!path) return reply.code(400).send({ error: 'ZEUS_GIT_PATH_REQUIRED', message: 'path is required' });
    try {
      return await readTaskIntegrationConflict(resolved.integration.integrationPath, path);
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
  });

  const workManagementProjectOperations = new WorkManagementProjectOperations({
    projects,
    sharedPaths: projectSharedPaths,
    templates: taskTemplates,
    saveProjectConfig: (projectId, config) => settings.setJson(projectConfigSettingsPrefix + projectId, config),
    stageProjectManagementStatus: (projectId) => {
      settings.setJson(appShellSettingsKey, {
        ...platformMutableState.appShellSettings,
        taskManagementStatusByProject: {
          ...platformMutableState.appShellSettings.taskManagementStatusByProject,
          [projectId]: cloneTaskManagementStatusConfig(platformMutableState.appShellSettings.taskManagementStatusTemplate),
        },
      });
    },
    activateProjectManagementStatus: (projectId) => {
      platformMutableState.appShellSettings = {
        ...platformMutableState.appShellSettings,
        taskManagementStatusByProject: {
          ...platformMutableState.appShellSettings.taskManagementStatusByProject,
          [projectId]: cloneTaskManagementStatusConfig(platformMutableState.appShellSettings.taskManagementStatusTemplate),
        },
      };
    },
    appendAuditLog,
    afterCommit: (callback) => db.afterCommit(callback),
    publishRealtimeEvent,
  });
  registerWorkManagementProjectCommandRoutes({
    server,
    application: workManagementCommands,
    create: (input, projectId, context) => workManagementProjectOperations.create(input, projectId, context),
    update: (projectId, input, context) => workManagementProjectOperations.update(projectId, input, context),
    updateWorkspace: (projectId, input, context) => workManagementProjectOperations.updateWorkspace(projectId, input, context),
    remove: (projectId, context) => workManagementProjectOperations.remove(projectId, context),
    archiveConfirmation: (projectId) => workManagementProjectOperations.archiveConfirmation(projectId),
    archive: (projectId) => workManagementProjectOperations.archive(projectId),
    restore: (projectId) => workManagementProjectOperations.restore(projectId),
    setDefaultTemplate: (projectId, input) => workManagementProjectOperations.setDefaultTemplate(projectId, input),
    mapDomainError: mapWorkManagementTaskDomainError,
  });

  const workManagementCoreOperations = new WorkManagementCoreOperations({
    projects,
    tasks,
    taskBoards,
    taskTemplates,
    conversations,
    resolveDefaultManagementStatus: (projectId) => resolveTaskManagementStatusConfigForProject(projectId).roles.defaultStatusId,
    readGraphNodeForProject: readCurrentGraphNodeByIdForProject,
    readGraphViewForProject: readCurrentGraphViewForProject,
    readGraphEdgesByNode: readCurrentGraphEdgesByNodeId,
    readGraphEdge: readCurrentGraphEdgeDetail,
    recordTaskEvent,
    appendAuditLog,
    afterCommit: (callback) => db.afterCommit(callback),
    publishRealtimeEvent: (type, payload) => {
      publishRealtimeEvent(type, payload);
    },
  });
  registerWorkManagementCoreCommandRoutes({
    server,
    application: workManagementCommands,
    updateTaskBoard: (projectId, input, context) => workManagementCoreOperations.updateTaskBoard(projectId, input, context),
    retryTask: (taskId, context) => workManagementCoreOperations.retryTask(taskId, context),
    createUserTask: (input, taskId, context) => workManagementCoreOperations.createUserTask(input, taskId, context),
    createTaskTemplate: (input, templateId, context) => workManagementCoreOperations.createTaskTemplate(input, templateId, context),
    createTaskFromTemplate: (templateId, input, taskId, context) => workManagementCoreOperations.createTaskFromTemplate(templateId, input, taskId, context),
    createTaskFromGraphConversation: (projectId, conversationId, input, taskId, context) => workManagementCoreOperations.createTaskFromGraphConversation(projectId, conversationId, input, taskId, context),
    createTaskFromGraphNode: (projectId, nodeId, input, taskId, context) => workManagementCoreOperations.createTaskFromGraphNode(projectId, nodeId, input, taskId, context),
    createTaskFromGraphView: (projectId, viewId, input, taskId, context) => workManagementCoreOperations.createTaskFromGraphView(projectId, viewId, input, taskId, context),
    linkTaskGraphNode: (taskId, input, context) => workManagementCoreOperations.linkTaskGraphNode(taskId, input, context),
  });

  const workManagementTaskEffects = new WorkManagementTaskEffectService({
    application: workManagementCommands,
    prepareTelegramNotification: async ({ taskId, status }) => {
      const task = tasks.getById(taskId);
      if (!task) throw nativeApiError('ZEUS_TASK_NOT_FOUND', 'Task not found');
      const taskStatus = status as TaskStatus;
      const notificationTitle = telegramTaskNotificationTitle(taskStatus);
      if (!notificationTitle) throw nativeApiError('ZEUS_TELEGRAM_TASK_STATUS_UNSUPPORTED', 'The task status does not produce a Telegram notification.');
      if (!platformMutableState.telegramNotificationSettings.enabled || (platformMutableState.telegramNotificationSettings.silentMode && !isCriticalTelegramTaskStatus(taskStatus))) {
        throw nativeApiError('ZEUS_TELEGRAM_NOTIFICATION_DISABLED', 'Telegram task notifications are disabled by the current local settings.');
      }
      const chatIds = [...platformMutableState.telegramNotificationSettings.chatIds];
      const token = await readTelegramToken();
      if (!token || chatIds.length === 0) throw nativeApiError('ZEUS_TELEGRAM_NOTIFICATION_UNAVAILABLE', 'Telegram task notification has no configured bot token or recipient.');
      const project = projects.getById(task.projectId);
      const text = [`Zeus ${notificationTitle}`, `任务：${task.title} (${task.id})`, `状态：${taskStatus}`, project ? `项目：${project.name}` : `项目：${task.projectId}`].join('\n');
      const sender = createTelegramBotMessageClient({ token });
      return {
        recipientCount: chatIds.length,
        send: async () => {
          // write marker 已在调用前耐久提交；任一收件人结果不明时整批保持 unknown，禁止盲目补发。
          for (const chatId of chatIds) await sender.sendMessage(chatId, text);
        },
      };
    },
    recordTaskEvent,
    redactSensitiveText,
  });
  if (!readOnlyValidation) workManagementTaskEffects.recover();

  type WorkManagementTaskCleanup = Awaited<ReturnType<typeof inspectTaskTerminalCleanup>>;
  type WorkManagementRuntimePreflight = Awaited<ReturnType<typeof prepareWorkManagementRuntimeStart>>;
  type WorkManagementRuntimeEffect = Awaited<ReturnType<typeof invokeWorkManagementRuntimeStart>> | { kind: 'stop'; stoppedSessionCount: number };
  type WorkManagementRuntimeResult = ReturnType<typeof finalizeWorkManagementRuntimeStart> | ZeusTaskRecord;
  const workManagementRuntimePreflights = new Map<string, WorkManagementRuntimePreflight>();
  const workManagementTaskOperations = new WorkManagementTaskOperations<WorkManagementTaskCleanup, ZeusConversationRecord, WorkManagementRuntimeEffect, WorkManagementRuntimeResult>({
    projects,
    tasks,
    taskBoards,
    resolveManagementStatusConfig: resolveTaskManagementStatusConfigForProject,
    isConfiguredManagementStatus: isConfiguredTaskManagementStatus,
    isManagementStatusTerminal: taskManagementStatusIsTerminal,
    taskBoardGroupValues,
    inspectTerminalCleanup: inspectTaskTerminalCleanup,
    cleanupRequiresConfirmation: (cleanup) => ({
      required: cleanup.requiresConfirmation,
      dirtyWorkspaceCount: cleanup.workspaces.filter((entry: { force: boolean }) => entry.force).length,
      activeConversationCount: cleanup.activeConversationCount,
      activeRuntimeSessionCount: cleanup.activeRuntimeSessionCount,
    }),
    closeTerminalResources: closeTaskResourcesForTerminalStatus,
    listTaskConversationHistory: (taskId, projectId) => conversationChoiceQueries.listTaskHistory(taskId, projectId),
    restoreTaskConversation: async (conversation) => {
      if (!conversation.archived) return conversation;
      if (conversation.transportKind === 'codex_native') {
        taskConversationReopenInProgressIds.add(conversation.id);
        try {
          await restoreNativeConversation(conversation);
        } finally {
          taskConversationReopenInProgressIds.delete(conversation.id);
        }
      } else {
        conversations.restore(conversation.id);
      }
      return conversations.getRecordById(conversation.id) ?? null;
    },
    validateRuntimeAction: (action, task, project) => {
      if (action !== 'run' && action !== 'continue') return;
      if (platformMutableState.runtimeSettings.defaultAdapterId === 'codex') {
        if (!codexNativeEnabled) throw nativeApiError('ZEUS_CODEX_NATIVE_DISABLED', 'Codex native conversation writes are disabled by ZEUS_CODEX_NATIVE_ENABLED.');
        if (action === 'continue') {
          throw nativeApiError('ZEUS_CONVERSATION_CHOICE_REQUIRED', 'Codex continue requires an explicitly selected native conversation. Use POST /api/tasks/:taskId/conversations with mode resume.');
        }
        if (conversationChoiceQueries.listTaskHistory(task.id, project.id).length > 0) {
          throw nativeApiError('ZEUS_CONVERSATION_CHOICE_REQUIRED', 'This task already has conversation history. Choose an exact conversation to resume, reference legacy history, or explicitly create a new conversation.');
        }
        return;
      }
      if (!isNonCodexAiCliAdapterId(platformMutableState.runtimeSettings.defaultAdapterId)) {
        throw nativeApiError('ZEUS_AI_RUNTIME_ADAPTER_NOT_FOUND', `AI CLI adapter not found: ${String(platformMutableState.runtimeSettings.defaultAdapterId)}`);
      }
    },
    invokeRuntimeAction: async (action, task, project, operationIdentity) => {
      const preflight = workManagementRuntimePreflights.get(operationIdentity);
      workManagementRuntimePreflights.delete(operationIdentity);
      if (!preflight) throw nativeApiError('ZEUS_WORK_MANAGEMENT_RUNTIME_PREFLIGHT_MISSING', 'Task Runtime preflight was not bound to this stable operation identity.');
      return invokeWorkManagementRuntimeStart(action, task, project, operationIdentity, preflight);
    },
    stopRuntimeSessions: async (taskId) => ({ kind: 'stop' as const, stoppedSessionCount: stopRunningTaskRuntimeSessions(taskId) }),
    finalizeStartedRuntimeAction: (action, task, effect, context) => {
      if (effect.kind === 'stop') throw new Error(`Task Runtime ${action} received a stop effect.`);
      return finalizeWorkManagementRuntimeStart(action, task, effect, context.commandId);
    },
    recordTaskEvent,
    appendAuditLog,
    afterCommit: (callback) => db.afterCommit(callback),
    publishRealtimeEvent,
    taskStatusEventTitle,
    shouldEnqueueTelegram: (status) =>
      Boolean(telegramTaskNotificationTitle(status)) &&
      platformMutableState.telegramNotificationSettings.enabled &&
      (!platformMutableState.telegramNotificationSettings.silentMode || isCriticalTelegramTaskStatus(status)) &&
      platformMutableState.telegramNotificationSettings.chatIds.length > 0,
    scheduleGraphCompletion: (task) => projectionDatabases.enqueueIndexWrite((projection) => writeTaskCompletionToGraphNode(projection, task)).then(() => undefined),
  });

  registerWorkManagementTaskCommandRoutes({
    server,
    application: workManagementCommands,
    prepareStatus: (taskId, input) => workManagementTaskOperations.prepareStatus(taskId, input),
    mutateStatus: (plan, context) => workManagementTaskOperations.mutateStatus(plan, context),
    bindStatusPostCommit: (_result, effect) => {
      if (effect) db.afterCommit(() => workManagementTaskEffects.schedule(effect));
    },
    prepareManagementStatus: (taskId, input) => workManagementTaskOperations.prepareManagementStatus(taskId, input),
    invokeManagementStatus: (plan) => workManagementTaskOperations.invokeManagementStatus(plan),
    mutateManagementStatus: (plan, effect, context) => workManagementTaskOperations.mutateManagementStatus(plan, effect, context),
    prepareTaskBoardMove: (projectId, input) => workManagementTaskOperations.prepareTaskBoardMove(projectId, input),
    invokeTaskBoardMove: (plan) => workManagementTaskOperations.invokeTaskBoardMove(plan),
    mutateTaskBoardMove: (plan, effect, context) => workManagementTaskOperations.mutateTaskBoardMove(plan, effect, context),
    prepareRuntimeAction: (action, taskId) => workManagementTaskOperations.prepareRuntimeAction(action, taskId),
    beforeRuntimeActionWrite: async (action, plan, operationIdentity) => {
      if (action !== 'run' && action !== 'continue') return;
      if (!workManagementRuntimePreflights.has(operationIdentity) && workManagementRuntimePreflights.size >= 256) {
        throw nativeApiError('ZEUS_WORK_MANAGEMENT_RUNTIME_PREFLIGHT_CAPACITY', 'Task Runtime preflight capacity is exhausted; retry after active starts settle.');
      }
      workManagementRuntimePreflights.set(
        operationIdentity,
        await prepareWorkManagementRuntimeStart(
          action,
          plan.project,
          tasks.getById(plan.taskId) ??
            (() => {
              throw nativeApiError('ZEUS_TASK_NOT_FOUND', 'Task not found');
            })(),
        ),
      );
    },
    invokeRuntimeAction: (action, plan, operationIdentity) => workManagementTaskOperations.invokeRuntimeAction(action, plan, operationIdentity),
    mutateRuntimeAction: (action, plan, effect, context) => workManagementTaskOperations.mutateRuntimeAction(action, plan, effect, context),
    mutateRuntimeActionFailure: (_action, _plan, _outcome, _error, context) => {
      workManagementRuntimePreflights.delete(context.operationIdentity);
    },
    runtimeSuccessStatusCode: (action, result) => (action === 'run' || action === 'continue' ? (isNativeApiRecord(result) && Reflect.get(result, 'queued') === true ? 202 : 201) : 200),
    archiveTask: (taskId, context) => workManagementTaskOperations.archiveTask(taskId, context),
    restoreTask: (taskId, context) => workManagementTaskOperations.restoreTask(taskId, context),
    updateTask: (taskId, input, context) => workManagementTaskOperations.updateTask(taskId, input, context),
    updateTaskTags: (taskId, input, context) => workManagementTaskOperations.updateTaskTags(taskId, input, context),
    updateTaskRelationships: (taskId, input, context) => workManagementTaskOperations.updateTaskRelationships(taskId, input, context),
    deleteTask: (taskId, input, context) => workManagementTaskOperations.deleteTask(taskId, input, context),
    mapDomainError: mapWorkManagementTaskDomainError,
  });

  registerConversationChoiceQueryRoutes({
    server,
    application: conversationChoiceQueries,
    synchronizeConversations: async (conversationIds) => {
      if (readOnlyValidation) return;
      await codexNativeCoordinator.synchronizeConversations({ conversationIds });
    },
  });

  server.get('/api/codex/account', async (_request, reply) => {
    try {
      return await codexAppServerManager.readAccount();
    } catch (error) {
      return sendNativeConversationApiError(reply, error);
    }
  });

  // 被动查看用量只能读取现有运行时或持久缓存，不得为了展示统计而启动外部 Codex。
  server.get('/api/codex/usage-summary', async () => codexUsageService.readSummary());

  server.get('/api/usage-overview', async () => usageOverviewService.read());

  server.get(
    '/api/codex/usage-analytics',
    async (
      request: FastifyRequest<{
        Querystring: { range?: string; projectId?: string; model?: string };
      }>,
      reply,
    ) => {
      const range = request.query.range ?? '30d';
      if (range !== '7d' && range !== '30d' && range !== '90d' && range !== 'all') {
        return reply.code(400).send({ error: 'ZEUS_CODEX_USAGE_RANGE_INVALID', message: 'range must be 7d, 30d, 90d, or all.' });
      }
      return codexUsageService.readAnalytics({
        range,
        projectId: request.query.projectId?.trim() || null,
        model: request.query.model?.trim() || null,
      });
    },
  );

  server.get('/api/tasks/:taskId/diff', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply): Promise<GitDiffSummary | unknown> => {
    const task = tasks.getById(request.params.taskId);
    if (!task) {
      return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    }
    const project = projects.getById(task.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Task project not found',
      });
    }
    const gitScope = projectGitQueries.resolveProjectScope(project);
    if ('limitation' in gitScope) {
      return reply.code(409).send({ error: 'ZEUS_PROJECT_GIT_SCOPE_UNSUPPORTED', message: gitScope.limitation });
    }
    const diff = await readGitDiff(gitScope.path);
    return diff;
  });

  const codeIntelligenceQueries = new CodeIntelligenceQueryApplication({
    projects,
    resolveGraphProjectName,
    readEdge: readCurrentGraphEdgeDetail,
    readNeighborhood: readCurrentGraphNeighborhood,
    search: searchCurrentGraphNodes,
    readView: readCurrentGraphView,
    readNode: readCurrentGraphNodeById,
    readEdgesByNodeId: readCurrentGraphEdgesByNodeId,
    attachViewPerformance: (view, startedAtMs) => attachGraphViewPerformance(view as unknown as GraphViewSnapshot, startedAtMs),
    formatProjectViewTitle: (view, projectName) => formatProjectScopedGraphViewTitle(view as unknown as GraphViewSnapshot, projectName),
  });
  registerCodeIntelligenceQueryRoutes({ server, application: codeIntelligenceQueries });

  server.get('/api/git/status', async () => readGitStatus(projectRoot));

  server.get('/api/git/diff', async (): Promise<GitDiffSummary> => readGitDiff(projectRoot));

  server.get('/api/git/patch', async (): Promise<GitPatchExport> => {
    const diff = await readGitDiff(projectRoot);
    return buildGitPatchExport(diff);
  });

  function readAgentCapabilityCatalog() {
    const checkedAt = now().toISOString();
    const configuredCommandPath = configuredCodexRuntimeCommandPath();
    let codexStatus = {
      available: false,
      version: null as string | null,
      checkedAt,
      reason: 'Zeus 当前已关闭 Codex 原生会话。',
    };
    if (codexNativeEnabled) {
      const transport = codexAppServerManager.getState();
      const capabilities = transport.type === 'ready' ? transport.capabilities : null;
      codexStatus = capabilities
        ? {
            available: capabilities.models.length > 0,
            version: capabilities.providerVersion,
            checkedAt,
            reason: capabilities.models.length > 0 ? `Codex App Server 已在既有运行世代中就绪，并返回 ${capabilities.models.length} 个模型。` : 'Codex App Server 已在既有运行世代中就绪，但没有返回可用模型。',
          }
        : {
            available: false,
            version: null,
            checkedAt,
            reason: configuredCommandPath ? `Codex 已配置，但当前 transport=${transport.type}；只读能力目录不会隐式启动 Provider。` : 'Codex 尚未配置可执行路径；只读能力目录不会探测或启动 Provider。',
          };
    }
    return createAgentCapabilityCatalog({
      enabled: codexNativeEnabled,
      available: codexStatus.available,
      checkedAt: codexStatus.checkedAt,
      adapterVersion: codexStatus.version,
      binaryVersion: codexStatus.version,
      reason: codexStatus.reason,
    });
  }

  server.get('/api/agents', async () => {
    const registry = readAgentCapabilityCatalog();
    return { items: registry.listPublic() };
  });

  server.get('/api/developer/agents', async (_request, reply) => {
    if (!platformMutableState.appShellSettings.developerModeEnabled) {
      return reply.code(404).send({
        error: 'ZEUS_DEVELOPER_AGENT_CATALOG_DISABLED',
        message: 'Developer agent catalog is disabled.',
      });
    }
    const registry = readAgentCapabilityCatalog();
    return { items: registry.listAll() };
  });

  server.get('/api/model-connections', async () => ({ items: await modelConnections.list() }));

  server.get('/api/zentao-instances', async () => ({ items: await zentaoCredentials.list() }));

  server.get('/api/models/catalog', async () => ({ items: await modelConnections.listSelectableModels() }));

  server.get('/api/projects/:projectId/model-selection', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    if (!projects.getById(request.params.projectId)) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    return modelConnections.getProjectSelection(request.params.projectId);
  });

  registerIntegrationCommandRoutes({
    server,
    application: integrationCommands,
    modelConnections,
    zentaoCredentials,
    projects,
    secretStore,
    refreshModelRuntime: () => piNativeCoordinator.refreshModelRuntime(),
    readSecuritySecrets: async () => ({
      telegramBotToken: getSecretPresenceLabel(await readTelegramToken()),
      externalApiKey: getSecretPresenceLabel(await secretStore.getSecret('external.apiKey')),
    }),
    appendAuditLog,
    redactSensitiveText,
  });

  server.put('/api/runtime/settings', async (request: FastifyRequest<{ Body: SettingsCommandRequest<UpdateRuntimeSettingsBody> }>, reply) => {
    try {
      const parsed = settingsCommands.parse<UpdateRuntimeSettingsBody>({
        value: request.body,
        commandType: settingsCommandTypes.runtimeSettingsPut,
        scopeKind: 'settings',
        expectedScopeId: () => 'runtime',
      });
      const nextSettings = normalizeImportedRuntimeSettings(parsed.input as RuntimeSettingsSnapshot);
      if (!nextSettings) return reply.code(400).send({ error: 'ZEUS_INVALID_RUNTIME_SETTINGS', message: 'Runtime settings are invalid, unsafe, or select the Generic shell without confirmation.' });
      const mutation = await settingsCommands.executeExternal({
        parsed,
        destinationId: 'runtime_log_retention',
        resourceId: runtimeSettingsKey,
        externalOperationId: `${parsed.operationIdentity}:retention`,
        invoke: async () => ({ settings: nextSettings, retention: await runRuntimeLogRetention(nextSettings.logRetentionDays) }),
        mutateAcceptedBusinessState: (result) => {
          settings.setJson(runtimeSettingsKey, result.settings);
          appendAuditLog({
            actorType: 'local_api',
            action: 'settings.runtime.updated',
            resourceType: 'settings',
            resourceId: runtimeSettingsKey,
            payload: { defaultAdapterId: result.settings.defaultAdapterId, logRetentionDays: result.settings.logRetentionDays, retention: result.retention },
          });
        },
      });
      platformMutableState.runtimeSettings = mutation.result.settings;
      return platformMutableState.runtimeSettings;
    } catch (error) {
      const mapped = settingsCommandHttpError(error, redactSensitiveText);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  server.get('/api/settings/app-shell', async (): Promise<AppShellSettingsSnapshot> => platformMutableState.appShellSettings);

  server.put('/api/settings/app-shell', async (request: FastifyRequest<{ Body: SettingsCommandRequest<UpdateAppShellSettingsBody> }>, reply): Promise<AppShellSettingsSnapshot | unknown> => {
    try {
      const parsed = settingsCommands.parse<UpdateAppShellSettingsBody>({
        value: request.body,
        commandType: settingsCommandTypes.appShellSettingsPut,
        scopeKind: 'settings',
        expectedScopeId: () => 'app-shell',
      });
      const previousSettings = platformMutableState.appShellSettings;
      const nextSettings = patchAppShellSettings(previousSettings, parsed.input, settingsIdentityCatalog);
      const migrationOperations: Array<{ projectId: string; fromStatus: TaskManagementStatus; toStatus: TaskManagementStatus }> = [];
      if (Object.prototype.hasOwnProperty.call(parsed.input, 'taskManagementStatusByProject')) {
        for (const project of projects.list()) {
          const previousConfig = previousSettings.taskManagementStatusByProject[project.id] ?? previousSettings.taskManagementStatusTemplate;
          const nextConfig = nextSettings.taskManagementStatusByProject[project.id] ?? nextSettings.taskManagementStatusTemplate;
          const nextStatusIds = new Set(nextConfig.statuses.map((status) => status.id));
          const removedStatusIds = previousConfig.statuses.map((status) => status.id).filter((statusId) => !nextStatusIds.has(statusId));
          for (const removedStatusId of removedStatusIds) {
            if (nextSettings.taskStatusFilterByProject[project.id] === removedStatusId) nextSettings.taskStatusFilterByProject[project.id] = 'unfinished';
            const replacementStatusId = parsed.input.taskManagementStatusReplacements?.[project.id]?.[removedStatusId];
            const taskCount = tasks.listByProject(project.id, { managementStatus: removedStatusId }).length + tasks.listArchivedByProject(project.id, { managementStatus: removedStatusId }).length;
            const carriesSystemBehavior = Object.values(previousConfig.roles).includes(removedStatusId);
            if ((taskCount > 0 || carriesSystemBehavior) && (!replacementStatusId || !nextStatusIds.has(replacementStatusId))) {
              return reply.code(409).send({
                error: 'ZEUS_TASK_MANAGEMENT_STATUS_REPLACEMENT_REQUIRED',
                message: 'A replacement status is required before deleting a status that is in use.',
                projectId: project.id,
                statusId: removedStatusId,
                taskCount,
              });
            }
            if (replacementStatusId && nextStatusIds.has(replacementStatusId)) {
              migrationOperations.push({ projectId: project.id, fromStatus: removedStatusId, toStatus: replacementStatusId });
              for (const roleName of Object.keys(nextConfig.roles) as Array<keyof typeof nextConfig.roles>) {
                if (previousConfig.roles[roleName] === removedStatusId) nextConfig.roles[roleName] = replacementStatusId;
              }
            }
          }
        }
      }
      const mutation = settingsCommands.executeCore({
        parsed,
        destinationId: 'app_shell_settings',
        resourceId: appShellSettingsKey,
        mutateBusinessState: () => {
          const migratedTasks = migrationOperations.flatMap((operation) => tasks.replaceManagementStatusForProject(operation.projectId, operation.fromStatus, operation.toStatus).map((task) => ({ task, operation })));
          settings.setJson(appShellSettingsKey, nextSettings);
          for (const { task, operation } of migratedTasks) {
            recordTaskEvent({ taskId: task.id, eventType: 'task.management_status.migrated', title: '任务管理状态配置迁移', payload: { from: operation.fromStatus, to: task.managementStatus } });
            publishRealtimeEvent('task.updated', { taskId: task.id, projectId: task.projectId, changedFields: ['managementStatus'], updatedAt: task.updatedAt });
          }
          appendAuditLog({
            actorType: 'local_api',
            action: 'settings.app_shell.updated',
            resourceType: 'settings',
            resourceId: appShellSettingsKey,
            payload: {
              appLanguage: nextSettings.appLanguage,
              appearance: nextSettings.appearance,
              webviewDebugEnabled: nextSettings.webviewDebugEnabled,
              developerModeEnabled: nextSettings.developerModeEnabled,
              multiWindowEnabled: nextSettings.multiWindowEnabled,
              backgroundModeEnabled: nextSettings.backgroundModeEnabled,
              desktopNotificationsEnabled: nextSettings.desktopNotificationsEnabled,
              openAtLoginEnabled: nextSettings.openAtLoginEnabled,
              autoUpdateChannel: nextSettings.autoUpdateChannel,
              defaultProjectId: nextSettings.defaultProjectId,
              pinnedProjectIds: nextSettings.pinnedProjectIds,
              collapsedProjectIds: nextSettings.collapsedProjectIds,
              sidebarConversationOrganization: nextSettings.sidebarConversationOrganization,
              sidebarConversationCollapsedStatusIdsByProject: nextSettings.sidebarConversationCollapsedStatusIdsByProject,
              defaultModel: nextSettings.defaultModel,
              defaultTaskTemplateId: nextSettings.defaultTaskTemplateId,
              taskTableColumns: nextSettings.taskTableColumns,
              taskTableColumnsByProject: nextSettings.taskTableColumnsByProject,
              taskTableEnumSortOrders: nextSettings.taskTableEnumSortOrders,
              taskManagementStatusTemplate: nextSettings.taskManagementStatusTemplate,
              taskManagementStatusProjectCount: Object.keys(nextSettings.taskManagementStatusByProject).length,
              migratedTaskManagementStatusCount: migratedTasks.length,
              taskStatusFilterByProject: nextSettings.taskStatusFilterByProject,
              taskViewModeByProject: nextSettings.taskViewModeByProject,
              taskPageViewByProject: nextSettings.taskPageViewByProject,
              taskExpandedIdsByProject: nextSettings.taskExpandedIdsByProject,
              codeWorkspaceByProject: nextSettings.codeWorkspaceByProject,
            },
          });
          return nextSettings;
        },
      });
      platformMutableState.appShellSettings = mutation.result;
      return platformMutableState.appShellSettings;
    } catch (error) {
      const mapped = settingsCommandHttpError(error, redactSensitiveText);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  const clearCodeGraphCache = async (request: FastifyRequest<{ Body: SettingsCommandRequest<Record<string, never>> }>, reply: FastifyReply): Promise<ClearCacheResult | unknown> => {
    try {
      const parsed = settingsCommands.parse<Record<string, never>>({
        value: request.body,
        commandType: settingsCommandTypes.projectionCacheClear,
        scopeKind: 'settings',
        expectedScopeId: () => 'projection-cache',
      });
      if (Object.keys(parsed.input).length !== 0) return reply.code(400).send({ error: 'ZEUS_SETTINGS_COMMAND_INVALID', message: 'Projection cache clear input must be empty.' });
      const clearedAt = now().toISOString();
      const mutation = await settingsCommands.executeExternal({
        parsed,
        destinationId: 'projection_database_cache',
        resourceId: 'code-graph-cache',
        externalOperationId: `${parsed.operationIdentity}:projection-clear`,
        invoke: async () => {
          await projectionDatabases.enqueueIndexWrite((projectionDb) => clearAllPersistedGraphCaches(projectionDb));
          return { result: { cleared: true, clearedCaches: ['code-index', 'graph-view', 'layout'] as const, clearedAt }, settings: { ...platformMutableState.appShellSettings, lastCacheClearAt: clearedAt } };
        },
        mutateAcceptedBusinessState: (result) => {
          settings.setJson(appShellSettingsKey, result.settings);
          appendAuditLog({
            actorType: 'local_api',
            action: 'settings.code_graph_cache.cleared',
            resourceType: 'code_graph_cache',
            payload: { clearedCaches: result.result.clearedCaches, clearedAt: result.result.clearedAt },
          });
        },
      });
      platformMutableState.memoryGraphCache = null;
      platformMutableState.appShellSettings = mutation.result.settings;
      return mutation.result.result;
    } catch (error) {
      const mapped = settingsCommandHttpError(error, redactSensitiveText);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  };
  server.post('/api/settings/code-graph-cache/clear', clearCodeGraphCache);
  // 保留旧端点供升级期间仍连接旧 Renderer 的窗口使用；产品文案不再把图谱投影称为全部缓存。
  server.post('/api/settings/cache/clear', clearCodeGraphCache);

  server.get('/api/settings/export', async (): Promise<LocalSettingsExportSnapshot> => {
    const exportedAt = new Date().toISOString();
    return {
      app: 'Zeus',
      schemaVersion: 1,
      exportedAt,
      redaction: { secretsRedacted: true },
      settings: {
        appShell: platformMutableState.appShellSettings,
        runtime: platformMutableState.runtimeSettings,
        codeMap: platformMutableState.codeMapSettings,
        telegramNotification: platformMutableState.telegramNotificationSettings,
        telegramSecurity: platformMutableState.telegramSecuritySettings,
      },
    };
  });

  server.post('/api/settings/import', async (request: FastifyRequest<{ Body: SettingsCommandRequest<ImportLocalSettingsBody> }>, reply): Promise<ImportLocalSettingsResult | unknown> => {
    try {
      const parsed = settingsCommands.parse<ImportLocalSettingsBody>({
        value: request.body,
        commandType: settingsCommandTypes.settingsImport,
        scopeKind: 'settings',
        expectedScopeId: () => 'local-settings-import',
      });
      if (parsed.input.schemaVersion !== 1 || !parsed.input.settings) return reply.code(400).send({ error: 'ZEUS_INVALID_SETTINGS_IMPORT', message: 'schemaVersion 1 and settings are required' });

      // 全部字段先完成 parse/normalize/关联约束计划，之后才允许写 Artifact、SQLite 或文件。
      const plannedAppShell = parsed.input.settings.appShell ? patchAppShellSettings(platformMutableState.appShellSettings, parsed.input.settings.appShell, settingsIdentityCatalog) : null;
      const plannedRuntime = parsed.input.settings.runtime ? normalizeImportedRuntimeSettings(parsed.input.settings.runtime) : null;
      const plannedCodeMap = parsed.input.settings.codeMap ? normalizeCodeMapSettings(parsed.input.settings.codeMap) : null;
      const plannedTelegramNotification = parsed.input.settings.telegramNotification ? normalizeImportedTelegramNotificationSettings(parsed.input.settings.telegramNotification) : null;
      const plannedTelegramSecurity = parsed.input.settings.telegramSecurity ? normalizeImportedTelegramSecuritySettings(parsed.input.settings.telegramSecurity) : null;
      if (parsed.input.settings.runtime && !plannedRuntime) return reply.code(400).send({ error: 'ZEUS_INVALID_SETTINGS_IMPORT', message: 'runtime settings are invalid or unsafe' });
      if (parsed.input.settings.codeMap && !plannedCodeMap) return reply.code(400).send({ error: 'ZEUS_INVALID_SETTINGS_IMPORT', message: 'codeMap settings are invalid' });
      if (parsed.input.settings.telegramNotification && !plannedTelegramNotification) return reply.code(400).send({ error: 'ZEUS_INVALID_SETTINGS_IMPORT', message: 'telegram notification settings are invalid' });
      if (parsed.input.settings.telegramSecurity && !plannedTelegramSecurity) return reply.code(400).send({ error: 'ZEUS_INVALID_SETTINGS_IMPORT', message: 'telegram security settings are invalid' });
      if (plannedAppShell && Object.prototype.hasOwnProperty.call(parsed.input.settings.appShell, 'taskManagementStatusByProject')) {
        for (const project of projects.list()) {
          const previousConfig = platformMutableState.appShellSettings.taskManagementStatusByProject[project.id] ?? platformMutableState.appShellSettings.taskManagementStatusTemplate;
          const nextConfig = plannedAppShell.taskManagementStatusByProject[project.id] ?? plannedAppShell.taskManagementStatusTemplate;
          const nextStatusIds = new Set(nextConfig.statuses.map((status) => status.id));
          for (const removedStatusId of previousConfig.statuses.map((status) => status.id).filter((statusId) => !nextStatusIds.has(statusId))) {
            const taskCount = tasks.listByProject(project.id, { managementStatus: removedStatusId }).length + tasks.listArchivedByProject(project.id, { managementStatus: removedStatusId }).length;
            if (taskCount > 0 || Object.values(previousConfig.roles).includes(removedStatusId)) {
              return reply
                .code(409)
                .send({ error: 'ZEUS_SETTINGS_IMPORT_STATUS_IN_USE', message: 'Settings import cannot remove an in-use task management status without an explicit replacement.', projectId: project.id, statusId: removedStatusId, taskCount });
            }
          }
        }
      }
      const importedSettings = [plannedAppShell && 'app-shell', plannedRuntime && 'runtime', plannedCodeMap && 'code-map', plannedTelegramNotification && 'telegram-notification', plannedTelegramSecurity && 'telegram-security'].filter(
        (value): value is string => typeof value === 'string',
      );
      const importedAt = now().toISOString();
      const publicResult: ImportLocalSettingsResult = { imported: true, importedSettings, importedAt };
      const mutation = await settingsCommands.executeExternal({
        parsed,
        destinationId: 'settings_import_artifact',
        resourceId: 'local-settings-import',
        externalOperationId: `${parsed.operationIdentity}:artifact-and-retention`,
        invoke: async () => ({
          publicResult,
          sourceArtifact: await settingsCommands.stageImportArtifact({ parsed: parsed as ParsedSettingsCommand<object>, value: parsed.input, kind: 'settings' }),
          retention: plannedRuntime ? await runRuntimeLogRetention(plannedRuntime.logRetentionDays) : null,
          planned: { appShell: plannedAppShell, runtime: plannedRuntime, codeMap: plannedCodeMap, telegramNotification: plannedTelegramNotification, telegramSecurity: plannedTelegramSecurity },
        }),
        mutateAcceptedBusinessState: (result) => {
          if (result.planned.appShell) settings.setJson(appShellSettingsKey, result.planned.appShell);
          if (result.planned.runtime) settings.setJson(runtimeSettingsKey, result.planned.runtime);
          if (result.planned.codeMap) settings.setJson(codeMapSettingsKey, result.planned.codeMap);
          if (result.planned.telegramNotification) settings.setJson(telegramNotificationSettingsKey, result.planned.telegramNotification);
          if (result.planned.telegramSecurity) settings.setJson(telegramSecuritySettingsKey, result.planned.telegramSecurity);
          appendAuditLog({
            actorType: 'local_api',
            action: 'settings.data_import.completed',
            resourceType: 'settings_import',
            payload: {
              schemaVersion: 1,
              importedSettings: result.publicResult.importedSettings,
              importedAt: result.publicResult.importedAt,
              secretsAccepted: false,
              sourceArtifactSha256: result.sourceArtifact.sha256,
              retention: result.retention,
            },
          });
        },
      });
      if (mutation.result.planned.appShell) platformMutableState.appShellSettings = mutation.result.planned.appShell;
      if (mutation.result.planned.runtime) platformMutableState.runtimeSettings = mutation.result.planned.runtime;
      if (mutation.result.planned.codeMap) platformMutableState.codeMapSettings = mutation.result.planned.codeMap;
      if (mutation.result.planned.telegramNotification) platformMutableState.telegramNotificationSettings = mutation.result.planned.telegramNotification;
      if (mutation.result.planned.telegramSecurity) platformMutableState.telegramSecuritySettings = mutation.result.planned.telegramSecurity;
      return mutation.result.publicResult;
    } catch (error) {
      const mapped = settingsCommandHttpError(error, redactSensitiveText);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  server.get('/api/data/export', async (): Promise<LocalDataExportSnapshot> => {
    const exportedAt = new Date().toISOString();
    return exportLocalBusinessData(db, exportedAt);
  });

  server.post('/api/data/import', { bodyLimit: 34 * 1024 * 1024 }, async (request: FastifyRequest<{ Body: SettingsCommandRequest<LocalDataExportSnapshot> }>, reply): Promise<ImportLocalDataResult | unknown> => {
    try {
      const parsed = settingsCommands.parse<LocalDataExportSnapshot>({
        value: request.body,
        commandType: settingsCommandTypes.dataImport,
        scopeKind: 'settings',
        expectedScopeId: () => 'local-business-data-import',
      });
      if (parsed.input.app !== 'Zeus' || ![1, 2].includes(parsed.input.schemaVersion) || parsed.input.redaction?.secretsRedacted !== true || !parsed.input.data) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_DATA_IMPORT', message: 'Zeus data import requires a redacted schemaVersion 1 or 2 snapshot' });
      }
      const validationError = validateLocalBusinessDataImport(db, parsed.input);
      if (validationError) return reply.code(400).send({ error: 'ZEUS_INVALID_DATA_IMPORT', message: validationError });
      const invalidProjectPaths = findInvalidPortableProjectPaths(parsed.input);
      if (invalidProjectPaths.length > 0) {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_DATA_IMPORT_PROJECT_PATH',
          message: `Imported projects must reference existing local directories: ${invalidProjectPaths.slice(0, 3).join(', ')}`,
          invalidProjectPaths: invalidProjectPaths.slice(0, 20),
        });
      }
      const importedCounts = plannedLocalBusinessDataImportCounts(parsed.input);
      const importedAt = now().toISOString();
      const publicResult: ImportLocalDataResult = { imported: true, importedCounts, importedAt };
      const mutation = await settingsCommands.executeExternal({
        parsed,
        destinationId: 'business_data_import_artifact',
        resourceId: 'local-business-data-import',
        externalOperationId: `${parsed.operationIdentity}:artifact-and-core-import`,
        invoke: async () => ({
          publicResult,
          sourceArtifact: await settingsCommands.stageImportArtifact({ parsed: parsed as ParsedSettingsCommand<object>, value: parsed.input, kind: 'business_data' }),
        }),
        mutateAcceptedBusinessState: (result) => {
          const appliedCounts = importLocalBusinessData(db, parsed.input);
          if (JSON.stringify(appliedCounts) !== JSON.stringify(result.publicResult.importedCounts)) throw new Error('Business data import plan changed after validation.');
          appendAuditLog({
            actorType: 'local_api',
            action: 'data.import.completed',
            resourceType: 'data_import',
            payload: { schemaVersion: parsed.input.schemaVersion, importedCounts: appliedCounts, importedAt: result.publicResult.importedAt, secretsAccepted: false, sourceArtifactSha256: result.sourceArtifact.sha256 },
          });
        },
      });
      return mutation.result.publicResult;
    } catch (error) {
      const mapped = settingsCommandHttpError(error, redactSensitiveText);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  server.get('/api/code-map/settings', async (): Promise<CodeMapSettingsSnapshot> => platformMutableState.codeMapSettings);

  server.put('/api/code-map/settings', async (request: FastifyRequest<{ Body: SettingsCommandRequest<UpdateCodeMapSettingsBody> }>, reply) => {
    try {
      const parsed = settingsCommands.parse<UpdateCodeMapSettingsBody>({
        value: request.body,
        commandType: settingsCommandTypes.codeMapSettingsPut,
        scopeKind: 'settings',
        expectedScopeId: () => 'code-map',
      });
      const nextSettings = normalizeCodeMapSettings(parsed.input);
      if (!nextSettings) return reply.code(400).send({ error: 'ZEUS_INVALID_CODE_MAP_SETTINGS', message: 'code map settings must use supported ranges and safe ignore directory names' });
      const mutation = settingsCommands.executeCore({
        parsed,
        destinationId: 'code_map_settings',
        resourceId: codeMapSettingsKey,
        mutateBusinessState: () => {
          settings.setJson(codeMapSettingsKey, nextSettings);
          appendAuditLog({
            actorType: 'local_api',
            action: 'settings.code_map.updated',
            resourceType: 'settings',
            resourceId: codeMapSettingsKey,
            payload: {
              defaultScanScope: nextSettings.defaultScanScope,
              ignoreDirectoryCount: nextSettings.defaultIgnoreDirectories.length,
              maxCallChainDepth: nextSettings.maxCallChainDepth,
              layoutAlgorithm: nextSettings.layoutAlgorithm,
              moduleFlowManualNotesLength: nextSettings.moduleFlowManualNotes.length,
            },
          });
          return nextSettings;
        },
      });
      platformMutableState.codeMapSettings = mutation.result;
      return platformMutableState.codeMapSettings;
    } catch (error) {
      const mapped = settingsCommandHttpError(error, redactSensitiveText);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  registerRuntimeSessionCommandRoutes({
    server,
    application: runtimeSessionCommands,
    ephemeralCapabilities: runtimeEphemeralCapabilities,
    aiRuntimeManager,
    runtimeSessions,
    projects,
    tasks,
    resolveRegisteredRuntimeAdapter,
    resolveExistingRuntimeSessionAdapter,
    readProjectAllowsShell: (projectId) => readProjectConfig(projectId).security.allowShell,
    buildRuntimeProcessEnv,
    resolveTaskDefaultManagementStatus: (projectId) => resolveTaskManagementStatusConfigForProject(projectId).roles.defaultStatusId,
    stopPersistedOrphanRuntimeSession,
    toAiRuntimeSession,
    toAiRuntimeLogEntry,
    parseRuntimeArgs,
    runtimeSessionIsConfirmedTerminal,
    redactSensitiveText,
    appendAuditLog,
    recordTaskEvent,
    publishRealtimeEvent,
    publishRuntimeSessionEvent,
    save: () => db.save(),
    now,
  });

  registerGitCommandRoutes({
    server,
    application: gitCommands,
    projectRoot,
    projects,
    tasks,
    redactSensitiveText,
    appendAuditLog,
    publishRealtimeEvent,
    save: () => db.save(),
    now,
  });

  registerWorkspaceGitCommandRoutes({
    server,
    application: workspaceGitCommands,
    operations: {
      prepare: prepareWorkspaceGitCommand,
      execute: executeWorkspaceGitCommand,
      isExplicitRejection: isWorkspaceGitExplicitRejection,
    },
    sendError: sendWorkspaceGitCommandError,
  });

  server.get(
    '/api/settings/runtime-status',
    async (): Promise<RuntimeStatusSnapshot> => ({
      aiCli: toPassiveRuntimeStatus(platformMutableState.runtimeSettings),
      telegram: getTelegramConfigurationState(await readTelegramToken(), platformMutableState.telegramSecuritySettings.allowedUserIds),
      terminal: runtimeTerminalStatus,
    }),
  );

  async function ensureCodexRemoteControlReady(remoteControl = platformMutableState.codexRemoteControlEnabled): Promise<void> {
    await codexAppServerManager.ensureReady({
      commandPath: remoteControl ? requireCodexRemoteControlCommandPath() : currentCodexRuntimeCommandPath(),
      ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}),
      ...(remoteControl ? { remoteControl: true } : {}),
    });
  }

  async function buildCodexRemoteControlSnapshot(status?: CodexRemoteControlStatus): Promise<CodexRemoteControlSnapshot> {
    await ensureCodexRemoteControlReady();
    const currentStatus = status ?? (await codexAppServerManager.readRemoteControlStatus());
    const clients = currentStatus.environmentId ? (await codexAppServerManager.listRemoteControlClients({ environmentId: currentStatus.environmentId, limit: 100, order: 'desc' })).data : [];
    return { enabled: platformMutableState.codexRemoteControlEnabled, status: currentStatus, clients, managedStandalone: readCodexRemoteControlStandalone() };
  }

  server.get(
    '/api/security/secrets',
    async (): Promise<SecuritySecretsSnapshot> => ({
      telegramBotToken: getSecretPresenceLabel(await readTelegramToken()),
      externalApiKey: getSecretPresenceLabel(await secretStore.getSecret('external.apiKey')),
    }),
  );

  server.get('/api/security/audit-logs', async (): Promise<SecurityAuditLogEntry[]> => auditLogs.listRecent().map(toSecurityAuditLogEntry));

  server.get('/api/release/status', async (): Promise<ReleaseStatusSnapshot> => buildReleaseStatusSnapshot());
  registerReleaseUpdateApi({
    server,
    buildUpdateStatus: buildReleaseUpdateStatus,
    readExecutionHostStatus: executionHostControl.readStatus,
  });

  const sendTelegramCommandRouteError = (reply: FastifyReply, error: unknown): unknown => {
    const commandError = telegramCommandHttpError(error);
    if (commandError) return reply.code(commandError.statusCode).send(commandError.payload);
    const statusCode = typeof error === 'object' && error !== null && typeof (error as { statusCode?: unknown }).statusCode === 'number' ? Number((error as { statusCode: number }).statusCode) : 500;
    const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code).slice(0, 128) : 'ZEUS_TELEGRAM_COMMAND_FAILED';
    const rawMessage = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: code, message: redactSensitiveText(rawMessage).text.slice(0, 2_048) });
  };

  server.post('/api/security/reset', async (request: FastifyRequest<{ Body: TelegramCommandRequest<Record<string, never>> }>, reply): Promise<SecurityResetResult | unknown> => {
    try {
      const parsed = telegramCommands.parse<Record<string, never>>({ value: request.body, commandType: telegramCommandTypes.securityReset, scopeId: 'security.reset' });
      assertTelegramCommandInputKeys(parsed.input, []);
      const projectSecretKeys = projects
        .list()
        .map((project) => getProjectDatabasePasswordSecretKey(project.id)?.key)
        .filter((key): key is string => Boolean(key))
        .sort();
      const nextNotificationSettings: TelegramNotificationSettingsSnapshot = { enabled: false, chatIds: [], silentMode: true };
      const nextSecuritySettings: TelegramSecuritySettingsSnapshot = { allowedUserIds: [] };
      const execution = await telegramCommands.executeExternal({
        parsed,
        destinationId: 'telegram-security-reset',
        resourceId: 'security.reset',
        children: [
          telegramChildOperation(parsed.operationIdentity, 'polling_timer_stop'),
          telegramChildOperation(parsed.operationIdentity, 'polling_service_stop'),
          telegramChildOperation(parsed.operationIdentity, 'telegram_token_delete'),
          telegramChildOperation(parsed.operationIdentity, 'external_api_key_delete'),
          ...projectSecretKeys.map((_key, index) => telegramChildOperation(parsed.operationIdentity, `project_database_password_delete_${index}`)),
        ],
        invoke: async () => {
          if (platformMutableState.telegramPollingTimer) clearInterval(platformMutableState.telegramPollingTimer);
          platformMutableState.telegramPollingTimer = undefined;
          if (platformMutableState.telegramPollingService) await platformMutableState.telegramPollingService.stop();
          platformMutableState.telegramPollingService = undefined;
          platformMutableState.telegramMessageSender = undefined;
          await secretStore.deleteSecret('telegram.botToken');
          await secretStore.deleteSecret('external.apiKey');
          for (const secretKey of projectSecretKeys) await secretStore.deleteSecret(secretKey);
          return {
            secrets: { telegramBotToken: getSecretPresenceLabel(undefined), externalApiKey: getSecretPresenceLabel(undefined) },
            telegramNotificationSettings: nextNotificationSettings,
            telegramSecuritySettings: nextSecuritySettings,
          };
        },
        mutateAcceptedBusinessState: () => {
          platformMutableState.telegramNotificationSettings = nextNotificationSettings;
          platformMutableState.telegramSecuritySettings = nextSecuritySettings;
          settings.setJson(telegramNotificationSettingsKey, nextNotificationSettings);
          settings.setJson(telegramSecuritySettingsKey, nextSecuritySettings);
          appendAuditLog({
            actorType: 'local_api',
            action: 'security.reset.completed',
            resourceType: 'security',
            payload: {
              clearedSecretClasses: ['telegram.botToken', 'external.apiKey', 'project.database.password'],
              projectDatabaseSecretCount: projectSecretKeys.length,
              telegramNotificationsDisabled: true,
              telegramAllowedUserIdsCleared: true,
            },
          });
        },
      });
      return execution.result;
    } catch (error) {
      return sendTelegramCommandRouteError(reply, error);
    }
  });

  server.get('/api/telegram/notification-settings', async (): Promise<TelegramNotificationSettingsSnapshot> => platformMutableState.telegramNotificationSettings);

  server.put('/api/telegram/notification-settings', async (request: FastifyRequest<{ Body: TelegramCommandRequest<UpdateTelegramNotificationSettingsBody> }>, reply) => {
    try {
      const parsed = telegramCommands.parse<UpdateTelegramNotificationSettingsBody>({ value: request.body, commandType: telegramCommandTypes.notificationSettingsUpdate, scopeId: 'telegram.notification-settings' });
      assertTelegramCommandInputKeys(parsed.input, ['enabled', 'chatIds', 'silentMode']);
      const next = parseTelegramNotificationSettingsInput(parsed.input, platformMutableState.telegramNotificationSettings);
      const execution = telegramCommands.executeCore({
        parsed,
        destinationId: 'telegram-settings-core',
        resourceId: 'telegram.notification-settings',
        mutateBusinessState: () => {
          platformMutableState.telegramNotificationSettings = next;
          settings.setJson(telegramNotificationSettingsKey, next);
          appendAuditLog({
            actorType: 'local_api',
            action: 'telegram.notification_settings.updated',
            resourceType: 'telegram',
            resourceId: 'notification-settings',
            payload: { enabled: next.enabled, silentMode: next.silentMode, chatIdCount: next.chatIds.length },
          });
          return next;
        },
      });
      return execution.result;
    } catch (error) {
      return sendTelegramCommandRouteError(reply, error);
    }
  });

  server.post('/api/telegram/test', async (request: FastifyRequest<{ Body: TelegramCommandRequest<Record<string, never>> }>, reply): Promise<TelegramTestConnectionResult | unknown> => {
    try {
      const parsed = telegramCommands.parse<Record<string, never>>({ value: request.body, commandType: telegramCommandTypes.connectionTest, scopeId: 'telegram.connection-test' });
      assertTelegramCommandInputKeys(parsed.input, []);
      const chatIds = [...platformMutableState.telegramNotificationSettings.chatIds];
      let sender: TelegramMessageSender | undefined;
      const sentAt = now().toISOString();
      const text = ['Zeus Telegram 测试连接', `时间：${sentAt}`, '这是一条由用户主动触发的真实连接测试，不包含 Token、命令明文或终端输出。'].join('\n');
      const execution = await telegramCommands.executeExternal({
        parsed,
        destinationId: 'telegram-send-message',
        resourceId: 'telegram.connection-test',
        children: [telegramChildOperation(parsed.operationIdentity, 'telegram_configuration_check'), ...chatIds.map((_chatId, index) => telegramChildOperation(parsed.operationIdentity, `send_message_${index}`))],
        beforeWrite: async () => {
          const token = await readTelegramToken();
          if (!token || chatIds.length === 0) throw telegramCommandRouteError('ZEUS_TELEGRAM_UNCONFIGURED', 'Telegram Bot Token 或通知 Chat ID 未配置。', 400);
          sender = createTelegramBotMessageClient({ token });
        },
        invoke: async () => {
          for (const chatId of chatIds) await sender!.sendMessage(chatId, text);
          return { ok: true, chatIds, attempts: 1, sentAt };
        },
        mutateAcceptedBusinessState: () => {
          appendAuditLog({
            actorType: 'local_api',
            action: 'telegram.test.sent',
            resourceType: 'telegram',
            resourceId: 'notification-settings',
            payload: { chatIdCount: chatIds.length, attempts: 1, sentAt },
          });
        },
        mutateFailureBusinessState: (outcome, error) => {
          appendAuditLog({
            actorType: 'local_api',
            action: 'telegram.test.failed',
            resourceType: 'telegram',
            resourceId: 'notification-settings',
            payload: { chatIdCount: chatIds.length, outcome, error: redactSensitiveText(error instanceof Error ? error.message : String(error)).text.slice(0, 2_048), sentAt },
          });
        },
        isExplicitRejection: isExplicitTelegramApiRejection,
      });
      return execution.result;
    } catch (error) {
      return sendTelegramCommandRouteError(reply, error);
    }
  });

  server.get('/api/telegram/security-settings', async (): Promise<TelegramSecuritySettingsSnapshot> => platformMutableState.telegramSecuritySettings);

  server.put('/api/telegram/security-settings', async (request: FastifyRequest<{ Body: TelegramCommandRequest<UpdateTelegramSecuritySettingsBody> }>, reply) => {
    try {
      const parsed = telegramCommands.parse<UpdateTelegramSecuritySettingsBody>({ value: request.body, commandType: telegramCommandTypes.securitySettingsUpdate, scopeId: 'telegram.security-settings' });
      assertTelegramCommandInputKeys(parsed.input, ['allowedUserIds']);
      const next = parseTelegramSecuritySettingsInput(parsed.input, platformMutableState.telegramSecuritySettings);
      const execution = await telegramCommands.executeExternal({
        parsed,
        destinationId: 'telegram-security-settings',
        resourceId: 'telegram.security-settings',
        children: [telegramChildOperation(parsed.operationIdentity, 'polling_timer_stop'), telegramChildOperation(parsed.operationIdentity, 'polling_service_stop')],
        invoke: async () => {
          if (platformMutableState.telegramPollingTimer) clearInterval(platformMutableState.telegramPollingTimer);
          platformMutableState.telegramPollingTimer = undefined;
          if (platformMutableState.telegramPollingService) await platformMutableState.telegramPollingService.stop();
          platformMutableState.telegramPollingService = undefined;
          return next;
        },
        mutateAcceptedBusinessState: () => {
          platformMutableState.telegramSecuritySettings = next;
          settings.setJson(telegramSecuritySettingsKey, next);
          appendAuditLog({
            actorType: 'local_api',
            action: 'telegram.security_settings.updated',
            resourceType: 'telegram',
            resourceId: 'security-settings',
            payload: { allowedUserIdsCount: next.allowedUserIds.length },
          });
        },
      });
      return execution.result;
    } catch (error) {
      return sendTelegramCommandRouteError(reply, error);
    }
  });

  server.post('/api/telegram/dispatch-preview', async (request: FastifyRequest<{ Body: TelegramCommandRequest<TelegramDispatchPreviewBody> }>, reply) => {
    try {
      const parsed = telegramCommands.parse<TelegramDispatchPreviewBody>({ value: request.body, commandType: telegramCommandTypes.dispatchPreview, scopeId: 'telegram.dispatch-preview' });
      const update = parseTelegramDispatchPreviewInput(parsed.input);
      const execution = await telegramCommands.executeExternal({
        parsed,
        destinationId: 'telegram-dispatch-preview',
        resourceId: 'telegram.dispatch-preview',
        children: [telegramChildOperation(parsed.operationIdentity, 'keychain_token_presence_read'), telegramChildOperation(parsed.operationIdentity, 'telegram_update_dispatch')],
        beforeWrite: async () => {
          if (!(await readTelegramToken())) throw telegramCommandRouteError('ZEUS_TELEGRAM_UNCONFIGURED', 'Telegram Bot Token 未配置。', 400);
        },
        invoke: async () => dispatchTelegramUpdate(update, { allowedUserIds: platformMutableState.telegramSecuritySettings.allowedUserIds }),
      });
      return execution.result;
    } catch (error) {
      return sendTelegramCommandRouteError(reply, error);
    }
  });

  server.get('/api/telegram/status', async (): Promise<TelegramStatusSnapshot> => {
    const state = getTelegramConfigurationState(await readTelegramToken(), platformMutableState.telegramSecuritySettings.allowedUserIds);
    return {
      configured: state.enabled,
      reason: state.reason,
      polling: getTelegramPollingService()?.status() ?? {
        running: false,
        offset: 0,
        lastError: null,
        handledUpdates: 0,
      },
      notificationSettings: platformMutableState.telegramNotificationSettings,
      securitySettings: platformMutableState.telegramSecuritySettings,
    };
  });

  server.patch('/api/telegram/settings', async (request: FastifyRequest<{ Body: TelegramCommandRequest<UpdateTelegramSettingsBody> }>, reply): Promise<TelegramSettingsSnapshot | unknown> => {
    try {
      const parsed = telegramCommands.parse<UpdateTelegramSettingsBody>({ value: request.body, commandType: telegramCommandTypes.settingsUpdate, scopeId: 'telegram.settings' });
      assertTelegramCommandInputKeys(parsed.input, ['enabled', 'chatIds', 'silentMode', 'allowedUserIds']);
      const nextNotificationSettings = parseTelegramNotificationSettingsInput(parsed.input, platformMutableState.telegramNotificationSettings);
      const nextSecuritySettings = parseTelegramSecuritySettingsInput(parsed.input, platformMutableState.telegramSecuritySettings);
      const execution = await telegramCommands.executeExternal({
        parsed,
        destinationId: 'telegram-settings-composite',
        resourceId: 'telegram.settings',
        children: [telegramChildOperation(parsed.operationIdentity, 'polling_timer_stop'), telegramChildOperation(parsed.operationIdentity, 'polling_service_stop')],
        invoke: async () => {
          if (platformMutableState.telegramPollingTimer) clearInterval(platformMutableState.telegramPollingTimer);
          platformMutableState.telegramPollingTimer = undefined;
          if (platformMutableState.telegramPollingService) await platformMutableState.telegramPollingService.stop();
          platformMutableState.telegramPollingService = undefined;
          return { notificationSettings: nextNotificationSettings, securitySettings: nextSecuritySettings };
        },
        mutateAcceptedBusinessState: () => {
          platformMutableState.telegramNotificationSettings = nextNotificationSettings;
          platformMutableState.telegramSecuritySettings = nextSecuritySettings;
          settings.setJson(telegramNotificationSettingsKey, nextNotificationSettings);
          settings.setJson(telegramSecuritySettingsKey, nextSecuritySettings);
          appendAuditLog({
            actorType: 'local_api',
            action: 'telegram.settings.updated',
            resourceType: 'telegram',
            resourceId: 'settings',
            payload: {
              chatIdCount: nextNotificationSettings.chatIds.length,
              allowedUserIdsCount: nextSecuritySettings.allowedUserIds.length,
              enabled: nextNotificationSettings.enabled,
              silentMode: nextNotificationSettings.silentMode,
            },
          });
        },
      });
      return execution.result;
    } catch (error) {
      return sendTelegramCommandRouteError(reply, error);
    }
  });

  registerTelegramPollingApi({
    server,
    application: telegramCommands,
    requireService: requireTelegramPollingService,
    getService: getTelegramPollingService,
    getTimer: () => platformMutableState.telegramPollingTimer,
    setTimer: (timer) => (platformMutableState.telegramPollingTimer = timer),
    redactSensitiveText,
  });

  // eslint-disable-next-line prefer-const
  closeLocalServerResources = async () => {
    const cleanupErrors: unknown[] = [];
    await closeHeavyWorkerJobs();
    platformMutableState.removeStorageWriteFaultListener?.();
    platformMutableState.removeStorageWriteFaultListener = null;
    if (platformMutableState.nativeEventSaveTimer) clearTimeout(platformMutableState.nativeEventSaveTimer);
    platformMutableState.nativeEventSaveTimer = null;
    try {
      flushPendingNativeDeltaEvents();
    } catch (error) {
      cleanupErrors.push(error);
    }
    commandCenter.close();
    if (platformMutableState.usageRefreshTimer) {
      clearInterval(platformMutableState.usageRefreshTimer);
      platformMutableState.usageRefreshTimer = undefined;
    }
    if (platformMutableState.telegramPollingTimer) {
      clearInterval(platformMutableState.telegramPollingTimer);
      platformMutableState.telegramPollingTimer = undefined;
    }
    try {
      await codexLegacyImportService?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await codexNativeCoordinator.close({ mode: settleCodexPendingOnClose ? 'final' : 'handoff' });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await piNativeCoordinator.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    // 只要 manager 仍保有活动进程所有权，就保留数据库与回调边界并低频重试。
    // 不能在子进程仍可能运行时关闭 DB 并让 execution host 强退，否则会留下无人管理的高能耗进程树。
    while (true) {
      try {
        // 先等待 Runtime 子进程与 stdout/stderr 排空，再执行最后一次保存和数据库关闭。
        await aiRuntimeManager.close();
        break;
      } catch (error) {
        const stillOwnsProcess = aiRuntimeManager.listSessions().some((session) => runtimeSessionMayOwnProcess(session.status));
        if (!stillOwnsProcess) {
          cleanupErrors.push(error);
          break;
        }
        await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, 250));
      }
    }
    try {
      flushRuntimeLogFileWrites();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await flushRuntimePersistenceWrites();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (ownsCodexAppServerManager) {
      try {
        await codexAppServerManager.prepareForShutdown();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await codexAppServerManager.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await workManagementTaskEffects.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await taskEventFileProjection.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await projectionDatabases.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await db.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Zeus local-server shutdown cleanup failed.');
  };
  return { close: closeLocalServerResources, projectGitQueries, conversationCapabilityQueries, commandCenter };
}
