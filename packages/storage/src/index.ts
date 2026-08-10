import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, statfs, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { nanoid } from 'nanoid';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic, type SqlValue as SqlJsValue } from 'sql.js';
import {
  type CodexUsageEstimate,
  type TokenUsageBreakdown,
  type ConversationResourceKind,
  type ConversationResourcePresentation,
  isTaskManagementStatus,
  isTaskPriority,
  isTaskType,
  type TaskAttachmentReference,
  type TaskManagementStatus,
  type TaskPriority,
  type TaskType,
  type TurnChangeFileType,
  type TurnChangeSetState,
} from '@zeus/shared';
import { migrateCommandCenterSchema } from './commands.js';

export * from './commands.js';

export { isTaskManagementStatus, isTaskPriority, isTaskType };
export type { TaskManagementStatus, TaskPriority, TaskType };
export type SqlValue = SQLInputValue;

export interface ZeusProjectRecord {
  id: string;
  name: string;
  slug: string;
  localPath: string;
  description: string | null;
  note: string | null;
  defaultTemplateId: string | null;
  scanStatus: 'not_scanned' | 'scanning' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

/** 项目容器内由用户确认纳入的真实 Git 仓库。 */
export interface ZeusProjectRepositoryRecord {
  id: string;
  projectId: string;
  name: string;
  relativePath: string;
  localPath: string;
  createdAt: string;
  updatedAt: string;
}

/** 项目容器内允许任务直接持久写入的非 Git 目录。 */
export interface ZeusProjectSharedPathRecord {
  id: string;
  projectId: string;
  relativePath: string;
  localPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTaskRecord {
  id: string;
  projectId: string;
  taskCode: string;
  taskSequence: number | null;
  parentTaskId: string | null;
  relatedTaskIds: string[];
  title: string;
  taskType: TaskType;
  description: string;
  defectCurrentState: string;
  defectExpectedOutcome: string;
  defectReproductionSteps: string;
  optimizationCurrentState: string;
  optimizationExpectedOutcome: string;
  managementStatus: TaskManagementStatus;
  status: 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';
  priority: string;
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowGitCommit: boolean;
  templateId: string | null;
  tags: string[];
  createdFrom: string;
  sourceContextJson: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskWorkspaceState = 'ready' | 'reclaimed' | 'merged' | 'discarded' | 'failed';
export type TaskEnvironmentState = 'ready' | 'reclaimed' | 'failed';

/** 一次任务推送的内部聚合记录，用于关联多个仓库工作区。 */
export interface ZeusTaskEnvironmentRecord {
  id: string;
  projectId: string;
  taskId: string;
  rootPath: string | null;
  state: TaskEnvironmentState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 任务工作区代表一次任务推送创建的独立任务开发线。
 * 会话结束不会删除工作区；只有任务完成、取消或显式清理才会回收 worktree。
 */
export interface ZeusTaskWorkspaceRecord {
  id: string;
  projectId: string;
  taskId: string;
  environmentId: string | null;
  repositoryId: string | null;
  repositoryName: string;
  repositoryRelativePath: string;
  repositoryPath: string;
  branchName: string;
  sourceBranch: string;
  sourceHeadSha: string;
  remoteName: string;
  remoteBranch: string;
  worktreePath: string | null;
  headSha: string | null;
  state: TaskWorkspaceState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskWorkspaceInput {
  id?: string;
  projectId: string;
  taskId: string;
  environmentId?: string;
  repositoryId?: string;
  repositoryName?: string;
  repositoryRelativePath?: string;
  repositoryPath?: string;
  branchName: string;
  sourceBranch: string;
  sourceHeadSha: string;
  remoteName?: string;
  remoteBranch?: string;
  worktreePath?: string;
  headSha?: string;
  state?: TaskWorkspaceState;
}

export interface UpdateTaskWorkspaceInput {
  worktreePath?: string | null;
  headSha?: string | null;
  state?: TaskWorkspaceState;
  remoteBranch?: string;
  lastError?: string | null;
}

export interface CreateProjectRepositoryInput {
  id?: string;
  projectId: string;
  name: string;
  relativePath: string;
  localPath: string;
}

export interface CreateProjectSharedPathInput {
  id?: string;
  projectId: string;
  relativePath: string;
  localPath: string;
}

export interface CreateTaskEnvironmentInput {
  id?: string;
  projectId: string;
  taskId: string;
  rootPath?: string;
  state?: TaskEnvironmentState;
}

export interface UpdateTaskEnvironmentInput {
  rootPath?: string | null;
  state?: TaskEnvironmentState;
  lastError?: string | null;
}

export type TaskIntegrationMode = 'merge' | 'squash';
export type TaskIntegrationState = 'preparing' | 'conflicted' | 'pending_local_sync' | 'merged' | 'failed';
export type TaskIntegrationLocalSyncStatus = 'synced' | 'pending';

export interface ZeusTaskIntegrationRecord {
  id: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  targetBranch: string;
  targetHeadSha: string;
  taskHeadSha: string | null;
  mode: TaskIntegrationMode;
  integrationPath: string | null;
  resultHeadSha: string | null;
  state: TaskIntegrationState;
  localSyncStatus: TaskIntegrationLocalSyncStatus | null;
  localHeadSha: string | null;
  localWorktreePath: string | null;
  conflictFiles: string[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskIntegrationInput {
  id?: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  targetBranch: string;
  targetHeadSha: string;
  taskHeadSha: string;
  mode: TaskIntegrationMode;
  integrationPath?: string;
  state?: TaskIntegrationState;
}

export interface UpdateTaskIntegrationInput {
  integrationPath?: string | null;
  resultHeadSha?: string | null;
  state?: TaskIntegrationState;
  localSyncStatus?: TaskIntegrationLocalSyncStatus | null;
  localHeadSha?: string | null;
  localWorktreePath?: string | null;
  conflictFiles?: string[];
  lastError?: string | null;
}

export interface ZeusTaskTemplateRecord {
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

export interface ZeusSettingRecord {
  key: string;
  valueJson: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  localPath: string;
  description?: string;
  note?: string;
}

export interface UpdateProjectInput {
  name?: string;
  localPath?: string;
  description?: string | null;
  note?: string | null;
}

export interface ProjectSearchOptions {
  query?: string;
}

export interface ProjectArchiveConfirmation {
  projectId: string;
  confirmationText: string;
  riskLevel: 'medium';
}

export interface CreateTaskInput {
  projectId: string;
  parentTaskId?: string | null;
  title: string;
  taskType: TaskType;
  description: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  createdFrom: string;
  sourceContext: Record<string, unknown>;
  managementStatus?: TaskManagementStatus;
  priority?: TaskPriority;
  templateId?: string;
  tags?: string[];
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
}

export interface UpdateTaskRelationshipsInput {
  expectedUpdatedAt: string;
  parentTaskId?: string | null;
  relatedTaskIds?: string[];
}

export interface DeleteTaskInput {
  childStrategy?: 'reparent' | 'delete_descendants' | 'make_roots';
  replacementParentTaskId?: string;
}

export interface DeleteTaskResult {
  task: ZeusTaskRecord;
  deletedTaskIds: string[];
  movedChildTaskIds: string[];
}

export interface CreateTaskTemplateInput {
  projectId?: string;
  name: string;
  description: string;
  promptTemplate: string;
  category?: string;
  defaultOptions?: Record<string, unknown>;
}

export interface CreateTaskFromTemplateInput {
  projectId: string;
  template: ZeusTaskTemplateRecord;
  managementStatus?: TaskManagementStatus;
  title?: string;
  variables?: Record<string, string>;
}

export interface TaskListOptions {
  query?: string;
  status?: ZeusTaskRecord['status'];
  managementStatus?: TaskManagementStatus;
  tag?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'taskType' | 'status' | 'managementStatus';
  sortDirection?: 'asc' | 'desc';
}

export interface UpdateTaskInput {
  title?: string;
  taskType?: TaskType;
  description?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
}

export type TaskEditableField =
  | 'title'
  | 'taskType'
  | 'description'
  | 'defectCurrentState'
  | 'defectExpectedOutcome'
  | 'defectReproductionSteps'
  | 'optimizationCurrentState'
  | 'optimizationExpectedOutcome'
  | 'priority'
  | 'tags'
  | 'attachments'
  | 'sourceContext'
  | 'allowCodeChanges'
  | 'allowTests'
  | 'allowGitCommit';

export interface UpdateTaskContentInput extends UpdateTaskInput {
  expectedUpdatedAt: string;
  priority?: TaskPriority;
  tags?: string[];
  attachments?: TaskAttachmentReference[];
  sourceContext?: Record<string, unknown>;
}

export interface UpdateTaskContentResult {
  task: ZeusTaskRecord;
  changedFields: TaskEditableField[];
  tagCountBefore: number;
  tagCountAfter: number;
  attachmentCountBefore: number;
  attachmentCountAfter: number;
  previousUpdatedAt: string;
}

export interface ZeusTaskEventRecord {
  id: string;
  taskId: string;
  eventType: string;
  title: string;
  payloadJson: string;
  createdAt: string;
}

export type RuntimeSessionStatus = 'running' | 'exited' | 'failed' | 'stopped' | 'orphan_detected' | 'lost';
export type RuntimeLogStream = 'system' | 'stdout' | 'stderr';
const DEFAULT_RUNTIME_LOG_PROJECTION_BYTES = 4 * 1024 * 1024;
const RUNTIME_LOG_PROJECTION_MARKER_TEXT = '[该轻量日志投影已按约 4 MB 预算省略部分内容；完整历史仍保存在 Runtime。]\n';

export interface ZeusRuntimeSessionRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  command: string;
  argsJson: string;
  cwd: string;
  status: RuntimeSessionStatus;
  pid: number | null;
  processIdentityToken: string | null;
  exitCode: number | null;
  summary: string | null;
  favorite: boolean;
  archived: boolean;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ZeusRuntimeLogRecord {
  id: string;
  sessionId: string;
  stream: RuntimeLogStream;
  text: string;
  createdAt: string;
}

export interface CreateRuntimeSessionInput {
  id: string;
  projectId: string;
  taskId?: string;
  command: string;
  args: string[];
  cwd: string;
  status: RuntimeSessionStatus;
  pid?: number;
  startedAt: string;
}

export interface UpdateRuntimeSessionStatusInput {
  status: RuntimeSessionStatus;
  exitCode?: number | null;
  endedAt?: string | null;
  pid?: number | null;
}

export interface AppendRuntimeLogInput {
  id: string;
  sessionId: string;
  stream: RuntimeLogStream;
  text: string;
  createdAt: string;
}

export interface AppendRuntimeLogResult {
  record: ZeusRuntimeLogRecord;
  inserted: boolean;
}

export interface RuntimeSessionListOptions {
  query?: string;
  projectId?: string;
  taskId?: string;
  archived?: boolean;
  favoriteOnly?: boolean;
}

export interface RuntimeLogListOptions {
  query?: string;
  stream?: RuntimeLogStream;
  limit?: number;
  offset?: number;
  /** 命令详情增量读取使用持久化终端序号，避免 OFFSET 在并发追加时漂移。 */
  afterSeq?: number;
  /** 终态首次打开时只读取展示预算内的末尾日志。 */
  tail?: boolean;
  /** 轻量投影的 UTF-8 正文字节预算；不传时保留完整分页语义。 */
  byteBudget?: number;
}

export interface RuntimeLogListResult {
  items: ZeusRuntimeLogRecord[];
  total: number;
  limit: number;
  offset: number;
  afterSeq: number;
  nextSeq: number;
  hasMore: boolean;
  truncated: boolean;
  query: string | null;
  stream: RuntimeLogStream | null;
}

export interface CreateTaskEventInput {
  taskId: string;
  eventType: string;
  title: string;
  payload: Record<string, unknown>;
}

export interface ZeusTerminalEventRecord {
  id: string;
  sessionId: string;
  taskId: string | null;
  seq: number;
  eventType: string;
  content: string;
  rawChunkPath: string | null;
  createdAt: string;
}

export interface AppendTerminalEventInput {
  sessionId: string;
  taskId?: string;
  seq: number;
  eventType: string;
  content: string;
  rawChunkPath?: string;
  createdAt: string;
}

export interface TerminalEventListOptions {
  limit?: number;
  offset?: number;
}

export interface TerminalEventListResult {
  sessionId: string;
  items: ZeusTerminalEventRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface ZeusConversationRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  workspaceId: string | null;
  environmentId: string | null;
  sessionId: string | null;
  title: string;
  summary: string | null;
  status: string;
  stage: ConversationStage;
  stageUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  transportKind: ConversationTransportKind;
  providerId: string | null;
  providerThreadId: string | null;
  providerThreadPath: string | null;
  providerModel: string | null;
  providerState: ConversationProviderState;
  providerProtocolVersion: string | null;
  providerBinaryVersion: string | null;
  legacySourceConversationId: string | null;
  providerSettingsJson: string;
  providerTokenUsageJson: string;
  permissionMode: ConversationPermissionMode;
  collaborationMode: ConversationCollaborationMode;
  nextTurnSettingsJson: string;
  completionUnread: boolean;
  agentKind: ConversationAgentKind | null;
  agentTransport: ConversationAgentTransport | null;
  modelSourceId: string | null;
  modelId: string | null;
  nativeSessionId: string | null;
  nativeSessionPath: string | null;
  capabilitySnapshotId: string | null;
}

export type ConversationTransportKind = 'legacy_cli' | 'codex_native';
export type ConversationStage = 'created' | 'connecting' | 'queued' | 'running' | 'waiting_user' | 'waiting_approval' | 'completed' | 'failed' | 'paused' | 'ready' | 'archived';
export type ConversationAgentKind = 'codex' | 'pi' | 'claude';
export type ConversationAgentTransport = 'app_server' | 'rpc' | 'sdk';
export type ConversationProviderState = 'unbound' | 'binding' | 'ready' | 'active' | 'waiting' | 'paused' | 'archived' | 'closed' | 'failed';
export type ConversationPermissionMode = 'read-only' | 'auto' | 'full-access';
export type ConversationCollaborationMode = 'default' | 'plan';

export interface ConversationNextTurnSettings {
  model: string;
  effort?: string;
  serviceTier?: string | null;
  permissionMode: ConversationPermissionMode;
  collaborationMode: ConversationCollaborationMode;
}

export interface ZeusConversationMessageRecord {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadataJson: string;
  createdAt: string;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerItemId: string | null;
  clientMessageId: string | null;
}

export interface ZeusConversationWithMessagesRecord extends ZeusConversationRecord {
  messages: ZeusConversationMessageRecord[];
}

export type CodexLegacyImportStatus = 'prepared' | 'waiting' | 'completed' | 'failed';

export interface ZeusCodexLegacyImportRecord {
  id: string;
  providerImportId: string | null;
  sourceConversationId: string;
  targetConversationId: string | null;
  snapshotPath: string;
  snapshotSha256: string;
  status: CodexLegacyImportStatus;
  targetThreadId: string | null;
  failureStage: string | null;
  failureMessage: string | null;
  providerBinaryVersion: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CreateCodexLegacyImportRunInput {
  sourceConversationId: string;
  snapshotPath: string;
  snapshotSha256: string;
  providerBinaryVersion: string;
}

export interface ConversationListOptions {
  query?: string;
  limit?: number;
  offset?: number;
  archived?: boolean;
}

export interface ConversationRecordListOptions {
  archived?: boolean;
}

export interface ConversationListResult {
  items: ZeusConversationWithMessagesRecord[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  archived: boolean;
}

export interface CreateConversationInput {
  id?: string;
  projectId: string;
  taskId?: string;
  workspaceId?: string;
  environmentId?: string;
  sessionId?: string;
  title: string;
  summary?: string;
  status?: string;
  transportKind?: ConversationTransportKind;
  providerId?: string;
  providerThreadId?: string;
  providerThreadPath?: string;
  providerModel?: string;
  providerState?: ConversationProviderState;
  providerProtocolVersion?: string;
  providerBinaryVersion?: string;
  legacySourceConversationId?: string;
  permissionMode?: ConversationPermissionMode;
  collaborationMode?: ConversationCollaborationMode;
  agentKind?: ConversationAgentKind;
  agentTransport?: ConversationAgentTransport;
  modelSourceId?: string;
  modelId?: string;
  nativeSessionId?: string;
  nativeSessionPath?: string;
  capabilitySnapshotId?: string;
}

export interface AppendConversationMessageInput {
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  clientMessageId?: string;
}

export interface UpdateConversationRuntimeStateInput {
  sessionId?: string | null;
  status?: string;
  summary?: string | null;
}

export interface BindConversationProviderInput {
  providerId: string;
  providerThreadId: string;
  providerThreadPath?: string | null;
  providerModel?: string | null;
  providerState: ConversationProviderState;
  providerProtocolVersion?: string | null;
  providerBinaryVersion?: string | null;
}

export interface ProviderSequenceSnapshot {
  generationId: string;
  sequence: number;
}

export interface ConversationProviderSettingsSnapshot extends ProviderSequenceSnapshot {
  model: string;
  effort?: string;
  serviceTier?: string | null;
}

export interface ConversationProviderTokenUsageSnapshot extends ProviderSequenceSnapshot {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
  cacheHitRate: number | null;
  estimatedCredits: number | null;
  apiEquivalentUsd: number | null;
  cacheSavingsUsd: number | null;
  priceCoverage: number | null;
  pricingCatalogDate: string | null;
  pricingSourceUrls: string[];
  historyComplete: boolean;
}

export interface CodexUsageLedgerRecord {
  id: string;
  providerId: string;
  accountScopeId: string;
  projectId: string;
  conversationId: string;
  providerThreadId: string;
  providerTurnId: string;
  model: string;
  serviceTier: string | null;
  usage: TokenUsageBreakdown;
  estimate: CodexUsageEstimate;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCodexUsageLedgerInput {
  providerId: string;
  accountScopeId: string;
  projectId: string;
  conversationId: string;
  providerThreadId: string;
  providerTurnId: string;
  model: string;
  serviceTier?: string | null;
  usage: TokenUsageBreakdown;
  estimate: CodexUsageEstimate;
  occurredAt: string;
}

export interface ListCodexUsageLedgerInput {
  accountScopeId?: string | null;
  since?: string | null;
  projectId?: string | null;
  model?: string | null;
  conversationId?: string | null;
}

export type ProviderVisibleJson = null | boolean | number | string | ProviderVisibleJson[] | { [key: string]: ProviderVisibleJson };
export interface CodexRateLimitWindowState {
  remaining?: number;
  usedPercent?: number;
  resetsAt?: number | string | null;
}
export interface CodexRateLimitCreditsState {
  balance?: number | string | null;
  unlimited?: boolean;
}
export interface CodexRateLimitsState {
  primary?: CodexRateLimitWindowState;
  secondary?: CodexRateLimitWindowState;
  credits?: CodexRateLimitCreditsState;
  planType?: string;
}
export interface CodexRateLimitsSnapshot extends ProviderSequenceSnapshot {
  value: CodexRateLimitsState;
}
export type CodexMcpServerStartupState = string | { status: string; error?: string | null };
export interface CodexMcpStartupStatusSnapshot extends ProviderSequenceSnapshot {
  value: Record<string, CodexMcpServerStartupState>;
}

export type ConversationTurnStatus = 'queued' | 'dispatching' | 'running' | 'waiting' | 'paused' | 'completed' | 'interrupted' | 'failed';
export interface ZeusConversationTurnRecord {
  id: string;
  conversationId: string;
  providerThreadId: string;
  providerTurnId: string | null;
  clientSubmissionId: string;
  status: ConversationTurnStatus;
  errorJson: string | null;
  planJson: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentKind: ConversationAgentKind | null;
  nativeRunId: string | null;
}

export type ConversationItemType = 'userMessage' | 'agentMessage' | 'reasoning' | 'commandExecution' | 'fileChange' | 'mcpToolCall' | 'dynamicToolCall' | 'plan' | 'imageView' | 'webSearch' | 'contextCompaction' | 'error';
export type ConversationItemStatus = 'in_progress' | 'completed' | 'failed';
export type ConversationItemPhase = 'prework' | 'final_answer';
export interface ZeusConversationItemRecord {
  id: string;
  conversationId: string;
  turnId: string;
  providerThreadId: string;
  providerTurnId: string;
  providerItemId: string;
  itemType: ConversationItemType;
  status: ConversationItemStatus;
  phase: ConversationItemPhase;
  textContent: string;
  payloadJson: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  agentKind: ConversationAgentKind | null;
  nativeItemId: string | null;
}

export type AgentCapabilitySupportStatus = 'unavailable' | 'framework_only' | 'experimental' | 'verified';

export interface ZeusAgentCapabilitySnapshotRecord {
  id: string;
  agentKind: ConversationAgentKind;
  transportKind: ConversationAgentTransport;
  supportStatus: AgentCapabilitySupportStatus;
  adapterVersion: string | null;
  binaryVersion: string | null;
  protocolVersion: string | null;
  capabilitiesJson: string;
  evidenceJson: string;
  checkedAt: string;
}

export interface CreateAgentCapabilitySnapshotInput {
  id?: string;
  agentKind: ConversationAgentKind;
  transportKind: ConversationAgentTransport;
  supportStatus: AgentCapabilitySupportStatus;
  adapterVersion?: string;
  binaryVersion?: string;
  protocolVersion?: string;
  capabilities: unknown;
  evidence: unknown;
  checkedAt: string;
}

export interface ZeusConversationResourceRecord {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  itemId: string;
  sourceIndex: number;
  canonicalTargetDigest: string;
  kind: ConversationResourceKind;
  presentation: ConversationResourcePresentation;
  displayJson: string;
  targetJson: string;
  authorityJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTurnChangeSetRecord {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  providerTurnId: string;
  state: TurnChangeSetState;
  unifiedDiff: string;
  preImageDigest: string | null;
  postImageDigest: string | null;
  conflictJson: string | null;
  unavailableReason: string | null;
  journalRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTurnChangeFileRecord {
  id: string;
  changeSetId: string;
  sourceItemId: string | null;
  sourceIndex: number;
  oldPath: string | null;
  newPath: string | null;
  changeType: TurnChangeFileType;
  addedLines: number;
  deletedLines: number;
  preHash: string | null;
  postHash: string | null;
  preExists: boolean;
  postExists: boolean;
  preMode: number | null;
  postMode: number | null;
  unifiedDiff: string;
  preBlobRef: string | null;
  postBlobRef: string | null;
  reversible: boolean;
  unavailableReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ConversationSubmissionKind = 'message' | 'steer';
export type ConversationRequestedDelivery = 'queue' | 'send_now';
export type ConversationSubmissionStatus = 'queued' | 'dispatching' | 'active' | 'paused' | 'completed' | 'resolved' | 'failed' | 'cancelled' | 'deleted';
export interface ZeusConversationSubmissionRecord {
  id: string;
  conversationId: string;
  idempotencyKey: string;
  requestHash: string;
  clientMessageId: string;
  kind: ConversationSubmissionKind;
  requestedDelivery: ConversationRequestedDelivery;
  status: ConversationSubmissionStatus;
  queuePosition: number | null;
  inputJson: string;
  targetProviderTurnId: string | null;
  providerTurnId: string | null;
  pausedReason: string | null;
  errorJson: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  resolvedAt: string | null;
}

export type ConversationServerRequestKind = 'command' | 'file' | 'permissions' | 'request_user_input' | 'mcp';
export type ConversationServerRequestStatus = 'pending' | 'resolved' | 'declined' | 'expired' | 'failed';
export interface ZeusConversationServerRequestRecord {
  id: string;
  conversationId: string;
  turnId: string | null;
  itemId: string | null;
  transportGenerationId: string;
  providerRequestIdJson: string;
  requestKind: ConversationServerRequestKind;
  payloadJson: string;
  status: ConversationServerRequestStatus;
  responseJson: string | null;
  containsSecret: boolean;
  expiresAt: string | null;
  autoResolutionState: ConversationRequestAutoResolutionState;
  createdAt: string;
  resolvedAt: string | null;
}

export type ConversationRequestAutoResolutionState = 'none' | 'scheduled' | 'snoozed';

export type ConversationPlanActionStatus = 'pending' | 'dismissed' | 'implemented' | 'refinement_requested' | 'superseded';

export interface ZeusConversationPlanActionRecord {
  id: string;
  conversationId: string;
  turnId: string;
  planItemId: string;
  status: ConversationPlanActionStatus;
  submissionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export type IdempotencyRequestStatus = 'in_progress' | 'completed' | 'failed';
export interface ZeusIdempotencyRequestRecord {
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  status: IdempotencyRequestStatus;
  httpStatus: number | null;
  responseJson: string | null;
  resourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusGitSnapshotRecord {
  id: string;
  taskId: string;
  projectId: string;
  snapshotType: string;
  branch: string | null;
  headSha: string | null;
  statusJson: string;
  diffTextPath: string | null;
  createdAt: string;
}

export interface ZeusGitChangeRecord {
  id: string;
  taskId: string;
  projectId: string;
  filePath: string;
  changeType: string;
  additions: number;
  deletions: number;
  diffHunkPath: string | null;
  linkedGraphNodesJson: string;
  createdAt: string;
}

export interface CreateGitSnapshotInput {
  taskId: string;
  projectId: string;
  snapshotType: string;
  branch?: string;
  headSha?: string;
  status: Record<string, unknown>;
  diffTextPath?: string;
  createdAt: string;
}

export interface CreateGitChangeInput {
  taskId: string;
  projectId: string;
  filePath: string;
  changeType: string;
  additions?: number;
  deletions?: number;
  diffHunkPath?: string;
  linkedGraphNodes?: string[];
  createdAt: string;
}

export interface ZeusAuditLogRecord {
  id: string;
  actorType: string;
  actorRef: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payloadJson: string;
  createdAt: string;
}

export interface AppendAuditLogInput {
  actorType: string;
  actorRef?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const builtInTaskTemplates = [
  {
    id: 'task_template_requirement_analysis',
    sortOrder: 1,
    name: '需求分析',
    description: '澄清真实需求、业务规则、边界与验收标准。',
    promptTemplate: '请基于 {{project_context}} 分析需求：{{requirement}}，输出业务规则、边界场景和验收标准。',
  },
  {
    id: 'task_template_code_implementation',
    sortOrder: 2,
    name: '代码实现',
    description: '根据已确认方案实现真实代码变更并补充验证。',
    promptTemplate: '请在 {{project_path}} 按设计实现：{{implementation_goal}}，并说明影响范围与验证方式。',
  },
  {
    id: 'task_template_bug_fix',
    sortOrder: 3,
    name: 'Bug 修复',
    description: '定位真实缺陷、补充回归验证并修复。',
    promptTemplate: '请复现并修复缺陷：{{bug_report}}，给出根因、修法、静态检查和真实运行验证结果。',
  },
  {
    id: 'task_template_code_review',
    sortOrder: 4,
    name: '代码评审',
    description: '审查真实变更的正确性、风险和可维护性。',
    promptTemplate: '请审查以下真实变更：{{diff_context}}，重点关注正确性、风险、验证缺口和回滚建议。',
  },
  {
    id: 'task_template_performance_analysis',
    sortOrder: 5,
    name: '性能分析',
    description: '分析真实代码路径的性能瓶颈与可观测指标。',
    promptTemplate: '请分析 {{target_flow}} 的性能风险，给出瓶颈假设、验证方式、优化建议和回归指标。',
  },
  {
    id: 'task_template_architecture_analysis',
    sortOrder: 6,
    name: '架构分析',
    description: '基于真实图谱理解模块边界、依赖和演进风险。',
    promptTemplate: '请基于 {{graph_context}} 分析架构边界、依赖方向、风险点和改造顺序。',
  },
  {
    id: 'task_template_sql_optimization',
    sortOrder: 7,
    name: 'SQL 优化',
    description: '分析真实 SQL、表结构或查询路径的优化空间。',
    promptTemplate: '请基于 {{sql_context}} 分析 SQL 性能、索引、事务一致性和回滚风险。',
  },
] as const;

const NATIVE_SQLITE_MIGRATION_ID = '20260808_0001_native_sqlite_wal';
const PROVIDER_EVENT_RECEIPTS_MIGRATION_ID = '20260808_0002_provider_event_receipts';
const NATIVE_SQLITE_BACKUP_SUFFIX = '.pre-native-sqlite.bak';
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_BACKUP_FREE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;
const LEGACY_PROCESSED_PROVIDER_EVENTS_SETTING_KEY = 'codex.native.processed_provider_events';

let sqlModulePromise: Promise<SqlJsStatic> | undefined;

/** 加载 sql.js SQLite 引擎；保持单例，避免每次打开数据库都重复初始化 wasm。 */
async function loadSqlModule(): Promise<SqlJsStatic> {
  sqlModulePromise ??= initSqlJs();
  return sqlModulePromise;
}

/** Zeus SQLite 包装器：负责迁移、保存和运行态诊断查询。 */
export class ZeusDatabase {
  private requestedSaveRevision = 0;
  private persistedSaveRevision = 0;
  private saveLoop: Promise<void> | null = null;
  private savepointSequence = 0;
  private savepointDepth = 0;
  private closed = false;
  private writeFailure: Error | null = null;

  constructor(private readonly db: DatabaseSync) {}

  execute(sql: string, params: SqlValue[] = []): void {
    this.assertWritable();
    if (isSqlTransactionControl(sql)) {
      throw new Error('ZeusDatabase.execute 不接受事务控制语句，请使用 transaction() 或 save()。');
    }
    this.ensurePendingTransaction();
    if (params.length === 0) {
      this.db.exec(sql);
      return;
    }
    this.db.prepare(sql).run(...params);
  }

  select<T>(sql: string, params: SqlValue[] = []): T[] {
    this.assertOpen();
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.select<T>(sql, params)[0];
  }

  countRows(tableName: string): number {
    if (!/^[a-z_]+$/u.test(tableName)) {
      throw new Error(`Invalid Zeus table name: ${tableName}`);
    }
    return this.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${tableName}`)?.count ?? 0;
  }

  async save(): Promise<void> {
    this.assertWritable();
    if (this.savepointDepth > 0) throw new Error('事务回调执行期间不能调用 ZeusDatabase.save()。');
    const requestedRevision = ++this.requestedSaveRevision;
    while (this.persistedSaveRevision < requestedRevision) {
      if (!this.saveLoop) {
        const loop = this.runSaveLoop();
        const trackedLoop = loop.finally(() => {
          if (this.saveLoop === trackedLoop) this.saveLoop = null;
        });
        this.saveLoop = trackedLoop;
      }
      await this.saveLoop;
    }
  }

  /**
   * 同一时刻只提交一个待持久事务；并发保存会合并到当前提交后的至多一次补提交流程。
   * SQLite WAL 只追加变化页，不再生成或替换完整数据库文件。
   */
  private async runSaveLoop(): Promise<void> {
    while (this.persistedSaveRevision < this.requestedSaveRevision) {
      const targetRevision = this.requestedSaveRevision;
      try {
        if (this.db.isTransaction) this.db.exec('COMMIT');
        this.persistedSaveRevision = targetRevision;
      } catch (error) {
        this.writeFailure = storageWriteError('Zeus SQLite 提交失败，存储已进入只读故障态。', error);
        throw this.writeFailure;
      }
    }
  }

  transaction<T>(operation: () => T): T {
    this.assertWritable();
    this.ensurePendingTransaction();
    const savepointName = `zeus_transaction_${++this.savepointSequence}`;
    this.db.exec(`SAVEPOINT ${savepointName}`);
    this.savepointDepth += 1;
    try {
      const result = operation();
      if (result instanceof Promise) throw new Error('ZeusDatabase.transaction 只接受同步事务回调。');
      this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      } catch (rollbackError) {
        this.writeFailure = storageWriteError('Zeus SQLite 保存点回滚失败，存储已进入只读故障态。', rollbackError);
        throw new AggregateError([error, this.writeFailure], 'Zeus SQLite 事务与回滚同时失败。');
      }
      throw error;
    } finally {
      this.savepointDepth -= 1;
    }
  }

  /** 正常关闭会先提交、截断 WAL，再释放数据库句柄。 */
  async close(): Promise<void> {
    if (this.closed) return;
    const errors: unknown[] = [];
    try {
      await this.save();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.db.isTransaction) {
      try {
        this.db.exec('ROLLBACK');
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.db.close();
      this.closed = true;
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Zeus SQLite 关闭失败。');
  }

  /** 启动失败时丢弃未提交变化，正式运行路径不得调用。 */
  discardAndClose(): void {
    if (this.closed) return;
    try {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
    } finally {
      this.db.close();
      this.closed = true;
    }
  }

  private ensurePendingTransaction(): void {
    if (!this.db.isTransaction) this.db.exec('BEGIN IMMEDIATE');
  }

  private assertOpen(): void {
    if (this.closed || !this.db.isOpen) throw new Error('Zeus SQLite 已关闭。');
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.writeFailure) throw this.writeFailure;
  }
}

function isSqlTransactionControl(sql: string): boolean {
  return /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/iu.test(sql);
}

function storageWriteError(message: string, cause: unknown): Error {
  return cause instanceof Error ? new Error(`${message} ${cause.message}`, { cause }) : new Error(`${message} ${String(cause)}`);
}

export interface SqliteSchemaIntrospectionSnapshot {
  sourcePath: string;
  statements: Array<{
    type: 'table' | 'index' | 'trigger' | 'view';
    name: string;
    sql: string;
  }>;
}

/** 只读读取用户配置的 SQLite 文件 schema；不执行迁移、不写回目标数据库。 */
export async function introspectSqliteSchema(filePath: string): Promise<SqliteSchemaIntrospectionSnapshot> {
  const SQL = await loadSqlModule();
  const bytes = await readFile(filePath);
  const sqlite = new SQL.Database(bytes);
  try {
    const tableNames = selectSqliteObjects(sqlite, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .map((row) => String(row.name ?? ''))
      .filter(Boolean);
    const statements: SqliteSchemaIntrospectionSnapshot['statements'] = tableNames.map((tableName) => ({
      type: 'table',
      name: tableName,
      sql: renderSqliteCreateTable(sqlite, tableName),
    }));
    statements.push(...tableNames.flatMap((tableName) => renderSqliteCreateIndexes(sqlite, tableName)));
    statements.push(
      ...selectSqliteObjects(sqlite, `SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') AND sql IS NOT NULL ORDER BY type, name`).flatMap((row) => {
        if ((row.type === 'trigger' || row.type === 'view') && typeof row.name === 'string' && typeof row.sql === 'string') {
          return [
            {
              type: row.type as 'trigger' | 'view',
              name: row.name,
              sql: row.sql,
            },
          ];
        }
        return [];
      }),
    );
    return { sourcePath: filePath, statements };
  } finally {
    sqlite.close();
  }
}

function selectSqliteObjects(sqlite: SqlJsDatabase, sql: string): Array<Record<string, SqlJsValue>> {
  const stmt = sqlite.prepare(sql);
  const rows: Array<Record<string, SqlJsValue>> = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, SqlJsValue>);
  } finally {
    stmt.free();
  }
  return rows;
}

function renderSqliteCreateTable(sqlite: SqlJsDatabase, tableName: string): string {
  const columns = selectSqliteObjects(sqlite, `PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`);
  const foreignKeys = selectSqliteObjects(sqlite, `PRAGMA foreign_key_list(${quoteSqliteIdentifier(tableName)})`);
  const columnLines = columns.map((column) => {
    const parts = [
      quoteSqliteIdentifier(String(column.name)),
      String(column.type || 'TEXT').toUpperCase(),
      Number(column.notnull ?? 0) === 1 ? 'NOT NULL' : '',
      Number(column.pk ?? 0) === 1 ? 'PRIMARY KEY' : '',
      column.dflt_value !== null && column.dflt_value !== undefined ? `DEFAULT ${String(column.dflt_value)}` : '',
    ].filter(Boolean);
    return `  ${parts.join(' ')}`;
  });
  const foreignKeyLines = foreignKeys.map((foreignKey) => `  FOREIGN KEY (${quoteSqliteIdentifier(String(foreignKey.from))}) REFERENCES ${quoteSqliteIdentifier(String(foreignKey.table))}(${quoteSqliteIdentifier(String(foreignKey.to))})`);
  return `CREATE TABLE ${quoteSqliteIdentifier(tableName)} (\n${[...columnLines, ...foreignKeyLines].join(',\n')}\n)`;
}

function renderSqliteCreateIndexes(sqlite: SqlJsDatabase, tableName: string): SqliteSchemaIntrospectionSnapshot['statements'] {
  return selectSqliteObjects(sqlite, `PRAGMA index_list(${quoteSqliteIdentifier(tableName)})`)
    .filter((index) => String(index.origin ?? 'c') === 'c')
    .flatMap((index) => {
      const indexName = String(index.name ?? '');
      if (!indexName || indexName.startsWith('sqlite_')) return [];
      const columns = selectSqliteObjects(sqlite, `PRAGMA index_info(${quoteSqliteIdentifier(indexName)})`)
        .map((column) => quoteSqliteIdentifier(String(column.name ?? '')))
        .filter((name) => name !== '""');
      if (columns.length === 0) return [];
      const unique = Number(index.unique ?? 0) === 1 ? 'UNIQUE ' : '';
      return [
        {
          type: 'index' as const,
          name: indexName,
          sql: `CREATE ${unique}INDEX ${quoteSqliteIdentifier(indexName)} ON ${quoteSqliteIdentifier(tableName)} (${columns.join(', ')})`,
        },
      ];
    });
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

/** 创建或打开 Zeus SQLite 数据库，并执行幂等迁移；不会写入任何 seed 业务记录。 */
export async function createZeusDatabase(filePath: string): Promise<ZeusDatabase> {
  const parentPath = dirname(filePath);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const databaseExists = await pathExists(filePath);

  if (databaseExists) {
    const sourceDb = openNativeSqlite(filePath, true);
    try {
      assertDatabaseQuickCheck(sourceDb, '现有 Zeus 数据库');
      if (!hasNativeSqliteMigration(sourceDb)) await ensureNativeSqliteBackup(sourceDb, filePath);
    } finally {
      sourceDb.close();
    }
  }

  const nativeDb = openNativeSqlite(filePath, false);
  try {
    await chmod(filePath, 0o600);
    configureNativeSqlite(nativeDb);
  } catch (error) {
    nativeDb.close();
    throw error;
  }

  const zeusDb = new ZeusDatabase(nativeDb);
  try {
    migrateCoreSchema(zeusDb);
    migrateRetiredUnitTestTemplate(zeusDb);
    migrateTaskManagementStatus(zeusDb);
    migrateTaskTypesAndContents(zeusDb);
    migrateCodexNativeConversationSchema(zeusDb);
    migrateCodexUsageLedgerSchema(zeusDb);
    migrateConversationStageSchema(zeusDb);
    migrateAgentRuntimeSchema(zeusDb);
    migrateTaskGitWorkspaceSchema(zeusDb);
    migrateMultiRepositoryTaskSchema(zeusDb);
    migrateCodexLegacyImportSchema(zeusDb);
    migrateMcpServerIdentifierFalsePositiveCleanup(zeusDb);
    migrateContextCompactionItemClassification(zeusDb);
    migrateCommandCenterSchema(zeusDb);
    migrateProviderEventReceipts(zeusDb);
    recordSchemaMigration(zeusDb, {
      migrationId: NATIVE_SQLITE_MIGRATION_ID,
      description: '切换为原生 SQLite WAL 增量持久化',
      checksumSource: 'node:sqlite,WAL,synchronous=FULL,busy_timeout=5000,wal_autocheckpoint=1000',
    });
    await zeusDb.save();
    assertDatabaseQuickCheck(nativeDb, '迁移后的 Zeus 数据库');
    return zeusDb;
  } catch (error) {
    zeusDb.discardAndClose();
    throw error;
  }
}

function openNativeSqlite(filePath: string, readOnly: boolean): DatabaseSync {
  return new DatabaseSync(filePath, {
    readOnly,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
}

function configureNativeSqlite(db: DatabaseSync): void {
  const journalMode = db.prepare('PRAGMA journal_mode = WAL').get();
  if (String(journalMode?.journal_mode ?? '').toLowerCase() !== 'wal') throw new Error('Zeus SQLite 无法启用 WAL，已中止启动。');
  db.exec(`PRAGMA synchronous = FULL`);
  db.exec(`PRAGMA foreign_keys = ON`);
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.exec(`PRAGMA wal_autocheckpoint = 1000`);
  db.enableDefensive(true);
}

function hasNativeSqliteMigration(db: DatabaseSync): boolean {
  const ledger = db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get();
  if (!ledger) return false;
  return Boolean(db.prepare(`SELECT 1 AS present FROM schema_migrations WHERE migration_id = ?`).get(NATIVE_SQLITE_MIGRATION_ID));
}

async function ensureNativeSqliteBackup(sourceDb: DatabaseSync, filePath: string): Promise<void> {
  const backupPath = `${filePath}${NATIVE_SQLITE_BACKUP_SUFFIX}`;
  const sourcePageCount = sqlitePageCount(sourceDb);
  if (await pathExists(backupPath)) {
    const existingBackup = openNativeSqlite(backupPath, true);
    try {
      assertDatabaseQuickCheck(existingBackup, '现有原生 SQLite 迁移备份');
      if (sqlitePageCount(existingBackup) !== sourcePageCount) throw new Error(`原生 SQLite 迁移备份与源数据库页数不一致：${backupPath}`);
      return;
    } finally {
      existingBackup.close();
    }
  }

  const sourceStats = await stat(filePath);
  const filesystemStats = await statfs(dirname(filePath));
  const availableBytes = filesystemStats.bavail * filesystemStats.bsize;
  const logicalDatabaseBytes = sourcePageCount * sqlitePageSize(sourceDb);
  const requiredBytes = Math.max(sourceStats.size, logicalDatabaseBytes) + SQLITE_BACKUP_FREE_SPACE_RESERVE_BYTES;
  if (availableBytes < requiredBytes) {
    throw new Error(`原生 SQLite 迁移至少需要 ${requiredBytes} 字节可用空间，当前仅有 ${availableBytes} 字节。`);
  }

  const temporaryBackupPath = `${backupPath}.creating-${process.pid}-${randomUUID()}`;
  try {
    await backup(sourceDb, temporaryBackupPath);
    await chmod(temporaryBackupPath, 0o600);
    const createdBackup = openNativeSqlite(temporaryBackupPath, true);
    try {
      assertDatabaseQuickCheck(createdBackup, '新建原生 SQLite 迁移备份');
      if (sqlitePageCount(createdBackup) !== sourcePageCount) throw new Error(`新建原生 SQLite 迁移备份与源数据库页数不一致：${temporaryBackupPath}`);
    } finally {
      createdBackup.close();
    }
    await rename(temporaryBackupPath, backupPath);
  } catch (error) {
    await unlink(temporaryBackupPath).catch(() => undefined);
    throw error;
  }
}

function sqlitePageCount(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA page_count').get();
  const value = Number(row?.page_count ?? -1);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Zeus SQLite 无法读取数据库页数。');
  return value;
}

function sqlitePageSize(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA page_size').get();
  const value = Number(row?.page_size ?? 0);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Zeus SQLite 无法读取数据库页大小。');
  return value;
}

function assertDatabaseQuickCheck(db: DatabaseSync, label: string): void {
  const rows = db.prepare('PRAGMA quick_check').all();
  const messages = rows.flatMap((row) => Object.values(row)).map(String);
  if (messages.length !== 1 || messages[0]?.toLowerCase() !== 'ok') throw new Error(`${label}完整性检查失败：${messages.join('; ') || '无检查结果'}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function migrateProviderEventReceipts(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS provider_event_receipts (
      identity TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      method TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      provider_item_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      UNIQUE (generation_id, sequence, method, thread_id, provider_turn_id, provider_item_id, request_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_provider_event_receipts_generation_sequence ON provider_event_receipts(generation_id, sequence)`);
  if (db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [PROVIDER_EVENT_RECEIPTS_MIGRATION_ID])) return;

  const legacySetting = db.get<{ value_json: string }>(`SELECT value_json FROM settings WHERE key = ?`, [LEGACY_PROCESSED_PROVIDER_EVENTS_SETTING_KEY]);
  if (legacySetting) {
    let identities: unknown;
    try {
      identities = JSON.parse(legacySetting.value_json);
    } catch (error) {
      throw storageWriteError('历史 Provider 事件去重记录无法解析，已保留原数据并中止迁移。', error);
    }
    if (!Array.isArray(identities) || identities.some((identity) => typeof identity !== 'string' || !identity)) {
      throw new Error('历史 Provider 事件去重记录格式非法，已保留原数据并中止迁移。');
    }
    const receipts = new ProviderEventReceiptRepository(db);
    for (const identity of new Set(identities)) {
      const [generationId = 'legacy', sequenceValue = '-1', method = 'legacy', threadId = '', providerTurnId = '', providerItemId = ''] = identity.split('|');
      const parsedSequence = Number(sequenceValue);
      receipts.record({
        identity,
        generationId,
        sequence: Number.isSafeInteger(parsedSequence) ? parsedSequence : -1,
        method,
        threadId,
        providerTurnId,
        providerItemId,
        // 旧格式以完整 identity 占位，避免两个不完整旧记录触发复合唯一键冲突。
        requestId: identity,
        receivedAt: nowIso(),
      });
    }
    for (const identity of new Set(identities)) {
      if (!receipts.has(identity)) throw new Error(`Provider 事件回执迁移校验失败：${identity}`);
    }
    db.execute(`DELETE FROM settings WHERE key = ?`, [LEGACY_PROCESSED_PROVIDER_EVENTS_SETTING_KEY]);
  }

  recordSchemaMigration(db, {
    migrationId: PROVIDER_EVENT_RECEIPTS_MIGRATION_ID,
    description: '将 Provider 事件去重记录迁移为逐行事务回执',
    checksumSource: 'provider_event_receipts:identity,generation_id,sequence,method,thread_id,provider_turn_id,provider_item_id,request_id,received_at',
  });
}

function migrateCoreSchema(db: ZeusDatabase): void {
  createSchemaMigrationsLedger(db);

  db.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      local_path TEXT NOT NULL,
      git_root TEXT,
      project_type TEXT,
      primary_language TEXT,
      description TEXT,
      note TEXT,
      default_model TEXT,
      default_work_mode TEXT,
      default_template_id TEXT,
      scan_status TEXT NOT NULL DEFAULT 'not_scanned',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  try {
    db.execute(`ALTER TABLE projects ADD COLUMN note TEXT`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  try {
    db.execute(`ALTER TABLE projects ADD COLUMN default_template_id TEXT`);
  } catch {
    // 列已存在时忽略；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  }
  db.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_task_id TEXT,
      title TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'requirement',
      description TEXT NOT NULL,
      defect_current_state TEXT NOT NULL DEFAULT '',
      defect_expected_outcome TEXT NOT NULL DEFAULT '',
      defect_reproduction_steps TEXT NOT NULL DEFAULT '',
      optimization_current_state TEXT NOT NULL DEFAULT '',
      optimization_expected_outcome TEXT NOT NULL DEFAULT '',
      management_status TEXT NOT NULL DEFAULT 'todo',
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      tags_json TEXT NOT NULL,
      template_id TEXT,
      model TEXT,
      work_dir TEXT,
      allow_code_changes INTEGER NOT NULL DEFAULT 0,
      allow_tests INTEGER NOT NULL DEFAULT 0,
      allow_git_commit INTEGER NOT NULL DEFAULT 0,
      created_from TEXT NOT NULL,
      source_context_json TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    )
  `);
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN task_code TEXT`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN task_sequence INTEGER`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS task_relations (
      left_task_id TEXT NOT NULL,
      right_task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (left_task_id, right_task_id),
      CHECK (left_task_id < right_task_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_relations_right_task_id ON task_relations(right_task_id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS runtime_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      process_identity_token TEXT,
      exit_code INTEGER,
      summary TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  for (const statement of [
    `ALTER TABLE runtime_sessions ADD COLUMN summary TEXT`,
    `ALTER TABLE runtime_sessions ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runtime_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runtime_sessions ADD COLUMN deleted_at TEXT`,
    `ALTER TABLE runtime_sessions ADD COLUMN process_identity_token TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // 列已存在时忽略；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
    }
  }

  db.execute(`
    CREATE TABLE IF NOT EXISTS runtime_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS terminal_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      content TEXT NOT NULL,
      raw_chunk_path TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      session_id TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS git_snapshots (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      branch TEXT,
      head_sha TEXT,
      status_json TEXT NOT NULL,
      diff_text_path TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS git_changes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      change_type TEXT NOT NULL,
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      diff_hunk_path TEXT,
      linked_graph_nodes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_ref TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS task_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      prompt_template TEXT NOT NULL,
      default_options_json TEXT NOT NULL DEFAULT '{}',
      built_in INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  for (const statement of [
    `CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_status_updated_at ON tasks(project_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_task_code ON tasks(project_id, task_code)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_sequence ON tasks(project_id, task_sequence)`,
    `CREATE INDEX IF NOT EXISTS idx_task_events_task_created_at ON task_events(task_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_sessions_task_status ON runtime_sessions(task_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_sessions_status ON runtime_sessions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_logs_session_id ON runtime_logs(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_terminal_events_session_seq ON terminal_events(session_id, seq)`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_project_updated_at ON conversations(project_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_created_at ON conversation_messages(conversation_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_git_snapshots_task_created_at ON git_snapshots(task_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_git_changes_task_file_path ON git_changes(task_id, file_path)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_at ON audit_logs(action, created_at)`,
  ]) {
    db.execute(statement);
  }
  backfillMissingTaskCodes(db);
  try {
    db.execute(`ALTER TABLE task_templates ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // 列已存在时忽略；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  }
  try {
    db.execute(`ALTER TABLE task_templates ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`);
  } catch {
    // 列已存在时忽略；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  }
  try {
    db.execute(`ALTER TABLE task_templates ADD COLUMN default_options_json TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // 列已存在时忽略；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  }

  const timestamp = nowIso();
  for (const template of builtInTaskTemplates) {
    db.execute(
      `INSERT OR IGNORE INTO task_templates (id, name, description, category, prompt_template, default_options_json, built_in, created_at, updated_at)
       VALUES (?, ?, ?, 'built_in', ?, '{}', 1, ?, ?)`,
      [template.id, template.name, template.description, template.promptTemplate, timestamp, timestamp],
    );
    db.execute(`UPDATE task_templates SET sort_order = ?, name = ?, description = ?, category = 'built_in', prompt_template = ?, default_options_json = '{}', updated_at = ? WHERE id = ? AND built_in = 1`, [
      template.sortOrder,
      template.name,
      template.description,
      template.promptTemplate,
      timestamp,
      template.id,
    ]);
  }

  recordSchemaMigration(db, {
    migrationId: '20260613_0001_core_schema',
    description: '初始化 Zeus 核心表、索引和内置任务模板定义',
    checksumSource: 'projects,tasks,task_events,runtime_sessions,runtime_logs,terminal_events,conversations,conversation_messages,git_snapshots,git_changes,audit_logs,event_log,settings,task_templates,indexes,built_in_templates',
  });
}

function migrateRetiredUnitTestTemplate(db: ZeusDatabase): void {
  const migrationId = '20260723_0001_retire_unit_test_template';
  if (
    db.get<{ migration_id: string }>(
      `SELECT migration_id
                                          FROM schema_migrations
                                          WHERE migration_id = ?`,
      [migrationId],
    )
  )
    return;
  db.execute(`DELETE
                FROM task_templates
                WHERE id = 'task_template_unit_test'
                  AND built_in = 1`);
  recordSchemaMigration(db, {
    migrationId,
    description: '退役内置单元测试任务模板',
    checksumSource: 'task_templates:delete:task_template_unit_test:built_in:v1',
  });
}

function migrateTaskManagementStatus(db: ZeusDatabase): void {
  const migrationId = '20260721_0001_task_management_status';
  if (
    db.get<{
      migration_id: string;
    }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])
  )
    return;
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN management_status TEXT NOT NULL DEFAULT 'todo'`);
  } catch {
    // 新库已在建表语句中包含字段；旧库重复执行时也安全忽略。
  }
  // 只在本迁移首次执行时把旧的 Agent 执行状态映射成项目阶段；后续两套状态互不自动覆盖。
  db.execute(`
    UPDATE tasks
       SET management_status = CASE status
         WHEN 'completed' THEN 'completed'
         WHEN 'cancelled' THEN 'cancelled'
         WHEN 'running' THEN 'in_development'
         WHEN 'paused' THEN 'in_development'
         WHEN 'waiting_confirmation' THEN 'in_development'
         WHEN 'failed' THEN 'in_development'
         ELSE 'todo'
       END
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_project_management_status_updated_at ON tasks(project_id, management_status, updated_at)`);
  recordSchemaMigration(db, {
    migrationId,
    description: '拆分项目管理任务状态与 Coding Agent 执行状态',
    checksumSource: 'tasks.management_status:v1:todo,in_development,in_testing,awaiting_acceptance,blocked,completed,cancelled',
  });
}

function migrateTaskTypesAndContents(db: ZeusDatabase): void {
  const migrationId = '20260805_0001_task_types_and_contents';
  if (db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])) return;
  const columns = [
    `task_type TEXT NOT NULL DEFAULT 'requirement'`,
    `defect_current_state TEXT NOT NULL DEFAULT ''`,
    `defect_expected_outcome TEXT NOT NULL DEFAULT ''`,
    `defect_reproduction_steps TEXT NOT NULL DEFAULT ''`,
    `optimization_current_state TEXT NOT NULL DEFAULT ''`,
    `optimization_expected_outcome TEXT NOT NULL DEFAULT ''`,
  ];
  for (const column of columns) {
    try {
      db.execute(`ALTER TABLE tasks ADD COLUMN ${column}`);
    } catch {
      // 新数据库建表时已经包含这些字段；旧数据库重复执行时也安全忽略。
    }
  }
  // 历史任务按用户确认口径统一归为需求；未知脏值同样收敛到合法类型。
  db.execute(`UPDATE tasks SET task_type = 'requirement' WHERE task_type IS NULL OR task_type NOT IN ('requirement', 'defect', 'optimization')`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_project_type_updated_at ON tasks(project_id, task_type, updated_at)`);
  recordSchemaMigration(db, {
    migrationId,
    description: '增加任务类型与类型专属内容，历史任务统一迁移为需求',
    checksumSource: 'tasks.task_type:requirement,defect,optimization:typed-content',
  });
}

function migrateTaskGitWorkspaceSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS task_workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      source_head_sha TEXT NOT NULL,
      remote_name TEXT NOT NULL DEFAULT 'origin',
      remote_branch TEXT NOT NULL,
      worktree_path TEXT,
      head_sha TEXT,
      state TEXT NOT NULL DEFAULT 'ready',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const usesRepositoryScopedWorkspaces = Boolean(db.get<{ name: string }>(`SELECT name FROM pragma_table_info('task_workspaces') WHERE name = 'repository_id'`));
  if (usesRepositoryScopedWorkspaces) {
    // 多仓模型允许同一项目的不同仓库使用同名任务分支，旧项目级唯一索引必须先移除。
    db.execute(`DROP INDEX IF EXISTS idx_task_workspaces_project_branch`);
  } else {
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_workspaces_project_branch ON task_workspaces(project_id, branch_name)`);
  }
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_workspaces_worktree_path ON task_workspaces(worktree_path) WHERE worktree_path IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_workspaces_task_state ON task_workspaces(task_id, state, updated_at)`);
  try {
    db.execute(`ALTER TABLE conversations ADD COLUMN workspace_id TEXT`);
  } catch {
    // 新库可能已经完成迁移；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  }
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_workspace_updated_at ON conversations(workspace_id, updated_at)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS task_integrations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      target_head_sha TEXT NOT NULL,
      task_head_sha TEXT,
      mode TEXT NOT NULL,
      integration_path TEXT,
      result_head_sha TEXT,
      state TEXT NOT NULL,
      local_sync_status TEXT,
      local_head_sha TEXT,
      local_worktree_path TEXT,
      conflict_files_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  for (const statement of [
    `ALTER TABLE task_integrations
            ADD COLUMN local_sync_status TEXT`,
    `ALTER TABLE task_integrations
            ADD COLUMN local_head_sha TEXT`,
    `ALTER TABLE task_integrations
            ADD COLUMN local_worktree_path TEXT`,
    `ALTER TABLE task_integrations
          ADD COLUMN task_head_sha TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；字段存在时保留当前数据。
    }
  }
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_integrations_task_state ON task_integrations(task_id, state, updated_at)`);
  db.execute(`DROP INDEX IF EXISTS idx_task_integrations_active_workspace_target`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_integrations_active_workspace_target ON task_integrations(workspace_id, target_branch) WHERE state IN ('preparing', 'conflicted', 'pending_local_sync')`);
  recordSchemaMigration(db, {
    migrationId: '20260731_0001_task_git_workspaces',
    description: '增加可跨会话复用的任务分支与 worktree 生命周期记录',
    checksumSource: 'task_workspaces,task_integrations,conversations.workspace_id,project_branch,worktree_path,task_state,integration_state',
  });
  recordSchemaMigration(db, {
    migrationId: '20260803_0002_task_integration_local_sync',
    description: '记录任务分支远端交付后的本地目标分支同步状态',
    checksumSource: 'task_integrations:local_sync_status,local_head_sha,local_worktree_path',
  });
  recordSchemaMigration(db, {
    migrationId: '20260807_0003_task_integration_task_head',
    description: '冻结任务分支合入候选使用的精确提交',
    checksumSource: 'task_integrations:task_head_sha',
  });
}

/**
 * 把单仓任务开发线扩展为任务环境聚合逐仓工作区。
 * 旧记录按一环境一工作区回填，避免升级后丢失既有会话和交付记录。
 */
function migrateMultiRepositoryTaskSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS project_repositories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      local_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_repositories_project_relative_path ON project_repositories(project_id, relative_path)`);
  db.execute(`DROP INDEX IF EXISTS idx_project_repositories_local_path`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_repositories_project_local_path ON project_repositories(project_id, local_path)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS project_shared_paths (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      local_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_shared_paths_project_relative_path ON project_shared_paths(project_id, relative_path)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS task_environments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      root_path TEXT,
      state TEXT NOT NULL DEFAULT 'ready',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_environments_task_state ON task_environments(task_id, state, updated_at)`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_environments_root_path ON task_environments(root_path) WHERE root_path IS NOT NULL`);

  for (const statement of [
    `ALTER TABLE task_workspaces ADD COLUMN environment_id TEXT`,
    `ALTER TABLE task_workspaces ADD COLUMN repository_id TEXT`,
    `ALTER TABLE task_workspaces ADD COLUMN repository_name TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE task_workspaces ADD COLUMN repository_relative_path TEXT NOT NULL DEFAULT '.'`,
    `ALTER TABLE task_workspaces ADD COLUMN repository_path TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE conversations ADD COLUMN environment_id TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；字段存在时保留当前数据。
    }
  }

  // 旧模型按项目限制分支名唯一；多仓项目允许不同仓库使用同名任务分支。
  db.execute(`DROP INDEX IF EXISTS idx_task_workspaces_project_branch`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_workspaces_repository_branch ON task_workspaces(repository_id, branch_name) WHERE repository_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_workspaces_environment_state ON task_workspaces(environment_id, state, updated_at)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_environment_updated_at ON conversations(environment_id, updated_at)`);

  db.execute(
    `INSERT OR IGNORE INTO task_environments (id, project_id, task_id, root_path, state, last_error, created_at, updated_at)
     SELECT 'task_environment_legacy_' || id,
            project_id,
            task_id,
            worktree_path,
            CASE WHEN state = 'failed' THEN 'failed' WHEN state = 'ready' THEN 'ready' ELSE 'reclaimed' END,
            last_error,
            created_at,
            updated_at
       FROM task_workspaces
      WHERE environment_id IS NULL`,
  );
  db.execute(
    `UPDATE task_workspaces
        SET environment_id = 'task_environment_legacy_' || id,
            repository_name = CASE WHEN repository_name = '' THEN '项目仓库' ELSE repository_name END,
            repository_path = CASE WHEN repository_path = '' THEN COALESCE((SELECT local_path FROM projects WHERE projects.id = task_workspaces.project_id), '') ELSE repository_path END
      WHERE environment_id IS NULL`,
  );
  db.execute(
    `UPDATE conversations
        SET environment_id = (SELECT environment_id FROM task_workspaces WHERE task_workspaces.id = conversations.workspace_id)
      WHERE environment_id IS NULL AND workspace_id IS NOT NULL`,
  );

  recordSchemaMigration(db, {
    migrationId: '20260803_0003_multi_repository_task_environments',
    description: '增加项目仓库、共享可写目录、任务环境与逐仓任务工作区',
    checksumSource: 'project_repositories,project_shared_paths,task_environments,task_workspaces.environment_id,repository_id,repository_relative_path,repository_path,conversations.environment_id',
  });
}

function createSchemaMigrationsLedger(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function recordSchemaMigration(
  db: ZeusDatabase,
  migration: {
    migrationId: string;
    description: string;
    checksumSource: string;
  },
): void {
  // migration 账本只记录结构版本，不写入项目/任务等业务假数据。
  const checksum = `sha256:${createHash('sha256').update(migration.checksumSource).digest('hex')}`;
  db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [migration.migrationId, migration.description, checksum, nowIso()]);
}

function migrateCodexNativeConversationSchema(db: ZeusDatabase): void {
  const needsCollaborationModeBackfill = !db.get<{
    migration_id: string;
  }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, ['20260722_0006_conversation_plan_actions']);
  for (const statement of [
    `ALTER TABLE conversations ADD COLUMN transport_kind TEXT NOT NULL DEFAULT 'legacy_cli'`,
    `ALTER TABLE conversations ADD COLUMN provider_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_thread_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_thread_path TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_model TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_state TEXT NOT NULL DEFAULT 'unbound'`,
    `ALTER TABLE conversations ADD COLUMN provider_protocol_version TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_binary_version TEXT`,
    `ALTER TABLE conversations ADD COLUMN legacy_source_conversation_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_settings_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE conversations ADD COLUMN provider_token_usage_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'read-only'`,
    `ALTER TABLE conversations ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE conversations ADD COLUMN next_turn_settings_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE conversations ADD COLUMN completion_unread INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；重复打开数据库时忽略已存在字段。
    }
  }

  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_provider_thread_id ON conversations(provider_thread_id) WHERE provider_thread_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_task_updated_at ON conversations(task_id, updated_at)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
      provider_turn_id TEXT, client_submission_id TEXT NOT NULL, status TEXT NOT NULL,
      error_json TEXT, plan_json TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  try {
    db.execute(`ALTER TABLE conversation_turns ADD COLUMN plan_json TEXT`);
  } catch {
    // 新库已在 CREATE TABLE 中包含该列；旧库只补一次。
  }
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turn_provider ON conversation_turns(provider_thread_id, provider_turn_id) WHERE provider_turn_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_turn_active ON conversation_turns(conversation_id, status, created_at, id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_items (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, provider_item_id TEXT NOT NULL,
      item_type TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, text_content TEXT NOT NULL,
      payload_json TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_item_provider ON conversation_items(provider_thread_id, provider_item_id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_resources (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, item_id TEXT NOT NULL, source_index INTEGER NOT NULL,
      canonical_target_digest TEXT NOT NULL, kind TEXT NOT NULL, presentation TEXT NOT NULL,
      display_json TEXT NOT NULL, target_json TEXT NOT NULL, authority_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_resource_source ON conversation_resources(item_id, source_index, canonical_target_digest)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_resources_conversation ON conversation_resources(conversation_id, turn_id, item_id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS turn_change_sets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, state TEXT NOT NULL,
      unified_diff TEXT NOT NULL, pre_image_digest TEXT, post_image_digest TEXT,
      conflict_json TEXT, unavailable_reason TEXT, journal_ref TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_change_set_turn ON turn_change_sets(conversation_id, turn_id)`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_change_set_provider_turn ON turn_change_sets(conversation_id, provider_turn_id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS turn_change_files (
      id TEXT PRIMARY KEY, change_set_id TEXT NOT NULL, source_item_id TEXT,
      source_index INTEGER NOT NULL, old_path TEXT, new_path TEXT, change_type TEXT NOT NULL,
      added_lines INTEGER NOT NULL DEFAULT 0, deleted_lines INTEGER NOT NULL DEFAULT 0,
      pre_hash TEXT, post_hash TEXT, pre_exists INTEGER NOT NULL DEFAULT 0,
      post_exists INTEGER NOT NULL DEFAULT 0, pre_mode INTEGER, post_mode INTEGER,
      unified_diff TEXT NOT NULL,
      pre_blob_ref TEXT, post_blob_ref TEXT, reversible INTEGER NOT NULL DEFAULT 0,
      unavailable_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  for (const statement of [
    `ALTER TABLE turn_change_files ADD COLUMN pre_exists INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE turn_change_files ADD COLUMN post_exists INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE turn_change_files ADD COLUMN pre_mode INTEGER`,
    `ALTER TABLE turn_change_files ADD COLUMN post_mode INTEGER`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // 新库已在 CREATE TABLE 中包含字段；旧库只补一次。
    }
  }
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_change_file_source ON turn_change_files(change_set_id, source_item_id, source_index)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_turn_change_files_set ON turn_change_files(change_set_id, source_index, id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_submissions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, client_message_id TEXT NOT NULL, kind TEXT NOT NULL,
      requested_delivery TEXT NOT NULL, status TEXT NOT NULL, queue_position INTEGER,
      input_json TEXT NOT NULL, target_provider_turn_id TEXT, provider_turn_id TEXT,
      paused_reason TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      dispatched_at TEXT, resolved_at TEXT
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_submission_idempotency ON conversation_submissions(conversation_id, idempotency_key)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_submission_created ON conversation_submissions(conversation_id, created_at, id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_submission_queue ON conversation_submissions(conversation_id, status, queue_position, created_at, id)`);
  if (needsCollaborationModeBackfill) backfillConversationCollaborationModes(db);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_server_requests (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT, item_id TEXT,
      transport_generation_id TEXT NOT NULL, provider_request_id_json TEXT NOT NULL,
      request_kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
      response_json TEXT, contains_secret INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_server_request_provider ON conversation_server_requests(transport_generation_id, provider_request_id_json)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_server_request_pending ON conversation_server_requests(conversation_id, status, created_at, id)`);
  try {
    db.execute(`ALTER TABLE conversation_server_requests ADD COLUMN auto_resolution_state TEXT NOT NULL DEFAULT 'none'`);
  } catch {
    // 新库已在迁移补列；旧库重复打开时忽略。
  }

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_plan_actions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      plan_item_id TEXT NOT NULL, status TEXT NOT NULL, submission_id TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_plan_action_item ON conversation_plan_actions(plan_item_id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_plan_action_pending ON conversation_plan_actions(conversation_id, status, created_at)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS idempotency_requests (
      scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      status TEXT NOT NULL, http_status INTEGER, response_json TEXT, resource_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, idempotency_key)
    )
  `);

  for (const statement of [
    `ALTER TABLE conversation_messages ADD COLUMN provider_thread_id TEXT`,
    `ALTER TABLE conversation_messages ADD COLUMN provider_turn_id TEXT`,
    `ALTER TABLE conversation_messages ADD COLUMN provider_item_id TEXT`,
    `ALTER TABLE conversation_messages ADD COLUMN client_message_id TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；重复打开数据库时忽略已存在字段。
    }
  }
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_provider_item ON conversation_messages(conversation_id, provider_item_id) WHERE provider_item_id IS NOT NULL`);

  recordSchemaMigration(db, {
    migrationId: '20260713_0002_codex_native_conversation',
    description: '增加 Codex native 会话运行表、唯一身份与本地幂等',
    checksumSource: 'codex_native_conversation:conversation_transport_provider,turns,items,submissions,server_requests,idempotency_requests,message_provider_identity,indexes,v1',
  });
  recordSchemaMigration(db, {
    migrationId: '20260715_0004_conversation_permission_mode',
    description: '增加 Codex native 会话权限模式事实源',
    checksumSource: 'conversations:permission_mode:read-only,auto,full-access:v1',
  });
  recordSchemaMigration(db, {
    migrationId: '20260721_0005_conversation_turn_plan',
    description: '增加 Codex native 轮次结构化计划快照',
    checksumSource: 'conversation_turns:plan_json:turn_plan_updated:v1',
  });
  recordSchemaMigration(db, {
    migrationId: '20260722_0006_conversation_plan_actions',
    description: '增加 PLAN 协作模式、计划实施请求和用户询问自动解决状态',
    checksumSource: 'conversations:collaboration_mode,conversation_plan_actions,conversation_server_requests:auto_resolution_state:v1',
  });
  recordSchemaMigration(db, {
    migrationId: '20260722_0007_conversation_completion_unread',
    description: '增加会话成功完成未读状态',
    checksumSource: 'conversations:completion_unread:successful_turn_completion,acknowledgement:v1',
  });
  recordSchemaMigration(db, {
    migrationId: '20260804_0001_conversation_next_turn_settings',
    description: '增加会话下一轮配置持久化',
    checksumSource: 'conversations:next_turn_settings_json:model,effort,service_tier,permission_mode,collaboration_mode',
  });
  recordSchemaMigration(db, {
    migrationId: '20260727_0008_conversation_resources_and_turn_change_sets',
    description: '增加会话资源与执行轮次变更集持久化',
    checksumSource: 'conversation_resources,turn_change_sets,turn_change_files:resource_authority,turn_patch_undo_reapply:v1',
  });
}

function migrateCodexUsageLedgerSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS codex_usage_ledger (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      account_scope_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      model TEXT NOT NULL,
      service_tier TEXT,
      total_tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      cache_write_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_output_tokens INTEGER NOT NULL,
      estimate_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider_id, provider_thread_id, provider_turn_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_usage_ledger_occurred ON codex_usage_ledger(occurred_at, id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_usage_ledger_project_occurred ON codex_usage_ledger(project_id, occurred_at, id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_usage_ledger_conversation_occurred ON codex_usage_ledger(conversation_id, occurred_at, id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_usage_ledger_model_occurred ON codex_usage_ledger(model, occurred_at, id)`);
  recordSchemaMigration(db, {
    migrationId: '20260810_0001_codex_usage_ledger',
    description: '增加与项目、会话生命周期独立的 Codex 逐轮用量账本',
    checksumSource: 'codex_usage_ledger:provider,account_scope,project,conversation,thread,turn,model,tier,token_breakdown,estimate,occurred_at',
  });
}

function migrateConversationStageSchema(db: ZeusDatabase): void {
  const migrationId = '20260807_0001_conversation_stage_updated_at';
  const alreadyMigrated = db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId]);
  for (const statement of [`ALTER TABLE conversations ADD COLUMN stage TEXT NOT NULL DEFAULT 'created'`, `ALTER TABLE conversations ADD COLUMN stage_updated_at TEXT NOT NULL DEFAULT ''`]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；字段存在时保持当前数据。
    }
  }
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_project_stage_updated_at ON conversations(project_id, stage_updated_at DESC, created_at DESC, id DESC)`);
  if (!alreadyMigrated) {
    for (const row of db.select<{ id: string; created_at: string }>(`SELECT id, created_at FROM conversations`)) {
      const projection = deriveConversationStageProjection(db, row.id);
      if (!projection) continue;
      db.execute(`UPDATE conversations SET stage = ?, stage_updated_at = ? WHERE id = ?`, [projection.stage, projection.evidenceAt || row.created_at, row.id]);
    }
  }
  recordSchemaMigration(db, {
    migrationId,
    description: '增加独立会话阶段与阶段更新时间，并从历史执行事实回填',
    checksumSource: 'conversations:stage,stage_updated_at:turns,submissions,requests,created_at:v1',
  });
}

function migrateAgentRuntimeSchema(db: ZeusDatabase): void {
  for (const statement of [
    `ALTER TABLE conversations ADD COLUMN agent_kind TEXT`,
    `ALTER TABLE conversations ADD COLUMN agent_transport TEXT`,
    `ALTER TABLE conversations ADD COLUMN model_source_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN model_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN native_session_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN native_session_path TEXT`,
    `ALTER TABLE conversations ADD COLUMN capability_snapshot_id TEXT`,
    `ALTER TABLE conversation_turns ADD COLUMN agent_kind TEXT`,
    `ALTER TABLE conversation_turns ADD COLUMN native_run_id TEXT`,
    `ALTER TABLE conversation_items ADD COLUMN agent_kind TEXT`,
    `ALTER TABLE conversation_items ADD COLUMN native_item_id TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；字段存在时保持当前数据。
    }
  }

  db.execute(`
    CREATE TABLE IF NOT EXISTS agent_capability_snapshots (
      id TEXT PRIMARY KEY,
      agent_kind TEXT NOT NULL,
      transport_kind TEXT NOT NULL,
      support_status TEXT NOT NULL,
      adapter_version TEXT,
      binary_version TEXT,
      protocol_version TEXT,
      capabilities_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      checked_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_agent_capability_snapshots_agent_checked ON agent_capability_snapshots(agent_kind, checked_at DESC)`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_agent_native_session ON conversations(agent_kind, native_session_id) WHERE agent_kind IS NOT NULL AND native_session_id IS NOT NULL`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turn_agent_native_run ON conversation_turns(agent_kind, provider_thread_id, native_run_id) WHERE agent_kind IS NOT NULL AND native_run_id IS NOT NULL`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_item_agent_native_item ON conversation_items(agent_kind, provider_thread_id, native_item_id) WHERE agent_kind IS NOT NULL AND native_item_id IS NOT NULL`);

  // 只回填有明确传输证据的 Codex 原生会话；历史 CLI 记录不猜测 Agent 或模型来源。
  db.execute(`UPDATE conversations SET
    agent_kind = COALESCE(agent_kind, 'codex'),
    agent_transport = COALESCE(agent_transport, 'app_server'),
    model_id = COALESCE(model_id, provider_model),
    native_session_id = COALESCE(native_session_id, provider_thread_id),
    native_session_path = COALESCE(native_session_path, provider_thread_path)
    WHERE transport_kind = 'codex_native'`);
  db.execute(`UPDATE conversation_turns SET
    agent_kind = COALESCE(agent_kind, 'codex'),
    native_run_id = COALESCE(native_run_id, provider_turn_id)
    WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_kind = 'codex')`);
  db.execute(`UPDATE conversation_items SET
    agent_kind = COALESCE(agent_kind, 'codex'),
    native_item_id = COALESCE(native_item_id, provider_item_id)
    WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_kind = 'codex')`);

  recordSchemaMigration(db, {
    migrationId: '20260803_0001_agent_runtime_framework',
    description: '增加多 Agent 身份、原生会话映射与能力证据快照',
    checksumSource: 'agent_runtime_framework:conversation_identity,turn_identity,item_identity,capability_snapshot,backfill_codex_native',
  });
}

function backfillConversationCollaborationModes(db: ZeusDatabase): void {
  for (const conversation of db.select<{ id: string }>(`SELECT id FROM conversations`)) {
    const latest = db.get<{
      input_json: string;
    }>(`SELECT input_json FROM conversation_submissions WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [conversation.id]);
    if (!latest) continue;
    try {
      const input = JSON.parse(latest.input_json) as { context?: { workMode?: unknown } };
      const mode = input.context?.workMode;
      if (mode === 'plan' || mode === 'default') db.execute(`UPDATE conversations SET collaboration_mode = ? WHERE id = ?`, [mode, conversation.id]);
    } catch {
      // 旧提交无法解析时保持列默认值 default，避免迁移失败阻断启动。
    }
  }
}

function migrateCodexLegacyImportSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS codex_legacy_imports (
      id TEXT PRIMARY KEY,
      provider_import_id TEXT,
      source_conversation_id TEXT NOT NULL,
      target_conversation_id TEXT,
      snapshot_path TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      target_thread_id TEXT,
      failure_stage TEXT,
      failure_message TEXT,
      provider_binary_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_legacy_import_source_snapshot ON codex_legacy_imports(source_conversation_id, snapshot_sha256)`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_legacy_import_target_thread ON codex_legacy_imports(target_thread_id) WHERE target_thread_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_legacy_import_provider_import ON codex_legacy_imports(provider_import_id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_legacy_import_status ON codex_legacy_imports(status, updated_at)`);
  recordSchemaMigration(db, {
    migrationId: '20260714_0003_codex_legacy_import',
    description: '增加 Codex legacy 会话导入快照映射、恢复状态与唯一身份',
    checksumSource: 'codex_legacy_imports:source_snapshot,target_thread,provider_import,status,v1',
  });
}

function migrateMcpServerIdentifierFalsePositiveCleanup(db: ZeusDatabase): void {
  const migrationId = '20260720_0005_mcp_server_identifier_false_positive_cleanup';
  if (
    db.get<{
      migration_id: string;
    }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])
  )
    return;

  const falsePositive = 'Secret-like provider field rejected: snapshot.openai-api-key-local-confirmation';
  db.transaction(() => {
    db.execute(`DELETE FROM conversation_items WHERE item_type = 'error' AND provider_item_id LIKE 'native-provider-event-error-%' AND text_content = ?`, [falsePositive]);

    const providerErrors = db.get<{
      value_json: string;
    }>(`SELECT value_json FROM settings WHERE key = 'codex.native.provider_event_errors'`);
    if (providerErrors) {
      try {
        const parsed = JSON.parse(providerErrors.value_json) as unknown;
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter((entry) => !(isPlainRecord(entry) && entry.method === 'mcpServer/startupStatus/updated' && isPlainRecord(entry.error) && entry.error.message === falsePositive));
          if (filtered.length !== parsed.length) {
            db.execute(`UPDATE settings SET value_json = ?, updated_at = ? WHERE key = 'codex.native.provider_event_errors'`, [JSON.stringify(filtered), nowIso()]);
          }
        }
      } catch {
        // 非法诊断 JSON 保持原样；本迁移只清理能够精确识别的历史误报。
      }
    }

    recordSchemaMigration(db, {
      migrationId,
      description: '清理 MCP 服务标识被误判为密钥字段所产生的历史错误项',
      checksumSource: 'mcp_server_identifier:false_positive:conversation_items,provider_event_errors:v1',
    });
  });
}

function migrateContextCompactionItemClassification(db: ZeusDatabase): void {
  const migrationId = '20260804_0001_context_compaction_item_classification';
  if (
    db.get<{
      migration_id: string;
    }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])
  )
    return;

  db.transaction(() => {
    const candidates = db.select<{ id: string; payload_json: string }>(`SELECT id, payload_json FROM conversation_items WHERE item_type = 'error'`);
    for (const candidate of candidates) {
      try {
        const payload = JSON.parse(candidate.payload_json) as unknown;
        if (isPlainRecord(payload) && payload.type === 'contextCompaction') {
          db.execute(`UPDATE conversation_items SET item_type = 'contextCompaction' WHERE id = ? AND item_type = 'error'`, [candidate.id]);
        }
      } catch {
        // 非法历史负载保持原样；本迁移只修正能够精确识别的上下文整理条目。
      }
    }

    recordSchemaMigration(db, {
      migrationId,
      description: '修正上下文整理条目被误分类为执行错误的历史记录',
      checksumSource: 'context_compaction:item_type:error_to_contextCompaction:20260804',
    });
  });
}

function backfillMissingTaskCodes(db: ZeusDatabase): void {
  const projectIds = db.select<{ project_id: string }>(`SELECT DISTINCT project_id FROM tasks WHERE deleted_at IS NULL ORDER BY project_id ASC`).map((row) => row.project_id);
  for (const projectId of projectIds) {
    const rows = db.select<{ id: string; task_sequence: number | null; task_code: string | null }>(`SELECT id, task_sequence, task_code FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`, [projectId]);
    const firstSequenceOwnerIds = new Map<number, string>();
    for (const row of rows) {
      const currentSequence = normalizeTaskSequence(row.task_sequence);
      if (currentSequence && !firstSequenceOwnerIds.has(currentSequence)) {
        firstSequenceOwnerIds.set(currentSequence, row.id);
      }
    }
    let nextSequence = 1;
    const usedSequences = new Set<number>();
    for (const row of rows) {
      // 预先保留每个合法序号的第一拥有者，避免空/非法行抢占后续合法任务编码。
      const currentSequence = normalizeTaskSequence(row.task_sequence);
      const isFirstSequenceOwner = currentSequence !== null && firstSequenceOwnerIds.get(currentSequence) === row.id;
      while (firstSequenceOwnerIds.has(nextSequence) || usedSequences.has(nextSequence)) nextSequence += 1;
      const sequence = isFirstSequenceOwner && currentSequence !== null ? currentSequence : nextSequence;
      usedSequences.add(sequence);
      nextSequence = Math.max(nextSequence, sequence + 1);
      const code = formatTaskCode(sequence);
      if (row.task_sequence !== sequence || row.task_code !== code) {
        db.execute(`UPDATE tasks SET task_sequence = ?, task_code = ? WHERE id = ?`, [sequence, code, row.id]);
      }
    }
  }
}

function clampPositiveInteger(value: number | undefined | null, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextIsoTimestamp(previousTimestamp: string): string {
  const now = Date.now();
  const previous = Date.parse(previousTimestamp);
  return new Date(Number.isFinite(previous) ? Math.max(now, previous + 1) : now).toISOString();
}

function slugifyProjectName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/(^-|-$)/gu, '');
  return slug || `project-${nanoid(8)}`;
}

function normalizeProjectLocalPath(localPath: string): string {
  const trimmed = localPath.trim();
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/u, '');
}

function dedupeProjectsByLocalPath(projects: ZeusProjectRecord[]): ZeusProjectRecord[] {
  const seen = new Set<string>();
  const deduped: ZeusProjectRecord[] = [];
  for (const project of projects) {
    const localPathKey = normalizeProjectLocalPath(project.localPath);
    if (seen.has(localPathKey)) {
      continue;
    }
    seen.add(localPathKey);
    deduped.push(project);
  }
  return deduped;
}

function renderPromptTemplate(promptTemplate: string, variables: Record<string, string>): string {
  return promptTemplate.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (match, key: string) => variables[key] ?? match);
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function formatTaskCode(sequence: number): string {
  return `ZEUS-${String(sequence).padStart(4, '0')}`;
}

function normalizeTaskSequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeTaskCode(value: unknown, sequence: number | null): string {
  if (typeof value === 'string') {
    const code = value.trim();
    // 只保留至少四位的统一格式；旧库编码由回填逻辑按原序号重新格式化。
    if (/^ZEUS-\d{4,}$/u.test(code)) return code;
  }
  return formatTaskCode(sequence ?? 1);
}

function parseTagsJson(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    return Array.isArray(parsed) ? normalizeTags(parsed.filter((tag): tag is string => typeof tag === 'string')) : [];
  } catch {
    return [];
  }
}

function parseTaskSourceContextJson(sourceContextJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(sourceContextJson) as unknown;
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function countTaskAttachmentReferences(sourceContext: Record<string, unknown>): number {
  return Array.isArray(sourceContext.attachments) ? sourceContext.attachments.length : 0;
}

function throwTaskEditConflict(taskId: string, currentUpdatedAt: string): never {
  throw Object.assign(new Error(`Zeus task changed after editing started: ${taskId}`), {
    code: 'ZEUS_TASK_EDIT_CONFLICT' as const,
    currentUpdatedAt,
  });
}

function filterAndSortTasks(records: ZeusTaskRecord[], options: TaskListOptions): ZeusTaskRecord[] {
  const query = options.query?.trim().toLowerCase();
  const tag = options.tag?.trim();
  const filtered = records.filter((record) => {
    const matchesQuery =
      !query ||
      [
        record.taskCode,
        record.id,
        record.title,
        record.taskType,
        record.description,
        record.defectCurrentState,
        record.defectExpectedOutcome,
        record.defectReproductionSteps,
        record.optimizationCurrentState,
        record.optimizationExpectedOutcome,
        record.createdFrom,
        record.sourceContextJson,
        record.priority,
      ]
        .join('\n')
        .toLowerCase()
        .includes(query);
    const matchesStatus = !options.status || record.status === options.status;
    const matchesManagementStatus = !options.managementStatus || record.managementStatus === options.managementStatus;
    const matchesTag = !tag || record.tags.includes(tag);
    return matchesQuery && matchesStatus && matchesManagementStatus && matchesTag;
  });
  const sortBy = options.sortBy ?? 'createdAt';
  const direction = options.sortDirection === 'desc' ? -1 : 1;
  return [...filtered].sort((left, right) => {
    const leftValue = String(left[sortBy]);
    const rightValue = String(right[sortBy]);
    return leftValue.localeCompare(rightValue) * direction;
  });
}

export interface ProviderEventReceiptInput {
  identity: string;
  generationId: string;
  sequence: number;
  method: string;
  threadId?: string | null;
  providerTurnId?: string | null;
  providerItemId?: string | null;
  requestId?: string | null;
  receivedAt: string;
}

/** Provider 回执和业务投影共用 ZeusDatabase 的待持久事务，避免去重状态与业务状态分裂。 */
export class ProviderEventReceiptRepository {
  constructor(private readonly db: ZeusDatabase) {}

  has(identity: string): boolean {
    return Boolean(this.db.get<{ identity: string }>(`SELECT identity FROM provider_event_receipts WHERE identity = ?`, [identity]));
  }

  record(input: ProviderEventReceiptInput): void {
    this.db.execute(
      `INSERT INTO provider_event_receipts
         (identity, generation_id, sequence, method, thread_id, provider_turn_id, provider_item_id, request_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity) DO NOTHING`,
      [input.identity, input.generationId, input.sequence, input.method, input.threadId ?? '', input.providerTurnId ?? '', input.providerItemId ?? '', input.requestId ?? '', input.receivedAt],
    );
  }

  listGenerationIds(): string[] {
    return this.db.select<{ generation_id: string }>(`SELECT DISTINCT generation_id FROM provider_event_receipts`).map((row) => row.generation_id);
  }

  deleteGenerations(generationIds: readonly string[]): void {
    if (generationIds.length === 0) return;
    const placeholders = generationIds.map(() => '?').join(', ');
    this.db.execute(`DELETE FROM provider_event_receipts WHERE generation_id IN (${placeholders})`, [...generationIds]);
  }
}

/** 设置仓储保存本机偏好与通知策略，不存储 token、密码等敏感明文。 */
export class SettingRepository {
  constructor(private readonly db: ZeusDatabase) {}

  getJson<T>(key: string): T | undefined {
    const row = this.db.get<DbSettingRow>(`SELECT key, value_json, updated_at FROM settings WHERE key = ?`, [key]);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return undefined;
    }
  }

  setJson(key: string, value: unknown): ZeusSettingRecord {
    const record: ZeusSettingRecord = {
      key,
      valueJson: JSON.stringify(value),
      updatedAt: nowIso(),
    };
    this.db.execute(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [record.key, record.valueJson, record.updatedAt],
    );
    return record;
  }

  upsertCodexRateLimitsSnapshot(snapshot: CodexRateLimitsSnapshot): CodexRateLimitsSnapshot | undefined {
    return this.upsertSequencedSnapshot('codex.native.rate_limits', snapshot);
  }

  getCodexRateLimitsSnapshot(): CodexRateLimitsSnapshot | undefined {
    return this.getJson<CodexRateLimitsSnapshot>('codex.native.rate_limits');
  }

  upsertCodexMcpStartupStatusSnapshot(snapshot: CodexMcpStartupStatusSnapshot): CodexMcpStartupStatusSnapshot | undefined {
    return this.upsertSequencedSnapshot('codex.native.mcp_startup_status', snapshot);
  }

  getCodexMcpStartupStatusSnapshot(): CodexMcpStartupStatusSnapshot | undefined {
    return this.getJson<CodexMcpStartupStatusSnapshot>('codex.native.mcp_startup_status');
  }

  private upsertSequencedSnapshot<T extends CodexRateLimitsSnapshot | CodexMcpStartupStatusSnapshot>(key: 'codex.native.rate_limits' | 'codex.native.mcp_startup_status', snapshot: T): T | undefined {
    if (key === 'codex.native.rate_limits') validateRateLimitsSnapshot(snapshot);
    else validateMcpStartupStatusSnapshot(snapshot);
    const current = this.getJson<T>(key);
    if (!shouldAcceptProviderSnapshot(this.db, snapshot, current)) return current;
    this.setJson(key, snapshot);
    return snapshot;
  }
}

/** 项目仓储只保存用户明确创建的真实本地路径记录。 */
export class ProjectRepository {
  constructor(private readonly db: ZeusDatabase) {}

  /**
   * 创建项目时以规范化后的本地路径作为唯一事实源；同一路径重复创建直接返回已有项目。
   */
  create(input: CreateProjectInput): ZeusProjectRecord {
    const localPath = normalizeProjectLocalPath(input.localPath);
    const existing = this.findByLocalPath(localPath);
    if (existing) {
      return existing;
    }
    const timestamp = nowIso();
    const record: ZeusProjectRecord = {
      id: `project_${nanoid(12)}`,
      name: input.name,
      slug: `${slugifyProjectName(input.name)}-${nanoid(6)}`,
      localPath,
      description: input.description ?? null,
      note: input.note ?? null,
      defaultTemplateId: null,
      scanStatus: 'not_scanned',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO projects (id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.name, record.slug, record.localPath, record.description, record.note, record.defaultTemplateId, record.scanStatus, record.createdAt, record.updatedAt],
    );
    return record;
  }

  list(): ZeusProjectRecord[] {
    return this.search();
  }

  search(options: ProjectSearchOptions = {}): ZeusProjectRecord[] {
    const query = options.query?.trim().toLowerCase();
    const projects = this.db
      .select<DbProjectRow>(
        `SELECT id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at
       FROM projects WHERE archived = 0 AND deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .map(mapProjectRow)
      .filter((project) => {
        if (!query) return true;
        return `${project.name}\n${project.localPath}\n${project.description ?? ''}\n${project.note ?? ''}`.toLowerCase().includes(query);
      });
    return dedupeProjectsByLocalPath(projects);
  }

  getById(projectId: string): ZeusProjectRecord | undefined {
    const row = this.db.get<DbProjectRow>(
      `SELECT id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at
       FROM projects WHERE id = ? AND deleted_at IS NULL`,
      [projectId],
    );
    return row ? mapProjectRow(row) : undefined;
  }

  update(projectId: string, input: UpdateProjectInput): ZeusProjectRecord {
    const existing = this.getById(projectId);
    if (!existing) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    const localPath = input.localPath === undefined ? existing.localPath : normalizeProjectLocalPath(input.localPath);
    // 只有真实修改本地路径时才执行唯一性校验；显示名称等元数据更新不应被历史重复路径数据阻断。
    if (input.localPath !== undefined && localPath !== existing.localPath) {
      const duplicated = this.findByLocalPath(localPath, projectId);
      if (duplicated) {
        throw new Error(`Zeus project localPath already exists: ${localPath}`);
      }
    }
    const timestamp = nowIso();
    this.db.execute(`UPDATE projects SET name = ?, local_path = ?, description = ?, note = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [
      input.name ?? existing.name,
      localPath,
      input.description === undefined ? existing.description : input.description,
      input.note === undefined ? existing.note : input.note,
      timestamp,
      projectId,
    ]);
    const updated = this.getById(projectId);
    if (!updated) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return updated;
  }

  /**
   * 按规范化路径查找未删除项目，包含归档项目，保证归档态也不会被重复创建绕过。
   */
  private findByLocalPath(localPath: string, excludeProjectId?: string): ZeusProjectRecord | undefined {
    return this.db
      .select<DbProjectRow>(
        `SELECT id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at
       FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .map(mapProjectRow)
      .find((project) => project.id !== excludeProjectId && normalizeProjectLocalPath(project.localPath) === localPath);
  }

  updateScanStatus(projectId: string, scanStatus: ZeusProjectRecord['scanStatus']): ZeusProjectRecord {
    const timestamp = nowIso();
    // 扫描状态只记录真实扫描生命周期，不提前写入 completed，避免 UI 误判图谱已可用。
    this.db.execute(`UPDATE projects SET scan_status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [scanStatus, timestamp, projectId]);
    const updated = this.getById(projectId);
    if (!updated) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return updated;
  }

  recoverInterruptedScans(activeProjectIds: readonly string[] = []): number {
    const timestamp = nowIso();
    const activeIds = activeProjectIds.filter((id) => typeof id === 'string' && id.length > 0);
    const activeFilter = activeIds.length > 0 ? ` AND id NOT IN (${activeIds.map(() => '?').join(', ')})` : '';
    const interrupted = this.db.select<{ id: string }>(`SELECT id FROM projects WHERE scan_status = 'scanning' AND deleted_at IS NULL${activeFilter}`, activeIds);
    if (interrupted.length === 0) return 0;
    // 扫描是进程内任务；无本进程所有权的 scanning 只能来自上次异常退出或旧版本崩溃残留，恢复为 failed 让用户可以重试。
    this.db.execute(`UPDATE projects SET scan_status = 'failed', updated_at = ? WHERE scan_status = 'scanning' AND deleted_at IS NULL${activeFilter}`, [timestamp, ...activeIds]);
    return interrupted.length;
  }

  prepareArchive(projectId: string): ProjectArchiveConfirmation {
    const existing = this.getById(projectId);
    if (!existing) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return {
      projectId,
      confirmationText: `确认归档项目 ${existing.name}`,
      riskLevel: 'medium',
    };
  }

  delete(projectId: string): ZeusProjectRecord {
    const existing = this.getById(projectId);
    if (!existing) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    const timestamp = nowIso();
    // 删除采用软删除，保留审计链路和关联任务来源，避免误删真实项目历史。
    this.db.execute(`UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, timestamp, projectId]);
    return existing;
  }

  setDefaultTemplate(projectId: string, templateId: string | null): ZeusProjectRecord {
    const timestamp = nowIso();
    // 项目默认模板只保存模板引用，不创建任务，避免引入任何 seed/mock 业务记录。
    this.db.execute(`UPDATE projects SET default_template_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [templateId, timestamp, projectId]);
    const updated = this.getById(projectId);
    if (!updated) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return updated;
  }

  archive(projectId: string): ZeusProjectRecord {
    const timestamp = nowIso();
    this.db.execute(`UPDATE projects SET archived = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, projectId]);
    const archived = this.getById(projectId);
    if (!archived) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return archived;
  }

  restore(projectId: string): ZeusProjectRecord {
    const timestamp = nowIso();
    this.db.execute(`UPDATE projects SET archived = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, projectId]);
    const restored = this.getById(projectId);
    if (!restored) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return restored;
  }

  listArchived(): ZeusProjectRecord[] {
    return this.db
      .select<DbProjectRow>(
        `SELECT id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at
       FROM projects WHERE archived = 1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
      )
      .map(mapProjectRow);
  }
}

const selectTaskFields = `id, project_id, task_code, task_sequence, parent_task_id, title, task_type, description,
  defect_current_state, defect_expected_outcome, defect_reproduction_steps, optimization_current_state, optimization_expected_outcome,
  management_status, status, priority, tags_json, template_id,
  allow_code_changes, allow_tests, allow_git_commit, created_from, source_context_json, created_at, updated_at`;

/** 任务仓储保存真实任务定义，初始状态统一为 ready，等待用户或 runtime 执行。 */
export class TaskRepository {
  constructor(private readonly db: ZeusDatabase) {}

  private nextTaskSequence(projectId: string): number {
    // 任务编码按项目内未删除任务的最大序号递增，保持与当前列表/回填口径一致。
    const row = this.db.get<{ sequence: number | null }>(`SELECT MAX(task_sequence) AS sequence FROM tasks WHERE project_id = ? AND deleted_at IS NULL`, [projectId]);
    return (row?.sequence ?? 0) + 1;
  }

  create(input: CreateTaskInput): ZeusTaskRecord {
    return this.db.transaction(() => {
      const timestamp = nowIso();
      const taskSequence = this.nextTaskSequence(input.projectId);
      const parentTaskId = input.parentTaskId ?? null;
      if (parentTaskId) this.assertValidParent(input.projectId, '__new_task__', parentTaskId, 1);
      const record: ZeusTaskRecord = {
        id: `task_${nanoid(12)}`,
        projectId: input.projectId,
        taskCode: formatTaskCode(taskSequence),
        taskSequence,
        parentTaskId,
        relatedTaskIds: [],
        title: input.title,
        taskType: input.taskType,
        description: input.description,
        defectCurrentState: input.defectCurrentState ?? '',
        defectExpectedOutcome: input.defectExpectedOutcome ?? '',
        defectReproductionSteps: input.defectReproductionSteps ?? '',
        optimizationCurrentState: input.optimizationCurrentState ?? '',
        optimizationExpectedOutcome: input.optimizationExpectedOutcome ?? '',
        managementStatus: isTaskManagementStatus(input.managementStatus) ? input.managementStatus : 'todo',
        status: 'ready',
        priority: input.priority ?? 'p3',
        allowCodeChanges: input.allowCodeChanges === true,
        allowTests: input.allowTests === true,
        allowGitCommit: input.allowGitCommit === true,
        templateId: input.templateId ?? null,
        tags: normalizeTags(input.tags ?? []),
        createdFrom: input.createdFrom,
        sourceContextJson: JSON.stringify(input.sourceContext),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.db.execute(
        `INSERT INTO tasks (id, project_id, task_code, task_sequence, parent_task_id, title, task_type, description,
        defect_current_state, defect_expected_outcome, defect_reproduction_steps, optimization_current_state, optimization_expected_outcome,
        management_status, status, priority, tags_json, template_id,
        allow_code_changes, allow_tests, allow_git_commit, created_from, source_context_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.projectId,
          record.taskCode,
          record.taskSequence,
          record.parentTaskId,
          record.title,
          record.taskType,
          record.description,
          record.defectCurrentState,
          record.defectExpectedOutcome,
          record.defectReproductionSteps,
          record.optimizationCurrentState,
          record.optimizationExpectedOutcome,
          record.managementStatus,
          record.status,
          record.priority,
          JSON.stringify(record.tags),
          record.templateId,
          record.allowCodeChanges ? 1 : 0,
          record.allowTests ? 1 : 0,
          record.allowGitCommit ? 1 : 0,
          record.createdFrom,
          record.sourceContextJson,
          record.createdAt,
          record.updatedAt,
        ],
      );
      return record;
    });
  }

