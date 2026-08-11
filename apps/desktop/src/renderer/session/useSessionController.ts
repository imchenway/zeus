import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ZeusBrowserPreparedSubmission } from '@zeus/shared';
import { createInitialSessionState, sessionReducer } from './sessionReducer.js';
import {
  type CodexConversationCapabilities,
  type ConversationResourcePreview,
  isNativeConversationEvent,
  type NativeCollaborationMode,
  type NativeConversationAttachment,
  type NativeConversationEvent,
  type NativeConversationSnapshot,
  type NativeNextTurnSettings,
  type NativeOperationAcceptance,
  type NativePendingRequest,
  type NativePermissionMode,
  type NativePlanImplementationRequest,
  type NativeQueuedSubmission,
  type NativeQueueSnapshot,
  type NativeRealtimeEventEnvelope,
  type NativeSessionError,
  type NativeSessionState,
  type NativeTurnSettingsSelection,
  type SendNativeMessageRequest,
  type TurnChangeSet,
  type TurnChangeSetOperationResult,
} from './sessionTypes.js';

export const reconnectBackoffMs = [250, 500, 1_000, 2_000, 5_000] as const;
// 同一个会话项的短增量只在一小段窗口内合并，避免把 React 更新频率绑定到 provider 的字符频率。
const RENDER_DELTA_COALESCE_MS = 40;

export function reconnectDelayMs(attempt: number): number {
  return reconnectBackoffMs[Math.min(Math.max(0, Math.floor(attempt) - 1), reconnectBackoffMs.length - 1)]!;
}

export interface SessionControllerClient {
  loadCodexConversationCapabilities?(projectId: string): Promise<CodexConversationCapabilities>;
  loadNativeConversation(projectId: string, conversationId: string): Promise<NativeConversationSnapshot>;
  loadNativePendingRequests(projectId: string, conversationId: string): Promise<{ conversationId: string; requests: NativePendingRequest[] }>;
  loadConversationResourcePreview?(projectId: string, conversationId: string, resourceId: string): Promise<ConversationResourcePreview>;
  loadTurnChangeFilePreview?(projectId: string, conversationId: string, turnId: string, changeSetId: string, fileId: string): Promise<ConversationResourcePreview>;
  loadTurnChangeSet?(projectId: string, conversationId: string, turnId: string): Promise<TurnChangeSet>;
  operateTurnChangeSet?(
    projectId: string,
    conversationId: string,
    turnId: string,
    action: 'undo' | 'reapply',
    input: { changeSetId: string; expectedState: 'applied' | 'undone'; idempotencyKey: string },
  ): Promise<TurnChangeSetOperationResult>;

  restoreArchivedNativeConversation(projectId: string, conversationId: string): Promise<NativeConversationSnapshot>;
  updateNativePermissionMode(projectId: string, conversationId: string, permissionMode: NativePermissionMode): Promise<NativeConversationSnapshot>;

  updateNativeCollaborationMode(projectId: string, conversationId: string, collaborationMode: NativeCollaborationMode): Promise<NativeConversationSnapshot>;
  updateNativeNextTurnSettings(projectId: string, conversationId: string, settings: NativeNextTurnSettings): Promise<NativeNextTurnSettings>;
  connectEvents(onEvent: (event: NativeRealtimeEventEnvelope) => void, options?: { afterEventId?: string }): WebSocket;
  sendNativeMessage(projectId: string, conversationId: string, input: SendNativeMessageRequest): Promise<NativeOperationAcceptance>;
  editNativeQueuedSubmission(projectId: string, conversationId: string, submissionId: string, content: string): Promise<NativeQueueSnapshot>;
  deleteNativeQueuedSubmission(projectId: string, conversationId: string, submissionId: string): Promise<NativeQueueSnapshot>;
  reorderNativeQueue(projectId: string, conversationId: string, orderedSubmissionIds: string[]): Promise<NativeQueueSnapshot>;
  sendNativeQueuedNow(projectId: string, conversationId: string, submissionId: string): Promise<NativeOperationAcceptance>;
  resumeNativeQueue(projectId: string, conversationId: string): Promise<NativeQueueSnapshot>;
  recoverNativeQueue(projectId: string, conversationId: string): Promise<NativeQueueSnapshot>;
  interruptNativeTurn(projectId: string, conversationId: string, turnId: string): Promise<NativeOperationAcceptance>;
  respondToNativeRequest(projectId: string, conversationId: string, requestId: string, response: Record<string, unknown>): Promise<{ operation: Record<string, unknown>; request: NativePendingRequest }>;

  snoozeNativeRequest(
    projectId: string,
    conversationId: string,
    requestId: string,
  ): Promise<{
    request: NativePendingRequest;
  }>;

  respondToPlanImplementationRequest(
    projectId: string,
    conversationId: string,
    requestId: string,
    input: { action: 'implement' | 'refine' | 'dismiss'; feedback?: string },
  ): Promise<{
    operation: NativeOperationAcceptance['operation'];
    request: NativePlanImplementationRequest;
    conversation: NativeConversationSnapshot;
  }>;
}

export interface SessionDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CreateSessionControllerOptions {
  client: SessionControllerClient;
  projectId: string;
  conversationId: string;
  initialCachedState?: NativeSessionState;
  initialOptimisticState?: NativeSessionState;
  storage?: SessionDraftStorage;
  createId?: () => string;
  reconnectDelay?: (delayMs: number) => Promise<void>;
  markBrowserCommentsSent?: (input: { conversationId: string; tabId: string; commentIds: string[] }) => Promise<unknown>;
}

export interface SessionController {
  start(): Promise<void>;
  reconnect(): Promise<void>;
  dispose(): void;
  subscribe(listener: () => void): () => void;
  getState(): NativeSessionState;
  setDraft(draft: string): void;
  setAttachments(attachments: NativeConversationAttachment[]): void;
  setBrowserSubmission(browserSubmission: ZeusBrowserPreparedSubmission | null): void;

  send(delivery: 'queue' | 'steer_now', expectedTurnId?: string, settings?: NativeTurnSettingsSelection): Promise<NativeOperationAcceptance>;
  editQueuedSubmission(submissionId: string, content: string): Promise<NativeQueueSnapshot>;
  deleteQueuedSubmission(submissionId: string): Promise<NativeQueueSnapshot>;
  reorderQueue(orderedSubmissionIds: string[]): Promise<NativeQueueSnapshot>;
  sendQueuedNow(submissionId: string): Promise<NativeOperationAcceptance>;
  resumeQueue(): Promise<NativeQueueSnapshot>;
  recoverQueue(): Promise<NativeQueueSnapshot>;

  restoreArchivedConversation(): Promise<NativeConversationSnapshot>;
  interruptActiveTurn(): Promise<NativeOperationAcceptance>;
  respondToRequest(requestId: string, response: Record<string, unknown>): Promise<{ operation: Record<string, unknown>; request: NativePendingRequest }>;

  snoozeRequest(requestId: string): Promise<{ request: NativePendingRequest }>;

  respondToPlanImplementationRequest(
    requestId: string,
    input: {
      action: 'implement' | 'refine' | 'dismiss';
      feedback?: string;
    },
  ): Promise<void>;
  setPermissionMode(permissionMode: NativePermissionMode): Promise<NativeConversationSnapshot>;

  setCollaborationMode(collaborationMode: NativeCollaborationMode): Promise<NativeConversationSnapshot>;
  setNextTurnSettings(settings: NativeNextTurnSettings): Promise<NativeNextTurnSettings>;
}

interface PendingSendEnvelope {
  fingerprint: string;
  content: string;
  displayText: string;
  draft: string;
  attachments: NativeConversationAttachment[];
  composerAttachments: NativeConversationAttachment[];
  browserSubmission: ZeusBrowserPreparedSubmission | null;
  delivery: 'queue' | 'steer_now';
  expectedTurnId?: string;
  model?: string;
  agentKind?: 'codex' | 'pi';
  effort?: string;
  serviceTier?: string | null;
  permissionMode?: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  idempotencyKey: string;
  clientUserMessageId: string;
  deliveryState?: 'pending' | 'accepted';
  acceptance?: NativeOperationAcceptance;
  browserCommentsMarked?: boolean;
}

