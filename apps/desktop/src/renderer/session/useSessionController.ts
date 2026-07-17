import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createInitialSessionState, sessionReducer } from './sessionReducer.js';
import {
  isNativeConversationEvent,
  type NativeConversationAttachment,
  type NativeConversationEvent,
  type NativeConversationSnapshot,
  type NativeOperationAcceptance,
  type NativePendingRequest,
  type NativePermissionMode,
  type NativeQueueSnapshot,
  type NativeRealtimeEventEnvelope,
  type NativeSessionError,
  type NativeSessionState,
  type SendNativeMessageRequest,
} from './sessionTypes.js';

export interface SessionControllerClient {
  loadNativeConversation(projectId: string, conversationId: string): Promise<NativeConversationSnapshot>;
  updateNativePermissionMode(projectId: string, conversationId: string, permissionMode: NativePermissionMode): Promise<NativeConversationSnapshot>;
  connectEvents(onEvent: (event: NativeRealtimeEventEnvelope) => void, options?: { afterEventId?: string }): WebSocket;
  sendNativeMessage(projectId: string, conversationId: string, input: SendNativeMessageRequest): Promise<NativeOperationAcceptance>;
  editNativeQueuedSubmission(projectId: string, conversationId: string, submissionId: string, content: string): Promise<NativeQueueSnapshot>;
  deleteNativeQueuedSubmission(projectId: string, conversationId: string, submissionId: string): Promise<NativeQueueSnapshot>;
  reorderNativeQueue(projectId: string, conversationId: string, orderedSubmissionIds: string[]): Promise<NativeQueueSnapshot>;
  sendNativeQueuedNow(projectId: string, conversationId: string, submissionId: string): Promise<NativeOperationAcceptance>;
  resumeNativeQueue(projectId: string, conversationId: string): Promise<NativeQueueSnapshot>;
  interruptNativeTurn(projectId: string, conversationId: string, turnId: string): Promise<NativeOperationAcceptance>;
  respondToNativeRequest(projectId: string, conversationId: string, requestId: string, response: Record<string, unknown>): Promise<{ operation: Record<string, unknown>; request: NativePendingRequest }>;
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
  storage?: SessionDraftStorage;
  createId?: () => string;
  reconnectDelay?: (delayMs: number) => Promise<void>;
}

export interface SessionController {
  start(): Promise<void>;
  reconnect(): Promise<void>;
  dispose(): void;
  subscribe(listener: () => void): () => void;
  getState(): NativeSessionState;
  setDraft(draft: string): void;
  setAttachments(attachments: NativeConversationAttachment[]): void;
  send(delivery: 'queue' | 'steer_now', expectedTurnId?: string): Promise<NativeOperationAcceptance>;
  editQueuedSubmission(submissionId: string, content: string): Promise<NativeQueueSnapshot>;
  deleteQueuedSubmission(submissionId: string): Promise<NativeQueueSnapshot>;
  reorderQueue(orderedSubmissionIds: string[]): Promise<NativeQueueSnapshot>;
  sendQueuedNow(submissionId: string): Promise<NativeOperationAcceptance>;
  resumeQueue(): Promise<NativeQueueSnapshot>;
  interruptActiveTurn(): Promise<NativeOperationAcceptance>;
  respondToRequest(requestId: string, response: Record<string, unknown>): Promise<{ operation: Record<string, unknown>; request: NativePendingRequest }>;
  setPermissionMode(permissionMode: NativePermissionMode): Promise<NativeConversationSnapshot>;
}

interface PendingSendEnvelope {
  fingerprint: string;
  content: string;
  attachments: NativeConversationAttachment[];
  delivery: 'queue' | 'steer_now';
  expectedTurnId?: string;
  idempotencyKey: string;
  clientUserMessageId: string;
  deliveryState?: 'pending' | 'accepted';
  acceptance?: NativeOperationAcceptance;
}

interface PersistedDraft {
  draft: string;
  attachments: NativeConversationAttachment[];
  pendingSend?: PendingSendEnvelope;
  recoveryRequired?: NativeSessionError;
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
  let state: NativeSessionState = {
    ...createInitialSessionState(),
    projectId: options.projectId,
    conversationId: options.conversationId,
    draft: persisted.draft,
    attachments: persisted.attachments,
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
    if (!draft && attachments.length === 0 && !pendingSend && !recoveryRequired) {
      storage.removeItem(storageKey);
      return;
    }
    storage.setItem(storageKey, JSON.stringify({ draft, attachments, ...(pendingSend ? { pendingSend } : {}), ...(recoveryRequired ? { recoveryRequired } : {}) } satisfies PersistedDraft));
  }

