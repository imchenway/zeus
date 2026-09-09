import { hasDatabaseUriPassword } from './projectCore.js';
import { createAutomationConversationDispatch } from './automationConversationDispatch.js';
import {
  checkAiCliAdapter,
  type CodexModelCapability,
  type CodexRemoteControlStatus,
  createAgentCapabilityCatalog,
  createAiRuntimeSessionManager,
  isNonCodexAiCliAdapterId,
  listAiCliAdapters,
  type SelectableConnectionModel,
} from '@zeus/ai-runtime';
import {
  buildGitPatchExport,
  getGitRepositoryContext,
  getGitWorkingContext,
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
import { normalizeProjectConfig, normalizeProjectModelServiceTierPreference, type ProjectConfigSnapshot, type ProjectModelServiceTierPreference, type UpdateProjectConfigBody } from './projectCore.js';
import { getSecretPresenceLabel } from './securityCore.js';
import { cloneTaskManagementStatusConfig, type TaskAttachmentReference, type TaskPushParentAttachmentOption } from '@zeus/shared';
import {
  AutomationRunRepository,
  AutomationTaskRepository,
  CommandDefinitionRepository,
  ConversationExecutionRepository,
  ConversationExpertRepository,
  ConversationProviderItemRepository,
  ConversationRepository,
  ConversationResourceRepository,
  ConversationServerRequestRepository,
  ConversationTurnRepository,
  DigitalEmployeeAutomationRepository,
  DigitalEmployeeExecutionRepository,
  DigitalEmployeeProjectEventRepository,
  DigitalEmployeeRepository,
  DigitalEmployeeTemplateRepository,
  ImRepository,
  ProjectionDatabaseRuntimeManager,
  ProjectRepository,
  runtimeSessionMayOwnProcess,
  SettingRepository,
  TaskBoardRepository,
  TaskEventRepository,
  type TaskManagementStatus,
  TaskRepository,
  TaskStageRepository,
  TaskWorkDecisionRepository,
  TaskWorkDeliverableRepository,
  TaskWorkItemRepository,
  TaskWorkRunRepository,
  TaskWorkspaceRepository,
  TerminalEventRepository,
  type ZeusConversationRecord,
  type ZeusProjectRecord,
  type ZeusTaskIntegrationAttemptRecord,
  type ZeusTaskRecord,
} from '@zeus/storage';
import { type TaskStatus } from './taskCore.js';
import { createTelegramBotMessageClient, getTelegramConfigurationState, type TelegramMessageSender, type TelegramPollingService } from './telegramAdapter.js';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { type CodexRemoteControlSnapshot, registerCodexPublicCommandRoutes } from './codexPublicCommandRoutes.js';
import { CodexSubagentQueryApplication } from './codexSubagentQueryApplication.js';
import { registerCodexSubagentQueryRoutes } from './codexSubagentQueryRoutes.js';
import { createCodexSubagentRuntimeReader } from './codexSubagentRuntimeProjection.js';
import { createCommandCenter } from './commandCenter.js';
import { ConversationCapabilityQueryApplication } from './conversationCapabilityQueryApplication.js';
import { ProjectRepositoryDiscoveryService } from './projectRepositoryDiscovery.js';
import { createDigitalEmployeeOrchestrator, type DigitalEmployeeOrchestrator } from './digitalEmployeeOrchestrator.js';
import { type AutomationScheduler, createAutomationScheduler } from './automationScheduler.js';
import { registerAutomationRoutes } from './automationRoutes.js';
import { registerDigitalEmployeeRoutes } from './digitalEmployeeRoutes.js';
import { registerConversationCapabilityQueryRoutes } from './conversationCapabilityQueryRoutes.js';
import { ConversationChoiceQueryApplication } from './conversationChoiceQueryApplication.js';
import { registerConversationChoiceQueryRoutes } from './conversationChoiceQueryRoutes.js';
import { registerConversationCommandRoutes } from './conversationCommandRoutes.js';
import { registerConversationDispatchCommandRoutes } from './conversationDispatchCommandRoutes.js';
import { ConversationDispatchCommandApplication, conversationDispatchCommandTypes, conversationDispatchInputSha256 } from './conversationDispatchCommandApplication.js';
import { isPathInsideRoot, readConversationResourcePreview } from './conversationResourcePreview.js';
import { type ConversationFileOpenGrant, createConversationFileOpenGrant, toConversationResource, toConversationResourceOpenIntent } from './conversationResources.js';
import { registerConversationSnapshotV2Api } from './conversationSnapshotV2Api.js';
import { registerConversationSyncRoutes } from './conversationSyncRoutes.js';
import { registerExecutionHostControlApi } from './executionHostControlApi.js';
import { createPollingAdmissionPause, registerExecutionHostHandoffApi } from './executionHostHandoffApi.js';
import { registerGitCommandRoutes } from './gitCommandRoutes.js';
import { readTaskIntegrationSnapshot } from './gitIntegrationOperations.js';
import { conversationStartReject, isExplicitConversationStartRejection, registerConversationStartCommandRoutes } from './conversationStartCommandRoutes.js';
import { ConversationStartCommandApplication, conversationStartCommandTypes, conversationStartInputSha256 } from './conversationStartCommandApplication.js';
import { closeHeavyWorkerJobs, heavyWorkerPoolSnapshot } from './heavyWorkerPool.js';
import type {
  DashboardSnapshot,
  ConversationHistoryItem,
  ConversationHistoryPage,
  ProjectDatabaseSecretSnapshot,
  ReleaseStatusSnapshot,
  RuntimeStatusSnapshot,
  SaveProjectDatabaseSecretBody,
  SecurityAuditLogEntry,
  SecurityResetResult,
  SecuritySecretsSnapshot,
  TelegramNotificationSettingsSnapshot,
  TelegramSecuritySettingsSnapshot,
} from './index.js';
import { registerIntegrationCommandRoutes } from './integrationCommandRoutes.js';
import { registerImConnectionRoutes } from './imConnectionRoutes.js';
import { ImTelegramService, stableIdentity } from './imTelegramService.js';
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
  codexRemoteControlEnabledSettingKey,
  type ImportLocalSettingsBody,
  type ImportLocalSettingsResult,
  type LocalSettingsExportSnapshot,
  normalizeImportedRuntimeSettings,
  patchAppShellSettings,
  projectConfigSettingsPrefix,
  runtimeSettingsKey,
  type UpdateAppShellSettingsBody,
  type UpdateRuntimeSettingsBody,
} from './localServerSettingsNormalization.js';
import { MemoryContextApplicationService, registerMemoryContextApi } from './memoryContextApi.js';
import { ProjectGitQueryApplication } from './projectGitQueryApplication.js';
import { registerProjectGitQueryRoutes } from './projectGitQueryRoutes.js';
import { ProjectQueryApplication } from './projectQueryApplication.js';
import { registerProjectQueryRoutes } from './projectQueryRoutes.js';
import { generateCodexCommitMessage } from './gitCommitCodexGeneration.js';
import { generateGitCommitMessage } from './gitCommitMessageGeneration.js';
import { generateReleaseNotesWithDeepSeek } from './releaseNotesGeneration.js';
import { registerReleaseUpdateApi } from './releaseUpdateApi.js';
import { parseRuntimeArgs, RuntimeQueryApplication, runtimeSessionIsConfirmedTerminal, type RuntimeSettingsSnapshot, toAiRuntimeLogEntry, toAiRuntimeSession } from './runtimeQueryApplication.js';
import { registerRuntimeQueryRoutes } from './runtimeQueryRoutes.js';
import { registerRuntimeSessionCommandRoutes } from './runtimeSessionCommandRoutes.js';
import { type ParsedSettingsCommand, SettingsCommandApplication, settingsCommandHttpError, type SettingsCommandRequest, settingsCommandTypes } from './settingsCommandApplication.js';
import { registerStorageRecoveryPreflightApi } from './storageRecoveryPreflightApi.js';
import { TaskStageApplication } from './taskStageApplication.js';
import { registerTaskStageRoutes } from './taskStageRoutes.js';
import { registerTaskWorkManagement, type TaskWorkManagementController } from './taskWorkManagement.js';
import { telegramChildOperation, TelegramCommandApplication, telegramCommandHttpError, type TelegramCommandRequest, telegramCommandTypes } from './telegramCommandApplication.js';
import { registerTelegramPollingApi } from './telegramPollingApi.js';
import { registerTelegramSettingsRoutes } from './telegramSettingsRoutes.js';
import { changeSetErrorStatus, errorCode as turnChangeSetErrorCode } from './turnChangeSets.js';
import { WorkManagementCommandApplication, workManagementCommandTypes, workManagementInputSha256 } from './workManagementCommandApplication.js';
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
import { registerZeusPluginRoutes } from './zeusPluginRoutes.js';
import { imInternalCommandRequest } from './localServerPlatformSupport.js';

export { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor, type ReadOnlyValidationApplicationIdentity } from './readOnlyValidation.js';

// 拆分期间保留结构化工厂依赖，后续按领域端口继续收窄。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LocalServerPlatformRouteDependencies = Record<string, any> & {
  server: FastifyInstance;
  aiRuntimeManager: ReturnType<typeof createAiRuntimeSessionManager>;
  conversationChoiceQueries: ConversationChoiceQueryApplication;
  conversationExecution: ConversationExecutionRepository;
  conversationExperts: ConversationExpertRepository;
  conversationDispatchCommands: ConversationDispatchCommandApplication;
  conversationAttachmentRoot?: string;
  taskAttachmentRoot?: string;
  conversationProviderItems: ConversationProviderItemRepository;
  conversationRequests: ConversationServerRequestRepository;
  conversationResources: ConversationResourceRepository;
  conversationTurns: ConversationTurnRepository;
  conversations: ConversationRepository;
  isNativeApiRecord(value: unknown): value is Record<string, unknown>;
  conversationStartCommands: ConversationStartCommandApplication;
  mapTaskRepositoriesWithConcurrency<Input, Output>(items: Input[], operation: (item: Input, index: number) => Promise<Output>, concurrency?: number): Promise<Output[]>;
  platformMutableState: {
    appShellSettings: AppShellSettingsSnapshot;
    codexRemoteControlEnabled: boolean;
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
  taskStages: TaskStageRepository;
  taskWorkspaces: TaskWorkspaceRepository;
  tasks: TaskRepository;
  telegramCommands: TelegramCommandApplication;
  terminalEvents: TerminalEventRepository;
  workManagementCommands: WorkManagementCommandApplication;
};

