import type {
  ConversationState,
  NativeConversationAttachment,
  NativeConversationEvent,
  NativeConversationSnapshot,
  NativeItemSnapshot,
  NativePendingRequest,
  NativeProviderSettingsSnapshot,
  NativeProviderValueSnapshot,
  NativeQueueSnapshot,
  NativeSessionError,
  NativeSessionItemBuffer,
  NativeSessionState,
  NativeTokenUsageSnapshot,
  NativeTurnSnapshot,
  TransportState,
} from './sessionTypes.js';

export type NativeSessionAction =
  | { type: 'transport_changed'; transportState: TransportState; reconnectAttempt?: number; error?: NativeSessionError | null }
  | { type: 'snapshot_hydrated'; snapshot: NativeConversationSnapshot }
  | { type: 'pending_requests_hydrated'; requests: NativePendingRequest[]; turns?: NativeTurnSnapshot[]; items?: NativeItemSnapshot[] }
  | { type: 'queue_hydrated'; queue: NativeQueueSnapshot }
  | { type: 'operation_started'; operation: string }
  | { type: 'operation_finished'; operation: string; error?: NativeSessionError | null }
  | { type: 'interrupt_started'; turnId: string }
  | { type: 'interrupt_failed'; previousConversationState: ConversationState; error: NativeSessionError }
  | { type: 'request_resolved'; requestId: string }
  | { type: 'event_received'; event: NativeConversationEvent; suppressRequestAuthority?: boolean }
  | { type: 'draft_changed'; draft: string }
  | { type: 'attachments_changed'; attachments: NativeConversationAttachment[] }
  | {
      type: 'send_started';
      clientUserMessageId: string;
      durableClientUserMessageId: string;
      draft: string;
      attachments: NativeConversationAttachment[];
      delivery: 'queue' | 'steer_now';
      previousConversationState: ConversationState;
    }
  | {
      type: 'send_failed';
      clientUserMessageId: string;
      draft: string;
      attachments: NativeConversationAttachment[];
      previousConversationState: ConversationState;
      error: NativeSessionError;
    }
  | { type: 'send_accepted'; clientUserMessageId: string; status: string }
  | { type: 'send_reconciliation_failed'; error: NativeSessionError }
  | { type: 'send_succeeded' };

export function nativeSessionItemKey(conversationId: string, threadId: string, turnId: string, itemId: string): string {
  return [conversationId, threadId, turnId, itemId].map((part) => encodeURIComponent(part)).join('/');
}

export function createInitialSessionState(): NativeSessionState {
  return {
    transportState: 'disconnected',
    reconnectAttempt: 0,
    conversationState: 'native_loading',
    projectId: null,
    conversationId: null,
    providerThreadId: null,
    activeTurnId: null,
    startedTurnId: null,
    snapshot: null,
    turnsByProviderId: {},
    terminalTurnIds: {},
    items: {},
    itemOrder: [],
    queue: null,
    pendingRequests: [],
    providerSettings: null,
    tokenUsage: null,
    rateLimits: null,
    mcpStartup: null,
    seenEventIds: {},
    lastSequenceByGeneration: {},
    lastEventId: null,
    draft: '',
    attachments: [],
    transcriptRevision: 0,
    busyOperation: null,
    error: null,
  };
}