type FailedSendReconciliation = { kind: 'durable'; acceptance: NativeOperationAcceptance } | { kind: 'absent' } | { kind: 'unknown' };

interface PersistedDraft {
  draft: string;
  attachments: NativeConversationAttachment[];
  browserSubmission?: ZeusBrowserPreparedSubmission | null;
  pendingSend?: PendingSendEnvelope;
  recoveryRequired?: NativeSessionError;
  recoveredSubmissionIds?: string[];
}

interface SocketLifecycle {
  opened: Promise<void>;
  isDisconnected(): boolean;
  markInactive(): void;
}

class SocketDisconnectedDuringHydrationError extends Error {
  constructor() {
    super('Zeus event socket disconnected during authoritative conversation hydration.');
    this.name = 'SocketDisconnectedDuringHydrationError';
  }
}

export function createSessionController(options: CreateSessionControllerOptions): SessionController {
  const storage = options.storage ?? browserStorage();
  const storageKey = `zeus.native-session-draft:${options.projectId}:${options.conversationId}`;
  const persisted = readPersistedDraft(storage, storageKey);
  let pendingSend = persisted.pendingSend ?? null;
  let recoveryRequired = persisted.recoveryRequired ?? null;
  const recoveredSubmissionIds = new Set(persisted.recoveredSubmissionIds ?? []);
  const initialCachedState =
    options.initialCachedState?.projectId === options.projectId &&
    options.initialCachedState.conversationId === options.conversationId &&
    options.initialCachedState.snapshot?.projectId === options.projectId &&
    options.initialCachedState.snapshot.id === options.conversationId
      ? options.initialCachedState
      : undefined;
  if (!recoveryRequired && initialCachedState?.error?.recoveryRequired) recoveryRequired = initialCachedState.error;
  const initialOptimisticItems = (options.initialOptimisticState?.itemOrder ?? [])
    .map((key) => options.initialOptimisticState?.items[key])
    .filter((item): item is NonNullable<typeof item> => Boolean(item?.optimistic && item.conversationId === options.conversationId));
  const cachedItems = initialCachedState?.items ?? {};
  const optimisticItems = Object.fromEntries(initialOptimisticItems.map((item) => [item.key, { ...item }]));
  const itemOrder = [...new Set([...(initialCachedState?.itemOrder ?? []), ...initialOptimisticItems.map((item) => item.key)])];
  let state: NativeSessionState = {
    ...(initialCachedState ?? createInitialSessionState()),
    transportState: 'disconnected',
    reconnectAttempt: 0,
    projectId: options.projectId,
    conversationId: options.conversationId,
    providerThreadId: initialCachedState?.providerThreadId ?? (initialOptimisticItems.length > 0 ? (options.initialOptimisticState?.providerThreadId ?? null) : null),
    conversationState: initialCachedState?.conversationState ?? (initialOptimisticItems.length > 0 ? 'starting_turn' : 'native_loading'),
    items: { ...cachedItems, ...optimisticItems },
    itemOrder,
    providerSettings: initialCachedState?.providerSettings ?? (initialOptimisticItems.length > 0 ? (options.initialOptimisticState?.providerSettings ?? null) : null),
    transcriptRevision: (initialCachedState?.transcriptRevision ?? 0) + initialOptimisticItems.filter((item) => !(item.key in cachedItems)).length,
    draft: persisted.draft,
    attachments: persisted.attachments,
    browserSubmission: persisted.browserSubmission ?? null,
    busyOperation: null,
    error: recoveryRequired,
  };
  let socket: WebSocket | null = null;
  let socketLifecycle: SocketLifecycle | null = null;
  let connectionToken = 0;
  let identityEpoch = 0;
  let disposed = false;
  let startPromise: Promise<void> | null = null;
  let reconnectLoopPromise: Promise<void> | null = null;
  let reconnectLoopEpoch = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReconnectTimer: ((shouldContinue: boolean) => void) | null = null;
  let requestRefresh: Promise<void> | null = null;
  let requestRefreshAgain = false;
  const resolvedRequestIds = new Set<string>();
  let targetedHydrationBuffer: NativeConversationEvent[] | null = null;
  const pendingRenderDeltas = new Map<string, NativeConversationEvent>();
  let renderDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  let activeOperation: { key: string; promise: Promise<unknown> } | null = null;
  const listeners = new Set<() => void>();
  const createId = options.createId ?? defaultCreateId;

  function dispatch(action: Parameters<typeof sessionReducer>[1]): void {
    const previousThreadId = state.providerThreadId;
    const previousTransportKind = state.snapshot?.transportKind ?? null;
    const previousRecoveryRequired = recoveryRequired;
    let next = sessionReducer(state, action);
    if (next.error?.recoveryRequired) recoveryRequired = next.error;
    if (recoveryRequired && !next.error?.recoveryRequired) next = { ...next, error: recoveryRequired };
    if (next === state && recoveryRequired === previousRecoveryRequired) return;
    state = next;
    if (state.providerThreadId !== previousThreadId || (state.snapshot?.transportKind ?? null) !== previousTransportKind) identityEpoch += 1;
    if (recoveryRequired && recoveryRequired !== previousRecoveryRequired) persistDraft();
    for (const listener of listeners) listener();
  }

  function persistDraft(): void {
    if (!storage) return;
    const draft = state.draft;
    const attachments = state.attachments;
    const browserSubmission = state.browserSubmission;
    if (!draft && attachments.length === 0 && !browserSubmission && !pendingSend && !recoveryRequired && recoveredSubmissionIds.size === 0) {
      storage.removeItem(storageKey);
      return;
    }
    storage.setItem(
      storageKey,
      JSON.stringify({
        draft,
        attachments,
        ...(browserSubmission ? { browserSubmission } : {}),
        ...(pendingSend ? { pendingSend } : {}),
        ...(recoveryRequired ? { recoveryRequired } : {}),
        ...(recoveredSubmissionIds.size > 0 ? { recoveredSubmissionIds: [...recoveredSubmissionIds] } : {}),
      } satisfies PersistedDraft),
    );
  }

  function clearDraftIfItStillMatches(envelope: PendingSendEnvelope): void {
    if (state.draft !== envelope.draft || !sameAttachments(state.attachments, envelope.composerAttachments) || !sameBrowserSubmission(state.browserSubmission, envelope.browserSubmission)) {
      return;
    }
    dispatch({ type: 'draft_changed', draft: '' });
    dispatch({ type: 'attachments_changed', attachments: [] });
    dispatch({ type: 'browser_submission_changed', browserSubmission: null });
    recoveredSubmissionIds.clear();
  }

  function rememberRecoveryRequired(error: NativeSessionError): void {
    if (error.recoveryRequired) recoveryRequired = error;
  }

  function reconcilePersistedRecovery(snapshot: NativeConversationSnapshot): void {
    if (!recoveryRequired) return;
    if (snapshotRequiresRecovery(snapshot)) {
      persistDraft();
      return;
    }
    if (pendingSend && acceptedEnvelopeIsDurable(snapshot, pendingSend)) {
      void markEnvelopeBrowserCommentsSent(pendingSend);
      clearDraftIfItStillMatches(pendingSend);
      pendingSend = null;
      recoveryRequired = null;
      dispatch({ type: 'send_succeeded' });
      persistDraft();
      return;
    }
    // 权威快照已经证明原会话可继续时，只清理旧写入门禁；任何未发送内容仍需回到草稿并由用户确认。
    pendingSend = null;
    recoveryRequired = null;
    dispatch({ type: 'send_succeeded' });
    persistDraft();
  }

  async function recoverManualConfirmationDraft(snapshot: NativeConversationSnapshot): Promise<void> {
    const recoverable = snapshot.queue.submissions
      .filter(isManualConfirmationSubmission)
      .sort((left, right) => left.position - right.position || (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id));
    if (recoverable.length === 0) return;

    const unseen = recoverable.filter((submission) => !recoveredSubmissionIds.has(submission.id));
    if (unseen.length > 0) {
      const recoveredText = unseen
        .map((submission) => submission.content.trim())
        .filter(Boolean)
        .join('\n\n');
      const currentDraft = state.draft.trim();
      const nextDraft = !recoveredText || currentDraft === recoveredText ? state.draft : [recoveredText, state.draft].filter((part) => part.trim()).join('\n\n');
      const nextAttachments = mergeAttachments(
        state.attachments,
        unseen.flatMap((submission) => submission.attachments ?? []),
      );
      dispatch({ type: 'draft_changed', draft: nextDraft });
      dispatch({ type: 'attachments_changed', attachments: nextAttachments });
      unseen.forEach((submission) => recoveredSubmissionIds.add(submission.id));
      if (!storage) return;
      try {
        persistDraft();
      } catch {
        // 草稿没有先持久化成功时保留服务端提交，避免恢复确认过程中丢失用户输入。
        unseen.forEach((submission) => recoveredSubmissionIds.delete(submission.id));
        return;
      }
    }

    if (!storage) return;
    for (const submission of recoverable) {
      try {
        const queue = await options.client.deleteNativeQueuedSubmission(options.projectId, options.conversationId, submission.id);
        if (disposed) return;
        dispatch({ type: 'queue_hydrated', queue });
      } catch {
        // 删除确认失败时保留服务端记录；下次权威快照会按 submission id 去重并重试。
      }
    }
  }

  function flushRenderDeltas(): void {
    if (renderDeltaTimer) clearTimeout(renderDeltaTimer);
    renderDeltaTimer = null;
    if (pendingRenderDeltas.size === 0) return;
    const events = [...pendingRenderDeltas.values()];
    pendingRenderDeltas.clear();
    for (const event of events) applyEventImmediately(event);
  }

  function queueRenderDelta(event: NativeConversationEvent): void {
    if (!isEventForController(event)) return;
    const key = renderDeltaKey(event);
    if (!key) {
      flushRenderDeltas();
      applyEventImmediately(event);
      return;
    }
    // Map 的删除再写入保留“最后一次到达”的顺序，避免合并后出现跨 item 的旧顺序。
    pendingRenderDeltas.delete(key);
    pendingRenderDeltas.set(key, event);
    if (!renderDeltaTimer) renderDeltaTimer = setTimeout(flushRenderDeltas, RENDER_DELTA_COALESCE_MS);
  }

  function applyEvent(event: NativeConversationEvent): void {
    if (targetedHydrationBuffer) {
      targetedHydrationBuffer.push(event);
      return;
    }
    if (event.type === 'conversation.item.delta') {
      queueRenderDelta(event);
      return;
    }
    // 完成态、请求态和 turn 边界必须先看到之前所有增量；完成事件本身仍立即到达 reducer。
    flushRenderDeltas();
    applyEventImmediately(event);
  }

  function applyEventImmediately(event: NativeConversationEvent): void {
    if (!isEventForController(event)) return;
    const requestId = eventRequestId(event);
    if (event.type === 'conversation.request.resolved' && requestId) {
      markRequestResolved(requestId, event);
      return;
    }
    const suppressRequestAuthority = event.type === 'conversation.request.created' && requestId !== null && resolvedRequestIds.has(requestId);
    dispatch({ type: 'event_received', event, ...(suppressRequestAuthority ? { suppressRequestAuthority: true } : {}) });
    if (event.type === 'conversation.request.created' && !suppressRequestAuthority) void refreshPendingRequests();
  }

  function markRequestResolved(requestId: string, event?: NativeConversationEvent): void {
    resolvedRequestIds.add(requestId);
    dispatch(event ? { type: 'event_received', event } : { type: 'request_resolved', requestId });
  }

  function resumeEventsAfterRequestResponse(requestId: string): void {
    markRequestResolved(requestId);
    // 用户可能在请求卡片前停留很久，期间本机 WebSocket 已经失活却尚未触发 close。
    // 回答成功后重新建立事件流并读取权威快照，保证行为与 Codex App 一致：
    // 请求解除后继续接收同一轮的后续事件，直到 turn/completed。
    cancelReconnectLoop();
    const attempt = hydrate(true, true);
    const token = connectionToken;
    void attempt.catch(() => scheduleReconnect(token));
  }

  function withoutResolvedRequests(snapshot: NativeConversationSnapshot): NativeConversationSnapshot {
    const requests = snapshot.requests.filter((request) => request.status !== 'pending' || !resolvedRequestIds.has(request.id));
    return requests.length === snapshot.requests.length ? snapshot : { ...snapshot, requests };
  }

  function acceptedEnvelopeIsDurable(snapshot: NativeConversationSnapshot, envelope: PendingSendEnvelope): boolean {
    return (
      snapshot.submissions.some((submission) => submission.clientUserMessageId === envelope.clientUserMessageId) ||
      snapshot.messages.some((message) => message.metadata.clientUserMessageId === envelope.clientUserMessageId) ||
      snapshot.items.some((item) => snapshotItemClientUserMessageId(item) === envelope.clientUserMessageId)
    );
  }

  function acceptedStatus(acceptance: NativeOperationAcceptance): string {
    const submissionStatus = acceptance.submission?.status;
    return typeof submissionStatus === 'string' ? submissionStatus : typeof acceptance.operation.status === 'string' ? acceptance.operation.status : 'accepted';
  }

  async function markEnvelopeBrowserCommentsSent(envelope: PendingSendEnvelope): Promise<void> {
    const browserSubmission = envelope.browserSubmission;
    if (!browserSubmission || envelope.browserCommentsMarked) return;
    const mark =
      options.markBrowserCommentsSent ??
      (typeof window !== 'undefined' && window.zeus?.markBrowserCommentsSent ? (input: { conversationId: string; tabId: string; commentIds: string[] }) => window.zeus!.markBrowserCommentsSent!(input) : undefined);
    if (!mark) return;
    try {
      await mark({
        conversationId: options.conversationId,
        tabId: browserSubmission.tabId,
        commentIds: browserSubmission.commentIds,
      });
      envelope.browserCommentsMarked = true;
      if (pendingSend === envelope) pendingSend = { ...envelope };
      persistDraft();
    } catch {
      // 模型提交已经被服务端接受时不能因本地页面状态同步失败而回滚或重复提交；
      // 下次恢复已接受的 envelope 时仍会重试标记。
    }
  }

  function projectAcceptedEnvelope(envelope: PendingSendEnvelope): void {
    if (!envelope.acceptance) return;
    dispatch({
      type: 'send_started',
      clientUserMessageId: envelope.clientUserMessageId,
      durableClientUserMessageId: envelope.clientUserMessageId,
      draft: envelope.displayText,
      attachments: envelope.composerAttachments,
      submittedAttachments: envelope.attachments,
      browserSubmission: envelope.browserSubmission,
      browserComments: envelope.browserSubmission?.comments ?? [],
      delivery: envelope.delivery,
      previousConversationState: state.conversationState,
    });
    dispatch({ type: 'send_accepted', clientUserMessageId: envelope.clientUserMessageId, status: acceptedStatus(envelope.acceptance) });
  }

  function reconcilePersistedAcceptance(snapshot: NativeConversationSnapshot): void {
    if (pendingSend?.deliveryState !== 'accepted' || !pendingSend.acceptance) return;
    if (acceptedEnvelopeIsDurable(snapshot, pendingSend)) {
      void markEnvelopeBrowserCommentsSent(pendingSend);
      clearDraftIfItStillMatches(pendingSend);
      pendingSend = null;
      dispatch({ type: 'send_succeeded' });
      persistDraft();
      return;
    }
    if (!hasNativeOptimisticItem(state, pendingSend.clientUserMessageId)) projectAcceptedEnvelope(pendingSend);
  }

  async function reconcileAcceptedSend(): Promise<void> {
    const envelope = pendingSend;
    if (!envelope || envelope.deliveryState !== 'accepted' || !envelope.acceptance || disposed) return;
    const buffered: NativeConversationEvent[] = [];
    targetedHydrationBuffer = buffered;
    try {
      const snapshot = await options.client.loadNativeConversation(options.projectId, options.conversationId);
      if (disposed || pendingSend !== envelope) return;
      dispatch({ type: 'snapshot_hydrated', snapshot: withoutResolvedRequests(snapshot) });
      if (acceptedEnvelopeIsDurable(snapshot, envelope)) {
        void markEnvelopeBrowserCommentsSent(envelope);
        clearDraftIfItStillMatches(envelope);
        pendingSend = null;
        dispatch({ type: 'send_succeeded' });
      } else {
        dispatch({
          type: 'send_reconciliation_failed',
          error: {
            message: 'The accepted message is waiting for a durable conversation snapshot.',
            code: 'ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING',
            recoveryRequired: false,
            retryable: true,
          },
        });
      }
      persistDraft();
    } catch (error) {
      if (!disposed && pendingSend === envelope) {
        dispatch({
          type: 'send_reconciliation_failed',
          error: {
            ...toSessionError(error, true),
            message: 'The message was accepted, but its durable conversation snapshot is temporarily unavailable.',
            code: 'ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING',
            recoveryRequired: false,
            retryable: true,
          },
        });
        persistDraft();
      }
    } finally {
      if (targetedHydrationBuffer === buffered) targetedHydrationBuffer = null;
      for (const event of buffered) applyEvent(event);
      flushRenderDeltas();
    }
  }

  function acceptanceFromDurableSnapshot(snapshot: NativeConversationSnapshot, envelope: PendingSendEnvelope): NativeOperationAcceptance {
    const submission = snapshot.submissions.find((candidate) => candidate.clientUserMessageId === envelope.clientUserMessageId);
    return {
      operation: {
        status: submission?.status ?? 'accepted',
        recovered: true,
        clientUserMessageId: envelope.clientUserMessageId,
      },
      conversation: {
        id: snapshot.id,
        recovered: true,
      },
      ...(submission
        ? {
            submission: {
              id: submission.id,
              status: submission.status,
              ...(submission.clientUserMessageId ? { clientUserMessageId: submission.clientUserMessageId } : {}),
              ...(submission.providerTurnId ? { providerTurnId: submission.providerTurnId } : {}),
            },
          }
        : {}),
    };
  }

  async function reconcileFailedSend(envelope: PendingSendEnvelope): Promise<FailedSendReconciliation> {
    const buffered: NativeConversationEvent[] = [];
    targetedHydrationBuffer = buffered;
    try {
      const snapshot = await options.client.loadNativeConversation(options.projectId, options.conversationId);
      if (disposed || pendingSend !== envelope) return { kind: 'unknown' };
      dispatch({ type: 'snapshot_hydrated', snapshot: withoutResolvedRequests(snapshot) });
      if (!acceptedEnvelopeIsDurable(snapshot, envelope)) return { kind: 'absent' };

      const acceptance = acceptanceFromDurableSnapshot(snapshot, envelope);
      pendingSend = { ...envelope, deliveryState: 'accepted', acceptance };
      dispatch({ type: 'send_accepted', clientUserMessageId: envelope.clientUserMessageId, status: acceptedStatus(acceptance) });
      void markEnvelopeBrowserCommentsSent(pendingSend);
      persistDraft();
      return { kind: 'durable', acceptance };
    } catch {
      return { kind: 'unknown' };
    } finally {
      if (targetedHydrationBuffer === buffered) targetedHydrationBuffer = null;
      for (const event of buffered) applyEvent(event);
      flushRenderDeltas();
    }
  }

  function isEventForController(event: NativeConversationEvent): boolean {
    if (event.payload.projectId !== options.projectId || event.payload.conversationId !== options.conversationId) return false;
    if (event.type === 'conversation.transport.changed' || event.type === 'conversation.thread.changed') return true;
    return !event.payload.threadId || !state.providerThreadId || event.payload.threadId === state.providerThreadId;
  }

  async function refreshPendingRequests(): Promise<void> {
    if (disposed) return;
    if (requestRefresh) {
      requestRefreshAgain = true;
      return requestRefresh;
    }
    const token = connectionToken;
    requestRefresh = (async () => {
      do {
        requestRefreshAgain = false;
        const refreshIdentityEpoch = identityEpoch;
        const snapshot = await options.client.loadNativePendingRequests(options.projectId, options.conversationId);
        if (disposed || token !== connectionToken) return;
        if (refreshIdentityEpoch !== identityEpoch || snapshot.conversationId !== options.conversationId) {
          if (requestRefreshAgain) continue;
          return;
        }
        dispatch({ type: 'pending_requests_hydrated', requests: snapshot.requests.filter((request) => !resolvedRequestIds.has(request.id)) });
      } while (requestRefreshAgain && !disposed && token === connectionToken);
    })()
      .catch(() => {
        // Fail closed: keep the pending placeholder when its authoritative detail cannot
        // be loaded. A later request event/reconnect will retry the projection.
      })
      .finally(() => {
        const shouldRefreshAgain = requestRefreshAgain && !disposed;
        requestRefresh = null;
        if (shouldRefreshAgain) {
          requestRefreshAgain = false;
          void refreshPendingRequests();
        }
      });
    return requestRefresh;
  }

  function cancelReconnectLoop(): void {
    reconnectLoopEpoch += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    resolveReconnectTimer?.(false);
    resolveReconnectTimer = null;
    reconnectLoopPromise = null;
  }

  async function waitForReconnectDelay(delayMs: number, epoch: number): Promise<boolean> {
    if (options.reconnectDelay) {
      try {
        await options.reconnectDelay(delayMs);
      } catch {
        return false;
      }
      return !disposed && epoch === reconnectLoopEpoch;
    }
    return new Promise<boolean>((resolve) => {
      resolveReconnectTimer = resolve;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        resolveReconnectTimer = null;
        resolve(!disposed && epoch === reconnectLoopEpoch);
      }, delayMs);
    });
  }

  function scheduleReconnect(token: number): void {
    if (disposed || token !== connectionToken || reconnectLoopPromise) return;
    const epoch = ++reconnectLoopEpoch;
    const loop = (async () => {
      let attempt = 0;
      while (!disposed && epoch === reconnectLoopEpoch) {
        dispatch({ type: 'transport_changed', transportState: 'reconnecting', reconnectAttempt: attempt + 1 });
        const delayMs = reconnectDelayMs(attempt + 1);
        if (!(await waitForReconnectDelay(delayMs, epoch))) return;
        try {
          await hydrate(true, true);
          if (!disposed && epoch === reconnectLoopEpoch && state.transportState === 'ready') return;
        } catch {
          // Keep retrying with capped exponential backoff until a connection succeeds,
          // a manual reconnect replaces this loop, or the controller is disposed.
        }
        attempt += 1;
      }
    })();
    reconnectLoopPromise = loop;
    void loop.finally(() => {
      if (reconnectLoopPromise === loop) reconnectLoopPromise = null;
    });
  }

  function observeSocket(nextSocket: WebSocket, token: number, onDisconnected: () => void): SocketLifecycle {
    let active = true;
    let disconnected = false;
    let opened = nextSocket.readyState === 1;
    let resolveOpen!: () => void;
    let rejectOpen!: (error: Error) => void;
    const openedPromise = opened
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          resolveOpen = resolve;
          rejectOpen = reject;
        });
    const eventTarget = nextSocket as WebSocket & {
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
    };

    if (typeof eventTarget.addEventListener !== 'function') {
      return { opened: Promise.resolve(), isDisconnected: () => false, markInactive: () => undefined };
    }

    const handleOpen = (): void => {
      if (!active || opened) return;
      opened = true;
      resolveOpen();
    };
    const handleDisconnect = (): void => {
      if (!active || disconnected) return;
      disconnected = true;
      if (!opened) rejectOpen(new Error('Zeus event socket disconnected before opening.'));
      onDisconnected();
    };
    eventTarget.addEventListener('open', handleOpen);
    eventTarget.addEventListener('close', handleDisconnect);
    eventTarget.addEventListener('error', handleDisconnect);

    return {
      opened: openedPromise,
      isDisconnected: () => disconnected,
      markInactive() {
        active = false;
        eventTarget.removeEventListener?.('open', handleOpen);
        eventTarget.removeEventListener?.('close', handleDisconnect);
        eventTarget.removeEventListener?.('error', handleDisconnect);
      },
    };
  }

  async function hydrate(reconnecting: boolean, canRefreshSocketConfig: boolean): Promise<void> {
    if (disposed) return;
    flushRenderDeltas();
    const token = ++connectionToken;
    socketLifecycle?.markInactive();
    socket?.close();
    socket = null;
    socketLifecycle = null;
    dispatch({ type: 'transport_changed', transportState: reconnecting ? 'reconnecting' : 'connecting', error: null });

    const buffered: NativeConversationEvent[] = [];
    let hydrating = true;
    let ready = false;
    const onEvent = (event: NativeRealtimeEventEnvelope): void => {
      if (disposed || token !== connectionToken || !isNativeConversationEvent(event)) return;
      if (hydrating) buffered.push(event);
      else applyEvent(event);
    };
    const eventOptions = reconnecting && state.lastEventId ? { afterEventId: state.lastEventId } : undefined;

    try {
      const nextSocket = options.client.connectEvents(onEvent, eventOptions);
      socket = nextSocket;
      const lifecycle = observeSocket(nextSocket, token, () => {
        if (ready) scheduleReconnect(token);
      });
      socketLifecycle = lifecycle;
      try {
        await lifecycle.opened;
      } catch (socketError) {
        lifecycle.markInactive();
        if (socket === nextSocket) socket = null;
        nextSocket.close();
        if (!canRefreshSocketConfig || disposed || token !== connectionToken) throw socketError;
        // An HTTP read refreshes Electron Main's rotated local-server base URL. Discard
        // this unbuffered read, reconnect the socket, then perform the authoritative GET.
        await options.client.loadNativeConversation(options.projectId, options.conversationId);
        if (disposed || token !== connectionToken) return;
        return hydrate(true, false);
      }

      if (lifecycle.isDisconnected()) throw new SocketDisconnectedDuringHydrationError();
      dispatch({ type: 'transport_changed', transportState: 'hydrating' });
      const snapshot = await options.client.loadNativeConversation(options.projectId, options.conversationId);
      if (disposed || token !== connectionToken) return;
      if (lifecycle.isDisconnected()) throw new SocketDisconnectedDuringHydrationError();
      dispatch({ type: 'snapshot_hydrated', snapshot: withoutResolvedRequests(snapshot) });
      reconcilePersistedRecovery(snapshot);
      await recoverManualConfirmationDraft(snapshot);
      reconcilePersistedAcceptance(snapshot);
      for (const event of buffered) applyEvent(event);
      hydrating = false;
      ready = true;
      dispatch({ type: 'transport_changed', transportState: 'ready', error: recoveryRequired });
    } catch (error) {
      hydrating = false;
      const shouldScheduleReconnect = !disposed && token === connectionToken && (error instanceof SocketDisconnectedDuringHydrationError || socketLifecycle?.isDisconnected() === true);
      if (!disposed && token === connectionToken) {
        socketLifecycle?.markInactive();
        socketLifecycle = null;
        const failedSocket = socket;
        socket = null;
        failedSocket?.close();
        dispatch({ type: 'transport_changed', transportState: 'failed', error: toSessionError(error, true) });
      }
      if (shouldScheduleReconnect) scheduleReconnect(token);
      throw error;
    }
  }

  function runOperation<T>(key: string, execute: () => Promise<T>, apply: (result: T) => void | Promise<void>, clearErrorOnSuccess = true, allowDuringRecovery = false): Promise<T> {
    if (recoveryRequired && !allowDuringRecovery) return Promise.reject(sessionWriteBlockedError(recoveryRequired));
    if (activeOperation) {
      if (activeOperation.key === key) return activeOperation.promise as Promise<T>;
      return Promise.reject(new Error(`Session operation already in progress: ${activeOperation.key}`));
    }
    dispatch({ type: 'operation_started', operation: key });
    const promise = execute()
      .then(async (result) => {
        await apply(result);
        dispatch({ type: 'operation_finished', operation: key, ...(clearErrorOnSuccess ? { error: null } : {}) });
        return result;
      })
      .catch((error) => {
        const sessionError = toSessionError(error, true);
        rememberRecoveryRequired(sessionError);
        dispatch({ type: 'operation_finished', operation: key, error: sessionError });
        persistDraft();
        throw error;
      })
      .finally(() => {
        if (activeOperation?.promise === promise) activeOperation = null;
      });
    activeOperation = { key, promise };
    return promise;
  }

  const controller: SessionController = {
    start() {
      if (state.transportState === 'ready') return Promise.resolve();
      if (!startPromise) {
        cancelReconnectLoop();
        const attempt = hydrate(false, true);
        const tracked = attempt.finally(() => {
          if (startPromise === tracked) startPromise = null;
        });
        startPromise = tracked;
      }
      return startPromise;
    },
    reconnect() {
      cancelReconnectLoop();
      dispatch({ type: 'transport_changed', transportState: 'reconnecting', reconnectAttempt: 1 });
      return hydrate(true, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (renderDeltaTimer) clearTimeout(renderDeltaTimer);
      renderDeltaTimer = null;
      pendingRenderDeltas.clear();
      cancelReconnectLoop();
      connectionToken += 1;
      socketLifecycle?.markInactive();
      socketLifecycle = null;
      socket?.close();
      socket = null;
      listeners.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    setDraft(draft) {
      if (pendingSend && pendingSend.deliveryState !== 'accepted' && !recoveryRequired && pendingSend.draft !== draft) pendingSend = null;
      dispatch({ type: 'draft_changed', draft });
      persistDraft();
    },
    setAttachments(attachments) {
      if (pendingSend && pendingSend.deliveryState !== 'accepted' && !recoveryRequired && !sameAttachments(pendingSend.composerAttachments, attachments)) pendingSend = null;
      dispatch({ type: 'attachments_changed', attachments: [...attachments] });
      persistDraft();
    },
    setBrowserSubmission(browserSubmission) {
      if (pendingSend && pendingSend.deliveryState !== 'accepted' && !recoveryRequired && !sameBrowserSubmission(pendingSend.browserSubmission, browserSubmission)) {
        pendingSend = null;
      }
      dispatch({
        type: 'browser_submission_changed',
        browserSubmission: browserSubmission ? structuredClone(browserSubmission) : null,
      });
      persistDraft();
    },
    setPermissionMode(permissionMode) {
      if (state.conversationState !== 'native_idle' || state.transportState !== 'ready') return Promise.reject(new Error('Conversation permission mode can change only while the conversation is idle.'));
      return runOperation(
        `permission-mode:${permissionMode}`,
        () => options.client.updateNativePermissionMode(options.projectId, options.conversationId, permissionMode),
        (snapshot) => dispatch({ type: 'snapshot_hydrated', snapshot: withoutResolvedRequests(snapshot) }),
      );
    },
    setCollaborationMode(collaborationMode) {
      return runOperation(
        `collaboration-mode:${collaborationMode}`,
        () => options.client.updateNativeCollaborationMode(options.projectId, options.conversationId, collaborationMode),
        (snapshot) => dispatch({ type: 'snapshot_hydrated', snapshot: withoutResolvedRequests(snapshot) }),
      );
    },
    setNextTurnSettings(settings) {
      return options.client.updateNativeNextTurnSettings(options.projectId, options.conversationId, settings).then((updated) => {
        if (!disposed) dispatch({ type: 'next_turn_settings_changed', settings: updated });
        return updated;
      });
    },
    send(delivery, expectedTurnId, settings) {
      if (recoveryRequired) return Promise.reject(sessionWriteBlockedError(recoveryRequired));
      const normalizedExpectedTurnId = expectedTurnId || undefined;
      const requestedCollaborationMode = settings?.collaborationMode ?? state.snapshot?.collaborationMode ?? 'default';
      const requestedPermissionMode = settings?.permissionMode ?? state.snapshot?.nextTurnSettings?.permissionMode ?? state.snapshot?.permissionMode;
      if (activeOperation) {
        const pendingOperation = pendingSend ? `send:${pendingSend.fingerprint}` : null;
        if (
          pendingSend &&
          activeOperation.key === pendingOperation &&
          pendingSend.delivery === delivery &&
          pendingSend.expectedTurnId === normalizedExpectedTurnId &&
          pendingSend.model === settings?.model &&
          pendingSend.agentKind === settings?.agentKind &&
          pendingSend.effort === settings?.effort &&
          pendingSend.serviceTier === settings?.serviceTier &&
          pendingSend.permissionMode === requestedPermissionMode &&
          pendingSend.collaborationMode === requestedCollaborationMode
        ) {
          return activeOperation.promise as Promise<NativeOperationAcceptance>;
        }
        return Promise.reject(new Error(`Session operation already in progress: ${activeOperation.key}`));
      }
      const draft = state.draft;
      const composerAttachments = [...state.attachments];
      const browserSubmission = state.browserSubmission ? structuredClone(state.browserSubmission) : null;
      if (!draft.trim() && composerAttachments.length === 0 && !browserSubmission) {
        return Promise.reject(new Error('Conversation message content, attachments, or browser comments are required.'));
      }
      const attachments = mergeAttachments(composerAttachments, browserSubmission?.attachments ?? []);
      const displayText = draft.trim() || (browserSubmission ? `Browser comments (${browserSubmission.commentIds.length})` : '');
      const content = browserSubmission ? [draft.trim(), browserSubmission.content.trim()].filter(Boolean).join('\n\n') : draft;
      const appliedSettings = delivery === 'queue' ? settings : undefined;
      const fingerprint = sendFingerprint({
        content,
        displayText,
        attachments,
        ...(browserSubmission?.comments.length ? { browserComments: browserSubmission.comments } : {}),
        delivery,
        ...(normalizedExpectedTurnId ? { expectedTurnId: normalizedExpectedTurnId } : {}),
        ...(appliedSettings?.model ? { model: appliedSettings.model } : {}),
        ...(appliedSettings?.agentKind ? { agentKind: appliedSettings.agentKind } : {}),
        ...(appliedSettings?.effort ? { effort: appliedSettings.effort } : {}),
        ...(appliedSettings && Object.prototype.hasOwnProperty.call(appliedSettings, 'serviceTier') ? { serviceTier: appliedSettings.serviceTier } : {}),
        ...(appliedSettings ? { permissionMode: appliedSettings.permissionMode } : {}),
        collaborationMode: requestedCollaborationMode,
      });
      if (!pendingSend || pendingSend.fingerprint !== fingerprint) {
        const reusableIdentity =
          pendingSend &&
          pendingSend.deliveryState !== 'accepted' &&
          pendingSend.content === content &&
          pendingSend.displayText === displayText &&
          pendingSend.draft === draft &&
          sameAttachments(pendingSend.attachments, attachments) &&
          sameAttachments(pendingSend.composerAttachments, composerAttachments) &&
          sameBrowserSubmission(pendingSend.browserSubmission, browserSubmission) &&
          pendingSend.delivery === delivery &&
          pendingSend.expectedTurnId === normalizedExpectedTurnId &&
          pendingSend.model === appliedSettings?.model &&
          pendingSend.agentKind === appliedSettings?.agentKind &&
          pendingSend.effort === appliedSettings?.effort &&
          pendingSend.permissionMode === (appliedSettings ? appliedSettings.permissionMode : undefined) &&
          pendingSend.collaborationMode === requestedCollaborationMode
            ? pendingSend
            : null;
        pendingSend = {
          fingerprint,
          content,
          displayText,
          draft,
          attachments,
          composerAttachments,
          browserSubmission,
          delivery,
          ...(normalizedExpectedTurnId ? { expectedTurnId: normalizedExpectedTurnId } : {}),
          ...(appliedSettings?.model ? { model: appliedSettings.model } : {}),
          ...(appliedSettings?.agentKind ? { agentKind: appliedSettings.agentKind } : {}),
          ...(appliedSettings?.effort ? { effort: appliedSettings.effort } : {}),
          ...(appliedSettings && Object.prototype.hasOwnProperty.call(appliedSettings, 'serviceTier') ? { serviceTier: appliedSettings.serviceTier } : {}),
          ...(appliedSettings ? { permissionMode: appliedSettings.permissionMode } : {}),
          collaborationMode: requestedCollaborationMode,
          // provider 尚未接受的失败提交只调整服务档位时，沿用原幂等身份重试。
          idempotencyKey: reusableIdentity?.idempotencyKey ?? createId(),
          clientUserMessageId: reusableIdentity?.clientUserMessageId ?? createId(),
        };
      }
      const envelope = pendingSend;
      persistDraft();
      const operation = `send:${envelope.fingerprint}`;
      const previousConversationState = state.conversationState;
      return runOperation(
        operation,
        async () => {
          dispatch({
            type: 'send_started',
            clientUserMessageId: envelope.clientUserMessageId,
            durableClientUserMessageId: envelope.clientUserMessageId,
            draft: envelope.displayText,
            attachments: envelope.composerAttachments,
            submittedAttachments: envelope.attachments,
            browserSubmission: envelope.browserSubmission,
            browserComments: envelope.browserSubmission?.comments ?? [],
            delivery,
            previousConversationState,
          });
          if (envelope.deliveryState === 'accepted' && envelope.acceptance) {
            dispatch({ type: 'send_accepted', clientUserMessageId: envelope.clientUserMessageId, status: acceptedStatus(envelope.acceptance) });
            void markEnvelopeBrowserCommentsSent(envelope);
            return envelope.acceptance;
          }
          try {
            const acceptance = await options.client.sendNativeMessage(options.projectId, options.conversationId, {
              content: envelope.content,
              ...(envelope.displayText ? { displayText: envelope.displayText } : {}),
              attachments: envelope.attachments,
              ...(envelope.browserSubmission?.comments.length ? { browserComments: envelope.browserSubmission.comments } : {}),
              delivery: envelope.delivery,
              ...(envelope.expectedTurnId ? { expectedTurnId: envelope.expectedTurnId } : {}),
              ...(envelope.model ? { model: envelope.model } : {}),
              ...(envelope.agentKind ? { agentKind: envelope.agentKind } : {}),
              ...(envelope.effort ? { effort: envelope.effort } : {}),
              ...(Object.prototype.hasOwnProperty.call(envelope, 'serviceTier') ? { serviceTier: envelope.serviceTier } : {}),
              ...(envelope.permissionMode ? { permissionMode: envelope.permissionMode } : {}),
              collaborationMode: envelope.collaborationMode,
              idempotencyKey: envelope.idempotencyKey,
              clientUserMessageId: envelope.clientUserMessageId,
            });
            pendingSend = { ...envelope, deliveryState: 'accepted', acceptance };
            dispatch({ type: 'send_accepted', clientUserMessageId: envelope.clientUserMessageId, status: acceptedStatus(acceptance) });
            void markEnvelopeBrowserCommentsSent(pendingSend);
            persistDraft();
            return acceptance;
          } catch (error) {
            const reconciliation = await reconcileFailedSend(envelope);
            if (reconciliation.kind === 'durable') return reconciliation.acceptance;
            const sessionError = toSessionError(error, true);
            rememberRecoveryRequired(sessionError);
            dispatch(
              reconciliation.kind === 'unknown'
                ? {
                    type: 'send_uncertain',
                    clientUserMessageId: envelope.clientUserMessageId,
                    draft: envelope.draft,
                    attachments: envelope.composerAttachments,
                    browserSubmission: envelope.browserSubmission,
                    previousConversationState,
                    error: sessionError,
                  }
                : {
                    type: 'send_failed',
                    clientUserMessageId: envelope.clientUserMessageId,
                    draft: envelope.draft,
                    attachments: envelope.composerAttachments,
                    browserSubmission: envelope.browserSubmission,
                    previousConversationState,
                    error: sessionError,
                  },
            );
            persistDraft();
            throw error;
          }
        },
        () => reconcileAcceptedSend(),
        false,
      );
    },
    editQueuedSubmission(submissionId, content) {
      return runOperation(
        `queue:edit:${submissionId}:${JSON.stringify(content)}`,
        () => options.client.editNativeQueuedSubmission(options.projectId, options.conversationId, submissionId, content),
        (queue) => dispatch({ type: 'queue_hydrated', queue }),
      );
    },
    deleteQueuedSubmission(submissionId) {
      return runOperation(
        `queue:delete:${submissionId}`,
        () => options.client.deleteNativeQueuedSubmission(options.projectId, options.conversationId, submissionId),
        (queue) => dispatch({ type: 'queue_hydrated', queue }),
        false,
        true,
      );
    },
    reorderQueue(orderedSubmissionIds) {
      return runOperation(
        `queue:reorder:${JSON.stringify(orderedSubmissionIds)}`,
        () => options.client.reorderNativeQueue(options.projectId, options.conversationId, orderedSubmissionIds),
        (queue) => dispatch({ type: 'queue_hydrated', queue }),
      );
    },
    sendQueuedNow(submissionId) {
      return runOperation(
        `queue:send-now:${submissionId}`,
        () => options.client.sendNativeQueuedNow(options.projectId, options.conversationId, submissionId),
        (acceptance) => {
          if (!acceptance.submission) return;
          dispatch({ type: 'steering_submission_hydrated', submission: acceptance.submission as unknown as NativeQueuedSubmission });
        },
      );
    },
    resumeQueue() {
      return runOperation(
        'queue:resume',
        () => options.client.resumeNativeQueue(options.projectId, options.conversationId),
        (queue) => dispatch({ type: 'queue_hydrated', queue }),
      );
    },
    recoverQueue() {
      return runOperation(
        'queue:recover',
        () => options.client.recoverNativeQueue(options.projectId, options.conversationId),
        (queue) => dispatch({ type: 'queue_hydrated', queue }),
        true,
        true,
      );
    },
    restoreArchivedConversation() {
      return runOperation(
        'provider-thread:restore',
        () => options.client.restoreArchivedNativeConversation(options.projectId, options.conversationId),
        (snapshot) => dispatch({ type: 'snapshot_hydrated', snapshot: withoutResolvedRequests(snapshot) }),
      );
    },
    interruptActiveTurn() {
      const turnId = state.activeTurnId;
      if (!turnId || state.startedTurnId !== turnId) return Promise.reject(new Error('A matching started turn is required before interrupt.'));
      const operation = `interrupt:${turnId}`;
      if (activeOperation) {
        if (activeOperation.key === operation) return activeOperation.promise as Promise<NativeOperationAcceptance>;
        return Promise.reject(new Error(`Session operation already in progress: ${activeOperation.key}`));
      }
      const previousConversationState = state.conversationState;
      dispatch({ type: 'interrupt_started', turnId });
      return runOperation(
        operation,
        () => options.client.interruptNativeTurn(options.projectId, options.conversationId, turnId),
        () => undefined,
      ).catch((error) => {
        dispatch({ type: 'interrupt_failed', previousConversationState, error: toSessionError(error, true) });
        throw error;
      });
    },
    respondToRequest(requestId, response) {
      return runOperation(
        `request:respond:${requestId}:${JSON.stringify(response)}`,
        () => options.client.respondToNativeRequest(options.projectId, options.conversationId, requestId, response),
        () => resumeEventsAfterRequestResponse(requestId),
      );
    },
    snoozeRequest(requestId) {
      return runOperation(
        `request:snooze:${requestId}`,
        () => options.client.snoozeNativeRequest(options.projectId, options.conversationId, requestId),
        ({ request }) =>
          dispatch({
            type: 'pending_requests_hydrated',
            requests: state.pendingRequests.map((candidate) => (candidate.id === request.id ? request : candidate)),
          }),
      );
    },
    respondToPlanImplementationRequest(requestId, input) {
      return runOperation(
        `plan-request:${requestId}:${JSON.stringify(input)}`,
        () => options.client.respondToPlanImplementationRequest(options.projectId, options.conversationId, requestId, input),
        ({ conversation }) =>
          dispatch({
            type: 'snapshot_hydrated',
            snapshot: withoutResolvedRequests(conversation),
          }),
      ).then(() => undefined);
    },
  };
  return controller;
}

export interface UseSessionControllerResult {
  state: NativeSessionState;
  controller: SessionController;
}

export function useSessionController(options: CreateSessionControllerOptions): UseSessionControllerResult {
  const controller = useMemo(() => createSessionController(options), [options.client, options.projectId, options.conversationId, options.initialCachedState, options.initialOptimisticState, options.storage, options.createId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => {
    void controller.start().catch(() => undefined);
    return () => controller.dispose();
  }, [controller]);
  return { state, controller };
}

function browserStorage(): SessionDraftStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function readPersistedDraft(storage: SessionDraftStorage | undefined, key: string): PersistedDraft {
  const empty: PersistedDraft = { draft: '', attachments: [] };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(key);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<PersistedDraft>;
    const attachments = Array.isArray(parsed.attachments) ? parsed.attachments.filter(isNativeAttachment) : [];
    const browserSubmission = isBrowserPreparedSubmission(parsed.browserSubmission) ? parsed.browserSubmission : null;
    const pendingCandidate = isPendingSendEnvelope(parsed.pendingSend) ? parsed.pendingSend : undefined;
    const pending = pendingCandidate ? { ...pendingCandidate, collaborationMode: pendingCandidate.collaborationMode ?? 'default' } : undefined;
    const recoveryRequired = isPersistedRecoveryRequired(parsed.recoveryRequired) ? parsed.recoveryRequired : undefined;
    const recoveredSubmissionIds = Array.isArray(parsed.recoveredSubmissionIds) ? parsed.recoveredSubmissionIds.filter((id): id is string => typeof id === 'string' && Boolean(id)) : [];
    const persistedDraft = typeof parsed.draft === 'string' ? parsed.draft : '';
    const restorePendingInput = pending && pending.deliveryState !== 'accepted' && !persistedDraft && attachments.length === 0 && !browserSubmission;
    return {
      draft: restorePendingInput ? pending.draft : persistedDraft || (pending && parsed.draft === undefined ? pending.draft : ''),
      attachments: restorePendingInput ? pending.composerAttachments : attachments,
      browserSubmission: restorePendingInput ? pending.browserSubmission : browserSubmission,
      ...(pending ? { pendingSend: pending } : {}),
      ...(recoveryRequired ? { recoveryRequired } : {}),
      ...(recoveredSubmissionIds.length > 0 ? { recoveredSubmissionIds } : {}),
    };
  } catch {
    return empty;
  }
}

function isPendingSendEnvelope(value: unknown): value is PendingSendEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const pending = value as Partial<PendingSendEnvelope>;
  return (
    typeof pending.fingerprint === 'string' &&
    typeof pending.content === 'string' &&
    typeof pending.displayText === 'string' &&
    typeof pending.draft === 'string' &&
    Array.isArray(pending.attachments) &&
    pending.attachments.every(isNativeAttachment) &&
    Array.isArray(pending.composerAttachments) &&
    pending.composerAttachments.every(isNativeAttachment) &&
    (pending.browserSubmission === null || isBrowserPreparedSubmission(pending.browserSubmission)) &&
    (pending.delivery === 'queue' || pending.delivery === 'steer_now') &&
    (pending.expectedTurnId === undefined || typeof pending.expectedTurnId === 'string') &&
    (pending.model === undefined || typeof pending.model === 'string') &&
    (pending.effort === undefined || typeof pending.effort === 'string') &&
    (pending.serviceTier === undefined || pending.serviceTier === null || typeof pending.serviceTier === 'string') &&
    (pending.permissionMode === undefined || pending.permissionMode === 'read-only' || pending.permissionMode === 'auto' || pending.permissionMode === 'full-access') &&
    (pending.collaborationMode === undefined || pending.collaborationMode === 'default' || pending.collaborationMode === 'plan') &&
    typeof pending.idempotencyKey === 'string' &&
    typeof pending.clientUserMessageId === 'string' &&
    (pending.deliveryState === undefined || pending.deliveryState === 'pending' || pending.deliveryState === 'accepted') &&
    (pending.acceptance === undefined || isNativeOperationAcceptance(pending.acceptance)) &&
    (pending.browserCommentsMarked === undefined || typeof pending.browserCommentsMarked === 'boolean') &&
    (pending.deliveryState !== 'accepted' || isNativeOperationAcceptance(pending.acceptance))
  );
}

