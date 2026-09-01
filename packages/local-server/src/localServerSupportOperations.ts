import {
    type AiCliAdapterDescriptor,
    type AiRuntimeLogEntry,
    type AiRuntimeSession,
    buildAiRuntimePrompt,
    createAiRuntimeSessionManager,
    createNonCodexAiCliAdapterInvocation,
    expandCliSearchPath,
    isNonCodexAiCliAdapterId,
    listAiCliAdapters,
    type NonCodexAiCliAdapterId,
} from '@zeus/ai-runtime';
import {type ProjectGraph} from '@zeus/graph-engine';
import {createDefaultProjectConfig, normalizeProjectConfig, type ProjectConfigSnapshot} from './projectCore.js';
import {
    buildAutoUpdatePolicy,
    detectReleaseReadiness,
    evaluateReleaseUpdateAvailability,
    parseReleaseUpdateManifest,
    type ReleaseUpdateArtifactArch,
    type ReleaseUpdateManifest,
    type ReleaseUpdateStatus
} from './releaseCore.js';
import {getSecretPresenceLabel, type SecretStore} from '@zeus/security-core';
import {commandNeedsHighRiskConfirmation, isTaskAttachmentField, type TaskAttachmentField} from '@zeus/shared';
import {
    CommandArtifactRepository,
    CommandDefinitionRepository,
    CommandRunRepository,
    ConversationRepository,
    ProjectionDatabaseRuntimeManager,
    ProjectRepository,
    RuntimeSessionRepository,
    SettingRepository,
    TaskEventRepository,
    TaskRepository,
    type ZeusConversationWithMessagesRecord,
    type ZeusProjectRecord,
    type ZeusTaskRecord,
} from '@zeus/storage';
import {type TaskStatus} from './taskCore.js';
import {
    createTelegramBotMessageClient,
    getTelegramConfigurationState,
    type TelegramCommand,
    type TelegramCommandResponse,
    type TelegramMessageSender,
    type TelegramPollingService,
    type TelegramUpdate
} from './telegramAdapter.js';
import {type FastifyInstance, type FastifyRequest} from 'fastify';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join, parse, resolve} from 'node:path';
import {
    emptyGraphSearchResult,
    type GraphEdgeDetail,
    graphEdgeDetailFromGraph,
    graphEdgesByNodeIdFromGraph,
    type GraphNeighborhood,
    graphNeighborhoodFromGraph,
    graphNodeSnapshotFromGraph,
    type GraphSearchResult,
    type GraphViewSnapshot,
    graphViewSnapshotFromGraph,
    readGraphEdgeDetail,
    readGraphEdgesByNodeId,
    readGraphNeighborhood,
    readGraphNodeById,
    readGraphNodeIdsBySourceRef,
    readGraphSummary,
    readGraphSummaryByProject,
    readGraphView,
    searchGraphNodes,
    searchGraphNodesInMemory,
} from './codeIntelligenceGraphStore.js';
import {commandCenterCommandTypes, createCommandCenterCommandRequest} from './commandCenterCommandApplication.js';
import {ConversationChoiceQueryApplication} from './conversationChoiceQueryApplication.js';
import {isPathInsideRoot} from './conversationResourcePreview.js';
import type {
    ProjectDatabaseSecretSnapshot,
    ReleaseStatusSnapshot,
    TelegramDispatchPreviewBody,
    TelegramNotificationSettingsSnapshot,
    TelegramRuntimeConfirmation,
    TelegramSecuritySettingsSnapshot,
    UpdateTelegramNotificationSettingsBody,
    UpdateTelegramSecuritySettingsBody,
} from './index.js';
import {type CodeMapSettingsSnapshot, projectConfigSettingsPrefix} from './localServerSettingsNormalization.js';
import {type WritableNonCodexLegacyConversationContext} from './nonCodexLegacyRuntime.js';
import {sanitizeRuntimeFileName} from './runtimeLogRetention.js';
import {
    assertPersistedRuntimeProcessIdentity,
    discoverPersistedRuntimeProcessTargetByIdentity,
    inspectPersistedRuntimeProcessIdentity,
    isSafeRuntimeProcessId,
    resolvePersistedRuntimeProcessTarget,
    signalPersistedRuntimeProcessTarget,
    waitForPersistedRuntimeProcessTargetExit,
} from './runtimeProcessIdentity.js';
import {
    type RuntimeSettingsSnapshot,
    toAiRuntimeLogEntry,
    toAiRuntimeSession,
    toAiRuntimeSessionOrUndefined
} from './runtimeQueryApplication.js';
import {historicalTaskAttachmentField} from './taskAttachmentLifecycle.js';

export { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor, type ReadOnlyValidationApplicationIdentity } from './readOnlyValidation.js';
// 拆分期间保留结构化工厂依赖，后续按领域端口继续收窄。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LocalServerSupportOperationDependencies = Record<string, any> & {
  aiRuntimeManager: ReturnType<typeof createAiRuntimeSessionManager>;
  commandArtifacts: CommandArtifactRepository;
  commandDefinitions: CommandDefinitionRepository;
  commandRuns: CommandRunRepository;
  conversationChoiceQueries: ConversationChoiceQueryApplication;
  conversations: ConversationRepository;
  isNativeApiRecord(value: unknown): value is Record<string, unknown>;
  now(): Date;
  platformMutableState: {
    codeMapSettings: CodeMapSettingsSnapshot;
    memoryGraphCache: ProjectGraph | null;
    runtimeSettings: RuntimeSettingsSnapshot;
    telegramMessageSender: TelegramMessageSender | undefined;
    telegramNotificationSettings: TelegramNotificationSettingsSnapshot;
    telegramPollingService: TelegramPollingService | undefined;
    telegramSecuritySettings: TelegramSecuritySettingsSnapshot;
  };
  projectionDatabases: ProjectionDatabaseRuntimeManager;
  projects: ProjectRepository;
  runtimeSessions: RuntimeSessionRepository;
  secretStore: SecretStore;
  server: FastifyInstance;
  settings: SettingRepository;
  taskEvents: TaskEventRepository;
  tasks: TaskRepository;
};

export function normalizeTelegramNotificationSettings(value: TelegramNotificationSettingsSnapshot | undefined, fallback: TelegramNotificationSettingsSnapshot): TelegramNotificationSettingsSnapshot {
  if (!value || !Array.isArray(value.chatIds)) return fallback;
  const seenChatIds = new Set<number>();
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    chatIds: value.chatIds.filter((chatId) => {
      if (!Number.isInteger(chatId) || chatId <= 0 || seenChatIds.has(chatId)) return false;
      seenChatIds.add(chatId);
      return true;
    }),
    silentMode: typeof value.silentMode === 'boolean' ? value.silentMode : fallback.silentMode,
  };
}

export function normalizeTelegramSecuritySettings(value: TelegramSecuritySettingsSnapshot | undefined, fallback: TelegramSecuritySettingsSnapshot): TelegramSecuritySettingsSnapshot {
  const source = Array.isArray(value?.allowedUserIds) ? value.allowedUserIds : fallback.allowedUserIds;
  const seen = new Set<number>();
  return {
    allowedUserIds: source.filter((userId) => {
      if (!Number.isInteger(userId) || userId <= 0 || seen.has(userId)) return false;
      seen.add(userId);
      return true;
    }),
  };
}

