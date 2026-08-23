import { type FormEvent, useCallback, useEffect } from 'react';
import { type ProjectCodeWorkspacePreference, renderTaskPushLayoutText, type ZentaoTaskExtract } from '@zeus/shared';
import { activateRequestingZeusWindowInMain, openExternalHttpsUrlInMain } from '../../appShellBridge.js';
import { completeCodexLoginHandoff } from '../../codexLoginHandoff.js';
import { type ConversationTreeRuntimeState, conversationTreeRuntimeStateFromConversation } from '../../session/ProjectConversationTree.js';
import {
  loadLegacyConversationDetail,
  nativeConversationChoiceFromAcceptance,
  type NativeConversationStartFailure,
  type NativeConversationStartPreparation,
  preloadCodexConversationCapabilities,
  type ProjectSessionWorkspaceStartInput,
  readCachedCodexConversationCapabilities,
  type SessionWorkspaceActions,
  type SessionWorkspaceStartInput,
  startNativeConversationWithDurableAcceptance,
  startProjectConversationWithDurableAcceptance,
} from '../../session/SessionWorkspace.js';
import type {
  CodexTaskPushCapabilities,
  NativeConversationAttachment,
  NativeConversationChoice,
  NativeConversationChoicesSnapshot,
  NativeProjectConversationChoicesSnapshot,
  NativeTurnSettingsSelection,
  StartTaskModelPushRequest,
} from '../../session/sessionTypes.js';
import { serviceTierWireOverride } from '../../session/serviceTierSelection.js';
import { resolveModelCapability } from '../../session/modelSelection.js';
import { type TaskEditResult } from '../../task/TaskDetailPaneContent.js';
import {
  buildTaskModelPushLayout,
  normalizeTaskModelPushCapabilities,
  readTaskModelPushPreferences,
  resolveTaskModelPushInitialForm,
  selectedTaskPushCurrentConversationPaths,
  selectedTaskPushParentContexts,
  selectedTaskPushRelatedContexts,
  type TaskModelPushForm,
  taskPushSupplementalLayoutAttachments,
  taskPushSupplementalRequestAttachments,
  writeTaskModelPushPreferences,
} from '../../task/TaskModelPushModal.js';
import {
  acceptTaskModelPushPendingState,
  attachTaskModelPushChoice,
  createTaskModelPushPendingState,
  enqueueTaskModelPushMessage,
  failTaskModelPushPendingState,
  retryTaskModelPushPendingState,
  taskModelPushHasRealChoice,
  type TaskModelPushPendingState,
  updateTaskModelPushAttachments,
  updateTaskModelPushDeferredMessages,
  updateTaskModelPushDraft,
} from '../../task/TaskModelPushPendingWorkspace.js';
import { type TaskResourceAuthorizationResult, type TaskResourcePayload } from '../../task/taskAttachments.js';
import { normalizeTaskTableEnumSortOrders, resolveTaskManagementStatus } from '../../task/taskWorkspaceModel.js';
import { reportApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { reportStorageReadOnlyFault } from '../../storageRecoveryError.js';
import { createSessionOperationId } from '../../sessionOperationIdentity.js';
import {
  type DashboardSnapshot,
  type GraphConversationHistoryItem,
  type GraphSearchResult,
  type GraphViewSnapshot,
  type GraphViewType,
  type ProjectGitAction,
  type ProjectGitActionResponse,
  type ProjectRecord,
  type SaveProjectConfigRequest,
  type TaskBoardOpenMode,
  type TaskManagementStatus,
  type TaskPriority,
  type TaskRecord,
  type TaskType,
  type UpdateTaskRelationshipsRequest,
  type UpdateTaskRequest,
  ZeusApiError,
  type ZeusRealtimeConnectionState,
  type ZeusRealtimeEvent,
} from '../../apiClient.js';
import { errorToLocalUiMessage, normalizeProjectConfig, parseProjectConfigList, redactLocalUiErrorMessage, toProjectConfigForm } from './WorkspaceChrome.js';
import {
  appendRuntimeOutputEventsToConversation,
  applyRuntimeEndedEventToConversation,
  beginNativeConversationChoiceTaskLoad,
  browserNativeConversationStartStorage,
  buildTaskCreateInitialForm,
  completeNativeConversationChoiceTaskLoad,
  defaultProjectNameFromLocalPath,
  executionHostSupportsConversationSource,
  failNativeConversationChoiceTaskLoad,
  formatConfiguredTaskManagementStatus,
  formatRuntimeAdapterDisplayName,
  getLanguageCopy,
  isDefinitiveNativeConversationStartRejection,
  isProjectConversationAttentionState,
  isProjectGraphViewForProject,
  isRuntimeConversationOutputEvent,
  type NativeConversationAppClient,
  normalizeCodeWorkspaceByProject,
  normalizeProjectLocalPath,
  normalizeRendererAppShellSettings,
  normalizeTaskCreateDraft,
  type ProjectCodeWorkspaceMode,
  readCodexConfigImportPromptPreference,
  resolveConversationNavigationId,
  resolveTaskManagementStatusConfig,
  selectCreatedGraphNodeTask,
  selectCreatedProjectTask,
  shouldRefreshConversationForRuntimeEvent,
  shouldRefreshNativeConversationListForRealtimeEvent,
  type TaskCreateAttachment,
  type TaskCreateAttachmentCandidate,
  type TaskCreateDraft,
  type TaskCreateTextField,
  toAppShellSettingsSavePayload,
  type TrackedTaskModelPushState,
  upsertProjectConversationChoiceSnapshot,
  upsertTaskConversationChoiceSnapshot,
  writeCodexConfigImportPromptPreference,
} from './workspaceSupport.js';
import type { WorkspaceQueryState } from './useWorkspaceQueryState.js';

/** 旧偏好只保存裸模型名时，只有项目默认来源能解除同名歧义；其他情况一律要求用户重选。 */
function resolveTaskModelPushCapability(capabilities: CodexTaskPushCapabilities, requestedIdentity: string) {
  const selected = resolveModelCapability(capabilities.models, requestedIdentity);
  if (selected) return selected;
  const preferred = resolveModelCapability(capabilities.models, capabilities.preferredModel);
  return preferred && preferred.model === requestedIdentity.trim() ? preferred : null;
}

export function useWorkspaceDomainActions(state: WorkspaceQueryState) {
  const {
    actionState,
    activeGraphView,
    activeGraphViewTypeRef,
    activeNavTarget,
    activeProjectId,
    activeProjectIdRef,
    activeProjectSection,
    activeTaskManagementStatusIds,
    appShellSettings,
    appShellSettingsRef,
    archivedConversationRefreshPromiseRef,
    codeWorkspaceCopy,
    codeWorkspacePreferenceTimerRef,
    conversationDraftOpen,
    conversationNotificationRef,
    createProjectConfigForm,
    creatingProjectBusy,
    gitDiff,
    graphConversationDetailRequestVersionRef,
    graphConversationListRequestVersionRef,
    graphConversationPage,
    graphConversationTaskIdentityRef,
    graphConversations,
    graphNodeTaskIdentityRef,
    graphProjectId,
    graphQuestionRequestVersionRef,
    graphScanRequestVersionRef,
    graphSearchRequestVersionRef,
    graphViewRequestVersionRef,
    loadTaskBoard,
    mergeTaskRecord,
    nativeConversationChoiceLoadCoordinator,
    nativeConversationChoiceTaskStates,
    nativeConversationChoicesByProjectRef,
    nativeConversationChoicesByTask,
    nativeConversationChoicesByTaskRef,
    nativeConversationRuntimeStates,
    nativeConversationStartEnvelopeManager,
    nativeLegacyMessages,
    nativeProjectConversationChoiceLoadCoordinator,
    pendingRealtimeNativeConversationRefreshIdsRef,
    pendingRealtimeTaskRefreshIdsRef,
    projectConfigForm,
    projectConversationStartEnvelopeManager,
    projectCreateForm,
    projectCreateReturnFocusRef,
    projectCreationReady,
    projectDetail,
    projectDirectoryChoosing,
    projectEditForm,
    projectSharedWritablePaths,
    projectSourceWorkspaceRef,
    projectTaskModelPushManagementStatus,
    projectedTaskConversationChoices,
    props,
    reconcileNativeConversationProjectSnapshot,
    reconcileNativeConversationProjectionStates,
    repeatRealtimeNativeConversationRefreshIdsRef,
    restoringArchivedConversationId,
    runtimeAdapters,
    runtimeSettings,
    scanBusy,
    scanState,
    selectedNativeConversationIdRef,
    selectedProject,
    selectedTaskConversationRef,
    setActionState,
    setActiveNavTarget,
    setActiveProjectSection,
    setAppShellSettings,
    setArchivedConversationLoadState,
    setArchivedConversations,
    setArchivedProjects,
    setCodexUsageRevision,
    setConversationDraftOpen,
    setConversationDrawer,
    setFocusedArchivedConversation,
    setGraphAnswer,
    setGraphConversationPage,
    setGraphConversations,
    setGraphNodeTaskFeedback,
    setGraphProjectId,
    setGraphSearchResult,
    setGraphSourceOpenFeedback,
    setGraphView,
    setLastGraphNodeTaskId,
    setLocalError,
    setNativeConversationChoiceProjectStates,
    setNativeConversationChoiceTaskStates,
    setNativeConversationChoicesByProject,
    setNativeConversationChoicesByTask,
    setNativeConversationRuntimeStates,
    setNativeConversationStatusSyncState,
    setNativeLegacyConversationDetails,
    setNativeLegacyMessageError,
    setNativeLegacyMessageLoadState,
    setNewConversationFocusRequest,
    setOptimisticTerminalTaskStatuses,
    setPendingProjectDeleteId,
    setProjectCodeWorkspaceMode,
    setProjectConfig,
    setProjectConfigForm,
    setProjectCreateDialogOpen,
    setProjectCreateError,
    setProjectCreateForm,
    setProjectDetail,
    setProjectDirectoryChoosing,
    setProjectEditForm,
    setProjectSharedWritablePaths,
    setProjectWorkspaceConfigError,
    setProjectWorkspaceConfigStatus,
    setRestoringArchivedConversationId,
    setScanState,
    setSelectedGraphConversation,
    setSelectedNativeConversationId,
    setSelectedNativeConversationPresentation,
    setSelectedTaskIds,
    setSnapshot,
    setTaskConversationDrawerTarget,
    setTaskConversationReopenState,
    setTaskCreateError,
    setTaskCreateForm,
    setTaskCreateModalOpen,
    setTaskDetail,
    setTaskDetailPaneTaskId,
    setTaskDetailPresentation,
    setTaskEvents,
    setTaskGitDeliveryRevision,
    setTaskGitMergeTaskId,
    setTaskGitReviewState,
    setTaskModelPushAnnouncement,
    setTaskModelPushCapabilities,
    setTaskModelPushConfigImportNeedsActivation,
    setTaskModelPushConfigImportPreview,
    setTaskModelPushError,
    setTaskModelPushForm,
    setTaskModelPushRefreshingRepositoryId,
    setTaskModelPushRuntimeCapabilities,
    setTaskModelPushStatus,
    setTaskModelPushTaskId,
    setTaskSearchQuery,
    setTaskTagFilter,
    setTaskTerminalCleanupConfirmation,
    setVisitedCodeWorkspaceModes,
    settingsWorkspaceCopy,
    sidebarConversationPreferenceSaveQueueRef,
    snapshot,
    taskCreateForm,
    taskCreateReturnFocusRef,
    taskCreateTitleInputRef,
    taskCreationIdentityRef,
    taskDetail,
    taskDetailPaneTaskId,
    taskGitDeliveryChangedRef,
    taskGitDeliveryConversationRef,
    taskGitReviewState,
    taskLocalVersionTransitionsRef,
    taskManagementStatusReplacementsRef,
    taskModelPushCapabilities,
    taskModelPushCapabilityRequestRef,
    taskModelPushConfigImportNeedsActivation,
    taskModelPushConfigImportPreview,
    taskModelPushDeferredDispatchingTaskIdsRef,
    taskModelPushDispatchingTaskIdsRef,
    taskModelPushEnvelopeRef,
    taskModelPushForm,
    taskModelPushLoginIdRef,
    taskModelPushLoginRequestRef,
    taskModelPushNavigationRef,
    taskModelPushPendingByTask,
    taskModelPushPendingByTaskRef,
    taskModelPushRefreshingRepositoryId,
    taskModelPushStatus,
    taskModelPushTaskId,
    taskMutationQueuesRef,
    taskStatusSettingsTargetId,
    taskTerminalCleanupConfirmation,
    taskWorkspaceCopy,
    uiCopy,
    updateTaskModelPushPendingByTask,
    visibleTasks,
    workspaceScrollRef,
  } = state;
  const persistCodeWorkspacePreference = useCallback(
    (projectId: string, preference: ProjectCodeWorkspacePreference) => {
      const normalizedPreference = normalizeCodeWorkspaceByProject({ [projectId]: preference })[projectId];
      if (!normalizedPreference) return;
      const current = appShellSettingsRef.current;
      if (JSON.stringify(current.codeWorkspaceByProject?.[projectId]) === JSON.stringify(normalizedPreference)) return;
      const next = normalizeRendererAppShellSettings({
        ...current,
        codeWorkspaceByProject: { ...(current.codeWorkspaceByProject ?? {}), [projectId]: normalizedPreference },
      });
      appShellSettingsRef.current = next;
      setAppShellSettings(next);
      if (codeWorkspacePreferenceTimerRef.current !== null) window.clearTimeout(codeWorkspacePreferenceTimerRef.current);
      codeWorkspacePreferenceTimerRef.current = window.setTimeout(() => {
        codeWorkspacePreferenceTimerRef.current = null;
        if (!props.onSaveAppShellSettings) return;
        void props
          .onSaveAppShellSettings(toAppShellSettingsSavePayload(next))
          .then((savedSettings) => {
            setAppShellSettings((latest) => ({
              ...normalizeRendererAppShellSettings(savedSettings),
              codeWorkspaceByProject: latest.codeWorkspaceByProject,
              taskTableColumns: latest.taskTableColumns,
              taskTableColumnsByProject: latest.taskTableColumnsByProject,
              taskTableEnumSortOrders: latest.taskTableEnumSortOrders,
              taskStatusFilterByProject: latest.taskStatusFilterByProject,
              taskViewModeByProject: latest.taskViewModeByProject,
              taskExpandedIdsByProject: latest.taskExpandedIdsByProject,
              sidebarConversationOrganization: latest.sidebarConversationOrganization,
              sidebarConversationCollapsedStatusIdsByProject: latest.sidebarConversationCollapsedStatusIdsByProject,
            }));
          })
          .catch((error) => recordLocalError('renderer-action', error));
      }, 400);
    },
    [props.onSaveAppShellSettings],
  );
  const persistSidebarConversationPreferences = useCallback((): void => {
    const saveAppShellSettings = props.onSaveAppShellSettings;
    if (!saveAppShellSettings) return;
    sidebarConversationPreferenceSaveQueueRef.current = sidebarConversationPreferenceSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const latestSettings = appShellSettingsRef.current;
        await saveAppShellSettings(toAppShellSettingsSavePayload(latestSettings, taskManagementStatusReplacementsRef.current));
      })
      .catch((error: unknown) => {
        recordLocalError('sidebar-conversation-preference-save', error);
      });
  }, [props.onSaveAppShellSettings]);

  const acknowledgeNativeConversationAttention = useCallback(
    (projectId: string, conversationId: string, expectedRevision: number): void => {
      const client = props.nativeConversationClient;
      if (!client) return;
      void client
        .acknowledgeNativeConversationAttention(projectId, conversationId, expectedRevision)
        .then(({ conversation }) => {
          if (conversation.projectId !== projectId || conversation.id !== conversationId) return;
          if (conversation.taskId) {
            setNativeConversationChoicesByTask((current) => ({
              ...current,
              [conversation.taskId!]: upsertTaskConversationChoiceSnapshot(conversation.taskId!, current[conversation.taskId!], conversation),
            }));
          } else {
            setNativeConversationChoicesByProject((current) => ({
              ...current,
              [projectId]: upsertProjectConversationChoiceSnapshot(current[projectId], conversation),
            }));
          }
        })
        .catch((error: unknown) => recordLocalError('conversation-attention-acknowledgement', error));
    },
    [props.nativeConversationClient],
  );

  useEffect(() => {
    const subscribeRealtimeEvents = props.onSubscribeRealtimeEvents;
    if (!subscribeRealtimeEvents) return;
    let pendingRuntimeConversationEvents: ZeusRealtimeEvent[] = [];
    let runtimeConversationFlushTimer: number | undefined;
    const flushRuntimeConversationEvents = (): void => {
      if (runtimeConversationFlushTimer) window.clearTimeout(runtimeConversationFlushTimer);
      runtimeConversationFlushTimer = undefined;
      if (pendingRuntimeConversationEvents.length === 0) return;
      const events = pendingRuntimeConversationEvents;
      pendingRuntimeConversationEvents = [];
      const sessionIds = new Set(events.map((event) => event.payload.sessionId).filter((sessionId): sessionId is string => typeof sessionId === 'string'));
      const appendEvents = (conversation: GraphConversationHistoryItem): GraphConversationHistoryItem =>
        conversation.sessionId && sessionIds.has(conversation.sessionId) ? appendRuntimeOutputEventsToConversation(conversation, events) : conversation;
      setGraphConversations((current) => {
        let changed = false;
        const next = current.map((conversation) => {
          const updated = appendEvents(conversation);
          if (updated !== conversation) changed = true;
          return updated;
        });
        return changed ? next : current;
      });
      setSelectedGraphConversation((current) => (current ? appendEvents(current) : current));
    };
    const queueRuntimeConversationEvent = (event: ZeusRealtimeEvent): void => {
      pendingRuntimeConversationEvents.push(event);
      if (pendingRuntimeConversationEvents.length >= 100) {
        flushRuntimeConversationEvents();
        return;
      }
      runtimeConversationFlushTimer ??= window.setTimeout(flushRuntimeConversationEvents, 100);
    };
    const refreshNativeConversationList = (projectId: string, conversationId: string): void => {
      const client = props.nativeConversationClient;
      if (!client) return;
      if (pendingRealtimeNativeConversationRefreshIdsRef.current.has(conversationId)) {
        repeatRealtimeNativeConversationRefreshIdsRef.current.add(conversationId);
        return;
      }
      pendingRealtimeNativeConversationRefreshIdsRef.current.add(conversationId);
      void client
        .loadNativeConversationChoice(projectId, conversationId)
        .then((metadata) => {
          if (metadata.id !== conversationId || metadata.projectId !== projectId) return;
          if (metadata.taskId) {
            const taskId = metadata.taskId;
            // 使更早发出的批量快照失效，避免旧状态覆盖实时轻量投影。
            nativeConversationChoiceLoadCoordinator.begin(taskId);
            setNativeConversationChoicesByTask((current) => {
              const next = { ...current, [taskId]: upsertTaskConversationChoiceSnapshot(taskId, current[taskId], metadata) };
              nativeConversationChoicesByTaskRef.current = next;
              return next;
            });
            setNativeConversationChoiceTaskStates((current) => ({ ...current, [taskId]: completeNativeConversationChoiceTaskLoad(current[taskId]) }));
          } else {
            nativeProjectConversationChoiceLoadCoordinator.begin(projectId);
            setNativeConversationChoicesByProject((current) => {
              const next = { ...current, [projectId]: upsertProjectConversationChoiceSnapshot(current[projectId], metadata) };
              nativeConversationChoicesByProjectRef.current = next;
              return next;
            });
            setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: completeNativeConversationChoiceTaskLoad(current[projectId]) }));
          }
          // 轻量元数据是全部列表投影的权威收口；当前打开会话也必须覆盖旧缓存，避免控制器与任务表长期分裂。
          reconcileNativeConversationProjectionStates([metadata]);
        })
        .catch((error: unknown) => recordLocalError('conversation-list-realtime-refresh', error))
        .finally(() => {
          pendingRealtimeNativeConversationRefreshIdsRef.current.delete(conversationId);
          if (!repeatRealtimeNativeConversationRefreshIdsRef.current.delete(conversationId)) return;
          refreshNativeConversationList(projectId, conversationId);
        });
    };
    let connectionState: ZeusRealtimeConnectionState = 'connecting';
    let statusSyncGeneration = 0;
    let statusSyncAttempt = 0;
    let statusSyncRetryTimer: number | undefined;
    let statusSnapshotTimer: number | undefined;
    let statusSnapshotRunning = false;
    const clearStatusSyncRetry = (): void => {
      if (statusSyncRetryTimer !== undefined) window.clearTimeout(statusSyncRetryTimer);
      statusSyncRetryTimer = undefined;
    };
    const clearStatusSnapshotTimer = (): void => {
      if (statusSnapshotTimer !== undefined) window.clearInterval(statusSnapshotTimer);
      statusSnapshotTimer = undefined;
    };
    const quietlyReconcileActiveProjectConversationStatus = (): void => {
      if (connectionState !== 'connected' || statusSnapshotRunning) return;
      const projectId = activeProjectIdRef.current;
      if (!projectId) return;
      statusSnapshotRunning = true;
      void reconcileNativeConversationProjectSnapshot(projectId)
        .catch((error: unknown) => recordLocalError('conversation-status-periodic-reconciliation', error))
        .finally(() => {
          statusSnapshotRunning = false;
        });
    };
    const synchronizeActiveProjectConversationStatus = (): void => {
      clearStatusSyncRetry();
      if (connectionState !== 'connected') return;
      const projectId = activeProjectIdRef.current;
      if (!projectId) {
        setNativeConversationStatusSyncState('connected');
        return;
      }
      const generation = ++statusSyncGeneration;
      setNativeConversationStatusSyncState('syncing');
      void reconcileNativeConversationProjectSnapshot(projectId).then(
        () => {
          if (connectionState !== 'connected' || generation !== statusSyncGeneration) return;
          statusSyncAttempt = 0;
          setNativeConversationStatusSyncState('connected');
        },
        (error: unknown) => {
          if (connectionState !== 'connected' || generation !== statusSyncGeneration) return;
          console.warn('会话状态权威快照校准失败，将自动重试。', error);
          const delay = Math.min(1_000 * 2 ** Math.min(statusSyncAttempt, 3), 8_000);
          statusSyncAttempt += 1;
          statusSyncRetryTimer = window.setTimeout(synchronizeActiveProjectConversationStatus, delay);
        },
      );
    };
    const unsubscribe = subscribeRealtimeEvents(
      (event) => {
        if (event.type === 'storage.write_fault') {
          reportStorageReadOnlyFault(appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en', event.payload.readsAvailable === true, (error) => recordLocalError('storage-recovery-preflight-and-restart', error));
          return;
        }
        if (event.type === 'codex.usage.changed') setCodexUsageRevision((current) => current + 1);
        if (typeof event.payload.projectId === 'string' && isProjectConversationAttentionState(event.payload.conversationAttentionState)) {
          const projectId = event.payload.projectId;
          const attentionState = event.payload.conversationAttentionState;
          setSnapshot((current) =>
            current.conversationAttentionByProject[projectId] === attentionState
              ? current
              : {
                  ...current,
                  conversationAttentionByProject: {
                    ...current.conversationAttentionByProject,
                    [projectId]: attentionState,
                  },
                },
          );
        }
        if (typeof event.payload.projectId === 'string' && typeof event.payload.conversationUnreadCount === 'number') {
          const projectId = event.payload.projectId;
          const unreadCount = Math.max(0, Math.floor(event.payload.conversationUnreadCount));
          setSnapshot((current) =>
            current.conversationUnreadCountByProject?.[projectId] === unreadCount
              ? current
              : {
                  ...current,
                  conversationUnreadCountByProject: {
                    ...(current.conversationUnreadCountByProject ?? {}),
                    [projectId]: unreadCount,
                  },
                },
          );
        }
        if (shouldRefreshNativeConversationListForRealtimeEvent(event)) {
          refreshNativeConversationList(event.payload.projectId as string, event.payload.conversationId as string);
        }
        if (event.type === 'conversation.thread.archived' && typeof event.payload.conversationId === 'string') {
          const conversationId = event.payload.conversationId;
          const taskId = typeof event.payload.taskId === 'string' ? event.payload.taskId : null;
          const projectId = typeof event.payload.projectId === 'string' ? event.payload.projectId : null;
          if (taskId) nativeConversationChoiceLoadCoordinator.forget(taskId, conversationId);
          else if (projectId) nativeProjectConversationChoiceLoadCoordinator.forget(projectId, conversationId);
          setNativeConversationChoicesByProject((current) =>
            Object.fromEntries(
              Object.entries(current).map(([projectId, choices]) => [
                projectId,
                { ...choices, choices: choices.choices.filter((choice) => choice.id !== conversationId), items: choices.items.filter((choice) => choice.id !== conversationId) },
              ]),
            ),
          );
          setNativeConversationChoicesByTask((current) =>
            Object.fromEntries(
              Object.entries(current).map(([taskId, choices]) => [taskId, { ...choices, choices: choices.choices.filter((choice) => choice.id !== conversationId), items: choices.items.filter((choice) => choice.id !== conversationId) }]),
            ),
          );
          if (selectedNativeConversationIdRef.current === conversationId) {
            selectedNativeConversationIdRef.current = null;
            setSelectedNativeConversationId(null);
            setFocusedArchivedConversation(null);
            setConversationDraftOpen(false);
          }
          void refreshArchivedConversations();
        }
        if (event.type === 'conversation.thread.unarchived') {
          const taskId = typeof event.payload.taskId === 'string' ? event.payload.taskId : null;
          const projectId = typeof event.payload.projectId === 'string' ? event.payload.projectId : null;
          if (taskId) void refreshNativeConversationChoices(taskId);
          else if (projectId) void refreshNativeProjectConversationChoices(projectId);
          void refreshArchivedConversations();
        }
        if (event.type === 'task.git_delivery.changed' && typeof event.payload.taskId === 'string') {
          setTaskGitDeliveryRevision((current) => current + 1);
          taskGitDeliveryChangedRef.current(event.payload.taskId);
        }
        if (event.type === 'task.board.updated' && typeof event.payload.projectId === 'string') {
          void loadTaskBoard(event.payload.projectId);
        }
        if (event.type === 'task.updated' && typeof event.payload.taskId === 'string' && props.onLoadTask) {
          const taskId = event.payload.taskId;
          if (typeof event.payload.managementStatus === 'string') {
            const incomingManagementStatus = event.payload.managementStatus;
            const updatedAt = typeof event.payload.updatedAt === 'string' ? event.payload.updatedAt : undefined;
            // 任务事件已经是服务端确认事实，先收口终态成员资格，再用完整任务读取补齐其余字段。
            setSnapshot((current) => ({
              ...current,
              tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, managementStatus: incomingManagementStatus, ...(updatedAt ? { updatedAt } : {}) } : task)),
            }));
            setTaskDetail((current) => (current?.id === taskId ? { ...current, managementStatus: incomingManagementStatus, ...(updatedAt ? { updatedAt } : {}) } : current));
            void refreshNativeConversationChoices(taskId).catch((error: unknown) => recordLocalError('task-conversation-realtime-refresh', error));
          }
          if (!pendingRealtimeTaskRefreshIdsRef.current.has(taskId)) {
            pendingRealtimeTaskRefreshIdsRef.current.add(taskId);
            void props
              .onLoadTask(taskId)
              .then(mergeTaskRecord)
              .catch((error: unknown) => recordLocalError('task-realtime-refresh', error))
              .finally(() => {
                pendingRealtimeTaskRefreshIdsRef.current.delete(taskId);
              });
          }
        }
        const conversation = selectedTaskConversationRef.current;
        if (isRuntimeConversationOutputEvent(event, conversation)) {
          queueRuntimeConversationEvent(event);
          return;
        }
        if (!shouldRefreshConversationForRuntimeEvent(event, conversation)) return;
        if (!conversation) return;
        flushRuntimeConversationEvents();
        setGraphConversations((current) => current.map((candidate) => (candidate.id === conversation.id ? applyRuntimeEndedEventToConversation(candidate, event) : candidate)));
        setSelectedGraphConversation((current) => (current?.id === conversation.id ? applyRuntimeEndedEventToConversation(current, event) : current));
      },
      (state) => {
        connectionState = state;
        statusSyncGeneration += 1;
        clearStatusSyncRetry();
        if (state === 'connected') {
          statusSyncAttempt = 0;
          synchronizeActiveProjectConversationStatus();
          clearStatusSnapshotTimer();
          // 实时终态事件偶发缺失时，后台完整快照负责自动收敛，用户无需点击会话触发修正。
          statusSnapshotTimer = window.setInterval(quietlyReconcileActiveProjectConversationStatus, 10_000);
          return;
        }
        clearStatusSnapshotTimer();
        setNativeConversationStatusSyncState(state);
      },
    );
    return () => {
      if (runtimeConversationFlushTimer) window.clearTimeout(runtimeConversationFlushTimer);
      clearStatusSyncRetry();
      clearStatusSnapshotTimer();
      statusSyncGeneration += 1;
      pendingRuntimeConversationEvents = [];
      if (unsubscribe) unsubscribe();
    };
  }, [
    loadTaskBoard,
    mergeTaskRecord,
    nativeConversationChoiceLoadCoordinator,
    nativeProjectConversationChoiceLoadCoordinator,
    props.nativeConversationClient,
    props.onLoadTask,
    props.onSubscribeRealtimeEvents,
    reconcileNativeConversationProjectSnapshot,
    reconcileNativeConversationProjectionStates,
  ]);

  const taskDetailPaneTaskSource = taskDetailPaneTaskId ? (taskDetail?.id === taskDetailPaneTaskId ? taskDetail : snapshot.tasks.find((task) => task.id === taskDetailPaneTaskId)) : undefined;
  const taskDetailPaneTask = taskDetailPaneTaskSource ? projectTaskModelPushManagementStatus(taskDetailPaneTaskSource) : undefined;
  const taskDetailPaneConversations = taskDetailPaneTask ? (nativeConversationChoicesByTask[taskDetailPaneTask.id]?.choices ?? []) : [];
  const taskDetailPaneConversationState = taskDetailPaneTask ? nativeConversationChoiceTaskStates[taskDetailPaneTask.id] : undefined;
  const taskDetailPaneModelPushOperation = taskDetailPaneTask ? taskModelPushPendingByTask[taskDetailPaneTask.id] : undefined;
  const taskDetailPaneModelPushView = taskDetailPaneModelPushOperation
    ? {
        status: taskDetailPaneModelPushOperation.status,
        error: taskDetailPaneModelPushOperation.error,
        ...(taskDetailPaneModelPushOperation.choice ? { conversationId: taskDetailPaneModelPushOperation.choice.id } : {}),
      }
    : undefined;
  const currentRuntimeAdapterDisplayName = formatRuntimeAdapterDisplayName(runtimeSettings.defaultAdapterId, runtimeAdapters, settingsWorkspaceCopy.runtime);
  const taskTableEnumSortOrders = normalizeTaskTableEnumSortOrders({ ...appShellSettings.taskTableEnumSortOrders, managementStatus: activeTaskManagementStatusIds }, activeTaskManagementStatusIds);
  const taskPriorityLabels = Object.fromEntries(taskWorkspaceCopy.taskCreatePriorityOptions.map((option) => [option.value, option.label])) as Record<TaskPriority, string>;
  const taskStatusSettingsProject = snapshot.projects.find((project) => project.id === taskStatusSettingsTargetId);
  const effectiveTaskStatusSettingsTargetId = taskStatusSettingsProject ? taskStatusSettingsProject.id : '__template__';
  const taskStatusSettingsConfig = effectiveTaskStatusSettingsTargetId === '__template__' ? resolveTaskManagementStatusConfig(appShellSettings) : resolveTaskManagementStatusConfig(appShellSettings, effectiveTaskStatusSettingsTargetId);
  const taskStatusSettingsUsageCounts =
    effectiveTaskStatusSettingsTargetId === '__template__'
      ? {}
      : snapshot.tasks
          .filter((task) => task.projectId === effectiveTaskStatusSettingsTargetId)
          .reduce<Record<string, number>>((counts, task) => {
            const managementStatus = resolveTaskManagementStatus(task);
            counts[managementStatus] = (counts[managementStatus] ?? 0) + 1;
            return counts;
          }, {});
  const changedFiles = gitDiff?.files ?? snapshot.git.changedFiles;

  useEffect(() => {
    const visibleTaskIdSet = new Set(visibleTasks.map((task) => task.id));
    // 批量选择只作用于当前项目和当前筛选结果；项目切换、刷新或筛选变化后，过期 id 必须自动剔除。
    setSelectedTaskIds((ids) => ids.filter((id) => visibleTaskIdSet.has(id)));
  }, [visibleTasks]);

  function recordLocalError(action: string, error: unknown): void {
    // 只记录真实捕获到的前端操作失败，并在渲染前脱敏，避免把 token / API key 明文带到界面。
    setLocalError({
      action,
      message: redactLocalUiErrorMessage(errorToLocalUiMessage(error)),
      occurredAt: new Date().toISOString(),
    });
    setActionState('failed');
  }

  function enqueueTaskMutation<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = taskMutationQueuesRef.current.get(taskId) ?? Promise.resolve();
    const mutation = previous.catch(() => undefined).then(operation);
    const completion = mutation.then(
      () => undefined,
      () => undefined,
    );
    taskMutationQueuesRef.current.set(taskId, completion);
    void completion.finally(() => {
      if (taskMutationQueuesRef.current.get(taskId) === completion) taskMutationQueuesRef.current.delete(taskId);
    });
    return mutation;
  }

  function resolveTaskMutationVersion(taskId: string, requestedVersion: string): string {
    const transitions = taskLocalVersionTransitionsRef.current.get(taskId);
    if (!transitions) return requestedVersion;
    const seen = new Set<string>();
    let resolved = requestedVersion;
    while (!seen.has(resolved)) {
      seen.add(resolved);
      const next = transitions.get(resolved);
      if (!next || next === resolved) break;
      resolved = next;
    }
    return resolved;
  }

  function recordTaskMutationVersion(taskId: string, previousVersion: string | undefined, nextVersion: string | undefined): void {
    if (!previousVersion || !nextVersion || previousVersion === nextVersion) return;
    const transitions = taskLocalVersionTransitionsRef.current.get(taskId) ?? new Map<string, string>();
    transitions.set(previousVersion, nextVersion);
    taskLocalVersionTransitionsRef.current.set(taskId, transitions);
  }

  function applyTaskMutationSnapshot(nextSnapshot: DashboardSnapshot, taskId: string): TaskRecord {
    const updatedTask = nextSnapshot.tasks.find((task) => task.id === taskId);
    if (!updatedTask) throw new Error(`Updated task ${taskId} was not present in the dashboard snapshot.`);
    mergeTaskRecord(updatedTask);
    return updatedTask;
  }

  function refreshOpenTaskEvents(taskId: string): void {
    if (!props.onLoadTaskEvents || taskDetailPaneTaskId !== taskId) return;
    void props
      .onLoadTaskEvents(taskId)
      .then(setTaskEvents)
      .catch((error: unknown) => recordLocalError('task-event-refresh', error));
  }

  async function loadLatestTaskAfterConflict(taskId: string): Promise<TaskRecord | null> {
    if (!props.onLoadTask) return null;
    const latest = await props.onLoadTask(taskId);
    taskLocalVersionTransitionsRef.current.delete(taskId);
    mergeTaskRecord(latest);
    return latest;
  }

  async function updateTaskContent(taskId: string, input: UpdateTaskRequest): Promise<TaskEditResult> {
    if (!props.onUpdateTask) throw new Error('Task update handler is not available.');
    return enqueueTaskMutation(taskId, async () => {
      const expectedUpdatedAt = resolveTaskMutationVersion(taskId, input.expectedUpdatedAt);
      setActionState('updating-task');
      try {
        const nextSnapshot = await props.onUpdateTask?.(taskId, { ...input, expectedUpdatedAt });
        if (!nextSnapshot) throw new Error('Task update handler returned no dashboard snapshot.');
        const updatedTask = applyTaskMutationSnapshot(nextSnapshot, taskId);
        recordTaskMutationVersion(taskId, expectedUpdatedAt, updatedTask.updatedAt);
        refreshOpenTaskEvents(taskId);
        setActionState('idle');
        return { kind: 'updated', task: updatedTask };
      } catch (error) {
        if (error instanceof ZeusApiError && error.error === 'ZEUS_TASK_EDIT_CONFLICT') {
          const latest = await loadLatestTaskAfterConflict(taskId);
          if (latest) {
            setActionState('idle');
            return { kind: 'conflict', latest };
          }
        }
        setActionState('idle');
        throw error;
      }
    });
  }

  async function updateTaskRelationships(taskId: string, input: UpdateTaskRelationshipsRequest): Promise<TaskEditResult> {
    if (!props.onUpdateTaskRelationships) throw new Error('Task relationship update handler is not available.');
    return enqueueTaskMutation(taskId, async () => {
      const expectedUpdatedAt = resolveTaskMutationVersion(taskId, input.expectedUpdatedAt);
      setActionState('updating-task');
      try {
        const nextSnapshot = await props.onUpdateTaskRelationships?.(taskId, { ...input, expectedUpdatedAt });
        if (!nextSnapshot) throw new Error('Task relationship update handler returned no dashboard snapshot.');
        const updatedTask = applyTaskMutationSnapshot(nextSnapshot, taskId);
        recordTaskMutationVersion(taskId, expectedUpdatedAt, updatedTask.updatedAt);
        setSnapshot(nextSnapshot);
        refreshOpenTaskEvents(taskId);
        setActionState('idle');
        return { kind: 'updated', task: updatedTask };
      } catch (error) {
        if (error instanceof ZeusApiError && error.error === 'ZEUS_TASK_EDIT_CONFLICT') {
          const latest = await loadLatestTaskAfterConflict(taskId);
          if (latest) {
            setActionState('idle');
            return { kind: 'conflict', latest };
          }
        }
        setActionState('idle');
        throw error;
      }
    });
  }

  async function loadTaskDetail(taskId: string): Promise<void> {
    setConversationDraftOpen(false);
    if (!props.onLoadTask) {
      setTaskDetail(snapshot.tasks.find((task) => task.id === taskId));
      return;
    }
    setActionState('updating-task');
    try {
      const task = await props.onLoadTask(taskId);
      setTaskDetail(task);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function openTaskDetailPane(taskId: string, presentation: TaskBoardOpenMode = 'side_peek'): Promise<void> {
    // 任务详情只有真正打开时才建立选中态；看板可在右侧抽屉、居中预览和工作区全页之间选择。
    setTaskDetailPresentation(presentation);
    setTaskDetailPaneTaskId(taskId);
    const pending: Promise<void>[] = [loadTaskDetail(taskId)];
    if (props.onLoadTaskEvents) {
      pending.push(
        props
          .onLoadTaskEvents(taskId)
          .then(setTaskEvents)
          .catch((error: unknown) => {
            recordLocalError('renderer-action', error);
          }),
      );
    }
    if (props.nativeConversationClient) {
      pending.push(
        refreshNativeConversationChoices(taskId)
          .then(() => undefined)
          .catch((error: unknown) => {
            recordLocalError('task-conversation-choice-load', error);
          }),
      );
    }
    await Promise.all(pending);
  }

  async function loadProjectConfig(projectId: string): Promise<void> {
    if (!props.onLoadProjectConfig) return;
    setActionState('creating-project');
    try {
      const loadedConfig = normalizeProjectConfig(await props.onLoadProjectConfig(projectId), projectId);
      setProjectConfig(loadedConfig);
      setProjectConfigForm(toProjectConfigForm(loadedConfig));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function loadProjectWorkspaceConfig(projectId: string): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client) return;
    setProjectWorkspaceConfigStatus('loading');
    setProjectWorkspaceConfigError(null);
    try {
      const config = await client.loadProjectWorkspaceConfig(projectId);
      setProjectSharedWritablePaths(config.sharedWritablePaths.map((entry) => entry.localPath).join('\n'));
      setProjectWorkspaceConfigStatus('idle');
    } catch (error) {
      setProjectWorkspaceConfigStatus('error');
      setProjectWorkspaceConfigError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    }
  }

  async function saveProjectWorkspaceConfig(projectId: string): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client) return;
    setProjectWorkspaceConfigStatus('saving');
    setProjectWorkspaceConfigError(null);
    try {
      const saved = await client.saveProjectWorkspaceConfig(projectId, {
        sharedWritablePaths: parseProjectConfigList(projectSharedWritablePaths).map((localPath) => ({ localPath })),
      });
      setProjectSharedWritablePaths(saved.sharedWritablePaths.map((entry) => entry.localPath).join('\n'));
      setProjectWorkspaceConfigStatus('idle');
    } catch (error) {
      setProjectWorkspaceConfigStatus('error');
      setProjectWorkspaceConfigError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    }
  }

  async function saveProjectConfig(projectId: string, event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (!props.onSaveProjectConfig) return;
    const input: SaveProjectConfigRequest = {
      defaultModel: projectConfigForm.defaultModel.trim() || null,
      defaultWorkMode: projectConfigForm.defaultWorkMode,
      defaultTaskPrompt: projectConfigForm.defaultTaskPrompt.trim(),
      scan: {
        ignoreDirectories: parseProjectConfigList(projectConfigForm.scanIgnoreDirectories),
        indexScope: projectConfigForm.indexScope,
      },
      language: {
        primary: projectConfigForm.languagePrimary.trim() || 'typescript',
        additional: parseProjectConfigList(projectConfigForm.languageAdditional),
      },
      dependencies: {
        packageManagers: parseProjectConfigList(projectConfigForm.packageManagers),
        manifestPaths: parseProjectConfigList(projectConfigForm.manifestPaths),
      },
      database: {
        connectionName: projectConfigForm.databaseConnectionName.trim() || null,
        schemaPaths: parseProjectConfigList(projectConfigForm.databaseSchemaPaths),
      },
      telegram: {
        alias: projectConfigForm.telegramAlias.trim() || null,
      },
      security: {
        allowShell: projectConfigForm.allowShell,
        allowGitWrite: projectConfigForm.allowGitWrite,
      },
    };
    setActionState('creating-project');
    try {
      // 项目配置只保存本机偏好，不验证或伪造外部 CLI、数据库、Telegram 的可用性。
      const savedConfig = normalizeProjectConfig(await props.onSaveProjectConfig(projectId, input), projectId);
      setProjectConfig(savedConfig);
      setProjectConfigForm(toProjectConfigForm(savedConfig));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function updateProject(projectId: string, event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (!props.onUpdateProject) return;
    const name = projectEditForm.name.trim();
    if (!name) return;
    setActionState('creating-project');
    try {
      const nextSnapshot = await props.onUpdateProject(projectId, {
        name,
        localPath: projectEditForm.localPath.trim() || undefined,
        description: projectEditForm.description.trim() || null,
        note: projectEditForm.note.trim() || null,
      });
      setSnapshot(nextSnapshot);
      const updatedProject = nextSnapshot.projects.find((project) => project.id === projectId);
      setProjectDetail(updatedProject);
      if (updatedProject)
        setProjectEditForm({
          name: updatedProject.name,
          localPath: updatedProject.localPath,
          description: updatedProject.description ?? '',
          note: updatedProject.note ?? '',
        });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function renameProjectDisplayName(projectId: string, displayName: string): Promise<void> {
    if (!props.onUpdateProject) throw new Error('Project rename is unavailable.');
    const name = displayName.trim();
    if (!name) throw new Error(getLanguageCopy(appShellSettings.appLanguage).sidebar.renameRequired);
    const currentProject = snapshot.projects.find((project) => project.id === projectId);
    if (!currentProject || currentProject.name === name) return;
    setActionState('creating-project');
    try {
      // 侧栏重命名只提交 name，避免把旧表单中的路径或说明顺带覆盖到真实项目记录。
      const nextSnapshot = await props.onUpdateProject(projectId, { name });
      const updatedProject = nextSnapshot.projects.find((project) => project.id === projectId);
      setSnapshot(nextSnapshot);
      if (projectDetail?.id === projectId) {
        setProjectDetail(updatedProject);
        if (updatedProject) {
          setProjectEditForm({
            name: updatedProject.name,
            localPath: updatedProject.localPath,
            description: updatedProject.description ?? '',
            note: updatedProject.note ?? '',
          });
        }
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('project-rename', error);
      throw error;
    }
  }

  async function revealProjectInFinder(projectPath: string): Promise<void> {
    if (!props.onRevealProjectInFinder) throw new Error('Project reveal is unavailable.');
    try {
      const result = await props.onRevealProjectInFinder(projectPath);
      if (!result.revealed) throw new Error(result.error ?? 'Project reveal failed.');
    } catch (error) {
      recordLocalError('project-reveal-in-finder', error);
      throw error;
    }
  }

  async function deleteProject(projectId: string): Promise<void> {
    if (!props.onDeleteProject) return;
    setActionState('creating-project');
    try {
      const nextSnapshot = await props.onDeleteProject(projectId);
      setSnapshot(nextSnapshot);
      setProjectDetail(nextSnapshot.projects[0]);
      setPendingProjectDeleteId(undefined);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function searchGraph(query: string, nodeType?: string, edgeType?: string, minConfidence?: number): Promise<void> {
    if ((!props.onSearchProjectGraph && !props.onSearchGraph) || scanState === 'scanning') return;
    if (!query.trim() && !nodeType?.trim() && !edgeType?.trim()) {
      // 清空检索条件时直接恢复当前完整视图；置信度仍由画布本地过滤，避免空查询被后端结果上限截断。
      graphSearchRequestVersionRef.current += 1;
      setGraphSearchResult(undefined);
      return;
    }
    const requestVersion = ++graphSearchRequestVersionRef.current;
    const projectId = activeProjectId;
    const requestedViewType = activeGraphViewTypeRef.current;
    try {
      let result: GraphSearchResult | undefined;
      if (props.onSearchProjectGraph && activeProjectId) {
        // 项目抽屉内的搜索必须绑定当前选中项目，避免误读全局当前仓库图谱。
        result = await props.onSearchProjectGraph(activeProjectId, query, nodeType, edgeType, minConfidence);
      } else if (props.onSearchGraph) {
        result = await props.onSearchGraph(query, nodeType, edgeType, minConfidence);
      }
      if (requestVersion !== graphSearchRequestVersionRef.current || activeProjectIdRef.current !== projectId || activeGraphViewTypeRef.current !== requestedViewType) return;
      setGraphSearchResult(result);
    } catch (error) {
      if (requestVersion !== graphSearchRequestVersionRef.current) return;
      recordLocalError('graph-search', error);
    }
  }

  async function askGraph(question: string): Promise<void> {
    if (!props.onAskGraph || !activeProjectId || scanState === 'scanning') return;
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) return;
    const requestVersion = ++graphQuestionRequestVersionRef.current;
    const projectId = activeProjectId;
    const requestedViewType = activeGraphViewTypeRef.current;
    try {
      // 图谱问答必须走真实后端 Runtime，不在前端编造 AI 结论。
      const answer = await props.onAskGraph(activeProjectId, normalizedQuestion);
      if (requestVersion !== graphQuestionRequestVersionRef.current || activeProjectIdRef.current !== projectId || activeGraphViewTypeRef.current !== requestedViewType) return;
      setGraphAnswer(answer);
      if (props.onLoadGraphConversations) {
        await loadGraphConversations({
          query: undefined,
          offset: 0,
          archived: false,
        });
      }
    } catch (error) {
      if (requestVersion !== graphQuestionRequestVersionRef.current) return;
      recordLocalError('graph-question', error);
    }
  }

  function upsertGraphConversation(conversation: GraphConversationHistoryItem): void {
    const existed = graphConversations.some((item) => item.id === conversation.id);
    setGraphConversations((current) => {
      return [conversation, ...current.filter((item) => item.id !== conversation.id)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
    if (!existed) setGraphConversationPage((page) => ({ ...page, total: Math.max(page.total + 1, graphConversations.length + 1) }));
    setSelectedGraphConversation(conversation);
  }

  async function loadGraphConversations(input: { query?: string; offset?: number; archived?: boolean } = {}): Promise<void> {
    if (!props.onLoadGraphConversations || !activeProjectId) return;
    const requestVersion = ++graphConversationListRequestVersionRef.current;
    const projectId = activeProjectId;
    try {
      const page = await props.onLoadGraphConversations(projectId, {
        query: input.query,
        limit: graphConversationPage.limit,
        offset: input.offset ?? graphConversationPage.offset,
        archived: input.archived ?? graphConversationPage.archived,
      });
      if (requestVersion !== graphConversationListRequestVersionRef.current || activeProjectIdRef.current !== projectId) return;
      setGraphConversations(page.items);
      setGraphConversationPage({
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        query: page.query,
        archived: page.archived,
      });
      setSelectedGraphConversation(page.items[0]);
    } catch (error) {
      if (requestVersion !== graphConversationListRequestVersionRef.current || activeProjectIdRef.current !== projectId) return;
      recordLocalError('graph-conversations', error);
    }
  }

  async function loadGraphConversationDetail(conversationId: string): Promise<void> {
    if (!activeProjectId) return;
    const requestVersion = ++graphConversationDetailRequestVersionRef.current;
    const projectId = activeProjectId;
    if (!props.onLoadGraphConversation) {
      setSelectedGraphConversation(graphConversations.find((conversation) => conversation.id === conversationId));
      return;
    }
    try {
      const conversation = await props.onLoadGraphConversation(projectId, conversationId);
      if (requestVersion !== graphConversationDetailRequestVersionRef.current || activeProjectIdRef.current !== projectId) return;
      upsertGraphConversation(conversation);
    } catch (error) {
      if (requestVersion !== graphConversationDetailRequestVersionRef.current || activeProjectIdRef.current !== projectId) return;
      recordLocalError('graph-conversation-load', error);
    }
  }

  async function archiveGraphConversation(conversationId: string): Promise<void> {
    if (!props.onArchiveGraphConversation || !activeProjectId) return;
    const projectId = activeProjectId;
    try {
      await props.onArchiveGraphConversation(projectId, conversationId);
      if (activeProjectIdRef.current !== projectId) return;
      await loadGraphConversations({
        query: graphConversationPage.query ?? undefined,
        offset: graphConversationPage.offset,
        archived: graphConversationPage.archived,
      });
    } catch (error) {
      recordLocalError('graph-conversation-archive', error);
    }
  }

  async function restoreGraphConversation(conversationId: string): Promise<void> {
    if (!props.onRestoreGraphConversation || !activeProjectId) return;
    const projectId = activeProjectId;
    try {
      await props.onRestoreGraphConversation(projectId, conversationId);
      if (activeProjectIdRef.current !== projectId) return;
      await loadGraphConversations({
        query: graphConversationPage.query ?? undefined,
        offset: graphConversationPage.offset,
        archived: graphConversationPage.archived,
      });
    } catch (error) {
      recordLocalError('graph-conversation-restore', error);
    }
  }

  useEffect(() => {
    if (activeNavTarget !== 'conversations' || activeProjectSection !== 'sessions' || conversationDraftOpen || !activeProjectId || !props.onLoadGraphConversations) return;
    // 进入项目会话页时读取 app-server 会话列表，确保任务创建出的会话和后续消息都来自本地 API。
    void loadGraphConversations({
      query: graphConversationPage.query ?? undefined,
      offset: 0,
      archived: false,
    });
  }, [activeNavTarget, activeProjectSection, activeProjectId, conversationDraftOpen]);

  function resetGraphWorkspace(projectId?: string): void {
    graphViewRequestVersionRef.current += 1;
    graphSearchRequestVersionRef.current += 1;
    graphQuestionRequestVersionRef.current += 1;
    graphScanRequestVersionRef.current += 1;
    graphConversationListRequestVersionRef.current += 1;
    graphConversationDetailRequestVersionRef.current += 1;
    activeGraphViewTypeRef.current = undefined;
    setGraphProjectId(projectId);
    setGraphView(undefined);
    setGraphSearchResult(undefined);
    setGraphAnswer(undefined);
    setGraphConversations([]);
    setSelectedGraphConversation(undefined);
    setGraphConversationPage({ total: 0, limit: graphConversationPage.limit, offset: 0, query: null, archived: false });
    setGraphNodeTaskFeedback('idle');
    setGraphSourceOpenFeedback('idle');
  }

  function acceptLoadedProjectGraphView(projectId: string, loadedGraphView: GraphViewSnapshot, expectedProject: ProjectRecord | undefined, options?: { preserveExisting?: boolean }): boolean {
    if (!isProjectGraphViewForProject(loadedGraphView, expectedProject, { requireProjectIdentity: true })) {
      // 所有项目级图谱入口都必须先校验项目身份；失败时只清空当前代码页并显示可恢复错误，不能把旧 Zeus 图谱挂到新项目。
      if (!options?.preserveExisting) resetGraphWorkspace(projectId);
      recordLocalError('graph-view-project-mismatch', new Error(`Graph view belongs to ${loadedGraphView.projectId ?? loadedGraphView.projectName ?? 'another project'}`));
      setScanState('failed');
      return false;
    }
    setGraphProjectId(projectId);
    setGraphView(loadedGraphView);
    activeGraphViewTypeRef.current = loadedGraphView.viewType as GraphViewType;
    return true;
  }

  async function openProjectGraphView(projectId: string, viewType: GraphViewType = 'architecture'): Promise<GraphViewSnapshot | undefined> {
    if (!props.onLoadProjectGraphView) return undefined;
    const requestVersion = ++graphViewRequestVersionRef.current;
    setScanState('scanning');
    try {
      const loadedGraphView = await props.onLoadProjectGraphView(projectId, viewType);
      if (requestVersion !== graphViewRequestVersionRef.current || activeProjectIdRef.current !== projectId) {
        // 用户已经切换到其他项目时，晚到的旧图谱响应不能覆盖当前代码页，也不能让按钮停在扫描中。
        return loadedGraphView;
      }
      if (loadedGraphView.viewType !== viewType) {
        recordLocalError('graph-view-open', new Error(`Requested ${viewType}, received ${loadedGraphView.viewType}`));
        setScanState('failed');
        return undefined;
      }
      const expectedProject = snapshot.projects.find((project) => project.id === projectId) ?? (selectedProject?.id === projectId ? selectedProject : undefined);
      if (!acceptLoadedProjectGraphView(projectId, loadedGraphView, expectedProject)) return undefined;
      setScanState('idle');
      return loadedGraphView;
    } catch (error) {
      if (requestVersion !== graphViewRequestVersionRef.current || activeProjectIdRef.current !== projectId) return undefined;
      recordLocalError('graph-view-open', error);
      setScanState('failed');
      return undefined;
    }
  }

  async function openGraphView(viewType: GraphViewType = 'architecture'): Promise<void> {
    if (!props.onLoadProjectGraphView && !props.onLoadGraphView) return;
    const requestVersion = ++graphViewRequestVersionRef.current;
    const projectId = activeProjectId;
    graphSearchRequestVersionRef.current += 1;
    graphQuestionRequestVersionRef.current += 1;
    // 视图切换时先清空旧搜索切片，避免上一视图的节点和边被套进新视图标题与布局。
    setGraphSearchResult(undefined);
    setGraphAnswer(undefined);
    setScanState('scanning');
    try {
      if (props.onLoadProjectGraphView && projectId) {
        const loadedGraphView = await props.onLoadProjectGraphView(projectId, viewType);
        if (requestVersion !== graphViewRequestVersionRef.current || activeProjectIdRef.current !== projectId) return;
        if (loadedGraphView.viewType !== viewType) throw new Error(`Requested ${viewType}, received ${loadedGraphView.viewType}`);
        const expectedProject = snapshot.projects.find((project) => project.id === projectId) ?? (selectedProject?.id === projectId ? selectedProject : undefined);
        if (!acceptLoadedProjectGraphView(projectId, loadedGraphView, expectedProject)) return;
      } else if (!projectId && props.onLoadGraphView) {
        const loadedGraphView = await props.onLoadGraphView(viewType);
        if (requestVersion !== graphViewRequestVersionRef.current) return;
        if (loadedGraphView.viewType !== viewType) throw new Error(`Requested ${viewType}, received ${loadedGraphView.viewType}`);
        setGraphView(loadedGraphView);
        activeGraphViewTypeRef.current = loadedGraphView.viewType as GraphViewType;
        setGraphProjectId(projectId);
      }
      setScanState('idle');
    } catch (error) {
      if (requestVersion !== graphViewRequestVersionRef.current || activeProjectIdRef.current !== projectId) return;
      recordLocalError('graph-view-open', error);
      setScanState('failed');
    }
  }

  async function selectProjectCodeWorkspaceMode(mode: ProjectCodeWorkspaceMode): Promise<void> {
    setProjectCodeWorkspaceMode(mode);
    setVisitedCodeWorkspaceModes((current) => new Set(current).add(mode));
    if (typeof window !== 'undefined') window.history.replaceState(null, '', mode === 'commands' ? '#project-commands' : `#project-code-${mode}`);
    if (mode !== 'graph' || !activeProjectId || !selectedProject) return;
    const currentGraphReady = graphProjectId === activeProjectId && activeGraphView && isProjectGraphViewForProject(activeGraphView, selectedProject, { requireProjectIdentity: true });
    if (currentGraphReady) return;
    resetGraphWorkspace(activeProjectId);
    if (selectedProject.scanStatus === 'completed') {
      const loadedGraphView = await openProjectGraphView(activeProjectId, 'architecture');
      if (loadedGraphView) return;
    }
    await scanActiveProjectGraph();
  }

  function codeMapActionLabel(): string {
    if (scanBusy) return codeWorkspaceCopy.scanning;
    if (scanState === 'failed') return codeWorkspaceCopy.retryScan;
    return codeWorkspaceCopy.openGraph;
  }

  async function scanActiveProjectGraph(): Promise<void> {
    if (!props.onScanProjectGraph && !props.onScanCurrentGraph) return;
    let scanRequestVersion = ++graphScanRequestVersionRef.current;
    const projectId = activeProjectId;
    const refreshViewType = activeGraphViewTypeRef.current ?? 'architecture';
    const hasCurrentGraphSnapshot = Boolean(activeGraphView && graphProjectId === projectId);
    setScanState('scanning');
    try {
      if (props.onScanProjectGraph && projectId) {
        if (hasCurrentGraphSnapshot) {
          // 重新扫描期间继续保留上一个可用快照；只有新快照成功加载后才原子替换，失败时用户仍能查看原图。
          graphViewRequestVersionRef.current += 1;
          graphSearchRequestVersionRef.current += 1;
          graphQuestionRequestVersionRef.current += 1;
          setGraphSearchResult(undefined);
          setGraphAnswer(undefined);
        } else {
          resetGraphWorkspace(projectId);
          scanRequestVersion = graphScanRequestVersionRef.current;
        }
        const nextSnapshot = await props.onScanProjectGraph(projectId);
        setSnapshot(nextSnapshot);
        if (scanRequestVersion !== graphScanRequestVersionRef.current || activeProjectIdRef.current !== projectId) return;
        if (props.onLoadProjectGraphView) {
          const viewRequestVersion = ++graphViewRequestVersionRef.current;
          const loadedGraphView = await props.onLoadProjectGraphView(projectId, refreshViewType);
          if (viewRequestVersion !== graphViewRequestVersionRef.current || activeProjectIdRef.current !== projectId) return;
          if (loadedGraphView.viewType !== refreshViewType) throw new Error(`Requested ${refreshViewType}, received ${loadedGraphView.viewType}`);
          const expectedProject = nextSnapshot.projects.find((project) => project.id === projectId) ?? snapshot.projects.find((project) => project.id === projectId) ?? (selectedProject?.id === projectId ? selectedProject : undefined);
          if (!acceptLoadedProjectGraphView(projectId, loadedGraphView, expectedProject, { preserveExisting: hasCurrentGraphSnapshot })) return;
        }
      } else if (!projectId && props.onScanCurrentGraph) {
        if (hasCurrentGraphSnapshot) {
          graphViewRequestVersionRef.current += 1;
          graphSearchRequestVersionRef.current += 1;
          graphQuestionRequestVersionRef.current += 1;
          setGraphSearchResult(undefined);
          setGraphAnswer(undefined);
        } else {
          resetGraphWorkspace(projectId);
          scanRequestVersion = graphScanRequestVersionRef.current;
        }
        setSnapshot(await props.onScanCurrentGraph());
        if (props.onLoadGraphView) {
          const viewRequestVersion = ++graphViewRequestVersionRef.current;
          const loadedGraphView = await props.onLoadGraphView(refreshViewType);
          if (viewRequestVersion !== graphViewRequestVersionRef.current) return;
          if (loadedGraphView.viewType !== refreshViewType) throw new Error(`Requested ${refreshViewType}, received ${loadedGraphView.viewType}`);
          setGraphView(loadedGraphView);
          activeGraphViewTypeRef.current = loadedGraphView.viewType as GraphViewType;
          setGraphProjectId(projectId);
        }
      }
      if (scanRequestVersion !== graphScanRequestVersionRef.current || activeProjectIdRef.current !== projectId) return;
      setScanState('idle');
    } catch (error) {
      if (scanRequestVersion !== graphScanRequestVersionRef.current || activeProjectIdRef.current !== projectId) return;
      recordLocalError('graph-scan', error);
      setScanState('failed');
    }
  }

  function resetProjectCreateDialog(): void {
    setProjectCreateDialogOpen(false);
    setProjectCreateForm({ name: '', localPath: '' });
    setProjectCreateError(undefined);
    window.requestAnimationFrame(() => projectCreateReturnFocusRef.current?.focus());
  }

  function openProjectCreateDialog(): void {
    if (!projectCreationReady) return;
    projectCreateReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setProjectCreateForm({ name: '', localPath: '' });
    setProjectCreateError(undefined);
    if (actionState === 'failed') setActionState('idle');
    setProjectCreateDialogOpen(true);
  }

  function closeProjectCreateDialog(): void {
    if (creatingProjectBusy || projectDirectoryChoosing) return;
    resetProjectCreateDialog();
  }

  async function chooseProjectDirectoryForCreate(): Promise<void> {
    if (!props.onChooseProjectDirectory || creatingProjectBusy || projectDirectoryChoosing) return;
    setProjectDirectoryChoosing(true);
    setProjectCreateError(undefined);
    try {
      const selectedPath = await props.onChooseProjectDirectory();
      if (!selectedPath) return;
      const localPath = normalizeProjectLocalPath(selectedPath);
      setProjectCreateForm((current) => ({
        name: current.name.trim() || defaultProjectNameFromLocalPath(localPath),
        localPath,
      }));
    } catch (error) {
      setProjectCreateError(errorToLocalUiMessage(error));
    } finally {
      setProjectDirectoryChoosing(false);
    }
  }

  async function createCurrentProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!props.onCreateCurrentProject || creatingProjectBusy) return;
    const name = projectCreateForm.name.trim();
    const localPath = normalizeProjectLocalPath(projectCreateForm.localPath);
    if (!name) {
      setProjectCreateError(uiCopy.sidebar.createNameRequired);
      return;
    }
    if (!localPath) {
      setProjectCreateError(uiCopy.sidebar.createFolderRequired);
      return;
    }
    setActionState('creating-project');
    setProjectCreateError(undefined);
    try {
      const nextSnapshot = await props.onCreateCurrentProject({
        name,
        localPath,
        description: uiCopy.sidebar.selectedRepositoryDescription,
        defaultModel: createProjectConfigForm.defaultModel.trim() || appShellSettings.defaultModel || null,
        defaultWorkMode: createProjectConfigForm.defaultWorkMode,
        defaultTaskPrompt: createProjectConfigForm.defaultTaskPrompt.trim(),
      });
      const selectedCreatedProject = nextSnapshot.projects.find((project) => normalizeProjectLocalPath(project.localPath) === localPath);
      setSnapshot(nextSnapshot);
      if (selectedCreatedProject) {
        activeProjectIdRef.current = selectedCreatedProject.id;
        setProjectDetail(selectedCreatedProject);
        setTaskDetail(undefined);
        setTaskDetailPaneTaskId(undefined);
        setConversationDraftOpen(false);
        setProjectEditForm({
          name: selectedCreatedProject.name,
          localPath: selectedCreatedProject.localPath,
          description: selectedCreatedProject.description ?? '',
          note: selectedCreatedProject.note ?? '',
        });
        if (activeProjectSection === 'code') resetGraphWorkspace(selectedCreatedProject.id);
      }
      setActionState('idle');
      resetProjectCreateDialog();
    } catch (error) {
      recordLocalError('renderer-action', error);
      setProjectCreateError(errorToLocalUiMessage(error));
      setActionState('failed');
    }
  }

  async function restoreProject(projectId: string): Promise<void> {
    if (!props.onRestoreProject) return;
    setActionState('creating-project');
    try {
      setSnapshot(await props.onRestoreProject(projectId));
      if (props.onLoadArchivedProjects) {
        setArchivedProjects(await props.onLoadArchivedProjects());
      } else {
        setArchivedProjects((items) => items.filter((item) => item.id !== projectId));
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function refreshArchivedProjects(): Promise<void> {
    if (!props.onLoadArchivedProjects) return;
    setArchivedProjects(await props.onLoadArchivedProjects());
  }

  async function openGraphSourceFromCodeMap(source: { sourceRef: string; lineStart?: number }): Promise<void> {
    const projectRoot = selectedProject?.localPath.replace(/\/+$/u, '');
    const normalizedSource = source.sourceRef.replaceAll('\\', '/');
    const relativePath = projectRoot && normalizedSource.startsWith(`${projectRoot}/`) ? normalizedSource.slice(projectRoot.length + 1) : normalizedSource.startsWith('/') ? null : normalizedSource.replace(/^\.\//u, '');
    if (relativePath) {
      setGraphSourceOpenFeedback('opening');
      try {
        await projectSourceWorkspaceRef.current?.openFile(relativePath, source.lineStart);
        setProjectCodeWorkspaceMode('source');
        setVisitedCodeWorkspaceModes((current) => new Set(current).add('source'));
        setGraphSourceOpenFeedback('opened');
        return;
      } catch (error) {
        recordLocalError('renderer-action', error);
      }
    }
    if (!props.onOpenGraphSource) {
      setGraphSourceOpenFeedback('failed');
      return;
    }
    setGraphSourceOpenFeedback('opening');
    try {
      const result = await props.onOpenGraphSource({ ...source, projectRoot: selectedProject?.localPath });
      if (result.opened) {
        setGraphSourceOpenFeedback('opened');
      } else {
        setGraphSourceOpenFeedback('failed');
      }
    } catch (error) {
      setGraphSourceOpenFeedback('failed');
      recordLocalError('renderer-action', error);
    }
  }

  async function createTaskFromGraphNode(nodeId: string): Promise<void> {
    if (!props.onCreateTaskFromGraphNode || !activeProjectId) return;
    const previousTaskIds = new Set(snapshot.tasks.map((task) => task.id));
    setLastGraphNodeTaskId(nodeId);
    setGraphNodeTaskFeedback('creating');
    setActionState('creating-task');
    try {
      const identityKey = `${activeProjectId}:${nodeId}`;
      const idempotencyKey = graphNodeTaskIdentityRef.current.get(identityKey) ?? createSessionOperationId();
      graphNodeTaskIdentityRef.current.set(identityKey, idempotencyKey);
      const nextSnapshot = await props.onCreateTaskFromGraphNode(nodeId, activeProjectId, idempotencyKey);
      const createdTask = selectCreatedGraphNodeTask(nextSnapshot, previousTaskIds, activeProjectId);
      setSnapshot(nextSnapshot);
      if (createdTask) {
        // 从代码图谱创建任务后立即回到任务主路径；只清搜索和标签，不覆盖用户按项目记住的状态筛选。
        setConversationDraftOpen(false);
        setActiveProjectSection('tasks');
        setTaskSearchQuery('');
        setTaskTagFilter('');
        setTaskDetail(createdTask);
      }
      setGraphNodeTaskFeedback('created');
      graphNodeTaskIdentityRef.current.delete(identityKey);
      setActionState('idle');
    } catch (error) {
      setGraphNodeTaskFeedback('failed');
      recordLocalError('renderer-action', error);
    }
  }

  async function createTaskFromGraphConversation(conversationId: string): Promise<void> {
    if (!props.onCreateTaskFromGraphConversation || !activeProjectId) return;
    setActionState('creating-task');
    try {
      const idempotencyKey = graphConversationTaskIdentityRef.current.get(conversationId) ?? createSessionOperationId();
      graphConversationTaskIdentityRef.current.set(conversationId, idempotencyKey);
      setSnapshot(await props.onCreateTaskFromGraphConversation(activeProjectId, conversationId, idempotencyKey));
      graphConversationTaskIdentityRef.current.delete(conversationId);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function createProjectTaskFromDraft(draft: TaskCreateDraft): Promise<boolean> {
    if (!props.onCreateTaskDraft || !activeProjectId) return false;
    const previousTaskIds = new Set(snapshot.tasks.map((task) => task.id));
    setActionState('creating-task');
    try {
      const signature = JSON.stringify(draft);
      const previousIdentity = taskCreationIdentityRef.current;
      const identity = previousIdentity?.signature === signature ? previousIdentity : { signature, idempotencyKey: createSessionOperationId() };
      taskCreationIdentityRef.current = identity;
      const nextSnapshot = await props.onCreateTaskDraft(activeProjectId, draft, identity.idempotencyKey);
      const createdTask = selectCreatedProjectTask(nextSnapshot, previousTaskIds, activeProjectId);
      setSnapshot(nextSnapshot);
      if (createdTask) {
        // 弹窗提交成功后才落真实任务；只清搜索和标签并打开详情，不覆盖用户按项目记住的状态筛选。
        setConversationDraftOpen(false);
        setTaskSearchQuery('');
        setTaskTagFilter('');
        setTaskDetail(createdTask);
        setActiveProjectSection('tasks');
        setTaskDetailPaneTaskId(createdTask.id);
        if (props.onLoadTaskEvents) {
          setTaskEvents(await props.onLoadTaskEvents(createdTask.id));
        }
      }
      setActionState('idle');
      taskCreationIdentityRef.current = null;
      return true;
    } catch (error) {
      setTaskCreateError(taskWorkspaceCopy.taskCreateSubmitFailed);
      recordLocalError('renderer-action', error);
      setActionState('idle');
      return false;
    }
  }

  function openTaskCreateModal(parentTaskId: string | null = null): void {
    taskCreateReturnFocusRef.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTaskCreateForm({ ...buildTaskCreateInitialForm(appShellSettings.appLanguage), parentTaskId });
    setTaskCreateError('');
    setTaskCreateModalOpen(true);
  }

  function closeTaskCreateModal(): void {
    setTaskCreateModalOpen(false);
    setTaskCreateError('');
    const restoreTaskCreateFocus = () => taskCreateReturnFocusRef.current?.focus();
    if (typeof window !== 'undefined') {
      window.setTimeout(restoreTaskCreateFocus, 0);
    } else {
      restoreTaskCreateFocus();
    }
  }

  function updateTaskCreateForm(field: TaskCreateTextField, value: string): void {
    setTaskCreateForm((current) => ({ ...current, [field]: value }));
    if (field === 'title') setTaskCreateError('');
  }

  function updateTaskCreateType(taskType: TaskType | ''): void {
    // 只切换当前展示的字段组，不清空其他类型的草稿，用户切回时可继续编辑。
    setTaskCreateForm((current) => ({ ...current, taskType }));
    if (taskType) setTaskCreateError('');
  }

  function updateTaskCreatePriority(priority: TaskPriority): void {
    setTaskCreateForm((current) => ({ ...current, priority }));
  }

  function applyZentaoTaskExtract(extract: ZentaoTaskExtract): void {
    if (extract.kind !== 'ok') return;
    // 只回填解析出的非空字段，保留用户已填写的父任务、优先级、标签和附件。
    setTaskCreateForm((current) => ({
      ...current,
      taskType: extract.taskType,
      title: extract.title.trim() ? extract.title : current.title,
      description: extract.description.trim() ? extract.description : current.description,
      defectCurrentState: extract.currentState.trim() ? extract.currentState : current.defectCurrentState,
      defectExpectedOutcome: extract.expectedOutcome.trim() ? extract.expectedOutcome : current.defectExpectedOutcome,
      defectReproductionSteps: extract.reproductionSteps.trim() ? extract.reproductionSteps : current.defectReproductionSteps,
    }));
    setTaskCreateError('');
  }

  async function openZentaoLinkInBrowser(url: string): Promise<boolean> {
    const opened = await openExternalHttpsUrlInMain({
      zeus: typeof window === 'undefined' ? undefined : window.zeus,
      url,
    });
    return opened.opened;
  }

  function mergeTaskCreateAttachments(attachments: TaskCreateAttachment[]): void {
    setTaskCreateForm((current) => {
      const byPath = new Map(current.attachments.map((attachment) => [attachment.path, attachment]));
      for (const attachment of attachments) {
        byPath.set(attachment.path, attachment);
      }
      // 本地附件只保存真实本机路径；用路径去重，避免重复选择或粘贴同一截图/日志文件。
      return { ...current, attachments: Array.from(byPath.values()) };
    });
  }

  function addTaskCreateAttachments(attachments: TaskCreateAttachment[]): void {
    mergeTaskCreateAttachments(attachments);
    if (attachments.length > 0) setTaskCreateError('');
  }

  async function authorizeTaskCreateFiles(files: File[], source: 'paste' | 'drop'): Promise<TaskResourceAuthorizationResult> {
    if (!props.onAuthorizeTaskFiles || files.length === 0) return { resources: [], failedCount: files.length };
    try {
      const result = await props.onAuthorizeTaskFiles(files, source);
      if (result.resources.length > 0 && result.failedCount === 0) setTaskCreateError('');
      else if (result.failedCount > 0) {
        setTaskCreateError(appShellSettings.appLanguage === 'zh-CN' ? `已添加可读取资源，另有 ${result.failedCount} 项读取失败。` : `Readable resources were added; ${result.failedCount} item(s) failed.`);
      }
      return result;
    } catch (error) {
      recordLocalError('renderer-action', error);
      setTaskCreateError(taskWorkspaceCopy.taskCreatePasteAttachmentFailed);
      return { resources: [], failedCount: files.length };
    }
  }

  async function materializeTaskCreateResources(resources: TaskResourcePayload[]): Promise<TaskCreateAttachmentCandidate[]> {
    if (!props.onMaterializeTaskResources || resources.length === 0) return [];
    try {
      const savedAttachments = await props.onMaterializeTaskResources(resources);
      setTaskCreateError('');
      return savedAttachments;
    } catch (error) {
      recordLocalError('renderer-action', error);
      setTaskCreateError(taskWorkspaceCopy.taskCreatePasteAttachmentFailed);
      return [];
    }
  }

  async function readTaskCreateClipboardResources(): Promise<{ resources: TaskCreateAttachmentCandidate[]; text: string }> {
    if (!props.onReadTaskClipboardResources) return { resources: [], text: '' };
    try {
      const result = await props.onReadTaskClipboardResources();
      if (result.resources.length > 0) setTaskCreateError('');
      return result;
    } catch (error) {
      recordLocalError('renderer-action', error);
      setTaskCreateError(taskWorkspaceCopy.taskCreatePasteAttachmentFailed);
      return { resources: [], text: '' };
    }
  }

  function removeTaskCreateAttachment(path: string): void {
    setTaskCreateForm((current) => ({
      ...current,
      attachments: current.attachments.filter((attachment) => attachment.path !== path),
    }));
  }

  async function submitTaskCreateModal(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = normalizeTaskCreateDraft(taskCreateForm, taskWorkspaceCopy.taskCreateTitleRequired, taskWorkspaceCopy.taskCreateTypeRequired);
    if ('error' in normalized) {
      setTaskCreateError(normalized.error);
      if (normalized.error === taskWorkspaceCopy.taskCreateTypeRequired) {
        window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.task-create-type-select > button')?.focus());
      } else {
        taskCreateTitleInputRef.current?.focus();
      }
      return;
    }
    const created = await createProjectTaskFromDraft(normalized.draft);
    if (created) closeTaskCreateModal();
  }

  async function refreshNativeConversationChoices(taskId: string): Promise<NativeConversationChoicesSnapshot | null> {
    const client = props.nativeConversationClient;
    if (!client) return null;
    const requestVersion = nativeConversationChoiceLoadCoordinator.begin(taskId);
    setNativeConversationChoiceTaskStates((current) => ({ ...current, [taskId]: beginNativeConversationChoiceTaskLoad(current[taskId]) }));
    try {
      const choices = await client.loadTaskConversationChoices(taskId);
      const merged = nativeConversationChoiceLoadCoordinator.commit(taskId, requestVersion, choices);
      if (!merged) return choices;
      setNativeConversationChoicesByTask((current) => ({ ...current, [taskId]: merged }));
      setNativeConversationChoiceTaskStates((current) => ({ ...current, [taskId]: completeNativeConversationChoiceTaskLoad(current[taskId]) }));
      return merged;
    } catch (error) {
      if (nativeConversationChoiceLoadCoordinator.isCurrent(taskId, requestVersion)) {
        const message = errorToLocalUiMessage(error);
        setNativeConversationChoiceTaskStates((current) => ({ ...current, [taskId]: failNativeConversationChoiceTaskLoad(current[taskId], message) }));
      }
      throw error;
    }
  }

  async function refreshNativeProjectConversationChoices(projectId: string): Promise<NativeProjectConversationChoicesSnapshot | null> {
    const client = props.nativeConversationClient;
    if (!client) return null;
    const requestVersion = nativeProjectConversationChoiceLoadCoordinator.begin(projectId);
    setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: beginNativeConversationChoiceTaskLoad(current[projectId]) }));
    try {
      const choices = await client.loadProjectConversationChoices(projectId);
      const merged = nativeProjectConversationChoiceLoadCoordinator.commit(projectId, requestVersion, choices);
      if (!merged) return choices;
      setNativeConversationChoicesByProject((current) => ({ ...current, [projectId]: merged }));
      setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: completeNativeConversationChoiceTaskLoad(current[projectId]) }));
      return merged;
    } catch (error) {
      if (nativeProjectConversationChoiceLoadCoordinator.isCurrent(projectId, requestVersion)) {
        setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: failNativeConversationChoiceTaskLoad(current[projectId], errorToLocalUiMessage(error)) }));
      }
      throw error;
    }
  }

  async function refreshArchivedConversations(): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client) return;
    if (archivedConversationRefreshPromiseRef.current) return archivedConversationRefreshPromiseRef.current;
    const refresh = (async () => {
      setArchivedConversationLoadState('loading');
      try {
        const result = await client.loadArchivedConversations();
        setArchivedConversations(result.choices);
        setArchivedConversationLoadState('ready');
      } catch (error) {
        setArchivedConversationLoadState('error');
        recordLocalError('archived-conversation-load', error);
      }
    })();
    archivedConversationRefreshPromiseRef.current = refresh;
    try {
      await refresh;
    } finally {
      if (archivedConversationRefreshPromiseRef.current === refresh) archivedConversationRefreshPromiseRef.current = null;
    }
  }

  async function archiveConversation(conversation: NativeConversationChoice): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client) return;
    try {
      await client.archiveNativeConversation(conversation.projectId, conversation.id);
      if (conversation.taskId) nativeConversationChoiceLoadCoordinator.forget(conversation.taskId, conversation.id);
      else nativeProjectConversationChoiceLoadCoordinator.forget(conversation.projectId, conversation.id);
      if (selectedNativeConversationIdRef.current === (conversation.navigationId ?? conversation.id)) {
        selectedNativeConversationIdRef.current = null;
        setSelectedNativeConversationId(null);
        setFocusedArchivedConversation(null);
        setConversationDraftOpen(false);
      }
      setNativeConversationRuntimeStates((current) => {
        const next = { ...current };
        delete next[conversation.id];
        return next;
      });
      await Promise.all([conversation.taskId ? refreshNativeConversationChoices(conversation.taskId) : refreshNativeProjectConversationChoices(conversation.projectId), refreshArchivedConversations()]);
    } catch (error) {
      recordLocalError('conversation-archive', error);
      throw error;
    }
  }

  async function restoreTaskConversation(conversation: NativeConversationChoice): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client || restoringArchivedConversationId) return;
    setRestoringArchivedConversationId(conversation.id);
    try {
      await client.restoreConversationArchive(conversation.projectId, conversation.id);
      await Promise.all([conversation.taskId ? refreshNativeConversationChoices(conversation.taskId) : refreshNativeProjectConversationChoices(conversation.projectId), refreshArchivedConversations()]);
    } catch (error) {
      recordLocalError('conversation-restore', error);
    } finally {
      setRestoringArchivedConversationId(null);
    }
  }

  async function selectNativeConversation(conversation: NativeConversationChoice, navigation: 'page' | 'preserve' = 'page', presentation: 'history' | 'interactive' = 'history'): Promise<void> {
    const targetProject = snapshot.projects.find((candidate) => candidate.id === conversation.projectId);
    if (targetProject) {
      activeProjectIdRef.current = targetProject.id;
      setProjectDetail(targetProject);
    }
    const task = conversation.taskId ? snapshot.tasks.find((candidate) => candidate.id === conversation.taskId) : undefined;
    if (task) setTaskDetail(task);
    else setTaskDetail(undefined);
    const navigationId = conversation.navigationId ?? conversation.id;
    selectedNativeConversationIdRef.current = navigationId;
    setSelectedNativeConversationId(navigationId);
    setSelectedNativeConversationPresentation(presentation);
    setFocusedArchivedConversation(conversation.archived ? conversation : null);
    setConversationDraftOpen(false);
    if (navigation === 'page') {
      setActiveNavTarget('conversations');
      setActiveProjectSection('sessions');
    }
    if (conversation.transportKind === 'codex_native') {
      setNativeLegacyMessageLoadState('empty');
      setNativeLegacyMessageError(null);
      return;
    }
    const sourceConversationId = conversation.legacySourceConversationId ?? conversation.id;
    if (nativeLegacyMessages[sourceConversationId]?.length) {
      setNativeLegacyMessageLoadState('empty');
      setNativeLegacyMessageError(null);
      return;
    }
    if (!props.onLoadGraphConversation) {
      setNativeLegacyMessageLoadState('error');
      setNativeLegacyMessageError('Legacy conversation details are unavailable; no messages can be referenced safely.');
      return;
    }
    setNativeLegacyMessageLoadState('loading');
    setNativeLegacyMessageError(null);
    try {
      const loaded = await loadLegacyConversationDetail(conversation, props.onLoadGraphConversation);
      const detail = loaded.detail;
      setNativeLegacyConversationDetails((current) => ({ ...current, [loaded.sourceConversationId]: detail }));
      if (detail.messages.length === 0) {
        setNativeLegacyMessageLoadState('error');
        setNativeLegacyMessageError('The legacy conversation contains no messages that can be referenced.');
      } else {
        setNativeLegacyMessageLoadState('empty');
      }
    } catch (error) {
      setNativeLegacyMessageLoadState('error');
      setNativeLegacyMessageError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
      recordLocalError('native-legacy-conversation-load', error);
    }
  }

  async function openTaskConversation(taskId: string, conversationId: string): Promise<void> {
    const conversation = nativeConversationChoicesByTask[taskId]?.choices.find((candidate) => candidate.id === conversationId);
    if (!conversation) return;
    const targetProject = snapshot.projects.find((project) => project.id === conversation.projectId);
    if (targetProject) {
      activeProjectIdRef.current = targetProject.id;
      setProjectDetail(targetProject);
    }
    setTaskDetailPaneTaskId(undefined);
    setTaskConversationDrawerTarget(undefined);
    setConversationDrawer(undefined);
    await selectNativeConversation(conversation);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', '#project-sessions');
    }
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function openTaskConflictAiConversation(taskId: string, conversationId: string): Promise<void> {
    let conversation: NativeConversationChoice | undefined;
    for (let attempt = 0; attempt < 3 && !conversation; attempt += 1) {
      try {
        const choices = await refreshNativeConversationChoices(taskId);
        conversation = choices?.choices.find((candidate) => candidate.id === conversationId);
      } catch {
        // 会话已由启动接口持久化；列表短暂失败不能被伪装成 AI 创建失败。
      }
      if (!conversation && attempt < 2) await new Promise<void>((resolve) => window.setTimeout(resolve, 160));
    }
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
    const targetProject = snapshot.projects.find((project) => project.id === (conversation?.projectId ?? task?.projectId));
    if (targetProject) {
      activeProjectIdRef.current = targetProject.id;
      setProjectDetail(targetProject);
    }
    setTaskGitMergeTaskId(null);
    setTaskDetailPaneTaskId(undefined);
    setTaskConversationDrawerTarget(undefined);
    setConversationDrawer(undefined);
    if (conversation) {
      await selectNativeConversation(conversation, 'page', 'interactive');
    } else {
      // 暂时未读到新会话时仍进入正确任务的会话页；后续列表刷新命中后会按 id 自动选中。
      if (task) setTaskDetail(task);
      selectedNativeConversationIdRef.current = conversationId;
      setSelectedNativeConversationId(conversationId);
      setSelectedNativeConversationPresentation('interactive');
      setConversationDraftOpen(false);
      setActiveNavTarget('conversations');
      setActiveProjectSection('sessions');
    }
    if (typeof window !== 'undefined') window.history.replaceState(null, '', '#project-sessions');
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openTaskGitDelivery(taskId: string, workspaceId?: string | null): void {
    if (!window.zeus?.openTaskGitDeliveryWindow) {
      setTaskGitMergeTaskId(taskId);
      return;
    }
    void window.zeus.openTaskGitDeliveryWindow({ taskId, workspaceId }).catch((error: unknown) => {
      recordLocalError('task-git-delivery-window-open', error);
      setTaskGitMergeTaskId(taskId);
    });
  }

  taskGitDeliveryChangedRef.current = (taskId) => {
    void Promise.all([refreshNativeConversationChoices(taskId), props.onLoadTaskEvents && taskDetailPaneTaskId === taskId ? props.onLoadTaskEvents(taskId).then(setTaskEvents) : Promise.resolve()]).catch((error: unknown) =>
      recordLocalError('task-git-delivery-projection-refresh', error),
    );
  };
  taskGitDeliveryConversationRef.current = ({ taskId, conversationId }) => {
    void openTaskConflictAiConversation(taskId, conversationId);
  };
  conversationNotificationRef.current = ({ projectId, conversationId }) => {
    const client = props.nativeConversationClient;
    if (!client) return;
    void client
      .loadNativeConversationChoice(projectId, conversationId)
      .then(async (conversation) => {
        if (conversation.projectId !== projectId || conversation.id !== conversationId) return;
        const project = snapshot.projects.find((candidate) => candidate.id === projectId);
        if (!project) return;
        activeProjectIdRef.current = projectId;
        setProjectDetail(project);
        if (conversation.taskId) {
          setNativeConversationChoicesByTask((current) => ({
            ...current,
            [conversation.taskId!]: upsertTaskConversationChoiceSnapshot(conversation.taskId!, current[conversation.taskId!], conversation),
          }));
        } else {
          setNativeConversationChoicesByProject((current) => ({
            ...current,
            [projectId]: upsertProjectConversationChoiceSnapshot(current[projectId], conversation),
          }));
        }
        await selectNativeConversation(conversation);
      })
      .catch((error: unknown) => recordLocalError('conversation-notification-open', error));
  };

  async function openTaskConversationDrawer(taskId: string, conversationId: string): Promise<void> {
    const conversation = projectedTaskConversationChoices[taskId]?.find((candidate) => candidate.id === conversationId || resolveConversationNavigationId(candidate) === conversationId);
    if (!conversation) {
      setTaskConversationDrawerTarget({ taskId, conversationId, navigationId: conversationId, status: 'error' });
      recordLocalError('task-conversation-drawer-open', new Error(`Task conversation ${conversationId} is no longer available in task ${taskId}.`));
      return;
    }
    const navigationId = resolveConversationNavigationId(conversation);
    setConversationDrawer(undefined);
    setTaskConversationDrawerTarget({ taskId, conversationId: conversation.id, navigationId, status: 'opening' });
    await selectNativeConversation(conversation, 'preserve');
  }

  async function chooseNativeConversationAttachments(): Promise<NativeConversationAttachment[]> {
    return props.onChooseConversationResources?.() ?? [];
  }

  async function startNativeConversation(input: SessionWorkspaceStartInput): Promise<boolean | NativeConversationStartPreparation | NativeConversationStartFailure> {
    const client = props.nativeConversationClient;
    if (!client) {
      const message = 'Codex native app-server client is unavailable.';
      return { state: 'failed', message };
    }
    setNativeConversationChoiceTaskStates((current) => ({ ...current, [input.task.id]: beginNativeConversationChoiceTaskLoad(current[input.task.id]) }));
    if (input.source === 'code_review' && !executionHostSupportsConversationSource(props.executionHostTransition, 'code_review')) {
      try {
        const request = nativeConversationStartEnvelopeManager.prepare(input);
        return {
          state: 'preparing',
          cancel: () => {
            nativeConversationStartEnvelopeManager.discardPending(input.task, request);
            setNativeConversationChoiceTaskStates((current) => ({ ...current, [input.task.id]: completeNativeConversationChoiceTaskLoad(current[input.task.id]) }));
          },
        };
      } catch (error) {
        const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error));
        setNativeConversationChoiceTaskStates((current) => ({ ...current, [input.task.id]: completeNativeConversationChoiceTaskLoad(current[input.task.id]) }));
        return { state: 'failed', message };
      }
    }
    let refreshError: unknown | null = null;
    try {
      const result = await startNativeConversationWithDurableAcceptance({
        input,
        envelopeManager: nativeConversationStartEnvelopeManager,
        dispatch: (taskId, request) => client.startNativeConversation(taskId, request),
        onAccepted: (choice) => {
          // durable acceptance 到达后必须立即离开创建表单；历史摘要刷新只是 best-effort，
          // 不能把已接受操作重新暴露成使用新 ID 的第二次创建。
          nativeConversationChoiceLoadCoordinator.preserveAccepted(choice);
          setNativeConversationChoicesByTask((current) => {
            const prior = current[input.task.id];
            const choices = [choice, ...(prior?.choices ?? []).filter((candidate) => candidate.id !== choice.id)];
            return {
              ...current,
              [input.task.id]: {
                taskId: input.task.id,
                projectId: input.task.projectId,
                hasHistory: true,
                requiresChoice: choices.length > 1,
                choices,
                items: choices,
              },
            };
          });
          setNativeConversationChoiceTaskStates((current) => ({ ...current, [input.task.id]: completeNativeConversationChoiceTaskLoad(current[input.task.id]) }));
          if (activeProjectIdRef.current !== input.task.projectId) return;
          setSelectedNativeConversationId(choice.id);
          setSelectedNativeConversationPresentation('interactive');
          setConversationDraftOpen(false);
          const task = snapshot.tasks.find((candidate) => candidate.id === input.task.id);
          if (task) setTaskDetail(task);
        },
        refresh: refreshNativeConversationChoices,
      });
      refreshError = result.refreshError;
    } catch (error) {
      if (isDefinitiveNativeConversationStartRejection(error)) {
        const rejectedRequest = nativeConversationStartEnvelopeManager.pending(input.task);
        if (rejectedRequest) nativeConversationStartEnvelopeManager.discardPending(input.task, rejectedRequest);
      }
      const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error));
      if (input.source === 'code_review') {
        setNativeConversationChoiceTaskStates((current) => ({ ...current, [input.task.id]: completeNativeConversationChoiceTaskLoad(current[input.task.id]) }));
        return { state: 'failed', message };
      }
      setNativeConversationChoiceTaskStates((current) => ({
        ...current,
        [input.task.id]: completeNativeConversationChoiceTaskLoad(current[input.task.id]),
      }));
      return { state: 'failed', message };
    }
    if (refreshError) {
      setNativeConversationChoiceTaskStates((current) => ({
        ...current,
        [input.task.id]: failNativeConversationChoiceTaskLoad(current[input.task.id], 'Conversation started. History refresh will retry later.'),
      }));
      recordLocalError('native-conversation-choice-refresh', refreshError);
    }
    return true;
  }

  async function startProjectConversation(input: ProjectSessionWorkspaceStartInput): Promise<boolean | NativeConversationStartFailure> {
    const client = props.nativeConversationClient;
    const projectId = input.owner.projectId;
    if (!client) {
      return { state: 'failed', message: 'Project conversation client is unavailable.' };
    }
    setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: beginNativeConversationChoiceTaskLoad(current[projectId]) }));
    let refreshError: unknown | null = null;
    try {
      const result = await startProjectConversationWithDurableAcceptance({
        input,
        envelopeManager: projectConversationStartEnvelopeManager,
        dispatch: (acceptedProjectId, request) => client.startProjectConversation(acceptedProjectId, request),
        onAccepted: (choice) => {
          nativeProjectConversationChoiceLoadCoordinator.preserveAccepted(choice);
          setNativeConversationChoicesByProject((current) => {
            const prior = current[projectId];
            const choices = [choice, ...(prior?.choices ?? []).filter((candidate) => candidate.id !== choice.id)];
            return { ...current, [projectId]: { projectId, choices, items: choices } };
          });
          setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: completeNativeConversationChoiceTaskLoad(current[projectId]) }));
          // A 项目的迟到 acceptance 只能写回 A 的缓存，不能抢走用户已切换到 B 项目的画布。
          if (activeProjectIdRef.current !== projectId) return;
          setTaskDetail(undefined);
          setSelectedNativeConversationId(choice.id);
          setSelectedNativeConversationPresentation('interactive');
          setConversationDraftOpen(false);
        },
        refresh: refreshNativeProjectConversationChoices,
      });
      refreshError = result.refreshError;
    } catch (error) {
      const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error));
      setNativeConversationChoiceProjectStates((current) => ({
        ...current,
        [projectId]: completeNativeConversationChoiceTaskLoad(current[projectId]),
      }));
      return { state: 'failed', message };
    }
    if (refreshError) {
      setNativeConversationChoiceProjectStates((current) => ({
        ...current,
        [projectId]: failNativeConversationChoiceTaskLoad(current[projectId], 'Conversation started. History refresh will retry later.'),
      }));
      recordLocalError('project-conversation-choice-refresh', refreshError);
    }
    return true;
  }

  const prepareNewConversationDraft = useCallback((): void => {
    // 新对话只是本地会话草稿入口，不能复用任务创建接口，否则会误生成 ZEU 编号的正式任务。
    // 离开任务页时不改状态筛选，返回后继续使用当前项目最后一次显式选择。
    setActiveNavTarget('conversations');
    setActiveProjectSection('sessions');
    setConversationDraftOpen(true);
    setSelectedNativeConversationPresentation('interactive');
    setNewConversationFocusRequest((current) => current + 1);
    setSelectedNativeConversationId(null);
    setFocusedArchivedConversation(null);
    setConversationDrawer(undefined);
    setTaskDetailPaneTaskId(undefined);
    setTaskSearchQuery('');
    setTaskTagFilter('');
    setTaskDetail(undefined);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', '#project-sessions');
    }
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const selectNewConversationProject = useCallback(
    (projectId: string): void => {
      const project = snapshot.projects.find((candidate) => candidate.id === projectId);
      if (!project || project.id === activeProjectIdRef.current) return;
      // 新会话项目选择与全局当前项目使用同一事实；只切换执行上下文，不卸载 composer，保留未发送文字和附件。
      activeProjectIdRef.current = project.id;
      setProjectDetail(project);
      setTaskDetail(undefined);
      setTaskDetailPaneTaskId(undefined);
      setSelectedNativeConversationId(null);
      setSelectedNativeConversationPresentation('interactive');
      setFocusedArchivedConversation(null);
      setConversationDrawer(undefined);
      setConversationDraftOpen(true);
      setActiveNavTarget('conversations');
      setActiveProjectSection('sessions');
      if (typeof window !== 'undefined') window.history.replaceState(null, '', '#project-sessions');
    },
    [snapshot.projects],
  );

  const executeNewConversationProjectGit = useCallback(
    async (projectId: string, repositoryId: string, action: ProjectGitAction): Promise<ProjectGitActionResponse> => {
      const client = props.nativeConversationClient;
      if (!client) throw new Error('Project Git actions are unavailable.');
      if (action.type === 'checkout' || action.type === 'create_branch') {
        const unsafeStates = new Set<ConversationTreeRuntimeState>(['connecting', 'reconnecting', 'paused', 'queued', 'streaming', 'pending_approval', 'pending_user_input']);
        let conversations: NativeConversationChoice[];
        try {
          conversations = (await client.loadProjectConversationChoices(projectId)).choices;
        } catch {
          // 分支切换前必须拿到项目会话的当前事实；无法确认时保持原分支，避免与后台写入并发。
          throw new Error('暂时无法确认项目会话状态，请稍后重试分支切换。');
        }
        const activeConversation = conversations.find((conversation) => {
          const runtimeState = nativeConversationRuntimeStates[conversation.id] ?? conversationTreeRuntimeStateFromConversation(conversation);
          return unsafeStates.has(runtimeState);
        });
        if (activeConversation) {
          throw new Error('项目中仍有会话可能写入当前工作目录，请先等待会话结束或停止会话后再切换分支。');
        }
      }
      return client.executeProjectGitAction(projectId, repositoryId, action);
    },
    [nativeConversationRuntimeStates, props.nativeConversationClient],
  );

  useEffect(() => {
    const unsubscribe = window.zeus?.onNativeNewConversation?.(() => prepareNewConversationDraft());
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [prepareNewConversationDraft]);

  function closeTaskGitReview(): void {
    const closedTaskId = taskGitReviewState?.taskId ?? null;
    setTaskGitReviewState(null);
    if (closedTaskId) {
      void refreshNativeConversationChoices(closedTaskId);
      refreshOpenTaskEvents(closedTaskId);
    }
  }

  function requestTaskTerminalCleanupConfirmation(statusLabel: string): Promise<boolean> {
    return new Promise((resolve) => setTaskTerminalCleanupConfirmation({ statusLabel, resolve }));
  }

  function resolveTaskTerminalCleanupConfirmation(confirmed: boolean): void {
    const pending = taskTerminalCleanupConfirmation;
    if (!pending) return;
    setTaskTerminalCleanupConfirmation(null);
    pending.resolve(confirmed);
  }

  async function updateTaskManagementStatus(taskId: string, status: TaskManagementStatus, options: { expectedUpdatedAt?: string; reopenConversationId?: string } = {}): Promise<TaskEditResult | undefined> {
    const currentTask = (taskDetail?.id === taskId ? taskDetail : undefined) ?? snapshot.tasks.find((task) => task.id === taskId);
    if (!props.onUpdateTaskManagementStatus || !currentTask || resolveTaskManagementStatus(currentTask) === status) return;
    const updateManagementStatus = props.onUpdateTaskManagementStatus;
    const projectStatusConfig = resolveTaskManagementStatusConfig(appShellSettings, currentTask.projectId);
    const statusLabel = formatConfiguredTaskManagementStatus(status, projectStatusConfig, appShellSettings.appLanguage);
    const terminalStatus = status === projectStatusConfig.roles.completedStatusId || status === projectStatusConfig.roles.cancelledStatusId;
    const clearOptimisticTerminalStatus = (): void =>
      setOptimisticTerminalTaskStatuses((current) => {
        if (!(taskId in current)) return current;
        const next = { ...current };
        delete next[taskId];
        return next;
      });
    if (terminalStatus) setOptimisticTerminalTaskStatuses((current) => (current[taskId] === status ? current : { ...current, [taskId]: status }));
    return enqueueTaskMutation(taskId, async () => {
      const expectedUpdatedAt = resolveTaskMutationVersion(taskId, options.expectedUpdatedAt ?? currentTask.updatedAt ?? '');
      setActionState('updating-task');
      try {
        let nextSnapshot: DashboardSnapshot;
        try {
          nextSnapshot = await updateManagementStatus(taskId, status, expectedUpdatedAt, undefined, options.reopenConversationId);
        } catch (error) {
          if (!(terminalStatus && error instanceof ZeusApiError && error.error === 'ZEUS_TASK_WORKTREE_CLEANUP_CONFIRMATION_REQUIRED')) throw error;
          const confirmed = await requestTaskTerminalCleanupConfirmation(statusLabel);
          if (!confirmed) {
            clearOptimisticTerminalStatus();
            setActionState('idle');
            return undefined;
          }
          nextSnapshot = await updateManagementStatus(taskId, status, expectedUpdatedAt, true, options.reopenConversationId);
        }
        const updatedTask = applyTaskMutationSnapshot(nextSnapshot, taskId);
        recordTaskMutationVersion(taskId, expectedUpdatedAt, updatedTask.updatedAt);
        refreshOpenTaskEvents(taskId);
        const reopeningTask =
          (resolveTaskManagementStatus(currentTask) === projectStatusConfig.roles.completedStatusId || resolveTaskManagementStatus(currentTask) === projectStatusConfig.roles.cancelledStatusId) &&
          status !== projectStatusConfig.roles.completedStatusId &&
          status !== projectStatusConfig.roles.cancelledStatusId;
        if (reopeningTask) await refreshNativeConversationChoices(taskId);
        clearOptimisticTerminalStatus();
        setActionState('idle');
        return { kind: 'updated', task: updatedTask };
      } catch (error) {
        if (error instanceof ZeusApiError && error.error === 'ZEUS_TASK_EDIT_CONFLICT') {
          const latest = await loadLatestTaskAfterConflict(taskId);
          if (latest) {
            clearOptimisticTerminalStatus();
            setActionState('idle');
            return { kind: 'conflict', latest };
          }
        }
        clearOptimisticTerminalStatus();
        recordLocalError('task-management-status-update', error);
        throw error;
      }
    });
  }

  async function reopenTaskFromConversation(taskId: string, conversationId: string): Promise<void> {
    const task = (taskDetail?.id === taskId ? taskDetail : undefined) ?? snapshot.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    const statusConfig = resolveTaskManagementStatusConfig(appShellSettings, task.projectId);
    setTaskConversationReopenState({ conversationId, status: 'busy' });
    try {
      const result = await updateTaskManagementStatus(taskId, statusConfig.roles.defaultStatusId, {
        expectedUpdatedAt: task.updatedAt,
        reopenConversationId: conversationId,
      });
      if (!result || result.kind === 'conflict') {
        setTaskConversationReopenState({
          conversationId,
          status: 'error',
          error: appShellSettings.appLanguage === 'zh-CN' ? '任务已在其他位置更新，请刷新详情后重试。' : 'The task changed elsewhere. Refresh its details and try again.',
        });
        return;
      }
      setTaskConversationReopenState(undefined);
      setFocusedArchivedConversation(null);
    } catch (error) {
      setTaskConversationReopenState({ conversationId, status: 'error', error: redactLocalUiErrorMessage(errorToLocalUiMessage(error)) });
    }
  }

  async function openTaskModelPush(taskId: string): Promise<void> {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
    const client = props.nativeConversationClient;
    if (!task || taskModelPushPendingByTask[task.id]?.status === 'submitting') return;
    const remembered = readTaskModelPushPreferences(browserNativeConversationStartStorage(), task.projectId);
    setTaskModelPushTaskId(task.id);
    setTaskModelPushCapabilities(null);
    setTaskModelPushRuntimeCapabilities(client ? readCachedCodexConversationCapabilities(client, task.projectId) : null);
    setTaskModelPushConfigImportPreview(null);
    setTaskModelPushConfigImportNeedsActivation(false);
    setTaskModelPushForm({
      model: remembered?.model ?? '',
      effort: remembered?.effort ?? '',
      serviceTier: remembered?.serviceTier ?? { type: 'standard' },
      serviceTierDowngraded: false,
      workMode: remembered?.workMode ?? 'default',
      permissionMode: remembered?.permissionMode ?? 'read-only',
      workspaceMode: remembered?.workspaceMode ?? 'direct',
      taskBranchMode: 'create',
      environmentId: '',
      directConcurrencyConfirmed: false,
      repositorySelections: {},
      currentConversationIds: [],
      parentContextSelections: {},
      relatedContextSelections: {},
      supplementalInfo: '',
      supplementalAttachments: [],
    });
    setTaskModelPushStatus('loading');
    setTaskModelPushRefreshingRepositoryId(null);
    setTaskModelPushError(null);
    taskModelPushEnvelopeRef.current.delete(task.id);
    const requestVersion = taskModelPushCapabilityRequestRef.current + 1;
    taskModelPushCapabilityRequestRef.current = requestVersion;
    if (!client) {
      setTaskModelPushStatus('error');
      setTaskModelPushError(appShellSettings.appLanguage === 'zh-CN' ? 'Codex app-server 客户端不可用。' : 'Codex app-server client is unavailable.');
      return;
    }
    void preloadCodexConversationCapabilities(client, task.projectId)
      .then((capabilities) => {
        if (taskModelPushCapabilityRequestRef.current !== requestVersion || !capabilities) return;
        setTaskModelPushRuntimeCapabilities(capabilities);
      })
      .catch(() => undefined);
    try {
      // 与 Codex App 一致：打开 composer 时只连接并读取能力，不提前创建 thread/turn。
      const capabilities = normalizeTaskModelPushCapabilities(await client.loadCodexTaskPushCapabilities(task.projectId, task.id));
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      setTaskModelPushCapabilities(capabilities);
      setTaskModelPushRuntimeCapabilities(capabilities);
      setTaskModelPushForm((current) => {
        const normalized = resolveTaskModelPushInitialForm(capabilities, {
          model: current.model,
          effort: current.effort,
          serviceTier: current.serviceTier,
          workMode: current.workMode,
          permissionMode: current.permissionMode,
          workspaceMode: current.workspaceMode,
        });
        return {
          ...normalized,
          supplementalInfo: current.supplementalInfo,
          supplementalAttachments: current.supplementalAttachments,
        };
      });
      setTaskModelPushStatus('ready');
    } catch (error) {
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      setTaskModelPushStatus('error');
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    }
  }

  function closeTaskModelPush(): void {
    if (taskModelPushStatus === 'submitting') return;
    taskModelPushLoginRequestRef.current += 1;
    const loginId = taskModelPushLoginIdRef.current;
    taskModelPushLoginIdRef.current = null;
    if (loginId && props.nativeConversationClient) void props.nativeConversationClient.cancelCodexChatGptLogin(loginId).catch((error) => recordLocalError('codex-login-cancel', error));
    taskModelPushCapabilityRequestRef.current += 1;
    if (taskModelPushTaskId) taskModelPushEnvelopeRef.current.delete(taskModelPushTaskId);
    setTaskModelPushTaskId(null);
    setTaskModelPushCapabilities(null);
    setTaskModelPushRuntimeCapabilities(null);
    setTaskModelPushConfigImportPreview(null);
    setTaskModelPushConfigImportNeedsActivation(false);
    setTaskModelPushRefreshingRepositoryId(null);
    setTaskModelPushError(null);
  }

  async function refreshTaskModelPushRepository(repositoryId: string): Promise<void> {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskModelPushTaskId);
    const client = props.nativeConversationClient;
    if (!task || !client || !taskModelPushCapabilities || taskModelPushRefreshingRepositoryId) return;
    const requestVersion = taskModelPushCapabilityRequestRef.current;
    setTaskModelPushRefreshingRepositoryId(repositoryId);
    setTaskModelPushError(null);
    try {
      const repository = await client.refreshTaskPushRepositoryRemote(task.projectId, task.id, repositoryId);
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      setTaskModelPushCapabilities((current) => {
        if (!current || current.taskId !== task.id) return current;
        const primary = current.git.primaryWorkspacePath === repository.localPath;
        return {
          ...current,
          repositories: current.repositories.map((candidate) => (candidate.id === repository.id ? repository : candidate)),
          git: primary
            ? {
                ...current.git,
                primaryBranch: repository.branch,
                primaryHeadSha: repository.headSha,
                primaryClean: repository.clean,
                defaultRemoteName: repository.defaultRemoteName,
                sourceRefs: repository.sourceRefs,
                suggestedBranchName: repository.suggestedBranchName,
              }
            : current.git,
        };
      });
      setTaskModelPushForm((current) => {
        const selection = current.repositorySelections[repository.id];
        if (!selection || repository.sourceRefs.some((source) => source.ref === selection.sourceRef)) return current;
        const fallback = repository.sourceRefs.find((source) => source.current)?.ref ?? repository.sourceRefs[0]?.ref ?? '';
        return {
          ...current,
          repositorySelections: {
            ...current.repositorySelections,
            [repository.id]: { ...selection, sourceRef: fallback, includeLocalChanges: false },
          },
        };
      });
    } catch (error) {
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    } finally {
      if (taskModelPushCapabilityRequestRef.current === requestVersion) setTaskModelPushRefreshingRepositoryId(null);
    }
  }

  function submitTaskModelPush(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const task = snapshot.tasks.find((candidate) => candidate.id === taskModelPushTaskId);
    const client = props.nativeConversationClient;
    const capabilities = taskModelPushCapabilities;
    const form = taskModelPushForm;
    if (
      !task ||
      !client ||
      !capabilities ||
      taskModelPushConfigImportPreview ||
      taskModelPushConfigImportNeedsActivation ||
      taskModelPushStatus === 'inspecting-config' ||
      taskModelPushStatus === 'importing-config' ||
      taskModelPushStatus === 'authenticating' ||
      taskModelPushStatus === 'authenticated' ||
      taskModelPushStatus === 'submitting' ||
      taskModelPushDispatchingTaskIdsRef.current.has(task.id)
    )
      return;
    proceedTaskModelPush(task, client, capabilities, form);
  }

  function proceedTaskModelPush(task: TaskRecord, client: NativeConversationAppClient, capabilities: CodexTaskPushCapabilities, form: TaskModelPushForm): void {
    const selectedModel = resolveTaskModelPushCapability(capabilities, form.model);
    if (selectedModel?.agentKind !== 'pi' && selectedModel?.sourceId === 'codex' && capabilities.codexAccount.requiresOpenaiAuth && !capabilities.codexAccount.signedIn) {
      void prepareCodexAndContinueTaskModelPush(task, client, capabilities, form);
      return;
    }
    continueTaskModelPush(task, capabilities, form);
  }

  async function prepareCodexAndContinueTaskModelPush(task: TaskRecord, client: NativeConversationAppClient, capabilities: CodexTaskPushCapabilities, form: TaskModelPushForm): Promise<void> {
    const storage = browserNativeConversationStartStorage();
    const preference = readCodexConfigImportPromptPreference(storage);
    if (preference === 'answered') {
      await authenticateCodexAndContinueTaskModelPush(task, client, capabilities, form);
      return;
    }
    if (preference === 'activation-required') {
      setTaskModelPushConfigImportNeedsActivation(true);
      await enableImportedCodexConfigAndContinueTaskModelPush(task, client, capabilities, form);
      return;
    }

    const requestVersion = taskModelPushLoginRequestRef.current + 1;
    taskModelPushLoginRequestRef.current = requestVersion;
    setTaskModelPushStatus('inspecting-config');
    setTaskModelPushError(null);
    try {
      const preview = await client.inspectCodexConfigImport();
      if (taskModelPushLoginRequestRef.current !== requestVersion) return;
      if (preview.available && preview.entries.length > 0) {
        setTaskModelPushConfigImportPreview(preview);
        setTaskModelPushStatus('ready');
        return;
      }
    } catch (error) {
      recordLocalError('codex-config-import-preview', error);
      if (taskModelPushLoginRequestRef.current !== requestVersion) return;
    }
    await authenticateCodexAndContinueTaskModelPush(task, client, capabilities, form);
  }

  function skipTaskModelPushCodexConfigImport(): void {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskModelPushTaskId);
    const client = props.nativeConversationClient;
    const capabilities = taskModelPushCapabilities;
    if (!task || !client || !capabilities || taskModelPushStatus !== 'ready') return;
    writeCodexConfigImportPromptPreference(browserNativeConversationStartStorage(), 'answered');
    setTaskModelPushConfigImportPreview(null);
    setTaskModelPushError(null);
    void authenticateCodexAndContinueTaskModelPush(task, client, capabilities, taskModelPushForm);
  }

  function cancelTaskModelPushCodexConfigImport(): void {
    taskModelPushLoginRequestRef.current += 1;
    setTaskModelPushConfigImportPreview(null);
    setTaskModelPushStatus('ready');
    setTaskModelPushError(null);
  }

  async function importTaskModelPushCodexConfig(): Promise<void> {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskModelPushTaskId);
    const client = props.nativeConversationClient;
    const capabilities = taskModelPushCapabilities;
    const form = taskModelPushForm;
    if (!task || !client || !capabilities || taskModelPushStatus === 'importing-config') return;
    if (taskModelPushConfigImportNeedsActivation) {
      await enableImportedCodexConfigAndContinueTaskModelPush(task, client, capabilities, form);
      return;
    }
    if (!taskModelPushConfigImportPreview) return;

    const requestVersion = taskModelPushLoginRequestRef.current + 1;
    taskModelPushLoginRequestRef.current = requestVersion;
    setTaskModelPushStatus('importing-config');
    setTaskModelPushError(null);
    try {
      const result = await client.importCodexConfig();
      if (taskModelPushLoginRequestRef.current !== requestVersion) return;
      if (!result.runtimeReloaded && result.imported.length > 0) {
        writeCodexConfigImportPromptPreference(browserNativeConversationStartStorage(), 'activation-required');
        setTaskModelPushConfigImportNeedsActivation(true);
        setTaskModelPushStatus('ready');
        setTaskModelPushError(result.runtimeError ?? (appShellSettings.appLanguage === 'zh-CN' ? '配置已导入，但新的 Codex 运行服务尚未就绪。' : 'The configuration was imported, but the fresh Codex runtime is not ready.'));
        return;
      }
      writeCodexConfigImportPromptPreference(browserNativeConversationStartStorage(), 'answered');
      setTaskModelPushConfigImportPreview(null);
      setTaskModelPushConfigImportNeedsActivation(false);
      await authenticateCodexAndContinueTaskModelPush(task, client, capabilities, form);
    } catch (error) {
      if (taskModelPushLoginRequestRef.current !== requestVersion) return;
      setTaskModelPushStatus('ready');
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    }
  }

  async function enableImportedCodexConfigAndContinueTaskModelPush(task: TaskRecord, client: NativeConversationAppClient, capabilities: CodexTaskPushCapabilities, form: TaskModelPushForm): Promise<void> {
    const requestVersion = taskModelPushLoginRequestRef.current + 1;
    taskModelPushLoginRequestRef.current = requestVersion;
    setTaskModelPushStatus('importing-config');
    setTaskModelPushError(null);
    try {
      await client.activateCodexConfig();
      if (taskModelPushLoginRequestRef.current !== requestVersion) return;
      writeCodexConfigImportPromptPreference(browserNativeConversationStartStorage(), 'answered');
      setTaskModelPushConfigImportPreview(null);
      setTaskModelPushConfigImportNeedsActivation(false);
      await authenticateCodexAndContinueTaskModelPush(task, client, capabilities, form);
    } catch (error) {
      if (taskModelPushLoginRequestRef.current !== requestVersion) return;
      writeCodexConfigImportPromptPreference(browserNativeConversationStartStorage(), 'activation-required');
      setTaskModelPushConfigImportNeedsActivation(true);
      setTaskModelPushStatus('ready');
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    }
  }

  async function authenticateCodexAndContinueTaskModelPush(task: TaskRecord, client: NativeConversationAppClient, capabilities: CodexTaskPushCapabilities, form: TaskModelPushForm): Promise<void> {
    const requestVersion = taskModelPushLoginRequestRef.current + 1;
    taskModelPushLoginRequestRef.current = requestVersion;
    taskModelPushLoginIdRef.current = null;
    setTaskModelPushStatus('authenticating');
    setTaskModelPushError(null);
    try {
      const login = await client.startCodexChatGptLogin();
      if (taskModelPushLoginRequestRef.current !== requestVersion) {
        await client.cancelCodexChatGptLogin(login.loginId).catch(() => undefined);
        return;
      }
      taskModelPushLoginIdRef.current = login.loginId;
      const opened = await openExternalHttpsUrlInMain({
        zeus: typeof window === 'undefined' ? undefined : window.zeus,
        url: login.authUrl,
      });
      if (!opened.opened) throw new Error('ZEUS_CODEX_LOGIN_BROWSER_OPEN_FAILED');

      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        if (taskModelPushLoginRequestRef.current !== requestVersion) return;
        const account = await client.loadCodexAccount();
        if (taskModelPushLoginRequestRef.current !== requestVersion) return;
        if (account.signedIn || !account.requiresOpenaiAuth) {
          taskModelPushLoginIdRef.current = null;
          const updatedCapabilities = { ...capabilities, codexAccount: account };
          setTaskModelPushCapabilities(updatedCapabilities);
          await completeCodexLoginHandoff({
            isCurrent: () => taskModelPushLoginRequestRef.current === requestVersion,
            showSuccess: () => {
              setTaskModelPushStatus('authenticated');
              setTaskModelPushError(null);
            },
            activateZeus: async () => {
              const result = await activateRequestingZeusWindowInMain({ zeus: typeof window === 'undefined' ? undefined : window.zeus });
              if (!result.activated) throw new Error(result.error ?? 'window_activation_failed');
            },
            recordActivationError: (error) => recordLocalError('codex-login-window-activation', error),
            continueOriginalAction: () => continueTaskModelPush(task, updatedCapabilities, form),
          });
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 800));
      }
      throw new Error('ZEUS_CODEX_LOGIN_TIMED_OUT');
    } catch (error) {
      if (taskModelPushLoginRequestRef.current !== requestVersion) return;
      const loginId = taskModelPushLoginIdRef.current;
      taskModelPushLoginIdRef.current = null;
      if (loginId) await client.cancelCodexChatGptLogin(loginId).catch(() => undefined);
      setTaskModelPushStatus('ready');
      const message =
        error instanceof Error && error.message === 'ZEUS_CODEX_LOGIN_BROWSER_OPEN_FAILED'
          ? appShellSettings.appLanguage === 'zh-CN'
            ? '无法安全打开官方登录页。请检查系统浏览器设置后重试。'
            : 'The official sign-in page could not be opened safely. Check your browser settings and try again.'
          : error instanceof Error && error.message === 'ZEUS_CODEX_LOGIN_TIMED_OUT'
            ? appShellSettings.appLanguage === 'zh-CN'
              ? '登录等待超时，当前配置已保留。请重新点击“登录并继续”。'
              : 'Sign-in timed out. Your configuration was preserved; choose “Sign in and continue” to try again.'
            : redactLocalUiErrorMessage(errorToLocalUiMessage(error));
      setTaskModelPushError(message);
    }
  }

  function cancelTaskModelPushAuthentication(): void {
    const client = props.nativeConversationClient;
    const loginId = taskModelPushLoginIdRef.current;
    taskModelPushLoginRequestRef.current += 1;
    taskModelPushLoginIdRef.current = null;
    setTaskModelPushStatus('ready');
    setTaskModelPushError(null);
    if (client && loginId) void client.cancelCodexChatGptLogin(loginId).catch((error) => recordLocalError('codex-login-cancel', error));
  }

  function continueTaskModelPush(task: TaskRecord, capabilities: CodexTaskPushCapabilities, form: TaskModelPushForm): void {
    if (taskModelPushDispatchingTaskIdsRef.current.has(task.id)) return;
    capabilities = normalizeTaskModelPushCapabilities(capabilities);
    const previousPending = taskModelPushPendingByTaskRef.current[task.id];
    let prepared: { pending: TrackedTaskModelPushState; targetProject: (typeof snapshot.projects)[number] | undefined } | null = null;
    try {
      const selectedModel = resolveTaskModelPushCapability(capabilities, form.model);
      if (!selectedModel) {
        throw new Error(appShellSettings.appLanguage === 'zh-CN' ? '所选模型来源不明确或已经不可用，请重新选择模型后重试。' : 'The selected model source is ambiguous or unavailable. Select the model again and retry.');
      }
      const normalizedForm = selectedModel.id === form.model ? form : { ...form, model: selectedModel.id };
      const supportedEfforts = selectedModel.supportedReasoningEfforts;
      if (supportedEfforts.length > 0 && !supportedEfforts.includes(normalizedForm.effort)) {
        throw new Error(
          appShellSettings.appLanguage === 'zh-CN'
            ? `所选模型不接受推理强度 ${normalizedForm.effort || '空值'}，请重新选择后再推送。`
            : `The selected model does not accept reasoning effort ${normalizedForm.effort || '(empty)'}. Select it again before pushing.`,
        );
      }
      const fingerprint = JSON.stringify({
        taskId: task.id,
        projectId: task.projectId,
        taskContextRevision: capabilities.taskContextRevision,
        repositoryRevision: capabilities.repositoryRevision,
        form: normalizedForm,
      });
      const persistedEnvelope = taskModelPushEnvelopeRef.current.get(task.id);
      const request: StartTaskModelPushRequest =
        persistedEnvelope?.fingerprint === fingerprint
          ? persistedEnvelope.request
          : {
              agentKind: selectedModel.agentKind ?? 'codex',
              mode: 'create',
              source: 'task_push',
              model: selectedModel.id,
              ...(normalizedForm.effort ? { effort: normalizedForm.effort } : {}),
              ...serviceTierWireOverride(normalizedForm.serviceTier),
              workMode: normalizedForm.workMode,
              permissionMode: normalizedForm.permissionMode,
              workspace:
                form.workspaceMode === 'direct'
                  ? { mode: 'direct', confirmConcurrentWrites: form.directConcurrencyConfirmed }
                  : form.taskBranchMode === 'existing'
                    ? { mode: 'existing', environmentId: form.environmentId }
                    : {
                        mode: 'create',
                        repositoryRevision: capabilities.repositoryRevision,
                        repositories: capabilities.repositories.map((repository) => ({
                          repositoryId: repository.id,
                          sourceRef: form.repositorySelections[repository.id]?.sourceRef ?? '',
                          branchName: form.repositorySelections[repository.id]?.branchName ?? '',
                          includeLocalChanges: form.repositorySelections[repository.id]?.includeLocalChanges === true,
                        })),
                      },
              ...(form.supplementalInfo.trim() ? { supplementalInfo: form.supplementalInfo.trim() } : {}),
              ...(form.supplementalAttachments.length > 0 ? { supplementalAttachments: taskPushSupplementalRequestAttachments(form.supplementalAttachments) } : {}),
              taskContext: {
                revision: capabilities.taskContextRevision,
                currentConversationIds: form.currentConversationIds,
                parentSelections: capabilities.parentContextOptions.flatMap((option) => {
                  const selection = form.parentContextSelections[option.taskId];
                  return selection?.selected ? [{ taskId: option.taskId, conversationIds: selection.conversationIds, attachmentKeys: selection.attachmentKeys }] : [];
                }),
                relatedSelections: capabilities.relatedContextOptions.flatMap((option) => {
                  const selection = form.relatedContextSelections[option.taskId];
                  return selection?.selected ? [{ taskId: option.taskId, conversationIds: selection.conversationIds, attachmentKeys: selection.attachmentKeys }] : [];
                }),
              },
              idempotencyKey: createSessionOperationId(),
              clientUserMessageId: createSessionOperationId(),
            };
      const targetProject = snapshot.projects.find((project) => project.id === task.projectId);
      const currentConversationPaths = selectedTaskPushCurrentConversationPaths(capabilities.currentConversationOptions, form.currentConversationIds);
      const parentContexts = selectedTaskPushParentContexts(capabilities.parentContextOptions, form.parentContextSelections);
      const relatedContexts = selectedTaskPushRelatedContexts(capabilities.relatedContextOptions, form.relatedContextSelections);
      const supplementalAttachments = taskPushSupplementalLayoutAttachments(form.supplementalAttachments);
      const layout = buildTaskModelPushLayout(task, form.supplementalInfo, capabilities.currentAttachmentOptions, currentConversationPaths, parentContexts, relatedContexts, supplementalAttachments);
      const pending: TrackedTaskModelPushState = {
        ...createTaskModelPushPendingState({
          task,
          projectName: targetProject?.name ?? task.projectId,
          request,
          form: normalizedForm,
          prompt: renderTaskPushLayoutText(layout),
          layout,
          currentAttachmentOptions: capabilities.currentAttachmentOptions,
          capabilities,
        }),
        origin: taskModelPushNavigationRef.current,
      };

      // 只有首发请求和待处理工作面都准备成功后，才锁定弹窗并进入创建态。
      taskModelPushEnvelopeRef.current.set(task.id, { fingerprint, request });
      taskModelPushDispatchingTaskIdsRef.current.add(task.id);
      setTaskModelPushStatus('submitting');
      setTaskModelPushError(null);
      updateTaskModelPushPendingByTask((current) => ({ ...current, [task.id]: pending }));
      prepared = { pending, targetProject };
    } catch (error) {
      taskModelPushEnvelopeRef.current.delete(task.id);
      taskModelPushDispatchingTaskIdsRef.current.delete(task.id);
      updateTaskModelPushPendingByTask((current) => {
        if (previousPending) return { ...current, [task.id]: previousPending };
        if (!current[task.id]) return current;
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      setTaskModelPushTaskId(task.id);
      setTaskModelPushCapabilities(capabilities);
      setTaskModelPushForm(form);
      setTaskModelPushStatus('error');
      const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error));
      setTaskModelPushError(appShellSettings.appLanguage === 'zh-CN' ? `创建准备失败：${message}` : `Conversation preparation failed: ${message}`);
      return;
    }
    if (!prepared) return;
    const { pending, targetProject } = prepared;
    setTaskModelPushAnnouncement(appShellSettings.appLanguage === 'zh-CN' ? `${task.title}：正在后台创建会话。` : `${task.title}: Creating conversation in the background.`);
    // 用户确认后立即进入稳定工作面；此后的真实身份接管不得再导航、滚动或夺取焦点。
    taskModelPushCapabilityRequestRef.current += 1;
    setTaskModelPushTaskId(null);
    setTaskModelPushCapabilities(null);
    if (targetProject) {
      activeProjectIdRef.current = targetProject.id;
      setProjectDetail(targetProject);
    }
    setTaskDetailPaneTaskId(undefined);
    setConversationDrawer(undefined);
    void selectNativeConversation(pending.choice, 'page', 'interactive');
    if (typeof window !== 'undefined') window.history.replaceState(null, '', '#project-sessions');
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    // 先让 pending 工作面和首条消息完成一次绘制，再启动真实会话创建，避免后台请求阻塞首帧。
    if (typeof window === 'undefined') {
      void dispatchTaskModelPush(pending);
    } else {
      window.requestAnimationFrame(() => {
        window.setTimeout(() => void dispatchTaskModelPush(pending), 0);
      });
    }
  }

  async function dispatchTaskModelPush(pending: TrackedTaskModelPushState): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client) {
      failTaskModelPushDispatch(pending, appShellSettings.appLanguage === 'zh-CN' ? 'Codex app-server 客户端不可用。' : 'Codex app-server client is unavailable.');
      return;
    }
    try {
      const result = await client.startTaskModelPush(pending.task.id, pending.request);
      const { acceptance } = result;
      if (acceptance.operation.status !== 'accepted' || acceptance.operation.idempotencyKey !== result.operationIdentity) {
        throw new Error('Task model push did not return a durable accepted operation.');
      }
      let choice = nativeConversationChoiceFromAcceptance(acceptance, pending.task);
      if (!choice.providerThreadId) {
        const submission = acceptance.submission;
        const submissionError = submission && typeof submission.error === 'object' && submission.error !== null ? (submission.error as Record<string, unknown>) : {};
        const recoverableDirectDirectoryFailure =
          submission?.status === 'paused' && submission.pausedReason === 'recovery_required' && submissionError.code === 'ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE' && submissionError.recoveryRequired === true;
        if (!recoverableDirectDirectoryFailure) {
          const reason = typeof submissionError.message === 'string' && submissionError.message.trim() ? submissionError.message : null;
          throw new Error(
            reason ??
              (appShellSettings.appLanguage === 'zh-CN'
                ? '会话已被服务端接受，但 Provider 尚未建立，当前状态不能安全自动重试。'
                : 'The conversation was accepted, but the provider was not established and the current state cannot be retried safely.'),
          );
        }
        // 原提交在 Provider RPC 前失败；恢复同一会话和提交，避免另建会话或重复首条消息。
        await client.recoverNativeQueue(pending.task.projectId, acceptance.conversation.id);
        choice = await client.loadNativeConversationChoice(pending.task.projectId, acceptance.conversation.id);
        if (!choice.providerThreadId) {
          throw new Error(appShellSettings.appLanguage === 'zh-CN' ? '直接目录已恢复，但 Provider 线程仍未建立。' : 'The direct directory was restored, but the provider thread is still unavailable.');
        }
      }
      taskModelPushEnvelopeRef.current.delete(pending.task.id);
      taskModelPushDispatchingTaskIdsRef.current.delete(pending.task.id);
      nativeConversationChoiceLoadCoordinator.preserveAccepted(choice);
      setNativeConversationChoicesByTask((current) => {
        const prior = current[pending.task.id];
        const choices = [choice, ...(prior?.choices ?? []).filter((candidate) => candidate.id !== choice.id)];
        return {
          ...current,
          [pending.task.id]: {
            taskId: pending.task.id,
            projectId: pending.task.projectId,
            hasHistory: true,
            requiresChoice: choices.length > 1,
            choices,
            items: choices,
          },
        };
      });
      const active = taskModelPushPendingByTaskRef.current[pending.task.id];
      if (!active || active.request.idempotencyKey !== pending.request.idempotencyKey) return;
      const attachedStates = updateTaskModelPushPendingByTask((current) => {
        const currentOperation = current[pending.task.id];
        if (!currentOperation || currentOperation.request.idempotencyKey !== pending.request.idempotencyKey) return current;
        return { ...current, [pending.task.id]: { ...attachTaskModelPushChoice(currentOperation, choice), origin: currentOperation.origin } };
      });
      const attached = attachedStates[pending.task.id];
      if (!attached || !taskModelPushHasRealChoice(attached)) throw new Error('Real task-push conversation was not attached atomically.');
      setTaskModelPushAnnouncement(appShellSettings.appLanguage === 'zh-CN' ? `${pending.task.title}：会话已创建。` : `${pending.task.title}: Conversation created.`);
      const submissionStatus = typeof acceptance.submission?.status === 'string' ? acceptance.submission.status : null;
      if (submissionStatus === 'active') {
        // 只有 thread/start 与首个 turn/start 都成功后，才更新同项目任务开发类型的选择记忆。
        writeTaskModelPushPreferences(browserNativeConversationStartStorage(), pending.task.projectId, pending.form);
      }
      // 真实会话只接管内部读写身份，绝不根据完成时的页面状态再次导航或滚动。
      await flushTaskModelPushDeferredMessages(attached);
      void refreshNativeConversationChoices(pending.task.id).catch((error: unknown) => recordLocalError('task-model-push-history-refresh', error));
      if (props.onLoadTask) {
        void props
          .onLoadTask(pending.task.id)
          .then(mergeTaskRecord)
          .catch((error: unknown) => recordLocalError('task-model-push-task-refresh', error));
      }
    } catch (error) {
      if (error instanceof ZeusApiError && error.error === 'ZEUS_CODEX_LOGIN_REQUIRED') {
        void resumeTaskModelPushAfterCodexLoginRequired(pending, client);
        return;
      }
      if (error instanceof ZeusApiError && (error.error === 'ZEUS_TASK_PUSH_CONTEXT_CHANGED' || error.error === 'ZEUS_TASK_PUSH_PARENT_CONTEXT_CHANGED')) {
        taskModelPushDispatchingTaskIdsRef.current.delete(pending.task.id);
        updateTaskModelPushPendingByTask((current) => {
          const active = current[pending.task.id];
          if (!active || active.request.idempotencyKey !== pending.request.idempotencyKey) return current;
          const message = appShellSettings.appLanguage === 'zh-CN' ? '任务上下文已变化。当前内容已保留，请重新确认有效的上下文后重试。' : 'Task context changed. Your content is preserved; review the valid context before retrying.';
          return {
            ...current,
            [pending.task.id]: {
              ...failTaskModelPushPendingState(active, message),
              contextRefreshRequired: true,
              origin: active.origin,
            },
          };
        });
        return;
      }
      failTaskModelPushDispatch(pending, redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    }
  }

  async function resumeTaskModelPushAfterCodexLoginRequired(pending: TrackedTaskModelPushState, client: NativeConversationAppClient): Promise<void> {
    taskModelPushDispatchingTaskIdsRef.current.delete(pending.task.id);
    updateTaskModelPushPendingByTask((current) => {
      const active = current[pending.task.id];
      if (active?.request.idempotencyKey !== pending.request.idempotencyKey) return current;
      const next = { ...current };
      delete next[pending.task.id];
      return next;
    });

    const originProject = pending.origin.projectId ? snapshot.projects.find((project) => project.id === pending.origin.projectId) : undefined;
    if (originProject) {
      activeProjectIdRef.current = originProject.id;
      setProjectDetail(originProject);
    }
    selectedNativeConversationIdRef.current = pending.origin.selectedConversationId;
    setSelectedNativeConversationId(pending.origin.selectedConversationId);
    setSelectedNativeConversationPresentation(pending.origin.selectedConversationPresentation);
    setActiveNavTarget(pending.origin.activeNavTarget);
    setActiveProjectSection(pending.origin.activeProjectSection);
    setTaskDetailPaneTaskId(pending.origin.taskDetailPaneTaskId);

    setTaskModelPushTaskId(pending.task.id);
    setTaskModelPushCapabilities(null);
    setTaskModelPushConfigImportPreview(null);
    setTaskModelPushConfigImportNeedsActivation(false);
    setTaskModelPushRefreshingRepositoryId(null);
    setTaskModelPushForm(pending.form);
    setTaskModelPushStatus('loading');
    setTaskModelPushError(null);
    setTaskModelPushAnnouncement(appShellSettings.appLanguage === 'zh-CN' ? `${pending.task.title}：Codex 登录已失效，已恢复本次推送。` : `${pending.task.title}: Codex sign-in expired. The push was restored.`);

    const requestVersion = taskModelPushCapabilityRequestRef.current + 1;
    taskModelPushCapabilityRequestRef.current = requestVersion;
    try {
      const capabilities = normalizeTaskModelPushCapabilities(await client.loadCodexTaskPushCapabilities(pending.task.projectId, pending.task.id));
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      setTaskModelPushCapabilities(capabilities);
      setTaskModelPushStatus('ready');
      setTaskModelPushError(null);
      proceedTaskModelPush(pending.task, client, capabilities, pending.form);
    } catch (error) {
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      setTaskModelPushStatus('error');
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    }
  }

  async function flushTaskModelPushDeferredMessages(pending: TrackedTaskModelPushState): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client || !taskModelPushHasRealChoice(pending) || taskModelPushDeferredDispatchingTaskIdsRef.current.has(pending.task.id)) return;
    taskModelPushDeferredDispatchingTaskIdsRef.current.add(pending.task.id);
    try {
      while (true) {
        const current = taskModelPushPendingByTaskRef.current[pending.task.id];
        if (!current || current.request.idempotencyKey !== pending.request.idempotencyKey) return;
        if (!taskModelPushHasRealChoice(current) || current.choice.id !== pending.choice.id) return;
        const message = current.deferredMessages.find((entry) => entry.status === 'queued');
        if (!message) {
          const completed: TrackedTaskModelPushState = { ...acceptTaskModelPushPendingState(current), origin: current.origin };
          updateTaskModelPushPendingByTask((states) => ({ ...states, [pending.task.id]: completed }));
          return;
        }
        updateTaskModelPushPendingByTask((states) => {
          const active = states[pending.task.id];
          if (!active) return states;
          return {
            ...states,
            [pending.task.id]: {
              ...updateTaskModelPushDeferredMessages(active, (messages) => messages.map((entry) => (entry.id === message.id ? { ...entry, status: 'sending', error: null } : entry))),
              origin: active.origin,
            },
          };
        });
        try {
          const acceptance = await client.sendNativeMessage(current.task.projectId, current.choice.id, {
            content: message.content,
            attachments: message.attachments,
            delivery: message.delivery,
            ...(message.settings?.model ? { model: message.settings.model } : {}),
            ...(message.settings?.agentKind ? { agentKind: message.settings.agentKind } : {}),
            ...(message.settings?.effort ? { effort: message.settings.effort } : {}),
            ...(message.settings && Object.prototype.hasOwnProperty.call(message.settings, 'serviceTier') ? { serviceTier: message.settings.serviceTier } : {}),
            ...(message.settings?.permissionMode ? { permissionMode: message.settings.permissionMode } : {}),
            collaborationMode: message.settings?.collaborationMode ?? (current.form.workMode === 'plan' ? 'plan' : 'default'),
            idempotencyKey: message.idempotencyKey,
            clientUserMessageId: message.clientUserMessageId,
          });
          if (acceptance.operation.status !== 'accepted') throw new Error('Deferred task-push message was not durably accepted.');
          updateTaskModelPushPendingByTask((states) => {
            const active = states[pending.task.id];
            if (!active) return states;
            return {
              ...states,
              [pending.task.id]: {
                ...updateTaskModelPushDeferredMessages(active, (messages) => messages.map((entry) => (entry.id === message.id ? { ...entry, status: 'accepted', error: null } : entry))),
                origin: active.origin,
              },
            };
          });
        } catch (error) {
          const messageText = redactLocalUiErrorMessage(errorToLocalUiMessage(error));
          updateTaskModelPushPendingByTask((states) => {
            const active = states[pending.task.id];
            if (!active) return states;
            const failedWithMessage = updateTaskModelPushDeferredMessages(active, (messages) => messages.map((entry) => (entry.id === message.id ? { ...entry, status: 'failed', error: messageText } : entry)));
            return { ...states, [pending.task.id]: { ...failTaskModelPushPendingState(failedWithMessage, messageText), origin: active.origin } };
          });
          return;
        }
      }
    } finally {
      taskModelPushDeferredDispatchingTaskIdsRef.current.delete(pending.task.id);
    }
  }

  async function refreshChangedTaskModelPushParentContext(pending: TrackedTaskModelPushState): Promise<void> {
    const client = props.nativeConversationClient;
    taskModelPushDispatchingTaskIdsRef.current.delete(pending.task.id);
    taskModelPushEnvelopeRef.current.delete(pending.task.id);
    updateTaskModelPushPendingByTask((current) => {
      const active = current[pending.task.id];
      if (active?.request.idempotencyKey !== pending.request.idempotencyKey) return current;
      const next = { ...current };
      delete next[pending.task.id];
      return next;
    });
    setTaskModelPushTaskId(pending.task.id);
    setTaskModelPushCapabilities(null);
    setTaskModelPushForm(pending.form);
    setTaskModelPushStatus('loading');
    setTaskModelPushError(appShellSettings.appLanguage === 'zh-CN' ? '任务上下文已变化，正在刷新选项；当前配置会保留。' : 'Task context changed. Refreshing options while preserving your configuration.');
    if (!client) {
      setTaskModelPushStatus('error');
      return;
    }
    const requestVersion = taskModelPushCapabilityRequestRef.current + 1;
    taskModelPushCapabilityRequestRef.current = requestVersion;
    try {
      const capabilities = normalizeTaskModelPushCapabilities(await client.loadCodexTaskPushCapabilities(pending.task.projectId, pending.task.id));
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      const availableCurrentConversationIds = new Set(capabilities.currentConversationOptions.filter((conversation) => conversation.available).map((conversation) => conversation.id));
      const currentConversationIds = pending.form.currentConversationIds.filter((id) => availableCurrentConversationIds.has(id));
      const parentContextSelections = Object.fromEntries(
        capabilities.parentContextOptions.flatMap((option) => {
          const previous = pending.form.parentContextSelections[option.taskId];
          if (!previous?.selected) return [];
          const conversationIds = new Set(option.conversations.filter((conversation) => conversation.available).map((conversation) => conversation.id));
          const attachmentKeys = new Set(option.attachments.filter((attachment) => attachment.available).map((attachment) => attachment.key));
          return [
            [
              option.taskId,
              {
                selected: true,
                conversationIds: previous.conversationIds.filter((id) => conversationIds.has(id)),
                attachmentKeys: previous.attachmentKeys.filter((key) => attachmentKeys.has(key)),
              },
            ],
          ];
        }),
      );
      const relatedContextSelections = Object.fromEntries(
        capabilities.relatedContextOptions.flatMap((option) => {
          const previous = pending.form.relatedContextSelections[option.taskId];
          if (!previous?.selected) return [];
          const conversationIds = new Set(option.conversations.filter((conversation) => conversation.available).map((conversation) => conversation.id));
          const attachmentKeys = new Set(option.attachments.filter((attachment) => attachment.available).map((attachment) => attachment.key));
          return [
            [
              option.taskId,
              {
                selected: true,
                conversationIds: previous.conversationIds.filter((id) => conversationIds.has(id)),
                attachmentKeys: previous.attachmentKeys.filter((key) => attachmentKeys.has(key)),
              },
            ],
          ];
        }),
      );
      setTaskModelPushCapabilities(capabilities);
      setTaskModelPushForm({ ...pending.form, currentConversationIds, parentContextSelections, relatedContextSelections });
      setTaskModelPushStatus('ready');
      setTaskModelPushError(
        appShellSettings.appLanguage === 'zh-CN'
          ? '任务上下文已刷新；模型、工作区、补充信息、本次附件和仍有效的选择已保留，请重新确认。'
          : 'Task context was refreshed. Model, workspace, supplemental information, attachments for this push, and still-valid selections were preserved. Review and confirm again.',
      );
    } catch (error) {
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      setTaskModelPushStatus('error');
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    }
  }

  function failTaskModelPushDispatch(pending: TrackedTaskModelPushState, message: string): void {
    taskModelPushDispatchingTaskIdsRef.current.delete(pending.task.id);
    updateTaskModelPushPendingByTask((current) => {
      const active = current[pending.task.id];
      if (active?.request.idempotencyKey !== pending.request.idempotencyKey) return current;
      return { ...current, [pending.task.id]: { ...failTaskModelPushPendingState(active, message), origin: active.origin } };
    });
    setTaskModelPushAnnouncement(appShellSettings.appLanguage === 'zh-CN' ? `${pending.task.title}：会话创建失败，可以在当前工作面重试。` : `${pending.task.title}: Conversation creation failed. Retry in the current workspace.`);
    reportApplicationError(message, {
      language: appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en',
      title: appShellSettings.appLanguage === 'zh-CN' ? '会话创建失败' : 'Conversation creation failed',
      source: 'App.taskModelPush',
      primaryAction: {
        label: appShellSettings.appLanguage === 'zh-CN' ? '重试' : 'Retry',
        run: () => retryTaskModelPush(pending.task.id),
      },
    });
  }

  function retryTaskModelPush(taskId: string): void {
    const pending = taskModelPushPendingByTaskRef.current[taskId];
    if (!pending || pending.status !== 'failed') return;
    if (pending.contextRefreshRequired) {
      void refreshChangedTaskModelPushParentContext(pending);
      return;
    }
    const retrying: TrackedTaskModelPushState = {
      ...retryTaskModelPushPendingState({
        ...pending,
        deferredMessages: pending.deferredMessages.map((message) => (message.status === 'failed' ? { ...message, status: 'queued', error: null } : message)),
      }),
      origin: pending.origin,
    };
    updateTaskModelPushPendingByTask((current) => ({ ...current, [taskId]: retrying }));
    if (taskModelPushHasRealChoice(retrying)) {
      void flushTaskModelPushDeferredMessages(retrying);
      return;
    }
    if (taskModelPushDispatchingTaskIdsRef.current.has(taskId)) return;
    taskModelPushDispatchingTaskIdsRef.current.add(taskId);
    setTaskModelPushAnnouncement(appShellSettings.appLanguage === 'zh-CN' ? `${retrying.task.title}：正在重试创建会话。` : `${retrying.task.title}: Retrying conversation creation.`);
    void dispatchTaskModelPush(retrying);
  }

  function mutateTaskModelPushPending(taskId: string, update: (pending: TrackedTaskModelPushState) => TaskModelPushPendingState): void {
    updateTaskModelPushPendingByTask((current) => {
      const pending = current[taskId];
      if (!pending) return current;
      return { ...current, [taskId]: { ...update(pending), origin: pending.origin } };
    });
  }

  function submitTaskModelPushPendingMessage(taskId: string, delivery: 'queue' | 'steer_now', settings?: NativeTurnSettingsSelection): void {
    const pending = taskModelPushPendingByTaskRef.current[taskId];
    if (!pending) return;
    const content = pending.session.draft;
    const attachments = [...pending.session.attachments];
    if (!content.trim() && attachments.length === 0) return;
    mutateTaskModelPushPending(taskId, (current) =>
      enqueueTaskModelPushMessage(current, {
        id: createSessionOperationId(),
        idempotencyKey: createSessionOperationId(),
        clientUserMessageId: createSessionOperationId(),
        content,
        attachments,
        delivery,
        ...(settings ? { settings } : {}),
      }),
    );
    queueMicrotask(() => {
      const current = taskModelPushPendingByTaskRef.current[taskId];
      if (current && taskModelPushHasRealChoice(current)) void flushTaskModelPushDeferredMessages(current);
    });
  }

  function editTaskModelPushPendingMessage(taskId: string, messageId: string, content: string): void {
    mutateTaskModelPushPending(taskId, (pending) => updateTaskModelPushDeferredMessages(pending, (messages) => messages.map((message) => (message.id === messageId ? { ...message, content } : message))));
  }

  function deleteTaskModelPushPendingMessage(taskId: string, messageId: string): void {
    mutateTaskModelPushPending(taskId, (pending) => updateTaskModelPushDeferredMessages(pending, (messages) => messages.filter((message) => message.id !== messageId)));
  }

  function reorderTaskModelPushPendingMessages(taskId: string, orderedIds: string[]): void {
    mutateTaskModelPushPending(taskId, (pending) =>
      updateTaskModelPushDeferredMessages(pending, (messages) => {
        const byId = new Map(messages.map((message) => [message.id, message]));
        return [...orderedIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])), ...messages.filter((message) => !orderedIds.includes(message.id))];
      }),
    );
  }

  function steerTaskModelPushPendingMessage(taskId: string, messageId: string): void {
    mutateTaskModelPushPending(taskId, (pending) =>
      updateTaskModelPushDeferredMessages(pending, (messages) => messages.map((message) => (message.id === messageId ? { ...message, delivery: 'steer_now', status: 'queued', error: null } : message))),
    );
    queueMicrotask(() => {
      const current = taskModelPushPendingByTaskRef.current[taskId];
      if (current && taskModelPushHasRealChoice(current)) void flushTaskModelPushDeferredMessages(current);
    });
  }

  function taskModelPushWorkspaceActions(pending: TrackedTaskModelPushState, onOpenTaskDetail: (taskId: string) => void): SessionWorkspaceActions {
    const updateAttachments = (attachments: NativeConversationAttachment[]): void => {
      mutateTaskModelPushPending(pending.task.id, (current) => updateTaskModelPushAttachments(current, attachments));
    };
    return {
      onDraftChange: (draft) => mutateTaskModelPushPending(pending.task.id, (current) => updateTaskModelPushDraft(current, draft)),
      onSubmit: (delivery, settings) => submitTaskModelPushPendingMessage(pending.task.id, delivery, settings),
      onChooseAttachments: props.onChooseConversationResources
        ? async () => {
            const attachments = await chooseNativeConversationAttachments();
            const current = taskModelPushPendingByTaskRef.current[pending.task.id];
            if (!current) return;
            updateAttachments([...current.session.attachments, ...attachments]);
          }
        : undefined,
      onAddAttachments: (attachments) => {
        const current = taskModelPushPendingByTaskRef.current[pending.task.id];
        if (!current) return;
        updateAttachments([...current.session.attachments, ...attachments]);
      },
      onRemoveAttachment: (attachment) => {
        const current = taskModelPushPendingByTaskRef.current[pending.task.id];
        if (!current) return;
        updateAttachments(current.session.attachments.filter((candidate) => !(candidate.name === attachment.name && candidate.localPath === attachment.localPath && candidate.uploadRef === attachment.uploadRef)));
      },
      onEditQueuedSubmission: (messageId, content) => editTaskModelPushPendingMessage(pending.task.id, messageId, content),
      onDeleteQueuedSubmission: (messageId) => deleteTaskModelPushPendingMessage(pending.task.id, messageId),
      onSendQueuedNow: (messageId) => steerTaskModelPushPendingMessage(pending.task.id, messageId),
      onReorderQueue: (orderedIds) => reorderTaskModelPushPendingMessages(pending.task.id, orderedIds),
      onOpenTaskDetail,
      onOpenTaskGitDelivery: (taskId, workspaceId) => openTaskGitDelivery(taskId, workspaceId),
    };
  }
  return {
    acknowledgeNativeConversationAttention,
    addTaskCreateAttachments,
    applyZentaoTaskExtract,
    archiveConversation,
    archiveGraphConversation,
    askGraph,
    authorizeTaskCreateFiles,
    cancelTaskModelPushAuthentication,
    cancelTaskModelPushCodexConfigImport,
    changedFiles,
    chooseNativeConversationAttachments,
    chooseProjectDirectoryForCreate,
    closeProjectCreateDialog,
    closeTaskCreateModal,
    closeTaskGitReview,
    closeTaskModelPush,
    codeMapActionLabel,
    createCurrentProject,
    createTaskFromGraphConversation,
    createTaskFromGraphNode,
    currentRuntimeAdapterDisplayName,
    deleteProject,
    effectiveTaskStatusSettingsTargetId,
    executeNewConversationProjectGit,
    importTaskModelPushCodexConfig,
    loadGraphConversationDetail,
    loadGraphConversations,
    loadProjectConfig,
    loadProjectWorkspaceConfig,
    materializeTaskCreateResources,
    openGraphSourceFromCodeMap,
    openGraphView,
    openProjectCreateDialog,
    openTaskConflictAiConversation,
    openTaskConversation,
    openTaskConversationDrawer,
    openTaskCreateModal,
    openTaskDetailPane,
    openTaskGitDelivery,
    openTaskModelPush,
    openZentaoLinkInBrowser,
    persistCodeWorkspacePreference,
    persistSidebarConversationPreferences,
    prepareNewConversationDraft,
    readTaskCreateClipboardResources,
    recordLocalError,
    recordTaskMutationVersion,
    refreshArchivedConversations,
    refreshArchivedProjects,
    refreshNativeConversationChoices,
    refreshOpenTaskEvents,
    refreshTaskModelPushRepository,
    removeTaskCreateAttachment,
    renameProjectDisplayName,
    reopenTaskFromConversation,
    requestTaskTerminalCleanupConfirmation,
    resetGraphWorkspace,
    resolveTaskTerminalCleanupConfirmation,
    restoreGraphConversation,
    restoreProject,
    restoreTaskConversation,
    retryTaskModelPush,
    revealProjectInFinder,
    saveProjectConfig,
    saveProjectWorkspaceConfig,
    scanActiveProjectGraph,
    searchGraph,
    selectNativeConversation,
    selectNewConversationProject,
    selectProjectCodeWorkspaceMode,
    skipTaskModelPushCodexConfigImport,
    startNativeConversation,
    startProjectConversation,
    submitTaskCreateModal,
    submitTaskModelPush,
    taskDetailPaneConversationState,
    taskDetailPaneConversations,
    taskDetailPaneModelPushView,
    taskDetailPaneTask,
    taskModelPushWorkspaceActions,
    taskPriorityLabels,
    taskStatusSettingsConfig,
    taskStatusSettingsUsageCounts,
    taskTableEnumSortOrders,
    updateProject,
    updateTaskContent,
    updateTaskCreateForm,
    updateTaskCreatePriority,
    updateTaskCreateType,
    updateTaskManagementStatus,
    updateTaskRelationships,
  };
}

export type WorkspaceDomainActions = ReturnType<typeof useWorkspaceDomainActions>;