  createFromTemplate(input: CreateTaskFromTemplateInput): ZeusTaskRecord {
    const variables = input.variables ?? {};
    const description = renderPromptTemplate(input.template.promptTemplate, variables);
    return this.create({
      projectId: input.projectId,
      title: input.title ?? input.template.name,
      taskType: 'requirement',
      description,
      managementStatus: input.managementStatus,
      createdFrom: 'template',
      templateId: input.template.id,
      sourceContext: {
        type: 'task_template',
        templateId: input.template.id,
        templateName: input.template.name,
        variables,
      },
    });
  }

  getById(taskId: string): ZeusTaskRecord | undefined {
    const row = this.db.get<DbTaskRow>(
      `SELECT ${selectTaskFields}
       FROM tasks WHERE id = ? AND deleted_at IS NULL`,
      [taskId],
    );
    return row ? this.withRelatedTaskIds(mapTaskRow(row)) : undefined;
  }

  archive(taskId: string): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, taskId]);
    const archived = this.getById(taskId);
    if (!archived) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return archived;
  }

  restore(taskId: string): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    // 恢复只切换归档标记，保留任务状态与时间线来源，避免丢失真实执行上下文。
    this.db.execute(`UPDATE tasks SET archived = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, taskId]);
    const restored = this.getById(taskId);
    if (!restored) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return restored;
  }

  updateStatus(taskId: string, status: ZeusTaskRecord['status']): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [status, timestamp, taskId]);
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  updateManagementStatus(taskId: string, managementStatus: TaskManagementStatus, expectedUpdatedAt?: string): ZeusTaskRecord {
    if (!isTaskManagementStatus(managementStatus)) throw new Error(`Unknown Zeus task management status: ${String(managementStatus)}`);
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
    if (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) throwTaskEditConflict(taskId, existing.updatedAt);
    if (existing.managementStatus === managementStatus) return existing;
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE tasks SET management_status = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`, [managementStatus, timestamp, taskId, expectedUpdatedAt ?? existing.updatedAt]);
    const modifiedRows = this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0;
    if (modifiedRows !== 1) {
      const current = this.getById(taskId);
      throwTaskEditConflict(taskId, current?.updatedAt ?? existing.updatedAt);
    }
    const updated = this.getById(taskId);
    if (!updated) throw new Error(`Zeus task not found: ${taskId}`);
    return updated;
  }

  replaceManagementStatusForProject(projectId: string, fromStatus: TaskManagementStatus, toStatus: TaskManagementStatus): ZeusTaskRecord[] {
    if (!isTaskManagementStatus(fromStatus) || !isTaskManagementStatus(toStatus)) throw new Error('Unknown Zeus task management status replacement.');
    if (fromStatus === toStatus) return [];
    return this.db.transaction(() => {
      const taskIds = this.db.select<{ id: string }>(`SELECT id FROM tasks WHERE project_id = ? AND management_status = ? AND deleted_at IS NULL ORDER BY created_at ASC`, [projectId, fromStatus]).map((row) => row.id);
      return taskIds.map((taskId) => this.updateManagementStatus(taskId, toStatus));
    });
  }

  update(taskId: string, input: UpdateTaskInput): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    this.db.execute(
      `UPDATE tasks SET title = ?, task_type = ?, description = ?, defect_current_state = ?, defect_expected_outcome = ?, defect_reproduction_steps = ?, optimization_current_state = ?, optimization_expected_outcome = ?, allow_code_changes = ?, allow_tests = ?, allow_git_commit = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
      [
        input.title ?? existing.title,
        input.taskType ?? existing.taskType,
        input.description ?? existing.description,
        input.defectCurrentState ?? existing.defectCurrentState,
        input.defectExpectedOutcome ?? existing.defectExpectedOutcome,
        input.defectReproductionSteps ?? existing.defectReproductionSteps,
        input.optimizationCurrentState ?? existing.optimizationCurrentState,
        input.optimizationExpectedOutcome ?? existing.optimizationExpectedOutcome,
        (input.allowCodeChanges ?? existing.allowCodeChanges) ? 1 : 0,
        (input.allowTests ?? existing.allowTests) ? 1 : 0,
        (input.allowGitCommit ?? existing.allowGitCommit) ? 1 : 0,
        timestamp,
        taskId,
      ],
    );
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  updateContent(taskId: string, input: UpdateTaskContentInput): UpdateTaskContentResult {
    return this.db.transaction(() => {
      const existing = this.getById(taskId);
      if (!existing) {
        throw new Error(`Zeus task not found: ${taskId}`);
      }
      if (existing.updatedAt !== input.expectedUpdatedAt) {
        throwTaskEditConflict(taskId, existing.updatedAt);
      }

      const title = input.title === undefined ? existing.title : input.title.trim();
      if (!title) {
        throw Object.assign(new Error('Task title is required.'), { code: 'ZEUS_TASK_TITLE_REQUIRED' as const });
      }
      const taskType = input.taskType ?? existing.taskType;
      if (!isTaskType(taskType)) {
        throw Object.assign(new Error('Task type is required.'), { code: 'ZEUS_INVALID_TASK_TYPE' as const });
      }
      const description = input.description ?? existing.description;
      const defectCurrentState = input.defectCurrentState ?? existing.defectCurrentState;
      const defectExpectedOutcome = input.defectExpectedOutcome ?? existing.defectExpectedOutcome;
      const defectReproductionSteps = input.defectReproductionSteps ?? existing.defectReproductionSteps;
      const optimizationCurrentState = input.optimizationCurrentState ?? existing.optimizationCurrentState;
      const optimizationExpectedOutcome = input.optimizationExpectedOutcome ?? existing.optimizationExpectedOutcome;
      const priority = input.priority ?? existing.priority;
      const tags = input.tags === undefined ? existing.tags : normalizeTags(input.tags);
      const allowCodeChanges = input.allowCodeChanges ?? existing.allowCodeChanges;
      const allowTests = input.allowTests ?? existing.allowTests;
      const allowGitCommit = input.allowGitCommit ?? existing.allowGitCommit;
      const previousSourceContext = parseTaskSourceContextJson(existing.sourceContextJson);
      const sourceContext = input.sourceContext ? { ...input.sourceContext } : input.attachments ? { ...previousSourceContext, attachments: input.attachments } : previousSourceContext;
      const sourceContextJson = JSON.stringify(sourceContext);
      const changedFields: TaskEditableField[] = [];
      if (title !== existing.title) changedFields.push('title');
      if (taskType !== existing.taskType) changedFields.push('taskType');
      if (description !== existing.description) changedFields.push('description');
      if (defectCurrentState !== existing.defectCurrentState) changedFields.push('defectCurrentState');
      if (defectExpectedOutcome !== existing.defectExpectedOutcome) changedFields.push('defectExpectedOutcome');
      if (defectReproductionSteps !== existing.defectReproductionSteps) changedFields.push('defectReproductionSteps');
      if (optimizationCurrentState !== existing.optimizationCurrentState) changedFields.push('optimizationCurrentState');
      if (optimizationExpectedOutcome !== existing.optimizationExpectedOutcome) changedFields.push('optimizationExpectedOutcome');
      if (priority !== existing.priority) changedFields.push('priority');
      if (canonicalJson(tags) !== canonicalJson(existing.tags)) changedFields.push('tags');
      if (input.attachments !== undefined && canonicalJson(sourceContext.attachments) !== canonicalJson(previousSourceContext.attachments)) changedFields.push('attachments');
      else if (input.sourceContext !== undefined && canonicalJson(sourceContext) !== canonicalJson(previousSourceContext)) changedFields.push('sourceContext');
      if (allowCodeChanges !== existing.allowCodeChanges) changedFields.push('allowCodeChanges');
      if (allowTests !== existing.allowTests) changedFields.push('allowTests');
      if (allowGitCommit !== existing.allowGitCommit) changedFields.push('allowGitCommit');

      const resultBase = {
        tagCountBefore: existing.tags.length,
        tagCountAfter: tags.length,
        attachmentCountBefore: countTaskAttachmentReferences(previousSourceContext),
        attachmentCountAfter: countTaskAttachmentReferences(sourceContext),
        previousUpdatedAt: existing.updatedAt,
      };
      if (changedFields.length === 0) {
        return { task: existing, changedFields, ...resultBase };
      }

      const timestamp = nextIsoTimestamp(existing.updatedAt);
      this.db.execute(
        `UPDATE tasks
         SET title = ?, task_type = ?, description = ?, defect_current_state = ?, defect_expected_outcome = ?, defect_reproduction_steps = ?,
             optimization_current_state = ?, optimization_expected_outcome = ?, priority = ?, tags_json = ?, source_context_json = ?,
             allow_code_changes = ?, allow_tests = ?, allow_git_commit = ?, updated_at = ?
         WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
        [
          title,
          taskType,
          description,
          defectCurrentState,
          defectExpectedOutcome,
          defectReproductionSteps,
          optimizationCurrentState,
          optimizationExpectedOutcome,
          priority,
          JSON.stringify(tags),
          sourceContextJson,
          allowCodeChanges ? 1 : 0,
          allowTests ? 1 : 0,
          allowGitCommit ? 1 : 0,
          timestamp,
          taskId,
          input.expectedUpdatedAt,
        ],
      );
      const modifiedRows = this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0;
      if (modifiedRows !== 1) {
        const current = this.getById(taskId);
        throwTaskEditConflict(taskId, current?.updatedAt ?? existing.updatedAt);
      }
      const updated = this.getById(taskId);
      if (!updated) {
        throw new Error(`Zeus task not found after update: ${taskId}`);
      }
      return { task: updated, changedFields, ...resultBase };
    });
  }

  updateSourceContext(taskId: string, sourceContext: Record<string, unknown>): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    // 图谱关联会持续补充任务来源上下文，单独更新 source_context_json，避免误改标题、描述和状态。
    this.db.execute(`UPDATE tasks SET source_context_json = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [JSON.stringify(sourceContext), timestamp, taskId]);
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  updateTags(taskId: string, tags: string[]): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE tasks SET tags_json = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [JSON.stringify(normalizeTags(tags)), timestamp, taskId]);
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  updateRelationships(taskId: string, input: UpdateTaskRelationshipsInput): ZeusTaskRecord {
    return this.db.transaction(() => {
      const existing = this.getById(taskId);
      if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
      if (existing.updatedAt !== input.expectedUpdatedAt) throwTaskEditConflict(taskId, existing.updatedAt);
      const parentTaskId = input.parentTaskId === undefined ? existing.parentTaskId : input.parentTaskId;
      const relatedTaskIds = input.relatedTaskIds === undefined ? existing.relatedTaskIds : [...new Set(input.relatedTaskIds)];
      this.assertValidParent(existing.projectId, taskId, parentTaskId, this.subtreeHeight(taskId));
      this.assertValidRelatedTasks(existing, relatedTaskIds);
      if (parentTaskId === existing.parentTaskId && canonicalJson(relatedTaskIds.slice().sort()) === canonicalJson(existing.relatedTaskIds.slice().sort())) return existing;
      const timestamp = nextIsoTimestamp(existing.updatedAt);
      this.db.execute(`UPDATE tasks SET parent_task_id = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`, [parentTaskId, timestamp, taskId, input.expectedUpdatedAt]);
      const modifiedRows = this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0;
      if (modifiedRows !== 1) throwTaskEditConflict(taskId, this.getById(taskId)?.updatedAt ?? existing.updatedAt);
      if (input.relatedTaskIds !== undefined) {
        this.db.execute(`DELETE FROM task_relations WHERE left_task_id = ? OR right_task_id = ?`, [taskId, taskId]);
        for (const relatedTaskId of relatedTaskIds) {
          const [leftTaskId, rightTaskId] = [taskId, relatedTaskId].sort();
          this.db.execute(`INSERT INTO task_relations (left_task_id, right_task_id, created_at) VALUES (?, ?, ?)`, [leftTaskId, rightTaskId, timestamp]);
        }
      }
      const updated = this.getById(taskId);
      if (!updated) throw new Error(`Zeus task not found after relationship update: ${taskId}`);
      return updated;
    });
  }

  delete(taskId: string, input: DeleteTaskInput = {}): DeleteTaskResult {
    return this.db.transaction(() => {
      if (input.childStrategy && !['reparent', 'delete_descendants', 'make_roots'].includes(input.childStrategy)) {
        throw Object.assign(new Error('Unknown child handling strategy.'), { code: 'ZEUS_TASK_DELETE_STRATEGY_INVALID' as const });
      }
      const existing = this.getById(taskId);
      if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
      const directChildren = this.listDirectChildren(taskId);
      if (directChildren.length > 0 && !input.childStrategy) {
        throw Object.assign(new Error('Deleting this task requires a child handling strategy.'), {
          code: 'ZEUS_TASK_DELETE_RELATIONSHIP_CONFIRMATION_REQUIRED' as const,
          childCount: directChildren.length,
          descendantCount: this.listDescendantIds(taskId).length,
        });
      }
      const timestamp = nextIsoTimestamp(existing.updatedAt);
      let deletedTaskIds = [taskId];
      let movedChildTaskIds: string[] = [];
      if (directChildren.length > 0 && input.childStrategy === 'reparent') {
        const replacementParentTaskId = input.replacementParentTaskId?.trim();
        if (!replacementParentTaskId) throw Object.assign(new Error('A replacement parent task is required.'), { code: 'ZEUS_TASK_REPLACEMENT_PARENT_REQUIRED' as const });
        const descendantIds = new Set(this.listDescendantIds(taskId));
        if (descendantIds.has(replacementParentTaskId)) throw Object.assign(new Error('The replacement parent cannot be inside the deleted task branch.'), { code: 'ZEUS_TASK_PARENT_CYCLE' as const });
        for (const child of directChildren) this.assertValidParent(existing.projectId, child.id, replacementParentTaskId, this.subtreeHeight(child.id));
        for (const child of directChildren) {
          this.db.execute(`UPDATE tasks SET parent_task_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [replacementParentTaskId, nextIsoTimestamp(child.updatedAt), child.id]);
        }
        movedChildTaskIds = directChildren.map((task) => task.id);
      } else if (directChildren.length > 0 && input.childStrategy === 'make_roots') {
        for (const child of directChildren) {
          this.db.execute(`UPDATE tasks SET parent_task_id = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [nextIsoTimestamp(child.updatedAt), child.id]);
        }
        movedChildTaskIds = directChildren.map((task) => task.id);
      } else if (input.childStrategy === 'delete_descendants') {
        deletedTaskIds = [taskId, ...this.listDescendantIds(taskId)];
      }
      for (const deletedTaskId of deletedTaskIds) {
        this.db.execute(`DELETE FROM task_relations WHERE left_task_id = ? OR right_task_id = ?`, [deletedTaskId, deletedTaskId]);
        this.db.execute(`UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, timestamp, deletedTaskId]);
      }
      return { task: existing, deletedTaskIds, movedChildTaskIds };
    });
  }

  listAll(options: TaskListOptions = {}): ZeusTaskRecord[] {
    const records = this.db
      .select<DbTaskRow>(
        `SELECT ${selectTaskFields}
       FROM tasks WHERE archived = 0 AND deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .map(mapTaskRow);
    this.attachRelatedTaskIds(records);
    return filterAndSortTasks(records, options);
  }

  listByProject(projectId: string, options: TaskListOptions = {}): ZeusTaskRecord[] {
    const records = this.db
      .select<DbTaskRow>(
        `SELECT ${selectTaskFields}
       FROM tasks WHERE project_id = ? AND archived = 0 AND deleted_at IS NULL ORDER BY created_at ASC`,
        [projectId],
      )
      .map(mapTaskRow);
    this.attachRelatedTaskIds(records);
    return filterAndSortTasks(records, options);
  }

  listArchivedByProject(projectId: string, options: TaskListOptions = {}): ZeusTaskRecord[] {
    const records = this.db
      .select<DbTaskRow>(
        `SELECT ${selectTaskFields}
       FROM tasks WHERE project_id = ? AND archived = 1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
        [projectId],
      )
      .map(mapTaskRow);
    this.attachRelatedTaskIds(records);
    return filterAndSortTasks(records, options);
  }

  private listDirectChildren(taskId: string): ZeusTaskRecord[] {
    const rows = this.db.select<DbTaskRow>(`SELECT ${selectTaskFields} FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`, [taskId]).map(mapTaskRow);
    this.attachRelatedTaskIds(rows);
    return rows;
  }

  private listDescendantIds(taskId: string): string[] {
    const descendants: string[] = [];
    const queue = [taskId];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = this.db.select<{ id: string }>(`SELECT id FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL`, [parentId]);
      for (const child of children) {
        descendants.push(child.id);
        queue.push(child.id);
      }
    }
    return descendants;
  }

  private subtreeHeight(taskId: string): number {
    const children = this.db.select<{ id: string }>(`SELECT id FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL`, [taskId]);
    return children.length === 0 ? 1 : 1 + Math.max(...children.map((child) => this.subtreeHeight(child.id)));
  }

  private assertValidParent(projectId: string, taskId: string, parentTaskId: string | null, subtreeHeight: number): void {
    if (!parentTaskId) {
      if (subtreeHeight > 3) throw Object.assign(new Error('Task hierarchy cannot exceed three levels.'), { code: 'ZEUS_TASK_HIERARCHY_DEPTH_EXCEEDED' as const });
      return;
    }
    if (parentTaskId === taskId) throw Object.assign(new Error('A task cannot be its own parent.'), { code: 'ZEUS_TASK_PARENT_CYCLE' as const });
    let depth = 1;
    let cursor: string | null = parentTaskId;
    const visited = new Set<string>();
    while (cursor) {
      if (cursor === taskId || visited.has(cursor)) throw Object.assign(new Error('Task parent relationship would create a cycle.'), { code: 'ZEUS_TASK_PARENT_CYCLE' as const });
      visited.add(cursor);
      const parent: { project_id: string; parent_task_id: string | null } | undefined = this.db.get<{ project_id: string; parent_task_id: string | null }>(`SELECT project_id, parent_task_id FROM tasks WHERE id = ? AND deleted_at IS NULL`, [
        cursor,
      ]);
      if (!parent) throw Object.assign(new Error('Parent task not found.'), { code: 'ZEUS_TASK_PARENT_NOT_FOUND' as const });
      if (parent.project_id !== projectId) throw Object.assign(new Error('Parent task must belong to the same project.'), { code: 'ZEUS_TASK_RELATION_PROJECT_MISMATCH' as const });
      depth += 1;
      cursor = parent.parent_task_id;
    }
    if (depth + subtreeHeight - 1 > 3) throw Object.assign(new Error('Task hierarchy cannot exceed three levels.'), { code: 'ZEUS_TASK_HIERARCHY_DEPTH_EXCEEDED' as const });
  }

  private assertValidRelatedTasks(task: ZeusTaskRecord, relatedTaskIds: string[]): void {
    for (const relatedTaskId of relatedTaskIds) {
      if (relatedTaskId === task.id) throw Object.assign(new Error('A task cannot relate to itself.'), { code: 'ZEUS_TASK_SELF_RELATION' as const });
      const related = this.db.get<{ project_id: string }>(`SELECT project_id FROM tasks WHERE id = ? AND deleted_at IS NULL`, [relatedTaskId]);
      if (!related) throw Object.assign(new Error('Related task not found.'), { code: 'ZEUS_TASK_RELATED_NOT_FOUND' as const });
      if (related.project_id !== task.projectId) throw Object.assign(new Error('Related task must belong to the same project.'), { code: 'ZEUS_TASK_RELATION_PROJECT_MISMATCH' as const });
    }
  }

  private withRelatedTaskIds(task: ZeusTaskRecord): ZeusTaskRecord {
    task.relatedTaskIds = this.db
      .select<{ related_task_id: string }>(`SELECT CASE WHEN left_task_id = ? THEN right_task_id ELSE left_task_id END AS related_task_id FROM task_relations WHERE left_task_id = ? OR right_task_id = ?`, [task.id, task.id, task.id])
      .map((row) => row.related_task_id);
    return task;
  }

  private attachRelatedTaskIds(tasks: ZeusTaskRecord[]): void {
    if (tasks.length === 0) return;
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const placeholders = tasks.map(() => '?').join(', ');
    const relations = this.db.select<{ left_task_id: string; right_task_id: string }>(`SELECT left_task_id, right_task_id FROM task_relations WHERE left_task_id IN (${placeholders}) OR right_task_id IN (${placeholders})`, [
      ...taskById.keys(),
      ...taskById.keys(),
    ]);
    for (const relation of relations) {
      taskById.get(relation.left_task_id)?.relatedTaskIds.push(relation.right_task_id);
      taskById.get(relation.right_task_id)?.relatedTaskIds.push(relation.left_task_id);
    }
  }
}