export function sessionReducer(state: NativeSessionState, action: NativeSessionAction): NativeSessionState {
  switch (action.type) {
    case 'transport_changed':
      return {
        ...state,
        transportState: action.transportState,
        reconnectAttempt: action.reconnectAttempt ?? (action.transportState === 'ready' || action.transportState === 'connecting' || action.transportState === 'disconnected' ? 0 : state.reconnectAttempt),
        error: action.error === undefined ? state.error : action.error,
      };
    case 'snapshot_hydrated':
      return hydrateSnapshot(state, action.snapshot);
    case 'pending_requests_hydrated': {
      const requests = normalizePendingRequests(state, action.requests, action.turns, action.items);
      return {
        ...state,
        pendingRequests: requests,
        conversationState: requestConversationState(requests) ?? conversationStateWithoutRequests(state),
      };
    }
    case 'queue_hydrated': {
      const recoveryError = recoveryErrorFromQueue(action.queue);
      return { ...state, queue: action.queue, conversationState: conversationStateFromQueue(action.queue, state), ...(recoveryError ? { error: recoveryError } : {}) };
    }
    case 'operation_started':
      return { ...state, busyOperation: action.operation, error: state.error?.recoveryRequired ? state.error : null };
    case 'operation_finished':
      return state.busyOperation !== action.operation ? state : { ...state, busyOperation: null, error: action.error === undefined ? state.error : action.error };
    case 'interrupt_started':
      return state.activeTurnId !== action.turnId ? state : { ...state, conversationState: 'interrupting', error: null };
    case 'interrupt_failed':
      return { ...state, conversationState: action.previousConversationState, error: action.error };
    case 'request_resolved': {
      const pendingRequests = state.pendingRequests.filter((request) => request.id !== action.requestId);
      return { ...state, pendingRequests, conversationState: requestConversationState(pendingRequests) ?? conversationStateWithoutRequests(state) };
    }
    case 'event_received':
      return reduceNativeEvent(state, action.event, action.suppressRequestAuthority === true);
    case 'draft_changed':
      return { ...state, draft: action.draft };
    case 'attachments_changed':
      return { ...state, attachments: action.attachments };
    case 'send_started':
      return addOptimisticUserItem(state, action);
    case 'send_failed': {
      const optimisticKey = optimisticUserItemKey(state, action.clientUserMessageId);
      const items = { ...state.items };
      delete items[optimisticKey];
      return {
        ...state,
        items,
        itemOrder: state.itemOrder.filter((key) => key !== optimisticKey),
        transcriptRevision: state.transcriptRevision + (optimisticKey in state.items ? 1 : 0),
        conversationState: action.previousConversationState,
        draft: action.draft,
        attachments: action.attachments,
        error: action.error,
      };
    }
    case 'send_accepted': {
      const optimisticKey = optimisticUserItemKey(state, action.clientUserMessageId);
      const optimistic = state.items[optimisticKey];
      if (!optimistic) return { ...state, error: null };
      return {
        ...state,
        items: { ...state.items, [optimisticKey]: { ...optimistic, status: action.status } },
        transcriptRevision: state.transcriptRevision + 1,
        error: null,
      };
    }
    case 'send_reconciliation_failed':
      return { ...state, error: action.error };
    case 'send_succeeded':
      return { ...state, error: null };
  }
}

