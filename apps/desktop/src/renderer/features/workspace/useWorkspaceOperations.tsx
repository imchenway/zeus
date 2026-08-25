import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cloneTaskManagementStatusConfig, type TaskManagementStatusConfig } from '@zeus/shared';
import { notifyMainAppShellSettingsChanged, recordManualUpdateCheckInMain } from '../../appShellBridge.js';
import { ConnectedSessionWorkspace, SessionWorkspace } from '../../session/SessionWorkspace.js';
import { selectHasConfirmedUserMessage } from '../../session/sessionSelectors.js';
import { TaskDetailPaneContent } from '../../task/TaskDetailPaneContent.js';
import { writeTaskModelPushPreferences } from '../../task/TaskModelPushModal.js';
import { taskModelPushHasRealChoice } from '../../task/TaskModelPushPendingWorkspace.js';
import { normalizeTaskTableColumnPreferences, normalizeTaskTableEnumSortOrders, resolveTaskManagementStatus, type TaskWorkspaceViewMode } from '../../task/taskWorkspaceModel.js';
import { createSessionOperationId } from '../../sessionOperationIdentity.js';
import {
  type AiRuntimeSession,
  type DeleteTaskRequest,
  type GitDiffHunk,
  type HighRiskGitOperation,
  type ProjectRecord,
  type TaskBoardMoveRequest,
  type TaskBoardViewSettings,
  type TaskBoardViewSnapshot,
  type TaskManagementStatus,
  type TaskPageViewMode,
  type TaskRecord,
  type TaskStatusFilter,
  ZeusApiError,
} from '../../apiClient.js';
import { normalizeCodeMapSettings, normalizeProjectConfig, normalizeRuntimeSettings, parseNumericList, resolveRuntimeNormalizedLogPath, toProjectConfigForm } from './WorkspaceChrome.js';
import { CodeMapView } from '../graph/CodeMapView.js';
import { buildGitHunkReviewKey, buildGitOperationExecutionInput, formatGitOperationLabel, formatRuntimeLogLine, toSafeAppShellImport } from './workspaceFormatters.js';
import {
  adjustProjectSidebarWidthForKeyboard,
  browserNativeConversationStartStorage,
  buildRuntimeSessionTaskDraft,
  clampProjectSidebarWidth,
  createSessionWorkspaceTask,
  formatConfiguredTaskManagementStatus,
  mergeAppShellSettingsSaveResponse,
  normalizeProjectSidebarPreferredWidth,
  normalizeRendererAppShellSettings,
  normalizeTaskStatusFilterByProject,
  persistProjectSidebarPreferredWidth,
  PROJECT_SIDEBAR_DEFAULT_WIDTH,
  PROJECT_SIDEBAR_MAX_WIDTH,
  type ProjectCodeWorkspaceMode,
  type ProjectSidebarDragState,
  type ProjectWorkspaceSection,
  resolveTaskManagementStatusConfig,
  resolveTaskTableColumnsForProject,
  toAppShellSettingsSavePayload,
  transitionProjectSidebarDrag,
  type WorkspaceViewId,
} from './workspaceSupport.js';
import type { WorkspaceQueryState } from './useWorkspaceQueryState.js';
import type { WorkspaceDomainActions } from './useWorkspaceDomainActions.js';

