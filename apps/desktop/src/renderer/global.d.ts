import type {
  ConversationFileLocation,
  ConversationOpenTarget,
  ConversationResourceOpenTarget,
  CreateProjectSourceEntryInput,
  FilePreviewItem,
  FilePreviewRequest,
  MoveProjectSourceEntryInput,
  NetworkProxyCheckTarget,
  NetworkProxyConnectionResult,
  NetworkProxySettings,
  ProjectSourceContentSearchOptions,
  ProjectSourceContentSearchResult,
  ProjectSourceDirectorySnapshot,
  ProjectSourceDocument,
  ProjectSourceEntry,
  ProjectSourceEvent,
  ProjectSourceSearchResult,
  SaveProjectSourceFileInput,
  ThirdPartyTaskExtract,
  TrashProjectSourceEntryInput,
  UsageModelCostBreakdown,
  UsageModelOutputRateBreakdown,
  ZeusBrowserApprovalDecision,
  ZeusBrowserCommand,
  ZeusBrowserConversationSnapshot,
  ZeusBrowserEvent,
  ZeusBrowserPreparedSubmission,
  ZeusBrowserSettings,
  ZeusComputerControlIdentity,
  ZeusComputerPreview,
  ZeusComputerSettings,
  ZeusRetiredNativeRuntimeState,
} from '@zeus/shared';
import type { GitFileBlame } from '@zeus/git-core';
import type { AutomaticUpdateIndicatorState } from './appShellBridge.js';
import type { DashboardClientOptions, LocalBusinessDataSnapshot, LocalSettingsExportSnapshot } from './apiClient.js';

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

/** 菜单栏主体与独立透明指标窗口之间共享的基础展示数据。 */
type MenuBarUsageDetailBridgeBase = {
  id: string;
  label: string;
  language: 'zh-CN' | 'en-US';
  appearance: 'light' | 'dark' | 'system';
  anchor: { x: number; y: number };
  pinned: boolean;
};