function isBrowserPreparedSubmission(value: unknown): value is ZeusBrowserPreparedSubmission {
  if (typeof value !== 'object' || value === null) return false;
  const submission = value as Partial<ZeusBrowserPreparedSubmission>;
  return (
    typeof submission.tabId === 'string' &&
    Boolean(submission.tabId) &&
    typeof submission.content === 'string' &&
    Array.isArray(submission.commentIds) &&
    submission.commentIds.length > 0 &&
    submission.commentIds.every((id) => typeof id === 'string' && Boolean(id)) &&
    Array.isArray(submission.comments) &&
    submission.comments.length === submission.commentIds.length &&
    submission.comments.every((comment) => typeof comment === 'object' && comment !== null && typeof comment.id === 'string' && typeof comment.body === 'string') &&
    Array.isArray(submission.attachments) &&
    submission.attachments.every(isNativeAttachment)
  );
}

function isNativeOperationAcceptance(value: unknown): value is NativeOperationAcceptance {
  if (typeof value !== 'object' || value === null) return false;
  const acceptance = value as Partial<NativeOperationAcceptance>;
  return typeof acceptance.operation === 'object' && acceptance.operation !== null && typeof acceptance.conversation === 'object' && acceptance.conversation !== null && typeof acceptance.conversation.id === 'string';
}

