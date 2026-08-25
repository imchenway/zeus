import websocketPlugin from '@fastify/websocket';
import {
  type AiCliAdapterDescriptor,
  type AiRuntimeLogEntry,
  type AiRuntimeSession,
  type CodexAppServerManager,
  type CodexResponsesRuntime,
  createAiRuntimeSessionManager,
  createCodexRuntimeGenerationManager,
  createOptionalNodePtyRuntimeSpawn,
  isOfficialDeepSeekResponsesModel,
  listAiCliAdapters,
  modelConnectionCredentialSlotId,
  modelRef,
  piRuntimeWorkerProtocolVersion,
  readCodexProviderRuntimeHealth,
} from '@zeus/ai-runtime';
import { type GitDiffSummary, type GitStatusSummary } from '@zeus/git-core';
import { type ProjectGraph } from '@zeus/graph-engine';
import { type ProjectConfigSnapshot } from '@zeus/project-core';
import { type AutoUpdatePolicy, type ReleaseReadiness } from '@zeus/release-core';
import { createMacOSKeychainStore, type SecretPresenceLabel, type SecretStore } from '@zeus/security-core';
import {
  cloneTaskManagementStatusConfig,
  type ReadOnlyValidationDescriptor,
  taskBoardEmptyGroupId,
  type TaskBoardGroupProperty,
  type TaskManagementStatusConfig,
  type TaskPushParentContextSelection,
  type TaskPushRelatedContextSelection,
} from '@zeus/shared';
import {
  type AppendAuditLogInput,
  ArtifactStore,
  AuditLogRepository,
  CodexLegacyImportRepository,
  CodexUsageLedgerRepository,
  ColdEvidenceRepository,
  CommandArtifactRepository,
  CommandDefinitionRepository,
  CommandDeliveryRepository,
  CommandRunRepository,
  type ConversationCollaborationMode,
  ConversationExecutionRepository,
  ConversationGoalRepository,
  type ConversationPermissionMode,
  ConversationPlanActionRepository,
  ConversationProviderItemRepository,
  ConversationProviderSyncCheckpointRepository,
  ConversationRepository,
  ConversationResourceRepository,
  ConversationServerRequestRepository,
  ConversationSnapshotV2Repository,
  ConversationSubmissionRepository,
  ConversationSyncEventRepository,
  ConversationTurnRepository,
  type CreateTaskEventInput,
  createZeusDatabase,
  ExecutionHostHandoffRepository,
  ExecutionHostWorkRepository,
  GitSnapshotRepository,
  IdempotencyRequestRepository,
  introspectSqliteSchema,
  LongTermMemoryRepository,
  ProjectionDatabaseRuntimeManager,
  ProjectRepository,
  ProjectRepositoryRegistrationRepository,
  ProjectSharedPathRepository,
  ProviderEventReceiptRepository,
  RuntimeSessionRepository,
  SettingRepository,
  type SqlValue,
  TaskBoardRepository,
  TaskEnvironmentRepository,
  TaskEventFileProjectionRepository,
  TaskEventRepository,
  TaskIntegrationAttemptRepository,
  TaskIntegrationRepository,
  type TaskManagementStatus,
  TaskRepository,
  TaskTemplateRepository,
  TaskWorkspaceRepository,
  TerminalEventRepository,
  TurnChangeFileRepository,
  TurnChangeSetRepository,
  type ZeusAuditLogRecord,
  type ZeusConversationResourceRecord,
  type ZeusConversationWithMessagesRecord,
  type ZeusDatabase,
  type ZeusProjectRecord,
  type ZeusTaskRecord,
} from '@zeus/storage';
import { type TaskStatus } from '@zeus/task-core';
import { type TelegramMessageSender, type TelegramPollingService, type TelegramUpdate } from '@zeus/telegram-adapter';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, constants as fsConstants, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BrowserAutomationPort } from './browserAutomation.js';
import { clearPersistedGraphCache, compactProjectGraphForRuntimeCache, persistScanAndGraph } from './codeIntelligenceGraphCache.js';
import { applyCodeMapSettingsToGraph, parseJsonObject, resolveCodeMapScanRoot, resolveConfiguredSqliteDatabase, resolveImportedSchemaFiles } from './codeIntelligenceGraphStore.js';
import { isUnsafeCodeMapScanRoot, UnsafeCodeMapScanRootError } from './codeMapScanBoundary.js';
import { createCodexConfigImportService } from './codexConfigImportService.js';
import { createZeusSkillService } from './zeusSkillService.js';
import { type CodexLegacyImportService, createCodexLegacyImportService } from './codexLegacyImportService.js';
import { createCodexNativeConversationCoordinator } from './codexNativeConversationCoordinator.js';
import { CodexPublicCommandApplicationService } from './codexPublicCommandApplication.js';
import { type CodexRemoteControlSnapshot } from './codexPublicCommandRoutes.js';
import { createCodexUsageService } from './codexUsageService.js';
import { createContextDispatchAuditPort } from './contextDispatchAudit.js';
import { ContextDispatchApplicationService, type ContextDispatchEnvelope } from './contextDispatchService.js';
import { resolveVerifiedCodexModelBudget } from './codexVerifiedModelBudgetCatalog.js';
import { resolveCodexModelCacheBudget } from './codexModelCacheBudget.js';
import { createConversationApplicationOperations, isNativeApiRecord, nativeApiError } from './conversationApplicationOperations.js';
import { ConversationCapabilityQueryApplication } from './conversationCapabilityQueryApplication.js';
import { compareConversationStageUpdatedDesc, ConversationChoiceQueryApplication, type ProjectConversationAttentionState } from './conversationChoiceQueryApplication.js';
import { ConversationCommandApplication } from './conversationCommandApplication.js';
import { ConversationDispatchCommandApplication } from './conversationDispatchCommandApplication.js';
import { createConversationExecutionContextOperations } from './conversationExecutionContextOperations.js';
import { ConversationExecutionCoordinator, type ConversationExecutionRoute } from './conversationExecutionCoordinator.js';
import { ManagedConversationToolResultStore } from './conversationPortableContext.js';
import { ConversationQueueCoreMutationApplication } from './conversationQueueCoreMutationApplication.js';
import { isObjectLike, quotePosixShellArgument } from './conversationResourcePreview.js';
import { normalizeConversationResources } from './conversationResources.js';
import { ConversationSnapshotCompatibilityTracker } from './conversationSnapshotCompatibility.js';
import { ConversationSyncProtocol } from './conversationSyncProtocol.js';
import { type ConversationRealtimeSocket } from './conversationSyncRoutes.js';
import { classifyConversationEventDurability, conversationEventFlowBudgets, ConversationEventFlowControl } from './eventFlowControl.js';
import { ExecutionHostMutationAdmissionFence } from './executionHostHandoffApi.js';
import { ExecutionHostStopCommandApplication } from './executionHostStopCommandApplication.js';
import { GitCommandApplication } from './gitCommandApplication.js';
import { createGitIntegrationOperations } from './gitIntegrationOperations.js';
import { GraphConversationCommandApplication } from './graphConversationCommandApplication.js';
import { activateHeavyWorkerJobs, closeHeavyWorkerJobs, runCodeMapHeavyJob, runGitDiffHeavyJob, runGitStatusHeavyJob } from './heavyWorkerPool.js';
import { IntegrationCommandApplication } from './integrationCommandApplication.js';
import { migrateLegacyCodexThreads } from './legacyCodexThreadMigration.js';
import { registerLocalServerPlatformRoutes } from './localServerPlatformRoutes.js';
import {
  type AppShellSettingsSnapshot,
  codeMapSettingsKey,
  type CodeMapSettingsSnapshot,
  codexRemoteControlEnabledSettingKey,
  defaultCodeMapSettings,
  normalizeAppShellSettings,
  normalizeCodeMapSettings,
  normalizeRuntimeSettings,
  runtimeSettingsKey,
  type TaskAgentRunStatus,
} from './localServerSettingsNormalization.js';
import { createLocalServerSupportOperations, normalizeTelegramNotificationSettings, normalizeTelegramSecuritySettings } from './localServerSupportOperations.js';
import { ManagedPortableContextStore } from './managedPortableContextStore.js';
import { migrateMisplacedCodexThreadRollouts } from './misplacedCodexThreadMigration.js';
import { createModelConnectionService } from './modelConnectionService.js';
import { LocalApiPerformanceCollector } from './performanceObservability.js';
import { createPiNativeConversationCoordinator } from './piNativeConversationCoordinator.js';
import { ProjectGitQueryApplication } from './projectGitQueryApplication.js';
import { registerProviderRuntimeControlApi } from './providerRuntimeControlApi.js';
import { ProviderRuntimeRecoveryApplicationService } from './providerRuntimeRecoveryService.js';
import { createReadOnlyValidationPiCoordinator } from './readOnlyValidationPiCoordinator.js';
import { applyRuntimeLogRetention, markRuntimeLogRetentionCommitted, type RuntimeLogRetentionResult, sanitizeRuntimeFileName } from './runtimeLogRetention.js';
import { isSafeRuntimeProcessId } from './runtimeProcessIdentity.js';
import { type RuntimeSettingsSnapshot } from './runtimeQueryApplication.js';
import { RuntimeEphemeralCapabilityService, RuntimeSessionCommandApplication } from './runtimeSessionCommandApplication.js';
import { SettingsCommandApplication } from './settingsCommandApplication.js';
import { ensurePiGlobalAgentProjection, migrateRuntimeDirectory, prepareTaskAttachmentRoot, repairTaskAttachmentReferences } from './taskAttachmentLifecycle.js';
import { TaskEventFileProjectionService } from './taskEventFileProjectionService.js';
import { createTaskRuntimeOperations } from './taskRuntimeOperations.js';
import { TelegramCommandApplication } from './telegramCommandApplication.js';
import { createTurnChangeSetService } from './turnChangeSets.js';
import { createUsageOverviewService } from './usageOverviewService.js';
import { WorkManagementCommandApplication } from './workManagementCommandApplication.js';
import { WorkspaceGitCommandApplication } from './workspaceGitCommandApplication.js';
import { createZentaoCredentialService } from './zentaoCredentialService.js';
import { createZeusDataLayoutForDatabase, type ZeusDataLayout } from './zeusDataLayout.js';

export { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor, type ReadOnlyValidationApplicationIdentity } from './readOnlyValidation.js';

export type { GraphEdgeDetail, GraphNeighborhood, GraphSearchResult, GraphViewSnapshot } from './codeIntelligenceGraphStore.js';
export { prepareUnifiedConversationStoreMigration, readUnifiedConversationStoreMigrationStatus, type ConversationStoreMigrationStatus } from './conversationStoreMigration.js';

export type { BrowserAutomationContentItem, BrowserAutomationPort, BrowserAutomationToolCall } from './browserAutomation.js';
export { createConversationAttachmentGrant, resolveConversationAttachmentGrant } from './conversationAttachmentGrant.js';
export { createLegacyFlatZeusDataLayout, createZeusDataLayout, createZeusDataLayoutForDatabase } from './zeusDataLayout.js';
export type { ZeusDataLayout, ZeusDataLayoutKind, ZeusDataLifecycle, ZeusDataOwner, ZeusDataPathDescriptor, ZeusDataPathKey } from './zeusDataLayout.js';

export const zeusLocalServerHost = '127.0.0.1' as const;
const nativeConversationAttentionEventTypes = new Set([
  'conversation.turn.started',
  'conversation.turn.completed',
  'conversation.queue.changed',
  'conversation.request.created',
  'conversation.request.resolved',
  'conversation.native.error',
  'conversation.attention.changed',
  'conversation.attention.acknowledged',
  'conversation.goal.updated',
  'conversation.goal.cleared',
]);

/**
 * 非枚举启动失败元数据：表示新 local-server 已取得并尝试完成 Codex finalization。
 * Desktop 只能依据该结构化信号决定 owner，不能依赖错误文案。
 */
export const codexFinalizationOwnershipClaimSymbol = Symbol.for('@zeus/local-server/codex-finalization-ownership-claimed');
const codexFinalizationOwnershipClaims = new WeakSet<object>();

export function hasCodexFinalizationOwnershipClaim(error: unknown): boolean {
  if (!isObjectLike(error)) return false;
  if (codexFinalizationOwnershipClaims.has(error)) return true;
  try {
    return Reflect.get(error, codexFinalizationOwnershipClaimSymbol) === true;
  } catch {
    return false;
  }
}