function hydrateSnapshot(state: NativeSessionState, snapshot: NativeConversationSnapshot): NativeSessionState {
  const turnsByProviderId = Object.fromEntries(snapshot.turns.filter((turn) => turn.providerTurnId).map((turn) => [turn.providerTurnId!, turn]));
  const providerTurnIdByLocalId = new Map(snapshot.turns.filter((turn) => turn.providerTurnId).map((turn) => [turn.id, turn.providerTurnId!]));
  const providerItemIdByLocalId = new Map(snapshot.items.filter((item) => item.providerItemId).map((item) => [item.id, item.providerItemId!]));
  const items: Record<string, NativeSessionItemBuffer> = {};
  const orderedItems: Array<{ key: string; timestamp: string; stableIndex: number }> = [];
  const threadId = snapshot.providerThreadId ?? 'unbound-thread';
  let stableIndex = 0;

  for (const item of snapshot.items) {
    // Provider userMessage items are also projected into the authoritative
    // conversation_messages table. Render that durable projection once so the
    // provider item and transcript row cannot create duplicate user bubbles.
    if (item.type === 'userMessage') continue;
    const turnId = providerTurnIdByLocalId.get(item.turnId) ?? item.turnId;
    const itemId = item.providerItemId ?? item.id;
    const key = nativeSessionItemKey(snapshot.id, threadId, turnId, itemId);
    items[key] = {
      key,
      conversationId: snapshot.id,
      threadId,
      turnId,
      itemId,
      localItemId: item.id,
      type: item.type,
      status: item.status,
      phase: item.phase,
      text: item.text,
      payload: item.payload,
      updatedAt: item.updatedAt,
    };
    orderedItems.push({ key, timestamp: item.startedAt ?? item.updatedAt, stableIndex: stableIndex++ });
  }

  const durableClientIds = new Set<string>();
  for (const message of snapshot.messages) {
    const clientUserMessageId = stringValue(message.metadata.clientUserMessageId);
    if (clientUserMessageId) durableClientIds.add(clientUserMessageId);
    // Native assistant content is represented by the provider item DTO, which has the
    // provider turn/item identity needed for incremental reconciliation.
    if (message.role === 'assistant') continue;
    const turnId = `message:${message.id}`;
    const key = nativeSessionItemKey(snapshot.id, threadId, turnId, message.id);
    items[key] = {
      key,
      conversationId: snapshot.id,
      threadId,
      turnId,
      itemId: message.id,
      localItemId: message.id,
      type: message.role === 'user' ? 'userMessage' : `${message.role}Message`,
      status: 'completed',
      phase: stringValue(message.metadata.phase) ?? 'prework',
      text: message.content,
      payload: message.metadata,
      optimistic: false,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      updatedAt: message.createdAt,
    };
    orderedItems.push({ key, timestamp: message.createdAt, stableIndex: stableIndex++ });
  }

  // A pending user message is renderer-owned until a durable conversation_message with
  // either the renderer id or the server-acknowledged canonical id appears in a snapshot.
  for (const key of state.itemOrder) {
    const item = state.items[key];
    if (!item?.optimistic || item.conversationId !== snapshot.id || key in items) continue;
    if ((item.clientUserMessageId && durableClientIds.has(item.clientUserMessageId)) || (item.durableClientUserMessageId && durableClientIds.has(item.durableClientUserMessageId))) continue;
    items[key] = item;
    orderedItems.push({ key, timestamp: item.updatedAt ?? snapshot.updatedAt, stableIndex: stableIndex++ });
  }

  const activeTurnId = activeTurnFromSnapshot(snapshot);
  const terminalTurnIds = { ...state.terminalTurnIds };
  for (const turn of snapshot.turns) {
    if (!turn.providerTurnId || !isTerminalTurnStatus(turn.status)) continue;
    terminalTurnIds[turn.providerTurnId] = terminalStatus(turn.status);
  }
  const pendingRequests = normalizePendingRequestsWithMaps(snapshot.requests, providerTurnIdByLocalId, providerItemIdByLocalId);
  const itemOrder = orderedItems.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.stableIndex - right.stableIndex).map((entry) => entry.key);
  return {
    ...state,
    projectId: snapshot.projectId,
    conversationId: snapshot.id,
    providerThreadId: snapshot.providerThreadId,
    activeTurnId,
    startedTurnId: activeTurnId,
    snapshot,
    turnsByProviderId,
    terminalTurnIds,
    items,
    itemOrder,
    queue: snapshot.queue,
    pendingRequests,
    providerSettings: snapshot.providerSettings ?? null,
    tokenUsage: snapshot.tokenUsage ?? null,
    rateLimits: snapshot.rateLimits ?? null,
    mcpStartup: snapshot.mcpStartup ?? null,
    conversationState: requestConversationState(pendingRequests) ?? conversationStateFromSnapshot(snapshot),
    transcriptRevision: state.transcriptRevision + 1,
    error: recoveryErrorFromSnapshot(snapshot),
  };
}