/** 费用或模型速率明细使用可判别联合，Renderer 不猜测条目结构。 */
type MenuBarUsageCostDetailBridgePayload = MenuBarUsageDetailBridgeBase & ({ kind: 'cost'; entries: UsageModelCostBreakdown[]; equivalentCost: boolean } | { kind: 'output-rate'; entries: UsageModelOutputRateBreakdown[] });

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
      /** 启动耗时与主页可交互状态上报。 */
      reportStartupSpan: (input: { stage: string; durationMs: number }) => void;
      reportHomeInteractive: () => void;
      getStartupSettings: () => Promise<import('./features/settings/settingsContracts.js').AppShellSettings | null>;
      getLocalServerConfig: () => Promise<DashboardClientOptions>;
      loadSessionViewCache: (identity: { projectId: string; conversationId: string }) => Promise<unknown | null>;
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
      /** 任务、普通会话与项目提交按钮共用同一原生窗口入口。 */
      openTaskGitDeliveryWindow: (
        input:
          | { taskId: string; workspaceId?: string | null; projectId?: never; conversationId?: never; repositoryId?: never; pathPrefix?: never }
          | { taskId?: never; workspaceId?: never; projectId: string; conversationId: string; repositoryId?: never; pathPrefix?: never }
          | { taskId?: never; workspaceId?: never; projectId: string; conversationId?: never; repositoryId: string; pathPrefix?: string },
      ) => Promise<{ opened: true; reused: boolean; taskId?: string; projectId?: string; conversationId?: string }>;
      /** 所有范围都关闭当前真实交付窗口。 */
      closeTaskGitDeliveryWindow: () => Promise<{ closed: true; taskId?: string; projectId?: string; conversationId?: string }>;
      getTaskGitDeliveryCurrentContext: () => Promise<{ taskId: string | null; workspaceId: string | null }>;
      notifyTaskGitDeliveryCurrentContext: (context: { taskId: string | null; workspaceId: string | null }) => void;
      notifyTaskGitDeliveryChanged: (taskId: string) => void;
      openTaskGitDeliveryConversation: (input: { taskId: string; conversationId: string } | { projectId: string; conversationId: string }) => Promise<{ opened: true }>;
      /** 任务工作区文件在独立窗口中只读查看。 */
      openTaskGitDiffWindow: (input: Extract<import('@zeus/shared').FilePreviewRequest, { kind: 'task-git' }>) => Promise<{ opened: true }>;
      openProjectGitDiffWindow: (input: {
        projectId: string;
        repositoryId: string;
        filePath: string;
        stage: 'combined' | 'staged' | 'unstaged';
        commitHash?: string;
        comparisonRef?: string;
        comparisonMode?: 'current' | 'working-tree';
        /** 已加载的推送补丁；提供时新窗口只展示快照，不重读仓库。 */
        diffText?: string;
      }) => Promise<{ opened: true }>;
      /** 按调用窗口身份读取展示快照，不接受其他窗口或本机路径。 */
      loadProjectGitDiffSnapshot: () => Promise<{ filePath: string; diff: import('./apiClient.js').GitDiffSummary }>;
      loadProjectGitWorkbench: (projectId: string) => Promise<import('./apiClient.js').ProjectGitWorkbenchSnapshot>;
      /** 只读获取当前项目的耐久 Git 操作历史页。 */
      loadProjectGitOperations: (input: { projectId: string; cursor?: string }) => Promise<import('./apiClient.js').ProjectGitOperationPage>;
      loadProjectGitHistory: (input: { projectId: string; repositoryId: string; offset: number; ref?: string }) => Promise<{ commits: import('./apiClient.js').ProjectGitRepositorySnapshot['recentCommits']; hasMore: boolean }>;
      loadProjectGitCommit: (input: { projectId: string; repositoryId: string; commitHash: string }) => Promise<import('./apiClient.js').ProjectGitCommitDetail>;
      /** 按指定远端目标读取待推送范围。 */
      loadProjectGitPushPreview: (input: { projectId: string; repositoryId: string; selection: import('./apiClient.js').ProjectGitPushPreviewInput }) => Promise<import('./apiClient.js').ProjectGitPushPreview>;
      loadProjectGitComparisonDiff: (input: { projectId: string; repositoryId: string; ref: string; mode: 'current' | 'working-tree' }) => Promise<import('./apiClient.js').GitDiffSummary>;
      cancelProjectGitAction: (repositoryId: string) => Promise<{ cancelled: boolean }>;
      executeProjectGitAction: (input: { projectId: string; repositoryId: string; action: import('./apiClient.js').ProjectGitAction }) => Promise<import('./apiClient.js').ProjectGitActionResponse>;
      onTaskGitDeliveryCurrentContext: (listener: (context: { taskId: string | null; workspaceId: string | null }) => void) => () => void;
      onTaskGitDeliveryAppearance: (listener: (settings: { language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system' }) => void) => () => void;
      /** 独立仓库差异窗口沿用应用主题，返回取消订阅函数。 */
      onProjectGitDiffAppearance: (listener: (appearance: 'light' | 'dark' | 'system') => void) => () => void;
      onTaskGitDeliveryChanged: (listener: (taskId: string) => void) => () => void;
      onOpenTaskGitDeliveryConversation: (listener: (input: { taskId: string; conversationId: string }) => void) => () => void;
      /** 系统单条提醒打开任务，汇总提醒打开通知分类。 */
      onOpenTaskNotification?: (listener: (input: { projectId?: string; taskId?: string; reminderId?: string }) => void) => () => void;
      onOpenConversationNotification: (listener: (input: { projectId: string; conversationId: string }) => void) => () => void;
      getRequestingWindowForeground: () => Promise<{ foreground: boolean }>;
      onRequestingWindowForegroundChanged: (listener: (foreground: boolean) => void) => () => void;
      hideMenuBarUsage: () => Promise<{ hidden: true }>;
      /** 菜单栏浮窗仅随内容调整高度，原生宽度保持 360px。 */
      resizeMenuBarUsage: (height: number) => Promise<{ width: number; height: number }>;
      /** 在指定屏幕锚点旁打开或更新独立透明费用明细窗口。 */
      showMenuBarUsageCostDetail: (payload: MenuBarUsageCostDetailBridgePayload) => Promise<{ shown: true }>;
      /** 未固定时延迟关闭费用明细，允许指针跨越原生窗口间距。 */
      scheduleHideMenuBarUsageCostDetail: () => Promise<{ scheduled: true }>;
      /** 指针进入触发器或明细窗口时取消延迟关闭。 */
      cancelHideMenuBarUsageCostDetail: () => Promise<{ cancelled: true }>;
      /** 立即关闭独立费用明细窗口。 */
      hideMenuBarUsageCostDetail: () => Promise<{ hidden: true }>;
      /** 独立费用 Renderer 读取首次展示数据。 */
      getMenuBarUsageCostDetail: () => Promise<MenuBarUsageCostDetailBridgePayload | null>;
      /** 独立费用 Renderer 按真实内容请求原生尺寸和位置。 */
      resizeMenuBarUsageCostDetail: (width: number, height: number) => Promise<{ x: number; y: number; width: number; height: number }>;
      /** 两个相关 Renderer 同步当前明细或关闭状态。 */
      onMenuBarUsageCostDetailChanged: (listener: (payload: MenuBarUsageCostDetailBridgePayload | null) => void) => () => void;
      onMenuBarUsageSettingsChanged: (listener: (settings: { language: 'zh-CN' | 'en-US'; appearance: 'light' | 'dark' | 'system' }) => void) => () => void;
      showMainWindowFromMenuBarUsage: () => Promise<{ shown: boolean }>;
      openMenuBarUsageSettings: (category: 'usage' | 'runtime') => Promise<{ opened: boolean; category: 'usage' | 'runtime' }>;
      quitFromMenuBarUsage: () => Promise<{ quitting: true }>;
      listProjectSourceDirectory: (input: { projectId: string; relativePath: string }) => Promise<ProjectSourceDirectorySnapshot>;
      searchProjectSourceEntries: (input: { projectId: string; query: string }) => Promise<ProjectSourceSearchResult>;
      searchProjectSourceContent: (input: { projectId: string; query: string } & ProjectSourceContentSearchOptions) => Promise<ProjectSourceContentSearchResult>;
      loadProjectSourceBlame: (input: { projectId: string; relativePath: string; ref?: string; expectedSha256?: string }) => Promise<GitFileBlame>;
      loadConversationSourceBlame: (input: { projectId: string; conversationId: string; resourceId: string; expectedSha256: string }) => Promise<GitFileBlame>;

      /** 跨入口共用的受授权文件预览。 */
      loadFilePreview: (input: FilePreviewRequest) => Promise<FilePreviewItem[]>;
      /** 页面关闭和选择变化时撤销短期资源。 */
      releaseFilePreview: (ids: string[]) => Promise<void>;
      /** 用户主动请求系统查看或导出当前预览版本。 */
      actOnFilePreview: (id: string, action: 'quick-look' | 'open' | 'reveal' | 'export' | 'edit') => Promise<void>;
      /** 只恢复两端预览中选中的行区块，并返回更新后的预览授权。 */
      /** 将完整草稿保存到当前授权工作区文件。 */
      saveFilePreview: (input: import('@zeus/shared').FilePreviewSaveInput) => Promise<import('@zeus/shared').FilePreviewItem[]>;
      revertFilePreviewBlock: (input: import('@zeus/shared').FilePreviewRevertInput) => Promise<import('@zeus/shared').FilePreviewItem[]>;
      /** 预览令牌绑定内容和窗口，不接受任意仓库路径。 */
      loadFilePreviewBlame: (id: string) => Promise<GitFileBlame | null>;
      /** 在原生源码页打开主进程校验后的目标，沿用草稿离开保护。 */
      onFilePreviewSourceWorkspaceRequested: (listener: (workspace: import('@zeus/shared').FilePreviewSourceWorkspace) => void) => () => void;
      readProjectSourceFile: (input: { projectId: string; relativePath: string }) => Promise<ProjectSourceDocument>;
      /** 项目内的草稿效果预览与相对资源读取。 */
      prepareProjectSourcePreview: (input: import('@zeus/shared').ProjectSourcePreviewRequest) => Promise<import('@zeus/shared').ProjectSourcePreviewGrant>;
      /** 资源授权绑定当前窗口，不保留已关闭页面。 */
      releaseProjectSourcePreview: (ids: string[]) => Promise<void>;
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
      /** 本机输入建议阶段日志，不包含草稿或回复正文。 */
      reportInputSuggestionDiagnostic: (entry: import('@zeus/shared').InputSuggestionUiDiagnostic) => void;
      reportRendererBootstrapReady: () => void;
      chooseProjectDirectory: () => Promise<string | null>;
      revealProjectInFinder: (projectPath: string) => Promise<{ revealed: true; path: string }>;
      chooseConversationResources: () => Promise<ConversationInputResourceBridge[]>;
      authorizeConversationFiles: (
        files: File[],
        source: 'paste' | 'drop',
      ) => Promise<{
        resources: ConversationInputResourceBridge[];
        failedCount: number;
        /** 部分成功时保留未完成项的具体原因。 */
        failureMessage?: string;
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
      chooseTaskAttachments: () => Promise<TaskInputResourceBridge[]>;
      authorizeTaskFiles: (
        files: File[],
        source: 'paste' | 'drop',
      ) => Promise<{
        resources: TaskInputResourceBridge[];
        failedCount: number;
        /** 部分成功时保留未完成项的具体原因。 */
        failureMessage?: string;
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
      /** 读取第三方任务详情，返回可编辑草稿。 */
      parseThirdPartyTaskLink: (url: string) => Promise<ThirdPartyTaskExtract>;
      /** 在共享登录状态的 Zeus 窗口打开来源页面。 */
      openThirdPartyTaskLogin: (url: string) => Promise<boolean>;
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
      /** 使用当前草稿检查指定的浏览器或模型宿主网络。 */
      checkNetworkProxyConnection: (settings: NetworkProxySettings, address: string, checkTarget: NetworkProxyCheckTarget) => Promise<NetworkProxyConnectionResult>;
      exportPatchToFile: (patch: unknown) => Promise<{ saved: boolean; filePath: string | null }>;
      openSource: (source: { projectRoot?: string; sourceRef: string; lineStart?: number }) => Promise<{
        opened: boolean;
        filePath: string | null;
        lineStart?: number | null;
      }>;
      openExternalHttpsUrl: (url: string) => Promise<{ opened: boolean; url?: string; error?: string }>;
      activateRequestingWindow: () => Promise<{ activated: boolean; error?: string }>;
      /** 更新状态与侧栏共用同一声明，防止手动更新阶段在桥接层遗漏。 */
      getAutomaticUpdateIndicator: () => Promise<AutomaticUpdateIndicatorState | null>;
      openAutomaticUpdateIndicator: () => Promise<{ opened: boolean }>;
      recordManualUpdateCheck: () => Promise<{ recorded: boolean }>;
      onAutomaticUpdateIndicatorChanged: (listener: (state: AutomaticUpdateIndicatorState) => void) => () => void;
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
      /** 终端焦点不覆盖右侧工作面的独立归属。 */
      notifyTerminalActivity: (active: boolean) => void;
      notifySessionContextActivity: (payload: { active: boolean; kind: 'browser' | 'subagents' | 'plan' | 'source' | 'turn_diff' | 'question' | 'none'; ownerConversationId?: string }) => void;
      notifyAppCloseLayerActivity: (active: boolean) => void;
      /** 管理由当前工作区创建的系统窗口。 */
      updateSystemWindow: (name: string, action: 'show' | 'close') => Promise<void>;
      /** 系统窗口关闭回调仍遵守表单的忙碌保护。 */
      onSystemWindowCloseRequest: (listener: (name: string) => void) => () => void;
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
      /** 原生关闭快捷键仅交给获得焦点的终端。 */
      onNativeCloseActiveTerminalTab: (listener: () => void) => () => void;
      onNativeCloseActiveContextTab: (listener: (ownerConversationId?: string) => void) => () => void;
      onNativeCloseFrontmostLayer: (listener: () => void) => () => void;
      /** 系统菜单保持原生网页可见，并返回选择或取消。 */
      /** 系统菜单绑定当前会话和标签，原生网页保持可见。 */
      showBrowserMenu: (input: {
        x: number;
        y: number;
        conversationId: string;
        tabId: string;
        language: 'zh-CN' | 'en-US';
        canSplit: boolean;
        expanded: boolean;
      }) => Promise<
        'new_tab' | 'close_tab' | 'close_other_tabs' | 'back' | 'forward' | 'reload' | 'stop' | 'find' | 'copy_url' | 'open_external' | 'zoom_in' | 'zoom_out' | 'zoom_reset' | 'devtools' | 'toggle_expanded' | 'reset_size' | 'close' | null
      >;
      getBrowserSnapshot: (conversationId: string) => Promise<ZeusBrowserConversationSnapshot>;
      openBrowserTab: (input: { conversationId: string; url?: string }) => Promise<ZeusBrowserConversationSnapshot>;
      /** 首发受理后迁移草稿网页，仅将本次提交的批注标记为已发送。 */
      adoptBrowserDraft: (input: { sourceConversationId: string; conversationId: string; commentIds: string[] }) => Promise<ZeusBrowserConversationSnapshot>;
      activateBrowserTab: (input: { conversationId: string; tabId: string }) => Promise<ZeusBrowserConversationSnapshot>;
      closeBrowserTab: (input: { conversationId: string; tabId: string }) => Promise<ZeusBrowserConversationSnapshot>;
      /** 关闭当前会话全部标签，返回清理后的权威状态。 */
      closeBrowserConversation: (conversationId: string) => Promise<ZeusBrowserConversationSnapshot>;
      runBrowserCommand: (input: { conversationId: string; tabId: string; command: ZeusBrowserCommand }) => Promise<ZeusBrowserConversationSnapshot>;
      setBrowserLayout: (input: { conversationId: string; tabId: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }) => Promise<{ applied: boolean }>;
      prepareBrowserComments: (input: { conversationId: string; tabId: string; commentIds?: string[] }) => Promise<ZeusBrowserPreparedSubmission>;
      getBrowserCommentPreview: (path: string) => Promise<{ previewUrl: string; mimeType: 'image/png' } | null>;
      markBrowserCommentsSent: (input: { conversationId: string; tabId: string; commentIds: string[] }) => Promise<ZeusBrowserConversationSnapshot>;
      respondToBrowserApproval: (input: { requestId: string; decision: ZeusBrowserApprovalDecision }) => Promise<{ resolved: boolean }>;
      getBrowserSettings: () => Promise<ZeusBrowserSettings>;
      updateBrowserSettings: (input: Partial<ZeusBrowserSettings>) => Promise<ZeusBrowserSettings>;
      clearBrowserData: () => Promise<{ cleared: boolean }>;
      getRetiredNativeRuntimeState: () => Promise<ZeusRetiredNativeRuntimeState>;
      archiveRetiredNativeRuntimes: () => Promise<ZeusRetiredNativeRuntimeState>;
      restoreRetiredNativeRuntimes: () => Promise<ZeusRetiredNativeRuntimeState>;
      getComputerSettings: () => Promise<ZeusComputerSettings>;
      /** 仅返回该会话正在进行的控制预览。 */
      getComputerPreview: (conversationId: string, imageId?: string | null) => Promise<ZeusComputerPreview | null>;
      /** 订阅轻量变化通知，离开会话时取消监听。 */
      onComputerPreviewChanged: (listener: (conversationId: string) => void) => () => void;
      updateComputerSettings: (input: Pick<ZeusComputerSettings, 'enabled'>) => Promise<ZeusComputerSettings>;
      requestComputerPermissions: () => Promise<ZeusComputerSettings>;
      openComputerPermissionSettings: (input: { permission: 'accessibility' | 'screen_capture' }) => Promise<{ opened: true; permission: 'accessibility' | 'screen_capture' }>;
      /** 会话内停止须携带控制身份；无参数为设置页全局停止。 */
      stopComputerUse: (input?: ZeusComputerControlIdentity) => Promise<ZeusComputerSettings>;
      onBrowserEvent: (listener: (event: ZeusBrowserEvent) => void) => () => void;
    };
  }
}
