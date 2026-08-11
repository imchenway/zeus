import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import { animate as animateMotion, motion, useMotionValue, useTransform } from 'framer-motion';
import type { ConversationFileLocation, ConversationOpenTarget, TurnChangeFile, ZeusBrowserPreparedSubmission } from '@zeus/shared';
import { openConversationResourceInMain, openTurnChangeFileInMain } from '../appShellBridge.js';
import { canSteerActiveTurn, type ComposerRuntimeSettings, ConversationComposer, resolveComposerKeyIntent } from './ConversationComposer.js';
import { ConversationTranscript } from './ConversationTranscript.js';
import { QueuedConversationMessages } from './QueuedConversationMessages.js';
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
import { defaultOpenTarget } from './ConversationResources.js';
import type {
  CodexConversationCapabilities,
  ConversationResource,
  ConversationResourcePreview,
  NativeCollaborationMode,
  NativeConversationAttachment,
  NativeConversationChoice,
  NativeConversationStage,
  NativeOperationAcceptance,
  NativePendingRequest,
  NativePermissionMode,
  NativePlanImplementationRequest,
  NativeServiceTierSelection,
  NativeSessionItemBuffer,
  NativeSessionState,
  NativeTurnSettingsSelection,
  SessionConversationOwner,
  StartNativeConversationRequest,
  StartProjectConversationRequest,
  TaskWorkspacesSnapshot,
  TurnChangeSet,
  TurnChangeSetOperationResult,
} from './sessionTypes.js';
import { normalizeServiceTierSelection, readProjectServiceTierPreference, serviceTierDescription, serviceTierOptions, serviceTierSelectionFromValue, serviceTierSelectionValue, serviceTierWireOverride } from './serviceTierSelection.js';
import { reconnectDelayMs, type SessionController, type SessionControllerClient, useSessionController } from './useSessionController.js';
import { createSessionEscapeController, type SessionEscapeController, type SessionEscapeLayer, type SessionEscapeResult } from './useThreadScrollController.js';
import { SafeMarkdown, type SessionUiLanguage } from './ThreadItemView.js';
import { autosizeTextarea } from './textareaAutosize.js';
import { conversationAttachmentIdentity, ConversationComposerAttachments } from './ConversationComposerAttachments.js';
import { useConversationInputResources } from './useConversationInputResources.js';
import { SessionQuickActionsCard } from './SessionQuickActionsCard.js';

export interface SessionWorkspaceTask {
  id: string;
  projectId: string;
  title: string;
  managementStatus?: {
    id: string;
    label: string;
    color: string;
  };
}

export type SessionStartMode = 'create' | 'resume' | 'reference_legacy';

export interface SessionWorkspaceStartInput {
  mode: SessionStartMode;
  task: SessionWorkspaceTask;
  inheritConversationId?: string;
  conversation?: NativeConversationChoice;
  legacyMessageIds?: string[];
  content: string;
  attachments?: NativeConversationAttachment[];
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  serviceTierSelection: NativeServiceTierSelection;
}

export interface ProjectSessionWorkspaceStartInput {
  owner: Extract<SessionConversationOwner, { kind: 'project' }>;
  content: string;
  attachments: NativeConversationAttachment[];
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  serviceTierSelection: NativeServiceTierSelection;
}

export interface SessionWorkspaceActions {
  onStartConversation?: (input: SessionWorkspaceStartInput) => void | boolean | Promise<void | boolean>;
  onStartProjectConversation?: (input: ProjectSessionWorkspaceStartInput) => void | boolean | Promise<void | boolean>;
  onLoadCapabilities?: (projectId: string) => Promise<CodexConversationCapabilities>;
  onReconnect?: () => void | Promise<void>;
  onDraftChange?: (draft: string) => void;
  onSubmit?: (delivery: 'queue' | 'steer_now', settings?: NativeTurnSettingsSelection) => void | Promise<void>;
  onStageBrowserComments?: (prepared: ZeusBrowserPreparedSubmission) => void | Promise<void>;
  onRemoveBrowserSubmission?: () => void;
  onInterrupt?: (turnId: string) => void | Promise<void>;
  onChooseAttachments?: () => void | Promise<void>;
  onChooseStartAttachments?: () => Promise<NativeConversationAttachment[]>;
  onAddAttachments?: (attachments: NativeConversationAttachment[]) => void;
  onRemoveAttachment?: (attachment: NativeConversationAttachment) => void;
  onEditQueuedSubmission?: (submissionId: string, content: string) => void | Promise<void>;
  onDeleteQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  onSendQueuedNow?: (submissionId: string) => void | Promise<void>;
  onReorderQueue?: (orderedSubmissionIds: string[]) => void | Promise<void>;
  onResumeQueue?: () => void | Promise<void>;
  onRecoverQueue?: () => void | Promise<void>;
  onRestoreArchivedConversation?: () => void | Promise<void>;
  onRespondToRequest?: (requestId: string, response: Record<string, unknown>) => void | Promise<void>;
  onEditUserItem?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  onRetryItem?: (item: NativeSessionItemBuffer) => void;
  onSelectTask?: (task: SessionWorkspaceTask) => void;
  onOpenTaskDetail?: (taskId: string) => void;
  onLoadTaskWorkspaces?: (taskId: string) => Promise<TaskWorkspacesSnapshot>;
  onOpenTaskGitReview?: (taskId: string, workspaceId: string | null, mode: 'commit' | 'push-only') => void;
  onOpenTaskGitDelivery?: (taskId: string) => void;
  onOpenImportSettings?: (conversation: NativeConversationChoice) => void;
  onNextTurnSettingsChange?: (settings: ComposerRuntimeSettings) => void | Promise<void>;
  onPermissionModeChange?: (permissionMode: NativePermissionMode) => void | Promise<void>;
  onCollaborationModeChange?: (collaborationMode: NativeCollaborationMode) => void | Promise<void>;
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
  onOperateTurnChangeSet?: (changeSet: TurnChangeSet, action: 'undo' | 'reapply') => Promise<TurnChangeSetOperationResult>;
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
      content: string;
      attachments?: NativeConversationAttachment[];
      inheritConversationId?: string;
      permissionMode: NativePermissionMode;
      collaborationMode: NativeCollaborationMode;
      serviceTier?: string | null;
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
  clearAccepted(input: SessionWorkspaceStartInput, request: StartNativeConversationRequest, acceptance: NativeOperationAcceptance): boolean;
}

export async function loadLegacyConversationDetail<T>(conversation: NativeConversationChoice, load: (projectId: string, sourceConversationId: string) => Promise<T>): Promise<{ sourceConversationId: string; detail: T }> {
  if (!conversation.readOnly && conversation.transportKind === 'codex_native') throw new Error('Only legacy read-only conversations can load reference details.');
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
  onStartConversation?: SessionWorkspaceActions['onStartConversation'];
  onStartProjectConversation?: SessionWorkspaceActions['onStartProjectConversation'];
  onOpenTaskDetail?: SessionWorkspaceActions['onOpenTaskDetail'];
  quickActionsSuppressed?: boolean;
  readOnlyGate?: SessionReadOnlyGate;
  onLoadTaskWorkspaces?: SessionWorkspaceActions['onLoadTaskWorkspaces'];
  onOpenTaskGitReview?: SessionWorkspaceActions['onOpenTaskGitReview'];
  onOpenTaskGitDelivery?: SessionWorkspaceActions['onOpenTaskGitDelivery'];
}