export async function registerLocalServerPlatformRoutes(dependencies: LocalServerPlatformRouteDependencies): Promise<{
  close(): Promise<void>;
  recover(): void;
  projectGitQueries: ProjectGitQueryApplication;
  conversationCapabilityQueries: ConversationCapabilityQueryApplication;
  commandCenter: ReturnType<typeof createCommandCenter>;
}> {
  const {
    server,
    zeusLocalServerHost,
    archiveNativeConversation,
    buildRuntimeProcessEnv,
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
    aiRuntimeManager,
    apiPerformance,
    appShellSettingsKey,
    appendAuditLog,
    applyConversationQueueReroute,
    applyLocalCorsHeaders,
    artifactStore,
    assertRequestedAgentKind,
    assertTelegramCommandInputKeys,
    auditLogs,
    authorizeReleaseNotesRequest,
    getBoundPort,
    buildReleaseStatusSnapshot,
    buildReleaseUpdateStatus,
    closeTaskResourcesForTerminalStatus,
    codexAppServerManager,
    codexConfigImportService,
    zeusSkillDefaultCwd,
    zeusSkillService,
    zeusPluginService,
    zeusConversationPluginRuntime,
    dangerouslyBypassPluginHookTrust,
    codexExternalAgentHome,
    codexLegacyImportService,
    codexNativeCoordinator,
    codexNativeEnabled,
    codexPublicCommands,
    codexUsageService,
    commandRuns,
    configuredCodexRuntimeCommandPath,
    conversationChoiceQueries,
    conversationExecution,
    conversationExperts,
    retryExpertExecution,
    conversationAttachmentRoot,
    taskAttachmentRoot,
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
    getProjectDatabasePasswordSecretKey,
    getTelegramPollingService,
    gitCommands,
    conversationStartCommands,
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
    normalizeTaskPushSupplementalAttachments,
    normalizeImportedTelegramNotificationSettings,
    normalizeImportedTelegramSecuritySettings,
    now,
    options,
    ownsCodexAppServerManager,
    parseTelegramDispatchPreviewInput,
    parseTelegramNotificationSettingsInput,
    parseTelegramSecuritySettingsInput,
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
    resolveNativeConversationExecutionRoot,
    resolveTaskIntegrationRequest,
    resolveTaskManagementStatusConfigForProject,
    resolveTaskPushContextState,
    resolveTaskWorkspaceRequest,
    restoreNativeConversation,
    retryTaskIntegrationAiPreparation,
    revokeReleaseNotesCapability,
    runRuntimeLogRetention,
    runtimeEphemeralCapabilities,
    runtimeSessionCommands,
    runtimeSessionDataDirectory,
    runtimeTerminalStatus,
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
    taskStages,
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
    toConversationHistoryItem,
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
    zentaoCredentials,
  } = dependencies;
  let closeLocalServerResources: () => Promise<void>;
  let digitalEmployeeOrchestrator: DigitalEmployeeOrchestrator | null = null;
  let taskWorkManagement: TaskWorkManagementController | null = null;
  let automationScheduler: AutomationScheduler | null = null;
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

  server.get('/api/projects/:projectId/git/commit-models', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    if (!projects.getById(request.params.projectId)) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: '项目不存在。' });
    const items = (await modelConnections.listSelectableModels())
      .filter((model: SelectableConnectionModel) => model.available && model.enabled && model.runtimeAdapter === 'pi_sdk')
      .map((model: SelectableConnectionModel) => ({ id: model.id, label: `${model.sourceName} · ${model.displayName}` }));
    let warning = '';
    try {
      if (!codexNativeEnabled) throw new Error('Codex 尚未启用。');
      const capabilities = await codexAppServerManager.ensureReady({ commandPath: currentCodexRuntimeCommandPath(), ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}) });
      const account = await codexAppServerManager.readAccount();
      if (!account.signedIn && account.requiresOpenaiAuth) throw new Error('请先在 Zeus 中登录 Codex，再刷新模型列表。');
      items.push(...capabilities.models.filter((model: CodexModelCapability) => model.raw.hidden !== true).map((model: CodexModelCapability) => ({ id: `codex:${model.model}`, label: `Codex · ${model.displayName || model.model}` })));
    } catch (error) {
      warning = redactSensitiveText(error instanceof Error ? error.message : 'Codex 模型加载失败。').text;
    }
    return { items, warning };
  });

  server.post(
    '/api/projects/:projectId/git/commit-message',
    { bodyLimit: 512_000 },
    async (request: FastifyRequest<{ Params: { projectId: string }; Body: { repositoryName?: unknown; stagedDiff?: unknown; files?: unknown; language?: unknown; modelRef?: unknown } }>, reply) => {
      if (!projects.getById(request.params.projectId)) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: '项目不存在。' });
      const body = request.body;
      if (
        typeof body?.repositoryName !== 'string' ||
        body.repositoryName.length > 1000 ||
        (body.modelRef !== undefined && (typeof body.modelRef !== 'string' || !body.modelRef.trim() || body.modelRef.length > 2000)) ||
        typeof body.stagedDiff !== 'string' ||
        body.stagedDiff.length > 100_000 ||
        !Array.isArray(body.files) ||
        body.files.length > 2000 ||
        body.files.some((file) => typeof file !== 'string' || file.length > 4096)
      ) {
        return reply.code(400).send({ error: 'ZEUS_GIT_COMMIT_MESSAGE_INPUT_INVALID', message: '已暂存改动内容无效或过大，请缩小提交范围。' });
      }
      try {
        const input = {
          repositoryName: body.repositoryName,
          stagedDiff: redactSensitiveText(body.stagedDiff).text,
          files: body.files as string[],
          language: body.language === 'en' ? ('en' as const) : ('zh-CN' as const),
          ...(typeof body.modelRef === 'string' ? { modelRef: body.modelRef } : {}),
        };
        if (input.modelRef?.startsWith('codex:')) {
          if (!codexNativeEnabled) throw new Error('Codex 尚未启用。');
          return await generateCodexCommitMessage(input, {
            commandPath: currentCodexRuntimeCommandPath(),
            codexHome: options.codexHome ?? dataLayout.codexHome,
            ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}),
          });
        }
        return await generateGitCommitMessage(modelConnections, request.params.projectId, input);
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
        return reply.code(status).send({ error: 'ZEUS_GIT_COMMIT_MESSAGE_FAILED', message: error instanceof Error ? error.message : 'AI 生成失败。' });
      }
    },
  );

  const projectQueries = new ProjectQueryApplication({
    projects,
    tasks,
    sharedPaths: projectSharedPaths,
    readConfig: readProjectConfig,
    git: {
      readOverviewStatus: (project) => (readOnlyValidation ? Promise.resolve(projectGitQueries.unsupportedStatus('只读验证模式不访问正式项目 Git；仅展示复制库中的项目与任务投影。')) : projectGitQueries.readStatus(project.id)),
    },
  });
  registerProjectQueryRoutes({ server, application: projectQueries });

  const workManagementQueries = new WorkManagementQueryApplication({ projects, tasks, taskBoards, taskEvents, taskTemplates });
  registerWorkManagementQueryRoutes({ server, application: workManagementQueries });

  const taskStageApplication = new TaskStageApplication({
    db,
    tasks,
    stages: taskStages,
    conversations,
    artifacts: artifactStore,
    recordTaskEvent,
    publishRealtimeEvent,
  });
  registerTaskStageRoutes({ server, application: taskStageApplication, commands: workManagementCommands, save: () => db.save() });

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
    settings,
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
    projectExists: (projectId) => Boolean(projects.getById(projectId)),
    getConversation: (conversationId) => conversations.getRecordById(conversationId),
    readExecutionContext: async (conversationId) => {
      if (readOnlyValidation) return { cwd: null, branch: null, isGitRepository: null };
      const conversation = conversations.getRecordById(conversationId);
      const cwdSource = conversation ? resolveNativeConversationExecutionRoot(conversation) : null;
      if (!cwdSource) return { cwd: null, branch: null, isGitRepository: null };
      const cwd = resolve(cwdSource);
      const git = await getGitWorkingContext(cwd);
      return { cwd, branch: git.branch, isGitRepository: git.isRepository };
    },
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
    };
  });

  registerCodexPublicCommandRoutes({
    server,
    application: codexPublicCommands,
    configImport: codexConfigImportService,
    legacyImport: codexLegacyImportService,
    skills: zeusSkillService,
    plugins: zeusPluginService,
    resolveSkillCwd: (projectId) => {
      if (!projectId) return zeusSkillDefaultCwd;
      const project = projects.getById(projectId);
      if (!project) throw Object.assign(new Error('项目不存在，无法读取项目级 Skill。'), { code: 'ZEUS_PROJECT_NOT_FOUND', statusCode: 404 });
      return project.localPath;
    },
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
      logout: () => codexAppServerManager.logoutAccount(),
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
  registerZeusPluginRoutes({
    server,
    plugins: zeusPluginService,
    runtime: zeusConversationPluginRuntime,
    dangerouslyBypassHookTrust: dangerouslyBypassPluginHookTrust === true,
    hasProject: (projectId) => Boolean(projects.getById(projectId)),
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
    ): Promise<ConversationHistoryPage | unknown> => {
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
        items: page.items.map(toConversationHistoryItem),
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
    toConversationHistoryItem: toConversationHistoryItem,
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
      queueUpdate: ({ params, content }) => {
        requireNativeQueueConversation(params);
        return conversationQueueCoreMutations.update({ conversationId: params.conversationId, submissionId: params.submissionId, content });
      },
      queueRetry: ({ params }) => {
        const conversation = requireNativeQueueConversation(params);
        const expertExecution = conversationExperts.getExecution(params.submissionId);
        if (expertExecution && expertExecution.conversationId === conversation.id) return retryExpertExecution(conversation.id, expertExecution.id);
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
        const turn = conversationTurns.listByConversation(conversation.id).find((candidate) => candidate.id === params.turnId || candidate.providerTurnId === params.turnId);
        if (!turn) throw Object.assign(nativeApiError('ZEUS_NATIVE_TURN_NOT_FOUND', 'Native provider turn not found'), { statusCode: 404 });
        if (!turn.providerTurnId && turn.clientSubmissionId) {
          const executions = conversationExperts.listExecutionsBySubmission(turn.clientSubmissionId);
          if (executions.length === 0) throw Object.assign(nativeApiError('ZEUS_NATIVE_TURN_NOT_FOUND', 'Native provider turn not found'), { statusCode: 404 });
          const interruptedAt = now().toISOString();
          for (const execution of executions) {
            if (['completed', 'failed', 'interrupted', 'cancelled'].includes(execution.status)) continue;
            const child = conversations.getById(execution.childConversationId);
            const childTurn = conversationTurns.getLatestActiveByConversation(execution.childConversationId);
            if (child && childTurn?.providerTurnId) {
              try {
                if (child.agentKind === 'pi') await piNativeCoordinator.interruptTurn({ conversation: child, providerTurnId: childTurn.providerTurnId });
                else await codexNativeCoordinator.interruptTurn({ conversationId: child.id, providerTurnId: childTurn.providerTurnId });
              } catch {
                // 父轮次的停止意图仍需耐久收口；子 Provider 的迟到结果会被终态门禁丢弃。
              }
            }
            const interrupted = conversationExperts.setExecutionStatus({ executionId: execution.id, status: 'interrupted', updatedAt: interruptedAt });
            publishNativeConversationEvent('conversation.expert.execution.changed', {
              conversationId: conversation.id,
              turnId: turn.id,
              execution: {
                id: interrupted.id,
                submissionId: interrupted.submissionId,
                ordinal: interrupted.ordinal,
                status: interrupted.status,
                actor: JSON.parse(interrupted.employeeSnapshotJson),
                text: interrupted.answer ?? '',
                error: interrupted.errorJson ? JSON.parse(interrupted.errorJson) : null,
              },
            });
          }
          conversationExperts.finishRoundIfTerminal(turn.clientSubmissionId, interruptedAt);
          await db.save();
          queueMicrotask(() => void dispatchUnifiedConversationQueueHead?.(conversation.id).catch(() => undefined));
          const updatedConversation = conversations.getById(conversation.id);
          const submission = conversationSubmissions.getById(turn.clientSubmissionId);
          if (!updatedConversation) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native interrupt acceptance was not persisted.');
          return toNativeInterruptAcceptance(operationIdentity, params.turnId, updatedConversation, submission);
        }
        const operation =
          conversation.agentKind === 'pi'
            ? await piNativeCoordinator.interruptTurn({ conversation, providerTurnId: turn.providerTurnId! })
            : await codexNativeCoordinator.interruptTurn({ conversationId: conversation.id, providerTurnId: turn.providerTurnId! });
        const updatedConversation = conversations.getById(conversation.id);
        const submission = operation.submissionId ? conversationSubmissions.getById(operation.submissionId) : undefined;
        if (!updatedConversation) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native interrupt acceptance was not persisted.');
        return toNativeInterruptAcceptance(operationIdentity, turn.providerTurnId!, updatedConversation, submission);
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
      queueRecover: async ({ params, intent }) => {
        const conversation = requireNativeQueueConversation(params);
        // 检查只返回已有 Pi 事实；不重启执行器或重新准备合入目录。
        if (intent === 'check' && conversation.agentKind === 'pi') return toNativeQueueApiSnapshot(conversation);
        const conflictAttempt = taskIntegrationAttempts.getByConversationId(conversation.id);
        if (intent === 'continue' && conflictAttempt?.state === 'failed') {
          await retryTaskIntegrationAiPreparation(conversation, conflictAttempt);
          return toNativeQueueApiSnapshot(conversation);
        }
        return codexNativeCoordinator.recoverQueue({ conversationId: conversation.id, intent });
      },
      queueReorder: ({ params, orderedSubmissionIds }) => {
        const conversation = requireNativeQueueConversation(params);
        return conversationQueueCoreMutations.reorder({ conversationId: conversation.id, orderedSubmissionIds });
      },
      afterMessageAccepted: ({ params, message }) => {
        if ((message.delivery ?? 'queue') !== 'queue') return;
        queueMicrotask(() => void dispatchUnifiedConversationQueueHead?.(params.conversationId).catch(() => undefined));
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

  type PreparedConversationProject = { kind: 'project'; project: ZeusProjectRecord };
  type PreparedConversationTask = { kind: 'task'; project: ZeusProjectRecord; task: ZeusTaskRecord };

  registerConversationStartCommandRoutes({
    server,
    application: conversationStartCommands,
    operations: {
      prepareProjectConversation: async ({ projectId, value }) => {
        const project = projects.getById(projectId);
        if (!project) conversationStartReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
        assertRequestedAgentKind(value);
        if (value.mode !== 'create') conversationStartReject(400, 'ZEUS_INVALID_CONVERSATION_START', 'Project conversations require mode create.');
        return { kind: 'project', project } satisfies PreparedConversationProject;
      },
      startProjectConversation: ({ prepared, value, operationIdentity, markExternalWriteStarted }) => {
        const { project } = requirePreparedConversationProject(prepared);
        return executeProjectConversationIdempotent(project, value, operationIdentity, markExternalWriteStarted);
      },
      prepareTaskConversation: async ({ taskId, value }) => {
        const task = tasks.getById(taskId);
        if (!task) conversationStartReject(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found');
        if (taskManagementStatusIsTerminal(task)) {
          conversationStartReject(409, 'ZEUS_TASK_REOPEN_REQUIRED', 'This task is completed or cancelled. Reopen the task and restore one archived conversation before continuing.');
        }
        const project = projects.getById(task.projectId);
        if (!project) conversationStartReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
        assertRequestedAgentKind(value);
        return { kind: 'task', project, task } satisfies PreparedConversationTask;
      },
      startTaskConversation: ({ prepared, value, operationIdentity, markExternalWriteStarted }) => {
        const { project, task } = requirePreparedConversationTask(prepared);
        return executeTaskConversationIdempotent(project, task, value, operationIdentity, markExternalWriteStarted);
      },
      isExplicitRejection: isExplicitConversationStartRejection,
    },
    sendNativeError: sendNativeConversationApiError,
  });

  function requirePreparedConversationProject(value: unknown): PreparedConversationProject {
    if (!isNativeApiRecord(value) || value.kind !== 'project' || !isNativeApiRecord(value.project)) {
      conversationStartReject(500, 'ZEUS_CONVERSATION_START_PREPARE_MISSING', 'Prepared project command context is unavailable.');
    }
    return value as unknown as PreparedConversationProject;
  }

  function requirePreparedConversationTask(value: unknown): PreparedConversationTask {
    if (!isNativeApiRecord(value) || value.kind !== 'task' || !isNativeApiRecord(value.project) || !isNativeApiRecord(value.task)) {
      conversationStartReject(500, 'ZEUS_CONVERSATION_START_PREPARE_MISSING', 'Prepared task conversation context is unavailable.');
    }
    return value as unknown as PreparedConversationTask;
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
      const directRequests = conversationRequests.listByConversation(conversation.id).filter((request) => request.status === 'pending' || (request.requestKind === 'request_user_input' && request.status === 'resolved'));
      const expertRequests = conversationExperts.listParticipants(conversation.id).flatMap((participant) => conversationRequests.listPendingByConversation(participant.childConversationId));
      const visibleRequests = [...directRequests, ...expertRequests];
      return {
        conversationId: conversation.id,
        // 先保留存储层本地身份；Renderer 会使用当前快照已知的映射统一为 Provider
        // 身份。这样超出最近轮次窗口的旧正文和旧回答仍共同使用本地 turnId，
        // 不会因为只有回答被提前转换而拆散到两个轮次。
        requests: visibleRequests.map((providerRequest) => {
          const projected = toNativeServerRequest(providerRequest);
          const execution = conversationExperts.getActiveExecutionByChildConversation(providerRequest.conversationId);
          if (!execution) return projected;
          const parentTurn = conversationTurns.listByConversation(conversation.id).find((turn) => turn.clientSubmissionId === execution.submissionId);
          return {
            ...projected,
            conversationId: conversation.id,
            ...(parentTurn ? { turnId: parentTurn.id } : {}),
            actor: JSON.parse(execution.employeeSnapshotJson),
            expertExecutionId: execution.id,
            ordinal: execution.ordinal,
          };
        }),
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
    ): Promise<ConversationHistoryItem | unknown> => {
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
    '/api/projects/:projectId/model-service-tier-preference',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: SettingsCommandRequest<ProjectModelServiceTierPreference>;
      }>,
      reply,
    ): Promise<ProjectConfigSnapshot | unknown> => {
      try {
        const parsed = settingsCommands.parse<ProjectModelServiceTierPreference>({
          value: request.body,
          commandType: settingsCommandTypes.projectModelServiceTierPreferencePut,
          scopeKind: 'project',
          expectedScopeId: () => request.params.projectId,
        });
        const project = projects.getById(request.params.projectId);
        if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
        const preference = normalizeProjectModelServiceTierPreference(parsed.input);
        if (!preference) {
          return reply.code(400).send({
            error: 'ZEUS_INVALID_PROJECT_SERVICE_TIER_PREFERENCE',
            message: 'Project model service tier preference must identify one model and use standard or priority',
          });
        }
        const current = readProjectConfig(project.id);
        const replacesExisting = current.serviceTierPreferences.some((entry: ProjectModelServiceTierPreference) => entry.modelSourceId === preference.modelSourceId && entry.modelId === preference.modelId);
        if (!replacesExisting && current.serviceTierPreferences.length >= 100) {
          return reply.code(409).send({ error: 'ZEUS_PROJECT_SERVICE_TIER_PREFERENCE_LIMIT', message: 'Project model service tier preference limit reached' });
        }
        const nextConfig: ProjectConfigSnapshot = {
          ...current,
          serviceTierPreferences: [...current.serviceTierPreferences.filter((entry: ProjectModelServiceTierPreference) => entry.modelSourceId !== preference.modelSourceId || entry.modelId !== preference.modelId), preference],
        };
        const mutation = settingsCommands.executeCore({
          parsed,
          destinationId: 'project_model_service_tier_preference',
          resourceId: project.id,
          mutateBusinessState: () => {
            settings.setJson(projectConfigSettingsPrefix + project.id, nextConfig);
            appendAuditLog({
              actorType: 'local_api',
              action: 'project.service_tier_preference.updated',
              resourceType: 'project',
              resourceId: project.id,
              payload: { ...preference },
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
        // 普通项目设置保存不拥有模型速度偏好，避免旧界面快照覆盖专用接口写入的显式选择。
        const ordinaryConfigBody: UpdateProjectConfigBody = { ...parsed.input };
        delete ordinaryConfigBody.serviceTierPreferences;
        const nextConfig = normalizeProjectConfig(project.id, ordinaryConfigBody, readProjectConfig(project.id));
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
              payload: { defaultWorkMode: nextConfig.defaultWorkMode, language: nextConfig.language.primary },
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
    try {
      /** 只读验收沿用复制库投影；正常打开交付页时读取真实冲突路径，不改写历史记录。 */
      const items = readOnlyValidation ? taskIntegrations.listByTask(task.id) : await Promise.all(taskIntegrations.listByTask(task.id).map(readTaskIntegrationSnapshot));
      return { taskId: task.id, items, integrations: items };
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
  });

  server.get('/api/tasks/:taskId/integrations/:integrationId/conflict', async (request: FastifyRequest<{ Params: { taskId: string; integrationId: string }; Querystring: { path?: string } }>, reply) => {
    const resolved = resolveTaskIntegrationRequest(request.params.taskId, request.params.integrationId);
    if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
    if (!resolved.integration.integrationPath) return reply.code(409).send({ error: 'ZEUS_TASK_INTEGRATION_PATH_UNAVAILABLE', message: 'Integration worktree is unavailable.' });
    /** 查询参数传递真实文件名，首尾空白不属于可清理的输入噪声。 */
    const path = request.query.path;
    if (!path) return reply.code(400).send({ error: 'ZEUS_GIT_PATH_REQUIRED', message: 'path is required' });
    try {
      return await readTaskIntegrationConflict(resolved.integration.integrationPath, path);
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
  });

  /** 后台发现只在普通可写宿主中被项目命令或恢复入口触发。 */
  const repositoryDiscovery = new ProjectRepositoryDiscoveryService({ db, projects, repositories: projectRepositories, settings, publishRealtimeEvent, redactSensitiveText });
  const workManagementProjectOperations = new WorkManagementProjectOperations({
    repositoryDiscovery,
    projects,
    sharedPaths: projectSharedPaths,
    templates: taskTemplates,
    saveProjectConfig: (projectId, config) => settings.setJson(projectConfigSettingsPrefix + projectId, config),
    stageProjectModelSelection: (projectId, explicitModel) => {
      // 项目显式模型优先；完整引用保存在模型选择中，不裁成裸模型名。
      const reference = explicitModel ?? platformMutableState.appShellSettings.newProjectDefaultModelRef;
      if (!reference) return;
      // 保留用户指定的完整引用；可用性只在推送阶段判断，不阻断项目创建。
      if (!reference.includes(':')) return;
      modelConnections.savePreparedProjectSelectionInCurrentTransaction({ projectId, allowedModelRefs: [reference], defaultModelRef: reference });
    },
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
    refreshRepositories: (projectId, context) => workManagementProjectOperations.refreshRepositories(projectId, context),
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

  const digitalEmployeeTemplates = new DigitalEmployeeTemplateRepository(db);
  const digitalEmployees = new DigitalEmployeeRepository(db);
  const digitalEmployeeAutomations = new DigitalEmployeeAutomationRepository(db);
  const digitalEmployeeExecutions = new DigitalEmployeeExecutionRepository(db);
  const digitalEmployeeProjectEvents = new DigitalEmployeeProjectEventRepository(db);
  const digitalEmployeeCommandDefinitions = new CommandDefinitionRepository(db);
  const taskWorkItems = new TaskWorkItemRepository(db, () => now().toISOString());
  const taskWorkRuns = new TaskWorkRunRepository(db, () => now().toISOString());
  const taskWorkDeliverables = new TaskWorkDeliverableRepository(db, () => now().toISOString());
  const taskWorkDecisions = new TaskWorkDecisionRepository(db, () => now().toISOString());
  const imRepository = new ImRepository(db);
  const imTelegramService = new ImTelegramService({
    language: () => platformMutableState.appShellSettings.appLanguage,
    repository: imRepository,
    secretStore,
    telegramCommands,
    projects,
    digitalEmployees,
    conversationAttachmentRoot,
    taskAttachmentRoot,
    now,
    redactSensitiveText,
    save: () => db.save(),
    readLegacyToken: readTelegramToken,
    clearLegacyToken: () => secretStore.deleteSecret('telegram.botToken'),
    operations: {
      listConversations: (projectId) => conversations.listRecordsByProject(projectId),
      createProjectConversation: async ({ project, content, attachments, preset, operationIdentity }) => {
        const value: Record<string, unknown> = {
          mode: 'create',
          content,
          attachments,
          agentKind: preset.agentKind,
          permissionMode: preset.permissionMode,
          collaborationMode: preset.workMode,
          clientUserMessageId: stableIdentity('im_client_message', operationIdentity),
          ...(preset.model ? { model: preset.model } : {}),
          ...(preset.reasoningEffort ? { effort: preset.reasoningEffort } : {}),
          ...(preset.skillId ? { skillId: preset.skillId } : {}),
          ...(preset.pluginReferences.length > 0 ? { pluginReferences: preset.pluginReferences } : {}),
        };
        const request = imInternalCommandRequest({
          commandType: conversationStartCommandTypes.projectConversationCreate,
          scopeKind: 'project',
          scopeId: project.id,
          operationIdentity,
          input: value,
          inputSha256: conversationStartInputSha256(value),
        });
        const parsed = conversationStartCommands.parse<Record<string, unknown>>({
          value: request,
          commandType: conversationStartCommandTypes.projectConversationCreate,
          scopeKind: 'project',
          scopeId: project.id,
        });
        const executed = await conversationStartCommands.executeExternal<Record<string, unknown>, { statusCode: number; body: unknown }>({
          parsed,
          destinationId: 'project-conversation-create',
          resourceId: project.id,
          externalOperationId: `conversation.project.create:${project.id}:${parsed.operationIdentity}`,
          invoke: (markExternalWriteStarted) => executeProjectConversationIdempotent(project, value, parsed.operationIdentity, markExternalWriteStarted),
          isExplicitRejection: isExplicitConversationStartRejection,
        });
        const body = executed.result.body as { conversation?: { id?: unknown } };
        const conversationId = typeof body.conversation?.id === 'string' ? body.conversation.id : '';
        if (!conversationId) throw nativeApiError('ZEUS_IM_CONVERSATION_ACCEPTANCE_INVALID', 'IM project conversation acceptance omitted its durable conversation identity.');
        return { conversationId };
      },
      sendConversationMessage: async ({ projectId, conversationId, content, attachments, delivery, operationIdentity }) => {
        const value: Record<string, unknown> = {
          idempotencyKey: operationIdentity,
          content,
          attachments,
          delivery,
          clientUserMessageId: stableIdentity('im_client_message', operationIdentity),
        };
        const request = imInternalCommandRequest({
          commandType: conversationDispatchCommandTypes.messageSubmit,
          scopeKind: 'product_conversation',
          scopeId: conversationId,
          operationIdentity,
          input: value,
          inputSha256: conversationDispatchInputSha256(value),
        });
        const parsed = conversationDispatchCommands.parse<Record<string, unknown>>({
          value: request,
          commandType: conversationDispatchCommandTypes.messageSubmit,
          scopeKind: 'product_conversation',
          scopeId: conversationId,
        });
        await conversationDispatchCommands.executeExternal({
          parsed,
          destinationId: 'conversation-message-dispatch',
          resourceId: conversationId,
          externalOperationId: `conversation-message:${conversationId}:${operationIdentity}`,
          invoke: (markExternalWriteStarted) =>
            executeConversationDispatchMessage({
              params: { projectId, conversationId },
              body: value,
              operationIdentity,
              providerWriteLifecycle: { markPrepared: async () => undefined, markRpcStarted: markExternalWriteStarted },
            }),
          isExplicitRejection: isExplicitConversationStartRejection,
        });
      },
      interruptConversation: async ({ projectId, conversationId, operationIdentity }) => {
        const conversation = conversations.getRecordById(conversationId);
        if (!conversation || conversation.projectId !== projectId) return false;
        const turn = conversationTurns.getLatestActiveByConversation(conversationId);
        if (!turn?.providerTurnId) return false;
        const value: Record<string, never> = {};
        const request = imInternalCommandRequest({
          commandType: conversationDispatchCommandTypes.turnInterrupt,
          scopeKind: 'turn',
          scopeId: turn.providerTurnId,
          operationIdentity,
          input: value,
          inputSha256: conversationDispatchInputSha256(value),
        });
        const parsed = conversationDispatchCommands.parse<Record<string, never>>({ value: request, commandType: conversationDispatchCommandTypes.turnInterrupt, scopeKind: 'turn', scopeId: turn.providerTurnId });
        await conversationDispatchCommands.executeExternal({
          parsed,
          destinationId: 'conversation-provider-turn-interrupt',
          resourceId: turn.providerTurnId,
          externalOperationId: `provider-turn-interrupt:${turn.providerTurnId}`,
          invoke: async () => {
            const operation =
              conversation.agentKind === 'pi'
                ? await piNativeCoordinator.interruptTurn({ conversation, providerTurnId: turn.providerTurnId! })
                : await codexNativeCoordinator.interruptTurn({ conversationId, providerTurnId: turn.providerTurnId! });
            return { operation, acknowledged: true };
          },
          isExplicitRejection: isExplicitConversationStartRejection,
        });
        return true;
      },
      resumeConversation: async ({ projectId, conversationId, operationIdentity }) => {
        const conversation = conversations.getRecordById(conversationId);
        if (!conversation || conversation.projectId !== projectId || conversation.agentKind === 'pi') return false;
        const value: Record<string, never> = {};
        const request = imInternalCommandRequest({
          commandType: conversationDispatchCommandTypes.queueResume,
          scopeKind: 'product_conversation',
          scopeId: conversationId,
          operationIdentity,
          input: value,
          inputSha256: conversationDispatchInputSha256(value),
        });
        const parsed = conversationDispatchCommands.parse<Record<string, never>>({ value: request, commandType: conversationDispatchCommandTypes.queueResume, scopeKind: 'product_conversation', scopeId: conversationId });
        await conversationDispatchCommands.executeExternal({
          parsed,
          destinationId: 'conversation-provider-queue-resume',
          resourceId: conversationId,
          externalOperationId: `provider-queue-resume:${conversationId}`,
          invoke: () => codexNativeCoordinator.resumeInterruptedQueue({ conversationId }),
          isExplicitRejection: isExplicitConversationStartRejection,
        });
        return true;
      },
      readConversationOutput: async ({ projectId, conversationId, afterSequence }) => {
        const conversation = conversations.getRecordById(conversationId);
        if (!conversation || conversation.projectId !== projectId || conversation.archived) return [];
        const projected: Array<{
          id: string;
          sequence: number;
          turnId: string;
          providerItemId: string | null;
          role: string;
          reasoningSummary: boolean;
          toolPairId: string | null;
          content: { preview: string; byteLength: number; truncated: boolean; contentHandle: string | null; refreshRequired: boolean };
        }> = [];
        let cursor: string | undefined;
        do {
          const page = conversationSnapshotV2.listModelHistoryPage({ conversationId, ...(cursor ? { cursor } : {}), entryLimit: 256, byteLimit: 1024 * 1024 });
          projected.push(...page.items);
          cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
        } while (cursor && projected.length < 4_096);

        const resourceRecords = conversationResources.listByConversation(conversationId);
        const output = [];
        for (const item of projected) {
          if (item.sequence <= afterSequence || item.role !== 'assistant' || item.reasoningSummary || item.toolPairId) continue;
          let text = item.content.preview;
          if (item.content.truncated) {
            if (!item.content.contentHandle || item.content.refreshRequired) throw nativeApiError('ZEUS_IM_CONTENT_INCOMPLETE', 'Snapshot V2 正文句柄不可用于完整 Telegram 回传。');
            let offset = 0;
            let complete = '';
            for (let pageIndex = 0; pageIndex < 16_384; pageIndex += 1) {
              const page = conversationSnapshotV2.readContentPage({ conversationId, handle: item.content.contentHandle, offset, byteLimit: 64 * 1024 });
              if (page.kind !== 'model_content' || page.offset !== offset || page.totalBytes !== item.content.byteLength) throw nativeApiError('ZEUS_IM_CONTENT_INTEGRITY_FAILED', 'Snapshot V2 完整正文分页身份或总量不一致。');
              complete += page.text;
              if (page.nextOffset === null) {
                text = complete;
                break;
              }
              if (page.nextOffset <= offset) throw nativeApiError('ZEUS_IM_CONTENT_INTEGRITY_FAILED', 'Snapshot V2 完整正文分页偏移未前进。');
              offset = page.nextOffset;
              if (pageIndex === 16_383) throw nativeApiError('ZEUS_IM_CONTENT_INTEGRITY_FAILED', 'Snapshot V2 完整正文分页超过安全上限。');
            }
          }
          const resources = [];
          let resourceFailures = 0;
          if (item.providerItemId) {
            for (const record of resourceRecords) {
              if (record.itemId !== item.providerItemId || record.turnId !== item.turnId || record.kind === 'website') continue;
              const resource = toConversationResource(record);
              if (!resource || resource.kind === 'website') {
                resourceFailures += 1;
                continue;
              }
              const intent = toConversationResourceOpenIntent(record);
              const absolutePath = typeof intent.target.absolutePath === 'string' ? resolve(intent.target.absolutePath) : '';
              const allowedRoot = typeof intent.authority.allowedRoot === 'string' ? resolve(intent.authority.allowedRoot) : '';
              if (!absolutePath || !allowedRoot || absolutePath === allowedRoot || !isPathInsideRoot(absolutePath, allowedRoot)) {
                resourceFailures += 1;
                continue;
              }
              try {
                const realRoot = realpathSync(allowedRoot);
                const realFile = realpathSync(absolutePath);
                const stats = statSync(realFile);
                if (!isPathInsideRoot(realFile, realRoot) || !stats.isFile() || stats.size > 50 * 1024 * 1024) {
                  resourceFailures += 1;
                  continue;
                }
                const display = intent.display;
                const mime = typeof display.mimeType === 'string' ? display.mimeType : resource.kind === 'attachment' && resource.mimeType ? resource.mimeType : 'application/octet-stream';
                resources.push({ id: record.id, displayName: typeof display.displayName === 'string' ? display.displayName : basename(realFile), mime, localPath: realFile });
              } catch {
                resourceFailures += 1;
              }
            }
          }
          output.push({ id: item.id, sequence: item.sequence, text, resources, resourceFailures });
        }
        return output;
      },
      listPendingRequests: ({ projectId, conversationId }) => {
        const conversation = conversations.getRecordById(conversationId);
        return conversation?.projectId === projectId ? conversationRequests.listPendingByConversation(conversationId) : [];
      },
      getPendingRequest: ({ projectId, conversationId, requestId }) => {
        const conversation = conversations.getRecordById(conversationId);
        const request = conversationRequests.getById(requestId);
        return conversation?.projectId === projectId && request?.conversationId === conversationId && request.status === 'pending' ? request : undefined;
      },
      respondToRequest: async ({ projectId, conversationId, requestId, response, operationIdentity }) => {
        const request = imInternalCommandRequest({
          commandType: conversationDispatchCommandTypes.serverRequestRespond,
          scopeKind: 'approval',
          scopeId: requestId,
          operationIdentity,
          input: response,
          inputSha256: conversationDispatchInputSha256(response),
        });
        const parsed = conversationDispatchCommands.parse<Record<string, unknown>>({ value: request, commandType: conversationDispatchCommandTypes.serverRequestRespond, scopeKind: 'approval', scopeId: requestId });
        await conversationDispatchCommands.executeExternal({
          parsed,
          destinationId: 'conversation-provider-server-request',
          resourceId: requestId,
          externalOperationId: `provider-server-request:${requestId}`,
          invoke: () => executeConversationDispatchRequestResponse({ params: { projectId, conversationId, requestId }, response, operationIdentity }),
          isExplicitRejection: isExplicitConversationStartRejection,
        });
      },
      getPendingPlan: ({ projectId, conversationId }) => {
        const conversation = conversations.getRecordById(conversationId);
        return conversation?.projectId === projectId ? conversationPlanActions.getLatestPending(conversationId) : undefined;
      },
      getPlan: ({ projectId, conversationId, requestId }) => {
        const conversation = conversations.getRecordById(conversationId);
        const plan = conversationPlanActions.getById(requestId);
        return conversation?.projectId === projectId && plan?.conversationId === conversationId ? plan : undefined;
      },
      respondToPlan: async ({ projectId, conversationId, requestId, action, feedback, operationIdentity }) => {
        const conversation = conversations.getRecordById(conversationId);
        const pending = conversationPlanActions.getById(requestId);
        if (!conversation || conversation.projectId !== projectId || !pending || pending.conversationId !== conversationId || pending.status !== 'pending')
          throw nativeApiError('ZEUS_IM_PLAN_REQUEST_NOT_FOUND', 'IM plan request is not pending in the bound project.');
        const input = { action, ...(feedback !== undefined ? { feedback } : {}) };
        const request = imInternalCommandRequest({
          commandType: conversationDispatchCommandTypes.planImplementationRespond,
          scopeKind: 'approval',
          scopeId: requestId,
          operationIdentity,
          input,
          inputSha256: conversationDispatchInputSha256(input),
        });
        const parsed = conversationDispatchCommands.parse<typeof input>({ value: request, commandType: conversationDispatchCommandTypes.planImplementationRespond, scopeKind: 'approval', scopeId: requestId });
        await conversationDispatchCommands.executeExternal({
          parsed,
          destinationId: 'conversation-plan-implementation',
          resourceId: requestId,
          externalOperationId: `plan-implementation-response:${requestId}`,
          invoke: () => codexNativeCoordinator.respondToPlanImplementationRequest({ conversationId, requestId, action, operationIdentity, ...(feedback !== undefined ? { feedback } : {}) }),
          isExplicitRejection: isExplicitConversationStartRejection,
        });
        const accepted = conversationPlanActions.getById(requestId);
        if (!accepted || accepted.conversationId !== conversationId || conversations.getRecordById(conversationId)?.projectId !== projectId)
          throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Plan implementation response was not persisted.');
      },
      listTasks: (projectId) => tasks.listByProject(projectId),
      listTaskManagementStatuses: (projectId) => {
        const config = resolveTaskManagementStatusConfigForProject(projectId);
        return config.statuses.map((status: { id: string; label: string | null }) => ({
          id: status.id,
          label: status.label,
          terminal: status.id === config.roles.completedStatusId || status.id === config.roles.cancelledStatusId,
        }));
      },
      taskRuntimeConversationChoiceRequired: (task) => platformMutableState.runtimeSettings.defaultAdapterId === 'codex' && conversationChoiceQueries.listTaskHistory(task.id, task.projectId).length > 0,
      getTask: (taskId) => tasks.getById(taskId),
      readTaskNotifications: ({ projectId, taskId, afterSequence }) => {
        const task = tasks.getById(taskId);
        if (!task || task.projectId !== projectId) return [];
        return taskEvents.listByTask(taskId).flatMap((event) => {
          const cursor = taskEvents.getProjectionCursor(event.id);
          return cursor && cursor.sequence > afterSequence ? [{ sequence: cursor.sequence, eventType: event.eventType, title: event.title, createdAt: event.createdAt }] : [];
        });
      },
      readTaskAttachments: (task) => {
        let source: Record<string, unknown> = {};
        try {
          const parsed = task.sourceContextJson ? (JSON.parse(task.sourceContextJson) as unknown) : null;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) source = parsed as Record<string, unknown>;
        } catch {
          source = {};
        }
        const rawAttachments = Array.isArray(source.attachments) ? source.attachments : [];
        if (rawAttachments.length === 0) return [];
        if (!taskAttachmentRoot) throw nativeApiError('ZEUS_IM_TASK_ATTACHMENT_ROOT_UNAVAILABLE', '任务附件授权根不可用，已阻止 Telegram 推送。');
        return rawAttachments.map((raw) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw nativeApiError('ZEUS_IM_TASK_ATTACHMENT_INVALID', '任务附件记录无效，已阻止 Telegram 推送。');
          const attachment = raw as Record<string, unknown>;
          const path = typeof attachment.path === 'string' ? resolve(attachment.path) : '';
          const root = resolve(taskAttachmentRoot);
          if (!path || path === root || !isPathInsideRoot(path, root)) throw nativeApiError('ZEUS_IM_TASK_ATTACHMENT_FORBIDDEN', '任务附件不在授权根内，已阻止 Telegram 推送。');
          try {
            const realRoot = realpathSync(root);
            const realFile = realpathSync(path);
            const stats = statSync(realFile);
            if (!isPathInsideRoot(realFile, realRoot) || !stats.isFile() || stats.size > 20 * 1024 * 1024) throw nativeApiError('ZEUS_IM_TASK_ATTACHMENT_FORBIDDEN', '任务附件未通过文件身份或大小校验，已阻止 Telegram 推送。');
            const mime = typeof attachment.mimeType === 'string' ? attachment.mimeType : 'application/octet-stream';
            const name = typeof attachment.name === 'string' && attachment.name.trim() ? attachment.name.trim() : basename(realFile);
            return { name, mime, size: stats.size, localPath: realFile };
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code).startsWith('ZEUS_IM_')) throw error;
            throw nativeApiError('ZEUS_IM_TASK_ATTACHMENT_UNAVAILABLE', '任务附件文件不可用，已阻止 Telegram 推送。');
          }
        });
      },
      createTask: async ({ projectId, title, attachments, operationIdentity }) => {
        const taskId = `task_${createHash('sha256').update(operationIdentity).digest('hex').slice(0, 32)}`;
        const value = {
          projectId,
          title,
          taskType: 'requirement' as const,
          description: '',
          sourceContext: {
            source: 'telegram_im',
            ...(attachments.length
              ? {
                  attachments: attachments.map((attachment) => ({
                    path: attachment.localPath,
                    name: attachment.name,
                    kind: attachment.mime.startsWith('image/') ? ('image' as const) : ('file' as const),
                    field: 'description' as const,
                    mimeType: attachment.mime,
                    size: attachment.size,
                  })),
                }
              : {}),
          },
        };
        const request = imInternalCommandRequest({
          commandType: workManagementCommandTypes.taskCreate,
          scopeKind: 'task',
          scopeId: taskId,
          operationIdentity: taskId,
          input: value,
          inputSha256: workManagementInputSha256(value),
        });
        const parsed = workManagementCommands.parse<typeof value>({ value: request, commandType: workManagementCommandTypes.taskCreate, scopeKind: 'task', expectedScopeId: ({ operationIdentity: identity }) => identity });
        const executed = workManagementCommands.executeCore({
          parsed,
          destinationId: 'work-management-task-application',
          resourceId: taskId,
          mutateBusinessState: () => workManagementCoreOperations.createUserTask(value, taskId, { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, actor: parsed.command.actor }),
        });
        return executed.result;
      },
      updateTask: async ({ task, field, value, attachments, operationIdentity }) => {
        let existingAttachments: TaskAttachmentReference[] = [];
        try {
          const source = task.sourceContextJson ? (JSON.parse(task.sourceContextJson) as unknown) : null;
          if (source && typeof source === 'object' && !Array.isArray(source) && Array.isArray((source as Record<string, unknown>).attachments))
            existingAttachments = (source as Record<string, unknown>).attachments as TaskAttachmentReference[];
        } catch {
          existingAttachments = [];
        }
        const additions: TaskAttachmentReference[] = attachments.map((attachment) => ({
          path: attachment.localPath,
          name: attachment.name,
          kind: attachment.mime.startsWith('image/') ? ('image' as const) : ('file' as const),
          field: 'description',
          mimeType: attachment.mime,
          size: attachment.size,
        }));
        const input = { expectedUpdatedAt: task.updatedAt, [field]: value, ...(additions.length ? { attachments: [...existingAttachments, ...additions] } : {}) };
        const request = imInternalCommandRequest({
          commandType: workManagementCommandTypes.taskUpdate,
          scopeKind: 'task',
          scopeId: task.id,
          operationIdentity,
          input,
          inputSha256: workManagementInputSha256(input),
        });
        const parsed = workManagementCommands.parse<typeof input>({ value: request, commandType: workManagementCommandTypes.taskUpdate, scopeKind: 'task', expectedScopeId: () => task.id });
        return workManagementCommands.executeCore({
          parsed,
          destinationId: 'work-management-task-application',
          resourceId: task.id,
          mutateBusinessState: () => workManagementTaskOperations.updateTask(task.id, input, { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, actor: parsed.command.actor }),
        }).result;
      },
      updateTaskStatus: async ({ task, managementStatus, operationIdentity }) => {
        const input = { status: managementStatus, expectedUpdatedAt: task.updatedAt };
        const request = imInternalCommandRequest({
          commandType: workManagementCommandTypes.taskManagementStatusUpdate,
          scopeKind: 'task',
          scopeId: task.id,
          operationIdentity,
          input,
          inputSha256: workManagementInputSha256(input),
        });
        const parsed = workManagementCommands.parse<typeof input>({ value: request, commandType: workManagementCommandTypes.taskManagementStatusUpdate, scopeKind: 'task', expectedScopeId: () => task.id });
        const prepared = await workManagementTaskOperations.prepareManagementStatus(task.id, input);
        const context = { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, actor: parsed.command.actor };
        if (!prepared.requiresExternal) {
          return workManagementCommands.executeCore({
            parsed,
            destinationId: 'work-management-task-management-status-application',
            resourceId: prepared.resourceId,
            mutateBusinessState: () => workManagementTaskOperations.mutateManagementStatus(prepared.state, null, context),
          }).result;
        }
        return (
          await workManagementCommands.executeExternal({
            parsed,
            destinationId: 'work-management-task-management-status-external',
            resourceId: prepared.resourceId,
            externalOperationId: `task-management-status:${parsed.operationIdentity}`,
            invoke: () => workManagementTaskOperations.invokeManagementStatus(prepared.state),
            mutateAcceptedBusinessState: (effect) => workManagementTaskOperations.mutateManagementStatus(prepared.state, effect, context),
          })
        ).result;
      },
      controlTask: async ({ task, action, operationIdentity }) => {
        const commandType = { run: workManagementCommandTypes.taskRun, pause: workManagementCommandTypes.taskPause, continue: workManagementCommandTypes.taskContinue, cancel: workManagementCommandTypes.taskCancel }[action];
        const value: Record<string, never> = {};
        const request = imInternalCommandRequest({ commandType, scopeKind: 'task', scopeId: task.id, operationIdentity, input: value, inputSha256: workManagementInputSha256(value) });
        const parsed = workManagementCommands.parse<Record<string, never>>({ value: request, commandType, scopeKind: 'task', expectedScopeId: () => task.id });
        const prepared = await workManagementTaskOperations.prepareRuntimeAction(action, task.id);
        if (action === 'run' || action === 'continue') {
          workManagementRuntimePreflights.set(operationIdentity, await prepareWorkManagementRuntimeStart(action, prepared.state.project, tasks.getById(prepared.state.taskId)!));
        }
        const context = { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, actor: parsed.command.actor };
        const executed = await workManagementCommands.executeExternal({
          parsed,
          destinationId: `work-management-task-runtime-${action}`,
          resourceId: prepared.resourceId,
          externalOperationId: `task-runtime-${action}:${operationIdentity}`,
          invoke: () => workManagementTaskOperations.invokeRuntimeAction(action, prepared.state, operationIdentity),
          mutateAcceptedBusinessState: (effect) => workManagementTaskOperations.mutateRuntimeAction(action, prepared.state, effect, context),
          mutateFailureBusinessState: () => workManagementRuntimePreflights.delete(operationIdentity),
        });
        return tasks.getById(task.id) ?? (executed.result as ZeusTaskRecord);
      },
      pushTask: async ({ task, content, preset, operationIdentity }) => {
        const project = projects.getById(task.projectId);
        if (!project) throw nativeApiError('ZEUS_PROJECT_NOT_FOUND', 'Project not found');
        const value: Record<string, unknown> = {
          mode: 'create',
          content,
          agentKind: preset.agentKind,
          permissionMode: preset.permissionMode,
          collaborationMode: preset.workMode,
          clientUserMessageId: stableIdentity('im_client_message', operationIdentity),
          ...(preset.model ? { model: preset.model } : {}),
          ...(preset.reasoningEffort ? { effort: preset.reasoningEffort } : {}),
          ...(preset.skillId ? { skillId: preset.skillId } : {}),
          ...(preset.pluginReferences.length > 0 ? { pluginReferences: preset.pluginReferences } : {}),
        };
        const request = imInternalCommandRequest({ commandType: conversationStartCommandTypes.taskConversationCreate, scopeKind: 'task', scopeId: task.id, operationIdentity, input: value, inputSha256: conversationStartInputSha256(value) });
        const parsed = conversationStartCommands.parse<Record<string, unknown>>({ value: request, commandType: conversationStartCommandTypes.taskConversationCreate, scopeKind: 'task', scopeId: task.id });
        const executed = await conversationStartCommands.executeExternal<Record<string, unknown>, { statusCode: number; body: unknown }>({
          parsed,
          destinationId: 'task-conversation-create',
          resourceId: task.id,
          externalOperationId: `conversation.task.create:${task.id}:${operationIdentity}`,
          invoke: (markExternalWriteStarted) => executeTaskConversationIdempotent(project, task, value, operationIdentity, markExternalWriteStarted),
          isExplicitRejection: isExplicitConversationStartRejection,
        });
        const body = executed.result.body as { conversation?: { id?: unknown } };
        const conversationId = typeof body.conversation?.id === 'string' ? body.conversation.id : '';
        if (!conversationId) throw nativeApiError('ZEUS_IM_CONVERSATION_ACCEPTANCE_INVALID', 'IM task conversation acceptance omitted its durable conversation identity.');
        return { conversationId };
      },
    },
  });

  registerImConnectionRoutes({ server, application: telegramCommands, service: imTelegramService, redactSensitiveText });
  if (!readOnlyValidation)
    void imTelegramService
      .restore()
      .catch((error) =>
        appendAuditLog({ actorType: 'system', action: 'im.telegram.restore_failed', resourceType: 'telegram', payload: { error: redactSensitiveText(error instanceof Error ? error.message : String(error)).text.slice(0, 2_048) } }),
      );
  const automationTasks = new AutomationTaskRepository(db);
  const automationRuns = new AutomationRunRepository(db);

  registerAutomationRoutes({
    server,
    tasks: automationTasks,
    runs: automationRuns,
    db,
    kick: () => automationScheduler?.kick(),
    now,
  });

  registerDigitalEmployeeRoutes({
    server,
    application: workManagementCommands,
    projects,
    tasks,
    taskEvents,
    templates: digitalEmployeeTemplates,
    employees: digitalEmployees,
    automations: digitalEmployeeAutomations,
    executions: digitalEmployeeExecutions,
    projectEvents: digitalEmployeeProjectEvents,
    commandDefinitions: digitalEmployeeCommandDefinitions,
    stages: taskStages,
    conversations,
    taskStageApplication,
    appendAuditLog,
    publishRealtimeEvent,
    isTaskTerminal: taskManagementStatusIsTerminal,
    save: () => db.save(),
    kick: () => digitalEmployeeOrchestrator?.kick(),
  });

  taskWorkManagement = registerTaskWorkManagement({
    server,
    apiToken: options.apiToken,
    application: workManagementCommands,
    projects,
    tasks,
    employees: digitalEmployees,
    legacyExecutions: digitalEmployeeExecutions,
    items: taskWorkItems,
    runs: taskWorkRuns,
    deliverables: taskWorkDeliverables,
    decisions: taskWorkDecisions,
    conversations,
    conversationTurns,
    conversationExecution,
    conversationRequests,
    conversationSubmissions,
    commandDefinitions: digitalEmployeeCommandDefinitions,
    commandRuns,
    artifacts: artifactStore,
    skillSnapshotRoot: join(dataLayout.artifactsDirectory, 'task-work-skill-snapshots'),
    skills: zeusSkillService,
    plugins: zeusPluginService,
    conversationCapabilities: conversationCapabilityQueries,
    normalizeTaskPushSupplementalAttachments,
    executeTaskConversationIdempotent: (project, task, body, idempotencyKey) => executeTaskConversationIdempotent(project, task, body, idempotencyKey),
    isTaskTerminal: taskManagementStatusIsTerminal,
    taskEvents,
    publishRealtimeEvent,
    save: () => db.save(),
    now,
    readOnlyValidation: Boolean(readOnlyValidation),
  });

  if (!readOnlyValidation) {
    automationScheduler = createAutomationScheduler({
      tasks: automationTasks,
      runs: automationRuns,
      conversations,
      submissions: conversationSubmissions,
      getProject: (projectId) => projects.getById(projectId),
      save: () => db.save(),
      now,
      publish: publishRealtimeEvent,
      dispatch: createAutomationConversationDispatch({ conversations, modelConnections, executeConversationDispatchMessage, executeProjectConversationIdempotent }),
    });
    digitalEmployeeOrchestrator = createDigitalEmployeeOrchestrator({
      server,
      apiToken: options.apiToken,
      workManagement: workManagementCommands,
      workspaceGit: workspaceGitCommands,
      workspaceGitOperations: {
        prepare: prepareWorkspaceGitCommand,
        execute: executeWorkspaceGitCommand,
        isExplicitRejection: isWorkspaceGitExplicitRejection,
      },
      employees: digitalEmployees,
      automations: digitalEmployeeAutomations,
      executions: digitalEmployeeExecutions,
      projectEvents: digitalEmployeeProjectEvents,
      projects,
      tasks,
      taskEvents,
      taskIntegrations,
      taskWorkspaces,
      stages: taskStages,
      taskStageApplication,
      conversations,
      conversationSubmissions,
      commandRuns,
      conversationCapabilities: conversationCapabilityQueries,
      taskWorkManagement,
      executeTaskConversationIdempotent: (project, task, body, idempotencyKey) => executeTaskConversationIdempotent(project, task, body, idempotencyKey),
      readTaskWorkspaceSnapshot,
      createTask: (input, taskId, context) => workManagementCoreOperations.createUserTask(input, taskId, context),
      resolveDefaultManagementStatus: (projectId) => resolveTaskManagementStatusConfigForProject(projectId).roles.defaultStatusId,
      resolveCompletedManagementStatus: (projectId) => resolveTaskManagementStatusConfigForProject(projectId).roles.completedStatusId,
      isTaskTerminal: taskManagementStatusIsTerminal,
      appendAuditLog,
      publishRealtimeEvent,
      save: () => db.save(),
      now,
    });
  }

  registerConversationChoiceQueryRoutes({
    server,
    application: conversationChoiceQueries,
  });

  server.get('/api/codex/account', async (_request, reply) => {
    try {
      return await codexAppServerManager.readAccount();
    } catch (error) {
      return sendNativeConversationApiError(reply, error);
    }
  });

  /** 查询本次授权的官方完成结果；不会启动进程或重新发起登录。 */
  server.get('/api/codex/account/login/:loginId', async (request: FastifyRequest<{ Params: { loginId: string }; Querystring: { generationId?: string } }>, reply) => {
    /** 登录身份只接受有界非空文本，避免把无效请求误当成等待中。 */
    const { loginId } = request.params;
    /** 运行实例编号防止重新启动后的旧页面认领新登录。 */
    const { generationId } = request.query;
    if (!loginId.trim() || loginId.length > 200 || typeof generationId !== 'string' || !generationId.trim() || generationId.length > 200) {
      return reply.code(400).send({ error: 'ZEUS_CODEX_LOGIN_ID_INVALID', message: '登录编号和运行实例编号无效。' });
    }
    try {
      return await codexAppServerManager.readChatGptLoginStatus({ loginId, generationId });
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

  // 密码查看沿用本机来源与令牌校验，不进入缓存、命令回执或审计明文。
  server.get('/api/zentao-instances/:instanceId/password', async (request: FastifyRequest<{ Params: { instanceId: string } }>, reply) => {
    reply.header('Cache-Control', 'no-store');
    /** 只有用户主动调用独立读取入口时才获取密码。 */
    const password = await zentaoCredentials.revealPassword(request.params.instanceId);
    appendAuditLog({ actorType: 'local_api', action: 'zentao.instance.password.viewed', resourceType: 'zentao_instance', resourceId: request.params.instanceId, payload: {} });
    return { password };
  });

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
      if (parsed.input.newProjectDefaultModelRef) {
        const models: SelectableConnectionModel[] = await modelConnections.listSelectableModels();
        if (!models.some((model) => model.id === parsed.input.newProjectDefaultModelRef && model.available)) {
          return reply.code(409).send({ error: 'ZEUS_NEW_PROJECT_MODEL_UNAVAILABLE', message: '请选择已保存密钥且已启用的供应商模型。' });
        }
      }
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
      const plannedTelegramNotification = parsed.input.settings.telegramNotification ? normalizeImportedTelegramNotificationSettings(parsed.input.settings.telegramNotification) : null;
      const plannedTelegramSecurity = parsed.input.settings.telegramSecurity ? normalizeImportedTelegramSecuritySettings(parsed.input.settings.telegramSecurity) : null;
      if (parsed.input.settings.runtime && !plannedRuntime) return reply.code(400).send({ error: 'ZEUS_INVALID_SETTINGS_IMPORT', message: 'runtime settings are invalid or unsafe' });
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
      const importedSettings = [plannedAppShell && 'app-shell', plannedRuntime && 'runtime', plannedTelegramNotification && 'telegram-notification', plannedTelegramSecurity && 'telegram-security'].filter(
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
          planned: { appShell: plannedAppShell, runtime: plannedRuntime, telegramNotification: plannedTelegramNotification, telegramSecurity: plannedTelegramSecurity },
        }),
        mutateAcceptedBusinessState: (result) => {
          if (result.planned.appShell) settings.setJson(appShellSettingsKey, result.planned.appShell);
          if (result.planned.runtime) settings.setJson(runtimeSettingsKey, result.planned.runtime);
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

  registerTelegramSettingsRoutes({
    server,
    telegramCommands,
    assertTelegramCommandInputKeys,
    parseTelegramNotificationSettingsInput,
    parseTelegramSecuritySettingsInput,
    parseTelegramDispatchPreviewInput,
    platformMutableState,
    settings,
    telegramNotificationSettingsKey,
    telegramSecuritySettingsKey,
    appendAuditLog,
    readTelegramToken,
    now,
    getTelegramPollingService,
    redactSensitiveText,
    isExplicitTelegramApiRejection,
    sendTelegramCommandRouteError,
    telegramCommandRouteError,
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
    try {
      await automationScheduler?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    automationScheduler = null;
    try {
      await digitalEmployeeOrchestrator?.close();
      await taskWorkManagement?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    digitalEmployeeOrchestrator = null;
    taskWorkManagement = null;
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
      await repositoryDiscovery.close();
      await workManagementTaskEffects.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await imTelegramService.close();
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
  return {
    close: closeLocalServerResources,
    recover: () => {
      if (!readOnlyValidation) {
        workManagementTaskEffects.recover();
        repositoryDiscovery.recover();
      }
    },
    projectGitQueries,
    conversationCapabilityQueries,
    commandCenter,
  };
}
