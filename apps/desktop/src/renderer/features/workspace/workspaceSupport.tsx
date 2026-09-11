import { usePresenceOpen } from '../../ui/MotionPresence.js';
import { retainInputFocus } from '../../ui/retainInputFocus.js';
import { type ClipboardEvent as ReactClipboardEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import {
  defaultTaskManagementStatusConfig,
  extractThirdPartyTaskLink,
  isTaskStatusFilter,
  normalizeTaskManagementStatusConfig,
  type ProjectCodeWorkspacePreference,
  type TaskManagementStatusConfig,
  type TaskManagementStatusDefinition,
  type ThirdPartyTaskExtract,
} from '@zeus/shared';
import { PENDING_RESOURCE_LONG_TEXT_THRESHOLD } from '../../ui/pendingResourcePolicy.js';
import { TaskAttachmentPreviewList } from '../../task/TaskAttachmentPreviewList.js';
import { type NativeConversationStartStorage, type SessionWorkspaceTask } from '../../session/SessionWorkspace.js';
import type { NativeConversationChoice, NativeConversationChoicesSnapshot, NativeProjectConversationChoicesSnapshot } from '../../session/sessionTypes.js';
import { compareConversationStageUpdatedDesc } from '../../session/conversationOrdering.js';
import type { SessionControllerClient } from '../../session/useSessionController.js';
import { type TaskModelPushPendingState } from '../../task/TaskModelPushPendingWorkspace.js';
import { type AppLanguage, languageCopy } from './workspaceCopy.js';
import {
  type TaskAttachmentCandidate,
  type TaskAttachmentRestoreTarget,
  taskAttachmentsForField,
  type TaskAttachmentView,
  type TaskResourceAuthorizationResult,
  type TaskResourcePayload,
  toPersistedTaskAttachment,
} from '../../task/taskAttachments.js';
import { normalizeTaskTableColumnPreferences, normalizeTaskTableEnumSortOrders, resolveTaskManagementStatus, type TaskWorkspaceViewMode } from '../../task/taskWorkspaceModel.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { Button, type ButtonVariant } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import {
  type AiRuntimeAdapterDescriptor,
  type AiRuntimeAdapterStatus,
  type AiRuntimeLogEntry,
  type AiRuntimeSession,
  type AiRuntimeSessionStatus,
  type AppShellSettings,
  type DashboardClient,
  type DashboardSnapshot,
  type DeleteTaskRequest,
  type ExecutionHostTransition,
  type GitDiffSummary,
  type GitOperationConfirmation,
  type ConversationHistoryItem,
  type ProjectConfig,
  type ProjectConversationAttentionState,
  type ProjectDatabaseSecretSnapshot,
  type ProjectRecord,
  type ReleaseStatusSnapshot,
  type ReleaseUpdateStatusSnapshot,
  type RuntimeOperationConfirmation,
  type RuntimeSettings,
  type RuntimeStatusSnapshot,
  type SecurityAuditLogEntry,
  type SecuritySecretsSnapshot,
  type TaskEventRecord,
  type TaskManagementStatus,
  type TaskPageViewMode,
  type TaskPriority,
  type TaskRecord,
  type TaskStatusFilter,
  type TaskTableColumnPreferences,
  type TaskTemplateRecord,
  type TaskType,
  ZeusApiError,
  type ZeusRealtimeEvent,
} from '../../apiClient.js';

export type MainNavTarget = 'projects' | 'conversations' | 'automations' | 'skills' | 'settings';
export type LegacyMainNavTarget = MainNavTarget | 'dashboard' | 'tasks' | 'runtime' | 'git-diff' | 'telegram' | 'settings-data';
export type ProjectWorkspaceSection = 'tasks' | 'git' | 'code' | 'sessions' | 'project-settings';
export type ProjectCodeWorkspaceMode = 'source' | 'commands';
export type ProjectWorkspaceEntryId = 'tasks' | 'git' | 'source' | 'commands';
export type ProjectWorkspaceEntry = Readonly<{
  id: ProjectWorkspaceEntryId;
  shortcutKey: '1' | '2' | '3' | '4' | '5';
  section: ProjectWorkspaceSection;
  codeMode: ProjectCodeWorkspaceMode | undefined;
}>;
export const PROJECT_WORKSPACE_ENTRIES = [
  { id: 'tasks', shortcutKey: '1', section: 'tasks', codeMode: undefined },
  { id: 'git', shortcutKey: '2', section: 'git', codeMode: undefined },
  { id: 'source', shortcutKey: '3', section: 'code', codeMode: 'source' },
  { id: 'commands', shortcutKey: '4', section: 'code', codeMode: 'commands' },
] as const satisfies readonly ProjectWorkspaceEntry[];
export type ProjectDetailPanel = 'diff' | 'edit' | 'config' | 'archive' | undefined;
export type ConversationDrawer = 'runtime' | 'context' | 'changes' | 'templates' | undefined;

const interactiveConversationRuntimeStates = new Set<NonNullable<NativeConversationChoice['listRuntimeState']>>(['connecting', 'reconnecting', 'paused', 'queued', 'streaming', 'pending_approval', 'pending_user_input']);

const interactiveConversationStages = new Set<NativeConversationChoice['stage']>(['connecting', 'queued', 'running', 'waiting_user', 'waiting_approval', 'paused']);

/**
 * 侧栏点击空闲会话时保持轻量历史读取；存在活动事实的会话必须恢复交互态，
 * 否则 lazy 历史控制器不会订阅后续事件，也会隐藏当前轮次的底部计划进度。
 */
export function resolveNativeConversationSelectionPresentation(conversation: NativeConversationChoice, runtimeState: NativeConversationChoice['listRuntimeState'] | undefined = conversation.listRuntimeState): 'history' | 'interactive' {
  if (conversation.transportKind !== 'codex_native' || conversation.archived || conversation.readOnly) return 'history';
  if (runtimeState && interactiveConversationRuntimeStates.has(runtimeState)) return 'interactive';
  return interactiveConversationStages.has(conversation.stage) ? 'interactive' : 'history';
}

/** 顶部入口与任务状态共用会话抽屉，并保留所属项目及稳定导航身份。 */
export type SessionDrawerTarget =
  | Readonly<{
      projectId: string;
      taskId?: string;
      conversationId: string;
      navigationId: string;
      status: 'opening' | 'error';
    }>
  | undefined;
export type TaskConversationReopenState = Readonly<{ conversationId: string; status: 'busy' | 'error'; error?: string }> | undefined;
export type SettingsCategory = 'general' | 'usage' | 'memory' | 'tasks' | 'employees' | 'runtime' | 'models' | 'browser' | 'im' | 'zentao' | 'commands' | 'release' | 'data';
export const SETTINGS_CATEGORIES = ['general', 'usage', 'memory', 'tasks', 'employees', 'runtime', 'models', 'browser', 'im', 'zentao', 'commands', 'release', 'data'] as const satisfies readonly SettingsCategory[];
export type DataPortabilityStatusState = { kind: 'idle' } | { kind: 'exported'; target: string } | { kind: 'imported'; target: string; changedSettings: string[] };
export type TaskBulkActionStatusState = { kind: 'idle' | 'running' | 'done' | 'failed'; message?: string };
export type RuntimeLogExportStatusState = { kind: 'idle' } | { kind: 'empty' } | { kind: 'cancelled' } | { kind: 'saved'; filePath: string } | { kind: 'failed' };
export type RuntimeLogCopyStatusState = { kind: 'idle' } | { kind: 'empty' } | { kind: 'copied' } | { kind: 'failed' };
export type RuntimeConfirmationStatusState =
  | { kind: 'idle' }
  | { kind: 'created'; confirmationId: string }
  | { kind: 'create_failed' }
  | { kind: 'reject_failed' }
  | { kind: 'rejected' }
  | { kind: 'critical_phrase_required' }
  | { kind: 'changed' }
  | { kind: 'consumed'; confirmationId: string }
  | { kind: 'failed' };
export type WorkspaceViewId = MainNavTarget;
export type InlineRecoveryAction = {
  label: string;
  onAction?: () => void;
  disabled?: boolean;
  busy?: boolean;
};
export type ControlBusyProps = { 'aria-busy'?: true; 'data-loading'?: 'true' };
export type TaskCreateAttachment = TaskAttachmentView;
export type TaskCreateAttachmentCandidate = TaskAttachmentCandidate;
export type TaskCreateFormState = {
  /** 草稿提交目标，与当前浏览的项目独立。 */
  projectId: string;
  /** 复制草稿显示专用标题；保存仍走普通创建命令。 */
  copiedFromTaskId: string | null;
  parentTaskId: string | null;
  title: string;
  taskType: TaskType | '';
  description: string;
  defectCurrentState: string;
  defectExpectedOutcome: string;
  defectReproductionSteps: string;
  optimizationCurrentState: string;
  optimizationExpectedOutcome: string;
  priority: TaskPriority;
  tags: string;
  attachments: TaskCreateAttachment[];
};
export type TaskCreateTextField = Extract<
  keyof TaskCreateFormState,
  'title' | 'description' | 'defectCurrentState' | 'defectExpectedOutcome' | 'defectReproductionSteps' | 'optimizationCurrentState' | 'optimizationExpectedOutcome' | 'tags'
>;
export type TaskCreateAttachmentField = Exclude<TaskCreateTextField, 'title'>;
export type TaskCreateDraft = {
  parentTaskId: string | null;
  title: string;
  taskType: TaskType;
  description: string;
  defectCurrentState: string;
  defectExpectedOutcome: string;
  defectReproductionSteps: string;
  optimizationCurrentState: string;
  optimizationExpectedOutcome: string;
  priority: TaskPriority;
  tags: string[];
  attachments: ReturnType<typeof toPersistedTaskAttachment>[];
};
export type TaskModelPushNavigationTarget = {
  projectId?: string;
  activeNavTarget: MainNavTarget;
  activeProjectSection: ProjectWorkspaceSection;
  selectedConversationId: string | null;
  selectedConversationPresentation: 'history' | 'interactive';
  taskDetailPaneTaskId?: string;
};

/** 接入请求只属于发起时的任务工作面，导航或切换任务后不再接收回执。 */
export function isTaskModelPushOriginCurrent(origin: TaskModelPushNavigationTarget, current: TaskModelPushNavigationTarget): boolean {
  return origin.projectId === current.projectId && origin.activeNavTarget === current.activeNavTarget && origin.activeProjectSection === current.activeProjectSection && origin.taskDetailPaneTaskId === current.taskDetailPaneTaskId;
}
export type TrackedTaskModelPushState = TaskModelPushPendingState & { origin: TaskModelPushNavigationTarget };
export type NativeConversationAppClient = SessionControllerClient &
  Pick<
    DashboardClient,
    | 'memory'
    | 'conversations'
    | 'projects'
    | 'tasks'
    | 'git'
    | 'settings'
    | 'remoteControl'
    | 'checkRuntimeAdapter'
    | 'loadProjectConversationChoices'
    | 'loadProjectConversationChoiceGroups'
    | 'loadArchivedConversations'
    | 'archiveNativeConversation'
    | 'restoreConversationArchive'
    | 'startProjectConversation'
    | 'loadTaskConversationChoices'
    | 'loadNativeConversationChoice'
    | 'startNativeConversation'
    | 'loadCodexTaskPushCapabilities'
    | 'refreshTaskPushRepositoryRemote'
    | 'loadCodexAccount'
    | 'loadCodexUsageSummary'
    | 'loadUsageOverview'
    | 'loadCodexUsageAnalytics'
    | 'startCodexChatGptLogin'
    | 'loadCodexChatGptLoginStatus'
    | 'cancelCodexChatGptLogin'
    | 'logoutCodexAccount'
    | 'inspectCodexConfigImport'
    | 'importCodexConfig'
    | 'activateCodexConfig'
    | 'loadSkills'
    | 'installSkill'
    | 'removeSkill'
    | 'loadPlugins'
    | 'loadPluginRuntimeStatus'
    | 'installPlugin'
    | 'updatePlugin'
    | 'setPluginEnabled'
    | 'removePlugin'
    | 'trustPluginHook'
    | 'setPluginHookEnabled'
    | 'loadPluginMarketplaces'
    | 'addPluginMarketplace'
    | 'refreshPluginMarketplace'
    | 'removePluginMarketplace'
    | 'bindPluginConnector'
    | 'revokePluginConnectorAuthorization'
    | 'setPluginMcpPolicy'
    | 'startTaskModelPush'
    | 'loadModelConnections'
    | 'createModelConnection'
    | 'updateModelConnection'
    | 'deleteModelConnection'
    | 'clearModelConnectionApiKey'
    | 'refreshModelConnectionModels'
    | 'diagnoseModelConnection'
    | 'loadZentaoInstances'
    | 'createZentaoInstance'
    | 'updateZentaoInstance'
    | 'deleteZentaoInstance'
    | 'clearZentaoInstancePassword'
    | 'revealZentaoInstancePassword'
    | 'verifyZentaoInstance'
    | 'loadSelectablePiModels'
    | 'loadProjectModelSelection'
    | 'saveProjectModelSelection'
    | 'loadProjectWorkspaceConfig'
    | 'saveProjectWorkspaceConfig'
    | 'loadTaskBoard'
    | 'updateTaskBoard'
    | 'moveTaskBoardTask'
    | 'loadProjectGitWorkbench'
    // 控制台与 Git 工作台通过同一个原生客户端读取耐久历史。
    | 'loadProjectGitOperations'
    | 'loadProjectGitCommit'
    | 'executeProjectGitAction'
    | 'generateGitCommitMessage'
    | 'loadGitCommitModels'
    | 'acknowledgeNativeConversationAttention'
    | 'loadTaskGitWorkspaces'
    | 'loadTaskGitWorkspaceIndex'
    | 'loadTaskGitWorkspaceSnapshot'
    | 'loadTaskWorkspaceFileDiff'
    | 'commitTaskWorkspace'
    | 'commitAllTaskWorkspaces'
    | 'pushTaskWorkspace'
    | 'pushAllTaskWorkspaces'
    | 'reclaimTaskWorkspace'
    | 'discardTaskWorkspace'
    | 'stopTaskWorkspaceSessions'
    | 'loadTaskIntegrations'
    | 'startTaskIntegration'
    | 'loadTaskIntegrationConflict'
    | 'startTaskIntegrationConflictAi'
    | 'resolveTaskIntegrationConflict'
    | 'finalizeTaskIntegration'
    | 'pushTaskIntegration'
    | 'loadCodexRemoteControl'
    | 'enableCodexRemoteControl'
    | 'disableCodexRemoteControl'
    | 'startCodexRemoteControlPairing'
    | 'loadCodexRemoteControlPairingStatus'
    | 'revokeCodexRemoteControlClient'
  >;
export type NativeConversationChoiceLoadState = 'empty' | 'loading' | 'ready' | 'error';

export interface NativeConversationChoiceTaskLoadState {
  status: Exclude<NativeConversationChoiceLoadState, 'empty'>;
  choicesKnown: boolean;
  error: string | null;
}

export function beginNativeConversationChoiceTaskLoad(previous: NativeConversationChoiceTaskLoadState | undefined): NativeConversationChoiceTaskLoadState {
  return { status: 'loading', choicesKnown: previous?.choicesKnown ?? false, error: null };
}

export function completeNativeConversationChoiceTaskLoad(previous?: NativeConversationChoiceTaskLoadState): NativeConversationChoiceTaskLoadState {
  void previous;
  return { status: 'ready', choicesKnown: true, error: null };
}