const selectProjectRepositoryFields = `id, project_id, name, relative_path, local_path, created_at, updated_at`;

/** 项目仓库登记只保存用户确认后的仓库集合，扫描候选不会自动进入持久记录。 */
export class ProjectRepositoryRegistrationRepository {
  constructor(private readonly db: ZeusDatabase) {}

  listByProject(projectId: string): ZeusProjectRepositoryRecord[] {
    return this.db.select<DbProjectRepositoryRow>(`SELECT ${selectProjectRepositoryFields} FROM project_repositories WHERE project_id = ? ORDER BY relative_path, id`, [projectId]).map(mapProjectRepositoryRow);
  }

  getById(repositoryId: string): ZeusProjectRepositoryRecord | undefined {
    const row = this.db.get<DbProjectRepositoryRow>(`SELECT ${selectProjectRepositoryFields} FROM project_repositories WHERE id = ?`, [repositoryId]);
    return row ? mapProjectRepositoryRow(row) : undefined;
  }

  replaceForProject(projectId: string, inputs: CreateProjectRepositoryInput[]): ZeusProjectRepositoryRecord[] {
    return this.db.transaction(() => {
      const existing = new Map(this.listByProject(projectId).map((record) => [record.localPath, record]));
      this.db.execute(`DELETE FROM project_repositories WHERE project_id = ?`, [projectId]);
      const timestamp = nowIso();
      for (const input of inputs) {
        const prior = existing.get(input.localPath);
        this.db.execute(`INSERT INTO project_repositories (id, project_id, name, relative_path, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
          input.id ?? prior?.id ?? `project_repository_${nanoid(12)}`,
          projectId,
          input.name,
          input.relativePath,
          input.localPath,
          prior?.createdAt ?? timestamp,
          timestamp,
        ]);
      }
      return this.listByProject(projectId);
    });
  }
}

const selectProjectSharedPathFields = `id, project_id, relative_path, local_path, created_at, updated_at`;

/** 共享可写目录必须由用户显式登记；默认不存在隐式写入根。 */
export class ProjectSharedPathRepository {
  constructor(private readonly db: ZeusDatabase) {}

  listByProject(projectId: string): ZeusProjectSharedPathRecord[] {
    return this.db.select<DbProjectSharedPathRow>(`SELECT ${selectProjectSharedPathFields} FROM project_shared_paths WHERE project_id = ? ORDER BY relative_path, id`, [projectId]).map(mapProjectSharedPathRow);
  }

  replaceForProject(projectId: string, inputs: CreateProjectSharedPathInput[]): ZeusProjectSharedPathRecord[] {
    return this.db.transaction(() => {
      const existing = new Map(this.listByProject(projectId).map((record) => [record.localPath, record]));
      this.db.execute(`DELETE FROM project_shared_paths WHERE project_id = ?`, [projectId]);
      const timestamp = nowIso();
      for (const input of inputs) {
        const prior = existing.get(input.localPath);
        this.db.execute(`INSERT INTO project_shared_paths (id, project_id, relative_path, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
          input.id ?? prior?.id ?? `project_shared_path_${nanoid(12)}`,
          projectId,
          input.relativePath,
          input.localPath,
          prior?.createdAt ?? timestamp,
          timestamp,
        ]);
      }
      return this.listByProject(projectId);
    });
  }
}

