import type {
  AgentCatalogSnapshot,
  ArchivedConversationChoicesSnapshot,
  BatchTaskWorkspaceResponse,
  CodexAccountSnapshot,
  CodexChatGptLogin,
  CodexConversationCapabilities,
  CodexTaskPushCapabilities,
  CodexTaskRepositoryCapability,
  ConversationResourcePreview,
  NativeCollaborationMode,
  NativeConversationChoice,
  NativeConversationChoicesSnapshot,
  NativeConversationSnapshot,
  NativeNextTurnSettings,
  NativeOperationAcceptance,
  NativePendingRequest,
  NativePermissionMode,
  NativePlanImplementationRequest,
  NativeProjectConversationChoicesSnapshot,
  NativeQueueSnapshot,
  SendNativeMessageRequest,
  StartNativeConversationRequest,
  StartProjectConversationRequest,
  StartTaskModelPushRequest,
  TaskGitDiffSummary,
  TaskIntegrationConflictAiSession,
  TaskIntegrationConflictFile,
  TaskIntegrationConflictPermissionMode,
  TaskIntegrationPushResult,
  TaskIntegrationRecord,
  TaskIntegrationResult,
  TaskWorkspaceCommitResult,
  TaskWorkspaceIndexCollection,
  TaskWorkspacePushResult,
  TaskWorkspaceSnapshotResponse,
  TaskWorkspacesSnapshot,
  TurnChangeSet,
  TurnChangeSetOperationResult,
} from './session/sessionTypes.js';
import type {
  CommandArtifact,
  CommandConfirmation,
  CommandDefinition,
  CommandDefinitionInput,
  CommandRun,
  ProjectCodeWorkspacePreference,
  TaskAttachmentReference,
  TaskManagementStatus,
  TaskManagementStatusConfig,
  TaskPriority,
  TaskStatusFilter,
  TaskType,
  CodexUsageAnalyticsSnapshot,
  CodexUsageRange,
  CodexUsageSummarySnapshot,
} from '@zeus/shared';

export type {
  CommandArtifact,
  CommandConfirmation,
  CommandDefinition,
  CommandDefinitionInput,
  CommandParameterDefinition,
  CommandRun,
  CommandRunStatus,
  TaskManagementStatus,
  TaskManagementStatusConfig,
  TaskPriority,
  TaskStatusFilter,
  TaskType,
} from '@zeus/shared';

export type TaskStatus = 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';
export type TaskAgentRunStatus = 'not_started' | 'connecting' | 'reconnecting' | 'running' | 'waiting_user' | 'waiting_approval' | 'paused' | 'idle' | 'failed' | 'legacy_readonly';
export type TaskTableColumnKey =
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
export type TaskTableColumnWidth = number;
export type TaskTableSortDirection = 'asc' | 'desc';

export interface NativeProjectConversationChoiceGroupsSnapshot {
  projectId: string;
  projectChoices: NativeProjectConversationChoicesSnapshot;
  taskChoicesByTaskId: Record<string, NativeConversationChoicesSnapshot>;
}

export interface TaskTableSortState {
  columnKey: TaskTableColumnKey | null;
  direction: TaskTableSortDirection | null;
}

export interface TaskTableColumnPreferences {
  visibleColumnKeys: TaskTableColumnKey[];
  columnOrder: TaskTableColumnKey[];
  columnWidths?: Partial<Record<TaskTableColumnKey, TaskTableColumnWidth>>;
  sort: TaskTableSortState;
}