function claimCodexFinalizationOwnership(error: unknown): unknown {
  const claimedError = isObjectLike(error) ? error : new Error('Local-server startup failed after Codex finalization ownership was claimed.', { cause: error });
  codexFinalizationOwnershipClaims.add(claimedError);
  try {
    Object.defineProperty(claimedError, codexFinalizationOwnershipClaimSymbol, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
  } catch {
    // Frozen errors still retain their identity and are recognized by this module's WeakSet.
  }
  return claimedError;
}

export interface CreateLocalServerOptions {
  dbPath: string;
  apiToken: string;
  /** Electron Main 派生并经 Execution Host bootstrap 贯穿；Core 不得自行回退到生产 service。 */
  keychainService: string;
  /** Zeus 本机数据路径登记表；未传入时从数据库所在目录生成兼容布局。 */
  dataLayout?: ZeusDataLayout;
  localConfigPath?: string;
  projectRoot?: string;
  currentAppVersion?: string | (() => string);
  executionHost?: {
    instanceId: string;
    protocolVersion: number;
    startedAt: string;
    mode: 'embedded' | 'detached';
  };
  telegramToken?: string;
  telegramAllowedUserIds?: number[];
  telegramNotificationChatIds?: number[];
  codexAppServerManager?: CodexAppServerManager;
  codexNativeEnabled?: boolean;
  codexRuntimeCommandPath?: string | (() => string);
  codexLegacyImportRoot?: string;
  codexHome?: string;
  codexConfigImportSourceRoot?: string;
  releaseUpdateManifestUrl?: string;
  allowUntrustedReleaseUpdateTest?: boolean;
  /** Electron Main 管理的任务附件目录；只允许服务端从任务记录引用。 */
  taskAttachmentRoot?: string;
  /** Electron Main 管理的浏览器截图目录；仅允许页面批注提交引用。 */
  browserAttachmentRoot?: string;
  /** Electron Main 管理的会话粘贴/拖放物化目录。 */
  conversationAttachmentRoot?: string;
  /** Electron Main 与 Local Server 共享的路径 capability 验签密钥。 */
  conversationAttachmentGrantSecret?: string;
  /** Electron Main 提供的内置浏览器自动化端口。 */
  browserAutomation?: BrowserAutomationPort;
  /** 仅由已核验 manifest 的 Main/Detached Core 传入；所有写入和外部能力必须失败关闭。 */
  readOnlyValidation?: ReadOnlyValidationDescriptor;
}

export interface SecurityAuditLogEntry {
  id: string;
  actorType: string;
  actorRef: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ZeusRealtimeEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RunningZeusLocalServer {
  server: FastifyInstance;
  host: typeof zeusLocalServerHost;
  port: number;
  baseUrl: string;
  prepareForShutdown: () => Promise<void>;
  close: () => Promise<void>;
}

type ZeusFastifyLifecycle = FastifyInstance & {
  prepareZeusShutdown?: () => Promise<void>;
};

export interface GraphConversationHistoryItem {
  id: string;
  projectId: string;
  taskId: string | null;
  sessionId: string | null;
  title: string;
  summary: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  messages: Array<{
    id: string;
    conversationId: string;
    role: string;
    content: string;
    source: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface GraphConversationHistoryPage {
  items: GraphConversationHistoryItem[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  archived: boolean;
}

export interface DashboardSnapshot {
  app: 'Zeus';
  localServer: { host: typeof zeusLocalServerHost; port: number | null };
  projects: ZeusProjectRecord[];
  tasks: ZeusTaskRecord[];
  conversationAttentionByProject: Record<string, ProjectConversationAttentionState>;
  conversationUnreadCountByProject: Record<string, number>;
  runtime: {
    aiCli: { available: boolean; reason: string };
    telegram: { enabled: boolean; reason: string };
  };
  git: GitStatusSummary;
  graph: { nodeCount: number; edgeCount: number; viewCount: number };
}

export interface RuntimeStatusSnapshot {
  aiCli: { name: string; command: string; available: boolean; reason: string };
  telegram: { enabled: boolean; reason: string };
  terminal: {
    provider: 'node-pty' | 'child_process';
    pty: { available: boolean; reason: string };
  };
}

export interface SecuritySecretsSnapshot {
  telegramBotToken: SecretPresenceLabel;
  externalApiKey: SecretPresenceLabel;
}

export interface ProjectDatabaseSecretSnapshot {
  connectionName: string | null;
  password: SecretPresenceLabel;
}

export interface SecurityResetResult {
  secrets: SecuritySecretsSnapshot;
  telegramNotificationSettings: TelegramNotificationSettingsSnapshot;
  telegramSecuritySettings: TelegramSecuritySettingsSnapshot;
}

export interface ReleaseStatusSnapshot {
  signing: { configured: boolean; label: string };
  notarization: { configured: boolean; label: string };
  homebrewCask: { configured: boolean; label: string };
  releaseWorkflow: { configured: boolean; label: string };
  readiness: ReleaseReadiness;
  autoUpdate: AutoUpdatePolicy;
}

export interface SaveProjectDatabaseSecretBody {
  password?: string;
}

export interface TelegramNotificationSettingsSnapshot {
  enabled: boolean;
  chatIds: number[];
  silentMode: boolean;
}

export interface TelegramSecuritySettingsSnapshot {
  allowedUserIds: number[];
}

export interface TelegramTestConnectionResult {
  ok: boolean;
  chatIds: number[];
  attempts: number;
  sentAt: string;
}

export interface TelegramStatusSnapshot {
  configured: boolean;
  reason: string;
  polling: ReturnType<TelegramPollingService['status']>;
  notificationSettings: TelegramNotificationSettingsSnapshot;
  securitySettings: TelegramSecuritySettingsSnapshot;
}

export interface TelegramSettingsSnapshot {
  notificationSettings: TelegramNotificationSettingsSnapshot;
  securitySettings: TelegramSecuritySettingsSnapshot;
}

export interface UpdateTelegramSettingsBody extends UpdateTelegramNotificationSettingsBody, UpdateTelegramSecuritySettingsBody {}

export interface UpdateTelegramNotificationSettingsBody {
  enabled?: boolean;
  chatIds?: number[];
  silentMode?: boolean;
}

export interface UpdateTelegramSecuritySettingsBody {
  allowedUserIds?: number[];
}

/** 归档确认只投影提示文案，不写项目、审计、Command 或外部状态。 */
export const projectArchiveConfirmationSideEffectDeclaration = {
  applicationMethod: 'ProjectRepository.prepareArchive',
  classification: 'read_only',
  writesBusinessState: false,
  commandLedger: 'not_applicable',
} as const;

export interface BatchTaskWorkspaceResult {
  workspaceId: string;
  repositoryName: string;
  repositoryRelativePath: string;
  status: 'succeeded' | 'skipped' | 'failed';
  message: string;
  headSha?: string;
}

export interface WorkspaceGitPreparedOpaque {
  projectId?: string;
  taskId?: string;
  repositoryId?: string;
  workspaceId?: string;
  integrationId?: string;
}

export interface WorkspaceGitExplicitRejection extends Error {
  workspaceGitExplicitRejection: true;
  statusCode: number;
  payload: unknown;
}

export interface CreateConversationMessageBody {
  content?: string;
  displayText?: string;
  composerDraft?: string;
  attachments?: NativeConversationAttachment[];
  browserComments?: unknown;
  browserCommentContent?: string;
  conversationContext?: unknown;
  delivery?: 'queue' | 'steer_now';
  expectedTurnId?: string;
  clientUserMessageId?: string;
  model?: string;
  effort?: string;
  serviceTier?: string | null;
  permissionMode?: ConversationPermissionMode;
  collaborationMode?: ConversationCollaborationMode;
  agentKind?: 'codex' | 'pi' | 'claude';
}

export interface NativeConversationAttachment {
  name: string;
  mime: string;
  size: number;
  localPath?: string;
  uploadRef?: string;
  kind?: 'image' | 'file' | 'directory' | 'pasted_text';
  /** 仅由服务端验签后注入，用于精确授权持久化路径。 */
  authorizedPath?: string;
  taskPushAttachmentKey?: string;
}

export type StartTaskConversationBody = (
  | {
      mode: 'create';
      content?: string;
      attachments?: NativeConversationAttachment[];
      inheritConversationId?: string;
      permissionMode?: ConversationPermissionMode;
      source?: 'task_push' | 'code_review' | 'conflict_resolution';
      model?: string;
      effort?: string;
      serviceTier?: string | null;
      workMode?: 'default' | 'plan';
      supplementalInfo?: string;
      supplementalAttachments?: NativeConversationAttachment[];
      taskContext?: {
        revision: string;
        parentSelections: TaskPushParentContextSelection[];
        relatedSelections: TaskPushRelatedContextSelection[];
      };
      integrationId?: string;
      conflictPath?: string;
      conflictContent?: string;
      goalObjective?: string;
      skillId?: string;
      workspace?:
        | { mode: 'direct'; confirmConcurrentWrites?: boolean }
        | {
            mode: 'create';
            repositoryRevision: string;
            repositories: Array<{
              repositoryId: string;
              sourceRef: string;
              branchName?: string;
              includeLocalChanges?: boolean;
            }>;
          }
        | { mode: 'create'; sourceRef: string; branchName?: string };
    }
  | { mode: 'resume'; conversationId: string; content: string }
  | { mode: 'reference_legacy'; sourceConversationId: string; messageIds: string[]; content: string; permissionMode?: ConversationPermissionMode }
) & {
  clientUserMessageId?: string;
  collaborationMode?: ConversationCollaborationMode;
  agentKind?: 'codex' | 'pi' | 'claude';
};

export interface StartProjectConversationBody {
  mode: 'create';
  content?: string;
  attachments?: NativeConversationAttachment[];
  permissionMode?: ConversationPermissionMode;
  collaborationMode?: ConversationCollaborationMode;
  serviceTier?: string | null;
  model?: string;
  effort?: string;
  clientUserMessageId?: string;
  agentKind?: 'codex' | 'pi' | 'claude';
  goalObjective?: string;
}

export interface TaskConversationAcceptanceReservation {
  scope: string;
  requestHash: string;
  operationId: string;
  conversationId: string;
  submissionId: string;
}

export type ProjectConversationAcceptanceReservation = TaskConversationAcceptanceReservation;

export type TelegramDispatchPreviewBody = TelegramUpdate;
const telegramNotificationSettingsKey = 'telegram.notificationSettings';
const telegramSecuritySettingsKey = 'telegram.securitySettings';

function resolveReleaseUpdateManifestUrl(configured: string | undefined, allowUntrustedTest: boolean): string {
  const fallback = 'https://github.com/imchenway/zeus/releases/latest/download/zeus-release-manifest.json';
  const candidate = configured?.trim() || fallback;
  const url = new URL(candidate);
  if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/imchenway/zeus/releases/')) return url.toString();
  if (allowUntrustedTest && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)) return url.toString();
  throw new Error('Zeus release update manifest URL is not trusted.');
}

const telegramRuntimeSummaryLogInterval = 5;
const NON_CODEX_LEGACY_HISTORY_LIMIT = 12;

export interface TelegramRuntimeConfirmation {
  id: string;
  taskId: string;
  projectId: string;
  action: 'run' | 'continue' | 'stop' | 'logs_full' | 'diff';
  createdAt: string;
  expiresAt: number;
  affectsTaskStatus: boolean;
  execute: () => Promise<string>;
}

/** 创建 Zeus 本地服务实例；监听动作由 Electron Main 决定。 */
export async function createLocalServer(options: CreateLocalServerOptions): Promise<FastifyInstance> {
  if (!options.readOnlyValidation) activateHeavyWorkerJobs();
  else await closeHeavyWorkerJobs();
  const startupStartedAt = performance.now();
  const traceStartup = (stage: string): void => {
    if (process.env.ZEUS_STARTUP_TIMING !== '1') return;
    console.info(`[Zeus startup] ${stage} ${Math.round(performance.now() - startupStartedAt)}ms`);
  };
  const db = await createZeusDatabase(options.dbPath, { readOnlyValidation: options.readOnlyValidation });
  traceStartup('database_ready');
  try {
    const server = await createLocalServerWithDatabase(options, db, traceStartup);
    traceStartup('local_server_created');
    return server;
  } catch (error) {
    try {
      db.discardAndClose();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Zeus local-server 启动与数据库回滚关闭同时失败。');
    }
    throw error;
  }
}

async function createLocalServerWithDatabase(options: CreateLocalServerOptions, db: ZeusDatabase, traceStartup: (stage: string) => void): Promise<FastifyInstance> {
  const readOnlyValidation = options.readOnlyValidation;
  const dataLayout = options.dataLayout ?? createZeusDataLayoutForDatabase(options.dbPath);
  if (resolve(dataLayout.database) !== resolve(options.dbPath)) throw new Error('Zeus 数据路径登记表与数据库路径不一致。');
  if (readOnlyValidation && (resolve(readOnlyValidation.validationRoot) !== resolve(dataLayout.root) || resolve(readOnlyValidation.database.path) !== resolve(options.dbPath))) {
    throw Object.assign(new Error('只读验证描述符与 Local Server 数据路径不一致。'), { code: 'ZEUS_READ_ONLY_VALIDATION_PATH_MISMATCH', statusCode: 503 });
  }
  const taskAttachmentRoot = readOnlyValidation ? undefined : prepareTaskAttachmentRoot(options.taskAttachmentRoot ?? dataLayout.taskAttachments);
  const attachmentRepair = readOnlyValidation ? { repairedAttachmentCount: 0, repairedTaskCount: 0, repairedPathCount: 0, repairedFieldCount: 0 } : repairTaskAttachmentReferences(db, taskAttachmentRoot);
  if (attachmentRepair.repairedAttachmentCount > 0) {
    await db.save();
    console.info(
      `Zeus 已修复 ${attachmentRepair.repairedTaskCount} 个历史任务中的 ${attachmentRepair.repairedAttachmentCount} 个附件引用（路径 ${attachmentRepair.repairedPathCount} 个，字段归属 ${attachmentRepair.repairedFieldCount} 个）。`,
    );
  }
  traceStartup('attachments_repaired');
  const projects = new ProjectRepository(db);
  const projectRepositories = new ProjectRepositoryRegistrationRepository(db);
  const projectSharedPaths = new ProjectSharedPathRepository(db);
  const tasks = new TaskRepository(db);
  const taskBoards = new TaskBoardRepository(db);
  const taskEnvironments = new TaskEnvironmentRepository(db);
  const taskWorkspaces = new TaskWorkspaceRepository(db);
  const taskConversationExecutionContextPromises = new Map<string, Promise<{ projectLocalPath: string; writableRoots: string[] } | null>>();
  const taskConversationReopenInProgressIds = new Set<string>();
  const taskIntegrations = new TaskIntegrationRepository(db);
  const taskIntegrationAttempts = new TaskIntegrationAttemptRepository(db);
  const taskConflictAiOperations = new Map<string, { conversationId: string; submissionId: string; running: boolean; finalizing: boolean }>();
  const taskEvents = new TaskEventRepository(db);
  const taskEventFileProjectionOutbox = new TaskEventFileProjectionRepository(db);
  const taskTemplates = new TaskTemplateRepository(db);
  const settingsIdentityCatalog = {
    hasProjectId: (projectId: string) => Boolean(projects.getById(projectId)),
    hasTaskTemplateId: (templateId: string) => Boolean(taskTemplates.getById(templateId)),
  };
  const runtimeSessions = new RuntimeSessionRepository(db);
  const commandDefinitions = new CommandDefinitionRepository(db);
  const commandRuns = new CommandRunRepository(db);
  const commandArtifacts = new CommandArtifactRepository(db);
  const artifactStore = new ArtifactStore(db, join(dataLayout.artifactsDirectory, 'content-addressed'), () => now().toISOString(), { writeFaultReporter: db });
  const projectionDatabases = new ProjectionDatabaseRuntimeManager({
    source: db,
    directory: join(dataLayout.dataDirectory, 'projections'),
    sourceDatabaseIdentity: resolve(options.dbPath),
    now: () => now().toISOString(),
  });
  if (!readOnlyValidation) await projectionDatabases.start();
  const terminalEvents = new TerminalEventRepository(db);
  const settings = new SettingRepository(db);
  const auditLogs = new AuditLogRepository(db);
  const conversations = new ConversationRepository(db);
  const conversationGoals = new ConversationGoalRepository(db);
  const codexUsageLedger = new CodexUsageLedgerRepository(db);
  const codexLegacyImports = new CodexLegacyImportRepository(db);
  const conversationTurns = new ConversationTurnRepository(db);
  const conversationProviderItems = new ConversationProviderItemRepository(db);
  const conversationResources = new ConversationResourceRepository(db);
  const turnChangeSets = new TurnChangeSetRepository(db, artifactStore);
  const turnChangeFiles = new TurnChangeFileRepository(db, artifactStore);
  const conversationSubmissions = new ConversationSubmissionRepository(db);
  const conversationExecution = new ConversationExecutionRepository(db);
  const conversationSnapshotV2 = new ConversationSnapshotV2Repository(db, artifactStore);
  const conversationSyncEvents = new ConversationSyncEventRepository(db);
  const longTermMemories = new LongTermMemoryRepository(db);
  const coldEvidence = new ColdEvidenceRepository(db);
  const conversationRequests = new ConversationServerRequestRepository(db);
  const executionHostHandoffs = new ExecutionHostHandoffRepository(db);
  const executionHostWork = new ExecutionHostWorkRepository(db);
  const conversationPlanActions = new ConversationPlanActionRepository(db);
  const conversationProviderSyncCheckpoints = new ConversationProviderSyncCheckpointRepository(db);
  const providerEventReceipts = new ProviderEventReceiptRepository(db);
  const commandDeliveries = new CommandDeliveryRepository(db);
  if (!readOnlyValidation) commandDeliveries.sealUnreceiptedProviderWritesAsUnknown(new Date().toISOString());
  const conversationCommands = new ConversationCommandApplication({ db, deliveries: commandDeliveries, redactSensitiveText, now: () => new Date() });
  const conversationDispatchCommands = new ConversationDispatchCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore, redactSensitiveText, now: () => new Date() });
  const graphConversationCommands = new GraphConversationCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore, redactSensitiveText, now: () => new Date() });
  const conversationQueueCoreMutations = new ConversationQueueCoreMutationApplication({
    submissions: conversationSubmissions,
    execution: conversationExecution,
    requests: conversationRequests,
    now: () => now().toISOString(),
    snapshot: (conversationId) => {
      const conversation = conversations.getById(conversationId);
      if (!conversation) throw new Error(`Zeus conversation not found: ${conversationId}`);
      return toNativeQueueApiSnapshot(conversation);
    },
  });
  const workManagementCommands = new WorkManagementCommandApplication({ db, deliveries: commandDeliveries, redactSensitiveText, now: () => new Date() });
  const runtimeSessionCommands = new RuntimeSessionCommandApplication({ db, deliveries: commandDeliveries, redactSensitiveText, now: () => new Date() });
  const gitCommands = new GitCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore, redactSensitiveText, now: () => new Date() });
  const workspaceGitCommands = new WorkspaceGitCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore, redactSensitiveText, now: () => new Date() });
  const integrationCommands = new IntegrationCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore, redactSensitiveText, now: () => new Date() });
  const settingsCommands = new SettingsCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore, redactSensitiveText, now: () => new Date() });
  const telegramCommands = new TelegramCommandApplication({ db, deliveries: commandDeliveries, redactSensitiveText, now: () => new Date() });
  const executionHostStopCommands = new ExecutionHostStopCommandApplication({ db, deliveries: commandDeliveries, redactSensitiveText, now: () => new Date() });
  const runtimeEphemeralCapabilities = new RuntimeEphemeralCapabilityService({ nowMs: () => Date.now() });
  const idempotencyRequests = new IdempotencyRequestRepository(db);
  const gitSnapshots = new GitSnapshotRepository(db);
  const portableContexts = new ManagedPortableContextStore(conversationExecution, artifactStore);
  const conversationExecutionCoordinator = new ConversationExecutionCoordinator({
    db,
    execution: conversationExecution,
    submissions: conversationSubmissions,
    portableContexts,
    commandDeliveries,
    now: () => now().toISOString(),
  });
  let dispatchUnifiedConversationQueueHead: ((conversationId: string) => Promise<void>) | null = null;
  const conversationToolResults = new ManagedConversationToolResultStore(dataLayout.conversationToolResults, conversationExecution, artifactStore);
  if (!readOnlyValidation) conversationExecution.setDispatchEnabled(false);
  if (!readOnlyValidation) await db.save();
  const executionHostAppVersion = (typeof options.currentAppVersion === 'function' ? options.currentAppVersion() : options.currentAppVersion)?.trim() || '0.0.0';
  const executionHostInstanceId = options.executionHost?.instanceId ?? `embedded-${process.pid}`;
  const executionHostHandoffRecovery = readOnlyValidation
    ? { outcome: 'none' as const }
    : executionHostHandoffs.recoverPrepared({
        claimingInstanceId: executionHostInstanceId,
        claimingAppVersion: executionHostAppVersion,
        restoredAt: new Date().toISOString(),
      });
  const executionHostDispatchMayResume = !readOnlyValidation && executionHostHandoffRecovery.outcome !== 'recovery_required';
  const recoveredInterruptedScans = executionHostDispatchMayResume ? projects.recoverInterruptedScans() : 0;
  if (recoveredInterruptedScans > 0) {
    // 上次进程在扫描中崩溃时不会进入 catch 分支；启动时恢复为 failed，避免项目永久停在“扫描中”且无法重试。
    await db.save();
  }
  const server = Fastify({ logger: false });
  const apiPerformance = new LocalApiPerformanceCollector();
  const executionHostMutationFence = new ExecutionHostMutationAdmissionFence(readOnlyValidation || executionHostDispatchMayResume ? 'open' : 'recovery_required');
  const conversationSnapshotCompatibility = new ConversationSnapshotCompatibilityTracker({
    rendererMigrated: false,
    maximumHistoryCopyAccepted: false,
    explicitReleaseApproval: false,
    requiredQuietDays: 30,
  });
  server.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) apiPerformance.begin(request, reply);
  });
  executionHostMutationFence.install(server);
  server.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) apiPerformance.capturePayload(request, reply, payload);
    return payload;
  });
  server.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/api/')) apiPerformance.finish(request, reply);
  });
  let closeLocalServerResources: (() => Promise<void>) | null = null;
  let removeStorageWriteFaultListener: (() => void) | null = null;
  server.addHook('onClose', async () => {
    apiPerformance.close();
    if (closeLocalServerResources) await closeLocalServerResources();
    else await db.close();
  });
  try {
    await server.register(websocketPlugin);
  } catch (error) {
    try {
      await server.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Zeus local-server 初始化与数据库关闭同时失败。');
    }
    throw error;
  }
  traceStartup('fastify_initialized');
  const projectRoot = options.projectRoot ?? process.cwd();
  const readGitStatus = async (cwd: string): Promise<GitStatusSummary> => (await runGitStatusHeavyJob(cwd)).status;
  const readGitDiff = async (cwd: string): Promise<GitDiffSummary> => (await runGitDiffHeavyJob(cwd)).diff;
  const releaseEnvironment = process.env;
  const releaseUpdateManifestUrl = resolveReleaseUpdateManifestUrl(options.releaseUpdateManifestUrl, Boolean(options.allowUntrustedReleaseUpdateTest));
  const activeProjectGraphScanIds = new Set<string>();
  const graphScanCommandOwners = new Map<string, string>();
  const telegramRuntimeConfirmations = new Map<string, TelegramRuntimeConfirmation>();
  const telegramRuntimeSummarySentLogCounts = new Map<string, Set<number>>();
  const telegramCommandRunMessages = new Map<string, { chatId: number; messageId?: number }>();
  const telegramCommandRunLogCounts = new Map<string, number>();
  const eventSubscribers = new Set<ConversationRealtimeSocket>();
  const nativeLocalEventGenerationId = `zeus-local-${randomUUID()}`;
  const conversationEventFlow = new ConversationEventFlowControl();
  const now = () => new Date();
  const realtimeSubscriberHighWaterBytes = conversationEventFlowBudgets.websocket.maximumBufferedBytes;
  // Provider 恢复、后台用量刷新和命令路由都可能在后续初始化阶段发布会话事件。
  // 同步协议必须先于这些发布者建立，避免异步回调命中尚未初始化的词法绑定。
  const conversationSyncProtocol = new ConversationSyncProtocol({
    db,
    repository: conversationSyncEvents,
    broadcast: broadcastRealtimeEvent,
    now,
    flowControl: conversationEventFlow,
  });
  // provider 可能以字符级频率发送增量；只在本地推送层合并同一 item，完成态仍是强制边界。
  const nativeDeltaCoalesceMs = 40;
  const pendingNativeDeltaEvents = new Map<string, { type: string; payload: Record<string, unknown>; byteLength: number }>();
  let pendingNativeDeltaBytes = 0;
  let nativeDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeEventSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeDeltaFlushFailure: Error | null = null;
  const nativeIdempotentInFlight = new Map<string, { requestHash: string; promise: Promise<{ statusCode: number; body: unknown }> }>();
  const telegramConfirmationTtlMs = 10 * 60 * 1000;
  const appShellSettingsKey = 'app.shell.settings';
  const codexAccountFingerprintSaltKey = 'codex.usage.account_fingerprint_salt';
  const conversationResourceBackfillSettingKey = 'conversation.resource_backfill';
  const conversationResourceBackfillRevision = '20260815_resource_projection';
  const localLogDirectory = dataLayout.localLogs;
  const localConfigPath = options.localConfigPath ?? dataLayout.localConfig;
  // 本地日志目录是设计书明确要求的物理落点；服务启动时创建，避免 UI 只展示一个不存在的路径。
  if (!readOnlyValidation) mkdirSync(localLogDirectory, { recursive: true });
  const taskEventFileProjection = new TaskEventFileProjectionService({
    db,
    outbox: taskEventFileProjectionOutbox,
    events: taskEvents,
    localLogDirectory,
    sanitizeTaskId: sanitizeRuntimeFileName,
    redactSensitiveText,
    now,
  });
  if (!readOnlyValidation) taskEventFileProjection.recover();
  const runtimeSessionDirectory = dataLayout.runtimeSessions;
  let telegramNotificationSettings: TelegramNotificationSettingsSnapshot = normalizeTelegramNotificationSettings(settings.getJson<TelegramNotificationSettingsSnapshot>(telegramNotificationSettingsKey), {
    enabled: true,
    chatIds: options.telegramNotificationChatIds ?? options.telegramAllowedUserIds ?? [],
    silentMode: false,
  });
  let telegramSecuritySettings: TelegramSecuritySettingsSnapshot = normalizeTelegramSecuritySettings(settings.getJson<TelegramSecuritySettingsSnapshot>(telegramSecuritySettingsKey), { allowedUserIds: options.telegramAllowedUserIds ?? [] });
  let runtimeSettings: RuntimeSettingsSnapshot = normalizeRuntimeSettings(settings.getJson<RuntimeSettingsSnapshot>(runtimeSettingsKey));
  const runRuntimeLogRetention = async (retentionDays = runtimeSettings.logRetentionDays): Promise<RuntimeLogRetentionResult> => {
    const result = applyRuntimeLogRetention({
      runtimeSessions,
      auditLogs,
      sessionRoot: runtimeSessionDirectory,
      retentionDays,
      now: now(),
    });
    if (result.quarantinedSessionCount > 0) await db.save();
    markRuntimeLogRetentionCommitted(result);
    return result;
  };
  if (!readOnlyValidation) await runRuntimeLogRetention();
  traceStartup('runtime_retention_ready');
  let codeMapSettings: CodeMapSettingsSnapshot = normalizeCodeMapSettings(settings.getJson<CodeMapSettingsSnapshot>(codeMapSettingsKey)) ?? defaultCodeMapSettings;
  let codexRemoteControlEnabled = settings.getJson<boolean>(codexRemoteControlEnabledSettingKey) === true;
  let memoryGraphCache: ProjectGraph | null = null;
  const persistedAppShellSettings = settings.getJson<AppShellSettingsSnapshot>(appShellSettingsKey);
  let appShellSettings: AppShellSettingsSnapshot = normalizeAppShellSettings(persistedAppShellSettings, localLogDirectory, localConfigPath, settingsIdentityCatalog);
  const missingTaskStatusProjectIds = projects
    .list()
    .map((project) => project.id)
    .filter((projectId) => !appShellSettings.taskManagementStatusByProject[projectId]);
  if (missingTaskStatusProjectIds.length > 0) {
    appShellSettings = {
      ...appShellSettings,
      taskManagementStatusByProject: {
        ...appShellSettings.taskManagementStatusByProject,
        ...Object.fromEntries(missingTaskStatusProjectIds.map((projectId) => [projectId, cloneTaskManagementStatusConfig(appShellSettings.taskManagementStatusTemplate)])),
      },
    };
  }
  if (
    !readOnlyValidation &&
    (missingTaskStatusProjectIds.length > 0 ||
      (persistedAppShellSettings &&
        (JSON.stringify(persistedAppShellSettings.taskTableColumns) !== JSON.stringify(appShellSettings.taskTableColumns) ||
          JSON.stringify(persistedAppShellSettings.taskTableColumnsByProject) !== JSON.stringify(appShellSettings.taskTableColumnsByProject) ||
          JSON.stringify(persistedAppShellSettings.taskTableEnumSortOrders) !== JSON.stringify(appShellSettings.taskTableEnumSortOrders) ||
          JSON.stringify(persistedAppShellSettings.taskManagementStatusTemplate) !== JSON.stringify(appShellSettings.taskManagementStatusTemplate) ||
          JSON.stringify(persistedAppShellSettings.taskManagementStatusByProject) !== JSON.stringify(appShellSettings.taskManagementStatusByProject) ||
          JSON.stringify(persistedAppShellSettings.taskStatusFilterByProject) !== JSON.stringify(appShellSettings.taskStatusFilterByProject) ||
          JSON.stringify(persistedAppShellSettings.taskViewModeByProject) !== JSON.stringify(appShellSettings.taskViewModeByProject) ||
          JSON.stringify(persistedAppShellSettings.taskPageViewByProject) !== JSON.stringify(appShellSettings.taskPageViewByProject) ||
          JSON.stringify(persistedAppShellSettings.taskExpandedIdsByProject) !== JSON.stringify(appShellSettings.taskExpandedIdsByProject) ||
          persistedAppShellSettings.sidebarConversationOrganization !== appShellSettings.sidebarConversationOrganization ||
          JSON.stringify(persistedAppShellSettings.sidebarConversationCollapsedStatusIdsByProject) !== JSON.stringify(appShellSettings.sidebarConversationCollapsedStatusIdsByProject))))
  ) {
    // 旧列键、旧默认顺序、新增列宽、项目筛选和侧栏会话组织偏好都只迁移一次并立即落库，避免每次启动重复改写本机视图配置。
    settings.setJson(appShellSettingsKey, appShellSettings);
    await db.save();
  }
  traceStartup('settings_ready');
  function resolveTaskManagementStatusConfigForProject(projectId: string): TaskManagementStatusConfig {
    return appShellSettings.taskManagementStatusByProject[projectId] ?? appShellSettings.taskManagementStatusTemplate;
  }

  function isConfiguredTaskManagementStatus(projectId: string, status: unknown): status is TaskManagementStatus {
    return typeof status === 'string' && resolveTaskManagementStatusConfigForProject(projectId).statuses.some((definition) => definition.id === status);
  }

  function taskBoardBranchStatus(taskId: string): string {
    const workspaces = taskWorkspaces.listByTask(taskId);
    if (workspaces.length === 0) return 'not_created';
    if (workspaces.some((workspace) => workspace.state === 'failed')) return 'action_required';
    if (workspaces.some((workspace) => workspace.state === 'ready')) return 'active';
    if (workspaces.some((workspace) => workspace.state === 'reclaimed')) return 'pushed';
    if (workspaces.some((workspace) => workspace.state === 'merged')) return 'merged';
    return 'discarded';
  }

  function taskBoardRunStatus(task: ZeusTaskRecord): TaskAgentRunStatus {
    const latestConversation = conversations
      .listRecordsByProject(task.projectId)
      .filter((conversation) => conversation.taskId === task.id)
      .sort(compareConversationStageUpdatedDesc)[0];
    if (!latestConversation) return 'not_started';
    return conversationChoiceQueries.toChoice(latestConversation).taskRunStatus;
  }

  function taskBoardGroupValues(task: ZeusTaskRecord, property: TaskBoardGroupProperty): string[] {
    if (property === 'managementStatus') return [task.managementStatus];
    if (property === 'priority') return [task.priority || taskBoardEmptyGroupId];
    if (property === 'taskType') return [task.taskType];
    if (property === 'tags') return task.tags.length > 0 ? task.tags : [taskBoardEmptyGroupId];
    if (property === 'parentTask') return [task.parentTaskId ?? taskBoardEmptyGroupId];
    if (property === 'runStatus') return [taskBoardRunStatus(task)];
    if (property === 'branchStatus') return [taskBoardBranchStatus(task.id)];
    return [task.createdFrom || taskBoardEmptyGroupId];
  }

  const secretStore: SecretStore = readOnlyValidation
    ? {
        getSecret: async () => undefined,
        setSecret: async () => {
          throw readOnlyValidationCapabilityError('Keychain 写入');
        },
        deleteSecret: async () => {
          throw readOnlyValidationCapabilityError('Keychain 删除');
        },
      }
    : createMacOSKeychainStore({ service: options.keychainService });
  const modelConnections = createModelConnectionService({
    settings,
    secretStore,
    save: () => db.save(),
    listProjectIds: () => projects.list().map((project) => project.id),
    now: () => now().toISOString(),
  });
  const contextDispatchAudit = createContextDispatchAuditPort({
    append: (input) => auditLogs.append(input),
    commit: () => db.save(),
    now,
  });
  const contextDispatch = new ContextDispatchApplicationService({
    memory: longTermMemories,
    coldEvidence,
    now,
    audit: contextDispatchAudit,
  });
  type ProviderDispatchContextInput = {
    provider: 'codex' | 'pi';
    conversationId: string;
    submissionId: string;
    projectId: string;
    projectLocalPath: string;
    taskId: string | null;
    modelId: string;
    modelSourceId: string | null;
    operationRisk: 'read_only' | 'local_write';
    currentInputCharacters: number;
    providerGenerationId: string | null;
  };
  type DispatchModelBudget = {
    contextWindowTokens: number;
    reservedOutputTokens: number;
    contextWindowSource: string;
    reservedOutputSource: string;
    checkedAt: string | null;
  };
  let resolveCodexDispatchModelBudget: ((modelId: string) => DispatchModelBudget | null) | null = null;

  async function compileProviderDispatchContext(input: ProviderDispatchContextInput): Promise<ContextDispatchEnvelope> {
    const project = projects.getById(input.projectId);
    if (!project) throw nativeApiError('ZEUS_CONTEXT_PROJECT_NOT_FOUND', '上下文编译找不到目标项目，已拒绝 Provider 派发。');
    const task = input.taskId ? tasks.getById(input.taskId) : undefined;
    if (input.taskId && !task) throw nativeApiError('ZEUS_CONTEXT_TASK_NOT_FOUND', '上下文编译找不到目标任务，已拒绝 Provider 派发。');
    if (task && task.projectId !== project.id) throw nativeApiError('ZEUS_CONTEXT_TASK_PROJECT_MISMATCH', '上下文任务与项目不一致，已拒绝 Provider 派发。');

    const configuredConnection = input.modelSourceId && input.modelSourceId !== 'codex' ? modelConnections.listMetadata().find((connection) => connection.id === input.modelSourceId) : undefined;
    const configuredModel = configuredConnection?.models.find((model) => model.id === input.modelId);
    if (configuredConnection && !configuredModel) throw nativeApiError('ZEUS_CONTEXT_MODEL_NOT_FOUND', '上下文编译找不到已冻结的模型配置，已拒绝 Provider 派发。');
    if (configuredModel) {
      const expectedAdapter = input.provider === 'codex' ? 'codex_app_server' : 'pi_sdk';
      if (configuredModel.runtimeAdapter !== expectedAdapter) throw nativeApiError('ZEUS_CONTEXT_RUNTIME_MODEL_MISMATCH', '上下文模型配置与真实运行适配器不一致，已拒绝 Provider 派发。');
    }

    const budget: DispatchModelBudget | null = configuredModel
      ? {
          contextWindowTokens: configuredModel.contextWindow,
          reservedOutputTokens: configuredModel.maxTokens,
          contextWindowSource: `model_connection:${configuredConnection!.id}:${configuredConnection!.updatedAt}`,
          reservedOutputSource: `model_connection:${configuredConnection!.id}:${configuredConnection!.updatedAt}`,
          checkedAt: configuredConnection!.updatedAt,
        }
      : input.provider === 'codex'
        ? (resolveCodexDispatchModelBudget?.(input.modelId) ?? null)
        : input.modelSourceId === null
          ? {
              contextWindowTokens: 256_000,
              reservedOutputTokens: 8_192,
              contextWindowSource: 'pi_sdk_0.83.0_runtime_fallback_256000',
              reservedOutputSource: 'pi_sdk_0.83.0_runtime_fallback_8192',
              checkedAt: null,
            }
          : null;
    if (!budget) throw nativeApiError('ZEUS_CONTEXT_MODEL_WINDOW_UNAVAILABLE', 'Provider 没有可核验的上下文窗口，已拒绝注入未受预算约束的上下文。');
    if (!Number.isSafeInteger(input.currentInputCharacters) || input.currentInputCharacters < 0) {
      throw nativeApiError('ZEUS_CONTEXT_INPUT_SIZE_INVALID', 'Provider 当前输入规模无效，已拒绝上下文编译。');
    }
    // 上游目前只提供字符数；按一字符一 token 做保守上界，不把估算伪装成真实 tokenizer。
    const currentInputTokens = input.currentInputCharacters;
    if (currentInputTokens > budget.contextWindowTokens) throw nativeApiError('ZEUS_CONTEXT_INPUT_BUDGET_EXCEEDED', '当前输入的保守 token 上界已超过模型窗口，已拒绝 Provider 派发。');
    const preflightTokenCount: ContextDispatchEnvelope['provider']['preflightTokenCount'] = {
      state: 'unavailable',
      exact: false,
      source: null,
      checkedAt: budget.checkedAt,
      reason: input.provider === 'codex' ? '当前 Codex app-server 没有请求前 token-count RPC；只能使用请求后的真实 usage 通知。' : 'Pi SDK 0.83.0 没有对完整待发请求进行精确预检计数的公共端口；运行后的 usage 不能替代预检。',
    };
    return contextDispatch.compileForDispatch({
      project: { id: project.id, localPath: input.projectLocalPath },
      task: task ? { id: task.id, code: task.taskCode } : null,
      provider: {
        id: input.provider === 'codex' ? 'codex' : `pi:${input.modelSourceId ?? 'custom'}`,
        modelId: input.modelId,
        contextWindowTokens: budget.contextWindowTokens,
        reservedOutputTokens: budget.reservedOutputTokens,
        currentInputTokens,
        capabilities: { applicationContext: true, untrustedContext: true, portableContext: true },
        preflightTokenCount,
      },
      operationRisk: input.operationRisk,
      sourceWatermarks: {
        'project.record': project.updatedAt,
        'task.record': task?.updatedAt ?? 'not_applicable',
        'provider.runtime_generation': input.providerGenerationId ?? 'unavailable',
        'provider.model_window_source': budget.contextWindowSource,
        'provider.reserved_output_source': budget.reservedOutputSource,
        'provider.current_input_count': currentInputTokens,
        'provider.current_input_counter': 'utf16_character_upper_bound_v1',
      },
      auditIdentity: {
        actorType: 'zeus_dispatch',
        actorRef: input.provider,
        conversationId: input.conversationId,
        submissionId: input.submissionId,
      },
    });
  }
  const zentaoCredentials = createZentaoCredentialService({
    settings,
    secretStore,
    save: () => db.save(),
    now: () => now().toISOString(),
  });
  const piAgentDirectory = readOnlyValidation ? dataLayout.piConfig : migrateRuntimeDirectory(join(dataLayout.root, 'pi-agent'), dataLayout.piConfig);
  const piSessionDirectory = readOnlyValidation ? dataLayout.piSessions : migrateRuntimeDirectory(join(dataLayout.root, 'pi-sessions'), dataLayout.piSessions);
  if (!readOnlyValidation) ensurePiGlobalAgentProjection(options.codexHome ?? dataLayout.codexHome, piAgentDirectory);
  const piNativeCoordinator = readOnlyValidation
    ? createReadOnlyValidationPiCoordinator(() => now().toISOString())
    : createPiNativeConversationCoordinator({
        db,
        commandDeliveries,
        conversations,
        turns: conversationTurns,
        providerItems: conversationProviderItems,
        submissions: conversationSubmissions,
        requests: conversationRequests,
        modelConnections,
        usageLedger: codexUsageLedger,
        agentDirectory: piAgentDirectory,
        sessionDirectory: piSessionDirectory,
        now: () => now().toISOString(),
        publish: publishNativeConversationEvent,
        redactSensitiveText,
        execution: conversationExecution,
        toolResults: conversationToolResults,
        compileDispatchContext: compileProviderDispatchContext,
      });
  const repairedPiConversationIdentityCount = piNativeCoordinator.repairPersistedConversationIdentities();
  const repairedPiAgentMessageProjectionCount = piNativeCoordinator.repairPersistedAgentMessageProjections();
  if (repairedPiConversationIdentityCount > 0 || repairedPiAgentMessageProjectionCount > 0) await db.save();
  const providerRuntimeRecovery = new ProviderRuntimeRecoveryApplicationService({
    commandDeliveries,
    readPiHealth: () => piNativeCoordinator.runtimeHealth(),
    recoverPi: () => piNativeCoordinator.recoverRuntime(),
    now: () => now().toISOString(),
  });
  registerProviderRuntimeControlApi({
    server,
    readCodexHealth: () => readCodexProviderRuntimeHealth(codexAppServerManager, () => now().toISOString()),
    readPiHealth: () => piNativeCoordinator.runtimeHealth(),
    recovery: providerRuntimeRecovery,
  });
  traceStartup('pi_recovery_ready');
  const runtimePersistenceWrites = new Set<Promise<void>>();
  const runtimePersistenceErrors: unknown[] = [];
  let runtimePersistenceSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let runtimePersistenceSavePending = false;
  const runtimeLogFileBatches = new Map<string, AiRuntimeLogEntry[]>();
  const runtimeLogFileWriteErrors: unknown[] = [];
  let runtimeLogFileFlushTimer: ReturnType<typeof setTimeout> | undefined;
  const optionalNodePty = createOptionalNodePtyRuntimeSpawn();
  const runtimeTerminalStatus: RuntimeStatusSnapshot['terminal'] = {
    provider: optionalNodePty.spawn ? 'node-pty' : 'child_process',
    pty: {
      available: optionalNodePty.available,
      reason: optionalNodePty.reason,
    },
  };
  const aiRuntimeManager = createAiRuntimeSessionManager({
    allowedRoot: projectRoot,
    allowedRoots: () => projects.list().map((project) => project.localPath),
    spawn: optionalNodePty.spawn,
    onSessionChange: persistRuntimeSession,
    onProcessIdentity: async ({ sessionId, token }) => {
      runtimeSessions.setProcessIdentity(sessionId, token);
      // 身份必须先提交到 WAL 再启动子进程；否则 App 在 spawn 后瞬间崩溃会留下无法安全核验的孤儿树。
      await db.save();
    },
    onProcessStarted: async ({ sessionId, pid }) => {
      if (!isSafeRuntimeProcessId(pid)) throw new Error(`Runtime 会话 ${sessionId} 未返回可持久化的进程组标识。`);
      runtimeSessions.updateStatus(sessionId, { status: 'running', pid });
      // spawn 后立即持久化 PID/PGID；完成前启动调用不会返回，失败则 manager 会强杀刚创建的进程树。
      await db.save();
    },
    onLog: persistRuntimeLog,
  });
  const ownsCodexAppServerManager = options.codexAppServerManager === undefined;
  const codexNativeEnabled = !readOnlyValidation && options.codexNativeEnabled !== false;
  const conversationChoiceQueries = new ConversationChoiceQueryApplication({
    projects,
    tasks,
    conversations,
    requests: conversationRequests,
    submissions: conversationSubmissions,
    turns: conversationTurns,
    workspaces: taskWorkspaces,
    codexNativeEnabled,
    readOnlyValidation: Boolean(readOnlyValidation),
  });
  const codexRuntimeCommandPath = options.codexRuntimeCommandPath;
  const configuredCodexRuntimeCommandPath = () => runtimeSettings.adapterCliPaths.codex?.trim() || (typeof codexRuntimeCommandPath === 'function' ? codexRuntimeCommandPath() : codexRuntimeCommandPath) || undefined;
  const codexExternalAgentHome = options.codexLegacyImportRoot
    ? (() => {
        mkdirSync(options.codexLegacyImportRoot!, { recursive: true, mode: 0o700 });
        return realpathSync(options.codexLegacyImportRoot!);
      })()
    : undefined;
  const configuredCodexHome = readOnlyValidation ? undefined : (options.codexHome ?? dataLayout.codexHome);
  const codexHome = configuredCodexHome
    ? (() => {
        mkdirSync(configuredCodexHome, { recursive: true, mode: 0o700 });
        return realpathSync(configuredCodexHome);
      })()
    : undefined;
  if (codexNativeEnabled && codexHome && options.codexConfigImportSourceRoot) {
    try {
      const migration = await migrateMisplacedCodexThreadRollouts({
        db,
        conversations,
        sourceCodexHome: options.codexConfigImportSourceRoot,
        targetCodexHome: codexHome,
      });
      if (migration.candidateCount > 0) {
        auditLogs.append({
          actorType: 'system',
          action: 'conversation.codex_thread_storage.migrate',
          resourceType: 'conversation',
          payload: {
            candidateCount: migration.candidateCount,
            copiedCount: migration.copied.length,
            existingCount: migration.existing.length,
            skippedCount: migration.skipped.length,
            migratedAt: now().toISOString(),
            migrated: [...migration.copied, ...migration.existing],
            skipped: migration.skipped,
          },
          createdAt: now().toISOString(),
        });
        await db.save();
      }
    } catch (migrationError) {
      auditLogs.append({
        actorType: 'system',
        action: 'conversation.codex_thread_storage.migrate_failed',
        resourceType: 'conversation',
        payload: { errorType: migrationError instanceof Error ? migrationError.name : typeof migrationError },
        createdAt: now().toISOString(),
      });
      await db.save();
    }
  }
  traceStartup('codex_thread_storage_ready');
  const readCodexRemoteControlStandalone = (): CodexRemoteControlSnapshot['managedStandalone'] => {
    if (!codexHome) {
      return {
        available: false,
        commandPath: null,
        installCommand: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      };
    }
    const commandPath = join(codexHome, 'packages', 'standalone', 'current', 'codex');
    let available = false;
    try {
      accessSync(commandPath, fsConstants.X_OK);
      available = true;
    } catch {
      // Remote Control 只能使用官方安装器在当前 CODEX_HOME 登记的固定入口。
    }
    const installDirectory = join(codexHome, 'bin');
    return {
      available,
      commandPath,
      installCommand: `curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_HOME=${quotePosixShellArgument(codexHome)} CODEX_INSTALL_DIR=${quotePosixShellArgument(installDirectory)} sh`,
    };
  };
  const requireCodexRemoteControlCommandPath = (): string => {
    const standalone = readCodexRemoteControlStandalone();
    if (standalone.available && standalone.commandPath) return standalone.commandPath;
    throw Object.assign(
      nativeApiError(
        'ZEUS_CODEX_REMOTE_CONTROL_STANDALONE_REQUIRED',
        `Zeus 已检测到普通 Codex CLI，但远程接管必须在 Zeus 独立 Codex 目录中使用官方独立安装版。当前缺少 ${standalone.commandPath ?? '受管理的 Codex 固定入口'}。请运行：${standalone.installCommand}。安装后在 Zeus 完成 Codex 登录并点击刷新；Zeus 不会自动安装，也不会借用其他 CODEX_HOME 的守护进程。`,
      ),
      { statusCode: 409 },
    );
  };
  const currentCodexRuntimeCommandPath = () => (codexRemoteControlEnabled ? requireCodexRemoteControlCommandPath() : configuredCodexRuntimeCommandPath() || 'codex');
  const codexConfigImportService =
    codexHome && options.codexConfigImportSourceRoot
      ? createCodexConfigImportService({
          sourceRoot: options.codexConfigImportSourceRoot,
          targetRoot: codexHome,
          backupRoot: dataLayout.codexConfigImportBackups,
          now,
        })
      : undefined;
  const browserAttachmentRoot = readOnlyValidation ? undefined : prepareTaskAttachmentRoot(options.browserAttachmentRoot ?? dataLayout.browserComments);
  const conversationAttachmentRoot = readOnlyValidation ? undefined : prepareTaskAttachmentRoot(options.conversationAttachmentRoot ?? dataLayout.conversationAttachments);
  const trustedConversationAttachmentRoots = [taskAttachmentRoot, browserAttachmentRoot, conversationAttachmentRoot].filter((root): root is string => Boolean(root));
  const generatedImageRoot = codexHome ? join(codexHome, 'generated_images') : undefined;
  const conversationExecutionContextOperations = createConversationExecutionContextOperations({
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
  });
  const {
    taskManagementStatusIsTerminal,
    taskConflictExecutionForConversation,
    taskConversationExecutionWorkspaceMode,
    resolveNativeConversationExecutionRoot,
    ensureNativeConversationExecutionContext,
    resolveTaskEnvironmentWritableRoots,
    mirrorTaskEnvironmentContainer,
    overlayTaskEnvironmentSharedPaths,
  } = conversationExecutionContextOperations;
  const resourceBackfillState = settings.getJson<{ revision?: string }>(conversationResourceBackfillSettingKey);
  if (!readOnlyValidation && resourceBackfillState?.revision !== conversationResourceBackfillRevision) {
    const existingResourceCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM conversation_resources`)?.count ?? 0;
    let conversationResourceBackfillCount = 0;
    // 资源表已有投影说明旧版启动回填已经实际运行；只补登记，不再把全部历史正文读入内存重算一次。
    if (existingResourceCount === 0) {
      for (const conversation of conversations.listNativeBoundRecords()) {
        const project = projects.getById(conversation.projectId);
        if (!project) continue;
        const conversationExecutionRoot = resolveNativeConversationExecutionRoot(conversation);
        // 任务会话的文件属于独立 worktree；执行根不可恢复时不能回退到项目主目录重写资源。
        if (!conversationExecutionRoot) continue;
        const submissions = conversationSubmissions.listByConversation(conversation.id);
        const existingResourcesByItem = new Map<string, ReturnType<typeof conversationResources.listByItem>>();
        for (const resource of conversationResources.listByConversation(conversation.id)) {
          const existing = existingResourcesByItem.get(resource.itemId) ?? [];
          existing.push(resource);
          existingResourcesByItem.set(resource.itemId, existing);
        }
        for (const item of conversationProviderItems.listByConversation(conversation.id)) {
          const submission = item.itemType === 'userMessage' ? submissions.find((candidate) => candidate.providerTurnId === item.providerTurnId) : undefined;
          const payload = parseJsonObject(item.payloadJson);
          const normalized = normalizeConversationResources({
            projectId: conversation.projectId,
            projectRoot: conversationExecutionRoot,
            conversationId: conversation.id,
            turnId: item.turnId,
            item,
            payload: submission ? { ...payload, attachments: parseJsonObject(submission.inputJson).attachments } : payload,
            text: item.textContent,
            trustedAttachmentRoots: trustedConversationAttachmentRoots,
            generatedImageRoot,
            now: item.updatedAt,
          });
          const existing = existingResourcesByItem.get(item.id) ?? [];
          if (conversationResourceRecordsEqual(existing, normalized)) continue;
          conversationResources.replaceForItem(item.id, normalized, item.updatedAt);
          conversationResourceBackfillCount += Math.max(normalized.length, existing.length);
        }
      }
    }
    settings.setJson(conversationResourceBackfillSettingKey, {
      revision: conversationResourceBackfillRevision,
      completedAt: now().toISOString(),
      projectedResourceCount: existingResourceCount + conversationResourceBackfillCount,
      adoptedExistingProjection: existingResourceCount > 0,
    });
    await db.save();
  }
  traceStartup('conversation_resources_ready');
  const turnChangeSetService = createTurnChangeSetService({
    db,
    changeSets: turnChangeSets,
    files: turnChangeFiles,
    projects,
    auditLogs,
    idempotency: idempotencyRequests,
    recoveryRoot: dataLayout.turnChangeSets,
    getConversationRoot: (conversationId) => {
      const conversation = conversations.getRecordById(conversationId);
      return conversation ? resolveNativeConversationExecutionRoot(conversation) : null;
    },
    broadcast: publishNativeConversationEvent,
    now: () => now().toISOString(),
    readOnlyValidation: Boolean(readOnlyValidation),
  });
  let settleCodexPendingOnClose = ownsCodexAppServerManager;
  let codexAccountFingerprintSalt = settings.getJson<string>(codexAccountFingerprintSaltKey)?.trim();
  if (!codexAccountFingerprintSalt) {
    codexAccountFingerprintSalt = readOnlyValidation ? readOnlyValidation.manifestHash : randomUUID();
    if (!readOnlyValidation) {
      settings.setJson(codexAccountFingerprintSaltKey, codexAccountFingerprintSalt);
      await db.save();
    }
  }
  if (readOnlyValidation && !options.codexAppServerManager) throw readOnlyValidationCapabilityError('缺少只读 Provider 空实现');
  const codexAppServerManager =
    options.codexAppServerManager ??
    createCodexRuntimeGenerationManager({
      accountFingerprintSalt: codexAccountFingerprintSalt,
      ...(codexHome ? { codexHome } : {}),
    });
  const codexPublicCommands = new CodexPublicCommandApplicationService({
    db,
    deliveries: commandDeliveries,
    artifacts: artifactStore,
    now,
  });
  const ensureSkillProviderCatalogReady = () =>
    codexAppServerManager
      .ensureReady({
        commandPath: currentCodexRuntimeCommandPath(),
        ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}),
      })
      .then(() => undefined);
  const zeusSkillService = codexHome
    ? createZeusSkillService({
        skillsRoot: join(codexHome, 'skills'),
        manager: codexAppServerManager,
        ensureReady: ensureSkillProviderCatalogReady,
        now,
      })
    : undefined;
  resolveCodexDispatchModelBudget = (modelId) => {
    const state = codexAppServerManager.getState();
    if (state.type !== 'ready') return null;
    const model = resolveModelCapability(state.capabilities.models, modelId);
    if (!model) return null;
    const contextWindowTokens = positiveIntegerOrNull(model.raw.contextWindow ?? model.raw.context_window ?? model.raw.modelContextWindow ?? model.raw.model_context_window);
    const modelCacheEvidence = contextWindowTokens ? null : resolveCodexModelCacheBudget({ codexHome: codexHome ?? null, providerVersion: state.capabilities.providerVersion, modelId: model.model, now: now() });
    // 上下文窗口与输出预留是两份独立证据。CLI 缓存当前只证明 context_window，
    // 不能因此丢弃同版本、同模型已经核验的 reservedOutputTokens。
    const verifiedFallback = resolveVerifiedCodexModelBudget(state.capabilities.providerVersion, model.model);
    if (!contextWindowTokens && !modelCacheEvidence && !verifiedFallback) return null;
    const reportedReservedOutput = positiveIntegerOrNull(model.raw.maxOutputTokens ?? model.raw.max_output_tokens ?? model.raw.maximumOutputTokens ?? model.raw.maximum_output_tokens);
    const effectiveContextWindow = contextWindowTokens ?? modelCacheEvidence?.contextWindowTokens ?? verifiedFallback!.contextWindowTokens;
    const reservedOutputTokens = Math.min(effectiveContextWindow, reportedReservedOutput ?? verifiedFallback?.reservedOutputTokens ?? Math.min(32_768, Math.max(8_192, Math.floor(effectiveContextWindow / 8))));
    const contextWindowSource = contextWindowTokens ? `codex_app_server:${state.capabilities.generationId}:model_catalog` : (modelCacheEvidence?.evidenceSource ?? verifiedFallback!.evidenceSource);
    return {
      contextWindowTokens: effectiveContextWindow,
      reservedOutputTokens,
      contextWindowSource,
      reservedOutputSource: reportedReservedOutput ? `codex_app_server:${state.capabilities.generationId}:model_catalog` : verifiedFallback ? verifiedFallback.evidenceSource : 'zeus_conservative_window_eighth_max_32768',
      checkedAt: modelCacheEvidence?.checkedAt ?? verifiedFallback?.checkedAt ?? state.capabilities.initializedAt,
    };
  };

  async function activateCurrentCodexConfiguration(): Promise<{ runtimeReloaded: true; runtimeGenerationId: string; restartRequired: false }> {
    if (!codexAppServerManager.activateFreshGeneration) {
      throw nativeApiError('ZEUS_CODEX_CONFIG_HOT_RELOAD_UNAVAILABLE', '当前 Codex 运行服务不支持配置热启用。');
    }
    const capabilities = await codexAppServerManager.activateFreshGeneration({
      commandPath: currentCodexRuntimeCommandPath(),
      ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}),
    });
    return { runtimeReloaded: true, runtimeGenerationId: capabilities.generationId, restartRequired: false };
  }

  async function resolveResponsesRuntime(input: { modelSourceId: string | null; model: string }): Promise<CodexResponsesRuntime | null> {
    if (!input.modelSourceId || input.modelSourceId === 'codex') return null;
    const connections = await modelConnections.loadRuntimeConnections();
    const connection = connections.find((candidate) => candidate.id === input.modelSourceId);
    const model = connection?.models.find((candidate) => candidate.id === input.model);
    if (!connection || !model || !isOfficialDeepSeekResponsesModel(connection, model.id)) return null;
    if (!connection.enabled || !model.enabled || !connection.apiKey) {
      throw nativeApiError('ZEUS_CODEX_PROVIDER_CREDENTIAL_UNAVAILABLE', 'DeepSeek 官方 Responses 会话缺少可用的连接或 API Key。');
    }
    const environment: Record<string, string> = {};
    for (const candidate of connections) {
      if (!candidate.enabled || !candidate.apiKey || !candidate.models.some((item) => item.enabled && isOfficialDeepSeekResponsesModel(candidate, item.id))) continue;
      environment[deepSeekResponsesEnvKey(candidate.id)] = candidate.apiKey;
    }
    const identity = createHash('sha256').update(connection.id).digest('hex').slice(0, 24);
    return {
      provider: {
        id: `zeus_deepseek_${identity}`,
        name: `DeepSeek · ${connection.name}`,
        baseUrl: 'https://api.deepseek.com',
        envKey: deepSeekResponsesEnvKey(connection.id),
        modelContextWindow: model.contextWindow,
      },
      environment,
    };
  }

  function deepSeekResponsesEnvKey(connectionId: string): string {
    const identity = createHash('sha256').update(connectionId).digest('hex').slice(0, 24).toUpperCase();
    return `ZEUS_MODEL_CONNECTION_${identity}_API_KEY`;
  }
  const codexUsageService = createCodexUsageService({
    manager: codexAppServerManager,
    ledger: codexUsageLedger,
    conversations,
    projects,
    settings,
    broadcast: publishRealtimeEvent,
    persist: () => db.save(),
    now: () => now().toISOString(),
    repairLegacyCodexSourceAlias: !readOnlyValidation,
  });
  const usageOverviewService = createUsageOverviewService({
    ledger: codexUsageLedger,
    codexUsage: codexUsageService,
    modelConnections,
    now,
  });
  let usageRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let usageRefreshInFlight: Promise<void> | undefined;
  const refreshOfficialUsageInBackground = async (): Promise<void> => {
    // 后台用量刷新只能复用已经由用户操作启动的 Codex，应用首次打开不得为读取用量而执行外部 CLI。
    if (codexAppServerManager.getState().type !== 'ready') return;
    const official = await codexUsageService.refreshOfficialUsage();
    publishRealtimeEvent('usage.changed', { providerId: 'codex', scope: 'official', stale: official.stale, updatedAt: now().toISOString() });
  };
  const scheduleOfficialUsageRefresh = (): void => {
    if (usageRefreshInFlight) return;
    const refresh = refreshOfficialUsageInBackground();
    usageRefreshInFlight = refresh;
    void refresh
      .catch(() => undefined)
      .finally(() => {
        if (usageRefreshInFlight === refresh) usageRefreshInFlight = undefined;
      });
  };
  if (!readOnlyValidation) {
    scheduleOfficialUsageRefresh();
    usageRefreshTimer = setInterval(scheduleOfficialUsageRefresh, 60_000);
    usageRefreshTimer.unref?.();
  }
  let codexNativeCoordinator: ReturnType<typeof createCodexNativeConversationCoordinator>;
  try {
    codexNativeCoordinator = createCodexNativeConversationCoordinator({
      manager: codexAppServerManager,
      enabled: codexNativeEnabled,
      commandPath: currentCodexRuntimeCommandPath,
      externalAgentHome: codexExternalAgentHome,
      db,
      conversations,
      turns: conversationTurns,
      providerItems: conversationProviderItems,
      resources: conversationResources,
      changeSets: turnChangeSetService,
      submissions: conversationSubmissions,
      requests: conversationRequests,
      planActions: conversationPlanActions,
      goals: conversationGoals,
      receipts: providerEventReceipts,
      syncCheckpoints: conversationProviderSyncCheckpoints,
      settings,
      usage: codexUsageService,
      execution: conversationExecution,
      commandDeliveries,
      toolResults: conversationToolResults,
      eventFlow: conversationEventFlow,
      resolveResponsesRuntime,
      browserAutomation: options.browserAutomation,
      trustedAttachmentRoots: trustedConversationAttachmentRoots,
      generatedImageRoot,
      getProjectRoot: (projectId) => projects.getById(projectId)?.localPath ?? null,
      ensureExecutionContext: ensureNativeConversationExecutionContext,
      compileDispatchContext: compileProviderDispatchContext,
      broadcast: publishNativeConversationEvent,
      now: () => now().toISOString(),
    });
  } catch (factoryError) {
    const cleanupErrors: unknown[] = [];
    try {
      await server.close();
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
    if (cleanupErrors.length > 0) throw new AggregateError([factoryError, ...cleanupErrors], 'Zeus native coordinator creation and cleanup failed.');
    throw factoryError;
  }
  const unifiedQueueDispatches = new Set<string>();
  dispatchUnifiedConversationQueueHead = async (conversationId) => {
    if (unifiedQueueDispatches.has(conversationId) || !conversationExecution.isDispatchEnabled()) return;
    const conversation = conversations.getById(conversationId);
    if (!conversation || conversation.archived) return;
    if (conversationTurns.listByConversation(conversationId).some((turn) => turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching')) return;
    const head = conversationSubmissions
      .listQueueByConversation(conversationId)
      .filter((submission) => !submission.providerTurnId && (submission.status === 'queued' || submission.status === 'paused' || submission.status === 'failed'))
      .at(0);
    if (!head || head.status !== 'queued' || !head.executionSnapshotId) return;
    const frozen = conversationExecution.getExecutionSnapshot(head.executionSnapshotId);
    if (!frozen) {
      conversationSubmissions.updateStatus(head.id, 'paused', { pausedReason: 'recovery_required', updatedAt: now().toISOString() });
      await db.save();
      return;
    }
    unifiedQueueDispatches.add(conversationId);
    try {
      const persisted = isNativeApiRecord(JSON.parse(head.inputJson)) ? (JSON.parse(head.inputJson) as Record<string, unknown>) : {};
      const content = typeof persisted.text === 'string' ? persisted.text : '';
      const workspaceIdentity = isNativeApiRecord(JSON.parse(frozen.workspaceIdentityJson)) ? (JSON.parse(frozen.workspaceIdentityJson) as Record<string, unknown>) : {};
      const project = projects.getById(conversation.projectId);
      if (!project) throw nativeApiError('ZEUS_PROJECT_NOT_FOUND', 'Conversation project was not found.');
      const executionRoot = typeof workspaceIdentity.executionRoot === 'string' ? workspaceIdentity.executionRoot : project.localPath;
      const connection = frozen.connectionId ? await modelConnections.get(frozen.connectionId) : undefined;
      const configuredModel = connection?.models.find((model) => model.id === frozen.modelId);
      if (frozen.connectionId) {
        const currentRuntimeKind = configuredModel?.runtimeAdapter === 'codex_app_server' ? 'codex' : configuredModel?.runtimeAdapter === 'pi_sdk' ? 'pi' : null;
        const currentCredentialSlotId = connection && configuredModel ? modelConnectionCredentialSlotId(connection.id, configuredModel.authenticationScheme) : null;
        const mismatch = {
          connectionMissing: !connection,
          modelMissingOrDisabled: !configuredModel?.enabled,
          endpointChanged: Boolean(connection && connection.baseUrl !== frozen.endpointIdentity),
          protocolChanged: Boolean(configuredModel && configuredModel.protocolFamily !== frozen.protocolFamily),
          authenticationChanged: Boolean(currentCredentialSlotId && currentCredentialSlotId !== frozen.credentialSlotId),
          runtimeChanged: currentRuntimeKind !== null && currentRuntimeKind !== frozen.runtimeKind,
        };
        if (Object.values(mismatch).some(Boolean)) {
          const pausedAt = now().toISOString();
          conversationSubmissions.updateStatus(head.id, 'paused', {
            pausedReason: 'semantic_route_changed',
            error: { code: 'ZEUS_CONVERSATION_ROUTE_CHANGED', message: '排队后模型端点、协议或运行路由发生变化，需要改路由 replacement。', mismatch },
            updatedAt: pausedAt,
          });
          conversationExecution.pauseQueueBehindHead(conversationId, head.id, pausedAt);
          conversationExecution.persistWarning({ conversationId, warningKind: 'semantic_route_changed', payload: { submissionId: head.id, mismatch }, occurredAt: pausedAt });
          await db.save();
          publishNativeConversationEvent('conversation.queue.changed', { conversationId, submissionId: head.id });
          return;
        }
      }
      const route: ConversationExecutionRoute = {
        runtimeKind: frozen.runtimeKind,
        connectionId: frozen.connectionId,
        credentialSlotId: frozen.credentialSlotId,
        endpointIdentity: frozen.endpointIdentity,
        protocolFamily: frozen.protocolFamily,
        modelId: frozen.modelId,
        effort: frozen.effort,
        serviceTier: frozen.serviceTier,
        permissionMode: frozen.permissionMode,
        collaborationMode: frozen.collaborationMode,
        workspaceIdentity,
        providerId: frozen.runtimeKind === 'codex' ? 'codex' : `pi:${frozen.connectionId ?? 'custom'}`,
        providerModel: frozen.connectionId ? modelRef(frozen.connectionId, frozen.modelId) : frozen.modelId,
        providerProtocolVersion: frozen.runtimeKind === 'codex' ? 'app-server' : piRuntimeWorkerProtocolVersion,
        providerBinaryVersion: frozen.runtimeKind === 'pi' ? 'pi-sdk-0.83.0' : null,
      };
      const lifecycle = conversationExecutionCoordinator.createLifecycle({
        conversationId,
        route,
        targetCapabilities: {
          readableReasoningSummary: true,
          media: configuredModel?.capability.imageInput.state !== 'unsupported',
          contextWindow: configuredModel?.contextWindow ?? null,
          currentInputCharacters: content.length,
        },
        userHistoryContent: { text: content },
      });
      if (frozen.runtimeKind === 'pi') {
        if (lifecycle.requiresNewSegment) {
          await piNativeCoordinator.startConversation({
            conversationId,
            submissionId: head.id,
            projectId: conversation.projectId,
            ...(conversation.taskId ? { taskId: conversation.taskId } : {}),
            ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
            ...(conversation.environmentId ? { environmentId: conversation.environmentId } : {}),
            conversationTitle: conversation.title,
            cwd: executionRoot,
            prompt: content,
            model: { sourceId: frozen.connectionId, modelId: frozen.modelId, displayName: null },
            ...(frozen.effort ? { thinkingLevel: frozen.effort } : {}),
            permissionMode: frozen.permissionMode as 'read-only' | 'auto' | 'full-access',
            idempotencyKey: head.idempotencyKey,
            clientUserMessageId: head.clientMessageId,
            segmentLifecycle: lifecycle,
          });
        } else {
          await piNativeCoordinator.submitMessage({
            conversation,
            submissionId: head.id,
            content,
            model: { sourceId: frozen.connectionId, modelId: frozen.modelId, displayName: null },
            ...(frozen.effort ? { thinkingLevel: frozen.effort } : {}),
            idempotencyKey: head.idempotencyKey,
            clientUserMessageId: head.clientMessageId,
            segmentLifecycle: lifecycle,
          });
        }
      } else {
        await codexNativeCoordinator.dispatchQueuedMessage({
          conversationId,
          submissionId: head.id,
          segmentLifecycle: lifecycle,
        });
      }
    } catch (error) {
      const failureAt = now().toISOString();
      const currentHead = conversationSubmissions.getById(head.id);
      // 生命周期已经区分“写入前失败”和“接受结果未知”时，不得再用通用恢复原因覆盖证据边界。
      if (!currentHead || currentHead.status === 'queued' || currentHead.status === 'dispatching') {
        conversationSubmissions.updateStatus(head.id, 'paused', {
          pausedReason: 'recovery_required',
          error: { code: 'ZEUS_UNIFIED_QUEUE_HEAD_FAILED', message: error instanceof Error ? error.message : String(error) },
          updatedAt: failureAt,
        });
      }
      conversationExecution.pauseQueueBehindHead(conversationId, head.id, failureAt);
      conversationExecution.persistWarning({
        conversationId,
        warningKind: 'queue_head_failed',
        payload: { submissionId: head.id, message: error instanceof Error ? error.message : String(error) },
        occurredAt: failureAt,
      });
      await db.save();
      publishNativeConversationEvent('conversation.queue.changed', { conversationId, submissionId: head.id });
    } finally {
      unifiedQueueDispatches.delete(conversationId);
    }
  };
  const recoverUnifiedOutcomeUnknownSwitches = async () => {
    const operations = conversationExecution.listOpenSwitchOperations().filter((operation) => operation.state === 'outcome_unknown');
    for (const operation of operations) {
      const segment = conversationExecution.segmentById(operation.targetSegmentId);
      const submission = conversationSubmissions.getById(operation.submissionId);
      if (!segment || !submission || segment.runtimeKind !== 'codex' || !segment.nativeSessionId) continue;
      try {
        const page = await codexAppServerManager.listThreadTurns({ threadId: segment.nativeSessionId, limit: 100, sortDirection: 'desc', itemsView: 'full' });
        const matched = page.data.find((turn) => providerTurnClientMessageId(turn) === submission.clientMessageId);
        if (!matched) {
          conversationExecution.recordRecoveryEvent({
            conversationId: operation.conversationId,
            segmentId: segment.id,
            eventKind: 'outcome_unknown_not_confirmed',
            payload: { operationId: operation.id, nativeSessionId: segment.nativeSessionId, clientUserMessageId: submission.clientMessageId },
            occurredAt: now().toISOString(),
          });
          continue;
        }
        const recoveredAt = now().toISOString();
        const persisted = isNativeApiRecord(JSON.parse(submission.inputJson)) ? (JSON.parse(submission.inputJson) as Record<string, unknown>) : {};
        const turnId = `conversation_turn_${createHash('sha256').update(`${operation.conversationId}\0${segment.id}\0${matched.id}`).digest('hex').slice(0, 24)}`;
        const commandDelivery = commandDeliveries.getByScope('submission', submission.id);
        const unknownOutbox = commandDelivery?.attempts.at(-1)?.outcome === 'outcome_unknown_after_write' ? commandDelivery.attempts.at(-1) : undefined;
        conversationExecution.acceptSwitchDurably(
          {
            operationId: operation.id,
            providerTurnId: matched.id,
            turnId,
            acceptanceEvidence: {
              source: 'startup_reconciliation',
              nativeSessionId: segment.nativeSessionId,
              clientUserMessageId: submission.clientMessageId,
              nativeTurnListed: true,
            },
            userHistoryContent: {
              text: typeof persisted.text === 'string' ? persisted.text : '',
              ...(typeof persisted.displayText === 'string' ? { displayText: persisted.displayText } : {}),
              ...(Array.isArray(persisted.attachments) ? { attachments: persisted.attachments } : {}),
              ...(Array.isArray(persisted.browserComments) ? { browserComments: persisted.browserComments } : {}),
              ...(isNativeApiRecord(persisted.conversationContext) ? { conversationContext: persisted.conversationContext } : {}),
            },
            acceptedAt: recoveredAt,
          },
          unknownOutbox
            ? () =>
                commandDeliveries.reconcileUnknownAsAcceptedInCurrentTransaction({
                  outboxId: unknownOutbox.id,
                  evidence: {
                    source: 'startup_provider_history_reconciliation',
                    nativeSessionId: segment.nativeSessionId,
                    clientUserMessageId: submission.clientMessageId,
                    nativeTurnListed: true,
                  },
                  providerId: 'codex',
                  nativeSessionId: segment.nativeSessionId,
                  nativeTurnId: matched.id,
                  occurredAt: recoveredAt,
                })
            : undefined,
        );
        conversationExecution.appendConfigEvidence({
          conversationId: operation.conversationId,
          turnId,
          submissionId: submission.id,
          segmentId: segment.id,
          layer: 'runtime_acknowledged',
          configuration: { recovered: true },
          evidence: { method: 'thread/turns/list', nativeTurnId: matched.id, clientUserMessageId: submission.clientMessageId },
          observedAt: recoveredAt,
        });
        conversationExecution.recordRecoveryEvent({
          conversationId: operation.conversationId,
          segmentId: segment.id,
          eventKind: 'outcome_unknown_accepted',
          payload: { operationId: operation.id, nativeTurnId: matched.id, clientUserMessageId: submission.clientMessageId },
          occurredAt: recoveredAt,
        });
      } catch (error) {
        conversationExecution.persistWarning({
          conversationId: operation.conversationId,
          warningKind: 'outcome_unknown_reconciliation_failed',
          payload: { operationId: operation.id, message: error instanceof Error ? error.message : String(error) },
          occurredAt: now().toISOString(),
        });
      }
    }
    if (operations.length > 0) await db.save();
  };
  const recoverAcceptedPiTurnsAfterRestart = async () => {
    const interruptedAt = now().toISOString();
    const candidates = conversationTurns.listInProgress().filter((turn) => turn.agentKind === 'pi' && (turn.status === 'dispatching' || turn.status === 'running' || turn.status === 'waiting'));
    let recovered = false;
    for (const turn of candidates) {
      const segment = conversationExecution.currentSegment(turn.conversationId);
      if (!segment || segment.runtimeKind !== 'pi' || segment.nativeSessionId !== turn.providerThreadId) continue;
      const failure = {
        code: 'ZEUS_PI_RUN_INTERRUPTED_BY_RESTART',
        message: 'Zeus 重启后确认此前 Pi 运行内核已结束；已接纳轮次保留为中断。',
      };
      conversationTurns.upsert({ ...turn, status: 'interrupted', error: failure, completedAt: interruptedAt, updatedAt: interruptedAt });
      if (turn.clientSubmissionId) {
        const submission = conversationSubmissions.getById(turn.clientSubmissionId);
        if (submission && (submission.status === 'dispatching' || submission.status === 'active')) {
          conversationSubmissions.updateStatus(submission.id, 'completed', {
            providerTurnId: turn.providerTurnId,
            error: failure,
            resolvedAt: interruptedAt,
            updatedAt: interruptedAt,
          });
        }
      }
      for (const queued of conversationSubmissions.listByConversation(turn.conversationId).filter((submission) => submission.status === 'queued' && !submission.providerTurnId)) {
        conversationSubmissions.updateStatus(queued.id, 'paused', { pausedReason: 'interrupted', updatedAt: interruptedAt });
      }
      conversations.updateAgentRuntime(turn.conversationId, { providerState: 'ready', status: 'open' });
      conversationExecution.recordRecoveryEvent({
        conversationId: turn.conversationId,
        segmentId: segment.id,
        eventKind: 'pi_accepted_turn_interrupted_after_restart',
        payload: { turnId: turn.id, providerTurnId: turn.providerTurnId, submissionId: turn.clientSubmissionId },
        occurredAt: interruptedAt,
      });
      conversationExecution.persistWarning({
        conversationId: turn.conversationId,
        warningKind: 'pi_turn_interrupted_after_restart',
        payload: { turnId: turn.id, providerTurnId: turn.providerTurnId },
        occurredAt: interruptedAt,
      });
      recovered = true;
    }
    if (recovered) await db.save();
  };
  traceStartup('codex_coordinator_ready');
  if (executionHostDispatchMayResume && codexNativeEnabled && codexRemoteControlEnabled) {
    void codexAppServerManager
      .ensureReady({ commandPath: currentCodexRuntimeCommandPath(), ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}), remoteControl: true })
      .then(() => codexAppServerManager.enableRemoteControl())
      .catch(async (error) => {
        auditLogs.append({
          actorType: 'system',
          action: 'codex.remote_control.restore_failed',
          resourceType: 'settings',
          payload: { error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) } },
          createdAt: now().toISOString(),
        });
        await db.save();
      });
  }
  if (executionHostDispatchMayResume && codexNativeEnabled) {
    try {
      const migration = await migrateLegacyCodexThreads({
        db,
        projects,
        tasks,
        taskEvents,
        runtimeSessions,
        conversations,
        turns: conversationTurns,
        providerItems: conversationProviderItems,
        submissions: conversationSubmissions,
        manager: codexAppServerManager,
        commandPath: currentCodexRuntimeCommandPath(),
        externalAgentHome: codexExternalAgentHome,
      });
      if (migration.imported.length > 0 || migration.existing.length > 0 || migration.archivedSourceConversationIds.length > 0) {
        auditLogs.append({
          actorType: 'system',
          action: 'conversation.legacy_codex_threads.migrate',
          resourceType: 'conversation',
          payload: {
            importedCount: migration.imported.length,
            existingCount: migration.existing.length,
            skippedCount: migration.skipped.length,
            archivedSourceCount: migration.archivedSourceConversationIds.length,
            skippedReasons: migration.skipped.map((entry) => entry.reason),
          },
          createdAt: now().toISOString(),
        });
        await db.save();
      }
    } catch (migrationError) {
      auditLogs.append({
        actorType: 'system',
        action: 'conversation.legacy_codex_threads.migrate_failed',
        resourceType: 'conversation',
        payload: { errorType: migrationError instanceof Error ? migrationError.name : typeof migrationError },
        createdAt: now().toISOString(),
      });
      await db.save();
    }
  }
  traceStartup('legacy_threads_ready');
  let codexLegacyImportService: CodexLegacyImportService | undefined;
  if (executionHostDispatchMayResume && codexNativeEnabled && options.codexLegacyImportRoot) {
    codexLegacyImportService = createCodexLegacyImportService({
      manager: codexAppServerManager,
      db,
      conversations,
      imports: codexLegacyImports,
      sourceRoot: codexExternalAgentHome!,
      allowedProjectRoots: () => projects.list().map((project) => project.localPath),
      commandPath: currentCodexRuntimeCommandPath(),
      providerBinaryVersion: 'user-installed',
      onUpdated: (snapshot) => publishNativeConversationEvent('codex.legacy_import.updated', snapshot),
    });
    try {
      await codexLegacyImportService.recover();
    } catch (recoveryError) {
      auditLogs.append({
        actorType: 'system',
        action: 'conversation.codex_legacy_import.recover_failed',
        resourceType: 'conversation',
        payload: { errorType: recoveryError instanceof Error ? recoveryError.name : typeof recoveryError },
        createdAt: now().toISOString(),
      });
      await db.save();
    }
  }
  traceStartup('legacy_imports_ready');
  (server as ZeusFastifyLifecycle).prepareZeusShutdown = async () => {
    if (readOnlyValidation) return;
    settleCodexPendingOnClose = true;
    await codexLegacyImportService?.close();
    await codexNativeCoordinator.close({ mode: 'final' });
  };
  if (executionHostDispatchMayResume) await turnChangeSetService.recoverInterruptedOperations();
  traceStartup('turn_changes_ready');
  if (
    executionHostDispatchMayResume &&
    codexNativeEnabled &&
    (conversations.listNativeBoundRecords('codex').length > 0 ||
      conversationSubmissions.listRecoverable().some((submission) => conversations.getRecordById(submission.conversationId)?.agentKind === 'codex' && (submission.status === 'dispatching' || submission.status === 'active')))
  ) {
    try {
      await codexNativeCoordinator.recover();
    } catch (recoveryError) {
      const claimedRecoveryError = claimCodexFinalizationOwnership(recoveryError);
      const cleanupErrors: unknown[] = [];
      try {
        await codexNativeCoordinator.close({ mode: 'final' });
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await server.close();
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
      if (cleanupErrors.length > 0) throw claimCodexFinalizationOwnership(new AggregateError([claimedRecoveryError, ...cleanupErrors], 'Zeus native recovery and cleanup failed.'));
      throw claimedRecoveryError;
    }
  }
  traceStartup('codex_recovery_ready');

  function recordTaskEvent(input: CreateTaskEventInput) {
    const event = taskEvents.create(input);
    taskEventFileProjectionOutbox.enqueue(event.taskId, event.id, event.createdAt);
    db.afterCommit(() => taskEventFileProjection.schedule(event.taskId));
    return event;
  }

  let telegramPollingService: TelegramPollingService | undefined;
  let telegramMessageSender: TelegramMessageSender | undefined;
  let telegramPollingTimer: ReturnType<typeof setInterval> | undefined;
  const platformMutableState = {
    get appShellSettings() {
      return appShellSettings;
    },
    set appShellSettings(value: AppShellSettingsSnapshot) {
      appShellSettings = value;
    },
    get codeMapSettings() {
      return codeMapSettings;
    },
    set codeMapSettings(value: CodeMapSettingsSnapshot) {
      codeMapSettings = value;
    },
    get codexRemoteControlEnabled() {
      return codexRemoteControlEnabled;
    },
    set codexRemoteControlEnabled(value: boolean) {
      codexRemoteControlEnabled = value;
    },
    get memoryGraphCache() {
      return memoryGraphCache;
    },
    set memoryGraphCache(value: ProjectGraph | null) {
      memoryGraphCache = value;
    },
    get nativeEventSaveTimer() {
      return nativeEventSaveTimer;
    },
    set nativeEventSaveTimer(value: ReturnType<typeof setTimeout> | null) {
      nativeEventSaveTimer = value;
    },
    get removeStorageWriteFaultListener() {
      return removeStorageWriteFaultListener;
    },
    set removeStorageWriteFaultListener(value: (() => void) | null) {
      removeStorageWriteFaultListener = value;
    },
    get runtimeSettings() {
      return runtimeSettings;
    },
    set runtimeSettings(value: RuntimeSettingsSnapshot) {
      runtimeSettings = value;
    },
    get telegramMessageSender() {
      return telegramMessageSender;
    },
    set telegramMessageSender(value: TelegramMessageSender | undefined) {
      telegramMessageSender = value;
    },
    get telegramNotificationSettings() {
      return telegramNotificationSettings;
    },
    set telegramNotificationSettings(value: TelegramNotificationSettingsSnapshot) {
      telegramNotificationSettings = value;
    },
    get telegramPollingService() {
      return telegramPollingService;
    },
    set telegramPollingService(value: TelegramPollingService | undefined) {
      telegramPollingService = value;
    },
    get telegramPollingTimer() {
      return telegramPollingTimer;
    },
    set telegramPollingTimer(value: ReturnType<typeof setInterval> | undefined) {
      telegramPollingTimer = value;
    },
    get telegramSecuritySettings() {
      return telegramSecuritySettings;
    },
    set telegramSecuritySettings(value: TelegramSecuritySettingsSnapshot) {
      telegramSecuritySettings = value;
    },
    get usageRefreshTimer() {
      return usageRefreshTimer;
    },
    set usageRefreshTimer(value: ReturnType<typeof setInterval> | undefined) {
      usageRefreshTimer = value;
    },
  };
  let boundPort: number | null = null;
  const releaseNotesCapabilityPolicy = {
    classification: 'ephemeral_capability',
    ttlMs: 10 * 60 * 1_000,
    maximumEntries: 256,
    oneShot: true,
    durableReplay: false,
    commandLedger: 'not_applicable',
  } as const;
  const releaseNotesCapabilities = new Map<string, { token: string; projectId: string; expiresAt: number; used: boolean }>();
  const releaseNotesAuthorizedRequests = new WeakSet<object>();

  server.decorate('setZeusBoundPort', (port: number) => {
    boundPort = port;
  });

  function createReleaseNotesCapability(input: { runId: string; projectId: string }): { url: string; token: string } {
    if (!boundPort) throw new Error('Zeus 本机服务尚未完成端口绑定，无法创建发布说明能力。');
    pruneReleaseNotesCapabilities();
    const existing = releaseNotesCapabilities.get(input.runId);
    if (existing) {
      if (existing.projectId !== input.projectId || existing.used) {
        throw Object.assign(new Error('发布说明临时能力已存在且不能重置或换项目复用。'), {
          code: 'ZEUS_RELEASE_NOTES_CAPABILITY_REUSE_REJECTED',
        });
      }
      return {
        url: `http://${zeusLocalServerHost}:${boundPort}/api/command-runs/${encodeURIComponent(input.runId)}/release-notes`,
        token: existing.token,
      };
    }
    if (!releaseNotesCapabilities.has(input.runId) && releaseNotesCapabilities.size >= releaseNotesCapabilityPolicy.maximumEntries) {
      throw Object.assign(new Error('发布说明临时能力已达到有界容量，请等待现有命令结束或能力过期。'), {
        code: 'ZEUS_RELEASE_NOTES_CAPABILITY_CAPACITY_EXCEEDED',
      });
    }
    const token = `zeus_release_notes_${randomUUID().replace(/-/gu, '')}${randomUUID().replace(/-/gu, '')}`;
    releaseNotesCapabilities.set(input.runId, {
      token,
      projectId: input.projectId,
      expiresAt: Date.now() + releaseNotesCapabilityPolicy.ttlMs,
      used: false,
    });
    return {
      url: `http://${zeusLocalServerHost}:${boundPort}/api/command-runs/${encodeURIComponent(input.runId)}/release-notes`,
      token,
    };
  }

  function revokeReleaseNotesCapability(runId: string): void {
    releaseNotesCapabilities.delete(runId);
  }

  function pruneReleaseNotesCapabilities(nowMs = Date.now()): void {
    for (const [runId, capability] of releaseNotesCapabilities) {
      if (capability.expiresAt <= nowMs) releaseNotesCapabilities.delete(runId);
    }
  }

  function authorizeReleaseNotesRequest(request: FastifyRequest): boolean {
    pruneReleaseNotesCapabilities();
    const match = request.url.match(/^\/api\/command-runs\/([^/?]+)\/release-notes(?:\?|$)/u);
    if (!match) return false;
    let runId: string;
    try {
      runId = decodeURIComponent(match[1] ?? '');
    } catch {
      return false;
    }
    const capability = releaseNotesCapabilities.get(runId);
    if (!capability || capability.used || capability.expiresAt <= Date.now()) {
      if (capability?.expiresAt && capability.expiresAt <= Date.now()) releaseNotesCapabilities.delete(runId);
      return false;
    }
    if (request.headers.authorization !== `Bearer ${capability.token}`) return false;
    capability.used = true;
    releaseNotesAuthorizedRequests.add(request);
    return true;
  }

  function appendAuditLog(input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }): void {
    auditLogs.append({
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
  }

  /** 慢订阅者在有界高水位断开，随后通过耐久游标补拉，避免 Core 为单个窗口无界缓存。 */
  function broadcastRealtimeEvent(event: ZeusRealtimeEvent): void {
    const encoded = JSON.stringify(event);
    for (const subscriber of eventSubscribers) {
      if (subscriber.readyState !== subscriber.OPEN) continue;
      if ((subscriber.bufferedAmount ?? 0) > realtimeSubscriberHighWaterBytes) {
        conversationEventFlow.observeWebSocketSlowConsumerDisconnect(subscriber.bufferedAmount ?? 0);
        subscriber.close(1013, 'Zeus event consumer exceeded the bounded queue; reconnect and resume by cursor.');
        eventSubscribers.delete(subscriber);
        continue;
      }
      try {
        subscriber.send(encoded);
      } catch {
        subscriber.close(1011, 'Zeus event delivery failed; reconnect and resume by cursor.');
        eventSubscribers.delete(subscriber);
      }
    }
  }

  /** 向本地 WebSocket 订阅者广播真实领域事件；payload 只放业务上下文，绝不包含 API Token。 */
  function publishRealtimeEvent(type: string, payload: Record<string, unknown>): ZeusRealtimeEvent {
    const event: ZeusRealtimeEvent = {
      id: randomUUID(),
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    broadcastRealtimeEvent(event);
    return event;
  }

  removeStorageWriteFaultListener = db.onWriteFault((snapshot) => {
    const fault = snapshot.fault;
    if (!fault) return;
    publishRealtimeEvent('storage.write_fault', {
      faultId: fault.id,
      kind: fault.kind,
      operation: fault.operation,
      occurredAt: fault.occurredAt,
      readsAvailable: snapshot.readsAvailable,
      writesAllowed: snapshot.writesAllowed,
      recoveryRequiresCoreRestart: fault.recoveryRequiresCoreRestart,
    });
  });

  function recordNativeDeltaFlushFailure(error: unknown): Error {
    const failure = error instanceof Error ? error : new Error(String(error));
    nativeDeltaFlushFailure = failure;
    console.error('Zeus 会话增量持久化失败；后续会话事件已失败关闭，等待权威恢复。', failure);
    return failure;
  }

  function flushPendingNativeDeltaEvents(saveAfterAppend = false): void {
    if (nativeDeltaFlushTimer) clearTimeout(nativeDeltaFlushTimer);
    nativeDeltaFlushTimer = null;
    if (nativeDeltaFlushFailure) throw nativeDeltaFlushFailure;
    if (pendingNativeDeltaEvents.size === 0) return;
    const pending = [...pendingNativeDeltaEvents.values()];
    pendingNativeDeltaEvents.clear();
    pendingNativeDeltaBytes = 0;
    try {
      db.transaction(() => {
        for (const event of pending) {
          const conversationId = typeof event.payload.conversationId === 'string' ? event.payload.conversationId : null;
          if (!conversationId) throw new Error('待持久会话增量事件缺少 conversationId。');
          conversationSyncProtocol.append({ conversationId, type: event.type, payload: event.payload });
        }
      });
    } catch (error) {
      for (const event of pending) {
        const conversationId = typeof event.payload.conversationId === 'string' ? event.payload.conversationId : randomUUID();
        pendingNativeDeltaEvents.set(nativeDeltaEventKey(conversationId, event.payload) ?? `${conversationId}:${randomUUID()}`, event);
        pendingNativeDeltaBytes += event.byteLength;
      }
      throw recordNativeDeltaFlushFailure(error);
    }
    if (saveAfterAppend) void db.save().catch(recordNativeDeltaFlushFailure);
  }

  function scheduleNativeDeltaFlush(): void {
    if (nativeDeltaFlushTimer) return;
    nativeDeltaFlushTimer = setTimeout(() => {
      try {
        flushPendingNativeDeltaEvents(true);
      } catch {
        // flush 已记录失败并保留待发投影；同步异常不能逃逸为未捕获进程异常。
      }
    }, nativeDeltaCoalesceMs);
  }

  /**
   * 广播可能位于调用方 save() 前或后：延后一轮可让前者共享业务提交，后者也能形成事件提交，
   * 避免事件留在未提交事务中直到下一次无关写入。afterCommit 仍保证客户端不会先于 SQLite 看见事件。
   */
  function scheduleNativeEventSave(): void {
    if (nativeEventSaveTimer) return;
    nativeEventSaveTimer = setTimeout(() => {
      nativeEventSaveTimer = null;
      void db.save().catch(recordNativeDeltaFlushFailure);
    }, 0);
  }

  function nativeDeltaEventKey(conversationId: string, payload: Record<string, unknown>): string | null {
    const threadId = typeof payload.threadId === 'string' ? payload.threadId : typeof payload.providerThreadId === 'string' ? payload.providerThreadId : null;
    const turnId = typeof payload.turnId === 'string' ? payload.turnId : typeof payload.providerTurnId === 'string' ? payload.providerTurnId : null;
    const itemId = typeof payload.itemId === 'string' ? payload.itemId : typeof payload.providerItemId === 'string' ? payload.providerItemId : null;
    const generationId = typeof payload.generationId === 'string' ? payload.generationId : nativeLocalEventGenerationId;
    if (!threadId || !turnId || !itemId) return null;
    return [conversationId, generationId, threadId, turnId, itemId].join(':');
  }

  function publishNativeConversationEvent(type: string, payload: Record<string, unknown>): void {
    if (nativeDeltaFlushFailure) throw nativeDeltaFlushFailure;
    const mappedType =
      type === 'conversation.item.updated'
        ? payload.status === 'in_progress'
          ? 'conversation.item.delta'
          : 'conversation.item.completed'
        : type === 'conversation.provider.settings.updated'
          ? 'conversation.settings.changed'
          : type === 'conversation.provider.token_usage.updated'
            ? 'conversation.tokenUsage.changed'
            : type === 'codex.rate_limits.updated'
              ? 'conversation.rateLimits.changed'
              : type === 'codex.mcp_startup_status.updated'
                ? 'conversation.mcpStartup.changed'
                : type === 'conversation.submission.steered'
                  ? 'conversation.queue.changed'
                  : type;
    const conversationIds =
      typeof payload.conversationId === 'string'
        ? [payload.conversationId]
        : mappedType === 'conversation.rateLimits.changed' || mappedType === 'conversation.mcpStartup.changed'
          ? conversations.listNativeBoundRecords('codex').map((conversation) => conversation.id)
          : [];
    if ((mappedType === 'conversation.turn.started' || mappedType === 'conversation.turn.completed') && typeof payload.conversationId === 'string') {
      for (const [attemptId, operation] of taskConflictAiOperations) {
        if (operation.conversationId !== payload.conversationId) continue;
        if (mappedType === 'conversation.turn.started') {
          operation.running = true;
          continue;
        }
        operation.running = false;
        // 命名冲突开发线由用户在会话中通过“代码交付”提交和合入，回合结束不能自动收口。
        if (payload.status === 'completed' && !taskIntegrationAttempts.getById(attemptId)) {
          scheduleTaskIntegrationAiFinalization(attemptId, operation.conversationId);
        }
      }
      if (mappedType === 'conversation.turn.completed' && dispatchUnifiedConversationQueueHead) {
        const conversationId = payload.conversationId;
        queueMicrotask(() => void dispatchUnifiedConversationQueueHead?.(conversationId).catch(() => undefined));
      }
    }
    if (mappedType !== 'conversation.item.delta') flushPendingNativeDeltaEvents();
    let appendedDeferredEvent = false;
    for (const conversationId of new Set(conversationIds)) {
      // 实时事件只需要会话元数据；禁止在每个增量事件中加载整段消息历史。
      const conversation = conversations.getRecordById(conversationId);
      if (!conversation || conversation.transportKind !== 'codex_native') continue;
      const generationId = typeof payload.generationId === 'string' ? payload.generationId : nativeLocalEventGenerationId;
      const steeringSubmission = mappedType === 'conversation.submission.steering' && typeof payload.submissionId === 'string' ? conversationSubmissions.getById(payload.submissionId) : undefined;
      const eventPayload = {
        ...payload,
        ...(mappedType === 'conversation.tokenUsage.changed' ? { unifiedUsage: conversationExecution.usageSnapshot(conversationId) } : {}),
        ...(mappedType === 'conversation.sessionMetrics.changed' ? { sessionMetrics: conversationExecution.sessionMetrics(conversationId) } : {}),
        ...(mappedType === 'conversation.queue.changed' ? { queue: toNativeQueueApiSnapshot(conversation) } : {}),
        ...(mappedType === 'conversation.submission.steering' && steeringSubmission
          ? {
              submission: toNativeSubmission(steeringSubmission),
              queue: toNativeQueueApiSnapshot(conversation),
            }
          : {}),
        ...(nativeConversationAttentionEventTypes.has(mappedType)
          ? {
              conversationAttentionState: conversationChoiceQueries.attentionByProject([conversation.projectId])[conversation.projectId] ?? 'idle',
              conversationUnreadCount: conversationChoiceQueries.unreadCountByProject([conversation.projectId])[conversation.projectId] ?? 0,
              conversationTitle: conversation.title,
              hasUnreadAttention: conversation.attentionUnread,
              attentionKind: conversation.attentionKind,
              attentionRevision: conversation.attentionRevision,
            }
          : {}),
        projectId: conversation.projectId,
        conversationId: conversation.id,
        entityRevision: typeof payload.revision === 'number' && Number.isSafeInteger(payload.revision) ? payload.revision : typeof payload.updatedAt === 'string' && payload.updatedAt ? payload.updatedAt : conversation.updatedAt,
        ...(typeof payload.threadId === 'string'
          ? { threadId: payload.threadId }
          : typeof payload.providerThreadId === 'string'
            ? { threadId: payload.providerThreadId }
            : conversation.providerThreadId
              ? { threadId: conversation.providerThreadId }
              : {}),
        ...(typeof payload.turnId === 'string' ? { turnId: payload.turnId } : typeof payload.providerTurnId === 'string' ? { turnId: payload.providerTurnId } : {}),
        ...(typeof payload.itemId === 'string' ? { itemId: payload.itemId } : typeof payload.providerItemId === 'string' ? { itemId: payload.providerItemId } : {}),
        generationId,
      } satisfies Record<string, unknown>;
      if (mappedType === 'conversation.item.delta') {
        const key = nativeDeltaEventKey(conversationId, eventPayload);
        if (key) {
          const byteLength = Buffer.byteLength(JSON.stringify({ type: mappedType, payload: eventPayload }), 'utf8');
          if (byteLength > conversationEventFlowBudgets.sqlite.maximumEventBytes) {
            conversationEventFlow.observeFailClosed();
            throw Object.assign(new Error('会话过程事件超过 SQLite 待提交队列的单事件预算；完整内容必须使用句柄。'), {
              code: 'ZEUS_CONVERSATION_EVENT_SQLITE_BUDGET_EXCEEDED',
            });
          }
          const existing = pendingNativeDeltaEvents.get(key);
          if (
            (!existing && pendingNativeDeltaEvents.size >= conversationEventFlowBudgets.sqlite.maximumCoalescingKeys) ||
            pendingNativeDeltaBytes - (existing?.byteLength ?? 0) + byteLength > conversationEventFlowBudgets.sqlite.maximumPendingBytes
          ) {
            flushPendingNativeDeltaEvents();
          }
          // 删除后再写入，保持跨 item 增量的最后到达顺序；同一 item 只保留最新累计文本。
          const replaced = pendingNativeDeltaEvents.get(key);
          if (replaced) pendingNativeDeltaBytes -= replaced.byteLength;
          pendingNativeDeltaEvents.delete(key);
          pendingNativeDeltaEvents.set(key, { type: mappedType, payload: eventPayload, byteLength });
          pendingNativeDeltaBytes += byteLength;
          conversationEventFlow.observeHighWater('sqlite', pendingNativeDeltaBytes, pendingNativeDeltaEvents.size);
          if (replaced) conversationEventFlow.observeCoalescedProcessEvent();
          scheduleNativeDeltaFlush();
          continue;
        }
        flushPendingNativeDeltaEvents();
      }
      const appendEvent = () => conversationSyncProtocol.append({ conversationId, type: mappedType, payload: eventPayload });
      if (classifyConversationEventDurability(mappedType) === 'critical_fact') db.commitCriticalFactSync(appendEvent);
      else {
        appendEvent();
        appendedDeferredEvent = true;
      }
    }
    if (appendedDeferredEvent) scheduleNativeEventSave();
  }

  function publishGitDiffUpdatedEvent(diff: GitDiffSummary, projectId?: string): void {
    publishRealtimeEvent('git.diff.updated', {
      projectId,
      isRepository: diff.isRepository,
      fileCount: diff.files.length,
      files: diff.files,
      diffTextLength: diff.diffText.length,
    });
  }

  function persistReadonlyGitDiffSnapshot(input: { projectId: string; taskId: string; diff: GitDiffSummary; graphRoot: string }): void {
    gitSnapshots.createSnapshot({
      projectId: input.projectId,
      taskId: input.taskId,
      snapshotType: 'readonly_diff',
      status: {
        isRepository: input.diff.isRepository,
        fileCount: input.diff.files.length,
        diffTextLength: input.diff.diffText.length,
      },
      createdAt: new Date().toISOString(),
    });
    for (const change of buildReadonlyGitChanges(input.diff)) {
      const linkedGraphNodes = readCurrentGraphNodeIdsBySourceRef(change.filePath, input.graphRoot);
      gitSnapshots.createChange({
        projectId: input.projectId,
        taskId: input.taskId,
        filePath: change.filePath,
        changeType: change.changeType,
        additions: change.additions,
        deletions: change.deletions,
        linkedGraphNodes,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async function runCodeMapScan(input: { projectName: string; rootPath: string; projectConfig?: ProjectConfigSnapshot; graphProjectName?: string }): Promise<Record<string, unknown>> {
    publishRealtimeEvent('project.scan.started', {
      projectName: input.projectName,
      rootPath: input.rootPath,
    });
    const scanStartedAt = Date.now();
    const scanRoot = resolveCodeMapScanRoot(input.rootPath, codeMapSettings);
    if (isUnsafeCodeMapScanRoot(scanRoot)) {
      // 全局 scan-current 历史入口不能因为 packaged cwd=/ 而扫描整台机器；项目页也必须拒绝根目录项目。
      throw new UnsafeCodeMapScanRootError();
    }
    const importedSchemaFiles = [...resolveImportedSchemaFiles(input.rootPath, input.projectConfig), ...(await writeConfiguredDatabaseSchemaFiles(input.rootPath, input.projectConfig))];
    // 扫描进度只描述真实执行阶段，不提前伪造文件数、节点数或视图数。
    publishRealtimeEvent('project.scan.progress', {
      projectName: input.projectName,
      rootPath: scanRoot,
      stage: 'resolve_scope',
      message: '解析代码地图扫描范围',
    });
    publishRealtimeEvent('project.scan.progress', {
      projectName: input.projectName,
      rootPath: scanRoot,
      stage: 'index_source',
      message: '扫描真实源码文件',
    });
    const graphProjectName = input.graphProjectName ?? input.projectName;
    const { scan, graph: workerGraph, resultRef } = await runCodeMapHeavyJob(scanRoot, graphProjectName, codeMapSettings.defaultIgnoreDirectories, importedSchemaFiles);
    publishRealtimeEvent('project.scan.progress', {
      projectName: input.projectName,
      rootPath: scan.rootPath,
      stage: 'build_graph',
      message: '构建真实代码图谱',
      fileCount: scan.files.length,
      symbolCount: scan.symbols.length,
      importedSchemaFileCount: importedSchemaFiles.length,
    });
    const graph = applyCodeMapSettingsToGraph(workerGraph, codeMapSettings);
    const runtimeGraph = compactProjectGraphForRuntimeCache(graph);
    publishRealtimeEvent('project.scan.progress', {
      projectName: input.projectName,
      rootPath: scan.rootPath,
      stage: 'cache_graph',
      message: '按图缓存策略保存扫描结果',
      nodeCount: runtimeGraph.nodes.length,
      edgeCount: runtimeGraph.edges.length,
      viewCount: runtimeGraph.views.length,
      graphCacheStrategy: codeMapSettings.graphCacheStrategy,
      fullNodeCount: graph.nodes.length,
      fullEdgeCount: graph.edges.length,
    });
    if (codeMapSettings.graphCacheStrategy === 'memory') {
      memoryGraphCache = runtimeGraph;
      await projectionDatabases.enqueueIndexWrite((projectionDb) => clearPersistedGraphCache(projectionDb, scan.projectName));
    } else if (codeMapSettings.graphCacheStrategy === 'disabled') {
      memoryGraphCache = null;
      await projectionDatabases.enqueueIndexWrite((projectionDb) => clearPersistedGraphCache(projectionDb, scan.projectName));
    } else {
      memoryGraphCache = null;
      await projectionDatabases.enqueueIndexWrite((projectionDb) => persistScanAndGraph(projectionDb, scan, runtimeGraph));
    }
    await db.save();
    const baseResult = {
      projectName: input.projectName,
      graphProjectName: scan.projectName,
      rootPath: scan.rootPath,
      fileCount: scan.files.length,
      symbolCount: scan.symbols.length,
      fullNodeCount: graph.nodes.length,
      fullEdgeCount: graph.edges.length,
      retainedNodeCount: runtimeGraph.nodes.length,
      retainedEdgeCount: runtimeGraph.edges.length,
      nodeCount: runtimeGraph.nodes.length,
      edgeCount: runtimeGraph.edges.length,
      viewCount: runtimeGraph.views.length,
      importedSchemaFileCount: importedSchemaFiles.length,
      heavyWorkerResultRef: resultRef,
    };
    const result = codeMapSettings.performanceMonitoringEnabled
      ? {
          ...baseResult,
          // 性能监控只暴露本次真实扫描耗时，不生成后台常驻指标或虚假历史曲线。
          performance: { durationMs: Math.max(0, Date.now() - scanStartedAt) },
        }
      : baseResult;
    publishRealtimeEvent('project.scan.completed', result);
    return result;
  }

  async function writeConfiguredDatabaseSchemaFiles(projectRootPath: string, config?: ProjectConfigSnapshot): Promise<Array<{ absolutePath: string; relativePath: string }>> {
    const sqliteConnection = resolveConfiguredSqliteDatabase(projectRootPath, config);
    if (!sqliteConnection) return [];
    const snapshot = await introspectSqliteSchema(sqliteConnection.absolutePath);
    if (snapshot.statements.length === 0) return [];
    const outputPath = join(localLogDirectory, 'schema-introspection', sanitizeRuntimeFileName(sqliteConnection.relativePath), 'schema.sql');
    mkdirSync(dirname(outputPath), { recursive: true });
    const ddl = [
      `-- Zeus database introspection source: sqlite:${sqliteConnection.relativePath}`,
      `-- Generated from a real local SQLite schema at scan time; this file is a cache, not seed data.`,
      ...snapshot.statements.map((statement) => `${statement.sql.replace(/;\\s*$/u, '')};`),
      '',
    ].join('\n');
    writeFileSync(outputPath, ddl, 'utf8');
    return [
      {
        absolutePath: outputPath,
        relativePath: `database-introspection/${sqliteConnection.relativePath}.sql`,
      },
    ];
  }

  // 延迟绑定用于打破工厂循环，依赖只能在其 owner 装配完成后被调用。
  // eslint-disable-next-line prefer-const
  let supportOperations!: ReturnType<typeof createLocalServerSupportOperations>;
  // eslint-disable-next-line prefer-const
  let conversationOperations!: ReturnType<typeof createConversationApplicationOperations>;
  // eslint-disable-next-line prefer-const
  let projectGitQueries!: ProjectGitQueryApplication;
  // eslint-disable-next-line prefer-const
  let conversationCapabilityQueries!: ConversationCapabilityQueryApplication;
  const taskRuntimeOperations = createTaskRuntimeOperations({
    aiRuntimeManager,
    appendAuditLog,
    buildRuntimeProcessEnv: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['buildRuntimeProcessEnv']>) => supportOperations.buildRuntimeProcessEnv(...args),
    codexAppServerManager,
    codexExternalAgentHome,
    codexNativeCoordinator,
    codexNativeEnabled,
    conversationCapabilityQueries: {
      unavailableCodexAccount: (...args: Parameters<ConversationCapabilityQueryApplication['unavailableCodexAccount']>) => conversationCapabilityQueries.unavailableCodexAccount(...args),
      buildConversationCapabilities: (...args: Parameters<ConversationCapabilityQueryApplication['buildConversationCapabilities']>) => conversationCapabilityQueries.buildConversationCapabilities(...args),
    },
    conversations,
    createNonCodexTaskRuntimeInvocation: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['createNonCodexTaskRuntimeInvocation']>) => supportOperations.createNonCodexTaskRuntimeInvocation(...args),
    createTaskRuntimeConversation: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['createTaskRuntimeConversation']>) => supportOperations.createTaskRuntimeConversation(...args),
    createTaskRuntimePrompt: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['createTaskRuntimePrompt']>) => supportOperations.createTaskRuntimePrompt(...args),
    createTelegramRuntimeConfirmation: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['createTelegramRuntimeConfirmation']>) => supportOperations.createTelegramRuntimeConfirmation(...args),
    currentCodexRuntimeCommandPath,
    db,
    getProjectGitQueries: () => projectGitQueries,
    handleTelegramBusinessCommand: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['handleTelegramBusinessCommand']>) => supportOperations.handleTelegramBusinessCommand(...args),
    localLogDirectory,
    normalizeNativeConversationAttachments: (value: unknown, projectLocalPath: string) => conversationOperations.normalizeNativeConversationAttachments(value, projectLocalPath),
    now,
    platformMutableState,
    projects,
    publishRealtimeEvent,
    readCurrentGraphSummaryForProject: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['readCurrentGraphSummaryForProject']>) => supportOperations.readCurrentGraphSummaryForProject(...args),
    readGitDiff,
    readProjectConfig: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['readProjectConfig']>) => supportOperations.readProjectConfig(...args),
    readTelegramToken: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['readTelegramToken']>) => supportOperations.readTelegramToken(...args),
    recordTaskEvent,
    redactSensitiveText,
    resolveCodexModel: (project: ZeusProjectRecord) => conversationOperations.resolveCodexModel(project),
    resolveResponsesRuntime,
    resolveTaskManagementStatusConfigForProject,
    runtimeSessions,
    searchCurrentGraphNodesForProject: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['searchCurrentGraphNodesForProject']>) => supportOperations.searchCurrentGraphNodesForProject(...args),
    taskAttachmentRoot,
    taskPushContentAttachmentFields: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['taskPushContentAttachmentFields']>) => supportOperations.taskPushContentAttachmentFields(...args),
    taskStatusEventTitle,
    tasks,
    telegramCommandRouteError: (...args: Parameters<ReturnType<typeof createLocalServerSupportOperations>['telegramCommandRouteError']>) => supportOperations.telegramCommandRouteError(...args),
    toGraphConversationHistoryItem,
    trustedConversationAttachmentRoots,
  });
  const {
    resolveModelCapability,
    positiveIntegerOrNull,
    resolveConversationCapabilities,
    assertCodexAccountReady,
    readServiceTierOverride,
    normalizeServiceTierForCapability,
    createTaskCodeReviewPrompt,
    buildTaskPushLayoutForTask,
    inspectTaskPushAttachments,
    normalizeTaskPushAttachments,
    normalizeTaskPushSupplementalAttachments,
    resolveTaskPushContextState,
    resolveSelectedTaskPushContext,
    mergeTaskPushAttachmentInputs,
    prepareWorkManagementRuntimeStart,
    invokeWorkManagementRuntimeStart,
    finalizeWorkManagementRuntimeStart,
    startTaskNativeConversation,
    stopRunningTaskRuntimeSessions,
    transitionTaskStatus,
    publishRuntimeSessionEvent,
    publishRuntimeLogEvent,
    publishRuntimeSessionEnded,
    parseTaskSourceContext,
    findProjectByRef,
    moveTaskTowardRunning,
    moveTaskToPushedManagementStatus,
    moveTaskToWaitingConfirmation,
    moveTaskToCancelled,
    parseTelegramLogsArgs,
    formatTelegramTaskLogs,
    formatTelegramGraphAsk,
    answerProjectGraphQuestion,
    persistGraphQuestionConversation,
    formatTelegramTaskDiff,
    requireTelegramPollingService,
  } = taskRuntimeOperations;
  supportOperations = createLocalServerSupportOperations({
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
  });
  const {
    readTelegramToken,
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
    readCurrentGraphNodeByIdForProject,
    readCurrentGraphViewForProject,
    formatProjectScopedGraphViewTitle,
    readCurrentGraphView,
    attachGraphViewPerformance,
    searchCurrentGraphNodes,
    readCurrentGraphNodeById,
    readCurrentGraphNodeIdsBySourceRef,
    readCurrentGraphEdgesByNodeId,
    readCurrentGraphEdgeDetail,
    readCurrentGraphNeighborhood,
    markRuntimeSessionConversationsInactive,
    persistRuntimeConversationSummary,
    stopPersistedOrphanRuntimeSession,
    recoverPersistedRuntimeSessions,
    buildReleaseStatusSnapshot,
    buildReleaseUpdateStatus,
    readProjectVersion,
    isAuthorizedRealtimeRequest,
    getTelegramPollingService,
    notifyTelegramCommandRunLog,
    notifyTelegramCommandRunSession,
    createTaskRuntimePrompt,
    resolveExistingRuntimeSessionAdapter,
    resolveNonCodexLiveSession,
    shouldReconnectTaskConversationRuntime,
    reconnectNonCodexLegacyConversationRuntime,
  } = supportOperations;
  if (executionHostDispatchMayResume) await recoverPersistedRuntimeSessions();
  traceStartup('runtime_sessions_ready');

  conversationOperations = createConversationApplicationOperations({
    aiRuntimeManager,
    appendAuditLog,
    assertCodexAccountReady,
    buildTaskPushLayoutForTask,
    codexAppServerManager,
    codexExternalAgentHome,
    codexNativeCoordinator,
    codexNativeEnabled,
    zeusSkillService,
    conversationChoiceQueries,
    conversationExecution,
    conversationExecutionCoordinator,
    conversationPlanActions,
    conversationRequests,
    conversationSubmissions,
    conversationTurns,
    conversations,
    countDirectProjectActiveWritableConversations: (...args: Parameters<typeof countDirectProjectActiveWritableConversations>) => countDirectProjectActiveWritableConversations(...args),
    createTaskCodeReviewPrompt,
    createTaskRuntimePrompt,
    currentCodexRuntimeCommandPath,
    db,
    dispatchUnifiedConversationQueueHead,
    idempotencyRequests,
    isPathInsideProjectRoot,
    mergeTaskPushAttachmentInputs,
    mirrorTaskEnvironmentContainer,
    modelConnections,
    moveTaskToPushedManagementStatus,
    moveTaskTowardRunning,
    nativeIdempotentInFlight,
    normalizeServiceTierForCapability,
    normalizeTaskPushAttachments,
    normalizeTaskPushSupplementalAttachments,
    now,
    options,
    overlayTaskEnvironmentSharedPaths,
    piNativeCoordinator,
    platformMutableState,
    prepareTaskIntegrationAiAttempt: (...args: Parameters<typeof prepareTaskIntegrationAiAttempt>) => prepareTaskIntegrationAiAttempt(...args),
    projectRepositories,
    projectRoot,
    projectSharedPaths,
    projects,
    publishNativeConversationEvent,
    readProjectConfig,
    readServiceTierOverride,
    readTaskWorkspaceReview: (...args: Parameters<typeof readTaskWorkspaceReview>) => readTaskWorkspaceReview(...args),
    reconnectNonCodexLegacyConversationRuntime,
    recordTaskEvent,
    redactSensitiveText,
    resolveConversationCapabilities,
    resolveModelCapability,
    resolveNonCodexLiveSession,
    resolveSelectedTaskPushContext,
    resolveTaskEnvironmentWritableRoots,
    resolveTaskIntegrationRequest: (...args: Parameters<typeof resolveTaskIntegrationRequest>) => resolveTaskIntegrationRequest(...args),
    resolveTaskManagementStatusConfigForProject,
    resolveTaskPushEnvironment: (...args: Parameters<typeof resolveTaskPushEnvironment>) => resolveTaskPushEnvironment(...args),
    resolveTaskPushExecutionCapabilities: (...args) => resolveTaskPushExecutionCapabilities(...args),
    shouldReconnectTaskConversationRuntime,
    taskConflictAiOperations,
    taskConversationExecutionContextPromises,
    taskConversationReopenInProgressIds,
    taskEnvironments,
    taskIntegrationAttempts,
    taskIntegrations,
    taskManagementStatusIsTerminal,
    taskConflictExecutionForConversation,
    taskConversationExecutionWorkspaceMode,
    resolveNativeConversationExecutionRoot,
    ensureNativeConversationExecutionContext,
    taskWorkspaces,
    tasks,
    toGraphConversationHistoryItem,
    transitionTaskStatus,
    trustedConversationAttachmentRoots,
  });
  const {
    archiveNativeConversation,
    restoreNativeConversation,
    toNativeSubmission,
    toNativeServerRequest,
    conversationGoalCapability,
    toNativeQueueApiSnapshot,
    inferNativeConversationSnapshotState,
    requireNativeQueueConversation,
    executeConversationDispatchMessage,
    executeConversationDispatchSideChat,
    prepareConversationQueueReroute,
    applyConversationQueueReroute,
    executeConversationDispatchRequestResponse,
    executeProjectConversationIdempotent,
    executeTaskConversationIdempotent,
    startNativeTaskConversationFromPlan,
    toNativeDurableAcceptance,
    toNativeInterruptAcceptance,
    sendNativeConversationApiError,
    parseProjectGitAction,
    assertRequestedAgentIsCodex,
    assertRequestedAgentKind,
    parseConversationPermissionMode,
    providerTurnClientMessageId,
  } = conversationOperations;
  const gitIntegrationOperations = createGitIntegrationOperations({
    aiRuntimeManager,
    appendAuditLog,
    codexNativeCoordinator,
    conversationSubmissions,
    conversationTurns,
    conversations,
    db,
    executeTaskConversationIdempotent,
    getProjectGitQueries: () => projectGitQueries,
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
  });
  const {
    mapTaskRepositoriesWithConcurrency,
    countDirectProjectActiveWritableConversations,
    resolveTaskPushExecutionCapabilities,
    resolveTaskPushEnvironment,
    countTaskWorkspaceActiveConversations,
    readTaskWorkspaceReview,
    readTaskWorkspaceSnapshot,
    unavailableTaskWorkspaceSnapshot,
    inspectTaskTerminalCleanup,
    closeTaskResourcesForTerminalStatus,
    resolveTaskWorkspaceRequest,
    resolveTaskIntegrationRequest,
    prepareWorkspaceGitCommand,
    executeWorkspaceGitCommand,
    isWorkspaceGitExplicitRejection,
    sendWorkspaceGitCommandError,
    sendTaskGitApiError,
    prepareTaskIntegrationAiAttempt,
    retryTaskIntegrationAiPreparation,
    failTaskIntegrationAiPreparation,
    scheduleTaskIntegrationAiFinalization,
  } = gitIntegrationOperations;
  function persistRuntimeSession(session: AiRuntimeSession): void {
    const existing = runtimeSessions.getById(session.id);
    if (existing) {
      runtimeSessions.updateStatus(session.id, {
        status: session.status,
        exitCode: session.exitCode ?? null,
        endedAt: session.endedAt ?? null,
        pid: session.pid ?? null,
      });
    } else {
      runtimeSessions.create({
        id: session.id,
        projectId: session.projectId,
        taskId: session.taskId,
        command: session.command,
        args: session.args,
        cwd: session.cwd,
        status: session.status,
        pid: session.pid,
        startedAt: session.startedAt,
      });
    }
    if (session.status === 'exited' || session.status === 'failed' || session.status === 'stopped') {
      persistRuntimeConversationSummary(session.id);
      markRuntimeSessionConversationsInactive(session);
      // close 已保证 stdout/stderr 排空；终态发布前合并写入最后一批文件日志。
      try {
        flushRuntimeLogFileWrites();
      } catch (error) {
        runtimePersistenceErrors.push(error);
      }
    }
    if (session.status === 'exited' || session.status === 'failed' || session.status === 'stopped') {
      publishRuntimeSessionEnded(session);
    }
    if (session.status === 'stopped') publishRuntimeSessionEvent('runtime.session.stopped', session);
    writeRuntimeSessionMetadata(session);
    commandCenter.handleRuntimeSessionChange(session);
    void notifyTelegramCommandRunSession(session);
    scheduleRuntimePersistenceSave(session.status !== 'running');
  }

  function persistRuntimeLog(log: AiRuntimeLogEntry): void {
    const persisted = runtimeSessions.appendLog(log);
    // 相同日志 ID 的重复回调不得再次写文件、广播、镜像或触发通知。
    if (!persisted.inserted) return;
    const rawChunkPath = queueRuntimeSessionLogFileWrite(log);
    terminalEvents.setRawChunkPathByRuntimeLogId(log.id, rawChunkPath);
    publishRuntimeLogEvent(log);
    commandCenter.handleRuntimeLog(log);
    void notifyTelegramCommandRunLog(log);
    void notifyTelegramRuntimeProgressSummary(log);
    scheduleRuntimePersistenceSave();
  }

  function scheduleRuntimePersistenceSave(immediate = false): void {
    runtimePersistenceSavePending = true;
    if (immediate) {
      if (runtimePersistenceSaveTimer) clearTimeout(runtimePersistenceSaveTimer);
      runtimePersistenceSaveTimer = undefined;
      commitScheduledRuntimePersistenceSave();
      return;
    }
    if (runtimePersistenceSaveTimer) return;
    runtimePersistenceSaveTimer = setTimeout(() => {
      runtimePersistenceSaveTimer = undefined;
      commitScheduledRuntimePersistenceSave();
    }, 100);
    runtimePersistenceSaveTimer.unref?.();
  }

  function commitScheduledRuntimePersistenceSave(): void {
    if (!runtimePersistenceSavePending) return;
    runtimePersistenceSavePending = false;
    const write = db.save();
    runtimePersistenceWrites.add(write);
    void write
      .catch((error: unknown) => {
        runtimePersistenceErrors.push(error);
      })
      .finally(() => runtimePersistenceWrites.delete(write));
  }

  async function flushRuntimePersistenceWrites(): Promise<void> {
    do {
      if (runtimePersistenceSaveTimer) clearTimeout(runtimePersistenceSaveTimer);
      runtimePersistenceSaveTimer = undefined;
      commitScheduledRuntimePersistenceSave();
      await Promise.allSettled([...runtimePersistenceWrites]);
    } while (runtimePersistenceSavePending || runtimePersistenceSaveTimer || runtimePersistenceWrites.size > 0);
    if (runtimePersistenceErrors.length === 1) throw runtimePersistenceErrors.shift();
    if (runtimePersistenceErrors.length > 1) throw new AggregateError(runtimePersistenceErrors.splice(0), 'AI Runtime 持久化失败。');
  }

  function runtimeSessionDataDirectory(sessionId: string): string {
    return join(runtimeSessionDirectory, sessionId);
  }

  function ensureRuntimeSessionDataDirectory(sessionId: string): string {
    const sessionDirectory = runtimeSessionDataDirectory(sessionId);
    mkdirSync(sessionDirectory, { recursive: true });
    return sessionDirectory;
  }

  function writeRuntimeSessionMetadata(session: AiRuntimeSession): void {
    const sessionDirectory = ensureRuntimeSessionDataDirectory(session.id);
    // metadata.json 只记录真实会话元数据，便于脱离 SQLite 时仍能人工定位终端日志来源。
    writeFileSync(
      join(sessionDirectory, 'metadata.json'),
      `${JSON.stringify(
        {
          sessionId: session.id,
          projectId: session.projectId,
          taskId: session.taskId ?? null,
          command: session.command,
          args: session.args,
          cwd: session.cwd,
          status: session.status,
          pid: session.pid ?? null,
          startedAt: session.startedAt,
          endedAt: session.endedAt ?? null,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  function queueRuntimeSessionLogFileWrite(log: AiRuntimeLogEntry): string {
    const sessionDirectory = ensureRuntimeSessionDataDirectory(log.sessionId);
    const batch = runtimeLogFileBatches.get(log.sessionId) ?? [];
    batch.push(log);
    runtimeLogFileBatches.set(log.sessionId, batch);
    if (!runtimeLogFileFlushTimer) {
      runtimeLogFileFlushTimer = setTimeout(() => {
        runtimeLogFileFlushTimer = undefined;
        try {
          flushRuntimeLogFileWrites();
        } catch (error) {
          // 定时批次失败需保留到终态或关闭阶段统一上报，避免异步回调直接击穿进程。
          runtimeLogFileWriteErrors.push(error);
        }
      }, 100);
      runtimeLogFileFlushTimer.unref?.();
    }
    // 终端事件直接指向规范化日志，避免每个 stdout chunk 再制造一个小文件。
    return join(sessionDirectory, 'terminal.normalized.log');
  }

  function flushRuntimeLogFileWrites(): void {
    if (runtimeLogFileFlushTimer) clearTimeout(runtimeLogFileFlushTimer);
    runtimeLogFileFlushTimer = undefined;
    const pending = [...runtimeLogFileBatches];
    runtimeLogFileBatches.clear();
    for (const [sessionId, logs] of pending) {
      if (logs.length === 0) continue;
      try {
        const sessionDirectory = ensureRuntimeSessionDataDirectory(sessionId);
        // 每 100ms 每个会话最多两次追加，避免每个输出块三次同步文件系统调用和海量 chunks 小文件。
        appendFileSync(join(sessionDirectory, 'terminal.raw.log'), logs.map((log) => `${log.text}${log.text.endsWith('\n') ? '' : '\n'}`).join(''), 'utf8');
        appendFileSync(join(sessionDirectory, 'terminal.normalized.log'), logs.map((log) => `${log.createdAt} [${log.stream}] ${log.text}${log.text.endsWith('\n') ? '' : '\n'}`).join(''), 'utf8');
      } catch (error) {
        runtimeLogFileWriteErrors.push(error);
      }
    }
    if (runtimeLogFileWriteErrors.length === 1) throw runtimeLogFileWriteErrors.shift();
    if (runtimeLogFileWriteErrors.length > 1) throw new AggregateError(runtimeLogFileWriteErrors.splice(0), 'AI Runtime 文件日志写入失败。');
  }

  const platformRoutes = await registerLocalServerPlatformRoutes({
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
    getBoundPort: () => boundPort,
    buildReleaseStatusSnapshot,
    buildReleaseUpdateStatus,
    closeTaskResourcesForTerminalStatus,
    codexAppServerManager,
    codexConfigImportService,
    zeusSkillDefaultCwd: codexHome ?? dataLayout.codexHome,
    zeusSkillService,
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
  });
  closeLocalServerResources = platformRoutes.close;
  projectGitQueries = platformRoutes.projectGitQueries;
  conversationCapabilityQueries = platformRoutes.conversationCapabilityQueries;
  const { commandCenter } = platformRoutes;

  // 先核对“请求已写出但 turn/start 回执丢失”的候选 thread；只有原生 turn 与
  // clientUserMessageId 同时吻合时才补交提升事务，其他情况保持结果未知和队列锁。
  // Pi 运行内核随 Zeus 进程结束，重启时必须把已接纳但未终结的轮次显式收敛为中断。
  if (executionHostDispatchMayResume) {
    for (const attempt of taskIntegrationAttempts.listByState('preparing')) {
      const conversation = conversations.getById(attempt.conversationId);
      if (!conversation) continue;
      taskConflictAiOperations.set(attempt.id, { conversationId: conversation.id, submissionId: attempt.submissionId, running: false, finalizing: false });
      void retryTaskIntegrationAiPreparation(conversation, attempt).catch((error) =>
        failTaskIntegrationAiPreparation({ attemptId: attempt.id, integrationId: attempt.integrationId }, error instanceof Error ? error.message : '重启后无法恢复冲突准备。'),
      );
    }
    await recoverAcceptedPiTurnsAfterRestart();
    await recoverUnifiedOutcomeUnknownSwitches();
  }
  if (!readOnlyValidation) conversationExecution.setDispatchEnabled(executionHostDispatchMayResume);
  if (!readOnlyValidation) await db.save();
  traceStartup('routes_ready');
  return server;
}

function readOnlyValidationCapabilityError(capability: string): Error {
  return Object.assign(new Error(`只读验证模式禁止${capability}。`), {
    code: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
    statusCode: 503,
    recoveryRequired: false as const,
  });
}

/** GET/HEAD 也可能启动 Provider、Keychain、Git、Worker 或读取真实进程；只允许明确的复制库查询面。 */
function isReadOnlyValidationExternalRead(path: string): boolean {
  const blockedPatterns = [
    /^\/api\/(?:codex|provider-runtime|runtime|telegram|model-connections|models\/catalog|zentao-instances|usage-overview|release)(?:\/|$)/u,
    /^\/api\/security\/(?:secrets|reset)(?:\/|$)/u,
    /^\/api\/(?:git|code-map)(?:\/|$)/u,
    /^\/api\/projects\/[^/]+\/(?:git|database\/secret|model-selection|scan-status|codex-task-push-capabilities|codex-conversation-capabilities)(?:\/|$)/u,
    /^\/api\/tasks\/[^/]+\/(?:diff|git-workspaces|integrations)(?:\/|$)/u,
    /^\/api\/projects\/[^/]+\/conversations\/[^/]+\/subagents(?:\/|$)/u,
    /^\/api\/projects\/[^/]+\/conversations\/[^/]+\/resources\/[^/]+\/(?:open-intent|preview)$/u,
    /^\/api\/projects\/[^/]+\/conversations\/[^/]+\/tool-results\/[^/]+$/u,
    /^\/api\/projects\/[^/]+\/conversations\/[^/]+\/turns\/[^/]+\/change-set\/[^/]+\/files\/[^/]+\/(?:open-intent|preview)$/u,
    /^\/api\/execution-host\/handoff(?:\/|$)/u,
    /^\/api\/diagnostics\/storage\/artifacts(?:\/|$)/u,
  ];
  return blockedPatterns.some((pattern) => pattern.test(path));
}

function readOnlyValidationSkippedCapabilities(): Array<{ id: string; reason: string }> {
  return [
    { id: 'core_database_startup_reconciliation', reason: 'query_only database; migrations, repairs, command sealing, handoff recovery and scan recovery skipped' },
    { id: 'codex_remote_control_restore', reason: 'Provider manager replaced by validation-only blocked port' },
    { id: 'codex_legacy_thread_migration', reason: 'Codex disabled before migration branch' },
    { id: 'codex_legacy_import_recovery', reason: 'legacy import service not constructed' },
    { id: 'codex_native_conversation_recovery', reason: 'native recovery branch disabled' },
    { id: 'codex_usage_background_refresh', reason: 'usage timer not installed' },
    { id: 'task_integration_preparing_retry', reason: 'dispatch admission false; preparing attempts not traversed' },
    { id: 'runtime_session_reconciliation', reason: 'persisted PID and PGID are not inspected' },
    { id: 'pi_accepted_turn_recovery', reason: 'Pi Worker not constructed; copied turn state unchanged' },
    { id: 'command_center_interrupted_run_recovery', reason: 'read-only Command Center skips directories and recovery' },
    { id: 'digital_employee_automation_and_execution', reason: 'query-only validation exposes history but does not construct the digital employee scheduler or dispatch Provider, Git, deployment and completion actions' },
    { id: 'heavy_worker_pool_activation', reason: 'worker pool remains closed' },
    { id: 'telegram_polling_and_notification', reason: 'token and Keychain port unavailable; all Telegram admission blocked' },
    { id: 'release_update_scheduler', reason: 'update endpoints blocked and Main scheduler not constructed' },
    { id: 'browser_host_state_restore', reason: 'static snapshot only; WebContentsView creation and navigation blocked in Main' },
  ];
}

/** 启动真实本地 HTTP 服务，端口 0 交给系统选择，始终绑定 127.0.0.1。 */
export async function startZeusLocalServer(options: CreateLocalServerOptions): Promise<RunningZeusLocalServer> {
  const server = await createLocalServer(options);
  let address: string;
  try {
    address = await server.listen({ host: zeusLocalServerHost, port: 0 });
  } catch (listenError) {
    const claimedListenError = claimCodexFinalizationOwnership(listenError);
    const cleanupErrors: unknown[] = [];
    try {
      await (server as ZeusFastifyLifecycle).prepareZeusShutdown?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await server.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    if (cleanupErrors.length > 0) throw claimCodexFinalizationOwnership(new AggregateError([claimedListenError, ...cleanupErrors], 'Zeus local-server listen and cleanup failed.'));
    throw claimedListenError;
  }
  const url = new URL(address);
  const port = Number(url.port);
  (server as FastifyInstance & { setZeusBoundPort?: (port: number) => void }).setZeusBoundPort?.(port);
  return {
    server,
    host: zeusLocalServerHost,
    port,
    baseUrl: `http://${zeusLocalServerHost}:${port}`,
    prepareForShutdown: async () => {
      await (server as ZeusFastifyLifecycle).prepareZeusShutdown?.();
    },
    close: async () => {
      await server.close();
    },
  };
}