export function ConnectedSessionWorkspace(props: ConnectedSessionWorkspaceProps) {
  // 每个 conversation 由父层 key 隔离；初始乐观状态只在 controller 创建时接管一次，
  // 后续即使父层清理 task-push pending，也不能重建 controller 或闪断真实 transcript。
  const initialCachedState = useRef(props.initialCachedState).current;
  const initialOptimisticState = useRef(props.initialOptimisticState).current;
  const { state, controller } = useSessionController({
    client: props.client,
    projectId: props.conversation.projectId,
    conversationId: props.conversation.id,
    initialCachedState,
    initialOptimisticState,
  });
  const [capabilities, setCapabilities] = useState<CodexConversationCapabilities | null>(null);
  useEffect(() => {
    let active = true;
    const load = props.client.loadCodexConversationCapabilities;
    if (!load)
      return () => {
        active = false;
      };
    void load(props.conversation.projectId)
      .then((snapshot) => {
        if (active) setCapabilities(snapshot);
      })
      .catch(() => {
        if (active) setCapabilities(null);
      });
    return () => {
      active = false;
    };
  }, [props.client, props.conversation.projectId]);
  useEffect(() => {
    props.onStateChange?.(props.conversation.id, state);
  }, [props.conversation.id, props.onStateChange, state]);
  return (
    <SessionWorkspace
      language={props.language}
      state={state}
      conversation={props.conversation}
      task={props.task}
      owner={props.owner}
      choices={props.choices}
      capabilities={capabilities}
      suppressComposer={Boolean(props.readOnlyGate)}
      quickActionsSuppressed={props.quickActionsSuppressed}
      readOnlyGate={props.readOnlyGate}
      actions={{
        ...createConnectedSessionActions({ controller, state, onChooseAttachments: props.onChooseAttachments }),
        onOpenResource: async (resource, target, location) => {
          const result = await openConversationResourceInMain({
            zeus: window.zeus,
            projectId: props.conversation.projectId,
            conversationId: props.conversation.id,
            resourceId: resource.id,
            target,
            ...(location ? { location } : {}),
          });
          if (!result.opened) throw new Error(result.error ?? 'conversation_resource_open_failed');
          if (result.mode !== 'zeus_source') return { opened: true, mode: result.mode };
          if (!props.client.loadConversationResourcePreview) throw new Error('conversation_resource_preview_unavailable');
          const preview = await props.client.loadConversationResourcePreview(props.conversation.projectId, props.conversation.id, resource.id);
          return {
            opened: true,
            mode: result.mode,
            preview: location ? { ...preview, location } : preview,
          };
        },
        onLoadResourcePreview: async (resource) => {
          if (!props.client.loadConversationResourcePreview) throw new Error('conversation_resource_preview_unavailable');
          return props.client.loadConversationResourcePreview(props.conversation.projectId, props.conversation.id, resource.id);
        },
        onOpenTurnChangeFile: async (changeSet, file, target, location) => {
          const result = await openTurnChangeFileInMain({
            zeus: window.zeus,
            projectId: props.conversation.projectId,
            conversationId: props.conversation.id,
            turnId: changeSet.providerTurnId,
            changeSetId: changeSet.id,
            fileId: file.id,
            target,
            ...(location ? { location } : {}),
          });
          if (!result.opened) throw new Error(result.error ?? 'turn_change_file_open_failed');
          if (result.mode !== 'zeus_source') return { opened: true, mode: result.mode };
          if (!props.client.loadTurnChangeFilePreview) throw new Error('turn_change_file_preview_unavailable');
          const preview = await props.client.loadTurnChangeFilePreview(props.conversation.projectId, props.conversation.id, changeSet.providerTurnId, changeSet.id, file.id);
          return {
            opened: true,
            mode: result.mode,
            preview: location ? { ...preview, location } : preview,
          };
        },
        onOperateTurnChangeSet: async (changeSet, action) => {
          if (!props.client.operateTurnChangeSet) throw new Error('turn_change_set_operation_unavailable');
          return props.client.operateTurnChangeSet(props.conversation.projectId, props.conversation.id, changeSet.providerTurnId, action, {
            changeSetId: changeSet.id,
            expectedState: action === 'undo' ? 'applied' : 'undone',
            idempotencyKey: crypto.randomUUID(),
          });
        },
        onStartConversation: props.onStartConversation,
        onStartProjectConversation: props.onStartProjectConversation,
        onOpenTaskDetail: props.onOpenTaskDetail,
        onLoadTaskWorkspaces: props.onLoadTaskWorkspaces,
        onOpenTaskGitReview: props.onOpenTaskGitReview,
        onOpenTaskGitDelivery: props.onOpenTaskGitDelivery,
        onLoadCapabilities: props.client.loadCodexConversationCapabilities,
        onChooseStartAttachments: props.onChooseAttachments,
      }}
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

export function createConnectedSessionActions(input: { controller: SessionController; state: NativeSessionState; onChooseAttachments?: () => Promise<NativeConversationAttachment[]> }): SessionWorkspaceActions {
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
      const effectiveDelivery = delivery === 'steer_now' && canSteerActiveTurn(input.state) ? 'steer_now' : 'queue';
      return settle(input.controller.send(effectiveDelivery, effectiveDelivery === 'steer_now' ? (input.state.activeTurnId ?? undefined) : undefined, effectiveDelivery === 'queue' ? settings : undefined));
    },
    onStageBrowserComments: (prepared) => input.controller.setBrowserSubmission(prepared),
    onRemoveBrowserSubmission: () => input.controller.setBrowserSubmission(null),
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
    // 删除未进入 provider turn 的内容是本地软删除，不会触发 Provider 重发。
    onDeleteQueuedSubmission: (submissionId) => settle(input.controller.deleteQueuedSubmission(submissionId)),
    onSendQueuedNow: (submissionId) => settle(input.controller.sendQueuedNow(submissionId)),
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
    permissionMode: permissionModeField(conversation.permissionMode),
    collaborationMode: conversation.collaborationMode === 'plan' ? 'plan' : 'default',
    createdAt: stringField(conversation.createdAt) ?? now,
    updatedAt: stringField(conversation.updatedAt) ?? now,
    archived: conversation.archived === true,
    hasUnreadCompletion: conversation.hasUnreadCompletion === true,
    pendingRequestKind: conversation.pendingRequestKind === 'user_input' ? 'user_input' : conversation.pendingRequestKind === 'approval' ? 'approval' : null,
    resumable: conversation.resumable !== false,
    readOnly: conversation.readOnly === true,
  };
}

export async function startNativeConversationWithDurableAcceptance<T>(options: {
  input: SessionWorkspaceStartInput;
  envelopeManager: NativeConversationStartEnvelopeManager;
  dispatch: (taskId: string, request: StartNativeConversationRequest) => Promise<NativeOperationAcceptance>;
  onAccepted: (choice: NativeConversationChoice) => void | Promise<void>;
  refresh: (taskId: string) => Promise<T>;
}): Promise<{ choice: NativeConversationChoice; request: StartNativeConversationRequest; acceptance: NativeOperationAcceptance; refreshResult: T | null; refreshError: unknown | null }> {
  const request = options.envelopeManager.prepare(options.input);
  const acceptance = await options.dispatch(options.input.task.id, request);
  if (!isDurableNativeConversationAcceptance(request, acceptance)) throw new Error('Native conversation start did not return a durable accepted operation.');
  options.envelopeManager.clearAccepted(options.input, request, acceptance);
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
  clearAccepted(input: ProjectSessionWorkspaceStartInput, request: StartProjectConversationRequest, acceptance: NativeOperationAcceptance): boolean;
}

/** 项目级首发在请求前持久化完整输入 envelope，重载或未知结果重试时复用同一组身份。 */
export function createProjectConversationStartEnvelopeManager(options: { storage?: NativeConversationStartStorage; createId: () => string }): ProjectConversationStartEnvelopeManager {
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
        throw new Error(`Unable to persist project conversation start before dispatch: ${error instanceof Error ? error.message : String(error)}`);
      }
      return request;
    },
    clearAccepted(input, request, acceptance) {
      if (!options.storage || !isDurableNativeConversationAcceptance(request, acceptance)) return false;
      const requestPayload = buildProjectConversationStartPayload(input);
      const fingerprint = JSON.stringify({ projectId: input.owner.projectId, payload: requestPayload });
      const storageKey = projectConversationStartStorageKey(input.owner.projectId);
      const persisted = readPersistedProjectConversationStartEnvelope(options.storage, storageKey);
      if (!persisted || persisted.fingerprint !== fingerprint || persisted.request.idempotencyKey !== request.idempotencyKey || persisted.request.clientUserMessageId !== request.clientUserMessageId) return false;
      try {
        options.storage.removeItem(storageKey);
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
    permissionMode: permissionModeField(conversation.permissionMode),
    collaborationMode: conversation.collaborationMode === 'plan' ? 'plan' : 'default',
    createdAt: stringField(conversation.createdAt) ?? now,
    updatedAt: stringField(conversation.updatedAt) ?? now,
    archived: conversation.archived === true,
    hasUnreadCompletion: conversation.hasUnreadCompletion === true,
    pendingRequestKind: conversation.pendingRequestKind === 'user_input' ? 'user_input' : conversation.pendingRequestKind === 'approval' ? 'approval' : null,
    resumable: conversation.resumable !== false,
    readOnly: conversation.readOnly === true,
  };
}