export interface TaskTableEnumSortOrders {
  priority: TaskPriority[];
  managementStatus: TaskManagementStatus[];
  runStatus: TaskAgentRunStatus[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  localPath: string;
  description?: string | null;
  note?: string | null;
  scanStatus: string;
  defaultTemplateId?: string | null;
}

export interface ProjectWorkspaceSharedPath {
  id: string;
  projectId: string;
  relativePath: string;
  localPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWorkspaceConfigSnapshot {
  projectId: string;
  containerPath: string;
  sharedWritablePaths: ProjectWorkspaceSharedPath[];
}

export type ProjectWorkMode = 'plan' | 'develop' | 'review' | 'debug';
export type ProjectIndexScope = 'project' | 'src' | 'custom';

export interface ProjectConfig {
  projectId: string;
  defaultModel: string | null;
  defaultWorkMode: ProjectWorkMode;
  defaultTaskPrompt: string;
  scan: {
    ignoreDirectories: string[];
    indexScope: ProjectIndexScope;
  };
  language: {
    primary: string;
    additional: string[];
  };
  dependencies: {
    packageManagers: string[];
    manifestPaths: string[];
  };
  vcs: {
    isGitRepository: boolean;
    gitRoot: string | null;
  };
  database: {
    connectionName: string | null;
    schemaPaths: string[];
  };
  telegram: {
    alias: string | null;
  };
  security: {
    allowShell: boolean;
    allowGitWrite: boolean;
  };
}

export type SaveProjectConfigRequest = Omit<ProjectConfig, 'projectId' | 'vcs'> & { vcs?: ProjectConfig['vcs'] };

export interface TaskRecord {
  id: string;
  projectId: string;
  taskCode?: string;
  taskSequence?: number | null;
  parentTaskId?: string | null;
  relatedTaskIds?: string[];
  title: string;
  taskType: TaskType;
  description?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  managementStatus?: TaskManagementStatus;
  status: TaskStatus;
  priority?: string;
  templateId?: string | null;
  tags?: string[];
  createdFrom?: string;
  sourceContextJson?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskTemplateRecord {
  id: string;
  name: string;
  description: string;
  category?: string;
  promptTemplate: string;
  defaultOptionsJson?: string;
  projectId?: string | null;
  builtIn: boolean;
}

export interface DashboardSnapshot {
  app: 'Zeus';
  localServer: { host: '127.0.0.1'; port: number | null };
  projects: ProjectRecord[];
  tasks: TaskRecord[];
  conversationAttentionByProject: Record<string, ProjectConversationAttentionState>;
  conversationUnreadCountByProject: Record<string, number>;
  runtime: {
    aiCli: { available: boolean; reason: string };
    telegram: { enabled: boolean; reason: string };
  };
  git: {
    isRepository: boolean;
    branch: string;
    clean?: boolean;
    changedFiles: string[];
    conflictFiles?: string[];
    fileStatuses?: Array<{
      path: string;
      originalPath?: string;
      indexStatus: string;
      workingTreeStatus: string;
      category: string;
    }>;
    remoteBranches?: string[];
    recentCommits?: Array<{
      hash: string;
      shortHash: string;
      subject: string;
      author: string;
      authoredAt: string;
    }>;
  };
  graph: { nodeCount: number; edgeCount: number; viewCount: number };
}

export type ProjectConversationAttentionState = 'idle' | 'running' | 'unread' | 'completed' | 'failed' | 'interrupted' | 'reply_required';

export interface SecretPresence {
  configured: boolean;
  label: '已安全保存' | '未配置';
}

export interface SecuritySecretsSnapshot {
  telegramBotToken: SecretPresence;
  externalApiKey: SecretPresence;
}

export type ModelConnectionTemplateId = 'custom' | 'deepseek' | 'bailian' | 'kimi' | 'zai';
export type ModelCapabilityState = 'supported' | 'unsupported' | 'unverified';
export type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelThinkingFormat = 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling';

export interface ModelCapabilityEvidence {
  source: 'template' | 'catalog' | 'manual' | 'probe';
  state: ModelCapabilityState;
  checkedAt: string | null;
  reason: string;
}

export interface ModelConnectionModel {
  id: string;
  displayName: string;
  enabled: boolean;
  contextWindow: number;
  maxTokens: number;
  speedLabel: 'standard' | 'high_speed' | 'flash' | 'turbo';
  capability: {
    reasoning: {
      state: ModelCapabilityState;
      levels: ModelThinkingLevel[];
      defaultLevel: ModelThinkingLevel;
      thinkingFormat: ModelThinkingFormat;
      levelMap: Partial<Record<ModelThinkingLevel, string | null>>;
      source: ModelCapabilityEvidence['source'];
      checkedAt: string | null;
      reason: string;
    };
    tools: ModelCapabilityEvidence;
    imageInput: ModelCapabilityEvidence;
    streaming: ModelCapabilityEvidence;
    usage: ModelCapabilityEvidence;
  };
}

export interface ModelConnectionRecord {
  id: string;
  name: string;
  templateId: ModelConnectionTemplateId;
  baseUrl: string;
  modelsPath: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
  models: ModelConnectionModel[];
  createdAt: string;
  updatedAt: string;
}

export interface SaveModelConnectionRequest {
  name: string;
  templateId: ModelConnectionTemplateId;
  baseUrl: string;
  modelsPath: string;
  enabled: boolean;
  models: ModelConnectionModel[];
  apiKey?: string;
}

export interface ModelConnectionDiagnostic {
  ok: boolean;
  stage: 'configuration' | 'credential' | 'catalog';
  code: string;
  message: string;
  checkedAt: string;
  discoveredModelCount: number | null;
}

export interface SelectablePiModel {
  id: string;
  model: string;
  displayName: string;
  sourceId: string;
  sourceName: string;
  agentKind: 'pi';
  enabled: boolean;
  available: boolean;
  availabilityReason: string;
  supportedReasoningEfforts: ModelThinkingLevel[];
  defaultReasoningEffort: ModelThinkingLevel | null;
  serviceTiers: [];
  defaultServiceTier: null;
  speedLabel: ModelConnectionModel['speedLabel'];
  tools: ModelCapabilityState;
  imageInput: ModelCapabilityState;
}

export interface ProjectModelSelection {
  projectId: string;
  allowedModelRefs: string[];
  defaultModelRef: string | null;
}

export interface ProjectDatabaseSecretSnapshot {
  connectionName: string | null;
  password: SecretPresence;
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

export interface ConfigurationPresence {
  configured: boolean;
  label: string;
}

export interface ReleaseReadinessSnapshot {
  canBuildUnsignedArtifacts: boolean;
  canSign: boolean;
  canNotarize: boolean;
  waitingFor: string[];
}

export interface AutoUpdatePolicySnapshot {
  currentVersion: string;
  channel: 'manual';
  checkMode: 'manual';
  updateFeedConfigured: boolean;
  changelogPath: string;
  waitingFor: string[];
  label: string;
}

export interface ReleaseStatusSnapshot {
  signing: ConfigurationPresence;
  notarization: ConfigurationPresence;
  homebrewCask: ConfigurationPresence;
  releaseWorkflow: ConfigurationPresence;
  readiness: ReleaseReadinessSnapshot;
  autoUpdate: AutoUpdatePolicySnapshot;
}

export interface ReleaseUpdateArtifactSnapshot {
  arch: 'arm64' | 'x64';
  kind: 'dmg' | 'zip';
  fileName: string;
  sha256: string;
  sizeBytes: number | null;
  downloadUrl: string;
}

export interface ReleaseUpdateStatusSnapshot {
  status: 'up_to_date' | 'available' | 'unavailable';
  currentVersion: string;
  latestVersion: string;
  channel: 'stable' | 'preview';
  releasePageUrl: string;
  artifact: ReleaseUpdateArtifactSnapshot | null;
  executionHostProtocolVersion: number;
  automaticInstallEnabled: boolean;
  recommendedAction: 'none' | 'open_download_page' | 'download_and_install';
  label: string;
  reason: string;
  checkedAt: string;
  executionHost?: {
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
    waitingRequestCount: number;
    activeRuntimeCount: number;
    activeCommandRunCount: number;
    hasActiveWork: boolean;
    observedAt: string;
  };
}

export interface ReleaseUpdateOperationSnapshot {
  accepted: boolean;
  update: ReleaseUpdateStatusSnapshot;
  reason: string;
}

export interface TelegramPollingStatus {
  running: boolean;
  offset: number;
  lastError: string | null;
  handledUpdates: number;
}

export interface TelegramPollingLogEntry {
  updateId: number | null;
  chatId: number | null;
  userId: number | null;
  command: string;
  allowed: boolean;
  error?: string;
}

export interface TelegramNotificationSettings {
  enabled: boolean;
  chatIds: number[];
  silentMode: boolean;
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
  polling: TelegramPollingStatus;
  notificationSettings: TelegramNotificationSettings;
  securitySettings: TelegramSecuritySettings;
}

export interface TelegramSettingsSnapshot {
  notificationSettings: TelegramNotificationSettings;
  securitySettings: TelegramSecuritySettings;
}

export interface UpdateTelegramSettingsRequest {
  enabled?: boolean;
  chatIds?: number[];
  silentMode?: boolean;
  allowedUserIds?: number[];
}

export interface TelegramSecuritySettings {
  allowedUserIds: number[];
}

export interface SecurityResetResult {
  secrets: SecuritySecretsSnapshot;
  telegramNotificationSettings: TelegramNotificationSettings;
  telegramSecuritySettings: TelegramSecuritySettings;
}

export interface AiRuntimeAdapterDescriptor {
  id: 'codex' | 'claude' | 'gemini' | 'generic';
  name: string;
  displayName: string;
  command: string;
  capabilities: string[];
}

export interface RuntimeSettings {
  defaultAdapterId: AiRuntimeAdapterDescriptor['id'];
  adapterModels: Partial<Record<AiRuntimeAdapterDescriptor['id'], string>>;
  adapterDefaultArgs: Partial<Record<AiRuntimeAdapterDescriptor['id'], string[]>>;
  adapterCliPaths: Partial<Record<AiRuntimeAdapterDescriptor['id'], string>>;
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
  autoConfirmationPolicy: 'never' | 'low_risk_only';
}

export interface CodeMapSettings {
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

export interface AppShellSettings {
  appLanguage: 'zh-CN' | 'en-US';
  appearance: 'system' | 'light' | 'dark';
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
  taskTableColumns?: TaskTableColumnPreferences;
  taskTableColumnsByProject?: Record<string, TaskTableColumnPreferences>;
  taskTableEnumSortOrders?: TaskTableEnumSortOrders;
  taskManagementStatusTemplate?: TaskManagementStatusConfig;
  taskManagementStatusByProject?: Record<string, TaskManagementStatusConfig>;
  taskStatusFilterByProject?: Record<string, TaskStatusFilter>;
  taskViewModeByProject?: Record<string, 'hierarchy' | 'flat'>;
  taskExpandedIdsByProject?: Record<string, string[]>;
  codeWorkspaceByProject?: Record<string, ProjectCodeWorkspacePreference>;
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

export type UpdateAppShellSettingsRequest = Pick<
  AppShellSettings,
  'appLanguage' | 'appearance' | 'webviewDebugEnabled' | 'developerModeEnabled' | 'multiWindowEnabled' | 'backgroundModeEnabled' | 'desktopNotificationsEnabled' | 'openAtLoginEnabled' | 'autoUpdateChannel'
> & {
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
  taskManagementStatusReplacements?: Record<string, Record<string, string>>;
  taskStatusFilterByProject?: Record<string, TaskStatusFilter>;
  taskViewModeByProject?: Record<string, 'hierarchy' | 'flat'>;
  taskExpandedIdsByProject?: Record<string, string[]>;
  codeWorkspaceByProject?: Record<string, ProjectCodeWorkspacePreference>;
};

export interface ClearLocalCachesResult {
  cleared: boolean;
  clearedCaches: Array<'code-index' | 'graph-view' | 'layout'>;
  clearedAt: string;
}

export interface LocalSettingsExportSnapshot {
  app: 'Zeus';
  schemaVersion: 1;
  exportedAt: string;
  redaction: {
    secretsRedacted: true;
  };
  settings: {
    appShell: AppShellSettings;
    runtime: RuntimeSettings;
    codeMap: CodeMapSettings;
    telegramNotification: TelegramNotificationSettings;
    telegramSecurity: TelegramSecuritySettings;
  };
}

export interface ImportLocalSettingsRequest {
  schemaVersion: 1;
  settings: {
    appShell?: UpdateAppShellSettingsRequest;
    runtime?: RuntimeSettings;
    codeMap?: CodeMapSettings;
    telegramNotification?: TelegramNotificationSettings;
    telegramSecurity?: TelegramSecuritySettings;
  };
}

export interface ImportLocalSettingsResult {
  imported: boolean;
  importedSettings: string[];
  importedAt: string;
}

export interface LocalBusinessDataSnapshot {
  app: 'Zeus';
  schemaVersion: 1 | 2;
  exportedAt: string;
  redaction: {
    secretsRedacted: true;
  };
  data: {
    projects: Array<
      ProjectRecord & {
        slug?: string;
        defaultTemplateId?: string | null;
        createdAt?: string;
        updatedAt?: string;
      }
    >;
    tasks: Array<
      TaskRecord & {
        sourceContextJson?: string;
        createdAt?: string;
        updatedAt?: string;
      }
    >;
    taskEvents: TaskEventRecord[];
    taskTemplates: TaskTemplateRecord[];
    commandDefinitions?: CommandDefinition[];
  };
}

export interface ImportLocalBusinessDataResult {
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

export interface AiRuntimeAdapterStatus extends AiRuntimeAdapterDescriptor {
  available: boolean;
  reason: string;
  version: string | null;
  resolvedCommandPath: string | null;
  checkedAt: string;
  compatibility: 'compatible' | 'incompatible' | 'not_checked';
  installationGuideUrl: string | null;
  authStatus: 'unknown' | 'authenticated' | 'unauthenticated';
  modelConfiguration: 'user-configured';
}

export interface RuntimeStatusSnapshot {
  aiCli: {
    name: string;
    command: string;
    available: boolean;
    reason: string;
  };
  telegram: {
    enabled: boolean;
    reason: string;
  };
  terminal?: {
    provider: 'node-pty' | 'child_process';
    pty: { available: boolean; reason: string };
  };
}

export interface CodexRemoteControlClient {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  lastSeenAt: number | null;
}

export interface CodexRemoteControlSnapshot {
  enabled: boolean;
  status: {
    status: 'disabled' | 'connecting' | 'connected' | 'errored';
    serverName: string;
    installationId: string;
    environmentId: string | null;
  };
  clients: CodexRemoteControlClient[];
  managedStandalone?: {
    available: boolean;
    commandPath: string | null;
    installCommand: string;
  };
}

export interface CodexRemoteControlPairing {
  pairingCode: string;
  manualPairingCode: string | null;
  environmentId: string;
  expiresAt: number;
  claimed: boolean;
}

export type AiRuntimeSessionStatus = 'running' | 'exited' | 'failed' | 'stopped' | 'orphan_detected' | 'lost';

export interface AiRuntimeSession {
  id: string;
  projectId: string;
  taskId?: string;
  command: string;
  args: string[];
  cwd: string;
  status: AiRuntimeSessionStatus;
  pid?: number;
  exitCode?: number | null;
  summary?: string | null;
  favorite?: boolean;
  archived?: boolean;
  deletedAt?: string | null;
  startedAt: string;
  endedAt?: string;
}

export interface AiRuntimeLogEntry {
  id: string;
  sessionId: string;
  stream: 'system' | 'stdout' | 'stderr';
  text: string;
  createdAt: string;
}

export interface CommandRunDetail {
  run: CommandRun;
  artifacts: CommandArtifact[];
  runtimeSession: AiRuntimeSession | null;
  logs: AiRuntimeLogEntry[];
  afterSeq: number;
  nextSeq: number;
  logTotal: number;
  hasMoreLogs: boolean;
  logsTruncated?: boolean;
}

export interface LoadCommandRunOptions {
  afterSeq?: number;
  logLimit?: number;
  tail?: boolean;
}

export interface CreateCommandConfirmationRequest {
  parameters: Record<string, string | number | boolean>;
  trigger?: 'desktop' | 'telegram';
}

export interface StartCommandRunRequest {
  confirmationId: string;
  parameters: Record<string, string | number | boolean>;
}

export type CommandConfirmationResponse = CommandConfirmation & { runId: string };

export interface AiRuntimeTerminalSnapshot {
  sessionId: string;
  status: AiRuntimeSessionStatus;
  command: string;
  cwd: string;
  logs: AiRuntimeLogEntry[];
  logsTruncated?: boolean;
  capturedAt: string;
}

export interface AiRuntimeTerminalEvent {
  id: string;
  sessionId: string;
  taskId: string | null;
  seq: number;
  eventType: string;
  content: string;
  rawChunkPath: string | null;
  createdAt: string;
}

export interface LoadRuntimeLogsRequest {
  query?: string;
  stream?: AiRuntimeLogEntry['stream'];
  limit?: number;
  offset?: number;
}

export interface LoadRuntimeTerminalEventsRequest {
  limit?: number;
  offset?: number;
}

export interface RuntimeLogPage {
  sessionId: string;
  items: AiRuntimeLogEntry[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  stream: AiRuntimeLogEntry['stream'] | null;
}

export interface RuntimeTerminalEventPage {
  sessionId: string;
  items: AiRuntimeTerminalEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface StartRuntimeSessionRequest {
  projectId: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  confirmationId?: string;
}

export interface RuntimeConfirmationSessionRequest {
  projectId: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd?: string;
}

export interface CreateRuntimeConfirmationRequest {
  action: 'start_generic_session';
  reason: string;
  session: RuntimeConfirmationSessionRequest;
}

export interface RuntimeOperationConfirmation {
  id: string;
  action: 'start_generic_session';
  status: 'pending' | 'confirmed' | 'consumed' | 'rejected';
  riskLevel: 'high';
  reason: string;
  securityContext?: {
    operationKind: 'shell_command';
    requiresConfirmation: true;
    riskLevel: 'high';
    projectId: string;
    taskId: string | null;
    cwd: string;
    commandPreview: string;
    redacted: boolean;
  };
  session: Required<Pick<RuntimeConfirmationSessionRequest, 'projectId' | 'command' | 'args' | 'cwd'>> & Pick<RuntimeConfirmationSessionRequest, 'taskId'>;
  createdAt: string;
  confirmedAt: string | null;
  consumedAt: string | null;
  rejectedAt?: string | null;
  rejectedReason?: string | null;
}

export interface LoadRuntimeSessionsRequest {
  query?: string;
  projectId?: string;
  taskId?: string;
  archived?: boolean;
  favoriteOnly?: boolean;
}

export interface CreateTaskFromRuntimeSessionRequest {
  title?: string;
  instruction?: string;
}

export interface TaskRuntimeControlResult {
  task: TaskRecord;
  conversation: GraphConversationHistoryItem;
  runtimeSession?: AiRuntimeSession;
  runtimeError?: {
    message: string;
  };
  queued?: true;
  reason?: string;
}

export interface GraphViewNode {
  id: string;
  nodeType: string;
  name: string;
  qualifiedName: string;
  sourceRef: string;
  symbolId: string;
  metadata: Record<string, unknown>;
}

export interface GraphViewEdge {
  id: string;
  edgeType: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
  confidence: number;
}

export type GraphViewType = 'architecture' | 'module' | 'table' | 'module_detail' | 'api_sequence' | 'module_flow' | 'method_logic';

export interface GraphViewSnapshot {
  id: string;
  schemaVersion: number;
  projectId?: string;
  projectName?: string;
  title: string;
  viewType: GraphViewType | string;
  layout?: {
    algorithm: string;
    width: number;
    height: number;
    positions: Array<{ nodeId: string; x: number; y: number }>;
  };
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  performance?: { durationMs: number; nodeCount: number; edgeCount: number };
}

export interface GraphSearchRequest {
  query: string;
  nodeType?: string;
  edgeType?: string;
  minConfidence?: number;
}

export interface GraphSearchResult {
  query: string;
  nodeType: string | null;
  edgeType: string | null;
  minConfidence: number;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

export interface GraphQuestionAnswer {
  projectId: string;
  question: string;
  answer: string;
  sessionId: string | null;
  sources: {
    nodes: GraphViewNode[];
    edges: GraphViewEdge[];
  };
}

export interface AskGraphRequest {
  question: string;
}

export interface GraphConversationMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

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
  messages: GraphConversationMessage[];
}

export interface SendConversationMessageResult {
  conversation: GraphConversationHistoryItem;
  runtimeSession?: AiRuntimeSession;
  runtimeError?: { message: string };
}

export interface GraphConversationHistoryPage {
  items: GraphConversationHistoryItem[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  archived: boolean;
}

export interface CreateTaskFromGraphConversationRequest {
  intent?: string;
}

export interface LoadGraphConversationsRequest {
  query?: string;
  limit?: number;
  offset?: number;
  archived?: boolean;
}

export interface GraphEdgeDetail extends GraphViewEdge {
  sourceNode: GraphViewNode;
  targetNode: GraphViewNode;
}

export interface GraphNeighborhood {
  centerNode: GraphViewNode;
  depth: number;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

export interface SemanticGraphNodeList {
  projectId: string;
  viewType: string;
  items: GraphViewNode[];
}

export interface SemanticGraphNodeDetail {
  projectId: string;
  node: GraphViewNode;
  relatedEdges: GraphViewEdge[];
}

export interface FocusedSemanticGraphView {
  projectId: string;
  node: GraphViewNode;
  view: Pick<GraphViewSnapshot, 'id' | 'title' | 'viewType'>;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

export interface GraphScanResult {
  projectName: string;
  rootPath: string;
  fileCount: number;
  symbolCount: number;
  nodeCount: number;
  edgeCount: number;
  viewCount: number;
}

export interface ProjectScanStatus {
  projectId: string;
  scanStatus: ProjectRecord['scanStatus'];
  graph: DashboardSnapshot['graph'];
}

export interface ProjectOverview {
  project: ProjectRecord;
  graph: DashboardSnapshot['graph'];
  git: GitStatusSummary;
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    recent: TaskRecord[];
  };
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  eventType: string;
  title: string;
  payloadJson: string;
  createdAt: string;
}

export interface GitDiffSummary {
  isRepository: boolean;
  files: string[];
  diffText: string;
  fileDiffs: GitFileDiff[];
}

export type GitDiffFileChangeType = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
export type GitDiffLineType = 'context' | 'addition' | 'deletion' | 'metadata';

export interface GitDiffLine {
  type: GitDiffLineType;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface GitDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
}

export interface GitFileDiff {
  oldPath: string;
  newPath: string;
  changeType: GitDiffFileChangeType;
  addedLines: number;
  deletedLines: number;
  hunks: GitDiffHunk[];
}

export interface GitPatchExport {
  fileName: string;
  mimeType: 'text/x-patch';
  patchText: string;
  files: string[];
  createdAt: string;
}

export interface ProjectGitSnapshotResult {
  projectId: string;
  taskId: string;
  snapshotType: 'readonly_diff';
  isRepository: boolean;
  fileCount: number;
  diffTextLength: number;
}

export type GitStatusSummary = DashboardSnapshot['git'];

export type HighRiskGitOperation = 'commit' | 'stash' | 'apply_stash' | 'rollback' | 'branch' | 'switch_branch' | 'pull' | 'push';

export interface GitOperationConfirmation {
  id: string;
  operation: HighRiskGitOperation;
  cwd: string;
  reason: string;
  message?: string;
  status: 'pending' | 'confirmed' | 'rejected';
  riskLevel: 'high';
  confirmationText: string;
  createdAt: string;
  expiresAt: string;
  confirmedAt?: string;
  rejectedAt?: string;
  rejectedReason?: string;
}

export interface CreateGitConfirmationRequest {
  operation: HighRiskGitOperation;
  reason: string;
  message?: string;
}

export interface ExecuteGitOperationRequest {
  confirmationId: string;
  operation: HighRiskGitOperation;
  message?: string;
  branchName?: string;
  baseRef?: string;
  stashRef?: string;
  remote?: string;
  targetRef?: string;
}

export interface ExecutedGitOperationResult {
  operation: HighRiskGitOperation;
  cwd: string;
  args: string[];
  stdout: string;
  stderr: string;
}

export interface CreateProjectRequest {
  name: string;
  localPath: string;
  description?: string;
  note?: string;
  defaultModel?: string | null;
  defaultWorkMode?: ProjectWorkMode;
  defaultTaskPrompt?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  localPath?: string;
  description?: string | null;
  note?: string | null;
}

export interface LoadProjectsRequest {
  query?: string;
}

export interface CreateTaskRequest {
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
  sourceContext: Record<string, unknown>;
  tags?: string[];
  priority: TaskPriority;
}

export interface UpdateTaskRelationshipsRequest {
  expectedUpdatedAt: string;
  parentTaskId?: string | null;
  relatedTaskIds?: string[];
}

export interface DeleteTaskRequest {
  childStrategy?: 'reparent' | 'delete_descendants' | 'make_roots';
  replacementParentTaskId?: string;
}

export interface DeleteTaskResult {
  task: TaskRecord;
  deletedTaskIds: string[];
  movedChildTaskIds: string[];
}

export interface LoadTasksRequest {
  projectId: string;
  query?: string;
  managementStatus?: TaskManagementStatus;
  tag?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'taskType' | 'managementStatus';
  sortDirection?: 'asc' | 'desc';
}

export interface UpdateTaskRequest {
  expectedUpdatedAt: string;
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

export interface CreateTaskFromGraphNodeRequest {
  projectId: string;
  intent?: string;
}

export interface CreateProjectGraphTaskRequest {
  intent?: string;
}

export interface LinkGraphNodeRequest {
  nodeId: string;
  reason?: string;
}

export interface CreateTaskTemplateRequest {
  projectId?: string;
  name: string;
  description: string;
  promptTemplate: string;
  category?: string;
  defaultOptions?: Record<string, unknown>;
}

export interface CreateTaskFromTemplateRequest {
  projectId: string;
  title?: string;
  variables?: Record<string, string>;
}

export interface DashboardClientOptions {
  baseUrl: string;
  apiToken: string;
  executionHostTransition?: ExecutionHostTransition;
  refreshLocalServerConfig?: () => Promise<DashboardClientOptions>;
}

export interface ExecutionHostTransition {
  state: 'current' | 'draining_previous';
  currentAppVersion: string;
  hostAppVersion: string;
}

export class ZeusApiError extends Error {
  readonly status: number;
  readonly error: string | null;
  readonly recoveryRequired: boolean;