export function failNativeConversationChoiceTaskLoad(previous: NativeConversationChoiceTaskLoadState | undefined, error: string): NativeConversationChoiceTaskLoadState {
  return { status: 'error', choicesKnown: previous?.choicesKnown ?? false, error };
}

export interface NativeConversationChoiceLoadCoordinator {
  begin(taskId: string): number;
  isCurrent(taskId: string, requestVersion: number): boolean;
  preserveAccepted(choice: NativeConversationChoice): void;

  forget(taskId: string, conversationId: string): void;
  commit(taskId: string, requestVersion: number, snapshot: NativeConversationChoicesSnapshot): NativeConversationChoicesSnapshot | null;
}

/** Keeps durable POST acceptance authoritative while eventually consistent GET snapshots race. */
export function createNativeConversationChoiceLoadCoordinator(): NativeConversationChoiceLoadCoordinator {
  const requestVersions = new Map<string, number>();
  const acceptedByTask = new Map<string, Map<string, NativeConversationChoice>>();
  const isCurrent = (taskId: string, requestVersion: number) => requestVersions.get(taskId) === requestVersion;
  return {
    begin(taskId) {
      const requestVersion = (requestVersions.get(taskId) ?? 0) + 1;
      requestVersions.set(taskId, requestVersion);
      return requestVersion;
    },
    isCurrent,
    preserveAccepted(choice) {
      if (!choice.taskId) return;
      const accepted = acceptedByTask.get(choice.taskId) ?? new Map<string, NativeConversationChoice>();
      accepted.set(choice.id, choice);
      acceptedByTask.set(choice.taskId, accepted);
    },
    forget(taskId, conversationId) {
      // 已确认归档后，让归档前发出的目录读取失效。
      requestVersions.set(taskId, (requestVersions.get(taskId) ?? 0) + 1);
      const accepted = acceptedByTask.get(taskId);
      if (!accepted) return;
      accepted.delete(conversationId);
      if (accepted.size === 0) acceptedByTask.delete(taskId);
    },
    commit(taskId, requestVersion, snapshot) {
      if (!isCurrent(taskId, requestVersion)) return null;
      const loadedIds = new Set(snapshot.choices.map((choice) => choice.id));
      const preserved = [...(acceptedByTask.get(taskId)?.values() ?? [])].filter((choice) => !loadedIds.has(choice.id));
      const choices = [...preserved, ...snapshot.choices].sort(compareConversationStageUpdatedDesc);
      return {
        ...snapshot,
        hasHistory: choices.length > 0,
        requiresChoice: choices.length > 0,
        choices,
        items: choices,
      };
    },
  };
}

export interface NativeProjectConversationChoiceLoadCoordinator {
  begin(projectId: string): number;
  isCurrent(projectId: string, requestVersion: number): boolean;
  preserveAccepted(choice: NativeConversationChoice): void;
  forget(projectId: string, conversationId: string): void;
  commit(projectId: string, requestVersion: number, snapshot: NativeProjectConversationChoicesSnapshot): NativeProjectConversationChoicesSnapshot | null;
}

/** 项目 choices 的乱序保护与 task choices 独立，taskId=null 的 durable acceptance 不会被旧 GET 快照覆盖。 */
export function createNativeProjectConversationChoiceLoadCoordinator(): NativeProjectConversationChoiceLoadCoordinator {
  const requestVersions = new Map<string, number>();
  const acceptedByProject = new Map<string, Map<string, NativeConversationChoice>>();
  const isCurrent = (projectId: string, requestVersion: number) => requestVersions.get(projectId) === requestVersion;
  return {
    begin(projectId) {
      const requestVersion = (requestVersions.get(projectId) ?? 0) + 1;
      requestVersions.set(projectId, requestVersion);
      return requestVersion;
    },
    isCurrent,
    preserveAccepted(choice) {
      if (choice.taskId !== null) return;
      const accepted = acceptedByProject.get(choice.projectId) ?? new Map<string, NativeConversationChoice>();
      accepted.set(choice.id, choice);
      acceptedByProject.set(choice.projectId, accepted);
    },
    forget(projectId, conversationId) {
      // 已确认归档后，让归档前发出的目录读取失效。
      requestVersions.set(projectId, (requestVersions.get(projectId) ?? 0) + 1);
      const accepted = acceptedByProject.get(projectId);
      if (!accepted) return;
      accepted.delete(conversationId);
      if (accepted.size === 0) acceptedByProject.delete(projectId);
    },
    commit(projectId, requestVersion, snapshot) {
      if (!isCurrent(projectId, requestVersion) || snapshot.projectId !== projectId) return null;
      const loadedIds = new Set(snapshot.choices.map((choice) => choice.id));
      const preserved = [...(acceptedByProject.get(projectId)?.values() ?? [])].filter((choice) => !loadedIds.has(choice.id));
      const choices = [...preserved, ...snapshot.choices].filter((choice) => choice.projectId === projectId && choice.taskId === null).sort(compareConversationStageUpdatedDesc);
      return { projectId, choices, items: choices };
    },
  };
}

export type TaskRuntimeControlHandlerResult =
  | DashboardSnapshot
  | {
      snapshot: DashboardSnapshot;
      task?: TaskRecord;
      conversation?: ConversationHistoryItem;
      runtimeError?: { message: string };
    };
export type NormalizedTaskRuntimeControlHandlerResult = {
  snapshot: DashboardSnapshot;
  task?: TaskRecord;
  conversation?: ConversationHistoryItem;
  runtimeError?: { message: string };
};
export type TaskRuntimeConversationNavigation = {
  task: TaskRecord;
  mainNavTarget: 'conversations';
  projectSection: 'sessions';
  hash: '#project-sessions';
};

export function shouldRefreshConversationForRuntimeEvent(event: ZeusRealtimeEvent, conversation: Pick<ConversationHistoryItem, 'sessionId' | 'archived'> | undefined): boolean {
  if (event.type !== 'runtime.session.ended') return false;
  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : undefined;
  return Boolean(sessionId && conversation && !conversation.archived && conversation.sessionId === sessionId);
}

export const realtimeRuntimeConversationMessageLimit = 2_000;
export const realtimeRuntimeConversationByteLimit = 4 * 1024 * 1024;
export const realtimeRuntimeConversationEncoder = new TextEncoder();

export function isRuntimeConversationOutputEvent(event: ZeusRealtimeEvent, conversation: Pick<ConversationHistoryItem, 'sessionId' | 'archived'> | undefined): boolean {
  if (event.type !== 'runtime.session.output' && event.type !== 'runtime.session.error') return false;
  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : undefined;
  return Boolean(sessionId && conversation && !conversation.archived && conversation.sessionId === sessionId);
}

export function appendRuntimeOutputEventsToConversation(conversation: ConversationHistoryItem, events: readonly ZeusRealtimeEvent[], language: 'zh-CN' | 'en-US'): ConversationHistoryItem {
  if (!conversation.sessionId) return conversation;
  const matchingEvents = events.filter((event) => event.payload.sessionId === conversation.sessionId);
  if (matchingEvents.length === 0) return conversation;
  const isRealtimeRuntimeMessage = (source: string): boolean => source === 'runtime_stdout_realtime' || source === 'runtime_stderr_realtime' || source === 'runtime_realtime_projection';
  const persistedMessages = [] as ConversationHistoryItem['messages'];
  const realtimeMessages = [] as ConversationHistoryItem['messages'];
  const existingLogIds = new Set<string>();
  for (const message of conversation.messages) {
    const runtimeLogId = typeof message.metadata.runtimeLogId === 'string' ? message.metadata.runtimeLogId : null;
    if (runtimeLogId) existingLogIds.add(runtimeLogId);
    if (!isRealtimeRuntimeMessage(message.source)) persistedMessages.push(message);
    else if (message.source !== 'runtime_realtime_projection') realtimeMessages.push(message);
  }

  let latestCreatedAt = conversation.updatedAt;
  let appended = false;
  for (const event of matchingEvents) {
    const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null;
    const logId = typeof event.payload.logId === 'string' ? event.payload.logId : null;
    const text = typeof event.payload.text === 'string' ? event.payload.text : null;
    const createdAt = typeof event.payload.createdAt === 'string' ? event.payload.createdAt : event.createdAt;
    const stream = event.payload.stream === 'stderr' ? 'stderr' : 'stdout';
    if (!sessionId || !logId || text === null || conversation.sessionId !== sessionId || existingLogIds.has(logId)) continue;
    existingLogIds.add(logId);
    realtimeMessages.push({
      id: `runtime_realtime_${logId}`,
      conversationId: conversation.id,
      role: stream === 'stderr' ? 'system' : 'assistant',
      content: text,
      source: stream === 'stderr' ? 'runtime_stderr_realtime' : 'runtime_stdout_realtime',
      metadata: {
        sessionId,
        runtimeLogId: logId,
        stream,
        textTruncated: event.payload.textTruncated === true,
        runtimeLogBytes: realtimeRuntimeConversationEncoder.encode(text).byteLength,
      },
      createdAt,
    });
    latestCreatedAt = createdAt;
    appended = true;
  }
  if (!appended) return conversation;

  const kept = [] as typeof realtimeMessages;
  let usedBytes = 0;
  let truncated = realtimeMessages.length > realtimeRuntimeConversationMessageLimit;
  for (let index = realtimeMessages.length - 1; index >= 0 && kept.length < realtimeRuntimeConversationMessageLimit; index -= 1) {
    const message = realtimeMessages[index]!;
    const bytes = typeof message.metadata.runtimeLogBytes === 'number' ? message.metadata.runtimeLogBytes : realtimeRuntimeConversationEncoder.encode(message.content).byteLength;
    if (bytes > realtimeRuntimeConversationByteLimit || usedBytes + bytes > realtimeRuntimeConversationByteLimit) {
      truncated = true;
      continue;
    }
    kept.push(message);
    usedBytes += bytes;
  }
  kept.reverse();
  if (truncated) {
    kept.unshift({
      id: `runtime_realtime_projection_${conversation.sessionId ?? conversation.id}`,
      conversationId: conversation.id,
      role: 'system',
      content: language === 'zh-CN' ? '这里只显示最近约 4 MB 的运行输出。完整内容可在运行日志中查看。' : 'Showing the latest 4 MB of output. Open the run logs for the full output.',
      source: 'runtime_realtime_projection',
      metadata: { sessionId: conversation.sessionId, logsTruncated: true },
      createdAt: kept[0]?.createdAt ?? latestCreatedAt,
    });
  }
  return { ...conversation, status: 'running', updatedAt: latestCreatedAt, messages: [...persistedMessages, ...kept] };
}

export function applyRuntimeEndedEventToConversation(conversation: ConversationHistoryItem, event: ZeusRealtimeEvent, language: 'zh-CN' | 'en-US'): ConversationHistoryItem {
  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null;
  if (!sessionId || conversation.sessionId !== sessionId) return conversation;
  const status = typeof event.payload.status === 'string' ? event.payload.status : conversation.status;
  const endedAt = typeof event.payload.endedAt === 'string' ? event.payload.endedAt : event.createdAt;
  const exitCode = typeof event.payload.exitCode === 'number' ? event.payload.exitCode : null;
  return {
    ...conversation,
    status,
    summary: language === 'zh-CN' ? `运行已结束${exitCode === null ? '' : `，退出码：${exitCode}`}` : `Run ended${exitCode === null ? '' : `; exit code: ${exitCode}`}`,
    updatedAt: endedAt,
  };
}

export const nativeConversationListLifecycleEventTypes = new Set([
  'conversation.transport.changed',
  'conversation.thread.changed',
  'conversation.turn.started',
  'conversation.turn.completed',
  'conversation.queue.changed',
  'conversation.request.created',
  'conversation.request.resolved',
  'conversation.plan_implementation_request.changed',
  'conversation.native.error',
  'conversation.attention.changed',
  'conversation.attention.acknowledged',
  'conversation.goal.updated',
  'conversation.goal.cleared',
]);

export function isProjectConversationAttentionState(value: unknown): value is ProjectConversationAttentionState {
  return value === 'idle' || value === 'running' || value === 'unread' || value === 'completed' || value === 'failed' || value === 'interrupted' || value === 'reply_required';
}

export function shouldRefreshNativeConversationListForRealtimeEvent(event: ZeusRealtimeEvent): boolean {
  return nativeConversationListLifecycleEventTypes.has(event.type) && typeof event.payload.projectId === 'string' && typeof event.payload.conversationId === 'string';
}

export type WorkMode = ProjectConfig['defaultWorkMode'];
export type DiagramExportFormat = 'mermaid' | 'plantuml';
export type AppShellSettingsSavePayload = Pick<
  AppShellSettings,
  | 'networkProxy'
  | 'appLanguage'
  | 'appearance'
  | 'webviewDebugEnabled'
  | 'developerModeEnabled'
  | 'multiWindowEnabled'
  | 'backgroundModeEnabled'
  | 'desktopNotificationsEnabled'
  | 'openAtLoginEnabled'
  | 'autoUpdateChannel'
  | 'defaultProjectId'
  | 'pinnedProjectIds'
  | 'collapsedProjectIds'
  | 'defaultModel'
  | 'defaultTaskTemplateId'
  | 'taskTableColumns'
  | 'taskTableColumnsByProject'
  | 'taskTableEnumSortOrders'
  | 'taskManagementStatusTemplate'
  | 'taskManagementStatusByProject'
  | 'taskStatusFilterByProject'
  | 'taskViewModeByProject'
  | 'taskPageViewByProject'
  | 'taskExpandedIdsByProject'
  | 'codeWorkspaceByProject'
> & { taskManagementStatusReplacements?: Record<string, Record<string, string>> };

export const PROJECT_SIDEBAR_DEFAULT_WIDTH = 248;
export const PROJECT_SIDEBAR_MIN_WIDTH = 200;
export const PROJECT_SIDEBAR_MAX_WIDTH = 420;
export const PROJECT_SIDEBAR_MIN_WORKSPACE_WIDTH = 520;
export const PROJECT_SIDEBAR_SEPARATOR_WIDTH = 1;
export const PROJECT_SIDEBAR_WIDTH_STORAGE_KEY = 'zeus.shell.project-sidebar-width:v1';

export interface ProjectSidebarWidthStorage {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
}

export function clampProjectSidebarWidth(width: number, viewportWidth: number): number {
  const safeViewportWidth = Number.isFinite(viewportWidth) ? viewportWidth : PROJECT_SIDEBAR_DEFAULT_WIDTH + PROJECT_SIDEBAR_SEPARATOR_WIDTH + PROJECT_SIDEBAR_MIN_WORKSPACE_WIDTH;
  const viewportMaximum = Math.max(PROJECT_SIDEBAR_MIN_WIDTH, Math.min(PROJECT_SIDEBAR_MAX_WIDTH, Math.floor(safeViewportWidth - PROJECT_SIDEBAR_SEPARATOR_WIDTH - PROJECT_SIDEBAR_MIN_WORKSPACE_WIDTH)));
  const safeWidth = Number.isFinite(width) ? Math.round(width) : PROJECT_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(viewportMaximum, Math.max(PROJECT_SIDEBAR_MIN_WIDTH, safeWidth));
}

export function normalizeProjectSidebarPreferredWidth(width: number): number {
  const safeWidth = Number.isFinite(width) ? Math.round(width) : PROJECT_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(PROJECT_SIDEBAR_MAX_WIDTH, Math.max(PROJECT_SIDEBAR_MIN_WIDTH, safeWidth));
}