export function createLocalServerSupportOperations(dependencies: LocalServerSupportOperationDependencies) {
  const {
    NON_CODEX_LEGACY_HISTORY_LIMIT,
    aiRuntimeManager,
    appendAuditLog,
    commandArtifacts,
    commandDefinitions,
    commandRuns,
    conversationChoiceQueries,
    conversations,
    dataLayout,
    db,
    findProjectByRef,
    formatTelegramGraphAsk,
    formatTelegramTaskDiff,
    formatTelegramTaskLogs,
    isNativeApiRecord,
    moveTaskToCancelled,
    moveTaskToWaitingConfirmation,
    moveTaskTowardRunning,
    nativeApiError,
    now,
    options,
    parseTaskSourceContext,
    parseTelegramLogsArgs,
    platformMutableState,
    projectRoot,
    projectionDatabases,
    projects,
    publishRealtimeEvent,
    publishRuntimeSessionEvent,
    recordTaskEvent,
    releaseEnvironment,
    releaseUpdateManifestUrl,
    resolveRegisteredRuntimeAdapter,
    runtimeSessions,
    secretStore,
    server,
    settings,
    startTaskNativeConversation,
    taskEvents,
    tasks,
    telegramCommandRunLogCounts,
    telegramCommandRunMessages,
    telegramConfirmationTtlMs,
    telegramRuntimeConfirmations,
    telegramRuntimeSummaryLogInterval,
    telegramRuntimeSummarySentLogCounts,
  } = dependencies;
  async function readTelegramToken(): Promise<string | undefined> {
    return options.telegramToken ?? (await secretStore.getSecret('telegram.botToken'));
  }

  async function sendTelegramNotificationOnce(sender: TelegramMessageSender, chatId: number, text: string): Promise<{ attempts: 1 }> {
    // 超时无法证明 Telegram 是否已接纳，因此后台通知也只写出一次，禁止盲目重复发送。
    await sender.sendMessage(chatId, text);
    return { attempts: 1 };
  }

  function extractTelegramNotificationAttempts(error: unknown): number {
    if (typeof error === 'object' && error !== null && 'attempts' in error && typeof error.attempts === 'number') {
      return error.attempts;
    }
    return 1;
  }

  async function notifyTelegramRuntimeProgressSummary(log: AiRuntimeLogEntry): Promise<void> {
    const session = aiRuntimeManager.getSession(log.sessionId) ?? toAiRuntimeSessionOrUndefined(runtimeSessions.getById(log.sessionId));
    if (!session?.taskId) return;
    if (session.status !== 'running') return;
    if (!platformMutableState.telegramNotificationSettings.enabled || platformMutableState.telegramNotificationSettings.silentMode) return;
    const token = await readTelegramToken();
    const chatIds = platformMutableState.telegramNotificationSettings.chatIds;
    if (!token || chatIds.length === 0) return;
    const logCount = runtimeSessions.searchLogs(log.sessionId, { limit: 1 }).total;
    if (logCount === 0 || logCount % telegramRuntimeSummaryLogInterval !== 0) return;
    const sentCounts = telegramRuntimeSummarySentLogCounts.get(log.sessionId) ?? new Set<number>();
    if (sentCounts.has(logCount)) return;
    sentCounts.add(logCount);
    telegramRuntimeSummarySentLogCounts.set(log.sessionId, sentCounts);

    const task = tasks.getById(session.taskId);
    if (!task) return;
    const recentLogs = runtimeSessions
      .listRecentLogs(log.sessionId, telegramRuntimeSummaryLogInterval)
      .map((entry) => `${entry.stream}: ${entry.text}`)
      .join('\n')
      .slice(0, 1200);
    const text = ['Zeus Runtime 阶段摘要', `任务：${task.title} (${task.id})`, `会话：${session.id}`, `日志数：${logCount}`, '最近真实日志：', recentLogs].join('\n');
    const sender = createTelegramBotMessageClient({ token });
    try {
      const results = await Promise.all(chatIds.map((chatId) => sendTelegramNotificationOnce(sender, chatId, text)));
      recordTaskEvent({
        taskId: task.id,
        eventType: 'telegram.runtime.summary.sent',
        title: 'Telegram Runtime 阶段摘要已发送',
        payload: {
          runtimeSessionId: session.id,
          logCount,
          chatIds,
          attempts: Math.max(...results.map((result) => result.attempts)),
        },
      });
    } catch (error) {
      recordTaskEvent({
        taskId: task.id,
        eventType: 'telegram.runtime.summary.failed',
        title: 'Telegram Runtime 阶段摘要发送失败',
        payload: {
          runtimeSessionId: session.id,
          logCount,
          attempts: extractTelegramNotificationAttempts(error),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    await db.save();
  }

  function telegramTaskNotificationTitle(status: TaskStatus): string | undefined {
    const titles: Partial<Record<TaskStatus, string>> = {
      running: '任务开始',
      waiting_confirmation: '任务等待确认',
      completed: '任务完成',
      failed: '任务失败',
      cancelled: '任务取消',
    };
    return titles[status];
  }

  function isCriticalTelegramTaskStatus(status: TaskStatus): boolean {
    return status === 'waiting_confirmation' || status === 'failed';
  }

  function assertTelegramCommandInputKeys(value: object, allowedKeys: readonly string[]): void {
    const allowed = new Set(allowedKeys);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw telegramCommandRouteError('ZEUS_TELEGRAM_COMMAND_INVALID', 'Telegram command input contains unsupported fields.', 400);
  }

  function parseTelegramNotificationSettingsInput(value: UpdateTelegramNotificationSettingsBody, fallback: TelegramNotificationSettingsSnapshot): TelegramNotificationSettingsSnapshot {
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw telegramCommandRouteError('ZEUS_INVALID_TELEGRAM_NOTIFICATION_SETTINGS', 'Telegram enabled must be a boolean.', 400);
    if (value.silentMode !== undefined && typeof value.silentMode !== 'boolean') throw telegramCommandRouteError('ZEUS_INVALID_TELEGRAM_NOTIFICATION_SETTINGS', 'Telegram silentMode must be a boolean.', 400);
    if (value.chatIds !== undefined && (!Array.isArray(value.chatIds) || value.chatIds.length > 256 || !value.chatIds.every((chatId) => Number.isSafeInteger(chatId) && chatId > 0))) {
      throw telegramCommandRouteError('ZEUS_INVALID_TELEGRAM_NOTIFICATION_SETTINGS', 'Telegram chatIds must contain at most 256 positive safe integers.', 400);
    }
    return normalizeTelegramNotificationSettings(
      {
        enabled: value.enabled ?? fallback.enabled,
        chatIds: value.chatIds ?? fallback.chatIds,
        silentMode: value.silentMode ?? fallback.silentMode,
      },
      fallback,
    );
  }

  function parseTelegramSecuritySettingsInput(value: UpdateTelegramSecuritySettingsBody, fallback: TelegramSecuritySettingsSnapshot): TelegramSecuritySettingsSnapshot {
    if (value.allowedUserIds !== undefined && (!Array.isArray(value.allowedUserIds) || value.allowedUserIds.length > 256 || !value.allowedUserIds.every((userId) => Number.isSafeInteger(userId) && userId > 0))) {
      throw telegramCommandRouteError('ZEUS_INVALID_TELEGRAM_SECURITY_SETTINGS', 'Telegram allowedUserIds must contain at most 256 positive safe integers.', 400);
    }
    return normalizeTelegramSecuritySettings({ allowedUserIds: value.allowedUserIds ?? fallback.allowedUserIds }, fallback);
  }

  function parseTelegramDispatchPreviewInput(value: TelegramDispatchPreviewBody): TelegramUpdate {
    assertTelegramCommandInputKeys(value as unknown as Record<string, unknown>, ['updateId', 'chatId', 'userId', 'text', 'messageId', 'callbackQueryId', 'callbackData']);
    if (!Number.isSafeInteger(value.updateId) || !Number.isSafeInteger(value.chatId) || !Number.isSafeInteger(value.userId) || typeof value.text !== 'string' || value.text.length === 0 || value.text.length > 4_096) {
      throw telegramCommandRouteError('ZEUS_INVALID_TELEGRAM_UPDATE', 'Telegram update payload is invalid or exceeds the 4096 character preview budget.', 400);
    }
    if (value.messageId !== undefined && !Number.isSafeInteger(value.messageId)) throw telegramCommandRouteError('ZEUS_INVALID_TELEGRAM_UPDATE', 'Telegram messageId must be a safe integer.', 400);
    if (value.callbackQueryId !== undefined && (typeof value.callbackQueryId !== 'string' || value.callbackQueryId.length > 256)) throw telegramCommandRouteError('ZEUS_INVALID_TELEGRAM_UPDATE', 'Telegram callbackQueryId is invalid.', 400);
    if (value.callbackData !== undefined && (typeof value.callbackData !== 'string' || Buffer.byteLength(value.callbackData, 'utf8') > 64))
      throw telegramCommandRouteError('ZEUS_INVALID_TELEGRAM_UPDATE', 'Telegram callbackData exceeds 64 bytes.', 400);
    return value;
  }

  function telegramCommandRouteError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
    return Object.assign(new Error(message), { code, statusCode });
  }

  function isExplicitTelegramApiRejection(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { dispatchDisposition?: unknown }).dispatchDisposition === 'explicitly_rejected');
  }

  function normalizeImportedTelegramNotificationSettings(value: TelegramNotificationSettingsSnapshot | undefined): TelegramNotificationSettingsSnapshot | null {
    if (!value || !Array.isArray(value.chatIds)) return null;
    if (!value.chatIds.every((chatId) => Number.isInteger(chatId) && chatId > 0)) return null;
    // Telegram 通知导入只恢复 chat id、启用状态和静默状态；Bot Token 仍必须留在 Keychain，不进入快照。
    return normalizeTelegramNotificationSettings(value, platformMutableState.telegramNotificationSettings);
  }

  function normalizeImportedTelegramSecuritySettings(value: TelegramSecuritySettingsSnapshot | undefined): TelegramSecuritySettingsSnapshot | null {
    if (!value || !Array.isArray(value.allowedUserIds)) return null;
    if (!value.allowedUserIds.every((userId) => Number.isInteger(userId) && userId > 0)) return null;
    // 白名单是远程执行安全边界，允许通过脱敏设置快照迁移，但不接受非正整数或其它权限字段。
    return normalizeTelegramSecuritySettings(value, platformMutableState.telegramSecuritySettings);
  }

  function getProjectDatabasePasswordSecretKey(projectId: string): { key: string; connectionName: string } | null {
    const connectionName = readProjectConfig(projectId).database.connectionName?.trim();
    if (!connectionName) return null;
    // Secret key 包含项目和连接名，避免不同项目的同名连接互相覆盖；连接名经过文件名同款清洗，不写入密码值。
    return {
      key: `project.${projectId}.database.${sanitizeRuntimeFileName(connectionName)}.password`,
      connectionName,
    };
  }

  async function readProjectDatabaseSecretSnapshot(projectId: string): Promise<ProjectDatabaseSecretSnapshot> {
    const secretKey = getProjectDatabasePasswordSecretKey(projectId);
    if (!secretKey)
      return {
        connectionName: null,
        password: getSecretPresenceLabel(undefined),
      };
    return {
      connectionName: secretKey.connectionName,
      password: getSecretPresenceLabel(await secretStore.getSecret(secretKey.key)),
    };
  }

  function readProjectConfig(projectId: string): ProjectConfigSnapshot {
    const fallback = createDefaultProjectConfig(projectId);
    const stored = settings.getJson<ProjectConfigSnapshot>(projectConfigSettingsPrefix + projectId);
    return normalizeProjectConfig(projectId, stored, fallback) ?? fallback;
  }

  function buildRuntimeProcessEnv(): NodeJS.ProcessEnv {
    const shellEnv: NodeJS.ProcessEnv = platformMutableState.runtimeSettings.shell.path
      ? {
          SHELL: platformMutableState.runtimeSettings.shell.path,
          ZEUS_SHELL_LOGIN: platformMutableState.runtimeSettings.shell.login ? '1' : '0',
        }
      : { ZEUS_SHELL_LOGIN: platformMutableState.runtimeSettings.shell.login ? '1' : '0' };
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...platformMutableState.runtimeSettings.terminalEnv,
      ZEUS_RUNTIME_TIMEOUT_SECONDS: String(platformMutableState.runtimeSettings.executionTimeoutSeconds),
      ...(platformMutableState.runtimeSettings.adapterCliPaths.codex ? { ZEUS_CODEX_COMMAND_PATH: platformMutableState.runtimeSettings.adapterCliPaths.codex } : {}),
      ...shellEnv,
    };
    return {
      ...mergedEnv,
      PATH: expandCliSearchPath(mergedEnv.PATH),
    };
  }

  function readCurrentGraphSummary(): {
    nodeCount: number;
    edgeCount: number;
    viewCount: number;
  } {
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'memory' && platformMutableState.memoryGraphCache) {
      return {
        nodeCount: platformMutableState.memoryGraphCache.nodes.length,
        edgeCount: platformMutableState.memoryGraphCache.edges.length,
        viewCount: platformMutableState.memoryGraphCache.views.length,
      };
    }
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'disabled') {
      return { nodeCount: 0, edgeCount: 0, viewCount: 0 };
    }
    return readGraphSummary(projectionDatabases.index);
  }

  function readCurrentGraphSummaryByProject(projectName: string): {
    nodeCount: number;
    edgeCount: number;
    viewCount: number;
  } {
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'memory' && platformMutableState.memoryGraphCache) {
      if (platformMutableState.memoryGraphCache.projectName !== projectName) {
        return { nodeCount: 0, edgeCount: 0, viewCount: 0 };
      }
      return {
        nodeCount: platformMutableState.memoryGraphCache.nodes.length,
        edgeCount: platformMutableState.memoryGraphCache.edges.length,
        viewCount: platformMutableState.memoryGraphCache.views.length,
      };
    }
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'disabled') {
      return { nodeCount: 0, edgeCount: 0, viewCount: 0 };
    }
    return readGraphSummaryByProject(projectionDatabases.index, projectName);
  }

  function resolveGraphProjectName(project: ZeusProjectRecord): string {
    // 项目级图谱缓存必须使用不可变项目 id 作为隔离键；项目名称可重名、可改名，不能用来决定要读哪一套真实图谱。
    return project.id;
  }

  function resolveGraphProjectReadKeys(project: ZeusProjectRecord): string[] {
    const primaryKey = resolveGraphProjectName(project);
    // 兼容旧版全局 Zeus 图谱和历史缓存：先读项目 id 新缓存，读不到时只回退项目显示名，非同名项目不会吃到 Zeus 全局图谱。
    return project.name && project.name !== primaryKey ? [primaryKey, project.name] : [primaryKey];
  }

  function readCurrentGraphSummaryForProject(project: ZeusProjectRecord): { graphProjectName: string; summary: { nodeCount: number; edgeCount: number; viewCount: number } } {
    const [primaryKey, ...fallbackKeys] = resolveGraphProjectReadKeys(project);
    const primarySummary = readCurrentGraphSummaryByProject(primaryKey);
    if (primarySummary.nodeCount > 0 || primarySummary.edgeCount > 0 || primarySummary.viewCount > 0) {
      return { graphProjectName: primaryKey, summary: primarySummary };
    }
    for (const fallbackKey of fallbackKeys) {
      const fallbackSummary = readCurrentGraphSummaryByProject(fallbackKey);
      if (fallbackSummary.nodeCount > 0 || fallbackSummary.edgeCount > 0 || fallbackSummary.viewCount > 0) {
        return { graphProjectName: fallbackKey, summary: fallbackSummary };
      }
    }
    return { graphProjectName: primaryKey, summary: primarySummary };
  }

  function readCurrentGraphNodeByIdForProject(nodeId: string, project: ZeusProjectRecord): { graphProjectName: string; node: GraphViewSnapshot['nodes'][number] } | undefined {
    for (const graphProjectName of resolveGraphProjectReadKeys(project)) {
      const node = readCurrentGraphNodeById(nodeId, graphProjectName);
      if (node) return { graphProjectName, node };
    }
    return undefined;
  }

  function readCurrentGraphViewForProject(viewType: string, project: ZeusProjectRecord): { graphProjectName: string; view: GraphViewSnapshot } | undefined {
    for (const graphProjectName of resolveGraphProjectReadKeys(project)) {
      const view = readCurrentGraphView(viewType, graphProjectName);
      if (view) return { graphProjectName, view };
    }
    return undefined;
  }

  function searchCurrentGraphNodesForProject(project: ZeusProjectRecord, rawQuery: string, nodeType?: string, edgeType?: string, rawMinConfidence?: string): { graphProjectName: string; result: GraphSearchResult } {
    const [primaryKey, ...fallbackKeys] = resolveGraphProjectReadKeys(project);
    const primaryResult = searchCurrentGraphNodes(rawQuery, nodeType, edgeType, rawMinConfidence, primaryKey);
    if (primaryResult.nodes.length > 0 || primaryResult.edges.length > 0) return { graphProjectName: primaryKey, result: primaryResult };
    for (const fallbackKey of fallbackKeys) {
      const fallbackResult = searchCurrentGraphNodes(rawQuery, nodeType, edgeType, rawMinConfidence, fallbackKey);
      if (fallbackResult.nodes.length > 0 || fallbackResult.edges.length > 0) return { graphProjectName: fallbackKey, result: fallbackResult };
    }
    return { graphProjectName: primaryKey, result: primaryResult };
  }

  function formatProjectScopedGraphViewTitle(view: Pick<GraphViewSnapshot, 'title' | 'viewType'>, projectName: string): string {
    // 项目级接口即使兼容读取旧全局当前仓库图谱，展示标题也必须跟随当前项目；
    // 否则用户切到 tc-app-core 仍看到 “Zeus 系统架构图”，会误判事实来源。
    const suffixByViewType: Record<string, string> = {
      architecture: '系统架构图',
      module: '模块图',
      table: '表关系图',
      module_detail: '模块详情图',
      api_sequence: '接口时序图',
      module_flow: '模块流程图',
      method_logic: '方法逻辑图',
    };
    const suffix = suffixByViewType[view.viewType];
    return suffix ? `${projectName} ${suffix}` : view.title;
  }

  function resolveGraphProjectNameByProjectId(projectId: string): string | undefined {
    const project = projects.getById(projectId);
    return project ? resolveGraphProjectName(project) : undefined;
  }

  function readCurrentGraphView(viewType: string, projectName?: string): GraphViewSnapshot | undefined {
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'memory') {
      if (!platformMutableState.memoryGraphCache || (projectName && platformMutableState.memoryGraphCache.projectName !== projectName)) return undefined;
      return graphViewSnapshotFromGraph(platformMutableState.memoryGraphCache, viewType);
    }
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'disabled') return undefined;
    return readGraphView(projectionDatabases.index, viewType, projectName);
  }

  function attachGraphViewPerformance(view: GraphViewSnapshot, startedAt: number): GraphViewSnapshot {
    if (!platformMutableState.codeMapSettings.performanceMonitoringEnabled) return view;
    // 性能监控只记录本次真实图谱视图读取耗时和真实节点/边数量，不生成虚假的历史趋势数据。
    return {
      ...view,
      performance: {
        durationMs: Math.max(0, Date.now() - startedAt),
        nodeCount: view.nodes.length,
        edgeCount: view.edges.length,
      },
    };
  }

  function searchCurrentGraphNodes(rawQuery: string, nodeType?: string, edgeType?: string, rawMinConfidence?: string, projectName?: string): GraphSearchResult {
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'memory') {
      return platformMutableState.memoryGraphCache && (!projectName || platformMutableState.memoryGraphCache.projectName === projectName)
        ? searchGraphNodesInMemory(platformMutableState.memoryGraphCache, rawQuery, nodeType, edgeType, rawMinConfidence)
        : emptyGraphSearchResult(rawQuery, nodeType, edgeType, rawMinConfidence);
    }
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'disabled') {
      return emptyGraphSearchResult(rawQuery, nodeType, edgeType, rawMinConfidence);
    }
    return searchGraphNodes(projectionDatabases.index, rawQuery, nodeType, edgeType, rawMinConfidence, projectName);
  }

  function readCurrentGraphNodeById(nodeId: string, projectName?: string): GraphViewSnapshot['nodes'][number] | undefined {
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'memory') {
      return platformMutableState.memoryGraphCache && (!projectName || platformMutableState.memoryGraphCache.projectName === projectName) ? graphNodeSnapshotFromGraph(platformMutableState.memoryGraphCache, nodeId) : undefined;
    }
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'disabled') return undefined;
    return readGraphNodeById(projectionDatabases.index, nodeId, projectName);
  }

  function readCurrentGraphNodeIdsBySourceRef(sourceRef: string, graphRoot = projectRoot): string[] {
    const sourceRefCandidates = Array.from(new Set([sourceRef, resolve(graphRoot, sourceRef)]));
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'memory') {
      // Git Diff 通常返回仓库相对路径，图谱扫描保存绝对路径；同时匹配两种口径但不做模糊匹配，避免误关联。
      return platformMutableState.memoryGraphCache
        ? platformMutableState.memoryGraphCache.nodes
            .filter((node) => sourceRefCandidates.includes(node.sourceRef))
            .map((node) => node.id)
            .sort()
        : [];
    }
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'disabled') return [];
    // Diff API 必须能独立使用；尚未扫描图谱时先创建空表，返回空关联而不是让审计快照失败。
    return sourceRefCandidates.flatMap((candidate) => readGraphNodeIdsBySourceRef(projectionDatabases.index, candidate)).sort();
  }

  function readCurrentGraphEdgesByNodeId(nodeId: string, projectName?: string): GraphViewSnapshot['edges'] {
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'memory') {
      return platformMutableState.memoryGraphCache && (!projectName || platformMutableState.memoryGraphCache.projectName === projectName) ? graphEdgesByNodeIdFromGraph(platformMutableState.memoryGraphCache, nodeId, 20) : [];
    }
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'disabled') return [];
    return readGraphEdgesByNodeId(projectionDatabases.index, nodeId, projectName);
  }

  function readCurrentGraphEdgeDetail(edgeId: string): GraphEdgeDetail | undefined {
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'memory') {
      return platformMutableState.memoryGraphCache ? graphEdgeDetailFromGraph(platformMutableState.memoryGraphCache, edgeId) : undefined;
    }
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'disabled') return undefined;
    return readGraphEdgeDetail(projectionDatabases.index, edgeId);
  }

  function readCurrentGraphNeighborhood(nodeId: string, depth: number, projectName?: string): GraphNeighborhood | undefined {
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'memory') {
      return platformMutableState.memoryGraphCache && (!projectName || platformMutableState.memoryGraphCache.projectName === projectName) ? graphNeighborhoodFromGraph(platformMutableState.memoryGraphCache, nodeId, depth) : undefined;
    }
    if (platformMutableState.codeMapSettings.graphCacheStrategy === 'disabled') return undefined;
    return readGraphNeighborhood(projectionDatabases.index, nodeId, depth, projectName);
  }

  function markRuntimeSessionConversationsInactive(session: Pick<AiRuntimeSession, 'id' | 'status' | 'endedAt' | 'exitCode'>): void {
    if (session.status === 'running') return;
    const summary = formatRuntimeSessionConversationSummary(session);
    for (const conversation of conversations.listRecordsBySessionId(session.id)) {
      if (conversation.status === session.status && conversation.summary === summary) continue;
      conversations.updateRuntimeState(conversation.id, {
        status: session.status,
        summary,
      });
    }
  }

  function formatRuntimeSessionConversationSummary(session: Pick<AiRuntimeSession, 'id' | 'status' | 'endedAt' | 'exitCode'>): string {
    const suffix = session.endedAt ? ` · ${session.endedAt}` : '';
    switch (session.status) {
      case 'exited':
        return `Runtime 会话 ${session.id} 已退出${typeof session.exitCode === 'number' ? `，exitCode=${session.exitCode}` : ''}${suffix}`;
      case 'failed':
        return `Runtime 会话 ${session.id} 已失败${suffix}`;
      case 'stopped':
        return `Runtime 会话 ${session.id} 已停止${suffix}`;
      case 'orphan_detected':
        return `Runtime 会话 ${session.id} 已变为孤儿进程，请续接或终止${suffix}`;
      case 'lost':
        return `Runtime 会话 ${session.id} 已丢失，请续接新 Runtime${suffix}`;
      default:
        return `Runtime 会话 ${session.id} 状态：${session.status}${suffix}`;
    }
  }

  function persistRuntimeConversationSummary(sessionId: string): void {
    const page = runtimeSessions.searchLogs(sessionId, {
      tail: true,
      limit: 2_000,
      byteBudget: 4 * 1024 * 1024,
    });
    const logs = page.items.map(toAiRuntimeLogEntry).filter((log) => log.stream === 'stdout' || log.stream === 'stderr');
    for (const conversation of conversations.listRecordsBySessionId(sessionId)) {
      if (!conversation.taskId) continue;
      for (const stream of ['stdout', 'stderr'] as const) {
        const streamLogs = logs.filter((log) => log.stream === stream);
        if (streamLogs.length === 0) continue;
        conversations.appendMessage({
          conversationId: conversation.id,
          role: stream === 'stdout' ? 'assistant' : 'system',
          content: streamLogs.map((log) => log.text).join(''),
          source: stream === 'stdout' ? 'runtime_stdout_summary' : 'runtime_stderr_summary',
          metadata: {
            sessionId,
            stream,
            runtimeSummary: true,
            logsTruncated: page.truncated,
            logCount: streamLogs.length,
          },
          createdAt: streamLogs.at(-1)?.createdAt ?? new Date().toISOString(),
          providerThreadId: sessionId,
          providerItemId: `${sessionId}-runtime-${stream}-summary`,
        });
      }
      if (page.truncated) {
        conversations.appendMessage({
          conversationId: conversation.id,
          role: 'system',
          content: 'Runtime 输出超过会话展示上限，仅保存最近约 4MB 摘要；完整历史请查看 Runtime 日志。',
          source: 'runtime_log_projection',
          metadata: { sessionId, runtimeSummary: true, logsTruncated: true },
          createdAt: logs.at(-1)?.createdAt ?? new Date().toISOString(),
          providerThreadId: sessionId,
          providerItemId: `${sessionId}-runtime-projection-summary`,
        });
      }
    }
  }

  async function stopPersistedOrphanRuntimeSession(sessionId: string): Promise<AiRuntimeSession | null> {
    const existing = runtimeSessions.getById(sessionId);
    if (!existing || existing.status !== 'orphan_detected') return null;
    if (!isSafeRuntimeProcessId(existing.pid) || existing.pid === process.pid || existing.pid === process.ppid) {
      throw new Error(`Runtime 孤儿会话 ${sessionId} 缺少可安全终止的进程标识，已保留 orphan_detected 状态。`);
    }

    const target = resolvePersistedRuntimeProcessTarget(existing.pid);
    if (target) {
      assertPersistedRuntimeProcessIdentity(target, existing.processIdentityToken, sessionId);
      try {
        signalPersistedRuntimeProcessTarget(target, 'SIGTERM');
      } catch (error) {
        throw new Error(`Runtime 孤儿进程树 ${existing.pid} 无法接收 SIGTERM，已保留 orphan_detected 状态：${error instanceof Error ? error.message : String(error)}`);
      }
      let exited = await waitForPersistedRuntimeProcessTargetExit(target, 5_000);
      if (!exited) {
        // TERM 等待期间原进程树可能退出且相同 PGID 被复用；强杀前必须重新核验随机出生身份。
        assertPersistedRuntimeProcessIdentity(target, existing.processIdentityToken, sessionId);
        try {
          signalPersistedRuntimeProcessTarget(target, 'SIGKILL');
        } catch (error) {
          throw new Error(`Runtime 孤儿进程树 ${existing.pid} 无法接收 SIGKILL，已保留 orphan_detected 状态：${error instanceof Error ? error.message : String(error)}`);
        }
        exited = await waitForPersistedRuntimeProcessTargetExit(target, 5_000);
      }
      if (!exited) {
        assertPersistedRuntimeProcessIdentity(target, existing.processIdentityToken, sessionId);
        throw new Error(`Runtime 孤儿进程树 ${existing.pid} 在强制终止后仍存活，已保留 orphan_detected 状态。`);
      }
    }

    const stopped = runtimeSessions.updateStatus(sessionId, {
      status: 'stopped',
      exitCode: existing.exitCode,
      endedAt: new Date().toISOString(),
      pid: existing.pid,
    });
    runtimeSessions.appendLog({
      id: `${sessionId}-orphan-stop-${randomUUID()}`,
      sessionId,
      stream: 'system',
      text: `已确认终止 orphan_detected Runtime 会话进程树 PID ${existing.pid}`,
      createdAt: new Date().toISOString(),
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'runtime.session.stopped',
      resourceType: 'runtime_session',
      resourceId: stopped.id,
      payload: {
        sessionId: stopped.id,
        projectId: stopped.projectId,
        taskId: stopped.taskId,
        status: stopped.status,
        pid: existing.pid,
        source: 'orphan_detected',
      },
    });
    const session = toAiRuntimeSession(stopped);
    markRuntimeSessionConversationsInactive(session);
    publishRuntimeSessionEvent('runtime.session.stopped', session, {
      source: 'orphan_detected',
    });
    return session;
  }

  async function recoverPersistedRuntimeSessions(): Promise<void> {
    let changed = false;
    for (const session of runtimeSessions.listUnfinishedForRecovery()) {
      const pid = session.pid;
      const hasPersistedProcessId = isSafeRuntimeProcessId(pid);
      const discovery = hasPersistedProcessId ? null : discoverPersistedRuntimeProcessTargetByIdentity(session.processIdentityToken);
      const target = hasPersistedProcessId ? resolvePersistedRuntimeProcessTarget(pid) : discovery?.target;
      const recoveredPid = target?.pid ?? pid;
      const identity = target ? inspectPersistedRuntimeProcessIdentity(target, session.processIdentityToken) : null;
      // 只要同 PGID 仍存在就保留 orphan；PID 从未落盘时也不能仅凭 token 扫描未命中断言进程不存在。
      const status = target || !hasPersistedProcessId ? 'orphan_detected' : 'lost';
      const message =
        status === 'lost'
          ? 'Runtime 会话恢复状态：lost，原进程树不存在，已保留已收集日志。'
          : identity === 'verified'
            ? discovery?.state === 'found'
              ? 'Runtime 会话恢复状态：orphan_detected，已通过持久身份找回 spawn 后未及时落盘的进程组，请重新附着或终止。'
              : 'Runtime 会话恢复状态：orphan_detected，原进程树仍存在且身份已核验，请重新附着或终止。'
            : identity === 'mismatch'
              ? 'Runtime 会话恢复状态：orphan_detected，同 PGID 仍存在但身份 token 未命中；可能是环境已被清理或 PID 复用，为避免误杀，停止操作将保持 fail-closed。'
              : !hasPersistedProcessId
                ? 'Runtime 会话恢复状态：orphan_detected，spawn 后 PID 未完整落盘且未能找回唯一进程组；为避免漏掉后台进程或误杀，停止操作将保持 fail-closed。'
                : 'Runtime 会话恢复状态：orphan_detected，原进程树可能仍存在但缺少可核验身份；为避免误杀，停止操作将保持 fail-closed。';
      const wasHidden = session.archived || session.deletedAt !== null;
      const pidRecovered = recoveredPid !== pid;
      if (session.status === status && !wasHidden && !pidRecovered) continue;
      let recovered = runtimeSessions.updateStatus(session.id, {
        status,
        exitCode: session.exitCode,
        endedAt: status === 'orphan_detected' ? session.endedAt : new Date().toISOString(),
        pid: recoveredPid,
      });
      if (status === 'orphan_detected' && wasHidden) recovered = runtimeSessions.restoreForRecovery(session.id);
      markRuntimeSessionConversationsInactive(toAiRuntimeSession(recovered));
      runtimeSessions.appendLog({
        id: `${session.id}-recovery-${randomUUID()}`,
        sessionId: session.id,
        stream: 'system',
        text: message,
        createdAt: new Date().toISOString(),
      });
      if (session.taskId) {
        // App 重启后的会话恢复状态同步写入任务时间线，方便用户从任务详情追溯真实运行态。
        recordTaskEvent({
          taskId: session.taskId,
          eventType: 'runtime.session.recovered',
          title: 'Runtime 会话恢复状态',
          payload: {
            sessionId: session.id,
            from: session.status,
            to: recovered.status,
            pid: recoveredPid ?? null,
            message,
          },
        });
      }
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.recovered',
        resourceType: 'runtime_session',
        resourceId: session.id,
        payload: {
          sessionId: session.id,
          from: session.status,
          to: recovered.status,
          pid: recoveredPid ?? null,
          identity,
          discovery: discovery?.state ?? null,
          restoredVisibility: status === 'orphan_detected' && wasHidden,
        },
      });
      changed = true;
    }
    if (changed) await db.save();
  }

  function buildReleaseStatusSnapshot(): ReleaseStatusSnapshot {
    const signingConfigured = Boolean(releaseEnvironment.CSC_LINK && releaseEnvironment.CSC_KEY_PASSWORD);
    const notarizationConfigured = Boolean(releaseEnvironment.APPLE_ID && releaseEnvironment.APPLE_APP_SPECIFIC_PASSWORD && releaseEnvironment.APPLE_TEAM_ID);
    const caskPath = `${projectRoot}/Casks/zeus.rb`;
    const workflowPath = `${projectRoot}/.github/workflows/release.yml`;
    const changelogPath = 'docs/release.md';
    const readiness = detectReleaseReadiness({
      hasAppleCertificate: signingConfigured,
      hasNotaryCredentials: notarizationConfigured,
    });
    const releaseWorkflowConfigured = existsSync(workflowPath);
    const autoUpdate = buildAutoUpdatePolicy({
      currentVersion: readProjectVersion(projectRoot),
      channel: 'manual',
      hasReleaseWorkflow: releaseWorkflowConfigured,
      hasSignedAndNotarizedArtifacts: readiness.canSign && readiness.canNotarize,
      changelogPath,
    });
    return {
      signing: {
        configured: signingConfigured,
        label: signingConfigured ? '签名证书已配置' : '等待 Apple 签名证书',
      },
      notarization: {
        configured: notarizationConfigured,
        label: notarizationConfigured ? '公证凭据已配置' : '等待 Apple 公证凭据',
      },
      homebrewCask: {
        configured: existsSync(caskPath),
        label: existsSync(caskPath) ? '已检测到 Casks/zeus.rb' : '等待 Homebrew cask 文件',
      },
      releaseWorkflow: {
        configured: releaseWorkflowConfigured,
        label: releaseWorkflowConfigured ? '已检测到 GitHub Release workflow' : '等待 GitHub Release workflow',
      },
      readiness,
      autoUpdate,
    };
  }

  async function buildReleaseUpdateStatus(): Promise<ReleaseUpdateStatus> {
    const configuredCurrentVersion = typeof options.currentAppVersion === 'function' ? options.currentAppVersion().trim() : options.currentAppVersion?.trim();
    const currentVersion = configuredCurrentVersion || readProjectVersion(projectRoot);
    const checkedAt = now().toISOString();
    try {
      const manifest = await loadReleaseUpdateManifest();
      return evaluateReleaseUpdateAvailability({
        currentVersion,
        manifest,
        platformArch: resolveReleaseUpdateArch(),
        executionHostProtocolVersion: options.executionHost?.protocolVersion ?? 2,
        checkedAt,
      });
    } catch (error) {
      return {
        status: 'unavailable',
        currentVersion,
        latestVersion: currentVersion,
        channel: 'stable',
        releasePageUrl: 'https://github.com/imchenway/zeus/releases/latest',
        artifact: null,
        executionHostProtocolVersion: options.executionHost?.protocolVersion ?? 2,
        automaticInstallEnabled: false,
        recommendedAction: 'open_download_page',
        label: '暂未取得更新清单',
        reason: error instanceof Error && error.message ? `无法读取 GitHub Release manifest：${error.message}` : '无法读取 GitHub Release manifest。',
        checkedAt,
      };
    }
  }

  async function loadReleaseUpdateManifest(): Promise<ReleaseUpdateManifest> {
    const response = await fetch(releaseUpdateManifestUrl, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return parseReleaseUpdateManifest(await response.json(), {
      allowLoopbackDownloadUrls: Boolean(options.allowUntrustedReleaseUpdateTest),
    });
  }

  function resolveReleaseUpdateArch(): ReleaseUpdateArtifactArch {
    return process.arch === 'x64' ? 'x64' : 'arm64';
  }

  function readProjectVersion(root: string): string {
    try {
      const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
      return typeof value.version === 'string' && value.version.trim() ? value.version.trim() : '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  function hasControlCharacter(value: string): boolean {
    return Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
  }

  function isAuthorizedRealtimeRequest(request: FastifyRequest): boolean {
    if (request.headers.authorization === `Bearer ${options.apiToken}`) return true;
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.searchParams.get('token') === options.apiToken) return true;
    const protocol = request.headers['sec-websocket-protocol'];
    const protocols = Array.isArray(protocol) ? protocol : typeof protocol === 'string' ? protocol.split(',').map((item) => item.trim()) : [];
    return protocols.includes(`zeus-token.${toBase64Url(options.apiToken)}`);
  }

  function toBase64Url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  function isRuntimeAdapterId(value: unknown): value is AiCliAdapterDescriptor['id'] {
    return listAiCliAdapters().some((adapter) => adapter.id === value);
  }

  function getTelegramPollingService(): TelegramPollingService | undefined {
    return platformMutableState.telegramPollingService;
  }

  async function handleTelegramBusinessCommand(command: TelegramCommand, update?: TelegramUpdate): Promise<string | TelegramCommandResponse> {
    switch (command.command) {
      case 'start':
      case 'help':
        return formatTelegramHelp(await readTelegramToken());
      case 'projects': {
        const rows = projects.list();
        if (rows.length === 0) return '项目列表为空。请先在 Zeus 桌面端添加真实本地代码库。';
        return `项目列表：\n${rows.map((project) => `- ${project.name} (${project.id}) ${project.localPath}`).join('\n')}`;
      }
      case 'tasks': {
        const projectId = command.args[0];
        const rows = projectId ? tasks.listByProject(projectId) : projects.list().flatMap((project) => tasks.listByProject(project.id));
        if (rows.length === 0) return '任务列表为空。';
        return `任务列表：\n${rows.map(formatTelegramTaskListRow).join('\n')}`;
      }
      case 'commands':
        return formatTelegramCommandMenu(command.args[0], Boolean(update?.callbackData));
      case 'command':
        return handleTelegramCommandCenterAction(command.args, update);
      case 'status': {
        const taskId = command.args[0];
        if (!taskId) return '请提供任务 ID：/status <taskId>';
        const task = tasks.getById(taskId);
        return task ? formatTelegramTaskStatus(task) : `未找到任务：${taskId}`;
      }
      case 'logs': {
        const { taskId, full } = parseTelegramLogsArgs(command.args);
        return formatTelegramTaskLogs(taskId, { full });
      }
      case 'diff':
        return formatTelegramTaskDiff(command.args[0]);
      case 'ask':
        return formatTelegramGraphAsk(command.args[0], command.args.slice(1).join(' '));
      case 'run':
        return runTelegramTask(command.args[0], command.args[1]);
      case 'confirm':
        return confirmTelegramRuntimeOperation(command.args[0]);
      case 'cancel':
        return cancelTelegramRuntimeOperation(command.args[0]);
      case 'stop':
        return stopTelegramTask(command.args[0]);
      case 'continue':
        return continueTelegramTask(command.args[0]);
      default:
        return '未知 Zeus 远程命令。';
    }
  }

  function formatTelegramHelp(token: string | undefined): string {
    const configuration = getTelegramConfigurationState(token, platformMutableState.telegramSecuritySettings.allowedUserIds);
    const polling = getTelegramPollingService()?.status();
    // Help 是远程入口的安全边界说明；只展示配置状态和命令格式，不回显 token、路径密钥或终端输出。
    return [
      'Zeus 远程命令帮助',
      '可用命令：',
      '/projects',
      '/commands [project]',
      '/command detail <project> <command>',
      '/command run <project> <command> [KEY=value]',
      '/tasks [project]',
      '/run <project> <task>',
      '/status <task>',
      '/stop <task>',
      '/continue <task>',
      '/logs <task> [--full]',
      '/diff <task>',
      '/ask <project> <question>',
      '/help',
      '安全限制：默认禁止远程执行任意 shell；远程任务默认不自动提交 Git；高风险执行需要确认。',
      '命令中心：只有桌面端已单独开启 Telegram 的命令才会显示；高风险命令同样需要本次明确确认，不需要额外短语。',
      `当前配置：Token：${token ? '已配置' : '未配置'}；白名单用户：${platformMutableState.telegramSecuritySettings.allowedUserIds.length}；通知 Chat：${platformMutableState.telegramNotificationSettings.chatIds.length}；Polling：${polling?.running ? '运行中' : '已停止'}；状态：${configuration.reason}`,
    ].join('\n');
  }

  function formatTelegramCommandMenu(projectIdentifier: string | undefined, editOriginalMessage: boolean): TelegramCommandResponse {
    if (!projectIdentifier) {
      const rows = projects.list();
      if (rows.length === 0) return { text: '项目列表为空。请先在 Zeus 桌面端添加真实本地代码库。' };
      return {
        text: '选择要执行命令的项目：',
        inlineKeyboard: rows.map((project) => [
          {
            text: project.name,
            callbackData: telegramCallbackData('project', project.id),
          },
        ]),
        editOriginalMessage,
      };
    }
    const project = resolveTelegramProject(projectIdentifier);
    if (!project) return { text: `未找到项目：${projectIdentifier}`, editOriginalMessage };
    const commands = commandDefinitions.listMerged(project.id, true).filter((command) => command.telegramEnabled);
    if (commands.length === 0) {
      return {
        text: `${project.name} 当前没有已授权的 Telegram 命令。请在 Zeus 桌面端逐条开启。`,
        inlineKeyboard: [[{ text: '返回项目', callbackData: telegramCallbackData('projects') }]],
        editOriginalMessage,
      };
    }
    return {
      text: [`命令菜单：${project.name}`, ...commands.map((command) => `- ${command.title} (/${command.name})${commandNeedsHighRiskConfirmation(command.riskFlags) ? ' · 高风险' : ''}`)].join('\n'),
      inlineKeyboard: [
        ...commands.map((command) => [
          {
            text: `▶ ${command.title}`,
            callbackData: telegramCallbackData('detail', project.id, command.id),
          },
        ]),
        [{ text: '返回项目', callbackData: telegramCallbackData('projects') }],
      ],
      editOriginalMessage,
    };
  }

  async function handleTelegramCommandCenterAction(args: string[], update?: TelegramUpdate): Promise<string | TelegramCommandResponse> {
    const [action, projectIdentifier, commandIdentifier, ...rawParameters] = args;
    if (!action || !projectIdentifier || !commandIdentifier || !['detail', 'run'].includes(action)) {
      return '命令格式：/command detail <project> <command> 或 /command run <project> <command> [KEY=value]';
    }
    const project = resolveTelegramProject(projectIdentifier);
    if (!project) return `未找到项目：${projectIdentifier}`;
    const command = commandDefinitions.getById(commandIdentifier) ?? commandDefinitions.findByToken(project.id, commandIdentifier, true);
    if (!command || (command.scope === 'project' && command.projectId !== project.id)) return `未找到命令：${commandIdentifier}`;
    if (!command.enabled || !command.telegramEnabled) return `命令 ${command.name} 未启用 Telegram 远程执行。`;
    const highRisk = commandNeedsHighRiskConfirmation(command.riskFlags);
    const missingRequiredParameter = command.parameters.find((parameter) => parameter.required && parameter.defaultValue === undefined);
    if (action === 'detail') {
      const runInstruction = `/command run ${project.id} ${command.id}${command.parameters.length > 0 ? ' KEY=value' : ''}`;
      const canUseButton = !missingRequiredParameter;
      return {
        text: [
          `命令：${command.title} (${command.name})`,
          `项目：${project.name}`,
          `目录：${project.localPath}`,
          `超时：${command.timeoutSeconds} 秒`,
          `风险：${highRisk ? '高风险，仍需本次明确确认' : '普通，仍需本次确认'}`,
          `参数：${command.parameters.length > 0 ? command.parameters.map((parameter) => `${parameter.key}${parameter.required ? '*' : ''}`).join(', ') : '无'}`,
          canUseButton ? '点击“确认运行”将创建一次性确认并启动。' : `请发送：${runInstruction}`,
        ].join('\n'),
        inlineKeyboard: [...(canUseButton ? [[{ text: '确认运行', callbackData: telegramCallbackData('run', project.id, command.id) }]] : []), [{ text: '返回命令', callbackData: telegramCallbackData('project', project.id) }]],
        editOriginalMessage: Boolean(update?.callbackData),
      };
    }
    const parsed = parseTelegramCommandParameters(command.parameters, rawParameters);
    if ('error' in parsed) return parsed.error;
    const telegramActor = { kind: 'remote_control' as const, id: `telegram:${update?.chatId ?? 0}` };
    const runId = `command_run_${randomUUID()}`;
    const confirmationResponse = await server.inject({
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(project.id)}/commands/${encodeURIComponent(command.id)}/confirmations`,
      headers: { authorization: `Bearer ${options.apiToken}` },
      payload: createCommandCenterCommandRequest({
        commandType: commandCenterCommandTypes.confirmationCreate,
        actor: telegramActor,
        scope: { kind: 'command_run', id: runId },
        expectedRevision: null,
        operationIdentity: runId,
        value: { parameters: parsed.parameters, trigger: 'telegram' },
      }),
    });
    if (confirmationResponse.statusCode !== 201) return formatTelegramCommandApiFailure(confirmationResponse);
    const confirmation = confirmationResponse.json<{ id: string; runId: string }>();
    const runResponse = await server.inject({
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(project.id)}/commands/${encodeURIComponent(command.id)}/runs`,
      headers: { authorization: `Bearer ${options.apiToken}` },
      payload: createCommandCenterCommandRequest({
        commandType: commandCenterCommandTypes.runStart,
        actor: telegramActor,
        scope: { kind: 'command_run', id: confirmation.runId },
        expectedRevision: null,
        operationIdentity: `command_run_start_${randomUUID()}`,
        value: { runId: confirmation.runId, confirmationId: confirmation.id, parameters: parsed.parameters },
      }),
    });
    if (runResponse.statusCode !== 201) return formatTelegramCommandApiFailure(runResponse);
    const run = runResponse.json<{ id: string; runtimeSessionId: string | null; status: string }>();
    telegramCommandRunMessages.set(run.id, {
      chatId: update?.chatId ?? 0,
      ...(update?.callbackData && update.messageId ? { messageId: update.messageId } : {}),
    });
    return {
      text: [`命令已启动：${command.title}`, `项目：${project.name}`, `执行 ID：${run.id}`, `状态：${run.status}`, 'Zeus 会在同一条命令消息中更新进度；完成后回传已登记产物。'].join('\n'),
      editOriginalMessage: Boolean(update?.callbackData),
    };
  }

  function resolveTelegramProject(identifier: string): ZeusProjectRecord | undefined {
    const normalized = identifier.trim().toLocaleLowerCase();
    return projects.list().find((project) => {
      const alias = readProjectConfig(project.id).telegram.alias?.trim().toLocaleLowerCase();
      return project.id.toLocaleLowerCase() === normalized || project.name.trim().toLocaleLowerCase() === normalized || alias === normalized;
    });
  }

  function parseTelegramCommandParameters(parameters: import('@zeus/shared').CommandParameterDefinition[], args: string[]): { parameters: Record<string, string | number | boolean> } | { error: string } {
    const values: Record<string, string | number | boolean> = {};
    for (const arg of args) {
      const separatorIndex = arg.indexOf('=');
      if (separatorIndex <= 0) return { error: `参数格式无效：${arg}。请使用 KEY=value。` };
      const key = arg.slice(0, separatorIndex).toLocaleUpperCase();
      const rawValue = arg.slice(separatorIndex + 1);
      const definition = parameters.find((parameter) => parameter.key === key);
      if (!definition) return { error: `命令未声明参数：${key}` };
      if (definition.type === 'number') {
        const numberValue = Number(rawValue);
        if (!Number.isFinite(numberValue)) return { error: `参数 ${key} 必须是数字。` };
        values[key] = numberValue;
      } else if (definition.type === 'boolean') {
        if (!['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'].includes(rawValue.toLocaleLowerCase())) {
          return { error: `参数 ${key} 必须是布尔值。` };
        }
        values[key] = ['1', 'true', 'yes', 'on'].includes(rawValue.toLocaleLowerCase());
      } else {
        values[key] = rawValue;
      }
    }
    return { parameters: values };
  }

  function formatTelegramCommandApiFailure(response: { json: <T>() => T; statusCode: number }): string {
    const payload = response.json<{ message?: string; error?: string; issues?: Array<{ message?: string }> }>();
    return [`命令请求被 Zeus 拒绝（${response.statusCode}）。`, payload.message ?? payload.error ?? '未知错误', ...(payload.issues ?? []).map((issue) => `- ${issue.message ?? '参数无效'}`)].join('\n');
  }

  function telegramCallbackData(action: 'projects' | 'project' | 'detail' | 'run', ...parts: string[]): string {
    const compactAction = {
      projects: 'ps',
      project: 'p',
      detail: 'd',
      run: 'r',
    }[action];
    const callbackData = ['zc', compactAction, ...parts.map((part) => Buffer.from(part, 'utf8').toString('base64url'))].join('|');
    if (Buffer.byteLength(callbackData, 'utf8') > 64) {
      throw new Error(`Telegram command callback exceeds 64 bytes: ${action}`);
    }
    return callbackData;
  }

  async function notifyTelegramCommandRunLog(log: AiRuntimeLogEntry): Promise<void> {
    const run = commandRuns.getByRuntimeSessionId(log.sessionId);
    if (!run) return;
    const message = telegramCommandRunMessages.get(run.id);
    if (!message?.messageId || !platformMutableState.telegramMessageSender?.editMessage || run.status !== 'running') return;
    const count = (telegramCommandRunLogCounts.get(run.id) ?? 0) + 1;
    telegramCommandRunLogCounts.set(run.id, count);
    if (count % 5 !== 0) return;
    try {
      await platformMutableState.telegramMessageSender.editMessage(message.chatId, message.messageId, formatTelegramCommandRunStatus(run));
    } catch (error) {
      appendAuditLog({
        actorType: 'telegram',
        action: 'command.telegram_status_update.failed',
        resourceType: 'command_run',
        resourceId: run.id,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async function notifyTelegramCommandRunSession(session: AiRuntimeSession): Promise<void> {
    const run = commandRuns.getByRuntimeSessionId(session.id);
    if (!run || run.status === 'running' || run.status === 'pending_confirmation' || run.status === 'starting' || run.status === 'stopping') return;
    const message = telegramCommandRunMessages.get(run.id);
    if (!message || !platformMutableState.telegramMessageSender) return;
    try {
      const text = formatTelegramCommandRunStatus(run);
      if (message.messageId && platformMutableState.telegramMessageSender.editMessage) {
        await platformMutableState.telegramMessageSender.editMessage(message.chatId, message.messageId, text);
      } else if (message.chatId !== 0) {
        await platformMutableState.telegramMessageSender.sendMessage(message.chatId, text);
      }
      if (message.chatId !== 0 && platformMutableState.telegramMessageSender.sendDocument) {
        for (const artifact of commandArtifacts.listByRun(run.id)) {
          const verifiedPath = verifyTelegramCommandArtifact(run.id, artifact.absolutePath);
          if (!verifiedPath) continue;
          await platformMutableState.telegramMessageSender.sendDocument(message.chatId, verifiedPath, `${run.commandSnapshot.title} · ${artifact.relativePath}`);
        }
      }
      appendAuditLog({
        actorType: 'telegram',
        action: 'command.telegram_status_update.sent',
        resourceType: 'command_run',
        resourceId: run.id,
        payload: {
          status: run.status,
          artifactCount: commandArtifacts.listByRun(run.id).length,
          editedOriginalMessage: Boolean(message.messageId),
        },
      });
    } catch (error) {
      appendAuditLog({
        actorType: 'telegram',
        action: 'command.telegram_status_update.failed',
        resourceType: 'command_run',
        resourceId: run.id,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      telegramCommandRunMessages.delete(run.id);
      telegramCommandRunLogCounts.delete(run.id);
      void db.save();
    }
  }

  function formatTelegramCommandRunStatus(run: import('@zeus/shared').CommandRun): string {
    const logs = run.runtimeSessionId ? runtimeSessions.listRecentLogs(run.runtimeSessionId, 8) : [];
    const tail = logs
      .filter((log) => log.stream === 'stdout' || log.stream === 'stderr')
      .map((log) => log.text.trim())
      .filter(Boolean)
      .join('\n')
      .slice(-900);
    return [
      `命令：${run.commandSnapshot.title} (${run.commandSnapshot.name})`,
      `执行 ID：${run.id}`,
      `状态：${run.status}`,
      `项目：${run.projectId}`,
      `目录：${run.cwd}`,
      run.exitCode === null ? null : `退出码：${run.exitCode}`,
      run.failureReason ? `说明：${run.failureReason}` : null,
      tail ? `最近输出：\n${tail}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  function verifyTelegramCommandArtifact(runId: string, artifactPath: string): string | null {
    try {
      const runRoot = realpathSync(join(dataLayout.commandRuns, runId));
      const artifactRealPath = realpathSync(artifactPath);
      if (!isPathInsideRoot(artifactRealPath, runRoot) || artifactRealPath === runRoot) return null;
      return statSync(artifactRealPath).isFile() ? artifactRealPath : null;
    } catch {
      return null;
    }
  }

  function formatTelegramTaskListRow(task: ZeusTaskRecord): string {
    return `- ${task.title} (${task.id}) 状态：${task.status}；更新：${task.updatedAt}；下一步：${formatTelegramTaskNextAction(task)}`;
  }

  function formatTelegramTaskNextAction(task: ZeusTaskRecord): string {
    switch (task.status) {
      case 'draft':
      case 'ready':
        return `/run ${task.projectId} ${task.id}`;
      case 'running':
        return `/status ${task.id} 或 /stop ${task.id}`;
      case 'paused':
        return `/continue ${task.id}`;
      case 'waiting_confirmation':
        return `/status ${task.id} 查看等待确认`;
      case 'completed':
        return `/logs ${task.id}`;
      case 'failed':
        return `/logs ${task.id} 查看失败原因`;
      case 'cancelled':
        return `/status ${task.id}`;
    }
  }

  function formatTelegramTaskStatus(task: ZeusTaskRecord): string {
    const runtimeLine = formatTelegramTaskRuntimeStatus(task);
    const recentEvents = taskEvents.listByTask(task.id).slice(-3);
    // /status 是远程排障入口：只汇总本地事实源，不读取终端长正文，也不伪造 Runtime 进度。
    return [
      `任务状态：${task.title} (${task.id})`,
      `状态：${task.status}`,
      `更新：${task.updatedAt}`,
      runtimeLine,
      `下一步：${formatTelegramTaskNextAction(task)}`,
      '最近事件：',
      ...(recentEvents.length > 0 ? recentEvents.map((event) => `- ${event.createdAt} ${event.title}`) : ['- 暂无任务事件']),
    ].join('\n');
  }

  function formatTelegramTaskRuntimeStatus(task: ZeusTaskRecord): string {
    const sessions = collectTaskRuntimeSessions(task);
    if (sessions.length === 0) return 'Runtime：暂无运行中会话';
    const counts = sessions.reduce<Record<string, number>>((acc, session) => {
      acc[session.status] = (acc[session.status] ?? 0) + 1;
      return acc;
    }, {});
    return `Runtime：${sessions.length} 个会话；${Object.entries(counts)
      .map(([status, count]) => `${status} ${count}`)
      .join('，')}`;
  }

  function collectTaskRuntimeSessions(task: ZeusTaskRecord): AiRuntimeSession[] {
    const memorySessions = aiRuntimeManager.listSessions().filter((session) => session.taskId === task.id);
    const memorySessionIds = new Set(memorySessions.map((session) => session.id));
    const persistedSessions = runtimeSessions
      .list({ taskId: task.id, archived: false })
      .filter((session) => !memorySessionIds.has(session.id))
      .map(toAiRuntimeSession);
    return [...memorySessions, ...persistedSessions];
  }

  async function runTelegramTask(projectRef: string | undefined, taskId: string | undefined): Promise<string> {
    if (!projectRef || !taskId) return '请提供项目和任务：/run <project> <taskId>';
    const project = findProjectByRef(projectRef);
    if (!project) return `未找到项目：${projectRef}`;
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    if (task.projectId !== project.id) return `任务不属于项目：${task.title} (${task.id})`;
    const adapterId = platformMutableState.runtimeSettings.defaultAdapterId;
    if (isNonCodexAiCliAdapterId(adapterId)) {
      const unsupportedMessage = getNonCodexTaskAttachmentsUnsupportedMessage(adapterId, task);
      if (unsupportedMessage) return unsupportedMessage;
    }
    return createTelegramRuntimeConfirmation('run', project, task, () => runTelegramTaskAfterConfirmation(project, task.id));
  }

  async function runTelegramTaskAfterConfirmation(project: ZeusProjectRecord, taskId: string): Promise<string> {
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const adapterId = platformMutableState.runtimeSettings.defaultAdapterId;
    if (adapterId === 'codex') {
      if (conversationChoiceQueries.listTaskHistory(task.id, project.id).length > 0) {
        if (task.status === 'waiting_confirmation') moveTaskToCancelled(task.id);
        await db.save();
        return `任务已有会话历史：${task.title} (${task.id})。远程操作未执行；请在桌面端显式选择新建、续接或引用旧会话，Telegram 不会隐式选择 Codex 会话。`;
      }
      const result = await startTaskNativeConversation(project, task, 'telegram.run', 'Telegram 已启动 Codex native 会话');
      return `已启动 Codex native 会话：${result.task.title} (${result.task.id}) · ${result.conversation.id}`;
    }
    if (!isNonCodexAiCliAdapterId(adapterId)) return `不支持的 Runtime adapter：${String(adapterId)}`;
    assertNonCodexTaskAttachmentsSupported(adapterId, task);
    const runningTask = moveTaskTowardRunning(task.id);
    const invocation = createNonCodexTaskRuntimeInvocation(adapterId, project, runningTask);
    const session = await aiRuntimeManager.startSession({
      projectId: project.id,
      taskId: runningTask.id,
      command: invocation.command,
      args: invocation.args,
      cwd: project.localPath,
      env: buildRuntimeProcessEnv(),
    });
    recordTaskEvent({
      taskId: runningTask.id,
      eventType: 'telegram.run',
      title: 'Telegram 已启动 Runtime 会话',
      payload: {
        runtimeSessionId: session.id,
        projectId: project.id,
        adapterId: invocation.adapterId,
        argCount: invocation.args.length,
      },
    });
    await db.save();
    return `已启动 Runtime 会话：${runningTask.title} (${runningTask.id}) · ${session.id}`;
  }

  async function stopTelegramTask(taskId: string | undefined): Promise<string> {
    if (!taskId) return '请提供任务 ID：/stop <taskId>';
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const project = projects.getById(task.projectId);
    if (!project) return `未找到任务所属项目：${task.projectId}`;
    return createTelegramRuntimeConfirmation('stop', project, task, () => stopTelegramTaskAfterConfirmation(task.id));
  }

  async function stopTelegramTaskAfterConfirmation(taskId: string): Promise<string> {
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const sessions = aiRuntimeManager.listSessions().filter((session) => session.taskId === task.id && session.status === 'running');
    for (const session of sessions) aiRuntimeManager.stopSession(session.id);
    const stopped = moveTaskToCancelled(task.id);
    recordTaskEvent({
      taskId: stopped.id,
      eventType: 'telegram.stop',
      title: 'Telegram 已停止任务',
      payload: {
        stoppedRuntimeSessions: sessions.map((session) => session.id),
      },
    });
    await db.save();
    return `已停止任务：${stopped.title} (${stopped.id}) · 停止会话 ${sessions.length} 个`;
  }

  async function continueTelegramTask(taskId: string | undefined): Promise<string> {
    if (!taskId) return '请提供任务 ID：/continue <taskId>';
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const project = projects.getById(task.projectId);
    if (!project) return `未找到任务所属项目：${task.projectId}`;
    const adapterId = platformMutableState.runtimeSettings.defaultAdapterId;
    if (isNonCodexAiCliAdapterId(adapterId)) {
      const unsupportedMessage = getNonCodexTaskAttachmentsUnsupportedMessage(adapterId, task);
      if (unsupportedMessage) return unsupportedMessage;
    }
    return createTelegramRuntimeConfirmation('continue', project, task, () => continueTelegramTaskAfterConfirmation(task.id));
  }

  async function continueTelegramTaskAfterConfirmation(taskId: string): Promise<string> {
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const project = projects.getById(task.projectId);
    if (!project) return `未找到任务所属项目：${task.projectId}`;
    const adapterId = platformMutableState.runtimeSettings.defaultAdapterId;
    if (adapterId === 'codex') {
      if (task.status === 'waiting_confirmation') moveTaskToCancelled(task.id);
      await db.save();
      return `远程操作未执行；请在桌面端为任务 ${task.title} (${task.id}) 显式选择要续接的 Codex native 会话，Telegram 不会隐式选择历史。`;
    }
    if (!isNonCodexAiCliAdapterId(adapterId)) return `不支持的 Runtime adapter：${String(adapterId)}`;
    assertNonCodexTaskAttachmentsSupported(adapterId, task);
    const runningTask = moveTaskTowardRunning(task.id);
    const invocation = createNonCodexTaskRuntimeInvocation(adapterId, project, runningTask, '继续执行该任务，优先复用已有上下文并说明新的真实依据。');
    const session = await aiRuntimeManager.startSession({
      projectId: project.id,
      taskId: runningTask.id,
      command: invocation.command,
      args: invocation.args,
      cwd: project.localPath,
      env: buildRuntimeProcessEnv(),
    });
    recordTaskEvent({
      taskId: runningTask.id,
      eventType: 'telegram.continue',
      title: 'Telegram 已继续任务',
      payload: {
        runtimeSessionId: session.id,
        projectId: project.id,
        adapterId: invocation.adapterId,
        argCount: invocation.args.length,
      },
    });
    await db.save();
    return `已继续任务：${runningTask.title} (${runningTask.id}) · Runtime 会话 ${session.id}`;
  }

  async function createTelegramRuntimeConfirmation(
    action: TelegramRuntimeConfirmation['action'],
    project: ZeusProjectRecord,
    task: ZeusTaskRecord,
    execute: () => Promise<string>,
    options: { affectsTaskStatus?: boolean } = {},
  ): Promise<string> {
    const affectsTaskStatus = options.affectsTaskStatus ?? true;
    const confirmationTask = affectsTaskStatus ? moveTaskToWaitingConfirmation(task.id) : task;
    const confirmationId = randomUUID();
    const createdAtMs = Date.now();
    telegramRuntimeConfirmations.set(confirmationId, {
      id: confirmationId,
      taskId: confirmationTask.id,
      projectId: project.id,
      action,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: createdAtMs + telegramConfirmationTtlMs,
      affectsTaskStatus,
      execute,
    });
    recordTaskEvent({
      taskId: confirmationTask.id,
      eventType: `telegram.${action}.confirmation.requested`,
      title: 'Telegram 远程高风险操作等待确认',
      payload: {
        confirmationId,
        projectId: project.id,
        action,
        affectsTaskStatus,
      },
    });
    appendAuditLog({
      actorType: 'telegram',
      action: 'security.confirmation.required',
      resourceType: 'telegram_runtime_confirmation',
      resourceId: confirmationId,
      payload: {
        confirmationId,
        projectId: project.id,
        taskId: confirmationTask.id,
        action,
        riskLevel: 'high',
        affectsTaskStatus,
      },
    });
    publishRealtimeEvent('security.confirmation.required', {
      confirmationId,
      action,
      operation: action,
      projectId: project.id,
      taskId: confirmationTask.id,
      riskLevel: 'high',
      affectsTaskStatus,
    });
    await db.save();
    return [`等待确认：${formatTelegramConfirmationActionLabel(action)} · ${confirmationTask.title} (${confirmationTask.id})`, `请发送 /confirm ${confirmationId} 完成二次确认。`, `如需放弃，请发送 /cancel ${confirmationId}。`].join('\n');
  }

  function formatTelegramConfirmationActionLabel(action: TelegramRuntimeConfirmation['action']): string {
    switch (action) {
      case 'run':
        return '远程启动 Runtime 会话';
      case 'continue':
        return '远程继续 Runtime 会话';
      case 'stop':
        return '远程停止 Runtime 会话';
      case 'logs_full':
        return '导出完整 Runtime 日志';
      case 'diff':
        return '查看 Git Diff';
    }
  }

  async function confirmTelegramRuntimeOperation(confirmationId: string | undefined): Promise<string> {
    if (!confirmationId) return '请提供确认 ID：/confirm <confirmationId>';
    const confirmation = telegramRuntimeConfirmations.get(confirmationId);
    if (!confirmation) return `确认不存在或已失效：${confirmationId}`;
    if (isTelegramConfirmationExpired(confirmation)) {
      telegramRuntimeConfirmations.delete(confirmationId);
      const expiredTask = confirmation.affectsTaskStatus ? moveTaskToCancelled(confirmation.taskId) : tasks.getById(confirmation.taskId);
      recordTaskEvent({
        taskId: expiredTask?.id ?? confirmation.taskId,
        eventType: `telegram.${confirmation.action}.confirmation.expired`,
        title: 'Telegram 远程高风险操作确认已过期',
        payload: {
          confirmationId,
          projectId: confirmation.projectId,
          action: confirmation.action,
          createdAt: confirmation.createdAt,
          affectsTaskStatus: confirmation.affectsTaskStatus,
        },
      });
      await db.save();
      return confirmation.affectsTaskStatus ? `确认已过期：${confirmationId}。远程操作未执行，任务已取消。` : `确认已过期：${confirmationId}。远程操作未执行。`;
    }
    telegramRuntimeConfirmations.delete(confirmationId);
    recordTaskEvent({
      taskId: confirmation.taskId,
      eventType: `telegram.${confirmation.action}.confirmation.confirmed`,
      title: 'Telegram 远程高风险操作已确认',
      payload: {
        confirmationId,
        projectId: confirmation.projectId,
        action: confirmation.action,
        createdAt: confirmation.createdAt,
        affectsTaskStatus: confirmation.affectsTaskStatus,
      },
    });
    appendAuditLog({
      actorType: 'telegram',
      action: 'security.confirmation.approved',
      resourceType: 'telegram_runtime_confirmation',
      resourceId: confirmationId,
      payload: {
        confirmationId,
        projectId: confirmation.projectId,
        taskId: confirmation.taskId,
        action: confirmation.action,
        riskLevel: 'high',
        affectsTaskStatus: confirmation.affectsTaskStatus,
      },
    });
    publishRealtimeEvent('security.confirmation.approved', {
      confirmationId,
      action: confirmation.action,
      operation: confirmation.action,
      projectId: confirmation.projectId,
      taskId: confirmation.taskId,
      riskLevel: 'high',
      affectsTaskStatus: confirmation.affectsTaskStatus,
    });
    await db.save();
    return confirmation.execute();
  }

  async function cancelTelegramRuntimeOperation(confirmationId: string | undefined): Promise<string> {
    if (!confirmationId) return '请提供确认 ID：/cancel <confirmationId>';
    const confirmation = telegramRuntimeConfirmations.get(confirmationId);
    if (!confirmation) return `确认不存在或已失效：${confirmationId}`;
    telegramRuntimeConfirmations.delete(confirmationId);
    const cancelledTask = confirmation.affectsTaskStatus ? moveTaskToCancelled(confirmation.taskId) : tasks.getById(confirmation.taskId);
    recordTaskEvent({
      taskId: cancelledTask?.id ?? confirmation.taskId,
      eventType: `telegram.${confirmation.action}.confirmation.cancelled`,
      title: 'Telegram 远程高风险操作确认已取消',
      payload: {
        confirmationId,
        projectId: confirmation.projectId,
        action: confirmation.action,
        createdAt: confirmation.createdAt,
        affectsTaskStatus: confirmation.affectsTaskStatus,
      },
    });
    appendAuditLog({
      actorType: 'telegram',
      action: 'security.confirmation.rejected',
      resourceType: 'telegram_runtime_confirmation',
      resourceId: confirmationId,
      payload: {
        confirmationId,
        projectId: confirmation.projectId,
        taskId: cancelledTask?.id ?? confirmation.taskId,
        action: confirmation.action,
        riskLevel: 'high',
        affectsTaskStatus: confirmation.affectsTaskStatus,
      },
    });
    publishRealtimeEvent('security.confirmation.rejected', {
      confirmationId,
      action: confirmation.action,
      operation: confirmation.action,
      projectId: confirmation.projectId,
      taskId: cancelledTask?.id ?? confirmation.taskId,
      riskLevel: 'high',
      affectsTaskStatus: confirmation.affectsTaskStatus,
    });
    await db.save();
    return confirmation.affectsTaskStatus ? `已取消远程确认：${confirmationId}。远程操作未执行，任务已取消。` : `已取消远程确认：${confirmationId}。远程操作未执行。`;
  }

  function isTelegramConfirmationExpired(confirmation: TelegramRuntimeConfirmation): boolean {
    return telegramConfirmationTtlMs <= 0 || Date.now() > confirmation.expiresAt;
  }

  function createTaskRuntimePrompt(task: ZeusTaskRecord, descriptionSupplement?: string): string {
    return buildAiRuntimePrompt({
      taskTitle: task.title,
      taskType: task.taskType,
      taskDescription: task.description,
      defectCurrentState: task.defectCurrentState,
      defectExpectedOutcome: task.defectExpectedOutcome,
      defectReproductionSteps: task.defectReproductionSteps,
      optimizationCurrentState: task.optimizationCurrentState,
      optimizationExpectedOutcome: task.optimizationExpectedOutcome,
      supplementalInfo: descriptionSupplement,
    });
  }

  function taskPushContentAttachmentFields(taskType: ZeusTaskRecord['taskType']): ReadonlySet<TaskAttachmentField> {
    return new Set<TaskAttachmentField>(
      taskType === 'defect'
        ? (['defectCurrentState', 'defectExpectedOutcome', 'defectReproductionSteps'] as const)
        : taskType === 'optimization'
          ? (['optimizationCurrentState', 'optimizationExpectedOutcome'] as const)
          : (['description'] as const),
    );
  }

  function getNonCodexTaskAttachmentsUnsupportedMessage(adapterId: NonCodexAiCliAdapterId, task: ZeusTaskRecord): string | null {
    const sourceContext = parseTaskSourceContext(task);
    const contentFields = taskPushContentAttachmentFields(task.taskType);
    const hasTaskPushAttachments =
      Array.isArray(sourceContext.attachments) &&
      sourceContext.attachments.some((attachment: unknown) => {
        const candidate = isNativeApiRecord(attachment) ? attachment : {};
        const field = isTaskAttachmentField(candidate.field) ? candidate.field : historicalTaskAttachmentField(task.taskType);
        return contentFields.has(field);
      });
    return hasTaskPushAttachments ? `Runtime adapter ${adapterId} 不支持任务附件，未启动会话。` : null;
  }

  function assertNonCodexTaskAttachmentsSupported(adapterId: NonCodexAiCliAdapterId, task: ZeusTaskRecord): void {
    const unsupportedMessage = getNonCodexTaskAttachmentsUnsupportedMessage(adapterId, task);
    if (unsupportedMessage) throw nativeApiError('ZEUS_NON_CODEX_TASK_ATTACHMENTS_UNSUPPORTED', unsupportedMessage);
  }

  function resolveExistingRuntimeSessionAdapter(command: string): AiCliAdapterDescriptor | null {
    const registered = resolveRegisteredRuntimeAdapter(command);
    if (registered) return registered;
    const adapters = listAiCliAdapters();
    const candidates = new Map<AiCliAdapterDescriptor['id'], AiCliAdapterDescriptor>();
    for (const adapter of adapters) {
      if (platformMutableState.runtimeSettings.adapterCliPaths[adapter.id]?.trim() === command) candidates.set(adapter.id, adapter);
      if (isAbsolute(command) && parse(command).base === adapter.command) candidates.set(adapter.id, adapter);
    }
    return candidates.size === 1 ? (candidates.values().next().value ?? null) : null;
  }

  function createNonCodexTaskRuntimeInvocation(adapterId: NonCodexAiCliAdapterId, project: ZeusProjectRecord, task: ZeusTaskRecord, instruction?: string, prompt = createTaskRuntimePrompt(task, instruction), commandPathOverride?: string) {
    assertNonCodexTaskAttachmentsSupported(adapterId, task);
    const projectConfig = readProjectConfig(project.id);
    // 项目默认模型优先级高于全局 Runtime 模型；未配置时才回退到全局设置。
    return createNonCodexAiCliAdapterInvocation(adapterId, prompt, {
      model: projectConfig.defaultModel ?? platformMutableState.runtimeSettings.adapterModels[adapterId],
      defaultArgs: platformMutableState.runtimeSettings.adapterDefaultArgs[adapterId] ?? [],
      commandPath: commandPathOverride ?? platformMutableState.runtimeSettings.adapterCliPaths[adapterId],
    });
  }

  function buildNonCodexLegacyContinuationPrompt(context: WritableNonCodexLegacyConversationContext, task: ZeusTaskRecord): string {
    const recentHistory = context.conversation.messages
      .slice(-NON_CODEX_LEGACY_HISTORY_LIMIT)
      .map((message) => `[${message.role}/${message.source}/${message.createdAt}]\n${message.content}`)
      .join('\n\n');
    return createTaskRuntimePrompt(
      task,
      [
        `继续执行 legacy CLI 会话 ${context.conversation.id}。`,
        '已有 legacy CLI Runtime 已退出、丢失或不可写时，这是自动续接的新 Runtime；不要新建任务，不要丢失上文。',
        '优先处理最后一条 user_followup；只能基于真实仓库、真实日志、真实错误输出行动。',
        '已有会话消息：',
        recentHistory || '暂无已有消息。',
      ].join('\n'),
    );
  }

  type NonCodexLiveSessionResolution = { type: 'writable'; session: AiRuntimeSession } | { type: 'missing-or-stopped' } | { type: 'mismatch'; reason: string };

  function resolveNonCodexLiveSession(project: ZeusProjectRecord, context: WritableNonCodexLegacyConversationContext): NonCodexLiveSessionResolution {
    const sessionId = context.conversation.sessionId;
    if (!sessionId) return { type: 'missing-or-stopped' };
    const session = aiRuntimeManager.getSession(sessionId);
    if (!session || session.status !== 'running') return { type: 'missing-or-stopped' };
    if (session.projectId !== project.id) {
      return { type: 'mismatch', reason: `Legacy Runtime project identity mismatch for session ${session.id}.` };
    }
    if (context.conversation.taskId && session.taskId !== context.conversation.taskId) {
      return { type: 'mismatch', reason: `Legacy Runtime task identity mismatch for session ${session.id}.` };
    }
    if (context.recordedCommand !== null) {
      if (session.command !== context.recordedCommand) {
        return { type: 'mismatch', reason: `Legacy Runtime command identity mismatch for session ${session.id}.` };
      }
      return { type: 'writable', session };
    }
    if (!isCompatibleNonCodexLegacySessionCommand(context.adapterId, session.command)) {
      return { type: 'mismatch', reason: `Legacy Runtime adapter identity mismatch for session ${session.id}.` };
    }
    return { type: 'writable', session };
  }

  function isCompatibleNonCodexLegacySessionCommand(adapterId: NonCodexAiCliAdapterId, command: string): boolean {
    const canonicalCommand: Record<NonCodexAiCliAdapterId, string> = { claude: 'claude', gemini: 'gemini', generic: 'sh' };
    const canonical = canonicalCommand[adapterId];
    const configured = platformMutableState.runtimeSettings.adapterCliPaths[adapterId]?.trim();
    if (command === canonical || (configured && command === configured)) return true;
    const commandBasename = parse(command).base;
    if (new Set(['codex', 'claude', 'gemini', 'sh']).has(commandBasename) && commandBasename !== canonical) return false;
    return isAbsolute(command) && commandBasename === canonical;
  }

  function shouldReconnectTaskConversationRuntime(message: string): boolean {
    return message.includes('AI Runtime session not found') || message.includes('不支持输入') || message.includes('not found') || message.includes('not running');
  }

  async function reconnectNonCodexLegacyConversationRuntime(
    project: ZeusProjectRecord,
    context: WritableNonCodexLegacyConversationContext,
    previousSessionId: string,
  ): Promise<{ runtimeSession: AiRuntimeSession; conversation: ZeusConversationWithMessagesRecord } | { runtimeError: { message: string } }> {
    const conversation = context.conversation;
    if (!conversation.taskId) {
      return { runtimeError: { message: '当前对话未绑定任务，无法自动续接 Runtime。' } };
    }
    const task = tasks.getById(conversation.taskId);
    if (!task || task.projectId !== project.id) {
      return { runtimeError: { message: `Conversation task not found: ${conversation.taskId}` } };
    }
    assertNonCodexTaskAttachmentsSupported(context.adapterId, task);
    const runningTask = moveTaskTowardRunning(task.id, 'task.runtime.reconnect');
    const latestConversation = conversations.getById(conversation.id) ?? conversation;
    const latestContext: WritableNonCodexLegacyConversationContext = { ...context, conversation: latestConversation };
    const prompt = buildNonCodexLegacyContinuationPrompt(latestContext, runningTask);
    const invocation = createNonCodexTaskRuntimeInvocation(context.adapterId, project, runningTask, undefined, prompt, context.recordedCommand ?? undefined);
    try {
      const session = await aiRuntimeManager.startSession({
        projectId: project.id,
        taskId: runningTask.id,
        command: invocation.command,
        args: invocation.args,
        cwd: project.localPath,
        env: buildRuntimeProcessEnv(),
      });
      conversations.appendMessage({
        conversationId: conversation.id,
        role: 'system',
        content: `Runtime 已自动续接：${session.id}`,
        source: 'task_runtime_reconnected',
        metadata: {
          projectId: project.id,
          taskId: runningTask.id,
          previousSessionId,
          sessionId: session.id,
          adapterId: invocation.adapterId,
          adapterCommand: invocation.command,
        },
        createdAt: new Date().toISOString(),
      });
      const runningConversation = conversations.updateRuntimeState(conversation.id, {
        sessionId: session.id,
        status: 'running',
        summary: `Runtime 会话 ${session.id}`,
      });
      recordTaskEvent({
        taskId: runningTask.id,
        eventType: 'task.runtime.reconnect',
        title: '任务已自动续接 Runtime',
        payload: {
          runtimeSessionId: session.id,
          previousSessionId,
          conversationId: runningConversation.id,
          projectId: project.id,
          adapterId: invocation.adapterId,
          argCount: invocation.args.length,
        },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.reconnected',
        resourceType: 'runtime_session',
        resourceId: session.id,
        payload: {
          sessionId: session.id,
          previousSessionId,
          projectId: project.id,
          taskId: runningTask.id,
          conversationId: runningConversation.id,
          command: session.command,
          cwd: session.cwd,
          source: 'conversation.message',
        },
      });
      publishRuntimeSessionEvent('runtime.session.created', session, {
        source: 'task.runtime.reconnect',
        previousSessionId,
        conversationId: runningConversation.id,
      });
      return { runtimeSession: session, conversation: runningConversation };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { runtimeError: { message } };
    }
  }

  function createTaskRuntimeConversation(adapterId: NonCodexAiCliAdapterId, adapterCommand: string, project: ZeusProjectRecord, task: ZeusTaskRecord, prompt: string, eventType: string): ZeusConversationWithMessagesRecord {
    const createdAt = new Date().toISOString();
    const conversation = conversations.create({
      projectId: project.id,
      taskId: task.id,
      title: `任务会话：${task.title.slice(0, 48)}`,
      summary: (task.description || prompt).slice(0, 240),
      status: 'starting',
      providerId: adapterId,
    });
    conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: prompt,
      source: 'task_prompt',
      metadata: {
        projectId: project.id,
        taskId: task.id,
        eventType,
        adapterId,
        adapterCommand,
      },
      createdAt,
    });
    const withMessages = conversations.getById(conversation.id);
    if (!withMessages) {
      throw new Error(`Zeus conversation not found: ${conversation.id}`);
    }
    return withMessages;
  }

  return {
    readTelegramToken,
    sendTelegramNotificationOnce,
    extractTelegramNotificationAttempts,
    notifyTelegramRuntimeProgressSummary,
    telegramTaskNotificationTitle,
    isCriticalTelegramTaskStatus,
    assertTelegramCommandInputKeys,
    parseTelegramNotificationSettingsInput,
    parseTelegramSecuritySettingsInput,
    parseTelegramDispatchPreviewInput,
    telegramCommandRouteError,
    isExplicitTelegramApiRejection,
    normalizeImportedTelegramNotificationSettings,
    normalizeImportedTelegramSecuritySettings,
    getProjectDatabasePasswordSecretKey,
    readProjectDatabaseSecretSnapshot,
    readProjectConfig,
    buildRuntimeProcessEnv,
    readCurrentGraphSummary,
    readCurrentGraphSummaryByProject,
    resolveGraphProjectName,
    resolveGraphProjectReadKeys,
    readCurrentGraphSummaryForProject,
    readCurrentGraphNodeByIdForProject,
    readCurrentGraphViewForProject,
    searchCurrentGraphNodesForProject,
    formatProjectScopedGraphViewTitle,
    resolveGraphProjectNameByProjectId,
    readCurrentGraphView,
    attachGraphViewPerformance,
    searchCurrentGraphNodes,
    readCurrentGraphNodeById,
    readCurrentGraphNodeIdsBySourceRef,
    readCurrentGraphEdgesByNodeId,
    readCurrentGraphEdgeDetail,
    readCurrentGraphNeighborhood,
    markRuntimeSessionConversationsInactive,
    formatRuntimeSessionConversationSummary,
    persistRuntimeConversationSummary,
    stopPersistedOrphanRuntimeSession,
    recoverPersistedRuntimeSessions,
    buildReleaseStatusSnapshot,
    buildReleaseUpdateStatus,
    loadReleaseUpdateManifest,
    resolveReleaseUpdateArch,
    readProjectVersion,
    hasControlCharacter,
    isAuthorizedRealtimeRequest,
    toBase64Url,
    isRuntimeAdapterId,
    getTelegramPollingService,
    handleTelegramBusinessCommand,
    formatTelegramHelp,
    formatTelegramCommandMenu,
    handleTelegramCommandCenterAction,
    resolveTelegramProject,
    parseTelegramCommandParameters,
    formatTelegramCommandApiFailure,
    telegramCallbackData,
    notifyTelegramCommandRunLog,
    notifyTelegramCommandRunSession,
    formatTelegramCommandRunStatus,
    verifyTelegramCommandArtifact,
    formatTelegramTaskListRow,
    formatTelegramTaskNextAction,
    formatTelegramTaskStatus,
    formatTelegramTaskRuntimeStatus,
    collectTaskRuntimeSessions,
    runTelegramTask,
    runTelegramTaskAfterConfirmation,
    stopTelegramTask,
    stopTelegramTaskAfterConfirmation,
    continueTelegramTask,
    continueTelegramTaskAfterConfirmation,
    createTelegramRuntimeConfirmation,
    formatTelegramConfirmationActionLabel,
    confirmTelegramRuntimeOperation,
    cancelTelegramRuntimeOperation,
    isTelegramConfirmationExpired,
    createTaskRuntimePrompt,
    taskPushContentAttachmentFields,
    getNonCodexTaskAttachmentsUnsupportedMessage,
    assertNonCodexTaskAttachmentsSupported,
    resolveExistingRuntimeSessionAdapter,
    createNonCodexTaskRuntimeInvocation,
    buildNonCodexLegacyContinuationPrompt,
    resolveNonCodexLiveSession,
    isCompatibleNonCodexLegacySessionCommand,
    shouldReconnectTaskConversationRuntime,
    reconnectNonCodexLegacyConversationRuntime,
    createTaskRuntimeConversation,
  };
}