const selectTaskEnvironmentFields = `id, project_id, task_id, root_path, state, last_error, created_at, updated_at`;

/** 任务环境保存多仓工作区的共同根和整体生命周期。 */
export class TaskEnvironmentRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateTaskEnvironmentInput): ZeusTaskEnvironmentRecord {
    const timestamp = nowIso();
    const record: ZeusTaskEnvironmentRecord = {
      id: input.id ?? `task_environment_${nanoid(12)}`,
      projectId: input.projectId,
      taskId: input.taskId,
      rootPath: input.rootPath ?? null,
      state: assertEnum(input.state ?? 'ready', ['ready', 'reclaimed', 'failed'] as const, 'task environment state'),
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(`INSERT INTO task_environments (id, project_id, task_id, root_path, state, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`, [
      record.id,
      record.projectId,
      record.taskId,
      record.rootPath,
      record.state,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  getById(environmentId: string): ZeusTaskEnvironmentRecord | undefined {
    const row = this.db.get<DbTaskEnvironmentRow>(`SELECT ${selectTaskEnvironmentFields} FROM task_environments WHERE id = ?`, [environmentId]);
    return row ? mapTaskEnvironmentRow(row) : undefined;
  }

  listByTask(taskId: string): ZeusTaskEnvironmentRecord[] {
    return this.db.select<DbTaskEnvironmentRow>(`SELECT ${selectTaskEnvironmentFields} FROM task_environments WHERE task_id = ? ORDER BY updated_at DESC, id`, [taskId]).map(mapTaskEnvironmentRow);
  }

  update(environmentId: string, input: UpdateTaskEnvironmentInput): ZeusTaskEnvironmentRecord {
    const existing = this.getById(environmentId);
    if (!existing) throw new Error(`Zeus task environment not found: ${environmentId}`);
    const state = input.state ? assertEnum(input.state, ['ready', 'reclaimed', 'failed'] as const, 'task environment state') : existing.state;
    this.db.execute(`UPDATE task_environments SET root_path = ?, state = ?, last_error = ?, updated_at = ? WHERE id = ?`, [
      'rootPath' in input ? (input.rootPath ?? null) : existing.rootPath,
      state,
      'lastError' in input ? (input.lastError ?? null) : existing.lastError,
      nowIso(),
      environmentId,
    ]);
    return this.getById(environmentId)!;
  }

  delete(environmentId: string): void {
    this.db.execute(`DELETE FROM task_environments WHERE id = ?`, [environmentId]);
  }
}

const selectTaskWorkspaceFields = `id, project_id, task_id, branch_name, source_branch, source_head_sha, remote_name,
  remote_branch, worktree_path, head_sha, state, last_error, created_at, updated_at,
  environment_id, repository_id, repository_name, repository_relative_path, repository_path`;

/** 任务工作区仓储只记录 Git 身份与生命周期，不代替 Git 本身作为分支状态真相源。 */
export class TaskWorkspaceRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateTaskWorkspaceInput): ZeusTaskWorkspaceRecord {
    const timestamp = nowIso();
    const state = assertEnum(input.state ?? 'ready', ['ready', 'reclaimed', 'merged', 'discarded', 'failed'] as const, 'task workspace state');
    const record: ZeusTaskWorkspaceRecord = {
      id: input.id ?? `task_workspace_${nanoid(12)}`,
      projectId: input.projectId,
      taskId: input.taskId,
      environmentId: input.environmentId ?? null,
      repositoryId: input.repositoryId ?? null,
      repositoryName: input.repositoryName ?? '项目仓库',
      repositoryRelativePath: input.repositoryRelativePath ?? '.',
      repositoryPath: input.repositoryPath ?? '',
      branchName: input.branchName,
      sourceBranch: input.sourceBranch,
      sourceHeadSha: input.sourceHeadSha,
      remoteName: input.remoteName ?? 'origin',
      remoteBranch: input.remoteBranch ?? input.branchName,
      worktreePath: input.worktreePath ?? null,
      headSha: input.headSha ?? null,
      state,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO task_workspaces
       (id, project_id, task_id, branch_name, source_branch, source_head_sha, remote_name, remote_branch,
        worktree_path, head_sha, state, last_error, created_at, updated_at,
        environment_id, repository_id, repository_name, repository_relative_path, repository_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.taskId,
        record.branchName,
        record.sourceBranch,
        record.sourceHeadSha,
        record.remoteName,
        record.remoteBranch,
        record.worktreePath,
        record.headSha,
        record.state,
        record.createdAt,
        record.updatedAt,
        record.environmentId,
        record.repositoryId,
        record.repositoryName,
        record.repositoryRelativePath,
        record.repositoryPath,
      ],
    );
    return record;
  }

  getById(workspaceId: string): ZeusTaskWorkspaceRecord | undefined {
    const row = this.db.get<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE id = ?`, [workspaceId]);
    return row ? mapTaskWorkspaceRow(row) : undefined;
  }

  getByProjectBranch(projectId: string, branchName: string): ZeusTaskWorkspaceRecord | undefined {
    const row = this.db.get<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE project_id = ? AND branch_name = ?`, [projectId, branchName]);
    return row ? mapTaskWorkspaceRow(row) : undefined;
  }

  getByRepositoryBranch(repositoryId: string, branchName: string): ZeusTaskWorkspaceRecord | undefined {
    const row = this.db.get<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE repository_id = ? AND branch_name = ?`, [repositoryId, branchName]);
    return row ? mapTaskWorkspaceRow(row) : undefined;
  }

  listByEnvironment(environmentId: string): ZeusTaskWorkspaceRecord[] {
    return this.db.select<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE environment_id = ? ORDER BY repository_relative_path, id`, [environmentId]).map(mapTaskWorkspaceRow);
  }

  listByTask(taskId: string): ZeusTaskWorkspaceRecord[] {
    return this.db.select<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE task_id = ? ORDER BY created_at, id`, [taskId]).map(mapTaskWorkspaceRow);
  }

  listByProject(projectId: string): ZeusTaskWorkspaceRecord[] {
    return this.db.select<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE project_id = ? ORDER BY updated_at DESC, id`, [projectId]).map(mapTaskWorkspaceRow);
  }

  update(workspaceId: string, input: UpdateTaskWorkspaceInput): ZeusTaskWorkspaceRecord {
    const existing = this.getById(workspaceId);
    if (!existing) throw new Error(`Zeus task workspace not found: ${workspaceId}`);
    const state = input.state ? assertEnum(input.state, ['ready', 'reclaimed', 'merged', 'discarded', 'failed'] as const, 'task workspace state') : existing.state;
    this.db.execute(
      `UPDATE task_workspaces
       SET worktree_path = ?, head_sha = ?, state = ?, remote_branch = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [
        'worktreePath' in input ? (input.worktreePath ?? null) : existing.worktreePath,
        'headSha' in input ? (input.headSha ?? null) : existing.headSha,
        state,
        input.remoteBranch ?? existing.remoteBranch,
        'lastError' in input ? (input.lastError ?? null) : existing.lastError,
        nowIso(),
        workspaceId,
      ],
    );
    return this.getById(workspaceId)!;
  }

  delete(workspaceId: string): void {
    this.db.execute(`DELETE FROM task_workspaces WHERE id = ?`, [workspaceId]);
  }
}

const selectTaskIntegrationFields = `id, project_id, task_id, workspace_id, target_branch, target_head_sha, task_head_sha, mode,
  integration_path, result_head_sha, state, local_sync_status, local_head_sha, local_worktree_path,
  conflict_files_json, last_error, created_at, updated_at`;

/** 合入记录保存隔离集成 worktree 的恢复身份，使冲突处理可以跨应用重启继续。 */
export class TaskIntegrationRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateTaskIntegrationInput): ZeusTaskIntegrationRecord {
    const timestamp = nowIso();
    const mode = assertEnum(input.mode, ['merge', 'squash'] as const, 'task integration mode');
    const state = assertEnum(input.state ?? 'preparing', ['preparing', 'conflicted', 'pending_local_sync', 'merged', 'failed'] as const, 'task integration state');
    const record: ZeusTaskIntegrationRecord = {
      id: input.id ?? `task_integration_${nanoid(12)}`,
      projectId: input.projectId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      targetBranch: input.targetBranch,
      targetHeadSha: input.targetHeadSha,
      taskHeadSha: input.taskHeadSha,
      mode,
      integrationPath: input.integrationPath ?? null,
      resultHeadSha: null,
      state,
      localSyncStatus: null,
      localHeadSha: null,
      localWorktreePath: null,
      conflictFiles: [],
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO task_integrations
       (id, project_id, task_id, workspace_id, target_branch, target_head_sha, task_head_sha, mode, integration_path,
        result_head_sha, state, local_sync_status, local_head_sha, local_worktree_path,
        conflict_files_json, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, '[]', NULL, ?, ?)`,
      [record.id, record.projectId, record.taskId, record.workspaceId, record.targetBranch, record.targetHeadSha, record.taskHeadSha, record.mode, record.integrationPath, record.state, record.createdAt, record.updatedAt],
    );
    return record;
  }

  getById(integrationId: string): ZeusTaskIntegrationRecord | undefined {
    const row = this.db.get<DbTaskIntegrationRow>(`SELECT ${selectTaskIntegrationFields} FROM task_integrations WHERE id = ?`, [integrationId]);
    return row ? mapTaskIntegrationRow(row) : undefined;
  }

  findActive(workspaceId: string, targetBranch: string): ZeusTaskIntegrationRecord | undefined {
    const row = this.db.get<DbTaskIntegrationRow>(
      `SELECT ${selectTaskIntegrationFields} FROM task_integrations WHERE workspace_id = ? AND target_branch = ? AND state IN ('preparing', 'conflicted', 'pending_local_sync') ORDER BY updated_at DESC LIMIT 1`,
      [workspaceId, targetBranch],
    );
    return row ? mapTaskIntegrationRow(row) : undefined;
  }

  listByTask(taskId: string): ZeusTaskIntegrationRecord[] {
    return this.db.select<DbTaskIntegrationRow>(`SELECT ${selectTaskIntegrationFields} FROM task_integrations WHERE task_id = ? ORDER BY updated_at DESC, id`, [taskId]).map(mapTaskIntegrationRow);
  }

  update(integrationId: string, input: UpdateTaskIntegrationInput): ZeusTaskIntegrationRecord {
    const existing = this.getById(integrationId);
    if (!existing) throw new Error(`Zeus task integration not found: ${integrationId}`);
    const state = input.state ? assertEnum(input.state, ['preparing', 'conflicted', 'pending_local_sync', 'merged', 'failed'] as const, 'task integration state') : existing.state;
    this.db.execute(
      `UPDATE task_integrations
       SET integration_path = ?, result_head_sha = ?, state = ?, local_sync_status = ?, local_head_sha = ?,
           local_worktree_path = ?, conflict_files_json = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [
        'integrationPath' in input ? (input.integrationPath ?? null) : existing.integrationPath,
        'resultHeadSha' in input ? (input.resultHeadSha ?? null) : existing.resultHeadSha,
        state,
        'localSyncStatus' in input ? (input.localSyncStatus ?? null) : existing.localSyncStatus,
        'localHeadSha' in input ? (input.localHeadSha ?? null) : existing.localHeadSha,
        'localWorktreePath' in input ? (input.localWorktreePath ?? null) : existing.localWorktreePath,
        JSON.stringify(input.conflictFiles ?? existing.conflictFiles),
        'lastError' in input ? (input.lastError ?? null) : existing.lastError,
        nowIso(),
        integrationId,
      ],
    );
    return this.getById(integrationId)!;
  }
}

/** 任务模板是产品 prompt 定义，不是项目、任务、会话或执行结果数据。 */
export class TaskTemplateRepository {
  constructor(private readonly db: ZeusDatabase) {}

  createCustom(input: CreateTaskTemplateInput): ZeusTaskTemplateRecord {
    const timestamp = nowIso();
    const record: ZeusTaskTemplateRecord = {
      id: `task_template_${nanoid(12)}`,
      name: input.name,
      description: input.description,
      category: input.category ?? 'custom',
      promptTemplate: input.promptTemplate,
      defaultOptionsJson: JSON.stringify(input.defaultOptions ?? {}),
      projectId: input.projectId ?? null,
      builtIn: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO task_templates (id, name, description, category, prompt_template, default_options_json, built_in, sort_order, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      [record.id, record.name, record.description, record.category, record.promptTemplate, record.defaultOptionsJson, record.projectId, record.createdAt, record.updatedAt],
    );
    return record;
  }

  getById(templateId: string): ZeusTaskTemplateRecord | undefined {
    const row = this.db.get<DbTaskTemplateRow>(
      `SELECT id, name, description, category, prompt_template, default_options_json, project_id, built_in, created_at, updated_at
       FROM task_templates WHERE id = ? AND deleted_at IS NULL`,
      [templateId],
    );
    return row ? mapTaskTemplateRow(row) : undefined;
  }

  listBuiltIn(): ZeusTaskTemplateRecord[] {
    return this.db
      .select<DbTaskTemplateRow>(
        `SELECT id, name, description, category, prompt_template, default_options_json, project_id, built_in, created_at, updated_at
       FROM task_templates WHERE built_in = 1 AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC`,
      )
      .map(mapTaskTemplateRow);
  }

  listAll(): ZeusTaskTemplateRecord[] {
    return this.db
      .select<DbTaskTemplateRow>(
        `SELECT id, name, description, category, prompt_template, default_options_json, project_id, built_in, created_at, updated_at
       FROM task_templates WHERE deleted_at IS NULL ORDER BY built_in DESC, sort_order ASC, created_at ASC, id ASC`,
      )
      .map(mapTaskTemplateRow);
  }

  listForProject(projectId: string): ZeusTaskTemplateRecord[] {
    return this.db
      .select<DbTaskTemplateRow>(
        `SELECT id, name, description, category, prompt_template, default_options_json, project_id, built_in, created_at, updated_at
       FROM task_templates
       WHERE deleted_at IS NULL AND (built_in = 1 OR project_id = ?)
       ORDER BY built_in DESC, sort_order ASC, created_at ASC, id ASC`,
        [projectId],
      )
      .map(mapTaskTemplateRow);
  }
}

/** 任务事件仓储记录真实任务时间线，供任务详情和远程入口复用。 */
export class TaskEventRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateTaskEventInput): ZeusTaskEventRecord {
    const record: ZeusTaskEventRecord = {
      id: `task_event_${nanoid(12)}`,
      taskId: input.taskId,
      eventType: input.eventType,
      title: input.title,
      payloadJson: JSON.stringify(input.payload),
      createdAt: nowIso(),
    };
    this.db.execute(`INSERT INTO task_events (id, task_id, event_type, title, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [record.id, record.taskId, record.eventType, record.title, record.payloadJson, record.createdAt]);
    return record;
  }

  listByTask(taskId: string): ZeusTaskEventRecord[] {
    return this.db.select<DbTaskEventRow>(`SELECT id, task_id, event_type, title, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY created_at ASC`, [taskId]).map(mapTaskEventRow);
  }
}

function assertRuntimeSessionCanBeHidden(session: ZeusRuntimeSessionRecord, operation: 'archive' | 'delete'): void {
  const confirmedTerminal = (session.status === 'exited' || session.status === 'failed' || session.status === 'stopped' || session.status === 'lost') && Boolean(session.endedAt);
  if (confirmedTerminal) return;
  throw Object.assign(new Error(`Runtime session ${session.id} must reach a terminal status before ${operation}.`), {
    code: 'ZEUS_RUNTIME_SESSION_UNFINISHED',
  });
}

/** Runtime 会话仓储保存真实 AI CLI 会话和终端日志，支持 App 重启后恢复列表。 */
export class RuntimeSessionRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateRuntimeSessionInput): ZeusRuntimeSessionRecord {
    const timestamp = nowIso();
    const record: ZeusRuntimeSessionRecord = {
      id: input.id,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      command: input.command,
      argsJson: JSON.stringify(input.args),
      cwd: input.cwd,
      status: input.status,
      pid: input.pid ?? null,
      processIdentityToken: null,
      exitCode: null,
      summary: null,
      favorite: false,
      archived: false,
      startedAt: input.startedAt,
      endedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    this.db.execute(
      `INSERT OR REPLACE INTO runtime_sessions (id, project_id, task_id, command, args_json, cwd, status, pid, process_identity_token, exit_code, summary, favorite, archived, started_at, ended_at, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.taskId,
        record.command,
        record.argsJson,
        record.cwd,
        record.status,
        record.pid,
        record.processIdentityToken,
        record.exitCode,
        record.summary,
        0,
        0,
        record.startedAt,
        record.endedAt,
        record.createdAt,
        record.updatedAt,
        record.deletedAt,
      ],
    );
    return record;
  }

  updateStatus(sessionId: string, input: UpdateRuntimeSessionStatusInput): ZeusRuntimeSessionRecord {
    const existing = this.getByIdIncludingDeleted(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    const updatedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET status = ?, exit_code = ?, ended_at = ?, pid = COALESCE(?, pid), updated_at = ? WHERE id = ?`, [
      input.status,
      input.exitCode ?? existing.exitCode,
      input.endedAt ?? existing.endedAt,
      input.pid ?? null,
      updatedAt,
      sessionId,
    ]);
    return this.getByIdIncludingDeleted(sessionId)!;
  }

  getById(sessionId: string): ZeusRuntimeSessionRecord | undefined {
    const row = this.db.get<DbRuntimeSessionRow>(runtimeSessionSelectSql(`WHERE id = ? AND deleted_at IS NULL LIMIT 1`), [sessionId]);
    return row ? mapRuntimeSessionRow(row) : undefined;
  }

  /** 启动恢复必须覆盖已归档和软删除记录，不能因可见性过滤漏掉仍在运行的进程。 */
  getByIdIncludingDeleted(sessionId: string): ZeusRuntimeSessionRecord | undefined {
    const row = this.db.get<DbRuntimeSessionRow>(runtimeSessionSelectSql(`WHERE id = ? LIMIT 1`), [sessionId]);
    return row ? mapRuntimeSessionRow(row) : undefined;
  }

  listUnfinishedForRecovery(): ZeusRuntimeSessionRecord[] {
    return this.db.select<DbRuntimeSessionRow>(runtimeSessionSelectSql(`WHERE status IN ('running', 'orphan_detected') ORDER BY started_at, id`)).map(mapRuntimeSessionRow);
  }

  /** 进程身份只能首次写入或幂等重放，禁止替换后把旧进程误认成新进程。 */
  setProcessIdentity(sessionId: string, token: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(token)) {
      throw new Error('ZEUS_RUNTIME_PROCESS_IDENTITY_INVALID');
    }
    const existing = this.getByIdIncludingDeleted(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    if (existing.processIdentityToken && existing.processIdentityToken !== token) {
      throw new Error(`ZEUS_RUNTIME_PROCESS_IDENTITY_CONFLICT: ${sessionId}`);
    }
    if (existing.processIdentityToken === token) return;
    this.db.execute(`UPDATE runtime_sessions SET process_identity_token = ?, updated_at = ? WHERE id = ?`, [token, nowIso(), sessionId]);
  }

