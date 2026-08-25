import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import { PaperclipIcon as Paperclip } from '@phosphor-icons/react/dist/csr/Paperclip';
import { TargetIcon as Target } from '@phosphor-icons/react/dist/csr/Target';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { animate as animateMotion, motion, useMotionValue, useTransform } from 'framer-motion';
import { type ConversationContextDraft, type ConversationFileLocation, type ConversationOpenTarget, type TurnChangeFile, type ZeusBrowserPreparedSubmission } from '@zeus/shared';
import type { ProjectGitAction, ProjectGitActionResponse, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import { openConversationResourceInMain, openTurnChangeFileInMain } from '../appShellBridge.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { canSteerActiveTurn, type ComposerRuntimeSettings, ConversationComposer, type ConversationComposerProps, resolveComposerKeyIntent } from './ConversationComposer.js';
import { ConversationTranscript, type ConversationTranscriptProps, type SessionCreationStatus } from './ConversationTranscript.js';
import { SessionPlanProgress } from './SessionActivity.js';
import { LegacyConversationBanner } from './LegacyConversationBanner.js';
import { hasPendingRequestDetails, PendingRequestSurface, requestKind } from './PendingRequestSurface.js';
import { PermissionModeControl } from './PermissionModeControl.js';
import { CollaborationModeControl } from './CollaborationModeControl.js';
import { ComposerDropdown } from './ComposerDropdown.js';
import { PlanImplementationRequestSurface } from './PlanImplementationRequestSurface.js';
import { PlanWorkspace } from './PlanWorkspace.js';
import { BrowserWorkspace } from './BrowserWorkspace.js';
import { SourceWorkspace } from './SourceWorkspace.js';
import { TurnDiffWorkspace } from './TurnChanges.js';
import { SideChatWorkspace } from './SideChatWorkspace.js';
import { SubagentWorkspace } from './SubagentWorkspace.js';
import { RuntimeDetails } from './RuntimeDetails.js';
import { defaultOpenTarget } from './ConversationResources.js';
import type {
  CodexConversationCapabilities,
  ConversationResource,
  ConversationResourcePreview,
  NativeCollaborationMode,
  NativeConversationAttachment,
  NativeConversationAttentionKind,
  NativeConversationChoice,
  NativeConversationContentV2Page,
  NativeConversationStage,
  NativeConversationStartDispatchResult,
  NativeConversationToolResultPage,
  NativeNextTurnSettings,
  NativeOperationAcceptance,
  NativePendingRequest,
  NativePermissionMode,
  NativePlanImplementationRequest,
  NativeServiceTierSelection,
  NativeSessionItemBuffer,
  NativeSessionState,
  NativeRuntimeDetailsSnapshot,
  NativeRuntimeFact,
  NativeSubagentListSnapshot,
  NativeSubagentThreadSnapshot,
  NativeTurnSettingsSelection,
  SessionConversationOwner,
  StartNativeConversationRequest,
  StartProjectConversationRequest,
  TaskWorkspacesSnapshot,
  TurnChangeSet,
  TurnChangeSetOperationResult,
} from './sessionTypes.js';
import { normalizeServiceTierSelection, selectionFromEffectiveServiceTier, serviceTierWireOverride } from './serviceTierSelection.js';
import { type SessionController, type SessionControllerClient, useSessionControllerInstance, useSessionControllerSelector } from './useSessionController.js';
import { createConversationComposerStateSelector, createConversationTranscriptStateSelector, createSessionWorkspaceStateSelector } from './sessionStateSlices.js';
import { createSessionEscapeController, type SessionEscapeController, type SessionEscapeLayer, type SessionEscapeResult } from './useThreadScrollController.js';
import { SafeMarkdown, type SessionUiLanguage } from './ThreadItemView.js';
import { autosizeTextarea } from './textareaAutosize.js';
import { conversationAttachmentIdentity, ConversationComposerAttachments } from './ConversationComposerAttachments.js';
import { ContextUsageIndicator } from './ContextUsageIndicator.js';
import { ServiceTierToggle } from './ServiceTierToggle.js';
import { useConversationInputResources } from './useConversationInputResources.js';
import { SessionQuickActionsCard } from './SessionQuickActionsCard.js';
import type { SessionCodeReviewSelection } from './SessionCodeReviewDialog.js';
import { conversationDisplayTitle } from './conversationDisplayTitle.js';
import { conversationRuntimePreferenceKind, readConversationRuntimePreferences, writeConversationRuntimePreferences } from './conversationRuntimePreferences.js';
import { resolveModelCapability } from './modelSelection.js';
import { GoalPanel, GoalRail } from './GoalPanel.js';
import { presentModelOptions } from '../modelOptionPresentation.js';
import { NewConversationExecutionContext } from './NewConversationExecutionContext.js';
import { formatVisibleApplicationError, useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';

export interface SessionWorkspaceTaskManagementStatus {
  id: string;
  label: string;
  color: string;
}

export interface SessionWorkspaceTask {
  id: string;
  projectId: string;
  title: string;
  managementStatus?: SessionWorkspaceTaskManagementStatus;
  managementStatusOptions?: readonly SessionWorkspaceTaskManagementStatus[];
}

export type SessionStartMode = 'create' | 'resume' | 'reference_legacy';

export interface SessionWorkspaceStartInput {
  mode: SessionStartMode;
  source?: 'code_review';
  task: SessionWorkspaceTask;
  inheritConversationId?: string;
  conversation?: NativeConversationChoice;
  legacyMessageIds?: string[];
  content: string;
  attachments?: NativeConversationAttachment[];
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  serviceTierSelection: NativeServiceTierSelection;
  model?: string;
  effort?: string;
  agentKind?: 'codex' | 'pi';
  goalObjective?: string;
}

export interface ProjectSessionWorkspaceStartInput {
  owner: Extract<SessionConversationOwner, { kind: 'project' }>;
  content: string;
  attachments: NativeConversationAttachment[];
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  serviceTierSelection: NativeServiceTierSelection;
  model?: string;
  effort?: string;
  goalObjective?: string;
}

export interface SessionWorkspaceActions {
  onStartConversation?: (
    input: SessionWorkspaceStartInput,
  ) => void | boolean | NativeConversationStartPreparation | NativeConversationStartFailure | Promise<void | boolean | NativeConversationStartPreparation | NativeConversationStartFailure>;
  onStartProjectConversation?: (input: ProjectSessionWorkspaceStartInput) => void | boolean | NativeConversationStartFailure | Promise<void | boolean | NativeConversationStartFailure>;
  onLoadCapabilities?: (projectId: string) => Promise<CodexConversationCapabilities>;
  onSelectNewConversationProject?: (projectId: string) => void;
  onLoadNewConversationProjectGit?: (projectId: string) => Promise<ProjectGitWorkbenchSnapshot>;
  onExecuteNewConversationProjectGit?: (projectId: string, repositoryId: string, action: ProjectGitAction) => Promise<ProjectGitActionResponse>;
  onReconnect?: () => void | Promise<void>;
  onDraftChange?: (draft: string) => void;
  onSubmit?: (delivery: 'queue' | 'steer_now', settings?: NativeTurnSettingsSelection) => void | Promise<void>;
  onStageBrowserComments?: (prepared: ZeusBrowserPreparedSubmission) => void | Promise<void>;
  onRemoveBrowserSubmission?: () => void;
  onContextDraftChange?: (draft: ConversationContextDraft) => void;
  onAskSideChat?: (selectedText: string, question: string) => Promise<string>;
  onInterrupt?: (turnId: string) => void | Promise<void>;
  onChooseAttachments?: () => void | Promise<void>;
  onChooseStartAttachments?: () => Promise<NativeConversationAttachment[]>;
  onAddAttachments?: (attachments: NativeConversationAttachment[]) => void;
  onRemoveAttachment?: (attachment: NativeConversationAttachment) => void;
  onEditQueuedSubmission?: (submissionId: string, content: string) => void | Promise<void>;
  onRetryQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  onRerouteQueuedSubmission?: (submissionId: string, settings: NativeNextTurnSettings) => void | Promise<void>;
  onDeleteQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  onSendQueuedNow?: (submissionId: string) => void | Promise<void>;
  onReorderQueue?: (orderedSubmissionIds: string[]) => void | Promise<void>;
  onResumeQueue?: () => void | Promise<void>;
  onRecoverQueue?: () => void | Promise<void>;
  onRestoreArchivedConversation?: () => void | Promise<void>;
  onRespondToRequest?: (requestId: string, response: Record<string, unknown>) => void | Promise<void>;
  onEditUserItem?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  onSelectTask?: (task: SessionWorkspaceTask) => void;
  onOpenTaskDetail?: (taskId: string) => void;
  onTaskManagementStatusChange?: (taskId: string, status: string) => void | Promise<unknown>;
  onLoadTaskWorkspaces?: (taskId: string) => Promise<TaskWorkspacesSnapshot>;
  onOpenTaskGitReview?: (taskId: string, workspaceId: string | null, mode: 'commit' | 'push-only') => void;
  onOpenTaskGitDelivery?: (taskId: string, workspaceId?: string | null) => void;
  onOpenProjectCommands?: () => void;
  onOpenImportSettings?: (conversation: NativeConversationChoice) => void;
  onNextTurnSettingsChange?: (settings: ComposerRuntimeSettings) => void | Promise<void>;
  onPermissionModeChange?: (permissionMode: NativePermissionMode) => void | Promise<void>;
  onCollaborationModeChange?: (collaborationMode: NativeCollaborationMode) => void | Promise<void>;
  onSetGoal?: (objective: string) => void | Promise<void>;
  onPauseGoal?: () => void | Promise<void>;
  onResumeGoal?: () => void | Promise<void>;
  onClearGoal?: (confirmUnfinished: boolean) => void | Promise<void>;
  onRespondToPlanImplementationRequest?: (
    requestId: string,
    input: {
      action: 'implement' | 'refine' | 'dismiss';
      feedback?: string;
    },
  ) => void | Promise<void>;
  onSnoozeRequest?: (requestId: string) => void | Promise<void>;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => Promise<ConversationResourceOpenActionResult>;
  onOpenTurnChangeFile?: (changeSet: TurnChangeSet, file: TurnChangeFile, target: ConversationOpenTarget, location?: ConversationFileLocation) => Promise<ConversationResourceOpenActionResult>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  onLoadSubagents?: () => Promise<NativeSubagentListSnapshot>;
  onLoadSubagentThread?: (threadId: string) => Promise<NativeSubagentThreadSnapshot>;
  onOperateTurnChangeSet?: (changeSet: TurnChangeSet, action: 'undo' | 'reapply') => Promise<TurnChangeSetOperationResult>;
  onLoadEarlierHistory?: () => void | Promise<void>;
  onLoadTurnProcess?: (turnId: string) => void | Promise<void>;
  onLoadTurnArtifacts?: (turnId: string) => void | Promise<void>;
  onLoadV2Content?: (handle: string, offset?: number) => Promise<NativeConversationContentV2Page>;
  onLoadV2ToolResult?: (handle: string, offset?: number) => Promise<NativeConversationToolResultPage>;
}

export interface NativeConversationStartPreparation {
  state: 'preparing';
  cancel: () => void;
}

export interface NativeConversationStartFailure {
  state: 'failed';
  message: string;
}

export interface ConversationResourceOpenActionResult {
  opened: boolean;
  mode?: 'zeus_source' | 'zeus_browser' | 'external' | 'file' | 'clipboard';
  preview?: ConversationResourcePreview;
}

export interface NativeConversationStartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StartNativeConversationPayload =
  | {
      mode: 'create';
      source?: 'code_review';
      content: string;
      attachments?: NativeConversationAttachment[];
      inheritConversationId?: string;
      permissionMode: NativePermissionMode;
      collaborationMode: NativeCollaborationMode;
      serviceTier?: string | null;
      model?: string;
      effort?: string;
      agentKind?: 'codex' | 'pi';
      goalObjective?: string;
    }
  | { mode: 'resume'; conversationId: string; content: string; collaborationMode: NativeCollaborationMode }
  | {
      mode: 'reference_legacy';
      sourceConversationId: string;
      messageIds: string[];
      content: string;
      permissionMode: NativePermissionMode;
      collaborationMode: NativeCollaborationMode;
    };

interface PersistedNativeConversationStartEnvelope {
  version: 1;
  fingerprint: string;
  request: StartNativeConversationRequest;
}

export interface NativeConversationStartEnvelopeManager {
  prepare(input: SessionWorkspaceStartInput): StartNativeConversationRequest;

  clearAccepted(input: SessionWorkspaceStartInput, request: StartNativeConversationRequest, acceptance: NativeOperationAcceptance, operationIdentity: string): boolean;
  pending(task: Pick<SessionWorkspaceTask, 'id' | 'projectId'>): StartNativeConversationRequest | null;

  clearPending(task: Pick<SessionWorkspaceTask, 'id' | 'projectId'>, request: StartNativeConversationRequest, acceptance: NativeOperationAcceptance, operationIdentity: string): boolean;
  discardPending(task: Pick<SessionWorkspaceTask, 'id' | 'projectId'>, request: StartNativeConversationRequest): boolean;
}

export async function loadLegacyConversationDetail<T>(conversation: NativeConversationChoice, load: (projectId: string, sourceConversationId: string) => Promise<T>): Promise<{ sourceConversationId: string; detail: T }> {
  if (conversation.transportKind === 'codex_native') throw new Error('Native conversations must load Snapshot V2 instead of legacy reference details.');
  const sourceConversationId = conversation.legacySourceConversationId ?? conversation.id;
  return { sourceConversationId, detail: await load(conversation.projectId, sourceConversationId) };
}

export interface ConnectedSessionWorkspaceProps {
  language: SessionUiLanguage;
  client: SessionControllerClient;
  conversation: NativeConversationChoice;
  task: SessionWorkspaceTask | null;
  owner: SessionConversationOwner;
  choices?: NativeConversationChoice[];
  onChooseAttachments?: () => Promise<NativeConversationAttachment[]>;
  onStateChange?: (conversationId: string, state: NativeSessionState) => void;
  initialCachedState?: NativeSessionState;
  initialOptimisticState?: NativeSessionState;
  initialCapabilities?: CodexConversationCapabilities | null;
  /** false 时保持完整本地工作面，但绝不以临时身份连接服务端。 */
  controllerEnabled?: boolean;
  localState?: NativeSessionState;
  localActions?: SessionWorkspaceActions;
  creationStatus?: SessionWorkspaceProps['creationStatus'];
  suppressComposer?: boolean;
  /** 侧边栏既有会话只展示持久记录，不恢复操作面或实时订阅。 */
  historyOnly?: boolean;
  stableConversationId?: string;
  onStartConversation?: SessionWorkspaceActions['onStartConversation'];
  onStartProjectConversation?: SessionWorkspaceActions['onStartProjectConversation'];
  onOpenTaskDetail?: SessionWorkspaceActions['onOpenTaskDetail'];
  onTaskManagementStatusChange?: SessionWorkspaceActions['onTaskManagementStatusChange'];
  taskManagementStatusChangeBusy?: boolean;
  quickActionsSuppressed?: boolean;
  readOnlyGate?: SessionReadOnlyGate;
  onLoadTaskWorkspaces?: SessionWorkspaceActions['onLoadTaskWorkspaces'];
  onOpenTaskGitReview?: SessionWorkspaceActions['onOpenTaskGitReview'];
  onOpenTaskGitDelivery?: SessionWorkspaceActions['onOpenTaskGitDelivery'];
  onOpenProjectCommands?: SessionWorkspaceActions['onOpenProjectCommands'];
  onLatestContentVisibilityChange?: (visible: boolean) => void;
}

interface ConversationCapabilitiesCacheEntry {
  value: CodexConversationCapabilities | null;
  promise: Promise<CodexConversationCapabilities> | null;
}

interface ScopedSubagentSnapshot {
  conversationId: string;
  snapshot: NativeSubagentListSnapshot | null;
}

interface ScopedConversationCapabilities {
  projectId: string;
  value: CodexConversationCapabilities | null;
}

const conversationCapabilitiesCache = new WeakMap<SessionControllerClient, Map<string, ConversationCapabilitiesCacheEntry>>();

function conversationCapabilitiesEntry(client: SessionControllerClient, projectId: string): ConversationCapabilitiesCacheEntry {
  let projectCache = conversationCapabilitiesCache.get(client);
  if (!projectCache) {
    projectCache = new Map();
    conversationCapabilitiesCache.set(client, projectCache);
  }
  const current = projectCache.get(projectId);
  if (current) return current;
  const created: ConversationCapabilitiesCacheEntry = { value: null, promise: null };
  projectCache.set(projectId, created);
  return created;
}

/** 项目级模型能力只读取一次并复用；会话切换不能让底部模型选择器退回空白。 */
export function preloadCodexConversationCapabilities(client: SessionControllerClient, projectId: string): Promise<CodexConversationCapabilities | null> {
  const load = client.loadCodexConversationCapabilities;
  if (!load) return Promise.resolve(null);
  const entry = conversationCapabilitiesEntry(client, projectId);
  if (entry.value) return Promise.resolve(entry.value);
  if (entry.promise) return entry.promise;
  const promise = load(projectId)
    .then((capabilities) => {
      entry.value = capabilities;
      return capabilities;
    })
    .finally(() => {
      if (entry.promise === promise) entry.promise = null;
    });
  entry.promise = promise;
  return promise;
}

function refreshCodexConversationCapabilities(client: SessionControllerClient, projectId: string): Promise<CodexConversationCapabilities | null> {
  const load = client.loadCodexConversationCapabilities;
  if (!load) return Promise.resolve(null);
  const entry = conversationCapabilitiesEntry(client, projectId);
  if (entry.promise) return entry.promise;
  const promise = load(projectId)
    .then((capabilities) => {
      entry.value = capabilities;
      return capabilities;
    })
    .finally(() => {
      if (entry.promise === promise) entry.promise = null;
    });
  entry.promise = promise;
  return promise;
}

/** 同步读取已有项目能力，只用于首帧展示；提交仍由服务端重新复验。 */
export function readCachedCodexConversationCapabilities(client: SessionControllerClient, projectId: string): CodexConversationCapabilities | null {
  return conversationCapabilitiesEntry(client, projectId).value;
}

export function ConnectedSessionWorkspace(props: ConnectedSessionWorkspaceProps) {
  const controllerEnabled = props.controllerEnabled !== false;
  const [continuedHistoryConversationId, setContinuedHistoryConversationId] = useState<string | null>(null);
  const historySnapshotOnly = Boolean(props.historyOnly && continuedHistoryConversationId !== props.conversation.id);
  // 真实 id 到达时只重建内部 controller，外层工作面和输入 DOM 保持同一 React 身份。
  const initialCachedState = useMemo(() => props.initialCachedState, [props.conversation.id, props.conversation.projectId]);
  const initialOptimisticState = useMemo(() => props.initialOptimisticState, [props.conversation.id, props.conversation.projectId]);
  const controller = useSessionControllerInstance({
    client: props.client,
    projectId: props.conversation.projectId,
    conversationId: props.conversation.id,
    initialCachedState,
    initialOptimisticState,
    enabled: controllerEnabled,
    realtimePolicy: historySnapshotOnly ? 'lazy' : 'auto',
  });
  const workspaceStateSelector = useMemo(createSessionWorkspaceStateSelector, [controller]);
  const state = useSessionControllerSelector(controller, workspaceStateSelector);
  const [subagentScope, setSubagentScope] = useState<ScopedSubagentSnapshot>(() => ({ conversationId: props.conversation.id, snapshot: null }));
  const subagentListSnapshot = subagentScope.conversationId === props.conversation.id ? subagentScope.snapshot : null;
  useEffect(() => {
    const loadSubagents = props.client.loadNativeSubagents;
    if (!loadSubagents || props.conversation.transportKind !== 'codex_native') return;
    const conversationId = props.conversation.id;
    let active = true;
    void loadSubagents(props.conversation.projectId, conversationId)
      .then((snapshot) => {
        if (active) setSubagentScope({ conversationId, snapshot });
      })
      .catch(() => {
        // 智能体预读失败不影响主会话；用户打开面板时仍可手动重试。
      });
    return () => {
      active = false;
    };
  }, [props.client, props.conversation.id, props.conversation.projectId, props.conversation.transportKind]);
  const [capabilitiesScope, setCapabilitiesScope] = useState<ScopedConversationCapabilities>(() => ({
    projectId: props.conversation.projectId,
    value: props.initialCapabilities ?? readCachedCodexConversationCapabilities(props.client, props.conversation.projectId),
  }));
  const capabilities = props.initialCapabilities ?? (capabilitiesScope.projectId === props.conversation.projectId ? capabilitiesScope.value : readCachedCodexConversationCapabilities(props.client, props.conversation.projectId));
  useEffect(() => {
    const projectId = props.conversation.projectId;
    let active = true;
    const cached = props.initialCapabilities ?? readCachedCodexConversationCapabilities(props.client, projectId);
    if (cached) setCapabilitiesScope({ projectId, value: cached });
    void refreshCodexConversationCapabilities(props.client, projectId)
      .then((snapshot) => {
        if (active && snapshot) setCapabilitiesScope({ projectId, value: snapshot });
      })
      .catch(() => {
        // 已有能力保持可见；后台刷新失败不能让输入区和模型选择器闪回空态。
      });
    return () => {
      active = false;
    };
  }, [props.client, props.conversation.projectId, props.initialCapabilities]);
  useEffect(() => {
    if (!controllerEnabled || !props.onStateChange) return;
    const publish = (): void => props.onStateChange?.(props.conversation.id, controller.getState());
    publish();
    return controller.subscribe(publish);
  }, [controller, controllerEnabled, props.conversation.id, props.onStateChange]);
  useEffect(() => {
    if (!controllerEnabled || !props.localState) return;
    // 权威会话已经接管后，创建期 localState 只能作为历史展示，不能再把旧草稿写回真实会话。
    if (controller.getState().snapshot?.id === props.conversation.id) return;
    // 权威快照接管前继续承接用户输入，避免同一工作面切换读写身份时丢失草稿或附件。
    controller.setDraft(props.localState.draft);
    controller.setAttachments(props.localState.attachments);
    controller.setBrowserSubmission(props.localState.browserSubmission);
    controller.setContextDraft(props.localState.contextDraft);
  }, [controller, controllerEnabled, props.localState?.attachments, props.localState?.browserSubmission, props.localState?.contextDraft, props.localState?.draft]);
  const displayedConversation = props.stableConversationId ? { ...props.conversation, id: props.stableConversationId } : props.conversation;
  const controllerHasSnapshot = controllerEnabled && state.snapshot?.id === props.conversation.id;
  const controllerFailed = controllerEnabled && state.transportState === 'failed';
  // 已经取得的完整正文始终优先于首发本地投影；后台校准只更新状态，不能让消息区退回第一条消息。
  const controllerVisible = controllerHasSnapshot || (controllerFailed && !props.creationStatus && Boolean(state.snapshot));
  // 普通会话冷切换时直接使用目标 controller；其 send 会在快照就绪前安全排队。
  // 创建期仍优先使用 localActions，避免临时会话身份提前连接服务端。
  const controllerActionsAvailable = controllerVisible || (controllerEnabled && !props.localState);
  const controllerInteractive = !historySnapshotOnly && controllerActionsAvailable;
  const displayedState = controllerVisible ? state : (props.localState ?? state);
  const transcriptLoading = controllerEnabled && !controllerVisible && !state.snapshot && ['connecting', 'hydrating', 'reconnecting'].includes(state.transportState);
  const displayedCreationStatus: SessionCreationStatus | undefined = historySnapshotOnly
    ? undefined
    : controllerFailed && props.creationStatus
      ? {
          state: 'failed',
          message: props.language === 'zh-CN' ? '连接失败' : 'Connection failed',
          error: state.error?.message,
          retryLabel: props.language === 'zh-CN' ? '重新连接' : 'Reconnect',
          onRetry: () => controller.reconnect(),
        }
      : controllerVisible && props.creationStatus?.state !== 'warning'
        ? undefined
        : props.creationStatus;
  const connectedActions = useMemo(() => createConnectedSessionActions({ controller, onChooseAttachments: props.onChooseAttachments }), [controller, props.onChooseAttachments]);
  const workspaceActions = useMemo<SessionWorkspaceActions>(() => {
    const projectId = props.conversation.projectId;
    const conversationId = props.conversation.id;
    // 资源、深历史和变更文件读取都是只读能力。它们必须同时存在于冷历史工作面
    // 和续聊后的交互工作面；不能因为第一条新消息让图片预览能力从 actions 消失。
    const controllerReadActions: SessionWorkspaceActions = {
      onLoadEarlierHistory: connectedActions.onLoadEarlierHistory,
      onLoadTurnProcess: connectedActions.onLoadTurnProcess,
      onLoadTurnArtifacts: connectedActions.onLoadTurnArtifacts,
      onLoadV2Content: connectedActions.onLoadV2Content,
      onLoadV2ToolResult: connectedActions.onLoadV2ToolResult,
      onOpenResource: async (resource, target, location) => {
        const result = await openConversationResourceInMain({
          zeus: window.zeus,
          projectId,
          conversationId,
          resourceId: resource.id,
          target,
          ...(location ? { location } : {}),
        });
        if (!result.opened) throw new Error(result.error ?? 'conversation_resource_open_failed');
        if (result.mode !== 'zeus_source') return { opened: true, mode: result.mode };
        if (!props.client.loadConversationResourcePreview) throw new Error('conversation_resource_preview_unavailable');
        const preview = await props.client.loadConversationResourcePreview(projectId, conversationId, resource.id);
        return { opened: true, mode: result.mode, preview: location ? { ...preview, location } : preview };
      },
      onLoadResourcePreview: async (resource) => {
        if (!props.client.loadConversationResourcePreview) throw new Error('conversation_resource_preview_unavailable');
        return props.client.loadConversationResourcePreview(projectId, conversationId, resource.id);
      },
      onOpenTurnChangeFile: async (changeSet, file, target, location) => {
        const result = await openTurnChangeFileInMain({
          zeus: window.zeus,
          projectId,
          conversationId,
          turnId: changeSet.providerTurnId,
          changeSetId: changeSet.id,
          fileId: file.id,
          target,
          ...(location ? { location } : {}),
        });
        if (!result.opened) throw new Error(result.error ?? 'turn_change_file_open_failed');
        if (result.mode !== 'zeus_source') return { opened: true, mode: result.mode };
        if (!props.client.loadTurnChangeFilePreview) throw new Error('conversation_resource_preview_unavailable');
        const preview = await props.client.loadTurnChangeFilePreview(projectId, conversationId, changeSet.providerTurnId, changeSet.id, file.id);
        return { opened: true, mode: result.mode, preview: location ? { ...preview, location } : preview };
      },
    };
    return {
      ...(controllerInteractive
        ? { ...connectedActions, ...controllerReadActions }
        : controllerActionsAvailable
          ? {
              ...(historySnapshotOnly
                ? {
                    onDraftChange: connectedActions.onDraftChange,
                    onSubmit: (delivery: 'queue' | 'steer_now', settings?: NativeTurnSettingsSelection) => {
                      setContinuedHistoryConversationId(conversationId);
                      return connectedActions.onSubmit?.(delivery, settings);
                    },
                    onChooseAttachments: connectedActions.onChooseAttachments,
                    onAddAttachments: connectedActions.onAddAttachments,
                    onRemoveAttachment: connectedActions.onRemoveAttachment,
                    onRemoveBrowserSubmission: connectedActions.onRemoveBrowserSubmission,
                    onContextDraftChange: connectedActions.onContextDraftChange,
                    onNextTurnSettingsChange: connectedActions.onNextTurnSettingsChange,
                    onPermissionModeChange: connectedActions.onPermissionModeChange,
                    onCollaborationModeChange: connectedActions.onCollaborationModeChange,
                  }
                : {}),
              ...controllerReadActions,
            }
          : props.localActions),
      ...(controllerInteractive
        ? {
            onOperateTurnChangeSet: async (changeSet, action) => {
              if (!props.client.operateTurnChangeSet) throw new Error('turn_change_set_operation_unavailable');
              return props.client.operateTurnChangeSet(projectId, conversationId, changeSet.providerTurnId, action, {
                changeSetId: changeSet.id,
                expectedState: action === 'undo' ? 'applied' : 'undone',
                idempotencyKey: crypto.randomUUID(),
              });
            },
            onSetGoal: async (objective) => {
              await props.client.setNativeGoal(projectId, conversationId, objective);
              await controller.reconnect();
            },
            onPauseGoal: async () => {
              await props.client.pauseNativeGoal(projectId, conversationId);
              await controller.reconnect();
            },
            onResumeGoal: async () => {
              await props.client.resumeNativeGoal(projectId, conversationId);
              await controller.reconnect();
            },
            onClearGoal: async (confirmUnfinished) => {
              await props.client.clearNativeGoal(projectId, conversationId, confirmUnfinished);
              await controller.reconnect();
            },
            ...(props.client.askNativeSideChat
              ? {
                  onAskSideChat: async (selectedText: string, question: string) => {
                    const result = await props.client.askNativeSideChat!(projectId, conversationId, { selectedText, question });
                    return result.answer;
                  },
                }
              : {}),
          }
        : {}),
      ...(props.client.loadNativeSubagents && props.client.loadNativeSubagentThread
        ? {
            onLoadSubagents: () => props.client.loadNativeSubagents!(projectId, conversationId),
            onLoadSubagentThread: (threadId: string) => props.client.loadNativeSubagentThread!(projectId, conversationId, threadId),
          }
        : {}),
      onStartConversation: props.onStartConversation,
      onStartProjectConversation: props.onStartProjectConversation,
      onOpenTaskDetail: props.onOpenTaskDetail,
      onTaskManagementStatusChange: props.onTaskManagementStatusChange,
      onLoadTaskWorkspaces: props.onLoadTaskWorkspaces,
      onOpenTaskGitReview: props.onOpenTaskGitReview,
      onOpenTaskGitDelivery: props.onOpenTaskGitDelivery,
      onOpenProjectCommands: props.onOpenProjectCommands,
      onLoadCapabilities: props.client.loadCodexConversationCapabilities,
      onChooseStartAttachments: props.onChooseAttachments,
    };
  }, [
    connectedActions,
    controller,
    controllerActionsAvailable,
    controllerInteractive,
    historySnapshotOnly,
    props.client,
    props.conversation.id,
    props.conversation.projectId,
    props.localActions,
    props.onChooseAttachments,
    props.onLoadTaskWorkspaces,
    props.onOpenProjectCommands,
    props.onOpenTaskDetail,
    props.onOpenTaskGitDelivery,
    props.onOpenTaskGitReview,
    props.onStartConversation,
    props.onStartProjectConversation,
    props.onTaskManagementStatusChange,
  ]);
  return (
    <SessionWorkspace
      language={props.language}
      state={displayedState}
      stateController={displayedState === state ? controller : undefined}
      conversation={displayedConversation}
      task={props.task}
      owner={props.owner}
      choices={props.choices}
      capabilities={capabilities}
      suppressComposer={props.suppressComposer || (!props.historyOnly && Boolean(props.readOnlyGate))}
      historyOnly={historySnapshotOnly}
      projectPersistedPlans
      quickActionsSuppressed={props.quickActionsSuppressed}
      taskManagementStatusChangeBusy={props.taskManagementStatusChangeBusy}
      readOnlyGate={props.historyOnly ? undefined : props.readOnlyGate}
      subagentListSnapshot={subagentListSnapshot}
      transcriptLoading={transcriptLoading}
      creationStatus={displayedCreationStatus}
      onLatestContentVisibilityChange={props.onLatestContentVisibilityChange}
      actions={workspaceActions}
    />
  );
}

export function resolveSessionWorkspaceEscape(input: {
  controller: SessionEscapeController;
  eventTarget: EventTarget | object | null;
  composerTextarea: HTMLTextAreaElement | object | null;
  repeat: boolean;
  openLayers: readonly SessionEscapeLayer[];
  responding: boolean;
  activeTurnId: string | null;
  startedTurnId: string | null;
  now: number;
}): SessionEscapeResult {
  return input.controller.handleEscape({
    repeat: input.repeat,
    openLayers: input.openLayers,
    inputFocused: input.composerTextarea !== null && input.eventTarget === input.composerTextarea,
    responding: input.responding,
    activeTurnId: input.activeTurnId,
    startedTurnId: input.startedTurnId,
    now: input.now,
  });
}

export function createConnectedSessionActions(input: { controller: SessionController; onChooseAttachments?: () => Promise<NativeConversationAttachment[]> }): SessionWorkspaceActions {
  const settle = async (operation: Promise<unknown>): Promise<void> => {
    try {
      await operation;
    } catch {
      // 控制器已把失败写回 typed state；组件只避免产生未处理的 Promise rejection。
    }
  };
  const addAttachments = (attachments: NativeConversationAttachment[]) => {
    const currentAttachments = input.controller.getState().attachments;
    const byIdentity = new Map(currentAttachments.map((attachment) => [conversationAttachmentIdentity(attachment), attachment]));
    attachments.forEach((attachment) => byIdentity.set(conversationAttachmentIdentity(attachment), attachment));
    input.controller.setAttachments([...byIdentity.values()]);
  };
  return {
    onReconnect: () => settle(input.controller.reconnect()),
    onDraftChange: input.controller.setDraft,
    onSubmit: (delivery, settings) => {
      const currentState = input.controller.getState();
      const effectiveDelivery = delivery === 'steer_now' && canSteerActiveTurn(currentState) ? 'steer_now' : 'queue';
      return settle(input.controller.send(effectiveDelivery, effectiveDelivery === 'steer_now' ? (currentState.activeTurnId ?? undefined) : undefined, effectiveDelivery === 'queue' ? settings : undefined));
    },
    onStageBrowserComments: (prepared) => input.controller.setBrowserSubmission(prepared),
    onRemoveBrowserSubmission: () => input.controller.setBrowserSubmission(null),
    onContextDraftChange: (draft) => input.controller.setContextDraft(draft),
    onInterrupt: () => settle(input.controller.interruptActiveTurn()),
    ...(input.onChooseAttachments
      ? {
          onChooseAttachments: async () => {
            const attachments = await input.onChooseAttachments?.();
            if (attachments?.length) addAttachments(attachments);
          },
        }
      : {}),
    onAddAttachments: addAttachments,
    onRemoveAttachment: (attachment) => {
      input.controller.setAttachments(input.controller.getState().attachments.filter((candidate) => candidate !== attachment));
    },
    // 编辑器只有在服务端确认后才退出；失败必须向组件传播以保留用户草稿。
    onEditQueuedSubmission: async (submissionId, content) => {
      await input.controller.editQueuedSubmission(submissionId, content);
    },
    onRetryQueuedSubmission: (submissionId) => settle(input.controller.retryQueuedSubmission(submissionId)),
    onRerouteQueuedSubmission: (submissionId, settings) => settle(input.controller.rerouteQueuedSubmission(submissionId, settings)),
    // 删除未进入 provider turn 的内容是本地软删除，不会触发 Provider 重发。
    onDeleteQueuedSubmission: (submissionId) => settle(input.controller.deleteQueuedSubmission(submissionId)),
    // 引导失败必须交给队列气泡处理并进入统一错误弹窗，不能像后台刷新一样静默吞掉。
    onSendQueuedNow: async (submissionId) => {
      await input.controller.sendQueuedNow(submissionId);
    },
    onReorderQueue: (orderedSubmissionIds) => settle(input.controller.reorderQueue(orderedSubmissionIds)),
    onResumeQueue: () => settle(input.controller.resumeQueue()),
    onRecoverQueue: () => settle(input.controller.recoverQueue()),
    onRestoreArchivedConversation: () => settle(input.controller.restoreArchivedConversation()),
    onRespondToRequest: (requestId, response) => input.controller.respondToRequest(requestId, response).then(() => undefined),
    onRespondToPlanImplementationRequest: (requestId, response) => input.controller.respondToPlanImplementationRequest(requestId, response),
    onSnoozeRequest: (requestId) => input.controller.snoozeRequest(requestId).then(() => undefined),
    onNextTurnSettingsChange: (settings) => input.controller.setNextTurnSettings(settings).then(() => undefined),
    onPermissionModeChange: (permissionMode) => settle(input.controller.setPermissionMode(permissionMode)),
    onCollaborationModeChange: (collaborationMode) => settle(input.controller.setCollaborationMode(collaborationMode)),
    onLoadEarlierHistory: () => settle(input.controller.loadEarlierHistory()),
    onLoadTurnProcess: (turnId) => settle(input.controller.loadTurnProcess(turnId)),
    onLoadTurnArtifacts: (turnId) => settle(input.controller.loadTurnArtifacts(turnId)),
    onLoadV2Content: (handle, offset) => input.controller.loadV2Content(handle, offset),
    onLoadV2ToolResult: (handle, offset) => input.controller.loadV2ToolResult(handle, offset),
    onEditUserItem: async (_item, content) => {
      const current = input.controller.getState();
      const active = current.conversationState === 'active_prework' || current.conversationState === 'active_final_answer';
      if (current.transportState !== 'ready' || (!active && current.conversationState !== 'native_idle')) {
        throw new Error('Conversation is not writable.');
      }
      input.controller.setDraft(content);
      const selectedSettings = current.snapshot?.nextTurnSettings;
      const settings =
        (selectedSettings?.model ?? current.providerSettings?.model)
          ? {
              model: selectedSettings?.model ?? current.providerSettings!.model,
              ...((selectedSettings?.effort ?? current.providerSettings?.effort) ? { effort: selectedSettings?.effort ?? current.providerSettings?.effort } : {}),
              ...(selectedSettings && Object.prototype.hasOwnProperty.call(selectedSettings, 'serviceTier')
                ? { serviceTier: selectedSettings.serviceTier }
                : current.providerSettings && Object.prototype.hasOwnProperty.call(current.providerSettings, 'serviceTier')
                  ? { serviceTier: current.providerSettings.serviceTier }
                  : {}),
              permissionMode: current.snapshot?.nextTurnSettings?.permissionMode ?? current.snapshot?.permissionMode ?? 'read-only',
              collaborationMode: current.snapshot?.nextTurnSettings?.collaborationMode ?? current.snapshot?.collaborationMode ?? 'default',
            }
          : undefined;
      await input.controller.send('queue', undefined, settings);
    },
  };
}

export function buildStartNativeConversationRequest(input: SessionWorkspaceStartInput, createId: () => string): StartNativeConversationRequest {
  return { ...buildStartNativeConversationPayload(input), idempotencyKey: createId(), clientUserMessageId: createId() } as StartNativeConversationRequest;
}

/** 在尽力刷新历史记录前，先把已持久接受的启动结果转成可选会话行。 */
export function nativeConversationChoiceFromAcceptance(acceptance: NativeOperationAcceptance, task: Pick<SessionWorkspaceTask, 'id' | 'projectId' | 'title'>, now = new Date().toISOString()): NativeConversationChoice {
  const conversation = acceptance.conversation;
  const provider = isRecord(conversation.provider) ? conversation.provider : {};
  const nativeSession = isRecord(conversation.nativeSession) ? conversation.nativeSession : {};
  return {
    id: acceptance.conversation.id,
    projectId: stringField(conversation.projectId) ?? task.projectId,
    taskId: stringField(conversation.taskId) ?? task.id,
    title: stringField(conversation.title) ?? task.title,
    summary: nullableStringField(conversation.summary),
    status: stringField(conversation.status) ?? 'active',
    stage: conversationStageField(conversation.stage) ?? 'created',
    stageUpdatedAt: stringField(conversation.stageUpdatedAt) ?? stringField(conversation.createdAt) ?? now,
    transportKind: stringField(conversation.transportKind) ?? 'codex_native',
    providerId: stringField(conversation.providerId) ?? stringField(provider.id) ?? 'codex',
    providerThreadId: stringField(conversation.providerThreadId) ?? stringField(provider.threadId),
    providerModel: stringField(conversation.providerModel) ?? stringField(provider.model),
    providerState: stringField(conversation.providerState) ?? stringField(provider.state),
    nativeSession: {
      id: stringField(nativeSession.id) ?? stringField(conversation.providerThreadId) ?? stringField(provider.threadId),
      path: nullableStringField(nativeSession.path),
    },
    ...nativeAgentAndModelIdentity(conversation),
    permissionMode: permissionModeField(conversation.permissionMode),
    collaborationMode: conversation.collaborationMode === 'plan' ? 'plan' : 'default',
    createdAt: stringField(conversation.createdAt) ?? now,
    updatedAt: stringField(conversation.updatedAt) ?? now,
    archived: conversation.archived === true,
    hasUnreadAttention: conversation.hasUnreadAttention === true,
    attentionKind: conversationAttentionKindField(conversation.attentionKind),
    attentionRevision: typeof conversation.attentionRevision === 'number' ? conversation.attentionRevision : 0,
    attentionTurnId: nullableStringField(conversation.attentionTurnId),
    attentionUpdatedAt: nullableStringField(conversation.attentionUpdatedAt),
    pendingRequestKind: conversation.pendingRequestKind === 'user_input' ? 'user_input' : conversation.pendingRequestKind === 'approval' ? 'approval' : null,
    resumable: conversation.resumable !== false,
    readOnly: conversation.readOnly === true,
  };
}

export async function startNativeConversationWithDurableAcceptance<T>(options: {
  input: SessionWorkspaceStartInput;
  envelopeManager: NativeConversationStartEnvelopeManager;
  dispatch: (taskId: string, request: StartNativeConversationRequest) => Promise<NativeConversationStartDispatchResult>;
  onAccepted: (choice: NativeConversationChoice) => void | Promise<void>;
  refresh: (taskId: string) => Promise<T>;
}): Promise<{ choice: NativeConversationChoice; request: StartNativeConversationRequest; acceptance: NativeOperationAcceptance; refreshResult: T | null; refreshError: unknown | null }> {
  const request = options.envelopeManager.prepare(options.input);
  const { acceptance, operationIdentity } = await options.dispatch(options.input.task.id, request);
  if (!isDurableNativeConversationAcceptance(request, acceptance, operationIdentity)) throw new Error('Native conversation start did not return a durable accepted operation.');
  options.envelopeManager.clearAccepted(options.input, request, acceptance, operationIdentity);
  const choice = nativeConversationChoiceFromAcceptance(acceptance, options.input.task);
  // acceptance 导航属于 durable 边界，必须先于摘要刷新发生。
  await options.onAccepted(choice);
  try {
    return { choice, request, acceptance, refreshResult: await options.refresh(options.input.task.id), refreshError: null };
  } catch (refreshError) {
    return { choice, request, acceptance, refreshResult: null, refreshError };
  }
}

interface PersistedProjectConversationStartEnvelope {
  version: 1;
  fingerprint: string;
  request: StartProjectConversationRequest;
}

export interface ProjectConversationStartEnvelopeManager {
  prepare(input: ProjectSessionWorkspaceStartInput): StartProjectConversationRequest;

  clearAccepted(input: ProjectSessionWorkspaceStartInput, request: StartProjectConversationRequest, acceptance: NativeOperationAcceptance, operationIdentity: string): boolean;
}

/** 项目级首发在请求前持久化完整输入 envelope，重载或未知结果重试时复用同一组身份。 */
export function createProjectConversationStartEnvelopeManager(options: {
  storage?: NativeConversationStartStorage;
  createId: () => string;
  releaseRequest?: (projectId: string, request: StartProjectConversationRequest) => void;
}): ProjectConversationStartEnvelopeManager {
  return {
    prepare(input) {
      if (!options.storage) throw new Error('Project conversation start requires durable local storage.');
      const requestPayload = buildProjectConversationStartPayload(input);
      const fingerprint = JSON.stringify({ projectId: input.owner.projectId, payload: requestPayload });
      const storageKey = projectConversationStartStorageKey(input.owner.projectId);
      const persisted = readPersistedProjectConversationStartEnvelope(options.storage, storageKey);
      if (persisted && persisted.fingerprint === fingerprint && projectRequestMatchesPayload(persisted.request, requestPayload)) return persisted.request;
      const request: StartProjectConversationRequest = { ...requestPayload, idempotencyKey: options.createId(), clientUserMessageId: options.createId() };
      try {
        options.storage.setItem(storageKey, JSON.stringify({ version: 1, fingerprint, request } satisfies PersistedProjectConversationStartEnvelope));
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'ZEUS_PROJECT_CONVERSATION_START_PERSIST_FAILED' });
      }
      return request;
    },
    clearAccepted(input, request, acceptance, operationIdentity) {
      if (!options.storage || !isDurableNativeConversationAcceptance(request, acceptance, operationIdentity)) return false;
      const requestPayload = buildProjectConversationStartPayload(input);
      const fingerprint = JSON.stringify({ projectId: input.owner.projectId, payload: requestPayload });
      const storageKey = projectConversationStartStorageKey(input.owner.projectId);
      const persisted = readPersistedProjectConversationStartEnvelope(options.storage, storageKey);
      if (!persisted || persisted.fingerprint !== fingerprint || persisted.request.idempotencyKey !== request.idempotencyKey || persisted.request.clientUserMessageId !== request.clientUserMessageId) return false;
      try {
        options.storage.removeItem(storageKey);
        options.releaseRequest?.(input.owner.projectId, request);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function projectConversationChoiceFromAcceptance(acceptance: NativeOperationAcceptance, owner: Extract<SessionConversationOwner, { kind: 'project' }>, now = new Date().toISOString()): NativeConversationChoice {
  const conversation = acceptance.conversation;
  const provider = isRecord(conversation.provider) ? conversation.provider : {};
  const nativeSession = isRecord(conversation.nativeSession) ? conversation.nativeSession : {};
  return {
    id: conversation.id,
    projectId: stringField(conversation.projectId) ?? owner.projectId,
    taskId: null,
    title: stringField(conversation.title) ?? owner.projectName,
    summary: nullableStringField(conversation.summary),
    status: stringField(conversation.status) ?? 'active',
    stage: conversationStageField(conversation.stage) ?? 'created',
    stageUpdatedAt: stringField(conversation.stageUpdatedAt) ?? stringField(conversation.createdAt) ?? now,
    transportKind: stringField(conversation.transportKind) ?? 'codex_native',
    providerId: stringField(conversation.providerId) ?? stringField(provider.id) ?? 'codex',
    providerThreadId: stringField(conversation.providerThreadId) ?? stringField(provider.threadId),
    providerModel: stringField(conversation.providerModel) ?? stringField(provider.model),
    providerState: stringField(conversation.providerState) ?? stringField(provider.state),
    nativeSession: {
      id: stringField(nativeSession.id) ?? stringField(conversation.providerThreadId) ?? stringField(provider.threadId),
      path: nullableStringField(nativeSession.path),
    },
    ...nativeAgentAndModelIdentity(conversation),
    permissionMode: permissionModeField(conversation.permissionMode),
    collaborationMode: conversation.collaborationMode === 'plan' ? 'plan' : 'default',
    createdAt: stringField(conversation.createdAt) ?? now,
    updatedAt: stringField(conversation.updatedAt) ?? now,
    archived: conversation.archived === true,
    hasUnreadAttention: conversation.hasUnreadAttention === true,
    attentionKind: conversationAttentionKindField(conversation.attentionKind),
    attentionRevision: typeof conversation.attentionRevision === 'number' ? conversation.attentionRevision : 0,
    attentionTurnId: nullableStringField(conversation.attentionTurnId),
    attentionUpdatedAt: nullableStringField(conversation.attentionUpdatedAt),
    pendingRequestKind: conversation.pendingRequestKind === 'user_input' ? 'user_input' : conversation.pendingRequestKind === 'approval' ? 'approval' : null,
    resumable: conversation.resumable !== false,
    readOnly: conversation.readOnly === true,
  };
}

export async function startProjectConversationWithDurableAcceptance<T>(options: {
  input: ProjectSessionWorkspaceStartInput;
  envelopeManager: ProjectConversationStartEnvelopeManager;
  dispatch: (projectId: string, request: StartProjectConversationRequest) => Promise<NativeConversationStartDispatchResult>;
  onAccepted: (choice: NativeConversationChoice) => void | Promise<void>;
  refresh: (projectId: string) => Promise<T>;
}): Promise<{ choice: NativeConversationChoice; request: StartProjectConversationRequest; acceptance: NativeOperationAcceptance; refreshResult: T | null; refreshError: unknown | null }> {
  const request = options.envelopeManager.prepare(options.input);
  const { acceptance, operationIdentity } = await options.dispatch(options.input.owner.projectId, request);
  if (!isDurableNativeConversationAcceptance(request, acceptance, operationIdentity)) throw new Error('Project conversation start did not return a durable accepted operation.');
  options.envelopeManager.clearAccepted(options.input, request, acceptance, operationIdentity);
  const choice = projectConversationChoiceFromAcceptance(acceptance, options.input.owner);
  await options.onAccepted(choice);
  try {
    return { choice, request, acceptance, refreshResult: await options.refresh(options.input.owner.projectId), refreshError: null };
  } catch (refreshError) {
    return { choice, request, acceptance, refreshResult: null, refreshError };
  }
}

function buildProjectConversationStartPayload(input: ProjectSessionWorkspaceStartInput): Omit<StartProjectConversationRequest, 'idempotencyKey' | 'clientUserMessageId'> {
  if (!input.content.trim() && input.attachments.length === 0) throw new Error('Project conversation start content or attachments are required.');
  return {
    mode: 'create',
    content: input.content,
    attachments: input.attachments,
    permissionMode: input.permissionMode ?? 'auto',
    collaborationMode: input.collaborationMode ?? 'default',
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...serviceTierWireOverride(input.serviceTierSelection),
    ...(input.goalObjective ? { goalObjective: input.goalObjective } : {}),
  };
}

function projectConversationStartStorageKey(projectId: string): string {
  return `zeus.project-conversation-start:v1:${encodeURIComponent(projectId)}`;
}

function readPersistedProjectConversationStartEnvelope(storage: NativeConversationStartStorage, storageKey: string): PersistedProjectConversationStartEnvelope | null {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedProjectConversationStartEnvelope>;
    if (parsed.version !== 1 || typeof parsed.fingerprint !== 'string' || !isProjectConversationStartRequest(parsed.request)) return null;
    return parsed as PersistedProjectConversationStartEnvelope;
  } catch {
    return null;
  }
}

function isProjectConversationStartRequest(value: unknown): value is StartProjectConversationRequest {
  if (!isRecord(value)) return false;
  return (
    value.mode === 'create' &&
    typeof value.content === 'string' &&
    Array.isArray(value.attachments) &&
    (Boolean(value.content.trim()) || value.attachments.length > 0) &&
    permissionModeField(value.permissionMode) !== undefined &&
    (value.collaborationMode === 'default' || value.collaborationMode === 'plan') &&
    serviceTierOverrideField(value.serviceTier) &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.effort === undefined || typeof value.effort === 'string') &&
    (value.goalObjective === undefined || (typeof value.goalObjective === 'string' && Boolean(value.goalObjective.trim()) && [...value.goalObjective].length <= 4_000)) &&
    typeof value.idempotencyKey === 'string' &&
    Boolean(value.idempotencyKey) &&
    typeof value.clientUserMessageId === 'string' &&
    Boolean(value.clientUserMessageId)
  );
}

function projectRequestMatchesPayload(request: StartProjectConversationRequest, payload: Omit<StartProjectConversationRequest, 'idempotencyKey' | 'clientUserMessageId'>): boolean {
  const requestPayload: Record<string, unknown> = { ...request };
  delete requestPayload.idempotencyKey;
  delete requestPayload.clientUserMessageId;
  return JSON.stringify(requestPayload) === JSON.stringify(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function nullableStringField(value: unknown): string | null {
  return value === null ? null : stringField(value);
}

function nativeAgentAndModelIdentity(conversation: Record<string, unknown>): Pick<NativeConversationChoice, 'agent' | 'model'> {
  const agent = isRecord(conversation.agent) ? conversation.agent : {};
  const model = isRecord(conversation.model) ? conversation.model : {};
  const agentKind = agent.kind === 'codex' || agent.kind === 'pi' || agent.kind === 'claude' ? agent.kind : null;
  const agentTransport = agent.transport === 'app_server' || agent.transport === 'rpc' || agent.transport === 'sdk' ? agent.transport : null;
  const supportStatus = agent.supportStatus === 'framework_only' || agent.supportStatus === 'experimental' || agent.supportStatus === 'verified' ? agent.supportStatus : 'unavailable';
  return {
    agent: {
      kind: agentKind,
      transport: agentTransport,
      supportStatus,
      capabilitySnapshotId: nullableStringField(agent.capabilitySnapshotId),
    },
    model: {
      sourceId: nullableStringField(model.sourceId),
      id: nullableStringField(model.id),
    },
  };
}

function permissionModeField(value: unknown): NativePermissionMode | undefined {
  return value === 'read-only' || value === 'auto' || value === 'full-access' ? value : undefined;
}

function conversationAttentionKindField(value: unknown): NativeConversationAttentionKind {
  return value === 'unread' || value === 'completed' || value === 'failed' || value === 'interrupted' ? value : 'none';
}

function conversationStageField(value: unknown): NativeConversationStage | undefined {
  return value === 'created' ||
    value === 'connecting' ||
    value === 'queued' ||
    value === 'running' ||
    value === 'waiting_user' ||
    value === 'waiting_approval' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'paused' ||
    value === 'ready' ||
    value === 'archived'
    ? value
    : undefined;
}

/**
 * 把尚未获得 durable acceptance 的 start envelope 先写入 localStorage。
 * 同一输入即使刷新页面也复用相同 IDs；输入变化才替换 envelope，避免 unknown-outcome 重试创建重复 thread。
 */
export function createNativeConversationStartEnvelopeManager(options: {
  storage?: NativeConversationStartStorage;
  createId: () => string;
  releaseRequest?: (task: Pick<SessionWorkspaceTask, 'id' | 'projectId'>, request: StartNativeConversationRequest) => void;
}): NativeConversationStartEnvelopeManager {
  return {
    prepare(input) {
      if (!options.storage) throw new Error('Native conversation start requires durable local storage.');
      const payload = buildStartNativeConversationPayload(input);
      const fingerprint = startNativeConversationFingerprint(input, payload);
      const storageKey = startNativeConversationStorageKey(input.task);
      const persisted = readPersistedNativeConversationStartEnvelope(options.storage, storageKey);
      if (persisted && persisted.fingerprint === fingerprint && requestMatchesPayload(persisted.request, payload)) return persisted.request;

      const request = { ...payload, idempotencyKey: options.createId(), clientUserMessageId: options.createId() } as StartNativeConversationRequest;
      const envelope: PersistedNativeConversationStartEnvelope = { version: 1, fingerprint, request };
      try {
        options.storage.setItem(storageKey, JSON.stringify(envelope));
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'ZEUS_NATIVE_CONVERSATION_START_PERSIST_FAILED' });
      }
      return request;
    },
    clearAccepted(input, request, acceptance, operationIdentity) {
      if (!options.storage || !isDurableNativeConversationAcceptance(request, acceptance, operationIdentity)) return false;
      const payload = buildStartNativeConversationPayload(input);
      const fingerprint = startNativeConversationFingerprint(input, payload);
      const storageKey = startNativeConversationStorageKey(input.task);
      const persisted = readPersistedNativeConversationStartEnvelope(options.storage, storageKey);
      if (!persisted || persisted.fingerprint !== fingerprint || persisted.request.idempotencyKey !== request.idempotencyKey || persisted.request.clientUserMessageId !== request.clientUserMessageId) return false;
      try {
        options.storage.removeItem(storageKey);
        options.releaseRequest?.(input.task, request);
        return true;
      } catch {
        // 接受结果已经 durable；保留旧 envelope 只会安全地复用同一 idempotency key。
        return false;
      }
    },
    pending(task) {
      if (!options.storage) return null;
      return readPersistedNativeConversationStartEnvelope(options.storage, startNativeConversationStorageKey(task))?.request ?? null;
    },
    clearPending(task, request, acceptance, operationIdentity) {
      if (!options.storage || !isDurableNativeConversationAcceptance(request, acceptance, operationIdentity)) return false;
      const storageKey = startNativeConversationStorageKey(task);
      const persisted = readPersistedNativeConversationStartEnvelope(options.storage, storageKey);
      if (!persisted || persisted.request.idempotencyKey !== request.idempotencyKey || persisted.request.clientUserMessageId !== request.clientUserMessageId) return false;
      try {
        options.storage.removeItem(storageKey);
        options.releaseRequest?.(task, request);
        return true;
      } catch {
        return false;
      }
    },
    discardPending(task, request) {
      if (!options.storage) return false;
      const storageKey = startNativeConversationStorageKey(task);
      const persisted = readPersistedNativeConversationStartEnvelope(options.storage, storageKey);
      if (!persisted || persisted.request.idempotencyKey !== request.idempotencyKey || persisted.request.clientUserMessageId !== request.clientUserMessageId) return false;
      try {
        options.storage.removeItem(storageKey);
        options.releaseRequest?.(task, request);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function buildStartNativeConversationPayload(input: SessionWorkspaceStartInput): StartNativeConversationPayload {
  const content = input.content.trim();
  if (input.mode === 'create') {
    if (!content && !input.attachments?.length) throw new Error('Native conversation start content or attachments are required.');
    if (input.source === 'code_review' && (!input.inheritConversationId || !input.model)) {
      throw new Error('Code review requires an inherited conversation and an explicit model.');
    }
    return {
      mode: 'create',
      ...(input.source ? { source: input.source } : {}),
      content,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.inheritConversationId ? { inheritConversationId: input.inheritConversationId } : {}),
      permissionMode: input.permissionMode ?? 'auto',
      collaborationMode: input.collaborationMode ?? 'default',
      ...serviceTierWireOverride(input.serviceTierSelection),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.agentKind ? { agentKind: input.agentKind } : {}),
      ...(input.goalObjective ? { goalObjective: input.goalObjective } : {}),
    };
  }
  if (!content) throw new Error('Native conversation resume/reference content is required.');
  if (!input.conversation) throw new Error('An explicit conversation choice is required.');
  if (input.mode === 'resume') {
    if (input.conversation.transportKind !== 'codex_native' || !input.conversation.resumable) throw new Error('The selected conversation is not resumable.');
    return {
      mode: 'resume',
      conversationId: input.conversation.id,
      content,
      collaborationMode: input.collaborationMode ?? input.conversation.collaborationMode ?? 'default',
    };
  }
  const messageIds = [...new Set(input.legacyMessageIds ?? [])];
  if (messageIds.length === 0) throw new Error('Explicit legacy message ids are required.');
  return {
    mode: 'reference_legacy',
    sourceConversationId: input.conversation.legacySourceConversationId ?? input.conversation.id,
    messageIds,
    content,
    permissionMode: input.permissionMode ?? 'auto',
    collaborationMode: input.collaborationMode ?? 'default',
  };
}

function startNativeConversationFingerprint(input: SessionWorkspaceStartInput, payload: StartNativeConversationPayload): string {
  return JSON.stringify({ projectId: input.task.projectId, taskId: input.task.id, payload });
}

function startNativeConversationStorageKey(task: Pick<SessionWorkspaceTask, 'id' | 'projectId'>): string {
  return `zeus.native-conversation-start:v1:${encodeURIComponent(task.projectId)}:${encodeURIComponent(task.id)}`;
}

function readPersistedNativeConversationStartEnvelope(storage: NativeConversationStartStorage, storageKey: string): PersistedNativeConversationStartEnvelope | null {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedNativeConversationStartEnvelope>;
    if (parsed.version !== 1 || typeof parsed.fingerprint !== 'string' || !isStartNativeConversationRequest(parsed.request)) return null;
    return parsed as PersistedNativeConversationStartEnvelope;
  } catch {
    return null;
  }
}

function isStartNativeConversationRequest(value: unknown): value is StartNativeConversationRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Partial<StartNativeConversationRequest>;
  if (typeof request.idempotencyKey !== 'string' || !request.idempotencyKey || typeof request.clientUserMessageId !== 'string' || !request.clientUserMessageId || typeof request.content !== 'string') return false;
  if (request.mode === 'create') {
    return (
      (Boolean(request.content.trim()) || (Array.isArray(request.attachments) && request.attachments.length > 0)) &&
      (request.source === undefined || request.source === 'code_review') &&
      (request.inheritConversationId === undefined || (typeof request.inheritConversationId === 'string' && Boolean(request.inheritConversationId))) &&
      (request.source !== 'code_review' ||
        (typeof request.inheritConversationId === 'string' &&
          Boolean(request.inheritConversationId) &&
          typeof request.model === 'string' &&
          Boolean(request.model) &&
          (request.effort === undefined || typeof request.effort === 'string') &&
          (request.agentKind === 'codex' || request.agentKind === 'pi'))) &&
      permissionModeField(request.permissionMode) !== undefined &&
      (request.collaborationMode === 'default' || request.collaborationMode === 'plan') &&
      serviceTierOverrideField(request.serviceTier) &&
      (request.goalObjective === undefined || (typeof request.goalObjective === 'string' && Boolean(request.goalObjective.trim()) && [...request.goalObjective].length <= 4_000))
    );
  }
  if (!request.content.trim()) return false;
  if (request.mode === 'resume') return typeof request.conversationId === 'string' && Boolean(request.conversationId) && (request.collaborationMode === 'default' || request.collaborationMode === 'plan');
  return (
    request.mode === 'reference_legacy' &&
    typeof request.sourceConversationId === 'string' &&
    Boolean(request.sourceConversationId) &&
    Array.isArray(request.messageIds) &&
    request.messageIds.length > 0 &&
    request.messageIds.every((messageId) => typeof messageId === 'string' && Boolean(messageId)) &&
    permissionModeField(request.permissionMode) !== undefined &&
    (request.collaborationMode === 'default' || request.collaborationMode === 'plan')
  );
}

function serviceTierOverrideField(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && Boolean(value.trim()));
}

function requestMatchesPayload(request: StartNativeConversationRequest, payload: StartNativeConversationPayload): boolean {
  const requestPayload: Record<string, unknown> = { ...request };
  delete requestPayload.idempotencyKey;
  delete requestPayload.clientUserMessageId;
  return JSON.stringify(requestPayload) === JSON.stringify(payload);
}

export function isDurableNativeConversationAcceptance(
  request: Pick<StartNativeConversationRequest | StartProjectConversationRequest, 'idempotencyKey'>,
  acceptance: NativeOperationAcceptance,
  operationIdentity = request.idempotencyKey,
): boolean {
  return (
    acceptance.operation.status === 'accepted' &&
    typeof acceptance.operation.id === 'string' &&
    acceptance.operation.id.length > 0 &&
    typeof request.idempotencyKey === 'string' &&
    request.idempotencyKey.length > 0 &&
    acceptance.operation.idempotencyKey === operationIdentity &&
    typeof acceptance.conversation.id === 'string' &&
    acceptance.conversation.id.length > 0
  );
}

export interface SessionWorkspaceProps {
  language: SessionUiLanguage;
  state: NativeSessionState | null;
  /** 真实会话用 selector 子组件订阅；本地创建态继续直接使用 state。 */
  stateController?: SessionController;
  conversation: NativeConversationChoice | null;
  task: SessionWorkspaceTask | null;
  owner?: SessionConversationOwner;
  tasks?: SessionWorkspaceTask[];
  projects?: readonly Pick<ProjectRecord, 'id' | 'name' | 'localPath'>[];
  choices?: NativeConversationChoice[];
  suppressComposer?: boolean;
  /** 历史快照阶段：只读正文和过程，不恢复旧队列；用户首次发送后原地进入活动态。 */
  historyOnly?: boolean;
  /** 历史入口的稳定身份；续聊后仍用于补齐旧轮次的持久化计划。 */
  projectPersistedPlans?: boolean;
  quickActionsSuppressed?: boolean;
  taskManagementStatusChangeBusy?: boolean;
  readOnlyGate?: SessionReadOnlyGate;
  capabilities?: CodexConversationCapabilities | null;
  /** 权威子线程预读结果；实时连接失败时仍允许只读打开智能体。 */
  subagentListSnapshot?: NativeSubagentListSnapshot | null;
  /** 目标正文尚未水合时，在输入区上方显示轻量状态。 */
  transcriptLoading?: boolean;
  choicesKnown?: boolean;
  legacyMessages?: Record<string, Array<{ id: string; role: string; content: string }>>;
  loadState?: 'empty' | 'loading' | 'error';
  loadError?: string | null;
  autoFocusNewConversation?: boolean;
  onLatestContentVisibilityChange?: (visible: boolean) => void;
  creationStatus?: SessionCreationStatus;
  actions?: SessionWorkspaceActions;
}

export interface SessionReadOnlyGate {
  title: string;
  description: string;
  actionLabel: string;
  busy?: boolean;
  error?: string | null;
  onAction: () => void | Promise<void>;
}

type SessionStateSelectorFactory = () => (state: NativeSessionState) => NativeSessionState;

function useOptionalSessionStateSlice(controller: SessionController | undefined, fallbackState: NativeSessionState, selectorFactory: SessionStateSelectorFactory): NativeSessionState {
  const selector = useMemo(selectorFactory, [controller, selectorFactory]);
  const fallbackRef = useRef(fallbackState);
  fallbackRef.current = fallbackState;
  const cache = useMemo<{ source: NativeSessionState | null; selection: NativeSessionState | null }>(() => ({ source: null, selection: null }), [controller, selector]);
  const subscribe = useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => undefined), [controller]);
  const getSnapshot = useCallback(() => {
    const source = controller?.getState() ?? fallbackRef.current;
    if (cache.source !== source || cache.selection === null) {
      cache.source = source;
      cache.selection = selector(source);
    }
    return cache.selection;
  }, [cache, controller, selector]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function SessionTranscriptProjection(props: Omit<ConversationTranscriptProps, 'state'> & { state: NativeSessionState; controller?: SessionController }) {
  const { controller, state: fallbackState, ...transcriptProps } = props;
  const state = useOptionalSessionStateSlice(controller, fallbackState, createConversationTranscriptStateSelector);
  return <ConversationTranscript {...transcriptProps} state={state} />;
}

function SessionComposerProjection(props: Omit<ConversationComposerProps, 'state'> & { state: NativeSessionState; controller?: SessionController }) {
  const { controller, state: fallbackState, ...composerProps } = props;
  const state = useOptionalSessionStateSlice(controller, fallbackState, createConversationComposerStateSelector);
  return <ConversationComposer {...composerProps} state={state} />;
}

const labels = {
  'zh-CN': {
    workspace: '会话工作区',
    loading: '正在加载会话',
    refreshing: '正在刷新会话',
    reconnecting: '正在重新连接',
    reconnectingAttempt: (attempt: number) => `正在重新连接 · 第 ${Math.max(1, attempt)} 次`,
    failed: '连接失败',
    failureHelp: '连接中断。请重新连接以读取最新快照。',
    loadFailureHelp: '会话读取未完成。请重新加载，当前草稿会继续保留。',
    refreshFailureHelp: '后台刷新失败，当前仍显示上次成功读取的内容。',
    serverBusy: '服务繁忙',
    serverBusyHelp: '服务暂时繁忙。请稍候片刻，然后重新连接。',
    details: '详情',
    retry: '重新连接',
    reload: '重新加载',
    ready: '已就绪',
    queued: '待发送',
    starting: '正在开始',
    working: '正在处理',
    answering: '正在回答',
    approval: '需要审批',
    input: '需要回答',
    interruptConfirm: '再次按 Escape 停止',
    interrupting: '正在停止',
    turnFailed: '本轮失败',
    newConversation: '新建会话',
    newInput: '发送消息',
    newPlaceholder: '输入消息，Enter 发送，Shift+Enter 换行',
    send: '发送',
    createGoal: '创建目标',
    goalInput: '目标内容',
    goalPlaceholder: '说明要达成什么、如何验证，以及何时停止',
    exitGoal: '退出目标输入',
    normalDraftPreserved: '普通消息草稿已保留',
    attach: '添加附件',
    removeAttachment: '移除附件',
    runtimeDetails: '运行时详情',
    model: '模型',
    cacheHitRate: '缓存 Token 命中率',
    contextUsage: '上下文占用',
    priceCoverage: '费用覆盖率',
    priceCatalogDate: '价格目录日期',
    priceSource: '价格来源',
    cwd: '当前目录',
    branch: '当前分支',
    sessionId: '会话 ID',
    jsonlPath: 'JSONL 文件',
    nonGitDirectory: '非 Git 目录',
    unavailable: '不可用',
    mcpStartup: 'MCP 启动状态',
    legacyTranscript: '只读旧会话记录',
    unsynced: '未同步',
    exactValue: '精确值',
  },
  'en-US': {
    workspace: 'Conversation workspace',
    loading: 'Loading conversation',
    refreshing: 'Refreshing conversation',
    reconnecting: 'Reconnecting',
    reconnectingAttempt: (attempt: number) => `Reconnecting · attempt ${Math.max(1, attempt)}`,
    failed: 'Connection failed',
    failureHelp: 'The connection was interrupted. Reconnect to load the latest snapshot.',
    loadFailureHelp: 'The conversation did not finish loading. Reload it; the current draft remains saved.',
    refreshFailureHelp: 'Background refresh failed. The last successfully loaded content remains visible.',
    serverBusy: 'Server busy',
    serverBusyHelp: 'The server is temporarily busy. Wait briefly, then reconnect.',
    details: 'Details',
    retry: 'Reconnect',
    reload: 'Reload',
    ready: 'Ready',
    queued: 'Queued',
    starting: 'Starting',
    working: 'Working',
    answering: 'Answering',
    approval: 'Approval required',
    input: 'Input required',
    interruptConfirm: 'Press Escape again to stop',
    interrupting: 'Stopping',
    turnFailed: 'Turn failed',
    newConversation: 'New conversation',
    newInput: 'Send a message',
    newPlaceholder: 'Type a message. Enter to send, Shift+Enter for a newline.',
    send: 'Send',
    createGoal: 'Create goal',
    goalInput: 'Goal objective',
    goalPlaceholder: 'Describe the outcome, validation, and stopping condition',
    exitGoal: 'Exit goal input',
    normalDraftPreserved: 'Message draft preserved',
    attach: 'Add attachment',
    removeAttachment: 'Remove attachment',
    runtimeDetails: 'Runtime details',
    model: 'Model',
    cacheHitRate: 'Cached-token hit rate',
    contextUsage: 'Context usage',
    priceCoverage: 'Price coverage',
    priceCatalogDate: 'Price catalog date',
    priceSource: 'Price source',
    cwd: 'Current directory',
    branch: 'Current branch',
    sessionId: 'Session ID',
    jsonlPath: 'JSONL file',
    nonGitDirectory: 'Not a Git directory',
    unavailable: 'Unavailable',
    mcpStartup: 'MCP startup',
    legacyTranscript: 'Read-only legacy transcript',
    unsynced: 'Not synced',
    exactValue: 'exact value',
  },
} as const;

type SessionContextWorkspace =
  | { kind: 'none' }
  | { kind: 'browser' }
  | { kind: 'subagents' }
  | { kind: 'plan'; itemKey: string }
  | { kind: 'source'; preview: ConversationResourcePreview }
  | { kind: 'turn_diff'; turnId: string; initialFileId?: string }
  | { kind: 'side_chat'; selectedText: string };

export interface SessionHeaderSnapshot {
  conversationId: string;
  title: string;
  contextLabel: string | null;
  taskId: string | null;
  taskManagementStatus: SessionWorkspaceTask['managementStatus'] | null;
  taskManagementStatusOptions: SessionWorkspaceTask['managementStatusOptions'];
}

export function createSessionHeaderSnapshot(conversation: NativeConversationChoice | null, task: SessionWorkspaceTask | null, owner?: SessionConversationOwner): SessionHeaderSnapshot | null {
  if (!conversation) return null;
  const taskId = task?.id ?? (owner?.kind === 'task' ? owner.taskId : null);
  const taskTitle = task?.title ?? (owner?.kind === 'task' ? owner.taskTitle : null);
  return {
    conversationId: conversation.id,
    title: conversationDisplayTitle(conversation.title, taskTitle),
    contextLabel: taskId ? null : ((owner?.kind === 'project' ? owner.projectName : null) ?? conversation.summary ?? conversation.projectId),
    taskId,
    taskManagementStatus: task?.managementStatus ?? null,
    taskManagementStatusOptions: task?.managementStatusOptions,
  };
}

export function SessionWorkspace(props: SessionWorkspaceProps) {
  const copy = labels[props.language];
  const actions = props.actions ?? {};
  const owner: SessionConversationOwner | undefined = props.owner ?? (props.task ? { kind: 'task', projectId: props.task.projectId, projectName: props.task.projectId, taskId: props.task.id, taskTitle: props.task.title } : undefined);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const workspaceIdentityRef = useRef(props.conversation?.id ?? null);
  workspaceIdentityRef.current = props.conversation?.id ?? null;
  const responseGuard = useRef(createRequestResponseGuard()).current;
  const escapeController = useRef(createSessionEscapeController()).current;
  const interruptResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextReturnFocusRef = useRef<HTMLElement | null>(null);
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [interruptArmed, setInterruptArmed] = useState(false);
  const [contextWorkspace, setContextWorkspace] = useState<SessionContextWorkspace>({ kind: 'none' });
  const contextWorkspaceRef = useRef<SessionContextWorkspace>(contextWorkspace);
  contextWorkspaceRef.current = contextWorkspace;
  const [contextMounted, setContextMounted] = useState(false);
  const [quickActionsPersistentHost, setQuickActionsPersistentHost] = useState<HTMLDivElement | null>(null);
  const [contextFullWidth, setContextFullWidth] = useState(false);
  const [browserPaneShare, setBrowserPaneShare] = useState(56);
  const [browserResizing, setBrowserResizing] = useState(false);
  const [browserLayoutWidth, setBrowserLayoutWidth] = useState(0);
  const [goalPanelOpen, setGoalPanelOpen] = useState(false);
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const browserSplitRef = useRef<HTMLDivElement | null>(null);
  const browserResizeActiveRef = useRef(false);
  const browserMotionStopRef = useRef<(() => void) | null>(null);
  const browserVisibilityProgress = useMotionValue(0);
  const browserTargetWidth = useMotionValue(0);
  const browserAnimatedWidth = useTransform<number, number>([browserVisibilityProgress, browserTargetWidth], ([progress, targetWidth]) => Math.max(0, Math.min(1, progress)) * targetWidth);
  const contextOpen = contextWorkspace.kind !== 'none';
  const browserOpen = contextWorkspace.kind === 'browser';
  const planWorkspaceItemKey = contextWorkspace.kind === 'plan' ? contextWorkspace.itemKey : null;
  const sessionReady = props.state != null;
  const resolvedBrowserTargetWidth = resolveBrowserTargetWidth(browserLayoutWidth, browserPaneShare, contextFullWidth);
  const currentHeader = useMemo(() => createSessionHeaderSnapshot(props.conversation, props.task, owner), [owner, props.conversation, props.task]);
  const displayedHeader = currentHeader;
  // 本地缓存只支撑会话重挂载的首帧；没有待确认用户修改时，后续以服务端快照为权威。
  const [composerRuntimeSettings, setComposerRuntimeSettings] = useState<ComposerRuntimeSettings | null>(() =>
    readConversationNextTurnSettings(browserConversationStorage(), props.conversation?.projectId ?? '', props.conversation?.id ?? ''),
  );
  const composerRuntimeSettingsDirtyRef = useRef(false);
  const lastNextTurnSettingsSyncRef = useRef<string | null>(null);
  const previousBlockingInteractionCountRef = useRef(0);
  const composerFocusRestorationPendingRef = useRef(false);
  const legacy = props.conversation && props.conversation.transportKind !== 'codex_native';
  const interactionReadOnly = Boolean(props.historyOnly) || Boolean(props.readOnlyGate) || Boolean(props.conversation?.readOnly && props.conversation.transportKind === 'codex_native');
  const transcriptInteractionsEnabled = !interactionReadOnly;
  // 历史分页、过程与截断正文都是本地只读查询。会话只读时仍必须允许查看。
  const transcriptReadActionsEnabled = true;
  const effectiveProviderState = props.state?.snapshot?.providerState ?? props.conversation?.providerState ?? null;
  const realtimeExpected = sessionStateNeedsRealtime(props.state);
  // 空闲历史会话只读本地快照，不存在“连接失败”；只有真实轮次、排队或待处理请求需要实时连接时才报告连接错误。
  const transportError = realtimeExpected && props.state?.transportState === 'failed' && props.state.error?.retryable === false ? (props.state.error ?? props.loadError ?? copy.failed) : null;
  useApplicationErrorDialog(props.historyOnly ? null : props.readOnlyGate?.error, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
  });
  useApplicationErrorDialog(!props.historyOnly && props.loadState === 'error' ? (props.loadError ?? copy.failed) : null, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
  });
  useApplicationErrorDialog(props.historyOnly ? null : transportError, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
  });
  const effectiveResumable = props.state?.snapshot ? !['closed', 'failed'].includes(effectiveProviderState ?? '') : effectiveProviderState === 'archived' ? true : props.conversation?.resumable;
  const nonResumableNative = Boolean(props.conversation && !legacy && !effectiveResumable);
  const pendingRequests = props.historyOnly ? [] : (props.state?.pendingRequests.filter((request) => request.status === 'pending' && hasPendingRequestDetails(request)) ?? []);
  const pendingPlanImplementationRequests = props.historyOnly ? [] : (props.state?.planImplementationRequests.filter((request) => request.status === 'pending').slice(-1) ?? []);
  const blockingPendingRequest = pendingRequests[0] ?? null;
  const blockingPlanImplementationRequest = blockingPendingRequest ? null : (pendingPlanImplementationRequests[0] ?? null);
  const blockingInteractionCount = pendingRequests.length + pendingPlanImplementationRequests.length;
  // 计划工作区绑定渲染层稳定 key，避免本地记录 ID 在实时事件合并后消失，导致右侧只打开空壳。
  const planWorkspaceItemCandidate = planWorkspaceItemKey ? props.state?.items[planWorkspaceItemKey] : null;
  const planWorkspaceItem = planWorkspaceItemCandidate?.type === 'plan' ? planWorkspaceItemCandidate : null;
  const turnDiffChangeSet = contextWorkspace.kind === 'turn_diff' ? (props.state?.changeSetsByProviderId[contextWorkspace.turnId] ?? null) : null;
  const dockedPlan = props.state ? selectDockedTurnPlan(props.state) : null;
  const goal = props.state?.snapshot?.goal ?? null;
  const capabilityGoals = props.capabilities?.goals;
  const goalCapability =
    props.state?.snapshot?.goalCapability ??
    ({
      ...(capabilityGoals ?? { supported: false, enabled: false, stage: null }),
      reason: capabilityGoals?.supported && capabilityGoals?.enabled ? 'available' : capabilityGoals?.supported ? 'disabled' : 'unverified',
    } as const);
  const selectedComposerModel = resolveModelCapability(props.capabilities?.models, composerRuntimeSettings?.model ?? props.state?.snapshot?.nextTurnSettings?.model ?? props.state?.providerSettings?.model);
  const goalAvailable = !legacy && goalCapability.supported && goalCapability.enabled && (selectedComposerModel?.agentKind ?? props.state?.snapshot?.agent?.kind ?? props.conversation?.agent?.kind) === 'codex';
  const subagentActivity = useMemo(() => projectSubagentActivity(Object.values(props.state?.items ?? {})), [props.state?.items]);
  const subagentThreadIds = useMemo(() => [...new Set([...subagentActivity.threadIds, ...(props.subagentListSnapshot?.items.map((item) => item.id) ?? [])])].sort(), [props.subagentListSnapshot?.items, subagentActivity.threadIds]);
  const subagentSnapshotRevision = props.subagentListSnapshot?.items.map((item) => `${item.id}:${item.status}:${item.updatedAt ?? ''}`).join('|') ?? '';
  const subagentSignature = subagentThreadIds.join(',');
  const autoOpenedSubagentSignatureRef = useRef('');

  useLayoutEffect(() => {
    contextReturnFocusRef.current = null;
    setComposerRuntimeSettings(readConversationNextTurnSettings(browserConversationStorage(), props.conversation?.projectId ?? '', props.conversation?.id ?? ''));
    composerRuntimeSettingsDirtyRef.current = false;
    lastNextTurnSettingsSyncRef.current = null;
    setRequestErrors({});
    setInterruptArmed(false);
    escapeController.reset();
    clearInterruptResetTimer(interruptResetTimerRef);
    previousBlockingInteractionCountRef.current = 0;
    composerFocusRestorationPendingRef.current = false;
    setContextWorkspace({ kind: 'none' });
    setContextFullWidth(false);
    setGoalPanelOpen(false);
    setGoalBusy(false);
    setGoalError(null);
    autoOpenedSubagentSignatureRef.current = '';
    browserMotionStopRef.current?.();
    browserMotionStopRef.current = null;
    browserVisibilityProgress.set(0);
    setContextMounted(false);
    setBrowserResizing(false);
    browserResizeActiveRef.current = false;
  }, [browserVisibilityProgress, escapeController, props.conversation?.id]);

  useEffect(() => {
    if (!subagentSignature || subagentSignature === autoOpenedSubagentSignatureRef.current) return;
    autoOpenedSubagentSignatureRef.current = subagentSignature;
    if (contextWorkspace.kind !== 'none' || !actions.onLoadSubagents || !actions.onLoadSubagentThread) return;
    setContextFullWidth(false);
    setContextWorkspace({ kind: 'subagents' });
  }, [actions.onLoadSubagentThread, actions.onLoadSubagents, contextWorkspace.kind, subagentSignature]);

  useEffect(() => {
    if (!props.state || legacy || composerRuntimeSettingsDirtyRef.current) return;
    const snapshotSettings = composerRuntimeSettingsFromState(props.state, props.capabilities, props.conversation);
    const projectId = props.state.projectId ?? props.conversation?.projectId;
    const conversationId = props.state.conversationId ?? props.conversation?.id;
    if (!snapshotSettings || !projectId || !conversationId) return;
    if (JSON.stringify(snapshotSettings) === JSON.stringify(composerRuntimeSettings)) return;
    writeConversationNextTurnSettings(browserConversationStorage(), projectId, conversationId, snapshotSettings);
    setComposerRuntimeSettings(snapshotSettings);
  }, [composerRuntimeSettings, legacy, props.capabilities, props.conversation?.collaborationMode, props.conversation?.permissionMode, props.state]);

  useEffect(() => {
    if (!props.state || legacy || interactionReadOnly || !composerRuntimeSettings || !composerRuntimeSettingsDirtyRef.current || !actions.onNextTurnSettingsChange) return;
    const conversationId = props.conversation?.id ?? null;
    const signature = JSON.stringify(composerRuntimeSettings);
    if (lastNextTurnSettingsSyncRef.current === signature) return;
    lastNextTurnSettingsSyncRef.current = signature;
    void Promise.resolve(actions.onNextTurnSettingsChange(composerRuntimeSettings))
      .then(() => {
        if (workspaceIdentityRef.current !== conversationId) return;
        if (lastNextTurnSettingsSyncRef.current !== signature) return;
        composerRuntimeSettingsDirtyRef.current = false;
        // 触发一次权威快照对账，接收服务端可能做出的规范化结果。
        setComposerRuntimeSettings((current) => (current ? { ...current } : current));
      })
      .catch(() => {
        if (workspaceIdentityRef.current !== conversationId) return;
        if (lastNextTurnSettingsSyncRef.current === signature) lastNextTurnSettingsSyncRef.current = null;
      });
  }, [actions, composerRuntimeSettings, interactionReadOnly, legacy, props.conversation?.id, props.state?.transportState]);

  function updateComposerRuntimeSettings(settings: ComposerRuntimeSettings): void {
    const projectId = props.state?.projectId ?? props.conversation?.projectId;
    const conversationId = props.state?.conversationId ?? props.conversation?.id;
    if (!props.state || !projectId || !conversationId || legacy || interactionReadOnly) return;
    composerRuntimeSettingsDirtyRef.current = true;
    writeConversationNextTurnSettings(browserConversationStorage(), projectId, conversationId, settings);
    const capability = props.capabilities?.models.find((candidate) => candidate.model === settings.model || candidate.id === settings.model);
    const preferenceKind = conversationRuntimePreferenceKind(owner, props.conversation?.title);
    const currentPreference = readConversationRuntimePreferences(browserConversationStorage(), projectId, preferenceKind);
    writeConversationRuntimePreferences(browserConversationStorage(), projectId, preferenceKind, {
      model: settings.model,
      ...(settings.effort ? { effort: settings.effort } : {}),
      serviceTier: selectionFromEffectiveServiceTier(settings.serviceTier, capability),
      permissionMode: settings.permissionMode,
      collaborationMode: settings.collaborationMode,
      ...(currentPreference?.workspaceMode ? { workspaceMode: currentPreference.workspaceMode } : {}),
    });
    lastNextTurnSettingsSyncRef.current = null;
    setComposerRuntimeSettings(settings);
  }

  useLayoutEffect(() => {
    const split = browserSplitRef.current;
    if (!split) return;
    const updateWidth = (): void => {
      const width = split.getBoundingClientRect().width;
      setBrowserLayoutWidth((current) => (Math.abs(current - width) < 0.5 ? current : width));
    };
    const observer = new ResizeObserver(updateWidth);
    observer.observe(split);
    updateWidth();
    return () => observer.disconnect();
  }, [props.conversation?.id, sessionReady]);

  useLayoutEffect(() => {
    browserTargetWidth.set(resolvedBrowserTargetWidth);
  }, [browserTargetWidth, resolvedBrowserTargetWidth]);

  useEffect(() => {
    browserMotionStopRef.current?.();
    browserMotionStopRef.current = null;
    const target = contextOpen ? 1 : 0;
    if (sessionPrefersReducedMotion()) {
      browserVisibilityProgress.set(target);
      setContextMounted(contextOpen);
      return;
    }
    if (!contextOpen && browserVisibilityProgress.get() <= 0) {
      setContextMounted(false);
      return;
    }
    let cancelled = false;
    let frame = 0;
    if (contextOpen) setContextMounted(true);
    const start = (): void => {
      const controls = animateMotion(browserVisibilityProgress, target, {
        type: 'spring',
        duration: 0.5,
        bounce: 0.1,
        onComplete: () => {
          if (!cancelled && target === 0) setContextMounted(false);
        },
      });
      browserMotionStopRef.current = () => controls.stop();
    };
    if (contextOpen) frame = requestAnimationFrame(start);
    else start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      browserMotionStopRef.current?.();
      browserMotionStopRef.current = null;
    };
  }, [browserVisibilityProgress, contextOpen]);

  useEffect(() => {
    const bridge = window.zeus;
    if (!bridge?.onBrowserEvent || !props.conversation) return;
    return bridge.onBrowserEvent((event) => {
      if (event.type === 'open_requested' && event.conversationId === (props.state?.conversationId ?? props.conversation?.id)) {
        setContextFullWidth(false);
        setContextWorkspace({ kind: 'browser' });
      }
    });
  }, [props.conversation, props.state?.conversationId]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'b' || legacy) return;
      event.preventDefault();
      contextReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setContextFullWidth(false);
      setContextWorkspace((current) => (current.kind === 'browser' ? { kind: 'none' } : { kind: 'browser' }));
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [legacy]);

  useEffect(() => {
    if (contextWorkspace.kind === 'none') {
      window.zeus?.notifySessionContextActivity?.({ active: false, kind: 'none' });
    }
  }, [contextWorkspace.kind]);

  useEffect(() => {
    const bridge = window.zeus;
    if (!bridge?.onNativeCloseActiveContextTab) return;
    return bridge.onNativeCloseActiveContextTab(() => {
      const current = contextWorkspaceRef.current;
      if (current.kind === 'none' || current.kind === 'browser') return;
      closeContextWorkspace();
    });
  }, [props.conversation?.id]);

  useEffect(
    () => () => {
      window.zeus?.notifySessionContextActivity?.({ active: false, kind: 'none' });
    },
    [],
  );

  useEffect(() => {
    const previous = previousBlockingInteractionCountRef.current;
    previousBlockingInteractionCountRef.current = blockingInteractionCount;
    const resolution = resolveComposerFocusRestoration({
      previousPendingCount: previous,
      pendingCount: blockingInteractionCount,
      restorationPending: composerFocusRestorationPendingRef.current,
      state: props.state,
      readOnly: nonResumableNative,
    });
    composerFocusRestorationPendingRef.current = resolution.restorationPending;
    if (!resolution.shouldFocus) return;
    composerRef.current?.focus();
  }, [blockingInteractionCount, nonResumableNative, props.state]);

  useEffect(() => {
    setInterruptArmed(false);
    escapeController.reset();
    clearInterruptResetTimer(interruptResetTimerRef);
  }, [escapeController, props.state?.activeTurnId]);

  useEffect(
    () => () => {
      clearInterruptResetTimer(interruptResetTimerRef);
    },
    [],
  );

  function handleWorkspaceKeyDownCapture(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape') return;
    if (event.target instanceof Element && event.target.closest('.session-composer-shell[data-goal-input="true"]')) return;
    const planRequest = pendingRequests.length === 0 ? pendingPlanImplementationRequests[0] : undefined;
    if (planRequest) {
      event.preventDefault();
      event.stopPropagation();
      void respondToPlanImplementationRequest(planRequest, { action: 'dismiss' });
      return;
    }
    if (contextOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeContextWorkspace();
      return;
    }
    const userInputRequest = pendingRequests.find((request) => requestKind(request) === 'request_user_input');
    if (userInputRequest) {
      if (event.target instanceof Element && event.target.closest('.session-rui-request')) return;
      event.preventDefault();
      event.stopPropagation();
      void respond(userInputRequest, { type: 'userInput', answers: {} });
      return;
    }
    const state = props.state;
    const active = state?.conversationState === 'active_prework' || state?.conversationState === 'active_final_answer';
    const result = resolveSessionWorkspaceEscape({
      controller: escapeController,
      eventTarget: event.target,
      composerTextarea: composerRef.current,
      repeat: event.repeat,
      openLayers: pendingRequests.length > 0 ? ['approval'] : [],
      responding: active,
      activeTurnId: state?.activeTurnId ?? null,
      startedTurnId: state?.startedTurnId ?? null,
      now: Date.now(),
    });
    if (!result.consumed) return;
    event.preventDefault();
    event.stopPropagation();
    if (result.action === 'close_approval') {
      const requestId = pendingRequests[0]?.id;
      if (requestId)
        setRequestErrors((current) => ({
          ...current,
          [requestId]: props.language === 'zh-CN' ? '请先明确允许、拒绝或提交回答；Escape 不会停止被请求阻塞的轮次。' : 'Choose allow, decline, or submit an answer. Escape will not interrupt a request-blocked turn.',
        }));
      return;
    }
    if (result.action === 'confirm_interrupt') {
      setInterruptArmed(true);
      clearInterruptResetTimer(interruptResetTimerRef);
      interruptResetTimerRef.current = setTimeout(
        () => {
          escapeController.reset();
          setInterruptArmed(false);
          interruptResetTimerRef.current = null;
        },
        Math.max(0, result.confirmUntil - Date.now()),
      );
      return;
    }
    if (result.action === 'interrupt') {
      clearInterruptResetTimer(interruptResetTimerRef);
      setInterruptArmed(false);
      void actions.onInterrupt?.(result.turnId);
    }
  }

  async function respond(request: NativePendingRequest, response: Record<string, unknown>): Promise<void> {
    if (!actions.onRespondToRequest || !responseGuard.begin(request.id)) return;
    const conversationId = workspaceIdentityRef.current;
    setRequestErrors((current) => {
      const next = { ...current };
      delete next[request.id];
      return next;
    });
    try {
      await actions.onRespondToRequest(request.id, response);
    } catch (error) {
      if (workspaceIdentityRef.current !== conversationId) return;
      setRequestErrors((current) => ({ ...current, [request.id]: formatVisibleApplicationError(error, props.language === 'zh-CN' ? 'zh-CN' : 'en') }));
    } finally {
      responseGuard.finish(request.id);
    }
  }

  function updateBrowserPaneShare(clientX: number): void {
    const split = browserSplitRef.current;
    if (!split) return;
    const rect = split.getBoundingClientRect();
    if (rect.width <= 0) return;
    const minimumBrowser = Math.min(440, rect.width * 0.62);
    const minimumConversation = Math.min(360, rect.width * 0.48);
    const minimumShare = Math.max(38, (minimumBrowser / rect.width) * 100);
    const maximumShare = Math.min(72, ((rect.width - minimumConversation) / rect.width) * 100);
    const rawShare = ((rect.right - clientX) / rect.width) * 100;
    setBrowserPaneShare(Math.round(Math.min(Math.max(rawShare, minimumShare), Math.max(minimumShare, maximumShare))));
  }

  function handleBrowserResizePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (contextFullWidth || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    browserResizeActiveRef.current = true;
    setBrowserResizing(true);
    updateBrowserPaneShare(event.clientX);
  }

  function handleBrowserResizePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!browserResizeActiveRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    updateBrowserPaneShare(event.clientX);
  }

  function finishBrowserResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    browserResizeActiveRef.current = false;
    setBrowserResizing(false);
  }

  function handleBrowserResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (contextFullWidth || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    setBrowserPaneShare((current) => Math.min(72, Math.max(38, current + (event.key === 'ArrowLeft' ? 2 : -2))));
  }

  async function respondToPlanImplementationRequest(
    request: NativePlanImplementationRequest,
    input: {
      action: 'implement' | 'refine' | 'dismiss';
      feedback?: string;
    },
  ): Promise<void> {
    if (!actions.onRespondToPlanImplementationRequest || !responseGuard.begin(request.id)) return;
    const conversationId = workspaceIdentityRef.current;
    setRequestErrors((current) => {
      const next = { ...current };
      delete next[request.id];
      return next;
    });
    try {
      await actions.onRespondToPlanImplementationRequest(request.id, input);
    } catch (error) {
      if (workspaceIdentityRef.current !== conversationId) return;
      setRequestErrors((current) => ({
        ...current,
        [request.id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      responseGuard.finish(request.id);
    }
  }

  async function openConversationResource(resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation): Promise<void> {
    if (!actions.onOpenResource) throw new Error('conversation_resource_open_unavailable');
    const conversationId = workspaceIdentityRef.current;
    contextReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const result = await actions.onOpenResource(resource, target, location);
    if (workspaceIdentityRef.current !== conversationId) return;
    if (!result.opened) throw new Error('conversation_resource_open_failed');
    if (result.mode === 'zeus_source' && result.preview) {
      setContextFullWidth(false);
      setContextWorkspace({ kind: 'source', preview: result.preview });
      return;
    }
    if (result.mode === 'zeus_browser') {
      setContextFullWidth(false);
      setContextWorkspace({ kind: 'browser' });
    }
  }

  async function openTurnChangeFile(changeSet: TurnChangeSet, file: TurnChangeFile, line?: number): Promise<void> {
    if (!actions.onOpenTurnChangeFile) throw new Error('turn_change_file_open_unavailable');
    const conversationId = workspaceIdentityRef.current;
    contextReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const result = await actions.onOpenTurnChangeFile(changeSet, file, line ? 'zeus_source' : 'preferred', line ? { line } : undefined);
    if (workspaceIdentityRef.current !== conversationId) return;
    if (!result.opened) throw new Error('turn_change_file_open_failed');
    if (result.mode === 'zeus_source' && result.preview) {
      setContextFullWidth(false);
      setContextWorkspace({ kind: 'source', preview: result.preview });
      return;
    }
    if (result.mode === 'zeus_browser') {
      setContextFullWidth(false);
      setContextWorkspace({ kind: 'browser' });
    }
  }

  async function operateTurnChangeSet(changeSet: TurnChangeSet, action: 'undo' | 'reapply'): Promise<TurnChangeSetOperationResult> {
    if (!actions.onOperateTurnChangeSet) throw new Error('turn_change_set_operation_unavailable');
    const conversationId = workspaceIdentityRef.current;
    const activeSource = contextWorkspace.kind === 'source' ? contextWorkspace.preview : null;
    let result: TurnChangeSetOperationResult | null = null;
    let operationFailed = false;
    let operationError: unknown;
    try {
      result = await actions.onOperateTurnChangeSet(changeSet, action);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    if (workspaceIdentityRef.current !== conversationId) {
      if (operationFailed) throw operationError;
      if (!result) throw new Error('turn_change_set_operation_missing_result');
      return result;
    }
    if (activeSource?.resource.kind === 'file') {
      const activePath = normalizeProjectRelativePath(activeSource.resource.projectRelativePath);
      const affected = changeSet.files.some((file) =>
        [file.oldPath, file.newPath]
          .filter((path): path is string => Boolean(path))
          .map(normalizeProjectRelativePath)
          .includes(activePath),
      );
      if (affected && actions.onOpenResource) {
        try {
          const refreshed = await actions.onOpenResource(activeSource.resource, 'zeus_source', activeSource.kind === 'source' ? activeSource.location : undefined);
          if (refreshed.preview) {
            setContextWorkspace((current) => (current.kind === 'source' && current.preview.resource.id === activeSource.resource.id ? { kind: 'source', preview: refreshed.preview as ConversationResourcePreview } : current));
          }
        } catch {
          setContextWorkspace((current) => (current.kind === 'source' && current.preview.resource.id === activeSource.resource.id ? { kind: 'none' } : current));
        }
      }
    }
    if (operationFailed) throw operationError;
    if (!result) {
      throw new Error('turn_change_set_operation_missing_result');
    }
    return result;
  }

  function closeContextWorkspace(options: { focusComposer?: boolean } = {}): void {
    window.zeus?.notifySessionContextActivity?.({ active: false, kind: 'none' });
    setContextWorkspace({ kind: 'none' });
    setContextFullWidth(false);
    const target = options.focusComposer ? composerRef.current : contextReturnFocusRef.current;
    contextReturnFocusRef.current = null;
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus();
      else composerRef.current?.focus();
    });
  }

  async function runGoalAction(action: (() => void | Promise<void>) | undefined, closeAfter = false): Promise<boolean> {
    if (!action || goalBusy) return false;
    const conversationId = workspaceIdentityRef.current;
    setGoalBusy(true);
    setGoalError(null);
    try {
      await action();
      if (workspaceIdentityRef.current !== conversationId) return false;
      if (closeAfter) setGoalPanelOpen(false);
      return true;
    } catch (error) {
      if (workspaceIdentityRef.current !== conversationId) return false;
      setGoalError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (workspaceIdentityRef.current === conversationId) setGoalBusy(false);
    }
  }

  function addResponseAnnotation(anchor: Parameters<NonNullable<ConversationTranscriptProps['onAddResponseAnnotation']>>[0]): string {
    const id = crypto.randomUUID();
    const current = props.state?.contextDraft;
    if (!current || !actions.onContextDraftChange) return '';
    actions.onContextDraftChange({ ...current, responseAnnotations: [...current.responseAnnotations, { id, anchor }] });
    return id;
  }

  function updateResponseAnnotation(id: string, note: string): void {
    const current = props.state?.contextDraft;
    if (!current || !actions.onContextDraftChange) return;
    actions.onContextDraftChange({
      ...current,
      responseAnnotations: current.responseAnnotations.map((annotation) => (annotation.id === id ? { ...annotation, ...(note.trim() ? { note: note.trim() } : { note: undefined }) } : annotation)),
    });
  }

  function removeResponseAnnotation(id: string): void {
    const current = props.state?.contextDraft;
    if (!current || !actions.onContextDraftChange) return;
    actions.onContextDraftChange({ ...current, responseAnnotations: current.responseAnnotations.filter((annotation) => annotation.id !== id) });
  }

  function updateCodeComments(codeComments: NonNullable<NativeSessionState['contextDraft']>['codeComments']): void {
    const current = props.state?.contextDraft;
    if (!current || !actions.onContextDraftChange) return;
    actions.onContextDraftChange({ ...current, codeComments });
  }

  function renderConversationComposer(): ReactNode {
    if (!props.state) return null;
    return (
      <SessionComposerProjection
        textareaRef={composerRef}
        state={props.state}
        controller={props.stateController}
        language={props.language}
        capabilities={props.capabilities}
        onDraftChange={(draft) => actions.onDraftChange?.(draft)}
        onSubmit={(delivery, settings) => actions.onSubmit?.(delivery, settings)}
        onInterrupt={(turnId) => actions.onInterrupt?.(turnId)}
        onChooseAttachments={actions.onChooseAttachments}
        onAddAttachments={actions.onAddAttachments}
        onRemoveAttachment={actions.onRemoveAttachment}
        onRemoveBrowserSubmission={actions.onRemoveBrowserSubmission}
        onContextDraftChange={actions.onContextDraftChange}
        runtimeSettings={composerRuntimeSettings}
        onRuntimeSettingsChange={updateComposerRuntimeSettings}
        permissionMode={composerRuntimeSettings?.permissionMode ?? props.state.snapshot?.nextTurnSettings?.permissionMode ?? props.state.snapshot?.permissionMode ?? props.conversation?.permissionMode ?? 'read-only'}
        collaborationMode={composerRuntimeSettings?.collaborationMode ?? props.state.snapshot?.nextTurnSettings?.collaborationMode ?? props.state.snapshot?.collaborationMode ?? props.conversation?.collaborationMode ?? 'default'}
        goalAvailable={goalAvailable}
        goal={goal}
        goalBusy={goalBusy}
        onSetGoal={actions.onSetGoal ? (objective) => runGoalAction(() => actions.onSetGoal?.(objective)) : undefined}
        onPauseGoal={actions.onPauseGoal ? () => runGoalAction(actions.onPauseGoal) : undefined}
        onResumeGoal={actions.onResumeGoal ? () => runGoalAction(actions.onResumeGoal) : undefined}
        onOpenGoal={() => {
          setGoalError(null);
          setGoalPanelOpen(true);
        }}
      />
    );
  }

  function renderBlockingInteraction(): ReactNode {
    if (props.suppressComposer || props.historyOnly) return null;
    if (blockingPendingRequest) {
      return (
        <section className="session-interaction-dock" aria-label={props.language === 'zh-CN' ? '待处理交互' : 'Pending interaction'}>
          <PendingRequestSurface
            key={blockingPendingRequest.id}
            request={blockingPendingRequest}
            language={props.language}
            permissionMode={props.state?.snapshot?.permissionMode ?? 'read-only'}
            filePaths={linkedFileApprovalPaths(props.state, blockingPendingRequest)}
            autoFocus
            busy={isRequestResponseBusy(props.state?.busyOperation ?? null, blockingPendingRequest.id)}
            error={requestErrors[blockingPendingRequest.id]}
            onRespond={(_requestId, response) => respond(blockingPendingRequest, response)}
            onSnooze={actions.onSnoozeRequest ? () => actions.onSnoozeRequest?.(blockingPendingRequest.id) : undefined}
            onChooseAttachments={actions.onChooseStartAttachments}
            answerAttachmentsSupported={(props.state?.snapshot?.agent?.kind ?? props.conversation?.agent?.kind ?? 'codex') === 'codex'}
          />
        </section>
      );
    }
    if (blockingPlanImplementationRequest) {
      return (
        <section className="session-interaction-dock" aria-label={props.language === 'zh-CN' ? '待处理交互' : 'Pending interaction'}>
          <PlanImplementationRequestSurface
            key={blockingPlanImplementationRequest.id}
            request={blockingPlanImplementationRequest}
            language={props.language}
            autoFocus
            busy={isRequestResponseBusy(props.state?.busyOperation ?? null, blockingPlanImplementationRequest.id)}
            error={requestErrors[blockingPlanImplementationRequest.id]}
            onRespond={(_requestId, response) => respondToPlanImplementationRequest(blockingPlanImplementationRequest, response)}
          />
        </section>
      );
    }
    return null;
  }

  return (
    <section
      className="session-workspace-root"
      aria-label={copy.workspace}
      data-transport-state={props.state?.transportState ?? props.loadState ?? 'empty'}
      data-conversation-state={props.state?.conversationState ?? (legacy ? 'legacy_readonly' : 'empty')}
      onKeyDownCapture={handleWorkspaceKeyDownCapture}
      onPointerDownCapture={(event) => {
        if (!contextOpen || !(event.target instanceof Element)) return;
        const active = Boolean(event.target.closest('.session-context-sidecar'));
        window.zeus?.notifySessionContextActivity?.({ active, kind: active ? contextWorkspace.kind : 'none' });
      }}
      onFocusCapture={(event) => {
        if (!contextOpen || !(event.target instanceof Element)) return;
        const active = Boolean(event.target.closest('.session-context-sidecar'));
        window.zeus?.notifySessionContextActivity?.({ active, kind: active ? contextWorkspace.kind : 'none' });
      }}
    >
      {displayedHeader ? (
        <header className="session-thread-header">
          <span key={displayedHeader.conversationId} className="session-thread-title-copy" data-conversation-transition="true">
            <span className="session-thread-title-row">
              {displayedHeader.taskId && actions.onOpenTaskDetail ? (
                <button
                  type="button"
                  className="session-thread-task-title"
                  title={displayedHeader.title}
                  aria-label={props.language === 'zh-CN' ? `打开任务详情：${displayedHeader.title}` : `Open task details: ${displayedHeader.title}`}
                  onClick={() => {
                    if (displayedHeader.taskId) actions.onOpenTaskDetail?.(displayedHeader.taskId);
                  }}
                >
                  {displayedHeader.title}
                </button>
              ) : (
                <strong title={displayedHeader.title}>{displayedHeader.title}</strong>
              )}
              {displayedHeader.taskId && displayedHeader.taskManagementStatus && displayedHeader.taskManagementStatusOptions?.length && actions.onTaskManagementStatusChange ? (
                <ZeusSelect
                  size="compact"
                  ariaLabel={props.language === 'zh-CN' ? `修改任务状态：${displayedHeader.title}` : `Change task status: ${displayedHeader.title}`}
                  value={displayedHeader.taskManagementStatus.id}
                  options={displayedHeader.taskManagementStatusOptions.map((status) => ({
                    value: status.id,
                    label: status.label,
                    color: status.color,
                  }))}
                  onChange={(status) => {
                    if (!displayedHeader.taskId || status === displayedHeader.taskManagementStatus?.id) return;
                    void Promise.resolve(actions.onTaskManagementStatusChange?.(displayedHeader.taskId, status)).catch(() => undefined);
                  }}
                  className="task-status-select task-status-custom session-thread-task-status"
                  style={{ '--task-status-tone': displayedHeader.taskManagementStatus.color } as CSSProperties}
                  disabled={props.taskManagementStatusChangeBusy}
                  searchable={false}
                />
              ) : displayedHeader.taskManagementStatus ? (
                <span
                  className="task-status-chip task-status-custom session-thread-task-status"
                  style={{ '--task-status-tone': displayedHeader.taskManagementStatus.color } as CSSProperties}
                  role="status"
                  aria-label={props.language === 'zh-CN' ? `任务状态：${displayedHeader.taskManagementStatus.label}` : `Task status: ${displayedHeader.taskManagementStatus.label}`}
                  title={props.language === 'zh-CN' ? `任务状态：${displayedHeader.taskManagementStatus.label}` : `Task status: ${displayedHeader.taskManagementStatus.label}`}
                >
                  <strong>{displayedHeader.taskManagementStatus.label}</strong>
                </span>
              ) : null}
            </span>
            {displayedHeader.contextLabel ? <small>{displayedHeader.contextLabel}</small> : null}
          </span>
          <div className="session-thread-header-actions">
            {!legacy && props.conversation ? (
              <button
                type="button"
                className={`session-browser-toggle ${browserOpen ? 'selected' : ''}`}
                aria-pressed={browserOpen}
                title={props.language === 'zh-CN' ? '内置浏览器（⌘⇧B）' : 'Built-in browser (⌘⇧B)'}
                onClick={(event) => {
                  contextReturnFocusRef.current = event.currentTarget;
                  if (browserOpen) {
                    closeContextWorkspace();
                    return;
                  }
                  setContextFullWidth(false);
                  setContextWorkspace({ kind: 'browser' });
                }}
              >
                <GlobeSimple aria-hidden="true" weight="regular" />
                <span>{props.language === 'zh-CN' ? '浏览器' : 'Browser'}</span>
              </button>
            ) : null}
            {!legacy && props.conversation && props.state ? (
              <SessionQuickActionsCard
                language={props.language}
                conversation={props.conversation}
                state={props.state}
                task={props.task}
                persistentHost={quickActionsPersistentHost}
                forceCollapsed={contextOpen || contextMounted}
                suppressed={props.quickActionsSuppressed}
                capabilities={props.capabilities}
                onLoadCapabilities={actions.onLoadCapabilities}
                onLoadTaskWorkspaces={actions.onLoadTaskWorkspaces}
                onOpenTaskDetail={actions.onOpenTaskDetail}
                onOpenGitReview={actions.onOpenTaskGitReview}
                onOpenGitDelivery={actions.onOpenTaskGitDelivery}
                onOpenProjectCommands={actions.onOpenProjectCommands}
                subagentCount={subagentThreadIds.length}
                onOpenSubagents={
                  actions.onLoadSubagents && actions.onLoadSubagentThread
                    ? (trigger) => {
                        contextReturnFocusRef.current = trigger;
                        setContextFullWidth(false);
                        setContextWorkspace({ kind: 'subagents' });
                      }
                    : undefined
                }
                onStartCodeReview={(selection: SessionCodeReviewSelection) => {
                  if (!props.task || !props.conversation || !actions.onStartConversation || props.conversation.projectId !== props.task.projectId || props.conversation.taskId !== props.task.id) {
                    return {
                      state: 'failed',
                      message: props.language === 'zh-CN' ? '当前会话没有可用于代码审查的任务 Worktree。' : 'This conversation does not have a task worktree available for code review.',
                    };
                  }
                  return actions.onStartConversation({
                    mode: 'create',
                    source: 'code_review',
                    task: props.task,
                    inheritConversationId: props.conversation.id,
                    content: props.language === 'zh-CN' ? '请审查当前工作区的完整代码变化。' : 'Review all code changes in the current workspace.',
                    permissionMode: selection.permissionMode,
                    collaborationMode: 'default',
                    serviceTierSelection: selection.serviceTierSelection,
                    model: selection.model,
                    effort: selection.effort,
                    agentKind: selection.agentKind,
                  });
                }}
                onAddSources={actions.onChooseAttachments}
                onOpenSource={(resource) => openConversationResource(resource, defaultOpenTarget(resource))}
                onLoadResourcePreview={actions.onLoadResourcePreview}
              />
            ) : null}
          </div>
        </header>
      ) : null}

      {!props.historyOnly && props.readOnlyGate ? (
        <section className="session-task-readonly-gate" role="note" aria-label={props.readOnlyGate.title}>
          <span>
            <strong>{props.readOnlyGate.title}</strong>
            <small>{props.readOnlyGate.description}</small>
          </span>
          <button type="button" onClick={() => void props.readOnlyGate?.onAction()} disabled={props.readOnlyGate.busy} aria-busy={props.readOnlyGate.busy || undefined}>
            {props.readOnlyGate.busy ? (props.language === 'zh-CN' ? '正在重新打开…' : 'Reopening…') : props.readOnlyGate.actionLabel}
          </button>
        </section>
      ) : null}

      {legacy && props.conversation ? (
        <>
          <LegacyConversationBanner conversation={props.conversation} language={props.language} onOpenImportSettings={actions.onOpenImportSettings} />
          {props.loadState === 'loading' ? (
            <p className="session-legacy-load-status" role="status" aria-live="polite">
              <span className="session-command-spinner" aria-hidden="true" />
              {copy.loading}
            </p>
          ) : null}
          {props.loadState === 'error' ? (
            <p className="session-legacy-load-status" role="status">
              {props.language === 'zh-CN' ? '旧会话仍保持只读。' : 'The legacy conversation remains read-only.'}
            </p>
          ) : null}
          {(props.legacyMessages?.[props.conversation.legacySourceConversationId ?? props.conversation.id] ?? []).length > 0 ? (
            <section className="session-legacy-transcript" role="log" aria-live="off" aria-label={copy.legacyTranscript}>
              {(props.legacyMessages?.[props.conversation.legacySourceConversationId ?? props.conversation.id] ?? []).map((message) => (
                <article key={message.id} className={`session-legacy-message session-legacy-message-${message.role}`}>
                  <strong>{message.role}</strong>
                  <SafeMarkdown text={message.content} language={props.language} />
                </article>
              ))}
            </section>
          ) : null}
        </>
      ) : props.state ? (
        <>
          <div className="session-thread-split" data-context-open={contextOpen || undefined} data-context-full-width={contextFullWidth || undefined}>
            <div className="session-thread-body">
              <div
                ref={browserSplitRef}
                className="session-conversation-browser-layout"
                data-browser-open={contextOpen || undefined}
                data-browser-expanded={contextFullWidth || undefined}
                data-context-kind={contextWorkspace.kind}
                data-browser-resizing={browserResizing || undefined}
              >
                <div className="session-conversation-pane">
                  <SessionRuntimeDetails state={props.state} conversation={props.conversation} language={props.language} capabilities={props.capabilities} />
                  <div ref={setQuickActionsPersistentHost} className="session-quick-actions-persistent-host" />
                  <SessionTranscriptProjection
                    state={props.state}
                    controller={props.stateController}
                    language={props.language}
                    historyOnly={props.historyOnly}
                    projectPersistedPlans={props.projectPersistedPlans}
                    historyLoading={Boolean(props.transcriptLoading ?? ((props.state.transportState === 'hydrating' || props.state.transportState === 'connecting') && !props.state.snapshot)) && !props.state.snapshot}
                    onLatestContentVisibilityChange={props.onLatestContentVisibilityChange}
                    creationStatus={props.creationStatus}
                    onEditUserItem={transcriptInteractionsEnabled ? actions.onEditUserItem : undefined}
                    openPlanItemKey={planWorkspaceItemKey}
                    onOpenPlan={
                      transcriptInteractionsEnabled
                        ? (item) => {
                            contextReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                            setContextFullWidth(false);
                            setContextWorkspace({ kind: 'plan', itemKey: item.key });
                          }
                        : undefined
                    }
                    onOpenResource={transcriptReadActionsEnabled ? openConversationResource : undefined}
                    onLoadResourcePreview={transcriptReadActionsEnabled ? actions.onLoadResourcePreview : undefined}
                    onLoadEarlierHistory={transcriptReadActionsEnabled ? actions.onLoadEarlierHistory : undefined}
                    onLoadTurnProcess={transcriptReadActionsEnabled ? actions.onLoadTurnProcess : undefined}
                    onLoadTurnArtifacts={transcriptReadActionsEnabled ? actions.onLoadTurnArtifacts : undefined}
                    onLoadV2Content={transcriptReadActionsEnabled ? actions.onLoadV2Content : undefined}
                    onLoadV2ToolResult={transcriptReadActionsEnabled ? actions.onLoadV2ToolResult : undefined}
                    onReviewTurnChanges={
                      transcriptInteractionsEnabled
                        ? (changeSet, fileId) => {
                            contextReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                            setContextFullWidth(false);
                            setContextWorkspace({
                              kind: 'turn_diff',
                              turnId: changeSet.providerTurnId,
                              ...(fileId ? { initialFileId: fileId } : {}),
                            });
                          }
                        : undefined
                    }
                    onOperateTurnChangeSet={transcriptInteractionsEnabled && actions.onOperateTurnChangeSet ? operateTurnChangeSet : undefined}
                    onAddResponseAnnotation={transcriptInteractionsEnabled && actions.onContextDraftChange ? addResponseAnnotation : undefined}
                    onUpdateResponseAnnotation={transcriptInteractionsEnabled && actions.onContextDraftChange ? updateResponseAnnotation : undefined}
                    onRemoveResponseAnnotation={transcriptInteractionsEnabled && actions.onContextDraftChange ? removeResponseAnnotation : undefined}
                    onOpenSideChat={
                      transcriptInteractionsEnabled && actions.onAskSideChat
                        ? (selectedText) => {
                            contextReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                            setContextFullWidth(false);
                            setContextWorkspace({ kind: 'side_chat', selectedText });
                          }
                        : undefined
                    }
                  />
                  {props.suppressComposer || props.historyOnly || !dockedPlan ? null : <SessionPlanProgress plan={dockedPlan} language={props.language} />}
                  {renderBlockingInteraction()}
                  {props.suppressComposer || blockingPendingRequest || blockingPlanImplementationRequest ? null : (
                    <>
                      {goal ? <GoalRail goal={goal} language={props.language} onOpen={() => setGoalPanelOpen(true)} /> : null}
                      {renderConversationComposer()}
                    </>
                  )}
                  {!props.historyOnly && interruptArmed ? (
                    <p className="session-interrupt-confirm" role="status">
                      {copy.interruptConfirm}
                    </p>
                  ) : null}
                </div>
                {contextMounted && props.conversation ? (
                  <motion.aside className="session-browser-sidecar session-context-sidecar" aria-label={contextWorkspaceLabel(contextWorkspace, props.language)} style={{ width: browserAnimatedWidth, opacity: browserVisibilityProgress }}>
                    <div
                      className="session-browser-resizer"
                      role="separator"
                      aria-label={props.language === 'zh-CN' ? '调整会话与右侧面板宽度' : 'Resize conversation and side panel'}
                      aria-orientation="vertical"
                      aria-valuemin={38}
                      aria-valuemax={72}
                      aria-valuenow={browserPaneShare}
                      tabIndex={contextFullWidth ? -1 : 0}
                      onPointerDown={handleBrowserResizePointerDown}
                      onPointerMove={handleBrowserResizePointerMove}
                      onPointerUp={finishBrowserResize}
                      onPointerCancel={finishBrowserResize}
                      onLostPointerCapture={() => {
                        browserResizeActiveRef.current = false;
                        setBrowserResizing(false);
                      }}
                      onKeyDown={handleBrowserResizeKeyDown}
                    />
                    <div className="session-browser-pane">
                      {contextWorkspace.kind === 'browser' && actions.onStageBrowserComments ? (
                        <BrowserWorkspace
                          conversationId={props.state?.conversationId ?? props.conversation.id}
                          language={props.language}
                          disabled={interactionReadOnly || nonResumableNative}
                          suspended={browserResizing}
                          expanded={contextFullWidth}
                          onClose={closeContextWorkspace}
                          onToggleExpanded={() => setContextFullWidth((expanded) => !expanded)}
                          onResetSize={() => {
                            setBrowserPaneShare(56);
                            setContextFullWidth(false);
                          }}
                          onStageComments={async (prepared) => {
                            await actions.onStageBrowserComments?.(prepared);
                            closeContextWorkspace({ focusComposer: true });
                          }}
                        />
                      ) : null}
                      {contextWorkspace.kind === 'subagents' && actions.onLoadSubagents && actions.onLoadSubagentThread ? (
                        <SubagentWorkspace
                          language={props.language}
                          conversationId={props.state.conversationId ?? props.conversation.id}
                          activityRevision={`${subagentActivity.revision}|${subagentSnapshotRevision}`}
                          hintCount={subagentThreadIds.length}
                          initialSnapshot={props.subagentListSnapshot}
                          fullWidth={contextFullWidth}
                          onFullWidthChange={setContextFullWidth}
                          onClose={closeContextWorkspace}
                          loadList={actions.onLoadSubagents}
                          loadThread={actions.onLoadSubagentThread}
                        />
                      ) : null}
                      {contextWorkspace.kind === 'plan' && planWorkspaceItem ? (
                        <PlanWorkspace item={planWorkspaceItem} language={props.language} fullWidth={contextFullWidth} onFullWidthChange={setContextFullWidth} onClose={closeContextWorkspace} />
                      ) : null}
                      {contextWorkspace.kind === 'source' ? (
                        <SourceWorkspace
                          preview={contextWorkspace.preview}
                          language={props.language}
                          fullWidth={contextFullWidth}
                          onFullWidthChange={setContextFullWidth}
                          onClose={closeContextWorkspace}
                          comments={props.state?.contextDraft.codeComments}
                          onCommentsChange={!interactionReadOnly && actions.onContextDraftChange ? updateCodeComments : undefined}
                        />
                      ) : null}
                      {contextWorkspace.kind === 'turn_diff' && turnDiffChangeSet ? (
                        <TurnDiffWorkspace
                          changeSet={turnDiffChangeSet}
                          initialFileId={contextWorkspace.initialFileId}
                          language={props.language}
                          fullWidth={contextFullWidth}
                          onFullWidthChange={setContextFullWidth}
                          onClose={closeContextWorkspace}
                          onOperate={!interactionReadOnly && actions.onOperateTurnChangeSet ? operateTurnChangeSet : undefined}
                          onOpenFile={(file, line) => openTurnChangeFile(turnDiffChangeSet, file, line)}
                          comments={props.state?.contextDraft.codeComments}
                          onCommentsChange={!interactionReadOnly && actions.onContextDraftChange ? updateCodeComments : undefined}
                        />
                      ) : null}
                      {contextWorkspace.kind === 'side_chat' && actions.onAskSideChat ? (
                        <SideChatWorkspace selectedText={contextWorkspace.selectedText} language={props.language} onAsk={(question) => actions.onAskSideChat!(contextWorkspace.selectedText, question)} onClose={closeContextWorkspace} />
                      ) : null}
                    </div>
                  </motion.aside>
                ) : null}
              </div>
            </div>
          </div>
          <GoalPanel
            open={goalPanelOpen}
            language={props.language}
            goal={goal}
            timeline={props.state?.snapshot?.goalTimeline ?? []}
            capability={goalCapability}
            busy={goalBusy}
            error={goalError}
            onDismiss={() => setGoalPanelOpen(false)}
            onSave={(objective) => runGoalAction(() => actions.onSetGoal?.(objective))}
            onPause={() => runGoalAction(actions.onPauseGoal)}
            onResume={() => runGoalAction(actions.onResumeGoal)}
            onClear={(confirmUnfinished) => runGoalAction(() => actions.onClearGoal?.(confirmUnfinished), true)}
          />
        </>
      ) : (
        <NewConversationComposer
          language={props.language}
          owner={owner}
          task={props.task}
          projects={props.projects}
          autoFocus={props.autoFocusNewConversation}
          loadState={props.loadState}
          loadError={props.loadError}
          capabilities={props.capabilities}
          onStartTask={actions.onStartConversation}
          onStartProject={actions.onStartProjectConversation}
          onLoadCapabilities={actions.onLoadCapabilities}
          onSelectProject={actions.onSelectNewConversationProject}
          onLoadProjectGit={actions.onLoadNewConversationProjectGit}
          onExecuteProjectGit={actions.onExecuteNewConversationProjectGit}
          onChooseAttachments={actions.onChooseStartAttachments}
        />
      )}
    </section>
  );
}

export function selectDockedTurnPlan(state: NativeSessionState): NativeSessionState['turnsByProviderId'][string]['plan'] {
  if (!state.activeTurnId) return null;
  const turn = state.turnsByProviderId[state.activeTurnId];
  if (!turn || turn.completedAt || (turn.status !== 'running' && turn.status !== 'waiting' && turn.status !== 'dispatching')) return null;
  return turn.plan;
}

function contextWorkspaceLabel(workspace: SessionContextWorkspace, language: SessionUiLanguage): string {
  const zh = language === 'zh-CN';
  if (workspace.kind === 'browser') return zh ? '会话浏览器' : 'Conversation browser';
  if (workspace.kind === 'subagents') return zh ? '智能体' : 'Agents';
  if (workspace.kind === 'plan') return zh ? '计划工作区' : 'Plan workspace';
  if (workspace.kind === 'source') return zh ? '源码预览' : 'Source preview';
  if (workspace.kind === 'turn_diff') return zh ? '变更审核' : 'Change review';
  if (workspace.kind === 'side_chat') return zh ? '侧边聊天' : 'Side chat';
  return zh ? '会话上下文工作区' : 'Conversation context workspace';
}

export function projectSubagentActivity(items: readonly NativeSessionItemBuffer[]): { threadIds: string[]; revision: string } {
  const threadIds = new Set<string>();
  const revisions: string[] = [];
  for (const item of items) {
    const payloadType = typeof item.payload.type === 'string' ? item.payload.type : item.type;
    const type = payloadType.toLowerCase().replaceAll(/[^a-z]/gu, '');
    if (type !== 'subagentactivity' && type !== 'collabagenttoolcall') continue;
    revisions.push(`${item.key}:${item.status}:${item.updatedAt ?? ''}`);
    if (typeof item.payload.agentThreadId === 'string') threadIds.add(item.payload.agentThreadId);
    if (Array.isArray(item.payload.receiverThreadIds)) {
      for (const threadId of item.payload.receiverThreadIds) if (typeof threadId === 'string' && threadId) threadIds.add(threadId);
    }
    const states = item.payload.agentsStates;
    if (states && typeof states === 'object' && !Array.isArray(states)) {
      for (const threadId of Object.keys(states)) if (threadId) threadIds.add(threadId);
    }
  }
  return { threadIds: [...threadIds].sort(), revision: revisions.join('|') };
}

function normalizeProjectRelativePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '');
}

