import type {DashboardClientOptions, LocalBusinessDataSnapshot, LocalSettingsExportSnapshot} from './apiClient.js';
import type {
    ConversationFileLocation,
    ConversationOpenTarget,
    ConversationResourceOpenTarget,
    CreateProjectSourceEntryInput,
    MoveProjectSourceEntryInput,
    ProjectSourceDirectorySnapshot,
    ProjectSourceDocument,
    ProjectSourceEntry,
    ProjectSourceEvent,
    ProjectSourceSearchResult,
    SaveProjectSourceFileInput,
    TrashProjectSourceEntryInput,
    ZentaoTaskExtract,
    ZeusBrowserApprovalDecision,
    ZeusBrowserCommand,
    ZeusBrowserConversationSnapshot,
    ZeusBrowserEvent,
    ZeusBrowserPreparedSubmission,
    ZeusBrowserSettings
} from '@zeus/shared';

type ConversationInputResourceBridge = {
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
  source: 'picker' | 'paste' | 'drop';
  characterCount?: number;
  restorableText?: string;
} & ({ localPath: string; uploadRef?: never } | { localPath?: never; uploadRef: string });

type TaskInputResourceBridge = {
  path: string;
  name: string;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
  mimeType?: string;
  size?: number;
  characterCount?: number;
  previewUrl?: string;
  restorableText?: string;
};