  /** 发现仍活动的隐藏记录时先恢复可见性，确保用户能够检查并停止，不能静默留在归档或回收站。 */
  restoreForRecovery(sessionId: string): ZeusRuntimeSessionRecord {
    const existing = this.getByIdIncludingDeleted(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    if (existing.status !== 'running' && existing.status !== 'orphan_detected') {
      throw new Error(`ZEUS_RUNTIME_RECOVERY_NOT_UNFINISHED: ${sessionId}`);
    }
    const updatedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET archived = 0, deleted_at = NULL, updated_at = ? WHERE id = ?`, [updatedAt, sessionId]);
    return this.getById(sessionId)!;
  }

  list(options: RuntimeSessionListOptions = {}): ZeusRuntimeSessionRecord[] {
    const query = options.query?.trim().toLowerCase();
    const queryClause = query
      ? `AND (
           LOWER(command) LIKE ?
           OR LOWER(cwd) LIKE ?
           OR LOWER(COALESCE(summary, '')) LIKE ?
           OR EXISTS (
             SELECT 1 FROM runtime_logs
             WHERE runtime_logs.session_id = runtime_sessions.id
               AND (LOWER(runtime_logs.text) LIKE ? OR LOWER(runtime_logs.stream) LIKE ? OR LOWER(runtime_logs.created_at) LIKE ?)
           )
         )`
      : '';
    const params: SqlValue[] = [options.archived ? 1 : 0, options.projectId ?? null, options.projectId ?? null, options.taskId ?? null, options.taskId ?? null, options.favoriteOnly ? 1 : 0];
    if (query) {
      const like = `%${query}%`;
      params.push(like, like, like, like, like, like);
    }
    return this.db
      .select<DbRuntimeSessionRow>(
        runtimeSessionSelectSql(`WHERE deleted_at IS NULL AND archived = ? AND (? IS NULL OR project_id = ?) AND (? IS NULL OR task_id = ?) AND (? = 0 OR favorite = 1) ${queryClause} ORDER BY started_at DESC, id DESC`),
        params,
      )
      .map(mapRuntimeSessionRow);
  }

  appendLog(input: AppendRuntimeLogInput): AppendRuntimeLogResult {
    const record: ZeusRuntimeLogRecord = {
      id: input.id,
      sessionId: input.sessionId,
      stream: input.stream,
      text: input.text,
      createdAt: input.createdAt,
    };
    const existingRow = this.db.get<DbRuntimeLogRow>(`SELECT id, session_id, stream, text, created_at FROM runtime_logs WHERE id = ? LIMIT 1`, [record.id]);
    if (existingRow) {
      const existing = mapRuntimeLogRow(existingRow);
      if (existing.sessionId !== record.sessionId || existing.stream !== record.stream || existing.text !== record.text || existing.createdAt !== record.createdAt) {
        throw new Error(`ZEUS_RUNTIME_LOG_ID_CONFLICT: ${record.id}`);
      }
      return { record: existing, inserted: false };
    }
    this.db.transaction(() => {
      this.db.execute(`INSERT INTO runtime_logs (id, session_id, stream, text, created_at) VALUES (?, ?, ?, ?, ?)`, [record.id, record.sessionId, record.stream, record.text, record.createdAt]);
      this.appendTerminalEventFromRuntimeLog(record);
    });
    return { record, inserted: true };
  }

  listLogs(sessionId: string): ZeusRuntimeLogRecord[] {
    return this.db
      .select<DbRuntimeLogRow>(
        `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.text, runtime_logs.created_at
         FROM terminal_events
         INNER JOIN runtime_logs ON runtime_logs.id = substr(terminal_events.id, 16) AND runtime_logs.session_id = terminal_events.session_id
         WHERE terminal_events.session_id = ?
         ORDER BY terminal_events.seq ASC`,
        [sessionId],
      )
      .map(mapRuntimeLogRow);
  }

  /** 高频状态投影先读取长度元数据，再按字节预算取正文，避免巨型日志先进入 Node 堆。 */
  listRecentLogs(sessionId: string, limit = 8, byteBudget = DEFAULT_RUNTIME_LOG_PROJECTION_BYTES): ZeusRuntimeLogRecord[] {
    const boundedLimit = clampPositiveInteger(limit, 8, 1, 2_500);
    const boundedByteBudget = clampPositiveInteger(byteBudget, DEFAULT_RUNTIME_LOG_PROJECTION_BYTES, 1_024, 16 * 1024 * 1024);
    const metadata = this.db.select<DbRuntimeLogMetadataRow>(
      `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.created_at,
              terminal_events.seq AS sequence, length(CAST(runtime_logs.text AS BLOB)) AS byte_length
         FROM terminal_events
         INNER JOIN runtime_logs ON runtime_logs.id = substr(terminal_events.id, 16) AND runtime_logs.session_id = terminal_events.session_id
         WHERE terminal_events.session_id = ?
         ORDER BY terminal_events.seq DESC
         LIMIT ?`,
      [sessionId, boundedLimit],
    );
    const projection = takeRuntimeLogMetadataWithinBudget(metadata, boundedByteBudget);
    const items = this.listLogsBySequenceRange(sessionId, projection.items);
    if (projection.truncated) items.unshift(createRuntimeLogProjectionMarker(sessionId, metadata[0]?.created_at));
    return items;
  }

  searchLogs(sessionId: string, options: RuntimeLogListOptions = {}): RuntimeLogListResult {
    const query = options.query?.trim() || null;
    const stream = options.stream ?? null;
    const limit = clampPositiveInteger(options.limit, 200, 1, 2_000);
    const offset = clampPositiveInteger(options.offset, 0, 0, 2_147_483_647);
    const afterSeq = clampPositiveInteger(options.afterSeq, 0, 0, Number.MAX_SAFE_INTEGER);
    const byteBudget = options.byteBudget === undefined ? null : clampPositiveInteger(options.byteBudget, DEFAULT_RUNTIME_LOG_PROJECTION_BYTES, 1_024, 16 * 1024 * 1024);
    const clauses = ['terminal_events.session_id = ?'];
    const params: SqlValue[] = [sessionId];
    if (stream) {
      clauses.push('runtime_logs.stream = ?');
      params.push(stream);
    }
    if (query) {
      clauses.push('(LOWER(runtime_logs.text) LIKE ? OR LOWER(runtime_logs.stream) LIKE ? OR LOWER(runtime_logs.created_at) LIKE ?)');
      const like = `%${query.toLowerCase()}%`;
      params.push(like, like, like);
    }
    const whereSql = clauses.join(' AND ');
    const fromSql = `FROM terminal_events
      INNER JOIN runtime_logs ON runtime_logs.id = substr(terminal_events.id, 16) AND runtime_logs.session_id = terminal_events.session_id`;
    const selectSql = `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.text, runtime_logs.created_at, terminal_events.seq AS sequence`;
    // 无筛选时 seq 是会话内持久单调序号，MAX 可直接走 session+seq 索引，避免 1 Hz 轮询反复 COUNT 全历史。
    const total =
      query || stream
        ? (this.db.get<{ count: number }>(`SELECT COUNT(*) AS count ${fromSql} WHERE ${whereSql}`, params)?.count ?? 0)
        : (this.db.get<{ count: number }>(`SELECT COALESCE(MAX(seq), 0) AS count FROM terminal_events WHERE session_id = ?`, [sessionId])?.count ?? 0);

    if (options.tail && byteBudget !== null) {
      const metadata = this.db.select<DbRuntimeLogMetadataRow>(
        `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.created_at,
                terminal_events.seq AS sequence, length(CAST(runtime_logs.text AS BLOB)) AS byte_length
         ${fromSql} WHERE ${whereSql} ORDER BY terminal_events.seq DESC LIMIT ?`,
        [...params, limit],
      );
      const projection = takeRuntimeLogMetadataWithinBudget(metadata, byteBudget);
      const sequenceClause = runtimeLogSequenceRangeClause(projection.items);
      const rows = sequenceClause ? this.db.select<DbSequencedRuntimeLogRow>(`${selectSql} ${fromSql} WHERE ${whereSql} AND ${sequenceClause.sql} ORDER BY terminal_events.seq ASC`, [...params, ...sequenceClause.params]) : [];
      const items = rows.map(mapRuntimeLogRow);
      if (projection.truncated) items.unshift(createRuntimeLogProjectionMarker(sessionId, metadata[0]?.created_at));
      return {
        items,
        total,
        limit,
        offset: Math.max(0, total - metadata.length),
        afterSeq,
        nextSeq: metadata[0]?.sequence ?? afterSeq,
        hasMore: false,
        truncated: projection.truncated || total > metadata.length,
        query,
        stream,
      };
    }

    if (options.tail) {
      const rows = this.db.select<DbSequencedRuntimeLogRow>(`${selectSql} ${fromSql} WHERE ${whereSql} ORDER BY terminal_events.seq DESC LIMIT ?`, [...params, limit]).reverse();
      const nextSeq = rows.at(-1)?.sequence ?? afterSeq;
      return {
        items: rows.map(mapRuntimeLogRow),
        total,
        limit,
        offset: Math.max(0, total - rows.length),
        afterSeq,
        nextSeq,
        hasMore: false,
        truncated: total > rows.length,
        query,
        stream,
      };
    }

    if (options.afterSeq !== undefined && byteBudget !== null) {
      const metadata = this.db.select<DbRuntimeLogMetadataRow>(
        `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.created_at,
                terminal_events.seq AS sequence, length(CAST(runtime_logs.text AS BLOB)) AS byte_length
         ${fromSql} WHERE ${whereSql} AND terminal_events.seq > ? ORDER BY terminal_events.seq ASC LIMIT ?`,
        [...params, afterSeq, limit + 1],
      );
      const hasMore = metadata.length > limit;
      const pageMetadata = hasMore ? metadata.slice(0, limit) : metadata;
      const nextSeq = pageMetadata.at(-1)?.sequence ?? afterSeq;
      const projection = takeRuntimeLogMetadataWithinBudget([...pageMetadata].reverse(), byteBudget);
      const sequenceClause = runtimeLogSequenceRangeClause(projection.items);
      const rows = sequenceClause ? this.db.select<DbSequencedRuntimeLogRow>(`${selectSql} ${fromSql} WHERE ${whereSql} AND ${sequenceClause.sql} ORDER BY terminal_events.seq ASC`, [...params, ...sequenceClause.params]) : [];
      const items = rows.map(mapRuntimeLogRow);
      if (projection.truncated) items.unshift(createRuntimeLogProjectionMarker(sessionId, pageMetadata[0]?.created_at));
      return { items, total, limit, offset: 0, afterSeq, nextSeq, hasMore, truncated: projection.truncated, query, stream };
    }

    if (options.afterSeq !== undefined) {
      const rows = this.db.select<DbSequencedRuntimeLogRow>(`${selectSql} ${fromSql} WHERE ${whereSql} AND terminal_events.seq > ? ORDER BY terminal_events.seq ASC LIMIT ?`, [...params, afterSeq, limit + 1]);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const nextSeq = pageRows.at(-1)?.sequence ?? afterSeq;
      return { items: pageRows.map(mapRuntimeLogRow), total, limit, offset: 0, afterSeq, nextSeq, hasMore, truncated: false, query, stream };
    }

    const rows = this.db.select<DbSequencedRuntimeLogRow>(`${selectSql} ${fromSql} WHERE ${whereSql} ORDER BY terminal_events.seq ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return {
      items: rows.map(mapRuntimeLogRow),
      total,
      limit,
      offset,
      afterSeq,
      nextSeq: rows.at(-1)?.sequence ?? afterSeq,
      hasMore: offset + rows.length < total,
      truncated: false,
      query,
      stream,
    };
  }

  private listLogsBySequenceRange(sessionId: string, metadata: DbRuntimeLogMetadataRow[]): ZeusRuntimeLogRecord[] {
    const sequenceClause = runtimeLogSequenceRangeClause(metadata);
    if (!sequenceClause) return [];
    return this.db
      .select<DbRuntimeLogRow>(
        `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.text, runtime_logs.created_at
         FROM terminal_events
         INNER JOIN runtime_logs ON runtime_logs.id = substr(terminal_events.id, 16) AND runtime_logs.session_id = terminal_events.session_id
         WHERE terminal_events.session_id = ? AND ${sequenceClause.sql}
         ORDER BY terminal_events.seq ASC`,
        [sessionId, ...sequenceClause.params],
      )
      .map(mapRuntimeLogRow);
  }

  setFavorite(sessionId: string, favorite: boolean): ZeusRuntimeSessionRecord {
    this.updateFlag(sessionId, 'favorite', favorite);
    return this.getById(sessionId)!;
  }

  archive(sessionId: string): ZeusRuntimeSessionRecord {
    const existing = this.getById(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    assertRuntimeSessionCanBeHidden(existing, 'archive');
    this.updateFlag(sessionId, 'archived', true);
    return this.getById(sessionId)!;
  }

  restore(sessionId: string): ZeusRuntimeSessionRecord {
    this.updateFlag(sessionId, 'archived', false);
    return this.getById(sessionId)!;
  }

  delete(sessionId: string): ZeusRuntimeSessionRecord {
    const existing = this.getById(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    assertRuntimeSessionCanBeHidden(existing, 'delete');
    const deletedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET deleted_at = ?, updated_at = ? WHERE id = ?`, [deletedAt, deletedAt, sessionId]);
    return { ...existing, deletedAt, updatedAt: deletedAt };
  }

  /**
   * 只返回没有任务归属、未收藏、已归档或已删除且早于保留边界的终态会话。
   * 活动会话和任务证据默认豁免，避免把“到期”误当成可以删除业务历史。
   */
  listLogRetentionCandidates(cutoff: string): ZeusRuntimeSessionRecord[] {
    return this.db
      .select<DbRuntimeSessionRow>(
        runtimeSessionSelectSql(
          `WHERE task_id IS NULL
             AND favorite = 0
             AND status IN ('exited', 'failed', 'stopped', 'lost')
             AND ended_at IS NOT NULL
             AND (archived = 1 OR deleted_at IS NOT NULL)
             AND COALESCE(ended_at, updated_at) < ?
             AND (EXISTS (SELECT 1 FROM runtime_logs WHERE runtime_logs.session_id = runtime_sessions.id)
               OR EXISTS (SELECT 1 FROM terminal_events WHERE terminal_events.session_id = runtime_sessions.id))
           ORDER BY COALESCE(ended_at, updated_at), id`,
        ),
        [cutoff],
      )
      .map(mapRuntimeSessionRow);
  }

  purgeRetainedLogs(sessionId: string): { runtimeLogCount: number; terminalEventCount: number } {
    const runtimeLogCount = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM runtime_logs WHERE session_id = ?`, [sessionId])?.count ?? 0;
    const terminalEventCount = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM terminal_events WHERE session_id = ?`, [sessionId])?.count ?? 0;
    this.db.execute(`DELETE FROM runtime_logs WHERE session_id = ?`, [sessionId]);
    this.db.execute(`DELETE FROM terminal_events WHERE session_id = ?`, [sessionId]);
    return { runtimeLogCount, terminalEventCount };
  }

  generateSummary(sessionId: string): ZeusRuntimeSessionRecord {
    const existing = this.getById(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    const realLogs: string[] = [];
    let afterSeq = 0;
    let remainingCharacters = 500;
    while (remainingCharacters > 0) {
      const rows = this.db.select<{ sequence: number; excerpt: string }>(
        `SELECT terminal_events.seq AS sequence, substr(trim(runtime_logs.text), 1, 500) AS excerpt
           FROM terminal_events
           INNER JOIN runtime_logs ON runtime_logs.id = substr(terminal_events.id, 16) AND runtime_logs.session_id = terminal_events.session_id
          WHERE terminal_events.session_id = ? AND terminal_events.seq > ? AND length(trim(runtime_logs.text)) > 0
          ORDER BY terminal_events.seq ASC
          LIMIT 32`,
        [sessionId, afterSeq],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const separatorLength = realLogs.length > 0 ? 1 : 0;
        const available = remainingCharacters - separatorLength;
        if (available <= 0) {
          remainingCharacters = 0;
          break;
        }
        realLogs.push(row.excerpt.slice(0, available));
        remainingCharacters -= separatorLength + Math.min(row.excerpt.length, available);
        afterSeq = row.sequence;
        if (remainingCharacters <= 0) break;
      }
      if (rows.length < 32) break;
    }
    // 摘要只能来自真实 Runtime 日志；没有日志时保持 null，由 UI 展示“未生成摘要”。
    const summary = realLogs.length > 0 ? realLogs.join('\n') : null;
    const updatedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET summary = ?, updated_at = ? WHERE id = ?`, [summary, updatedAt, sessionId]);
    return this.getById(sessionId)!;
  }

  private updateFlag(sessionId: string, column: 'favorite' | 'archived', enabled: boolean): void {
    const existing = this.getById(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    const updatedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET ${column} = ?, updated_at = ? WHERE id = ?`, [enabled ? 1 : 0, updatedAt, sessionId]);
  }

  /** Runtime 日志同时镜像成 terminal_events，保证设计书要求的终端回放表有真实写入来源。 */
  private appendTerminalEventFromRuntimeLog(record: ZeusRuntimeLogRecord): void {
    const session = this.getById(record.sessionId);
    const nextSeq = this.db.get<{ next_seq: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM terminal_events WHERE session_id = ?`, [record.sessionId])?.next_seq ?? 1;
    this.db.execute(
      `INSERT INTO terminal_events (id, session_id, task_id, seq, event_type, content, raw_chunk_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      // 正文只保存在 runtime_logs；terminal_events 保留稳定序号和引用，读取回放时再关联正文。
      [`terminal_event_${record.id}`, record.sessionId, session?.taskId ?? null, nextSeq, record.stream, '', null, record.createdAt],
    );
  }
}

function takeRuntimeLogMetadataWithinBudget(metadata: DbRuntimeLogMetadataRow[], byteBudget: number): { items: DbRuntimeLogMetadataRow[]; truncated: boolean } {
  const markerBytes = Buffer.byteLength(RUNTIME_LOG_PROJECTION_MARKER_TEXT, 'utf8');
  let remainingBytes = Math.max(0, byteBudget - markerBytes);
  const items: DbRuntimeLogMetadataRow[] = [];
  for (const entry of metadata) {
    if (entry.byte_length > remainingBytes) return { items, truncated: true };
    items.push(entry);
    remainingBytes -= entry.byte_length;
  }
  return { items, truncated: false };
}

function runtimeLogSequenceRangeClause(metadata: DbRuntimeLogMetadataRow[]): { sql: string; params: SqlValue[] } | null {
  if (metadata.length === 0) return null;
  const sequences = metadata.map((entry) => entry.sequence);
  return { sql: 'terminal_events.seq BETWEEN ? AND ?', params: [Math.min(...sequences), Math.max(...sequences)] };
}

function createRuntimeLogProjectionMarker(sessionId: string, createdAt?: string): ZeusRuntimeLogRecord {
  return {
    id: `runtime_log_projection_marker_${sessionId}`,
    sessionId,
    stream: 'system',
    text: RUNTIME_LOG_PROJECTION_MARKER_TEXT,
    createdAt: createdAt ?? nowIso(),
  };
}

/** 终端事件仓储按 session+seq 持久化真实输出，后续可支撑 PTY 回放与审计。 */
export class TerminalEventRepository {
  constructor(private readonly db: ZeusDatabase) {}

  append(input: AppendTerminalEventInput): ZeusTerminalEventRecord {
    const record: ZeusTerminalEventRecord = {
      id: `terminal_event_${nanoid(12)}`,
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      seq: input.seq,
      eventType: input.eventType,
      content: input.content,
      rawChunkPath: input.rawChunkPath ?? null,
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO terminal_events (id, session_id, task_id, seq, event_type, content, raw_chunk_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.sessionId, record.taskId, record.seq, record.eventType, record.content, record.rawChunkPath, record.createdAt],
    );
    return record;
  }

  listBySession(sessionId: string): ZeusTerminalEventRecord[] {
    return this.db
      .select<DbTerminalEventRow>(
        `SELECT terminal_events.id, terminal_events.session_id, terminal_events.task_id, terminal_events.seq,
                terminal_events.event_type, COALESCE(runtime_logs.text, terminal_events.content) AS content,
                terminal_events.raw_chunk_path, terminal_events.created_at
           FROM terminal_events
           LEFT JOIN runtime_logs
             ON terminal_events.id = 'terminal_event_' || runtime_logs.id
            AND terminal_events.session_id = runtime_logs.session_id
          WHERE terminal_events.session_id = ?
          ORDER BY terminal_events.seq ASC, terminal_events.created_at ASC`,
        [sessionId],
      )
      .map(mapTerminalEventRow);
  }

  /** 按 session 和 seq 做稳定 SQL 分页，避免终端长会话回放时一次性加载全量事件。 */
  listBySessionPage(sessionId: string, options: TerminalEventListOptions = {}): TerminalEventListResult {
    const limit = clampPositiveInteger(options.limit, 200, 1, 1_000);
    const offset = clampPositiveInteger(options.offset, 0, 0, 2_147_483_647);
    const total = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM terminal_events WHERE session_id = ?`, [sessionId])?.count ?? 0;
    const items = this.db
      .select<DbTerminalEventRow>(
        `SELECT terminal_events.id, terminal_events.session_id, terminal_events.task_id, terminal_events.seq,
                terminal_events.event_type, COALESCE(runtime_logs.text, terminal_events.content) AS content,
                terminal_events.raw_chunk_path, terminal_events.created_at
           FROM terminal_events
           LEFT JOIN runtime_logs
             ON terminal_events.id = 'terminal_event_' || runtime_logs.id
            AND terminal_events.session_id = runtime_logs.session_id
          WHERE terminal_events.session_id = ?
          ORDER BY terminal_events.seq ASC, terminal_events.created_at ASC
          LIMIT ? OFFSET ?`,
        [sessionId, limit, offset],
      )
      .map(mapTerminalEventRow);
    return { sessionId, items, total, limit, offset };
  }

  /** 为 runtime log 镜像出的 terminal event 补充 chunk 文件路径，让 SQLite 索引能指向大文本文件。 */
  setRawChunkPathByRuntimeLogId(runtimeLogId: string, rawChunkPath: string): void {
    this.db.execute(`UPDATE terminal_events SET raw_chunk_path = ? WHERE id = ?`, [rawChunkPath, `terminal_event_${runtimeLogId}`]);
  }
}

const selectConversationFields = `id, project_id, task_id, session_id, title, summary, status, stage, stage_updated_at, created_at, updated_at, archived,
  transport_kind, provider_id, provider_thread_id, provider_thread_path, provider_model, provider_state,
  provider_protocol_version, provider_binary_version, legacy_source_conversation_id, provider_settings_json, provider_token_usage_json, permission_mode, collaboration_mode, next_turn_settings_json, completion_unread, workspace_id, environment_id,
  agent_kind, agent_transport, model_source_id, model_id, native_session_id, native_session_path, capability_snapshot_id`;
const selectConversationMessageFields = `id, conversation_id, role, content, source, metadata_json, created_at,
  provider_thread_id, provider_turn_id, provider_item_id, client_message_id`;

function latestIso(...values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort((left, right) => right.localeCompare(left))[0] ?? '';
}

/**
 * 从持久执行事实投影当前会话阶段。该投影不读取会话正文、配置或阅读状态，避免非阶段变化污染排序。
 */
function deriveConversationStageProjection(db: ZeusDatabase, conversationId: string): { stage: ConversationStage; evidenceAt: string } | null {
  const conversation = db.get<{
    archived: number;
    transport_kind: ConversationTransportKind;
    status: string;
    provider_state: ConversationProviderState;
    created_at: string;
  }>(`SELECT archived, transport_kind, status, provider_state, created_at FROM conversations WHERE id = ?`, [conversationId]);
  if (!conversation) return null;
  if (conversation.archived === 1 || conversation.provider_state === 'archived') return { stage: 'archived', evidenceAt: conversation.created_at };

  const pendingPlanAction = db.get<{ created_at: string }>(`SELECT created_at FROM conversation_plan_actions WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1`, [conversationId]);
  if (pendingPlanAction) return { stage: 'waiting_user', evidenceAt: pendingPlanAction.created_at };

  const pendingRequest = db.get<{ request_kind: ConversationServerRequestKind; created_at: string }>(
    `SELECT request_kind, created_at FROM conversation_server_requests WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [conversationId],
  );
  if (pendingRequest) {
    return {
      stage: pendingRequest.request_kind === 'request_user_input' ? 'waiting_user' : 'waiting_approval',
      evidenceAt: pendingRequest.created_at,
    };
  }

  const activeTurn = db.get<{ started_at: string | null; updated_at: string }>(`SELECT started_at, updated_at FROM conversation_turns WHERE conversation_id = ? AND status = 'running' ORDER BY updated_at DESC, id DESC LIMIT 1`, [
    conversationId,
  ]);
  const activeSubmission = db.get<{ dispatched_at: string | null; updated_at: string }>(
    `SELECT dispatched_at, updated_at FROM conversation_submissions WHERE conversation_id = ? AND status = 'active' ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [conversationId],
  );
  if (activeTurn || activeSubmission || conversation.provider_state === 'active' || conversation.status === 'running') {
    return {
      stage: 'running',
      evidenceAt: latestIso(activeTurn?.started_at, activeTurn?.updated_at, activeSubmission?.dispatched_at, activeSubmission?.updated_at, conversation.created_at),
    };
  }

  const queuedSubmission = db.get<{ created_at: string; updated_at: string }>(
    `SELECT created_at, updated_at FROM conversation_submissions WHERE conversation_id = ? AND status IN ('queued', 'dispatching') ORDER BY created_at ASC, id ASC LIMIT 1`,
    [conversationId],
  );
  if (queuedSubmission) {
    const latestTerminal = db.get<{ completed_at: string | null; updated_at: string }>(
      `SELECT completed_at, updated_at FROM conversation_turns WHERE conversation_id = ? AND status IN ('completed', 'interrupted', 'failed') ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC LIMIT 1`,
      [conversationId],
    );
    return { stage: 'queued', evidenceAt: latestIso(queuedSubmission.created_at, latestTerminal?.completed_at, latestTerminal?.updated_at) };
  }

  const latestTurn = db.get<{ status: string; completed_at: string | null; updated_at: string }>(`SELECT status, completed_at, updated_at FROM conversation_turns WHERE conversation_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`, [
    conversationId,
  ]);
  const latestSubmission = db.get<{ status: string; resolved_at: string | null; updated_at: string }>(
    `SELECT status, resolved_at, updated_at FROM conversation_submissions WHERE conversation_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [conversationId],
  );
  const terminalEvidenceAt = latestIso(latestTurn?.completed_at, latestTurn?.updated_at, latestSubmission?.resolved_at, latestSubmission?.updated_at, conversation.created_at);
  if (conversation.provider_state === 'paused') return { stage: 'paused', evidenceAt: terminalEvidenceAt };
  if (conversation.provider_state === 'failed' || conversation.status === 'failed') return { stage: 'failed', evidenceAt: terminalEvidenceAt };
  if (conversation.provider_state === 'waiting') return { stage: 'waiting_approval', evidenceAt: terminalEvidenceAt };
  if (conversation.provider_state === 'closed') return { stage: 'completed', evidenceAt: terminalEvidenceAt };
  if (conversation.transport_kind === 'legacy_cli') return { stage: 'completed', evidenceAt: conversation.created_at };
  if (conversation.provider_state === 'binding' || conversation.provider_state === 'unbound' || conversation.status === 'starting') {
    return { stage: 'connecting', evidenceAt: conversation.created_at };
  }
  if (conversation.provider_state === 'ready') {
    if (latestTurn?.status === 'failed') return { stage: 'failed', evidenceAt: terminalEvidenceAt };
    if (latestTurn?.status === 'paused' || latestTurn?.status === 'interrupted') return { stage: 'paused', evidenceAt: terminalEvidenceAt };
    if (latestTurn?.status === 'completed') return { stage: 'completed', evidenceAt: terminalEvidenceAt };
    return { stage: 'ready', evidenceAt: terminalEvidenceAt };
  }
  if (latestTurn?.status === 'waiting') return { stage: 'waiting_approval', evidenceAt: terminalEvidenceAt };
  if (latestTurn?.status === 'failed' || latestSubmission?.status === 'failed') return { stage: 'failed', evidenceAt: terminalEvidenceAt };
  if (latestTurn?.status === 'paused' || latestTurn?.status === 'interrupted' || latestSubmission?.status === 'paused') return { stage: 'paused', evidenceAt: terminalEvidenceAt };
  if (latestTurn?.status === 'completed' || latestSubmission?.status === 'completed') return { stage: 'completed', evidenceAt: terminalEvidenceAt };
  return { stage: 'created', evidenceAt: conversation.created_at };
}

/** 只有阶段枚举真正变化时才推进阶段时间，不触碰会话最后更新时间。 */
function syncConversationStage(db: ZeusDatabase, conversationId: string, occurredAt = nowIso()): void {
  const current = db.get<{ stage: ConversationStage; stage_updated_at: string }>(`SELECT stage, stage_updated_at FROM conversations WHERE id = ?`, [conversationId]);
  const projection = deriveConversationStageProjection(db, conversationId);
  if (!current || !projection || current.stage === projection.stage) return;
  db.execute(`UPDATE conversations SET stage = ?, stage_updated_at = ? WHERE id = ?`, [projection.stage, occurredAt, conversationId]);
}

/** 保存一次真实能力检查的版本与结论，不保存命令原文、密钥或对话正文。 */
export class AgentCapabilitySnapshotRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateAgentCapabilitySnapshotInput): ZeusAgentCapabilitySnapshotRecord {
    const record: ZeusAgentCapabilitySnapshotRecord = {
      id: input.id ?? `agent_capability_${nanoid(12)}`,
      agentKind: assertEnum(input.agentKind, ['codex', 'pi', 'claude'] as const, 'agent capability kind'),
      transportKind: assertEnum(input.transportKind, ['app_server', 'rpc', 'sdk'] as const, 'agent capability transport'),
      supportStatus: assertEnum(input.supportStatus, ['unavailable', 'framework_only', 'experimental', 'verified'] as const, 'agent capability support status'),
      adapterVersion: input.adapterVersion ?? null,
      binaryVersion: input.binaryVersion ?? null,
      protocolVersion: input.protocolVersion ?? null,
      capabilitiesJson: JSON.stringify(input.capabilities),
      evidenceJson: JSON.stringify(input.evidence),
      checkedAt: input.checkedAt,
    };
    this.db.execute(
      `INSERT INTO agent_capability_snapshots
       (id, agent_kind, transport_kind, support_status, adapter_version, binary_version, protocol_version, capabilities_json, evidence_json, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.agentKind, record.transportKind, record.supportStatus, record.adapterVersion, record.binaryVersion, record.protocolVersion, record.capabilitiesJson, record.evidenceJson, record.checkedAt],
    );
    return record;
  }

  getById(id: string): ZeusAgentCapabilitySnapshotRecord | undefined {
    const row = this.db.get<DbAgentCapabilitySnapshotRow>(`SELECT * FROM agent_capability_snapshots WHERE id = ?`, [id]);
    return row ? mapAgentCapabilitySnapshotRow(row) : undefined;
  }

  listByAgent(agentKind: ConversationAgentKind, limit = 20): ZeusAgentCapabilitySnapshotRecord[] {
    const normalizedAgentKind = assertEnum(agentKind, ['codex', 'pi', 'claude'] as const, 'agent capability kind');
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
    return this.db.select<DbAgentCapabilitySnapshotRow>(`SELECT * FROM agent_capability_snapshots WHERE agent_kind = ? ORDER BY checked_at DESC, id DESC LIMIT ?`, [normalizedAgentKind, safeLimit]).map(mapAgentCapabilitySnapshotRow);
  }
}