export async function startProjectConversationWithDurableAcceptance<T>(options: {
  input: ProjectSessionWorkspaceStartInput;
  envelopeManager: ProjectConversationStartEnvelopeManager;
  dispatch: (projectId: string, request: StartProjectConversationRequest) => Promise<NativeOperationAcceptance>;
  onAccepted: (choice: NativeConversationChoice) => void | Promise<void>;
  refresh: (projectId: string) => Promise<T>;
}): Promise<{ choice: NativeConversationChoice; request: StartProjectConversationRequest; acceptance: NativeOperationAcceptance; refreshResult: T | null; refreshError: unknown | null }> {
  const request = options.envelopeManager.prepare(options.input);
  const acceptance = await options.dispatch(options.input.owner.projectId, request);
  if (!isDurableNativeConversationAcceptance(request, acceptance)) throw new Error('Project conversation start did not return a durable accepted operation.');
  options.envelopeManager.clearAccepted(options.input, request, acceptance);
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
    ...serviceTierWireOverride(input.serviceTierSelection),
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

function permissionModeField(value: unknown): NativePermissionMode | undefined {
  return value === 'read-only' || value === 'auto' || value === 'full-access' ? value : undefined;
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
export function createNativeConversationStartEnvelopeManager(options: { storage?: NativeConversationStartStorage; createId: () => string }): NativeConversationStartEnvelopeManager {
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
        throw new Error(`Unable to persist native conversation start before dispatch: ${error instanceof Error ? error.message : String(error)}`);
      }
      return request;
    },
    clearAccepted(input, request, acceptance) {
      if (!options.storage || !isDurableNativeConversationAcceptance(request, acceptance)) return false;
      const payload = buildStartNativeConversationPayload(input);
      const fingerprint = startNativeConversationFingerprint(input, payload);
      const storageKey = startNativeConversationStorageKey(input.task);
      const persisted = readPersistedNativeConversationStartEnvelope(options.storage, storageKey);
      if (!persisted || persisted.fingerprint !== fingerprint || persisted.request.idempotencyKey !== request.idempotencyKey || persisted.request.clientUserMessageId !== request.clientUserMessageId) return false;
      try {
        options.storage.removeItem(storageKey);
        return true;
      } catch {
        // 接受结果已经 durable；保留旧 envelope 只会安全地复用同一 idempotency key。
        return false;
      }
    },
  };
}

function buildStartNativeConversationPayload(input: SessionWorkspaceStartInput): StartNativeConversationPayload {
  const content = input.content.trim();
  if (input.mode === 'create') {
    if (!content && !input.attachments?.length) throw new Error('Native conversation start content or attachments are required.');
    return {
      mode: 'create',
      content,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.inheritConversationId ? { inheritConversationId: input.inheritConversationId } : {}),
      permissionMode: input.permissionMode ?? 'auto',
      collaborationMode: input.collaborationMode ?? 'default',
      ...serviceTierWireOverride(input.serviceTierSelection),
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

function startNativeConversationStorageKey(task: SessionWorkspaceTask): string {
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
      (request.inheritConversationId === undefined || (typeof request.inheritConversationId === 'string' && Boolean(request.inheritConversationId))) &&
      permissionModeField(request.permissionMode) !== undefined &&
      (request.collaborationMode === 'default' || request.collaborationMode === 'plan') &&
      serviceTierOverrideField(request.serviceTier)
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

export function isDurableNativeConversationAcceptance(request: Pick<StartNativeConversationRequest | StartProjectConversationRequest, 'idempotencyKey'>, acceptance: NativeOperationAcceptance): boolean {
  return (
    acceptance.operation.status === 'accepted' &&
    typeof acceptance.operation.id === 'string' &&
    acceptance.operation.id.length > 0 &&
    acceptance.operation.idempotencyKey === request.idempotencyKey &&
    typeof acceptance.conversation.id === 'string' &&
    acceptance.conversation.id.length > 0
  );
}

export interface SessionWorkspaceProps {
  language: SessionUiLanguage;
  state: NativeSessionState | null;
  conversation: NativeConversationChoice | null;
  task: SessionWorkspaceTask | null;
  owner?: SessionConversationOwner;
  tasks?: SessionWorkspaceTask[];
  choices?: NativeConversationChoice[];
  suppressComposer?: boolean;
  quickActionsSuppressed?: boolean;
  readOnlyGate?: SessionReadOnlyGate;
  capabilities?: CodexConversationCapabilities | null;
  choicesKnown?: boolean;
  legacyMessages?: Record<string, Array<{ id: string; role: string; content: string }>>;
  loadState?: 'empty' | 'loading' | 'error';
  loadError?: string | null;
  autoFocusNewConversation?: boolean;
  creationStatus?: {
    state: 'creating' | 'failed';
    message: string;
    error?: string | null;
    retryLabel?: string;
    onRetry?: () => void | Promise<void>;
  };
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

const labels = {
  'zh-CN': {
    workspace: '会话工作区',
    loading: '正在加载会话',
    refreshing: '正在刷新会话',
    reconnecting: '正在重新连接',
    reconnectingAttempt: (attempt: number) => `正在重新连接 · 第 ${Math.max(1, attempt)} 次`,
    failed: '连接失败',
    failureHelp: '连接中断。请重新连接以读取最新快照。',
    refreshFailureHelp: '后台刷新失败，当前仍显示上次成功读取的内容。',
    serverBusy: '服务繁忙',
    serverBusyHelp: '服务暂时繁忙。请稍候片刻，然后重新连接。',
    details: '详情',
    retry: '重新连接',
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
    attach: '添加附件',
    removeAttachment: '移除附件',
    runtimeDetails: '运行时详情',
    model: '模型',
    usage: 'Token 用量',
    cacheHitRate: '缓存 Token 命中率',
    cacheRead: '缓存读取',
    cacheWrite: '缓存写入',
    reasoningOutput: '推理输出',
    contextUsage: '上下文占用',
    estimatedCredits: '估算 Credits',
    apiEquivalentUsd: 'API 等价美元',
    priceCoverage: '费用覆盖率',
    priceSource: '价格来源',
    collectionNotice: '该指标自用量采集启用后开始记录',
    cwd: '当前目录',
    branch: '当前分支',
    sessionId: '会话 ID',
    jsonlPath: 'JSONL 文件',
    nonGitDirectory: '非 Git 目录',
    unavailable: '不可用',
    rateLimits: '账户限额',
    mcpStartup: 'MCP 启动状态',
    runtimeReady: '运行时状态正常',
    runtimeAttention: '需要关注',
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
    refreshFailureHelp: 'Background refresh failed. The last successfully loaded content remains visible.',
    serverBusy: 'Server busy',
    serverBusyHelp: 'The server is temporarily busy. Wait briefly, then reconnect.',
    details: 'Details',
    retry: 'Reconnect',
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
    attach: 'Add attachment',
    removeAttachment: 'Remove attachment',
    runtimeDetails: 'Runtime details',
    model: 'Model',
    usage: 'Token usage',
    cacheHitRate: 'Cached-token hit rate',
    cacheRead: 'Cache reads',
    cacheWrite: 'Cache writes',
    reasoningOutput: 'Reasoning output',
    contextUsage: 'Context usage',
    estimatedCredits: 'Estimated Credits',
    apiEquivalentUsd: 'API-equivalent USD',
    priceCoverage: 'Price coverage',
    priceSource: 'Price source',
    collectionNotice: 'This metric is recorded only since usage collection was enabled',
    cwd: 'Current directory',
    branch: 'Current branch',
    sessionId: 'Session ID',
    jsonlPath: 'JSONL file',
    nonGitDirectory: 'Not a Git directory',
    unavailable: 'Unavailable',
    rateLimits: 'Account rate limits',
    mcpStartup: 'MCP startup',
    runtimeReady: 'Runtime status current',
    runtimeAttention: 'Attention required',
    legacyTranscript: 'Read-only legacy transcript',
    unsynced: 'Not synced',
    exactValue: 'exact value',
  },
} as const;

const TOKEN_USAGE_UNITS = [
  { suffix: '', divisor: 1 },
  { suffix: 'K', divisor: 1_000 },
  { suffix: 'M', divisor: 1_000_000 },
  { suffix: 'B', divisor: 1_000_000_000 },
] as const;
const TOKEN_USAGE_SIGNIFICANT_DIGITS = 3;
const TOKEN_USAGE_COMPACT_FORMATTER = new Intl.NumberFormat('en-US', { maximumSignificantDigits: TOKEN_USAGE_SIGNIFICANT_DIGITS, useGrouping: false });
const TOKEN_USAGE_EXACT_FORMATTERS = {
  'zh-CN': new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }),
  'en-US': new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }),
} satisfies Record<SessionUiLanguage, Intl.NumberFormat>;