function reduceNativeEvent(state: NativeSessionState, event: NativeConversationEvent, suppressRequestAuthority = false): NativeSessionState {
  if (state.seenEventIds[event.id]) return state;
  const payload = event.payload;
  const identityControlEvent = event.type === 'conversation.transport.changed' || event.type === 'conversation.thread.changed';
  if (!isEventForSelectedSession(state, payload, identityControlEvent)) return state;

  const generationId = stringValue(payload.generationId);
  const sequence = numberValue(payload.sequence);
  if (generationId && sequence !== null && sequence <= (state.lastSequenceByGeneration[generationId] ?? -1)) return state;

  const seenEventIds = { ...state.seenEventIds, [event.id]: true as const };
  const lastSequenceByGeneration = generationId && sequence !== null ? { ...state.lastSequenceByGeneration, [generationId]: sequence } : state.lastSequenceByGeneration;
  const base: NativeSessionState = {
    ...state,
    seenEventIds,
    lastSequenceByGeneration,
    lastEventId: event.id,
  };

  switch (event.type) {
    case 'conversation.transport.changed':
      return applyProviderIdentityChange(base, payload, true);
    case 'conversation.thread.changed':
      return applyProviderIdentityChange(base, payload, false);
    case 'conversation.turn.started': {
      const turnId = stringValue(payload.turnId);
      if (!turnId || state.terminalTurnIds[turnId]) return base;
      return {
        ...base,
        activeTurnId: turnId,
        startedTurnId: turnId,
        conversationState: 'active_prework',
      };
    }
    case 'conversation.turn.completed': {
      const turnId = stringValue(payload.turnId);
      if (!turnId) return base;
      const status = terminalStatus(stringValue(payload.status) ?? 'completed');
      const terminalTurnIds = { ...state.terminalTurnIds, [turnId]: status };
      if (turnId !== state.activeTurnId) return { ...base, terminalTurnIds };
      return {
        ...base,
        terminalTurnIds,
        activeTurnId: null,
        conversationState: status === 'failed' ? 'turn_failed' : 'native_idle',
      };
    }
    case 'conversation.item.started':
    case 'conversation.item.delta':
    case 'conversation.item.completed':
      return reduceItemEvent(base, event);
    case 'conversation.settings.changed':
      return { ...base, providerSettings: providerSettingsFrom(payload) };
    case 'conversation.tokenUsage.changed':
      return { ...base, tokenUsage: tokenUsageFrom(payload) };
    case 'conversation.rateLimits.changed':
      return { ...base, rateLimits: providerValueFrom(payload) };
    case 'conversation.mcpStartup.changed':
      return { ...base, mcpStartup: providerValueFrom(payload) };
    case 'conversation.queue.changed': {
      const queue = isRecord(payload.queue) ? (payload.queue as unknown as NativeQueueSnapshot) : state.queue;
      const recoveryError = queue ? recoveryErrorFromQueue(queue) : null;
      return queue ? { ...base, queue, conversationState: conversationStateFromQueue(queue, base), ...(recoveryError ? { error: recoveryError } : {}) } : base;
    }
    case 'conversation.request.created': {
      if (suppressRequestAuthority) return base;
      const requestId = stringValue(payload.requestId);
      const requestKind = stringValue(payload.requestKind) ?? 'approval';
      const pendingRequests = requestId && !state.pendingRequests.some((request) => request.id === requestId) ? [...state.pendingRequests, requestPlaceholder(state, payload, requestId, requestKind, event.createdAt)] : state.pendingRequests;
      return {
        ...base,
        pendingRequests,
        conversationState: requestKind === 'request_user_input' || requestKind === 'userInput' ? 'waiting_user_input' : 'waiting_approval',
      };
    }
    case 'conversation.request.resolved': {
      const requestId = stringValue(payload.requestId);
      const pendingRequests = requestId ? state.pendingRequests.filter((request) => request.id !== requestId) : state.pendingRequests;
      return {
        ...base,
        pendingRequests,
        conversationState: requestConversationState(pendingRequests) ?? conversationStateWithoutRequests(base),
      };
    }
    case 'conversation.native.error':
      return {
        ...base,
        conversationState: 'turn_failed',
        error: sessionErrorFromPayload(payload),
      };
    default:
      return base;
  }
}

function reduceItemEvent(state: NativeSessionState, event: NativeConversationEvent): NativeSessionState {
  const payload = event.payload;
  const conversationId = stringValue(payload.conversationId) ?? state.conversationId;
  const threadId = stringValue(payload.threadId) ?? state.providerThreadId;
  const turnId = stringValue(payload.turnId);
  const itemId = stringValue(payload.itemId);
  if (!conversationId || !threadId || !turnId || !itemId) return state;

  const key = nativeSessionItemKey(conversationId, threadId, turnId, itemId);
  const previous = state.items[key];
  const completed = event.type === 'conversation.item.completed';
  if (previous && isTerminalItemStatus(previous.status) && !completed) return state;
  const incomingText = stringValue(payload.textContent) ?? '';
  const incomingType = stringValue(payload.itemType);
  const incomingPayload = isRecord(payload.itemPayload) ? payload.itemPayload : null;
  const effectiveType = completed ? (incomingType ?? previous?.type ?? 'providerItem') : (previous?.type ?? incomingType ?? 'providerItem');
  const providerClientId = effectiveType === 'userMessage' && incomingPayload ? stringValue(incomingPayload.clientId) : null;
  const optimisticEntry = providerClientId ? Object.entries(state.items).find(([, item]) => item.optimistic && (item.clientUserMessageId === providerClientId || item.durableClientUserMessageId === providerClientId)) : undefined;
  const optimisticText = optimisticEntry?.[1].text ?? '';
  const next: NativeSessionItemBuffer = {
    key,
    conversationId,
    threadId,
    turnId,
    itemId,
    type: effectiveType,
    status: stringValue(payload.status) ?? (completed ? 'completed' : (previous?.status ?? 'in_progress')),
    phase: stringValue(payload.phase) ?? previous?.phase ?? 'prework',
    text: completed ? incomingText || previous?.text || optimisticText : reconcileCumulativeText(previous?.text ?? optimisticText, incomingText),
    // Delta payloads are provider method fragments. Keep the typed shell established by
    // item/started; item/completed is the persisted authoritative item projection.
    payload: completed ? (incomingPayload ?? previous?.payload ?? {}) : (previous?.payload ?? incomingPayload ?? {}),
    ...(providerClientId ? { clientUserMessageId: providerClientId, durableClientUserMessageId: providerClientId, optimistic: false } : {}),
    updatedAt: event.createdAt,
  };
  const isNew = previous === undefined;
  const optimisticKey = optimisticEntry?.[0];
  const items = { ...state.items, [key]: next };
  if (optimisticKey && optimisticKey !== key) delete items[optimisticKey];
  const itemOrder = optimisticKey && optimisticKey !== key ? [...new Set(state.itemOrder.map((entry) => (entry === optimisticKey ? key : entry)))] : isNew ? [...state.itemOrder, key] : state.itemOrder;
  const phase = next.phase === 'final_answer' ? 'active_final_answer' : 'active_prework';
  const terminal = Boolean(state.terminalTurnIds[turnId]);
  return {
    ...state,
    activeTurnId: terminal ? state.activeTurnId : turnId,
    items,
    itemOrder,
    transcriptRevision: state.transcriptRevision + 1,
    conversationState: terminal ? state.conversationState : phase,
  };
}