/** 对话仓储保存 AI 对话主记录与消息，不写入任何 seed 对话。 */
export class ConversationRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateConversationInput): ZeusConversationRecord {
    const transportKind = assertEnum(input.transportKind ?? 'legacy_cli', ['legacy_cli', 'codex_native'] as const, 'conversation transport kind');
    const providerState = assertEnum(input.providerState ?? 'unbound', ['unbound', 'binding', 'ready', 'active', 'waiting', 'paused', 'archived', 'closed', 'failed'] as const, 'conversation provider state');
    const permissionMode = assertEnum(input.permissionMode ?? 'read-only', ['read-only', 'auto', 'full-access'] as const, 'conversation permission mode');
    const collaborationMode = assertEnum(input.collaborationMode ?? 'default', ['default', 'plan'] as const, 'conversation collaboration mode');
    const agentKind = input.agentKind ? assertEnum(input.agentKind, ['codex', 'pi', 'claude'] as const, 'conversation agent kind') : transportKind === 'codex_native' ? 'codex' : null;
    const agentTransport = input.agentTransport ? assertEnum(input.agentTransport, ['app_server', 'rpc', 'sdk'] as const, 'conversation agent transport') : transportKind === 'codex_native' ? 'app_server' : null;
    const timestamp = nowIso();
    const record: ZeusConversationRecord = {
      id: input.id ?? `conversation_${nanoid(12)}`,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      workspaceId: input.workspaceId ?? null,
      environmentId: input.environmentId ?? null,
      sessionId: input.sessionId ?? null,
      title: input.title,
      summary: input.summary ?? null,
      status: input.status ?? 'open',
      stage: 'created',
      stageUpdatedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      archived: false,
      transportKind,
      providerId: input.providerId ?? null,
      providerThreadId: input.providerThreadId ?? null,
      providerThreadPath: input.providerThreadPath ?? null,
      providerModel: input.providerModel ?? null,
      providerState,
      providerProtocolVersion: input.providerProtocolVersion ?? null,
      providerBinaryVersion: input.providerBinaryVersion ?? null,
      legacySourceConversationId: input.legacySourceConversationId ?? null,
      providerSettingsJson: '{}',
      providerTokenUsageJson: '{}',
      permissionMode,
      collaborationMode,
      nextTurnSettingsJson: '{}',
      completionUnread: false,
      agentKind,
      agentTransport,
      modelSourceId: input.modelSourceId ?? null,
      modelId: input.modelId ?? input.providerModel ?? null,
      nativeSessionId: input.nativeSessionId ?? input.providerThreadId ?? null,
      nativeSessionPath: input.nativeSessionPath ?? input.providerThreadPath ?? null,
      capabilitySnapshotId: input.capabilitySnapshotId ?? null,
    };
    this.db.execute(
      `INSERT INTO conversations (id, project_id, task_id, workspace_id, environment_id, session_id, title, summary, status, stage, stage_updated_at, created_at, updated_at, archived,
        transport_kind, provider_id, provider_thread_id, provider_thread_path, provider_model, provider_state,
        provider_protocol_version, provider_binary_version, legacy_source_conversation_id, provider_settings_json, provider_token_usage_json, permission_mode, collaboration_mode, next_turn_settings_json, completion_unread,
        agent_kind, agent_transport, model_source_id, model_id, native_session_id, native_session_path, capability_snapshot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.taskId,
        record.workspaceId,
        record.environmentId,
        record.sessionId,
        record.title,
        record.summary,
        record.status,
        record.stage,
        record.stageUpdatedAt,
        record.createdAt,
        record.updatedAt,
        record.transportKind,
        record.providerId,
        record.providerThreadId,
        record.providerThreadPath,
        record.providerModel,
        record.providerState,
        record.providerProtocolVersion,
        record.providerBinaryVersion,
        record.legacySourceConversationId,
        record.providerSettingsJson,
        record.providerTokenUsageJson,
        record.permissionMode,
        record.collaborationMode,
        record.nextTurnSettingsJson,
        record.agentKind,
        record.agentTransport,
        record.modelSourceId,
        record.modelId,
        record.nativeSessionId,
        record.nativeSessionPath,
        record.capabilitySnapshotId,
      ],
    );
    syncConversationStage(this.db, record.id, timestamp);
    return this.getById(record.id) ?? record;
  }

  updatePermissionMode(conversationId: string, permissionMode: ConversationPermissionMode): ZeusConversationWithMessagesRecord {
    const normalized = assertEnum(permissionMode, ['read-only', 'auto', 'full-access'] as const, 'conversation permission mode');
    this.db.execute(`UPDATE conversations SET permission_mode = ?, updated_at = ? WHERE id = ?`, [normalized, nowIso(), conversationId]);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  updateCollaborationMode(conversationId: string, collaborationMode: ConversationCollaborationMode): ZeusConversationWithMessagesRecord {
    const normalized = assertEnum(collaborationMode, ['default', 'plan'] as const, 'conversation collaboration mode');
    this.db.execute(`UPDATE conversations SET collaboration_mode = ?, updated_at = ? WHERE id = ?`, [normalized, nowIso(), conversationId]);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  updateNextTurnSettings(conversationId: string, settings: ConversationNextTurnSettings): ZeusConversationWithMessagesRecord {
    validateNextTurnSettings(settings);
    this.db.execute(`UPDATE conversations SET next_turn_settings_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(settings), nowIso(), conversationId]);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  getNextTurnSettings(conversationId: string): ConversationNextTurnSettings | undefined {
    const row = this.db.get<{ next_turn_settings_json: string }>(`SELECT next_turn_settings_json FROM conversations WHERE id = ?`, [conversationId]);
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.next_turn_settings_json) as unknown;
      validateNextTurnSettings(parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** 完成未读是列表阅读状态，不得改变会话活跃时间或排序。 */
  setCompletionUnread(conversationId: string, completionUnread: boolean): ZeusConversationWithMessagesRecord {
    if (!this.db.get<{ id: string }>(`SELECT id FROM conversations WHERE id = ?`, [conversationId])) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    this.db.execute(`UPDATE conversations SET completion_unread = ? WHERE id = ?`, [completionUnread ? 1 : 0, conversationId]);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  appendMessage(input: AppendConversationMessageInput): ZeusConversationMessageRecord {
    const record: ZeusConversationMessageRecord = {
      id: `conversation_message_${nanoid(12)}`,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      source: input.source,
      metadataJson: JSON.stringify(input.metadata),
      createdAt: input.createdAt,
      providerThreadId: input.providerThreadId ?? null,
      providerTurnId: input.providerTurnId ?? null,
      providerItemId: input.providerItemId ?? null,
      clientMessageId: input.clientMessageId ?? null,
    };
    const params = [record.id, record.conversationId, record.role, record.content, record.source, record.metadataJson, record.createdAt, record.providerThreadId, record.providerTurnId, record.providerItemId, record.clientMessageId];
    if (record.providerItemId) {
      this.db.execute(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, provider_item_id) WHERE provider_item_id IS NOT NULL DO UPDATE SET
           role = excluded.role, content = excluded.content, source = excluded.source, metadata_json = excluded.metadata_json,
           provider_thread_id = excluded.provider_thread_id, provider_turn_id = excluded.provider_turn_id,
           client_message_id = excluded.client_message_id`,
        params,
      );
    } else {
      this.db.execute(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params,
      );
    }
    this.db.execute(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [record.createdAt, record.conversationId]);
    if (!record.providerItemId) return record;
    return this.db
      .select<DbConversationMessageRow>(`SELECT ${selectConversationMessageFields} FROM conversation_messages WHERE conversation_id = ? AND provider_item_id = ?`, [record.conversationId, record.providerItemId])
      .map(mapConversationMessageRow)[0]!;
  }

  bindProvider(conversationId: string, input: BindConversationProviderInput): ZeusConversationWithMessagesRecord {
    assertEnum(input.providerState, ['unbound', 'binding', 'ready', 'active', 'waiting', 'paused', 'archived', 'closed', 'failed'] as const, 'conversation provider state');
    const timestamp = nowIso();
    this.db.execute(
      `UPDATE conversations SET transport_kind = 'codex_native', provider_id = ?, provider_thread_id = ?, provider_thread_path = COALESCE(?, provider_thread_path),
       provider_model = COALESCE(?, provider_model), provider_state = ?, provider_protocol_version = COALESCE(?, provider_protocol_version), provider_binary_version = COALESCE(?, provider_binary_version),
       agent_kind = 'codex', agent_transport = 'app_server', model_id = COALESCE(?, model_id), native_session_id = ?, native_session_path = COALESCE(?, native_session_path), updated_at = ? WHERE id = ?`,
      [
        input.providerId,
        input.providerThreadId,
        input.providerThreadPath ?? null,
        input.providerModel ?? null,
        input.providerState,
        input.providerProtocolVersion ?? null,
        input.providerBinaryVersion ?? null,
        input.providerModel ?? null,
        input.providerThreadId,
        input.providerThreadPath ?? null,
        timestamp,
        conversationId,
      ],
    );
    syncConversationStage(this.db, conversationId, timestamp);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  updateProviderThreadPath(conversationId: string, input: { providerThreadId: string; providerThreadPath: string }): ZeusConversationWithMessagesRecord {
    const providerThreadPath = input.providerThreadPath;
    if (!providerThreadPath.trim()) throw new Error('Provider thread path is required.');
    this.db.execute(
      `UPDATE conversations SET provider_thread_path = ?, native_session_path = ?
       WHERE id = ? AND provider_thread_id = ?`,
      [providerThreadPath, providerThreadPath, conversationId, input.providerThreadId],
    );
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    if (updated.providerThreadId !== input.providerThreadId || updated.providerThreadPath !== providerThreadPath || updated.nativeSessionPath !== providerThreadPath) {
      throw new Error(`Zeus conversation provider thread does not match: ${conversationId}`);
    }
    return updated;
  }

  upsertProviderSettingsSnapshot(conversationId: string, snapshot: ConversationProviderSettingsSnapshot): ConversationProviderSettingsSnapshot | undefined {
    return this.upsertConversationSnapshot(conversationId, 'provider_settings_json', snapshot);
  }

  getProviderSettingsSnapshot(conversationId: string): ConversationProviderSettingsSnapshot | undefined {
    return this.getConversationSnapshot<ConversationProviderSettingsSnapshot>(conversationId, 'provider_settings_json');
  }

  upsertProviderTokenUsageSnapshot(conversationId: string, snapshot: ConversationProviderTokenUsageSnapshot): ConversationProviderTokenUsageSnapshot | undefined {
    return this.upsertConversationSnapshot(conversationId, 'provider_token_usage_json', snapshot);
  }

  getProviderTokenUsageSnapshot(conversationId: string): ConversationProviderTokenUsageSnapshot | undefined {
    const snapshot = this.getConversationSnapshot<ConversationProviderTokenUsageSnapshot & { inputTokens?: number; outputTokens?: number; totalTokens?: number }>(conversationId, 'provider_token_usage_json');
    if (!snapshot) return undefined;
    if (snapshot.total && snapshot.last) return snapshot;
    if ([snapshot.inputTokens, snapshot.outputTokens, snapshot.totalTokens].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      const total: TokenUsageBreakdown = {
        totalTokens: snapshot.totalTokens!,
        inputTokens: snapshot.inputTokens!,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: snapshot.outputTokens!,
        reasoningOutputTokens: 0,
      };
      return {
        generationId: snapshot.generationId,
        sequence: snapshot.sequence,
        total,
        last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        modelContextWindow: null,
        cacheHitRate: null,
        estimatedCredits: null,
        apiEquivalentUsd: null,
        cacheSavingsUsd: null,
        priceCoverage: null,
        pricingCatalogDate: null,
        pricingSourceUrls: [],
        historyComplete: false,
      };
    }
    return undefined;
  }

  private upsertConversationSnapshot<T extends ProviderSequenceSnapshot>(conversationId: string, column: 'provider_settings_json' | 'provider_token_usage_json', snapshot: T): T | undefined {
    if (column === 'provider_settings_json') validateProviderSettingsSnapshot(snapshot);
    else validateProviderTokenUsageSnapshot(snapshot);
    const current = this.getConversationSnapshot<T>(conversationId, column);
    if (!shouldAcceptProviderSnapshot(this.db, snapshot, current)) return current;
    this.db.execute(`UPDATE conversations SET ${column} = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(snapshot), nowIso(), conversationId]);
    if (!this.db.get<{ id: string }>(`SELECT id FROM conversations WHERE id = ?`, [conversationId])) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return snapshot;
  }

  private getConversationSnapshot<T extends ProviderSequenceSnapshot>(conversationId: string, column: 'provider_settings_json' | 'provider_token_usage_json'): T | undefined {
    const row = this.db.get<{ value_json: string }>(`SELECT ${column} AS value_json FROM conversations WHERE id = ?`, [conversationId]);
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.value_json) as T;
      return typeof parsed.generationId === 'string' && typeof parsed.sequence === 'number' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  updateRuntimeState(conversationId: string, input: UpdateConversationRuntimeStateInput): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    const timestamp = nowIso();
    const assignments = ['updated_at = ?'];
    const values: Array<string | number | null> = [timestamp];
    if ('sessionId' in input) {
      assignments.push('session_id = ?');
      values.push(input.sessionId ?? null);
    }
    if ('status' in input) {
      assignments.push('status = ?');
      values.push(input.status ?? existing.status);
    }
    if ('summary' in input) {
      assignments.push('summary = ?');
      values.push(input.summary ?? null);
    }
    this.db.execute(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`, [...values, conversationId]);
    syncConversationStage(this.db, conversationId, timestamp);
    const updated = this.getById(conversationId);
    if (!updated) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    return updated;
  }

  /** 通用 Agent 运行态更新，不把 Pi SDK 伪装成 Codex app-server。 */
  updateAgentRuntime(conversationId: string, input: { providerState?: ConversationProviderState; status?: string; modelSourceId?: string | null; modelId?: string | null; providerModel?: string | null }): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) throw new Error(`Zeus conversation not found: ${conversationId}`);
    const timestamp = nowIso();
    const assignments = ['updated_at = ?'];
    const values: Array<string | number | null> = [timestamp];
    if (input.providerState) {
      assignments.push('provider_state = ?');
      values.push(assertEnum(input.providerState, ['unbound', 'binding', 'ready', 'active', 'waiting', 'paused', 'archived', 'closed', 'failed'] as const, 'conversation provider state'));
    }
    if (input.status) {
      assignments.push('status = ?');
      values.push(input.status);
    }
    if ('modelSourceId' in input) {
      assignments.push('model_source_id = ?');
      values.push(input.modelSourceId ?? null);
    }
    if ('modelId' in input) {
      assignments.push('model_id = ?');
      values.push(input.modelId ?? null);
    }
    if ('providerModel' in input) {
      assignments.push('provider_model = ?');
      values.push(input.providerModel ?? null);
    }
    this.db.execute(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`, [...values, conversationId]);
    syncConversationStage(this.db, conversationId, timestamp);
    return this.getById(conversationId)!;
  }

  listMessages(conversationId: string): ZeusConversationMessageRecord[] {
    return this.db
      .select<DbConversationMessageRow>(
        `SELECT ${selectConversationMessageFields}
       FROM conversation_messages WHERE conversation_id = ${toSqlStringLiteral(conversationId)} ORDER BY created_at ASC, id ASC`,
      )
      .map(mapConversationMessageRow);
  }

  getRecordById(conversationId: string): ZeusConversationRecord | undefined {
    const row = this.db.get<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE id = ?`, [conversationId]);
    return row ? mapConversationRow(row) : undefined;
  }

  getById(conversationId: string): ZeusConversationWithMessagesRecord | undefined {
    const conversation = this.getRecordById(conversationId);
    if (!conversation) return undefined;
    return { ...conversation, messages: this.listMessages(conversation.id) };
  }

  getByProviderThreadId(providerThreadId: string): ZeusConversationWithMessagesRecord | undefined {
    const row = this.db.get<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE provider_thread_id = ? AND archived = 0`, [providerThreadId]);
    if (!row) return undefined;
    const conversation = mapConversationRow(row);
    return { ...conversation, messages: this.listMessages(conversation.id) };
  }

  /** 只读取已绑定原生会话元数据，供状态投影和枚举路径使用。 */
  listNativeBoundRecords(agentKind?: ConversationAgentKind): ZeusConversationRecord[] {
    const agentClause = agentKind ? ' AND agent_kind = ?' : '';
    return this.db
      .select<DbConversationRow>(
        `SELECT ${selectConversationFields} FROM conversations WHERE transport_kind = 'codex_native' AND provider_thread_id IS NOT NULL AND provider_state NOT IN ('closed', 'failed') AND archived = 0${agentClause} ORDER BY created_at, id`,
        agentKind ? [agentKind] : [],
      )
      .map(mapConversationRow);
  }

  listNativeBound(agentKind?: ConversationAgentKind): ZeusConversationWithMessagesRecord[] {
    return this.listNativeBoundRecords(agentKind).map((conversation) => ({ ...conversation, messages: this.listMessages(conversation.id) }));
  }

  /** 身份修复候选包含已归档或失败会话，保证历史记录恢复后仍按原 Agent 路由。 */
  listNativeIdentityCandidates(): ZeusConversationWithMessagesRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE transport_kind = 'codex_native' AND provider_thread_id IS NOT NULL ORDER BY created_at, id`).map((row) => {
      const conversation = mapConversationRow(row);
      return { ...conversation, messages: this.listMessages(conversation.id) };
    });
  }

  /** 只有调用方已经核验 Pi 原生会话和消息证据时，才允许纠正被 Codex 恢复器污染的主身份。 */
  repairPiAgentIdentity(input: { conversationId: string; nativeSessionId: string; nativeSessionPath: string; modelSourceId: string }): boolean {
    this.db.execute(
      `UPDATE conversations
       SET provider_id = ?, provider_protocol_version = 'sdk',
           provider_binary_version = CASE WHEN provider_binary_version LIKE 'pi-sdk-%' THEN provider_binary_version ELSE NULL END,
           agent_kind = 'pi', agent_transport = 'sdk'
       WHERE id = ? AND transport_kind = 'codex_native' AND COALESCE(agent_kind, '') <> 'pi'
         AND provider_thread_id = native_session_id AND provider_thread_id = ?
         AND provider_thread_path = native_session_path AND native_session_path = ?
         AND model_source_id = ?
         AND EXISTS (
           SELECT 1 FROM conversation_messages
           WHERE conversation_messages.conversation_id = conversations.id
             AND conversation_messages.source = 'pi_sdk'
             AND conversation_messages.provider_thread_id = conversations.native_session_id
         )`,
      [`pi:${input.modelSourceId}`, input.conversationId, input.nativeSessionId, input.nativeSessionPath, input.modelSourceId],
    );
    return (this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) === 1;
  }

  /** 侧边栏状态聚合只读取会话主记录，不加载消息正文。 */
  listUnarchivedRecords(): ZeusConversationRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE archived = 0 ORDER BY updated_at DESC, id DESC`).map(mapConversationRow);
  }

  /** 会话选择列表只读取主记录，避免为每条会话加载完整消息正文。 */
  listRecordsByProject(projectId: string, options: ConversationRecordListOptions = {}): ZeusConversationRecord[] {
    return this.db
      .select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE project_id = ? AND archived = ? ORDER BY stage_updated_at DESC, created_at DESC, id DESC`, [projectId, options.archived === true ? 1 : 0])
      .map(mapConversationRow);
  }

  /** 精准任务刷新沿用同一元数据投影，不再扫描项目会话或消息。 */
  listRecordsByTask(taskId: string, options: ConversationRecordListOptions = {}): ZeusConversationRecord[] {
    return this.db
      .select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE task_id = ? AND archived = ? ORDER BY stage_updated_at DESC, created_at DESC, id DESC`, [taskId, options.archived === true ? 1 : 0])
      .map(mapConversationRow);
  }

  /** Runtime 日志镜像按会话身份定位时只需要主记录，不读取历史消息。 */
  listRecordsBySessionId(sessionId: string): ZeusConversationRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE session_id = ? ORDER BY updated_at DESC, id DESC`, [sessionId]).map(mapConversationRow);
  }

  listByWorkspace(workspaceId: string): ZeusConversationWithMessagesRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE workspace_id = ? AND archived = 0 ORDER BY updated_at DESC, id`, [workspaceId]).map((row) => {
      const conversation = mapConversationRow(row);
      return { ...conversation, messages: this.listMessages(conversation.id) };
    });
  }

  listByEnvironment(environmentId: string): ZeusConversationWithMessagesRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE environment_id = ? AND archived = 0 ORDER BY updated_at DESC, id`, [environmentId]).map((row) => {
      const conversation = mapConversationRow(row);
      return { ...conversation, messages: this.listMessages(conversation.id) };
    });
  }

  listByTask(taskId: string): ZeusConversationWithMessagesRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE task_id = ? AND archived = 0 ORDER BY updated_at DESC, id`, [taskId]).map((row) => {
      const conversation = mapConversationRow(row);
      return { ...conversation, messages: this.listMessages(conversation.id) };
    });
  }

  /** 父任务上下文选择需要同时看到未归档和已归档会话，不改变常规会话列表的隐藏规则。 */
  listAllByTask(taskId: string): ZeusConversationWithMessagesRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE task_id = ? ORDER BY created_at ASC, id`, [taskId]).map((row) => {
      const conversation = mapConversationRow(row);
      return { ...conversation, messages: this.listMessages(conversation.id) };
    });
  }

  listBySessionId(sessionId: string): ZeusConversationWithMessagesRecord[] {
    return this.db
      .select<DbConversationRow>(
        `SELECT ${selectConversationFields}
       FROM conversations WHERE session_id = ${toSqlStringLiteral(sessionId)} ORDER BY updated_at DESC, id DESC`,
      )
      .map((row) => {
        const conversation = mapConversationRow(row);
        return { ...conversation, messages: this.listMessages(conversation.id) };
      });
  }

  listByProject(projectId: string, options: ConversationListOptions = {}): ConversationListResult {
    const query = options.query?.trim().toLowerCase() ?? '';
    const limit = clampConversationLimit(options.limit);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const archived = options.archived === true;
    const allRows = this.db.select<DbConversationRow>(
      `SELECT ${selectConversationFields}
       FROM conversations WHERE project_id = ${toSqlStringLiteral(projectId)} AND archived = ${archived ? 1 : 0} ORDER BY updated_at DESC, id DESC`,
    );
    const matchedRows = allRows.filter((row) => {
      if (!query) return true;
      const messages = this.listMessages(row.id);
      // 搜索覆盖标题、摘要、会话与消息正文，避免用户记得答案片段却找不到历史记录。
      return `${row.title}\n${row.summary ?? ''}\n${row.session_id ?? ''}\n${messages.map((message) => message.content).join('\n')}`.toLowerCase().includes(query);
    });
    const rows = matchedRows.slice(offset, offset + limit);
    return {
      items: rows.map((row) => {
        const conversation = mapConversationRow(row);
        return {
          ...conversation,
          messages: this.listMessages(conversation.id),
        };
      }),
      total: matchedRows.length,
      limit,
      offset,
      query: query || null,
      archived,
    };
  }

  archive(conversationId: string): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    const timestamp = nowIso();
    // 归档只隐藏会话列表，不删除消息，保证图谱问答证据链可恢复。
    this.db.execute(`UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ${toSqlStringLiteral(conversationId)}`, [1, timestamp]);
    syncConversationStage(this.db, conversationId, timestamp);
    const archived = this.getById(conversationId);
    if (!archived) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    return archived;
  }

  restore(conversationId: string): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    const timestamp = nowIso();
    this.db.execute(`UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ${toSqlStringLiteral(conversationId)}`, [0, timestamp]);
    syncConversationStage(this.db, conversationId, timestamp);
    const restored = this.getById(conversationId);
    if (!restored) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    return restored;
  }

  listByProjectLegacy(projectId: string, limit = 20): ZeusConversationWithMessagesRecord[] {
    return this.listByProject(projectId, { limit }).items;
  }
}

export class CodexLegacyImportRepository {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(
    private readonly db: ZeusDatabase,
    options: { now?: () => string; id?: () => string } = {},
  ) {
    this.now = options.now ?? nowIso;
    this.createId = options.id ?? (() => `codex_legacy_import_${nanoid(12)}`);
  }

  createRun(input: CreateCodexLegacyImportRunInput): ZeusCodexLegacyImportRecord {
    const existing = this.db.get<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE source_conversation_id = ? AND snapshot_sha256 = ?`, [input.sourceConversationId, input.snapshotSha256]);
    if (existing) return mapCodexLegacyImportRow(existing);
    if (!/^[a-f0-9]{64}$/u.test(input.snapshotSha256)) throw new Error('Codex legacy snapshot SHA-256 is invalid.');
    const source = this.db.get<{ id: string }>(`SELECT id FROM conversations WHERE id = ?`, [input.sourceConversationId]);
    if (!source) throw new Error(`Codex legacy source conversation not found: ${input.sourceConversationId}`);
    const timestamp = this.now();
    const id = this.createId();
    this.db.execute(
      `INSERT INTO codex_legacy_imports
       (id, provider_import_id, source_conversation_id, target_conversation_id, snapshot_path, snapshot_sha256, status,
        target_thread_id, failure_stage, failure_message, provider_binary_version, created_at, updated_at, started_at, completed_at)
       VALUES (?, NULL, ?, NULL, ?, ?, 'prepared', NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      [id, input.sourceConversationId, input.snapshotPath, input.snapshotSha256, input.providerBinaryVersion, timestamp, timestamp],
    );
    return this.getById(id)!;
  }

  getById(id: string): ZeusCodexLegacyImportRecord | undefined {
    const row = this.db.get<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE id = ?`, [id]);
    return row ? mapCodexLegacyImportRow(row) : undefined;
  }

  getByImportId(providerImportId: string): ZeusCodexLegacyImportRecord[] {
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE provider_import_id = ? ORDER BY created_at, id`, [providerImportId]).map(mapCodexLegacyImportRow);
  }

  listBySourceConversation(sourceConversationId: string): ZeusCodexLegacyImportRecord[] {
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE source_conversation_id = ? ORDER BY created_at DESC, id DESC`, [sourceConversationId]).map(mapCodexLegacyImportRow);
  }

  listRecoverable(): ZeusCodexLegacyImportRecord[] {
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE status IN ('prepared', 'waiting') ORDER BY created_at, id`).map(mapCodexLegacyImportRow);
  }

  listRecent(limit = 100): ZeusCodexLegacyImportRecord[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports ORDER BY updated_at DESC, id DESC LIMIT ?`, [safeLimit]).map(mapCodexLegacyImportRow);
  }

  markStarted(id: string, providerImportId: string): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status !== 'prepared') throw new Error(`Invalid Codex legacy import transition: ${record.status} -> waiting.`);
    if (!providerImportId.trim()) throw new Error('Codex legacy provider import id is required.');
    const timestamp = this.now();
    this.db.execute(
      `UPDATE codex_legacy_imports SET provider_import_id = ?, status = 'waiting', failure_stage = NULL, failure_message = NULL,
       started_at = ?, updated_at = ? WHERE id = ?`,
      [providerImportId, timestamp, timestamp, id],
    );
    return this.requireById(id);
  }

  markCompleted(id: string, targetThreadId: string, targetConversationId: string): ZeusCodexLegacyImportRecord {
    const record = this.requireTransition(id, 'waiting', 'completed');
    if (!targetThreadId.trim() || !targetConversationId.trim()) throw new Error('Codex legacy import completion requires target identities.');
    const timestamp = this.now();
    this.db.execute(
      `UPDATE codex_legacy_imports SET status = 'completed', target_thread_id = ?, target_conversation_id = ?,
       failure_stage = NULL, failure_message = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?`,
      [targetThreadId, targetConversationId, timestamp, timestamp, id, record.status],
    );
    return this.requireById(id);
  }

  markFailed(id: string, input: { stage: string; message: string }): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status === 'completed') throw new Error('Invalid Codex legacy import transition: completed -> failed.');
    const timestamp = this.now();
    this.db.execute(`UPDATE codex_legacy_imports SET status = 'failed', failure_stage = ?, failure_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [input.stage, input.message, timestamp, timestamp, id]);
    return this.requireById(id);
  }

  retryFailed(id: string): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status !== 'failed') throw new Error(`Invalid Codex legacy import transition: ${record.status} -> prepared.`);
    const timestamp = this.now();
    this.db.execute(
      `UPDATE codex_legacy_imports SET provider_import_id = NULL, status = 'prepared', target_thread_id = NULL,
       target_conversation_id = NULL, failure_stage = NULL, failure_message = NULL, started_at = NULL,
       completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'failed'`,
      [timestamp, id],
    );
    return this.requireById(id);
  }

  bindThreadAndArchiveSource(input: { id: string; targetThreadId: string; providerBinaryVersion: string }): { run: ZeusCodexLegacyImportRecord; conversation: ZeusConversationWithMessagesRecord } {
    if (!input.targetThreadId.trim()) throw new Error('Codex legacy import target thread id is required.');
    const run = this.requireTransition(input.id, 'waiting', 'completed');
    const targetConversationId = `conversation_${nanoid(12)}`;
    this.db.transaction(() => {
      const source = this.db.get<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE id = ? AND transport_kind = 'legacy_cli' AND archived = 0`, [run.sourceConversationId]);
      if (!source) throw new Error(`Eligible Codex legacy source conversation not found: ${run.sourceConversationId}`);
      const timestamp = this.now();
      this.db.execute(
        `INSERT INTO conversations
         (id, project_id, task_id, session_id, title, summary, status, created_at, updated_at, archived,
          transport_kind, provider_id, provider_thread_id, provider_thread_path, provider_model, provider_state,
          provider_protocol_version, provider_binary_version, legacy_source_conversation_id, provider_settings_json, provider_token_usage_json,
          agent_kind, agent_transport, native_session_id)
         VALUES (?, ?, ?, NULL, ?, ?, 'open', ?, ?, 0, 'codex_native', 'codex', ?, NULL, NULL, 'ready', ?, ?, ?, '{}', '{}', 'codex', 'app_server', ?)`,
        [targetConversationId, source.project_id, source.task_id, source.title, source.summary, timestamp, timestamp, input.targetThreadId, input.providerBinaryVersion, input.providerBinaryVersion, source.id, input.targetThreadId],
      );
      const sourceMessages = this.db.select<DbConversationMessageRow>(`SELECT ${selectConversationMessageFields} FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id`, [source.id]);
      for (const message of sourceMessages) {
        this.db.execute(
          `INSERT INTO conversation_messages
           (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `conversation_message_${nanoid(12)}`,
            targetConversationId,
            message.role,
            message.content,
            message.source,
            message.metadata_json,
            message.created_at,
            input.targetThreadId,
            message.provider_turn_id,
            message.provider_item_id,
            message.client_message_id,
          ],
        );
      }
      this.db.execute(`UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?`, [timestamp, source.id]);
      this.db.execute(
        `UPDATE codex_legacy_imports SET status = 'completed', target_thread_id = ?, target_conversation_id = ?, provider_binary_version = ?,
         failure_stage = NULL, failure_message = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`,
        [input.targetThreadId, targetConversationId, input.providerBinaryVersion, timestamp, timestamp, input.id],
      );
    });
    const conversation = new ConversationRepository(this.db).getById(targetConversationId);
    if (!conversation) throw new Error(`Imported Codex conversation not found: ${targetConversationId}`);
    return { run: this.requireById(input.id), conversation };
  }

  private requireById(id: string): ZeusCodexLegacyImportRecord {
    const record = this.getById(id);
    if (!record) throw new Error(`Codex legacy import record not found: ${id}`);
    return record;
  }

  private requireTransition(id: string, from: CodexLegacyImportStatus, to: CodexLegacyImportStatus): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status !== from) throw new Error(`Invalid Codex legacy import transition: ${record.status} -> ${to}.`);
    return record;
  }
}

export class ConversationTurnRepository {
  constructor(private readonly db: ZeusDatabase) {}

  upsert(
    input: Omit<ZeusConversationTurnRecord, 'id' | 'errorJson' | 'planJson' | 'agentKind' | 'nativeRunId'> & {
      id?: string;
      error?: unknown;
      agentKind?: ConversationAgentKind | null;
      nativeRunId?: string | null;
    },
  ): ZeusConversationTurnRecord {
    const status = assertEnum(input.status, ['queued', 'dispatching', 'running', 'waiting', 'paused', 'completed', 'interrupted', 'failed'] as const, 'conversation turn status');
    const existing = input.providerTurnId ? this.db.get<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE provider_thread_id = ? AND provider_turn_id = ?`, [input.providerThreadId, input.providerTurnId]) : undefined;
    if (existing?.status === 'completed') return mapConversationTurnRow(existing);
    const id = existing?.id ?? input.id ?? `conversation_turn_${nanoid(12)}`;
    const errorJson = input.error === undefined ? null : JSON.stringify(input.error);
    this.db.execute(
      `INSERT INTO conversation_turns (id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status, error_json, started_at, completed_at, created_at, updated_at, agent_kind, native_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider_thread_id = excluded.provider_thread_id, provider_turn_id = excluded.provider_turn_id,
       status = excluded.status, error_json = excluded.error_json, started_at = COALESCE(excluded.started_at, conversation_turns.started_at),
       completed_at = excluded.completed_at, updated_at = excluded.updated_at, agent_kind = excluded.agent_kind, native_run_id = COALESCE(excluded.native_run_id, conversation_turns.native_run_id)`,
      [
        id,
        input.conversationId,
        input.providerThreadId,
        input.providerTurnId,
        input.clientSubmissionId,
        status,
        errorJson,
        input.startedAt,
        input.completedAt,
        input.createdAt,
        input.updatedAt,
        input.agentKind ?? 'codex',
        input.nativeRunId ?? input.providerTurnId,
      ],
    );
    syncConversationStage(this.db, input.conversationId, input.updatedAt);
    return mapConversationTurnRow(this.db.get<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE id = ?`, [id])!);
  }

  getById(id: string): ZeusConversationTurnRecord | undefined {
    const row = this.db.get<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE id = ?`, [id]);
    return row ? mapConversationTurnRow(row) : undefined;
  }

  updatePlan(
    id: string,
    plan: {
      explanation: string | null;
      steps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>;
    },
    updatedAt: string,
  ): ZeusConversationTurnRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation turn not found: ${id}`);
    const planJson = JSON.stringify(plan);
    this.db.execute(`UPDATE conversation_turns SET plan_json = ?, updated_at = ? WHERE id = ?`, [planJson, updatedAt, id]);
    return this.getById(id)!;
  }

  listByConversation(conversationId: string): ZeusConversationTurnRecord[] {
    return this.db.select<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapConversationTurnRow);
  }

  getLatestActiveByConversation(conversationId: string): ZeusConversationTurnRecord | undefined {
    const row = this.db.get<DbConversationTurnRow>(
      `SELECT id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status,
              NULL AS error_json, NULL AS plan_json, started_at, completed_at, created_at, updated_at, agent_kind, native_run_id
         FROM conversation_turns
        WHERE conversation_id = ? AND status IN ('running', 'dispatching', 'waiting')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [conversationId],
    );
    return row ? mapConversationTurnRow(row) : undefined;
  }

  /** 批量投影会话运行态时不加载错误和计划正文，避免逐会话查询与大 JSON 放大。 */
  listInProgress(): ZeusConversationTurnRecord[] {
    return this.db
      .select<DbConversationTurnRow>(
        `SELECT id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status,
                NULL AS error_json, NULL AS plan_json, started_at, completed_at, created_at, updated_at, agent_kind, native_run_id
         FROM conversation_turns
         WHERE status IN ('queued', 'dispatching', 'running', 'waiting', 'paused')
         ORDER BY conversation_id, created_at, id`,
      )
      .map(mapConversationTurnRow);
  }
}

/** Codex 用量账本不建立外键，被引用对象删除后仍保留真实历史消耗。 */
export class CodexUsageLedgerRepository {
  constructor(private readonly db: ZeusDatabase) {}

  upsert(input: UpsertCodexUsageLedgerInput): CodexUsageLedgerRecord {
    validateTokenUsageBreakdown(input.usage);
    validateCodexUsageEstimate(input.estimate);
    if (![input.providerId, input.accountScopeId, input.projectId, input.conversationId, input.providerThreadId, input.providerTurnId, input.model].every((value) => value.trim())) {
      throw new Error('Codex usage ledger identity is incomplete');
    }
    const existing = this.findByProviderTurn(input.providerId, input.providerThreadId, input.providerTurnId);
    const timestamp = nowIso();
    const id = existing?.id ?? `codex_usage_${nanoid(12)}`;
    const createdAt = existing?.createdAt ?? timestamp;
    this.db.execute(
      `INSERT INTO codex_usage_ledger
         (id, provider_id, account_scope_id, project_id, conversation_id, provider_thread_id, provider_turn_id, model, service_tier,
          total_tokens, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens,
          estimate_json, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, provider_thread_id, provider_turn_id) DO UPDATE SET
         account_scope_id = excluded.account_scope_id,
         project_id = excluded.project_id,
         conversation_id = excluded.conversation_id,
         model = excluded.model,
         service_tier = excluded.service_tier,
         total_tokens = excluded.total_tokens,
         input_tokens = excluded.input_tokens,
         cached_input_tokens = excluded.cached_input_tokens,
         cache_write_input_tokens = excluded.cache_write_input_tokens,
         output_tokens = excluded.output_tokens,
         reasoning_output_tokens = excluded.reasoning_output_tokens,
         estimate_json = excluded.estimate_json,
         occurred_at = excluded.occurred_at,
         updated_at = excluded.updated_at`,
      [
        id,
        input.providerId,
        input.accountScopeId,
        input.projectId,
        input.conversationId,
        input.providerThreadId,
        input.providerTurnId,
        input.model,
        input.serviceTier ?? null,
        input.usage.totalTokens,
        input.usage.inputTokens,
        input.usage.cachedInputTokens,
        input.usage.cacheWriteInputTokens,
        input.usage.outputTokens,
        input.usage.reasoningOutputTokens,
        JSON.stringify(input.estimate),
        input.occurredAt,
        createdAt,
        timestamp,
      ],
    );
    return this.findByProviderTurn(input.providerId, input.providerThreadId, input.providerTurnId)!;
  }

  findByProviderTurn(providerId: string, providerThreadId: string, providerTurnId: string): CodexUsageLedgerRecord | undefined {
    const row = this.db.get<DbCodexUsageLedgerRow>(`SELECT * FROM codex_usage_ledger WHERE provider_id = ? AND provider_thread_id = ? AND provider_turn_id = ?`, [providerId, providerThreadId, providerTurnId]);
    return row ? mapCodexUsageLedgerRow(row) : undefined;
  }