function taskStatusEventTitle(status: TaskStatus): string {
  const titles: Record<TaskStatus, string> = {
    draft: '任务回到草稿',
    ready: '任务等待执行',
    running: '任务已开始',
    paused: '任务已暂停',
    waiting_confirmation: '任务等待确认',
    completed: '任务已完成',
    failed: '任务已失败',
    cancelled: '任务已取消',
  };
  return titles[status];
}

function mapWorkManagementTaskDomainError(error: unknown): { statusCode: number; payload: Record<string, unknown> } {
  const code = isObjectLike(error) && typeof Reflect.get(error, 'code') === 'string' ? String(Reflect.get(error, 'code')).slice(0, 160) : 'ZEUS_WORK_MANAGEMENT_TASK_ERROR';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const redacted = redactSensitiveText(rawMessage).text;
  const bytes = Buffer.from(redacted, 'utf8');
  const message =
    bytes.byteLength <= 2_048
      ? redacted
      : `${bytes
          .subarray(0, 2_045)
          .toString('utf8')
          .replace(/\uFFFD$/u, '')}...`;
  const statusCode = code.endsWith('_NOT_FOUND')
    ? 404
    : code.includes('CONFLICT') ||
        code.includes('CHOICE_REQUIRED') ||
        code.includes('REOPEN_REQUIRED') ||
        code.includes('CLEANUP_BUSY') ||
        code.includes('DISABLED') ||
        code.includes('UNAVAILABLE') ||
        code.includes('NOT_AVAILABLE') ||
        code.includes('MISMATCH') ||
        code.includes('STALE')
      ? 409
      : code.startsWith('ZEUS_INVALID_') || code.endsWith('_INVALID') || code.endsWith('_REQUIRED') || code.includes('_UNSUPPORTED')
        ? 400
        : 500;
  return { statusCode, payload: { error: code, message } };
}