function clearInterruptResetTimer(timerRef: { current: ReturnType<typeof setTimeout> | null }): void {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = null;
}

export function createRequestResponseGuard(): { begin(requestId: string): boolean; finish(requestId: string): void } {
  const pending = new Set<string>();
  return {
    begin(requestId) {
      if (pending.has(requestId)) return false;
      pending.add(requestId);
      return true;
    },
    finish(requestId) {
      pending.delete(requestId);
    },
  };
}

export function isRequestResponseBusy(operation: string | null, requestId: string): boolean {
  const prefixes = [`request:respond:${requestId}`, `plan-request:${requestId}`];
  return prefixes.some((prefix) => operation === prefix || operation?.startsWith(`${prefix}:`) === true);
}

export function shouldRestoreComposerFocus(previousPendingCount: number, pendingCount: number, state: NativeSessionState | null): boolean {
  return previousPendingCount > 0 && pendingCount === 0 && isComposerWritableForFocus(state, false);
}

export function resolveComposerFocusRestoration(input: { previousPendingCount: number; pendingCount: number; restorationPending: boolean; state: NativeSessionState | null; readOnly: boolean }): {
  restorationPending: boolean;
  shouldFocus: boolean;
} {
  if (input.pendingCount > 0) return { restorationPending: false, shouldFocus: false };
  const restorationPending = input.restorationPending || input.previousPendingCount > 0;
  if (!restorationPending || !isComposerWritableForFocus(input.state, input.readOnly)) return { restorationPending, shouldFocus: false };
  return { restorationPending: false, shouldFocus: true };
}