function reconcileCumulativeText(current: string, incoming: string): string {
  if (!incoming) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  // Codex snapshots are cumulative; a non-prefix payload is an authoritative correction,
  // not an append-only token fragment.
  return incoming;
}

function addOptimisticUserItem(state: NativeSessionState, action: Extract<NativeSessionAction, { type: 'send_started' }>): NativeSessionState {
  const key = optimisticUserItemKey(state, action.clientUserMessageId);
  const conversationId = state.conversationId ?? 'pending-conversation';
  const threadId = state.providerThreadId ?? 'pending-thread';
  const item: NativeSessionItemBuffer = {
    key,
    conversationId,
    threadId,
    turnId: `pending:${action.clientUserMessageId}`,
    itemId: action.clientUserMessageId,
    type: 'userMessage',
    status: 'pending',
    phase: 'prework',
    text: action.draft,
    payload: { attachments: action.attachments },
    optimistic: true,
    clientUserMessageId: action.clientUserMessageId,
    durableClientUserMessageId: action.durableClientUserMessageId,
  };
  const keepActiveState =
    action.previousConversationState === 'active_prework' || action.previousConversationState === 'active_final_answer' || action.previousConversationState === 'waiting_approval' || action.previousConversationState === 'waiting_user_input';
  return {
    ...state,
    items: { ...state.items, [key]: item },
    itemOrder: state.items[key] ? state.itemOrder : [...state.itemOrder, key],
    transcriptRevision: state.transcriptRevision + 1,
    conversationState: keepActiveState ? action.previousConversationState : 'starting_turn',
    draft: '',
    attachments: [],
    error: null,
  };
}

function optimisticUserItemKey(state: NativeSessionState, clientUserMessageId: string): string {
  return nativeSessionItemKey(state.conversationId ?? 'pending-conversation', state.providerThreadId ?? 'pending-thread', `pending:${clientUserMessageId}`, clientUserMessageId);
}

function isEventForSelectedSession(state: NativeSessionState, payload: Record<string, unknown>, allowThreadTransition = false): boolean {
  const conversationId = stringValue(payload.conversationId);
  if (!conversationId || !state.conversationId || conversationId !== state.conversationId) return false;
  const projectId = stringValue(payload.projectId);
  if (projectId && state.projectId && projectId !== state.projectId) return false;
  if (allowThreadTransition) return true;
  const threadId = stringValue(payload.threadId);
  return !(threadId && state.providerThreadId && threadId !== state.providerThreadId);
}

