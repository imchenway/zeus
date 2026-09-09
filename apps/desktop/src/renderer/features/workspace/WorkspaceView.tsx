import { RuntimeSettingsPane } from '../../settings/RuntimeSettingsPane.js';
import { SettingsSaveStatus, useSettingsAutosave, type SettingsSaveState } from '../../settings/useSettingsAutosave.js';
import type { UpdateAppShellSettingsRequest } from '../settings/settingsContracts.js';
import { RuntimeXtermPane } from '../runtime/RuntimeXtermPane.js';
import { handleInlineRailKeyboardNavigation } from './workspaceSupport.js';
import { useModelSetup, ModelSetupDialog, CodexAccountSettings, type TaskModelSetupContext } from '../../settings/ModelSetup.js';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { useId, useMemo, useState } from 'react';
import type { DashboardClient, ProjectRecord } from '../../apiClient.js';
import { openAutomaticUpdateIndicatorInMain } from '../../appShellBridge.js';
import { ProjectGitWorkbench } from '../../git/ProjectGitWorkbench.js';
import { conversationDisplayTitle } from '../../session/conversationDisplayTitle.js';
import { TaskGitReviewModal } from '../../task/TaskGitReviewModal.js';
import { persistPendingConflictAiStart, TaskGitMergeModal } from '../../task/TaskGitMergeModal.js';
import { TaskModelPushModal, writeTaskModelPushPreferences } from '../../task/TaskModelPushModal.js';
import { TaskWorkspace } from '../../task/TaskWorkspace.js';
import { LegacyChatImportSettings } from '../../settings/LegacyChatImportSettings.js';
import { CodexConfigImportSettings } from '../../settings/CodexConfigImportSettings.js';
import { BrowserSettingsPane } from '../../settings/BrowserSettingsPane.js';
import { GeneralSettingsPane } from '../../settings/GeneralSettingsPane.js';
import { SettingsPagination, settingsPage, settingsPageSize } from '../../settings/SettingsPagination.js';
import { CodexRemoteControlSettings } from '../../settings/CodexRemoteControlSettings.js';
import { ModelConnectionsSettingsPane } from '../../settings/ModelConnectionsSettingsPane.js';
import { ZentaoSettingsPane } from '../../settings/ZentaoSettingsPane.js';
import { TaskManagementStatusEditor } from '../../settings/TaskManagementStatusEditor.js';
import { CodexUsageSettingsPane } from '../../settings/CodexUsageSettingsPane.js';
import { MemorySettingsPane } from '../memory/MemorySettingsPane.js';
import { DigitalEmployeeTemplatesSettings } from '../digital-employees/DigitalEmployeeTemplatesSettings.js';
import { ImRobotSettingsPane } from '../telegram/ImRobotSettingsPane.js';
import { ProjectDigitalEmployeesPanel } from '../digital-employees/ProjectDigitalEmployeesPanel.js';
import { ProjectModelsSettings } from '../../settings/ProjectModelsSettings.js';
import { ExtensionsWorkspace } from '../skills/ExtensionsWorkspace.js';
import { AutomationsWorkspace } from '../automations/AutomationsWorkspace.js';
import { defaultTaskTableEnumSortOrders, normalizeTaskTableEnumSortOrders } from '../../task/taskWorkspaceModel.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { taskAgentRunStatusLabels } from '../../task/TaskRunStatusChip.js';
import { WorkspaceDrawer } from '../../ui/WorkspaceDrawer.js';
import { CommandCenterPanel } from '../../CommandCenterPanel.js';
import { ProjectSourceWorkspace } from '../../code/ProjectSourceWorkspace.js';
import { formatRuntimeAdapterDetectionFacts, InlineRecoveryPrompt, ProjectCreateDialog, ProjectStartGuide, ProjectWorkspaceModeToolbar, SidebarNav } from './WorkspaceChrome.js';
import { GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE } from './workspaceFormatters.js';
import {
  browserNativeConversationStartStorage,
  controlBusyProps,
  executionHostSupportsConversationSource,
  formatArchivedConversationDate,
  formatConfiguredTaskManagementStatus,
  formatReleaseArtifactKind,
  formatReleaseAutoUpdateLabel,
  formatReleasePresenceStatus,
  formatReleaseUpdateChannel,
  formatReleaseUpdateLabel,
  formatReleaseUpdateReason,
  formatReleaseWaitingForItems,
  formatRuntimeSessionStatus,
  formatRuntimeAdapterDisplayName,
  type NativeConversationAppClient,
  NativeSettingsPane,
  PROJECT_SIDEBAR_MIN_WIDTH,
  ProjectArchiveWorkbench,
  type SettingsCategory,
  TaskCreateModal,
  TaskDeleteRelationshipDialog,
  TaskEnumOrderEditor,
  taskHierarchyDepth,
  TaskTableLayoutDecisionDialog,
  TaskTerminalCleanupDialog,
  isTaskModelPushOriginCurrent,
} from './workspaceSupport.js';
import type { WorkspaceQueryState } from './useWorkspaceQueryState.js';
import type { WorkspaceDomainActions } from './useWorkspaceDomainActions.js';
import type { WorkspaceOperations } from './useWorkspaceOperations.js';

/** 项目设置只保留两个同级入口，避免把两块长内容纵向拼成一个页面。 */
type ProjectSettingsSection = 'employees' | 'models';

/** 项目设置页在离开页面或切换项目时重新挂载，因此默认入口始终是数字员工。 */
function ProjectSettingsWorkspace(props: { project: ProjectRecord; commandClient: DashboardClient | null; conversationClient: NativeConversationAppClient | null; language: 'zh-CN' | 'en-US' }) {
  const zh = props.language === 'zh-CN';
  const [section, setSection] = useState<ProjectSettingsSection>('employees');
  const sectionId = useId();
  const employeesTabId = `${sectionId}-employees-tab`;
  const employeesPanelId = `${sectionId}-employees-panel`;
  const modelsTabId = `${sectionId}-models-tab`;
  const modelsPanelId = `${sectionId}-models-panel`;

  return (
    <div className="project-settings-shell">
      <header className="project-settings-page-heading">
        <span className="project-settings-page-title">
          <h1>{zh ? '项目设置' : 'Project settings'}</h1>
          <p>{props.project.name}</p>
        </span>
        <nav className="project-settings-section-tabs" aria-label={zh ? '项目设置分类' : 'Project settings sections'} role="tablist" data-inline-rail-keyboard="horizontal" onKeyDown={handleInlineRailKeyboardNavigation}>
          <button
            id={employeesTabId}
            type="button"
            role="tab"
            aria-selected={section === 'employees'}
            aria-controls={employeesPanelId}
            tabIndex={section === 'employees' ? 0 : -1}
            data-inline-rail-item="true"
            onClick={() => setSection('employees')}
          >
            {zh ? '数字员工' : 'Digital employees'}
          </button>
          <button id={modelsTabId} type="button" role="tab" aria-selected={section === 'models'} aria-controls={modelsPanelId} tabIndex={section === 'models' ? 0 : -1} data-inline-rail-item="true" onClick={() => setSection('models')}>
            {zh ? '可用模型' : 'Available models'}
          </button>
        </nav>
      </header>

      <section id={employeesPanelId} className="project-settings-panel" role="tabpanel" aria-labelledby={employeesTabId} hidden={section !== 'employees'}>
        <ProjectDigitalEmployeesPanel projectId={props.project.id} projectName={props.project.name} client={props.commandClient} skillClient={props.conversationClient} language={props.language} />
      </section>
      <section id={modelsPanelId} className="project-settings-panel" role="tabpanel" aria-labelledby={modelsTabId} hidden={section !== 'models'}>
        <ProjectModelsSettings projectId={props.project.id} client={props.commandClient} language={props.language} />
      </section>
    </div>
  );
}