  list(input: ListCodexUsageLedgerInput = {}): CodexUsageLedgerRecord[] {
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    if (input.accountScopeId) {
      clauses.push('account_scope_id = ?');
      values.push(input.accountScopeId);
    }
    if (input.since) {
      clauses.push('occurred_at >= ?');
      values.push(input.since);
    }
    if (input.projectId) {
      clauses.push('project_id = ?');
      values.push(input.projectId);
    }
    if (input.model) {
      clauses.push('model = ?');
      values.push(input.model);
    }
    if (input.conversationId) {
      clauses.push('conversation_id = ?');
      values.push(input.conversationId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.select<DbCodexUsageLedgerRow>(`SELECT * FROM codex_usage_ledger${where} ORDER BY occurred_at ASC, id ASC`, values).map(mapCodexUsageLedgerRow);
  }

  collectionStartedAt(accountScopeId?: string | null): string | null {
    return accountScopeId
      ? (this.db.get<{ occurred_at: string }>(`SELECT occurred_at FROM codex_usage_ledger WHERE account_scope_id = ? ORDER BY occurred_at ASC, id ASC LIMIT 1`, [accountScopeId])?.occurred_at ?? null)
      : (this.db.get<{ occurred_at: string }>(`SELECT occurred_at FROM codex_usage_ledger ORDER BY occurred_at ASC, id ASC LIMIT 1`)?.occurred_at ?? null);
  }
}

type ConversationItemBaseInput = {
  conversationId: string;
  turnId: string;
  providerThreadId: string;
  providerTurnId: string;
  providerItemId: string;
  itemType: ConversationItemType;
  phase: ConversationItemPhase;
  payload: unknown;
  startedAt?: string | null;
  updatedAt: string;
  agentKind?: ConversationAgentKind;
  nativeItemId?: string;
};

export class ConversationItemRepository {
  constructor(private readonly db: ZeusDatabase) {}

  appendDelta(input: ConversationItemBaseInput & { delta: string; status?: ConversationItemStatus }): ZeusConversationItemRecord {
    const itemType = assertEnum(
      input.itemType,
      ['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'plan', 'imageView', 'webSearch', 'contextCompaction', 'error'] as const,
      'conversation item type',
    );
    const status = assertEnum(input.status ?? 'in_progress', ['in_progress', 'completed', 'failed'] as const, 'conversation item status');
    const phase = assertEnum(input.phase, ['prework', 'final_answer'] as const, 'conversation item phase');
    const existing = this.getByProvider(input.providerThreadId, input.providerItemId);
    if (existing?.status === 'completed') return existing;
    const id = existing?.id ?? `conversation_item_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_items (id, conversation_id, turn_id, provider_thread_id, provider_turn_id, provider_item_id, item_type, status, phase, text_content, payload_json, started_at, completed_at, updated_at, agent_kind, native_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(provider_thread_id, provider_item_id) DO UPDATE SET
       turn_id = excluded.turn_id, provider_turn_id = excluded.provider_turn_id, item_type = excluded.item_type,
       status = excluded.status, phase = excluded.phase, text_content = conversation_items.text_content || excluded.text_content,
       payload_json = excluded.payload_json, started_at = COALESCE(conversation_items.started_at, excluded.started_at), updated_at = excluded.updated_at,
       agent_kind = excluded.agent_kind, native_item_id = excluded.native_item_id`,
      [
        id,
        input.conversationId,
        input.turnId,
        input.providerThreadId,
        input.providerTurnId,
        input.providerItemId,
        itemType,
        status,
        phase,
        input.delta,
        JSON.stringify(input.payload),
        input.startedAt ?? null,
        input.updatedAt,
        input.agentKind ?? 'codex',
        input.nativeItemId ?? input.providerItemId,
      ],
    );
    return this.getByProvider(input.providerThreadId, input.providerItemId)!;
  }

  upsertProgress(input: ConversationItemBaseInput & { textContent: string; status?: ConversationItemStatus }): ZeusConversationItemRecord {
    const itemType = assertEnum(
      input.itemType,
      ['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'plan', 'imageView', 'webSearch', 'contextCompaction', 'error'] as const,
      'conversation item type',
    );
    const status = assertEnum(input.status ?? 'in_progress', ['in_progress', 'completed', 'failed'] as const, 'conversation item status');
    const phase = assertEnum(input.phase, ['prework', 'final_answer'] as const, 'conversation item phase');
    const existing = this.getByProvider(input.providerThreadId, input.providerItemId);
    if (existing?.status === 'completed') return existing;
    const id = existing?.id ?? `conversation_item_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_items (id, conversation_id, turn_id, provider_thread_id, provider_turn_id, provider_item_id, item_type, status, phase, text_content, payload_json, started_at, completed_at, updated_at, agent_kind, native_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(provider_thread_id, provider_item_id) DO UPDATE SET
       turn_id = excluded.turn_id, provider_turn_id = excluded.provider_turn_id, item_type = excluded.item_type,
       status = excluded.status, phase = excluded.phase, text_content = excluded.text_content,
       payload_json = excluded.payload_json, started_at = COALESCE(conversation_items.started_at, excluded.started_at),
       updated_at = excluded.updated_at, agent_kind = excluded.agent_kind, native_item_id = excluded.native_item_id`,
      [
        id,
        input.conversationId,
        input.turnId,
        input.providerThreadId,
        input.providerTurnId,
        input.providerItemId,
        itemType,
        status,
        phase,
        input.textContent,
        JSON.stringify(input.payload),
        input.startedAt ?? null,
        input.updatedAt,
        input.agentKind ?? 'codex',
        input.nativeItemId ?? input.providerItemId,
      ],
    );
    return this.getByProvider(input.providerThreadId, input.providerItemId)!;
  }

  upsertCompleted(input: ConversationItemBaseInput & { textContent: string; completedAt: string | null; status?: ConversationItemStatus }): ZeusConversationItemRecord {
    const itemType = assertEnum(
      input.itemType,
      ['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'plan', 'imageView', 'webSearch', 'contextCompaction', 'error'] as const,
      'conversation item type',
    );
    const status = assertEnum(input.status ?? 'completed', ['in_progress', 'completed', 'failed'] as const, 'conversation item status');
    const phase = assertEnum(input.phase, ['prework', 'final_answer'] as const, 'conversation item phase');
    const existing = this.getByProvider(input.providerThreadId, input.providerItemId);
    if (existing?.status === 'completed') return existing;
    const id = existing?.id ?? `conversation_item_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_items (id, conversation_id, turn_id, provider_thread_id, provider_turn_id, provider_item_id, item_type, status, phase, text_content, payload_json, started_at, completed_at, updated_at, agent_kind, native_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_thread_id, provider_item_id) DO UPDATE SET
       turn_id = excluded.turn_id, provider_turn_id = excluded.provider_turn_id, item_type = excluded.item_type,
       status = excluded.status, phase = excluded.phase, text_content = excluded.text_content,
       payload_json = excluded.payload_json, started_at = COALESCE(conversation_items.started_at, excluded.started_at),
       completed_at = excluded.completed_at, updated_at = excluded.updated_at, agent_kind = excluded.agent_kind, native_item_id = excluded.native_item_id`,
      [
        id,
        input.conversationId,
        input.turnId,
        input.providerThreadId,
        input.providerTurnId,
        input.providerItemId,
        itemType,
        status,
        phase,
        input.textContent,
        JSON.stringify(input.payload),
        input.startedAt ?? null,
        input.completedAt,
        input.updatedAt,
        input.agentKind ?? 'codex',
        input.nativeItemId ?? input.providerItemId,
      ],
    );
    return this.getByProvider(input.providerThreadId, input.providerItemId)!;
  }

  /**
   * 修复旧版 Pi 已完成回答投影：消息表已有最终正文时，只替换同一 Pi 回答项的展示正文。
   * 该入口不改变轮次状态，也不允许把其他类型或进行中的项目强制封口。
   */
  replaceCompletedPiAgentMessage(input: { providerThreadId: string; providerItemId: string; textContent: string; updatedAt: string }): ZeusConversationItemRecord | undefined {
    this.db.execute(
      `UPDATE conversation_items
             SET text_content = ?,
                 phase = 'final_answer',
                 updated_at = ?
             WHERE provider_thread_id = ?
               AND provider_item_id = ?
               AND item_type = 'agentMessage'
               AND status = 'completed'
               AND agent_kind = 'pi'`,
      [input.textContent, input.updatedAt, input.providerThreadId, input.providerItemId],
    );
    return this.getByProvider(input.providerThreadId, input.providerItemId);
  }

  getByProvider(providerThreadId: string, providerItemId: string): ZeusConversationItemRecord | undefined {
    const row = this.db.get<DbConversationItemRow>(`SELECT * FROM conversation_items WHERE provider_thread_id = ? AND provider_item_id = ?`, [providerThreadId, providerItemId]);
    return row ? mapConversationItemRow(row) : undefined;
  }

  getById(id: string): ZeusConversationItemRecord | undefined {
    const row = this.db.get<DbConversationItemRow>(`SELECT * FROM conversation_items WHERE id = ?`, [id]);
    return row ? mapConversationItemRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationItemRecord[] {
    return this.db.select<DbConversationItemRow>(`SELECT * FROM conversation_items WHERE conversation_id = ? ORDER BY updated_at, id`, [conversationId]).map(mapConversationItemRow);
  }
}

export class ConversationResourceRepository {
  constructor(private readonly db: ZeusDatabase) {}

  replaceForItem(itemId: string, resources: Array<Omit<ZeusConversationResourceRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }>, updatedAt: string): ZeusConversationResourceRecord[] {
    return this.db.transaction(() => {
      this.db.execute(`DELETE FROM conversation_resources WHERE item_id = ?`, [itemId]);
      for (const resource of resources) {
        const kind = assertEnum(resource.kind, ['file', 'website', 'attachment'] as const, 'conversation resource kind');
        const presentation = assertEnum(resource.presentation, ['inline', 'card'] as const, 'conversation resource presentation');
        this.db.execute(
          `INSERT INTO conversation_resources
             (id, project_id, conversation_id, turn_id, item_id, source_index, canonical_target_digest,
              kind, presentation, display_json, target_json, authority_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            resource.id ?? `conversation_resource_${nanoid(12)}`,
            resource.projectId,
            resource.conversationId,
            resource.turnId,
            itemId,
            resource.sourceIndex,
            resource.canonicalTargetDigest,
            kind,
            presentation,
            resource.displayJson,
            resource.targetJson,
            resource.authorityJson,
            updatedAt,
            updatedAt,
          ],
        );
      }
      return this.listByItem(itemId);
    });
  }

  getById(id: string): ZeusConversationResourceRecord | undefined {
    const row = this.db.get<DbConversationResourceRow>(`SELECT * FROM conversation_resources WHERE id = ?`, [id]);
    return row ? mapConversationResourceRow(row) : undefined;
  }

  listByItem(itemId: string): ZeusConversationResourceRecord[] {
    return this.db.select<DbConversationResourceRow>(`SELECT * FROM conversation_resources WHERE item_id = ? ORDER BY source_index, id`, [itemId]).map(mapConversationResourceRow);
  }

  listByConversation(conversationId: string): ZeusConversationResourceRecord[] {
    return this.db.select<DbConversationResourceRow>(`SELECT * FROM conversation_resources WHERE conversation_id = ? ORDER BY created_at, source_index, id`, [conversationId]).map(mapConversationResourceRow);
  }
}

export class TurnChangeSetRepository {
  constructor(private readonly db: ZeusDatabase) {}

  upsert(
    input: Omit<ZeusTurnChangeSetRecord, 'id' | 'createdAt' | 'updatedAt'> & {
      id?: string;
      createdAt?: string;
      updatedAt: string;
    },
  ): ZeusTurnChangeSetRecord {
    const state = assertEnum(input.state, ['capturing', 'applied', 'undoing', 'undone', 'reapplying', 'conflicted', 'unavailable'] as const, 'turn change set state');
    const existing = this.getByTurn(input.conversationId, input.turnId);
    const id = existing?.id ?? input.id ?? `turn_change_set_${nanoid(12)}`;
    const createdAt = existing?.createdAt ?? input.createdAt ?? input.updatedAt;
    this.db.execute(
      `INSERT INTO turn_change_sets
         (id, project_id, conversation_id, turn_id, provider_turn_id, state, unified_diff,
          pre_image_digest, post_image_digest, conflict_json, unavailable_reason, journal_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, turn_id) DO UPDATE SET
         provider_turn_id = excluded.provider_turn_id, state = excluded.state,
         unified_diff = excluded.unified_diff, pre_image_digest = excluded.pre_image_digest,
         post_image_digest = excluded.post_image_digest, conflict_json = excluded.conflict_json,
         unavailable_reason = excluded.unavailable_reason, journal_ref = excluded.journal_ref,
         updated_at = excluded.updated_at`,
      [
        id,
        input.projectId,
        input.conversationId,
        input.turnId,
        input.providerTurnId,
        state,
        input.unifiedDiff,
        input.preImageDigest,
        input.postImageDigest,
        input.conflictJson,
        input.unavailableReason,
        input.journalRef,
        createdAt,
        input.updatedAt,
      ],
    );
    return this.getByTurn(input.conversationId, input.turnId)!;
  }

  getById(id: string): ZeusTurnChangeSetRecord | undefined {
    const row = this.db.get<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE id = ?`, [id]);
    return row ? mapTurnChangeSetRow(row) : undefined;
  }

  getByTurn(conversationId: string, turnId: string): ZeusTurnChangeSetRecord | undefined {
    const row = this.db.get<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE conversation_id = ? AND turn_id = ?`, [conversationId, turnId]);
    return row ? mapTurnChangeSetRow(row) : undefined;
  }

  getByProviderTurn(conversationId: string, providerTurnId: string): ZeusTurnChangeSetRecord | undefined {
    const row = this.db.get<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE conversation_id = ? AND provider_turn_id = ?`, [conversationId, providerTurnId]);
    return row ? mapTurnChangeSetRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusTurnChangeSetRecord[] {
    return this.db.select<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapTurnChangeSetRow);
  }

  listInProgress(): ZeusTurnChangeSetRecord[] {
    return this.db.select<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE state IN ('undoing', 'reapplying') ORDER BY updated_at, id`).map(mapTurnChangeSetRow);
  }
}

export class TurnChangeFileRepository {
  constructor(private readonly db: ZeusDatabase) {}

  upsert(
    input: Omit<ZeusTurnChangeFileRecord, 'id' | 'createdAt' | 'updatedAt'> & {
      id?: string;
      createdAt?: string;
      updatedAt: string;
      replacePreImage?: boolean;
    },
  ): ZeusTurnChangeFileRecord {
    const changeType = assertEnum(input.changeType, ['added', 'deleted', 'modified', 'renamed', 'binary'] as const, 'turn change file type');
    const existing =
      input.sourceItemId === null
        ? undefined
        : this.db.get<DbTurnChangeFileRow>(`SELECT * FROM turn_change_files WHERE change_set_id = ? AND source_item_id = ? AND source_index = ?`, [input.changeSetId, input.sourceItemId, input.sourceIndex]);
    const id = existing?.id ?? input.id ?? `turn_change_file_${nanoid(12)}`;
    const createdAt = existing?.created_at ?? input.createdAt ?? input.updatedAt;
    this.db.execute(
      `INSERT INTO turn_change_files
         (id, change_set_id, source_item_id, source_index, old_path, new_path, change_type,
          added_lines, deleted_lines, pre_hash, post_hash, pre_exists, post_exists,
          pre_mode, post_mode, unified_diff, pre_blob_ref, post_blob_ref,
          reversible, unavailable_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(change_set_id, source_item_id, source_index) DO UPDATE SET
         old_path = excluded.old_path, new_path = excluded.new_path, change_type = excluded.change_type,
         added_lines = excluded.added_lines, deleted_lines = excluded.deleted_lines,
         pre_hash = CASE WHEN ? = 1 THEN excluded.pre_hash ELSE COALESCE(turn_change_files.pre_hash, excluded.pre_hash) END,
         post_hash = excluded.post_hash,
         pre_exists = CASE WHEN ? = 1 THEN excluded.pre_exists ELSE turn_change_files.pre_exists END,
         post_exists = excluded.post_exists,
         pre_mode = CASE WHEN ? = 1 THEN excluded.pre_mode ELSE COALESCE(turn_change_files.pre_mode, excluded.pre_mode) END,
         post_mode = excluded.post_mode, unified_diff = excluded.unified_diff,
         pre_blob_ref = CASE WHEN ? = 1 THEN excluded.pre_blob_ref ELSE COALESCE(turn_change_files.pre_blob_ref, excluded.pre_blob_ref) END,
         post_blob_ref = excluded.post_blob_ref, reversible = excluded.reversible,
         unavailable_reason = excluded.unavailable_reason, updated_at = excluded.updated_at`,
      [
        id,
        input.changeSetId,
        input.sourceItemId,
        input.sourceIndex,
        input.oldPath,
        input.newPath,
        changeType,
        input.addedLines,
        input.deletedLines,
        input.preHash,
        input.postHash,
        input.preExists ? 1 : 0,
        input.postExists ? 1 : 0,
        input.preMode,
        input.postMode,
        input.unifiedDiff,
        input.preBlobRef,
        input.postBlobRef,
        input.reversible ? 1 : 0,
        input.unavailableReason,
        createdAt,
        input.updatedAt,
        input.replacePreImage ? 1 : 0,
        input.replacePreImage ? 1 : 0,
        input.replacePreImage ? 1 : 0,
        input.replacePreImage ? 1 : 0,
      ],
    );
    return this.getById(id)!;
  }

  getById(id: string): ZeusTurnChangeFileRecord | undefined {
    const row = this.db.get<DbTurnChangeFileRow>(`SELECT * FROM turn_change_files WHERE id = ?`, [id]);
    return row ? mapTurnChangeFileRow(row) : undefined;
  }

  listByChangeSet(changeSetId: string): ZeusTurnChangeFileRecord[] {
    return this.db.select<DbTurnChangeFileRow>(`SELECT * FROM turn_change_files WHERE change_set_id = ? ORDER BY source_index, id`, [changeSetId]).map(mapTurnChangeFileRow);
  }
}

export class ConversationSubmissionRepository {
  constructor(private readonly db: ZeusDatabase) {}

  createOrGet(input: {
    id?: string;
    conversationId: string;
    idempotencyKey: string;
    requestHash: string;
    clientMessageId: string;
    kind: ConversationSubmissionKind;
    requestedDelivery: ConversationRequestedDelivery;
    status: ConversationSubmissionStatus;
    queuePosition?: number | null;
    input: unknown;
    targetProviderTurnId?: string | null;
    providerTurnId?: string | null;
    pausedReason?: string | null;
    error?: unknown;
    createdAt: string;
    dispatchedAt?: string | null;
    resolvedAt?: string | null;
  }): ZeusConversationSubmissionRecord {
    const kind = assertEnum(input.kind, ['message', 'steer'] as const, 'conversation submission kind');
    const requestedDelivery = assertEnum(input.requestedDelivery, ['queue', 'send_now'] as const, 'conversation submission requested delivery');
    const status = assertEnum(input.status, ['queued', 'dispatching', 'active', 'paused', 'completed', 'resolved', 'failed', 'cancelled', 'deleted'] as const, 'conversation submission status');
    const existing = this.db.get<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE conversation_id = ? AND idempotency_key = ?`, [input.conversationId, input.idempotencyKey]);
    if (existing) {
      if (existing.request_hash !== input.requestHash || (input.id !== undefined && existing.id !== input.id)) throwIdempotencyConflict(input.conversationId, input.idempotencyKey);
      return mapConversationSubmissionRow(existing);
    }
    const id = input.id ?? `conversation_submission_${nanoid(12)}`;
    const errorJson = input.error === undefined ? null : JSON.stringify(input.error);
    this.db.execute(
      `INSERT INTO conversation_submissions (id, conversation_id, idempotency_key, request_hash, client_message_id, kind, requested_delivery, status, queue_position, input_json, target_provider_turn_id, provider_turn_id, paused_reason, error_json, created_at, updated_at, dispatched_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.conversationId,
        input.idempotencyKey,
        input.requestHash,
        input.clientMessageId,
        kind,
        requestedDelivery,
        status,
        input.queuePosition ?? null,
        JSON.stringify(input.input),
        input.targetProviderTurnId ?? null,
        input.providerTurnId ?? null,
        input.pausedReason ?? null,
        errorJson,
        input.createdAt,
        input.createdAt,
        input.dispatchedAt ?? null,
        input.resolvedAt ?? null,
      ],
    );
    syncConversationStage(this.db, input.conversationId, input.createdAt);
    return this.getById(id)!;
  }

  getById(id: string): ZeusConversationSubmissionRecord | undefined {
    const row = this.db.get<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE id = ?`, [id]);
    return row ? mapConversationSubmissionRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationSubmissionRecord[] {
    return this.db.select<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE conversation_id = ? ORDER BY queue_position, created_at, id`, [conversationId]).map(mapConversationSubmissionRow);
  }

  getFirstByConversation(conversationId: string): ZeusConversationSubmissionRecord | undefined {
    const row = this.db.get<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE conversation_id = ? ORDER BY created_at, id LIMIT 1`, [conversationId]);
    return row ? mapConversationSubmissionRow(row) : undefined;
  }

  listQueueByConversation(conversationId: string): ZeusConversationSubmissionRecord[] {
    return this.db
      .select<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE conversation_id = ? AND status IN ('queued', 'paused') ORDER BY queue_position, created_at, id`, [conversationId])
      .map(mapConversationSubmissionRow);
  }

  listRecoverable(): ZeusConversationSubmissionRecord[] {
    return this.db
      .select<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE status IN ('queued', 'dispatching', 'active', 'paused') ORDER BY conversation_id, queue_position, created_at, id`)
      .map(mapConversationSubmissionRow);
  }

  updateQueuedInput(id: string, input: { requestHash: string; input: unknown; updatedAt?: string }): ZeusConversationSubmissionRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation submission not found: ${id}`);
    if (existing.status !== 'queued' && existing.status !== 'paused' && existing.status !== 'failed') {
      throw Object.assign(new Error('Only queued, paused, or failed submissions can be edited.'), { code: 'ZEUS_NATIVE_SUBMISSION_NOT_EDITABLE' as const });
    }
    this.db.execute(`UPDATE conversation_submissions SET request_hash = ?, input_json = ?, updated_at = ? WHERE id = ?`, [input.requestHash, JSON.stringify(input.input), input.updatedAt ?? nowIso(), id]);
    return this.getById(id)!;
  }

  reorderQueued(conversationId: string, orderedSubmissionIds: readonly string[], updatedAt = nowIso()): ZeusConversationSubmissionRecord[] {
    const queued = this.listByConversation(conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
    if (orderedSubmissionIds.length !== queued.length || new Set(orderedSubmissionIds).size !== queued.length || orderedSubmissionIds.some((id) => !queued.some((entry) => entry.id === id))) {
      throw Object.assign(new Error('Queued submission reorder must contain every queued or paused submission exactly once.'), { code: 'ZEUS_NATIVE_QUEUE_REORDER_INVALID' as const });
    }
    this.db.transaction(() => {
      orderedSubmissionIds.forEach((id, index) => this.db.execute(`UPDATE conversation_submissions SET queue_position = ?, updated_at = ? WHERE id = ? AND conversation_id = ?`, [index + 1, updatedAt, id, conversationId]));
    });
    return this.listByConversation(conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
  }

  updateStatus(
    id: string,
    statusValue: ConversationSubmissionStatus,
    input: { providerTurnId?: string | null; pausedReason?: string | null; error?: unknown; dispatchedAt?: string | null; resolvedAt?: string | null; updatedAt?: string } = {},
  ): ZeusConversationSubmissionRecord {
    const status = assertEnum(statusValue, ['queued', 'dispatching', 'active', 'paused', 'completed', 'resolved', 'failed', 'cancelled', 'deleted'] as const, 'conversation submission status');
    const updatedAt = input.updatedAt ?? nowIso();
    this.db.execute(
      `UPDATE conversation_submissions SET status = ?, provider_turn_id = COALESCE(?, provider_turn_id), paused_reason = ?, error_json = ?, dispatched_at = COALESCE(?, dispatched_at), resolved_at = COALESCE(?, resolved_at), updated_at = ? WHERE id = ?`,
      [status, input.providerTurnId ?? null, input.pausedReason ?? null, input.error === undefined ? null : JSON.stringify(input.error), input.dispatchedAt ?? null, input.resolvedAt ?? null, updatedAt, id],
    );
    const updated = this.getById(id);
    if (!updated) throw new Error(`Conversation submission not found: ${id}`);
    syncConversationStage(this.db, updated.conversationId, updatedAt);
    return updated;
  }

  requeueRejectedSteer(id: string, updatedAt = nowIso()): ZeusConversationSubmissionRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation submission not found: ${id}`);
    const parsedInput = parseStoredJson(existing.inputJson);
    if (!isPlainRecord(parsedInput)) throw new Error(`Conversation submission input is invalid: ${id}`);
    // Provider 明确拒绝已结束轮次的 steer 时，这条输入从未进入模型；清除旧轮次绑定后按普通队列消息继续处理。
    this.db.execute(
      `UPDATE conversation_submissions
       SET kind = 'message', requested_delivery = 'queue', status = 'queued', input_json = ?,
           target_provider_turn_id = NULL, provider_turn_id = NULL, paused_reason = NULL,
           error_json = NULL, dispatched_at = NULL, resolved_at = NULL, updated_at = ?
       WHERE id = ?`,
      [
        JSON.stringify({
          ...parsedInput,
          delivery: 'queue',
          expectedTurnId: null,
        }),
        updatedAt,
        id,
      ],
    );
    const updated = this.getById(id)!;
    syncConversationStage(this.db, updated.conversationId, updatedAt);
    return updated;
  }
}

export class ConversationServerRequestRepository {
  constructor(private readonly db: ZeusDatabase) {}

  upsert(input: {
    conversationId: string;
    turnId?: string | null;
    itemId?: string | null;
    transportGenerationId: string;
    providerRequestId: string | number;
    requestKind: ConversationServerRequestKind;
    payload: unknown;
    status: ConversationServerRequestStatus;
    response?: unknown;
    containsSecret?: boolean;
    expiresAt?: string | null;
    autoResolutionState?: ConversationRequestAutoResolutionState;
    createdAt: string;
    resolvedAt?: string | null;
  }): ZeusConversationServerRequestRecord {
    const requestKind = assertEnum(input.requestKind, ['command', 'file', 'permissions', 'request_user_input', 'mcp'] as const, 'conversation server request kind');
    const status = assertEnum(input.status, ['pending', 'resolved', 'declined', 'expired', 'failed'] as const, 'conversation server request status');
    const providerRequestIdJson = serializeProviderRequestId(input.providerRequestId);
    const existing = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE transport_generation_id = ? AND provider_request_id_json = ?`, [input.transportGenerationId, providerRequestIdJson]);
    const persistedPayload = parseStoredJson(existing?.payload_json);
    const containsSecret = input.containsSecret === true || existing?.contains_secret === 1 || hasSecretUserInputQuestion(input.payload) || hasSecretUserInputQuestion(persistedPayload);
    const payload = containsSecret ? redactSecretValues(input.payload) : input.payload;
    if (existing) {
      assertConversationServerRequestIdentity(existing, requestKind, payload, containsSecret);
      return mapConversationServerRequestRow(existing);
    }
    const id = `conversation_server_request_${nanoid(12)}`;
    const response = containsSecret && input.response !== undefined ? createSecretResponseSummary(input.payload, input.response) : input.response;
    this.db.execute(
      `INSERT INTO conversation_server_requests (id, conversation_id, turn_id, item_id, transport_generation_id, provider_request_id_json, request_kind, payload_json, status, response_json, contains_secret, expires_at, auto_resolution_state, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(transport_generation_id, provider_request_id_json) DO NOTHING`,
      [
        id,
        input.conversationId,
        input.turnId ?? null,
        input.itemId ?? null,
        input.transportGenerationId,
        providerRequestIdJson,
        requestKind,
        JSON.stringify(payload),
        status,
        response === undefined ? null : JSON.stringify(response),
        containsSecret ? 1 : 0,
        input.expiresAt ?? null,
        assertEnum(input.autoResolutionState ?? 'none', ['none', 'scheduled', 'snoozed'] as const, 'request auto resolution state'),
        input.createdAt,
        input.resolvedAt ?? null,
      ],
    );
    const stored = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE transport_generation_id = ? AND provider_request_id_json = ?`, [input.transportGenerationId, providerRequestIdJson]);
    if (!stored) throw new Error('Conversation server request insert did not persist a record.');
    assertConversationServerRequestIdentity(stored, requestKind, payload, containsSecret);
    syncConversationStage(this.db, input.conversationId, input.createdAt);
    return mapConversationServerRequestRow(stored);
  }

  resolve(id: string, input: { response: unknown; isSecret?: boolean; questionIds?: string[]; answerCount?: number; resolvedAt: string }): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    const persistedPayload = parseStoredJson(existing.payloadJson);
    const secret = input.isSecret === true || existing.containsSecret || hasSecretUserInputQuestion(persistedPayload);
    const responseJson = secret ? JSON.stringify(createSecretResponseSummary(persistedPayload, input.response, input.questionIds, input.answerCount)) : JSON.stringify(input.response);
    this.db.execute(`UPDATE conversation_server_requests SET status = 'resolved', response_json = ?, contains_secret = ?, resolved_at = ? WHERE id = ?`, [responseJson, secret ? 1 : 0, input.resolvedAt, id]);
    syncConversationStage(this.db, existing.conversationId, input.resolvedAt);
    return this.getById(id)!;
  }

  /**
   * 宿主升级会终止旧 app-server 的瞬时请求通道，但用户仍需在同一 Zeus 会话中继续作答。
   * 这里只恢复待处理投影并写入明确交接标记；真正回复时必须重新校验原请求与用户答案。
   */
  restorePendingAfterHostHandoff(id: string, input: { sourceInstanceId: string; capturedAt: string; restoredAt: string }): ZeusConversationServerRequestRecord {
    return this.restorePendingAfterTransportRecovery(id, {
      recoveryReason: 'host_handoff',
      sourceInstanceId: input.sourceInstanceId,
      capturedAt: input.capturedAt,
      restoredAt: input.restoredAt,
    });
  }

  /**
   * app-server 请求通道退出后，旧请求不能再通过原 RPC 作答，但仍可作为一次显式续接的恢复点。
   * 该标记只恢复 Zeus 侧交互，不会把旧请求伪装成当前 app-server 的有效请求。
   */
  restorePendingAfterTransportRecovery(
    id: string,
    input: {
      recoveryReason: 'host_handoff' | 'app_server_generation_changed';
      restoredAt: string;
      sourceInstanceId?: string;
      capturedAt?: string;
      sourceGenerationId?: string;
      currentGenerationId?: string | null;
    },
  ): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    this.db.execute(
      `UPDATE conversation_server_requests
       SET status = 'pending', response_json = ?, resolved_at = NULL, auto_resolution_state = 'none'
       WHERE id = ?`,
      [
        JSON.stringify({
          interactionRecoveryCheckpoint: true,
          recoveryReason: input.recoveryReason,
          ...(input.recoveryReason === 'host_handoff' ? { handoffCheckpoint: true } : {}),
          ...(input.sourceInstanceId ? { sourceInstanceId: input.sourceInstanceId } : {}),
          ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
          ...(input.sourceGenerationId ? { sourceGenerationId: input.sourceGenerationId } : {}),
          ...(input.currentGenerationId !== undefined ? { currentGenerationId: input.currentGenerationId } : {}),
          restoredAt: input.restoredAt,
        }),
        id,
      ],
    );
    syncConversationStage(this.db, existing.conversationId, input.restoredAt);
    return this.getById(id)!;
  }

  /** 记录请求已由 Codex 的其他已授权客户端回答；Zeus 不持久化它看不到的答案正文。 */
  resolveExternally(id: string, input: { source: 'codex_remote_control' | 'provider'; resolvedAt: string }): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    this.db.execute(`UPDATE conversation_server_requests SET status = 'resolved', response_json = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`, [
      JSON.stringify({ type: 'external_resolution', source: input.source }),
      input.resolvedAt,
      id,
    ]);
    syncConversationStage(this.db, existing.conversationId, input.resolvedAt);
    return this.getById(id)!;
  }

  fail(id: string, input: { error: unknown; resolvedAt: string }): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    this.db.execute(`UPDATE conversation_server_requests SET status = 'failed', response_json = ?, resolved_at = ? WHERE id = ?`, [JSON.stringify(input.error), input.resolvedAt, id]);
    syncConversationStage(this.db, existing.conversationId, input.resolvedAt);
    return this.getById(id)!;
  }

  expire(id: string, input: { response: unknown; resolvedAt: string }): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    this.db.execute(`UPDATE conversation_server_requests SET status = 'expired', response_json = ?, resolved_at = ? WHERE id = ? AND status IN ('pending', 'resolved')`, [JSON.stringify(input.response), input.resolvedAt, id]);
    syncConversationStage(this.db, existing.conversationId, input.resolvedAt);
    return this.getById(id)!;
  }

  snooze(id: string): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    if (existing.status !== 'pending') throw Object.assign(new Error('Only a pending request can be snoozed.'), { code: 'ZEUS_CODEX_SERVER_REQUEST_NOT_PENDING' as const });
    this.db.execute(`UPDATE conversation_server_requests SET auto_resolution_state = 'snoozed', expires_at = NULL WHERE id = ?`, [id]);
    return this.getById(id)!;
  }

  getById(id: string): ZeusConversationServerRequestRecord | undefined {
    const row = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE id = ?`, [id]);
    return row ? mapConversationServerRequestRow(row) : undefined;
  }

  getByProvider(transportGenerationId: string, providerRequestId: string | number): ZeusConversationServerRequestRecord | undefined {
    const row = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE transport_generation_id = ? AND provider_request_id_json = ?`, [
      transportGenerationId,
      serializeProviderRequestId(providerRequestId),
    ]);
    return row ? mapConversationServerRequestRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationServerRequestRecord[] {
    return this.db.select<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapConversationServerRequestRow);
  }

  listPendingByConversation(conversationId: string): ZeusConversationServerRequestRecord[] {
    return this.db.select<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at, id`, [conversationId]).map(mapConversationServerRequestRow);
  }

  listPending(): ZeusConversationServerRequestRecord[] {
    return this.db.select<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE status = 'pending' ORDER BY created_at, id`).map(mapConversationServerRequestRow);
  }
}

export class ConversationPlanActionRepository {
  constructor(private readonly db: ZeusDatabase) {}

  createPending(input: { conversationId: string; turnId: string; planItemId: string; createdAt: string }): ZeusConversationPlanActionRecord {
    const existing = this.db.get<DbConversationPlanActionRow>(`SELECT * FROM conversation_plan_actions WHERE plan_item_id = ?`, [input.planItemId]);
    if (existing) return mapConversationPlanActionRow(existing);
    return this.db.transaction(() => {
      this.db.execute(`UPDATE conversation_plan_actions SET status = 'superseded', resolved_at = ?, updated_at = ? WHERE conversation_id = ? AND status IN ('pending', 'refinement_requested')`, [
        input.createdAt,
        input.createdAt,
        input.conversationId,
      ]);
      const id = `conversation_plan_action_${nanoid(12)}`;
      this.db.execute(
        `INSERT INTO conversation_plan_actions (id, conversation_id, turn_id, plan_item_id, status, submission_id, created_at, resolved_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`,
        [id, input.conversationId, input.turnId, input.planItemId, input.createdAt, input.createdAt],
      );
      const created = this.getById(id)!;
      syncConversationStage(this.db, input.conversationId, input.createdAt);
      return created;
    });
  }

  getById(id: string): ZeusConversationPlanActionRecord | undefined {
    const row = this.db.get<DbConversationPlanActionRow>(`SELECT * FROM conversation_plan_actions WHERE id = ?`, [id]);
    return row ? mapConversationPlanActionRow(row) : undefined;
  }

  getLatestPending(conversationId: string): ZeusConversationPlanActionRecord | undefined {
    const row = this.db.get<DbConversationPlanActionRow>(`SELECT * FROM conversation_plan_actions WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1`, [conversationId]);
    return row ? mapConversationPlanActionRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationPlanActionRecord[] {
    return this.db.select<DbConversationPlanActionRow>(`SELECT * FROM conversation_plan_actions WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapConversationPlanActionRow);
  }

  resolveLatestPending(
    id: string,
    conversationId: string,
    input: {
      status: Exclude<ConversationPlanActionStatus, 'pending' | 'superseded'>;
      submissionId?: string | null;
      resolvedAt: string;
    },
  ): ZeusConversationPlanActionRecord {
    const status = assertEnum(input.status, ['dismissed', 'implemented', 'refinement_requested'] as const, 'conversation plan action resolution');
    return this.db.transaction(() =>
      this.resolveLatestPendingInCurrentTransaction(id, conversationId, {
        ...input,
        status,
      }),
    );
  }

  /** 仅供已经持有 ZeusDatabase transaction 的领域操作组合调用。 */
  resolveLatestPendingInCurrentTransaction(
    id: string,
    conversationId: string,
    input: {
      status: Exclude<ConversationPlanActionStatus, 'pending' | 'superseded'>;
      submissionId?: string | null;
      resolvedAt: string;
    },
  ): ZeusConversationPlanActionRecord {
    const status = assertEnum(input.status, ['dismissed', 'implemented', 'refinement_requested'] as const, 'conversation plan action resolution');
    const latest = this.getLatestPending(conversationId);
    if (!latest || latest.id !== id) {
      throw Object.assign(new Error('Plan implementation request is stale or already resolved.'), { code: 'ZEUS_PLAN_IMPLEMENTATION_REQUEST_STALE' as const });
    }
    this.db.execute(`UPDATE conversation_plan_actions SET status = ?, submission_id = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, [status, input.submissionId ?? null, input.resolvedAt, input.resolvedAt, id]);
    const updated = this.getById(id)!;
    syncConversationStage(this.db, conversationId, input.resolvedAt);
    return updated;
  }
}

export class IdempotencyRequestRepository {
  constructor(private readonly db: ZeusDatabase) {}

  createOrGet(input: {
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    status: IdempotencyRequestStatus;
    httpStatus?: number | null;
    response?: unknown;
    resourceId?: string | null;
    createdAt: string;
  }): ZeusIdempotencyRequestRecord {
    const status = assertEnum(input.status, ['in_progress', 'completed', 'failed'] as const, 'idempotency request status');
    const existing = this.db.get<DbIdempotencyRequestRow>(`SELECT * FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [input.scope, input.idempotencyKey]);
    if (existing) {
      if (existing.request_hash !== input.requestHash) throwIdempotencyConflict(input.scope, input.idempotencyKey);
      return mapIdempotencyRequestRow(existing);
    }
    this.db.execute(`INSERT INTO idempotency_requests (scope, idempotency_key, request_hash, status, http_status, response_json, resource_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      input.scope,
      input.idempotencyKey,
      input.requestHash,
      status,
      input.httpStatus ?? null,
      input.response === undefined ? null : JSON.stringify(input.response),
      input.resourceId ?? null,
      input.createdAt,
      input.createdAt,
    ]);
    return mapIdempotencyRequestRow(this.db.get<DbIdempotencyRequestRow>(`SELECT * FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [input.scope, input.idempotencyKey])!);
  }

  get(scope: string, idempotencyKey: string): ZeusIdempotencyRequestRecord | undefined {
    const row = this.db.get<DbIdempotencyRequestRow>(`SELECT * FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [scope, idempotencyKey]);
    return row ? mapIdempotencyRequestRow(row) : undefined;
  }

  complete(input: { scope: string; idempotencyKey: string; status: 'completed' | 'failed'; httpStatus: number; response: unknown; resourceId?: string | null; updatedAt: string }): ZeusIdempotencyRequestRecord {
    const existing = this.get(input.scope, input.idempotencyKey);
    if (!existing) throw new Error(`Idempotency request not found: ${input.scope}/${input.idempotencyKey}`);
    this.db.execute(
      `UPDATE idempotency_requests
       SET status = ?, http_status = ?, response_json = ?, resource_id = ?, updated_at = ?
       WHERE scope = ? AND idempotency_key = ?`,
      [input.status, input.httpStatus, JSON.stringify(input.response), input.resourceId ?? existing.resourceId, input.updatedAt, input.scope, input.idempotencyKey],
    );
    return this.get(input.scope, input.idempotencyKey)!;
  }
}

function clampConversationLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function toSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function assertEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`Unknown ${label}: ${String(value)}`);
  return value as T[number];
}

const providerGenerationOrderSettingKey = 'codex.native.transport_generation_order';

function assertProviderSequenceSnapshot(snapshot: unknown): asserts snapshot is ProviderSequenceSnapshot {
  if (!isPlainRecord(snapshot) || typeof snapshot.generationId !== 'string' || !snapshot.generationId || !Number.isSafeInteger(snapshot.sequence) || Number(snapshot.sequence) < 0) {
    throw new Error('Invalid provider generation/sequence snapshot');
  }
}

function validateProviderSettingsSnapshot(snapshot: unknown): asserts snapshot is ConversationProviderSettingsSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertNoSecretLikeProviderKeys(candidate);
  assertOnlyKeys(candidate, ['generationId', 'sequence', 'model', 'effort', 'serviceTier'], 'provider settings snapshot');
  if (
    typeof candidate.model !== 'string' ||
    !candidate.model.trim() ||
    (candidate.effort !== undefined && typeof candidate.effort !== 'string') ||
    (candidate.serviceTier !== undefined && candidate.serviceTier !== null && typeof candidate.serviceTier !== 'string')
  ) {
    throw new Error('Invalid provider settings snapshot');
  }
}

function validateNextTurnSettings(settings: unknown): asserts settings is ConversationNextTurnSettings {
  if (!isPlainRecord(settings)) throw new Error('Invalid conversation next turn settings');
  assertOnlyKeys(settings, ['model', 'effort', 'serviceTier', 'permissionMode', 'collaborationMode'], 'conversation next turn settings');
  if (
    typeof settings.model !== 'string' ||
    !settings.model.trim() ||
    (settings.effort !== undefined && (typeof settings.effort !== 'string' || !settings.effort.trim())) ||
    (settings.serviceTier !== undefined && settings.serviceTier !== null && (typeof settings.serviceTier !== 'string' || !settings.serviceTier.trim()))
  ) {
    throw new Error('Invalid conversation next turn settings');
  }
  assertEnum(settings.permissionMode, ['read-only', 'auto', 'full-access'] as const, 'conversation next turn permission mode');
  assertEnum(settings.collaborationMode, ['default', 'plan'] as const, 'conversation next turn collaboration mode');
}

function validateProviderTokenUsageSnapshot(snapshot: unknown): asserts snapshot is ConversationProviderTokenUsageSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertNoSecretLikeProviderKeys(candidate, new Set(['inputtokens', 'cachedinputtokens', 'cachewriteinputtokens', 'outputtokens', 'reasoningoutputtokens', 'totaltokens']));
  assertOnlyKeys(
    candidate,
    ['generationId', 'sequence', 'total', 'last', 'modelContextWindow', 'cacheHitRate', 'estimatedCredits', 'apiEquivalentUsd', 'cacheSavingsUsd', 'priceCoverage', 'pricingCatalogDate', 'pricingSourceUrls', 'historyComplete'],
    'provider token usage snapshot',
  );
  validateTokenUsageBreakdown(candidate.total);
  validateTokenUsageBreakdown(candidate.last);
  for (const value of [candidate.modelContextWindow, candidate.cacheHitRate, candidate.estimatedCredits, candidate.apiEquivalentUsd, candidate.cacheSavingsUsd, candidate.priceCoverage]) {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('Invalid provider token usage snapshot');
  }
  if ((candidate.pricingCatalogDate !== null && typeof candidate.pricingCatalogDate !== 'string') || !Array.isArray(candidate.pricingSourceUrls) || candidate.pricingSourceUrls.some((url) => typeof url !== 'string')) {
    throw new Error('Invalid provider token usage snapshot');
  }
  if (typeof candidate.historyComplete !== 'boolean') throw new Error('Invalid provider token usage snapshot');
}

