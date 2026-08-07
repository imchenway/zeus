import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, constants as fsConstants, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { getNextTaskStatus, type TaskStatus } from '@zeus/task-core';
import {
  buildTaskCommitMessageSuggestion,
  cloneTaskManagementStatusConfig,
  type CommandDefinition,
  commandNeedsHighRiskConfirmation,
  type ConversationResource,
  type ConversationResourcePreview,
  isTaskStatusFilter,
  defaultTaskManagementStatusConfig,
  normalizeTaskManagementStatusConfig,
  type TaskAttachmentReference,
  type TaskManagementStatusConfig,
  type TaskStatusFilter,
  validateCommandDefinitionInput,
} from '@zeus/shared';
import { type ProjectScanResult, scanProjectSource } from '@zeus/code-indexer';
import { buildProjectGraph, GRAPH_VIEW_SCHEMA_VERSION, type ProjectGraph } from '@zeus/graph-engine';
import { createDefaultProjectConfig, normalizeProjectConfig, type ProjectConfigSnapshot, type UpdateProjectConfigBody } from '@zeus/project-core';
import {
  type AutoUpdatePolicy,
  buildAutoUpdatePolicy,
  detectReleaseReadiness,
  evaluateReleaseUpdateAvailability,
  parseReleaseUpdateManifest,
  type ReleaseReadiness,
  type ReleaseUpdateArtifactArch,
  type ReleaseUpdateManifest,
  type ReleaseUpdateStatus,
} from '@zeus/release-core';
import {
  type AiCliAdapterDescriptor,
  type AiRuntimeLogEntry,
  type AiRuntimeSession,
  type AiRuntimeTerminalSnapshot,
  buildAiRuntimePrompt,
  checkAiCliAdapter,
  type CodexAppServerManager,
  type CodexRemoteControlClient,
  type CodexRemoteControlPairing,
  type CodexRemoteControlStatus,
  createAgentCapabilityCatalog,
  createAiRuntimeSessionManager,
  createCodexAppServerManager,
  createNonCodexAiCliAdapterInvocation,
  createOptionalNodePtyRuntimeSpawn,
  expandCliSearchPath,
  isNonCodexAiCliAdapterId,
  listAiCliAdapters,
  type NonCodexAiCliAdapterId,
} from '@zeus/ai-runtime';
import type { BrowserAutomationPort } from './browserAutomation.js';
import { resolveConversationAttachmentGrant } from './conversationAttachmentGrant.js';
import { createModelConnectionService, type SaveModelConnectionRequest } from './modelConnectionService.js';
import { createPiNativeConversationCoordinator } from './piNativeConversationCoordinator.js';
import { buildTaskConflictAiPrompt, parseTaskConflictAiAnswer, parseTaskConflictAiBlocks } from './taskConflictAi.js';
import { createMacOSKeychainStore, getSecretPresenceLabel, type SecretPresenceLabel } from '@zeus/security-core';
import {
  buildGitPatchExport,
  buildTaskBranchName,
  buildTaskEnvironmentRootPath,
  cleanupPreparedTaskWorktree,
  commitAndPushTaskWorkspace,
  completeTaskIntegrationCommit,
  confirmGitOperation,
  createGitOperationConfirmation,
  discardTaskWorktree,
  discoverGitRepositories,
  executeHighRiskGitOperation,
  fetchGitRemote,
  finalizeTaskBranchIntegration,
  getGitBranchHead,
  getGitDiff,
  getGitRepositoryContext,
  getGitStatus,
  getGitWorkingContext,
  getRemoteTrackingBranchHead,
  getTaskBranchComparison,
  getTaskBranchFileDiff,
  getTaskWorkspaceFileDiff,
  getTaskWorkspaceReview,
  type GitDiffSummary,
  type GitOperationConfirmation,
  type GitPatchExport,
  type GitStatusSummary,
  type HighRiskGitOperation,
  isGitConfirmationExpired,
  prepareTaskWorktree,
  pushTaskWorkspace,
  readTaskIntegrationConflict,
  reclaimDeliveredTaskWorktree,
  reclaimTaskWorktree,
  rejectGitOperation,
  removeTaskWorktreeForTerminalStatus,
  startTaskBranchIntegration,
  writeTaskIntegrationResolution,
} from '@zeus/git-core';
import {
  type AppendAuditLogInput,
  AuditLogRepository,
  CodexLegacyImportRepository,
  CommandArtifactRepository,
  CommandDefinitionRepository,
  CommandRunRepository,
  type ConversationCollaborationMode,
  ConversationItemRepository,
  type ConversationNextTurnSettings,
  type ConversationPermissionMode,
  ConversationPlanActionRepository,
  ConversationRepository,
  ConversationResourceRepository,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  type CreateTaskEventInput,
  createZeusDatabase,
  GitSnapshotRepository,
  IdempotencyRequestRepository,
  introspectSqliteSchema,
  isTaskManagementStatus,
  isTaskPriority,
  isTaskType,
  ProjectRepository,
  ProjectRepositoryRegistrationRepository,
  ProjectSharedPathRepository,
  type RuntimeLogStream,
  RuntimeSessionRepository,
  SettingRepository,
  TaskEnvironmentRepository,
  TaskEventRepository,
  TaskIntegrationRepository,
  type TaskManagementStatus,
  type TaskPriority,
  TaskRepository,
  TaskTemplateRepository,
  type TaskType,
  TaskWorkspaceRepository,
  TerminalEventRepository,
  TurnChangeFileRepository,
  TurnChangeSetRepository,
  type ZeusAuditLogRecord,
  type ZeusConversationResourceRecord,
  type ZeusConversationWithMessagesRecord,
  type ZeusDatabase,
  type ZeusProjectRecord,
  type ZeusProjectRepositoryRecord,
  type ZeusProjectSharedPathRecord,
  type ZeusRuntimeLogRecord,
  type ZeusRuntimeSessionRecord,
  type ZeusTaskEnvironmentRecord,
  type ZeusTaskIntegrationRecord,
  type ZeusTaskRecord,
  type ZeusTaskWorkspaceRecord,
} from '@zeus/storage';
import { createCodexNativeConversationCoordinator } from './codexNativeConversationCoordinator.js';
import { normalizeConversationResources, toConversationResource, toConversationResourceOpenIntent } from './conversationResources.js';
import { changeSetErrorStatus, createTurnChangeSetService, errorCode as turnChangeSetErrorCode } from './turnChangeSets.js';
import { createCommandCenter } from './commandCenter.js';
import { migrateLegacyCodexThreads } from './legacyCodexThreadMigration.js';
import { type CodexLegacyImportService, createCodexLegacyImportService } from './codexLegacyImportService.js';
import { createCodexConfigImportService } from './codexConfigImportService.js';
import { resolveWritableNonCodexLegacyConversation, type WritableNonCodexLegacyConversationContext } from './nonCodexLegacyRuntime.js';
import {
  createTelegramBotMessageClient,
  createTelegramLongPollingClient,
  createTelegramPollingService,
  dispatchTelegramUpdate,
  getTelegramConfigurationState,
  type TelegramCommand,
  type TelegramCommandResponse,
  type TelegramMessageSender,
  type TelegramPollingService,
  type TelegramUpdate,
} from '@zeus/telegram-adapter';

export type { BrowserAutomationContentItem, BrowserAutomationPort, BrowserAutomationToolCall } from './browserAutomation.js';
export { createConversationAttachmentGrant, resolveConversationAttachmentGrant } from './conversationAttachmentGrant.js';

export const zeusLocalServerHost = '127.0.0.1' as const;
const nativeConversationAttentionEventTypes = new Set(['conversation.turn.started', 'conversation.turn.completed', 'conversation.queue.changed', 'conversation.request.created', 'conversation.request.resolved', 'conversation.native.error']);

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

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function readConversationResourcePreview(resource: Exclude<ConversationResource, { kind: 'website' }>, intent: ReturnType<typeof toConversationResourceOpenIntent>): ConversationResourcePreview {
  const absolutePath = typeof intent.target.absolutePath === 'string' ? resolve(intent.target.absolutePath) : '';
  const allowedRoot = typeof intent.authority.allowedRoot === 'string' ? resolve(intent.authority.allowedRoot) : '';
  if (!absolutePath || !allowedRoot || !isPathInsideRoot(absolutePath, allowedRoot) || absolutePath === allowedRoot) {
    throw Object.assign(new Error('Conversation resource path is outside its authorized root.'), { code: 'ZEUS_CONVERSATION_RESOURCE_FORBIDDEN' });
  }
  const rootRealPath = realpathSync(allowedRoot);
  const fileRealPath = realpathSync(absolutePath);
  if (!isPathInsideRoot(fileRealPath, rootRealPath)) {
    throw Object.assign(new Error('Conversation resource resolves outside its authorized root.'), { code: 'ZEUS_CONVERSATION_RESOURCE_FORBIDDEN' });
  }
  const fileStat = statSync(fileRealPath);
  if (!fileStat.isFile()) {
    throw Object.assign(new Error('Conversation resource is not a regular file.'), { code: 'ZEUS_CONVERSATION_RESOURCE_NOT_FILE' });
  }
  const imageMimeType = conversationImageMimeType(fileRealPath);
  const maximumPreviewBytes = imageMimeType ? 16 * 1024 * 1024 : 2 * 1024 * 1024;
  if (fileStat.size > maximumPreviewBytes) {
    throw Object.assign(new Error('Conversation resource is too large for the Zeus preview.'), { code: 'ZEUS_CONVERSATION_RESOURCE_TOO_LARGE' });
  }
  const bytes = readFileSync(fileRealPath);
  if (imageMimeType) {
    return {
      kind: 'image',
      resource,
      mimeType: imageMimeType,
      dataUrl: `data:${imageMimeType};base64,${bytes.toString('base64')}`,
      byteLength: bytes.byteLength,
    };
  }
  if (bytes.includes(0)) {
    throw Object.assign(new Error('Binary files cannot be rendered in the source preview.'), { code: 'ZEUS_CONVERSATION_RESOURCE_BINARY' });
  }
  const content = bytes.toString('utf8');
  return {
    kind: 'source',
    resource,
    language: sourceLanguageForPath(fileRealPath),
    content,
    lineCount: sourcePreviewLineCount(content),
    truncated: false,
    ...(resource.kind === 'file' && resource.location ? { location: resource.location } : {}),
  };
}

function sourcePreviewLineCount(content: string): number {
  const normalized = content.replace(/\r\n?/gu, '\n');
  if (normalized === '') return 1;
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n').length;
}

function conversationImageMimeType(path: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif' | 'image/bmp' | 'image/x-icon' | null {
  const extension = path.slice(path.lastIndexOf('.')).toLocaleLowerCase();
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
  } as const;
  return mimeTypes[extension as keyof typeof mimeTypes] ?? null;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

function sourceLanguageForPath(path: string): string | null {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLocaleLowerCase();
  const languages: Record<string, string> = {
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    h: 'c',
    hpp: 'cpp',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    kt: 'kotlin',
    md: 'markdown',
    php: 'php',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scss: 'scss',
    sh: 'shell',
    sql: 'sql',
    swift: 'swift',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'text',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return languages[extension] ?? null;
}

export interface CreateLocalServerOptions {
  dbPath: string;
  apiToken: string;
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

interface ZeusRealtimeSocket {
  OPEN: number;
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: 'close', listener: () => void) => void;
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

export interface GraphViewSnapshot {
  id: string;
  schemaVersion: number;
  projectId?: string;
  projectName?: string;
  title: string;
  viewType: string;
  layout?: {
    algorithm: string;
    width: number;
    height: number;
    positions: Array<{ nodeId: string; x: number; y: number }>;
  };
  nodes: Array<{
    id: string;
    nodeType: string;
    name: string;
    qualifiedName: string;
    sourceRef: string;
    symbolId: string;
    metadata: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    edgeType: string;
    sourceNodeId: string;
    targetNodeId: string;
    sourceRef: string;
    confidence: number;
    metadata: Record<string, unknown>;
  }>;
  performance?: { durationMs: number; nodeCount: number; edgeCount: number };
}

export interface GraphSearchResult {
  query: string;
  nodeType: string | null;
  edgeType: string | null;
  minConfidence: number;
  nodes: GraphViewSnapshot['nodes'];
  edges: GraphViewSnapshot['edges'];
}

export type GraphEdgeDetail = GraphViewSnapshot['edges'][number] & {
  sourceNode: GraphViewSnapshot['nodes'][number];
  targetNode: GraphViewSnapshot['nodes'][number];
};

export interface GraphNeighborhood {
  centerNode: GraphViewSnapshot['nodes'][number];
  depth: number;
  nodes: GraphViewSnapshot['nodes'];
  edges: GraphViewSnapshot['edges'];
}

interface GraphQuestionAnswer {
  projectId: string;
  question: string;
  answer: string;
  sessionId: string | null;
  conversationId?: string | null;
  sources: {
    nodes: GraphViewSnapshot['nodes'];
    edges: GraphViewSnapshot['edges'];
  };
}

interface GraphConversationHistoryItem {
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

interface GraphConversationHistoryPage {
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
  runtime: {
    aiCli: { available: boolean; reason: string };
    telegram: { enabled: boolean; reason: string };
  };
  git: GitStatusSummary;
  graph: { nodeCount: number; edgeCount: number; viewCount: number };
}

type ProjectConversationAttentionState = 'idle' | 'running' | 'reply_required';

interface RuntimeStatusSnapshot {
  aiCli: { name: string; command: string; available: boolean; reason: string };
  telegram: { enabled: boolean; reason: string };
  terminal: {
    provider: 'node-pty' | 'child_process';
    pty: { available: boolean; reason: string };
  };
}

interface CodexRemoteControlSnapshot {
  enabled: boolean;
  status: CodexRemoteControlStatus;
  clients: CodexRemoteControlClient[];
}

interface CodexRemoteControlPairingSnapshot extends CodexRemoteControlPairing {
  claimed: boolean;
}

interface SecuritySecretsSnapshot {
  telegramBotToken: SecretPresenceLabel;
  externalApiKey: SecretPresenceLabel;
}

interface ProjectDatabaseSecretSnapshot {
  connectionName: string | null;
  password: SecretPresenceLabel;
}

interface SecurityResetResult {
  secrets: SecuritySecretsSnapshot;
  telegramNotificationSettings: TelegramNotificationSettingsSnapshot;
  telegramSecuritySettings: TelegramSecuritySettingsSnapshot;
}

interface ReleaseStatusSnapshot {
  signing: { configured: boolean; label: string };
  notarization: { configured: boolean; label: string };
  homebrewCask: { configured: boolean; label: string };
  releaseWorkflow: { configured: boolean; label: string };
  readiness: ReleaseReadiness;
  autoUpdate: AutoUpdatePolicy;
}

interface ReleaseUpdateOperationSnapshot {
  accepted: boolean;
  update: ReleaseUpdateStatus & { executionHost: ExecutionHostWorkStatusSnapshot };
  reason: string;
}

interface ExecutionHostWorkStatusSnapshot {
  instanceId: string | null;
  protocolVersion: number;
  mode: 'embedded' | 'detached';
  pid: number;
  startedAt: string | null;
  transport: {
    state: 'idle' | 'starting' | 'ready' | 'restarting' | 'closed';
    generationId: string | null;
  };
  runtimeGenerations: Array<{
    generationId: string;
    state: 'idle' | 'starting' | 'ready' | 'restarting' | 'closed';
    active: boolean;
    activeThreadCount: number;
    pendingRequestCount: number;
  }>;
  activeTurnCount: number;
  effectfulTurnCount: number;
  waitingRequestCount: number;
  activeRuntimeCount: number;
  activeCommandRunCount: number;
  hasActiveWork: boolean;
  observedAt: string;
}

interface ExecutionHostStopResult {
  requestedTurnCount: number;
  stoppedRuntimeCount: number;
  failedTurns: Array<{ conversationId: string; providerTurnId: string; message: string }>;
  requestedAt: string;
}

interface ExecutionHostHandoffCheckpoint {
  sourceInstanceId: string;
  capturedAt: string;
  requests: Array<{
    id: string;
    conversationId: string;
    transportGenerationId: string;
    requestKind: 'command' | 'file' | 'permissions' | 'request_user_input' | 'mcp';
  }>;
}

interface SaveTelegramTokenBody {
  token?: string;
}

interface SaveExternalApiKeyBody {
  key?: string;
}

interface SaveProjectDatabaseSecretBody {
  password?: string;
}

interface TelegramNotificationSettingsSnapshot {
  enabled: boolean;
  chatIds: number[];
  silentMode: boolean;
}

interface TelegramSecuritySettingsSnapshot {
  allowedUserIds: number[];
}

interface TelegramTestConnectionResult {
  ok: boolean;
  chatIds: number[];
  attempts: number;
  sentAt: string;
}

interface TelegramStatusSnapshot {
  configured: boolean;
  reason: string;
  polling: ReturnType<TelegramPollingService['status']>;
  notificationSettings: TelegramNotificationSettingsSnapshot;
  securitySettings: TelegramSecuritySettingsSnapshot;
}

interface TelegramSettingsSnapshot {
  notificationSettings: TelegramNotificationSettingsSnapshot;
  securitySettings: TelegramSecuritySettingsSnapshot;
}

interface UpdateTelegramSettingsBody extends UpdateTelegramNotificationSettingsBody, UpdateTelegramSecuritySettingsBody {}

interface UpdateTelegramNotificationSettingsBody {
  enabled?: boolean;
  chatIds?: number[];
  silentMode?: boolean;
}

interface UpdateTelegramSecuritySettingsBody {
  allowedUserIds?: number[];
}

type RuntimeAutoConfirmationPolicy = 'never' | 'low_risk_only';

interface RuntimeSettingsSnapshot {
  defaultAdapterId: AiCliAdapterDescriptor['id'];
  adapterModels: Partial<Record<AiCliAdapterDescriptor['id'], string>>;
  adapterDefaultArgs: Partial<Record<AiCliAdapterDescriptor['id'], string[]>>;
  adapterCliPaths: Partial<Record<AiCliAdapterDescriptor['id'], string>>;
  terminalEnv: Record<string, string>;
  shell: {
    path: string | null;
    login: boolean;
  };
  concurrency: {
    maxPerProject: number;
    maxGlobal: number;
  };
  executionTimeoutSeconds: number;
  logRetentionDays: number;
  autoConfirmationPolicy: RuntimeAutoConfirmationPolicy;
}

interface CodeMapSettingsSnapshot {
  defaultScanScope: 'project' | 'src' | 'custom';
  defaultIgnoreDirectories: string[];
  maxCallChainDepth: number;
  showLowConfidenceEdges: boolean;
  layoutAlgorithm: 'hierarchical' | 'force' | 'dagre';
  graphCacheStrategy: 'sqlite' | 'memory' | 'disabled';
  tableRelationInference: 'foreign_key_and_name' | 'foreign_key_only' | 'name_only' | 'disabled';
  aiSummaryEnabled: boolean;
  incrementalScanEnabled: boolean;
  performanceMonitoringEnabled: boolean;
  moduleFlowManualNotes: string;
}

interface UpdateCodeMapSettingsBody {
  defaultScanScope?: unknown;
  defaultIgnoreDirectories?: unknown;
  maxCallChainDepth?: unknown;
  showLowConfidenceEdges?: unknown;
  layoutAlgorithm?: unknown;
  graphCacheStrategy?: unknown;
  tableRelationInference?: unknown;
  aiSummaryEnabled?: unknown;
  incrementalScanEnabled?: unknown;
  performanceMonitoringEnabled?: unknown;
  moduleFlowManualNotes?: unknown;
}

interface UpdateRuntimeSettingsBody {
  defaultAdapterId?: string;
  adapterModels?: Record<string, unknown>;
  adapterDefaultArgs?: Record<string, unknown>;
  adapterCliPaths?: Record<string, unknown>;
  terminalEnv?: Record<string, unknown>;
  shell?: {
    path?: unknown;
    login?: unknown;
  };
  concurrency?: {
    maxPerProject?: unknown;
    maxGlobal?: unknown;
  };
  executionTimeoutSeconds?: unknown;
  logRetentionDays?: unknown;
  autoConfirmationPolicy?: unknown;
}

type AppAppearance = 'system' | 'light' | 'dark';
type AppLanguage = 'zh-CN' | 'en-US';
type TaskTableColumnKey =
  | 'code'
  | 'intent'
  | 'taskType'
  | 'managementStatus'
  | 'branchStatus'
  | 'runStatus'
  | 'source'
  | 'updatedAt'
  | 'createdAt'
  | 'template'
  | 'project'
  | 'priority'
  | 'description'
  | 'runtimeSession'
  | 'rawId'
  | 'createdFrom';
type TaskTableColumnWidth = number;
type TaskTableSortDirection = 'asc' | 'desc';
type TaskAgentRunStatus = 'not_started' | 'connecting' | 'reconnecting' | 'running' | 'waiting_user' | 'waiting_approval' | 'paused' | 'idle' | 'failed' | 'legacy_readonly';

interface TaskTableSortState {
  columnKey: TaskTableColumnKey | null;
  direction: TaskTableSortDirection | null;
}

interface TaskTableColumnPreferences {
  visibleColumnKeys: TaskTableColumnKey[];
  columnOrder: TaskTableColumnKey[];
  columnWidths?: Partial<Record<TaskTableColumnKey, TaskTableColumnWidth>>;
  sort: TaskTableSortState;
}

interface TaskTableEnumSortOrders {
  priority: TaskPriority[];
  managementStatus: TaskManagementStatus[];
  runStatus: TaskAgentRunStatus[];
}

const defaultTaskTableColumnOrder: TaskTableColumnKey[] = [
  'code',
  'intent',
  'taskType',
  'managementStatus',
  'branchStatus',
  'runStatus',
  'source',
  'createdAt',
  'updatedAt',
  'template',
  'project',
  'priority',
  'description',
  'runtimeSession',
  'rawId',
  'createdFrom',
];
const defaultVisibleTaskTableColumns: TaskTableColumnKey[] = ['code', 'intent', 'taskType', 'managementStatus', 'branchStatus', 'runStatus', 'source', 'createdAt', 'updatedAt'];
const defaultTaskTableColumnWidths: Record<TaskTableColumnKey, number> = {
  code: 112,
  intent: 280,
  taskType: 96,
  managementStatus: 112,
  branchStatus: 128,
  runStatus: 132,
  source: 120,
  updatedAt: 148,
  createdAt: 148,
  template: 144,
  project: 144,
  priority: 112,
  description: 220,
  runtimeSession: 180,
  rawId: 180,
  createdFrom: 144,
};
const legacyTaskTableColumnWidthScale = {
  compact: 0.78,
  standard: 1,
  wide: 1.35,
} as const;
const defaultTaskTableEnumSortOrders: TaskTableEnumSortOrders = {
  priority: ['p0', 'p1', 'p2', 'p3', 'p4'],
  managementStatus: ['todo', 'in_development', 'in_testing', 'awaiting_acceptance', 'blocked', 'completed', 'cancelled'],
  runStatus: ['not_started', 'connecting', 'reconnecting', 'running', 'waiting_user', 'waiting_approval', 'paused', 'idle', 'failed', 'legacy_readonly'],
};
const preBranchStatusDefaultTaskTableColumnOrder: TaskTableColumnKey[] = [
  'code',
  'intent',
  'managementStatus',
  'runStatus',
  'source',
  'createdAt',
  'updatedAt',
  'template',
  'project',
  'priority',
  'description',
  'runtimeSession',
  'rawId',
  'createdFrom',
];
const preBranchStatusDefaultVisibleTaskTableColumns: TaskTableColumnKey[] = ['code', 'intent', 'managementStatus', 'runStatus', 'source', 'createdAt', 'updatedAt'];
const previousDefaultTaskTableColumns: Array<{ visible: TaskTableColumnKey[]; order: TaskTableColumnKey[] }> = [
  {
    visible: preBranchStatusDefaultVisibleTaskTableColumns,
    order: preBranchStatusDefaultTaskTableColumnOrder,
  },
  {
    visible: ['code', 'intent', 'managementStatus', 'runStatus', 'source', 'updatedAt'],
    order: ['code', 'intent', 'managementStatus', 'runStatus', 'source', 'updatedAt', 'createdAt', 'template', 'project', 'priority', 'description', 'runtimeSession', 'rawId', 'createdFrom'],
  },
];
const taskTableColumnKeySet = new Set<TaskTableColumnKey>(defaultTaskTableColumnOrder);
const legacyTaskTableColumnKeySet = new Set(['nextAction', 'aiExecution', 'signals']);

function normalizeTaskTableColumnKeys(value: unknown, fallback: TaskTableColumnKey[]): TaskTableColumnKey[] {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<TaskTableColumnKey>();
  const keys = value.filter((item): item is TaskTableColumnKey => typeof item === 'string' && taskTableColumnKeySet.has(item as TaskTableColumnKey));
  for (const key of keys) seen.add(key);
  return seen.size > 0 ? Array.from(seen) : fallback;
}

function normalizeTaskTableColumnPreferences(value: unknown): TaskTableColumnPreferences {
  const input = typeof value === 'object' && value !== null ? (value as Partial<TaskTableColumnPreferences>) : {};
  const hasLegacyColumns = containsLegacyTaskTableColumnKeys(input.visibleColumnKeys) || containsLegacyTaskTableColumnKeys(input.columnOrder);
  const visible = normalizeTaskTableColumnKeys(migrateLegacyTaskTableColumnKeys(input.visibleColumnKeys), defaultVisibleTaskTableColumns);
  // 编码和意图是任务列表的识别锚点，即使导入/保存缺失也要补回，避免用户配置损坏导致任务不可扫描。
  let visibleWithRequired = Array.from(new Set<TaskTableColumnKey>([...visible, 'code', 'intent']));
  const order = normalizeTaskTableColumnKeys(migrateLegacyTaskTableColumnKeys(input.columnOrder), defaultTaskTableColumnOrder);
  if (hasLegacyColumns) visibleWithRequired = placeStatusColumnsAfterIntent(visibleWithRequired);
  let migratedOrder = hasLegacyColumns ? placeStatusColumnsAfterIntent(order) : order;
  const usesPreviousDefault = previousDefaultTaskTableColumns.some((defaults) => taskTableColumnArraysEqual(visibleWithRequired, defaults.visible) && taskTableColumnArraysEqual(migratedOrder, defaults.order));
  if (usesPreviousDefault) {
    visibleWithRequired = [...defaultVisibleTaskTableColumns];
    migratedOrder = [...defaultTaskTableColumnOrder];
  } else {
    migratedOrder = insertMissingBranchStatusAfterManagementStatus(migratedOrder);
  }
  const columnWidths = normalizeTaskTableColumnWidths(input.columnWidths);
  const sort = normalizeTaskTableSortState(input.sort);
  // 用户传入顺序只决定已知列的优先级，其他合法列按默认顺序补齐，保证前端刷新后列集合稳定。
  const ordered = [...migratedOrder, ...defaultTaskTableColumnOrder.filter((key) => !migratedOrder.includes(key))];
  const normalized: TaskTableColumnPreferences = {
    visibleColumnKeys: visibleWithRequired.filter((key) => taskTableColumnKeySet.has(key)),
    columnOrder: ordered,
    sort,
  };
  if (columnWidths) normalized.columnWidths = columnWidths;
  return normalized;
}

function insertMissingBranchStatusAfterManagementStatus(keys: TaskTableColumnKey[]): TaskTableColumnKey[] {
  if (keys.includes('branchStatus')) return keys;
  const managementStatusIndex = keys.indexOf('managementStatus');
  const insertIndex = managementStatusIndex >= 0 ? managementStatusIndex + 1 : 0;
  return [...keys.slice(0, insertIndex), 'branchStatus', ...keys.slice(insertIndex)];
}

function taskTableColumnArraysEqual(left: readonly TaskTableColumnKey[], right: readonly TaskTableColumnKey[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function normalizeTaskTableColumnWidths(value: unknown): Partial<Record<TaskTableColumnKey, TaskTableColumnWidth>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const normalized: Partial<Record<TaskTableColumnKey, TaskTableColumnWidth>> = {};
  for (const [key, width] of Object.entries(value)) {
    if (!taskTableColumnKeySet.has(key as TaskTableColumnKey)) continue;
    const normalizedWidth = normalizeTaskTableColumnWidth(key as TaskTableColumnKey, width);
    if (normalizedWidth === null) continue;
    normalized[key as TaskTableColumnKey] = normalizedWidth;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeTaskTableColumnWidth(columnKey: TaskTableColumnKey, value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(640, Math.max(64, Math.round(value)));
  if (typeof value !== 'string' || !(value in legacyTaskTableColumnWidthScale)) return null;
  const scale = legacyTaskTableColumnWidthScale[value as keyof typeof legacyTaskTableColumnWidthScale];
  return Math.round(defaultTaskTableColumnWidths[columnKey] * scale);
}

function normalizeTaskTableSortState(value: unknown): TaskTableSortState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { columnKey: null, direction: null };
  const input = value as Partial<TaskTableSortState>;
  const columnKey = typeof input.columnKey === 'string' && taskTableColumnKeySet.has(input.columnKey as TaskTableColumnKey) ? (input.columnKey as TaskTableColumnKey) : null;
  const direction = input.direction === 'asc' || input.direction === 'desc' ? input.direction : null;
  return columnKey && direction ? { columnKey, direction } : { columnKey: null, direction: null };
}

function normalizeTaskTableColumnsByProject(value: unknown): Record<string, TaskTableColumnPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, TaskTableColumnPreferences> = {};
  for (const [projectId, preferences] of Object.entries(value)) {
    const normalizedProjectId = projectId.trim();
    const containsControlCharacter = Array.from(normalizedProjectId).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
    if (!normalizedProjectId || normalizedProjectId.length > 160 || containsControlCharacter) continue;
    normalized[normalizedProjectId] = normalizeTaskTableColumnPreferences(preferences);
  }
  return normalized;
}

function normalizeTaskStatusFilterByProject(value: unknown): Record<string, TaskStatusFilter> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, TaskStatusFilter> = {};
  let count = 0;
  for (const [projectId, filter] of Object.entries(value)) {
    const normalizedProjectId = projectId.trim();
    const containsControlCharacter = Array.from(normalizedProjectId).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
    if (!normalizedProjectId || normalizedProjectId.length > 160 || containsControlCharacter || !isTaskStatusFilter(filter)) continue;
    normalized[normalizedProjectId] = filter;
    count += 1;
    if (count >= 100) break;
  }
  return normalized;
}

function normalizeTaskViewModeByProject(value: unknown): Record<string, 'hierarchy' | 'flat'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([projectId, mode]) => Boolean(projectId.trim()) && projectId.length <= 160 && (mode === 'hierarchy' || mode === 'flat'))
      .slice(0, 100),
  ) as Record<string, 'hierarchy' | 'flat'>;
}

function normalizeTaskExpandedIdsByProject(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, string[]> = {};
  for (const [projectId, taskIds] of Object.entries(value)) {
    if (!projectId.trim() || projectId.length > 160 || !Array.isArray(taskIds)) continue;
    normalized[projectId] = [...new Set(taskIds.filter((taskId): taskId is string => typeof taskId === 'string' && Boolean(taskId.trim()) && taskId.length <= 160))].slice(0, 500);
  }
  return normalized;
}

function normalizeTaskManagementStatusByProject(value: unknown, template: TaskManagementStatusConfig): Record<string, TaskManagementStatusConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, TaskManagementStatusConfig> = {};
  for (const [projectId, config] of Object.entries(value)) {
    const normalizedProjectId = projectId.trim();
    const containsControlCharacter = Array.from(normalizedProjectId).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
    if (!normalizedProjectId || normalizedProjectId.length > 160 || containsControlCharacter) continue;
    normalized[normalizedProjectId] = normalizeTaskManagementStatusConfig(config, template);
    if (Object.keys(normalized).length >= 100) break;
  }
  return normalized;
}

function normalizeTaskTableEnumSortOrders(value: unknown): TaskTableEnumSortOrders {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<TaskTableEnumSortOrders>) : {};
  return {
    priority: normalizeEnumOrder(input.priority, defaultTaskTableEnumSortOrders.priority),
    managementStatus: normalizeEnumOrder(input.managementStatus, defaultTaskTableEnumSortOrders.managementStatus),
    runStatus: normalizeEnumOrder(input.runStatus, defaultTaskTableEnumSortOrders.runStatus),
  };
}

function normalizeEnumOrder<T extends string>(value: unknown, fallback: readonly T[]): T[] {
  if (!Array.isArray(value)) return [...fallback];
  const allowed = new Set(fallback);
  const normalized = Array.from(new Set(value.filter((item): item is T => typeof item === 'string' && allowed.has(item as T))));
  return [...normalized, ...fallback.filter((item) => !normalized.includes(item))];
}

function containsLegacyTaskTableColumnKeys(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => typeof item === 'string' && legacyTaskTableColumnKeySet.has(item));
}

function placeStatusColumnsAfterIntent(keys: TaskTableColumnKey[]): TaskTableColumnKey[] {
  const withoutStatusColumns = keys.filter((key) => key !== 'managementStatus' && key !== 'runStatus');
  const intentIndex = withoutStatusColumns.indexOf('intent');
  const insertIndex = intentIndex >= 0 ? intentIndex + 1 : 0;
  return [...withoutStatusColumns.slice(0, insertIndex), 'managementStatus', 'runStatus', ...withoutStatusColumns.slice(insertIndex)];
}

function migrateLegacyTaskTableColumnKeys(value: unknown): unknown {
  if (!containsLegacyTaskTableColumnKeys(value)) return value;
  if (!Array.isArray(value)) return value;
  const migrated: string[] = [];
  let insertedStatusColumns = false;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (legacyTaskTableColumnKeySet.has(item)) {
      if (!insertedStatusColumns) {
        migrated.push('managementStatus', 'runStatus');
        insertedStatusColumns = true;
      }
      continue;
    }
    migrated.push(item);
  }
  return migrated;
}

interface AppShellSettingsSnapshot {
  appLanguage: AppLanguage;
  appearance: AppAppearance;
  webviewDebugEnabled: boolean;
  developerModeEnabled: boolean;
  multiWindowEnabled: boolean;
  backgroundModeEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  openAtLoginEnabled: boolean;
  autoUpdateChannel: 'manual';
  defaultProjectId: string | null;
  pinnedProjectIds: string[];
  collapsedProjectIds: string[];
  defaultModel: string | null;
  defaultTaskTemplateId: string | null;
  taskTableColumns: TaskTableColumnPreferences;
  taskTableColumnsByProject: Record<string, TaskTableColumnPreferences>;
  taskTableEnumSortOrders: TaskTableEnumSortOrders;
  taskManagementStatusTemplate: TaskManagementStatusConfig;
  taskManagementStatusByProject: Record<string, TaskManagementStatusConfig>;
  taskStatusFilterByProject: Record<string, TaskStatusFilter>;
  taskViewModeByProject: Record<string, 'hierarchy' | 'flat'>;
  taskExpandedIdsByProject: Record<string, string[]>;
  localLogDirectory: string;
  localConfigPath: string;
  dataPortability: {
    importSupported: boolean;
    exportSupported: boolean;
    redactsSecrets: boolean;
  };
  cache: {
    codeIndex: boolean;
    graphView: boolean;
    layout: boolean;
  };
  lastCacheClearAt: string | null;
}

interface UpdateAppShellSettingsBody {
  appLanguage?: AppLanguage;
  appearance?: AppAppearance;
  webviewDebugEnabled?: boolean;
  developerModeEnabled?: boolean;
  multiWindowEnabled?: boolean;
  backgroundModeEnabled?: boolean;
  desktopNotificationsEnabled?: boolean;
  openAtLoginEnabled?: boolean;
  autoUpdateChannel?: 'manual';
  defaultProjectId?: string | null;
  pinnedProjectIds?: string[];
  collapsedProjectIds?: string[];
  defaultModel?: string | null;
  defaultTaskTemplateId?: string | null;
  taskTableColumns?: Partial<TaskTableColumnPreferences>;
  taskTableColumnsByProject?: Record<string, TaskTableColumnPreferences>;
  taskTableEnumSortOrders?: TaskTableEnumSortOrders;
  taskManagementStatusTemplate?: TaskManagementStatusConfig;
  taskManagementStatusByProject?: Record<string, TaskManagementStatusConfig>;
  /** 删除状态时只作为本次保存的迁移指令，不进入持久设置。 */
  taskManagementStatusReplacements?: Record<string, Record<string, string>>;
  taskStatusFilterByProject?: Record<string, TaskStatusFilter>;
  taskViewModeByProject?: Record<string, 'hierarchy' | 'flat'>;
  taskExpandedIdsByProject?: Record<string, string[]>;
}

interface ClearCacheResult {
  cleared: boolean;
  clearedCaches: Array<'code-index' | 'graph-view' | 'layout'>;
  clearedAt: string;
}

interface LocalSettingsExportSnapshot {
  app: 'Zeus';
  schemaVersion: 1;
  exportedAt: string;
  redaction: {
    secretsRedacted: true;
  };
  settings: {
    appShell: AppShellSettingsSnapshot;
    runtime: RuntimeSettingsSnapshot;
    codeMap: CodeMapSettingsSnapshot;
    telegramNotification: TelegramNotificationSettingsSnapshot;
    telegramSecurity: TelegramSecuritySettingsSnapshot;
  };
}

interface ImportLocalSettingsBody {
  schemaVersion?: number;
  settings?: {
    appShell?: UpdateAppShellSettingsBody;
    runtime?: RuntimeSettingsSnapshot;
    codeMap?: UpdateCodeMapSettingsBody;
    telegramNotification?: TelegramNotificationSettingsSnapshot;
    telegramSecurity?: TelegramSecuritySettingsSnapshot;
  };
}

interface ImportLocalSettingsResult {
  imported: boolean;
  importedSettings: string[];
  importedAt: string;
}

interface LocalDataExportSnapshot {
  app: 'Zeus';
  schemaVersion: 1 | 2;
  exportedAt: string;
  redaction: {
    secretsRedacted: true;
  };
  data: {
    projects: PortableProjectRecord[];
    tasks: PortableTaskRecord[];
    taskEvents: PortableTaskEventRecord[];
    taskTemplates: PortableTaskTemplateRecord[];
    commandDefinitions?: CommandDefinition[];
  };
}

interface ImportLocalDataResult {
  imported: boolean;
  importedCounts: {
    projects: number;
    tasks: number;
    taskEvents: number;
    taskTemplates: number;
    commandDefinitions: number;
  };
  importedAt: string;
}

interface PortableProjectRecord {
  id: string;
  name: string;
  slug: string;
  localPath: string;
  description: string | null;
  note: string | null;
  defaultTemplateId: string | null;
  scanStatus: string;
  createdAt: string;
  updatedAt: string;
}

interface PortableTaskRecord {
  id: string;
  projectId: string;
  title: string;
  taskType?: TaskType;
  description: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  managementStatus?: TaskManagementStatus;
  status: string;
  tags: string[];
  templateId: string | null;
  taskCode?: string;
  taskSequence?: number | null;
  priority?: string;
  createdFrom: string;
  sourceContextJson: string;
  createdAt: string;
  updatedAt: string;
}

interface PortableTaskEventRecord {
  id: string;
  taskId: string;
  eventType: string;
  title: string;
  payloadJson: string;
  createdAt: string;
}

interface PortableTaskTemplateRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  promptTemplate: string;
  defaultOptionsJson: string;
  projectId: string | null;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CreateProjectBody {
  name: string;
  localPath: string;
  description?: string;
  note?: string;
  defaultModel?: unknown;
  defaultWorkMode?: unknown;
  defaultTaskPrompt?: unknown;
}

interface UpdateProjectBody {
  name?: string;
  localPath?: string;
  description?: string | null;
  note?: string | null;
}

interface UpdateProjectWorkspaceConfigBody {
  sharedWritablePaths?: Array<{ localPath?: unknown }>;
}

interface CreateTaskBody {
  projectId: string;
  parentTaskId?: string | null;
  title: string;
  taskType?: TaskType;
  description?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  sourceContext?: Record<string, unknown>;
  tags?: string[];
  priority?: TaskPriority;
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
}

interface ListTasksQuery {
  projectId?: string;
  query?: string;
  status?: TaskStatus;
  managementStatus?: TaskManagementStatus;
  tag?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'taskType' | 'status' | 'managementStatus';
  sortDirection?: 'asc' | 'desc';
}

interface CreateTaskTemplateBody {
  projectId?: string;
  name: string;
  description: string;
  promptTemplate: string;
  category?: string;
  defaultOptions?: Record<string, unknown>;
}

interface SetProjectDefaultTemplateBody {
  templateId: string | null;
}

interface CreateTaskFromTemplateBody {
  projectId: string;
  title?: string;
  variables?: Record<string, string>;
}

interface CreateTaskFromGraphNodeBody {
  projectId: string;
  intent?: string;
}

interface CreateProjectGraphTaskBody {
  intent?: string;
}

interface LinkGraphNodeBody {
  nodeId?: string;
  reason?: string;
}

interface CreateTaskFromGraphConversationBody {
  intent?: string;
}

interface AskProjectGraphBody {
  question?: string;
}

interface UpdateTaskStatusBody {
  status: TaskStatus;
}

interface UpdateTaskManagementStatusBody {
  status: TaskManagementStatus;
  expectedUpdatedAt?: string;
  confirmWorktreeCleanup?: boolean;
}

interface UpdateTaskBody {
  expectedUpdatedAt?: string;
  title?: string;
  taskType?: TaskType;
  description?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  priority?: TaskPriority;
  tags?: string[];
  attachments?: TaskAttachmentReference[];
  sourceContext?: Record<string, unknown>;
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
}

interface UpdateTaskRelationshipsBody {
  expectedUpdatedAt?: string;
  parentTaskId?: string | null;
  relatedTaskIds?: string[];
}

interface DeleteTaskBody {
  childStrategy?: 'reparent' | 'delete_descendants' | 'make_roots';
  replacementParentTaskId?: string;
}

interface UpdateTaskTagsBody {
  tags?: string[];
  expectedUpdatedAt?: string;
}

function normalizeTaskAttachmentReferences(value: unknown): TaskAttachmentReference[] | null {
  if (!Array.isArray(value) || value.length > 24) return null;
  const byPath = new Map<string, TaskAttachmentReference>();
  for (const rawAttachment of value) {
    if (!rawAttachment || typeof rawAttachment !== 'object' || Array.isArray(rawAttachment)) return null;
    const attachment = rawAttachment as Record<string, unknown>;
    const path = typeof attachment.path === 'string' ? attachment.path.trim() : '';
    const name = typeof attachment.name === 'string' ? attachment.name.trim() : '';
    const kind = attachment.kind;
    if (!path || !name || (kind !== 'image' && kind !== 'file' && kind !== 'directory' && kind !== 'pasted_text')) return null;
    if (attachment.mimeType !== undefined && typeof attachment.mimeType !== 'string') return null;
    if (attachment.size !== undefined && (!Number.isSafeInteger(attachment.size) || Number(attachment.size) < 0)) return null;
    if (attachment.characterCount !== undefined && (!Number.isSafeInteger(attachment.characterCount) || Number(attachment.characterCount) < 0)) return null;
    byPath.set(path, {
      path,
      name,
      kind,
      ...(typeof attachment.mimeType === 'string' && attachment.mimeType.trim() ? { mimeType: attachment.mimeType.trim() } : {}),
      ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
      ...(typeof attachment.characterCount === 'number' ? { characterCount: attachment.characterCount } : {}),
    });
  }
  return Array.from(byPath.values());
}

function taskEditConflictDetails(error: unknown): { code: string; currentUpdatedAt?: string } | null {
  if (!(error instanceof Error) || !('code' in error) || typeof (error as Error & { code?: unknown }).code !== 'string') return null;
  const candidate = error as Error & { code: string; currentUpdatedAt?: unknown };
  return {
    code: candidate.code,
    ...(typeof candidate.currentUpdatedAt === 'string' ? { currentUpdatedAt: candidate.currentUpdatedAt } : {}),
  };
}

interface CreateGitConfirmationBody {
  operation: string;
  reason: string;
  message?: string;
}

interface CreateProjectGitSnapshotBody {
  taskId?: string;
}

interface ExecuteGitOperationBody {
  confirmationId?: string;
  operation?: string;
  message?: string;
  branchName?: string;
  baseRef?: string;
  stashRef?: string;
  remote?: string;
  targetRef?: string;
}

interface CommitTaskWorkspaceBody {
  message?: string;
  selectedPaths?: string[];
  push?: boolean;
}

interface DiscardTaskWorkspaceBody {
  confirmationText?: string;
}

interface StartTaskIntegrationBody {
  target?: 'source' | 'current';
  targetBranch?: string;
  mode?: 'merge' | 'squash';
  prepareOnly?: boolean;
}

interface ResolveTaskIntegrationConflictBody {
  content?: string;
}

interface AssistTaskIntegrationConflictBody {
  content?: string;
}

interface CreateRuntimeSessionBody {
  projectId: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  confirmationId?: string;
}

interface RuntimeConfirmationSessionInput {
  projectId: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd?: string;
}

interface CreateRuntimeConfirmationBody {
  action?: 'start_generic_session';
  reason?: string;
  session?: RuntimeConfirmationSessionInput;
}

interface RuntimeOperationConfirmation {
  id: string;
  action: 'start_generic_session';
  status: 'pending' | 'confirmed' | 'consumed' | 'rejected';
  riskLevel: 'high';
  reason: string;
  securityContext: RuntimeConfirmationSecurityContext;
  session: Required<Pick<RuntimeConfirmationSessionInput, 'projectId' | 'command' | 'args' | 'cwd'>> & Pick<RuntimeConfirmationSessionInput, 'taskId'>;
  createdAt: string;
  confirmedAt: string | null;
  consumedAt: string | null;
  rejectedAt?: string | null;
  rejectedReason?: string | null;
}

interface RuntimeConfirmationSecurityContext {
  operationKind: 'shell_command';
  requiresConfirmation: true;
  riskLevel: 'high';
  projectId: string;
  taskId: string | null;
  cwd: string;
  commandPreview: string;
  redacted: boolean;
}

interface RuntimeInputBody {
  input?: string;
}

interface CreateConversationMessageBody {
  content?: string;
  displayText?: string;
  attachments?: NativeConversationAttachment[];
  browserComments?: unknown;
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

interface NativeConversationAttachment {
  name: string;
  mime: string;
  size: number;
  localPath?: string;
  uploadRef?: string;
  /** 仅由服务端验签后注入，用于精确授权持久化路径。 */
  authorizedPath?: string;
}

type StartTaskConversationBody = (
  | {
      mode: 'create';
      content?: string;
      attachments?: NativeConversationAttachment[];
      inheritConversationId?: string;
      permissionMode?: ConversationPermissionMode;
      source?: 'task_push';
      model?: string;
      effort?: string;
      serviceTier?: string | null;
      workMode?: 'default' | 'plan';
      supplementalInfo?: string;
      workspace?:
        | { mode: 'direct'; confirmConcurrentWrites?: boolean }
        | {
            mode: 'create';
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

interface StartProjectConversationBody {
  mode: 'create';
  content?: string;
  attachments?: NativeConversationAttachment[];
  permissionMode?: ConversationPermissionMode;
  collaborationMode?: ConversationCollaborationMode;
  serviceTier?: string | null;
  clientUserMessageId?: string;
  agentKind?: 'codex' | 'pi' | 'claude';
}

interface TaskConversationAcceptanceReservation {
  scope: string;
  requestHash: string;
  operationId: string;
  conversationId: string;
  submissionId: string;
}

type ProjectConversationAcceptanceReservation = TaskConversationAcceptanceReservation;

interface RuntimeResizeBody {
  cols?: number;
  rows?: number;
}

interface ListRuntimeSessionsQuery {
  query?: string;
  projectId?: string;
  taskId?: string;
  archived?: string;
  favoriteOnly?: string;
}

interface ListRuntimeLogsQuery {
  query?: string;
  stream?: RuntimeLogStream;
  limit?: string;
  offset?: string;
}

interface ListTerminalEventsQuery {
  limit?: string;
  offset?: string;
}

interface UpdateRuntimeFavoriteBody {
  favorite?: boolean;
}

interface CreateTaskFromRuntimeSessionBody {
  title?: string;
  instruction?: string;
}

type TelegramDispatchPreviewBody = TelegramUpdate;
const telegramNotificationSettingsKey = 'telegram.notificationSettings';
const telegramSecuritySettingsKey = 'telegram.securitySettings';
const runtimeSettingsKey = 'runtime.settings';
const codeMapSettingsKey = 'codeMap.settings';
const codexRemoteControlEnabledSettingKey = 'codex.remote_control.enabled';
const projectConfigSettingsPrefix = 'project.config.';
const defaultRuntimeSettings: RuntimeSettingsSnapshot = {
  defaultAdapterId: 'codex',
  adapterModels: {},
  adapterDefaultArgs: {},
  adapterCliPaths: {},
  terminalEnv: {},
  shell: { path: null, login: false },
  concurrency: { maxPerProject: 1, maxGlobal: 2 },
  executionTimeoutSeconds: 3600,
  logRetentionDays: 30,
  autoConfirmationPolicy: 'never',
};
const defaultCodeMapSettings: CodeMapSettingsSnapshot = {
  defaultScanScope: 'project',
  defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
  maxCallChainDepth: 3,
  showLowConfidenceEdges: false,
  layoutAlgorithm: 'hierarchical',
  graphCacheStrategy: 'sqlite',
  tableRelationInference: 'foreign_key_and_name',
  aiSummaryEnabled: false,
  incrementalScanEnabled: true,
  performanceMonitoringEnabled: false,
  moduleFlowManualNotes: '',
};

function migrateRuntimeDirectory(legacyPath: string, targetPath: string): string {
  if (!existsSync(targetPath) && existsSync(legacyPath)) {
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    // 旧目录保留作回退依据，复制成功后新运行内核只写入收敛后的目录。
    cpSync(legacyPath, targetPath, { recursive: true, errorOnExist: true, force: false });
  }
  mkdirSync(targetPath, { recursive: true, mode: 0o700 });
  return realpathSync(targetPath);
}

function ensurePiGlobalAgentProjection(codexHome: string | undefined, piAgentDirectory: string): void {
  if (!codexHome) return;
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const canonicalCodexHome = realpathSync(codexHome);
  const projectionPath = join(piAgentDirectory, 'AGENTS.md');
  try {
    lstatSync(projectionPath);
    return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
  }
  // Pi 只复用纯文本全局指令；Codex 插件、技能和配置格式不在这里伪装成 Pi 原生资源。
  symlinkSync(relative(piAgentDirectory, join(canonicalCodexHome, 'AGENTS.md')), projectionPath);
}

function prepareTaskAttachmentRoot(path: string | undefined): string | undefined {
  if (!path) return undefined;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

type ManagedTaskAttachmentRepairResult = {
  repairedAttachmentCount: number;
  repairedTaskCount: number;
};

function inspectTaskManagedResource(resourcePath: string): { bytes: number; digest: string } {
  const resource = lstatSync(resourcePath);
  if (resource.isSymbolicLink()) throw new Error('symbolic links are not trusted task attachments');
  if (resource.isFile()) {
    const bytes = readFileSync(resourcePath);
    return { bytes: bytes.byteLength, digest: createHash('sha256').update('file\0').update(bytes).digest('hex') };
  }
  if (!resource.isDirectory()) throw new Error('unsupported task attachment type');
  const digest = createHash('sha256').update('directory\0');
  let bytes = 0;
  for (const entryName of readdirSync(resourcePath).sort()) {
    const entry = inspectTaskManagedResource(join(resourcePath, entryName));
    bytes += entry.bytes;
    digest.update(entryName).update('\0').update(entry.digest).update('\0');
  }
  return { bytes, digest: digest.digest('hex') };
}

function resolveCurrentManagedTaskAttachmentPath(attachment: Record<string, unknown>, taskAttachmentRoot: string | undefined): string | undefined {
  if (!taskAttachmentRoot) return undefined;
  const storedPath = typeof attachment.path === 'string' ? attachment.path.trim() : '';
  if (!storedPath || !isAbsolute(storedPath)) return undefined;
  try {
    const currentRoot = realpathSync(taskAttachmentRoot);
    const storedRealPath = realpathSync(storedPath);
    if (isPathInsideRoot(storedRealPath, currentRoot) && storedRealPath !== currentRoot) return storedRealPath;
  } catch {
    // 历史绝对路径可能已经不存在；继续尝试当前托管目录中的同一资源标识。
  }
  if (parse(dirname(storedPath)).base !== 'task-attachments') return undefined;
  const managedResourceName = parse(storedPath).base;
  if (!/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-.+/iu.test(managedResourceName)) return undefined;
  try {
    const currentRoot = realpathSync(taskAttachmentRoot);
    const candidatePath = realpathSync(join(currentRoot, managedResourceName));
    if (!isPathInsideRoot(candidatePath, currentRoot) || candidatePath === currentRoot) return undefined;
    const candidate = statSync(candidatePath);
    const storedKind = typeof attachment.kind === 'string' ? attachment.kind : '';
    if ((storedKind === 'directory') !== candidate.isDirectory()) return undefined;
    if (!candidate.isFile() && !candidate.isDirectory()) return undefined;
    const storedSize = typeof attachment.size === 'number' && Number.isFinite(attachment.size) ? attachment.size : undefined;
    if (candidate.isFile() && storedSize !== undefined && candidate.size !== storedSize) return undefined;
    let candidateInspection: ReturnType<typeof inspectTaskManagedResource> | undefined;
    if (candidate.isDirectory() && storedSize !== undefined) {
      candidateInspection = inspectTaskManagedResource(candidatePath);
      if (candidateInspection.bytes !== storedSize) return undefined;
    }

    if (existsSync(storedPath)) {
      const storedRealPath = realpathSync(storedPath);
      if (storedRealPath !== candidatePath) {
        candidateInspection ??= inspectTaskManagedResource(candidatePath);
        if (inspectTaskManagedResource(storedRealPath).digest !== candidateInspection.digest) return undefined;
      }
    } else {
      // 原目录已经清理时，只能依据受信当前目录、稳定资源名、类型和已保存大小恢复。
    }
    return candidatePath;
  } catch {
    return undefined;
  }
}

function repairMovedTaskAttachmentReferences(db: ZeusDatabase, taskAttachmentRoot: string | undefined): ManagedTaskAttachmentRepairResult {
  if (!taskAttachmentRoot) return { repairedAttachmentCount: 0, repairedTaskCount: 0 };
  let repairedAttachmentCount = 0;
  let repairedTaskCount = 0;
  for (const row of db.select<{ id: string; source_context_json: string }>(`SELECT id, source_context_json
                                                                              FROM tasks
                                                                              WHERE deleted_at IS NULL`)) {
    let sourceContext: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.source_context_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      sourceContext = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!Array.isArray(sourceContext.attachments)) continue;
    let taskChanged = false;
    const attachments = sourceContext.attachments.map((rawAttachment) => {
      if (!rawAttachment || typeof rawAttachment !== 'object' || Array.isArray(rawAttachment)) return rawAttachment;
      const attachment = rawAttachment as Record<string, unknown>;
      const currentPath = resolveCurrentManagedTaskAttachmentPath(attachment, taskAttachmentRoot);
      if (!currentPath || currentPath === attachment.path) return rawAttachment;
      taskChanged = true;
      repairedAttachmentCount += 1;
      return { ...attachment, path: currentPath };
    });
    if (!taskChanged) continue;
    db.execute(
      `UPDATE tasks
                    SET source_context_json = ?
                    WHERE id = ?`,
      [JSON.stringify({ ...sourceContext, attachments }), row.id],
    );
    repairedTaskCount += 1;
  }
  return { repairedAttachmentCount, repairedTaskCount };
}

function hasTaskImageSignature(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/gif') return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (mime === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mime === 'image/bmp') return bytes.subarray(0, 2).toString('ascii') === 'BM';
  if (mime === 'image/tiff') return bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
  if (mime === 'image/heic' || mime === 'image/heif') {
    const boxType = bytes.subarray(4, 12).toString('ascii');
    return boxType.startsWith('ftyp') && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(bytes.subarray(8, 12).toString('ascii'));
  }
  return false;
}

const unsafeCodeMapScanRootMessage = 'Refusing to scan filesystem root. Choose a real project directory before generating the code graph.';

class UnsafeCodeMapScanRootError extends Error {
  constructor() {
    super(unsafeCodeMapScanRootMessage);
    this.name = 'UnsafeCodeMapScanRootError';
  }
}

/** 防止旧全局扫描入口在 packaged App 的 cwd 为 / 时递归整台机器，导致扫描卡死或进程崩溃。 */
export function isUnsafeCodeMapScanRoot(rootPath: string): boolean {
  const normalizedRoot = resolve(rootPath);
  return normalizedRoot === parse(normalizedRoot).root;
}

function isUnsafeCodeMapScanRootError(error: unknown): error is UnsafeCodeMapScanRootError {
  return error instanceof UnsafeCodeMapScanRootError;
}

function resolveReleaseUpdateManifestUrl(configured: string | undefined, allowUntrustedTest: boolean): string {
  const fallback = 'https://github.com/imchenway/zeus/releases/latest/download/zeus-release-manifest.json';
  const candidate = configured?.trim() || fallback;
  const url = new URL(candidate);
  if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/imchenway/zeus/releases/')) return url.toString();
  if (allowUntrustedTest && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)) return url.toString();
  throw new Error('Zeus release update manifest URL is not trusted.');
}

const telegramNotificationMaxAttempts = 3;
const telegramRuntimeSummaryLogInterval = 5;
const NON_CODEX_LEGACY_HISTORY_LIMIT = 12;

interface TelegramRuntimeConfirmation {
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
  const taskAttachmentRoot = prepareTaskAttachmentRoot(options.taskAttachmentRoot);
  const db = await createZeusDatabase(options.dbPath);
  const attachmentRepair = repairMovedTaskAttachmentReferences(db, taskAttachmentRoot);
  if (attachmentRepair.repairedAttachmentCount > 0) {
    await db.save();
    console.info(`Zeus 已恢复 ${attachmentRepair.repairedTaskCount} 个历史任务中的 ${attachmentRepair.repairedAttachmentCount} 个托管附件引用。`);
  }
  const projects = new ProjectRepository(db);
  const projectRepositories = new ProjectRepositoryRegistrationRepository(db);
  const projectSharedPaths = new ProjectSharedPathRepository(db);
  const tasks = new TaskRepository(db);
  const taskEnvironments = new TaskEnvironmentRepository(db);
  const taskWorkspaces = new TaskWorkspaceRepository(db);
  const taskIntegrations = new TaskIntegrationRepository(db);
  const taskEvents = new TaskEventRepository(db);
  const taskTemplates = new TaskTemplateRepository(db);
  const runtimeSessions = new RuntimeSessionRepository(db);
  const commandDefinitions = new CommandDefinitionRepository(db);
  const commandRuns = new CommandRunRepository(db);
  const commandArtifacts = new CommandArtifactRepository(db);
  const terminalEvents = new TerminalEventRepository(db);
  const settings = new SettingRepository(db);
  const auditLogs = new AuditLogRepository(db);
  const conversations = new ConversationRepository(db);
  const codexLegacyImports = new CodexLegacyImportRepository(db);
  const conversationTurns = new ConversationTurnRepository(db);
  const conversationItems = new ConversationItemRepository(db);
  const conversationResources = new ConversationResourceRepository(db);
  const turnChangeSets = new TurnChangeSetRepository(db);
  const turnChangeFiles = new TurnChangeFileRepository(db);
  const conversationSubmissions = new ConversationSubmissionRepository(db);
  const conversationRequests = new ConversationServerRequestRepository(db);
  const conversationPlanActions = new ConversationPlanActionRepository(db);
  const idempotencyRequests = new IdempotencyRequestRepository(db);
  const gitSnapshots = new GitSnapshotRepository(db);
  const recoveredInterruptedScans = projects.recoverInterruptedScans();
  if (recoveredInterruptedScans > 0) {
    // 上次进程在扫描中崩溃时不会进入 catch 分支；启动时恢复为 failed，避免项目永久停在“扫描中”且无法重试。
    await db.save();
  }
  const server = Fastify({ logger: false });
  await server.register(websocketPlugin);
  const projectRoot = options.projectRoot ?? process.cwd();
  const readGitStatus = getGitStatus;
  const readGitDiff = getGitDiff;
  const releaseEnvironment = process.env;
  const releaseUpdateManifestUrl = resolveReleaseUpdateManifestUrl(options.releaseUpdateManifestUrl, Boolean(options.allowUntrustedReleaseUpdateTest));
  const gitConfirmations = new Map<string, GitOperationConfirmation>();
  const consumedGitConfirmationIds = new Set<string>();
  const activeProjectGraphScanIds = new Set<string>();
  const runtimeConfirmations = new Map<string, RuntimeOperationConfirmation>();
  const telegramRuntimeConfirmations = new Map<string, TelegramRuntimeConfirmation>();
  const telegramRuntimeSummarySentLogCounts = new Map<string, Set<number>>();
  const telegramCommandRunMessages = new Map<string, { chatId: number; messageId?: number }>();
  const telegramCommandRunLogCounts = new Map<string, number>();
  const eventSubscribers = new Set<ZeusRealtimeSocket>();
  const nativeLocalEventGenerationId = `zeus-local-${randomUUID()}`;
  let nativeLocalEventSequence = 0;
  const nativeIdempotentInFlight = new Map<string, { requestHash: string; promise: Promise<{ statusCode: number; body: unknown }> }>();
  const telegramConfirmationTtlMs = 10 * 60 * 1000;
  const gitConfirmationTtlMs = 10 * 60 * 1000;
  const now = () => new Date();
  const appShellSettingsKey = 'app.shell.settings';
  const localLogDirectory = `${options.dbPath}.logs`;
  const localConfigPath = options.localConfigPath ?? join(dirname(options.dbPath), 'zeus.config.json');
  // 本地日志目录是设计书明确要求的物理落点；服务启动时创建，避免 UI 只展示一个不存在的路径。
  mkdirSync(localLogDirectory, { recursive: true });
  const runtimeSessionDirectory = join(dirname(options.dbPath), 'sessions');
  let telegramNotificationSettings: TelegramNotificationSettingsSnapshot = normalizeTelegramNotificationSettings(settings.getJson<TelegramNotificationSettingsSnapshot>(telegramNotificationSettingsKey), {
    enabled: true,
    chatIds: options.telegramNotificationChatIds ?? options.telegramAllowedUserIds ?? [],
    silentMode: false,
  });
  let telegramSecuritySettings: TelegramSecuritySettingsSnapshot = normalizeTelegramSecuritySettings(settings.getJson<TelegramSecuritySettingsSnapshot>(telegramSecuritySettingsKey), { allowedUserIds: options.telegramAllowedUserIds ?? [] });
  let runtimeSettings: RuntimeSettingsSnapshot = normalizeRuntimeSettings(settings.getJson<RuntimeSettingsSnapshot>(runtimeSettingsKey));
  let codeMapSettings: CodeMapSettingsSnapshot = normalizeCodeMapSettings(settings.getJson<CodeMapSettingsSnapshot>(codeMapSettingsKey)) ?? defaultCodeMapSettings;
  let codexRemoteControlEnabled = settings.getJson<boolean>(codexRemoteControlEnabledSettingKey) === true;
  let memoryGraphCache: ProjectGraph | null = null;
  const persistedAppShellSettings = settings.getJson<AppShellSettingsSnapshot>(appShellSettingsKey);
  let appShellSettings: AppShellSettingsSnapshot = normalizeAppShellSettings(persistedAppShellSettings, localLogDirectory, localConfigPath);
  const missingTaskStatusProjectIds = projects.list().map((project) => project.id).filter((projectId) => !appShellSettings.taskManagementStatusByProject[projectId]);
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
    missingTaskStatusProjectIds.length > 0 ||
    (persistedAppShellSettings &&
      (JSON.stringify(persistedAppShellSettings.taskTableColumns) !== JSON.stringify(appShellSettings.taskTableColumns) ||
      JSON.stringify(persistedAppShellSettings.taskTableColumnsByProject) !== JSON.stringify(appShellSettings.taskTableColumnsByProject) ||
      JSON.stringify(persistedAppShellSettings.taskTableEnumSortOrders) !== JSON.stringify(appShellSettings.taskTableEnumSortOrders) ||
      JSON.stringify(persistedAppShellSettings.taskManagementStatusTemplate) !== JSON.stringify(appShellSettings.taskManagementStatusTemplate) ||
      JSON.stringify(persistedAppShellSettings.taskManagementStatusByProject) !== JSON.stringify(appShellSettings.taskManagementStatusByProject) ||
      JSON.stringify(persistedAppShellSettings.taskStatusFilterByProject) !== JSON.stringify(appShellSettings.taskStatusFilterByProject) ||
      JSON.stringify(persistedAppShellSettings.taskViewModeByProject) !== JSON.stringify(appShellSettings.taskViewModeByProject) ||
      JSON.stringify(persistedAppShellSettings.taskExpandedIdsByProject) !== JSON.stringify(appShellSettings.taskExpandedIdsByProject)))
  ) {
    // 旧列键、旧默认顺序、新增列宽和项目筛选偏好都只迁移一次并立即落库，避免每次启动重复改写本机视图配置。
    settings.setJson(appShellSettingsKey, appShellSettings);
    await db.save();
  }
  function resolveTaskManagementStatusConfigForProject(projectId: string): TaskManagementStatusConfig {
    return appShellSettings.taskManagementStatusByProject[projectId] ?? appShellSettings.taskManagementStatusTemplate;
  }

  function isConfiguredTaskManagementStatus(projectId: string, status: unknown): status is TaskManagementStatus {
    return typeof status === 'string' && resolveTaskManagementStatusConfigForProject(projectId).statuses.some((definition) => definition.id === status);
  }
  const secretStore = createMacOSKeychainStore();
  const modelConnections = createModelConnectionService({
    settings,
    secretStore,
    save: () => db.save(),
    listProjectIds: () => projects.list().map((project) => project.id),
    now: () => now().toISOString(),
  });
  const piAgentDirectory = migrateRuntimeDirectory(join(dirname(options.dbPath), 'pi-agent'), join(dirname(options.dbPath), 'agent-runtimes', 'pi', 'config'));
  const piSessionDirectory = migrateRuntimeDirectory(join(dirname(options.dbPath), 'pi-sessions'), join(dirname(options.dbPath), 'agent-runtimes', 'pi', 'sessions'));
  ensurePiGlobalAgentProjection(options.codexHome, piAgentDirectory);
  const piNativeCoordinator = createPiNativeConversationCoordinator({
    db,
    conversations,
    turns: conversationTurns,
    items: conversationItems,
    submissions: conversationSubmissions,
    requests: conversationRequests,
    modelConnections,
    agentDirectory: piAgentDirectory,
    sessionDirectory: piSessionDirectory,
    now: () => now().toISOString(),
    publish: publishNativeConversationEvent,
  });
  const repairedPiConversationIdentityCount = piNativeCoordinator.repairPersistedConversationIdentities();
  const repairedPiAgentMessageProjectionCount = piNativeCoordinator.repairPersistedAgentMessageProjections();
  if (repairedPiConversationIdentityCount > 0 || repairedPiAgentMessageProjectionCount > 0) await db.save();
  const runtimePersistenceWrites: Array<Promise<void>> = [];
  const runtimePidExists = processPidExists;
  const runtimeKillPid = processKillPid;
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
    onLog: persistRuntimeLog,
  });
  const ownsCodexAppServerManager = options.codexAppServerManager === undefined;
  const codexNativeEnabled = options.codexNativeEnabled !== false;
  const codexRuntimeCommandPath = options.codexRuntimeCommandPath;
  const configuredCodexRuntimeCommandPath = () => runtimeSettings.adapterCliPaths.codex?.trim() || (typeof codexRuntimeCommandPath === 'function' ? codexRuntimeCommandPath() : codexRuntimeCommandPath) || undefined;
  const currentCodexRuntimeCommandPath = () => configuredCodexRuntimeCommandPath() || 'codex';
  const codexExternalAgentHome = options.codexLegacyImportRoot
    ? (() => {
        mkdirSync(options.codexLegacyImportRoot!, { recursive: true, mode: 0o700 });
        return realpathSync(options.codexLegacyImportRoot!);
      })()
    : undefined;
  const codexHome = options.codexHome
    ? (() => {
        mkdirSync(options.codexHome!, { recursive: true, mode: 0o700 });
        return realpathSync(options.codexHome!);
      })()
    : undefined;
  const codexConfigImportService =
    codexHome && options.codexConfigImportSourceRoot
      ? createCodexConfigImportService({
          sourceRoot: options.codexConfigImportSourceRoot,
          targetRoot: codexHome,
          backupRoot: join(dirname(options.dbPath), 'imports', 'codex'),
          now,
        })
      : undefined;
  const browserAttachmentRoot = prepareTaskAttachmentRoot(options.browserAttachmentRoot);
  const conversationAttachmentRoot = prepareTaskAttachmentRoot(options.conversationAttachmentRoot);
  const trustedConversationAttachmentRoots = [taskAttachmentRoot, browserAttachmentRoot, conversationAttachmentRoot].filter((root): root is string => Boolean(root));
  let conversationResourceBackfillCount = 0;
  for (const conversation of conversations.listNativeBound()) {
    const project = projects.getById(conversation.projectId);
    if (!project) continue;
    const submissions = conversationSubmissions.listByConversation(conversation.id);
    const existingResourcesByItem = new Map<string, ReturnType<typeof conversationResources.listByItem>>();
    for (const resource of conversationResources.listByConversation(conversation.id)) {
      const existing = existingResourcesByItem.get(resource.itemId) ?? [];
      existing.push(resource);
      existingResourcesByItem.set(resource.itemId, existing);
    }
    for (const item of conversationItems.listByConversation(conversation.id)) {
      const submission = item.itemType === 'userMessage' ? submissions.find((candidate) => candidate.providerTurnId === item.providerTurnId) : undefined;
      const payload = parseJsonObject(item.payloadJson);
      const normalized = normalizeConversationResources({
        projectId: conversation.projectId,
        projectRoot: project.localPath,
        conversationId: conversation.id,
        turnId: item.turnId,
        item,
        payload: submission ? { ...payload, attachments: parseJsonObject(submission.inputJson).attachments } : payload,
        text: item.textContent,
        trustedAttachmentRoots: trustedConversationAttachmentRoots,
        now: item.updatedAt,
      });
      const existing = existingResourcesByItem.get(item.id) ?? [];
      if (conversationResourceRecordsEqual(existing, normalized)) continue;
      conversationResources.replaceForItem(item.id, normalized, item.updatedAt);
      conversationResourceBackfillCount += Math.max(normalized.length, existing.length);
    }
  }
  if (conversationResourceBackfillCount > 0) await db.save();
  const turnChangeSetService = createTurnChangeSetService({
    db,
    changeSets: turnChangeSets,
    files: turnChangeFiles,
    projects,
    auditLogs,
    idempotency: idempotencyRequests,
    recoveryRoot: join(dirname(options.dbPath), 'turn-change-sets'),
    getConversationRoot: (conversationId) => {
      const conversation = conversations.getById(conversationId);
      return conversation ? resolveNativeConversationExecutionRoot(conversation) : null;
    },
    broadcast: publishNativeConversationEvent,
    now: () => now().toISOString(),
  });
  let settleCodexPendingOnClose = ownsCodexAppServerManager;
  const codexAppServerManager = options.codexAppServerManager ?? createCodexAppServerManager();
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
      items: conversationItems,
      resources: conversationResources,
      changeSets: turnChangeSetService,
      submissions: conversationSubmissions,
      requests: conversationRequests,
      planActions: conversationPlanActions,
      settings,
      browserAutomation: options.browserAutomation,
      trustedAttachmentRoots: trustedConversationAttachmentRoots,
      getProjectRoot: (projectId) => projects.getById(projectId)?.localPath ?? null,
      getConcurrency: (projectId) => {
        const runningLegacy = listUniqueRunningRuntimeSessions();
        return {
          project: runningLegacy.filter((session) => session.projectId === projectId).length,
          global: runningLegacy.length,
          maxPerProject: runtimeSettings.concurrency.maxPerProject,
          maxGlobal: runtimeSettings.concurrency.maxGlobal,
        };
      },
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
  if (codexNativeEnabled && codexRemoteControlEnabled) {
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
  if (codexNativeEnabled) {
    try {
      const migration = await migrateLegacyCodexThreads({
        db,
        projects,
        tasks,
        taskEvents,
        runtimeSessions,
        conversations,
        turns: conversationTurns,
        items: conversationItems,
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
  let codexLegacyImportService: CodexLegacyImportService | undefined;
  if (codexNativeEnabled && options.codexLegacyImportRoot) {
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
  (server as ZeusFastifyLifecycle).prepareZeusShutdown = async () => {
    settleCodexPendingOnClose = true;
    await codexLegacyImportService?.close();
    await codexNativeCoordinator.close({ mode: 'final' });
  };
  await turnChangeSetService.recoverInterruptedOperations();
  if (
    codexNativeEnabled &&
    (conversations.listNativeBound('codex').length > 0 ||
      conversationSubmissions
        .listRecoverable()
        .some((submission) => conversations.getById(submission.conversationId)?.agentKind === 'codex' && (submission.status === 'dispatching' || submission.status === 'active')))
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

  function recordTaskEvent(input: CreateTaskEventInput) {
    const event = taskEvents.create(input);
    writeTaskEventLogFile(event);
    return event;
  }

  function writeTaskEventLogFile(event: ReturnType<TaskEventRepository['create']>): void {
    const taskDirectory = join(localLogDirectory, 'tasks', sanitizeRuntimeFileName(event.taskId));
    mkdirSync(taskDirectory, { recursive: true });
    // 任务日志文件是设计书要求的物理证据链：SQLite 负责索引，文件负责人工排障和离线导出。
    appendFileSync(join(taskDirectory, 'timeline.normalized.log'), `${event.createdAt} [${event.eventType}] ${event.title} taskId=${event.taskId} payload=${event.payloadJson}\n`, 'utf8');
    appendFileSync(join(taskDirectory, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }

  let telegramPollingService: TelegramPollingService | undefined;
  let telegramMessageSender: TelegramMessageSender | undefined;
  let telegramPollingTimer: ReturnType<typeof setInterval> | undefined;
  let boundPort: number | null = null;

  server.decorate('setZeusBoundPort', (port: number) => {
    boundPort = port;
  });

  function appendAuditLog(input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }): void {
    auditLogs.append({
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
  }

  async function recoverInactiveProjectGraphScans(): Promise<void> {
    const recovered = projects.recoverInterruptedScans([...activeProjectGraphScanIds]);
    if (recovered > 0) {
      // 旧版本或异常退出可能留下无主 scanning；只恢复不属于本进程真实扫描的项目，避免重启后永久无法重试。
      await db.save();
    }
  }

  /** 拒绝 Runtime 项目外 cwd 时写入安全审计，证明命令未进入执行层。 */
  function appendRuntimeCwdRejectedAuditLog(input: { requestedCwd: string; projectRoot: string; projectId: string; taskId: string | null; phase: 'confirmation' | 'session' }): void {
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.runtime.cwd_rejected',
      resourceType: 'runtime_session',
      payload: {
        projectId: input.projectId,
        taskId: input.taskId,
        phase: input.phase,
        requestedCwd: resolve(input.requestedCwd),
        projectRoot: resolve(input.projectRoot),
      },
    });
  }

  /** 拒绝 shell 参数中的项目外绝对路径，补齐 cwd 之外的写入边界审计。 */
  function appendRuntimeShellPathRejectedAuditLog(input: { commandText: string; rejectedPath: string; projectRoot: string; projectId: string; taskId: string | null; phase: 'confirmation' | 'session' }): void {
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.runtime.shell_path_rejected',
      resourceType: 'runtime_confirmation',
      payload: {
        projectId: input.projectId,
        taskId: input.taskId,
        phase: input.phase,
        rejectedPath: resolve(input.rejectedPath),
        projectRoot: resolve(input.projectRoot),
        commandPreview: redactSensitiveText(input.commandText).text,
      },
    });
  }

  /** 拒绝访问常见本机敏感目录，避免 shell 读取 SSH/云凭据/Keychain 等私密资料。 */
  function appendRuntimeSensitivePathRejectedAuditLog(input: { commandText: string; rejectedPath: string; projectId: string; taskId: string | null; phase: 'confirmation' | 'session' }): void {
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.runtime.sensitive_path_rejected',
      resourceType: 'runtime_confirmation',
      payload: {
        projectId: input.projectId,
        taskId: input.taskId,
        phase: input.phase,
        rejectedPath: input.rejectedPath,
        commandPreview: redactSensitiveText(input.commandText).text,
      },
    });
  }

  /** 拒绝疑似密钥文件名，即便它位于项目目录内，也避免 Runtime 直接读取或搬运明文密钥。 */
  function appendRuntimeSecretFileRejectedAuditLog(input: { commandText: string; rejectedPath: string; projectId: string; taskId: string | null; phase: 'confirmation' | 'session' }): void {
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.runtime.secret_file_rejected',
      resourceType: 'runtime_confirmation',
      payload: {
        projectId: input.projectId,
        taskId: input.taskId,
        phase: input.phase,
        rejectedPath: input.rejectedPath,
        commandPreview: redactSensitiveText(input.commandText).text,
      },
    });
  }

  await recoverPersistedRuntimeSessions();

  /** 向本地 WebSocket 订阅者广播真实领域事件；payload 只放业务上下文，绝不包含 API Token。 */
  function publishRealtimeEvent(type: string, payload: Record<string, unknown>): ZeusRealtimeEvent {
    const event: ZeusRealtimeEvent = {
      id: randomUUID(),
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    const encoded = JSON.stringify(event);
    for (const subscriber of eventSubscribers) {
      if (subscriber.readyState === subscriber.OPEN) {
        subscriber.send(encoded);
      }
    }
    return event;
  }

  function publishNativeConversationEvent(type: string, payload: Record<string, unknown>): void {
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
          ? conversations.listNativeBound('codex').map((conversation) => conversation.id)
          : [];
    for (const conversationId of new Set(conversationIds)) {
      const conversation = conversations.getById(conversationId);
      if (!conversation || conversation.transportKind !== 'codex_native') continue;
      const generationId = typeof payload.generationId === 'string' ? payload.generationId : nativeLocalEventGenerationId;
      const sequence = typeof payload.sequence === 'number' ? payload.sequence : ++nativeLocalEventSequence;
      publishRealtimeEvent(mappedType, {
        ...payload,
        ...(mappedType === 'conversation.queue.changed' ? { queue: toNativeQueueApiSnapshot(conversation) } : {}),
        ...(nativeConversationAttentionEventTypes.has(mappedType) ? { conversationAttentionState: buildProjectConversationAttentionByProject([conversation.projectId])[conversation.projectId] ?? 'idle' } : {}),
        projectId: conversation.projectId,
        conversationId: conversation.id,
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
        sequence,
      });
    }
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
    const scan = await scanProjectSource({
      rootPath: scanRoot,
      projectName: graphProjectName,
      ignoreDirectories: codeMapSettings.defaultIgnoreDirectories,
      additionalFiles: importedSchemaFiles,
    });
    publishRealtimeEvent('project.scan.progress', {
      projectName: input.projectName,
      rootPath: scan.rootPath,
      stage: 'build_graph',
      message: '构建真实代码图谱',
      fileCount: scan.files.length,
      symbolCount: scan.symbols.length,
      importedSchemaFileCount: importedSchemaFiles.length,
    });
    const graph = applyCodeMapSettingsToGraph(buildProjectGraph(scan), codeMapSettings);
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
      clearPersistedGraphCache(db, scan.projectName);
    } else if (codeMapSettings.graphCacheStrategy === 'disabled') {
      memoryGraphCache = null;
      clearPersistedGraphCache(db, scan.projectName);
    } else {
      memoryGraphCache = null;
      persistScanAndGraph(db, scan, runtimeGraph);
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

  server.get('/health', async () => ({
    ok: true,
    app: 'Zeus',
    host: zeusLocalServerHost,
    port: boundPort,
    // 兼容设计书 7.1 的健康检查契约；这些字段只描述本机服务真实运行态，不伪造外部 AI/Telegram 可用性。
    status: 'ok',
    appName: 'Zeus',
    version: readProjectVersion(projectRoot),
    database: 'ok',
    runtime: 'ok',
  }));

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
    if (request.url.startsWith('/api/events') && isAuthorizedRealtimeRequest(request)) return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${options.apiToken}`) {
      await reply.code(401).send({
        error: 'ZEUS_UNAUTHORIZED',
        message: 'Missing or invalid Zeus local API token',
      });
    }
  });

  const commandCenter = createCommandCenter({
    server,
    db,
    projects,
    runtimeSessions,
    aiRuntimeManager,
    commandScriptsDirectory: join(dirname(options.dbPath), 'command-scripts'),
    commandRunsDirectory: join(dirname(options.dbPath), 'command-runs'),
    readProjectSecurity: (projectId) => readProjectConfig(projectId).security,
    buildRuntimeProcessEnv,
    appendAuditLog,
    publishRealtimeEvent,
    save: () => db.save(),
    now,
    confirmationTtlMs: telegramConfirmationTtlMs,
  });

  function buildExecutionHostWorkStatusSnapshot(): ExecutionHostWorkStatusSnapshot {
    const transport = codexAppServerManager.getState();
    const activeTurnCount = conversationSubmissions.listRecoverable().filter((submission) => submission.status === 'dispatching' || submission.status === 'active').length;
    const effectfulTurnCount = conversations
      .listNativeBound()
      .flatMap((conversation) => conversationTurns.listByConversation(conversation.id))
      .filter((turn) => turn.status === 'dispatching' || turn.status === 'running').length;
    const waitingRequestCount = conversations
      .listNativeBound()
      .flatMap((conversation) => conversationRequests.listByConversation(conversation.id))
      .filter((request) => request.status === 'pending').length;
    const activeRuntimeCount = aiRuntimeManager.listSessions().filter((session) => session.status === 'running').length;
    const activeCommandRunCount = commandRuns.listActive().length;
    return {
      instanceId: options.executionHost?.instanceId ?? null,
      protocolVersion: options.executionHost?.protocolVersion ?? 1,
      mode: options.executionHost?.mode ?? 'embedded',
      pid: process.pid,
      startedAt: options.executionHost?.startedAt ?? null,
      transport: {
        state: transport.type,
        generationId: transport.type === 'idle' || transport.type === 'closed' ? null : transport.generationId,
      },
      runtimeGenerations: codexAppServerManager.listRuntimeGenerations().map((generation) => ({
        generationId: generation.generationId,
        state: generation.state,
        active: generation.active,
        activeThreadCount: generation.activeThreadCount,
        pendingRequestCount: generation.pendingRequestCount,
      })),
      activeTurnCount,
      effectfulTurnCount,
      waitingRequestCount,
      activeRuntimeCount,
      activeCommandRunCount,
      hasActiveWork: activeTurnCount > 0 || waitingRequestCount > 0 || activeRuntimeCount > 0 || activeCommandRunCount > 0,
      observedAt: now().toISOString(),
    };
  }

  server.get('/api/execution-host/status', async (): Promise<ExecutionHostWorkStatusSnapshot> => buildExecutionHostWorkStatusSnapshot());

  server.post('/api/execution-host/handoff-checkpoint', async (request: FastifyRequest<{ Body: ExecutionHostHandoffCheckpoint }>, reply) => {
    const checkpoint = request.body;
    if (
      !checkpoint ||
      typeof checkpoint.sourceInstanceId !== 'string' ||
      !checkpoint.sourceInstanceId.trim() ||
      typeof checkpoint.capturedAt !== 'string' ||
      !Number.isFinite(Date.parse(checkpoint.capturedAt)) ||
      !Array.isArray(checkpoint.requests)
    ) {
      return reply.code(400).send({ error: 'ZEUS_EXECUTION_HOST_HANDOFF_CHECKPOINT_INVALID', message: 'Execution-host handoff checkpoint is invalid.' });
    }

    const restoredAt = now().toISOString();
    let restoredRequestCount = 0;
    for (const candidate of checkpoint.requests) {
      if (!candidate || typeof candidate.id !== 'string' || typeof candidate.conversationId !== 'string' || typeof candidate.transportGenerationId !== 'string') continue;
      const persisted = conversationRequests.getById(candidate.id);
      if (!persisted || persisted.conversationId !== candidate.conversationId || persisted.transportGenerationId !== candidate.transportGenerationId || persisted.requestKind !== candidate.requestKind) {
        continue;
      }
      conversationRequests.restorePendingAfterHostHandoff(persisted.id, {
        sourceInstanceId: checkpoint.sourceInstanceId,
        capturedAt: checkpoint.capturedAt,
        restoredAt,
      });
      const conversation = conversations.getById(persisted.conversationId);
      const turn = persisted.turnId ? conversationTurns.getById(persisted.turnId) : undefined;
      if (conversation?.transportKind === 'codex_native' && turn && turn.status !== 'completed') {
        conversationTurns.upsert({ ...turn, status: 'waiting', completedAt: null, updatedAt: restoredAt });
        conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: 'waiting',
        });
      }
      restoredRequestCount += 1;
    }
    await db.save();
    if (restoredRequestCount > 0) {
      publishNativeConversationEvent('execution_host.handoff_checkpoint.restored', {
        sourceInstanceId: checkpoint.sourceInstanceId,
        restoredRequestCount,
      });
    }
    return { restoredRequestCount, restoredAt };
  });

  server.post('/api/execution-host/stop-active', async (): Promise<ExecutionHostStopResult> => {
    const requestedAt = now().toISOString();
    const failedTurns: ExecutionHostStopResult['failedTurns'] = [];
    const activeSubmissions = conversationSubmissions.listRecoverable().filter((submission) => (submission.status === 'dispatching' || submission.status === 'active') && submission.providerTurnId);
    const requestedTurns = new Set<string>();
    for (const submission of activeSubmissions) {
      const providerTurnId = submission.providerTurnId!;
      const identity = `${submission.conversationId}\0${providerTurnId}`;
      if (requestedTurns.has(identity)) continue;
      requestedTurns.add(identity);
      try {
        await codexNativeCoordinator.interruptTurn({
          conversationId: submission.conversationId,
          providerTurnId,
        });
      } catch (error) {
        failedTurns.push({
          conversationId: submission.conversationId,
          providerTurnId,
          message: error instanceof Error ? error.message : '无法停止正在执行的轮次。',
        });
      }
    }
    const activeRuntimeSessions = aiRuntimeManager.listSessions().filter((session) => session.status === 'running');
    for (const session of activeRuntimeSessions) aiRuntimeManager.stopSession(session.id);
    await db.save();
    return {
      requestedTurnCount: requestedTurns.size,
      stoppedRuntimeCount: activeRuntimeSessions.length,
      failedTurns,
      requestedAt,
    };
  });

  server.get('/api/dashboard', async (): Promise<DashboardSnapshot> => {
    await recoverInactiveProjectGraphScans();
    const currentProjects = projects.list();
    return {
      app: 'Zeus',
      localServer: { host: zeusLocalServerHost, port: boundPort },
      projects: currentProjects,
      tasks: currentProjects.flatMap((project) => tasks.listByProject(project.id)),
      conversationAttentionByProject: buildProjectConversationAttentionByProject(currentProjects.map((project) => project.id)),
      runtime: {
        aiCli: await toRuntimeStatus(runtimeSettings),
        telegram: getTelegramConfigurationState(await readTelegramToken(), telegramSecuritySettings.allowedUserIds),
      },
      git: await getGitStatus(projectRoot),
      graph: readCurrentGraphSummary(),
    };
  });

  server.get('/api/events', { websocket: true }, (socket, request) => {
    if (!isAuthorizedRealtimeRequest(request)) {
      socket.close(1008, 'Missing or invalid Zeus local API token');
      return;
    }
    eventSubscribers.add(socket);
    socket.on('close', () => eventSubscribers.delete(socket));
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'server.connected',
        payload: { app: 'Zeus', host: zeusLocalServerHost, port: boundPort },
        createdAt: new Date().toISOString(),
      } satisfies ZeusRealtimeEvent),
    );
  });

  server.get('/api/projects', async (request: FastifyRequest<{ Querystring: { query?: string } }>) => {
    await recoverInactiveProjectGraphScans();
    return projects.search({ query: request.query.query });
  });

  server.get('/api/projects/archived', async () => projects.listArchived());

  server.get('/api/codex-native/import', async (_request, reply) => {
    if (!codexLegacyImportService) {
      return reply.code(503).send({ error: 'ZEUS_CODEX_LEGACY_IMPORT_UNAVAILABLE', message: 'Codex legacy import is unavailable.' });
    }
    try {
      const snapshot = await codexLegacyImportService.detect();
      return {
        eligible: snapshot.eligible.map((entry) => ({ sourceConversationId: entry.sourceConversationId, title: entry.title, cwd: entry.cwd })),
        runs: snapshot.runs.map(toCodexLegacyImportApiRun),
      };
    } catch (error) {
      return sendCodexLegacyImportError(reply, error);
    }
  });

  server.get('/api/codex-config/import', async (_request, reply) => {
    if (!codexConfigImportService) {
      return reply.code(503).send({ error: 'ZEUS_CODEX_CONFIG_IMPORT_UNAVAILABLE', message: 'Codex configuration import is unavailable.' });
    }
    try {
      return await codexConfigImportService.inspect();
    } catch (error) {
      return reply.code(500).send({ error: 'ZEUS_CODEX_CONFIG_IMPORT_FAILED', message: error instanceof Error ? error.message : 'Codex configuration inspection failed.' });
    }
  });

  server.post('/api/codex-config/import', async (_request, reply) => {
    if (!codexConfigImportService) {
      return reply.code(503).send({ error: 'ZEUS_CODEX_CONFIG_IMPORT_UNAVAILABLE', message: 'Codex configuration import is unavailable.' });
    }
    try {
      const result = await codexConfigImportService.import();
      auditLogs.append({
        actorType: 'user',
        action: 'settings.codex_config.imported',
        resourceType: 'settings',
        payload: {
          imported: result.imported,
          skipped: result.skipped.map((entry) => ({ path: entry.path, reason: entry.reason })),
          backupCreated: result.backupRoot !== null,
          restartRequired: result.restartRequired,
        },
        createdAt: result.importedAt,
      });
      await db.save();
      return result;
    } catch (error) {
      return reply.code(500).send({ error: 'ZEUS_CODEX_CONFIG_IMPORT_FAILED', message: error instanceof Error ? error.message : 'Codex configuration import failed.' });
    }
  });

  server.post('/api/codex-native/import', async (request: FastifyRequest<{ Body: { sourceConversationIds?: unknown } }>, reply) => {
    if (!codexLegacyImportService) {
      return reply.code(503).send({ error: 'ZEUS_CODEX_LEGACY_IMPORT_UNAVAILABLE', message: 'Codex legacy import is unavailable.' });
    }
    const sourceConversationIds = request.body?.sourceConversationIds;
    if (!Array.isArray(sourceConversationIds) || !sourceConversationIds.every((id) => typeof id === 'string' && id.trim().length > 0)) {
      return reply.code(400).send({ error: 'ZEUS_CODEX_LEGACY_IMPORT_SELECTION_INVALID', message: 'sourceConversationIds must contain nonblank conversation ids.' });
    }
    try {
      const result = await codexLegacyImportService.start({ sourceConversationIds });
      return { importId: result.importId, status: result.status, runs: result.runs.map(toCodexLegacyImportApiRun) };
    } catch (error) {
      return sendCodexLegacyImportError(reply, error);
    }
  });

  server.get('/api/codex-native/import/:importId', async (request: FastifyRequest<{ Params: { importId: string } }>, reply) => {
    if (!codexLegacyImportService) {
      return reply.code(503).send({ error: 'ZEUS_CODEX_LEGACY_IMPORT_UNAVAILABLE', message: 'Codex legacy import is unavailable.' });
    }
    try {
      const result = codexLegacyImportService.get(request.params.importId);
      return { importId: result.importId, status: result.status, runs: result.runs.map(toCodexLegacyImportApiRun) };
    } catch (error) {
      return sendCodexLegacyImportError(reply, error);
    }
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

  server.patch(
    '/api/projects/:projectId/conversations/:conversationId/next-turn-settings',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
        Body: {
          model?: unknown;
          effort?: unknown;
          serviceTier?: unknown;
          permissionMode?: unknown;
          collaborationMode?: unknown;
        };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
      }
      const model = typeof request.body?.model === 'string' ? request.body.model.trim() : '';
      const effort = request.body?.effort === undefined ? undefined : typeof request.body.effort === 'string' ? request.body.effort.trim() : null;
      const hasServiceTier = Object.prototype.hasOwnProperty.call(request.body ?? {}, 'serviceTier');
      const serviceTier = request.body?.serviceTier;
      const permissionMode = parseConversationPermissionMode(request.body?.permissionMode);
      const collaborationMode = parseConversationCollaborationMode(request.body?.collaborationMode);
      if (!model || effort === null || effort === '' || (hasServiceTier && serviceTier !== null && (typeof serviceTier !== 'string' || !serviceTier.trim()))) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_CONVERSATION_SETTINGS', message: 'Next turn model, reasoning effort, or service tier is invalid.' });
      }
      if (!permissionMode) return reply.code(400).send({ error: 'ZEUS_INVALID_PERMISSION_MODE', message: 'permissionMode must be read-only, auto, or full-access.' });
      if (!collaborationMode) return reply.code(400).send({ error: 'ZEUS_INVALID_COLLABORATION_MODE', message: 'collaborationMode must be default or plan.' });
      const settings: ConversationNextTurnSettings = {
        model,
        ...(effort ? { effort } : {}),
        ...(hasServiceTier ? { serviceTier: serviceTier === null ? null : (serviceTier as string).trim() } : {}),
        permissionMode,
        collaborationMode,
      };
      conversations.updateNextTurnSettings(conversation.id, settings);
      await db.save();
      return settings;
    },
  );

  server.patch(
    '/api/projects/:projectId/conversations/:conversationId/permission-mode',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
        Body: { permissionMode?: unknown };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
      }
      const permissionMode = parseConversationPermissionMode(request.body?.permissionMode);
      if (!permissionMode) return reply.code(400).send({ error: 'ZEUS_INVALID_PERMISSION_MODE', message: 'permissionMode must be read-only, auto, or full-access.' });
      const runState = inferNativeConversationSnapshotState(conversation);
      if (runState.type !== 'idle') {
        return reply.code(409).send({ error: 'ZEUS_NATIVE_PERMISSION_MODE_IN_PROGRESS', message: 'Conversation permission mode can change only while the conversation is idle.' });
      }
      const updated = conversations.updatePermissionMode(conversation.id, permissionMode);
      await db.save();
      return toNativeConversationSnapshot(updated);
    },
  );

  server.patch(
    '/api/projects/:projectId/conversations/:conversationId/collaboration-mode',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
        Body: { collaborationMode?: unknown };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({
          error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND',
          message: 'Native conversation not found',
        });
      }
      const collaborationMode = parseConversationCollaborationMode(request.body?.collaborationMode);
      if (!collaborationMode)
        return reply.code(400).send({
          error: 'ZEUS_INVALID_COLLABORATION_MODE',
          message: 'collaborationMode must be default or plan.',
        });
      const updated = conversations.updateCollaborationMode(conversation.id, collaborationMode);
      await db.save();
      publishNativeConversationEvent('conversation.collaboration_mode.changed', {
        conversationId: conversation.id,
        collaborationMode,
      });
      return toNativeConversationSnapshot(updated);
    },
  );

  server.put(
    '/api/projects/:projectId/conversations/:conversationId/completion-acknowledgement',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({
          error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND',
          message: 'Native conversation not found',
        });
      }
      if (conversation.completionUnread) {
        conversations.setCompletionUnread(conversation.id, false);
        await db.save();
      }
      return reply.code(204).send();
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
      return conversation.transportKind === 'codex_native' ? toNativeConversationSnapshot(conversation) : toGraphConversationHistoryItem(conversation);
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

  for (const action of ['undo', 'reapply'] as const) {
    server.post(
      `/api/projects/:projectId/conversations/:conversationId/turns/:turnId/change-set/${action}`,
      async (
        request: FastifyRequest<{
          Params: { projectId: string; conversationId: string; turnId: string };
          Body: { changeSetId?: unknown; expectedState?: unknown; idempotencyKey?: unknown };
        }>,
        reply,
      ) => {
        const body = request.body ?? {};
        if (typeof body.changeSetId !== 'string' || typeof body.idempotencyKey !== 'string' || !body.changeSetId.trim() || !body.idempotencyKey.trim() || (body.expectedState !== 'applied' && body.expectedState !== 'undone')) {
          return reply.code(400).send({
            error: 'ZEUS_TURN_CHANGE_SET_REQUEST_INVALID',
            message: 'changeSetId, expectedState, and idempotencyKey are required.',
          });
        }
        try {
          return await turnChangeSetService.operate({
            projectId: request.params.projectId,
            conversationId: request.params.conversationId,
            turnId: conversationTurns.listByConversation(request.params.conversationId).find((candidate) => candidate.id === request.params.turnId || candidate.providerTurnId === request.params.turnId)?.id ?? request.params.turnId,
            action,
            request: {
              changeSetId: body.changeSetId,
              expectedState: body.expectedState,
              idempotencyKey: body.idempotencyKey,
            },
          });
        } catch (error) {
          return reply.code(changeSetErrorStatus(error)).send({
            error: turnChangeSetErrorCode(error),
            message: error instanceof Error ? error.message : 'Turn change set operation failed.',
            ...(error instanceof Error && 'paths' in error && Array.isArray((error as Error & { paths?: unknown }).paths) ? { paths: (error as Error & { paths: unknown[] }).paths } : {}),
          });
        }
      },
    );
  }

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/messages',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
        Body: CreateConversationMessageBody;
      }>,
      reply,
    ): Promise<{ conversation: GraphConversationHistoryItem; runtimeSession?: AiRuntimeSession; runtimeError?: { message: string } } | unknown> => {
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
      try {
        assertRequestedAgentKind(request.body ?? {});
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
      if (conversation.agentKind === 'claude') {
        return reply.code(409).send({
          error: 'ZEUS_AGENT_NOT_AVAILABLE',
          message: 'Claude Agent 当前尚未开放。',
        });
      }
      const content = typeof request.body?.content === 'string' ? request.body.content.trim() : '';
      const hasNativeResourceInput =
        conversation.transportKind === 'codex_native' && ((Array.isArray(request.body?.attachments) && request.body.attachments.length > 0) || (Array.isArray(request.body?.browserComments) && request.body.browserComments.length > 0));
      if (!content && !hasNativeResourceInput) {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_CONVERSATION_MESSAGE',
          message: 'Conversation message content, attachments, or browser comments are required',
        });
      }
      if (conversation.transportKind === 'codex_native') {
        const idempotencyKey = readIdempotencyKey(request);
        if (!idempotencyKey) return reply.code(400).send({ error: 'ZEUS_IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required.' });
        try {
          const accepted = await executeIdempotentJson(
            `conversation-message:${conversation.id}`,
            idempotencyKey,
            request.body ?? {},
            202,
            (stableOperationId, lifecycle) => acceptNativeConversationMessage(conversation, content, request.body ?? {}, idempotencyKey, stableOperationId, lifecycle),
            async (stableOperationId, persistedResourceId) => {
              const updatedConversation = conversations.getById(conversation.id);
              let submission = conversationSubmissions.listByConversation(conversation.id).find((candidate) => candidate.idempotencyKey === idempotencyKey);
              if (!updatedConversation || !submission || persistedResourceId !== submission.id || !submission.providerTurnId) return undefined;
              const input = parseJsonObject(submission.inputJson);
              if (input.delivery === 'steer_now' && submission.status === 'queued') {
                submission = conversationSubmissions.updateStatus(submission.id, 'paused', {
                  pausedReason: 'recovery_required',
                  error: { code: 'ZEUS_NATIVE_STEER_OUTCOME_UNKNOWN' },
                  updatedAt: now().toISOString(),
                });
                await db.save();
              }
              return { statusCode: 202, body: toNativeDurableAcceptance(stableOperationId, idempotencyKey, updatedConversation, submission) };
            },
          );
          return reply.code(accepted.statusCode).send(accepted.body);
        } catch (error) {
          return sendNativeConversationApiError(reply, error);
        }
      }
      const legacyContext = resolveWritableNonCodexLegacyConversation(conversation, {
        configuredCommands: {
          claude: runtimeSettings.adapterCliPaths.claude,
          gemini: runtimeSettings.adapterCliPaths.gemini,
          generic: runtimeSettings.adapterCliPaths.generic,
        },
      });
      if (!legacyContext) {
        return reply.code(409).send({
          error: 'ZEUS_LEGACY_CONVERSATION_READ_ONLY',
          message: 'Legacy CLI conversations are read-only. Create a native conversation with an explicit legacy reference instead.',
        });
      }
      const liveResolution = resolveNonCodexLiveSession(project, legacyContext);
      if (liveResolution.type === 'mismatch') {
        return reply.code(409).send({
          error: 'ZEUS_LEGACY_RUNTIME_IDENTITY_MISMATCH',
          message: liveResolution.reason,
        });
      }
      const createdAt = new Date().toISOString();
      conversations.appendMessage({
        conversationId: conversation.id,
        role: 'user',
        content,
        source: 'user_followup',
        metadata: {
          projectId: project.id,
          taskId: conversation.taskId,
          sessionId: conversation.sessionId,
        },
        createdAt,
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'conversation.message.created',
        resourceType: 'conversation',
        resourceId: conversation.id,
        payload: {
          projectId: project.id,
          conversationId: conversation.id,
          taskId: conversation.taskId,
          sessionId: conversation.sessionId,
          contentLength: content.length,
        },
      });
      let runtimeSession: AiRuntimeSession | undefined;
      let runtimeError: { message: string } | undefined;
      const conversationAfterUserMessage = conversations.getById(conversation.id);
      if (!conversationAfterUserMessage) {
        throw new Error(`Zeus conversation not found: ${conversation.id}`);
      }
      const refreshedLegacyContext: WritableNonCodexLegacyConversationContext = {
        ...legacyContext,
        conversation: conversationAfterUserMessage,
      };
      if (liveResolution.type === 'writable') {
        try {
          runtimeSession = aiRuntimeManager.inputSession(liveResolution.session.id, `${content}\n`);
          appendAuditLog({
            actorType: 'local_api',
            action: 'runtime.session.input',
            resourceType: 'runtime_session',
            resourceId: runtimeSession.id,
            payload: {
              sessionId: runtimeSession.id,
              projectId: runtimeSession.projectId,
              taskId: runtimeSession.taskId,
              conversationId: conversation.id,
              inputLength: content.length,
              source: 'conversation.message',
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!shouldReconnectTaskConversationRuntime(message)) {
            runtimeError = { message };
          }
        }
      }
      if (!runtimeSession && !runtimeError) {
        const reconnectResult = await reconnectNonCodexLegacyConversationRuntime(project, refreshedLegacyContext, conversation.sessionId ?? 'missing-runtime-session');
        if ('runtimeSession' in reconnectResult) {
          runtimeSession = reconnectResult.runtimeSession;
        } else {
          runtimeError = reconnectResult.runtimeError;
        }
      }
      if (runtimeError) {
        conversations.appendMessage({
          conversationId: conversation.id,
          role: 'system',
          content: `Runtime 输入失败：${runtimeError.message}`,
          source: 'task_runtime_input_error',
          metadata: {
            projectId: project.id,
            taskId: conversation.taskId,
            sessionId: conversation.sessionId,
          },
          createdAt: new Date().toISOString(),
        });
      }
      await db.save();
      const updatedConversation = conversations.getById(conversation.id);
      if (!updatedConversation) {
        throw new Error(`Zeus conversation not found: ${conversation.id}`);
      }
      return reply.code(201).send({
        conversation: toGraphConversationHistoryItem(updatedConversation),
        ...(runtimeSession ? { runtimeSession } : {}),
        ...(runtimeError ? { runtimeError } : {}),
      });
    },
  );

  server.patch(
    '/api/projects/:projectId/conversations/:conversationId/queue/:submissionId',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string; submissionId: string };
        Body: { content?: string };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
      }
      const content = request.body?.content?.trim();
      if (!content) return reply.code(400).send({ error: 'ZEUS_INVALID_CONVERSATION_MESSAGE', message: 'Queued message content is required.' });
      try {
        const queue = await codexNativeCoordinator.editQueuedSubmission({
          conversationId: conversation.id,
          submissionId: request.params.submissionId,
          content,
        });
        publishNativeConversationEvent('conversation.queue.changed', { conversationId: conversation.id });
        return queue;
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.delete(
    '/api/projects/:projectId/conversations/:conversationId/queue/:submissionId',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string; submissionId: string };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
      }
      try {
        const queue = await codexNativeCoordinator.deleteQueuedSubmission({
          conversationId: conversation.id,
          submissionId: request.params.submissionId,
        });
        publishNativeConversationEvent('conversation.queue.changed', { conversationId: conversation.id });
        return queue;
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/queue/:submissionId/send-now',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string; submissionId: string };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
      }
      try {
        const startedResourceId = `send-now:${request.params.submissionId}`;
        const accepted = await executeIdempotentJson(
          `native-send-now:${conversation.id}`,
          request.params.submissionId,
          {},
          202,
          async (stableOperationId, lifecycle) => {
            const operation = await codexNativeCoordinator.sendQueuedNow({
              conversationId: conversation.id,
              submissionId: request.params.submissionId,
              providerWriteLifecycle: {
                markPrepared: () => lifecycle.markPrepared(startedResourceId),
                markRpcStarted: () => lifecycle.markRpcStarted(startedResourceId),
              },
            });
            const updatedConversation = conversations.getById(conversation.id);
            const submission = conversationSubmissions.getById(request.params.submissionId);
            if (!updatedConversation || !submission) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native send-now acceptance was not persisted.');
            void operation;
            return toNativeDurableAcceptance(stableOperationId, request.params.submissionId, updatedConversation, submission);
          },
          (stableOperationId, persistedResourceId) => {
            if (persistedResourceId !== startedResourceId) return undefined;
            const updatedConversation = conversations.getById(conversation.id);
            const submission = conversationSubmissions.getById(request.params.submissionId);
            if (!updatedConversation || !submission || submission.status !== 'resolved' || !submission.providerTurnId) return undefined;
            return { statusCode: 202, body: toNativeDurableAcceptance(stableOperationId, request.params.submissionId, updatedConversation, submission) };
          },
          startedResourceId,
        );
        return reply.code(accepted.statusCode).send(accepted.body);
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/turns/:turnId/interrupt',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string; turnId: string };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
      }
      const turn = conversationTurns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === request.params.turnId);
      if (!turn) return reply.code(404).send({ error: 'ZEUS_NATIVE_TURN_NOT_FOUND', message: 'Native provider turn not found' });
      try {
        const startedResourceId = `interrupt:${turn.id}`;
        const accepted = await executeIdempotentJson(
          `native-interrupt:${conversation.id}`,
          request.params.turnId,
          {},
          202,
          async (stableOperationId, lifecycle) => {
            const operation =
              conversation.agentKind === 'pi'
                ? await (async () => {
                    await lifecycle.markPrepared(startedResourceId);
                    lifecycle.markRpcStarted(startedResourceId);
                    return piNativeCoordinator.interruptTurn({ conversation, providerTurnId: request.params.turnId });
                  })()
                : await codexNativeCoordinator.interruptTurn({
                    conversationId: conversation.id,
                    providerTurnId: request.params.turnId,
                    providerWriteLifecycle: {
                      markPrepared: () => lifecycle.markPrepared(startedResourceId),
                      markRpcStarted: () => lifecycle.markRpcStarted(startedResourceId),
                    },
                  });
            const updatedConversation = conversations.getById(conversation.id);
            const submission = operation.submissionId ? conversationSubmissions.getById(operation.submissionId) : undefined;
            if (!updatedConversation) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native interrupt acceptance was not persisted.');
            return toNativeInterruptAcceptance(stableOperationId, request.params.turnId, updatedConversation, submission);
          },
          async (stableOperationId, persistedResourceId) => {
            if (persistedResourceId !== startedResourceId) return undefined;
            const updatedConversation = conversations.getById(conversation.id);
            const currentTurn = conversationTurns.getById(turn.id);
            const submission = conversationSubmissions.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === request.params.turnId);
            if (!updatedConversation || !currentTurn) return undefined;
            if (currentTurn.status === 'interrupted') {
              return { statusCode: 202, body: toNativeInterruptAcceptance(stableOperationId, request.params.turnId, updatedConversation, submission) };
            }
            if (currentTurn.status === 'running' || currentTurn.status === 'waiting' || currentTurn.status === 'dispatching') {
              const timestamp = now().toISOString();
              conversationTurns.upsert({ ...currentTurn, status: 'paused', updatedAt: timestamp });
              if (submission && (submission.status === 'active' || submission.status === 'dispatching')) {
                conversationSubmissions.updateStatus(submission.id, 'paused', {
                  pausedReason: 'recovery_required',
                  error: { code: 'ZEUS_NATIVE_INTERRUPT_OUTCOME_UNKNOWN' },
                  updatedAt: timestamp,
                });
              }
              conversations.bindProvider(conversation.id, {
                providerId: 'codex',
                providerThreadId: currentTurn.providerThreadId,
                providerModel: updatedConversation.providerModel,
                providerState: 'paused',
              });
              await db.save();
            }
            return undefined;
          },
          startedResourceId,
        );
        return reply.code(accepted.statusCode).send(accepted.body);
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/requests/:requestId/respond',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string; requestId: string };
        Body: Record<string, unknown>;
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
      }
      const providerRequest = conversationRequests.getById(request.params.requestId);
      if (!providerRequest || providerRequest.conversationId !== conversation.id) {
        return reply.code(404).send({ error: 'ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', message: 'Codex server request not found' });
      }
      try {
        const startedResourceId = `request-response:${providerRequest.id}`;
        const accepted = await executeIdempotentJson(
          `native-request-response:${conversation.id}`,
          providerRequest.id,
          request.body ?? {},
          202,
          async (stableOperationId, lifecycle) => {
            const response = normalizeNativeServerRequestResponse(providerRequest.requestKind, request.body ?? {});
            if (conversation.agentKind === 'pi') {
              await lifecycle.markPrepared(startedResourceId);
              lifecycle.markRpcStarted(startedResourceId);
              await piNativeCoordinator.respondToRequest({ requestId: providerRequest.id, response });
            } else {
              await codexNativeCoordinator.respondToRequest({
                requestId: providerRequest.id,
                response,
                providerWriteLifecycle: {
                  markPrepared: () => lifecycle.markPrepared(startedResourceId),
                  markRpcStarted: () => lifecycle.markRpcStarted(startedResourceId),
                },
              });
            }
            const resolved = conversationRequests.getById(providerRequest.id);
            if (!resolved) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native request response was not persisted.');
            return {
              operation: { id: stableOperationId, status: 'accepted' as const, idempotencyKey: providerRequest.id },
              request: toNativeServerRequest(resolved),
            };
          },
          (stableOperationId, persistedResourceId) => {
            if (persistedResourceId !== startedResourceId) return undefined;
            const persistedRequest = conversationRequests.getById(providerRequest.id);
            if (!persistedRequest || persistedRequest.status !== 'resolved') return undefined;
            return {
              statusCode: 202,
              body: {
                operation: { id: stableOperationId, status: 'accepted' as const, idempotencyKey: providerRequest.id },
                request: toNativeServerRequest(persistedRequest),
              },
            };
          },
          startedResourceId,
        );
        return reply.code(accepted.statusCode).send(accepted.body);
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/plan-implementation-requests/:requestId/respond',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string; requestId: string };
        Body: { action?: unknown; feedback?: unknown };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({
          error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND',
          message: 'Native conversation not found',
        });
      }
      const action = request.body?.action;
      if (action !== 'implement' && action !== 'refine' && action !== 'dismiss') {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_PLAN_IMPLEMENTATION_RESPONSE',
          message: 'action must be implement, refine, or dismiss.',
        });
      }
      try {
        const operation = await codexNativeCoordinator.respondToPlanImplementationRequest({
          conversationId: conversation.id,
          requestId: request.params.requestId,
          action,
          ...(typeof request.body?.feedback === 'string' ? { feedback: request.body.feedback } : {}),
        });
        const updated = conversations.getById(conversation.id);
        const planRequest = conversationPlanActions.getById(request.params.requestId);
        if (!updated || !planRequest) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Plan implementation response was not persisted.');
        return reply.code(202).send({
          operation,
          request: planRequest,
          conversation: await toNativeConversationSnapshot(updated),
        });
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/requests/:requestId/snooze',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string; requestId: string };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({
          error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND',
          message: 'Native conversation not found',
        });
      }
      const providerRequest = conversationRequests.getById(request.params.requestId);
      if (!providerRequest || providerRequest.conversationId !== conversation.id) {
        return reply.code(404).send({
          error: 'ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND',
          message: 'Codex server request not found',
        });
      }
      try {
        await codexNativeCoordinator.snoozeRequest({ requestId: providerRequest.id });
        return { request: toNativeServerRequest(conversationRequests.getById(providerRequest.id)!) };
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/provider-thread/restore',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({
          error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND',
          message: 'Native conversation not found',
        });
      }
      try {
        await codexNativeCoordinator.restoreArchivedConversation({ conversationId: conversation.id });
        const restored = conversations.getById(conversation.id);
        if (!restored)
          return reply.code(404).send({
            error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND',
            message: 'Native conversation not found',
          });
        publishNativeConversationEvent('conversation.thread.changed', {
          conversationId: conversation.id,
          providerThreadId: restored.providerThreadId,
          providerState: restored.providerState,
        });
        publishNativeConversationEvent('conversation.queue.changed', { conversationId: conversation.id });
        return toNativeConversationSnapshot(restored);
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/queue/resume',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
      }
      try {
        const snapshot = await codexNativeCoordinator.resumeInterruptedQueue({ conversationId: conversation.id });
        publishNativeConversationEvent('conversation.queue.changed', { conversationId: conversation.id });
        return reply.code(202).send(snapshot);
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/queue/reorder',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
        Body: { orderedSubmissionIds?: string[] };
      }>,
      reply,
    ) => {
      const conversation = conversations.getById(request.params.conversationId);
      if (!conversation || conversation.projectId !== request.params.projectId || conversation.transportKind !== 'codex_native') {
        return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
      }
      const orderedSubmissionIds = request.body?.orderedSubmissionIds;
      if (!Array.isArray(orderedSubmissionIds) || orderedSubmissionIds.some((id) => typeof id !== 'string')) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_NATIVE_QUEUE_REORDER', message: 'orderedSubmissionIds must be an array of submission ids.' });
      }
      try {
        const queue = await codexNativeCoordinator.reorderQueue({ conversationId: conversation.id, orderedSubmissionIds });
        publishNativeConversationEvent('conversation.queue.changed', { conversationId: conversation.id });
        return queue;
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/archive',
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
      if (conversation.transportKind === 'codex_native') {
        try {
          await codexNativeCoordinator.archiveConversation({ conversationId: conversation.id });
        } catch (error) {
          return sendNativeConversationApiError(reply, error);
        }
      } else {
        conversations.archive(conversation.id);
      }
      const archived = conversations.getById(conversation.id);
      if (!archived) {
        return reply.code(404).send({
          error: 'ZEUS_CONVERSATION_NOT_FOUND',
          message: 'Conversation not found',
        });
      }
      appendAuditLog({
        actorType: 'local_api',
        action: 'conversation.archived',
        resourceType: 'conversation',
        resourceId: archived.id,
        payload: { projectId: project.id, conversationId: archived.id },
      });
      await db.save();
      return toGraphConversationHistoryItem(archived);
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/restore',
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
      if (conversation.transportKind === 'codex_native') {
        try {
          await codexNativeCoordinator.restoreArchivedConversation({ conversationId: conversation.id });
        } catch (error) {
          return sendNativeConversationApiError(reply, error);
        }
      } else {
        conversations.restore(conversation.id);
      }
      const restored = conversations.getById(conversation.id);
      if (!restored) {
        return reply.code(404).send({
          error: 'ZEUS_CONVERSATION_NOT_FOUND',
          message: 'Conversation not found',
        });
      }
      appendAuditLog({
        actorType: 'local_api',
        action: 'conversation.restored',
        resourceType: 'conversation',
        resourceId: restored.id,
        payload: { projectId: project.id, conversationId: restored.id },
      });
      await db.save();
      return toGraphConversationHistoryItem(restored);
    },
  );

  server.get('/api/projects/:projectId', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    return project;
  });

  server.get('/api/conversations/archived', async () => {
    const choices = listArchivedTaskConversationHistory().map(toNativeConversationChoice);
    return { choices, items: choices };
  });

  server.get('/api/projects/:projectId/config', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply): Promise<ProjectConfigSnapshot | unknown> => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    return readProjectConfig(project.id);
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
        Body: SaveProjectDatabaseSecretBody;
      }>,
      reply,
    ): Promise<ProjectDatabaseSecretSnapshot | unknown> => {
      const project = projects.getById(request.params.projectId);
      if (!project)
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      const secretKey = getProjectDatabasePasswordSecretKey(project.id);
      if (!secretKey)
        return reply.code(400).send({
          error: 'ZEUS_DATABASE_CONNECTION_NOT_CONFIGURED',
          message: 'Project database connection name is required before saving a password',
        });
      const password = request.body?.password?.trim();
      if (!password)
        return reply.code(400).send({
          error: 'ZEUS_INVALID_SECRET',
          message: 'Database connection password is required',
        });
      await secretStore.setSecret(secretKey.key, password);
      appendAuditLog({
        actorType: 'local_api',
        action: 'security.secret.database_connection_password.saved',
        resourceType: 'secret',
        resourceId: secretKey.key,
        payload: {
          projectId: project.id,
          connectionName: secretKey.connectionName,
          configured: true,
          secretValueStored: false,
        },
      });
      await db.save();
      return {
        connectionName: secretKey.connectionName,
        password: getSecretPresenceLabel(password),
      };
    },
  );

  server.delete('/api/projects/:projectId/database/secret', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply): Promise<ProjectDatabaseSecretSnapshot | unknown> => {
    const project = projects.getById(request.params.projectId);
    if (!project)
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    const secretKey = getProjectDatabasePasswordSecretKey(project.id);
    if (!secretKey)
      return {
        connectionName: null,
        password: getSecretPresenceLabel(undefined),
      };
    await secretStore.deleteSecret(secretKey.key);
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.secret.database_connection_password.deleted',
      resourceType: 'secret',
      resourceId: secretKey.key,
      payload: {
        projectId: project.id,
        connectionName: secretKey.connectionName,
        configured: false,
      },
    });
    await db.save();
    return {
      connectionName: secretKey.connectionName,
      password: getSecretPresenceLabel(undefined),
    };
  });

  server.put(
    '/api/projects/:projectId/config',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: UpdateProjectConfigBody;
      }>,
      reply,
    ): Promise<ProjectConfigSnapshot | unknown> => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const nextConfig = normalizeProjectConfig(project.id, request.body, readProjectConfig(project.id));
      if (!nextConfig) {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_PROJECT_CONFIG',
          message: 'Project config must use safe single-line values and supported options',
        });
      }
      if (hasDatabaseUriPassword(nextConfig.database.connectionName)) {
        return reply.code(400).send({
          error: 'ZEUS_DATABASE_CONNECTION_SECRET_IN_URI',
          message: 'Database connection URI must not include a password; save the password in the project Keychain field.',
        });
      }
      // 项目配置只保存用户偏好，不创建任务、不执行扫描、不声明外部 CLI 或数据库已可用。
      settings.setJson(projectConfigSettingsPrefix + project.id, nextConfig);
      appendAuditLog({
        actorType: 'local_api',
        action: 'project.config.updated',
        resourceType: 'project',
        resourceId: project.id,
        payload: {
          defaultWorkMode: nextConfig.defaultWorkMode,
          indexScope: nextConfig.scan.indexScope,
          language: nextConfig.language.primary,
        },
      });
      await db.save();
      return nextConfig;
    },
  );

  server.post('/api/projects/:projectId/scan', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    if (activeProjectGraphScanIds.has(project.id)) {
      return reply.code(409).send({
        error: 'ZEUS_GRAPH_SCAN_ALREADY_RUNNING',
        message: 'Graph scan is already running for this project.',
      });
    }
    activeProjectGraphScanIds.add(project.id);
    projects.updateScanStatus(project.id, 'scanning');
    await db.save();
    try {
      const result = await runCodeMapScan({
        projectName: project.name,
        graphProjectName: resolveGraphProjectName(project),
        rootPath: project.localPath,
        projectConfig: readProjectConfig(project.id),
      });
      projects.updateScanStatus(project.id, 'completed');
      await db.save();
      return result;
    } catch (error) {
      projects.updateScanStatus(project.id, 'failed');
      await db.save();
      publishRealtimeEvent('project.scan.failed', {
        projectName: project.name,
        rootPath: project.localPath,
        message: error instanceof Error ? error.message : String(error),
      });
      return reply.code(isUnsafeCodeMapScanRootError(error) ? 400 : 500).send({
        error: isUnsafeCodeMapScanRootError(error) ? 'ZEUS_UNSAFE_GRAPH_SCAN_ROOT' : 'ZEUS_GRAPH_SCAN_FAILED',
        message: error instanceof Error ? error.message : 'Graph scan failed',
      });
    } finally {
      activeProjectGraphScanIds.delete(project.id);
    }
  });

  server.get('/api/projects/:projectId/scan-status', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    return {
      projectId: project.id,
      scanStatus: project.scanStatus,
      graph: readCurrentGraphSummaryByProject(resolveGraphProjectName(project)),
    };
  });

  server.get('/api/projects/:projectId/overview', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    const projectTasks = tasks.listByProject(project.id);
    const gitScope = resolveProjectGitScope(project);
    return {
      project,
      graph: readCurrentGraphSummaryByProject(resolveGraphProjectName(project)),
      git: 'limitation' in gitScope ? unsupportedProjectGitStatus(gitScope.limitation) : await readGitStatus(gitScope.path),
      tasks: {
        total: projectTasks.length,
        byStatus: countTasksByStatus(projectTasks),
        recent: projectTasks.slice(-5).reverse(),
      },
    };
  });

  server.get('/api/projects/:projectId/git/status', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply): Promise<GitStatusSummary | unknown> => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    const gitScope = resolveProjectGitScope(project);
    return 'limitation' in gitScope ? unsupportedProjectGitStatus(gitScope.limitation) : readGitStatus(gitScope.path);
  });

  server.get(
    '/api/projects/:projectId/git/diff',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Querystring: { taskId?: string };
      }>,
      reply,
    ): Promise<GitDiffSummary | unknown> => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const gitScope = resolveProjectGitScope(project);
      if ('limitation' in gitScope) {
        return reply.code(409).send({ error: 'ZEUS_PROJECT_GIT_SCOPE_UNSUPPORTED', message: gitScope.limitation });
      }
      const diff = await readGitDiff(gitScope.path);
      publishGitDiffUpdatedEvent(diff, project.id);
      if (request.query.taskId) {
        persistReadonlyGitDiffSnapshot({
          projectId: project.id,
          taskId: request.query.taskId,
          diff,
          graphRoot: project.localPath,
        });
        publishRealtimeEvent('git.snapshot.created', {
          projectId: project.id,
          taskId: request.query.taskId,
          snapshotType: 'readonly_diff',
          fileCount: diff.files.length,
        });
        await db.save();
      }
      return diff;
    },
  );

  server.get('/api/tasks/:taskId/git-workspaces', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    const project = projects.getById(task.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    const remoteRefreshes = new Map<string, ReturnType<typeof fetchGitRemote>>();
    const refreshWorkspaceRemote = (repositoryPath: string, remoteName: string): ReturnType<typeof fetchGitRemote> => {
      const key = `${repositoryPath}\0${remoteName}`;
      const existing = remoteRefreshes.get(key);
      if (existing) return existing;
      const refresh = fetchGitRemote(repositoryPath, remoteName);
      remoteRefreshes.set(key, refresh);
      return refresh;
    };
    let items: Array<Record<string, unknown>>;
    try {
      items = await Promise.all(
        taskWorkspaces.listByTask(task.id).map(async (workspace) => {
          const repositoryPath = workspace.repositoryPath || project.localPath;
          const repository = await getGitRepositoryContext(repositoryPath);
          let refreshedRemote: Awaited<ReturnType<typeof fetchGitRemote>> | null = null;
          let remoteRefreshError: string | null = null;
          if (workspace.remoteName) {
            try {
              refreshedRemote = await refreshWorkspaceRemote(repositoryPath, workspace.remoteName);
            } catch (error) {
              // 远端故障只限制当前仓库的远端动作，本机差异和本地提交必须继续可用。
              remoteRefreshError = taskGitErrorCode(error);
            }
          }
          const targetBranches = workspace.remoteName ? (refreshedRemote?.branches.map((ref) => ref.slice(`${workspace.remoteName}/`.length)) ?? []) : repository.localBranches;
          const activeConversationCount = countTaskWorkspaceActiveConversations(workspace);
          let branchComparison = null;
          let comparisonError: string | undefined;
          try {
            branchComparison = await getTaskBranchComparison(repositoryPath, workspace.sourceBranch, workspace.branchName, workspace.sourceHeadSha);
          } catch (error) {
            comparisonError = error instanceof Error ? error.message : 'Task branch comparison failed.';
          }
          const remoteHeadSha = workspace.remoteName && refreshedRemote ? await getRemoteTrackingBranchHead(repositoryPath, workspace.remoteName, workspace.remoteBranch) : null;
          const expectedHeadSha = branchComparison?.taskHeadSha ?? workspace.headSha;
          const remoteVerified = Boolean(expectedHeadSha && remoteHeadSha === expectedHeadSha);
          if (!workspace.worktreePath || workspace.state === 'reclaimed' || workspace.state === 'merged' || workspace.state === 'discarded') {
            return {
              ...workspace,
              activeConversationCount,
              review: null,
              branchComparison,
              remoteHeadSha,
              remoteVerified,
              remoteRefreshError,
              primaryBranch: repository.branch || null,
              localBranches: repository.localBranches,
              targetBranches,
              ...(comparisonError ? { comparisonError } : {}),
            };
          }
          try {
            return {
              ...workspace,
              activeConversationCount,
              review: await readTaskWorkspaceReview(workspace),
              branchComparison,
              remoteHeadSha,
              remoteVerified,
              remoteRefreshError,
              primaryBranch: repository.branch || null,
              localBranches: repository.localBranches,
              targetBranches,
              ...(comparisonError ? { comparisonError } : {}),
            };
          } catch (error) {
            return {
              ...workspace,
              activeConversationCount,
              review: null,
              reviewError: error instanceof Error ? error.message : 'Task workspace review failed.',
              branchComparison,
              remoteHeadSha,
              remoteVerified,
              remoteRefreshError,
              primaryBranch: repository.branch || null,
              localBranches: repository.localBranches,
              targetBranches,
              ...(comparisonError ? { comparisonError } : {}),
            };
          }
        }),
      );
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

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/commit', async (request: FastifyRequest<{ Params: { taskId: string; workspaceId: string }; Body: CommitTaskWorkspaceBody }>, reply) => {
    const resolved = resolveTaskWorkspaceRequest(request.params.taskId, request.params.workspaceId);
    if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
    const { task, workspace } = resolved;
    try {
      assertTaskWorkspaceWritable(workspace);
      assertNestedTaskWorktreesReclaimed(workspace);
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
    if (!workspace.worktreePath) return reply.code(409).send({ error: 'ZEUS_TASK_WORKTREE_UNAVAILABLE', message: 'Task worktree is not available.' });
    if (request.body?.push === true && !workspace.remoteName) {
      return reply.code(409).send({ error: 'ZEUS_TASK_GIT_REMOTE_UNAVAILABLE', message: 'This repository has no Git remote. Commit locally or configure a remote before pushing.' });
    }
    const selectedPaths = Array.isArray(request.body?.selectedPaths) && request.body.selectedPaths.every((path) => typeof path === 'string') ? request.body.selectedPaths : [];
    try {
      const result = await commitAndPushTaskWorkspace({
        cwd: workspace.worktreePath,
        ignoredPaths: taskWorkspaceIgnoredPaths(workspace),
        message:
          request.body?.message?.trim() ||
          buildTaskCommitMessageSuggestion({
            taskType: task.taskType,
            taskCode: task.taskCode,
            taskTitle: task.title,
          }),
        selectedPaths,
        remoteName: workspace.remoteName,
        remoteBranch: workspace.remoteBranch,
        push: request.body?.push === true,
      });
      taskWorkspaces.update(workspace.id, { headSha: result.headSha, state: 'ready', lastError: null });
      recordTaskEvent({
        taskId: task.id,
        eventType: result.pushed ? 'task.git_workspace.pushed' : 'task.git_workspace.committed',
        title: result.pushed ? '任务分支已提交并推送' : '任务分支已提交',
        payload: { workspaceId: workspace.id, branchName: workspace.branchName, ...result },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: result.pushed ? 'task.git_workspace.commit_push' : 'task.git_workspace.commit',
        resourceType: 'task_workspace',
        resourceId: workspace.id,
        payload: { taskId: task.id, projectId: task.projectId, branchName: workspace.branchName, selectedPaths, ...result },
        createdAt: new Date().toISOString(),
      });
      await db.save();
      return { workspace: taskWorkspaces.getById(workspace.id), result, review: await readTaskWorkspaceReview(workspace) };
    } catch (error) {
      taskWorkspaces.update(workspace.id, { state: 'failed', lastError: error instanceof Error ? error.message : 'Task workspace commit failed.' });
      await db.save();
      return sendTaskGitApiError(reply, error);
    }
  });

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/push', async (request: FastifyRequest<{ Params: { taskId: string; workspaceId: string } }>, reply) => {
    const resolved = resolveTaskWorkspaceRequest(request.params.taskId, request.params.workspaceId);
    if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
    const { task, workspace } = resolved;
    try {
      assertTaskWorkspaceWritable(workspace);
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
    if (!workspace.worktreePath) return reply.code(409).send({ error: 'ZEUS_TASK_WORKTREE_UNAVAILABLE', message: 'Task worktree is not available.' });
    if (!workspace.remoteName) {
      return reply.code(409).send({ error: 'ZEUS_TASK_GIT_REMOTE_UNAVAILABLE', message: 'This repository has no Git remote. Configure a remote before pushing.' });
    }
    try {
      const result = await pushTaskWorkspace({
        cwd: workspace.worktreePath,
        ignoredPaths: taskWorkspaceIgnoredPaths(workspace),
        remoteName: workspace.remoteName,
        remoteBranch: workspace.remoteBranch,
      });
      taskWorkspaces.update(workspace.id, { headSha: result.headSha, state: 'ready', lastError: null });
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.git_workspace.pushed',
        title: '任务分支已推送',
        payload: { workspaceId: workspace.id, branchName: workspace.branchName, ...result },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'task.git_workspace.push',
        resourceType: 'task_workspace',
        resourceId: workspace.id,
        payload: { taskId: task.id, projectId: task.projectId, branchName: workspace.branchName, ...result },
        createdAt: new Date().toISOString(),
      });
      await db.save();
      return { workspace: taskWorkspaces.getById(workspace.id), result, review: await readTaskWorkspaceReview(workspace) };
    } catch (error) {
      taskWorkspaces.update(workspace.id, { state: 'failed', lastError: error instanceof Error ? error.message : 'Task workspace push failed.' });
      await db.save();
      return sendTaskGitApiError(reply, error);
    }
  });

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/stop-sessions', async (request: FastifyRequest<{ Params: { taskId: string; workspaceId: string } }>, reply) => {
    const resolved = resolveTaskWorkspaceRequest(request.params.taskId, request.params.workspaceId);
    if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
    let interrupted = 0;
    let cancelled = 0;
    try {
      for (const conversation of listTaskWorkspaceConversations(resolved.workspace)) {
        const activeTurn = [...conversationTurns.listByConversation(conversation.id)].reverse().find((turn) => (turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching') && turn.providerTurnId);
        if (activeTurn?.providerTurnId) {
          await codexNativeCoordinator.interruptTurn({ conversationId: conversation.id, providerTurnId: activeTurn.providerTurnId });
          interrupted += 1;
        }
        for (const submission of conversationSubmissions.listByConversation(conversation.id)) {
          if (submission.status !== 'queued' && submission.status !== 'paused' && submission.status !== 'failed') continue;
          conversationSubmissions.updateStatus(submission.id, 'cancelled', { resolvedAt: new Date().toISOString() });
          cancelled += 1;
        }
      }
      recordTaskEvent({
        taskId: resolved.task.id,
        eventType: 'task.git_workspace.sessions_stopped',
        title: '任务分支上的活动会话已停止',
        payload: { workspaceId: resolved.workspace.id, interrupted, cancelled },
      });
      await db.save();
      return { workspaceId: resolved.workspace.id, interrupted, cancelled };
    } catch (error) {
      return sendNativeConversationApiError(reply, error);
    }
  });

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/reclaim', async (request: FastifyRequest<{ Params: { taskId: string; workspaceId: string } }>, reply) => {
    const resolved = resolveTaskWorkspaceRequest(request.params.taskId, request.params.workspaceId);
    if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
    const { task, project, workspace } = resolved;
    try {
      assertTaskWorkspaceWritable(workspace);
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
    if (!workspace.worktreePath) {
      if (workspace.state === 'reclaimed') return { workspace };
      return reply.code(409).send({ error: 'ZEUS_TASK_WORKTREE_UNAVAILABLE', message: 'Task worktree is not available.' });
    }
    try {
      const result = await reclaimTaskWorktree({
        repositoryPath: workspace.repositoryPath || project.localPath,
        worktreePath: workspace.worktreePath,
        remoteName: workspace.remoteName,
        remoteBranch: workspace.remoteBranch,
        sourceHeadSha: workspace.sourceHeadSha,
        ignoredPaths: taskWorkspaceIgnoredPaths(workspace),
      });
      const updated = taskWorkspaces.update(workspace.id, { worktreePath: null, headSha: result.headSha, state: 'reclaimed', lastError: null });
      await reclaimDeferredDeliveredAncestors(workspace.environmentId);
      reconcileTaskEnvironmentState(workspace.environmentId);
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.git_workspace.reclaimed',
        title: '任务 worktree 已回收',
        payload: { workspaceId: workspace.id, branchName: workspace.branchName, ...result },
      });
      await db.save();
      return { workspace: updated, result };
    } catch (error) {
      taskWorkspaces.update(workspace.id, { state: 'failed', lastError: error instanceof Error ? error.message : 'Task worktree reclaim failed.' });
      await db.save();
      return sendTaskGitApiError(reply, error);
    }
  });

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/discard', async (request: FastifyRequest<{ Params: { taskId: string; workspaceId: string }; Body: DiscardTaskWorkspaceBody }>, reply) => {
    const resolved = resolveTaskWorkspaceRequest(request.params.taskId, request.params.workspaceId);
    if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
    const { task, project, workspace } = resolved;
    try {
      assertTaskWorkspaceWritable(workspace);
      assertNestedTaskWorktreesReclaimed(workspace);
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
    try {
      const result = await discardTaskWorktree({
        repositoryPath: workspace.repositoryPath || project.localPath,
        worktreePath: workspace.worktreePath,
        branchName: workspace.branchName,
        confirmationText: request.body?.confirmationText?.trim() ?? '',
      });
      const updated = taskWorkspaces.update(workspace.id, { worktreePath: null, state: 'discarded', lastError: null });
      await reclaimDeferredDeliveredAncestors(workspace.environmentId);
      reconcileTaskEnvironmentState(workspace.environmentId);
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.git_workspace.discarded',
        title: '任务本地分支已放弃',
        payload: { workspaceId: workspace.id, remoteBranchPreserved: true, ...result },
      });
      await db.save();
      return { workspace: updated, result };
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
  });

  server.get('/api/tasks/:taskId/integrations', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    return { taskId: task.id, items: taskIntegrations.listByTask(task.id), integrations: taskIntegrations.listByTask(task.id) };
  });

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/integrate', async (request: FastifyRequest<{ Params: { taskId: string; workspaceId: string }; Body: StartTaskIntegrationBody }>, reply) => {
    const resolved = resolveTaskWorkspaceRequest(request.params.taskId, request.params.workspaceId);
    if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
    const { task, project, workspace } = resolved;
    if (workspace.state === 'discarded') {
      return reply.code(409).send({
        error: 'ZEUS_TASK_WORKSPACE_CLOSED',
        message: 'Discarded task branches cannot be merged.',
      });
    }
    try {
      assertTaskWorkspaceWritable(workspace);
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
    const repositoryPath = workspace.repositoryPath || project.localPath;
    const repository = await getGitRepositoryContext(repositoryPath);
    if (!repository.isRepository) {
      return reply.code(409).send({
        error: 'ZEUS_TARGET_BRANCH_UNAVAILABLE',
        message: 'Project repository is unavailable.',
      });
    }
    if (workspace.worktreePath) {
      try {
        const taskReview = await readTaskWorkspaceReview(workspace);
        if (taskReview.conflictFiles.length > 0)
          return reply.code(409).send({
            error: 'ZEUS_TASK_WORKSPACE_CONFLICTED',
            message: 'Resolve task workspace conflicts before merging.',
          });
        if (!taskReview.clean)
          return reply.code(409).send({
            error: 'ZEUS_TASK_WORKSPACE_DIRTY',
            message: 'Commit or discard every task workspace change before merging.',
          });
      } catch (error) {
        return sendTaskGitApiError(reply, error);
      }
    } else if (workspace.state !== 'reclaimed' && workspace.state !== 'merged') {
      return reply.code(409).send({
        error: 'ZEUS_TASK_WORKTREE_UNAVAILABLE',
        message: 'Task worktree is unavailable before delivery preparation completed.',
      });
    }
    const requestedTargetBranch = request.body?.targetBranch?.trim();
    const targetBranch = requestedTargetBranch || (request.body?.target === 'current' && !workspace.remoteName ? repository.branch : workspace.sourceBranch);
    if (!targetBranch || targetBranch === 'detached') {
      return reply.code(409).send({
        error: 'ZEUS_TARGET_BRANCH_UNAVAILABLE',
        message: workspace.remoteName ? 'Select an available branch from the latest remote snapshot.' : 'Select an available local target branch.',
      });
    }
    const mode = request.body?.mode === 'squash' ? 'squash' : 'merge';
    let targetHeadSha: string;
    let taskHeadSha: string;
    let targetRef: string | undefined;
    try {
      taskHeadSha = await getGitBranchHead(repositoryPath, workspace.branchName);
      if (workspace.remoteName) {
        const refreshed = await fetchGitRemote(repositoryPath, workspace.remoteName);
        const remoteTargetRef = `${workspace.remoteName}/${targetBranch}`;
        if (!refreshed.branches.includes(remoteTargetRef)) {
          throw nativeApiError('ZEUS_TARGET_BRANCH_UNAVAILABLE', `Remote target branch is not available after refresh: ${remoteTargetRef}`);
        }
        const [remoteTaskHeadSha, remoteTargetHeadSha] = await Promise.all([
          getRemoteTrackingBranchHead(repositoryPath, workspace.remoteName, workspace.remoteBranch),
          getRemoteTrackingBranchHead(repositoryPath, workspace.remoteName, targetBranch),
        ]);
        if (!remoteTaskHeadSha || remoteTaskHeadSha !== taskHeadSha) {
          throw nativeApiError('ZEUS_TASK_BRANCH_PUSH_REQUIRED', `Push ${workspace.branchName} so ${workspace.remoteName}/${workspace.remoteBranch} exactly matches local HEAD before merging.`);
        }
        if (!remoteTargetHeadSha) throw nativeApiError('ZEUS_TARGET_BRANCH_UNAVAILABLE', `Remote target branch is unavailable: ${remoteTargetRef}`);
        targetHeadSha = remoteTargetHeadSha;
        targetRef = `refs/remotes/${remoteTargetRef}`;
      } else {
        targetHeadSha = await getGitBranchHead(repositoryPath, targetBranch);
      }
    } catch (error) {
      return sendTaskGitApiError(reply, error);
    }
    const active = taskIntegrations.findActive(workspace.id, targetBranch);
    if (active) return reply.code(active.state === 'conflicted' ? 202 : 409).send({ integration: active });
    const integrationId = `task_integration_${randomUUID()}`;
    const integration = taskIntegrations.create({
      id: integrationId,
      projectId: project.id,
      taskId: task.id,
      workspaceId: workspace.id,
      targetBranch,
      targetHeadSha,
      taskHeadSha,
      mode,
      state: 'preparing',
    });
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
        return reply.code(202).send({ integration: updated });
      }
      if (request.body?.prepareOnly === true) {
        updated = taskIntegrations.update(integration.id, {
          state: 'conflicted',
          conflictFiles: [],
          lastError: null,
        });
        recordTaskEvent({
          taskId: task.id,
          eventType: 'task.git_integration.rebuilt_for_confirmation',
          title: '合入候选已按最新目标分支重建，等待重新确认',
          payload: {
            integrationId: integration.id,
            workspaceId: workspace.id,
            targetBranch,
            targetHeadSha: started.targetHeadSha,
          },
        });
        await db.save();
        return reply.code(202).send({ integration: updated });
      }
      const finalized = await finalizeTaskBranchIntegration({
        repositoryPath,
        integrationPath: started.integrationPath,
        targetBranch,
        targetHeadSha: started.targetHeadSha,
        resultHeadSha: started.resultHeadSha!,
        remoteName: workspace.remoteName,
      });
      const pendingLocalSync = !finalized.remoteName && finalized.localSyncStatus === 'pending';
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
          title: '合入结果等待同步到本地目标分支',
          payload: { integrationId: integration.id, workspaceId: workspace.id, targetBranch, resultHeadSha: finalized.resultHeadSha },
        });
        await db.save();
        return reply.code(202).send({ integration: updated, result: finalized });
      }
      const taskWorktreeReclaimed = targetBranch === workspace.sourceBranch ? await markTaskWorkspaceDelivered(workspace) : false;
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.git_integration.merged',
        title: targetBranch === workspace.sourceBranch ? '任务分支已合入来源分支' : `任务分支已合入 ${targetBranch}`,
        payload: {
          integrationId: integration.id,
          workspaceId: workspace.id,
          mode,
          sourceDelivered: targetBranch === workspace.sourceBranch,
          taskWorktreeReclaimed,
          ...finalized,
        },
      });
      await db.save();
      return { integration: updated, result: finalized };
    } catch (error) {
      taskIntegrations.update(integration.id, { state: 'failed', lastError: error instanceof Error ? error.message : 'Task branch integration failed.' });
      await db.save();
      return sendTaskGitApiError(reply, error);
    }
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

  server.post(
    '/api/tasks/:taskId/integrations/:integrationId/conflict/ai-draft',
    async (request: FastifyRequest<{ Params: { taskId: string; integrationId: string }; Querystring: { path?: string }; Body: AssistTaskIntegrationConflictBody }>, reply) => {
      const resolved = resolveTaskIntegrationRequest(request.params.taskId, request.params.integrationId);
      if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
      if (!resolved.integration.integrationPath) return reply.code(409).send({ error: 'ZEUS_TASK_INTEGRATION_PATH_UNAVAILABLE', message: 'Integration worktree is unavailable.' });
      const path = request.query.path?.trim();
      if (!path) return reply.code(400).send({ error: 'ZEUS_GIT_PATH_REQUIRED', message: 'path is required' });
      const content = request.body?.content;
      if (typeof content !== 'string') return reply.code(400).send({ error: 'ZEUS_TASK_CONFLICT_CONTENT_REQUIRED', message: 'Conflict draft content is required.' });
      if (content.length > 2_000_000) return reply.code(413).send({ error: 'ZEUS_TASK_CONFLICT_TOO_LARGE', message: '当前冲突草稿过大，无法交给 AI 处理。' });
      try {
        const blocks = parseTaskConflictAiBlocks(content);
        if (blocks.length === 0) throw nativeApiError('ZEUS_CONFLICT_AI_NO_CONFLICT', '当前文件没有仍需 AI 处理的冲突块。');
        if (blocks.length > 50) throw nativeApiError('ZEUS_CONFLICT_AI_TOO_MANY_BLOCKS', '当前文件的冲突块过多，请先人工处理一部分。');
        const modelConversation = conversations
          .listByTask(resolved.task.id)
          .filter((conversation) => (conversation.agentKind === 'codex' || conversation.agentKind === 'pi') && Boolean(conversation.modelId ?? conversation.providerModel))
          .sort((left, right) => Number(right.workspaceId === resolved.workspace.id) - Number(left.workspaceId === resolved.workspace.id))[0];
        if (!modelConversation || (modelConversation.agentKind !== 'codex' && modelConversation.agentKind !== 'pi')) {
          throw nativeApiError('ZEUS_CONFLICT_AI_MODEL_SELECTION_REQUIRED', '这条任务开发线没有可沿用的 AI 模型，请先选择模型。');
        }
        const modelId = modelConversation.modelId ?? modelConversation.providerModel;
        if (!modelId) throw nativeApiError('ZEUS_CONFLICT_AI_MODEL_SELECTION_REQUIRED', '这条任务开发线没有可沿用的 AI 模型，请先选择模型。');
        const settings = conversations.getNextTurnSettings(modelConversation.id);
        const prompt = buildTaskConflictAiPrompt({
          path,
          targetBranch: resolved.integration.targetBranch,
          taskBranch: resolved.workspace.branchName,
          blocks,
        });
        const conversationId = randomUUID();
        const submissionId = randomUUID();
        const operation =
          modelConversation.agentKind === 'pi'
            ? await piNativeCoordinator.startConversation({
                conversationId,
                submissionId,
                projectId: resolved.project.id,
                taskId: resolved.task.id,
                taskTitle: resolved.task.title,
                conversationTitle: `冲突处理：${path}`,
                cwd: resolved.integration.integrationPath,
                prompt,
                model: { sourceId: modelConversation.modelSourceId, modelId, displayName: null },
                ...(settings?.effort ? { thinkingLevel: settings.effort } : {}),
                permissionMode: 'read-only',
                idempotencyKey: randomUUID(),
                clientUserMessageId: randomUUID(),
                workspaceId: resolved.workspace.id,
                ...(resolved.workspace.environmentId ? { environmentId: resolved.workspace.environmentId } : {}),
              })
            : await codexNativeCoordinator.startTaskConversation({
                conversationId,
                submissionId,
                projectId: resolved.project.id,
                projectLocalPath: resolved.integration.integrationPath,
                taskId: resolved.task.id,
                workspaceId: resolved.workspace.id,
                ...(resolved.workspace.environmentId ? { environmentId: resolved.workspace.environmentId } : {}),
                conversationTitle: `冲突处理：${path}`,
                taskTitle: resolved.task.title,
                prompt,
                model: modelId,
                ...(settings?.effort ? { effort: settings.effort } : {}),
                ...(settings && Object.prototype.hasOwnProperty.call(settings, 'serviceTier') ? { serviceTier: settings.serviceTier } : {}),
                allowCodeChanges: false,
                allowTests: false,
                allowGitCommit: false,
                permissionMode: 'read-only',
                applyLegacyTaskGuards: false,
                idempotencyKey: randomUUID(),
                clientUserMessageId: randomUUID(),
              });
        if (operation.status !== 'active' || !operation.providerTurnId) {
          throw nativeApiError('ZEUS_CONFLICT_AI_BUSY', '任务模型当前没有可用执行位，请稍后重试。');
        }
        const answer = await waitForTaskConflictAiAnswer(operation.conversationId, operation.providerTurnId, runtimeSettings.executionTimeoutSeconds * 1_000);
        const suggestions = parseTaskConflictAiAnswer(answer, blocks);
        return {
          path,
          agentKind: modelConversation.agentKind,
          modelSourceId: modelConversation.modelSourceId,
          modelId,
          conversationId: operation.conversationId,
          suggestions,
        };
      } catch (error) {
        return sendTaskGitApiError(reply, error);
      }
    },
  );

  server.put(
    '/api/tasks/:taskId/integrations/:integrationId/conflict',
    async (request: FastifyRequest<{ Params: { taskId: string; integrationId: string }; Querystring: { path?: string }; Body: ResolveTaskIntegrationConflictBody }>, reply) => {
      const resolved = resolveTaskIntegrationRequest(request.params.taskId, request.params.integrationId);
      if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
      if (!resolved.integration.integrationPath) return reply.code(409).send({ error: 'ZEUS_TASK_INTEGRATION_PATH_UNAVAILABLE', message: 'Integration worktree is unavailable.' });
      if (typeof request.body?.content !== 'string') return reply.code(400).send({ error: 'ZEUS_TASK_CONFLICT_CONTENT_REQUIRED', message: 'Resolved content is required.' });
      const path = request.query.path?.trim();
      if (!path) return reply.code(400).send({ error: 'ZEUS_GIT_PATH_REQUIRED', message: 'path is required' });
      try {
        await assertTaskIntegrationStillCurrent(resolved.project, resolved.workspace, resolved.integration);
        const result = await writeTaskIntegrationResolution(resolved.integration.integrationPath, path, request.body.content);
        const integration = taskIntegrations.update(resolved.integration.id, { conflictFiles: result.remainingConflictFiles, state: 'conflicted', lastError: null });
        await db.save();
        return { integration, result };
      } catch (error) {
        if (isStaleTaskIntegrationError(error)) {
          taskIntegrations.update(resolved.integration.id, {
            state: 'failed',
            lastError: error instanceof Error ? error.message : 'Task integration became stale.',
          });
          await db.save();
        }
        return sendTaskGitApiError(reply, error);
      }
    },
  );

  server.post('/api/tasks/:taskId/integrations/:integrationId/finalize', async (request: FastifyRequest<{ Params: { taskId: string; integrationId: string } }>, reply) => {
    const resolved = resolveTaskIntegrationRequest(request.params.taskId, request.params.integrationId);
    if ('error' in resolved) return reply.code(resolved.status).send(resolved.error);
    const { task, project, integration, workspace } = resolved;
    if (!integration.integrationPath) return reply.code(409).send({ error: 'ZEUS_TASK_INTEGRATION_PATH_UNAVAILABLE', message: 'Integration worktree is unavailable.' });
    try {
      await assertTaskIntegrationStillCurrent(project, workspace, integration);
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
        remoteName: workspace.remoteName,
      });
      const pendingLocalSync = !finalized.remoteName && finalized.localSyncStatus === 'pending';
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
          title: '合入结果等待同步到本地目标分支',
          payload: { integrationId: integration.id, workspaceId: workspace.id, targetBranch: integration.targetBranch, resultHeadSha: finalized.resultHeadSha },
        });
        await db.save();
        return reply.code(202).send({ integration: updated, result: finalized });
      }
      const taskWorktreeReclaimed = integration.targetBranch === workspace.sourceBranch ? await markTaskWorkspaceDelivered(workspace) : false;
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.git_integration.merged',
        title: integration.targetBranch === workspace.sourceBranch ? '任务分支已合入来源分支' : `任务分支已合入 ${integration.targetBranch}`,
        payload: {
          integrationId: integration.id,
          workspaceId: workspace.id,
          mode: integration.mode,
          sourceDelivered: integration.targetBranch === workspace.sourceBranch,
          taskWorktreeReclaimed,
          ...finalized,
        },
      });
      await db.save();
      return { integration: updated, result: finalized };
    } catch (error) {
      taskIntegrations.update(integration.id, {
        state: isStaleTaskIntegrationError(error) ? 'failed' : integration.conflictFiles.length > 0 ? 'conflicted' : 'failed',
        lastError: error instanceof Error ? error.message : 'Task integration finalization failed.',
      });
      await db.save();
      return sendTaskGitApiError(reply, error);
    }
  });

  server.post(
    '/api/projects/:projectId/git/snapshot',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: CreateProjectGitSnapshotBody;
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const taskId = request.body?.taskId;
      if (!taskId) {
        return reply.code(400).send({
          error: 'ZEUS_TASK_REQUIRED',
          message: 'taskId is required for project git snapshot',
        });
      }
      const task = tasks.getById(taskId);
      if (!task || task.projectId !== project.id) {
        return reply.code(404).send({
          error: 'ZEUS_TASK_NOT_FOUND',
          message: 'Task not found for this project',
        });
      }
      const gitScope = resolveProjectGitScope(project);
      if ('limitation' in gitScope) {
        return reply.code(409).send({ error: 'ZEUS_PROJECT_GIT_SCOPE_UNSUPPORTED', message: gitScope.limitation });
      }
      const diff = await readGitDiff(gitScope.path);
      publishGitDiffUpdatedEvent(diff, project.id);
      persistReadonlyGitDiffSnapshot({
        projectId: project.id,
        taskId: task.id,
        diff,
        graphRoot: project.localPath,
      });
      publishRealtimeEvent('git.snapshot.created', {
        projectId: project.id,
        taskId: task.id,
        snapshotType: 'readonly_diff',
        fileCount: diff.files.length,
      });
      await db.save();
      return reply.code(201).send({
        projectId: project.id,
        taskId: task.id,
        snapshotType: 'readonly_diff',
        isRepository: diff.isRepository,
        fileCount: diff.files.length,
        diffTextLength: diff.diffText.length,
      });
    },
  );

  server.post('/api/projects/:projectId/git/patch', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply): Promise<GitPatchExport | unknown> => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    // 项目级 patch 只导出 readonly diff，不执行任何 Git 写操作，避免绕过高风险确认流。
    const gitScope = resolveProjectGitScope(project);
    if ('limitation' in gitScope) {
      return reply.code(409).send({ error: 'ZEUS_PROJECT_GIT_SCOPE_UNSUPPORTED', message: gitScope.limitation });
    }
    const diff = await readGitDiff(gitScope.path);
    const patch = buildGitPatchExport(diff);
    appendAuditLog({
      actorType: 'local_api',
      action: 'git.patch.exported',
      resourceType: 'git_patch',
      resourceId: patch.fileName,
      payload: {
        projectId: project.id,
        fileCount: patch.files.length,
        patchTextLength: patch.patchText.length,
        readonly: true,
      },
      createdAt: patch.createdAt,
    });
    await db.save();
    return patch;
  });

  server.post('/api/projects', async (request: FastifyRequest<{ Body: CreateProjectBody }>, reply) => {
    const body = request.body;
    if (!body?.name || !body.localPath) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_PROJECT',
        message: 'Project name and localPath are required',
      });
    }
    const pathValidation = validateReadableProjectDirectory(body.localPath);
    if (!pathValidation.valid) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_PROJECT_PATH',
        message: pathValidation.message,
      });
    }
    const initialDefaults = normalizeProjectConfig(
      'pending-project',
      {
        defaultModel: body.defaultModel,
        defaultWorkMode: body.defaultWorkMode,
        defaultTaskPrompt: body.defaultTaskPrompt,
      },
      createDefaultProjectConfig('pending-project'),
    );
    if (!initialDefaults) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_PROJECT_CONFIG',
        message: 'Project defaults must use safe single-line values and supported work modes',
      });
    }
    const project = projects.create({
      name: body.name,
      localPath: pathValidation.localPath,
      description: body.description,
      note: body.note,
    });
    const detectedConfig = detectProjectConfigFromLocalFiles(project.id, project.localPath);
    const initialProjectConfig = normalizeProjectConfig(
      project.id,
      {
        defaultModel: body.defaultModel,
        defaultWorkMode: body.defaultWorkMode,
        defaultTaskPrompt: body.defaultTaskPrompt,
      },
      detectedConfig,
    );
    if (!initialProjectConfig) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_PROJECT_CONFIG',
        message: 'Project defaults must use safe single-line values and supported work modes',
      });
    }
    // 创建项目时写入用户选择的默认 AI 偏好，同时保留真实文件检测得到的语言和依赖配置。
    settings.setJson(projectConfigSettingsPrefix + project.id, initialProjectConfig);
    appShellSettings = {
      ...appShellSettings,
      taskManagementStatusByProject: {
        ...appShellSettings.taskManagementStatusByProject,
        [project.id]: cloneTaskManagementStatusConfig(appShellSettings.taskManagementStatusTemplate),
      },
    };
    settings.setJson(appShellSettingsKey, appShellSettings);
    appendAuditLog({
      actorType: 'local_api',
      action: 'project.config.detected',
      resourceType: 'project',
      resourceId: project.id,
      payload: {
        language: initialProjectConfig.language.primary,
        packageManagers: initialProjectConfig.dependencies.packageManagers,
        manifestPaths: initialProjectConfig.dependencies.manifestPaths,
        gitRoot: initialProjectConfig.vcs.gitRoot,
        defaultWorkMode: initialProjectConfig.defaultWorkMode,
      },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'project.created',
      resourceType: 'project',
      resourceId: project.id,
      payload: {
        projectId: project.id,
        name: project.name,
        localPath: project.localPath,
      },
    });
    publishRealtimeEvent('project.created', {
      projectId: project.id,
      name: project.name,
      localPath: project.localPath,
    });
    await db.save();
    return reply.code(201).send(project);
  });

  server.patch(
    '/api/projects/:projectId',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: UpdateProjectBody;
      }>,
      reply,
    ) => {
      const existing = projects.getById(request.params.projectId);
      if (!existing) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      let normalizedLocalPath: string | undefined;
      if (typeof request.body?.localPath === 'string' && request.body.localPath !== existing.localPath) {
        const pathValidation = validateReadableProjectDirectory(request.body.localPath);
        if (!pathValidation.valid) {
          return reply.code(400).send({
            error: 'ZEUS_INVALID_PROJECT_PATH',
            message: pathValidation.message,
          });
        }
        normalizedLocalPath = pathValidation.localPath;
      }
      const updated = projects.update(existing.id, {
        ...(request.body ?? {}),
        localPath: normalizedLocalPath,
      });
      await db.save();
      return updated;
    },
  );

  server.get('/api/projects/:projectId/workspace-config', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    return {
      projectId: project.id,
      containerPath: project.localPath,
      sharedWritablePaths: projectSharedPaths.listByProject(project.id),
    };
  });

  server.put('/api/projects/:projectId/workspace-config', async (request: FastifyRequest<{ Params: { projectId: string }; Body: UpdateProjectWorkspaceConfigBody }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    try {
      const sharedPaths = normalizeProjectMemberDirectories(project, request.body?.sharedWritablePaths, 'shared');
      assertProjectMemberPathsDoNotOverlap(
        sharedPaths.map((entry) => entry.localPath),
        'Shared writable paths cannot contain one another.',
      );
      const savedSharedPaths = projectSharedPaths.replaceForProject(
        project.id,
        sharedPaths.map((entry) => ({ projectId: project.id, relativePath: entry.relativePath, localPath: entry.localPath })),
      );
      appendAuditLog({
        actorType: 'local_api',
        action: 'project.workspace_config.updated',
        resourceType: 'project',
        resourceId: project.id,
        payload: {
          projectId: project.id,
          sharedWritablePaths: savedSharedPaths.map((entry) => entry.relativePath),
        },
      });
      await db.save();
      return { projectId: project.id, containerPath: project.localPath, sharedWritablePaths: savedSharedPaths };
    } catch (error) {
      return sendNativeConversationApiError(reply, error);
    }
  });

  server.delete('/api/projects/:projectId', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const existing = projects.getById(request.params.projectId);
    if (!existing) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    const deleted = projects.delete(existing.id);
    await db.save();
    return deleted;
  });

  server.post('/api/projects/:projectId/archive-confirmation', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const existing = projects.getById(request.params.projectId);
    if (!existing) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    return projects.prepareArchive(existing.id);
  });

  server.post('/api/projects/:projectId/archive', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const existing = projects.getById(request.params.projectId);
    if (!existing) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    const archived = projects.archive(existing.id);
    await db.save();
    return archived;
  });

  server.post('/api/projects/:projectId/restore', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const existing = projects.getById(request.params.projectId);
    if (!existing) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    const restored = projects.restore(existing.id);
    await db.save();
    return restored;
  });

  server.put(
    '/api/projects/:projectId/default-template',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: SetProjectDefaultTemplateBody;
      }>,
      reply,
    ) => {
      const existing = projects.getById(request.params.projectId);
      if (!existing) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const templateId = request.body?.templateId ?? null;
      if (templateId) {
        const template = taskTemplates.getById(templateId);
        if (!template || (template.projectId && template.projectId !== existing.id)) {
          return reply.code(404).send({
            error: 'ZEUS_TEMPLATE_NOT_FOUND',
            message: 'Task template not found for this project',
          });
        }
      }
      const updated = projects.setDefaultTemplate(existing.id, templateId);
      await db.save();
      return updated;
    },
  );

  server.post('/api/tasks', async (request: FastifyRequest<{ Body: CreateTaskBody }>, reply) => {
    const body = request.body;
    if (!body?.projectId || !body.title || !isTaskType(body.taskType)) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_TASK',
        message: 'projectId, title and taskType are required',
      });
    }
    if (
      [body.description, body.defectCurrentState, body.defectExpectedOutcome, body.defectReproductionSteps, body.optimizationCurrentState, body.optimizationExpectedOutcome].some((value) => value !== undefined && typeof value !== 'string')
    ) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_TASK_CONTENT',
        message: 'Task type content fields must be strings when provided',
      });
    }
    if (body.parentTaskId !== undefined && body.parentTaskId !== null && typeof body.parentTaskId !== 'string') {
      return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_PARENT', message: 'parentTaskId must be a string or null.' });
    }
    if ([body.allowCodeChanges, body.allowTests, body.allowGitCommit].some((value) => value !== undefined && typeof value !== 'boolean')) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_TASK_PERMISSIONS',
        message: 'allowCodeChanges, allowTests and allowGitCommit must be booleans when provided',
      });
    }
    if (body.priority !== undefined && !isTaskPriority(body.priority)) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_TASK_PRIORITY',
        message: 'priority must be one of p0, p1, p2, p3 or p4',
      });
    }
    let task: ZeusTaskRecord;
    try {
      task = tasks.create({
        projectId: body.projectId,
        managementStatus: resolveTaskManagementStatusConfigForProject(body.projectId).roles.defaultStatusId,
        parentTaskId: body.parentTaskId,
        title: body.title,
        taskType: body.taskType,
        description: body.description ?? '',
        defectCurrentState: body.defectCurrentState,
        defectExpectedOutcome: body.defectExpectedOutcome,
        defectReproductionSteps: body.defectReproductionSteps,
        optimizationCurrentState: body.optimizationCurrentState,
        optimizationExpectedOutcome: body.optimizationExpectedOutcome,
        createdFrom: 'user',
        sourceContext: body.sourceContext ?? {},
        tags: body.tags,
        priority: body.priority,
        allowCodeChanges: body.allowCodeChanges,
        allowTests: body.allowTests,
        allowGitCommit: body.allowGitCommit,
      });
    } catch (error) {
      const details = taskEditConflictDetails(error);
      if (details?.code === 'ZEUS_TASK_PARENT_NOT_FOUND') return reply.code(404).send({ error: details.code, message: 'Parent task not found.' });
      if (details?.code === 'ZEUS_TASK_RELATION_PROJECT_MISMATCH' || details?.code === 'ZEUS_TASK_HIERARCHY_DEPTH_EXCEEDED' || details?.code === 'ZEUS_TASK_PARENT_CYCLE') {
        return reply.code(409).send({ error: details.code, message: error instanceof Error ? error.message : 'Invalid parent task.' });
      }
      throw error;
    }
    recordTaskEvent({
      taskId: task.id,
      eventType: 'task.created',
      title: '任务已创建',
      payload: { status: task.status, managementStatus: task.managementStatus, taskType: task.taskType, priority: task.priority, source: task.createdFrom },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'task.created',
      resourceType: 'task',
      resourceId: task.id,
      payload: {
        taskId: task.id,
        projectId: task.projectId,
        title: task.title,
        taskType: task.taskType,
        status: task.status,
        priority: task.priority,
      },
    });
    publishRealtimeEvent('task.created', {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
      priority: task.priority,
    });
    await db.save();
    return reply.code(201).send(task);
  });

  server.patch(
    '/api/tasks/:taskId/status',
    async (
      request: FastifyRequest<{
        Params: { taskId: string };
        Body: UpdateTaskStatusBody;
      }>,
      reply,
    ) => {
      const existing = tasks.getById(request.params.taskId);
      if (!existing) {
        return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
      }
      let nextStatus: TaskStatus;
      try {
        nextStatus = getNextTaskStatus(existing.status, request.body.status);
      } catch (error) {
        return reply.code(409).send({
          error: 'ZEUS_INVALID_TASK_TRANSITION',
          message: error instanceof Error ? error.message : 'Invalid task transition',
        });
      }
      const updated = tasks.updateStatus(existing.id, nextStatus);
      recordTaskEvent({
        taskId: updated.id,
        eventType: 'task.status.changed',
        title: taskStatusEventTitle(nextStatus),
        payload: { from: existing.status, to: nextStatus },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'task.status.changed',
        resourceType: 'task',
        resourceId: updated.id,
        payload: {
          taskId: updated.id,
          projectId: updated.projectId,
          from: existing.status,
          to: nextStatus,
        },
      });
      publishTaskStatusChanged(updated, existing.status, nextStatus, 'task.status.patch');
      if (nextStatus === 'completed') {
        const writeback = writeTaskCompletionToGraphNode(db, updated);
        if (writeback) {
          recordTaskEvent({
            taskId: updated.id,
            eventType: 'graph.node.writeback',
            title: '任务结果已回写图谱节点',
            payload: writeback,
          });
        }
      }
      await notifyTelegramTaskStatus(updated, nextStatus);
      await db.save();
      return updated;
    },
  );

  server.patch(
    '/api/tasks/:taskId/management-status',
    async (
      request: FastifyRequest<{
        Params: { taskId: string };
        Body: UpdateTaskManagementStatusBody;
      }>,
      reply,
    ) => {
      const existing = tasks.getById(request.params.taskId);
      if (!existing) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
      const projectStatusConfig = resolveTaskManagementStatusConfigForProject(existing.projectId);
      if (!isConfiguredTaskManagementStatus(existing.projectId, request.body?.status)) {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_TASK_MANAGEMENT_STATUS',
          message: 'Unknown task management status',
        });
      }
      if (typeof request.body?.expectedUpdatedAt !== 'string' || !request.body.expectedUpdatedAt) {
        return reply.code(400).send({
          error: 'ZEUS_TASK_EDIT_VERSION_REQUIRED',
          message: 'expectedUpdatedAt is required when updating task management status.',
        });
      }
      if (request.body.confirmWorktreeCleanup !== undefined && typeof request.body.confirmWorktreeCleanup !== 'boolean') {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_TASK_WORKTREE_CLEANUP_CONFIRMATION',
          message: 'confirmWorktreeCleanup must be a boolean when provided.',
        });
      }
      if (existing.updatedAt !== request.body.expectedUpdatedAt) {
        return reply.code(409).send({
          error: 'ZEUS_TASK_EDIT_CONFLICT',
          message: 'Task changed after editing started.',
          currentUpdatedAt: existing.updatedAt,
        });
      }
      if (request.body.status === projectStatusConfig.roles.completedStatusId || request.body.status === projectStatusConfig.roles.cancelledStatusId) {
        const project = projects.getById(existing.projectId);
        if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
        const cleanup = await inspectTaskTerminalCleanup(existing.id, project.localPath);
        if (cleanup.requiresConfirmation && request.body.confirmWorktreeCleanup !== true) {
          return reply.code(409).send({
            error: 'ZEUS_TASK_WORKTREE_CLEANUP_CONFIRMATION_REQUIRED',
            message: 'Task worktrees contain local changes or active sessions. Confirm to stop and archive task sessions and permanently remove the worktrees.',
            targetStatus: request.body.status,
            dirtyWorkspaceCount: cleanup.workspaces.filter((entry) => entry.force).length,
            activeConversationCount: cleanup.activeConversationCount,
            activeRuntimeSessionCount: cleanup.activeRuntimeSessionCount,
          });
        }
        try {
          await closeTaskResourcesForTerminalStatus(existing.id, cleanup);
        } catch (error) {
          return sendTaskGitApiError(reply, error);
        }
      }
      let updated: ZeusTaskRecord;
      try {
        updated = tasks.updateManagementStatus(existing.id, request.body.status, request.body.expectedUpdatedAt);
      } catch (error) {
        const conflict = taskEditConflictDetails(error);
        if (conflict?.code === 'ZEUS_TASK_EDIT_CONFLICT') {
          return reply.code(409).send({
            error: conflict.code,
            message: 'Task changed after editing started.',
            currentUpdatedAt: conflict.currentUpdatedAt,
          });
        }
        throw error;
      }
      if (updated.managementStatus === existing.managementStatus) return updated;
      recordTaskEvent({
        taskId: updated.id,
        eventType: 'task.management_status.changed',
        title: '任务管理状态已变更',
        payload: { from: existing.managementStatus, to: updated.managementStatus },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'task.management_status.changed',
        resourceType: 'task',
        resourceId: updated.id,
        payload: {
          taskId: updated.id,
          projectId: updated.projectId,
          from: existing.managementStatus,
          to: updated.managementStatus,
        },
      });
      publishRealtimeEvent('task.updated', {
        taskId: updated.id,
        projectId: updated.projectId,
        managementStatus: updated.managementStatus,
        changedFields: ['managementStatus'],
        updatedAt: updated.updatedAt,
      });
      await db.save();
      return updated;
    },
  );

  server.get('/api/projects/:projectId/conversation-choices', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    const choices = listProjectConversationHistory(project.id).map(toNativeConversationChoice);
    return { projectId: project.id, choices, items: choices };
  });

  server.post(
    '/api/projects/:projectId/conversations',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: StartProjectConversationBody | Record<string, unknown>;
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return reply.code(400).send({ error: 'ZEUS_IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required.' });
      try {
        const accepted = await executeProjectConversationIdempotent(project, request.body ?? {}, idempotencyKey);
        return reply.code(accepted.statusCode).send(accepted.body);
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.get('/api/tasks/:taskId/conversation-choices', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    const project = projects.getById(task.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    const history = listTaskConversationHistory(task.id, project.id);
    const choices = history.map(toNativeConversationChoice);
    return {
      taskId: task.id,
      projectId: project.id,
      hasHistory: choices.length > 0,
      requiresChoice: choices.length > 0,
      choices,
      items: choices,
    };
  });

  server.get(
    '/api/projects/:projectId/codex-task-push-capabilities',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Querystring: { taskId?: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
      const taskId = request.query.taskId?.trim();
      if (!taskId) return reply.code(400).send({ error: 'ZEUS_TASK_ID_REQUIRED', message: 'taskId is required' });
      const task = tasks.getById(taskId);
      if (!task || task.projectId !== project.id)
        return reply.code(404).send({
          error: 'ZEUS_TASK_NOT_FOUND',
          message: 'Task not found',
        });
      try {
        return await resolveTaskPushCapabilities(project, task);
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.get(
    '/api/projects/:projectId/codex-conversation-capabilities',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
      try {
        return await resolveConversationCapabilities(project);
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.get('/api/codex/account', async (_request, reply) => {
    try {
      await codexAppServerManager.ensureReady({
        commandPath: currentCodexRuntimeCommandPath(),
        ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}),
      });
      return await codexAppServerManager.readAccount();
    } catch (error) {
      return sendNativeConversationApiError(reply, error);
    }
  });

  server.post('/api/codex/account/login/chatgpt', async (_request, reply) => {
    try {
      await codexAppServerManager.ensureReady({
        commandPath: currentCodexRuntimeCommandPath(),
        ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}),
      });
      return await codexAppServerManager.startChatGptLogin();
    } catch (error) {
      return sendNativeConversationApiError(reply, error);
    }
  });

  server.post(
    '/api/codex/account/login/:loginId/cancel',
    async (
      request: FastifyRequest<{
        Params: { loginId: string };
      }>,
      reply,
    ) => {
      try {
        await codexAppServerManager.ensureReady({
          commandPath: currentCodexRuntimeCommandPath(),
          ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}),
        });
        await codexAppServerManager.cancelChatGptLogin({ loginId: request.params.loginId });
        return { cancelled: true };
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post(
    '/api/tasks/:taskId/conversations',
    async (
      request: FastifyRequest<{
        Params: { taskId: string };
        Body: StartTaskConversationBody | Record<string, unknown>;
      }>,
      reply,
    ) => {
      const task = tasks.getById(request.params.taskId);
      if (!task) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
      const project = projects.getById(task.projectId);
      if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) {
        return reply.code(400).send({ error: 'ZEUS_IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required.' });
      }
      try {
        const accepted = await executeTaskConversationIdempotent(project, task, request.body ?? {}, idempotencyKey);
        return reply.code(accepted.statusCode).send(accepted.body);
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    },
  );

  server.post('/api/tasks/:taskId/run', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) {
      return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    }
    const project = projects.getById(task.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    if (runtimeSettings.defaultAdapterId === 'codex') {
      if (!codexNativeEnabled) {
        return reply.code(409).send({
          error: 'ZEUS_CODEX_NATIVE_DISABLED',
          message: 'Codex native conversation writes are disabled by ZEUS_CODEX_NATIVE_ENABLED.',
        });
      }
      if (listTaskConversationHistory(task.id, project.id).length > 0) {
        return reply.code(409).send({
          error: 'ZEUS_CONVERSATION_CHOICE_REQUIRED',
          message: 'This task already has conversation history. Choose an exact conversation to resume, reference legacy history, or explicitly create a new conversation.',
        });
      }
      try {
        const idempotencyKey = `legacy-run-${randomUUID()}`;
        const accepted = await executeTaskConversationIdempotent(project, task, { mode: 'create' }, idempotencyKey);
        if (accepted.body.submission.status === 'active') {
          moveTaskTowardRunning(task.id, 'task.runtime.run');
          await db.save();
        }
        return reply.code(accepted.statusCode).send(accepted.body);
      } catch (error) {
        return sendNativeConversationApiError(reply, error);
      }
    }
    try {
      const result = await startTaskRuntimeSession(project, task, 'task.runtime.run', '任务已通过本地 API 启动 Runtime');
      return reply.code('queued' in result ? 202 : 201).send(result);
    } catch (error) {
      return sendNativeConversationApiError(reply, error);
    }
  });

  server.post('/api/tasks/:taskId/pause', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) {
      return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    }
    stopRunningTaskRuntimeSessions(task.id);
    const paused = transitionTaskStatus(task, 'paused', 'task.runtime.pause');
    await db.save();
    return paused;
  });

  server.post('/api/tasks/:taskId/continue', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) {
      return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    }
    const project = projects.getById(task.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    if (runtimeSettings.defaultAdapterId === 'codex') {
      if (!codexNativeEnabled) {
        return reply.code(409).send({
          error: 'ZEUS_CODEX_NATIVE_DISABLED',
          message: 'Codex native conversation writes are disabled by ZEUS_CODEX_NATIVE_ENABLED.',
        });
      }
      return reply.code(409).send({
        error: 'ZEUS_CONVERSATION_CHOICE_REQUIRED',
        message: 'Codex continue requires an explicitly selected native conversation. Use POST /api/tasks/:taskId/conversations with mode resume.',
      });
    }
    try {
      const result = await startTaskRuntimeSession(project, task, 'task.runtime.continue', '任务已通过本地 API 继续 Runtime', '继续执行该任务，优先复用已有上下文并说明新的真实依据。');
      return reply.code('queued' in result ? 202 : 201).send(result);
    } catch (error) {
      return sendNativeConversationApiError(reply, error);
    }
  });

  server.post('/api/tasks/:taskId/cancel', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) {
      return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    }
    stopRunningTaskRuntimeSessions(task.id);
    const cancelled = transitionTaskStatus(task, 'cancelled', 'task.runtime.cancel');
    await db.save();
    return cancelled;
  });

  server.post('/api/tasks/:taskId/retry', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) {
      return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    }
    const retried = transitionTaskStatus(task, 'ready', 'task.runtime.retry');
    await db.save();
    return retried;
  });

  server.post('/api/tasks/:taskId/archive', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const existing = tasks.getById(request.params.taskId);
    if (!existing) {
      return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    }
    const archived = tasks.archive(existing.id);
    recordTaskEvent({
      taskId: archived.id,
      eventType: 'task.archived',
      title: '任务已归档',
      payload: { status: archived.status, archived: true },
    });
    await db.save();
    return archived;
  });

  server.post('/api/tasks/:taskId/restore', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const existing = tasks.getById(request.params.taskId);
    if (!existing) {
      return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    }
    const restored = tasks.restore(existing.id);
    recordTaskEvent({
      taskId: restored.id,
      eventType: 'task.restored',
      title: '任务已恢复',
      payload: { status: restored.status, archived: false },
    });
    await db.save();
    return restored;
  });

  server.get('/api/tasks/:taskId', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = tasks.getById(request.params.taskId);
    if (!task) {
      return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    }
    return task;
  });

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
    const gitScope = resolveProjectGitScope(project);
    if ('limitation' in gitScope) {
      return reply.code(409).send({ error: 'ZEUS_PROJECT_GIT_SCOPE_UNSUPPORTED', message: gitScope.limitation });
    }
    const diff = await readGitDiff(gitScope.path);
    publishGitDiffUpdatedEvent(diff, project.id);
    persistReadonlyGitDiffSnapshot({
      projectId: project.id,
      taskId: task.id,
      diff,
      graphRoot: project.localPath,
    });
    publishRealtimeEvent('git.snapshot.created', {
      projectId: project.id,
      taskId: task.id,
      snapshotType: 'readonly_diff',
      fileCount: diff.files.length,
    });
    await db.save();
    return diff;
  });

  server.patch(
    '/api/tasks/:taskId',
    async (
      request: FastifyRequest<{
        Params: { taskId: string };
        Body: UpdateTaskBody;
      }>,
      reply,
    ) => {
      const existing = tasks.getById(request.params.taskId);
      if (!existing) {
        return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
      }
      const body = request.body ?? {};
      if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) {
        return reply.code(400).send({ error: 'ZEUS_TASK_EDIT_VERSION_REQUIRED', message: 'expectedUpdatedAt is required when updating a task.' });
      }
      if (body.title !== undefined && typeof body.title !== 'string') {
        return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_TITLE', message: 'Task title must be a string.' });
      }
      if (typeof body.title === 'string' && !body.title.trim()) {
        return reply.code(400).send({ error: 'ZEUS_TASK_TITLE_REQUIRED', message: 'Task title is required.' });
      }
      if (body.taskType !== undefined && !isTaskType(body.taskType)) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_TYPE', message: 'Task type must be requirement, defect or optimization.' });
      }
      if (body.description !== undefined && typeof body.description !== 'string') {
        return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_DESCRIPTION', message: 'Task description must be a string.' });
      }
      if ([body.defectCurrentState, body.defectExpectedOutcome, body.defectReproductionSteps, body.optimizationCurrentState, body.optimizationExpectedOutcome].some((value) => value !== undefined && typeof value !== 'string')) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_CONTENT', message: 'Task type content fields must be strings when provided.' });
      }
      if (body.priority !== undefined && !isTaskPriority(body.priority)) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_PRIORITY', message: 'Task priority must be one of p0, p1, p2, p3 or p4.' });
      }
      if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === 'string'))) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_TAGS', message: 'Task tags must be an array of strings.' });
      }
      const attachments = body.attachments === undefined ? undefined : normalizeTaskAttachmentReferences(body.attachments);
      if (attachments === null) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_ATTACHMENTS', message: 'Task attachments must contain at most 24 valid attachment references.' });
      }
      if (body.sourceContext !== undefined && (!body.sourceContext || typeof body.sourceContext !== 'object' || Array.isArray(body.sourceContext))) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_SOURCE_CONTEXT', message: 'Task source context must be an object.' });
      }
      if (body.sourceContext !== undefined && attachments !== undefined) {
        return reply.code(400).send({ error: 'ZEUS_AMBIGUOUS_TASK_CONTEXT_UPDATE', message: 'sourceContext and attachments cannot be updated in the same request.' });
      }
      if ([body.allowCodeChanges, body.allowTests, body.allowGitCommit].some((value) => value !== undefined && typeof value !== 'boolean')) {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_TASK_PERMISSIONS',
          message: 'allowCodeChanges, allowTests and allowGitCommit must be booleans when provided',
        });
      }
      let result: ReturnType<TaskRepository['updateContent']>;
      try {
        result = tasks.updateContent(existing.id, {
          expectedUpdatedAt: body.expectedUpdatedAt,
          title: body.title,
          taskType: body.taskType,
          description: body.description,
          defectCurrentState: body.defectCurrentState,
          defectExpectedOutcome: body.defectExpectedOutcome,
          defectReproductionSteps: body.defectReproductionSteps,
          optimizationCurrentState: body.optimizationCurrentState,
          optimizationExpectedOutcome: body.optimizationExpectedOutcome,
          priority: body.priority,
          tags: body.tags,
          attachments,
          sourceContext: body.sourceContext,
          allowCodeChanges: body.allowCodeChanges,
          allowTests: body.allowTests,
          allowGitCommit: body.allowGitCommit,
        });
      } catch (error) {
        const details = taskEditConflictDetails(error);
        if (details?.code === 'ZEUS_TASK_EDIT_CONFLICT') {
          return reply.code(409).send({
            error: details.code,
            message: 'Task changed after editing started.',
            currentUpdatedAt: details.currentUpdatedAt,
          });
        }
        if (details?.code === 'ZEUS_TASK_TITLE_REQUIRED') {
          return reply.code(400).send({ error: details.code, message: 'Task title is required.' });
        }
        throw error;
      }
      if (result.changedFields.length === 0) return result.task;
      const updated = result.task;
      recordTaskEvent({
        taskId: updated.id,
        eventType: 'task.updated',
        title: '任务内容已更新',
        payload: {
          changedFields: result.changedFields,
          tagCount: { before: result.tagCountBefore, after: result.tagCountAfter },
          attachmentCount: { before: result.attachmentCountBefore, after: result.attachmentCountAfter },
          previousUpdatedAt: result.previousUpdatedAt,
          updatedAt: updated.updatedAt,
        },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'task.updated',
        resourceType: 'task',
        resourceId: updated.id,
        payload: {
          taskId: updated.id,
          projectId: updated.projectId,
          changedFields: result.changedFields,
          tagCountBefore: result.tagCountBefore,
          tagCountAfter: result.tagCountAfter,
          attachmentCountBefore: result.attachmentCountBefore,
          attachmentCountAfter: result.attachmentCountAfter,
        },
      });
      publishRealtimeEvent('task.updated', {
        taskId: updated.id,
        projectId: updated.projectId,
        changedFields: result.changedFields,
        updatedAt: updated.updatedAt,
      });
      await db.save();
      return updated;
    },
  );

  server.put(
    '/api/tasks/:taskId/tags',
    async (
      request: FastifyRequest<{
        Params: { taskId: string };
        Body: UpdateTaskTagsBody;
      }>,
      reply,
    ) => {
      const existing = tasks.getById(request.params.taskId);
      if (!existing) {
        return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
      }
      if (typeof request.body?.expectedUpdatedAt !== 'string' || !request.body.expectedUpdatedAt) {
        return reply.code(400).send({ error: 'ZEUS_TASK_EDIT_VERSION_REQUIRED', message: 'expectedUpdatedAt is required when updating task tags.' });
      }
      if (!Array.isArray(request.body?.tags) || !request.body.tags.every((tag) => typeof tag === 'string')) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_TAGS', message: 'Task tags must be an array of strings.' });
      }
      let result: ReturnType<TaskRepository['updateContent']>;
      try {
        result = tasks.updateContent(existing.id, { expectedUpdatedAt: request.body.expectedUpdatedAt, tags: request.body.tags });
      } catch (error) {
        const conflict = taskEditConflictDetails(error);
        if (conflict?.code === 'ZEUS_TASK_EDIT_CONFLICT') {
          return reply.code(409).send({ error: conflict.code, message: 'Task changed after editing started.', currentUpdatedAt: conflict.currentUpdatedAt });
        }
        throw error;
      }
      if (result.changedFields.length === 0) return result.task;
      const updated = result.task;
      recordTaskEvent({
        taskId: updated.id,
        eventType: 'task.tags.updated',
        title: '任务标签已更新',
        payload: { changedFields: ['tags'], tagCount: { before: result.tagCountBefore, after: result.tagCountAfter }, previousUpdatedAt: result.previousUpdatedAt, updatedAt: updated.updatedAt },
      });
      publishRealtimeEvent('task.updated', { taskId: updated.id, projectId: updated.projectId, changedFields: ['tags'], updatedAt: updated.updatedAt });
      await db.save();
      return updated;
    },
  );

  server.patch(
    '/api/tasks/:taskId/relationships',
    async (
      request: FastifyRequest<{
        Params: { taskId: string };
        Body: UpdateTaskRelationshipsBody;
      }>,
      reply,
    ) => {
      const existing = tasks.getById(request.params.taskId);
      if (!existing) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
      const body = request.body ?? {};
      if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) {
        return reply.code(400).send({ error: 'ZEUS_TASK_EDIT_VERSION_REQUIRED', message: 'expectedUpdatedAt is required when updating task relationships.' });
      }
      if (body.parentTaskId !== undefined && body.parentTaskId !== null && typeof body.parentTaskId !== 'string') {
        return reply.code(400).send({ error: 'ZEUS_INVALID_TASK_PARENT', message: 'parentTaskId must be a string or null.' });
      }
      if (body.relatedTaskIds !== undefined && (!Array.isArray(body.relatedTaskIds) || !body.relatedTaskIds.every((taskId) => typeof taskId === 'string'))) {
        return reply.code(400).send({ error: 'ZEUS_INVALID_RELATED_TASKS', message: 'relatedTaskIds must be an array of task ids.' });
      }
      let updated: ZeusTaskRecord;
      try {
        updated = tasks.updateRelationships(existing.id, {
          expectedUpdatedAt: body.expectedUpdatedAt,
          parentTaskId: body.parentTaskId,
          relatedTaskIds: body.relatedTaskIds,
        });
      } catch (error) {
        const details = taskEditConflictDetails(error);
        if (details?.code === 'ZEUS_TASK_EDIT_CONFLICT') {
          return reply.code(409).send({ error: details.code, message: 'Task changed after editing started.', currentUpdatedAt: details.currentUpdatedAt });
        }
        if (details?.code === 'ZEUS_TASK_PARENT_NOT_FOUND' || details?.code === 'ZEUS_TASK_RELATED_NOT_FOUND') {
          return reply.code(404).send({ error: details.code, message: error instanceof Error ? error.message : 'Related task not found.' });
        }
        if (details?.code?.startsWith('ZEUS_TASK_')) {
          return reply.code(409).send({ error: details.code, message: error instanceof Error ? error.message : 'Invalid task relationship.' });
        }
        throw error;
      }
      if (updated.updatedAt === existing.updatedAt) return updated;
      recordTaskEvent({
        taskId: updated.id,
        eventType: 'task.relationships.updated',
        title: '任务关系已更新',
        payload: {
          parentTaskId: { before: existing.parentTaskId, after: updated.parentTaskId },
          relatedTaskIds: { before: existing.relatedTaskIds, after: updated.relatedTaskIds },
        },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'task.relationships.updated',
        resourceType: 'task',
        resourceId: updated.id,
        payload: { taskId: updated.id, projectId: updated.projectId, parentTaskId: updated.parentTaskId, relatedTaskIds: updated.relatedTaskIds },
      });
      publishRealtimeEvent('task.updated', { taskId: updated.id, projectId: updated.projectId, changedFields: ['relationships'], updatedAt: updated.updatedAt });
      await db.save();
      return updated;
    },
  );

  server.delete('/api/tasks/:taskId', async (request: FastifyRequest<{ Params: { taskId: string }; Body: DeleteTaskBody }>, reply) => {
    const existing = tasks.getById(request.params.taskId);
    if (!existing) {
      return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    }
    if (request.body?.childStrategy !== undefined && !['reparent', 'delete_descendants', 'make_roots'].includes(request.body.childStrategy)) {
      return reply.code(400).send({ error: 'ZEUS_TASK_DELETE_STRATEGY_INVALID', message: 'Unknown child handling strategy.' });
    }
    let deleted: ReturnType<TaskRepository['delete']>;
    try {
      deleted = tasks.delete(existing.id, request.body ?? {});
    } catch (error) {
      const details = taskEditConflictDetails(error);
      if (details?.code === 'ZEUS_TASK_DELETE_RELATIONSHIP_CONFIRMATION_REQUIRED') {
        const candidate = error as Error & { childCount?: number; descendantCount?: number };
        return reply.code(409).send({
          error: details.code,
          message: 'Choose how to handle this task’s children before deleting it.',
          childCount: candidate.childCount ?? 0,
          descendantCount: candidate.descendantCount ?? 0,
        });
      }
      if (details?.code === 'ZEUS_TASK_PARENT_NOT_FOUND') return reply.code(404).send({ error: details.code, message: error instanceof Error ? error.message : 'Replacement parent task not found.' });
      if (details?.code?.startsWith('ZEUS_TASK_')) return reply.code(409).send({ error: details.code, message: error instanceof Error ? error.message : 'Unable to delete task.' });
      throw error;
    }
    recordTaskEvent({
      taskId: deleted.task.id,
      eventType: 'task.deleted',
      title: '任务已删除',
      payload: { softDeleted: true, deletedTaskIds: deleted.deletedTaskIds, movedChildTaskIds: deleted.movedChildTaskIds, childStrategy: request.body?.childStrategy ?? null },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'task.deleted',
      resourceType: 'task',
      resourceId: deleted.task.id,
      payload: { taskId: deleted.task.id, projectId: deleted.task.projectId, deletedTaskIds: deleted.deletedTaskIds, movedChildTaskIds: deleted.movedChildTaskIds },
    });
    await db.save();
    return deleted;
  });

  server.get('/api/tasks/:taskId/events', async (request: FastifyRequest<{ Params: { taskId: string } }>) => taskEvents.listByTask(request.params.taskId));

  server.get('/api/tasks', async (request: FastifyRequest<{ Querystring: ListTasksQuery }>, reply) => {
    const projectId = request.query.projectId;
    if (!projectId) {
      return reply.code(400).send({
        error: 'ZEUS_PROJECT_REQUIRED',
        message: 'projectId is required',
      });
    }
    return tasks.listByProject(projectId, {
      query: request.query.query,
      status: request.query.status,
      managementStatus: request.query.managementStatus,
      tag: request.query.tag,
      sortBy: request.query.sortBy,
      sortDirection: request.query.sortDirection,
    });
  });

  server.get('/api/tasks/archived', async (request: FastifyRequest<{ Querystring: { projectId?: string } }>, reply) => {
    const projectId = request.query.projectId;
    if (!projectId) {
      return reply.code(400).send({
        error: 'ZEUS_PROJECT_REQUIRED',
        message: 'projectId is required',
      });
    }
    return tasks.listArchivedByProject(projectId);
  });

  server.get('/api/task-templates', async (request: FastifyRequest<{ Querystring: { projectId?: string } }>) => {
    const projectId = request.query.projectId;
    return projectId ? taskTemplates.listForProject(projectId) : taskTemplates.listAll();
  });

  server.post('/api/task-templates', async (request: FastifyRequest<{ Body: CreateTaskTemplateBody }>, reply) => {
    const body = request.body;
    if (!body?.name || !body.description || !body.promptTemplate) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_TEMPLATE',
        message: 'name, description and promptTemplate are required',
      });
    }
    if (body.projectId && !projects.getById(body.projectId)) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    const template = taskTemplates.createCustom({
      projectId: body.projectId,
      name: body.name,
      description: body.description,
      promptTemplate: body.promptTemplate,
      category: body.category,
      defaultOptions: body.defaultOptions,
    });
    await db.save();
    return reply.code(201).send(template);
  });

  server.post(
    '/api/task-templates/:templateId/tasks',
    async (
      request: FastifyRequest<{
        Params: { templateId: string };
        Body: CreateTaskFromTemplateBody;
      }>,
      reply,
    ) => {
      const body = request.body;
      if (!body?.projectId) {
        return reply.code(400).send({
          error: 'ZEUS_PROJECT_REQUIRED',
          message: 'projectId is required',
        });
      }
      const project = projects.getById(body.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const template = taskTemplates.getById(request.params.templateId);
      if (!template || (template.projectId && template.projectId !== project.id)) {
        return reply.code(404).send({
          error: 'ZEUS_TEMPLATE_NOT_FOUND',
          message: 'Task template not found for this project',
        });
      }
      const task = tasks.createFromTemplate({
        projectId: project.id,
        managementStatus: resolveTaskManagementStatusConfigForProject(project.id).roles.defaultStatusId,
        template,
        title: body.title,
        variables: body.variables,
      });
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.created.from_template',
        title: '任务从模板创建',
        payload: {
          templateId: template.id,
          templateName: template.name,
          builtIn: template.builtIn,
        },
      });
      await db.save();
      return reply.code(201).send(task);
    },
  );

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/tasks',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
        Body: CreateTaskFromGraphConversationBody;
      }>,
      reply,
    ) => {
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
      const userMessage = conversation.messages.find((message) => message.role === 'user');
      const assistantMessage = [...conversation.messages].reverse().find((message) => message.role === 'assistant');
      if (!userMessage || !assistantMessage) {
        return reply.code(409).send({
          error: 'ZEUS_CONVERSATION_INCOMPLETE',
          message: 'Conversation does not contain both question and answer messages',
        });
      }
      const assistantMetadata = parseJsonObject(assistantMessage.metadataJson);
      const sourceNodeIds = Array.isArray(assistantMetadata.sourceNodeIds) ? assistantMetadata.sourceNodeIds.filter((item): item is string => typeof item === 'string') : [];
      const sourceEdgeIds = Array.isArray(assistantMetadata.sourceEdgeIds) ? assistantMetadata.sourceEdgeIds.filter((item): item is string => typeof item === 'string') : [];
      const sourceNodes = sourceNodeIds.map((nodeId) => readCurrentGraphNodeByIdForProject(nodeId, project)?.node).filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
      const sourceEdges = sourceEdgeIds.map((edgeId) => readCurrentGraphEdgeDetail(edgeId)).filter((edge): edge is GraphEdgeDetail => Boolean(edge));
      const suggestedTestScope = Array.from(new Set([...sourceNodes.map((node) => node.sourceRef), ...sourceEdges.map((edge) => edge.sourceRef)].filter(Boolean)));
      const questionSummary = userMessage.content.slice(0, 48);
      const task = tasks.create({
        projectId: project.id,
        managementStatus: resolveTaskManagementStatusConfigForProject(project.id).roles.defaultStatusId,
        title: `跟进图谱问答：${questionSummary}`,
        taskType: 'requirement',
        description: [
          request.body?.intent ?? '基于这次图谱问答创建可执行跟进任务。',
          `问题：${userMessage.content}`,
          `回答摘要：${assistantMessage.content.slice(0, 500)}`,
          suggestedTestScope.length > 0 ? `建议验证范围：${suggestedTestScope.join(', ')}` : '建议验证范围：等待更多图谱来源',
        ].join('\n'),
        createdFrom: 'graph_question',
        sourceContext: {
          graphQuestion: {
            conversationId: conversation.id,
            question: userMessage.content,
            answer: assistantMessage.content,
            sourceNodeIds,
            sourceEdgeIds,
          },
          sourceNodes,
          sourceEdges,
          suggestedTestScope,
          riskHints: ['核对 AI 回答来源节点是否仍与当前代码一致', '优先补充来源文件相关验收', '若图谱来源不足，先重新扫描真实代码库'],
        },
        tags: ['graph-question'],
      });
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.created.from_graph_question',
        title: '任务从图谱问答创建',
        payload: {
          conversationId: conversation.id,
          sourceNodeIds,
          sourceEdgeIds,
        },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'graph.conversation.task.created',
        resourceType: 'task',
        resourceId: task.id,
        payload: {
          projectId: project.id,
          conversationId: conversation.id,
          sourceNodeCount: sourceNodeIds.length,
          sourceEdgeCount: sourceEdgeIds.length,
        },
      });
      await db.save();
      return reply.code(201).send(task);
    },
  );

  server.post(
    '/api/graph/nodes/:nodeId/tasks',
    async (
      request: FastifyRequest<{
        Params: { nodeId: string };
        Body: CreateTaskFromGraphNodeBody;
      }>,
      reply,
    ) => {
      const body = request.body;
      if (!body?.projectId) {
        return reply.code(400).send({
          error: 'ZEUS_PROJECT_REQUIRED',
          message: 'projectId is required',
        });
      }
      const project = projects.getById(body.projectId);
      const task = project ? createTaskFromGraphNodeForProject(project, request.params.nodeId, body.intent) : createTaskFromGraphNode(body.projectId, request.params.nodeId, body.intent);
      if (!task) {
        return reply.code(404).send({
          error: 'ZEUS_GRAPH_NODE_NOT_FOUND',
          message: 'Graph node not found. Scan the project first.',
        });
      }
      await db.save();
      return reply.code(201).send(task);
    },
  );

  server.post(
    '/api/projects/:projectId/graph/nodes/:nodeId/create-task',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; nodeId: string };
        Body: CreateProjectGraphTaskBody;
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const task = createTaskFromGraphNodeForProject(project, request.params.nodeId, request.body?.intent);
      if (!task) {
        return reply.code(404).send({
          error: 'ZEUS_GRAPH_NODE_NOT_FOUND',
          message: 'Graph node not found. Scan the project first.',
        });
      }
      await db.save();
      return reply.code(201).send(task);
    },
  );

  server.post(
    '/api/projects/:projectId/graph/views/:viewId/create-task',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; viewId: string };
        Body: CreateProjectGraphTaskBody;
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const view = readCurrentGraphViewForProject(request.params.viewId, project)?.view;
      if (!view) {
        return reply.code(404).send({
          error: 'ZEUS_GRAPH_VIEW_NOT_FOUND',
          message: 'Graph view not found. Scan the project first.',
        });
      }
      const sourceNodes = view.nodes.slice(0, 20);
      const sourceEdges = view.edges.slice(0, 40);
      const task = tasks.create({
        projectId: project.id,
        managementStatus: resolveTaskManagementStatusConfigForProject(project.id).roles.defaultStatusId,
        title: `分析图谱视图：${view.title}`,
        taskType: 'requirement',
        description: [request.body?.intent ?? '基于当前代码图谱视图分析架构风险、影响范围和建议验收范围。', `视图类型：${view.viewType}`, `节点数：${view.nodes.length}`, `边数：${view.edges.length}`].join('\n'),
        createdFrom: 'graph_view',
        sourceContext: {
          graphView: {
            id: view.id,
            title: view.title,
            viewType: view.viewType,
            nodeCount: view.nodes.length,
            edgeCount: view.edges.length,
          },
          sourceNodes,
          sourceEdges,
          suggestedTestScope: Array.from(new Set(sourceNodes.map((node) => node.sourceRef).filter(Boolean))),
          riskHints: ['按视图节点逐项核对影响面', '优先补齐来源文件验收', '如果视图过大，先缩小到关键节点再执行'],
        },
      });
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.created.from_graph_view',
        title: '任务从图谱视图创建',
        payload: {
          viewId: view.id,
          viewType: view.viewType,
          nodeCount: view.nodes.length,
          edgeCount: view.edges.length,
        },
      });
      await db.save();
      return reply.code(201).send(task);
    },
  );

  server.post(
    '/api/tasks/:taskId/link-graph-node',
    async (
      request: FastifyRequest<{
        Params: { taskId: string };
        Body: LinkGraphNodeBody;
      }>,
      reply,
    ) => {
      const task = tasks.getById(request.params.taskId);
      if (!task) {
        return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
      }
      const nodeId = request.body?.nodeId;
      if (!nodeId) {
        return reply.code(400).send({
          error: 'ZEUS_GRAPH_NODE_REQUIRED',
          message: 'nodeId is required',
        });
      }
      const project = projects.getById(task.projectId);
      const node = project ? readCurrentGraphNodeByIdForProject(nodeId, project)?.node : readCurrentGraphNodeById(nodeId);
      if (!node) {
        return reply.code(404).send({
          error: 'ZEUS_GRAPH_NODE_NOT_FOUND',
          message: 'Graph node not found. Scan the project first.',
        });
      }
      const sourceContext = parseTaskSourceContext(task);
      const existingLinks = Array.isArray(sourceContext.linkedGraphNodes) ? sourceContext.linkedGraphNodes.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
      const linkedGraphNodes = [
        ...existingLinks.filter((item) => item.id !== node.id),
        {
          id: node.id,
          name: node.name,
          nodeType: node.nodeType,
          sourceRef: node.sourceRef,
          reason: request.body?.reason ?? '手动关联图谱节点',
        },
      ];
      // link-graph-node 只补充任务来源上下文，不改变任务状态，避免误触发运行或完成流转。
      const updated = tasks.updateSourceContext(task.id, {
        ...sourceContext,
        linkedGraphNodes,
        suggestedTestScope: Array.from(new Set([...(Array.isArray(sourceContext.suggestedTestScope) ? sourceContext.suggestedTestScope.filter((item): item is string => typeof item === 'string') : []), node.sourceRef])),
      });
      recordTaskEvent({
        taskId: updated.id,
        eventType: 'task.linked_graph_node',
        title: '任务关联图谱节点',
        payload: {
          nodeId: node.id,
          sourceRef: node.sourceRef,
          reason: request.body?.reason ?? null,
        },
      });
      await db.save();
      return updated;
    },
  );

  server.get('/api/graph/edges/:edgeId', async (request: FastifyRequest<{ Params: { edgeId: string } }>, reply) => {
    const detail = readCurrentGraphEdgeDetail(request.params.edgeId);
    if (!detail) {
      return reply.code(404).send({
        error: 'ZEUS_GRAPH_EDGE_NOT_FOUND',
        message: 'Graph edge not found. Scan the project first.',
      });
    }
    return detail;
  });

  server.get(
    '/api/graph/nodes/:nodeId/neighborhood',
    async (
      request: FastifyRequest<{
        Params: { nodeId: string };
        Querystring: { depth?: string };
      }>,
      reply,
    ) => {
      const depth = Math.max(1, Math.min(2, Number(request.query.depth ?? '1') || 1));
      const neighborhood = readCurrentGraphNeighborhood(request.params.nodeId, depth);
      if (!neighborhood) {
        return reply.code(404).send({
          error: 'ZEUS_GRAPH_NODE_NOT_FOUND',
          message: 'Graph node not found. Scan the project first.',
        });
      }
      return neighborhood;
    },
  );

  server.get(
    '/api/graph/search',
    async (
      request: FastifyRequest<{
        Querystring: {
          query?: string;
          nodeType?: string;
          edgeType?: string;
          minConfidence?: string;
        };
      }>,
    ): Promise<GraphSearchResult> => {
      return searchCurrentGraphNodes(request.query.query ?? '', request.query.nodeType, request.query.edgeType, request.query.minConfidence);
    },
  );

  server.get(
    '/api/projects/:projectId/graph/search',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Querystring: {
          query?: string;
          nodeType?: string;
          edgeType?: string;
          minConfidence?: string;
        };
      }>,
      reply,
    ): Promise<GraphSearchResult | unknown> => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      // 项目级搜索必须绑定到当前项目图谱；仅对当前仓库兼容旧的全局扫描缓存，避免其他项目误读 Zeus 图谱。
      const graphProjectName = resolveGraphProjectName(project);
      return searchCurrentGraphNodes(request.query.query ?? '', request.query.nodeType, request.query.edgeType, request.query.minConfidence, graphProjectName);
    },
  );

  server.get('/api/projects/:projectId/graph/views', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    const graphProjectName = resolveGraphProjectName(project);
    const viewTypes = ['architecture', 'module', 'table', 'module_detail', 'api_sequence', 'module_flow', 'method_logic'];
    const views = viewTypes
      .map((viewType) => readCurrentGraphView(viewType, graphProjectName))
      .filter((view): view is GraphViewSnapshot => Boolean(view))
      .map((view) => ({
        id: view.id,
        title: formatProjectScopedGraphViewTitle(view, project.name),
        viewType: view.viewType,
        nodeCount: view.nodes.length,
        edgeCount: view.edges.length,
      }));
    return { projectId: project.id, views };
  });

  server.post('/api/projects/:projectId/graph/views/generate', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    if (activeProjectGraphScanIds.has(project.id)) {
      return reply.code(409).send({
        error: 'ZEUS_GRAPH_SCAN_ALREADY_RUNNING',
        message: 'Graph scan is already running for this project.',
      });
    }
    activeProjectGraphScanIds.add(project.id);
    projects.updateScanStatus(project.id, 'scanning');
    await db.save();
    try {
      const result = await runCodeMapScan({
        projectName: project.name,
        graphProjectName: resolveGraphProjectName(project),
        rootPath: project.localPath,
        projectConfig: readProjectConfig(project.id),
      });
      projects.updateScanStatus(project.id, 'completed');
      await db.save();
      return result;
    } catch (error) {
      projects.updateScanStatus(project.id, 'failed');
      await db.save();
      return reply.code(isUnsafeCodeMapScanRootError(error) ? 400 : 500).send({
        error: isUnsafeCodeMapScanRootError(error) ? 'ZEUS_UNSAFE_GRAPH_SCAN_ROOT' : 'ZEUS_GRAPH_SCAN_FAILED',
        message: error instanceof Error ? error.message : 'Graph view generation failed',
      });
    } finally {
      activeProjectGraphScanIds.delete(project.id);
    }
  });

  server.get(
    '/api/projects/:projectId/graph/views/:viewId',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; viewId: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      // 设计书称 viewId；当前图谱事实层以 viewType 作为稳定 id 使用。
      const viewReadStartedAt = Date.now();
      const graphProjectName = resolveGraphProjectName(project);
      const view = readCurrentGraphView(request.params.viewId, graphProjectName);
      if (!view) {
        return reply.code(404).send({
          error: 'ZEUS_GRAPH_VIEW_NOT_FOUND',
          message: 'Graph view not found. Scan the project first.',
        });
      }
      const measuredView = attachGraphViewPerformance(view, viewReadStartedAt);
      const projectScopedTitle = formatProjectScopedGraphViewTitle(measuredView, project.name);
      publishRealtimeEvent('graph.view.generated', {
        projectId: project.id,
        viewType: view.viewType,
        title: projectScopedTitle,
        nodeCount: view.nodes.length,
        edgeCount: view.edges.length,
        performance: measuredView.performance,
      });
      return { ...measuredView, title: projectScopedTitle, projectId: project.id, projectName: project.name };
    },
  );

  server.get(
    '/api/projects/:projectId/graph/nodes/:nodeId',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; nodeId: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const graphProjectName = resolveGraphProjectName(project);
      const node = readCurrentGraphNodeById(request.params.nodeId, graphProjectName);
      if (!node) {
        return reply.code(404).send({
          error: 'ZEUS_GRAPH_NODE_NOT_FOUND',
          message: 'Graph node not found. Scan the project first.',
        });
      }
      return node;
    },
  );

  server.get(
    '/api/projects/:projectId/graph/nodes/:nodeId/neighborhood',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; nodeId: string };
        Querystring: { depth?: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const depth = Math.max(1, Math.min(2, Number(request.query.depth ?? '1') || 1));
      const graphProjectName = resolveGraphProjectName(project);
      const neighborhood = readCurrentGraphNeighborhood(request.params.nodeId, depth, graphProjectName);
      if (!neighborhood) {
        return reply.code(404).send({
          error: 'ZEUS_GRAPH_NODE_NOT_FOUND',
          message: 'Graph node not found. Scan the project first.',
        });
      }
      return neighborhood;
    },
  );

  server.get('/api/projects/:projectId/apis', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    return listSemanticGraphNodes(project.id, 'api_sequence', ['api']);
  });

  server.get('/api/projects/:projectId/apis/:apiId', async (request: FastifyRequest<{ Params: { projectId: string; apiId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    return readSemanticGraphNode(project.id, request.params.apiId, ['api'], reply);
  });

  server.get('/api/projects/:projectId/apis/:apiId/sequence', async (request: FastifyRequest<{ Params: { projectId: string; apiId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    return readFocusedSemanticGraphView(project.id, request.params.apiId, ['api'], 'api_sequence', reply);
  });

  server.get('/api/projects/:projectId/modules', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    return listSemanticGraphNodes(project.id, 'module', ['file', 'package']);
  });

  server.get(
    '/api/projects/:projectId/modules/:moduleId',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; moduleId: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      return readSemanticGraphNode(project.id, request.params.moduleId, ['file', 'package'], reply);
    },
  );

  server.get(
    '/api/projects/:projectId/modules/:moduleId/flow',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; moduleId: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      return readFocusedSemanticGraphView(project.id, request.params.moduleId, ['file', 'package'], 'module_flow', reply);
    },
  );

  server.get('/api/projects/:projectId/tables', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = projects.getById(request.params.projectId);
    if (!project) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    return listSemanticGraphNodes(project.id, 'table', ['table']);
  });

  server.get(
    '/api/projects/:projectId/tables/columns/search',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Querystring: { query?: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      return searchProjectTableFields(project.id, request.query.query ?? '');
    },
  );

  server.get(
    '/api/projects/:projectId/tables/:tableId',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; tableId: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      return readSemanticGraphNode(project.id, request.params.tableId, ['table'], reply);
    },
  );

  server.get(
    '/api/projects/:projectId/tables/:tableId/impact',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; tableId: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      return readFocusedSemanticGraphView(project.id, request.params.tableId, ['table'], 'method_logic', reply);
    },
  );

  server.get(
    '/api/projects/:projectId/methods/:methodId/logic',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; methodId: string };
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      return readFocusedSemanticGraphView(project.id, request.params.methodId, ['function'], 'method_logic', reply);
    },
  );

  server.post(
    '/api/projects/:projectId/ask',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: AskProjectGraphBody;
      }>,
      reply,
    ) => {
      const project = projects.getById(request.params.projectId);
      if (!project) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      }
      const question = request.body?.question?.trim();
      if (!question) {
        return reply.code(400).send({
          error: 'ZEUS_GRAPH_QUESTION_REQUIRED',
          message: 'question is required',
        });
      }
      let answer: GraphQuestionAnswer;
      try {
        answer = await answerProjectGraphQuestion(project, question);
      } catch (error) {
        if (isNativeApiRecord(error) && error.code === 'ZEUS_CODEX_NATIVE_DISABLED') return sendNativeConversationApiError(reply, error);
        throw error;
      }
      persistGraphQuestionConversation(answer);
      await db.save();
      return answer;
    },
  );

  server.get('/api/graph/views/:viewType', async (request: FastifyRequest<{ Params: { viewType: string } }>, reply) => {
    const viewReadStartedAt = Date.now();
    const view = readCurrentGraphView(request.params.viewType);
    if (!view) {
      return reply.code(404).send({
        error: 'ZEUS_GRAPH_VIEW_NOT_FOUND',
        message: 'Graph view not found. Scan the project first.',
      });
    }
    const measuredView = attachGraphViewPerformance(view, viewReadStartedAt);
    publishRealtimeEvent('graph.view.generated', {
      viewType: view.viewType,
      title: view.title,
      nodeCount: view.nodes.length,
      edgeCount: view.edges.length,
      performance: measuredView.performance,
    });
    return measuredView;
  });

  server.post('/api/graph/scan-current', async (_request, reply) => {
    try {
      return await runCodeMapScan({
        projectName: 'Zeus',
        rootPath: projectRoot,
      });
    } catch (error) {
      publishRealtimeEvent('project.scan.failed', {
        projectName: 'Zeus',
        rootPath: projectRoot,
        message: error instanceof Error ? error.message : String(error),
      });
      return reply.code(isUnsafeCodeMapScanRootError(error) ? 400 : 500).send({
        error: isUnsafeCodeMapScanRootError(error) ? 'ZEUS_UNSAFE_GRAPH_SCAN_ROOT' : 'ZEUS_GRAPH_SCAN_FAILED',
        message: error instanceof Error ? error.message : 'Graph scan failed',
      });
    }
  });

  server.get('/api/git/status', async () => readGitStatus(projectRoot));

  server.get(
    '/api/git/diff',
    async (
      request: FastifyRequest<{
        Querystring: { projectId?: string; taskId?: string };
      }>,
    ): Promise<GitDiffSummary> => {
      const diff = await readGitDiff(projectRoot);
      publishGitDiffUpdatedEvent(diff, request.query.projectId);
      if (request.query.projectId && request.query.taskId) {
        persistReadonlyGitDiffSnapshot({
          projectId: request.query.projectId,
          taskId: request.query.taskId,
          diff,
          graphRoot: projectRoot,
        });
        publishRealtimeEvent('git.snapshot.created', {
          projectId: request.query.projectId,
          taskId: request.query.taskId,
          snapshotType: 'readonly_diff',
          isRepository: diff.isRepository,
          fileCount: diff.files.length,
          diffTextLength: diff.diffText.length,
        });
        await db.save();
      }
      return diff;
    },
  );

  server.get('/api/git/patch', async (): Promise<GitPatchExport> => {
    const diff = await getGitDiff(projectRoot);
    const patch = buildGitPatchExport(diff);
    appendAuditLog({
      actorType: 'local_api',
      action: 'git.patch.exported',
      resourceType: 'git_patch',
      resourceId: patch.fileName,
      payload: {
        fileCount: patch.files.length,
        patchTextLength: patch.patchText.length,
        readonly: true,
      },
      createdAt: patch.createdAt,
    });
    await db.save();
    return patch;
  });

  server.get('/api/runtime/adapters', async () => listAiCliAdapters());

  async function readAgentCapabilityCatalog() {
    const checkedAt = now().toISOString();
    const configuredCommandPath = configuredCodexRuntimeCommandPath();
    let codexStatus = {
      available: false,
      version: null as string | null,
      checkedAt,
      reason: 'Zeus 当前已关闭 Codex 原生会话。',
    };
    if (codexNativeEnabled) {
      const cliStatus = await checkAiCliAdapter('codex', {
        ...(configuredCommandPath ? { commandPath: configuredCommandPath } : {}),
        now: () => checkedAt,
      });
      codexStatus = {
        available: false,
        version: cliStatus.version,
        checkedAt: cliStatus.checkedAt,
        reason: cliStatus.reason,
      };
      if (cliStatus.available) {
        try {
          const capabilities = await codexAppServerManager.ensureReady({ commandPath: currentCodexRuntimeCommandPath(), ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}) });
          codexStatus = {
            ...codexStatus,
            available: capabilities.models.length > 0,
            reason: capabilities.models.length > 0 ? `${cliStatus.reason.replace(/[。；]+$/u, '')}；App Server 已完成初始化并返回 ${capabilities.models.length} 个模型。` : 'Codex App Server 已初始化，但没有返回可用模型。',
          };
        } catch (error) {
          codexStatus = {
            ...codexStatus,
            reason: error instanceof Error ? `Codex CLI 已检测，但 App Server 初始化失败：${error.message}` : 'Codex CLI 已检测，但 App Server 初始化失败。',
          };
        }
      }
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
    const registry = await readAgentCapabilityCatalog();
    return { items: registry.listPublic() };
  });

  server.get('/api/developer/agents', async (_request, reply) => {
    if (!appShellSettings.developerModeEnabled) {
      return reply.code(404).send({
        error: 'ZEUS_DEVELOPER_AGENT_CATALOG_DISABLED',
        message: 'Developer agent catalog is disabled.',
      });
    }
    const registry = await readAgentCapabilityCatalog();
    return { items: registry.listAll() };
  });

  server.get('/api/model-connections', async () => ({ items: await modelConnections.list() }));

  server.post('/api/model-connections', async (request: FastifyRequest<{ Body: SaveModelConnectionRequest }>, reply) => {
    try {
      const connection = await modelConnections.create(request.body ?? ({} as SaveModelConnectionRequest));
      appendAuditLog({
        actorType: 'local_api',
        action: 'model.connection.created',
        resourceType: 'model_connection',
        resourceId: connection.id,
        payload: { name: connection.name, templateId: connection.templateId, baseUrl: connection.baseUrl, modelCount: connection.models.length, apiKeyConfigured: connection.apiKeyConfigured },
      });
      return reply.code(201).send(connection);
    } catch (error) {
      return sendModelConnectionError(reply, error);
    }
  });

  server.put('/api/model-connections/:connectionId', async (request: FastifyRequest<{ Params: { connectionId: string }; Body: SaveModelConnectionRequest }>, reply) => {
    try {
      const connection = await modelConnections.update(request.params.connectionId, request.body ?? ({} as SaveModelConnectionRequest));
      appendAuditLog({
        actorType: 'local_api',
        action: 'model.connection.updated',
        resourceType: 'model_connection',
        resourceId: connection.id,
        payload: { name: connection.name, templateId: connection.templateId, baseUrl: connection.baseUrl, modelCount: connection.models.length, apiKeyConfigured: connection.apiKeyConfigured },
      });
      return connection;
    } catch (error) {
      return sendModelConnectionError(reply, error);
    }
  });

  server.delete('/api/model-connections/:connectionId', async (request: FastifyRequest<{ Params: { connectionId: string } }>, reply) => {
    try {
      await modelConnections.remove(request.params.connectionId);
      appendAuditLog({ actorType: 'local_api', action: 'model.connection.deleted', resourceType: 'model_connection', resourceId: request.params.connectionId, payload: {} });
      return reply.code(204).send();
    } catch (error) {
      return sendModelConnectionError(reply, error);
    }
  });

  server.delete('/api/model-connections/:connectionId/api-key', async (request: FastifyRequest<{ Params: { connectionId: string } }>, reply) => {
    try {
      const connection = await modelConnections.clearApiKey(request.params.connectionId);
      appendAuditLog({ actorType: 'local_api', action: 'model.connection.api_key.cleared', resourceType: 'model_connection', resourceId: connection.id, payload: {} });
      return connection;
    } catch (error) {
      return sendModelConnectionError(reply, error);
    }
  });

  server.post('/api/model-connections/:connectionId/models/refresh', async (request: FastifyRequest<{ Params: { connectionId: string } }>, reply) => {
    try {
      const result = await modelConnections.refreshModels(request.params.connectionId);
      appendAuditLog({
        actorType: 'local_api',
        action: 'model.connection.catalog.refreshed',
        resourceType: 'model_connection',
        resourceId: result.connection.id,
        payload: { discoveredModelCount: result.discoveredModelIds.length, addedModelCount: result.addedModelIds.length, checkedAt: result.checkedAt },
      });
      return result;
    } catch (error) {
      return sendModelConnectionError(reply, error);
    }
  });

  server.post('/api/model-connections/:connectionId/diagnose', async (request: FastifyRequest<{ Params: { connectionId: string } }>) => modelConnections.diagnose(request.params.connectionId));

  server.get('/api/models/catalog', async () => ({ items: await modelConnections.listSelectableModels() }));

  server.get('/api/projects/:projectId/model-selection', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    if (!projects.getById(request.params.projectId)) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    return modelConnections.getProjectSelection(request.params.projectId);
  });

  server.put('/api/projects/:projectId/model-selection', async (request: FastifyRequest<{ Params: { projectId: string }; Body: unknown }>, reply) => {
    if (!projects.getById(request.params.projectId)) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    try {
      const selection = await modelConnections.saveProjectSelection(request.params.projectId, request.body);
      appendAuditLog({
        actorType: 'local_api',
        action: 'project.model_selection.updated',
        resourceType: 'project',
        resourceId: request.params.projectId,
        payload: { modelCount: selection.allowedModelRefs.length, defaultModelRef: selection.defaultModelRef },
      });
      return selection;
    } catch (error) {
      return sendModelConnectionError(reply, error);
    }
  });

  server.get('/api/runtime/settings', async (): Promise<RuntimeSettingsSnapshot> => runtimeSettings);

  server.put('/api/runtime/settings', async (request: FastifyRequest<{ Body: UpdateRuntimeSettingsBody }>, reply) => {
    const nextAdapterId = request.body?.defaultAdapterId;
    if (!isRuntimeAdapterId(nextAdapterId)) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SETTINGS',
        message: 'defaultAdapterId must be one of the known runtime adapters',
      });
    }
    if (nextAdapterId === 'generic') {
      return reply.code(400).send({
        error: 'ZEUS_GENERIC_RUNTIME_REQUIRES_CONFIRMATION',
        message: 'Generic shell runtime requires an explicit high-risk confirmation flow before it can be used as the default adapter',
      });
    }
    const adapterModels = normalizeRuntimeAdapterModels(request.body?.adapterModels);
    if (!adapterModels) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SETTINGS',
        message: 'adapterModels must use known adapters and single-line model names',
      });
    }
    const adapterDefaultArgs = normalizeRuntimeAdapterDefaultArgs(request.body?.adapterDefaultArgs);
    if (!adapterDefaultArgs) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SETTINGS',
        message: 'adapterDefaultArgs must use known adapters and short single-line arguments',
      });
    }
    const adapterCliPaths = normalizeRuntimeAdapterCliPaths(request.body?.adapterCliPaths);
    if (!adapterCliPaths) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SETTINGS',
        message: 'adapterCliPaths must use known dedicated adapters and absolute single-line paths',
      });
    }
    const terminalEnv = normalizeRuntimeTerminalEnv(request.body?.terminalEnv);
    if (!terminalEnv) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SETTINGS',
        message: 'terminalEnv must use safe single-line environment variable names and values',
      });
    }
    const shell = normalizeRuntimeShellSettings(request.body?.shell);
    if (!shell) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SETTINGS',
        message: 'shell.path must be an absolute single-line path when provided',
      });
    }
    const concurrency = normalizeRuntimeConcurrencySettings(request.body?.concurrency);
    if (!concurrency) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SETTINGS',
        message: 'concurrency must use positive integer limits',
      });
    }
    // Runtime 默认 adapter 是本机偏好设置；只保存选择，不假定对应 CLI 已安装或已登录。
    const executionTimeoutSeconds = normalizeRuntimeExecutionTimeoutSeconds(request.body?.executionTimeoutSeconds);
    if (executionTimeoutSeconds === null) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SETTINGS',
        message: 'executionTimeoutSeconds must be an integer between 60 and 86400',
      });
    }
    const logRetentionDays = normalizeRuntimeLogRetentionDays(request.body?.logRetentionDays);
    if (logRetentionDays === null) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SETTINGS',
        message: 'logRetentionDays must be an integer between 1 and 365',
      });
    }
    const autoConfirmationPolicy = normalizeRuntimeAutoConfirmationPolicy(request.body?.autoConfirmationPolicy);
    if (autoConfirmationPolicy === null) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SETTINGS',
        message: 'autoConfirmationPolicy must be never or low_risk_only',
      });
    }
    // 自动确认策略只是偏好开关；Generic shell、Git 写入、删除文件等高风险动作仍必须走显式确认。
    runtimeSettings = {
      defaultAdapterId: nextAdapterId,
      adapterModels,
      adapterDefaultArgs,
      adapterCliPaths,
      terminalEnv,
      shell,
      concurrency,
      executionTimeoutSeconds,
      logRetentionDays,
      autoConfirmationPolicy,
    };
    settings.setJson(runtimeSettingsKey, runtimeSettings);
    await db.save();
    return runtimeSettings;
  });

  server.get('/api/settings/app-shell', async (): Promise<AppShellSettingsSnapshot> => appShellSettings);

  server.put('/api/settings/app-shell', async (request: FastifyRequest<{ Body: UpdateAppShellSettingsBody }>, reply): Promise<AppShellSettingsSnapshot | unknown> => {
    const previousSettings = appShellSettings;
    const nextSettings = patchAppShellSettings(previousSettings, request.body ?? {});
    const migrationOperations: Array<{ projectId: string; fromStatus: TaskManagementStatus; toStatus: TaskManagementStatus }> = [];
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'taskManagementStatusByProject')) {
      for (const project of projects.list()) {
        const previousConfig = previousSettings.taskManagementStatusByProject[project.id] ?? previousSettings.taskManagementStatusTemplate;
        const nextConfig = nextSettings.taskManagementStatusByProject[project.id] ?? nextSettings.taskManagementStatusTemplate;
        const nextStatusIds = new Set(nextConfig.statuses.map((status) => status.id));
        const removedStatusIds = previousConfig.statuses.map((status) => status.id).filter((statusId) => !nextStatusIds.has(statusId));
        for (const removedStatusId of removedStatusIds) {
          if (nextSettings.taskStatusFilterByProject[project.id] === removedStatusId) nextSettings.taskStatusFilterByProject[project.id] = 'unfinished';
          const replacementStatusId = request.body.taskManagementStatusReplacements?.[project.id]?.[removedStatusId];
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
    const migratedTasks = migrationOperations.flatMap((operation) => tasks.replaceManagementStatusForProject(operation.projectId, operation.fromStatus, operation.toStatus).map((task) => ({ task, operation })));
    appShellSettings = nextSettings;
    settings.setJson(appShellSettingsKey, appShellSettings);
    for (const { task, operation } of migratedTasks) {
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.management_status.migrated',
        title: '任务管理状态配置迁移',
        payload: { from: operation.fromStatus, to: task.managementStatus },
      });
      publishRealtimeEvent('task.updated', { taskId: task.id, projectId: task.projectId, changedFields: ['managementStatus'], updatedAt: task.updatedAt });
    }
    appendAuditLog({
      actorType: 'local_api',
      action: 'settings.app_shell.updated',
      resourceType: 'settings',
      resourceId: appShellSettingsKey,
      payload: {
        appLanguage: appShellSettings.appLanguage,
        appearance: appShellSettings.appearance,
        webviewDebugEnabled: appShellSettings.webviewDebugEnabled,
        developerModeEnabled: appShellSettings.developerModeEnabled,
        multiWindowEnabled: appShellSettings.multiWindowEnabled,
        backgroundModeEnabled: appShellSettings.backgroundModeEnabled,
        desktopNotificationsEnabled: appShellSettings.desktopNotificationsEnabled,
        openAtLoginEnabled: appShellSettings.openAtLoginEnabled,
        autoUpdateChannel: appShellSettings.autoUpdateChannel,
        defaultProjectId: appShellSettings.defaultProjectId,
        pinnedProjectIds: appShellSettings.pinnedProjectIds,
        collapsedProjectIds: appShellSettings.collapsedProjectIds,
        defaultModel: appShellSettings.defaultModel,
        defaultTaskTemplateId: appShellSettings.defaultTaskTemplateId,
        taskTableColumns: appShellSettings.taskTableColumns,
        taskTableColumnsByProject: appShellSettings.taskTableColumnsByProject,
        taskTableEnumSortOrders: appShellSettings.taskTableEnumSortOrders,
        taskManagementStatusTemplate: appShellSettings.taskManagementStatusTemplate,
        taskManagementStatusProjectCount: Object.keys(appShellSettings.taskManagementStatusByProject).length,
        migratedTaskManagementStatusCount: migratedTasks.length,
        taskStatusFilterByProject: appShellSettings.taskStatusFilterByProject,
        taskViewModeByProject: appShellSettings.taskViewModeByProject,
        taskExpandedIdsByProject: appShellSettings.taskExpandedIdsByProject,
      },
    });
    await db.save();
    return appShellSettings;
  });

  server.post('/api/settings/cache/clear', async (): Promise<ClearCacheResult> => {
    const clearedAt = new Date().toISOString();
    memoryGraphCache = null;
    clearAllPersistedGraphCaches(db);
    appShellSettings = { ...appShellSettings, lastCacheClearAt: clearedAt };
    settings.setJson(appShellSettingsKey, appShellSettings);
    appendAuditLog({
      actorType: 'local_api',
      action: 'settings.cache.cleared',
      resourceType: 'cache',
      payload: {
        clearedCaches: ['code-index', 'graph-view', 'layout'],
        clearedAt,
      },
    });
    await db.save();
    return {
      cleared: true,
      clearedCaches: ['code-index', 'graph-view', 'layout'],
      clearedAt,
    };
  });

  server.get('/api/settings/export', async (): Promise<LocalSettingsExportSnapshot> => {
    const exportedAt = new Date().toISOString();
    appendAuditLog({
      actorType: 'local_api',
      action: 'settings.data_export.completed',
      resourceType: 'settings_export',
      payload: { schemaVersion: 1, secretsRedacted: true, exportedAt },
    });
    await db.save();
    return {
      app: 'Zeus',
      schemaVersion: 1,
      exportedAt,
      redaction: { secretsRedacted: true },
      settings: {
        appShell: appShellSettings,
        runtime: runtimeSettings,
        codeMap: codeMapSettings,
        telegramNotification: telegramNotificationSettings,
        telegramSecurity: telegramSecuritySettings,
      },
    };
  });

  server.post('/api/settings/import', async (request: FastifyRequest<{ Body: ImportLocalSettingsBody }>, reply): Promise<ImportLocalSettingsResult | unknown> => {
    if (request.body?.schemaVersion !== 1 || !request.body.settings) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_SETTINGS_IMPORT',
        message: 'schemaVersion 1 and settings are required',
      });
    }
    const importedSettings: string[] = [];
    if (request.body.settings.appShell) {
      appShellSettings = patchAppShellSettings(appShellSettings, request.body.settings.appShell);
      settings.setJson(appShellSettingsKey, appShellSettings);
      importedSettings.push('app-shell');
    }
    if (request.body.settings.runtime) {
      const importedRuntimeSettings = normalizeImportedRuntimeSettings(request.body.settings.runtime);
      if (!importedRuntimeSettings) {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_SETTINGS_IMPORT',
          message: 'runtime settings are invalid or unsafe',
        });
      }
      runtimeSettings = importedRuntimeSettings;
      settings.setJson(runtimeSettingsKey, runtimeSettings);
      importedSettings.push('runtime');
    }
    if (request.body.settings.codeMap) {
      const importedCodeMapSettings = normalizeCodeMapSettings(request.body.settings.codeMap);
      if (!importedCodeMapSettings) {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_SETTINGS_IMPORT',
          message: 'codeMap settings are invalid',
        });
      }
      codeMapSettings = importedCodeMapSettings;
      settings.setJson(codeMapSettingsKey, codeMapSettings);
      importedSettings.push('code-map');
    }
    if (request.body.settings.telegramNotification) {
      const importedTelegramNotificationSettings = normalizeImportedTelegramNotificationSettings(request.body.settings.telegramNotification);
      if (!importedTelegramNotificationSettings) {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_SETTINGS_IMPORT',
          message: 'telegram notification settings are invalid',
        });
      }
      telegramNotificationSettings = importedTelegramNotificationSettings;
      settings.setJson(telegramNotificationSettingsKey, telegramNotificationSettings);
      importedSettings.push('telegram-notification');
    }
    if (request.body.settings.telegramSecurity) {
      const importedTelegramSecuritySettings = normalizeImportedTelegramSecuritySettings(request.body.settings.telegramSecurity);
      if (!importedTelegramSecuritySettings) {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_SETTINGS_IMPORT',
          message: 'telegram security settings are invalid',
        });
      }
      telegramSecuritySettings = importedTelegramSecuritySettings;
      settings.setJson(telegramSecuritySettingsKey, telegramSecuritySettings);
      importedSettings.push('telegram-security');
    }
    const importedAt = new Date().toISOString();
    appendAuditLog({
      actorType: 'local_api',
      action: 'settings.data_import.completed',
      resourceType: 'settings_import',
      payload: {
        schemaVersion: 1,
        importedSettings,
        importedAt,
        secretsAccepted: false,
      },
    });
    await db.save();
    return { imported: true, importedSettings, importedAt };
  });

  server.get('/api/data/export', async (): Promise<LocalDataExportSnapshot> => {
    const exportedAt = new Date().toISOString();
    const snapshot = exportLocalBusinessData(db, exportedAt);
    appendAuditLog({
      actorType: 'local_api',
      action: 'data.export.completed',
      resourceType: 'data_export',
      payload: {
        schemaVersion: snapshot.schemaVersion,
        secretsRedacted: true,
        exportedAt,
        counts: {
          projects: snapshot.data.projects.length,
          tasks: snapshot.data.tasks.length,
          taskEvents: snapshot.data.taskEvents.length,
          taskTemplates: snapshot.data.taskTemplates.length,
          commandDefinitions: snapshot.data.commandDefinitions?.length ?? 0,
        },
      },
    });
    await db.save();
    return snapshot;
  });

  server.post('/api/data/import', async (request: FastifyRequest<{ Body: LocalDataExportSnapshot }>, reply): Promise<ImportLocalDataResult | unknown> => {
    if (request.body?.app !== 'Zeus' || ![1, 2].includes(request.body.schemaVersion) || request.body.redaction?.secretsRedacted !== true || !request.body.data) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_DATA_IMPORT',
        message: 'Zeus data import requires a redacted schemaVersion 1 or 2 snapshot',
      });
    }
    const invalidProjectPaths = findInvalidPortableProjectPaths(request.body);
    if (invalidProjectPaths.length > 0) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_DATA_IMPORT_PROJECT_PATH',
        message: `Imported projects must reference existing local directories: ${invalidProjectPaths.slice(0, 3).join(', ')}`,
        invalidProjectPaths: invalidProjectPaths.slice(0, 20),
      });
    }
    const importedCounts = importLocalBusinessData(db, request.body);
    const importedAt = new Date().toISOString();
    appendAuditLog({
      actorType: 'local_api',
      action: 'data.import.completed',
      resourceType: 'data_import',
      payload: {
        schemaVersion: request.body.schemaVersion,
        importedCounts,
        importedAt,
        secretsAccepted: false,
      },
    });
    await db.save();
    return { imported: true, importedCounts, importedAt };
  });

  server.get('/api/code-map/settings', async (): Promise<CodeMapSettingsSnapshot> => codeMapSettings);

  server.put('/api/code-map/settings', async (request: FastifyRequest<{ Body: UpdateCodeMapSettingsBody }>, reply) => {
    const nextSettings = normalizeCodeMapSettings(request.body);
    if (!nextSettings) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_CODE_MAP_SETTINGS',
        message: 'code map settings must use supported ranges and safe ignore directory names',
      });
    }
    // 代码地图设置只影响真实扫描与视图偏好，不写入任何示例图谱数据。
    codeMapSettings = nextSettings;
    settings.setJson(codeMapSettingsKey, codeMapSettings);
    appendAuditLog({
      actorType: 'local_api',
      action: 'settings.code_map.updated',
      resourceType: 'settings',
      resourceId: codeMapSettingsKey,
      payload: {
        defaultScanScope: codeMapSettings.defaultScanScope,
        ignoreDirectoryCount: codeMapSettings.defaultIgnoreDirectories.length,
        maxCallChainDepth: codeMapSettings.maxCallChainDepth,
        layoutAlgorithm: codeMapSettings.layoutAlgorithm,
        moduleFlowManualNotesLength: codeMapSettings.moduleFlowManualNotes.length,
      },
    });
    await db.save();
    return codeMapSettings;
  });

  server.get('/api/runtime/adapters/:adapter/check', async (request: FastifyRequest<{ Params: { adapter: string } }>, reply) => {
    try {
      const adapterId = request.params.adapter;
      const configuredPath = isRuntimeAdapterId(adapterId) ? runtimeSettings.adapterCliPaths[adapterId] : undefined;
      return await checkAiCliAdapter(adapterId, { commandPath: configuredPath });
    } catch {
      return reply.code(404).send({
        error: 'ZEUS_RUNTIME_ADAPTER_NOT_FOUND',
        message: 'AI Runtime adapter not found',
      });
    }
  });

  server.post('/api/runtime/confirmations', async (request: FastifyRequest<{ Body: CreateRuntimeConfirmationBody }>, reply) => {
    const body = request.body;
    if (body?.action !== 'start_generic_session' || !body.reason?.trim() || !body.session?.projectId || !body.session.command) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_CONFIRMATION',
        message: 'action, reason and session are required for runtime confirmation',
      });
    }
    if (!isGenericRuntimeAdapterCommand(body.session.command)) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_CONFIRMATION',
        message: 'runtime confirmation is only required for Generic shell sessions',
      });
    }
    const confirmationProject = projects.getById(body.session.projectId);
    if (!confirmationProject) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    if (!readProjectConfig(confirmationProject.id).security.allowShell) {
      return reply.code(403).send({
        error: 'ZEUS_RUNTIME_SHELL_PERMISSION_REQUIRED',
        message: 'Project must enable allowShell before Generic shell sessions can be confirmed',
      });
    }
    const confirmationProjectRoot = confirmationProject.localPath;
    const confirmationCwd = body.session.cwd ?? confirmationProjectRoot;
    if (!isPathInsideProjectRoot(confirmationCwd, confirmationProjectRoot)) {
      appendRuntimeCwdRejectedAuditLog({
        requestedCwd: confirmationCwd,
        projectRoot: confirmationProjectRoot,
        projectId: body.session.projectId,
        taskId: body.session.taskId ?? null,
        phase: 'confirmation',
      });
      await db.save();
      return reply.code(400).send({
        error: 'ZEUS_RUNTIME_CWD_OUTSIDE_PROJECT',
        message: 'Runtime cwd must stay inside the configured project root before high-risk shell confirmation can be created',
      });
    }
    const confirmationShellPathRisk = detectGenericShellOutsideProjectPath(body.session.command, body.session.args ?? [], confirmationProjectRoot);
    if (confirmationShellPathRisk) {
      appendRuntimeShellPathRejectedAuditLog({
        ...confirmationShellPathRisk,
        projectRoot: confirmationProjectRoot,
        projectId: body.session.projectId,
        taskId: body.session.taskId ?? null,
        phase: 'confirmation',
      });
      await db.save();
      return reply.code(400).send({
        error: 'ZEUS_RUNTIME_SHELL_PATH_OUTSIDE_PROJECT',
        message: 'Generic shell command arguments must not target paths outside the configured project root',
      });
    }
    const confirmationSensitivePathRisk = detectGenericShellSensitivePath(body.session.command, body.session.args ?? []);
    if (confirmationSensitivePathRisk) {
      appendRuntimeSensitivePathRejectedAuditLog({
        ...confirmationSensitivePathRisk,
        projectId: body.session.projectId,
        taskId: body.session.taskId ?? null,
        phase: 'confirmation',
      });
      await db.save();
      return reply.code(400).send({
        error: 'ZEUS_RUNTIME_SENSITIVE_PATH_REJECTED',
        message: 'Generic shell command arguments must not access sensitive local directories',
      });
    }
    const confirmationSecretFileRisk = detectGenericShellSecretFile(body.session.command, body.session.args ?? []);
    if (confirmationSecretFileRisk) {
      appendRuntimeSecretFileRejectedAuditLog({
        ...confirmationSecretFileRisk,
        projectId: body.session.projectId,
        taskId: body.session.taskId ?? null,
        phase: 'confirmation',
      });
      await db.save();
      return reply.code(400).send({
        error: 'ZEUS_RUNTIME_SECRET_FILE_REJECTED',
        message: 'Generic shell command arguments must not access likely secret files',
      });
    }
    const createdAt = new Date().toISOString();
    const session = {
      projectId: body.session.projectId,
      taskId: body.session.taskId,
      command: body.session.command,
      args: body.session.args ?? [],
      cwd: confirmationCwd,
    };
    const reason = redactSensitiveText(body.reason.trim()).text;
    const securityContext = buildRuntimeConfirmationSecurityContext(session);
    const confirmation: RuntimeOperationConfirmation = {
      id: randomUUID(),
      action: 'start_generic_session',
      status: 'pending',
      riskLevel: 'high',
      reason,
      securityContext,
      session,
      createdAt,
      confirmedAt: null,
      consumedAt: null,
    };
    runtimeConfirmations.set(confirmation.id, confirmation);
    appendAuditLog({
      actorType: 'local_api',
      action: 'runtime.confirmation.created',
      resourceType: 'runtime_confirmation',
      resourceId: confirmation.id,
      payload: {
        action: confirmation.action,
        reason: confirmation.reason,
        securityContext: confirmation.securityContext,
      },
      createdAt,
    });
    publishRealtimeEvent('runtime.confirmation.created', {
      confirmationId: confirmation.id,
      action: confirmation.action,
      projectId: confirmation.session.projectId,
      taskId: confirmation.session.taskId ?? null,
      riskLevel: confirmation.riskLevel,
      operation: confirmation.action,
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.confirmation.required',
      resourceType: 'runtime_confirmation',
      resourceId: confirmation.id,
      payload: {
        action: confirmation.action,
        reason: confirmation.reason,
        securityContext: confirmation.securityContext,
      },
      createdAt,
    });
    await db.save();
    return reply.code(201).send(toRuntimeOperationConfirmationResponse(confirmation));
  });

  server.post(
    '/api/runtime/confirmations/:confirmationId/reject',
    async (
      request: FastifyRequest<{
        Params: { confirmationId: string };
        Body: { reason?: string };
      }>,
      reply,
    ) => {
      const existing = runtimeConfirmations.get(request.params.confirmationId);
      if (!existing) {
        return reply.code(404).send({
          error: 'ZEUS_RUNTIME_CONFIRMATION_NOT_FOUND',
          message: 'Runtime confirmation not found',
        });
      }
      if (existing.status !== 'pending') {
        return reply.code(409).send({
          error: 'ZEUS_RUNTIME_CONFIRMATION_ALREADY_USED',
          message: 'Runtime confirmation is not pending',
        });
      }
      const rejectedAt = new Date().toISOString();
      const rawReason = request.body?.reason?.trim();
      const rejectedReason = rawReason ? redactSensitiveText(rawReason).text : null;
      // Runtime 拒绝必须终止一次性确认令牌，避免被后续会话启动误消费。
      const rejected: RuntimeOperationConfirmation = {
        ...existing,
        status: 'rejected',
        rejectedAt,
        rejectedReason,
      };
      runtimeConfirmations.set(rejected.id, rejected);
      appendAuditLog({
        actorType: 'local_api',
        action: 'security.confirmation.rejected',
        resourceType: 'runtime_confirmation',
        resourceId: rejected.id,
        payload: {
          action: rejected.action,
          securityContext: rejected.securityContext,
          rejectedAt,
          rejectedReason,
        },
        createdAt: rejectedAt,
      });
      publishRealtimeEvent('security.confirmation.rejected', {
        confirmationId: rejected.id,
        action: rejected.action,
        operation: rejected.action,
        projectId: rejected.session.projectId,
        taskId: rejected.session.taskId ?? null,
        riskLevel: rejected.riskLevel,
      });
      await db.save();
      return toRuntimeOperationConfirmationResponse(rejected);
    },
  );

  server.post('/api/runtime/confirmations/:confirmationId/confirm', async (request: FastifyRequest<{ Params: { confirmationId: string } }>, reply) => {
    const existing = runtimeConfirmations.get(request.params.confirmationId);
    if (!existing) {
      return reply.code(404).send({
        error: 'ZEUS_RUNTIME_CONFIRMATION_NOT_FOUND',
        message: 'Runtime confirmation not found',
      });
    }
    if (existing.status !== 'pending') {
      return reply.code(409).send({
        error: 'ZEUS_RUNTIME_CONFIRMATION_ALREADY_USED',
        message: 'Runtime confirmation is not pending',
      });
    }
    const confirmedAt = new Date().toISOString();
    const confirmed: RuntimeOperationConfirmation = {
      ...existing,
      status: 'confirmed',
      confirmedAt,
    };
    runtimeConfirmations.set(confirmed.id, confirmed);
    appendAuditLog({
      actorType: 'local_api',
      action: 'runtime.confirmation.confirmed',
      resourceType: 'runtime_confirmation',
      resourceId: confirmed.id,
      payload: {
        action: confirmed.action,
        securityContext: confirmed.securityContext,
        confirmedAt,
      },
      createdAt: confirmedAt,
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.confirmation.approved',
      resourceType: 'runtime_confirmation',
      resourceId: confirmed.id,
      payload: {
        action: confirmed.action,
        securityContext: confirmed.securityContext,
        confirmedAt,
      },
      createdAt: confirmedAt,
    });
    publishRealtimeEvent('security.confirmation.approved', {
      confirmationId: confirmed.id,
      action: confirmed.action,
      operation: confirmed.action,
      projectId: confirmed.session.projectId,
      taskId: confirmed.session.taskId ?? null,
      riskLevel: confirmed.riskLevel,
    });
    await db.save();
    return toRuntimeOperationConfirmationResponse(confirmed);
  });

  server.post('/api/runtime/sessions', async (request: FastifyRequest<{ Body: CreateRuntimeSessionBody }>, reply) => {
    const body = request.body;
    if (!body?.projectId || !body.command) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_RUNTIME_SESSION',
        message: 'projectId and command are required',
      });
    }
    const runtimeAdapter = resolveRegisteredRuntimeAdapter(body.command);
    if (!runtimeAdapter) {
      return reply.code(400).send({
        error: 'ZEUS_UNSUPPORTED_RUNTIME_COMMAND',
        message: 'Runtime sessions can only start registered AI CLI adapter commands',
      });
    }
    if (runtimeAdapter.id === 'codex') {
      return reply.code(409).send({
        error: 'ZEUS_CODEX_NATIVE_APP_SERVER_REQUIRED',
        message: 'Codex Runtime writes require the native app-server transport.',
      });
    }
    const runtimeProject = projects.getById(body.projectId);
    if (!runtimeProject) {
      return reply.code(404).send({
        error: 'ZEUS_PROJECT_NOT_FOUND',
        message: 'Project not found',
      });
    }
    if (runtimeAdapter.id === 'generic' && !readProjectConfig(runtimeProject.id).security.allowShell) {
      return reply.code(403).send({
        error: 'ZEUS_RUNTIME_SHELL_PERMISSION_REQUIRED',
        message: 'Project must enable allowShell before Generic shell sessions can run',
      });
    }
    const runtimeProjectRoot = runtimeProject.localPath;
    const requestedRuntimeCwd = body.cwd ?? runtimeProjectRoot;
    if (!isPathInsideProjectRoot(requestedRuntimeCwd, runtimeProjectRoot)) {
      appendRuntimeCwdRejectedAuditLog({
        requestedCwd: requestedRuntimeCwd,
        projectRoot: runtimeProjectRoot,
        projectId: body.projectId,
        taskId: body.taskId ?? null,
        phase: 'session',
      });
      await db.save();
      return reply.code(400).send({
        error: 'ZEUS_RUNTIME_CWD_OUTSIDE_PROJECT',
        message: 'Runtime cwd must stay inside the configured project root',
      });
    }
    if (isGenericRuntimeAdapterCommand(body.command)) {
      const sessionShellPathRisk = detectGenericShellOutsideProjectPath(body.command, body.args ?? [], runtimeProjectRoot);
      if (sessionShellPathRisk) {
        appendRuntimeShellPathRejectedAuditLog({
          ...sessionShellPathRisk,
          projectRoot: runtimeProjectRoot,
          projectId: body.projectId,
          taskId: body.taskId ?? null,
          phase: 'session',
        });
        await db.save();
        return reply.code(400).send({
          error: 'ZEUS_RUNTIME_SHELL_PATH_OUTSIDE_PROJECT',
          message: 'Generic shell command arguments must not target paths outside the configured project root',
        });
      }
      const sessionSensitivePathRisk = detectGenericShellSensitivePath(body.command, body.args ?? []);
      if (sessionSensitivePathRisk) {
        appendRuntimeSensitivePathRejectedAuditLog({
          ...sessionSensitivePathRisk,
          projectId: body.projectId,
          taskId: body.taskId ?? null,
          phase: 'session',
        });
        await db.save();
        return reply.code(400).send({
          error: 'ZEUS_RUNTIME_SENSITIVE_PATH_REJECTED',
          message: 'Generic shell command arguments must not access sensitive local directories',
        });
      }
      const sessionSecretFileRisk = detectGenericShellSecretFile(body.command, body.args ?? []);
      if (sessionSecretFileRisk) {
        appendRuntimeSecretFileRejectedAuditLog({
          ...sessionSecretFileRisk,
          projectId: body.projectId,
          taskId: body.taskId ?? null,
          phase: 'session',
        });
        await db.save();
        return reply.code(400).send({
          error: 'ZEUS_RUNTIME_SECRET_FILE_REJECTED',
          message: 'Generic shell command arguments must not access likely secret files',
        });
      }
    }
    if (isGenericRuntimeAdapterCommand(body.command)) {
      const confirmation = body.confirmationId ? runtimeConfirmations.get(body.confirmationId) : undefined;
      if (confirmation?.status === 'rejected') {
        return reply.code(409).send({
          error: 'ZEUS_RUNTIME_CONFIRMATION_REJECTED',
          message: 'Runtime confirmation was rejected',
        });
      }
      if (!confirmation || !canConsumeGenericRuntimeConfirmation(confirmation, body, runtimeProjectRoot)) {
        return reply.code(400).send({
          error: 'ZEUS_GENERIC_RUNTIME_REQUIRES_CONFIRMATION',
          message: 'Generic shell runtime requires a confirmed high-risk confirmation before it can start a session',
        });
      }
      const consumedAt = new Date().toISOString();
      runtimeConfirmations.set(confirmation.id, {
        ...confirmation,
        status: 'consumed',
        consumedAt,
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.confirmation.consumed',
        resourceType: 'runtime_confirmation',
        resourceId: confirmation.id,
        payload: {
          action: confirmation.action,
          securityContext: confirmation.securityContext,
          consumedAt,
        },
        createdAt: consumedAt,
      });
    }
    const concurrency = evaluateRuntimeConcurrency(body.projectId);
    if (!concurrency.allowed) {
      return reply.code(409).send({
        error: 'ZEUS_RUNTIME_CONCURRENCY_LIMIT',
        message: concurrency.reason,
        scope: concurrency.scope,
        limit: concurrency.limit,
        runningCount: concurrency.runningCount,
      });
    }
    try {
      const session = await aiRuntimeManager.startSession({
        projectId: body.projectId,
        taskId: body.taskId,
        command: body.command,
        args: body.args ?? [],
        cwd: body.cwd ?? runtimeProjectRoot,
        env: buildRuntimeProcessEnv(),
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.created',
        resourceType: 'runtime_session',
        resourceId: session.id,
        payload: {
          sessionId: session.id,
          projectId: session.projectId,
          taskId: session.taskId,
          command: session.command,
          cwd: session.cwd,
          argCount: session.args.length,
        },
      });
      publishRuntimeSessionEvent('runtime.session.created', session);
      await db.save();
      return reply.code(201).send(session);
    } catch (error) {
      return reply.code(400).send({
        error: 'ZEUS_RUNTIME_SESSION_REJECTED',
        message: error instanceof Error ? error.message : 'Runtime session rejected',
      });
    }
  });

  server.get('/api/runtime/sessions', async (request: FastifyRequest<{ Querystring: ListRuntimeSessionsQuery }>) => {
    const hasFilter = Boolean(request.query.query || request.query.projectId || request.query.taskId || request.query.archived || request.query.favoriteOnly);
    if (hasFilter) {
      const persisted = runtimeSessions
        .list({
          query: request.query.query,
          projectId: request.query.projectId,
          taskId: request.query.taskId,
          archived: request.query.archived === 'true',
          favoriteOnly: request.query.favoriteOnly === 'true',
        })
        .map(toAiRuntimeSession);
      const memory = aiRuntimeManager.listSessions().filter((session) => matchesRuntimeSessionFilter(session, request.query));
      const byId = new Map<string, AiRuntimeSession>();
      for (const session of [...persisted, ...memory]) byId.set(session.id, session);
      return [...byId.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    }
    const memorySessions = aiRuntimeManager.listSessions();
    const memoryIds = new Set(memorySessions.map((session) => session.id));
    return [
      ...memorySessions,
      ...runtimeSessions
        .list()
        .filter((session) => !memoryIds.has(session.id))
        .map(toAiRuntimeSession),
    ];
  });

  server.get('/api/runtime/sessions/:sessionId', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
    const session = aiRuntimeManager.getSession(request.params.sessionId) ?? toAiRuntimeSessionOrUndefined(runtimeSessions.getById(request.params.sessionId));
    if (!session) {
      return reply.code(404).send({
        error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
        message: 'AI Runtime session not found',
      });
    }
    return session;
  });

  server.get(
    '/api/runtime/sessions/:sessionId/logs',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Querystring: ListRuntimeLogsQuery;
      }>,
      reply,
    ) => {
      if (!aiRuntimeManager.getSession(request.params.sessionId) && !runtimeSessions.getById(request.params.sessionId)) {
        return reply.code(404).send({
          error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
          message: 'AI Runtime session not found',
        });
      }
      const hasLogQuery = Boolean(request.query.query || request.query.stream || request.query.limit || request.query.offset);
      const memoryLogs = aiRuntimeManager.getLogs(request.params.sessionId);
      if (!hasLogQuery) return memoryLogs.length > 0 ? memoryLogs : runtimeSessions.listLogs(request.params.sessionId).map(toAiRuntimeLogEntry);

      const page =
        memoryLogs.length > 0
          ? filterRuntimeMemoryLogs(memoryLogs, request.query)
          : runtimeSessions.searchLogs(request.params.sessionId, {
              query: request.query.query,
              stream: normalizeRuntimeLogStream(request.query.stream),
              limit: parseBoundedInteger(request.query.limit, 200, 1, 1_000),
              offset: parseBoundedInteger(request.query.offset, 0, 0, 100_000),
            });
      return {
        sessionId: request.params.sessionId,
        query: page.query,
        stream: page.stream,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        items: page.items.map((entry) => ('sessionId' in entry ? entry : toAiRuntimeLogEntry(entry))),
      };
    },
  );

  server.post(
    '/api/runtime/sessions/:sessionId/input',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Body: RuntimeInputBody;
      }>,
      reply,
    ) => {
      const input = request.body?.input;
      if (typeof input !== 'string' || input.length === 0) {
        return reply.code(400).send({
          error: 'ZEUS_INVALID_RUNTIME_INPUT',
          message: 'Runtime input is required',
        });
      }
      const liveSession = aiRuntimeManager.getSession(request.params.sessionId);
      if (!liveSession) {
        return reply.code(404).send({
          error: 'ZEUS_RUNTIME_INPUT_REJECTED',
          message: 'AI Runtime session not found',
        });
      }
      const liveAdapter = resolveExistingRuntimeSessionAdapter(liveSession.command);
      if (!liveAdapter) {
        return reply.code(409).send({
          error: 'ZEUS_RUNTIME_INPUT_REJECTED',
          message: 'Runtime session adapter identity could not be verified.',
        });
      }
      if (liveAdapter.id === 'codex') {
        return reply.code(409).send({
          error: 'ZEUS_CODEX_NATIVE_APP_SERVER_REQUIRED',
          message: 'Codex Runtime writes require the native app-server transport.',
        });
      }
      try {
        const session = aiRuntimeManager.inputSession(request.params.sessionId, input);
        appendAuditLog({
          actorType: 'local_api',
          action: 'runtime.session.input',
          resourceType: 'runtime_session',
          resourceId: session.id,
          payload: {
            sessionId: session.id,
            projectId: session.projectId,
            taskId: session.taskId,
            inputLength: input.length,
          },
        });
        await db.save();
        return session;
      } catch (error) {
        return reply.code(error instanceof Error && error.message.includes('not found') ? 404 : 409).send({
          error: 'ZEUS_RUNTIME_INPUT_REJECTED',
          message: error instanceof Error ? error.message : 'Runtime input rejected',
        });
      }
    },
  );

  server.post('/api/runtime/sessions/:sessionId/interrupt', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
    try {
      const session = aiRuntimeManager.interruptSession(request.params.sessionId);
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.interrupt',
        resourceType: 'runtime_session',
        resourceId: session.id,
        payload: {
          sessionId: session.id,
          projectId: session.projectId,
          taskId: session.taskId,
          signal: 'SIGINT',
        },
      });
      await db.save();
      return session;
    } catch (error) {
      return reply.code(error instanceof Error && error.message.includes('not found') ? 404 : 409).send({
        error: 'ZEUS_RUNTIME_INTERRUPT_REJECTED',
        message: error instanceof Error ? error.message : 'Runtime interrupt rejected',
      });
    }
  });

  server.post(
    '/api/runtime/sessions/:sessionId/resize',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Body: RuntimeResizeBody;
      }>,
      reply,
    ) => {
      try {
        const cols = Number(request.body?.cols);
        const rows = Number(request.body?.rows);
        const session = aiRuntimeManager.resizeSession(request.params.sessionId, cols, rows);
        appendAuditLog({
          actorType: 'local_api',
          action: 'runtime.session.resize',
          resourceType: 'runtime_session',
          resourceId: session.id,
          payload: {
            sessionId: session.id,
            projectId: session.projectId,
            taskId: session.taskId,
            cols,
            rows,
          },
        });
        await db.save();
        return session;
      } catch (error) {
        return reply.code(error instanceof Error && error.message.includes('not found') ? 404 : 409).send({
          error: 'ZEUS_RUNTIME_RESIZE_REJECTED',
          message: error instanceof Error ? error.message : 'Runtime resize rejected',
        });
      }
    },
  );

  server.get('/api/runtime/sessions/:sessionId/terminal', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply): Promise<AiRuntimeTerminalSnapshot | unknown> => {
    try {
      return aiRuntimeManager.getTerminalSnapshot(request.params.sessionId);
    } catch {
      const session = runtimeSessions.getById(request.params.sessionId);
      if (!session)
        return reply.code(404).send({
          error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
          message: 'AI Runtime session not found',
        });
      return {
        sessionId: session.id,
        status: session.status,
        command: [session.command, ...parseRuntimeArgs(session.argsJson)].join(' '),
        cwd: session.cwd,
        logs: runtimeSessions.listLogs(session.id).map(toAiRuntimeLogEntry),
        capturedAt: new Date().toISOString(),
      };
    }
  });

  server.get(
    '/api/runtime/sessions/:sessionId/terminal/events',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Querystring: ListTerminalEventsQuery;
      }>,
      reply,
    ) => {
      if (!aiRuntimeManager.getSession(request.params.sessionId) && !runtimeSessions.getById(request.params.sessionId)) {
        return reply.code(404).send({
          error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
          message: 'AI Runtime session not found',
        });
      }
      const limit = parseBoundedInteger(request.query.limit, 200, 1, 1_000);
      const offset = parseBoundedInteger(request.query.offset, 0, 0, 100_000);
      // terminal_events 是终端回放的审计事实表；分页下推到 SQLite，避免长会话全量读入内存。
      const page = terminalEvents.listBySessionPage(request.params.sessionId, {
        limit,
        offset,
      });
      return {
        sessionId: request.params.sessionId,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        items: page.items,
      };
    },
  );

  server.post('/api/runtime/sessions/:sessionId/stop', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
    try {
      const session = aiRuntimeManager.stopSession(request.params.sessionId);
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.stopped',
        resourceType: 'runtime_session',
        resourceId: session.id,
        payload: {
          sessionId: session.id,
          projectId: session.projectId,
          taskId: session.taskId,
          status: session.status,
        },
      });
      publishRuntimeSessionEvent('runtime.session.stopped', session);
      await db.save();
      return session;
    } catch {
      const persisted = stopPersistedOrphanRuntimeSession(request.params.sessionId);
      if (!persisted)
        return reply.code(404).send({
          error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
          message: 'AI Runtime session not found',
        });
      await db.save();
      return persisted;
    }
  });

  server.post('/api/runtime/sessions/:sessionId/summary', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
    try {
      const session = runtimeSessions.generateSummary(request.params.sessionId);
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.summary.generated',
        resourceType: 'runtime_session',
        resourceId: session.id,
        payload: {
          sessionId: session.id,
          projectId: session.projectId,
          taskId: session.taskId,
          hasSummary: Boolean(session.summary),
        },
      });
      await db.save();
      return toAiRuntimeSession(session);
    } catch {
      return reply.code(404).send({
        error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
        message: 'AI Runtime session not found',
      });
    }
  });

  server.put(
    '/api/runtime/sessions/:sessionId/favorite',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Body: UpdateRuntimeFavoriteBody;
      }>,
      reply,
    ) => {
      try {
        const favorite = Boolean(request.body?.favorite);
        const session = runtimeSessions.setFavorite(request.params.sessionId, favorite);
        appendAuditLog({
          actorType: 'local_api',
          action: 'runtime.session.favorite.updated',
          resourceType: 'runtime_session',
          resourceId: session.id,
          payload: {
            sessionId: session.id,
            projectId: session.projectId,
            taskId: session.taskId,
            favorite,
          },
        });
        await db.save();
        return toAiRuntimeSession(session);
      } catch {
        return reply.code(404).send({
          error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
          message: 'AI Runtime session not found',
        });
      }
    },
  );

  server.post('/api/runtime/sessions/:sessionId/archive', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
    try {
      const session = runtimeSessions.archive(request.params.sessionId);
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.archived',
        resourceType: 'runtime_session',
        resourceId: session.id,
        payload: {
          sessionId: session.id,
          projectId: session.projectId,
          taskId: session.taskId,
          archived: true,
        },
      });
      await db.save();
      return toAiRuntimeSession(session);
    } catch {
      return reply.code(404).send({
        error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
        message: 'AI Runtime session not found',
      });
    }
  });

  server.post('/api/runtime/sessions/:sessionId/restore', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
    try {
      const session = runtimeSessions.restore(request.params.sessionId);
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.restored',
        resourceType: 'runtime_session',
        resourceId: session.id,
        payload: {
          sessionId: session.id,
          projectId: session.projectId,
          taskId: session.taskId,
          archived: false,
        },
      });
      await db.save();
      return toAiRuntimeSession(session);
    } catch {
      return reply.code(404).send({
        error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
        message: 'AI Runtime session not found',
      });
    }
  });

  server.post(
    '/api/runtime/sessions/:sessionId/tasks',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Body: CreateTaskFromRuntimeSessionBody;
      }>,
      reply,
    ) => {
      const session = runtimeSessions.getById(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({
          error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
          message: 'AI Runtime session not found',
        });
      }
      if (!projects.getById(session.projectId)) {
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Runtime session project not found',
        });
      }
      const logs = runtimeSessions.listLogs(session.id);
      const instruction = request.body?.instruction?.trim() || '基于真实 Runtime 会话继续分析后续处理事项。';
      const task = tasks.create({
        projectId: session.projectId,
        managementStatus: resolveTaskManagementStatusConfigForProject(session.projectId).roles.defaultStatusId,
        title: request.body?.title?.trim() || `继续会话：${session.command}`,
        taskType: 'requirement',
        description: [
          instruction,
          `Runtime 会话：${session.id}`,
          `命令：${[session.command, ...parseRuntimeArgs(session.argsJson)].join(' ')}`,
          `工作目录：${session.cwd}`,
          `日志摘要：${session.summary ?? logs[0]?.text ?? '未生成摘要'}`,
        ].join('\n'),
        createdFrom: 'runtime_session',
        sourceContext: {
          runtimeSessionId: session.id,
          projectId: session.projectId,
          taskId: session.taskId,
          command: session.command,
          args: parseRuntimeArgs(session.argsJson),
          cwd: session.cwd,
          logs: logs.slice(-10),
        },
      });
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.created.from_runtime_session',
        title: '任务从 Runtime 会话创建',
        payload: { runtimeSessionId: session.id, logCount: logs.length },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.task.created',
        resourceType: 'runtime_session',
        resourceId: session.id,
        payload: {
          sessionId: session.id,
          projectId: session.projectId,
          sourceTaskId: session.taskId,
          createdTaskId: task.id,
          logCount: logs.length,
        },
      });
      await db.save();
      return reply.code(201).send(task);
    },
  );

  server.delete('/api/runtime/sessions/:sessionId', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
    try {
      const session = runtimeSessions.delete(request.params.sessionId);
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.deleted',
        resourceType: 'runtime_session',
        resourceId: session.id,
        payload: {
          sessionId: session.id,
          projectId: session.projectId,
          taskId: session.taskId,
          deletedAt: session.deletedAt,
        },
      });
      await db.save();
      return toAiRuntimeSession(session);
    } catch {
      return reply.code(404).send({
        error: 'ZEUS_RUNTIME_SESSION_NOT_FOUND',
        message: 'AI Runtime session not found',
      });
    }
  });

  server.post('/api/git/confirmations', async (request: FastifyRequest<{ Body: CreateGitConfirmationBody }>, reply) => {
    const body = request.body;
    const rawReason = body?.reason?.trim() ?? '';
    if (!body?.operation || !rawReason) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_GIT_CONFIRMATION',
        message: 'operation and reason are required',
      });
    }
    if (!isHighRiskGitOperation(body.operation)) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_GIT_CONFIRMATION_OPERATION',
        message: 'Git confirmation operation must be commit, stash, apply_stash, rollback or branch',
      });
    }
    const reason = redactSensitiveText(rawReason).text;
    const message = body.message ? redactSensitiveText(body.message).text : undefined;
    const confirmation = createGitOperationConfirmation(
      {
        operation: body.operation,
        cwd: projectRoot,
        reason,
        message,
      },
      { createdAt: now(), ttlMs: gitConfirmationTtlMs },
    );
    gitConfirmations.set(confirmation.id, confirmation);
    appendAuditLog({
      actorType: 'local_api',
      action: 'git.confirmation.created',
      resourceType: 'git_confirmation',
      resourceId: confirmation.id,
      payload: {
        operation: confirmation.operation,
        cwd: confirmation.cwd,
        reason: confirmation.reason,
        message: confirmation.message ?? null,
        riskLevel: confirmation.riskLevel,
      },
      createdAt: confirmation.createdAt,
    });
    publishRealtimeEvent('git.confirmation.created', {
      confirmationId: confirmation.id,
      operation: confirmation.operation,
      riskLevel: confirmation.riskLevel,
    });
    await db.save();
    return reply.code(201).send(confirmation);
  });

  server.post(
    '/api/git/confirmations/:confirmationId/reject',
    async (
      request: FastifyRequest<{
        Params: { confirmationId: string };
        Body: { reason?: string };
      }>,
      reply,
    ) => {
      const existing = gitConfirmations.get(request.params.confirmationId);
      if (!existing) {
        return reply.code(404).send({
          error: 'ZEUS_GIT_CONFIRMATION_NOT_FOUND',
          message: 'Git confirmation not found',
        });
      }
      if (existing.status !== 'pending') {
        return reply.code(409).send({
          error: 'ZEUS_GIT_CONFIRMATION_ALREADY_RESOLVED',
          message: 'Git confirmation is no longer pending',
        });
      }
      const rawReason = request.body?.reason?.trim();
      const rejectedReason = rawReason ? redactSensitiveText(rawReason).text : undefined;
      const rejected = rejectGitOperation(existing, now(), rejectedReason);
      gitConfirmations.set(rejected.id, rejected);
      appendAuditLog({
        actorType: 'local_api',
        action: 'security.confirmation.rejected',
        resourceType: 'git_confirmation',
        resourceId: rejected.id,
        payload: {
          operation: rejected.operation,
          cwd: rejected.cwd,
          riskLevel: rejected.riskLevel,
          rejectedAt: rejected.rejectedAt,
          rejectedReason: rejected.rejectedReason ?? null,
        },
        createdAt: rejected.rejectedAt ?? new Date().toISOString(),
      });
      publishRealtimeEvent('security.confirmation.rejected', {
        confirmationId: rejected.id,
        operation: rejected.operation,
        riskLevel: rejected.riskLevel,
      });
      await db.save();
      return rejected;
    },
  );

  server.post('/api/git/confirmations/:confirmationId/confirm', async (request: FastifyRequest<{ Params: { confirmationId: string } }>, reply) => {
    const existing = gitConfirmations.get(request.params.confirmationId);
    if (!existing) {
      return reply.code(404).send({
        error: 'ZEUS_GIT_CONFIRMATION_NOT_FOUND',
        message: 'Git confirmation not found',
      });
    }
    if (existing.status !== 'pending') {
      return reply.code(409).send({
        error: 'ZEUS_GIT_CONFIRMATION_ALREADY_CONFIRMED',
        message: 'Git confirmation is no longer pending',
      });
    }
    if (isGitConfirmationExpired(existing, now())) {
      return reply.code(409).send({
        error: 'ZEUS_GIT_CONFIRMATION_EXPIRED',
        message: 'Git confirmation has expired',
      });
    }
    const confirmed = confirmGitOperation(existing, now());
    gitConfirmations.set(confirmed.id, confirmed);
    appendAuditLog({
      actorType: 'local_api',
      action: 'git.confirmation.confirmed',
      resourceType: 'git_confirmation',
      resourceId: confirmed.id,
      payload: {
        operation: confirmed.operation,
        cwd: confirmed.cwd,
        riskLevel: confirmed.riskLevel,
        confirmedAt: confirmed.confirmedAt,
      },
      createdAt: confirmed.confirmedAt ?? new Date().toISOString(),
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.confirmation.approved',
      resourceType: 'git_confirmation',
      resourceId: confirmed.id,
      payload: {
        operation: confirmed.operation,
        cwd: confirmed.cwd,
        riskLevel: confirmed.riskLevel,
        confirmedAt: confirmed.confirmedAt,
      },
      createdAt: confirmed.confirmedAt ?? new Date().toISOString(),
    });
    publishRealtimeEvent('security.confirmation.approved', {
      confirmationId: confirmed.id,
      operation: confirmed.operation,
      riskLevel: confirmed.riskLevel,
    });
    await db.save();
    return confirmed;
  });

  server.post('/api/git/operations', async (request: FastifyRequest<{ Body: ExecuteGitOperationBody }>, reply) => {
    const body = request.body;
    if (!body?.confirmationId || !body.operation) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_GIT_OPERATION',
        message: 'confirmationId and operation are required',
      });
    }
    if (!isHighRiskGitOperation(body.operation)) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_GIT_OPERATION',
        message: 'Git operation must be commit, stash, apply_stash, rollback, branch, pull or push',
      });
    }
    const confirmation = gitConfirmations.get(body.confirmationId);
    if (!confirmation) {
      return reply.code(404).send({
        error: 'ZEUS_GIT_CONFIRMATION_NOT_FOUND',
        message: 'Git confirmation not found',
      });
    }
    if (consumedGitConfirmationIds.has(confirmation.id)) {
      return reply.code(409).send({
        error: 'ZEUS_GIT_CONFIRMATION_ALREADY_CONSUMED',
        message: 'Git confirmation has already been consumed by an operation',
      });
    }
    if (confirmation.status === 'rejected') {
      return reply.code(409).send({
        error: 'ZEUS_GIT_CONFIRMATION_REJECTED',
        message: 'Git confirmation was rejected',
      });
    }
    if (confirmation.status !== 'confirmed') {
      return reply.code(409).send({
        error: 'ZEUS_GIT_CONFIRMATION_NOT_CONFIRMED',
        message: 'Git operation requires a confirmed confirmation',
      });
    }
    if (confirmation.operation !== body.operation) {
      return reply.code(400).send({
        error: 'ZEUS_GIT_OPERATION_MISMATCH',
        message: 'Git operation must match the confirmed operation',
      });
    }
    try {
      const result = await executeHighRiskGitOperation({
        confirmation,
        operation: body.operation,
        message: body.message,
        branchName: body.branchName,
        baseRef: body.baseRef,
        stashRef: body.stashRef,
        remote: body.remote,
        targetRef: body.targetRef,
      });
      consumedGitConfirmationIds.add(confirmation.id);
      appendAuditLog({
        actorType: 'local_api',
        action: 'git.operation.executed',
        resourceType: 'git_confirmation',
        resourceId: confirmation.id,
        payload: {
          operation: result.operation,
          cwd: result.cwd,
          args: result.args,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
        },
        createdAt: now().toISOString(),
      });
      await db.save();
      return result;
    } catch (error) {
      return reply.code(400).send({
        error: 'ZEUS_GIT_OPERATION_REJECTED',
        message: error instanceof Error ? error.message : 'Git operation rejected',
      });
    }
  });

  server.post(
    '/api/projects/:projectId/git/branch',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: ExecuteGitOperationBody;
      }>,
      reply,
    ) => {
      if (!projects.getById(request.params.projectId))
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      return executeConfirmedGitOperationBody({ ...request.body, operation: 'branch' }, reply);
    },
  );

  server.post(
    '/api/projects/:projectId/git/checkout',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: ExecuteGitOperationBody;
      }>,
      reply,
    ) => {
      if (!projects.getById(request.params.projectId))
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      return executeConfirmedGitOperationBody({ ...request.body, operation: 'switch_branch' }, reply);
    },
  );

  server.post(
    '/api/projects/:projectId/git/commit',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: ExecuteGitOperationBody;
      }>,
      reply,
    ) => {
      if (!projects.getById(request.params.projectId))
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      return executeConfirmedGitOperationBody({ ...request.body, operation: 'commit' }, reply);
    },
  );

  server.post(
    '/api/projects/:projectId/git/stash',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: ExecuteGitOperationBody;
      }>,
      reply,
    ) => {
      if (!projects.getById(request.params.projectId))
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      return executeConfirmedGitOperationBody({ ...request.body, operation: 'stash' }, reply);
    },
  );

  server.post(
    '/api/projects/:projectId/git/apply-stash',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: ExecuteGitOperationBody;
      }>,
      reply,
    ) => {
      if (!projects.getById(request.params.projectId))
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      return executeConfirmedGitOperationBody({ ...request.body, operation: 'apply_stash' }, reply);
    },
  );

  server.post(
    '/api/projects/:projectId/git/pull',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: ExecuteGitOperationBody;
      }>,
      reply,
    ) => {
      if (!projects.getById(request.params.projectId))
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      return executeConfirmedGitOperationBody({ ...request.body, operation: 'pull' }, reply);
    },
  );

  server.post(
    '/api/projects/:projectId/git/push',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: ExecuteGitOperationBody;
      }>,
      reply,
    ) => {
      if (!projects.getById(request.params.projectId))
        return reply.code(404).send({
          error: 'ZEUS_PROJECT_NOT_FOUND',
          message: 'Project not found',
        });
      return executeConfirmedGitOperationBody({ ...request.body, operation: 'push' }, reply);
    },
  );

  server.post(
    '/api/tasks/:taskId/git/rollback',
    async (
      request: FastifyRequest<{
        Params: { taskId: string };
        Body: ExecuteGitOperationBody;
      }>,
      reply,
    ) => {
      if (!tasks.getById(request.params.taskId)) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
      return executeConfirmedGitOperationBody({ ...request.body, operation: 'rollback' }, reply);
    },
  );

  server.get(
    '/api/settings/runtime-status',
    async (): Promise<RuntimeStatusSnapshot> => ({
      aiCli: await toRuntimeStatus(runtimeSettings),
      telegram: getTelegramConfigurationState(await readTelegramToken(), telegramSecuritySettings.allowedUserIds),
      terminal: runtimeTerminalStatus,
    }),
  );

  async function ensureCodexRemoteControlReady(): Promise<void> {
    await codexAppServerManager.ensureReady({
      commandPath: currentCodexRuntimeCommandPath(),
      ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}),
      ...(codexRemoteControlEnabled ? { remoteControl: true } : {}),
    });
  }

  async function buildCodexRemoteControlSnapshot(status?: CodexRemoteControlStatus): Promise<CodexRemoteControlSnapshot> {
    await ensureCodexRemoteControlReady();
    const currentStatus = status ?? (await codexAppServerManager.readRemoteControlStatus());
    const clients = currentStatus.environmentId ? (await codexAppServerManager.listRemoteControlClients({ environmentId: currentStatus.environmentId, limit: 100, order: 'desc' })).data : [];
    return { enabled: codexRemoteControlEnabled, status: currentStatus, clients };
  }

  server.get('/api/codex/remote-control', async (): Promise<CodexRemoteControlSnapshot> => buildCodexRemoteControlSnapshot());

  server.post('/api/codex/remote-control/enable', async (): Promise<CodexRemoteControlSnapshot> => {
    await ensureCodexRemoteControlReady();
    const status = await codexAppServerManager.enableRemoteControl();
    codexRemoteControlEnabled = true;
    settings.setJson(codexRemoteControlEnabledSettingKey, true);
    auditLogs.append({
      actorType: 'user',
      action: 'codex.remote_control.enabled',
      resourceType: 'settings',
      ...(status.environmentId ? { resourceId: status.environmentId } : {}),
      payload: { status: status.status, serverName: status.serverName },
      createdAt: now().toISOString(),
    });
    await db.save();
    return buildCodexRemoteControlSnapshot(status);
  });

  server.post('/api/codex/remote-control/disable', async (): Promise<CodexRemoteControlSnapshot> => {
    await ensureCodexRemoteControlReady();
    const status = await codexAppServerManager.disableRemoteControl();
    codexRemoteControlEnabled = false;
    settings.setJson(codexRemoteControlEnabledSettingKey, false);
    auditLogs.append({
      actorType: 'user',
      action: 'codex.remote_control.disabled',
      resourceType: 'settings',
      ...(status.environmentId ? { resourceId: status.environmentId } : {}),
      payload: { status: status.status, serverName: status.serverName },
      createdAt: now().toISOString(),
    });
    await db.save();
    return buildCodexRemoteControlSnapshot(status);
  });

  server.post('/api/codex/remote-control/pairing', async (_request, reply): Promise<CodexRemoteControlPairingSnapshot | unknown> => {
    await ensureCodexRemoteControlReady();
    const status = await codexAppServerManager.readRemoteControlStatus();
    if (status.status === 'disabled') {
      return reply.code(409).send({ error: 'ZEUS_CODEX_REMOTE_CONTROL_DISABLED', message: 'Enable Codex Remote Control before pairing a device.' });
    }
    const pairing = await codexAppServerManager.startRemoteControlPairing({ manualCode: true });
    return { ...pairing, claimed: false };
  });

  server.post('/api/codex/remote-control/pairing/status', async (request: FastifyRequest<{ Body: { pairingCode?: string | null; manualPairingCode?: string | null } }>, reply): Promise<{ claimed: boolean } | unknown> => {
    const pairingCode = typeof request.body?.pairingCode === 'string' ? request.body.pairingCode : null;
    const manualPairingCode = typeof request.body?.manualPairingCode === 'string' ? request.body.manualPairingCode : null;
    if (!pairingCode && !manualPairingCode) return reply.code(400).send({ error: 'ZEUS_CODEX_REMOTE_PAIRING_CODE_REQUIRED', message: 'A pairing code is required.' });
    await ensureCodexRemoteControlReady();
    return codexAppServerManager.readRemoteControlPairingStatus(pairingCode ? { pairingCode } : { manualPairingCode });
  });

  server.delete('/api/codex/remote-control/clients/:clientId', async (request: FastifyRequest<{ Params: { clientId: string }; Querystring: { environmentId?: string } }>, reply): Promise<CodexRemoteControlSnapshot | unknown> => {
    const environmentId = request.query.environmentId?.trim();
    const clientId = request.params.clientId?.trim();
    if (!environmentId || !clientId) return reply.code(400).send({ error: 'ZEUS_CODEX_REMOTE_CLIENT_ID_REQUIRED', message: 'Environment and client identifiers are required.' });
    await ensureCodexRemoteControlReady();
    await codexAppServerManager.revokeRemoteControlClient({ environmentId, clientId });
    return buildCodexRemoteControlSnapshot();
  });

  server.get(
    '/api/security/secrets',
    async (): Promise<SecuritySecretsSnapshot> => ({
      telegramBotToken: getSecretPresenceLabel(await readTelegramToken()),
      externalApiKey: getSecretPresenceLabel(await secretStore.getSecret('external.apiKey')),
    }),
  );

  server.get('/api/security/audit-logs', async (): Promise<SecurityAuditLogEntry[]> => auditLogs.listRecent().map(toSecurityAuditLogEntry));

  server.get('/api/release/status', async (): Promise<ReleaseStatusSnapshot> => buildReleaseStatusSnapshot());
  server.get('/api/release/update-status', async () => ({
    ...(await buildReleaseUpdateStatus()),
    executionHost: buildExecutionHostWorkStatusSnapshot(),
  }));
  server.post('/api/release/check-update', async () => ({
    ...(await buildReleaseUpdateStatus()),
    executionHost: buildExecutionHostWorkStatusSnapshot(),
  }));
  server.post('/api/release/download-update', async (): Promise<ReleaseUpdateOperationSnapshot> => {
    const update = {
      ...(await buildReleaseUpdateStatus()),
      executionHost: buildExecutionHostWorkStatusSnapshot(),
    };
    return {
      accepted: false,
      update,
      reason: update.automaticInstallEnabled ? '下载能力已预留，当前版本仍要求用户通过 GitHub Release 或安装脚本完成安装。' : '当前 Release 产物未同时签名和公证，不允许静默下载或自动安装。',
    };
  });
  server.post('/api/release/install-update', async (): Promise<ReleaseUpdateOperationSnapshot> => {
    const update = {
      ...(await buildReleaseUpdateStatus()),
      executionHost: buildExecutionHostWorkStatusSnapshot(),
    };
    return {
      accepted: false,
      update,
      reason: update.automaticInstallEnabled ? '安装能力已预留，正式启用前仍需用户确认安装包来源。' : '当前 Release 产物未同时签名和公证，不允许自动替换本机 App。',
    };
  });

  server.put('/api/security/secrets/telegram-bot-token', async (request: FastifyRequest<{ Body: SaveTelegramTokenBody }>, reply) => {
    const token = request.body?.token?.trim();
    if (!token) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_SECRET',
        message: 'Telegram Bot Token is required',
      });
    }
    await secretStore.setSecret('telegram.botToken', token);
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.secret.telegram_bot_token.saved',
      resourceType: 'secret',
      resourceId: 'telegram.botToken',
      payload: { configured: true, secretValueStored: false },
    });
    await db.save();
    return {
      telegramBotToken: getSecretPresenceLabel(token),
      externalApiKey: getSecretPresenceLabel(await secretStore.getSecret('external.apiKey')),
    };
  });

  server.delete('/api/security/secrets/telegram-bot-token', async () => {
    await secretStore.deleteSecret('telegram.botToken');
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.secret.telegram_bot_token.deleted',
      resourceType: 'secret',
      resourceId: 'telegram.botToken',
      payload: { configured: false },
    });
    await db.save();
    return {
      telegramBotToken: getSecretPresenceLabel(undefined),
      externalApiKey: getSecretPresenceLabel(await secretStore.getSecret('external.apiKey')),
    };
  });

  server.put('/api/security/secrets/external-api-key', async (request: FastifyRequest<{ Body: SaveExternalApiKeyBody }>, reply) => {
    const key = request.body?.key?.trim();
    if (!key) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_SECRET',
        message: 'External API Key is required',
      });
    }
    // 外部 API Key 只进入本机 SecretStore；API/UI 只返回状态，避免明文进入渲染进程状态树。
    await secretStore.setSecret('external.apiKey', key);
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.secret.external_api_key.saved',
      resourceType: 'secret',
      resourceId: 'external.apiKey',
      payload: { configured: true, secretValueStored: false },
    });
    await db.save();
    return {
      telegramBotToken: getSecretPresenceLabel(await readTelegramToken()),
      externalApiKey: getSecretPresenceLabel(key),
    };
  });

  server.delete('/api/security/secrets/external-api-key', async () => {
    await secretStore.deleteSecret('external.apiKey');
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.secret.external_api_key.deleted',
      resourceType: 'secret',
      resourceId: 'external.apiKey',
      payload: { configured: false },
    });
    await db.save();
    return {
      telegramBotToken: getSecretPresenceLabel(await readTelegramToken()),
      externalApiKey: getSecretPresenceLabel(undefined),
    };
  });

  server.post('/api/security/reset', async (): Promise<SecurityResetResult> => {
    await secretStore.deleteSecret('telegram.botToken');
    await secretStore.deleteSecret('external.apiKey');
    for (const project of projects.list()) {
      const secretKey = getProjectDatabasePasswordSecretKey(project.id);
      if (secretKey) await secretStore.deleteSecret(secretKey.key);
    }
    if (telegramPollingTimer) {
      clearInterval(telegramPollingTimer);
      telegramPollingTimer = undefined;
    }
    if (telegramPollingService) await telegramPollingService.stop();
    telegramPollingService = undefined;
    telegramNotificationSettings = {
      enabled: false,
      chatIds: [],
      silentMode: true,
    };
    telegramSecuritySettings = { allowedUserIds: [] };
    settings.setJson(telegramNotificationSettingsKey, telegramNotificationSettings);
    settings.setJson(telegramSecuritySettingsKey, telegramSecuritySettings);
    appendAuditLog({
      actorType: 'local_api',
      action: 'security.reset.completed',
      resourceType: 'security',
      payload: {
        clearedSecrets: ['telegram.botToken', 'external.apiKey', 'project.database.password'],
        telegramNotificationsDisabled: true,
        telegramAllowedUserIdsCleared: true,
      },
    });
    await db.save();
    return {
      secrets: {
        telegramBotToken: getSecretPresenceLabel(undefined),
        externalApiKey: getSecretPresenceLabel(undefined),
      },
      telegramNotificationSettings,
      telegramSecuritySettings,
    };
  });

  server.get('/api/telegram/notification-settings', async (): Promise<TelegramNotificationSettingsSnapshot> => telegramNotificationSettings);

  server.put('/api/telegram/notification-settings', async (request: FastifyRequest<{ Body: UpdateTelegramNotificationSettingsBody }>, reply) => {
    const body = request.body ?? {};
    if (body.chatIds && !body.chatIds.every((chatId) => Number.isInteger(chatId) && chatId > 0)) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_TELEGRAM_NOTIFICATION_SETTINGS',
        message: 'Telegram chatIds must be positive integers',
      });
    }
    telegramNotificationSettings = {
      enabled: body.enabled ?? telegramNotificationSettings.enabled,
      chatIds: body.chatIds ?? telegramNotificationSettings.chatIds,
      silentMode: body.silentMode ?? telegramNotificationSettings.silentMode,
    };
    settings.setJson(telegramNotificationSettingsKey, telegramNotificationSettings);
    await db.save();
    return telegramNotificationSettings;
  });

  server.post('/api/telegram/test', async (_request, reply): Promise<TelegramTestConnectionResult | unknown> => {
    const token = await readTelegramToken();
    const chatIds = telegramNotificationSettings.chatIds;
    if (!token || chatIds.length === 0) {
      return reply.code(400).send({
        error: 'ZEUS_TELEGRAM_UNCONFIGURED',
        message: 'Telegram Bot Token 或通知 Chat ID 未配置。',
      });
    }
    const sender = createTelegramBotMessageClient({ token });
    const sentAt = new Date().toISOString();
    const text = ['Zeus Telegram 测试连接', `时间：${sentAt}`, '这是一条由用户主动触发的真实连接测试，不包含 Token、命令明文或终端输出。'].join('\n');
    try {
      const results = await Promise.all(chatIds.map((chatId) => sendTelegramNotificationWithRetry(sender, chatId, text)));
      const attempts = Math.max(...results.map((result) => result.attempts));
      appendAuditLog({
        actorType: 'local_api',
        action: 'telegram.test.sent',
        resourceType: 'telegram',
        resourceId: 'notification-settings',
        payload: { chatIds, attempts, sentAt },
      });
      await db.save();
      return { ok: true, chatIds, attempts, sentAt };
    } catch (error) {
      const attempts = extractTelegramNotificationAttempts(error);
      appendAuditLog({
        actorType: 'local_api',
        action: 'telegram.test.failed',
        resourceType: 'telegram',
        resourceId: 'notification-settings',
        payload: {
          chatIds,
          attempts,
          error: error instanceof Error ? error.message : String(error),
          sentAt,
        },
      });
      await db.save();
      return reply.code(502).send({
        error: 'ZEUS_TELEGRAM_TEST_FAILED',
        message: error instanceof Error ? error.message : 'Telegram test failed',
        attempts,
      });
    }
  });

  server.get('/api/telegram/security-settings', async (): Promise<TelegramSecuritySettingsSnapshot> => telegramSecuritySettings);

  server.put('/api/telegram/security-settings', async (request: FastifyRequest<{ Body: UpdateTelegramSecuritySettingsBody }>, reply) => {
    const body = request.body ?? {};
    if (body.allowedUserIds && !body.allowedUserIds.every((userId) => Number.isInteger(userId))) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_TELEGRAM_SECURITY_SETTINGS',
        message: 'Telegram allowedUserIds must be integers',
      });
    }
    telegramSecuritySettings = normalizeTelegramSecuritySettings(
      {
        allowedUserIds: body.allowedUserIds ?? telegramSecuritySettings.allowedUserIds,
      },
      telegramSecuritySettings,
    );
    // 白名单是 Telegram 执行权限边界；变更后必须丢弃旧 polling 实例，避免继续沿用旧权限快照。
    if (telegramPollingTimer) {
      clearInterval(telegramPollingTimer);
      telegramPollingTimer = undefined;
    }
    if (telegramPollingService) {
      await telegramPollingService.stop();
      telegramPollingService = undefined;
    }
    settings.setJson(telegramSecuritySettingsKey, telegramSecuritySettings);
    appendAuditLog({
      actorType: 'local_api',
      action: 'telegram.security_settings.updated',
      resourceType: 'telegram',
      resourceId: 'security-settings',
      payload: {
        allowedUserIdsCount: telegramSecuritySettings.allowedUserIds.length,
      },
    });
    await db.save();
    return telegramSecuritySettings;
  });

  server.post('/api/telegram/dispatch-preview', async (request: FastifyRequest<{ Body: TelegramDispatchPreviewBody }>, reply) => {
    if (!(await readTelegramToken())) {
      return reply.code(400).send({
        error: 'ZEUS_TELEGRAM_UNCONFIGURED',
        message: 'Telegram Bot Token 未配置。',
      });
    }
    const body = request.body;
    if (!body || typeof body.updateId !== 'number' || typeof body.chatId !== 'number' || typeof body.userId !== 'number' || typeof body.text !== 'string') {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_TELEGRAM_UPDATE',
        message: 'Telegram update payload is invalid',
      });
    }
    return dispatchTelegramUpdate(body, {
      allowedUserIds: telegramSecuritySettings.allowedUserIds,
    });
  });

  server.get('/api/telegram/status', async (): Promise<TelegramStatusSnapshot> => {
    const state = getTelegramConfigurationState(await readTelegramToken(), telegramSecuritySettings.allowedUserIds);
    return {
      configured: state.enabled,
      reason: state.reason,
      polling: getTelegramPollingService()?.status() ?? {
        running: false,
        offset: 0,
        lastError: null,
        handledUpdates: 0,
      },
      notificationSettings: telegramNotificationSettings,
      securitySettings: telegramSecuritySettings,
    };
  });

  server.patch('/api/telegram/settings', async (request: FastifyRequest<{ Body: UpdateTelegramSettingsBody }>, reply): Promise<TelegramSettingsSnapshot | unknown> => {
    const body = request.body ?? {};
    if (body.chatIds && !body.chatIds.every((chatId) => Number.isInteger(chatId))) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_TELEGRAM_NOTIFICATION_SETTINGS',
        message: 'Telegram chatIds must be integers',
      });
    }
    if (body.allowedUserIds && !body.allowedUserIds.every((userId) => Number.isInteger(userId))) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_TELEGRAM_SECURITY_SETTINGS',
        message: 'Telegram allowedUserIds must be integers',
      });
    }
    telegramNotificationSettings = normalizeTelegramNotificationSettings(
      {
        enabled: body.enabled ?? telegramNotificationSettings.enabled,
        chatIds: body.chatIds ?? telegramNotificationSettings.chatIds,
        silentMode: body.silentMode ?? telegramNotificationSettings.silentMode,
      },
      telegramNotificationSettings,
    );
    telegramSecuritySettings = normalizeTelegramSecuritySettings(
      {
        allowedUserIds: body.allowedUserIds ?? telegramSecuritySettings.allowedUserIds,
      },
      telegramSecuritySettings,
    );
    if (telegramPollingTimer) {
      clearInterval(telegramPollingTimer);
      telegramPollingTimer = undefined;
    }
    if (telegramPollingService) {
      await telegramPollingService.stop();
      telegramPollingService = undefined;
    }
    settings.setJson(telegramNotificationSettingsKey, telegramNotificationSettings);
    settings.setJson(telegramSecuritySettingsKey, telegramSecuritySettings);
    appendAuditLog({
      actorType: 'local_api',
      action: 'telegram.settings.updated',
      resourceType: 'telegram',
      resourceId: 'settings',
      payload: {
        chatIds: telegramNotificationSettings.chatIds,
        allowedUserIdsCount: telegramSecuritySettings.allowedUserIds.length,
        enabled: telegramNotificationSettings.enabled,
        silentMode: telegramNotificationSettings.silentMode,
      },
    });
    await db.save();
    return {
      notificationSettings: telegramNotificationSettings,
      securitySettings: telegramSecuritySettings,
    };
  });

  server.post('/api/telegram/start', async (_request, reply) => {
    const service = await ensureTelegramPollingService(reply);
    if (!service) return;
    const status = await service.start();
    if (!telegramPollingTimer) {
      telegramPollingTimer = setInterval(() => {
        void service.pollOnce();
      }, 30_000);
    }
    return status;
  });

  server.post('/api/telegram/stop', async () => {
    if (telegramPollingTimer) {
      clearInterval(telegramPollingTimer);
      telegramPollingTimer = undefined;
    }
    return getTelegramPollingService() ? getTelegramPollingService()!.stop() : { running: false, offset: 0, lastError: null, handledUpdates: 0 };
  });

  server.get(
    '/api/telegram/polling/status',
    async () =>
      getTelegramPollingService()?.status() ?? {
        running: false,
        offset: 0,
        lastError: null,
        handledUpdates: 0,
      },
  );

  server.get('/api/telegram/polling/logs', async () => getTelegramPollingService()?.logs() ?? []);

  server.get('/api/telegram/messages', async () => {
    // 设计书 API 兼容入口：消息日志来自真实 long polling 审计事件，不单独制造消息记录。
    return getTelegramPollingService()?.logs() ?? [];
  });

  server.post('/api/telegram/polling/start', async (_request, reply) => {
    const service = await ensureTelegramPollingService(reply);
    if (!service) return;
    const status = await service.start();
    if (!telegramPollingTimer) {
      telegramPollingTimer = setInterval(() => {
        void service.pollOnce();
      }, 30_000);
    }
    return status;
  });

  server.post('/api/telegram/polling/poll-once', async (_request, reply) => {
    const service = await ensureTelegramPollingService(reply);
    if (!service) return;
    return service.pollOnce();
  });

  server.post('/api/telegram/polling/stop', async () => {
    if (telegramPollingTimer) {
      clearInterval(telegramPollingTimer);
      telegramPollingTimer = undefined;
    }
    return getTelegramPollingService() ? getTelegramPollingService()!.stop() : { running: false, offset: 0, lastError: null, handledUpdates: 0 };
  });

  server.addHook('onClose', async () => {
    const cleanupErrors: unknown[] = [];
    commandCenter.close();
    if (telegramPollingTimer) {
      clearInterval(telegramPollingTimer);
      telegramPollingTimer = undefined;
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
    try {
      await Promise.all(runtimePersistenceWrites);
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
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Zeus local-server shutdown cleanup failed.');
  });

  async function executeConfirmedGitOperationBody(body: ExecuteGitOperationBody | undefined, reply: FastifyReply): Promise<unknown> {
    if (!body?.confirmationId || !body.operation) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_GIT_OPERATION',
        message: 'confirmationId and operation are required',
      });
    }
    if (!isHighRiskGitOperation(body.operation)) {
      return reply.code(400).send({
        error: 'ZEUS_INVALID_GIT_OPERATION',
        message: 'Git operation must be commit, stash, apply_stash, rollback, branch, pull or push',
      });
    }
    const confirmation = gitConfirmations.get(body.confirmationId);
    if (!confirmation) {
      return reply.code(404).send({
        error: 'ZEUS_GIT_CONFIRMATION_NOT_FOUND',
        message: 'Git confirmation not found',
      });
    }
    if (consumedGitConfirmationIds.has(confirmation.id)) {
      return reply.code(409).send({
        error: 'ZEUS_GIT_CONFIRMATION_ALREADY_CONSUMED',
        message: 'Git confirmation has already been consumed by an operation',
      });
    }
    if (confirmation.status !== 'confirmed') {
      return reply.code(409).send({
        error: 'ZEUS_GIT_CONFIRMATION_NOT_CONFIRMED',
        message: 'Git operation requires a confirmed confirmation',
      });
    }
    if (confirmation.operation !== body.operation) {
      return reply.code(400).send({
        error: 'ZEUS_GIT_OPERATION_MISMATCH',
        message: 'Git operation must match the confirmed operation',
      });
    }
    try {
      const result = await executeHighRiskGitOperation({
        confirmation,
        operation: body.operation,
        message: body.message,
        branchName: body.branchName,
        baseRef: body.baseRef,
        stashRef: body.stashRef,
        remote: body.remote,
        targetRef: body.targetRef,
      });
      consumedGitConfirmationIds.add(confirmation.id);
      appendAuditLog({
        actorType: 'local_api',
        action: 'git.operation.executed',
        resourceType: 'git_confirmation',
        resourceId: confirmation.id,
        payload: {
          operation: result.operation,
          cwd: result.cwd,
          args: result.args,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
        },
        createdAt: now().toISOString(),
      });
      await db.save();
      return result;
    } catch (error) {
      return reply.code(400).send({
        error: 'ZEUS_GIT_OPERATION_REJECTED',
        message: error instanceof Error ? error.message : 'Git operation rejected',
      });
    }
  }

  async function readTelegramToken(): Promise<string | undefined> {
    return options.telegramToken ?? (await secretStore.getSecret('telegram.botToken'));
  }

  async function notifyTelegramTaskStatus(task: ZeusTaskRecord, status: TaskStatus): Promise<void> {
    const title = telegramTaskNotificationTitle(status);
    if (!title) return;
    const token = await readTelegramToken();
    const chatIds = telegramNotificationSettings.chatIds;
    if (!telegramNotificationSettings.enabled || (telegramNotificationSettings.silentMode && !isCriticalTelegramTaskStatus(status))) return;
    if (!token || chatIds.length === 0) return;
    const sender = createTelegramBotMessageClient({ token });
    const project = projects.getById(task.projectId);
    const text = [`Zeus ${title}`, `任务：${task.title} (${task.id})`, `状态：${status}`, project ? `项目：${project.name}` : `项目：${task.projectId}`].join('\n');
    try {
      const results = await Promise.all(chatIds.map((chatId) => sendTelegramNotificationWithRetry(sender, chatId, text)));
      recordTaskEvent({
        taskId: task.id,
        eventType: 'telegram.notification.sent',
        title: 'Telegram 通知已发送',
        payload: {
          status,
          chatIds,
          notificationTitle: title,
          attempts: Math.max(...results.map((result) => result.attempts)),
        },
      });
    } catch (error) {
      const attempts = extractTelegramNotificationAttempts(error);
      recordTaskEvent({
        taskId: task.id,
        eventType: 'telegram.notification.failed',
        title: 'Telegram 通知发送失败',
        payload: {
          status,
          attempts,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async function sendTelegramNotificationWithRetry(sender: TelegramMessageSender, chatId: number, text: string): Promise<{ attempts: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= telegramNotificationMaxAttempts; attempt += 1) {
      try {
        // Telegram Bot API 偶发网络抖动时重试，避免任务关键状态通知被一次失败直接吞掉。
        await sender.sendMessage(chatId, text);
        return { attempts: attempt };
      } catch (error) {
        lastError = error;
      }
    }
    throw Object.assign(lastError instanceof Error ? lastError : new Error(String(lastError)), { attempts: telegramNotificationMaxAttempts });
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
    if (!telegramNotificationSettings.enabled || telegramNotificationSettings.silentMode) return;
    const token = await readTelegramToken();
    const chatIds = telegramNotificationSettings.chatIds;
    if (!token || chatIds.length === 0) return;
    const logs = runtimeSessions.listLogs(log.sessionId);
    const logCount = logs.length;
    if (logCount === 0 || logCount % telegramRuntimeSummaryLogInterval !== 0) return;
    const sentCounts = telegramRuntimeSummarySentLogCounts.get(log.sessionId) ?? new Set<number>();
    if (sentCounts.has(logCount)) return;
    sentCounts.add(logCount);
    telegramRuntimeSummarySentLogCounts.set(log.sessionId, sentCounts);

    const task = tasks.getById(session.taskId);
    if (!task) return;
    const recentLogs = logs
      .slice(-telegramRuntimeSummaryLogInterval)
      .map((entry) => `${entry.stream}: ${entry.text}`)
      .join('\n')
      .slice(0, 1200);
    const text = ['Zeus Runtime 阶段摘要', `任务：${task.title} (${task.id})`, `会话：${session.id}`, `日志数：${logCount}`, '最近真实日志：', recentLogs].join('\n');
    const sender = createTelegramBotMessageClient({ token });
    try {
      const results = await Promise.all(chatIds.map((chatId) => sendTelegramNotificationWithRetry(sender, chatId, text)));
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

  function normalizeTelegramNotificationSettings(value: TelegramNotificationSettingsSnapshot | undefined, fallback: TelegramNotificationSettingsSnapshot): TelegramNotificationSettingsSnapshot {
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

  function normalizeTelegramSecuritySettings(value: TelegramSecuritySettingsSnapshot | undefined, fallback: TelegramSecuritySettingsSnapshot): TelegramSecuritySettingsSnapshot {
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

  function normalizeImportedTelegramNotificationSettings(value: TelegramNotificationSettingsSnapshot | undefined): TelegramNotificationSettingsSnapshot | null {
    if (!value || !Array.isArray(value.chatIds)) return null;
    if (!value.chatIds.every((chatId) => Number.isInteger(chatId) && chatId > 0)) return null;
    // Telegram 通知导入只恢复 chat id、启用状态和静默状态；Bot Token 仍必须留在 Keychain，不进入快照。
    return normalizeTelegramNotificationSettings(value, telegramNotificationSettings);
  }

  function normalizeImportedTelegramSecuritySettings(value: TelegramSecuritySettingsSnapshot | undefined): TelegramSecuritySettingsSnapshot | null {
    if (!value || !Array.isArray(value.allowedUserIds)) return null;
    if (!value.allowedUserIds.every((userId) => Number.isInteger(userId) && userId > 0)) return null;
    // 白名单是远程执行安全边界，允许通过脱敏设置快照迁移，但不接受非正整数或其它权限字段。
    return normalizeTelegramSecuritySettings(value, telegramSecuritySettings);
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

  function normalizeCodeMapSettings(value: unknown): CodeMapSettingsSnapshot | null {
    if (value === undefined) return defaultCodeMapSettings;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as UpdateCodeMapSettingsBody;
    const defaultScanScope = isCodeMapScanScope(raw.defaultScanScope) ? raw.defaultScanScope : defaultCodeMapSettings.defaultScanScope;
    const defaultIgnoreDirectories = normalizeCodeMapIgnoreDirectories(raw.defaultIgnoreDirectories);
    const maxCallChainDepth = normalizeIntegerRange(raw.maxCallChainDepth, defaultCodeMapSettings.maxCallChainDepth, 1, 10);
    if (!defaultIgnoreDirectories || maxCallChainDepth === null) return null;
    const layoutAlgorithm = isCodeMapLayoutAlgorithm(raw.layoutAlgorithm) ? raw.layoutAlgorithm : defaultCodeMapSettings.layoutAlgorithm;
    const graphCacheStrategy = isGraphCacheStrategy(raw.graphCacheStrategy) ? raw.graphCacheStrategy : defaultCodeMapSettings.graphCacheStrategy;
    const tableRelationInference = isTableRelationInference(raw.tableRelationInference) ? raw.tableRelationInference : defaultCodeMapSettings.tableRelationInference;
    const moduleFlowManualNotes = normalizeCodeMapManualNotes(raw.moduleFlowManualNotes);
    if (moduleFlowManualNotes === null) return null;
    return {
      defaultScanScope,
      defaultIgnoreDirectories,
      maxCallChainDepth,
      showLowConfidenceEdges: raw.showLowConfidenceEdges === true,
      layoutAlgorithm,
      graphCacheStrategy,
      tableRelationInference,
      aiSummaryEnabled: raw.aiSummaryEnabled === true,
      incrementalScanEnabled: raw.incrementalScanEnabled !== false,
      performanceMonitoringEnabled: raw.performanceMonitoringEnabled === true,
      moduleFlowManualNotes,
    };
  }

  function normalizeCodeMapManualNotes(value: unknown): string | null {
    if (value === undefined) return defaultCodeMapSettings.moduleFlowManualNotes;
    if (typeof value !== 'string') return null;
    // 人工流程草稿只保存本机说明，不参与图谱事实生成；限制长度避免设置快照被日志/大文本污染。
    if (value.includes('\u0000') || value.length > 4000) return null;
    return value.trim();
  }

  function normalizeCodeMapIgnoreDirectories(value: unknown): string[] | null {
    if (value === undefined) return defaultCodeMapSettings.defaultIgnoreDirectories;
    if (!Array.isArray(value)) return null;
    const seen = new Set<string>();
    const items: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') return null;
      const directory = item.trim();
      if (!isSafeCodeMapIgnoreDirectory(directory)) return null;
      if (!seen.has(directory)) {
        seen.add(directory);
        items.push(directory);
      }
    }
    return items;
  }

  function isSafeCodeMapIgnoreDirectory(value: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..') && value.length > 0 && value.length <= 80;
  }

  function normalizeIntegerRange(value: unknown, fallback: number, min: number, max: number): number | null {
    if (value === undefined) return fallback;
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
  }

  function isCodeMapScanScope(value: unknown): value is CodeMapSettingsSnapshot['defaultScanScope'] {
    return value === 'project' || value === 'src' || value === 'custom';
  }

  function isCodeMapLayoutAlgorithm(value: unknown): value is CodeMapSettingsSnapshot['layoutAlgorithm'] {
    return value === 'hierarchical' || value === 'force' || value === 'dagre';
  }

  function isGraphCacheStrategy(value: unknown): value is CodeMapSettingsSnapshot['graphCacheStrategy'] {
    return value === 'sqlite' || value === 'memory' || value === 'disabled';
  }

  function isTableRelationInference(value: unknown): value is CodeMapSettingsSnapshot['tableRelationInference'] {
    return value === 'foreign_key_and_name' || value === 'foreign_key_only' || value === 'name_only' || value === 'disabled';
  }

  /** 根据真实项目根目录中的 manifest 文件生成默认项目配置；只读取存在性，不创建任务、不执行扫描。 */

  /** 校验项目路径必须是真实存在且可读的本地目录，避免创建指向不存在路径的假项目。 */
  function validateReadableProjectDirectory(localPath: string): { valid: true; localPath: string } | { valid: false; message: string } {
    try {
      const canonicalPath = normalizeProjectDirectoryPath(localPath);
      if (!statSync(canonicalPath).isDirectory()) {
        return {
          valid: false,
          message: 'Project localPath must point to an existing directory',
        };
      }
      accessSync(canonicalPath, fsConstants.R_OK);
      return { valid: true, localPath: canonicalPath };
    } catch {
      return {
        valid: false,
        message: 'Project localPath must exist and be readable',
      };
    }
  }

  function normalizeProjectMemberDirectories(project: ZeusProjectRecord, values: Array<{ localPath?: unknown }> | undefined, kind: 'repository' | 'shared'): Array<{ localPath: string; relativePath: string }> {
    if (!Array.isArray(values)) throw nativeApiError('ZEUS_PROJECT_WORKSPACE_CONFIG_INVALID', 'repositories and sharedWritablePaths must both be arrays.');
    const projectRoot = realpathSync(project.localPath);
    const seen = new Set<string>();
    return values.map((value, index) => {
      if (!value || typeof value.localPath !== 'string' || !value.localPath.trim()) {
        throw nativeApiError('ZEUS_PROJECT_WORKSPACE_PATH_REQUIRED', `Workspace path ${index + 1} is required.`);
      }
      const requestedPath = isAbsolute(value.localPath.trim()) ? value.localPath.trim() : join(projectRoot, value.localPath.trim());
      let localPath: string;
      try {
        localPath = realpathSync(requestedPath);
      } catch {
        throw nativeApiError('ZEUS_PROJECT_WORKSPACE_PATH_INVALID', `Workspace path does not exist: ${value.localPath}`);
      }
      if (!statSync(localPath).isDirectory() || !isPathInsideRoot(localPath, projectRoot)) {
        throw nativeApiError('ZEUS_PROJECT_WORKSPACE_PATH_OUTSIDE_CONTAINER', `Workspace path must be a directory inside the project container: ${value.localPath}`);
      }
      if (kind === 'shared' && localPath === projectRoot) {
        throw nativeApiError('ZEUS_PROJECT_SHARED_PATH_TOO_BROAD', 'The whole project container cannot be registered as a shared writable path.');
      }
      if (seen.has(localPath)) throw nativeApiError('ZEUS_PROJECT_WORKSPACE_PATH_DUPLICATE', `Workspace path is duplicated: ${value.localPath}`);
      seen.add(localPath);
      const relativePath = relative(projectRoot, localPath).split(sep).join('/') || '.';
      return { localPath, relativePath };
    });
  }

  function assertProjectMemberPathsDoNotOverlap(paths: string[], message: string): void {
    for (let index = 0; index < paths.length; index += 1) {
      for (let candidateIndex = index + 1; candidateIndex < paths.length; candidateIndex += 1) {
        const left = paths[index]!;
        const right = paths[candidateIndex]!;
        if (isPathInsideRoot(left, right) || isPathInsideRoot(right, left)) {
          throw nativeApiError('ZEUS_PROJECT_WORKSPACE_PATH_OVERLAP', message);
        }
      }
    }
  }

  /** 旧项目级 Git 页面没有仓库选择器；多仓配置下必须明确暴露能力边界。 */
  function resolveProjectGitScope(project: ZeusProjectRecord): { path: string } | { limitation: string } {
    const repositories = projectRepositories.listByProject(project.id);
    if (repositories.length === 0) {
      if (!existsSync(join(project.localPath, '.git'))) {
        return { limitation: '项目目录不是已登记的 Git 根；如项目包含嵌套仓库，请先在项目设置中确认任务仓库。' };
      }
      return { path: project.localPath };
    }
    if (repositories.length === 1 && resolve(repositories[0]!.localPath) === resolve(project.localPath)) {
      return { path: repositories[0]!.localPath };
    }
    return { limitation: '项目级 Git 页面暂不支持多仓或嵌套仓库；请在任务的代码交付中逐仓操作。' };
  }

  function unsupportedProjectGitStatus(limitation: string): GitStatusSummary & { limitation: string } {
    return {
      isRepository: false,
      branch: '',
      clean: true,
      changedFiles: [],
      conflictFiles: [],
      fileStatuses: [],
      remoteBranches: [],
      recentCommits: [],
      limitation,
    };
  }

  function normalizeProjectDirectoryPath(localPath: string): string {
    const absolutePath = resolve(localPath.trim());
    if (absolutePath === '/') return absolutePath;
    return absolutePath.replace(/\/+$/u, '');
  }

  function detectProjectConfigFromLocalFiles(projectId: string, projectLocalPath: string): ProjectConfigSnapshot {
    const config = createDefaultProjectConfig(projectId);
    const has = (relativePath: string): boolean => existsSync(join(projectLocalPath, relativePath));
    const gitRoot = detectGitRoot(projectLocalPath);
    const manifestPaths: string[] = [];
    const addManifest = (relativePath: string): void => {
      if (has(relativePath)) manifestPaths.push(relativePath);
    };

    addManifest('package.json');
    addManifest('pnpm-workspace.yaml');
    addManifest('pnpm-lock.yaml');
    addManifest('package-lock.json');
    addManifest('yarn.lock');
    addManifest('tsconfig.json');
    addManifest('pom.xml');
    addManifest('build.gradle');
    addManifest('build.gradle.kts');
    addManifest('settings.gradle');
    addManifest('settings.gradle.kts');

    const packageManagers: string[] = [];
    const addPackageManager = (name: string): void => {
      if (!packageManagers.includes(name)) packageManagers.push(name);
    };
    if (has('pnpm-workspace.yaml') || has('pnpm-lock.yaml')) addPackageManager('pnpm');
    if (has('package-lock.json')) addPackageManager('npm');
    if (has('yarn.lock')) addPackageManager('yarn');
    if (has('pom.xml')) addPackageManager('maven');
    if (has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts')) addPackageManager('gradle');

    const hasNodeManifest = has('package.json') || has('tsconfig.json');
    const hasJavaManifest = has('pom.xml') || has('build.gradle') || has('build.gradle.kts');
    const primary = hasJavaManifest && !hasNodeManifest ? 'java' : 'typescript';
    const additional: string[] = [];
    if (hasNodeManifest) additional.push('javascript');
    if (hasJavaManifest && primary !== 'java') additional.push('java');

    return {
      ...config,
      language: { primary, additional },
      dependencies: { packageManagers, manifestPaths },
      vcs: { isGitRepository: gitRoot !== null, gitRoot },
    };
  }

  /** 从项目目录向上寻找 .git，支持 workspace 子目录作为项目根的真实仓库场景。 */
  function detectGitRoot(projectLocalPath: string): string | null {
    let currentPath = resolve(projectLocalPath);
    while (true) {
      if (existsSync(join(currentPath, '.git'))) return currentPath;
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) return null;
      currentPath = parentPath;
    }
  }

  function normalizeRuntimeSettings(value: RuntimeSettingsSnapshot | undefined): RuntimeSettingsSnapshot {
    if (!value || !isRuntimeAdapterId(value.defaultAdapterId)) return defaultRuntimeSettings;
    return {
      defaultAdapterId: value.defaultAdapterId,
      adapterModels: normalizeRuntimeAdapterModels(value.adapterModels) ?? {},
      adapterDefaultArgs: normalizeRuntimeAdapterDefaultArgs(value.adapterDefaultArgs) ?? {},
      adapterCliPaths: normalizeRuntimeAdapterCliPaths(value.adapterCliPaths) ?? {},
      terminalEnv: normalizeRuntimeTerminalEnv(value.terminalEnv) ?? {},
      shell: normalizeRuntimeShellSettings(value.shell) ?? defaultRuntimeSettings.shell,
      concurrency: normalizeRuntimeConcurrencySettings(value.concurrency) ?? defaultRuntimeSettings.concurrency,
      executionTimeoutSeconds: normalizeRuntimeExecutionTimeoutSeconds(value.executionTimeoutSeconds) ?? defaultRuntimeSettings.executionTimeoutSeconds,
      logRetentionDays: normalizeRuntimeLogRetentionDays(value.logRetentionDays) ?? defaultRuntimeSettings.logRetentionDays,
      autoConfirmationPolicy: normalizeRuntimeAutoConfirmationPolicy(value.autoConfirmationPolicy) ?? defaultRuntimeSettings.autoConfirmationPolicy,
    };
  }

  function normalizeImportedRuntimeSettings(value: RuntimeSettingsSnapshot | undefined): RuntimeSettingsSnapshot | null {
    if (!value || !isRuntimeAdapterId(value.defaultAdapterId) || value.defaultAdapterId === 'generic') return null;
    const adapterModels = normalizeRuntimeAdapterModels(value.adapterModels);
    const adapterDefaultArgs = normalizeRuntimeAdapterDefaultArgs(value.adapterDefaultArgs);
    const adapterCliPaths = normalizeRuntimeAdapterCliPaths(value.adapterCliPaths);
    const terminalEnv = normalizeRuntimeTerminalEnv(value.terminalEnv);
    const shell = normalizeRuntimeShellSettings(value.shell);
    const concurrency = normalizeRuntimeConcurrencySettings(value.concurrency);
    const executionTimeoutSeconds = normalizeRuntimeExecutionTimeoutSeconds(value.executionTimeoutSeconds);
    const logRetentionDays = normalizeRuntimeLogRetentionDays(value.logRetentionDays);
    const autoConfirmationPolicy = normalizeRuntimeAutoConfirmationPolicy(value.autoConfirmationPolicy);
    if (!adapterModels || !adapterDefaultArgs || !adapterCliPaths || !terminalEnv || !shell || !concurrency || executionTimeoutSeconds === null || logRetentionDays === null || autoConfirmationPolicy === null) {
      return null;
    }
    // 设置快照导入只恢复安全的本机偏好；Generic shell 不能被导入为默认 adapter，避免绕过显式确认。
    return {
      defaultAdapterId: value.defaultAdapterId,
      adapterModels,
      adapterDefaultArgs,
      adapterCliPaths,
      terminalEnv,
      shell,
      concurrency,
      executionTimeoutSeconds,
      logRetentionDays,
      autoConfirmationPolicy,
    };
  }

  function normalizeAppShellSettings(value: AppShellSettingsSnapshot | undefined, fallbackLogDirectory: string, fallbackConfigPath: string): AppShellSettingsSnapshot {
    const appearance: AppAppearance = value?.appearance === 'light' || value?.appearance === 'dark' || value?.appearance === 'system' ? value.appearance : 'system';
    const appLanguage: AppLanguage = value?.appLanguage === 'en-US' ? 'en-US' : 'zh-CN';
    const taskManagementStatusTemplate = normalizeTaskManagementStatusConfig(value?.taskManagementStatusTemplate, defaultTaskManagementStatusConfig);
    return {
      appLanguage,
      appearance,
      webviewDebugEnabled: value?.webviewDebugEnabled === true,
      developerModeEnabled: value?.developerModeEnabled === true,
      multiWindowEnabled: typeof value?.multiWindowEnabled === 'boolean' ? value.multiWindowEnabled : true,
      backgroundModeEnabled: typeof value?.backgroundModeEnabled === 'boolean' ? value.backgroundModeEnabled : true,
      desktopNotificationsEnabled: typeof value?.desktopNotificationsEnabled === 'boolean' ? value.desktopNotificationsEnabled : true,
      openAtLoginEnabled: typeof value?.openAtLoginEnabled === 'boolean' ? value.openAtLoginEnabled : false,
      autoUpdateChannel: 'manual',
      defaultProjectId: normalizeDefaultProjectId(value?.defaultProjectId),
      pinnedProjectIds: normalizeProjectPreferenceIds(value?.pinnedProjectIds),
      collapsedProjectIds: normalizeProjectPreferenceIds(value?.collapsedProjectIds),
      defaultModel: normalizeAppShellDefaultModel(value?.defaultModel),
      defaultTaskTemplateId: normalizeDefaultTaskTemplateId(value?.defaultTaskTemplateId),
      taskTableColumns: normalizeTaskTableColumnPreferences(value?.taskTableColumns),
      taskTableColumnsByProject: normalizeTaskTableColumnsByProject(value?.taskTableColumnsByProject),
      taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders(value?.taskTableEnumSortOrders),
      taskManagementStatusTemplate,
      taskManagementStatusByProject: normalizeTaskManagementStatusByProject(value?.taskManagementStatusByProject, taskManagementStatusTemplate),
      taskStatusFilterByProject: normalizeTaskStatusFilterByProject(value?.taskStatusFilterByProject),
      taskViewModeByProject: normalizeTaskViewModeByProject(value?.taskViewModeByProject),
      taskExpandedIdsByProject: normalizeTaskExpandedIdsByProject(value?.taskExpandedIdsByProject),
      localLogDirectory: fallbackLogDirectory,
      // 本地配置文件路径由当前运行实例决定，不接受导入文件覆盖，避免误指向其他机器路径。
      localConfigPath: fallbackConfigPath,
      dataPortability: {
        importSupported: true,
        exportSupported: true,
        redactsSecrets: true,
      },
      cache: { codeIndex: true, graphView: true, layout: true },
      lastCacheClearAt: typeof value?.lastCacheClearAt === 'string' ? value.lastCacheClearAt : null,
    };
  }

  function patchAppShellSettings(current: AppShellSettingsSnapshot, input: UpdateAppShellSettingsBody): AppShellSettingsSnapshot {
    return normalizeAppShellSettings(
      {
        ...current,
        appLanguage: input.appLanguage === 'en-US' || input.appLanguage === 'zh-CN' ? input.appLanguage : current.appLanguage,
        appearance: input.appearance ?? current.appearance,
        webviewDebugEnabled: typeof input.webviewDebugEnabled === 'boolean' ? input.webviewDebugEnabled : current.webviewDebugEnabled,
        developerModeEnabled: typeof input.developerModeEnabled === 'boolean' ? input.developerModeEnabled : current.developerModeEnabled,
        multiWindowEnabled: typeof input.multiWindowEnabled === 'boolean' ? input.multiWindowEnabled : current.multiWindowEnabled,
        backgroundModeEnabled: typeof input.backgroundModeEnabled === 'boolean' ? input.backgroundModeEnabled : current.backgroundModeEnabled,
        desktopNotificationsEnabled: typeof input.desktopNotificationsEnabled === 'boolean' ? input.desktopNotificationsEnabled : current.desktopNotificationsEnabled,
        openAtLoginEnabled: typeof input.openAtLoginEnabled === 'boolean' ? input.openAtLoginEnabled : current.openAtLoginEnabled,
        autoUpdateChannel: 'manual',
        defaultProjectId: input.defaultProjectId === null ? null : typeof input.defaultProjectId === 'string' ? input.defaultProjectId : current.defaultProjectId,
        pinnedProjectIds: Array.isArray(input.pinnedProjectIds) ? normalizeProjectPreferenceIds(input.pinnedProjectIds) : current.pinnedProjectIds,
        collapsedProjectIds: Array.isArray(input.collapsedProjectIds) ? normalizeProjectPreferenceIds(input.collapsedProjectIds) : current.collapsedProjectIds,
        defaultModel: input.defaultModel === null ? null : typeof input.defaultModel === 'string' ? input.defaultModel : current.defaultModel,
        defaultTaskTemplateId: input.defaultTaskTemplateId === null ? null : typeof input.defaultTaskTemplateId === 'string' ? input.defaultTaskTemplateId : current.defaultTaskTemplateId,
        // taskTableColumns 支持局部保存；columnWidths 只有显式传入时才替换，空对象用于明确恢复默认列宽。
        taskTableColumns: input.taskTableColumns
          ? normalizeTaskTableColumnPreferences({
              ...current.taskTableColumns,
              ...input.taskTableColumns,
              columnWidths: Object.prototype.hasOwnProperty.call(input.taskTableColumns, 'columnWidths') ? input.taskTableColumns.columnWidths : current.taskTableColumns.columnWidths,
            })
          : current.taskTableColumns,
        taskTableColumnsByProject: Object.prototype.hasOwnProperty.call(input, 'taskTableColumnsByProject') ? normalizeTaskTableColumnsByProject(input.taskTableColumnsByProject) : current.taskTableColumnsByProject,
        taskTableEnumSortOrders: Object.prototype.hasOwnProperty.call(input, 'taskTableEnumSortOrders') ? normalizeTaskTableEnumSortOrders(input.taskTableEnumSortOrders) : current.taskTableEnumSortOrders,
        taskManagementStatusTemplate: Object.prototype.hasOwnProperty.call(input, 'taskManagementStatusTemplate') ? normalizeTaskManagementStatusConfig(input.taskManagementStatusTemplate, current.taskManagementStatusTemplate) : current.taskManagementStatusTemplate,
        taskManagementStatusByProject: Object.prototype.hasOwnProperty.call(input, 'taskManagementStatusByProject')
          ? normalizeTaskManagementStatusByProject(input.taskManagementStatusByProject, Object.prototype.hasOwnProperty.call(input, 'taskManagementStatusTemplate') ? normalizeTaskManagementStatusConfig(input.taskManagementStatusTemplate, current.taskManagementStatusTemplate) : current.taskManagementStatusTemplate)
          : current.taskManagementStatusByProject,
        taskStatusFilterByProject: Object.prototype.hasOwnProperty.call(input, 'taskStatusFilterByProject') ? normalizeTaskStatusFilterByProject(input.taskStatusFilterByProject) : current.taskStatusFilterByProject,
        taskViewModeByProject: Object.prototype.hasOwnProperty.call(input, 'taskViewModeByProject') ? normalizeTaskViewModeByProject(input.taskViewModeByProject) : current.taskViewModeByProject,
        taskExpandedIdsByProject: Object.prototype.hasOwnProperty.call(input, 'taskExpandedIdsByProject') ? normalizeTaskExpandedIdsByProject(input.taskExpandedIdsByProject) : current.taskExpandedIdsByProject,
      },
      current.localLogDirectory,
      current.localConfigPath,
    );
  }

  function normalizeAppShellDefaultModel(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return null;
    const model = value.trim();
    // 通用默认模型只是本机偏好，限制为短单行文本，避免污染日志或后续 Runtime 参数展示。
    if (!model || model.length > 128 || hasControlCharacter(model)) return null;
    return model;
  }

  function normalizeProjectPreferenceIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (!id || id.length > 120 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids.slice(0, 100);
  }

  function normalizeDefaultProjectId(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return null;
    // 默认项目只能引用真实已连接项目；导入或保存未知 ID 时不创建占位项目。
    return projects.getById(value) ? value : null;
  }

  function normalizeDefaultTaskTemplateId(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return null;
    // 默认任务模板只能引用真实存在的模板；保存或导入未知 ID 时不创建占位模板。
    return taskTemplates.getById(value) ? value : null;
  }

  function normalizeRuntimeAutoConfirmationPolicy(value: unknown): RuntimeAutoConfirmationPolicy | null {
    if (value === undefined) return defaultRuntimeSettings.autoConfirmationPolicy;
    return value === 'never' || value === 'low_risk_only' ? value : null;
  }

  function normalizeRuntimeAdapterModels(value: unknown): RuntimeSettingsSnapshot['adapterModels'] | null {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const adapterModels: RuntimeSettingsSnapshot['adapterModels'] = {};
    for (const [adapterId, rawModel] of Object.entries(value)) {
      if (!isRuntimeAdapterId(adapterId)) return null;
      if (typeof rawModel !== 'string') return null;
      const model = rawModel.trim();
      if (!model) continue;
      // 模型名会进入本机 CLI 参数，只允许短单行文本，避免控制字符污染日志或命令展示。
      if (model.length > 128 || hasControlCharacter(model)) return null;
      adapterModels[adapterId] = model;
    }
    return adapterModels;
  }

  function normalizeRuntimeAdapterDefaultArgs(value: unknown): RuntimeSettingsSnapshot['adapterDefaultArgs'] | null {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const adapterArgs: RuntimeSettingsSnapshot['adapterDefaultArgs'] = {};
    for (const [adapterId, rawArgs] of Object.entries(value)) {
      if (!isRuntimeAdapterId(adapterId)) return null;
      if (!Array.isArray(rawArgs)) return null;
      const args = rawArgs.map((arg) => (typeof arg === 'string' ? arg.trim() : null));
      if (args.some((arg) => !arg || arg.length > 128 || hasControlCharacter(arg))) return null;
      if (args.length > 16) return null;
      if (args.length > 0) adapterArgs[adapterId] = args as string[];
    }
    return adapterArgs;
  }

  function normalizeRuntimeAdapterCliPaths(value: unknown): RuntimeSettingsSnapshot['adapterCliPaths'] | null {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const cliPaths: RuntimeSettingsSnapshot['adapterCliPaths'] = {};
    for (const [adapterId, rawPath] of Object.entries(value)) {
      if (!isRuntimeAdapterId(adapterId) || adapterId === 'generic') return null;
      if (typeof rawPath !== 'string') return null;
      const cliPath = rawPath.trim();
      if (!cliPath) continue;
      // CLI 路径只接受本机绝对路径；不检查存在性，避免把“已配置路径”伪造成“已安装/已登录”。
      if (!cliPath.startsWith('/') || cliPath.length > 256 || hasControlCharacter(cliPath)) return null;
      const basenameAdapter = listAiCliAdapters().find((adapter) => adapter.command === parse(cliPath).base);
      if (basenameAdapter && basenameAdapter.id !== adapterId) return null;
      cliPaths[adapterId] = cliPath;
    }
    return cliPaths;
  }

  function normalizeRuntimeTerminalEnv(value: unknown): RuntimeSettingsSnapshot['terminalEnv'] | null {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const env: RuntimeSettingsSnapshot['terminalEnv'] = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(rawKey) || rawKey.length > 64) return null;
      if (typeof rawValue !== 'string') return null;
      const valueText = rawValue.trim();
      if (!valueText) continue;
      // 环境变量会进入真实子进程，限制为单行短文本，避免控制字符污染终端和日志。
      if (valueText.length > 512 || hasControlCharacter(valueText)) return null;
      env[rawKey] = valueText;
    }
    return env;
  }

  function normalizeRuntimeShellSettings(value: unknown): RuntimeSettingsSnapshot['shell'] | null {
    if (value === undefined) return defaultRuntimeSettings.shell;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as { path?: unknown; login?: unknown };
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (path && (!path.startsWith('/') || path.length > 256 || hasControlCharacter(path))) return null;
    return {
      path: path || null,
      login: raw.login === true,
    };
  }

  function normalizeRuntimeConcurrencySettings(value: unknown): RuntimeSettingsSnapshot['concurrency'] | null {
    if (value === undefined) return defaultRuntimeSettings.concurrency;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as { maxPerProject?: unknown; maxGlobal?: unknown };
    const maxPerProject = normalizeRuntimeConcurrencyLimit(raw.maxPerProject, defaultRuntimeSettings.concurrency.maxPerProject);
    const maxGlobal = normalizeRuntimeConcurrencyLimit(raw.maxGlobal, defaultRuntimeSettings.concurrency.maxGlobal);
    if (maxPerProject === null || maxGlobal === null || maxGlobal < maxPerProject) return null;
    return { maxPerProject, maxGlobal };
  }

  function normalizeRuntimeConcurrencyLimit(value: unknown, fallback: number): number | null {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 20) return null;
    return value;
  }

  function normalizeRuntimeExecutionTimeoutSeconds(value: unknown): number | null {
    if (value === undefined) return defaultRuntimeSettings.executionTimeoutSeconds;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 60 || value > 86_400) return null;
    return value;
  }

  function normalizeRuntimeLogRetentionDays(value: unknown): number | null {
    if (value === undefined) return defaultRuntimeSettings.logRetentionDays;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 365) return null;
    return value;
  }

  function buildRuntimeProcessEnv(): NodeJS.ProcessEnv {
    const shellEnv: NodeJS.ProcessEnv = runtimeSettings.shell.path
      ? {
          SHELL: runtimeSettings.shell.path,
          ZEUS_SHELL_LOGIN: runtimeSettings.shell.login ? '1' : '0',
        }
      : { ZEUS_SHELL_LOGIN: runtimeSettings.shell.login ? '1' : '0' };
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...runtimeSettings.terminalEnv,
      ZEUS_RUNTIME_TIMEOUT_SECONDS: String(runtimeSettings.executionTimeoutSeconds),
      ...(runtimeSettings.adapterCliPaths.codex ? { ZEUS_CODEX_COMMAND_PATH: runtimeSettings.adapterCliPaths.codex } : {}),
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
    if (codeMapSettings.graphCacheStrategy === 'memory' && memoryGraphCache) {
      return {
        nodeCount: memoryGraphCache.nodes.length,
        edgeCount: memoryGraphCache.edges.length,
        viewCount: memoryGraphCache.views.length,
      };
    }
    if (codeMapSettings.graphCacheStrategy === 'disabled') {
      return { nodeCount: 0, edgeCount: 0, viewCount: 0 };
    }
    return readGraphSummary(db);
  }

  function readCurrentGraphSummaryByProject(projectName: string): {
    nodeCount: number;
    edgeCount: number;
    viewCount: number;
  } {
    if (codeMapSettings.graphCacheStrategy === 'memory' && memoryGraphCache) {
      if (memoryGraphCache.projectName !== projectName) {
        return { nodeCount: 0, edgeCount: 0, viewCount: 0 };
      }
      return {
        nodeCount: memoryGraphCache.nodes.length,
        edgeCount: memoryGraphCache.edges.length,
        viewCount: memoryGraphCache.views.length,
      };
    }
    if (codeMapSettings.graphCacheStrategy === 'disabled') {
      return { nodeCount: 0, edgeCount: 0, viewCount: 0 };
    }
    return readGraphSummaryByProject(db, projectName);
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

  function createTaskFromGraphNodeForProject(project: ZeusProjectRecord, nodeId: string, intent?: string): ZeusTaskRecord | null {
    const resolvedNode = readCurrentGraphNodeByIdForProject(nodeId, project);
    if (!resolvedNode) return null;
    return createTaskFromGraphNode(project.id, nodeId, intent, resolvedNode.graphProjectName);
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

  function countTasksByStatus(projectTasks: ZeusTaskRecord[]): Record<string, number> {
    return projectTasks.reduce<Record<string, number>>((counts, task) => {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
      return counts;
    }, {});
  }

  function readCurrentGraphView(viewType: string, projectName?: string): GraphViewSnapshot | undefined {
    if (codeMapSettings.graphCacheStrategy === 'memory') {
      if (!memoryGraphCache || (projectName && memoryGraphCache.projectName !== projectName)) return undefined;
      return graphViewSnapshotFromGraph(memoryGraphCache, viewType);
    }
    if (codeMapSettings.graphCacheStrategy === 'disabled') return undefined;
    return readGraphView(db, viewType, projectName);
  }

  function attachGraphViewPerformance(view: GraphViewSnapshot, startedAt: number): GraphViewSnapshot {
    if (!codeMapSettings.performanceMonitoringEnabled) return view;
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
    if (codeMapSettings.graphCacheStrategy === 'memory') {
      return memoryGraphCache && (!projectName || memoryGraphCache.projectName === projectName)
        ? searchGraphNodesInMemory(memoryGraphCache, rawQuery, nodeType, edgeType, rawMinConfidence)
        : emptyGraphSearchResult(rawQuery, nodeType, edgeType, rawMinConfidence);
    }
    if (codeMapSettings.graphCacheStrategy === 'disabled') {
      return emptyGraphSearchResult(rawQuery, nodeType, edgeType, rawMinConfidence);
    }
    return searchGraphNodes(db, rawQuery, nodeType, edgeType, rawMinConfidence, projectName);
  }

  function readCurrentGraphNodeById(nodeId: string, projectName?: string): GraphViewSnapshot['nodes'][number] | undefined {
    if (codeMapSettings.graphCacheStrategy === 'memory') {
      return memoryGraphCache && (!projectName || memoryGraphCache.projectName === projectName) ? graphNodeSnapshotFromGraph(memoryGraphCache, nodeId) : undefined;
    }
    if (codeMapSettings.graphCacheStrategy === 'disabled') return undefined;
    return readGraphNodeById(db, nodeId, projectName);
  }

  function listSemanticGraphNodes(
    projectId: string,
    viewType: string,
    nodeTypes: string[],
  ): {
    projectId: string;
    viewType: string;
    items: GraphViewSnapshot['nodes'];
  } {
    const graphProjectName = resolveGraphProjectNameByProjectId(projectId);
    const view = readCurrentGraphView(viewType, graphProjectName);
    const allowedTypes = new Set(nodeTypes);
    // 语义列表只从真实图谱视图提取节点；没有扫描结果时返回空列表，不构造假 API/模块/表。
    const items = view ? view.nodes.filter((node) => allowedTypes.has(node.nodeType)) : [];
    return { projectId, viewType, items };
  }

  function searchProjectTableFields(
    projectId: string,
    query: string,
  ): {
    projectId: string;
    viewType: string;
    query: string;
    items: GraphViewSnapshot['nodes'];
  } {
    const normalizedQuery = query.trim().toLowerCase();
    const graphProjectName = resolveGraphProjectNameByProjectId(projectId);
    const view = readCurrentGraphView('table', graphProjectName);
    const fields = view ? view.nodes.filter((node) => node.nodeType === 'column') : [];
    // 字段搜索只返回真实扫描得到的 column 节点；空查询列出字段，非空查询按列名、限定名、来源文件和表名匹配。
    const items = normalizedQuery
      ? fields.filter((node) => {
          const haystack = [
            node.name,
            node.qualifiedName,
            node.sourceRef,
            typeof node.metadata.tableName === 'string' ? node.metadata.tableName : '',
            typeof node.metadata.tableQualifiedName === 'string' ? node.metadata.tableQualifiedName : '',
          ]
            .join('\n')
            .toLowerCase();
          return haystack.includes(normalizedQuery);
        })
      : fields;
    return { projectId, viewType: 'table', query: query.trim(), items };
  }

  function readSemanticGraphNode(
    projectId: string,
    nodeId: string,
    nodeTypes: string[],
    reply: FastifyReply,
  ):
    | {
        projectId: string;
        node: GraphViewSnapshot['nodes'][number];
        relatedEdges: GraphViewSnapshot['edges'];
      }
    | unknown {
    const graphProjectName = resolveGraphProjectNameByProjectId(projectId);
    const node = readCurrentGraphNodeById(nodeId, graphProjectName);
    if (!node || !nodeTypes.includes(node.nodeType)) {
      return reply.code(404).send({
        error: 'ZEUS_GRAPH_NODE_NOT_FOUND',
        message: 'Graph node not found. Scan the project first.',
      });
    }
    return {
      projectId,
      node,
      relatedEdges: readCurrentGraphEdgesByNodeId(node.id, graphProjectName),
    };
  }

  function readFocusedSemanticGraphView(
    projectId: string,
    nodeId: string,
    nodeTypes: string[],
    viewType: string,
    reply: FastifyReply,
  ):
    | {
        projectId: string;
        node: GraphViewSnapshot['nodes'][number];
        view: Pick<GraphViewSnapshot, 'id' | 'title' | 'viewType'>;
        nodes: GraphViewSnapshot['nodes'];
        edges: GraphViewSnapshot['edges'];
      }
    | unknown {
    const graphProjectName = resolveGraphProjectNameByProjectId(projectId);
    const node = readCurrentGraphNodeById(nodeId, graphProjectName);
    if (!node || !nodeTypes.includes(node.nodeType)) {
      return reply.code(404).send({
        error: 'ZEUS_GRAPH_NODE_NOT_FOUND',
        message: 'Graph node not found. Scan the project first.',
      });
    }
    const view = readCurrentGraphView(viewType, graphProjectName);
    if (!view) {
      return reply.code(404).send({
        error: 'ZEUS_GRAPH_VIEW_NOT_FOUND',
        message: 'Graph view not found. Scan the project first.',
      });
    }
    const relatedEdges = view.edges.filter((edge) => edge.sourceNodeId === node.id || edge.targetNodeId === node.id);
    const relatedNodeIds = new Set<string>([node.id]);
    for (const edge of relatedEdges) {
      relatedNodeIds.add(edge.sourceNodeId);
      relatedNodeIds.add(edge.targetNodeId);
    }
    const focusedNodes = view.nodes.filter((item) => relatedNodeIds.has(item.id));
    return {
      projectId,
      node,
      view: { id: view.id, title: view.title, viewType: view.viewType },
      nodes: focusedNodes.some((item) => item.id === node.id) ? focusedNodes : [node, ...focusedNodes],
      edges: relatedEdges,
    };
  }

  function readCurrentGraphNodeIdsBySourceRef(sourceRef: string, graphRoot = projectRoot): string[] {
    const sourceRefCandidates = Array.from(new Set([sourceRef, resolve(graphRoot, sourceRef)]));
    if (codeMapSettings.graphCacheStrategy === 'memory') {
      // Git Diff 通常返回仓库相对路径，图谱扫描保存绝对路径；同时匹配两种口径但不做模糊匹配，避免误关联。
      return memoryGraphCache
        ? memoryGraphCache.nodes
            .filter((node) => sourceRefCandidates.includes(node.sourceRef))
            .map((node) => node.id)
            .sort()
        : [];
    }
    if (codeMapSettings.graphCacheStrategy === 'disabled') return [];
    // Diff API 必须能独立使用；尚未扫描图谱时先创建空表，返回空关联而不是让审计快照失败。
    ensureGraphCacheTables(db);
    return sourceRefCandidates.flatMap((candidate) => readGraphNodeIdsBySourceRef(db, candidate)).sort();
  }

  function readCurrentGraphEdgesByNodeId(nodeId: string, projectName?: string): GraphViewSnapshot['edges'] {
    if (codeMapSettings.graphCacheStrategy === 'memory') {
      return memoryGraphCache && (!projectName || memoryGraphCache.projectName === projectName) ? graphEdgesByNodeIdFromGraph(memoryGraphCache, nodeId, 20) : [];
    }
    if (codeMapSettings.graphCacheStrategy === 'disabled') return [];
    return readGraphEdgesByNodeId(db, nodeId, projectName);
  }

  function readCurrentGraphEdgeDetail(edgeId: string): GraphEdgeDetail | undefined {
    if (codeMapSettings.graphCacheStrategy === 'memory') {
      return memoryGraphCache ? graphEdgeDetailFromGraph(memoryGraphCache, edgeId) : undefined;
    }
    if (codeMapSettings.graphCacheStrategy === 'disabled') return undefined;
    return readGraphEdgeDetail(db, edgeId);
  }

  function readCurrentGraphNeighborhood(nodeId: string, depth: number, projectName?: string): GraphNeighborhood | undefined {
    if (codeMapSettings.graphCacheStrategy === 'memory') {
      return memoryGraphCache && (!projectName || memoryGraphCache.projectName === projectName) ? graphNeighborhoodFromGraph(memoryGraphCache, nodeId, depth) : undefined;
    }
    if (codeMapSettings.graphCacheStrategy === 'disabled') return undefined;
    return readGraphNeighborhood(db, nodeId, depth, projectName);
  }

  function evaluateRuntimeConcurrency(projectId: string):
    | { allowed: true }
    | {
        allowed: false;
        scope: 'project' | 'global';
        limit: number;
        runningCount: number;
        reason: string;
      } {
    const runningSessions = listUniqueRunningRuntimeSessions();
    const projectRunningCount = runningSessions.filter((session) => session.projectId === projectId).length;
    if (projectRunningCount >= runtimeSettings.concurrency.maxPerProject) {
      return {
        allowed: false,
        scope: 'project',
        limit: runtimeSettings.concurrency.maxPerProject,
        runningCount: projectRunningCount,
        reason: `项目运行中 Runtime 会话已达到并发上限 ${runtimeSettings.concurrency.maxPerProject}，任务保持 READY 等待后续启动。`,
      };
    }
    if (runningSessions.length >= runtimeSettings.concurrency.maxGlobal) {
      return {
        allowed: false,
        scope: 'global',
        limit: runtimeSettings.concurrency.maxGlobal,
        runningCount: runningSessions.length,
        reason: `全局运行中 Runtime 会话已达到并发上限 ${runtimeSettings.concurrency.maxGlobal}，任务保持 READY 等待后续启动。`,
      };
    }
    return { allowed: true };
  }

  function listUniqueRunningRuntimeSessions(): AiRuntimeSession[] {
    const sessionsById = new Map<string, AiRuntimeSession>();
    for (const session of runtimeSessions.list({ archived: false }).map(toAiRuntimeSession)) {
      if (session.status === 'running') sessionsById.set(session.id, session);
    }
    for (const session of aiRuntimeManager.listSessions()) {
      if (session.status === 'running') sessionsById.set(session.id, session);
    }
    return [...sessionsById.values()];
  }

  function markRuntimeSessionConversationsInactive(session: Pick<AiRuntimeSession, 'id' | 'status' | 'endedAt' | 'exitCode'>): void {
    if (session.status === 'running') return;
    const summary = formatRuntimeSessionConversationSummary(session);
    for (const conversation of conversations.listBySessionId(session.id)) {
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

  function mirrorExistingRuntimeLogsToConversation(sessionId: string, conversationId: string): ZeusConversationWithMessagesRecord {
    for (const log of listAllRuntimeLogs(sessionId)) {
      mirrorRuntimeLogToConversation(conversationId, log);
    }
    const updated = conversations.getById(conversationId);
    if (!updated) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    return updated;
  }

  function listAllRuntimeLogs(sessionId: string): AiRuntimeLogEntry[] {
    const logs: AiRuntimeLogEntry[] = [];
    let offset = 0;
    while (true) {
      const page = runtimeSessions.searchLogs(sessionId, { limit: 1_000, offset });
      logs.push(...page.items.map(toAiRuntimeLogEntry));
      if (page.items.length < page.limit) break;
      offset += page.items.length;
    }
    return logs;
  }

  function mirrorRuntimeLogToBoundTaskConversations(log: AiRuntimeLogEntry): void {
    if (!shouldMirrorRuntimeLogToConversation(log)) return;
    for (const conversation of conversations.listBySessionId(log.sessionId)) {
      mirrorRuntimeLogToConversation(conversation.id, log);
    }
  }

  function shouldMirrorRuntimeLogToConversation(log: AiRuntimeLogEntry): boolean {
    return (log.stream === 'stdout' || log.stream === 'stderr') && log.text.trim().length > 0;
  }

  function mirrorRuntimeLogToConversation(conversationId: string, log: AiRuntimeLogEntry): void {
    if (!shouldMirrorRuntimeLogToConversation(log)) return;
    const conversation = conversations.getById(conversationId);
    if (!conversation || !conversation.taskId) return;
    const alreadyMirrored = conversation.messages.some((message) => parseJsonObject(message.metadataJson).runtimeLogId === log.id);
    if (alreadyMirrored) return;
    const stream = log.stream === 'stderr' ? 'stderr' : 'stdout';
    conversations.appendMessage({
      conversationId,
      role: stream === 'stdout' ? 'assistant' : 'system',
      content: log.text,
      source: stream === 'stdout' ? 'runtime_stdout' : 'runtime_stderr',
      metadata: {
        sessionId: log.sessionId,
        runtimeLogId: log.id,
        stream,
      },
      createdAt: log.createdAt,
    });
  }

  function stopPersistedOrphanRuntimeSession(sessionId: string): AiRuntimeSession | null {
    const existing = runtimeSessions.getById(sessionId);
    if (!existing || existing.status !== 'orphan_detected' || typeof existing.pid !== 'number') return null;
    runtimeKillPid(existing.pid, 'SIGTERM');
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
      text: `已终止 orphan_detected Runtime 会话 PID ${existing.pid}`,
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
    for (const session of runtimeSessions.list({ archived: false }).filter((item) => item.status === 'running')) {
      const pid = session.pid;
      const pidStillExists = typeof pid === 'number' && runtimePidExists(pid);
      const status = pidStillExists ? 'orphan_detected' : 'lost';
      const message = pidStillExists ? 'Runtime 会话恢复状态：orphan_detected，原 PID 仍存在，请重新附着或终止。' : 'Runtime 会话恢复状态：lost，原 PID 不存在，已保留已收集日志。';
      const recovered = runtimeSessions.updateStatus(session.id, {
        status,
        exitCode: session.exitCode,
        endedAt: pidStillExists ? session.endedAt : new Date().toISOString(),
        pid,
      });
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
            pid: pid ?? null,
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
          pid: pid ?? null,
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
        executionHostProtocolVersion: options.executionHost?.protocolVersion ?? 1,
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
        executionHostProtocolVersion: options.executionHost?.protocolVersion ?? 1,
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
    return telegramPollingService;
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
    const configuration = getTelegramConfigurationState(token, telegramSecuritySettings.allowedUserIds);
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
      `当前配置：Token：${token ? '已配置' : '未配置'}；白名单用户：${telegramSecuritySettings.allowedUserIds.length}；通知 Chat：${telegramNotificationSettings.chatIds.length}；Polling：${polling?.running ? '运行中' : '已停止'}；状态：${configuration.reason}`,
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
    const confirmationResponse = await server.inject({
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(project.id)}/commands/${encodeURIComponent(command.id)}/confirmations`,
      headers: { authorization: `Bearer ${options.apiToken}` },
      payload: {
        parameters: parsed.parameters,
        trigger: 'telegram',
      },
    });
    if (confirmationResponse.statusCode !== 201) return formatTelegramCommandApiFailure(confirmationResponse);
    const confirmation = confirmationResponse.json<{ id: string; runId: string }>();
    const runResponse = await server.inject({
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(project.id)}/commands/${encodeURIComponent(command.id)}/runs`,
      headers: { authorization: `Bearer ${options.apiToken}` },
      payload: {
        confirmationId: confirmation.id,
        parameters: parsed.parameters,
      },
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
    if (!message?.messageId || !telegramMessageSender?.editMessage || run.status !== 'running') return;
    const count = (telegramCommandRunLogCounts.get(run.id) ?? 0) + 1;
    telegramCommandRunLogCounts.set(run.id, count);
    if (count % 5 !== 0) return;
    try {
      await telegramMessageSender.editMessage(message.chatId, message.messageId, formatTelegramCommandRunStatus(run));
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
    if (!run || run.status === 'running' || run.status === 'pending_confirmation') return;
    const message = telegramCommandRunMessages.get(run.id);
    if (!message || !telegramMessageSender) return;
    try {
      const text = formatTelegramCommandRunStatus(run);
      if (message.messageId && telegramMessageSender.editMessage) {
        await telegramMessageSender.editMessage(message.chatId, message.messageId, text);
      } else if (message.chatId !== 0) {
        await telegramMessageSender.sendMessage(message.chatId, text);
      }
      if (message.chatId !== 0 && telegramMessageSender.sendDocument) {
        for (const artifact of commandArtifacts.listByRun(run.id)) {
          const verifiedPath = verifyTelegramCommandArtifact(run.id, artifact.absolutePath);
          if (!verifiedPath) continue;
          await telegramMessageSender.sendDocument(message.chatId, verifiedPath, `${run.commandSnapshot.title} · ${artifact.relativePath}`);
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
    const logs = run.runtimeSessionId ? runtimeSessions.listLogs(run.runtimeSessionId).slice(-8) : [];
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
      const runRoot = realpathSync(join(dirname(options.dbPath), 'command-runs', runId));
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
    const adapterId = runtimeSettings.defaultAdapterId;
    if (isNonCodexAiCliAdapterId(adapterId)) {
      const unsupportedMessage = getNonCodexTaskAttachmentsUnsupportedMessage(adapterId, task);
      if (unsupportedMessage) return unsupportedMessage;
    }
    return createTelegramRuntimeConfirmation('run', project, task, () => runTelegramTaskAfterConfirmation(project, task.id));
  }

  async function runTelegramTaskAfterConfirmation(project: ZeusProjectRecord, taskId: string): Promise<string> {
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const adapterId = runtimeSettings.defaultAdapterId;
    if (adapterId === 'codex') {
      if (listTaskConversationHistory(task.id, project.id).length > 0) {
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
    const adapterId = runtimeSettings.defaultAdapterId;
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
    const adapterId = runtimeSettings.defaultAdapterId;
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

  function getNonCodexTaskAttachmentsUnsupportedMessage(adapterId: NonCodexAiCliAdapterId, task: ZeusTaskRecord): string | null {
    const sourceContext = parseTaskSourceContext(task);
    return Array.isArray(sourceContext.attachments) && sourceContext.attachments.length > 0 ? `Runtime adapter ${adapterId} 不支持任务附件，未启动会话。` : null;
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
      if (runtimeSettings.adapterCliPaths[adapter.id]?.trim() === command) candidates.set(adapter.id, adapter);
      if (isAbsolute(command) && parse(command).base === adapter.command) candidates.set(adapter.id, adapter);
    }
    return candidates.size === 1 ? (candidates.values().next().value ?? null) : null;
  }

  function createNonCodexTaskRuntimeInvocation(adapterId: NonCodexAiCliAdapterId, project: ZeusProjectRecord, task: ZeusTaskRecord, instruction?: string, prompt = createTaskRuntimePrompt(task, instruction), commandPathOverride?: string) {
    assertNonCodexTaskAttachmentsSupported(adapterId, task);
    const projectConfig = readProjectConfig(project.id);
    // 项目默认模型优先级高于全局 Runtime 模型；未配置时才回退到全局设置。
    return createNonCodexAiCliAdapterInvocation(adapterId, prompt, {
      model: projectConfig.defaultModel ?? runtimeSettings.adapterModels[adapterId],
      defaultArgs: runtimeSettings.adapterDefaultArgs[adapterId] ?? [],
      commandPath: commandPathOverride ?? runtimeSettings.adapterCliPaths[adapterId],
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
    const configured = runtimeSettings.adapterCliPaths[adapterId]?.trim();
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
    const concurrency = evaluateRuntimeConcurrency(project.id);
    if (!concurrency.allowed) {
      const queuedConversation = conversations.updateRuntimeState(conversation.id, {
        status: 'queued',
        summary: concurrency.reason,
      });
      recordTaskEvent({
        taskId: task.id,
        eventType: 'task.runtime.reconnect.queued',
        title: 'Runtime 续接已排队',
        payload: {
          projectId: project.id,
          conversationId: conversation.id,
          previousSessionId,
          scope: concurrency.scope,
          limit: concurrency.limit,
          runningCount: concurrency.runningCount,
        },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.reconnect.queued',
        resourceType: 'conversation',
        resourceId: conversation.id,
        payload: {
          projectId: project.id,
          taskId: task.id,
          conversationId: queuedConversation.id,
          previousSessionId,
          reason: concurrency.reason,
        },
      });
      return { runtimeError: { message: concurrency.reason } };
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
      const conversationWithRuntimeLogs = mirrorExistingRuntimeLogsToConversation(session.id, runningConversation.id);
      recordTaskEvent({
        taskId: runningTask.id,
        eventType: 'task.runtime.reconnect',
        title: '任务已自动续接 Runtime',
        payload: {
          runtimeSessionId: session.id,
          previousSessionId,
          conversationId: conversationWithRuntimeLogs.id,
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
          conversationId: conversationWithRuntimeLogs.id,
          command: session.command,
          cwd: session.cwd,
          source: 'conversation.message',
        },
      });
      publishRuntimeSessionEvent('runtime.session.created', session, {
        source: 'task.runtime.reconnect',
        previousSessionId,
        conversationId: conversationWithRuntimeLogs.id,
      });
      return { runtimeSession: session, conversation: conversationWithRuntimeLogs };
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

  function listTaskConversationHistory(taskId: string, projectId: string): ZeusConversationWithMessagesRecord[] {
    const history: ZeusConversationWithMessagesRecord[] = [];
    let offset = 0;
    while (true) {
      const page = conversations.listByProject(projectId, { limit: 100, offset });
      history.push(...page.items.filter((conversation) => conversation.taskId === taskId));
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) return history.sort(compareConversationStageUpdatedDesc);
    }
  }

  function listArchivedTaskConversationHistory(): ZeusConversationWithMessagesRecord[] {
    const history: ZeusConversationWithMessagesRecord[] = [];
    for (const project of [...projects.list(), ...projects.listArchived()]) {
      let offset = 0;
      while (true) {
        const page = conversations.listByProject(project.id, { archived: true, limit: 100, offset });
        history.push(...page.items.filter((conversation) => conversation.taskId !== null));
        offset += page.items.length;
        if (offset >= page.total || page.items.length === 0) break;
      }
    }
    return history.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  function listProjectConversationHistory(projectId: string): ZeusConversationWithMessagesRecord[] {
    const history: ZeusConversationWithMessagesRecord[] = [];
    let offset = 0;
    while (true) {
      const page = conversations.listByProject(projectId, { limit: 100, offset });
      history.push(
        ...page.items.filter((conversation) => {
          if (conversation.taskId !== null || conversation.archived) return false;
          const firstSubmission = conversationSubmissions.listByConversation(conversation.id)[0];
          const context = firstSubmission ? parseJsonObject(firstSubmission.inputJson).context : undefined;
          return !isNativeApiRecord(context) || context.ephemeral !== true;
        }),
      );
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) return history.sort(compareConversationStageUpdatedDesc);
    }
  }

  function compareConversationStageUpdatedDesc(left: ZeusConversationWithMessagesRecord, right: ZeusConversationWithMessagesRecord): number {
    return right.stageUpdatedAt.localeCompare(left.stageUpdatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
  }

  /** 侧边栏只聚合用户可进入的会话；待回复覆盖运行中，暂停、失败和完成未读不参与。 */
  function buildProjectConversationAttentionByProject(projectIds: readonly string[]): Record<string, ProjectConversationAttentionState> {
    const targetProjectIds = new Set(projectIds);
    const states = new Map<string, ProjectConversationAttentionState>(projectIds.map((projectId) => [projectId, 'idle']));
    const pendingRequestConversationIds = new Set(conversationRequests.listPending().map((request) => request.conversationId));
    const recoverableSubmissions = conversationSubmissions.listRecoverable();
    const runningSubmissionConversationIds = new Set(
      recoverableSubmissions.filter((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active').map((submission) => submission.conversationId),
    );

    for (const conversation of conversations.listUnarchivedRecords()) {
      if (!targetProjectIds.has(conversation.projectId)) continue;
      const replyRequired = pendingRequestConversationIds.has(conversation.id) || conversation.providerState === 'waiting';
      const running = runningSubmissionConversationIds.has(conversation.id) || conversation.providerState === 'binding' || conversation.providerState === 'active' || conversation.status === 'starting' || conversation.status === 'running';
      if (!replyRequired && !running) continue;
      const firstSubmission = conversationSubmissions.listByConversation(conversation.id)[0];
      const context = firstSubmission ? parseJsonObject(firstSubmission.inputJson).context : undefined;
      if (isNativeApiRecord(context) && context.ephemeral === true) continue;
      if (replyRequired) {
        states.set(conversation.projectId, 'reply_required');
      } else if (states.get(conversation.projectId) === 'idle') {
        states.set(conversation.projectId, 'running');
      }
    }

    return Object.fromEntries(states);
  }

  function toNativeConversationSummary(conversation: ZeusConversationWithMessagesRecord) {
    const pendingRequest = conversationRequests.listByConversation(conversation.id).find((request) => request.status === 'pending');
    return {
      id: conversation.id,
      projectId: conversation.projectId,
      taskId: conversation.taskId,
      workspaceId: conversation.workspaceId,
      environmentId: conversation.environmentId,
      workspace: conversation.workspaceId ? (taskWorkspaces.getById(conversation.workspaceId) ?? null) : null,
      title: conversation.title,
      summary: conversation.summary,
      status: conversation.status,
      stage: conversation.stage,
      stageUpdatedAt: conversation.stageUpdatedAt,
      transportKind: conversation.transportKind,
      providerId: conversation.providerId,
      providerThreadId: conversation.providerThreadId,
      providerModel: conversation.providerModel,
      providerState: conversation.providerState,
      legacySourceConversationId: conversation.legacySourceConversationId,
      permissionMode: conversation.permissionMode,
      collaborationMode: conversation.collaborationMode,
      hasUnreadCompletion: conversation.completionUnread,
      pendingRequestKind: pendingRequest ? (pendingRequest.requestKind === 'request_user_input' ? 'user_input' : 'approval') : null,
      provider: {
        id: conversation.providerId,
        threadId: conversation.providerThreadId,
        model: conversation.providerModel,
        state: conversation.providerState,
      },
      agent: {
        kind: conversation.agentKind,
        transport: conversation.agentTransport,
        supportStatus: conversation.agentKind === 'codex' && codexNativeEnabled ? 'verified' : conversation.agentKind === 'pi' ? 'experimental' : 'unavailable',
        capabilitySnapshotId: conversation.capabilitySnapshotId,
      },
      model: {
        sourceId: conversation.modelSourceId,
        id: conversation.modelId ?? conversation.providerModel,
      },
      nativeSession: {
        id: conversation.nativeSessionId ?? conversation.providerThreadId,
        path: conversation.nativeSessionPath ?? conversation.providerThreadPath,
      },
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      archived: conversation.archived,
    };
  }

  function toCodexLegacyImportApiRun(run: ReturnType<CodexLegacyImportRepository['getById']> extends infer RecordType ? Exclude<RecordType, undefined> : never) {
    return {
      id: run.id,
      importId: run.providerImportId,
      sourceConversationId: run.sourceConversationId,
      targetConversationId: run.targetConversationId,
      status: run.status,
      targetThreadId: run.targetThreadId,
      failureStage: run.failureStage,
      failureMessage: run.failureMessage,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
    };
  }

  function sendCodexLegacyImportError(reply: FastifyReply, error: unknown) {
    const code = error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string' ? String((error as Error & { code: string }).code) : 'ZEUS_CODEX_LEGACY_IMPORT_FAILED';
    const status = code === 'ZEUS_CODEX_LEGACY_IMPORT_NOT_FOUND' ? 404 : code.endsWith('_INVALID') || code.endsWith('_INELIGIBLE') || code.endsWith('_CONFLICT') ? 400 : 500;
    return reply.code(status).send({ error: code, message: error instanceof Error ? error.message : 'Codex legacy import failed.' });
  }

  function toNativeConversationChoice(conversation: ZeusConversationWithMessagesRecord) {
    return {
      ...toNativeConversationSummary(conversation),
      resumable: conversation.transportKind === 'codex_native' && !conversation.archived && conversation.providerState !== 'closed' && conversation.providerState !== 'failed',
      readOnly: conversation.transportKind === 'legacy_cli',
    };
  }

  function toNativeSubmission(submission: NonNullable<ReturnType<ConversationSubmissionRepository['getById']>>) {
    const input = parseJsonObject(submission.inputJson);
    return {
      id: submission.id,
      conversationId: submission.conversationId,
      content: typeof input.displayText === 'string' && input.displayText.trim() ? input.displayText : typeof input.text === 'string' ? input.text : '',
      status: submission.status,
      delivery: input.delivery === 'steer_now' ? 'steer_now' : 'queue',
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      expectedTurnId: typeof input.expectedTurnId === 'string' ? input.expectedTurnId : null,
      clientUserMessageId: submission.clientMessageId,
      position: submission.queuePosition,
      providerTurnId: submission.providerTurnId,
      pausedReason: submission.pausedReason,
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
    };
  }

  function toNativeServerRequest(request: NonNullable<ReturnType<ConversationServerRequestRepository['getById']>>) {
    const type = request.requestKind === 'request_user_input' ? 'userInput' : request.requestKind === 'mcp' ? 'MCP' : request.requestKind;
    return {
      id: request.id,
      conversationId: request.conversationId,
      turnId: request.turnId,
      itemId: request.itemId,
      generationId: request.transportGenerationId,
      type,
      status: request.status,
      payload: parseJsonObject(request.payloadJson),
      response: request.responseJson ? parseJsonObject(request.responseJson) : null,
      containsSecret: request.containsSecret,
      expiresAt: request.expiresAt,
      autoResolutionState: request.autoResolutionState,
      createdAt: request.createdAt,
      resolvedAt: request.resolvedAt,
    };
  }

  function parseNativeTurnPlan(value: string | null) {
    if (!value) return null;
    const parsed = parseJsonObject(value);
    if (!(parsed.explanation === null || typeof parsed.explanation === 'string') || !Array.isArray(parsed.steps)) return null;
    const steps = parsed.steps.flatMap((candidate) => {
      if (!isNativeApiRecord(candidate) || typeof candidate.step !== 'string' || !candidate.step.trim()) return [];
      if (candidate.status !== 'pending' && candidate.status !== 'inProgress' && candidate.status !== 'completed') return [];
      return [{ step: candidate.step, status: candidate.status }];
    });
    if (steps.length !== parsed.steps.length) return null;
    return { explanation: parsed.explanation, steps };
  }

  async function toNativeConversationSnapshot(conversation: ZeusConversationWithMessagesRecord) {
    const submissions = conversationSubmissions.listByConversation(conversation.id);
    const itemRecords = conversationItems.listByConversation(conversation.id);
    const itemByProviderItemId = new Map(itemRecords.filter((item) => item.providerItemId).map((item) => [item.providerItemId, item]));
    const resourcesByItemId = new Map<string, ReturnType<typeof toConversationResource>[]>();
    for (const record of conversationResources.listByConversation(conversation.id)) {
      const resource = toConversationResource(record);
      if (!resource) continue;
      const current = resourcesByItemId.get(record.itemId) ?? [];
      current.push(resource);
      resourcesByItemId.set(record.itemId, current);
    }
    const providerSettings = conversations.getProviderSettingsSnapshot(conversation.id);
    const nextTurnSettings = conversations.getNextTurnSettings(conversation.id) ?? nextTurnSettingsFallback(conversation, submissions, providerSettings);
    const tokenUsage = conversations.getProviderTokenUsageSnapshot(conversation.id);
    const rateLimits = settings.getCodexRateLimitsSnapshot();
    const mcpStartup = settings.getCodexMcpStartupStatusSnapshot();
    const executionContext = await readNativeConversationExecutionContext(conversation);
    return {
      ...toGraphConversationHistoryItem(conversation),
      ...toNativeConversationSummary(conversation),
      ...(providerSettings ? { providerSettings } : {}),
      ...(nextTurnSettings ? { nextTurnSettings } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(rateLimits ? { rateLimits } : {}),
      ...(mcpStartup ? { mcpStartup } : {}),
      executionContext,
      messages: conversation.messages.map((message) => {
        const providerItem = message.providerItemId ? itemByProviderItemId.get(message.providerItemId) : undefined;
        return {
          id: message.id,
          conversationId: message.conversationId,
          role: message.role,
          content: message.content,
          source: message.source,
          metadata: parseJsonObject(message.metadataJson),
          resources: providerItem ? (resourcesByItemId.get(providerItem.id) ?? []) : [],
          createdAt: message.createdAt,
        };
      }),
      turns: conversationTurns.listByConversation(conversation.id).map((turn) => ({
        id: turn.id,
        providerTurnId: turn.providerTurnId,
        submissionId: turn.clientSubmissionId,
        status: turn.status,
        error: parseConversationTurnFailure(turn.errorJson),
        plan: parseNativeTurnPlan(turn.planJson),
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        createdAt: turn.createdAt,
        updatedAt: turn.updatedAt,
      })),
      items: itemRecords.map((item) => ({
        id: item.id,
        turnId: item.turnId,
        providerItemId: item.providerItemId,
        type: item.itemType,
        status: item.status,
        phase: item.phase,
        text: item.textContent,
        payload: parseJsonObject(item.payloadJson),
        resources: resourcesByItemId.get(item.id) ?? [],
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        updatedAt: item.updatedAt,
      })),
      submissions: submissions.map(toNativeSubmission),
      changeSets: turnChangeSetService.listByConversation(conversation.id),
      queue: toNativeQueueApiSnapshot(conversation, submissions),
      requests: conversationRequests.listByConversation(conversation.id).map(toNativeServerRequest),
      planImplementationRequests: conversationPlanActions.listByConversation(conversation.id).map((request) => ({
        id: request.id,
        conversationId: request.conversationId,
        turnId: request.turnId,
        planItemId: request.planItemId,
        status: request.status,
        submissionId: request.submissionId,
        createdAt: request.createdAt,
        resolvedAt: request.resolvedAt,
        updatedAt: request.updatedAt,
      })),
    };
  }

  function nextTurnSettingsFallback(
    conversation: ZeusConversationWithMessagesRecord,
    submissions: ReturnType<ConversationSubmissionRepository['listByConversation']>,
    providerSettings: ReturnType<ConversationRepository['getProviderSettingsSnapshot']>,
  ): ConversationNextTurnSettings | undefined {
    const latest = [...submissions].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).at(-1);
    const input = latest ? parseJsonObject(latest.inputJson) : {};
    const context = isNativeApiRecord(input.context) ? input.context : {};
    const model = typeof context.model === 'string' && context.model.trim() ? context.model : (providerSettings?.model ?? conversation.providerModel);
    if (!model) return undefined;
    const effort = typeof context.effort === 'string' && context.effort.trim() ? context.effort : providerSettings?.effort;
    const hasContextServiceTier = Object.prototype.hasOwnProperty.call(context, 'serviceTier');
    const hasProviderServiceTier = providerSettings ? Object.prototype.hasOwnProperty.call(providerSettings, 'serviceTier') : false;
    return {
      model,
      ...(effort ? { effort } : {}),
      ...(hasContextServiceTier && (context.serviceTier === null || typeof context.serviceTier === 'string') ? { serviceTier: context.serviceTier } : hasProviderServiceTier ? { serviceTier: providerSettings?.serviceTier } : {}),
      permissionMode: conversation.permissionMode,
      collaborationMode: conversation.collaborationMode,
    };
  }

  function resolveNativeConversationExecutionRoot(conversation: ZeusConversationWithMessagesRecord): string | null {
    const contextualSubmission = conversationSubmissions.listByConversation(conversation.id).find((submission) => {
      const context = parseJsonObject(submission.inputJson).context;
      return isNativeApiRecord(context) && typeof context.projectLocalPath === 'string' && Boolean(context.projectLocalPath.trim());
    });
    const persistedContext = contextualSubmission ? parseJsonObject(contextualSubmission.inputJson).context : undefined;
    const workspace = conversation.workspaceId ? taskWorkspaces.getById(conversation.workspaceId) : undefined;
    const environment = conversation.environmentId ? taskEnvironments.getById(conversation.environmentId) : undefined;
    const project = projects.getById(conversation.projectId);
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

  async function readNativeConversationExecutionContext(conversation: ZeusConversationWithMessagesRecord): Promise<{ cwd: string | null; branch: string | null; isGitRepository: boolean | null }> {
    const cwdSource = resolveNativeConversationExecutionRoot(conversation);
    if (!cwdSource) return { cwd: null, branch: null, isGitRepository: null };
    const cwd = resolve(cwdSource);
    const git = await getGitWorkingContext(cwd);
    return { cwd, branch: git.branch, isGitRepository: git.isRepository };
  }

  function toNativeQueueApiSnapshot(conversation: ZeusConversationWithMessagesRecord, submissions = conversationSubmissions.listByConversation(conversation.id)) {
    return {
      state: inferNativeConversationSnapshotState(conversation),
      submissions: submissions.filter((submission) => (submission.status === 'queued' || submission.status === 'paused') && !submission.providerTurnId).map(toNativeSubmission),
    };
  }

  function inferNativeConversationSnapshotState(conversation: ZeusConversationWithMessagesRecord) {
    if (conversation.providerState === 'archived')
      return {
        type: 'paused' as const,
        reason: 'provider_archived' as const,
      };
    const turns = conversationTurns.listByConversation(conversation.id);
    const active = [...turns].reverse().find((turn) => turn.status === 'running' || turn.status === 'dispatching' || turn.status === 'waiting');
    if (active?.providerTurnId) {
      if (active.status === 'waiting') {
        const pending = conversationRequests
          .listByConversation(conversation.id)
          .find((request) => request.turnId === active.id && request.status === 'pending' && (conversation.agentKind === 'pi' || codexAppServerManager.hasGeneration(request.transportGenerationId)));
        if (pending) {
          return {
            type: 'waiting' as const,
            turnId: active.providerTurnId,
            requestId: pending.id,
            reason: pending.requestKind === 'request_user_input' ? ('user_input' as const) : ('approval' as const),
          };
        }
      }
      return { type: 'active' as const, turnId: active.providerTurnId, phase: 'prework' as const };
    }
    const paused = conversationSubmissions.listByConversation(conversation.id).filter((submission) => submission.status === 'paused');
    if (paused.some((submission) => submission.pausedReason === 'recovery_required')) return { type: 'paused' as const, reason: 'recovery_required' as const };
    if (paused.some((submission) => submission.pausedReason === 'interrupted')) return { type: 'paused' as const, reason: 'interrupted' as const };
    if (paused.some((submission) => submission.pausedReason === 'transport_unavailable')) return { type: 'paused' as const, reason: 'transport_unavailable' as const };
    if (paused.length > 0 && paused.every((submission) => submission.pausedReason === 'user_confirmation')) return { type: 'idle' as const };
    if (paused.length > 0) return { type: 'paused' as const, reason: 'recovery_required' as const };
    return { type: 'idle' as const };
  }

  async function acceptNativeConversationMessage(
    conversation: ZeusConversationWithMessagesRecord,
    content: string,
    body: CreateConversationMessageBody,
    idempotencyKey: string,
    stableOperationId: string,
    providerWriteLifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void },
  ) {
    const delivery = body.delivery ?? 'queue';
    if (delivery !== 'queue' && delivery !== 'steer_now') throw nativeApiError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'Message delivery must be queue or steer_now.');
    const project = projects.getById(conversation.projectId);
    if (!project) throw nativeApiError('ZEUS_PROJECT_NOT_FOUND', 'Conversation project was not found.');
    const attachments = normalizeNativeConversationAttachments(body.attachments, project.localPath);
    const browserComments = normalizeNativeBrowserComments(body.browserComments);
    if (!content && attachments.length === 0 && browserComments.length === 0) {
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'Conversation message content, attachments, or browser comments are required.');
    }
    const displayText =
      body.displayText === undefined
        ? undefined
        : typeof body.displayText === 'string' && body.displayText.trim() && body.displayText.length <= 100_000
          ? body.displayText.trim()
          : (() => {
              throw nativeApiError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'displayText must be a non-empty string no longer than 100000 characters.');
            })();
    const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    const requestedEffort = typeof body.effort === 'string' && body.effort.trim() ? body.effort.trim() : null;
    const requestedServiceTier = readServiceTierOverride(body);
    const permissionMode = body.permissionMode === undefined ? undefined : parseConversationPermissionMode(body.permissionMode);
    if (body.permissionMode !== undefined && !permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
    const collaborationMode = body.collaborationMode === undefined ? undefined : parseConversationCollaborationMode(body.collaborationMode);
    if (body.collaborationMode !== undefined && !collaborationMode) throw nativeApiError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.');
    const expectedTurnId = typeof body.expectedTurnId === 'string' && body.expectedTurnId.trim() ? body.expectedTurnId.trim() : null;
    if (delivery === 'steer_now') {
      if (requestedModel || requestedEffort || requestedServiceTier.present || body.permissionMode !== undefined) {
        throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', 'Model, reasoning effort, service tier, and permission mode can change only when starting a queued turn.');
      }
      const activeTurn = [...conversationTurns.listByConversation(conversation.id)].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching');
      if (!expectedTurnId || activeTurn?.providerTurnId !== expectedTurnId) {
        throw nativeApiError('ZEUS_NATIVE_TURN_MISMATCH', 'steer_now requires the exact currently active provider turn id.');
      }
    }
    let selectedModel: string | null = null;
    let selectedModelSourceId: string | null = conversation.modelSourceId;
    let selectedAgentKind: 'codex' | 'pi' = conversation.agentKind === 'pi' ? 'pi' : 'codex';
    let selectedEffort: string | null = null;
    let selectedServiceTier: string | null | undefined;
    if (requestedModel || requestedEffort || requestedServiceTier.present) {
      const capabilities = await resolveConversationCapabilities(project);
      const model = requestedModel ?? conversation.providerModel ?? capabilities.preferredModel;
      const capability = capabilities.models.find((candidate) => candidate.model === model || candidate.id === model);
      if (!capability) throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', 'Selected Codex model is not available in the current app-server generation.');
      if (capability.available === false) throw nativeApiError('ZEUS_MODEL_NOT_READY', capability.availabilityReason || '所选模型当前不可运行。');
      if (requestedEffort && !capability.supportedReasoningEfforts.some((effort) => effort === requestedEffort)) {
        throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', 'Selected reasoning effort is not supported by the selected Codex model.');
      }
      selectedModel = capability.model;
      selectedModelSourceId = capability.sourceId ?? null;
      selectedAgentKind = capability.agentKind ?? 'codex';
      selectedEffort = requestedEffort ?? capability.defaultReasoningEffort ?? capability.supportedReasoningEfforts[0] ?? null;
      selectedServiceTier = normalizeServiceTierForCapability(requestedServiceTier, capability);
    }
    const clientUserMessageId = normalizeNativeClientUserMessageId(body.clientUserMessageId, `native-client-${createHash('sha256').update(`${conversation.id}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`);
    if (selectedAgentKind !== (conversation.agentKind === 'pi' ? 'pi' : 'codex')) {
      throw nativeApiError('ZEUS_AGENT_SWITCH_REQUIRES_NEW_CONVERSATION', '不能在同一会话内切换 Codex 与 Pi，请新建会话。');
    }
    let nativeOperation =
      conversation.agentKind === 'pi'
        ? delivery === 'steer_now'
          ? await piNativeCoordinator.steerMessage({
              conversation,
              submissionId: `conversation_submission_${createHash('sha256').update(`${stableOperationId}\0pi-steer`).digest('hex').slice(0, 24)}`,
              content,
              expectedTurnId: expectedTurnId!,
              idempotencyKey,
              clientUserMessageId,
            })
          : await piNativeCoordinator.submitMessage({
              conversation,
              submissionId: `conversation_submission_${createHash('sha256').update(`${stableOperationId}\0pi-submission`).digest('hex').slice(0, 24)}`,
              content,
              model: { sourceId: selectedModelSourceId, modelId: selectedModel ?? conversation.modelId ?? conversation.providerModel ?? '', displayName: null },
              ...(selectedEffort ? { thinkingLevel: selectedEffort } : {}),
              idempotencyKey,
              clientUserMessageId,
            })
        : await codexNativeCoordinator.submitMessage({
            conversationId: conversation.id,
            content,
            ...(displayText ? { displayText } : {}),
            attachments,
            browserComments,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedEffort ? { effort: selectedEffort } : {}),
            ...(requestedServiceTier.present ? { serviceTier: selectedServiceTier ?? null } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(collaborationMode ? { collaborationMode } : {}),
            idempotencyKey,
            clientUserMessageId,
            providerWriteLifecycle,
          });
    const persisted = conversationSubmissions.getById(nativeOperation.submissionId);
    if (!persisted) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native message submission was not persisted.');
    const input = parseJsonObject(persisted.inputJson);
    db.execute('UPDATE conversation_submissions SET requested_delivery = ?, input_json = ?, updated_at = ? WHERE id = ?', [
      delivery === 'steer_now' ? 'send_now' : 'queue',
      JSON.stringify({
        ...input,
        delivery,
        attachments,
        browserComments,
        expectedTurnId,
        ...(displayText ? { displayText } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
        ...(requestedServiceTier.present ? { serviceTier: selectedServiceTier ?? null } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
      }),
      now().toISOString(),
      persisted.id,
    ]);
    if (persisted.providerTurnId) {
      db.execute('UPDATE conversation_messages SET metadata_json = ? WHERE conversation_id = ? AND client_message_id = ?', [
        JSON.stringify({
          clientUserMessageId,
          delivery,
          attachments,
          browserComments,
          expectedTurnId,
          ...(displayText ? { displayText } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          ...(requestedServiceTier.present ? { serviceTier: selectedServiceTier ?? null } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
        }),
        conversation.id,
        clientUserMessageId,
      ]);
    }
    await db.save();
    if (delivery === 'steer_now' && conversation.agentKind !== 'pi') nativeOperation = await codexNativeCoordinator.sendQueuedNow({ conversationId: conversation.id, submissionId: persisted.id, providerWriteLifecycle });
    const updatedConversation = conversations.getById(conversation.id);
    const updatedSubmission = conversationSubmissions.getById(persisted.id);
    if (!updatedConversation || !updatedSubmission) throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native message acceptance was not persisted.');
    await db.save();
    if (delivery === 'queue') {
      publishNativeConversationEvent('conversation.queue.changed', {
        conversationId: updatedConversation.id,
        queue: toNativeQueueApiSnapshot(updatedConversation),
      });
    }
    void nativeOperation;
    return toNativeDurableAcceptance(stableOperationId, idempotencyKey, updatedConversation, updatedSubmission);
  }

  function normalizeNativeConversationAttachments(value: unknown, projectLocalPath: string): NativeConversationAttachment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT', 'attachments must be an array.');
    return value.map((attachment, index) => {
      if (
        !isNativeApiRecord(attachment) ||
        typeof attachment.name !== 'string' ||
        !attachment.name.trim() ||
        typeof attachment.mime !== 'string' ||
        !attachment.mime.trim() ||
        typeof attachment.size !== 'number' ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 0
      ) {
        throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT', `Attachment ${index} must include name, mime, and a non-negative integer size.`);
      }
      const localPath = typeof attachment.localPath === 'string' && attachment.localPath.trim() ? attachment.localPath.trim() : undefined;
      const uploadRef = typeof attachment.uploadRef === 'string' && attachment.uploadRef.trim() ? attachment.uploadRef.trim() : undefined;
      if ((localPath ? 1 : 0) + (uploadRef ? 1 : 0) !== 1) {
        throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT', `Attachment ${index} requires exactly one of localPath or uploadRef.`);
      }
      let canonicalLocalPath: string | undefined;
      let authorizedPath: string | undefined;
      if (uploadRef) {
        const grantedPath = options.conversationAttachmentGrantSecret ? resolveConversationAttachmentGrant(uploadRef, options.conversationAttachmentGrantSecret) : null;
        if (!grantedPath) {
          throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT_GRANT', `Attachment ${index} path grant is invalid or expired.`);
        }
        try {
          canonicalLocalPath = realpathSync(grantedPath);
          const pathStat = statSync(canonicalLocalPath);
          if (canonicalLocalPath !== grantedPath || (!pathStat.isFile() && !pathStat.isDirectory())) {
            throw new Error('Granted attachment path changed or is not a file/directory.');
          }
          authorizedPath = canonicalLocalPath;
        } catch {
          throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT_GRANT', `Attachment ${index} granted path is no longer available.`);
        }
      }
      if (localPath) {
        if (!isAbsolute(localPath)) throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT', `Attachment ${index} localPath must be absolute.`);
        try {
          const projectRealPath = realpathSync(projectLocalPath);
          canonicalLocalPath = realpathSync(localPath);
          const allowedRoots = [projectRealPath, ...trustedConversationAttachmentRoots];
          const pathStat = statSync(canonicalLocalPath);
          if (!allowedRoots.some((root) => isPathInsideProjectRoot(canonicalLocalPath!, root)) || (!pathStat.isFile() && !pathStat.isDirectory())) {
            throw new Error('Attachment path is outside trusted roots or is not a file/directory.');
          }
        } catch {
          throw nativeApiError('ZEUS_INVALID_CONVERSATION_ATTACHMENT', `Attachment ${index} localPath must resolve inside a trusted Zeus attachment root.`);
        }
      }
      return {
        name: attachment.name.trim(),
        mime: attachment.mime.trim(),
        size: attachment.size,
        ...(canonicalLocalPath ? { localPath: canonicalLocalPath } : {}),
        ...(authorizedPath ? { authorizedPath } : {}),
      };
    });
  }

  function normalizeNativeBrowserComments(value: unknown): Record<string, unknown>[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 200) {
      throw nativeApiError('ZEUS_INVALID_BROWSER_COMMENTS', 'browserComments must be an array with no more than 200 entries.');
    }
    value.forEach((comment, index) => {
      const anchor = isNativeApiRecord(comment) && isNativeApiRecord(comment.anchor) ? comment.anchor : null;
      if (
        !isNativeApiRecord(comment) ||
        typeof comment.id !== 'string' ||
        !comment.id.trim() ||
        comment.id.length > 200 ||
        typeof comment.number !== 'number' ||
        !Number.isSafeInteger(comment.number) ||
        comment.number < 1 ||
        typeof comment.body !== 'string' ||
        !comment.body.trim() ||
        comment.body.length > 20_000 ||
        !anchor ||
        typeof anchor.pageUrl !== 'string' ||
        !anchor.pageUrl ||
        anchor.pageUrl.length > 20_000
      ) {
        throw nativeApiError('ZEUS_INVALID_BROWSER_COMMENTS', `Browser comment ${index} has invalid identity, body, page URL, or anchor metadata.`);
      }
    });
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > 1_000_000) {
      throw nativeApiError('ZEUS_INVALID_BROWSER_COMMENTS', 'browserComments must be no larger than 1 MB.');
    }
    return JSON.parse(serialized) as Record<string, unknown>[];
  }

  function normalizeNativeClientUserMessageId(value: unknown, legacyFallback: string): string {
    if (value === undefined) return legacyFallback;
    if (typeof value !== 'string' || !value.trim() || value.length > 200) {
      throw nativeApiError('ZEUS_INVALID_CLIENT_USER_MESSAGE_ID', 'clientUserMessageId must be a non-empty string no longer than 200 characters.');
    }
    return value;
  }

  function normalizeNativeServerRequestResponse(requestKind: 'command' | 'file' | 'permissions' | 'request_user_input' | 'mcp', body: Record<string, unknown>): Parameters<typeof codexNativeCoordinator.respondToRequest>[0]['response'] {
    type NativeResponse = Parameters<typeof codexNativeCoordinator.respondToRequest>[0]['response'];
    const commandDecisions = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
    const fileDecisions = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
    if (requestKind === 'command' && body.type === requestKind && typeof body.decision === 'string' && commandDecisions.has(body.decision)) {
      return { type: requestKind, decision: body.decision as 'accept' | 'acceptForSession' | 'decline' | 'cancel' };
    }
    if (requestKind === 'command' && body.type === requestKind && isNativeApiRecord(body.decision) && Object.keys(body.decision).length === 1) {
      const rawAmendment = body.decision.acceptWithExecpolicyAmendment;
      if (
        isNativeApiRecord(rawAmendment) &&
        Object.keys(rawAmendment).length === 1 &&
        Array.isArray(rawAmendment.execpolicy_amendment) &&
        rawAmendment.execpolicy_amendment.length > 0 &&
        rawAmendment.execpolicy_amendment.every((entry) => typeof entry === 'string' && entry.length > 0)
      ) {
        return {
          type: 'command',
          decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: rawAmendment.execpolicy_amendment as string[] } },
        } as Extract<NativeResponse, { type: 'command' }>;
      }
    }
    if (requestKind === 'file' && body.type === requestKind && typeof body.decision === 'string' && fileDecisions.has(body.decision)) {
      return { type: requestKind, decision: body.decision as 'accept' | 'acceptForSession' | 'decline' | 'cancel' };
    }
    if (requestKind === 'permissions' && body.type === 'permissions' && isNativeApiRecord(body.permissions) && (body.scope === 'turn' || body.scope === 'session')) {
      return {
        type: 'permissions',
        permissions: body.permissions as Extract<NativeResponse, { type: 'permissions' }>['permissions'],
        scope: body.scope,
        ...(typeof body.strictAutoReview === 'boolean' ? { strictAutoReview: body.strictAutoReview } : {}),
      };
    }
    if (requestKind === 'request_user_input' && body.type === 'userInput' && isNativeApiRecord(body.answers)) {
      const answers = Object.fromEntries(
        Object.entries(body.answers).map(([questionId, answer]) => {
          if (!isNativeApiRecord(answer) || !Array.isArray(answer.answers) || answer.answers.some((value) => typeof value !== 'string')) {
            throw nativeApiError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', `Invalid answers for user input question ${questionId}.`);
          }
          return [questionId, { answers: answer.answers as string[] }];
        }),
      );
      return { type: 'request_user_input', answers };
    }
    if (requestKind === 'mcp' && body.type === 'MCP' && (body.action === 'accept' || body.action === 'decline' || body.action === 'cancel')) {
      return {
        type: 'mcp',
        action: body.action,
        content: (body.content ?? null) as Extract<NativeResponse, { type: 'mcp' }>['content'],
        _meta: (body._meta ?? null) as Extract<NativeResponse, { type: 'mcp' }>['_meta'],
      };
    }
    throw nativeApiError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', `Response type does not match pending ${requestKind} request.`);
  }

  async function executeProjectConversationIdempotent(project: ZeusProjectRecord, body: StartProjectConversationBody | Record<string, unknown>, idempotencyKey: string) {
    assertRequestedAgentIsCodex(body);
    const scope = `project-conversation:${project.id}`;
    const requestHash = nativeIdempotencyRequestHash(body);
    const stableOperationId = nativeStableOperationId(scope, idempotencyKey, requestHash);
    const reservation = createTaskConversationAcceptanceReservation(scope, requestHash, stableOperationId, body);
    const resourceId = encodeProjectConversationAcceptanceReservation(reservation);
    return executeIdempotentJson(
      scope,
      idempotencyKey,
      body,
      202,
      async (ownedOperationId, lifecycle) => {
        if (ownedOperationId !== reservation.operationId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Stable operation identity changed while accepting a project conversation.');
        const accepted = await acceptProjectConversation(project, body, idempotencyKey, ownedOperationId, reservation, lifecycle);
        await checkpointInProgressIdempotentResponse(scope, idempotencyKey, 202, accepted);
        return accepted;
      },
      (_ownedOperationId, persistedResourceId) => recoverProjectConversationAcceptance(project, idempotencyKey, reservation, persistedResourceId),
      resourceId,
    );
  }

  function encodeProjectConversationAcceptanceReservation(reservation: ProjectConversationAcceptanceReservation): string {
    return `project-acceptance:${Buffer.from(JSON.stringify(reservation), 'utf8').toString('base64url')}`;
  }

  function decodeProjectConversationAcceptanceReservation(value: string | null): ProjectConversationAcceptanceReservation | null {
    if (!value?.startsWith('project-acceptance:')) return null;
    try {
      const decoded: unknown = JSON.parse(Buffer.from(value.slice('project-acceptance:'.length), 'base64url').toString('utf8'));
      if (
        !isNativeApiRecord(decoded) ||
        typeof decoded.scope !== 'string' ||
        typeof decoded.requestHash !== 'string' ||
        typeof decoded.operationId !== 'string' ||
        typeof decoded.conversationId !== 'string' ||
        typeof decoded.submissionId !== 'string'
      ) {
        return null;
      }
      return decoded as unknown as ProjectConversationAcceptanceReservation;
    } catch {
      return null;
    }
  }

  async function acceptProjectConversation(
    project: ZeusProjectRecord,
    body: StartProjectConversationBody | Record<string, unknown>,
    idempotencyKey: string,
    stableOperationId: string,
    reservation: ProjectConversationAcceptanceReservation,
    providerWriteLifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void },
  ) {
    if (!isNativeApiRecord(body) || body.mode !== 'create') throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Project conversations require mode create.');
    if (body.content !== undefined && typeof body.content !== 'string') throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Project conversation content must be a string.');
    const permissionMode = body.permissionMode === undefined ? 'auto' : parseConversationPermissionMode(body.permissionMode);
    if (!permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
    const collaborationMode = body.collaborationMode === undefined ? 'default' : parseConversationCollaborationMode(body.collaborationMode);
    if (!collaborationMode) throw nativeApiError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.');
    const attachments = normalizeNativeConversationAttachments(body.attachments, project.localPath);
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content && attachments.length === 0) {
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Project conversation content or attachments are required.');
    }
    const capabilities = await resolveConversationCapabilities(project);
    const selectedModel = capabilities.models.find((candidate) => candidate.model === capabilities.preferredModel || candidate.id === capabilities.preferredModel) ?? capabilities.models[0]!;
    const requestedServiceTier = readServiceTierOverride(body);
    const serviceTier = normalizeServiceTierForCapability(requestedServiceTier, selectedModel);
    const clientUserMessageId = normalizeNativeClientUserMessageId(body.clientUserMessageId, `native-client-${createHash('sha256').update(`${project.id}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`);
    const resourceId = encodeProjectConversationAcceptanceReservation(reservation);
    const reservedLifecycle = {
      markPrepared: (submissionId: string) => {
        if (submissionId !== reservation.submissionId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Prepared submission does not match the reserved project acceptance resource.');
        return providerWriteLifecycle.markPrepared(resourceId);
      },
      markRpcStarted: (submissionId: string) => {
        if (submissionId !== reservation.submissionId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Provider submission does not match the reserved project acceptance resource.');
        return providerWriteLifecycle.markRpcStarted(resourceId);
      },
    };
    const nativeOperation = await codexNativeCoordinator.startProjectConversation({
      conversationId: reservation.conversationId,
      submissionId: reservation.submissionId,
      projectId: project.id,
      projectLocalPath: project.localPath,
      prompt: content,
      attachments,
      model: selectedModel.model,
      ...(requestedServiceTier.present ? { serviceTier } : {}),
      permissionMode,
      collaborationMode,
      idempotencyKey,
      clientUserMessageId,
      providerWriteLifecycle: reservedLifecycle,
    });
    const conversation = conversations.getById(nativeOperation.conversationId);
    const submission = conversationSubmissions.getById(nativeOperation.submissionId);
    if (
      !conversation ||
      !submission ||
      conversation.id !== reservation.conversationId ||
      conversation.projectId !== project.id ||
      conversation.taskId !== null ||
      submission.id !== reservation.submissionId ||
      submission.conversationId !== conversation.id
    ) {
      throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Project conversation acceptance did not persist the exact reserved resources.');
    }
    return toNativeDurableAcceptance(stableOperationId, idempotencyKey, conversation, submission);
  }

  function recoverProjectConversationAcceptance(project: ZeusProjectRecord, idempotencyKey: string, expected: ProjectConversationAcceptanceReservation, persistedResourceId: string | null) {
    const persisted = decodeProjectConversationAcceptanceReservation(persistedResourceId);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(expected)) return undefined;
    const conversation = conversations.getById(persisted.conversationId);
    const submission = conversationSubmissions.getById(persisted.submissionId);
    if (
      !conversation ||
      !submission ||
      conversation.projectId !== project.id ||
      conversation.taskId !== null ||
      submission.conversationId !== conversation.id ||
      submission.idempotencyKey !== idempotencyKey ||
      persisted.scope !== `project-conversation:${project.id}` ||
      persisted.operationId !== expected.operationId ||
      persisted.requestHash !== expected.requestHash
    ) {
      return undefined;
    }
    // acceptance checkpoint 缺失时不能从可变会话快照伪造原响应。
    return undefined;
  }

  async function executeTaskConversationIdempotent(project: ZeusProjectRecord, task: ZeusTaskRecord, body: StartTaskConversationBody | Record<string, unknown>, idempotencyKey: string) {
    assertRequestedAgentKind(body);
    const scope = `task-conversation:${task.id}`;
    const requestHash = nativeIdempotencyRequestHash(body);
    const stableOperationId = nativeStableOperationId(scope, idempotencyKey, requestHash);
    const reservation = createTaskConversationAcceptanceReservation(scope, requestHash, stableOperationId, body);
    const resourceId = encodeTaskConversationAcceptanceReservation(reservation);
    return executeIdempotentJson(
      scope,
      idempotencyKey,
      body,
      202,
      async (ownedOperationId, lifecycle) => {
        if (ownedOperationId !== reservation.operationId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Stable operation identity changed while accepting a task conversation.');
        const accepted = await acceptTaskConversation(project, task, body, idempotencyKey, ownedOperationId, reservation, lifecycle);
        await checkpointInProgressIdempotentResponse(scope, idempotencyKey, 202, accepted);
        return accepted;
      },
      (_ownedOperationId, persistedResourceId) => recoverTaskConversationAcceptance(project, task, idempotencyKey, reservation, persistedResourceId),
      resourceId,
    );
  }

  function createTaskConversationAcceptanceReservation(scope: string, requestHash: string, operationId: string, body: unknown): TaskConversationAcceptanceReservation {
    const selectedConversationId = isNativeApiRecord(body) && body.mode === 'resume' && typeof body.conversationId === 'string' && body.conversationId ? body.conversationId : null;
    return {
      scope,
      requestHash,
      operationId,
      conversationId: selectedConversationId ?? `conversation_${createHash('sha256').update(`${operationId}\0conversation`).digest('hex').slice(0, 24)}`,
      submissionId: `conversation_submission_${createHash('sha256').update(`${operationId}\0submission`).digest('hex').slice(0, 24)}`,
    };
  }

  function encodeTaskConversationAcceptanceReservation(reservation: TaskConversationAcceptanceReservation): string {
    return `task-acceptance:${Buffer.from(JSON.stringify(reservation), 'utf8').toString('base64url')}`;
  }

  function decodeTaskConversationAcceptanceReservation(value: string | null): TaskConversationAcceptanceReservation | null {
    if (!value?.startsWith('task-acceptance:')) return null;
    try {
      const decoded: unknown = JSON.parse(Buffer.from(value.slice('task-acceptance:'.length), 'base64url').toString('utf8'));
      if (
        !isNativeApiRecord(decoded) ||
        typeof decoded.scope !== 'string' ||
        typeof decoded.requestHash !== 'string' ||
        typeof decoded.operationId !== 'string' ||
        typeof decoded.conversationId !== 'string' ||
        typeof decoded.submissionId !== 'string'
      ) {
        return null;
      }
      return decoded as unknown as TaskConversationAcceptanceReservation;
    } catch {
      return null;
    }
  }

  async function acceptTaskConversation(
    project: ZeusProjectRecord,
    task: ZeusTaskRecord,
    body: StartTaskConversationBody | Record<string, unknown>,
    idempotencyKey: string,
    stableOperationId: string,
    reservation: TaskConversationAcceptanceReservation,
    providerWriteLifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void },
  ) {
    const history = listTaskConversationHistory(task.id, project.id);
    if (!isNativeApiRecord(body) || typeof body.mode !== 'string') {
      if (history.length > 0) throw nativeApiError('ZEUS_CONVERSATION_CHOICE_REQUIRED', 'Existing task conversations require an explicit create, resume, or reference_legacy choice.');
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Conversation mode is required.');
    }

    const clientUserMessageId = normalizeNativeClientUserMessageId(body.clientUserMessageId, `native-client-${createHash('sha256').update(`${task.id}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`);
    const resourceId = encodeTaskConversationAcceptanceReservation(reservation);
    const reservedLifecycle = {
      markPrepared: (submissionId: string) => {
        if (submissionId !== reservation.submissionId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Prepared submission does not match the reserved task acceptance resource.');
        return providerWriteLifecycle.markPrepared(resourceId);
      },
      markRpcStarted: (submissionId: string) => {
        if (submissionId !== reservation.submissionId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Provider submission does not match the reserved task acceptance resource.');
        return providerWriteLifecycle.markRpcStarted(resourceId);
      },
    };
    let nativeOperation: { conversationId: string; submissionId: string; providerThreadId: string | null; providerTurnId: string | null; status: string };
    if (body.mode === 'create') {
      if (body.source === 'task_push') {
        if (body.content !== undefined || body.attachments !== undefined) {
          throw nativeApiError('ZEUS_INVALID_TASK_PUSH', 'Task push content and attachments are assembled by the server from the canonical task record.');
        }
        const modelName = typeof body.model === 'string' ? body.model.trim() : '';
        const effort = typeof body.effort === 'string' ? body.effort.trim() : '';
        const workMode = body.workMode === 'plan' || body.workMode === 'default' ? body.workMode : null;
        const supplementalInfo = typeof body.supplementalInfo === 'string' ? body.supplementalInfo.trim() : '';
        if (!modelName) throw nativeApiError('ZEUS_INVALID_TASK_PUSH', 'Task push model is required.');
        if (!workMode) throw nativeApiError('ZEUS_INVALID_TASK_PUSH', 'Task push workMode must be default or plan.');
        if (supplementalInfo.length > 20_000) throw nativeApiError('ZEUS_INVALID_TASK_PUSH', 'Task push supplementalInfo must be no longer than 20000 characters.');
        const permissionMode = body.permissionMode === undefined ? 'read-only' : parseConversationPermissionMode(body.permissionMode);
        if (!permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
        const capabilities = await resolveTaskPushCapabilities(project, task);
        const selectedModel = capabilities.models.find((candidate) => candidate.model === modelName || candidate.id === modelName);
        if (!selectedModel) throw nativeApiError('ZEUS_CODEX_MODEL_UNAVAILABLE', `Configured Codex model is unavailable: ${modelName}`);
        if (selectedModel.available === false) throw nativeApiError('ZEUS_MODEL_NOT_READY', selectedModel.availabilityReason || '所选模型当前不可运行。');
        if (selectedModel.agentKind !== 'pi') await assertCodexAccountReady();
        const requestedServiceTier = readServiceTierOverride(body);
        const serviceTier = normalizeServiceTierForCapability(requestedServiceTier, selectedModel);
        const selectedEffort = effort || selectedModel.defaultReasoningEffort || selectedModel.supportedReasoningEfforts[0] || '';
        if (selectedEffort && !selectedModel.supportedReasoningEfforts.some((candidate) => candidate === selectedEffort)) {
          throw nativeApiError('ZEUS_CODEX_EFFORT_UNAVAILABLE', `Configured Codex effort is unavailable: ${selectedEffort}`);
        }
        if (!isNativeApiRecord(body.workspace) || (body.workspace.mode !== 'create' && body.workspace.mode !== 'direct')) {
          throw nativeApiError('ZEUS_TASK_PUSH_WORKSPACE_MODE_REQUIRED', 'Choose the project directory or a worktree for this task push.');
        }
        const directWorkspace = body.workspace.mode === 'direct';
        const activeDirectWrites = directWorkspace && permissionMode !== 'read-only' ? countDirectProjectActiveWritableConversations(project.id) : 0;
        if (activeDirectWrites > 0 && body.workspace.confirmConcurrentWrites !== true) {
          throw nativeApiError('ZEUS_DIRECT_WORKSPACE_CONCURRENCY_CONFIRMATION_REQUIRED', `${activeDirectWrites} writable conversation(s) already use this project directory. Confirm concurrent writes before continuing.`);
        }
        const taskEnvironment = directWorkspace ? null : await resolveTaskPushEnvironment(project, task, body.workspace, stableOperationId);
        const attachmentInput = normalizeTaskPushAttachments(task, project.localPath);
        nativeOperation =
          selectedModel.agentKind === 'pi'
            ? await piNativeCoordinator.startConversation({
                conversationId: reservation.conversationId,
                submissionId: reservation.submissionId,
                projectId: project.id,
                taskId: task.id,
                taskTitle: task.title,
                cwd: taskEnvironment?.cwd ?? project.localPath,
                prompt: buildTaskPushPrompt(task, supplementalInfo),
                model: { sourceId: selectedModel.sourceId ?? null, modelId: selectedModel.model, displayName: selectedModel.displayName ?? null },
                ...(selectedEffort ? { thinkingLevel: selectedEffort } : {}),
                permissionMode,
                idempotencyKey,
                clientUserMessageId,
                ...(taskEnvironment
                  ? {
                      environmentId: taskEnvironment.environment.id,
                      ...(taskEnvironment.workspaces[0] ? { workspaceId: taskEnvironment.workspaces[0].id } : {}),
                    }
                  : {}),
              })
            : await codexNativeCoordinator.startTaskConversation({
                conversationId: reservation.conversationId,
                submissionId: reservation.submissionId,
                projectId: project.id,
                projectLocalPath: taskEnvironment?.cwd ?? project.localPath,
                taskId: task.id,
                ...(taskEnvironment
                  ? {
                      environmentId: taskEnvironment.environment.id,
                      ...(taskEnvironment.workspaces[0] ? { workspaceId: taskEnvironment.workspaces[0].id } : {}),
                      writableRoots: taskEnvironment.writableRoots,
                    }
                  : { writableRoots: [project.localPath] }),
                taskTitle: task.title,
                prompt: buildTaskPushPrompt(task, supplementalInfo),
                attachments: attachmentInput.attachments,
                allowedAttachmentRoots: attachmentInput.allowedRoots,
                model: selectedModel.model,
                ...(selectedEffort ? { effort: selectedEffort } : {}),
                ...(requestedServiceTier.present ? { serviceTier } : {}),
                workMode,
                // 兼容字段在该链路中不参与权限或提示词决策；权限完全取自弹窗的 permissionMode。
                allowCodeChanges: false,
                allowTests: false,
                allowGitCommit: false,
                applyLegacyTaskGuards: false,
                bypassConcurrency: true,
                permissionMode,
                idempotencyKey,
                clientUserMessageId,
                providerWriteLifecycle: reservedLifecycle,
              });
      } else {
        if (body.content !== undefined && typeof body.content !== 'string') throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Create content must be a string.');
        const collaborationMode = body.collaborationMode === undefined ? 'default' : parseConversationCollaborationMode(body.collaborationMode);
        if (!collaborationMode) throw nativeApiError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.');
        const permissionMode = body.permissionMode === undefined ? (task.allowCodeChanges ? 'auto' : 'read-only') : parseConversationPermissionMode(body.permissionMode);
        if (!permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
        const explicitAttachments = normalizeNativeConversationAttachments(body.attachments, project.localPath);
        const explicitContent = typeof body.content === 'string' ? body.content.trim() : '';
        const canonicalAttachmentInput = body.attachments === undefined && !explicitContent ? normalizeTaskPushAttachments(task, project.localPath) : null;
        const attachments = canonicalAttachmentInput?.attachments ?? explicitAttachments;
        const content = explicitContent || createTaskRuntimePrompt(task);
        const capabilities = await resolveConversationCapabilities(project);
        const selectedModel = capabilities.models.find((candidate) => candidate.model === capabilities.preferredModel || candidate.id === capabilities.preferredModel) ?? capabilities.models[0]!;
        const requestedServiceTier = readServiceTierOverride(body);
        const serviceTier = normalizeServiceTierForCapability(requestedServiceTier, selectedModel);
        const inheritConversationId = typeof body.inheritConversationId === 'string' ? body.inheritConversationId.trim() : '';
        let inheritedEnvironment: Awaited<ReturnType<typeof resolveTaskPushEnvironment>> | null = null;
        if (inheritConversationId) {
          const sourceConversation = conversations.getById(inheritConversationId);
          if (!sourceConversation || sourceConversation.projectId !== project.id || sourceConversation.taskId !== task.id) {
            throw nativeApiError('ZEUS_TASK_EXECUTION_CONTEXT_INVALID', 'The source conversation does not belong to this task.');
          }
          if (!sourceConversation.environmentId && !sourceConversation.workspaceId) {
            throw nativeApiError('ZEUS_TASK_EXECUTION_CONTEXT_REQUIRED', 'The source task conversation has no persisted execution workspace.');
          }
          inheritedEnvironment = await resolveTaskPushEnvironment(
            project,
            task,
            sourceConversation.environmentId ? { mode: 'existing', environmentId: sourceConversation.environmentId } : { mode: 'existing', workspaceId: sourceConversation.workspaceId },
            stableOperationId,
          );
        }
        nativeOperation = await codexNativeCoordinator.startTaskConversation({
          conversationId: reservation.conversationId,
          submissionId: reservation.submissionId,
          projectId: project.id,
          projectLocalPath: inheritedEnvironment?.cwd ?? project.localPath,
          taskId: task.id,
          ...(inheritedEnvironment
            ? {
                environmentId: inheritedEnvironment.environment.id,
                ...(inheritedEnvironment.workspaces[0] ? { workspaceId: inheritedEnvironment.workspaces[0].id } : {}),
                writableRoots: inheritedEnvironment.writableRoots,
              }
            : {}),
          taskTitle: task.title,
          prompt: content,
          attachments,
          ...(canonicalAttachmentInput?.allowedRoots.length ? { allowedAttachmentRoots: canonicalAttachmentInput.allowedRoots } : {}),
          model: selectedModel.model,
          ...(requestedServiceTier.present ? { serviceTier } : {}),
          allowCodeChanges: task.allowCodeChanges,
          allowTests: task.allowTests,
          allowGitCommit: task.allowGitCommit,
          permissionMode,
          workMode: collaborationMode,
          idempotencyKey,
          clientUserMessageId,
          providerWriteLifecycle: reservedLifecycle,
        });
      }
    } else if (body.mode === 'resume') {
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      const selected = conversations.getById(conversationId);
      if (!selected || selected.projectId !== project.id || selected.taskId !== task.id || selected.archived) {
        throw nativeApiError('ZEUS_CONVERSATION_CHOICE_INVALID', 'Selected conversation does not belong to this task.');
      }
      if (selected.transportKind !== 'codex_native') throw nativeApiError('ZEUS_LEGACY_CONVERSATION_READ_ONLY', 'Legacy conversations are read-only and cannot be resumed as native threads.');
      if (!content) throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Resume content is required.');
      if (selected.id !== reservation.conversationId) throw nativeApiError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Selected resume conversation does not match the reserved task acceptance resource.');
      const collaborationMode = body.collaborationMode === undefined ? selected.collaborationMode : parseConversationCollaborationMode(body.collaborationMode);
      if (!collaborationMode) throw nativeApiError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.');
      nativeOperation = await codexNativeCoordinator.submitMessage({
        conversationId: selected.id,
        submissionId: reservation.submissionId,
        content,
        collaborationMode,
        idempotencyKey,
        clientUserMessageId,
        providerWriteLifecycle: reservedLifecycle,
      });
    } else if (body.mode === 'reference_legacy') {
      const sourceConversationId = typeof body.sourceConversationId === 'string' ? body.sourceConversationId : '';
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      const messageIds = Array.isArray(body.messageIds) && body.messageIds.every((messageId) => typeof messageId === 'string') ? body.messageIds : [];
      const selected = conversations.getById(sourceConversationId);
      if (!selected || selected.projectId !== project.id || selected.taskId !== task.id || selected.transportKind !== 'legacy_cli') {
        throw nativeApiError('ZEUS_CONVERSATION_CHOICE_INVALID', 'Selected legacy conversation does not belong to this task.');
      }
      if (!content || messageIds.length === 0) throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', 'Legacy reference content and explicit messageIds are required.');
      const permissionMode = body.permissionMode === undefined ? (task.allowCodeChanges ? 'auto' : 'read-only') : parseConversationPermissionMode(body.permissionMode);
      if (!permissionMode) throw nativeApiError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.');
      const collaborationMode = body.collaborationMode === undefined ? 'default' : parseConversationCollaborationMode(body.collaborationMode);
      if (!collaborationMode) throw nativeApiError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.');
      nativeOperation = await codexNativeCoordinator.startTaskConversation({
        conversationId: reservation.conversationId,
        submissionId: reservation.submissionId,
        projectId: project.id,
        projectLocalPath: project.localPath,
        taskId: task.id,
        taskTitle: task.title,
        prompt: content,
        model: await resolveCodexModel(project),
        allowCodeChanges: task.allowCodeChanges,
        allowTests: task.allowTests,
        allowGitCommit: task.allowGitCommit,
        permissionMode,
        workMode: collaborationMode,
        idempotencyKey,
        clientUserMessageId,
        legacyReference: { conversationId: selected.id, messageIds },
        providerWriteLifecycle: reservedLifecycle,
      });
    } else {
      throw nativeApiError('ZEUS_INVALID_CONVERSATION_START', `Unsupported conversation mode: ${String(body.mode)}`);
    }

    const conversation = conversations.getById(nativeOperation.conversationId);
    const submission = conversationSubmissions.getById(nativeOperation.submissionId);
    if (!conversation || !submission || conversation.id !== reservation.conversationId || submission.id !== reservation.submissionId || submission.conversationId !== conversation.id) {
      throw nativeApiError('ZEUS_NATIVE_ACCEPTANCE_NOT_DURABLE', 'Native conversation acceptance did not persist the exact reserved resources.');
    }
    if (body.mode === 'create' && body.source === 'task_push') {
      const environmentWorkspaces = conversation.environmentId
        ? taskWorkspaces.listByEnvironment(conversation.environmentId)
        : conversation.workspaceId
          ? [taskWorkspaces.getById(conversation.workspaceId)].filter((workspace): workspace is ZeusTaskWorkspaceRecord => Boolean(workspace))
          : [];
      for (const taskWorkspace of environmentWorkspaces) {
        if (!taskWorkspace.worktreePath) continue;
        try {
          const review = await readTaskWorkspaceReview(taskWorkspace);
          taskWorkspaces.update(taskWorkspace.id, { headSha: review.headSha, state: 'ready', lastError: null });
        } catch (error) {
          taskWorkspaces.update(taskWorkspace.id, { state: 'failed', lastError: error instanceof Error ? error.message : 'Task workspace review failed.' });
        }
      }
      if (nativeOperation.status === 'active') {
        const latestTask = tasks.getById(task.id);
        const projectStatusConfig = resolveTaskManagementStatusConfigForProject(task.projectId);
        if (latestTask?.managementStatus === projectStatusConfig.roles.defaultStatusId) {
          const updatedTask = tasks.updateManagementStatus(latestTask.id, projectStatusConfig.roles.pushedStatusId, latestTask.updatedAt);
          recordTaskEvent({
            taskId: updatedTask.id,
            eventType: 'task.management_status.changed',
            title: '任务推送成功，管理状态已更新',
            payload: {
              from: latestTask.managementStatus,
              to: updatedTask.managementStatus,
              trigger: 'task.model_push.started',
              conversationId: conversation.id,
            },
          });
          appendAuditLog({
            actorType: 'system',
            action: 'task.management_status.changed',
            resourceType: 'task',
            resourceId: updatedTask.id,
            payload: {
              taskId: updatedTask.id,
              projectId: updatedTask.projectId,
              from: latestTask.managementStatus,
              to: updatedTask.managementStatus,
              trigger: 'task.model_push.started',
              conversationId: conversation.id,
            },
          });
          publishRealtimeEvent('task.updated', {
            taskId: updatedTask.id,
            projectId: updatedTask.projectId,
            managementStatus: updatedTask.managementStatus,
            changedFields: ['managementStatus'],
            updatedAt: updatedTask.updatedAt,
          });
        }
        const runningTask = moveTaskTowardRunning(task.id, 'task.model_push.started');
        recordTaskEvent({
          taskId: runningTask.id,
          eventType: 'task.model_push.started',
          title: '任务已推送到模型',
          payload: {
            conversationId: conversation.id,
            providerThreadId: nativeOperation.providerThreadId,
            providerTurnId: nativeOperation.providerTurnId,
            model: conversation.providerModel,
            permissionMode: conversation.permissionMode,
            workMode: body.workMode,
          },
        });
      } else if (nativeOperation.providerThreadId) {
        const runningTask = moveTaskTowardRunning(task.id, 'task.model_push.thread_created');
        const failedTask = transitionTaskStatus(runningTask, 'failed', 'task.model_push.turn_failed');
        recordTaskEvent({
          taskId: failedTask.id,
          eventType: 'task.model_push.turn_failed',
          title: '会话已创建，但首轮发送失败',
          payload: {
            conversationId: conversation.id,
            providerThreadId: nativeOperation.providerThreadId,
            operationStatus: nativeOperation.status,
          },
        });
      }
      await db.save();
    }
    return toNativeDurableAcceptance(stableOperationId, idempotencyKey, conversation, submission);
  }

  function recoverTaskConversationAcceptance(project: ZeusProjectRecord, task: ZeusTaskRecord, idempotencyKey: string, expected: TaskConversationAcceptanceReservation, persistedResourceId: string | null) {
    const persisted = decodeTaskConversationAcceptanceReservation(persistedResourceId);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(expected)) return undefined;
    const conversation = conversations.getById(persisted.conversationId);
    const submission = conversationSubmissions.getById(persisted.submissionId);
    if (
      !conversation ||
      !submission ||
      conversation.projectId !== project.id ||
      conversation.taskId !== task.id ||
      submission.conversationId !== conversation.id ||
      submission.idempotencyKey !== idempotencyKey ||
      persisted.scope !== `task-conversation:${task.id}` ||
      persisted.operationId !== expected.operationId ||
      persisted.requestHash !== expected.requestHash
    ) {
      return undefined;
    }
    // response_json 是 acceptance 的唯一不可变 checkpoint；缺失时即便 provider turn 已存在也不能从可变 snapshot 伪造原响应。
    return undefined;
  }

  function toNativeDurableAcceptance(stableOperationId: string, idempotencyKey: string, conversation: ZeusConversationWithMessagesRecord, submission: NonNullable<ReturnType<ConversationSubmissionRepository['getById']>>) {
    const conversationSummary = toNativeConversationSummary(conversation);
    const submissionSummary = toNativeSubmission(submission);
    return {
      operation: { id: stableOperationId, status: 'accepted' as const, idempotencyKey },
      conversation: { ...conversationSummary, updatedAt: conversationSummary.createdAt },
      submission: { ...submissionSummary, updatedAt: submissionSummary.createdAt },
    };
  }

  function toNativeInterruptAcceptance(stableOperationId: string, idempotencyKey: string, conversation: ZeusConversationWithMessagesRecord, submission: ReturnType<ConversationSubmissionRepository['getById']>) {
    const conversationSummary = toNativeConversationSummary(conversation);
    const submissionSummary = submission ? toNativeSubmission(submission) : undefined;
    return {
      operation: { id: stableOperationId, status: 'accepted' as const, idempotencyKey },
      conversation: { ...conversationSummary, updatedAt: conversationSummary.createdAt },
      ...(submissionSummary ? { submission: { ...submissionSummary, updatedAt: submissionSummary.createdAt } } : {}),
    };
  }

  function readIdempotencyKey(request: FastifyRequest): string | null {
    const value = request.headers['idempotency-key'];
    const normalized = Array.isArray(value) ? value[0] : value;
    return typeof normalized === 'string' && normalized.trim() ? normalized.trim() : null;
  }

  async function executeIdempotentJson<T>(
    scope: string,
    idempotencyKey: string,
    requestBody: unknown,
    statusCode: number,
    execute: (stableOperationId: string, lifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void }) => Promise<T>,
    recover?: (stableOperationId: string, persistedResourceId: string | null) => { statusCode: number; body: T } | undefined | Promise<{ statusCode: number; body: T } | undefined>,
    preparedResourceId?: string,
  ): Promise<{ statusCode: number; body: T }> {
    if (!codexNativeEnabled) throw nativeApiError('ZEUS_CODEX_NATIVE_DISABLED', 'Codex native conversation writes are disabled by ZEUS_CODEX_NATIVE_ENABLED.');
    const hash = nativeIdempotencyRequestHash(requestBody);
    const stableOperationId = nativeStableOperationId(scope, idempotencyKey, hash);
    const inFlightKey = `${scope}\0${idempotencyKey}`;
    const inFlight = nativeIdempotentInFlight.get(inFlightKey);
    if (inFlight) {
      if (inFlight.requestHash !== hash) throw nativeApiError('ZEUS_IDEMPOTENCY_CONFLICT', `Idempotency-Key ${idempotencyKey} was already used with a different request body.`);
      return (await inFlight.promise) as { statusCode: number; body: T };
    }
    const promise = Promise.resolve().then(() => executeOwnedIdempotentJson(scope, idempotencyKey, hash, stableOperationId, statusCode, execute, recover, preparedResourceId));
    nativeIdempotentInFlight.set(inFlightKey, { requestHash: hash, promise: promise as Promise<{ statusCode: number; body: unknown }> });
    try {
      return await promise;
    } finally {
      if (nativeIdempotentInFlight.get(inFlightKey)?.promise === promise) nativeIdempotentInFlight.delete(inFlightKey);
    }
  }

  async function executeOwnedIdempotentJson<T>(
    scope: string,
    idempotencyKey: string,
    hash: string,
    stableOperationId: string,
    statusCode: number,
    execute: (stableOperationId: string, lifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void }) => Promise<T>,
    recover: ((stableOperationId: string, persistedResourceId: string | null) => { statusCode: number; body: T } | undefined | Promise<{ statusCode: number; body: T } | undefined>) | undefined,
    initialPreparedResourceId: string | undefined,
  ): Promise<{ statusCode: number; body: T }> {
    const existing = db.get<{ request_hash: string; status: string; http_status: number | null; response_json: string | null; resource_id: string | null }>(
      'SELECT request_hash, status, http_status, response_json, resource_id FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?',
      [scope, idempotencyKey],
    );
    let preparedResourceId = initialPreparedResourceId ?? stableOperationId;
    if (existing) {
      if (existing.request_hash !== hash) throw nativeApiError('ZEUS_IDEMPOTENCY_CONFLICT', `Idempotency-Key ${idempotencyKey} was already used with a different request body.`);
      if (existing.status === 'completed' && existing.response_json) {
        return { statusCode: existing.http_status ?? statusCode, body: JSON.parse(existing.response_json) as T };
      }
      if (existing.status === 'in_progress' && existing.response_json) {
        db.execute(`UPDATE idempotency_requests SET status = 'completed', updated_at = ? WHERE scope = ? AND idempotency_key = ?`, [now().toISOString(), scope, idempotencyKey]);
        await db.save();
        return { statusCode: existing.http_status ?? statusCode, body: JSON.parse(existing.response_json) as T };
      }
      if (existing.status === 'in_progress') {
        const marker = parseNativeIdempotencyMarker(existing.resource_id);
        if (marker.phase === 'rpc_started') {
          const recovered = recover ? await recover(stableOperationId, marker.resourceId) : undefined;
          if (recovered !== undefined) {
            await checkpointCompletedIdempotentResponse(scope, idempotencyKey, recovered.statusCode, recovered.body);
            return recovered;
          }
          const recoveryRequired = createNativeIdempotencyRecoveryRequired(stableOperationId, idempotencyKey, marker.resourceId) as T;
          await checkpointCompletedIdempotentResponse(scope, idempotencyKey, 409, recoveryRequired);
          return { statusCode: 409, body: recoveryRequired };
        }
        preparedResourceId = marker.resourceId ?? preparedResourceId;
      }
      db.execute('DELETE FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?', [scope, idempotencyKey]);
      await db.save();
    }
    idempotencyRequests.createOrGet({
      scope,
      idempotencyKey,
      requestHash: hash,
      status: 'in_progress',
      resourceId: `prepared:${preparedResourceId}`,
      createdAt: now().toISOString(),
    });
    await db.save();
    let phase: 'prepared' | 'rpc_started' = 'prepared';
    let resourceId = preparedResourceId;
    const updateMarker = (nextPhase: 'prepared' | 'rpc_started', nextResourceId: string): void => {
      db.execute(`UPDATE idempotency_requests SET resource_id = ?, updated_at = ? WHERE scope = ? AND idempotency_key = ?`, [`${nextPhase}:${nextResourceId}`, now().toISOString(), scope, idempotencyKey]);
      phase = nextPhase;
      resourceId = nextResourceId;
    };
    try {
      const body = await execute(stableOperationId, {
        markPrepared: async (nextResourceId) => {
          updateMarker('prepared', nextResourceId);
          await db.save();
        },
        markRpcStarted: (nextResourceId) => updateMarker('rpc_started', nextResourceId),
      });
      await checkpointCompletedIdempotentResponse(scope, idempotencyKey, statusCode, body);
      return { statusCode, body };
    } catch (error) {
      if (phase === 'prepared') {
        db.execute('DELETE FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?', [scope, idempotencyKey]);
        await db.save();
      } else {
        db.execute(`UPDATE idempotency_requests SET resource_id = ?, updated_at = ? WHERE scope = ? AND idempotency_key = ?`, [`rpc_started:${resourceId}`, now().toISOString(), scope, idempotencyKey]);
        await db.save();
      }
      throw error;
    }
  }

  function parseNativeIdempotencyMarker(value: string | null): { phase: 'prepared' | 'rpc_started'; resourceId: string | null } {
    if (value?.startsWith('prepared:')) return { phase: 'prepared', resourceId: value.slice('prepared:'.length) || null };
    if (value?.startsWith('rpc_started:')) return { phase: 'rpc_started', resourceId: value.slice('rpc_started:'.length) || null };
    return { phase: 'rpc_started', resourceId: value };
  }

  function createNativeIdempotencyRecoveryRequired(stableOperationId: string, idempotencyKey: string, resourceId: string | null) {
    return {
      error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED',
      message: 'The provider write may have started, but Zeus has no durable proof of its outcome. The RPC was not replayed.',
      recoveryRequired: true,
      operation: { id: stableOperationId, status: 'recovery_required' as const, idempotencyKey },
      ...(resourceId ? { resourceId } : {}),
    };
  }

  async function checkpointCompletedIdempotentResponse(scope: string, idempotencyKey: string, statusCode: number, body: unknown): Promise<void> {
    db.execute(`UPDATE idempotency_requests SET http_status = ?, response_json = ?, updated_at = ? WHERE scope = ? AND idempotency_key = ?`, [statusCode, JSON.stringify(body), now().toISOString(), scope, idempotencyKey]);
    await db.save();
    db.execute(`UPDATE idempotency_requests SET status = 'completed', updated_at = ? WHERE scope = ? AND idempotency_key = ?`, [now().toISOString(), scope, idempotencyKey]);
    await db.save();
  }

  async function checkpointInProgressIdempotentResponse(scope: string, idempotencyKey: string, statusCode: number, body: unknown): Promise<void> {
    db.execute(`UPDATE idempotency_requests SET http_status = ?, response_json = ?, updated_at = ? WHERE scope = ? AND idempotency_key = ? AND status = 'in_progress'`, [
      statusCode,
      JSON.stringify(body),
      now().toISOString(),
      scope,
      idempotencyKey,
    ]);
    await db.save();
  }

  function sendNativeConversationApiError(reply: FastifyReply, error: unknown) {
    const code = isNativeApiRecord(error) && typeof error.code === 'string' ? error.code : 'ZEUS_NATIVE_CONVERSATION_API_ERROR';
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = code.endsWith('_NOT_FOUND')
      ? 404
      : code.includes('CONFLICT') ||
          code.includes('LOGIN_REQUIRED') ||
          code.includes('CHOICE_REQUIRED') ||
          code.includes('READ_ONLY') ||
          code.includes('NOT_EDITABLE') ||
          code.includes('NOT_QUEUED') ||
          code.includes('NOT_ACTIVE') ||
          code.includes('NOT_INTERRUPTED') ||
          code.includes('IN_PROGRESS') ||
          code.includes('MISMATCH') ||
          code.includes('EXCEEDS_POLICY') ||
          code.includes('EXCEEDS_REQUEST') ||
          code.includes('ATTACHMENT_UNAVAILABLE') ||
          code.includes('NATIVE_DISABLED') ||
          code.includes('NOT_AVAILABLE') ||
          code.includes('STALE')
        ? 409
        : code.startsWith('ZEUS_INVALID_') || code.endsWith('_INVALID') || code.endsWith('_REQUIRED') || code.includes('_UNSUPPORTED')
          ? 400
          : 500;
    return reply.code(statusCode).send({ error: code, message, ...(code.includes('STALE') || code.includes('RECOVERY_REQUIRED') ? { recoveryRequired: true } : {}) });
  }

  function sendModelConnectionError(reply: FastifyReply, error: unknown) {
    const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
    const code = typeof candidate?.code === 'string' ? candidate.code : 'ZEUS_MODEL_CONNECTION_FAILED';
    const statusCode = typeof candidate?.statusCode === 'number' && candidate.statusCode >= 400 && candidate.statusCode <= 599 ? candidate.statusCode : code.endsWith('_NOT_FOUND') ? 404 : 400;
    const message = typeof candidate?.message === 'string' && candidate.message.trim() ? candidate.message : '模型连接操作失败。';
    return reply.code(statusCode).send({ error: code, message });
  }

  function nativeApiError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
  }

  function assertRequestedAgentIsCodex(value: unknown): void {
    if (!isNativeApiRecord(value) || value.agentKind === undefined || value.agentKind === 'codex') return;
    if (value.agentKind === 'pi' || value.agentKind === 'claude') {
      throw nativeApiError('ZEUS_AGENT_NOT_AVAILABLE', `${value.agentKind === 'pi' ? 'Pi' : 'Claude'} Agent 当前尚未开放。`);
    }
    throw nativeApiError('ZEUS_INVALID_AGENT_KIND', 'agentKind must be codex, pi, claude, or omitted.');
  }

  function assertRequestedAgentKind(value: unknown): void {
    if (!isNativeApiRecord(value) || value.agentKind === undefined || value.agentKind === 'codex' || value.agentKind === 'pi') return;
    if (value.agentKind === 'claude') throw nativeApiError('ZEUS_AGENT_NOT_AVAILABLE', 'Claude Agent 当前尚未开放。');
    throw nativeApiError('ZEUS_INVALID_AGENT_KIND', 'agentKind must be codex, pi, claude, or omitted.');
  }

  function parseConversationPermissionMode(value: unknown): ConversationPermissionMode | null {
    return value === 'read-only' || value === 'auto' || value === 'full-access' ? value : null;
  }

  function parseConversationCollaborationMode(value: unknown): ConversationCollaborationMode | null {
    return value === 'default' || value === 'plan' ? value : null;
  }

  function isNativeApiRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function canonicalNativeApiJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalNativeApiJson).join(',')}]`;
    if (isNativeApiRecord(value)) {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalNativeApiJson(value[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  function nativeIdempotencyRequestHash(value: unknown): string {
    return createHash('sha256').update(canonicalNativeApiJson(value)).digest('hex');
  }

  function nativeStableOperationId(scope: string, idempotencyKey: string, requestHash: string): string {
    return `native_operation_${createHash('sha256').update(`${scope}\0${idempotencyKey}\0${requestHash}`).digest('hex').slice(0, 24)}`;
  }

  async function resolveCodexModel(project: ZeusProjectRecord): Promise<string> {
    if (!codexNativeEnabled) throw nativeApiError('ZEUS_CODEX_NATIVE_DISABLED', 'Codex native conversation writes are disabled by ZEUS_CODEX_NATIVE_ENABLED.');
    const projectConfig = readProjectConfig(project.id);
    const configured = projectConfig.defaultModel ?? runtimeSettings.adapterModels.codex;
    if (configured?.trim()) return configured.trim();
    const capabilities = await codexAppServerManager.ensureReady({ commandPath: currentCodexRuntimeCommandPath(), ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}) });
    const firstSupported = capabilities.supportedModels[0];
    if (!firstSupported) {
      throw Object.assign(new Error('Codex app-server did not report an available model.'), { code: 'ZEUS_CODEX_MODEL_UNAVAILABLE' });
    }
    return firstSupported;
  }

  /** Worktree 仓库属于本次推送的实时事实，不再要求用户在项目设置中维护清单。 */
  async function synchronizeDiscoveredProjectRepositories(project: ZeusProjectRecord): Promise<ZeusProjectRepositoryRecord[]> {
    const discovered = await discoverGitRepositories(project.localPath);
    const records = projectRepositories.replaceForProject(
      project.id,
      discovered.map((repository) => ({
        projectId: project.id,
        name: repository.name,
        relativePath: repository.relativePath,
        localPath: repository.localPath,
      })),
    );
    await db.save();
    return records;
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

  async function resolveTaskPushCapabilities(project: ZeusProjectRecord, task: ZeusTaskRecord) {
    const capabilities = await resolveConversationCapabilities(project);
    const registeredRepositories = await synchronizeDiscoveredProjectRepositories(project);
    const repositoryCapabilities = await Promise.all(
      registeredRepositories.map(async (registeredRepository) => {
        const [repository, review] = await Promise.all([
          getGitRepositoryContext(registeredRepository.localPath),
          getTaskWorkspaceReview(registeredRepository.localPath, projectRepositoryIgnoredPaths(project.id, registeredRepository.id, registeredRepository.localPath)),
        ]);
        if (!repository.isRepository) {
          throw nativeApiError('ZEUS_PROJECT_REPOSITORY_UNAVAILABLE', `Project repository is unavailable: ${registeredRepository.relativePath}`);
        }
        const defaultRemoteName = repository.remotes.includes('origin') ? 'origin' : (repository.remotes[0] ?? '');
        const refreshedRemote = defaultRemoteName ? await fetchGitRemote(registeredRepository.localPath, defaultRemoteName) : null;
        const sourceRefs = refreshedRemote
          ? refreshedRemote.branches.map((ref) => {
              const branch = ref.slice(`${defaultRemoteName}/`.length);
              return {
                ref,
                label: `${branch} · ${defaultRemoteName}`,
                kind: 'remote' as const,
                current: branch === repository.branch,
              };
            })
          : repository.localBranches.map((ref) => ({
              ref,
              label: ref,
              kind: 'local' as const,
              current: ref === repository.branch,
            }));
        return {
          ...registeredRepository,
          branch: repository.branch,
          headSha: repository.headSha,
          clean: review.clean,
          defaultRemoteName,
          sourceMode: defaultRemoteName ? ('remote' as const) : ('local' as const),
          sourceRefs,
          suggestedBranchName: buildTaskBranchName(task.taskCode, task.title, taskEnvironments.listByTask(task.id).length + 1),
        };
      }),
    );
    const primaryRepository = repositoryCapabilities[0];
    return {
      ...capabilities,
      taskId: task.id,
      canonicalPrompt: createTaskRuntimePrompt(task),
      repositories: repositoryCapabilities,
      directWorkspace: {
        path: project.localPath,
        activeWritableConversationCount: countDirectProjectActiveWritableConversations(project.id),
      },
      sharedWritablePaths: projectSharedPaths.listByProject(project.id),
      git: {
        primaryWorkspacePath: primaryRepository?.localPath ?? project.localPath,
        primaryBranch: primaryRepository?.branch ?? '',
        primaryHeadSha: primaryRepository?.headSha ?? '',
        primaryClean: primaryRepository?.clean ?? true,
        defaultRemoteName: primaryRepository?.defaultRemoteName ?? '',
        sourceRefs: primaryRepository?.sourceRefs ?? [],
        suggestedBranchName: buildTaskBranchName(task.taskCode, task.title, taskEnvironments.listByTask(task.id).length + 1),
        worktreeRoot: join(dirname(project.localPath), '.zeus-worktrees'),
      },
    };
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

    const registeredRepositories = await synchronizeDiscoveredProjectRepositories(project);
    if (registeredRepositories.length === 0) {
      throw nativeApiError('ZEUS_WORKTREE_REPOSITORY_REQUIRED', 'No Git repository was found in the project directory. Initialize a repository or use the project directory directly.');
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
      for (let index = 0; index < registeredRepositories.length; index += 1) {
        const registeredRepository = registeredRepositories[index]!;
        const requested = requestedById.get(registeredRepository.id);
        if (!requested) throw nativeApiError('ZEUS_TASK_REPOSITORY_SELECTION_INCOMPLETE', `Choose a source branch for ${registeredRepository.relativePath}.`);
        const sourceRef = typeof requested.sourceRef === 'string' ? requested.sourceRef.trim() : '';
        const repository = await getGitRepositoryContext(registeredRepository.localPath);
        const remoteName = repository.remotes.includes('origin') ? 'origin' : (repository.remotes[0] ?? '');
        const refreshedRemote = remoteName ? await fetchGitRemote(registeredRepository.localPath, remoteName) : null;
        const sourceKind = refreshedRemote ? ('remote' as const) : ('local' as const);
        if (!sourceRef || (refreshedRemote ? !refreshedRemote.branches.includes(sourceRef) : !repository.localBranches.includes(sourceRef))) {
          throw nativeApiError(
            'ZEUS_TASK_SOURCE_BRANCH_INVALID',
            refreshedRemote ? `Choose a branch from the latest ${remoteName} snapshot for ${registeredRepository.relativePath}.` : `Choose a local named source branch for ${registeredRepository.relativePath}.`,
          );
        }
        const sourceBranch = refreshedRemote ? sourceRef.slice(`${remoteName}/`.length) : sourceRef;
        const branchName = typeof requested.branchName === 'string' && requested.branchName.trim() ? requested.branchName.trim() : buildTaskBranchName(task.taskCode, task.title, taskEnvironments.listByTask(task.id).length + 1);
        if (taskWorkspaces.getByRepositoryBranch(registeredRepository.id, branchName)) {
          throw nativeApiError('ZEUS_TASK_BRANCH_ALREADY_MANAGED', `Task branch is already managed in ${registeredRepository.relativePath}: ${branchName}`);
        }
        const workspaceId = `task_workspace_${createHash('sha256').update(`${stableOperationId}\0${registeredRepository.id}`).digest('hex').slice(0, 24)}`;
        const prepared = await prepareTaskWorktree({
          repositoryPath: registeredRepository.localPath,
          projectSlug: project.slug,
          taskCode: task.taskCode,
          taskTitle: task.title,
          workspaceId,
          branchName,
          sourceRef,
          sourceKind,
          sourceBranch,
          existingBranch: false,
          worktreePath: join(environmentRoot, registeredRepository.relativePath),
          includeLocalChanges: sourceKind === 'local' && requested.includeLocalChanges === true,
          ignoredPaths: projectRepositoryIgnoredPaths(project.id, registeredRepository.id, registeredRepository.localPath),
        });
        preparedMembers.push({ repository: registeredRepository, prepared, remoteName });
      }
      overlayTaskEnvironmentSharedPaths(environmentRoot, projectSharedPaths.listByProject(project.id));
    } catch (error) {
      for (const member of [...preparedMembers].reverse()) {
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
      for (const member of [...preparedMembers].reverse()) {
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

  function assertTaskEnvironmentWritable(environment: ZeusTaskEnvironmentRecord): void {
    if (conversations.listByEnvironment(environment.id).some((conversation) => conversation.providerState === 'binding' || conversation.providerState === 'active' || conversation.providerState === 'waiting')) {
      throw nativeApiError('ZEUS_TASK_ENVIRONMENT_BUSY', 'The selected task environment already has an active writable Codex turn.');
    }
  }

  function assertTaskWorkspaceWritable(workspace: ZeusTaskWorkspaceRecord): void {
    if (countTaskWorkspaceActiveConversations(workspace) > 0) {
      throw nativeApiError('ZEUS_TASK_WORKSPACE_BUSY', `Task branch ${workspace.branchName} already has an active writable Codex turn.`);
    }
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

  /** 来源分支远端交付成功后回收干净任务目录；清理失败不能反写成交付失败。 */
  async function markTaskWorkspaceDelivered(workspace: ZeusTaskWorkspaceRecord): Promise<boolean> {
    if (!workspace.worktreePath) {
      taskWorkspaces.update(workspace.id, { state: 'merged', lastError: null });
      reconcileTaskEnvironmentState(workspace.environmentId);
      return false;
    }
    const nested = nestedTaskWorkspacesWithWorktree(workspace);
    if (nested.length > 0) {
      taskWorkspaces.update(workspace.id, {
        state: 'merged',
        lastError: `目标分支已交付；等待嵌套仓库 Worktree 先回收：${nested.map((entry) => entry.repositoryRelativePath).join('、')}`,
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
        lastError: `目标分支已交付，但任务 worktree 回收失败：${message}`,
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
        taskWorkspaces.update(candidate.id, { lastError: `目标分支已交付，但任务 worktree 回收失败：${message}` });
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

  function readTaskWorkspaceReview(workspace: ZeusTaskWorkspaceRecord) {
    if (!workspace.worktreePath) throw nativeApiError('ZEUS_TASK_WORKTREE_UNAVAILABLE', 'Task worktree is not available.');
    return getTaskWorkspaceReview(workspace.worktreePath, taskWorkspaceIgnoredPaths(workspace));
  }

  function listTaskWorkspaceConversations(workspace: ZeusTaskWorkspaceRecord): ZeusConversationWithMessagesRecord[] {
    return workspace.environmentId ? conversations.listByEnvironment(workspace.environmentId) : conversations.listByWorkspace(workspace.id);
  }

  async function inspectTaskTerminalCleanup(taskId: string, fallbackRepositoryPath: string) {
    const workspacePlans = await Promise.all(
      taskWorkspaces.listByTask(taskId).map(async (workspace) => {
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
    const activeRuntimeSessionCount = taskRuntimeSessions.filter((session) => session.status === 'running').length;
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

    const runningRuntimeIds = new Set(cleanup.runtimeSessions.filter((session) => session.status === 'running').map((session) => session.id));
    for (const session of aiRuntimeManager.listSessions()) {
      if (runningRuntimeIds.has(session.id)) aiRuntimeManager.stopSession(session.id);
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
    for (const session of cleanup.runtimeSessions) runtimeSessions.archive(session.id);
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

  /** 保存冲突草稿或最终推送前重新校验候选使用的任务与目标精确提交。 */
  async function assertTaskIntegrationStillCurrent(project: ZeusProjectRecord, workspace: ZeusTaskWorkspaceRecord, integration: ZeusTaskIntegrationRecord): Promise<void> {
    const repositoryPath = workspace.repositoryPath || project.localPath;
    const taskHeadSha = await getGitBranchHead(repositoryPath, workspace.branchName);
    if (!integration.taskHeadSha || integration.taskHeadSha !== taskHeadSha) {
      throw nativeApiError('ZEUS_TASK_HEAD_CHANGED', 'Task branch changed after the integration candidate was created. Rebuild from the current task HEAD.');
    }
    if (workspace.remoteName) {
      await fetchGitRemote(repositoryPath, workspace.remoteName);
      const [remoteTaskHeadSha, remoteTargetHeadSha] = await Promise.all([
        getRemoteTrackingBranchHead(repositoryPath, workspace.remoteName, workspace.remoteBranch),
        getRemoteTrackingBranchHead(repositoryPath, workspace.remoteName, integration.targetBranch),
      ]);
      if (!remoteTaskHeadSha || remoteTaskHeadSha !== taskHeadSha) {
        throw nativeApiError('ZEUS_TASK_BRANCH_PUSH_REQUIRED', `Remote task branch ${workspace.remoteName}/${workspace.remoteBranch} must exactly match local HEAD before merging.`);
      }
      if (remoteTargetHeadSha !== integration.targetHeadSha) {
        throw nativeApiError('ZEUS_TARGET_HEAD_CHANGED', 'Remote target branch advanced while the integration was being prepared.');
      }
      return;
    }
    const targetHeadSha = await getGitBranchHead(repositoryPath, integration.targetBranch);
    if (targetHeadSha !== integration.targetHeadSha) throw nativeApiError('ZEUS_TARGET_HEAD_CHANGED', 'Local target branch advanced while the integration was being prepared.');
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
    return code === 'ZEUS_TARGET_HEAD_CHANGED' || code === 'ZEUS_TASK_HEAD_CHANGED' || code === 'ZEUS_TASK_BRANCH_PUSH_REQUIRED';
  }

  function sendTaskGitApiError(reply: FastifyReply, error: unknown) {
    const code = taskGitErrorCode(error);
    const status =
      code === 'ZEUS_TASK_BRANCH_PUSH_REQUIRED'
        ? 409
        : code.endsWith('_NOT_FOUND')
          ? 404
          : code.endsWith('_INVALID') || code.endsWith('_REQUIRED')
            ? 400
            : /_(?:DIRTY|CONFLICTED|FAILED|BUSY|CHANGED|UNAVAILABLE|ALREADY_EXISTS|ALREADY_MANAGED|CLOSED|VERIFICATION_FAILED|PUSH_REQUIRED|DIVERGED)$/u.test(code)
              ? 409
              : 500;
    return reply.code(status).send({ error: code, message: error instanceof Error ? error.message : 'Task Git operation failed.' });
  }

  function taskGitErrorCode(error: unknown): string {
    return error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string' ? String((error as Error & { code: string }).code) : 'ZEUS_TASK_GIT_OPERATION_FAILED';
  }

  async function waitForTaskConflictAiAnswer(conversationId: string, providerTurnId: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    while (Date.now() < deadline) {
      const turn = conversationTurns.listByConversation(conversationId).find((candidate) => candidate.providerTurnId === providerTurnId);
      if (turn?.status === 'failed') throw nativeApiError('ZEUS_CONFLICT_AI_FAILED', 'AI 处理冲突失败，请打开对应会话查看原因。');
      if (turn?.status === 'interrupted') throw nativeApiError('ZEUS_CONFLICT_AI_INTERRUPTED', 'AI 处理冲突已中断。');
      if (turn?.status === 'completed') {
        const conversation = conversations.getById(conversationId);
        const answer = conversation?.messages
          .filter((message) => message.role === 'assistant' && message.providerTurnId === providerTurnId)
          .map((message) => message.content)
          .join('\n')
          .trim();
        if (!answer) throw nativeApiError('ZEUS_CONFLICT_AI_RESPONSE_EMPTY', 'AI 已结束，但没有返回冲突草稿。');
        return answer;
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 120));
    }
    throw nativeApiError('ZEUS_CONFLICT_AI_TIMEOUT', 'AI 处理冲突超时；对应会话仍保留，可打开查看状态。');
  }

  async function resolveConversationCapabilities(project: ZeusProjectRecord) {
    const piSelection = await modelConnections.getProjectSelection(project.id);
    const piCatalog = await modelConnections.listSelectableModels();
    const allowedPi = piCatalog.filter((model) => piSelection.allowedModelRefs.includes(model.id));
    const codexCapabilities = codexNativeEnabled ? await codexAppServerManager.ensureReady({ commandPath: currentCodexRuntimeCommandPath(), ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}) }) : null;
    const codexAccount = codexCapabilities
      ? await codexAppServerManager.readAccount()
      : {
          generationId: 'codex-disabled',
          requiresOpenaiAuth: false,
          signedIn: false,
          accountType: null,
          planType: null,
        };
    const codexModels = (codexCapabilities?.models ?? []).map((model) => ({
      id: model.id,
      model: model.model,
      agentKind: 'codex' as const,
      sourceId: 'codex',
      sourceName: 'Codex',
      available: true,
      availabilityReason: 'Codex app-server 已报告该模型。',
      ...(model.displayName ? { displayName: model.displayName } : {}),
      supportedReasoningEfforts: [...model.supportedReasoningEfforts],
      ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      serviceTiers: model.serviceTiers.map((tier) => ({ ...tier })),
      ...(model.defaultServiceTier !== undefined ? { defaultServiceTier: model.defaultServiceTier } : {}),
    }));
    const piModels = allowedPi.map((model) => ({
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      agentKind: 'pi' as const,
      sourceId: model.sourceId,
      sourceName: model.sourceName,
      available: model.available,
      availabilityReason: model.availabilityReason,
      supportedReasoningEfforts: [...model.supportedReasoningEfforts],
      defaultReasoningEffort: model.defaultReasoningEffort,
      serviceTiers: [] as Array<{ id: string; name: string; description: string }>,
      defaultServiceTier: null,
      speedLabel: model.speedLabel,
      tools: model.tools,
      imageInput: model.imageInput,
    }));
    const models = [...codexModels, ...piModels];
    if (models.length === 0) throw nativeApiError('ZEUS_MODEL_UNAVAILABLE', '当前项目没有可用的 Codex 或 Pi 模型。');
    const projectConfig = readProjectConfig(project.id);
    const configuredModel = projectConfig.defaultModel ?? runtimeSettings.adapterModels.codex;
    const preferredModel =
      models.find((candidate) => candidate.id === piSelection.defaultModelRef && candidate.available !== false)?.id ??
      models.find((candidate) => (candidate.model === configuredModel || candidate.id === configuredModel) && candidate.available !== false)?.id ??
      models.find((candidate) => candidate.available !== false)?.id ??
      models[0]!.id;
    return {
      generationId: codexCapabilities?.generationId ?? 'pi-sdk',
      initializedAt: codexCapabilities?.initializedAt ?? now().toISOString(),
      projectId: project.id,
      preferredModel,
      models,
      codexAccount,
    };
  }

  async function assertCodexAccountReady(): Promise<void> {
    const account = await codexAppServerManager.readAccount({ refreshToken: true });
    if (!account.requiresOpenaiAuth || account.signedIn) return;
    throw nativeApiError('ZEUS_CODEX_LOGIN_REQUIRED', 'Zeus 专属 Codex 尚未登录。请先完成登录，再创建会话。');
  }

  function readServiceTierOverride(value: object): { present: false } | { present: true; value: string | null } {
    if (!Object.prototype.hasOwnProperty.call(value, 'serviceTier')) return { present: false };
    const serviceTier = (value as { serviceTier?: unknown }).serviceTier;
    if (serviceTier === null) return { present: true, value: null };
    if (typeof serviceTier === 'string' && serviceTier.trim()) return { present: true, value: serviceTier.trim() };
    throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', 'serviceTier must be null, a non-empty catalog id, or omitted.');
  }

  function normalizeServiceTierForCapability(requested: { present: false } | { present: true; value: string | null }, capability: { serviceTiers: Array<{ id: string }> }): string | null | undefined {
    if (!requested.present) return undefined;
    if (requested.value === null) return null;
    return capability.serviceTiers.some((tier) => tier.id === requested.value) ? requested.value : null;
  }

  function buildTaskPushPrompt(task: ZeusTaskRecord, supplementalInfo: string): string {
    return createTaskRuntimePrompt(task, supplementalInfo);
  }

  function normalizeTaskPushAttachments(task: ZeusTaskRecord, projectLocalPath: string): { attachments: NativeConversationAttachment[]; allowedRoots: string[] } {
    const sourceContext = parseTaskSourceContext(task);
    const rawAttachments = Array.isArray(sourceContext.attachments) ? sourceContext.attachments : [];
    const projectRoot = realpathSync(projectLocalPath);
    const allowedRoots = [projectRoot, ...(taskAttachmentRoot ? [taskAttachmentRoot] : [])];
    const unavailable: string[] = [];
    const attachments: NativeConversationAttachment[] = [];
    for (const [index, rawAttachment] of rawAttachments.entries()) {
      const candidate = isNativeApiRecord(rawAttachment) ? rawAttachment : {};
      const storedPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
      const path = resolveCurrentManagedTaskAttachmentPath(candidate, taskAttachmentRoot) ?? storedPath;
      const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : path ? parse(path).base : `附件 ${index + 1}`;
      if (!path || !isAbsolute(path)) {
        unavailable.push(name);
        continue;
      }
      try {
        const canonicalPath = realpathSync(path);
        const resource = statSync(canonicalPath);
        if (
          (!resource.isFile() && !resource.isDirectory()) ||
          !allowedRoots.some((root) => {
            const relativePath = relative(root, canonicalPath);
            return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
          })
        ) {
          throw new Error('outside trusted task attachment roots');
        }
        const storedMime = typeof candidate.mimeType === 'string' && candidate.mimeType.trim() ? candidate.mimeType.trim() : '';
        const kind = resource.isDirectory() ? 'directory' : candidate.kind === 'image' ? 'image' : candidate.kind === 'pasted_text' ? 'pasted_text' : 'file';
        const mime = resource.isDirectory() ? 'inode/directory' : storedMime || (kind === 'image' ? 'image/*' : kind === 'pasted_text' ? 'text/plain' : 'application/octet-stream');
        if (resource.isFile() && (resource.size === 0 || (kind === 'image' && !hasTaskImageSignature(mime.toLowerCase(), readFileSync(canonicalPath))))) {
          throw new Error('empty or unsupported image attachment');
        }
        attachments.push({
          name,
          mime,
          size: resource.isDirectory() ? 0 : resource.size,
          localPath: canonicalPath,
        });
      } catch {
        unavailable.push(name);
      }
    }
    if (unavailable.length > 0) {
      throw nativeApiError('ZEUS_TASK_PUSH_ATTACHMENT_UNAVAILABLE', `以下附件不可用，未创建会话：${unavailable.join('、')}`);
    }
    return { attachments, allowedRoots };
  }

  async function startTaskNativeConversation(project: ZeusProjectRecord, task: ZeusTaskRecord, eventType: string, eventTitle: string, instruction?: string) {
    const prompt = createTaskRuntimePrompt(task, instruction);
    const attachmentInput = normalizeTaskPushAttachments(task, project.localPath);
    const operation = await codexNativeCoordinator.startTaskConversation({
      projectId: project.id,
      projectLocalPath: project.localPath,
      taskId: task.id,
      taskTitle: task.title,
      prompt,
      attachments: attachmentInput.attachments,
      allowedAttachmentRoots: attachmentInput.allowedRoots,
      model: await resolveCodexModel(project),
      allowCodeChanges: task.allowCodeChanges,
      allowTests: task.allowTests,
      allowGitCommit: task.allowGitCommit,
      idempotencyKey: randomUUID(),
      clientUserMessageId: randomUUID(),
    });
    const conversation = conversations.getById(operation.conversationId);
    if (!conversation) throw new Error(`Zeus native conversation not found: ${operation.conversationId}`);
    const nextTask = operation.status === 'active' ? moveTaskTowardRunning(task.id, eventType) : task.status === 'ready' ? task : transitionTaskStatus(task, 'ready', `${eventType}.queued`);
    recordTaskEvent({
      taskId: nextTask.id,
      eventType: operation.status === 'active' ? eventType : 'task.runtime.queued',
      title: operation.status === 'active' ? eventTitle : 'Codex native 并发已满，任务保持 READY',
      payload: {
        conversationId: conversation.id,
        providerThreadId: operation.providerThreadId,
        providerTurnId: operation.providerTurnId,
        adapterId: 'codex',
        transportKind: 'codex_native',
        operationStatus: operation.status,
      },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: operation.status === 'active' ? 'native.conversation.started' : 'native.conversation.queued',
      resourceType: 'conversation',
      resourceId: conversation.id,
      payload: {
        taskId: nextTask.id,
        projectId: project.id,
        providerThreadId: operation.providerThreadId,
        providerTurnId: operation.providerTurnId,
        source: eventType,
      },
    });
    await db.save();
    return { task: nextTask, conversation: toGraphConversationHistoryItem(conversation), nativeOperation: operation, ...(operation.status === 'queued' ? { queued: true as const, reason: 'Codex native concurrency is full.' } : {}) };
  }

  async function startTaskRuntimeSession(
    project: ZeusProjectRecord,
    task: ZeusTaskRecord,
    eventType: string,
    eventTitle: string,
    instruction?: string,
  ): Promise<
    | { task: ZeusTaskRecord; runtimeSession: AiRuntimeSession; conversation: GraphConversationHistoryItem }
    | {
        task: ZeusTaskRecord;
        conversation: GraphConversationHistoryItem;
        nativeOperation: Awaited<ReturnType<typeof codexNativeCoordinator.startTaskConversation>>;
        queued?: true;
        reason?: string;
      }
    | { task: ZeusTaskRecord; conversation: GraphConversationHistoryItem; runtimeError: { message: string } }
    | {
        task: ZeusTaskRecord;
        conversation: GraphConversationHistoryItem;
        queued: true;
        reason: string;
        concurrency: {
          scope: 'project' | 'global';
          limit: number;
          runningCount: number;
        };
      }
  > {
    const adapterId = runtimeSettings.defaultAdapterId;
    if (adapterId === 'codex') {
      return startTaskNativeConversation(project, task, eventType, eventTitle, instruction);
    }
    if (!isNonCodexAiCliAdapterId(adapterId)) {
      throw new Error(`AI CLI adapter not found: ${String(adapterId)}`);
    }
    const prompt = createTaskRuntimePrompt(task, instruction);
    const invocation = createNonCodexTaskRuntimeInvocation(adapterId, project, task, instruction, prompt);
    const startingConversation = createTaskRuntimeConversation(adapterId, invocation.command, project, task, prompt, eventType);
    const concurrency = evaluateRuntimeConcurrency(project.id);
    if (!concurrency.allowed) {
      const queuedConversation = conversations.updateRuntimeState(startingConversation.id, {
        status: 'queued',
        summary: concurrency.reason,
      });
      const readyTask = task.status === 'ready' ? task : transitionTaskStatus(task, 'ready', `${eventType}.queued`);
      recordTaskEvent({
        taskId: readyTask.id,
        eventType: 'task.runtime.queued',
        title: 'Runtime 并发已满，任务保持 READY',
        payload: {
          projectId: project.id,
          scope: concurrency.scope,
          limit: concurrency.limit,
          runningCount: concurrency.runningCount,
        },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: 'runtime.session.queued',
        resourceType: 'task',
        resourceId: readyTask.id,
        payload: {
          taskId: readyTask.id,
          projectId: project.id,
          source: eventType,
          conversationId: queuedConversation.id,
          scope: concurrency.scope,
          limit: concurrency.limit,
          runningCount: concurrency.runningCount,
        },
      });
      await db.save();
      return {
        task: readyTask,
        conversation: toGraphConversationHistoryItem(queuedConversation),
        queued: true,
        reason: concurrency.reason,
        concurrency: {
          scope: concurrency.scope,
          limit: concurrency.limit,
          runningCount: concurrency.runningCount,
        },
      };
    }
    const runningTask = moveTaskTowardRunning(task.id, eventType);
    let session: AiRuntimeSession;
    let runningConversation: ZeusConversationWithMessagesRecord;
    try {
      session = await aiRuntimeManager.startSession({
        projectId: project.id,
        taskId: runningTask.id,
        command: invocation.command,
        args: invocation.args,
        cwd: project.localPath,
        env: buildRuntimeProcessEnv(),
      });
      runningConversation = conversations.updateRuntimeState(startingConversation.id, {
        sessionId: session.id,
        status: 'running',
        summary: `Runtime 会话 ${session.id}`,
      });
      runningConversation = mirrorExistingRuntimeLogsToConversation(session.id, runningConversation.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();
      const failedTask = transitionTaskStatus(runningTask, 'failed', `${eventType}.failed`);
      conversations.appendMessage({
        conversationId: startingConversation.id,
        role: 'system',
        content: `Runtime 启动失败：${message}`,
        source: 'task_runtime_error',
        metadata: {
          projectId: project.id,
          taskId: runningTask.id,
          eventType,
        },
        createdAt: failedAt,
      });
      const failedConversation = conversations.updateRuntimeState(startingConversation.id, {
        status: 'failed',
        summary: message.slice(0, 240),
      });
      await db.save();
      return {
        task: failedTask,
        conversation: toGraphConversationHistoryItem(failedConversation),
        runtimeError: { message },
      };
    }
    recordTaskEvent({
      taskId: runningTask.id,
      eventType,
      title: eventTitle,
      payload: {
        runtimeSessionId: session.id,
        conversationId: runningConversation.id,
        projectId: project.id,
        adapterId: invocation.adapterId,
        argCount: invocation.args.length,
      },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'runtime.session.created',
      resourceType: 'runtime_session',
      resourceId: session.id,
      payload: {
        sessionId: session.id,
        projectId: project.id,
        taskId: runningTask.id,
        conversationId: runningConversation.id,
        command: session.command,
        cwd: session.cwd,
        source: eventType,
      },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'task.status.changed',
      resourceType: 'task',
      resourceId: runningTask.id,
      payload: {
        taskId: runningTask.id,
        projectId: runningTask.projectId,
        from: task.status,
        to: runningTask.status,
        source: eventType,
      },
    });
    publishTaskStatusChanged(runningTask, task.status, runningTask.status, eventType);
    publishRuntimeSessionEvent('runtime.session.created', session, {
      source: eventType,
      conversationId: runningConversation.id,
    });
    await db.save();
    return { task: runningTask, runtimeSession: session, conversation: toGraphConversationHistoryItem(runningConversation) };
  }

  function stopRunningTaskRuntimeSessions(taskId: string): void {
    for (const session of aiRuntimeManager.listSessions().filter((item) => item.taskId === taskId && item.status === 'running')) {
      aiRuntimeManager.stopSession(session.id);
    }
  }

  function transitionTaskStatus(task: ZeusTaskRecord, target: TaskStatus, eventType: string): ZeusTaskRecord {
    const updated = tasks.updateStatus(task.id, getNextTaskStatus(task.status, target));
    recordTaskEvent({
      taskId: updated.id,
      eventType,
      title: taskStatusEventTitle(updated.status),
      payload: { from: task.status, to: updated.status },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'task.status.changed',
      resourceType: 'task',
      resourceId: updated.id,
      payload: {
        taskId: updated.id,
        projectId: updated.projectId,
        from: task.status,
        to: updated.status,
        source: eventType,
      },
    });
    publishTaskStatusChanged(updated, task.status, updated.status, eventType);
    return updated;
  }

  function publishTaskStatusChanged(task: ZeusTaskRecord, from: TaskStatus, to: TaskStatus, source: string): void {
    publishRealtimeEvent('task.status.changed', {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      from,
      to,
      status: task.status,
      source,
    });
  }

  function publishRuntimeSessionEvent(type: 'runtime.session.created' | 'runtime.session.stopped', session: AiRuntimeSession, extra: Record<string, unknown> = {}): void {
    publishRealtimeEvent(type, {
      sessionId: session.id,
      projectId: session.projectId,
      taskId: session.taskId ?? null,
      command: session.command,
      status: session.status,
      cwd: session.cwd,
      ...extra,
    });
  }

  function publishRuntimeLogEvent(log: AiRuntimeLogEntry): void {
    if (log.stream !== 'stdout' && log.stream !== 'stderr') return;
    publishRealtimeEvent(log.stream === 'stderr' ? 'runtime.session.error' : 'runtime.session.output', {
      sessionId: log.sessionId,
      logId: log.id,
      stream: log.stream,
      text: log.text,
      createdAt: log.createdAt,
    });
  }

  function publishRuntimeSessionEnded(session: AiRuntimeSession): void {
    publishRealtimeEvent('runtime.session.ended', {
      sessionId: session.id,
      projectId: session.projectId,
      taskId: session.taskId ?? null,
      command: session.command,
      status: session.status,
      exitCode: session.exitCode ?? null,
      endedAt: session.endedAt ?? null,
    });
  }

  function parseTaskSourceContext(task: ZeusTaskRecord): Record<string, unknown> {
    try {
      const parsed = JSON.parse(task.sourceContextJson) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  function createTaskFromGraphNode(projectId: string, nodeId: string, intent?: string, projectName?: string): ZeusTaskRecord | null {
    const node = readCurrentGraphNodeById(nodeId, projectName);
    if (!node) {
      return null;
    }
    const relatedEdges = readCurrentGraphEdgesByNodeId(node.id, projectName);
    const lineStart = typeof node.metadata.lineStart === 'number' ? node.metadata.lineStart : undefined;
    const lineEnd = typeof node.metadata.lineEnd === 'number' ? node.metadata.lineEnd : undefined;
    // 节点任务创建只依赖真实图谱节点和边；调用方负责校验 projectId 是否来自有效项目。
    const task = tasks.create({
      projectId,
      managementStatus: resolveTaskManagementStatusConfigForProject(projectId).roles.defaultStatusId,
      title: `分析图谱节点：${node.name}`,
      taskType: 'requirement',
      description: [intent ?? '基于代码图谱分析该节点的实现风险、影响范围和建议验证范围。', `节点类型：${node.nodeType}`, `来源：${node.sourceRef}${lineStart ? `:${lineStart}${lineEnd ? `-${lineEnd}` : ''}` : ''}`].join('\n'),
      createdFrom: 'graph_node',
      sourceContext: {
        graphNode: node,
        relatedEdges,
        suggestedVerificationScope: Array.from(new Set([node.sourceRef, ...relatedEdges.map((edge) => edge.sourceRef)])),
        riskHints: ['检查节点上下游影响', '执行相关静态检查与构建', '如节点涉及运行时入口需验证本地服务 API'],
      },
    });
    recordTaskEvent({
      taskId: task.id,
      eventType: 'task.created.from_graph_node',
      title: '任务从图谱节点创建',
      payload: { nodeId: node.id, sourceRef: node.sourceRef },
    });
    return task;
  }

  function findProjectByRef(projectRef: string): ZeusProjectRecord | undefined {
    return projects.getById(projectRef) ?? projects.list().find((project) => project.name === projectRef || project.localPath === projectRef);
  }

  function moveTaskTowardRunning(taskId: string, eventType = 'telegram.status.changed'): ZeusTaskRecord {
    let current = tasks.getById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    if (current.status === 'completed') return current;
    if (current.status === 'running') return current;
    const path: Partial<Record<TaskStatus, TaskStatus[]>> = {
      draft: ['ready', 'running'],
      ready: ['running'],
      paused: ['running'],
      waiting_confirmation: ['running'],
      failed: ['ready', 'running'],
      cancelled: ['ready', 'running'],
    };
    for (const target of path[current.status] ?? []) {
      const nextStatus = getNextTaskStatus(current.status, target);
      current = tasks.updateStatus(current.id, nextStatus);
      recordTaskEvent({
        taskId: current.id,
        eventType,
        title: taskStatusEventTitle(nextStatus),
        payload: { to: nextStatus },
      });
    }
    return current;
  }

  function moveTaskToWaitingConfirmation(taskId: string): ZeusTaskRecord {
    let current = moveTaskTowardRunning(taskId);
    if (current.status !== 'running') return current;
    const nextStatus = getNextTaskStatus(current.status, 'waiting_confirmation');
    current = tasks.updateStatus(current.id, nextStatus);
    recordTaskEvent({
      taskId: current.id,
      eventType: 'telegram.status.changed',
      title: taskStatusEventTitle(nextStatus),
      payload: { to: nextStatus },
    });
    return current;
  }

  function moveTaskToCancelled(taskId: string): ZeusTaskRecord {
    let current = tasks.getById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    if (current.status === 'completed' || current.status === 'cancelled') return current;
    if (current.status === 'failed') {
      current = tasks.updateStatus(current.id, getNextTaskStatus(current.status, 'ready'));
    }
    const nextStatus = getNextTaskStatus(current.status, 'cancelled');
    current = tasks.updateStatus(current.id, nextStatus);
    recordTaskEvent({
      taskId: current.id,
      eventType: 'telegram.status.changed',
      title: taskStatusEventTitle(nextStatus),
      payload: { to: nextStatus },
    });
    return current;
  }

  function parseTelegramLogsArgs(args: string[]): {
    taskId: string | undefined;
    full: boolean;
  } {
    const full = args.includes('--full');
    return { taskId: args.find((arg) => arg !== '--full'), full };
  }

  function collectTaskRuntimeLogRows(task: ZeusTaskRecord): Array<{ session: AiRuntimeSession; log: AiRuntimeLogEntry }> {
    const memorySessions = aiRuntimeManager.listSessions().filter((session) => session.taskId === task.id);
    const persistedSessions = runtimeSessions.list({ taskId: task.id, archived: false }).map(toAiRuntimeSession);
    const sessionsById = new Map<string, AiRuntimeSession>();
    for (const session of [...persistedSessions, ...memorySessions]) sessionsById.set(session.id, session);
    return [...sessionsById.values()].flatMap((session) => {
      const memoryLogs = aiRuntimeManager.getLogs(session.id);
      const logs = memoryLogs.length > 0 ? memoryLogs : runtimeSessions.listLogs(session.id).map(toAiRuntimeLogEntry);
      return logs.map((log) => ({ session, log }));
    });
  }

  async function formatTelegramTaskLogs(taskId: string | undefined, options: { full?: boolean } = {}): Promise<string> {
    if (!taskId) return '请提供任务 ID：/logs <taskId>';
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const rows = collectTaskRuntimeLogRows(task);
    if (rows.length === 0) return `Runtime 日志为空：任务 ${task.title} (${task.id}) 暂无真实会话日志。`;
    if (options.full) {
      const project = projects.getById(task.projectId);
      if (!project) return `未找到任务所属项目：${task.projectId}`;
      return createTelegramRuntimeConfirmation(
        'logs_full',
        project,
        task,
        async () => {
          const currentTask = tasks.getById(task.id);
          if (!currentTask) return `未找到任务：${task.id}`;
          const currentRows = collectTaskRuntimeLogRows(currentTask);
          if (currentRows.length === 0) return `Runtime 日志为空：任务 ${currentTask.title} (${currentTask.id}) 暂无真实会话日志。`;
          return exportTelegramTaskLogs(currentTask, currentRows);
        },
        { affectsTaskStatus: false },
      );
    }
    const latestRows = rows.slice(-8);
    return [`Runtime 日志：${task.title} (${task.id})`, ...latestRows.map(({ session, log }) => `- ${session.command} · ${log.stream}: ${redactSensitiveText(log.text.trim()).text}`)].join('\n');
  }

  function exportTelegramTaskLogs(task: ZeusTaskRecord, rows: Array<{ session: AiRuntimeSession; log: AiRuntimeLogEntry }>): string {
    const exportDirectory = join(localLogDirectory, 'telegram-exports', sanitizeRuntimeFileName(task.id));
    mkdirSync(exportDirectory, { recursive: true });
    const exportFileName = `${now().toISOString().replace(/[:.]/gu, '-')}-${sanitizeRuntimeFileName(task.id)}.log`;
    const exportPath = join(exportDirectory, exportFileName);
    const sessionIds = new Set(rows.map(({ session }) => session.id));
    // Telegram 只返回文件路径与统计，完整正文落本地脱敏文件，避免长日志和密钥片段进入聊天窗口。
    const body = rows
      .map(({ session, log }) => {
        const text = redactSensitiveText(log.text.trimEnd()).text;
        return `${log.createdAt} ${session.id} ${session.command} [${log.stream}] ${text}`;
      })
      .join('\n');
    writeFileSync(exportPath, `${body}\n`, 'utf8');
    return [`Runtime 日志已导出：${task.title} (${task.id})`, `会话 ${sessionIds.size} 个 · 日志 ${rows.length} 行`, `文件：${exportPath}`].join('\n');
  }

  async function formatTelegramGraphAsk(projectRef: string | undefined, question: string): Promise<string> {
    if (!projectRef || !question.trim()) return '请提供项目和问题：/ask <project> <question>';
    const project = findProjectByRef(projectRef);
    if (!project) return `未找到项目：${projectRef}`;
    const answer = await answerProjectGraphQuestion(project, question.trim());
    const sourceLines = [
      ...answer.sources.nodes.slice(0, 5).map((node) => {
        const lineStart = typeof node.metadata.lineStart === 'number' ? `:${node.metadata.lineStart}` : '';
        return `- 节点 ${node.name} (${node.nodeType}) 来源 ${node.sourceRef}${lineStart}`;
      }),
      ...answer.sources.edges.slice(0, 3).map((edge) => `- 关系 ${edge.edgeType} 来源 ${edge.sourceRef} confidence ${edge.confidence}`),
    ];
    return [
      `图谱问答回答：${project.name}`,
      `问题：${answer.question}`,
      `回答：${answer.answer}`,
      answer.sessionId ? `Runtime 会话：${answer.sessionId}` : 'Runtime 会话：未启动，来源不足以判断。',
      '来源：',
      ...(sourceLines.length > 0 ? sourceLines : ['- 未命中真实图谱节点或边']),
    ].join('\n');
  }

  async function answerProjectGraphQuestion(project: ZeusProjectRecord, question: string): Promise<GraphQuestionAnswer> {
    const { summary } = readCurrentGraphSummaryForProject(project);
    if (summary.nodeCount === 0) {
      return createInsufficientGraphAnswer(project.id, question, `不足以判断：项目 ${project.name} 尚未扫描出真实代码图谱。`);
    }
    const { result } = searchCurrentGraphNodesForProject(project, question, undefined, undefined, '0');
    if (result.nodes.length === 0 && result.edges.length === 0) {
      return createInsufficientGraphAnswer(project.id, question, '不足以判断：未命中真实图谱节点或边，请换用源码文件名、模块名、函数名或接口名提问。');
    }
    const nodes = result.nodes.slice(0, 5);
    const edges = result.edges.slice(0, 3);
    const projectConfig = readProjectConfig(project.id);
    const prompt = buildGraphQuestionPrompt(project, question, nodes, edges, projectConfig);
    const adapterId = runtimeSettings.defaultAdapterId;
    if (adapterId === 'codex') {
      const operation = await codexNativeCoordinator.startEphemeralConversation({
        projectId: project.id,
        projectLocalPath: project.localPath,
        title: `图谱问答：${question.slice(0, 48)}`,
        prompt,
        model: await resolveCodexModel(project),
        idempotencyKey: randomUUID(),
        clientUserMessageId: randomUUID(),
      });
      if (operation.status !== 'active' || !operation.providerTurnId) {
        throw Object.assign(new Error('Codex native graph provider dispatch failed.'), { code: 'ZEUS_CODEX_EPHEMERAL_DISPATCH_FAILED' });
      }
      const completed = await codexNativeCoordinator.waitForTurnResult({
        conversationId: operation.conversationId,
        providerTurnId: operation.providerTurnId,
        timeoutMs: runtimeSettings.executionTimeoutSeconds * 1_000,
      });
      return {
        projectId: project.id,
        question,
        answer: completed.answer || '不足以判断：Codex native turn 未返回可用回答。',
        sessionId: null,
        conversationId: operation.conversationId,
        sources: { nodes, edges },
      };
    }
    if (!isNonCodexAiCliAdapterId(adapterId)) {
      throw new Error(`AI CLI adapter not found: ${String(adapterId)}`);
    }
    const invocation = createNonCodexAiCliAdapterInvocation(adapterId, prompt, {
      // 图谱问答同样属于项目内 AI Runtime，优先使用项目默认模型。
      model: projectConfig.defaultModel ?? runtimeSettings.adapterModels[adapterId],
      defaultArgs: runtimeSettings.adapterDefaultArgs[adapterId] ?? [],
      commandPath: runtimeSettings.adapterCliPaths[adapterId],
    });
    const session = await aiRuntimeManager.startSession({
      projectId: project.id,
      command: invocation.command,
      args: invocation.args,
      cwd: project.localPath,
      env: buildRuntimeProcessEnv(),
    });
    await waitForRuntimeSessionExit(session.id);
    await db.save();
    const answer = collectRuntimeAnswer(session.id);
    return {
      projectId: project.id,
      question,
      answer: answer || '不足以判断：AI Runtime 未返回可用回答。',
      sessionId: session.id,
      sources: { nodes, edges },
    };
  }

  function createInsufficientGraphAnswer(projectId: string, question: string, answer: string): GraphQuestionAnswer {
    return {
      projectId,
      question,
      answer,
      sessionId: null,
      sources: { nodes: [], edges: [] },
    };
  }

  /** 将图谱问答沉淀为可追溯对话；只保存真实问题、真实回答和真实来源 ID，不生成任何伪上下文。 */
  function persistGraphQuestionConversation(answer: GraphQuestionAnswer): void {
    if (answer.conversationId) {
      const nativeConversation = conversations.getById(answer.conversationId);
      if (nativeConversation?.transportKind === 'codex_native') {
        conversations.updateRuntimeState(nativeConversation.id, { status: 'closed', summary: answer.answer.slice(0, 240) });
        return;
      }
    }
    const createdAt = new Date().toISOString();
    const conversation = conversations.create({
      projectId: answer.projectId,
      sessionId: answer.sessionId ?? undefined,
      title: `图谱问答：${answer.question.slice(0, 48)}`,
      summary: answer.answer.slice(0, 240),
      status: 'closed',
    });
    conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: answer.question,
      source: 'graph_question',
      metadata: { projectId: answer.projectId },
      createdAt,
    });
    conversations.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: answer.answer,
      source: 'graph_answer',
      metadata: {
        projectId: answer.projectId,
        sessionId: answer.sessionId,
        sourceNodeIds: answer.sources.nodes.map((node) => node.id),
        sourceEdgeIds: answer.sources.edges.map((edge) => edge.id),
      },
      createdAt: new Date(Date.parse(createdAt) + 1).toISOString(),
    });
  }

  function buildGraphQuestionPrompt(project: ZeusProjectRecord, question: string, nodes: GraphViewSnapshot['nodes'], edges: GraphViewSnapshot['edges'], projectConfig = readProjectConfig(project.id)): string {
    const sourceContext = {
      graphQuestion: question,
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.nodeType,
        name: node.name,
        qualifiedName: node.qualifiedName,
        sourceRef: node.sourceRef,
        lineStart: node.metadata.lineStart,
        lineEnd: node.metadata.lineEnd,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        type: edge.edgeType,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        sourceRef: edge.sourceRef,
        confidence: edge.confidence,
      })),
    };
    return [
      '你是 Zeus 本地优先 AI 研发工作台中的 AI Runtime。',
      '只能基于真实仓库、真实日志、真实错误输出行动；信息不足时先说明缺口，不要编造结果。',
      `项目：${project.name}`,
      `项目路径：${project.localPath}`,
      `任务：图谱问答：${question}`,
      '任务描述：基于 Zeus 真实代码图谱回答用户问题。回答必须带来源；如果来源不足，明确说“不足以判断”。',
      `来源上下文：${JSON.stringify(sourceContext)}`,
      `项目默认工作模式：${projectConfig.defaultWorkMode}`,
      ...(projectConfig.defaultTaskPrompt.trim() ? [`项目默认任务提示词：${projectConfig.defaultTaskPrompt.trim()}`] : []),
      '执行要求：请仅基于 sourceContext 中的真实图谱节点和边回答，保留文件路径、行号、节点或关系来源；不要编造未出现的模块、接口、表或任务记录。',
    ].join('\n');
  }

  async function waitForRuntimeSessionExit(sessionId: string): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      const session = aiRuntimeManager.getSession(sessionId);
      if (session && session.status !== 'running') return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function collectRuntimeAnswer(sessionId: string): string {
    return aiRuntimeManager
      .getLogs(sessionId)
      .filter((log) => log.stream === 'stdout')
      .map((log) => log.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  async function formatTelegramTaskDiff(taskId: string | undefined): Promise<string> {
    if (!taskId) return '请提供任务 ID：/diff <taskId>';
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const project = projects.getById(task.projectId);
    if (!project) return `未找到任务所属项目：${task.projectId}`;
    return createTelegramRuntimeConfirmation('diff', project, task, async () => formatTelegramTaskDiffAfterConfirmation(task.id), { affectsTaskStatus: false });
  }

  async function formatTelegramTaskDiffAfterConfirmation(taskId: string): Promise<string> {
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const project = projects.getById(task.projectId);
    if (!project) return `未找到任务所属项目：${task.projectId}`;
    const gitScope = resolveProjectGitScope(project);
    if ('limitation' in gitScope) return `Git Diff：${gitScope.limitation}`;
    const diff = await readGitDiff(gitScope.path);
    if (!diff.isRepository) return `Git Diff：${project.localPath} 不是 Git 仓库。`;
    if (diff.files.length === 0) return `Git Diff：${project.localPath} 当前没有未提交变更。`;
    const diffText = redactSensitiveText(diff.diffText).text;
    if (diff.diffText.length > 1200 || diff.files.length > 12) {
      return [
        `Git Diff 摘要：${project.name} (${project.localPath})`,
        `变更文件 ${diff.files.length} 个，diffTextLength=${diff.diffText.length}`,
        ...diff.files.slice(0, 12).map((file) => `- ${file}`),
        diff.files.length > 12 ? `…另有 ${diff.files.length - 12} 个文件未在 Telegram 中展开` : '完整 diff 请在 Zeus 桌面端或补丁导出中查看。',
      ].join('\n');
    }
    return [`Git Diff：${project.name} (${project.localPath})`, `变更文件 ${diff.files.length} 个：`, ...diff.files.slice(0, 12).map((file) => `- ${file}`), diffText ? diffText.slice(0, 1200) : '无 diff 文本。'].join('\n');
  }

  async function ensureTelegramPollingService(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }): Promise<TelegramPollingService | undefined> {
    const token = await readTelegramToken();
    const allowedUserIds = telegramSecuritySettings.allowedUserIds;
    const state = getTelegramConfigurationState(token, allowedUserIds);
    if (!state.enabled || !token) {
      reply.code(400).send({ error: 'ZEUS_TELEGRAM_UNCONFIGURED', message: state.reason });
      return undefined;
    }
    telegramMessageSender ??= createTelegramBotMessageClient({ token });
    const sender = telegramMessageSender;
    telegramPollingService ??= createTelegramPollingService({
      client: createTelegramLongPollingClient({ token }),
      allowedUserIds,
      reply: (chatId, text, replyOptions) => {
        if (replyOptions?.editMessageId && sender.editMessage) {
          return sender.editMessage(chatId, replyOptions.editMessageId, text, { inlineKeyboard: replyOptions.inlineKeyboard });
        }
        return sender.sendMessage(chatId, text, { inlineKeyboard: replyOptions?.inlineKeyboard });
      },
      handleCommand: (command, update) => handleTelegramBusinessCommand(command, update),
    });
    return telegramPollingService;
  }

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
      markRuntimeSessionConversationsInactive(session);
    }
    if (session.status === 'exited' || session.status === 'failed') {
      publishRuntimeSessionEnded(session);
    }
    writeRuntimeSessionMetadata(session);
    commandCenter.handleRuntimeSessionChange(session);
    void notifyTelegramCommandRunSession(session);
    runtimePersistenceWrites.push(db.save());
    if (session.status !== 'running') {
      void codexNativeCoordinator.capacityChanged().catch((error) => {
        publishRealtimeEvent('conversation.native.queue_dispatch_failed', {
          source: 'legacy_runtime_capacity_changed',
          sessionId: session.id,
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      });
    }
  }

  function persistRuntimeLog(log: AiRuntimeLogEntry): void {
    runtimeSessions.appendLog(log);
    mirrorRuntimeLogToBoundTaskConversations(log);
    const rawChunkPath = writeRuntimeSessionLogFiles(log);
    terminalEvents.setRawChunkPathByRuntimeLogId(log.id, rawChunkPath);
    publishRuntimeLogEvent(log);
    commandCenter.handleRuntimeLog(log);
    void notifyTelegramCommandRunLog(log);
    void notifyTelegramRuntimeProgressSummary(log);
    runtimePersistenceWrites.push(db.save());
  }

  function runtimeSessionDataDirectory(sessionId: string): string {
    return join(runtimeSessionDirectory, sessionId);
  }

  function ensureRuntimeSessionDataDirectory(sessionId: string): string {
    const sessionDirectory = runtimeSessionDataDirectory(sessionId);
    mkdirSync(join(sessionDirectory, 'chunks'), { recursive: true });
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

  function writeRuntimeSessionLogFiles(log: AiRuntimeLogEntry): string {
    const sessionDirectory = ensureRuntimeSessionDataDirectory(log.sessionId);
    const chunkPath = join(sessionDirectory, 'chunks', `${sanitizeRuntimeFileName(log.id)}.log`);
    // terminal.raw.log 保存运行时输出主体；当前日志在 AI Runtime 层已完成敏感字段脱敏。
    appendFileSync(join(sessionDirectory, 'terminal.raw.log'), `${log.text}${log.text.endsWith('\n') ? '' : '\n'}`, 'utf8');
    appendFileSync(join(sessionDirectory, 'terminal.normalized.log'), `${log.createdAt} [${log.stream}] ${log.text}${log.text.endsWith('\n') ? '' : '\n'}`, 'utf8');
    writeFileSync(chunkPath, log.text, 'utf8');
    return chunkPath;
  }

  return server;
}

function sanitizeRuntimeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, '_');
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

function matchesRuntimeSessionFilter(session: AiRuntimeSession, query: ListRuntimeSessionsQuery): boolean {
  if (query.projectId && session.projectId !== query.projectId) return false;
  if (query.taskId && session.taskId !== query.taskId) return false;
  if (query.archived === 'true' || query.favoriteOnly === 'true') return false;
  if (query.query) {
    const haystack = `${session.command}
${session.cwd}
${session.summary ?? ''}`.toLowerCase();
    if (!haystack.includes(query.query.toLowerCase())) return false;
  }
  return true;
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

function toAiRuntimeSessionOrUndefined(record: ZeusRuntimeSessionRecord | undefined): AiRuntimeSession | undefined {
  return record ? toAiRuntimeSession(record) : undefined;
}

function toAiRuntimeSession(record: ZeusRuntimeSessionRecord): AiRuntimeSession {
  return {
    id: record.id,
    projectId: record.projectId,
    taskId: record.taskId ?? undefined,
    command: record.command,
    args: parseRuntimeArgs(record.argsJson),
    cwd: record.cwd,
    status: record.status,
    pid: record.pid ?? undefined,
    exitCode: record.exitCode,
    summary: record.summary,
    favorite: record.favorite,
    archived: record.archived,
    deletedAt: record.deletedAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? undefined,
  };
}

function processPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processKillPid(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function normalizeRuntimeLogStream(stream: RuntimeLogStream | undefined): RuntimeLogStream | undefined {
  return stream === 'system' || stream === 'stdout' || stream === 'stderr' ? stream : undefined;
}

function parseBoundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function filterRuntimeMemoryLogs(
  logs: AiRuntimeLogEntry[],
  query: ListRuntimeLogsQuery,
): {
  items: AiRuntimeLogEntry[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  stream: RuntimeLogStream | null;
} {
  const rawQuery = query.query?.trim() || null;
  const normalizedQuery = rawQuery?.toLowerCase() || null;
  const stream = normalizeRuntimeLogStream(query.stream) ?? null;
  const limit = parseBoundedInteger(query.limit, 200, 1, 1_000);
  const offset = parseBoundedInteger(query.offset, 0, 0, 100_000);
  const filtered = logs.filter((log) => {
    if (stream && log.stream !== stream) return false;
    if (!normalizedQuery) return true;
    return `${log.stream} ${log.text} ${log.createdAt}`.toLowerCase().includes(normalizedQuery);
  });
  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
    query: rawQuery,
    stream,
  };
}

function toAiRuntimeLogEntry(record: ZeusRuntimeLogRecord): AiRuntimeLogEntry {
  return {
    id: record.id,
    sessionId: record.sessionId,
    stream: record.stream,
    text: record.text,
    createdAt: record.createdAt,
  };
}

function parseRuntimeArgs(argsJson: string): string[] {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function toRuntimeStatus(runtimeSettings: RuntimeSettingsSnapshot): Promise<{
  name: string;
  command: string;
  available: boolean;
  reason: string;
}> {
  const adapters = listAiCliAdapters().filter((adapter) => adapter.id !== 'generic');
  const candidates = await Promise.all(adapters.map((adapter) => checkAiCliAdapter(adapter.id, { commandPath: runtimeSettings.adapterCliPaths[adapter.id] })));
  const available = candidates.find((candidate) => candidate.available);
  if (available) return available;
  return {
    name: 'Codex CLI',
    command: 'codex',
    available: false,
    reason: '未检测到可用 AI CLI，请在设置中配置 Codex、Claude Code、Gemini 或通用 CLI。',
  };
}

function readGraphEdgeDetail(
  db: {
    get: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T | undefined;
  },
  edgeId: string,
): GraphEdgeDetail | undefined {
  const edge = db.get<{
    id: string;
    edge_type: string;
    source_node_id: string;
    target_node_id: string;
    source_ref: string;
    confidence: number;
    metadata_json: string;
  }>(
    `SELECT id, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json
     FROM project_edges WHERE id = ? LIMIT 1`,
    [edgeId],
  );
  if (!edge) return undefined;
  const sourceNode = readGraphNodeById(db, edge.source_node_id);
  const targetNode = readGraphNodeById(db, edge.target_node_id);
  if (!sourceNode || !targetNode) return undefined;
  return {
    id: edge.id,
    edgeType: edge.edge_type,
    sourceNodeId: edge.source_node_id,
    targetNodeId: edge.target_node_id,
    sourceRef: edge.source_ref,
    confidence: edge.confidence,
    metadata: parseJsonObject(edge.metadata_json),
    sourceNode,
    targetNode,
  };
}

function readGraphNeighborhood(
  db: {
    get: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T | undefined;
    select: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T[];
  },
  nodeId: string,
  depth: number,
  projectName?: string,
): GraphNeighborhood | undefined {
  const centerNode = readGraphNodeById(db, nodeId, projectName);
  if (!centerNode) return undefined;
  type GraphNeighborhoodEdgeRow = {
    id: string;
    edge_type: string;
    source_node_id: string;
    target_node_id: string;
    source_ref: string;
    confidence: number;
    metadata_json: string;
  };
  const normalizedDepth = depth === 2 ? 2 : 1;
  const maxNodes = normalizedDepth === 1 ? 40 : 80;
  const nodeIds = new Set<string>([nodeId]);
  const edgeRowsById = new Map<string, GraphNeighborhoodEdgeRow>();
  let frontier = [nodeId];

  for (let hop = 0; hop < normalizedDepth && frontier.length > 0; hop += 1) {
    const placeholders = frontier.map(() => '?').join(', ');
    const rows = db.select<GraphNeighborhoodEdgeRow>(
      `SELECT id, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json
       FROM project_edges
       WHERE (? IS NULL OR project_name = ?)
         AND (source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders}))
       ORDER BY rowid ASC
       LIMIT 240`,
      [projectName ?? null, projectName ?? null, ...frontier, ...frontier],
    );
    const nextFrontier: string[] = [];
    for (const edge of rows) {
      edgeRowsById.set(edge.id, edge);
      for (const candidateId of [edge.source_node_id, edge.target_node_id]) {
        if (nodeIds.has(candidateId) || nodeIds.size >= maxNodes) continue;
        nodeIds.add(candidateId);
        nextFrontier.push(candidateId);
      }
    }
    frontier = nextFrontier;
  }

  const edges = Array.from(edgeRowsById.values())
    .filter((edge) => nodeIds.has(edge.source_node_id) && nodeIds.has(edge.target_node_id))
    .map((edge) => ({
      id: edge.id,
      edgeType: edge.edge_type,
      sourceNodeId: edge.source_node_id,
      targetNodeId: edge.target_node_id,
      sourceRef: edge.source_ref,
      confidence: edge.confidence,
      metadata: parseJsonObject(edge.metadata_json),
    }));
  const nodes = Array.from(nodeIds)
    .map((id) => readGraphNodeById(db, id, projectName))
    .filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
  return { centerNode, depth: normalizedDepth, nodes, edges };
}

function normalizeGraphSearchFilters(
  rawQuery: string,
  nodeType?: string,
  edgeType?: string,
  rawMinConfidence?: string,
): {
  query: string;
  nodeType: string | null;
  edgeType: string | null;
  minConfidence: number;
} {
  return {
    query: rawQuery.trim(),
    nodeType: nodeType?.trim() || null,
    edgeType: edgeType?.trim() || null,
    minConfidence: Number.isFinite(Number(rawMinConfidence)) ? Number(rawMinConfidence) : 0,
  };
}

function emptyGraphSearchResult(rawQuery: string, nodeType?: string, edgeType?: string, rawMinConfidence?: string): GraphSearchResult {
  const filters = normalizeGraphSearchFilters(rawQuery, nodeType, edgeType, rawMinConfidence);
  return {
    query: filters.query,
    nodeType: filters.nodeType,
    edgeType: filters.edgeType,
    minConfidence: filters.minConfidence,
    nodes: [],
    edges: [],
  };
}

function searchGraphNodesInMemory(graph: ProjectGraph, rawQuery: string, nodeType?: string, edgeType?: string, rawMinConfidence?: string): GraphSearchResult {
  const filters = normalizeGraphSearchFilters(rawQuery, nodeType, edgeType, rawMinConfidence);
  const normalizedQuery = filters.query.toLowerCase();
  const includesQuery = (value: string): boolean => normalizedQuery.length === 0 || value.toLowerCase().includes(normalizedQuery);
  const nodes = graph.nodes
    .filter((node) => includesQuery(node.name) || includesQuery(node.qualifiedName) || includesQuery(node.sourceRef))
    .filter((node) => !filters.nodeType || node.nodeType === filters.nodeType)
    .sort((left, right) => {
      const leftSourceHit = includesQuery(left.sourceRef) ? 0 : 1;
      const rightSourceHit = includesQuery(right.sourceRef) ? 0 : 1;
      if (leftSourceHit !== rightSourceHit) return leftSourceHit - rightSourceHit;
      const leftQualifiedHit = includesQuery(left.qualifiedName) ? 0 : 1;
      const rightQualifiedHit = includesQuery(right.qualifiedName) ? 0 : 1;
      if (leftQualifiedHit !== rightQualifiedHit) return leftQualifiedHit - rightQualifiedHit;
      return left.sourceRef.localeCompare(right.sourceRef) || left.name.localeCompare(right.name);
    })
    .slice(0, 50)
    .map((node) => ({
      id: node.id,
      nodeType: node.nodeType,
      name: node.name,
      qualifiedName: node.qualifiedName,
      sourceRef: node.sourceRef,
      symbolId: node.symbolId,
      metadata: node.metadata,
    }));
  const edges = graph.edges
    .filter((edge) => !filters.edgeType || edge.edgeType === filters.edgeType)
    .filter((edge) => edge.confidence >= filters.minConfidence)
    .filter((edge) => filters.query.length === 0 || edge.sourceRef.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => right.confidence - left.confidence || left.sourceRef.localeCompare(right.sourceRef))
    .slice(0, 50)
    .map((edge) => ({
      id: edge.id,
      edgeType: edge.edgeType,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      sourceRef: edge.sourceRef,
      confidence: edge.confidence,
      metadata: edge.metadata ?? {},
    }));
  return {
    query: filters.query,
    nodeType: filters.nodeType,
    edgeType: filters.edgeType,
    minConfidence: filters.minConfidence,
    nodes,
    edges,
  };
}

function searchGraphNodes(db: { select: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T[] }, rawQuery: string, nodeType?: string, edgeType?: string, rawMinConfidence?: string, projectName?: string): GraphSearchResult {
  const { query, nodeType: normalizedType, edgeType: normalizedEdgeType, minConfidence } = normalizeGraphSearchFilters(rawQuery, nodeType, edgeType, rawMinConfidence);
  const rows = db.select<{
    id: string;
    node_type: string;
    name: string;
    qualified_name: string;
    source_ref: string;
    symbol_id: string;
    metadata_json: string;
  }>(
    `SELECT id, node_type, name, qualified_name, source_ref, symbol_id, metadata_json
     FROM project_nodes
     WHERE (? IS NULL OR project_name = ?)
       AND (? = '' OR lower(name) LIKE lower(?) OR lower(qualified_name) LIKE lower(?) OR lower(source_ref) LIKE lower(?))
       AND (? IS NULL OR node_type = ?)
     ORDER BY
       CASE
         WHEN lower(source_ref) LIKE lower(?) THEN 0
         WHEN lower(qualified_name) LIKE lower(?) THEN 1
         ELSE 2
       END ASC,
       source_ref ASC,
       name ASC
     LIMIT 50`,
    [projectName ?? null, projectName ?? null, query, `%${query}%`, `%${query}%`, `%${query}%`, normalizedType, normalizedType, `%${query}%`, `%${query}%`],
  );
  const edges = db
    .select<{
      id: string;
      edge_type: string;
      source_node_id: string;
      target_node_id: string;
      source_ref: string;
      confidence: number;
      metadata_json: string;
    }>(
      `SELECT id, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json
     FROM project_edges
     WHERE (? IS NULL OR project_name = ?)
       AND (? IS NULL OR edge_type = ?)
       AND confidence >= ?
       AND (? = '' OR lower(source_ref) LIKE lower(?))
     ORDER BY confidence DESC, source_ref ASC
     LIMIT 50`,
      [projectName ?? null, projectName ?? null, normalizedEdgeType, normalizedEdgeType, minConfidence, query, `%${query}%`],
    )
    .map((edge) => ({
      id: edge.id,
      edgeType: edge.edge_type,
      sourceNodeId: edge.source_node_id,
      targetNodeId: edge.target_node_id,
      sourceRef: edge.source_ref,
      confidence: edge.confidence,
      metadata: parseJsonObject(edge.metadata_json),
    }));
  return {
    query,
    nodeType: normalizedType,
    edgeType: normalizedEdgeType,
    minConfidence,
    nodes: rows.map((node) => ({
      id: node.id,
      nodeType: node.node_type,
      name: node.name,
      qualifiedName: node.qualified_name,
      sourceRef: node.source_ref,
      symbolId: node.symbol_id,
      metadata: parseJsonObject(node.metadata_json),
    })),
    edges,
  };
}

function writeTaskCompletionToGraphNode(
  db: {
    get: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T | undefined;
    execute: (sql: string, params?: import('sql.js').SqlValue[]) => void;
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

function readGraphNodeById(
  db: {
    get: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T | undefined;
  },
  nodeId: string,
  projectName?: string,
): GraphViewSnapshot['nodes'][number] | undefined {
  const node = db.get<{
    id: string;
    node_type: string;
    name: string;
    qualified_name: string;
    source_ref: string;
    symbol_id: string;
    metadata_json: string;
  }>(
    `SELECT id, node_type, name, qualified_name, source_ref, symbol_id, metadata_json
     FROM project_nodes WHERE id = ? AND (? IS NULL OR project_name = ?) LIMIT 1`,
    [nodeId, projectName ?? null, projectName ?? null],
  );
  if (!node) return undefined;
  return {
    id: node.id,
    nodeType: node.node_type,
    name: node.name,
    qualifiedName: node.qualified_name,
    sourceRef: node.source_ref,
    symbolId: node.symbol_id,
    metadata: parseJsonObject(node.metadata_json),
  };
}

function readGraphNodeIdsBySourceRef(db: { select: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T[] }, sourceRef: string): string[] {
  return db
    .select<{ id: string }>(
      `SELECT id
     FROM project_nodes
     WHERE source_ref = ?
     ORDER BY node_type ASC, qualified_name ASC, id ASC`,
      [sourceRef],
    )
    .map((node) => node.id);
}

function readGraphEdgesByNodeId(db: { select: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T[] }, nodeId: string, projectName?: string): GraphViewSnapshot['edges'] {
  return db
    .select<{
      id: string;
      edge_type: string;
      source_node_id: string;
      target_node_id: string;
      source_ref: string;
      confidence: number;
      metadata_json: string;
    }>(
      `SELECT id, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json
     FROM project_edges WHERE (? IS NULL OR project_name = ?) AND (source_node_id = ? OR target_node_id = ?) ORDER BY rowid ASC LIMIT 20`,
      [projectName ?? null, projectName ?? null, nodeId, nodeId],
    )
    .map((edge) => ({
      id: edge.id,
      edgeType: edge.edge_type,
      sourceNodeId: edge.source_node_id,
      targetNodeId: edge.target_node_id,
      sourceRef: edge.source_ref,
      confidence: edge.confidence,
      metadata: parseJsonObject(edge.metadata_json),
    }));
}

// 项目级图谱读取必须带 projectName 过滤，否则同 view_type 的第一条缓存会把 Zeus 图谱串到其他项目。
function readGraphView(
  db: {
    get: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T | undefined;
    select: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T[];
  },
  viewType: string,
  projectName?: string,
): GraphViewSnapshot | undefined {
  try {
    const view = db.get<{
      id: string;
      project_name: string;
      view_type: string;
      title: string;
      payload_json: string;
    }>(`SELECT id, project_name, view_type, title, payload_json FROM graph_views WHERE view_type = ? AND (? IS NULL OR project_name = ?) ORDER BY id ASC LIMIT 1`, [viewType, projectName ?? null, projectName ?? null]);
    if (!view) return undefined;
    const payload = parseGraphViewPayload(view.payload_json);
    if (payload.schemaVersion !== GRAPH_VIEW_SCHEMA_VERSION) return undefined;
    const nodes = db
      .select<{
        id: string;
        node_type: string;
        name: string;
        qualified_name: string;
        source_ref: string;
        symbol_id: string;
        metadata_json: string;
      }>(
        `SELECT id, node_type, name, qualified_name, source_ref, symbol_id, metadata_json
     FROM project_nodes WHERE project_name = ? ORDER BY rowid ASC`,
        [view.project_name],
      )
      .filter((node) => !payload.hasNodeFilter || payload.nodeIds.has(node.id))
      .map((node) => ({
        id: node.id,
        nodeType: node.node_type,
        name: node.name,
        qualifiedName: node.qualified_name,
        sourceRef: node.source_ref,
        symbolId: node.symbol_id,
        metadata: parseJsonObject(node.metadata_json),
      }));
    const edges = db
      .select<{
        id: string;
        edge_type: string;
        source_node_id: string;
        target_node_id: string;
        source_ref: string;
        confidence: number;
        metadata_json: string;
      }>(
        `SELECT id, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json
     FROM project_edges WHERE project_name = ? ORDER BY rowid ASC`,
        [view.project_name],
      )
      .filter((edge) => !payload.hasEdgeFilter || payload.edgeIds.has(edge.id))
      .map((edge) => ({
        id: edge.id,
        edgeType: edge.edge_type,
        sourceNodeId: edge.source_node_id,
        targetNodeId: edge.target_node_id,
        sourceRef: edge.source_ref,
        confidence: edge.confidence,
        metadata: parseJsonObject(edge.metadata_json),
      }));
    return {
      id: view.id,
      schemaVersion: payload.schemaVersion,
      projectName: view.project_name,
      title: view.title,
      viewType: view.view_type,
      layout: payload.layout,
      nodes,
      edges,
    };
  } catch {
    // 项目首次创建且尚未扫描时，图谱缓存表可能还不存在；此时返回空态让 API 给出可恢复 404，而不是把界面打成 500。
    return undefined;
  }
}

function graphNodeToSnapshot(node: ProjectGraph['nodes'][number]): GraphViewSnapshot['nodes'][number] {
  return {
    id: node.id,
    nodeType: node.nodeType,
    name: node.name,
    qualifiedName: node.qualifiedName,
    sourceRef: node.sourceRef,
    symbolId: node.symbolId,
    metadata: node.metadata,
  };
}

function graphEdgeToSnapshot(edge: ProjectGraph['edges'][number]): GraphViewSnapshot['edges'][number] {
  return {
    id: edge.id,
    edgeType: edge.edgeType,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    sourceRef: edge.sourceRef,
    confidence: edge.confidence,
    metadata: edge.metadata ?? {},
  };
}

function graphNodeSnapshotFromGraph(graph: ProjectGraph, nodeId: string): GraphViewSnapshot['nodes'][number] | undefined {
  const node = graph.nodes.find((item) => item.id === nodeId);
  return node ? graphNodeToSnapshot(node) : undefined;
}

function graphEdgesByNodeIdFromGraph(graph: ProjectGraph, nodeId: string, limit: number): GraphViewSnapshot['edges'] {
  return graph.edges
    .filter((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId)
    .slice(0, limit)
    .map(graphEdgeToSnapshot);
}

function graphEdgeDetailFromGraph(graph: ProjectGraph, edgeId: string): GraphEdgeDetail | undefined {
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!edge) return undefined;
  const sourceNode = graphNodeSnapshotFromGraph(graph, edge.sourceNodeId);
  const targetNode = graphNodeSnapshotFromGraph(graph, edge.targetNodeId);
  if (!sourceNode || !targetNode) return undefined;
  return { ...graphEdgeToSnapshot(edge), sourceNode, targetNode };
}

function graphNeighborhoodFromGraph(graph: ProjectGraph, nodeId: string, depth: number): GraphNeighborhood | undefined {
  const centerNode = graphNodeSnapshotFromGraph(graph, nodeId);
  if (!centerNode) return undefined;
  const normalizedDepth = depth === 2 ? 2 : 1;
  const maxNodes = normalizedDepth === 1 ? 40 : 80;
  const nodeIds = new Set<string>([nodeId]);
  const edgesById = new Map<string, GraphViewSnapshot['edges'][number]>();
  let frontier = [nodeId];

  for (let hop = 0; hop < normalizedDepth && frontier.length > 0; hop += 1) {
    const frontierIds = new Set(frontier);
    const nextFrontier: string[] = [];
    for (const edge of graph.edges) {
      if (!frontierIds.has(edge.sourceNodeId) && !frontierIds.has(edge.targetNodeId)) continue;
      const snapshotEdge = graphEdgeToSnapshot(edge);
      edgesById.set(snapshotEdge.id, snapshotEdge);
      for (const candidateId of [edge.sourceNodeId, edge.targetNodeId]) {
        if (nodeIds.has(candidateId) || nodeIds.size >= maxNodes) continue;
        nodeIds.add(candidateId);
        nextFrontier.push(candidateId);
      }
    }
    frontier = nextFrontier;
  }

  const edges = Array.from(edgesById.values()).filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId));
  const nodes = Array.from(nodeIds)
    .map((id) => graphNodeSnapshotFromGraph(graph, id))
    .filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
  return { centerNode, depth: normalizedDepth, nodes, edges };
}

function graphViewSnapshotFromGraph(graph: ProjectGraph, viewType: string): GraphViewSnapshot | undefined {
  const view = graph.views.find((item) => item.viewType === viewType);
  if (!view) return undefined;
  const nodeIds = new Set(view.nodeIds);
  const edgeIds = new Set(view.edgeIds);
  return {
    id: view.id,
    schemaVersion: view.schemaVersion,
    projectName: graph.projectName,
    title: view.title,
    viewType: view.viewType,
    layout: view.layout,
    nodes: graph.nodes
      .filter((node) => nodeIds.has(node.id))
      .map((node) => ({
        id: node.id,
        nodeType: node.nodeType,
        name: node.name,
        qualifiedName: node.qualifiedName,
        sourceRef: node.sourceRef,
        symbolId: node.symbolId,
        metadata: node.metadata,
      })),
    edges: graph.edges
      .filter((edge) => edgeIds.has(edge.id))
      .map((edge) => ({
        id: edge.id,
        edgeType: edge.edgeType,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        sourceRef: edge.sourceRef,
        confidence: edge.confidence,
        metadata: edge.metadata ?? {},
      })),
  };
}

function parseGraphViewPayload(payloadJson: string): {
  schemaVersion: number | undefined;
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  hasNodeFilter: boolean;
  hasEdgeFilter: boolean;
  layout?: GraphViewSnapshot['layout'];
} {
  try {
    const payload = JSON.parse(payloadJson) as {
      schemaVersion?: number;
      nodeIds?: string[];
      edgeIds?: string[];
      layout?: unknown;
    };
    return {
      schemaVersion: payload.schemaVersion,
      nodeIds: new Set(payload.nodeIds ?? []),
      edgeIds: new Set(payload.edgeIds ?? []),
      hasNodeFilter: Array.isArray(payload.nodeIds),
      hasEdgeFilter: Array.isArray(payload.edgeIds),
      layout: parseGraphViewLayout(payload.layout),
    };
  } catch {
    return {
      schemaVersion: undefined,
      nodeIds: new Set(),
      edgeIds: new Set(),
      hasNodeFilter: false,
      hasEdgeFilter: false,
    };
  }
}

function parseGraphViewLayout(value: unknown): GraphViewSnapshot['layout'] | undefined {
  const layout = value as Partial<NonNullable<GraphViewSnapshot['layout']>>;
  if (!layout || typeof layout !== 'object' || typeof layout.algorithm !== 'string' || typeof layout.width !== 'number' || typeof layout.height !== 'number' || !Array.isArray(layout.positions)) return undefined;
  const positions = layout.positions.filter((position): position is { nodeId: string; x: number; y: number } => {
    const item = position as Partial<{
      nodeId: string;
      x: number;
      y: number;
    }>;
    return typeof item.nodeId === 'string' && typeof item.x === 'number' && typeof item.y === 'number';
  });
  return {
    algorithm: layout.algorithm,
    width: layout.width,
    height: layout.height,
    positions,
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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

function readGraphSummary(db: { countRows: (tableName: string) => number }): {
  nodeCount: number;
  edgeCount: number;
  viewCount: number;
} {
  return {
    nodeCount: safeCount(db, 'project_nodes'),
    edgeCount: safeCount(db, 'project_edges'),
    viewCount: safeCount(db, 'graph_views'),
  };
}

function readGraphSummaryByProject(
  db: {
    get: <T>(sql: string, params?: import('sql.js').SqlValue[]) => T | undefined;
  },
  projectName: string,
): { nodeCount: number; edgeCount: number; viewCount: number } {
  try {
    const counts = db.get<{
      node_count: number;
      edge_count: number;
      view_count: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM project_nodes WHERE project_name = ?) AS node_count,
         (SELECT COUNT(*) FROM project_edges WHERE project_name = ?) AS edge_count,
         (SELECT COUNT(*) FROM graph_views WHERE project_name = ?) AS view_count`,
      [projectName, projectName, projectName],
    );
    return {
      nodeCount: counts?.node_count ?? 0,
      edgeCount: counts?.edge_count ?? 0,
      viewCount: counts?.view_count ?? 0,
    };
  } catch {
    // 扫描失败前可能尚未创建图谱缓存表；状态接口仍应返回项目状态，而不是二次失败。
    return { nodeCount: 0, edgeCount: 0, viewCount: 0 };
  }
}

function safeCount(db: { countRows: (tableName: string) => number }, tableName: string): number {
  try {
    return db.countRows(tableName);
  } catch {
    return 0;
  }
}

function resolveCodeMapScanRoot(projectRoot: string, settings: CodeMapSettingsSnapshot): string {
  if (settings.defaultScanScope !== 'src') return projectRoot;
  const srcRoot = join(projectRoot, 'src');
  // src 范围只在真实 src 目录存在时生效；不存在时回退项目根，避免扫描失败或制造虚假目录。
  return existsSync(srcRoot) ? srcRoot : projectRoot;
}

function hasDatabaseUriPassword(value: string | null | undefined): boolean {
  const text = value?.trim();
  if (!text || !/^(?:postgresql?|mysql|mariadb):/iu.test(text)) return false;
  try {
    return Boolean(new URL(text).password);
  } catch {
    // URI 格式不完整时也按 user:password@ 形态拦截，避免敏感信息落入本地设置表。
    return /:\/\/[^:@\s]+:[^@\s]+@/u.test(text);
  }
}

function resolveImportedSchemaFiles(projectRoot: string, config?: ProjectConfigSnapshot): Array<{ absolutePath: string; relativePath: string }> {
  if (!config?.database.schemaPaths.length) return [];
  const projectRootPath = resolve(projectRoot);
  const files: Array<{ absolutePath: string; relativePath: string }> = [];
  const seen = new Set<string>();
  for (const schemaPath of config.database.schemaPaths) {
    const absolutePath = resolve(projectRootPath, schemaPath);
    const relativePath = relative(projectRootPath, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || relativePath === '..' || relativePath.startsWith('/')) continue;
    if (seen.has(absolutePath)) continue;
    if (!existsSync(absolutePath)) continue;
    const info = statSync(absolutePath);
    if (!info.isFile()) continue;
    // DDL 导入只接受真实文件；缺失、目录或不在项目内的路径不会生成任何 schema 节点。
    files.push({ absolutePath, relativePath });
    seen.add(absolutePath);
  }
  return files;
}

function resolveConfiguredSqliteDatabase(projectRoot: string, config?: ProjectConfigSnapshot): { absolutePath: string; relativePath: string } | null {
  const connectionName = config?.database.connectionName?.trim();
  const explicitExternalConnection = connectionName?.match(/^(postgresql?|mysql|mariadb):/iu);
  if (explicitExternalConnection?.[1]) {
    const dialect = explicitExternalConnection[1].toLowerCase() === 'postgresql' ? 'postgres' : explicitExternalConnection[1].toLowerCase();
    const displayName = dialect === 'postgres' ? 'Postgres' : dialect === 'mariadb' ? 'MariaDB' : 'MySQL';
    // 外部数据库驱动尚未纳入依赖清单；明确失败比静默跳过 schema 更符合“不伪造真实来源”的设计书约束。
    throw new Error(`${displayName} database introspection driver is not installed; connection scheme ${explicitExternalConnection[1].toLowerCase()} is waiting for approved dependency setup`);
  }
  const match = connectionName?.match(/^sqlite:(.+)$/iu);
  if (!match?.[1]) return null;
  const rawRelativePath = match[1].trim().replace(/\\/gu, '/');
  if (!rawRelativePath || rawRelativePath.startsWith('/') || rawRelativePath.includes('\0')) {
    throw new Error('SQLite database connection must use a project-relative path');
  }
  const projectRootPath = resolve(projectRoot);
  const absolutePath = resolve(projectRootPath, rawRelativePath);
  const relativePath = relative(projectRootPath, absolutePath).replace(/\\/gu, '/');
  if (!relativePath || relativePath.startsWith('..') || relativePath === '..' || relativePath.startsWith('/')) {
    throw new Error(`SQLite database path is outside the project: ${rawRelativePath}`);
  }
  if (!/\.(?:sqlite|sqlite3|db)$/iu.test(relativePath)) {
    throw new Error(`SQLite database file must end with .sqlite, .sqlite3, or .db: ${relativePath}`);
  }
  if (!existsSync(absolutePath)) {
    throw new Error(`SQLite database file is not accessible: ${relativePath}`);
  }
  const info = statSync(absolutePath);
  if (!info.isFile()) {
    throw new Error(`SQLite database path is not a file: ${relativePath}`);
  }
  return { absolutePath, relativePath };
}

function applyCodeMapSettingsToGraph(graph: ProjectGraph, settings: CodeMapSettingsSnapshot): ProjectGraph {
  if (settings.tableRelationInference === 'foreign_key_and_name' || settings.tableRelationInference === 'name_only') {
    return graph;
  }
  const edges = graph.edges.filter((edge) => edge.edgeType !== 'references');
  const allowedEdgeIds = new Set(edges.map((edge) => edge.id));
  // 当前 references 边来自命名推断；关闭推断或只保留真实外键时，同步裁剪视图 edgeIds，避免展示被禁用的推断关系。
  const views = graph.views.map((view) => ({
    ...view,
    edgeIds: view.edgeIds.filter((edgeId) => allowedEdgeIds.has(edgeId)),
  }));
  return { ...graph, edges, views };
}

function exportLocalBusinessData(db: ZeusDatabase, exportedAt: string): LocalDataExportSnapshot {
  const projects = db
    .select<PortableProjectDbRow>(
      `SELECT id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at
     FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC`,
    )
    .map(mapPortableProjectRow);
  const projectIds = new Set(projects.map((project) => project.id));
  const tasks = db
    .select<PortableTaskDbRow>(
      `SELECT id,
                project_id,
                title,
                task_type,
                description,
                defect_current_state,
                defect_expected_outcome,
                defect_reproduction_steps,
                optimization_current_state,
                optimization_expected_outcome,
                management_status,
                status,
                tags_json,
                template_id,
                task_code,
                task_sequence,
                priority,
                created_from,
                source_context_json,
                created_at,
                updated_at
     FROM tasks WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC`,
    )
    .map(mapPortableTaskRow)
    .filter((task) => projectIds.has(task.projectId));
  const taskIds = new Set(tasks.map((task) => task.id));
  const taskEvents = db
    .select<PortableTaskEventDbRow>(
      `SELECT id, task_id, event_type, title, payload_json, created_at
     FROM task_events ORDER BY created_at ASC, id ASC`,
    )
    .map(mapPortableTaskEventRow)
    .filter((event) => taskIds.has(event.taskId));
  const taskTemplates = db
    .select<PortableTaskTemplateDbRow>(
      `SELECT id, name, description, category, prompt_template, default_options_json, project_id, built_in, created_at, updated_at
     FROM task_templates WHERE deleted_at IS NULL AND built_in = 0 ORDER BY created_at ASC, id ASC`,
    )
    .map(mapPortableTaskTemplateRow)
    .filter((template) => !template.projectId || projectIds.has(template.projectId));
  const commandDefinitions = new CommandDefinitionRepository(db);
  const portableCommands = [...commandDefinitions.listGlobal(), ...projects.flatMap((project) => commandDefinitions.listProject(project.id))];
  return {
    app: 'Zeus',
    schemaVersion: 2,
    exportedAt,
    redaction: { secretsRedacted: true },
    data: { projects, tasks, taskEvents, taskTemplates, commandDefinitions: portableCommands },
  };
}

function importLocalBusinessData(db: ZeusDatabase, snapshot: LocalDataExportSnapshot): ImportLocalDataResult['importedCounts'] {
  const projects = Array.isArray(snapshot.data.projects) ? snapshot.data.projects.filter(isPortableProjectRecord) : [];
  const projectIds = new Set(projects.map((project) => project.id));
  const taskTemplates = Array.isArray(snapshot.data.taskTemplates)
    ? snapshot.data.taskTemplates.filter((template) => isPortableTaskTemplateRecord(template) && !template.builtIn && (!template.projectId || projectIds.has(template.projectId)))
    : [];
  const tasks = Array.isArray(snapshot.data.tasks) ? snapshot.data.tasks.filter((task) => isPortableTaskRecord(task) && projectIds.has(task.projectId)) : [];
  const taskIds = new Set(tasks.map((task) => task.id));
  const taskEvents = Array.isArray(snapshot.data.taskEvents) ? snapshot.data.taskEvents.filter((event) => isPortableTaskEventRecord(event) && taskIds.has(event.taskId)) : [];

  for (const project of projects) {
    // 导入保留原 ID，保证任务、模板和事件仍能关联到真实项目；不写入任何密钥或运行产物。
    db.execute(
      `INSERT OR REPLACE INTO projects (id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at, archived, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      [project.id, project.name, project.slug, project.localPath, project.description, project.note ?? null, project.defaultTemplateId, project.scanStatus, project.createdAt, project.updatedAt],
    );
  }
  for (const template of taskTemplates) {
    db.execute(
      `INSERT OR REPLACE INTO task_templates (id, name, description, category, prompt_template, default_options_json, built_in, sort_order, project_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL)`,
      [template.id, template.name, template.description, template.category, template.promptTemplate, template.defaultOptionsJson, template.projectId, template.createdAt, template.updatedAt],
    );
  }
  for (const task of tasks) {
    db.execute(
      `INSERT OR REPLACE INTO tasks (id, project_id, title, task_type, description, defect_current_state, defect_expected_outcome, defect_reproduction_steps,
        optimization_current_state, optimization_expected_outcome, management_status, status, tags_json, template_id, task_code, task_sequence, priority, created_from, source_context_json, archived, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      [
        task.id,
        task.projectId,
        task.title,
        isTaskType(task.taskType) ? task.taskType : 'requirement',
        task.description,
        task.defectCurrentState ?? '',
        task.defectExpectedOutcome ?? '',
        task.defectReproductionSteps ?? '',
        task.optimizationCurrentState ?? '',
        task.optimizationExpectedOutcome ?? '',
        isTaskManagementStatus(task.managementStatus) ? task.managementStatus : 'todo',
        task.status,
        JSON.stringify(task.tags),
        task.templateId,
        task.taskCode ?? null,
        task.taskSequence ?? null,
        task.priority ?? 'normal',
        task.createdFrom,
        task.sourceContextJson,
        task.createdAt,
        task.updatedAt,
      ],
    );
  }
  for (const event of taskEvents) {
    db.execute(
      `INSERT OR REPLACE INTO task_events (id, task_id, event_type, title, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [event.id, event.taskId, event.eventType, event.title, event.payloadJson, event.createdAt],
    );
  }
  const commandRepository = new CommandDefinitionRepository(db);
  const commandDefinitions =
    snapshot.schemaVersion >= 2 && Array.isArray(snapshot.data.commandDefinitions)
      ? snapshot.data.commandDefinitions.filter((command) => isPortableCommandDefinition(command) && (command.scope === 'global' || (command.projectId !== null && projectIds.has(command.projectId))))
      : [];
  let importedCommandDefinitions = 0;
  for (const command of commandDefinitions) {
    const conflicts = commandRepository.findTokenConflicts({
      scope: command.scope,
      projectId: command.projectId,
      tokens: [command.name, ...command.aliases],
      excludeCommandId: command.id,
    });
    if (conflicts.length > 0) continue;
    db.execute(`DELETE FROM command_aliases WHERE command_id = ?`, [command.id]);
    db.execute(`DELETE FROM command_definitions WHERE id = ?`, [command.id]);
    commandRepository.create({
      ...command,
      id: command.id,
      scope: command.scope,
      projectId: command.projectId,
      enabled: false,
      telegramEnabled: false,
      revision: Math.max(1, command.revision),
      createdAt: command.createdAt,
    });
    importedCommandDefinitions += 1;
  }
  return {
    projects: projects.length,
    tasks: tasks.length,
    taskEvents: taskEvents.length,
    taskTemplates: taskTemplates.length,
    commandDefinitions: importedCommandDefinitions,
  };
}

function isPortableCommandDefinition(value: unknown): value is CommandDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Partial<CommandDefinition>;
  if (
    typeof command.id !== 'string' ||
    (command.scope !== 'global' && command.scope !== 'project') ||
    (command.projectId !== null && typeof command.projectId !== 'string') ||
    typeof command.name !== 'string' ||
    !Array.isArray(command.aliases) ||
    !command.aliases.every((alias) => typeof alias === 'string') ||
    typeof command.title !== 'string' ||
    typeof command.description !== 'string' ||
    typeof command.command !== 'string' ||
    !Array.isArray(command.parameters) ||
    typeof command.timeoutSeconds !== 'number' ||
    typeof command.revision !== 'number' ||
    typeof command.createdAt !== 'string' ||
    typeof command.updatedAt !== 'string'
  ) {
    return false;
  }
  return validateCommandDefinitionInput(command as CommandDefinition).length === 0;
}

function findInvalidPortableProjectPaths(snapshot: LocalDataExportSnapshot): string[] {
  const projects = Array.isArray(snapshot.data.projects) ? snapshot.data.projects.filter(isPortableProjectRecord) : [];
  const invalidPaths: string[] = [];
  for (const project of projects) {
    const localPath = project.localPath.trim();
    if (!localPath || !localPath.startsWith('/') || localPath.includes('\0')) {
      invalidPaths.push(localPath || project.id);
      continue;
    }
    try {
      const info = statSync(localPath);
      if (!info.isDirectory()) invalidPaths.push(localPath);
    } catch {
      invalidPaths.push(localPath);
    }
  }
  return invalidPaths;
}

interface PortableProjectDbRow {
  id: string;
  name: string;
  slug: string;
  local_path: string;
  description: string | null;
  note: string | null;
  default_template_id: string | null;
  scan_status: string;
  created_at: string;
  updated_at: string;
}

interface PortableTaskDbRow {
  id: string;
  project_id: string;
  title: string;
  task_type: string;
  description: string;
  defect_current_state: string;
  defect_expected_outcome: string;
  defect_reproduction_steps: string;
  optimization_current_state: string;
  optimization_expected_outcome: string;
  management_status: string;
  status: string;
  tags_json: string;
  template_id: string | null;
  task_code: string | null;
  task_sequence: number | null;
  priority: string | null;
  created_from: string;
  source_context_json: string;
  created_at: string;
  updated_at: string;
}

interface PortableTaskEventDbRow {
  id: string;
  task_id: string;
  event_type: string;
  title: string;
  payload_json: string;
  created_at: string;
}

interface PortableTaskTemplateDbRow {
  id: string;
  name: string;
  description: string;
  category: string;
  prompt_template: string;
  default_options_json: string;
  project_id: string | null;
  built_in: number;
  created_at: string;
  updated_at: string;
}

function mapPortableProjectRow(row: PortableProjectDbRow): PortableProjectRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    localPath: row.local_path,
    description: row.description,
    note: row.note,
    defaultTemplateId: row.default_template_id,
    scanStatus: row.scan_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPortableTaskRow(row: PortableTaskDbRow): PortableTaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    taskType: isTaskType(row.task_type) ? row.task_type : 'requirement',
    description: row.description,
    defectCurrentState: row.defect_current_state,
    defectExpectedOutcome: row.defect_expected_outcome,
    defectReproductionSteps: row.defect_reproduction_steps,
    optimizationCurrentState: row.optimization_current_state,
    optimizationExpectedOutcome: row.optimization_expected_outcome,
    managementStatus: isTaskManagementStatus(row.management_status) ? row.management_status : 'todo',
    status: row.status,
    tags: parseStringArrayJson(row.tags_json),
    templateId: row.template_id,
    taskCode: row.task_code ?? undefined,
    taskSequence: row.task_sequence,
    priority: row.priority ?? 'normal',
    createdFrom: row.created_from,
    sourceContextJson: row.source_context_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPortableTaskEventRow(row: PortableTaskEventDbRow): PortableTaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    eventType: row.event_type,
    title: row.title,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function mapPortableTaskTemplateRow(row: PortableTaskTemplateDbRow): PortableTaskTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    promptTemplate: row.prompt_template,
    defaultOptionsJson: row.default_options_json,
    projectId: row.project_id,
    builtIn: row.built_in === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStringArrayJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function isPortableProjectRecord(value: unknown): value is PortableProjectRecord {
  const record = value as Partial<PortableProjectRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.slug === 'string' &&
    typeof record.localPath === 'string' &&
    typeof record.scanStatus === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function isPortableTaskRecord(value: unknown): value is PortableTaskRecord {
  const record = value as Partial<PortableTaskRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.projectId === 'string' &&
    typeof record.title === 'string' &&
    typeof record.description === 'string' &&
    typeof record.status === 'string' &&
    Array.isArray(record.tags) &&
    typeof record.createdFrom === 'string' &&
    typeof record.sourceContextJson === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function isPortableTaskEventRecord(value: unknown): value is PortableTaskEventRecord {
  const record = value as Partial<PortableTaskEventRecord>;
  return typeof record.id === 'string' && typeof record.taskId === 'string' && typeof record.eventType === 'string' && typeof record.title === 'string' && typeof record.payloadJson === 'string' && typeof record.createdAt === 'string';
}

function isPortableTaskTemplateRecord(value: unknown): value is PortableTaskTemplateRecord {
  const record = value as Partial<PortableTaskTemplateRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.description === 'string' &&
    typeof record.category === 'string' &&
    typeof record.promptTemplate === 'string' &&
    typeof record.defaultOptionsJson === 'string' &&
    typeof record.builtIn === 'boolean' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
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
  reply.header('Access-Control-Allow-Headers', 'authorization,content-type');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
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

function isGenericRuntimeAdapterCommand(command: string): boolean {
  return resolveRegisteredRuntimeAdapter(command)?.id === 'generic';
}

function isHighRiskGitOperation(operation: string): operation is HighRiskGitOperation {
  // Git 写操作只接受设计书列出的高风险白名单，避免 API 被扩展成任意 git 子命令入口。
  return ['commit', 'stash', 'apply_stash', 'rollback', 'branch', 'switch_branch', 'pull', 'push'].includes(operation);
}

/** 判断 Runtime cwd 是否仍位于项目根目录内；相等也允许，避免本地 API 变成项目外 shell 入口。 */
function isPathInsideProjectRoot(candidatePath: string, projectRoot: string): boolean {
  const resolvedCandidate = resolve(candidatePath);
  const resolvedRoot = resolve(projectRoot);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

function detectGenericShellOutsideProjectPath(command: string, args: string[], projectRoot: string): { commandText: string; rejectedPath: string } | null {
  if (!isGenericRuntimeAdapterCommand(command)) return null;
  const commandText = extractGenericShellCommandText(args);
  if (!commandText) return null;
  const tokens = tokenizeShellCommand(commandText);
  const redirectedPathRisk = findShellOutputRedirectOutsideProjectPath(tokens, projectRoot);
  if (redirectedPathRisk) return { commandText, rejectedPath: redirectedPathRisk };
  const writeCommandIndex = findShellWriteCommandIndex(tokens);
  if (writeCommandIndex < 0) return null;
  for (const token of tokens.slice(writeCommandIndex + 1)) {
    if (!token.startsWith('/') || token === '/') continue;
    if (!isPathInsideProjectRoot(token, projectRoot)) return { commandText, rejectedPath: token };
  }
  return null;
}

function detectGenericShellSensitivePath(command: string, args: string[]): { commandText: string; rejectedPath: string } | null {
  if (!isGenericRuntimeAdapterCommand(command)) return null;
  const commandText = extractGenericShellCommandText(args);
  if (!commandText) return null;
  const tokens = tokenizeShellCommand(commandText);
  for (const token of tokens) {
    if (isSensitiveLocalPathToken(token)) return { commandText, rejectedPath: token };
  }
  return null;
}

function detectGenericShellSecretFile(command: string, args: string[]): { commandText: string; rejectedPath: string } | null {
  if (!isGenericRuntimeAdapterCommand(command)) return null;
  const commandText = extractGenericShellCommandText(args);
  if (!commandText) return null;
  const tokens = tokenizeShellCommand(commandText);
  for (const token of tokens) {
    if (isLikelySecretFileToken(token)) return { commandText, rejectedPath: token };
  }
  return null;
}

function isLikelySecretFileToken(token: string): boolean {
  const cleaned = token.replace(/\\+/gu, '/').split(/[?#]/u)[0] ?? token;
  const basename = (cleaned.split('/').pop() ?? cleaned).toLowerCase();
  if (!basename || basename === '.' || basename === '..') return false;
  const looksLikePath = cleaned.includes('/') || basename.startsWith('.') || /\.[a-z0-9]+$/iu.test(basename);
  if (!looksLikePath) return false;
  const exactNames = new Set(['.env', '.env.local', '.env.production', '.env.development', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'credentials.json', 'service-account.json', 'service_account.json', 'kubeconfig']);
  if (exactNames.has(basename)) return true;
  return /\.(pem|key|p12|pfx|crt|cer)$/u.test(basename) || /(^|[-_.])(secret|secrets|token|apikey|api-key|private-key)([-_.]|$)/u.test(basename);
}

function isSensitiveLocalPathToken(token: string): boolean {
  const normalized = token.replace(/\\+/gu, '/');
  const lower = normalized.toLowerCase();
  const sensitivePrefixes = ['/etc', '/private/etc', '~/.ssh', '~/.aws', '~/.gnupg', '~/.gpg', '~/.config/gcloud', '~/library/keychains', '~/library/application support/com.apple.tcc'];
  return sensitivePrefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

function extractGenericShellCommandText(args: string[]): string | null {
  const shellCommandFlagIndex = args.findIndex((arg) => arg === '-c' || arg === '-lc' || arg === '-cl');
  if (shellCommandFlagIndex < 0) return null;
  return args[shellCommandFlagIndex + 1]?.trim() || null;
}

function findShellWriteCommandIndex(tokens: string[]): number {
  const writeCommands = new Set(['cp', 'mv', 'rm', 'touch', 'mkdir', 'rmdir', 'tee', 'chmod', 'chown', 'ln']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'sudo' || token === 'command' || token === 'env') continue;
    const commandName = token.split('/').pop() ?? token;
    return writeCommands.has(commandName) ? index : -1;
  }
  return -1;
}

function findShellOutputRedirectOutsideProjectPath(tokens: string[], projectRoot: string): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    // shell 重定向会绕过 cp/mv 等显式写命令，因此单独检查输出目标路径。
    const redirectTarget = extractShellOutputRedirectTarget(tokens, index);
    if (!redirectTarget || !redirectTarget.startsWith('/') || redirectTarget === '/') continue;
    if (!isPathInsideProjectRoot(redirectTarget, projectRoot)) return redirectTarget;
  }
  return null;
}

function extractShellOutputRedirectTarget(tokens: string[], index: number): string | null {
  const token = tokens[index];
  // 同时覆盖 `> /tmp/a`、`>> /tmp/a`、`2> /tmp/a`、`>/tmp/a`、`2>/tmp/a`、`&>/tmp/a`。
  if (/^(?:\d*>>?|&>)$/u.test(token)) return tokens[index + 1] ?? null;
  const inlineRedirect = token.match(/^(?:\d*>>?|&>)(.+)$/u);
  return inlineRedirect?.[1] ?? null;
}

function tokenizeShellCommand(commandText: string): string[] {
  const tokens = commandText.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? [];
  return tokens.map((token) => token.replace(/^['"]|['"]$/gu, ''));
}

function canConsumeGenericRuntimeConfirmation(confirmation: RuntimeOperationConfirmation, body: CreateRuntimeSessionBody, defaultCwd: string): boolean {
  if (confirmation.action !== 'start_generic_session' || confirmation.status !== 'confirmed') return false;
  const requestedArgs = body.args ?? [];
  const requestedCwd = body.cwd ?? defaultCwd;
  return (
    confirmation.session.projectId === body.projectId &&
    confirmation.session.taskId === body.taskId &&
    confirmation.session.command === body.command &&
    confirmation.session.cwd === requestedCwd &&
    stringArraysEqual(confirmation.session.args, requestedArgs)
  );
}

function buildRuntimeConfirmationSecurityContext(session: RuntimeOperationConfirmation['session']): RuntimeConfirmationSecurityContext {
  const previewParts = [session.command, ...session.args];
  const redactedPreview = redactSensitiveText(previewParts.join(' '));
  return {
    operationKind: 'shell_command',
    requiresConfirmation: true,
    riskLevel: 'high',
    projectId: session.projectId,
    taskId: session.taskId ?? null,
    cwd: session.cwd,
    commandPreview: redactedPreview.text,
    redacted: redactedPreview.redacted,
  };
}

/** 运行时确认响应只返回脱敏后的展示字段；服务端内存里仍保留原始 session 用于严格匹配和一次性消费。 */
function toRuntimeOperationConfirmationResponse(confirmation: RuntimeOperationConfirmation): RuntimeOperationConfirmation {
  return {
    ...confirmation,
    session: {
      ...confirmation.session,
      args: confirmation.session.args.map((arg) => redactSensitiveText(arg).text),
    },
  };
}

/** 对进入 API 响应和审计日志的敏感片段做保守脱敏，避免 token/API key 随安全确认记录外泄。 */
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

function parseConversationTurnFailure(errorJson: string | null): {
  category: 'authentication' | 'rate_limit' | 'network' | 'configuration' | 'permission' | 'unknown';
  code: string | null;
  message: string;
  providerStatus: string | null;
  additionalDetails: string[];
} | null {
  if (!errorJson) return null;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(errorJson);
    if (!isConversationFailureRecord(parsed)) return conversationFailureFromText(typeof parsed === 'string' ? parsed : errorJson);
    value = parsed;
  } catch {
    return conversationFailureFromText(errorJson);
  }
  const providerError = isConversationFailureRecord(value.providerError) ? value.providerError : null;
  const message = sanitizeConversationFailureText(
    typeof value.message === 'string' && value.message.trim() ? value.message : typeof providerError?.message === 'string' && providerError.message.trim() ? providerError.message : '智能体运行内核没有提供更具体的失败原因。',
  );
  const additionalDetails = [typeof providerError?.additionalDetails === 'string' ? providerError.additionalDetails : null, typeof providerError?.codexErrorInfo === 'string' ? `Codex: ${providerError.codexErrorInfo}` : null]
    .filter((detail): detail is string => Boolean(detail?.trim()))
    .map(sanitizeConversationFailureText)
    .filter((detail, index, details) => detail !== message && details.indexOf(detail) === index);
  return {
    category: classifyConversationFailure(message),
    code: typeof value.code === 'string' && value.code.trim() ? value.code.trim().slice(0, 120) : null,
    message,
    providerStatus: typeof value.providerStatus === 'string' && value.providerStatus.trim() ? value.providerStatus.trim().slice(0, 120) : null,
    additionalDetails,
  };
}

function conversationFailureFromText(value: string): {
  category: 'authentication' | 'rate_limit' | 'network' | 'configuration' | 'permission' | 'unknown';
  code: null;
  message: string;
  providerStatus: null;
  additionalDetails: [];
} {
  const message = sanitizeConversationFailureText(value) || '智能体运行内核没有提供更具体的失败原因。';
  return { category: classifyConversationFailure(message), code: null, message, providerStatus: null, additionalDetails: [] };
}

function isConversationFailureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 会话页只接收脱敏、无堆栈的失败正文；原始错误仍留在本机数据库用于诊断。 */
function sanitizeConversationFailureText(value: string): string {
  const withoutStack = value
    .split(/\r?\n/u)
    .filter((line) => !/^\s*at\s+/u.test(line))
    .join(' ');
  return redactSensitiveText(withoutStack)
    .text.replace(/file:\/\/\/Users\/[^\s,;:'"<>]+/giu, '[本机路径]')
    .replace(/\/Users\/[^\s,;:'"<>]+/gu, '[本机路径]')
    .replace(/[A-Za-z]:\\[^\s,;:'"<>]+/gu, '[本机路径]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_000);
}

function classifyConversationFailure(message: string): 'authentication' | 'rate_limit' | 'network' | 'configuration' | 'permission' | 'unknown' {
  if (/\b(?:401|403)\b|auth(?:entication|orization)?|unauthori[sz]ed|api[-_ ]?key|登录|鉴权/iu.test(message)) return 'authentication';
  if (/\b429\b|rate[-_ ]?limit|too many requests|quota|限流|配额/iu.test(message)) return 'rate_limit';
  if (/network|failed to fetch|connection|socket|timed?\s*out|timeout|dns|网络|连接|超时/iu.test(message)) return 'network';
  if (/permission denied|sandbox|not allowed|forbidden|权限|沙箱/iu.test(message)) return 'permission';
  if (/\b400\b|invalid|unsupported|unknown model|model not found|reasoning_effort|参数|模型.*(?:不存在|不支持)/iu.test(message)) return 'configuration';
  return 'unknown';
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clearPersistedGraphCache(db: { execute: (sql: string, params?: import('sql.js').SqlValue[]) => void }, projectName: string): void {
  ensureGraphCacheTables(db);
  // 图缓存禁用时只返回本次扫描结果，不保留旧 SQLite 视图，避免 UI 读取到过期图谱。
  db.execute('DELETE FROM code_symbols WHERE project_name = ?', [projectName]);
  db.execute('DELETE FROM project_nodes WHERE project_name = ?', [projectName]);
  db.execute('DELETE FROM project_edges WHERE project_name = ?', [projectName]);
  db.execute('DELETE FROM graph_views WHERE project_name = ?', [projectName]);
}

function clearAllPersistedGraphCaches(db: { execute: (sql: string, params?: import('sql.js').SqlValue[]) => void }): void {
  ensureGraphCacheTables(db);
  // 设置页缓存清理只删除可重建的代码索引/图谱/布局缓存，不触碰项目、任务、Runtime 日志或 Git 快照。
  db.execute('DELETE FROM code_symbols');
  db.execute('DELETE FROM project_nodes');
  db.execute('DELETE FROM project_edges');
  db.execute('DELETE FROM graph_views');
}

const RUNTIME_GRAPH_CACHE_NODE_BUDGET = 12000;
const RUNTIME_GRAPH_CACHE_EDGE_BUDGET = 24000;

function compactProjectGraphForRuntimeCache(graph: ProjectGraph): ProjectGraph {
  const retainedNodeIds = new Set<string>();
  const retainedEdgeIds = new Set<string>();

  for (const view of graph.views) {
    for (const nodeId of view.nodeIds) {
      if (retainedNodeIds.size >= RUNTIME_GRAPH_CACHE_NODE_BUDGET) break;
      retainedNodeIds.add(nodeId);
    }
  }
  for (const view of graph.views) {
    for (const edgeId of view.edgeIds) {
      if (retainedEdgeIds.size >= RUNTIME_GRAPH_CACHE_EDGE_BUDGET) break;
      retainedEdgeIds.add(edgeId);
    }
  }

  if (retainedNodeIds.size === 0) return graph;
  const nodes = graph.nodes.filter((node) => retainedNodeIds.has(node.id));
  const retainedConcreteNodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => retainedEdgeIds.has(edge.id))
    .filter((edge) => retainedConcreteNodeIds.has(edge.sourceNodeId) && retainedConcreteNodeIds.has(edge.targetNodeId))
    .slice(0, RUNTIME_GRAPH_CACHE_EDGE_BUDGET);
  const retainedConcreteEdgeIds = new Set(edges.map((edge) => edge.id));
  const views = graph.views.map((view) => ({
    ...view,
    nodeIds: view.nodeIds.filter((nodeId) => retainedConcreteNodeIds.has(nodeId)),
    edgeIds: view.edgeIds.filter((edgeId) => retainedConcreteEdgeIds.has(edgeId)),
    layout: {
      ...view.layout,
      // 大型项目只把各视图实际可打开的节点坐标留进运行时缓存，防止 sql.js 在 Electron 主进程里为不可见全量符号撑爆内存。
      positions: view.layout.positions.filter((position) => retainedConcreteNodeIds.has(position.nodeId)),
    },
  }));

  return {
    ...graph,
    nodes,
    edges,
    views,
  };
}

function ensureGraphCacheTables(db: { execute: (sql: string, params?: import('sql.js').SqlValue[]) => void }): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS code_symbols (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      symbol_type TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      language TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      source_hash TEXT NOT NULL
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS project_nodes (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      node_type TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS project_edges (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      confidence REAL NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  try {
    // 旧版本本地图缓存没有边 metadata；启动时补列，失败仅代表列已存在。
    db.execute(`ALTER TABLE project_edges ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // SQLite 不支持 ADD COLUMN IF NOT EXISTS，重复迁移时忽略即可。
  }
  db.execute(`
    CREATE TABLE IF NOT EXISTS graph_views (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      view_type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);
}

function persistScanAndGraph(db: { execute: (sql: string, params?: import('sql.js').SqlValue[]) => void }, scan: ProjectScanResult, graph: ProjectGraph): void {
  ensureGraphCacheTables(db);
  db.execute('DELETE FROM code_symbols WHERE project_name = ?', [scan.projectName]);
  db.execute('DELETE FROM project_nodes WHERE project_name = ?', [scan.projectName]);
  db.execute('DELETE FROM project_edges WHERE project_name = ?', [scan.projectName]);
  db.execute('DELETE FROM graph_views WHERE project_name = ?', [scan.projectName]);
  const retainedSymbolIds = new Set(graph.nodes.map((node) => node.symbolId));
  for (const symbol of scan.symbols.filter((item) => retainedSymbolIds.has(item.id))) {
    db.execute(
      `INSERT INTO code_symbols (id, project_name, symbol_type, name, qualified_name, file_path, line_start, line_end, language, metadata_json, source_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [symbol.id, scan.projectName, symbol.symbolType, symbol.name, symbol.qualifiedName, symbol.filePath, symbol.lineStart, symbol.lineEnd, symbol.language, JSON.stringify(symbol.metadata), symbol.sourceHash],
    );
  }
  for (const node of graph.nodes) {
    db.execute(
      `INSERT INTO project_nodes (id, project_name, node_type, name, qualified_name, source_ref, symbol_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [node.id, scan.projectName, node.nodeType, node.name, node.qualifiedName, node.sourceRef, node.symbolId, JSON.stringify(node.metadata)],
    );
  }
  for (const edge of graph.edges) {
    db.execute(
      `INSERT INTO project_edges (id, project_name, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [edge.id, scan.projectName, edge.edgeType, edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, edge.confidence, JSON.stringify(edge.metadata ?? {})],
    );
  }
  for (const view of graph.views) {
    db.execute(`INSERT INTO graph_views (id, project_name, view_type, title, payload_json) VALUES (?, ?, ?, ?, ?)`, [
      view.id,
      scan.projectName,
      view.viewType,
      view.title,
      JSON.stringify({
        schemaVersion: view.schemaVersion,
        nodeIds: view.nodeIds,
        edgeIds: view.edgeIds,
        layout: view.layout,
      }),
    ]);
  }
}