export function WorkspaceView(input: { state: WorkspaceQueryState; domainActions: WorkspaceDomainActions; operations: WorkspaceOperations }) {
  const [settingsSearchQuery, setSettingsSearchQuery] = useState('');
  /** 一次编辑一个字段，新增字段无需继续拉长页面。 */
  const [taskField, setTaskField] = useState<'status' | 'priority' | 'runStatus'>('status');
  const { state, domainActions, operations } = input;
  const {
    actionState,
    activeNavTarget,
    activeProjectId,
    activeProjectSection,
    activeTaskManagementStatusConfig,
    activeTaskManagementStatusLabels,
    activeTaskTableColumns,
    appShellSettings,
    archivedConversationLoadState,
    archivedConversations,
    archivedProjects,
    automaticUpdateIndicator,
    codeWorkspaceCopy,
    codexConfigImportError,
    codexConfigImportLoading,
    codexConfigImportPreview,
    codexConfigImportResult,
    codexLegacyImportBusy,
    codexLegacyImportError,
    codexLegacyImportLoading,
    codexLegacyImportSnapshot,
    codexUsageRevision,
    conversationDrawer,
    creatingProjectBusy,
    creatingTaskBusy,
    currentProjectTasks,
    currentTaskConversationChoices,
    dataPortabilityStatusCopy,
    genericShellCriticalConfirmed,
    genericShellRisk,
    gitDiffCopy,
    loadTaskBoard,
    loadingDiffBusy,
    loadingRuntimeBusy,
    loadingTemplatesBusy,
    localizedGenericShellRisk,
    nativeConversationGroups,
    nativeConversationRuntimeStates,
    nativeConversationStatusSyncState,
    nativeConversationTaskRunStatuses,
    orderedProjects,
    pendingProjectDeleteId,
    projectCodeWorkspaceMode,
    projectCreateDialogOpen,
    projectCreateError,
    projectCreateForm,
    projectCreationReady,
    projectDetail,
    projectDirectoryChoosing,
    projectPanel,
    projectSidebarResizing,
    projectSourceWorkspaceRef,
    projectedRuntimeLogOutput,
    props,
    releaseStatus,
    releaseLoadState,
    setReleaseLoadRevision,
    releaseUpdateBusy,
    releaseUpdateCheckState,
    releaseUpdateStatus,
    restoringArchivedConversationId,
    runtime,
    runtimeAdapterChecks,
    runtimeAdapters,
    runtimeConfirmation,
    runtimeConfirmationStatusCopy,
    runtimeFavoriteOnly,
    runtimeGenericShellCommand,
    runtimeGenericShellCriticalConfirmation,
    runtimeInput,
    runtimeLogCopyStatusCopy,
    runtimeLogExportStatusCopy,
    runtimeLogSearchQuery,
    runtimeLogs,
    runtimeLogsCollapsed,
    runtimeSearchQuery,
    runtimeSessions,
    runtimeSettings,
    runtimeShowArchived,
    runtimeStatus,
    secondaryDrawerCopy,
    selectedNativeConversation,
    selectedNativeConversationId,
    selectedProject,
    selectedTaskIds,
    sessionWorkspaceCopy,
    setAppShellSettings,
    setConversationDrawer,
    setPendingProjectDeleteId,
    setProjectCreateError,
    setProjectCreateForm,
    setProjectPanel,
    setRuntimeConfirmation,
    setRuntimeConfirmationCommand,
    setRuntimeConfirmationStatus,
    setRuntimeFavoriteOnly,
    setRuntimeGenericShellCommand,
    setRuntimeGenericShellCriticalConfirmation,
    setRuntimeInput,
    setRuntimeLogSearchQuery,
    setRuntimeLogsCollapsed,
    setRuntimeSearchQuery,
    setRuntimeSettings,
    setRuntimeShowArchived,
    setSettingsCategory,
    setSourceWorkspaceDirty,
    setTaskConversationDrawerTarget,
    setTaskCreateForm,
    setTaskDeleteDialogTaskId,
    setTaskEvents,
    setTaskGitMergeTaskId,
    setTaskModelPushForm,
    setTaskSearchQuery,
    setTaskStatusSettingsTargetId,
    setTaskTableLayoutDraft,
    setTaskTableLayoutScopeDialogOpen,
    setTaskTagFilter,
    settingsCategory,
    settingsWorkspaceCopy,
    snapshot,
    sourceWorkspaceLeaveDialogOpen,
    sourceWorkspaceSaveBusy,
    storageRecoveryFault,
    taskBoardLoadState,
    taskBoardSnapshots,
    taskBulkActionStatus,
    taskConversationDrawerReady,
    taskConversationDrawerTarget,
    taskCreateError,
    taskCreateForm,
    taskCreateModalOpen,
    taskCreateTitleInputRef,
    taskDeleteDialogTaskId,
    taskDetailPaneTaskId,
    taskDetailPresentation,
    taskGitDeliveryRevision,
    taskGitDeliveryChangedRef,
    taskGitMergeTaskId,
    taskGitReviewState,
    taskModelPushAnnouncement,
    taskModelPushCapabilities,
    taskModelPushError,
    taskModelPushEntry,
    taskModelPushForm,
    taskModelPushRefreshingRepositoryId,
    taskModelPushRuntimeCapabilities,
    taskModelPushServiceTierPreferences,
    taskModelPushStatus,
    taskModelPushTaskId,
    taskPageViewMode,
    taskSearchQuery,
    taskStatusFilter,
    taskStatusFilterValues,
    taskTableLayoutDirty,
    taskTableLayoutLeaveDialogOpen,
    taskTableLayoutSaveBusy,
    taskTableLayoutScopeDialogOpen,
    taskTagFilter,
    taskTemplates,
    taskTerminalCleanupConfirmation,
    taskWorkspaceCopy,
    uiCopy,
    updatingTaskBusy,
    visibleTasks,
    visitedCodeWorkspaceModes,
    workspaceScrollRef,
  } = state;
  const {
    addTaskCreateAttachments,
    applyThirdPartyTaskExtract,
    archiveConversation,
    authorizeTaskCreateFiles,
    changedFiles,
    chooseProjectDirectoryForCreate,
    closeProjectCreateDialog,
    closeTaskCreateModal,
    closeTaskGitReview,
    closeTaskModelPush,
    createCurrentProject,
    deleteProject,
    effectiveTaskStatusSettingsTargetId,
    materializeTaskCreateResources,
    openProjectCreateDialog,
    openTaskConflictAiConversation,
    openTaskConversationDrawer,
    openTaskCreateModal,
    openTaskDetailPane,
    openThirdPartyLinkInBrowser,
    persistCodeWorkspacePreference,
    prepareNewConversationDraft,
    readTaskCreateClipboardResources,
    refreshArchivedConversations,
    refreshArchivedProjects,
    refreshNativeConversationChoices,
    refreshTaskModelPushRepository,
    removeTaskCreateAttachment,
    renameProjectDisplayName,
    resolveTaskTerminalCleanupConfirmation,
    restoreProject,
    restoreTaskConversation,
    runStorageRecoveryPreflightAndRestart,
    revealProjectInFinder,
    selectNativeConversation,
    submitTaskCreateModal,
    submitTaskModelPush,
    taskDetailPaneTask,
    taskPriorityLabels,
    taskStatusSettingsConfig,
    taskStatusSettingsUsageCounts,
    taskTableEnumSortOrders,
    updateTaskContent,
    updateTaskCreateForm,
    updateTaskCreatePriority,
    updateTaskCreateType,
    updateTaskManagementStatus,
  } = domainActions;
  const {
    activateCodexConfig,
    archiveRuntimeSession,
    beginSaveTaskTableLayoutAndLeave,
    cancelSourceWorkspaceLeave,
    cancelTaskTableLayoutLeave,
    cancelTaskTableLayoutScopeDialog,
    checkReleaseUpdate,
    checkRuntimeAdapter,
    clearNetworkCache,
    clearTaskSelection,
    closeTaskDetail,
    confirmAndStartGenericRuntime,
    copyRuntimeLogs,
    createGenericRuntimeConfirmation,
    createTaskFromRuntimeSession,
    createTaskFromTemplate,
    deleteRuntimeSession,
    deleteTaskWithRelationshipStrategy,
    discardSourceWorkspaceAndLeave,
    discardTaskTableLayoutAndLeave,
    exportLocalSettings,
    exportRuntimeLogs,
    generateRuntimeSessionSummary,
    handleMainNavigate,
    handleProjectSidebarResizeKeyDown,
    handleProjectSidebarResizePointerDown,
    handleWindowDragPointerDown,
    importCodexConfig,
    importLocalSettings,
    interruptRuntimeSession,
    loadGitDiff,
    loadRuntimeStatus,
    loadRuntimeTerminalSnapshot,
    loadTaskTemplates,
    moveTaskBoardTask,
    openProjectSection,
    projectDrawerVisualProps,
    projectSidebarMaximumWidth,
    projectSidebarShellStyle,
    projectSidebarWidth,
    refreshCodexConfigImport,
    refreshCodexLegacyImports,
    refreshRuntimeSessions,
    rejectGenericRuntimeConfirmation,
    renderNativeConversationWorkspace,
    renderTaskDetailPaneContent,
    repositoryPickerLabel,
    resetProjectSidebarWidth,
    resizeRuntimeSession,
    restoreRuntimeSession,
    runBulkTaskDelete,
    runBulkTaskStatusChange,
    saveSourceWorkspaceAndLeave,
    saveTaskPageViewMode,
    saveTaskStatusFilter,
    saveTaskTableLayout,
    sendRuntimeInput,
    setRuntimeSessionFavorite,
    startCodexLegacyImport,
    startRuntimeSession,
    stopRuntimeSession,
    toggleAllVisibleTaskSelection,
    toggleCollapsedProject,
    togglePinnedProject,
    toggleSidebarConversationOrganization,
    toggleSidebarConversationStatusGroup,
    toggleTaskSelection,
    updateTaskBoardSettings,
    workspaceDrawerPortalStyle,
  } = operations;
  /** 任务详情也可从会话页打开；接入上下文仍由原工作面身份约束，关闭或切换后旧回执失效。 */
  const modelSetupTask = snapshot.tasks.find((task) => task.id === taskModelPushTaskId);
  const taskModelSetupContext: TaskModelSetupContext | undefined =
    modelSetupTask &&
    (activeNavTarget === 'projects' || activeNavTarget === 'conversations') &&
    modelSetupTask.projectId === activeProjectId &&
    (!state.taskModelPushEntryRef.current || isTaskModelPushOriginCurrent(state.taskModelPushEntryRef.current.origin, state.taskModelPushNavigationRef.current))
      ? {
          projectId: modelSetupTask.projectId,
          taskId: modelSetupTask.id,
          label: `${snapshot.projects.find((project) => project.id === modelSetupTask.projectId)?.name ?? ''} · ${modelSetupTask.title}`,
          entry: taskModelPushEntry === 'confirmation' ? 'from_confirmation' : 'before_confirmation',
          onCancel: taskModelPushEntry === 'confirmation' ? () => undefined : domainActions.closeTaskModelPush,
          onComplete: domainActions.refreshTaskModelPushModels,
        }
      : undefined;
  /** 接入弹窗留在确认页上方，原表单继续持有输入与附件。 */
  const modelSetup = useModelSetup({
    client: props.nativeConversationClient ?? null,
    settings: appShellSettings,
    onSettingsSaved: state.setAppShellSettings,
    taskContext: taskModelSetupContext,
    requestedTaskStep: taskModelPushEntry === 'choose' || taskModelPushEntry === 'custom' ? taskModelPushEntry : undefined,
  });
  /** 侧栏选项与当前详情相互关联，键盘和读屏均可定位内容。 */
  const settingsPanelId = useId();
  /** 归档筛选只作用于当前列表，不修改任何会话。 */
  const [archiveQuery, setArchiveQuery] = useState('');
  /** 任务字段的写入状态；仅提交该页拥有的偏好。 */
  const taskAutosave = useSettingsAutosave(appShellSettings.appLanguage);
  /** 两个复合页共享各自页面标题处的保存反馈。 */
  const [runtimeSaveState, setRuntimeSaveState] = useState<SettingsSaveState>('idle');
  const [modelSaveState, setModelSaveState] = useState<SettingsSaveState>('idle');
  /** 删除状态的替换关系随失败草稿保留，成功后才清除。 */
  function saveTaskFields(patch: Pick<UpdateAppShellSettingsRequest, 'taskTableEnumSortOrders' | 'taskManagementStatusTemplate' | 'taskManagementStatusByProject' | 'taskManagementStatusReplacements'>): void {
    setAppShellSettings((current) => ({ ...current, ...patch }));
    /** 客户端串行保存，避免与通用设置互相覆盖。 */
    const client = props.nativeConversationClient?.settings;
    if (!client) return;
    void taskAutosave.save(async () => {
      await client.saveAppShellSettings({ ...patch, taskManagementStatusReplacements: patch.taskManagementStatusReplacements ?? state.taskManagementStatusReplacements });
      state.setTaskManagementStatusReplacements({});
    });
  }
  /** 项目快速筛选与文字搜索同时生效。 */
  const [archiveProjectId, setArchiveProjectId] = useState('');
  /** 分页状态随列表缩短自动夹紧。 */
  const [archiveRequestedPage, setArchiveRequestedPage] = useState(1);
  /** 列表变化时一次关联项目和任务，搜索时不再逐条扫描全部任务。 */
  const archiveItems = useMemo(() => {
    /** 任务编号和标题来自当前任务记录。 */
    const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
    /** 项目名称来自当前项目记录。 */
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    return archivedConversations.map((conversation) => ({ conversation, task: tasks.get(conversation.taskId ?? ''), project: projects.get(conversation.projectId) }));
  }, [archivedConversations, snapshot.tasks, snapshot.projects]);
  /** 标题、项目与任务编号使用相同的检索词。 */
  const normalizedArchiveQuery = archiveQuery.trim().toLocaleLowerCase();
  /** 空检索直接复用列表，不额外生成数组。 */
  const filteredArchives = archiveItems.filter(
    ({ conversation, task, project }) =>
      (!archiveProjectId || conversation.projectId === archiveProjectId) &&
      (!normalizedArchiveQuery || `${conversation.title} ${task?.title ?? ''} ${task?.taskCode ?? ''} ${project?.name ?? ''}`.toLocaleLowerCase().includes(normalizedArchiveQuery)),
  );
  /** 当前展示页始终对应有效记录范围。 */
  const archivePage = settingsPage(filteredArchives.length, archiveRequestedPage);
  const normalizedSettingsQuery = settingsSearchQuery.trim().toLocaleLowerCase();
  const settingsGroups = [
    {
      group: settingsWorkspaceCopy.sectionGroups.personal,
      items: [
        ['general', settingsWorkspaceCopy.categories.general, undefined],
        ['usage', settingsWorkspaceCopy.categories.usage, undefined],
        ['memory', settingsWorkspaceCopy.categories.memory, settingsWorkspaceCopy.localStatus],
        ['tasks', settingsWorkspaceCopy.categories.tasks, undefined],
        ['employees', settingsWorkspaceCopy.categories.employees, settingsWorkspaceCopy.localStatus],
      ],
    },
    {
      group: settingsWorkspaceCopy.sectionGroups.integrations,
      items: [
        ['runtime', settingsWorkspaceCopy.categories.runtime, runtime.aiCli.available ? settingsWorkspaceCopy.protectedStatus : settingsWorkspaceCopy.waitingStatus],
        ['models', settingsWorkspaceCopy.categories.models, settingsWorkspaceCopy.localStatus],
        ['browser', settingsWorkspaceCopy.categories.browser, settingsWorkspaceCopy.localStatus],
        // IM 接入名称同时用于侧栏展示与设置搜索。
        ['im', appShellSettings.appLanguage === 'zh-CN' ? 'IM 接入' : 'IM Integrations', runtime.telegram.enabled ? settingsWorkspaceCopy.protectedStatus : settingsWorkspaceCopy.waitingStatus],
        ['zentao', settingsWorkspaceCopy.categories.zentao, settingsWorkspaceCopy.localStatus],
      ],
    },
    {
      group: settingsWorkspaceCopy.sectionGroups.coding,
      items: [['commands', settingsWorkspaceCopy.categories.commands, settingsWorkspaceCopy.localStatus]],
    },
    {
      group: settingsWorkspaceCopy.sectionGroups.maintenance,
      items: [
        ['release', settingsWorkspaceCopy.categories.release, settingsWorkspaceCopy.waitingStatus],
        ['data', settingsWorkspaceCopy.categories.data, settingsWorkspaceCopy.localStatus],
      ],
    },
  ] as Array<{ group: string; items: Array<[SettingsCategory, string, string | undefined]> }>;
  const visibleSettingsGroups = settingsGroups
    .map((group) => ({
      ...group,
      items: group.items.filter(([id, label]) => `${group.group} ${label} ${id}`.toLocaleLowerCase().includes(normalizedSettingsQuery)),
    }))
    .filter((group) => group.items.length > 0);
  const visibleSettingsItems = visibleSettingsGroups.flatMap((group) => group.items);
  const settingsNavigationTabStop = visibleSettingsItems.some(([id]) => id === settingsCategory) ? settingsCategory : visibleSettingsItems[0]?.[0];

  return (
    <main
      className={`zeus-shell ai-native-shell macos-ai-app codex-thread-workbench workspace-product-shell theme-${appShellSettings.appearance}${activeNavTarget === 'settings' ? ' settings-dedicated-shell' : ''}${activeNavTarget === 'skills' ? ' skills-dedicated-shell' : ''}${activeNavTarget === 'automations' ? ' automations-dedicated-shell' : ''}${activeProjectSection === 'sessions' && activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && activeNavTarget !== 'automations' ? ' session-codex-parity-v1' : ''}`}
      data-theme={appShellSettings.appearance}
      data-language={appShellSettings.appLanguage}
      data-project-sidebar-resizing={projectSidebarResizing ? 'true' : 'false'}
      style={projectSidebarShellStyle}
      lang={uiCopy.documentLang}
      aria-label={uiCopy.shellAriaLabel}
    >
      <ModelSetupDialog controller={modelSetup} />
      <div className="window-drag-strip" aria-hidden="true" onPointerDown={handleWindowDragPointerDown} />
      <output className="sr-only" aria-live="polite" aria-atomic="true">
        {taskModelPushAnnouncement}
      </output>
      {nativeConversationStatusSyncState !== 'connected' ? (
        <output className="conversation-status-sync-indicator" data-state={nativeConversationStatusSyncState} role="status" aria-live="polite" aria-atomic="true">
          {nativeConversationStatusSyncState === 'stale' ? null : <span className="conversation-status-sync-spinner" aria-hidden="true" />}
          <span>
            {nativeConversationStatusSyncState === 'stale'
              ? appShellSettings.appLanguage === 'zh-CN'
                ? '会话状态暂未同步，正在后台重试'
                : 'Conversation status is unavailable; retrying in the background'
              : appShellSettings.appLanguage === 'zh-CN'
                ? '正在同步会话状态'
                : 'Syncing conversation status'}
          </span>
        </output>
      ) : null}
      {storageRecoveryFault ? (
        <InlineRecoveryPrompt
          className="storage-recovery-prompt"
          title={
            storageRecoveryFault.phase === 'failed'
              ? appShellSettings.appLanguage === 'zh-CN'
                ? '存储恢复未完成'
                : 'Storage recovery did not complete'
              : appShellSettings.appLanguage === 'zh-CN'
                ? '存储已停止写入'
                : 'Storage writes have stopped'
          }
          body={
            appShellSettings.appLanguage === 'zh-CN'
              ? storageRecoveryFault.readsAvailable
                ? 'Zeus 仍可读取现有数据。检查通过后将重启全部相关进程。'
                : 'Zeus 已停止读写。检查通过后将重启全部相关进程。'
              : storageRecoveryFault.readsAvailable
                ? 'Existing data is still readable. Zeus will restart all related processes after the check succeeds.'
                : 'Reads and writes have stopped. Zeus will restart all related processes after the check succeeds.'
          }
          actions={[
            {
              label:
                storageRecoveryFault.phase === 'running'
                  ? appShellSettings.appLanguage === 'zh-CN'
                    ? '正在检查'
                    : 'Checking'
                  : storageRecoveryFault.phase === 'failed'
                    ? appShellSettings.appLanguage === 'zh-CN'
                      ? '重新检查'
                      : 'Check again'
                    : appShellSettings.appLanguage === 'zh-CN'
                      ? '检查并重启'
                      : 'Check and restart',
              onAction: () => void runStorageRecoveryPreflightAndRestart(),
              busy: storageRecoveryFault.phase === 'running',
              disabled: storageRecoveryFault.phase === 'running',
            },
          ]}
        />
      ) : null}
      <ProjectCreateDialog
        open={projectCreateDialogOpen}
        form={projectCreateForm}
        busy={creatingProjectBusy}
        directoryBusy={projectDirectoryChoosing}
        error={projectCreateError}
        copy={uiCopy.sidebar}
        onNameChange={(name) => {
          setProjectCreateForm((current) => ({ ...current, name }));
          if (projectCreateError) setProjectCreateError(undefined);
        }}
        onChooseDirectory={() => void chooseProjectDirectoryForCreate()}
        onClose={closeProjectCreateDialog}
        onSubmit={(event) => void createCurrentProject(event)}
      />
      <TaskTerminalCleanupDialog
        confirmation={taskTerminalCleanupConfirmation}
        language={appShellSettings.appLanguage}
        onCancel={() => resolveTaskTerminalCleanupConfirmation(false)}
        onConfirm={() => resolveTaskTerminalCleanupConfirmation(true)}
      />
      <TaskTableLayoutDecisionDialog
        open={sourceWorkspaceLeaveDialogOpen}
        title={appShellSettings.appLanguage === 'zh-CN' ? '代码修改尚未保存' : 'Code changes have not been saved'}
        description={
          appShellSettings.appLanguage === 'zh-CN' ? '离开后，未保存的代码修改会丢失。请保存全部文件、放弃修改，或取消离开。' : 'Unsaved code changes will be lost when you leave. Save all files, discard changes, or stay on this page.'
        }
        busy={sourceWorkspaceSaveBusy}
        actions={[
          { id: 'cancel-source-leave', label: appShellSettings.appLanguage === 'zh-CN' ? '取消' : 'Cancel', onClick: cancelSourceWorkspaceLeave },
          {
            id: 'discard-source-leave',
            label: appShellSettings.appLanguage === 'zh-CN' ? '放弃' : 'Discard',
            variant: 'danger',
            onClick: discardSourceWorkspaceAndLeave,
          },
          {
            id: 'save-source-leave',
            label: appShellSettings.appLanguage === 'zh-CN' ? '保存全部' : 'Save all',
            variant: 'primary',
            onClick: () => void saveSourceWorkspaceAndLeave(),
          },
        ]}
        onCancel={cancelSourceWorkspaceLeave}
      />
      <TaskTableLayoutDecisionDialog
        open={taskTableLayoutLeaveDialogOpen}
        title={appShellSettings.appLanguage === 'zh-CN' ? '任务列表布局尚未保存' : 'Task list layout is not saved'}
        description={appShellSettings.appLanguage === 'zh-CN' ? '离开后，本次列显隐、排序、位置和宽度修改将丢失。' : 'Leaving now will discard your column visibility, sort, order, and width changes.'}
        actions={[
          {
            id: 'continue-editing',
            label: appShellSettings.appLanguage === 'zh-CN' ? '继续编辑' : 'Continue editing',
            onClick: cancelTaskTableLayoutLeave,
          },
          {
            id: 'discard-leave',
            label: appShellSettings.appLanguage === 'zh-CN' ? '放弃更改并离开' : 'Discard changes and leave',
            variant: 'danger',
            onClick: discardTaskTableLayoutAndLeave,
          },
          {
            id: 'save-leave',
            label: appShellSettings.appLanguage === 'zh-CN' ? '保存并离开' : 'Save and leave',
            variant: 'primary',
            onClick: beginSaveTaskTableLayoutAndLeave,
          },
        ]}
        onCancel={cancelTaskTableLayoutLeave}
      />
      <TaskTableLayoutDecisionDialog
        open={taskTableLayoutScopeDialogOpen}
        title={appShellSettings.appLanguage === 'zh-CN' ? '保存任务列表布局' : 'Save task list layout'}
        description={
          appShellSettings.appLanguage === 'zh-CN'
            ? '请选择这次布局修改的作用范围。保存到全部项目会更新全局默认，并清除所有项目的单独覆盖。'
            : 'Choose where this layout applies. Saving for all projects updates the global default and clears project-specific overrides.'
        }
        busy={taskTableLayoutSaveBusy}
        actions={[
          {
            id: 'project',
            label: appShellSettings.appLanguage === 'zh-CN' ? '仅当前项目' : 'Current project only',
            onClick: () => void saveTaskTableLayout('project'),
          },
          {
            id: 'global',
            label: appShellSettings.appLanguage === 'zh-CN' ? '全部项目' : 'All projects',
            variant: 'primary',
            onClick: () => void saveTaskTableLayout('global'),
          },
          {
            id: 'cancel',
            label: appShellSettings.appLanguage === 'zh-CN' ? '取消' : 'Cancel',
            onClick: cancelTaskTableLayoutScopeDialog,
          },
        ]}
        onCancel={cancelTaskTableLayoutScopeDialog}
      />
      {activeNavTarget !== 'settings' ? (
        <SidebarNav
          activeNavTarget={activeNavTarget}
          activeProjectId={activeProjectId}
          activeProjectSection={activeProjectSection}
          projects={orderedProjects}
          pinnedProjectIds={appShellSettings.pinnedProjectIds}
          collapsedProjectIds={appShellSettings.collapsedProjectIds}
          conversationOrganization={appShellSettings.sidebarConversationOrganization}
          collapsedConversationStatusIdsByProject={appShellSettings.sidebarConversationCollapsedStatusIdsByProject}
          conversationGroups={nativeConversationGroups}
          selectedConversationId={selectedNativeConversationId}
          conversationStates={nativeConversationRuntimeStates}
          automaticUpdateIndicator={automaticUpdateIndicator}
          appLanguage={appShellSettings.appLanguage}
          canCreateProject={projectCreationReady && !creatingProjectBusy}
          createProjectBusy={creatingProjectBusy}
          onCreateProject={openProjectCreateDialog}
          onCreateConversation={prepareNewConversationDraft}
          onSelectConversation={(conversation) => void selectNativeConversation(conversation)}
          onArchiveConversation={archiveConversation}
          onNavigate={handleMainNavigate}
          onOpenAutomaticUpdate={() => void openAutomaticUpdateIndicatorInMain({ zeus: globalThis.window.zeus })}
          onOpenProjectSection={openProjectSection}
          onTogglePinnedProject={togglePinnedProject}
          onToggleProjectCollapsed={(projectId) => void toggleCollapsedProject(projectId)}
          onToggleConversationOrganization={toggleSidebarConversationOrganization}
          onToggleConversationStatusGroup={toggleSidebarConversationStatusGroup}
          onRevealProjectInFinder={(projectPath) => revealProjectInFinder(projectPath)}
          onRenameProject={(projectId, displayName) => renameProjectDisplayName(projectId, displayName)}
          onPrepareProjectDelete={setPendingProjectDeleteId}
          onConfirmProjectDelete={deleteProject}
          pendingProjectDeleteId={pendingProjectDeleteId}
        />
      ) : null}
      {activeNavTarget !== 'settings' ? (
        <div
          className="project-sidebar-resizer"
          role="separator"
          aria-label={appShellSettings.appLanguage === 'zh-CN' ? '调整项目侧边栏宽度' : 'Resize project sidebar'}
          aria-orientation="vertical"
          aria-valuemin={PROJECT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={projectSidebarMaximumWidth}
          aria-valuenow={projectSidebarWidth}
          aria-valuetext={appShellSettings.appLanguage === 'zh-CN' ? `${projectSidebarWidth} 像素` : `${projectSidebarWidth} pixels`}
          tabIndex={0}
          onDoubleClick={resetProjectSidebarWidth}
          onKeyDown={handleProjectSidebarResizeKeyDown}
          onPointerDown={handleProjectSidebarResizePointerDown}
        />
      ) : null}
      <section className="workspace ai-workspace" ref={workspaceScrollRef}>
        {activeNavTarget === 'projects' && snapshot.projects.length === 0 ? (
          <ProjectStartGuide
            language={appShellSettings.appLanguage}
            busy={projectDirectoryChoosing || creatingProjectBusy}
            available={projectCreationReady}
            onChooseFolder={() => {
              openProjectCreateDialog();
              void chooseProjectDirectoryForCreate();
            }}
          />
        ) : null}
        {activeNavTarget === 'skills' ? <ExtensionsWorkspace client={props.nativeConversationClient ?? null} language={appShellSettings.appLanguage} projectId={activeProjectId} onChooseDirectory={props.onChooseProjectDirectory} /> : null}
        {activeNavTarget === 'automations' ? (
          <AutomationsWorkspace
            client={props.commandClient ?? null}
            projects={snapshot.projects}
            language={appShellSettings.appLanguage}
            onOpenConversation={async (run) => {
              if (!run.conversationId || !props.nativeConversationClient) return;
              const choice = await props.nativeConversationClient.loadNativeConversationChoice(run.projectId, run.conversationId);
              await selectNativeConversation(choice);
            }}
          />
        ) : null}
        {activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && activeNavTarget !== 'automations' && selectedProject ? (
          <ProjectWorkspaceModeToolbar
            project={selectedProject}
            section={activeProjectSection}
            codeMode={projectCodeWorkspaceMode}
            language={appShellSettings.appLanguage}
            onOpen={(section, codeMode) => openProjectSection(selectedProject, section, codeMode)}
          />
        ) : null}
        {activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && activeNavTarget !== 'automations' && activeProjectSection === 'code' && selectedProject ? (
          <section className="workspace-view workspace-view-project-code project-code-workspace" aria-label={codeWorkspaceCopy.projectCodeAria}>
            <div className="project-code-mode-host">
              {projectCodeWorkspaceMode === 'source' ? (
                <div className="project-code-mode-pane">
                  <ProjectSourceWorkspace
                    key={selectedProject.id}
                    ref={projectSourceWorkspaceRef}
                    project={selectedProject}
                    language={appShellSettings.appLanguage}
                    preference={appShellSettings.codeWorkspaceByProject?.[selectedProject.id]}
                    onPreferenceChange={(preference) => persistCodeWorkspacePreference(selectedProject.id, preference)}
                    onDirtyChange={setSourceWorkspaceDirty}
                    onOpenExternal={(relativePath, line) => void props.onOpenSource?.({ sourceRef: relativePath, lineStart: line, projectRoot: selectedProject.localPath })}
                  />
                </div>
              ) : null}
              {visitedCodeWorkspaceModes.has('commands') ? (
                <div className="project-code-mode-pane project-code-command-pane" hidden={projectCodeWorkspaceMode !== 'commands'}>
                  {props.commandClient ? <CommandCenterPanel mode="project" project={selectedProject} client={props.commandClient} language={appShellSettings.appLanguage} /> : null}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && activeNavTarget !== 'automations' && activeProjectSection === 'git' && selectedProject && props.nativeConversationClient ? (
          <section className="workspace-view workspace-view-project-git">
            <ProjectGitWorkbench key={selectedProject.id} project={selectedProject} client={props.nativeConversationClient} language={appShellSettings.appLanguage} />
          </section>
        ) : null}

        {activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && activeNavTarget !== 'automations' && snapshot.projects.length > 0 && activeProjectSection === 'project-settings' ? (
          <section className="workspace-view workspace-view-project-settings" aria-label={codeWorkspaceCopy.projectSettingsAria}>
            <section className="workspace-detail-pane project-detail-pane" aria-label={codeWorkspaceCopy.detailAria}>
              {selectedProject ? (
                <ProjectSettingsWorkspace key={selectedProject.id} project={selectedProject} commandClient={props.commandClient ?? null} conversationClient={props.nativeConversationClient ?? null} language={appShellSettings.appLanguage} />
              ) : (
                <>
                  <InlineRecoveryPrompt
                    title={uiCopy.sidebar.selectLocalRepository}
                    body=""
                    actions={[
                      {
                        label: repositoryPickerLabel(),
                        onAction: openProjectCreateDialog,
                        disabled: !projectCreationReady || creatingProjectBusy,
                        busy: creatingProjectBusy,
                      },
                    ]}
                  />
                  {projectPanel === 'archive' ? (
                    <WorkspaceDrawer
                      {...projectDrawerVisualProps}
                      label={codeWorkspaceCopy.drawerLabel}
                      backdropLabel={codeWorkspaceCopy.drawerBackdrop}
                      closeLabel={codeWorkspaceCopy.drawerClose}
                      className="project-drawer"
                      portalStyle={workspaceDrawerPortalStyle}
                      onClose={() => setProjectPanel(undefined)}
                    >
                      <ProjectArchiveWorkbench
                        projects={archivedProjects}
                        copy={codeWorkspaceCopy.projectArchive}
                        codeCopy={codeWorkspaceCopy}
                        onRefresh={refreshArchivedProjects}
                        refreshDisabled={!props.onLoadArchivedProjects}
                        onRestore={restoreProject}
                      />
                    </WorkspaceDrawer>
                  ) : null}
                </>
              )}
            </section>
          </section>
        ) : null}
        {activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && activeNavTarget !== 'automations' && snapshot.projects.length > 0 && (activeProjectSection === 'tasks' || activeProjectSection === 'sessions') ? (
          <section
            className={`workspace-view ${activeProjectSection === 'tasks' ? 'workspace-view-project-tasks' : 'workspace-view-project-sessions'}`}
            aria-label={activeProjectSection === 'tasks' ? taskWorkspaceCopy.viewAria : sessionWorkspaceCopy.viewAria}
          >
            <section
              className={`workspace-detail-pane ${activeProjectSection === 'tasks' ? 'task-management-detail-pane' : 'conversation-detail-pane'}`}
              aria-label={activeProjectSection === 'tasks' ? taskWorkspaceCopy.detailAria : sessionWorkspaceCopy.detailAria}
            >
              {activeProjectSection === 'tasks' ? (
                <>
                  {/* 默认仍是完整宽度的任务列表；看板可按项目切换，只有全页详情会临时替换任务工作区。 */}
                  {taskDetailPaneTask && taskDetailPresentation === 'full_page' ? (
                    <section className="task-detail-full-page" aria-label={taskWorkspaceCopy.detailPaneLabel}>
                      <header className="task-detail-presentation-header">
                        <Button variant="secondary" size="compact" onClick={closeTaskDetail}>
                          {appShellSettings.appLanguage === 'zh-CN' ? '返回任务' : 'Back to tasks'}
                        </Button>
                        <strong>{taskDetailPaneTask.title}</strong>
                      </header>
                      {renderTaskDetailPaneContent()}
                    </section>
                  ) : (
                    <TaskWorkspace
                      projectName={selectedProject?.name}
                      tasks={currentProjectTasks}
                      boardTasks={visibleTasks}
                      selectedTaskId={taskDetailPaneTaskId}
                      selectedTaskIds={selectedTaskIds}
                      searchQuery={taskSearchQuery}
                      statusFilter={taskStatusFilter}
                      tagFilter={taskTagFilter}
                      statusOptions={taskStatusFilterValues}
                      statusLabels={activeTaskManagementStatusLabels}
                      statusDefinitions={activeTaskManagementStatusConfig.statuses}
                      completedStatusId={activeTaskManagementStatusConfig.roles.completedStatusId}
                      cancelledStatusId={activeTaskManagementStatusConfig.roles.cancelledStatusId}
                      runStatusLabels={taskAgentRunStatusLabels[appShellSettings.appLanguage]}
                      priorityOptions={taskWorkspaceCopy.taskCreatePriorityOptions}
                      copy={taskWorkspaceCopy}
                      appLanguage={appShellSettings.appLanguage}
                      runtime={runtime}
                      runtimeSessions={runtimeSessions}
                      taskConversations={currentTaskConversationChoices}
                      conversationRunStatuses={nativeConversationTaskRunStatuses}
                      taskTableColumns={activeTaskTableColumns}
                      taskTableEnumSortOrders={taskTableEnumSortOrders}
                      taskTableLayoutDirty={taskTableLayoutDirty}
                      creatingTaskBusy={creatingTaskBusy}
                      bulkActionBusy={updatingTaskBusy}
                      statusChangeBusy={updatingTaskBusy}
                      bulkActionStatus={taskBulkActionStatus}
                      listState={!props.snapshot ? 'loading' : 'ready'}
                      activeProjectId={activeProjectId}
                      pageViewMode={taskPageViewMode}
                      taskBoardSnapshot={activeProjectId ? (taskBoardSnapshots[activeProjectId] ?? null) : null}
                      taskBoardLoading={activeProjectId ? Boolean(taskBoardLoadState[activeProjectId]?.loading) : false}
                      taskBoardError={activeProjectId ? (taskBoardLoadState[activeProjectId]?.error ?? null) : null}
                      onSearchChange={setTaskSearchQuery}
                      onStatusFilterChange={(filter) => void saveTaskStatusFilter(filter)}
                      onTagFilterChange={setTaskTagFilter}
                      onTaskTableColumnsChange={(preferences) => setTaskTableLayoutDraft({ projectId: activeProjectId, preferences })}
                      onSaveTaskTableLayout={() => setTaskTableLayoutScopeDialogOpen(true)}
                      onCreateTask={() => openTaskCreateModal()}
                      onOpenTaskDetail={(taskId, mode) => void openTaskDetailPane(taskId, mode)}
                      onOpenTaskConversation={(taskId, conversationId) => void openTaskConversationDrawer(taskId, conversationId)}
                      onPageViewModeChange={(viewMode) => void saveTaskPageViewMode(viewMode)}
                      onReloadTaskBoard={activeProjectId ? () => void loadTaskBoard(activeProjectId) : undefined}
                      onUpdateTaskBoard={updateTaskBoardSettings}
                      onMoveTaskBoardTask={moveTaskBoardTask}
                      onLoadTaskAttachmentPreview={props.onLoadTaskAttachmentPreview}
                      onToggleTaskSelection={toggleTaskSelection}
                      onToggleAllVisibleTaskSelection={toggleAllVisibleTaskSelection}
                      onClearTaskSelection={clearTaskSelection}
                      onTaskStatusChange={(taskId, targetStatus) => void updateTaskManagementStatus(taskId, targetStatus).catch(() => undefined)}
                      onTaskPriorityChange={updateTaskContent}
                      onBulkTaskStatusChange={(targetStatus, taskIds) => void runBulkTaskStatusChange(targetStatus, taskIds)}
                      onBulkTaskDelete={(taskIds) => void runBulkTaskDelete(taskIds)}
                      onRetryTaskList={
                        props.onLoadTasks && activeProjectId ? () => void props.onLoadTasks?.(activeProjectId, taskSearchQuery, taskStatusFilter && taskStatusFilter !== 'unfinished' ? taskStatusFilter : undefined, taskTagFilter) : undefined
                      }
                      onOpenProjectSettings={selectedProject ? () => openProjectSection(selectedProject, 'project-settings') : undefined}
                      onOpenProjectCode={selectedProject ? () => openProjectSection(selectedProject, 'code') : undefined}
                      controlBusyProps={controlBusyProps}
                    />
                  )}
                  <TaskCreateModal
                    projects={snapshot.projects}
                    onProjectChange={(projectId) => setTaskCreateForm((current) => ({ ...current, projectId, parentTaskId: null }))}
                    open={taskCreateModalOpen}
                    copy={taskWorkspaceCopy}
                    form={taskCreateForm}
                    parentTasks={snapshot.tasks.filter((task) => task.projectId === taskCreateForm.projectId && taskHierarchyDepth(task, snapshot.tasks) < 3)}
                    error={taskCreateError}
                    busy={creatingTaskBusy}
                    titleInputRef={taskCreateTitleInputRef}
                    onFormChange={updateTaskCreateForm}
                    onTaskTypeChange={updateTaskCreateType}
                    onPriorityChange={updateTaskCreatePriority}
                    onParentChange={(parentTaskId) => setTaskCreateForm((current) => ({ ...current, parentTaskId }))}
                    onAuthorizeFiles={authorizeTaskCreateFiles}
                    onMaterializeResources={materializeTaskCreateResources}
                    onReadClipboardResources={readTaskCreateClipboardResources}
                    onParseThirdPartyLink={(url) => props.onParseThirdPartyTaskLink?.(url) ?? Promise.resolve({ kind: 'unsupported', sourceUrl: url })}
                    onApplyThirdPartyTaskInfo={applyThirdPartyTaskExtract}
                    onOpenThirdPartyLink={openThirdPartyLinkInBrowser}
                    onAddAttachments={addTaskCreateAttachments}
                    onLoadAttachmentPreview={props.onLoadTaskAttachmentPreview}
                    onOpenAttachment={props.onOpenTaskAttachment}
                    onRemoveAttachment={removeTaskCreateAttachment}
                    onClose={closeTaskCreateModal}
                    onSubmit={(event) => void submitTaskCreateModal(event)}
                  />
                  <TaskDeleteRelationshipDialog
                    task={currentProjectTasks.find((task) => task.id === taskDeleteDialogTaskId)}
                    allTasks={currentProjectTasks}
                    busy={updatingTaskBusy}
                    language={appShellSettings.appLanguage}
                    onCancel={() => setTaskDeleteDialogTaskId(null)}
                    onConfirm={(input) => {
                      if (taskDeleteDialogTaskId) void deleteTaskWithRelationshipStrategy(taskDeleteDialogTaskId, input);
                    }}
                  />
                </>
              ) : (
                renderNativeConversationWorkspace((taskId) => void openTaskDetailPane(taskId))
              )}

              <TaskModelPushModal
                open={Boolean(taskModelPushTaskId) && taskModelPushEntry === 'confirmation' && !modelSetup.step}
                language={appShellSettings.appLanguage}
                task={snapshot.tasks.find((task) => task.id === taskModelPushTaskId) ?? null}
                projectName={snapshot.projects.find((project) => project.id === snapshot.tasks.find((task) => task.id === taskModelPushTaskId)?.projectId)?.name}
                capabilities={taskModelPushCapabilities}
                runtimeCapabilities={taskModelPushRuntimeCapabilities}
                serviceTierPreferences={taskModelPushServiceTierPreferences}
                form={taskModelPushForm}
                status={taskModelPushStatus}
                refreshingRepositoryId={taskModelPushRefreshingRepositoryId}
                error={taskModelPushError}
                skillClient={props.nativeConversationClient ?? null}
                onChange={(nextForm) => {
                  setTaskModelPushForm((current) => {
                    const resolved = typeof nextForm === 'function' ? nextForm(current) : nextForm;
                    const task = snapshot.tasks.find((candidate) => candidate.id === taskModelPushTaskId);
                    if (task) writeTaskModelPushPreferences(browserNativeConversationStartStorage(), task.projectId, resolved);
                    return resolved;
                  });
                }}
                onServiceTierPreferenceChange={domainActions.saveTaskModelPushServiceTierPreference}
                onRefreshRepository={(repositoryId) => void refreshTaskModelPushRepository(repositoryId)}
                onRefreshLocalRepositories={() => void domainActions.refreshTaskModelPushRepositories()}
                onConnectModel={() => modelSetup.open('choose', taskModelSetupContext ?? null)}
                onRetryModels={() => void domainActions.refreshTaskModelPushModels().catch(() => undefined)}
                onClose={closeTaskModelPush}
                onSubmit={(event) => void submitTaskModelPush(event)}
              />
              <TaskGitMergeModal
                open={Boolean(taskGitMergeTaskId)}
                language={appShellSettings.appLanguage}
                task={snapshot.tasks.find((task) => task.id === taskGitMergeTaskId) ?? null}
                projectName={snapshot.projects.find((project) => project.id === snapshot.tasks.find((task) => task.id === taskGitMergeTaskId)?.projectId)?.name}
                currentConversationWorkspaceId={selectedNativeConversation?.taskId === taskGitMergeTaskId ? selectedNativeConversation.workspaceId : null}
                refreshRevision={taskGitDeliveryRevision}
                client={props.nativeConversationClient ?? null}
                executionReady={executionHostSupportsConversationSource(props.executionHostTransition, 'conflict_resolution')}
                onQueueConflictAiStart={persistPendingConflictAiStart}
                onChanged={() =>
                  taskGitMergeTaskId
                    ? Promise.all([
                        refreshNativeConversationChoices(taskGitMergeTaskId),
                        props.onLoadTaskEvents && taskDetailPaneTaskId === taskGitMergeTaskId ? props.onLoadTaskEvents(taskGitMergeTaskId).then(setTaskEvents) : Promise.resolve(),
                      ]).then(() => undefined)
                    : Promise.resolve()
                }
                onOpenConversation={(taskId, conversationId) => openTaskConflictAiConversation(taskId, conversationId)}
                onClose={() => {
                  // 关闭后再刷新共享快照，避免提交过程中重置交付弹窗的文件选择。
                  if (taskGitMergeTaskId) taskGitDeliveryChangedRef.current(taskGitMergeTaskId);
                  setTaskGitMergeTaskId(null);
                }}
              />
              {taskDetailPaneTask && taskDetailPresentation === 'side_peek' ? (
                <WorkspaceDrawer
                  presentation="floating"
                  backdrop="dimmed"
                  size="wide"
                  label={taskWorkspaceCopy.detailPaneLabel}
                  backdropLabel={taskWorkspaceCopy.detailPaneBackdrop}
                  closeLabel={taskWorkspaceCopy.detailPaneClose}
                  className="task-detail-floating-drawer"
                  portalStyle={workspaceDrawerPortalStyle}
                  onClose={closeTaskDetail}
                >
                  {renderTaskDetailPaneContent()}
                </WorkspaceDrawer>
              ) : null}
              {taskDetailPaneTask && taskDetailPresentation === 'center_peek' ? (
                <ModalPortal rootClassName="task-detail-center-portal" backdropClassName="task-detail-center-backdrop" onDismiss={closeTaskDetail}>
                  <section className="task-detail-center-dialog" role="dialog" aria-modal="true" aria-label={taskWorkspaceCopy.detailPaneLabel}>
                    <header className="task-detail-presentation-header">
                      <strong>{taskDetailPaneTask.title}</strong>
                      <Button variant="secondary" size="compact" onClick={closeTaskDetail} aria-label={taskWorkspaceCopy.detailPaneClose}>
                        {appShellSettings.appLanguage === 'zh-CN' ? '关闭' : 'Close'}
                      </Button>
                    </header>
                    {renderTaskDetailPaneContent()}
                  </section>
                </ModalPortal>
              ) : null}

              {taskConversationDrawerTarget ? (
                <WorkspaceDrawer
                  presentation="sheet"
                  backdrop="dimmed"
                  size="wide"
                  label={taskWorkspaceCopy.taskConversationDrawerLabel}
                  backdropLabel={taskWorkspaceCopy.taskConversationDrawerBackdrop}
                  closeLabel={taskWorkspaceCopy.taskConversationDrawerClose}
                  className={`task-conversation-drawer session-codex-parity-v1 theme-${appShellSettings.appearance}`}
                  portalStyle={workspaceDrawerPortalStyle}
                  onClose={() => setTaskConversationDrawerTarget(undefined)}
                >
                  {taskConversationDrawerReady ? (
                    renderNativeConversationWorkspace((taskId) => {
                      setTaskConversationDrawerTarget(undefined);
                      void openTaskDetailPane(taskId);
                    })
                  ) : taskConversationDrawerTarget.status === 'error' ? (
                    <section className="task-conversation-drawer-loading task-conversation-drawer-error" role="status">
                      <p>{taskWorkspaceCopy.taskConversationDrawerUnavailable}</p>
                      <Button variant="secondary" size="compact" onClick={() => void openTaskConversationDrawer(taskConversationDrawerTarget.taskId, taskConversationDrawerTarget.conversationId)}>
                        {taskWorkspaceCopy.taskConversationDrawerRetry}
                      </Button>
                    </section>
                  ) : (
                    <section className="task-conversation-drawer-loading" role="status" aria-live="polite">
                      {taskWorkspaceCopy.taskConversationDrawerLoading}
                    </section>
                  )}
                </WorkspaceDrawer>
              ) : null}

              {conversationDrawer ? (
                <WorkspaceDrawer
                  presentation="sheet"
                  backdrop="dimmed"
                  size="wide"
                  label={sessionWorkspaceCopy.secondaryDrawerLabel}
                  backdropLabel={sessionWorkspaceCopy.secondaryDrawerBackdrop}
                  closeLabel={sessionWorkspaceCopy.secondaryDrawerClose}
                  className={`conversation-drawer conversation-drawer-shell conversation-drawer-sheet-${conversationDrawer}`}
                  portalStyle={workspaceDrawerPortalStyle}
                  onClose={() => setConversationDrawer(undefined)}
                >
                  {conversationDrawer === 'runtime' ? (
                    <section className="product-drawer-pane conversation-drawer-sheet conversation-drawer-sheet-runtime runtime-workbench" aria-label={sessionWorkspaceCopy.runtimeDrawer.runtimeEnvironment}>
                      {/* Runtime 抽屉只表达真实运行能力和确认状态，按“状态、适配器、高风险、会话、日志”连续行组织。 */}
                      <div className="drawer-header-row">
                        <strong>{sessionWorkspaceCopy.runtimeDrawer.runtimeEnvironment}</strong>
                        <button type="button" onClick={loadRuntimeStatus} disabled={!props.onLoadRuntimeStatus || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                          {sessionWorkspaceCopy.runtimeDrawer.refresh}
                        </button>
                      </div>
                      <section className="runtime-status-row-list" aria-label={sessionWorkspaceCopy.runtimeDrawer.runtimeStatus}>
                        <div className="runtime-capability-state-row">
                          <strong>{runtime.aiCli.name}</strong>
                          <span>{runtime.aiCli.available ? sessionWorkspaceCopy.runtimeDrawer.detectedCommand(runtime.aiCli.command) : sessionWorkspaceCopy.runtimeDrawer.waitingForCommand(runtime.aiCli.command)}</span>
                        </div>
                        <div className="runtime-capability-state-row">
                          <strong>{sessionWorkspaceCopy.runtimeDrawer.terminalBackend}</strong>
                          <span>{runtime.terminal?.pty.available ? (appShellSettings.appLanguage === 'zh-CN' ? '交互式终端' : 'Interactive terminal') : appShellSettings.appLanguage === 'zh-CN' ? '命令输出' : 'Command output'}</span>
                          <em>
                            {runtime.terminal
                              ? runtime.terminal.pty.available
                                ? appShellSettings.appLanguage === 'zh-CN'
                                  ? '可以输入命令并查看输出。'
                                  : 'Enter commands and view their output.'
                                : appShellSettings.appLanguage === 'zh-CN'
                                  ? '可以查看命令输出，暂不支持交互式输入。'
                                  : 'Command output is available; interactive input is not supported.'
                              : sessionWorkspaceCopy.runtimeDrawer.terminalPending}
                          </em>
                        </div>
                      </section>
                      {runtimeAdapters.length > 0 ? (
                        <section className="runtime-adapter-list runtime-adapter-row-list" aria-label={sessionWorkspaceCopy.runtimeDrawer.runtimeAdaptersAria}>
                          <strong>{sessionWorkspaceCopy.runtimeDrawer.runtimeAdaptersTitle}</strong>
                          {runtimeAdapters.map((adapter) => {
                            const checked = runtimeAdapterChecks[adapter.id];
                            return (
                              <div className="runtime-adapter-row" key={adapter.id}>
                                <span className="runtime-row-copy">
                                  <strong>{formatRuntimeAdapterDisplayName(adapter.id, runtimeAdapters, sessionWorkspaceCopy.runtimeDrawer)}</strong>
                                  <span>
                                    {adapter.command} ·{' '}
                                    {checked ? (checked.available ? sessionWorkspaceCopy.runtimeDrawer.adapterAvailable : sessionWorkspaceCopy.runtimeDrawer.adapterUnavailable) : sessionWorkspaceCopy.runtimeDrawer.adapterUnchecked}
                                  </span>
                                  <small>{formatRuntimeAdapterDetectionFacts(adapter, checked, appShellSettings.appLanguage)}</small>
                                </span>
                                <span className="runtime-row-command-rail">
                                  <button type="button" onClick={() => checkRuntimeAdapter(adapter.id)} disabled={loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                                    {sessionWorkspaceCopy.runtimeDrawer.checkAdapter}
                                  </button>
                                </span>
                              </div>
                            );
                          })}
                        </section>
                      ) : null}
                      {runtimeAdapters.some((adapter) => adapter.id === 'generic') ? (
                        <section className="runtime-generic-shell-risk-list runtime-generic-shell-row-list" aria-label={sessionWorkspaceCopy.runtimeDrawer.genericShellRiskAria}>
                          <strong>{sessionWorkspaceCopy.runtimeDrawer.genericShellRiskTitle}</strong>
                          {/* Generic shell 会启动真实本机命令，输入、预览、确认状态必须拆开，避免被误解为普通表单。 */}
                          <section className="runtime-generic-shell-input-row" aria-label={sessionWorkspaceCopy.runtimeDrawer.genericShellCommandAria}>
                            <span className="runtime-generic-shell-copy">
                              <strong>{sessionWorkspaceCopy.runtimeDrawer.genericShellCommandTitle}</strong>
                              <small>{sessionWorkspaceCopy.runtimeDrawer.genericShellCommandHelp}</small>
                            </span>
                            <span className="runtime-generic-shell-field">
                              <input
                                aria-label={sessionWorkspaceCopy.runtimeDrawer.genericShellCommandAria}
                                placeholder={sessionWorkspaceCopy.runtimeDrawer.genericShellCommandPlaceholder}
                                value={runtimeGenericShellCommand}
                                onChange={(event) => {
                                  setRuntimeGenericShellCommand(event.currentTarget.value);
                                  setRuntimeGenericShellCriticalConfirmation('');
                                  setRuntimeConfirmation(undefined);
                                  setRuntimeConfirmationCommand('');
                                  setRuntimeConfirmationStatus({ kind: 'changed' });
                                }}
                              />
                            </span>
                          </section>
                          <section className="runtime-shell-preview-row" aria-label={sessionWorkspaceCopy.runtimeDrawer.commandPreviewAria}>
                            <span className="runtime-generic-shell-copy">
                              <strong>{sessionWorkspaceCopy.runtimeDrawer.commandPreviewTitle}</strong>
                              <small>{sessionWorkspaceCopy.runtimeDrawer.commandPreviewHelp}</small>
                            </span>
                            <span>{runtimeGenericShellCommand.trim() ? `sh -lc ${runtimeGenericShellCommand.trim()}` : sessionWorkspaceCopy.runtimeDrawer.emptyShellCommand}</span>
                            <em>{sessionWorkspaceCopy.runtimeDrawer.genericShellRiskSummary(localizedGenericShellRisk.label, localizedGenericShellRisk.reason)}</em>
                          </section>
                          {genericShellRisk.level === 'critical' ? (
                            <section className="runtime-generic-shell-input-row" aria-label={sessionWorkspaceCopy.runtimeDrawer.criticalPhraseAria}>
                              <span className="runtime-generic-shell-copy">
                                <strong>{sessionWorkspaceCopy.runtimeDrawer.criticalPhraseTitle}</strong>
                                <small>{sessionWorkspaceCopy.runtimeDrawer.criticalPhraseHelp(GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE)}</small>
                              </span>
                              <span className="runtime-generic-shell-field">
                                <input
                                  aria-label={sessionWorkspaceCopy.runtimeDrawer.criticalPhraseAria}
                                  placeholder={GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE}
                                  value={runtimeGenericShellCriticalConfirmation}
                                  onChange={(event) => setRuntimeGenericShellCriticalConfirmation(event.currentTarget.value)}
                                />
                              </span>
                            </section>
                          ) : null}
                          <section className="runtime-generic-shell-state-row" aria-label={sessionWorkspaceCopy.runtimeDrawer.confirmationStateAria}>
                            <span className="runtime-generic-shell-copy">
                              <strong>{sessionWorkspaceCopy.runtimeDrawer.confirmationStateTitle}</strong>
                              <small>{sessionWorkspaceCopy.runtimeDrawer.confirmationStateHelp}</small>
                            </span>
                            <span>{runtimeConfirmationStatusCopy}</span>
                          </section>
                          {runtimeConfirmation?.status === 'rejected' ? (
                            <section className="runtime-generic-shell-rejected-row" aria-label={sessionWorkspaceCopy.runtimeDrawer.rejectedAria}>
                              <span className="runtime-generic-shell-copy">
                                <strong>{sessionWorkspaceCopy.runtimeDrawer.rejectedTitle}</strong>
                                <small>{sessionWorkspaceCopy.runtimeDrawer.rejectedHelp}</small>
                              </span>
                              <span>{runtimeConfirmation.rejectedReason ?? sessionWorkspaceCopy.runtimeDrawer.rejectedReasonFallback}</span>
                            </section>
                          ) : null}
                          <div className="runtime-generic-shell-command-rail">
                            <button
                              type="button"
                              onClick={createGenericRuntimeConfirmation}
                              disabled={!props.onCreateRuntimeConfirmation || !activeProjectId || !runtimeGenericShellCommand.trim() || loadingRuntimeBusy}
                              {...controlBusyProps(loadingRuntimeBusy)}
                            >
                              {sessionWorkspaceCopy.runtimeDrawer.createGenericShellConfirmation}
                            </button>
                            {runtimeConfirmation?.status === 'pending' ? (
                              <button type="button" onClick={rejectGenericRuntimeConfirmation} disabled={!props.onRejectRuntimeOperation || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                                {sessionWorkspaceCopy.runtimeDrawer.rejectGenericShellConfirmation}
                              </button>
                            ) : null}
                            {runtimeConfirmation?.status !== 'rejected' ? (
                              <button
                                type="button"
                                onClick={confirmAndStartGenericRuntime}
                                disabled={!props.onConfirmRuntimeOperation || !runtimeConfirmation || runtimeConfirmation.status !== 'pending' || !genericShellCriticalConfirmed || loadingRuntimeBusy}
                                {...controlBusyProps(loadingRuntimeBusy)}
                              >
                                {sessionWorkspaceCopy.runtimeDrawer.confirmAndStartGenericShell}
                              </button>
                            ) : null}
                          </div>
                          {runtimeConfirmation?.status === 'pending' ? (
                            <section className="runtime-generic-shell-state-row" aria-label={sessionWorkspaceCopy.runtimeDrawer.rejectImpactAria}>
                              <span className="runtime-generic-shell-copy">
                                <strong>{sessionWorkspaceCopy.runtimeDrawer.rejectImpactTitle}</strong>
                                <small>{sessionWorkspaceCopy.runtimeDrawer.rejectImpactHelp}</small>
                              </span>
                              <span>{sessionWorkspaceCopy.runtimeDrawer.rejectImpactBody}</span>
                            </section>
                          ) : null}
                        </section>
                      ) : null}
                      <section className="runtime-session-list runtime-session-row-list" aria-label={sessionWorkspaceCopy.runtimeDrawer.runtimeSessions}>
                        <div className="drawer-header-row">
                          <strong>{sessionWorkspaceCopy.runtimeDrawer.runtimeSessions}</strong>
                          <button type="button" onClick={startRuntimeSession} disabled={!activeProjectId || !runtime.aiCli.available || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {sessionWorkspaceCopy.runtimeDrawer.startRuntimeSession}
                          </button>
                        </div>
                        <div className="runtime-session-filter-grid runtime-session-filter-row" aria-label={sessionWorkspaceCopy.runtimeDrawer.runtimeSessionSearch}>
                          {/* 会话筛选拆成显式搜索行和开关行，避免 label 把输入、复选框和布局语义混在一起。 */}
                          <section className="runtime-session-filter-control-row" aria-label={sessionWorkspaceCopy.runtimeDrawer.searchSessions}>
                            <span className="runtime-session-filter-copy">
                              <strong>{sessionWorkspaceCopy.runtimeDrawer.searchSessions}</strong>
                              <small>{sessionWorkspaceCopy.runtimeDrawer.searchSessionsHelp}</small>
                            </span>
                            <span className="runtime-session-filter-field">
                              <input type="search" aria-label={sessionWorkspaceCopy.runtimeDrawer.searchSessions} value={runtimeSearchQuery} onChange={(event) => setRuntimeSearchQuery(event.currentTarget.value)} />
                            </span>
                          </section>
                          <span className="runtime-session-filter-toggle-row">
                            <input aria-label={sessionWorkspaceCopy.runtimeDrawer.favoritesOnly} type="checkbox" checked={runtimeFavoriteOnly} onChange={(event) => setRuntimeFavoriteOnly(event.currentTarget.checked)} />
                            <span>{sessionWorkspaceCopy.runtimeDrawer.favoritesOnly}</span>
                          </span>
                          <span className="runtime-session-filter-toggle-row">
                            <input aria-label={sessionWorkspaceCopy.runtimeDrawer.showArchived} type="checkbox" checked={runtimeShowArchived} onChange={(event) => setRuntimeShowArchived(event.currentTarget.checked)} />
                            <span>{sessionWorkspaceCopy.runtimeDrawer.showArchived}</span>
                          </span>
                          <button type="button" onClick={refreshRuntimeSessions} disabled={!props.onLoadRuntimeSessions || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {sessionWorkspaceCopy.runtimeDrawer.applyFilters}
                          </button>
                        </div>
                        {runtimeSessions.length === 0 ? (
                          <span className="runtime-session-empty-row">{sessionWorkspaceCopy.runtimeDrawer.emptyRuntimeSessions}</span>
                        ) : (
                          runtimeSessions.slice(0, 5).map((session) => (
                            <div className="runtime-session-row" key={session.id}>
                              <span className="runtime-row-copy">
                                <strong>{[session.command, ...session.args].join(' ')}</strong>
                                <span>
                                  {formatRuntimeSessionStatus(session.status, sessionWorkspaceCopy.runtimeDrawer)} · {session.cwd}
                                </span>
                                <small>{session.summary ?? sessionWorkspaceCopy.runtimeDrawer.sessionSummaryFallback}</small>
                              </span>
                              <div className="runtime-session-action-rail" aria-label={sessionWorkspaceCopy.runtimeDrawer.runtimeSessionActionsAria}>
                                {/* 会话行先暴露高频主操作，低频整理/导出/删除收进第二行动作，避免继续复用任务按钮堆。 */}
                                <span className="runtime-session-primary-command-rail">
                                  <button type="button" onClick={() => generateRuntimeSessionSummary(session.id)}>
                                    {sessionWorkspaceCopy.runtimeDrawer.generateSummary}
                                  </button>
                                  <button type="button" onClick={() => createTaskFromRuntimeSession(session)}>
                                    {sessionWorkspaceCopy.runtimeDrawer.createTaskFromSession}
                                  </button>
                                </span>
                                <span className="runtime-session-secondary-command-rail">
                                  <button type="button" onClick={() => setRuntimeSessionFavorite(session)}>
                                    {session.favorite ? sessionWorkspaceCopy.runtimeDrawer.unfavoriteSession : sessionWorkspaceCopy.runtimeDrawer.favoriteSession}
                                  </button>
                                  {session.archived ? (
                                    <button type="button" onClick={() => restoreRuntimeSession(session.id)}>
                                      {sessionWorkspaceCopy.runtimeDrawer.restoreSession}
                                    </button>
                                  ) : (
                                    <button type="button" onClick={() => archiveRuntimeSession(session.id)}>
                                      {sessionWorkspaceCopy.runtimeDrawer.archiveSession}
                                    </button>
                                  )}
                                  <button type="button" onClick={() => exportRuntimeLogs(session.id)}>
                                    {sessionWorkspaceCopy.runtimeDrawer.exportCurrentLog}
                                  </button>
                                  <button type="button" className="runtime-session-danger-action" onClick={() => deleteRuntimeSession(session.id)}>
                                    {sessionWorkspaceCopy.runtimeDrawer.deleteSession}
                                  </button>
                                </span>
                              </div>
                              {session.status === 'running' ? (
                                <section className="runtime-session-live-controls" aria-label={sessionWorkspaceCopy.runtimeDrawer.runtimeInputAria}>
                                  {/* 运行中输入拆成说明列和控件列，避免 label 包住按钮造成抽屉内部继续像临时表单。 */}
                                  <section className="runtime-session-compose-row" aria-label={sessionWorkspaceCopy.runtimeDrawer.runtimeInputSendAria}>
                                    <span className="runtime-session-compose-copy">
                                      <strong>{sessionWorkspaceCopy.runtimeDrawer.runtimeInputTitle}</strong>
                                      <small>{sessionWorkspaceCopy.runtimeDrawer.runtimeInputHelp}</small>
                                    </span>
                                    <span className="runtime-session-compose-field">
                                      <input aria-label={sessionWorkspaceCopy.runtimeDrawer.runtimeInputAria} value={runtimeInput} onChange={(event) => setRuntimeInput(event.currentTarget.value)} />
                                      <button type="button" onClick={() => sendRuntimeInput(session.id)} disabled={!runtimeInput.trim() || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                                        {sessionWorkspaceCopy.runtimeDrawer.sendRuntimeInput}
                                      </button>
                                    </span>
                                  </section>
                                  <span className="runtime-session-terminal-command-rail" aria-label={sessionWorkspaceCopy.runtimeDrawer.terminalControlsAria}>
                                    <button type="button" onClick={() => interruptRuntimeSession(session.id)}>
                                      {sessionWorkspaceCopy.runtimeDrawer.interrupt}
                                    </button>
                                    <button type="button" onClick={() => resizeRuntimeSession(session.id)}>
                                      {sessionWorkspaceCopy.runtimeDrawer.resizeTerminal}
                                    </button>
                                    <button type="button" onClick={() => loadRuntimeTerminalSnapshot(session.id)}>
                                      {sessionWorkspaceCopy.runtimeDrawer.loadTerminalSnapshot}
                                    </button>
                                    <button type="button" className="runtime-session-stop-action" onClick={() => stopRuntimeSession(session.id)}>
                                      {sessionWorkspaceCopy.runtimeDrawer.stopSession}
                                    </button>
                                  </span>
                                </section>
                              ) : null}
                              {session.status === 'orphan_detected' ? (
                                <section className="runtime-session-orphan-controls" aria-label={sessionWorkspaceCopy.runtimeDrawer.orphanControlsAria}>
                                  {/* 孤儿会话只保留风险说明和终止入口，避免伪装成可继续输入的运行中表单。 */}
                                  <span className="runtime-session-orphan-copy">
                                    <strong>{sessionWorkspaceCopy.runtimeDrawer.orphanTitle(session.pid ?? sessionWorkspaceCopy.runtimeDrawer.unknownPid)}</strong>
                                    <small>{sessionWorkspaceCopy.runtimeDrawer.orphanHelp}</small>
                                  </span>
                                  <span className="runtime-session-orphan-command-rail">
                                    <button type="button" className="runtime-session-orphan-stop-action" onClick={() => stopRuntimeSession(session.id)}>
                                      {sessionWorkspaceCopy.runtimeDrawer.orphanStop}
                                    </button>
                                  </span>
                                </section>
                              ) : null}
                            </div>
                          ))
                        )}
                      </section>
                      {runtimeLogs.length > 0 ? (
                        <section className="runtime-log-workbench" aria-label={sessionWorkspaceCopy.runtimeDrawer.logsAria}>
                          <div className="runtime-log-toolbar">
                            <span className="runtime-log-title">
                              <strong>{sessionWorkspaceCopy.runtimeDrawer.logsTitle}</strong>
                              <small>{sessionWorkspaceCopy.runtimeDrawer.logsHelp}</small>
                            </span>
                            <span className="runtime-log-command-rail" aria-label={sessionWorkspaceCopy.runtimeDrawer.logActionsAria}>
                              {/* Runtime 日志抽屉只保留一条工具栏：搜索、复制、折叠和导出聚合到同一组，避免表单和按钮继续散落。 */}
                              <button type="button" onClick={copyRuntimeLogs}>
                                {sessionWorkspaceCopy.runtimeDrawer.copyLogs}
                              </button>
                              <button type="button" onClick={() => setRuntimeLogsCollapsed((current) => !current)}>
                                {runtimeLogsCollapsed ? sessionWorkspaceCopy.runtimeDrawer.expandLogs : sessionWorkspaceCopy.runtimeDrawer.collapseLogs}
                              </button>
                              <span className="sr-only">{sessionWorkspaceCopy.runtimeDrawer.expandLogs}</span>
                              <button type="button" onClick={() => exportRuntimeLogs(runtimeLogs[0]?.sessionId ?? '')}>
                                {sessionWorkspaceCopy.runtimeDrawer.exportCurrentLog}
                              </button>
                            </span>
                          </div>
                          <section className="runtime-log-search-control-row" aria-label={sessionWorkspaceCopy.runtimeDrawer.logSearchAria}>
                            <span className="runtime-log-search-copy">
                              <strong>{sessionWorkspaceCopy.runtimeDrawer.logSearchTitle}</strong>
                              <small>{sessionWorkspaceCopy.runtimeDrawer.logSearchHelp}</small>
                            </span>
                            <span className="runtime-log-search-field">
                              <input type="search" aria-label={sessionWorkspaceCopy.runtimeDrawer.logSearchTitle} value={runtimeLogSearchQuery} onChange={(event) => setRuntimeLogSearchQuery(event.currentTarget.value)} />
                            </span>
                          </section>
                          <div className="runtime-log-state-row">
                            <small>{sessionWorkspaceCopy.runtimeDrawer.logExportState(runtimeLogExportStatusCopy, runtimeLogCopyStatusCopy)}</small>
                            <span className="log-legend">{sessionWorkspaceCopy.runtimeDrawer.logLegend}</span>
                          </div>
                          <div className="runtime-log-stream" aria-label={sessionWorkspaceCopy.runtimeDrawer.rawOutputAria}>
                            <RuntimeXtermPane logs={runtimeLogs} enabled={runtimeStatus?.terminal?.provider === 'node-pty' && runtimeStatus.terminal.pty.available === true} ariaLabel={sessionWorkspaceCopy.runtimeDrawer.terminalAria} />
                            {!runtimeLogsCollapsed ? <code className="runtime-log-line output">{projectedRuntimeLogOutput}</code> : <span>{sessionWorkspaceCopy.runtimeDrawer.collapsedLogs}</span>}
                          </div>
                        </section>
                      ) : null}
                    </section>
                  ) : null}

                  {conversationDrawer === 'changes' ? (
                    <section className="product-drawer-pane conversation-drawer-sheet conversation-drawer-sheet-changes conversation-change-workbench" aria-label={secondaryDrawerCopy.changesLabel}>
                      <div className="drawer-header-row">
                        <strong>{gitDiffCopy.title}</strong>
                        <button type="button" onClick={loadGitDiff} disabled={!props.onLoadGitDiff || loadingDiffBusy} {...controlBusyProps(loadingDiffBusy)}>
                          {loadingDiffBusy ? secondaryDrawerCopy.loadingDiff : secondaryDrawerCopy.loadDiff}
                        </button>
                      </div>
                      {changedFiles.length === 0 ? (
                        <section className="conversation-change-empty-row" aria-label={secondaryDrawerCopy.noLoadedChangesAria}>
                          <span className="conversation-change-file-copy">
                            <strong>{secondaryDrawerCopy.noLoadedChangesTitle}</strong>
                            <small>{secondaryDrawerCopy.noLoadedChangesHelp}</small>
                          </span>
                        </section>
                      ) : (
                        <div className="conversation-change-file-list" aria-label={secondaryDrawerCopy.changedFilesAria}>
                          {changedFiles.slice(0, 12).map((file) => (
                            <article className="conversation-change-file-row" key={file}>
                              <span className="conversation-change-file-copy">
                                <strong>{file}</strong>
                                <small>{secondaryDrawerCopy.realGitDiffFile}</small>
                              </span>
                              <span className="conversation-change-file-meta">{secondaryDrawerCopy.loaded}</span>
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  ) : null}

                  {conversationDrawer === 'templates' ? (
                    <section className="product-drawer-pane conversation-drawer-sheet conversation-drawer-sheet-templates task-template-workbench" aria-label={secondaryDrawerCopy.templatesLabel}>
                      {/* 任务模板抽屉只负责选择真实模板并创建任务，模板说明和套用动作必须在同一行内可扫描。 */}
                      <div className="drawer-header-row">
                        <strong>{secondaryDrawerCopy.templatesLabel}</strong>
                        <button type="button" onClick={loadTaskTemplates} disabled={!props.onLoadTaskTemplates || loadingTemplatesBusy} {...controlBusyProps(loadingTemplatesBusy)}>
                          {actionState === 'loading-templates' ? secondaryDrawerCopy.loadingTemplates : secondaryDrawerCopy.loadTemplates}
                        </button>
                      </div>
                      <section className="task-template-list" aria-label={secondaryDrawerCopy.templateListAria}>
                        {taskTemplates.length === 0 ? (
                          <div className="task-template-empty-row" aria-label={secondaryDrawerCopy.emptyTemplatesAria}>
                            <span className="task-template-copy">
                              <strong>{secondaryDrawerCopy.emptyTemplatesTitle}</strong>
                              <span>{secondaryDrawerCopy.emptyTemplatesHelp}</span>
                            </span>
                            <span className="task-template-command-rail">
                              <button type="button" onClick={loadTaskTemplates} disabled={!props.onLoadTaskTemplates || loadingTemplatesBusy} {...controlBusyProps(loadingTemplatesBusy)}>
                                {actionState === 'loading-templates' ? secondaryDrawerCopy.loadingTemplates : secondaryDrawerCopy.loadTemplates}
                              </button>
                            </span>
                          </div>
                        ) : (
                          taskTemplates.map((template) => (
                            <div className="task-template-row" key={template.id}>
                              <span className="task-template-copy">
                                <strong>{template.name}</strong>
                                <span>{template.description || (template.builtIn ? secondaryDrawerCopy.builtInTaskTemplate : secondaryDrawerCopy.projectTaskTemplate)}</span>
                                <small>{template.builtIn ? secondaryDrawerCopy.builtInTemplate : secondaryDrawerCopy.projectTemplate}</small>
                              </span>
                              <span className="task-template-command-rail">
                                <button type="button" onClick={() => createTaskFromTemplate(template.id)}>
                                  {secondaryDrawerCopy.applyTemplate}
                                </button>
                              </span>
                            </div>
                          ))
                        )}
                      </section>
                    </section>
                  ) : null}
                </WorkspaceDrawer>
              ) : null}
            </section>
          </section>
        ) : null}

        <TaskGitReviewModal
          open={Boolean(taskGitReviewState)}
          language={appShellSettings.appLanguage}
          task={snapshot.tasks.find((task) => task.id === taskGitReviewState?.taskId) ?? null}
          projectName={snapshot.projects.find((project) => project.id === snapshot.tasks.find((task) => task.id === taskGitReviewState?.taskId)?.projectId)?.name}
          client={props.nativeConversationClient ?? null}
          mode={taskGitReviewState?.mode ?? 'commit'}
          preferredWorkspaceId={taskGitReviewState?.workspaceId}
          onClose={closeTaskGitReview}
        />

        {activeNavTarget === 'settings' ? (
          <section className="workspace-view workspace-view-settings settings-reference-shell" aria-label={settingsWorkspaceCopy.viewAria}>
            <aside className="settings-sidebar-shell" aria-label={settingsWorkspaceCopy.categoryListAria}>
              <button type="button" className="settings-return-button" onClick={() => handleMainNavigate('projects')}>
                <span aria-hidden="true">←</span>
                <span>{settingsWorkspaceCopy.returnToApp}</span>
              </button>
              <span className="settings-query-field">
                <MagnifyingGlass aria-hidden="true" weight="regular" />
                <input
                  className="settings-query-control"
                  aria-label={settingsWorkspaceCopy.searchAria}
                  placeholder={settingsWorkspaceCopy.searchPlaceholder}
                  value={settingsSearchQuery}
                  onChange={(event) => setSettingsSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setSettingsSearchQuery('');
                    }
                  }}
                />
              </span>
              <nav
                className="settings-section-nav settings-sidebar-nav"
                aria-label={settingsWorkspaceCopy.categoryListAria}
                role="tablist"
                aria-orientation="vertical"
                data-inline-rail-keyboard="vertical"
                onKeyDown={handleInlineRailKeyboardNavigation}
              >
                {visibleSettingsGroups.map((group) => (
                  <div className="settings-sidebar-group" role="presentation" key={group.group}>
                    <span className="settings-sidebar-group-title" role="presentation">
                      {group.group}
                    </span>
                    {group.items.map(([id, label]) => (
                      <button
                        key={id}
                        id={`${settingsPanelId}-${id}`}
                        type="button"
                        className={`settings-section-button ${settingsCategory === id ? 'selected' : ''}`}
                        role="tab"
                        aria-controls={settingsPanelId}
                        aria-selected={settingsCategory === id}
                        tabIndex={settingsNavigationTabStop === id ? 0 : -1}
                        data-inline-rail-item="true"
                        onClick={() => setSettingsCategory(id)}
                      >
                        <span className="settings-section-label">{label}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </nav>
              {visibleSettingsItems.length === 0 ? <p role="status">{appShellSettings.appLanguage === 'zh-CN' ? '没有匹配的设置分段' : 'No matching settings sections'}</p> : null}
            </aside>
            <section key={settingsCategory} id={settingsPanelId} role="tabpanel" tabIndex={0} className="settings-detail-pane" aria-labelledby={`${settingsPanelId}-${settingsCategory}`}>
              <div className="settings-content-column">
                {settingsCategory === 'general' ? <GeneralSettingsPane value={appShellSettings} client={props.nativeConversationClient?.settings ?? null} onChange={setAppShellSettings} /> : null}
                {settingsCategory === 'usage' ? <CodexUsageSettingsPane client={props.nativeConversationClient ?? null} language={appShellSettings.appLanguage} refreshRevision={codexUsageRevision} /> : null}
                {settingsCategory === 'memory' && props.nativeConversationClient ? (
                  <MemorySettingsPane
                    client={props.nativeConversationClient.memory}
                    language={appShellSettings.appLanguage}
                    projects={snapshot.projects.map((project) => ({ id: project.id, name: project.name }))}
                    initialProjectId={projectDetail?.id}
                  />
                ) : null}
                {settingsCategory === 'employees' ? <DigitalEmployeeTemplatesSettings client={props.commandClient ?? null} skillClient={props.nativeConversationClient ?? null} language={appShellSettings.appLanguage} /> : null}
                {settingsCategory === 'tasks' ? (
                  <section className="settings-product-pane task-list-settings-pane" aria-label={settingsWorkspaceCopy.categories.tasks}>
                    <header className="settings-page-heading">
                      <span>
                        <h2 className="settings-page-title">{settingsWorkspaceCopy.categories.tasks}</h2>
                        <p>{appShellSettings.appLanguage === 'zh-CN' ? '选择字段，调整选项与排序。修改后自动保存。' : 'Choose a field to edit options and order. Changes save automatically.'}</p>
                      </span>
                      <SettingsSaveStatus status={taskAutosave.status} language={appShellSettings.appLanguage} />
                    </header>
                    <div className="task-fields-workspace">
                      <nav className="task-field-nav" aria-label={appShellSettings.appLanguage === 'zh-CN' ? '任务字段' : 'Task fields'}>
                        {(['status', 'priority', 'runStatus'] as const).map((field) => (
                          <button className="task-field-tab" key={field} type="button" aria-current={taskField === field ? 'page' : undefined} onClick={() => setTaskField(field)}>
                            {
                              {
                                status: appShellSettings.appLanguage === 'zh-CN' ? '任务状态' : 'Task status',
                                priority: appShellSettings.appLanguage === 'zh-CN' ? '优先级' : 'Priority',
                                runStatus: appShellSettings.appLanguage === 'zh-CN' ? '运行状态' : 'Run status',
                              }[field]
                            }
                          </button>
                        ))}
                      </nav>
                      <fieldset className="task-field-detail" onInput={() => taskAutosave.reset()} disabled={taskAutosave.status === 'saving'}>
                        {taskField === 'status' ? (
                          <>
                            <section className="settings-product-section" aria-labelledby="task-status-config-title">
                              <header className="settings-section-heading">
                                <strong id="task-status-config-title">{appShellSettings.appLanguage === 'zh-CN' ? '任务状态' : 'Task statuses'}</strong>
                                <span>
                                  {appShellSettings.appLanguage === 'zh-CN'
                                    ? '每个项目独立维护状态名称、颜色和顺序。删除使用中的状态时，先迁移任务再删除。'
                                    : 'Each project owns its status names, colors, and order. In-use statuses migrate before deletion.'}
                                </span>
                              </header>
                              <label className="task-status-config-scope">
                                <span>{appShellSettings.appLanguage === 'zh-CN' ? '配置对象' : 'Configuration target'}</span>
                                <ZeusSelect
                                  size="regular"
                                  ariaLabel={appShellSettings.appLanguage === 'zh-CN' ? '选择任务状态配置对象' : 'Choose task status configuration target'}
                                  value={effectiveTaskStatusSettingsTargetId}
                                  onChange={setTaskStatusSettingsTargetId}
                                  options={[
                                    { value: '__template__', label: appShellSettings.appLanguage === 'zh-CN' ? '新项目默认模板' : 'New project default template' },
                                    ...snapshot.projects.map((project) => ({ value: project.id, label: project.name })),
                                  ]}
                                />
                              </label>
                              <TaskManagementStatusEditor
                                language={appShellSettings.appLanguage}
                                config={taskStatusSettingsConfig}
                                usageCounts={taskStatusSettingsUsageCounts}
                                labelForStatus={(status) => formatConfiguredTaskManagementStatus(status, taskStatusSettingsConfig, appShellSettings.appLanguage)}
                                onChange={(config, deletion) => {
                                  /** 迁移关系与状态配置在同一笔本地事务提交。 */
                                  const replacements =
                                    effectiveTaskStatusSettingsTargetId !== '__template__' && deletion?.replacementStatusId
                                      ? {
                                          ...state.taskManagementStatusReplacements,
                                          [effectiveTaskStatusSettingsTargetId]: { ...state.taskManagementStatusReplacements[effectiveTaskStatusSettingsTargetId], [deletion.removedStatusId]: deletion.replacementStatusId },
                                        }
                                      : state.taskManagementStatusReplacements;
                                  state.setTaskManagementStatusReplacements(replacements);
                                  saveTaskFields({
                                    ...(effectiveTaskStatusSettingsTargetId === '__template__'
                                      ? { taskManagementStatusTemplate: config }
                                      : { taskManagementStatusByProject: { ...appShellSettings.taskManagementStatusByProject, [effectiveTaskStatusSettingsTargetId]: config } }),
                                    taskManagementStatusReplacements: replacements,
                                  });
                                }}
                              />
                            </section>
                          </>
                        ) : (
                          <section className="settings-product-section" aria-labelledby="task-list-sort-settings-title">
                            <header className="settings-section-heading">
                              <strong id="task-list-sort-settings-title">{appShellSettings.appLanguage === 'zh-CN' ? '其他字段的排序规则' : 'Sort order for other fields'}</strong>
                              <span>
                                {appShellSettings.appLanguage === 'zh-CN'
                                  ? '优先级和运行状态仍为系统固定值；拖动定义升序，降序会反转该顺序。此设置对所有项目生效。'
                                  : 'Priority and run status remain fixed system values. Drag to define ascending order; descending reverses it. This applies to every project.'}
                              </span>
                            </header>
                            <div className="task-enum-order-grid task-enum-order-grid-secondary">
                              {taskField === 'priority' ? (
                                <TaskEnumOrderEditor
                                  language={appShellSettings.appLanguage}
                                  title={appShellSettings.appLanguage === 'zh-CN' ? '优先级' : 'Priority'}
                                  description={appShellSettings.appLanguage === 'zh-CN' ? 'P0 至 P4 的业务顺序' : 'Business order for P0 through P4'}
                                  items={taskTableEnumSortOrders.priority.map((value) => ({ value, label: taskPriorityLabels[value] }))}
                                  onChange={(priority) => saveTaskFields({ taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders({ ...appShellSettings.taskTableEnumSortOrders, priority }) })}
                                />
                              ) : (
                                <TaskEnumOrderEditor
                                  language={appShellSettings.appLanguage}
                                  title={appShellSettings.appLanguage === 'zh-CN' ? '运行状态' : 'Run status'}
                                  description={appShellSettings.appLanguage === 'zh-CN' ? 'AI 工作状态的排序' : 'AI work status order'}
                                  items={taskTableEnumSortOrders.runStatus.map((value) => ({ value, label: taskAgentRunStatusLabels[appShellSettings.appLanguage][value] }))}
                                  onChange={(runStatus) => saveTaskFields({ taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders({ ...appShellSettings.taskTableEnumSortOrders, runStatus }) })}
                                />
                              )}
                            </div>
                            <div className="task-list-settings-actions">
                              <Button
                                variant="secondary"
                                size="compact"
                                onClick={() => saveTaskFields({ taskTableEnumSortOrders: { ...taskTableEnumSortOrders, [taskField]: defaultTaskTableEnumSortOrders[taskField as 'priority' | 'runStatus'] } })}
                              >
                                {appShellSettings.appLanguage === 'zh-CN' ? '恢复默认顺序' : 'Restore default order'}
                              </Button>
                            </div>
                          </section>
                        )}
                      </fieldset>
                    </div>
                  </section>
                ) : null}
                {settingsCategory === 'runtime' ? (
                  <section className="settings-product-pane" aria-label={settingsWorkspaceCopy.categories.runtime}>
                    <header className="settings-page-heading">
                      <span>
                        <h2 className="settings-page-title">{settingsWorkspaceCopy.categories.runtime}</h2>
                        <p>{appShellSettings.appLanguage === 'zh-CN' ? '管理本机运行环境、远程接管与配置导入。' : 'Local runtime, remote control and configuration import.'}</p>
                      </span>
                      <SettingsSaveStatus status={runtimeSaveState} language={appShellSettings.appLanguage} />
                    </header>
                    <CodexRemoteControlSettings language={appShellSettings.appLanguage} client={props.nativeConversationClient?.remoteControl ?? null} />
                    <LegacyChatImportSettings
                      language={appShellSettings.appLanguage}
                      snapshot={codexLegacyImportSnapshot}
                      loading={codexLegacyImportLoading}
                      busy={codexLegacyImportBusy}
                      error={codexLegacyImportError}
                      onRefresh={refreshCodexLegacyImports}
                      onImport={startCodexLegacyImport}
                    />
                    <CodexConfigImportSettings
                      language={appShellSettings.appLanguage}
                      preview={codexConfigImportPreview}
                      result={codexConfigImportResult}
                      loading={codexConfigImportLoading}
                      error={codexConfigImportError}
                      onRefresh={refreshCodexConfigImport}
                      onImport={importCodexConfig}
                      onActivate={activateCodexConfig}
                    />
                    <RuntimeSettingsPane
                      value={runtimeSettings}
                      language={appShellSettings.appLanguage}
                      adapters={runtimeAdapters}
                      onChange={setRuntimeSettings}
                      onSave={props.onSaveRuntimeSettings}
                      onSaveStateChange={setRuntimeSaveState}
                    />
                  </section>
                ) : null}
                {settingsCategory === 'browser' ? <BrowserSettingsPane language={appShellSettings.appLanguage} /> : null}
                {settingsCategory === 'models' ? (
                  <>
                    <header className="settings-page-heading">
                      <span>
                        <h2 className="settings-page-title">{settingsWorkspaceCopy.categories.models}</h2>
                        <p>{appShellSettings.appLanguage === 'zh-CN' ? '管理模型服务与可用模型。' : 'Manage model providers and available models.'}</p>
                      </span>
                      <SettingsSaveStatus status={modelSaveState} language={appShellSettings.appLanguage} />
                    </header>
                    <CodexAccountSettings controller={modelSetup} />
                    <ModelConnectionsSettingsPane language={appShellSettings.appLanguage} client={props.nativeConversationClient ?? null} onSaveStateChange={setModelSaveState} />
                  </>
                ) : null}
                {settingsCategory === 'zentao' ? <ZentaoSettingsPane language={appShellSettings.appLanguage} client={props.nativeConversationClient ?? null} /> : null}
                {settingsCategory === 'im' ? <ImRobotSettingsPane client={props.commandClient ?? null} language={appShellSettings.appLanguage} /> : null}
                {settingsCategory === 'commands' && props.commandClient ? <CommandCenterPanel mode="global" client={props.commandClient} language={appShellSettings.appLanguage} /> : null}
                {settingsCategory === 'release' ? (
                  <section className="settings-product-pane" aria-label={settingsWorkspaceCopy.categories.release}>
                    <h2 className="settings-page-title">{settingsWorkspaceCopy.categories.release}</h2>
                    {releaseLoadState !== 'ready' ? (
                      <section className="settings-product-section" aria-busy={releaseLoadState === 'loading'}>
                        <p role="status">
                          {appShellSettings.appLanguage === 'zh-CN'
                            ? releaseLoadState === 'loading'
                              ? '正在读取发布与更新状态…'
                              : '无法读取发布与更新状态，请重试。'
                            : releaseLoadState === 'loading'
                              ? 'Loading release and update status…'
                              : 'Unable to load release and update status. Please retry.'}
                        </p>
                        {releaseLoadState === 'failed' ? (
                          <button type="button" onClick={() => setReleaseLoadRevision((value) => value + 1)}>
                            {appShellSettings.appLanguage === 'zh-CN' ? '重试' : 'Retry'}
                          </button>
                        ) : null}
                      </section>
                    ) : (
                      <NativeSettingsPane label={settingsWorkspaceCopy.release.paneTitle} className="deep-settings-pane release-settings-pane">
                        <section className="release-update-workbench" aria-label={settingsWorkspaceCopy.release.updateAria}>
                          <section className="release-update-command-row" aria-label={settingsWorkspaceCopy.release.updateActionAria}>
                            <span className="release-update-copy">
                              <strong>{settingsWorkspaceCopy.release.updateTitle}</strong>
                              <small>{formatReleaseUpdateReason(releaseUpdateStatus, settingsWorkspaceCopy.release)}</small>
                            </span>
                            <span className="release-update-field">
                              {/* 设置页保留发布清单证据；用户升级操作统一由 macOS 原生 Homebrew 窗口承载。 */}
                              <span>{formatReleaseUpdateLabel(releaseUpdateStatus, settingsWorkspaceCopy.release)}</span>
                              <small>{settingsWorkspaceCopy.release.installHelp()}</small>
                            </span>
                            <span className="release-update-command-rail">
                              <button type="button" onClick={() => void checkReleaseUpdate()} disabled={!props.onCheckReleaseUpdate || releaseUpdateBusy} {...controlBusyProps(releaseUpdateBusy)}>
                                {releaseUpdateCheckState === 'loading' ? settingsWorkspaceCopy.release.checking : settingsWorkspaceCopy.release.checkUpdates}
                              </button>
                            </span>
                          </section>
                          <section className="release-update-version-row" aria-label={settingsWorkspaceCopy.release.versionAria}>
                            <span className="release-update-copy">
                              <strong>{settingsWorkspaceCopy.release.versionTitle}</strong>
                              <small>
                                {releaseUpdateStatus.checkedAt
                                  ? settingsWorkspaceCopy.release.checkedAt(formatArchivedConversationDate(releaseUpdateStatus.checkedAt, appShellSettings.appLanguage))
                                  : settingsWorkspaceCopy.release.notChecked}
                              </small>
                            </span>
                            <span className="release-update-field">
                              <span>{settingsWorkspaceCopy.release.currentVersion(releaseUpdateStatus.currentVersion)}</span>
                              <span>{settingsWorkspaceCopy.release.latestVersion(releaseUpdateStatus.latestVersion)}</span>
                              <small>{formatReleaseUpdateChannel(releaseUpdateStatus.channel, settingsWorkspaceCopy.release)}</small>
                            </span>
                            <span className="release-update-command-rail">
                              <a href={releaseUpdateStatus.releasePageUrl}>GitHub Release</a>
                            </span>
                          </section>
                        </section>
                        <section className="release-technical-details">
                          <h3>{appShellSettings.appLanguage === 'zh-CN' ? '安装包与发布详情' : 'Package and release details'}</h3>
                          <section className="release-update-artifact-row" aria-label={settingsWorkspaceCopy.release.artifactAria}>
                            <span className="release-update-copy">
                              <strong>{settingsWorkspaceCopy.release.artifactTitle}</strong>
                              <small>
                                {releaseUpdateStatus.artifact
                                  ? `${releaseUpdateStatus.artifact.arch} · ${formatReleaseArtifactKind(releaseUpdateStatus.artifact.kind, settingsWorkspaceCopy.release)}`
                                  : settingsWorkspaceCopy.release.waitingArtifact}
                              </small>
                            </span>
                            <span className="release-update-field">
                              {releaseUpdateStatus.artifact ? (
                                <>
                                  <span>{releaseUpdateStatus.artifact.fileName}</span>
                                  <small>{releaseUpdateStatus.artifact.sha256}</small>
                                </>
                              ) : (
                                <span>{settingsWorkspaceCopy.release.noArtifact}</span>
                              )}
                            </span>
                            <span className="release-update-command-rail">
                              {releaseUpdateCheckState === 'failed' ? (
                                <span role="status">{settingsWorkspaceCopy.release.updateFailed}</span>
                              ) : (
                                <span className="settings-action-meta">{settingsWorkspaceCopy.release.recommendedActions[releaseUpdateStatus.recommendedAction]}</span>
                              )}
                            </span>
                          </section>
                          <section className="settings-state-row settings-release-signing-state-row" aria-label={settingsWorkspaceCopy.release.signingAria}>
                            <strong>{settingsWorkspaceCopy.release.signingTitle}</strong>
                            <span>{formatReleasePresenceStatus('signing', releaseStatus.signing, settingsWorkspaceCopy.release)}</span>
                            <em>{settingsWorkspaceCopy.release.signingEnvironmentOnly}</em>
                          </section>
                          <section className="settings-state-row settings-release-notarization-state-row" aria-label={settingsWorkspaceCopy.release.notarizationAria}>
                            <strong>{settingsWorkspaceCopy.release.notarizationTitle}</strong>
                            <span>{formatReleasePresenceStatus('notarization', releaseStatus.notarization, settingsWorkspaceCopy.release)}</span>
                            <em>{settingsWorkspaceCopy.release.notarizationDescription}</em>
                          </section>
                          <section className="settings-state-row settings-release-cask-state-row" aria-label={settingsWorkspaceCopy.release.caskAria}>
                            <strong>{settingsWorkspaceCopy.release.caskTitle}</strong>
                            <span>{formatReleasePresenceStatus('homebrewCask', releaseStatus.homebrewCask, settingsWorkspaceCopy.release)}</span>
                            <em>{releaseStatus.readiness.canBuildUnsignedArtifacts ? settingsWorkspaceCopy.release.unsignedBuildAvailable : settingsWorkspaceCopy.release.unsignedBuildUnavailable}</em>
                          </section>
                          <section className="settings-log-row release-detail-row" aria-label={settingsWorkspaceCopy.release.detailAria}>
                            <span className="settings-row-copy">
                              <strong>{settingsWorkspaceCopy.release.detailTitle}</strong>
                              <small>{settingsWorkspaceCopy.release.detailDescription}</small>
                            </span>
                            <span className="settings-row-field settings-evidence-list">
                              <span>
                                {settingsWorkspaceCopy.release.autoUpdateReserved} · {formatReleaseAutoUpdateLabel(releaseStatus.autoUpdate, settingsWorkspaceCopy.release)}
                              </span>
                              {releaseStatus.autoUpdate.changelogPath ? <small>{releaseStatus.autoUpdate.changelogPath}</small> : null}
                              <small>{formatReleaseWaitingForItems(releaseStatus.readiness.waitingFor, settingsWorkspaceCopy.release)}</small>
                              <small>{formatReleaseWaitingForItems(releaseStatus.autoUpdate.waitingFor, settingsWorkspaceCopy.release)}</small>
                            </span>
                            <span className="settings-row-action-rail">
                              <span className="settings-action-meta">{settingsWorkspaceCopy.release.realReleaseStatus}</span>
                            </span>
                          </section>
                        </section>
                      </NativeSettingsPane>
                    )}
                  </section>
                ) : null}
                {settingsCategory === 'data' ? (
                  <section className="settings-product-pane" aria-label={settingsWorkspaceCopy.categories.data}>
                    <h2 className="settings-page-title">{settingsWorkspaceCopy.categories.data}</h2>
                    <NativeSettingsPane label={settingsWorkspaceCopy.data.paneTitle} className="deep-settings-pane data-settings-pane">
                      <section className="settings-data-portability-row" aria-label={settingsWorkspaceCopy.data.portabilityAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.data.localLogDirectoryTitle}</strong>
                          <small>{settingsWorkspaceCopy.data.localLogDirectoryDescription}</small>
                        </span>
                        <span className="settings-row-field">
                          <span>{appShellSettings.localLogDirectory}</span>
                          <small>{dataPortabilityStatusCopy}</small>
                        </span>
                        <span className="settings-row-action-rail">
                          <button type="button" onClick={exportLocalSettings} disabled={!props.onExportLocalSettings || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.data.exportSettings}
                          </button>
                          <button type="button" onClick={importLocalSettings} disabled={!props.onImportLocalSettings || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.data.importSettings}
                          </button>
                        </span>
                      </section>
                      <section className="settings-data-portability-row" aria-label={settingsWorkspaceCopy.data.cacheAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.data.cacheTitle}</strong>
                          <small>{settingsWorkspaceCopy.data.cacheDescription}</small>
                        </span>
                        <span className="settings-row-field" />
                        <span className="settings-row-action-rail">
                          <button type="button" onClick={clearNetworkCache} disabled={!window.zeus?.clearNetworkCache || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.data.clearNetworkCache}
                          </button>
                        </span>
                      </section>
                      <section className="settings-archived-conversations-row" aria-label={settingsWorkspaceCopy.data.archivedConversationsAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.data.archivedConversationsTitle}</strong>
                          <small>{settingsWorkspaceCopy.data.archivedConversationsDescription}</small>
                        </span>
                        <div className="settings-archive-filters">
                          <ZeusSelect
                            size="regular"
                            ariaLabel={appShellSettings.appLanguage === 'zh-CN' ? '筛选归档项目' : 'Filter archived projects'}
                            value={archiveProjectId}
                            onChange={(id) => {
                              setArchiveProjectId(id);
                              setArchiveRequestedPage(1);
                            }}
                            options={[
                              { value: '', label: appShellSettings.appLanguage === 'zh-CN' ? '全部项目' : 'All projects' },
                              ...Array.from(new Map(archiveItems.map(({ conversation, project }) => [conversation.projectId, { value: conversation.projectId, label: project?.name ?? conversation.projectId }])).values()),
                            ]}
                          />
                          <input
                            type="search"
                            className="settings-list-search"
                            aria-label={appShellSettings.appLanguage === 'zh-CN' ? '搜索归档会话' : 'Search archived conversations'}
                            placeholder={appShellSettings.appLanguage === 'zh-CN' ? '搜索标题、项目或任务编号' : 'Search title, project or task'}
                            value={archiveQuery}
                            onChange={(event) => {
                              setArchiveQuery(event.currentTarget.value);
                              setArchiveRequestedPage(1);
                            }}
                          />
                        </div>
                        <span className="settings-archived-conversation-list" aria-live="polite">
                          {archivedConversationLoadState === 'loading' ? <small>{settingsWorkspaceCopy.data.loadingArchivedConversations}</small> : null}
                          {archivedConversationLoadState === 'error' ? (
                            <span className="settings-archived-conversation-state">
                              <button type="button" onClick={() => void refreshArchivedConversations()}>
                                {settingsWorkspaceCopy.data.retryArchivedConversations}
                              </button>
                            </span>
                          ) : null}
                          {archivedConversationLoadState === 'ready' && filteredArchives.length === 0 ? (
                            <small>
                              {normalizedArchiveQuery || archiveProjectId ? (appShellSettings.appLanguage === 'zh-CN' ? '没有匹配的归档会话。' : 'No matching archived conversations.') : settingsWorkspaceCopy.data.emptyArchivedConversations}
                            </small>
                          ) : null}
                          {filteredArchives.slice((archivePage - 1) * settingsPageSize, archivePage * settingsPageSize).map(({ conversation, task, project }) => {
                            return (
                              <span className="settings-archived-conversation-item" key={conversation.id}>
                                <span className="settings-archived-conversation-copy">
                                  <strong>{conversationDisplayTitle(conversation.title, task?.title, appShellSettings.appLanguage)}</strong>
                                  <small>
                                    {task
                                      ? settingsWorkspaceCopy.data.archivedConversationContext(project?.name ?? conversation.projectId, task.taskCode ?? task.id)
                                      : settingsWorkspaceCopy.data.archivedProjectConversationContext(project?.name ?? conversation.projectId)}
                                  </small>
                                  <time className="settings-archive-date" dateTime={conversation.updatedAt}>
                                    {formatArchivedConversationDate(conversation.updatedAt, appShellSettings.appLanguage)}
                                  </time>
                                </span>
                                <button type="button" disabled={restoringArchivedConversationId !== null} onClick={() => void restoreTaskConversation(conversation)}>
                                  {restoringArchivedConversationId === conversation.id ? settingsWorkspaceCopy.data.restoringArchivedConversation : settingsWorkspaceCopy.data.restoreArchivedConversation}
                                </button>
                              </span>
                            );
                          })}
                        </span>
                        <SettingsPagination
                          label={settingsWorkspaceCopy.data.archivedConversationsTitle}
                          language={appShellSettings.appLanguage}
                          total={filteredArchives.length}
                          page={archivePage}
                          onChange={setArchiveRequestedPage}
                          disabled={archivedConversationLoadState === 'loading'}
                        />
                      </section>
                    </NativeSettingsPane>
                  </section>
                ) : null}
              </div>
            </section>
          </section>
        ) : null}
      </section>
    </main>
  );
}