export function readProjectSidebarPreferredWidth(storage: Pick<ProjectSidebarWidthStorage, 'getItem'> | undefined): number {
  if (!storage) return PROJECT_SIDEBAR_DEFAULT_WIDTH;
  try {
    const persisted = Number(storage.getItem(PROJECT_SIDEBAR_WIDTH_STORAGE_KEY));
    if (!Number.isFinite(persisted) || persisted < PROJECT_SIDEBAR_MIN_WIDTH || persisted > PROJECT_SIDEBAR_MAX_WIDTH) return PROJECT_SIDEBAR_DEFAULT_WIDTH;
    return Math.round(persisted);
  } catch {
    return PROJECT_SIDEBAR_DEFAULT_WIDTH;
  }
}

export function adjustProjectSidebarWidthForKeyboard(currentWidth: number, key: string, shiftKey: boolean, viewportWidth: number): number | null {
  if (key === 'Home') return PROJECT_SIDEBAR_MIN_WIDTH;
  if (key === 'End') return clampProjectSidebarWidth(PROJECT_SIDEBAR_MAX_WIDTH, viewportWidth);
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const delta = shiftKey ? 32 : 8;
  return clampProjectSidebarWidth(currentWidth + (key === 'ArrowRight' ? delta : -delta), viewportWidth);
}

export function resolveProjectSidebarDragResult(startPreferredWidth: number, startRenderedWidth: number, startClientX: number, endClientX: number, viewportWidth: number, commit: boolean): { preferredWidth: number; persist: boolean } {
  const normalizedStartPreference = normalizeProjectSidebarPreferredWidth(startPreferredWidth);
  if (!commit || endClientX === startClientX) return { preferredWidth: normalizedStartPreference, persist: false };
  const nextRenderedWidth = clampProjectSidebarWidth(startRenderedWidth + endClientX - startClientX, viewportWidth);
  if (nextRenderedWidth === startRenderedWidth) return { preferredWidth: normalizedStartPreference, persist: false };
  return { preferredWidth: nextRenderedWidth, persist: true };
}

export interface ProjectSidebarDragState {
  pointerId: number;
  startPreferredWidth: number;
  startRenderedWidth: number;
  startClientX: number;
  lastClientX: number;
}

export type ProjectSidebarDragEvent = { type: 'move'; pointerId: number; clientX: number } | { type: 'finish'; pointerId: number; clientX: number; viewportWidth: number } | { type: 'cancel'; pointerId?: number };

export function transitionProjectSidebarDrag(state: ProjectSidebarDragState, event: ProjectSidebarDragEvent): { state: ProjectSidebarDragState | null; accepted: boolean; result: { preferredWidth: number; persist: boolean } | null } {
  if (event.pointerId !== undefined && event.pointerId !== state.pointerId) return { state, accepted: false, result: null };
  if (event.type === 'move') return { state: { ...state, lastClientX: event.clientX }, accepted: true, result: null };
  if (event.type === 'cancel') return { state: null, accepted: true, result: { preferredWidth: state.startPreferredWidth, persist: false } };
  return {
    state: null,
    accepted: true,
    result: resolveProjectSidebarDragResult(state.startPreferredWidth, state.startRenderedWidth, state.startClientX, event.clientX, event.viewportWidth, true),
  };
}

export function writeProjectSidebarPreferredWidth(storage: Pick<ProjectSidebarWidthStorage, 'setItem'> | undefined, width: number): boolean {
  if (!storage?.setItem) return false;
  try {
    storage.setItem(PROJECT_SIDEBAR_WIDTH_STORAGE_KEY, String(normalizeProjectSidebarPreferredWidth(width)));
    return true;
  } catch {
    return false;
  }
}

export function browserProjectSidebarWidthStorage(): ProjectSidebarWidthStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function persistProjectSidebarPreferredWidth(width: number): void {
  // 侧栏宽度是可选的本机 UI 偏好；存储不可用时继续使用当前会话内状态。
  writeProjectSidebarPreferredWidth(browserProjectSidebarWidthStorage(), width);
}

export function browserNativeConversationStartStorage(): NativeConversationStartStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function isDefinitiveNativeConversationStartRejection(error: unknown): error is ZeusApiError {
  // 只有服务端明确拒绝且无需恢复时才结束重试；网络错误、服务端故障和结果未知仍保留原幂等身份。
  return error instanceof ZeusApiError && error.status >= 400 && error.status < 500 && !error.recoveryRequired;
}

export const codexConfigImportPromptStorageKey = 'zeus.codex-config-import-prompt';
export type CodexConfigImportPromptPreference = 'answered' | 'activation-required';

export function readCodexConfigImportPromptPreference(storage: Pick<NativeConversationStartStorage, 'getItem'> | undefined): CodexConfigImportPromptPreference | null {
  try {
    const value = storage?.getItem(codexConfigImportPromptStorageKey);
    return value === 'answered' || value === 'activation-required' ? value : null;
  } catch {
    return null;
  }
}

export function writeCodexConfigImportPromptPreference(storage: Pick<NativeConversationStartStorage, 'setItem'> | undefined, value: CodexConfigImportPromptPreference): void {
  try {
    storage?.setItem(codexConfigImportPromptStorageKey, value);
  } catch {
    // 一次性引导偏好不可写时继续当前流程，不阻断真实登录或配置启用。
  }
}

export function executionHostSupportsConversationSource(transition: ExecutionHostTransition | undefined, source: 'task_push' | 'code_review' | 'conflict_resolution'): boolean {
  // 非 Electron 渲染面没有宿主交接事实时保留既有行为；正式应用始终由 Main 传入已复验能力。
  if (!transition) return true;
  return transition.capabilities.nativeConversationSources.includes(source);
}

export function SessionMobileSourceTrigger(props: { language: AppLanguage; open: boolean; onOpen: () => void; triggerRef?: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={props.triggerRef} type="button" className="session-mobile-source-trigger" aria-expanded={props.open} aria-controls="session-project-conversation-list" onClick={props.onOpen}>
      <span aria-hidden="true">☰</span>
      {props.language === 'zh-CN' ? '会话列表' : 'Conversations'}
    </button>
  );
}

export const SESSION_DRAWER_FOCUS_DELAY_MS = 40;

export function scheduleSessionDrawerInitialFocus(
  target: Pick<HTMLElement, 'focus'>,
  requestFrame: (callback: FrameRequestCallback) => number = (callback) => window.setTimeout(() => callback(Date.now()), SESSION_DRAWER_FOCUS_DELAY_MS),
  cancelFrame: (frameId: number) => void = (frameId) => window.clearTimeout(frameId),
): () => void {
  const frameId = requestFrame(() => target.focus());
  return () => cancelFrame(frameId);
}

export function resolveSessionDrawerInitialFocusTarget(drawer: HTMLElement): HTMLElement {
  return drawer.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? drawer;
}

/** 在所属项目内统一解析真实会话身份与创建期间保留的导航身份。 */
export function resolveSelectedNativeConversationForProject(choices: NativeConversationChoice[], selectedConversationId: string | null, activeProjectId: string | undefined): NativeConversationChoice | null {
  if (!selectedConversationId || !activeProjectId) return null;
  return choices.find((conversation) => (resolveConversationNavigationId(conversation) === selectedConversationId || conversation.id === selectedConversationId) && conversation.projectId === activeProjectId) ?? null;
}

export function resolveConversationNavigationId(conversation: NativeConversationChoice): string {
  return conversation.navigationId ?? conversation.id;
}

export function resolveTaskConversationToView(snapshot: NativeConversationChoicesSnapshot | undefined): NativeConversationChoice | null {
  if (!snapshot?.choices.length) return null;
  return [...snapshot.choices].sort(compareConversationStageUpdatedDesc)[0] ?? null;
}

export function upsertTaskConversationChoiceSnapshot(taskId: string, snapshot: NativeConversationChoicesSnapshot | undefined, metadata: NativeConversationChoice): NativeConversationChoicesSnapshot {
  const choices = metadata.archived
    ? (snapshot?.choices ?? []).filter((choice) => choice.id !== metadata.id)
    : [metadata, ...(snapshot?.choices ?? []).filter((choice) => choice.id !== metadata.id)].sort(compareConversationStageUpdatedDesc);
  return {
    taskId,
    projectId: metadata.projectId,
    hasHistory: choices.length > 0,
    requiresChoice: choices.length > 0,
    choices,
    items: choices,
  };
}

export function upsertProjectConversationChoiceSnapshot(snapshot: NativeProjectConversationChoicesSnapshot | undefined, metadata: NativeConversationChoice): NativeProjectConversationChoicesSnapshot {
  const choices = metadata.archived
    ? (snapshot?.choices ?? []).filter((choice) => choice.id !== metadata.id)
    : [metadata, ...(snapshot?.choices ?? []).filter((choice) => choice.id !== metadata.id)].sort(compareConversationStageUpdatedDesc);
  return { projectId: metadata.projectId, choices, items: choices };
}
export const workModeValues = ['plan', 'develop', 'review', 'debug'] as const;
export const taskManagementStatusLabels: Record<AppLanguage, Record<string, string>> = {
  'zh-CN': {
    '': '全部',
    todo: '待开始',
    in_development: '开发中',
    in_testing: '测试中',
    awaiting_acceptance: '待验收',
    blocked: '已阻塞',
    completed: '已完成',
    cancelled: '已取消',
  },
  'en-US': {
    '': 'All',
    todo: 'To do',
    in_development: 'In development',
    in_testing: 'In testing',
    awaiting_acceptance: 'Awaiting acceptance',
    blocked: 'Blocked',
    completed: 'Completed',
    cancelled: 'Cancelled',
  },
};

export function resolveTaskManagementStatusConfig(settings: AppShellSettings, projectId?: string): TaskManagementStatusConfig {
  const template = normalizeTaskManagementStatusConfig(settings.taskManagementStatusTemplate, defaultTaskManagementStatusConfig);
  return projectId ? normalizeTaskManagementStatusConfig(settings.taskManagementStatusByProject?.[projectId], template) : template;
}

export function formatConfiguredTaskManagementStatus(status: TaskManagementStatusDefinition | string, config: TaskManagementStatusConfig, language: AppLanguage): string {
  const definition = typeof status === 'string' ? config.statuses.find((candidate) => candidate.id === status) : status;
  if (!definition) return typeof status === 'string' ? status : status.id;
  return definition.label?.trim() || taskManagementStatusLabels[language][definition.id] || definition.id;
}

export function buildConfiguredTaskManagementStatusLabels(config: TaskManagementStatusConfig, language: AppLanguage): Record<TaskManagementStatus | '', string> {
  return {
    '': taskManagementStatusLabels[language][''],
    ...Object.fromEntries(config.statuses.map((status) => [status.id, formatConfiguredTaskManagementStatus(status, config, language)])),
  };
}

export function createSessionWorkspaceTask(task: TaskRecord, settings: AppShellSettings, language: AppLanguage): SessionWorkspaceTask {
  const config = resolveTaskManagementStatusConfig(settings, task.projectId);
  const managementStatusId = resolveTaskManagementStatus(task);
  const definition = config.statuses.find((status) => status.id === managementStatusId);
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    managementStatus: {
      id: managementStatusId,
      label: formatConfiguredTaskManagementStatus(definition ?? managementStatusId, config, language),
      color: definition?.color ?? '#6b7280',
    },
    managementStatusOptions: config.statuses.map((status) => ({
      id: status.id,
      label: formatConfiguredTaskManagementStatus(status, config, language),
      color: status.color,
    })),
  };
}

/** 动作入口在真实提交、扫描、读取中时统一挂载 busy 属性，让 CSS 产品态接管而不是只靠 disabled 变灰。 */
export function controlBusyProps(isBusy: boolean): ControlBusyProps {
  return isBusy ? { 'aria-busy': true, 'data-loading': 'true' } : {};
}

export function normalizeTaskStatusFilterByProject(value: unknown): Record<string, TaskStatusFilter> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, TaskStatusFilter> = {};
  let count = 0;
  for (const [projectId, filter] of Object.entries(value)) {
    const normalizedProjectId = projectId.trim();
    const containsControlCharacter = Array.from(normalizedProjectId).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
    if (!normalizedProjectId || normalizedProjectId.length > 160 || containsControlCharacter || !isTaskStatusFilter(filter)) continue;
    normalized[normalizedProjectId] = filter;
    count += 1;
    if (count >= 100) break;
  }
  return normalized;
}

export function normalizeTaskViewModeByProject(value: unknown): Record<string, TaskWorkspaceViewMode> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([projectId, mode]) => Boolean(projectId.trim()) && (mode === 'hierarchy' || mode === 'flat'))) as Record<string, TaskWorkspaceViewMode>;
}

export function normalizeTaskPageViewByProject(value: unknown): Record<string, TaskPageViewMode> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([projectId, mode]) => Boolean(projectId.trim()) && (mode === 'list' || mode === 'board'))) as Record<string, TaskPageViewMode>;
}

export function normalizeTaskExpandedIdsByProject(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([projectId, taskIds]) => Boolean(projectId.trim()) && Array.isArray(taskIds))
      .map(([projectId, taskIds]) => [projectId, [...new Set((taskIds as unknown[]).filter((taskId): taskId is string => typeof taskId === 'string' && Boolean(taskId.trim())))].slice(0, 500)]),
  );
}

export function normalizeCodeWorkspaceByProject(value: unknown): Record<string, ProjectCodeWorkspacePreference> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([projectId, preference]) => Boolean(projectId.trim()) && preference && typeof preference === 'object' && !Array.isArray(preference))
      .slice(0, 100)
      .map(([projectId, preference]) => {
        const raw = preference as Partial<ProjectCodeWorkspacePreference>;
        const normalizePaths = (paths: unknown, limit: number) =>
          Array.isArray(paths)
            ? [
                ...new Set(
                  paths
                    .filter((path): path is string => typeof path === 'string')
                    .map((path) => path.trim().replaceAll('\\', '/'))
                    .filter((path) => Boolean(path) && !path.startsWith('/') && !path.split('/').includes('..') && !path.split('/').includes('.git')),
                ),
              ].slice(0, limit)
            : [];
        const openFiles = normalizePaths(raw.openFiles, 20);
        const activeFile = typeof raw.activeFile === 'string' && normalizePaths([raw.activeFile], 1).length === 1 ? raw.activeFile : null;
        const expandedDirectories = normalizePaths(raw.expandedDirectories, 200);
        const treeWidth = Math.max(200, Math.min(420, Math.round(typeof raw.treeWidth === 'number' && Number.isFinite(raw.treeWidth) ? raw.treeWidth : 260)));
        return [projectId.trim(), { openFiles, activeFile, expandedDirectories, treeWidth } satisfies ProjectCodeWorkspacePreference];
      }),
  );
}