  constructor(input: { status: number; error?: string | null; message: string; recoveryRequired?: boolean }) {
    super(input.message);
    this.name = 'ZeusApiError';
    this.status = input.status;
    this.error = input.error ?? null;
    this.recoveryRequired = input.recoveryRequired ?? false;
  }
}

export interface ZeusRealtimeEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type ZeusRealtimeConnectionState = 'connecting' | 'connected' | 'reconnecting';

export type CodexLegacyImportRunStatus = 'prepared' | 'waiting' | 'completed' | 'failed';

export interface CodexLegacyImportEligibleSession {
  sourceConversationId: string;
  title: string;
  cwd: string;
}

export interface CodexLegacyImportRun {
  id: string;
  importId: string | null;
  sourceConversationId: string;
  targetConversationId: string | null;
  status: CodexLegacyImportRunStatus;
  targetThreadId: string | null;
  failureStage: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CodexLegacyImportSnapshot {
  eligible: CodexLegacyImportEligibleSession[];
  runs: CodexLegacyImportRun[];
}

export interface CodexLegacyImportResult {
  importId: string;
  status: 'waiting' | 'completed' | 'failed';
  runs: CodexLegacyImportRun[];
}

export interface CodexConfigImportEntry {
  path: string;
  kind: 'file' | 'directory';
  nodeCount: number;
}

export interface CodexConfigImportPreview {
  available: boolean;
  sourceRoot: string;
  targetRoot: string;
  entries: CodexConfigImportEntry[];
  skipped: Array<{
    path: string;
    reason: 'missing' | 'symbolic_link' | 'unsupported_type' | 'contains_sensitive_assignment' | 'too_large' | 'generated_runtime';
  }>;
}

export interface CodexConfigImportResult extends CodexConfigImportPreview {
  imported: string[];
  backupRoot: string | null;
  importedAt: string;
  restartRequired: boolean;
}

export interface ProjectArchiveConfirmation {
  projectId: string;
  confirmationText: string;
  riskLevel: 'medium';
}

export interface DashboardClient {
  connectEvents: (onEvent: (event: ZeusRealtimeEvent) => void, options?: { afterEventId?: string }) => WebSocket;
  subscribeEvents: (onEvent: (event: ZeusRealtimeEvent) => void, onConnectionState: (state: ZeusRealtimeConnectionState) => void) => () => void;
  loadAgents: () => Promise<AgentCatalogSnapshot>;
  loadModelConnections: () => Promise<ModelConnectionRecord[]>;
  createModelConnection: (input: SaveModelConnectionRequest) => Promise<ModelConnectionRecord>;
  updateModelConnection: (connectionId: string, input: SaveModelConnectionRequest) => Promise<ModelConnectionRecord>;
  deleteModelConnection: (connectionId: string) => Promise<void>;
  clearModelConnectionApiKey: (connectionId: string) => Promise<ModelConnectionRecord>;
  refreshModelConnectionModels: (connectionId: string) => Promise<{ connection: ModelConnectionRecord; discoveredModelIds: string[]; addedModelIds: string[]; checkedAt: string }>;
  diagnoseModelConnection: (connectionId: string) => Promise<ModelConnectionDiagnostic>;
  loadSelectablePiModels: () => Promise<SelectablePiModel[]>;
  loadProjectModelSelection: (projectId: string) => Promise<ProjectModelSelection>;
  saveProjectModelSelection: (projectId: string, input: ProjectModelSelection) => Promise<ProjectModelSelection>;
  loadArchivedConversations: () => Promise<ArchivedConversationChoicesSnapshot>;
  loadProjectConversationChoices: (projectId: string) => Promise<NativeProjectConversationChoicesSnapshot>;
  loadProjectConversationChoiceGroups: (projectId: string) => Promise<NativeProjectConversationChoiceGroupsSnapshot>;
  startProjectConversation: (projectId: string, input: StartProjectConversationRequest) => Promise<NativeOperationAcceptance>;
  loadTaskConversationChoices: (taskId: string) => Promise<NativeConversationChoicesSnapshot>;
  startNativeConversation: (taskId: string, input: StartNativeConversationRequest) => Promise<NativeOperationAcceptance>;
  loadCodexTaskPushCapabilities: (projectId: string, taskId: string) => Promise<CodexTaskPushCapabilities>;
  refreshTaskPushRepositoryRemote: (projectId: string, taskId: string, repositoryId: string) => Promise<CodexTaskRepositoryCapability>;
  loadCodexConversationCapabilities: (projectId: string) => Promise<CodexConversationCapabilities>;
  loadCodexAccount: () => Promise<CodexAccountSnapshot>;
  loadCodexUsageSummary: () => Promise<CodexUsageSummarySnapshot>;
  loadCodexUsageAnalytics: (input: { range: CodexUsageRange; projectId?: string; model?: string }) => Promise<CodexUsageAnalyticsSnapshot>;
  startCodexChatGptLogin: () => Promise<CodexChatGptLogin>;
  cancelCodexChatGptLogin: (loginId: string) => Promise<void>;
  startTaskModelPush: (taskId: string, input: StartTaskModelPushRequest) => Promise<NativeOperationAcceptance>;
  loadTaskGitWorkspaces: (taskId: string) => Promise<TaskWorkspacesSnapshot>;
  loadTaskGitWorkspaceIndex: (taskId: string) => Promise<TaskWorkspaceIndexCollection>;
  loadTaskGitWorkspaceSnapshot: (taskId: string, workspaceId: string) => Promise<TaskWorkspaceSnapshotResponse>;
  loadTaskWorkspaceFileDiff: (
    taskId: string,
    workspaceId: string,
    path: string,
    scope?: 'working' | 'committed',
  ) => Promise<{
    path: string;
    diff: TaskGitDiffSummary;
  }>;
  commitTaskWorkspace: (taskId: string, workspaceId: string, input: { message: string; selectedPaths: string[] }) => Promise<TaskWorkspaceCommitResult>;
  commitAllTaskWorkspaces: (taskId: string, input: { message: string }) => Promise<BatchTaskWorkspaceResponse>;
  pushTaskWorkspace: (taskId: string, workspaceId: string) => Promise<TaskWorkspacePushResult>;
  pushAllTaskWorkspaces: (taskId: string) => Promise<BatchTaskWorkspaceResponse>;
  pushTaskIntegration: (taskId: string, integrationId: string) => Promise<TaskIntegrationPushResult>;
  reclaimTaskWorkspace: (taskId: string, workspaceId: string) => Promise<{ workspace: unknown; result?: unknown }>;
  discardTaskWorkspace: (taskId: string, workspaceId: string, confirmationText: string) => Promise<{ workspace: unknown; result: unknown }>;
  stopTaskWorkspaceSessions: (taskId: string, workspaceId: string) => Promise<{ workspaceId: string; interrupted: number; cancelled: number }>;
  loadTaskIntegrations: (taskId: string) => Promise<{ taskId: string; items: TaskIntegrationRecord[]; integrations: TaskIntegrationRecord[] }>;
  startTaskIntegration: (
    taskId: string,
    workspaceId: string,
    input: {
      targetBranch: string;
      mode: 'merge' | 'squash';
      prepareOnly?: boolean;
    },
  ) => Promise<{ integration: TaskIntegrationRecord; result?: TaskIntegrationResult }>;
  loadTaskIntegrationConflict: (taskId: string, integrationId: string, path: string) => Promise<TaskIntegrationConflictFile>;
  startTaskIntegrationConflictAi: (taskId: string, integrationId: string, path: string, content: string, permissionMode: TaskIntegrationConflictPermissionMode, idempotencyKey: string) => Promise<TaskIntegrationConflictAiSession>;
  resolveTaskIntegrationConflict: (taskId: string, integrationId: string, path: string, content: string) => Promise<{ integration: TaskIntegrationRecord; result: { path: string; remainingConflictFiles: string[] } }>;
  finalizeTaskIntegration: (
    taskId: string,
    integrationId: string,
  ) => Promise<{
    integration: TaskIntegrationRecord;
    result: TaskIntegrationResult;
  }>;
  loadNativeConversation: (projectId: string, conversationId: string) => Promise<NativeConversationSnapshot>;
  loadNativePendingRequests: (projectId: string, conversationId: string) => Promise<{ conversationId: string; requests: NativePendingRequest[] }>;
  loadNativeConversationChoice: (projectId: string, conversationId: string) => Promise<NativeConversationChoice>;
  archiveNativeConversation: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  restoreConversationArchive: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  loadConversationResourcePreview: (projectId: string, conversationId: string, resourceId: string) => Promise<ConversationResourcePreview>;
  loadTurnChangeFilePreview: (projectId: string, conversationId: string, turnId: string, changeSetId: string, fileId: string) => Promise<ConversationResourcePreview>;
  loadTurnChangeSet: (projectId: string, conversationId: string, turnId: string) => Promise<TurnChangeSet>;
  operateTurnChangeSet: (
    projectId: string,
    conversationId: string,
    turnId: string,
    action: 'undo' | 'reapply',
    input: { changeSetId: string; expectedState: 'applied' | 'undone'; idempotencyKey: string },
  ) => Promise<TurnChangeSetOperationResult>;
  acknowledgeNativeConversationAttention: (projectId: string, conversationId: string, expectedRevision: number) => Promise<{ acknowledged: boolean; conversation: NativeConversationChoice }>;
  restoreArchivedNativeConversation: (projectId: string, conversationId: string) => Promise<NativeConversationSnapshot>;
  updateNativePermissionMode: (projectId: string, conversationId: string, permissionMode: NativePermissionMode) => Promise<NativeConversationSnapshot>;
  updateNativeCollaborationMode: (projectId: string, conversationId: string, collaborationMode: NativeCollaborationMode) => Promise<NativeConversationSnapshot>;
  updateNativeNextTurnSettings: (projectId: string, conversationId: string, settings: NativeNextTurnSettings) => Promise<NativeNextTurnSettings>;
  loadCodexLegacyImports: () => Promise<CodexLegacyImportSnapshot>;
  startCodexLegacyImport: (sourceConversationIds: string[]) => Promise<CodexLegacyImportResult>;
  loadCodexLegacyImport: (importId: string) => Promise<CodexLegacyImportResult>;
  inspectCodexConfigImport: () => Promise<CodexConfigImportPreview>;
  importCodexConfig: () => Promise<CodexConfigImportResult>;
  sendNativeMessage: (projectId: string, conversationId: string, input: SendNativeMessageRequest) => Promise<NativeOperationAcceptance>;
  editNativeQueuedSubmission: (projectId: string, conversationId: string, submissionId: string, content: string) => Promise<NativeQueueSnapshot>;
  deleteNativeQueuedSubmission: (projectId: string, conversationId: string, submissionId: string) => Promise<NativeQueueSnapshot>;
  sendNativeQueuedNow: (projectId: string, conversationId: string, submissionId: string) => Promise<NativeOperationAcceptance>;
  interruptNativeTurn: (projectId: string, conversationId: string, turnId: string) => Promise<NativeOperationAcceptance>;
  respondToNativeRequest: (projectId: string, conversationId: string, requestId: string, response: Record<string, unknown>) => Promise<{ operation: Record<string, unknown>; request: NativePendingRequest }>;
  snoozeNativeRequest: (
    projectId: string,
    conversationId: string,
    requestId: string,
  ) => Promise<{
    request: NativePendingRequest;
  }>;
  respondToPlanImplementationRequest: (
    projectId: string,
    conversationId: string,
    requestId: string,
    input: { action: 'implement' | 'refine' | 'dismiss'; feedback?: string },
  ) => Promise<{
    operation: NativeOperationAcceptance['operation'];
    request: NativePlanImplementationRequest;
    conversation: NativeConversationSnapshot;
  }>;
  resumeNativeQueue: (projectId: string, conversationId: string) => Promise<NativeQueueSnapshot>;
  recoverNativeQueue: (projectId: string, conversationId: string) => Promise<NativeQueueSnapshot>;
  reorderNativeQueue: (projectId: string, conversationId: string, orderedSubmissionIds: string[]) => Promise<NativeQueueSnapshot>;
  loadDashboard: () => Promise<DashboardSnapshot>;
  loadRuntimeStatus: () => Promise<RuntimeStatusSnapshot>;
  loadCodexRemoteControl: () => Promise<CodexRemoteControlSnapshot>;
  enableCodexRemoteControl: () => Promise<CodexRemoteControlSnapshot>;
  disableCodexRemoteControl: () => Promise<CodexRemoteControlSnapshot>;
  startCodexRemoteControlPairing: () => Promise<CodexRemoteControlPairing>;
  loadCodexRemoteControlPairingStatus: (input: { pairingCode?: string | null; manualPairingCode?: string | null }) => Promise<{ claimed: boolean }>;
  revokeCodexRemoteControlClient: (environmentId: string, clientId: string) => Promise<CodexRemoteControlSnapshot>;
  loadRuntimeSettings: () => Promise<RuntimeSettings>;
  saveRuntimeSettings: (input: RuntimeSettings) => Promise<RuntimeSettings>;
  loadCodeMapSettings: () => Promise<CodeMapSettings>;
  saveCodeMapSettings: (input: CodeMapSettings) => Promise<CodeMapSettings>;
  loadAppShellSettings: () => Promise<AppShellSettings>;
  saveAppShellSettings: (input: UpdateAppShellSettingsRequest) => Promise<AppShellSettings>;
  clearLocalCaches: () => Promise<ClearLocalCachesResult>;
  exportLocalSettings: () => Promise<LocalSettingsExportSnapshot>;
  importLocalSettings: (input: ImportLocalSettingsRequest) => Promise<ImportLocalSettingsResult>;
  exportLocalBusinessData: () => Promise<LocalBusinessDataSnapshot>;
  importLocalBusinessData: (input: LocalBusinessDataSnapshot) => Promise<ImportLocalBusinessDataResult>;
  loadGlobalCommands: () => Promise<CommandDefinition[]>;
  createGlobalCommand: (input: CommandDefinitionInput) => Promise<CommandDefinition>;
  updateGlobalCommand: (commandId: string, input: Partial<CommandDefinitionInput>) => Promise<CommandDefinition>;
  deleteGlobalCommand: (commandId: string) => Promise<CommandDefinition>;
  loadProjectCommands: (projectId: string) => Promise<CommandDefinition[]>;
  createProjectCommand: (projectId: string, input: CommandDefinitionInput) => Promise<CommandDefinition>;
  updateProjectCommand: (projectId: string, commandId: string, input: Partial<CommandDefinitionInput>) => Promise<CommandDefinition>;
  deleteProjectCommand: (projectId: string, commandId: string) => Promise<CommandDefinition>;
  createCommandConfirmation: (projectId: string, commandId: string, input: CreateCommandConfirmationRequest) => Promise<CommandConfirmationResponse>;
  startCommandRun: (projectId: string, commandId: string, input: StartCommandRunRequest) => Promise<CommandRun>;
  loadCommandRuns: (projectId: string, limit?: number) => Promise<CommandRun[]>;
  loadCommandRun: (runId: string, options?: LoadCommandRunOptions) => Promise<CommandRunDetail>;
  stopCommandRun: (runId: string) => Promise<CommandRun>;
  loadCommandArtifact: (artifactId: string) => Promise<Blob>;
  loadRuntimeAdapters: () => Promise<AiRuntimeAdapterDescriptor[]>;
  checkRuntimeAdapter: (adapterId: string) => Promise<AiRuntimeAdapterStatus>;
  loadRuntimeSessions: (input?: LoadRuntimeSessionsRequest) => Promise<AiRuntimeSession[]>;
  createRuntimeConfirmation: (input: CreateRuntimeConfirmationRequest) => Promise<RuntimeOperationConfirmation>;
  confirmRuntimeOperation: (confirmationId: string) => Promise<RuntimeOperationConfirmation>;
  rejectRuntimeOperation: (confirmationId: string, reason?: string) => Promise<RuntimeOperationConfirmation>;
  startRuntimeSession: (input: StartRuntimeSessionRequest) => Promise<AiRuntimeSession>;
  stopRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  loadRuntimeSessionLogs: (sessionId: string) => Promise<AiRuntimeLogEntry[]>;
  loadRuntimeSessionLogsPage: (sessionId: string, input?: LoadRuntimeLogsRequest) => Promise<RuntimeLogPage>;
  sendRuntimeInput: (sessionId: string, input: string) => Promise<AiRuntimeSession>;
  interruptRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  resizeRuntimeSession: (sessionId: string, size: { cols: number; rows: number }) => Promise<AiRuntimeSession>;
  loadRuntimeTerminalSnapshot: (sessionId: string) => Promise<AiRuntimeTerminalSnapshot>;
  loadRuntimeTerminalEvents: (sessionId: string, input?: LoadRuntimeTerminalEventsRequest) => Promise<RuntimeTerminalEventPage>;
  generateRuntimeSessionSummary: (sessionId: string) => Promise<AiRuntimeSession>;
  setRuntimeSessionFavorite: (sessionId: string, favorite: boolean) => Promise<AiRuntimeSession>;
  archiveRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  restoreRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  deleteRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  createTaskFromRuntimeSession: (sessionId: string, input: CreateTaskFromRuntimeSessionRequest) => Promise<TaskRecord>;
  loadSecuritySecrets: () => Promise<SecuritySecretsSnapshot>;
  loadSecurityAuditLogs: () => Promise<SecurityAuditLogEntry[]>;
  loadReleaseStatus: () => Promise<ReleaseStatusSnapshot>;
  loadReleaseUpdateStatus: () => Promise<ReleaseUpdateStatusSnapshot>;
  checkReleaseUpdate: () => Promise<ReleaseUpdateStatusSnapshot>;
  downloadReleaseUpdate: () => Promise<ReleaseUpdateOperationSnapshot>;
  installReleaseUpdate: () => Promise<ReleaseUpdateOperationSnapshot>;
  saveTelegramBotToken: (token: string) => Promise<SecuritySecretsSnapshot>;
  clearTelegramBotToken: () => Promise<SecuritySecretsSnapshot>;
  saveExternalApiKey: (key: string) => Promise<SecuritySecretsSnapshot>;
  clearExternalApiKey: () => Promise<SecuritySecretsSnapshot>;
  resetSecurity: () => Promise<SecurityResetResult>;
  loadTelegramStatus: () => Promise<TelegramStatusSnapshot>;
  saveTelegramSettings: (input: UpdateTelegramSettingsRequest) => Promise<TelegramSettingsSnapshot>;
  startTelegram: () => Promise<TelegramPollingStatus>;
  stopTelegram: () => Promise<TelegramPollingStatus>;
  loadTelegramPollingStatus: () => Promise<TelegramPollingStatus>;
  loadTelegramPollingLogs: () => Promise<TelegramPollingLogEntry[]>;
  loadTelegramMessages: () => Promise<TelegramPollingLogEntry[]>;
  startTelegramPolling: () => Promise<TelegramPollingStatus>;
  stopTelegramPolling: () => Promise<TelegramPollingStatus>;
  pollTelegramOnce: () => Promise<TelegramPollingStatus>;
  testTelegramConnection: () => Promise<TelegramTestConnectionResult>;
  loadTelegramNotificationSettings: () => Promise<TelegramNotificationSettings>;
  saveTelegramNotificationSettings: (input: TelegramNotificationSettings) => Promise<TelegramNotificationSettings>;
  loadTelegramSecuritySettings: () => Promise<TelegramSecuritySettings>;
  saveTelegramSecuritySettings: (input: TelegramSecuritySettings) => Promise<TelegramSecuritySettings>;
  loadTaskTemplates: (projectId?: string) => Promise<TaskTemplateRecord[]>;
  loadArchivedProjects: () => Promise<ProjectRecord[]>;
  loadArchivedTasks: (projectId: string) => Promise<TaskRecord[]>;
  scanCurrentGraph: () => Promise<GraphScanResult>;
  loadGraphView: (viewType?: GraphViewType) => Promise<GraphViewSnapshot>;
  searchGraph: (input: GraphSearchRequest) => Promise<GraphSearchResult>;
  loadProjectGraphView: (projectId: string, viewType?: GraphViewType) => Promise<GraphViewSnapshot>;
  searchProjectGraph: (projectId: string, input: GraphSearchRequest) => Promise<GraphSearchResult>;
  loadProjectGraphNode: (projectId: string, nodeId: string) => Promise<GraphViewSnapshot['nodes'][number]>;
  loadProjectGraphNeighborhood: (projectId: string, nodeId: string, depth?: 1 | 2) => Promise<GraphNeighborhood>;
  loadProjectApis: (projectId: string) => Promise<SemanticGraphNodeList>;
  loadProjectApi: (projectId: string, apiId: string) => Promise<SemanticGraphNodeDetail>;
  loadProjectApiSequence: (projectId: string, apiId: string) => Promise<FocusedSemanticGraphView>;
  loadProjectModules: (projectId: string) => Promise<SemanticGraphNodeList>;
  loadProjectModule: (projectId: string, moduleId: string) => Promise<SemanticGraphNodeDetail>;
  loadProjectModuleFlow: (projectId: string, moduleId: string) => Promise<FocusedSemanticGraphView>;
  loadProjectTables: (projectId: string) => Promise<SemanticGraphNodeList>;
  searchProjectTableFields: (projectId: string, query: string) => Promise<SemanticGraphNodeList & { query: string }>;
  loadProjectTable: (projectId: string, tableId: string) => Promise<SemanticGraphNodeDetail>;
  loadProjectTableImpact: (projectId: string, tableId: string) => Promise<FocusedSemanticGraphView>;
  loadProjectMethodLogic: (projectId: string, methodId: string) => Promise<FocusedSemanticGraphView>;
  askGraph: (projectId: string, input: AskGraphRequest) => Promise<GraphQuestionAnswer>;
  loadGraphConversations: (projectId: string, input?: LoadGraphConversationsRequest) => Promise<GraphConversationHistoryPage>;
  loadGraphConversation: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  sendConversationMessage: (projectId: string, conversationId: string, content: string) => Promise<SendConversationMessageResult>;
  archiveGraphConversation: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  restoreGraphConversation: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  createTaskFromGraphConversation: (projectId: string, conversationId: string, input?: CreateTaskFromGraphConversationRequest) => Promise<TaskRecord>;
  loadGraphEdgeDetail: (edgeId: string) => Promise<GraphEdgeDetail>;
  loadGraphNeighborhood: (nodeId: string, depth?: 1 | 2) => Promise<GraphNeighborhood>;
  loadProjects: (input?: LoadProjectsRequest) => Promise<ProjectRecord[]>;
  loadProject: (projectId: string) => Promise<ProjectRecord>;
  loadProjectConfig: (projectId: string) => Promise<ProjectConfig>;
  saveProjectConfig: (projectId: string, input: SaveProjectConfigRequest) => Promise<ProjectConfig>;
  loadProjectWorkspaceConfig: (projectId: string) => Promise<ProjectWorkspaceConfigSnapshot>;
  saveProjectWorkspaceConfig: (projectId: string, input: { sharedWritablePaths: Array<{ localPath: string }> }) => Promise<ProjectWorkspaceConfigSnapshot>;
  loadProjectDatabaseSecret: (projectId: string) => Promise<ProjectDatabaseSecretSnapshot>;
  saveProjectDatabasePassword: (projectId: string, password: string) => Promise<ProjectDatabaseSecretSnapshot>;
  clearProjectDatabasePassword: (projectId: string) => Promise<ProjectDatabaseSecretSnapshot>;
  createProject: (input: CreateProjectRequest) => Promise<ProjectRecord>;
  updateProject: (projectId: string, input: UpdateProjectRequest) => Promise<ProjectRecord>;
  deleteProject: (projectId: string) => Promise<ProjectRecord>;
  createProjectArchiveConfirmation: (projectId: string) => Promise<ProjectArchiveConfirmation>;
  archiveProject: (projectId: string) => Promise<ProjectRecord>;
  restoreProject: (projectId: string) => Promise<ProjectRecord>;
  setProjectDefaultTemplate: (projectId: string, templateId: string | null) => Promise<ProjectRecord>;
  scanProject: (projectId: string) => Promise<GraphScanResult>;
  loadProjectScanStatus: (projectId: string) => Promise<ProjectScanStatus>;
  loadProjectOverview: (projectId: string) => Promise<ProjectOverview>;
  createTask: (input: CreateTaskRequest) => Promise<TaskRecord>;
  loadTasks: (input: LoadTasksRequest) => Promise<TaskRecord[]>;
  loadTask: (taskId: string) => Promise<TaskRecord>;
  updateTask: (taskId: string, input: UpdateTaskRequest) => Promise<TaskRecord>;
  updateTaskRelationships: (taskId: string, input: UpdateTaskRelationshipsRequest) => Promise<TaskRecord>;
  updateTaskTags: (taskId: string, tags: string[], expectedUpdatedAt: string) => Promise<TaskRecord>;
  deleteTask: (taskId: string, input?: DeleteTaskRequest) => Promise<DeleteTaskResult>;
  runTask: (taskId: string) => Promise<TaskRuntimeControlResult>;
  pauseTask: (taskId: string) => Promise<TaskRecord>;
  continueTask: (taskId: string) => Promise<TaskRuntimeControlResult>;
  cancelTask: (taskId: string) => Promise<TaskRecord>;
  retryTask: (taskId: string) => Promise<TaskRecord>;
  createTaskFromGraphNode: (nodeId: string, input: CreateTaskFromGraphNodeRequest) => Promise<TaskRecord>;
  createProjectTaskFromGraphNode: (projectId: string, nodeId: string, input?: CreateProjectGraphTaskRequest) => Promise<TaskRecord>;
  createProjectTaskFromGraphView: (projectId: string, viewId: string, input?: CreateProjectGraphTaskRequest) => Promise<TaskRecord>;
  linkTaskGraphNode: (taskId: string, input: LinkGraphNodeRequest) => Promise<TaskRecord>;
  createTaskTemplate: (input: CreateTaskTemplateRequest) => Promise<TaskTemplateRecord>;
  createTaskFromTemplate: (templateId: string, input: CreateTaskFromTemplateRequest) => Promise<TaskRecord>;
  loadGitDiff: () => Promise<GitDiffSummary>;
  loadProjectGitStatus: (projectId: string) => Promise<GitStatusSummary>;
  loadProjectGitDiff: (projectId: string) => Promise<GitDiffSummary>;
  createProjectGitSnapshot: (projectId: string, taskId: string) => Promise<ProjectGitSnapshotResult>;
  exportProjectGitPatch: (projectId: string) => Promise<GitPatchExport>;
  loadTaskGitDiff: (taskId: string) => Promise<GitDiffSummary>;
  exportGitPatch: () => Promise<GitPatchExport>;
  loadTaskEvents: (taskId: string) => Promise<TaskEventRecord[]>;
  updateTaskStatus: (taskId: string, status: TaskStatus) => Promise<TaskRecord>;
  updateTaskManagementStatus: (taskId: string, status: TaskManagementStatus, expectedUpdatedAt: string, confirmWorktreeCleanup?: boolean, reopenConversationId?: string) => Promise<TaskRecord>;
  archiveTask: (taskId: string) => Promise<TaskRecord>;
  restoreTask: (taskId: string) => Promise<TaskRecord>;
  createGitConfirmation: (input: CreateGitConfirmationRequest) => Promise<GitOperationConfirmation>;
  confirmGitOperation: (confirmationId: string) => Promise<GitOperationConfirmation>;
  rejectGitOperation: (confirmationId: string, reason?: string) => Promise<GitOperationConfirmation>;
  executeGitOperation: (input: ExecuteGitOperationRequest) => Promise<ExecutedGitOperationResult>;
  executeProjectGitBranch: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitCheckout: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitCommit: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitStash: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitApplyStash: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitPull: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitPush: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeTaskGitRollback: (taskId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
}

/** Renderer API client：只访问 Electron Main 暴露的本地服务地址和 token。 */
export function createDashboardClient(options: DashboardClientOptions): DashboardClient {
  let currentOptions = options;

  function subscribeEvents(onEvent: (event: ZeusRealtimeEvent) => void, onConnectionState: (state: ZeusRealtimeConnectionState) => void): () => void {
    let active = true;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let connectionGeneration = 0;
    let reconnectAttempt = 0;
    let connectedOnce = false;

    const scheduleReconnect = (): void => {
      if (!active || retryTimer !== undefined) return;
      onConnectionState(connectedOnce ? 'reconnecting' : 'connecting');
      const delay = Math.min(250 * 2 ** Math.min(reconnectAttempt, 4), 4_000);
      reconnectAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void connect(true);
      }, delay);
    };

