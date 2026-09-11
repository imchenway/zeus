import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectTerminalOutput } from '@zeus/shared';
import { cloneTaskManagementStatusConfig, defaultTaskManagementStatusConfig } from '@zeus/shared';
import { type AutomaticUpdateIndicatorState, loadAutomaticUpdateIndicatorFromMain } from '../../appShellBridge.js';
import { type ConversationTreeRuntimeState, conversationTreeRuntimeStateFromConversation, conversationTreeRuntimeStateFromSession, type ProjectConversationGroup } from '../../session/ProjectConversationTree.js';
import { createNativeConversationStartEnvelopeManager, createProjectConversationStartEnvelopeManager, preloadCodexConversationCapabilities, type SessionWorkspaceTask } from '../../session/SessionWorkspace.js';
import { forgetConversationStartCommandRequest, conversationStartClientCommandTypes } from '../conversations/conversationStartCommandClient.js';
import type { CodexConversationCapabilities, CodexTaskPushCapabilities, NativeConversationChoice, NativeSessionState, SessionConversationOwner, StartTaskModelPushRequest } from '../../session/sessionTypes.js';
import { compareConversationStageUpdatedDesc } from '../../session/conversationOrdering.js';
import { buildPersistedSessionViewCache, initialSessionHotCache, rememberSessionHotState, type SessionHotCache } from '../../session/sessionHotCache.js';
import { type TaskModelPushForm, type TaskModelPushModalStatus } from '../../task/TaskModelPushModal.js';
import { useConversationFeatureController } from '../conversations/useConversationFeatureController.js';
import { useGitFeatureController } from '../git/useGitFeatureController.js';
import { useProjectFeatureController } from '../projects/useProjectFeatureController.js';
import { useSettingsFeatureController } from '../settings/useSettingsFeatureController.js';
import { useTaskFeatureController } from '../tasks/useTaskFeatureController.js';
import { defaultTaskTableEnumSortOrders, filterVisibleTasks, normalizeTaskTableColumnPreferences, resolveTaskManagementStatus, taskAgentRunStatusFromConversation, taskAgentRunStatusFromSession } from '../../task/taskWorkspaceModel.js';
import { useApplicationErrorDialog } from '../../ui/ApplicationErrorDialog.js';
import type { StorageRecoveryFaultState } from '../../storageRecoveryError.js';
import { createSessionOperationId } from '../../sessionOperationIdentity.js';
import { type ProjectSourceWorkspaceHandle } from '../../code/ProjectSourceWorkspace.js';
import {
  type AiRuntimeAdapterDescriptor,
  type AiRuntimeAdapterStatus,
  type AiRuntimeLogEntry,
  type AiRuntimeSession,
  type CodexConfigImportResult,
  type CodexConfigImportPreview,
  createEmptyDashboardSnapshot,
  type DashboardSnapshot,
  type GitDiffSummary,
  type GitOperationConfirmation,
  type ConversationHistoryItem,
  type ProjectConfig,
  type ProjectModelServiceTierPreference,
  type ProjectDatabaseSecretSnapshot,
  type ProjectRecord,
  type ReleaseStatusSnapshot,
  type ReleaseUpdateStatusSnapshot,
  type RuntimeOperationConfirmation,
  type RuntimeSettings,
  type RuntimeStatusSnapshot,
  type SecurityAuditLogEntry,
  type SecuritySecretsSnapshot,
  type TaskAgentRunStatus,
  type TaskBoardOpenMode,
  type TaskBoardViewSnapshot,
  type TaskEventRecord,
  type TaskManagementStatus,
  type TaskPageViewMode,
  type TaskRecord,
  type TaskStageRecord,
  type TaskStatusFilter,
  type TaskTableColumnPreferences,
  type TaskTemplateRecord,
  type TelegramNotificationSettings,
  type TelegramPollingLogEntry,
  type TelegramPollingStatus,
  type TelegramSecuritySettings,
  type ZeusRealtimeConnectionState,
} from '../../apiClient.js';
import {
  errorToLocalUiMessage,
  formatGenericShellRisk,
  formatRuntimeConfirmationStatus,
  normalizeLocalUiError,
  normalizeProjectConfig,
  normalizeRuntimeSettings,
  type ProjectConfigFormState,
  toProjectConfigForm,
} from './WorkspaceChrome.js';
import { classifyGenericShellCommandRisk, isGenericShellCriticalConfirmationSatisfied, joinRuntimeLogEntries, runtimeLogMatches } from './workspaceFormatters.js';
import {
  beginNativeConversationChoiceTaskLoad,
  browserNativeConversationStartStorage,
  browserProjectSidebarWidthStorage,
  buildConfiguredTaskManagementStatusLabels,
  buildTaskCreateInitialForm,
  completeNativeConversationChoiceTaskLoad,
  type ConversationDrawer,
  createNativeConversationChoiceLoadCoordinator,
  createNativeProjectConversationChoiceLoadCoordinator,
  createSessionWorkspaceTask,
  type DataPortabilityStatusState,
  dedupeProjectRecordsByLocalPath,
  failNativeConversationChoiceTaskLoad,
  formatConfiguredTaskManagementStatus,
  formatDataPortabilityStatus,
  formatRuntimeLogCopyStatus,
  formatRuntimeLogExportStatus,
  getLanguageCopy,
  inferInitialMainNavTarget,
  inferInitialProjectSection,
  type LocalUiErrorSnapshot,
  type MainNavTarget,
  type NativeConversationChoiceTaskLoadState,
  normalizeRendererAppShellSettings,
  orderProjectsByPinnedIds,
  type ProjectCodeWorkspaceMode,
  type ProjectCreateFormState,
  type ProjectDetailPanel,
  type ProjectWorkspaceSection,
  readCurrentMainNavTarget,
  readProjectSidebarPreferredWidth,
  readSettingsCategoryFromHash,
  resolveConversationNavigationId,
  resolveNativeConversationSelectionPresentation,
  resolveSelectedNativeConversationForProject,
  resolveTaskManagementStatusConfig,
  resolveTaskStatusFilterForProject,
  resolveTaskTableColumnsForProject,
  type RuntimeConfirmationStatusState,
  type RuntimeLogCopyStatusState,
  type RuntimeLogExportStatusState,
  type SettingsCategory,
  syncRecordFromSnapshot,
  type TaskBulkActionStatusState,
  type SessionDrawerTarget,
  type TaskConversationReopenState,
  type TaskCreateFormState,
  type TaskModelPushNavigationTarget,
  isTaskModelPushOriginCurrent,
  taskTableColumnPreferencesEqual,
  type TrackedTaskModelPushState,
} from './workspaceSupport.js';
import type { WorkspacePageProps } from './workspaceContracts.js';