function validateTokenUsageBreakdown(value: unknown): asserts value is TokenUsageBreakdown {
  if (!isPlainRecord(value)) throw new Error('Invalid token usage breakdown');
  assertOnlyKeys(value, ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'], 'token usage breakdown');
  if (Object.values(value).some((entry) => typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0)) throw new Error('Invalid token usage breakdown');
}

function validateCodexUsageEstimate(value: unknown): asserts value is CodexUsageEstimate {
  if (!isPlainRecord(value) || !isPlainRecord(value.rateSnapshot)) throw new Error('Invalid Codex usage estimate');
  assertNoSecretLikeProviderKeys(value, new Set(['input', 'cachedinput', 'cachewrite', 'output', 'billabletokens', 'pricedtokens']));
  for (const candidate of [value.credits, value.apiEquivalentUsd, value.cacheSavingsUsd, value.coverage]) {
    if (candidate !== null && (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0)) throw new Error('Invalid Codex usage estimate');
  }
  if (![value.pricedTokens, value.billableTokens].every((candidate) => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0)) throw new Error('Invalid Codex usage estimate');
}

function validateRateLimitsSnapshot(snapshot: unknown): asserts snapshot is CodexRateLimitsSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertOnlyKeys(candidate, ['generationId', 'sequence', 'value'], 'Codex rate limits snapshot');
  assertNoSecretLikeProviderKeys(candidate.value);
  assertProviderVisibleJson(candidate.value, 'rate limits');
  if (!isPlainRecord(candidate.value)) throw new Error('Invalid Codex rate limits snapshot');
  for (const key of ['primary', 'secondary'] as const) {
    const window = candidate.value[key];
    if (window === undefined) continue;
    if (!isPlainRecord(window)) throw new Error('Invalid Codex rate limits snapshot');
    if (window.remaining !== undefined && (typeof window.remaining !== 'number' || !Number.isFinite(window.remaining))) throw new Error('Invalid Codex rate limits snapshot');
    if (window.usedPercent !== undefined && (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent))) throw new Error('Invalid Codex rate limits snapshot');
    if (window.resetsAt !== undefined && window.resetsAt !== null && typeof window.resetsAt !== 'number' && typeof window.resetsAt !== 'string') throw new Error('Invalid Codex rate limits snapshot');
  }
}

function validateMcpStartupStatusSnapshot(snapshot: unknown): asserts snapshot is CodexMcpStartupStatusSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertOnlyKeys(candidate, ['generationId', 'sequence', 'value'], 'Codex MCP startup snapshot');
  assertProviderVisibleJson(candidate.value, 'MCP startup status');
  if (!isPlainRecord(candidate.value)) throw new Error('Invalid Codex MCP startup snapshot');
  for (const [serverId, state] of Object.entries(candidate.value)) {
    if (!serverId.trim()) throw new Error('Invalid Codex MCP startup snapshot');
    // 顶层键是 MCP 服务标识而非负载字段；密钥规则继续应用于每个服务的状态内容。
    assertNoSecretLikeProviderKeys(state, new Set<string>(), `snapshot.${serverId}`);
    if (typeof state === 'string') continue;
    if (!isPlainRecord(state) || typeof state.status !== 'string') throw new Error('Invalid Codex MCP startup snapshot');
    assertOnlyKeys(state, ['status', 'error'], 'Codex MCP server startup state');
    if (state.error !== undefined && state.error !== null && typeof state.error !== 'string') throw new Error('Invalid Codex MCP startup snapshot');
  }
}

function shouldAcceptProviderSnapshot(db: ZeusDatabase, incoming: ProviderSequenceSnapshot, current: ProviderSequenceSnapshot | undefined): boolean {
  const row = db.get<{ value_json: string }>(`SELECT value_json FROM settings WHERE key = ?`, [providerGenerationOrderSettingKey]);
  let generationIds: string[] = [];
  if (row) {
    const parsed = parseStoredJson(row.value_json);
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.generationIds) || !parsed.generationIds.every((value) => typeof value === 'string' && value)) throw new Error('Invalid persisted provider generation order');
    generationIds = [...new Set(parsed.generationIds)];
  }
  let changed = false;
  for (const generationId of [current?.generationId, incoming.generationId]) {
    if (generationId && !generationIds.includes(generationId)) {
      generationIds.push(generationId);
      changed = true;
    }
  }
  if (changed) {
    const timestamp = nowIso();
    db.execute(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [providerGenerationOrderSettingKey, JSON.stringify({ generationIds }), timestamp],
    );
  }
  const incomingEpoch = generationIds.indexOf(incoming.generationId);
  if (incomingEpoch < generationIds.length - 1) return false;
  return !(current && current.generationId === incoming.generationId && current.sequence >= incoming.sequence);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Invalid ${label}`);
}

function assertNoSecretLikeProviderKeys(value: unknown, allowedTokenCounters = new Set<string>(), path = 'snapshot', seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`Invalid cyclic provider state at ${path}`);
  seen.add(value);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
    const tokenLike = normalized.includes('token') && !allowedTokenCounters.has(normalized);
    const secretKeyLike =
      normalized === 'key' || ['apikey', 'accesskey', 'secretkey', 'privatekey', 'signingkey', 'encryptionkey', 'decryptionkey', 'sessionkey', 'serviceaccountkey', 'clientkey', 'keymaterial'].some((marker) => normalized.includes(marker));
    if (tokenLike || secretKeyLike || ['secret', 'authorization', 'credential', 'password', 'passphrase', 'bearer', 'cookie'].some((marker) => normalized.includes(marker))) {
      throw new Error(`Secret-like provider field rejected: ${path}.${key}`);
    }
    assertNoSecretLikeProviderKeys(nested, allowedTokenCounters, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function assertProviderVisibleJson(value: unknown, label: string, seen = new WeakSet<object>()): asserts value is ProviderVisibleJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid ${label} provider state`);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error(`Invalid ${label} provider state`);
  seen.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const nested of entries) assertProviderVisibleJson(nested, label, seen);
  seen.delete(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function throwIdempotencyConflict(scope: string, key: string): never {
  throw Object.assign(new Error(`Idempotency key conflict for ${scope}/${key}`), { code: 'ZEUS_IDEMPOTENCY_CONFLICT' as const });
}

function serializeProviderRequestId(value: string | number): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Provider request id must be a finite JSON scalar');
  return JSON.stringify(value);
}

function parseStoredJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function assertConversationServerRequestIdentity(existing: DbConversationServerRequestRow, requestKind: ConversationServerRequestKind, payload: unknown, containsSecret: boolean): void {
  const sameKind = existing.request_kind === requestKind;
  const samePayload = canonicalJson(existing.payload_json ? parseStoredJson(existing.payload_json) : undefined) === canonicalJson(payload);
  const sameSecretClassification = (existing.contains_secret === 1) === containsSecret;
  if (sameKind && samePayload && sameSecretClassification) return;
  throw Object.assign(new Error('Codex server request identity conflicts with an existing generation-scoped provider request.'), {
    code: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT' as const,
  });
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function hasSecretUserInputQuestion(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.some(hasSecretUserInputQuestion);
  if (!isPlainRecord(payload)) return false;
  if (Array.isArray(payload.questions) && payload.questions.some((question) => isPlainRecord(question) && question.isSecret === true)) return true;
  return Object.values(payload).some(hasSecretUserInputQuestion);
}

function extractUserInputQuestionIds(payload: unknown): string[] {
  if (!isPlainRecord(payload) || !Array.isArray(payload.questions)) return [];
  return payload.questions.flatMap((question) => {
    if (!isPlainRecord(question)) return [];
    const id = typeof question.id === 'string' ? question.id : typeof question.questionId === 'string' ? question.questionId : undefined;
    return id ? [id] : [];
  });
}

function countUserInputAnswers(response: unknown): number {
  if (!isPlainRecord(response) || !isPlainRecord(response.answers)) return 0;
  let count = 0;
  for (const answer of Object.values(response.answers)) {
    if (Array.isArray(answer)) count += answer.length;
    else if (isPlainRecord(answer) && Array.isArray(answer.answers)) count += answer.answers.length;
    else if (answer !== undefined && answer !== null) count += 1;
  }
  return count;
}

function createSecretResponseSummary(payload: unknown, response: unknown, questionIds?: string[], answerCount?: number): { questionIds: string[]; answerCount: number; answers: '[REDACTED]'; publicAnswers: Record<string, string[]> } {
  return {
    questionIds: questionIds ?? extractUserInputQuestionIds(payload),
    answerCount: answerCount ?? countUserInputAnswers(response),
    answers: '[REDACTED]',
    publicAnswers: extractNonSecretUserInputAnswers(payload, response),
  };
}

function extractNonSecretUserInputAnswers(payload: unknown, response: unknown): Record<string, string[]> {
  if (!isPlainRecord(payload) || !Array.isArray(payload.questions) || !isPlainRecord(response) || !isPlainRecord(response.answers)) return {};
  const publicQuestionIds = new Set(
    payload.questions.flatMap((question) => {
      if (!isPlainRecord(question) || question.isSecret !== false) return [];
      const id = typeof question.id === 'string' ? question.id : typeof question.questionId === 'string' ? question.questionId : undefined;
      return id ? [id] : [];
    }),
  );
  return Object.fromEntries(
    Object.entries(response.answers).flatMap(([questionId, answer]) => {
      if (!publicQuestionIds.has(questionId) || !isPlainRecord(answer) || !Array.isArray(answer.answers) || !answer.answers.every((entry) => typeof entry === 'string')) return [];
      return [[questionId, answer.answers]];
    }),
  );
}

function redactSecretValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretValues);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => (/^(?:answer|answers|value|secret)$/iu.test(key) ? [key, '[REDACTED]'] : [key, redactSecretValues(nested)])));
}

/** Git 快照仓储只记录状态与 diff 路径，不主动执行任何 Git 写操作。 */
export class GitSnapshotRepository {
  constructor(private readonly db: ZeusDatabase) {}

  createSnapshot(input: CreateGitSnapshotInput): ZeusGitSnapshotRecord {
    const record: ZeusGitSnapshotRecord = {
      id: `git_snapshot_${nanoid(12)}`,
      taskId: input.taskId,
      projectId: input.projectId,
      snapshotType: input.snapshotType,
      branch: input.branch ?? null,
      headSha: input.headSha ?? null,
      statusJson: JSON.stringify(input.status),
      diffTextPath: input.diffTextPath ?? null,
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO git_snapshots (id, task_id, project_id, snapshot_type, branch, head_sha, status_json, diff_text_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.taskId, record.projectId, record.snapshotType, record.branch, record.headSha, record.statusJson, record.diffTextPath, record.createdAt],
    );
    return record;
  }

  createChange(input: CreateGitChangeInput): ZeusGitChangeRecord {
    const record: ZeusGitChangeRecord = {
      id: `git_change_${nanoid(12)}`,
      taskId: input.taskId,
      projectId: input.projectId,
      filePath: input.filePath,
      changeType: input.changeType,
      additions: input.additions ?? 0,
      deletions: input.deletions ?? 0,
      diffHunkPath: input.diffHunkPath ?? null,
      linkedGraphNodesJson: JSON.stringify(input.linkedGraphNodes ?? []),
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO git_changes (id, task_id, project_id, file_path, change_type, additions, deletions, diff_hunk_path, linked_graph_nodes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.taskId, record.projectId, record.filePath, record.changeType, record.additions, record.deletions, record.diffHunkPath, record.linkedGraphNodesJson, record.createdAt],
    );
    return record;
  }

  listSnapshots(taskId: string): ZeusGitSnapshotRecord[] {
    return this.db
      .select<DbGitSnapshotRow>(
        `SELECT id, task_id, project_id, snapshot_type, branch, head_sha, status_json, diff_text_path, created_at
       FROM git_snapshots WHERE task_id = ? ORDER BY created_at ASC`,
        [taskId],
      )
      .map(mapGitSnapshotRow);
  }

  listChanges(taskId: string): ZeusGitChangeRecord[] {
    return this.db
      .select<DbGitChangeRow>(
        `SELECT id, task_id, project_id, file_path, change_type, additions, deletions, diff_hunk_path, linked_graph_nodes_json, created_at
       FROM git_changes WHERE task_id = ? ORDER BY file_path ASC, created_at ASC`,
        [taskId],
      )
      .map(mapGitChangeRow);
  }
}

/** 审计日志仓储记录真实本地/远程动作，payload 由调用方传入且不写入默认假数据。 */
export class AuditLogRepository {
  constructor(private readonly db: ZeusDatabase) {}

  append(input: AppendAuditLogInput): ZeusAuditLogRecord {
    const record: ZeusAuditLogRecord = {
      id: `audit_log_${nanoid(12)}`,
      actorType: input.actorType,
      actorRef: input.actorRef ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      payloadJson: JSON.stringify(input.payload),
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO audit_logs (id, actor_type, actor_ref, action, resource_type, resource_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.actorType, record.actorRef, record.action, record.resourceType, record.resourceId, record.payloadJson, record.createdAt],
    );
    return record;
  }

  listRecent(limit = 20): ZeusAuditLogRecord[] {
    return this.db
      .select<DbAuditLogRow>(
        `SELECT id, actor_type, actor_ref, action, resource_type, resource_id, payload_json, created_at
       FROM audit_logs ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        [limit],
      )
      .map(mapAuditLogRow);
  }
}

interface DbTaskEventRow {
  id: string;
  task_id: string;
  event_type: string;
  title: string;
  payload_json: string;
  created_at: string;
}

interface DbRuntimeSessionRow {
  id: string;
  project_id: string;
  task_id: string | null;
  command: string;
  args_json: string;
  cwd: string;
  status: RuntimeSessionStatus;
  pid: number | null;
  process_identity_token: string | null;
  exit_code: number | null;
  summary: string | null;
  favorite: number;
  archived: number;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface DbRuntimeLogRow {
  id: string;
  session_id: string;
  stream: RuntimeLogStream;
  text: string;
  created_at: string;
}

interface DbSequencedRuntimeLogRow extends DbRuntimeLogRow {
  sequence: number;
}

interface DbRuntimeLogMetadataRow {
  id: string;
  session_id: string;
  stream: RuntimeLogStream;
  created_at: string;
  sequence: number;
  byte_length: number;
}

interface DbTerminalEventRow {
  id: string;
  session_id: string;
  task_id: string | null;
  seq: number;
  event_type: string;
  content: string;
  raw_chunk_path: string | null;
  created_at: string;
}

interface DbConversationRow {
  id: string;
  project_id: string;
  task_id: string | null;
  workspace_id: string | null;
  environment_id: string | null;
  session_id: string | null;
  title: string;
  summary: string | null;
  status: string;
  stage: ConversationStage;
  stage_updated_at: string;
  created_at: string;
  updated_at: string;
  archived: number;
  transport_kind: ConversationTransportKind;
  provider_id: string | null;
  provider_thread_id: string | null;
  provider_thread_path: string | null;
  provider_model: string | null;
  provider_state: ConversationProviderState;
  provider_protocol_version: string | null;
  provider_binary_version: string | null;
  legacy_source_conversation_id: string | null;
  provider_settings_json: string;
  provider_token_usage_json: string;
  permission_mode: ConversationPermissionMode;
  collaboration_mode: ConversationCollaborationMode;
  next_turn_settings_json: string;
  completion_unread: number;
  agent_kind: ConversationAgentKind | null;
  agent_transport: ConversationAgentTransport | null;
  model_source_id: string | null;
  model_id: string | null;
  native_session_id: string | null;
  native_session_path: string | null;
  capability_snapshot_id: string | null;
}

interface DbConversationMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  source: string;
  metadata_json: string;
  created_at: string;
  provider_thread_id: string | null;
  provider_turn_id: string | null;
  provider_item_id: string | null;
  client_message_id: string | null;
}

interface DbCodexLegacyImportRow {
  id: string;
  provider_import_id: string | null;
  source_conversation_id: string;
  target_conversation_id: string | null;
  snapshot_path: string;
  snapshot_sha256: string;
  status: CodexLegacyImportStatus;
  target_thread_id: string | null;
  failure_stage: string | null;
  failure_message: string | null;
  provider_binary_version: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface DbConversationTurnRow {
  id: string;
  conversation_id: string;
  provider_thread_id: string;
  provider_turn_id: string | null;
  client_submission_id: string;
  status: ConversationTurnStatus;
  error_json: string | null;
  plan_json: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  agent_kind: ConversationAgentKind | null;
  native_run_id: string | null;
}

interface DbCodexUsageLedgerRow {
  id: string;
  provider_id: string;
  account_scope_id: string;
  project_id: string;
  conversation_id: string;
  provider_thread_id: string;
  provider_turn_id: string;
  model: string;
  service_tier: string | null;
  total_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  estimate_json: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
}

interface DbConversationItemRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  provider_thread_id: string;
  provider_turn_id: string;
  provider_item_id: string;
  item_type: ConversationItemType;
  status: ConversationItemStatus;
  phase: ConversationItemPhase;
  text_content: string;
  payload_json: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  agent_kind: ConversationAgentKind | null;
  native_item_id: string | null;
}

interface DbAgentCapabilitySnapshotRow {
  id: string;
  agent_kind: ConversationAgentKind;
  transport_kind: ConversationAgentTransport;
  support_status: AgentCapabilitySupportStatus;
  adapter_version: string | null;
  binary_version: string | null;
  protocol_version: string | null;
  capabilities_json: string;
  evidence_json: string;
  checked_at: string;
}

interface DbConversationResourceRow {
  id: string;
  project_id: string;
  conversation_id: string;
  turn_id: string;
  item_id: string;
  source_index: number;
  canonical_target_digest: string;
  kind: ConversationResourceKind;
  presentation: ConversationResourcePresentation;
  display_json: string;
  target_json: string;
  authority_json: string;
  created_at: string;
  updated_at: string;
}

interface DbTurnChangeSetRow {
  id: string;
  project_id: string;
  conversation_id: string;
  turn_id: string;
  provider_turn_id: string;
  state: TurnChangeSetState;
  unified_diff: string;
  pre_image_digest: string | null;
  post_image_digest: string | null;
  conflict_json: string | null;
  unavailable_reason: string | null;
  journal_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTurnChangeFileRow {
  id: string;
  change_set_id: string;
  source_item_id: string | null;
  source_index: number;
  old_path: string | null;
  new_path: string | null;
  change_type: TurnChangeFileType;
  added_lines: number;
  deleted_lines: number;
  pre_hash: string | null;
  post_hash: string | null;
  pre_exists: number;
  post_exists: number;
  pre_mode: number | null;
  post_mode: number | null;
  unified_diff: string;
  pre_blob_ref: string | null;
  post_blob_ref: string | null;
  reversible: number;
  unavailable_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface DbConversationSubmissionRow {
  id: string;
  conversation_id: string;
  idempotency_key: string;
  request_hash: string;
  client_message_id: string;
  kind: ConversationSubmissionKind;
  requested_delivery: ConversationRequestedDelivery;
  status: ConversationSubmissionStatus;
  queue_position: number | null;
  input_json: string;
  target_provider_turn_id: string | null;
  provider_turn_id: string | null;
  paused_reason: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  resolved_at: string | null;
}

interface DbConversationServerRequestRow {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  item_id: string | null;
  transport_generation_id: string;
  provider_request_id_json: string;
  request_kind: ConversationServerRequestKind;
  payload_json: string;
  status: ConversationServerRequestStatus;
  response_json: string | null;
  contains_secret: number;
  expires_at: string | null;
  auto_resolution_state: ConversationRequestAutoResolutionState;
  created_at: string;
  resolved_at: string | null;
}

interface DbConversationPlanActionRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  plan_item_id: string;
  status: ConversationPlanActionStatus;
  submission_id: string | null;
  created_at: string;
  resolved_at: string | null;
  updated_at: string;
}

interface DbIdempotencyRequestRow {
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: IdempotencyRequestStatus;
  http_status: number | null;
  response_json: string | null;
  resource_id: string | null;
  created_at: string;
  updated_at: string;
}

interface DbGitSnapshotRow {
  id: string;
  task_id: string;
  project_id: string;
  snapshot_type: string;
  branch: string | null;
  head_sha: string | null;
  status_json: string;
  diff_text_path: string | null;
  created_at: string;
}

interface DbGitChangeRow {
  id: string;
  task_id: string;
  project_id: string;
  file_path: string;
  change_type: string;
  additions: number;
  deletions: number;
  diff_hunk_path: string | null;
  linked_graph_nodes_json: string;
  created_at: string;
}

interface DbAuditLogRow {
  id: string;
  actor_type: string;
  actor_ref: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  payload_json: string;
  created_at: string;
}

interface DbSettingRow {
  key: string;
  value_json: string;
  updated_at: string;
}

interface DbProjectRow {
  id: string;
  name: string;
  slug: string;
  local_path: string;
  description: string | null;
  note: string | null;
  default_template_id: string | null;
  scan_status: ZeusProjectRecord['scanStatus'];
  created_at: string;
  updated_at: string;
}

interface DbProjectRepositoryRow {
  id: string;
  project_id: string;
  name: string;
  relative_path: string;
  local_path: string;
  created_at: string;
  updated_at: string;
}

interface DbProjectSharedPathRow {
  id: string;
  project_id: string;
  relative_path: string;
  local_path: string;
  created_at: string;
  updated_at: string;
}

interface DbTaskEnvironmentRow {
  id: string;
  project_id: string;
  task_id: string;
  root_path: string | null;
  state: TaskEnvironmentState;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTaskRow {
  id: string;
  project_id: string;
  task_code: string | null;
  task_sequence: number | null;
  parent_task_id: string | null;
  title: string;
  task_type: string;
  description: string;
  defect_current_state: string;
  defect_expected_outcome: string;
  defect_reproduction_steps: string;
  optimization_current_state: string;
  optimization_expected_outcome: string;
  management_status: string;
  status: ZeusTaskRecord['status'];
  priority: string;
  tags_json: string;
  template_id: string | null;
  allow_code_changes: number;
  allow_tests: number;
  allow_git_commit: number;
  created_from: string;
  source_context_json: string;
  created_at: string;
  updated_at: string;
}

interface DbTaskWorkspaceRow {
  id: string;
  project_id: string;
  task_id: string;
  environment_id: string | null;
  repository_id: string | null;
  repository_name: string;
  repository_relative_path: string;
  repository_path: string;
  branch_name: string;
  source_branch: string;
  source_head_sha: string;
  remote_name: string;
  remote_branch: string;
  worktree_path: string | null;
  head_sha: string | null;
  state: TaskWorkspaceState;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTaskIntegrationRow {
  id: string;
  project_id: string;
  task_id: string;
  workspace_id: string;
  target_branch: string;
  target_head_sha: string;
  task_head_sha: string | null;
  mode: TaskIntegrationMode;
  integration_path: string | null;
  result_head_sha: string | null;
  state: TaskIntegrationState;
  local_sync_status: TaskIntegrationLocalSyncStatus | null;
  local_head_sha: string | null;
  local_worktree_path: string | null;
  conflict_files_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTaskTemplateRow {
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

function mapTaskEventRow(row: DbTaskEventRow): ZeusTaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    eventType: row.event_type,
    title: row.title,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function mapRuntimeSessionRow(row: DbRuntimeSessionRow): ZeusRuntimeSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    command: row.command,
    argsJson: row.args_json,
    cwd: row.cwd,
    status: row.status,
    pid: row.pid,
    processIdentityToken: row.process_identity_token,
    exitCode: row.exit_code,
    summary: row.summary,
    favorite: row.favorite === 1,
    archived: row.archived === 1,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function runtimeSessionSelectSql(whereClause: string): string {
  return `SELECT id, project_id, task_id, command, args_json, cwd, status, pid, process_identity_token, exit_code, summary, favorite, archived, started_at, ended_at, created_at, updated_at, deleted_at
          FROM runtime_sessions ${whereClause}`;
}

function mapRuntimeLogRow(row: DbRuntimeLogRow): ZeusRuntimeLogRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    stream: row.stream,
    text: row.text,
    createdAt: row.created_at,
  };
}

function mapTerminalEventRow(row: DbTerminalEventRow): ZeusTerminalEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    seq: row.seq,
    eventType: row.event_type,
    content: row.content,
    rawChunkPath: row.raw_chunk_path,
    createdAt: row.created_at,
  };
}

function mapConversationRow(row: DbConversationRow): ZeusConversationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    environmentId: row.environment_id,
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    stage: assertEnum(row.stage, ['created', 'connecting', 'queued', 'running', 'waiting_user', 'waiting_approval', 'completed', 'failed', 'paused', 'ready', 'archived'] as const, 'conversation stage'),
    stageUpdatedAt: row.stage_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    transportKind: row.transport_kind,
    providerId: row.provider_id,
    providerThreadId: row.provider_thread_id,
    providerThreadPath: row.provider_thread_path,
    providerModel: row.provider_model,
    providerState: row.provider_state,
    providerProtocolVersion: row.provider_protocol_version,
    providerBinaryVersion: row.provider_binary_version,
    legacySourceConversationId: row.legacy_source_conversation_id,
    providerSettingsJson: row.provider_settings_json,
    providerTokenUsageJson: row.provider_token_usage_json,
    permissionMode: assertEnum(row.permission_mode, ['read-only', 'auto', 'full-access'] as const, 'conversation permission mode'),
    collaborationMode: assertEnum(row.collaboration_mode, ['default', 'plan'] as const, 'conversation collaboration mode'),
    nextTurnSettingsJson: row.next_turn_settings_json,
    completionUnread: row.completion_unread === 1,
    agentKind: row.agent_kind,
    agentTransport: row.agent_transport,
    modelSourceId: row.model_source_id,
    modelId: row.model_id,
    nativeSessionId: row.native_session_id,
    nativeSessionPath: row.native_session_path,
    capabilitySnapshotId: row.capability_snapshot_id,
  };
}

function mapConversationMessageRow(row: DbConversationMessageRow): ZeusConversationMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    source: row.source,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    providerItemId: row.provider_item_id,
    clientMessageId: row.client_message_id,
  };
}

function mapCodexLegacyImportRow(row: DbCodexLegacyImportRow): ZeusCodexLegacyImportRecord {
  return {
    id: row.id,
    providerImportId: row.provider_import_id,
    sourceConversationId: row.source_conversation_id,
    targetConversationId: row.target_conversation_id,
    snapshotPath: row.snapshot_path,
    snapshotSha256: row.snapshot_sha256,
    status: row.status,
    targetThreadId: row.target_thread_id,
    failureStage: row.failure_stage,
    failureMessage: row.failure_message,
    providerBinaryVersion: row.provider_binary_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapConversationTurnRow(row: DbConversationTurnRow): ZeusConversationTurnRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    clientSubmissionId: row.client_submission_id,
    status: row.status,
    errorJson: row.error_json,
    planJson: row.plan_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agentKind: row.agent_kind,
    nativeRunId: row.native_run_id,
  };
}

function mapCodexUsageLedgerRow(row: DbCodexUsageLedgerRow): CodexUsageLedgerRecord {
  const estimate = JSON.parse(row.estimate_json) as CodexUsageEstimate;
  validateCodexUsageEstimate(estimate);
  return {
    id: row.id,
    providerId: row.provider_id,
    accountScopeId: row.account_scope_id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    model: row.model,
    serviceTier: row.service_tier,
    usage: {
      totalTokens: row.total_tokens,
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      cacheWriteInputTokens: row.cache_write_input_tokens,
      outputTokens: row.output_tokens,
      reasoningOutputTokens: row.reasoning_output_tokens,
    },
    estimate,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversationItemRow(row: DbConversationItemRow): ZeusConversationItemRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    providerItemId: row.provider_item_id,
    itemType: row.item_type,
    status: row.status,
    phase: row.phase,
    textContent: row.text_content,
    payloadJson: row.payload_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    agentKind: row.agent_kind,
    nativeItemId: row.native_item_id,
  };
}

function mapAgentCapabilitySnapshotRow(row: DbAgentCapabilitySnapshotRow): ZeusAgentCapabilitySnapshotRecord {
  return {
    id: row.id,
    agentKind: row.agent_kind,
    transportKind: row.transport_kind,
    supportStatus: row.support_status,
    adapterVersion: row.adapter_version,
    binaryVersion: row.binary_version,
    protocolVersion: row.protocol_version,
    capabilitiesJson: row.capabilities_json,
    evidenceJson: row.evidence_json,
    checkedAt: row.checked_at,
  };
}

function mapConversationResourceRow(row: DbConversationResourceRow): ZeusConversationResourceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    sourceIndex: row.source_index,
    canonicalTargetDigest: row.canonical_target_digest,
    kind: row.kind,
    presentation: row.presentation,
    displayJson: row.display_json,
    targetJson: row.target_json,
    authorityJson: row.authority_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTurnChangeSetRow(row: DbTurnChangeSetRow): ZeusTurnChangeSetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    providerTurnId: row.provider_turn_id,
    state: row.state,
    unifiedDiff: row.unified_diff,
    preImageDigest: row.pre_image_digest,
    postImageDigest: row.post_image_digest,
    conflictJson: row.conflict_json,
    unavailableReason: row.unavailable_reason,
    journalRef: row.journal_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTurnChangeFileRow(row: DbTurnChangeFileRow): ZeusTurnChangeFileRecord {
  return {
    id: row.id,
    changeSetId: row.change_set_id,
    sourceItemId: row.source_item_id,
    sourceIndex: row.source_index,
    oldPath: row.old_path,
    newPath: row.new_path,
    changeType: row.change_type,
    addedLines: row.added_lines,
    deletedLines: row.deleted_lines,
    preHash: row.pre_hash,
    postHash: row.post_hash,
    preExists: row.pre_exists === 1,
    postExists: row.post_exists === 1,
    preMode: row.pre_mode,
    postMode: row.post_mode,
    unifiedDiff: row.unified_diff,
    preBlobRef: row.pre_blob_ref,
    postBlobRef: row.post_blob_ref,
    reversible: row.reversible === 1,
    unavailableReason: row.unavailable_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversationSubmissionRow(row: DbConversationSubmissionRow): ZeusConversationSubmissionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    clientMessageId: row.client_message_id,
    kind: row.kind,
    requestedDelivery: row.requested_delivery,
    status: row.status,
    queuePosition: row.queue_position,
    inputJson: row.input_json,
    targetProviderTurnId: row.target_provider_turn_id,
    providerTurnId: row.provider_turn_id,
    pausedReason: row.paused_reason,
    errorJson: row.error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
    resolvedAt: row.resolved_at,
  };
}

function mapConversationServerRequestRow(row: DbConversationServerRequestRow): ZeusConversationServerRequestRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    transportGenerationId: row.transport_generation_id,
    providerRequestIdJson: row.provider_request_id_json,
    requestKind: row.request_kind,
    payloadJson: row.payload_json,
    status: row.status,
    responseJson: row.response_json,
    containsSecret: row.contains_secret === 1,
    expiresAt: row.expires_at,
    autoResolutionState: assertEnum(row.auto_resolution_state, ['none', 'scheduled', 'snoozed'] as const, 'request auto resolution state'),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function mapConversationPlanActionRow(row: DbConversationPlanActionRow): ZeusConversationPlanActionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    planItemId: row.plan_item_id,
    status: assertEnum(row.status, ['pending', 'dismissed', 'implemented', 'refinement_requested', 'superseded'] as const, 'conversation plan action status'),
    submissionId: row.submission_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
  };
}

function mapIdempotencyRequestRow(row: DbIdempotencyRequestRow): ZeusIdempotencyRequestRecord {
  return {
    scope: row.scope,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    httpStatus: row.http_status,
    responseJson: row.response_json,
    resourceId: row.resource_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGitSnapshotRow(row: DbGitSnapshotRow): ZeusGitSnapshotRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    snapshotType: row.snapshot_type,
    branch: row.branch,
    headSha: row.head_sha,
    statusJson: row.status_json,
    diffTextPath: row.diff_text_path,
    createdAt: row.created_at,
  };
}

function mapGitChangeRow(row: DbGitChangeRow): ZeusGitChangeRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    filePath: row.file_path,
    changeType: row.change_type,
    additions: row.additions,
    deletions: row.deletions,
    diffHunkPath: row.diff_hunk_path,
    linkedGraphNodesJson: row.linked_graph_nodes_json,
    createdAt: row.created_at,
  };
}

function mapAuditLogRow(row: DbAuditLogRow): ZeusAuditLogRecord {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorRef: row.actor_ref,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function mapProjectRow(row: DbProjectRow): ZeusProjectRecord {
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

function mapProjectRepositoryRow(row: DbProjectRepositoryRow): ZeusProjectRepositoryRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    relativePath: row.relative_path,
    localPath: row.local_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProjectSharedPathRow(row: DbProjectSharedPathRow): ZeusProjectSharedPathRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    relativePath: row.relative_path,
    localPath: row.local_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskEnvironmentRow(row: DbTaskEnvironmentRow): ZeusTaskEnvironmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    rootPath: row.root_path,
    state: assertEnum(row.state, ['ready', 'reclaimed', 'failed'] as const, 'task environment state'),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskRow(row: DbTaskRow): ZeusTaskRecord {
  const sequence = normalizeTaskSequence(row.task_sequence);
  return {
    id: row.id,
    projectId: row.project_id,
    taskCode: normalizeTaskCode(row.task_code, sequence),
    taskSequence: sequence,
    parentTaskId: row.parent_task_id,
    relatedTaskIds: [],
    title: row.title,
    taskType: isTaskType(row.task_type) ? row.task_type : 'requirement',
    description: row.description,
    defectCurrentState: row.defect_current_state ?? '',
    defectExpectedOutcome: row.defect_expected_outcome ?? '',
    defectReproductionSteps: row.defect_reproduction_steps ?? '',
    optimizationCurrentState: row.optimization_current_state ?? '',
    optimizationExpectedOutcome: row.optimization_expected_outcome ?? '',
    managementStatus: isTaskManagementStatus(row.management_status) ? row.management_status : 'todo',
    status: row.status,
    priority: row.priority || 'normal',
    allowCodeChanges: row.allow_code_changes === 1,
    allowTests: row.allow_tests === 1,
    allowGitCommit: row.allow_git_commit === 1,
    templateId: row.template_id,
    tags: parseTagsJson(row.tags_json),
    createdFrom: row.created_from,
    sourceContextJson: row.source_context_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskWorkspaceRow(row: DbTaskWorkspaceRow): ZeusTaskWorkspaceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    environmentId: row.environment_id,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    repositoryRelativePath: row.repository_relative_path,
    repositoryPath: row.repository_path,
    branchName: row.branch_name,
    sourceBranch: row.source_branch,
    sourceHeadSha: row.source_head_sha,
    remoteName: row.remote_name,
    remoteBranch: row.remote_branch,
    worktreePath: row.worktree_path,
    headSha: row.head_sha,
    state: assertEnum(row.state, ['ready', 'reclaimed', 'merged', 'discarded', 'failed'] as const, 'task workspace state'),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskIntegrationRow(row: DbTaskIntegrationRow): ZeusTaskIntegrationRecord {
  let conflictFiles: string[] = [];
  try {
    const parsed = JSON.parse(row.conflict_files_json) as unknown;
    if (Array.isArray(parsed)) conflictFiles = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    conflictFiles = [];
  }
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    targetBranch: row.target_branch,
    targetHeadSha: row.target_head_sha,
    taskHeadSha: row.task_head_sha,
    mode: assertEnum(row.mode, ['merge', 'squash'] as const, 'task integration mode'),
    integrationPath: row.integration_path,
    resultHeadSha: row.result_head_sha,
    state: assertEnum(row.state, ['preparing', 'conflicted', 'pending_local_sync', 'merged', 'failed'] as const, 'task integration state'),
    localSyncStatus: row.local_sync_status ? assertEnum(row.local_sync_status, ['synced', 'pending'] as const, 'task integration local sync status') : null,
    localHeadSha: row.local_head_sha,
    localWorktreePath: row.local_worktree_path,
    conflictFiles,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskTemplateRow(row: DbTaskTemplateRow): ZeusTaskTemplateRecord {
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