export function normalizeRendererAppShellSettings(settings: AppShellSettings): AppShellSettings {
  const taskTableColumnsByProject = Object.fromEntries(
    Object.entries(settings.taskTableColumnsByProject ?? {})
      .filter(([projectId]) => Boolean(projectId.trim()))
      .map(([projectId, preferences]) => [projectId.trim(), normalizeTaskTableColumnPreferences(preferences)]),
  );
  const taskManagementStatusTemplate = normalizeTaskManagementStatusConfig(settings.taskManagementStatusTemplate, defaultTaskManagementStatusConfig);
  const taskManagementStatusByProject = Object.fromEntries(
    Object.entries(settings.taskManagementStatusByProject ?? {})
      .filter(([projectId]) => Boolean(projectId.trim()))
      .map(([projectId, config]) => [projectId.trim(), normalizeTaskManagementStatusConfig(config, taskManagementStatusTemplate)]),
  );
  return {
    ...settings,
    collapsedProjectIds: Array.isArray(settings.collapsedProjectIds) ? [...new Set(settings.collapsedProjectIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).map((id) => id.trim()))].slice(0, 100) : [],
    taskTableColumns: normalizeTaskTableColumnPreferences(settings.taskTableColumns),
    taskTableColumnsByProject,
    taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders(settings.taskTableEnumSortOrders),
    taskManagementStatusTemplate,
    taskManagementStatusByProject,
    taskStatusFilterByProject: normalizeTaskStatusFilterByProject(settings.taskStatusFilterByProject),
    taskViewModeByProject: normalizeTaskViewModeByProject(settings.taskViewModeByProject),
    taskPageViewByProject: normalizeTaskPageViewByProject(settings.taskPageViewByProject),
    taskExpandedIdsByProject: normalizeTaskExpandedIdsByProject(settings.taskExpandedIdsByProject),
    codeWorkspaceByProject: normalizeCodeWorkspaceByProject(settings.codeWorkspaceByProject),
  };
}

export function toAppShellSettingsSavePayload(settings: AppShellSettings, taskManagementStatusReplacements?: Record<string, Record<string, string>>): AppShellSettingsSavePayload {
  // 漏斗由独立局部请求保存，不放入通用整份快照，避免较早收集的设置回写旧筛选。
  const taskTableColumns = normalizeTaskTableColumnPreferences(settings.taskTableColumns);
  const taskTableColumnsByProject = Object.fromEntries(Object.entries(settings.taskTableColumnsByProject ?? {}).map(([projectId, preferences]) => [projectId, normalizeTaskTableColumnPreferences(preferences)]));
  const taskStatusFilterByProject = normalizeTaskStatusFilterByProject(settings.taskStatusFilterByProject);
  return {
    // 代理草稿随通用设置保存；其他偏好更新继续携带原值。
    networkProxy: settings.networkProxy,
    appLanguage: settings.appLanguage,
    appearance: settings.appearance,
    webviewDebugEnabled: settings.webviewDebugEnabled,
    developerModeEnabled: settings.developerModeEnabled,
    multiWindowEnabled: settings.multiWindowEnabled,
    backgroundModeEnabled: settings.backgroundModeEnabled,
    desktopNotificationsEnabled: settings.desktopNotificationsEnabled,
    openAtLoginEnabled: settings.openAtLoginEnabled,
    autoUpdateChannel: settings.autoUpdateChannel,
    defaultProjectId: settings.defaultProjectId,
    pinnedProjectIds: settings.pinnedProjectIds,
    collapsedProjectIds: settings.collapsedProjectIds,
    defaultModel: settings.defaultModel,
    defaultTaskTemplateId: settings.defaultTaskTemplateId,
    // 任务字段偏好属于本机 app shell 设置；任何通用设置保存都必须带上，避免后续保存把字段配置丢掉。
    taskTableColumns: {
      ...taskTableColumns,
      // 空对象是“恢复默认列宽”的显式协议；省略字段表示局部保存时继续沿用已存列宽。
      columnWidths: taskTableColumns.columnWidths ?? {},
    },
    taskTableColumnsByProject,
    taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders(settings.taskTableEnumSortOrders),
    taskManagementStatusTemplate: normalizeTaskManagementStatusConfig(settings.taskManagementStatusTemplate, defaultTaskManagementStatusConfig),
    taskManagementStatusByProject: Object.fromEntries(
      Object.entries(settings.taskManagementStatusByProject ?? {}).map(([projectId, config]) => [projectId, normalizeTaskManagementStatusConfig(config, resolveTaskManagementStatusConfig(settings))]),
    ),
    ...(taskManagementStatusReplacements && Object.keys(taskManagementStatusReplacements).length > 0 ? { taskManagementStatusReplacements } : {}),
    taskStatusFilterByProject,
    taskViewModeByProject: normalizeTaskViewModeByProject(settings.taskViewModeByProject),
    taskPageViewByProject: normalizeTaskPageViewByProject(settings.taskPageViewByProject),
    taskExpandedIdsByProject: normalizeTaskExpandedIdsByProject(settings.taskExpandedIdsByProject),
    codeWorkspaceByProject: normalizeCodeWorkspaceByProject(settings.codeWorkspaceByProject),
  };
}

export function resolveTaskTableColumnsForProject(settings: AppShellSettings, projectId: string | undefined): TaskTableColumnPreferences {
  if (projectId) {
    const projectPreferences = settings.taskTableColumnsByProject?.[projectId];
    if (projectPreferences) return normalizeTaskTableColumnPreferences(projectPreferences);
  }
  return normalizeTaskTableColumnPreferences(settings.taskTableColumns);
}

export function resolveTaskStatusFilterForProject(settings: AppShellSettings, projectId: string | undefined): TaskStatusFilter {
  if (!projectId) return 'unfinished';
  const filter = settings.taskStatusFilterByProject?.[projectId];
  if (filter === '' || filter === 'unfinished') return filter;
  return isTaskStatusFilter(filter) && resolveTaskManagementStatusConfig(settings, projectId).statuses.some((status) => status.id === filter) ? filter : 'unfinished';
}

export function taskTableColumnPreferencesEqual(left: TaskTableColumnPreferences, right: TaskTableColumnPreferences): boolean {
  return JSON.stringify(normalizeTaskTableColumnPreferences(left)) === JSON.stringify(normalizeTaskTableColumnPreferences(right));
}

export function resolveTaskTableColumnsSaveResponse(input: { currentSettings: AppShellSettings; savedSettings: AppShellSettings; requestId: number; latestRequestId: number }): AppShellSettings {
  const currentSettings = normalizeRendererAppShellSettings(input.currentSettings);
  if (input.requestId !== input.latestRequestId) return currentSettings;
  const savedSettings = normalizeRendererAppShellSettings(input.savedSettings);
  // 字段偏好保存只确认字段偏好本身；慢返回不能顺手回滚用户已修改的外观、置顶项目等 AppShell 设置。
  return {
    ...currentSettings,
    taskTableColumns: savedSettings.taskTableColumns,
    taskTableColumnsByProject: savedSettings.taskTableColumnsByProject,
    taskTableEnumSortOrders: savedSettings.taskTableEnumSortOrders,
    taskStatusFilterByProject: currentSettings.taskStatusFilterByProject,
    taskViewModeByProject: currentSettings.taskViewModeByProject,
    taskPageViewByProject: currentSettings.taskPageViewByProject,
    taskExpandedIdsByProject: currentSettings.taskExpandedIdsByProject,
    codeWorkspaceByProject: currentSettings.codeWorkspaceByProject,
  };
}

export function mergeAppShellSettingsSaveResponse(input: { currentSettings: AppShellSettings; savedSettings: AppShellSettings }): AppShellSettings {
  const currentSettings = normalizeRendererAppShellSettings(input.currentSettings);
  const savedSettings = normalizeRendererAppShellSettings(input.savedSettings);
  // 普通 AppShell 保存可能比字段偏好保存更晚返回；合并时固定保留当前最新字段列，避免旧 payload 把任务表配置回滚。
  return {
    ...savedSettings,
    // 漏斗单独排队保存；其他设置的较早响应不能回滚用户刚改的筛选。
    sidebarConversationFilters: currentSettings.sidebarConversationFilters,
    modelSetupStatus: currentSettings.modelSetupStatus,
    newProjectDefaultModelRef: currentSettings.newProjectDefaultModelRef,
    taskTableColumns: currentSettings.taskTableColumns,
    taskTableColumnsByProject: currentSettings.taskTableColumnsByProject,
    taskTableEnumSortOrders: currentSettings.taskTableEnumSortOrders,
    taskStatusFilterByProject: currentSettings.taskStatusFilterByProject,
    taskViewModeByProject: currentSettings.taskViewModeByProject,
    taskPageViewByProject: currentSettings.taskPageViewByProject,
    taskExpandedIdsByProject: currentSettings.taskExpandedIdsByProject,
    codeWorkspaceByProject: currentSettings.codeWorkspaceByProject,
  };
}

/** 应用语言只在一处翻译核心枚举值，避免中文界面继续漏出 plan、ready 等内部状态码。 */
export function getLanguageCopy(appLanguage: AppLanguage) {
  return languageCopy[appLanguage] ?? languageCopy['zh-CN'];
}

/** 数据导入导出状态存结构化事实，渲染时再按当前语言转成人话，避免切换语言后残留旧语言。 */
export function formatDataPortabilityStatus(status: DataPortabilityStatusState, copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['data']): string {
  if (status.kind === 'idle') return copy.notImportedExported;
  if (status.kind === 'exported') return copy.exported(status.target);
  return copy.imported(status.target, status.changedSettings.length > 0 ? status.changedSettings.join(', ') : copy.noSettingsChanged);
}

export function formatArchivedConversationDate(value: string, appLanguage: AppLanguage): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(appLanguage, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

/** Runtime 日志导出状态只存结构化事实，渲染时按当前语言输出，避免英文界面残留中文状态。 */
export function formatRuntimeLogExportStatus(status: RuntimeLogExportStatusState, copy: ReturnType<typeof getLanguageCopy>['sessionWorkspace']['runtimeDrawer']): string {
  if (status.kind === 'empty') return copy.logExportEmpty;
  if (status.kind === 'cancelled') return copy.logExportCancelled;
  if (status.kind === 'saved') return copy.logExportSaved(status.filePath);
  if (status.kind === 'failed') return copy.logExportFailed;
  return copy.logExportIdle;
}

/** Runtime 日志复制状态只存结构化事实，渲染时按当前语言输出，避免切换语言后保留旧状态字符串。 */
export function formatRuntimeLogCopyStatus(status: RuntimeLogCopyStatusState, copy: ReturnType<typeof getLanguageCopy>['sessionWorkspace']['runtimeDrawer']): string {
  if (status.kind === 'empty') return copy.logCopyEmpty;
  if (status.kind === 'copied') return copy.logCopySuccess;
  if (status.kind === 'failed') return copy.logCopyFailed;
  return copy.logCopyIdle;
}

export function formatReleasePresenceStatus(kind: 'signing' | 'notarization' | 'homebrewCask', status: ReleaseStatusSnapshot[typeof kind], copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  // 发布状态 label 是本机后端检测结果，渲染层按当前语言重建 UI 文案，避免英文界面漏出中文后端 label。
  if (kind === 'signing') return status.configured ? copy.releaseSigningConfigured : copy.releaseSigningWaiting;
  if (kind === 'notarization') return status.configured ? copy.releaseNotarizationConfigured : copy.releaseNotarizationWaiting;
  return status.configured ? copy.releaseCaskDetected : copy.releaseCaskWaiting;
}

export function formatReleaseAutoUpdateLabel(status: ReleaseStatusSnapshot['autoUpdate'], copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  return status.updateFeedConfigured ? copy.autoUpdateFeed(formatReleaseUpdateChannel(status.channel as ReleaseUpdateStatusSnapshot['channel'], copy), status.currentVersion) : copy.autoUpdateManual(status.currentVersion);
}

export function formatReleaseUpdateLabel(status: ReleaseUpdateStatusSnapshot, copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  if (status.status === 'up_to_date') return copy.updateStatusLabels.up_to_date(status.currentVersion);
  if (status.status === 'available') return copy.updateStatusLabels.available(status.latestVersion);
  return copy.updateStatusLabels.unavailable;
}

export function formatReleaseUpdateReason(status: ReleaseUpdateStatusSnapshot, copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  if (status.status === 'up_to_date') return copy.updateReasons.current;
  if (status.status === 'available' && !status.artifact) return copy.updateReasons.noArtifact;
  if (status.status === 'available') return status.automaticInstallEnabled ? copy.updateReasons.availableInstallable : copy.updateReasons.availableManual;
  return copy.updateReasons.unavailable;
}

export function formatReleaseUpdateChannel(channel: ReleaseUpdateStatusSnapshot['channel'], copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  // Release 更新渠道是结构化枚举，渲染时转换成人话；不要把 stable/preview 原样塞进设置页。
  return copy.updateChannelLabels[channel] ?? channel;
}

export function formatReleaseArtifactKind(kind: NonNullable<ReleaseUpdateStatusSnapshot['artifact']>['kind'], copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  // 安装包类型是发布 manifest 枚举；文件名继续保留真实扩展名，摘要文案按当前语言展示。
  return copy.artifactKindLabels[kind] ?? kind;
}

export function formatReleaseWaitingForItems(items: string[], copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  // release-core 的 waitingFor 是结构化英文键；已知键按当前语言展示，未知键保留原值方便排查真实发布依赖。
  const labels: Record<string, string> = copy.waitingForLabels;
  return items.map((item) => labels[item] ?? item).join(' · ');
}

/** Runtime 会话状态是 API/存储枚举，界面按当前语言格式化，不能把 running/orphan_detected 直接露给用户。 */
export function formatRuntimeSessionStatus(status: AiRuntimeSessionStatus, copy: ReturnType<typeof getLanguageCopy>['sessionWorkspace']['runtimeDrawer']): string {
  return copy.runtimeSessionStatusLabels[status] ?? status;
}

export function buildRuntimeSessionTaskDraft(session: Pick<AiRuntimeSession, 'command'>, appLanguage: AppLanguage): { title: string; instruction: string } {
  const copy = getLanguageCopy(appLanguage).sessionWorkspace.runtimeDrawer;
  return {
    // Runtime 会话生成任务时只把真实命令作为事实值带入，标题和说明必须跟随当前界面语言。
    title: copy.taskDraftTitle(session.command),
    instruction: copy.taskDraftInstruction,
  };
}

export function buildProjectDirectoryResolution(selectedPath: string | null | undefined, appLanguage: AppLanguage): { path: string | null; description: string } {
  const copy = getLanguageCopy(appLanguage).sidebar;
  if (selectedPath) return { path: selectedPath, description: copy.selectedRepositoryDescription };
  return { path: null, description: copy.cancelledRepositoryDescription };
}

export function buildTemplateTaskDraft(appLanguage: AppLanguage): { title: string; variables: { goal: string } } {
  const copy = getLanguageCopy(appLanguage).taskWorkspace;
  return {
    title: copy.templateTaskTitle,
    variables: { goal: copy.templateTaskGoal },
  };
}

export function buildDefaultTaskDraft(appLanguage: AppLanguage): { title: string; description: string } {
  const copy = getLanguageCopy(appLanguage).taskWorkspace;
  return {
    title: copy.defaultTaskTitle,
    description: copy.defaultTaskDescription,
  };
}

export function buildTaskCreateInitialForm(_appLanguage: AppLanguage): TaskCreateFormState {
  void _appLanguage;
  return {
    projectId: '',
    copiedFromTaskId: null,
    title: '',
    parentTaskId: null,
    taskType: '',
    description: '',
    defectCurrentState: '',
    defectExpectedOutcome: '',
    defectReproductionSteps: '',
    optimizationCurrentState: '',
    optimizationExpectedOutcome: '',
    priority: 'p3',
    tags: '',
    attachments: [],
  };
}

export function normalizeTaskCreateDraft(form: TaskCreateFormState, titleRequiredMessage: string, typeRequiredMessage: string): { draft: TaskCreateDraft } | { error: string } {
  const title = form.title.trim();
  if (!title) return { error: titleRequiredMessage };
  if (!form.taskType) return { error: typeRequiredMessage };
  const seenTags = new Set<string>();
  const tags = form.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => {
      if (!tag || seenTags.has(tag)) return false;
      seenTags.add(tag);
      return true;
    });
  return {
    draft: {
      title,
      parentTaskId: form.parentTaskId,
      taskType: form.taskType,
      description: form.description.trim(),
      defectCurrentState: form.defectCurrentState.trim(),
      defectExpectedOutcome: form.defectExpectedOutcome.trim(),
      defectReproductionSteps: form.defectReproductionSteps.trim(),
      optimizationCurrentState: form.optimizationCurrentState.trim(),
      optimizationExpectedOutcome: form.optimizationExpectedOutcome.trim(),
      priority: form.priority,
      tags,
      // 任务持久化只保存 Zeus 托管后的本机路径与元信息；data URL 预览只留在本次 UI 状态，避免把大图写入任务 JSON。
      attachments: form.attachments.map(toPersistedTaskAttachment),
    },
  };
}