  function clearDraftIfItStillMatches(envelope: PendingSendEnvelope): void {
    if (state.draft !== envelope.content || !sameAttachments(state.attachments, envelope.attachments)) return;
    dispatch({ type: 'draft_changed', draft: '' });
    dispatch({ type: 'attachments_changed', attachments: [] });
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
      clearDraftIfItStillMatches(pendingSend);
      pendingSend = null;
      recoveryRequired = null;
      dispatch({ type: 'send_succeeded' });
      persistDraft();
      return;
    }
    dispatch({ type: 'send_reconciliation_failed', error: recoveryRequired });
    persistDraft();
  }

  function applyEvent(event: NativeConversationEvent): void {
    if (targetedHydrationBuffer) {
      targetedHydrationBuffer.push(event);
      return;
    }
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

  function withoutResolvedRequests(snapshot: NativeConversationSnapshot): NativeConversationSnapshot {
    const requests = snapshot.requests.filter((request) => !resolvedRequestIds.has(request.id));
    return requests.length === snapshot.requests.length ? snapshot : { ...snapshot, requests };
  }

  function acceptedEnvelopeIsDurable(snapshot: NativeConversationSnapshot, envelope: PendingSendEnvelope): boolean {
    return snapshot.submissions.some((submission) => submission.clientUserMessageId === envelope.clientUserMessageId) || snapshot.messages.some((message) => message.metadata.clientUserMessageId === envelope.clientUserMessageId);
  }

  function acceptedStatus(acceptance: NativeOperationAcceptance): string {
    const submissionStatus = acceptance.submission?.status;
    return typeof submissionStatus === 'string' ? submissionStatus : typeof acceptance.operation.status === 'string' ? acceptance.operation.status : 'accepted';
  }

  function projectAcceptedEnvelope(envelope: PendingSendEnvelope): void {
    if (!envelope.acceptance) return;
    dispatch({
      type: 'send_started',
      clientUserMessageId: envelope.clientUserMessageId,
      durableClientUserMessageId: envelope.clientUserMessageId,
      draft: envelope.content,
      attachments: envelope.attachments,
      delivery: envelope.delivery,
      previousConversationState: state.conversationState,
    });
    dispatch({ type: 'send_accepted', clientUserMessageId: envelope.clientUserMessageId, status: acceptedStatus(envelope.acceptance) });
  }

  function reconcilePersistedAcceptance(snapshot: NativeConversationSnapshot): void {
    if (pendingSend?.deliveryState !== 'accepted' || !pendingSend.acceptance) return;
    if (acceptedEnvelopeIsDurable(snapshot, pendingSend)) {
      clearDraftIfItStillMatches(pendingSend);
      pendingSend = null;
      dispatch({ type: 'send_succeeded' });
      persistDraft();
      return;
    }
    const optimisticKey = nativeOptimisticKey(state, pendingSend.clientUserMessageId);
    if (!state.items[optimisticKey]) projectAcceptedEnvelope(pendingSend);
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
      for (const event of buffered) applyEventImmediately(event);
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
        const expectedThreadId = state.providerThreadId;
        const snapshot = await options.client.loadNativeConversation(options.projectId, options.conversationId);
        if (disposed || token !== connectionToken) return;
        if (refreshIdentityEpoch !== identityEpoch || snapshot.providerThreadId !== expectedThreadId) {
          if (requestRefreshAgain) continue;
          return;
        }
        dispatch({ type: 'pending_requests_hydrated', requests: snapshot.requests.filter((request) => !resolvedRequestIds.has(request.id)), turns: snapshot.turns, items: snapshot.items });
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
    const backoffMs = [250, 500, 1_000, 2_000, 5_000] as const;
    const loop = (async () => {
      let attempt = 0;
      while (!disposed && epoch === reconnectLoopEpoch) {
        dispatch({ type: 'transport_changed', transportState: 'reconnecting', reconnectAttempt: attempt + 1 });
        const delayMs = backoffMs[Math.min(attempt, backoffMs.length - 1)];
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

  function runOperation<T>(key: string, execute: () => Promise<T>, apply: (result: T) => void | Promise<void>, clearErrorOnSuccess = true): Promise<T> {
    if (recoveryRequired) return Promise.reject(sessionWriteBlockedError(recoveryRequired));
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
      if (pendingSend && pendingSend.deliveryState !== 'accepted' && !recoveryRequired && pendingSend.content !== draft) pendingSend = null;
      dispatch({ type: 'draft_changed', draft });
      persistDraft();
    },
    setAttachments(attachments) {
      if (pendingSend && pendingSend.deliveryState !== 'accepted' && !recoveryRequired && !sameAttachments(pendingSend.attachments, attachments)) pendingSend = null;
      dispatch({ type: 'attachments_changed', attachments: [...attachments] });
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
    send(delivery, expectedTurnId) {
      if (recoveryRequired) return Promise.reject(sessionWriteBlockedError(recoveryRequired));
      const normalizedExpectedTurnId = expectedTurnId || undefined;
      if (activeOperation) {
        const pendingOperation = pendingSend ? `send:${pendingSend.fingerprint}` : null;
        if (pendingSend && activeOperation.key === pendingOperation && pendingSend.delivery === delivery && pendingSend.expectedTurnId === normalizedExpectedTurnId) {
          return activeOperation.promise as Promise<NativeOperationAcceptance>;
        }
        return Promise.reject(new Error(`Session operation already in progress: ${activeOperation.key}`));
      }
      const draft = state.draft;
      const attachments = [...state.attachments];
      if (!draft.trim()) return Promise.reject(new Error('Conversation message content is required.'));
      const fingerprint = sendFingerprint({ content: draft, attachments, delivery, ...(normalizedExpectedTurnId ? { expectedTurnId: normalizedExpectedTurnId } : {}) });
      if (!pendingSend || pendingSend.fingerprint !== fingerprint) {
        pendingSend = {
          fingerprint,
          content: draft,
          attachments,
          delivery,
          ...(normalizedExpectedTurnId ? { expectedTurnId: normalizedExpectedTurnId } : {}),
          idempotencyKey: createId(),
          clientUserMessageId: createId(),
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
            draft,
            attachments,
            delivery,
            previousConversationState,
          });
          if (envelope.deliveryState === 'accepted' && envelope.acceptance) {
            dispatch({ type: 'send_accepted', clientUserMessageId: envelope.clientUserMessageId, status: acceptedStatus(envelope.acceptance) });
            return envelope.acceptance;
          }
          try {
            const acceptance = await options.client.sendNativeMessage(options.projectId, options.conversationId, {
              content: envelope.content,
              attachments: envelope.attachments,
              delivery: envelope.delivery,
              ...(envelope.expectedTurnId ? { expectedTurnId: envelope.expectedTurnId } : {}),
              idempotencyKey: envelope.idempotencyKey,
              clientUserMessageId: envelope.clientUserMessageId,
            });
            pendingSend = { ...envelope, deliveryState: 'accepted', acceptance };
            dispatch({ type: 'send_accepted', clientUserMessageId: envelope.clientUserMessageId, status: acceptedStatus(acceptance) });
            persistDraft();
            return acceptance;
          } catch (error) {
            const sessionError = toSessionError(error, true);
            rememberRecoveryRequired(sessionError);
            dispatch({
              type: 'send_failed',
              clientUserMessageId: envelope.clientUserMessageId,
              draft: envelope.content,
              attachments: envelope.attachments,
              previousConversationState,
              error: sessionError,
            });
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
        () => undefined,
      );
    },
    resumeQueue() {
      return runOperation(
        'queue:resume',
        () => options.client.resumeNativeQueue(options.projectId, options.conversationId),
        (queue) => dispatch({ type: 'queue_hydrated', queue }),
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
        () => markRequestResolved(requestId),
      );
    },
  };
  return controller;
}

export interface UseSessionControllerResult {
  state: NativeSessionState;
  controller: SessionController;
}

export function useSessionController(options: CreateSessionControllerOptions): UseSessionControllerResult {
  const controller = useMemo(() => createSessionController(options), [options.client, options.projectId, options.conversationId, options.storage, options.createId]);
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
    const pending = isPendingSendEnvelope(parsed.pendingSend) ? parsed.pendingSend : undefined;
    const recoveryRequired = isPersistedRecoveryRequired(parsed.recoveryRequired) ? parsed.recoveryRequired : undefined;
    const persistedDraft = typeof parsed.draft === 'string' ? parsed.draft : '';
    const restorePendingInput = pending && pending.deliveryState !== 'accepted' && !persistedDraft && attachments.length === 0;
    return {
      draft: restorePendingInput ? pending.content : persistedDraft || (pending && parsed.draft === undefined ? pending.content : ''),
      attachments: restorePendingInput ? pending.attachments : attachments,
      ...(pending ? { pendingSend: pending } : {}),
      ...(recoveryRequired ? { recoveryRequired } : {}),
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
    Array.isArray(pending.attachments) &&
    pending.attachments.every(isNativeAttachment) &&
    (pending.delivery === 'queue' || pending.delivery === 'steer_now') &&
    (pending.expectedTurnId === undefined || typeof pending.expectedTurnId === 'string') &&
    typeof pending.idempotencyKey === 'string' &&
    typeof pending.clientUserMessageId === 'string' &&
    (pending.deliveryState === undefined || pending.deliveryState === 'pending' || pending.deliveryState === 'accepted') &&
    (pending.acceptance === undefined || isNativeOperationAcceptance(pending.acceptance)) &&
    (pending.deliveryState !== 'accepted' || isNativeOperationAcceptance(pending.acceptance))
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

function eventRequestId(event: NativeConversationEvent): string | null {
  const requestId = event.payload.requestId;
  return typeof requestId === 'string' && requestId.trim() ? requestId : null;
}

function snapshotRequiresRecovery(snapshot: NativeConversationSnapshot): boolean {
  return (
    (snapshot.queue.state.type === 'paused' && snapshot.queue.state.reason === 'recovery_required') || snapshot.submissions.some((submission) => submission.status === 'recovery_required' || submission.pausedReason === 'recovery_required')
  );
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