    const connect = async (refreshConfig: boolean): Promise<void> => {
      const generation = ++connectionGeneration;
      if (refreshConfig && currentOptions.refreshLocalServerConfig) {
        try {
          const refreshLocalServerConfig = currentOptions.refreshLocalServerConfig;
          const refreshed = await refreshLocalServerConfig();
          currentOptions = { ...refreshed, refreshLocalServerConfig };
        } catch {
          if (active && generation === connectionGeneration) scheduleReconnect();
          return;
        }
      }
      if (!active || generation !== connectionGeneration) return;
      try {
        const nextSocket = connectZeusEvents(currentOptions, (event) => {
          if (!active || generation !== connectionGeneration || socket !== nextSocket) return;
          if (event.type === 'server.connected') {
            connectedOnce = true;
            reconnectAttempt = 0;
            onConnectionState('connected');
          }
          onEvent(event);
        });
        socket = nextSocket;
        nextSocket.addEventListener(
          'close',
          () => {
            if (!active || generation !== connectionGeneration || socket !== nextSocket) return;
            socket = null;
            scheduleReconnect();
          },
          { once: true },
        );
        nextSocket.addEventListener(
          'error',
          () => {
            if (!active || generation !== connectionGeneration || socket !== nextSocket) return;
            nextSocket.close();
          },
          { once: true },
        );
      } catch {
        if (active && generation === connectionGeneration) scheduleReconnect();
      }
    };