function toPassiveRuntimeStatus(runtimeSettings: RuntimeSettingsSnapshot): {
  name: string;
  command: string;
  available: boolean;
  reason: string;
} {
  const adapters = listAiCliAdapters();
  const selected = adapters.find((adapter) => adapter.id === runtimeSettings.defaultAdapterId) ?? adapters.find((adapter) => adapter.id === 'codex');
  if (selected) {
    return {
      name: selected.name,
      command: selected.command,
      available: false,
      reason: `Zeus 未主动检查 ${selected.displayName}。启动和状态刷新不会扫描或执行外部 CLI；请在 Runtime 适配器中手动检查。`,
    };
  }
  return {
    name: 'Codex CLI',
    command: 'codex',
    available: false,
    reason: 'Zeus 未主动检查外部 CLI。请在 Runtime 适配器中选择目标后手动检查。',
  };
}

function writeTaskCompletionToGraphNode(
  db: {
    get: <T>(sql: string, params?: SqlValue[]) => T | undefined;
    execute: (sql: string, params?: SqlValue[]) => void;
  },
  task: ZeusTaskRecord,
): { nodeId: string; sourceRef: string; taskId: string } | undefined {
  const context = parseJsonObject(task.sourceContextJson);
  const graphNode = context.graphNode && typeof context.graphNode === 'object' ? (context.graphNode as { id?: unknown; sourceRef?: unknown }) : undefined;
  const nodeId = typeof graphNode?.id === 'string' ? graphNode.id : undefined;
  if (!nodeId) return undefined;
  const row = db.get<{ id: string; source_ref: string; metadata_json: string }>(`SELECT id, source_ref, metadata_json FROM project_nodes WHERE id = ? LIMIT 1`, [nodeId]);
  if (!row) return undefined;
  const metadata = parseJsonObject(row.metadata_json);
  const existingRecentTasks = Array.isArray(metadata.recentTasks) ? metadata.recentTasks : [];
  const recentTask = {
    taskId: task.id,
    title: task.title,
    status: task.status,
    completedAt: task.updatedAt,
  };
  const recentTasks = [recentTask, ...existingRecentTasks.filter((item) => !isSameTaskSummary(item, task.id))].slice(0, 5);
  const existingRiskTags = Array.isArray(metadata.riskTags) ? metadata.riskTags.filter((item): item is string => typeof item === 'string') : [];
  const riskTags = Array.from(new Set([...existingRiskTags, 'task_completed']));
  db.execute('UPDATE project_nodes SET metadata_json = ? WHERE id = ?', [JSON.stringify({ ...metadata, recentTasks, riskTags }), nodeId]);
  return { nodeId, sourceRef: row.source_ref, taskId: task.id };
}

