import type {
  ConversationState,
  NativeConversationAttachment,
  NativeConversationEvent,
  NativeConversationSnapshot,
  NativeItemSnapshot,
  NativeNextTurnSettings,
  NativePendingRequest,
  NativePlanImplementationRequest,
  NativeProviderSettingsSnapshot,
  NativeProviderValueSnapshot,
  NativeQueuedSubmission,
  NativeQueueSnapshot,
  NativeSessionError,
  NativeSessionItemBuffer,
  NativeSessionState,
  NativeTokenUsageSnapshot,
  NativeTurnPlanSnapshot,
  NativeTurnSnapshot,
  TransportState,
} from './sessionTypes.js';
import type { TaskPushMessageLayout } from '@zeus/shared';
import type { ZeusBrowserComment, ZeusBrowserPreparedSubmission } from '@zeus/shared';

export type NativeSessionAction =
  | { type: 'transport_changed'; transportState: TransportState; reconnectAttempt?: number; error?: NativeSessionError | null }
  | { type: 'snapshot_hydrated'; snapshot: NativeConversationSnapshot }
  | { type: 'next_turn_settings_changed'; settings: NativeNextTurnSettings }
  | { type: 'pending_requests_hydrated'; requests: NativePendingRequest[]; turns?: NativeTurnSnapshot[]; items?: NativeItemSnapshot[] }
  | { type: 'queue_hydrated'; queue: NativeQueueSnapshot }
  | { type: 'steering_submission_hydrated'; submission: NativeQueuedSubmission; queue?: NativeQueueSnapshot }
  | { type: 'operation_started'; operation: string }
  | { type: 'operation_finished'; operation: string; error?: NativeSessionError | null }
  | { type: 'interrupt_started'; turnId: string }
  | { type: 'interrupt_failed'; previousConversationState: ConversationState; error: NativeSessionError }
  | { type: 'request_resolved'; requestId: string }
  | { type: 'event_received'; event: NativeConversationEvent; suppressRequestAuthority?: boolean }
  | { type: 'draft_changed'; draft: string }
  | { type: 'attachments_changed'; attachments: NativeConversationAttachment[] }
  | { type: 'browser_submission_changed'; browserSubmission: ZeusBrowserPreparedSubmission | null }
  | {
      type: 'send_started';
      clientUserMessageId: string;
      durableClientUserMessageId: string;
      draft: string;
      attachments: NativeConversationAttachment[];
      submittedAttachments: NativeConversationAttachment[];
      browserSubmission: ZeusBrowserPreparedSubmission | null;
      browserComments: ZeusBrowserComment[];
      delivery: 'queue' | 'steer_now';
      previousConversationState: ConversationState;
      taskPushLayout?: TaskPushMessageLayout;
    }
  | {
      type: 'send_failed';
      clientUserMessageId: string;
      draft: string;
      attachments: NativeConversationAttachment[];
      browserSubmission: ZeusBrowserPreparedSubmission | null;
      previousConversationState: ConversationState;
      error: NativeSessionError;
    }
  | {
      type: 'send_uncertain';
      clientUserMessageId: string;
      draft: string;
      attachments: NativeConversationAttachment[];
      browserSubmission: ZeusBrowserPreparedSubmission | null;
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
    changeSetsByProviderId: {},
    terminalTurnIds: {},
    items: {},
    itemOrder: [],
    queue: null,
    pendingRequests: [],
    planImplementationRequests: [],
    providerSettings: null,
    tokenUsage: null,
    rateLimits: null,
    mcpStartup: null,
    seenEventIds: {},
    lastSequenceByGeneration: {},
    lastEventId: null,
    draft: '',
    attachments: [],
    browserSubmission: null,
    transcriptRevision: 0,
    feedbackEpoch: 0,
    visibleFeedbackEpoch: 0,
    busyOperation: null,
    error: null,
  };
}

