import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
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
import { CodexRemoteControlSettings } from '../../settings/CodexRemoteControlSettings.js';
import { ModelConnectionsSettingsPane } from '../../settings/ModelConnectionsSettingsPane.js';
import { ZentaoSettingsPane } from '../../settings/ZentaoSettingsPane.js';
import { TaskManagementStatusEditor } from '../../settings/TaskManagementStatusEditor.js';
import { CodexUsageSettingsPane } from '../../settings/CodexUsageSettingsPane.js';
import { MemorySettingsPane } from '../memory/MemorySettingsPane.js';
import { DigitalEmployeeTemplatesSettings } from '../digital-employees/DigitalEmployeeTemplatesSettings.js';
import { ProjectDigitalEmployeesPanel } from '../digital-employees/ProjectDigitalEmployeesPanel.js';
import { SkillsWorkspace } from '../skills/SkillsWorkspace.js';
import { defaultTaskTableEnumSortOrders, normalizeTaskTableEnumSortOrders } from '../../task/taskWorkspaceModel.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { taskAgentRunStatusLabels } from '../../task/TaskRunStatusChip.js';
import { WorkspaceDrawer } from '../../ui/WorkspaceDrawer.js';
import { CommandCenterPanel } from '../../CommandCenterPanel.js';
import { ProjectSourceWorkspace } from '../../code/ProjectSourceWorkspace.js';
import {
  formatRuntimeAdapterDetectionFacts,
  formatRuntimeDefaultArgs,
  formatRuntimeTerminalEnv,
  InlineRecoveryPrompt,
  normalizeRuntimeSettingNumber,
  parseRuntimeDefaultArgsText,
  parseRuntimeTerminalEnvText,
  ProjectCreateDialog,
  ProjectWorkspaceModeToolbar,
  SidebarNav,
} from './WorkspaceChrome.js';
import { formatGraphConversationStatus, GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE } from './workspaceFormatters.js';
import { handleInlineRailKeyboardNavigation, RuntimeXtermPane } from '../graph/GraphCanvas.js';
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
  formatRuntimeAdapterDisplayName,
  formatRuntimeSessionStatus,
  NativeControlRow,
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
} from './workspaceSupport.js';
import type { WorkspaceQueryState } from './useWorkspaceQueryState.js';
import type { WorkspaceDomainActions } from './useWorkspaceDomainActions.js';
import type { WorkspaceOperations } from './useWorkspaceOperations.js';
export function WorkspaceView(input: { state: WorkspaceQueryState; domainActions: WorkspaceDomainActions; operations: WorkspaceOperations }) {
  const { state, domainActions, operations } = input;
  const {
    actionState,
    activeGraphView,
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
    creatingGitConfirmationBusy,
    creatingProjectBusy,
    creatingTaskBusy,
    currentProjectTasks,
    currentTaskConversationChoices,
    dataPortabilityStatusCopy,
    expandedTaskIds,
    externalApiKeyInput,
    genericShellCriticalConfirmed,
    genericShellRisk,
    gitBranchName,
    gitDiffCopy,
    gitRemote,
    gitTargetRef,
    graphAnswer,
    graphConversations,
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
    scanBusy,
    scanState,
    secondaryDrawerCopy,
    securityAuditLogs,
    securitySecrets,
    selectNoResults,
    selectSearchPlaceholder,
    selectedNativeConversation,
    selectedNativeConversationId,
    selectedProject,
    selectedTaskIds,
    sessionWorkspaceCopy,
    setActiveNavTarget,
    setActiveProjectSection,
    setAppShellSettings,
    setConversationDrawer,
    setExternalApiKeyInput,
    setGitBranchName,
    setGitRemote,
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
    setTelegramAllowedUserIdsInput,
    setTelegramNotificationChatIdsInput,
    setTelegramTokenInput,
    settingsCategory,
    settingsWorkspaceCopy,
    snapshot,
    sourceWorkspaceLeaveDialogOpen,
    sourceWorkspaceSaveBusy,
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
    taskGitMergeTaskId,
    taskGitReviewState,
    taskModelPushAnnouncement,
    taskModelPushCapabilities,
    taskModelPushConfigImportNeedsActivation,
    taskModelPushConfigImportPreview,
    taskModelPushError,
    taskModelPushForm,
    taskModelPushRefreshingRepositoryId,
    taskModelPushRuntimeCapabilities,
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
    taskViewMode,
    taskWorkspaceCopy,
    telegramAllowedUserIdsInput,
    telegramNotificationChatIdsInput,
    telegramPollingLogs,
    telegramPollingStatus,
    telegramTestStatus,
    telegramTokenInput,
    uiCopy,
    updatingTaskBusy,
    visibleTasks,
    visitedCodeWorkspaceModes,
    workspaceScrollRef,
  } = state;
  const {
    addTaskCreateAttachments,
    applyZentaoTaskExtract,
    archiveConversation,
    authorizeTaskCreateFiles,
    cancelTaskModelPushAuthentication,
    cancelTaskModelPushCodexConfigImport,
    changedFiles,
    chooseProjectDirectoryForCreate,
    closeProjectCreateDialog,
    closeTaskCreateModal,
    closeTaskGitReview,
    closeTaskModelPush,
    codeMapActionLabel,
    createCurrentProject,
    currentRuntimeAdapterDisplayName,
    deleteProject,
    effectiveTaskStatusSettingsTargetId,
    importTaskModelPushCodexConfig,
    loadGraphConversationDetail,
    materializeTaskCreateResources,
    openProjectCreateDialog,
    openTaskConflictAiConversation,
    openTaskConversationDrawer,
    openTaskCreateModal,
    openTaskDetailPane,
    openZentaoLinkInBrowser,
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
    revealProjectInFinder,
    selectNativeConversation,
    selectProjectCodeWorkspaceMode,
    skipTaskModelPushCodexConfigImport,
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
    clearExternalApiKey,
    clearLocalCaches,
    clearNetworkCache,
    clearTaskSelection,
    clearTelegramBotToken,
    closeTaskDetail,
    confirmAndStartGenericRuntime,
    copyRuntimeLogs,
    createGenericRuntimeConfirmation,
    createGitConfirmation,
    createTaskFromRuntimeSession,
    createTaskFromTemplate,
    deleteRuntimeSession,
    deleteTaskWithRelationshipStrategy,
    discardSourceWorkspaceAndLeave,
    discardTaskTableLayoutAndLeave,
    exportLocalSettings,
    exportRuntimeLogs,
    generateRuntimeSessionSummary,
    handleCodeMapAction,
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
    renderProjectCodeMapStage,
    renderTaskDetailPaneContent,
    repositoryPickerLabel,
    resetProjectSidebarWidth,
    resetSecurity,
    resizeRuntimeSession,
    restoreRuntimeSession,
    runBulkTaskDelete,
    runBulkTaskStatusChange,
    saveAppShellSettings,
    saveExternalApiKey,
    saveRuntimeSettings,
    saveSourceWorkspaceAndLeave,
    saveTaskPageViewMode,
    saveTaskStatusFilter,
    saveTaskTableLayout,
    saveTaskViewPreferences,
    saveTelegramBotToken,
    saveTelegramNotificationSettings,
    saveTelegramSecuritySettings,
    sendRuntimeInput,
    setRuntimeSessionFavorite,
    startCodexLegacyImport,
    startRuntimeSession,
    stopRuntimeSession,
    testTelegramConnection,
    toggleAllVisibleTaskSelection,
    toggleCollapsedProject,
    togglePinnedProject,
    toggleSidebarConversationOrganization,
    toggleSidebarConversationStatusGroup,
    toggleTaskSelection,
    updateTaskBoardSettings,
    updateTaskManagementStatusConfigDraft,
    workspaceDrawerPortalStyle,
  } = operations;
  return (
    <main
      className={`zeus-shell ai-native-shell macos-ai-app codex-thread-workbench code-map-product-shell theme-${appShellSettings.appearance}${activeNavTarget === 'settings' ? ' settings-dedicated-shell' : ''}${activeNavTarget === 'skills' ? ' skills-dedicated-shell' : ''}${activeProjectSection === 'sessions' && activeNavTarget !== 'settings' && activeNavTarget !== 'skills' ? ' session-codex-parity-v1' : ''}`}
      data-theme={appShellSettings.appearance}
      data-language={appShellSettings.appLanguage}
      data-project-sidebar-resizing={projectSidebarResizing ? 'true' : 'false'}
      style={projectSidebarShellStyle}
      lang={uiCopy.documentLang}
      aria-label={uiCopy.shellAriaLabel}
    >
      <div className="window-drag-strip" aria-hidden="true" onPointerDown={handleWindowDragPointerDown} />
      <output className="sr-only" aria-live="polite" aria-atomic="true">
        {taskModelPushAnnouncement}
      </output>
      {nativeConversationStatusSyncState !== 'connected' ? (
        <output className="conversation-status-sync-indicator" data-state={nativeConversationStatusSyncState} role="status" aria-live="polite" aria-atomic="true">
          <span className="conversation-status-sync-spinner" aria-hidden="true" />
          <span>{appShellSettings.appLanguage === 'zh-CN' ? '正在同步会话状态' : 'Syncing conversation status'}</span>
        </output>
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
        title={appShellSettings.appLanguage === 'zh-CN' ? '源码修改尚未保存' : 'Source changes are not saved'}
        description={
          appShellSettings.appLanguage === 'zh-CN'
            ? '离开代码页、切换项目或退出应用前，请保存全部文件、放弃草稿，或取消本次操作。切换图谱和命令不会触发此提示。'
            : 'Before leaving the code page, switching projects, or quitting, save all files, discard drafts, or cancel. Switching Graph or Commands keeps the drafts.'
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
        {activeNavTarget === 'skills' ? <SkillsWorkspace client={props.nativeConversationClient ?? null} language={appShellSettings.appLanguage} onChooseDirectory={props.onChooseProjectDirectory} /> : null}
        {activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && selectedProject ? (
          <ProjectWorkspaceModeToolbar
            project={selectedProject}
            section={activeProjectSection}
            codeMode={projectCodeWorkspaceMode}
            language={appShellSettings.appLanguage}
            onOpen={(section, codeMode) => openProjectSection(selectedProject, section, codeMode)}
          />
        ) : null}
        {activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && activeProjectSection === 'code' && selectedProject ? (
          <section className="workspace-view workspace-view-project-code project-code-workspace" aria-label={codeWorkspaceCopy.projectCodeAria}>
            <div className="project-code-mode-host">
              <div className="project-code-mode-pane" hidden={projectCodeWorkspaceMode !== 'source'}>
                <ProjectSourceWorkspace
                  key={selectedProject.id}
                  ref={projectSourceWorkspaceRef}
                  project={selectedProject}
                  language={appShellSettings.appLanguage}
                  preference={appShellSettings.codeWorkspaceByProject?.[selectedProject.id]}
                  onPreferenceChange={(preference) => persistCodeWorkspacePreference(selectedProject.id, preference)}
                  onDirtyChange={setSourceWorkspaceDirty}
                  onOpenExternal={(relativePath, line) => void props.onOpenGraphSource?.({ sourceRef: relativePath, lineStart: line, projectRoot: selectedProject.localPath })}
                />
              </div>
              {visitedCodeWorkspaceModes.has('graph') ? (
                <div className="project-code-mode-pane project-code-graph-pane" hidden={projectCodeWorkspaceMode !== 'graph'}>
                  {activeGraphView ? (
                    renderProjectCodeMapStage()
                  ) : (
                    <section className="project-code-mode-empty" aria-live="polite">
                      <strong>{scanBusy ? codeWorkspaceCopy.scanning : codeWorkspaceCopy.graphTitle}</strong>
                      <span>{scanState === 'failed' ? codeWorkspaceCopy.retryScan : codeWorkspaceCopy.waitingRealScan}</span>
                      <Button variant="primary" busy={scanBusy} onClick={() => void selectProjectCodeWorkspaceMode('graph')}>
                        {codeMapActionLabel()}
                      </Button>
                    </section>
                  )}
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

        {activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && activeProjectSection === 'git' && selectedProject && props.nativeConversationClient ? (
          <section className="workspace-view workspace-view-project-git">
            <ProjectGitWorkbench project={selectedProject} client={props.nativeConversationClient} language={appShellSettings.appLanguage} />
          </section>
        ) : null}

        {activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && activeProjectSection === 'project-settings' ? (
          <section className="workspace-view workspace-view-project-settings" aria-label={codeWorkspaceCopy.projectSettingsAria}>
            <section className="workspace-detail-pane project-detail-pane" aria-label={codeWorkspaceCopy.detailAria}>
              {selectedProject ? (
                <ProjectDigitalEmployeesPanel
                  projectId={selectedProject.id}
                  projectName={selectedProject.name}
                  client={props.commandClient ?? null}
                  skillClient={props.nativeConversationClient ?? null}
                  language={appShellSettings.appLanguage}
                />
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
        {activeNavTarget !== 'settings' && activeNavTarget !== 'skills' && (activeProjectSection === 'tasks' || activeProjectSection === 'sessions') ? (
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
                      viewMode={taskViewMode}
                      taskBoardSnapshot={activeProjectId ? (taskBoardSnapshots[activeProjectId] ?? null) : null}
                      taskBoardLoading={activeProjectId ? Boolean(taskBoardLoadState[activeProjectId]?.loading) : false}
                      taskBoardError={activeProjectId ? (taskBoardLoadState[activeProjectId]?.error ?? null) : null}
                      expandedTaskIds={expandedTaskIds}
                      onSearchChange={setTaskSearchQuery}
                      onStatusFilterChange={(filter) => void saveTaskStatusFilter(filter)}
                      onTagFilterChange={setTaskTagFilter}
                      onTaskTableColumnsChange={(preferences) => setTaskTableLayoutDraft({ projectId: activeProjectId, preferences })}
                      onSaveTaskTableLayout={() => setTaskTableLayoutScopeDialogOpen(true)}
                      onCreateTask={() => openTaskCreateModal()}
                      onOpenTaskDetail={(taskId, mode) => void openTaskDetailPane(taskId, mode)}
                      onOpenTaskConversation={(taskId, conversationId) => void openTaskConversationDrawer(taskId, conversationId)}
                      onViewModeChange={(viewMode) => void saveTaskViewPreferences({ viewMode })}
                      onPageViewModeChange={(viewMode) => void saveTaskPageViewMode(viewMode)}
                      onReloadTaskBoard={activeProjectId ? () => void loadTaskBoard(activeProjectId) : undefined}
                      onUpdateTaskBoard={updateTaskBoardSettings}
                      onMoveTaskBoardTask={moveTaskBoardTask}
                      onLoadTaskAttachmentPreview={props.onLoadTaskAttachmentPreview}
                      onToggleTaskExpanded={(taskId) =>
                        void saveTaskViewPreferences({
                          expandedTaskIds: expandedTaskIds.includes(taskId) ? expandedTaskIds.filter((id) => id !== taskId) : [...expandedTaskIds, taskId],
                        })
                      }
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
                    open={taskCreateModalOpen}
                    copy={taskWorkspaceCopy}
                    form={taskCreateForm}
                    parentTasks={currentProjectTasks.filter((task) => taskHierarchyDepth(task, currentProjectTasks) < 3)}
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
                    onParseZentaoLink={(url) => props.onParseZentaoTaskLink?.(url) ?? Promise.resolve({ kind: 'unsupported', sourceUrl: url })}
                    onApplyZentaoTaskInfo={applyZentaoTaskExtract}
                    onOpenZentaoLink={openZentaoLinkInBrowser}
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
                </>
              ) : (
                renderNativeConversationWorkspace((taskId) => void openTaskDetailPane(taskId))
              )}

              <TaskModelPushModal
                open={Boolean(taskModelPushTaskId)}
                language={appShellSettings.appLanguage}
                task={snapshot.tasks.find((task) => task.id === taskModelPushTaskId) ?? null}
                projectName={snapshot.projects.find((project) => project.id === snapshot.tasks.find((task) => task.id === taskModelPushTaskId)?.projectId)?.name}
                capabilities={taskModelPushCapabilities}
                runtimeCapabilities={taskModelPushRuntimeCapabilities}
                form={taskModelPushForm}
                status={taskModelPushStatus}
                configImportPreview={taskModelPushConfigImportPreview}
                configImportNeedsActivation={taskModelPushConfigImportNeedsActivation}
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
                onRefreshRepository={(repositoryId) => void refreshTaskModelPushRepository(repositoryId)}
                onClose={closeTaskModelPush}
                onCancelAuthentication={cancelTaskModelPushAuthentication}
                onCancelCodexConfigImport={cancelTaskModelPushCodexConfigImport}
                onImportCodexConfig={() => void importTaskModelPushCodexConfig()}
                onSkipCodexConfigImport={skipTaskModelPushCodexConfigImport}
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
                onClose={() => setTaskGitMergeTaskId(null)}
              />
              {taskDetailPaneTask && taskDetailPresentation === 'side_peek' ? (
                <WorkspaceDrawer
                  presentation="floating"
                  backdrop="dimmed"
                  size="standard"
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
                          <em>{runtime.aiCli.reason}</em>
                        </div>
                        <div className="runtime-capability-state-row">
                          <strong>{sessionWorkspaceCopy.runtimeDrawer.terminalBackend}</strong>
                          <span>{runtime.terminal?.provider ?? 'child_process'}</span>
                          <em>{runtime.terminal?.pty.reason ?? sessionWorkspaceCopy.runtimeDrawer.terminalPending}</em>
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

                  {conversationDrawer === 'context' ? (
                    <section className="product-drawer-pane conversation-drawer-sheet conversation-drawer-sheet-context conversation-context-workbench" aria-label={secondaryDrawerCopy.contextLabel}>
                      <div className="drawer-header-row">
                        <strong>{secondaryDrawerCopy.contextLabel}</strong>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveNavTarget('projects');
                            setActiveProjectSection('code');
                            void handleCodeMapAction();
                          }}
                        >
                          {secondaryDrawerCopy.openGraph}
                        </button>
                      </div>
                      <section className="conversation-context-scope-row" aria-label={secondaryDrawerCopy.graphScopeAria}>
                        <span className="conversation-context-row-copy">
                          <strong>{secondaryDrawerCopy.graphContextTitle}</strong>
                          <small>{secondaryDrawerCopy.graphContextHelp}</small>
                        </span>
                        <span className="conversation-context-row-meta">{secondaryDrawerCopy.graphContextMetrics(snapshot.graph.nodeCount, snapshot.graph.edgeCount, snapshot.graph.viewCount)}</span>
                      </section>
                      {graphAnswer ? (
                        <div className="graph-context-answer-row conversation-context-answer-row">
                          <span className="conversation-context-row-copy">
                            <strong>{secondaryDrawerCopy.graphAnswerTitle}</strong>
                            <small>{graphAnswer.sessionId ? secondaryDrawerCopy.runtimeSession(graphAnswer.sessionId) : secondaryDrawerCopy.insufficientRuntimeSession}</small>
                          </span>
                          <span className="conversation-context-row-meta">{graphAnswer.answer}</span>
                        </div>
                      ) : null}
                      {graphConversations.length > 0 ? (
                        <div className="conversation-context-graph-list" aria-label={secondaryDrawerCopy.graphConversationListAria}>
                          {graphConversations.slice(0, 4).map((conversation) => (
                            <button type="button" className="conversation-context-graph-row" key={conversation.id} onClick={() => loadGraphConversationDetail(conversation.id)}>
                              {/* 上下文抽屉只提供图谱问答来源选择：标题、摘要和状态同一行呈现，避免回退成通用对象卡片。 */}
                              <span className="conversation-context-graph-copy">
                                <strong>{conversation.title}</strong>
                                <small>{conversation.summary || conversation.sessionId || conversation.projectId}</small>
                              </span>
                              <span className="conversation-context-graph-meta">
                                <span>{formatGraphConversationStatus(conversation.status, appShellSettings.appLanguage)}</span>
                                <small>{conversation.archived ? secondaryDrawerCopy.archived : secondaryDrawerCopy.openable}</small>
                              </span>
                            </button>
                          ))}
                        </div>
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
                <input className="settings-query-control" aria-label={settingsWorkspaceCopy.searchAria} placeholder={settingsWorkspaceCopy.searchPlaceholder} />
              </span>
              <nav
                className="settings-section-nav settings-sidebar-nav"
                aria-label={settingsWorkspaceCopy.categoryListAria}
                role="tablist"
                aria-orientation="vertical"
                data-inline-rail-keyboard="vertical"
                onKeyDown={handleInlineRailKeyboardNavigation}
              >
                {(
                  [
                    {
                      group: settingsWorkspaceCopy.sectionGroups.personal,
                      items: [
                        ['general', settingsWorkspaceCopy.categories.general, undefined],
                        ['usage', settingsWorkspaceCopy.categories.usage, undefined],
                        ['memory', settingsWorkspaceCopy.categories.memory, settingsWorkspaceCopy.localStatus],
                        ['tasks', settingsWorkspaceCopy.categories.tasks, undefined],
                        ['employees', settingsWorkspaceCopy.categories.employees, settingsWorkspaceCopy.localStatus],
                        ['security', settingsWorkspaceCopy.categories.security, settingsWorkspaceCopy.protectedStatus],
                      ],
                    },
                    {
                      group: settingsWorkspaceCopy.sectionGroups.integrations,
                      items: [
                        ['runtime', settingsWorkspaceCopy.categories.runtime, runtime.aiCli.available ? settingsWorkspaceCopy.protectedStatus : settingsWorkspaceCopy.waitingStatus],
                        ['models', settingsWorkspaceCopy.categories.models, settingsWorkspaceCopy.localStatus],
                        ['browser', settingsWorkspaceCopy.categories.browser, settingsWorkspaceCopy.localStatus],
                        ['telegram', settingsWorkspaceCopy.categories.telegram, runtime.telegram.enabled ? settingsWorkspaceCopy.protectedStatus : settingsWorkspaceCopy.waitingStatus],
                        ['zentao', settingsWorkspaceCopy.categories.zentao, settingsWorkspaceCopy.localStatus],
                      ],
                    },
                    {
                      group: settingsWorkspaceCopy.sectionGroups.coding,
                      items: [
                        ['commands', settingsWorkspaceCopy.categories.commands, settingsWorkspaceCopy.localStatus],
                        ['git', settingsWorkspaceCopy.categories.git, settingsWorkspaceCopy.protectedStatus],
                      ],
                    },
                    {
                      group: settingsWorkspaceCopy.sectionGroups.maintenance,
                      items: [
                        ['release', settingsWorkspaceCopy.categories.release, settingsWorkspaceCopy.waitingStatus],
                        ['data', settingsWorkspaceCopy.categories.data, settingsWorkspaceCopy.localStatus],
                      ],
                    },
                  ] as Array<{ group: string; items: Array<[SettingsCategory, string, string | undefined]> }>
                ).map((group) => (
                  <div className="settings-sidebar-group" role="presentation" key={group.group}>
                    <span className="settings-sidebar-group-title" role="presentation">
                      {group.group}
                    </span>
                    {group.items.map(([id, label, badge]) => (
                      <button
                        key={id}
                        type="button"
                        className={`settings-section-button ${settingsCategory === id ? 'selected' : ''}`}
                        role="tab"
                        aria-selected={settingsCategory === id}
                        tabIndex={settingsCategory === id ? 0 : -1}
                        data-inline-rail-item="true"
                        onClick={() => setSettingsCategory(id)}
                      >
                        <span className="settings-section-icon" aria-hidden="true" />
                        <span className="settings-section-label">{label}</span>
                        {badge ? <span className="settings-section-badge">{badge}</span> : null}
                      </button>
                    ))}
                  </div>
                ))}
              </nav>
            </aside>
            <section className="settings-detail-pane" aria-label={settingsWorkspaceCopy.detailPaneAria}>
              <div className="settings-content-column">
                {settingsCategory === 'general' ? (
                  <section className="settings-product-pane" aria-label={settingsWorkspaceCopy.categories.general}>
                    <h2 className="settings-page-title">{settingsWorkspaceCopy.categories.general}</h2>
                    <section className="settings-mode-pane" aria-labelledby="settings-work-mode-title">
                      <header className="settings-section-heading">
                        <strong id="settings-work-mode-title">{settingsWorkspaceCopy.workModeTitle}</strong>
                        <span>{settingsWorkspaceCopy.workModeDescription}</span>
                      </header>
                      <div className="settings-mode-row">
                        <button
                          type="button"
                          className={`settings-mode-card ${appShellSettings.developerModeEnabled ? 'selected' : ''}`}
                          aria-pressed={appShellSettings.developerModeEnabled}
                          onClick={() =>
                            setAppShellSettings((current) => ({
                              ...current,
                              developerModeEnabled: true,
                            }))
                          }
                        >
                          <span className="settings-mode-icon" aria-hidden="true" />
                          <span className="settings-mode-copy">
                            <strong>{settingsWorkspaceCopy.engineeringModeTitle}</strong>
                            <small>{settingsWorkspaceCopy.engineeringModeDescription}</small>
                          </span>
                          <span className="settings-mode-radio" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className={`settings-mode-card ${!appShellSettings.developerModeEnabled ? 'selected' : ''}`}
                          aria-pressed={!appShellSettings.developerModeEnabled}
                          onClick={() =>
                            setAppShellSettings((current) => ({
                              ...current,
                              developerModeEnabled: false,
                            }))
                          }
                        >
                          <span className="settings-mode-icon" aria-hidden="true" />
                          <span className="settings-mode-copy">
                            <strong>{settingsWorkspaceCopy.dailyModeTitle}</strong>
                            <small>{settingsWorkspaceCopy.dailyModeDescription}</small>
                          </span>
                          <span className="settings-mode-radio" aria-hidden="true" />
                        </button>
                      </div>
                    </section>
                    <section className="settings-product-section" aria-labelledby="settings-permissions-title">
                      <header className="settings-section-heading">
                        <strong id="settings-permissions-title">{settingsWorkspaceCopy.permissionsTitle}</strong>
                      </header>
                      <NativeSettingsPane label={settingsWorkspaceCopy.permissionsTitle} className="settings-permission-pane">
                        <NativeControlRow title={settingsWorkspaceCopy.defaultPermissionTitle} description={settingsWorkspaceCopy.defaultPermissionDescription} className="settings-permission-row">
                          <span className="settings-row-status">{settingsWorkspaceCopy.protectedStatus}</span>
                        </NativeControlRow>
                        <NativeControlRow title={settingsWorkspaceCopy.autoReviewTitle} description={settingsWorkspaceCopy.autoReviewDescription} className="settings-permission-row">
                          <span className="settings-row-status">{runtimeSettings.autoConfirmationPolicy === 'never' ? settingsWorkspaceCopy.waitingStatus : settingsWorkspaceCopy.protectedStatus}</span>
                        </NativeControlRow>
                        <NativeControlRow title={settingsWorkspaceCopy.fullAccessTitle} description={settingsWorkspaceCopy.fullAccessDescription} className="settings-permission-row settings-permission-danger-row">
                          <span className="settings-row-status">{settingsWorkspaceCopy.waitingStatus}</span>
                        </NativeControlRow>
                      </NativeSettingsPane>
                    </section>
                    <section className="settings-product-section" aria-labelledby="settings-general-title">
                      <header className="settings-section-heading">
                        <strong id="settings-general-title">{settingsWorkspaceCopy.generalPaneTitle}</strong>
                      </header>
                      <NativeSettingsPane label={settingsWorkspaceCopy.generalPaneTitle}>
                        <NativeControlRow title={settingsWorkspaceCopy.appLanguageTitle} description={settingsWorkspaceCopy.appLanguageDescription}>
                          <ZeusSelect
                            size="roomy"
                            ariaLabel={settingsWorkspaceCopy.appLanguageTitle}
                            value={appShellSettings.appLanguage}
                            onChange={(value) =>
                              setAppShellSettings((current) => ({
                                ...current,
                                appLanguage: value,
                              }))
                            }
                            searchPlaceholder={selectSearchPlaceholder}
                            emptyLabel={selectNoResults}
                            options={[
                              { value: 'zh-CN', label: uiCopy.languages['zh-CN'] },
                              { value: 'en-US', label: uiCopy.languages['en-US'] },
                            ]}
                          />
                        </NativeControlRow>
                        <NativeControlRow title={settingsWorkspaceCopy.appearanceTitle} description={settingsWorkspaceCopy.appearanceDescription}>
                          <ZeusSelect
                            size="roomy"
                            ariaLabel={settingsWorkspaceCopy.appearanceTitle}
                            value={appShellSettings.appearance}
                            onChange={(value) =>
                              setAppShellSettings((current) => ({
                                ...current,
                                appearance: value,
                              }))
                            }
                            searchPlaceholder={selectSearchPlaceholder}
                            emptyLabel={selectNoResults}
                            options={[
                              { value: 'system', label: uiCopy.appearance.system },
                              { value: 'light', label: uiCopy.appearance.light },
                              { value: 'dark', label: uiCopy.appearance.dark },
                            ]}
                          />
                        </NativeControlRow>
                        <NativeControlRow title={settingsWorkspaceCopy.desktopNotificationsTitle} description={settingsWorkspaceCopy.desktopNotificationsDescription}>
                          <span className="settings-switch-control" aria-label={settingsWorkspaceCopy.desktopNotificationsSwitchAria}>
                            <span className="settings-switch-copy">
                              <strong>{appShellSettings.desktopNotificationsEnabled ? settingsWorkspaceCopy.notificationsEnabled : settingsWorkspaceCopy.notificationsDisabled}</strong>
                              <small>{appShellSettings.desktopNotificationsEnabled ? settingsWorkspaceCopy.notificationsEnabledHelp : settingsWorkspaceCopy.notificationsDisabledHelp}</small>
                            </span>
                            <span className="settings-switch-state">
                              <input
                                className="native-switch-input"
                                aria-label={settingsWorkspaceCopy.desktopNotificationsInputAria}
                                type="checkbox"
                                checked={appShellSettings.desktopNotificationsEnabled}
                                onChange={(event) =>
                                  setAppShellSettings((current) => ({
                                    ...current,
                                    desktopNotificationsEnabled: event.currentTarget.checked,
                                  }))
                                }
                              />
                              {/* 开关保留原生 checkbox 可访问性，外层只承担状态文案和布局。 */}
                              <span className="native-switch-track" aria-hidden="true" />
                            </span>
                          </span>
                        </NativeControlRow>
                        <NativeControlRow title={settingsWorkspaceCopy.saveSettingsTitle} description={settingsWorkspaceCopy.saveSettingsDescription}>
                          <button type="button" onClick={saveAppShellSettings} disabled={!props.onSaveAppShellSettings || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.save}
                          </button>
                        </NativeControlRow>
                      </NativeSettingsPane>
                    </section>
                  </section>
                ) : null}
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
                    <h2 className="settings-page-title">{settingsWorkspaceCopy.categories.tasks}</h2>
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
                        onChange={updateTaskManagementStatusConfigDraft}
                      />
                    </section>
                    <section className="settings-product-section" aria-labelledby="task-list-sort-settings-title">
                      <header className="settings-section-heading">
                        <strong id="task-list-sort-settings-title">{appShellSettings.appLanguage === 'zh-CN' ? '其他枚举升序规则' : 'Other enum ascending order'}</strong>
                        <span>
                          {appShellSettings.appLanguage === 'zh-CN'
                            ? '优先级和运行状态仍为系统固定值；拖动定义升序，降序会反转该顺序。此设置对所有项目生效。'
                            : 'Priority and run status remain fixed system values. Drag to define ascending order; descending reverses it. This applies to every project.'}
                        </span>
                      </header>
                      <div className="task-enum-order-grid task-enum-order-grid-secondary">
                        <TaskEnumOrderEditor
                          language={appShellSettings.appLanguage}
                          title={appShellSettings.appLanguage === 'zh-CN' ? '优先级' : 'Priority'}
                          description={appShellSettings.appLanguage === 'zh-CN' ? 'P0 至 P4 的业务顺序' : 'Business order for P0 through P4'}
                          items={taskTableEnumSortOrders.priority.map((value) => ({ value, label: taskPriorityLabels[value] }))}
                          onChange={(priority) =>
                            setAppShellSettings((current) => ({
                              ...current,
                              taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders({ ...current.taskTableEnumSortOrders, priority }),
                            }))
                          }
                        />
                        <TaskEnumOrderEditor
                          language={appShellSettings.appLanguage}
                          title={appShellSettings.appLanguage === 'zh-CN' ? '运行状态' : 'Run status'}
                          description={appShellSettings.appLanguage === 'zh-CN' ? 'Coding Agent 运行阶段顺序' : 'Coding Agent runtime stage order'}
                          items={taskTableEnumSortOrders.runStatus.map((value) => ({ value, label: taskAgentRunStatusLabels[appShellSettings.appLanguage][value] }))}
                          onChange={(runStatus) =>
                            setAppShellSettings((current) => ({
                              ...current,
                              taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders({ ...current.taskTableEnumSortOrders, runStatus }),
                            }))
                          }
                        />
                      </div>
                      <div className="task-list-settings-actions">
                        <Button
                          variant="secondary"
                          size="compact"
                          onClick={() =>
                            setAppShellSettings((current) => ({
                              ...current,
                              taskTableEnumSortOrders: defaultTaskTableEnumSortOrders,
                            }))
                          }
                        >
                          {appShellSettings.appLanguage === 'zh-CN' ? '恢复默认顺序' : 'Restore default order'}
                        </Button>
                        <Button variant="primary" size="compact" onClick={() => void saveAppShellSettings()} disabled={!props.onSaveAppShellSettings || loadingRuntimeBusy} busy={loadingRuntimeBusy}>
                          {settingsWorkspaceCopy.save}
                        </Button>
                      </div>
                    </section>
                  </section>
                ) : null}
                {settingsCategory === 'runtime' ? (
                  <section className="settings-product-pane" aria-label={settingsWorkspaceCopy.categories.runtime}>
                    <NativeSettingsPane label={settingsWorkspaceCopy.runtime.paneTitle} className="deep-settings-pane runtime-settings-pane">
                      <section className="settings-state-row settings-runtime-cli-state-row" aria-label={settingsWorkspaceCopy.runtime.cliStatusAria}>
                        <strong>{runtime.aiCli.name}</strong>
                        <span>{runtime.aiCli.available ? settingsWorkspaceCopy.runtime.detected : settingsWorkspaceCopy.runtime.waitingConfiguration}</span>
                        <em>{runtime.aiCli.reason}</em>
                      </section>
                      <section className="settings-config-row runtime-adapter-select-row" aria-label={settingsWorkspaceCopy.runtime.defaultAdapterAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.runtime.defaultAdapterTitle}</strong>
                          <small>{settingsWorkspaceCopy.runtime.defaultAdapterDescription}</small>
                        </span>
                        <span className="settings-row-field">
                          <ZeusSelect
                            size="roomy"
                            ariaLabel={settingsWorkspaceCopy.runtime.defaultAdapterAria}
                            value={runtimeSettings.defaultAdapterId}
                            onChange={(value) =>
                              setRuntimeSettings((current) => ({
                                ...current,
                                defaultAdapterId: value,
                              }))
                            }
                            searchPlaceholder={selectSearchPlaceholder}
                            emptyLabel={selectNoResults}
                            options={
                              runtimeAdapters.length === 0
                                ? [{ value: 'codex', label: settingsWorkspaceCopy.runtime.codexCliDisplayName }]
                                : runtimeAdapters.map((adapter) => ({
                                    value: adapter.id,
                                    label: formatRuntimeAdapterDisplayName(adapter.id, runtimeAdapters, settingsWorkspaceCopy.runtime),
                                  }))
                            }
                          />
                        </span>
                        <span className="settings-row-action-rail">
                          <span className="settings-action-meta">{settingsWorkspaceCopy.runtime.adapterActionMeta}</span>
                        </span>
                      </section>
                      <section className="settings-state-row settings-runtime-default-state-row" aria-label={settingsWorkspaceCopy.runtime.currentDefaultAria}>
                        <strong>{settingsWorkspaceCopy.runtime.currentDefaultTitle}</strong>
                        <span>{currentRuntimeAdapterDisplayName}</span>
                        <em>{settingsWorkspaceCopy.runtime.currentDefault(currentRuntimeAdapterDisplayName)}</em>
                      </section>
                      <section className="settings-config-row runtime-adapter-model-row" aria-label={settingsWorkspaceCopy.runtime.adapterModelAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.runtime.adapterModelTitle}</strong>
                          <small>{settingsWorkspaceCopy.runtime.adapterModelDescription}</small>
                        </span>
                        <span className="settings-row-field">
                          <input
                            aria-label={settingsWorkspaceCopy.runtime.adapterModelAria}
                            value={runtimeSettings.adapterModels[runtimeSettings.defaultAdapterId] ?? ''}
                            onChange={(event) =>
                              setRuntimeSettings((current) => ({
                                ...current,
                                adapterModels: {
                                  ...current.adapterModels,
                                  [current.defaultAdapterId]: event.currentTarget.value,
                                },
                              }))
                            }
                          />
                        </span>
                        <span className="settings-row-action-rail">
                          <span className="settings-action-meta">{settingsWorkspaceCopy.runtime.modelMeta}</span>
                        </span>
                      </section>
                      <section className="settings-config-row runtime-default-args-row" aria-label={settingsWorkspaceCopy.runtime.defaultArgsAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.runtime.defaultArgsTitle}</strong>
                          <small>{settingsWorkspaceCopy.runtime.defaultArgsDescription}</small>
                        </span>
                        <span className="settings-row-field">
                          <input
                            aria-label={settingsWorkspaceCopy.runtime.defaultArgsAria}
                            value={formatRuntimeDefaultArgs(runtimeSettings.adapterDefaultArgs[runtimeSettings.defaultAdapterId] ?? ['--ask-for-approval', 'never'])}
                            onChange={(event) =>
                              setRuntimeSettings((current) => ({
                                ...current,
                                adapterDefaultArgs: {
                                  ...current.adapterDefaultArgs,
                                  [current.defaultAdapterId]: parseRuntimeDefaultArgsText(event.currentTarget.value),
                                },
                              }))
                            }
                          />
                        </span>
                        <span className="settings-row-action-rail">
                          <span className="settings-action-meta">{settingsWorkspaceCopy.runtime.argsMeta}</span>
                        </span>
                      </section>
                      <section className="settings-config-row runtime-cli-path-row" aria-label={settingsWorkspaceCopy.runtime.cliPathAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.runtime.cliPathTitle}</strong>
                          <small>{settingsWorkspaceCopy.runtime.cliPathDescription}</small>
                        </span>
                        <span className="settings-row-field">
                          <input
                            aria-label={settingsWorkspaceCopy.runtime.cliPathAria}
                            value={runtimeSettings.adapterCliPaths[runtimeSettings.defaultAdapterId] ?? ''}
                            onChange={(event) =>
                              setRuntimeSettings((current) => ({
                                ...current,
                                adapterCliPaths: {
                                  ...current.adapterCliPaths,
                                  [current.defaultAdapterId]: event.currentTarget.value,
                                },
                              }))
                            }
                          />
                        </span>
                        <span className="settings-row-action-rail">
                          <span className="settings-action-meta">PATH</span>
                        </span>
                      </section>
                      <section className="settings-state-row settings-runtime-timeout-state-row" aria-label={settingsWorkspaceCopy.runtime.timeoutAria}>
                        <strong>{settingsWorkspaceCopy.runtime.timeoutTitle}</strong>
                        <span>{settingsWorkspaceCopy.runtime.seconds(runtimeSettings.executionTimeoutSeconds)}</span>
                        <em>{settingsWorkspaceCopy.runtime.logRetention(runtimeSettings.logRetentionDays)}</em>
                      </section>
                      <section className="settings-state-row settings-runtime-confirmation-policy-row" aria-label={settingsWorkspaceCopy.runtime.autoConfirmAria}>
                        <strong>{settingsWorkspaceCopy.runtime.autoConfirmTitle}</strong>
                        <span>{settingsWorkspaceCopy.runtime.autoConfirmPolicies[runtimeSettings.autoConfirmationPolicy]}</span>
                        <em>{settingsWorkspaceCopy.runtime.autoConfirmHighRiskBoundary}</em>
                      </section>
                      <section className="settings-config-row runtime-timeout-row" aria-label={settingsWorkspaceCopy.runtime.timeoutSecondsAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.runtime.timeoutSecondsTitle}</strong>
                          <small>{settingsWorkspaceCopy.runtime.timeoutSecondsDescription}</small>
                        </span>
                        <span className="settings-row-field">
                          <input
                            aria-label={settingsWorkspaceCopy.runtime.timeoutSecondsAria}
                            value={String(runtimeSettings.executionTimeoutSeconds)}
                            onChange={(event) =>
                              setRuntimeSettings((current) => ({
                                ...current,
                                executionTimeoutSeconds: normalizeRuntimeSettingNumber(event.currentTarget.value, current.executionTimeoutSeconds, 24 * 3600),
                              }))
                            }
                          />
                        </span>
                        <span className="settings-row-action-rail">
                          <span className="settings-action-meta">{settingsWorkspaceCopy.runtime.secondsUnit}</span>
                        </span>
                      </section>
                      <section className="settings-matrix-row runtime-advanced-row" aria-label={settingsWorkspaceCopy.runtime.advancedAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.runtime.advancedTitle}</strong>
                          <small>{settingsWorkspaceCopy.runtime.advancedDescription}</small>
                        </span>
                        <span className="settings-row-field settings-runtime-advanced-field-list">
                          {/* 高级 Runtime 参数保持在同一设置行内，用显式双字段区域承载真实 shell 与 env 输入，避免回到纵向表单堆。 */}
                          <span className="settings-inline-field settings-runtime-advanced-field settings-runtime-shell-field">
                            <span>{settingsWorkspaceCopy.runtime.shellPathTitle}</span>
                            <input
                              aria-label={settingsWorkspaceCopy.runtime.shellPathAria}
                              value={runtimeSettings.shell.path ?? ''}
                              onChange={(event) =>
                                setRuntimeSettings((current) => ({
                                  ...current,
                                  shell: {
                                    ...current.shell,
                                    path: event.currentTarget.value || null,
                                  },
                                }))
                              }
                            />
                          </span>
                          <span className="settings-inline-field settings-runtime-advanced-field settings-runtime-env-field">
                            <span>{settingsWorkspaceCopy.runtime.terminalEnvTitle}</span>
                            <textarea
                              aria-label={settingsWorkspaceCopy.runtime.terminalEnvAria}
                              value={formatRuntimeTerminalEnv(runtimeSettings.terminalEnv)}
                              onChange={(event) =>
                                setRuntimeSettings((current) => ({
                                  ...current,
                                  terminalEnv: parseRuntimeTerminalEnvText(event.currentTarget.value),
                                }))
                              }
                            />
                          </span>
                          <small>{settingsWorkspaceCopy.runtime.advancedHelp}</small>
                        </span>
                        <span className="settings-row-action-rail">
                          <span className="settings-action-meta">{runtimeSettings.shell.login ? settingsWorkspaceCopy.runtime.loginShell : settingsWorkspaceCopy.runtime.nonLoginShell}</span>
                        </span>
                      </section>
                      <button type="button" onClick={saveRuntimeSettings} disabled={!props.onSaveRuntimeSettings || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                        {settingsWorkspaceCopy.runtime.saveDefaultAdapter}
                      </button>
                    </NativeSettingsPane>
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
                  </section>
                ) : null}
                {settingsCategory === 'browser' ? <BrowserSettingsPane language={appShellSettings.appLanguage} /> : null}
                {settingsCategory === 'models' ? <ModelConnectionsSettingsPane language={appShellSettings.appLanguage} client={props.nativeConversationClient ?? null} /> : null}
                {settingsCategory === 'zentao' ? <ZentaoSettingsPane language={appShellSettings.appLanguage} client={props.nativeConversationClient ?? null} /> : null}
                {settingsCategory === 'telegram' ? (
                  <section className="settings-product-pane" aria-label={settingsWorkspaceCopy.categories.telegram}>
                    <NativeSettingsPane label={settingsWorkspaceCopy.telegram.paneTitle} className="deep-settings-pane telegram-settings-pane">
                      <section className="settings-secret-row telegram-secret-row" aria-label={settingsWorkspaceCopy.telegram.botTokenAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.telegram.botTokenTitle}</strong>
                          <small>{settingsWorkspaceCopy.telegram.botTokenHelp(securitySecrets.telegramBotToken.configured ? settingsWorkspaceCopy.telegram.botTokenConfigured : settingsWorkspaceCopy.telegram.botTokenNotConfigured)}</small>
                        </span>
                        <span className="settings-row-field settings-sensitive-field">
                          <span>{settingsWorkspaceCopy.telegram.tokenFieldLabel}</span>
                          <input aria-label={settingsWorkspaceCopy.telegram.botTokenAria} type="password" value={telegramTokenInput} onChange={(event) => setTelegramTokenInput(event.currentTarget.value)} />
                        </span>
                        <span className="settings-row-action-rail">
                          <button type="button" onClick={saveTelegramBotToken} disabled={!telegramTokenInput.trim() || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.telegram.saveToKeychain}
                          </button>
                          <button type="button" onClick={clearTelegramBotToken} disabled={!props.onClearTelegramBotToken || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.telegram.clearToken}
                          </button>
                        </span>
                      </section>
                      <section className="settings-secret-row telegram-chat-row" aria-label={settingsWorkspaceCopy.telegram.chatIdAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.telegram.chatIdTitle}</strong>
                          <small>{telegramTestStatus}</small>
                        </span>
                        <span className="settings-row-field settings-sensitive-field">
                          <span>{settingsWorkspaceCopy.telegram.chatIdFieldLabel}</span>
                          <input aria-label={settingsWorkspaceCopy.telegram.chatIdAria} value={telegramNotificationChatIdsInput} onChange={(event) => setTelegramNotificationChatIdsInput(event.currentTarget.value)} />
                        </span>
                        <span className="settings-row-action-rail">
                          <button type="button" onClick={saveTelegramNotificationSettings} disabled={!props.onSaveTelegramNotificationSettings || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.telegram.saveNotifications}
                          </button>
                          <button type="button" onClick={testTelegramConnection} disabled={!props.onTestTelegramConnection || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.telegram.testConnection}
                          </button>
                        </span>
                      </section>
                      <section className="settings-log-row telegram-polling-row" aria-label={settingsWorkspaceCopy.telegram.pollingAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.telegram.pollingTitle}</strong>
                          <small>{settingsWorkspaceCopy.telegram.pollingDescription}</small>
                        </span>
                        <span className="settings-row-field settings-evidence-list">
                          <span>{settingsWorkspaceCopy.telegram.pollingState(telegramPollingStatus.running, telegramPollingStatus.offset)}</span>
                          {telegramPollingLogs.length === 0 ? <small>{settingsWorkspaceCopy.telegram.emptyPollingLogs}</small> : null}
                          {telegramPollingLogs.slice(-5).map((entry, index) => (
                            <code key={`${entry.updateId ?? 'poll'}-${index}`}>{entry.command}</code>
                          ))}
                        </span>
                        <span className="settings-row-action-rail">
                          <span className="settings-action-meta">{settingsWorkspaceCopy.telegram.latestLogs}</span>
                        </span>
                      </section>
                    </NativeSettingsPane>
                  </section>
                ) : null}
                {settingsCategory === 'security' ? (
                  <section className="settings-product-pane" aria-label={settingsWorkspaceCopy.categories.security}>
                    <NativeSettingsPane label={settingsWorkspaceCopy.security.paneTitle} className="deep-settings-pane security-settings-pane">
                      <section className="settings-secret-row security-secret-row" aria-label={settingsWorkspaceCopy.security.externalApiKeyAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.security.externalApiKeyTitle}</strong>
                          <small>
                            {settingsWorkspaceCopy.security.externalApiKeyHelp(
                              securitySecrets.externalApiKey.configured ? settingsWorkspaceCopy.security.externalApiKeyConfigured : settingsWorkspaceCopy.security.externalApiKeyNotConfigured,
                            )}
                          </small>
                        </span>
                        <span className="settings-row-field settings-sensitive-field">
                          <span>{settingsWorkspaceCopy.security.externalApiKeyFieldLabel}</span>
                          <input aria-label={settingsWorkspaceCopy.security.externalApiKeyAria} type="password" value={externalApiKeyInput} onChange={(event) => setExternalApiKeyInput(event.currentTarget.value)} />
                        </span>
                        <span className="settings-row-action-rail">
                          <button type="button" onClick={saveExternalApiKey} disabled={!externalApiKeyInput.trim() || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.security.saveApiKey}
                          </button>
                          <button type="button" onClick={clearExternalApiKey} disabled={!props.onClearExternalApiKey || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.security.clearApiKey}
                          </button>
                        </span>
                      </section>
                      <section className="settings-secret-row security-whitelist-row" aria-label={settingsWorkspaceCopy.security.allowlistAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.security.allowlistTitle}</strong>
                          <small>{settingsWorkspaceCopy.security.allowlistDescription}</small>
                        </span>
                        <span className="settings-row-field settings-sensitive-field">
                          <span>{settingsWorkspaceCopy.security.allowlistFieldLabel}</span>
                          <input aria-label={settingsWorkspaceCopy.security.allowlistFieldAria} value={telegramAllowedUserIdsInput} onChange={(event) => setTelegramAllowedUserIdsInput(event.currentTarget.value)} />
                        </span>
                        <span className="settings-row-action-rail">
                          <button type="button" onClick={saveTelegramSecuritySettings} disabled={!props.onSaveTelegramSecuritySettings || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.security.saveAllowlist}
                          </button>
                        </span>
                      </section>
                      <section className="settings-danger-row security-danger-row" aria-label={settingsWorkspaceCopy.security.exposureRiskAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.security.exposureRiskTitle}</strong>
                          <small>{settingsWorkspaceCopy.security.exposureRiskDescription}</small>
                        </span>
                        <span className="settings-row-field">{settingsWorkspaceCopy.security.exposureRiskResetHelp}</span>
                        <span className="settings-row-action-rail">
                          <Button variant="danger" size="compact" onClick={resetSecurity} disabled={!props.onResetSecurity} busy={loadingRuntimeBusy}>
                            {settingsWorkspaceCopy.security.resetSecurity}
                          </Button>
                        </span>
                      </section>
                      <section className="settings-audit-row security-audit-row" aria-label={settingsWorkspaceCopy.security.auditAria}>
                        <span className="settings-row-copy">
                          <strong>{settingsWorkspaceCopy.security.auditTitle}</strong>
                          <small>{settingsWorkspaceCopy.security.auditDescription}</small>
                        </span>
                        <span className="settings-row-field settings-evidence-list">
                          {securityAuditLogs.length === 0 ? <span>{settingsWorkspaceCopy.security.emptyAudit}</span> : securityAuditLogs.slice(0, 6).map((entry) => <code key={entry.id}>{entry.action}</code>)}
                        </span>
                        <span className="settings-row-action-rail">
                          <span className="settings-action-meta">{settingsWorkspaceCopy.security.latestAudit}</span>
                        </span>
                      </section>
                    </NativeSettingsPane>
                  </section>
                ) : null}
                {settingsCategory === 'git' ? (
                  <section className="settings-product-pane" aria-label={settingsWorkspaceCopy.categories.git}>
                    <NativeSettingsPane label={settingsWorkspaceCopy.git.paneTitle} className="deep-settings-pane git-settings-pane">
                      <NativeControlRow title={settingsWorkspaceCopy.git.branchNameTitle} description={settingsWorkspaceCopy.git.branchNameDescription} className="git-settings-field-row">
                        <input aria-label={settingsWorkspaceCopy.git.branchNameAria} value={gitBranchName} onChange={(event) => setGitBranchName(event.currentTarget.value)} />
                      </NativeControlRow>
                      <NativeControlRow title={settingsWorkspaceCopy.git.remoteTitle} description={settingsWorkspaceCopy.git.remoteDescription} className="git-settings-field-row">
                        <input aria-label={settingsWorkspaceCopy.git.remoteAria} value={gitRemote} onChange={(event) => setGitRemote(event.currentTarget.value)} />
                      </NativeControlRow>
                      <section className="settings-danger-row git-confirmation-risk-row" aria-label={settingsWorkspaceCopy.git.confirmationAria}>
                        <span className="settings-row-copy git-confirmation-risk-copy">
                          <strong>{settingsWorkspaceCopy.git.confirmationTitle}</strong>
                          <small>{settingsWorkspaceCopy.git.confirmationDescription}</small>
                        </span>
                        <span className="settings-row-field git-confirmation-risk-meta">
                          {/* Git 写操作必须保留二次确认和审计，按钮只创建确认单，不直接改仓库。 */}
                          <span>{settingsWorkspaceCopy.git.targetBranch(gitBranchName)}</span>
                          <small>{settingsWorkspaceCopy.git.remoteTarget(gitRemote, gitTargetRef)}</small>
                        </span>
                        <span className="settings-row-action-rail git-confirmation-risk-rail">
                          <Button variant="danger" size="compact" onClick={() => createGitConfirmation('branch')} disabled={!gitBranchName.trim()} busy={creatingGitConfirmationBusy}>
                            {settingsWorkspaceCopy.git.requestBranchConfirmation}
                          </Button>
                          <Button variant="danger" size="compact" onClick={() => createGitConfirmation('push')} disabled={!gitRemote.trim() || !gitTargetRef.trim()} busy={creatingGitConfirmationBusy}>
                            {settingsWorkspaceCopy.git.requestPushConfirmation}
                          </Button>
                        </span>
                      </section>
                    </NativeSettingsPane>
                  </section>
                ) : null}
                {settingsCategory === 'commands' && props.commandClient ? <CommandCenterPanel mode="global" client={props.commandClient} language={appShellSettings.appLanguage} /> : null}
                {settingsCategory === 'release' ? (
                  <section className="settings-product-pane" aria-label={settingsWorkspaceCopy.categories.release}>
                    <NativeSettingsPane label={settingsWorkspaceCopy.release.paneTitle} className="deep-settings-pane release-settings-pane">
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
                          <small>{releaseStatus.autoUpdate.changelogPath}</small>
                          <small>{formatReleaseWaitingForItems(releaseStatus.readiness.waitingFor, settingsWorkspaceCopy.release)}</small>
                          <small>{formatReleaseWaitingForItems(releaseStatus.autoUpdate.waitingFor, settingsWorkspaceCopy.release)}</small>
                        </span>
                        <span className="settings-row-action-rail">
                          <span className="settings-action-meta">{settingsWorkspaceCopy.release.realReleaseStatus}</span>
                        </span>
                      </section>
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
                            <small>{releaseUpdateStatus.checkedAt ? settingsWorkspaceCopy.release.checkedAt(releaseUpdateStatus.checkedAt) : settingsWorkspaceCopy.release.notChecked}</small>
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
                      </section>
                    </NativeSettingsPane>
                  </section>
                ) : null}
                {settingsCategory === 'data' ? (
                  <section className="settings-product-pane" aria-label={settingsWorkspaceCopy.categories.data}>
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
                          <button type="button" onClick={clearLocalCaches} disabled={!props.onClearLocalCaches || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.data.clearCache}
                          </button>
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
                        <span className="settings-archived-conversation-list" aria-live="polite">
                          {archivedConversationLoadState === 'loading' ? <small>{settingsWorkspaceCopy.data.loadingArchivedConversations}</small> : null}
                          {archivedConversationLoadState === 'error' ? (
                            <span className="settings-archived-conversation-state">
                              <button type="button" onClick={() => void refreshArchivedConversations()}>
                                {settingsWorkspaceCopy.data.retryArchivedConversations}
                              </button>
                            </span>
                          ) : null}
                          {archivedConversationLoadState === 'ready' && archivedConversations.length === 0 ? <small>{settingsWorkspaceCopy.data.emptyArchivedConversations}</small> : null}
                          {archivedConversations.map((conversation) => {
                            const task = snapshot.tasks.find((candidate) => candidate.id === conversation.taskId);
                            const project = snapshot.projects.find((candidate) => candidate.id === conversation.projectId);
                            return (
                              <span className="settings-archived-conversation-item" key={conversation.id}>
                                <span className="settings-archived-conversation-copy">
                                  <strong>{conversationDisplayTitle(conversation.title, task?.title)}</strong>
                                  <small>
                                    {task
                                      ? settingsWorkspaceCopy.data.archivedConversationContext(project?.name ?? conversation.projectId, task.taskCode ?? task.id)
                                      : settingsWorkspaceCopy.data.archivedProjectConversationContext(project?.name ?? conversation.projectId)}
                                  </small>
                                  <small>{formatArchivedConversationDate(conversation.updatedAt, appShellSettings.appLanguage)}</small>
                                </span>
                                <button type="button" disabled={restoringArchivedConversationId !== null} onClick={() => void restoreTaskConversation(conversation)}>
                                  {restoringArchivedConversationId === conversation.id ? settingsWorkspaceCopy.data.restoringArchivedConversation : settingsWorkspaceCopy.data.restoreArchivedConversation}
                                </button>
                              </span>
                            );
                          })}
                        </span>
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