function isSameTaskSummary(value: unknown, taskId: string): boolean {
  return Boolean(value && typeof value === 'object' && 'taskId' in value && (value as { taskId?: unknown }).taskId === taskId);
}

function toGraphConversationHistoryItem(conversation: ZeusConversationWithMessagesRecord): GraphConversationHistoryItem {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    sessionId: conversation.sessionId,
    title: conversation.title,
    summary: conversation.summary,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    archived: conversation.archived,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      source: message.source,
      metadata: parseJsonObject(message.metadataJson),
      createdAt: message.createdAt,
    })),
  };
}

function buildReadonlyGitChanges(diff: GitDiffSummary): Array<{
  filePath: string;
  changeType: string;
  additions: number;
  deletions: number;
}> {
  const byPath = new Map(diff.fileDiffs.map((file) => [file.newPath, file]));
  return diff.files.map((filePath) => {
    const fileDiff = byPath.get(filePath);
    return {
      filePath,
      changeType: fileDiff?.changeType ?? 'modified',
      additions: fileDiff?.addedLines ?? 0,
      deletions: fileDiff?.deletedLines ?? 0,
    };
  });
}

function conversationResourceRecordsEqual(existing: readonly ZeusConversationResourceRecord[], next: readonly Omit<ZeusConversationResourceRecord, 'createdAt' | 'updatedAt'>[]): boolean {
  if (existing.length !== next.length) return false;
  return existing.every((resource, index) => {
    const candidate = next[index];
    return (
      candidate !== undefined &&
      resource.id === candidate.id &&
      resource.projectId === candidate.projectId &&
      resource.conversationId === candidate.conversationId &&
      resource.turnId === candidate.turnId &&
      resource.itemId === candidate.itemId &&
      resource.sourceIndex === candidate.sourceIndex &&
      resource.canonicalTargetDigest === candidate.canonicalTargetDigest &&
      resource.kind === candidate.kind &&
      resource.presentation === candidate.presentation &&
      resource.displayJson === candidate.displayJson &&
      resource.targetJson === candidate.targetJson &&
      resource.authorityJson === candidate.authorityJson
    );
  });
}