/** 将后台取得的权威快照转换为可直接展示和缓存的会话状态。 */
export function createHydratedSessionState(snapshot: NativeConversationSnapshot): NativeSessionState {
  return hydrateSnapshot(
    {
      ...createInitialSessionState(),
      transportState: 'ready',
      projectId: snapshot.projectId,
      conversationId: snapshot.id,
    },
    snapshot,
  );
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
    case 'next_turn_settings_changed':
      return state.snapshot
        ? {
            ...state,
            snapshot: {
              ...state.snapshot,
              nextTurnSettings: action.settings,
            },
          }
        : state;
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
    case 'steering_submission_hydrated':
      return projectSteeringSubmission(state, action.submission, action.queue);
    case 'operation_started':
      return { ...state, busyOperation: action.operation, error: state.error?.recoveryRequired ? state.error : null };
    case 'operation_finished':
      return state.busyOperation !== action.operation ? state : { ...state, busyOperation: null, error: action.error === undefined ? state.error : action.error };
    case 'interrupt_started':
      return state.activeTurnId !== action.turnId ? state : { ...state, conversationState: 'interrupting', error: null };
    case 'interrupt_failed':
      return { ...state, conversationState: action.previousConversationState, error: action.error };
    case 'request_resolved': {
      const wasPending = state.pendingRequests.some((request) => request.id === action.requestId);
      const pendingRequests = state.pendingRequests.filter((request) => request.id !== action.requestId);
      return {
        ...state,
        pendingRequests,
        feedbackEpoch: wasPending && state.activeTurnId ? state.feedbackEpoch + 1 : state.feedbackEpoch,
        conversationState: requestConversationState(pendingRequests) ?? conversationStateWithoutRequests(state),
      };
    }
    case 'event_received':
      return reduceNativeEvent(state, action.event, action.suppressRequestAuthority === true);
    case 'draft_changed':
      return { ...state, draft: action.draft };
    case 'attachments_changed':
      return { ...state, attachments: action.attachments };
    case 'browser_submission_changed':
      return { ...state, browserSubmission: action.browserSubmission };
    case 'send_started':
      return addOptimisticUserItem(state, action);
    case 'send_failed': {
      const optimisticEntry = optimisticUserItemEntry(state, action.clientUserMessageId);
      const optimisticKey = optimisticEntry?.[0] ?? optimisticUserItemKey(state, action.clientUserMessageId);
      const items = { ...state.items };
      if (optimisticEntry) delete items[optimisticKey];
      return {
        ...state,
        items,
        itemOrder: state.itemOrder.filter((key) => key !== optimisticKey),
        transcriptRevision: state.transcriptRevision + (optimisticEntry ? 1 : 0),
        conversationState: action.previousConversationState,
        draft: action.draft,
        attachments: action.attachments,
        browserSubmission: action.browserSubmission,
        error: action.error,
      };
    }
    case 'send_uncertain': {
      const optimisticEntry = optimisticUserItemEntry(state, action.clientUserMessageId);
      const optimisticKey = optimisticEntry?.[0] ?? optimisticUserItemKey(state, action.clientUserMessageId);
      const optimistic = optimisticEntry?.[1];
      return {
        ...state,
        ...(optimistic
          ? {
              items: {
                ...state.items,
                [optimisticKey]: {
                  ...optimistic,
                  status: 'unconfirmed',
                },
              },
            }
          : {}),
        conversationState: action.previousConversationState,
        draft: action.draft,
        attachments: action.attachments,
        browserSubmission: action.browserSubmission,
        error: action.error,
        transcriptRevision: state.transcriptRevision + (optimistic ? 1 : 0),
      };
    }
    case 'send_accepted': {
      const optimisticEntry = optimisticUserItemEntry(state, action.clientUserMessageId);
      const optimisticKey = optimisticEntry?.[0] ?? optimisticUserItemKey(state, action.clientUserMessageId);
      const optimistic = optimisticEntry?.[1];
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
  const previousOptimisticStableIndexes = new Map<string, number>();
  state.itemOrder.forEach((key, index) => {
    const item = state.items[key];
    if (!item?.optimistic || item.conversationId !== snapshot.id) return;
    for (const clientId of userMessageClientIds(item)) previousOptimisticStableIndexes.set(clientId, index);
  });
  let stableIndex = 0;
  const providerItemKeyById = new Map<string, string>();
  const providerUserItemKeyByClientId = new Map<string, string>();
  const durableClientIds = new Set<string>();
  const durableUserClientIds = new Set<string>();
  const stableIndexForClient = (clientId: string | null): number => {
    const previousIndex = clientId ? previousOptimisticStableIndexes.get(clientId) : undefined;
    if (previousIndex !== undefined) {
      stableIndex = Math.max(stableIndex, previousIndex + 1);
      return previousIndex;
    }
    return stableIndex++;
  };

  for (const item of snapshot.items) {
    const turnId = providerTurnIdByLocalId.get(item.turnId) ?? item.turnId;
    const itemId = item.providerItemId ?? item.id;
    const key = nativeSessionItemKey(snapshot.id, threadId, turnId, itemId);
    const itemClientId = isUserMessageType(item.type) ? (stringValue(item.payload.clientId) ?? stringValue(item.payload.clientUserMessageId)) : null;
    if (itemClientId && providerUserItemKeyByClientId.has(itemClientId)) continue;
    items[key] = {
      key,
      conversationId: snapshot.id,
      threadId,
      turnId,
      itemId,
      ...(item.providerItemId ? { providerItemId: item.providerItemId } : {}),
      localItemId: item.id,
      type: item.type,
      status: item.status,
      phase: item.phase,
      text: item.text,
      payload: item.payload,
      resources: item.resources ?? [],
      updatedAt: item.updatedAt,
      ...(itemClientId ? { clientUserMessageId: itemClientId, durableClientUserMessageId: itemClientId } : {}),
    };
    orderedItems.push({ key, timestamp: item.startedAt ?? item.updatedAt, stableIndex: stableIndexForClient(itemClientId) });
    if (item.providerItemId) providerItemKeyById.set(item.providerItemId, key);
    if (itemClientId) {
      durableClientIds.add(itemClientId);
      providerUserItemKeyByClientId.set(itemClientId, key);
    }
  }

  for (const message of snapshot.messages) {
    const clientUserMessageId = stringValue(message.metadata.clientUserMessageId);
    if (clientUserMessageId) durableClientIds.add(clientUserMessageId);
    // Native assistant content is represented by the provider item DTO, which has the
    // provider turn/item identity needed for incremental reconciliation.
    if (message.role === 'assistant') continue;
    if (message.role === 'user' && clientUserMessageId && durableUserClientIds.has(clientUserMessageId)) continue;
    if (message.role === 'user' && clientUserMessageId) durableUserClientIds.add(clientUserMessageId);
    const providerItemKey = message.providerItemId ? providerItemKeyById.get(message.providerItemId) : clientUserMessageId ? providerUserItemKeyByClientId.get(clientUserMessageId) : undefined;
    if (message.role === 'user' && providerItemKey) {
      const providerItem = items[providerItemKey];
      if (providerItem) {
        items[providerItemKey] = {
          ...providerItem,
          status: 'completed',
          text: message.content || providerItem.text,
          payload: {
            ...providerItem.payload,
            ...message.metadata,
            ...(clientUserMessageId ? { clientId: clientUserMessageId } : {}),
          },
          resources: message.resources ?? providerItem.resources,
          optimistic: false,
          ...(clientUserMessageId ? { clientUserMessageId, durableClientUserMessageId: clientUserMessageId } : {}),
          updatedAt: message.createdAt,
        };
        continue;
      }
    }
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
      resources: message.resources ?? [],
      optimistic: false,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(message.providerItemId ? { providerItemId: message.providerItemId } : {}),
      updatedAt: message.createdAt,
    };
    orderedItems.push({ key, timestamp: message.createdAt, stableIndex: stableIndexForClient(clientUserMessageId) });
  }

  // Provider 尚未回放精确 userMessage 时，从持久 submission 恢复当前轮次中的引导投影。
  for (const submission of snapshot.submissions) {
    const clientUserMessageId = submission.clientUserMessageId;
    const providerTurnId = submission.providerTurnId;
    const pendingStatus = submission.status === 'dispatching' || (submission.status === 'paused' && submission.pausedReason === 'recovery_required');
    if (submission.delivery !== 'steer_now' || !pendingStatus || !clientUserMessageId || !providerTurnId || durableClientIds.has(clientUserMessageId)) continue;
    const itemId = `steering:${submission.id}`;
    const key = nativeSessionItemKey(snapshot.id, threadId, providerTurnId, itemId);
    items[key] = steeringSubmissionItem(snapshot.id, threadId, submission, key, itemId);
    orderedItems.push({ key, timestamp: submission.createdAt ?? snapshot.updatedAt, stableIndex: stableIndexForClient(clientUserMessageId) });
    durableClientIds.add(clientUserMessageId);
  }

  // A pending user message is renderer-owned until a durable conversation_message with
  // either the renderer id or the server-acknowledged canonical id appears in a snapshot.
  for (const key of state.itemOrder) {
    const item = state.items[key];
    if (!item?.optimistic || item.conversationId !== snapshot.id || key in items) continue;
    if ((item.clientUserMessageId && durableClientIds.has(item.clientUserMessageId)) || (item.durableClientUserMessageId && durableClientIds.has(item.durableClientUserMessageId))) continue;
    items[key] = item;
    orderedItems.push({ key, timestamp: item.updatedAt ?? snapshot.updatedAt, stableIndex: stableIndexForClient(item.clientUserMessageId ?? item.durableClientUserMessageId ?? null) });
  }

  const activeTurnId = activeTurnFromSnapshot(snapshot);
  const changeSetsByProviderId = Object.fromEntries((snapshot.changeSets ?? []).map((changeSet) => [changeSet.providerTurnId, changeSet]));
  const terminalTurnIds = { ...state.terminalTurnIds };
  for (const turn of snapshot.turns) {
    if (!turn.providerTurnId || !isTerminalTurnStatus(turn.status)) continue;
    terminalTurnIds[turn.providerTurnId] = terminalStatus(turn.status);
  }
  const pendingRequests = normalizePendingRequestsWithMaps(snapshot.requests, providerTurnIdByLocalId, providerItemIdByLocalId);
  const itemOrder = orderedItems.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.stableIndex - right.stableIndex).map((entry) => entry.key);
  const feedbackEpoch = activeTurnId ? state.feedbackEpoch + 1 : state.feedbackEpoch;
  const hasVisibleActiveFeedback = activeTurnId ? Object.values(items).some((item) => item.turnId === activeTurnId && item.status === 'in_progress' && itemProvidesVisibleFeedback(item)) : false;
  return {
    ...state,
    projectId: snapshot.projectId,
    conversationId: snapshot.id,
    providerThreadId: snapshot.providerThreadId,
    activeTurnId,
    startedTurnId: activeTurnId,
    snapshot,
    turnsByProviderId,
    changeSetsByProviderId,
    terminalTurnIds,
    items,
    itemOrder,
    queue: snapshot.queue,
    pendingRequests,
    planImplementationRequests: snapshot.planImplementationRequests ?? [],
    providerSettings: snapshot.providerSettings ?? null,
    tokenUsage: snapshot.tokenUsage ?? null,
    rateLimits: snapshot.rateLimits ?? null,
    mcpStartup: snapshot.mcpStartup ?? null,
    conversationState: requestConversationState(pendingRequests) ?? conversationStateFromSnapshot(snapshot),
    transcriptRevision: state.transcriptRevision + 1,
    feedbackEpoch,
    visibleFeedbackEpoch: hasVisibleActiveFeedback ? feedbackEpoch : Math.min(state.visibleFeedbackEpoch, feedbackEpoch),
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
      const submissionId = stringValue(payload.submissionId);
      const existingTurn = base.turnsByProviderId[turnId];
      const startedAt = stringValue(payload.startedAt) ?? existingTurn?.startedAt ?? event.createdAt;
      const turn: NativeTurnSnapshot = {
        id: existingTurn?.id ?? turnId,
        providerTurnId: existingTurn?.providerTurnId ?? turnId,
        submissionId: existingTurn?.submissionId ?? submissionId,
        status: stringValue(payload.status) ?? 'running',
        error: existingTurn?.error ?? null,
        plan: existingTurn?.plan ?? null,
        startedAt,
        completedAt: null,
        createdAt: existingTurn?.createdAt ?? startedAt,
        updatedAt: event.createdAt,
      };
      const queue = base.queue
        ? {
            ...base.queue,
            state: { type: 'active' as const, turnId, phase: 'prework' as const },
            submissions: submissionId ? base.queue.submissions.filter((submission) => submission.id !== submissionId) : base.queue.submissions,
          }
        : null;
      return {
        ...base,
        activeTurnId: turnId,
        startedTurnId: turnId,
        queue,
        turnsByProviderId: { ...base.turnsByProviderId, [turnId]: turn },
        feedbackEpoch: base.feedbackEpoch + 1,
        transcriptRevision: base.transcriptRevision + 1,
        conversationState: 'active_prework',
      };
    }
    case 'conversation.turn.completed': {
      const turnId = stringValue(payload.turnId);
      if (!turnId) return base;
      const status = terminalStatus(stringValue(payload.status) ?? 'completed');
      const existingTurn = base.turnsByProviderId[turnId];
      const completedAt = stringValue(payload.completedAt) ?? existingTurn?.completedAt ?? event.createdAt;
      const turn: NativeTurnSnapshot = {
        id: existingTurn?.id ?? turnId,
        providerTurnId: existingTurn?.providerTurnId ?? turnId,
        submissionId: existingTurn?.submissionId ?? stringValue(payload.submissionId),
        status,
        error: existingTurn?.error ?? null,
        plan: existingTurn?.plan ?? null,
        startedAt: existingTurn?.startedAt ?? stringValue(payload.startedAt),
        completedAt,
        createdAt: existingTurn?.createdAt ?? completedAt,
        updatedAt: event.createdAt,
      };
      const terminalTurnIds = { ...base.terminalTurnIds, [turnId]: status };
      const nextState = {
        ...base,
        terminalTurnIds,
        turnsByProviderId: { ...base.turnsByProviderId, [turnId]: turn },
        transcriptRevision: base.transcriptRevision + 1,
      };
      if (turnId !== state.activeTurnId) return nextState;
      return {
        ...nextState,
        activeTurnId: null,
        conversationState: status === 'failed' ? 'turn_failed' : 'native_idle',
      };
    }
    case 'conversation.turn.plan.updated': {
      const turnId = stringValue(payload.turnId);
      const plan = nativeTurnPlanFrom(payload.plan);
      const turn = turnId ? base.turnsByProviderId[turnId] : undefined;
      if (!turnId || !turn || !plan) return base;
      return {
        ...base,
        turnsByProviderId: {
          ...base.turnsByProviderId,
          [turnId]: { ...turn, plan, updatedAt: event.createdAt },
        },
        transcriptRevision: base.transcriptRevision + 1,
      };
    }
    case 'conversation.turn.change_set.changed': {
      const changeSet = isRecord(payload.changeSet) ? (payload.changeSet as unknown as NativeSessionState['changeSetsByProviderId'][string]) : null;
      const providerTurnId = changeSet?.providerTurnId ?? stringValue(payload.turnId);
      if (!changeSet || !providerTurnId || changeSet.conversationId !== base.conversationId) return base;
      return {
        ...base,
        changeSetsByProviderId: {
          ...base.changeSetsByProviderId,
          [providerTurnId]: changeSet,
        },
        transcriptRevision: base.transcriptRevision + 1,
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
      return queue ? { ...base, queue, transcriptRevision: base.transcriptRevision + 1, conversationState: conversationStateFromQueue(queue, base), ...(recoveryError ? { error: recoveryError } : {}) } : base;
    }
    case 'conversation.submission.steering': {
      const submission = isRecord(payload.submission) ? (payload.submission as unknown as NativeQueuedSubmission) : null;
      const queue = isRecord(payload.queue) ? (payload.queue as unknown as NativeQueueSnapshot) : undefined;
      return submission ? projectSteeringSubmission(base, submission, queue) : base;
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
      const wasPending = requestId ? state.pendingRequests.some((request) => request.id === requestId) : false;
      const pendingRequests = requestId ? state.pendingRequests.filter((request) => request.id !== requestId) : state.pendingRequests;
      return {
        ...base,
        pendingRequests,
        feedbackEpoch: wasPending && state.activeTurnId ? base.feedbackEpoch + 1 : base.feedbackEpoch,
        conversationState: requestConversationState(pendingRequests) ?? conversationStateWithoutRequests(base),
      };
    }
    case 'conversation.request.snoozed': {
      const requestId = stringValue(payload.requestId);
      if (!requestId) return base;
      return {
        ...base,
        pendingRequests: base.pendingRequests.map((request) =>
          request.id === requestId
            ? {
                ...request,
                autoResolutionState: 'snoozed',
                expiresAt: null,
              }
            : request,
        ),
      };
    }
    case 'conversation.plan_implementation_request.changed': {
      const requestId = stringValue(payload.requestId);
      const status = planImplementationStatus(payload.status);
      if (!requestId || !status) return base;
      const existing = base.planImplementationRequests.find((request) => request.id === requestId);
      const updated: NativePlanImplementationRequest = existing
        ? {
            ...existing,
            status,
            submissionId: stringValue(payload.submissionId) ?? existing.submissionId,
            resolvedAt: status === 'pending' ? null : event.createdAt,
            updatedAt: event.createdAt,
          }
        : {
            id: requestId,
            conversationId: base.conversationId ?? '',
            turnId: stringValue(payload.turnId) ?? '',
            planItemId: stringValue(payload.planItemId) ?? '',
            status,
            submissionId: stringValue(payload.submissionId),
            createdAt: event.createdAt,
            resolvedAt: status === 'pending' ? null : event.createdAt,
            updatedAt: event.createdAt,
          };
      return {
        ...base,
        planImplementationRequests: [...base.planImplementationRequests.filter((request) => request.id !== requestId), updated],
        snapshot: base.snapshot
          ? {
              ...base.snapshot,
              collaborationMode: payload.collaborationMode === 'plan' || payload.collaborationMode === 'default' ? payload.collaborationMode : base.snapshot.collaborationMode,
            }
          : base.snapshot,
      };
    }
    case 'conversation.collaboration_mode.changed':
      return base.snapshot && (payload.collaborationMode === 'default' || payload.collaborationMode === 'plan')
        ? {
            ...base,
            snapshot: { ...base.snapshot, collaborationMode: payload.collaborationMode },
          }
        : base;
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

function planImplementationStatus(value: unknown): NativePlanImplementationRequest['status'] | null {
  return value === 'pending' || value === 'dismissed' || value === 'implemented' || value === 'refinement_requested' || value === 'superseded' ? value : null;
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
  const incomingResources = Array.isArray(payload.itemResources) ? payload.itemResources : null;
  const effectiveType = completed ? (incomingType ?? previous?.type ?? 'providerItem') : (previous?.type ?? incomingType ?? 'providerItem');
  const providerClientId = isUserMessageType(effectiveType) && incomingPayload ? stringValue(incomingPayload.clientId) : null;
  const matchedUserEntry = isUserMessageType(effectiveType)
    ? Object.entries(state.items).find(([, item]) => isUserMessageItem(item) && ((providerClientId !== null && userMessageClientIds(item).includes(providerClientId)) || (!item.optimistic && item.providerItemId === itemId)))
    : undefined;
  const optimisticEntry = matchedUserEntry?.[1].optimistic ? matchedUserEntry : undefined;
  const matchedUserItem = matchedUserEntry?.[1];
  const optimisticText = optimisticEntry?.[1].text ?? '';
  const matchedUserText = matchedUserItem?.text ?? '';
  const resolvedClientId = matchedUserItem?.clientUserMessageId ?? matchedUserItem?.durableClientUserMessageId ?? providerClientId;
  const next: NativeSessionItemBuffer = {
    key,
    conversationId,
    threadId,
    turnId,
    itemId,
    providerItemId: itemId,
    type: effectiveType,
    status: stringValue(payload.status) ?? (completed ? 'completed' : (previous?.status ?? 'in_progress')),
    phase: stringValue(payload.phase) ?? previous?.phase ?? matchedUserItem?.phase ?? 'prework',
    text: completed ? incomingText || previous?.text || matchedUserText || optimisticText : reconcileCumulativeText(previous?.text ?? matchedUserText ?? optimisticText, incomingText),
    // 进行中事件以 started 的类型壳为基础合并权威进度字段；completed 仍是最终投影。
    payload: completed ? (incomingPayload ?? previous?.payload ?? matchedUserItem?.payload ?? {}) : mergeProgressPayload(previous?.payload ?? matchedUserItem?.payload, incomingPayload),
    resources: completed ? (incomingResources ?? previous?.resources ?? matchedUserItem?.resources ?? []) : (previous?.resources ?? matchedUserItem?.resources ?? incomingResources ?? []),
    ...(resolvedClientId ? { clientUserMessageId: resolvedClientId, durableClientUserMessageId: resolvedClientId, optimistic: false } : {}),
    updatedAt: event.createdAt,
  };
  const isNew = previous === undefined;
  const matchedKey = matchedUserEntry?.[0];
  const items = { ...state.items, [key]: next };
  if (matchedKey && matchedKey !== key) delete items[matchedKey];
  const itemOrder = matchedKey && matchedKey !== key ? [...new Set(state.itemOrder.map((entry) => (entry === matchedKey ? key : entry)))] : isNew ? [...state.itemOrder, key] : state.itemOrder;
  const phase = next.phase === 'final_answer' ? 'active_final_answer' : 'active_prework';
  const terminal = Boolean(state.terminalTurnIds[turnId]);
  const visibleFeedbackEpoch = itemProvidesVisibleFeedback(next) ? state.feedbackEpoch : state.visibleFeedbackEpoch;
  return {
    ...state,
    activeTurnId: terminal ? state.activeTurnId : turnId,
    items,
    itemOrder,
    transcriptRevision: state.transcriptRevision + 1,
    visibleFeedbackEpoch,
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

function itemProvidesVisibleFeedback(item: NativeSessionItemBuffer): boolean {
  const type = item.type.toLocaleLowerCase().replace(/[\s_\-/]+/gu, '');
  if (type === 'usermessage' || type === 'user') return false;
  if (item.text.trim()) return true;
  return ['commandexecution', 'command', 'mcptoolcall', 'dynamictoolcall', 'websearch', 'imageview', 'imagegeneration', 'toolcall', 'tool', 'filechange', 'file'].includes(type);
}

function mergeProgressPayload(previous: Record<string, unknown> | undefined, incoming: Record<string, unknown> | null): Record<string, unknown> {
  if (!previous) return incoming ?? {};
  if (!incoming) return previous;
  const previousPresentation = isRecord(previous.presentation) ? previous.presentation : null;
  const incomingPresentation = isRecord(incoming.presentation) ? incoming.presentation : null;
  return {
    ...previous,
    ...incoming,
    ...(previousPresentation || incomingPresentation ? { presentation: { ...(previousPresentation ?? {}), ...(incomingPresentation ?? {}) } } : {}),
  };
}

function addOptimisticUserItem(state: NativeSessionState, action: Extract<NativeSessionAction, { type: 'send_started' }>): NativeSessionState {
  const existingOptimisticEntry = optimisticUserItemEntry(state, action.clientUserMessageId);
  const key = existingOptimisticEntry?.[0] ?? optimisticUserItemKey(state, action.clientUserMessageId);
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
    payload: {
      attachments: action.submittedAttachments,
      delivery: action.delivery,
      ...(action.taskPushLayout ? { taskPushLayout: action.taskPushLayout } : {}),
      ...(action.browserComments.length ? { browserComments: action.browserComments } : {}),
    },
    resources: [],
    optimistic: true,
    clientUserMessageId: action.clientUserMessageId,
    durableClientUserMessageId: action.durableClientUserMessageId,
  };
  const keepActiveState =
    action.previousConversationState === 'active_prework' || action.previousConversationState === 'active_final_answer' || action.previousConversationState === 'waiting_approval' || action.previousConversationState === 'waiting_user_input';
  return {
    ...state,
    items: { ...state.items, [key]: item },
    itemOrder: existingOptimisticEntry || state.items[key] ? state.itemOrder : [...state.itemOrder, key],
    transcriptRevision: state.transcriptRevision + 1,
    conversationState: keepActiveState ? action.previousConversationState : 'starting_turn',
    draft: '',
    attachments: [],
    browserSubmission: null,
    error: null,
  };
}

function projectSteeringSubmission(state: NativeSessionState, submission: NativeQueuedSubmission, authoritativeQueue?: NativeQueueSnapshot): NativeSessionState {
  const queue = authoritativeQueue ?? (state.queue ? { ...state.queue, submissions: state.queue.submissions.filter((entry) => entry.id !== submission.id) } : null);
  const clientUserMessageId = submission.clientUserMessageId;
  const turnId = submission.providerTurnId;
  const conversationId = state.conversationId;
  const threadId = state.providerThreadId;
  if (submission.delivery !== 'steer_now' || !clientUserMessageId || !turnId || !conversationId || !threadId) {
    return queue ? { ...state, queue, conversationState: conversationStateFromQueue(queue, state) } : state;
  }
  const matchedEntry = Object.entries(state.items).find(([, item]) => isUserMessageItem(item) && userMessageClientIds(item).includes(clientUserMessageId));
  if (matchedEntry && !matchedEntry[1].optimistic) return queue ? { ...state, queue, conversationState: conversationStateFromQueue(queue, state) } : state;
  const itemId = `steering:${submission.id}`;
  const key = nativeSessionItemKey(conversationId, threadId, turnId, itemId);
  const previousKey = matchedEntry?.[0];
  const previous = matchedEntry?.[1];
  const item: NativeSessionItemBuffer = {
    ...steeringSubmissionItem(conversationId, threadId, submission, key, itemId),
    ...(previous
      ? {
          text: submission.content || previous.text,
          resources: previous.resources,
          payload: { ...previous.payload, ...steeringSubmissionPayload(submission) },
        }
      : {}),
  };
  const items = { ...state.items, [key]: item };
  if (previousKey && previousKey !== key) delete items[previousKey];
  const itemOrder = previousKey ? [...new Set(state.itemOrder.map((entry) => (entry === previousKey ? key : entry)))] : state.itemOrder.includes(key) ? state.itemOrder : [...state.itemOrder, key];
  return {
    ...state,
    items,
    itemOrder,
    ...(queue ? { queue, conversationState: conversationStateFromQueue(queue, state) } : {}),
    transcriptRevision: state.transcriptRevision + 1,
  };
}

function steeringSubmissionItem(conversationId: string, threadId: string, submission: NativeQueuedSubmission, key: string, itemId: string): NativeSessionItemBuffer {
  return {
    key,
    conversationId,
    threadId,
    turnId: submission.providerTurnId!,
    itemId,
    type: 'userMessage',
    status: submission.status,
    phase: 'prework',
    text: submission.content,
    payload: steeringSubmissionPayload(submission),
    resources: [],
    optimistic: true,
    clientUserMessageId: submission.clientUserMessageId,
    durableClientUserMessageId: submission.clientUserMessageId,
    updatedAt: submission.updatedAt ?? submission.createdAt,
  };
}

function steeringSubmissionPayload(submission: NativeQueuedSubmission): Record<string, unknown> {
  return {
    delivery: 'steer_now',
    submissionId: submission.id,
    attachments: submission.attachments ?? [],
    ...(submission.pausedReason ? { pausedReason: submission.pausedReason } : {}),
    ...(submission.error ? { error: submission.error } : {}),
  };
}

function isUserMessageItem(item: NativeSessionItemBuffer): boolean {
  return isUserMessageType(item.type);
}

function isUserMessageType(type: string): boolean {
  const normalized = type.toLocaleLowerCase().replace(/[\s_\-/]+/gu, '');
  return normalized === 'usermessage' || normalized === 'user';
}

function userMessageClientIds(item: NativeSessionItemBuffer): string[] {
  return [item.clientUserMessageId, item.durableClientUserMessageId].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
}

function optimisticUserItemEntry(state: NativeSessionState, clientUserMessageId: string): [string, NativeSessionItemBuffer] | undefined {
  const directKey = optimisticUserItemKey(state, clientUserMessageId);
  const directItem = state.items[directKey];
  if (directItem?.optimistic) return [directKey, directItem];
  return Object.entries(state.items).find(([, item]) => item.optimistic && isUserMessageItem(item) && userMessageClientIds(item).includes(clientUserMessageId));
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
  const total = tokenBreakdownFrom(payload.total);
  const last = tokenBreakdownFrom(payload.last);
  return {
    generationId: stringValue(payload.generationId) ?? '',
    sequence: numberValue(payload.sequence) ?? 0,
    total,
    last,
    modelContextWindow: numberValue(payload.modelContextWindow),
    cacheHitRate: numberValue(payload.cacheHitRate),
    estimatedCredits: numberValue(payload.estimatedCredits),
    apiEquivalentUsd: numberValue(payload.apiEquivalentUsd),
    cacheSavingsUsd: numberValue(payload.cacheSavingsUsd),
    priceCoverage: numberValue(payload.priceCoverage),
    pricingCatalogDate: stringValue(payload.pricingCatalogDate),
    pricingSourceUrls: Array.isArray(payload.pricingSourceUrls) ? payload.pricingSourceUrls.filter((value): value is string => typeof value === 'string') : [],
    historyComplete: payload.historyComplete === true,
  };
}

function tokenBreakdownFrom(value: unknown): NativeTokenUsageSnapshot['total'] {
  const payload = isRecord(value) ? value : {};
  return {
    totalTokens: numberValue(payload.totalTokens) ?? 0,
    inputTokens: numberValue(payload.inputTokens) ?? 0,
    cachedInputTokens: numberValue(payload.cachedInputTokens) ?? 0,
    cacheWriteInputTokens: numberValue(payload.cacheWriteInputTokens) ?? 0,
    outputTokens: numberValue(payload.outputTokens) ?? 0,
    reasoningOutputTokens: numberValue(payload.reasoningOutputTokens) ?? 0,
  };
}

function providerValueFrom(payload: Record<string, unknown>): NativeProviderValueSnapshot {
  return {
    ...(stringValue(payload.generationId) ? { generationId: stringValue(payload.generationId)! } : {}),
    ...(numberValue(payload.sequence) !== null ? { sequence: numberValue(payload.sequence)! } : {}),
    value: isRecord(payload.value) ? payload.value : {},
  };
}

function nativeTurnPlanFrom(value: unknown): NativeTurnPlanSnapshot | null {
  if (!isRecord(value) || !(value.explanation === null || typeof value.explanation === 'string') || !Array.isArray(value.steps)) return null;
  const steps = value.steps.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.step !== 'string' || !candidate.step.trim()) return [];
    const statusValue = candidate.status;
    if (statusValue !== 'pending' && statusValue !== 'inProgress' && statusValue !== 'completed') return [];
    return [{ step: candidate.step, status: statusValue as 'pending' | 'inProgress' | 'completed' }];
  });
  if (steps.length !== value.steps.length) return null;
  return { explanation: value.explanation, steps };
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