function isComposerWritableForFocus(state: NativeSessionState | null, readOnly: boolean): boolean {
  return Boolean(!readOnly && state && !state.busyOperation && state.conversationState !== 'legacy_readonly');
}

function NewConversationComposer(props: {
  language: SessionUiLanguage;
  owner?: SessionConversationOwner;
  task: SessionWorkspaceTask | null;
  projects?: readonly Pick<ProjectRecord, 'id' | 'name' | 'localPath'>[];
  inheritConversationId?: string;
  autoFocus?: boolean;
  docked?: boolean;
  initialContent?: string;
  initialAttachments?: NativeConversationAttachment[];
  loadState?: SessionWorkspaceProps['loadState'];
  loadError?: string | null;
  capabilities?: CodexConversationCapabilities | null;
  onStartTask?: SessionWorkspaceActions['onStartConversation'];
  onStartProject?: SessionWorkspaceActions['onStartProjectConversation'];
  onLoadCapabilities?: SessionWorkspaceActions['onLoadCapabilities'];
  onSelectProject?: SessionWorkspaceActions['onSelectNewConversationProject'];
  onLoadProjectGit?: SessionWorkspaceActions['onLoadNewConversationProjectGit'];
  onExecuteProjectGit?: SessionWorkspaceActions['onExecuteNewConversationProjectGit'];
  onChooseAttachments?: SessionWorkspaceActions['onChooseStartAttachments'];
  onAccepted?: () => void | Promise<void>;
}) {
  const copy = labels[props.language];
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const runtimePreferencesInitializedRef = useRef(false);
  const [content, setContent] = useState(() => props.initialContent ?? '');
  const [attachments, setAttachments] = useState<NativeConversationAttachment[]>(() => [...(props.initialAttachments ?? [])]);
  const [permissionMode, setPermissionMode] = useState<NativePermissionMode>('auto');
  const [collaborationMode, setCollaborationMode] = useState<NativeCollaborationMode>('default');
  const [capabilities, setCapabilities] = useState<CodexConversationCapabilities | null>(props.capabilities ?? null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(!props.capabilities);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedEffort, setSelectedEffort] = useState('');
  const [serviceTierSelection, setServiceTierSelection] = useState<NativeServiceTierSelection>({ type: 'standard' });
  const [isComposing, setIsComposing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [executionContextBusy, setExecutionContextBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [goalInputOpen, setGoalInputOpen] = useState(false);
  const [goalObjective, setGoalObjective] = useState('');
  const inputResources = useConversationInputResources({
    textareaRef,
    text: content,
    disabled: submitting || !props.owner || goalInputOpen,
    onTextChange: setContent,
    onAddAttachments: (selected) => {
      setLocalError(null);
      setAttachments((current) => mergeConversationAttachments(current, selected));
    },
    onRemoveAttachment: (attachment) => {
      setAttachments((current) => current.filter((candidate) => candidate !== attachment));
    },
    onError: setLocalError,
  });

  useApplicationErrorDialog(localError ?? (props.loadState === 'error' ? props.loadError : null), {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
  });

  useEffect(() => {
    if (props.autoFocus) textareaRef.current?.focus();
  }, [props.autoFocus]);

  useEffect(() => {
    const projectId = props.owner?.projectId;
    if (!projectId) return;
    if (!runtimePreferencesInitializedRef.current) {
      const remembered = readConversationRuntimePreferences(browserConversationStorage(), projectId, conversationRuntimePreferenceKind(props.owner));
      setSelectedModelId(remembered?.model ?? '');
      setSelectedEffort(remembered?.effort ?? '');
      setPermissionMode(remembered?.permissionMode ?? 'auto');
      setCollaborationMode(remembered?.collaborationMode ?? 'default');
      setServiceTierSelection(remembered?.serviceTier ?? { type: 'standard' });
      runtimePreferencesInitializedRef.current = true;
    }
    if (props.capabilities) {
      setCapabilities(props.capabilities);
      setCapabilitiesLoading(false);
      return;
    }
    setCapabilities(null);
    setCapabilitiesLoading(true);
    let active = true;
    void props
      .onLoadCapabilities?.(projectId)
      .then((snapshot) => {
        if (active && snapshot) setCapabilities(snapshot);
      })
      .catch((error: unknown) => {
        if (active) setLocalError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setCapabilitiesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.capabilities, props.onLoadCapabilities, props.owner?.projectId]);

  const preferredModel = resolveModelCapability(capabilities?.models, selectedModelId) ?? resolveModelCapability(capabilities?.models, capabilities?.preferredModel);
  const modelPresentation = useMemo(() => presentModelOptions(capabilities?.models ?? [], preferredModel?.id ?? selectedModelId, props.language), [capabilities?.models, preferredModel?.id, props.language, selectedModelId]);
  const selectedModel = resolveModelCapability(modelPresentation.models, modelPresentation.selectedId) ?? modelPresentation.models[0] ?? null;
  const selectedModelLabel = selectedModel ? modelPresentation.triggerLabel : '';
  const goalAvailable = Boolean(capabilities?.goals?.supported && capabilities?.goals?.enabled && selectedModel?.agentKind !== 'pi');
  const goalInputActive = goalInputOpen && goalAvailable;
  const goalCount = [...goalObjective.trim()].length;
  const goalObjectiveValid = goalCount > 0 && goalCount <= 4_000;

  useEffect(() => {
    if (!goalAvailable) setGoalInputOpen(false);
  }, [goalAvailable]);

  useEffect(() => {
    if (!selectedModel) return;
    if (selectedModelId !== selectedModel.id) setSelectedModelId(selectedModel.id);
    if (!selectedModel.supportedReasoningEfforts.includes(selectedEffort)) setSelectedEffort(selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? '');
    const normalized = normalizeServiceTierSelection(serviceTierSelection, selectedModel);
    if (!normalized.downgraded) return;
    setServiceTierSelection(normalized.selection);
  }, [selectedEffort, selectedModel, selectedModelId, serviceTierSelection]);

  useEffect(() => {
    const projectId = props.owner?.projectId;
    if (!projectId || !selectedModel) return;
    const preferenceKind = conversationRuntimePreferenceKind(props.owner);
    const currentPreference = readConversationRuntimePreferences(browserConversationStorage(), projectId, preferenceKind);
    writeConversationRuntimePreferences(browserConversationStorage(), projectId, preferenceKind, {
      model: selectedModel.id,
      ...(selectedEffort ? { effort: selectedEffort } : {}),
      serviceTier: serviceTierSelection,
      permissionMode,
      collaborationMode,
      ...(currentPreference?.workspaceMode ? { workspaceMode: currentPreference.workspaceMode } : {}),
    });
  }, [collaborationMode, permissionMode, props.owner, selectedEffort, selectedModel, serviceTierSelection]);

  useLayoutEffect(() => {
    if (textareaRef.current) autosizeTextarea(textareaRef.current);
  }, [content, goalInputActive, goalObjective]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const view = textarea?.ownerDocument.defaultView;
    if (!textarea || !view) return;
    const resize = () => autosizeTextarea(textarea);
    view.addEventListener('resize', resize);
    return () => view.removeEventListener('resize', resize);
  }, []);

  async function submit(overrides: { content?: string; goalObjective?: string } = {}): Promise<void> {
    const submittedContent = overrides.content ?? content;
    const submittedGoal = (overrides.goalObjective ?? (goalInputActive ? goalObjective : '')).trim();
    if (!props.owner || submitting || executionContextBusy || capabilitiesLoading || !selectedModel || (!submittedContent.trim() && attachments.length === 0) || (goalInputActive && !submittedGoal)) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      let accepted: void | boolean | NativeConversationStartPreparation | NativeConversationStartFailure;
      if (props.owner.kind === 'project') {
        if (!props.onStartProject) throw new Error('Project conversation start is unavailable.');
        accepted = await props.onStartProject({
          owner: props.owner,
          content: submittedContent,
          attachments,
          permissionMode,
          collaborationMode,
          serviceTierSelection,
          model: selectedModel?.id,
          effort: selectedEffort || undefined,
          ...(submittedGoal ? { goalObjective: submittedGoal } : {}),
        });
      } else {
        if (!props.task || !props.onStartTask) throw new Error('Task conversation start is unavailable.');
        accepted = await props.onStartTask({
          mode: 'create',
          task: props.task,
          ...(props.inheritConversationId ? { inheritConversationId: props.inheritConversationId } : {}),
          content: submittedContent,
          attachments,
          permissionMode,
          collaborationMode,
          serviceTierSelection,
          model: selectedModel?.id,
          effort: selectedEffort || undefined,
          ...(submittedGoal ? { goalObjective: submittedGoal } : {}),
        });
      }
      if (accepted === false) return;
      if (accepted && typeof accepted === 'object' && accepted.state === 'failed') {
        setLocalError(accepted.message);
        return;
      }
      await props.onAccepted?.();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  const composer = (
    <section
      className="session-composer-shell session-new-conversation-composer"
      aria-label={copy.newInput}
      aria-busy={submitting || executionContextBusy || capabilitiesLoading || inputResources.processing || undefined}
      data-goal-input={goalInputActive ? 'true' : 'false'}
      data-resource-dragging={inputResources.dragging ? 'true' : 'false'}
      onDragEnter={inputResources.handleDragEnter}
      onDragOver={inputResources.handleDragOver}
      onDragLeave={inputResources.handleDragLeave}
      onDrop={inputResources.handleDrop}
    >
      {goalInputActive ? null : (
        <ConversationComposerAttachments
          attachments={attachments}
          language={props.language}
          disabled={submitting || inputResources.processing}
          onRemove={(attachment) => setAttachments((current) => current.filter((candidate) => candidate !== attachment))}
          onRestorePastedText={inputResources.restorePastedText}
        />
      )}
      <div className="session-composer-input-frame" data-goal-input={goalInputActive ? 'true' : 'false'}>
        {props.owner?.kind === 'project' && props.projects?.length ? (
          <NewConversationExecutionContext
            language={props.language}
            projectId={props.owner.projectId}
            projects={props.projects}
            disabled={submitting}
            onSelectProject={props.onSelectProject}
            onLoadProjectGit={props.onLoadProjectGit}
            onExecuteProjectGit={props.onExecuteProjectGit}
            onBusyChange={setExecutionContextBusy}
          />
        ) : null}
        {goalInputActive ? (
          <div className="session-goal-compose-context">
            <Target aria-hidden="true" weight="regular" />
            <strong>{copy.createGoal}</strong>
            {content.trim() || attachments.length > 0 ? <small>{copy.normalDraftPreserved}</small> : null}
            <span className={goalCount > 4_000 ? 'session-goal-compose-count is-invalid' : 'session-goal-compose-count'}>{goalCount} / 4000</span>
            <button
              type="button"
              aria-label={copy.exitGoal}
              onClick={() => {
                setGoalInputOpen(false);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              disabled={submitting}
            >
              <X aria-hidden="true" weight="bold" />
            </button>
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          aria-label={goalInputActive ? copy.goalInput : copy.newInput}
          aria-keyshortcuts="Enter Shift+Enter Escape"
          autoFocus={props.autoFocus}
          placeholder={goalInputActive ? copy.goalPlaceholder : copy.newPlaceholder}
          value={goalInputActive ? goalObjective : content}
          disabled={submitting || !props.owner}
          onChange={(event) => (goalInputActive ? setGoalObjective(event.currentTarget.value) : setContent(event.currentTarget.value))}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onPaste={goalInputActive ? undefined : inputResources.handlePaste}
          onKeyDown={(event) => {
            if (!goalInputActive) inputResources.handlePasteShortcut(event);
            const intent = resolveComposerKeyIntent({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: isComposing || event.nativeEvent.isComposing,
              keyCode: event.nativeEvent.keyCode,
              repeat: event.repeat,
            });
            if (intent === 'escape' && goalInputActive) {
              event.preventDefault();
              event.stopPropagation();
              setGoalInputOpen(false);
              return;
            }
            if (intent !== 'submit') return;
            event.preventDefault();
            if (goalInputActive) {
              if (goalObjectiveValid) void submit({ content: content.trim() ? content : goalObjective, goalObjective });
              return;
            }
            if (/^\/goal(?:\s|$)/u.test(content.trim()) && goalAvailable) {
              const objective = content.trim().slice('/goal'.length).trim();
              if (['pause', 'resume', 'clear'].includes(objective)) return;
              setContent('');
              if (!objective) {
                setGoalInputOpen(true);
                requestAnimationFrame(() => textareaRef.current?.focus());
                return;
              }
              setGoalObjective(objective);
              setGoalInputOpen(true);
              void submit({ content: objective, goalObjective: objective });
              return;
            }
            void submit();
          }}
        />
        <div className="session-composer-command-row">
          <span className="session-composer-leading-actions">
            {!goalInputActive && props.onChooseAttachments ? (
              <button
                type="button"
                className="session-attachment-button"
                aria-label={copy.attach}
                disabled={submitting || inputResources.processing || !props.owner}
                onClick={async () => {
                  try {
                    const selected = await props.onChooseAttachments?.();
                    if (selected?.length) {
                      setAttachments((current) => mergeConversationAttachments(current, selected));
                    }
                  } catch (error) {
                    setLocalError(error instanceof Error ? error.message : String(error));
                  }
                }}
              >
                <Paperclip aria-hidden="true" weight="regular" />
              </button>
            ) : null}
            <PermissionModeControl language={props.language} value={permissionMode} disabled={submitting || !props.owner} onChange={setPermissionMode} />
            <CollaborationModeControl language={props.language} value={collaborationMode} disabled={submitting || !props.owner} onChange={setCollaborationMode} />
            {goalAvailable ? (
              <button
                type="button"
                className="session-goal-trigger"
                aria-label={goalInputActive ? copy.exitGoal : copy.createGoal}
                aria-pressed={goalInputActive}
                data-active={goalInputActive ? 'true' : 'false'}
                title={copy.createGoal}
                disabled={submitting || !props.owner}
                onClick={() => {
                  setGoalInputOpen((open) => !open);
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
              >
                <Target aria-hidden="true" weight={goalInputActive ? 'fill' : 'regular'} />
              </button>
            ) : null}
          </span>
          <span className="session-composer-trailing-actions">
            <span className="session-composer-runtime-settings">
              <ContextUsageIndicator unifiedUsage={null} language={props.language} />
              <ServiceTierToggle language={props.language} model={selectedModel} value={serviceTierSelection} disabled={submitting || !props.owner} onChange={setServiceTierSelection} />
              <ComposerDropdown
                label={props.language === 'zh-CN' ? '模型' : 'Model'}
                triggerLabel={`${props.language === 'zh-CN' ? '模型' : 'Model'}：${selectedModelLabel}`}
                displayLabel={selectedModelLabel}
                className="session-composer-model-dropdown"
                value={selectedModel?.id ?? ''}
                options={modelPresentation.options}
                disabled={submitting || !props.owner || !selectedModel}
                searchable
                searchPlaceholder={props.language === 'zh-CN' ? '搜索供应商或模型' : 'Search providers or models'}
                emptyLabel={props.language === 'zh-CN' ? '没有匹配模型' : 'No matching models'}
                onChange={(value) => {
                  const nextModel = resolveModelCapability(modelPresentation.models, value);
                  setSelectedModelId(nextModel?.id ?? value);
                  setSelectedEffort(nextModel?.defaultReasoningEffort ?? nextModel?.supportedReasoningEfforts[0] ?? '');
                  const normalized = normalizeServiceTierSelection(serviceTierSelection, nextModel);
                  setServiceTierSelection(normalized.selection);
                }}
              />
              <ComposerDropdown
                label={props.language === 'zh-CN' ? '推理强度' : 'Reasoning effort'}
                triggerLabel={`${props.language === 'zh-CN' ? '推理强度' : 'Reasoning effort'}：${selectedEffort}`}
                value={selectedEffort}
                options={(selectedModel?.supportedReasoningEfforts ?? []).map((effort) => ({ value: effort, label: effort }))}
                disabled={submitting || !props.owner || !selectedEffort}
                onChange={setSelectedEffort}
              />
            </span>
            <span className="session-primary-command-slot" data-primary-command-slot="true">
              <button
                type="button"
                className="session-send-button"
                aria-label={goalInputActive ? copy.createGoal : copy.send}
                onClick={() => void submit(goalInputActive ? { content: content.trim() ? content : goalObjective, goalObjective } : {})}
                disabled={submitting || executionContextBusy || capabilitiesLoading || inputResources.processing || !props.owner || !selectedModel || (goalInputActive ? !goalObjectiveValid : !content.trim() && attachments.length === 0)}
                aria-busy={submitting || undefined}
              >
                {submitting ? <span className="session-command-spinner" aria-hidden="true" /> : <ArrowUp aria-hidden="true" weight="bold" />}
              </button>
            </span>
          </span>
        </div>
      </div>
    </section>
  );

  // 停靠态与普通输入框同为会话列的直接子项，避免恢复容器参与剩余空间分配后把输入框推到正文顶部。
  if (props.docked) return composer;

  return (
    <section className="session-new-conversation">
      <span className="session-new-conversation-spacer" aria-hidden="true" />
      {composer}
    </section>
  );
}

function browserConversationStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function conversationNextTurnSettingsStorageKey(projectId: string, conversationId: string): string {
  return `zeus.native-next-turn-settings:${projectId}:${conversationId}`;
}

function readConversationNextTurnSettings(storage: Pick<Storage, 'getItem'> | undefined, projectId: string, conversationId: string): ComposerRuntimeSettings | null {
  if (!storage || !projectId || !conversationId) return null;
  try {
    const parsed = JSON.parse(storage.getItem(conversationNextTurnSettingsStorageKey(projectId, conversationId)) ?? 'null') as Partial<ComposerRuntimeSettings> | null;
    if (
      !parsed ||
      typeof parsed.model !== 'string' ||
      !parsed.model.trim() ||
      (parsed.effort !== undefined && (typeof parsed.effort !== 'string' || !parsed.effort.trim())) ||
      (parsed.serviceTier !== undefined && parsed.serviceTier !== null && (typeof parsed.serviceTier !== 'string' || !parsed.serviceTier.trim())) ||
      (parsed.permissionMode !== 'read-only' && parsed.permissionMode !== 'auto' && parsed.permissionMode !== 'full-access') ||
      (parsed.collaborationMode !== 'default' && parsed.collaborationMode !== 'plan')
    ) {
      return null;
    }
    return {
      model: parsed.model,
      ...(parsed.effort ? { effort: parsed.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed, 'serviceTier') ? { serviceTier: parsed.serviceTier } : {}),
      permissionMode: parsed.permissionMode,
      collaborationMode: parsed.collaborationMode,
    };
  } catch {
    return null;
  }
}

function writeConversationNextTurnSettings(storage: Pick<Storage, 'setItem'> | undefined, projectId: string, conversationId: string, settings: ComposerRuntimeSettings): void {
  if (!storage || !projectId || !conversationId) return;
  storage.setItem(conversationNextTurnSettingsStorageKey(projectId, conversationId), JSON.stringify(settings));
}

function composerRuntimeSettingsFromState(
  state: NativeSessionState,
  capabilities: CodexConversationCapabilities | null | undefined,
  conversation: Pick<NativeConversationChoice, 'permissionMode' | 'collaborationMode'> | null | undefined,
): ComposerRuntimeSettings | null {
  const source = state.snapshot?.nextTurnSettings;
  const requestedModel = source?.model ?? state.providerSettings?.model;
  if (!requestedModel) return null;
  const capability = resolveModelCapability(capabilities?.models, requestedModel) ?? resolveModelCapability(capabilities?.models, capabilities?.preferredModel);
  const model = capability?.id ?? requestedModel;
  const requestedEffort = source?.effort ?? state.providerSettings?.effort;
  const effort = requestedEffort && (!capability || capability.supportedReasoningEfforts.includes(requestedEffort)) ? requestedEffort : (capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0]);
  const hasSourceServiceTier = source ? Object.prototype.hasOwnProperty.call(source, 'serviceTier') : false;
  const hasProviderServiceTier = state.providerSettings ? Object.prototype.hasOwnProperty.call(state.providerSettings, 'serviceTier') : false;
  const requestedServiceTier = hasSourceServiceTier ? source?.serviceTier : hasProviderServiceTier ? state.providerSettings?.serviceTier : undefined;
  const serviceTier = typeof requestedServiceTier === 'string' && capability && !capability.serviceTiers.some((tier) => tier.id === requestedServiceTier) ? null : requestedServiceTier;
  return {
    model,
    ...(effort ? { effort } : {}),
    ...(hasSourceServiceTier || hasProviderServiceTier ? { serviceTier } : {}),
    // 任务首发创建期还没有服务端快照，先使用本次已确认的会话选择；
    // 快照到达后仍由服务端权限覆盖，缺失事实继续安全回退为只读。
    permissionMode: source?.permissionMode ?? state.snapshot?.permissionMode ?? conversation?.permissionMode ?? 'read-only',
    collaborationMode: source?.collaborationMode ?? state.snapshot?.collaborationMode ?? conversation?.collaborationMode ?? 'default',
  };
}

function mergeConversationAttachments(current: NativeConversationAttachment[], added: NativeConversationAttachment[]): NativeConversationAttachment[] {
  const byIdentity = new Map(current.map((attachment) => [conversationAttachmentIdentity(attachment), attachment]));
  added.forEach((attachment) => byIdentity.set(conversationAttachmentIdentity(attachment), attachment));
  return [...byIdentity.values()];
}

function SessionRuntimeDetails(props: { state: NativeSessionState; conversation: NativeConversationChoice | null; language: SessionUiLanguage; capabilities?: CodexConversationCapabilities | null }) {
  const model = props.state.providerSettings?.model?.trim() || props.state.snapshot?.model?.id?.trim() || props.conversation?.model?.id?.trim() || null;
  const effort = props.state.providerSettings?.effort?.trim() || props.state.snapshot?.nextTurnSettings?.effort?.trim() || null;
  const rawServiceTier = props.state.providerSettings?.serviceTier ?? props.state.snapshot?.nextTurnSettings?.serviceTier;
  const hasServiceTier = Boolean(
    (props.state.providerSettings && Object.prototype.hasOwnProperty.call(props.state.providerSettings, 'serviceTier')) ||
    (props.state.snapshot?.nextTurnSettings && Object.prototype.hasOwnProperty.call(props.state.snapshot.nextTurnSettings, 'serviceTier')) ||
    (!props.state.providerSettings && props.state.snapshot?.model?.id),
  );
  const serviceTier = !rawServiceTier || rawServiceTier === 'default' ? null : (props.capabilities?.models.flatMap((candidate) => candidate.serviceTiers).find((tier) => tier.id === rawServiceTier)?.name ?? rawServiceTier);
  const usage = props.state.tokenUsage;
  const metrics = props.state.sessionMetrics ?? props.state.snapshot?.sessionMetrics ?? null;
  const unifiedUsage = metrics?.usage ?? props.state.unifiedUsage;
  const conversationUsage = unifiedUsage?.conversationTotal ?? null;
  const latestRequest = unifiedUsage?.latestModelRequest ?? null;
  const totalTokens = conversationUsage?.totalTokens ?? usage?.total.totalTokens ?? null;
  const inputTokens = conversationUsage?.inputTokens ?? usage?.total.inputTokens ?? null;
  const outputTokens = conversationUsage?.outputTokens ?? usage?.total.outputTokens ?? null;
  const reasoningTokens = conversationUsage?.reasoningOutputTokens ?? usage?.total.reasoningOutputTokens ?? null;
  const cacheHitRate = nullableCacheHitRate(conversationUsage?.inputTokens ?? null, conversationUsage?.cachedInputTokens ?? null) ?? usage?.cacheHitRate ?? null;
  const cost = metrics?.cost ?? {
    apiEquivalentUsd: usage?.apiEquivalentUsd ?? null,
    priceCoverage: usage?.priceCoverage ?? null,
    pricingCatalogDate: usage?.pricingCatalogDate ?? null,
    pricingSourceUrls: usage?.pricingSourceUrls ?? [],
    historyComplete: usage?.historyComplete ?? false,
    complete: usage?.apiEquivalentUsd !== null && usage?.priceCoverage === 1 && usage?.historyComplete === true,
  };
  const mcpStartup = props.state.mcpStartup?.value ?? null;
  const executionContext = props.state.snapshot?.executionContext;
  const nativeSession = props.state.snapshot?.nativeSession ?? props.conversation?.nativeSession;
  const performance = metrics?.performance ?? null;
  const activity = metrics?.activity ?? null;
  const changes = metrics?.changeSummary ?? null;
  const runtime: NativeRuntimeDetailsSnapshot = {
    model: runtimeFact(model, '会话尚未同步模型。'),
    effort: runtimeFact(effort, '会话尚未同步推理强度。'),
    serviceTier: hasServiceTier ? { state: 'available', value: serviceTier } : { state: 'unavailable', reason: '会话尚未同步服务层级。' },
    usage: {
      totalTokens: runtimeFact(totalTokens, '会话累计 Token 暂无数据。'),
      inputTokens: runtimeFact(inputTokens, '累计输入 Token 暂无数据。'),
      outputTokens: runtimeFact(outputTokens, '累计输出 Token 暂无数据。'),
      reasoningOutputTokens: runtimeFact(reasoningTokens, '累计推理 Token 暂无数据。'),
      contextTokens: runtimeFact(latestRequest?.totalTokens ?? usage?.last.totalTokens ?? null, '最近请求上下文 Token 暂无数据。'),
      contextWindow: runtimeFact(latestRequest?.contextWindow ?? usage?.modelContextWindow ?? null, '模型上下文窗口暂无数据。'),
      cacheHitRate: runtimeFact(cacheHitRate, '缓存命中率暂无数据。'),
      apiEquivalentUsd: runtimeFact(cost.apiEquivalentUsd, '当前模型没有可用的 API 等价价格。'),
      priceCoverage: runtimeFact(cost.priceCoverage, '价格覆盖率暂无数据。'),
      pricingCatalogDate: runtimeFact(cost.pricingCatalogDate, '价格目录日期暂无数据。'),
      pricingSourceUrls: cost.pricingSourceUrls.length > 0 ? { state: 'available', value: cost.pricingSourceUrls } : { state: 'unavailable', reason: '价格来源暂无数据。' },
      historyComplete: { state: 'available', value: cost.historyComplete },
    },
    performance: {
      latestOutputTokensPerSecond: runtimeFact(performance?.latestOutputTokensPerSecond ?? null, '最近请求缺少可核验的输出计时。'),
      latestFirstVisibleResponseMs: runtimeFact(performance?.latestFirstVisibleResponseMs ?? null, '最近请求缺少首段可见响应计时。'),
      cumulativeProcessedDurationMs: runtimeFact(performance?.cumulativeProcessedDurationMs ?? null, '累计处理耗时暂无数据。'),
    },
    activity: {
      turnCount: runtimeFact(activity?.turnCount ?? null, '轮次统计暂无数据。'),
      modelRequestCount: runtimeFact(activity?.modelRequestCount ?? null, '模型请求统计暂无数据。'),
      toolOrCommandCount: runtimeFact(activity?.toolOrCommandCount ?? null, '工具与命令统计暂无数据。'),
      retryCount: runtimeFact(activity?.retryCount ?? null, '重试统计暂无数据。'),
      failedTurnCount: runtimeFact(activity?.failedTurnCount ?? null, '失败轮次统计暂无数据。'),
    },
    changeSummary:
      changes?.available && changes.fileCount !== null && changes.addedLines !== null && changes.deletedLines !== null
        ? { state: 'available', value: { fileCount: changes.fileCount, addedLines: changes.addedLines, deletedLines: changes.deletedLines, complete: changes.complete } }
        : { state: 'unavailable', reason: '代码改动统计暂无数据。' },
    environment: {
      cwd: runtimeFact(executionContext?.cwd ?? null, '会话工作目录暂无数据。'),
      branch: runtimeFact(executionContext?.cwd ? (executionContext.branch ?? labels[props.language].nonGitDirectory) : null, '会话分支暂无数据。'),
      nativeSessionId: runtimeFact(nativeSession?.id ?? props.state.providerThreadId ?? props.conversation?.providerThreadId ?? null, '会话线程 ID 暂无数据。'),
      nativeSessionPath: runtimeFact(nativeSession?.path ?? null, '会话 JSONL 路径暂无数据。'),
    },
  };
  return <RuntimeDetails runtime={runtime} language={props.language} scope="session" mcpStartup={mcpStartup} />;
}

function runtimeFact<T>(value: T | null | undefined, reason: string): NativeRuntimeFact<T> {
  return value === null || value === undefined ? { state: 'unavailable', reason } : { state: 'available', value };
}

function nullableCacheHitRate(inputTokens: number | null, cachedInputTokens: number | null): number | null {
  if (inputTokens === null || cachedInputTokens === null || inputTokens <= 0) return null;
  return Math.min(1, Math.max(0, cachedInputTokens / inputTokens));
}

function linkedFileApprovalPaths(state: NativeSessionState | null, request: NativePendingRequest): string[] {
  const providerItemId = stringField(request.payload.itemId);
  if (!state || requestKind(request) !== 'file' || !providerItemId) return [];
  const linkedItem = Object.values(state.items).find((item) => item.itemId === providerItemId || item.providerItemId === providerItemId);
  if (!linkedItem || linkedItem.type.replace(/[^a-z]/gi, '').toLowerCase() !== 'filechange' || !Array.isArray(linkedItem.payload.changes)) return [];
  return [
    ...new Set(
      linkedItem.payload.changes.flatMap((change) => {
        if (!isRecord(change)) return [];
        const path = stringField(change.path);
        return path ? [path] : [];
      }),
    ),
  ];
}

function sessionStateNeedsRealtime(state: NativeSessionState | null | undefined): boolean {
  if (!state) return false;
  if (state.pendingRequests.some((request) => request.status === 'pending')) return true;
  if (state.planImplementationRequests.some((request) => request.status === 'pending')) return true;
  if (state.queue?.state.type === 'dispatching' || state.queue?.state.type === 'active' || state.queue?.state.type === 'waiting') return true;
  if (state.queue?.submissions.some((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active')) return true;
  return (
    state.conversationState === 'starting_turn' ||
    state.conversationState === 'active_prework' ||
    state.conversationState === 'active_final_answer' ||
    state.conversationState === 'waiting_approval' ||
    state.conversationState === 'waiting_user_input'
  );
}

function resolveBrowserTargetWidth(layoutWidth: number, paneShare: number, expanded: boolean): number {
  if (!Number.isFinite(layoutWidth) || layoutWidth <= 0) return 0;
  if (expanded || layoutWidth <= 840) return layoutWidth;
  const minimumBrowser = Math.min(440, layoutWidth * 0.62);
  const minimumConversation = Math.min(360, layoutWidth * 0.48);
  const maximumBrowser = Math.max(minimumBrowser, layoutWidth - minimumConversation);
  return Math.min(Math.max((layoutWidth * paneShare) / 100, minimumBrowser), maximumBrowser);
}

function sessionPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