    onConnectionState('connecting');
    void connect(false);

    return () => {
      active = false;
      connectionGeneration += 1;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
      const currentSocket = socket;
      socket = null;
      currentSocket?.close();
    };
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    try {
      return await requestOnce<T>(path, init);
    } catch (error) {
      if (!isLikelyLocalServerConnectionError(error) || !currentOptions.refreshLocalServerConfig) {
        throw error;
      }
      // 本地服务由 Electron Main 监管，异常重启后端口可能变化；失败时只刷新一次配置并重试，避免静默死循环。
      const refreshLocalServerConfig = currentOptions.refreshLocalServerConfig;
      const refreshed = await refreshLocalServerConfig();
      currentOptions = { ...refreshed, refreshLocalServerConfig };
      return requestOnce<T>(path, init);
    }
  }

  async function requestOnce<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${currentOptions.apiToken}`,
    };
    if (init?.body) headers['content-type'] = 'application/json';
    const response = await fetch(`${currentOptions.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      const errorPayload = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
        recoveryRequired?: boolean;
        operation?: { status?: string };
      } | null;
      const recoveryRequired = errorPayload?.recoveryRequired === true || errorPayload?.error === 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED' || errorPayload?.operation?.status === 'recovery_required';
      // 本地 API 的错误消息已经过服务端脱敏，renderer 优先展示可操作原因，避免只暴露状态码。
      throw new ZeusApiError({
        status: response.status,
        error: errorPayload?.error,
        message: errorPayload?.message ?? `Zeus local API request failed: ${path} ${response.status}`,
        recoveryRequired,
      });
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async function requestBlob(path: string): Promise<Blob> {
    const response = await fetch(`${currentOptions.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${currentOptions.apiToken}` },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ZeusApiError({
        status: response.status,
        error: payload.error ?? null,
        message: payload.message ?? `Zeus local API request failed: ${response.status}`,
      });
    }
    return response.blob();
  }

