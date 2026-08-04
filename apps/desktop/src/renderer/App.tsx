import {
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { FolderPlusIcon as FolderPlus } from '@phosphor-icons/react/dist/csr/FolderPlus';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { PushPinIcon as PushPin } from '@phosphor-icons/react/dist/csr/PushPin';
import { PushPinSlashIcon as PushPinSlash } from '@phosphor-icons/react/dist/csr/PushPinSlash';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import {
  buildMermaidDiagramExport,
  buildMermaidDiagramSource,
  buildPlantUmlDiagramExport,
  buildPlantUmlDiagramSource,
  type MermaidDiagramExportFile,
  type PlantUmlDiagramExportFile,
  toReactFlowElements,
  toSigmaGraph,
} from '@zeus/diagram-engine';
import { isTaskStatusFilter } from '@zeus/shared';
import '@xterm/xterm/css/xterm.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './session/session.css';
import './ui/primitives.css';
import { notifyMainAppShellSettingsChanged, openExternalHttpsUrlInMain } from './appShellBridge.js';
import { PENDING_RESOURCE_LONG_TEXT_THRESHOLD } from './ui/pendingResourcePolicy.js';
import { TaskAttachmentPreviewList } from './task/TaskAttachmentPreviewList.js';
import { type ConversationTreeRuntimeState, conversationTreeRuntimeStateFromSession, conversationTreeRuntimeStateFromSnapshot, type ProjectConversationGroup, ProjectConversationTree } from './session/ProjectConversationTree.js';
import {
  ConnectedSessionWorkspace,
  createNativeConversationStartEnvelopeManager,
  createProjectConversationStartEnvelopeManager,
  loadLegacyConversationDetail,
  nativeConversationChoiceFromAcceptance,
  type NativeConversationStartStorage,
  type ProjectSessionWorkspaceStartInput,
  SessionWorkspace,
  type SessionWorkspaceStartInput,
  type SessionWorkspaceTask,
  startNativeConversationWithDurableAcceptance,
  startProjectConversationWithDurableAcceptance,
} from './session/SessionWorkspace.js';
import type {
  CodexTaskPushCapabilities,
  NativeConversationAttachment,
  NativeConversationChoice,
  NativeConversationChoicesSnapshot,
  NativeConversationSnapshot,
  NativeProjectConversationChoicesSnapshot,
  NativeServiceTierSelection,
  NativeSessionState,
  SessionConversationOwner,
  StartTaskModelPushRequest,
} from './session/sessionTypes.js';
import { selectHasConfirmedUserMessage } from './session/sessionSelectors.js';
import { readProjectServiceTierPreference, serviceTierWireOverride, writeProjectServiceTierPreference } from './session/serviceTierSelection.js';
import type { SessionControllerClient } from './session/useSessionController.js';
import { TaskDetailPaneContent, type TaskEditResult } from './task/TaskDetailPaneContent.js';
import { TaskGitReviewModal } from './task/TaskGitReviewModal.js';
import { TaskGitMergeModal } from './task/TaskGitMergeModal.js';
import {
  buildTaskModelPushMessage,
  readTaskModelPushPreferences,
  resolveTaskModelPushInitialForm,
  type TaskModelPushForm,
  TaskModelPushModal,
  type TaskModelPushModalStatus,
  writeTaskModelPushPreferences,
} from './task/TaskModelPushModal.js';
import {
  acceptTaskModelPushPendingState,
  createTaskModelPushPendingState,
  failTaskModelPushPendingState,
  retryTaskModelPushPendingState,
  type TaskModelPushPendingState,
  TaskModelPushPendingWorkspace,
} from './task/TaskModelPushPendingWorkspace.js';
import { TaskWorkspace } from './task/TaskWorkspace.js';
import { LegacyChatImportSettings } from './settings/LegacyChatImportSettings.js';
import { BrowserSettingsPane } from './settings/BrowserSettingsPane.js';
import { type TaskAttachmentRestoreTarget, type TaskAttachmentView, toPersistedTaskAttachment } from './task/taskAttachments.js';
import {
  defaultTaskTableEnumSortOrders,
  filterVisibleTasks,
  normalizeTaskTableColumnPreferences,
  normalizeTaskTableEnumSortOrders,
  resolveTaskManagementStatus,
  taskAgentRunStatusFromSession,
  taskManagementStatuses,
} from './task/taskWorkspaceModel.js';
import { ZeusSelect } from './ZeusSelect.js';
import { Button, type ButtonVariant } from './ui/Button.js';
import { ModalPortal } from './ui/ModalPortal.js';
import { SourceListRow } from './ui/SourceListRow.js';
import { WorkspaceDrawer } from './ui/WorkspaceDrawer.js';
import { CommandCenterPanel } from './CommandCenterPanel.js';
import { ReleaseUpdateDialog, type ReleaseUpdateDialogState } from './release/ReleaseUpdateDialog.js';
import { ArchitectureGraphCanvas, buildArchitectureLayerModel } from './graph/ArchitectureGraphCanvas.js';
import {
  type AiRuntimeAdapterDescriptor,
  type AiRuntimeAdapterStatus,
  type AiRuntimeLogEntry,
  type AiRuntimeSession,
  type AiRuntimeSessionStatus,
  type AiRuntimeTerminalEvent,
  type AiRuntimeTerminalSnapshot,
  type AppShellSettings,
  type CodeMapSettings,
  type CodexLegacyImportResult,
  type CodexLegacyImportSnapshot,
  createEmptyDashboardSnapshot,
  type CreateProjectRequest,
  type DashboardClient,
  type DashboardSnapshot,
  type ExecutedGitOperationResult,
  type ExecuteGitOperationRequest,
  type GitDiffHunk,
  type GitDiffSummary,
  type GitOperationConfirmation,
  type GitPatchExport,
  type GraphConversationHistoryItem,
  type GraphConversationHistoryPage,
  type GraphNeighborhood,
  type GraphQuestionAnswer,
  type GraphSearchResult,
  type GraphViewSnapshot,
  type GraphViewType,
  type HighRiskGitOperation,
  type ImportLocalBusinessDataResult,
  type ImportLocalSettingsRequest,
  type ImportLocalSettingsResult,
  type LoadRuntimeSessionsRequest,
  type LocalBusinessDataSnapshot,
  type LocalSettingsExportSnapshot,
  type ProjectArchiveConfirmation,
  type ProjectConfig,
  type ProjectDatabaseSecretSnapshot,
  type ProjectRecord,
  type ProjectRepositoryDiscoverySnapshot,
  type ProjectWorkspaceConfigSnapshot,
  type ReleaseStatusSnapshot,
  type ReleaseUpdateOperationSnapshot,
  type ReleaseUpdateStatusSnapshot,
  type RuntimeOperationConfirmation,
  type RuntimeSettings,
  type RuntimeStatusSnapshot,
  type SaveProjectConfigRequest,
  type SecurityAuditLogEntry,
  type SecurityResetResult,
  type SecuritySecretsSnapshot,
  type SendConversationMessageResult,
  type TaskAgentRunStatus,
  type TaskEventRecord,
  type TaskManagementStatus,
  type TaskPriority,
  type TaskRecord,
  type TaskStatus,
  type TaskStatusFilter,
  type TaskTableColumnPreferences,
  type TaskTemplateRecord,
  type TelegramNotificationSettings,
  type TelegramPollingLogEntry,
  type TelegramPollingStatus,
  type TelegramSecuritySettings,
  type TelegramTestConnectionResult,
  type UpdateTaskRequest,
  ZeusApiError,
  type ZeusRealtimeEvent,
} from './apiClient.js';

export {
  buildMermaidDiagramExport,
  buildMermaidDiagramSource,
  buildPlantUmlDiagramExport,
  buildPlantUmlDiagramSource,
  toReactFlowElements,
  toSigmaGraph,
  type MermaidDiagramExportFile,
  type PlantUmlDiagramExportFile,
} from '@zeus/diagram-engine';

type MainNavTarget = 'projects' | 'conversations' | 'settings';
type LegacyMainNavTarget = MainNavTarget | 'dashboard' | 'tasks' | 'code-map' | 'runtime' | 'git-diff' | 'telegram' | 'settings-data';
type ProjectWorkspaceSection = 'tasks' | 'code' | 'sessions' | 'commands' | 'project-settings';
type ProjectDetailPanel = 'diff' | 'edit' | 'config' | 'archive' | undefined;
type ConversationDrawer = 'runtime' | 'context' | 'changes' | 'templates' | undefined;
type SettingsCategory = 'general' | 'tasks' | 'runtime' | 'browser' | 'telegram' | 'security' | 'commands' | 'git' | 'release' | 'data';
type DataPortabilityStatusState = { kind: 'idle' } | { kind: 'exported'; target: string } | { kind: 'imported'; target: string; changedSettings: string[] };
type TaskBulkActionStatusState = { kind: 'idle' | 'running' | 'done' | 'failed'; message?: string };
type RuntimeLogExportStatusState = { kind: 'idle' } | { kind: 'empty' } | { kind: 'cancelled' } | { kind: 'saved'; filePath: string } | { kind: 'failed' };
type RuntimeLogCopyStatusState = { kind: 'idle' } | { kind: 'empty' } | { kind: 'copied' } | { kind: 'failed' };
type RuntimeConfirmationStatusState =
  | { kind: 'idle' }
  | { kind: 'created'; confirmationId: string }
  | { kind: 'create_failed' }
  | { kind: 'reject_failed' }
  | { kind: 'rejected' }
  | { kind: 'critical_phrase_required' }
  | { kind: 'changed' }
  | { kind: 'consumed'; confirmationId: string }
  | { kind: 'failed' };
type WorkspaceViewId = MainNavTarget;
type InlineRecoveryAction = {
  label: string;
  onAction?: () => void;
  disabled?: boolean;
  busy?: boolean;
};
type ControlBusyProps = { 'aria-busy'?: true; 'data-loading'?: 'true' };
type TaskCreateAttachment = TaskAttachmentView;
type TaskCreateFormState = { title: string; description: string; priority: TaskPriority; tags: string; attachments: TaskCreateAttachment[] };
type TaskCreateTextField = Extract<keyof TaskCreateFormState, 'title' | 'description' | 'tags'>;
type TaskCreateDraft = { title: string; description: string; priority: TaskPriority; tags: string[]; attachments: ReturnType<typeof toPersistedTaskAttachment>[] };
type TaskResourcePayload = { name?: string; type?: string; data?: ArrayBuffer; text?: string; kind?: 'image' | 'file' | 'pasted_text' };
type TaskResourceAuthorizationResult = { resources: TaskCreateAttachment[]; failedCount: number };
type NativeConversationAppClient = SessionControllerClient &
  Pick<
    DashboardClient,
    | 'loadProjectConversationChoices'
    | 'startProjectConversation'
    | 'loadTaskConversationChoices'
    | 'startNativeConversation'
    | 'loadCodexTaskPushCapabilities'
    | 'startTaskModelPush'
    | 'loadProjectWorkspaceConfig'
    | 'discoverProjectRepositories'
    | 'saveProjectWorkspaceConfig'
    | 'acknowledgeNativeConversationCompletion'
    | 'loadTaskGitWorkspaces'
    | 'loadTaskWorkspaceFileDiff'
    | 'commitTaskWorkspace'
    | 'pushTaskWorkspace'
    | 'reclaimTaskWorkspace'
    | 'discardTaskWorkspace'
    | 'stopTaskWorkspaceSessions'
    | 'loadTaskIntegrations'
    | 'startTaskIntegration'
    | 'loadTaskIntegrationConflict'
    | 'resolveTaskIntegrationConflict'
    | 'assistTaskIntegrationConflict'
    | 'finalizeTaskIntegration'
  >;
type NativeConversationChoiceLoadState = 'empty' | 'loading' | 'ready' | 'error';

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
      const accepted = acceptedByTask.get(taskId);
      if (!accepted) return;
      accepted.delete(conversationId);
      if (accepted.size === 0) acceptedByTask.delete(taskId);
    },
    commit(taskId, requestVersion, snapshot) {
      if (!isCurrent(taskId, requestVersion)) return null;
      const loadedIds = new Set(snapshot.choices.map((choice) => choice.id));
      const preserved = [...(acceptedByTask.get(taskId)?.values() ?? [])].filter((choice) => !loadedIds.has(choice.id));
      const choices = [...preserved, ...snapshot.choices].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return {
        ...snapshot,
        hasHistory: choices.length > 0,
        requiresChoice: choices.length > 1,
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
    commit(projectId, requestVersion, snapshot) {
      if (!isCurrent(projectId, requestVersion) || snapshot.projectId !== projectId) return null;
      const loadedIds = new Set(snapshot.choices.map((choice) => choice.id));
      const preserved = [...(acceptedByProject.get(projectId)?.values() ?? [])].filter((choice) => !loadedIds.has(choice.id));
      const choices = [...preserved, ...snapshot.choices].filter((choice) => choice.projectId === projectId && choice.taskId === null).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { projectId, choices, items: choices };
    },
  };
}

export type TaskRuntimeControlHandlerResult =
  | DashboardSnapshot
  | {
      snapshot: DashboardSnapshot;
      task?: TaskRecord;
      conversation?: GraphConversationHistoryItem;
      runtimeError?: { message: string };
    };
export type NormalizedTaskRuntimeControlHandlerResult = {
  snapshot: DashboardSnapshot;
  task?: TaskRecord;
  conversation?: GraphConversationHistoryItem;
  runtimeError?: { message: string };
};
export type TaskRuntimeConversationNavigation = {
  task: TaskRecord;
  mainNavTarget: 'conversations';
  projectSection: 'sessions';
  hash: '#project-sessions';
};

export function shouldRefreshConversationForRuntimeEvent(event: ZeusRealtimeEvent, conversation: Pick<GraphConversationHistoryItem, 'sessionId' | 'archived'> | undefined): boolean {
  if (event.type !== 'runtime.session.output' && event.type !== 'runtime.session.error') return false;
  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : undefined;
  return Boolean(sessionId && conversation && !conversation.archived && conversation.sessionId === sessionId);
}

const nativeConversationListLifecycleEventTypes = new Set([
  'conversation.transport.changed',
  'conversation.thread.changed',
  'conversation.turn.started',
  'conversation.turn.completed',
  'conversation.queue.changed',
  'conversation.request.created',
  'conversation.request.resolved',
  'conversation.native.error',
]);

export function shouldRefreshNativeConversationListForRealtimeEvent(event: ZeusRealtimeEvent): boolean {
  return nativeConversationListLifecycleEventTypes.has(event.type) && typeof event.payload.projectId === 'string' && typeof event.payload.conversationId === 'string';
}

function taskAgentRunStatusFromConversationTreeRuntimeState(state: ConversationTreeRuntimeState): TaskAgentRunStatus {
  if (state === 'connecting') return 'connecting';
  if (state === 'reconnecting') return 'reconnecting';
  if (state === 'pending_user_input') return 'waiting_user';
  if (state === 'pending_approval') return 'waiting_approval';
  if (state === 'paused') return 'paused';
  if (state === 'ready') return 'idle';
  if (state === 'error') return 'failed';
  if (state === 'legacy_readonly') return 'legacy_readonly';
  return 'running';
}

type AppLanguage = AppShellSettings['appLanguage'];
type WorkMode = ProjectConfig['defaultWorkMode'];
type CodeMapToolPanel = 'runtime' | 'search' | 'qa' | 'mermaid' | 'entities';
type DiagramExportFormat = 'mermaid' | 'plantuml';
type GraphNodeTaskFeedback = 'idle' | 'creating' | 'created' | 'failed';
type GraphSourceOpenFeedback = 'idle' | 'opening' | 'opened' | 'failed';
type AppShellSettingsSavePayload = Pick<
  AppShellSettings,
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
  | 'taskStatusFilterByProject'
>;

function createSessionOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

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

function normalizeProjectSidebarPreferredWidth(width: number): number {
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

function browserProjectSidebarWidthStorage(): ProjectSidebarWidthStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function persistProjectSidebarPreferredWidth(width: number): void {
  // 侧栏宽度是可选的本机 UI 偏好；存储不可用时继续使用当前会话内状态。
  writeProjectSidebarPreferredWidth(browserProjectSidebarWidthStorage(), width);
}

function browserNativeConversationStartStorage(): NativeConversationStartStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function SessionMobileSourceTrigger(props: { language: AppLanguage; open: boolean; onOpen: () => void; triggerRef?: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={props.triggerRef} type="button" className="session-mobile-source-trigger" aria-expanded={props.open} aria-controls="session-project-conversation-list" onClick={props.onOpen}>
      <span aria-hidden="true">☰</span>
      {props.language === 'zh-CN' ? '会话列表' : 'Conversations'}
    </button>
  );
}

const SESSION_DRAWER_FOCUS_DELAY_MS = 40;

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

export function resolveSelectedNativeConversationForProject(choices: NativeConversationChoice[], selectedConversationId: string | null, activeProjectId: string | undefined): NativeConversationChoice | null {
  if (!selectedConversationId || !activeProjectId) return null;
  return choices.find((conversation) => conversation.id === selectedConversationId && conversation.projectId === activeProjectId) ?? null;
}

export function resolveTaskConversationToView(snapshot: NativeConversationChoicesSnapshot | undefined): NativeConversationChoice | null {
  if (!snapshot?.choices.length) return null;
  return snapshot.choices.reduce((latest, candidate) => (candidate.updatedAt.localeCompare(latest.updatedAt) > 0 ? candidate : latest));
}

export function updateConversationChoiceCompletionUnread<
  Snapshot extends {
    choices: NativeConversationChoice[];
    items: NativeConversationChoice[];
  },
>(snapshot: Snapshot, conversationId: string, hasUnreadCompletion: boolean): Snapshot {
  const update = (choice: NativeConversationChoice) =>
    choice.id === conversationId && choice.hasUnreadCompletion !== hasUnreadCompletion
      ? {
          ...choice,
          hasUnreadCompletion,
        }
      : choice;
  const choices = snapshot.choices.map(update);
  const items = snapshot.items.map(update);
  if (choices.every((choice, index) => choice === snapshot.choices[index]) && items.every((choice, index) => choice === snapshot.items[index])) return snapshot;
  return { ...snapshot, choices, items };
}

export function updateConversationChoiceFromNativeSnapshot<
  Snapshot extends {
    choices: NativeConversationChoice[];
    items: NativeConversationChoice[];
  },
>(snapshot: Snapshot, nativeSnapshot: NativeConversationSnapshot): Snapshot {
  let changed = false;
  const update = (choice: NativeConversationChoice): NativeConversationChoice => {
    if (choice.id !== nativeSnapshot.id) return choice;
    changed = true;
    return {
      ...choice,
      projectId: nativeSnapshot.projectId,
      taskId: nativeSnapshot.taskId,
      title: nativeSnapshot.title,
      summary: nativeSnapshot.summary,
      status: nativeSnapshot.status,
      transportKind: nativeSnapshot.transportKind,
      providerId: nativeSnapshot.providerId,
      providerThreadId: nativeSnapshot.providerThreadId,
      providerModel: nativeSnapshot.providerModel,
      providerState: nativeSnapshot.providerState,
      pendingRequestKind: nativeSnapshot.pendingRequestKind,
      createdAt: nativeSnapshot.createdAt,
      updatedAt: nativeSnapshot.updatedAt,
      archived: nativeSnapshot.archived,
      permissionMode: nativeSnapshot.permissionMode,
      collaborationMode: nativeSnapshot.collaborationMode,
    };
  };
  const choices = snapshot.choices.map(update).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const items = snapshot.items.map(update).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return changed ? { ...snapshot, choices, items } : snapshot;
}

function updateConversationChoiceSnapshotCollection<
  Snapshot extends {
    choices: NativeConversationChoice[];
    items: NativeConversationChoice[];
  },
>(collection: Record<string, Snapshot>, nativeSnapshot: NativeConversationSnapshot): Record<string, Snapshot> {
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(collection).map(([key, snapshot]) => {
      const updated = updateConversationChoiceFromNativeSnapshot(snapshot, nativeSnapshot);
      if (updated !== snapshot) changed = true;
      return [key, updated];
    }),
  ) as Record<string, Snapshot>;
  return changed ? next : collection;
}

const GRAPH_NODE_TASK_SUCCESS_DISMISS_MS = 2200;
const GRAPH_SOURCE_OPEN_FEEDBACK_DISMISS_MS = 2400;
const workModeValues = ['plan', 'develop', 'review', 'debug'] as const;
const taskStatusFilterValues: readonly TaskStatusFilter[] = ['', 'unfinished', ...taskManagementStatuses];
const taskManagementStatusLabels: Record<AppLanguage, Record<TaskManagementStatus | '', string>> = {
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
const taskAgentRunStatusLabels: Record<AppLanguage, Record<TaskAgentRunStatus, string>> = {
  'zh-CN': {
    not_started: '未启动',
    connecting: '正在连接',
    reconnecting: '正在重连',
    running: '运行中',
    waiting_user: '等待用户回复',
    waiting_approval: '等待授权',
    paused: '已暂停',
    idle: '等待新指令',
    failed: '运行失败',
    legacy_readonly: '旧会话只读',
  },
  'en-US': {
    not_started: 'Not started',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    running: 'Running',
    waiting_user: 'Waiting for user',
    waiting_approval: 'Waiting for approval',
    paused: 'Paused',
    idle: 'Waiting for instructions',
    failed: 'Run failed',
    legacy_readonly: 'Legacy read-only',
  },
};
const graphNodeTypeFilterValues = ['', 'file', 'function', 'package', 'api', 'table', 'column', 'control_flow', 'aggregate'] as const;
const graphEdgeTypeFilterValues = [
  '',
  'declares',
  'contains',
  'calls',
  'reads_table',
  'writes_table',
  'awaits_call',
  'branch_false',
  'branch_true',
  'control_flow',
  'emits',
  'executes',
  'executes_sql',
  'exposes_api',
  'handles_api',
  'loop_back',
  'loop_break',
  'loop_continue',
  'module_depends_on',
  'next_control_flow',
  'promise_catch',
  'promise_then',
  'references',
  'resolves_to',
  'try_catch',
  'try_finally',
  'uses_column',
] as const;

const languageCopy = {
  'zh-CN': {
    shellAriaLabel: 'Zeus macOS AI 原生研发工作台 · 已遵循减少动态效果',
    documentLang: 'zh-CN',
    languages: {
      'zh-CN': '简体中文',
      'en-US': '英语',
    },
    appearance: {
      system: '跟随系统',
      light: '浅色',
      dark: '深色',
    },
    workModes: {
      plan: '规划',
      develop: '开发',
      review: '评审',
      debug: '调试',
    },
    taskStatuses: {
      '': '全部',
      draft: '草稿',
      ready: '待开始',
      running: '运行中',
      paused: '已暂停',
      waiting_confirmation: '等待确认',
      completed: '已完成',
      failed: '已失败',
      cancelled: '已取消',
    },
    taskEventTypeLabels: {
      'task.created': '任务创建',
      'task.status.changed': '任务状态变更',
      'task.updated': '任务内容更新',
      'task.tags.updated': '任务标签更新',
      'task.archived': '任务归档',
      'task.restored': '任务恢复',
      'task.deleted': '任务删除',
      'task.runtime.queued': '任务运行排队',
      'task.runtime.run': '任务运行',
      'task.runtime.continue': '任务继续',
      'task.runtime.pause': '任务暂停',
      'task.runtime.cancel': '任务取消',
      'task.created.from_template': '从模板创建任务',
      'task.created.from_graph_question': '从图谱问答创建任务',
      'task.created.from_graph_view': '从图谱视图创建任务',
      'task.created.from_graph_node': '从图谱节点创建任务',
      'task.created.from_runtime_session': '从 Runtime 会话创建任务',
      'task.linked_graph_node': '关联图谱节点',
      'graph.node.writeback': '图谱节点写回',
      'runtime.session.recovered': 'Runtime 会话恢复',
      'telegram.notification.sent': 'Telegram 通知已发送',
      'telegram.notification.failed': 'Telegram 通知发送失败',
      'telegram.runtime.summary.sent': 'Telegram Runtime 摘要已发送',
      'telegram.runtime.summary.failed': 'Telegram Runtime 摘要发送失败',
      'telegram.run': 'Telegram 触发运行',
      'telegram.stop': 'Telegram 触发停止',
      'telegram.continue': 'Telegram 触发继续',
      'telegram.status.changed': 'Telegram 状态变更',
    },
    taskEventTypeSegments: {
      task: '任务',
      created: '创建',
      status: '状态',
      changed: '变更',
      updated: '更新',
      archived: '归档',
      restored: '恢复',
      deleted: '删除',
      runtime: 'Runtime',
      queued: '排队',
      run: '运行',
      continue: '继续',
      pause: '暂停',
      cancel: '取消',
      graph: '图谱',
      node: '节点',
      writeback: '写回',
      linked: '关联',
      from: '来自',
      view: '视图',
      question: '问答',
      template: '模板',
      session: '会话',
      recovered: '恢复',
      telegram: 'Telegram',
      notification: '通知',
      sent: '已发送',
      failed: '失败',
      summary: '摘要',
      stop: '停止',
      confirmation: '确认',
      requested: '已请求',
      expired: '已过期',
      confirmed: '已确认',
      cancelled: '已取消',
    },
    taskSorts: {
      title: '标题',
      managementStatus: '任务状态',
      createdAt: '创建时间',
      updatedAt: '更新时间',
    },
    graphNodeTypes: {
      '': '全部',
      file: '文件',
      function: '函数',
      package: '包',
      module: '模块',
      class: '类',
      interface: '接口定义',
      type: '类型',
      enum: '枚举',
      config: '配置',
      dependency: '依赖',
      api: '接口',
      table: '表',
      column: '字段',
      control_flow: '控制流',
      aggregate: '聚合',
    },
    graphEdgeTypes: {
      '': '全部',
      declares: '声明',
      contains: '包含',
      calls: '调用',
      reads_table: '读表',
      writes_table: '写表',
      awaits_call: '等待调用',
      branch_false: '否分支',
      branch_true: '是分支',
      control_flow: '控制流',
      emits: '发出事件',
      executes: '执行',
      executes_sql: '执行 SQL',
      exposes_api: '暴露接口',
      handles_api: '处理接口',
      loop_back: '循环回退',
      loop_break: '跳出循环',
      loop_continue: '继续循环',
      module_depends_on: '模块依赖',
      next_control_flow: '下一步控制流',
      promise_catch: 'Promise 异常',
      promise_then: 'Promise 后续',
      references: '引用',
      resolves_to: '解析到',
      try_catch: '异常捕获',
      try_finally: '最终清理',
      uses_column: '使用字段',
    },
    graphViewTypes: {
      architecture: '系统架构图',
      module: '模块图',
      table: '表关系图',
      module_detail: '模块详情图',
      api_sequence: '接口时序图',
      module_flow: '模块流程图',
      method_logic: '方法逻辑图',
    },
    localOperationFailed: '本地操作失败',
    sidebar: {
      ariaLabel: '项目优先导航',
      quickActionsLabel: '快捷入口',
      newChat: '新对话',
      search: '搜索',
      projects: '项目',
      projectListLabel: '项目列表',
      selectRepository: '选择真实本地代码库',
      selectedRepositoryDescription: '用户选择的真实本地仓库',
      cancelledRepositoryDescription: '用户取消选择，已保留当前项目列表',
      creatingRepository: '创建中',
      selectLocalRepository: '选择真实本地代码库',
      noProjectMatches: '没有匹配项目',
      addProject: '新增项目',
      createDialogTitle: '创建项目',
      createNameLabel: '项目名称',
      createNamePlaceholder: '项目名称',
      createFolderLabel: '项目目录',
      createFolderHelp: '选择一个 Zeus 可读取、索引和执行任务的本地目录。',
      createChooseFolder: '选择 Zeus 可读取和编辑的文件夹',
      createChangeFolder: '更换目录',
      createCancel: '取消',
      createSubmit: '创建项目',
      createSubmitting: '创建中',
      createNameRequired: '项目名称不能为空',
      createFolderRequired: '请先选择项目目录',
      projectSettingsPrefix: '项目设置',
      expandProjectPrefix: '展开项目',
      collapseProjectPrefix: '折叠项目',
      moreProjectActionsPrefix: '更多项目操作',
      projectMenuSuffix: '项目菜单',
      pinProject: '置顶该项目',
      unpinProject: '取消置顶',
      revealProjectInFinder: '在 Finder 中显示',
      renameProject: '重命名项目',
      deleteProject: '删除项目',
      confirmDeleteProject: '确认删除项目',
      deleteProjectHint: '只删除 Zeus 项目记录，不删除本地目录',
      renameDialogTitle: '重命名项目',
      renameDialogHelp: '只修改 Zeus 内的显示名称，不更改本地文件夹或仓库路径。',
      renameLabel: '项目显示名称',
      renamePlaceholder: '输入项目名称',
      renameCancel: '取消',
      renameSave: '保存',
      renameSaving: '保存中',
      renameRequired: '项目名称不能为空',
      pinned: '置顶',
      labelSeparator: '：',
      sections: {
        tasks: '任务',
        code: '代码',
        sessions: '会话',
        commands: '命令',
      },
      current: '当前',
      globalSettingsLabel: '全局设置',
      settings: '设置',
    },
    taskWorkspace: {
      viewAria: '项目任务',
      listAria: '任务列表',
      filterAria: '任务筛选与新建',
      searchAria: '搜索任务',
      searchTitle: '搜索任务',
      searchHelp: '标题或描述',
      conditionsAria: '任务筛选条件',
      statusAria: '任务状态',
      statusSelectAria: '任务状态筛选',
      taskStatusSelectAria: (taskTitle: string) => `修改任务状态：${taskTitle}`,
      detailStatusSelectAria: '修改当前任务状态',
      statusTitle: '状态',
      unfinishedStatusFilter: '未完成',
      statusHelp: '只看某类进度',
      sortAria: '任务排序',
      sortSelectAria: '任务排序',
      sortTitle: '排序',
      selectSearchPlaceholder: '搜索选项',
      selectNoResults: '没有匹配选项',
      rowMetaTitle: '来源',
      defaultTaskLabel: '默认任务',
      templateTaskLabel: '模板任务',
      sortHelp: '决定列表顺序',
      tagsAria: '任务标签',
      tagFilterAria: '任务标签筛选',
      tagsTitle: '标签',
      tagsHelp: '输入单个标签过滤',
      filterActionsAria: '任务筛选操作',
      filterAction: '筛选',
      newTask: '新任务',
      taskCreateDialogTitle: '创建任务',
      taskCreateTitleLabel: '任务标题',
      taskCreateTitlePlaceholder: '例如：修复任务表格列可见性',
      taskCreateDescriptionLabel: '任务要求 / 意图',
      taskCreateDescriptionPlaceholder: '描述期望行为、验收标准和必要上下文',
      taskCreatePriorityLabel: '优先级',
      taskCreatePriorityOptions: [
        { value: 'p0', label: 'P0：立即开始处理' },
        { value: 'p1', label: 'P1：紧急且重要' },
        { value: 'p2', label: 'P2：紧急不重要' },
        { value: 'p3', label: 'P3：重要不紧急' },
        { value: 'p4', label: 'P4：不重要不紧急' },
      ],
      taskCreateTagsLabel: '标签',
      taskCreateTagsPlaceholder: '可选，逗号分隔',
      taskCreateAttachmentsLabel: '图片与附件',
      taskCreateAttachmentsHint: '支持选择、粘贴或拖入文件、文件夹和超长文本',
      taskCreateChooseAttachments: '添加图片或附件',
      taskCreateRemoveAttachment: '移除附件',
      taskCreateImageAttachment: '图片',
      taskCreateFileAttachment: '文件',
      taskCreateOpenAttachment: '打开附件',
      taskCreatePreviewAttachment: '放大预览附件',
      taskCreatePreviewClose: '关闭附件预览',
      taskCreatePreviewUnavailable: '无法预览，本机路径已保存',
      taskCreateLocalPathLabel: '本机路径',
      taskCreateAttachmentAddedStatus: (count: number) => `已添加 ${count} 个附件，图片可放大，文件可打开。`,
      taskCreateAttachmentPickerFailed: '无法打开附件选择器，请重试。',
      taskCreatePasteAttachmentFailed: '无法保存粘贴的图片或附件，请重试。',
      taskCreateCancel: '取消',
      taskCreateSubmit: '创建任务',
      taskCreateSubmitting: '创建中',
      taskCreateClose: '关闭创建任务弹窗',
      taskCreateTitleRequired: '请输入任务标题',
      taskCreateSubmitFailed: '创建任务失败，请保留输入后重试。',
      today: '今天',
      emptyTitle: '还没有任务',
      emptyHelp: '用“新任务”创建第一条研发任务；创建后会显示任务状态、运行状态和更新时间。',
      emptySecondaryAction: '查看项目代码',
      emptyOutcomeStatus: '状态会随任务推进更新',
      emptyOutcomeAi: 'AI Runtime 连接后显示执行状态',
      emptyOutcomeEvidence: '运行、来源和事件会形成证据',
      noResultsPrimaryAction: '清除筛选',
      noResultsSecondaryAction: '查看全部状态',
      taskListLoadingToolbarStatus: '任务加载中',
      taskListLoadingTitle: '正在读取任务',
      taskListLoadingHelp: '保留当前视图框架',
      taskListLoadingMeta: '等待本机数据',
      taskListErrorToolbarStatus: '任务暂不可用',
      taskListErrorTitle: '无法读取任务列表',
      taskListErrorHelp: '请重试，或在项目设置中确认本机路径权限。错误详情只进入本机日志，不在普通界面暴露堆栈。',
      taskListErrorRetry: '重试',
      taskListErrorProjectSettings: '项目设置',
      noResultsTitle: '没有匹配任务',
      noResultsHelp: '筛选条件已即时应用；调整搜索、状态或标签即可恢复列表。',
      archiveAria: '归档任务',
      archiveTitle: '归档任务',
      itemUnit: '条',
      restoreTask: '恢复任务',
      detailAria: '任务管理详情',
      statusRowAria: '任务管理',
      statusRowTitle: '任务管理',
      noProjectSelected: '未选择项目',
      workbenchAria: '任务管理工作台',
      statusBoardAria: '任务状态总览',
      currentStatus: '当前状态',
      noTags: '未设置标签',
      aiCliLabel: 'AI CLI',
      telegramLabel: 'Telegram',
      aiDetected: '已检测',
      aiNotConfigured: '未配置',
      taskCodeLabel: '任务编码',
      priorityLabel: '优先级',
      sourceLabel: '上下文来源',
      updatedAtLabel: '更新时间',
      runtimeSessionLabel: 'Runtime 会话',
      runtimeCommandLabel: '运行命令 / 状态',
      latestEvidenceLabel: '最近事件',
      noEvidence: '暂无执行证据',
      attachmentsTitle: '图片与附件',
      imageAttachmentLabel: '图片',
      fileAttachmentLabel: '文件',
      openFileAttachmentLabel: '打开附件',
      previewAttachmentLabel: '放大预览附件',
      previewCloseLabel: '关闭附件预览',
      previewUnavailableLabel: '无法预览，本机路径已保存',
      localPathLabel: '本机路径',
      runtimeSessionNotStarted: '未启动 Runtime 会话',
      runtimeCommandMissing: '未记录运行命令',
      nextActionLabels: {
        draft: '可启动 AI',
        ready: '可启动 AI',
        running: '等待 AI 输出',
        paused: '可继续',
        waiting_confirmation: '需要我确认',
        completed: '已完成',
        failed: '可重试',
        cancelled: '已取消',
      },
      sourceLabels: {
        graph_node: '图谱节点',
        graph_view: '代码图谱',
        runtime_session: 'Runtime 会话',
        template: '任务模板',
        graph_question: '图谱问答',
        manual: '手动创建',
        user: '手动创建',
      },
      updatedAtMissing: '未记录',
      sensitiveCommandArgument: '***',
      runtimeSessionStatusLabels: {
        running: '运行中',
        exited: '已退出',
        failed: '已失败',
        stopped: '已停止',
        orphan_detected: '孤儿进程',
        lost: '已丢失',
      },
      telegramEnabled: '已启用',
      telegramDisabled: '未启用',
      contentAria: '任务管理内容',
      requestAria: '任务要求',
      requestTitle: '任务要求',
      noRequest: '暂无任务要求；可以在下方补充下一步要求。',
      eventsAria: '任务事件',
      eventsTitle: '任务事件',
      noEvents: '暂无事件；修改任务状态或推送到新会话后会在这里显示真实记录。',
      commandDockAria: '任务推进命令',
      statusActionsAria: '任务状态操作',
      runTask: '推送到模型',
      viewConversation: '查看会话',
      pushNewConversation: '推送到新会话',
      conversationsTitle: '关联会话',
      conversationEmptyTitle: '还没有关联会话',
      conversationEmptyHelp: '推送后会创建新会话，历史会话不会被覆盖。',
      conversationLoading: '正在读取关联会话…',
      conversationError: '关联会话暂时无法刷新',
      openConversation: '打开会话',
      retryConversationLoad: '重新加载',
      markComplete: '标记完成',
      cancelTask: '取消任务',
      retryTask: '重试任务',
      detailPaneLabel: '任务详情',
      detailPaneBackdrop: '关闭任务详情',
      detailPaneClose: '关闭',
      openTaskDetail: '打开任务详情',
      taskCountPrefix: '任务',
      filteredState: '已筛选',
      allState: '全部状态',
      codeColumnTitle: '任务编码',
      intentColumnTitle: '任务',
      managementStatusColumnTitle: '任务状态',
      runStatusColumnTitle: '运行状态',
      sourceColumnTitle: '上下文来源',
      createdAtColumnTitle: '创建时间',
      updatedAtColumnTitle: '更新时间',
      priorityColumnTitle: '优先级',
      projectColumnTitle: '项目',
      templateColumnTitle: '模板',
      descriptionColumnTitle: '描述',
      runtimeSessionColumnTitle: 'Runtime 会话',
      rawIdColumnTitle: '原始任务 ID',
      createdFromColumnTitle: '创建来源',
      fieldSettings: '自定义列',
      fieldSettingsAria: '自定义任务字段',
      fieldSettingsHelp: '显示、隐藏或调整任务表格字段',
      restoreDefaultColumns: '恢复默认字段',
      requiredColumnReason: '固定列，不能隐藏',
      moveColumnUpAria: (columnTitle: string) => `上移字段：${columnTitle}`,
      moveColumnDownAria: (columnTitle: string) => `下移字段：${columnTitle}`,
      compactColumnAria: (columnTitle: string) => `压缩字段宽度：${columnTitle}`,
      standardColumnAria: (columnTitle: string) => `标准字段宽度：${columnTitle}`,
      wideColumnAria: (columnTitle: string) => `放宽字段宽度：${columnTitle}`,
      selectTaskAria: (taskTitle: string) => `选择任务：${taskTitle}`,
      selectAllVisibleTasks: '选择当前筛选结果',
      clearTaskSelection: '清除选择',
      bulkSelectedCount: (count: number) => `已选择 ${count} 项`,
      bulkStatusTargetAria: '批量状态目标',
      bulkStatusTargetTitle: '批量状态',
      bulkApplyStatus: '应用状态',
      bulkDelete: '批量删除',
      bulkDeleteConfirm: (count: number, skippedCount: number) => `确认删除 ${count} 个任务？${skippedCount ? `将跳过 ${skippedCount} 个运行中或等待确认任务。` : ''}此操作不可撤销。`,
      bulkStatusSkippedHint: (eligibleCount: number, skippedCount: number) => `可处理 ${eligibleCount} 项，跳过 ${skippedCount} 项`,
      primaryActionsTitle: '主操作',
      secondaryActionsTitle: '次操作',
      dangerActionsTitle: '危险操作',
      metadataTitle: '任务元信息',
      projectLabel: '项目',
      templateLabel: '模板',
      cancelConfirm: '确认取消该任务？运行中的 Runtime 会收到取消请求。',
      followUpAria: '要求后续变更',
      followUpTitle: '要求后续变更',
      followUpHelp: '补充到当前任务，不把任务页伪装成会话聊天输入框。',
      followUpPlaceholder: '补充任务要求',
      saveRequest: '保存要求',
      modeRailAria: '任务模式状态',
      contextRailAria: '任务收纳入口',
      runtime: '运行环境',
      context: '上下文',
      codeChanges: '代码变更',
      templates: '模板',
      defaultTaskTitle: '分析当前项目结构',
      defaultTaskDescription: '基于真实扫描和 Git 状态分析当前 Zeus 仓库',
      templateTaskTitle: '从模板创建的任务',
      templateTaskGoal: '基于模板补充真实任务目标',
    },
    sessionWorkspace: {
      viewAria: '项目会话',
      listAria: '会话列表',
      toolbarAria: '会话搜索与新建',
      searchAria: '对话搜索',
      searchTitle: '对话搜索',
      searchHelp: '按标题或描述过滤',
      newChat: '新对话',
      newChatPrompt: (projectName: string) => `我们应该在 ${projectName} 中构建什么？`,
      newChatPlaceholder: '随心输入',
      newChatCommandRowAria: '新对话工具栏',
      composerAddContextAria: '添加上下文',
      composerCustomize: '自定义',
      composerCustomizeAria: '自定义会话设置',
      composerCurrentAi: (adapterName: string) => `当前 AI：${adapterName}`,
      starterListAria: '新对话建议入口',
      starterCreateTask: '完成一次项目任务',
      starterOpenCode: '查看代码图谱',
      starterOpenRuntime: '打开运行环境',
      environmentTitle: '环境信息',
      environmentChanges: '变更',
      environmentLocalMode: '本地模式',
      environmentBranch: 'main',
      emptyTitle: '还没有会话',
      emptyHelp: '新对话会创建真实会话记录；当前筛选没有匹配项时可先清空搜索词。',
      rowType: '对话',
      archiveAria: '归档会话',
      archiveTitle: '归档会话',
      itemUnit: '条',
      restoreSession: '恢复会话',
      detailAria: '当前对话',
      aiDetected: 'AI CLI 已检测',
      aiNotConfigured: 'AI CLI 未配置',
      telegramEnabled: 'Telegram 已启用',
      telegramDisabled: 'Telegram 未启用',
      threadAria: '当前对话',
      messageListAria: '任务事件与对话消息',
      userRequest: '用户要求',
      assistantResponse: 'AI 回复',
      waitingTitle: '等待下一步',
      noEvents: '暂无事件，下一步可以推送到模型或补充任务要求。',
      inputDockAria: '任务下一步与对话输入',
      statusActionsAria: '任务状态操作',
      sendToConversation: '推送到模型',
      markComplete: '标记完成',
      cancelTask: '取消任务',
      followUpAria: '要求后续变更',
      followUpTitle: '要求后续变更',
      followUpHelp: '补充给当前任务或 CLI 对话的下一步要求。',
      followUpPlaceholder: '要求后续变更',
      send: '发送',
      modeRailAria: '会话模式状态',
      contextRailAria: '对话收纳入口',
      runtime: '运行环境',
      context: '上下文',
      codeChanges: '代码变更',
      templates: '模板',
      secondaryDrawerLabel: '对话抽屉',
      secondaryDrawerBackdrop: '对话抽屉背景',
      secondaryDrawerClose: '关闭对话抽屉',
      secondaryDrawer: {
        contextLabel: '上下文',
        openGraph: '打开图谱',
        graphScopeAria: '图谱上下文规模',
        graphContextTitle: '图谱上下文',
        graphContextHelp: '当前项目真实图谱规模',
        graphContextMetrics: (nodes: number, edges: number, views: number) => `${nodes} 个节点 / ${edges} 条边 / ${views} 个视图`,
        graphAnswerTitle: '图谱问答',
        runtimeSession: (sessionId: string) => `Runtime 会话 ${sessionId}`,
        insufficientRuntimeSession: '来源不足，未启动 Runtime 会话',
        graphConversationListAria: '图谱问答会话',
        archived: '已归档',
        openable: '可打开',
        changesLabel: '代码变更',
        loadDiff: '读取 Diff',
        loadingDiff: '读取中',
        noLoadedChangesAria: '暂无已读取变更',
        noLoadedChangesTitle: '暂无已读取变更',
        noLoadedChangesHelp: '读取 Diff 后会按真实文件路径展示。',
        changedFilesAria: '代码变更文件',
        realGitDiffFile: '真实 Git diff 文件',
        loaded: '已读取',
        templatesLabel: '任务模板',
        loadingTemplates: '读取中',
        loadTemplates: '读取模板',
        templateListAria: '任务模板列表',
        emptyTemplatesAria: '暂无任务模板',
        emptyTemplatesTitle: '暂无模板',
        emptyTemplatesHelp: '读取真实模板后，这里会显示可套用的任务提示和创建入口。',
        builtInTaskTemplate: '内置任务模板',
        projectTaskTemplate: '项目任务模板',
        builtInTemplate: '内置模板',
        projectTemplate: '项目模板',
        applyTemplate: '套用模板',
      },
      runtimeDrawer: {
        runtimeEnvironment: '运行环境',
        refresh: '刷新',
        runtimeStatus: 'Runtime 状态',
        detectedCommand: (command: string) => `已检测到 ${command}`,
        waitingForCommand: (command: string) => `等待配置 ${command}`,
        terminalBackend: '终端后端',
        terminalPending: 'node-pty 状态等待读取。',
        runtimeSessions: 'AI Runtime 会话',
        startRuntimeSession: '启动 Runtime 会话',
        runtimeSessionSearch: 'Runtime 会话搜索',
        searchSessions: '搜索会话',
        searchSessionsHelp: '按命令、路径或摘要过滤',
        favoritesOnly: '只看收藏',
        showArchived: '显示归档',
        applyFilters: '应用会话筛选',
        emptyRuntimeSessions: '暂无真实 Runtime 会话。',
        runtimeSessionStatusLabels: {
          running: '运行中',
          exited: '已退出',
          failed: '失败',
          stopped: '已停止',
          orphan_detected: '孤儿会话',
          lost: '已丢失',
        },
        runtimeAdaptersAria: 'Runtime 适配器',
        runtimeAdaptersTitle: 'Runtime 适配器',
        codexCliDisplayName: 'OpenAI Codex CLI',
        genericShellDisplayName: '通用 Shell',
        adapterAvailable: '可用',
        adapterUnavailable: '不可用',
        adapterUnchecked: '未检测',
        checkAdapter: '检测适配器',
        adapterCapabilities: (capabilities: string) => `能力：${capabilities}`,
        adapterVersion: (version: string) => `版本：${version}`,
        adapterAuthStatus: (status: string) => `登录状态：${status}`,
        adapterModelConfig: (modelConfiguration: string) => `模型配置：${modelConfiguration}`,
        adapterAuthAuthenticated: '已认证',
        adapterAuthUnauthenticated: '未登录',
        adapterAuthUnknown: '未知',
        adapterVersionUnknown: '未读取',
        adapterModelUserConfigured: '用户配置',
        genericShellRiskAria: '通用 Shell 高风险确认',
        genericShellRiskTitle: '通用 Shell 高风险确认',
        genericShellCommandAria: '通用 Shell 命令',
        genericShellCommandTitle: '通用 Shell 命令',
        genericShellCommandHelp: '按 sh -lc 一次性启动真实本机命令，变更后必须重新创建确认。',
        genericShellCommandPlaceholder: '例如 pnpm --version',
        genericShellChangedStatus: '命令已变更，请重新创建通用 Shell 确认',
        genericShellConfirmationIdle: '尚未创建通用 Shell 确认',
        genericShellConfirmationCreated: (confirmationId: string) => `已创建确认 ${confirmationId}，确认只绑定本次 sh -lc。`,
        genericShellConfirmationCreateFailed: '通用 Shell 确认创建失败',
        genericShellConfirmationRejectFailed: '通用 Shell 确认拒绝失败',
        genericShellCriticalPhraseRequired: (phrase: string) => `高危命令必须先手动输入 ${phrase}`,
        genericShellConfirmationConsumed: (confirmationId: string) => `已消费确认 ${confirmationId} 并启动通用 Shell 会话。`,
        genericShellConfirmationFailed: '通用 Shell 确认或启动失败',
        commandPreviewAria: '通用 Shell 命令预览',
        commandPreviewTitle: '命令预览',
        commandPreviewHelp: '本次 sh -lc 预览',
        emptyShellCommand: '尚未输入 shell 命令',
        genericShellRiskSummary: (label: string, reason: string) => `${label}：${reason}。确认只绑定本次 sh -lc。`,
        criticalPhraseAria: '高危命令确认短语',
        criticalPhraseTitle: '高危命令确认短语',
        criticalPhraseHelp: (phrase: string) => `检测到高危命令，启动前必须完整输入 ${phrase}。`,
        confirmationStateAria: '通用 Shell 确认状态',
        confirmationStateTitle: '确认状态',
        confirmationStateHelp: '本次命令绑定',
        rejectedAria: '已拒绝通用 Shell 确认',
        rejectedTitle: '已拒绝通用 Shell 确认',
        rejectedHelp: '不会启动 Runtime 会话',
        rejectedReasonFallback: '用户已拒绝本次一次性确认。',
        createGenericShellConfirmation: '创建通用 Shell 确认',
        rejectGenericShellConfirmation: '拒绝通用 Shell 确认',
        confirmAndStartGenericShell: '确认并启动通用 Shell',
        rejectImpactAria: '拒绝通用 Shell 影响',
        rejectImpactTitle: '拒绝影响',
        rejectImpactHelp: '安全边界',
        rejectImpactBody: '拒绝后不会启动 Runtime 会话。',
        sessionSummaryFallback: '未生成摘要',
        runtimeSessionActionsAria: 'Runtime 会话操作',
        generateSummary: '生成摘要',
        createTaskFromSession: '从会话创建任务',
        taskDraftTitle: (command: string) => `继续会话：${command}`,
        taskDraftInstruction: '基于真实 Runtime 会话日志继续分析后续处理事项。',
        unfavoriteSession: '取消收藏',
        favoriteSession: '收藏会话',
        restoreSession: '恢复会话',
        archiveSession: '归档会话',
        exportCurrentLog: '导出当前日志',
        deleteSession: '删除会话',
        runtimeInputAria: 'Runtime 输入',
        runtimeInputSendAria: 'Runtime 输入发送',
        runtimeInputTitle: 'Runtime 输入',
        runtimeInputHelp: '只发送到当前运行会话',
        sendRuntimeInput: '发送 Runtime 输入',
        terminalControlsAria: 'Runtime 终端控制',
        interrupt: '中断',
        resizeTerminal: '调整终端尺寸',
        loadTerminalSnapshot: '读取终端快照',
        stopSession: '停止会话',
        orphanControlsAria: 'Runtime 孤儿会话控制',
        unknownPid: '未知',
        orphanTitle: (pid: string | number) => `进程 ${pid} 已脱离当前 Runtime 控制`,
        orphanHelp: '只能终止本机残留进程；不会恢复输入、日志或 AI 会话状态。',
        orphanStop: '终止孤儿会话',
        logsAria: '真实 Runtime 日志',
        logsTitle: '真实 Runtime 日志',
        logsHelp: '原始输出查看',
        logActionsAria: 'Runtime 日志操作',
        copyLogs: '复制当前日志',
        expandLogs: '展开日志',
        collapseLogs: '折叠日志',
        logSearchAria: 'Runtime 日志搜索',
        logSearchTitle: '搜索日志',
        logSearchHelp: '仅过滤当前加载的真实日志',
        logExportIdle: '尚未导出 Runtime 日志',
        logExportEmpty: '没有可导出的真实 Runtime 日志',
        logExportCancelled: '已取消 Runtime 日志导出',
        logExportFailed: 'Runtime 日志导出失败',
        logExportSaved: (filePath: string) => `最近导出 Runtime 日志：${filePath}`,
        logCopyIdle: '尚未复制 Runtime 日志',
        logCopyEmpty: '没有可复制的真实 Runtime 日志',
        logCopySuccess: '已复制当前日志',
        logCopyFailed: '复制当前日志失败',
        logExportState: (exportStatus: string, copyStatus: string) => `日志导出只保存当前加载的真实 Runtime 日志 · ${exportStatus} · ${copyStatus}`,
        logLegend: '错误高亮 / 命令高亮 / AI 回复高亮',
        rawOutputAria: '原始输出查看',
        collapsedLogs: '日志已折叠，点击展开日志查看。',
        terminalAria: 'xterm Runtime 终端',
      },
    },
    codeWorkspace: {
      detailAria: '当前项目状态',
      repositoryAria: '当前仓库',
      stateProjectSettings: '项目设置',
      stateCodeGraph: '代码与图谱',
      overviewAria: '代码库与图谱概览',
      contextRailAria: '代码库上下文',
      repositoryStatusAria: '仓库状态',
      repositoryStatusTitle: '仓库状态',
      localPath: '本地路径',
      scan: '扫描',
      git: 'Git',
      gitNotDetected: 'Git 未检测',
      changeUnit: '个变更',
      graph: '图谱',
      graphSummaryAria: '代码图谱摘要',
      graphTitle: '代码图谱',
      viewsAvailable: (count: number) => `${count} 个视图可用`,
      graphCounts: (nodes: number, edges: number) => `${nodes} 个节点 / ${edges} 条边`,
      waitingRealScan: '等待真实扫描',
      emptyGraphHelp: '选择扫描后才展示真实节点、边和视图，不用占位图谱。',
      primaryActionsAria: '主要操作',
      scanProject: '扫描项目',
      openGraph: '打开图谱',
      viewChanges: '查看变更',
      secondaryActionsAria: '更多项目操作',
      edit: '编辑',
      configure: '配置',
      moreProjectActions: '更多项目操作',
      drawerLabel: '项目抽屉',
      graphDrawerAria: '代码图谱',
      scanning: '扫描中',
      retryScan: '重试扫描',
      openCodeMap: '打开代码图谱',
      scanCurrentRepository: '扫描当前仓库',
      projectSettingsAria: '项目设置',
      projectCodeAria: '项目代码',
      projectListAria: '项目列表',
      projectSearchCreateAria: '项目搜索与创建',
      projectSearchAria: '项目搜索',
      projectSearchTitle: '搜索项目',
      projectSearchHelp: '名称或本地路径',
      projectSearchAction: '搜索',
      projectListContentAria: '项目列表内容',
      drawerBackdrop: '项目抽屉关闭区域',
      drawerClose: '关闭项目抽屉',
      scanStatuses: {
        not_scanned: '未扫描',
        scanning: '扫描中',
        completed: '已完成',
        failed: '扫描失败',
      },
      projectArchive: {
        aria: '归档项目',
        title: '归档项目',
        count: (count: number) => (count === 0 ? '暂无可恢复项目' : `${count} 个项目可恢复`),
        refresh: '刷新',
        emptyAria: '归档项目空态',
        emptyTitle: '没有归档项目',
        emptyHelp: '归档后的项目会在这里显示；恢复只恢复 Zeus 的项目记录，不会移动本地目录。',
        listAria: '归档项目列表',
        restore: '恢复项目',
      },
      projectEdit: {
        formAria: '项目编辑表单',
        currentProjectAria: '当前项目',
        currentProjectTitle: '当前项目',
        nameAria: '项目名称',
        nameTitle: '项目名称',
        nameHelp: '只影响 Zeus 内部展示名，不改动本地目录名称。',
        pathAria: '项目路径',
        pathTitle: '项目路径',
        pathHelp: '指向真实本地代码库；保存后会影响后续扫描和图谱来源。',
        descriptionAria: '项目描述',
        descriptionTitle: '项目描述',
        descriptionHelp: '用于区分项目上下文，不参与代码扫描和文件写入。',
        saveAria: '保存项目编辑',
        save: '保存项目变更',
        deleteAria: '删除项目',
        deleteTitle: '删除项目',
        deleteHelp: '只删除 Zeus 项目记录，不删除本地目录',
        confirmDelete: '确认删除项目',
      },
      projectConfig: {
        formAria: '项目配置',
        currentStateAria: '当前项目配置状态',
        currentStateTitle: '当前配置',
        waitingToLoad: '待读取',
        defaultModelAria: '默认 AI 模型',
        defaultModelTitle: '默认 AI 模型',
        defaultModelHelp: '新任务默认使用的真实 AI Runtime 模型，不在前端伪造可用性。',
        defaultWorkModeAria: '默认工作模式',
        defaultWorkModeTitle: '默认工作模式',
        defaultWorkModeHelp: '控制新任务进入 plan、develop、review 或 debug 的默认入口。',
        defaultTaskPromptAria: '默认任务提示',
        defaultTaskPromptTitle: '默认任务提示',
        defaultTaskPromptHelp: '用于图谱问答等项目级上下文，不进入正式任务首发。',
        scanIgnoreAria: '扫描忽略规则',
        scanIgnoreTitle: '扫描忽略规则',
        scanIgnoreHelp: '逗号分隔目录；用于代码扫描与图谱生成时排除噪音。',
        indexScopeAria: '索引范围',
        indexScopeTitle: '索引范围',
        indexScopeHelp: '决定图谱扫描覆盖整个项目、仅 src，还是自定义路径。',
        indexScopeOptions: {
          project: '整个项目',
          src: '仅 src',
          custom: '自定义',
        },
        primaryLanguageAria: '主语言',
        primaryLanguageTitle: '主语言',
        primaryLanguageHelp: '用于图谱、任务模板和默认提示的语言画像。',
        additionalLanguagesAria: '附加语言',
        additionalLanguagesTitle: '附加语言',
        additionalLanguagesHelp: '逗号分隔；补充多语言仓库的扫描与提示语境。',
        packageManagersAria: '包管理器',
        packageManagersTitle: '包管理器',
        packageManagersHelp: '逗号分隔；影响任务建议和仓库健康摘要。',
        manifestPathsAria: '清单路径',
        manifestPathsTitle: '清单路径',
        manifestPathsHelp: '逗号分隔真实 manifest 文件，供依赖识别与图谱摘要使用。',
        databaseConnectionAria: '数据库连接名',
        databaseConnectionTitle: '数据库连接名',
        databaseConnectionHelp: '仅保存连接标识，密码仍走本机钥匙串。',
        schemaPathsAria: '结构定义路径',
        schemaPathsTitle: '结构定义路径',
        schemaPathsHelp: '逗号分隔 DDL / SQL 文件，会并入代码图谱来源。',
        telegramAliasAria: 'Telegram 别名',
        telegramAliasTitle: 'Telegram 别名',
        telegramAliasHelp: '用于项目通知路由；空值表示不绑定项目级别名。',
        allowShellAria: '允许 Shell',
        allowShellTitle: '允许 Shell',
        allowShellHelp: '开启后任务可请求本项目 Shell 能力，仍受全局安全策略约束。',
        allowGitWriteAria: '允许 Git 写操作',
        allowGitWriteTitle: '允许 Git 写操作',
        allowGitWriteHelp: '只决定项目级默认许可，不绕过用户确认和全局限制。',
        databaseStateAria: '数据库配置说明',
        databaseTitle: '数据库',
        passwordStateAria: '数据库密码状态',
        passwordTitle: '密码状态',
        passwordConfigured: '密码已安全保存',
        passwordNotConfigured: '密码未配置',
        passwordHelp: '密码只保存在本机钥匙串，不在界面回显。',
        save: '保存项目配置',
        unsetPackageManagers: '未设置包管理器',
        unsetManifestPaths: '未设置清单路径',
        unsetConnectionName: '未设置连接名',
        unsetSchemaPaths: '未设置结构定义路径',
        externalDatabaseHelp: '外部数据库驱动待接入；请把密码保存到钥匙串密码字段，连接名显示会自动脱敏，不会声明远程结构定义已读取。',
        localSchemaHelp: '配置的真实 DDL/SQL 文件会在 src 扫描范围外并入代码图谱；连接名不是凭据。',
      },
    },
    settingsWorkspace: {
      viewAria: '设置',
      categoryListAria: '设置分段',
      detailPaneAria: '设置详情',
      returnToApp: '返回应用',
      searchAria: '搜索设置',
      searchPlaceholder: '搜索设置...',
      sectionGroups: {
        personal: '个人',
        integrations: '集成',
        coding: '编码',
        maintenance: '维护',
      },
      workModeTitle: '工作模式',
      workModeDescription: '选择 Zeus 默认展示多少技术细节',
      engineeringModeTitle: '适用于工程',
      engineeringModeDescription: '更多执行细节、证据和控制',
      dailyModeTitle: '适用于日常工作',
      dailyModeDescription: '同样强大，技术细节更少',
      permissionsTitle: '权限',
      defaultPermissionTitle: '默认权限',
      defaultPermissionDescription: '默认只访问当前工作区；额外路径需要再次确认。',
      autoReviewTitle: '自动审核',
      autoReviewDescription: '低风险请求可自动审核；高风险动作仍需要确认。',
      fullAccessTitle: '完全访问权限',
      fullAccessDescription: '默认关闭；开启前必须说明风险并保留审计。',
      protectedStatus: '受保护',
      waitingStatus: '等待',
      localStatus: '本机',
      categories: {
        general: '通用',
        tasks: '任务列表',
        runtime: 'AI CLI / Runtime',
        browser: '内置浏览器',
        telegram: 'Telegram',
        security: '安全与钥匙串',
        commands: '命令',
        git: 'Git 确认',
        release: '发布与更新',
        data: '缓存与数据',
      },
      generalPaneTitle: '通用设置',
      appLanguageTitle: '应用语言',
      appLanguageDescription: '选择 Zeus 使用的界面语言',
      appearanceTitle: '深色/浅色模式',
      appearanceDescription: '界面跟随系统，或固定为浅色、深色',
      desktopNotificationsTitle: '桌面通知',
      desktopNotificationsDescription: '本机任务、Runtime 和 Telegram 状态变化时提醒',
      desktopNotificationsSwitchAria: '桌面通知开关',
      desktopNotificationsInputAria: '桌面通知',
      notificationsEnabled: '已启用',
      notificationsDisabled: '已关闭',
      notificationsEnabledHelp: '通知会在本机显示',
      notificationsDisabledHelp: '不会主动打扰',
      saveSettingsTitle: '保存设置',
      saveSettingsDescription: '仅保存本机界面偏好，不影响项目或 Runtime 会话',
      save: '保存',
      runtime: {
        paneTitle: 'Runtime 执行设置',
        cliStatusAria: 'Runtime CLI 检测状态',
        detected: '已检测',
        waitingConfiguration: '等待配置',
        defaultAdapterAria: '默认 Runtime 适配器',
        defaultAdapterTitle: '默认运行适配器',
        defaultAdapterDescription: '启动新 Runtime 会话时优先使用。',
        codexCliDisplayName: 'Codex CLI',
        genericShellDisplayName: '通用 Shell',
        adapterActionMeta: '运行适配器',
        currentDefaultAria: '当前默认 Runtime 适配器',
        currentDefaultTitle: '当前默认',
        currentDefault: (adapter: string) => `当前默认：${adapter}`,
        adapterModelAria: '默认适配器模型',
        adapterModelTitle: '默认适配器模型',
        adapterModelDescription: '仅写入本机 Runtime 配置，不声明外部 CLI 已登录。',
        defaultArgsAria: '默认参数',
        defaultArgsTitle: '默认参数',
        defaultArgsDescription: '按空格解析为真实 CLI 参数。',
        cliPathAria: 'CLI 路径',
        cliPathTitle: 'CLI 路径',
        cliPathDescription: '可选本机可执行文件绝对路径；留空则依次检查当前 PATH、常见目录和登录 Shell。Zeus 不内置或自动安装 CLI。',
        concurrencyAria: 'Runtime 并发上限',
        concurrencyTitle: '项目并发上限',
        globalConcurrency: (count: number) => `全局并发上限：${count}`,
        timeoutAria: 'Runtime 执行超时',
        timeoutTitle: '执行超时',
        seconds: (count: number) => `${count} 秒`,
        logRetention: (days: number) => `日志保留策略：保留 ${days} 天`,
        autoConfirmAria: 'Runtime 自动确认策略',
        autoConfirmTitle: '自动确认策略',
        autoConfirmHighRiskBoundary: '不会绕过通用 Shell、Git 写入、删除文件等高风险确认。',
        autoConfirmPolicies: {
          never: '从不',
          low_risk_only: '仅低风险',
        },
        timeoutSecondsAria: '执行超时秒数',
        timeoutSecondsTitle: '执行超时秒数',
        timeoutSecondsDescription: '超过该时间后由 Runtime 状态机处理超时。',
        secondsUnit: '秒',
        advancedAria: '高级 Runtime 参数',
        advancedTitle: '高级 Runtime 参数',
        advancedDescription: '只写入真实 Runtime 子进程配置；不会声明 CLI 已安装或已登录。',
        advancedHelp: '环境变量会进入真实子进程；不会验证 CLI 已安装或已登录。',
        shellPathTitle: 'Shell 路径',
        shellPathAria: 'Shell 路径',
        terminalEnvTitle: '终端环境变量',
        terminalEnvAria: '终端环境变量',
        loginShell: '作为 login shell 启动',
        nonLoginShell: '非 login shell 启动',
        modelMeta: '模型',
        argsMeta: '参数',
        saveDefaultAdapter: '保存默认适配器',
      },
      telegram: {
        paneTitle: 'Telegram 设置',
        botTokenAria: 'Telegram 机器人令牌',
        botTokenTitle: 'Telegram 机器人令牌',
        botTokenConfigured: '已配置',
        botTokenNotConfigured: '未配置',
        botTokenHelp: (label: string) => `${label} · 令牌只保存到 macOS 钥匙串；界面不回显明文。`,
        tokenFieldLabel: '令牌',
        saveToKeychain: '保存到钥匙串',
        clearToken: '清理令牌',
        chatIdAria: 'Telegram 通知会话 ID',
        chatIdTitle: '通知会话 ID',
        chatIdFieldLabel: '通知会话 ID',
        notTested: '尚未测试连接',
        saveNotifications: '保存通知设置',
        testConnection: '测试连接',
        testSuccess: (chatIds: string, attempts: number, sentAt: string) => `测试连接已发送：${chatIds} · 尝试 ${attempts} 次 · ${sentAt}`,
        testFailed: '测试连接失败，请检查机器人令牌和通知会话 ID。',
        pollingAria: 'Telegram 轮询与消息日志',
        pollingTitle: '轮询与消息日志',
        pollingDescription: '只展示真实 polling update，不生成假 Telegram 消息。',
        pollingState: (running: boolean, offset: number) => `${running ? '运行中' : '已停止'} · offset ${offset}`,
        emptyPollingLogs: '暂无真实 Telegram 轮询日志。',
        latestLogs: '最近 5 条',
      },
      security: {
        paneTitle: '安全与钥匙串设置',
        externalApiKeyAria: '外部接口密钥',
        externalApiKeyTitle: '外部接口密钥',
        externalApiKeyConfigured: '外部接口密钥已配置',
        externalApiKeyNotConfigured: '外部接口密钥未配置',
        externalApiKeyHelp: (label: string) => `${label} · 只保存到 macOS 钥匙串；不会声明外部 AI 服务已可用。`,
        externalApiKeyFieldLabel: '接口密钥',
        saveApiKey: '保存接口密钥',
        clearApiKey: '清理接口密钥',
        allowlistAria: 'Telegram 白名单',
        allowlistTitle: 'Telegram 白名单',
        allowlistDescription: '只有允许的真实 Telegram 用户可远程触发操作。',
        allowlistFieldAria: '允许用户 ID',
        allowlistFieldLabel: '允许用户 ID',
        saveAllowlist: '保存白名单',
        exposureRiskAria: '泄露风险',
        exposureRiskTitle: '泄露风险',
        exposureRiskDescription: '清理本机保存的令牌、接口密钥与远程控制白名单状态。',
        exposureRiskResetHelp: '重置后需要重新配置外部凭据。',
        resetSecurity: '重置安全设置',
        auditAria: '安全审计',
        auditTitle: '安全审计',
        auditDescription: '只展示真实本机安全审计记录。',
        emptyAudit: '暂无真实安全审计记录。',
        latestAudit: '最近 6 条',
      },
      git: {
        paneTitle: 'Git 确认设置',
        branchNameAria: 'Git 分支名',
        branchNameTitle: '分支名',
        branchNameDescription: '只用于创建 Git 写操作确认，不会直接执行。',
        remoteAria: 'Git 远端',
        remoteTitle: '远端',
        remoteDescription: '只用于推送确认，真实推送仍需要二次确认。',
        confirmationAria: 'Git 写操作确认',
        confirmationTitle: '危险操作必须确认',
        confirmationDescription: '这里只生成本机确认请求，不会直接执行 Git 写操作。',
        targetBranch: (branch: string) => (branch.trim() ? `目标分支：${branch.trim()}` : '目标分支未填写'),
        remoteTarget: (remote: string, target: string) => (remote.trim() ? `远端：${remote.trim()} · 目标：${target.trim() || '未填写'}` : '远端未填写'),
        requestBranchConfirmation: '请求创建分支确认',
        requestPushConfirmation: '请求推送确认',
      },
      release: {
        paneTitle: '发布与签名',
        signingAria: 'macOS 签名状态',
        signingTitle: 'macOS 签名',
        signingEnvironmentOnly: '证书只通过发布环境变量读取。',
        notarizationAria: '公证状态',
        notarizationTitle: '公证',
        notarizationDescription: '不会伪造签名或公证成功；没有 Apple 凭据时只允许未签名验证。',
        caskAria: 'Homebrew cask 状态',
        caskTitle: 'Homebrew cask',
        releaseSigningConfigured: '签名证书已配置',
        releaseSigningWaiting: '等待 Apple 签名证书',
        releaseNotarizationConfigured: '公证凭据已配置',
        releaseNotarizationWaiting: '等待 Apple 公证凭据',
        releaseCaskDetected: '已检测到 Casks/zeus.rb',
        releaseCaskWaiting: '等待 Homebrew cask 文件',
        unsignedBuildAvailable: '未签名构建可用',
        unsignedBuildUnavailable: '未签名构建不可用',
        detailAria: '发布详情',
        detailTitle: '发布详情',
        detailDescription: '不把未签名、未公证产物伪装成正式发布。',
        autoUpdateReserved: '自动更新预留',
        autoUpdateManual: (version: string) => `手动更新 · ${version}`,
        autoUpdateFeed: (channel: string, version: string) => `${channel}更新 · ${version}`,
        realReleaseStatus: '真实发布状态',
        updateAria: '软件更新',
        updateActionAria: '软件更新操作',
        updateTitle: '软件更新',
        updateStatusLabels: {
          up_to_date: (version: string) => `已是最新版本：${version}`,
          available: (version: string) => `发现新版本：${version}`,
          unavailable: '暂未取得更新清单',
        },
        updateReasons: {
          current: '当前版本已不低于发布清单中的最新版本。',
          availableManual: '当前 Release 产物未同时签名和公证，只允许打开 GitHub Release 手动安装。',
          availableInstallable: '发现新版本，产物已签名并公证，可下载后安装。',
          noArtifact: '发现新版本，但没有匹配本机架构的 macOS 产物。',
          unavailable: '无法读取 GitHub Release 发布清单。',
        },
        waitingForLabels: {
          'Apple signing certificate': '等待 Apple 签名证书',
          'Apple notarization credentials': '等待 Apple 公证凭据',
          'GitHub Release workflow': '等待 GitHub Release 工作流',
          'signed and notarized artifacts': '需要已签名和公证的发布产物',
        },
        installHelp: (automatic: boolean) => (automatic ? '已签名与公证，可下载后安装。' : '下载安装需要签名与公证；当前只打开 GitHub Release 手动安装。'),
        checking: '检查中',
        checkUpdates: '检查更新',
        versionAria: '软件更新版本',
        versionTitle: '版本',
        checkedAt: (value: string) => `检查时间 ${value}`,
        notChecked: '尚未完成远端检查',
        currentVersion: (version: string) => `当前版本：${version}`,
        latestVersion: (version: string) => `最新版本：${version}`,
        updateChannelLabels: {
          stable: '稳定频道',
          preview: '预览频道',
        },
        artifactAria: '软件更新安装包',
        artifactTitle: '安装包',
        artifactKindLabels: {
          dmg: 'DMG 安装包',
          zip: 'ZIP 压缩包',
        },
        waitingArtifact: '等待匹配本机架构',
        noArtifact: '暂无匹配本机架构的安装包。',
        updateFailed: '更新检查失败，请稍后重试。',
        recommendedActions: {
          none: '无需更新',
          open_download_page: '打开下载页',
          download_and_install: '下载并安装',
        },
      },
      data: {
        paneTitle: '缓存与数据设置',
        portabilityAria: '缓存与数据导入导出',
        localLogDirectoryTitle: '本地日志目录',
        localLogDirectoryDescription: '导出会在本机脱敏保存，不上传业务数据。',
        notImportedExported: '尚未导入/导出',
        exportSettings: '导出设置',
        importSettings: '导入设置',
        clearCache: '清理缓存',
        exported: (target: string) => `最近导出：${target}，密钥已脱敏`,
        imported: (target: string, changed: string) => `最近导入：${target}，${changed}`,
        noSettingsChanged: '无设置变更',
      },
    },
    gitDiffWorkspace: {
      drawerAria: '代码变更',
      title: '代码变更',
      exportPatch: '导出 Patch',
      worktreeStateAria: 'Git 工作区状态',
      worktreeStateTitle: 'Git 工作区状态',
      cleanStatus: '干净',
      changedStatus: (count: number) => `有 ${count} 个变更`,
      worktreeMeta: (conflicts: number, remoteBranches: number, latestCommit?: string) => `冲突 ${conflicts} · 远程分支 ${remoteBranches}${latestCommit ? ` · 最近提交 ${latestCommit}` : ''}`,
      changedFilesAria: '变更文件列表',
      emptyChangedFiles: '当前仓库暂无已读取变更。',
      fileReviewAria: (path: string) => `${path} 变更审查`,
      fileDiffTitle: (path: string) => `文件级 Diff：${path}`,
      pendingDecision: '未决策',
      hunkActionsAria: (header: string) => `${header} 决策`,
      acceptHunk: '接受',
      rejectHunk: '拒绝',
      riskParamsAria: 'Git 高风险参数',
      riskParamsTitle: 'Git 高风险参数',
      branchNameAria: '新分支名称',
      branchNameTitle: '新分支名称',
      branchNameHelp: '用于创建并切换新分支，必须先经过 Git 高风险确认。',
      switchBranchAria: '切换已有分支',
      switchBranchTitle: '切换已有分支',
      switchBranchHelp: '只填写真实存在或准备创建的分支名，不在前端伪造 Git 状态。',
      baseRefAria: 'Git 对比基准',
      baseRefTitle: '对比基准',
      baseRefHelp: '用于生成真实 diff 的 base ref，影响审查范围。',
      stashRefAria: 'Stash 引用',
      stashRefTitle: 'Stash 引用',
      stashRefHelp: '用于选择真实 stash 记录，恢复前仍需要二次确认。',
      remoteNameAria: '远端名称',
      remoteNameTitle: '远端名称',
      remoteNameHelp: '用于 push 等远端写操作，必须来自真实 Git remote。',
      targetRefAria: '目标引用',
      targetRefTitle: '目标引用',
      targetRefHelp: '用于远端目标 ref；空值不会自动推断成安全目标。',
      rollbackTargetAria: '回滚目标',
      rollbackTargetTitle: '回滚目标',
      rollbackTargetHelp: '用于高风险回滚路径；必须经确认后才会进入执行链。',
      confirmationAria: 'Git 高风险确认',
      commitMessageAria: '提交说明',
      commitMessageTitle: '提交说明',
      commitMessageHelp: '只用于已确认的 commit 请求；为空时禁用提交确认。',
      commitMessageStatusAria: '提交说明状态',
      commitMessageStatusTitle: '提交说明状态',
      commitMessageStatusHelp: 'commit 前置条件',
      commitMessageStatusText: '用于已确认 Git commit；为空时不会执行提交',
      requestStashConfirmation: '请求暂存确认',
      requestCommitConfirmation: '请求提交确认',
      currentConfirmationAria: '当前 Git 确认状态',
      currentConfirmationTitle: '当前确认',
      confirmationStatusLabels: {
        pending: '待确认',
        confirmed: '已确认',
        rejected: '已拒绝',
      },
      patchStatusAria: 'Patch 导出状态',
      patchStatusTitle: 'Patch 状态',
      localExport: '本机导出',
      confirmationExpiryAria: 'Git 确认有效期',
      confirmationExpiryTitle: '确认有效期',
      confirmationExpiryHelp: '过期后需重新确认',
      confirmOperation: '确认 Git 操作',
      rejectConfirmation: '拒绝 Git 确认',
      rejectImpactAria: '拒绝 Git 确认影响',
      rejectImpactTitle: '拒绝影响',
      safetyBoundary: '安全边界',
      rejectImpactText: '拒绝后不会执行任何 Git 写操作',
      rejectedAria: '已拒绝 Git 确认',
      rejectedTitle: '已拒绝 Git 确认',
      rejectedHelp: '不会执行 Git 写操作',
      rejectedFallback: '用户已拒绝本次 Git 确认',
      whitelistScopeAria: 'Git 白名单执行范围',
      executionScopeTitle: '执行范围',
      whitelistCommandHelp: '白名单命令',
      whitelistCommandText: '只执行白名单 Git 命令',
      executeConfirmed: '执行已确认',
      operationStatusAria: 'Git 操作状态',
      operationStatusTitle: '操作状态',
      localExecutionChain: '本机执行链',
      patchNotExported: '尚未导出 Patch',
      operationNotExecuted: '尚未执行 Git 写操作',
      operationConfirmFailed: 'Git 操作确认失败；请重新创建确认',
      rejectStatus: '已拒绝 Git 确认；不会执行 Git 写操作',
      rejectFailed: 'Git 确认拒绝失败；请查看本地审计日志',
      commitMessageRequired: '提交需要 commit message；请重新创建带 message 的提交确认',
      executedStatus: (operation: string, args: string) => `已执行 ${operation} · git ${args}`,
      executeFailed: 'Git 写操作执行失败；请查看本地审计日志',
      patchSaved: (filePath: string | null) => `已保存 .patch 文件：${filePath}`,
      patchGenerated: (fileName: string) => `已生成只读 Patch：${fileName}`,
      unknownExpiry: '未知',
      operationLabels: {
        commit: '提交',
        stash: '暂存',
        apply_stash: '应用暂存',
        rollback: '回滚',
        branch: '创建分支',
        switch_branch: '切换分支',
        pull: '拉取',
        push: '推送',
      },
      decisionSummary: (accepted: number, rejected: number, pending: number) => `审查决策：已接受 ${accepted} · 已拒绝 ${rejected} · 待审查 ${pending} · 不执行 git apply`,
      reviewSummary: (files: number, hunks: number, added: number, deleted: number) => `${files} 个文件 · ${hunks} 个 hunk · +${added} / -${deleted}`,
    },
    codeMapWorkspace: {
      viewAria: '代码图谱视图',
      statusAria: '代码图谱状态与视图',
      contextStripAria: '代码图谱上下文',
      title: '代码图谱',
      sourceSummary: '真实来源：源码扫描生成节点、边和布局。',
      contextFactsAria: '代码图谱真实事实',
      realSource: '真实来源',
      currentView: '当前视图',
      viewSwitcherAria: '图谱视图切换',
      performanceAria: '图谱性能监控',
      viewReadPrefix: '图谱视图读取',
      realNodes: '真实节点',
      realEdges: '真实边',
      primaryGridAria: '图谱主舞台与检查器',
      stageAria: '图谱主舞台',
      inspectorAria: '图谱检查器',
      visibilityAria: '图谱节点显示控制',
      hiddenNodes: (count: number) => `已隐藏 ${count} 个节点`,
      restoreAllNodes: '恢复全部节点',
      secondaryToolsAria: '图谱二级工具',
      toolSwitchAria: '图谱工具切换',
      tools: {
        runtime: { label: '图谱渲染诊断', description: '校验静态图谱渲染' },
        search: { label: '搜索与筛选', description: '先定位节点' },
        qa: { label: '图谱问答', description: '基于来源提问' },
        mermaid: { label: 'Mermaid', description: '导出当前视图' },
        entities: { label: '节点与边', description: '查看来源清单' },
      },
      searchPanelAria: '搜索与筛选',
      searchFilterAria: '图谱搜索过滤',
      nodeSearchAria: '搜索节点/字段',
      nodeSearchTitle: '搜索节点/字段',
      nodeSearchHelp: '按节点名、字段或来源路径定位',
      nodeTypeAria: '筛选类型',
      nodeTypeTitle: '筛选类型',
      nodeTypeHelp: '限制节点类别',
      edgeTypeAria: '边类型',
      edgeTypeTitle: '边类型',
      edgeTypeHelp: '限制调用或数据关系',
      minConfidenceAria: '最低置信度',
      minConfidenceTitle: '最低置信度',
      minConfidenceHelp: '过滤低置信边',
      searchAction: '搜索',
      resultCount: (count: number) => `${count} 个结果`,
      qaPanelAria: '图谱问答',
      qaComposeAria: '图谱提问',
      qaModeRailAria: '图谱问答模式状态',
      askGraphTitle: '向图谱提问',
      askGraphHelp: '回答必须由真实 AI Runtime 基于图谱来源生成；来源不足时会明确说明不足以判断。',
      questionAria: '图谱问题输入',
      questionTitle: '问题',
      questionHelp: '围绕当前真实图谱提问',
      askGraphAction: '向图谱提问',
      explainNodeQuestion: (name: string, source: string) => `解释图谱节点 ${name}，来源 ${source}`,
      nodeDetail: '节点详情',
      edgeDetail: '边详情',
      currentSelection: '当前对象',
      nodeSource: '节点来源',
      edgeSource: '边来源',
      lineLabel: '行',
      missingSymbol: '未绑定 symbol',
      graphRuntime: '图谱渲染诊断',
      runtimeToolCollapsed: '该工具只用当前静态图谱校验 Sigma 与 React Flow 渲染，不代表真实运行调用链。',
      sequenceRuntimeHidden: '时序图和方法逻辑图已经是主舞台，不再叠加静态渲染诊断。',
      sigmaTitle: 'Sigma WebGL 大图',
      sigmaSourceAria: 'Sigma 图谱真实来源',
      sigmaEmpty: '当前没有真实节点，WebGL 渲染诊断保持空态。',
      reactFlowTitle: 'React Flow 局部图',
      reactFlowEdgesAria: 'React Flow 真实边',
      reactFlowEmpty: '当前没有真实局部图节点。',
      graphCanvas: '代码图谱画布',
      sequenceGraphCanvas: '时序图画布',
      canvasEmpty: '当前筛选没有真实节点；调整搜索条件后会展示由源码扫描生成的节点和边。',
      aggregatedEdges: '聚合边',
      nodeCount: (count: number) => `${count} 个节点`,
      edgeCount: (count: number) => `${count} 条边`,
      lifelineCount: (count: number) => `${count} 条生命线`,
      aggregatedEdgeCount: (count: number) => `${count} 条聚合边`,
      serverLayout: '服务端布局',
      canvasSourcesAria: '画布源码来源',
      openSourceShortcut: '按 O 打开源码',
      createTaskShortcut: '按 T 创建任务',
      graphNodeTaskStatusAria: '图谱节点任务创建状态',
      graphNodeTaskCreating: '正在从节点创建任务',
      graphNodeTaskCreated: '已从节点创建任务，正在打开任务列表',
      graphNodeTaskCreateFailed: '节点任务创建失败，请查看本地错误提示后重试。',
      graphNodeTaskRetry: '重试',
      graphNodeTaskRetryAria: '重试从当前图谱节点创建任务',
      graphAnswerAria: '图谱问答回答',
      runtimeSessionLabel: 'Runtime 会话',
      insufficientRuntimeSession: '来源不足，未启动 Runtime 会话',
      qaHistoryAria: '图谱问答历史',
      qaHistoryToolbarAria: '图谱问答历史工具栏',
      qaHistorySearchAria: '搜索图谱问答历史',
      searchHistoryTitle: '搜索历史',
      searchHistoryHelp: '只查真实问答记录',
      searchHistoryAction: '搜索历史',
      viewActiveHistory: '查看未归档',
      viewArchivedHistory: '查看归档',
      realQaCount: (count: number) => `${count} 条真实问答`,
      qaHistoryEmptyAria: '图谱问答历史空态',
      noRealQaHistory: '暂无真实问答历史',
      noMatchingQaHistory: '没有匹配的真实图谱问答；换个关键词或查看未筛选历史。',
      qaHistoryEmptyHelp: '完成一次问答后会在这里展示问题、回答和来源。',
      answerNotGenerated: '未生成回答',
      viewDetail: '查看详情',
      createTaskFromQa: '从问答创建任务',
      graphConversationTaskIntent: '基于这次图谱问答创建可执行跟进任务',
      graphNodeTaskIntent: '分析该图谱节点的实现风险、影响范围和建议验收范围',
      restoreHistory: '恢复历史',
      archiveHistory: '归档历史',
      qaPaginationAria: '图谱问答历史分页',
      previousPage: '上一页',
      nextPage: '下一页',
      pageRangeEmpty: '第 0-0 条',
      pageRange: (start: number, end: number) => `第 ${start}-${end} 条`,
      qaDetailAria: '图谱问答详情',
      qaDetailStatusAria: '图谱问答详情状态',
      archivedStatus: '已归档',
      activeStatus: '未归档',
      conversationStatusLabels: {
        open: '进行中',
        starting: '启动中',
        queued: '排队中',
        running: '进行中',
        active: '进行中',
        exited: '待继续',
        failed: '失败',
        stopped: '已停止',
        lost: '已丢失',
        orphan_detected: '待接管',
        closed: '已关闭',
        completed: '已完成',
        archived: '已归档',
      },
      messageCount: (count: number) => `${count} 条消息`,
      qaMessagesAria: '图谱问答消息',
      assistantAnswer: 'AI 回答',
      userQuestion: '用户问题',
      messageSourceLabels: {
        graph_question: '来源：图谱问题',
        graph_answer: '来源：图谱回答',
      },
      mermaidPanelAria: 'Mermaid 导出',
      mermaidPreviewAria: 'Mermaid 预览',
      mermaidExportCommandsAria: 'Mermaid 导出命令',
      diagramFormatAria: '图表源码格式',
      mermaidPreviewTitle: 'Mermaid 预览',
      plantUmlPreviewTitle: 'PlantUML 预览',
      mermaidSequencePreviewTitle: 'Mermaid 时序图预览',
      plantUmlSequencePreviewTitle: 'PlantUML 时序图预览',
      mermaidPreviewHelp: '基于当前真实可见节点和边生成 Mermaid 文本；PlantUML 可切换导出给成熟 UML 工具链；不渲染假图，也不引入额外依赖。',
      hideMermaidSource: '隐藏 Mermaid 源码',
      generateMermaidPreview: '生成 Mermaid 预览',
      exportMermaidSource: '导出 Mermaid 源码',
      mermaidSavedStatus: (filePath: string) => `已保存 Mermaid 源码：${filePath}`,
      mermaidGeneratedStatus: (fileName: string) => `已生成 Mermaid 源码：${fileName}`,
      mermaidSaveFailedStatus: 'Mermaid 源码保存失败；已保留当前预览文本，可复制后手动保存。',
      mermaidSourceAria: 'Mermaid 源码',
      mermaidEmptyAria: 'Mermaid 预览未生成',
      mermaidEmptyTitle: '预览未生成',
      mermaidEmptyHelp: '点击生成后只展示当前筛选后仍可见的真实节点与边。',
      mermaidStatusAria: 'Mermaid 导出状态',
      mermaidGeneratedFile: (fileName: string, mimeType: string) => `已生成 ${fileName} · ${mimeType}`,
      entityPanelAria: '节点与边列表',
      entityWorkbenchAria: '图谱节点与边来源',
      graphNodesAria: '图谱节点',
      graphNodesTitle: '图谱节点',
      realNodeCount: (count: number) => `${count} 个真实节点`,
      sourceCount: (count: number) => `${count} 个来源`,
      aggregatedNodeSummary: (count: number, sourceCount: number) => `聚合 ${count} 个真实节点 · ${sourceCount} 个来源`,
      aggregateNodeLabel: '聚合节点',
      createTaskFromNode: '从节点创建任务',
      openSource: '打开源码',
      graphSourceOpenStatusAria: '源码打开状态',
      graphSourceOpenOpening: '正在打开源码',
      graphSourceOpenOpened: '源码已打开',
      graphSourceOpenFailed: '源码打开失败',
      restoreNode: '恢复节点',
      hideNode: '隐藏节点',
      openNodeMenu: '打开节点菜单',
      nodeActionMenuAria: '节点操作菜单',
      graphEdgesAria: '图谱边',
      graphEdgesTitle: '图谱边',
      realEdgeCount: (count: number) => `${count} 条真实边`,
      aggregatedEdgeSummary: (count: number, sourceCount: number) => `聚合 ${count} 条真实边 · ${sourceCount} 个来源`,
      confidenceValue: (confidence: string) => `置信度 ${confidence}`,
      confidenceUnknown: '置信度未知',
      aiSummary: 'AI 摘要',
      recentTasks: '最近任务',
      unnamedTask: '未命名任务',
      unknownTaskStatus: '未知状态',
      oneHopNeighbors: '一跳邻居',
      twoHopImpact: '二跳影响范围',
      riskTags: '风险标签',
      nodeActions: {
        inspectDetail: '查看详情',
        openSource: '打开源码',
        askNode: '提问此节点',
        generateSequence: '生成时序图',
        generateFlow: '生成流程图',
        expandOneHop: '展开一跳',
        expandTwoHop: '展开二跳',
        createTask: '从节点创建任务',
        restoreNode: '恢复节点',
        hideNode: '隐藏节点',
      },
    },
  },
  'en-US': {
    shellAriaLabel: 'Zeus macOS AI native development workbench · Motion respects reduced motion',
    documentLang: 'en',
    languages: {
      'zh-CN': 'Simplified Chinese',
      'en-US': 'English',
    },
    appearance: {
      system: 'Follow system',
      light: 'Light',
      dark: 'Dark',
    },
    workModes: {
      plan: 'Plan',
      develop: 'Develop',
      review: 'Review',
      debug: 'Debug',
    },
    taskStatuses: {
      '': 'All',
      draft: 'Draft',
      ready: 'Ready',
      running: 'Running',
      paused: 'Paused',
      waiting_confirmation: 'Waiting for confirmation',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    taskEventTypeLabels: {
      'task.created': 'Task created',
      'task.status.changed': 'Task status changed',
      'task.updated': 'Task updated',
      'task.tags.updated': 'Task tags updated',
      'task.archived': 'Task archived',
      'task.restored': 'Task restored',
      'task.deleted': 'Task deleted',
      'task.runtime.queued': 'Task runtime queued',
      'task.runtime.run': 'Task runtime run',
      'task.runtime.continue': 'Task runtime continue',
      'task.runtime.pause': 'Task runtime pause',
      'task.runtime.cancel': 'Task runtime cancel',
      'task.created.from_template': 'Task created from template',
      'task.created.from_graph_question': 'Task created from graph question',
      'task.created.from_graph_view': 'Task created from graph view',
      'task.created.from_graph_node': 'Task created from graph node',
      'task.created.from_runtime_session': 'Task created from Runtime session',
      'task.linked_graph_node': 'Linked graph node',
      'graph.node.writeback': 'Graph node writeback',
      'runtime.session.recovered': 'Runtime session recovered',
      'telegram.notification.sent': 'Telegram notification sent',
      'telegram.notification.failed': 'Telegram notification failed',
      'telegram.runtime.summary.sent': 'Telegram Runtime summary sent',
      'telegram.runtime.summary.failed': 'Telegram Runtime summary failed',
      'telegram.run': 'Telegram run',
      'telegram.stop': 'Telegram stop',
      'telegram.continue': 'Telegram continue',
      'telegram.status.changed': 'Telegram status changed',
    },
    taskEventTypeSegments: {
      task: 'Task',
      created: 'created',
      status: 'status',
      changed: 'changed',
      updated: 'updated',
      archived: 'archived',
      restored: 'restored',
      deleted: 'deleted',
      runtime: 'Runtime',
      queued: 'queued',
      run: 'run',
      continue: 'continue',
      pause: 'pause',
      cancel: 'cancel',
      graph: 'graph',
      node: 'node',
      writeback: 'writeback',
      linked: 'linked',
      from: 'from',
      view: 'view',
      question: 'question',
      template: 'template',
      session: 'session',
      recovered: 'recovered',
      telegram: 'Telegram',
      notification: 'notification',
      sent: 'sent',
      failed: 'failed',
      summary: 'summary',
      stop: 'stop',
      confirmation: 'confirmation',
      requested: 'requested',
      expired: 'expired',
      confirmed: 'confirmed',
      cancelled: 'cancelled',
    },
    taskSorts: {
      title: 'Title',
      managementStatus: 'Task status',
      createdAt: 'Created',
      updatedAt: 'Updated',
    },
    graphNodeTypes: {
      '': 'All',
      file: 'File',
      function: 'Function',
      package: 'Package',
      module: 'Module',
      class: 'Class',
      interface: 'Interface',
      type: 'Type',
      enum: 'Enum',
      config: 'Config',
      dependency: 'Dependency',
      api: 'API',
      table: 'Table',
      column: 'Column',
      control_flow: 'Control flow',
      aggregate: 'Aggregate',
    },
    graphEdgeTypes: {
      '': 'All',
      declares: 'Declares',
      contains: 'Contains',
      calls: 'Calls',
      reads_table: 'Reads table',
      writes_table: 'Writes table',
      awaits_call: 'Awaits call',
      branch_false: 'False branch',
      branch_true: 'True branch',
      control_flow: 'Control flow',
      emits: 'Emits',
      executes: 'Executes',
      executes_sql: 'Executes SQL',
      exposes_api: 'Exposes API',
      handles_api: 'Handles API',
      loop_back: 'Loop back',
      loop_break: 'Loop break',
      loop_continue: 'Loop continue',
      module_depends_on: 'Module depends on',
      next_control_flow: 'Next control flow',
      promise_catch: 'Promise catch',
      promise_then: 'Promise then',
      references: 'References',
      resolves_to: 'Resolves to',
      try_catch: 'Try catch',
      try_finally: 'Try finally',
      uses_column: 'Uses column',
    },
    graphViewTypes: {
      architecture: 'Architecture',
      module: 'Module',
      table: 'Table relationships',
      module_detail: 'Module detail',
      api_sequence: 'API sequence',
      module_flow: 'Module flow',
      method_logic: 'Method logic',
    },
    localOperationFailed: 'Local operation failed',
    sidebar: {
      ariaLabel: 'Project-first navigation',
      quickActionsLabel: 'Quick actions',
      newChat: 'New chat',
      search: 'Search',
      projects: 'Projects',
      projectListLabel: 'Project list',
      selectRepository: 'Choose local repository',
      selectedRepositoryDescription: 'User selected a real local repository',
      cancelledRepositoryDescription: 'User cancelled selection; existing projects are unchanged',
      creatingRepository: 'Creating',
      selectLocalRepository: 'Choose local repository',
      noProjectMatches: 'No matching projects',
      addProject: 'Add project',
      createDialogTitle: 'Create project',
      createNameLabel: 'Project name',
      createNamePlaceholder: 'Project name',
      createFolderLabel: 'Project folder',
      createFolderHelp: 'Choose one local folder that Zeus can read, index, and use for task execution.',
      createChooseFolder: 'Choose a folder Zeus can read and edit',
      createChangeFolder: 'Change folder',
      createCancel: 'Cancel',
      createSubmit: 'Create project',
      createSubmitting: 'Creating',
      createNameRequired: 'Project name is required',
      createFolderRequired: 'Choose a project folder first',
      projectSettingsPrefix: 'Project settings',
      expandProjectPrefix: 'Expand project',
      collapseProjectPrefix: 'Collapse project',
      moreProjectActionsPrefix: 'More project actions',
      projectMenuSuffix: 'project menu',
      pinProject: 'Pin project',
      unpinProject: 'Unpin project',
      revealProjectInFinder: 'Reveal in Finder',
      renameProject: 'Rename project',
      deleteProject: 'Delete project',
      confirmDeleteProject: 'Confirm delete project',
      deleteProjectHint: 'Only removes the Zeus project record, not the local folder',
      renameDialogTitle: 'Rename project',
      renameDialogHelp: 'Only changes the display name in Zeus. The local folder and repository path stay unchanged.',
      renameLabel: 'Project display name',
      renamePlaceholder: 'Enter project name',
      renameCancel: 'Cancel',
      renameSave: 'Save',
      renameSaving: 'Saving',
      renameRequired: 'Project name is required',
      pinned: 'Pinned',
      labelSeparator: ': ',
      sections: {
        tasks: 'Tasks',
        code: 'Code',
        sessions: 'Sessions',
        commands: 'Commands',
      },
      current: 'Current',
      globalSettingsLabel: 'Global settings',
      settings: 'Settings',
    },
    taskWorkspace: {
      viewAria: 'Project tasks',
      listAria: 'Task list',
      filterAria: 'Task filters and creation',
      searchAria: 'Search tasks',
      searchTitle: 'Search tasks',
      searchHelp: 'Title or description',
      conditionsAria: 'Task filter conditions',
      statusAria: 'Task status',
      statusSelectAria: 'Task status filter',
      taskStatusSelectAria: (taskTitle: string) => `Change task status: ${taskTitle}`,
      detailStatusSelectAria: 'Change current task status',
      statusTitle: 'Status',
      unfinishedStatusFilter: 'Unfinished',
      statusHelp: 'Show one progress state',
      sortAria: 'Task sort',
      sortSelectAria: 'Task sort',
      sortTitle: 'Sort',
      selectSearchPlaceholder: 'Search options',
      selectNoResults: 'No matching options',
      rowMetaTitle: 'Source',
      defaultTaskLabel: 'Default task',
      templateTaskLabel: 'Template task',
      sortHelp: 'List order',
      tagsAria: 'Task tags',
      tagFilterAria: 'Task tag filter',
      tagsTitle: 'Tags',
      tagsHelp: 'Filter by one tag',
      filterActionsAria: 'Task filter actions',
      filterAction: 'Filter',
      newTask: 'New task',
      taskCreateDialogTitle: 'Create task',
      taskCreateTitleLabel: 'Task title',
      taskCreateTitlePlaceholder: 'For example: Fix task table column visibility',
      taskCreateDescriptionLabel: 'Task request / intent',
      taskCreateDescriptionPlaceholder: 'Describe the expected behavior, acceptance criteria, and required context',
      taskCreatePriorityLabel: 'Priority',
      taskCreatePriorityOptions: [
        { value: 'p0', label: 'P0: Start handling immediately' },
        { value: 'p1', label: 'P1: Urgent and important' },
        { value: 'p2', label: 'P2: Urgent, not important' },
        { value: 'p3', label: 'P3: Important, not urgent' },
        { value: 'p4', label: 'P4: Not important or urgent' },
      ],
      taskCreateTagsLabel: 'Tags',
      taskCreateTagsPlaceholder: 'Optional, comma separated',
      taskCreateAttachmentsLabel: 'Images and attachments',
      taskCreateAttachmentsHint: 'Choose, paste, or drop files, folders, and long text',
      taskCreateChooseAttachments: 'Add images or files',
      taskCreateRemoveAttachment: 'Remove attachment',
      taskCreateImageAttachment: 'Image',
      taskCreateFileAttachment: 'File',
      taskCreateOpenAttachment: 'Open attachment',
      taskCreatePreviewAttachment: 'Preview attachment',
      taskCreatePreviewClose: 'Close attachment preview',
      taskCreatePreviewUnavailable: 'Preview unavailable. Local path saved.',
      taskCreateLocalPathLabel: 'Local path',
      taskCreateAttachmentAddedStatus: (count: number) => `Added ${count} attachment${count === 1 ? '' : 's'}. Images preview larger; files open locally.`,
      taskCreateAttachmentPickerFailed: 'Unable to open the attachment picker. Try again.',
      taskCreatePasteAttachmentFailed: 'Unable to save pasted images or files. Try again.',
      taskCreateCancel: 'Cancel',
      taskCreateSubmit: 'Create task',
      taskCreateSubmitting: 'Creating',
      taskCreateClose: 'Close create task dialog',
      taskCreateTitleRequired: 'Enter a task title',
      taskCreateSubmitFailed: 'Task creation failed. Your input is preserved for retry.',
      today: 'Today',
      emptyTitle: 'No tasks yet',
      emptyHelp: 'Create the first engineering task with New task. Task status, run status, and updated time will appear after creation.',
      emptySecondaryAction: 'View project code',
      emptyOutcomeStatus: 'Status updates as work moves',
      emptyOutcomeAi: 'AI Runtime state appears after launch',
      emptyOutcomeEvidence: 'Run events and sources become evidence',
      noResultsPrimaryAction: 'Clear filters',
      noResultsSecondaryAction: 'View all states',
      taskListLoadingToolbarStatus: 'Tasks loading',
      taskListLoadingTitle: 'Loading tasks',
      taskListLoadingHelp: 'Keeping the current table frame in place.',
      taskListLoadingMeta: 'Waiting for local data',
      taskListErrorToolbarStatus: 'Tasks unavailable',
      taskListErrorTitle: 'Unable to read task list',
      taskListErrorHelp: 'Retry, or confirm local path permissions in project settings. Error details are written only to local logs.',
      taskListErrorRetry: 'Retry',
      taskListErrorProjectSettings: 'Project settings',
      noResultsTitle: 'No matching tasks',
      noResultsHelp: 'Filters apply immediately. Adjust search, status, or tag to restore the list.',
      archiveAria: 'Archived tasks',
      archiveTitle: 'Archived tasks',
      itemUnit: 'items',
      restoreTask: 'Restore task',
      detailAria: 'Task management detail',
      statusRowAria: 'Task management',
      statusRowTitle: 'Task management',
      noProjectSelected: 'No project selected',
      workbenchAria: 'Task management workbench',
      statusBoardAria: 'Task status overview',
      currentStatus: 'Current status',
      noTags: 'No tags',
      aiCliLabel: 'AI CLI',
      telegramLabel: 'Telegram',
      aiDetected: 'Detected',
      aiNotConfigured: 'Not configured',
      taskCodeLabel: 'Task code',
      priorityLabel: 'Priority',
      sourceLabel: 'Context source',
      updatedAtLabel: 'Updated',
      runtimeSessionLabel: 'Runtime session',
      runtimeCommandLabel: 'Command / status',
      latestEvidenceLabel: 'Latest evidence',
      noEvidence: 'No execution evidence yet',
      attachmentsTitle: 'Images and attachments',
      imageAttachmentLabel: 'Image',
      fileAttachmentLabel: 'File',
      openFileAttachmentLabel: 'Open attachment',
      previewAttachmentLabel: 'Preview attachment',
      previewCloseLabel: 'Close attachment preview',
      previewUnavailableLabel: 'Preview unavailable. Local path saved.',
      localPathLabel: 'Local path',
      runtimeSessionNotStarted: 'Runtime session not started',
      runtimeCommandMissing: 'No runtime command recorded',
      nextActionLabels: {
        draft: 'Can start AI',
        ready: 'Can start AI',
        running: 'Waiting for AI output',
        paused: 'Can continue',
        waiting_confirmation: 'Needs my confirmation',
        completed: 'Completed',
        failed: 'Can retry',
        cancelled: 'Cancelled',
      },
      sourceLabels: {
        graph_node: 'Graph node',
        graph_view: 'Code graph',
        runtime_session: 'Runtime session',
        template: 'Task template',
        graph_question: 'Graph Q&A',
        manual: 'Manual',
        user: 'Manual',
      },
      updatedAtMissing: 'Not recorded',
      sensitiveCommandArgument: '***',
      runtimeSessionStatusLabels: {
        running: 'Running',
        exited: 'Exited',
        failed: 'Failed',
        stopped: 'Stopped',
        orphan_detected: 'Orphan detected',
        lost: 'Lost',
      },
      telegramEnabled: 'Enabled',
      telegramDisabled: 'Disabled',
      contentAria: 'Task management content',
      requestAria: 'Task request',
      requestTitle: 'Task request',
      noRequest: 'No task request yet. Add the next requirement below.',
      eventsAria: 'Task events',
      eventsTitle: 'Task events',
      noEvents: 'No events yet. Status changes and new conversations will appear here as real records.',
      commandDockAria: 'Task progress commands',
      statusActionsAria: 'Task status actions',
      runTask: 'Push to model',
      viewConversation: 'View conversation',
      pushNewConversation: 'Push to new conversation',
      conversationsTitle: 'Linked conversations',
      conversationEmptyTitle: 'No linked conversations yet',
      conversationEmptyHelp: 'A push creates a new conversation without replacing history.',
      conversationLoading: 'Loading linked conversations…',
      conversationError: 'Linked conversations could not be refreshed',
      openConversation: 'Open conversation',
      retryConversationLoad: 'Reload',
      markComplete: 'Mark complete',
      cancelTask: 'Cancel task',
      retryTask: 'Retry task',
      detailPaneLabel: 'Task details',
      detailPaneBackdrop: 'Close task details',
      detailPaneClose: 'Close',
      openTaskDetail: 'Open task details',
      taskCountPrefix: 'Tasks',
      filteredState: 'Filtered',
      allState: 'All states',
      codeColumnTitle: 'Task code',
      intentColumnTitle: 'Task',
      managementStatusColumnTitle: 'Task status',
      runStatusColumnTitle: 'Run status',
      sourceColumnTitle: 'Context source',
      createdAtColumnTitle: 'Created',
      updatedAtColumnTitle: 'Updated',
      priorityColumnTitle: 'Priority',
      projectColumnTitle: 'Project',
      templateColumnTitle: 'Template',
      descriptionColumnTitle: 'Description',
      runtimeSessionColumnTitle: 'Runtime session',
      rawIdColumnTitle: 'Raw task ID',
      createdFromColumnTitle: 'Created from',
      fieldSettings: 'Columns',
      fieldSettingsAria: 'Customize task fields',
      fieldSettingsHelp: 'Show, hide, or reorder task table fields.',
      restoreDefaultColumns: 'Restore default fields',
      requiredColumnReason: 'Required column; cannot be hidden',
      moveColumnUpAria: (columnTitle: string) => `Move field up: ${columnTitle}`,
      moveColumnDownAria: (columnTitle: string) => `Move field down: ${columnTitle}`,
      compactColumnAria: (columnTitle: string) => `Use compact width for: ${columnTitle}`,
      standardColumnAria: (columnTitle: string) => `Use standard width for: ${columnTitle}`,
      wideColumnAria: (columnTitle: string) => `Use wide width for: ${columnTitle}`,
      selectTaskAria: (taskTitle: string) => `Select task: ${taskTitle}`,
      selectAllVisibleTasks: 'Select current results',
      clearTaskSelection: 'Clear selection',
      bulkSelectedCount: (count: number) => `${count} selected`,
      bulkStatusTargetAria: 'Bulk status target',
      bulkStatusTargetTitle: 'Bulk status',
      bulkApplyStatus: 'Apply status',
      bulkDelete: 'Bulk delete',
      bulkDeleteConfirm: (count: number, skippedCount: number) => `Delete ${count} tasks?${skippedCount ? ` ${skippedCount} running or waiting tasks will be skipped.` : ''} This cannot be undone.`,
      bulkStatusSkippedHint: (eligibleCount: number, skippedCount: number) => `${eligibleCount} eligible, ${skippedCount} skipped`,
      primaryActionsTitle: 'Primary actions',
      secondaryActionsTitle: 'Secondary actions',
      dangerActionsTitle: 'Danger actions',
      metadataTitle: 'Task metadata',
      projectLabel: 'Project',
      templateLabel: 'Template',
      cancelConfirm: 'Cancel this task? Running Runtime work will receive a cancel request.',
      followUpAria: 'Request follow-up',
      followUpTitle: 'Request follow-up',
      followUpHelp: 'Add to this task without turning the task page into a chat input.',
      followUpPlaceholder: 'Add task request',
      saveRequest: 'Save request',
      modeRailAria: 'Task mode status',
      contextRailAria: 'Task context links',
      runtime: 'Runtime',
      context: 'Context',
      codeChanges: 'Code changes',
      templates: 'Templates',
      defaultTaskTitle: 'Analyze current project structure',
      defaultTaskDescription: 'Analyze the current project from real scans and Git status',
      templateTaskTitle: 'Task created from template',
      templateTaskGoal: 'Fill in the real task goal from the selected template',
    },
    sessionWorkspace: {
      viewAria: 'Project sessions',
      listAria: 'Session list',
      toolbarAria: 'Session search and creation',
      searchAria: 'Search sessions',
      searchTitle: 'Search sessions',
      searchHelp: 'Title or description',
      newChat: 'New chat',
      newChatPrompt: (projectName: string) => `What should we build in ${projectName}?`,
      newChatPlaceholder: 'Type freely',
      newChatCommandRowAria: 'New chat tools',
      composerAddContextAria: 'Add context',
      composerCustomize: 'Customize',
      composerCustomizeAria: 'Customize conversation settings',
      composerCurrentAi: (adapterName: string) => `Current AI: ${adapterName}`,
      starterListAria: 'New chat starter actions',
      starterCreateTask: 'Finish a project task',
      starterOpenCode: 'Open code graph',
      starterOpenRuntime: 'Open runtime',
      environmentTitle: 'Environment',
      environmentChanges: 'Changes',
      environmentLocalMode: 'Local mode',
      environmentBranch: 'main',
      emptyTitle: 'No sessions yet',
      emptyHelp: 'New chat creates a real session record. Clear the search term if the current filter has no matches.',
      rowType: 'Conversation',
      archiveAria: 'Archived sessions',
      archiveTitle: 'Archived sessions',
      itemUnit: 'items',
      restoreSession: 'Restore session',
      detailAria: 'Current conversation',
      aiDetected: 'AI CLI detected',
      aiNotConfigured: 'AI CLI not configured',
      telegramEnabled: 'Telegram enabled',
      telegramDisabled: 'Telegram disabled',
      threadAria: 'Current conversation',
      messageListAria: 'Task events and conversation messages',
      userRequest: 'User request',
      assistantResponse: 'AI response',
      waitingTitle: 'Waiting for next step',
      noEvents: 'No events yet. Create an app-server session or add the next requirement.',
      inputDockAria: 'Next step and conversation input',
      statusActionsAria: 'Task status actions',
      sendToConversation: 'Push to model',
      markComplete: 'Mark complete',
      cancelTask: 'Cancel task',
      followUpAria: 'Request follow-up',
      followUpTitle: 'Request follow-up',
      followUpHelp: 'Add the next requirement to this task or app-server session.',
      followUpPlaceholder: 'Request follow-up',
      send: 'Send',
      modeRailAria: 'Session mode status',
      contextRailAria: 'Conversation context links',
      runtime: 'Runtime',
      context: 'Context',
      codeChanges: 'Code changes',
      templates: 'Templates',
      secondaryDrawerLabel: 'Conversation drawer',
      secondaryDrawerBackdrop: 'Conversation drawer backdrop',
      secondaryDrawerClose: 'Close conversation drawer',
      secondaryDrawer: {
        contextLabel: 'Context',
        openGraph: 'Open graph',
        graphScopeAria: 'Graph context scope',
        graphContextTitle: 'Graph context',
        graphContextHelp: 'Real graph scope for the current project',
        graphContextMetrics: (nodes: number, edges: number, views: number) => `${nodes} ${nodes === 1 ? 'node' : 'nodes'} / ${edges} ${edges === 1 ? 'edge' : 'edges'} / ${views} ${views === 1 ? 'view' : 'views'}`,
        graphAnswerTitle: 'Graph Q&A',
        runtimeSession: (sessionId: string) => `Runtime session ${sessionId}`,
        insufficientRuntimeSession: 'Insufficient sources, Runtime session not started',
        graphConversationListAria: 'Graph Q&A sessions',
        archived: 'Archived',
        openable: 'Openable',
        changesLabel: 'Code changes',
        loadDiff: 'Load Diff',
        loadingDiff: 'Loading',
        noLoadedChangesAria: 'No loaded changes',
        noLoadedChangesTitle: 'No loaded changes',
        noLoadedChangesHelp: 'Load Diff to show real file paths.',
        changedFilesAria: 'Changed files',
        realGitDiffFile: 'Real Git diff file',
        loaded: 'Loaded',
        templatesLabel: 'Task templates',
        loadingTemplates: 'Loading',
        loadTemplates: 'Load templates',
        templateListAria: 'Task template list',
        emptyTemplatesAria: 'No task templates',
        emptyTemplatesTitle: 'No templates',
        emptyTemplatesHelp: 'Load real templates to show task prompts and creation actions here.',
        builtInTaskTemplate: 'Built-in task template',
        projectTaskTemplate: 'Project task template',
        builtInTemplate: 'Built-in template',
        projectTemplate: 'Project template',
        applyTemplate: 'Apply template',
      },
      runtimeDrawer: {
        runtimeEnvironment: 'Runtime environment',
        refresh: 'Refresh',
        runtimeStatus: 'Runtime status',
        detectedCommand: (command: string) => `Detected ${command}`,
        waitingForCommand: (command: string) => `Waiting for ${command}`,
        terminalBackend: 'Terminal backend',
        terminalPending: 'node-pty status is pending.',
        runtimeSessions: 'AI Runtime sessions',
        startRuntimeSession: 'Start Runtime session',
        runtimeSessionSearch: 'Runtime session search',
        searchSessions: 'Search sessions',
        searchSessionsHelp: 'Command, path, or summary',
        favoritesOnly: 'Favorites only',
        showArchived: 'Show archived',
        applyFilters: 'Apply filters',
        emptyRuntimeSessions: 'No real Runtime sessions yet.',
        runtimeSessionStatusLabels: {
          running: 'Running',
          exited: 'Exited',
          failed: 'Failed',
          stopped: 'Stopped',
          orphan_detected: 'Orphan detected',
          lost: 'Lost',
        },
        runtimeAdaptersAria: 'Runtime adapters',
        runtimeAdaptersTitle: 'Runtime adapters',
        codexCliDisplayName: 'OpenAI Codex CLI',
        genericShellDisplayName: 'Generic shell',
        adapterAvailable: 'Available',
        adapterUnavailable: 'Unavailable',
        adapterUnchecked: 'Not checked',
        checkAdapter: 'Check adapter',
        adapterCapabilities: (capabilities: string) => `Capabilities: ${capabilities}`,
        adapterVersion: (version: string) => `Version: ${version}`,
        adapterAuthStatus: (status: string) => `Auth status: ${status}`,
        adapterModelConfig: (modelConfiguration: string) => `Model config: ${modelConfiguration}`,
        adapterAuthAuthenticated: 'Authenticated',
        adapterAuthUnauthenticated: 'Not signed in',
        adapterAuthUnknown: 'Unknown',
        adapterVersionUnknown: 'Not read',
        adapterModelUserConfigured: 'User configured',
        genericShellRiskAria: 'Generic shell high-risk confirmation',
        genericShellRiskTitle: 'Generic shell high-risk confirmation',
        genericShellCommandAria: 'Generic shell command',
        genericShellCommandTitle: 'Generic shell command',
        genericShellCommandHelp: 'Starts a real local command once through sh -lc. Create a fresh confirmation after changes.',
        genericShellCommandPlaceholder: 'For example pnpm --version',
        genericShellChangedStatus: 'Command changed. Create a new Generic shell confirmation.',
        genericShellConfirmationIdle: 'No Generic shell confirmation yet',
        genericShellConfirmationCreated: (confirmationId: string) => `Created confirmation ${confirmationId}. It is bound to this sh -lc only.`,
        genericShellConfirmationCreateFailed: 'Failed to create Generic shell confirmation',
        genericShellConfirmationRejectFailed: 'Failed to reject Generic shell confirmation',
        genericShellCriticalPhraseRequired: (phrase: string) => `Enter ${phrase} manually before starting this critical command`,
        genericShellConfirmationConsumed: (confirmationId: string) => `Consumed confirmation ${confirmationId} and started a Generic shell session.`,
        genericShellConfirmationFailed: 'Generic shell confirmation or startup failed',
        commandPreviewAria: 'Generic shell command preview',
        commandPreviewTitle: 'Command preview',
        commandPreviewHelp: 'This sh -lc preview',
        emptyShellCommand: 'No shell command entered yet',
        genericShellRiskSummary: (label: string, reason: string) => `${label}: ${reason}. Confirmation is bound to this sh -lc only.`,
        criticalPhraseAria: 'Critical command confirmation phrase',
        criticalPhraseTitle: 'Critical command confirmation phrase',
        criticalPhraseHelp: (phrase: string) => `A critical command was detected. Enter ${phrase} exactly before starting.`,
        confirmationStateAria: 'Generic shell confirmation state',
        confirmationStateTitle: 'Confirmation state',
        confirmationStateHelp: 'Bound to this command',
        rejectedAria: 'Rejected Generic shell confirmation',
        rejectedTitle: 'Rejected Generic shell confirmation',
        rejectedHelp: 'Runtime session will not start',
        rejectedReasonFallback: 'The user rejected this one-time confirmation.',
        createGenericShellConfirmation: 'Create Generic shell confirmation',
        rejectGenericShellConfirmation: 'Reject Generic shell confirmation',
        confirmAndStartGenericShell: 'Confirm and start Generic shell',
        rejectImpactAria: 'Generic shell rejection impact',
        rejectImpactTitle: 'Rejection impact',
        rejectImpactHelp: 'Safety boundary',
        rejectImpactBody: 'Rejected commands will not start a Runtime session.',
        sessionSummaryFallback: 'No summary generated',
        runtimeSessionActionsAria: 'Runtime session actions',
        generateSummary: 'Generate summary',
        createTaskFromSession: 'Create task from session',
        taskDraftTitle: (command: string) => `Continue session: ${command}`,
        taskDraftInstruction: 'Continue the follow-up analysis from the real Runtime session logs.',
        unfavoriteSession: 'Remove favorite',
        favoriteSession: 'Favorite session',
        restoreSession: 'Restore session',
        archiveSession: 'Archive session',
        exportCurrentLog: 'Export current log',
        deleteSession: 'Delete session',
        runtimeInputAria: 'Runtime input',
        runtimeInputSendAria: 'Send Runtime input',
        runtimeInputTitle: 'Runtime input',
        runtimeInputHelp: 'Sends only to the current running session',
        sendRuntimeInput: 'Send Runtime input',
        terminalControlsAria: 'Runtime terminal controls',
        interrupt: 'Interrupt',
        resizeTerminal: 'Resize terminal',
        loadTerminalSnapshot: 'Load terminal snapshot',
        stopSession: 'Stop session',
        orphanControlsAria: 'Runtime orphan session controls',
        unknownPid: 'Unknown',
        orphanTitle: (pid: string | number) => `Process ${pid} is outside current Runtime control`,
        orphanHelp: 'Only terminates the remaining local process. Input, logs, or AI session state will not be restored.',
        orphanStop: 'Terminate orphan session',
        logsAria: 'Real Runtime logs',
        logsTitle: 'Real Runtime logs',
        logsHelp: 'Raw output viewer',
        logActionsAria: 'Runtime log actions',
        copyLogs: 'Copy current logs',
        expandLogs: 'Expand logs',
        collapseLogs: 'Collapse logs',
        logSearchAria: 'Runtime log search',
        logSearchTitle: 'Search logs',
        logSearchHelp: 'Filters only the real logs currently loaded',
        logExportIdle: 'No Runtime log export yet',
        logExportEmpty: 'No real Runtime logs to export',
        logExportCancelled: 'Runtime log export cancelled',
        logExportFailed: 'Runtime log export failed',
        logExportSaved: (filePath: string) => `Last Runtime log export: ${filePath}`,
        logCopyIdle: 'No Runtime log copy yet',
        logCopyEmpty: 'No real Runtime logs to copy',
        logCopySuccess: 'Current logs copied',
        logCopyFailed: 'Copy current logs failed',
        logExportState: (exportStatus: string, copyStatus: string) => `Log export only saves the real Runtime logs currently loaded · ${exportStatus} · ${copyStatus}`,
        logLegend: 'Error highlight / command highlight / AI reply highlight',
        rawOutputAria: 'Raw output viewer',
        collapsedLogs: 'Logs collapsed. Expand logs to view them.',
        terminalAria: 'xterm Runtime terminal',
      },
    },
    codeWorkspace: {
      detailAria: 'Current project status',
      repositoryAria: 'Current repository',
      stateProjectSettings: 'Project settings',
      stateCodeGraph: 'Code and graph',
      overviewAria: 'Code repository and graph overview',
      contextRailAria: 'Repository context',
      repositoryStatusAria: 'Repository status',
      repositoryStatusTitle: 'Repository status',
      localPath: 'Local path',
      scan: 'Scan',
      git: 'Git',
      gitNotDetected: 'Git not detected',
      changeUnit: 'changes',
      graph: 'Graph',
      graphSummaryAria: 'Code graph summary',
      graphTitle: 'Code graph',
      viewsAvailable: (count: number) => `${count} ${count === 1 ? 'view' : 'views'} available`,
      graphCounts: (nodes: number, edges: number) => `${nodes} ${nodes === 1 ? 'node' : 'nodes'} / ${edges} ${edges === 1 ? 'edge' : 'edges'}`,
      waitingRealScan: 'Waiting for real scan',
      emptyGraphHelp: 'Run a real scan before showing nodes, edges, or views. Zeus does not render placeholder graphs.',
      primaryActionsAria: 'Main actions',
      scanProject: 'Scan project',
      openGraph: 'Open graph',
      viewChanges: 'View changes',
      secondaryActionsAria: 'More project actions',
      edit: 'Edit',
      configure: 'Configure',
      moreProjectActions: 'More project actions',
      drawerLabel: 'Project drawer',
      graphDrawerAria: 'Code graph',
      scanning: 'Scanning',
      retryScan: 'Retry scan',
      openCodeMap: 'Open Code Map',
      scanCurrentRepository: 'Scan current repository',
      projectSettingsAria: 'Project settings',
      projectCodeAria: 'Project code',
      projectListAria: 'Project list',
      projectSearchCreateAria: 'Project search and create',
      projectSearchAria: 'Project search',
      projectSearchTitle: 'Search projects',
      projectSearchHelp: 'Name or local path',
      projectSearchAction: 'Search',
      projectListContentAria: 'Project list content',
      drawerBackdrop: 'Project drawer dismiss area',
      drawerClose: 'Close project drawer',
      scanStatuses: {
        not_scanned: 'Not scanned',
        scanning: 'Scanning',
        completed: 'Completed',
        failed: 'Scan failed',
      },
      projectArchive: {
        aria: 'Archived projects',
        title: 'Archived projects',
        count: (count: number) => (count === 0 ? 'No projects can be restored' : `${count} ${count === 1 ? 'project can' : 'projects can'} be restored`),
        refresh: 'Refresh',
        emptyAria: 'Archived projects empty state',
        emptyTitle: 'No archived projects',
        emptyHelp: 'Archived projects appear here. Restore only restores the Zeus project record and never moves the local folder.',
        listAria: 'Archived project list',
        restore: 'Restore project',
      },
      projectEdit: {
        formAria: 'Edit project',
        currentProjectAria: 'Current project',
        currentProjectTitle: 'Current project',
        nameAria: 'Project name',
        nameTitle: 'Project name',
        nameHelp: 'Only changes the display name inside Zeus. It does not rename the local folder.',
        pathAria: 'Project path',
        pathTitle: 'Project path',
        pathHelp: 'Points to the real local repository. Saving changes future scans and graph sources.',
        descriptionAria: 'Project description',
        descriptionTitle: 'Project description',
        descriptionHelp: 'Helps distinguish project context. It is not used for code scanning or file writes.',
        saveAria: 'Save project edit',
        save: 'Save project changes',
        deleteAria: 'Delete project',
        deleteTitle: 'Delete project',
        deleteHelp: 'Only removes the Zeus project record. It does not delete the local folder.',
        confirmDelete: 'Confirm delete project',
      },
      projectConfig: {
        formAria: 'Project configuration',
        currentStateAria: 'Current project configuration state',
        currentStateTitle: 'Current configuration',
        waitingToLoad: 'Waiting to load',
        defaultModelAria: 'Default AI model',
        defaultModelTitle: 'Default AI model',
        defaultModelHelp: 'The real AI Runtime model used by new tasks. Zeus does not fake availability.',
        defaultWorkModeAria: 'Default work mode',
        defaultWorkModeTitle: 'Default work mode',
        defaultWorkModeHelp: 'Controls whether new tasks start in plan, develop, review, or debug.',
        defaultTaskPromptAria: 'Default task prompt',
        defaultTaskPromptTitle: 'Default task prompt',
        defaultTaskPromptHelp: 'Used for project-level contexts such as graph Q&A, not formal task dispatch.',
        scanIgnoreAria: 'Scan ignore rules',
        scanIgnoreTitle: 'Scan ignore rules',
        scanIgnoreHelp: 'Comma-separated directories excluded from code scans and graph generation.',
        indexScopeAria: 'Index scope',
        indexScopeTitle: 'Index scope',
        indexScopeHelp: 'Controls whether graph scans cover the whole project, src only, or custom paths.',
        indexScopeOptions: {
          project: 'Whole project',
          src: 'src only',
          custom: 'Custom',
        },
        primaryLanguageAria: 'Primary language',
        primaryLanguageTitle: 'Primary language',
        primaryLanguageHelp: 'Language profile used for graphs, task templates, and default prompts.',
        additionalLanguagesAria: 'Additional languages',
        additionalLanguagesTitle: 'Additional languages',
        additionalLanguagesHelp: 'Comma-separated languages for multi-language repositories.',
        packageManagersAria: 'Package managers',
        packageManagersTitle: 'Package managers',
        packageManagersHelp: 'Comma-separated package managers used by task suggestions and repository health.',
        manifestPathsAria: 'Manifest paths',
        manifestPathsTitle: 'Manifest paths',
        manifestPathsHelp: 'Comma-separated real manifest files used for dependency detection and graph summaries.',
        databaseConnectionAria: 'Database connection name',
        databaseConnectionTitle: 'Database connection name',
        databaseConnectionHelp: 'Only stores the connection label. Passwords stay in the local Keychain.',
        schemaPathsAria: 'Schema paths',
        schemaPathsTitle: 'Schema paths',
        schemaPathsHelp: 'Comma-separated DDL or SQL files added as code graph sources.',
        telegramAliasAria: 'Telegram alias',
        telegramAliasTitle: 'Telegram alias',
        telegramAliasHelp: 'Used for project notification routing. Empty means no project-level alias.',
        allowShellAria: 'Allow Shell',
        allowShellTitle: 'Allow Shell',
        allowShellHelp: 'Lets tasks request Shell capability for this project while global safety policies still apply.',
        allowGitWriteAria: 'Allow Git writes',
        allowGitWriteTitle: 'Allow Git writes',
        allowGitWriteHelp: 'Only controls project-level default permission. It does not bypass user confirmation or global limits.',
        databaseStateAria: 'Database configuration summary',
        databaseTitle: 'Database',
        passwordStateAria: 'Database password status',
        passwordTitle: 'Password status',
        passwordConfigured: 'Saved securely',
        passwordNotConfigured: 'Not configured',
        passwordHelp: 'Passwords stay in the local Keychain and are never shown in the UI.',
        save: 'Save project configuration',
        unsetPackageManagers: 'No package managers set',
        unsetManifestPaths: 'No manifest paths set',
        unsetConnectionName: 'No connection name set',
        unsetSchemaPaths: 'No Schema paths set',
        externalDatabaseHelp: 'External database drivers are pending. Save passwords in the Keychain field; connection labels are redacted and Zeus does not claim the remote schema has been read.',
        localSchemaHelp: 'Real DDL or SQL files are added to the code graph outside the src scan scope. The connection name is not a credential.',
      },
    },
    settingsWorkspace: {
      viewAria: 'Settings',
      categoryListAria: 'Settings sections',
      detailPaneAria: 'Settings detail',
      returnToApp: 'Back to app',
      searchAria: 'Search settings',
      searchPlaceholder: 'Search settings...',
      sectionGroups: {
        personal: 'Personal',
        integrations: 'Integrations',
        coding: 'Coding',
        maintenance: 'Maintenance',
      },
      workModeTitle: 'Work mode',
      workModeDescription: 'Choose how many technical details Zeus shows by default',
      engineeringModeTitle: 'For engineering',
      engineeringModeDescription: 'More execution detail, evidence, and control',
      dailyModeTitle: 'For daily work',
      dailyModeDescription: 'Just as capable, with fewer technical details',
      permissionsTitle: 'Permissions',
      defaultPermissionTitle: 'Default permissions',
      defaultPermissionDescription: 'Defaults to the current workspace. Extra paths require confirmation.',
      autoReviewTitle: 'Automatic review',
      autoReviewDescription: 'Low-risk requests can be reviewed automatically. High-risk actions still require confirmation.',
      fullAccessTitle: 'Full access',
      fullAccessDescription: 'Off by default. Enabling must explain the risk and keep an audit trail.',
      protectedStatus: 'Protected',
      waitingStatus: 'Waiting',
      localStatus: 'Local',
      categories: {
        general: 'General',
        tasks: 'Task list',
        runtime: 'AI CLI / Runtime',
        browser: 'Built-in browser',
        telegram: 'Telegram',
        security: 'Security & Keychain',
        commands: 'Commands',
        git: 'Git confirmation',
        release: 'Release & updates',
        data: 'Cache & data',
      },
      generalPaneTitle: 'General settings',
      appLanguageTitle: 'App language',
      appLanguageDescription: 'Choose the interface language Zeus uses',
      appearanceTitle: 'Appearance',
      appearanceDescription: 'Follow system, light, or dark',
      desktopNotificationsTitle: 'Desktop notifications',
      desktopNotificationsDescription: 'Local task, Runtime, and Telegram status changes can notify you',
      desktopNotificationsSwitchAria: 'Desktop notifications switch',
      desktopNotificationsInputAria: 'Desktop notifications',
      notificationsEnabled: 'Enabled',
      notificationsDisabled: 'Disabled',
      notificationsEnabledHelp: 'Notifications appear locally',
      notificationsDisabledHelp: 'Will not interrupt you',
      saveSettingsTitle: 'Save settings',
      saveSettingsDescription: 'Only saves local interface preferences. Projects and Runtime sessions are unchanged.',
      save: 'Save',
      runtime: {
        paneTitle: 'Runtime execution settings',
        cliStatusAria: 'Runtime CLI status',
        detected: 'Detected',
        waitingConfiguration: 'Waiting for configuration',
        defaultAdapterAria: 'Default Runtime Adapter',
        defaultAdapterTitle: 'Default Runtime Adapter',
        defaultAdapterDescription: 'Used first when starting a new Runtime session.',
        codexCliDisplayName: 'Codex CLI',
        genericShellDisplayName: 'Generic shell',
        adapterActionMeta: 'Adapter',
        currentDefaultAria: 'Current default Runtime Adapter',
        currentDefaultTitle: 'Current default',
        currentDefault: (adapter: string) => `Current default: ${adapter}`,
        adapterModelAria: 'Default Adapter model',
        adapterModelTitle: 'Default Adapter model',
        adapterModelDescription: 'Only writes local Runtime configuration. It does not claim the external CLI is signed in.',
        defaultArgsAria: 'Default arguments',
        defaultArgsTitle: 'Default arguments',
        defaultArgsDescription: 'Parsed as real CLI arguments separated by spaces.',
        cliPathAria: 'CLI path',
        cliPathTitle: 'CLI path',
        cliPathDescription: 'Optional absolute path. When empty, Zeus checks PATH, common local directories, and the login shell. Zeus never bundles or installs the CLI.',
        concurrencyAria: 'Runtime concurrency limit',
        concurrencyTitle: 'Project concurrency limit',
        globalConcurrency: (count: number) => `Global concurrency limit: ${count}`,
        timeoutAria: 'Runtime execution timeout',
        timeoutTitle: 'Execution timeout',
        seconds: (count: number) => `${count} seconds`,
        logRetention: (days: number) => `Log retention: keep ${days} days`,
        autoConfirmAria: 'Runtime auto-confirm policy',
        autoConfirmTitle: 'Auto-confirm policy',
        autoConfirmHighRiskBoundary: 'Does not bypass high-risk confirmations such as Generic shell, Git writes, or file deletion.',
        autoConfirmPolicies: {
          never: 'Never',
          low_risk_only: 'Low risk only',
        },
        timeoutSecondsAria: 'Execution timeout seconds',
        timeoutSecondsTitle: 'Execution timeout seconds',
        timeoutSecondsDescription: 'After this time, the Runtime state machine handles the timeout.',
        secondsUnit: 'seconds',
        advancedAria: 'Advanced Runtime arguments',
        advancedTitle: 'Advanced Runtime arguments',
        advancedDescription: 'Only writes real Runtime child-process configuration. It does not claim the CLI is installed or signed in.',
        advancedHelp: 'Environment variables enter the real child process. Zeus does not verify the CLI is installed or signed in.',
        shellPathTitle: 'Shell path',
        shellPathAria: 'Shell path',
        terminalEnvTitle: 'Terminal environment variables',
        terminalEnvAria: 'Terminal environment variables',
        loginShell: 'Start as login shell',
        nonLoginShell: 'Start as non-login shell',
        modelMeta: 'Model',
        argsMeta: 'Arguments',
        saveDefaultAdapter: 'Save default Adapter',
      },
      telegram: {
        paneTitle: 'Telegram settings',
        botTokenAria: 'Telegram Bot Token',
        botTokenTitle: 'Telegram Bot Token',
        botTokenConfigured: 'Configured',
        botTokenNotConfigured: 'Telegram token not configured',
        botTokenHelp: (label: string) => `${label} · Token is stored in macOS Keychain. The UI never reveals the secret.`,
        tokenFieldLabel: 'Token',
        saveToKeychain: 'Save to Keychain',
        clearToken: 'Clear token',
        chatIdAria: 'Telegram notification Chat ID',
        chatIdTitle: 'Notification Chat ID',
        chatIdFieldLabel: 'Chat ID',
        notTested: 'Not tested yet',
        saveNotifications: 'Save notification settings',
        testConnection: 'Test connection',
        testSuccess: (chatIds: string, attempts: number, sentAt: string) => `Test connection sent: ${chatIds} · ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'} · ${sentAt}`,
        testFailed: 'Test connection failed. Check the Bot Token and notification Chat ID.',
        pollingAria: 'Telegram polling and message logs',
        pollingTitle: 'Polling and message logs',
        pollingDescription: 'Only shows real polling updates. Zeus does not generate fake Telegram messages.',
        pollingState: (running: boolean, offset: number) => `${running ? 'Running' : 'Stopped'} · offset ${offset}`,
        emptyPollingLogs: 'No real Telegram polling logs yet.',
        latestLogs: 'Latest 5',
      },
      security: {
        paneTitle: 'Security & Keychain settings',
        externalApiKeyAria: 'External API Key',
        externalApiKeyTitle: 'External API Key',
        externalApiKeyConfigured: 'External API key configured',
        externalApiKeyNotConfigured: 'External API key not configured',
        externalApiKeyHelp: (label: string) => `${label} · Stored only in macOS Keychain. Zeus does not claim the external AI service is available.`,
        externalApiKeyFieldLabel: 'API Key',
        saveApiKey: 'Save API Key',
        clearApiKey: 'Clear API Key',
        allowlistAria: 'Telegram allowlist',
        allowlistTitle: 'Telegram allowlist',
        allowlistDescription: 'Only allowed real Telegram users can trigger remote operations.',
        allowlistFieldAria: 'Allowed User ID',
        allowlistFieldLabel: 'Allowed User ID',
        saveAllowlist: 'Save allowlist',
        exposureRiskAria: 'Exposure risk',
        exposureRiskTitle: 'Exposure risk',
        exposureRiskDescription: 'Clears locally stored Token, API Key, and remote-control allowlist state.',
        exposureRiskResetHelp: 'External credentials must be configured again after reset.',
        resetSecurity: 'Reset security settings',
        auditAria: 'Security audit',
        auditTitle: 'Security audit',
        auditDescription: 'Only shows real local security audit records.',
        emptyAudit: 'No real security audit records yet.',
        latestAudit: 'Latest 6',
      },
      git: {
        paneTitle: 'Git confirmation settings',
        branchNameAria: 'Git branch name',
        branchNameTitle: 'Branch name',
        branchNameDescription: 'Only used to create a Git write confirmation. It does not execute immediately.',
        remoteAria: 'Git remote',
        remoteTitle: 'Remote',
        remoteDescription: 'Only used for push confirmations. The real push still requires a second confirmation.',
        confirmationAria: 'Git write confirmation',
        confirmationTitle: 'Dangerous operations require confirmation',
        confirmationDescription: 'Only creates a local confirmation request. It never executes a Git write directly.',
        targetBranch: (branch: string) => (branch.trim() ? `Target branch: ${branch.trim()}` : 'Target branch not filled'),
        remoteTarget: (remote: string, target: string) => (remote.trim() ? `Remote: ${remote.trim()} · target: ${target.trim() || 'not filled'}` : 'Remote not filled'),
        requestBranchConfirmation: 'Request branch confirmation',
        requestPushConfirmation: 'Request push confirmation',
      },
      release: {
        paneTitle: 'Release and signing',
        signingAria: 'macOS signing status',
        signingTitle: 'macOS signing',
        signingEnvironmentOnly: 'Certificates are read only from release environment variables.',
        notarizationAria: 'notarization status',
        notarizationTitle: 'notarization',
        notarizationDescription: 'Zeus does not fake signing or notarization success. Without Apple credentials, only unsigned verification is allowed.',
        caskAria: 'Homebrew cask status',
        caskTitle: 'Homebrew cask',
        releaseSigningConfigured: 'Signing certificate configured',
        releaseSigningWaiting: 'Waiting for signing certificate',
        releaseNotarizationConfigured: 'Notarization credentials configured',
        releaseNotarizationWaiting: 'Waiting for notarization credentials',
        releaseCaskDetected: 'Local cask generated',
        releaseCaskWaiting: 'Waiting for Homebrew cask file',
        unsignedBuildAvailable: 'Unsigned build available',
        unsignedBuildUnavailable: 'Unsigned build unavailable',
        detailAria: 'Release details',
        detailTitle: 'Release details',
        detailDescription: 'Unsigned or non-notarized artifacts are never presented as a production release.',
        autoUpdateReserved: 'Auto-update reserved',
        autoUpdateManual: (version: string) => `Manual update · ${version}`,
        autoUpdateFeed: (channel: string, version: string) => `${channel} update · ${version}`,
        realReleaseStatus: 'Real release status',
        updateAria: 'Software update',
        updateActionAria: 'Software update actions',
        updateTitle: 'Software update',
        updateStatusLabels: {
          up_to_date: (version: string) => `Already up to date: ${version}`,
          available: (version: string) => `New version available: ${version}`,
          unavailable: 'Update manifest unavailable',
        },
        updateReasons: {
          current: 'The current version is already at or above the release manifest version.',
          availableManual: 'Release artifacts are not both signed and notarized. Zeus only opens GitHub Release for manual installation.',
          availableInstallable: 'A new signed and notarized release is available for download and installation.',
          noArtifact: 'A new version is available, but no macOS artifact matches this Mac architecture.',
          unavailable: 'Zeus could not read the GitHub Release manifest.',
        },
        waitingForLabels: {
          'Apple signing certificate': 'Apple signing certificate',
          'Apple notarization credentials': 'Apple notarization credentials',
          'GitHub Release workflow': 'GitHub Release workflow',
          'signed and notarized artifacts': 'signed and notarized artifacts',
        },
        installHelp: (automatic: boolean) => (automatic ? 'Signed and notarized artifacts can be downloaded and installed.' : 'Installation requires signing and notarization. Currently opens GitHub Release for manual install.'),
        checking: 'Checking',
        checkUpdates: 'Check updates',
        versionAria: 'Software update version',
        versionTitle: 'Version',
        checkedAt: (value: string) => `Checked at ${value}`,
        notChecked: 'Remote check has not completed yet',
        currentVersion: (version: string) => `Current version: ${version}`,
        latestVersion: (version: string) => `Latest version: ${version}`,
        updateChannelLabels: {
          stable: 'Stable',
          preview: 'Preview',
        },
        artifactAria: 'Software update installer',
        artifactTitle: 'Installer',
        artifactKindLabels: {
          dmg: 'DMG',
          zip: 'ZIP',
        },
        waitingArtifact: 'Waiting for a matching local architecture',
        noArtifact: 'No installer matches this Mac architecture yet.',
        updateFailed: 'Update check failed. Try again later.',
        recommendedActions: {
          none: 'No update needed',
          open_download_page: 'Open download page',
          download_and_install: 'Download and install',
        },
      },
      data: {
        paneTitle: 'Cache and data settings',
        portabilityAria: 'Cache and data import and export',
        localLogDirectoryTitle: 'Local log directory',
        localLogDirectoryDescription: 'Exports are saved locally with secrets redacted. Zeus does not upload business data.',
        notImportedExported: 'Not imported or exported yet',
        exportSettings: 'Export settings',
        importSettings: 'Import settings',
        clearCache: 'Clear cache',
        exported: (target: string) => `Last export: ${target}; secrets redacted`,
        imported: (target: string, changed: string) => `Last import: ${target}; ${changed}`,
        noSettingsChanged: 'No settings changed',
      },
    },
    gitDiffWorkspace: {
      drawerAria: 'Code changes',
      title: 'Code changes',
      exportPatch: 'Export patch',
      worktreeStateAria: 'Git worktree status',
      worktreeStateTitle: 'Git worktree status',
      cleanStatus: 'Clean',
      changedStatus: (count: number) => `${count} ${count === 1 ? 'change' : 'changes'}`,
      worktreeMeta: (conflicts: number, remoteBranches: number, latestCommit?: string) => `Conflicts ${conflicts} · Remote branches ${remoteBranches}${latestCommit ? ` · Latest commit ${latestCommit}` : ''}`,
      changedFilesAria: 'Changed files',
      emptyChangedFiles: 'No loaded changes in the current repository.',
      fileReviewAria: (path: string) => `${path} change review`,
      fileDiffTitle: (path: string) => `File diff: ${path}`,
      pendingDecision: 'Pending review',
      hunkActionsAria: (header: string) => `${header} decision`,
      acceptHunk: 'Accept',
      rejectHunk: 'Reject',
      riskParamsAria: 'High-risk Git parameters',
      riskParamsTitle: 'High-risk Git parameters',
      branchNameAria: 'New branch name',
      branchNameTitle: 'New branch name',
      branchNameHelp: 'Creates and switches to a branch only after high-risk Git confirmation.',
      switchBranchAria: 'Switch branch',
      switchBranchTitle: 'Switch branch',
      switchBranchHelp: 'Use a real or intended branch name. Zeus does not invent Git state in the UI.',
      baseRefAria: 'Git base ref',
      baseRefTitle: 'Base ref',
      baseRefHelp: 'Controls the real diff base ref and therefore the review scope.',
      stashRefAria: 'Stash ref',
      stashRefTitle: 'Stash ref',
      stashRefHelp: 'Selects a real stash entry. Restoring it still requires confirmation.',
      remoteNameAria: 'Remote name',
      remoteNameTitle: 'Remote name',
      remoteNameHelp: 'Used for remote writes such as push. It must come from a real Git remote.',
      targetRefAria: 'Target ref',
      targetRefTitle: 'Target ref',
      targetRefHelp: 'Remote target ref. Empty values are not auto-inferred as safe targets.',
      rollbackTargetAria: 'Rollback target',
      rollbackTargetTitle: 'Rollback target',
      rollbackTargetHelp: 'Used for high-risk rollback paths and only enters execution after confirmation.',
      confirmationAria: 'High-risk Git confirmation',
      commitMessageAria: 'Commit message',
      commitMessageTitle: 'Commit message',
      commitMessageHelp: 'Only used for confirmed commit requests. Empty messages disable commit confirmation.',
      commitMessageStatusAria: 'Commit message status',
      commitMessageStatusTitle: 'Commit message status',
      commitMessageStatusHelp: 'Commit prerequisite',
      commitMessageStatusText: 'Used for confirmed Git commits. Empty messages will not execute a commit',
      requestStashConfirmation: 'Request stash confirmation',
      requestCommitConfirmation: 'Request commit confirmation',
      currentConfirmationAria: 'Current Git confirmation status',
      currentConfirmationTitle: 'Current confirmation',
      confirmationStatusLabels: {
        pending: 'Pending',
        confirmed: 'Confirmed',
        rejected: 'Rejected',
      },
      patchStatusAria: 'Patch export status',
      patchStatusTitle: 'Patch status',
      localExport: 'Local export',
      confirmationExpiryAria: 'Git confirmation expiry',
      confirmationExpiryTitle: 'Confirmation expiry',
      confirmationExpiryHelp: 'Confirm again after expiry',
      confirmOperation: 'Confirm Git operation',
      rejectConfirmation: 'Reject Git confirmation',
      rejectImpactAria: 'Reject Git confirmation impact',
      rejectImpactTitle: 'Reject impact',
      safetyBoundary: 'Safety boundary',
      rejectImpactText: 'Rejecting will not execute any Git write',
      rejectedAria: 'Rejected Git confirmation',
      rejectedTitle: 'Rejected Git confirmation',
      rejectedHelp: 'No Git write will execute',
      rejectedFallback: 'The user rejected this Git confirmation',
      whitelistScopeAria: 'Git allowlist execution scope',
      executionScopeTitle: 'Execution scope',
      whitelistCommandHelp: 'Allowlisted command',
      whitelistCommandText: 'Only allowlisted Git commands are executed',
      executeConfirmed: 'Execute confirmed',
      operationStatusAria: 'Git operation status',
      operationStatusTitle: 'Operation status',
      localExecutionChain: 'Local execution chain',
      patchNotExported: 'Patch not exported yet',
      operationNotExecuted: 'No Git write executed yet',
      operationConfirmFailed: 'Git operation confirmation failed. Create a new confirmation.',
      rejectStatus: 'Git confirmation rejected. No Git write will execute.',
      rejectFailed: 'Failed to reject Git confirmation. Check the local audit log.',
      commitMessageRequired: 'Commit requires a commit message. Create a confirmation with a message.',
      executedStatus: (operation: string, args: string) => `Executed ${operation} · git ${args}`,
      executeFailed: 'Git write execution failed. Check the local audit log.',
      patchSaved: (filePath: string | null) => `Saved .patch file: ${filePath}`,
      patchGenerated: (fileName: string) => `Generated read-only patch: ${fileName}`,
      unknownExpiry: 'Unknown',
      operationLabels: {
        commit: 'commit',
        stash: 'stash',
        apply_stash: 'apply stash',
        rollback: 'rollback',
        branch: 'create branch',
        switch_branch: 'switch branch',
        pull: 'pull',
        push: 'push',
      },
      decisionSummary: (accepted: number, rejected: number, pending: number) => `Review decision: accepted ${accepted} · rejected ${rejected} · pending ${pending} · no git apply`,
      reviewSummary: (files: number, hunks: number, added: number, deleted: number) => `${files} ${files === 1 ? 'file' : 'files'} · ${hunks} ${hunks === 1 ? 'hunk' : 'hunks'} · +${added} / -${deleted}`,
    },
    codeMapWorkspace: {
      viewAria: 'Code graph view',
      statusAria: 'Code graph status and view',
      contextStripAria: 'Code graph context',
      title: 'Code graph',
      sourceSummary: 'Real source: nodes, edges, and layout are generated from source scans.',
      contextFactsAria: 'Code graph real facts',
      realSource: 'Real source',
      currentView: 'Current view',
      viewSwitcherAria: 'Graph view switcher',
      performanceAria: 'Graph performance',
      viewReadPrefix: 'Graph view read',
      realNodes: 'Real nodes',
      realEdges: 'Real edges',
      primaryGridAria: 'Graph stage and inspector',
      stageAria: 'Graph stage',
      inspectorAria: 'Graph inspector',
      visibilityAria: 'Graph node visibility controls',
      hiddenNodes: (count: number) => `${count} nodes hidden`,
      restoreAllNodes: 'Restore all nodes',
      secondaryToolsAria: 'Graph secondary tools',
      toolSwitchAria: 'Graph tool switcher',
      tools: {
        runtime: { label: 'Graph render diagnostics', description: 'Validate static graph rendering' },
        search: { label: 'Search and filters', description: 'Locate nodes first' },
        qa: { label: 'Graph Q&A', description: 'Ask from sources' },
        mermaid: { label: 'Mermaid', description: 'Export current view' },
        entities: { label: 'Nodes and edges', description: 'Review source list' },
      },
      searchPanelAria: 'Search and filters',
      searchFilterAria: 'Graph search filters',
      nodeSearchAria: 'Search node or field',
      nodeSearchTitle: 'Search node or field',
      nodeSearchHelp: 'Node name, field, or source path',
      nodeTypeAria: 'Node type',
      nodeTypeTitle: 'Node type',
      nodeTypeHelp: 'Limit node category',
      edgeTypeAria: 'Edge type',
      edgeTypeTitle: 'Edge type',
      edgeTypeHelp: 'Limit call or data relationship',
      minConfidenceAria: 'Minimum confidence',
      minConfidenceTitle: 'Minimum confidence',
      minConfidenceHelp: 'Filter low-confidence edges',
      searchAction: 'Search',
      resultCount: (count: number) => `${count} results`,
      qaPanelAria: 'Graph Q&A',
      qaComposeAria: 'Graph question',
      qaModeRailAria: 'Graph Q&A mode status',
      askGraphTitle: 'Ask the graph',
      askGraphHelp: 'Answers must come from the real AI Runtime with graph sources. When sources are insufficient, Zeus says so.',
      questionAria: 'Graph question input',
      questionTitle: 'Question',
      questionHelp: 'Ask about the current real graph',
      askGraphAction: 'Ask the graph',
      explainNodeQuestion: (name: string, source: string) => `Explain graph node ${name}, source ${source}`,
      nodeDetail: 'Node detail',
      edgeDetail: 'Edge detail',
      currentSelection: 'Current object',
      nodeSource: 'Node source',
      edgeSource: 'Edge source',
      lineLabel: 'Line',
      missingSymbol: 'No symbol bound',
      graphRuntime: 'Graph render diagnostics',
      runtimeToolCollapsed: 'This tool only validates Sigma and React Flow against the current static graph; it is not a live runtime call trace.',
      sequenceRuntimeHidden: 'Sequence and method-logic views are already the main stage, so static render diagnostics stay hidden.',
      sigmaTitle: 'Sigma WebGL graph',
      sigmaSourceAria: 'Sigma graph real sources',
      sigmaEmpty: 'No real nodes are visible, so the WebGL render diagnostic stays empty.',
      reactFlowTitle: 'React Flow local graph',
      reactFlowEdgesAria: 'React Flow real edges',
      reactFlowEmpty: 'No real local graph nodes are visible.',
      graphCanvas: 'Code graph canvas',
      sequenceGraphCanvas: 'Sequence diagram canvas',
      canvasEmpty: 'No real nodes match the current filters. Adjust search to show scanned source nodes and edges.',
      aggregatedEdges: 'aggregated edges',
      nodeCount: (count: number) => `${count} ${count === 1 ? 'node' : 'nodes'}`,
      edgeCount: (count: number) => `${count} ${count === 1 ? 'edge' : 'edges'}`,
      lifelineCount: (count: number) => `${count} ${count === 1 ? 'lifeline' : 'lifelines'}`,
      aggregatedEdgeCount: (count: number) => `${count} aggregated ${count === 1 ? 'edge' : 'edges'}`,
      serverLayout: 'server layout',
      canvasSourcesAria: 'Canvas source files',
      openSourceShortcut: 'Press O to open source',
      createTaskShortcut: 'Press T to create task',
      graphNodeTaskStatusAria: 'Graph node task creation status',
      graphNodeTaskCreating: 'Creating a task from this node',
      graphNodeTaskCreated: 'Task created from node, opening the task list',
      graphNodeTaskCreateFailed: 'Node task creation failed. Review the local error and try again.',
      graphNodeTaskRetry: 'Retry',
      graphNodeTaskRetryAria: 'Retry creating a task from the current graph node',
      graphAnswerAria: 'Graph answer',
      runtimeSessionLabel: 'Runtime session',
      insufficientRuntimeSession: 'Insufficient sources, Runtime session not started',
      qaHistoryAria: 'Q&A history',
      qaHistoryToolbarAria: 'Q&A history toolbar',
      qaHistorySearchAria: 'Search Q&A history',
      searchHistoryTitle: 'Search history',
      searchHistoryHelp: 'Real Q&A records only',
      searchHistoryAction: 'Search history',
      viewActiveHistory: 'View active',
      viewArchivedHistory: 'View archived',
      realQaCount: (count: number) => `${count} real Q&A`,
      qaHistoryEmptyAria: 'Q&A history empty state',
      noRealQaHistory: 'No real Q&A history',
      noMatchingQaHistory: 'No matching real graph Q&A. Try another keyword or clear the filter.',
      qaHistoryEmptyHelp: 'After one answer, questions, answers, and sources appear here.',
      answerNotGenerated: 'No answer generated',
      viewDetail: 'View detail',
      createTaskFromQa: 'Create task from Q&A',
      graphConversationTaskIntent: 'Create an actionable follow-up task from this code-map Q&A',
      graphNodeTaskIntent: 'Analyze this graph node for implementation risk, impact scope, and recommended acceptance scope',
      restoreHistory: 'Restore history',
      archiveHistory: 'Archive history',
      qaPaginationAria: 'Q&A history pagination',
      previousPage: 'Previous page',
      nextPage: 'Next page',
      pageRangeEmpty: 'Items 0-0',
      pageRange: (start: number, end: number) => `Items ${start}-${end}`,
      qaDetailAria: 'Q&A detail',
      qaDetailStatusAria: 'Q&A detail status',
      archivedStatus: 'Archived',
      activeStatus: 'Active',
      conversationStatusLabels: {
        open: 'Open',
        starting: 'Starting',
        queued: 'Queued',
        running: 'Running',
        active: 'Active',
        exited: 'Ready to continue',
        failed: 'Failed',
        stopped: 'Stopped',
        lost: 'Lost',
        orphan_detected: 'Needs handoff',
        closed: 'Closed',
        completed: 'Completed',
        archived: 'Archived',
      },
      messageCount: (count: number) => `${count} messages`,
      qaMessagesAria: 'Q&A messages',
      assistantAnswer: 'Assistant answer',
      userQuestion: 'User question',
      messageSourceLabels: {
        graph_question: 'Source: graph question',
        graph_answer: 'Source: graph answer',
      },
      mermaidPanelAria: 'Mermaid export',
      mermaidPreviewAria: 'Mermaid preview',
      mermaidExportCommandsAria: 'Mermaid export commands',
      diagramFormatAria: 'Diagram source format',
      mermaidPreviewTitle: 'Mermaid preview',
      plantUmlPreviewTitle: 'PlantUML preview',
      mermaidSequencePreviewTitle: 'Mermaid sequence preview',
      plantUmlSequencePreviewTitle: 'PlantUML sequence preview',
      mermaidPreviewHelp: 'Generate Mermaid text from the currently visible real nodes and edges. PlantUML can be switched on for mature UML toolchains. Zeus does not render fake diagrams or add dependencies.',
      hideMermaidSource: 'Hide Mermaid source',
      generateMermaidPreview: 'Generate Mermaid preview',
      exportMermaidSource: 'Export Mermaid source',
      mermaidSavedStatus: (filePath: string) => `Saved Mermaid source: ${filePath}`,
      mermaidGeneratedStatus: (fileName: string) => `Generated Mermaid source: ${fileName}`,
      mermaidSaveFailedStatus: 'Mermaid source could not be saved. The current preview text is still available to copy manually.',
      mermaidSourceAria: 'Mermaid source',
      mermaidEmptyAria: 'Mermaid preview not generated',
      mermaidEmptyTitle: 'Preview not generated',
      mermaidEmptyHelp: 'Generate it to show only the real nodes and edges still visible after filters.',
      mermaidStatusAria: 'Mermaid export status',
      mermaidGeneratedFile: (fileName: string, mimeType: string) => `Generated ${fileName} · ${mimeType}`,
      entityPanelAria: 'Graph entities',
      entityWorkbenchAria: 'Graph nodes and edges sources',
      graphNodesAria: 'Graph nodes',
      graphNodesTitle: 'Graph nodes',
      realNodeCount: (count: number) => `${count} real node${count === 1 ? '' : 's'}`,
      sourceCount: (count: number) => `${count} source${count === 1 ? '' : 's'}`,
      aggregatedNodeSummary: (count: number, sourceCount: number) => `Aggregated ${count} real nodes · ${sourceCount} source${sourceCount === 1 ? '' : 's'}`,
      aggregateNodeLabel: 'Aggregate node',
      createTaskFromNode: 'Create task from node',
      openSource: 'Open source',
      graphSourceOpenStatusAria: 'Source open status',
      graphSourceOpenOpening: 'Opening source',
      graphSourceOpenOpened: 'Source opened',
      graphSourceOpenFailed: 'Source open failed',
      restoreNode: 'Restore node',
      hideNode: 'Hide node',
      openNodeMenu: 'Open node menu',
      nodeActionMenuAria: 'Node action menu',
      graphEdgesAria: 'Graph edges',
      graphEdgesTitle: 'Graph edges',
      realEdgeCount: (count: number) => `${count} real edge${count === 1 ? '' : 's'}`,
      aggregatedEdgeSummary: (count: number, sourceCount: number) => `Aggregated ${count} real edges · ${sourceCount} source${sourceCount === 1 ? '' : 's'}`,
      confidenceValue: (confidence: string) => `Confidence ${confidence}`,
      confidenceUnknown: 'confidence unknown',
      aiSummary: 'AI summary',
      recentTasks: 'Recent tasks',
      unnamedTask: 'Untitled task',
      unknownTaskStatus: 'Unknown status',
      oneHopNeighbors: 'One-hop neighbors',
      twoHopImpact: 'Two-hop impact',
      riskTags: 'Risk tags',
      nodeActions: {
        inspectDetail: 'Inspect detail',
        openSource: 'Open source',
        askNode: 'Ask this node',
        generateSequence: 'Generate sequence',
        generateFlow: 'Generate flow',
        expandOneHop: 'Expand one hop',
        expandTwoHop: 'Expand two hops',
        createTask: 'Create task from node',
        restoreNode: 'Restore node',
        hideNode: 'Hide node',
      },
    },
  },
} as const satisfies Record<
  AppLanguage,
  {
    shellAriaLabel: string;
    documentLang: 'zh-CN' | 'en';
    languages: Record<AppLanguage, string>;
    appearance: Record<AppShellSettings['appearance'], string>;
    workModes: Record<WorkMode, string>;
    taskStatuses: Record<TaskStatus | '', string>;
    taskEventTypeLabels: Record<string, string>;
    taskEventTypeSegments: Record<string, string>;
    taskSorts: Record<'createdAt' | 'updatedAt' | 'title' | 'managementStatus', string>;
    graphNodeTypes: Record<string, string>;
    graphEdgeTypes: Record<string, string>;
    graphViewTypes: Record<GraphViewType, string>;
    localOperationFailed: string;
    sidebar: {
      ariaLabel: string;
      quickActionsLabel: string;
      newChat: string;
      search: string;
      projects: string;
      projectListLabel: string;
      selectRepository: string;
      selectedRepositoryDescription: string;
      cancelledRepositoryDescription: string;
      creatingRepository: string;
      selectLocalRepository: string;
      noProjectMatches: string;
      addProject: string;
      createDialogTitle: string;
      createNameLabel: string;
      createNamePlaceholder: string;
      createFolderLabel: string;
      createFolderHelp: string;
      createChooseFolder: string;
      createChangeFolder: string;
      createCancel: string;
      createSubmit: string;
      createSubmitting: string;
      createNameRequired: string;
      createFolderRequired: string;
      projectSettingsPrefix: string;
      expandProjectPrefix: string;
      collapseProjectPrefix: string;
      moreProjectActionsPrefix: string;
      projectMenuSuffix: string;
      pinProject: string;
      unpinProject: string;
      revealProjectInFinder: string;
      renameProject: string;
      deleteProject: string;
      confirmDeleteProject: string;
      deleteProjectHint: string;
      renameDialogTitle: string;
      renameDialogHelp: string;
      renameLabel: string;
      renamePlaceholder: string;
      renameCancel: string;
      renameSave: string;
      renameSaving: string;
      renameRequired: string;
      pinned: string;
      labelSeparator: string;
      sections: Record<Exclude<ProjectWorkspaceSection, 'project-settings'>, string>;
      current: string;
      globalSettingsLabel: string;
      settings: string;
    };
    taskWorkspace: {
      viewAria: string;
      listAria: string;
      filterAria: string;
      searchAria: string;
      searchTitle: string;
      searchHelp: string;
      conditionsAria: string;
      statusAria: string;
      statusSelectAria: string;
      taskStatusSelectAria: (taskTitle: string) => string;
      detailStatusSelectAria: string;
      statusTitle: string;
      unfinishedStatusFilter: string;
      statusHelp: string;
      sortAria: string;
      sortSelectAria: string;
      sortTitle: string;
      selectSearchPlaceholder: string;
      selectNoResults: string;
      rowMetaTitle: string;
      defaultTaskLabel: string;
      templateTaskLabel: string;
      sortHelp: string;
      tagsAria: string;
      tagFilterAria: string;
      tagsTitle: string;
      tagsHelp: string;
      filterActionsAria: string;
      filterAction: string;
      newTask: string;
      taskCreateDialogTitle: string;
      taskCreateTitleLabel: string;
      taskCreateTitlePlaceholder: string;
      taskCreateDescriptionLabel: string;
      taskCreateDescriptionPlaceholder: string;
      taskCreatePriorityLabel: string;
      taskCreatePriorityOptions: readonly { value: TaskPriority; label: string }[];
      taskCreateTagsLabel: string;
      taskCreateTagsPlaceholder: string;
      taskCreateAttachmentsLabel: string;
      taskCreateAttachmentsHint: string;
      taskCreateChooseAttachments: string;
      taskCreateRemoveAttachment: string;
      taskCreateImageAttachment: string;
      taskCreateFileAttachment: string;
      taskCreateOpenAttachment: string;
      taskCreatePreviewAttachment: string;
      taskCreatePreviewClose: string;
      taskCreatePreviewUnavailable: string;
      taskCreateLocalPathLabel: string;
      taskCreateAttachmentAddedStatus: (count: number) => string;
      taskCreateAttachmentPickerFailed: string;
      taskCreatePasteAttachmentFailed: string;
      taskCreateCancel: string;
      taskCreateSubmit: string;
      taskCreateSubmitting: string;
      taskCreateClose: string;
      taskCreateTitleRequired: string;
      taskCreateSubmitFailed: string;
      today: string;
      emptyTitle: string;
      emptyHelp: string;
      emptySecondaryAction: string;
      emptyOutcomeStatus: string;
      emptyOutcomeAi: string;
      emptyOutcomeEvidence: string;
      noResultsPrimaryAction: string;
      noResultsSecondaryAction: string;
      taskListLoadingToolbarStatus: string;
      taskListLoadingTitle: string;
      taskListLoadingHelp: string;
      taskListLoadingMeta: string;
      taskListErrorToolbarStatus: string;
      taskListErrorTitle: string;
      taskListErrorHelp: string;
      taskListErrorRetry: string;
      taskListErrorProjectSettings: string;
      noResultsTitle: string;
      noResultsHelp: string;
      archiveAria: string;
      archiveTitle: string;
      itemUnit: string;
      restoreTask: string;
      detailAria: string;
      statusRowAria: string;
      statusRowTitle: string;
      noProjectSelected: string;
      workbenchAria: string;
      statusBoardAria: string;
      currentStatus: string;
      noTags: string;
      aiCliLabel: string;
      telegramLabel: string;
      aiDetected: string;
      aiNotConfigured: string;
      taskCodeLabel: string;
      priorityLabel: string;
      sourceLabel: string;
      updatedAtLabel: string;
      runtimeSessionLabel: string;
      runtimeCommandLabel: string;
      runtimeSessionNotStarted: string;
      runtimeCommandMissing: string;
      nextActionLabels: Record<TaskStatus, string>;
      sourceLabels: Record<string, string>;
      updatedAtMissing: string;
      sensitiveCommandArgument: string;
      runtimeSessionStatusLabels: Record<AiRuntimeSessionStatus, string>;
      telegramEnabled: string;
      telegramDisabled: string;
      contentAria: string;
      requestAria: string;
      requestTitle: string;
      noRequest: string;
      eventsAria: string;
      eventsTitle: string;
      noEvents: string;
      commandDockAria: string;
      statusActionsAria: string;
      runTask: string;
      viewConversation: string;
      pushNewConversation: string;
      conversationsTitle: string;
      conversationEmptyTitle: string;
      conversationEmptyHelp: string;
      conversationLoading: string;
      conversationError: string;
      openConversation: string;
      retryConversationLoad: string;
      markComplete: string;
      cancelTask: string;
      retryTask: string;
      detailPaneLabel: string;
      detailPaneBackdrop: string;
      detailPaneClose: string;
      openTaskDetail: string;
      taskCountPrefix: string;
      filteredState: string;
      allState: string;
      codeColumnTitle: string;
      intentColumnTitle: string;
      managementStatusColumnTitle: string;
      runStatusColumnTitle: string;
      sourceColumnTitle: string;
      createdAtColumnTitle: string;
      updatedAtColumnTitle: string;
      priorityColumnTitle: string;
      projectColumnTitle: string;
      templateColumnTitle: string;
      descriptionColumnTitle: string;
      runtimeSessionColumnTitle: string;
      rawIdColumnTitle: string;
      createdFromColumnTitle: string;
      fieldSettings: string;
      fieldSettingsAria: string;
      fieldSettingsHelp: string;
      restoreDefaultColumns: string;
      requiredColumnReason: string;
      moveColumnUpAria: (columnTitle: string) => string;
      moveColumnDownAria: (columnTitle: string) => string;
      compactColumnAria: (columnTitle: string) => string;
      standardColumnAria: (columnTitle: string) => string;
      wideColumnAria: (columnTitle: string) => string;
      selectTaskAria: (taskTitle: string) => string;
      selectAllVisibleTasks: string;
      clearTaskSelection: string;
      bulkSelectedCount: (count: number) => string;
      bulkStatusTargetAria: string;
      bulkStatusTargetTitle: string;
      bulkApplyStatus: string;
      bulkDelete: string;
      bulkDeleteConfirm: (count: number, skippedCount: number) => string;
      bulkStatusSkippedHint: (eligibleCount: number, skippedCount: number) => string;
      primaryActionsTitle: string;
      secondaryActionsTitle: string;
      dangerActionsTitle: string;
      metadataTitle: string;
      latestEvidenceLabel: string;
      noEvidence: string;
      attachmentsTitle: string;
      imageAttachmentLabel: string;
      fileAttachmentLabel: string;
      openFileAttachmentLabel: string;
      previewAttachmentLabel: string;
      previewCloseLabel: string;
      previewUnavailableLabel: string;
      localPathLabel: string;
      projectLabel: string;
      templateLabel: string;
      cancelConfirm: string;
      followUpAria: string;
      followUpTitle: string;
      followUpHelp: string;
      followUpPlaceholder: string;
      saveRequest: string;
      modeRailAria: string;
      contextRailAria: string;
      runtime: string;
      context: string;
      codeChanges: string;
      templates: string;
      defaultTaskTitle: string;
      defaultTaskDescription: string;
      templateTaskTitle: string;
      templateTaskGoal: string;
    };
    sessionWorkspace: {
      viewAria: string;
      listAria: string;
      toolbarAria: string;
      searchAria: string;
      searchTitle: string;
      searchHelp: string;
      newChat: string;
      newChatPrompt: (projectName: string) => string;
      newChatPlaceholder: string;
      newChatCommandRowAria: string;
      composerAddContextAria: string;
      composerCustomize: string;
      composerCustomizeAria: string;
      composerCurrentAi: (adapterName: string) => string;
      starterListAria: string;
      starterCreateTask: string;
      starterOpenCode: string;
      starterOpenRuntime: string;
      environmentTitle: string;
      environmentChanges: string;
      environmentLocalMode: string;
      environmentBranch: string;
      emptyTitle: string;
      emptyHelp: string;
      rowType: string;
      archiveAria: string;
      archiveTitle: string;
      itemUnit: string;
      restoreSession: string;
      detailAria: string;
      aiDetected: string;
      aiNotConfigured: string;
      telegramEnabled: string;
      telegramDisabled: string;
      threadAria: string;
      messageListAria: string;
      userRequest: string;
      assistantResponse: string;
      waitingTitle: string;
      noEvents: string;
      inputDockAria: string;
      statusActionsAria: string;
      sendToConversation: string;
      markComplete: string;
      cancelTask: string;
      followUpAria: string;
      followUpTitle: string;
      followUpHelp: string;
      followUpPlaceholder: string;
      send: string;
      modeRailAria: string;
      contextRailAria: string;
      runtime: string;
      context: string;
      codeChanges: string;
      templates: string;
      secondaryDrawerLabel: string;
      secondaryDrawerBackdrop: string;
      secondaryDrawerClose: string;
      secondaryDrawer: {
        contextLabel: string;
        openGraph: string;
        graphScopeAria: string;
        graphContextTitle: string;
        graphContextHelp: string;
        graphContextMetrics: (nodes: number, edges: number, views: number) => string;
        graphAnswerTitle: string;
        runtimeSession: (sessionId: string) => string;
        insufficientRuntimeSession: string;
        graphConversationListAria: string;
        archived: string;
        openable: string;
        changesLabel: string;
        loadDiff: string;
        loadingDiff: string;
        noLoadedChangesAria: string;
        noLoadedChangesTitle: string;
        noLoadedChangesHelp: string;
        changedFilesAria: string;
        realGitDiffFile: string;
        loaded: string;
        templatesLabel: string;
        loadingTemplates: string;
        loadTemplates: string;
        templateListAria: string;
        emptyTemplatesAria: string;
        emptyTemplatesTitle: string;
        emptyTemplatesHelp: string;
        builtInTaskTemplate: string;
        projectTaskTemplate: string;
        builtInTemplate: string;
        projectTemplate: string;
        applyTemplate: string;
      };
      runtimeDrawer: {
        runtimeEnvironment: string;
        refresh: string;
        runtimeStatus: string;
        detectedCommand: (command: string) => string;
        waitingForCommand: (command: string) => string;
        terminalBackend: string;
        terminalPending: string;
        runtimeSessions: string;
        startRuntimeSession: string;
        runtimeSessionSearch: string;
        searchSessions: string;
        searchSessionsHelp: string;
        favoritesOnly: string;
        showArchived: string;
        applyFilters: string;
        emptyRuntimeSessions: string;
        runtimeSessionStatusLabels: Record<AiRuntimeSessionStatus, string>;
        runtimeAdaptersAria: string;
        runtimeAdaptersTitle: string;
        codexCliDisplayName: string;
        genericShellDisplayName: string;
        adapterAvailable: string;
        adapterUnavailable: string;
        adapterUnchecked: string;
        checkAdapter: string;
        adapterCapabilities: (capabilities: string) => string;
        adapterVersion: (version: string) => string;
        adapterAuthStatus: (status: string) => string;
        adapterModelConfig: (modelConfiguration: string) => string;
        adapterAuthAuthenticated: string;
        adapterAuthUnauthenticated: string;
        adapterAuthUnknown: string;
        adapterVersionUnknown: string;
        adapterModelUserConfigured: string;
        genericShellRiskAria: string;
        genericShellRiskTitle: string;
        genericShellCommandAria: string;
        genericShellCommandTitle: string;
        genericShellCommandHelp: string;
        genericShellCommandPlaceholder: string;
        genericShellChangedStatus: string;
        genericShellConfirmationIdle: string;
        genericShellConfirmationCreated: (confirmationId: string) => string;
        genericShellConfirmationCreateFailed: string;
        genericShellConfirmationRejectFailed: string;
        genericShellCriticalPhraseRequired: (phrase: string) => string;
        genericShellConfirmationConsumed: (confirmationId: string) => string;
        genericShellConfirmationFailed: string;
        commandPreviewAria: string;
        commandPreviewTitle: string;
        commandPreviewHelp: string;
        emptyShellCommand: string;
        genericShellRiskSummary: (label: string, reason: string) => string;
        criticalPhraseAria: string;
        criticalPhraseTitle: string;
        criticalPhraseHelp: (phrase: string) => string;
        confirmationStateAria: string;
        confirmationStateTitle: string;
        confirmationStateHelp: string;
        rejectedAria: string;
        rejectedTitle: string;
        rejectedHelp: string;
        rejectedReasonFallback: string;
        createGenericShellConfirmation: string;
        rejectGenericShellConfirmation: string;
        confirmAndStartGenericShell: string;
        rejectImpactAria: string;
        rejectImpactTitle: string;
        rejectImpactHelp: string;
        rejectImpactBody: string;
        sessionSummaryFallback: string;
        runtimeSessionActionsAria: string;
        generateSummary: string;
        createTaskFromSession: string;
        taskDraftTitle: (command: string) => string;
        taskDraftInstruction: string;
        unfavoriteSession: string;
        favoriteSession: string;
        restoreSession: string;
        archiveSession: string;
        exportCurrentLog: string;
        deleteSession: string;
        runtimeInputAria: string;
        runtimeInputSendAria: string;
        runtimeInputTitle: string;
        runtimeInputHelp: string;
        sendRuntimeInput: string;
        terminalControlsAria: string;
        interrupt: string;
        resizeTerminal: string;
        loadTerminalSnapshot: string;
        stopSession: string;
        orphanControlsAria: string;
        unknownPid: string;
        orphanTitle: (pid: string | number) => string;
        orphanHelp: string;
        orphanStop: string;
        logsAria: string;
        logsTitle: string;
        logsHelp: string;
        logActionsAria: string;
        copyLogs: string;
        expandLogs: string;
        collapseLogs: string;
        logSearchAria: string;
        logSearchTitle: string;
        logSearchHelp: string;
        logExportIdle: string;
        logExportEmpty: string;
        logExportCancelled: string;
        logExportFailed: string;
        logExportSaved: (filePath: string) => string;
        logCopyIdle: string;
        logCopyEmpty: string;
        logCopySuccess: string;
        logCopyFailed: string;
        logExportState: (exportStatus: string, copyStatus: string) => string;
        logLegend: string;
        rawOutputAria: string;
        collapsedLogs: string;
        terminalAria: string;
      };
    };
    codeWorkspace: {
      detailAria: string;
      repositoryAria: string;
      stateProjectSettings: string;
      stateCodeGraph: string;
      overviewAria: string;
      contextRailAria: string;
      repositoryStatusAria: string;
      repositoryStatusTitle: string;
      localPath: string;
      scan: string;
      git: string;
      gitNotDetected: string;
      changeUnit: string;
      graph: string;
      graphSummaryAria: string;
      graphTitle: string;
      viewsAvailable: (count: number) => string;
      graphCounts: (nodes: number, edges: number) => string;
      waitingRealScan: string;
      emptyGraphHelp: string;
      primaryActionsAria: string;
      scanProject: string;
      openGraph: string;
      viewChanges: string;
      secondaryActionsAria: string;
      edit: string;
      configure: string;
      moreProjectActions: string;
      drawerLabel: string;
      graphDrawerAria: string;
      scanning: string;
      retryScan: string;
      openCodeMap: string;
      scanCurrentRepository: string;
      projectSettingsAria: string;
      projectCodeAria: string;
      projectListAria: string;
      projectSearchCreateAria: string;
      projectSearchAria: string;
      projectSearchTitle: string;
      projectSearchHelp: string;
      projectSearchAction: string;
      projectListContentAria: string;
      drawerBackdrop: string;
      drawerClose: string;
      scanStatuses: Record<'not_scanned' | 'scanning' | 'completed' | 'failed', string>;
      projectArchive: {
        aria: string;
        title: string;
        count: (count: number) => string;
        refresh: string;
        emptyAria: string;
        emptyTitle: string;
        emptyHelp: string;
        listAria: string;
        restore: string;
      };
      projectEdit: {
        formAria: string;
        currentProjectAria: string;
        currentProjectTitle: string;
        nameAria: string;
        nameTitle: string;
        nameHelp: string;
        pathAria: string;
        pathTitle: string;
        pathHelp: string;
        descriptionAria: string;
        descriptionTitle: string;
        descriptionHelp: string;
        saveAria: string;
        save: string;
        deleteAria: string;
        deleteTitle: string;
        deleteHelp: string;
        confirmDelete: string;
      };
      projectConfig: {
        formAria: string;
        currentStateAria: string;
        currentStateTitle: string;
        waitingToLoad: string;
        defaultModelAria: string;
        defaultModelTitle: string;
        defaultModelHelp: string;
        defaultWorkModeAria: string;
        defaultWorkModeTitle: string;
        defaultWorkModeHelp: string;
        defaultTaskPromptAria: string;
        defaultTaskPromptTitle: string;
        defaultTaskPromptHelp: string;
        scanIgnoreAria: string;
        scanIgnoreTitle: string;
        scanIgnoreHelp: string;
        indexScopeAria: string;
        indexScopeTitle: string;
        indexScopeHelp: string;
        indexScopeOptions: Record<ProjectConfig['scan']['indexScope'], string>;
        primaryLanguageAria: string;
        primaryLanguageTitle: string;
        primaryLanguageHelp: string;
        additionalLanguagesAria: string;
        additionalLanguagesTitle: string;
        additionalLanguagesHelp: string;
        packageManagersAria: string;
        packageManagersTitle: string;
        packageManagersHelp: string;
        manifestPathsAria: string;
        manifestPathsTitle: string;
        manifestPathsHelp: string;
        databaseConnectionAria: string;
        databaseConnectionTitle: string;
        databaseConnectionHelp: string;
        schemaPathsAria: string;
        schemaPathsTitle: string;
        schemaPathsHelp: string;
        telegramAliasAria: string;
        telegramAliasTitle: string;
        telegramAliasHelp: string;
        allowShellAria: string;
        allowShellTitle: string;
        allowShellHelp: string;
        allowGitWriteAria: string;
        allowGitWriteTitle: string;
        allowGitWriteHelp: string;
        databaseStateAria: string;
        databaseTitle: string;
        passwordStateAria: string;
        passwordTitle: string;
        passwordConfigured: string;
        passwordNotConfigured: string;
        passwordHelp: string;
        save: string;
        unsetPackageManagers: string;
        unsetManifestPaths: string;
        unsetConnectionName: string;
        unsetSchemaPaths: string;
        externalDatabaseHelp: string;
        localSchemaHelp: string;
      };
    };
    settingsWorkspace: {
      viewAria: string;
      categoryListAria: string;
      detailPaneAria: string;
      returnToApp: string;
      searchAria: string;
      searchPlaceholder: string;
      sectionGroups: {
        personal: string;
        integrations: string;
        coding: string;
        maintenance: string;
      };
      workModeTitle: string;
      workModeDescription: string;
      engineeringModeTitle: string;
      engineeringModeDescription: string;
      dailyModeTitle: string;
      dailyModeDescription: string;
      permissionsTitle: string;
      defaultPermissionTitle: string;
      defaultPermissionDescription: string;
      autoReviewTitle: string;
      autoReviewDescription: string;
      fullAccessTitle: string;
      fullAccessDescription: string;
      protectedStatus: string;
      waitingStatus: string;
      localStatus: string;
      categories: Record<SettingsCategory, string>;
      generalPaneTitle: string;
      appLanguageTitle: string;
      appLanguageDescription: string;
      appearanceTitle: string;
      appearanceDescription: string;
      desktopNotificationsTitle: string;
      desktopNotificationsDescription: string;
      desktopNotificationsSwitchAria: string;
      desktopNotificationsInputAria: string;
      notificationsEnabled: string;
      notificationsDisabled: string;
      notificationsEnabledHelp: string;
      notificationsDisabledHelp: string;
      saveSettingsTitle: string;
      saveSettingsDescription: string;
      save: string;
      runtime: {
        paneTitle: string;
        cliStatusAria: string;
        detected: string;
        waitingConfiguration: string;
        defaultAdapterAria: string;
        defaultAdapterTitle: string;
        defaultAdapterDescription: string;
        codexCliDisplayName: string;
        genericShellDisplayName: string;
        adapterActionMeta: string;
        currentDefaultAria: string;
        currentDefaultTitle: string;
        currentDefault: (adapter: string) => string;
        adapterModelAria: string;
        adapterModelTitle: string;
        adapterModelDescription: string;
        defaultArgsAria: string;
        defaultArgsTitle: string;
        defaultArgsDescription: string;
        cliPathAria: string;
        cliPathTitle: string;
        cliPathDescription: string;
        concurrencyAria: string;
        concurrencyTitle: string;
        globalConcurrency: (count: number) => string;
        timeoutAria: string;
        timeoutTitle: string;
        seconds: (count: number) => string;
        logRetention: (days: number) => string;
        autoConfirmAria: string;
        autoConfirmTitle: string;
        autoConfirmHighRiskBoundary: string;
        autoConfirmPolicies: Record<RuntimeSettings['autoConfirmationPolicy'], string>;
        timeoutSecondsAria: string;
        timeoutSecondsTitle: string;
        timeoutSecondsDescription: string;
        secondsUnit: string;
        advancedAria: string;
        advancedTitle: string;
        advancedDescription: string;
        advancedHelp: string;
        shellPathTitle: string;
        shellPathAria: string;
        terminalEnvTitle: string;
        terminalEnvAria: string;
        loginShell: string;
        nonLoginShell: string;
        modelMeta: string;
        argsMeta: string;
        saveDefaultAdapter: string;
      };
      telegram: {
        paneTitle: string;
        botTokenAria: string;
        botTokenTitle: string;
        botTokenConfigured: string;
        botTokenNotConfigured: string;
        botTokenHelp: (label: string) => string;
        tokenFieldLabel: string;
        saveToKeychain: string;
        clearToken: string;
        chatIdAria: string;
        chatIdTitle: string;
        chatIdFieldLabel: string;
        notTested: string;
        saveNotifications: string;
        testConnection: string;
        testSuccess: (chatIds: string, attempts: number, sentAt: string) => string;
        testFailed: string;
        pollingAria: string;
        pollingTitle: string;
        pollingDescription: string;
        pollingState: (running: boolean, offset: number) => string;
        emptyPollingLogs: string;
        latestLogs: string;
      };
      security: {
        paneTitle: string;
        externalApiKeyAria: string;
        externalApiKeyTitle: string;
        externalApiKeyConfigured: string;
        externalApiKeyNotConfigured: string;
        externalApiKeyHelp: (label: string) => string;
        externalApiKeyFieldLabel: string;
        saveApiKey: string;
        clearApiKey: string;
        allowlistAria: string;
        allowlistTitle: string;
        allowlistDescription: string;
        allowlistFieldAria: string;
        allowlistFieldLabel: string;
        saveAllowlist: string;
        exposureRiskAria: string;
        exposureRiskTitle: string;
        exposureRiskDescription: string;
        exposureRiskResetHelp: string;
        resetSecurity: string;
        auditAria: string;
        auditTitle: string;
        auditDescription: string;
        emptyAudit: string;
        latestAudit: string;
      };
      git: {
        paneTitle: string;
        branchNameAria: string;
        branchNameTitle: string;
        branchNameDescription: string;
        remoteAria: string;
        remoteTitle: string;
        remoteDescription: string;
        confirmationAria: string;
        confirmationTitle: string;
        confirmationDescription: string;
        targetBranch: (branch: string) => string;
        remoteTarget: (remote: string, target: string) => string;
        requestBranchConfirmation: string;
        requestPushConfirmation: string;
      };
      release: {
        paneTitle: string;
        signingAria: string;
        signingTitle: string;
        signingEnvironmentOnly: string;
        notarizationAria: string;
        notarizationTitle: string;
        notarizationDescription: string;
        caskAria: string;
        caskTitle: string;
        releaseSigningConfigured: string;
        releaseSigningWaiting: string;
        releaseNotarizationConfigured: string;
        releaseNotarizationWaiting: string;
        releaseCaskDetected: string;
        releaseCaskWaiting: string;
        unsignedBuildAvailable: string;
        unsignedBuildUnavailable: string;
        detailAria: string;
        detailTitle: string;
        detailDescription: string;
        autoUpdateReserved: string;
        autoUpdateManual: (version: string) => string;
        autoUpdateFeed: (channel: string, version: string) => string;
        realReleaseStatus: string;
        updateAria: string;
        updateActionAria: string;
        updateTitle: string;
        updateStatusLabels: {
          up_to_date: (version: string) => string;
          available: (version: string) => string;
          unavailable: string;
        };
        updateReasons: {
          current: string;
          availableManual: string;
          availableInstallable: string;
          noArtifact: string;
          unavailable: string;
        };
        waitingForLabels: Record<string, string>;
        installHelp: (automatic: boolean) => string;
        checking: string;
        checkUpdates: string;
        versionAria: string;
        versionTitle: string;
        checkedAt: (value: string) => string;
        notChecked: string;
        currentVersion: (version: string) => string;
        latestVersion: (version: string) => string;
        updateChannelLabels: Record<ReleaseUpdateStatusSnapshot['channel'], string>;
        artifactAria: string;
        artifactTitle: string;
        artifactKindLabels: Record<NonNullable<ReleaseUpdateStatusSnapshot['artifact']>['kind'], string>;
        waitingArtifact: string;
        noArtifact: string;
        updateFailed: string;
        recommendedActions: Record<ReleaseUpdateStatusSnapshot['recommendedAction'], string>;
      };
      data: {
        paneTitle: string;
        portabilityAria: string;
        localLogDirectoryTitle: string;
        localLogDirectoryDescription: string;
        notImportedExported: string;
        exportSettings: string;
        importSettings: string;
        clearCache: string;
        exported: (target: string) => string;
        imported: (target: string, changed: string) => string;
        noSettingsChanged: string;
      };
    };
    gitDiffWorkspace: {
      drawerAria: string;
      title: string;
      exportPatch: string;
      worktreeStateAria: string;
      worktreeStateTitle: string;
      cleanStatus: string;
      changedStatus: (count: number) => string;
      worktreeMeta: (conflicts: number, remoteBranches: number, latestCommit?: string) => string;
      changedFilesAria: string;
      emptyChangedFiles: string;
      fileReviewAria: (path: string) => string;
      fileDiffTitle: (path: string) => string;
      pendingDecision: string;
      hunkActionsAria: (header: string) => string;
      acceptHunk: string;
      rejectHunk: string;
      riskParamsAria: string;
      riskParamsTitle: string;
      branchNameAria: string;
      branchNameTitle: string;
      branchNameHelp: string;
      switchBranchAria: string;
      switchBranchTitle: string;
      switchBranchHelp: string;
      baseRefAria: string;
      baseRefTitle: string;
      baseRefHelp: string;
      stashRefAria: string;
      stashRefTitle: string;
      stashRefHelp: string;
      remoteNameAria: string;
      remoteNameTitle: string;
      remoteNameHelp: string;
      targetRefAria: string;
      targetRefTitle: string;
      targetRefHelp: string;
      rollbackTargetAria: string;
      rollbackTargetTitle: string;
      rollbackTargetHelp: string;
      confirmationAria: string;
      commitMessageAria: string;
      commitMessageTitle: string;
      commitMessageHelp: string;
      commitMessageStatusAria: string;
      commitMessageStatusTitle: string;
      commitMessageStatusHelp: string;
      commitMessageStatusText: string;
      requestStashConfirmation: string;
      requestCommitConfirmation: string;
      currentConfirmationAria: string;
      currentConfirmationTitle: string;
      confirmationStatusLabels: Record<GitOperationConfirmation['status'], string>;
      patchStatusAria: string;
      patchStatusTitle: string;
      localExport: string;
      confirmationExpiryAria: string;
      confirmationExpiryTitle: string;
      confirmationExpiryHelp: string;
      confirmOperation: string;
      rejectConfirmation: string;
      rejectImpactAria: string;
      rejectImpactTitle: string;
      safetyBoundary: string;
      rejectImpactText: string;
      rejectedAria: string;
      rejectedTitle: string;
      rejectedHelp: string;
      rejectedFallback: string;
      whitelistScopeAria: string;
      executionScopeTitle: string;
      whitelistCommandHelp: string;
      whitelistCommandText: string;
      executeConfirmed: string;
      operationStatusAria: string;
      operationStatusTitle: string;
      localExecutionChain: string;
      patchNotExported: string;
      operationNotExecuted: string;
      operationConfirmFailed: string;
      rejectStatus: string;
      rejectFailed: string;
      commitMessageRequired: string;
      executedStatus: (operation: string, args: string) => string;
      executeFailed: string;
      patchSaved: (filePath: string | null) => string;
      patchGenerated: (fileName: string) => string;
      unknownExpiry: string;
      operationLabels: Record<string, string>;
      decisionSummary: (accepted: number, rejected: number, pending: number) => string;
      reviewSummary: (files: number, hunks: number, added: number, deleted: number) => string;
    };
    codeMapWorkspace: {
      viewAria: string;
      statusAria: string;
      contextStripAria: string;
      title: string;
      sourceSummary: string;
      contextFactsAria: string;
      realSource: string;
      currentView: string;
      viewSwitcherAria: string;
      performanceAria: string;
      viewReadPrefix: string;
      realNodes: string;
      realEdges: string;
      primaryGridAria: string;
      stageAria: string;
      inspectorAria: string;
      visibilityAria: string;
      hiddenNodes: (count: number) => string;
      restoreAllNodes: string;
      secondaryToolsAria: string;
      toolSwitchAria: string;
      tools: Record<CodeMapToolPanel, { label: string; description: string }>;
      searchPanelAria: string;
      searchFilterAria: string;
      nodeSearchAria: string;
      nodeSearchTitle: string;
      nodeSearchHelp: string;
      nodeTypeAria: string;
      nodeTypeTitle: string;
      nodeTypeHelp: string;
      edgeTypeAria: string;
      edgeTypeTitle: string;
      edgeTypeHelp: string;
      minConfidenceAria: string;
      minConfidenceTitle: string;
      minConfidenceHelp: string;
      searchAction: string;
      resultCount: (count: number) => string;
      qaPanelAria: string;
      qaComposeAria: string;
      qaModeRailAria: string;
      askGraphTitle: string;
      askGraphHelp: string;
      questionAria: string;
      questionTitle: string;
      questionHelp: string;
      askGraphAction: string;
      explainNodeQuestion: (name: string, source: string) => string;
      nodeDetail: string;
      edgeDetail: string;
      currentSelection: string;
      nodeSource: string;
      edgeSource: string;
      lineLabel: string;
      missingSymbol: string;
      graphRuntime: string;
      runtimeToolCollapsed: string;
      sequenceRuntimeHidden: string;
      sigmaTitle: string;
      sigmaSourceAria: string;
      sigmaEmpty: string;
      reactFlowTitle: string;
      reactFlowEdgesAria: string;
      reactFlowEmpty: string;
      graphCanvas: string;
      sequenceGraphCanvas: string;
      canvasEmpty: string;
      aggregatedEdges: string;
      nodeCount: (count: number) => string;
      edgeCount: (count: number) => string;
      lifelineCount: (count: number) => string;
      aggregatedEdgeCount: (count: number) => string;
      serverLayout: string;
      canvasSourcesAria: string;
      openSourceShortcut: string;
      createTaskShortcut: string;
      graphNodeTaskStatusAria: string;
      graphNodeTaskCreating: string;
      graphNodeTaskCreated: string;
      graphNodeTaskCreateFailed: string;
      graphNodeTaskRetry: string;
      graphNodeTaskRetryAria: string;
      graphAnswerAria: string;
      runtimeSessionLabel: string;
      insufficientRuntimeSession: string;
      qaHistoryAria: string;
      qaHistoryToolbarAria: string;
      qaHistorySearchAria: string;
      searchHistoryTitle: string;
      searchHistoryHelp: string;
      searchHistoryAction: string;
      viewActiveHistory: string;
      viewArchivedHistory: string;
      realQaCount: (count: number) => string;
      qaHistoryEmptyAria: string;
      noRealQaHistory: string;
      noMatchingQaHistory: string;
      qaHistoryEmptyHelp: string;
      answerNotGenerated: string;
      viewDetail: string;
      createTaskFromQa: string;
      graphConversationTaskIntent: string;
      graphNodeTaskIntent: string;
      restoreHistory: string;
      archiveHistory: string;
      qaPaginationAria: string;
      previousPage: string;
      nextPage: string;
      pageRangeEmpty: string;
      pageRange: (start: number, end: number) => string;
      qaDetailAria: string;
      qaDetailStatusAria: string;
      archivedStatus: string;
      activeStatus: string;
      conversationStatusLabels: Record<string, string>;
      messageCount: (count: number) => string;
      qaMessagesAria: string;
      assistantAnswer: string;
      userQuestion: string;
      messageSourceLabels: Record<string, string>;
      mermaidPanelAria: string;
      mermaidPreviewAria: string;
      mermaidExportCommandsAria: string;
      diagramFormatAria: string;
      mermaidPreviewTitle: string;
      plantUmlPreviewTitle: string;
      mermaidSequencePreviewTitle: string;
      plantUmlSequencePreviewTitle: string;
      mermaidPreviewHelp: string;
      hideMermaidSource: string;
      generateMermaidPreview: string;
      exportMermaidSource: string;
      mermaidSavedStatus: (filePath: string) => string;
      mermaidGeneratedStatus: (fileName: string) => string;
      mermaidSaveFailedStatus: string;
      mermaidSourceAria: string;
      mermaidEmptyAria: string;
      mermaidEmptyTitle: string;
      mermaidEmptyHelp: string;
      mermaidStatusAria: string;
      mermaidGeneratedFile: (fileName: string, mimeType: string) => string;
      entityPanelAria: string;
      entityWorkbenchAria: string;
      graphNodesAria: string;
      graphNodesTitle: string;
      realNodeCount: (count: number) => string;
      sourceCount: (count: number) => string;
      aggregatedNodeSummary: (count: number, sourceCount: number) => string;
      aggregateNodeLabel: string;
      createTaskFromNode: string;
      openSource: string;
      graphSourceOpenStatusAria: string;
      graphSourceOpenOpening: string;
      graphSourceOpenOpened: string;
      graphSourceOpenFailed: string;
      restoreNode: string;
      hideNode: string;
      openNodeMenu: string;
      nodeActionMenuAria: string;
      graphEdgesAria: string;
      graphEdgesTitle: string;
      realEdgeCount: (count: number) => string;
      aggregatedEdgeSummary: (count: number, sourceCount: number) => string;
      confidenceValue: (confidence: string) => string;
      confidenceUnknown: string;
      aiSummary: string;
      recentTasks: string;
      unnamedTask: string;
      unknownTaskStatus: string;
      oneHopNeighbors: string;
      twoHopImpact: string;
      riskTags: string;
      nodeActions: {
        inspectDetail: string;
        openSource: string;
        askNode: string;
        generateSequence: string;
        generateFlow: string;
        expandOneHop: string;
        expandTwoHop: string;
        createTask: string;
        restoreNode: string;
        hideNode: string;
      };
    };
  }
>;

/** 动作入口在真实提交、扫描、读取中时统一挂载 busy 属性，让 CSS 产品态接管而不是只靠 disabled 变灰。 */
function controlBusyProps(isBusy: boolean): ControlBusyProps {
  return isBusy ? { 'aria-busy': true, 'data-loading': 'true' } : {};
}

function normalizeTaskStatusFilterByProject(value: unknown): Record<string, TaskStatusFilter> {
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

function normalizeRendererAppShellSettings(settings: AppShellSettings): AppShellSettings {
  const taskTableColumnsByProject = Object.fromEntries(
    Object.entries(settings.taskTableColumnsByProject ?? {})
      .filter(([projectId]) => Boolean(projectId.trim()))
      .map(([projectId, preferences]) => [projectId.trim(), normalizeTaskTableColumnPreferences(preferences)]),
  );
  return {
    ...settings,
    collapsedProjectIds: Array.isArray(settings.collapsedProjectIds) ? [...new Set(settings.collapsedProjectIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).map((id) => id.trim()))].slice(0, 100) : [],
    taskTableColumns: normalizeTaskTableColumnPreferences(settings.taskTableColumns),
    taskTableColumnsByProject,
    taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders(settings.taskTableEnumSortOrders),
    taskStatusFilterByProject: normalizeTaskStatusFilterByProject(settings.taskStatusFilterByProject),
  };
}

export function toAppShellSettingsSavePayload(settings: AppShellSettings): AppShellSettingsSavePayload {
  const taskTableColumns = normalizeTaskTableColumnPreferences(settings.taskTableColumns);
  const taskTableColumnsByProject = Object.fromEntries(Object.entries(settings.taskTableColumnsByProject ?? {}).map(([projectId, preferences]) => [projectId, normalizeTaskTableColumnPreferences(preferences)]));
  const taskStatusFilterByProject = normalizeTaskStatusFilterByProject(settings.taskStatusFilterByProject);
  return {
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
    taskStatusFilterByProject,
  };
}

function resolveTaskTableColumnsForProject(settings: AppShellSettings, projectId: string | undefined): TaskTableColumnPreferences {
  if (projectId) {
    const projectPreferences = settings.taskTableColumnsByProject?.[projectId];
    if (projectPreferences) return normalizeTaskTableColumnPreferences(projectPreferences);
  }
  return normalizeTaskTableColumnPreferences(settings.taskTableColumns);
}

function resolveTaskStatusFilterForProject(settings: AppShellSettings, projectId: string | undefined): TaskStatusFilter {
  if (!projectId) return 'unfinished';
  const filter = settings.taskStatusFilterByProject?.[projectId];
  return isTaskStatusFilter(filter) ? filter : 'unfinished';
}

function taskTableColumnPreferencesEqual(left: TaskTableColumnPreferences, right: TaskTableColumnPreferences): boolean {
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
  };
}

export function mergeAppShellSettingsSaveResponse(input: { currentSettings: AppShellSettings; savedSettings: AppShellSettings }): AppShellSettings {
  const currentSettings = normalizeRendererAppShellSettings(input.currentSettings);
  const savedSettings = normalizeRendererAppShellSettings(input.savedSettings);
  // 普通 AppShell 保存可能比字段偏好保存更晚返回；合并时固定保留当前最新字段列，避免旧 payload 把任务表配置回滚。
  return {
    ...savedSettings,
    taskTableColumns: currentSettings.taskTableColumns,
    taskTableColumnsByProject: currentSettings.taskTableColumnsByProject,
    taskTableEnumSortOrders: currentSettings.taskTableEnumSortOrders,
    taskStatusFilterByProject: currentSettings.taskStatusFilterByProject,
  };
}

/** 应用语言只在一处翻译核心枚举值，避免中文界面继续漏出 plan、ready 等内部状态码。 */
function getLanguageCopy(appLanguage: AppLanguage) {
  return languageCopy[appLanguage] ?? languageCopy['zh-CN'];
}

/** 数据导入导出状态存结构化事实，渲染时再按当前语言转成人话，避免切换语言后残留旧语言。 */
function formatDataPortabilityStatus(status: DataPortabilityStatusState, copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['data']): string {
  if (status.kind === 'idle') return copy.notImportedExported;
  if (status.kind === 'exported') return copy.exported(status.target);
  return copy.imported(status.target, status.changedSettings.length > 0 ? status.changedSettings.join(', ') : copy.noSettingsChanged);
}

/** Runtime 日志导出状态只存结构化事实，渲染时按当前语言输出，避免英文界面残留中文状态。 */
function formatRuntimeLogExportStatus(status: RuntimeLogExportStatusState, copy: ReturnType<typeof getLanguageCopy>['sessionWorkspace']['runtimeDrawer']): string {
  if (status.kind === 'empty') return copy.logExportEmpty;
  if (status.kind === 'cancelled') return copy.logExportCancelled;
  if (status.kind === 'saved') return copy.logExportSaved(status.filePath);
  if (status.kind === 'failed') return copy.logExportFailed;
  return copy.logExportIdle;
}

/** Runtime 日志复制状态只存结构化事实，渲染时按当前语言输出，避免切换语言后保留旧状态字符串。 */
function formatRuntimeLogCopyStatus(status: RuntimeLogCopyStatusState, copy: ReturnType<typeof getLanguageCopy>['sessionWorkspace']['runtimeDrawer']): string {
  if (status.kind === 'empty') return copy.logCopyEmpty;
  if (status.kind === 'copied') return copy.logCopySuccess;
  if (status.kind === 'failed') return copy.logCopyFailed;
  return copy.logCopyIdle;
}

function formatReleasePresenceStatus(kind: 'signing' | 'notarization' | 'homebrewCask', status: ReleaseStatusSnapshot[typeof kind], copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  // 发布状态 label 是本机后端检测结果，渲染层按当前语言重建 UI 文案，避免英文界面漏出中文后端 label。
  if (kind === 'signing') return status.configured ? copy.releaseSigningConfigured : copy.releaseSigningWaiting;
  if (kind === 'notarization') return status.configured ? copy.releaseNotarizationConfigured : copy.releaseNotarizationWaiting;
  return status.configured ? copy.releaseCaskDetected : copy.releaseCaskWaiting;
}

function formatReleaseAutoUpdateLabel(status: ReleaseStatusSnapshot['autoUpdate'], copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  return status.updateFeedConfigured ? copy.autoUpdateFeed(formatReleaseUpdateChannel(status.channel as ReleaseUpdateStatusSnapshot['channel'], copy), status.currentVersion) : copy.autoUpdateManual(status.currentVersion);
}

function formatReleaseUpdateLabel(status: ReleaseUpdateStatusSnapshot, copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  if (status.status === 'up_to_date') return copy.updateStatusLabels.up_to_date(status.currentVersion);
  if (status.status === 'available') return copy.updateStatusLabels.available(status.latestVersion);
  return copy.updateStatusLabels.unavailable;
}

function formatReleaseUpdateReason(status: ReleaseUpdateStatusSnapshot, copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  if (status.status === 'up_to_date') return copy.updateReasons.current;
  if (status.status === 'available' && !status.artifact) return copy.updateReasons.noArtifact;
  if (status.status === 'available') return status.automaticInstallEnabled ? copy.updateReasons.availableInstallable : copy.updateReasons.availableManual;
  return copy.updateReasons.unavailable;
}

function formatReleaseUpdateChannel(channel: ReleaseUpdateStatusSnapshot['channel'], copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  // Release 更新渠道是结构化枚举，渲染时转换成人话；不要把 stable/preview 原样塞进设置页。
  return copy.updateChannelLabels[channel] ?? channel;
}

function formatReleaseArtifactKind(kind: NonNullable<ReleaseUpdateStatusSnapshot['artifact']>['kind'], copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  // 安装包类型是发布 manifest 枚举；文件名继续保留真实扩展名，摘要文案按当前语言展示。
  return copy.artifactKindLabels[kind] ?? kind;
}

function formatReleaseWaitingForItems(items: string[], copy: ReturnType<typeof getLanguageCopy>['settingsWorkspace']['release']): string {
  // release-core 的 waitingFor 是结构化英文键；已知键按当前语言展示，未知键保留原值方便排查真实发布依赖。
  const labels: Record<string, string> = copy.waitingForLabels;
  return items.map((item) => labels[item] ?? item).join(' · ');
}

/** Runtime 会话状态是 API/存储枚举，界面按当前语言格式化，不能把 running/orphan_detected 直接露给用户。 */
function formatRuntimeSessionStatus(status: AiRuntimeSessionStatus, copy: ReturnType<typeof getLanguageCopy>['sessionWorkspace']['runtimeDrawer']): string {
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

export function buildGraphConversationTaskIntent(appLanguage: AppLanguage): string {
  // 图谱问答转任务的 intent 属于 UI 动作语义，必须跟随当前界面语言；图谱来源和会话事实仍由后端保留原文。
  return getLanguageCopy(appLanguage).codeMapWorkspace.graphConversationTaskIntent;
}

export function buildGraphNodeTaskIntent(appLanguage: AppLanguage): string {
  // 图谱节点转任务的 intent 只描述动作意图；真实节点名、路径和来源继续由后端从图谱事实读取。
  return getLanguageCopy(appLanguage).codeMapWorkspace.graphNodeTaskIntent;
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
    title: '',
    description: '',
    priority: 'p3',
    tags: '',
    attachments: [],
  };
}

export function normalizeTaskCreateDraft(form: TaskCreateFormState, titleRequiredMessage: string): { draft: TaskCreateDraft } | { error: string } {
  const title = form.title.trim();
  if (!title) return { error: titleRequiredMessage };
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
      description: form.description.trim(),
      priority: form.priority,
      tags,
      // 任务持久化只保存 Zeus 托管后的本机路径与元信息；data URL 预览只留在本次 UI 状态，避免把大图写入任务 JSON。
      attachments: form.attachments.map(toPersistedTaskAttachment),
    },
  };
}

/** Runtime 适配器 ID 是真实配置值，界面只在已知内置适配器上转换成人话标签，未知 ID 保留原值方便排障。 */
function formatRuntimeAdapterDisplayName(adapterId: string, adapters: AiRuntimeAdapterDescriptor[], copy: { codexCliDisplayName: string; genericShellDisplayName: string }): string {
  const displayName = adapters.find((adapter) => adapter.id === adapterId)?.displayName;
  // 只本地化 Zeus 内置 Generic shell 默认标签；如果后端或插件提供了自定义 displayName，保留真实值便于排障。
  if (adapterId === 'generic' && (!displayName || displayName === 'Generic shell')) return copy.genericShellDisplayName;
  return displayName ?? (adapterId === 'codex' ? copy.codexCliDisplayName : adapterId);
}

/** 旧 hash 只做兼容迁移；当前可见导航已经改为项目优先 source-list，不再保留三项顶层菜单数组。 */
function normalizeMainNavTarget(hash: string | undefined): MainNavTarget {
  const target = hash?.replace(/^#/, '');
  if (!target) return 'conversations';
  if (target === 'dashboard' || target === 'tasks' || target === 'runtime' || target === 'conversations') return 'conversations';
  if (target === 'code-map' || target === 'git-diff' || target === 'projects') return 'projects';
  if (target === 'telegram' || target === 'settings' || target?.startsWith('settings-')) return 'settings';
  return 'conversations';
}

function readCurrentMainNavTarget(): MainNavTarget {
  return typeof window === 'undefined' ? 'conversations' : normalizeMainNavTarget(window.location.hash);
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

function resolveInitialGraphProjectId(initialGraphView: GraphViewSnapshot | undefined, explicitProjectId: string | undefined, projects: ProjectRecord[]): string | undefined {
  if (!initialGraphView) return undefined;
  if (explicitProjectId) {
    const explicitProject = projects.find((project) => project.id === explicitProjectId);
    // 启动恢复态传入 projectId 时也必须反查图谱归属；旧版全局“系统架构图”不能因为显式 id 被硬贴到另一个项目。
    return explicitProject && canAttachInitialGraphViewToProject(initialGraphView, explicitProject) ? explicitProjectId : undefined;
  }
  if (projects.length !== 1) return undefined;
  const [project] = projects;
  if (!project) return undefined;
  // 初始图谱来自恢复态或预览态；只有项目身份明确匹配，或旧版 Zeus 自身的全局图谱恢复，才允许自动挂到当前项目。
  if (!canAttachInitialGraphViewToProject(initialGraphView, project)) return undefined;
  return project.id;
}

const projectGraphTitleSuffixes = ['系统架构图', '模块图', '表关系图', '模块详情图', '接口时序图', '模块流程图', '方法逻辑图'];

export function isProjectGraphViewForProject(graphView: GraphViewSnapshot, project: Pick<ProjectRecord, 'id' | 'name'> | undefined, options: { requireProjectIdentity?: boolean } = {}): boolean {
  if (!project) return false;
  // 项目级图谱响应一旦携带归属元数据，就必须和当前项目完全匹配；缺省元数据仅为旧预览数据/旧全局接口兼容。
  if (graphView.projectId && graphView.projectId !== project.id) return false;
  if (graphView.projectName && graphView.projectName !== project.name) return false;
  if (!isProjectGraphViewTitleForProject(graphView, project, options)) return false;
  if (options.requireProjectIdentity && !graphView.projectId && !graphView.projectName) return false;
  return true;
}

function isProjectGraphViewTitleForProject(graphView: Pick<GraphViewSnapshot, 'title'>, project: Pick<ProjectRecord, 'name'>, options: { requireProjectIdentity?: boolean } = {}): boolean {
  if (typeof graphView.title !== 'string') return true;
  const title = graphView.title.trim();
  const projectName = project.name.trim();
  if (!title || !projectName) return true;
  const normalizedTitle = title.toLocaleLowerCase();
  const normalizedProjectName = projectName.toLocaleLowerCase();
  const hasStandardGraphSuffix = projectGraphTitleSuffixes.some((suffix) => title === suffix || title.endsWith(` ${suffix}`));
  if (!hasStandardGraphSuffix) return true;
  // 标准图谱标题是用户最先看到的事实来源；只要是项目级图谱，就必须以当前项目名开头，避免 A 项目被旧响应盖上 B 项目 metadata 后继续显示 B 图谱。
  if (normalizedTitle.startsWith(`${normalizedProjectName} `)) return true;
  return !options.requireProjectIdentity && title === projectGraphTitleSuffixes.find((suffix) => suffix === title);
}

function canAttachInitialGraphViewToProject(graphView: GraphViewSnapshot, project: Pick<ProjectRecord, 'id' | 'name'>): boolean {
  if (graphView.projectId || graphView.projectName) {
    return isProjectGraphViewForProject(graphView, project);
  }
  const normalizedProjectName = project.name.trim().toLocaleLowerCase();
  // 旧版全局 scan-current 没有 projectId/projectName，但 Zeus 自身历史图谱仍要能恢复；非 Zeus 项目不能吃到 “Zeus 系统架构图”。
  if (normalizedProjectName === 'zeus') return true;
  const normalizedGraphTitle = typeof graphView.title === 'string' ? graphView.title.trim().toLocaleLowerCase() : '';
  return normalizedProjectName === 'zeus' || normalizedGraphTitle === normalizedProjectName || normalizedGraphTitle.startsWith(`${normalizedProjectName} `);
}

/** 首屏只打开一个真实工作区；预览或恢复态带有明确数据时进入对应入口，避免把所有内容铺成一页。 */
function inferInitialMainNavTarget(props: {
  initialMainNavTarget?: LegacyMainNavTarget;
  initialGraphView?: GraphViewSnapshot;
  initialGraphAnswer?: GraphQuestionAnswer;
  initialGraphConversations?: GraphConversationHistoryItem[];
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
  if (props.initialGitDiff || props.initialGitConfirmation || props.initialGraphView || props.initialGraphAnswer || props.initialGraphConversations?.length) return 'projects';
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

function inferInitialProjectSection(props: {
  initialMainNavTarget?: LegacyMainNavTarget;
  initialGraphView?: GraphViewSnapshot;
  initialGraphAnswer?: GraphQuestionAnswer;
  initialGraphConversations?: GraphConversationHistoryItem[];
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
  if (props.initialProjectConfig || props.initialProjectDatabaseSecret) return 'project-settings';
  if (props.initialMainNavTarget === 'tasks') return 'tasks';
  if (props.initialMainNavTarget === 'code-map' || props.initialMainNavTarget === 'git-diff' || props.initialMainNavTarget === 'projects') return 'code';
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
  if (props.initialGraphView || props.initialGraphAnswer || props.initialGraphConversations?.length || props.initialGitDiff || props.initialGitConfirmation) return 'code';
  const firstProject = props.snapshot?.projects[0];
  return firstProject && firstProject.scanStatus === 'not_scanned' ? 'code' : 'sessions';
}

function syncRecordFromSnapshot<T extends { id: string }>(current: T | undefined, records: T[]): T | undefined {
  return current ? (records.find((record) => record.id === current.id) ?? records[0]) : records[0];
}

function selectCreatedProjectTask(snapshot: DashboardSnapshot, previousTaskIds: Set<string>, projectId: string): TaskRecord | undefined {
  return snapshot.tasks.find((task) => task.projectId === projectId && !previousTaskIds.has(task.id)) ?? snapshot.tasks.find((task) => task.projectId === projectId);
}

function selectCreatedGraphNodeTask(snapshot: DashboardSnapshot, previousTaskIds: Set<string>, projectId: string): TaskRecord | undefined {
  return selectCreatedProjectTask(snapshot, previousTaskIds, projectId);
}

function normalizeProjectLocalPath(localPath: string): string {
  const trimmed = localPath.trim();
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/u, '');
}

interface ProjectCreateFormState {
  name: string;
  localPath: string;
}

function defaultProjectNameFromLocalPath(localPath: string): string {
  const normalizedPath = normalizeProjectLocalPath(localPath);
  if (normalizedPath === '/') return 'Root';
  return normalizedPath.split('/').filter(Boolean).at(-1) ?? '';
}

function dedupeProjectRecordsByLocalPath(projects: ProjectRecord[]): ProjectRecord[] {
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

function orderProjectsByPinnedIds(projects: ProjectRecord[], pinnedProjectIds: string[]): ProjectRecord[] {
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

const graphViewOptions: Array<{ type: GraphViewType }> = [{ type: 'architecture' }, { type: 'module' }, { type: 'table' }, { type: 'module_detail' }, { type: 'api_sequence' }, { type: 'module_flow' }, { type: 'method_logic' }];

const codeMapToolPanels: Array<{ id: CodeMapToolPanel }> = [{ id: 'runtime' }, { id: 'search' }, { id: 'qa' }, { id: 'mermaid' }, { id: 'entities' }];

function TaskCreateModal(props: {
  open: boolean;
  copy: ReturnType<typeof getLanguageCopy>['taskWorkspace'];
  form: TaskCreateFormState;
  error?: string;
  busy: boolean;
  titleInputRef: RefObject<HTMLInputElement | null>;
  onFormChange: (field: TaskCreateTextField, value: string) => void;
  onPriorityChange: (priority: TaskPriority) => void;
  onChooseAttachments: () => void;
  onAuthorizeFiles: (files: File[], source: 'paste' | 'drop') => Promise<TaskResourceAuthorizationResult>;
  onMaterializeResources: (resources: TaskResourcePayload[]) => Promise<TaskCreateAttachment[]>;
  onReadClipboardResources: () => Promise<{ resources: TaskCreateAttachment[]; text: string }>;
  onAddAttachments: (attachments: TaskCreateAttachment[]) => void;
  onLoadAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
  onRemoveAttachment: (path: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const pasteShortcutFallbackTokenRef = useRef(0);
  const [resourceProcessingCount, setResourceProcessingCount] = useState(0);
  const [resourceDragDepth, setResourceDragDepth] = useState(0);
  if (!props.open) return null;
  const describedBy = props.error ? 'task-create-error' : undefined;
  const resourcesBusy = resourceProcessingCount > 0;
  const interactionBusy = props.busy || resourcesBusy;

  function trapTaskCreateModalFocus(event: ReactKeyboardEvent<HTMLFormElement>): void {
    if (event.key !== 'Tab' || typeof document === 'undefined') return;
    const focusableTaskCreateControls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'),
    ).filter((element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true');
    if (focusableTaskCreateControls.length === 0) return;
    const firstControl = focusableTaskCreateControls[0];
    const lastControl = focusableTaskCreateControls[focusableTaskCreateControls.length - 1];
    // 弹窗打开时把 Tab 环限制在表单内，避免键盘用户跳到背景任务列表后误操作真实任务。
    if (event.shiftKey && document.activeElement === firstControl) {
      event.preventDefault();
      lastControl?.focus();
    } else if (!event.shiftKey && document.activeElement === lastControl) {
      event.preventDefault();
      firstControl?.focus();
    }
  }

  function handleTaskCreateModalKeyDown(event: ReactKeyboardEvent<HTMLFormElement>): void {
    trapTaskCreateModalFocus(event);
    if (event.key === 'Escape' && !interactionBusy) {
      event.stopPropagation();
      props.onClose();
      return;
    }
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
    setResourceProcessingCount((current) => current + 1);
    try {
      await operation();
    } finally {
      setResourceProcessingCount((current) => Math.max(0, current - 1));
    }
  }

  async function handleTaskCreateClipboardPaste(event: ReactClipboardEvent<HTMLFormElement>): Promise<void> {
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
        if (result.resources.length > 0) props.onAddAttachments(result.resources);
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

  function handleTaskCreateDragEnter(event: ReactDragEvent<HTMLFormElement>): void {
    const dataTransfer = event.dataTransfer;
    if (interactionBusy || !taskCreateDataTransferHasFiles(dataTransfer)) return;
    event.preventDefault();
    setResourceDragDepth((current) => current + 1);
  }

  function handleTaskCreateDragOver(event: ReactDragEvent<HTMLFormElement>): void {
    const dataTransfer = event.dataTransfer;
    if (interactionBusy || !taskCreateDataTransferHasFiles(dataTransfer)) return;
    event.preventDefault();
    dataTransfer.dropEffect = 'copy';
  }

  function handleTaskCreateDragLeave(event: ReactDragEvent<HTMLFormElement>): void {
    const dataTransfer = event.dataTransfer;
    if (!taskCreateDataTransferHasFiles(dataTransfer)) return;
    event.preventDefault();
    setResourceDragDepth((current) => Math.max(0, current - 1));
  }

  function handleTaskCreateDrop(event: ReactDragEvent<HTMLFormElement>): void {
    const dataTransfer = event.dataTransfer;
    if (interactionBusy || !taskCreateDataTransferHasFiles(dataTransfer)) return;
    event.preventDefault();
    setResourceDragDepth(0);
    const files = taskCreateDataTransferFiles(dataTransfer);
    if (files.length === 0) return;
    void runTaskResourceOperation(async () => {
      const result = await props.onAuthorizeFiles(files, 'drop');
      if (result.resources.length > 0) props.onAddAttachments(result.resources);
    });
  }

  function restoreTaskCreateText(attachment: TaskCreateAttachment): void {
    if (!attachment.restorableText || interactionBusy) return;
    const restoreTarget = attachment.restoreTarget ?? {
      field: 'description' as const,
      start: props.form.description.length,
      end: props.form.description.length,
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
        data-resource-dragging={resourceDragDepth > 0 ? 'true' : undefined}
        onPaste={handleTaskCreateClipboardPaste}
        onDragEnter={handleTaskCreateDragEnter}
        onDragOver={handleTaskCreateDragOver}
        onDragLeave={handleTaskCreateDragLeave}
        onDrop={handleTaskCreateDrop}
        onSubmit={(event) => {
          if (resourcesBusy) {
            event.preventDefault();
            return;
          }
          props.onSubmit(event);
        }}
        onKeyDown={handleTaskCreateModalKeyDown}
      >
        <header className="task-create-modal-header">
          <strong id="task-create-modal-title" className="task-create-modal-heading">
            {props.copy.taskCreateDialogTitle}
          </strong>
          <button type="button" className="task-create-modal-close" aria-label={props.copy.taskCreateClose} onClick={props.onClose} disabled={interactionBusy}>
            ×
          </button>
        </header>
        <div className="task-create-modal-body">
          {/* 创建任务只收集 Zeus 本地任务 draft，避免复制 giraffe 的负责人、迭代、附件和富文本团队字段。 */}
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
              disabled={interactionBusy}
            />
          </div>
          <div className="task-create-field task-create-description-field">
            <span id="task-create-description-label">{props.copy.taskCreateDescriptionLabel}</span>
            <textarea
              id="task-create-description-input"
              className="task-create-description-input"
              value={props.form.description}
              placeholder={props.copy.taskCreateDescriptionPlaceholder}
              aria-labelledby="task-create-description-label"
              onChange={(event) => props.onFormChange('description', event.currentTarget.value)}
              disabled={interactionBusy}
            />
          </div>
          <div className="task-create-two-column-row">
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
            <div className="task-create-field task-create-tags-field">
              <span id="task-create-tags-label">{props.copy.taskCreateTagsLabel}</span>
              <input
                id="task-create-tags-input"
                className="task-create-tags-input"
                value={props.form.tags}
                placeholder={props.copy.taskCreateTagsPlaceholder}
                aria-labelledby="task-create-tags-label"
                onChange={(event) => props.onFormChange('tags', event.currentTarget.value)}
                disabled={interactionBusy}
              />
            </div>
          </div>
          <section className="task-create-attachments" aria-label={props.copy.taskCreateAttachmentsLabel}>
            <div className="task-create-attachments-heading">
              <span>
                <strong>{props.copy.taskCreateAttachmentsLabel}</strong>
                <small>{props.copy.taskCreateAttachmentsHint}</small>
              </span>
              <button type="button" className="task-create-attachment-picker" onClick={props.onChooseAttachments} disabled={interactionBusy}>
                {props.copy.taskCreateChooseAttachments}
              </button>
            </div>
            {props.form.attachments.length > 0 ? (
              <TaskAttachmentPreviewList
                attachments={props.form.attachments}
                mode="editable"
                disabled={interactionBusy}
                onRemove={props.onRemoveAttachment}
                onRestoreText={restoreTaskCreateText}
                onLoadPreview={props.onLoadAttachmentPreview}
                onOpenAttachment={props.onOpenAttachment}
                copy={{
                  imageLabel: props.copy.taskCreateImageAttachment,
                  fileLabel: props.copy.taskCreateFileAttachment,
                  openFileLabel: props.copy.taskCreateOpenAttachment,
                  removeLabel: props.copy.taskCreateRemoveAttachment,
                  openPreviewLabel: props.copy.taskCreatePreviewAttachment,
                  closePreviewLabel: props.copy.taskCreatePreviewClose,
                  previewUnavailable: props.copy.taskCreatePreviewUnavailable,
                  localPathLabel: props.copy.taskCreateLocalPathLabel,
                  addedStatus: props.copy.taskCreateAttachmentAddedStatus,
                }}
              />
            ) : null}
          </section>
          {props.error ? (
            <p className="task-create-error" id="task-create-error" role="alert">
              {props.error}
            </p>
          ) : null}
        </div>
        <footer className="task-create-modal-footer">
          <Button variant="secondary" size="regular" className="task-create-cancel-button" onClick={props.onClose} disabled={interactionBusy}>
            {props.copy.taskCreateCancel}
          </Button>
          <Button type="submit" variant="primary" size="regular" className="task-create-submit-button" busy={props.busy} disabled={resourcesBusy}>
            {props.busy ? props.copy.taskCreateSubmitting : props.copy.taskCreateSubmit}
          </Button>
        </footer>
      </form>
    </ModalPortal>
  );

  // ModalPortal 统一提升到 body；根节点必须透明，只允许语义 backdrop 绘制遮罩与虚化。
  return modalSurface;
}

function TaskTableLayoutDecisionDialog(props: { open: boolean; title: string; description: string; busy?: boolean; actions: Array<{ id: string; label: string; variant?: ButtonVariant; onClick: () => void }>; onCancel: () => void }) {
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!props.open) return;
    const focusTimer = window.setTimeout(() => firstActionRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [props.open]);
  if (!props.open) return null;
  const surface = (
    <ModalPortal rootClassName="task-table-layout-dialog-portal" backdropClassName="task-create-modal-backdrop" dismissDisabled={props.busy} onDismiss={props.onCancel}>
      <section
        className="task-table-layout-dialog zeus-solid-form-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-table-layout-dialog-title"
        aria-describedby="task-table-layout-dialog-description"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !props.busy) {
            event.preventDefault();
            props.onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          if (controls.length === 0) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
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

function TaskEnumOrderEditor<T extends string>(props: { title: string; description: string; language: AppLanguage; items: Array<{ value: T; label: string }>; onChange: (values: T[]) => void }) {
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

function safelyReadClipboardData(clipboardData: DataTransfer, type: string): string {
  try {
    return clipboardData.getData(type);
  } catch {
    return '';
  }
}

function resolveTaskCreatePasteField(target: EventTarget): { field: TaskCreateTextField; control: HTMLInputElement | HTMLTextAreaElement } | undefined {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return undefined;
  if (target.id === 'task-create-title-input') return { field: 'title', control: target };
  if (target.id === 'task-create-description-input') return { field: 'description', control: target };
  if (target.id === 'task-create-tags-input') return { field: 'tags', control: target };
  return undefined;
}

function captureTaskAttachmentRestoreTarget(field: TaskCreateTextField, control: HTMLInputElement | HTMLTextAreaElement): TaskAttachmentRestoreTarget {
  const start = control.selectionStart ?? control.value.length;
  return {
    field,
    start,
    end: control.selectionEnd ?? start,
  };
}

function withTaskAttachmentRestoreTarget(attachments: TaskCreateAttachment[], restoreTarget: TaskAttachmentRestoreTarget): TaskCreateAttachment[] {
  return attachments.map((attachment) => (attachment.restorableText ? { ...attachment, restoreTarget } : attachment));
}

function taskCreateDataTransferFiles(dataTransfer: DataTransfer): File[] {
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

function taskCreateDataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files') || dataTransfer.files.length > 0;
}

function taskCreateControlId(field: TaskCreateTextField): string {
  if (field === 'title') return 'task-create-title-input';
  if (field === 'tags') return 'task-create-tags-input';
  return 'task-create-description-input';
}

/** Codex macOS 风格纯色设置 pane：用标题、留白和控件边界分组，不再用灰度条带或横线切割内容。 */
function NativeSettingsPane(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <section className={`native-settings-pane ${props.className ?? ''}`} aria-label={props.label}>
      {props.children}
    </section>
  );
}

/** Codex macOS 风格行：左侧保持标题与解释，右侧只放当前行的控件或状态。 */
function NativeControlRow(props: { title: string; description?: string; children: ReactNode; className?: string }) {
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

function formatProjectScanStatus(status: ProjectRecord['scanStatus'], copy: ReturnType<typeof getLanguageCopy>['codeWorkspace']): string {
  return copy.scanStatuses[status as keyof typeof copy.scanStatuses] ?? status;
}

function ProjectArchiveWorkbench(props: {
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
                <small>{formatProjectScanStatus(project.scanStatus, props.codeCopy)}</small>
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
  action: string;
  message: string;
  occurredAt: string;
};

/** Zeus 主界面：展示真实 API snapshot；无真实记录时才展示空状态。 */
export function App(props: {
  snapshot?: DashboardSnapshot;
  onScanCurrentGraph?: () => Promise<DashboardSnapshot>;
  onLoadGraphView?: (viewType?: GraphViewType) => Promise<GraphViewSnapshot>;
  onLoadGraphNeighborhood?: (nodeId: string, depth?: 1 | 2) => Promise<GraphNeighborhood>;
  onSearchGraph?: (query: string, nodeType?: string, edgeType?: string, minConfidence?: number) => Promise<GraphSearchResult>;
  onScanProjectGraph?: (projectId: string) => Promise<DashboardSnapshot>;
  onLoadProjectGraphView?: (projectId: string, viewType?: GraphViewType) => Promise<GraphViewSnapshot>;
  onLoadProjectGraphNeighborhood?: (projectId: string, nodeId: string, depth?: 1 | 2) => Promise<GraphNeighborhood>;
  onSearchProjectGraph?: (projectId: string, query: string, nodeType?: string, edgeType?: string, minConfidence?: number) => Promise<GraphSearchResult>;
  onAskGraph?: (projectId: string, question: string) => Promise<GraphQuestionAnswer>;
  onLoadGraphConversations?: (
    projectId: string,
    input?: {
      query?: string;
      limit?: number;
      offset?: number;
      archived?: boolean;
    },
  ) => Promise<GraphConversationHistoryPage>;
  onLoadGraphConversation?: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  onSendConversationMessage?: (projectId: string, conversationId: string, content: string) => Promise<SendConversationMessageResult>;
  nativeConversationClient?: NativeConversationAppClient;
  commandClient?: DashboardClient;
  initialNativeConversationChoices?: NativeConversationChoicesSnapshot[];
  initialNativeProjectConversationChoices?: NativeProjectConversationChoicesSnapshot[];
  initialSelectedNativeConversationId?: string;
  onSubscribeRealtimeEvents?: (onEvent: (event: ZeusRealtimeEvent) => void) => (() => void) | void;
  onArchiveGraphConversation?: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  onRestoreGraphConversation?: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  onCreateTaskFromGraphConversation?: (projectId: string, conversationId: string) => Promise<DashboardSnapshot>;
  onChooseProjectDirectory?: () => Promise<string | null>;
  onCreateCurrentProject?: (request: CreateProjectRequest) => Promise<DashboardSnapshot>;
  onLoadProjects?: (query?: string) => Promise<ProjectRecord[]>;
  onLoadProject?: (projectId: string) => Promise<ProjectRecord>;
  onLoadProjectConfig?: (projectId: string) => Promise<ProjectConfig>;
  onSaveProjectConfig?: (projectId: string, input: SaveProjectConfigRequest) => Promise<ProjectConfig>;
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
  onChooseTaskAttachments?: () => Promise<TaskCreateAttachment[]>;
  onChooseConversationResources?: () => Promise<NativeConversationAttachment[]>;
  onAuthorizeTaskFiles?: (files: File[], source: 'paste' | 'drop') => Promise<TaskResourceAuthorizationResult>;
  onMaterializeTaskResources?: (resources: TaskResourcePayload[]) => Promise<TaskCreateAttachment[]>;
  onReadTaskClipboardResources?: () => Promise<{ resources: TaskCreateAttachment[]; text: string }>;
  onLoadTaskAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenTaskAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
  onCreateTaskDraft?: (projectId: string, draft: TaskCreateDraft) => Promise<DashboardSnapshot>;
  onLoadTasks?: (projectId: string, query?: string, managementStatus?: TaskManagementStatus, tag?: string, sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'managementStatus') => Promise<TaskRecord[]>;
  onLoadTask?: (taskId: string) => Promise<TaskRecord>;
  onUpdateTask?: (taskId: string, input: UpdateTaskRequest) => Promise<DashboardSnapshot>;
  onUpdateTaskTags?: (taskId: string, tags: string[], expectedUpdatedAt: string) => Promise<DashboardSnapshot>;
  onDeleteTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onRunTask?: (taskId: string) => Promise<TaskRuntimeControlHandlerResult>;
  onPauseTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onContinueTask?: (taskId: string) => Promise<TaskRuntimeControlHandlerResult>;
  onCancelTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onRetryTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onCreateTaskFromGraphNode?: (nodeId: string, projectId: string) => Promise<DashboardSnapshot>;
  onOpenGraphSource?: (source: { projectRoot?: string; sourceRef: string; lineStart?: number }) => Promise<{
    opened: boolean;
    filePath: string | null;
    lineStart?: number | null;
  }>;
  onCreateTaskFromTemplate?: (templateId: string, projectId: string) => Promise<DashboardSnapshot>;
  onLoadGitDiff?: () => Promise<GitDiffSummary>;
  onExportGitPatch?: () => Promise<GitPatchExport>;
  onExportPatchFile?: (patch: GitPatchExport) => Promise<{ saved: boolean; filePath: string | null }>;
  onExportMermaidDiagramFile?: (payload: MermaidDiagramExportFile) => Promise<{ saved: boolean; filePath: string | null }>;
  onExportPlantUmlDiagramFile?: (payload: PlantUmlDiagramExportFile) => Promise<{ saved: boolean; filePath: string | null }>;
  initialRuntimeStatus?: RuntimeStatusSnapshot;
  onLoadRuntimeStatus?: () => Promise<RuntimeStatusSnapshot>;
  onLoadRuntimeSettings?: () => Promise<RuntimeSettings>;
  onSaveRuntimeSettings?: (input: RuntimeSettings) => Promise<RuntimeSettings>;
  onLoadCodeMapSettings?: () => Promise<CodeMapSettings>;
  onSaveCodeMapSettings?: (input: CodeMapSettings) => Promise<CodeMapSettings>;
  onLoadAppShellSettings?: () => Promise<AppShellSettings>;
  onLoadCodexLegacyImports?: () => Promise<CodexLegacyImportSnapshot>;
  onStartCodexLegacyImport?: (sourceConversationIds: string[]) => Promise<CodexLegacyImportResult>;
  onSaveAppShellSettings?: (
    input: Pick<
      AppShellSettings,
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
      | 'taskStatusFilterByProject'
    >,
  ) => Promise<AppShellSettings>;
  onClearLocalCaches?: () => Promise<{
    cleared: boolean;
    clearedCaches: Array<'code-index' | 'graph-view' | 'layout'>;
    clearedAt: string;
  }>;
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
  onCreateTaskFromRuntimeSession?: (sessionId: string, input: { title?: string; instruction?: string }) => Promise<DashboardSnapshot>;
  onLoadSecuritySecrets?: () => Promise<SecuritySecretsSnapshot>;
  onLoadSecurityAuditLogs?: () => Promise<SecurityAuditLogEntry[]>;
  onLoadReleaseStatus?: () => Promise<ReleaseStatusSnapshot>;
  onCheckReleaseUpdate?: () => Promise<ReleaseUpdateStatusSnapshot>;
  onDownloadReleaseUpdate?: () => Promise<ReleaseUpdateOperationSnapshot>;
  onInstallReleaseUpdate?: () => Promise<ReleaseUpdateOperationSnapshot>;
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
  onUpdateTaskManagementStatus?: (taskId: string, status: TaskManagementStatus, expectedUpdatedAt: string) => Promise<DashboardSnapshot>;
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
  initialGraphView?: GraphViewSnapshot;
  initialGraphProjectId?: string;
  initialGraphAnswer?: GraphQuestionAnswer;
  initialGraphConversations?: GraphConversationHistoryItem[];
  initialRuntimeSessions?: AiRuntimeSession[];
  initialRuntimeLogs?: AiRuntimeLogEntry[];
  initialRuntimeAdapters?: AiRuntimeAdapterDescriptor[];
  initialRuntimeAdapterChecks?: Record<string, AiRuntimeAdapterStatus>;
  initialRuntimeSettings?: RuntimeSettings;
  initialRuntimeGenericShellCommand?: string;
  initialSecuritySecrets?: SecuritySecretsSnapshot;
  initialRuntimeConfirmation?: RuntimeOperationConfirmation;
  initialCodeMapSettings?: CodeMapSettings;
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
}) {
  const [activeNavTarget, setActiveNavTarget] = useState<MainNavTarget>(() => inferInitialMainNavTarget(props));
  const [activeProjectSection, setActiveProjectSection] = useState<ProjectWorkspaceSection>(() => inferInitialProjectSection(props));
  const workspaceScrollRef = useRef<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(() => props.snapshot ?? createEmptyDashboardSnapshot());
  const [gitDiff, setGitDiff] = useState<GitDiffSummary | undefined>(() => props.initialGitDiff);
  const [gitHunkDecisions, setGitHunkDecisions] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const initialGitDiffCopy = getLanguageCopy(props.initialAppShellSettings?.appLanguage ?? 'zh-CN').gitDiffWorkspace;
  const [patchExportStatus, setPatchExportStatus] = useState<string>(() => initialGitDiffCopy.patchNotExported);
  const [graphView, setGraphView] = useState<GraphViewSnapshot | undefined>(() => props.initialGraphView);
  const [graphProjectId, setGraphProjectId] = useState<string | undefined>(() => resolveInitialGraphProjectId(props.initialGraphView, props.initialGraphProjectId, snapshot.projects));
  const [graphAnswer, setGraphAnswer] = useState<GraphQuestionAnswer | undefined>(() => props.initialGraphAnswer);
  const [graphConversations, setGraphConversations] = useState<GraphConversationHistoryItem[]>(() => props.initialGraphConversations ?? []);
  const [graphConversationPage, setGraphConversationPage] = useState<Pick<GraphConversationHistoryPage, 'total' | 'limit' | 'offset' | 'query' | 'archived'>>(() => ({
    total: props.initialGraphConversations?.length ?? 0,
    limit: 5,
    offset: 0,
    query: null,
    archived: false,
  }));
  const [selectedGraphConversation, setSelectedGraphConversation] = useState<GraphConversationHistoryItem | undefined>(() => props.initialGraphConversations?.[0]);
  const [nativeLegacyConversationDetails, setNativeLegacyConversationDetails] = useState<Record<string, GraphConversationHistoryItem>>({});
  const [nativeLegacyMessageLoadState, setNativeLegacyMessageLoadState] = useState<'empty' | 'loading' | 'error'>('empty');
  const [nativeLegacyMessageError, setNativeLegacyMessageError] = useState<string | null>(null);
  const [nativeConversationChoicesByTask, setNativeConversationChoicesByTask] = useState<Record<string, NativeConversationChoicesSnapshot>>(() =>
    Object.fromEntries((props.initialNativeConversationChoices ?? []).map((snapshot) => [snapshot.taskId, snapshot])),
  );
  const [nativeConversationChoicesByProject, setNativeConversationChoicesByProject] = useState<Record<string, NativeProjectConversationChoicesSnapshot>>(() =>
    Object.fromEntries((props.initialNativeProjectConversationChoices ?? []).map((snapshot) => [snapshot.projectId, snapshot])),
  );
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
  const [newConversationFocusRequest, setNewConversationFocusRequest] = useState(0);
  const [nativeConversationRuntimeStates, setNativeConversationRuntimeStates] = useState<Record<string, ConversationTreeRuntimeState>>({});
  const [nativeConversationTaskRunStatuses, setNativeConversationTaskRunStatuses] = useState<Record<string, TaskAgentRunStatus>>({});
  const [sessionSourceRailOpen, setSessionSourceRailOpen] = useState(false);
  const [compactSessionViewport, setCompactSessionViewport] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 759px)').matches === true);
  const [projectSidebarViewportWidth, setProjectSidebarViewportWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  const [projectSidebarPreferredWidth, setProjectSidebarPreferredWidth] = useState(() => readProjectSidebarPreferredWidth(browserProjectSidebarWidthStorage()));
  const [projectSidebarResizing, setProjectSidebarResizing] = useState(false);
  const projectSidebarCommittedWidthRef = useRef(projectSidebarPreferredWidth);
  const sessionSourceRailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sessionSourceRailRef = useRef<HTMLElement | null>(null);
  const projectSidebarDragCleanupRef = useRef<(() => void) | null>(null);
  const nativeConversationChoiceLoadCoordinator = useRef(createNativeConversationChoiceLoadCoordinator()).current;
  const nativeProjectConversationChoiceLoadCoordinator = useRef(createNativeProjectConversationChoiceLoadCoordinator()).current;
  const nativeConversationStartEnvelopeManager = useMemo(() => createNativeConversationStartEnvelopeManager({ storage: browserNativeConversationStartStorage(), createId: createSessionOperationId }), []);
  const projectConversationStartEnvelopeManager = useMemo(() => createProjectConversationStartEnvelopeManager({ storage: browserNativeConversationStartStorage(), createId: createSessionOperationId }), []);
  useEffect(() => {
    if (activeProjectSection !== 'sessions' || activeNavTarget === 'settings') setSessionSourceRailOpen(false);
  }, [activeNavTarget, activeProjectSection]);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(max-width: 759px)');
    const update = () => setCompactSessionViewport(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const updateProjectSidebarViewportWidth = () => setProjectSidebarViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateProjectSidebarViewportWidth);
    return () => window.removeEventListener('resize', updateProjectSidebarViewportWidth);
  }, []);
  useEffect(() => () => projectSidebarDragCleanupRef.current?.(), []);
  useEffect(() => {
    if (!compactSessionViewport || !sessionSourceRailOpen) return;
    const drawer = sessionSourceRailRef.current;
    if (!drawer) return;
    // click 默认焦点会在 handler 后落回触发器；下一帧再把焦点送进会话中栏抽屉。
    return scheduleSessionDrawerInitialFocus(resolveSessionDrawerInitialFocusTarget(drawer));
  }, [compactSessionViewport, sessionSourceRailOpen]);
  const [graphConversationSearch, setGraphConversationSearch] = useState('');
  const [graphNodeTaskFeedback, setGraphNodeTaskFeedback] = useState<GraphNodeTaskFeedback>('idle');
  const [graphSourceOpenFeedback, setGraphSourceOpenFeedback] = useState<GraphSourceOpenFeedback>('idle');
  const [lastGraphNodeTaskId, setLastGraphNodeTaskId] = useState<string | undefined>();
  useEffect(() => {
    if (graphNodeTaskFeedback !== 'created') return;
    const clearGraphNodeTaskSuccessFeedback = window.setTimeout(() => {
      // 图谱节点任务创建成功只做短暂确认，失败状态继续保留以支持原地重试。
      setGraphNodeTaskFeedback('idle');
    }, GRAPH_NODE_TASK_SUCCESS_DISMISS_MS);
    return () => window.clearTimeout(clearGraphNodeTaskSuccessFeedback);
  }, [graphNodeTaskFeedback]);
  useEffect(() => {
    if (graphSourceOpenFeedback === 'idle' || graphSourceOpenFeedback === 'opening') return;
    const clearGraphSourceOpenFeedback = window.setTimeout(() => {
      // 源码打开结果只做短暂确认，避免状态条长期压在代码图谱主舞台上。
      setGraphSourceOpenFeedback('idle');
    }, GRAPH_SOURCE_OPEN_FEEDBACK_DISMISS_MS);
    return () => window.clearTimeout(clearGraphSourceOpenFeedback);
  }, [graphSourceOpenFeedback]);
  const [taskEvents, setTaskEvents] = useState<TaskEventRecord[]>(() => props.initialTaskEvents ?? []);
  const [taskTemplates, setTaskTemplates] = useState<TaskTemplateRecord[]>(() => props.initialTaskTemplates ?? []);
  const [archivedProjects, setArchivedProjects] = useState<ProjectRecord[]>(() => props.initialArchivedProjects ?? []);
  const [conversationDraftOpen, setConversationDraftOpen] = useState(false);
  const [projectDetail, setProjectDetail] = useState<ProjectRecord | undefined>(() => props.snapshot?.projects[0]);
  const [taskDetail, setTaskDetail] = useState<TaskRecord | undefined>(() => props.snapshot?.tasks[0]);
  const [taskDetailPaneTaskId, setTaskDetailPaneTaskId] = useState<string | undefined>();
  const [projectCreateDialogOpen, setProjectCreateDialogOpen] = useState(false);
  const [projectCreateForm, setProjectCreateForm] = useState<ProjectCreateFormState>({ name: '', localPath: '' });
  const [projectCreateError, setProjectCreateError] = useState<string | undefined>();
  const [projectDirectoryChoosing, setProjectDirectoryChoosing] = useState(false);
  const projectCreateReturnFocusRef = useRef<HTMLElement | null>(null);
  const [createProjectConfigForm] = useState(() => ({
    defaultModel: '',
    defaultWorkMode: 'plan' as ProjectConfig['defaultWorkMode'],
    defaultTaskPrompt: '',
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
  const [projectWorkspaceConfig, setProjectWorkspaceConfig] = useState<ProjectWorkspaceConfigSnapshot | undefined>();
  const [projectRepositoryDiscovery, setProjectRepositoryDiscovery] = useState<ProjectRepositoryDiscoverySnapshot | undefined>();
  const [selectedProjectRepositoryPaths, setSelectedProjectRepositoryPaths] = useState<string[]>([]);
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

  const [graphSearchResult, setGraphSearchResult] = useState<GraphSearchResult | undefined>();
  const [gitConfirmation, setGitConfirmation] = useState<GitOperationConfirmation | undefined>(() => props.initialGitConfirmation);
  const [gitOperationStatus, setGitOperationStatus] = useState<string>(() => initialGitDiffCopy.operationNotExecuted);
  const [gitCommitMessage, setGitCommitMessage] = useState('');
  const [gitBranchName, setGitBranchName] = useState('');
  const [gitSwitchBranchName, setGitSwitchBranchName] = useState('');
  const [gitBaseRef, setGitBaseRef] = useState('');
  const [gitStashRef, setGitStashRef] = useState('stash@{0}');
  const [gitRemote, setGitRemote] = useState('origin');
  const [gitTargetRef, setGitTargetRef] = useState('main');
  const [gitRollbackRef, setGitRollbackRef] = useState('HEAD');
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusSnapshot | undefined>(props.initialRuntimeStatus);
  const [runtimeAdapters, setRuntimeAdapters] = useState<AiRuntimeAdapterDescriptor[]>(() => props.initialRuntimeAdapters ?? []);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>(() => normalizeRuntimeSettings(props.initialRuntimeSettings));
  const [codexLegacyImportSnapshot, setCodexLegacyImportSnapshot] = useState<CodexLegacyImportSnapshot | null>(null);
  const [codexLegacyImportLoading, setCodexLegacyImportLoading] = useState(false);
  const [codexLegacyImportBusy, setCodexLegacyImportBusy] = useState(false);
  const [codexLegacyImportError, setCodexLegacyImportError] = useState<string | null>(null);
  const [codeMapSettings, setCodeMapSettings] = useState<CodeMapSettings>(() => normalizeCodeMapSettings(props.initialCodeMapSettings));
  const [appShellSettings, setAppShellSettings] = useState<AppShellSettings>(() =>
    normalizeRendererAppShellSettings(
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
        taskStatusFilterByProject: {},
        localLogDirectory: 'Zeus/logs',
        localConfigPath: 'Zeus/zeus.config.json',
        dataPortability: {
          importSupported: true,
          exportSupported: true,
          redactsSecrets: true,
        },
        cache: { codeIndex: true, graphView: true, layout: true },
        lastCacheClearAt: null,
      },
    ),
  );
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.zeusTheme = appShellSettings.appearance;
    return () => {
      if (root.dataset.zeusTheme === appShellSettings.appearance) {
        delete root.dataset.zeusTheme;
      }
    };
  }, [appShellSettings.appearance]);
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
  const [taskCreateForm, setTaskCreateForm] = useState<TaskCreateFormState>(() => buildTaskCreateInitialForm(appShellSettings.appLanguage));
  const [taskCreateError, setTaskCreateError] = useState('');
  const [taskModelPushTaskId, setTaskModelPushTaskId] = useState<string | null>(null);
  const [taskModelPushCapabilities, setTaskModelPushCapabilities] = useState<CodexTaskPushCapabilities | null>(null);
  const [taskModelPushForm, setTaskModelPushForm] = useState<TaskModelPushForm>({
    model: '',
    effort: '',
    serviceTier: { type: 'follow' },
    serviceTierDowngraded: false,
    workMode: 'default',
    permissionMode: 'read-only',
    workspaceMode: 'create',
    environmentId: '',
    repositorySelections: {},
    supplementalInfo: '',
  });
  const [taskModelPushStatus, setTaskModelPushStatus] = useState<TaskModelPushModalStatus>('loading');
  const [taskModelPushError, setTaskModelPushError] = useState<string | null>(null);
  const [taskModelPushPending, setTaskModelPushPending] = useState<TaskModelPushPendingState | null>(null);
  const [taskGitReviewState, setTaskGitReviewState] = useState<{
    taskId: string;
    workspaceId?: string | null;
    mode: 'commit' | 'commit-only' | 'push-only' | 'delivery' | 'completed' | 'cancelled';
  } | null>(null);
  const [taskGitMergeTaskId, setTaskGitMergeTaskId] = useState<string | null>(null);
  const taskModelPushCapabilityRequestRef = useRef(0);
  const taskModelPushEnvelopeRef = useRef<{ fingerprint: string; request: StartTaskModelPushRequest } | null>(null);
  const pendingProjectServiceTierPreferencesRef = useRef(new Map<string, { projectId: string; clientUserMessageId: string; selection: NativeServiceTierSelection }>());
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
        executionHostProtocolVersion: 1,
        automaticInstallEnabled: false,
        recommendedAction: 'open_download_page',
        label: '暂未检查更新',
        reason: '点击检查更新后读取 GitHub Release 发布清单；未签名或未公证的产物只允许手动安装。',
        checkedAt: '',
      },
  );
  const [releaseUpdateCheckState, setReleaseUpdateCheckState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [releaseUpdateDialogState, setReleaseUpdateDialogState] = useState<ReleaseUpdateDialogState | null>(null);
  const releaseUpdateRequestIdRef = useRef(0);
  const releaseUpdateMenuBusyRef = useRef(false);
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
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'failed'>('idle');
  const [actionState, setActionState] = useState<
    'idle' | 'creating-project' | 'creating-task' | 'loading-diff' | 'loading-runtime' | 'loading-templates' | 'updating-task' | 'creating-git-confirmation' | 'confirming-git-operation' | 'executing-git-operation' | 'failed'
  >('idle');
  const creatingProjectBusy = actionState === 'creating-project';
  const creatingTaskBusy = actionState === 'creating-task';
  const updatingTaskBusy = actionState === 'updating-task';
  const loadingDiffBusy = actionState === 'loading-diff';
  const loadingRuntimeBusy = actionState === 'loading-runtime';
  const loadingTemplatesBusy = actionState === 'loading-templates';
  const creatingGitConfirmationBusy = actionState === 'creating-git-confirmation';
  const confirmingGitOperationBusy = actionState === 'confirming-git-operation';
  const executingGitOperationBusy = actionState === 'executing-git-operation';
  const scanActionBusy = scanState === 'scanning';
  const releaseUpdateBusy = releaseUpdateCheckState === 'loading';
  const [localError, setLocalError] = useState<LocalUiErrorSnapshot | undefined>(() => normalizeLocalUiError(props.initialLocalError));
  const projectCreationReady = Boolean(props.onChooseProjectDirectory && props.onCreateCurrentProject);
  const gitLabel = snapshot.git.isRepository ? `Git ${snapshot.git.branch}` : codeWorkspaceCopy.gitNotDetected;
  useEffect(() => {
    if (!taskCreateModalOpen) return;
    const focusTitleInput = window.setTimeout(() => taskCreateTitleInputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTitleInput);
  }, [taskCreateModalOpen]);
  useEffect(() => {
    const syncActiveTarget = () => setActiveNavTarget(readCurrentMainNavTarget());
    syncActiveTarget();
    window.addEventListener('hashchange', syncActiveTarget);
    return () => window.removeEventListener('hashchange', syncActiveTarget);
  }, []);

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
    if (props.initialProjectConfig || props.initialProjectDatabaseSecret) return 'config';
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
    if (props.initialMainNavTarget === 'code-map' || props.initialGraphView || props.initialGraphAnswer || props.initialGraphConversations?.length) return 'context';
    if (props.initialMainNavTarget === 'git-diff' || props.initialGitDiff || props.initialGitConfirmation) return 'changes';
    if (props.initialTaskTemplates?.length) return 'templates';
    return undefined;
  });
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(() => {
    if (props.initialMainNavTarget === 'settings-data') return 'data';
    if (props.initialMainNavTarget === 'telegram' || props.initialSecuritySecrets?.telegramBotToken.configured) return 'telegram';
    if (props.initialRuntimeSettings || props.initialRuntimeStatus) return 'runtime';
    if (props.initialSecuritySecrets || props.initialSecurityAuditLogs?.length) return 'security';
    if (props.initialGitConfirmation && props.initialMainNavTarget === 'settings') return 'git';
    if (props.initialReleaseStatus) return 'release';
    return 'general';
  });
  useEffect(() => {
    if (activeNavTarget !== 'settings' || settingsCategory !== 'runtime' || codexLegacyImportSnapshot || codexLegacyImportLoading || !props.onLoadCodexLegacyImports) return;
    void refreshCodexLegacyImports();
  }, [activeNavTarget, codexLegacyImportLoading, codexLegacyImportSnapshot, props.onLoadCodexLegacyImports, settingsCategory]);
  const selectedProject = projectDetail ?? firstProject;
  const activeProjectId = selectedProject?.id ?? firstProjectId;
  const taskStatusFilter = resolveTaskStatusFilterForProject(appShellSettings, activeProjectId);
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
  const pendingTaskTableLayoutLeaveRef = useRef<(() => void) | null>(null);
  const pendingTaskTableLayoutLeaveCancelRef = useRef<(() => void) | null>(null);
  const saveTaskTableLayoutThenLeaveRef = useRef(false);
  useEffect(() => {
    if (taskTableLayoutDraft.projectId === activeProjectId) return;
    setTaskTableLayoutDraft({ projectId: activeProjectId, preferences: persistedTaskTableColumns });
  }, [activeProjectId, persistedTaskTableColumns, taskTableLayoutDraft.projectId]);
  useEffect(() => {
    window.zeus?.notifyTaskTableLayoutDirty?.(taskTableLayoutDirty);
  }, [taskTableLayoutDirty]);
  useEffect(() => {
    const bridge = window.zeus;
    if (!bridge?.onTaskTableLayoutCloseRequested || !bridge.resolveTaskTableLayoutCloseRequest) return;
    return bridge.onTaskTableLayoutCloseRequested(() => {
      if (!taskTableLayoutDirty) {
        bridge.resolveTaskTableLayoutCloseRequest(true);
        return;
      }
      requestTaskTableLayoutLeave(
        () => bridge.resolveTaskTableLayoutCloseRequest(true),
        () => bridge.resolveTaskTableLayoutCloseRequest(false),
      );
    });
  }, [taskTableLayoutDirty]);
  const activeProjectIdRef = useRef<string | undefined>(activeProjectId);
  const graphViewRequestVersionRef = useRef(0);
  const graphSearchRequestVersionRef = useRef(0);
  const graphQuestionRequestVersionRef = useRef(0);
  const graphScanRequestVersionRef = useRef(0);
  const graphConversationListRequestVersionRef = useRef(0);
  const graphConversationDetailRequestVersionRef = useRef(0);
  const activeGraphViewTypeRef = useRef<GraphViewType | undefined>(undefined);
  const selectedTaskConversationRef = useRef<GraphConversationHistoryItem | undefined>(undefined);
  const pendingRealtimeConversationRefreshIdsRef = useRef<Set<string>>(new Set());
  const pendingRealtimeTaskRefreshIdsRef = useRef<Set<string>>(new Set());
  const pendingRealtimeNativeConversationRefreshIdsRef = useRef<Set<string>>(new Set());
  const repeatRealtimeNativeConversationRefreshIdsRef = useRef<Set<string>>(new Set());
  const taskMutationQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const taskLocalVersionTransitionsRef = useRef<Map<string, Map<string, string>>>(new Map());
  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);
  // 图谱视图必须同时匹配当前项目 id 与响应元数据，避免切换项目后把 Zeus 或其他项目图谱挂到当前代码页。
  const activeGraphView = graphView && graphProjectId === activeProjectId && isProjectGraphViewForProject(graphView, selectedProject, { requireProjectIdentity: orderedProjects.length > 1 }) ? graphView : undefined;
  useEffect(() => {
    activeGraphViewTypeRef.current = activeGraphView?.viewType as GraphViewType | undefined;
  }, [activeGraphView?.viewType]);
  const activeProjectGraphSummary = activeGraphView
    ? {
        // 项目代码页只能展示已经通过当前项目身份校验的图谱数据；Dashboard 的全局 Zeus 计数不能作为项目图谱兜底。
        nodeCount: activeGraphView.nodes.length,
        edgeCount: activeGraphView.edges.length,
      }
    : { nodeCount: 0, edgeCount: 0 };
  const activeProjectGraphSummaryBoundary = appShellSettings.appLanguage === 'zh-CN' ? '当前已加载视图' : 'Currently loaded view';
  // 忙碌态只代表本轮 UI 发起的动作；数据库里上次崩溃残留的 scanning 不能永久锁死项目扫描入口，真实并发由服务端 409 兜底。
  const scanBusy = scanActionBusy;
  useEffect(() => {
    if (graphProjectId === activeProjectId) return;
    // 当前项目变化时必须先清空旧图谱工作区，避免 A 项目的真实图谱继续挂在 B 项目的代码页里。
    resetGraphWorkspace(activeProjectId);
  }, [activeProjectId, graphProjectId]);
  const currentProjectTasks = useMemo(() => (activeProjectId ? snapshot.tasks.filter((task) => task.projectId === activeProjectId) : snapshot.tasks), [activeProjectId, snapshot.tasks]);
  const currentTaskConversationChoices = useMemo(() => Object.fromEntries(currentProjectTasks.map((task) => [task.id, nativeConversationChoicesByTask[task.id]?.choices ?? []])), [currentProjectTasks, nativeConversationChoicesByTask]);
  const nativeConversationChoices = useMemo(
    () => [...Object.values(nativeConversationChoicesByProject), ...Object.values(nativeConversationChoicesByTask)].flatMap((entry) => entry.choices).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [nativeConversationChoicesByProject, nativeConversationChoicesByTask],
  );
  const selectedNativeConversation = useMemo(
    () => resolveSelectedNativeConversationForProject(nativeConversationChoices, selectedNativeConversationId, activeProjectId),
    [activeProjectId, nativeConversationChoices, selectedNativeConversationId],
  );
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
  }, [selectedNativeConversationId]);

  const setNativeConversationCompletionUnread = useCallback((conversationId: string, hasUnreadCompletion: boolean): void => {
    setNativeConversationChoicesByProject((current) => Object.fromEntries(Object.entries(current).map(([projectId, snapshot]) => [projectId, updateConversationChoiceCompletionUnread(snapshot, conversationId, hasUnreadCompletion)])));
    setNativeConversationChoicesByTask((current) => Object.fromEntries(Object.entries(current).map(([taskId, snapshot]) => [taskId, updateConversationChoiceCompletionUnread(snapshot, conversationId, hasUnreadCompletion)])));
  }, []);

  const acknowledgeNativeConversationCompletion = useCallback(
    (projectId: string, conversationId: string): void => {
      const client = props.nativeConversationClient;
      if (!client) return;
      setNativeConversationCompletionUnread(conversationId, false);
      void client.acknowledgeNativeConversationCompletion(projectId, conversationId).catch((error: unknown) => {
        setNativeConversationCompletionUnread(conversationId, true);
        recordLocalError('conversation-completion-acknowledgement', error);
      });
    },
    [props.nativeConversationClient, setNativeConversationCompletionUnread],
  );

  useEffect(() => {
    if (!selectedNativeConversation?.hasUnreadCompletion) return;
    acknowledgeNativeConversationCompletion(selectedNativeConversation.projectId, selectedNativeConversation.id);
  }, [acknowledgeNativeConversationCompletion, selectedNativeConversation]);
  const nativeConversationGroups = useMemo<ProjectConversationGroup[]>(
    () =>
      orderedProjects.map((project) => ({
        projectId: project.id,
        projectName: project.name,
        conversations: [...(nativeConversationChoicesByProject[project.id]?.choices ?? [])].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        tasks: snapshot.tasks
          .filter((task) => task.projectId === project.id)
          .map((task) => ({
            taskId: task.id,
            taskCode: task.taskCode?.trim() || task.id,
            taskTitle: task.title,
            conversations: [...(nativeConversationChoicesByTask[task.id]?.choices ?? [])].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          })),
      })),
    [nativeConversationChoicesByProject, nativeConversationChoicesByTask, orderedProjects, snapshot.tasks],
  );
  const recordNativeConversationRuntimeState = useCallback((conversationId: string, state: NativeSessionState): void => {
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
  }, []);

  useEffect(() => {
    const client = props.nativeConversationClient;
    if (!client || (activeProjectSection !== 'sessions' && activeProjectSection !== 'tasks') || !activeProjectId) return;
    let cancelled = false;
    const projectId = activeProjectId;
    const projectRequestVersion = nativeProjectConversationChoiceLoadCoordinator.begin(projectId);
    const taskLoads = currentProjectTasks.map((task) => ({ task, requestVersion: nativeConversationChoiceLoadCoordinator.begin(task.id) }));
    setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: beginNativeConversationChoiceTaskLoad(current[projectId]) }));
    setNativeConversationChoiceTaskStates((current) => ({
      ...current,
      ...Object.fromEntries(taskLoads.map(({ task }) => [task.id, beginNativeConversationChoiceTaskLoad(current[task.id])])),
    }));

    void client.loadProjectConversationChoices(projectId).then(
      (snapshot) => {
        if (cancelled || !nativeProjectConversationChoiceLoadCoordinator.isCurrent(projectId, projectRequestVersion)) return;
        const merged = nativeProjectConversationChoiceLoadCoordinator.commit(projectId, projectRequestVersion, snapshot);
        if (!merged) return;
        setNativeConversationChoicesByProject((current) => ({ ...current, [projectId]: merged }));
        setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: completeNativeConversationChoiceTaskLoad(current[projectId]) }));
      },
      (error) => {
        if (cancelled || !nativeProjectConversationChoiceLoadCoordinator.isCurrent(projectId, projectRequestVersion)) return;
        setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: failNativeConversationChoiceTaskLoad(current[projectId], errorToLocalUiMessage(error)) }));
      },
    );

    void Promise.allSettled(taskLoads.map(({ task }) => client.loadTaskConversationChoices(task.id))).then((results) => {
      if (cancelled) return;
      results.forEach((result, index) => {
        const load = taskLoads[index];
        if (!load || !nativeConversationChoiceLoadCoordinator.isCurrent(load.task.id, load.requestVersion)) return;
        if (result.status === 'fulfilled') {
          const merged = nativeConversationChoiceLoadCoordinator.commit(load.task.id, load.requestVersion, result.value);
          if (!merged) return;
          setNativeConversationChoicesByTask((current) => ({ ...current, [load.task.id]: merged }));
          setNativeConversationChoiceTaskStates((current) => ({ ...current, [load.task.id]: completeNativeConversationChoiceTaskLoad(current[load.task.id]) }));
          return;
        }
        const message = errorToLocalUiMessage(result.reason);
        setNativeConversationChoiceTaskStates((current) => ({ ...current, [load.task.id]: failNativeConversationChoiceTaskLoad(current[load.task.id], message) }));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activeProjectSection, currentProjectTasks, nativeConversationChoiceLoadCoordinator, nativeProjectConversationChoiceLoadCoordinator, props.nativeConversationClient]);

  const nativeSessionTaskRecord = selectedNativeConversation?.taskId
    ? snapshot.tasks.find((task) => task.id === selectedNativeConversation.taskId)
    : conversationDraftOpen && taskDetail && (!activeProjectId || taskDetail.projectId === activeProjectId)
      ? taskDetail
      : undefined;
  const nativeSessionTask: SessionWorkspaceTask | null = nativeSessionTaskRecord ? { id: nativeSessionTaskRecord.id, projectId: nativeSessionTaskRecord.projectId, title: nativeSessionTaskRecord.title } : null;
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
  const nativeSessionChoices = nativeSessionTask ? (nativeConversationChoicesByTask[nativeSessionTask.id]?.choices ?? []) : nativeSessionProject ? (nativeConversationChoicesByProject[nativeSessionProject.id]?.choices ?? []) : [];
  const nativeSessionChoiceTaskState = nativeSessionTask ? nativeConversationChoiceTaskStates[nativeSessionTask.id] : nativeSessionProject ? nativeConversationChoiceProjectStates[nativeSessionProject.id] : undefined;
  const nativeLegacyMessages = useMemo(() => {
    const entries: Array<[string, Array<{ id: string; role: string; content: string }>]> = [...graphConversations, ...(selectedGraphConversation ? [selectedGraphConversation] : [])].map((conversation) => [
      conversation.id,
      conversation.messages.map((message) => ({ id: message.id, role: message.role, content: message.content })),
    ]);
    for (const [sourceConversationId, conversation] of Object.entries(nativeLegacyConversationDetails)) {
      entries.push([sourceConversationId, conversation.messages.map((message) => ({ id: message.id, role: message.role, content: message.content }))]);
    }
    return Object.fromEntries(entries);
  }, [graphConversations, nativeLegacyConversationDetails, selectedGraphConversation]);
  const selectedTask = conversationDraftOpen ? undefined : taskDetail && (!activeProjectId || taskDetail.projectId === activeProjectId) ? taskDetail : currentProjectTasks[0];
  const selectedTaskConversation = useMemo(() => {
    if (!selectedTask) return undefined;
    const candidatesById = new Map<string, GraphConversationHistoryItem>();
    for (const conversation of graphConversations) candidatesById.set(conversation.id, conversation);
    if (selectedGraphConversation) candidatesById.set(selectedGraphConversation.id, selectedGraphConversation);
    return Array.from(candidatesById.values())
      .filter((conversation) => !conversation.archived && conversation.projectId === selectedTask.projectId && conversation.taskId === selectedTask.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }, [graphConversations, selectedGraphConversation, selectedTask?.id, selectedTask?.projectId]);
  const visibleTasks = useMemo(() => filterVisibleTasks(currentProjectTasks, taskSearchQuery, taskStatusFilter, taskTagFilter), [currentProjectTasks, taskSearchQuery, taskStatusFilter, taskTagFilter]);

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

  useEffect(() => {
    const subscribeRealtimeEvents = props.onSubscribeRealtimeEvents;
    const loadGraphConversation = props.onLoadGraphConversation;
    if (!subscribeRealtimeEvents) return;
    const refreshNativeConversationList = (projectId: string, conversationId: string): void => {
      const client = props.nativeConversationClient;
      if (!client) return;
      if (pendingRealtimeNativeConversationRefreshIdsRef.current.has(conversationId)) {
        repeatRealtimeNativeConversationRefreshIdsRef.current.add(conversationId);
        return;
      }
      pendingRealtimeNativeConversationRefreshIdsRef.current.add(conversationId);
      void client
        .loadNativeConversation(projectId, conversationId)
        .then(async (nativeSnapshot) => {
          if (nativeSnapshot.id !== conversationId || nativeSnapshot.projectId !== projectId) return;
          const knownConversation = nativeSnapshot.taskId
            ? nativeConversationChoicesByTaskRef.current[nativeSnapshot.taskId]?.choices.some((choice) => choice.id === conversationId) === true
            : nativeConversationChoicesByProjectRef.current[projectId]?.choices.some((choice) => choice.id === conversationId) === true;
          if (knownConversation) {
            setNativeConversationChoicesByProject((current) => updateConversationChoiceSnapshotCollection(current, nativeSnapshot));
            setNativeConversationChoicesByTask((current) => updateConversationChoiceSnapshotCollection(current, nativeSnapshot));
          } else if (nativeSnapshot.taskId) {
            const taskId = nativeSnapshot.taskId;
            const requestVersion = nativeConversationChoiceLoadCoordinator.begin(taskId);
            const choices = await client.loadTaskConversationChoices(taskId);
            const merged = nativeConversationChoiceLoadCoordinator.commit(taskId, requestVersion, choices);
            if (merged) {
              nativeConversationChoicesByTaskRef.current = { ...nativeConversationChoicesByTaskRef.current, [taskId]: merged };
              setNativeConversationChoicesByTask((current) => ({ ...current, [taskId]: merged }));
              setNativeConversationChoiceTaskStates((current) => ({ ...current, [taskId]: completeNativeConversationChoiceTaskLoad(current[taskId]) }));
            }
          } else {
            const requestVersion = nativeProjectConversationChoiceLoadCoordinator.begin(projectId);
            const choices = await client.loadProjectConversationChoices(projectId);
            const merged = nativeProjectConversationChoiceLoadCoordinator.commit(projectId, requestVersion, choices);
            if (merged) {
              nativeConversationChoicesByProjectRef.current = { ...nativeConversationChoicesByProjectRef.current, [projectId]: merged };
              setNativeConversationChoicesByProject((current) => ({ ...current, [projectId]: merged }));
              setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: completeNativeConversationChoiceTaskLoad(current[projectId]) }));
            }
          }
          const runtimeState = conversationTreeRuntimeStateFromSnapshot(nativeSnapshot);
          setNativeConversationRuntimeStates((current) => (current[conversationId] === runtimeState ? current : { ...current, [conversationId]: runtimeState }));
          const taskRunStatus = taskAgentRunStatusFromConversationTreeRuntimeState(runtimeState);
          setNativeConversationTaskRunStatuses((current) => (current[conversationId] === taskRunStatus ? current : { ...current, [conversationId]: taskRunStatus }));
        })
        .catch((error: unknown) => recordLocalError('conversation-list-realtime-refresh', error))
        .finally(() => {
          pendingRealtimeNativeConversationRefreshIdsRef.current.delete(conversationId);
          if (!repeatRealtimeNativeConversationRefreshIdsRef.current.delete(conversationId)) return;
          refreshNativeConversationList(projectId, conversationId);
        });
    };
    const unsubscribe = subscribeRealtimeEvents((event) => {
      if (shouldRefreshNativeConversationListForRealtimeEvent(event)) {
        refreshNativeConversationList(event.payload.projectId as string, event.payload.conversationId as string);
      }
      if (event.type === 'conversation.turn.completed' && typeof event.payload.conversationId === 'string') {
        const conversationId = event.payload.conversationId;
        const hasUnreadCompletion = event.payload.status === 'completed' && event.payload.hasUnreadCompletion !== false;
        if (hasUnreadCompletion) {
          const selected = selectedNativeConversationIdRef.current === conversationId;
          setNativeConversationCompletionUnread(conversationId, !selected);
          if (selected && typeof event.payload.projectId === 'string') {
            acknowledgeNativeConversationCompletion(event.payload.projectId, conversationId);
          }
        }
      }
      if (event.type === 'task.updated' && typeof event.payload.taskId === 'string' && props.onLoadTask) {
        const taskId = event.payload.taskId;
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
      if (!loadGraphConversation) return;
      if (!shouldRefreshConversationForRuntimeEvent(event, selectedTaskConversationRef.current)) return;
      const conversation = selectedTaskConversationRef.current;
      if (!conversation) return;
      const projectId = conversation.projectId || activeProjectIdRef.current;
      if (!projectId || pendingRealtimeConversationRefreshIdsRef.current.has(conversation.id)) return;
      pendingRealtimeConversationRefreshIdsRef.current.add(conversation.id);
      void loadGraphConversation(projectId, conversation.id)
        .then((updatedConversation) => upsertGraphConversation(updatedConversation))
        .catch((error: unknown) => recordLocalError('conversation-realtime-refresh', error))
        .finally(() => {
          pendingRealtimeConversationRefreshIdsRef.current.delete(conversation.id);
        });
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [acknowledgeNativeConversationCompletion, mergeTaskRecord, props.nativeConversationClient, props.onLoadGraphConversation, props.onLoadTask, props.onSubscribeRealtimeEvents, setNativeConversationCompletionUnread]);

  const taskDetailPaneTask = taskDetailPaneTaskId ? (taskDetail?.id === taskDetailPaneTaskId ? taskDetail : snapshot.tasks.find((task) => task.id === taskDetailPaneTaskId)) : undefined;
  const taskDetailPaneConversations = taskDetailPaneTask ? (nativeConversationChoicesByTask[taskDetailPaneTask.id]?.choices ?? []) : [];
  const taskDetailPaneConversationState = taskDetailPaneTask ? nativeConversationChoiceTaskStates[taskDetailPaneTask.id] : undefined;
  const currentRuntimeAdapterDisplayName = formatRuntimeAdapterDisplayName(runtimeSettings.defaultAdapterId, runtimeAdapters, settingsWorkspaceCopy.runtime);
  const taskTableEnumSortOrders = normalizeTaskTableEnumSortOrders(appShellSettings.taskTableEnumSortOrders);
  const taskPriorityLabels = Object.fromEntries(taskWorkspaceCopy.taskCreatePriorityOptions.map((option) => [option.value, option.label])) as Record<TaskPriority, string>;
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

  async function openTaskDetailPane(taskId: string): Promise<void> {
    // 点击任务行从右侧打开悬浮详情抽屉；透明点击层保留列表原貌，并让用户点击抽屉外空白处立即关闭。
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
      const [config, discovery] = await Promise.all([client.loadProjectWorkspaceConfig(projectId), client.discoverProjectRepositories(projectId)]);
      setProjectWorkspaceConfig(config);
      setProjectRepositoryDiscovery(discovery);
      setSelectedProjectRepositoryPaths(config.repositories.map((repository) => repository.localPath));
      setProjectSharedWritablePaths(config.sharedWritablePaths.map((entry) => entry.localPath).join('\n'));
      setProjectWorkspaceConfigStatus('idle');
    } catch (error) {
      setProjectWorkspaceConfigStatus('error');
      setProjectWorkspaceConfigError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
      recordLocalError('project-workspace-config-load', error);
    }
  }

  async function saveProjectWorkspaceConfig(projectId: string): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client) return;
    setProjectWorkspaceConfigStatus('saving');
    setProjectWorkspaceConfigError(null);
    try {
      const saved = await client.saveProjectWorkspaceConfig(projectId, {
        repositories: selectedProjectRepositoryPaths.map((localPath) => ({ localPath })),
        sharedWritablePaths: parseProjectConfigList(projectSharedWritablePaths).map((localPath) => ({ localPath })),
      });
      setProjectWorkspaceConfig(saved);
      const discovery = await client.discoverProjectRepositories(projectId);
      setProjectRepositoryDiscovery(discovery);
      setSelectedProjectRepositoryPaths(saved.repositories.map((repository) => repository.localPath));
      setProjectSharedWritablePaths(saved.sharedWritablePaths.map((entry) => entry.localPath).join('\n'));
      setProjectWorkspaceConfigStatus('idle');
    } catch (error) {
      setProjectWorkspaceConfigStatus('error');
      setProjectWorkspaceConfigError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
      recordLocalError('project-workspace-config-save', error);
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

  async function handleCodeMapAction(): Promise<void> {
    handleMainNavigate('projects');
    setActiveProjectSection('code');
    if (activeProjectId && selectedProject?.scanStatus === 'completed' && !activeGraphView) {
      const loadedGraphView = await openProjectGraphView(activeProjectId, 'architecture');
      if (!loadedGraphView) await scanActiveProjectGraph();
      return;
    }
    await scanActiveProjectGraph();
  }

  function codeMapActionLabel(): string {
    if (scanBusy) return codeWorkspaceCopy.scanning;
    if (scanState === 'failed') return codeWorkspaceCopy.retryScan;
    return codeWorkspaceCopy.openGraph;
  }

  function renderProjectCodeMapStage(): ReactNode {
    if (!activeGraphView) return null;
    return (
      <section className="project-code-map-stage" aria-label={codeWorkspaceCopy.graphDrawerAria}>
        {/* 代码逻辑图是代码页主角：真实图谱直接成为代码页首层舞台，不再藏进项目抽屉。 */}
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
      const nextSnapshot = await props.onCreateTaskFromGraphNode(nodeId, activeProjectId);
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
      setSnapshot(await props.onCreateTaskFromGraphConversation(activeProjectId, conversationId));
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
      const nextSnapshot = await props.onCreateTaskDraft(activeProjectId, draft);
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
      return true;
    } catch (error) {
      setTaskCreateError(taskWorkspaceCopy.taskCreateSubmitFailed);
      recordLocalError('renderer-action', error);
      setActionState('idle');
      return false;
    }
  }

  function openTaskCreateModal(): void {
    taskCreateReturnFocusRef.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTaskCreateForm(buildTaskCreateInitialForm(appShellSettings.appLanguage));
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

  function updateTaskCreatePriority(priority: TaskPriority): void {
    setTaskCreateForm((current) => ({ ...current, priority }));
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

  async function chooseTaskCreateAttachments(): Promise<void> {
    if (!props.onChooseTaskAttachments) return;
    try {
      const selectedAttachments = await props.onChooseTaskAttachments();
      mergeTaskCreateAttachments(selectedAttachments);
      setTaskCreateError('');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setTaskCreateError(taskWorkspaceCopy.taskCreateAttachmentPickerFailed);
    }
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

  async function materializeTaskCreateResources(resources: TaskResourcePayload[]): Promise<TaskCreateAttachment[]> {
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

  async function readTaskCreateClipboardResources(): Promise<{ resources: TaskCreateAttachment[]; text: string }> {
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
    const normalized = normalizeTaskCreateDraft(taskCreateForm, taskWorkspaceCopy.taskCreateTitleRequired);
    if ('error' in normalized) {
      setTaskCreateError(normalized.error);
      taskCreateTitleInputRef.current?.focus();
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

  async function selectNativeConversation(conversation: NativeConversationChoice): Promise<void> {
    const task = conversation.taskId ? snapshot.tasks.find((candidate) => candidate.id === conversation.taskId) : undefined;
    if (task) setTaskDetail(task);
    else setTaskDetail(undefined);
    selectedNativeConversationIdRef.current = conversation.id;
    setSelectedNativeConversationId(conversation.id);
    if (conversation.hasUnreadCompletion) acknowledgeNativeConversationCompletion(conversation.projectId, conversation.id);
    setConversationDraftOpen(false);
    setActiveNavTarget('conversations');
    setActiveProjectSection('sessions');
    if (!conversation.readOnly && conversation.transportKind === 'codex_native') {
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
    setConversationDrawer(undefined);
    await selectNativeConversation(conversation);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', '#project-sessions');
    }
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function prepareNativeConversationForTask(taskId: string): void {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    const targetProject = snapshot.projects.find((project) => project.id === task.projectId);
    if (targetProject) {
      activeProjectIdRef.current = targetProject.id;
      setProjectDetail(targetProject);
    }
    setTaskDetail(task);
    setSelectedNativeConversationId(null);
    setConversationDraftOpen(true);
    setNewConversationFocusRequest((current) => current + 1);
    setActiveNavTarget('conversations');
    setActiveProjectSection('sessions');
    setConversationDrawer(undefined);
    setTaskDetailPaneTaskId(undefined);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', '#project-sessions');
    }
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function chooseNativeConversationAttachments(): Promise<NativeConversationAttachment[]> {
    return props.onChooseConversationResources?.() ?? [];
  }

  async function startNativeConversation(input: SessionWorkspaceStartInput): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client) {
      recordLocalError('native-conversation-start', new Error('Codex native app-server client is unavailable.'));
      return;
    }
    setNativeConversationChoiceTaskStates((current) => ({ ...current, [input.task.id]: beginNativeConversationChoiceTaskLoad(current[input.task.id]) }));
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
          setConversationDraftOpen(false);
          const task = snapshot.tasks.find((candidate) => candidate.id === input.task.id);
          if (task) setTaskDetail(task);
        },
        refresh: refreshNativeConversationChoices,
      });
      if (result.acceptance.submission?.status === 'active') {
        writeProjectServiceTierPreference(browserNativeConversationStartStorage(), input.task.projectId, input.serviceTierSelection);
      } else {
        pendingProjectServiceTierPreferencesRef.current.set(result.choice.id, {
          projectId: input.task.projectId,
          clientUserMessageId: result.request.clientUserMessageId,
          selection: input.serviceTierSelection,
        });
      }
      refreshError = result.refreshError;
    } catch (error) {
      const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error));
      setNativeConversationChoiceTaskStates((current) => ({ ...current, [input.task.id]: failNativeConversationChoiceTaskLoad(current[input.task.id], message) }));
      recordLocalError('native-conversation-start', error);
      return;
    }
    if (refreshError) {
      setNativeConversationChoiceTaskStates((current) => ({
        ...current,
        [input.task.id]: failNativeConversationChoiceTaskLoad(current[input.task.id], 'Conversation started. History refresh will retry later.'),
      }));
      recordLocalError('native-conversation-choice-refresh', refreshError);
    }
  }

  async function startProjectConversation(input: ProjectSessionWorkspaceStartInput): Promise<void> {
    const client = props.nativeConversationClient;
    const projectId = input.owner.projectId;
    if (!client) {
      recordLocalError('project-conversation-start', new Error('Project conversation client is unavailable.'));
      return;
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
          setConversationDraftOpen(false);
        },
        refresh: refreshNativeProjectConversationChoices,
      });
      if (result.acceptance.submission?.status === 'active') {
        writeProjectServiceTierPreference(browserNativeConversationStartStorage(), projectId, input.serviceTierSelection);
      } else {
        pendingProjectServiceTierPreferencesRef.current.set(result.choice.id, {
          projectId,
          clientUserMessageId: result.request.clientUserMessageId,
          selection: input.serviceTierSelection,
        });
      }
      refreshError = result.refreshError;
    } catch (error) {
      const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error));
      setNativeConversationChoiceProjectStates((current) => ({ ...current, [projectId]: failNativeConversationChoiceTaskLoad(current[projectId], message) }));
      recordLocalError('project-conversation-start', error);
      return;
    }
    if (refreshError) {
      setNativeConversationChoiceProjectStates((current) => ({
        ...current,
        [projectId]: failNativeConversationChoiceTaskLoad(current[projectId], 'Conversation started. History refresh will retry later.'),
      }));
      recordLocalError('project-conversation-choice-refresh', refreshError);
    }
  }

  const prepareNewConversationDraft = useCallback((): void => {
    // 新对话只是本地会话草稿入口，不能复用任务创建接口，否则会误生成 ZEU 编号的正式任务。
    // 离开任务页时不改状态筛选，返回后继续使用当前项目最后一次显式选择。
    setActiveNavTarget('conversations');
    setActiveProjectSection('sessions');
    setConversationDraftOpen(true);
    setNewConversationFocusRequest((current) => current + 1);
    setSelectedNativeConversationId(null);
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

  async function updateTaskManagementStatus(taskId: string, status: TaskManagementStatus, options: { skipGitReview?: boolean; expectedUpdatedAt?: string } = {}): Promise<TaskEditResult | undefined> {
    const currentTask = (taskDetail?.id === taskId ? taskDetail : undefined) ?? snapshot.tasks.find((task) => task.id === taskId);
    if (!props.onUpdateTaskManagementStatus || !currentTask || resolveTaskManagementStatus(currentTask) === status) return;
    if (!options.skipGitReview && (status === 'completed' || status === 'cancelled') && props.nativeConversationClient) {
      setTaskGitReviewState({ taskId, mode: status });
      return;
    }
    const updateManagementStatus = props.onUpdateTaskManagementStatus;
    return enqueueTaskMutation(taskId, async () => {
      const expectedUpdatedAt = resolveTaskMutationVersion(taskId, options.expectedUpdatedAt ?? currentTask.updatedAt ?? '');
      setActionState('updating-task');
      try {
        const nextSnapshot = await updateManagementStatus(taskId, status, expectedUpdatedAt);
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
        recordLocalError('task-management-status-update', error);
        throw error;
      }
    });
  }

  async function openTaskModelPush(taskId: string): Promise<void> {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
    const client = props.nativeConversationClient;
    if (!task) return;
    setTaskModelPushTaskId(task.id);
    setTaskModelPushCapabilities(null);
    setTaskModelPushForm({
      model: '',
      effort: '',
      serviceTier: { type: 'follow' },
      serviceTierDowngraded: false,
      workMode: 'default',
      permissionMode: 'read-only',
      workspaceMode: 'create',
      environmentId: '',
      repositorySelections: {},
      supplementalInfo: '',
    });
    setTaskModelPushStatus('loading');
    setTaskModelPushError(null);
    taskModelPushEnvelopeRef.current = null;
    const requestVersion = taskModelPushCapabilityRequestRef.current + 1;
    taskModelPushCapabilityRequestRef.current = requestVersion;
    if (!client) {
      setTaskModelPushStatus('error');
      setTaskModelPushError(appShellSettings.appLanguage === 'zh-CN' ? 'Codex app-server 客户端不可用。' : 'Codex app-server client is unavailable.');
      return;
    }
    try {
      // 与 Codex App 一致：打开 composer 时只连接并读取能力，不提前创建 thread/turn。
      const capabilities = await client.loadCodexTaskPushCapabilities(task.projectId, task.id);
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      const remembered = readTaskModelPushPreferences(browserNativeConversationStartStorage(), task.projectId);
      const rememberedServiceTier = readProjectServiceTierPreference(browserNativeConversationStartStorage(), task.projectId);
      setTaskModelPushCapabilities(capabilities);
      setTaskModelPushForm(resolveTaskModelPushInitialForm(capabilities, remembered, rememberedServiceTier));
      setTaskModelPushStatus('ready');
    } catch (error) {
      if (taskModelPushCapabilityRequestRef.current !== requestVersion) return;
      setTaskModelPushStatus('error');
      setTaskModelPushError(redactLocalUiErrorMessage(errorToLocalUiMessage(error)));
    }
  }

  function closeTaskModelPush(): void {
    if (taskModelPushStatus === 'submitting') return;
    taskModelPushCapabilityRequestRef.current += 1;
    taskModelPushEnvelopeRef.current = null;
    setTaskModelPushTaskId(null);
    setTaskModelPushCapabilities(null);
    setTaskModelPushError(null);
  }

  function submitTaskModelPush(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const task = snapshot.tasks.find((candidate) => candidate.id === taskModelPushTaskId);
    const client = props.nativeConversationClient;
    if (!task || !client || !taskModelPushCapabilities || taskModelPushStatus === 'submitting') return;
    const fingerprint = JSON.stringify({ taskId: task.id, projectId: task.projectId, form: taskModelPushForm });
    const persistedEnvelope = taskModelPushEnvelopeRef.current;
    const request: StartTaskModelPushRequest =
      persistedEnvelope?.fingerprint === fingerprint
        ? persistedEnvelope.request
        : {
            mode: 'create',
            source: 'task_push',
            model: taskModelPushForm.model,
            ...(taskModelPushForm.effort ? { effort: taskModelPushForm.effort } : {}),
            ...serviceTierWireOverride(taskModelPushForm.serviceTier),
            workMode: taskModelPushForm.workMode,
            permissionMode: taskModelPushForm.permissionMode,
            workspace:
              taskModelPushForm.workspaceMode === 'existing'
                ? { mode: 'existing', environmentId: taskModelPushForm.environmentId }
                : {
                    mode: 'create',
                    repositories: taskModelPushCapabilities.repositories.map((repository) => ({
                      repositoryId: repository.id,
                      sourceRef: taskModelPushForm.repositorySelections[repository.id]?.sourceRef ?? '',
                      branchName: taskModelPushForm.repositorySelections[repository.id]?.branchName ?? '',
                    })),
                  },
            ...(taskModelPushForm.supplementalInfo.trim() ? { supplementalInfo: taskModelPushForm.supplementalInfo.trim() } : {}),
            idempotencyKey: createSessionOperationId(),
            clientUserMessageId: createSessionOperationId(),
          };
    taskModelPushEnvelopeRef.current = { fingerprint, request };
    setTaskModelPushStatus('submitting');
    setTaskModelPushError(null);
    const targetProject = snapshot.projects.find((project) => project.id === task.projectId);
    const pending = createTaskModelPushPendingState({
      task,
      projectName: targetProject?.name ?? task.projectId,
      request,
      form: taskModelPushForm,
      prompt: buildTaskModelPushMessage(task, taskModelPushForm.supplementalInfo),
    });
    nativeConversationChoiceLoadCoordinator.preserveAccepted(pending.choice);
    setNativeConversationChoicesByTask((current) => {
      const prior = current[task.id];
      const choices = [pending.choice, ...(prior?.choices ?? []).filter((candidate) => candidate.id !== pending.choice.id)];
      return {
        ...current,
        [task.id]: {
          taskId: task.id,
          projectId: task.projectId,
          hasHistory: true,
          requiresChoice: choices.length > 1,
          choices,
          items: choices,
        },
      };
    });
    setTaskModelPushPending(pending);
    if (targetProject) {
      activeProjectIdRef.current = targetProject.id;
      setProjectDetail(targetProject);
    }
    setTaskDetail(task);
    setSelectedNativeConversationId(pending.choice.id);
    setConversationDraftOpen(false);
    setTaskDetailPaneTaskId(undefined);
    setConversationDrawer(undefined);
    taskModelPushCapabilityRequestRef.current += 1;
    setTaskModelPushTaskId(null);
    setTaskModelPushCapabilities(null);
    setActiveNavTarget('conversations');
    setActiveProjectSection('sessions');
    if (typeof window !== 'undefined') window.history.replaceState(null, '', '#project-sessions');
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    void dispatchTaskModelPush(pending);
  }

  async function dispatchTaskModelPush(pending: TaskModelPushPendingState): Promise<void> {
    const client = props.nativeConversationClient;
    if (!client) return;
    try {
      const acceptance = await client.startTaskModelPush(pending.task.id, pending.request);
      if (acceptance.operation.status !== 'accepted' || acceptance.operation.idempotencyKey !== pending.request.idempotencyKey) {
        throw new Error('Task model push did not return a durable accepted operation.');
      }
      taskModelPushEnvelopeRef.current = null;
      const provider = typeof acceptance.conversation.provider === 'object' && acceptance.conversation.provider !== null ? (acceptance.conversation.provider as Record<string, unknown>) : {};
      const providerThreadId = (typeof acceptance.conversation.providerThreadId === 'string' && acceptance.conversation.providerThreadId) || (typeof provider.threadId === 'string' && provider.threadId) || null;
      if (!providerThreadId) {
        throw new Error(appShellSettings.appLanguage === 'zh-CN' ? 'app-server 未能创建真实会话，消息尚未发送。请检查连接后重试。' : 'app-server did not create a real conversation. Check the connection and retry.');
      }

      const choice = nativeConversationChoiceFromAcceptance(acceptance, pending.task);
      nativeConversationChoiceLoadCoordinator.forget(pending.task.id, pending.choice.id);
      nativeConversationChoiceLoadCoordinator.preserveAccepted(choice);
      setNativeConversationChoicesByTask((current) => {
        const prior = current[pending.task.id];
        const choices = [choice, ...(prior?.choices ?? []).filter((candidate) => candidate.id !== choice.id && candidate.id !== pending.choice.id)];
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
      setSelectedNativeConversationId(choice.id);
      setTaskModelPushPending((current) => (current?.request.idempotencyKey === pending.request.idempotencyKey ? acceptTaskModelPushPendingState(current, choice) : current));
      const submissionStatus = typeof acceptance.submission?.status === 'string' ? acceptance.submission.status : null;
      if (submissionStatus === 'active') {
        // 只有 thread/start 与首个 turn/start 都成功后，才更新项目级选择记忆。
        writeTaskModelPushPreferences(browserNativeConversationStartStorage(), pending.task.projectId, pending.form);
        writeProjectServiceTierPreference(browserNativeConversationStartStorage(), pending.task.projectId, pending.form.serviceTier);
      }
      void refreshNativeConversationChoices(pending.task.id).catch((error: unknown) => recordLocalError('task-model-push-history-refresh', error));
      if (props.onLoadTask) {
        void props
          .onLoadTask(pending.task.id)
          .then((updatedTask) => {
            setTaskDetail(updatedTask);
            setSnapshot((current) => ({ ...current, tasks: current.tasks.map((candidate) => (candidate.id === updatedTask.id ? updatedTask : candidate)) }));
          })
          .catch((error: unknown) => recordLocalError('task-model-push-task-refresh', error));
      }
    } catch (error) {
      const message = redactLocalUiErrorMessage(errorToLocalUiMessage(error));
      const failed = failTaskModelPushPendingState(pending, message);
      nativeConversationChoiceLoadCoordinator.preserveAccepted(failed.choice);
      setNativeConversationChoicesByTask((current) => {
        const prior = current[pending.task.id];
        const choices = [failed.choice, ...(prior?.choices ?? []).filter((candidate) => candidate.id !== failed.choice.id)];
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
      setTaskModelPushPending((current) => (current?.request.idempotencyKey === pending.request.idempotencyKey ? failed : current));
    }
  }

  function retryTaskModelPush(): void {
    if (!taskModelPushPending || taskModelPushPending.status !== 'failed') return;
    const retrying = retryTaskModelPushPendingState(taskModelPushPending);
    nativeConversationChoiceLoadCoordinator.preserveAccepted(retrying.choice);
    setNativeConversationChoicesByTask((current) => {
      const prior = current[retrying.task.id];
      const choices = [retrying.choice, ...(prior?.choices ?? []).filter((candidate) => candidate.id !== retrying.choice.id)];
      return {
        ...current,
        [retrying.task.id]: {
          taskId: retrying.task.id,
          projectId: retrying.task.projectId,
          hasHistory: true,
          requiresChoice: choices.length > 1,
          choices,
          items: choices,
        },
      };
    });
    setTaskModelPushPending(retrying);
    void dispatchTaskModelPush(retrying);
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
    const skippedCount = requestedTasks.length - eligibleTasks.length;
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
          if (!props.onUpdateTaskManagementStatus) throw new Error('Task management status handler is not available.');
          const nextSnapshot = await props.onUpdateTaskManagementStatus(task.id, targetStatus, task.updatedAt ?? '');
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

  async function runBulkTaskDelete(taskIds: string[]): Promise<void> {
    if (!props.onDeleteTask) return;
    const requestedTaskIdSet = new Set(taskIds);
    const requestedTasks = visibleTasks.filter((task) => requestedTaskIdSet.has(task.id));
    const eligibleTasks = requestedTasks.filter((task) => task.status !== 'running' && task.status !== 'waiting_confirmation');
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

  async function checkReleaseUpdate(presentDialog = false): Promise<void> {
    if (!props.onCheckReleaseUpdate) return;
    if (presentDialog && releaseUpdateMenuBusyRef.current) return;
    const requestId = releaseUpdateRequestIdRef.current + 1;
    releaseUpdateRequestIdRef.current = requestId;
    if (presentDialog) {
      releaseUpdateMenuBusyRef.current = true;
      setReleaseUpdateDialogState({ kind: 'checking' });
    }
    setReleaseUpdateCheckState('loading');
    try {
      const update = await props.onCheckReleaseUpdate();
      setReleaseUpdateStatus(update);
      setReleaseUpdateCheckState('idle');
      if (presentDialog && releaseUpdateRequestIdRef.current === requestId) {
        setReleaseUpdateDialogState({ kind: 'result', update });
      }
    } catch (error) {
      setReleaseUpdateCheckState('failed');
      if (presentDialog && releaseUpdateRequestIdRef.current === requestId) {
        setReleaseUpdateDialogState({ kind: 'failed' });
      }
      recordLocalError('renderer-action', error);
    } finally {
      if (presentDialog) releaseUpdateMenuBusyRef.current = false;
    }
  }

  function closeReleaseUpdateDialog(): void {
    releaseUpdateRequestIdRef.current += 1;
    releaseUpdateMenuBusyRef.current = false;
    setReleaseUpdateDialogState(null);
  }

  async function openReleaseUpdateDownloadPage(update: ReleaseUpdateStatusSnapshot): Promise<void> {
    const result = await openExternalHttpsUrlInMain({
      zeus: typeof window === 'undefined' ? undefined : window.zeus,
      url: update.releasePageUrl,
    });
    if (result.opened) {
      closeReleaseUpdateDialog();
      return;
    }
    setReleaseUpdateDialogState({
      kind: 'failed',
      update,
      reason: appShellSettings.appLanguage === 'zh-CN' ? '无法安全打开 GitHub Release 下载页。' : 'Zeus could not safely open the GitHub Release download page.',
    });
  }

  async function installReleaseUpdate(update: ReleaseUpdateStatusSnapshot): Promise<void> {
    if (!props.onDownloadReleaseUpdate || !props.onInstallReleaseUpdate) {
      setReleaseUpdateDialogState({
        kind: 'failed',
        update,
        reason: appShellSettings.appLanguage === 'zh-CN' ? '当前构建没有可用的下载和安装桥接。' : 'This build does not provide the download and installation bridge.',
      });
      return;
    }
    setReleaseUpdateDialogState({ kind: 'installing', update });
    try {
      const download = await props.onDownloadReleaseUpdate();
      if (!download.accepted) {
        setReleaseUpdateDialogState({ kind: 'failed', update: download.update, reason: download.reason });
        return;
      }
      const installation = await props.onInstallReleaseUpdate();
      if (!installation.accepted) {
        setReleaseUpdateDialogState({ kind: 'failed', update: installation.update, reason: installation.reason });
        return;
      }
      setReleaseUpdateDialogState({ kind: 'installing', update: installation.update });
    } catch (error) {
      setReleaseUpdateDialogState({
        kind: 'failed',
        update,
        reason: appShellSettings.appLanguage === 'zh-CN' ? '升级请求失败，请稍后重试。' : 'The update request failed. Try again later.',
      });
      recordLocalError('renderer-action', error);
    }
  }

  useEffect(() => {
    const unsubscribe = window.zeus?.onNativeCheckForUpdates?.(() => {
      void checkReleaseUpdate(true);
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [props.onCheckReleaseUpdate]);

  async function checkRuntimeAdapter(adapterId: string): Promise<void> {
    if (!props.onCheckRuntimeAdapter) return;
    setActionState('loading-runtime');
    try {
      const status = await props.onCheckRuntimeAdapter(adapterId);
      setRuntimeAdapterChecks((current) => ({
        ...current,
        [adapterId]: status,
      }));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function saveRuntimeSettings(): Promise<void> {
    if (!props.onSaveRuntimeSettings) return;
    setActionState('loading-runtime');
    try {
      // 只保存用户选择的默认 adapter；是否可用仍必须通过真实 CLI 检测确认。
      setRuntimeSettings(normalizeRuntimeSettings(await props.onSaveRuntimeSettings(runtimeSettings)));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function saveAppShellSettings(): Promise<void> {
    if (!props.onSaveAppShellSettings) return;
    setActionState('loading-runtime');
    try {
      // 通用设置只保存本机偏好，不写入任何业务假数据或密钥明文。
      const savedSettings = await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(appShellSettings));
      setAppShellSettings((currentSettings) =>
        mergeAppShellSettingsSaveResponse({
          currentSettings,
          savedSettings,
        }),
      );
      await notifyMainAppShellSettingsChanged({
        zeus: window.zeus,
        settings: {
          webviewDebugEnabled: savedSettings.webviewDebugEnabled,
          multiWindowEnabled: savedSettings.multiWindowEnabled,
          backgroundModeEnabled: savedSettings.backgroundModeEnabled,
          desktopNotificationsEnabled: savedSettings.desktopNotificationsEnabled,
          openAtLoginEnabled: savedSettings.openAtLoginEnabled,
        },
      });
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
      const savedSettings = await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(nextSettings));
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
      const savedSettings = props.onSaveAppShellSettings ? normalizeRendererAppShellSettings(await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(nextSettings))) : nextSettings;
      setAppShellSettings((currentSettings) => ({
        ...savedSettings,
        taskStatusFilterByProject: currentSettings.taskStatusFilterByProject,
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
      const nextSnapshot = await props.onCreateTaskFromRuntimeSession(session.id, buildRuntimeSessionTaskDraft(session, appShellSettings.appLanguage));
      setSnapshot(nextSnapshot);
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
      const nextSnapshot = await props.onCreateTaskFromTemplate(templateId, activeProjectId);
      setConversationDraftOpen(false);
      setSnapshot(nextSnapshot);
      const latestTaskId = nextSnapshot.tasks.at(-1)?.id;
      if (latestTaskId && props.onLoadTaskEvents) {
        setTaskEvents(await props.onLoadTaskEvents(latestTaskId));
      }
      setActionState('idle');
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
    requestTaskTableLayoutLeave(navigate);
  }

  function openProjectSection(project: ProjectRecord, section: ProjectWorkspaceSection): void {
    const navigate = () => {
      activeProjectIdRef.current = project.id;
      setProjectDetail(project);
      setConversationDraftOpen(false);
      setActiveNavTarget(section === 'project-settings' || section === 'code' || section === 'commands' ? 'projects' : 'conversations');
      setActiveProjectSection(section);
      setProjectPanel(section === 'project-settings' ? 'config' : undefined);
      const projectGraphIsAlreadyCurrent = graphProjectId === project.id && graphView !== undefined && isProjectGraphViewForProject(graphView, project, { requireProjectIdentity: true });
      if (section === 'code' && !projectGraphIsAlreadyCurrent) {
        resetGraphWorkspace(project.id);
        if (project.scanStatus === 'completed') void openProjectGraphView(project.id, 'architecture');
      }
      if (section === 'project-settings') void loadProjectConfig(project.id);
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', `#project-${section}`);
      }
      workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    };
    if (project.id === activeProjectId && section === activeProjectSection) {
      navigate();
      return;
    }
    requestTaskTableLayoutLeave(navigate);
  }

  async function togglePinnedProject(projectId: string): Promise<void> {
    const currentIds = appShellSettings.pinnedProjectIds;
    const nextPinnedProjectIds = currentIds.includes(projectId) ? currentIds.filter((id) => id !== projectId) : [projectId, ...currentIds];
    const nextSettings = normalizeRendererAppShellSettings({ ...appShellSettings, pinnedProjectIds: nextPinnedProjectIds });
    setAppShellSettings(nextSettings);
    if (!props.onSaveAppShellSettings) return;
    try {
      const savedSettings = await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(nextSettings));
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
      const savedSettings = await props.onSaveAppShellSettings(toAppShellSettingsSavePayload(nextSettings));
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

  return (
    <main
      className={`zeus-shell ai-native-shell macos-ai-app codex-thread-workbench code-map-product-shell theme-${appShellSettings.appearance}${activeNavTarget === 'settings' ? ' settings-dedicated-shell' : ''}${activeProjectSection === 'sessions' && activeNavTarget !== 'settings' ? ' session-codex-parity-v1' : ''}`}
      data-theme={appShellSettings.appearance}
      data-language={appShellSettings.appLanguage}
      data-session-source-rail={sessionSourceRailOpen ? 'open' : 'hidden'}
      data-project-sidebar-resizing={projectSidebarResizing ? 'true' : 'false'}
      style={projectSidebarShellStyle}
      lang={uiCopy.documentLang}
      aria-label={uiCopy.shellAriaLabel}
    >
      <div className="window-drag-strip" aria-hidden="true" onPointerDown={handleWindowDragPointerDown} />
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
      {releaseUpdateDialogState ? (
        <ReleaseUpdateDialog
          language={appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en'}
          state={releaseUpdateDialogState}
          onDismiss={closeReleaseUpdateDialog}
          onRetry={() => void checkReleaseUpdate(true)}
          onOpenDownloadPage={(update) => void openReleaseUpdateDownloadPage(update)}
          onInstall={(update) => void installReleaseUpdate(update)}
        />
      ) : null}
      {activeNavTarget !== 'settings' ? (
        <SidebarNav
          activeNavTarget={activeNavTarget}
          activeProjectId={activeProjectId}
          activeProjectSection={activeProjectSection}
          projects={orderedProjects}
          pinnedProjectIds={appShellSettings.pinnedProjectIds}
          collapsedProjectIds={appShellSettings.collapsedProjectIds}
          appLanguage={appShellSettings.appLanguage}
          canCreateProject={projectCreationReady && !creatingProjectBusy}
          createProjectBusy={creatingProjectBusy}
          onCreateProject={openProjectCreateDialog}
          onCreateConversation={prepareNewConversationDraft}
          onNavigate={handleMainNavigate}
          onOpenProjectSection={openProjectSection}
          onTogglePinnedProject={togglePinnedProject}
          onToggleProjectCollapsed={(projectId) => void toggleCollapsedProject(projectId)}
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
      {activeProjectSection === 'sessions' && activeNavTarget !== 'settings' ? (
        <button
          type="button"
          className="session-mobile-source-backdrop"
          aria-label={appShellSettings.appLanguage === 'zh-CN' ? '关闭会话列表' : 'Close conversation list'}
          aria-hidden={sessionSourceRailOpen ? undefined : true}
          tabIndex={sessionSourceRailOpen ? 0 : -1}
          onClick={() => {
            setSessionSourceRailOpen(false);
            sessionSourceRailTriggerRef.current?.focus();
          }}
        />
      ) : null}

      <section className="workspace ai-workspace" ref={workspaceScrollRef}>
        {activeProjectSection === 'sessions' && activeNavTarget !== 'settings' ? (
          <SessionMobileSourceTrigger triggerRef={sessionSourceRailTriggerRef} language={appShellSettings.appLanguage} open={sessionSourceRailOpen} onOpen={() => setSessionSourceRailOpen(true)} />
        ) : null}
        {localError ? (
          <section className="inline-status failed" aria-label={uiCopy.localOperationFailed}>
            <strong>{localError.message}</strong>
          </section>
        ) : null}

        {activeNavTarget !== 'settings' && activeProjectSection === 'commands' && selectedProject && props.commandClient ? (
          <section className="workspace-view workspace-view-command-center" aria-label={appShellSettings.appLanguage === 'zh-CN' ? '项目命令' : 'Project commands'}>
            <CommandCenterPanel mode="project" project={selectedProject} client={props.commandClient} language={appShellSettings.appLanguage} />
          </section>
        ) : null}

        {activeNavTarget !== 'settings' && (activeProjectSection === 'code' || activeProjectSection === 'project-settings') ? (
          <section
            className={`workspace-view ${activeProjectSection === 'project-settings' ? 'workspace-view-project-settings' : 'workspace-view-project-code'}`}
            aria-label={activeProjectSection === 'project-settings' ? codeWorkspaceCopy.projectSettingsAria : codeWorkspaceCopy.projectCodeAria}
          >
            <section className="workspace-detail-pane project-detail-pane" aria-label={codeWorkspaceCopy.detailAria}>
              {selectedProject ? (
                <div className={`project-repository-workbench ${activeProjectSection === 'code' ? 'project-code-workbench' : 'project-settings-workbench'}`}>
                  {/* 代码图谱页直接进入工作舞台；对象身份栏只保留给项目设置页。 */}
                  {activeProjectSection === 'project-settings' ? (
                    <section className="project-repository-status-row zeus-object-toolbar" aria-label={codeWorkspaceCopy.repositoryAria}>
                      <span className="native-folder-icon zeus-avatar-token zeus-object-toolbar-avatar" aria-hidden="true" />
                      <span className="project-repository-main zeus-object-toolbar-copy">
                        <strong>{selectedProject.name}</strong>
                        <span>{selectedProject.localPath}</span>
                      </span>
                      <span className="project-state-meta zeus-object-toolbar-status">{codeWorkspaceCopy.stateProjectSettings}</span>
                    </section>
                  ) : null}

                  <section className="project-code-primary" aria-label={codeWorkspaceCopy.overviewAria}>
                    {activeProjectSection === 'code' ? renderProjectCodeMapStage() : null}
                    {activeProjectSection === 'project-settings' || !activeGraphView ? (
                      <section className="project-code-context-rail" aria-label={codeWorkspaceCopy.contextRailAria}>
                        <section className="code-repository-facts" aria-label={codeWorkspaceCopy.repositoryStatusAria}>
                          <div className="code-context-rail-heading">
                            <strong>{codeWorkspaceCopy.repositoryStatusTitle}</strong>
                            <span>{selectedProject.name}</span>
                          </div>
                          <dl>
                            <div className="code-repository-fact-row">
                              <dt>{codeWorkspaceCopy.localPath}</dt>
                              <dd>{selectedProject.localPath}</dd>
                            </div>
                            <div className="code-repository-fact-row">
                              <dt>{codeWorkspaceCopy.scan}</dt>
                              <dd>{formatProjectScanStatus(selectedProject.scanStatus, codeWorkspaceCopy)}</dd>
                            </div>
                            <div className="code-repository-fact-row">
                              <dt>{codeWorkspaceCopy.git}</dt>
                              <dd>
                                {gitLabel}
                                {changedFiles.length > 0 ? ` · ${changedFiles.length} ${codeWorkspaceCopy.changeUnit}` : ''}
                              </dd>
                            </div>
                            <div className="code-repository-fact-row">
                              <dt>{codeWorkspaceCopy.graph}</dt>
                              <dd>
                                {activeProjectGraphSummary.nodeCount > 0
                                  ? `${codeWorkspaceCopy.graphCounts(activeProjectGraphSummary.nodeCount, activeProjectGraphSummary.edgeCount)} · ${activeProjectGraphSummaryBoundary}`
                                  : codeWorkspaceCopy.waitingRealScan}
                              </dd>
                            </div>
                          </dl>
                        </section>

                        <section className="code-graph-status-strip" aria-label={codeWorkspaceCopy.graphSummaryAria}>
                          <div className="code-context-rail-heading">
                            <strong>{codeWorkspaceCopy.graphTitle}</strong>
                            <span>{activeProjectGraphSummary.nodeCount > 0 ? activeProjectGraphSummaryBoundary : codeWorkspaceCopy.waitingRealScan}</span>
                          </div>
                          <p>
                            {activeProjectGraphSummary.nodeCount > 0
                              ? `${activeProjectGraphSummaryBoundary} · ${codeWorkspaceCopy.graphCounts(activeProjectGraphSummary.nodeCount, activeProjectGraphSummary.edgeCount)}`
                              : codeWorkspaceCopy.emptyGraphHelp}
                          </p>
                        </section>

                        <div className="code-repository-primary-rail" aria-label={codeWorkspaceCopy.primaryActionsAria}>
                          {/* 代码库主路径只有三件事：扫描、打开图谱、查看变更；其余项目操作收进次要操作行。 */}
                          <button
                            type="button"
                            onClick={() => {
                              void scanActiveProjectGraph();
                            }}
                            disabled={(!props.onScanProjectGraph && !props.onScanCurrentGraph) || !activeProjectId || scanBusy}
                            {...controlBusyProps(scanBusy)}
                          >
                            {codeWorkspaceCopy.scanProject}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void handleCodeMapAction();
                            }}
                            disabled={(!props.onLoadProjectGraphView && !props.onLoadGraphView && !props.onScanProjectGraph && !props.onScanCurrentGraph) || !activeProjectId || scanBusy}
                            {...controlBusyProps(scanBusy)}
                          >
                            {codeMapActionLabel()}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setProjectPanel('diff');
                              void loadGitDiff();
                            }}
                            disabled={!props.onLoadGitDiff || loadingDiffBusy}
                            {...controlBusyProps(loadingDiffBusy)}
                          >
                            {codeWorkspaceCopy.viewChanges}
                          </button>
                        </div>

                        <div className="code-repository-secondary-rail" aria-label={codeWorkspaceCopy.secondaryActionsAria}>
                          <button type="button" onClick={() => setProjectPanel(projectPanel === 'edit' ? undefined : 'edit')}>
                            {codeWorkspaceCopy.edit}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setProjectPanel(projectPanel === 'config' ? undefined : 'config');
                              if (selectedProject.id) {
                                void loadProjectConfig(selectedProject.id);
                                void loadProjectWorkspaceConfig(selectedProject.id);
                              }
                            }}
                          >
                            {codeWorkspaceCopy.configure}
                          </button>
                          <button type="button" onClick={() => setProjectPanel(projectPanel === 'archive' ? undefined : 'archive')}>
                            {codeWorkspaceCopy.moreProjectActions}
                          </button>
                        </div>
                      </section>
                    ) : null}
                  </section>

                  {projectPanel ? (
                    <WorkspaceDrawer
                      {...projectDrawerVisualProps}
                      label={projectPanel === 'config' ? projectConfigCopy.formAria : codeWorkspaceCopy.drawerLabel}
                      backdropLabel={codeWorkspaceCopy.drawerBackdrop}
                      closeLabel={codeWorkspaceCopy.drawerClose}
                      className="project-drawer"
                      portalStyle={workspaceDrawerPortalStyle}
                      onClose={() => setProjectPanel(undefined)}
                    >
                      {projectPanel === 'diff' ? (
                        <section className="product-drawer-pane git-diff-drawer-workbench" aria-label={gitDiffCopy.drawerAria}>
                          {/* Git review flat workbench：文件、hunk 与确认参数按连续审查流呈现，不再使用 panel/card 壳层。 */}
                          <div className="drawer-header-row">
                            <strong>{gitDiffCopy.title}</strong>
                            <button type="button" onClick={exportGitPatch} disabled={loadingDiffBusy} {...controlBusyProps(loadingDiffBusy)}>
                              {gitDiffCopy.exportPatch}
                            </button>
                          </div>
                          <section className="git-worktree-state-row" aria-label={gitDiffCopy.worktreeStateAria}>
                            <strong>{gitDiffCopy.worktreeStateTitle}</strong>
                            <span>{snapshot.git.clean === true ? gitDiffCopy.cleanStatus : gitDiffCopy.changedStatus(changedFiles.length)}</span>
                            <em>{gitDiffCopy.worktreeMeta(snapshot.git.conflictFiles?.length ?? 0, snapshot.git.remoteBranches?.length ?? 0, snapshot.git.recentCommits?.[0]?.shortHash)}</em>
                          </section>
                          <section className="git-file-change-list" aria-label={gitDiffCopy.changedFilesAria}>
                            {changedFiles.length === 0 ? <span>{gitDiffCopy.emptyChangedFiles}</span> : changedFiles.slice(0, 12).map((file) => <code key={file}>{file}</code>)}
                          </section>
                          {gitDiff?.fileDiffs.slice(0, 4).map((file) => (
                            <section className="git-review-workbench git-file-review-workbench" key={`${file.oldPath}-${file.newPath}`} aria-label={gitDiffCopy.fileReviewAria(file.newPath)}>
                              <div className="git-file-review-heading">
                                <strong>{gitDiffCopy.fileDiffTitle(file.newPath)}</strong>
                                <span>
                                  +{file.addedLines} / -{file.deletedLines}
                                </span>
                              </div>
                              {file.hunks.slice(0, 2).map((hunk) => (
                                <div className="git-hunk-decision git-hunk-review-row" key={hunk.header}>
                                  <div className="git-hunk-lines">
                                    <span className="git-hunk-meta">{hunk.header}</span>
                                    {hunk.lines.slice(0, 4).map((line, index) => (
                                      <code key={`${hunk.header}-${index}`}>{line.content}</code>
                                    ))}
                                    <small>{gitHunkDecisions[buildGitHunkReviewKey(file, hunk)] ?? gitDiffCopy.pendingDecision}</small>
                                  </div>
                                  <div className="git-hunk-command-rail" aria-label={gitDiffCopy.hunkActionsAria(hunk.header)}>
                                    <button type="button" onClick={() => setGitHunkDecision(file, hunk, 'accepted')}>
                                      {gitDiffCopy.acceptHunk}
                                    </button>
                                    <button type="button" onClick={() => setGitHunkDecision(file, hunk, 'rejected')}>
                                      {gitDiffCopy.rejectHunk}
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </section>
                          ))}
                          {gitDiff ? <small>{buildGitDiffDecisionSummary(gitDiff, gitHunkDecisions, appShellSettings.appLanguage)}</small> : null}
                          <section className="git-risk-row-list" aria-label={gitDiffCopy.riskParamsAria}>
                            <strong>{gitDiffCopy.riskParamsTitle}</strong>
                            {/* Git 高风险参数必须显式说明影响范围，避免用户把危险 Git 写操作当作普通输入框。 */}
                            <section className="git-risk-input-row" aria-label={gitDiffCopy.branchNameAria}>
                              <span className="git-risk-input-copy">
                                <strong>{gitDiffCopy.branchNameTitle}</strong>
                                <small>{gitDiffCopy.branchNameHelp}</small>
                              </span>
                              <span className="git-risk-input-field">
                                <input aria-label={gitDiffCopy.branchNameAria} value={gitBranchName} onChange={(event) => setGitBranchName(event.currentTarget.value)} />
                              </span>
                            </section>
                            <section className="git-risk-input-row" aria-label={gitDiffCopy.switchBranchAria}>
                              <span className="git-risk-input-copy">
                                <strong>{gitDiffCopy.switchBranchTitle}</strong>
                                <small>{gitDiffCopy.switchBranchHelp}</small>
                              </span>
                              <span className="git-risk-input-field">
                                <input aria-label={gitDiffCopy.switchBranchAria} value={gitSwitchBranchName} onChange={(event) => setGitSwitchBranchName(event.currentTarget.value)} />
                              </span>
                            </section>
                            <section className="git-risk-input-row" aria-label={gitDiffCopy.baseRefAria}>
                              <span className="git-risk-input-copy">
                                <strong>{gitDiffCopy.baseRefTitle}</strong>
                                <small>{gitDiffCopy.baseRefHelp}</small>
                              </span>
                              <span className="git-risk-input-field">
                                <input aria-label={gitDiffCopy.baseRefAria} value={gitBaseRef} onChange={(event) => setGitBaseRef(event.currentTarget.value)} />
                              </span>
                            </section>
                            <section className="git-risk-input-row" aria-label={gitDiffCopy.stashRefAria}>
                              <span className="git-risk-input-copy">
                                <strong>{gitDiffCopy.stashRefTitle}</strong>
                                <small>{gitDiffCopy.stashRefHelp}</small>
                              </span>
                              <span className="git-risk-input-field">
                                <input aria-label={gitDiffCopy.stashRefAria} value={gitStashRef} onChange={(event) => setGitStashRef(event.currentTarget.value)} />
                              </span>
                            </section>
                            <section className="git-risk-input-row" aria-label={gitDiffCopy.remoteNameAria}>
                              <span className="git-risk-input-copy">
                                <strong>{gitDiffCopy.remoteNameTitle}</strong>
                                <small>{gitDiffCopy.remoteNameHelp}</small>
                              </span>
                              <span className="git-risk-input-field">
                                <input aria-label={gitDiffCopy.remoteNameAria} value={gitRemote} onChange={(event) => setGitRemote(event.currentTarget.value)} />
                              </span>
                            </section>
                            <section className="git-risk-input-row" aria-label={gitDiffCopy.targetRefAria}>
                              <span className="git-risk-input-copy">
                                <strong>{gitDiffCopy.targetRefTitle}</strong>
                                <small>{gitDiffCopy.targetRefHelp}</small>
                              </span>
                              <span className="git-risk-input-field">
                                <input aria-label={gitDiffCopy.targetRefAria} value={gitTargetRef} onChange={(event) => setGitTargetRef(event.currentTarget.value)} />
                              </span>
                            </section>
                            <section className="git-risk-input-row" aria-label={gitDiffCopy.rollbackTargetAria}>
                              <span className="git-risk-input-copy">
                                <strong>{gitDiffCopy.rollbackTargetTitle}</strong>
                                <small>{gitDiffCopy.rollbackTargetHelp}</small>
                              </span>
                              <span className="git-risk-input-field">
                                <input aria-label={gitDiffCopy.rollbackTargetAria} value={gitRollbackRef} onChange={(event) => setGitRollbackRef(event.currentTarget.value)} />
                              </span>
                            </section>
                          </section>
                          <section className="git-confirmation-risk-list git-confirmation-row-list" aria-label={gitDiffCopy.confirmationAria}>
                            <section className="git-risk-input-row git-confirmation-message-row" aria-label={gitDiffCopy.commitMessageAria}>
                              <span className="git-risk-input-copy">
                                <strong>{gitDiffCopy.commitMessageTitle}</strong>
                                <small>{gitDiffCopy.commitMessageHelp}</small>
                              </span>
                              <span className="git-risk-input-field">
                                <input aria-label={gitDiffCopy.commitMessageAria} value={gitCommitMessage} onChange={(event) => setGitCommitMessage(event.currentTarget.value)} />
                              </span>
                            </section>
                            <section className="git-confirmation-state-row" aria-label={gitDiffCopy.commitMessageStatusAria}>
                              <span className="git-confirmation-state-copy">
                                <strong>{gitDiffCopy.commitMessageStatusTitle}</strong>
                                <small>{gitDiffCopy.commitMessageStatusHelp}</small>
                              </span>
                              <span>{gitDiffCopy.commitMessageStatusText}</span>
                            </section>
                            <div className="git-confirmation-command-rail">
                              <button type="button" onClick={() => createGitConfirmation('stash')} disabled={creatingGitConfirmationBusy} {...controlBusyProps(creatingGitConfirmationBusy)}>
                                {gitDiffCopy.requestStashConfirmation}
                              </button>
                              <button type="button" onClick={() => createGitConfirmation('commit')} disabled={creatingGitConfirmationBusy || !gitCommitMessage.trim()} {...controlBusyProps(creatingGitConfirmationBusy)}>
                                {gitDiffCopy.requestCommitConfirmation}
                              </button>
                            </div>
                            {gitConfirmation ? (
                              <section className="git-confirmation-state-row" aria-label={gitDiffCopy.currentConfirmationAria}>
                                <span className="git-confirmation-state-copy">
                                  <strong>{gitDiffCopy.currentConfirmationTitle}</strong>
                                  <small>{formatGitConfirmationStatus(gitConfirmation.status, appShellSettings.appLanguage)}</small>
                                </span>
                                <span>{gitConfirmation.confirmationText}</span>
                              </section>
                            ) : (
                              <section className="git-confirmation-state-row" aria-label={gitDiffCopy.patchStatusAria}>
                                <span className="git-confirmation-state-copy">
                                  <strong>{gitDiffCopy.patchStatusTitle}</strong>
                                  <small>{gitDiffCopy.localExport}</small>
                                </span>
                                <span>{patchExportStatus}</span>
                              </section>
                            )}
                            {gitConfirmation?.expiresAt ? (
                              <section className="git-confirmation-state-row" aria-label={gitDiffCopy.confirmationExpiryAria}>
                                <span className="git-confirmation-state-copy">
                                  <strong>{gitDiffCopy.confirmationExpiryTitle}</strong>
                                  <small>{gitDiffCopy.confirmationExpiryHelp}</small>
                                </span>
                                <span>{formatGitConfirmationExpiry(gitConfirmation.expiresAt, appShellSettings.appLanguage)}</span>
                              </section>
                            ) : null}
                            {gitConfirmation?.status === 'pending' ? (
                              <div className="git-confirmation-command-rail">
                                <button type="button" onClick={confirmGitOperation} disabled={!props.onConfirmGitOperation || confirmingGitOperationBusy} {...controlBusyProps(confirmingGitOperationBusy)}>
                                  {gitDiffCopy.confirmOperation}
                                </button>
                                <button type="button" onClick={rejectGitOperation} disabled={!props.onRejectGitOperation || confirmingGitOperationBusy} {...controlBusyProps(confirmingGitOperationBusy)}>
                                  {gitDiffCopy.rejectConfirmation}
                                </button>
                              </div>
                            ) : null}
                            {gitConfirmation?.status === 'pending' ? (
                              <section className="git-confirmation-state-row" aria-label={gitDiffCopy.rejectImpactAria}>
                                <span className="git-confirmation-state-copy">
                                  <strong>{gitDiffCopy.rejectImpactTitle}</strong>
                                  <small>{gitDiffCopy.safetyBoundary}</small>
                                </span>
                                <span>{gitDiffCopy.rejectImpactText}</span>
                              </section>
                            ) : null}
                            {gitConfirmation?.status === 'rejected' ? (
                              <section className="git-confirmation-rejected-row" aria-label={gitDiffCopy.rejectedAria}>
                                <span className="git-confirmation-state-copy">
                                  <strong>{gitDiffCopy.rejectedTitle}</strong>
                                  <small>{gitDiffCopy.rejectedHelp}</small>
                                </span>
                                <span>{gitConfirmation.rejectedReason ?? gitDiffCopy.rejectedFallback}</span>
                              </section>
                            ) : null}
                            {gitConfirmation?.status === 'confirmed' ? (
                              <section className="git-confirmation-state-row" aria-label={gitDiffCopy.whitelistScopeAria}>
                                <span className="git-confirmation-state-copy">
                                  <strong>{gitDiffCopy.executionScopeTitle}</strong>
                                  <small>{gitDiffCopy.whitelistCommandHelp}</small>
                                </span>
                                <span>{gitDiffCopy.whitelistCommandText}</span>
                              </section>
                            ) : null}
                            {gitConfirmation?.status === 'confirmed' ? (
                              <div className="git-confirmation-command-rail">
                                <button type="button" onClick={executeConfirmedGitOperation} disabled={!props.onExecuteGitOperation || executingGitOperationBusy} {...controlBusyProps(executingGitOperationBusy)}>
                                  {gitDiffCopy.executeConfirmed}
                                  {formatGitOperationLabel(gitConfirmation.operation, appShellSettings.appLanguage)}
                                </button>
                              </div>
                            ) : null}
                            <section className="git-confirmation-state-row" aria-label={gitDiffCopy.operationStatusAria}>
                              <span className="git-confirmation-state-copy">
                                <strong>{gitDiffCopy.operationStatusTitle}</strong>
                                <small>{gitDiffCopy.localExecutionChain}</small>
                              </span>
                              <span>{gitOperationStatus}</span>
                            </section>
                          </section>
                        </section>
                      ) : null}

                      {projectPanel === 'edit' ? (
                        <form className="product-drawer-pane project-edit-row-list" aria-label={projectEditCopy.formAria} onSubmit={(event) => updateProject(selectedProject.id, event)}>
                          {/* 项目编辑属于项目级危险入口，常规字段和删除确认必须分行，避免误点。 */}
                          <div className="project-edit-identity-row" aria-label={projectEditCopy.currentProjectAria}>
                            <strong>{projectEditCopy.currentProjectTitle}</strong>
                            <span>{selectedProject.name}</span>
                            <em>{selectedProject.localPath}</em>
                          </div>
                          {/* 项目编辑字段保持说明列 + 控件列，避免修改入口继续呈现为旧后台表单。 */}
                          <section className="project-edit-setting-row" aria-label={projectEditCopy.nameAria}>
                            <span className="project-edit-setting-copy">
                              <strong>{projectEditCopy.nameTitle}</strong>
                              <small>{projectEditCopy.nameHelp}</small>
                            </span>
                            <span className="project-edit-setting-field">
                              <input aria-label={projectEditCopy.nameAria} value={projectEditForm.name} onChange={(event) => patchProjectEditForm({ name: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-edit-setting-row" aria-label={projectEditCopy.pathAria}>
                            <span className="project-edit-setting-copy">
                              <strong>{projectEditCopy.pathTitle}</strong>
                              <small>{projectEditCopy.pathHelp}</small>
                            </span>
                            <span className="project-edit-setting-field">
                              <input aria-label={projectEditCopy.pathAria} value={projectEditForm.localPath} onChange={(event) => patchProjectEditForm({ localPath: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-edit-setting-row project-edit-textarea-row" aria-label={projectEditCopy.descriptionAria}>
                            <span className="project-edit-setting-copy">
                              <strong>{projectEditCopy.descriptionTitle}</strong>
                              <small>{projectEditCopy.descriptionHelp}</small>
                            </span>
                            <span className="project-edit-setting-field">
                              <textarea aria-label={projectEditCopy.descriptionAria} value={projectEditForm.description} onChange={(event) => patchProjectEditForm({ description: event.currentTarget.value })} />
                            </span>
                          </section>
                          <div className="project-edit-command-rail" aria-label={projectEditCopy.saveAria}>
                            <button type="submit" disabled={!projectEditForm.name.trim() || creatingProjectBusy} {...controlBusyProps(creatingProjectBusy)}>
                              {projectEditCopy.save}
                            </button>
                          </div>
                          <section className="project-edit-danger-row" aria-label={projectEditCopy.deleteAria}>
                            <span className="project-edit-danger-copy">
                              <strong>{projectEditCopy.deleteTitle}</strong>
                              <small>{projectEditCopy.deleteHelp}</small>
                            </span>
                            <span className="project-edit-danger-rail">
                              <button type="button" className="danger-action" onClick={() => setPendingProjectDeleteId(selectedProject.id)}>
                                {projectEditCopy.deleteTitle}
                              </button>
                              {pendingProjectDeleteId === selectedProject.id ? (
                                <button type="button" className="danger-action" onClick={() => deleteProject(selectedProject.id)}>
                                  {projectEditCopy.confirmDelete}
                                </button>
                              ) : null}
                            </span>
                          </section>
                        </form>
                      ) : null}

                      {projectPanel === 'config' ? (
                        <form className="product-drawer-pane project-config-row-list" aria-label={projectConfigCopy.formAria} onSubmit={(event) => saveProjectConfig(selectedProject.id, event)}>
                          {/* 项目配置抽屉必须覆盖完整保存契约，避免隐藏字段只能靠默认值写回。 */}
                          <div className="project-config-state-row" aria-label={projectConfigCopy.currentStateAria}>
                            <strong>{projectConfigCopy.currentStateTitle}</strong>
                            <span>{projectConfig ? uiCopy.workModes[projectConfig.defaultWorkMode] : projectConfigCopy.waitingToLoad}</span>
                            <em>
                              {formatProjectLanguage(projectConfigForm)} · {formatProjectDependencies(projectConfigForm, projectConfigCopy)}
                            </em>
                          </div>
                          <section className="project-workspace-config" aria-label="项目任务工作区">
                            <span className="project-config-setting-copy">
                              <strong>任务工作区</strong>
                              <small>项目目录是容器。请确认任务需要带入的 Git 仓库；每次新建任务环境时会再逐仓选择来源分支。</small>
                            </span>
                            <div className="project-workspace-config-body">
                              <small>项目容器：{projectWorkspaceConfig?.containerPath ?? selectedProject.localPath}</small>
                              {projectWorkspaceConfigStatus === 'loading' ? <small>正在发现 Git 仓库…</small> : null}
                              {(projectRepositoryDiscovery?.candidates ?? []).length > 0 ? (
                                <fieldset className="project-repository-choice-list">
                                  <legend>发现的 Git 仓库</legend>
                                  {projectRepositoryDiscovery?.candidates.map((candidate) => (
                                    <label key={candidate.localPath}>
                                      <input
                                        type="checkbox"
                                        checked={selectedProjectRepositoryPaths.includes(candidate.localPath)}
                                        onChange={(event) => {
                                          // React 完成事件分发后会清空 currentTarget；先读取勾选值，避免延迟状态计算访问失效事件并触发界面崩溃。
                                          const checked = event.currentTarget.checked;
                                          setSelectedProjectRepositoryPaths((current) => (checked ? Array.from(new Set([...current, candidate.localPath])) : current.filter((path) => path !== candidate.localPath)));
                                        }}
                                        disabled={projectWorkspaceConfigStatus === 'saving'}
                                      />
                                      <span>
                                        <strong>{candidate.name}</strong>
                                        <small>
                                          {candidate.relativePath} · {candidate.branch || 'detached'} · {candidate.remotes.length > 0 ? candidate.remotes.join(', ') : '无远端'}
                                        </small>
                                      </span>
                                    </label>
                                  ))}
                                </fieldset>
                              ) : projectWorkspaceConfigStatus !== 'loading' ? (
                                <small>未发现 Git 仓库；任务会直接使用项目目录，不检出分支。</small>
                              ) : null}
                              <label className="project-shared-paths-field">
                                <span>共享可写目录</span>
                                <textarea
                                  value={projectSharedWritablePaths}
                                  onChange={(event) => setProjectSharedWritablePaths(event.currentTarget.value)}
                                  placeholder={`${selectedProject.localPath}/docs`}
                                  disabled={projectWorkspaceConfigStatus === 'saving'}
                                />
                                <small>每行一个目录。任务环境会直接写入这些真实目录，例如父级 docs；它们不参与 Git 隔离。</small>
                              </label>
                              {projectWorkspaceConfigError ? (
                                <p className="task-model-push-error" role="alert">
                                  {projectWorkspaceConfigError}
                                </p>
                              ) : null}
                              <div className="project-config-command-rail">
                                <button
                                  type="button"
                                  onClick={() => void loadProjectWorkspaceConfig(selectedProject.id)}
                                  disabled={!props.nativeConversationClient || projectWorkspaceConfigStatus === 'loading' || projectWorkspaceConfigStatus === 'saving'}
                                >
                                  重新发现
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void saveProjectWorkspaceConfig(selectedProject.id)}
                                  disabled={!props.nativeConversationClient || projectWorkspaceConfigStatus === 'loading' || projectWorkspaceConfigStatus === 'saving'}
                                >
                                  {projectWorkspaceConfigStatus === 'saving' ? '正在保存…' : '保存任务工作区'}
                                </button>
                              </div>
                            </div>
                          </section>
                          {/* 项目配置字段拆成说明列和控件列，保留 form 提交语义，但不再把字段直接堆成 label 列表。 */}
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.defaultModelAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.defaultModelTitle}</strong>
                              <small>{projectConfigCopy.defaultModelHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input aria-label={projectConfigCopy.defaultModelAria} value={projectConfigForm.defaultModel} onChange={(event) => patchProjectConfigForm({ defaultModel: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.defaultWorkModeAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.defaultWorkModeTitle}</strong>
                              <small>{projectConfigCopy.defaultWorkModeHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <ZeusSelect
                                size="roomy"
                                ariaLabel={projectConfigCopy.defaultWorkModeAria}
                                value={projectConfigForm.defaultWorkMode}
                                onChange={(value) => patchProjectConfigForm({ defaultWorkMode: value })}
                                searchPlaceholder={selectSearchPlaceholder}
                                emptyLabel={selectNoResults}
                                options={workModeValues.map((mode) => ({
                                  value: mode,
                                  label: uiCopy.workModes[mode],
                                }))}
                              />
                            </span>
                          </section>
                          <section className="project-config-setting-row project-config-textarea-row" aria-label={projectConfigCopy.defaultTaskPromptAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.defaultTaskPromptTitle}</strong>
                              <small>{projectConfigCopy.defaultTaskPromptHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <textarea aria-label={projectConfigCopy.defaultTaskPromptAria} value={projectConfigForm.defaultTaskPrompt} onChange={(event) => patchProjectConfigForm({ defaultTaskPrompt: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.scanIgnoreAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.scanIgnoreTitle}</strong>
                              <small>{projectConfigCopy.scanIgnoreHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input aria-label={projectConfigCopy.scanIgnoreAria} value={projectConfigForm.scanIgnoreDirectories} onChange={(event) => patchProjectConfigForm({ scanIgnoreDirectories: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.indexScopeAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.indexScopeTitle}</strong>
                              <small>{projectConfigCopy.indexScopeHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <ZeusSelect
                                size="roomy"
                                ariaLabel={projectConfigCopy.indexScopeAria}
                                value={projectConfigForm.indexScope}
                                onChange={(value) => patchProjectConfigForm({ indexScope: value })}
                                searchPlaceholder={selectSearchPlaceholder}
                                emptyLabel={selectNoResults}
                                options={[
                                  { value: 'project', label: projectConfigCopy.indexScopeOptions.project },
                                  { value: 'src', label: projectConfigCopy.indexScopeOptions.src },
                                  { value: 'custom', label: projectConfigCopy.indexScopeOptions.custom },
                                ]}
                              />
                            </span>
                          </section>
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.primaryLanguageAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.primaryLanguageTitle}</strong>
                              <small>{projectConfigCopy.primaryLanguageHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input aria-label={projectConfigCopy.primaryLanguageAria} value={projectConfigForm.languagePrimary} onChange={(event) => patchProjectConfigForm({ languagePrimary: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.additionalLanguagesAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.additionalLanguagesTitle}</strong>
                              <small>{projectConfigCopy.additionalLanguagesHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input aria-label={projectConfigCopy.additionalLanguagesAria} value={projectConfigForm.languageAdditional} onChange={(event) => patchProjectConfigForm({ languageAdditional: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.packageManagersAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.packageManagersTitle}</strong>
                              <small>{projectConfigCopy.packageManagersHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input aria-label={projectConfigCopy.packageManagersAria} value={projectConfigForm.packageManagers} onChange={(event) => patchProjectConfigForm({ packageManagers: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.manifestPathsAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.manifestPathsTitle}</strong>
                              <small>{projectConfigCopy.manifestPathsHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input aria-label={projectConfigCopy.manifestPathsAria} value={projectConfigForm.manifestPaths} onChange={(event) => patchProjectConfigForm({ manifestPaths: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.databaseConnectionAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.databaseConnectionTitle}</strong>
                              <small>{projectConfigCopy.databaseConnectionHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input
                                aria-label={projectConfigCopy.databaseConnectionAria}
                                value={projectConfigForm.databaseConnectionName}
                                onChange={(event) => patchProjectConfigForm({ databaseConnectionName: event.currentTarget.value })}
                              />
                            </span>
                          </section>
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.schemaPathsAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.schemaPathsTitle}</strong>
                              <small>{projectConfigCopy.schemaPathsHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input aria-label={projectConfigCopy.schemaPathsAria} value={projectConfigForm.databaseSchemaPaths} onChange={(event) => patchProjectConfigForm({ databaseSchemaPaths: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-config-setting-row" aria-label={projectConfigCopy.telegramAliasAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.telegramAliasTitle}</strong>
                              <small>{projectConfigCopy.telegramAliasHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input aria-label={projectConfigCopy.telegramAliasAria} value={projectConfigForm.telegramAlias} onChange={(event) => patchProjectConfigForm({ telegramAlias: event.currentTarget.value })} />
                            </span>
                          </section>
                          <section className="project-config-setting-row project-config-toggle-row" aria-label={projectConfigCopy.allowShellAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.allowShellTitle}</strong>
                              <small>{projectConfigCopy.allowShellHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input aria-label={projectConfigCopy.allowShellAria} type="checkbox" checked={projectConfigForm.allowShell} onChange={(event) => patchProjectConfigForm({ allowShell: event.currentTarget.checked })} />
                            </span>
                          </section>
                          <section className="project-config-setting-row project-config-toggle-row" aria-label={projectConfigCopy.allowGitWriteAria}>
                            <span className="project-config-setting-copy">
                              <strong>{projectConfigCopy.allowGitWriteTitle}</strong>
                              <small>{projectConfigCopy.allowGitWriteHelp}</small>
                            </span>
                            <span className="project-config-setting-field">
                              <input aria-label={projectConfigCopy.allowGitWriteAria} type="checkbox" checked={projectConfigForm.allowGitWrite} onChange={(event) => patchProjectConfigForm({ allowGitWrite: event.currentTarget.checked })} />
                            </span>
                          </section>
                          <div className="project-config-state-row" aria-label={projectConfigCopy.databaseStateAria}>
                            <strong>{projectConfigCopy.databaseTitle}</strong>
                            <span>{formatProjectDatabase(projectConfigForm, projectConfigCopy)}</span>
                            <em>{formatProjectDatabaseHelp(projectConfigForm, projectConfigCopy)}</em>
                          </div>
                          {projectDatabaseSecret ? (
                            <div className="project-config-state-row" aria-label={projectConfigCopy.passwordStateAria}>
                              <strong>{projectConfigCopy.passwordTitle}</strong>
                              {/* 敏感状态只消费 configured 结构化事实，避免后端 label 语言或密钥提示泄漏到当前 UI。 */}
                              <span>{projectDatabaseSecret.password.configured ? projectConfigCopy.passwordConfigured : projectConfigCopy.passwordNotConfigured}</span>
                              <em>{projectConfigCopy.passwordHelp}</em>
                            </div>
                          ) : null}
                          <div className="project-config-command-rail">
                            <button type="submit" disabled={!props.onSaveProjectConfig || creatingProjectBusy} {...controlBusyProps(creatingProjectBusy)}>
                              {projectConfigCopy.save}
                            </button>
                          </div>
                        </form>
                      ) : null}

                      {projectPanel === 'archive' ? (
                        <ProjectArchiveWorkbench
                          projects={archivedProjects}
                          copy={codeWorkspaceCopy.projectArchive}
                          codeCopy={codeWorkspaceCopy}
                          onRefresh={refreshArchivedProjects}
                          refreshDisabled={!props.onLoadArchivedProjects}
                          onRestore={restoreProject}
                        />
                      ) : null}
                    </WorkspaceDrawer>
                  ) : null}
                </div>
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

        {activeNavTarget !== 'settings' && (activeProjectSection === 'tasks' || activeProjectSection === 'sessions') ? (
          <section
            className={`workspace-view ${activeProjectSection === 'tasks' ? 'workspace-view-project-tasks' : 'workspace-view-project-sessions'}`}
            aria-label={activeProjectSection === 'tasks' ? taskWorkspaceCopy.viewAria : sessionWorkspaceCopy.viewAria}
          >
            {activeProjectSection === 'sessions' ? (
              <aside
                id="session-project-conversation-list"
                ref={sessionSourceRailRef}
                className="workspace-list-pane session-list-pane"
                aria-label={sessionWorkspaceCopy.listAria}
                aria-hidden={compactSessionViewport && !sessionSourceRailOpen ? true : undefined}
                aria-modal={compactSessionViewport && sessionSourceRailOpen ? true : undefined}
                role={compactSessionViewport && sessionSourceRailOpen ? 'dialog' : undefined}
                inert={compactSessionViewport && !sessionSourceRailOpen ? true : undefined}
                tabIndex={-1}
                onKeyDownCapture={(event) => {
                  if (!compactSessionViewport || !sessionSourceRailOpen) return;
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setSessionSourceRailOpen(false);
                    sessionSourceRailTriggerRef.current?.focus();
                    return;
                  }
                  if (event.key !== 'Tab') return;
                  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')).filter((element) => !element.hidden);
                  if (focusable.length === 0) {
                    event.preventDefault();
                    event.currentTarget.focus();
                    return;
                  }
                  const first = focusable[0];
                  const last = focusable[focusable.length - 1];
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                  }
                }}
              >
                <ProjectConversationTree
                  groups={nativeConversationGroups.filter((group) => group.projectId === activeProjectId)}
                  selectedConversationId={selectedNativeConversationId}
                  conversationStates={nativeConversationRuntimeStates}
                  onSelectConversation={(conversation) => {
                    selectNativeConversation(conversation);
                    setSessionSourceRailOpen(false);
                  }}
                  onStartConversation={(taskId) => {
                    prepareNativeConversationForTask(taskId);
                    setSessionSourceRailOpen(false);
                  }}
                  language={appShellSettings.appLanguage}
                />
              </aside>
            ) : null}
            <section
              className={`workspace-detail-pane ${activeProjectSection === 'tasks' ? 'task-management-detail-pane' : 'conversation-detail-pane'}`}
              aria-label={activeProjectSection === 'tasks' ? taskWorkspaceCopy.detailAria : sessionWorkspaceCopy.detailAria}
            >
              {activeProjectSection === 'tasks' ? (
                <>
                  {/* 任务页首屏只保留任务表格，任务列表保持完整宽度；任务详情通过透明点击层上的右侧悬浮抽屉展开，点击抽屉外空白处即可关闭。 */}
                  <TaskWorkspace
                    projectName={selectedProject?.name}
                    tasks={currentProjectTasks}
                    selectedTaskId={taskDetailPaneTaskId}
                    selectedTaskIds={selectedTaskIds}
                    searchQuery={taskSearchQuery}
                    statusFilter={taskStatusFilter}
                    tagFilter={taskTagFilter}
                    statusOptions={taskStatusFilterValues}
                    statusLabels={taskManagementStatusLabels[appShellSettings.appLanguage]}
                    runStatusLabels={taskAgentRunStatusLabels[appShellSettings.appLanguage]}
                    copy={taskWorkspaceCopy}
                    appLanguage={appShellSettings.appLanguage}
                    runtime={runtime}
                    runtimeSessions={runtimeSessions}
                    taskConversations={currentTaskConversationChoices}
                    conversationRunStatuses={nativeConversationTaskRunStatuses}
                    taskTableColumns={activeTaskTableColumns}
                    taskTableEnumSortOrders={appShellSettings.taskTableEnumSortOrders}
                    taskTableLayoutDirty={taskTableLayoutDirty}
                    creatingTaskBusy={creatingTaskBusy}
                    bulkActionBusy={updatingTaskBusy}
                    statusChangeBusy={updatingTaskBusy}
                    bulkActionStatus={taskBulkActionStatus}
                    listState={!props.snapshot ? 'loading' : 'ready'}
                    activeProjectId={activeProjectId}
                    onSearchChange={setTaskSearchQuery}
                    onStatusFilterChange={(filter) => void saveTaskStatusFilter(filter)}
                    onTagFilterChange={setTaskTagFilter}
                    onTaskTableColumnsChange={(preferences) => setTaskTableLayoutDraft({ projectId: activeProjectId, preferences })}
                    onSaveTaskTableLayout={() => setTaskTableLayoutScopeDialogOpen(true)}
                    onCreateTask={openTaskCreateModal}
                    onOpenTaskDetail={(taskId) => void openTaskDetailPane(taskId)}
                    onToggleTaskSelection={toggleTaskSelection}
                    onToggleAllVisibleTaskSelection={toggleAllVisibleTaskSelection}
                    onClearTaskSelection={clearTaskSelection}
                    onTaskStatusChange={(taskId, targetStatus) => void updateTaskManagementStatus(taskId, targetStatus).catch(() => undefined)}
                    onBulkTaskStatusChange={(targetStatus, taskIds) => void runBulkTaskStatusChange(targetStatus, taskIds)}
                    onBulkTaskDelete={(taskIds) => void runBulkTaskDelete(taskIds)}
                    onRetryTaskList={
                      props.onLoadTasks && activeProjectId ? () => void props.onLoadTasks?.(activeProjectId, taskSearchQuery, taskStatusFilter && taskStatusFilter !== 'unfinished' ? taskStatusFilter : undefined, taskTagFilter) : undefined
                    }
                    onOpenProjectSettings={selectedProject ? () => openProjectSection(selectedProject, 'project-settings') : undefined}
                    onOpenProjectCode={selectedProject ? () => openProjectSection(selectedProject, 'code') : undefined}
                    controlBusyProps={controlBusyProps}
                  />
                  <TaskCreateModal
                    open={taskCreateModalOpen}
                    copy={taskWorkspaceCopy}
                    form={taskCreateForm}
                    error={taskCreateError}
                    busy={creatingTaskBusy}
                    titleInputRef={taskCreateTitleInputRef}
                    onFormChange={updateTaskCreateForm}
                    onPriorityChange={updateTaskCreatePriority}
                    onChooseAttachments={() => void chooseTaskCreateAttachments()}
                    onAuthorizeFiles={authorizeTaskCreateFiles}
                    onMaterializeResources={materializeTaskCreateResources}
                    onReadClipboardResources={readTaskCreateClipboardResources}
                    onAddAttachments={addTaskCreateAttachments}
                    onLoadAttachmentPreview={props.onLoadTaskAttachmentPreview}
                    onOpenAttachment={props.onOpenTaskAttachment}
                    onRemoveAttachment={removeTaskCreateAttachment}
                    onClose={closeTaskCreateModal}
                    onSubmit={(event) => void submitTaskCreateModal(event)}
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
                  <TaskModelPushModal
                    open={Boolean(taskModelPushTaskId)}
                    language={appShellSettings.appLanguage}
                    task={snapshot.tasks.find((task) => task.id === taskModelPushTaskId) ?? null}
                    projectName={snapshot.projects.find((project) => project.id === snapshot.tasks.find((task) => task.id === taskModelPushTaskId)?.projectId)?.name}
                    capabilities={taskModelPushCapabilities}
                    form={taskModelPushForm}
                    status={taskModelPushStatus}
                    error={taskModelPushError}
                    onChange={setTaskModelPushForm}
                    onClose={closeTaskModelPush}
                    onSubmit={(event) => void submitTaskModelPush(event)}
                    onLoadAttachmentPreview={props.onLoadTaskAttachmentPreview}
                    onOpenAttachment={props.onOpenTaskAttachment}
                  />
                  <TaskGitMergeModal
                    open={Boolean(taskGitMergeTaskId)}
                    language={appShellSettings.appLanguage}
                    task={snapshot.tasks.find((task) => task.id === taskGitMergeTaskId) ?? null}
                    projectName={snapshot.projects.find((project) => project.id === snapshot.tasks.find((task) => task.id === taskGitMergeTaskId)?.projectId)?.name}
                    client={props.nativeConversationClient ?? null}
                    onChanged={() =>
                      taskGitMergeTaskId
                        ? Promise.all([
                            refreshNativeConversationChoices(taskGitMergeTaskId),
                            props.onLoadTaskEvents && taskDetailPaneTaskId === taskGitMergeTaskId ? props.onLoadTaskEvents(taskGitMergeTaskId).then(setTaskEvents) : Promise.resolve(),
                          ]).then(() => undefined)
                        : Promise.resolve()
                    }
                    onClose={() => setTaskGitMergeTaskId(null)}
                  />
                  {taskDetailPaneTask ? (
                    <WorkspaceDrawer
                      presentation="floating"
                      backdrop="dimmed"
                      size="standard"
                      label={taskWorkspaceCopy.detailPaneLabel}
                      backdropLabel={taskWorkspaceCopy.detailPaneBackdrop}
                      closeLabel={taskWorkspaceCopy.detailPaneClose}
                      className="task-detail-floating-drawer"
                      portalStyle={workspaceDrawerPortalStyle}
                      onClose={() => setTaskDetailPaneTaskId(undefined)}
                    >
                      <TaskDetailPaneContent
                        language={appShellSettings.appLanguage}
                        task={taskDetailPaneTask}
                        events={taskEvents.filter((event) => event.taskId === taskDetailPaneTask.id)}
                        copy={taskWorkspaceCopy}
                        statusLabels={taskManagementStatusLabels[appShellSettings.appLanguage]}
                        eventTypeLabels={uiCopy.taskEventTypeLabels}
                        priorityOptions={taskWorkspaceCopy.taskCreatePriorityOptions}
                        busy={updatingTaskBusy}
                        conversations={taskDetailPaneConversations}
                        conversationsLoading={taskDetailPaneConversationState?.status === 'loading' && !taskDetailPaneConversationState.choicesKnown}
                        conversationsError={taskDetailPaneConversationState?.status === 'error' ? taskDetailPaneConversationState.error : null}
                        onOpenConversation={(taskId, conversationId) => void openTaskConversation(taskId, conversationId)}
                        onPushNewConversation={(taskId) => void openTaskModelPush(taskId)}
                        onOpenCodeDelivery={(taskId) => setTaskGitMergeTaskId(taskId)}
                        onCommitCode={(taskId) => setTaskGitReviewState({ taskId, mode: 'commit-only' })}
                        onPushCode={(taskId) => setTaskGitReviewState({ taskId, mode: 'push-only' })}
                        onUpdateTaskContent={updateTaskContent}
                        onManagementStatusChange={(taskId, status, expectedUpdatedAt) => updateTaskManagementStatus(taskId, status, { expectedUpdatedAt })}
                        onChooseAttachments={props.onChooseTaskAttachments}
                        onReloadConversations={(taskId) => void refreshNativeConversationChoices(taskId)}
                        onLoadAttachmentPreview={props.onLoadTaskAttachmentPreview}
                        onOpenAttachment={props.onOpenTaskAttachment}
                      />
                    </WorkspaceDrawer>
                  ) : null}
                </>
              ) : taskModelPushPending && taskModelPushPending.status !== 'accepted' && selectedNativeConversation?.id === taskModelPushPending.choice.id ? (
                <TaskModelPushPendingWorkspace language={appShellSettings.appLanguage} pending={taskModelPushPending} onRetry={retryTaskModelPush} />
              ) : selectedNativeConversation && props.nativeConversationClient && selectedNativeConversation.transportKind === 'codex_native' && !selectedNativeConversation.readOnly && nativeSessionOwner ? (
                <ConnectedSessionWorkspace
                  key={selectedNativeConversation.id}
                  language={appShellSettings.appLanguage}
                  client={props.nativeConversationClient}
                  conversation={selectedNativeConversation}
                  task={nativeSessionTask}
                  owner={nativeSessionOwner}
                  choices={nativeSessionChoices}
                  initialOptimisticState={taskModelPushPending?.status === 'accepted' && taskModelPushPending.choice.id === selectedNativeConversation.id ? taskModelPushPending.session : undefined}
                  onChooseAttachments={props.onChooseConversationResources ? chooseNativeConversationAttachments : undefined}
                  onStateChange={(conversationId, state) => {
                    recordNativeConversationRuntimeState(conversationId, state);
                    if (taskModelPushPending?.status === 'accepted' && taskModelPushPending.choice.id === conversationId && selectHasConfirmedUserMessage(state, taskModelPushPending.request.clientUserMessageId)) {
                      writeTaskModelPushPreferences(browserNativeConversationStartStorage(), taskModelPushPending.task.projectId, taskModelPushPending.form);
                      writeProjectServiceTierPreference(browserNativeConversationStartStorage(), taskModelPushPending.task.projectId, taskModelPushPending.form.serviceTier);
                      setTaskModelPushPending(null);
                    }
                    const pendingPreference = pendingProjectServiceTierPreferencesRef.current.get(conversationId);
                    if (pendingPreference && selectHasConfirmedUserMessage(state, pendingPreference.clientUserMessageId)) {
                      writeProjectServiceTierPreference(browserNativeConversationStartStorage(), pendingPreference.projectId, pendingPreference.selection);
                      pendingProjectServiceTierPreferencesRef.current.delete(conversationId);
                    }
                  }}
                  onStartConversation={startNativeConversation}
                  onStartProjectConversation={startProjectConversation}
                />
              ) : (
                <SessionWorkspace
                  key={`new-conversation-${nativeSessionOwner?.kind ?? 'none'}-${nativeSessionOwner?.kind === 'task' ? nativeSessionOwner.taskId : (nativeSessionOwner?.projectId ?? 'none')}-${newConversationFocusRequest}`}
                  language={appShellSettings.appLanguage}
                  state={null}
                  conversation={selectedNativeConversation}
                  task={nativeSessionTask}
                  owner={nativeSessionOwner}
                  tasks={currentProjectTasks.map((task) => ({ id: task.id, projectId: task.projectId, title: task.title }))}
                  choices={nativeSessionChoices}
                  autoFocusNewConversation={conversationDraftOpen}
                  legacyMessages={nativeLegacyMessages}
                  choicesKnown={
                    selectedNativeConversation && (selectedNativeConversation.readOnly || selectedNativeConversation.transportKind !== 'codex_native')
                      ? true
                      : props.nativeConversationClient
                        ? (nativeSessionChoiceTaskState?.choicesKnown ?? false)
                        : true
                  }
                  loadState={
                    selectedNativeConversation && (selectedNativeConversation.readOnly || selectedNativeConversation.transportKind !== 'codex_native')
                      ? nativeLegacyMessageLoadState
                      : props.nativeConversationClient
                        ? nativeSessionChoiceTaskState?.status === 'ready'
                          ? 'empty'
                          : (nativeSessionChoiceTaskState?.status ?? 'loading')
                        : 'empty'
                  }
                  loadError={selectedNativeConversation && (selectedNativeConversation.readOnly || selectedNativeConversation.transportKind !== 'codex_native') ? nativeLegacyMessageError : nativeSessionChoiceTaskState?.error}
                  actions={{
                    onStartConversation: startNativeConversation,
                    onStartProjectConversation: startProjectConversation,
                    onLoadCapabilities: props.nativeConversationClient?.loadCodexConversationCapabilities,
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
              )}

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
                            {!runtimeLogsCollapsed ? (
                              runtimeLogs
                                .filter((entry) => runtimeLogMatches(entry, runtimeLogSearchQuery))
                                .slice(-8)
                                .map((entry) => {
                                  const tone = classifyRuntimeLog(entry);
                                  return (
                                    <code className={`runtime-log-line ${tone}`} key={entry.id}>
                                      {formatRuntimeLogLine(entry)}
                                    </code>
                                  );
                                })
                            ) : (
                              <span>{sessionWorkspaceCopy.runtimeDrawer.collapsedLogs}</span>
                            )}
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
          onReadyToCloseTask={(status) => (taskGitReviewState ? updateTaskManagementStatus(taskGitReviewState.taskId, status, { skipGitReview: true }).then(() => undefined) : Promise.resolve())}
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
                        ['tasks', settingsWorkspaceCopy.categories.tasks, undefined],
                        ['security', settingsWorkspaceCopy.categories.security, settingsWorkspaceCopy.protectedStatus],
                      ],
                    },
                    {
                      group: settingsWorkspaceCopy.sectionGroups.integrations,
                      items: [
                        ['runtime', settingsWorkspaceCopy.categories.runtime, runtime.aiCli.available ? settingsWorkspaceCopy.protectedStatus : settingsWorkspaceCopy.waitingStatus],
                        ['browser', settingsWorkspaceCopy.categories.browser, settingsWorkspaceCopy.localStatus],
                        ['telegram', settingsWorkspaceCopy.categories.telegram, runtime.telegram.enabled ? settingsWorkspaceCopy.protectedStatus : settingsWorkspaceCopy.waitingStatus],
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
                {settingsCategory === 'tasks' ? (
                  <section className="settings-product-pane task-list-settings-pane" aria-label={settingsWorkspaceCopy.categories.tasks}>
                    <h2 className="settings-page-title">{settingsWorkspaceCopy.categories.tasks}</h2>
                    <section className="settings-product-section" aria-labelledby="task-list-sort-settings-title">
                      <header className="settings-section-heading">
                        <strong id="task-list-sort-settings-title">{appShellSettings.appLanguage === 'zh-CN' ? '枚举值升序规则' : 'Enum ascending order'}</strong>
                        <span>
                          {appShellSettings.appLanguage === 'zh-CN'
                            ? '拖动定义升序；降序会反转该顺序，空值始终排在最后。此设置对所有项目生效。'
                            : 'Drag to define ascending order. Descending reverses it, while empty values always stay last. This applies to every project.'}
                        </span>
                      </header>
                      <div className="task-enum-order-grid">
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
                          title={appShellSettings.appLanguage === 'zh-CN' ? '管理状态' : 'Management status'}
                          description={appShellSettings.appLanguage === 'zh-CN' ? '任务交付阶段顺序' : 'Task delivery stage order'}
                          items={taskTableEnumSortOrders.managementStatus.map((value) => ({ value, label: taskManagementStatusLabels[appShellSettings.appLanguage][value] }))}
                          onChange={(managementStatus) =>
                            setAppShellSettings((current) => ({
                              ...current,
                              taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders({ ...current.taskTableEnumSortOrders, managementStatus }),
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
                      <section className="settings-state-row settings-runtime-concurrency-state-row" aria-label={settingsWorkspaceCopy.runtime.concurrencyAria}>
                        <strong>{settingsWorkspaceCopy.runtime.concurrencyTitle}</strong>
                        <span>{runtimeSettings.concurrency.maxPerProject}</span>
                        <em>{settingsWorkspaceCopy.runtime.globalConcurrency(runtimeSettings.concurrency.maxGlobal)}</em>
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
                    <LegacyChatImportSettings
                      language={appShellSettings.appLanguage}
                      snapshot={codexLegacyImportSnapshot}
                      loading={codexLegacyImportLoading}
                      busy={codexLegacyImportBusy}
                      error={codexLegacyImportError}
                      onRefresh={refreshCodexLegacyImports}
                      onImport={startCodexLegacyImport}
                    />
                  </section>
                ) : null}
                {settingsCategory === 'browser' ? <BrowserSettingsPane language={appShellSettings.appLanguage} /> : null}
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
                            {/* 更新状态来自真实 Release 检查结果；未签名/未公证时只引导打开下载页，不伪装自动安装可用。 */}
                            <span>{formatReleaseUpdateLabel(releaseUpdateStatus, settingsWorkspaceCopy.release)}</span>
                            <small>{settingsWorkspaceCopy.release.installHelp(releaseUpdateStatus.automaticInstallEnabled)}</small>
                          </span>
                          <span className="release-update-command-rail">
                            <button type="button" onClick={() => void checkReleaseUpdate(false)} disabled={!props.onCheckReleaseUpdate || releaseUpdateBusy} {...controlBusyProps(releaseUpdateBusy)}>
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
                          <button type="button" onClick={clearLocalCaches} disabled={!props.onClearLocalCaches || loadingRuntimeBusy} {...controlBusyProps(loadingRuntimeBusy)}>
                            {settingsWorkspaceCopy.data.clearCache}
                          </button>
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

export const GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE = 'ZEUS HIGH RISK';

export type GenericShellCommandRiskLevel = 'empty' | 'medium' | 'critical';

export interface GenericShellCommandRisk {
  level: GenericShellCommandRiskLevel;
  /** 风险标签只保存稳定状态码，真正展示文案必须走当前语言 copy 域。 */
  label: string;
  /** 风险原因只保存稳定状态码，避免英文界面混入中文状态值。 */
  reason: string;
}

/** 对 Generic shell 命令做本地静态风险提示；只用于提示和确认文案，不替代后端确认与审计。 */
export function classifyGenericShellCommandRisk(command: string): GenericShellCommandRisk {
  const normalized = command.trim().toLowerCase();
  if (!normalized)
    return {
      level: 'empty',
      label: 'generic_shell.risk.empty',
      reason: 'generic_shell.reason.empty',
    };
  const criticalPatterns = [
    /\brm\s+.*(-rf|-fr|-r)\b/,
    /\b(sudo\s+)?rm\s+.*\//,
    /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/,
    /\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/,
    /\bdd\s+.*\bof=/,
    /\bchmod\s+-r\s+777\b/,
    /\bmkfs\b/,
    /:\(\)\s*\{\s*:\|:\s*&\s*}\s*;/,
  ];
  if (criticalPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      level: 'critical',
      label: 'generic_shell.risk.critical',
      reason: 'generic_shell.reason.critical_pattern',
    };
  }
  return {
    level: 'medium',
    label: 'generic_shell.risk.medium',
    reason: 'generic_shell.reason.requires_confirmation',
  };
}

export interface GitOperationExecutionForm {
  branchName?: string;
  baseRef?: string;
  stashRef?: string;
  remote?: string;
  targetRef?: string;
}

/** 从已确认记录和专用表单构造白名单 Git 执行请求；不允许用户输入任意 git 子命令。 */
export function buildGitOperationExecutionInput(confirmation: GitOperationConfirmation, form: GitOperationExecutionForm = {}): ExecuteGitOperationRequest {
  const input: ExecuteGitOperationRequest = {
    confirmationId: confirmation.id,
    operation: confirmation.operation,
  };
  if (confirmation.operation === 'commit') input.message = confirmation.message;
  if (confirmation.operation === 'stash') input.message = confirmation.message ?? confirmation.reason;
  if (confirmation.operation === 'branch' || confirmation.operation === 'switch_branch') input.branchName = form.branchName;
  if (confirmation.operation === 'branch' && form.baseRef?.trim()) input.baseRef = form.baseRef;
  if (confirmation.operation === 'apply_stash') input.stashRef = form.stashRef;
  if (confirmation.operation === 'pull' || confirmation.operation === 'push') {
    input.remote = form.remote;
    input.targetRef = form.targetRef;
  }
  if (confirmation.operation === 'rollback') input.targetRef = form.targetRef;
  return input;
}

export function buildGitDiffReviewSummary(diff: GitDiffSummary, appLanguage: AppLanguage = 'zh-CN'): string {
  const hunkCount = diff.fileDiffs?.reduce((total, file) => total + file.hunks.length, 0) ?? 0;
  const addedLines = diff.fileDiffs?.reduce((total, file) => total + file.addedLines, 0) ?? 0;
  const deletedLines = diff.fileDiffs?.reduce((total, file) => total + file.deletedLines, 0) ?? 0;
  return getLanguageCopy(appLanguage).gitDiffWorkspace.reviewSummary(diff.files.length, hunkCount, addedLines, deletedLines);
}

export function buildGitDiffDecisionSummary(diff: GitDiffSummary, decisions: Record<string, 'accepted' | 'rejected'>, appLanguage: AppLanguage = 'zh-CN'): string {
  let accepted = 0;
  let rejected = 0;
  let total = 0;
  for (const file of diff.fileDiffs ?? []) {
    for (const hunk of file.hunks) {
      total += 1;
      const decision = decisions[buildGitHunkReviewKey(file, hunk)];
      if (decision === 'accepted') accepted += 1;
      if (decision === 'rejected') rejected += 1;
    }
  }
  const pending = Math.max(total - accepted - rejected, 0);
  return getLanguageCopy(appLanguage).gitDiffWorkspace.decisionSummary(accepted, rejected, pending);
}

function buildGitHunkReviewKey(file: { oldPath: string; newPath: string }, hunk: GitDiffHunk): string {
  return `${file.oldPath}->${file.newPath}:${hunk.header}`;
}

/** 使用固定 UTC 格式展示 Git 确认过期时间，避免本地时区差异让审查口径不一致。 */
function formatGitConfirmationExpiry(expiresAt: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) return getLanguageCopy(appLanguage).gitDiffWorkspace.unknownExpiry;
  return `${parsed.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** Git 确认状态来自安全确认记录，渲染时按当前 UI 语言格式化，避免 pending 这类内部状态直出。 */
function formatGitConfirmationStatus(status: GitOperationConfirmation['status'], appLanguage: AppLanguage = 'zh-CN'): string {
  const labels = getLanguageCopy(appLanguage).gitDiffWorkspace.confirmationStatusLabels;
  return labels[status] ?? status;
}

/** Git 写操作标签只用于安全确认后的 UI 展示，不反推任何命令参数。 */
function formatGitOperationLabel(operation: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const labels: Record<string, string> = getLanguageCopy(appLanguage).gitDiffWorkspace.operationLabels;
  return labels[operation] ?? operation;
}

/** 图谱问答会话状态来自存储枚举，渲染时按当前 UI 语言格式化，未知状态保留原始事实。 */
function formatGraphConversationStatus(status: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const labels: Record<string, string> = getLanguageCopy(appLanguage).codeMapWorkspace.conversationStatusLabels;
  return labels[status] ?? status;
}

/** 图谱问答消息来源是内部来源枚举，渲染时按当前 UI 语言格式化；未知来源保留原始事实便于追溯。 */
function formatGraphMessageSource(source: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const labels: Record<string, string> = getLanguageCopy(appLanguage).codeMapWorkspace.messageSourceLabels;
  return labels[source] ?? source;
}

/** 图谱节点类型是搜索和布局使用的结构化枚举，展示时按界面语言转换，不改写图谱数据本身。 */
function formatGraphNodeType(nodeType: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const labels: Record<string, string> = getLanguageCopy(appLanguage).graphNodeTypes;
  return labels[nodeType] ?? nodeType;
}

function formatGraphNodeTypeList(nodeTypes: string[], appLanguage: AppLanguage = 'zh-CN'): string {
  return nodeTypes.map((nodeType) => formatGraphNodeType(nodeType, appLanguage)).join(' / ');
}

/** 图谱边类型同样保留原始 API 枚举，只在可读 UI 标签中本地化。 */
function formatGraphEdgeType(edgeType: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const labels: Record<string, string> = getLanguageCopy(appLanguage).graphEdgeTypes;
  return labels[edgeType] ?? edgeType;
}

function formatGraphLayoutAlgorithm(algorithm: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const zhLabels: Record<string, string> = {
    hierarchical: '层级布局',
    force: '力导向布局',
    dagre: 'Dagre 布局',
    'radial-neighborhood': '节点邻域布局',
  };
  const enLabels: Record<string, string> = {
    hierarchical: 'hierarchical layout',
    force: 'force layout',
    dagre: 'Dagre layout',
    'radial-neighborhood': 'node neighborhood layout',
  };
  return appLanguage === 'en-US' ? (enLabels[algorithm] ?? algorithm) : (zhLabels[algorithm] ?? algorithm);
}

/** 图谱风险标签来自扫描/任务写回的结构化枚举；界面显示本地化标签，未知真实标签保留原文便于追溯。 */
function formatGraphRiskTag(tag: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const riskTagLabels: Record<AppLanguage, Record<string, string>> = {
    'zh-CN': {
      task_completed: '任务完成',
      task_failed: '任务失败',
      task_running: '任务运行中',
      task_paused: '任务暂停',
      task_cancelled: '任务取消',
      source_verified: '来源已验证',
      schema_drift: 'Schema 漂移',
      orphan_detected: '孤儿会话',
    },
    'en-US': {
      task_completed: 'Task completed',
      task_failed: 'Task failed',
      task_running: 'Task running',
      task_paused: 'Task paused',
      task_cancelled: 'Task cancelled',
      source_verified: 'Source verified',
      schema_drift: 'Schema drift',
      orphan_detected: 'Orphan detected',
    },
  };
  return riskTagLabels[appLanguage][tag] ?? tag;
}

function formatGraphEdgeWithConfidence(edge: { edgeType: string; confidence: number }, appLanguage: AppLanguage = 'zh-CN'): string {
  return `${formatGraphEdgeType(edge.edgeType, appLanguage)} ${edge.confidence.toFixed(2)}`;
}

function formatGraphRuntimeEdgeLabel(label: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const [edgeType, ...rest] = label.split(/\s+/u);
  if (!edgeType) return label;
  return [formatGraphEdgeType(edgeType, appLanguage), ...rest].join(' ');
}

/** Git clean 状态可能来自旧版本 API，缺失时用 changedFiles 兜底，保持界面向后兼容。 */

/** 将 Git diff 文件变更类型转成稳定中文文案，方便用户按文件审查真实变更。 */

/** 只展示每个 hunk 的前几行真实差异，避免大 diff 让 Dashboard 失控。 */

/** 高危 Generic shell 命令必须有人工输入短语，避免误点直接启动破坏性命令。 */
export function isGenericShellCriticalConfirmationSatisfied(risk: GenericShellCommandRisk, phrase: string): boolean {
  if (risk.level !== 'critical') return true;
  return phrase.trim() === GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE;
}

function formatRuntimeLogLine(entry: AiRuntimeLogEntry): string {
  return `${entry.createdAt} · ${entry.stream}: ${entry.text}`;
}

function runtimeLogMatches(entry: AiRuntimeLogEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${entry.stream} ${entry.text} ${entry.createdAt}`.toLowerCase().includes(normalized);
}

function classifyRuntimeLog(entry: AiRuntimeLogEntry): 'error' | 'command' | 'ai' | 'output' {
  const text = entry.text.trim();
  if (entry.stream === 'stderr' || /(^|\b)(error|failed|exception)(\b|:)/iu.test(text)) return 'error';
  if (entry.stream === 'system' || text.startsWith('$') || text.startsWith('>')) return 'command';
  if (/^(AI|Assistant|Codex):/iu.test(text)) return 'ai';
  return 'output';
}

function toSafeAppShellImport(
  raw: Partial<AppShellSettings> | undefined,
):
  | Pick<
      AppShellSettings,
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
      | 'taskStatusFilterByProject'
    >
  | undefined {
  if (!raw) return undefined;
  return {
    appLanguage: raw.appLanguage === 'en-US' ? 'en-US' : 'zh-CN',
    appearance: raw.appearance === 'light' || raw.appearance === 'dark' || raw.appearance === 'system' ? raw.appearance : 'system',
    webviewDebugEnabled: raw.webviewDebugEnabled === true,
    developerModeEnabled: raw.developerModeEnabled === true,
    multiWindowEnabled: typeof raw.multiWindowEnabled === 'boolean' ? raw.multiWindowEnabled : true,
    backgroundModeEnabled: typeof raw.backgroundModeEnabled === 'boolean' ? raw.backgroundModeEnabled : true,
    desktopNotificationsEnabled: typeof raw.desktopNotificationsEnabled === 'boolean' ? raw.desktopNotificationsEnabled : true,
    openAtLoginEnabled: typeof raw.openAtLoginEnabled === 'boolean' ? raw.openAtLoginEnabled : false,
    autoUpdateChannel: 'manual',
    defaultProjectId: typeof raw.defaultProjectId === 'string' ? raw.defaultProjectId : null,
    pinnedProjectIds: Array.isArray(raw.pinnedProjectIds) ? raw.pinnedProjectIds.filter((id): id is string => typeof id === 'string') : [],
    collapsedProjectIds: Array.isArray(raw.collapsedProjectIds) ? raw.collapsedProjectIds.filter((id): id is string => typeof id === 'string') : [],
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : null,
    defaultTaskTemplateId: typeof raw.defaultTaskTemplateId === 'string' ? raw.defaultTaskTemplateId : null,
    taskTableColumns: normalizeTaskTableColumnPreferences(raw.taskTableColumns),
    taskTableColumnsByProject: Object.fromEntries(Object.entries(raw.taskTableColumnsByProject ?? {}).map(([projectId, preferences]) => [projectId, normalizeTaskTableColumnPreferences(preferences)])),
    taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders(raw.taskTableEnumSortOrders),
    taskStatusFilterByProject: normalizeTaskStatusFilterByProject(raw.taskStatusFilterByProject),
  };
}

function CodeMapView(props: {
  isActive?: boolean;
  graphView: GraphViewSnapshot;
  searchResult?: GraphSearchResult;
  graphAnswer?: GraphQuestionAnswer;
  graphConversations?: GraphConversationHistoryItem[];
  graphConversationPage?: Pick<GraphConversationHistoryPage, 'total' | 'limit' | 'offset' | 'query' | 'archived'>;
  selectedGraphConversation?: GraphConversationHistoryItem;
  graphConversationSearch?: string;
  graphNodeTaskFeedback?: GraphNodeTaskFeedback;
  graphNodeTaskTargetId?: string;
  graphSourceOpenFeedback?: GraphSourceOpenFeedback;
  scanState?: 'idle' | 'scanning' | 'failed';
  onGraphConversationSearchChange?: (query: string) => void;
  onLoadGraphConversations?: (input?: { query?: string; offset?: number; archived?: boolean }) => void;
  onLoadGraphConversation?: (conversationId: string) => void;
  onArchiveGraphConversation?: (conversationId: string) => void;
  onRestoreGraphConversation?: (conversationId: string) => void;
  onCreateTaskFromGraphConversation?: (conversationId: string) => void;
  onLoadView?: (viewType: GraphViewType) => Promise<void>;
  onLoadGraphNeighborhood?: (nodeId: string, depth?: 1 | 2) => Promise<GraphNeighborhood>;
  onSearchGraph?: (query: string, nodeType?: string, edgeType?: string, minConfidence?: number) => void;
  onAskGraph?: (question: string) => void;
  onCreateTaskFromNode?: (nodeId: string) => void;
  onOpenGraphSource?: (source: { sourceRef: string; lineStart?: number }) => void;
  onScanGraph?: () => void;
  onOpenChanges?: () => void;
  onExportMermaidDiagramFile?: (payload: MermaidDiagramExportFile) => Promise<{ saved: boolean; filePath: string | null }>;
  onExportPlantUmlDiagramFile?: (payload: PlantUmlDiagramExportFile) => Promise<{ saved: boolean; filePath: string | null }>;
  codeMapSettings: CodeMapSettings;
  appLanguage: AppLanguage;
}) {
  const uiCopy = getLanguageCopy(props.appLanguage);
  const codeMapCopy = uiCopy.codeMapWorkspace;
  const graphWorkbenchCopy =
    props.appLanguage === 'zh-CN'
      ? {
          viewPicker: '选择图谱视图',
          quickSearch: '搜索节点或关系',
          ask: '询问',
          tools: '图谱工具',
          close: '关闭图谱面板',
          allGraphs: '全部图谱',
          structure: '真实结构',
          scanIdle: '图谱已就绪',
          scanBusy: '正在读取或更新图谱',
          scanFailed: '图谱读取或更新失败',
          currentVisible: '当前可见',
          loadedTotal: '已加载总量',
          relationUnit: '条关系',
          relationGroupUnit: '个关系组',
          nodeUnit: '个节点',
          representedRelations: (count: number) => `表达 ${count} 条原始关系`,
          omittedRelations: (groups: number, relations: number) => `另有 ${groups} 个关系组 / ${relations} 条原始关系未渲染`,
          restoreHidden: '恢复隐藏节点',
          inspectNode: '节点详情',
          inspectEdge: '关系详情',
          focusAll: '全部',
          focusOne: '一跳',
          focusTwo: '两跳',
          focusLabel: '聚焦关系',
          drilldownBack: '返回系统架构图',
          drilldownLoading: (name: string) => `正在生成 ${name} 的节点关系图`,
          drilldownFailed: '节点关系图生成失败，请重试',
          drilldownDepth: '邻域深度',
          drilldownOne: '一跳图',
          drilldownTwo: '两跳图',
          drilldownGraph: '节点关系图',
          openSource: '打开源码',
          askNode: '询问节点',
          createTask: '创建任务',
          hideNode: '隐藏节点',
          rescan: '重新扫描',
          viewChanges: '查看变更',
          toolMenu: '图谱工具菜单',
          canvasHint: '拖动空白处平移，使用控制按钮缩放',
          searchNoMatch: '当前视图没有匹配项，画布已保留原图',
          staticStructure: '静态扫描结构 · 非运行时轨迹',
        }
      : {
          viewPicker: 'Select graph view',
          quickSearch: 'Search nodes or relations',
          ask: 'Ask',
          tools: 'Graph tools',
          close: 'Close graph panel',
          allGraphs: 'All graphs',
          structure: 'Real structure',
          scanIdle: 'Graph ready',
          scanBusy: 'Loading or updating graph',
          scanFailed: 'Graph load or update failed',
          currentVisible: 'Visible',
          loadedTotal: 'Loaded total',
          relationUnit: 'relations',
          relationGroupUnit: 'relation groups',
          nodeUnit: 'nodes',
          representedRelations: (count: number) => `representing ${count} original relation${count === 1 ? '' : 's'}`,
          omittedRelations: (groups: number, relations: number) => `${groups} relation group${groups === 1 ? '' : 's'} / ${relations} original relation${relations === 1 ? '' : 's'} not rendered`,
          restoreHidden: 'Restore hidden nodes',
          inspectNode: 'Node details',
          inspectEdge: 'Relation details',
          focusAll: 'All',
          focusOne: '1 hop',
          focusTwo: '2 hops',
          focusLabel: 'Focus relations',
          drilldownBack: 'Back to system architecture',
          drilldownLoading: (name: string) => `Building the graph around ${name}`,
          drilldownFailed: 'Failed to build the node graph. Try again.',
          drilldownDepth: 'Neighborhood depth',
          drilldownOne: '1-hop graph',
          drilldownTwo: '2-hop graph',
          drilldownGraph: 'Node graph',
          openSource: 'Open source',
          askNode: 'Ask about node',
          createTask: 'Create task',
          hideNode: 'Hide node',
          rescan: 'Rescan',
          viewChanges: 'View changes',
          toolMenu: 'Graph tools menu',
          canvasHint: 'Drag empty canvas to pan and use the controls to zoom',
          searchNoMatch: 'No match in this view; the original graph remains visible',
          staticStructure: 'Static scan structure · not a runtime trace',
        };
  const selectSearchPlaceholder = props.appLanguage === 'zh-CN' ? '搜索选项' : 'Search options';
  const selectNoResults = props.appLanguage === 'zh-CN' ? '没有匹配选项' : 'No matching options';
  const [hiddenNodeIds, setHiddenNodeIds] = useState<string[]>([]);
  const [activeNodeMenuId, setActiveNodeMenuId] = useState<string | null>(null);
  const graphNodeMenuCloseAnimationMs = 120;
  const [closingNodeMenuId, setClosingNodeMenuId] = useState<string | null>(null);
  const graphNodeMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [selectedGraphEdgeId, setSelectedGraphEdgeId] = useState<string | null>(null);
  const [selectedGraphSubject, setSelectedGraphSubject] = useState<'node' | 'edge'>('node');
  const [selectedGraphHopDepth, setSelectedGraphHopDepth] = useState<0 | 1 | 2>(0);
  const [graphDrilldown, setGraphDrilldown] = useState<(GraphNeighborhood & { label: string }) | null>(null);
  const [graphDrilldownStatus, setGraphDrilldownStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [graphDrilldownPendingLabel, setGraphDrilldownPendingLabel] = useState('');
  const [graphDrilldownPendingTarget, setGraphDrilldownPendingTarget] = useState<{ nodeId: string; depth: 1 | 2; label: string } | null>(null);
  const graphDrilldownRequestVersionRef = useRef(0);
  const [showMermaidPreview, setShowMermaidPreview] = useState(false);
  const [diagramExportFormat, setDiagramExportFormat] = useState<'mermaid' | 'plantuml'>('mermaid');
  const [lastMermaidExport, setLastMermaidExport] = useState<ReturnType<typeof buildMermaidDiagramExport> | ReturnType<typeof buildPlantUmlDiagramExport> | null>(null);
  const [mermaidExportStatus, setMermaidExportStatus] = useState<string | null>(null);
  const [graphSearchQuery, setGraphSearchQuery] = useState('');
  const [graphQuestionInput, setGraphQuestionInput] = useState('');
  const [graphNodeTypeFilter, setGraphNodeTypeFilter] = useState('');
  const [graphEdgeTypeFilter, setGraphEdgeTypeFilter] = useState('');
  const [activeGraphTool, setActiveGraphTool] = useState<CodeMapToolPanel | null>(null);
  const [graphToolMenuOpen, setGraphToolMenuOpen] = useState(false);
  const [graphMinConfidence, setGraphMinConfidence] = useState(props.codeMapSettings.showLowConfidenceEdges ? 0 : 1);
  const [isCompactGraphWorkbench, setIsCompactGraphWorkbench] = useState(false);
  const codeMapWorkbenchRef = useRef<HTMLElement | null>(null);
  const graphQuickSearchRef = useRef<HTMLInputElement | null>(null);
  const graphToolMenuRef = useRef<HTMLDivElement | null>(null);
  const graphOverlayRef = useRef<HTMLElement | null>(null);
  const graphOverlayCloseRef = useRef<HTMLButtonElement | null>(null);
  const graphToolTriggerRef = useRef<HTMLButtonElement | null>(null);
  const graphOverlayReturnFocusRef = useRef<HTMLElement | SVGElement | null>(null);
  const graphNodeTaskStatusText =
    props.graphNodeTaskFeedback === 'creating'
      ? codeMapCopy.graphNodeTaskCreating
      : props.graphNodeTaskFeedback === 'created'
        ? codeMapCopy.graphNodeTaskCreated
        : props.graphNodeTaskFeedback === 'failed'
          ? codeMapCopy.graphNodeTaskCreateFailed
          : null;
  const graphSourceOpenStatusText =
    props.graphSourceOpenFeedback === 'opening'
      ? codeMapCopy.graphSourceOpenOpening
      : props.graphSourceOpenFeedback === 'opened'
        ? codeMapCopy.graphSourceOpenOpened
        : props.graphSourceOpenFeedback === 'failed'
          ? codeMapCopy.graphSourceOpenFailed
          : null;

  function retryGraphNodeTask(): void {
    if (!props.graphNodeTaskTargetId) return;
    props.onCreateTaskFromNode?.(props.graphNodeTaskTargetId);
  }

  const filteredGraph = useMemo(() => {
    const hiddenIds = new Set(hiddenNodeIds);
    const minConfidence = normalizeGraphMinConfidence(graphMinConfidence, props.codeMapSettings.showLowConfidenceEdges ? 0 : 1);
    const nodes = props.graphView.nodes.filter((node) => !hiddenIds.has(node.id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = props.graphView.edges.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId) && edge.confidence >= minConfidence);
    return { nodes, edges };
  }, [graphMinConfidence, hiddenNodeIds, props.codeMapSettings.showLowConfidenceEdges, props.graphView.edges, props.graphView.nodes]);
  const searchedGraph = useMemo(() => {
    if (!props.searchResult) return { ...filteredGraph, hasMatches: true };
    const resultNodeIds = new Set(props.searchResult.nodes.map((node) => node.id));
    const resultEdgeIds = new Set(props.searchResult.edges.map((edge) => edge.id));
    const edges = filteredGraph.edges.filter((edge) => resultEdgeIds.has(edge.id));
    const matchedNodeIds = new Set(resultNodeIds);
    for (const edge of edges) {
      matchedNodeIds.add(edge.sourceNodeId);
      matchedNodeIds.add(edge.targetNodeId);
    }
    const nodes = filteredGraph.nodes.filter((node) => matchedNodeIds.has(node.id));
    const hasMatches = nodes.length > 0 || edges.length > 0;
    // 项目级搜索结果必须先和当前视图求交；零命中时保留原图，并在画布上下文明确反馈。
    return hasMatches ? { nodes, edges, hasMatches } : { ...filteredGraph, hasMatches };
  }, [filteredGraph, props.searchResult]);
  const drilldownFilteredGraph = useMemo(() => {
    if (!graphDrilldown) return null;
    const hiddenIds = new Set(hiddenNodeIds);
    const minConfidence = normalizeGraphMinConfidence(graphMinConfidence, props.codeMapSettings.showLowConfidenceEdges ? 0 : 1);
    const nodes = graphDrilldown.nodes.filter((node) => !hiddenIds.has(node.id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = graphDrilldown.edges.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId) && edge.confidence >= minConfidence);
    return { nodes, edges };
  }, [graphDrilldown, graphMinConfidence, hiddenNodeIds, props.codeMapSettings.showLowConfidenceEdges]);
  const searchResultHasCurrentMatches = graphDrilldown || !props.searchResult ? true : searchedGraph.hasMatches;
  const activeGraphScope = drilldownFilteredGraph ?? filteredGraph;
  const defaultVisibleGraph = drilldownFilteredGraph ?? { nodes: searchedGraph.nodes, edges: searchedGraph.edges };
  const focusedGraph = useMemo(
    () =>
      selectedGraphNodeId && selectedGraphHopDepth > 0
        ? buildGraphNeighborhoodSlice({
            nodes: activeGraphScope.nodes,
            edges: activeGraphScope.edges,
            centerNodeId: selectedGraphNodeId,
            depth: selectedGraphHopDepth as 1 | 2,
          })
        : defaultVisibleGraph,
    [activeGraphScope.edges, activeGraphScope.nodes, defaultVisibleGraph, selectedGraphHopDepth, selectedGraphNodeId],
  );
  const visibleGraph = useMemo(
    () =>
      buildVisibleGraphSlice({
        nodes: focusedGraph.nodes,
        edges: focusedGraph.edges,
        hiddenNodeIds: [],
        maxNodes: graphDrilldown ? 18 : 24,
        maxEdges: 80,
        showLowConfidenceEdges: true,
        minConfidence: 0,
      }),
    [focusedGraph.edges, focusedGraph.nodes, graphDrilldown],
  );
  const { nodes: visibleNodes, edges: visibleEdges, stats: visibleGraphStats } = visibleGraph;
  const visibleArchitectureModel = useMemo(
    () => (!graphDrilldown && props.graphView.viewType === 'architecture' ? buildArchitectureLayerModel(visibleNodes, visibleEdges, props.graphView.title) : null),
    [graphDrilldown, props.graphView.title, props.graphView.viewType, visibleEdges, visibleNodes],
  );
  const graphDrilldownLayout = useMemo(() => (graphDrilldown ? buildGraphNeighborhoodLayout(graphDrilldown.centerNode.id, visibleNodes, visibleEdges) : undefined), [graphDrilldown, visibleEdges, visibleNodes]);
  const inspectorGraphView = useMemo(
    () => ({
      ...props.graphView,
      title: graphDrilldown ? `${graphDrilldown.label} · ${graphWorkbenchCopy.drilldownGraph}` : props.graphView.title,
      viewType: graphDrilldown ? 'module_detail' : props.graphView.viewType,
      layout: graphDrilldownLayout ?? props.graphView.layout,
      nodes: activeGraphScope.nodes,
      edges: activeGraphScope.edges,
    }),
    [activeGraphScope.edges, activeGraphScope.nodes, graphDrilldown, graphDrilldownLayout, graphWorkbenchCopy.drilldownGraph, props.graphView],
  );
  const selectedGraphNode = visibleNodes.find((node) => node.id === selectedGraphNodeId);
  const selectedGraphEdge = visibleEdges.find((edge) => edge.id === selectedGraphEdgeId);
  const selectedGraphEdgeSource = selectedGraphEdge ? visibleNodes.find((node) => node.id === selectedGraphEdge.sourceNodeId) : null;
  const selectedGraphEdgeTarget = selectedGraphEdge ? visibleNodes.find((node) => node.id === selectedGraphEdge.targetNodeId) : null;
  const selectedGraphCurrentTarget =
    selectedGraphSubject === 'edge' && selectedGraphEdge ? `${selectedGraphEdgeSource?.name ?? selectedGraphEdge.sourceNodeId} → ${selectedGraphEdgeTarget?.name ?? selectedGraphEdge.targetNodeId}` : (selectedGraphNode?.name ?? '');

  useEffect(() => {
    graphDrilldownRequestVersionRef.current += 1;
    setGraphDrilldown(null);
    setGraphDrilldownStatus('idle');
    setGraphDrilldownPendingLabel('');
    setGraphDrilldownPendingTarget(null);
    setSelectedGraphNodeId(null);
    setSelectedGraphEdgeId(null);
    setSelectedGraphHopDepth(0);
  }, [props.graphView.id, props.graphView.viewType]);

  const conversationPage = props.graphConversationPage ?? {
    total: props.graphConversations?.length ?? 0,
    limit: 5,
    offset: 0,
    query: null,
    archived: false,
  };
  const nextOffset = conversationPage.offset + conversationPage.limit;
  const previousOffset = Math.max(0, conversationPage.offset - conversationPage.limit);
  const selectedConversation = props.selectedGraphConversation ?? props.graphConversations?.[0];
  const isSequenceDiagramExportView = props.graphView.viewType === 'api_sequence' || props.graphView.viewType === 'method_logic';
  const shouldRenderRuntimeGraph = activeGraphTool === 'runtime' && (props.isActive || typeof window === 'undefined') && !isSequenceDiagramExportView;
  const graphQaModeItems = [
    {
      label: codeMapCopy.currentView,
      value: graphDrilldown ? `${graphDrilldown.label} · ${graphWorkbenchCopy.drilldownGraph}` : (uiCopy.graphViewTypes[props.graphView.viewType as GraphViewType] ?? props.graphView.viewType),
    },
    {
      label: codeMapCopy.realNodes,
      value: `${visibleNodes.length} / ${activeGraphScope.nodes.length}`,
    },
    {
      label: codeMapCopy.realEdges,
      value: `${visibleGraphStats.representedEdgeCount} / ${activeGraphScope.edges.length}`,
    },
    {
      label: codeMapCopy.runtimeSessionLabel,
      value: props.graphAnswer?.sessionId ?? codeMapCopy.insufficientRuntimeSession,
    },
  ];

  const diagramExportFormatLabel = diagramExportFormat === 'plantuml' ? 'PlantUML' : 'Mermaid';
  const diagramPreviewTitle = isSequenceDiagramExportView
    ? diagramExportFormat === 'plantuml'
      ? codeMapCopy.plantUmlSequencePreviewTitle
      : codeMapCopy.mermaidSequencePreviewTitle
    : diagramExportFormat === 'plantuml'
      ? codeMapCopy.plantUmlPreviewTitle
      : codeMapCopy.mermaidPreviewTitle;
  const buildVisibleDiagramSource = (format: DiagramExportFormat): string => {
    const input = {
      viewType: graphDrilldown ? 'module_detail' : props.graphView.viewType,
      nodes: visibleNodes,
      edges: visibleEdges,
    };
    // PlantUML 走成熟 UML 工具链源码格式；Mermaid 保留轻量文本预览，两者都只使用当前真实可见节点和边。
    return format === 'plantuml' ? buildPlantUmlDiagramSource(input) : buildMermaidDiagramSource(input);
  };
  function buildVisibleDiagramExport(format: 'plantuml'): PlantUmlDiagramExportFile;
  function buildVisibleDiagramExport(format: 'mermaid'): MermaidDiagramExportFile;
  function buildVisibleDiagramExport(format: DiagramExportFormat): MermaidDiagramExportFile | PlantUmlDiagramExportFile {
    const source = buildVisibleDiagramSource(format);
    const input = {
      viewTitle: graphDrilldown ? `${graphDrilldown.label} · ${graphWorkbenchCopy.drilldownGraph}` : props.graphView.title,
      viewType: graphDrilldown ? 'module_detail' : props.graphView.viewType,
      generatedAt: new Date().toISOString(),
      source,
    };
    return format === 'plantuml' ? buildPlantUmlDiagramExport(input) : buildMermaidDiagramExport(input);
  }

  function toggleNodeVisibility(nodeId: string): void {
    setHiddenNodeIds((current) => (current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId]));
  }

  function findGraphObjectElement(kind: 'node' | 'edge', id: string | null): HTMLElement | SVGElement | null {
    if (!id) return null;
    const attribute = `data-graph-${kind}-id`;
    const candidates = codeMapWorkbenchRef.current?.querySelectorAll<HTMLElement | SVGElement>(`[${attribute}]`) ?? [];
    return Array.from(candidates).find((candidate) => candidate.getAttribute(attribute) === id) ?? null;
  }

  function restoreGraphObjectFocus(kind: 'node' | 'edge', id: string | null): void {
    const target = findGraphObjectElement(kind, id);
    window.requestAnimationFrame(() => target?.focus());
  }

  function closeGraphInspector(options?: { restoreFocus?: boolean }): void {
    const nodeId = selectedGraphNodeId;
    const edgeId = selectedGraphEdgeId;
    const subject = selectedGraphSubject;
    setSelectedGraphNodeId(null);
    setSelectedGraphEdgeId(null);
    setSelectedGraphHopDepth(0);
    if (options?.restoreFocus) restoreGraphObjectFocus(subject, subject === 'node' ? nodeId : edgeId);
  }

  function leaveGraphDrilldown(): void {
    graphDrilldownRequestVersionRef.current += 1;
    setGraphDrilldown(null);
    setGraphDrilldownStatus('idle');
    setGraphDrilldownPendingLabel('');
    setGraphDrilldownPendingTarget(null);
    closeGraphInspector();
  }

  async function openGraphDrilldown(nodeId: string, depth: 1 | 2, label: string): Promise<void> {
    if (!props.onLoadGraphNeighborhood) {
      selectGraphNode(nodeId);
      return;
    }
    const requestVersion = ++graphDrilldownRequestVersionRef.current;
    closeGraphInspector();
    setActiveGraphTool(null);
    setGraphToolMenuOpen(false);
    setGraphDrilldownPendingLabel(label);
    setGraphDrilldownPendingTarget({ nodeId, depth, label });
    setGraphDrilldownStatus('loading');
    try {
      const neighborhood = await props.onLoadGraphNeighborhood(nodeId, depth);
      if (requestVersion !== graphDrilldownRequestVersionRef.current) return;
      setGraphDrilldown({
        ...neighborhood,
        depth,
        label,
      });
      setGraphDrilldownStatus('idle');
      setGraphDrilldownPendingTarget(null);
    } catch {
      if (requestVersion !== graphDrilldownRequestVersionRef.current) return;
      setGraphDrilldownStatus('failed');
    }
  }

  function closeGraphTool(options?: { restoreFocus?: boolean }): void {
    setActiveGraphTool(null);
    if (options?.restoreFocus) {
      const target = graphOverlayReturnFocusRef.current;
      window.requestAnimationFrame(() => target?.focus());
    }
  }

  function openGraphTool(tool: CodeMapToolPanel, trigger?: HTMLElement | SVGElement | null): void {
    if (trigger) graphOverlayReturnFocusRef.current = trigger;
    else if (!graphOverlayReturnFocusRef.current && graphToolTriggerRef.current) graphOverlayReturnFocusRef.current = graphToolTriggerRef.current;
    closeGraphInspector();
    setGraphToolMenuOpen(false);
    setActiveGraphTool(tool);
  }

  function toggleGraphToolMenu(trigger: HTMLButtonElement): void {
    graphOverlayReturnFocusRef.current = trigger;
    setGraphToolMenuOpen((current) => !current);
  }

  function runQuickGraphSearch(): void {
    leaveGraphDrilldown();
    closeGraphInspector();
    const request = buildGraphSearchRequest({
      query: graphSearchQuery,
      nodeType: graphNodeTypeFilter,
      edgeType: graphEdgeTypeFilter,
      minConfidence: graphMinConfidence,
    });
    props.onSearchGraph?.(request.query, request.nodeType, request.edgeType, request.minConfidence);
  }

  const selectGraphNode = (nodeId: string): void => {
    // 节点与边详情互斥，默认不保留过期对象，保证详情面板只解释当前主动选择。
    setActiveGraphTool(null);
    setGraphToolMenuOpen(false);
    setSelectedGraphNodeId(nodeId);
    setSelectedGraphEdgeId(null);
    setSelectedGraphSubject('node');
    setSelectedGraphHopDepth(0);
  };

  const selectPrimaryGraphNode = (nodeId: string): void => {
    if (props.graphView.viewType !== 'architecture' || graphDrilldown) {
      selectGraphNode(nodeId);
      return;
    }
    const workload = visibleArchitectureModel?.workloads.find((item) => item.primaryNode.id === nodeId || item.module?.id === nodeId || item.application?.id === nodeId);
    const selectedNode = visibleNodes.find((node) => node.id === nodeId);
    // 架构卡片把模块与启动入口合并展示；下钻以模块为中心，才能得到包含父级、入口和依赖的真实邻域，而不是只剩一条 contains 关系。
    const centerNodeId = workload?.module?.id ?? nodeId;
    const label = workload?.application?.name ?? workload?.label ?? selectedNode?.name ?? nodeId;
    void openGraphDrilldown(centerNodeId, 2, label);
  };

  const selectGraphEdge = (edgeId: string): void => {
    setActiveGraphTool(null);
    setGraphToolMenuOpen(false);
    setSelectedGraphNodeId(null);
    setSelectedGraphEdgeId(edgeId);
    setSelectedGraphSubject('edge');
    setSelectedGraphHopDepth(0);
  };

  function clearGraphNodeMenuCloseTimer(): void {
    if (!graphNodeMenuCloseTimerRef.current) return;
    clearTimeout(graphNodeMenuCloseTimerRef.current);
    graphNodeMenuCloseTimerRef.current = null;
  }

  function openGraphNodeMenu(nodeId: string): void {
    clearGraphNodeMenuCloseTimer();
    setClosingNodeMenuId(null);
    setActiveNodeMenuId(nodeId);
  }

  const closeGraphNodeMenu = () => setActiveNodeMenuId(null);
  function closeGraphNodeMenuWithMotion(): void {
    if (!activeNodeMenuId) return;
    const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    clearGraphNodeMenuCloseTimer();
    if (prefersReducedMotion) {
      setClosingNodeMenuId(null);
      closeGraphNodeMenu();
      return;
    }
    // 图谱节点菜单属于轻量 popover，关闭时保留一小段退出动画，避免菜单像异常消失一样闪断。
    setClosingNodeMenuId(activeNodeMenuId);
    closeGraphNodeMenu();
    graphNodeMenuCloseTimerRef.current = setTimeout(() => {
      setClosingNodeMenuId(null);
      graphNodeMenuCloseTimerRef.current = null;
    }, graphNodeMenuCloseAnimationMs);
  }

  function toggleGraphNodeMenu(nodeId: string): void {
    if (activeNodeMenuId === nodeId) {
      closeGraphNodeMenuWithMotion();
      return;
    }
    openGraphNodeMenu(nodeId);
  }

  const handleGraphNodeMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeGraphNodeMenuWithMotion();
  };
  useEffect(
    () => () => {
      clearGraphNodeMenuCloseTimer();
    },
    [],
  );
  useEffect(() => {
    const closeGraphNodeMenuOnOutsidePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.graph-node-row')) return;
      closeGraphNodeMenuWithMotion();
    };
    document.addEventListener('pointerdown', closeGraphNodeMenuOnOutsidePointerDown, true);
    return () => document.removeEventListener('pointerdown', closeGraphNodeMenuOnOutsidePointerDown, true);
  }, [activeNodeMenuId]);
  useEffect(() => {
    const compactQuery = window.matchMedia('(max-width: 760px)');
    const syncCompactState = () => setIsCompactGraphWorkbench(compactQuery.matches);
    syncCompactState();
    compactQuery.addEventListener('change', syncCompactState);
    return () => compactQuery.removeEventListener('change', syncCompactState);
  }, []);
  useEffect(() => {
    closeGraphInspector();
    setHiddenNodeIds([]);
    setGraphSearchQuery('');
    setGraphNodeTypeFilter('');
    setGraphEdgeTypeFilter('');
    setActiveGraphTool(null);
    setGraphToolMenuOpen(false);
    setActiveNodeMenuId(null);
  }, [props.graphView.viewType]);
  useEffect(() => {
    if (!props.isActive) return undefined;
    const focusGraphSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      if (isCompactGraphWorkbench) {
        const returnTarget = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : graphToolTriggerRef.current;
        openGraphTool('search', returnTarget);
        return;
      }
      graphQuickSearchRef.current?.focus();
      graphQuickSearchRef.current?.select();
    };
    document.addEventListener('keydown', focusGraphSearch);
    return () => document.removeEventListener('keydown', focusGraphSearch);
  }, [isCompactGraphWorkbench, props.isActive]);
  useEffect(() => {
    if (!graphToolMenuOpen) return undefined;
    const focusFrame = window.requestAnimationFrame(() => {
      graphToolMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [graphToolMenuOpen]);
  useEffect(() => {
    if (!activeGraphTool && !selectedGraphNode && !selectedGraphEdge) return;
    const focusOverlay = window.requestAnimationFrame(() => {
      if (isCompactGraphWorkbench) {
        if (activeGraphTool === 'search') {
          graphOverlayRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
          return;
        }
        graphOverlayCloseRef.current?.focus();
        return;
      }
      if (activeGraphTool) {
        graphOverlayRef.current?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])')?.focus();
      }
    });
    return () => window.cancelAnimationFrame(focusOverlay);
  }, [activeGraphTool, isCompactGraphWorkbench, selectedGraphEdge, selectedGraphNode]);

  const handleGraphWorkbenchKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      if (graphToolMenuOpen) {
        event.preventDefault();
        setGraphToolMenuOpen(false);
        graphToolTriggerRef.current?.focus();
        return;
      }
      if (activeGraphTool) {
        event.preventDefault();
        closeGraphTool({ restoreFocus: true });
        return;
      }
      if (selectedGraphNode || selectedGraphEdge) {
        event.preventDefault();
        closeGraphInspector({ restoreFocus: true });
      }
      return;
    }
  };

  const handleGraphWorkbenchPointerDownCapture = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!graphToolMenuOpen || !(event.target instanceof Node)) return;
    if (graphToolMenuRef.current?.contains(event.target) || graphToolTriggerRef.current?.contains(event.target)) return;
    // 点击工作台其他区域时关闭菜单，并把焦点留给用户刚刚点击的目标。
    setGraphToolMenuOpen(false);
  };

  const handleGraphToolMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setGraphToolMenuOpen(false);
      graphToolTriggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (items.length === 0) return;
    const currentIndex = Math.max(
      0,
      items.findIndex((item) => item === document.activeElement),
    );
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (currentIndex + 1) % items.length : (currentIndex - 1 + items.length) % items.length;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  function runNodeAction(node: GraphViewSnapshot['nodes'][number], action: GraphNodeActionMenuItem): void {
    if (action.id === 'inspect-detail') {
      selectGraphNode(node.id);
      setSelectedGraphHopDepth(0);
    }
    if (action.id === 'create-task') props.onCreateTaskFromNode?.(node.id);
    if (action.id === 'open-source')
      props.onOpenGraphSource?.({
        sourceRef: action.sourceRef,
        lineStart: action.lineStart ?? undefined,
      });
    if (action.id === 'ask-node') {
      const request = buildGraphQuestionRequest(codeMapCopy.explainNodeQuestion(node.qualifiedName, node.sourceRef));
      if (request.canAsk) props.onAskGraph?.(request.question);
    }
    if (action.id === 'generate-sequence' || action.id === 'generate-flow') {
      selectGraphNode(node.id);
      setShowMermaidPreview(true);
    }
    if (action.id === 'expand-one-hop') {
      selectGraphNode(node.id);
      setSelectedGraphHopDepth(1);
    }
    if (action.id === 'expand-two-hop') {
      selectGraphNode(node.id);
      setSelectedGraphHopDepth(2);
    }
    if (action.id === 'toggle-visibility') toggleNodeVisibility(node.id);
    closeGraphNodeMenuWithMotion();
  }

  const scanStatusCopy = props.scanState === 'scanning' ? graphWorkbenchCopy.scanBusy : props.scanState === 'failed' ? graphWorkbenchCopy.scanFailed : graphWorkbenchCopy.scanIdle;
  const inspectorOpen = Boolean(selectedGraphNode || selectedGraphEdge);

  return (
    <section
      ref={codeMapWorkbenchRef}
      className="code-map-view code-map-workbench code-map-graph-first"
      aria-label={codeMapCopy.viewAria}
      onKeyDown={handleGraphWorkbenchKeyDown}
      onPointerDownCapture={handleGraphWorkbenchPointerDownCapture}
    >
      <header className="code-map-command-bar" aria-label={codeMapCopy.viewSwitcherAria}>
        <ZeusSelect<GraphViewType>
          size="compact"
          className="code-map-view-picker"
          ariaLabel={graphWorkbenchCopy.viewPicker}
          value={props.graphView.viewType as GraphViewType}
          onChange={(viewType) => {
            setGraphToolMenuOpen(false);
            leaveGraphDrilldown();
            void props.onLoadView?.(viewType);
          }}
          searchable={false}
          searchPlaceholder={selectSearchPlaceholder}
          emptyLabel={selectNoResults}
          options={graphViewOptions.map((option) => ({
            value: option.type,
            label: uiCopy.graphViewTypes[option.type],
          }))}
        />
        <label className="code-map-quick-search">
          <MagnifyingGlass aria-hidden="true" weight="regular" />
          <input
            ref={graphQuickSearchRef}
            type="search"
            aria-label={graphWorkbenchCopy.quickSearch}
            placeholder={`${graphWorkbenchCopy.quickSearch}…`}
            value={graphSearchQuery}
            disabled={props.scanState === 'scanning'}
            onChange={(event) => setGraphSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              runQuickGraphSearch();
            }}
          />
          <kbd>⌘F</kbd>
        </label>
        <span className={`code-map-scan-state ${props.scanState ?? 'idle'}`} role="status" aria-live="polite">
          <i aria-hidden="true" />
          {scanStatusCopy}
        </span>
        <span className="code-map-command-actions">
          <button
            type="button"
            disabled={props.scanState === 'scanning'}
            onClick={(event) => {
              graphOverlayReturnFocusRef.current = event.currentTarget;
              openGraphTool('qa', event.currentTarget);
            }}
          >
            {graphWorkbenchCopy.ask}
          </button>
          <button
            ref={graphToolTriggerRef}
            type="button"
            aria-expanded={graphToolMenuOpen}
            aria-haspopup="menu"
            onClick={(event) => {
              // 统一走 click，避免辅助技术同时合成 pointer 与 click 时把菜单连续开关两次。
              toggleGraphToolMenu(event.currentTarget);
            }}
          >
            {graphWorkbenchCopy.tools}
          </button>
        </span>
        {graphToolMenuOpen ? (
          <div ref={graphToolMenuRef} className="code-map-tool-menu" role="menu" aria-label={graphWorkbenchCopy.toolMenu} onKeyDown={handleGraphToolMenuKeyDown}>
            {codeMapToolPanels.map((tool) => (
              <button key={tool.id} type="button" role="menuitem" onClick={() => openGraphTool(tool.id, graphToolTriggerRef.current)}>
                <strong>{codeMapCopy.tools[tool.id].label}</strong>
                <small>{codeMapCopy.tools[tool.id].description}</small>
              </button>
            ))}
            <span className="code-map-tool-menu-separator" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              disabled={!props.onScanGraph || props.scanState === 'scanning'}
              onClick={() => {
                setGraphToolMenuOpen(false);
                props.onScanGraph?.();
              }}
            >
              <strong>{graphWorkbenchCopy.rescan}</strong>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!props.onOpenChanges}
              onClick={() => {
                setGraphToolMenuOpen(false);
                props.onOpenChanges?.();
              }}
            >
              <strong>{graphWorkbenchCopy.viewChanges}</strong>
            </button>
          </div>
        ) : null}
      </header>

      <div className="code-map-primary-grid" aria-label={codeMapCopy.primaryGridAria} data-overlay-open={inspectorOpen || Boolean(activeGraphTool) ? 'true' : 'false'}>
        <section className="code-map-stage-surface" aria-label={codeMapCopy.stageAria}>
          <header className="code-map-canvas-context">
            <span>
              {graphDrilldown ? (
                <>
                  <button type="button" className="code-map-breadcrumb-button" onClick={leaveGraphDrilldown}>
                    {uiCopy.graphViewTypes.architecture}
                  </button>
                  <i aria-hidden="true">/</i>
                  <strong>{graphDrilldown.label}</strong>
                </>
              ) : (
                <>
                  <strong>{graphWorkbenchCopy.allGraphs}</strong>
                  <i aria-hidden="true">/</i>
                  <span>{uiCopy.graphViewTypes[props.graphView.viewType as GraphViewType] ?? props.graphView.title}</span>
                </>
              )}
            </span>
            <span>
              {graphDrilldown ? (
                <span className="code-map-drilldown-depth" aria-label={graphWorkbenchCopy.drilldownDepth}>
                  {([1, 2] as const).map((depth) => (
                    <button
                      key={depth}
                      type="button"
                      aria-pressed={graphDrilldown.depth === depth}
                      disabled={graphDrilldownStatus === 'loading'}
                      onClick={() => void openGraphDrilldown(graphDrilldown.centerNode.id, depth, graphDrilldown.label)}
                    >
                      {depth === 1 ? graphWorkbenchCopy.drilldownOne : graphWorkbenchCopy.drilldownTwo}
                    </button>
                  ))}
                </span>
              ) : null}
              {props.searchResult && !searchResultHasCurrentMatches ? (
                <em className="code-map-search-feedback" role="status">
                  {graphWorkbenchCopy.searchNoMatch}
                </em>
              ) : null}
              {visibleArchitectureModel ? (
                <>
                  {graphWorkbenchCopy.currentVisible} {visibleArchitectureModel.objectCount} {props.appLanguage === 'zh-CN' ? '个架构对象' : 'architecture objects'} · {visibleArchitectureModel.dependencyEdges.length}{' '}
                  {props.appLanguage === 'zh-CN' ? '条依赖' : 'dependencies'}
                </>
              ) : (
                <>
                  {graphWorkbenchCopy.currentVisible} {visibleNodes.length} {graphWorkbenchCopy.nodeUnit} · {visibleEdges.length} {graphWorkbenchCopy.relationGroupUnit} ·{' '}
                  {graphWorkbenchCopy.representedRelations(visibleGraphStats.representedEdgeCount)}
                </>
              )}
              {hiddenNodeIds.length > 0 ? (
                <button type="button" onClick={() => setHiddenNodeIds([])}>
                  {graphWorkbenchCopy.restoreHidden} ({hiddenNodeIds.length})
                </button>
              ) : null}
            </span>
          </header>
          {graphDrilldownStatus !== 'idle' ? (
            <section className={`code-map-drilldown-status ${graphDrilldownStatus}`} role="status" aria-live="polite">
              <span>{graphDrilldownStatus === 'loading' ? graphWorkbenchCopy.drilldownLoading(graphDrilldownPendingLabel) : graphWorkbenchCopy.drilldownFailed}</span>
              {graphDrilldownStatus === 'failed' ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!graphDrilldownPendingTarget) return;
                    void openGraphDrilldown(graphDrilldownPendingTarget.nodeId, graphDrilldownPendingTarget.depth, graphDrilldownPendingTarget.label);
                  }}
                >
                  {props.appLanguage === 'zh-CN' ? '重试' : 'Retry'}
                </button>
              ) : null}
            </section>
          ) : null}
          {graphNodeTaskStatusText ? (
            <section className={`graph-node-task-status-row ${props.graphNodeTaskFeedback}`} role="status" aria-live="polite" aria-label={codeMapCopy.graphNodeTaskStatusAria}>
              <span>{graphNodeTaskStatusText}</span>
              {props.graphNodeTaskFeedback === 'failed' && props.graphNodeTaskTargetId ? (
                <button type="button" className="graph-node-task-retry-button" aria-label={codeMapCopy.graphNodeTaskRetryAria} onClick={retryGraphNodeTask}>
                  {codeMapCopy.graphNodeTaskRetry}
                </button>
              ) : null}
            </section>
          ) : null}
          {graphSourceOpenStatusText ? (
            <section className={`graph-source-open-status-row ${props.graphSourceOpenFeedback}`} role="status" aria-live="polite" aria-label={codeMapCopy.graphSourceOpenStatusAria}>
              <span>{graphSourceOpenStatusText}</span>
            </section>
          ) : null}
          <GraphCanvas
            title={graphDrilldown ? `${graphDrilldown.label} · ${graphWorkbenchCopy.drilldownGraph}` : props.graphView.title}
            nodes={visibleNodes}
            edges={visibleEdges}
            layout={graphDrilldownLayout ?? props.graphView.layout}
            viewType={graphDrilldown ? 'module_detail' : (props.graphView.viewType as GraphViewType)}
            appLanguage={props.appLanguage}
            currentNodeId={selectedGraphSubject === 'node' ? (selectedGraphNode?.id ?? graphDrilldown?.centerNode.id) : graphDrilldown?.centerNode.id}
            currentEdgeId={selectedGraphSubject === 'edge' ? selectedGraphEdge?.id : null}
            onSelectNode={selectPrimaryGraphNode}
            onSelectEdge={selectGraphEdge}
            onClearSelection={() => closeGraphInspector()}
            onOpenGraphSource={props.onOpenGraphSource}
            onCreateTaskFromNode={props.onCreateTaskFromNode}
          />

          {inspectorOpen ? (
            <aside ref={graphOverlayRef} className="code-map-inspector-pane code-map-floating-surface" aria-label={codeMapCopy.inspectorAria} role={isCompactGraphWorkbench ? 'dialog' : undefined}>
              <header className="code-map-floating-header">
                <span>
                  <small>{selectedGraphSubject === 'edge' ? graphWorkbenchCopy.inspectEdge : graphWorkbenchCopy.inspectNode}</small>
                  <strong>{selectedGraphCurrentTarget}</strong>
                </span>
                <button ref={graphOverlayCloseRef} type="button" aria-label={graphWorkbenchCopy.close} onClick={() => closeGraphInspector({ restoreFocus: true })}>
                  <X aria-hidden="true" weight="regular" />
                </button>
              </header>
              {selectedGraphNode ? (
                <>
                  <div className="graph-focus-toolbar" aria-label={graphWorkbenchCopy.focusLabel}>
                    {([0, 1, 2] as const).map((depth) => (
                      <button key={depth} type="button" aria-pressed={selectedGraphHopDepth === depth} disabled={isAggregatedGraphNode(selectedGraphNode) && depth > 0} onClick={() => setSelectedGraphHopDepth(depth)}>
                        {depth === 0 ? graphWorkbenchCopy.focusAll : depth === 1 ? graphWorkbenchCopy.focusOne : graphWorkbenchCopy.focusTwo}
                      </button>
                    ))}
                  </div>
                  <GraphNodeDetail node={selectedGraphNode} graphView={inspectorGraphView} expandedHopDepth={selectedGraphHopDepth || undefined} appLanguage={props.appLanguage} isCurrent />
                  <div className="graph-inspector-actions">
                    <button
                      type="button"
                      disabled={!resolveGraphCanvasNodeSourceRef(selectedGraphNode)}
                      onClick={() =>
                        props.onOpenGraphSource?.({
                          sourceRef: resolveGraphCanvasNodeSourceRef(selectedGraphNode),
                          lineStart: resolveGraphCanvasNodeLineStart(selectedGraphNode) ?? undefined,
                        })
                      }
                    >
                      {graphWorkbenchCopy.openSource}
                    </button>
                    <button
                      type="button"
                      disabled={isAggregatedGraphNode(selectedGraphNode) || props.scanState === 'scanning'}
                      onClick={() => {
                        if (isAggregatedGraphNode(selectedGraphNode)) return;
                        const question = codeMapCopy.explainNodeQuestion(selectedGraphNode.qualifiedName, resolveGraphCanvasNodeSourceRef(selectedGraphNode));
                        setGraphQuestionInput(question);
                        openGraphTool('qa', findGraphObjectElement('node', selectedGraphNode.id));
                      }}
                    >
                      {graphWorkbenchCopy.askNode}
                    </button>
                    <button type="button" disabled={isAggregatedGraphNode(selectedGraphNode)} onClick={() => props.onCreateTaskFromNode?.(selectedGraphNode.id)}>
                      {graphWorkbenchCopy.createTask}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (isAggregatedGraphNode(selectedGraphNode)) {
                          setHiddenNodeIds((current) => [...new Set([...current, ...selectedGraphNode.nodeIds])]);
                        } else {
                          toggleNodeVisibility(selectedGraphNode.id);
                        }
                        closeGraphInspector();
                      }}
                    >
                      {graphWorkbenchCopy.hideNode}
                    </button>
                  </div>
                </>
              ) : null}
              {selectedGraphEdge ? <GraphEdgeDetailPanel edge={selectedGraphEdge} nodes={visibleNodes} graphView={inspectorGraphView} appLanguage={props.appLanguage} isCurrent /> : null}
            </aside>
          ) : null}

          {activeGraphTool ? (
            <aside ref={graphOverlayRef} className="code-map-tool-surface code-map-floating-surface" aria-label={codeMapCopy.tools[activeGraphTool].label} role={isCompactGraphWorkbench ? 'dialog' : undefined}>
              <header className="code-map-floating-header">
                <span>
                  <small>{graphWorkbenchCopy.tools}</small>
                  <strong>{codeMapCopy.tools[activeGraphTool].label}</strong>
                </span>
                <button ref={graphOverlayCloseRef} type="button" aria-label={graphWorkbenchCopy.close} onClick={() => closeGraphTool({ restoreFocus: true })}>
                  <X aria-hidden="true" weight="regular" />
                </button>
              </header>
              <section className="code-map-secondary-tools code-map-secondary-inspector" aria-label={codeMapCopy.secondaryToolsAria}>
                <section className={`code-map-tool-pane ${activeGraphTool === 'runtime' ? 'code-map-tool-pane-active' : ''}`} aria-label={codeMapCopy.graphRuntime} hidden={activeGraphTool !== 'runtime'}>
                  {shouldRenderRuntimeGraph ? (
                    <GraphRuntimeCanvas
                      nodes={visibleNodes}
                      edges={visibleEdges}
                      layout={graphDrilldownLayout ?? props.graphView.layout}
                      appLanguage={props.appLanguage}
                      currentNodeId={selectedGraphSubject === 'node' ? selectedGraphNode?.id : null}
                      currentEdgeId={selectedGraphSubject === 'edge' ? selectedGraphEdge?.id : null}
                      onSelectNode={selectGraphNode}
                      onSelectEdge={selectGraphEdge}
                    />
                  ) : (
                    <section className="graph-runtime-unavailable-row" aria-label={codeMapCopy.graphRuntime}>
                      {/* 运行时预览只能按需出现；默认状态必须明确它被收纳而不是悄悄抢占主画布。 */}
                      <span className="graph-qa-copy">
                        <strong>{codeMapCopy.graphRuntime}</strong>
                        <span>{isSequenceDiagramExportView ? codeMapCopy.sequenceRuntimeHidden : codeMapCopy.runtimeToolCollapsed}</span>
                      </span>
                    </section>
                  )}
                </section>

                <section className={`code-map-tool-pane ${activeGraphTool === 'search' ? 'code-map-tool-pane-active' : ''}`} aria-label={codeMapCopy.searchPanelAria} hidden={activeGraphTool !== 'search'}>
                  <div className="graph-search-control-grid" aria-label={codeMapCopy.searchFilterAria}>
                    <section className="graph-search-control-row" aria-label={codeMapCopy.nodeSearchAria}>
                      {/* 图谱筛选控件必须保留来源语境：说明列讲清筛选含义，控件列只负责输入。 */}
                      <span className="graph-search-control-copy">
                        <strong>{codeMapCopy.nodeSearchTitle}</strong>
                        <small>{codeMapCopy.nodeSearchHelp}</small>
                      </span>
                      <span className="graph-search-control-field">
                        <input type="search" aria-label={codeMapCopy.nodeSearchAria} value={graphSearchQuery} onChange={(event) => setGraphSearchQuery(event.currentTarget.value)} />
                      </span>
                    </section>
                    <section className="graph-search-control-row" aria-label={codeMapCopy.nodeTypeAria}>
                      <span className="graph-search-control-copy">
                        <strong>{codeMapCopy.nodeTypeTitle}</strong>
                        <small>{codeMapCopy.nodeTypeHelp}</small>
                      </span>
                      <span className="graph-search-control-field">
                        <ZeusSelect
                          size="regular"
                          ariaLabel={codeMapCopy.nodeTypeAria}
                          value={graphNodeTypeFilter}
                          onChange={setGraphNodeTypeFilter}
                          searchPlaceholder={selectSearchPlaceholder}
                          emptyLabel={selectNoResults}
                          options={graphNodeTypeFilterValues.map((nodeType) => ({
                            value: nodeType,
                            label: uiCopy.graphNodeTypes[nodeType],
                          }))}
                        />
                      </span>
                    </section>
                    <section className="graph-search-control-row" aria-label={codeMapCopy.edgeTypeAria}>
                      <span className="graph-search-control-copy">
                        <strong>{codeMapCopy.edgeTypeTitle}</strong>
                        <small>{codeMapCopy.edgeTypeHelp}</small>
                      </span>
                      <span className="graph-search-control-field">
                        <ZeusSelect
                          size="regular"
                          ariaLabel={codeMapCopy.edgeTypeAria}
                          value={graphEdgeTypeFilter}
                          onChange={setGraphEdgeTypeFilter}
                          searchPlaceholder={selectSearchPlaceholder}
                          emptyLabel={selectNoResults}
                          options={graphEdgeTypeFilterValues.map((edgeType) => ({
                            value: edgeType,
                            label: uiCopy.graphEdgeTypes[edgeType],
                          }))}
                        />
                      </span>
                    </section>
                    <section className="graph-search-control-row" aria-label={codeMapCopy.minConfidenceAria}>
                      <span className="graph-search-control-copy">
                        <strong>{codeMapCopy.minConfidenceTitle}</strong>
                        <small>{codeMapCopy.minConfidenceHelp}</small>
                      </span>
                      <span className="graph-search-control-field">
                        <input
                          aria-label={codeMapCopy.minConfidenceAria}
                          type="number"
                          min="0"
                          max="1"
                          step="0.1"
                          value={graphMinConfidence}
                          onChange={(event) => setGraphMinConfidence(normalizeGraphMinConfidence(event.currentTarget.value, graphMinConfidence))}
                        />
                      </span>
                    </section>
                    <button type="button" disabled={props.scanState === 'scanning'} onClick={runQuickGraphSearch}>
                      {codeMapCopy.searchAction}
                    </button>
                    {props.searchResult ? <span>{codeMapCopy.resultCount(props.searchResult.nodes.length + props.searchResult.edges.length)}</span> : null}
                    {props.searchResult && !searchResultHasCurrentMatches ? (
                      <span className="code-map-search-feedback" role="status">
                        {graphWorkbenchCopy.searchNoMatch}
                      </span>
                    ) : null}
                  </div>
                </section>

                <section className={`code-map-tool-pane ${activeGraphTool === 'qa' ? 'code-map-tool-pane-active' : ''}`} aria-label={codeMapCopy.qaPanelAria} hidden={activeGraphTool !== 'qa'}>
                  <section className="graph-qa-workbench" aria-label={codeMapCopy.qaPanelAria}>
                    {/* 图谱问答必须绑定真实图谱来源，提问、回答、历史和详情按连续行组织，避免回到表单和时间线堆叠。 */}
                    <section className="graph-qa-compose-row zeus-composer-dock" aria-label={codeMapCopy.qaComposeAria}>
                      <span className="graph-qa-copy">
                        <strong>{codeMapCopy.askGraphTitle}</strong>
                        <small>{codeMapCopy.askGraphHelp}</small>
                      </span>
                      <section className="graph-qa-question-row" aria-label={codeMapCopy.questionAria}>
                        <span className="graph-qa-question-copy">
                          <strong>{codeMapCopy.questionTitle}</strong>
                          <small>{codeMapCopy.questionHelp}</small>
                        </span>
                        <span className="graph-qa-question-field">
                          <input aria-label={codeMapCopy.askGraphAction} value={graphQuestionInput} onChange={(event) => setGraphQuestionInput(event.currentTarget.value)} />
                        </span>
                      </section>
                      <span className="graph-qa-decision-rail zeus-decision-rail" data-inline-rail-keyboard="horizontal" onKeyDown={handleInlineRailKeyboardNavigation}>
                        <button
                          type="button"
                          className="graph-qa-ask-button zeus-decision-rail-button"
                          data-inline-rail-item="true"
                          disabled={props.scanState === 'scanning' || !buildGraphQuestionRequest(graphQuestionInput).canAsk}
                          onClick={() => {
                            const request = buildGraphQuestionRequest(graphQuestionInput);
                            if (request.canAsk) props.onAskGraph?.(request.question);
                          }}
                        >
                          {codeMapCopy.askGraphAction}
                        </button>
                      </span>
                      <section className="graph-qa-mode-rail zeus-mode-rail" aria-label={codeMapCopy.qaModeRailAria}>
                        {graphQaModeItems.map((item) => (
                          <span className="graph-qa-mode-rail-item zeus-mode-rail-item" key={item.label}>
                            <small>{item.label}</small>
                            <strong>{item.value}</strong>
                          </span>
                        ))}
                      </section>
                    </section>
                    {props.graphAnswer ? (
                      <section className="graph-qa-answer-row" aria-label={codeMapCopy.graphAnswerAria}>
                        <span className="graph-qa-copy">
                          <strong>{props.graphAnswer.answer}</strong>
                          <span>{props.graphAnswer.sessionId ? `${codeMapCopy.runtimeSessionLabel} ${props.graphAnswer.sessionId}` : codeMapCopy.insufficientRuntimeSession}</span>
                          {props.graphAnswer.sources.nodes.slice(0, 3).map((node) => (
                            <small key={node.id}>{node.sourceRef}</small>
                          ))}
                        </span>
                      </section>
                    ) : null}
                    <section className="graph-qa-history" aria-label={codeMapCopy.qaHistoryAria}>
                      <div className="graph-qa-history-toolbar" aria-label={codeMapCopy.qaHistoryToolbarAria}>
                        <section className="graph-qa-history-search-row" aria-label={codeMapCopy.qaHistorySearchAria}>
                          <span className="graph-qa-history-search-copy">
                            <strong>{codeMapCopy.searchHistoryTitle}</strong>
                            <small>{codeMapCopy.searchHistoryHelp}</small>
                          </span>
                          <span className="graph-qa-history-search-field">
                            <input type="search" aria-label={codeMapCopy.qaHistorySearchAria} value={props.graphConversationSearch ?? ''} onChange={(event) => props.onGraphConversationSearchChange?.(event.target.value)} />
                          </span>
                        </section>
                        <span className="graph-qa-toolbar-command-rail">
                          <button
                            type="button"
                            onClick={() =>
                              props.onLoadGraphConversations?.({
                                query: props.graphConversationSearch?.trim() || undefined,
                                offset: 0,
                                archived: conversationPage.archived,
                              })
                            }
                          >
                            {codeMapCopy.searchHistoryAction}
                          </button>
                          <button
                            type="button"
                            aria-pressed={conversationPage.archived}
                            onClick={() =>
                              props.onLoadGraphConversations?.({
                                query: conversationPage.query ?? undefined,
                                offset: 0,
                                archived: !conversationPage.archived,
                              })
                            }
                          >
                            {conversationPage.archived ? codeMapCopy.viewActiveHistory : codeMapCopy.viewArchivedHistory}
                          </button>
                        </span>
                        <span className="graph-qa-count">{codeMapCopy.realQaCount(conversationPage.total)}</span>
                      </div>
                      {(props.graphConversations ?? []).length === 0 ? (
                        <div className="graph-qa-empty-row" aria-label={codeMapCopy.qaHistoryEmptyAria}>
                          <span className="graph-qa-copy">
                            <strong>{codeMapCopy.noRealQaHistory}</strong>
                            <span>{conversationPage.query ? codeMapCopy.noMatchingQaHistory : codeMapCopy.qaHistoryEmptyHelp}</span>
                          </span>
                        </div>
                      ) : (
                        props.graphConversations?.slice(0, 5).map((conversation) => {
                          const assistantMessage = conversation.messages.find((message) => message.role === 'assistant');
                          return (
                            <article className="graph-qa-history-row" key={conversation.id}>
                              <span className="graph-qa-copy">
                                <strong>{conversation.title}</strong>
                                <span>{assistantMessage?.content ?? conversation.summary ?? codeMapCopy.answerNotGenerated}</span>
                                <small>{conversation.sessionId ? `${codeMapCopy.runtimeSessionLabel} ${conversation.sessionId}` : codeMapCopy.insufficientRuntimeSession}</small>
                              </span>
                              <span className="graph-qa-history-command-rail">
                                <button type="button" className="graph-qa-detail-button" onClick={() => props.onLoadGraphConversation?.(conversation.id)}>
                                  {codeMapCopy.viewDetail}
                                </button>
                                <button type="button" className="graph-qa-task-button" onClick={() => props.onCreateTaskFromGraphConversation?.(conversation.id)}>
                                  {codeMapCopy.createTaskFromQa}
                                </button>
                                {conversation.archived ? (
                                  <button type="button" className="graph-qa-archive-button" onClick={() => props.onRestoreGraphConversation?.(conversation.id)}>
                                    {codeMapCopy.restoreHistory}
                                  </button>
                                ) : (
                                  <button type="button" className="graph-qa-archive-button" onClick={() => props.onArchiveGraphConversation?.(conversation.id)}>
                                    {codeMapCopy.archiveHistory}
                                  </button>
                                )}
                              </span>
                            </article>
                          );
                        })
                      )}
                      <div className="graph-qa-pagination-row" aria-label={codeMapCopy.qaPaginationAria}>
                        <button
                          type="button"
                          disabled={conversationPage.offset <= 0}
                          onClick={() =>
                            props.onLoadGraphConversations?.({
                              query: conversationPage.query ?? undefined,
                              offset: previousOffset,
                              archived: conversationPage.archived,
                            })
                          }
                        >
                          {codeMapCopy.previousPage}
                        </button>
                        <span>{conversationPage.total === 0 ? codeMapCopy.pageRangeEmpty : codeMapCopy.pageRange(conversationPage.offset + 1, Math.min(conversationPage.total, conversationPage.offset + conversationPage.limit))}</span>
                        <button
                          type="button"
                          disabled={nextOffset >= conversationPage.total}
                          onClick={() =>
                            props.onLoadGraphConversations?.({
                              query: conversationPage.query ?? undefined,
                              offset: nextOffset,
                              archived: conversationPage.archived,
                            })
                          }
                        >
                          {codeMapCopy.nextPage}
                        </button>
                      </div>
                      {selectedConversation ? (
                        <aside className="graph-qa-detail-pane graph-qa-detail-inspector" aria-label={codeMapCopy.qaDetailAria}>
                          <header className="graph-qa-detail-header">
                            <span className="graph-qa-detail-title-copy">
                              <strong>{selectedConversation.title}</strong>
                              <small>{selectedConversation.summary || selectedConversation.projectId}</small>
                            </span>
                            <small>
                              {selectedConversation.archived ? codeMapCopy.archivedStatus : codeMapCopy.activeStatus} · {formatGraphConversationStatus(selectedConversation.status, props.appLanguage)}
                            </small>
                          </header>
                          <section className="graph-qa-detail-meta-row" aria-label={codeMapCopy.qaDetailStatusAria}>
                            <span className="graph-qa-detail-message-copy">
                              {/* Runtime 会话来自真实历史记录；缺失时明确展示未启动，避免伪造会话来源。 */}
                              <strong>{selectedConversation.sessionId ? `${codeMapCopy.runtimeSessionLabel} ${selectedConversation.sessionId}` : codeMapCopy.insufficientRuntimeSession}</strong>
                              <small>{selectedConversation.updatedAt}</small>
                            </span>
                            <span>{codeMapCopy.messageCount(selectedConversation.messages.length)}</span>
                          </section>
                          <section className="graph-qa-detail-message-list" aria-label={codeMapCopy.qaMessagesAria}>
                            {selectedConversation.messages.map((message) => (
                              <div className="graph-qa-message-row" key={message.id}>
                                <span className="graph-qa-detail-message-copy graph-qa-copy">
                                  <strong>{message.role === 'assistant' ? codeMapCopy.assistantAnswer : codeMapCopy.userQuestion}</strong>
                                  <span>{message.content}</span>
                                  <small>{formatGraphMessageSource(message.source, props.appLanguage)}</small>
                                </span>
                              </div>
                            ))}
                          </section>
                        </aside>
                      ) : null}
                    </section>
                  </section>
                </section>

                <section className={`code-map-tool-pane ${activeGraphTool === 'mermaid' ? 'code-map-tool-pane-active' : ''}`} aria-label={codeMapCopy.mermaidPanelAria} hidden={activeGraphTool !== 'mermaid'}>
                  <section className="graph-mermaid-preview graph-mermaid-workbench" aria-label={codeMapCopy.mermaidPreviewAria}>
                    {/* 图表源码导出只展示真实可见节点和边；PlantUML 用于对接成熟 UML 工具链，Mermaid 保留轻量预览。 */}
                    <div className="graph-mermaid-command-row" aria-label={codeMapCopy.mermaidExportCommandsAria}>
                      <span className="graph-mermaid-copy">
                        <strong>{diagramPreviewTitle}</strong>
                        <small>{codeMapCopy.mermaidPreviewHelp}</small>
                      </span>
                      <span className="graph-mermaid-command-rail">
                        <span className="graph-diagram-format-switch" aria-label={codeMapCopy.diagramFormatAria}>
                          {(['mermaid', 'plantuml'] as const).map((format) => (
                            <button key={format} type="button" aria-pressed={diagramExportFormat === format} onClick={() => setDiagramExportFormat(format)}>
                              {format === 'plantuml' ? 'PlantUML' : 'Mermaid'}
                            </button>
                          ))}
                        </span>
                        <button type="button" onClick={() => setShowMermaidPreview((current) => !current)}>
                          {showMermaidPreview ? codeMapCopy.hideMermaidSource : codeMapCopy.generateMermaidPreview}
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              if (diagramExportFormat === 'plantuml') {
                                const exportFile = buildVisibleDiagramExport('plantuml');
                                setLastMermaidExport(exportFile);
                                const saved = props.onExportPlantUmlDiagramFile ? await props.onExportPlantUmlDiagramFile(exportFile) : { saved: false, filePath: null };
                                setMermaidExportStatus(saved.saved && saved.filePath ? codeMapCopy.mermaidSavedStatus(saved.filePath) : codeMapCopy.mermaidGeneratedStatus(exportFile.fileName));
                              } else {
                                const exportFile = buildVisibleDiagramExport('mermaid');
                                setLastMermaidExport(exportFile);
                                const saved = props.onExportMermaidDiagramFile ? await props.onExportMermaidDiagramFile(exportFile) : { saved: false, filePath: null };
                                setMermaidExportStatus(saved.saved && saved.filePath ? codeMapCopy.mermaidSavedStatus(saved.filePath) : codeMapCopy.mermaidGeneratedStatus(exportFile.fileName));
                              }
                            } catch {
                              setMermaidExportStatus(codeMapCopy.mermaidSaveFailedStatus);
                            }
                            setShowMermaidPreview(true);
                          }}
                        >
                          {codeMapCopy.exportMermaidSource}
                        </button>
                      </span>
                    </div>
                    {showMermaidPreview ? (
                      <div className="graph-mermaid-source-row" aria-label={codeMapCopy.mermaidSourceAria}>
                        <small>{diagramExportFormatLabel}</small>
                        <pre className="graph-mermaid-source-preview">{buildVisibleDiagramSource(diagramExportFormat)}</pre>
                      </div>
                    ) : (
                      <div className="graph-mermaid-empty-row" aria-label={codeMapCopy.mermaidEmptyAria}>
                        <span className="graph-mermaid-copy">
                          <strong>{codeMapCopy.mermaidEmptyTitle}</strong>
                          <span>{codeMapCopy.mermaidEmptyHelp}</span>
                        </span>
                      </div>
                    )}
                    {lastMermaidExport || mermaidExportStatus ? (
                      <div className="graph-mermaid-status-row" aria-label={codeMapCopy.mermaidStatusAria}>
                        {lastMermaidExport ? <small>{codeMapCopy.mermaidGeneratedFile(lastMermaidExport.fileName, lastMermaidExport.mimeType)}</small> : null}
                        {mermaidExportStatus ? <small>{mermaidExportStatus}</small> : null}
                      </div>
                    ) : null}
                  </section>
                </section>

                <section className={`code-map-tool-pane ${activeGraphTool === 'entities' ? 'code-map-tool-pane-active' : ''}`} aria-label={codeMapCopy.entityPanelAria} hidden={activeGraphTool !== 'entities'}>
                  <section className="graph-entity-workbench" aria-label={codeMapCopy.entityWorkbenchAria}>
                    {/* 节点和边列表只表达真实来源与常用动作，操作列和信息列分离，避免节点卡片继续按钮平铺。 */}
                    <section className="graph-entity-section" aria-label={codeMapCopy.graphNodesAria}>
                      <div className="graph-entity-section-header">
                        <strong>{codeMapCopy.graphNodesTitle}</strong>
                        <span>{codeMapCopy.realNodeCount(visibleNodes.length)}</span>
                      </div>
                      <div className="graph-node-list" aria-label={codeMapCopy.graphNodesAria}>
                        {visibleNodes.map((node) => {
                          if (isAggregatedGraphNode(node)) {
                            return (
                              <article className="graph-node-row aggregate" key={node.id}>
                                <span className="graph-node-copy">
                                  <strong>{node.name}</strong>
                                  <span>{formatGraphNodeTypeList(node.nodeTypes, props.appLanguage)}</span>
                                  <small>{codeMapCopy.aggregatedNodeSummary(node.aggregateCount, node.sourceRefs.length)}</small>
                                </span>
                                <span className="graph-node-command-rail">
                                  <small>{codeMapCopy.aggregateNodeLabel}</small>
                                </span>
                              </article>
                            );
                          }
                          const isHidden = hiddenNodeIds.includes(node.id);
                          const isMenuOpen = activeNodeMenuId === node.id;
                          const isMenuClosing = closingNodeMenuId === node.id;
                          const isMenuVisible = isMenuOpen || isMenuClosing;
                          const isCurrentGraphNodeEntity = selectedGraphSubject === 'node' && selectedGraphNode?.id === node.id;
                          const nodeActions = buildGraphNodeActionMenu(node, isHidden, props.appLanguage);
                          return (
                            <article
                              className={`graph-node-row${isCurrentGraphNodeEntity ? ' current-graph-entity-row' : ''}`}
                              aria-current={isCurrentGraphNodeEntity ? 'true' : undefined}
                              key={node.id}
                              onKeyDown={handleGraphNodeMenuKeyDown}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                openGraphNodeMenu(node.id);
                              }}
                            >
                              <button type="button" className="graph-node-copy" onClick={() => selectGraphNode(node.id)}>
                                <strong>{node.name}</strong>
                                <span>{formatGraphNodeType(node.nodeType, props.appLanguage)}</span>
                                <small>
                                  {node.sourceRef}:{String(node.metadata.lineStart ?? '?')}
                                </small>
                              </button>
                              <span className="graph-node-command-rail">
                                <button type="button" onClick={() => props.onCreateTaskFromNode?.(node.id)}>
                                  {codeMapCopy.createTaskFromNode}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    props.onOpenGraphSource?.({
                                      sourceRef: node.sourceRef,
                                      lineStart: typeof node.metadata.lineStart === 'number' ? node.metadata.lineStart : undefined,
                                    })
                                  }
                                >
                                  {codeMapCopy.openSource}
                                </button>
                                <button type="button" aria-pressed={isHidden} onClick={() => toggleNodeVisibility(node.id)}>
                                  {isHidden ? codeMapCopy.restoreNode : codeMapCopy.hideNode}
                                </button>
                                <button type="button" aria-expanded={isMenuOpen} onClick={() => toggleGraphNodeMenu(node.id)}>
                                  {codeMapCopy.openNodeMenu}
                                </button>
                              </span>
                              <div
                                className="graph-node-menu-row"
                                role="menu"
                                aria-label={codeMapCopy.nodeActionMenuAria}
                                hidden={!isMenuVisible}
                                data-motion-surface="popover"
                                data-motion-state={isMenuClosing ? 'closing' : isMenuOpen ? 'open' : undefined}
                              >
                                {nodeActions.map((action) => (
                                  <button key={action.id} type="button" role="menuitem" onClick={() => runNodeAction(node, action)}>
                                    {action.label}
                                  </button>
                                ))}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                    <section className="graph-entity-section" aria-label={codeMapCopy.graphEdgesAria}>
                      <div className="graph-entity-section-header">
                        <strong>{codeMapCopy.graphEdgesTitle}</strong>
                        <span>{codeMapCopy.realEdgeCount(visibleEdges.length)}</span>
                      </div>
                      <div className="graph-edge-list" aria-label={codeMapCopy.graphEdgesAria}>
                        {visibleEdges.map((edge) => {
                          const isCurrentGraphEdgeEntity = selectedGraphSubject === 'edge' && selectedGraphEdge?.id === edge.id;
                          return (
                            <div className={`graph-edge-row${isCurrentGraphEdgeEntity ? ' current-graph-entity-row' : ''}`} aria-current={isCurrentGraphEdgeEntity ? 'true' : undefined} key={edge.id}>
                              <button type="button" className="graph-edge-copy" onClick={() => selectGraphEdge(edge.id)}>
                                <strong>{formatGraphEdgeType(edge.edgeType, props.appLanguage)}</strong>
                                <span>{edge.sourceRef}</span>
                                {'aggregateCount' in edge && edge.aggregateCount > 1 ? <small>{codeMapCopy.aggregatedEdgeSummary(edge.aggregateCount, edge.sourceRefs.length)}</small> : null}
                              </button>
                              <span className="graph-edge-meta-rail">{typeof edge.confidence === 'number' ? <small>{codeMapCopy.confidenceValue(edge.confidence.toFixed(2))}</small> : <small>{codeMapCopy.confidenceUnknown}</small>}</span>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  </section>
                </section>
              </section>
            </aside>
          ) : null}
        </section>
        <footer className="code-map-status-bar" aria-label={codeMapCopy.performanceAria}>
          <span>
            <strong>{graphDrilldown ? `${graphDrilldown.label} · ${graphWorkbenchCopy.drilldownGraph}` : (uiCopy.graphViewTypes[props.graphView.viewType as GraphViewType] ?? props.graphView.title)}</strong>
            <span>
              {visibleArchitectureModel ? (
                <>
                  {graphWorkbenchCopy.currentVisible} {visibleArchitectureModel.objectCount} {props.appLanguage === 'zh-CN' ? '个架构对象' : 'architecture objects'} / {visibleArchitectureModel.dependencyEdges.length}{' '}
                  {props.appLanguage === 'zh-CN' ? '条依赖' : 'dependencies'}
                </>
              ) : (
                <>
                  {graphWorkbenchCopy.currentVisible} {visibleNodes.length} {graphWorkbenchCopy.nodeUnit} / {visibleEdges.length} {graphWorkbenchCopy.relationGroupUnit} ·{' '}
                  {graphWorkbenchCopy.representedRelations(visibleGraphStats.representedEdgeCount)}
                </>
              )}
            </span>
            <span>
              {graphWorkbenchCopy.loadedTotal} {activeGraphScope.nodes.length} {graphWorkbenchCopy.nodeUnit} / {activeGraphScope.edges.length} {graphWorkbenchCopy.relationUnit}
            </span>
            {visibleGraphStats.omittedEdgeGroupCount > 0 ? <span>{graphWorkbenchCopy.omittedRelations(visibleGraphStats.omittedEdgeGroupCount, visibleGraphStats.omittedRepresentedEdgeCount)}</span> : null}
            <span>{graphWorkbenchCopy.staticStructure}</span>
            {graphDrilldownLayout || props.graphView.layout ? <span>{formatGraphLayoutAlgorithm((graphDrilldownLayout ?? props.graphView.layout)!.algorithm, props.appLanguage)}</span> : null}
            {props.graphView.performance ? <span>{Math.round(props.graphView.performance.durationMs)}ms</span> : null}
          </span>
          <span className={props.scanState ?? 'idle'}>
            <i aria-hidden="true" />
            {scanStatusCopy}
          </span>
        </footer>
      </div>
    </section>
  );
}

export interface GraphNodeActionMenuItem {
  id: 'inspect-detail' | 'create-task' | 'open-source' | 'ask-node' | 'generate-sequence' | 'generate-flow' | 'expand-one-hop' | 'expand-two-hop' | 'toggle-visibility';
  label: string;
  sourceRef: string;
  lineStart: number | null;
}

export function buildGraphNodeActionMenu(node: GraphViewSnapshot['nodes'][number], hidden = false, appLanguage: AppLanguage = 'zh-CN'): GraphNodeActionMenuItem[] {
  const lineStart = typeof node.metadata.lineStart === 'number' ? node.metadata.lineStart : null;
  const actionCopy = getLanguageCopy(appLanguage).codeMapWorkspace.nodeActions;
  return [
    {
      id: 'inspect-detail',
      label: actionCopy.inspectDetail,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'open-source',
      label: actionCopy.openSource,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'ask-node',
      label: actionCopy.askNode,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'generate-sequence',
      label: actionCopy.generateSequence,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'generate-flow',
      label: actionCopy.generateFlow,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'expand-one-hop',
      label: actionCopy.expandOneHop,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'expand-two-hop',
      label: actionCopy.expandTwoHop,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'create-task',
      label: actionCopy.createTask,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'toggle-visibility',
      label: hidden ? actionCopy.restoreNode : actionCopy.hideNode,
      sourceRef: node.sourceRef,
      lineStart,
    },
  ];
}

export type AggregatedGraphNode = GraphViewSnapshot['nodes'][number] & {
  isAggregate: true;
  aggregateCount: number;
  nodeIds: string[];
  sourceRefs: string[];
  nodeTypes: string[];
};

export type AggregatedGraphEdge = GraphViewSnapshot['edges'][number] & {
  aggregateCount: number;
  sourceRefs: string[];
  edgeIds: string[];
};

export function buildGraphNeighborhoodSlice(input: { nodes: GraphViewSnapshot['nodes']; edges: GraphViewSnapshot['edges']; centerNodeId: string; depth: 1 | 2 }): {
  nodes: GraphViewSnapshot['nodes'];
  edges: GraphViewSnapshot['edges'];
} {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  if (!nodeIds.has(input.centerNodeId)) return { nodes: input.nodes, edges: input.edges };

  const adjacency = new Map<string, Set<string>>();
  for (const nodeId of nodeIds) adjacency.set(nodeId, new Set());
  for (const edge of input.edges) {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) continue;
    adjacency.get(edge.sourceNodeId)?.add(edge.targetNodeId);
    adjacency.get(edge.targetNodeId)?.add(edge.sourceNodeId);
  }

  const visibleNodeIds = new Set([input.centerNodeId]);
  let frontier = new Set([input.centerNodeId]);
  for (let step = 0; step < input.depth; step += 1) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      for (const neighborId of adjacency.get(nodeId) ?? []) {
        if (!visibleNodeIds.has(neighborId)) next.add(neighborId);
      }
    }
    for (const nodeId of next) visibleNodeIds.add(nodeId);
    frontier = next;
  }

  return {
    nodes: input.nodes.filter((node) => visibleNodeIds.has(node.id)),
    edges: input.edges.filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)),
  };
}

export function buildVisibleGraphSlice(input: {
  nodes: GraphViewSnapshot['nodes'];
  edges: GraphViewSnapshot['edges'];
  hiddenNodeIds: string[];
  maxNodes: number;
  maxEdges: number;
  showLowConfidenceEdges?: boolean;
  minConfidence?: number;
}): {
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  edges: AggregatedGraphEdge[];
  stats: {
    renderedEdgeGroupCount: number;
    representedEdgeCount: number;
    omittedEdgeGroupCount: number;
    omittedRepresentedEdgeCount: number;
  };
} {
  const hiddenNodeIds = new Set(input.hiddenNodeIds);
  const minConfidence = typeof input.minConfidence === 'number' ? normalizeGraphMinConfidence(input.minConfidence, input.showLowConfidenceEdges ? 0 : 1) : input.showLowConfidenceEdges ? 0 : 1;
  const nodes = buildAggregatedGraphNodes(
    input.nodes.filter((node) => !hiddenNodeIds.has(node.id)),
    input.maxNodes,
  );
  const visibleNodeIdBySourceNodeId = new Map<string, string>();
  for (const node of nodes) {
    if (isAggregatedGraphNode(node)) {
      for (const sourceNodeId of node.nodeIds) visibleNodeIdBySourceNodeId.set(sourceNodeId, node.id);
    } else {
      visibleNodeIdBySourceNodeId.set(node.id, node.id);
    }
  }
  const remappedEdges = input.edges.flatMap((edge) => {
    if (edge.confidence < minConfidence) return [];
    const sourceNodeId = visibleNodeIdBySourceNodeId.get(edge.sourceNodeId);
    const targetNodeId = visibleNodeIdBySourceNodeId.get(edge.targetNodeId);
    if (!sourceNodeId || !targetNodeId) return [];
    return [{ ...edge, sourceNodeId, targetNodeId }];
  });
  const allEdgeGroups = buildAggregatedGraphEdges(remappedEdges);
  const edges = allEdgeGroups.slice(0, Math.max(1, input.maxEdges));
  const representedEdgeCount = edges.reduce((count, edge) => count + edge.aggregateCount, 0);
  const totalRepresentedEdgeCount = allEdgeGroups.reduce((count, edge) => count + edge.aggregateCount, 0);
  return {
    nodes,
    edges,
    stats: {
      renderedEdgeGroupCount: edges.length,
      representedEdgeCount,
      omittedEdgeGroupCount: Math.max(0, allEdgeGroups.length - edges.length),
      omittedRepresentedEdgeCount: Math.max(0, totalRepresentedEdgeCount - representedEdgeCount),
    },
  };
}

export function buildGraphQuestionRequest(question: string): {
  question: string;
  canAsk: boolean;
} {
  const normalizedQuestion = question.trim();
  return {
    question: normalizedQuestion,
    canAsk: normalizedQuestion.length > 0,
  };
}

export interface GraphSearchFilterInput {
  query: string;
  nodeType?: string;
  edgeType?: string;
  minConfidence: number;
}

export function buildGraphSearchRequest(input: GraphSearchFilterInput): {
  query: string;
  nodeType?: string;
  edgeType?: string;
  minConfidence: number;
} {
  return {
    query: input.query.trim(),
    nodeType: input.nodeType?.trim() || undefined,
    edgeType: input.edgeType?.trim() || undefined,
    minConfidence: normalizeGraphMinConfidence(input.minConfidence, 1),
  };
}

export function normalizeGraphMinConfidence(value: string | number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return Math.min(1, Math.max(0, fallback));
  return Math.min(1, Math.max(0, Math.round(parsed * 100) / 100));
}

export function isAggregatedGraphNode(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): node is AggregatedGraphNode {
  return 'isAggregate' in node && node.isAggregate === true;
}

export function buildAggregatedGraphNodes(nodes: GraphViewSnapshot['nodes'], maxNodes: number): Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode> {
  const safeMaxNodes = Math.max(1, maxNodes);
  if (nodes.length <= safeMaxNodes) return nodes;
  const aggregateSlotCount = safeMaxNodes < 4 ? 1 : Math.min(4, Math.max(1, Math.floor(safeMaxNodes / 5)));
  const concreteNodeCount = Math.max(0, safeMaxNodes - aggregateSlotCount);
  const concreteNodes = nodes.slice(0, concreteNodeCount);
  const overflowNodes = nodes.slice(concreteNodeCount);
  const groups = new Map<string, { label: string; nodes: GraphViewSnapshot['nodes'] }>();
  for (const node of overflowNodes) {
    const sourceParts = node.sourceRef.split(/[\\/]/u).filter(Boolean);
    const sourceDirectories = sourceParts.slice(0, -1);
    const sourceArea = sourceDirectories.length > 1 ? sourceDirectories.slice(-2).join('/') : sourceDirectories[0] || node.nodeType;
    const key = `${sourceArea}::${node.nodeType}`;
    const group = groups.get(key) ?? { label: `${sourceArea} · ${node.nodeType}`, nodes: [] };
    group.nodes.push(node);
    groups.set(key, group);
  }
  const semanticGroups = [...groups.values()];
  const visibleGroups =
    semanticGroups.length <= aggregateSlotCount
      ? semanticGroups
      : [
          ...semanticGroups.slice(0, Math.max(0, aggregateSlotCount - 1)),
          {
            label: 'other · mixed',
            nodes: semanticGroups.slice(Math.max(0, aggregateSlotCount - 1)).flatMap((group) => group.nodes),
          },
        ];

  const aggregateNodes = visibleGroups.map((group, index): AggregatedGraphNode => {
    const sourceRefs = [...new Set(group.nodes.map((node) => node.sourceRef))];
    const nodeTypes = [...new Set(group.nodes.map((node) => node.nodeType))];
    const nodeIds = group.nodes.map((node) => node.id);
    const firstOverflow = group.nodes[0];
    const aggregateKey = buildGraphAggregateKey(nodeIds);
    // 聚合只压缩当前渲染模型；每个原节点仍保留到 nodeIds，边端点会在下一步同步重映射。
    return {
      id: `aggregate_${index}_${aggregateKey}`,
      nodeType: 'aggregate',
      name: `${group.label} · ${group.nodes.length}`,
      qualifiedName: `aggregate:${group.label}:${aggregateKey}`,
      sourceRef: firstOverflow?.sourceRef ?? '',
      symbolId: `aggregate_symbol_${index}_${aggregateKey}`,
      metadata: {
        aggregateCount: group.nodes.length,
        nodeIds,
        sourceRefs,
        nodeTypes,
      },
      isAggregate: true,
      aggregateCount: group.nodes.length,
      nodeIds,
      sourceRefs,
      nodeTypes,
    };
  });
  return [...concreteNodes, ...aggregateNodes];
}

function buildGraphAggregateKey(nodeIds: string[]): string {
  let hash = 2166136261;
  for (const nodeId of nodeIds) {
    for (let index = 0; index < nodeId.length; index += 1) {
      hash ^= nodeId.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(36);
}

export function buildAggregatedGraphEdges(edges: GraphViewSnapshot['edges']): AggregatedGraphEdge[] {
  const groups = new Map<string, AggregatedGraphEdge>();
  for (const edge of edges) {
    const key = `${edge.sourceNodeId}::${edge.targetNodeId}::${edge.edgeType}`;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        ...edge,
        aggregateCount: 1,
        sourceRefs: [edge.sourceRef],
        edgeIds: [edge.id],
      });
      continue;
    }
    current.aggregateCount += 1;
    current.edgeIds.push(edge.id);
    if (!current.sourceRefs.includes(edge.sourceRef)) current.sourceRefs.push(edge.sourceRef);
    current.confidence = Math.round(((current.confidence * (current.aggregateCount - 1) + edge.confidence) / current.aggregateCount) * 100) / 100;
  }
  return [...groups.values()];
}

function RuntimeXtermPane(props: { logs: AiRuntimeLogEntry[]; enabled: boolean; ariaLabel: string }) {
  const terminalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!props.enabled || !terminalRef.current || typeof window === 'undefined') return;
    let disposed = false;
    let terminal: import('@xterm/xterm').Terminal | undefined;
    void import('@xterm/xterm').then(({ Terminal }) => {
      if (disposed || !terminalRef.current) return;
      // xterm 只负责渲染已采集的真实 Runtime 日志；输入、resize、Ctrl-C 仍走后端审计 API。
      terminal = new Terminal({
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        rows: 10,
        cols: 120,
        theme: { background: '#0f172a', foreground: '#dbeafe' },
      });
      terminal.open(terminalRef.current);
      for (const entry of props.logs.slice(-80)) terminal.writeln(formatRuntimeLogLine(entry));
    });
    return () => {
      disposed = true;
      terminal?.dispose();
    };
  }, [props.enabled, props.logs]);

  if (!props.enabled) return null;
  return <div className="xterm-runtime-pane" aria-label={props.ariaLabel} ref={terminalRef} />;
}

type SigmaRendererInstance = { kill: () => void };
type GraphologyGraphInstance = {
  addNode: (key: string, attributes?: Record<string, unknown>) => void;
  addDirectedEdgeWithKey: (key: string, source: string, target: string, attributes?: Record<string, unknown>) => void;
};
type GraphologyGraphConstructor = new () => GraphologyGraphInstance;
type SigmaRendererConstructor = new (graph: GraphologyGraphInstance, container: HTMLElement, settings?: Record<string, unknown>) => SigmaRendererInstance;

export interface SigmaRuntimeGraphNode {
  key: string;
  attributes: {
    label: string;
    type: string;
    nodeType: string;
    sourceRef: string;
    x: number;
    y: number;
    size: number;
    color: string;
  };
}

export interface SigmaRuntimeGraph {
  nodes: SigmaRuntimeGraphNode[];
  edges: ReturnType<typeof toSigmaGraph>['edges'];
}

export function buildSigmaRuntimeGraph(input: {
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>;
  layout?: GraphViewSnapshot['layout'];
}): SigmaRuntimeGraph {
  const baseGraph = toSigmaGraph({ nodes: input.nodes, edges: input.edges });
  const width = normalizeGraphCanvasDimension(input.layout?.width, 720, 1440);
  const height = normalizeGraphCanvasDimension(input.layout?.height, 300, 900);
  const layout = buildGraphCanvasLayout(input.nodes, width, height, input.layout);

  return {
    ...baseGraph,
    nodes: baseGraph.nodes.map((node) => {
      const point = layout.get(node.key) ?? {
        x: Math.round(width / 2),
        y: Math.round(height / 2),
      };
      const nodeType = node.attributes.type;
      return {
        ...node,
        attributes: {
          ...node.attributes,
          type: 'circle',
          nodeType,
          // Sigma/WebGL 运行时要求 x/y 是真实数值；这里复用服务端布局或确定性前端布局，不生成演示节点。
          x: point.x,
          y: point.y,
          size: nodeType === 'aggregate' ? 11 : 8,
          color: sigmaNodeColor(nodeType),
        },
      };
    }),
  };
}

function sigmaNodeColor(nodeType: string): string {
  switch (nodeType) {
    case 'api':
      return '#4f46e5';
    case 'table':
    case 'column':
      return '#0f766e';
    case 'function':
      return '#7c3aed';
    case 'aggregate':
      return '#64748b';
    default:
      return '#2563eb';
  }
}

export function GraphRuntimeCanvas(props: {
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>;
  layout?: GraphViewSnapshot['layout'];
  appLanguage: AppLanguage;
  currentNodeId?: string | null;
  currentEdgeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
  onOpenGraphSource?: (source: { sourceRef: string; lineStart?: number }) => void;
  onCreateTaskFromNode?: (nodeId: string) => void;
}) {
  const copy = getLanguageCopy(props.appLanguage).codeMapWorkspace;
  const sigmaContainerRef = useRef<HTMLDivElement | null>(null);
  const reactFlowContainerRef = useRef<HTMLDivElement | null>(null);
  const sigmaGraph = useMemo(
    () =>
      buildSigmaRuntimeGraph({
        nodes: props.nodes,
        edges: props.edges,
        layout: props.layout,
      }),
    [props.nodes, props.edges, props.layout],
  );
  const reactFlowElements = useMemo(() => toReactFlowElements({ nodes: props.nodes, edges: props.edges }), [props.nodes, props.edges]);

  useEffect(() => {
    if (!sigmaContainerRef.current || props.nodes.length === 0 || typeof window === 'undefined') return undefined;
    let disposed = false;
    let sigmaRenderer: SigmaRendererInstance | undefined;

    void (async () => {
      const [{ default: Graph }, { default: Sigma }] = await Promise.all([
        import('graphology') as unknown as Promise<{
          default: GraphologyGraphConstructor;
        }>,
        import('sigma') as unknown as Promise<{
          default: SigmaRendererConstructor;
        }>,
        // 动态加载 React Flow 运行时，避免服务端静态渲染时访问浏览器 API。
        import('@xyflow/react'),
      ]);
      if (disposed || !sigmaContainerRef.current) return;
      const graph = new Graph();
      for (const node of sigmaGraph.nodes) graph.addNode(node.key, node.attributes);
      for (const edge of sigmaGraph.edges) graph.addDirectedEdgeWithKey(edge.key, edge.source, edge.target, edge.attributes);
      // Sigma/WebGL 只渲染真实转换后的 Graphology 图，不补造空节点或演示边。
      sigmaRenderer = new Sigma(graph, sigmaContainerRef.current, {
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: 12,
        allowInvalidContainer: true,
      });
      if (reactFlowContainerRef.current) reactFlowContainerRef.current.dataset.runtimeReady = 'true';
    })();

    return () => {
      disposed = true;
      sigmaRenderer?.kill();
    };
  }, [props.nodes.length, sigmaGraph]);

  if (props.nodes.length === 0) {
    return (
      <section className="graph-runtime-canvas" aria-label={copy.graphRuntime}>
        <article className="graph-runtime-pane" aria-label={copy.sigmaTitle}>
          <h3>{copy.sigmaTitle}</h3>
          <p>{copy.sigmaEmpty}</p>
        </article>
        <article className="graph-runtime-pane" aria-label={copy.reactFlowTitle}>
          <h3>{copy.reactFlowTitle}</h3>
          <p>{copy.reactFlowEmpty}</p>
        </article>
      </section>
    );
  }

  return (
    <section className="graph-runtime-canvas" aria-label={copy.graphRuntime}>
      <article className="graph-runtime-pane" aria-label={copy.sigmaTitle}>
        <div className="graph-canvas-header">
          <h3>{copy.sigmaTitle}</h3>
          <span>
            {copy.nodeCount(sigmaGraph.nodes.length)} · {copy.edgeCount(sigmaGraph.edges.length)}
          </span>
        </div>
        <div className="graph-runtime-mount" data-runtime="sigma" ref={sigmaContainerRef} />
        <div className="graph-runtime-facts" aria-label={copy.sigmaSourceAria}>
          {sigmaGraph.nodes.slice(0, 4).map((node) => (
            <span key={node.key}>{node.attributes.label}</span>
          ))}
          {sigmaGraph.edges.slice(0, 3).map((edge) => (
            <small key={edge.key}>
              {formatGraphEdgeType(edge.attributes.label, props.appLanguage)} {edge.attributes.confidence.toFixed(2)}
            </small>
          ))}
        </div>
      </article>
      <article className="graph-runtime-pane" aria-label={copy.reactFlowTitle}>
        <div className="graph-canvas-header">
          <h3>{copy.reactFlowTitle}</h3>
          <span>
            {copy.nodeCount(reactFlowElements.nodes.length)} · {copy.edgeCount(reactFlowElements.edges.length)}
          </span>
        </div>
        <div className="graph-runtime-mount" data-runtime="react-flow" ref={reactFlowContainerRef}>
          {reactFlowElements.nodes.slice(0, 5).map((node) => (
            <button
              type="button"
              className={`react-flow-node-summary${props.currentNodeId === String(node.id) ? ' current-graph-runtime-object' : ''}`}
              data-react-flow-node-id={node.id}
              aria-current={props.currentNodeId === String(node.id) ? 'true' : undefined}
              onClick={() => props.onSelectNode?.(String(node.id))}
              key={node.id}
            >
              <strong>{node.data.label}</strong>
              <span>{formatGraphNodeType(String(node.type), props.appLanguage)}</span>
              <small>{node.data.sourceRef}</small>
            </button>
          ))}
        </div>
        <div className="graph-runtime-facts" aria-label={copy.reactFlowEdgesAria}>
          {reactFlowElements.edges.slice(0, 4).map((edge) => (
            <button
              type="button"
              className={`react-flow-edge-summary${props.currentEdgeId === String(edge.id) ? ' current-graph-runtime-object' : ''}`}
              data-react-flow-edge-id={edge.id}
              aria-current={props.currentEdgeId === String(edge.id) ? 'true' : undefined}
              onClick={() => props.onSelectEdge?.(String(edge.id))}
              key={edge.id}
            >
              {formatGraphRuntimeEdgeLabel(String(edge.label ?? ''), props.appLanguage)}
            </button>
          ))}
        </div>
      </article>
    </section>
  );
}

function GraphCanvas(props: {
  title?: string;
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>;
  layout?: GraphViewSnapshot['layout'];
  viewType?: GraphViewType;
  appLanguage: AppLanguage;
  currentNodeId?: string | null;
  currentEdgeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
  onClearSelection?: () => void;
  onOpenGraphSource?: (source: { sourceRef: string; lineStart?: number }) => void;
  onCreateTaskFromNode?: (nodeId: string) => void;
}) {
  const copy = getLanguageCopy(props.appLanguage).codeMapWorkspace;
  const interactionCopy =
    props.appLanguage === 'zh-CN'
      ? {
          zoomOut: '缩小图谱',
          zoomIn: '放大图谱',
          fit: '适配',
          minimap: '图谱小地图',
        }
      : {
          zoomOut: 'Zoom out',
          zoomIn: 'Zoom in',
          fit: 'Fit',
          minimap: 'Graph minimap',
        };
  const isSequenceGraphView = props.viewType === 'api_sequence' || props.viewType === 'method_logic';
  const sourceWidth = normalizeGraphCanvasDimension(props.layout?.width, 720, 1440);
  const sourceHeight = normalizeGraphCanvasDimension(props.layout?.height, 300, 900);
  // 时序图世界坐标随生命线与消息数量增长，视口仍由 viewBox 控制，避免把大型链路压进固定 1440×900 后相互覆盖。
  const width = isSequenceGraphView ? Math.max(sourceWidth, props.nodes.length * 150 + 120) : sourceWidth;
  const height = isSequenceGraphView ? Math.max(sourceHeight, props.edges.length * 42 + 150) : sourceHeight;
  const layout = useMemo(() => buildGraphCanvasLayout(props.nodes, width, height, props.layout), [height, props.layout, props.nodes, width]);
  const visibleEdges = useMemo(() => {
    const visibleNodeIds = new Set(props.nodes.map((node) => node.id));
    return props.edges
      .filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId))
      .map(
        (edge): AggregatedGraphEdge =>
          'aggregateCount' in edge
            ? edge
            : {
                ...edge,
                aggregateCount: 1,
                sourceRefs: [edge.sourceRef],
                edgeIds: [edge.id],
              },
      );
  }, [props.edges, props.nodes]);
  const baseViewport = useMemo(() => buildGraphCanvasViewport(layout, props.nodes.length, width, height, isSequenceGraphView), [height, isSequenceGraphView, layout, props.nodes.length, width]);
  const graphModelKey = useMemo(() => `${props.viewType ?? 'graph'}:${props.nodes.map((node) => node.id).join('|')}:${visibleEdges.map((edge) => edge.id).join('|')}`, [props.nodes, props.viewType, visibleEdges]);
  const [camera, setCamera] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const cameraDragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    panX: number;
    panY: number;
    viewportWidth: number;
    viewportHeight: number;
    elementWidth: number;
    elementHeight: number;
  } | null>(null);
  const canvasLabel = isSequenceGraphView ? copy.sequenceGraphCanvas : copy.graphCanvas;
  const canvasTitle = isSequenceGraphView ? canvasLabel : props.title?.trim() || canvasLabel;
  const cameraViewport = {
    x: baseViewport.x + camera.panX + (baseViewport.width - baseViewport.width / camera.zoom) / 2,
    y: baseViewport.y + camera.panY + (baseViewport.height - baseViewport.height / camera.zoom) / 2,
    width: baseViewport.width / camera.zoom,
    height: baseViewport.height / camera.zoom,
  };

  useEffect(() => {
    setCamera({ zoom: 1, panX: 0, panY: 0 });
    setIsPanning(false);
    cameraDragRef.current = null;
  }, [graphModelKey]);

  const setGraphZoom = (nextZoom: number): void => {
    setCamera((current) => ({
      ...current,
      zoom: Math.min(2.4, Math.max(0.6, Math.round(nextZoom * 10) / 10)),
    }));
  };

  const fitGraphCanvas = (): void => {
    setCamera({ zoom: 1, panX: 0, panY: 0 });
  };

  const handleGraphCanvasPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    props.onClearSelection?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    cameraDragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panX: camera.panX,
      panY: camera.panY,
      viewportWidth: cameraViewport.width,
      viewportHeight: cameraViewport.height,
      elementWidth: Math.max(1, bounds.width),
      elementHeight: Math.max(1, bounds.height),
    };
    setIsPanning(true);
  };

  const handleGraphCanvasPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = cameraDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextPanX = drag.panX - ((event.clientX - drag.clientX) / drag.elementWidth) * drag.viewportWidth;
    const nextPanY = drag.panY - ((event.clientY - drag.clientY) / drag.elementHeight) * drag.viewportHeight;
    setCamera((current) => ({
      ...current,
      panX: Math.max(-baseViewport.width, Math.min(baseViewport.width, nextPanX)),
      panY: Math.max(-baseViewport.height, Math.min(baseViewport.height, nextPanY)),
    }));
  };

  const finishGraphCanvasPan = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (cameraDragRef.current?.pointerId !== event.pointerId) return;
    cameraDragRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleGraphCanvasWheel = (event: ReactWheelEvent<SVGSVGElement>): void => {
    event.preventDefault();
    setGraphZoom(camera.zoom + (event.deltaY < 0 ? 0.1 : -0.1));
  };

  const canvasControls = (
    <nav className="graph-canvas-controls" aria-label={canvasLabel}>
      <button type="button" aria-label={interactionCopy.zoomOut} onClick={() => setGraphZoom(camera.zoom - 0.1)}>
        −
      </button>
      <output aria-live="polite">{Math.round(camera.zoom * 100)}%</output>
      <button type="button" aria-label={interactionCopy.zoomIn} onClick={() => setGraphZoom(camera.zoom + 0.1)}>
        ＋
      </button>
      <button type="button" onClick={fitGraphCanvas}>
        {interactionCopy.fit}
      </button>
    </nav>
  );

  if (props.nodes.length === 0) {
    return (
      <section className="graph-canvas" aria-label={copy.graphCanvas}>
        <div className="graph-canvas-empty">
          <h3>{canvasTitle}</h3>
          <p>{copy.canvasEmpty}</p>
        </div>
      </section>
    );
  }

  if (props.viewType === 'architecture') {
    return (
      <ArchitectureGraphCanvas
        model={buildArchitectureLayerModel(props.nodes, visibleEdges, props.title)}
        appLanguage={props.appLanguage}
        zoom={camera.zoom}
        controls={canvasControls}
        currentNodeId={props.currentNodeId}
        currentEdgeId={props.currentEdgeId}
        onSelectNode={props.onSelectNode}
        onSelectEdge={props.onSelectEdge}
        onClearSelection={props.onClearSelection}
        onOpenGraphSource={props.onOpenGraphSource}
      />
    );
  }

  // 接口时序图与方法逻辑图都使用同一套交互式时序舞台，避免方法调用链回退成普通节点云。
  if (isSequenceGraphView) {
    const sequenceLayout = buildGraphSequenceCanvasLayout(props.nodes, visibleEdges, width, height, props.appLanguage);
    const handleSequenceNodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, nodeId: string): void => {
      const node = props.nodes.find((item) => item.id === nodeId);
      if (event.key.toLowerCase() === 'o' && node) {
        event.preventDefault();
        openGraphSequenceNodeSource(node);
        return;
      }
      if (event.key.toLowerCase() === 't' && node) {
        event.preventDefault();
        createGraphSequenceNodeTask(node);
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      props.onSelectNode?.(nodeId);
    };
    const handleSequenceEdgeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, edgeId: string): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      props.onSelectEdge?.(edgeId);
    };
    const handleSequenceFragmentKeyDown = (event: ReactKeyboardEvent<SVGGElement>, edgeId: string): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      props.onSelectEdge?.(edgeId);
    };
    const handleSequenceFragmentOperandKeyDown = (event: ReactKeyboardEvent<SVGGElement>, edgeId: string): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      props.onSelectEdge?.(edgeId);
    };
    const openGraphSequenceNodeSource = (node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): void => {
      const sourceRef = resolveGraphSequenceNodeSourceRef(node);
      if (!sourceRef) return;
      const lineStart = resolveGraphSequenceNodeLineStart(node);
      // 时序图节点直接复用 main 进程的安全源码打开通道，不在 renderer 拼绝对路径或绕过项目根目录校验。
      props.onOpenGraphSource?.({
        sourceRef,
        lineStart: typeof lineStart === 'number' ? lineStart : undefined,
      });
    };
    const createGraphSequenceNodeTask = (node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): void => {
      if (isAggregatedGraphNode(node)) return;
      // 时序图节点直接复用图谱节点创建任务能力，让“看懂调用链”后的下一步进入任务列表主路径。
      props.onCreateTaskFromNode?.(node.id);
    };

    return (
      <section className="graph-canvas graph-sequence-stage" aria-label={canvasLabel}>
        <svg
          className={`graph-canvas-svg graph-sequence-svg${isPanning ? ' is-panning' : ''}`}
          role="group"
          aria-label={canvasLabel}
          viewBox={`${cameraViewport.x} ${cameraViewport.y} ${cameraViewport.width} ${cameraViewport.height}`}
          onPointerDown={handleGraphCanvasPointerDown}
          onPointerMove={handleGraphCanvasPointerMove}
          onPointerUp={finishGraphCanvasPan}
          onPointerCancel={finishGraphCanvasPan}
          onWheel={handleGraphCanvasWheel}
        >
          <defs>
            <marker id="graph-sequence-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          </defs>
          {sequenceLayout.fragments.map((fragment) => {
            return (
              <g
                className={`graph-sequence-fragment graph-sequence-fragment-${fragment.kind}${props.currentEdgeId === fragment.edgeIds[0] ? ' current-graph-canvas-object' : ''}`}
                data-sequence-fragment-kind={fragment.kind}
                data-sequence-fragment-guard={fragment.guardText ?? undefined}
                data-sequence-fragment-edge-count={String(fragment.edgeCount)}
                data-sequence-fragment-operand-count={String(fragment.operands.length)}
                data-sequence-fragment-edge-id={fragment.edgeIds[0]}
                data-sequence-fragment-inferred="true"
                key={fragment.id}
                role="button"
                tabIndex={0}
                aria-current={props.currentEdgeId === fragment.edgeIds[0] ? 'true' : undefined}
                aria-keyshortcuts="Enter Space"
                aria-label={`${fragment.label}${fragment.guardText ? ` · ${fragment.guardText}` : ''}`}
                onClick={() => props.onSelectEdge?.(fragment.edgeIds[0])}
                onKeyDown={(event) => handleSequenceFragmentKeyDown(event, fragment.edgeIds[0])}
              >
                <rect x={fragment.x} y={fragment.y} width={fragment.width} height={fragment.height} rx="8" />
                <rect className="graph-sequence-fragment-label-box" x={fragment.x + 8} y={fragment.y + 5} width={fragment.labelWidth} height="22" rx="5" />
                <text className="graph-sequence-fragment-label" x={fragment.x + 16} y={fragment.y + 20}>
                  {fragment.label}
                </text>
                {fragment.guardText ? (
                  <text className="graph-sequence-fragment-guard" x={fragment.x + 22 + fragment.label.length * 9} y={fragment.y + 20}>
                    {fragment.guardText}
                  </text>
                ) : null}
                {renderGraphSequenceFragmentOperands(fragment, props.appLanguage, props.onSelectEdge, handleSequenceFragmentOperandKeyDown)}
              </g>
            );
          })}
          {props.nodes.map((node) => {
            const lane = sequenceLayout.lifelines.get(node.id);
            if (!lane) return null;
            return (
              <g
                className={`graph-sequence-lifeline ${node.nodeType}${props.currentNodeId === node.id ? ' current-graph-canvas-object' : ''}`}
                key={node.id}
                role="button"
                tabIndex={0}
                aria-current={props.currentNodeId === node.id ? 'true' : undefined}
                aria-keyshortcuts={isAggregatedGraphNode(node) ? 'Enter Space' : 'Enter Space O T'}
                data-graph-node-id={node.id}
                data-graph-source-ref={resolveGraphSequenceNodeSourceRef(node)}
                data-graph-source-line={resolveGraphSequenceNodeLineStart(node) ?? undefined}
                aria-label={`${node.name} · ${formatGraphNodeType(node.nodeType, props.appLanguage)}`}
                onClick={() => props.onSelectNode?.(node.id)}
                onDoubleClick={() => openGraphSequenceNodeSource(node)}
                onKeyDown={(event) => handleSequenceNodeKeyDown(event, node.id)}
              >
                <rect className="graph-sequence-node-box" x={lane.x - lane.width / 2} y="22" width={lane.width} height="40" rx="6" />
                <text className="graph-sequence-node-name" x={lane.x} y="43">
                  {node.name}
                </text>
                <line className="graph-sequence-node-line" x1={lane.x} y1="72" x2={lane.x} y2={height - 28} />
                <title>
                  {isAggregatedGraphNode(node)
                    ? `${node.qualifiedName} · ${copy.aggregatedNodeSummary(node.aggregateCount, node.sourceRefs.length)}`
                    : `${node.qualifiedName} · ${resolveGraphSequenceNodeSourceRef(node)} · ${copy.openSourceShortcut} · ${copy.createTaskShortcut}`}
                </title>
              </g>
            );
          })}
          {sequenceLayout.activations.map((activation) => (
            <rect className="graph-sequence-activation" key={`${activation.nodeId}-${activation.y}`} x={activation.x - 5} y={activation.y} width="10" height={activation.height} rx="4" />
          ))}
          {visibleEdges.map((edge, index) => {
            const message = sequenceLayout.messages.get(edge.id);
            if (!message) return null;
            return (
              <g
                className={`graph-sequence-message${message.kind === 'self' ? ' graph-sequence-self-message' : ''}${message.kind === 'return' ? ' graph-sequence-return-message' : ''}${props.currentEdgeId === edge.id ? ' current-graph-canvas-object' : ''}`}
                key={edge.id}
                role="button"
                tabIndex={0}
                aria-current={props.currentEdgeId === edge.id ? 'true' : undefined}
                aria-keyshortcuts="Enter Space"
                data-graph-edge-id={edge.id}
                aria-label={formatGraphEdgeWithConfidence(edge, props.appLanguage)}
                onClick={() => props.onSelectEdge?.(edge.id)}
                onKeyDown={(event) => handleSequenceEdgeKeyDown(event, edge.id)}
              >
                {message.kind === 'self' ? (
                  <path d={`M ${message.sourceX} ${message.y} H ${message.loopX} V ${message.loopBottomY} H ${message.sourceX + 8}`} markerEnd="url(#graph-sequence-arrow)" />
                ) : (
                  <line x1={message.sourceX} y1={message.y} x2={message.targetX} y2={message.y} markerEnd="url(#graph-sequence-arrow)" />
                )}
                <text x={message.kind === 'self' ? (message.sourceX + message.loopX) / 2 : (message.sourceX + message.targetX) / 2} y={message.y - 8}>
                  {`${index + 1}: ${formatGraphEdgeWithConfidence(edge, props.appLanguage)}`}
                  {/* 来源数量是 UI 文案，必须跟随当前语言；真实 sourceRef 路径仍保持原文。 */}
                  {edge.sourceRefs.length > 1 ? ` · ${copy.sourceCount(edge.sourceRefs.length)}` : ''}
                </text>
              </g>
            );
          })}
        </svg>
        {canvasControls}
      </section>
    );
  }

  const handleGraphCanvasNodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): void => {
    if (event.key.toLowerCase() === 'o') {
      event.preventDefault();
      openGraphCanvasNodeSource(node);
      return;
    }
    if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      createGraphCanvasNodeTask(node);
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    props.onSelectNode?.(node.id);
  };
  const openGraphCanvasNodeSource = (node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): void => {
    const sourceRef = resolveGraphCanvasNodeSourceRef(node);
    if (!sourceRef) return;
    const lineStart = resolveGraphCanvasNodeLineStart(node);
    // 普通图谱节点和时序图 lifeline 使用同一条安全源码打开通道，避免用户必须先跳去右侧实体列表才能继续追代码。
    props.onOpenGraphSource?.({
      sourceRef,
      lineStart: typeof lineStart === 'number' ? lineStart : undefined,
    });
  };
  const createGraphCanvasNodeTask = (node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): void => {
    if (isAggregatedGraphNode(node)) return;
    // 方法逻辑图、模块图等普通节点也能直接进入任务主路径，保持“图谱是代码页主角”的交互闭环。
    props.onCreateTaskFromNode?.(node.id);
  };
  return (
    <section className="graph-canvas" aria-label={copy.graphCanvas}>
      <svg
        className={`graph-canvas-svg${isPanning ? ' is-panning' : ''}`}
        role="group"
        aria-label={copy.graphCanvas}
        viewBox={`${cameraViewport.x} ${cameraViewport.y} ${cameraViewport.width} ${cameraViewport.height}`}
        onPointerDown={handleGraphCanvasPointerDown}
        onPointerMove={handleGraphCanvasPointerMove}
        onPointerUp={finishGraphCanvasPan}
        onPointerCancel={finishGraphCanvasPan}
        onWheel={handleGraphCanvasWheel}
      >
        <defs>
          <marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>
        {visibleEdges.map((edge) => {
          const source = layout.get(edge.sourceNodeId);
          const target = layout.get(edge.targetNodeId);
          if (!source || !target) return null;
          const geometry = buildGraphCanvasEdgeGeometry(source, target, edge.sourceNodeId === edge.targetNodeId);
          return (
            <g
              className={`graph-canvas-edge${props.currentEdgeId === edge.id ? ' current-graph-canvas-object' : ''}`}
              key={edge.id}
              role="button"
              tabIndex={0}
              aria-current={props.currentEdgeId === edge.id ? 'true' : undefined}
              aria-keyshortcuts="Enter Space"
              data-graph-edge-id={edge.id}
              aria-label={formatGraphEdgeWithConfidence(edge, props.appLanguage)}
              onClick={(event) => {
                event.stopPropagation();
                props.onSelectEdge?.(edge.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                props.onSelectEdge?.(edge.id);
              }}
            >
              {geometry.kind === 'loop' ? <path d={geometry.path} markerEnd="url(#graph-arrow)" /> : <line x1={geometry.x1} y1={geometry.y1} x2={geometry.x2} y2={geometry.y2} markerEnd="url(#graph-arrow)" />}
              <text x={geometry.labelX} y={geometry.labelY}>
                {formatGraphEdgeWithConfidence(edge, props.appLanguage)}
                {/* 来源数量是 UI 文案，必须跟随当前语言；真实 sourceRef 路径仍保持原文。 */}
                {edge.sourceRefs.length > 1 ? ` · ${copy.sourceCount(edge.sourceRefs.length)}` : ''}
              </text>
            </g>
          );
        })}
        {props.nodes.map((node) => {
          const point = layout.get(node.id);
          if (!point) return null;
          return (
            <g
              className={`graph-canvas-node ${node.nodeType}${props.currentNodeId === node.id ? ' current-graph-canvas-object' : ''}`}
              key={node.id}
              transform={`translate(${point.x} ${point.y})`}
              role="button"
              tabIndex={0}
              aria-current={props.currentNodeId === node.id ? 'true' : undefined}
              aria-keyshortcuts={isAggregatedGraphNode(node) ? 'Enter Space' : 'Enter Space O T'}
              data-graph-node-id={node.id}
              data-graph-source-ref={resolveGraphCanvasNodeSourceRef(node)}
              data-graph-source-line={resolveGraphCanvasNodeLineStart(node) ?? undefined}
              aria-label={`${node.name} · ${formatGraphNodeType(node.nodeType, props.appLanguage)}`}
              onClick={(event) => {
                event.stopPropagation();
                props.onSelectNode?.(node.id);
              }}
              onDoubleClick={() => openGraphCanvasNodeSource(node)}
              onKeyDown={(event) => handleGraphCanvasNodeKeyDown(event, node)}
            >
              <rect className="graph-canvas-node-surface" x="-78" y="-30" width="156" height="60" rx="9" />
              <rect className="graph-canvas-node-kind" x="-78" y="-30" width="5" height="60" rx="3" />
              <text className="graph-canvas-node-name" x="-63" y="-4">
                {node.name.length > 24 ? `${node.name.slice(0, 23)}…` : node.name}
              </text>
              <text className="graph-canvas-node-type" x="-63" y="15">
                {formatGraphNodeType(node.nodeType, props.appLanguage)}
              </text>
              <title>
                {isAggregatedGraphNode(node)
                  ? `${node.qualifiedName} · ${copy.aggregatedNodeSummary(node.aggregateCount, node.sourceRefs.length)}`
                  : `${node.qualifiedName} · ${resolveGraphCanvasNodeSourceRef(node)} · ${copy.openSourceShortcut} · ${copy.createTaskShortcut}`}
              </title>
            </g>
          );
        })}
      </svg>
      {props.nodes.length > 6 ? (
        <button type="button" className="graph-canvas-minimap" aria-label={`${interactionCopy.minimap} · ${interactionCopy.fit}`} onClick={fitGraphCanvas}>
          <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {visibleEdges.map((edge) => {
              const source = layout.get(edge.sourceNodeId);
              const target = layout.get(edge.targetNodeId);
              if (!source || !target) return null;
              return <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} />;
            })}
            {props.nodes.map((node) => {
              const point = layout.get(node.id);
              return point ? <circle key={node.id} cx={point.x} cy={point.y} r={Math.max(7, width / 90)} /> : null;
            })}
            <rect className="graph-canvas-minimap-viewport" x={cameraViewport.x} y={cameraViewport.y} width={cameraViewport.width} height={cameraViewport.height} />
          </svg>
        </button>
      ) : null}
      {canvasControls}
    </section>
  );
}

function buildGraphCanvasEdgeGeometry(
  source: { x: number; y: number },
  target: { x: number; y: number },
  selfLoop: boolean,
): { kind: 'loop'; path: string; labelX: number; labelY: number } | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; labelX: number; labelY: number } {
  if (selfLoop) {
    return {
      kind: 'loop',
      path: `M ${source.x + 78} ${source.y} C ${source.x + 72} ${source.y - 58}, ${source.x + 20} ${source.y - 74}, ${source.x} ${source.y - 30}`,
      labelX: source.x + 38,
      labelY: source.y - 52,
    };
  }
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  const horizontalIntersection = Math.abs(deltaX) > 0 ? 78 / Math.abs(deltaX) : Number.POSITIVE_INFINITY;
  const verticalIntersection = Math.abs(deltaY) > 0 ? 30 / Math.abs(deltaY) : Number.POSITIVE_INFINITY;
  const intersectionScale = Math.min(0.49, horizontalIntersection, verticalIntersection);
  const x1 = source.x + deltaX * intersectionScale;
  const y1 = source.y + deltaY * intersectionScale;
  const x2 = target.x - deltaX * intersectionScale;
  const y2 = target.y - deltaY * intersectionScale;
  return {
    kind: 'line',
    x1,
    y1,
    x2,
    y2,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2 - 8,
  };
}

function resolveGraphCanvasNodeSourceRef(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): string {
  if (isAggregatedGraphNode(node)) return '';
  return node.sourceRef;
}

function resolveGraphCanvasNodeLineStart(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): number | null {
  if (isAggregatedGraphNode(node)) return null;
  return typeof node.metadata?.lineStart === 'number' ? node.metadata.lineStart : null;
}

type GraphSequenceLane = { x: number; width: number };
type GraphSequenceMessage =
  | { kind: 'call'; sourceX: number; targetX: number; y: number }
  | { kind: 'return'; sourceX: number; targetX: number; y: number }
  | { kind: 'self'; sourceX: number; targetX: number; y: number; loopX: number; loopBottomY: number };
type GraphSequenceActivation = { nodeId: string; x: number; y: number; height: number };
type GraphSequenceFragmentKind = 'alt' | 'loop' | 'catch' | 'finally' | 'branch';
type GraphSequenceFragmentOperand = { guardText: string; y: number; edgeId: string };
type GraphSequenceFragment = {
  id: string;
  kind: GraphSequenceFragmentKind;
  label: string;
  guardText: string | null;
  operands: GraphSequenceFragmentOperand[];
  edgeIds: string[];
  edgeCount: number;
  labelWidth: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

function resolveGraphSequenceNodeSourceRef(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): string {
  if (isAggregatedGraphNode(node)) return '';
  return node.sourceRef;
}

function resolveGraphSequenceNodeLineStart(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): number | null {
  if (isAggregatedGraphNode(node)) return null;
  const lineStart = node.metadata.lineStart;
  return typeof lineStart === 'number' ? lineStart : null;
}

function renderGraphSequenceFragmentOperands(
  fragment: GraphSequenceFragment,
  appLanguage: AppLanguage,
  onSelectEdge: ((edgeId: string) => void) | undefined,
  onOperandKeyDown: (event: ReactKeyboardEvent<SVGGElement>, edgeId: string) => void,
): ReactNode {
  if (fragment.kind !== 'alt' || fragment.operands.length < 2) return null;

  return fragment.operands.map((operand, index) => (
    <g
      className="graph-sequence-fragment-operand"
      data-sequence-fragment-operand={operand.guardText}
      data-sequence-fragment-operand-edge-id={operand.edgeId}
      key={`${fragment.id}-operand-${index}`}
      role="button"
      tabIndex={0}
      aria-label={formatGraphSequenceOperandAriaLabel(fragment.label, operand.guardText, appLanguage)}
      onClick={(event) => {
        event.stopPropagation();
        onSelectEdge?.(operand.edgeId);
      }}
      onKeyDown={(event) => onOperandKeyDown(event, operand.edgeId)}
    >
      {index > 0 ? <line className="graph-sequence-fragment-operand-line" x1={fragment.x + 8} x2={fragment.x + fragment.width - 8} y1={Math.max(fragment.y + 36, operand.y - 28)} y2={Math.max(fragment.y + 36, operand.y - 28)} /> : null}
      {/* 聚合 alt frame 内继续保留每个 guard 分支标签，避免多分支被压成一个不可读标题。 */}
      <text className="graph-sequence-fragment-operand-label" x={fragment.x + 16} y={operand.y}>
        {operand.guardText}
      </text>
    </g>
  ));
}

function formatGraphSequenceOperandAriaLabel(label: string, guardText: string, appLanguage: AppLanguage): string {
  return appLanguage === 'zh-CN' ? `${label} 分支 · ${guardText}` : `${label} operand · ${guardText}`;
}

function buildGraphSequenceCanvasLayout(nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>, edges: AggregatedGraphEdge[], width: number, height: number, appLanguage: AppLanguage) {
  const lifelines = new Map<string, GraphSequenceLane>();
  const messages = new Map<string, GraphSequenceMessage>();
  const activations: GraphSequenceActivation[] = [];
  const horizontalInset = Math.min(84, Math.max(42, width * 0.08));
  const usableWidth = Math.max(1, width - horizontalInset * 2);
  const laneStep = nodes.length <= 1 ? 0 : usableWidth / (nodes.length - 1);

  nodes.forEach((node, index) => {
    lifelines.set(node.id, {
      x: Math.round(horizontalInset + laneStep * index),
      width: Math.min(168, Math.max(92, Math.round(usableWidth / Math.max(2, nodes.length)))),
    });
  });

  const messageStartY = 92;
  const messageStep = Math.max(34, Math.min(58, Math.floor((height - 140) / Math.max(1, edges.length))));
  edges.forEach((edge, index) => {
    const source = lifelines.get(edge.sourceNodeId);
    const target = lifelines.get(edge.targetNodeId);
    if (!source || !target) return;
    const y = Math.min(height - 44, messageStartY + index * messageStep);
    if (edge.sourceNodeId === edge.targetNodeId) {
      const loopX = Math.min(width - 24, source.x + Math.min(96, Math.max(54, source.width * 0.56)));
      messages.set(edge.id, {
        kind: 'self',
        sourceX: source.x,
        targetX: target.x,
        y,
        loopX,
        loopBottomY: Math.min(height - 36, y + Math.max(26, Math.min(42, messageStep * 0.72))),
      });
    } else if (isGraphSequenceReturnEdge(edge)) {
      messages.set(edge.id, {
        kind: 'return',
        sourceX: source.x,
        targetX: target.x,
        y,
      });
    } else {
      messages.set(edge.id, {
        kind: 'call',
        sourceX: source.x,
        targetX: target.x,
        y,
      });
    }
    // 激活条表达“此 lifeline 正在处理调用”，让 API 时序图从平面连线升级为接近 IDEA SequenceDiagram 的执行语义。
    activations.push({
      nodeId: edge.targetNodeId,
      x: target.x,
      y: Math.max(62, y - 12),
      height: Math.max(28, Math.min(46, messageStep + 8)),
    });
  });

  const fragments = buildGraphSequenceFragments(edges, lifelines, messages, new Map(nodes.map((node) => [node.id, node])), width, height, appLanguage);

  return { lifelines, messages, activations, fragments };
}

function buildGraphSequenceFragments(
  edges: AggregatedGraphEdge[],
  lifelines: Map<string, GraphSequenceLane>,
  messages: Map<string, GraphSequenceMessage>,
  nodesById: Map<string, GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>,
  width: number,
  height: number,
  appLanguage: AppLanguage,
): GraphSequenceFragment[] {
  const fragments = edges.flatMap((edge) => {
    if (!isGraphSequenceBranchEdge(edge, nodesById)) return [];
    const source = lifelines.get(edge.sourceNodeId);
    const target = lifelines.get(edge.targetNodeId);
    const message = messages.get(edge.id);
    if (!source || !target || !message) return [];
    const left = Math.max(18, Math.min(source.x, target.x) - 26);
    const right = Math.min(width - 18, Math.max(source.x, target.x) + 26);
    const top = Math.max(64, message.y - 28);
    const bottom = Math.min(height - 30, message.y + 46);

    const kind = resolveGraphSequenceFragmentKind(edge, nodesById);
    const fragmentKindLabel = formatGraphSequenceFragmentLabel(kind, appLanguage);
    // 当前 fragment 来自静态节点/关系名称推导，直接写入可见标签，不能冒充运行时或显式语法事实。
    const label = appLanguage === 'zh-CN' ? `${fragmentKindLabel} · 静态推导` : `${fragmentKindLabel} · inferred`;
    const guardText = formatGraphSequenceFragmentGuard(kind, edge, nodesById);

    return [
      {
        id: `${edge.id}-fragment`,
        kind,
        label,
        guardText,
        operands: guardText ? [{ guardText, y: Math.min(bottom - 12, message.y + 16), edgeId: edge.id }] : [],
        edgeIds: [edge.id],
        edgeCount: 1,
        labelWidth: Math.max(34, label.length * 9 + 18 + (guardText ? guardText.length * 7 + 8 : 0)),
        x: left,
        y: top,
        width: Math.max(92, right - left),
        height: Math.max(50, bottom - top),
      },
    ];
  });

  return mergeGraphSequenceFragments(fragments);
}

function mergeGraphSequenceFragments(fragments: GraphSequenceFragment[]): GraphSequenceFragment[] {
  const merged: GraphSequenceFragment[] = [];
  for (const fragment of fragments) {
    const previous = merged.at(-1);
    if (!previous || previous.kind !== fragment.kind) {
      merged.push({ ...fragment });
      continue;
    }
    const x = Math.min(previous.x, fragment.x);
    const y = Math.min(previous.y, fragment.y);
    const right = Math.max(previous.x + previous.width, fragment.x + fragment.width);
    const bottom = Math.max(previous.y + previous.height, fragment.y + fragment.height);
    const guards = [previous.guardText, fragment.guardText].filter((item): item is string => Boolean(item));
    const guardText = Array.from(new Set(guards)).join(' · ') || null;
    const operands = [...previous.operands, ...fragment.operands];
    const edgeIds = Array.from(new Set([...previous.edgeIds, ...fragment.edgeIds]));
    // 相邻同类 fragment 聚合成一个 SequenceDiagram frame，避免多条 guard 边把画布切成碎框。
    merged[merged.length - 1] = {
      ...previous,
      id: `${previous.id}+${fragment.id}`,
      guardText,
      operands,
      edgeIds,
      edgeCount: previous.edgeCount + fragment.edgeCount,
      labelWidth: Math.max(34, previous.label.length * 9 + 18 + (guardText ? guardText.length * 7 + 8 : 0)),
      x,
      y,
      width: Math.max(92, right - x),
      height: Math.max(50, bottom - y),
    };
  }
  return merged;
}

function isGraphSequenceBranchEdge(edge: AggregatedGraphEdge, nodesById: Map<string, GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>): boolean {
  if (/\b(call|calls|executes|executes_sql|reads_table|writes_table|uses_column|references|contains|declares)\b/iu.test(edge.edgeType)) return false;
  const source = nodesById.get(edge.sourceNodeId);
  const target = nodesById.get(edge.targetNodeId);
  const searchableText = [edge.edgeType, source?.nodeType, target?.nodeType, source?.name, target?.name, source?.qualifiedName, target?.qualifiedName].filter(Boolean).join(' ');

  return /\b(branch|branches|condition|conditional|guard|if|else|switch|case|try|catch|finally|cleanup|loop)\b/iu.test(searchableText);
}

function resolveGraphSequenceFragmentKind(edge: AggregatedGraphEdge, nodesById: Map<string, GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>): GraphSequenceFragmentKind {
  const source = nodesById.get(edge.sourceNodeId);
  const target = nodesById.get(edge.targetNodeId);
  const searchableText = [edge.edgeType, source?.nodeType, target?.nodeType, source?.name, target?.name, source?.qualifiedName, target?.qualifiedName].filter(Boolean).join(' ');
  // SequenceDiagram fragment operator 采用 UML 约定词，避免中文/英文切换时把 alt、loop、finally 这类图形语义翻译散。
  if (/\b(try_finally|finally|cleanup)\b/iu.test(searchableText)) return 'finally';
  if (/\b(loop|loop_back|loop_break|loop_continue|while|for|foreach)\b/iu.test(searchableText)) return 'loop';
  if (/\b(try_catch|catch|promise_catch)\b/iu.test(searchableText)) return 'catch';
  if (/\b(branch|branches|condition|conditional|guard|if|else|switch|case|control_flow)\b/iu.test(searchableText)) return 'alt';
  return 'branch';
}

function formatGraphSequenceFragmentLabel(kind: GraphSequenceFragmentKind, appLanguage: AppLanguage): string {
  if (kind === 'branch') return appLanguage === 'en-US' ? 'branch' : '分支';
  return kind;
}

function formatGraphSequenceFragmentGuard(kind: GraphSequenceFragmentKind, edge: AggregatedGraphEdge, nodesById: Map<string, GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>): string | null {
  if (kind === 'branch') return null;
  const target = nodesById.get(edge.targetNodeId);
  const source = nodesById.get(edge.sourceNodeId);
  const rawGuard = normalizeGraphSequenceGuardText(kind, target?.name || target?.qualifiedName || source?.name || '');
  return rawGuard ? `[${rawGuard}]` : null;
}

function normalizeGraphSequenceGuardText(kind: GraphSequenceFragmentKind, value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (kind === 'alt') return text.replace(/^(?:if|else if|guard|condition)\s+/iu, '').trim();
  if (kind === 'loop') return text.replace(/^(?:loop)\s+/iu, '').trim();
  if (kind === 'finally') return text.replace(/^finally\s+/iu, '').trim();
  if (kind === 'catch') return text.replace(/^(?:catch|promise catch)\s+/iu, '').trim();
  return text;
}

function isGraphSequenceReturnEdge(edge: AggregatedGraphEdge): boolean {
  // SequenceDiagram 里 return / finally / promise continuation 语义应以虚线消息表达，避免被误读成新的同步调用。
  return /\b(return|returns|returned|try_finally|finally|cleanup|promise_then|then|promise_catch|catch)\b/iu.test(edge.edgeType);
}

export function buildGraphCanvasLayout(nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>, width: number, height: number, serverLayout?: GraphViewSnapshot['layout']) {
  const layout = new Map<string, { x: number; y: number }>();
  const serverPositions = new Map((serverLayout?.positions ?? []).map((position) => [position.nodeId, { x: position.x, y: position.y }]));
  const centerX = width / 2;
  const centerY = height / 2;
  const radiusX = Math.max(190, width / 2 - 96);
  const radiusY = Math.max(72, height / 2 - 64);

  nodes.forEach((node, index) => {
    const serverPosition = serverPositions.get(node.id);
    if (serverPosition) {
      // 服务端在超大图谱下会给出真实全局坐标；桌面画布只消费压缩后的视窗坐标，避免 macOS 窗口被几万像素的 SVG/WebGL 画布撑开。
      layout.set(node.id, normalizeServerGraphPosition(serverPosition, serverLayout, width, height));
      return;
    }
    // 使用确定性椭圆布局，避免服务端渲染与前端渲染产生随机差异。
    const angle = nodes.length === 1 ? -Math.PI / 2 : -Math.PI / 2 + (index / nodes.length) * Math.PI * 2;
    layout.set(node.id, {
      x: Math.round(centerX + Math.cos(angle) * radiusX),
      y: Math.round(centerY + Math.sin(angle) * radiusY),
    });
  });

  return compactSmallGraphCanvasLayout(layout, nodes.length, width, height, Boolean(serverLayout));
}

function buildGraphNeighborhoodLayout(
  centerNodeId: string,
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>,
  edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>,
): NonNullable<GraphViewSnapshot['layout']> {
  const width = 900;
  const height = 720;
  const center = { x: width / 2, y: Math.round(height * 0.56) };
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const oneHopIds = new Set<string>();

  for (const edge of edges) {
    if (edge.sourceNodeId === centerNodeId && visibleNodeIds.has(edge.targetNodeId)) oneHopIds.add(edge.targetNodeId);
    if (edge.targetNodeId === centerNodeId && visibleNodeIds.has(edge.sourceNodeId)) oneHopIds.add(edge.sourceNodeId);
  }

  const innerNodes = nodes.filter((node) => node.id !== centerNodeId && oneHopIds.has(node.id));
  const outerNodes = nodes.filter((node) => node.id !== centerNodeId && !oneHopIds.has(node.id));
  // 一跳节点过多时拆成双环，避免 156px 节点卡片在中心周围互相覆盖。
  if (outerNodes.length === 0 && innerNodes.length > 10) outerNodes.push(...innerNodes.splice(10));

  const positions: NonNullable<GraphViewSnapshot['layout']>['positions'] = [];
  if (visibleNodeIds.has(centerNodeId)) positions.push({ nodeId: centerNodeId, ...center });

  const placeRing = (ringNodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>, radiusX: number, radiusY: number, angleOffset: number): void => {
    ringNodes.forEach((node, index) => {
      const angle = angleOffset + (index / Math.max(1, ringNodes.length)) * Math.PI * 2;
      positions.push({
        nodeId: node.id,
        x: Math.round(center.x + Math.cos(angle) * radiusX),
        y: Math.round(center.y + Math.sin(angle) * radiusY),
      });
    });
  };

  placeRing(innerNodes, 230, 160, -Math.PI / 2);
  placeRing(outerNodes, 350, 230, -Math.PI / 2 + Math.PI / Math.max(2, outerNodes.length));

  return {
    algorithm: 'radial-neighborhood',
    width,
    height,
    positions,
  };
}

export function buildGraphCanvasViewport(layout: Map<string, { x: number; y: number }>, nodeCount: number, width: number, height: number, isSequenceGraphView: boolean): { x: number; y: number; width: number; height: number } {
  if (isSequenceGraphView || nodeCount <= 0 || nodeCount > 8 || layout.size === 0) {
    return { x: 0, y: 0, width, height };
  }
  const points = Array.from(layout.values());
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const sourceWidth = Math.max(1, maxX - minX);
  const sourceHeight = Math.max(1, maxY - minY);
  const minViewportWidth = Math.min(width, Math.max(520, nodeCount * 130));
  const minViewportHeight = Math.min(height, Math.max(320, nodeCount * 72));
  const viewportWidth = Math.min(width, Math.max(minViewportWidth, sourceWidth + 280));
  const viewportHeight = Math.min(height, Math.max(minViewportHeight, sourceHeight + 220));
  const centerX = minX + sourceWidth / 2;
  const centerY = minY + sourceHeight / 2;
  // 小型普通图谱使用内容感知 viewBox，避免真实节点集中在中心时仍被整张服务端画布缩成截图里的小点。
  const x = Math.max(0, Math.min(width - viewportWidth, centerX - viewportWidth / 2));
  const y = Math.max(0, Math.min(height - viewportHeight, centerY - viewportHeight / 2));

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(viewportWidth),
    height: Math.round(viewportHeight),
  };
}

function compactSmallGraphCanvasLayout(layout: Map<string, { x: number; y: number }>, nodeCount: number, width: number, height: number, fromServerLayout: boolean): Map<string, { x: number; y: number }> {
  if (!fromServerLayout || nodeCount < 3 || nodeCount > 8 || layout.size < 3) return layout;
  const points = Array.from(layout.values());
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const sourceWidth = Math.max(1, maxX - minX);
  const sourceHeight = Math.max(1, maxY - minY);
  const targetWidth = Math.min(Math.max(320, nodeCount * 170), Math.max(320, width - 220));
  const targetHeight = Math.min(Math.max(140, nodeCount * 70), Math.max(140, height - 280));
  const scale = Math.min(1, targetWidth / sourceWidth, targetHeight / sourceHeight);
  const sourceCenterX = minX + sourceWidth / 2;
  const sourceCenterY = minY + sourceHeight / 2;
  const targetCenterX = width / 2;
  const targetCenterY = height / 2;
  const minInsetX = Math.min(96, Math.max(40, width * 0.07));
  const minInsetY = Math.min(96, Math.max(72, height * 0.14));
  const compacted = new Map<string, { x: number; y: number }>();

  layout.forEach((point, nodeId) => {
    // 小型真实图谱如果完全照搬服务端大画布坐标，会在代码页产生大面积空白；这里只做等比例收束，不改变节点相对结构。
    const x = Math.round(targetCenterX + (point.x - sourceCenterX) * scale);
    const y = Math.round(targetCenterY + (point.y - sourceCenterY) * scale);
    compacted.set(nodeId, {
      x: Math.min(width - minInsetX, Math.max(minInsetX, x)),
      y: Math.min(height - minInsetY, Math.max(minInsetY, y)),
    });
  });

  return compacted;
}

function normalizeGraphCanvasDimension(value: number | undefined, fallback: number, maxDesktopSize: number) {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  const rounded = Math.round(value);
  return rounded > maxDesktopSize * 2 ? maxDesktopSize : Math.max(fallback, rounded);
}

function normalizeServerGraphPosition(position: { x: number; y: number }, serverLayout: GraphViewSnapshot['layout'] | undefined, width: number, height: number) {
  if (!serverLayout || (serverLayout.width === width && serverLayout.height === height)) return position;
  const serverWidth = Number.isFinite(serverLayout.width) && serverLayout.width > 0 ? serverLayout.width : width;
  const serverHeight = Number.isFinite(serverLayout.height) && serverLayout.height > 0 ? serverLayout.height : height;
  const insetX = Math.min(72, Math.max(24, width * 0.06));
  const insetY = Math.min(64, Math.max(24, height * 0.07));
  const usableWidth = Math.max(1, width - insetX * 2);
  const usableHeight = Math.max(1, height - insetY * 2);
  const x = Math.min(serverWidth, Math.max(0, position.x));
  const y = Math.min(serverHeight, Math.max(0, position.y));

  return {
    x: Math.round(insetX + (x / serverWidth) * usableWidth),
    y: Math.round(insetY + (y / serverHeight) * usableHeight),
  };
}

const handleSourceListKeyboardNavigation = (event: ReactKeyboardEvent<HTMLElement>) => {
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

const handleInlineRailKeyboardNavigation = (event: ReactKeyboardEvent<HTMLElement>) => {
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

function GraphNodeDetail(props: { node: GraphViewSnapshot['nodes'][number]; graphView: GraphViewSnapshot; expandedHopDepth?: 1 | 2; appLanguage: AppLanguage; isCurrent?: boolean }) {
  const copy = getLanguageCopy(props.appLanguage).codeMapWorkspace;
  const aggregateNode = isAggregatedGraphNode(props.node) ? props.node : null;
  const recentTasks = Array.isArray(props.node.metadata.recentTasks) ? props.node.metadata.recentTasks : [];
  const riskTags = Array.isArray(props.node.metadata.riskTags) ? props.node.metadata.riskTags.filter((tag): tag is string => typeof tag === 'string') : [];
  const aiSummary = typeof props.node.metadata.aiSummary === 'string' && props.node.metadata.aiSummary.trim() ? props.node.metadata.aiSummary.trim() : null;
  const lineRange = `${String(props.node.metadata.lineStart ?? '?')}-${String(props.node.metadata.lineEnd ?? '?')}`;
  const oneHopEdges = props.graphView.edges.filter((edge) => edge.sourceNodeId === props.node.id || edge.targetNodeId === props.node.id);
  const oneHopNodeIds = Array.from(new Set(oneHopEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]).filter((id) => id !== props.node.id)));
  const oneHopNodes = oneHopNodeIds.map((id) => props.graphView.nodes.find((node) => node.id === id)).filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
  const twoHopNodeIds = Array.from(
    new Set(
      props.graphView.edges
        .filter((edge) => oneHopNodeIds.includes(edge.sourceNodeId) || oneHopNodeIds.includes(edge.targetNodeId))
        .flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId])
        .filter((id) => id !== props.node.id && !oneHopNodeIds.includes(id)),
    ),
  );
  const twoHopNodes = twoHopNodeIds.map((id) => props.graphView.nodes.find((node) => node.id === id)).filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
  return (
    <aside className={`graph-detail-workbench graph-node-detail-workbench${props.isCurrent ? ' current-graph-detail' : ''}`} aria-label={copy.nodeDetail} aria-current={props.isCurrent ? 'true' : undefined}>
      <header className="graph-detail-header">
        <span className="graph-detail-title-copy">
          <strong>{copy.nodeDetail}</strong>
          <span>{props.node.qualifiedName}</span>
        </span>
        <span className="graph-detail-type-pill">{formatGraphNodeType(props.node.nodeType, props.appLanguage)}</span>
      </header>
      <section className="graph-detail-source-row" aria-label={copy.nodeSource}>
        <span className="graph-detail-source-copy">
          {aggregateNode ? (
            <>
              <strong>{copy.aggregatedNodeSummary(aggregateNode.aggregateCount, aggregateNode.sourceRefs.length)}</strong>
              {aggregateNode.sourceRefs.slice(0, 6).map((sourceRef) => (
                <small key={sourceRef}>{sourceRef}</small>
              ))}
              {aggregateNode.sourceRefs.length > 6 ? <small>+{aggregateNode.sourceRefs.length - 6}</small> : null}
            </>
          ) : (
            <>
              <strong>{props.node.sourceRef}</strong>
              <small>
                {copy.lineLabel} {lineRange} · {props.node.symbolId ?? copy.missingSymbol}
              </small>
            </>
          )}
        </span>
      </section>
      {aiSummary ? (
        <section className="graph-detail-context-row graph-detail-summary-row" aria-label={copy.aiSummary}>
          <span className="graph-detail-source-copy">
            <strong>{copy.aiSummary}</strong>
            <span>{aiSummary}</span>
          </span>
        </section>
      ) : null}
      {recentTasks.length > 0 ? (
        <section className="graph-detail-context-row graph-detail-task-row" aria-label={copy.recentTasks}>
          <span className="graph-detail-row-label">{copy.recentTasks}</span>
          <span className="graph-detail-context-list">
            {recentTasks.slice(0, 3).map((task, index) => {
              const taskRecord = task as {
                taskId?: string;
                title?: string;
                status?: string;
              };
              const taskStatusLabel = taskRecord.status ? (getLanguageCopy(props.appLanguage).taskStatuses[taskRecord.status as TaskStatus] ?? copy.unknownTaskStatus) : copy.unknownTaskStatus;
              return (
                <span key={taskRecord.taskId ?? index}>
                  {taskRecord.title ?? copy.unnamedTask} · {taskStatusLabel}
                </span>
              );
            })}
          </span>
        </section>
      ) : null}
      {oneHopNodes.length > 0 ? (
        <section className="graph-detail-context-row graph-detail-neighborhood-row" aria-label={copy.oneHopNeighbors}>
          <span className="graph-detail-row-label">{copy.oneHopNeighbors}</span>
          <span className="graph-detail-context-list">
            {oneHopNodes.slice(0, 4).map((node) => (
              <span key={node.id}>
                {node.name} · {formatGraphNodeType(node.nodeType, props.appLanguage)}
              </span>
            ))}
          </span>
        </section>
      ) : null}
      {twoHopNodes.length > 0 ? (
        <section className="graph-detail-context-row graph-detail-neighborhood-row" aria-label={copy.twoHopImpact} hidden={(props.expandedHopDepth ?? 1) < 2}>
          <span className="graph-detail-row-label">{copy.twoHopImpact}</span>
          <span className="graph-detail-context-list">
            {twoHopNodes.slice(0, 4).map((node) => (
              <span key={node.id}>
                {node.name} · {formatGraphNodeType(node.nodeType, props.appLanguage)}
              </span>
            ))}
          </span>
        </section>
      ) : null}
      {riskTags.length > 0 ? (
        <section className="graph-detail-context-row graph-detail-risk-row" aria-label={copy.riskTags}>
          <span className="graph-detail-row-label">{copy.riskTags}</span>
          <span className="graph-detail-context-list">
            {riskTags.map((tag) => (
              <span key={tag}>{formatGraphRiskTag(tag, props.appLanguage)}</span>
            ))}
          </span>
        </section>
      ) : null}
    </aside>
  );
}

function GraphEdgeDetailPanel(props: {
  edge: GraphViewSnapshot['edges'][number] | AggregatedGraphEdge;
  nodes?: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  graphView: GraphViewSnapshot;
  appLanguage: AppLanguage;
  isCurrent?: boolean;
}) {
  const copy = getLanguageCopy(props.appLanguage).codeMapWorkspace;
  const detailCopy =
    props.appLanguage === 'zh-CN'
      ? {
          originalEdges: '原始边标识',
          moreSources: (count: number) => `另有 ${count} 个来源`,
          moreEdges: (count: number) => `另有 ${count} 条原始边`,
        }
      : {
          originalEdges: 'Original edge IDs',
          moreSources: (count: number) => `${count} more source${count === 1 ? '' : 's'}`,
          moreEdges: (count: number) => `${count} more original edge${count === 1 ? '' : 's'}`,
        };
  const currentNodes = props.nodes ?? props.graphView.nodes;
  const source = currentNodes.find((node) => node.id === props.edge.sourceNodeId) ?? props.graphView.nodes.find((node) => node.id === props.edge.sourceNodeId);
  const target = currentNodes.find((node) => node.id === props.edge.targetNodeId) ?? props.graphView.nodes.find((node) => node.id === props.edge.targetNodeId);
  const sourceRefs = 'sourceRefs' in props.edge ? props.edge.sourceRefs : [props.edge.sourceRef];
  const edgeIds = 'edgeIds' in props.edge ? props.edge.edgeIds : [props.edge.id];
  const aggregateCount = 'aggregateCount' in props.edge ? props.edge.aggregateCount : 1;
  return (
    <aside className={`graph-detail-workbench graph-edge-detail-workbench${props.isCurrent ? ' current-graph-detail' : ''}`} aria-label={copy.edgeDetail} aria-current={props.isCurrent ? 'true' : undefined}>
      <header className="graph-detail-header">
        <span className="graph-detail-title-copy">
          <strong>{copy.edgeDetail}</strong>
          <span>{formatGraphEdgeType(props.edge.edgeType, props.appLanguage)}</span>
        </span>
        <span className="graph-detail-type-pill">{copy.confidenceValue(props.edge.confidence.toFixed(2))}</span>
      </header>
      <section className="graph-detail-source-row" aria-label={copy.edgeSource}>
        <span className="graph-detail-source-copy">
          <strong>
            {source?.name ?? props.edge.sourceNodeId} → {target?.name ?? props.edge.targetNodeId}
          </strong>
          {aggregateCount > 1 ? <small>{copy.aggregatedEdgeSummary(aggregateCount, sourceRefs.length)}</small> : null}
          {sourceRefs.slice(0, 8).map((sourceRef) => (
            <small key={sourceRef}>{sourceRef}</small>
          ))}
          {sourceRefs.length > 8 ? <small>{detailCopy.moreSources(sourceRefs.length - 8)}</small> : null}
        </span>
      </section>
      <section className="graph-detail-context-row" aria-label={detailCopy.originalEdges}>
        <span className="graph-detail-source-copy">
          <strong>{detailCopy.originalEdges}</strong>
          {edgeIds.slice(0, 8).map((edgeId) => (
            <small key={edgeId}>{edgeId}</small>
          ))}
          {edgeIds.length > 8 ? <small>{detailCopy.moreEdges(edgeIds.length - 8)}</small> : null}
        </span>
      </section>
    </aside>
  );
}

function ProjectCreateDialog(props: {
  open: boolean;
  form: ProjectCreateFormState;
  busy: boolean;
  directoryBusy: boolean;
  error?: string;
  copy: ReturnType<typeof getLanguageCopy>['sidebar'];
  onNameChange: (name: string) => void;
  onChooseDirectory: () => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const focusFrame = window.requestAnimationFrame(() => nameInputRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [props.open]);
  if (!props.open) return null;

  const interactionBusy = props.busy || props.directoryBusy;
  const describedBy = props.error ? 'project-create-folder-help project-create-error' : 'project-create-folder-help';

  function handleProjectCreateKeyDown(event: ReactKeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Escape' && !interactionBusy) {
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')).filter(
      (element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true',
    );
    if (controls.length === 0) return;
    const firstControl = controls[0];
    const lastControl = controls.at(-1);
    if (event.shiftKey && document.activeElement === firstControl) {
      event.preventDefault();
      lastControl?.focus();
    } else if (!event.shiftKey && document.activeElement === lastControl) {
      event.preventDefault();
      firstControl?.focus();
    }
  }

  return (
    <ModalPortal rootClassName="project-create-dialog-portal-root" backdropClassName="project-create-dialog-backdrop" dismissDisabled={interactionBusy} onDismiss={props.onClose}>
      <form
        className="project-create-dialog zeus-solid-form-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-create-dialog-title"
        aria-describedby={describedBy}
        onSubmit={props.onSubmit}
        onKeyDown={handleProjectCreateKeyDown}
      >
        <header className="project-create-dialog-header">
          <strong id="project-create-dialog-title">{props.copy.createDialogTitle}</strong>
          <button type="button" className="project-create-dialog-close" aria-label={props.copy.createCancel} onClick={props.onClose} disabled={interactionBusy}>
            <X aria-hidden="true" weight="regular" />
          </button>
        </header>
        <div className="project-create-dialog-body">
          <label className="visually-hidden" htmlFor="project-create-name-input">
            {props.copy.createNameLabel}
          </label>
          <div className="project-create-name-control">
            <span className="project-create-name-icon" aria-hidden="true">
              <Folder weight="regular" />
            </span>
            <input
              ref={nameInputRef}
              id="project-create-name-input"
              value={props.form.name}
              placeholder={props.copy.createNamePlaceholder}
              aria-invalid={props.error === props.copy.createNameRequired ? true : undefined}
              onChange={(event) => props.onNameChange(event.currentTarget.value)}
              disabled={interactionBusy}
            />
          </div>
          <section className="project-create-folder-field" aria-labelledby="project-create-folder-label">
            <strong id="project-create-folder-label">{props.copy.createFolderLabel}</strong>
            <p id="project-create-folder-help" className="visually-hidden">
              {props.copy.createFolderHelp}
            </p>
            <button
              type="button"
              className="project-create-folder-picker"
              data-selected={props.form.localPath ? 'true' : 'false'}
              aria-describedby="project-create-folder-help"
              onClick={props.onChooseDirectory}
              disabled={interactionBusy}
              {...controlBusyProps(props.directoryBusy)}
            >
              <span className="project-create-folder-picker-icon" aria-hidden="true">
                {props.form.localPath ? <FolderOpen weight="regular" /> : <FolderPlus weight="regular" />}
              </span>
              <span className="project-create-folder-picker-copy">
                <strong>{props.form.localPath ? defaultProjectNameFromLocalPath(props.form.localPath) : props.copy.createChooseFolder}</strong>
                {props.form.localPath ? <small title={props.form.localPath}>{props.form.localPath}</small> : null}
              </span>
              {props.form.localPath ? <span className="project-create-folder-change">{props.copy.createChangeFolder}</span> : null}
            </button>
          </section>
          {props.error ? (
            <p className="project-create-error" id="project-create-error" role="alert">
              {props.error}
            </p>
          ) : null}
        </div>
        <footer className="project-create-dialog-footer">
          <Button variant="secondary" size="regular" onClick={props.onClose} disabled={interactionBusy}>
            {props.copy.createCancel}
          </Button>
          <Button type="submit" variant="primary" size="regular" busy={props.busy} disabled={interactionBusy || !props.form.name.trim() || !props.form.localPath}>
            {props.busy ? props.copy.createSubmitting : props.copy.createSubmit}
          </Button>
        </footer>
      </form>
    </ModalPortal>
  );
}

function ProjectRenameDialog(props: {
  project?: ProjectRecord;
  draft: string;
  busy: boolean;
  error?: string;
  copy: ReturnType<typeof getLanguageCopy>['sidebar'];
  onDraftChange: (draft: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.project) return;
    const focusFrame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [props.project?.id]);
  if (!props.project) return null;

  const describedBy = props.error ? 'project-rename-dialog-help project-rename-error' : 'project-rename-dialog-help';
  const surface = (
    <ModalPortal rootClassName="project-rename-dialog-portal-root" backdropClassName="project-rename-dialog-backdrop" dismissDisabled={props.busy} onDismiss={props.onClose}>
      <form
        className="project-rename-dialog zeus-solid-form-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-rename-dialog-title"
        aria-describedby={describedBy}
        onSubmit={props.onSubmit}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || props.busy) return;
          event.stopPropagation();
          props.onClose();
        }}
      >
        <header className="project-rename-dialog-header">
          <span>
            <strong id="project-rename-dialog-title">{props.copy.renameDialogTitle}</strong>
            <small id="project-rename-dialog-help">{props.copy.renameDialogHelp}</small>
          </span>
          <button type="button" className="project-rename-dialog-close" aria-label={props.copy.renameCancel} onClick={props.onClose} disabled={props.busy}>
            <X aria-hidden="true" weight="regular" />
          </button>
        </header>
        <div className="project-rename-dialog-body">
          <label htmlFor="project-rename-input">{props.copy.renameLabel}</label>
          <input
            ref={inputRef}
            id="project-rename-input"
            value={props.draft}
            placeholder={props.copy.renamePlaceholder}
            aria-invalid={props.error ? true : undefined}
            onChange={(event) => props.onDraftChange(event.currentTarget.value)}
            disabled={props.busy}
          />
          {props.error ? (
            <small className="project-rename-error" id="project-rename-error" role="alert">
              {props.error}
            </small>
          ) : null}
        </div>
        <footer className="project-rename-dialog-footer">
          <Button variant="secondary" size="regular" className="project-rename-dialog-cancel" onClick={props.onClose} disabled={props.busy}>
            {props.copy.renameCancel}
          </Button>
          <Button type="submit" variant="primary" size="regular" className="project-rename-dialog-submit" busy={props.busy} disabled={!props.draft.trim()}>
            {props.busy ? props.copy.renameSaving : props.copy.renameSave}
          </Button>
        </footer>
      </form>
    </ModalPortal>
  );
  return surface;
}

function SidebarNav(props: {
  activeNavTarget: WorkspaceViewId;
  activeProjectId?: string;
  activeProjectSection: ProjectWorkspaceSection;
  projects: ProjectRecord[];
  pinnedProjectIds: string[];
  collapsedProjectIds: string[];
  appLanguage: AppLanguage;
  canCreateProject: boolean;
  createProjectBusy: boolean;
  onCreateProject: () => void;
  onCreateConversation: () => void;
  onNavigate: (target: WorkspaceViewId) => void;
  onOpenProjectSection: (project: ProjectRecord, section: ProjectWorkspaceSection) => void;
  onTogglePinnedProject: (projectId: string) => void;
  onToggleProjectCollapsed: (projectId: string) => void;
  onRevealProjectInFinder: (projectPath: string) => Promise<void>;
  onRenameProject: (projectId: string, displayName: string) => Promise<void>;
  onPrepareProjectDelete: (projectId: string) => void;
  onConfirmProjectDelete: (projectId: string) => void;
  pendingProjectDeleteId?: string;
}) {
  const projectPopoverCloseAnimationMs = 120;
  const projectPopoverAnchorGapPx = 6;
  const [openProjectMenuIds, setOpenProjectMenuIds] = useState<Set<string>>(() => new Set());
  const [closingProjectMenuIds, setClosingProjectMenuIds] = useState<Set<string>>(() => new Set());
  const [projectMenuPositions, setProjectMenuPositions] = useState<Map<string, { left: number; top: number }>>(() => new Map());
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [projectRenameTarget, setProjectRenameTarget] = useState<ProjectRecord | undefined>();
  const [projectRenameDraft, setProjectRenameDraft] = useState('');
  const [projectRenameBusy, setProjectRenameBusy] = useState(false);
  const [projectRenameError, setProjectRenameError] = useState<string | undefined>();
  const openProjectMenuIdsRef = useRef(openProjectMenuIds);
  const projectMenuButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const projectMenuCloseTimerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    openProjectMenuIdsRef.current = openProjectMenuIds;
  }, [openProjectMenuIds]);
  useEffect(() => {
    return () => {
      projectMenuCloseTimerRefs.current.forEach((timer) => clearTimeout(timer));
      projectMenuCloseTimerRefs.current.clear();
    };
  }, []);
  const closeProjectSearch = () => {
    setProjectSearchOpen(false);
    setProjectSearchQuery('');
  };
  const toggleProjectSearch = () => {
    if (projectSearchOpen) {
      closeProjectSearch();
      return;
    }
    setProjectSearchOpen(true);
  };
  const handleProjectSearchKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeProjectSearch();
  };
  const clearProjectMenuCloseTimer = (projectId: string) => {
    const timer = projectMenuCloseTimerRefs.current.get(projectId);
    if (!timer) return;
    clearTimeout(timer);
    projectMenuCloseTimerRefs.current.delete(projectId);
  };
  const closeProjectMoreMenu = (projectId: string) => {
    clearProjectMenuCloseTimer(projectId);
    setClosingProjectMenuIds((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
    setOpenProjectMenuIds((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
    setProjectMenuPositions((current) => {
      if (!current.has(projectId)) return current;
      const next = new Map(current);
      next.delete(projectId);
      return next;
    });
  };
  const closeProjectMoreMenuWithMotion = (projectId: string) => {
    if (!openProjectMenuIdsRef.current.has(projectId)) return;
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      closeProjectMoreMenu(projectId);
      return;
    }
    setClosingProjectMenuIds((current) => new Set(current).add(projectId));
    clearProjectMenuCloseTimer(projectId);
    const timer = setTimeout(() => {
      projectMenuCloseTimerRefs.current.delete(projectId);
      closeProjectMoreMenu(projectId);
    }, projectPopoverCloseAnimationMs);
    projectMenuCloseTimerRefs.current.set(projectId, timer);
  };
  const closeProjectMoreMenusImmediately = () => {
    projectMenuCloseTimerRefs.current.forEach((timer) => clearTimeout(timer));
    projectMenuCloseTimerRefs.current.clear();
    setClosingProjectMenuIds((current) => (current.size === 0 ? current : new Set()));
    setOpenProjectMenuIds((current) => (current.size === 0 ? current : new Set()));
    setProjectMenuPositions((current) => (current.size === 0 ? current : new Map()));
  };
  const closeOpenProjectMoreMenusWithMotion = () => {
    const openProjectIds = Array.from(openProjectMenuIdsRef.current);
    if (openProjectIds.length === 0) return;
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      closeProjectMoreMenusImmediately();
      return;
    }
    openProjectIds.forEach((projectId) => closeProjectMoreMenuWithMotion(projectId));
  };
  const toggleProjectMoreMenu = (projectId: string, anchorButton: HTMLButtonElement) => {
    if (openProjectMenuIdsRef.current.has(projectId)) {
      closeProjectMoreMenuWithMotion(projectId);
      return;
    }
    const anchorRect = anchorButton.getBoundingClientRect();
    setProjectMenuPositions((current) => {
      const next = new Map(current);
      next.set(projectId, {
        left: anchorRect.right + projectPopoverAnchorGapPx,
        top: anchorRect.top,
      });
      return next;
    });
    clearProjectMenuCloseTimer(projectId);
    setClosingProjectMenuIds((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
    setOpenProjectMenuIds((current) => {
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  };
  const handleProjectMoreMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, projectId: string) => {
    const menuItems = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeProjectMoreMenuWithMotion(projectId);
      projectMenuButtonRefs.current.get(projectId)?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || menuItems.length === 0) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? menuItems.length - 1 : event.key === 'ArrowDown' ? (currentIndex + 1 + menuItems.length) % menuItems.length : (currentIndex - 1 + menuItems.length) % menuItems.length;
    menuItems[nextIndex]?.focus();
  };
  useEffect(() => {
    const closeProjectMoreMenusOnOutsidePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.project-row-actions, .project-more-popover')) return;
      // 点击菜单外部只关闭轻量 popover，不折叠项目行，避免破坏多个项目可同时展开的 source-list 状态。
      closeOpenProjectMoreMenusWithMotion();
    };
    document.addEventListener('pointerdown', closeProjectMoreMenusOnOutsidePointerDown, true);
    return () => document.removeEventListener('pointerdown', closeProjectMoreMenusOnOutsidePointerDown, true);
  }, []);
  useEffect(() => {
    if (openProjectMenuIds.size === 0) return;
    const syncOpenProjectMenuPositions = () => {
      setProjectMenuPositions((current) => {
        const next = new Map(current);
        openProjectMenuIds.forEach((projectId) => {
          const anchorButton = projectMenuButtonRefs.current.get(projectId);
          if (!anchorButton) return;
          const anchorRect = anchorButton.getBoundingClientRect();
          next.set(projectId, {
            left: anchorRect.right + projectPopoverAnchorGapPx,
            top: anchorRect.top,
          });
        });
        return next;
      });
    };
    window.addEventListener('resize', syncOpenProjectMenuPositions);
    document.addEventListener('scroll', syncOpenProjectMenuPositions, true);
    return () => {
      window.removeEventListener('resize', syncOpenProjectMenuPositions);
      document.removeEventListener('scroll', syncOpenProjectMenuPositions, true);
    };
  }, [openProjectMenuIds]);
  const copy = getLanguageCopy(props.appLanguage).sidebar;
  const openProjectRenameDialog = (project: ProjectRecord) => {
    closeProjectMoreMenuWithMotion(project.id);
    setProjectRenameTarget(project);
    setProjectRenameDraft(project.name);
    setProjectRenameError(undefined);
  };
  const closeProjectRenameDialog = () => {
    if (projectRenameBusy) return;
    const projectId = projectRenameTarget?.id;
    setProjectRenameTarget(undefined);
    setProjectRenameDraft('');
    setProjectRenameError(undefined);
    if (projectId) window.requestAnimationFrame(() => projectMenuButtonRefs.current.get(projectId)?.focus());
  };
  const submitProjectRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectRenameTarget || projectRenameBusy) return;
    const displayName = projectRenameDraft.trim();
    if (!displayName) {
      setProjectRenameError(copy.renameRequired);
      return;
    }
    setProjectRenameBusy(true);
    setProjectRenameError(undefined);
    try {
      await props.onRenameProject(projectRenameTarget.id, displayName);
      const projectId = projectRenameTarget.id;
      setProjectRenameTarget(undefined);
      setProjectRenameDraft('');
      window.requestAnimationFrame(() => projectMenuButtonRefs.current.get(projectId)?.focus());
    } catch (error) {
      setProjectRenameError(errorToLocalUiMessage(error));
    } finally {
      setProjectRenameBusy(false);
    }
  };
  const visibleProjects = projectSearchQuery.trim()
    ? props.projects.filter((project) => {
        const query = projectSearchQuery.trim().toLocaleLowerCase();
        return project.name.toLocaleLowerCase().includes(query) || project.localPath.toLocaleLowerCase().includes(query);
      })
    : props.projects;
  // macOS 红黄绿窗口按钮属于系统层：侧栏只保留 44px 顶部安全区，避开交通灯但不再保留整行死空间。
  const titlebarProtectedSidebarStyle = {
    '--zeus-hidden-titlebar-safe-top': '44px',
    paddingBlockStart: 'var(--zeus-hidden-titlebar-safe-top, 44px)',
    paddingTop: 'var(--zeus-hidden-titlebar-safe-top, 44px)',
  } as CSSProperties;
  const projectMenuPortalHost = typeof document === 'undefined' ? undefined : (document.querySelector<HTMLElement>('.macos-ai-app.zeus-shell') ?? undefined);

  return (
    <aside className="zeus-sidebar ai-sidebar project-first-sidebar zeus-titlebar-protected-source-list" aria-label={copy.ariaLabel} style={titlebarProtectedSidebarStyle}>
      <div className="project-window-control-reserved-space" aria-hidden="true" />
      <nav className="project-quick-actions codex-source-list-quick-actions" aria-label={copy.quickActionsLabel}>
        <button type="button" className="project-quick-action" onClick={props.onCreateConversation} disabled={!props.activeProjectId}>
          <span className="project-quick-action-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <path d="M4.2 14.9 4.8 11 12.6 3.2a2 2 0 0 1 2.8 0l1.4 1.4a2 2 0 0 1 0 2.8L9 15.2l-3.9.6Z" />
              <path d="m11.4 4.4 4.2 4.2" />
            </svg>
          </span>
          <span className="project-quick-action-label">{copy.newChat}</span>
        </button>
        <button type="button" className="project-quick-action" aria-expanded={projectSearchOpen} onClick={toggleProjectSearch} disabled={props.projects.length === 0}>
          <span className="project-quick-action-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <circle cx="8.8" cy="8.8" r="5.4" />
              <path d="m13 13 3.4 3.4" />
            </svg>
          </span>
          <span className="project-quick-action-label">{copy.search}</span>
        </button>
      </nav>
      {projectSearchOpen ? (
        <section className="project-sidebar-search-row" aria-label={copy.search} onKeyDown={handleProjectSearchKeyDown}>
          {/* 搜索入口只负责本地过滤项目 source-list，不再偷偷跳到第一个项目任务页，避免误切当前工作上下文。 */}
          <span className="project-sidebar-search-icon" aria-hidden="true">
            ⌕
          </span>
          <input type="search" aria-label={copy.search} placeholder={copy.search} value={projectSearchQuery} autoFocus onChange={(event) => setProjectSearchQuery(event.currentTarget.value)} />
        </section>
      ) : null}

      <section className="project-sidebar-list zeus-source-list" role="navigation" data-source-list-keyboard="vertical" aria-label={copy.projectListLabel} onKeyDown={handleSourceListKeyboardNavigation}>
        <div className="project-sidebar-heading">
          <span>{copy.projects}</span>
          <button type="button" className="project-add-button" aria-label={copy.addProject} title={copy.addProject} onClick={props.onCreateProject} disabled={!props.canCreateProject} {...controlBusyProps(props.createProjectBusy)}>
            <Plus aria-hidden="true" weight="regular" />
          </button>
        </div>
        {props.projects.length === 0 ? null : visibleProjects.length === 0 ? (
          <section className="project-inline-recovery-row project-search-empty-row" aria-label={copy.noProjectMatches}>
            <span className="project-inline-recovery-copy">
              <strong>{copy.noProjectMatches}</strong>
            </span>
          </section>
        ) : (
          visibleProjects.map((project) => {
            const isActiveProject = project.id === props.activeProjectId && props.activeNavTarget !== 'settings';
            const pinned = props.pinnedProjectIds.includes(project.id);
            const expanded = !props.collapsedProjectIds.includes(project.id);
            const menuOpen = openProjectMenuIds.has(project.id);
            const menuClosing = closingProjectMenuIds.has(project.id);
            const menuVisible = menuOpen || menuClosing;
            const menuPosition = projectMenuPositions.get(project.id);
            const projectMorePopover =
              menuVisible && menuPosition ? (
                <div
                  id={`project-more-menu-${project.id}`}
                  className="project-more-popover zeus-quiet-more-menu"
                  role="menu"
                  aria-label={`${project.name} ${copy.moreProjectActionsPrefix}`}
                  data-motion-surface="popover"
                  data-motion-state={menuClosing ? 'closing' : 'open'}
                  style={{ left: menuPosition.left, top: menuPosition.top }}
                  onKeyDown={(event) => handleProjectMoreMenuKeyDown(event, project.id)}
                >
                  {/* 项目菜单提升到应用壳层，位置只由“更多”按钮的视口坐标决定，避免被侧栏滚动容器横向裁剪。 */}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      props.onTogglePinnedProject(project.id);
                      closeProjectMoreMenuWithMotion(project.id);
                    }}
                  >
                    <span className="project-more-menu-icon" aria-hidden="true">
                      {pinned ? <PushPinSlash weight="regular" /> : <PushPin weight="regular" />}
                    </span>
                    <span>{pinned ? copy.unpinProject : copy.pinProject}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeProjectMoreMenuWithMotion(project.id);
                      void props.onRevealProjectInFinder(project.localPath).catch(() => undefined);
                    }}
                  >
                    <span className="project-more-menu-icon" aria-hidden="true">
                      <FolderOpen weight="regular" />
                    </span>
                    <span>{copy.revealProjectInFinder}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => openProjectRenameDialog(project)}>
                    <span className="project-more-menu-icon" aria-hidden="true">
                      <PencilSimple weight="regular" />
                    </span>
                    <span>{copy.renameProject}</span>
                  </button>
                  <button type="button" role="menuitem" className="project-menu-remove-action" onClick={() => props.onPrepareProjectDelete(project.id)}>
                    <span className="project-more-menu-icon" aria-hidden="true">
                      <X weight="regular" />
                    </span>
                    <span>{copy.deleteProject}</span>
                  </button>
                  {props.pendingProjectDeleteId === project.id ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="danger-action project-menu-confirm-remove-action"
                      onClick={() => {
                        props.onConfirmProjectDelete(project.id);
                        closeProjectMoreMenuWithMotion(project.id);
                      }}
                    >
                      <span className="project-more-menu-icon" aria-hidden="true">
                        <X weight="bold" />
                      </span>
                      <span>{copy.confirmDeleteProject}</span>
                    </button>
                  ) : null}
                </div>
              ) : null;
            return (
              <section className="project-sidebar-item" key={project.id} aria-label={`${copy.projects}${copy.labelSeparator}${project.name}`}>
                <SourceListRow
                  level="root"
                  surface="fill"
                  expanded={expanded}
                  icon={
                    <svg className="native-folder-icon zeus-avatar-token" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                      <path d="M2.8 6.4h5.1l1.4 1.5h7.9v7.7a1.4 1.4 0 0 1-1.4 1.4H4.2a1.4 1.4 0 0 1-1.4-1.4Z" />
                      <path d="M2.8 6.4V5.7a1.4 1.4 0 0 1 1.4-1.4h3.4l1.5 2.1" />
                    </svg>
                  }
                  label={<strong>{project.name}</strong>}
                  buttonProps={{
                    type: 'button',
                    tabIndex: isActiveProject ? 0 : -1,
                    'data-source-list-item': 'true',
                    'aria-label': `${expanded ? copy.collapseProjectPrefix : copy.expandProjectPrefix}${copy.labelSeparator}${project.name}`,
                    onClick: () => props.onToggleProjectCollapsed(project.id),
                  }}
                  actions={
                    <>
                      <button type="button" className="project-settings-button" aria-label={`${copy.projectSettingsPrefix}${copy.labelSeparator}${project.name}`} onClick={() => props.onOpenProjectSection(project, 'project-settings')}>
                        ⚙
                      </button>
                      <div className={`project-row-actions ${menuOpen ? 'open' : ''} ${menuClosing ? 'closing' : ''}`.trim()} onKeyDown={(event) => handleProjectMoreMenuKeyDown(event, project.id)}>
                        <button
                          type="button"
                          className="project-more-button"
                          ref={(button) => {
                            if (button) {
                              projectMenuButtonRefs.current.set(project.id, button);
                            } else {
                              projectMenuButtonRefs.current.delete(project.id);
                            }
                          }}
                          aria-label={`${copy.moreProjectActionsPrefix}${copy.labelSeparator}${project.name}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          aria-controls={menuVisible ? `project-more-menu-${project.id}` : undefined}
                          onClick={(event) => toggleProjectMoreMenu(project.id, event.currentTarget)}
                        >
                          ···
                        </button>
                      </div>
                      {projectMorePopover ? (projectMenuPortalHost ? createPortal(projectMorePopover, projectMenuPortalHost) : projectMorePopover) : null}
                    </>
                  }
                />
                {expanded ? (
                  <div className="project-section-menu animated-project-menu" data-inline-rail-keyboard="horizontal" aria-label={`${project.name} ${copy.projectMenuSuffix}`} onKeyDown={handleInlineRailKeyboardNavigation}>
                    {(
                      [
                        { id: 'tasks', label: copy.sections.tasks, icon: '✓' },
                        { id: 'code', label: copy.sections.code, icon: '⌘' },
                        {
                          id: 'sessions',
                          label: copy.sections.sessions,
                          icon: (
                            <svg data-project-section-icon="sessions" aria-hidden="true" focusable="false" viewBox="0 0 16 16">
                              <path d="M3.25 3.5h9.5a.75.75 0 0 1 .75.75V9.5a.75.75 0 0 1-.75.75H7.1L4 11.75l.65-3h-1.4A.75.75 0 0 1 2.5 8V4.25a.75.75 0 0 1 .75-.75Z" />
                            </svg>
                          ),
                        },
                        { id: 'commands', label: copy.sections.commands, icon: '▶' },
                      ] satisfies Array<{ id: ProjectWorkspaceSection; label: string; icon: ReactNode }>
                    ).map((item) => {
                      const current = isActiveProject && props.activeProjectSection === item.id;
                      return (
                        <SourceListRow
                          level="nested"
                          surface="fill"
                          selected={current}
                          icon={item.icon}
                          label={item.label}
                          state={current ? copy.current : undefined}
                          buttonProps={{
                            type: 'button',
                            'aria-current': current ? 'page' : undefined,
                            tabIndex: current ? 0 : -1,
                            'data-inline-rail-item': 'true',
                            onClick: () => props.onOpenProjectSection(project, item.id),
                          }}
                          key={item.id}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </section>

      <section className="project-global-settings" aria-label={copy.globalSettingsLabel}>
        <button type="button" className={props.activeNavTarget === 'settings' ? 'active' : ''} onClick={() => props.onNavigate('settings')}>
          <span aria-hidden="true">⚙</span>
          {copy.settings}
        </button>
      </section>
      <ProjectRenameDialog
        project={projectRenameTarget}
        draft={projectRenameDraft}
        busy={projectRenameBusy}
        error={projectRenameError}
        copy={copy}
        onDraftChange={(draft) => {
          setProjectRenameDraft(draft);
          if (projectRenameError) setProjectRenameError(undefined);
        }}
        onClose={closeProjectRenameDialog}
        onSubmit={(event) => void submitProjectRename(event)}
      />
    </aside>
  );
}

function InlineRecoveryPrompt(props: { title: string; body: string; actions: InlineRecoveryAction[]; className?: string }) {
  return (
    <section className={`project-inline-recovery-row ${props.className ?? ''}`} aria-label={props.title}>
      <span className="project-inline-recovery-copy">
        <strong>{props.title}</strong>
        {props.body ? <small>{props.body}</small> : null}
      </span>
      {props.actions.length > 0 ? (
        <span className="project-inline-recovery-command-rail">
          {props.actions.map((action) => (
            <button key={action.label} type="button" onClick={action.onAction} disabled={action.disabled} {...controlBusyProps(action.busy === true)}>
              {action.label}
            </button>
          ))}
        </span>
      ) : null}
    </section>
  );
}

function formatRuntimeDefaultArgs(args: string[]): string {
  return args.join(' ');
}

function formatRuntimeAdapterDetectionFacts(adapter: AiRuntimeAdapterDescriptor, status: AiRuntimeAdapterStatus | undefined, appLanguage: AppLanguage): string {
  const copy = getLanguageCopy(appLanguage).sessionWorkspace.runtimeDrawer;
  if (!status) return copy.adapterCapabilities(adapter.capabilities.join(' / '));
  // Adapter 检测字段直接来自真实探测结果；按当前应用语言格式化标签，但不翻译真实命令、模型 ID 或能力 ID。
  const modelConfiguration = status.modelConfiguration === 'user-configured' ? copy.adapterModelUserConfigured : status.modelConfiguration;
  return [
    status.resolvedCommandPath ?? adapter.command,
    copy.adapterVersion(status.version ?? copy.adapterVersionUnknown),
    status.checkedAt,
    copy.adapterAuthStatus(formatAdapterAuthStatus(status.authStatus, appLanguage)),
    copy.adapterModelConfig(modelConfiguration),
    copy.adapterCapabilities(status.capabilities.join(' / ')),
  ].join(' · ');
}

function formatAdapterAuthStatus(status: AiRuntimeAdapterStatus['authStatus'], appLanguage: AppLanguage): string {
  const copy = getLanguageCopy(appLanguage).sessionWorkspace.runtimeDrawer;
  if (status === 'authenticated') return copy.adapterAuthAuthenticated;
  if (status === 'unauthenticated') return copy.adapterAuthUnauthenticated;
  return copy.adapterAuthUnknown;
}

function formatGenericShellRisk(risk: GenericShellCommandRisk, copy: ReturnType<typeof getLanguageCopy>['sessionWorkspace']['runtimeDrawer']): GenericShellCommandRisk {
  if (risk.level === 'empty') {
    return {
      ...risk,
      label: copy.emptyShellCommand,
      reason: copy.genericShellCommandHelp,
    };
  }
  if (risk.level === 'critical') {
    return {
      ...risk,
      label: copy.criticalPhraseTitle,
      reason: copy.criticalPhraseHelp(GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE),
    };
  }
  return {
    ...risk,
    label: copy.confirmationStateTitle,
    reason: copy.genericShellCommandHelp,
  };
}

function formatRuntimeConfirmationStatus(status: RuntimeConfirmationStatusState, copy: ReturnType<typeof getLanguageCopy>['sessionWorkspace']['runtimeDrawer']): string {
  if (status.kind === 'created') return copy.genericShellConfirmationCreated(status.confirmationId);
  if (status.kind === 'create_failed') return copy.genericShellConfirmationCreateFailed;
  if (status.kind === 'reject_failed') return copy.genericShellConfirmationRejectFailed;
  if (status.kind === 'rejected') return `${copy.rejectedTitle} · ${copy.rejectedHelp}`;
  if (status.kind === 'critical_phrase_required') return copy.genericShellCriticalPhraseRequired(GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE);
  if (status.kind === 'changed') return copy.genericShellChangedStatus;
  if (status.kind === 'consumed') return copy.genericShellConfirmationConsumed(status.confirmationId);
  if (status.kind === 'failed') return copy.genericShellConfirmationFailed;
  return copy.genericShellConfirmationIdle;
}

function parseRuntimeDefaultArgsText(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function formatRuntimeTerminalEnv(env: RuntimeSettings['terminalEnv']): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

interface ProjectConfigFormState {
  defaultModel: string;
  defaultWorkMode: ProjectConfig['defaultWorkMode'];
  defaultTaskPrompt: string;
  scanIgnoreDirectories: string;
  indexScope: ProjectConfig['scan']['indexScope'];
  languagePrimary: string;
  languageAdditional: string;
  packageManagers: string;
  manifestPaths: string;
  databaseConnectionName: string;
  databaseSchemaPaths: string;
  telegramAlias: string;
  allowShell: boolean;
  allowGitWrite: boolean;
}

function normalizeProjectConfig(config?: Partial<ProjectConfig>, projectId?: string): ProjectConfig | undefined {
  const resolvedProjectId = config?.projectId ?? projectId;
  if (!resolvedProjectId) return undefined;
  return {
    projectId: resolvedProjectId,
    defaultModel: config?.defaultModel ?? null,
    defaultWorkMode: config?.defaultWorkMode ?? 'plan',
    defaultTaskPrompt: config?.defaultTaskPrompt ?? '',
    scan: {
      ignoreDirectories: config?.scan?.ignoreDirectories ?? ['node_modules', 'dist', '.tmp', 'coverage'],
      indexScope: config?.scan?.indexScope ?? 'project',
    },
    language: {
      primary: config?.language?.primary ?? 'typescript',
      additional: config?.language?.additional ?? [],
    },
    dependencies: {
      packageManagers: config?.dependencies?.packageManagers ?? [],
      manifestPaths: config?.dependencies?.manifestPaths ?? [],
    },
    vcs: {
      isGitRepository: config?.vcs?.isGitRepository ?? false,
      gitRoot: config?.vcs?.gitRoot ?? null,
    },
    database: {
      connectionName: config?.database?.connectionName ?? null,
      schemaPaths: config?.database?.schemaPaths ?? [],
    },
    telegram: {
      alias: config?.telegram?.alias ?? null,
    },
    security: {
      allowShell: config?.security?.allowShell ?? false,
      allowGitWrite: config?.security?.allowGitWrite ?? false,
    },
  };
}

function toProjectConfigForm(config?: ProjectConfig): ProjectConfigFormState {
  const normalized = normalizeProjectConfig(config, config?.projectId) ?? {
    projectId: '',
    defaultModel: null,
    defaultWorkMode: 'plan',
    defaultTaskPrompt: '',
    scan: {
      ignoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
      indexScope: 'project',
    },
    language: { primary: 'typescript', additional: [] },
    dependencies: { packageManagers: [], manifestPaths: [] },
    vcs: { isGitRepository: false, gitRoot: null },
    database: { connectionName: null, schemaPaths: [] },
    telegram: { alias: null },
    security: { allowShell: false, allowGitWrite: false },
  };
  return {
    defaultModel: normalized.defaultModel ?? '',
    defaultWorkMode: normalized.defaultWorkMode,
    defaultTaskPrompt: normalized.defaultTaskPrompt,
    scanIgnoreDirectories: normalized.scan.ignoreDirectories.join(', '),
    indexScope: normalized.scan.indexScope,
    languagePrimary: normalized.language.primary,
    languageAdditional: normalized.language.additional.join(', '),
    packageManagers: normalized.dependencies.packageManagers.join(', '),
    manifestPaths: normalized.dependencies.manifestPaths.join(', '),
    databaseConnectionName: redactDatabaseConnectionName(normalized.database.connectionName),
    databaseSchemaPaths: normalized.database.schemaPaths.join(', '),
    telegramAlias: normalized.telegram.alias ?? '',
    allowShell: normalized.security.allowShell,
    allowGitWrite: normalized.security.allowGitWrite,
  };
}

function parseProjectConfigList(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && !item.includes('..'))
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function parseNumericList(text: string): number[] {
  const seen = new Set<number>();
  return text
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function formatProjectLanguage(form: ProjectConfigFormState): string {
  const additional = parseProjectConfigList(form.languageAdditional);
  return [form.languagePrimary.trim() || 'typescript', ...additional].join(' + ');
}

function formatProjectDependencies(form: ProjectConfigFormState, copy: ReturnType<typeof getLanguageCopy>['codeWorkspace']['projectConfig']): string {
  const managers = parseProjectConfigList(form.packageManagers).join(', ') || copy.unsetPackageManagers;
  const manifests = parseProjectConfigList(form.manifestPaths).join(', ') || copy.unsetManifestPaths;
  return `${managers} · ${manifests}`;
}

function formatProjectDatabase(form: ProjectConfigFormState, copy: ReturnType<typeof getLanguageCopy>['codeWorkspace']['projectConfig']): string {
  const connectionName = redactDatabaseConnectionName(form.databaseConnectionName) || copy.unsetConnectionName;
  const schemaPaths = parseProjectConfigList(form.databaseSchemaPaths).join(', ') || copy.unsetSchemaPaths;
  return `${connectionName} · ${schemaPaths}`;
}

function formatProjectDatabaseHelp(form: ProjectConfigFormState, copy: ReturnType<typeof getLanguageCopy>['codeWorkspace']['projectConfig']): string {
  return isExternalDatabaseUri(form.databaseConnectionName) ? copy.externalDatabaseHelp : copy.localSchemaHelp;
}

function isExternalDatabaseUri(value: string | null | undefined): boolean {
  return /^(?:postgresql?|mysql|mariadb):/iu.test(value?.trim() ?? '');
}

function redactDatabaseConnectionName(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (!isExternalDatabaseUri(text)) return text;
  try {
    const url = new URL(text);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    // URI 格式异常时仍要避免 user:password@ 片段直接出现在界面。
    return text.replace(/(:\/\/[^:@\s]+):[^@\s]+@/u, '$1:***@');
  }
}

function normalizeLocalUiError(error?: LocalUiErrorSnapshot): LocalUiErrorSnapshot | undefined {
  if (!error) return undefined;
  return {
    action: error.action.trim() || 'renderer-action',
    message: redactLocalUiErrorMessage(error.message),
    occurredAt: error.occurredAt.trim() || new Date(0).toISOString(),
  };
}

function errorToLocalUiMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '本地操作失败，详情请查看本地日志目录。';
}

function redactLocalUiErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [REDACTED]')
    .replace(/\b(token|api[_-]?key|secret|password)=([^\s;&]+)/giu, '$1=[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gu, '[REDACTED]');
}

function normalizeRuntimeSettings(settings?: Partial<RuntimeSettings>): RuntimeSettings {
  const defaultSettings: RuntimeSettings = {
    defaultAdapterId: 'codex',
    adapterModels: {},
    adapterDefaultArgs: {},
    adapterCliPaths: {},
    terminalEnv: {},
    shell: { path: null, login: false },
    concurrency: { maxPerProject: 1, maxGlobal: 2 },
    executionTimeoutSeconds: 3600,
    logRetentionDays: 30,
    autoConfirmationPolicy: 'never',
  };
  const maxPerProject = normalizeRuntimeSettingNumber(String(settings?.concurrency?.maxPerProject ?? defaultSettings.concurrency.maxPerProject), defaultSettings.concurrency.maxPerProject);
  const maxGlobal = Math.max(normalizeRuntimeSettingNumber(String(settings?.concurrency?.maxGlobal ?? defaultSettings.concurrency.maxGlobal), defaultSettings.concurrency.maxGlobal), maxPerProject);
  return {
    ...defaultSettings,
    ...settings,
    adapterModels: settings?.adapterModels ?? defaultSettings.adapterModels,
    adapterDefaultArgs: settings?.adapterDefaultArgs ?? defaultSettings.adapterDefaultArgs,
    adapterCliPaths: settings?.adapterCliPaths ?? defaultSettings.adapterCliPaths,
    terminalEnv: settings?.terminalEnv ?? defaultSettings.terminalEnv,
    shell: { ...defaultSettings.shell, ...settings?.shell },
    concurrency: { maxPerProject, maxGlobal },
  };
}

function normalizeCodeMapSettings(settings?: Partial<CodeMapSettings>): CodeMapSettings {
  const defaultSettings: CodeMapSettings = {
    defaultScanScope: 'project',
    defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
    maxCallChainDepth: 3,
    showLowConfidenceEdges: false,
    layoutAlgorithm: 'hierarchical',
    graphCacheStrategy: 'sqlite',
    tableRelationInference: 'foreign_key_and_name',
    aiSummaryEnabled: false,
    incrementalScanEnabled: true,
    performanceMonitoringEnabled: false,
    moduleFlowManualNotes: '',
  };
  return {
    ...defaultSettings,
    ...settings,
    defaultIgnoreDirectories: Array.isArray(settings?.defaultIgnoreDirectories) ? settings.defaultIgnoreDirectories : defaultSettings.defaultIgnoreDirectories,
    maxCallChainDepth: typeof settings?.maxCallChainDepth === 'number' ? settings.maxCallChainDepth : defaultSettings.maxCallChainDepth,
    moduleFlowManualNotes: typeof settings?.moduleFlowManualNotes === 'string' ? settings.moduleFlowManualNotes : defaultSettings.moduleFlowManualNotes,
  };
}

function parseRuntimeTerminalEnvText(text: string): RuntimeSettings['terminalEnv'] {
  const env: RuntimeSettings['terminalEnv'] = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    const name = key.trim();
    const value = valueParts.join('=').trim();
    // 只保存明确的键值对，避免把空变量写进真实 Runtime 子进程环境。
    if (!name || !value) continue;
    env[name] = value;
  }
  return env;
}

export function resolveRuntimeNormalizedLogPath(events: AiRuntimeTerminalEvent[]): string | undefined {
  const chunkPath = events.find((event) => event.rawChunkPath?.includes('/chunks/'))?.rawChunkPath;
  if (!chunkPath) return undefined;
  return chunkPath.replace(/\/chunks\/[^/]+$/u, '/terminal.normalized.log');
}

function normalizeRuntimeSettingNumber(value: string, fallback: number, max = 20): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
}