export function taskHierarchyDepth(task: TaskRecord, tasks: readonly TaskRecord[]): number {
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  let depth = 1;
  let parentTaskId = task.parentTaskId ?? null;
  const visited = new Set<string>([task.id]);
  while (parentTaskId && !visited.has(parentTaskId)) {
    visited.add(parentTaskId);
    depth += 1;
    parentTaskId = taskById.get(parentTaskId)?.parentTaskId ?? null;
  }
  return depth;
}

export function taskSubtreeHeight(taskId: string, tasks: readonly TaskRecord[]): number {
  const children = tasks.filter((task) => task.parentTaskId === taskId);
  return children.length === 0 ? 1 : 1 + Math.max(...children.map((task) => taskSubtreeHeight(task.id, tasks)));
}

/** Runtime 适配器 ID 是真实配置值，界面只在已知内置适配器上转换成人话标签，未知 ID 保留原值方便排障。 */
export function formatRuntimeAdapterDisplayName(adapterId: string, adapters: AiRuntimeAdapterDescriptor[], copy: { codexCliDisplayName: string; genericShellDisplayName: string }): string {
  const displayName = adapters.find((adapter) => adapter.id === adapterId)?.displayName;
  // 只本地化 Zeus 内置 Generic shell 默认标签；如果后端或插件提供了自定义 displayName，保留真实值便于排障。
  if (adapterId === 'generic' && (!displayName || displayName === 'Generic shell')) return copy.genericShellDisplayName;
  return displayName ?? (adapterId === 'codex' ? copy.codexCliDisplayName : adapterId);
}