type TokenUsageLabel = 'tokens' | 'in' | 'out';

function formatTokenCount(count: number, language: SessionUiLanguage): { compact: string; exact: string } {
  let unitIndex = 0;
  for (let index = 1; index < TOKEN_USAGE_UNITS.length; index += 1) {
    if (count < TOKEN_USAGE_UNITS[index].divisor) break;
    unitIndex = index;
  }

  let unit = TOKEN_USAGE_UNITS[unitIndex];
  let rounded = Number((count / unit.divisor).toPrecision(TOKEN_USAGE_SIGNIFICANT_DIGITS));
  if (rounded >= 1_000 && unitIndex < TOKEN_USAGE_UNITS.length - 1) {
    unitIndex += 1;
    unit = TOKEN_USAGE_UNITS[unitIndex];
    rounded = Number((count / unit.divisor).toPrecision(TOKEN_USAGE_SIGNIFICANT_DIGITS));
  }

  const exact = TOKEN_USAGE_EXACT_FORMATTERS[language].format(count);
  return {
    compact: unitIndex === 0 ? exact : `${TOKEN_USAGE_COMPACT_FORMATTER.format(rounded)}${unit.suffix}`,
    exact,
  };
}

function TokenUsageValue(props: { count: number; label: TokenUsageLabel; language: SessionUiLanguage }) {
  const display = formatTokenCount(props.count, props.language);
  const visibleText = `${display.compact} ${props.label}`;
  const exactText = `${display.exact} ${props.label}`;
  return (
    <span title={exactText} aria-label={`${visibleText}, ${labels[props.language].exactValue} ${exactText}`}>
      {visibleText}
    </span>
  );
}

type SessionWorkspaceStatus = { kind: 'ready' | 'busy' | 'warning' | 'error'; label: string };

type SessionContextWorkspace = { kind: 'none' } | { kind: 'browser' } | { kind: 'plan'; itemId: string } | { kind: 'source'; preview: ConversationResourcePreview } | { kind: 'turn_diff'; turnId: string; initialFileId?: string };

export interface SessionHeaderSnapshot {
  conversationId: string;
  title: string;
  contextLabel: string | null;
  taskId: string | null;
  taskManagementStatus: SessionWorkspaceTask['managementStatus'] | null;
  status: SessionWorkspaceStatus;
}

export function createSessionHeaderSnapshot(
  conversation: NativeConversationChoice | null,
  task: SessionWorkspaceTask | null,
  state: NativeSessionState | null,
  loadState: SessionWorkspaceProps['loadState'],
  language: SessionUiLanguage,
  owner?: SessionConversationOwner,
): SessionHeaderSnapshot | null {
  if (!conversation) return null;
  const taskId = task?.id ?? (owner?.kind === 'task' ? owner.taskId : null);
  const taskTitle = task?.title ?? (owner?.kind === 'task' ? owner.taskTitle : null);
  return {
    conversationId: conversation.id,
    title: taskTitle ?? conversation.title,
    contextLabel: taskId ? null : ((owner?.kind === 'project' ? owner.projectName : null) ?? conversation.summary ?? conversation.projectId),
    taskId,
    taskManagementStatus: task?.managementStatus ?? null,
    status: sessionStatus(state, loadState, labels[language]),
  };
}