export function useWorkspaceOperations(state: WorkspaceQueryState, domainActions: WorkspaceDomainActions) {
  const {
    actionState,
    activeGraphView,
    activeNavTarget,
    activeProjectId,
    activeProjectIdRef,
    activeProjectSection,
    activeTaskManagementStatusConfig,
    activeTaskManagementStatusLabels,
    activeTaskTableColumns,
    appShellSettings,
    appShellSettingsRef,
    codeMapSettings,
    codeWorkspaceCopy,
    codexConfigImportResult,
    conversationDraftOpen,
    currentProjectTasks,
    expandedTaskIds,
    externalApiKeyInput,
    firstProjectId,
    genericShellCriticalConfirmed,
    gitBaseRef,
    gitBranchName,
    gitCommitMessage,
    gitConfirmation,
    gitDiffCopy,
    gitRemote,
    gitRollbackRef,
    gitStashRef,
    gitSwitchBranchName,
    gitTargetRef,
    graphAnswer,
    graphConversationPage,
    graphConversationSearch,
    graphConversations,
    graphNodeTaskFeedback,
    graphSearchResult,
    graphSourceOpenFeedback,
    lastGraphNodeTaskId,
    loadTaskBoard,
    mergeTaskRecord,
    nativeConversationHotCacheRef,
    nativeLegacyMessageError,
    nativeLegacyMessageLoadState,
    nativeLegacyMessages,
    nativeSessionChoiceTaskState,
    nativeSessionChoices,
    nativeSessionOwner,
    nativeSessionTask,
    nativeSessionTaskReadOnly,
    newConversationFocusRequest,
    optimisticTerminalTaskStatuses,
    pendingSourceWorkspaceLeaveCancelRef,
    pendingSourceWorkspaceLeaveRef,
    pendingTaskTableLayoutLeaveCancelRef,
    pendingTaskTableLayoutLeaveRef,
    persistedTaskTableColumns,
    projectCodeWorkspaceMode,
    projectPanel,
    projectSidebarCommittedWidthRef,
    projectSidebarDragCleanupRef,
    projectSidebarPreferredWidth,
    projectSidebarViewportWidth,
    projectSourceWorkspaceRef,
    props,
    recordNativeConversationRuntimeState,
    runtime,
    runtimeConfirmation,
    runtimeConfirmationCommand,
    runtimeFavoriteOnly,
    runtimeGenericShellCommand,
    runtimeInput,
    runtimeLogs,
    runtimeSearchQuery,
    runtimeSettings,
    runtimeShowArchived,
    runtimeTaskIdentityRef,
    saveTaskTableLayoutThenLeaveRef,
    scanState,
    selectedGraphConversation,
    selectedNativeConversation,
    selectedNativeConversationPresentation,
    selectedProject,
    selectedTaskModelPushOperation,
    selectedTaskModelPushOptimisticState,
    sessionWorkspaceCopy,
    setActionState,
    setActiveNavTarget,
    setActiveProjectSection,
    setAppShellSettings,
    setCodeMapSettings,
    setCodexConfigImportError,
    setCodexConfigImportLoading,
    setCodexConfigImportPreview,
    setCodexConfigImportResult,
    setCodexLegacyImportBusy,
    setCodexLegacyImportError,
    setCodexLegacyImportLoading,
    setCodexLegacyImportSnapshot,
    setConversationDraftOpen,
    setDataPortabilityStatus,
    setExternalApiKeyInput,
    setGitConfirmation,
    setGitDiff,
    setGitHunkDecisions,
    setGitOperationStatus,
    setGraphConversationSearch,
    setLatestConversationContentVisible,
    setPatchExportStatus,
    setProjectCodeWorkspaceMode,
    setProjectConfig,
    setProjectConfigForm,
    setProjectDetail,
    setProjectPanel,
    setProjectSidebarPreferredWidth,
    setProjectSidebarResizing,
    setReleaseStatus,
    setReleaseUpdateCheckState,
    setReleaseUpdateStatus,
    setRuntimeAdapterChecks,
    setRuntimeAdapters,
    setRuntimeConfirmation,
    setRuntimeConfirmationCommand,
    setRuntimeConfirmationStatus,
    setRuntimeInput,
    setRuntimeLogCopyStatus,
    setRuntimeLogExportStatus,
    setRuntimeLogs,
    setRuntimeSessions,
    setRuntimeSettings,
    setRuntimeStatus,
    setSecurityAuditLogs,
    setSecuritySecrets,
    setSelectedTaskIds,
    setSettingsCategory,
    setSnapshot,
    setSourceWorkspaceLeaveDialogOpen,
    setSourceWorkspaceSaveBusy,
    setTaskBoardSnapshots,
    setTaskBulkActionStatus,
    setTaskDeleteDialogTaskId,
    setTaskDetail,
    setTaskDetailPaneTaskId,
    setTaskDetailPresentation,
    setTaskEvents,
    setTaskGitReviewState,
    setTaskManagementStatusReplacements,
    setTaskTableLayoutDraft,
    setTaskTableLayoutLeaveDialogOpen,
    setTaskTableLayoutSaveBusy,
    setTaskTableLayoutScopeDialogOpen,
    setTaskTemplates,
    setTelegramAllowedUserIdsInput,
    setTelegramNotificationChatIdsInput,
    setTelegramNotificationSettings,
    setTelegramPollingStatus,
    setTelegramSecuritySettings,
    setTelegramTestStatus,
    setTelegramTokenInput,
    setVisitedCodeWorkspaceModes,
    settingsWorkspaceCopy,
    snapshot,
    sourceWorkspaceDirty,
    taskBoardSnapshots,
    taskConversationReopenState,
    taskDetailPaneTaskId,
    taskEvents,
    taskManagementStatusReplacements,
    taskPageViewMode,
    taskStatusFilter,
    taskTableLayoutDirty,
    taskViewMode,
    taskWorkspaceCopy,
    telegramAllowedUserIdsInput,
    telegramNotificationChatIdsInput,
    telegramNotificationSettings,
    telegramSecuritySettings,
    telegramTokenInput,
    templateTaskIdentityRef,
    uiCopy,
    updatingTaskBusy,
    visibleTasks,
    workspaceScrollRef,
  } = state;
  const {
    archiveGraphConversation,
    askGraph,
    chooseNativeConversationAttachments,
    createTaskFromGraphConversation,
    createTaskFromGraphNode,
    effectiveTaskStatusSettingsTargetId,
    executeNewConversationProjectGit,
    loadGraphConversationDetail,
    loadGraphConversations,
    loadProjectConfig,
    openGraphSourceFromCodeMap,
    openGraphView,
    openTaskConversation,
    openTaskCreateModal,
    openTaskGitDelivery,
    openTaskModelPush,
    persistSidebarConversationPreferences,
    recordLocalError,
    recordTaskMutationVersion,
    refreshNativeConversationChoices,
    refreshOpenTaskEvents,
    reopenTaskFromConversation,
    requestTaskTerminalCleanupConfirmation,
    restoreGraphConversation,
    retryTaskModelPush,
    scanActiveProjectGraph,
    searchGraph,
    selectNewConversationProject,
    selectProjectCodeWorkspaceMode,
    startNativeConversation,
    startProjectConversation,
    taskDetailPaneConversationState,
    taskDetailPaneConversations,
    taskDetailPaneModelPushView,
    taskDetailPaneTask,
    taskModelPushWorkspaceActions,
    updateTaskContent,
    updateTaskManagementStatus,
    updateTaskRelationships,
  } = domainActions;
  async function handleCodeMapAction(): Promise<void> {
    handleMainNavigate('projects');
    setActiveProjectSection('code');
    await selectProjectCodeWorkspaceMode('graph');
  }

  function renderProjectCodeMapStage(): ReactNode {
    if (!activeGraphView) return null;
    return (
      <section className="project-code-map-stage" aria-label={codeWorkspaceCopy.graphDrawerAria}>
        {/* 图谱按首次进入模式再加载，源码工作台始终保持已打开标签和草稿。 */}
        <CodeMapView
          isActive={activeProjectSection === 'code'}
          graphView={activeGraphView}
          searchResult={graphSearchResult}
          graphAnswer={graphAnswer}
          graphConversations={graphConversations}
          graphConversationPage={graphConversationPage}
          selectedGraphConversation={selectedGraphConversation}
          graphConversationSearch={graphConversationSearch}
          graphNodeTaskFeedback={graphNodeTaskFeedback}
          graphNodeTaskTargetId={lastGraphNodeTaskId}
          graphSourceOpenFeedback={graphSourceOpenFeedback}
          scanState={scanState}
          onGraphConversationSearchChange={setGraphConversationSearch}
          onLoadGraphConversations={loadGraphConversations}
          onLoadGraphConversation={loadGraphConversationDetail}
          onArchiveGraphConversation={archiveGraphConversation}
          onRestoreGraphConversation={restoreGraphConversation}
          onCreateTaskFromGraphConversation={createTaskFromGraphConversation}
          onLoadView={openGraphView}
          onLoadGraphNeighborhood={activeProjectId && props.onLoadProjectGraphNeighborhood ? (nodeId, depth) => props.onLoadProjectGraphNeighborhood!(activeProjectId, nodeId, depth) : props.onLoadGraphNeighborhood}
          onSearchGraph={searchGraph}
          onAskGraph={askGraph}
          onCreateTaskFromNode={createTaskFromGraphNode}
          onOpenGraphSource={openGraphSourceFromCodeMap}
          onScanGraph={() => {
            void scanActiveProjectGraph();
          }}
          onOpenChanges={() => {
            setProjectPanel('diff');
            void loadGitDiff();
          }}
          onExportMermaidDiagramFile={props.onExportMermaidDiagramFile}
          onExportPlantUmlDiagramFile={props.onExportPlantUmlDiagramFile}
          codeMapSettings={codeMapSettings}
          appLanguage={appShellSettings.appLanguage}
        />
      </section>
    );
  }

  function toggleTaskSelection(taskId: string, selected: boolean): void {
    setSelectedTaskIds((ids) => {
      if (!selected) return ids.filter((id) => id !== taskId);
      return ids.includes(taskId) ? ids : [...ids, taskId];
    });
    setTaskBulkActionStatus({ kind: 'idle' });
  }

  function toggleAllVisibleTaskSelection(taskIds: string[], selected: boolean): void {
    setSelectedTaskIds((ids) => {
      const taskIdSet = new Set(taskIds);
      if (!selected) return ids.filter((id) => !taskIdSet.has(id));
      return Array.from(new Set([...ids, ...taskIds]));
    });
    setTaskBulkActionStatus({ kind: 'idle' });
  }

  function clearTaskSelection(): void {
    setSelectedTaskIds([]);
    setTaskBulkActionStatus({ kind: 'idle' });
  }

  function formatTaskBulkActionResult(successCount: number, skippedCount: number, failedCount: number): string {
    if (appShellSettings.appLanguage === 'zh-CN') return `已处理 ${successCount} 项，跳过 ${skippedCount} 项，失败 ${failedCount} 项。`;
    return `${successCount} processed, ${skippedCount} skipped, ${failedCount} failed.`;
  }

  async function runBulkTaskStatusChange(targetStatus: TaskManagementStatus, taskIds: string[]): Promise<void> {
    const requestedTaskIdSet = new Set(taskIds);
    const requestedTasks = visibleTasks.filter((task) => requestedTaskIdSet.has(task.id));
    const eligibleTasks = requestedTasks.filter((task) => resolveTaskManagementStatus(task) !== targetStatus);
    let skippedCount = requestedTasks.length - eligibleTasks.length;
    const succeededTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    if (eligibleTasks.length === 0) {
      setTaskBulkActionStatus({ kind: 'done', message: formatTaskBulkActionResult(0, skippedCount, 0) });
      return;
    }
    setActionState('updating-task');
    setTaskBulkActionStatus({ kind: 'running', message: formatTaskBulkActionResult(0, skippedCount, 0) });
    try {
      for (const task of eligibleTasks) {
        try {
          const result = await updateTaskManagementStatus(task.id, targetStatus, { expectedUpdatedAt: task.updatedAt ?? '' });
          if (!result || result.kind !== 'updated') {
            skippedCount += 1;
            continue;
          }
          succeededTaskIds.push(task.id);
        } catch {
          failedTaskIds.push(task.id);
        }
      }
      setSelectedTaskIds((ids) => ids.filter((id) => !succeededTaskIds.includes(id)));
      setTaskBulkActionStatus({
        kind: failedTaskIds.length > 0 ? 'failed' : 'done',
        message: formatTaskBulkActionResult(succeededTaskIds.length, skippedCount, failedTaskIds.length),
      });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function runBulkTaskDelete(taskIds: string[]): Promise<void> {
    if (!props.onDeleteTask) return;
    const requestedTaskIdSet = new Set(taskIds);
    const requestedTasks = visibleTasks.filter((task) => requestedTaskIdSet.has(task.id));
    // 批量删除不替用户猜测父任务处置方式；有直接子任务的任务留到详情中的三选一确认。
    const eligibleTasks = requestedTasks.filter((task) => task.status !== 'running' && task.status !== 'waiting_confirmation' && !currentProjectTasks.some((candidate) => candidate.parentTaskId === task.id));
    const skippedCount = requestedTasks.length - eligibleTasks.length;
    if (eligibleTasks.length === 0) {
      setTaskBulkActionStatus({ kind: 'done', message: formatTaskBulkActionResult(0, skippedCount, 0) });
      return;
    }
    if (!window.confirm(taskWorkspaceCopy.bulkDeleteConfirm(eligibleTasks.length, skippedCount))) return;
    const succeededTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    setActionState('updating-task');
    setTaskBulkActionStatus({ kind: 'running', message: formatTaskBulkActionResult(0, skippedCount, 0) });
    try {
      for (const task of eligibleTasks) {
        try {
          const nextSnapshot = await props.onDeleteTask(task.id);
          setSnapshot(nextSnapshot);
          succeededTaskIds.push(task.id);
        } catch {
          failedTaskIds.push(task.id);
        }
      }
      setSelectedTaskIds((ids) => ids.filter((id) => !succeededTaskIds.includes(id)));
      setTaskBulkActionStatus({
        kind: failedTaskIds.length > 0 ? 'failed' : 'done',
        message: formatTaskBulkActionResult(succeededTaskIds.length, skippedCount, failedTaskIds.length),
      });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function deleteTaskWithRelationshipStrategy(taskId: string, input: DeleteTaskRequest): Promise<void> {
    if (!props.onDeleteTask) return;
    setActionState('updating-task');
    try {
      const nextSnapshot = await props.onDeleteTask(taskId, input);
      setSnapshot(nextSnapshot);
      setSelectedTaskIds((ids) => ids.filter((id) => id !== taskId));
      setTaskDeleteDialogTaskId(null);
      setTaskDetailPaneTaskId(undefined);
      setTaskDetail(undefined);
      setActionState('idle');
    } catch (error) {
      recordLocalError('task-delete', error);
      setActionState('idle');
    }
  }

  async function createGitConfirmation(operation: HighRiskGitOperation): Promise<void> {
    if (!props.onCreateGitConfirmation) return;
    setActionState('creating-git-confirmation');
    try {
      setGitConfirmation(await props.onCreateGitConfirmation(operation, operation === 'commit' ? gitCommitMessage.trim() : undefined));
      setGitOperationStatus(gitDiffCopy.operationNotExecuted);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function confirmGitOperation(): Promise<void> {
    if (!props.onConfirmGitOperation || !gitConfirmation) return;
    setActionState('confirming-git-operation');
    try {
      setGitConfirmation(await props.onConfirmGitOperation(gitConfirmation.id));
      setGitOperationStatus(gitDiffCopy.operationNotExecuted);
      setActionState('idle');
    } catch {
      setGitOperationStatus(gitDiffCopy.operationConfirmFailed);
      setActionState('failed');
    }
  }

  async function rejectGitOperation(): Promise<void> {
    if (!props.onRejectGitOperation || !gitConfirmation) return;
    setActionState('confirming-git-operation');
    try {
      const rejected = await props.onRejectGitOperation(gitConfirmation.id, `用户在 Git Diff 面板拒绝${formatGitOperationLabel(gitConfirmation.operation)}确认`);
      setGitConfirmation(rejected);
      setGitOperationStatus(gitDiffCopy.rejectStatus);
      setActionState('idle');
    } catch {
      setGitOperationStatus(gitDiffCopy.rejectFailed);
      setActionState('failed');
    }
  }

  async function executeConfirmedGitOperation(): Promise<void> {
    if (!props.onExecuteGitOperation || !gitConfirmation || gitConfirmation.status !== 'confirmed') return;
    const executionInput = buildGitOperationExecutionInput(gitConfirmation, {
      branchName: gitConfirmation.operation === 'switch_branch' ? gitSwitchBranchName : gitBranchName,
      baseRef: gitBaseRef,
      stashRef: gitStashRef,
      remote: gitRemote,
      targetRef: gitConfirmation.operation === 'rollback' ? gitRollbackRef : gitTargetRef,
    });
    if (gitConfirmation.operation === 'commit' && !executionInput.message?.trim()) {
      setGitOperationStatus(gitDiffCopy.commitMessageRequired);
      return;
    }
    setActionState('executing-git-operation');
    try {
      const result = await props.onExecuteGitOperation(executionInput);
      setGitOperationStatus(gitDiffCopy.executedStatus(formatGitOperationLabel(result.operation, appShellSettings.appLanguage), result.args.join(' ')));
      setActionState('idle');
    } catch {
      setGitOperationStatus(gitDiffCopy.executeFailed);
      setActionState('failed');
    }
  }

  function setGitHunkDecision(file: { oldPath: string; newPath: string }, hunk: GitDiffHunk, decision: 'accepted' | 'rejected'): void {
    setGitHunkDecisions((current) => ({
      ...current,
      [buildGitHunkReviewKey(file, hunk)]: decision,
    }));
  }

  async function loadGitDiff(): Promise<void> {
    if (!props.onLoadGitDiff) return;
    setActionState('loading-diff');
    try {
      setGitDiff(await props.onLoadGitDiff());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function exportGitPatch(): Promise<void> {
    if (!props.onExportGitPatch) return;
    setActionState('loading-diff');
    try {
      const patch = await props.onExportGitPatch();
      const saved = props.onExportPatchFile ? await props.onExportPatchFile(patch) : { saved: false, filePath: null };
      setPatchExportStatus(saved.saved ? gitDiffCopy.patchSaved(saved.filePath) : gitDiffCopy.patchGenerated(patch.fileName));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function loadRuntimeStatus(): Promise<void> {
    if (!props.onLoadRuntimeStatus) return;
    setActionState('loading-runtime');
    try {
      setRuntimeStatus(await props.onLoadRuntimeStatus());
      if (props.onLoadSecuritySecrets) setSecuritySecrets(await props.onLoadSecuritySecrets());
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      if (props.onLoadReleaseStatus) setReleaseStatus(await props.onLoadReleaseStatus());
      if (props.onLoadTelegramNotificationSettings) {
        const settings = await props.onLoadTelegramNotificationSettings();
        setTelegramNotificationSettings(settings);
        setTelegramNotificationChatIdsInput(settings.chatIds.join(', '));
      }
      if (props.onLoadTelegramSecuritySettings) {
        const settings = await props.onLoadTelegramSecuritySettings();
        setTelegramSecuritySettings(settings);
        setTelegramAllowedUserIdsInput(settings.allowedUserIds.join(', '));
      }
      if (props.onLoadRuntimeAdapters) setRuntimeAdapters(await props.onLoadRuntimeAdapters());
      if (props.onLoadRuntimeSettings) setRuntimeSettings(normalizeRuntimeSettings(await props.onLoadRuntimeSettings()));
      if (props.onLoadCodeMapSettings) {
        const settings = normalizeCodeMapSettings(await props.onLoadCodeMapSettings());
        setCodeMapSettings(settings);
      }
      if (props.onLoadProjectConfig && firstProjectId) {
        const loadedConfig = normalizeProjectConfig(await props.onLoadProjectConfig(firstProjectId), firstProjectId);
        setProjectConfig(loadedConfig);
        setProjectConfigForm(toProjectConfigForm(loadedConfig));
      }
      if (props.onLoadAppShellSettings) setAppShellSettings(normalizeRendererAppShellSettings(await props.onLoadAppShellSettings()));
      if (props.onLoadRuntimeSessions) {
        const sessions = await props.onLoadRuntimeSessions();
        setRuntimeSessions(sessions);
        if (sessions[0] && props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(sessions[0].id));
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function refreshCodexLegacyImports(): Promise<void> {
    if (!props.onLoadCodexLegacyImports) return;
    setCodexLegacyImportLoading(true);
    setCodexLegacyImportError(null);
    try {
      setCodexLegacyImportSnapshot(await props.onLoadCodexLegacyImports());
    } catch (error) {
      setCodexLegacyImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setCodexLegacyImportLoading(false);
    }
  }

  async function startCodexLegacyImport(sourceConversationIds: string[]): Promise<void> {
    if (!props.onStartCodexLegacyImport || !props.onLoadCodexLegacyImports || sourceConversationIds.length === 0) return;
    setCodexLegacyImportBusy(true);
    setCodexLegacyImportError(null);
    try {
      const started = await props.onStartCodexLegacyImport(sourceConversationIds);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const snapshot = await props.onLoadCodexLegacyImports();
        setCodexLegacyImportSnapshot(snapshot);
        const activeRun = snapshot.runs.some((run) => run.importId === started.importId && (run.status === 'prepared' || run.status === 'waiting'));
        if (!activeRun) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      }
    } catch (error) {
      setCodexLegacyImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setCodexLegacyImportBusy(false);
    }
  }

  async function refreshCodexConfigImport(): Promise<void> {
    if (!props.onInspectCodexConfigImport) return;
    setCodexConfigImportLoading(true);
    setCodexConfigImportError(null);
    try {
      setCodexConfigImportPreview(await props.onInspectCodexConfigImport());
    } catch (error) {
      setCodexConfigImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setCodexConfigImportLoading(false);
    }
  }

  async function importCodexConfig(): Promise<void> {
    if (!props.onImportCodexConfig) return;
    setCodexConfigImportLoading(true);
    setCodexConfigImportError(null);
    try {
      const result = await props.onImportCodexConfig();
      setCodexConfigImportResult(result);
      setCodexConfigImportPreview(result);
      if (result.runtimeError) setCodexConfigImportError(result.runtimeError);
    } catch (error) {
      setCodexConfigImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setCodexConfigImportLoading(false);
    }
  }

  async function activateCodexConfig(): Promise<void> {
    if (!props.onActivateCodexConfig || !codexConfigImportResult) return;
    setCodexConfigImportLoading(true);
    setCodexConfigImportError(null);
    try {
      const activation = await props.onActivateCodexConfig();
      setCodexConfigImportResult((current) => (current ? { ...current, ...activation, runtimeError: null } : current));
    } catch (error) {
      setCodexConfigImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setCodexConfigImportLoading(false);
    }
  }

  async function checkReleaseUpdate(): Promise<void> {
    if (!props.onCheckReleaseUpdate) return;
    setReleaseUpdateCheckState('loading');
    try {
      const update = await props.onCheckReleaseUpdate();
      setReleaseUpdateStatus(update);
      void recordManualUpdateCheckInMain({ zeus: globalThis.window.zeus });
      setReleaseUpdateCheckState('idle');
    } catch (error) {
      setReleaseUpdateCheckState('failed');
      recordLocalError('renderer-action', error);
    }
  }

  async function checkRuntimeAdapter(adapterId: string): Promise<void> {
    if (!props.onCheckRuntimeAdapter) return;
    setActionState('loading-runtime');
    try {
      const status = await props.onCheckRuntimeAdapter(adapterId);
      setRuntimeAdapterChecks((current) => ({
        ...current,
        [adapterId]: status,
      }));
      if (adapterId === runtimeSettings.defaultAdapterId) {
        setRuntimeStatus((current) => ({
          ...(current ?? runtime),
          aiCli: {
            name: status.name,
            command: status.command,
            available: status.available,
            reason: status.reason,
          },
        }));
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function saveRuntimeSettings(): Promise<void> {
    if (!props.onSaveRuntimeSettings) return;
    setActionState('loading-runtime');
    try {
      // 保存设置不触发外部 CLI；真实可用性只能由用户随后明确点击检查确认。
      setRuntimeSettings(normalizeRuntimeSettings(await props.onSaveRuntimeSettings(runtimeSettings)));
      if (props.onLoadRuntimeStatus) setRuntimeStatus(await props.onLoadRuntimeStatus());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  function updateTaskManagementStatusConfigDraft(config: TaskManagementStatusConfig, deletion?: { removedStatusId: string; replacementStatusId?: string }): void {
    const nextConfig = cloneTaskManagementStatusConfig(config);
    setAppShellSettings((current) => {
      if (effectiveTaskStatusSettingsTargetId === '__template__') return { ...current, taskManagementStatusTemplate: nextConfig };
      return {
        ...current,
        taskManagementStatusByProject: {
          ...(current.taskManagementStatusByProject ?? {}),
          [effectiveTaskStatusSettingsTargetId]: nextConfig,
        },
      };
    });
    if (effectiveTaskStatusSettingsTargetId !== '__template__' && deletion?.replacementStatusId) {
      setTaskManagementStatusReplacements((current) => ({
        ...current,
        [effectiveTaskStatusSettingsTargetId]: {
          ...(current[effectiveTaskStatusSettingsTargetId] ?? {}),
          [deletion.removedStatusId]: deletion.replacementStatusId!,
        },
      }));
    }
  }

  async function saveAppShellSettings(): Promise<void> {
    if (!props.onSaveAppShellSettings) return;
    setActionState('loading-runtime');
    try {
      // 通用设置只保存本机偏好，不写入任何业务假数据或密钥明文。
      const savedSettings = await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(appShellSettings, taskManagementStatusReplacements));
      setAppShellSettings((currentSettings) =>
        mergeAppShellSettingsSaveResponse({
          currentSettings,
          savedSettings,
        }),
      );
      await notifyMainAppShellSettingsChanged({
        zeus: window.zeus,
        settings: {
          appLanguage: savedSettings.appLanguage,
          appearance: savedSettings.appearance,
          webviewDebugEnabled: savedSettings.webviewDebugEnabled,
          multiWindowEnabled: savedSettings.multiWindowEnabled,
          backgroundModeEnabled: savedSettings.backgroundModeEnabled,
          desktopNotificationsEnabled: savedSettings.desktopNotificationsEnabled,
          openAtLoginEnabled: savedSettings.openAtLoginEnabled,
        },
      });
      setTaskManagementStatusReplacements({});
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function saveTaskStatusFilter(filter: TaskStatusFilter): Promise<void> {
    if (!activeProjectId || filter === taskStatusFilter) return;
    const nextSettings = normalizeRendererAppShellSettings({
      ...appShellSettings,
      taskStatusFilterByProject: {
        ...(appShellSettings.taskStatusFilterByProject ?? {}),
        [activeProjectId]: filter,
      },
    });
    setAppShellSettings(nextSettings);
    if (!props.onSaveAppShellSettings) return;
    try {
      const savedSettings = await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(nextSettings, taskManagementStatusReplacements));
      setAppShellSettings((currentSettings) =>
        mergeAppShellSettingsSaveResponse({
          currentSettings,
          savedSettings,
        }),
      );
    } catch (error) {
      recordLocalError('task-status-filter-save', error);
    }
  }

  async function saveTaskPageViewMode(pageViewMode: TaskPageViewMode): Promise<void> {
    if (!activeProjectId || pageViewMode === taskPageViewMode) return;
    const nextSettings = normalizeRendererAppShellSettings({
      ...appShellSettings,
      taskPageViewByProject: {
        ...(appShellSettings.taskPageViewByProject ?? {}),
        [activeProjectId]: pageViewMode,
      },
    });
    setAppShellSettings(nextSettings);
    if (pageViewMode === 'board' && !taskBoardSnapshots[activeProjectId]) void loadTaskBoard(activeProjectId);
    if (!props.onSaveAppShellSettings) return;
    try {
      const savedSettings = await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(nextSettings, taskManagementStatusReplacements));
      setAppShellSettings((currentSettings) => mergeAppShellSettingsSaveResponse({ currentSettings, savedSettings }));
    } catch (error) {
      recordLocalError('task-page-view-preference-save', error);
    }
  }

  async function updateTaskBoardSettings(settings: Partial<TaskBoardViewSettings>): Promise<TaskBoardViewSnapshot> {
    if (!activeProjectId || !props.nativeConversationClient) throw new Error(appShellSettings.appLanguage === 'zh-CN' ? '看板设置能力不可用。' : 'Board settings are unavailable.');
    const projectId = activeProjectId;
    const currentBoard = taskBoardSnapshots[projectId] ?? (await loadTaskBoard(projectId));
    if (!currentBoard) throw new Error(appShellSettings.appLanguage === 'zh-CN' ? '无法载入看板配置。' : 'Unable to load board settings.');
    try {
      const board = await props.nativeConversationClient.updateTaskBoard(projectId, currentBoard.revision, settings);
      setTaskBoardSnapshots((current) => ({ ...current, [projectId]: board }));
      return board;
    } catch (error) {
      if (error instanceof ZeusApiError && error.status === 409) await loadTaskBoard(projectId);
      throw error;
    }
  }

  async function moveTaskBoardTask(input: TaskBoardMoveRequest): Promise<{ task: TaskRecord; board: TaskBoardViewSnapshot }> {
    if (!activeProjectId || !props.nativeConversationClient) throw new Error(appShellSettings.appLanguage === 'zh-CN' ? '看板移动能力不可用。' : 'Board move is unavailable.');
    const projectId = activeProjectId;
    try {
      let result: { task: TaskRecord; board: TaskBoardViewSnapshot };
      try {
        result = await props.nativeConversationClient.moveTaskBoardTask(projectId, input);
      } catch (error) {
        if (!(error instanceof ZeusApiError && error.error === 'ZEUS_TASK_WORKTREE_CLEANUP_CONFIRMATION_REQUIRED')) throw error;
        const boardSettings = taskBoardSnapshots[projectId]?.settings;
        const statusId = boardSettings?.groupBy === 'managementStatus' ? input.target.groupId : boardSettings?.subgroupBy === 'managementStatus' ? input.target.subgroupId : null;
        const statusLabel = statusId ? formatConfiguredTaskManagementStatus(statusId, activeTaskManagementStatusConfig, appShellSettings.appLanguage) : appShellSettings.appLanguage === 'zh-CN' ? '终态' : 'terminal status';
        const confirmed = await requestTaskTerminalCleanupConfirmation(statusLabel);
        if (!confirmed) throw new Error(appShellSettings.appLanguage === 'zh-CN' ? '已取消移动。' : 'Move cancelled.');
        result = await props.nativeConversationClient.moveTaskBoardTask(projectId, { ...input, confirmWorktreeCleanup: true });
      }
      setTaskBoardSnapshots((current) => ({ ...current, [projectId]: result.board }));
      mergeTaskRecord(result.task);
      recordTaskMutationVersion(input.taskId, input.expectedTaskUpdatedAt, result.task.updatedAt);
      refreshOpenTaskEvents(input.taskId);
      return result;
    } catch (error) {
      if (error instanceof ZeusApiError && error.status === 409) {
        await Promise.all([loadTaskBoard(projectId), props.onLoadTask ? props.onLoadTask(input.taskId).then(mergeTaskRecord) : Promise.resolve()]);
      }
      throw error;
    }
  }

  async function saveTaskViewPreferences(input: { viewMode?: TaskWorkspaceViewMode; expandedTaskIds?: string[] }): Promise<void> {
    if (!activeProjectId) return;
    const nextSettings = normalizeRendererAppShellSettings({
      ...appShellSettings,
      taskViewModeByProject: {
        ...(appShellSettings.taskViewModeByProject ?? {}),
        [activeProjectId]: input.viewMode ?? taskViewMode,
      },
      taskExpandedIdsByProject: {
        ...(appShellSettings.taskExpandedIdsByProject ?? {}),
        [activeProjectId]: input.expandedTaskIds ?? expandedTaskIds,
      },
    });
    setAppShellSettings(nextSettings);
    if (!props.onSaveAppShellSettings) return;
    try {
      const savedSettings = await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(nextSettings, taskManagementStatusReplacements));
      setAppShellSettings((currentSettings) => mergeAppShellSettingsSaveResponse({ currentSettings, savedSettings }));
    } catch (error) {
      recordLocalError('task-view-preference-save', error);
    }
  }

  async function saveTaskTableLayout(scope: 'project' | 'global'): Promise<boolean> {
    if (scope === 'project' && !activeProjectId) return false;
    const normalizedDraft = normalizeTaskTableColumnPreferences(activeTaskTableColumns);
    const nextSettings = normalizeRendererAppShellSettings(
      scope === 'global'
        ? {
            ...appShellSettings,
            taskTableColumns: normalizedDraft,
            // “全部项目”表示重建统一基线，旧项目覆盖必须清空，否则它们仍会遮蔽新的全局设置。
            taskTableColumnsByProject: {},
          }
        : {
            ...appShellSettings,
            taskTableColumnsByProject: {
              ...(appShellSettings.taskTableColumnsByProject ?? {}),
              [activeProjectId!]: normalizedDraft,
            },
          },
    );
    setTaskTableLayoutSaveBusy(true);
    try {
      const savedSettings = props.onSaveAppShellSettings ? normalizeRendererAppShellSettings(await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(nextSettings, taskManagementStatusReplacements))) : nextSettings;
      setAppShellSettings((currentSettings) => ({
        ...savedSettings,
        taskStatusFilterByProject: currentSettings.taskStatusFilterByProject,
        taskViewModeByProject: currentSettings.taskViewModeByProject,
        taskPageViewByProject: currentSettings.taskPageViewByProject,
        taskExpandedIdsByProject: currentSettings.taskExpandedIdsByProject,
        sidebarConversationOrganization: currentSettings.sidebarConversationOrganization,
        sidebarConversationCollapsedStatusIdsByProject: currentSettings.sidebarConversationCollapsedStatusIdsByProject,
      }));
      const savedPreferences = resolveTaskTableColumnsForProject(savedSettings, activeProjectId);
      setTaskTableLayoutDraft({ projectId: activeProjectId, preferences: savedPreferences });
      setTaskTableLayoutScopeDialogOpen(false);
      if (saveTaskTableLayoutThenLeaveRef.current) {
        saveTaskTableLayoutThenLeaveRef.current = false;
        const leave = pendingTaskTableLayoutLeaveRef.current;
        pendingTaskTableLayoutLeaveRef.current = null;
        pendingTaskTableLayoutLeaveCancelRef.current = null;
        leave?.();
      }
      return true;
    } catch (error) {
      recordLocalError('renderer-action', error);
      return false;
    } finally {
      setTaskTableLayoutSaveBusy(false);
    }
  }

  function requestTaskTableLayoutLeave(leave: () => void, cancel?: () => void): void {
    if (!taskTableLayoutDirty) {
      leave();
      return;
    }
    pendingTaskTableLayoutLeaveRef.current = leave;
    pendingTaskTableLayoutLeaveCancelRef.current = cancel ?? null;
    setTaskTableLayoutLeaveDialogOpen(true);
  }

  function requestWorkspaceLeave(leave: () => void, cancel?: () => void): void {
    if (sourceWorkspaceDirty) {
      pendingSourceWorkspaceLeaveRef.current = () => requestTaskTableLayoutLeave(leave, cancel);
      pendingSourceWorkspaceLeaveCancelRef.current = cancel ?? null;
      setSourceWorkspaceLeaveDialogOpen(true);
      return;
    }
    requestTaskTableLayoutLeave(leave, cancel);
  }

  function cancelSourceWorkspaceLeave(): void {
    const cancel = pendingSourceWorkspaceLeaveCancelRef.current;
    pendingSourceWorkspaceLeaveRef.current = null;
    pendingSourceWorkspaceLeaveCancelRef.current = null;
    setSourceWorkspaceLeaveDialogOpen(false);
    cancel?.();
  }

  function discardSourceWorkspaceAndLeave(): void {
    projectSourceWorkspaceRef.current?.discardAll();
    setSourceWorkspaceLeaveDialogOpen(false);
    const leave = pendingSourceWorkspaceLeaveRef.current;
    pendingSourceWorkspaceLeaveRef.current = null;
    pendingSourceWorkspaceLeaveCancelRef.current = null;
    leave?.();
  }

  async function saveSourceWorkspaceAndLeave(): Promise<void> {
    setSourceWorkspaceSaveBusy(true);
    try {
      if (!(await projectSourceWorkspaceRef.current?.saveAll())) return;
      setSourceWorkspaceLeaveDialogOpen(false);
      const leave = pendingSourceWorkspaceLeaveRef.current;
      pendingSourceWorkspaceLeaveRef.current = null;
      pendingSourceWorkspaceLeaveCancelRef.current = null;
      leave?.();
    } finally {
      setSourceWorkspaceSaveBusy(false);
    }
  }

  function cancelTaskTableLayoutLeave(): void {
    const cancel = pendingTaskTableLayoutLeaveCancelRef.current;
    pendingTaskTableLayoutLeaveRef.current = null;
    pendingTaskTableLayoutLeaveCancelRef.current = null;
    saveTaskTableLayoutThenLeaveRef.current = false;
    setTaskTableLayoutLeaveDialogOpen(false);
    setTaskTableLayoutScopeDialogOpen(false);
    cancel?.();
  }

  function discardTaskTableLayoutAndLeave(): void {
    setTaskTableLayoutDraft({ projectId: activeProjectId, preferences: persistedTaskTableColumns });
    setTaskTableLayoutLeaveDialogOpen(false);
    const leave = pendingTaskTableLayoutLeaveRef.current;
    pendingTaskTableLayoutLeaveRef.current = null;
    pendingTaskTableLayoutLeaveCancelRef.current = null;
    leave?.();
  }

  function beginSaveTaskTableLayoutAndLeave(): void {
    saveTaskTableLayoutThenLeaveRef.current = true;
    setTaskTableLayoutLeaveDialogOpen(false);
    setTaskTableLayoutScopeDialogOpen(true);
  }

  function cancelTaskTableLayoutScopeDialog(): void {
    if (saveTaskTableLayoutThenLeaveRef.current) {
      cancelTaskTableLayoutLeave();
      return;
    }
    setTaskTableLayoutScopeDialogOpen(false);
  }

  async function clearLocalCaches(): Promise<void> {
    if (!props.onClearLocalCaches) return;
    setActionState('loading-runtime');
    try {
      const cleared = await props.onClearLocalCaches();
      setAppShellSettings((current) => ({
        ...current,
        lastCacheClearAt: cleared.clearedAt,
      }));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function clearNetworkCache(): Promise<void> {
    if (!window.zeus?.clearNetworkCache) return;
    setActionState('loading-runtime');
    try {
      await window.zeus.clearNetworkCache();
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function exportLocalSettings(): Promise<void> {
    if (!props.onExportLocalSettings) return;
    setActionState('loading-runtime');
    try {
      const exported = await props.onExportLocalSettings();
      const saved = props.onExportSettingsFile ? await props.onExportSettingsFile(exported) : { saved: false, filePath: null };
      setDataPortabilityStatus({ kind: 'exported', target: saved.saved && saved.filePath ? saved.filePath : exported.exportedAt });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function importLocalSettings(): Promise<void> {
    if (!props.onImportLocalSettings) return;
    setActionState('loading-runtime');
    try {
      const selected = props.onImportSettingsFile ? await props.onImportSettingsFile() : { imported: false, filePath: null };
      const result = await props.onImportLocalSettings(
        selected.snapshot
          ? {
              schemaVersion: 1,
              settings: {
                appShell: toSafeAppShellImport(selected.snapshot.settings.appShell),
                runtime: selected.snapshot.settings.runtime,
                codeMap: selected.snapshot.settings.codeMap,
                telegramNotification: selected.snapshot.settings.telegramNotification,
                telegramSecurity: selected.snapshot.settings.telegramSecurity,
              },
            }
          : {
              schemaVersion: 1,
              settings: {
                appShell: {
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
                  defaultModel: appShellSettings.defaultModel,
                  defaultTaskTemplateId: appShellSettings.defaultTaskTemplateId,
                  taskTableColumns: normalizeTaskTableColumnPreferences(appShellSettings.taskTableColumns),
                  taskTableColumnsByProject: Object.fromEntries(Object.entries(appShellSettings.taskTableColumnsByProject ?? {}).map(([projectId, preferences]) => [projectId, normalizeTaskTableColumnPreferences(preferences)])),
                  taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders(appShellSettings.taskTableEnumSortOrders),
                  taskManagementStatusTemplate: resolveTaskManagementStatusConfig(appShellSettings),
                  taskManagementStatusByProject: appShellSettings.taskManagementStatusByProject ?? {},
                  taskStatusFilterByProject: normalizeTaskStatusFilterByProject(appShellSettings.taskStatusFilterByProject),
                },
                runtime: runtimeSettings,
                codeMap: codeMapSettings,
                telegramNotification: telegramNotificationSettings,
                telegramSecurity: telegramSecuritySettings,
              },
            },
      );
      if (props.onLoadAppShellSettings) setAppShellSettings(normalizeRendererAppShellSettings(await props.onLoadAppShellSettings()));
      if (props.onLoadRuntimeSettings) setRuntimeSettings(normalizeRuntimeSettings(await props.onLoadRuntimeSettings()));
      if (props.onLoadCodeMapSettings) {
        const settings = normalizeCodeMapSettings(await props.onLoadCodeMapSettings());
        setCodeMapSettings(settings);
      }
      if (props.onLoadTelegramNotificationSettings) {
        const settings = await props.onLoadTelegramNotificationSettings();
        setTelegramNotificationSettings(settings);
        setTelegramNotificationChatIdsInput(settings.chatIds.join(', '));
      }
      if (props.onLoadTelegramSecuritySettings) {
        const settings = await props.onLoadTelegramSecuritySettings();
        setTelegramSecuritySettings(settings);
        setTelegramAllowedUserIdsInput(settings.allowedUserIds.join(', '));
      }
      setDataPortabilityStatus({ kind: 'imported', target: selected.imported && selected.filePath ? selected.filePath : result.importedAt, changedSettings: result.importedSettings });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function startRuntimeSession(): Promise<void> {
    if (!props.onStartRuntimeSession || !activeProjectId || !selectedProject) return;
    setActionState('loading-runtime');
    try {
      const session = await props.onStartRuntimeSession({
        projectId: activeProjectId,
        command: runtime.aiCli.command,
        args: ['--version'],
        cwd: selectedProject.localPath,
      });
      setRuntimeSessions((items) => [session, ...items.filter((item) => item.id !== session.id)]);
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(session.id));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function createGenericRuntimeConfirmation(): Promise<void> {
    const shellCommand = runtimeGenericShellCommand.trim();
    if (!props.onCreateRuntimeConfirmation || !activeProjectId || !selectedProject || !shellCommand) return;
    setActionState('loading-runtime');
    try {
      const confirmation = await props.onCreateRuntimeConfirmation({
        action: 'start_generic_session',
        reason: `用户在 Zeus 桌面端明确确认启动 Generic shell Runtime：${shellCommand}`,
        session: {
          projectId: activeProjectId,
          command: 'sh',
          args: ['-lc', shellCommand],
          cwd: selectedProject.localPath,
        },
      });
      setRuntimeConfirmation(confirmation);
      setRuntimeConfirmationCommand(shellCommand);
      setRuntimeConfirmationStatus({ kind: 'created', confirmationId: confirmation.id });
      setActionState('idle');
    } catch {
      setRuntimeConfirmationStatus({ kind: 'create_failed' });
      setActionState('failed');
    }
  }

  async function rejectGenericRuntimeConfirmation(): Promise<void> {
    if (!props.onRejectRuntimeOperation || !runtimeConfirmation) return;
    setActionState('loading-runtime');
    try {
      // 拒绝操作只关闭当前一次性令牌，不启动任何 Runtime 子进程。
      const rejected = await props.onRejectRuntimeOperation(runtimeConfirmation.id, `用户在 Runtime 设置中${sessionWorkspaceCopy.runtimeDrawer.rejectGenericShellConfirmation}`);
      setRuntimeConfirmation(rejected);
      setRuntimeConfirmationStatus({ kind: 'rejected' });
      setActionState('idle');
    } catch {
      setRuntimeConfirmationStatus({ kind: 'reject_failed' });
      setActionState('failed');
    }
  }

  async function confirmAndStartGenericRuntime(): Promise<void> {
    if (!props.onConfirmRuntimeOperation || !props.onStartRuntimeSession || !runtimeConfirmation || !activeProjectId || !selectedProject) return;
    if (!genericShellCriticalConfirmed) {
      setRuntimeConfirmationStatus({ kind: 'critical_phrase_required' });
      return;
    }
    const shellCommand = runtimeGenericShellCommand.trim();
    if (runtimeConfirmationCommand !== shellCommand) {
      setRuntimeConfirmation(undefined);
      setRuntimeConfirmationCommand('');
      setRuntimeConfirmationStatus({ kind: 'changed' });
      return;
    }
    setActionState('loading-runtime');
    try {
      const confirmed = await props.onConfirmRuntimeOperation(runtimeConfirmation.id);
      const session = await props.onStartRuntimeSession({
        projectId: activeProjectId,
        command: 'sh',
        args: ['-lc', shellCommand],
        cwd: selectedProject.localPath,
        confirmationId: confirmed.id,
      });
      setRuntimeConfirmation({
        ...confirmed,
        status: 'consumed',
        consumedAt: new Date().toISOString(),
      });
      setRuntimeConfirmationStatus({ kind: 'consumed', confirmationId: confirmed.id });
      setRuntimeSessions((items) => [session, ...items.filter((item) => item.id !== session.id)]);
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(session.id));
      setActionState('idle');
    } catch {
      setRuntimeConfirmationStatus({ kind: 'failed' });
      setActionState('failed');
    }
  }

  async function sendRuntimeInput(sessionId: string): Promise<void> {
    const input = runtimeInput.trim();
    if (!props.onSendRuntimeInput || !input) return;
    setActionState('loading-runtime');
    try {
      await props.onSendRuntimeInput(sessionId, input);
      setRuntimeInput('');
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(sessionId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function interruptRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onInterruptRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      const updated = await props.onInterruptRuntimeSession(sessionId);
      setRuntimeSessions((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(sessionId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function resizeRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onResizeRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      await props.onResizeRuntimeSession(sessionId, { cols: 120, rows: 32 });
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(sessionId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function loadRuntimeTerminalSnapshot(sessionId: string): Promise<void> {
    if (!props.onLoadRuntimeTerminalSnapshot) return;
    setActionState('loading-runtime');
    try {
      const snapshot = await props.onLoadRuntimeTerminalSnapshot(sessionId);
      setRuntimeLogs(snapshot.logs);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function stopRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onStopRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      const stopped = await props.onStopRuntimeSession(sessionId);
      setRuntimeSessions((items) => items.map((item) => (item.id === stopped.id ? stopped : item)));
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(sessionId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function refreshRuntimeSessions(): Promise<void> {
    if (!props.onLoadRuntimeSessions) return;
    setActionState('loading-runtime');
    try {
      setRuntimeSessions(
        await props.onLoadRuntimeSessions({
          query: runtimeSearchQuery.trim() || undefined,
          favoriteOnly: runtimeFavoriteOnly,
          archived: runtimeShowArchived,
        }),
      );
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function generateRuntimeSessionSummary(sessionId: string): Promise<void> {
    if (!props.onGenerateRuntimeSessionSummary) return;
    setActionState('loading-runtime');
    try {
      const updated = await props.onGenerateRuntimeSessionSummary(sessionId);
      setRuntimeSessions((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function setRuntimeSessionFavorite(session: AiRuntimeSession): Promise<void> {
    if (!props.onSetRuntimeSessionFavorite) return;
    setActionState('loading-runtime');
    try {
      const updated = await props.onSetRuntimeSessionFavorite(session.id, !session.favorite);
      setRuntimeSessions((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function archiveRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onArchiveRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      const archived = await props.onArchiveRuntimeSession(sessionId);
      setRuntimeSessions((items) => items.filter((item) => item.id !== archived.id));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function restoreRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onRestoreRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      const restored = await props.onRestoreRuntimeSession(sessionId);
      setRuntimeSessions((items) => items.map((item) => (item.id === restored.id ? restored : item)));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function createTaskFromRuntimeSession(session: AiRuntimeSession): Promise<void> {
    if (!props.onCreateTaskFromRuntimeSession) return;
    setActionState('creating-task');
    try {
      const idempotencyKey = runtimeTaskIdentityRef.current.get(session.id) ?? createSessionOperationId();
      runtimeTaskIdentityRef.current.set(session.id, idempotencyKey);
      const nextSnapshot = await props.onCreateTaskFromRuntimeSession(session.id, buildRuntimeSessionTaskDraft(session, appShellSettings.appLanguage), idempotencyKey);
      setSnapshot(nextSnapshot);
      runtimeTaskIdentityRef.current.delete(session.id);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function deleteRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onDeleteRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      const deleted = await props.onDeleteRuntimeSession(sessionId);
      setRuntimeSessions((items) => items.filter((item) => item.id !== deleted.id));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function exportRuntimeLogs(sessionId: string): Promise<void> {
    const logs = runtimeLogs.filter((entry) => entry.sessionId === sessionId);
    let sourceFilePath: string | undefined;
    if (props.onLoadRuntimeTerminalEvents) {
      const terminalEvents = await props.onLoadRuntimeTerminalEvents(sessionId, { limit: 1, offset: 0 });
      sourceFilePath = resolveRuntimeNormalizedLogPath(terminalEvents.items);
    }
    if (!window.zeus?.exportRuntimeLogsToFile || (logs.length === 0 && !sourceFilePath)) {
      setRuntimeLogExportStatus({ kind: 'empty' });
      return;
    }
    setActionState('loading-runtime');
    try {
      const exported = await window.zeus.exportRuntimeLogsToFile({
        fileName: `zeus-runtime-${sessionId}.log`,
        mimeType: 'text/plain',
        sessionId,
        sourceFilePath,
        logs: logs.map((entry) => ({
          createdAt: entry.createdAt,
          stream: entry.stream,
          text: entry.text,
        })),
      });
      setRuntimeLogExportStatus(exported.saved && exported.filePath ? { kind: 'saved', filePath: exported.filePath } : { kind: 'cancelled' });
      setActionState('idle');
    } catch {
      setRuntimeLogExportStatus({ kind: 'failed' });
      setActionState('failed');
    }
  }

  async function copyRuntimeLogs(): Promise<void> {
    const content = runtimeLogs.map(formatRuntimeLogLine).join('\n');
    if (!content) {
      setRuntimeLogCopyStatus({ kind: 'empty' });
      return;
    }
    try {
      await navigator.clipboard?.writeText(content);
      setRuntimeLogCopyStatus({ kind: 'copied' });
    } catch {
      // 非浏览器或权限不足时不伪造复制成功，仅保留可见状态。
      setRuntimeLogCopyStatus({ kind: 'failed' });
    }
  }

  async function saveTelegramBotToken(): Promise<void> {
    const token = telegramTokenInput.trim();
    if (!props.onSaveTelegramBotToken || !token) return;
    setActionState('loading-runtime');
    try {
      setSecuritySecrets(await props.onSaveTelegramBotToken(token));
      setTelegramTokenInput('');
      if (props.onLoadRuntimeStatus) setRuntimeStatus(await props.onLoadRuntimeStatus());
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function clearTelegramBotToken(): Promise<void> {
    if (!props.onClearTelegramBotToken) return;
    setActionState('loading-runtime');
    try {
      setSecuritySecrets(await props.onClearTelegramBotToken());
      if (props.onLoadRuntimeStatus) setRuntimeStatus(await props.onLoadRuntimeStatus());
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function saveExternalApiKey(): Promise<void> {
    const key = externalApiKeyInput.trim();
    if (!props.onSaveExternalApiKey || !key) return;
    setActionState('loading-runtime');
    try {
      setSecuritySecrets(await props.onSaveExternalApiKey(key));
      setExternalApiKeyInput('');
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function clearExternalApiKey(): Promise<void> {
    if (!props.onClearExternalApiKey) return;
    setActionState('loading-runtime');
    try {
      setSecuritySecrets(await props.onClearExternalApiKey());
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function resetSecurity(): Promise<void> {
    if (!props.onResetSecurity) return;
    setActionState('loading-runtime');
    try {
      const reset = await props.onResetSecurity();
      setSecuritySecrets(reset.secrets);
      setTelegramNotificationSettings(reset.telegramNotificationSettings);
      setTelegramNotificationChatIdsInput(reset.telegramNotificationSettings.chatIds.join(', '));
      setTelegramSecuritySettings(reset.telegramSecuritySettings);
      setTelegramAllowedUserIdsInput(reset.telegramSecuritySettings.allowedUserIds.join(', '));
      if (props.onLoadRuntimeStatus) setRuntimeStatus(await props.onLoadRuntimeStatus());
      if (props.onLoadTelegramPollingStatus) setTelegramPollingStatus(await props.onLoadTelegramPollingStatus());
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function saveTelegramNotificationSettings(): Promise<void> {
    if (!props.onSaveTelegramNotificationSettings) return;
    setActionState('loading-runtime');
    try {
      const settings = await props.onSaveTelegramNotificationSettings({
        enabled: telegramNotificationSettings.enabled,
        chatIds: parseNumericList(telegramNotificationChatIdsInput),
        silentMode: telegramNotificationSettings.silentMode,
      });
      setTelegramNotificationSettings(settings);
      setTelegramNotificationChatIdsInput(settings.chatIds.join(', '));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function testTelegramConnection(): Promise<void> {
    if (!props.onTestTelegramConnection) return;
    setActionState('loading-runtime');
    try {
      // 主动测试只回显 Chat ID、尝试次数和时间，不把 Bot Token 或消息明文写入界面状态。
      const result = await props.onTestTelegramConnection();
      setTelegramTestStatus(settingsWorkspaceCopy.telegram.testSuccess(result.chatIds.join(', '), result.attempts, result.sentAt));
      setActionState('idle');
    } catch {
      setTelegramTestStatus(settingsWorkspaceCopy.telegram.testFailed);
      setActionState('failed');
    }
  }

  async function saveTelegramSecuritySettings(): Promise<void> {
    if (!props.onSaveTelegramSecuritySettings) return;
    setActionState('loading-runtime');
    try {
      const settings = await props.onSaveTelegramSecuritySettings({
        allowedUserIds: parseNumericList(telegramAllowedUserIdsInput),
      });
      setTelegramSecuritySettings(settings);
      setTelegramAllowedUserIdsInput(settings.allowedUserIds.join(', '));
      setRuntimeStatus(await props.onLoadRuntimeStatus?.());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function loadTaskTemplates(): Promise<void> {
    if (!props.onLoadTaskTemplates) return;
    setActionState('loading-templates');
    try {
      setTaskTemplates(await props.onLoadTaskTemplates(activeProjectId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function createTaskFromTemplate(templateId: string): Promise<void> {
    if (!props.onCreateTaskFromTemplate || !activeProjectId) return;
    setActionState('creating-task');
    try {
      const identityKey = `${activeProjectId}:${templateId}`;
      const idempotencyKey = templateTaskIdentityRef.current.get(identityKey) ?? createSessionOperationId();
      templateTaskIdentityRef.current.set(identityKey, idempotencyKey);
      const nextSnapshot = await props.onCreateTaskFromTemplate(templateId, activeProjectId, idempotencyKey);
      setConversationDraftOpen(false);
      setSnapshot(nextSnapshot);
      const latestTaskId = nextSnapshot.tasks.at(-1)?.id;
      if (latestTaskId && props.onLoadTaskEvents) {
        setTaskEvents(await props.onLoadTaskEvents(latestTaskId));
      }
      setActionState('idle');
      templateTaskIdentityRef.current.delete(identityKey);
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  function handleMainNavigate(target: WorkspaceViewId): void {
    const navigate = () => {
      setActiveNavTarget(target);
      if (typeof window !== 'undefined') {
        // 只更新地址栏语义，不触发浏览器原生锚点滚动，避免左栏和主工作区一起跳到底部。
        window.history.replaceState(null, '', `#${target}`);
      }
      workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    };
    if (target === activeNavTarget) {
      navigate();
      return;
    }
    requestWorkspaceLeave(navigate);
  }

  function openProjectSection(project: ProjectRecord, section: ProjectWorkspaceSection, codeMode: ProjectCodeWorkspaceMode = 'source'): void {
    const navigate = () => {
      activeProjectIdRef.current = project.id;
      setProjectDetail(project);
      setConversationDraftOpen(false);
      setActiveNavTarget(section === 'sessions' ? 'conversations' : 'projects');
      setActiveProjectSection(section);
      if (section === 'code') {
        setProjectCodeWorkspaceMode(codeMode);
        setVisitedCodeWorkspaceModes((current) => new Set(current).add(codeMode));
      }
      setProjectPanel(section === 'project-settings' ? 'config' : undefined);
      if (section === 'project-settings') void loadProjectConfig(project.id);
      if (typeof window !== 'undefined') window.history.replaceState(null, '', section === 'code' ? (codeMode === 'commands' ? '#project-commands' : `#project-code-${codeMode}`) : `#project-${section}`);
      workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    };
    if (project.id === activeProjectId && section === activeProjectSection && (section !== 'code' || codeMode === projectCodeWorkspaceMode)) {
      navigate();
      return;
    }
    requestWorkspaceLeave(navigate);
  }

  function openProjectCommands(projectId: string): void {
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      recordLocalError('project-commands-open', new Error('The conversation project is no longer available.'));
      return;
    }
    const navigate = () => {
      activeProjectIdRef.current = project.id;
      setProjectDetail(project);
      setConversationDraftOpen(false);
      setActiveNavTarget('projects');
      setActiveProjectSection('code');
      setProjectCodeWorkspaceMode('commands');
      setVisitedCodeWorkspaceModes((current) => new Set(current).add('commands'));
      setProjectPanel(undefined);
      if (typeof window !== 'undefined') window.history.replaceState(null, '', '#project-commands');
      workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    };
    if (project.id === activeProjectId && activeProjectSection === 'code' && projectCodeWorkspaceMode === 'commands') {
      navigate();
      return;
    }
    requestWorkspaceLeave(navigate);
  }

  async function togglePinnedProject(projectId: string): Promise<void> {
    const currentIds = appShellSettings.pinnedProjectIds;
    const nextPinnedProjectIds = currentIds.includes(projectId) ? currentIds.filter((id) => id !== projectId) : [projectId, ...currentIds];
    const nextSettings = normalizeRendererAppShellSettings({ ...appShellSettings, pinnedProjectIds: nextPinnedProjectIds });
    setAppShellSettings(nextSettings);
    if (!props.onSaveAppShellSettings) return;
    try {
      const savedSettings = await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(nextSettings, taskManagementStatusReplacements));
      setAppShellSettings((currentSettings) =>
        mergeAppShellSettingsSaveResponse({
          currentSettings,
          savedSettings,
        }),
      );
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function toggleCollapsedProject(projectId: string): Promise<void> {
    const currentIds = appShellSettings.collapsedProjectIds;
    const nextCollapsedProjectIds = currentIds.includes(projectId) ? currentIds.filter((id) => id !== projectId) : [...currentIds, projectId];
    const nextSettings = normalizeRendererAppShellSettings({ ...appShellSettings, collapsedProjectIds: nextCollapsedProjectIds });
    setAppShellSettings(nextSettings);
    if (!props.onSaveAppShellSettings) return;
    try {
      const savedSettings = await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(nextSettings, taskManagementStatusReplacements));
      setAppShellSettings((currentSettings) => ({
        ...mergeAppShellSettingsSaveResponse({
          currentSettings,
          savedSettings,
        }),
        // 展开操作可能连续发生；慢返回只确认服务端写入，不回滚用户刚完成的下一次折叠选择。
        collapsedProjectIds: currentSettings.collapsedProjectIds,
      }));
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  function toggleSidebarConversationOrganization(): void {
    const currentSettings = appShellSettingsRef.current;
    const nextSettings = normalizeRendererAppShellSettings({
      ...currentSettings,
      sidebarConversationOrganization: currentSettings.sidebarConversationOrganization === 'task_status' ? 'flat' : 'task_status',
    });
    appShellSettingsRef.current = nextSettings;
    setAppShellSettings(nextSettings);
    persistSidebarConversationPreferences();
  }

  function toggleSidebarConversationStatusGroup(projectId: string, statusId: string): void {
    const currentSettings = appShellSettingsRef.current;
    const currentStatusIds = currentSettings.sidebarConversationCollapsedStatusIdsByProject[projectId] ?? [];
    const nextStatusIds = currentStatusIds.includes(statusId) ? currentStatusIds.filter((candidate) => candidate !== statusId) : [...currentStatusIds, statusId];
    const nextSettings = normalizeRendererAppShellSettings({
      ...currentSettings,
      sidebarConversationCollapsedStatusIdsByProject: {
        ...currentSettings.sidebarConversationCollapsedStatusIdsByProject,
        [projectId]: nextStatusIds,
      },
    });
    appShellSettingsRef.current = nextSettings;
    setAppShellSettings(nextSettings);
    persistSidebarConversationPreferences();
  }

  function repositoryPickerLabel(): string {
    if (actionState === 'creating-project') return uiCopy.sidebar.creatingRepository;
    return uiCopy.sidebar.selectRepository;
  }

  function handleWindowDragPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const bridge = window.zeus;
    if (event.button !== 0 || !bridge?.beginWindowDrag || !bridge.moveWindowDrag || !bridge.endWindowDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // 某些系统级拖拽事件不会允许 capture；后续仍通过 window 级监听完成拖拽。
    }
    void bridge.beginWindowDrag({
      screenX: event.screenX,
      screenY: event.screenY,
    });

    const handlePointerMove = (moveEvent: PointerEvent) => {
      void bridge.moveWindowDrag({
        screenX: moveEvent.screenX,
        screenY: moveEvent.screenY,
      });
    };
    const finishWindowDrag = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishWindowDrag);
      window.removeEventListener('pointercancel', finishWindowDrag);
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        // release 失败不影响 Main 进程清理拖拽状态。
      }
      void bridge.endWindowDrag();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishWindowDrag, { once: true });
    window.addEventListener('pointercancel', finishWindowDrag, { once: true });
  }

  const projectSidebarWidth = clampProjectSidebarWidth(projectSidebarPreferredWidth, projectSidebarViewportWidth);
  const projectSidebarMaximumWidth = clampProjectSidebarWidth(PROJECT_SIDEBAR_MAX_WIDTH, projectSidebarViewportWidth);
  const projectSidebarShellStyle = {
    '--zeus-project-sidebar-width': `${projectSidebarWidth}px`,
  } as CSSProperties;
  const workspaceDrawerPortalStyle = {
    // Portal 不继承应用壳层变量，只同步真实侧栏宽度用于计算抽屉可用空间；关闭点击层始终覆盖整个窗口。
    '--zeus-drawer-sidebar-inline-size': `${projectSidebarWidth + 1}px`,
  } as CSSProperties;
  const projectDrawerVisualProps = projectPanel === 'config' ? ({ presentation: 'floating', backdrop: 'dimmed', size: 'wide' } as const) : ({ presentation: 'sheet', backdrop: 'dimmed', size: 'wide' } as const);

  function commitProjectSidebarPreferredWidth(width: number): void {
    const nextWidth = normalizeProjectSidebarPreferredWidth(width);
    projectSidebarCommittedWidthRef.current = nextWidth;
    setProjectSidebarPreferredWidth(nextWidth);
    persistProjectSidebarPreferredWidth(nextWidth);
  }

  function resetProjectSidebarWidth(): void {
    projectSidebarCommittedWidthRef.current = PROJECT_SIDEBAR_DEFAULT_WIDTH;
    setProjectSidebarPreferredWidth(PROJECT_SIDEBAR_DEFAULT_WIDTH);
    persistProjectSidebarPreferredWidth(PROJECT_SIDEBAR_DEFAULT_WIDTH);
  }

  function handleProjectSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Home' || event.key === 'End' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const nextWidth = adjustProjectSidebarWidthForKeyboard(projectSidebarWidth, event.key, event.shiftKey, projectSidebarViewportWidth);
      if (nextWidth !== null && nextWidth !== projectSidebarWidth) commitProjectSidebarPreferredWidth(nextWidth);
    }
  }

  function handleProjectSidebarResizePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    projectSidebarDragCleanupRef.current?.();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startClientX = event.clientX;
    const startPreferredWidth = projectSidebarCommittedWidthRef.current;
    const startWidth = projectSidebarWidth;
    let dragState: ProjectSidebarDragState = {
      pointerId,
      startPreferredWidth,
      startRenderedWidth: startWidth,
      startClientX,
      lastClientX: startClientX,
    };
    let animationFrame = 0;

    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Electron 系统层可能拒绝 capture；window 级监听仍能完成拖动。
    }
    setProjectSidebarResizing(true);

    const applyPendingWidth = () => {
      animationFrame = 0;
      setProjectSidebarPreferredWidth(clampProjectSidebarWidth(startWidth + dragState.lastClientX - startClientX, window.innerWidth));
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const transition = transitionProjectSidebarDrag(dragState, { type: 'move', pointerId: moveEvent.pointerId, clientX: moveEvent.clientX });
      if (!transition.accepted || !transition.state) return;
      dragState = transition.state;
      if (animationFrame !== 0) return;
      animationFrame = window.requestAnimationFrame(applyPendingWidth);
    };
    const cleanup = () => {
      if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishProjectSidebarResize);
      window.removeEventListener('pointercancel', cancelProjectSidebarResize);
      window.removeEventListener('blur', cancelProjectSidebarResize);
      target.removeEventListener('lostpointercapture', cancelProjectSidebarResize);
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // capture 未建立时无需额外处理。
      }
      projectSidebarDragCleanupRef.current = null;
    };
    const cancelProjectSidebarResize = (cancelEvent?: Event) => {
      const eventPointerId = cancelEvent && 'pointerId' in cancelEvent ? (cancelEvent as PointerEvent).pointerId : undefined;
      const transition = transitionProjectSidebarDrag(dragState, { type: 'cancel', pointerId: eventPointerId });
      if (!transition.accepted || !transition.result) return;
      cleanup();
      setProjectSidebarPreferredWidth(transition.result.preferredWidth);
      setProjectSidebarResizing(false);
    };
    const finishProjectSidebarResize = (finishEvent: PointerEvent) => {
      const transition = transitionProjectSidebarDrag(dragState, { type: 'finish', pointerId: finishEvent.pointerId, clientX: finishEvent.clientX, viewportWidth: window.innerWidth });
      if (!transition.accepted || !transition.result) return;
      cleanup();
      setProjectSidebarPreferredWidth(transition.result.preferredWidth);
      if (transition.result.persist) {
        projectSidebarCommittedWidthRef.current = transition.result.preferredWidth;
        persistProjectSidebarPreferredWidth(transition.result.preferredWidth);
      }
      setProjectSidebarResizing(false);
    };

    projectSidebarDragCleanupRef.current = cancelProjectSidebarResize;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishProjectSidebarResize);
    window.addEventListener('pointercancel', cancelProjectSidebarResize);
    window.addEventListener('blur', cancelProjectSidebarResize);
    target.addEventListener('lostpointercapture', cancelProjectSidebarResize);
  }

  function renderNativeConversationWorkspace(onOpenTaskDetail: (taskId: string) => void): ReactNode {
    const taskReadOnlyGate =
      nativeSessionTaskReadOnly && nativeSessionTask && selectedNativeConversation
        ? {
            title: appShellSettings.appLanguage === 'zh-CN' ? '此任务已结束，会话当前为只读' : 'This task is closed and the conversation is read-only',
            description:
              appShellSettings.appLanguage === 'zh-CN' ? '你仍可查看完整归档记录。继续对话会重新打开任务，并只取消归档当前会话。' : 'You can still review the full archive. Continuing reopens the task and unarchives only this conversation.',
            actionLabel: appShellSettings.appLanguage === 'zh-CN' ? '重新打开任务并继续' : 'Reopen task and continue',
            busy: taskConversationReopenState?.conversationId === selectedNativeConversation.id && taskConversationReopenState.status === 'busy',
            error: taskConversationReopenState?.conversationId === selectedNativeConversation.id && taskConversationReopenState.status === 'error' ? taskConversationReopenState.error : null,
            onAction: () => reopenTaskFromConversation(nativeSessionTask.id, selectedNativeConversation.id),
          }
        : undefined;
    if (selectedTaskModelPushOperation && (!taskModelPushHasRealChoice(selectedTaskModelPushOperation) || selectedTaskModelPushOperation.status !== 'accepted') && nativeSessionOwner && props.nativeConversationClient) {
      const pending = selectedTaskModelPushOperation;
      return (
        <ConnectedSessionWorkspace
          key={`${pending.choice.projectId}:${pending.navigationId}`}
          language={appShellSettings.appLanguage}
          client={props.nativeConversationClient}
          controllerEnabled={false}
          localState={pending.session}
          conversation={pending.choice}
          task={nativeSessionTask}
          owner={nativeSessionOwner}
          choices={nativeSessionChoices}
          initialOptimisticState={pending.session}
          initialCapabilities={pending.capabilities}
          stableConversationId={pending.navigationId}
          quickActionsSuppressed={Boolean(taskDetailPaneTaskId)}
          taskManagementStatusChangeBusy={updatingTaskBusy}
          creationStatus={
            pending.status === 'failed'
              ? {
                  state: 'failed',
                  message: appShellSettings.appLanguage === 'zh-CN' ? '会话创建失败' : 'Conversation creation failed',
                  error: pending.error,
                  retryLabel: pending.contextRefreshRequired ? (appShellSettings.appLanguage === 'zh-CN' ? '重新确认' : 'Review') : appShellSettings.appLanguage === 'zh-CN' ? '重试' : 'Retry',
                  onRetry: () => retryTaskModelPush(pending.task.id),
                }
              : {
                  state: 'creating',
                  message: appShellSettings.appLanguage === 'zh-CN' ? '正在连接' : 'Connecting',
                }
          }
          localActions={taskModelPushWorkspaceActions(pending, onOpenTaskDetail)}
          onStartConversation={startNativeConversation}
          onStartProjectConversation={startProjectConversation}
          onLoadSkills={props.nativeConversationClient.loadSkills}
          onOpenTaskDetail={onOpenTaskDetail}
          onTaskManagementStatusChange={(taskId, status) => updateTaskManagementStatus(taskId, status)}
          onLoadTaskWorkspaces={props.nativeConversationClient.loadTaskGitWorkspaces}
          onOpenTaskGitReview={(taskId, workspaceId, mode) => setTaskGitReviewState({ taskId, workspaceId, mode })}
          onOpenTaskGitDelivery={(taskId, workspaceId) => openTaskGitDelivery(taskId, workspaceId)}
          onLatestContentVisibilityChange={setLatestConversationContentVisible}
        />
      );
    }
    if (selectedNativeConversation && props.nativeConversationClient && selectedNativeConversation.transportKind === 'codex_native' && nativeSessionOwner) {
      const targetWorkspace = (
        <ConnectedSessionWorkspace
          key={`${selectedNativeConversation.projectId}:${selectedTaskModelPushOperation?.navigationId ?? selectedNativeConversation.navigationId ?? selectedNativeConversation.id}`}
          language={appShellSettings.appLanguage}
          client={props.nativeConversationClient}
          controllerEnabled={!selectedTaskModelPushOperation || (selectedTaskModelPushOperation.status === 'accepted' && taskModelPushHasRealChoice(selectedTaskModelPushOperation))}
          localState={selectedTaskModelPushOperation?.session}
          localActions={selectedTaskModelPushOperation ? taskModelPushWorkspaceActions(selectedTaskModelPushOperation, onOpenTaskDetail) : undefined}
          conversation={selectedNativeConversation}
          historyOnly={selectedNativeConversationPresentation === 'history'}
          task={nativeSessionTask}
          owner={nativeSessionOwner}
          choices={nativeSessionChoices}
          initialCachedState={nativeConversationHotCacheRef.current.get(selectedNativeConversation.id)?.state}
          initialOptimisticState={selectedTaskModelPushOptimisticState}
          initialCapabilities={selectedTaskModelPushOperation?.capabilities}
          stableConversationId={selectedTaskModelPushOperation?.navigationId}
          creationStatus={
            selectedTaskModelPushOperation
              ? {
                  state: 'creating',
                  message: appShellSettings.appLanguage === 'zh-CN' ? '正在连接' : 'Connecting',
                }
              : undefined
          }
          readOnlyGate={taskReadOnlyGate}
          suppressComposer={selectedNativeConversation.readOnly}
          quickActionsSuppressed={Boolean(taskDetailPaneTaskId)}
          taskManagementStatusChangeBusy={updatingTaskBusy}
          onChooseAttachments={props.onChooseConversationResources ? chooseNativeConversationAttachments : undefined}
          onStateChange={(conversationId, state) => {
            recordNativeConversationRuntimeState(conversationId, state);
            if (selectedTaskModelPushOperation?.status === 'accepted' && selectedTaskModelPushOperation.choice?.id === conversationId && selectHasConfirmedUserMessage(state, selectedTaskModelPushOperation.request.clientUserMessageId)) {
              writeTaskModelPushPreferences(browserNativeConversationStartStorage(), selectedTaskModelPushOperation.task.projectId, selectedTaskModelPushOperation.form);
            }
          }}
          onStartConversation={startNativeConversation}
          onStartProjectConversation={startProjectConversation}
          onLoadSkills={props.nativeConversationClient.loadSkills}
          onOpenTaskDetail={onOpenTaskDetail}
          onTaskManagementStatusChange={(taskId, status) => updateTaskManagementStatus(taskId, status)}
          onLoadTaskWorkspaces={props.nativeConversationClient.loadTaskGitWorkspaces}
          onOpenTaskGitReview={(taskId, workspaceId, mode) => setTaskGitReviewState({ taskId, workspaceId, mode })}
          onOpenTaskGitDelivery={(taskId, workspaceId) => openTaskGitDelivery(taskId, workspaceId)}
          onOpenProjectCommands={() => openProjectCommands(selectedNativeConversation.projectId)}
          onLatestContentVisibilityChange={setLatestConversationContentVisible}
        />
      );
      return targetWorkspace;
    }
    return (
      <SessionWorkspace
        key={selectedNativeConversation ? `${selectedNativeConversation.projectId}:${selectedNativeConversation.navigationId ?? selectedNativeConversation.id}` : `new-conversation-${newConversationFocusRequest}`}
        language={appShellSettings.appLanguage}
        state={null}
        conversation={selectedNativeConversation}
        historyOnly={Boolean(selectedNativeConversation && selectedNativeConversationPresentation === 'history')}
        task={nativeSessionTask}
        owner={nativeSessionOwner}
        projects={snapshot.projects}
        tasks={currentProjectTasks.map((task) => createSessionWorkspaceTask(task, appShellSettings, appShellSettings.appLanguage))}
        choices={nativeSessionChoices}
        suppressComposer={Boolean(taskReadOnlyGate)}
        quickActionsSuppressed={Boolean(taskDetailPaneTaskId)}
        taskManagementStatusChangeBusy={updatingTaskBusy}
        readOnlyGate={taskReadOnlyGate}
        autoFocusNewConversation={conversationDraftOpen}
        legacyMessages={nativeLegacyMessages}
        choicesKnown={selectedNativeConversation && selectedNativeConversation.transportKind !== 'codex_native' ? true : props.nativeConversationClient ? (nativeSessionChoiceTaskState?.choicesKnown ?? false) : true}
        loadState={
          selectedNativeConversation && selectedNativeConversation.transportKind !== 'codex_native'
            ? nativeLegacyMessageLoadState
            : props.nativeConversationClient
              ? nativeSessionChoiceTaskState?.status === 'ready'
                ? 'empty'
                : (nativeSessionChoiceTaskState?.status ?? 'loading')
              : 'empty'
        }
        loadError={selectedNativeConversation && selectedNativeConversation.transportKind !== 'codex_native' ? nativeLegacyMessageError : nativeSessionChoiceTaskState?.error}
        onLatestContentVisibilityChange={setLatestConversationContentVisible}
        actions={{
          onStartConversation: startNativeConversation,
          onStartProjectConversation: startProjectConversation,
          onOpenTaskDetail,
          onTaskManagementStatusChange: (taskId, status) => updateTaskManagementStatus(taskId, status),
          onLoadCapabilities: props.nativeConversationClient?.loadCodexConversationCapabilities,
          onLoadSkills: props.nativeConversationClient?.loadSkills,
          onSelectNewConversationProject: selectNewConversationProject,
          onLoadNewConversationProjectGit: props.nativeConversationClient?.loadProjectGitWorkbench,
          onExecuteNewConversationProjectGit: props.nativeConversationClient ? executeNewConversationProjectGit : undefined,
          onChooseStartAttachments: props.onChooseConversationResources ? chooseNativeConversationAttachments : undefined,
          onOpenImportSettings: () => {
            setSettingsCategory('runtime');
            handleMainNavigate('settings');
          },
          onSelectTask: (task) => {
            const selectedTask = snapshot.tasks.find((candidate) => candidate.id === task.id);
            if (selectedTask) setTaskDetail(selectedTask);
          },
        }}
      />
    );
  }

  function closeTaskDetail(): void {
    setTaskDetailPaneTaskId(undefined);
    setTaskDetailPresentation('side_peek');
  }

  function renderTaskDetailPaneContent(): ReactNode {
    if (!taskDetailPaneTask) return null;
    return (
      <TaskDetailPaneContent
        language={appShellSettings.appLanguage}
        task={taskDetailPaneTask}
        allTasks={currentProjectTasks}
        events={taskEvents.filter((event) => event.taskId === taskDetailPaneTask.id)}
        copy={taskWorkspaceCopy}
        statusLabels={activeTaskManagementStatusLabels}
        statusDefinitions={activeTaskManagementStatusConfig.statuses}
        priorityOptions={taskWorkspaceCopy.taskCreatePriorityOptions}
        busy={updatingTaskBusy}
        terminalReadOnly={
          Boolean(optimisticTerminalTaskStatuses[taskDetailPaneTask.id]) ||
          resolveTaskManagementStatus(taskDetailPaneTask) === activeTaskManagementStatusConfig.roles.completedStatusId ||
          resolveTaskManagementStatus(taskDetailPaneTask) === activeTaskManagementStatusConfig.roles.cancelledStatusId
        }
        digitalEmployeeClient={props.commandClient ?? null}
        conversations={taskDetailPaneConversations}
        conversationsLoading={taskDetailPaneConversationState?.status === 'loading' && !taskDetailPaneConversationState.choicesKnown}
        conversationsError={taskDetailPaneConversationState?.status === 'error' ? taskDetailPaneConversationState.error : null}
        modelPushOperation={taskDetailPaneModelPushView}
        onOpenConversation={(taskId, conversationId) => void openTaskConversation(taskId, conversationId)}
        onPushNewConversation={(taskId) => void openTaskModelPush(taskId)}
        onRetryModelPush={retryTaskModelPush}
        onOpenCodeDelivery={(taskId) => openTaskGitDelivery(taskId)}
        onCommitCode={(taskId) => setTaskGitReviewState({ taskId, mode: 'commit-only' })}
        onPushCode={(taskId) => setTaskGitReviewState({ taskId, mode: 'push-only' })}
        onUpdateTaskContent={updateTaskContent}
        onUpdateRelationships={updateTaskRelationships}
        onCreateChild={(taskId) => openTaskCreateModal(taskId)}
        onDeleteTask={(taskId) => setTaskDeleteDialogTaskId(taskId)}
        onManagementStatusChange={(taskId, status, expectedUpdatedAt) => updateTaskManagementStatus(taskId, status, { expectedUpdatedAt })}
        onAuthorizeFiles={props.onAuthorizeTaskFiles}
        onMaterializeResources={props.onMaterializeTaskResources}
        onReadClipboardResources={props.onReadTaskClipboardResources}
        onReloadConversations={(taskId) => void refreshNativeConversationChoices(taskId)}
        onLoadAttachmentPreview={props.onLoadTaskAttachmentPreview}
        onOpenAttachment={props.onOpenTaskAttachment}
      />
    );
  }
  return {
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
    confirmGitOperation,
    copyRuntimeLogs,
    createGenericRuntimeConfirmation,
    createGitConfirmation,
    createTaskFromRuntimeSession,
    createTaskFromTemplate,
    deleteRuntimeSession,
    deleteTaskWithRelationshipStrategy,
    discardSourceWorkspaceAndLeave,
    discardTaskTableLayoutAndLeave,
    executeConfirmedGitOperation,
    exportGitPatch,
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
    rejectGitOperation,
    renderNativeConversationWorkspace,
    renderProjectCodeMapStage,
    renderTaskDetailPaneContent,
    repositoryPickerLabel,
    requestWorkspaceLeave,
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
    setGitHunkDecision,
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
  };
}

export type WorkspaceOperations = ReturnType<typeof useWorkspaceOperations>;