/** 将数据库审计记录转换为本地 API 响应；payload 只解析对象，避免把异常 JSON 透出给界面。 */
function toSecurityAuditLogEntry(record: ZeusAuditLogRecord): SecurityAuditLogEntry {
  return {
    id: record.id,
    actorType: record.actorType,
    actorRef: record.actorRef,
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    payload: parseJsonObject(record.payloadJson),
    createdAt: record.createdAt,
  };
}

/** 仅允许 Electron/file/app 与本机开发 origin 访问本地 API，阻断任意网页带 token 调用。 */
function isAllowedLocalAppOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'file:' || parsed.protocol === 'app:') return true;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function applyLocalCorsHeaders(reply: FastifyReply, origin: string | undefined): void {
  if (!origin || origin === 'null') return;
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Access-Control-Allow-Credentials', 'false');
  reply.header('Access-Control-Allow-Headers', 'authorization,content-type,x-zeus-snapshot-caller,x-zeus-trace-id');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  reply.header('Access-Control-Expose-Headers', 'deprecation,link,server-timing,x-zeus-conversation-snapshot-generation,x-zeus-trace-id');
  reply.header('Vary', 'Origin');
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Runtime 只能启动已登记的 AI CLI adapter 命令，避免本地 API 退化成任意 shell 执行入口。 */
function resolveRegisteredRuntimeAdapter(command: string): AiCliAdapterDescriptor | null {
  const trimmed = command.trim();
  if (trimmed !== command || trimmed.length === 0 || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) return null;
  return listAiCliAdapters().find((adapter) => adapter.command === trimmed) ?? null;
}

/** 判断 Runtime cwd 是否仍位于项目根目录内；相等也允许，避免本地 API 变成项目外 shell 入口。 */
function isPathInsideProjectRoot(candidatePath: string, projectRoot: string): boolean {
  const resolvedCandidate = resolve(candidatePath);
  const resolvedRoot = resolve(projectRoot);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

function redactSensitiveText(value: string): {
  text: string;
  redacted: boolean;
} {
  let redacted = false;
  const replace = (text: string, pattern: RegExp, replacer: string | ((...args: string[]) => string)): string =>
    text.replace(pattern, (...args: string[]) => {
      redacted = true;
      return typeof replacer === 'string' ? replacer : replacer(...args);
    });
  let text = value;
  text = replace(text, /(\b(?:token|api[-_]?key|secret|password)\s*=\s*)[^\s"']+/giu, (_match, prefix) => `${prefix}[REDACTED]`);
  text = replace(text, /(--(?:api-key|token|secret|password)\s+)[^\s"']+/giu, (_match, prefix) => `${prefix}[REDACTED]`);
  text = replace(text, /(\bbearer\s+)(?!or\s+basic\s+authentication\b)[^\s"']+/giu, (_match, prefix) => `${prefix}[REDACTED]`);
  text = replace(text, /\bsecret-[A-Za-z0-9._-]+/gu, '[REDACTED]');
  return { text, redacted };
}