export function SessionWorkspace(props: SessionWorkspaceProps) {
  const copy = labels[props.language];
  const actions = props.actions ?? {};
  const owner: SessionConversationOwner | undefined = props.owner ?? (props.task ? { kind: 'task', projectId: props.task.projectId, projectName: props.task.projectId, taskId: props.task.id, taskTitle: props.task.title } : undefined);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const responseGuard = useRef(createRequestResponseGuard()).current;
  const escapeController = useRef(createSessionEscapeController()).current;
  const interruptResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextReturnFocusRef = useRef<HTMLElement | null>(null);
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [interruptArmed, setInterruptArmed] = useState(false);
  const [contextWorkspace, setContextWorkspace] = useState<SessionContextWorkspace>({ kind: 'none' });
  const [contextMounted, setContextMounted] = useState(false);
  const [quickActionsPersistentHost, setQuickActionsPersistentHost] = useState<HTMLDivElement | null>(null);
  const [contextFullWidth, setContextFullWidth] = useState(false);
  const [browserPaneShare, setBrowserPaneShare] = useState(56);
  const [browserResizing, setBrowserResizing] = useState(false);
  const [browserLayoutWidth, setBrowserLayoutWidth] = useState(0);
  const browserSplitRef = useRef<HTMLDivElement | null>(null);
  const browserResizeActiveRef = useRef(false);
  const browserMotionStopRef = useRef<(() => void) | null>(null);
  const browserVisibilityProgress = useMotionValue(0);
  const browserTargetWidth = useMotionValue(0);
  const browserAnimatedWidth = useTransform<number, number>([browserVisibilityProgress, browserTargetWidth], ([progress, targetWidth]) => Math.max(0, Math.min(1, progress)) * targetWidth);
  const contextOpen = contextWorkspace.kind !== 'none';
  const browserOpen = contextWorkspace.kind === 'browser';
  const planWorkspaceItemId = contextWorkspace.kind === 'plan' ? contextWorkspace.itemId : null;
  const sessionReady = props.state != null;
  const resolvedBrowserTargetWidth = resolveBrowserTargetWidth(browserLayoutWidth, browserPaneShare, contextFullWidth);
  const currentHeader = useMemo(() => createSessionHeaderSnapshot(props.conversation, props.task, props.state, props.loadState, props.language, owner), [owner, props.conversation, props.language, props.loadState, props.state, props.task]);
  const currentHeaderRef = useRef(currentHeader);
  currentHeaderRef.current = currentHeader;
  const [displayedHeader, setDisplayedHeader] = useState(currentHeader);
  const [titleMotion, setTitleMotion] = useState<'entered' | 'exiting'>('entered');
  // 会话重新挂载时先接管本地已确认的用户选择，避免旧热快照在首轮 effect 中覆盖尚在落盘的配置。
  const [composerRuntimeSettings, setComposerRuntimeSettings] = useState<ComposerRuntimeSettings | null>(() =>
    readConversationNextTurnSettings(browserConversationStorage(), props.conversation?.projectId ?? '', props.conversation?.id ?? ''),
  );
  const lastNextTurnSettingsSyncRef = useRef<string | null>(null);
  const previousBlockingInteractionCountRef = useRef(0);
  const composerFocusRestorationPendingRef = useRef(false);
  const legacy = props.conversation && (props.conversation.readOnly || props.conversation.transportKind !== 'codex_native');
  const interactionReadOnly = Boolean(props.readOnlyGate);
  const effectiveProviderState = props.state?.snapshot?.providerState ?? props.conversation?.providerState ?? null;
  const effectiveResumable = props.state?.snapshot ? !['closed', 'failed'].includes(effectiveProviderState ?? '') : effectiveProviderState === 'archived' ? true : props.conversation?.resumable;
  const nonResumableNative = Boolean(props.conversation && !legacy && !effectiveResumable);
  const pendingRequests = props.state?.pendingRequests.filter((request) => request.status === 'pending' && hasPendingRequestDetails(request)) ?? [];
  const pendingPlanImplementationRequests = props.state?.planImplementationRequests.filter((request) => request.status === 'pending').slice(-1) ?? [];
  const blockingPendingRequest = pendingRequests[0] ?? null;
  const blockingUserInputRequest = blockingPendingRequest && requestKind(blockingPendingRequest) === 'request_user_input' ? blockingPendingRequest : null;
  const blockingPlanImplementationRequest = blockingPendingRequest ? null : (pendingPlanImplementationRequests[0] ?? null);
  const blockingInteractionCount = pendingRequests.length + pendingPlanImplementationRequests.length;
  const planWorkspaceItem = planWorkspaceItemId ? (Object.values(props.state?.items ?? {}).find((item) => item.type === 'plan' && (item.localItemId === planWorkspaceItemId || item.itemId === planWorkspaceItemId)) ?? null) : null;
  const turnDiffChangeSet = contextWorkspace.kind === 'turn_diff' ? (props.state?.changeSetsByProviderId[contextWorkspace.turnId] ?? null) : null;
  const dockedPlan = props.state ? selectDockedTurnPlan(props.state) : null;

  useEffect(() => {
    contextReturnFocusRef.current = null;
    setComposerRuntimeSettings(readConversationNextTurnSettings(browserConversationStorage(), props.conversation?.projectId ?? '', props.conversation?.id ?? ''));
    lastNextTurnSettingsSyncRef.current = null;
    setContextWorkspace({ kind: 'none' });
    setContextFullWidth(false);
    browserMotionStopRef.current?.();
    browserMotionStopRef.current = null;
    browserVisibilityProgress.set(0);
    setContextMounted(false);
    setBrowserResizing(false);
    browserResizeActiveRef.current = false;
  }, [browserVisibilityProgress, props.conversation?.id]);

  useEffect(() => {
    if (!props.state || legacy || composerRuntimeSettings) return;
    const snapshotSettings = composerRuntimeSettingsFromState(props.state, props.capabilities);
    const projectId = props.state.projectId ?? props.conversation?.projectId;
    const conversationId = props.state.conversationId ?? props.conversation?.id;
    if (!snapshotSettings || !projectId || !conversationId) return;
    writeConversationNextTurnSettings(browserConversationStorage(), projectId, conversationId, snapshotSettings);
    setComposerRuntimeSettings(snapshotSettings);
  }, [composerRuntimeSettings, legacy, props.capabilities, props.state]);

  useEffect(() => {
    if (!props.state || legacy || interactionReadOnly || !composerRuntimeSettings || !actions.onNextTurnSettingsChange) return;
    const signature = JSON.stringify(composerRuntimeSettings);
    if (lastNextTurnSettingsSyncRef.current === signature) return;
    lastNextTurnSettingsSyncRef.current = signature;
    void Promise.resolve(actions.onNextTurnSettingsChange(composerRuntimeSettings)).catch(() => {
      if (lastNextTurnSettingsSyncRef.current === signature) lastNextTurnSettingsSyncRef.current = null;
    });
  }, [actions, composerRuntimeSettings, interactionReadOnly, legacy, props.state?.transportState]);

  function updateComposerRuntimeSettings(settings: ComposerRuntimeSettings): void {
    const projectId = props.state?.projectId ?? props.conversation?.projectId;
    const conversationId = props.state?.conversationId ?? props.conversation?.id;
    if (!props.state || !projectId || !conversationId || legacy || interactionReadOnly) return;
    writeConversationNextTurnSettings(browserConversationStorage(), projectId, conversationId, settings);
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
      if (event.type === 'open_requested' && event.conversationId === props.conversation?.id) {
        setContextFullWidth(false);
        setContextWorkspace({ kind: 'browser' });
      }
    });
  }, [props.conversation]);

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
    if (displayedHeader?.conversationId === currentHeader?.conversationId) return;
    if (sessionPrefersReducedMotion()) {
      setDisplayedHeader(currentHeader);
      setTitleMotion('entered');
      return;
    }
    setTitleMotion('exiting');
    const timer = setTimeout(() => {
      setDisplayedHeader(currentHeaderRef.current);
      setTitleMotion('entered');
    }, 180);
    return () => clearTimeout(timer);
  }, [currentHeader?.conversationId, displayedHeader?.conversationId]);

  useEffect(() => {
    if (displayedHeader?.conversationId === currentHeader?.conversationId) setDisplayedHeader(currentHeader);
  }, [currentHeader, displayedHeader?.conversationId]);

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
    setRequestErrors((current) => {
      const next = { ...current };
      delete next[request.id];
      return next;
    });
    try {
      await actions.onRespondToRequest(request.id, response);
    } catch (error) {
      setRequestErrors((current) => ({ ...current, [request.id]: error instanceof Error ? error.message : String(error) }));
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
    setRequestErrors((current) => {
      const next = { ...current };
      delete next[request.id];
      return next;
    });
    try {
      await actions.onRespondToPlanImplementationRequest(request.id, input);
    } catch (error) {
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
    contextReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const result = await actions.onOpenResource(resource, target, location);
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
    contextReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const result = await actions.onOpenTurnChangeFile(changeSet, file, line ? 'zeus_source' : 'preferred', line ? { line } : undefined);
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
    setContextWorkspace({ kind: 'none' });
    setContextFullWidth(false);
    const target = options.focusComposer ? composerRef.current : contextReturnFocusRef.current;
    contextReturnFocusRef.current = null;
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus();
      else composerRef.current?.focus();
    });
  }

  function renderConversationComposer(): ReactNode {
    if (!props.state) return null;
    return (
      <ConversationComposer
        textareaRef={composerRef}
        state={props.state}
        language={props.language}
        capabilities={props.capabilities}
        onDraftChange={(draft) => actions.onDraftChange?.(draft)}
        onSubmit={(delivery, settings) => actions.onSubmit?.(delivery, settings)}
        onInterrupt={(turnId) => actions.onInterrupt?.(turnId)}
        onChooseAttachments={actions.onChooseAttachments}
        onAddAttachments={actions.onAddAttachments}
        onRemoveAttachment={actions.onRemoveAttachment}
        onRemoveBrowserSubmission={actions.onRemoveBrowserSubmission}
        runtimeSettings={composerRuntimeSettings}
        onRuntimeSettingsChange={updateComposerRuntimeSettings}
        permissionMode={composerRuntimeSettings?.permissionMode ?? props.state.snapshot?.nextTurnSettings?.permissionMode ?? props.state.snapshot?.permissionMode ?? 'read-only'}
        collaborationMode={composerRuntimeSettings?.collaborationMode ?? props.state.snapshot?.nextTurnSettings?.collaborationMode ?? props.state.snapshot?.collaborationMode ?? 'default'}
      />
    );
  }

  function renderQueuedConversationMessages(): ReactNode {
    if (!props.state) return null;
    return (
      <QueuedConversationMessages
        state={props.state}
        language={props.language}
        onEdit={actions.onEditQueuedSubmission}
        onDelete={actions.onDeleteQueuedSubmission}
        onSendNow={actions.onSendQueuedNow}
        onReorder={actions.onReorderQueue}
        onResume={actions.onResumeQueue}
        onRetry={actions.onRestoreArchivedConversation}
      />
    );
  }

  return (
    <section
      className="session-workspace-root"
      aria-label={copy.workspace}
      data-transport-state={props.state?.transportState ?? props.loadState ?? 'empty'}
      data-conversation-state={props.state?.conversationState ?? (legacy ? 'legacy_readonly' : 'empty')}
      onKeyDownCapture={handleWorkspaceKeyDownCapture}
    >
      {displayedHeader ? (
        <header className="session-thread-header" data-motion-title={titleMotion}>
          <span className="session-thread-title-copy">
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
              {displayedHeader.taskManagementStatus ? (
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
            <span
              className={`session-thread-status session-thread-status-${displayedHeader.status.kind}`}
              role={displayedHeader.status.kind === 'error' ? 'alert' : 'status'}
              aria-live={displayedHeader.status.kind === 'error' ? 'assertive' : 'polite'}
            >
              <span className="session-status-symbol" aria-hidden="true" />
              <span>{displayedHeader.status.label}</span>
            </span>
            {!legacy && props.conversation && props.state ? (
              <SessionQuickActionsCard
                language={props.language}
                conversation={props.conversation}
                state={props.state}
                task={props.task}
                persistentHost={quickActionsPersistentHost}
                forceCollapsed={contextOpen || contextMounted}
                suppressed={props.quickActionsSuppressed}
                onLoadTaskWorkspaces={actions.onLoadTaskWorkspaces}
                onOpenTaskDetail={actions.onOpenTaskDetail}
                onOpenGitReview={actions.onOpenTaskGitReview}
                onOpenGitDelivery={actions.onOpenTaskGitDelivery}
                onAddSources={actions.onChooseAttachments}
                onOpenSource={(resource) => openConversationResource(resource, defaultOpenTarget(resource))}
              />
            ) : null}
          </div>
        </header>
      ) : null}

      {props.readOnlyGate ? (
        <section className="session-task-readonly-gate" role="note" aria-label={props.readOnlyGate.title}>
          <span>
            <strong>{props.readOnlyGate.title}</strong>
            <small>{props.readOnlyGate.description}</small>
            {props.readOnlyGate.error ? <em role="alert">{props.readOnlyGate.error}</em> : null}
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
            <p className="session-legacy-load-status session-legacy-load-error" role="alert">
              {props.loadError ?? copy.failed}
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
                {(props.state.transportState === 'hydrating' || props.state.transportState === 'connecting') && !props.state.snapshot ? <SessionLoading language={props.language} /> : null}
                {props.state.transportState === 'reconnecting' ? <SessionReconnectNotice language={props.language} attempt={props.state.reconnectAttempt} onReconnect={actions.onReconnect} /> : null}
                {props.state.transportState === 'failed' ? (
                  <section className="session-transport-failure" role="alert" data-retained-content={Boolean(props.state.snapshot) || undefined}>
                    <WarningCircle aria-hidden="true" weight="regular" />
                    <span className="session-transport-failure-copy">
                      <strong>{isServerBusyError(props.state.error) ? copy.serverBusy : copy.failed}</strong>
                      <p>{props.state.transportState === 'failed' && props.state.snapshot ? copy.refreshFailureHelp : isServerBusyError(props.state.error) ? copy.serverBusyHelp : (props.state.error?.message ?? copy.failureHelp)}</p>
                      {errorMessage(props.state.error) || props.loadError ? (
                        <details className="session-error-details">
                          <summary>{copy.details}</summary>
                          <p>{errorMessage(props.state.error) ?? props.loadError}</p>
                        </details>
                      ) : null}
                    </span>
                    {actions.onReconnect ? (
                      <button type="button" onClick={() => void actions.onReconnect?.()}>
                        {copy.retry}
                      </button>
                    ) : null}
                  </section>
                ) : null}
                <div ref={setQuickActionsPersistentHost} className="session-quick-actions-persistent-host" />
                <ConversationTranscript
                  state={props.state}
                  language={props.language}
                  onEditUserItem={interactionReadOnly ? undefined : actions.onEditUserItem}
                  onRetryItem={interactionReadOnly ? undefined : actions.onRetryItem}
                  openPlanItemId={planWorkspaceItemId}
                  onOpenPlan={(item) => {
                    contextReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                    setContextFullWidth(false);
                    setContextWorkspace({ kind: 'plan', itemId: item.localItemId ?? item.itemId });
                  }}
                  onOpenResource={openConversationResource}
                  onLoadResourcePreview={actions.onLoadResourcePreview}
                  onReviewTurnChanges={(changeSet, fileId) => {
                    contextReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                    setContextFullWidth(false);
                    setContextWorkspace({
                      kind: 'turn_diff',
                      turnId: changeSet.providerTurnId,
                      ...(fileId ? { initialFileId: fileId } : {}),
                    });
                  }}
                  onOperateTurnChangeSet={!interactionReadOnly && actions.onOperateTurnChangeSet ? operateTurnChangeSet : undefined}
                />
                {props.suppressComposer || !dockedPlan ? null : <SessionPlanProgress plan={dockedPlan} language={props.language} />}
                {props.suppressComposer ? null : blockingPendingRequest ? (
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
                    />
                    {renderQueuedConversationMessages()}
                  </section>
                ) : blockingPlanImplementationRequest ? (
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
                    {renderQueuedConversationMessages()}
                  </section>
                ) : null}
                {props.suppressComposer || blockingUserInputRequest ? null : (
                  <>
                    {renderQueuedConversationMessages()}
                    {renderConversationComposer()}
                  </>
                )}
                {props.creationStatus ? (
                  <section className={`session-creation-status is-${props.creationStatus.state}`} role={props.creationStatus.state === 'failed' ? 'alert' : 'status'} aria-live="polite">
                    {props.creationStatus.state === 'creating' ? <span className="session-command-spinner" aria-hidden="true" /> : <WarningCircle aria-hidden="true" weight="regular" />}
                    <span>
                      <strong>{props.creationStatus.message}</strong>
                      {props.creationStatus.error ? <small>{props.creationStatus.error}</small> : null}
                    </span>
                    {props.creationStatus.state === 'failed' && props.creationStatus.onRetry ? (
                      <button type="button" onClick={() => void props.creationStatus?.onRetry?.()}>
                        {props.creationStatus.retryLabel ?? (props.language === 'zh-CN' ? '重试' : 'Retry')}
                      </button>
                    ) : null}
                  </section>
                ) : null}
                {interruptArmed ? (
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
                    aria-label={props.language === 'zh-CN' ? '调整会话与浏览器宽度' : 'Resize conversation and browser'}
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
                        conversationId={props.conversation.id}
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
                    {contextWorkspace.kind === 'plan' && planWorkspaceItem ? (
                      <PlanWorkspace item={planWorkspaceItem} language={props.language} fullWidth={contextFullWidth} onFullWidthChange={setContextFullWidth} onClose={closeContextWorkspace} />
                    ) : null}
                    {contextWorkspace.kind === 'source' ? (
                      <SourceWorkspace preview={contextWorkspace.preview} language={props.language} fullWidth={contextFullWidth} onFullWidthChange={setContextFullWidth} onClose={closeContextWorkspace} />
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
                      />
                    ) : null}
                  </div>
                </motion.aside>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <NewConversationComposer
          language={props.language}
          owner={owner}
          task={props.task}
          autoFocus={props.autoFocusNewConversation}
          loadState={props.loadState}
          loadError={props.loadError}
          capabilities={props.capabilities}
          onStartTask={actions.onStartConversation}
          onStartProject={actions.onStartProjectConversation}
          onLoadCapabilities={actions.onLoadCapabilities}
          onChooseAttachments={actions.onChooseStartAttachments}
        />
      )}
    </section>
  );
}

export function selectDockedTurnPlan(state: NativeSessionState): NativeSessionState['turnsByProviderId'][string]['plan'] {
  if (!state.activeTurnId) return null;
  return state.turnsByProviderId[state.activeTurnId]?.plan ?? null;
}

function contextWorkspaceLabel(workspace: SessionContextWorkspace, language: SessionUiLanguage): string {
  const zh = language === 'zh-CN';
  if (workspace.kind === 'browser') return zh ? '会话浏览器' : 'Conversation browser';
  if (workspace.kind === 'plan') return zh ? '计划工作区' : 'Plan workspace';
  if (workspace.kind === 'source') return zh ? '源码预览' : 'Source preview';
  if (workspace.kind === 'turn_diff') return zh ? '变更审核' : 'Change review';
  return zh ? '会话上下文工作区' : 'Conversation context workspace';
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
  const prefix = `request:respond:${requestId}`;
  return operation === prefix || operation?.startsWith(`${prefix}:`) === true;
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
  onChooseAttachments?: SessionWorkspaceActions['onChooseStartAttachments'];
  onAccepted?: () => void | Promise<void>;
}) {
  const copy = labels[props.language];
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [content, setContent] = useState(() => props.initialContent ?? '');
  const [attachments, setAttachments] = useState<NativeConversationAttachment[]>(() => [...(props.initialAttachments ?? [])]);
  const [permissionMode, setPermissionMode] = useState<NativePermissionMode>('auto');
  const [collaborationMode, setCollaborationMode] = useState<NativeCollaborationMode>('default');
  const [capabilities, setCapabilities] = useState<CodexConversationCapabilities | null>(props.capabilities ?? null);
  const [serviceTierSelection, setServiceTierSelection] = useState<NativeServiceTierSelection>(() => readProjectServiceTierPreference(browserConversationStorage(), props.owner?.projectId ?? ''));
  const [serviceTierDowngraded, setServiceTierDowngraded] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputResources = useConversationInputResources({
    textareaRef,
    text: content,
    disabled: submitting || !props.owner,
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

  useEffect(() => {
    if (props.autoFocus) textareaRef.current?.focus();
  }, [props.autoFocus]);

  useEffect(() => {
    const projectId = props.owner?.projectId;
    if (!projectId) return;
    setServiceTierSelection(readProjectServiceTierPreference(browserConversationStorage(), projectId));
    setServiceTierDowngraded(false);
    if (props.capabilities) {
      setCapabilities(props.capabilities);
      return;
    }
    let active = true;
    void props
      .onLoadCapabilities?.(projectId)
      .then((snapshot) => {
        if (active && snapshot) setCapabilities(snapshot);
      })
      .catch((error: unknown) => {
        if (active) setLocalError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [props.capabilities, props.onLoadCapabilities, props.owner?.projectId]);

  const selectedModel = capabilities?.models.find((model) => model.model === capabilities.preferredModel || model.id === capabilities.preferredModel) ?? capabilities?.models[0] ?? null;

  useEffect(() => {
    if (!selectedModel) return;
    const normalized = normalizeServiceTierSelection(serviceTierSelection, selectedModel);
    if (!normalized.downgraded) return;
    setServiceTierSelection(normalized.selection);
    setServiceTierDowngraded(true);
  }, [selectedModel, serviceTierSelection]);

  useLayoutEffect(() => {
    if (textareaRef.current) autosizeTextarea(textareaRef.current);
  }, [content]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const view = textarea?.ownerDocument.defaultView;
    if (!textarea || !view) return;
    const resize = () => autosizeTextarea(textarea);
    view.addEventListener('resize', resize);
    return () => view.removeEventListener('resize', resize);
  }, []);

  async function submit(): Promise<void> {
    if (!props.owner || submitting || (!content.trim() && attachments.length === 0)) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      let accepted: void | boolean;
      if (props.owner.kind === 'project') {
        if (!props.onStartProject) throw new Error('Project conversation start is unavailable.');
        accepted = await props.onStartProject({ owner: props.owner, content, attachments, permissionMode, collaborationMode, serviceTierSelection });
      } else {
        if (!props.task || !props.onStartTask) throw new Error('Task conversation start is unavailable.');
        accepted = await props.onStartTask({
          mode: 'create',
          task: props.task,
          ...(props.inheritConversationId ? { inheritConversationId: props.inheritConversationId } : {}),
          content,
          attachments,
          permissionMode,
          collaborationMode,
          serviceTierSelection,
        });
      }
      if (accepted === false) return;
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
      aria-busy={submitting || inputResources.processing || undefined}
      data-resource-dragging={inputResources.dragging ? 'true' : 'false'}
      onDragEnter={inputResources.handleDragEnter}
      onDragOver={inputResources.handleDragOver}
      onDragLeave={inputResources.handleDragLeave}
      onDrop={inputResources.handleDrop}
    >
      {localError || (props.loadState === 'error' && props.loadError) ? (
        <p className="session-new-conversation-error" role="alert">
          {localError ?? props.loadError}
        </p>
      ) : null}
      <ConversationComposerAttachments
        attachments={attachments}
        language={props.language}
        disabled={submitting || inputResources.processing}
        onRemove={(attachment) => setAttachments((current) => current.filter((candidate) => candidate !== attachment))}
        onRestorePastedText={inputResources.restorePastedText}
      />
      <div className="session-composer-input-frame">
        <textarea
          ref={textareaRef}
          aria-label={copy.newInput}
          aria-keyshortcuts="Enter Shift+Enter"
          autoFocus={props.autoFocus}
          placeholder={copy.newPlaceholder}
          value={content}
          disabled={submitting || !props.owner}
          onChange={(event) => setContent(event.currentTarget.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onPaste={inputResources.handlePaste}
          onKeyDown={(event) => {
            inputResources.handlePasteShortcut(event);
            const intent = resolveComposerKeyIntent({ key: event.key, shiftKey: event.shiftKey, isComposing: isComposing || event.nativeEvent.isComposing, repeat: event.repeat });
            if (intent !== 'submit') return;
            event.preventDefault();
            void submit();
          }}
        />
        <div className="session-composer-command-row">
          <span className="session-composer-leading-actions">
            {props.onChooseAttachments ? (
              <button
                type="button"
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
                <span aria-hidden="true">＋</span>
              </button>
            ) : null}
            <ComposerDropdown
              label={props.language === 'zh-CN' ? '服务档位' : 'Service tier'}
              value={serviceTierSelectionValue(serviceTierSelection)}
              options={serviceTierOptions(selectedModel, props.language, true)}
              disabled={submitting || !props.owner}
              onChange={(value) => {
                setServiceTierSelection(serviceTierSelectionFromValue(value));
                setServiceTierDowngraded(false);
              }}
            />
            <PermissionModeControl language={props.language} value={permissionMode} disabled={submitting || !props.owner} onChange={setPermissionMode} />
            <CollaborationModeControl language={props.language} value={collaborationMode} disabled={submitting || !props.owner} onChange={setCollaborationMode} />
          </span>
          <span className="session-composer-trailing-actions">
            <span className="session-primary-command-slot" data-primary-command-slot="true">
              <button
                type="button"
                className="session-send-button"
                aria-label={copy.send}
                onClick={() => void submit()}
                disabled={submitting || inputResources.processing || !props.owner || (!content.trim() && attachments.length === 0)}
                aria-busy={submitting || undefined}
              >
                {submitting ? <span className="session-command-spinner" aria-hidden="true" /> : <span aria-hidden="true">↑</span>}
              </button>
            </span>
          </span>
        </div>
        <small className="session-service-tier-note" role={serviceTierDowngraded ? 'status' : undefined}>
          {serviceTierDowngraded
            ? props.language === 'zh-CN'
              ? '当前模型不支持原 Fast 档位，已切换为标准。'
              : 'The current model does not support the previous Fast tier. Standard is selected.'
            : serviceTierDescription(serviceTierSelection, selectedModel, props.language)}
        </small>
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

function composerRuntimeSettingsFromState(state: NativeSessionState, capabilities: CodexConversationCapabilities | null | undefined): ComposerRuntimeSettings | null {
  const source = state.snapshot?.nextTurnSettings;
  const requestedModel = source?.model ?? state.providerSettings?.model;
  if (!requestedModel) return null;
  const capability =
    capabilities?.models.find((candidate) => candidate.model === requestedModel || candidate.id === requestedModel) ??
    capabilities?.models.find((candidate) => candidate.model === capabilities.preferredModel || candidate.id === capabilities.preferredModel);
  const model = capability?.model ?? requestedModel;
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
    permissionMode: source?.permissionMode ?? state.snapshot?.permissionMode ?? 'read-only',
    collaborationMode: source?.collaborationMode ?? state.snapshot?.collaborationMode ?? 'default',
  };
}

function mergeConversationAttachments(current: NativeConversationAttachment[], added: NativeConversationAttachment[]): NativeConversationAttachment[] {
  const byIdentity = new Map(current.map((attachment) => [conversationAttachmentIdentity(attachment), attachment]));
  added.forEach((attachment) => byIdentity.set(conversationAttachmentIdentity(attachment), attachment));
  return [...byIdentity.values()];
}

function SessionLoading(props: { language: SessionUiLanguage }) {
  const copy = labels[props.language];
  return (
    <section className="session-loading" role="status" aria-live="polite">
      <span className="session-loading-line" />
      <span className="session-loading-line" />
      <strong>{copy.loading}</strong>
    </section>
  );
}

function SessionReconnectNotice(props: { language: SessionUiLanguage; attempt: number; onReconnect?: () => void | Promise<void> }) {
  const delay = reconnectDelayMs(props.attempt);
  const delayLabel = delay < 1_000 ? `${delay} ms` : `${delay / 1_000} s`;
  return (
    <section className="session-reconnect-notice" role="status" aria-live="polite" aria-atomic="true">
      <ArrowsClockwise aria-hidden="true" weight="regular" />
      <span>
        <strong>{labels[props.language].reconnectingAttempt(props.attempt)}</strong>
        <small>{props.language === 'zh-CN' ? `自动重试会持续进行；下次约 ${delayLabel} 后，历史记录仍可查看。` : `Automatic retries continue; next attempt in about ${delayLabel}. History remains available.`}</small>
      </span>
      {props.onReconnect ? (
        <button type="button" onClick={() => void props.onReconnect?.()}>
          {props.language === 'zh-CN' ? '立即重试' : 'Retry now'}
        </button>
      ) : null}
    </section>
  );
}

function SessionRuntimeDetails(props: { state: NativeSessionState; conversation: NativeConversationChoice | null; language: SessionUiLanguage; capabilities?: CodexConversationCapabilities | null }) {
  const copy = labels[props.language];
  const model = props.state.providerSettings?.model?.trim() || copy.unsynced;
  const effort = props.state.providerSettings?.effort?.trim() || copy.unsynced;
  const rawServiceTier = props.state.providerSettings?.serviceTier;
  const hasServiceTier = Boolean(props.state.providerSettings && Object.prototype.hasOwnProperty.call(props.state.providerSettings, 'serviceTier'));
  const serviceTier = !hasServiceTier
    ? copy.unsynced
    : !rawServiceTier || rawServiceTier === 'default'
      ? props.language === 'zh-CN'
        ? '标准'
        : 'Standard'
      : (props.capabilities?.models.flatMap((candidate) => candidate.serviceTiers).find((tier) => tier.id === rawServiceTier)?.name ?? rawServiceTier);
  const usage = props.state.tokenUsage;
  const mcpStartup = props.state.mcpStartup?.value ?? null;
  const warning = runtimeValueNeedsAttention(mcpStartup);
  const modelLabel = [model, effort, serviceTier].join(' · ');
  const executionContext = props.state.snapshot?.executionContext;
  const executionCwd = executionContext?.cwd ?? copy.unavailable;
  const executionBranch = executionContext?.cwd ? (executionContext.branch ?? copy.nonGitDirectory) : copy.unavailable;
  const nativeSession = props.state.snapshot?.nativeSession ?? props.conversation?.nativeSession;
  const nativeSessionId = nativeSession?.id ?? props.state.providerThreadId ?? props.conversation?.providerThreadId ?? copy.unavailable;
  const nativeSessionPath = nativeSession?.path ?? copy.unavailable;
  return (
    <details className="session-runtime-details" data-severity={warning ? 'warning' : 'ready'} aria-label={copy.runtimeDetails}>
      <summary>
        <span className="session-runtime-summary-primary">
          {usage ? <TokenUsageValue count={usage.total.totalTokens} label="tokens" language={props.language} /> : <span>{copy.unavailable}</span>}
          <span>
            {copy.cacheHitRate} {formatPercentage(usage?.cacheHitRate ?? null, props.language)}
          </span>
        </span>
      </summary>
      <dl>
        {modelLabel ? (
          <div>
            <dt>{copy.model}</dt>
            <dd>{modelLabel}</dd>
          </div>
        ) : null}
        {usage ? (
          <>
            <RuntimeUsageRow label={copy.usage} value={<TokenUsageValue count={usage.total.totalTokens} label="tokens" language={props.language} />} />
            <RuntimeUsageRow label={props.language === 'zh-CN' ? '输入' : 'Input'} value={<TokenUsageValue count={usage.total.inputTokens} label="in" language={props.language} />} />
            <RuntimeUsageRow label={copy.cacheRead} value={<TokenUsageValue count={usage.total.cachedInputTokens} label="tokens" language={props.language} />} />
            <RuntimeUsageRow label={copy.cacheWrite} value={<TokenUsageValue count={usage.total.cacheWriteInputTokens} label="tokens" language={props.language} />} />
            <RuntimeUsageRow label={props.language === 'zh-CN' ? '输出' : 'Output'} value={<TokenUsageValue count={usage.total.outputTokens} label="out" language={props.language} />} />
            <RuntimeUsageRow label={copy.reasoningOutput} value={<TokenUsageValue count={usage.total.reasoningOutputTokens} label="tokens" language={props.language} />} />
            <RuntimeUsageRow label={copy.cacheHitRate} value={formatPercentage(usage.cacheHitRate, props.language)} />
            <RuntimeUsageRow
              label={copy.contextUsage}
              value={
                usage.modelContextWindow
                  ? `${formatPercentage(usage.last.inputTokens / usage.modelContextWindow, props.language)} · ${formatTokenCount(usage.last.inputTokens, props.language).exact} / ${formatTokenCount(usage.modelContextWindow, props.language).exact}`
                  : copy.unavailable
              }
            />
            <RuntimeUsageRow label={copy.estimatedCredits} value={formatEstimatedCost(usage.estimatedCredits, 'Credits', props.language)} />
            <RuntimeUsageRow label={copy.apiEquivalentUsd} value={formatEstimatedCost(usage.apiEquivalentUsd, 'USD', props.language)} />
            <RuntimeUsageRow label={copy.priceCoverage} value={formatPercentage(usage.priceCoverage, props.language)} />
            <RuntimeUsageRow
              label={copy.priceSource}
              value={
                usage.pricingCatalogDate ? (
                  usage.pricingSourceUrls[0] ? (
                    <a href={usage.pricingSourceUrls[0]} target="_blank" rel="noreferrer">
                      {usage.pricingCatalogDate}
                    </a>
                  ) : (
                    usage.pricingCatalogDate
                  )
                ) : (
                  copy.unavailable
                )
              }
            />
            {!usage.historyComplete ? <RuntimeUsageRow label={props.language === 'zh-CN' ? '历史口径' : 'History'} value={copy.collectionNotice} /> : null}
          </>
        ) : null}
        {executionContext ? <RuntimeUsageRow label={copy.cwd} value={<code title={executionCwd}>{executionCwd}</code>} /> : null}
        {executionContext ? <RuntimeUsageRow label={copy.branch} value={<code title={executionBranch}>{executionBranch}</code>} /> : null}
        {nativeSession?.id || props.state.providerThreadId || props.conversation?.providerThreadId ? <RuntimeUsageRow label={copy.sessionId} value={<code title={nativeSessionId}>{nativeSessionId}</code>} /> : null}
        {nativeSession?.path ? <RuntimeUsageRow label={copy.jsonlPath} value={<code title={nativeSessionPath}>{nativeSessionPath}</code>} /> : null}
        {mcpStartup ? (
          <div>
            <dt>{copy.mcpStartup}</dt>
            <dd>{runtimeValueSummary(mcpStartup)}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

function RuntimeUsageRow(props: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function formatPercentage(value: number | null, language: SessionUiLanguage): string {
  if (value === null || !Number.isFinite(value)) return labels[language].unavailable;
  return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, value));
}

function formatEstimatedCost(value: number | null, unit: 'Credits' | 'USD', language: SessionUiLanguage): string {
  if (value === null || !Number.isFinite(value)) return labels[language].unavailable;
  const formatted = new Intl.NumberFormat(language, { minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: 6 }).format(value);
  return unit === 'USD' ? `~$${formatted}` : `~${formatted} Credits`;
}

function runtimeValueNeedsAttention(value: unknown, key = ''): boolean {
  if (typeof value === 'number') return /remaining|available|balance/i.test(key) && value <= 0;
  if (typeof value === 'string') return /^(error|failed|degraded|unavailable|blocked|exhausted)$/i.test(value.trim());
  if (Array.isArray(value)) return value.some((entry) => runtimeValueNeedsAttention(entry, key));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([entryKey, entryValue]) => runtimeValueNeedsAttention(entryValue, entryKey));
}

function runtimeValueSummary(value: Record<string, unknown>): string {
  return runtimeValueFragments(value).join(' · ');
}

function runtimeValueFragments(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => runtimeValueFragments(entry, [...path, String(index + 1)]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => runtimeValueFragments(entry, [...path, key]));
  if (value === null || value === undefined) return [];
  const rawLabel = path.map(humanizeRuntimeKey).join(' ');
  const label = rawLabel ? `${rawLabel.charAt(0).toUpperCase()}${rawLabel.slice(1)}` : 'Value';
  return [`${label}: ${String(value)}`];
}

function humanizeRuntimeKey(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
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

function sessionStatus(state: NativeSessionState | null, loadState: SessionWorkspaceProps['loadState'], copy: (typeof labels)[SessionUiLanguage]): SessionWorkspaceStatus {
  if (!state) {
    if (loadState === 'loading') return { kind: 'busy', label: copy.loading };
    if (loadState === 'error') return { kind: 'error', label: copy.failed };
    return { kind: 'ready', label: copy.ready };
  }
  if (state.transportState === 'connecting' || state.transportState === 'hydrating')
    return {
      kind: 'busy',
      label: state.snapshot ? copy.refreshing : copy.loading,
    };
  if (state.transportState === 'reconnecting')
    return {
      kind: 'warning',
      label: copy.reconnectingAttempt(state.reconnectAttempt),
    };
  if (state.transportState === 'failed')
    return {
      kind: 'error',
      label: isServerBusyError(state.error) ? copy.serverBusy : copy.failed,
    };
  if ((state.snapshot?.providerState === 'archived' || (state.queue?.state.type === 'paused' && state.queue.state.reason === 'provider_archived')) && (state.queue?.submissions.length ?? 0) > 0)
    return {
      kind: 'busy',
      label: copy.queued,
    };
  switch (state.conversationState) {
    case 'native_loading':
      return { kind: 'busy', label: copy.loading };
    case 'native_idle':
      return { kind: 'ready', label: copy.ready };
    case 'starting_turn':
      return { kind: 'busy', label: copy.starting };
    case 'active_prework':
      return { kind: 'busy', label: copy.working };
    case 'active_final_answer':
      return { kind: 'busy', label: copy.answering };
    case 'waiting_approval':
      return { kind: 'warning', label: copy.approval };
    case 'waiting_user_input':
      return { kind: 'warning', label: copy.input };
    case 'interrupt_confirm':
      return { kind: 'warning', label: copy.interruptConfirm };
    case 'interrupting':
      return { kind: 'busy', label: copy.interrupting };
    case 'turn_failed':
      return { kind: 'error', label: errorMessage(state.error) ?? copy.turnFailed };
    case 'legacy_readonly':
      return { kind: 'warning', label: copy.legacyTranscript };
  }
}

function errorMessage(error: NativeSessionState['error']): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : error.message;
}

function isServerBusyError(error: NativeSessionState['error']): boolean {
  return error?.status === 429 || /^(RATE_LIMITED|SERVER_BUSY|TOO_MANY_REQUESTS)$/i.test(error?.code ?? '');
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
