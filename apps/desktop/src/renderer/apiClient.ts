export type TaskStatus = 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';

export interface ProjectRecord {
  id: string;
  name: string;
  localPath: string;
  description?: string | null;
  note?: string | null;
  scanStatus: string;
  defaultTemplateId?: string | null;
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
  title: string;
  description?: string;
  status: TaskStatus;
  templateId?: string | null;
  tags?: string[];
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

export interface SecretPresence {
  configured: boolean;
  label: '已安全保存' | '未配置';
}

export interface SecuritySecretsSnapshot {
  telegramBotToken: SecretPresence;
  externalApiKey: SecretPresence;
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
  automaticInstallEnabled: boolean;
  recommendedAction: 'none' | 'open_download_page' | 'download_and_install';
  label: string;
  reason: string;
  checkedAt: string;
}

export interface ReleaseUpdateOperationSnapshot {
  accepted: false;
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
  defaultModel: string | null;
  defaultTaskTemplateId: string | null;
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
  defaultModel?: string | null;
  defaultTaskTemplateId?: string | null;
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
  schemaVersion: 1;
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
  };
}

export interface ImportLocalBusinessDataResult {
  imported: boolean;
  importedCounts: {
    projects: number;
    tasks: number;
    taskEvents: number;
    taskTemplates: number;
  };
  importedAt: string;
}

export interface AiRuntimeAdapterStatus extends AiRuntimeAdapterDescriptor {
  available: boolean;
  reason: string;
  version: string | null;
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

export interface AiRuntimeTerminalSnapshot {
  sessionId: string;
  status: AiRuntimeSessionStatus;
  command: string;
  cwd: string;
  logs: AiRuntimeLogEntry[];
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
  runtimeSession: AiRuntimeSession;
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
  title: string;
  description: string;
  sourceContext: Record<string, unknown>;
  tags?: string[];
}

export interface LoadTasksRequest {
  projectId: string;
  query?: string;
  status?: TaskStatus;
  tag?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'status';
  sortDirection?: 'asc' | 'desc';
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
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
  refreshLocalServerConfig?: () => Promise<DashboardClientOptions>;
}

export interface ZeusRealtimeEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectArchiveConfirmation {
  projectId: string;
  confirmationText: string;
  riskLevel: 'medium';
}

export interface DashboardClient {
  connectEvents: (onEvent: (event: ZeusRealtimeEvent) => void) => WebSocket;
  loadDashboard: () => Promise<DashboardSnapshot>;
  loadRuntimeStatus: () => Promise<RuntimeStatusSnapshot>;
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
  archiveGraphConversation: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  restoreGraphConversation: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  createTaskFromGraphConversation: (projectId: string, conversationId: string, input?: CreateTaskFromGraphConversationRequest) => Promise<TaskRecord>;
  loadGraphEdgeDetail: (edgeId: string) => Promise<GraphEdgeDetail>;
  loadGraphNeighborhood: (nodeId: string, depth?: 1 | 2) => Promise<GraphNeighborhood>;
  loadProjects: (input?: LoadProjectsRequest) => Promise<ProjectRecord[]>;
  loadProject: (projectId: string) => Promise<ProjectRecord>;
  loadProjectConfig: (projectId: string) => Promise<ProjectConfig>;
  saveProjectConfig: (projectId: string, input: SaveProjectConfigRequest) => Promise<ProjectConfig>;
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
  updateTaskTags: (taskId: string, tags: string[]) => Promise<TaskRecord>;
  deleteTask: (taskId: string) => Promise<TaskRecord>;
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
        message?: string;
      } | null;
      // 本地 API 的错误消息已经过服务端脱敏，renderer 优先展示可操作原因，避免只暴露状态码。
      throw new Error(errorPayload?.message ?? `Zeus local API request failed: ${path} ${response.status}`);
    }
    return (await response.json()) as T;
  }

  return {
    connectEvents: (onEvent) => connectZeusEvents(options, onEvent),
    loadDashboard: () => request<DashboardSnapshot>('/api/dashboard'),
    loadRuntimeStatus: () => request<RuntimeStatusSnapshot>('/api/settings/runtime-status'),
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
      request<ClearLocalCachesResult>('/api/settings/cache/clear', {
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
        `/api/tasks?projectId=${encodeURIComponent(input.projectId)}${input.query ? `&query=${encodeURIComponent(input.query)}` : ''}${input.status ? `&status=${encodeURIComponent(input.status)}` : ''}${input.tag ? `&tag=${encodeURIComponent(input.tag)}` : ''}${input.sortBy ? `&sortBy=${encodeURIComponent(input.sortBy)}` : ''}${input.sortDirection ? `&sortDirection=${encodeURIComponent(input.sortDirection)}` : ''}`,
      ),
    loadTask: (taskId) => request<TaskRecord>(`/api/tasks/${taskId}`),
    updateTask: (taskId, input) =>
      request<TaskRecord>(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    updateTaskTags: (taskId, tags) =>
      request<TaskRecord>(`/api/tasks/${taskId}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tags }),
      }),
    deleteTask: (taskId) => request<TaskRecord>(`/api/tasks/${taskId}`, { method: 'DELETE' }),
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

function connectZeusEvents(options: DashboardClientOptions, onEvent: (event: ZeusRealtimeEvent) => void): WebSocket {
  const wsUrl = `${options.baseUrl.replace(/^http/u, 'ws')}/api/events`;
  const socket = new WebSocket(wsUrl, buildZeusWebSocketProtocol(options.apiToken));
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