function isPersistedRecoveryRequired(value: unknown): value is NativeSessionError {
  if (typeof value !== 'object' || value === null) return false;
  const error = value as Partial<NativeSessionError>;
  return (
    typeof error.message === 'string' &&
    (typeof error.code === 'string' || error.code === null) &&
    error.recoveryRequired === true &&
    error.retryable === false &&
    (error.status === undefined || (typeof error.status === 'number' && Number.isFinite(error.status)))
  );
}

function nativeOptimisticKey(state: NativeSessionState, clientUserMessageId: string): string {
  return [state.conversationId ?? 'pending-conversation', state.providerThreadId ?? 'pending-thread', `pending:${clientUserMessageId}`, clientUserMessageId].map((part) => encodeURIComponent(part)).join('/');
}

function hasNativeOptimisticItem(state: NativeSessionState, clientUserMessageId: string): boolean {
  const directItem = state.items[nativeOptimisticKey(state, clientUserMessageId)];
  return Boolean(directItem?.optimistic || Object.values(state.items).some((item) => item.optimistic && (item.clientUserMessageId === clientUserMessageId || item.durableClientUserMessageId === clientUserMessageId)));
}

function isNativeAttachment(value: unknown): value is NativeConversationAttachment {
  if (typeof value !== 'object' || value === null) return false;
  const attachment = value as { name?: unknown; mime?: unknown; size?: unknown; localPath?: unknown; uploadRef?: unknown };
  const paths = (typeof attachment.localPath === 'string' && attachment.localPath ? 1 : 0) + (typeof attachment.uploadRef === 'string' && attachment.uploadRef ? 1 : 0);
  return typeof attachment.name === 'string' && typeof attachment.mime === 'string' && Number.isSafeInteger(attachment.size) && Number(attachment.size) >= 0 && paths === 1;
}

