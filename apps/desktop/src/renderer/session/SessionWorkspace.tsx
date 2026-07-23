import {type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState} from 'react';
import {ArrowsClockwiseIcon as ArrowsClockwise} from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import {WarningCircleIcon as WarningCircle} from '@phosphor-icons/react/dist/csr/WarningCircle';
import {canSteerActiveTurn, ConversationComposer, resolveComposerKeyIntent} from './ConversationComposer.js';
import {ConversationTranscript} from './ConversationTranscript.js';
import {SessionPlanProgress} from './SessionActivity.js';
import {LegacyConversationBanner} from './LegacyConversationBanner.js';
import {PendingRequestSurface, requestKind} from './PendingRequestSurface.js';
import {PermissionModeControl} from './PermissionModeControl.js';
import {CollaborationModeControl} from './CollaborationModeControl.js';
import {PlanImplementationRequestSurface} from './PlanImplementationRequestSurface.js';
import {PlanWorkspace} from './PlanWorkspace.js';
import type {
    CodexConversationCapabilities,
    NativeCollaborationMode,
    NativeConversationAttachment,
    NativeConversationChoice,
    NativeOperationAcceptance,
    NativePendingRequest,
    NativePermissionMode,
    NativePlanImplementationRequest,
    NativeSessionItemBuffer,
    NativeSessionState,
    NativeTurnSettingsSelection,
    SessionConversationOwner,
    StartNativeConversationRequest,
    StartProjectConversationRequest,
} from './sessionTypes.js';
import {
    reconnectDelayMs,
    type SessionController,
    type SessionControllerClient,
    useSessionController
} from './useSessionController.js';
import {
    createSessionEscapeController,
    type SessionEscapeController,
    type SessionEscapeLayer,
    type SessionEscapeResult
} from './useThreadScrollController.js';
import {SafeMarkdown, type SessionUiLanguage} from './ThreadItemView.js';

export interface SessionWorkspaceTask {
  id: string;
  projectId: string;
  title: string;
}

export type SessionStartMode = 'create' | 'resume' | 'reference_legacy';

export interface SessionWorkspaceStartInput {
  mode: SessionStartMode;
  task: SessionWorkspaceTask;
  conversation?: NativeConversationChoice;
  legacyMessageIds?: string[];
  content: string;
  attachments?: NativeConversationAttachment[];
  permissionMode: NativePermissionMode;
    collaborationMode: NativeCollaborationMode;
}

export interface ProjectSessionWorkspaceStartInput {
  owner: Extract<SessionConversationOwner, { kind: 'project' }>;
  content: string;
  attachments: NativeConversationAttachment[];
  permissionMode: NativePermissionMode;
    collaborationMode: NativeCollaborationMode;
}

export interface SessionWorkspaceActions {
  onStartConversation?: (input: SessionWorkspaceStartInput) => void | Promise<void>;
  onStartProjectConversation?: (input: ProjectSessionWorkspaceStartInput) => void | Promise<void>;
  onReconnect?: () => void | Promise<void>;
  onDraftChange?: (draft: string) => void;
    onSubmit?: (delivery: 'queue' | 'steer_now', settings?: NativeTurnSettingsSelection) => void | Promise<void>;
  onInterrupt?: (turnId: string) => void | Promise<void>;
  onChooseAttachments?: () => void | Promise<void>;
  onChooseStartAttachments?: () => Promise<NativeConversationAttachment[]>;
  onRemoveAttachment?: (attachment: NativeConversationAttachment) => void;
  onEditQueuedSubmission?: (submissionId: string, content: string) => void | Promise<void>;
  onDeleteQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  onSendQueuedNow?: (submissionId: string) => void | Promise<void>;
  onReorderQueue?: (orderedSubmissionIds: string[]) => void | Promise<void>;
  onResumeQueue?: () => void | Promise<void>;
    onRestoreArchivedConversation?: () => void | Promise<void>;
  onRespondToRequest?: (requestId: string, response: Record<string, unknown>) => void | Promise<void>;
    onEditUserItem?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  onRetryItem?: (item: NativeSessionItemBuffer) => void;
  onSelectTask?: (task: SessionWorkspaceTask) => void;
  onOpenImportSettings?: (conversation: NativeConversationChoice) => void;
  onPermissionModeChange?: (permissionMode: NativePermissionMode) => void | Promise<void>;
    onCollaborationModeChange?: (collaborationMode: NativeCollaborationMode) => void | Promise<void>;
    onRespondToPlanImplementationRequest?: (requestId: string, input: {
        action: 'implement' | 'refine' | 'dismiss';
        feedback?: string
    }) => void | Promise<void>;
    onSnoozeRequest?: (requestId: string) => void | Promise<void>;
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
    permissionMode: NativePermissionMode;
    collaborationMode: NativeCollaborationMode
}
    | { mode: 'resume'; conversationId: string; content: string; collaborationMode: NativeCollaborationMode }
    | {
    mode: 'reference_legacy';
    sourceConversationId: string;
    messageIds: string[];
    content: string;
    permissionMode: NativePermissionMode;
    collaborationMode: NativeCollaborationMode
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
    initialOptimisticState?: NativeSessionState;
  onStartConversation?: SessionWorkspaceActions['onStartConversation'];
  onStartProjectConversation?: SessionWorkspaceActions['onStartProjectConversation'];
}