  return {
    connectEvents: (onEvent, eventOptions) => connectZeusEvents(currentOptions, onEvent, eventOptions),
    subscribeEvents,
    loadAgents: () => request<AgentCatalogSnapshot>('/api/agents'),
    loadModelConnections: async () => (await request<{ items: ModelConnectionRecord[] }>('/api/model-connections')).items,
    createModelConnection: (input) => request<ModelConnectionRecord>('/api/model-connections', { method: 'POST', body: JSON.stringify(input) }),
    updateModelConnection: (connectionId, input) => request<ModelConnectionRecord>(`/api/model-connections/${encodeURIComponent(connectionId)}`, { method: 'PUT', body: JSON.stringify(input) }),
    deleteModelConnection: (connectionId) => request<void>(`/api/model-connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),
    clearModelConnectionApiKey: (connectionId) => request<ModelConnectionRecord>(`/api/model-connections/${encodeURIComponent(connectionId)}/api-key`, { method: 'DELETE' }),
    refreshModelConnectionModels: (connectionId) =>
      request<{ connection: ModelConnectionRecord; discoveredModelIds: string[]; addedModelIds: string[]; checkedAt: string }>(`/api/model-connections/${encodeURIComponent(connectionId)}/models/refresh`, { method: 'POST' }),
    diagnoseModelConnection: (connectionId) => request<ModelConnectionDiagnostic>(`/api/model-connections/${encodeURIComponent(connectionId)}/diagnose`, { method: 'POST' }),
    loadSelectablePiModels: async () => (await request<{ items: SelectablePiModel[] }>('/api/models/catalog')).items,
    loadProjectModelSelection: (projectId) => request<ProjectModelSelection>(`/api/projects/${encodeURIComponent(projectId)}/model-selection`),
    saveProjectModelSelection: (projectId, input) => request<ProjectModelSelection>(`/api/projects/${encodeURIComponent(projectId)}/model-selection`, { method: 'PUT', body: JSON.stringify(input) }),
    loadArchivedConversations: () => request<ArchivedConversationChoicesSnapshot>('/api/conversations/archived'),
    loadProjectConversationChoices: (projectId) => request<NativeProjectConversationChoicesSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversation-choices`),
    loadProjectConversationChoiceGroups: (projectId) => request<NativeProjectConversationChoiceGroupsSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversation-choice-groups`),
    startProjectConversation: (projectId, input) => {
      const { idempotencyKey, ...body } = input;
      return request<NativeOperationAcceptance>(`/api/projects/${encodeURIComponent(projectId)}/conversations`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      });
    },
    loadTaskConversationChoices: (taskId) => request<NativeConversationChoicesSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/conversation-choices`),
    loadCodexTaskPushCapabilities: (projectId, taskId) => request<CodexTaskPushCapabilities>(`/api/projects/${encodeURIComponent(projectId)}/codex-task-push-capabilities?taskId=${encodeURIComponent(taskId)}`),
    refreshTaskPushRepositoryRemote: (projectId, taskId, repositoryId) =>
      request<CodexTaskRepositoryCapability>(`/api/projects/${encodeURIComponent(projectId)}/codex-task-push-capabilities/repositories/${encodeURIComponent(repositoryId)}/refresh-remote?taskId=${encodeURIComponent(taskId)}`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    loadCodexConversationCapabilities: (projectId) => request<CodexConversationCapabilities>(`/api/projects/${encodeURIComponent(projectId)}/codex-conversation-capabilities`),
    loadCodexAccount: () => request<CodexAccountSnapshot>('/api/codex/account'),
    loadCodexUsageSummary: () => request<CodexUsageSummarySnapshot>('/api/codex/usage-summary'),
    loadCodexUsageAnalytics: (input) => {
      const query = new URLSearchParams({ range: input.range });
      if (input.projectId) query.set('projectId', input.projectId);
      if (input.model) query.set('model', input.model);
      return request<CodexUsageAnalyticsSnapshot>(`/api/codex/usage-analytics?${query.toString()}`);
    },
    startCodexChatGptLogin: () => request<CodexChatGptLogin>('/api/codex/account/login/chatgpt', { method: 'POST' }),
    cancelCodexChatGptLogin: async (loginId) => {
      await request<{ cancelled: true }>(`/api/codex/account/login/${encodeURIComponent(loginId)}/cancel`, { method: 'POST' });
    },
    startTaskModelPush: (taskId, input) => {
      const { idempotencyKey, ...body } = input;
      return request<NativeOperationAcceptance>(`/api/tasks/${encodeURIComponent(taskId)}/conversations`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      });
    },
    loadTaskGitWorkspaces: (taskId) => request<TaskWorkspacesSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces`),
    loadTaskGitWorkspaceIndex: (taskId) => request<TaskWorkspaceIndexCollection>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/index`),
    loadTaskGitWorkspaceSnapshot: (taskId, workspaceId) => request<TaskWorkspaceSnapshotResponse>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/snapshot`),
    loadTaskWorkspaceFileDiff: (taskId, workspaceId, path, scope = 'working') =>
      request<{
        path: string;
        diff: TaskGitDiffSummary;
      }>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/file-diff?path=${encodeURIComponent(path)}&scope=${encodeURIComponent(scope)}`),
    commitTaskWorkspace: (taskId, workspaceId, input) =>
      request<TaskWorkspaceCommitResult>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/commit`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    commitAllTaskWorkspaces: (taskId, input) =>
      request<BatchTaskWorkspaceResponse>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/commit-all`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    pushTaskWorkspace: (taskId, workspaceId) =>
      request<TaskWorkspacePushResult>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/push`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    pushAllTaskWorkspaces: (taskId) =>
      request<BatchTaskWorkspaceResponse>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/push-all`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    pushTaskIntegration: (taskId, integrationId) =>
      request<TaskIntegrationPushResult>(`/api/tasks/${encodeURIComponent(taskId)}/integrations/${encodeURIComponent(integrationId)}/push`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    reclaimTaskWorkspace: (taskId, workspaceId) =>
      request<{ workspace: unknown; result?: unknown }>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/reclaim`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    discardTaskWorkspace: (taskId, workspaceId, confirmationText) =>
      request<{ workspace: unknown; result: unknown }>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/discard`, {
        method: 'POST',
        body: JSON.stringify({ confirmationText }),
      }),
    stopTaskWorkspaceSessions: (taskId, workspaceId) =>
      request<{ workspaceId: string; interrupted: number; cancelled: number }>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/stop-sessions`, { method: 'POST', body: JSON.stringify({}) }),
    loadTaskIntegrations: (taskId) => request<{ taskId: string; items: TaskIntegrationRecord[]; integrations: TaskIntegrationRecord[] }>(`/api/tasks/${encodeURIComponent(taskId)}/integrations`),
    startTaskIntegration: (taskId, workspaceId, input) =>
      request<{
        integration: TaskIntegrationRecord;
        result?: TaskIntegrationResult;
      }>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/integrate`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    loadTaskIntegrationConflict: (taskId, integrationId, path) => request<TaskIntegrationConflictFile>(`/api/tasks/${encodeURIComponent(taskId)}/integrations/${encodeURIComponent(integrationId)}/conflict?path=${encodeURIComponent(path)}`),
    startTaskIntegrationConflictAi: (taskId, integrationId, path, content, permissionMode, idempotencyKey) =>
      request<TaskIntegrationConflictAiSession>(`/api/tasks/${encodeURIComponent(taskId)}/integrations/${encodeURIComponent(integrationId)}/conflict/ai-session?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ content, permissionMode }),
      }),
    resolveTaskIntegrationConflict: (taskId, integrationId, path, content) =>
      request<{ integration: TaskIntegrationRecord; result: { path: string; remainingConflictFiles: string[] } }>(
        `/api/tasks/${encodeURIComponent(taskId)}/integrations/${encodeURIComponent(integrationId)}/conflict?path=${encodeURIComponent(path)}`,
        { method: 'PUT', body: JSON.stringify({ content }) },
      ),
    finalizeTaskIntegration: (taskId, integrationId) =>
      request<{
        integration: TaskIntegrationRecord;
        result: TaskIntegrationResult;
      }>(`/api/tasks/${encodeURIComponent(taskId)}/integrations/${encodeURIComponent(integrationId)}/finalize`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    startNativeConversation: (taskId, input) => {
      const { idempotencyKey, ...body } = input;
      return request<NativeOperationAcceptance>(`/api/tasks/${encodeURIComponent(taskId)}/conversations`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      });
    },
    loadNativeConversation: (projectId, conversationId) => request<NativeConversationSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`),
    loadNativePendingRequests: (projectId, conversationId) =>
      request<{ conversationId: string; requests: NativePendingRequest[] }>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/pending-requests`),
    loadNativeConversationChoice: (projectId, conversationId) => request<NativeConversationChoice>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/choice`),
    archiveNativeConversation: (projectId, conversationId) => request<GraphConversationHistoryItem>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/archive`, { method: 'POST' }),
    restoreConversationArchive: (projectId, conversationId) => request<GraphConversationHistoryItem>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/restore`, { method: 'POST' }),
    loadConversationResourcePreview: (projectId, conversationId, resourceId) =>
      request<ConversationResourcePreview>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/resources/${encodeURIComponent(resourceId)}/preview`),
    loadTurnChangeFilePreview: (projectId, conversationId, turnId, changeSetId, fileId) =>
      request<ConversationResourcePreview>(
        `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/change-set/${encodeURIComponent(changeSetId)}/files/${encodeURIComponent(fileId)}/preview`,
      ),
    loadTurnChangeSet: (projectId, conversationId, turnId) => request<TurnChangeSet>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/change-set`),
    operateTurnChangeSet: (projectId, conversationId, turnId, action, input) =>
      request<TurnChangeSetOperationResult>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/change-set/${action}`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    acknowledgeNativeConversationAttention: (projectId, conversationId, expectedRevision) =>
      request<{ acknowledged: boolean; conversation: NativeConversationChoice }>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/attention-acknowledgement`, {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision }),
      }),
    restoreArchivedNativeConversation: (projectId, conversationId) =>
      request<NativeConversationSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/provider-thread/restore`, { method: 'POST' }),
    updateNativePermissionMode: (projectId, conversationId, permissionMode) =>
      request<NativeConversationSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/permission-mode`, {
        method: 'PATCH',
        body: JSON.stringify({ permissionMode }),
      }),
    updateNativeCollaborationMode: (projectId, conversationId, collaborationMode) =>
      request<NativeConversationSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/collaboration-mode`, {
        method: 'PATCH',
        body: JSON.stringify({ collaborationMode }),
      }),
    updateNativeNextTurnSettings: (projectId, conversationId, settings) =>
      request<NativeNextTurnSettings>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/next-turn-settings`, {
        method: 'PATCH',
        body: JSON.stringify(settings),
      }),
    loadCodexLegacyImports: () => request<CodexLegacyImportSnapshot>('/api/codex-native/import'),
    startCodexLegacyImport: (sourceConversationIds) =>
      request<CodexLegacyImportResult>('/api/codex-native/import', {
        method: 'POST',
        body: JSON.stringify({ sourceConversationIds }),
      }),
    loadCodexLegacyImport: (importId) => request<CodexLegacyImportResult>(`/api/codex-native/import/${encodeURIComponent(importId)}`),
    inspectCodexConfigImport: () => request<CodexConfigImportPreview>('/api/codex-config/import'),
    importCodexConfig: () => request<CodexConfigImportResult>('/api/codex-config/import', { method: 'POST' }),
    sendNativeMessage: (projectId, conversationId, input) => {
      const { idempotencyKey, ...body } = input;
      return request<NativeOperationAcceptance>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      });
    },
    editNativeQueuedSubmission: (projectId, conversationId, submissionId, content) =>
      request<NativeQueueSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(submissionId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      }),
    deleteNativeQueuedSubmission: (projectId, conversationId, submissionId) =>
      request<NativeQueueSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(submissionId)}`, { method: 'DELETE' }),
    sendNativeQueuedNow: (projectId, conversationId, submissionId) =>
      request<NativeOperationAcceptance>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(submissionId)}/send-now`, { method: 'POST' }),
    interruptNativeTurn: (projectId, conversationId, turnId) =>
      request<NativeOperationAcceptance>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/interrupt`, { method: 'POST' }),
    respondToNativeRequest: (projectId, conversationId, requestId, response) =>
      request<{ operation: Record<string, unknown>; request: NativePendingRequest }>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/requests/${encodeURIComponent(requestId)}/respond`, {
        method: 'POST',
        body: JSON.stringify(response),
      }),
    snoozeNativeRequest: (projectId, conversationId, requestId) =>
      request<{
        request: NativePendingRequest;
      }>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/requests/${encodeURIComponent(requestId)}/snooze`, { method: 'POST' }),
    respondToPlanImplementationRequest: (projectId, conversationId, requestId, input) =>
      request<{
        operation: NativeOperationAcceptance['operation'];
        request: NativePlanImplementationRequest;
        conversation: NativeConversationSnapshot;
      }>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/plan-implementation-requests/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: JSON.stringify(input) }),
    resumeNativeQueue: (projectId, conversationId) => request<NativeQueueSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/queue/resume`, { method: 'POST' }),
    recoverNativeQueue: (projectId, conversationId) => request<NativeQueueSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/queue/recover`, { method: 'POST' }),
    reorderNativeQueue: (projectId, conversationId, orderedSubmissionIds) =>
      request<NativeQueueSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/queue/reorder`, {
        method: 'POST',
        body: JSON.stringify({ orderedSubmissionIds }),
      }),
    loadDashboard: async () => normalizeDashboardSnapshot(await request<DashboardSnapshot>('/api/dashboard')),
    loadRuntimeStatus: () => request<RuntimeStatusSnapshot>('/api/settings/runtime-status'),
    loadCodexRemoteControl: () => request<CodexRemoteControlSnapshot>('/api/codex/remote-control'),
    enableCodexRemoteControl: () => request<CodexRemoteControlSnapshot>('/api/codex/remote-control/enable', { method: 'POST' }),
    disableCodexRemoteControl: () => request<CodexRemoteControlSnapshot>('/api/codex/remote-control/disable', { method: 'POST' }),
    startCodexRemoteControlPairing: () => request<CodexRemoteControlPairing>('/api/codex/remote-control/pairing', { method: 'POST' }),
    loadCodexRemoteControlPairingStatus: (input) => request<{ claimed: boolean }>('/api/codex/remote-control/pairing/status', { method: 'POST', body: JSON.stringify(input) }),
    revokeCodexRemoteControlClient: (environmentId, clientId) =>
      request<CodexRemoteControlSnapshot>(`/api/codex/remote-control/clients/${encodeURIComponent(clientId)}?environmentId=${encodeURIComponent(environmentId)}`, { method: 'DELETE' }),
    loadRuntimeSettings: () => request<RuntimeSettings>('/api/runtime/settings'),
    saveRuntimeSettings: (input) =>
      request<RuntimeSettings>('/api/runtime/settings', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    loadCodeMapSettings: () => request<CodeMapSettings>('/api/code-map/settings'),
    saveCodeMapSettings: (input) =>
      request<CodeMapSettings>('/api/code-map/settings', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    loadAppShellSettings: () => request<AppShellSettings>('/api/settings/app-shell'),
    saveAppShellSettings: (input) =>
      request<AppShellSettings>('/api/settings/app-shell', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    clearLocalCaches: () =>
      request<ClearLocalCachesResult>('/api/settings/code-graph-cache/clear', {
        method: 'POST',
      }),
    exportLocalSettings: () => request<LocalSettingsExportSnapshot>('/api/settings/export'),
    importLocalSettings: (input) =>
      request<ImportLocalSettingsResult>('/api/settings/import', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    exportLocalBusinessData: () => request<LocalBusinessDataSnapshot>('/api/data/export'),
    importLocalBusinessData: (input) =>
      request<ImportLocalBusinessDataResult>('/api/data/import', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    loadGlobalCommands: () => request<CommandDefinition[]>('/api/commands/global'),
    createGlobalCommand: (input) => request<CommandDefinition>('/api/commands/global', { method: 'POST', body: JSON.stringify(input) }),
    updateGlobalCommand: (commandId, input) => request<CommandDefinition>(`/api/commands/global/${encodeURIComponent(commandId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
    deleteGlobalCommand: (commandId) => request<CommandDefinition>(`/api/commands/global/${encodeURIComponent(commandId)}`, { method: 'DELETE' }),
    loadProjectCommands: (projectId) => request<CommandDefinition[]>(`/api/projects/${encodeURIComponent(projectId)}/commands`),
    createProjectCommand: (projectId, input) => request<CommandDefinition>(`/api/projects/${encodeURIComponent(projectId)}/commands`, { method: 'POST', body: JSON.stringify(input) }),
    updateProjectCommand: (projectId, commandId, input) =>
      request<CommandDefinition>(`/api/projects/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteProjectCommand: (projectId, commandId) => request<CommandDefinition>(`/api/projects/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}`, { method: 'DELETE' }),
    createCommandConfirmation: (projectId, commandId, input) =>
      request<CommandConfirmationResponse>(`/api/projects/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}/confirmations`, { method: 'POST', body: JSON.stringify(input) }),
    startCommandRun: (projectId, commandId, input) =>
      request<CommandRun>(`/api/projects/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}/runs`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    loadCommandRuns: (projectId, limit = 100) => request<CommandRun[]>(`/api/projects/${encodeURIComponent(projectId)}/command-runs?limit=${encodeURIComponent(String(limit))}`),
    loadCommandRun: (runId, options = {}) => {
      const params = new URLSearchParams();
      if (options.afterSeq !== undefined) params.set('afterSeq', String(options.afterSeq));
      if (options.logLimit !== undefined) params.set('logLimit', String(options.logLimit));
      if (options.tail !== undefined) params.set('tail', String(options.tail));
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return request<CommandRunDetail>(`/api/command-runs/${encodeURIComponent(runId)}${query}`);
    },
    stopCommandRun: (runId) => request<CommandRun>(`/api/command-runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }),
    loadCommandArtifact: (artifactId) => requestBlob(`/api/command-artifacts/${encodeURIComponent(artifactId)}/content`),
    loadRuntimeAdapters: () => request<AiRuntimeAdapterDescriptor[]>('/api/runtime/adapters'),
    checkRuntimeAdapter: (adapterId) => request<AiRuntimeAdapterStatus>(`/api/runtime/adapters/${adapterId}/check`),
    loadRuntimeSessions: (input) => request<AiRuntimeSession[]>(`/api/runtime/sessions${toRuntimeSessionQuery(input)}`),
    createRuntimeConfirmation: (input) =>
      request<RuntimeOperationConfirmation>('/api/runtime/confirmations', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    confirmRuntimeOperation: (confirmationId) => request<RuntimeOperationConfirmation>(`/api/runtime/confirmations/${confirmationId}/confirm`, { method: 'POST' }),
    rejectRuntimeOperation: (confirmationId, reason) => request<RuntimeOperationConfirmation>(`/api/runtime/confirmations/${confirmationId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    startRuntimeSession: (input) =>
      request<AiRuntimeSession>('/api/runtime/sessions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    stopRuntimeSession: (sessionId) =>
      request<AiRuntimeSession>(`/api/runtime/sessions/${sessionId}/stop`, {
        method: 'POST',
      }),
    loadRuntimeSessionLogs: (sessionId) => request<AiRuntimeLogEntry[]>(`/api/runtime/sessions/${sessionId}/logs`),
    loadRuntimeSessionLogsPage: (sessionId, input) => request<RuntimeLogPage>(`/api/runtime/sessions/${sessionId}/logs${toRuntimeLogQuery(input)}`),
    sendRuntimeInput: (sessionId, input) =>
      request<AiRuntimeSession>(`/api/runtime/sessions/${sessionId}/input`, {
        method: 'POST',
        body: JSON.stringify({ input }),
      }),
    interruptRuntimeSession: (sessionId) => request<AiRuntimeSession>(`/api/runtime/sessions/${sessionId}/interrupt`, { method: 'POST' }),
    resizeRuntimeSession: (sessionId, size) =>
      request<AiRuntimeSession>(`/api/runtime/sessions/${sessionId}/resize`, {
        method: 'POST',
        body: JSON.stringify(size),
      }),
    loadRuntimeTerminalSnapshot: (sessionId) => request<AiRuntimeTerminalSnapshot>(`/api/runtime/sessions/${sessionId}/terminal`),
    loadRuntimeTerminalEvents: (sessionId, input) => request<RuntimeTerminalEventPage>(`/api/runtime/sessions/${sessionId}/terminal/events${toTerminalEventQuery(input)}`),
    generateRuntimeSessionSummary: (sessionId) =>
      request<AiRuntimeSession>(`/api/runtime/sessions/${sessionId}/summary`, {
        method: 'POST',
      }),
    setRuntimeSessionFavorite: (sessionId, favorite) =>
      request<AiRuntimeSession>(`/api/runtime/sessions/${sessionId}/favorite`, {
        method: 'PUT',
        body: JSON.stringify({ favorite }),
      }),
    archiveRuntimeSession: (sessionId) =>
      request<AiRuntimeSession>(`/api/runtime/sessions/${sessionId}/archive`, {
        method: 'POST',
      }),
    restoreRuntimeSession: (sessionId) =>
      request<AiRuntimeSession>(`/api/runtime/sessions/${sessionId}/restore`, {
        method: 'POST',
      }),
    deleteRuntimeSession: (sessionId) =>
      request<AiRuntimeSession>(`/api/runtime/sessions/${sessionId}`, {
        method: 'DELETE',
      }),
    createTaskFromRuntimeSession: (sessionId, input) =>
      request<TaskRecord>(`/api/runtime/sessions/${sessionId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    loadSecuritySecrets: () => request<SecuritySecretsSnapshot>('/api/security/secrets'),
    loadSecurityAuditLogs: () => request<SecurityAuditLogEntry[]>('/api/security/audit-logs'),
    loadReleaseStatus: () => request<ReleaseStatusSnapshot>('/api/release/status'),
    loadReleaseUpdateStatus: () => request<ReleaseUpdateStatusSnapshot>('/api/release/update-status'),
    checkReleaseUpdate: () =>
      request<ReleaseUpdateStatusSnapshot>('/api/release/check-update', {
        method: 'POST',
      }),
    downloadReleaseUpdate: () =>
      request<ReleaseUpdateOperationSnapshot>('/api/release/download-update', {
        method: 'POST',
      }),
    installReleaseUpdate: () =>
      request<ReleaseUpdateOperationSnapshot>('/api/release/install-update', {
        method: 'POST',
      }),
    saveTelegramBotToken: (token) => request<SecuritySecretsSnapshot>('/api/security/secrets/telegram-bot-token', { method: 'PUT', body: JSON.stringify({ token }) }),
    clearTelegramBotToken: () => request<SecuritySecretsSnapshot>('/api/security/secrets/telegram-bot-token', { method: 'DELETE' }),
    saveExternalApiKey: (key) => request<SecuritySecretsSnapshot>('/api/security/secrets/external-api-key', { method: 'PUT', body: JSON.stringify({ key }) }),
    clearExternalApiKey: () => request<SecuritySecretsSnapshot>('/api/security/secrets/external-api-key', { method: 'DELETE' }),
    resetSecurity: () => request<SecurityResetResult>('/api/security/reset', { method: 'POST' }),
    loadTelegramStatus: () => request<TelegramStatusSnapshot>('/api/telegram/status'),
    saveTelegramSettings: (input) =>
      request<TelegramSettingsSnapshot>('/api/telegram/settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    startTelegram: () => request<TelegramPollingStatus>('/api/telegram/start', { method: 'POST' }),
    stopTelegram: () => request<TelegramPollingStatus>('/api/telegram/stop', { method: 'POST' }),
    loadTelegramPollingStatus: () => request<TelegramPollingStatus>('/api/telegram/polling/status'),
    loadTelegramPollingLogs: () => request<TelegramPollingLogEntry[]>('/api/telegram/polling/logs'),
    loadTelegramMessages: () => request<TelegramPollingLogEntry[]>('/api/telegram/messages'),
    startTelegramPolling: () =>
      request<TelegramPollingStatus>('/api/telegram/polling/start', {
        method: 'POST',
      }),
    stopTelegramPolling: () =>
      request<TelegramPollingStatus>('/api/telegram/polling/stop', {
        method: 'POST',
      }),
    pollTelegramOnce: () =>
      request<TelegramPollingStatus>('/api/telegram/polling/poll-once', {
        method: 'POST',
      }),
    testTelegramConnection: () =>
      request<TelegramTestConnectionResult>('/api/telegram/test', {
        method: 'POST',
      }),
    loadTelegramNotificationSettings: () => request<TelegramNotificationSettings>('/api/telegram/notification-settings'),
    saveTelegramNotificationSettings: (input) => request<TelegramNotificationSettings>('/api/telegram/notification-settings', { method: 'PUT', body: JSON.stringify(input) }),
    loadTelegramSecuritySettings: () => request<TelegramSecuritySettings>('/api/telegram/security-settings'),
    saveTelegramSecuritySettings: (input) =>
      request<TelegramSecuritySettings>('/api/telegram/security-settings', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    loadTaskTemplates: (projectId) => request<TaskTemplateRecord[]>(`/api/task-templates${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
    loadArchivedProjects: () => request<ProjectRecord[]>('/api/projects/archived'),
    loadArchivedTasks: (projectId) => request<TaskRecord[]>(`/api/tasks/archived?projectId=${encodeURIComponent(projectId)}`),
    scanCurrentGraph: () => request<GraphScanResult>('/api/graph/scan-current', { method: 'POST' }),
    loadGraphView: (viewType = 'architecture') => request<GraphViewSnapshot>(`/api/graph/views/${viewType}`),
    searchGraph: (input) =>
      request<GraphSearchResult>(
        `/api/graph/search?query=${encodeURIComponent(input.query)}${input.nodeType ? `&nodeType=${encodeURIComponent(input.nodeType)}` : ''}${input.edgeType ? `&edgeType=${encodeURIComponent(input.edgeType)}` : ''}${typeof input.minConfidence === 'number' ? `&minConfidence=${input.minConfidence}` : ''}`,
      ),
    // 项目级图谱方法只封装本地 API 路径，真实图谱事实仍由服务端扫描/缓存保证。
    loadProjectGraphView: (projectId, viewType = 'architecture') => request<GraphViewSnapshot>(`/api/projects/${projectId}/graph/views/${viewType}`),
    searchProjectGraph: (projectId, input) =>
      request<GraphSearchResult>(
        `/api/projects/${projectId}/graph/search?query=${encodeURIComponent(input.query)}${input.nodeType ? `&nodeType=${encodeURIComponent(input.nodeType)}` : ''}${input.edgeType ? `&edgeType=${encodeURIComponent(input.edgeType)}` : ''}${typeof input.minConfidence === 'number' ? `&minConfidence=${input.minConfidence}` : ''}`,
      ),
    loadProjectGraphNode: (projectId, nodeId) => request<GraphViewSnapshot['nodes'][number]>(`/api/projects/${projectId}/graph/nodes/${nodeId}`),
    loadProjectGraphNeighborhood: (projectId, nodeId, depth = 1) => request<GraphNeighborhood>(`/api/projects/${projectId}/graph/nodes/${nodeId}/neighborhood?depth=${depth}`),
    // 语义 Code Map API 从服务端真实图谱派生，不在 renderer 侧补数据或重分类。
    loadProjectApis: (projectId) => request<SemanticGraphNodeList>(`/api/projects/${projectId}/apis`),
    loadProjectApi: (projectId, apiId) => request<SemanticGraphNodeDetail>(`/api/projects/${projectId}/apis/${apiId}`),
    loadProjectApiSequence: (projectId, apiId) => request<FocusedSemanticGraphView>(`/api/projects/${projectId}/apis/${apiId}/sequence`),
    loadProjectModules: (projectId) => request<SemanticGraphNodeList>(`/api/projects/${projectId}/modules`),
    loadProjectModule: (projectId, moduleId) => request<SemanticGraphNodeDetail>(`/api/projects/${projectId}/modules/${moduleId}`),
    loadProjectModuleFlow: (projectId, moduleId) => request<FocusedSemanticGraphView>(`/api/projects/${projectId}/modules/${moduleId}/flow`),
    loadProjectTables: (projectId) => request<SemanticGraphNodeList>(`/api/projects/${projectId}/tables`),
    searchProjectTableFields: (projectId, query) => request<SemanticGraphNodeList & { query: string }>(`/api/projects/${projectId}/tables/columns/search?query=${encodeURIComponent(query)}`),
    loadProjectTable: (projectId, tableId) => request<SemanticGraphNodeDetail>(`/api/projects/${projectId}/tables/${tableId}`),
    loadProjectTableImpact: (projectId, tableId) => request<FocusedSemanticGraphView>(`/api/projects/${projectId}/tables/${tableId}/impact`),
    loadProjectMethodLogic: (projectId, methodId) => request<FocusedSemanticGraphView>(`/api/projects/${projectId}/methods/${methodId}/logic`),
    askGraph: (projectId, input) =>
      request<GraphQuestionAnswer>(`/api/projects/${projectId}/ask`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    loadGraphConversations: (projectId, input) => request<GraphConversationHistoryPage>(`/api/projects/${projectId}/conversations${toGraphConversationQuery(input)}`),
    loadGraphConversation: (projectId, conversationId) => request<GraphConversationHistoryItem>(`/api/projects/${projectId}/conversations/${conversationId}`),
    sendConversationMessage: (projectId, conversationId, content) =>
      request<SendConversationMessageResult>(`/api/projects/${projectId}/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      }),
    archiveGraphConversation: (projectId, conversationId) => request<GraphConversationHistoryItem>(`/api/projects/${projectId}/conversations/${conversationId}/archive`, { method: 'POST' }),
    restoreGraphConversation: (projectId, conversationId) => request<GraphConversationHistoryItem>(`/api/projects/${projectId}/conversations/${conversationId}/restore`, { method: 'POST' }),
    createTaskFromGraphConversation: (projectId, conversationId, input) => request<TaskRecord>(`/api/projects/${projectId}/conversations/${conversationId}/tasks`, { method: 'POST', body: JSON.stringify(input ?? {}) }),
    loadGraphEdgeDetail: (edgeId) => request<GraphEdgeDetail>(`/api/graph/edges/${edgeId}`),
    loadGraphNeighborhood: (nodeId, depth = 1) => request<GraphNeighborhood>(`/api/graph/nodes/${nodeId}/neighborhood?depth=${depth}`),
    loadProjects: (input) => request<ProjectRecord[]>(`/api/projects${input?.query ? `?query=${encodeURIComponent(input.query)}` : ''}`),
    loadProject: (projectId) => request<ProjectRecord>(`/api/projects/${projectId}`),
    // 项目配置仅保存用户偏好，不在 renderer 侧补造项目、任务或外部运行时状态。
    loadProjectConfig: (projectId) => request<ProjectConfig>(`/api/projects/${projectId}/config`),
    saveProjectConfig: (projectId, input) =>
      request<ProjectConfig>(`/api/projects/${projectId}/config`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    loadProjectWorkspaceConfig: (projectId) => request<ProjectWorkspaceConfigSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/workspace-config`),
    saveProjectWorkspaceConfig: (projectId, input) =>
      request<ProjectWorkspaceConfigSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/workspace-config`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    loadProjectDatabaseSecret: (projectId) => request<ProjectDatabaseSecretSnapshot>(`/api/projects/${projectId}/database/secret`),
    saveProjectDatabasePassword: (projectId, password) => request<ProjectDatabaseSecretSnapshot>(`/api/projects/${projectId}/database/secret`, { method: 'PUT', body: JSON.stringify({ password }) }),
    clearProjectDatabasePassword: (projectId) => request<ProjectDatabaseSecretSnapshot>(`/api/projects/${projectId}/database/secret`, { method: 'DELETE' }),
    createProject: (input) =>
      request<ProjectRecord>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateProject: (projectId, input) =>
      request<ProjectRecord>(`/api/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    deleteProject: (projectId) =>
      request<ProjectRecord>(`/api/projects/${projectId}`, {
        method: 'DELETE',
      }),
    createProjectArchiveConfirmation: (projectId) => request<ProjectArchiveConfirmation>(`/api/projects/${projectId}/archive-confirmation`, { method: 'POST' }),
    archiveProject: (projectId) =>
      request<ProjectRecord>(`/api/projects/${projectId}/archive`, {
        method: 'POST',
      }),
    restoreProject: (projectId) =>
      request<ProjectRecord>(`/api/projects/${projectId}/restore`, {
        method: 'POST',
      }),
    setProjectDefaultTemplate: (projectId, templateId) =>
      request<ProjectRecord>(`/api/projects/${projectId}/default-template`, {
        method: 'PUT',
        body: JSON.stringify({ templateId }),
      }),
    scanProject: (projectId) =>
      request<GraphScanResult>(`/api/projects/${projectId}/scan`, {
        method: 'POST',
      }),
    loadProjectScanStatus: (projectId) => request<ProjectScanStatus>(`/api/projects/${projectId}/scan-status`),
    loadProjectOverview: (projectId) => request<ProjectOverview>(`/api/projects/${projectId}/overview`),
    createTask: (input) =>
      request<TaskRecord>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    loadTasks: (input) =>
      request<TaskRecord[]>(
        `/api/tasks?projectId=${encodeURIComponent(input.projectId)}${input.query ? `&query=${encodeURIComponent(input.query)}` : ''}${input.managementStatus ? `&managementStatus=${encodeURIComponent(input.managementStatus)}` : ''}${input.tag ? `&tag=${encodeURIComponent(input.tag)}` : ''}${input.sortBy ? `&sortBy=${encodeURIComponent(input.sortBy)}` : ''}${input.sortDirection ? `&sortDirection=${encodeURIComponent(input.sortDirection)}` : ''}`,
      ),
    loadTask: (taskId) => request<TaskRecord>(`/api/tasks/${taskId}`),
    updateTask: (taskId, input) =>
      request<TaskRecord>(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    updateTaskRelationships: (taskId, input) =>
      request<TaskRecord>(`/api/tasks/${taskId}/relationships`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    updateTaskTags: (taskId, tags, expectedUpdatedAt) =>
      request<TaskRecord>(`/api/tasks/${taskId}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tags, expectedUpdatedAt }),
      }),
    deleteTask: (taskId, input = {}) => request<DeleteTaskResult>(`/api/tasks/${taskId}`, { method: 'DELETE', body: JSON.stringify(input) }),
    runTask: (taskId) =>
      request<TaskRuntimeControlResult>(`/api/tasks/${taskId}/run`, {
        method: 'POST',
      }),
    pauseTask: (taskId) => request<TaskRecord>(`/api/tasks/${taskId}/pause`, { method: 'POST' }),
    continueTask: (taskId) =>
      request<TaskRuntimeControlResult>(`/api/tasks/${taskId}/continue`, {
        method: 'POST',
      }),
    cancelTask: (taskId) => request<TaskRecord>(`/api/tasks/${taskId}/cancel`, { method: 'POST' }),
    retryTask: (taskId) => request<TaskRecord>(`/api/tasks/${taskId}/retry`, { method: 'POST' }),
    createTaskFromGraphNode: (nodeId, input) =>
      request<TaskRecord>(`/api/graph/nodes/${nodeId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    // 项目级图谱任务接口对齐设计书 7.7；renderer 只传意图和节点/视图 id，不拼装图谱上下文。
    createProjectTaskFromGraphNode: (projectId, nodeId, input) => request<TaskRecord>(`/api/projects/${projectId}/graph/nodes/${nodeId}/create-task`, { method: 'POST', body: JSON.stringify(input ?? {}) }),
    createProjectTaskFromGraphView: (projectId, viewId, input) => request<TaskRecord>(`/api/projects/${projectId}/graph/views/${viewId}/create-task`, { method: 'POST', body: JSON.stringify(input ?? {}) }),
    linkTaskGraphNode: (taskId, input) =>
      request<TaskRecord>(`/api/tasks/${taskId}/link-graph-node`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    createTaskTemplate: (input) =>
      request<TaskTemplateRecord>('/api/task-templates', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    createTaskFromTemplate: (templateId, input) =>
      request<TaskRecord>(`/api/task-templates/${templateId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    loadGitDiff: () => request<GitDiffSummary>('/api/git/diff'),
    loadProjectGitStatus: (projectId) => request<GitStatusSummary>(`/api/projects/${projectId}/git/status`),
    loadProjectGitDiff: (projectId) => request<GitDiffSummary>(`/api/projects/${projectId}/git/diff`),
    createProjectGitSnapshot: (projectId, taskId) => request<ProjectGitSnapshotResult>(`/api/projects/${projectId}/git/snapshot`, { method: 'POST', body: JSON.stringify({ taskId }) }),
    // 项目级 patch 导出走后端 readonly 路由，renderer 不拼接或执行任何 Git 命令。
    exportProjectGitPatch: (projectId) =>
      request<GitPatchExport>(`/api/projects/${projectId}/git/patch`, {
        method: 'POST',
      }),
    loadTaskGitDiff: (taskId) => request<GitDiffSummary>(`/api/tasks/${taskId}/diff`),
    exportGitPatch: () => request<GitPatchExport>('/api/git/patch'),
    loadTaskEvents: (taskId) => request<TaskEventRecord[]>(`/api/tasks/${taskId}/events`),
    updateTaskStatus: (taskId, status) =>
      request<TaskRecord>(`/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    updateTaskManagementStatus: (taskId, status, expectedUpdatedAt, confirmWorktreeCleanup, reopenConversationId) =>
      request<TaskRecord>(`/api/tasks/${taskId}/management-status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          expectedUpdatedAt,
          ...(confirmWorktreeCleanup === true ? { confirmWorktreeCleanup: true } : {}),
          ...(reopenConversationId ? { reopenConversationId } : {}),
        }),
      }),
    archiveTask: (taskId) => request<TaskRecord>(`/api/tasks/${taskId}/archive`, { method: 'POST' }),
    restoreTask: (taskId) => request<TaskRecord>(`/api/tasks/${taskId}/restore`, { method: 'POST' }),
    createGitConfirmation: (input) =>
      request<GitOperationConfirmation>('/api/git/confirmations', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    confirmGitOperation: (confirmationId) => request<GitOperationConfirmation>(`/api/git/confirmations/${confirmationId}/confirm`, { method: 'POST' }),
    // 拒绝高风险 Git 确认只改变确认单状态，后端会保证不执行任何 Git 写命令。
    rejectGitOperation: (confirmationId, reason) => request<GitOperationConfirmation>(`/api/git/confirmations/${confirmationId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    executeGitOperation: (input) =>
      request<ExecutedGitOperationResult>('/api/git/operations', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    executeProjectGitBranch: (projectId, input) => request<ExecutedGitOperationResult>(`/api/projects/${projectId}/git/branch`, { method: 'POST', body: JSON.stringify(input) }),
    executeProjectGitCheckout: (projectId, input) => request<ExecutedGitOperationResult>(`/api/projects/${projectId}/git/checkout`, { method: 'POST', body: JSON.stringify(input) }),
    executeProjectGitCommit: (projectId, input) => request<ExecutedGitOperationResult>(`/api/projects/${projectId}/git/commit`, { method: 'POST', body: JSON.stringify(input) }),
    executeProjectGitStash: (projectId, input) => request<ExecutedGitOperationResult>(`/api/projects/${projectId}/git/stash`, { method: 'POST', body: JSON.stringify(input) }),
    executeProjectGitApplyStash: (projectId, input) => request<ExecutedGitOperationResult>(`/api/projects/${projectId}/git/apply-stash`, { method: 'POST', body: JSON.stringify(input) }),
    executeProjectGitPull: (projectId, input) => request<ExecutedGitOperationResult>(`/api/projects/${projectId}/git/pull`, { method: 'POST', body: JSON.stringify(input) }),
    executeProjectGitPush: (projectId, input) => request<ExecutedGitOperationResult>(`/api/projects/${projectId}/git/push`, { method: 'POST', body: JSON.stringify(input) }),
    executeTaskGitRollback: (taskId, input) =>
      request<ExecutedGitOperationResult>(`/api/tasks/${taskId}/git/rollback`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  };
}

/**
 * 上一正式版宿主可能缺少新增的纯投影字段。Renderer 在边界统一补齐，
 * 避免后端任务正常运行时，整个工作台因一个可缺省字段进入崩溃页。
 */
export function normalizeDashboardSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  return {
    ...snapshot,
    conversationAttentionByProject: snapshot.conversationAttentionByProject && typeof snapshot.conversationAttentionByProject === 'object' ? snapshot.conversationAttentionByProject : {},
    conversationUnreadCountByProject: snapshot.conversationUnreadCountByProject && typeof snapshot.conversationUnreadCountByProject === 'object' ? snapshot.conversationUnreadCountByProject : {},
  };
}

function connectZeusEvents(options: DashboardClientOptions, onEvent: (event: ZeusRealtimeEvent) => void, eventOptions?: { afterEventId?: string }): WebSocket {
  const wsUrl = new URL(`${options.baseUrl.replace(/^http/u, 'ws')}/api/events`);
  if (eventOptions?.afterEventId) wsUrl.searchParams.set('afterEventId', eventOptions.afterEventId);
  const socket = new WebSocket(wsUrl.toString(), buildZeusWebSocketProtocol(options.apiToken));
  socket.addEventListener('message', (message) => {
    void decodeWebSocketMessage(message.data).then((text) => {
      if (!text) return;
      onEvent(JSON.parse(text) as ZeusRealtimeEvent);
    });
  });
  return socket;
}

function buildZeusWebSocketProtocol(apiToken: string): string {
  if (typeof Buffer !== 'undefined') {
    return `zeus-token.${Buffer.from(apiToken, 'utf8').toString('base64url')}`;
  }
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(apiToken)))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
  return `zeus-token.${encoded}`;
}

function isLikelyLocalServerConnectionError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const message = error.message.toLowerCase();
  return message.includes('fetch') || message.includes('network') || message.includes('failed');
}

async function decodeWebSocketMessage(data: MessageEvent['data']): Promise<string | null> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data === 'object' && 'text' in data && typeof data.text === 'function') {
    return data.text();
  }
  return null;
}

function toRuntimeSessionQuery(input?: LoadRuntimeSessionsRequest): string {
  const params = new URLSearchParams();
  if (input?.query) params.set('query', input.query);
  if (input?.projectId) params.set('projectId', input.projectId);
  if (input?.taskId) params.set('taskId', input.taskId);
  if (input?.archived) params.set('archived', 'true');
  if (input?.favoriteOnly) params.set('favoriteOnly', 'true');
  const query = params.toString();
  return query ? `?${query}` : '';
}

function toRuntimeLogQuery(input?: LoadRuntimeLogsRequest): string {
  const params = new URLSearchParams();
  if (input?.query) params.set('query', input.query);
  if (input?.stream) params.set('stream', input.stream);
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit));
  if (typeof input?.offset === 'number') params.set('offset', String(input.offset));
  const query = params.toString();
  return query ? `?${query}` : '?limit=200';
}

function toTerminalEventQuery(input?: LoadRuntimeTerminalEventsRequest): string {
  const params = new URLSearchParams();
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit));
  if (typeof input?.offset === 'number') params.set('offset', String(input.offset));
  const query = params.toString();
  return query ? `?${query}` : '?limit=200';
}

function toGraphConversationQuery(input?: LoadGraphConversationsRequest): string {
  const params = new URLSearchParams();
  if (input?.query) params.set('query', input.query);
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit));
  if (typeof input?.offset === 'number') params.set('offset', String(input.offset));
  if (input?.archived) params.set('archived', 'true');
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** 首次渲染兜底 snapshot，不包含任何假业务记录。 */
export function createEmptyDashboardSnapshot(): DashboardSnapshot {
  return {
    app: 'Zeus',
    localServer: { host: '127.0.0.1', port: null },
    projects: [],
    tasks: [],
    conversationAttentionByProject: {},
    conversationUnreadCountByProject: {},
    runtime: {
      aiCli: {
        available: false,
        reason: '未检测到可用 AI CLI，请在设置中配置。',
      },
      telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
    },
    git: {
      isRepository: false,
      branch: '',
      clean: true,
      changedFiles: [],
      conflictFiles: [],
      fileStatuses: [],
      remoteBranches: [],
      recentCommits: [],
    },
    graph: { nodeCount: 0, edgeCount: 0, viewCount: 0 },
  };
}