function applyProviderIdentityChange(state: NativeSessionState, payload: Record<string, unknown>, updateTransport: boolean): NativeSessionState {
  const providerThreadId = stringValue(payload.providerThreadId) ?? stringValue(payload.threadId) ?? state.providerThreadId;
  const providerState = stringValue(payload.providerState);
  const transportKind = updateTransport ? stringValue(payload.transportKind) : null;
  const threadChanged = Boolean(providerThreadId && providerThreadId !== state.providerThreadId);
  const snapshot = state.snapshot
    ? {
        ...state.snapshot,
        ...(transportKind ? { transportKind } : {}),
        providerThreadId,
        ...(providerState ? { providerState } : {}),
        provider: {
          ...state.snapshot.provider,
          threadId: providerThreadId,
          ...(providerState ? { state: providerState } : {}),
        },
      }
    : null;
  return {
    ...state,
    providerThreadId,
    snapshot,
    ...(threadChanged
      ? {
          activeTurnId: null,
          startedTurnId: null,
          turnsByProviderId: {},
          terminalTurnIds: {},
          queue: null,
          pendingRequests: [],
          conversationState: providerState === 'failed' ? ('turn_failed' as const) : ('native_idle' as const),
        }
      : providerState === 'failed'
        ? { conversationState: 'turn_failed' as const }
        : {}),
  };
}

function activeTurnFromSnapshot(snapshot: NativeConversationSnapshot): string | null {
  if (snapshot.queue.state.type === 'active' || snapshot.queue.state.type === 'waiting') return snapshot.queue.state.turnId;
  const active = [...snapshot.turns].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting');
  return active?.providerTurnId ?? null;
}

function conversationStateFromSnapshot(snapshot: NativeConversationSnapshot): ConversationState {
  if (snapshot.transportKind !== 'codex_native') return 'legacy_readonly';
  const requestState = requestConversationState(snapshot.requests);
  if (requestState) return requestState;
  if (snapshot.status === 'failed' || snapshot.providerState === 'failed') return 'turn_failed';
  switch (snapshot.queue.state.type) {
    case 'dispatching':
      return 'starting_turn';
    case 'active':
      return snapshot.queue.state.phase === 'final_answer' ? 'active_final_answer' : 'active_prework';
    case 'waiting':
      return snapshot.queue.state.reason === 'user_input' ? 'waiting_user_input' : 'waiting_approval';
    case 'paused':
      return snapshot.queue.state.reason === 'recovery_required' ? 'turn_failed' : 'native_idle';
    case 'idle':
      return 'native_idle';
  }
}

function recoveryErrorFromSnapshot(snapshot: NativeConversationSnapshot): NativeSessionError | null {
  return (
    recoveryErrorFromQueue(snapshot.queue) ??
    (snapshot.submissions.some((submission) => submission.status === 'recovery_required' || submission.pausedReason === 'recovery_required')
      ? {
          message: 'The native conversation requires authoritative recovery before any further provider write.',
          code: 'ZEUS_NATIVE_SNAPSHOT_RECOVERY_REQUIRED',
          recoveryRequired: true,
          retryable: false,
        }
      : null)
  );
}

function recoveryErrorFromQueue(queue: NativeQueueSnapshot): NativeSessionError | null {
  if (queue.state.type !== 'paused' || queue.state.reason !== 'recovery_required') return null;
  return {
    message: 'The native conversation requires authoritative recovery before any further provider write.',
    code: 'ZEUS_NATIVE_SNAPSHOT_RECOVERY_REQUIRED',
    recoveryRequired: true,
    retryable: false,
  };
}

function requestConversationState(requests: NativePendingRequest[]): ConversationState | null {
  const pending = requests.find((request) => request.status === 'pending');
  if (!pending) return null;
  return pending.type === 'userInput' || pending.type === 'request_user_input' ? 'waiting_user_input' : 'waiting_approval';
}

function requestPlaceholder(state: NativeSessionState, payload: Record<string, unknown>, requestId: string, requestKind: string, createdAt: string): NativePendingRequest {
  return {
    id: requestId,
    conversationId: state.conversationId ?? '',
    turnId: stringValue(payload.turnId),
    itemId: stringValue(payload.itemId),
    generationId: stringValue(payload.generationId) ?? '',
    type: requestKind === 'request_user_input' ? 'userInput' : requestKind,
    status: 'pending',
    payload: {},
    response: null,
    containsSecret: false,
    expiresAt: null,
    createdAt,
    resolvedAt: null,
  };
}

