import { type ThirdPartyTaskExtract } from '@zeus/shared';
import type { NativeConversationAttachment, NativeConversationChoicesSnapshot, NativeProjectConversationChoicesSnapshot } from '../../session/sessionTypes.js';
import { type TaskResourceAuthorizationResult, type TaskResourcePayload } from '../../task/taskAttachments.js';
import {
  type AiRuntimeAdapterDescriptor,
  type AiRuntimeAdapterStatus,
  type AiRuntimeLogEntry,
  type AiRuntimeSession,
  type AiRuntimeTerminalEvent,
  type AiRuntimeTerminalSnapshot,
  type AppShellSettings,
  type CodexConfigActivationResult,
  type CodexConfigImportPreview,
  type CodexConfigImportResult,
  type CreateProjectRequest,
  type DashboardClient,
  type DashboardSnapshot,
  type DeleteTaskRequest,
  type ExecutedGitOperationResult,
  type ExecuteGitOperationRequest,
  type ExecutionHostTransition,
  type GitDiffSummary,
  type GitOperationConfirmation,
  type GitPatchExport,
  type ConversationHistoryItem,
  type HighRiskGitOperation,
  type ImportLocalBusinessDataResult,
  type ImportLocalSettingsRequest,
  type ImportLocalSettingsResult,
  type LoadRuntimeSessionsRequest,
  type LocalBusinessDataSnapshot,
  type LocalSettingsExportSnapshot,
  type ProjectArchiveConfirmation,
  type ProjectConfig,
  type ProjectModelServiceTierPreference,
  type ProjectDatabaseSecretSnapshot,
  type ProjectRecord,
  type ReleaseStatusSnapshot,
  type ReleaseUpdateStatusSnapshot,
  type RuntimeOperationConfirmation,
  type RuntimeSettings,
  type RuntimeStatusSnapshot,
  type SaveProjectConfigRequest,
  type SecurityAuditLogEntry,
  type SecurityResetResult,
  type SecuritySecretsSnapshot,
  type SendConversationMessageResult,
  type TaskEventRecord,
  type TaskManagementStatus,
  type TaskRecord,
  type TaskStatus,
  type TaskTemplateRecord,
  type TelegramNotificationSettings,
  type TelegramPollingLogEntry,
  type TelegramPollingStatus,
  type TelegramSecuritySettings,
  type TelegramTestConnectionResult,
  type UpdateTaskRelationshipsRequest,
  type UpdateTaskRequest,
  type ZeusRealtimeConnectionState,
  type ZeusRealtimeEvent,
} from '../../apiClient.js';
import {
  type AppShellSettingsSavePayload,
  type LegacyMainNavTarget,
  type LocalUiErrorSnapshot,
  type MainNavTarget,
  type NativeConversationAppClient,
  type SettingsCategory,
  type TaskCreateAttachmentCandidate,
  type TaskCreateDraft,
  type TaskRuntimeControlHandlerResult,
} from './workspaceSupport.js';
export type WorkspacePageProps = {
  /** 读取已有会话正文，供历史会话展示使用。 */
  onLoadLegacyConversation?: (projectId: string, conversationId: string) => Promise<ConversationHistoryItem>;
  snapshot?: DashboardSnapshot;
  executionHostTransition?: ExecutionHostTransition;
  onSendConversationMessage?: (projectId: string, conversationId: string, content: string) => Promise<SendConversationMessageResult>;
  nativeConversationClient?: NativeConversationAppClient;
  commandClient?: DashboardClient;
  initialNativeConversationChoices?: NativeConversationChoicesSnapshot[];
  initialNativeProjectConversationChoices?: NativeProjectConversationChoicesSnapshot[];
  initialSelectedNativeConversationId?: string;
  onSubscribeRealtimeEvents?: (onEvent: (event: ZeusRealtimeEvent) => void, onConnectionState: (state: ZeusRealtimeConnectionState) => void) => (() => void) | void;
  onChooseProjectDirectory?: () => Promise<string | null>;
  onCreateCurrentProject?: (request: CreateProjectRequest) => Promise<DashboardSnapshot>;
  onLoadProjects?: (query?: string) => Promise<ProjectRecord[]>;
  onLoadProject?: (projectId: string) => Promise<ProjectRecord>;
  onLoadProjectConfig?: (projectId: string) => Promise<ProjectConfig>;
  onSaveProjectConfig?: (projectId: string, input: SaveProjectConfigRequest) => Promise<ProjectConfig>;
  onSaveProjectModelServiceTierPreference?: (projectId: string, input: ProjectModelServiceTierPreference) => Promise<ProjectConfig>;
  onLoadProjectDatabaseSecret?: (projectId: string) => Promise<ProjectDatabaseSecretSnapshot>;
  onSaveProjectDatabasePassword?: (projectId: string, password: string) => Promise<ProjectDatabaseSecretSnapshot>;
  onClearProjectDatabasePassword?: (projectId: string) => Promise<ProjectDatabaseSecretSnapshot>;
  onUpdateProject?: (
    projectId: string,
    input: {
      name: string;
      localPath?: string;
      description?: string | null;
      note?: string | null;
    },
  ) => Promise<DashboardSnapshot>;
  onRevealProjectInFinder?: (projectPath: string) => Promise<{ revealed: boolean; path?: string; error?: string }>;
  onDeleteProject?: (projectId: string) => Promise<DashboardSnapshot>;
  onCreateProjectArchiveConfirmation?: (projectId: string) => Promise<ProjectArchiveConfirmation>;
  onArchiveProject?: (projectId: string) => Promise<DashboardSnapshot>;
  onRestoreProject?: (projectId: string) => Promise<DashboardSnapshot>;
  onLoadArchivedProjects?: () => Promise<ProjectRecord[]>;
  onLoadArchivedTasks?: (projectId: string) => Promise<TaskRecord[]>;
  onSetProjectDefaultTemplate?: (projectId: string, templateId: string | null) => Promise<DashboardSnapshot>;
  onChooseTaskAttachments?: () => Promise<TaskCreateAttachmentCandidate[]>;
  onChooseConversationResources?: () => Promise<NativeConversationAttachment[]>;
  onAuthorizeTaskFiles?: (files: File[], source: 'paste' | 'drop') => Promise<TaskResourceAuthorizationResult>;
  onMaterializeTaskResources?: (resources: TaskResourcePayload[]) => Promise<TaskCreateAttachmentCandidate[]>;
  onReadTaskClipboardResources?: () => Promise<{ resources: TaskCreateAttachmentCandidate[]; text: string }>;
  onParseThirdPartyTaskLink?: (url: string) => Promise<ThirdPartyTaskExtract>;
  onLoadTaskAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenTaskAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
  onCreateTaskDraft?: (projectId: string, draft: TaskCreateDraft, idempotencyKey: string) => Promise<DashboardSnapshot>;
  onLoadTasks?: (projectId: string, query?: string, managementStatus?: TaskManagementStatus, tag?: string, sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'managementStatus') => Promise<TaskRecord[]>;
  onLoadTask?: (taskId: string) => Promise<TaskRecord>;
  onUpdateTask?: (taskId: string, input: UpdateTaskRequest) => Promise<DashboardSnapshot>;
  onUpdateTaskRelationships?: (taskId: string, input: UpdateTaskRelationshipsRequest) => Promise<DashboardSnapshot>;
  onUpdateTaskTags?: (taskId: string, tags: string[], expectedUpdatedAt: string) => Promise<DashboardSnapshot>;
  onDeleteTask?: (taskId: string, input?: DeleteTaskRequest) => Promise<DashboardSnapshot>;
  onRunTask?: (taskId: string) => Promise<TaskRuntimeControlHandlerResult>;
  onPauseTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onContinueTask?: (taskId: string) => Promise<TaskRuntimeControlHandlerResult>;
  onCancelTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onRetryTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onOpenSource?: (source: { projectRoot?: string; sourceRef: string; lineStart?: number }) => Promise<{
    opened: boolean;
    filePath: string | null;
    lineStart?: number | null;
  }>;
  onCreateTaskFromTemplate?: (templateId: string, projectId: string, idempotencyKey: string) => Promise<DashboardSnapshot>;
  onLoadGitDiff?: () => Promise<GitDiffSummary>;
  onExportGitPatch?: () => Promise<GitPatchExport>;
  onExportPatchFile?: (patch: GitPatchExport) => Promise<{ saved: boolean; filePath: string | null }>;
  initialRuntimeStatus?: RuntimeStatusSnapshot;
  onLoadRuntimeStatus?: () => Promise<RuntimeStatusSnapshot>;
  onLoadRuntimeSettings?: () => Promise<RuntimeSettings>;
  onLoadAppShellSettings?: () => Promise<AppShellSettings>;
  onInspectCodexConfigImport?: () => Promise<CodexConfigImportPreview>;
  onImportCodexConfig?: () => Promise<CodexConfigImportResult>;
  onActivateCodexConfig?: () => Promise<CodexConfigActivationResult>;
  onSaveAppShellSettings?: (input: AppShellSettingsSavePayload) => Promise<AppShellSettings>;
  onExportLocalSettings?: () => Promise<LocalSettingsExportSnapshot>;
  onImportLocalSettings?: (input: ImportLocalSettingsRequest) => Promise<ImportLocalSettingsResult>;
  onExportLocalBusinessData?: () => Promise<LocalBusinessDataSnapshot>;
  onImportLocalBusinessData?: (input: LocalBusinessDataSnapshot) => Promise<ImportLocalBusinessDataResult>;
  onExportSettingsFile?: (snapshot: LocalSettingsExportSnapshot) => Promise<{ saved: boolean; filePath: string | null }>;
  onExportBusinessDataFile?: (snapshot: LocalBusinessDataSnapshot) => Promise<{ saved: boolean; filePath: string | null }>;
  onImportSettingsFile?: () => Promise<{
    imported: boolean;
    filePath: string | null;
    snapshot?: LocalSettingsExportSnapshot;
  }>;
  onImportBusinessDataFile?: () => Promise<{
    imported: boolean;
    filePath: string | null;
    snapshot?: LocalBusinessDataSnapshot;
  }>;
  onLoadRuntimeAdapters?: () => Promise<AiRuntimeAdapterDescriptor[]>;
  onCheckRuntimeAdapter?: (adapterId: string) => Promise<AiRuntimeAdapterStatus>;
  onLoadRuntimeSessions?: (input?: LoadRuntimeSessionsRequest) => Promise<AiRuntimeSession[]>;
  onCreateRuntimeConfirmation?: (input: {
    action: 'start_generic_session';
    reason: string;
    session: {
      projectId: string;
      taskId?: string;
      command: string;
      args?: string[];
      cwd?: string;
    };
  }) => Promise<RuntimeOperationConfirmation>;
  onConfirmRuntimeOperation?: (confirmationId: string) => Promise<RuntimeOperationConfirmation>;
  onRejectRuntimeOperation?: (confirmationId: string, reason?: string) => Promise<RuntimeOperationConfirmation>;
  onStartRuntimeSession?: (input: { projectId: string; taskId?: string; command: string; args?: string[]; cwd?: string; confirmationId?: string }) => Promise<AiRuntimeSession>;
  onStopRuntimeSession?: (sessionId: string) => Promise<AiRuntimeSession>;
  onLoadRuntimeSessionLogs?: (sessionId: string) => Promise<AiRuntimeLogEntry[]>;
  onSendRuntimeInput?: (sessionId: string, input: string) => Promise<AiRuntimeSession>;
  onInterruptRuntimeSession?: (sessionId: string) => Promise<AiRuntimeSession>;
  onResizeRuntimeSession?: (sessionId: string, size: { cols: number; rows: number }) => Promise<AiRuntimeSession>;
  onLoadRuntimeTerminalSnapshot?: (sessionId: string) => Promise<AiRuntimeTerminalSnapshot>;
  onLoadRuntimeTerminalEvents?: (sessionId: string, input?: { limit?: number; offset?: number }) => Promise<{ items: AiRuntimeTerminalEvent[] }>;
  onGenerateRuntimeSessionSummary?: (sessionId: string) => Promise<AiRuntimeSession>;
  onSetRuntimeSessionFavorite?: (sessionId: string, favorite: boolean) => Promise<AiRuntimeSession>;
  onArchiveRuntimeSession?: (sessionId: string) => Promise<AiRuntimeSession>;
  onRestoreRuntimeSession?: (sessionId: string) => Promise<AiRuntimeSession>;
  onDeleteRuntimeSession?: (sessionId: string) => Promise<AiRuntimeSession>;
  onCreateTaskFromRuntimeSession?: (sessionId: string, input: { title?: string; instruction?: string }, idempotencyKey: string) => Promise<DashboardSnapshot>;
  onLoadSecuritySecrets?: () => Promise<SecuritySecretsSnapshot>;
  onLoadSecurityAuditLogs?: () => Promise<SecurityAuditLogEntry[]>;
  onLoadReleaseStatus?: () => Promise<ReleaseStatusSnapshot>;
  onLoadReleaseUpdateStatus?: () => Promise<ReleaseUpdateStatusSnapshot>;
  onCheckReleaseUpdate?: () => Promise<ReleaseUpdateStatusSnapshot>;
  onSaveTelegramBotToken?: (token: string) => Promise<SecuritySecretsSnapshot>;
  onClearTelegramBotToken?: () => Promise<SecuritySecretsSnapshot>;
  onSaveExternalApiKey?: (key: string) => Promise<SecuritySecretsSnapshot>;
  onClearExternalApiKey?: () => Promise<SecuritySecretsSnapshot>;
  onResetSecurity?: () => Promise<SecurityResetResult>;
  onLoadTelegramPollingStatus?: () => Promise<TelegramPollingStatus>;
  onLoadTelegramPollingLogs?: () => Promise<TelegramPollingLogEntry[]>;
  onStartTelegramPolling?: () => Promise<TelegramPollingStatus>;
  onStopTelegramPolling?: () => Promise<TelegramPollingStatus>;
  onPollTelegramOnce?: () => Promise<TelegramPollingStatus>;
  onTestTelegramConnection?: () => Promise<TelegramTestConnectionResult>;
  onLoadTelegramNotificationSettings?: () => Promise<TelegramNotificationSettings>;
  onSaveTelegramNotificationSettings?: (input: TelegramNotificationSettings) => Promise<TelegramNotificationSettings>;
  onLoadTelegramSecuritySettings?: () => Promise<TelegramSecuritySettings>;
  onSaveTelegramSecuritySettings?: (input: TelegramSecuritySettings) => Promise<TelegramSecuritySettings>;
  onLoadTaskTemplates?: (projectId?: string) => Promise<TaskTemplateRecord[]>;
  onLoadTaskEvents?: (taskId: string) => Promise<TaskEventRecord[]>;
  onUpdateTaskStatus?: (taskId: string, status: TaskStatus) => Promise<DashboardSnapshot>;
  onUpdateTaskManagementStatus?: (taskId: string, status: TaskManagementStatus, expectedUpdatedAt: string, confirmWorktreeCleanup?: boolean, reopenConversationId?: string) => Promise<DashboardSnapshot>;
  onArchiveTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onRestoreTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onCreateGitConfirmation?: (operation: HighRiskGitOperation, message?: string) => Promise<GitOperationConfirmation>;
  onConfirmGitOperation?: (confirmationId: string) => Promise<GitOperationConfirmation>;
  onRejectGitOperation?: (confirmationId: string, reason?: string) => Promise<GitOperationConfirmation>;
  onExecuteGitOperation?: (input: ExecuteGitOperationRequest) => Promise<ExecutedGitOperationResult>;
  initialTaskEvents?: TaskEventRecord[];
  initialTaskTemplates?: TaskTemplateRecord[];
  initialArchivedProjects?: ProjectRecord[];
  initialArchivedTasks?: TaskRecord[];
  initialRuntimeSessions?: AiRuntimeSession[];
  initialRuntimeLogs?: AiRuntimeLogEntry[];
  initialRuntimeAdapters?: AiRuntimeAdapterDescriptor[];
  initialRuntimeAdapterChecks?: Record<string, AiRuntimeAdapterStatus>;
  initialRuntimeSettings?: RuntimeSettings;
  initialRuntimeGenericShellCommand?: string;
  initialSecuritySecrets?: SecuritySecretsSnapshot;
  initialRuntimeConfirmation?: RuntimeOperationConfirmation;
  initialProjectConfig?: ProjectConfig;
  initialProjectDatabaseSecret?: ProjectDatabaseSecretSnapshot;
  initialAppShellSettings?: AppShellSettings;
  initialReleaseStatus?: ReleaseStatusSnapshot;
  initialReleaseUpdateStatus?: ReleaseUpdateStatusSnapshot;
  initialSecurityAuditLogs?: SecurityAuditLogEntry[];
  initialGitConfirmation?: GitOperationConfirmation;
  initialGitDiff?: GitDiffSummary;
  initialLocalError?: LocalUiErrorSnapshot;
  initialMainNavTarget?: LegacyMainNavTarget;
  shellNavigation?: {
    activeNavTarget: MainNavTarget;
    settingsCategory: SettingsCategory;
    onNavigate: (target: MainNavTarget) => void;
    onSettingsCategoryChange: (category: SettingsCategory) => void;
  };
};