function sendFingerprint(input: Omit<SendNativeMessageRequest, 'idempotencyKey' | 'clientUserMessageId'>): string {
  return JSON.stringify(input);
}

function sameAttachments(left: NativeConversationAttachment[], right: NativeConversationAttachment[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBrowserSubmission(left: ZeusBrowserPreparedSubmission | null, right: ZeusBrowserPreparedSubmission | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeAttachments(left: NativeConversationAttachment[], right: NativeConversationAttachment[]): NativeConversationAttachment[] {
  const merged = new Map<string, NativeConversationAttachment>();
  for (const attachment of [...left, ...right]) {
    const key = 'localPath' in attachment ? `local:${attachment.localPath}` : `upload:${attachment.uploadRef}`;
    if (!merged.has(key)) merged.set(key, attachment);
  }
  return [...merged.values()];
}

function eventRequestId(event: NativeConversationEvent): string | null {
  const requestId = event.payload.requestId;
  return typeof requestId === 'string' && requestId.trim() ? requestId : null;
}

function renderDeltaKey(event: NativeConversationEvent): string | null {
  if (event.type !== 'conversation.item.delta') return null;
  const { conversationId, generationId, threadId, turnId, itemId } = event.payload;
  if (!threadId || !turnId || !itemId) return null;
  return [conversationId, generationId, threadId, turnId, itemId].join(':');
}

function snapshotRequiresRecovery(snapshot: NativeConversationSnapshot): boolean {
  return (
    (snapshot.queue.state.type === 'paused' && snapshot.queue.state.reason === 'recovery_required') || snapshot.submissions.some((submission) => submission.status === 'recovery_required' || submission.pausedReason === 'recovery_required')
  );
}

function snapshotItemClientUserMessageId(item: { type: string; payload: Record<string, unknown> }): string | null {
  const normalizedType = item.type.toLocaleLowerCase().replace(/[\s_\-/]+/gu, '');
  if (normalizedType !== 'usermessage' && normalizedType !== 'user') return null;
  const clientId = item.payload.clientId ?? item.payload.clientUserMessageId;
  return typeof clientId === 'string' && clientId.trim() ? clientId : null;
}

function isManualConfirmationSubmission(submission: NativeQueuedSubmission): boolean {
  return (submission.status === 'queued' || submission.status === 'paused') && submission.pausedReason === 'user_confirmation' && !submission.providerTurnId;
}

function sessionWriteBlockedError(error: NativeSessionError): Error & {
  error: string | null;
  recoveryRequired: true;
  retryable: false;
  status?: number;
} {
  return Object.assign(new Error(error.message), {
    error: error.code,
    recoveryRequired: true as const,
    retryable: false as const,
    ...(error.status === undefined ? {} : { status: error.status }),
  });
}

function toSessionError(error: unknown, retryable: boolean): NativeSessionError {
  if (typeof error === 'object' && error !== null) {
    const value = error as { message?: unknown; error?: unknown; recoveryRequired?: unknown; status?: unknown; operation?: unknown };
    const code = typeof value.error === 'string' ? value.error : null;
    const operation = typeof value.operation === 'object' && value.operation !== null ? (value.operation as { status?: unknown }) : null;
    const recoveryRequired = value.recoveryRequired === true || code === 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED' || operation?.status === 'recovery_required';
    return {
      message: typeof value.message === 'string' ? value.message : String(error),
      code,
      recoveryRequired,
      retryable: !recoveryRequired && retryable,
      ...(typeof value.status === 'number' ? { status: value.status } : {}),
    };
  }
  return { message: String(error), code: null, recoveryRequired: false, retryable };
}

function defaultCreateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