function normalizePendingRequests(state: NativeSessionState, requests: NativePendingRequest[], turns = state.snapshot?.turns, items = state.snapshot?.items): NativePendingRequest[] {
  if (!turns || !items) return requests;
  const providerTurnIdByLocalId = new Map(turns.filter((turn) => turn.providerTurnId).map((turn) => [turn.id, turn.providerTurnId!]));
  const providerItemIdByLocalId = new Map(items.filter((item) => item.providerItemId).map((item) => [item.id, item.providerItemId!]));
  return normalizePendingRequestsWithMaps(requests, providerTurnIdByLocalId, providerItemIdByLocalId);
}

function normalizePendingRequestsWithMaps(requests: NativePendingRequest[], providerTurnIdByLocalId: Map<string, string>, providerItemIdByLocalId: Map<string, string>): NativePendingRequest[] {
  return requests.map((request) => ({
    ...request,
    turnId: request.turnId ? (providerTurnIdByLocalId.get(request.turnId) ?? request.turnId) : null,
    itemId: request.itemId ? (providerItemIdByLocalId.get(request.itemId) ?? request.itemId) : null,
  }));
}

function conversationStateWithoutRequests(state: NativeSessionState): ConversationState {
  if (state.conversationState === 'turn_failed' || state.conversationState === 'interrupting' || state.conversationState === 'interrupt_confirm') return state.conversationState;
  if (state.activeTurnId) return state.conversationState === 'active_final_answer' ? 'active_final_answer' : 'active_prework';
  return 'native_idle';
}

function conversationStateFromQueue(queue: NativeQueueSnapshot, state: NativeSessionState): ConversationState {
  const requestState = requestConversationState(state.pendingRequests);
  if (requestState) return requestState;
  switch (queue.state.type) {
    case 'idle':
      return 'native_idle';
    case 'dispatching':
      return 'starting_turn';
    case 'active':
      return queue.state.phase === 'final_answer' ? 'active_final_answer' : 'active_prework';
    case 'waiting':
      return queue.state.reason === 'user_input' ? 'waiting_user_input' : 'waiting_approval';
    case 'paused':
      return queue.state.reason === 'recovery_required' ? 'turn_failed' : 'native_idle';
  }
}

function isTerminalTurnStatus(status: string): boolean {
  return status === 'completed' || status === 'interrupted' || status === 'failed';
}

function terminalStatus(status: string): 'completed' | 'interrupted' | 'failed' {
  if (status === 'interrupted' || status === 'failed') return status;
  return 'completed';
}

function isTerminalItemStatus(status: string): boolean {
  return status === 'completed' || status === 'failed';
}

function sessionErrorFromPayload(payload: Record<string, unknown>): NativeSessionError {
  const nested = isRecord(payload.error) ? payload.error : null;
  const code = stringValue(nested?.error) ?? stringValue(payload.error);
  const recoveryRequired = booleanValue(nested?.recoveryRequired) ?? booleanValue(payload.recoveryRequired) ?? false;
  return {
    message: stringValue(nested?.message) ?? stringValue(payload.message) ?? 'Codex native conversation failed',
    code,
    recoveryRequired,
    retryable: !recoveryRequired && (booleanValue(nested?.retryable) ?? booleanValue(payload.retryable) ?? false),
  };
}

function providerSettingsFrom(payload: Record<string, unknown>): NativeProviderSettingsSnapshot {
  return {
    ...(stringValue(payload.generationId) ? { generationId: stringValue(payload.generationId)! } : {}),
    ...(numberValue(payload.sequence) !== null ? { sequence: numberValue(payload.sequence)! } : {}),
    model: stringValue(payload.model) ?? '',
    ...(stringValue(payload.effort) ? { effort: stringValue(payload.effort)! } : {}),
  };
}

function tokenUsageFrom(payload: Record<string, unknown>): NativeTokenUsageSnapshot {
  return {
    ...(stringValue(payload.generationId) ? { generationId: stringValue(payload.generationId)! } : {}),
    ...(numberValue(payload.sequence) !== null ? { sequence: numberValue(payload.sequence)! } : {}),
    inputTokens: numberValue(payload.inputTokens) ?? 0,
    outputTokens: numberValue(payload.outputTokens) ?? 0,
    totalTokens: numberValue(payload.totalTokens) ?? 0,
  };
}

function providerValueFrom(payload: Record<string, unknown>): NativeProviderValueSnapshot {
  return {
    ...(stringValue(payload.generationId) ? { generationId: stringValue(payload.generationId)! } : {}),
    ...(numberValue(payload.sequence) !== null ? { sequence: numberValue(payload.sequence)! } : {}),
    value: isRecord(payload.value) ? payload.value : {},
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