/** 旧 hash 只做兼容迁移；当前可见导航已经改为项目优先 source-list，不再保留三项顶层菜单数组。 */
export function normalizeMainNavTarget(hash: string | undefined): MainNavTarget {
  const target = hash?.replace(/^#/, '');
  if (!target) return 'conversations';
  if (target === 'dashboard' || target === 'tasks' || target === 'runtime' || target === 'conversations') return 'conversations';
  if (target === 'git-diff' || target === 'projects' || target === 'project-commands' || target.startsWith('project-code')) return 'projects';
  if (target === 'skills') return 'skills';
  if (target === 'automations') return 'automations';
  if (target === 'telegram' || target === 'settings' || target?.startsWith('settings-')) return 'settings';
  return 'conversations';
}

export function readCurrentMainNavTarget(): MainNavTarget {
  return typeof window === 'undefined' ? 'conversations' : normalizeMainNavTarget(window.location.hash);
}

export function readSettingsCategoryFromHash(): SettingsCategory | undefined {
  if (typeof window === 'undefined') return undefined;
  const target = window.location.hash.replace(/^#settings-/, '');
  if (target === 'telegram') {
    window.history.replaceState(null, '', '#settings-im');
    return 'im';
  }
  return SETTINGS_CATEGORIES.includes(target as SettingsCategory) ? (target as SettingsCategory) : undefined;
}

export function normalizeTaskRuntimeControlHandlerResult(result: TaskRuntimeControlHandlerResult): NormalizedTaskRuntimeControlHandlerResult {
  if ('snapshot' in result) {
    return {
      snapshot: result.snapshot,
      task: result.task,
      conversation: result.conversation,
      runtimeError: result.runtimeError,
    };
  }
  return { snapshot: result };
}

export function resolveTaskRuntimeActionRoute(action: 'run' | 'pause' | 'continue' | 'cancel' | 'retry'): 'model_push' | 'runtime_api' {
  return action === 'run' ? 'model_push' : 'runtime_api';
}

export function resolveTaskRuntimeConversationNavigation(action: 'run' | 'pause' | 'continue' | 'cancel' | 'retry', result: NormalizedTaskRuntimeControlHandlerResult): TaskRuntimeConversationNavigation | undefined {
  if (action !== 'run' && action !== 'continue') return undefined;
  if (action === 'continue' && !result.conversation) return undefined;
  const conversationTaskId = result.conversation?.taskId;
  const targetTask = result.task ?? (conversationTaskId ? result.snapshot.tasks.find((task) => task.id === conversationTaskId) : undefined);
  if (!targetTask) return undefined;
  return {
    task: targetTask,
    mainNavTarget: 'conversations',
    projectSection: 'sessions',
    hash: '#project-sessions',
  };
}

/** 首屏只打开一个真实工作区；预览或恢复态带有明确数据时进入对应入口，避免把所有内容铺成一页。 */
export function inferInitialMainNavTarget(props: {
  initialMainNavTarget?: LegacyMainNavTarget;
  initialTaskEvents?: TaskEventRecord[];
  initialGitDiff?: GitDiffSummary;
  initialGitConfirmation?: GitOperationConfirmation;
  initialRuntimeSessions?: AiRuntimeSession[];
  initialRuntimeStatus?: RuntimeStatusSnapshot;
  initialRuntimeLogs?: AiRuntimeLogEntry[];
  initialRuntimeAdapters?: AiRuntimeAdapterDescriptor[];
  initialRuntimeAdapterChecks?: Record<string, AiRuntimeAdapterStatus>;
  initialRuntimeSettings?: RuntimeSettings;
  initialRuntimeGenericShellCommand?: string;
  initialRuntimeConfirmation?: RuntimeOperationConfirmation;
  initialSecuritySecrets?: SecuritySecretsSnapshot;
  initialAppShellSettings?: AppShellSettings;
  initialReleaseStatus?: ReleaseStatusSnapshot;
  initialReleaseUpdateStatus?: ReleaseUpdateStatusSnapshot;
  initialSecurityAuditLogs?: SecurityAuditLogEntry[];
  initialLocalError?: LocalUiErrorSnapshot;
  initialProjectConfig?: ProjectConfig;
  initialProjectDatabaseSecret?: ProjectDatabaseSecretSnapshot;
  initialArchivedProjects?: ProjectRecord[];
  initialArchivedTasks?: TaskRecord[];
  initialTaskTemplates?: TaskTemplateRecord[];
  snapshot?: DashboardSnapshot;
}): MainNavTarget {
  if (props.initialMainNavTarget) return normalizeMainNavTarget(`#${props.initialMainNavTarget}`);
  if (typeof window !== 'undefined' && window.location.hash) return readCurrentMainNavTarget();
  if (props.initialSecuritySecrets || props.initialReleaseStatus || props.initialSecurityAuditLogs?.length || props.initialLocalError) return 'settings';
  if (props.initialProjectConfig || props.initialProjectDatabaseSecret || props.initialArchivedProjects?.length) return 'projects';
  if (props.initialGitDiff || props.initialGitConfirmation) return 'projects';
  if (
    props.initialTaskEvents?.length ||
    props.initialArchivedTasks?.length ||
    props.initialTaskTemplates?.length ||
    props.initialRuntimeStatus ||
    props.initialRuntimeSessions?.length ||
    props.initialRuntimeLogs?.length ||
    props.initialRuntimeAdapters?.length ||
    props.initialRuntimeSettings ||
    props.initialRuntimeGenericShellCommand ||
    props.initialRuntimeConfirmation ||
    (props.snapshot?.tasks.length ?? 0) > 0
  )
    return 'conversations';
  if (props.snapshot?.projects.length) return 'projects';
  return 'projects';
}

export function inferInitialProjectSection(props: {
  initialMainNavTarget?: LegacyMainNavTarget;
  initialTaskEvents?: TaskEventRecord[];
  initialTaskTemplates?: TaskTemplateRecord[];
  initialRuntimeStatus?: RuntimeStatusSnapshot;
  initialRuntimeSessions?: AiRuntimeSession[];
  initialRuntimeLogs?: AiRuntimeLogEntry[];
  initialRuntimeAdapters?: AiRuntimeAdapterDescriptor[];
  initialRuntimeSettings?: RuntimeSettings;
  initialRuntimeGenericShellCommand?: string;
  initialRuntimeConfirmation?: RuntimeOperationConfirmation;
  initialGitDiff?: GitDiffSummary;
  initialGitConfirmation?: GitOperationConfirmation;
  initialProjectConfig?: ProjectConfig;
  initialProjectDatabaseSecret?: ProjectDatabaseSecretSnapshot;
  initialArchivedProjects?: ProjectRecord[];
  snapshot?: DashboardSnapshot;
}): ProjectWorkspaceSection {
  if (typeof window !== 'undefined' && (window.location.hash === '#project-commands' || window.location.hash.startsWith('#project-code'))) return 'code';
  if (props.initialProjectConfig || props.initialProjectDatabaseSecret) return 'project-settings';
  if (props.initialMainNavTarget === 'tasks') return 'tasks';
  if (props.initialMainNavTarget === 'git-diff' || props.initialMainNavTarget === 'projects') return 'code';
  if (props.initialMainNavTarget === 'conversations' || props.initialMainNavTarget === 'runtime' || props.initialMainNavTarget === 'dashboard') return 'sessions';
  if (
    props.initialTaskEvents?.length ||
    props.initialTaskTemplates?.length ||
    props.initialRuntimeStatus ||
    props.initialRuntimeSessions?.length ||
    props.initialRuntimeLogs?.length ||
    props.initialRuntimeAdapters?.length ||
    props.initialRuntimeSettings ||
    props.initialRuntimeGenericShellCommand ||
    props.initialRuntimeConfirmation
  )
    return 'sessions';
  if (props.initialArchivedProjects?.length) return 'code';
  return 'tasks';
}

export function syncRecordFromSnapshot<T extends { id: string }>(current: T | undefined, records: T[]): T | undefined {
  return current ? (records.find((record) => record.id === current.id) ?? records[0]) : records[0];
}

export function selectCreatedProjectTask(snapshot: DashboardSnapshot, previousTaskIds: Set<string>, projectId: string): TaskRecord | undefined {
  return snapshot.tasks.find((task) => task.projectId === projectId && !previousTaskIds.has(task.id)) ?? snapshot.tasks.find((task) => task.projectId === projectId);
}

export function normalizeProjectLocalPath(localPath: string): string {
  const trimmed = localPath.trim();
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/u, '');
}

export interface ProjectCreateFormState {
  name: string;
  localPath: string;
}

export function defaultProjectNameFromLocalPath(localPath: string): string {
  const normalizedPath = normalizeProjectLocalPath(localPath);
  if (normalizedPath === '/') return 'Root';
  return normalizedPath.split('/').filter(Boolean).at(-1) ?? '';
}

export function dedupeProjectRecordsByLocalPath(projects: ProjectRecord[]): ProjectRecord[] {
  const seen = new Set<string>();
  const deduped: ProjectRecord[] = [];
  for (const project of projects) {
    const key = normalizeProjectLocalPath(project.localPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({ ...project, localPath: key });
  }
  return deduped;
}

export function orderProjectsByPinnedIds(projects: ProjectRecord[], pinnedProjectIds: string[]): ProjectRecord[] {
  if (pinnedProjectIds.length === 0) return projects;
  const pinnedRank = new Map(pinnedProjectIds.map((projectId, index) => [projectId, index]));
  return [...projects].sort((left, right) => {
    const leftRank = pinnedRank.get(left.id);
    const rightRank = pinnedRank.get(right.id);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return 0;
  });
}

export function TaskCreateFieldAttachments(props: {
  field: TaskCreateAttachmentField;
  attachments: TaskCreateAttachment[];
  copy: ReturnType<typeof getLanguageCopy>['taskWorkspace'];
  disabled: boolean;
  onRemove: (path: string) => void;
  onRestoreText: (attachment: TaskCreateAttachment) => void;
  onLoadPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
}) {
  const attachments = taskAttachmentsForField(props.attachments, props.field);
  if (attachments.length === 0) return null;
  return (
    <div className="task-create-field-attachments">
      <TaskAttachmentPreviewList
        attachments={attachments}
        mode="editable"
        disabled={props.disabled}
        onRemove={props.onRemove}
        onRestoreText={props.onRestoreText}
        onLoadPreview={props.onLoadPreview}
        onOpenAttachment={props.onOpenAttachment}
        copy={{
          imageLabel: props.copy.taskCreateImageAttachment,
          fileLabel: props.copy.taskCreateFileAttachment,
          openFileLabel: props.copy.taskCreateOpenAttachment,
          removeLabel: props.copy.taskCreateRemoveAttachment,
          openPreviewLabel: props.copy.taskCreatePreviewAttachment,
          closePreviewLabel: props.copy.taskCreatePreviewClose,
          previewLoading: props.copy.taskCreatePreviewLoading,
          previewUnavailable: props.copy.taskCreatePreviewUnavailable,
          previewLoadFailed: props.copy.taskCreatePreviewLoadFailed,
          retryPreviewLabel: props.copy.taskCreatePreviewRetry,
          localPathLabel: props.copy.taskCreateLocalPathLabel,
          addedStatus: props.copy.taskCreateAttachmentAddedStatus,
        }}
      />
    </div>
  );
}

/** 创建和复制共用内容表单，第三方读取完成后回到草稿确认。 */
export function TaskCreateModal(props: {
  open: boolean;
  /** 复制任务可选择目标项目；新建任务沿用打开时的项目。 */
  projects: ProjectRecord[];
  /** 切换项目时由上层解除原项目的父任务选择。 */
  onProjectChange: (projectId: string) => void;
  copy: ReturnType<typeof getLanguageCopy>['taskWorkspace'];
  form: TaskCreateFormState;
  error?: string;
  busy: boolean;
  titleInputRef: RefObject<HTMLInputElement | null>;
  parentTasks: TaskRecord[];
  onFormChange: (field: TaskCreateTextField, value: string) => void;
  onTaskTypeChange: (taskType: TaskType | '') => void;
  onPriorityChange: (priority: TaskPriority) => void;
  onParentChange: (parentTaskId: string | null) => void;
  onAuthorizeFiles: (files: File[], source: 'paste' | 'drop') => Promise<TaskResourceAuthorizationResult>;
  onMaterializeResources: (resources: TaskResourcePayload[]) => Promise<TaskCreateAttachmentCandidate[]>;
  onReadClipboardResources: () => Promise<{ resources: TaskCreateAttachmentCandidate[]; text: string }>;
  onParseThirdPartyLink: (url: string) => Promise<ThirdPartyTaskExtract>;
  onApplyThirdPartyTaskInfo: (info: ThirdPartyTaskExtract) => void;
  onOpenThirdPartyLink: (url: string) => Promise<boolean>;
  onAddAttachments: (attachments: TaskCreateAttachment[]) => void;
  onLoadAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
  onRemoveAttachment: (path: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  /** 视觉退出期间立即注销旧附件和外部资料回执。 */
  const interactionOpen = usePresenceOpen() && props.open;
  const pasteShortcutFallbackTokenRef = useRef(0);
  const [resourceProcessingCount, setResourceProcessingCount] = useState(0);
  /** 附加设置由底部操作栏展开，默认不占正文空间。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 展开后定位附加字段，长表单中也能直接编辑。 */
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  /** 第三方导入独占当前步骤，避免链接读取与任务编辑混在一起。 */
  const [thirdPartyOpen, setThirdPartyOpen] = useState(false);
  /** 当前草稿的第三方来源链接。 */
  const [thirdPartyLinkInput, setThirdPartyLinkInput] = useState('');
  /** 读取期间锁定草稿，避免提交或编辑与异步回填竞争。 */
  const [thirdPartyParsing, setThirdPartyParsing] = useState(false);
  /** 读取结果和可恢复的登录入口。 */
  const [thirdPartyHint, setThirdPartyHint] = useState<{ tone: 'ok' | 'error'; text: string; openUrl?: string } | null>(null);
  /** 仅当前弹窗的请求可回填；关闭、重开和卸载都会使旧请求失效。 */
  const thirdPartyRequestRef = useRef<symbol | null>(null);
  const taskTypeOptions = useMemo(() => [{ value: '' as const, label: props.copy.taskCreateTypePlaceholder, disabled: true }, ...props.copy.taskCreateTypeOptions], [props.copy.taskCreateTypeOptions, props.copy.taskCreateTypePlaceholder]);
  useEffect(() => {
    if (interactionOpen) {
      setSettingsOpen(false);
      setThirdPartyOpen(false);
      setThirdPartyLinkInput('');
      setThirdPartyParsing(false);
      setThirdPartyHint(null);
    }
    return () => {
      thirdPartyRequestRef.current = null;
      pasteShortcutFallbackTokenRef.current += 1;
    };
  }, [interactionOpen]);
  /** 用户展开设置后滚到字段区，并让键盘从优先级开始操作。 */
  useEffect(() => {
    if (!settingsOpen) return;
    settingsPanelRef.current?.scrollIntoView({ block: 'nearest' });
    settingsPanelRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [settingsOpen]);
  /** 从导入步骤返回后，键盘可直接核对或继续填写任务标题。 */
  useEffect(() => {
    if (interactionOpen && !thirdPartyOpen) props.titleInputRef.current?.focus();
  }, [interactionOpen, thirdPartyOpen, props.titleInputRef]);
  if (!props.open) return null;
  const describedBy = thirdPartyOpen ? 'task-create-third-party-help' : props.error ? 'task-create-error' : undefined;
  const resourcesBusy = resourceProcessingCount > 0;
  /** 附件处理只阻止提交和切换任务结构，不禁用正在输入的文字框。 */
  const textInputDisabled = props.busy || thirdPartyParsing;
  const interactionBusy = textInputDisabled || resourcesBusy;

  function handleTaskCreateModalKeyDown(event: ReactKeyboardEvent<HTMLFormElement>): void {
    handleTaskCreatePasteShortcutFallback(event);
  }

  function handleTaskCreatePasteShortcutFallback(event: ReactKeyboardEvent<HTMLFormElement>): void {
    const pasteTarget = resolveTaskCreatePasteField(event.target);
    if (!pasteTarget || interactionBusy || typeof window === 'undefined') return;
    if (event.key.toLowerCase() !== 'v' || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
    const fallbackToken = pasteShortcutFallbackTokenRef.current + 1;
    pasteShortcutFallbackTokenRef.current = fallbackToken;
    const restoreTarget = captureTaskAttachmentRestoreTarget(pasteTarget.field, pasteTarget.control);
    // Finder / Paste.app 复制本地图片文件时，Electron 有时不会给 textarea 派发 DOM paste 事件；
    // 这里不阻止默认粘贴，只在短暂等待后发现 paste 事件没有到达时，让 Main 读取统一的文件、目录、图片或长文本资源。
    window.setTimeout(() => {
      if (pasteShortcutFallbackTokenRef.current !== fallbackToken) return;
      void runTaskResourceOperation(async () => {
        const result = await props.onReadClipboardResources();
        if (pasteShortcutFallbackTokenRef.current !== fallbackToken) return;
        if (result.resources.length > 0) {
          props.onAddAttachments(withTaskAttachmentRestoreTarget(result.resources, restoreTarget));
        } else if (result.text) {
          insertTaskCreatePlainTextPaste(pasteTarget.field, pasteTarget.control, result.text);
        }
        if (pasteShortcutFallbackTokenRef.current === fallbackToken) {
          pasteShortcutFallbackTokenRef.current += 1;
        }
      }).catch(() => {
        if (pasteShortcutFallbackTokenRef.current === fallbackToken) {
          pasteShortcutFallbackTokenRef.current += 1;
        }
      });
    }, 120);
  }

  async function runTaskResourceOperation(operation: () => Promise<void>): Promise<void> {
    /** 保留粘贴来源字段的焦点，附件回填不改变用户选区。 */
    const restoreFocus = retainInputFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setResourceProcessingCount((current) => current + 1);
    try {
      await operation();
    } finally {
      setResourceProcessingCount((current) => Math.max(0, current - 1));
      restoreFocus();
    }
  }

  /** 读取一次完整链接，只有当前草稿仍持有该请求时才填入。 */
  async function handleThirdPartyLinkParse(rawUrl: string): Promise<void> {
    /** 保留用户输入供失败后核对和重试。 */
    const url = rawUrl.trim();
    if (!url || interactionBusy || thirdPartyRequestRef.current) return;
    /** 同步占用请求身份，阻止同一轮事件内的重复解析。 */
    const request = Symbol();
    thirdPartyRequestRef.current = request;
    setThirdPartyOpen(true);
    setThirdPartyParsing(true);
    setThirdPartyHint(null);
    try {
      /** 来源详情通过主进程校验后才允许进入草稿。 */
      const result = await props.onParseThirdPartyLink(url);
      if (thirdPartyRequestRef.current !== request) return;
      if (result.kind === 'ok') {
        props.onApplyThirdPartyTaskInfo(result);
        setThirdPartyHint({ tone: 'ok', text: props.copy.taskCreateThirdPartyApplied(result.title || result.objectId, result.provider, result.attachments.length, result.attachmentFailedCount) });
        setThirdPartyOpen(false);
      } else if (result.kind === 'login_required') {
        setThirdPartyHint({ tone: 'error', text: props.copy.taskCreateThirdPartyLoginRequired, openUrl: result.sourceUrl });
      } else if (result.kind === 'unsupported') {
        setThirdPartyHint({ tone: 'error', text: props.copy.taskCreateThirdPartyUnsupported });
      } else if (result.kind === 'failed' && result.cause === 'credential_missing') {
        setThirdPartyHint({ tone: 'error', text: props.copy.taskCreateThirdPartyCredentialMissing, openUrl: result.sourceUrl });
      } else if (result.kind === 'failed' && result.cause === 'auth_failed') {
        setThirdPartyHint({ tone: 'error', text: props.copy.taskCreateThirdPartyAuthFailed, openUrl: result.sourceUrl });
      } else {
        setThirdPartyHint({ tone: 'error', text: props.copy.taskCreateThirdPartyFailed(result.reason), ...(result.reason === 'not_found_or_no_access' || result.reason === 'invalid_response' ? { openUrl: result.sourceUrl } : {}) });
      }
    } catch {
      if (thirdPartyRequestRef.current === request) setThirdPartyHint({ tone: 'error', text: props.copy.taskCreateThirdPartyFailed() });
    } finally {
      if (thirdPartyRequestRef.current === request) {
        thirdPartyRequestRef.current = null;
        setThirdPartyParsing(false);
      }
    }
  }

  /** 返回手动填写时注销读取回执，保留链接与草稿，避免迟到结果覆盖编辑。 */
  function handleThirdPartyBack(): void {
    thirdPartyRequestRef.current = null;
    setThirdPartyParsing(false);
    setThirdPartyHint(null);
    setThirdPartyOpen(false);
  }

  /** 打开失败要留在当前草稿明确提示，不能让登录按钮静默失效。 */
  async function handleThirdPartyLogin(url: string): Promise<void> {
    try {
      if (await props.onOpenThirdPartyLink(url)) return;
    } catch {
      // 主进程不可用或窗口加载失败时使用相同的可恢复提示。
    }
    setThirdPartyHint({ tone: 'error', text: props.copy.taskCreateThirdPartyOpenFailed, openUrl: url });
  }

  async function handleTaskCreateClipboardPaste(event: ReactClipboardEvent<HTMLFormElement>): Promise<void> {
    // 标题栏直接粘贴第三方详情链接时，自动转入链接读取。
    if (!interactionBusy && event.target instanceof HTMLInputElement && event.target.id === 'task-create-title-input') {
      const pastedLink = extractThirdPartyTaskLink(safelyReadClipboardData(event.clipboardData, 'text/plain'));
      if (pastedLink) {
        event.preventDefault();
        pasteShortcutFallbackTokenRef.current += 1;
        setThirdPartyLinkInput(pastedLink);
        void handleThirdPartyLinkParse(pastedLink);
        return;
      }
    }
    const pasteTarget = resolveTaskCreatePasteField(event.target);
    if (!pasteTarget || interactionBusy) return;
    pasteShortcutFallbackTokenRef.current += 1;
    const restoreTarget = captureTaskAttachmentRestoreTarget(pasteTarget.field, pasteTarget.control);
    const plainText = safelyReadClipboardData(event.clipboardData, 'text/plain');
    const pastedFiles = taskCreateDataTransferFiles(event.clipboardData);
    event.preventDefault();
    await runTaskResourceOperation(async () => {
      const nativeResult = await props.onReadClipboardResources();
      if (nativeResult.resources.length > 0) {
        props.onAddAttachments(withTaskAttachmentRestoreTarget(nativeResult.resources, restoreTarget));
        return;
      }
      if (pastedFiles.length > 0) {
        const result = await props.onAuthorizeFiles(pastedFiles, 'paste');
        if (result.resources.length > 0) props.onAddAttachments(withTaskAttachmentField(result.resources, pasteTarget.field));
        return;
      }
      const text = nativeResult.text || plainText;
      if (text.length >= PENDING_RESOURCE_LONG_TEXT_THRESHOLD) {
        const resources = await props.onMaterializeResources([{ name: 'Pasted text.txt', type: 'text/plain', text, kind: 'pasted_text' }]);
        if (resources.length > 0) {
          props.onAddAttachments(withTaskAttachmentRestoreTarget(resources, restoreTarget));
          return;
        }
      }
      insertTaskCreatePlainTextPaste(pasteTarget.field, pasteTarget.control, text);
    });
  }

  function restoreTaskCreateText(attachment: TaskCreateAttachment): void {
    if (!attachment.restorableText || interactionBusy) return;
    const defaultRestoreField = activeTaskCreateContentField(props.form.taskType);
    const restoreTarget = attachment.restoreTarget ?? {
      field: defaultRestoreField,
      start: props.form[defaultRestoreField].length,
      end: props.form[defaultRestoreField].length,
    };
    const currentValue = props.form[restoreTarget.field];
    const start = Math.min(restoreTarget.start, currentValue.length);
    const end = Math.min(Math.max(start, restoreTarget.end), currentValue.length);
    const nextValue = `${currentValue.slice(0, start)}${attachment.restorableText}${currentValue.slice(end)}`;
    const nextCaretPosition = start + attachment.restorableText.length;
    props.onFormChange(restoreTarget.field, nextValue);
    props.onRemoveAttachment(attachment.path);
    window.requestAnimationFrame(() => {
      const control = document.getElementById(taskCreateControlId(restoreTarget.field));
      if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement)) return;
      control.focus();
      control.setSelectionRange(nextCaretPosition, nextCaretPosition);
    });
  }

  function insertTaskCreatePlainTextPaste(field: TaskCreateTextField, control: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    if (!text) return;
    const selectionStart = control.selectionStart ?? control.value.length;
    const selectionEnd = control.selectionEnd ?? selectionStart;
    const nextValue = `${control.value.slice(0, selectionStart)}${text}${control.value.slice(selectionEnd)}`;
    const nextCaretPosition = selectionStart + text.length;
    props.onFormChange(field, nextValue);
    // 文字粘贴被我们拦截后手动回填；下一帧恢复光标，避免用户继续输入时跳到末尾。
    window.requestAnimationFrame(() => control.setSelectionRange(nextCaretPosition, nextCaretPosition));
  }

  const modalSurface = (
    <ModalPortal rootClassName="task-create-modal-portal-root" backdropClassName="task-create-modal-backdrop" dismissDisabled={interactionBusy} onDismiss={props.onClose}>
      <form
        className="task-create-modal zeus-solid-form-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-create-modal-title"
        aria-describedby={describedBy}
        onPaste={handleTaskCreateClipboardPaste}
        onSubmit={(event) => {
          if (thirdPartyOpen) {
            event.preventDefault();
            void handleThirdPartyLinkParse(thirdPartyLinkInput);
            return;
          }
          if (interactionBusy) {
            event.preventDefault();
            return;
          }
          props.onSubmit(event);
        }}
        onKeyDown={handleTaskCreateModalKeyDown}
      >
        <header className="task-create-modal-header">
          <strong id="task-create-modal-title" className="task-create-modal-heading">
            {thirdPartyOpen ? props.copy.taskCreateThirdPartyLinkLabel : props.form.copiedFromTaskId ? (props.copy.taskCountPrefix === 'Tasks' ? 'Copy task' : '复制任务') : props.copy.taskCreateDialogTitle}
          </strong>
          <div className="task-create-modal-header-actions">
            {!thirdPartyOpen ? (
              <Button
                variant="secondary"
                size="compact"
                onClick={() => {
                  setThirdPartyHint(null);
                  setThirdPartyOpen(true);
                }}
                disabled={interactionBusy}
              >
                {props.copy.taskCreateThirdPartyLinkLabel}
              </Button>
            ) : null}
            <button type="button" className="task-create-modal-close" aria-label={props.copy.taskCreateClose} onClick={props.onClose} disabled={interactionBusy}>
              ×
            </button>
          </div>
        </header>
        <div className="task-create-modal-body">
          {thirdPartyOpen ? (
            <div id="task-create-third-party-panel" className="task-create-field task-create-third-party-field">
              <span id="task-create-third-party-label">{props.copy.taskCreateThirdPartyUrlLabel}</span>
              <input
                autoFocus
                id="task-create-third-party-input"
                className="task-create-title-input task-create-third-party-input"
                value={thirdPartyLinkInput}
                placeholder={props.copy.taskCreateThirdPartyLinkPlaceholder}
                aria-labelledby="task-create-third-party-label"
                aria-describedby="task-create-third-party-help task-create-third-party-feedback"
                aria-invalid={thirdPartyHint?.tone === 'error' ? true : undefined}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setThirdPartyLinkInput(event.currentTarget.value);
                  setThirdPartyHint(null);
                }}
                onPaste={(event) => {
                  /** 仅粘贴完整链接才自动读取，逐字输入由按钮或回车确认。 */
                  const pastedLink = extractThirdPartyTaskLink(safelyReadClipboardData(event.clipboardData, 'text/plain'));
                  if (!pastedLink || interactionBusy) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setThirdPartyLinkInput(pastedLink);
                  void handleThirdPartyLinkParse(pastedLink);
                }}
                disabled={interactionBusy}
              />
              <small id="task-create-third-party-help" className="task-create-third-party-hint">
                {props.copy.taskCreateThirdPartyLinkHelp}
              </small>
              <small id="task-create-third-party-feedback" className={`task-create-third-party-hint${thirdPartyHint ? ` task-create-third-party-hint-${thirdPartyHint.tone}` : ''}`} role="status">
                {thirdPartyHint
                  ? [
                      thirdPartyHint.text,
                      thirdPartyHint.openUrl ? (
                        <button key="open" type="button" className="task-create-third-party-open-button" onClick={() => void handleThirdPartyLogin(thirdPartyHint.openUrl as string)} disabled={interactionBusy}>
                          {props.copy.taskCreateThirdPartyOpenLink}
                        </button>
                      ) : null,
                    ]
                  : thirdPartyParsing
                    ? props.copy.taskCreateThirdPartyParsing
                    : null}
              </small>
            </div>
          ) : (
            <>
              {thirdPartyHint?.tone === 'ok' ? (
                <small className="task-create-third-party-hint task-create-third-party-hint-ok" role="status">
                  {thirdPartyHint.text}
                </small>
              ) : null}
              {props.form.copiedFromTaskId ? (
                <>
                  <p className="task-flow-context">
                    {props.copy.taskCountPrefix === 'Tasks' ? 'Copy content, tags and attachments into a new task. History and relationships stay with the original.' : '复制正文、标签和附件为新任务，原任务的执行历史和任务关系保留在原处。'}
                  </p>
                  <label className="task-create-field">
                    <span>{props.copy.taskCountPrefix === 'Tasks' ? 'Target project' : '目标项目'}</span>
                    <select value={props.form.projectId} onChange={(event) => props.onProjectChange(event.currentTarget.value)} disabled={interactionBusy} required>
                      {props.projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
              <div className="task-create-field task-create-title-field">
                <span id="task-create-title-label">{props.copy.taskCreateTitleLabel}</span>
                <input
                  ref={props.titleInputRef}
                  id="task-create-title-input"
                  className="task-create-title-input"
                  value={props.form.title}
                  placeholder={props.copy.taskCreateTitlePlaceholder}
                  aria-labelledby="task-create-title-label"
                  aria-invalid={props.error ? true : undefined}
                  aria-describedby={props.error ? 'task-create-error' : undefined}
                  onChange={(event) => props.onFormChange('title', event.currentTarget.value)}
                  disabled={textInputDisabled}
                />
              </div>
              <div className="task-create-two-column-row">
                <div className="task-create-field task-create-type-field">
                  <span id="task-create-type-label">{props.copy.taskCreateTypeLabel}</span>
                  <ZeusSelect
                    size="regular"
                    className="task-create-type-select"
                    ariaLabel={props.copy.taskCreateTypeLabel}
                    value={props.form.taskType}
                    options={taskTypeOptions}
                    onChange={props.onTaskTypeChange}
                    searchable={false}
                    disabled={interactionBusy}
                  />
                </div>
              </div>
              {props.form.taskType === 'requirement' ? (
                <div className="task-create-field task-create-description-field">
                  <span id="task-create-description-label">{props.copy.taskCreateDescriptionLabel}</span>
                  <TaskCreateFieldAttachments
                    field="description"
                    attachments={props.form.attachments}
                    copy={props.copy}
                    disabled={interactionBusy}
                    onRemove={props.onRemoveAttachment}
                    onRestoreText={restoreTaskCreateText}
                    onLoadPreview={props.onLoadAttachmentPreview}
                    onOpenAttachment={props.onOpenAttachment}
                  />
                  <textarea
                    id="task-create-description-input"
                    className="task-create-description-input"
                    value={props.form.description}
                    placeholder={props.copy.taskCreateDescriptionPlaceholder}
                    aria-labelledby="task-create-description-label"
                    onChange={(event) => props.onFormChange('description', event.currentTarget.value)}
                    disabled={textInputDisabled}
                  />
                </div>
              ) : null}
              {props.form.taskType === 'defect' ? (
                <>
                  <div className="task-create-field task-create-description-field">
                    <span id="task-create-defect-current-state-label">{props.copy.taskCreateCurrentStateLabel}</span>
                    <TaskCreateFieldAttachments
                      field="defectCurrentState"
                      attachments={props.form.attachments}
                      copy={props.copy}
                      disabled={interactionBusy}
                      onRemove={props.onRemoveAttachment}
                      onRestoreText={restoreTaskCreateText}
                      onLoadPreview={props.onLoadAttachmentPreview}
                      onOpenAttachment={props.onOpenAttachment}
                    />
                    <textarea
                      id="task-create-defect-current-state-input"
                      className="task-create-description-input"
                      value={props.form.defectCurrentState}
                      placeholder={props.copy.taskCreateCurrentStatePlaceholder}
                      aria-labelledby="task-create-defect-current-state-label"
                      onChange={(event) => props.onFormChange('defectCurrentState', event.currentTarget.value)}
                      disabled={textInputDisabled}
                    />
                  </div>
                  <div className="task-create-field task-create-description-field">
                    <span id="task-create-defect-expected-outcome-label">{props.copy.taskCreateExpectedOutcomeLabel}</span>
                    <TaskCreateFieldAttachments
                      field="defectExpectedOutcome"
                      attachments={props.form.attachments}
                      copy={props.copy}
                      disabled={interactionBusy}
                      onRemove={props.onRemoveAttachment}
                      onRestoreText={restoreTaskCreateText}
                      onLoadPreview={props.onLoadAttachmentPreview}
                      onOpenAttachment={props.onOpenAttachment}
                    />
                    <textarea
                      id="task-create-defect-expected-outcome-input"
                      className="task-create-description-input"
                      value={props.form.defectExpectedOutcome}
                      placeholder={props.copy.taskCreateExpectedOutcomePlaceholder}
                      aria-labelledby="task-create-defect-expected-outcome-label"
                      onChange={(event) => props.onFormChange('defectExpectedOutcome', event.currentTarget.value)}
                      disabled={textInputDisabled}
                    />
                  </div>
                  <div className="task-create-field task-create-description-field">
                    <span id="task-create-defect-reproduction-steps-label">{props.copy.taskCreateReproductionStepsLabel}</span>
                    <TaskCreateFieldAttachments
                      field="defectReproductionSteps"
                      attachments={props.form.attachments}
                      copy={props.copy}
                      disabled={interactionBusy}
                      onRemove={props.onRemoveAttachment}
                      onRestoreText={restoreTaskCreateText}
                      onLoadPreview={props.onLoadAttachmentPreview}
                      onOpenAttachment={props.onOpenAttachment}
                    />
                    <textarea
                      id="task-create-defect-reproduction-steps-input"
                      className="task-create-description-input"
                      value={props.form.defectReproductionSteps}
                      placeholder={props.copy.taskCreateReproductionStepsPlaceholder}
                      aria-labelledby="task-create-defect-reproduction-steps-label"
                      onChange={(event) => props.onFormChange('defectReproductionSteps', event.currentTarget.value)}
                      disabled={textInputDisabled}
                    />
                  </div>
                </>
              ) : null}
              {props.form.taskType === 'optimization' ? (
                <>
                  <div className="task-create-field task-create-description-field">
                    <span id="task-create-optimization-current-state-label">{props.copy.taskCreateCurrentStateLabel}</span>
                    <TaskCreateFieldAttachments
                      field="optimizationCurrentState"
                      attachments={props.form.attachments}
                      copy={props.copy}
                      disabled={interactionBusy}
                      onRemove={props.onRemoveAttachment}
                      onRestoreText={restoreTaskCreateText}
                      onLoadPreview={props.onLoadAttachmentPreview}
                      onOpenAttachment={props.onOpenAttachment}
                    />
                    <textarea
                      id="task-create-optimization-current-state-input"
                      className="task-create-description-input"
                      value={props.form.optimizationCurrentState}
                      placeholder={props.copy.taskCreateCurrentStatePlaceholder}
                      aria-labelledby="task-create-optimization-current-state-label"
                      onChange={(event) => props.onFormChange('optimizationCurrentState', event.currentTarget.value)}
                      disabled={textInputDisabled}
                    />
                  </div>
                  <div className="task-create-field task-create-description-field">
                    <span id="task-create-optimization-expected-outcome-label">{props.copy.taskCreateExpectedOutcomeLabel}</span>
                    <TaskCreateFieldAttachments
                      field="optimizationExpectedOutcome"
                      attachments={props.form.attachments}
                      copy={props.copy}
                      disabled={interactionBusy}
                      onRemove={props.onRemoveAttachment}
                      onRestoreText={restoreTaskCreateText}
                      onLoadPreview={props.onLoadAttachmentPreview}
                      onOpenAttachment={props.onOpenAttachment}
                    />
                    <textarea
                      id="task-create-optimization-expected-outcome-input"
                      className="task-create-description-input"
                      value={props.form.optimizationExpectedOutcome}
                      placeholder={props.copy.taskCreateExpectedOutcomePlaceholder}
                      aria-labelledby="task-create-optimization-expected-outcome-label"
                      onChange={(event) => props.onFormChange('optimizationExpectedOutcome', event.currentTarget.value)}
                      disabled={textInputDisabled}
                    />
                  </div>
                </>
              ) : null}
              {settingsOpen ? (
                <div ref={settingsPanelRef} id="task-create-options" className="task-create-options">
                  <div className="task-create-field task-create-priority-field">
                    <span id="task-create-priority-label">{props.copy.taskCreatePriorityLabel}</span>
                    <ZeusSelect
                      size="regular"
                      className="task-create-priority-select"
                      ariaLabel={props.copy.taskCreatePriorityLabel}
                      value={props.form.priority}
                      options={props.copy.taskCreatePriorityOptions}
                      onChange={props.onPriorityChange}
                      searchable={false}
                      disabled={interactionBusy}
                    />
                  </div>
                  <div className="task-create-field task-create-parent-field">
                    <span>{props.copy.taskCountPrefix === 'Tasks' ? 'Parent task' : '父任务'}</span>
                    <ZeusSelect
                      size="regular"
                      ariaLabel={props.copy.taskCountPrefix === 'Tasks' ? 'Parent task' : '父任务'}
                      value={props.form.parentTaskId ?? ''}
                      options={[
                        { value: '', label: props.copy.taskCountPrefix === 'Tasks' ? 'No parent (root task)' : '无父任务（根任务）' },
                        ...props.parentTasks.map((task) => ({ value: task.id, label: `${task.taskCode ?? task.id} · ${task.title}` })),
                      ]}
                      onChange={(value) => props.onParentChange(value || null)}
                      searchPlaceholder={props.copy.selectSearchPlaceholder}
                      emptyLabel={props.copy.selectNoResults}
                      disabled={interactionBusy}
                    />
                  </div>
                  <div className="task-create-field task-create-tags-field">
                    <span id="task-create-tags-label">{props.copy.taskCreateTagsLabel}</span>
                    <TaskCreateFieldAttachments
                      field="tags"
                      attachments={props.form.attachments}
                      copy={props.copy}
                      disabled={interactionBusy}
                      onRemove={props.onRemoveAttachment}
                      onRestoreText={restoreTaskCreateText}
                      onLoadPreview={props.onLoadAttachmentPreview}
                      onOpenAttachment={props.onOpenAttachment}
                    />
                    <input
                      id="task-create-tags-input"
                      className="task-create-tags-input"
                      value={props.form.tags}
                      placeholder={props.copy.taskCreateTagsPlaceholder}
                      aria-labelledby="task-create-tags-label"
                      onChange={(event) => props.onFormChange('tags', event.currentTarget.value)}
                      disabled={textInputDisabled}
                    />
                  </div>
                </div>
              ) : null}
              {props.error ? (
                <p className="task-create-error" id="task-create-error" role="alert">
                  {props.error}
                </p>
              ) : null}
            </>
          )}
        </div>
        <footer className="task-create-modal-footer">
          {thirdPartyOpen ? (
            <>
              <Button variant="secondary" size="regular" onClick={handleThirdPartyBack} disabled={props.busy || resourcesBusy}>
                {props.copy.taskCreateThirdPartyBack}
              </Button>
              <Button type="submit" variant="primary" size="regular" busy={thirdPartyParsing} disabled={interactionBusy || !thirdPartyLinkInput.trim()}>
                {thirdPartyParsing ? props.copy.taskCreateThirdPartyParsing : props.copy.taskCreateThirdPartyParse}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="regular" className="task-create-cancel-button" onClick={props.onClose} disabled={interactionBusy}>
                {props.copy.taskCreateCancel}
              </Button>
              <Button variant="secondary" size="regular" className="task-create-settings-toggle" aria-expanded={settingsOpen} aria-controls="task-create-options" onClick={() => setSettingsOpen((open) => !open)} disabled={interactionBusy}>
                {props.copy.taskCreateMoreSettings}
              </Button>
              <Button type="submit" variant="primary" size="regular" className="task-create-submit-button" busy={props.busy} disabled={interactionBusy}>
                {props.busy ? props.copy.taskCreateSubmitting : props.copy.taskCreateSubmit}
              </Button>
            </>
          )}
        </footer>
      </form>
    </ModalPortal>
  );

  // ModalPortal 统一提升到 body；根节点必须透明，只允许语义 backdrop 绘制遮罩与虚化。
  return modalSurface;
}

export function TaskTableLayoutDecisionDialog(props: { open: boolean; title: string; description: string; busy?: boolean; actions: Array<{ id: string; label: string; variant?: ButtonVariant; onClick: () => void }>; onCancel: () => void }) {
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!props.open) return;
    const focusTimer = window.setTimeout(() => firstActionRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [props.open]);
  if (!props.open) return null;
  const surface = (
    <ModalPortal rootClassName="task-table-layout-dialog-portal" backdropClassName="task-create-modal-backdrop" dismissDisabled={props.busy} onDismiss={props.onCancel}>
      <section className="task-table-layout-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="task-table-layout-dialog-title" aria-describedby="task-table-layout-dialog-description" tabIndex={-1}>
        <header>
          <strong id="task-table-layout-dialog-title">{props.title}</strong>
          <p id="task-table-layout-dialog-description">{props.description}</p>
        </header>
        <footer>
          {props.actions.map((action, index) => (
            <Button ref={index === 0 ? firstActionRef : undefined} variant={action.variant} busy={props.busy} key={action.id} onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </footer>
      </section>
    </ModalPortal>
  );
  return surface;
}

export function TaskTerminalCleanupDialog(props: { confirmation: { statusLabel: string } | null; language: AppLanguage; onCancel: () => void; onConfirm: () => void }) {
  if (!props.confirmation) return null;
  const zh = props.language === 'zh-CN';
  const title = zh ? `清理工作现场并标记为“${props.confirmation.statusLabel}”？` : `Clean up the workspace and mark it “${props.confirmation.statusLabel}”?`;
  return (
    <ModalPortal rootClassName="task-terminal-cleanup-dialog-portal" backdropClassName="task-create-modal-backdrop" onDismiss={props.onCancel}>
      <section
        className="task-terminal-cleanup-dialog zeus-solid-form-surface"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="task-terminal-cleanup-dialog-title"
        aria-describedby="task-terminal-cleanup-dialog-description task-terminal-cleanup-dialog-effects task-terminal-cleanup-dialog-preserved"
      >
        <header>
          <span className="task-terminal-cleanup-dialog-icon" aria-hidden="true">
            <WarningCircle weight="fill" />
          </span>
          <span>
            <strong id="task-terminal-cleanup-dialog-title">{title}</strong>
            <p id="task-terminal-cleanup-dialog-description">{zh ? '这个任务还有未提交内容或活动会话。继续后，Zeus 会：' : 'This task still has local changes or active sessions. If you continue, Zeus will:'}</p>
          </span>
        </header>
        <ul id="task-terminal-cleanup-dialog-effects">
          <li>{zh ? '停止并归档关联会话；消息记录仍可查看。' : 'Stop and archive related sessions; their message history remains available.'}</li>
          <li>{zh ? '永久删除任务工作目录中的未提交和未跟踪文件。' : 'Permanently delete uncommitted and untracked files from the task workspace.'}</li>
        </ul>
        <p className="task-terminal-cleanup-dialog-preserved" id="task-terminal-cleanup-dialog-preserved">
          {zh ? '已提交的代码、任务分支和代码交付记录不会删除。' : 'Committed code, task branches, and delivery records will not be deleted.'}
        </p>
        <footer>
          <Button variant="secondary" onClick={props.onCancel}>
            {zh ? '先保留现场' : 'Keep workspace'}
          </Button>
          <Button variant="danger" onClick={props.onConfirm}>
            {zh ? `清理并标记为“${props.confirmation.statusLabel}”` : `Clean up and mark “${props.confirmation.statusLabel}”`}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

export function TaskDeleteRelationshipDialog(props: { task?: TaskRecord; allTasks: TaskRecord[]; busy: boolean; language: AppLanguage; onCancel: () => void; onConfirm: (input: DeleteTaskRequest) => void }) {
  const [strategy, setStrategy] = useState<NonNullable<DeleteTaskRequest['childStrategy']>>('make_roots');
  const [replacementParentTaskId, setReplacementParentTaskId] = useState('');
  useEffect(() => {
    setStrategy('make_roots');
    setReplacementParentTaskId('');
  }, [props.task?.id]);
  if (!props.task) return null;
  const zh = props.language === 'zh-CN';
  const directChildren = props.allTasks.filter((task) => task.parentTaskId === props.task?.id);
  const branchTaskIds = new Set<string>([props.task.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of props.allTasks) {
      if (task.parentTaskId && branchTaskIds.has(task.parentTaskId) && !branchTaskIds.has(task.id)) {
        branchTaskIds.add(task.id);
        changed = true;
      }
    }
  }
  const movedBranchHeight = directChildren.length === 0 ? 0 : Math.max(...directChildren.map((task) => taskSubtreeHeight(task.id, props.allTasks)));
  const replacementCandidates = props.allTasks.filter((task) => !branchTaskIds.has(task.id) && taskHierarchyDepth(task, props.allTasks) + movedBranchHeight <= 3);
  return (
    <ModalPortal rootClassName="task-delete-dialog-portal" backdropClassName="task-create-modal-backdrop" dismissDisabled={props.busy} onDismiss={props.onCancel}>
      <section className="task-delete-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="task-delete-dialog-title">
        <header>
          <strong id="task-delete-dialog-title">{zh ? `删除“${props.task.title}”` : `Delete “${props.task.title}”`}</strong>
          <p>
            {directChildren.length > 0
              ? zh
                ? `这个任务有 ${directChildren.length} 个直接子任务。请选择如何处理，原有下级结构会保持不变。`
                : `This task has ${directChildren.length} direct children. Choose how to handle them; the existing lower structure stays unchanged.`
              : zh
                ? '确认删除这个任务？它的普通关联会同时解除。'
                : 'Delete this task? Its ordinary relations will also be removed.'}
          </p>
        </header>
        {directChildren.length > 0 ? (
          <div className="task-delete-strategy-list">
            <label>
              <input type="radio" name="task-delete-strategy" checked={strategy === 'reparent'} onChange={() => setStrategy('reparent')} />
              <span>
                <strong>{zh ? '更换父任务' : 'Move under another parent'}</strong>
                <small>{zh ? '全部直接子任务连同各自下级结构一起移动。' : 'Move every direct child with its existing lower structure.'}</small>
              </span>
            </label>
            {strategy === 'reparent' ? (
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '选择新的父任务' : 'Choose the new parent task'}
                value={replacementParentTaskId}
                options={[{ value: '', label: zh ? '请选择新的父任务' : 'Select a replacement parent', disabled: true }, ...replacementCandidates.map((task) => ({ value: task.id, label: `${task.taskCode ?? task.id} · ${task.title}` }))]}
                onChange={setReplacementParentTaskId}
                disabled={props.busy || replacementCandidates.length === 0}
              />
            ) : null}
            <label>
              <input type="radio" name="task-delete-strategy" checked={strategy === 'delete_descendants'} onChange={() => setStrategy('delete_descendants')} />
              <span>
                <strong>{zh ? '全部跟随删除' : 'Delete the whole branch'}</strong>
                <small>{zh ? '当前任务和它下面的全部任务都会删除。' : 'Delete this task and every task below it.'}</small>
              </span>
            </label>
            <label>
              <input type="radio" name="task-delete-strategy" checked={strategy === 'make_roots'} onChange={() => setStrategy('make_roots')} />
              <span>
                <strong>{zh ? '全部保留为根任务' : 'Keep children as roots'}</strong>
                <small>{zh ? '只删除当前任务，直接子任务变为根任务。' : 'Delete only this task and make its direct children root tasks.'}</small>
              </span>
            </label>
          </div>
        ) : null}
        <footer>
          <Button variant="secondary" onClick={props.onCancel} disabled={props.busy}>
            {zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant="danger"
            busy={props.busy}
            disabled={directChildren.length > 0 && strategy === 'reparent' && !replacementParentTaskId}
            onClick={() => props.onConfirm(directChildren.length > 0 ? { childStrategy: strategy, ...(strategy === 'reparent' ? { replacementParentTaskId } : {}) } : {})}
          >
            {zh ? '确认删除' : 'Delete'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

export function TaskEnumOrderEditor<T extends string>(props: { title: string; description: string; language: AppLanguage; items: Array<{ value: T; label: string }>; onChange: (values: T[]) => void }) {
  const [draggedValue, setDraggedValue] = useState<T | null>(null);
  const moveItem = (value: T, targetIndex: number) => {
    const values = props.items.map((item) => item.value);
    const sourceIndex = values.indexOf(value);
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= values.length || sourceIndex === targetIndex) return;
    const nextValues = [...values];
    const [moved] = nextValues.splice(sourceIndex, 1);
    nextValues.splice(targetIndex, 0, moved);
    props.onChange(nextValues);
  };
  return (
    <section className="task-enum-order-editor" aria-label={props.title}>
      <header>
        <strong>{props.title}</strong>
        <small>{props.description}</small>
      </header>
      <ol>
        {props.items.map((item, index) => (
          <li
            key={item.value}
            className={draggedValue === item.value ? 'dragging' : undefined}
            onDragOver={(event) => {
              if (draggedValue) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedValue) moveItem(draggedValue, index);
              setDraggedValue(null);
            }}
          >
            <button
              type="button"
              className="task-enum-order-drag-handle"
              draggable
              aria-label={props.language === 'zh-CN' ? `拖动 ${item.label}` : `Drag ${item.label}`}
              title={props.language === 'zh-CN' ? '拖动调整顺序' : 'Drag to reorder'}
              onDragStart={(event) => {
                setDraggedValue(item.value);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.value);
              }}
              onDragEnd={() => setDraggedValue(null)}
            >
              <span aria-hidden="true">⋮⋮</span>
            </button>
            <span className="task-enum-order-rank">{index + 1}</span>
            <span className="task-enum-order-label">{item.label}</span>
            <span className="task-enum-order-actions">
              <button type="button" aria-label={props.language === 'zh-CN' ? `上移 ${item.label}` : `Move ${item.label} up`} disabled={index === 0} onClick={() => moveItem(item.value, index - 1)}>
                ↑
              </button>
              <button type="button" aria-label={props.language === 'zh-CN' ? `下移 ${item.label}` : `Move ${item.label} down`} disabled={index === props.items.length - 1} onClick={() => moveItem(item.value, index + 1)}>
                ↓
              </button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function safelyReadClipboardData(clipboardData: DataTransfer, type: string): string {
  try {
    return clipboardData.getData(type);
  } catch {
    return '';
  }
}

export function resolveTaskCreatePasteField(target: EventTarget): { field: TaskCreateAttachmentField; control: HTMLInputElement | HTMLTextAreaElement } | undefined {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return undefined;
  const fieldByControlId = new Map<TaskCreateAttachmentField, string>([
    ['description', 'task-create-description-input'],
    ['defectCurrentState', 'task-create-defect-current-state-input'],
    ['defectExpectedOutcome', 'task-create-defect-expected-outcome-input'],
    ['defectReproductionSteps', 'task-create-defect-reproduction-steps-input'],
    ['optimizationCurrentState', 'task-create-optimization-current-state-input'],
    ['optimizationExpectedOutcome', 'task-create-optimization-expected-outcome-input'],
    ['tags', 'task-create-tags-input'],
  ]);
  for (const [field, controlId] of fieldByControlId) {
    if (target.id === controlId) return { field, control: target };
  }
  return undefined;
}

export function captureTaskAttachmentRestoreTarget(field: TaskCreateAttachmentField, control: HTMLInputElement | HTMLTextAreaElement): TaskAttachmentRestoreTarget {
  const start = control.selectionStart ?? control.value.length;
  return {
    field,
    start,
    end: control.selectionEnd ?? start,
  };
}

export function withTaskAttachmentField(attachments: TaskCreateAttachmentCandidate[], field: TaskCreateAttachmentField): TaskCreateAttachment[] {
  return attachments.map((attachment) => ({ ...attachment, field }));
}

export function withTaskAttachmentRestoreTarget(attachments: TaskCreateAttachmentCandidate[], restoreTarget: TaskAttachmentRestoreTarget): TaskCreateAttachment[] {
  return attachments.map((attachment) => ({ ...attachment, field: restoreTarget.field, ...(attachment.restorableText ? { restoreTarget } : {}) }));
}

export function taskCreateDataTransferFiles(dataTransfer: DataTransfer): File[] {
  const candidates = [
    ...Array.from(dataTransfer.files),
    ...Array.from(dataTransfer.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null),
  ];
  const seen = new Set<string>();
  return candidates.filter((file) => {
    const fingerprint = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

export function taskCreateControlId(field: TaskCreateTextField): string {
  const controlIds: Record<TaskCreateTextField, string> = {
    title: 'task-create-title-input',
    description: 'task-create-description-input',
    defectCurrentState: 'task-create-defect-current-state-input',
    defectExpectedOutcome: 'task-create-defect-expected-outcome-input',
    defectReproductionSteps: 'task-create-defect-reproduction-steps-input',
    optimizationCurrentState: 'task-create-optimization-current-state-input',
    optimizationExpectedOutcome: 'task-create-optimization-expected-outcome-input',
    tags: 'task-create-tags-input',
  };
  return controlIds[field];
}

/** 未记录原粘贴位置时，把可恢复长文本放回当前类型的第一个正文栏。 */
export function activeTaskCreateContentField(taskType: TaskType | ''): Extract<TaskCreateTextField, 'description' | 'defectCurrentState' | 'optimizationCurrentState'> {
  if (taskType === 'defect') return 'defectCurrentState';
  if (taskType === 'optimization') return 'optimizationCurrentState';
  return 'description';
}

/** Codex macOS 风格纯色设置 pane：用标题、留白和控件边界分组，不再用灰度条带或横线切割内容。 */
export function NativeSettingsPane(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <section className={`native-settings-pane ${props.className ?? ''}`} aria-label={props.label}>
      {props.children}
    </section>
  );
}

/** Codex macOS 风格行：左侧保持标题与解释，右侧只放当前行的控件或状态。 */
export function NativeControlRow(props: { title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`native-control-row ${props.className ?? ''}`}>
      <span className="native-control-copy">
        <strong>{props.title}</strong>
        {props.description ? <span className="native-control-description">{props.description}</span> : null}
      </span>
      <span className="native-control-slot">{props.children}</span>
    </div>
  );
}

export function ProjectArchiveWorkbench(props: {
  projects: ProjectRecord[];
  copy: ReturnType<typeof getLanguageCopy>['codeWorkspace']['projectArchive'];
  codeCopy: ReturnType<typeof getLanguageCopy>['codeWorkspace'];
  onRefresh: () => void | Promise<void>;
  refreshDisabled: boolean;
  onRestore: (projectId: string) => void | Promise<void>;
}) {
  return (
    <section className="product-drawer-pane project-archive-workbench" aria-label={props.copy.aria}>
      {/* 归档项目只承担恢复工作流：顶部说明当前范围，列表行拆分项目身份与恢复动作，避免继续复用宽松旧卡片行。 */}
      <div className="project-archive-header">
        <span className="project-archive-copy">
          <strong>{props.copy.title}</strong>
          <small>{props.copy.count(props.projects.length)}</small>
        </span>
        <button type="button" onClick={() => void props.onRefresh()} disabled={props.refreshDisabled}>
          {props.copy.refresh}
        </button>
      </div>
      {props.projects.length === 0 ? (
        <div className="project-archive-empty-row" aria-label={props.copy.emptyAria}>
          <span className="project-archive-copy">
            <strong>{props.copy.emptyTitle}</strong>
            <small>{props.copy.emptyHelp}</small>
          </span>
        </div>
      ) : (
        <div className="project-archive-list" aria-label={props.copy.listAria}>
          {props.projects.map((project) => (
            <article className="project-archive-row" key={project.id}>
              <span className="project-archive-copy">
                <strong>{project.name}</strong>
                <small>{project.localPath}</small>
              </span>
              <span className="project-archive-command-rail">
                <button type="button" onClick={() => void props.onRestore(project.id)}>
                  {props.copy.restore}
                </button>
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export type LocalUiErrorSnapshot = {
  /** 保留可操作错误身份供统一错误出口使用。 */
  code?: string;
  action: string;
  message: string;
  occurredAt: string;
};

/** 为水平工具栏提供左右键、Home 和 End 焦点导航。 */
export const handleInlineRailKeyboardNavigation = (event: ReactKeyboardEvent<HTMLElement>) => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;

  const inlineRailItems = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-inline-rail-item="true"]:not([disabled])'));
  if (inlineRailItems.length === 0) return;

  // Decision rail 与二级菜单按 macOS toolbar 语义处理：Tab 进入，左右键在同一组动作内移动焦点。
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activeIndex = activeElement ? inlineRailItems.findIndex((item) => item === activeElement || item.contains(activeElement)) : -1;
  const currentIndex = activeIndex >= 0 ? activeIndex : 0;
  let nextIndex = currentIndex;

  if (event.key === 'ArrowRight') nextIndex = Math.min(currentIndex + 1, inlineRailItems.length - 1);
  if (event.key === 'ArrowLeft') nextIndex = Math.max(currentIndex - 1, 0);
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = inlineRailItems.length - 1;

  event.preventDefault();
  inlineRailItems[nextIndex]?.focus();
};

/** 为来源列表提供上下键与首尾项导航。 */
export const handleSourceListKeyboardNavigation = (event: ReactKeyboardEvent<HTMLElement>) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;

  const sourceListItems = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-source-list-item="true"]:not([disabled])'));
  if (sourceListItems.length === 0) return;

  // source-list 使用 roving focus：当前选中行保留 tabIndex=0，方向键只在列表内部移动焦点，不触发页面级滚动。
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activeIndex = activeElement ? sourceListItems.findIndex((item) => item === activeElement || item.contains(activeElement)) : -1;
  const rovingIndex = sourceListItems.findIndex((item) => item.getAttribute('tabindex') === '0');
  const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(rovingIndex, 0);
  let nextIndex = currentIndex;

  if (event.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, sourceListItems.length - 1);
  if (event.key === 'ArrowUp') nextIndex = Math.max(currentIndex - 1, 0);
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = sourceListItems.length - 1;

  event.preventDefault();
  sourceListItems[nextIndex]?.focus();
};
