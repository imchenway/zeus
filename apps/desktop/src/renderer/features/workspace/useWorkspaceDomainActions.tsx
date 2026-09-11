import { type FormEvent, useCallback, useEffect } from 'react';
import { describeUserFacingError, isTaskPriority, type ProjectCodeWorkspacePreference, renderTaskPushLayoutText, type ThirdPartyTaskExtract } from '@zeus/shared';
import { type ConversationTreeRuntimeState, conversationTreeRuntimeStateFromConversation } from '../../session/ProjectConversationTree.js';
import {
  loadLegacyConversationDetail,
  nativeConversationChoiceFromAcceptance,
  type NativeConversationStartFailure,
  type NativeConversationStartPreparation,
  type ProjectSessionWorkspaceStartInput,
  type SessionWorkspaceActions,
  type SessionWorkspaceStartInput,
  startNativeConversationWithDurableAcceptance,
  startProjectConversationWithDurableAcceptance,
} from '../../session/SessionWorkspace.js';
import type {
  CodexTaskPushCapabilities,
  CodexTaskPushModelCapability,
  NativeConversationAttachment,
  NativeConversationChoice,
  NativeConversationChoicesSnapshot,
  NativeProjectConversationChoicesSnapshot,
  NativeServiceTierSelection,
  NativeTurnSettingsSelection,
  StartTaskModelPushRequest,
} from '../../session/sessionTypes.js';
import { serviceTierWireOverride } from '../../session/serviceTierSelection.js';
import { toProjectModelServiceTierPreference, upsertProjectModelServiceTierPreference } from '../../session/projectServiceTierPreferences.js';
import { resolveModelCapability } from '../../session/modelSelection.js';
import { type TaskEditResult } from '../../task/TaskDetailPaneContent.js';
import {
  buildTaskModelPushLayout,
  normalizeTaskModelPushCapabilities,
  readTaskModelPushPreferences,
  reconcileTaskPushRepositories,
  resolveTaskModelPushInitialForm,
  resolveTaskModelPushEntry,
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
  identifyTaskModelPushPendingOperation,
  retryTaskModelPushPendingState,
  taskModelPushHasRealChoice,
  type TaskModelPushPendingState,
  updateTaskModelPushAttachments,
  updateTaskModelPushDeferredMessages,
  updateTaskModelPushDraft,
  updateTaskModelPushRetryProgress,
} from '../../task/TaskModelPushPendingWorkspace.js';
import { parseTaskAttachments, type TaskResourceAuthorizationResult, type TaskResourcePayload } from '../../task/taskAttachments.js';
import { normalizeTaskTableEnumSortOrders, resolveTaskManagementStatus } from '../../task/taskWorkspaceModel.js';
import { modelSetupRequestedEvent, reportApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { reportStorageReadOnlyFault } from '../../storageRecoveryError.js';
import { readSkillWorkflowDefault, workflowSkillSelectionRequest } from '../skills/skillWorkflowPreferences.js';
import { createSessionOperationId } from '../../sessionOperationIdentity.js';
import {
  type DashboardSnapshot,
  type ConversationHistoryItem,
  type ProjectGitAction,
  type ProjectGitActionResponse,
  type SaveProjectConfigRequest,
  type TaskBoardOpenMode,
  type TaskManagementStatus,
  type TaskPriority,
  type TaskRecord,
  type TaskStageRecord,
  type TaskType,
  type UpdateTaskRelationshipsRequest,
  type UpdateTaskRequest,
  ZeusApiError,
  type ZeusRealtimeConnectionState,
  type ZeusRealtimeEvent,
} from '../../apiClient.js';
import { errorToLocalUiMessage, normalizeProjectConfig, parseProjectConfigList, redactLocalUiErrorMessage, toProjectConfigForm } from './WorkspaceChrome.js';
import {
  isTaskModelPushOriginCurrent,
  appendRuntimeOutputEventsToConversation,
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
  isRuntimeConversationOutputEvent,
  type NativeConversationAppClient,
  normalizeCodeWorkspaceByProject,
  normalizeProjectLocalPath,
  normalizeRendererAppShellSettings,
  normalizeTaskCreateDraft,
  type ProjectCodeWorkspaceMode,
  resolveConversationNavigationId,
  resolveSelectedNativeConversationForProject,
  resolveNativeConversationSelectionPresentation,
  resolveTaskManagementStatusConfig,
  selectCreatedProjectTask,
  shouldRefreshConversationForRuntimeEvent,
  shouldRefreshNativeConversationListForRealtimeEvent,
  type TaskCreateAttachment,
  type TaskCreateAttachmentCandidate,
  type TaskCreateDraft,
  type TaskCreateTextField,
  toAppShellSettingsSavePayload,
  type TrackedTaskModelPushState,
  type TaskModelPushNavigationTarget,
  upsertProjectConversationChoiceSnapshot,
  upsertTaskConversationChoiceSnapshot,
} from './workspaceSupport.js';
import type { WorkspaceQueryState } from './useWorkspaceQueryState.js';
import { useProjectRepositoryDiscovery } from './useProjectRepositoryDiscovery.js';
import { codexCapabilitiesChangedEvent } from '../codex/codexApiClient.js';

/** 旧偏好只保存裸模型名时，只有项目默认来源能解除同名歧义；其他情况一律要求用户重选。 */
function resolveTaskModelPushCapability(capabilities: CodexTaskPushCapabilities, requestedIdentity: string) {
  const selected = resolveModelCapability(capabilities.models, requestedIdentity);
  if (selected) return selected;
  const preferred = resolveModelCapability(capabilities.models, capabilities.preferredModel);
  return preferred && preferred.model === requestedIdentity.trim() ? preferred : null;
}

export function useWorkspaceDomainActions(state: WorkspaceQueryState) {
  /** 后台发现与当前推送弹窗的仓库更新共用独立生命周期。 */
  const refreshTaskModelPushRepositories = useProjectRepositoryDiscovery(state);
  const {
    actionState,
    activeProjectId,
    activeProjectIdRef,
    activeTaskManagementStatusIds,
    appShellSettings,
    appShellSettingsRef,
    archivedConversationRefreshPromiseRef,
    codeWorkspacePreferenceTimerRef,
    conversationNotificationRef,
    createProjectConfigForm,
    creatingProjectBusy,
    gitDiff,
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
    projectCreateDialogOpen,
    projectCreateReturnFocusRef,
    projectCreationReady,
    projectDetail,
    projectDirectoryChoosing,
    projectEditForm,
    projectSharedWritablePaths,
    projectTaskModelPushManagementStatus,
    projectedTaskConversationChoices,
    props,
    reconcileNativeConversationProjectSnapshot,
    reconcileNativeConversationProjectionStates,
    requestWorkspaceLeaveRef,
    repeatRealtimeNativeConversationRefreshIdsRef,
    restoringArchivedConversationId,
    runtimeAdapters,
    runtimeSettings,
    selectedNativeConversationIdRef,
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
    setSelectedNativeConversationId,
    setSelectedNativeConversationPresentation,
    setSelectedTaskIds,
    setSnapshot,
    setStorageRecoveryFault,
    setSessionDrawerTarget,
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
    setTaskModelPushError,
    setTaskModelPushEntry,
    setTaskModelPushForm,
    setTaskModelPushRefreshingRepositoryId,
    setTaskModelPushRuntimeCapabilities,
    setTaskModelPushServiceTierPreferences,
    setTaskModelPushStatus,
    setTaskModelPushTaskId,
    setTaskSearchQuery,
    setTaskTagFilter,
    setTaskTerminalCleanupConfirmation,
    setVisitedCodeWorkspaceModes,
    settingsWorkspaceCopy,
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
    taskModelPushCapabilities: loadedTaskModelPushCapabilities,
    taskModelPushCapabilityRequestRef,
    taskModelPushDeferredDispatchingTaskIdsRef,
    taskModelPushDispatchingTaskIdsRef,
    taskModelPushEnvelopeRef,
    taskModelPushForm,
    taskModelPushEntryRef,
    taskModelPushNavigationRef,
    taskModelPushPendingByTask,
    taskModelPushPendingByTaskRef,
    taskModelPushRefreshingRepositoryId,
    taskModelPushRuntimeCapabilities,
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
  /** 模型目录晚于本地仓库就绪时，各提交入口使用与界面一致的真实模型来源。 */
  const taskModelPushCapabilities =
    loadedTaskModelPushCapabilities && loadedTaskModelPushCapabilities.models.length === 0 && taskModelPushRuntimeCapabilities?.projectId === loadedTaskModelPushCapabilities.projectId
      ? { ...loadedTaskModelPushCapabilities, models: taskModelPushRuntimeCapabilities.models, preferredModel: taskModelPushRuntimeCapabilities.preferredModel }
      : loadedTaskModelPushCapabilities;
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
              // 源码偏好的较早回执不能覆盖之后选择的侧边栏筛选。
              sidebarConversationFilters: latest.sidebarConversationFilters,
              codeWorkspaceByProject: latest.codeWorkspaceByProject,
              taskTableColumns: latest.taskTableColumns,
              taskTableColumnsByProject: latest.taskTableColumnsByProject,
              taskTableEnumSortOrders: latest.taskTableEnumSortOrders,
              taskStatusFilterByProject: latest.taskStatusFilterByProject,
              taskViewModeByProject: latest.taskViewModeByProject,
              taskExpandedIdsByProject: latest.taskExpandedIdsByProject,
            }));
          })
          .catch((error) => recordLocalError('renderer-action', error));
      }, 400);
    },
    [props.onSaveAppShellSettings],
  );
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
      const appendEvents = (conversation: ConversationHistoryItem): ConversationHistoryItem =>
        conversation.sessionId && sessionIds.has(conversation.sessionId) ? appendRuntimeOutputEventsToConversation(conversation, events, appShellSettings.appLanguage) : conversation;
      setNativeLegacyConversationDetails((current) => Object.fromEntries(Object.entries(current).map(([id, conversation]) => [id, appendEvents(conversation)])));
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
      if (statusSyncAttempt === 0) setNativeConversationStatusSyncState('syncing');
      void reconcileNativeConversationProjectSnapshot(projectId).then(
        () => {
          if (connectionState !== 'connected' || generation !== statusSyncGeneration) return;
          statusSyncAttempt = 0;
          setNativeConversationStatusSyncState('connected');
        },
        (error: unknown) => {
          if (connectionState !== 'connected' || generation !== statusSyncGeneration) return;
          console.warn('暂时无法读取最新会话状态，正在重新连接。', error);
          setNativeConversationStatusSyncState('stale');
          const delay = Math.min(1_000 * 2 ** Math.min(statusSyncAttempt, 3), 8_000);
          statusSyncAttempt += 1;
          statusSyncRetryTimer = window.setTimeout(synchronizeActiveProjectConversationStatus, delay);
        },
      );
    };
    const unsubscribe = subscribeRealtimeEvents(
      (event) => {
        if (event.type === 'codex.models.changed') {
          // 当前连接发布新目录后，所有模型选择器共用一次能力变更通知。
          if (event.payload.succeeded === true) window.dispatchEvent(new Event(codexCapabilitiesChangedEvent));
          return;
        }
        if (event.type === 'codex.rpc.retrying') {
          const operationIdentity = typeof event.payload.operationIdentity === 'string' ? event.payload.operationIdentity : null;
          const method = typeof event.payload.method === 'string' ? event.payload.method : null;
          const retryAttempt = typeof event.payload.retryAttempt === 'number' && Number.isInteger(event.payload.retryAttempt) ? event.payload.retryAttempt : null;
          const maxRetries = typeof event.payload.maxRetries === 'number' && Number.isInteger(event.payload.maxRetries) ? event.payload.maxRetries : null;
          if (operationIdentity && method && retryAttempt !== null && maxRetries !== null && retryAttempt >= 1 && retryAttempt <= maxRetries) {
            updateTaskModelPushPendingByTask((current) => {
              let changed = false;
              const next = Object.fromEntries(
                Object.entries(current).map(([taskId, pending]) => {
                  if (pending.operationIdentity !== operationIdentity || pending.status !== 'submitting') return [taskId, pending];
                  changed = true;
                  return [taskId, { ...updateTaskModelPushRetryProgress(pending, { method, retryAttempt, maxRetries }), origin: pending.origin }];
                }),
              );
              return changed ? next : current;
            });
          }
          return;
        }
        if (event.type === 'storage.write_fault') {
          const fault = reportStorageReadOnlyFault(appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en', event.payload.readsAvailable === true);
          setStorageRecoveryFault((current) => (current?.phase === 'running' ? { ...fault, phase: 'running' } : fault));
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
          removeConfirmedArchivedConversation(conversationId, projectId, taskId);
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
      },
      (state) => {
        connectionState = state;
        statusSyncGeneration += 1;
        clearStatusSyncRetry();
        if (state === 'connected') {
          // 断线期间可能错过目录事件，连接恢复后补读当前快照。
          window.dispatchEvent(new Event(codexCapabilitiesChangedEvent));
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
    updateTaskModelPushPendingByTask,
  ]);

  useEffect(() => {
    /** 后台同步只替换目录，不重建任务表单或覆盖用户选择。 */
    const client = props.nativeConversationClient;
    const projectId = loadedTaskModelPushCapabilities?.projectId ?? taskModelPushRuntimeCapabilities?.projectId;
    if (!taskModelPushTaskId || !projectId || !client?.loadCodexConversationCapabilities) return;
    /** 关闭弹窗、切换任务或新一轮读取后丢弃迟到结果。 */
    let disposed = false;
    let requestSequence = 0;
    const refresh = (): void => {
      const sequence = ++requestSequence;
      const request = taskModelPushCapabilityRequestRef.current;
      void client.loadCodexConversationCapabilities!(projectId)
        .then((capabilities) => {
          if (disposed || sequence !== requestSequence || request !== taskModelPushCapabilityRequestRef.current) return;
          setTaskModelPushRuntimeCapabilities(capabilities);
          setTaskModelPushCapabilities((current) => (current?.taskId === taskModelPushTaskId && current.projectId === projectId ? { ...current, models: capabilities.models, preferredModel: capabilities.preferredModel } : current));
        })
        .catch((error: unknown) => {
          if (!disposed && sequence === requestSequence) recordLocalError('task-model-catalog-refresh', error);
        });
    };
    window.addEventListener(codexCapabilitiesChangedEvent, refresh);
    return () => {
      disposed = true;
      window.removeEventListener(codexCapabilitiesChangedEvent, refresh);
    };
  }, [props.nativeConversationClient, taskModelPushTaskId, loadedTaskModelPushCapabilities?.projectId, taskModelPushRuntimeCapabilities?.projectId]);

  const taskDetailPaneTaskSource = taskDetailPaneTaskId ? (taskDetail?.id === taskDetailPaneTaskId ? taskDetail : snapshot.tasks.find((task) => task.id === taskDetailPaneTaskId)) : undefined;
  const taskDetailPaneTask = taskDetailPaneTaskSource ? projectTaskModelPushManagementStatus(taskDetailPaneTaskSource) : undefined;
  const taskDetailPaneConversations = taskDetailPaneTask ? (nativeConversationChoicesByTask[taskDetailPaneTask.id]?.choices ?? []) : [];
  const taskDetailPaneConversationState = taskDetailPaneTask ? nativeConversationChoiceTaskStates[taskDetailPaneTask.id] : undefined;
  const taskDetailPaneModelPushOperation = taskDetailPaneTask ? taskModelPushPendingByTask[taskDetailPaneTask.id] : undefined;
  const taskDetailPaneModelPushView = taskDetailPaneModelPushOperation
    ? {
        status: taskDetailPaneModelPushOperation.status,
        error: taskDetailPaneModelPushOperation.error,
        errorCause: taskDetailPaneModelPushOperation.errorCause,
        canRetry: taskDetailPaneModelPushOperation.contextRefreshRequired || taskDetailPaneModelPushOperation.canRetry === true,
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
    // 由 localError 的统一出口弹窗，格式化阶段不再重复上报。
    const explanation = describeUserFacingError(error, appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en');
    setLocalError({
      action,
      code: error instanceof ZeusApiError ? (error.error ?? undefined) : undefined,
      message: redactLocalUiErrorMessage(explanation.details || explanation.message),
      occurredAt: new Date().toISOString(),
    });
    setActionState('failed');
  }

  async function runStorageRecoveryPreflightAndRestart(): Promise<void> {
    const restart = window.zeus?.runStorageRecoveryPreflightAndRestart;
    if (!restart) {
      const error = new Error(appShellSettings.appLanguage === 'zh-CN' ? '存储恢复服务尚未就绪。' : 'Storage recovery is not available yet.');
      setStorageRecoveryFault((current) => (current ? { ...current, phase: 'failed' } : current));
      recordLocalError('storage-recovery-preflight-and-restart', error);
      return;
    }
    setStorageRecoveryFault((current) => (current ? { ...current, phase: 'running' } : current));
    try {
      await restart();
    } catch (error) {
      setStorageRecoveryFault((current) => (current ? { ...current, phase: 'failed' } : current));
      recordLocalError('storage-recovery-preflight-and-restart', error);
    }
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
        if (input.projectId && updatedTask.projectId === input.projectId) {
          // 移动成功后打开目标项目，并一次刷新解除关系的其他任务。
          setSnapshot(nextSnapshot);
          setProjectDetail(nextSnapshot.projects.find((project) => project.id === updatedTask.projectId));
          activeProjectIdRef.current = updatedTask.projectId;
        }
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
      setProjectWorkspaceConfigError(redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage)));
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
      setProjectWorkspaceConfigError(redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage)));
    }
  }

  async function saveProjectConfig(projectId: string, event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (!props.onSaveProjectConfig) return;
    const input: SaveProjectConfigRequest = {
      defaultModel: projectConfigForm.defaultModel.trim() || null,
      defaultWorkMode: projectConfigForm.defaultWorkMode,
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

  async function selectProjectCodeWorkspaceMode(mode: ProjectCodeWorkspaceMode): Promise<void> {
    setProjectCodeWorkspaceMode(mode);
    setVisitedCodeWorkspaceModes((current) => new Set(current).add(mode));
    if (typeof window !== 'undefined') window.history.replaceState(null, '', mode === 'commands' ? '#project-commands' : `#project-code-${mode}`);
  }

  function resetProjectCreateDialog(): void {
    setProjectCreateDialogOpen(false);
    setProjectCreateForm({ name: '', localPath: '' });
    setProjectCreateError(undefined);
    window.requestAnimationFrame(() => projectCreateReturnFocusRef.current?.focus());
  }

  /** 常规创建入口先展示表单；引导页选好目录后再进入同一表单。 */
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

  /** 共用目录选择流程：引导页延后显示确认表单，表单内更换目录保留已填写的名称。 */
  async function chooseProjectDirectoryForCreate(): Promise<void> {
    if (!projectCreationReady || !props.onChooseProjectDirectory || creatingProjectBusy || projectDirectoryChoosing) return;
    if (!projectCreateDialogOpen) {
      projectCreateReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setProjectCreateForm({ name: '', localPath: '' });
      if (actionState === 'failed') setActionState('idle');
    }
    setProjectDirectoryChoosing(true);
    setProjectCreateError(undefined);
    try {
      /** 原生面板关闭后才展示确认表单，取消时留在原入口并恢复键盘焦点。 */
      const selectedPath = await props.onChooseProjectDirectory();
      if (!selectedPath) {
        if (!projectCreateDialogOpen) window.requestAnimationFrame(() => projectCreateReturnFocusRef.current?.focus());
        return;
      }
      /** 目录统一规范化后用于默认名称及项目保存。 */
      const localPath = normalizeProjectLocalPath(selectedPath);
      setProjectCreateForm((current) => ({
        name: current.name.trim() || defaultProjectNameFromLocalPath(localPath),
        localPath,
      }));
      setProjectCreateDialogOpen(true);
    } catch (error) {
      setProjectCreateError(errorToLocalUiMessage(error, appShellSettings.appLanguage));
      // 失败时在既有表单显示原因和重选入口，避免引导页隐藏错误。
      setProjectCreateDialogOpen(true);
    } finally {
      setProjectDirectoryChoosing(false);
    }
  }

  /** 项目创建完成后进入项目页面，任务由用户主动新建。 */
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
        defaultModel: appShellSettings.newProjectDefaultModelRef || createProjectConfigForm.defaultModel.trim() || appShellSettings.defaultModel || null,
        defaultWorkMode: createProjectConfigForm.defaultWorkMode,
      });
      const selectedCreatedProject = nextSnapshot.projects.find((project) => normalizeProjectLocalPath(project.localPath) === localPath);
      setSnapshot(nextSnapshot);
      setActionState('idle');
      resetProjectCreateDialog();
      if (selectedCreatedProject) {
        setProjectDetail(selectedCreatedProject);
        activeProjectIdRef.current = selectedCreatedProject.id;
        setConversationDraftOpen(false);
        setActiveNavTarget('projects');
        setActiveProjectSection('tasks');
      }
    } catch (error) {
      setProjectCreateError(errorToLocalUiMessage(error, appShellSettings.appLanguage));
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

  /** 新建与复制共用提交身份，目标项目参与去重以免重试落入错误项目。 */
  async function createProjectTaskFromDraft(draft: TaskCreateDraft, projectId = activeProjectId): Promise<boolean> {
    if (!props.onCreateTaskDraft || !projectId) return false;
    const previousTaskIds = new Set(snapshot.tasks.map((task) => task.id));
    setActionState('creating-task');
    try {
      const signature = JSON.stringify({ projectId, draft });
      const previousIdentity = taskCreationIdentityRef.current;
      const identity = previousIdentity?.signature === signature ? previousIdentity : { signature, idempotencyKey: createSessionOperationId() };
      taskCreationIdentityRef.current = identity;
      const nextSnapshot = await props.onCreateTaskDraft(projectId, draft, identity.idempotencyKey);
      const createdTask = selectCreatedProjectTask(nextSnapshot, previousTaskIds, projectId);
      setSnapshot(nextSnapshot);
      if (createdTask) {
        setProjectDetail(nextSnapshot.projects.find((project) => project.id === projectId));
        activeProjectIdRef.current = projectId;
        // 弹窗提交成功后才落真实任务；只清搜索和标签并打开详情，不覆盖用户按项目记住的状态筛选。
        setConversationDraftOpen(false);
        setTaskSearchQuery('');
        setTaskTagFilter('');
        setTaskDetail(createdTask);
        setActiveProjectSection('tasks');
        setTaskDetailPaneTaskId(createdTask.id);
        if (props.onLoadTaskEvents) {
          // 已创建成功后，事件读取失败不能让用户重复创建任务。
          void props
            .onLoadTaskEvents(createdTask.id)
            .then(setTaskEvents)
            .catch((error: unknown) => recordLocalError('task-event-refresh', error));
        }
      }
      setActionState('idle');
      taskCreationIdentityRef.current = null;
      return true;
    } catch (error) {
      setTaskCreateError(errorToLocalUiMessage(error, appShellSettings.appLanguage));
      recordLocalError('renderer-action', error);
      setActionState('idle');
      return false;
    }
  }

  /** 用户主动新建任务时，将当前项目固定为草稿目标。 */
  function openTaskCreateModal(parentTaskId: string | null = null): void {
    taskCreateReturnFocusRef.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTaskCreateForm({ ...buildTaskCreateInitialForm(appShellSettings.appLanguage), projectId: activeProjectId ?? '', parentTaskId });
    setTaskCreateError('');
    setTaskCreateModalOpen(true);
  }

  /** 复制仅预填可编辑内容，目标选择和保存沿用新建任务流程。 */
  function openTaskCopyModal(task: TaskRecord): void {
    openTaskCreateModal();
    setActiveProjectSection('tasks');
    setTaskCreateForm({
      ...buildTaskCreateInitialForm(appShellSettings.appLanguage),
      projectId: snapshot.projects.find((project) => project.id !== task.projectId)?.id ?? task.projectId,
      copiedFromTaskId: task.id,
      title: task.title,
      taskType: task.taskType,
      description: task.description ?? '',
      defectCurrentState: task.defectCurrentState ?? '',
      defectExpectedOutcome: task.defectExpectedOutcome ?? '',
      defectReproductionSteps: task.defectReproductionSteps ?? '',
      optimizationCurrentState: task.optimizationCurrentState ?? '',
      optimizationExpectedOutcome: task.optimizationExpectedOutcome ?? '',
      priority: isTaskPriority(task.priority) ? task.priority : 'p3',
      tags: (task.tags ?? []).join(', '),
      attachments: parseTaskAttachments(task.sourceContextJson),
    });
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

  /** 将确认可读的第三方字段填入草稿，保留手动填写的其他信息。 */
  function applyThirdPartyTaskExtract(extract: ThirdPartyTaskExtract): void {
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
      attachments: Array.from(new Map([...current.attachments, ...extract.attachments].map((attachment) => [attachment.path, attachment])).values()),
    }));
    setTaskCreateError('');
  }

  /** 登录必须与读取共用 Zeus 会话，系统浏览器的登录不会生效。 */
  async function openThirdPartyLinkInBrowser(url: string): Promise<boolean> {
    return typeof window !== 'undefined' && Boolean(await window.zeus?.openThirdPartyTaskLogin?.(url));
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
    const created = await createProjectTaskFromDraft(normalized.draft, taskCreateForm.projectId);
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
        const message = errorToLocalUiMessage(error, appShellSettings.appLanguage);
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
        setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: failNativeConversationChoiceTaskLoad(current[projectId], errorToLocalUiMessage(error, appShellSettings.appLanguage)) }));
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

  /** HTTP 回执与实时通知共用已确认归档的移除逻辑，不依赖下一次列表读取成功。 */
  function removeConfirmedArchivedConversation(conversationId: string, projectId: string | null, taskId: string | null, navigationId = conversationId): void {
    if (taskId) nativeConversationChoiceLoadCoordinator.forget(taskId, conversationId);
    else if (projectId) nativeProjectConversationChoiceLoadCoordinator.forget(projectId, conversationId);
    setNativeConversationChoicesByProject((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, choices]) => [id, { ...choices, choices: choices.choices.filter((choice) => choice.id !== conversationId), items: choices.items.filter((choice) => choice.id !== conversationId) }]),
      ),
    );
    setNativeConversationChoicesByTask((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, choices]) => {
          // 归档最后一条会话后同步清除历史选择标记。
          const remainingChoices = choices.choices.filter((choice) => choice.id !== conversationId);
          return [id, { ...choices, hasHistory: remainingChoices.length > 0, requiresChoice: remainingChoices.length > 0, choices: remainingChoices, items: remainingChoices }];
        }),
      ),
    );
    if (selectedNativeConversationIdRef.current === navigationId) {
      selectedNativeConversationIdRef.current = null;
      setSelectedNativeConversationId(null);
      setFocusedArchivedConversation(null);
      setConversationDraftOpen(false);
      setActiveProjectSection('tasks');
    }
    setNativeConversationRuntimeStates((current) => {
      // 清除已离开工作区的会话运行状态。
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  }

  /** 归档请求成功前保留原会话；后续目录读取失败由目录自身显示原因。 */
  async function archiveConversation(conversation: NativeConversationChoice): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client) return;
    try {
      await client.archiveNativeConversation(conversation.projectId, conversation.id);
    } catch (error) {
      /** 归档失败始终保留列表项；检查只核对已有状态，不再次归档或发送。 */
      const language = appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en';
      reportApplicationError(error, {
        language,
        title: language === 'zh-CN' ? `归档未完成：${conversation.title}` : `Archive not completed: ${conversation.title}`,
        action:
          describeUserFacingError(error, language).action === 'check'
            ? {
                label: language === 'zh-CN' ? '检查状态' : 'Check status',
                onClick: async () => {
                  if (!(await selectNativeConversation(conversation))) return;
                  await client.recoverNativeQueue(conversation.projectId, conversation.id, 'check');
                },
              }
            : undefined,
      });
      return;
    }
    removeConfirmedArchivedConversation(conversation.id, conversation.projectId, conversation.taskId ?? null, conversation.navigationId ?? conversation.id);
    void (conversation.taskId ? refreshNativeConversationChoices(conversation.taskId) : refreshNativeProjectConversationChoices(conversation.projectId)).catch(() => undefined);
    void refreshArchivedConversations();
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

  const runAfterWorkspaceLeave = useCallback(
    (leave: () => void | Promise<void>): Promise<boolean> =>
      new Promise<boolean>((resolve, reject) => {
        requestWorkspaceLeaveRef.current(
          () => {
            Promise.resolve(leave()).then(
              () => resolve(true),
              (error: unknown) => reject(error),
            );
          },
          () => resolve(false),
        );
      }),
    [requestWorkspaceLeaveRef],
  );

  /** 所有入口先沿用当前投影的导航身份，真实会话身份仍用于读取消息。 */
  async function applyNativeConversationSelection(conversation: NativeConversationChoice, navigation: 'page' | 'preserve', presentation?: 'history' | 'interactive'): Promise<void> {
    const targetProject = snapshot.projects.find((candidate) => candidate.id === conversation.projectId);
    if (targetProject) {
      activeProjectIdRef.current = targetProject.id;
      setProjectDetail(targetProject);
    }
    const task = conversation.taskId ? snapshot.tasks.find((candidate) => candidate.id === conversation.taskId) : undefined;
    if (task) setTaskDetail(task);
    else setTaskDetail(undefined);
    /** 任务详情、通知等入口可能只持有真实身份，不能丢掉推送工作面的稳定身份。 */
    const navigationId = resolveConversationNavigationId(resolveSelectedNativeConversationForProject(state.nativeConversationChoices, conversation.id, conversation.projectId) ?? conversation);
    const resolvedPresentation =
      presentation ?? resolveNativeConversationSelectionPresentation(conversation, nativeConversationRuntimeStates[navigationId] ?? nativeConversationRuntimeStates[conversation.id] ?? conversation.listRuntimeState);
    selectedNativeConversationIdRef.current = navigationId;
    setSelectedNativeConversationId(navigationId);
    setSelectedNativeConversationPresentation(resolvedPresentation);
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
    if (!props.onLoadLegacyConversation) {
      setNativeLegacyMessageLoadState('error');
      setNativeLegacyMessageError('Legacy conversation details are unavailable; no messages can be referenced safely.');
      return;
    }
    setNativeLegacyMessageLoadState('loading');
    setNativeLegacyMessageError(null);
    try {
      const loaded = await loadLegacyConversationDetail(conversation, props.onLoadLegacyConversation);
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
      setNativeLegacyMessageError(redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage)));
      recordLocalError('native-legacy-conversation-load', error);
    }
  }

  async function selectNativeConversation(conversation: NativeConversationChoice, navigation: 'page' | 'preserve' = 'page', presentation?: 'history' | 'interactive'): Promise<boolean> {
    if (navigation === 'preserve') {
      await applyNativeConversationSelection(conversation, navigation, presentation);
      return true;
    }
    return runAfterWorkspaceLeave(() => applyNativeConversationSelection(conversation, navigation, presentation));
  }

  /** 从抽屉或任务入口进入同一会话的完整页面，保留现有的实时呈现方式。 */
  async function openNativeConversationPage(conversation: NativeConversationChoice): Promise<void> {
    /** 已打开的会话不因切换展示容器退回历史模式。 */
    const presentation = state.selectedNativeConversation?.projectId === conversation.projectId && state.selectedNativeConversation.id === conversation.id ? state.selectedNativeConversationPresentation : undefined;
    if (!(await selectNativeConversation(conversation, 'page', presentation))) return;
    setTaskDetailPaneTaskId(undefined);
    setSessionDrawerTarget(undefined);
    setConversationDrawer(undefined);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', '#project-sessions');
    }
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** 任务入口沿用统一的完整会话页跳转。 */
  async function openTaskConversation(taskId: string, conversationId: string): Promise<void> {
    /** 仅打开该任务实际存在的会话。 */
    const conversation = nativeConversationChoicesByTask[taskId]?.choices.find((candidate) => candidate.id === conversationId);
    if (conversation) await openNativeConversationPage(conversation);
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
    const navigated = conversation
      ? await selectNativeConversation(conversation, 'page', 'interactive')
      : await runAfterWorkspaceLeave(() => {
          // 暂时未读到新会话时仍进入正确任务的会话页；后续列表刷新命中后会按 id 自动选中。
          if (targetProject) {
            activeProjectIdRef.current = targetProject.id;
            setProjectDetail(targetProject);
          }
          if (task) setTaskDetail(task);
          selectedNativeConversationIdRef.current = conversationId;
          setSelectedNativeConversationId(conversationId);
          setSelectedNativeConversationPresentation('interactive');
          setConversationDraftOpen(false);
          setActiveNavTarget('conversations');
          setActiveProjectSection('sessions');
        });
    if (!navigated) return;
    setTaskGitMergeTaskId(null);
    setTaskDetailPaneTaskId(undefined);
    setSessionDrawerTarget(undefined);
    setConversationDrawer(undefined);
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
    // 独立交付窗口、服务端通知和返回内嵌交付页共用同一快照失效入口。
    setTaskGitDeliveryRevision((current) => current + 1);
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

  /** 顶部与任务状态入口共用抽屉，打开时保留底层工作区。 */
  async function openNativeConversationDrawer(conversation: NativeConversationChoice): Promise<void> {
    if (conversation.projectId !== activeProjectId) return;
    /** 抽屉按稳定导航身份等待正文，兼容普通会话和归档快照。 */
    const navigationId = resolveConversationNavigationId(resolveSelectedNativeConversationForProject(state.nativeConversationChoices, conversation.id, conversation.projectId) ?? conversation);
    setConversationDrawer(undefined);
    setSessionDrawerTarget({ projectId: conversation.projectId, taskId: conversation.taskId ?? undefined, conversationId: conversation.id, navigationId, status: 'opening' });
    if (state.selectedNativeConversation && resolveConversationNavigationId(state.selectedNativeConversation) === navigationId) return;
    await selectNativeConversation(conversation, 'preserve');
  }

  /** 任务状态先定位所属会话，再交给统一抽屉入口。 */
  async function openTaskConversationDrawer(taskId: string, conversationId: string): Promise<void> {
    /** 列表投影包含归档会话的稳定导航身份。 */
    const conversation = projectedTaskConversationChoices[taskId]?.find((candidate) => candidate.id === conversationId || resolveConversationNavigationId(candidate) === conversationId);
    if (!conversation) {
      /** 缺失会话的错误仍限制在原任务所在项目。 */
      const projectId = snapshot.tasks.find((task) => task.id === taskId)?.projectId ?? activeProjectId;
      if (!projectId) return;
      setSessionDrawerTarget({ projectId, taskId, conversationId, navigationId: conversationId, status: 'error' });
      recordLocalError('task-conversation-drawer-open', new Error(`Task conversation ${conversationId} is no longer available in task ${taskId}.`));
      return;
    }
    await openNativeConversationDrawer(conversation);
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
        const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage));
        setNativeConversationChoiceTaskStates((current) => ({ ...current, [input.task.id]: completeNativeConversationChoiceTaskLoad(current[input.task.id]) }));
        return { state: 'failed', message, code: error instanceof ZeusApiError ? (error.error ?? undefined) : undefined };
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
      const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage));
      if (input.source === 'code_review') {
        setNativeConversationChoiceTaskStates((current) => ({ ...current, [input.task.id]: completeNativeConversationChoiceTaskLoad(current[input.task.id]) }));
        return { state: 'failed', message, code: error instanceof ZeusApiError ? (error.error ?? undefined) : undefined };
      }
      setNativeConversationChoiceTaskStates((current) => ({
        ...current,
        [input.task.id]: completeNativeConversationChoiceTaskLoad(current[input.task.id]),
      }));
      return { state: 'failed', message, code: error instanceof ZeusApiError ? (error.error ?? undefined) : undefined };
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
      const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage));
      setNativeConversationChoiceProjectStates((current) => ({
        ...current,
        [projectId]: completeNativeConversationChoiceTaskLoad(current[projectId]),
      }));
      return { state: 'failed', message, code: error instanceof ZeusApiError ? (error.error ?? undefined) : undefined };
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
    void runAfterWorkspaceLeave(() => {
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
    });
  }, [runAfterWorkspaceLeave]);

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
      setTaskGitDeliveryRevision((current) => current + 1);
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
      setTaskConversationReopenState({ conversationId, status: 'error', error: redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage)) });
    }
  }

  /** 入口先检查接入；只有用户再次确认才会创建会话或执行任务。 */
  async function openTaskModelPush(taskId: string, stage?: TaskStageRecord): Promise<void> {
    /** 当前任务及客户端属于同一次入口操作。 */
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
    const client = props.nativeConversationClient;
    if (!task || taskModelPushPendingByTaskRef.current[task.id]?.status === 'submitting') return;
    if (taskModelPushEntryRef.current?.taskId === taskId && taskModelPushEntryRef.current.pending && isTaskModelPushOriginCurrent(taskModelPushEntryRef.current.origin, taskModelPushNavigationRef.current)) return;
    /** 同步登记请求，覆盖同一事件周期内的重复点击。 */
    const entry = { taskId, stage, origin: taskModelPushNavigationRef.current, pending: true };
    taskModelPushEntryRef.current = entry;
    const request = ++taskModelPushCapabilityRequestRef.current;
    setTaskModelPushEntry('checking');
    const remembered = readTaskModelPushPreferences(browserNativeConversationStartStorage(), task.projectId);
    setTaskModelPushTaskId(task.id);
    setTaskModelPushCapabilities(null);
    setTaskModelPushServiceTierPreferences([]);
    setTaskModelPushRuntimeCapabilities(null);
    setTaskModelPushForm({
      ...(stage ? { stageId: stage.id } : {}),
      model: stage?.modelRef ?? remembered?.model ?? '',
      effort: stage?.effort ?? remembered?.effort ?? '',
      serviceTier: stage?.serviceTier ? { type: 'catalog', id: stage.serviceTier } : (remembered?.serviceTier ?? { type: 'standard' }),
      serviceTierDowngraded: false,
      workMode: stage?.workMode ?? remembered?.workMode ?? 'default',
      permissionMode: stage?.permissionMode ?? remembered?.permissionMode ?? 'read-only',
      skillId: readSkillWorkflowDefault('task_push'),
      workspaceMode: remembered?.workspaceMode ?? 'direct',
      workspaceModeSelected: Boolean(remembered?.workspaceMode),
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
    try {
      if (!client?.loadCodexConversationCapabilities) throw new Error(appShellSettings.appLanguage === 'zh-CN' ? '本地服务暂不可用，请重新检查。' : 'The local service is unavailable. Check again.');
      /** 账号与供应商独立于 Git 查询；查询异常不能作为未配置处理。 */
      const [runtime, connections] = await Promise.all([client.loadCodexConversationCapabilities(task.projectId), client.loadModelConnections()]);
      if (!isTaskModelPushRequestCurrent(request, entry.origin)) return;
      setTaskModelPushRuntimeCapabilities(runtime);
      /** 只选择下一工作面，不改写当前任务的模型选择。 */
      const destination = resolveTaskModelPushEntry(runtime, connections.length > 0);
      if (destination === 'confirmation') await loadTaskModelPushConfirmation(task, request, entry.origin);
      else {
        setTaskModelPushEntry(destination);
        setTaskModelPushStatus('ready');
      }
    } catch (error) {
      if (!isTaskModelPushRequestCurrent(request, entry.origin)) return;
      entry.pending = false;
      setTaskModelPushEntry('error');
      setTaskModelPushStatus('error');
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage)));
    }
  }

  /** 请求代次与当前工作面同时匹配时，才允许异步结果改变页面。 */
  function isTaskModelPushRequestCurrent(request: number, origin: TaskModelPushNavigationTarget): boolean {
    return request === taskModelPushCapabilityRequestRef.current && isTaskModelPushOriginCurrent(origin, taskModelPushNavigationRef.current);
  }

  /** 首次检查失败后按原任务阶段重查，不丢失阶段模型或权限。 */
  function retryTaskModelPushEntry(): void {
    /** 重试信息只在当前任务入口期间有效。 */
    const entry = taskModelPushEntryRef.current;
    if (entry && isTaskModelPushOriginCurrent(entry.origin, taskModelPushNavigationRef.current)) void openTaskModelPush(entry.taskId, entry.stage);
  }

  /** 确认资料共用一条加载路径，接入返回时保留原表单与附件。 */
  async function loadTaskModelPushConfirmation(task: TaskRecord, request: number, origin: TaskModelPushNavigationTarget, reference?: string | null): Promise<void> {
    /** 目录与任务配置读取不会准备工作区或创建会话。 */
    const client = props.nativeConversationClient;
    if (!client) throw new Error('ZEUS_MODEL_UNAVAILABLE');
    const [rawCapabilities, loadedProjectConfig] = await Promise.all([client.loadCodexTaskPushCapabilities(task.projectId, task.id), props.onLoadProjectConfig?.(task.projectId) ?? Promise.resolve(undefined)]);
    if (!isTaskModelPushRequestCurrent(request, origin)) return;
    const capabilities = normalizeTaskModelPushCapabilities(rawCapabilities);
    /** Codex 登录优先保留当前 Codex 模型；供应商选择使用用户明确选中的引用。 */
    const previousModel = resolveModelCapability(capabilities.models, taskModelPushForm.model);
    const selected =
      reference === undefined
        ? undefined
        : reference
          ? resolveModelCapability(capabilities.models, reference)
          : previousModel?.sourceId === 'codex' && previousModel.available !== false
            ? previousModel
            : capabilities.models.find((model) => model.sourceId === 'codex' && model.available !== false);
    if (reference !== undefined && (!selected || selected.available === false)) throw new Error('ZEUS_MODEL_UNAVAILABLE');
    const serviceTierPreferences = normalizeProjectConfig(loadedProjectConfig, task.projectId)?.serviceTierPreferences ?? [];
    setTaskModelPushCapabilities(capabilities);
    setTaskModelPushServiceTierPreferences(serviceTierPreferences);
    setTaskModelPushForm((current) => {
      const normalized = resolveTaskModelPushInitialForm(
        capabilities,
        {
          model: current.stageId ? current.model : (selected?.id ?? current.model),
          effort: current.effort,
          serviceTier: current.serviceTier,
          workMode: current.workMode,
          permissionMode: current.permissionMode,
          ...(current.workspaceModeSelected ? { workspaceMode: current.workspaceMode } : {}),
        },
        serviceTierPreferences,
        current.skillId,
      );
      return reconcileTaskPushRepositories(
        {
          ...current,
          model: normalized.model,
          effort: normalized.effort,
          serviceTier: normalized.serviceTier,
          serviceTierDowngraded: normalized.serviceTierDowngraded,
          environmentId: current.environmentId || normalized.environmentId,
          ...(current.stageId ? { stageId: current.stageId } : {}),
          ...(current.stageId
            ? {
                model: current.model,
                effort: current.effort,
                serviceTier: current.serviceTier,
                serviceTierDowngraded: false,
                workMode: current.workMode,
                permissionMode: current.permissionMode,
              }
            : {}),
          supplementalInfo: current.supplementalInfo,
          supplementalAttachments: current.supplementalAttachments,
        },
        capabilities,
      );
    });
    setTaskModelPushStatus('ready');
    setTaskModelPushEntry('confirmation');
  }

  /** 重查只刷新能力；接入完成才预选明确指定的模型，两者都不发送。 */
  async function refreshTaskModelPushModels(reference?: string | null): Promise<void> {
    /** 请求身份覆盖关闭、切换项目和打开另一任务。 */
    const task = snapshot.tasks.find((candidate) => candidate.id === taskModelPushTaskId);
    const client = props.nativeConversationClient;
    if (!task || !client?.loadCodexConversationCapabilities) throw new Error('ZEUS_MODEL_UNAVAILABLE');
    const request = ++taskModelPushCapabilityRequestRef.current;
    const origin = taskModelPushNavigationRef.current;
    setTaskModelPushStatus('loading');
    setTaskModelPushError(null);
    try {
      /** 重新读取账号，不把前一次登录缓存当作本次结果。 */
      const runtime = await client.loadCodexConversationCapabilities(task.projectId);
      if (!isTaskModelPushRequestCurrent(request, origin)) return;
      setTaskModelPushRuntimeCapabilities(runtime);
      await loadTaskModelPushConfirmation(task, request, origin, reference);
    } catch (error) {
      if (!isTaskModelPushRequestCurrent(request, origin)) return;
      setTaskModelPushStatus('error');
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage)));
      throw error;
    }
  }

  async function saveTaskModelPushServiceTierPreference(model: CodexTaskPushModelCapability, selection: NativeServiceTierSelection): Promise<void> {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskModelPushTaskId);
    if (!task || !props.onSaveProjectModelServiceTierPreference) {
      setTaskModelPushError(appShellSettings.appLanguage === 'zh-CN' ? '项目模型速度偏好保存入口不可用。' : 'Project model speed preference saving is unavailable.');
      return;
    }
    const preference = toProjectModelServiceTierPreference(model, selection);
    setTaskModelPushServiceTierPreferences((current) => upsertProjectModelServiceTierPreference(current, preference));
    try {
      const saved = normalizeProjectConfig(await props.onSaveProjectModelServiceTierPreference(task.projectId, preference), task.projectId);
      if (!saved) throw new Error(appShellSettings.appLanguage === 'zh-CN' ? '项目模型速度偏好保存结果无效。' : 'The saved project model speed preference is invalid.');
      setTaskModelPushServiceTierPreferences(saved.serviceTierPreferences);
    } catch (error) {
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage)));
      try {
        const config = normalizeProjectConfig(await props.onLoadProjectConfig?.(task.projectId), task.projectId);
        if (config) setTaskModelPushServiceTierPreferences(config.serviceTierPreferences);
      } catch {
        // 保存失败后的读取只用于回滚乐观状态；原始错误已经展示。
      }
    }
  }

  function closeTaskModelPush(): void {
    if (taskModelPushStatus === 'submitting') return;
    taskModelPushEntryRef.current = null;
    setTaskModelPushEntry('confirmation');
    taskModelPushCapabilityRequestRef.current += 1;
    if (taskModelPushTaskId) taskModelPushEnvelopeRef.current.delete(taskModelPushTaskId);
    setTaskModelPushTaskId(null);
    setTaskModelPushCapabilities(null);
    setTaskModelPushRuntimeCapabilities(null);
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
        return {
          ...current,
          repositorySelectionNeedsReview: true,
          repositorySelections: {
            ...current.repositorySelections,
            [repository.id]: { ...selection, sourceRef: '', includeLocalChanges: false },
          },
        };
      });
    } catch (error) {
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage)));
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
    if (!task || !client || !capabilities || taskModelPushStatus === 'submitting' || taskModelPushDispatchingTaskIdsRef.current.has(task.id)) return;
    if (form.workspaceMode === 'worktree' && form.taskBranchMode === 'create' && (!capabilities.repositoryDiscovery.completedAt || form.repositorySelectionNeedsReview)) return;
    const runtimeAccount = taskModelPushRuntimeCapabilities?.projectId === capabilities.projectId ? taskModelPushRuntimeCapabilities.codexAccount : null;
    proceedTaskModelPush(task, runtimeAccount ? { ...capabilities, codexAccount: runtimeAccount } : capabilities, form);
  }

  function proceedTaskModelPush(task: TaskRecord, capabilities: CodexTaskPushCapabilities, form: TaskModelPushForm): void {
    const selectedModel = resolveTaskModelPushCapability(capabilities, form.model);
    if (selectedModel?.agentKind !== 'pi' && selectedModel?.sourceId === 'codex' && capabilities.codexAccount.requiresOpenaiAuth && !capabilities.codexAccount.signedIn) {
      window.dispatchEvent(new CustomEvent(modelSetupRequestedEvent, { detail: 'codex' }));
      return;
    }
    continueTaskModelPush(task, capabilities, form);
  }

  function continueTaskModelPush(task: TaskRecord, capabilities: CodexTaskPushCapabilities, form: TaskModelPushForm): void {
    if (taskModelPushDispatchingTaskIdsRef.current.has(task.id)) return;
    capabilities = normalizeTaskModelPushCapabilities(capabilities);
    const previousPending = taskModelPushPendingByTaskRef.current[task.id];
    let prepared: { pending: TrackedTaskModelPushState } | null = null;
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
              ...(normalizedForm.stageId ? { stageId: normalizedForm.stageId } : {}),
              model: selectedModel.id,
              ...(normalizedForm.effort ? { effort: normalizedForm.effort } : {}),
              ...serviceTierWireOverride(normalizedForm.serviceTier),
              workMode: normalizedForm.workMode,
              permissionMode: normalizedForm.permissionMode,
              ...workflowSkillSelectionRequest(normalizedForm.skillId),
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
      prepared = { pending };
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
      const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage));
      setTaskModelPushError(message);
      return;
    }
    if (!prepared) return;
    const { pending } = prepared;
    setTaskModelPushAnnouncement(appShellSettings.appLanguage === 'zh-CN' ? `${task.title}：正在后台创建会话。` : `${task.title}: Creating conversation in the background.`);
    // 用户确认后立即进入稳定工作面；此后的真实身份接管不得再导航、滚动或夺取焦点。
    taskModelPushEntryRef.current = null;
    taskModelPushCapabilityRequestRef.current += 1;
    setTaskModelPushTaskId(null);
    setTaskModelPushCapabilities(null);
    void selectNativeConversation(pending.choice, 'page', 'interactive')
      .then((navigated) => {
        if (!navigated) return;
        setTaskDetailPaneTaskId(undefined);
        setConversationDrawer(undefined);
        if (typeof window !== 'undefined') window.history.replaceState(null, '', '#project-sessions');
        workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
      })
      .catch((error: unknown) => recordLocalError('task-model-push-navigation', error));
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
      failTaskModelPushDispatch(pending, appShellSettings.appLanguage === 'zh-CN' ? '无法连接 Codex 服务。' : 'The Codex service connection is unavailable.');
      return;
    }
    try {
      const result = await client.startTaskModelPush(pending.task.id, pending.request, {
        onOperationIdentity(operationIdentity) {
          updateTaskModelPushPendingByTask((current) => {
            const active = current[pending.task.id];
            if (!active || active.request.idempotencyKey !== pending.request.idempotencyKey) return current;
            return { ...current, [pending.task.id]: { ...identifyTaskModelPushPendingOperation(active, operationIdentity), origin: active.origin } };
          });
        },
      });
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
          throw Object.assign(
            new Error(
              reason ??
                (appShellSettings.appLanguage === 'zh-CN'
                  ? '对话还未连接到 AI 服务。为避免重复创建，Zeus 已暂停再次尝试。'
                  : 'The conversation has not connected to the AI service. Zeus has paused further attempts to avoid creating duplicates.'),
            ),
            { code: typeof submissionError.code === 'string' ? submissionError.code : 'ZEUS_TASK_MODEL_PUSH_PROVIDER_NOT_ESTABLISHED' },
          );
        }
        // 原提交在 Provider RPC 前失败；恢复同一会话和提交，避免另建会话或重复首条消息。
        await client.recoverNativeQueue(pending.task.projectId, acceptance.conversation.id, 'continue');
        choice = await client.loadNativeConversationChoice(pending.task.projectId, acceptance.conversation.id);
        if (!choice.providerThreadId) {
          throw new Error(appShellSettings.appLanguage === 'zh-CN' ? '工作目录已可用，但对话仍未连接到 AI 服务。' : 'The working folder is available, but the conversation has not connected to the AI service.');
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
          const message = appShellSettings.appLanguage === 'zh-CN' ? '所选任务或关联内容已更新。请检查最新内容后再创建对话。' : 'The selected task or related content has changed. Review the latest content before creating the conversation.';
          return {
            ...current,
            [pending.task.id]: {
              ...failTaskModelPushPendingState(active, message, error),
              contextRefreshRequired: true,
              origin: active.origin,
            },
          };
        });
        return;
      }
      failTaskModelPushDispatch(pending, error);
    }
  }

  async function resumeTaskModelPushAfterCodexLoginRequired(pending: TrackedTaskModelPushState, client: NativeConversationAppClient): Promise<void> {
    taskModelPushDispatchingTaskIdsRef.current.delete(pending.task.id);
    // 迟到的登录失败只留在原任务，不能把已经切换的工作面导航回来。
    if (selectedNativeConversationIdRef.current !== (pending.choice.navigationId ?? pending.choice.id)) {
      failTaskModelPushDispatch(pending, new Error('ZEUS_CODEX_LOGIN_REQUIRED'));
      return;
    }
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

    taskModelPushEntryRef.current = null;
    setTaskModelPushEntry('confirmation');
    setTaskModelPushTaskId(pending.task.id);
    setTaskModelPushCapabilities(null);
    setTaskModelPushRefreshingRepositoryId(null);
    setTaskModelPushForm(pending.form);
    setTaskModelPushStatus('loading');
    setTaskModelPushError(null);
    setTaskModelPushAnnouncement(appShellSettings.appLanguage === 'zh-CN' ? `${pending.task.title}：Codex 登录已失效，请登录后继续。` : `${pending.task.title}: Codex sign-in expired. Sign in to continue.`);

    const requestVersion = taskModelPushCapabilityRequestRef.current + 1;
    taskModelPushCapabilityRequestRef.current = requestVersion;
    try {
      const capabilities = normalizeTaskModelPushCapabilities(await client.loadCodexTaskPushCapabilities(pending.task.projectId, pending.task.id));
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      const loginRequiredCapabilities: CodexTaskPushCapabilities = {
        ...capabilities,
        codexAccount: {
          ...capabilities.codexAccount,
          requiresOpenaiAuth: true,
          signedIn: false,
        },
      };
      setTaskModelPushCapabilities(loginRequiredCapabilities);
      setTaskModelPushStatus('ready');
      setTaskModelPushError(null);
      // 返回确认页并显示接入入口；用户决定何时重新登录。
    } catch (error) {
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      setTaskModelPushStatus('error');
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage)));
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
          const messageText = redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage));
          updateTaskModelPushPendingByTask((states) => {
            const active = states[pending.task.id];
            if (!active) return states;
            const failedWithMessage = updateTaskModelPushDeferredMessages(active, (messages) => messages.map((entry) => (entry.id === message.id ? { ...entry, status: 'failed', error: messageText } : entry)));
            return { ...states, [pending.task.id]: { ...failTaskModelPushPendingState(failedWithMessage, messageText, error), origin: active.origin } };
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
    taskModelPushEntryRef.current = null;
    setTaskModelPushEntry('confirmation');
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
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage)));
    }
  }

  function failTaskModelPushDispatch(pending: TrackedTaskModelPushState, error: unknown): void {
    const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error, appShellSettings.appLanguage));
    taskModelPushDispatchingTaskIdsRef.current.delete(pending.task.id);
    // 迟到的登录失败只留在原任务，不能把已经切换的工作面导航回来。
    if (selectedNativeConversationIdRef.current !== (pending.choice.navigationId ?? pending.choice.id)) {
      failTaskModelPushDispatch(pending, new Error('ZEUS_CODEX_LOGIN_REQUIRED'));
      return;
    }
    updateTaskModelPushPendingByTask((current) => {
      const active = current[pending.task.id];
      if (active?.request.idempotencyKey !== pending.request.idempotencyKey) return current;
      return { ...current, [pending.task.id]: { ...failTaskModelPushPendingState(active, message, error), origin: active.origin } };
    });
    setTaskModelPushAnnouncement(message);
    reportApplicationError(error, { language: appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en' });
  }

  function retryTaskModelPush(taskId: string): void {
    const pending = taskModelPushPendingByTaskRef.current[taskId];
    if (!pending || pending.status !== 'failed' || (!pending.contextRefreshRequired && !pending.canRetry)) return;
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
    applyThirdPartyTaskExtract,
    archiveConversation,
    authorizeTaskCreateFiles,
    changedFiles,
    chooseNativeConversationAttachments,
    chooseProjectDirectoryForCreate,
    closeProjectCreateDialog,
    closeTaskCreateModal,
    closeTaskGitReview,
    closeTaskModelPush,
    createCurrentProject,
    currentRuntimeAdapterDisplayName,
    deleteProject,
    effectiveTaskStatusSettingsTargetId,
    executeNewConversationProjectGit,
    loadProjectConfig,
    loadProjectWorkspaceConfig,
    materializeTaskCreateResources,
    openProjectCreateDialog,
    openTaskConflictAiConversation,
    openTaskConversation,
    openTaskConversationDrawer,
    openNativeConversationDrawer,
    openNativeConversationPage,
    openTaskCreateModal,
    openTaskCopyModal,
    openTaskDetailPane,
    openTaskGitDelivery,
    openTaskModelPush,
    openThirdPartyLinkInBrowser,
    persistCodeWorkspacePreference,
    prepareNewConversationDraft,
    readTaskCreateClipboardResources,
    recordLocalError,
    recordTaskMutationVersion,
    refreshArchivedConversations,
    refreshArchivedProjects,
    refreshNativeConversationChoices,
    refreshOpenTaskEvents,
    refreshTaskModelPushModels,
    retryTaskModelPushEntry,
    refreshTaskModelPushRepository,
    refreshTaskModelPushRepositories,
    removeTaskCreateAttachment,
    renameProjectDisplayName,
    reopenTaskFromConversation,
    requestTaskTerminalCleanupConfirmation,
    resolveTaskTerminalCleanupConfirmation,
    restoreProject,
    restoreTaskConversation,
    retryTaskModelPush,
    runStorageRecoveryPreflightAndRestart,
    revealProjectInFinder,
    saveProjectConfig,
    saveProjectWorkspaceConfig,
    saveTaskModelPushServiceTierPreference,
    selectNativeConversation,
    selectNewConversationProject,
    selectProjectCodeWorkspaceMode,
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