export function ConnectedSessionWorkspace(props: ConnectedSessionWorkspaceProps) {
    // 每个 conversation 由父层 key 隔离；初始乐观状态只在 controller 创建时接管一次，
    // 后续即使父层清理 task-push pending，也不能重建 controller 或闪断真实 transcript。
    const initialOptimisticState = useRef(props.initialOptimisticState).current;
    const {state, controller} = useSessionController({
        client: props.client,
        projectId: props.conversation.projectId,
        conversationId: props.conversation.id,
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
      suppressComposer={!state.snapshot}
      capabilities={capabilities}
      actions={{
        ...createConnectedSessionActions({ controller, state, onChooseAttachments: props.onChooseAttachments }),
        onStartConversation: props.onStartConversation,
        onStartProjectConversation: props.onStartProjectConversation,
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
  const recoveryRequired = input.state.error?.recoveryRequired === true;
  const settle = async (operation: Promise<unknown>): Promise<void> => {
    try {
      await operation;
    } catch {
      // 控制器已把失败写回 typed state；组件只避免产生未处理的 Promise rejection。
    }
  };
  return {
    onReconnect: () => (recoveryRequired ? Promise.resolve() : settle(input.controller.reconnect())),
    onDraftChange: input.controller.setDraft,
      onSubmit: (delivery, settings) => {
      if (recoveryRequired) return Promise.resolve();
      const effectiveDelivery = delivery === 'steer_now' && canSteerActiveTurn(input.state) ? 'steer_now' : 'queue';
          return settle(input.controller.send(effectiveDelivery, effectiveDelivery === 'steer_now' ? (input.state.activeTurnId ?? undefined) : undefined, effectiveDelivery === 'queue' ? settings : undefined));
    },
    onInterrupt: () => (recoveryRequired ? Promise.resolve() : settle(input.controller.interruptActiveTurn())),
    ...(input.onChooseAttachments
      ? {
          onChooseAttachments: async () => {
            const attachments = await input.onChooseAttachments?.();
            if (attachments?.length) input.controller.setAttachments([...input.state.attachments, ...attachments]);
          },
        }
      : {}),
    onRemoveAttachment: (attachment) => input.controller.setAttachments(input.state.attachments.filter((candidate) => candidate !== attachment)),
    // 编辑器只有在服务端确认后才退出；失败必须向组件传播以保留用户草稿。
    onEditQueuedSubmission: async (submissionId, content) => {
      if (recoveryRequired) return;
      await input.controller.editQueuedSubmission(submissionId, content);
    },
    onDeleteQueuedSubmission: (submissionId) => (recoveryRequired ? Promise.resolve() : settle(input.controller.deleteQueuedSubmission(submissionId))),
    onSendQueuedNow: (submissionId) => (recoveryRequired ? Promise.resolve() : settle(input.controller.sendQueuedNow(submissionId))),
    onReorderQueue: (orderedSubmissionIds) => (recoveryRequired ? Promise.resolve() : settle(input.controller.reorderQueue(orderedSubmissionIds))),
    onResumeQueue: () => (recoveryRequired ? Promise.resolve() : settle(input.controller.resumeQueue())),
      onRestoreArchivedConversation: () => (recoveryRequired ? Promise.resolve() : settle(input.controller.restoreArchivedConversation())),
    onRespondToRequest: (requestId, response) => (recoveryRequired ? Promise.resolve() : input.controller.respondToRequest(requestId, response).then(() => undefined)),
      onRespondToPlanImplementationRequest: (requestId, response) => (recoveryRequired ? Promise.resolve() : input.controller.respondToPlanImplementationRequest(requestId, response)),
      onSnoozeRequest: (requestId) => (recoveryRequired ? Promise.resolve() : input.controller.snoozeRequest(requestId).then(() => undefined)),
    onPermissionModeChange: (permissionMode) => (recoveryRequired ? Promise.resolve() : settle(input.controller.setPermissionMode(permissionMode))),
      onCollaborationModeChange: (collaborationMode) => (recoveryRequired ? Promise.resolve() : settle(input.controller.setCollaborationMode(collaborationMode))),
      onEditUserItem: async (_item, content) => {
          const current = input.controller.getState();
          const active = current.conversationState === 'active_prework' || current.conversationState === 'active_final_answer';
          if (current.error?.recoveryRequired || current.transportState !== 'ready' || (!active && current.conversationState !== 'native_idle')) {
              throw new Error('Conversation is not writable.');
          }
          input.controller.setDraft(content);
          const settings = current.providerSettings?.model
              ? {
                  model: current.providerSettings.model,
                  ...(current.providerSettings.effort ? {effort: current.providerSettings.effort} : {}),
                  collaborationMode: current.snapshot?.collaborationMode ?? 'default',
              }
              : undefined;
          await input.controller.send('queue', undefined, settings);
      },
  };
}

export function buildStartNativeConversationRequest(input: SessionWorkspaceStartInput, createId: () => string): StartNativeConversationRequest {
  return { ...buildStartNativeConversationPayload(input), idempotencyKey: createId(), clientUserMessageId: createId() } as StartNativeConversationRequest;
}

/** Converts a durable start acceptance into a selectable row before any best-effort history refresh. */
export function nativeConversationChoiceFromAcceptance(acceptance: NativeOperationAcceptance, task: SessionWorkspaceTask, now = new Date().toISOString()): NativeConversationChoice {
  const conversation = acceptance.conversation;
  const provider = isRecord(conversation.provider) ? conversation.provider : {};
  return {
    id: acceptance.conversation.id,
    projectId: stringField(conversation.projectId) ?? task.projectId,
    taskId: stringField(conversation.taskId) ?? task.id,
    title: stringField(conversation.title) ?? task.title,
    summary: nullableStringField(conversation.summary),
    status: stringField(conversation.status) ?? 'active',
    transportKind: stringField(conversation.transportKind) ?? 'codex_native',
    providerId: stringField(conversation.providerId) ?? stringField(provider.id) ?? 'codex',
    providerThreadId: stringField(conversation.providerThreadId) ?? stringField(provider.threadId),
    providerModel: stringField(conversation.providerModel) ?? stringField(provider.model),
    providerState: stringField(conversation.providerState) ?? stringField(provider.state),
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
}): Promise<{ choice: NativeConversationChoice; refreshResult: T | null; refreshError: unknown | null }> {
  const request = options.envelopeManager.prepare(options.input);
  const acceptance = await options.dispatch(options.input.task.id, request);
  if (!isDurableNativeConversationAcceptance(request, acceptance)) throw new Error('Native conversation start did not return a durable accepted operation.');
  options.envelopeManager.clearAccepted(options.input, request, acceptance);
  const choice = nativeConversationChoiceFromAcceptance(acceptance, options.input.task);
  // acceptance 导航属于 durable 边界，必须先于摘要刷新发生。
  await options.onAccepted(choice);
  try {
    return { choice, refreshResult: await options.refresh(options.input.task.id), refreshError: null };
  } catch (refreshError) {
    return { choice, refreshResult: null, refreshError };
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
  return {
    id: conversation.id,
    projectId: stringField(conversation.projectId) ?? owner.projectId,
    taskId: null,
    title: stringField(conversation.title) ?? owner.projectName,
    summary: nullableStringField(conversation.summary),
    status: stringField(conversation.status) ?? 'active',
    transportKind: stringField(conversation.transportKind) ?? 'codex_native',
    providerId: stringField(conversation.providerId) ?? stringField(provider.id) ?? 'codex',
    providerThreadId: stringField(conversation.providerThreadId) ?? stringField(provider.threadId),
    providerModel: stringField(conversation.providerModel) ?? stringField(provider.model),
    providerState: stringField(conversation.providerState) ?? stringField(provider.state),
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
}): Promise<{ choice: NativeConversationChoice; refreshResult: T | null; refreshError: unknown | null }> {
  const request = options.envelopeManager.prepare(options.input);
  const acceptance = await options.dispatch(options.input.owner.projectId, request);
  if (!isDurableNativeConversationAcceptance(request, acceptance)) throw new Error('Project conversation start did not return a durable accepted operation.');
  options.envelopeManager.clearAccepted(options.input, request, acceptance);
  const choice = projectConversationChoiceFromAcceptance(acceptance, options.input.owner);
  await options.onAccepted(choice);
  try {
    return { choice, refreshResult: await options.refresh(options.input.owner.projectId), refreshError: null };
  } catch (refreshError) {
    return { choice, refreshResult: null, refreshError };
  }
}

function buildProjectConversationStartPayload(input: ProjectSessionWorkspaceStartInput): Omit<StartProjectConversationRequest, 'idempotencyKey' | 'clientUserMessageId'> {
  if (!input.content.trim()) throw new Error('Project conversation start content is required.');
    return {
        mode: 'create',
        content: input.content,
        attachments: input.attachments,
        permissionMode: input.permissionMode ?? 'auto',
        collaborationMode: input.collaborationMode ?? 'default'
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
    Boolean(value.content.trim()) &&
    Array.isArray(value.attachments) &&
    permissionModeField(value.permissionMode) !== undefined &&
    (value.collaborationMode === 'default' || value.collaborationMode === 'plan') &&
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
  if (!content) throw new Error('Native conversation start content is required.');
    if (input.mode === 'create')
        return {
            mode: 'create',
            content, ...(input.attachments?.length ? {attachments: input.attachments} : {}),
            permissionMode: input.permissionMode ?? 'auto',
            collaborationMode: input.collaborationMode ?? 'default'
        };
  if (!input.conversation) throw new Error('An explicit conversation choice is required.');
  if (input.mode === 'resume') {
    if (input.conversation.transportKind !== 'codex_native' || !input.conversation.resumable) throw new Error('The selected conversation is not resumable.');
      return {
          mode: 'resume',
          conversationId: input.conversation.id,
          content,
          collaborationMode: input.collaborationMode ?? input.conversation.collaborationMode ?? 'default'
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
  if (typeof request.idempotencyKey !== 'string' || !request.idempotencyKey || typeof request.clientUserMessageId !== 'string' || !request.clientUserMessageId || typeof request.content !== 'string' || !request.content) return false;
    if (request.mode === 'create') return permissionModeField(request.permissionMode) !== undefined && (request.collaborationMode === 'default' || request.collaborationMode === 'plan');
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
    capabilities?: CodexConversationCapabilities | null;
  choicesKnown?: boolean;
  legacyMessages?: Record<string, Array<{ id: string; role: string; content: string }>>;
  loadState?: 'empty' | 'loading' | 'error';
  loadError?: string | null;
  autoFocusNewConversation?: boolean;
  actions?: SessionWorkspaceActions;
}

const labels = {
  'zh-CN': {
    workspace: '会话工作区',
    loading: '正在加载会话',
    reconnecting: '正在重新连接',
    reconnectingAttempt: (attempt: number) => `正在重新连接 · 第 ${Math.max(1, attempt)} 次`,
    failed: '连接失败',
    failureHelp: '连接中断。请重新连接以读取最新快照。',
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
    rateLimits: '账户限额',
    mcpStartup: 'MCP 启动状态',
    runtimeReady: '运行时状态正常',
    runtimeAttention: '需要关注',
    recoveryRequired: '需要恢复',
    recoveryRequiredHelp: '当前状态可能不完整，不能安全续接。请新建会话，不要重连或继续发送。',
    startNew: '新建会话',
    nonResumable: '此会话已不能继续。',
    nonResumableHelp: '历史仍可只读查看；若要继续工作，请显式新建会话。',
    legacyTranscript: '只读旧会话记录',
    unsynced: '未同步',
    tokens: (count: number) => `${count} tokens`,
  },
  'en-US': {
    workspace: 'Conversation workspace',
    loading: 'Loading conversation',
    reconnecting: 'Reconnecting',
    reconnectingAttempt: (attempt: number) => `Reconnecting · attempt ${Math.max(1, attempt)}`,
    failed: 'Connection failed',
    failureHelp: 'The connection was interrupted. Reconnect to load the latest snapshot.',
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
    rateLimits: 'Account rate limits',
    mcpStartup: 'MCP startup',
    runtimeReady: 'Runtime status current',
    runtimeAttention: 'Attention required',
    recoveryRequired: 'Recovery required',
    recoveryRequiredHelp: 'The current state may be incomplete and cannot be continued safely. Start a new conversation instead of reconnecting or sending.',
    startNew: 'Start a new conversation',
    nonResumable: 'This conversation can no longer be continued.',
    nonResumableHelp: 'Its history remains read-only. Start a new conversation explicitly to continue working.',
    legacyTranscript: 'Read-only legacy transcript',
    unsynced: 'Not synced',
    tokens: (count: number) => `${count} tokens`,
  },
} as const;

type SessionWorkspaceStatus = { kind: 'ready' | 'busy' | 'warning' | 'error'; label: string };

export interface SessionHeaderSnapshot {
  conversationId: string;
  title: string;
  contextLabel: string;
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
  return {
    conversationId: conversation.id,
    title: conversation.title,
    contextLabel: task?.title ?? (owner?.kind === 'project' ? owner.projectName : null) ?? conversation.summary ?? conversation.projectId,
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
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [interruptArmed, setInterruptArmed] = useState(false);
  const [startFreshOpen, setStartFreshOpen] = useState(false);
    const [planWorkspaceItemId, setPlanWorkspaceItemId] = useState<string | null>(null);
    const [planWorkspaceFullWidth, setPlanWorkspaceFullWidth] = useState(false);
  const currentHeader = useMemo(() => createSessionHeaderSnapshot(props.conversation, props.task, props.state, props.loadState, props.language, owner), [owner, props.conversation, props.language, props.loadState, props.state, props.task]);
  const currentHeaderRef = useRef(currentHeader);
  currentHeaderRef.current = currentHeader;
  const [displayedHeader, setDisplayedHeader] = useState(currentHeader);
  const [titleMotion, setTitleMotion] = useState<'entered' | 'exiting'>('entered');
  const previousPendingCountRef = useRef(0);
  const composerFocusRestorationPendingRef = useRef(false);
  const legacy = props.conversation && (props.conversation.readOnly || props.conversation.transportKind !== 'codex_native');
    const effectiveProviderState = props.state?.snapshot?.providerState ?? props.conversation?.providerState ?? null;
    const effectiveResumable = props.state?.snapshot ? !['closed', 'failed'].includes(effectiveProviderState ?? '') : effectiveProviderState === 'archived' ? true : props.conversation?.resumable;
    const nonResumableNative = Boolean(props.conversation && !legacy && !effectiveResumable);
  const pendingRequests = props.state?.pendingRequests.filter((request) => request.status === 'pending') ?? [];
    const pendingPlanImplementationRequests = props.state?.planImplementationRequests.filter((request) => request.status === 'pending').slice(-1) ?? [];
    const planWorkspaceItem = planWorkspaceItemId ? (Object.values(props.state?.items ?? {}).find((item) => item.type === 'plan' && (item.localItemId === planWorkspaceItemId || item.itemId === planWorkspaceItemId)) ?? null) : null;
    const dockedPlan = props.state ? selectDockedTurnPlan(props.state) : null;

    useEffect(() => {
        setPlanWorkspaceItemId(null);
        setPlanWorkspaceFullWidth(false);
    }, [props.conversation?.id]);

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
    const previous = previousPendingCountRef.current;
    previousPendingCountRef.current = pendingRequests.length;
    const resolution = resolveComposerFocusRestoration({
      previousPendingCount: previous,
      pendingCount: pendingRequests.length,
      restorationPending: composerFocusRestorationPendingRef.current,
      state: props.state,
      readOnly: nonResumableNative,
    });
    composerFocusRestorationPendingRef.current = resolution.restorationPending;
    if (!resolution.shouldFocus) return;
    composerRef.current?.focus();
  }, [nonResumableNative, pendingRequests.length, props.state]);

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
      const planRequest = pendingPlanImplementationRequests[0];
      if (planRequest) {
          event.preventDefault();
          event.stopPropagation();
          void respondToPlanImplementationRequest(planRequest, {action: 'dismiss'});
          return;
      }
      if (planWorkspaceItemId) {
          event.preventDefault();
          event.stopPropagation();
          setPlanWorkspaceItemId(null);
          setPlanWorkspaceFullWidth(false);
          return;
      }
      const userInputRequest = pendingRequests.find((request) => requestKind(request) === 'request_user_input');
      if (userInputRequest) {
          if (event.target instanceof Element && event.target.closest('.session-rui-request')) return;
          event.preventDefault();
          event.stopPropagation();
          void respond(userInputRequest, {type: 'userInput', answers: {}});
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

    async function respondToPlanImplementationRequest(request: NativePlanImplementationRequest, input: {
        action: 'implement' | 'refine' | 'dismiss';
        feedback?: string
    }): Promise<void> {
        if (!actions.onRespondToPlanImplementationRequest || !responseGuard.begin(request.id)) return;
        setRequestErrors((current) => {
            const next = {...current};
            delete next[request.id];
            return next;
        });
        try {
            await actions.onRespondToPlanImplementationRequest(request.id, input);
        } catch (error) {
            setRequestErrors((current) => ({
                ...current,
                [request.id]: error instanceof Error ? error.message : String(error)
            }));
        } finally {
            responseGuard.finish(request.id);
        }
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
            <strong>{displayedHeader.title}</strong>
            <small>{displayedHeader.contextLabel}</small>
          </span>
          <span
            className={`session-thread-status session-thread-status-${displayedHeader.status.kind}`}
            role={displayedHeader.status.kind === 'error' ? 'alert' : 'status'}
            aria-live={displayedHeader.status.kind === 'error' ? 'assertive' : 'polite'}
          >
            <span className="session-status-symbol" aria-hidden="true"/>
            <span>{displayedHeader.status.label}</span>
          </span>
        </header>
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
          <div className="session-thread-split" data-plan-open={Boolean(planWorkspaceItem) || undefined}
               data-plan-full-width={planWorkspaceFullWidth || undefined}>
              <div className="session-thread-body">
                  <SessionRuntimeDetails state={props.state} conversation={props.conversation}
                                         language={props.language}/>
                  {props.state.transportState === 'hydrating' || props.state.transportState === 'connecting' ?
                      <SessionLoading language={props.language}/> : null}
                  {props.state.transportState === 'reconnecting' ?
                      <SessionReconnectNotice language={props.language} attempt={props.state.reconnectAttempt}
                                              onReconnect={actions.onReconnect}/> : null}
                  {props.state.transportState === 'failed' ? (
                      <section className="session-transport-failure" role="alert">
                          <WarningCircle aria-hidden="true" weight="regular"/>
                          <span className="session-transport-failure-copy">
                  <strong>{props.state.error?.recoveryRequired ? copy.recoveryRequired : isServerBusyError(props.state.error) ? copy.serverBusy : copy.failed}</strong>
                  <p>{props.state.error?.recoveryRequired ? copy.recoveryRequiredHelp : isServerBusyError(props.state.error) ? copy.serverBusyHelp : copy.failureHelp}</p>
                              {errorMessage(props.state.error) || props.loadError ? (
                                  <details className="session-error-details">
                                      <summary>{copy.details}</summary>
                                      <p>{errorMessage(props.state.error) ?? props.loadError}</p>
                                  </details>
                              ) : null}
                </span>
                          {props.state.error?.recoveryRequired ? (
                              <button type="button" onClick={() => setStartFreshOpen(true)}>
                                  {copy.startNew}
                              </button>
                          ) : actions.onReconnect ? (
                              <button type="button" onClick={() => void actions.onReconnect?.()}>
                                  {copy.retry}
                              </button>
                          ) : null}
                      </section>
                  ) : null}
                  {nonResumableNative ? (
                      <section className="session-nonresumable-notice" role="status">
                          <strong>{copy.nonResumable}</strong>
                          <p>{copy.nonResumableHelp}</p>
                          <button type="button" onClick={() => setStartFreshOpen(true)}>
                              {copy.startNew}
                          </button>
                      </section>
                  ) : null}
                  {(startFreshOpen || props.state.error?.recoveryRequired) && owner ? (
                      <NewConversationComposer
                          language={props.language}
                          owner={owner}
                          task={props.task}
                          autoFocus
                          onStartTask={actions.onStartConversation}
                          onStartProject={actions.onStartProjectConversation}
                          onChooseAttachments={actions.onChooseStartAttachments}
                      />
                  ) : null}
                  <ConversationTranscript
                      state={props.state}
                      language={props.language}
                      onEditUserItem={actions.onEditUserItem}
                      onRetryItem={actions.onRetryItem}
                      pendingRequests={pendingRequests}
                      planImplementationRequests={pendingPlanImplementationRequests}
                      openPlanItemId={planWorkspaceItemId}
                      onOpenPlan={(item) => setPlanWorkspaceItemId(item.localItemId ?? item.itemId)}
                      renderPendingRequest={(request, index) => (
                          <PendingRequestSurface
                              request={request}
                              language={props.language}
                              permissionMode={props.state?.snapshot?.permissionMode ?? 'read-only'}
                              autoFocus={index === 0}
                              busy={Boolean(props.state?.error?.recoveryRequired) || isRequestResponseBusy(props.state?.busyOperation ?? null, request.id)}
                              error={requestErrors[request.id]}
                              onRespond={(_requestId, response) => respond(request, response)}
                              onSnooze={actions.onSnoozeRequest ? () => actions.onSnoozeRequest?.(request.id) : undefined}
                          />
                      )}
                      renderPlanImplementationRequest={(request, index) => (
                          <PlanImplementationRequestSurface
                              request={request}
                              language={props.language}
                              autoFocus={index === 0 && pendingRequests.length === 0}
                              busy={isRequestResponseBusy(props.state?.busyOperation ?? null, request.id)}
                              error={requestErrors[request.id]}
                              onRespond={(_requestId, response) => respondToPlanImplementationRequest(request, response)}
                          />
                      )}
                  />
                  {props.suppressComposer || !dockedPlan ? null :
                      <SessionPlanProgress plan={dockedPlan} language={props.language}/>}
                  {props.suppressComposer ? null : (
                      <ConversationComposer
                          textareaRef={composerRef}
                          state={props.state}
                          language={props.language}
                          capabilities={props.capabilities}
                          onDraftChange={(draft) => actions.onDraftChange?.(draft)}
                          onSubmit={(delivery, settings) => actions.onSubmit?.(delivery, settings)}
                          onInterrupt={(turnId) => actions.onInterrupt?.(turnId)}
                          onChooseAttachments={actions.onChooseAttachments}
                          onRemoveAttachment={actions.onRemoveAttachment}
                          onEditQueuedSubmission={actions.onEditQueuedSubmission}
                          onDeleteQueuedSubmission={actions.onDeleteQueuedSubmission}
                          onSendQueuedNow={actions.onSendQueuedNow}
                          onReorderQueue={actions.onReorderQueue}
                          onResumeQueue={actions.onResumeQueue}
                          onRetryQueue={actions.onRestoreArchivedConversation}
                          readOnly={nonResumableNative || Boolean(props.state.error?.recoveryRequired)}
                          permissionMode={props.state.snapshot?.permissionMode ?? 'read-only'}
                          onPermissionModeChange={actions.onPermissionModeChange}
                          collaborationMode={props.state.snapshot?.collaborationMode ?? 'default'}
                          onCollaborationModeChange={actions.onCollaborationModeChange}
                      />
                  )}
                  {interruptArmed ? (
                      <p className="session-interrupt-confirm" role="status">
                          {copy.interruptConfirm}
                      </p>
                  ) : null}
              </div>
              {planWorkspaceItem ? (
                  <PlanWorkspace
                      item={planWorkspaceItem}
                      language={props.language}
                      fullWidth={planWorkspaceFullWidth}
                      onFullWidthChange={setPlanWorkspaceFullWidth}
                      onClose={() => {
                          setPlanWorkspaceItemId(null);
                          setPlanWorkspaceFullWidth(false);
                      }}
                  />
          ) : null}
        </div>
      ) : (
        <NewConversationComposer
          language={props.language}
          owner={owner}
          task={props.task}
          autoFocus={props.autoFocusNewConversation}
          loadState={props.loadState}
          loadError={props.loadError}
          onStartTask={actions.onStartConversation}
          onStartProject={actions.onStartProjectConversation}
          onChooseAttachments={actions.onChooseStartAttachments}
        />
      )}
    </section>
  );
}

export function selectDockedTurnPlan(state: NativeSessionState): NativeSessionState['turnsByProviderId'][string]['plan'] {
    if (state.activeTurnId) return state.turnsByProviderId[state.activeTurnId]?.plan ?? null;
    const turnIdsInTranscript = [...state.itemOrder]
        .reverse()
        .map((key) => state.items[key]?.turnId)
        .filter((turnId): turnId is string => Boolean(turnId));
    for (const turnId of turnIdsInTranscript) {
        const plan = state.turnsByProviderId[turnId]?.plan;
        if (plan?.steps.length) return plan;
    }
    return [...Object.values(state.turnsByProviderId)].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).find((turn) => turn.plan?.steps.length)?.plan ?? null;
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
  return Boolean(
    !readOnly &&
    state?.transportState === 'ready' &&
    !state.busyOperation &&
    !state.error?.recoveryRequired &&
    state.conversationState !== 'legacy_readonly' &&
    state.conversationState !== 'waiting_approval' &&
    state.conversationState !== 'waiting_user_input',
  );
}

function NewConversationComposer(props: {
  language: SessionUiLanguage;
  owner?: SessionConversationOwner;
  task: SessionWorkspaceTask | null;
  autoFocus?: boolean;
  loadState?: SessionWorkspaceProps['loadState'];
  loadError?: string | null;
  onStartTask?: SessionWorkspaceActions['onStartConversation'];
  onStartProject?: SessionWorkspaceActions['onStartProjectConversation'];
  onChooseAttachments?: SessionWorkspaceActions['onChooseStartAttachments'];
}) {
  const copy = labels[props.language];
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<NativeConversationAttachment[]>([]);
  const [permissionMode, setPermissionMode] = useState<NativePermissionMode>('auto');
    const [collaborationMode, setCollaborationMode] = useState<NativeCollaborationMode>('default');
  const [isComposing, setIsComposing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (props.autoFocus) textareaRef.current?.focus();
  }, [props.autoFocus]);

  async function submit(): Promise<void> {
    if (!props.owner || submitting || !content.trim()) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      if (props.owner.kind === 'project') {
        if (!props.onStartProject) throw new Error('Project conversation start is unavailable.');
          await props.onStartProject({owner: props.owner, content, attachments, permissionMode, collaborationMode});
      } else {
        if (!props.task || !props.onStartTask) throw new Error('Task conversation start is unavailable.');
          await props.onStartTask({
              mode: 'create',
              task: props.task,
              content,
              attachments,
              permissionMode,
              collaborationMode
          });
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="session-new-conversation">
      <span className="session-new-conversation-spacer" aria-hidden="true" />
      <section className="session-composer-shell session-new-conversation-composer" aria-label={copy.newInput} aria-busy={submitting || undefined}>
        {localError || (props.loadState === 'error' && props.loadError) ? (
          <p className="session-new-conversation-error" role="alert">
            {localError ?? props.loadError}
          </p>
        ) : null}
        {attachments.length > 0 ? (
          <ul className="session-composer-attachments" aria-label={props.language === 'zh-CN' ? '待发送附件' : 'Pending attachments'}>
            {attachments.map((attachment) => (
              <li key={attachment.localPath ?? attachment.uploadRef}>
                <span>{attachment.name}</span>
                <button type="button" aria-label={`${copy.removeAttachment}: ${attachment.name}`} disabled={submitting} onClick={() => setAttachments((current) => current.filter((candidate) => candidate !== attachment))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
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
            onKeyDown={(event) => {
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
                  disabled={submitting || !props.owner}
                  onClick={async () => {
                    try {
                      const selected = await props.onChooseAttachments?.();
                      if (selected?.length) {
                        setAttachments((current) => {
                          const byIdentity = new Map(current.map((attachment) => [attachment.localPath ?? attachment.uploadRef, attachment]));
                          selected.forEach((attachment) => byIdentity.set(attachment.localPath ?? attachment.uploadRef, attachment));
                          return [...byIdentity.values()];
                        });
                      }
                    } catch (error) {
                      setLocalError(error instanceof Error ? error.message : String(error));
                    }
                  }}
                >
                  <span aria-hidden="true">＋</span>
                </button>
              ) : null}
              <PermissionModeControl language={props.language} value={permissionMode} disabled={submitting || !props.owner} onChange={setPermissionMode} />
              <CollaborationModeControl language={props.language} value={collaborationMode}
                                        disabled={submitting || !props.owner} onChange={setCollaborationMode}/>
            </span>
            <span className="session-composer-trailing-actions">
              <span className="session-primary-command-slot" data-primary-command-slot="true">
                <button type="button" className="session-send-button" aria-label={copy.send} onClick={() => void submit()} disabled={submitting || !props.owner || !content.trim()} aria-busy={submitting || undefined}>
                  {submitting ? <span className="session-command-spinner" aria-hidden="true" /> : <span aria-hidden="true">↑</span>}
                </button>
              </span>
            </span>
          </div>
        </div>
      </section>
    </section>
  );
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

function SessionReconnectNotice(props: {
    language: SessionUiLanguage;
    attempt: number;
    onReconnect?: () => void | Promise<void>
}) {
    const delay = reconnectDelayMs(props.attempt);
    const delayLabel = delay < 1_000 ? `${delay} ms` : `${delay / 1_000} s`;
  return (
      <section className="session-reconnect-notice" role="status" aria-live="polite" aria-atomic="true">
          <ArrowsClockwise aria-hidden="true" weight="regular"/>
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

function SessionRuntimeDetails(props: { state: NativeSessionState; conversation: NativeConversationChoice | null; language: SessionUiLanguage }) {
  const copy = labels[props.language];
  const model = props.state.providerSettings?.model?.trim() || copy.unsynced;
  const effort = props.state.providerSettings?.effort?.trim() || copy.unsynced;
  const usage = props.state.tokenUsage;
  const rateLimits = props.state.rateLimits?.value ?? null;
  const mcpStartup = props.state.mcpStartup?.value ?? null;
  const warning = runtimeValueNeedsAttention(rateLimits) || runtimeValueNeedsAttention(mcpStartup);
  const modelLabel = [model, effort].join(' · ');
  return (
    <details className="session-runtime-details" data-severity={warning ? 'warning' : 'ready'} aria-label={copy.runtimeDetails}>
      <summary>
        {modelLabel ? <span>{modelLabel}</span> : null}
        {usage ? <span>{copy.tokens(usage.totalTokens)}</span> : null}
        {rateLimits ? <span>{runtimeValueHeadline(rateLimits)}</span> : null}
        {mcpStartup ? <span>{runtimeValueHeadline(mcpStartup)}</span> : null}
        <span className="session-runtime-severity">
          <span aria-hidden="true">{warning ? '!' : '·'}</span>
          {warning ? copy.runtimeAttention : copy.runtimeReady}
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
          <div>
            <dt>{copy.usage}</dt>
            <dd>
              {copy.tokens(usage.totalTokens)} · {usage.inputTokens} in · {usage.outputTokens} out
            </dd>
          </div>
        ) : null}
        {rateLimits ? (
          <div>
            <dt>{copy.rateLimits}</dt>
            <dd>{runtimeValueSummary(rateLimits)}</dd>
          </div>
        ) : null}
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

function runtimeValueNeedsAttention(value: unknown, key = ''): boolean {
  if (typeof value === 'number') return /remaining|available|balance/i.test(key) && value <= 0;
  if (typeof value === 'string') return /^(error|failed|degraded|unavailable|blocked|exhausted)$/i.test(value.trim());
  if (Array.isArray(value)) return value.some((entry) => runtimeValueNeedsAttention(entry, key));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([entryKey, entryValue]) => runtimeValueNeedsAttention(entryValue, entryKey));
}

function runtimeValueHeadline(value: Record<string, unknown>): string {
  return runtimeValueFragments(value).slice(0, 2).join(' · ');
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

function sessionStatus(state: NativeSessionState | null, loadState: SessionWorkspaceProps['loadState'], copy: (typeof labels)[SessionUiLanguage]): SessionWorkspaceStatus {
  if (!state) {
      if (loadState === 'loading') return {kind: 'busy', label: copy.loading};
      if (loadState === 'error') return {kind: 'error', label: copy.failed};
      return {kind: 'ready', label: copy.ready};
  }
    if (state.transportState === 'connecting' || state.transportState === 'hydrating') return {
        kind: 'busy',
        label: copy.loading
    };
    if (state.transportState === 'reconnecting') return {
        kind: 'warning',
        label: copy.reconnectingAttempt(state.reconnectAttempt)
    };
    if (state.error?.recoveryRequired) return {kind: 'error', label: copy.recoveryRequired};
    if (state.transportState === 'failed') return {
        kind: 'error',
        label: isServerBusyError(state.error) ? copy.serverBusy : copy.failed
    };
    if ((state.snapshot?.providerState === 'archived' || (state.queue?.state.type === 'paused' && state.queue.state.reason === 'provider_archived')) && (state.queue?.submissions.length ?? 0) > 0) return {
        kind: 'busy',
        label: copy.queued
    };
  switch (state.conversationState) {
    case 'native_loading':
        return {kind: 'busy', label: copy.loading};
    case 'native_idle':
        return {kind: 'ready', label: copy.ready};
    case 'starting_turn':
        return {kind: 'busy', label: copy.starting};
    case 'active_prework':
        return {kind: 'busy', label: copy.working};
    case 'active_final_answer':
        return {kind: 'busy', label: copy.answering};
    case 'waiting_approval':
        return {kind: 'warning', label: copy.approval};
    case 'waiting_user_input':
        return {kind: 'warning', label: copy.input};
    case 'interrupt_confirm':
        return {kind: 'warning', label: copy.interruptConfirm};
    case 'interrupting':
        return {kind: 'busy', label: copy.interrupting};
    case 'turn_failed':
        return {kind: 'error', label: errorMessage(state.error) ?? copy.turnFailed};
    case 'legacy_readonly':
        return {kind: 'warning', label: copy.legacyTranscript};
  }
}

function errorMessage(error: NativeSessionState['error']): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : error.message;
}

function isServerBusyError(error: NativeSessionState['error']): boolean {
  return error?.status === 429 || /^(RATE_LIMITED|SERVER_BUSY|TOO_MANY_REQUESTS)$/i.test(error?.code ?? '');
}

function sessionPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