export function useWorkspaceQueryState(props: WorkspacePageProps) {
  /** 异步失败发生时使用最新界面语言，避免早期创建的回调固定中文。 */
  const errorLanguageRef = useRef<'zh-CN' | 'en-US'>(props.initialAppShellSettings?.appLanguage ?? 'zh-CN');
  const [localActiveNavTarget, setLocalActiveNavTarget] = useState<MainNavTarget>(() => inferInitialMainNavTarget(props));
  const activeNavTarget = props.shellNavigation?.activeNavTarget ?? localActiveNavTarget;
  const setActiveNavTarget = props.shellNavigation?.onNavigate ?? setLocalActiveNavTarget;
  const [activeProjectSection, setActiveProjectSection] = useState<ProjectWorkspaceSection>(() => inferInitialProjectSection(props));
  const [projectCodeWorkspaceMode, setProjectCodeWorkspaceMode] = useState<ProjectCodeWorkspaceMode>(() => (typeof window !== 'undefined' && window.location.hash === '#project-commands' ? 'commands' : 'source'));
  const [visitedCodeWorkspaceModes, setVisitedCodeWorkspaceModes] = useState<Set<ProjectCodeWorkspaceMode>>(() => new Set(typeof window !== 'undefined' && window.location.hash === '#project-commands' ? ['source', 'commands'] : ['source']));
  const projectSourceWorkspaceRef = useRef<ProjectSourceWorkspaceHandle | null>(null);
  const [sourceWorkspaceDirty, setSourceWorkspaceDirty] = useState(false);
  const workspaceScrollRef = useRef<HTMLElement | null>(null);
  const [dashboardSnapshot, setDashboardSnapshot] = useState<DashboardSnapshot>(() => props.snapshot ?? createEmptyDashboardSnapshot());
  const { snapshot: projectQuery, replace: replaceProjectQuery } = useProjectFeatureController({ client: props.nativeConversationClient?.projects ?? null, initialItems: dashboardSnapshot.projects });
  const { snapshot: taskQuery, replace: replaceTaskQuery } = useTaskFeatureController({ client: props.nativeConversationClient?.tasks ?? null, initialItems: dashboardSnapshot.tasks });
  const snapshot = useMemo<DashboardSnapshot>(() => ({ ...dashboardSnapshot, projects: [...projectQuery.items], tasks: [...taskQuery.items] }), [dashboardSnapshot, projectQuery.items, taskQuery.items]);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const setSnapshot = useCallback(
    (updater: DashboardSnapshot | ((current: DashboardSnapshot) => DashboardSnapshot)): void => {
      const next = typeof updater === 'function' ? updater(snapshotRef.current) : updater;
      snapshotRef.current = next;
      replaceProjectQuery(next.projects);
      replaceTaskQuery(next.tasks);
      setDashboardSnapshot(next);
    },
    [replaceProjectQuery, replaceTaskQuery],
  );
  const initialGitDiffCopy = getLanguageCopy(props.initialAppShellSettings?.appLanguage ?? 'zh-CN').gitDiffWorkspace;
  const { snapshot: gitQuery, set: setGitQuery } = useGitFeatureController({
    client: props.nativeConversationClient?.git ?? null,
    initialDiff: props.initialGitDiff,
    initialConfirmation: props.initialGitConfirmation,
    patchNotExported: initialGitDiffCopy.patchNotExported,
    operationNotExecuted: initialGitDiffCopy.operationNotExecuted,
  });
  const gitDiff = gitQuery.diff;
  const gitHunkDecisions = gitQuery.hunkDecisions;
  const patchExportStatus = gitQuery.patchExportStatus;
  const setGitDiff = useCallback((updater: GitDiffSummary | undefined | ((current: GitDiffSummary | undefined) => GitDiffSummary | undefined)) => setGitQuery('diff', updater), [setGitQuery]);
  const setGitHunkDecisions = useCallback(
    (updater: Record<string, 'accepted' | 'rejected'> | ((current: Readonly<Record<string, 'accepted' | 'rejected'>>) => Readonly<Record<string, 'accepted' | 'rejected'>>)) => setGitQuery('hunkDecisions', updater),
    [setGitQuery],
  );
  const setPatchExportStatus = useCallback((updater: string | ((current: string) => string)) => setGitQuery('patchExportStatus', updater), [setGitQuery]);
  const [nativeLegacyConversationDetails, setNativeLegacyConversationDetails] = useState<Record<string, ConversationHistoryItem>>({});
  const [nativeLegacyMessageLoadState, setNativeLegacyMessageLoadState] = useState<'empty' | 'loading' | 'error'>('empty');
  const [nativeLegacyMessageError, setNativeLegacyMessageError] = useState<string | null>(null);
  const {
    snapshot: conversationQuery,
    updateTaskChoices: setNativeConversationChoicesByTask,
    updateProjectChoices: setNativeConversationChoicesByProject,
    setArchived: setArchivedConversations,
    setArchivedLoadState: setArchivedConversationLoadState,
    setRestoringConversationId: setRestoringArchivedConversationId,
  } = useConversationFeatureController({
    client: props.nativeConversationClient?.conversations ?? null,
    initialTaskChoices: props.initialNativeConversationChoices,
    initialProjectChoices: props.initialNativeProjectConversationChoices,
  });
  const nativeConversationChoicesByTask = conversationQuery.choicesByTask;
  const nativeConversationChoicesByProject = conversationQuery.choicesByProject;
  const nativeConversationChoicesByTaskRef = useRef(nativeConversationChoicesByTask);
  const nativeConversationChoicesByProjectRef = useRef(nativeConversationChoicesByProject);
  useEffect(() => {
    nativeConversationChoicesByTaskRef.current = nativeConversationChoicesByTask;
  }, [nativeConversationChoicesByTask]);
  useEffect(() => {
    nativeConversationChoicesByProjectRef.current = nativeConversationChoicesByProject;
  }, [nativeConversationChoicesByProject]);
  const [nativeConversationChoiceTaskStates, setNativeConversationChoiceTaskStates] = useState<Record<string, NativeConversationChoiceTaskLoadState>>(() =>
    Object.fromEntries((props.initialNativeConversationChoices ?? []).map((snapshot) => [snapshot.taskId, completeNativeConversationChoiceTaskLoad(undefined)])),
  );
  const [nativeConversationChoiceProjectStates, setNativeConversationChoiceProjectStates] = useState<Record<string, NativeConversationChoiceTaskLoadState>>(() =>
    Object.fromEntries((props.initialNativeProjectConversationChoices ?? []).map((snapshot) => [snapshot.projectId, completeNativeConversationChoiceTaskLoad(undefined)])),
  );
  const [selectedNativeConversationId, setSelectedNativeConversationId] = useState<string | null>(() => props.initialSelectedNativeConversationId ?? null);
  const selectedNativeConversationIdRef = useRef<string | null>(props.initialSelectedNativeConversationId ?? null);
  const [selectedNativeConversationPresentation, setSelectedNativeConversationPresentation] = useState<'history' | 'interactive'>(() => (props.initialSelectedNativeConversationId ? 'history' : 'interactive'));
  const [latestConversationContentVisible, setLatestConversationContentVisible] = useState(false);
  const [zeusWindowForeground, setZeusWindowForeground] = useState(false);
  const [focusedArchivedConversation, setFocusedArchivedConversation] = useState<NativeConversationChoice | null>(null);
  const [optimisticTerminalTaskStatuses, setOptimisticTerminalTaskStatuses] = useState<Record<string, TaskManagementStatus>>({});
  const [taskTerminalCleanupConfirmation, setTaskTerminalCleanupConfirmation] = useState<{
    statusLabel: string;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const archivedConversations = conversationQuery.archived;
  const archivedConversationLoadState = conversationQuery.archivedLoadState;
  const restoringArchivedConversationId = conversationQuery.restoringConversationId;
  const archivedConversationRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const [newConversationFocusRequest, setNewConversationFocusRequest] = useState(0);
  const [nativeConversationRuntimeStates, setNativeConversationRuntimeStates] = useState<Record<string, ConversationTreeRuntimeState>>({});
  const [nativeConversationTaskRunStatuses, setNativeConversationTaskRunStatuses] = useState<Record<string, TaskAgentRunStatus>>({});
  const [nativeConversationStatusSyncState, setNativeConversationStatusSyncState] = useState<ZeusRealtimeConnectionState | 'syncing' | 'stale'>(() => (props.onSubscribeRealtimeEvents ? 'connecting' : 'connected'));
  const [initialNativeConversationHotCache] = useState<SessionHotCache>(initialSessionHotCache);
  const nativeConversationHotCacheRef = useRef<SessionHotCache>(initialNativeConversationHotCache);
  const sessionViewCachePersistTimerRef = useRef<number | null>(null);
  const [projectSidebarViewportWidth, setProjectSidebarViewportWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  const [projectSidebarPreferredWidth, setProjectSidebarPreferredWidth] = useState(() => readProjectSidebarPreferredWidth(browserProjectSidebarWidthStorage()));
  const [projectSidebarResizing, setProjectSidebarResizing] = useState(false);
  const projectSidebarCommittedWidthRef = useRef(projectSidebarPreferredWidth);
  const projectSidebarDragCleanupRef = useRef<(() => void) | null>(null);
  const nativeConversationChoiceLoadCoordinator = useRef(createNativeConversationChoiceLoadCoordinator()).current;
  const nativeProjectConversationChoiceLoadCoordinator = useRef(createNativeProjectConversationChoiceLoadCoordinator()).current;
  const nativeConversationStartEnvelopeManager = useMemo(
    () =>
      createNativeConversationStartEnvelopeManager({
        storage: browserNativeConversationStartStorage(),
        createId: createSessionOperationId,
        releaseRequest: (task, request) =>
          forgetConversationStartCommandRequest({
            commandType: conversationStartClientCommandTypes.taskConversationCreate,
            scopeKind: 'task',
            scopeId: task.id,
            reconnectIdentity: request.idempotencyKey,
          }),
      }),
    [],
  );
  const recoveringNativeConversationStartsRef = useRef<Set<string>>(new Set());
  const recoveringConflictAiStartsRef = useRef<Set<string>>(new Set());
  const taskCreationIdentityRef = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const templateTaskIdentityRef = useRef<Map<string, string>>(new Map());
  const runtimeTaskIdentityRef = useRef<Map<string, string>>(new Map());
  const projectConversationStartEnvelopeManager = useMemo(
    () =>
      createProjectConversationStartEnvelopeManager({
        storage: browserNativeConversationStartStorage(),
        createId: createSessionOperationId,
        releaseRequest: (projectId, request) =>
          forgetConversationStartCommandRequest({
            commandType: conversationStartClientCommandTypes.projectConversationCreate,
            scopeKind: 'project',
            scopeId: projectId,
            reconnectIdentity: request.idempotencyKey,
          }),
      }),
    [],
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const updateProjectSidebarViewportWidth = () => setProjectSidebarViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateProjectSidebarViewportWidth);
    return () => window.removeEventListener('resize', updateProjectSidebarViewportWidth);
  }, []);
  useEffect(() => () => projectSidebarDragCleanupRef.current?.(), []);
  const [taskEvents, setTaskEvents] = useState<TaskEventRecord[]>(() => props.initialTaskEvents ?? []);
  const [taskTemplates, setTaskTemplates] = useState<TaskTemplateRecord[]>(() => props.initialTaskTemplates ?? []);
  const [archivedProjects, setArchivedProjects] = useState<ProjectRecord[]>(() => props.initialArchivedProjects ?? []);
  const [conversationDraftOpen, setConversationDraftOpen] = useState(false);
  const [projectDetail, setProjectDetail] = useState<ProjectRecord | undefined>(() => props.snapshot?.projects[0]);
  const [taskDetail, setTaskDetail] = useState<TaskRecord | undefined>(() => props.snapshot?.tasks[0]);
  const [taskDetailPaneTaskId, setTaskDetailPaneTaskId] = useState<string | undefined>();
  const [taskDetailPresentation, setTaskDetailPresentation] = useState<TaskBoardOpenMode>('side_peek');
  const [taskBoardSnapshots, setTaskBoardSnapshots] = useState<Record<string, TaskBoardViewSnapshot>>({});
  const [taskBoardLoadState, setTaskBoardLoadState] = useState<Record<string, { loading: boolean; error: string | null }>>({});
  const loadTaskBoard = useCallback(
    async (projectId: string): Promise<TaskBoardViewSnapshot | null> => {
      const client = props.nativeConversationClient;
      if (!client) return null;
      setTaskBoardLoadState((current) => ({ ...current, [projectId]: { loading: true, error: null } }));
      try {
        const board = await client.loadTaskBoard(projectId);
        setTaskBoardSnapshots((current) => ({ ...current, [projectId]: board }));
        setTaskBoardLoadState((current) => ({ ...current, [projectId]: { loading: false, error: null } }));
        return board;
      } catch (error) {
        const message = errorToLocalUiMessage(error, errorLanguageRef.current);
        setTaskBoardLoadState((current) => ({ ...current, [projectId]: { loading: false, error: message } }));
        return null;
      }
    },
    [props.nativeConversationClient],
  );
  const [projectCreateDialogOpen, setProjectCreateDialogOpen] = useState(false);
  const [projectCreateForm, setProjectCreateForm] = useState<ProjectCreateFormState>({ name: '', localPath: '' });
  const [projectCreateError, setProjectCreateError] = useState<string | undefined>();
  const [projectDirectoryChoosing, setProjectDirectoryChoosing] = useState(false);
  const projectCreateReturnFocusRef = useRef<HTMLElement | null>(null);
  const [createProjectConfigForm] = useState(() => ({
    defaultModel: '',
    defaultWorkMode: 'plan' as ProjectConfig['defaultWorkMode'],
  }));
  const [taskSearchQuery, setTaskSearchQuery] = useState('');
  const [taskTagFilter, setTaskTagFilter] = useState('');
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [taskBulkActionStatus, setTaskBulkActionStatus] = useState<TaskBulkActionStatusState>({ kind: 'idle' });
  const [projectEditForm, setProjectEditForm] = useState(() => ({
    name: props.snapshot?.projects[0]?.name ?? '',
    localPath: props.snapshot?.projects[0]?.localPath ?? '',
    description: props.snapshot?.projects[0]?.description ?? '',
    note: props.snapshot?.projects[0]?.note ?? '',
  }));
  const initialProjectConfig = normalizeProjectConfig(props.initialProjectConfig, props.snapshot?.projects[0]?.id);
  const [projectConfig, setProjectConfig] = useState<ProjectConfig | undefined>(() => initialProjectConfig);
  const [projectConfigForm, setProjectConfigForm] = useState<ProjectConfigFormState>(() => toProjectConfigForm(initialProjectConfig));
  const [projectSharedWritablePaths, setProjectSharedWritablePaths] = useState('');
  const [projectWorkspaceConfigStatus, setProjectWorkspaceConfigStatus] = useState<'idle' | 'loading' | 'saving' | 'error'>('idle');
  const [projectWorkspaceConfigError, setProjectWorkspaceConfigError] = useState<string | null>(null);
  const [projectDatabaseSecret] = useState<ProjectDatabaseSecretSnapshot | undefined>(() => props.initialProjectDatabaseSecret);
  const [pendingProjectDeleteId, setPendingProjectDeleteId] = useState<string | undefined>();

  function patchProjectEditForm(patch: Partial<typeof projectEditForm>): void {
    setProjectEditForm((current) => ({ ...current, ...patch }));
  }

  function patchProjectConfigForm(patch: Partial<ProjectConfigFormState>): void {
    setProjectConfigForm((current) => ({ ...current, ...patch }));
  }

  useEffect(() => {
    if (!props.snapshot) return;
    // 同步 Electron hydration 后传入的真实 snapshot，避免首屏 connecting 空状态锁死后续真实项目与任务。
    setSnapshot(props.snapshot);
    const nextProject = syncRecordFromSnapshot(projectDetail, props.snapshot.projects);
    const nextTask = syncRecordFromSnapshot(taskDetail, props.snapshot.tasks);
    setProjectDetail(nextProject);
    setTaskDetail(nextTask);
    setProjectEditForm({
      name: nextProject?.name ?? '',
      localPath: nextProject?.localPath ?? '',
      description: nextProject?.description ?? '',
      note: nextProject?.note ?? '',
    });
  }, [props.snapshot]);
  const gitConfirmation = gitQuery.confirmation;
  const gitOperationStatus = gitQuery.operationStatus;
  const gitCommitMessage = gitQuery.commitMessage;
  const gitBranchName = gitQuery.branchName;
  const gitSwitchBranchName = gitQuery.switchBranchName;
  const gitBaseRef = gitQuery.baseRef;
  const gitStashRef = gitQuery.stashRef;
  const gitRemote = gitQuery.remote;
  const gitTargetRef = gitQuery.targetRef;
  const gitRollbackRef = gitQuery.rollbackRef;
  const setGitConfirmation = useCallback((updater: GitOperationConfirmation | undefined | ((current: GitOperationConfirmation | undefined) => GitOperationConfirmation | undefined)) => setGitQuery('confirmation', updater), [setGitQuery]);
  const setGitOperationStatus = useCallback((updater: string | ((current: string) => string)) => setGitQuery('operationStatus', updater), [setGitQuery]);
  const setGitCommitMessage = useCallback((updater: string | ((current: string) => string)) => setGitQuery('commitMessage', updater), [setGitQuery]);
  const setGitBranchName = useCallback((updater: string | ((current: string) => string)) => setGitQuery('branchName', updater), [setGitQuery]);
  const setGitSwitchBranchName = useCallback((updater: string | ((current: string) => string)) => setGitQuery('switchBranchName', updater), [setGitQuery]);
  const setGitBaseRef = useCallback((updater: string | ((current: string) => string)) => setGitQuery('baseRef', updater), [setGitQuery]);
  const setGitStashRef = useCallback((updater: string | ((current: string) => string)) => setGitQuery('stashRef', updater), [setGitQuery]);
  const setGitRemote = useCallback((updater: string | ((current: string) => string)) => setGitQuery('remote', updater), [setGitQuery]);
  const setGitTargetRef = useCallback((updater: string | ((current: string) => string)) => setGitQuery('targetRef', updater), [setGitQuery]);
  const setGitRollbackRef = useCallback((updater: string | ((current: string) => string)) => setGitQuery('rollbackRef', updater), [setGitQuery]);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusSnapshot | undefined>(props.initialRuntimeStatus);
  const [runtimeAdapters, setRuntimeAdapters] = useState<AiRuntimeAdapterDescriptor[]>(() => props.initialRuntimeAdapters ?? []);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>(() => normalizeRuntimeSettings(props.initialRuntimeSettings));
  const [codexConfigImportPreview, setCodexConfigImportPreview] = useState<CodexConfigImportPreview | null>(null);
  const [codexConfigImportResult, setCodexConfigImportResult] = useState<CodexConfigImportResult | null>(null);
  const [codexConfigImportLoading, setCodexConfigImportLoading] = useState(false);
  const [codexConfigImportError, setCodexConfigImportError] = useState<string | null>(null);
  const initialAppShellSettings = normalizeRendererAppShellSettings(
    props.initialAppShellSettings ?? {
      appLanguage: 'zh-CN',
      appearance: 'system',
      webviewDebugEnabled: false,
      developerModeEnabled: false,
      multiWindowEnabled: true,
      backgroundModeEnabled: true,
      desktopNotificationsEnabled: true,
      openAtLoginEnabled: false,
      autoUpdateChannel: 'manual',
      defaultProjectId: null,
      pinnedProjectIds: [],
      collapsedProjectIds: [],
      defaultModel: null,
      defaultTaskTemplateId: null,
      taskTableColumns: normalizeTaskTableColumnPreferences(),
      taskTableColumnsByProject: {},
      taskTableEnumSortOrders: defaultTaskTableEnumSortOrders,
      taskManagementStatusTemplate: cloneTaskManagementStatusConfig(defaultTaskManagementStatusConfig),
      taskManagementStatusByProject: {},
      taskStatusFilterByProject: {},
      taskViewModeByProject: {},
      taskPageViewByProject: {},
      taskExpandedIdsByProject: {},
      codeWorkspaceByProject: {},
      localLogDirectory: 'Zeus/logs',
      localConfigPath: 'Zeus/zeus.config.json',
      dataPortability: {
        importSupported: true,
        exportSupported: true,
        redactsSecrets: true,
      },
    },
  );
  const { snapshot: settingsQuery, update: setAppShellSettings } = useSettingsFeatureController({ client: props.nativeConversationClient?.settings ?? null, initialValue: initialAppShellSettings });
  const appShellSettings = settingsQuery.value;
  useApplicationErrorDialog(projectWorkspaceConfigError, {
    language: appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en',
  });
  useApplicationErrorDialog(archivedConversationLoadState === 'error' ? (conversationQuery.errorCause ?? conversationQuery.error) : null, {
    language: appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en',
  });
  const appShellSettingsRef = useRef(appShellSettings);
  const codeWorkspacePreferenceTimerRef = useRef<number | null>(null);
  appShellSettingsRef.current = appShellSettings;
  useEffect(
    () => () => {
      if (codeWorkspacePreferenceTimerRef.current !== null) window.clearTimeout(codeWorkspacePreferenceTimerRef.current);
    },
    [],
  );
  const [taskStatusSettingsTargetId, setTaskStatusSettingsTargetId] = useState<string>(() => snapshot.projects[0]?.id ?? '__template__');
  const [taskManagementStatusReplacements, setTaskManagementStatusReplacements] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    setAppShellSettings((current) => {
      const template = resolveTaskManagementStatusConfig(current);
      const currentByProject = current.taskManagementStatusByProject ?? {};
      const missingProjectIds = snapshot.projects.map((project) => project.id).filter((projectId) => !currentByProject[projectId]);
      if (missingProjectIds.length === 0) return current;
      return {
        ...current,
        taskManagementStatusByProject: {
          ...currentByProject,
          ...Object.fromEntries(missingProjectIds.map((projectId) => [projectId, cloneTaskManagementStatusConfig(template)])),
        },
      };
    });
  }, [snapshot.projects]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.zeusTheme = appShellSettings.appearance;
    return () => {
      if (root.dataset.zeusTheme === appShellSettings.appearance) {
        delete root.dataset.zeusTheme;
      }
    };
  }, [appShellSettings.appearance]);
  errorLanguageRef.current = appShellSettings.appLanguage;
  const uiCopy = getLanguageCopy(appShellSettings.appLanguage);
  const taskWorkspaceCopy = uiCopy.taskWorkspace;
  const sessionWorkspaceCopy = uiCopy.sessionWorkspace;
  const secondaryDrawerCopy = sessionWorkspaceCopy.secondaryDrawer;
  const codeWorkspaceCopy = uiCopy.codeWorkspace;
  const projectEditCopy = codeWorkspaceCopy.projectEdit;
  const projectConfigCopy = codeWorkspaceCopy.projectConfig;
  const settingsWorkspaceCopy = uiCopy.settingsWorkspace;
  const gitDiffCopy = uiCopy.gitDiffWorkspace;
  const selectSearchPlaceholder = appShellSettings.appLanguage === 'zh-CN' ? '搜索选项' : 'Search options';
  const selectNoResults = appShellSettings.appLanguage === 'zh-CN' ? '没有匹配选项' : 'No matching options';
  const [taskCreateModalOpen, setTaskCreateModalOpen] = useState(false);
  const [taskDeleteDialogTaskId, setTaskDeleteDialogTaskId] = useState<string | null>(null);
  const [taskCreateForm, setTaskCreateForm] = useState<TaskCreateFormState>(() => buildTaskCreateInitialForm(appShellSettings.appLanguage));
  const [taskCreateError, setTaskCreateError] = useState('');
  const [taskModelPushTaskId, setTaskModelPushTaskId] = useState<string | null>(null);
  /** 入口检查与接入期间不展示确认页，失败保留在任务操作旁。 */
  const [taskModelPushEntry, setTaskModelPushEntry] = useState<'checking' | 'choose' | 'custom' | 'confirmation' | 'error'>('confirmation');
  /** 同步阻止入口重复打开，失败时允许按原阶段和工作面身份重查。 */
  const taskModelPushEntryRef = useRef<{ taskId: string; stage?: TaskStageRecord; origin: TaskModelPushNavigationTarget; pending: boolean } | null>(null);
  const [taskModelPushCapabilities, setTaskModelPushCapabilities] = useState<CodexTaskPushCapabilities | null>(null);
  const [taskModelPushServiceTierPreferences, setTaskModelPushServiceTierPreferences] = useState<ProjectModelServiceTierPreference[]>([]);
  const [taskModelPushRuntimeCapabilities, setTaskModelPushRuntimeCapabilities] = useState<CodexConversationCapabilities | null>(null);
  const [taskModelPushForm, setTaskModelPushForm] = useState<TaskModelPushForm>({
    model: '',
    effort: '',
    serviceTier: { type: 'standard' },
    serviceTierDowngraded: false,
    workMode: 'default',
    permissionMode: 'read-only',
    skillId: '',
    workspaceMode: 'direct',
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
  const [taskModelPushStatus, setTaskModelPushStatus] = useState<TaskModelPushModalStatus>('loading');
  const [taskModelPushRefreshingRepositoryId, setTaskModelPushRefreshingRepositoryId] = useState<string | null>(null);
  const [taskModelPushError, setTaskModelPushError] = useState<string | null>(null);
  const [taskModelPushPendingByTask, setTaskModelPushPendingByTask] = useState<Record<string, TrackedTaskModelPushState>>({});
  const taskModelPushPendingByTaskRef = useRef<Record<string, TrackedTaskModelPushState>>({});
  const [taskModelPushAnnouncement, setTaskModelPushAnnouncement] = useState('');
  const [taskGitReviewState, setTaskGitReviewState] = useState<{
    taskId: string;
    workspaceId?: string | null;
    mode: 'commit' | 'commit-only' | 'push-only' | 'delivery';
  } | null>(null);
  const [taskGitMergeTaskId, setTaskGitMergeTaskId] = useState<string | null>(null);
  const [taskGitDeliveryRevision, setTaskGitDeliveryRevision] = useState(0);
  const taskGitDeliveryChangedRef = useRef<(taskId: string) => void>(() => undefined);
  const taskGitDeliveryConversationRef = useRef<(input: { taskId: string; conversationId: string }) => void>(() => undefined);
  const conversationNotificationRef = useRef<(input: { projectId: string; conversationId: string }) => void>(() => undefined);
  const taskModelPushCapabilityRequestRef = useRef(0);
  const taskModelPushEnvelopeRef = useRef(new Map<string, { fingerprint: string; request: StartTaskModelPushRequest }>());
  const taskModelPushDispatchingTaskIdsRef = useRef(new Set<string>());
  const taskModelPushDeferredDispatchingTaskIdsRef = useRef(new Set<string>());
  const taskCreateTitleInputRef = useRef<HTMLInputElement | null>(null);
  const taskCreateReturnFocusRef = useRef<HTMLElement | null>(null);
  const [dataPortabilityStatus, setDataPortabilityStatus] = useState<DataPortabilityStatusState>({ kind: 'idle' });
  const dataPortabilityStatusCopy = formatDataPortabilityStatus(dataPortabilityStatus, settingsWorkspaceCopy.data);
  const [runtimeAdapterChecks, setRuntimeAdapterChecks] = useState<Record<string, AiRuntimeAdapterStatus>>(() => props.initialRuntimeAdapterChecks ?? {});
  const [runtimeConfirmation, setRuntimeConfirmation] = useState<RuntimeOperationConfirmation | undefined>(() => props.initialRuntimeConfirmation);
  const [runtimeConfirmationCommand, setRuntimeConfirmationCommand] = useState(() => props.initialRuntimeConfirmation?.session.args.slice(1).join(' ') ?? '');
  const [runtimeGenericShellCommand, setRuntimeGenericShellCommand] = useState(props.initialRuntimeGenericShellCommand ?? '');
  const [runtimeGenericShellCriticalConfirmation, setRuntimeGenericShellCriticalConfirmation] = useState('');
  const genericShellRisk = classifyGenericShellCommandRisk(runtimeGenericShellCommand);
  const localizedGenericShellRisk = formatGenericShellRisk(genericShellRisk, sessionWorkspaceCopy.runtimeDrawer);
  const genericShellCriticalConfirmed = isGenericShellCriticalConfirmationSatisfied(genericShellRisk, runtimeGenericShellCriticalConfirmation);
  const [runtimeConfirmationStatus, setRuntimeConfirmationStatus] = useState<RuntimeConfirmationStatusState>(() => (props.initialRuntimeConfirmation?.status === 'rejected' ? { kind: 'rejected' } : { kind: 'idle' }));
  const runtimeConfirmationStatusCopy = formatRuntimeConfirmationStatus(runtimeConfirmationStatus, sessionWorkspaceCopy.runtimeDrawer);
  const [runtimeSessions, setRuntimeSessions] = useState<AiRuntimeSession[]>(() => props.initialRuntimeSessions ?? []);
  const [runtimeLogs, setRuntimeLogs] = useState<AiRuntimeLogEntry[]>(() => props.initialRuntimeLogs ?? []);
  const [runtimeSearchQuery, setRuntimeSearchQuery] = useState('');
  const [runtimeInput, setRuntimeInput] = useState('');
  const [runtimeFavoriteOnly, setRuntimeFavoriteOnly] = useState(false);
  const [runtimeShowArchived, setRuntimeShowArchived] = useState(false);
  const [runtimeLogExportStatus, setRuntimeLogExportStatus] = useState<RuntimeLogExportStatusState>({ kind: 'idle' });
  const [runtimeLogSearchQuery, setRuntimeLogSearchQuery] = useState('');
  const [runtimeLogsCollapsed, setRuntimeLogsCollapsed] = useState(false);
  const [runtimeLogCopyStatus, setRuntimeLogCopyStatus] = useState<RuntimeLogCopyStatusState>({ kind: 'idle' });
  const runtimeLogExportStatusCopy = formatRuntimeLogExportStatus(runtimeLogExportStatus, sessionWorkspaceCopy.runtimeDrawer);
  const runtimeLogCopyStatusCopy = formatRuntimeLogCopyStatus(runtimeLogCopyStatus, sessionWorkspaceCopy.runtimeDrawer);
  const projectedRuntimeLogOutput = useMemo(() => projectTerminalOutput(joinRuntimeLogEntries(runtimeLogs.filter((entry) => runtimeLogMatches(entry, runtimeLogSearchQuery)))).slice(-64 * 1024), [runtimeLogSearchQuery, runtimeLogs]);
  const [securitySecrets, setSecuritySecrets] = useState<SecuritySecretsSnapshot>(
    () =>
      props.initialSecuritySecrets ?? {
        telegramBotToken: { configured: false, label: '未配置' },
        externalApiKey: { configured: false, label: '未配置' },
      },
  );
  const [externalApiKeyInput, setExternalApiKeyInput] = useState('');
  const [securityAuditLogs, setSecurityAuditLogs] = useState<SecurityAuditLogEntry[]>(() => props.initialSecurityAuditLogs ?? []);
  const [releaseStatus, setReleaseStatus] = useState<ReleaseStatusSnapshot>(
    () =>
      props.initialReleaseStatus ?? {
        signing: { configured: false, label: '等待 Apple 签名证书' },
        notarization: { configured: false, label: '等待 Apple 公证凭据' },
        homebrewCask: { configured: false, label: '等待 Homebrew cask 文件' },
        releaseWorkflow: {
          configured: false,
          label: '等待 GitHub Release 工作流',
        },
        readiness: {
          canBuildUnsignedArtifacts: true,
          canSign: false,
          canNotarize: false,
          waitingFor: ['Apple signing certificate', 'Apple notarization credentials'],
        },
        autoUpdate: {
          currentVersion: '0.1.0',
          channel: 'manual',
          checkMode: 'manual',
          updateFeedConfigured: false,
          changelogPath: 'docs/release.md',
          waitingFor: ['signed and notarized artifacts'],
          label: '手动更新 · 0.1.0',
        },
      },
  );
  const [releaseUpdateStatus, setReleaseUpdateStatus] = useState<ReleaseUpdateStatusSnapshot>(
    () =>
      props.initialReleaseUpdateStatus ?? {
        status: 'unavailable',
        currentVersion: '0.1.0',
        latestVersion: '0.1.0',
        channel: 'stable',
        releasePageUrl: 'https://github.com/imchenway/zeus/releases/latest',
        artifact: null,
        executionHostProtocolVersion: 2,
        automaticInstallEnabled: false,
        recommendedAction: 'open_download_page',
        label: '暂未检查更新',
        reason: '点击检查更新后读取 GitHub Release 发布清单；实际升级由 macOS 原生 Homebrew 更新窗口承载。',
        checkedAt: '',
      },
  );
  const [releaseUpdateCheckState, setReleaseUpdateCheckState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [automaticUpdateIndicator, setAutomaticUpdateIndicator] = useState<AutomaticUpdateIndicatorState | null>(null);
  const [telegramTokenInput, setTelegramTokenInput] = useState('');
  const [telegramPollingStatus, setTelegramPollingStatus] = useState<TelegramPollingStatus>({
    running: false,
    offset: 0,
    lastError: null,
    handledUpdates: 0,
  });
  const [telegramPollingLogs] = useState<TelegramPollingLogEntry[]>([]);
  const [telegramNotificationSettings, setTelegramNotificationSettings] = useState<TelegramNotificationSettings>({
    enabled: true,
    chatIds: [],
    silentMode: false,
  });
  const [telegramNotificationChatIdsInput, setTelegramNotificationChatIdsInput] = useState('');
  const [telegramTestStatus, setTelegramTestStatus] = useState<string>(() => getLanguageCopy(props.initialAppShellSettings?.appLanguage ?? 'zh-CN').settingsWorkspace.telegram.notTested);
  const [telegramSecuritySettings, setTelegramSecuritySettings] = useState<TelegramSecuritySettings>({ allowedUserIds: [] });
  const [telegramAllowedUserIdsInput, setTelegramAllowedUserIdsInput] = useState('');
  const [actionState, setActionState] = useState<
    'idle' | 'creating-project' | 'creating-task' | 'loading-diff' | 'loading-runtime' | 'loading-templates' | 'updating-task' | 'creating-git-confirmation' | 'confirming-git-operation' | 'executing-git-operation' | 'failed'
  >('idle');
  useEffect(() => {
    let active = true;
    const bridge = globalThis.window.zeus;
    void loadAutomaticUpdateIndicatorFromMain({ zeus: bridge })
      .then((state) => {
        if (active) setAutomaticUpdateIndicator(state);
      })
      .catch(() => undefined);
    const unsubscribe = bridge?.onAutomaticUpdateIndicatorChanged?.((state) => {
      if (active) setAutomaticUpdateIndicator(state);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  const creatingProjectBusy = actionState === 'creating-project';
  const creatingTaskBusy = actionState === 'creating-task';
  const updatingTaskBusy = actionState === 'updating-task';
  const loadingDiffBusy = actionState === 'loading-diff';
  const loadingRuntimeBusy = actionState === 'loading-runtime';
  const loadingTemplatesBusy = actionState === 'loading-templates';
  const creatingGitConfirmationBusy = actionState === 'creating-git-confirmation';
  const confirmingGitOperationBusy = actionState === 'confirming-git-operation';
  const executingGitOperationBusy = actionState === 'executing-git-operation';
  const releaseUpdateBusy = releaseUpdateCheckState === 'loading';
  const [localError, setLocalError] = useState<LocalUiErrorSnapshot | undefined>(() => normalizeLocalUiError(props.initialLocalError));
  const [storageRecoveryFault, setStorageRecoveryFault] = useState<StorageRecoveryFaultState | null>(null);
  useApplicationErrorDialog(localError, {
    language: appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en',
  });
  const projectCreationReady = Boolean(props.onChooseProjectDirectory && props.onCreateCurrentProject);
  const gitLabel = snapshot.git.isRepository ? `Git ${snapshot.git.branch}` : codeWorkspaceCopy.gitNotDetected;
  useEffect(() => {
    if (!taskCreateModalOpen) return;
    const focusTitleInput = window.setTimeout(() => taskCreateTitleInputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTitleInput);
  }, [taskCreateModalOpen]);
  useEffect(() => {
    if (props.shellNavigation) return;
    const syncActiveTarget = () => {
      setActiveNavTarget(readCurrentMainNavTarget());
      const categoryFromHash = readSettingsCategoryFromHash();
      if (categoryFromHash) setSettingsCategory(categoryFromHash);
    };
    syncActiveTarget();
    window.addEventListener('hashchange', syncActiveTarget);
    return () => window.removeEventListener('hashchange', syncActiveTarget);
  }, [props.shellNavigation]);

  const visibleProjects = useMemo(() => dedupeProjectRecordsByLocalPath(snapshot.projects), [snapshot.projects]);
  const orderedProjects = useMemo(() => orderProjectsByPinnedIds(visibleProjects, appShellSettings.pinnedProjectIds), [visibleProjects, appShellSettings.pinnedProjectIds]);
  const firstProject = orderedProjects[0];
  const firstProjectId = firstProject?.id;
  const runtime = runtimeStatus ?? {
    aiCli: {
      name: 'Codex CLI',
      command: 'codex',
      available: snapshot.runtime.aiCli.available,
      reason: snapshot.runtime.aiCli.reason,
    },
    telegram: snapshot.runtime.telegram,
    terminal: {
      provider: 'child_process' as const,
      pty: {
        available: false,
        reason: sessionWorkspaceCopy.runtimeDrawer.terminalPending,
      },
    },
  };
  const [projectPanel, setProjectPanel] = useState<ProjectDetailPanel>(() => {
    if (props.initialMainNavTarget === 'git-diff' || props.initialGitDiff || props.initialGitConfirmation) return 'diff';
    if (props.initialArchivedProjects?.length) return 'archive';
    return undefined;
  });
  const [conversationDrawer, setConversationDrawer] = useState<ConversationDrawer>(() => {
    if (
      props.initialMainNavTarget === 'runtime' ||
      props.initialRuntimeStatus ||
      props.initialRuntimeSessions?.length ||
      props.initialRuntimeLogs?.length ||
      props.initialRuntimeAdapters?.length ||
      props.initialRuntimeSettings ||
      props.initialRuntimeGenericShellCommand ||
      props.initialRuntimeConfirmation
    )
      return 'runtime';
    if (props.initialMainNavTarget === 'git-diff' || props.initialGitDiff || props.initialGitConfirmation) return 'changes';
    if (props.initialTaskTemplates?.length) return 'templates';
    return undefined;
  });
  /** 当前打开的会话抽屉与底层项目页面分开保存。 */
  const [sessionDrawerTarget, setSessionDrawerTarget] = useState<SessionDrawerTarget>();
  const [taskConversationReopenState, setTaskConversationReopenState] = useState<TaskConversationReopenState>();
  const [localSettingsCategory, setLocalSettingsCategory] = useState<SettingsCategory>(() => {
    const categoryFromHash = readSettingsCategoryFromHash();
    if (categoryFromHash) return categoryFromHash;
    if (props.initialMainNavTarget === 'settings-data') return 'data';
    if (props.initialMainNavTarget === 'telegram' || props.initialSecuritySecrets?.telegramBotToken.configured) return 'im';
    if (props.initialRuntimeSettings || props.initialRuntimeStatus) return 'runtime';
    if (props.initialReleaseStatus) return 'release';
    return 'general';
  });
  const settingsCategory = props.shellNavigation?.settingsCategory ?? localSettingsCategory;
  const [releaseLoadState, setReleaseLoadState] = useState<'loading' | 'ready' | 'failed'>(props.initialReleaseStatus && props.initialReleaseUpdateStatus ? 'ready' : 'loading');
  const [releaseLoadRevision, setReleaseLoadRevision] = useState(0);
  useEffect(() => {
    if (activeNavTarget !== 'settings' || settingsCategory !== 'release') return;
    if (!props.onLoadReleaseStatus || !props.onLoadReleaseUpdateStatus) {
      setReleaseLoadState(props.initialReleaseStatus && props.initialReleaseUpdateStatus ? 'ready' : 'failed');
      return;
    }
    let cancelled = false;
    setReleaseLoadState('loading');
    void Promise.all([props.onLoadReleaseStatus(), props.onLoadReleaseUpdateStatus()])
      .then(([status, update]) => {
        if (cancelled) return;
        setReleaseStatus(status);
        setReleaseUpdateStatus(update);
        setReleaseLoadState('ready');
      })
      .catch(() => {
        if (!cancelled) setReleaseLoadState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [activeNavTarget, settingsCategory, props.onLoadReleaseStatus, props.onLoadReleaseUpdateStatus, props.initialReleaseStatus, props.initialReleaseUpdateStatus, releaseLoadRevision]);
  const setSettingsCategory = props.shellNavigation?.onSettingsCategoryChange ?? setLocalSettingsCategory;
  const [codexUsageRevision, setCodexUsageRevision] = useState(0);
  const selectedProject = projectDetail ?? firstProject;
  const activeProjectId = selectedProject?.id ?? firstProjectId;
  useEffect(() => {
    // 切换项目或页面时收起旧抽屉，避免显示其他项目的会话。
    setSessionDrawerTarget(undefined);
  }, [activeNavTarget, activeProjectSection, activeProjectId]);
  const taskStatusFilter = resolveTaskStatusFilterForProject(appShellSettings, activeProjectId);
  const taskPageViewMode: TaskPageViewMode = activeProjectId ? (appShellSettings.taskPageViewByProject?.[activeProjectId] ?? 'list') : 'list';
  const persistedTaskTableColumns = useMemo(() => resolveTaskTableColumnsForProject(appShellSettings, activeProjectId), [activeProjectId, appShellSettings.taskTableColumns, appShellSettings.taskTableColumnsByProject]);
  const [taskTableLayoutDraft, setTaskTableLayoutDraft] = useState<{ projectId?: string; preferences: TaskTableColumnPreferences }>(() => ({
    projectId: selectedProject?.id ?? props.snapshot?.projects[0]?.id,
    preferences: resolveTaskTableColumnsForProject(appShellSettings, selectedProject?.id ?? props.snapshot?.projects[0]?.id),
  }));
  const activeTaskTableColumns = taskTableLayoutDraft.projectId === activeProjectId ? taskTableLayoutDraft.preferences : persistedTaskTableColumns;
  const taskTableLayoutDirty = taskTableLayoutDraft.projectId === activeProjectId && !taskTableColumnPreferencesEqual(activeTaskTableColumns, persistedTaskTableColumns);
  const [taskTableLayoutScopeDialogOpen, setTaskTableLayoutScopeDialogOpen] = useState(false);
  const [taskTableLayoutLeaveDialogOpen, setTaskTableLayoutLeaveDialogOpen] = useState(false);
  const [taskTableLayoutSaveBusy, setTaskTableLayoutSaveBusy] = useState(false);
  const [sourceWorkspaceLeaveDialogOpen, setSourceWorkspaceLeaveDialogOpen] = useState(false);
  const [sourceWorkspaceSaveBusy, setSourceWorkspaceSaveBusy] = useState(false);
  const pendingSourceWorkspaceLeaveRef = useRef<(() => void) | null>(null);
  const pendingSourceWorkspaceLeaveCancelRef = useRef<(() => void) | null>(null);
  const pendingTaskTableLayoutLeaveRef = useRef<(() => void) | null>(null);
  const pendingTaskTableLayoutLeaveCancelRef = useRef<(() => void) | null>(null);
  const pendingWorkspaceLeaveKindRef = useRef<'navigation' | 'close' | null>(null);
  const requestWorkspaceLeaveRef = useRef<(leave: () => void, cancel?: () => void, kind?: 'navigation' | 'close') => void>((leave) => leave());
  const saveTaskTableLayoutThenLeaveRef = useRef(false);
  useEffect(() => {
    if (!activeProjectId || taskPageViewMode !== 'board' || taskBoardSnapshots[activeProjectId] || taskBoardLoadState[activeProjectId]?.loading || taskBoardLoadState[activeProjectId]?.error) return;
    void loadTaskBoard(activeProjectId);
  }, [activeProjectId, loadTaskBoard, taskBoardLoadState, taskBoardSnapshots, taskPageViewMode]);
  useEffect(() => {
    if (taskTableLayoutDraft.projectId === activeProjectId) return;
    setTaskTableLayoutDraft({ projectId: activeProjectId, preferences: persistedTaskTableColumns });
  }, [activeProjectId, persistedTaskTableColumns, taskTableLayoutDraft.projectId]);
  useEffect(() => {
    const bridge = window.zeus;
    if (bridge?.setUnsavedChangeState) {
      bridge.setUnsavedChangeState('task-table-layout', taskTableLayoutDirty);
      bridge.setUnsavedChangeState('project-source', sourceWorkspaceDirty);
    } else {
      bridge?.notifyTaskTableLayoutDirty?.(taskTableLayoutDirty || sourceWorkspaceDirty);
    }
  }, [sourceWorkspaceDirty, taskTableLayoutDirty]);
  const activeProjectIdRef = useRef<string | undefined>(activeProjectId);
  const taskModelPushNavigationRef = useRef<TaskModelPushNavigationTarget>({
    projectId: activeProjectId,
    activeNavTarget,
    activeProjectSection,
    selectedConversationId: selectedNativeConversationId,
    selectedConversationPresentation: selectedNativeConversationPresentation,
    taskDetailPaneTaskId,
  });
  taskModelPushNavigationRef.current = {
    projectId: activeProjectId,
    activeNavTarget,
    activeProjectSection,
    selectedConversationId: selectedNativeConversationId,
    selectedConversationPresentation: selectedNativeConversationPresentation,
    taskDetailPaneTaskId,
  };
  useEffect(() => {
    if (!taskModelPushEntryRef.current || isTaskModelPushOriginCurrent(taskModelPushEntryRef.current.origin, taskModelPushNavigationRef.current)) return;
    taskModelPushCapabilityRequestRef.current += 1;
    taskModelPushEntryRef.current = null;
    setTaskModelPushTaskId(null);
    setTaskModelPushEntry('confirmation');
    setTaskModelPushError(null);
  }, [activeProjectId, activeNavTarget, activeProjectSection, taskDetailPaneTaskId]);
  const updateTaskModelPushPendingByTask = useCallback((update: (current: Record<string, TrackedTaskModelPushState>) => Record<string, TrackedTaskModelPushState>): Record<string, TrackedTaskModelPushState> => {
    // ref 是首发操作的同步事实源；React state 只负责投影，不能再把较旧提交反写进 ref。
    const next = update(taskModelPushPendingByTaskRef.current);
    taskModelPushPendingByTaskRef.current = next;
    setTaskModelPushPendingByTask(next);
    return next;
  }, []);
  const selectedTaskConversationRef = useRef<ConversationHistoryItem | undefined>(undefined);
  const pendingRealtimeTaskRefreshIdsRef = useRef<Set<string>>(new Set());
  const pendingRealtimeNativeConversationRefreshIdsRef = useRef<Set<string>>(new Set());
  const repeatRealtimeNativeConversationRefreshIdsRef = useRef<Set<string>>(new Set());
  const taskMutationQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const taskLocalVersionTransitionsRef = useRef<Map<string, Map<string, string>>>(new Map());
  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);
  const projectTaskModelPushManagementStatus = useCallback(
    (task: TaskRecord): TaskRecord => {
      const pending = taskModelPushPendingByTask[task.id];
      if (!pending || pending.status === 'failed') return task;
      const statusConfig = resolveTaskManagementStatusConfig(appShellSettings, task.projectId);
      return resolveTaskManagementStatus(task) === statusConfig.roles.defaultStatusId ? { ...task, managementStatus: statusConfig.roles.pushedStatusId } : task;
    },
    [appShellSettings, taskModelPushPendingByTask],
  );
  const currentProjectTasks = useMemo(
    () => (activeProjectId ? snapshot.tasks.filter((task) => task.projectId === activeProjectId) : snapshot.tasks).map(projectTaskModelPushManagementStatus),
    [activeProjectId, projectTaskModelPushManagementStatus, snapshot.tasks],
  );
  const currentProjectTaskIdsSignature = useMemo(() => JSON.stringify(currentProjectTasks.map((task) => task.id)), [currentProjectTasks]);
  const terminalTaskIds = useMemo(
    () =>
      new Set(
        snapshot.tasks
          .filter((task) => {
            const config = resolveTaskManagementStatusConfig(appShellSettings, task.projectId);
            const status = resolveTaskManagementStatus(task);
            return status === config.roles.completedStatusId || status === config.roles.cancelledStatusId;
          })
          .map((task) => task.id),
      ),
    [appShellSettings, snapshot.tasks],
  );
  /** 任务状态不能隐藏仍未归档的会话；正在结束任务的本次操作仍保持界面锁定。 */
  const conversationTreeHiddenTaskIds = useMemo(
    () => new Set([...terminalTaskIds].filter((taskId) => !nativeConversationChoicesByTask[taskId]?.choices.some((choice) => !choice.archived)).concat(Object.keys(optimisticTerminalTaskStatuses))),
    [nativeConversationChoicesByTask, optimisticTerminalTaskStatuses, terminalTaskIds],
  );
  /** 将同一次推送的临时工作面与真实会话合并为一个入口，不依赖列表和回执的到达顺序。 */
  const projectedTaskConversationChoices = useMemo(
    () =>
      Object.fromEntries(
        snapshot.tasks.map((task) => {
          /** 本任务当前的本地推送工作面。 */
          const pending = taskModelPushPendingByTask[task.id];
          /** 服务端返回的任务历史，包含可能先于推送回执到达的真实会话。 */
          const choices = nativeConversationChoicesByTask[task.id]?.choices ?? [];
          if (!pending) return [task.id, choices];
          /** 创建身份只能在同一项目和任务内关联，防止误合并同名会话及其他推送。 */
          const isPendingChoice = (choice: NativeConversationChoice): boolean =>
            choice.id === pending.choice.id || (Boolean(pending.operationIdentity) && choice.projectId === pending.task.projectId && choice.taskId === pending.task.id && choice.creationOperationIdentity === pending.operationIdentity);
          /** 身份匹配不代表创建成功；只有原流程确认接受后才采用服务端展示状态。 */
          const authoritativeChoice = pending.status === 'accepted' ? choices.find(isPendingChoice) : undefined;
          /** 接管后继续保留稳定导航身份，创建中或失败时保持原工作面。 */
          const projectedChoice = authoritativeChoice ? { ...authoritativeChoice, navigationId: pending.navigationId } : pending.choice;
          return [task.id, [projectedChoice, ...choices.filter((choice) => !isPendingChoice(choice))]];
        }),
      ) as Record<string, NativeConversationChoice[]>,
    [nativeConversationChoicesByTask, snapshot.tasks, taskModelPushPendingByTask],
  );
  const currentTaskConversationChoices = useMemo(() => Object.fromEntries(currentProjectTasks.map((task) => [task.id, projectedTaskConversationChoices[task.id] ?? []])), [currentProjectTasks, projectedTaskConversationChoices]);
  const nativeConversationChoices = useMemo(() => {
    // 归档焦点属于工作区当前对象，不属于活跃会话树；最后写入可避免迟到的普通快照覆盖只读身份。
    const choicesById = new Map<string, NativeConversationChoice>();
    for (const choice of Object.values(nativeConversationChoicesByProject).flatMap((entry) => entry.choices)) {
      choicesById.set(choice.id, choice);
    }
    for (const choices of Object.values(projectedTaskConversationChoices)) {
      for (const choice of choices) choicesById.set(choice.navigationId ?? choice.id, choice);
    }
    if (focusedArchivedConversation) choicesById.set(focusedArchivedConversation.navigationId ?? focusedArchivedConversation.id, focusedArchivedConversation);
    return [...choicesById.values()].sort(compareConversationStageUpdatedDesc);
  }, [focusedArchivedConversation, nativeConversationChoicesByProject, projectedTaskConversationChoices]);
  const selectedNativeConversation = useMemo(
    () => resolveSelectedNativeConversationForProject(nativeConversationChoices, selectedNativeConversationId, activeProjectId),
    [activeProjectId, nativeConversationChoices, selectedNativeConversationId],
  );
  const selectedNativeConversationResolvedPresentation = selectedNativeConversation
    ? resolveNativeConversationSelectionPresentation(
        selectedNativeConversation,
        nativeConversationRuntimeStates[resolveConversationNavigationId(selectedNativeConversation)] ?? nativeConversationRuntimeStates[selectedNativeConversation.id] ?? selectedNativeConversation.listRuntimeState,
      )
    : 'history';
  useEffect(() => {
    if (selectedNativeConversationPresentation !== 'history' || selectedNativeConversationResolvedPresentation !== 'interactive') return;
    // 窗口恢复时没有侧栏点击事件；列表事实确认会话仍活动后同样要恢复实时投影。
    setSelectedNativeConversationPresentation('interactive');
  }, [selectedNativeConversationPresentation, selectedNativeConversationResolvedPresentation]);
  useEffect(() => {
    if (!props.nativeConversationClient || !activeProjectId) return;
    // 能力元数据很小且按项目复用；完整会话快照必须等用户真正打开时再读取。
    // 旧逻辑会在后台并发水合最多 24 份完整历史，使数据库、JSON 解析和 Renderer 内存
    // 都随“可见会话数量 × 全部历史”增长，直接抵消热缓存的收益。
    void preloadCodexConversationCapabilities(props.nativeConversationClient, activeProjectId).catch(() => undefined);
  }, [activeProjectId, props.nativeConversationClient]);
  /** 项目和导航身份都一致时才展示正文，普通项目会话也可打开。 */
  const sessionDrawerReady = Boolean(sessionDrawerTarget && selectedNativeConversation?.projectId === sessionDrawerTarget.projectId && resolveConversationNavigationId(selectedNativeConversation) === sessionDrawerTarget.navigationId);
  useEffect(() => {
    if (!selectedNativeConversation?.taskId) return;
    const taskId = selectedNativeConversation.taskId;
    if (conversationTreeHiddenTaskIds.has(taskId)) {
      setFocusedArchivedConversation((current) => (current?.id === selectedNativeConversation.id && current.archived && current.readOnly ? current : { ...selectedNativeConversation, archived: true, readOnly: true }));
      return;
    }
    const activeChoice = projectedTaskConversationChoices[taskId]?.find(
      (conversation) => (conversation.navigationId ?? conversation.id) === (selectedNativeConversation.navigationId ?? selectedNativeConversation.id) && !conversation.archived,
    );
    if (activeChoice) setFocusedArchivedConversation((current) => (current?.id === selectedNativeConversation.id ? null : current));
  }, [conversationTreeHiddenTaskIds, projectedTaskConversationChoices, selectedNativeConversation]);
  useEffect(() => {
    window.zeus?.notifyTaskGitDeliveryCurrentContext?.({
      taskId: selectedNativeConversation?.taskId ?? null,
      workspaceId: selectedNativeConversation?.workspaceId ?? null,
    });
  }, [selectedNativeConversation?.taskId, selectedNativeConversation?.workspaceId]);
  useEffect(() => {
    const disposeChanged = window.zeus?.onTaskGitDeliveryChanged?.((taskId) => taskGitDeliveryChangedRef.current(taskId));
    const disposeConversation = window.zeus?.onOpenTaskGitDeliveryConversation?.((input) => taskGitDeliveryConversationRef.current(input));
    const disposeNotification = window.zeus?.onOpenConversationNotification?.((input) => conversationNotificationRef.current(input));
    return () => {
      disposeChanged?.();
      disposeConversation?.();
      disposeNotification?.();
    };
  }, []);
  const selectedTaskModelPushOperation = Object.values(taskModelPushPendingByTask).find((pending) => pending.navigationId === selectedNativeConversationId);
  const selectedTaskModelPushOptimisticState = selectedTaskModelPushOperation?.status === 'accepted' && selectedTaskModelPushOperation.choice.id === selectedNativeConversation?.id ? selectedTaskModelPushOperation.session : undefined;
  useEffect(() => {
    function onCommitShortcut(event: globalThis.KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      if (!selectedNativeConversation?.taskId || !selectedNativeConversation.workspaceId) return;
      event.preventDefault();
      setTaskGitReviewState({
        taskId: selectedNativeConversation.taskId,
        workspaceId: selectedNativeConversation.workspaceId,
        mode: 'commit',
      });
    }
    window.addEventListener('keydown', onCommitShortcut);
    return () => window.removeEventListener('keydown', onCommitShortcut);
  }, [selectedNativeConversation?.taskId, selectedNativeConversation?.workspaceId]);
  useEffect(() => {
    selectedNativeConversationIdRef.current = selectedNativeConversationId;
    setLatestConversationContentVisible(false);
  }, [selectedNativeConversationId]);
  const nativeConversationGroups = useMemo<ProjectConversationGroup[]>(
    () =>
      orderedProjects.map((project) => {
        const statusConfig = resolveTaskManagementStatusConfig(appShellSettings, project.id);
        return {
          projectId: project.id,
          projectName: project.name,
          conversations: [...(nativeConversationChoicesByProject[project.id]?.choices ?? [])].filter((conversation) => !conversation.archived).sort(compareConversationStageUpdatedDesc),
          taskStatuses: statusConfig.statuses.map((status) => ({
            id: status.id,
            label: formatConfiguredTaskManagementStatus(status, statusConfig, appShellSettings.appLanguage),
          })),
          tasks: snapshot.tasks
            .filter((task) => task.projectId === project.id)
            .map(projectTaskModelPushManagementStatus)
            .map((task) => ({
              taskId: task.id,
              taskCode: task.taskCode?.trim() || task.id,
              taskTitle: task.title,
              managementStatus: resolveTaskManagementStatus(task),
              conversations: conversationTreeHiddenTaskIds.has(task.id) ? [] : [...(projectedTaskConversationChoices[task.id] ?? [])].filter((conversation) => !conversation.archived).sort(compareConversationStageUpdatedDesc),
            })),
        };
      }),
    [
      appShellSettings.appLanguage,
      appShellSettings.taskManagementStatusByProject,
      appShellSettings.taskManagementStatusTemplate,
      conversationTreeHiddenTaskIds,
      nativeConversationChoicesByProject,
      orderedProjects,
      projectTaskModelPushManagementStatus,
      projectedTaskConversationChoices,
      snapshot.tasks,
    ],
  );
  const reconcileNativeConversationProjectionStates = useCallback((choices: readonly NativeConversationChoice[]): void => {
    if (choices.length === 0) return;
    setNativeConversationRuntimeStates((current) => {
      const next = { ...current };
      for (const conversation of choices) next[conversation.id] = conversationTreeRuntimeStateFromConversation(conversation);
      return next;
    });
    setNativeConversationTaskRunStatuses((current) => {
      const next = { ...current };
      for (const conversation of choices) next[conversation.id] = taskAgentRunStatusFromConversation(conversation);
      return next;
    });
  }, []);
  const persistNativeConversationViewCache = useCallback((): void => {
    sessionViewCachePersistTimerRef.current = null;
    const persist = window.zeus?.persistSessionViewCache;
    if (!persist || nativeConversationHotCacheRef.current.size === 0) return;
    const snapshot = buildPersistedSessionViewCache(nativeConversationHotCacheRef.current);
    if (snapshot.entries.length > 0) persist(snapshot);
  }, []);
  const scheduleNativeConversationViewCachePersistence = useCallback((): void => {
    if (!window.zeus?.persistSessionViewCache) return;
    if (sessionViewCachePersistTimerRef.current !== null) window.clearTimeout(sessionViewCachePersistTimerRef.current);
    sessionViewCachePersistTimerRef.current = window.setTimeout(persistNativeConversationViewCache, 2_500);
  }, [persistNativeConversationViewCache]);
  useEffect(() => {
    const flush = (): void => {
      if (sessionViewCachePersistTimerRef.current !== null) window.clearTimeout(sessionViewCachePersistTimerRef.current);
      persistNativeConversationViewCache();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [persistNativeConversationViewCache]);
  const recordNativeConversationRuntimeState = useCallback(
    (conversationId: string, state: NativeSessionState): void => {
      // 冷切换的 controller 只有视图加载态，不能覆盖服务端已经给出的会话运行态；
      // 否则用户快速切走后该临时状态无人收尾，会在侧栏永久留下假转圈。
      if (!state.snapshot && (state.transportState === 'connecting' || state.transportState === 'hydrating' || state.transportState === 'reconnecting' || state.transportState === 'disconnected')) return;
      const remembered = rememberSessionHotState(nativeConversationHotCacheRef.current, conversationId, state);
      // 只有本次进程已经完成权威水合，才把显示缓存推进到磁盘；旧缓存刷新失败不能续期。
      if (remembered && state.transportState === 'ready') scheduleNativeConversationViewCachePersistence();
      const runtimeState = conversationTreeRuntimeStateFromSession(state);
      setNativeConversationRuntimeStates((current) => (current[conversationId] === runtimeState ? current : { ...current, [conversationId]: runtimeState }));
      const taskRunStatus = taskAgentRunStatusFromSession(state);
      setNativeConversationTaskRunStatuses((current) =>
        current[conversationId] === taskRunStatus
          ? current
          : {
              ...current,
              [conversationId]: taskRunStatus,
            },
      );
    },
    [scheduleNativeConversationViewCachePersistence],
  );

  useEffect(() => {
    const client = props.nativeConversationClient;
    if (!client || (activeProjectSection !== 'sessions' && activeProjectSection !== 'tasks') || !activeProjectId) return;
    let cancelled = false;
    const projectId = activeProjectId;
    const projectRequestVersion = nativeProjectConversationChoiceLoadCoordinator.begin(projectId);
    const taskLoads = (JSON.parse(currentProjectTaskIdsSignature) as string[]).map((taskId) => ({ taskId, requestVersion: nativeConversationChoiceLoadCoordinator.begin(taskId) }));
    setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: beginNativeConversationChoiceTaskLoad(current[projectId]) }));
    setNativeConversationChoiceTaskStates((current) => ({
      ...current,
      ...Object.fromEntries(taskLoads.map(({ taskId }) => [taskId, beginNativeConversationChoiceTaskLoad(current[taskId])])),
    }));

    void client.loadProjectConversationChoiceGroups(projectId).then(
      (snapshot) => {
        if (cancelled) return;
        const mergedProjectChoices = nativeProjectConversationChoiceLoadCoordinator.isCurrent(projectId, projectRequestVersion)
          ? nativeProjectConversationChoiceLoadCoordinator.commit(projectId, projectRequestVersion, snapshot.projectChoices)
          : null;
        const mergedTaskChoices = taskLoads.flatMap(({ taskId, requestVersion }) => {
          const loaded = snapshot.taskChoicesByTaskId[taskId] ?? {
            taskId,
            projectId,
            hasHistory: false,
            requiresChoice: false,
            choices: [],
            items: [],
          };
          const merged = nativeConversationChoiceLoadCoordinator.commit(taskId, requestVersion, loaded);
          return merged ? ([[taskId, merged]] as const) : [];
        });
        if (mergedProjectChoices) setNativeConversationChoicesByProject((current) => ({ ...current, [projectId]: mergedProjectChoices }));
        if (mergedTaskChoices.length > 0) setNativeConversationChoicesByTask((current) => ({ ...current, ...Object.fromEntries(mergedTaskChoices) }));
        reconcileNativeConversationProjectionStates([...(mergedProjectChoices?.choices ?? []), ...mergedTaskChoices.flatMap(([, choices]) => choices.choices)]);
        if (mergedProjectChoices) setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: completeNativeConversationChoiceTaskLoad(current[projectId]) }));
        if (mergedTaskChoices.length > 0) {
          setNativeConversationChoiceTaskStates((current) => ({
            ...current,
            ...Object.fromEntries(mergedTaskChoices.map(([taskId]) => [taskId, completeNativeConversationChoiceTaskLoad(current[taskId])])),
          }));
        }
      },
      (error) => {
        if (cancelled) return;
        const message = errorToLocalUiMessage(error, errorLanguageRef.current);
        if (nativeProjectConversationChoiceLoadCoordinator.isCurrent(projectId, projectRequestVersion)) {
          setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: failNativeConversationChoiceTaskLoad(current[projectId], message) }));
        }
        setNativeConversationChoiceTaskStates((current) => ({
          ...current,
          ...Object.fromEntries(
            taskLoads.filter(({ taskId, requestVersion }) => nativeConversationChoiceLoadCoordinator.isCurrent(taskId, requestVersion)).map(({ taskId }) => [taskId, failNativeConversationChoiceTaskLoad(current[taskId], message)]),
          ),
        }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    activeProjectId,
    activeProjectSection,
    currentProjectTaskIdsSignature,
    nativeConversationChoiceLoadCoordinator,
    nativeProjectConversationChoiceLoadCoordinator,
    props.nativeConversationClient,
    reconcileNativeConversationProjectionStates,
  ]);

  const reconcileNativeConversationProjectSnapshot = useCallback(
    async (projectId: string): Promise<void> => {
      const client = props.nativeConversationClient;
      if (!client) return;
      const projectRequestVersion = nativeProjectConversationChoiceLoadCoordinator.begin(projectId);
      const loaded = await client.loadProjectConversationChoiceGroups(projectId);
      const projectChoices = nativeProjectConversationChoiceLoadCoordinator.commit(projectId, projectRequestVersion, loaded.projectChoices);
      const taskChoices = Object.entries(loaded.taskChoicesByTaskId).flatMap(([taskId, choices]) => {
        const requestVersion = nativeConversationChoiceLoadCoordinator.begin(taskId);
        const merged = nativeConversationChoiceLoadCoordinator.commit(taskId, requestVersion, choices);
        return merged ? ([[taskId, merged]] as const) : [];
      });

      if (projectChoices) {
        setNativeConversationChoicesByProject((current) => {
          const next = { ...current, [projectId]: projectChoices };
          nativeConversationChoicesByProjectRef.current = next;
          return next;
        });
        setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: completeNativeConversationChoiceTaskLoad(current[projectId]) }));
      }
      if (taskChoices.length > 0) {
        setNativeConversationChoicesByTask((current) => {
          const next = { ...current, ...Object.fromEntries(taskChoices) };
          nativeConversationChoicesByTaskRef.current = next;
          return next;
        });
        setNativeConversationChoiceTaskStates((current) => ({
          ...current,
          ...Object.fromEntries(taskChoices.map(([taskId]) => [taskId, completeNativeConversationChoiceTaskLoad(current[taskId])])),
        }));
      }
      reconcileNativeConversationProjectionStates([...(projectChoices?.choices ?? []), ...taskChoices.flatMap(([, choices]) => choices.choices)]);
    },
    [nativeConversationChoiceLoadCoordinator, nativeProjectConversationChoiceLoadCoordinator, props.nativeConversationClient, reconcileNativeConversationProjectionStates],
  );

  const nativeSessionTaskRecordSource = selectedNativeConversation?.taskId
    ? snapshot.tasks.find((task) => task.id === selectedNativeConversation.taskId)
    : conversationDraftOpen && taskDetail && (!activeProjectId || taskDetail.projectId === activeProjectId)
      ? taskDetail
      : undefined;
  const nativeSessionTaskRecord = nativeSessionTaskRecordSource ? projectTaskModelPushManagementStatus(nativeSessionTaskRecordSource) : undefined;
  const optimisticNativeSessionTaskStatus = nativeSessionTaskRecord ? optimisticTerminalTaskStatuses[nativeSessionTaskRecord.id] : undefined;
  const effectiveNativeSessionTaskRecord = nativeSessionTaskRecord && optimisticNativeSessionTaskStatus ? { ...nativeSessionTaskRecord, managementStatus: optimisticNativeSessionTaskStatus } : nativeSessionTaskRecord;
  const nativeSessionTaskStatusConfig = effectiveNativeSessionTaskRecord ? resolveTaskManagementStatusConfig(appShellSettings, effectiveNativeSessionTaskRecord.projectId) : null;
  /** 已归档会话、新建会话和任务结束中的操作沿用重新打开入口；未归档原会话可以继续。 */
  const nativeSessionTaskReadOnly = Boolean(
    (selectedNativeConversation?.archived !== false || optimisticNativeSessionTaskStatus) &&
    effectiveNativeSessionTaskRecord &&
    nativeSessionTaskStatusConfig &&
    (resolveTaskManagementStatus(effectiveNativeSessionTaskRecord) === nativeSessionTaskStatusConfig.roles.completedStatusId ||
      resolveTaskManagementStatus(effectiveNativeSessionTaskRecord) === nativeSessionTaskStatusConfig.roles.cancelledStatusId),
  );
  const nativeSessionTask: SessionWorkspaceTask | null = effectiveNativeSessionTaskRecord ? createSessionWorkspaceTask(effectiveNativeSessionTaskRecord, appShellSettings, appShellSettings.appLanguage) : null;
  const nativeSessionProject = activeProjectId ? snapshot.projects.find((project) => project.id === activeProjectId) : undefined;
  const nativeSessionOwner: SessionConversationOwner | undefined = nativeSessionTask
    ? {
        kind: 'task',
        projectId: nativeSessionTask.projectId,
        projectName: nativeSessionProject?.name ?? nativeSessionTask.projectId,
        taskId: nativeSessionTask.id,
        taskTitle: nativeSessionTask.title,
      }
    : nativeSessionProject
      ? { kind: 'project', projectId: nativeSessionProject.id, projectName: nativeSessionProject.name }
      : undefined;
  const nativeSessionChoices = nativeSessionTask ? (projectedTaskConversationChoices[nativeSessionTask.id] ?? []) : nativeSessionProject ? (nativeConversationChoicesByProject[nativeSessionProject.id]?.choices ?? []) : [];
  const nativeSessionChoiceTaskState = nativeSessionTask ? nativeConversationChoiceTaskStates[nativeSessionTask.id] : nativeSessionProject ? nativeConversationChoiceProjectStates[nativeSessionProject.id] : undefined;
  const nativeLegacyMessages = useMemo(() => {
    const entries: Array<[string, Array<{ id: string; role: string; content: string }>]> = [];
    for (const [sourceConversationId, conversation] of Object.entries(nativeLegacyConversationDetails)) {
      entries.push([sourceConversationId, conversation.messages.map((message) => ({ id: message.id, role: message.role, content: message.content }))]);
    }
    return Object.fromEntries(entries);
  }, [nativeLegacyConversationDetails]);
  const activeTaskManagementStatusConfig = resolveTaskManagementStatusConfig(appShellSettings, activeProjectId);
  const activeTaskManagementStatusLabels = buildConfiguredTaskManagementStatusLabels(activeTaskManagementStatusConfig, appShellSettings.appLanguage);
  const activeTaskManagementStatusIds = activeTaskManagementStatusConfig.statuses.map((status) => status.id);
  const taskStatusFilterValues: readonly TaskStatusFilter[] = ['', 'unfinished', ...activeTaskManagementStatusIds];
  const selectedTask = conversationDraftOpen ? undefined : taskDetail && (!activeProjectId || taskDetail.projectId === activeProjectId) ? taskDetail : currentProjectTasks[0];
  const selectedTaskConversation = useMemo(() => {
    if (!selectedTask) return undefined;
    const candidatesById = new Map(Object.values(nativeLegacyConversationDetails).map((conversation) => [conversation.id, conversation]));
    return Array.from(candidatesById.values())
      .filter((conversation) => !conversation.archived && conversation.projectId === selectedTask.projectId && conversation.taskId === selectedTask.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }, [nativeLegacyConversationDetails, selectedTask?.id, selectedTask?.projectId]);
  const visibleTasks = useMemo(
    () =>
      filterVisibleTasks(currentProjectTasks, taskSearchQuery, taskStatusFilter, taskTagFilter, {
        completed: activeTaskManagementStatusConfig.roles.completedStatusId,
        cancelled: activeTaskManagementStatusConfig.roles.cancelledStatusId,
      }),
    [activeTaskManagementStatusConfig.roles.cancelledStatusId, activeTaskManagementStatusConfig.roles.completedStatusId, currentProjectTasks, taskSearchQuery, taskStatusFilter, taskTagFilter],
  );

  useEffect(() => {
    selectedTaskConversationRef.current = selectedTaskConversation;
  }, [selectedTaskConversation]);

  const mergeTaskRecord = useCallback((task: TaskRecord): void => {
    setSnapshot((current) => ({
      ...current,
      tasks: current.tasks.some((candidate) => candidate.id === task.id) ? current.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)) : [...current.tasks, task],
    }));
    setTaskDetail((current) => (current?.id === task.id ? task : current));
  }, []);
  return {
    props,
    actionState,
    activeNavTarget,
    activeProjectId,
    activeProjectIdRef,
    activeProjectSection,
    activeTaskManagementStatusConfig,
    activeTaskManagementStatusIds,
    activeTaskManagementStatusLabels,
    activeTaskTableColumns,
    appShellSettings,
    appShellSettingsRef,
    archivedConversationLoadState,
    archivedConversationRefreshPromiseRef,
    archivedConversations,
    archivedProjects,
    automaticUpdateIndicator,
    codeWorkspaceCopy,
    codeWorkspacePreferenceTimerRef,
    codexConfigImportError,
    codexConfigImportLoading,
    codexConfigImportPreview,
    codexConfigImportResult,
    codexUsageRevision,
    confirmingGitOperationBusy,
    conversationDraftOpen,
    conversationDrawer,
    conversationNotificationRef,
    createProjectConfigForm,
    creatingGitConfirmationBusy,
    creatingProjectBusy,
    creatingTaskBusy,
    currentProjectTasks,
    currentTaskConversationChoices,
    dataPortabilityStatusCopy,
    executingGitOperationBusy,
    externalApiKeyInput,
    firstProjectId,
    genericShellCriticalConfirmed,
    genericShellRisk,
    gitBaseRef,
    gitBranchName,
    gitCommitMessage,
    gitConfirmation,
    gitDiff,
    gitDiffCopy,
    gitHunkDecisions,
    gitLabel,
    gitOperationStatus,
    gitRemote,
    gitRollbackRef,
    gitStashRef,
    gitSwitchBranchName,
    gitTargetRef,
    latestConversationContentVisible,
    loadTaskBoard,
    loadingDiffBusy,
    loadingRuntimeBusy,
    loadingTemplatesBusy,
    localizedGenericShellRisk,
    mergeTaskRecord,
    nativeConversationChoiceLoadCoordinator,
    nativeConversationChoiceTaskStates,
    nativeConversationChoicesByProjectRef,
    nativeConversationChoicesByTask,
    nativeConversationChoices,
    nativeConversationChoicesByTaskRef,
    nativeConversationGroups,
    nativeConversationHotCacheRef,
    nativeConversationRuntimeStates,
    nativeConversationStartEnvelopeManager,
    nativeConversationStatusSyncState,
    nativeConversationTaskRunStatuses,
    nativeLegacyMessageError,
    nativeLegacyMessageLoadState,
    nativeLegacyMessages,
    nativeProjectConversationChoiceLoadCoordinator,
    nativeSessionChoiceTaskState,
    nativeSessionChoices,
    nativeSessionOwner,
    nativeSessionTask,
    nativeSessionTaskReadOnly,
    newConversationFocusRequest,
    optimisticTerminalTaskStatuses,
    orderedProjects,
    patchExportStatus,
    patchProjectConfigForm,
    patchProjectEditForm,
    pendingProjectDeleteId,
    pendingRealtimeNativeConversationRefreshIdsRef,
    pendingRealtimeTaskRefreshIdsRef,
    pendingSourceWorkspaceLeaveCancelRef,
    pendingSourceWorkspaceLeaveRef,
    pendingTaskTableLayoutLeaveCancelRef,
    pendingTaskTableLayoutLeaveRef,
    pendingWorkspaceLeaveKindRef,
    persistedTaskTableColumns,
    projectCodeWorkspaceMode,
    projectConfig,
    projectConfigCopy,
    projectConfigForm,
    projectConversationStartEnvelopeManager,
    projectCreateDialogOpen,
    projectCreateError,
    projectCreateForm,
    projectCreateReturnFocusRef,
    projectCreationReady,
    projectDatabaseSecret,
    projectDetail,
    projectDirectoryChoosing,
    projectEditCopy,
    projectEditForm,
    projectPanel,
    projectSharedWritablePaths,
    projectSidebarCommittedWidthRef,
    projectSidebarDragCleanupRef,
    projectSidebarPreferredWidth,
    projectSidebarResizing,
    projectSidebarViewportWidth,
    projectSourceWorkspaceRef,
    projectTaskModelPushManagementStatus,
    projectWorkspaceConfigStatus,
    projectedRuntimeLogOutput,
    projectedTaskConversationChoices,
    reconcileNativeConversationProjectSnapshot,
    reconcileNativeConversationProjectionStates,
    recordNativeConversationRuntimeState,
    recoveringConflictAiStartsRef,
    recoveringNativeConversationStartsRef,
    releaseStatus,
    releaseLoadState,
    setReleaseLoadRevision,
    releaseUpdateBusy,
    releaseUpdateCheckState,
    releaseUpdateStatus,
    repeatRealtimeNativeConversationRefreshIdsRef,
    requestWorkspaceLeaveRef,
    restoringArchivedConversationId,
    runtime,
    runtimeAdapterChecks,
    runtimeAdapters,
    runtimeConfirmation,
    runtimeConfirmationCommand,
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
    runtimeTaskIdentityRef,
    saveTaskTableLayoutThenLeaveRef,
    secondaryDrawerCopy,
    securityAuditLogs,
    securitySecrets,
    selectNoResults,
    selectSearchPlaceholder,
    selectedNativeConversation,
    selectedNativeConversationId,
    selectedNativeConversationIdRef,
    selectedNativeConversationPresentation,
    selectedProject,
    selectedTaskConversationRef,
    selectedTaskIds,
    selectedTaskModelPushOperation,
    selectedTaskModelPushOptimisticState,
    sessionWorkspaceCopy,
    setActionState,
    setActiveNavTarget,
    setActiveProjectSection,
    setAppShellSettings,
    setArchivedConversationLoadState,
    setArchivedConversations,
    setArchivedProjects,
    setCodexConfigImportError,
    setCodexConfigImportLoading,
    setCodexConfigImportPreview,
    setCodexConfigImportResult,
    setCodexUsageRevision,
    setConversationDraftOpen,
    setConversationDrawer,
    setDataPortabilityStatus,
    setExternalApiKeyInput,
    setFocusedArchivedConversation,
    setGitBaseRef,
    setGitBranchName,
    setGitCommitMessage,
    setGitConfirmation,
    setGitDiff,
    setGitHunkDecisions,
    setGitOperationStatus,
    setGitRemote,
    setGitRollbackRef,
    setGitStashRef,
    setGitSwitchBranchName,
    setGitTargetRef,
    setLatestConversationContentVisible,
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
    setPatchExportStatus,
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
    setProjectPanel,
    setProjectSharedWritablePaths,
    setProjectSidebarPreferredWidth,
    setProjectSidebarResizing,
    setProjectWorkspaceConfigError,
    setProjectWorkspaceConfigStatus,
    setReleaseStatus,
    setReleaseUpdateCheckState,
    setReleaseUpdateStatus,
    setRestoringArchivedConversationId,
    setRuntimeAdapterChecks,
    setRuntimeAdapters,
    setRuntimeConfirmation,
    setRuntimeConfirmationCommand,
    setRuntimeConfirmationStatus,
    setRuntimeFavoriteOnly,
    setRuntimeGenericShellCommand,
    setRuntimeGenericShellCriticalConfirmation,
    setRuntimeInput,
    setRuntimeLogCopyStatus,
    setRuntimeLogExportStatus,
    setRuntimeLogSearchQuery,
    setRuntimeLogs,
    setRuntimeLogsCollapsed,
    setRuntimeSearchQuery,
    setRuntimeSessions,
    setRuntimeSettings,
    setRuntimeShowArchived,
    setRuntimeStatus,
    setSecurityAuditLogs,
    setSecuritySecrets,
    setSelectedNativeConversationId,
    setSelectedNativeConversationPresentation,
    setSelectedTaskIds,
    setSettingsCategory,
    setSnapshot,
    setSourceWorkspaceDirty,
    setSourceWorkspaceLeaveDialogOpen,
    setSourceWorkspaceSaveBusy,
    setStorageRecoveryFault,
    setTaskBoardSnapshots,
    setTaskBulkActionStatus,
    setSessionDrawerTarget,
    setTaskConversationReopenState,
    setTaskCreateError,
    setTaskCreateForm,
    setTaskCreateModalOpen,
    setTaskDeleteDialogTaskId,
    setTaskDetail,
    setTaskDetailPaneTaskId,
    setTaskDetailPresentation,
    setTaskEvents,
    setTaskGitDeliveryRevision,
    setTaskGitMergeTaskId,
    setTaskGitReviewState,
    setTaskManagementStatusReplacements,
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
    setTaskStatusSettingsTargetId,
    setTaskTableLayoutDraft,
    setTaskTableLayoutLeaveDialogOpen,
    setTaskTableLayoutSaveBusy,
    setTaskTableLayoutScopeDialogOpen,
    setTaskTagFilter,
    setTaskTemplates,
    setTaskTerminalCleanupConfirmation,
    setTelegramAllowedUserIdsInput,
    setTelegramNotificationChatIdsInput,
    setTelegramNotificationSettings,
    setTelegramPollingStatus,
    setTelegramSecuritySettings,
    setTelegramTestStatus,
    setTelegramTokenInput,
    setVisitedCodeWorkspaceModes,
    setZeusWindowForeground,
    settingsCategory,
    settingsWorkspaceCopy,
    snapshot,
    sourceWorkspaceDirty,
    sourceWorkspaceLeaveDialogOpen,
    sourceWorkspaceSaveBusy,
    storageRecoveryFault,
    taskBoardLoadState,
    taskBoardSnapshots,
    taskBulkActionStatus,
    sessionDrawerReady,
    sessionDrawerTarget,
    taskConversationReopenState,
    taskCreateError,
    taskCreateForm,
    taskCreateModalOpen,
    taskCreateReturnFocusRef,
    taskCreateTitleInputRef,
    taskCreationIdentityRef,
    taskDeleteDialogTaskId,
    taskDetail,
    taskDetailPaneTaskId,
    taskDetailPresentation,
    taskEvents,
    taskGitDeliveryChangedRef,
    taskGitDeliveryConversationRef,
    taskGitDeliveryRevision,
    taskGitMergeTaskId,
    taskGitReviewState,
    taskLocalVersionTransitionsRef,
    taskManagementStatusReplacements,
    taskModelPushAnnouncement,
    taskModelPushCapabilities,
    taskModelPushCapabilityRequestRef,
    taskModelPushDeferredDispatchingTaskIdsRef,
    taskModelPushDispatchingTaskIdsRef,
    taskModelPushEnvelopeRef,
    taskModelPushError,
    taskModelPushEntry,
    taskModelPushEntryRef,
    taskModelPushForm,
    taskModelPushNavigationRef,
    taskModelPushPendingByTask,
    taskModelPushPendingByTaskRef,
    taskModelPushRefreshingRepositoryId,
    taskModelPushRuntimeCapabilities,
    taskModelPushServiceTierPreferences,
    taskModelPushStatus,
    taskModelPushTaskId,
    taskMutationQueuesRef,
    taskPageViewMode,
    taskSearchQuery,
    taskStatusFilter,
    taskStatusFilterValues,
    taskStatusSettingsTargetId,
    taskTableLayoutDirty,
    taskTableLayoutLeaveDialogOpen,
    taskTableLayoutSaveBusy,
    taskTableLayoutScopeDialogOpen,
    taskTagFilter,
    taskTemplates,
    taskTerminalCleanupConfirmation,
    taskWorkspaceCopy,
    telegramAllowedUserIdsInput,
    telegramNotificationChatIdsInput,
    telegramNotificationSettings,
    telegramPollingLogs,
    telegramPollingStatus,
    telegramSecuritySettings,
    telegramTestStatus,
    telegramTokenInput,
    templateTaskIdentityRef,
    uiCopy,
    updateTaskModelPushPendingByTask,
    updatingTaskBusy,
    visibleTasks,
    visitedCodeWorkspaceModes,
    workspaceScrollRef,
    zeusWindowForeground,
  };
}

export type WorkspaceQueryState = ReturnType<typeof useWorkspaceQueryState>;