declare global {
  interface Window {
    /** 仅返回当前窗口的无正文、有界性能投影，供隔离 Test 现场提取。 */
    __zeusPerformanceSnapshot?: () => import('./rendererPerformanceObservability.js').RendererPerformanceSnapshot;
    zeus?: {
      appName: 'Zeus';
      getConversationStoreMigrationStatus: () => Promise<{
        phase: 'not_required' | 'preflight' | 'candidate_build' | 'candidate_validation' | 'promotion' | 'promoted_but_validation_failed' | 'completed' | 'failed';
        migrationId: string;
        databasePath: string;
        candidatePath: string | null;
        safeRollbackPath: string | null;
        diagnosticPath: string;
        updatedAt: string;
        error: { message: string; code: string | null } | null;
      } | null>;
      retryConversationStoreMigration: () => Promise<unknown>;
      openConversationStoreMigrationDiagnostics: () => Promise<void>;
      exitConversationStoreMigration: () => Promise<void>;
      getExecutionHostMaintenanceStatus: () => Promise<{
        code: 'ZEUS_EXECUTION_HOST_PROTOCOL_INCOMPATIBLE' | 'ZEUS_EXECUTION_HOST_OWNER_METADATA_CONFLICT' | 'ZEUS_EXECUTION_HOST_OWNER_UNCONFIRMED' | 'ZEUS_EXECUTION_HOST_STARTUP_TIMEOUT';
        currentProtocolVersion: number;
        hostProtocolVersion: number | null;
        hostAppVersion: string | null;
        hostPid: number | null;
        hostGenerationId: string | null;
        stage: string | null;
        detectedAt: string;
        message: string;
      } | null>;
      retryExecutionHostMaintenance: () => Promise<void>;
      exitExecutionHostMaintenance: () => Promise<void>;
        restartAfterStartupFailure: () => Promise<void>;
        exitAfterStartupFailure: () => Promise<void>;
      getLocalServerConfig: () => Promise<DashboardClientOptions>;
      loadSessionViewCache: () => Promise<unknown | null>;
      persistSessionViewCache: (value: import('./session/sessionHotCache.js').PersistedSessionViewCache) => void;
      runStorageRecoveryPreflightAndRestart: () => Promise<{
        faultId: string;
        transactionRolledBack: true;
        quickCheck: 'ok';
        walCheckpoint: 'ok';
        foreignKeyCheck: 'ok';
        commandLedgerCheck: 'ok';
        commandLedgerViolations: 0;
        preparedCommands: number;
        providerWritesAwaitingReconciliation: number;
        recoveryRequiredCommands: number;
        artifactStagingWrite: 'ok';
        artifactFreeSpace: 'ok';
        eligibleForCoreRestart: true;
        coreRestartRequired: true;
        checkedAt: string;
        restartScheduled: true;
      }>;
      openTaskGitDeliveryWindow: (input: { taskId: string; workspaceId?: string | null }) => Promise<{ opened: true; reused: boolean; taskId: string }>;
      closeTaskGitDeliveryWindow: () => Promise<{ closed: true; taskId: string }>;
      getTaskGitDeliveryCurrentContext: () => Promise<{ taskId: string | null; workspaceId: string | null }>;
      notifyTaskGitDeliveryCurrentContext: (context: { taskId: string | null; workspaceId: string | null }) => void;
      notifyTaskGitDeliveryChanged: (taskId: string) => void;
      openTaskGitDeliveryConversation: (input: { taskId: string; conversationId: string }) => Promise<{ opened: true }>;
      openProjectGitDiffWindow: (input: {
        projectId: string;
        repositoryId: string;
        filePath: string;
        stage: 'combined' | 'staged' | 'unstaged';
        commitHash?: string;
        comparisonRef?: string;
        comparisonMode?: 'current' | 'working-tree';
      }) => Promise<{ opened: true }>;
      loadProjectGitWorkbench: (projectId: string) => Promise<import('./apiClient.js').ProjectGitWorkbenchSnapshot>;
      loadProjectGitCommit: (input: { projectId: string; repositoryId: string; commitHash: string }) => Promise<import('./apiClient.js').ProjectGitCommitDetail>;
      loadProjectGitComparisonDiff: (input: { projectId: string; repositoryId: string; ref: string; mode: 'current' | 'working-tree' }) => Promise<import('./apiClient.js').GitDiffSummary>;
      executeProjectGitAction: (input: { projectId: string; repositoryId: string; action: import('./apiClient.js').ProjectGitAction }) => Promise<import('./apiClient.js').ProjectGitActionResponse>;
      onTaskGitDeliveryCurrentContext: (listener: (context: { taskId: string | null; workspaceId: string | null }) => void) => () => void;
      onTaskGitDeliveryAppearance: (listener: (settings: { language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system' }) => void) => () => void;
      onTaskGitDeliveryChanged: (listener: (taskId: string) => void) => () => void;
      onOpenTaskGitDeliveryConversation: (listener: (input: { taskId: string; conversationId: string }) => void) => () => void;
      onOpenConversationNotification: (listener: (input: { projectId: string; conversationId: string }) => void) => () => void;
      getRequestingWindowForeground: () => Promise<{ foreground: boolean }>;
      onRequestingWindowForegroundChanged: (listener: (foreground: boolean) => void) => () => void;
      hideMenuBarUsage: () => Promise<{ hidden: true }>;
      onMenuBarUsageSettingsChanged: (listener: (settings: { language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system' }) => void) => () => void;
      showMainWindowFromMenuBarUsage: () => Promise<{ shown: boolean }>;
      openMenuBarUsageSettings: (category: 'usage' | 'runtime') => Promise<{ opened: boolean; category: 'usage' | 'runtime' }>;
      quitFromMenuBarUsage: () => Promise<{ quitting: true }>;
      listProjectSourceDirectory: (input: { projectId: string; relativePath: string }) => Promise<ProjectSourceDirectorySnapshot>;
      searchProjectSourceEntries: (input: { projectId: string; query: string }) => Promise<ProjectSourceSearchResult>;
      readProjectSourceFile: (input: { projectId: string; relativePath: string }) => Promise<ProjectSourceDocument>;
      saveProjectSourceFile: (input: SaveProjectSourceFileInput) => Promise<ProjectSourceDocument>;
      createProjectSourceEntry: (input: CreateProjectSourceEntryInput) => Promise<ProjectSourceEntry>;
      moveProjectSourceEntry: (input: MoveProjectSourceEntryInput) => Promise<ProjectSourceEntry>;
      trashProjectSourceEntry: (input: TrashProjectSourceEntryInput) => Promise<{ trashed: true; relativePath: string }>;
      revealProjectSourceEntry: (input: { projectId: string; relativePath: string }) => Promise<{ revealed: true; relativePath: string }>;
      openProjectSourceExternally: (input: { projectId: string; relativePath: string }) => Promise<{ opened: true; relativePath: string }>;
      watchProjectSource: (projectId: string) => Promise<{ watching: true; projectId: string }>;
      unwatchProjectSource: () => Promise<{ watching: false }>;
      onProjectSourceEvent: (listener: (event: ProjectSourceEvent) => void) => () => void;
      reportRendererFatalFailure: (message: string) => void;
        reportRendererRuntimeError: (message: string) => void;
      reportRendererBootstrapReady: () => void;
      chooseProjectDirectory: () => Promise<string | null>;
      chooseRecoveryBackupDestinations: () => Promise<{
        cancelled: boolean;
        destinations: Array<{
          grantId: string;
          destinationId: string;
          displayName: string;
        }>;
      }>;
      revealProjectInFinder: (projectPath: string) => Promise<{ revealed: true; path: string }>;
      chooseConversationResources: () => Promise<ConversationInputResourceBridge[]>;
      authorizeConversationFiles: (
        files: File[],
        source: 'paste' | 'drop',
      ) => Promise<{
        resources: ConversationInputResourceBridge[];
        failedCount: number;
      }>;
      materializeConversationResources: (
        resources: Array<{
          name?: string;
          type?: string;
          data?: ArrayBuffer;
          text?: string;
          source?: 'paste' | 'drop';
          kind?: 'image' | 'file' | 'pasted_text';
        }>,
      ) => Promise<ConversationInputResourceBridge[]>;
      readConversationClipboardResources: () => Promise<{ resources: ConversationInputResourceBridge[]; text: string }>;
      getConversationResourcePreview: (resource: { localPath?: string; uploadRef?: string }) => Promise<{ previewUrl: string; mimeType: string } | null>;
      openConversationInputResource: (resource: { localPath?: string; uploadRef?: string }) => Promise<{ opened: boolean; error?: string }>;
      discardConversationResources: (resources: Array<{ localPath?: string; uploadRef?: string }>) => Promise<{ discardedCount: number }>;
      chooseTaskAttachments: () => Promise<TaskInputResourceBridge[]>;
      authorizeTaskFiles: (
        files: File[],
        source: 'paste' | 'drop',
      ) => Promise<{
        resources: TaskInputResourceBridge[];
        failedCount: number;
      }>;
      materializeTaskResources: (
        resources: Array<{
          name?: string;
          type?: string;
          data?: ArrayBuffer;
          text?: string;
          kind?: 'image' | 'file' | 'pasted_text';
        }>,
      ) => Promise<TaskInputResourceBridge[]>;
      readTaskClipboardResources: () => Promise<{ resources: TaskInputResourceBridge[]; text: string }>;
      readTaskClipboardAttachments: () => Promise<Array<{ name: string; type: string; data: ArrayBuffer }>>;
      readTaskClipboardImage: () => Promise<{ name: string; type: 'image/png'; data: ArrayBuffer } | null>;
      writeClipboardText: (text: string) => Promise<{ written: boolean }>;
      saveTaskClipboardAttachments: () => Promise<TaskInputResourceBridge[]>;
      saveTaskPastedAttachments: (
        attachments: Array<{
          name?: string;
          type?: string;
          data?: ArrayBuffer;
          text?: string;
          kind?: 'image' | 'file' | 'pasted_text';
        }>,
      ) => Promise<TaskInputResourceBridge[]>;
      getTaskAttachmentPreview: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
      openTaskAttachment: (path: string) => Promise<{ opened: boolean; error?: string }>;
      parseZentaoTaskLink: (url: string) => Promise<ZentaoTaskExtract>;
      exportSettingsSnapshotToFile: (snapshot: unknown) => Promise<{ saved: boolean; filePath: string | null }>;
      importSettingsSnapshotFromFile: () => Promise<{
        imported: boolean;
        filePath: string | null;
        snapshot?: LocalSettingsExportSnapshot;
      }>;
      importBusinessDataSnapshotFromFile: () => Promise<{
        imported: boolean;
        filePath: string | null;
        snapshot?: LocalBusinessDataSnapshot;
      }>;
      clearNetworkCache: () => Promise<{ cleared: boolean; clearedAt: string }>;
      exportPatchToFile: (patch: unknown) => Promise<{ saved: boolean; filePath: string | null }>;
      openGraphSource: (source: { projectRoot?: string; sourceRef: string; lineStart?: number }) => Promise<{
        opened: boolean;
        filePath: string | null;
        lineStart?: number | null;
      }>;
      openExternalHttpsUrl: (url: string) => Promise<{ opened: boolean; url?: string; error?: string }>;
      activateRequestingWindow: () => Promise<{ activated: boolean; error?: string }>;
      getAutomaticUpdateIndicator: () => Promise<{
        phase: 'idle' | 'available' | 'preparing' | 'retrying' | 'ready' | 'failed';
        currentVersion: string;
        latestVersion: string | null;
        detail: string;
        updatedAt: string;
        progress?: number;
        retryAt?: string;
      } | null>;
      openAutomaticUpdateIndicator: () => Promise<{ opened: boolean }>;
      recordManualUpdateCheck: () => Promise<{ recorded: boolean }>;
      onAutomaticUpdateIndicatorChanged: (
        listener: (state: {
          phase: 'idle' | 'available' | 'preparing' | 'retrying' | 'ready' | 'failed';
          currentVersion: string;
          latestVersion: string | null;
          detail: string;
          updatedAt: string;
          progress?: number;
          retryAt?: string;
        }) => void,
      ) => () => void;
      listConversationResourceOpenTargets: (request: { projectId: string; conversationId: string; resourceId: string }) => Promise<{ resourceId: string; targets: ConversationResourceOpenTarget[] }>;
      openConversationResource: (request: { projectId: string; conversationId: string; resourceId: string; target: ConversationOpenTarget; location?: ConversationFileLocation }) => Promise<{
        opened: boolean;
        resourceId: string;
        target: ConversationOpenTarget;
        mode?: 'zeus_source' | 'zeus_browser' | 'external' | 'file' | 'clipboard';
        error?: string;
      }>;
      openTurnChangeFile: (request: { projectId: string; conversationId: string; turnId: string; changeSetId: string; fileId: string; target: ConversationOpenTarget; location?: ConversationFileLocation }) => Promise<{
        opened: boolean;
        resourceId: string;
        target: ConversationOpenTarget;
        mode?: 'zeus_source' | 'zeus_browser' | 'external' | 'file' | 'clipboard';
        error?: string;
      }>;
      exportMermaidDiagramToFile: (payload: { fileName: string; mimeType: 'text/vnd.mermaid'; content: string }) => Promise<{ saved: boolean; filePath: string | null }>;
      exportPlantUmlDiagramToFile: (payload: { fileName: string; mimeType: 'text/vnd.plantuml'; content: string }) => Promise<{ saved: boolean; filePath: string | null }>;
      notifyAppShellSettingsChanged: (settings: {
        appLanguage: 'zh-CN' | 'en-US';
        appearance: 'light' | 'dark' | 'system';
        webviewDebugEnabled: boolean;
        multiWindowEnabled: boolean;
        backgroundModeEnabled: boolean;
        desktopNotificationsEnabled: boolean;
        openAtLoginEnabled: boolean;
      }) => Promise<{ applied: boolean }>;
      notifyTaskTableLayoutDirty: (dirty: boolean) => void;
      setUnsavedChangeState: (key: string, dirty: boolean) => void;
      notifySensitiveRequestDraft: (payload: { requestId: string; present: boolean }) => void;
      notifySessionContextActivity: (payload: { active: boolean; kind: 'browser' | 'subagents' | 'plan' | 'source' | 'turn_diff' | 'side_chat' | 'none' }) => void;
      notifyAppCloseLayerActivity: (active: boolean) => void;
      resolveTaskTableLayoutCloseRequest: (proceed: boolean) => void;
      resolveUnsavedChangesCloseRequest: (proceed: boolean) => void;
      onTaskTableLayoutCloseRequested: (listener: () => void) => () => void;
      onUnsavedChangesCloseRequested: (listener: () => void) => () => void;
      exportRuntimeLogsToFile: (payload: {
        fileName: string;
        mimeType: 'text/plain';
        sessionId: string;
        sourceFilePath?: string;
        logs: Array<{ createdAt: string; stream: string; text: string }>;
      }) => Promise<{ saved: boolean; filePath: string | null }>;
      beginWindowDrag: (point: { screenX: number; screenY: number }) => Promise<{ dragging: boolean }>;
      moveWindowDrag: (point: { screenX: number; screenY: number }) => Promise<{ dragging: boolean; x?: number; y?: number }>;
      endWindowDrag: () => Promise<{ dragging: false }>;
      onNativeNewConversation: (listener: () => void) => () => void;
      onNativeCloseActiveContextTab: (listener: () => void) => () => void;
      onNativeCloseFrontmostLayer: (listener: () => void) => () => void;
      getBrowserSnapshot: (conversationId: string) => Promise<ZeusBrowserConversationSnapshot>;
      openBrowserTab: (input: { conversationId: string; url?: string }) => Promise<ZeusBrowserConversationSnapshot>;
      activateBrowserTab: (input: { conversationId: string; tabId: string }) => Promise<ZeusBrowserConversationSnapshot>;
      closeBrowserTab: (input: { conversationId: string; tabId: string }) => Promise<ZeusBrowserConversationSnapshot>;
      runBrowserCommand: (input: { conversationId: string; tabId: string; command: ZeusBrowserCommand }) => Promise<ZeusBrowserConversationSnapshot>;
      setBrowserLayout: (input: { conversationId: string; tabId: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }) => Promise<{ applied: boolean }>;
      prepareBrowserComments: (input: { conversationId: string; tabId: string; commentIds?: string[] }) => Promise<ZeusBrowserPreparedSubmission>;
      getBrowserCommentPreview: (path: string) => Promise<{ previewUrl: string; mimeType: 'image/png' } | null>;
      markBrowserCommentsSent: (input: { conversationId: string; tabId: string; commentIds: string[] }) => Promise<ZeusBrowserConversationSnapshot>;
      respondToBrowserApproval: (input: { requestId: string; decision: ZeusBrowserApprovalDecision }) => Promise<{ resolved: boolean }>;
      getBrowserSettings: () => Promise<ZeusBrowserSettings>;
      updateBrowserSettings: (input: Partial<ZeusBrowserSettings>) => Promise<ZeusBrowserSettings>;
      clearBrowserData: () => Promise<{ cleared: boolean }>;
      onBrowserEvent: (listener: (event: ZeusBrowserEvent) => void) => () => void;
    };
  }
}
