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
  NativeSessionMetricsSnapshot,
  NativeSessionState,
  NativeTokenUsageSnapshot,
  NativeTurnPlanSnapshot,
  NativeTurnSnapshot,
  NativeUnifiedUsageSnapshot,
  TransportState,
} from './sessionTypes.js';
import type { ZeusBrowserComment, ZeusBrowserPreparedSubmission } from '@zeus/shared';
import { type ConversationContextDraft, emptyConversationContextDraft, type TaskPushMessageLayout } from '@zeus/shared';

export type NativeSessionAction =
  | { type: 'transport_changed'; transportState: TransportState; reconnectAttempt?: number; error?: NativeSessionError | null }
  | { type: 'snapshot_hydrated'; snapshot: NativeConversationSnapshot }
  | { type: 'snapshot_v2_page_merged'; snapshot: NativeConversationSnapshot }
  | { type: 'next_turn_settings_changed'; settings: NativeNextTurnSettings }
  | {
      type: 'pending_requests_hydrated';
      requests: NativePendingRequest[];
      planImplementationRequests?: NativePlanImplementationRequest[];
      turns?: NativeTurnSnapshot[];
      items?: NativeItemSnapshot[];
    }
  | { type: 'queue_hydrated'; queue: NativeQueueSnapshot }
  | { type: 'queued_submission_deleted'; submissionId: string; clientUserMessageId?: string; queue: NativeQueueSnapshot }
  | { type: 'steering_submission_hydrated'; submission: NativeQueuedSubmission; queue?: NativeQueueSnapshot }
  | { type: 'steering_submission_failed'; submissionId: string; clientUserMessageId?: string; error: NativeSessionError }
  | { type: 'operation_started'; operation: string }
  | { type: 'operation_finished'; operation: string; error?: NativeSessionError | null }
  | { type: 'interrupt_started'; turnId: string }
  | { type: 'interrupt_failed'; previousConversationState: ConversationState; error: NativeSessionError }
  | { type: 'request_resolved'; requestId: string }
  | { type: 'event_received'; event: NativeConversationEvent; suppressRequestAuthority?: boolean }
  | { type: 'draft_changed'; draft: string }
  | { type: 'attachments_changed'; attachments: NativeConversationAttachment[] }
  | { type: 'browser_submission_changed'; browserSubmission: ZeusBrowserPreparedSubmission | null }
  | { type: 'context_draft_changed'; contextDraft: ConversationContextDraft }
  | {
      type: 'send_started';
      clientUserMessageId: string;
      durableClientUserMessageId: string;
      draft: string;
      attachments: NativeConversationAttachment[];
      submittedAttachments: NativeConversationAttachment[];
      browserSubmission: ZeusBrowserPreparedSubmission | null;
      contextDraft: ConversationContextDraft;
      browserComments: ZeusBrowserComment[];
      delivery: 'queue' | 'steer_now';
      previousConversationState: ConversationState;
      startedAt: string;
      queuedUntilHydrated?: boolean;
      taskPushLayout?: TaskPushMessageLayout;
    }
  | {
      type: 'send_failed';
      clientUserMessageId: string;
      draft: string;
      attachments: NativeConversationAttachment[];
      browserSubmission: ZeusBrowserPreparedSubmission | null;
      contextDraft: ConversationContextDraft;
      previousConversationState: ConversationState;
      error: NativeSessionError;
    }
  | {
      type: 'send_uncertain';
      clientUserMessageId: string;
      draft: string;
      attachments: NativeConversationAttachment[];
      browserSubmission: ZeusBrowserPreparedSubmission | null;
      contextDraft: ConversationContextDraft;
      previousConversationState: ConversationState;
      error: NativeSessionError;
    }
  | { type: 'send_accepted'; clientUserMessageId: string; status: string; submissionId?: string; providerTurnId?: string }
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
    unifiedUsage: null,
    sessionMetrics: null,
    rateLimits: null,
    mcpStartup: null,
    seenEventIds: {},
    lastSequenceByGeneration: {},
    lastEventId: null,
    draft: '',
    attachments: [],
    browserSubmission: null,
    contextDraft: structuredClone(emptyConversationContextDraft),
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
    case 'snapshot_v2_page_merged':
      return mergeSnapshotV2Page(state, action.snapshot);
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
        planImplementationRequests: action.planImplementationRequests ?? state.planImplementationRequests,
        conversationState: requestConversationState(requests) ?? conversationStateWithoutRequests(state),
      };
    }
    case 'queue_hydrated': {
      return projectQueueSubmissionMessages(state, action.queue);
    }
    case 'queued_submission_deleted':
      return removeQueuedSubmissionProjection(state, action.submissionId, action.clientUserMessageId, action.queue);
    case 'steering_submission_hydrated':
      return projectSteeringSubmission(state, action.submission, action.queue);
    case 'steering_submission_failed':
      return markSteeringSubmissionUnconfirmed(state, action.submissionId, action.clientUserMessageId, action.error);
    case 'operation_started':
      return { ...state, busyOperation: action.operation, error: null };
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
    case 'context_draft_changed':
      return { ...state, contextDraft: action.contextDraft };
    case 'send_started':
      return addOptimisticUserItem(state, action);
    case 'send_failed': {
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
                  status: 'failed',
                  payload: {
                    ...optimistic.payload,
                    deliveryError: action.error,
                  },
                },
              },
            }
          : {}),
        transcriptRevision: state.transcriptRevision + (optimisticEntry ? 1 : 0),
        conversationState: action.previousConversationState,
        draft: action.draft,
        attachments: action.attachments,
        browserSubmission: action.browserSubmission,
        contextDraft: action.contextDraft,
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
                  payload: {
                    ...optimistic.payload,
                    deliveryError: action.error,
                  },
                },
              },
            }
          : {}),
        conversationState: action.previousConversationState,
        draft: action.draft,
        attachments: action.attachments,
        browserSubmission: action.browserSubmission,
        contextDraft: action.contextDraft,
        error: action.error,
        transcriptRevision: state.transcriptRevision + (optimistic ? 1 : 0),
      };
    }
    case 'send_accepted': {
      const optimisticEntry = optimisticUserItemEntry(state, action.clientUserMessageId);
      const optimisticKey = optimisticEntry?.[0] ?? optimisticUserItemKey(state, action.clientUserMessageId);
      const optimistic = optimisticEntry?.[1];
      if (!optimistic) return { ...state, error: null };
      const terminal = action.providerTurnId ? state.terminalTurnIds[action.providerTurnId] : undefined;
      const payload: Record<string, unknown> = {
        ...optimistic.payload,
        ...(action.submissionId ? { submissionId: action.submissionId } : {}),
      };
      if (action.status === 'active' || action.status === 'completed' || action.status === 'resolved' || terminal) {
        delete payload.pausedReason;
        delete payload.error;
        delete payload.deliveryError;
      }
      return {
        ...state,
        items: {
          ...state.items,
          [optimisticKey]: {
            ...optimistic,
            ...(action.providerTurnId ? { turnId: action.providerTurnId } : {}),
            status: terminal ? 'completed' : action.status,
            payload,
            optimistic: terminal || action.status === 'completed' || action.status === 'resolved' ? false : optimistic.optimistic,
          },
        },
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
  const previousUserItemKeys = new Map<string, string>();
  const previousUserStableIndexes = new Map<string, number>();
  const previousUserItemsByClientId = new Map<string, NativeSessionItemBuffer>();
  const previousUserItemsBySubmissionId = new Map<string, NativeSessionItemBuffer>();
  state.itemOrder.forEach((key, index) => {
    const item = state.items[key];
    if (!item || item.conversationId !== snapshot.id || !isUserMessageItem(item)) return;
    const submissionId = stringValue(item.payload.submissionId);
    if (submissionId) previousUserItemsBySubmissionId.set(submissionId, item);
    for (const clientId of userMessageClientIds(item)) {
      previousUserItemKeys.set(clientId, key);
      previousUserStableIndexes.set(clientId, index);
      previousUserItemsByClientId.set(clientId, item);
    }
  });
  let stableIndex = 0;
  const providerItemKeyById = new Map<string, string>();
  const providerUserItemKeyByClientId = new Map<string, string>();
  const durableClientIds = new Set<string>();
  const durableUserClientIds = new Set<string>();
  const stableIndexForClient = (clientId: string | null): number => {
    const previousIndex = clientId ? previousUserStableIndexes.get(clientId) : undefined;
    if (previousIndex !== undefined) {
      stableIndex = Math.max(stableIndex, previousIndex + 1);
      return previousIndex;
    }
    return stableIndex++;
  };

  for (const item of snapshot.items) {
    const turnId = providerTurnIdByLocalId.get(item.turnId) ?? item.turnId;
    const itemId = item.providerItemId ?? item.id;
    const timelineAt = item.startedAt ?? item.updatedAt;
    const itemSubmissionId = isUserMessageType(item.type) ? stringValue(item.payload.submissionId) : null;
    let itemClientId = isUserMessageType(item.type) ? (stringValue(item.payload.clientId) ?? stringValue(item.payload.clientUserMessageId)) : null;
    const previousUserItem = (itemClientId ? previousUserItemsByClientId.get(itemClientId) : undefined) ?? (itemSubmissionId ? previousUserItemsBySubmissionId.get(itemSubmissionId) : undefined);
    itemClientId ??= previousUserItem ? (userMessageClientIds(previousUserItem)[0] ?? null) : null;
    const existingProviderUserKey = itemClientId ? providerUserItemKeyByClientId.get(itemClientId) : undefined;
    if (existingProviderUserKey) {
      // Provider 可能用多个 item 回放同一客户端用户消息；别名也要指向已有可见项，
      // 否则其持久消息会失去身份并以原始纯文本再次进入时间线。
      if (item.providerItemId) providerItemKeyById.set(item.providerItemId, existingProviderUserKey);
      continue;
    }
    // 同一条用户消息从本地发送态交接为 Provider item 时沿用可见身份，避免气泡被卸载后重建。
    const key = (itemClientId ? previousUserItemKeys.get(itemClientId) : undefined) ?? nativeSessionItemKey(snapshot.id, threadId, turnId, itemId);
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
      payload: previousUserItem ? mergeStableUserMessagePresentation(previousUserItem.payload, item.payload) : item.payload,
      resources: item.resources ?? [],
      timelineAt,
      updatedAt: item.updatedAt,
      ...(itemClientId ? { clientUserMessageId: itemClientId, durableClientUserMessageId: itemClientId } : {}),
    };
    orderedItems.push({ key, timestamp: timelineAt, stableIndex: stableIndexForClient(itemClientId) });
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
    const key = (clientUserMessageId ? previousUserItemKeys.get(clientUserMessageId) : undefined) ?? nativeSessionItemKey(snapshot.id, threadId, turnId, message.id);
    const previousUserItem = message.role === 'user' && clientUserMessageId ? previousUserItemsByClientId.get(clientUserMessageId) : undefined;
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
      payload: previousUserItem ? mergeStableUserMessagePresentation(previousUserItem.payload, message.metadata) : message.metadata,
      resources: message.resources ?? [],
      optimistic: false,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(message.providerItemId ? { providerItemId: message.providerItemId } : {}),
      timelineAt: message.createdAt,
      updatedAt: message.createdAt,
    };
    orderedItems.push({ key, timestamp: message.createdAt, stableIndex: stableIndexForClient(clientUserMessageId) });
  }

  // Provider 尚未回放精确 userMessage 时，从持久 submission 恢复同一条用户消息。
  // 排队阶段也保留稳定客户端身份，后续开轮只更新状态与 turnId，不把消息挪出再重建。
  for (const submission of snapshot.submissions) {
    const clientUserMessageId = submission.clientUserMessageId;
    const pendingStatus = shouldProjectSubmissionMessage(submission);
    if (!pendingStatus || !clientUserMessageId || durableClientIds.has(clientUserMessageId)) continue;
    const providerTurnId = submission.providerTurnId ?? `pending:${clientUserMessageId}`;
    const itemId = `${submission.delivery === 'steer_now' ? 'steering' : 'submission'}:${submission.id}`;
    const key = previousUserItemKeys.get(clientUserMessageId) ?? nativeSessionItemKey(snapshot.id, threadId, providerTurnId, itemId);
    const submissionItem = submissionUserMessageItem(snapshot.id, threadId, submission, key, itemId, providerTurnId);
    const previousUserItem = previousUserItemsByClientId.get(clientUserMessageId);
    items[key] = previousUserItem
      ? {
          ...submissionItem,
          payload: mergeStableUserMessagePresentation(previousUserItem.payload, submissionItem.payload),
        }
      : submissionItem;
    orderedItems.push({ key, timestamp: submission.createdAt ?? snapshot.updatedAt, stableIndex: stableIndexForClient(clientUserMessageId) });
    durableClientIds.add(clientUserMessageId);
  }

  // A pending user message is renderer-owned until a durable conversation_message with
  // either the renderer id or the server-acknowledged canonical id appears in a snapshot.
  const submissionsByClientId = new Map(snapshot.submissions.flatMap((submission) => (submission.clientUserMessageId ? [[submission.clientUserMessageId, submission] as const] : [])));
  for (const key of state.itemOrder) {
    const item = state.items[key];
    if (!item?.optimistic || item.conversationId !== snapshot.id || key in items) continue;
    const knownSubmission = userMessageClientIds(item)
      .map((clientId) => submissionsByClientId.get(clientId))
      .find((submission): submission is NativeQueuedSubmission => Boolean(submission));
    if (knownSubmission && shouldDiscardSubmissionProjection(knownSubmission)) continue;
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
  const projectedItemOrder = orderedItems.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.stableIndex - right.stableIndex).map((entry) => entry.key);
  const stableItems = reuseEquivalentSessionItems(state.items, items);
  const itemOrder = sameStringArray(state.itemOrder, projectedItemOrder) ? state.itemOrder : projectedItemOrder;
  const activeTurnChanged = Boolean(activeTurnId && state.activeTurnId !== activeTurnId);
  const requestResolvedBySnapshot = Boolean(
    activeTurnId && pendingRequests.some((request) => request.turnId === activeTurnId && request.status === 'resolved' && state.pendingRequests.some((previous) => previous.id === request.id && previous.status !== 'resolved')),
  );
  const feedbackEpoch = activeTurnChanged || requestResolvedBySnapshot ? state.feedbackEpoch + 1 : state.feedbackEpoch;
  const latestResolutionAt = activeTurnId ? latestResolvedRequestAt(pendingRequests, activeTurnId) : null;
  const hasVisibleActiveFeedback = activeTurnId
    ? Object.values(items).some((item) => item.turnId === activeTurnId && itemProvidesVisibleFeedback(item) && (!latestResolutionAt || (item.updatedAt ?? item.timelineAt ?? '') >= latestResolutionAt))
    : false;
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
    items: stableItems,
    itemOrder,
    queue: snapshot.queue,
    pendingRequests,
    planImplementationRequests: snapshot.planImplementationRequests ?? [],
    providerSettings: snapshot.providerSettings ?? null,
    tokenUsage: snapshot.tokenUsage ?? null,
    unifiedUsage: snapshot.sessionMetrics?.usage ?? snapshot.usage,
    sessionMetrics: snapshot.sessionMetrics ?? null,
    rateLimits: snapshot.rateLimits ?? null,
    mcpStartup: snapshot.mcpStartup ?? null,
    conversationState: requestConversationState(pendingRequests) ?? conversationStateFromSnapshot(snapshot),
    transcriptRevision: state.transcriptRevision + (stableItems === state.items && itemOrder === state.itemOrder ? 0 : 1),
    feedbackEpoch,
    visibleFeedbackEpoch: hasVisibleActiveFeedback ? feedbackEpoch : Math.min(state.visibleFeedbackEpoch, feedbackEpoch),
    error: null,
  };
}

/**
 * 按需 V2 页只补充历史、过程与游标，不拥有实时轮次终态。
 * 若用普通水合处理，较早的分页基准会把刚完成的轮次降回运行中并丢掉实时最终答复。
 */
function mergeSnapshotV2Page(state: NativeSessionState, snapshot: NativeConversationSnapshot): NativeSessionState {
  const hydrated = hydrateSnapshot(state, snapshot);
  const items = { ...hydrated.items };
  for (const [key, previous] of Object.entries(state.items)) {
    const projected = items[key];
    if (!projected) {
      items[key] = previous;
      continue;
    }
    items[key] = {
      ...previous,
      ...projected,
      status: isTerminalItemStatus(previous.status) && !isTerminalItemStatus(projected.status) ? previous.status : projected.status,
      payload: { ...previous.payload, ...projected.payload },
      resources: projected.resources.length > 0 ? projected.resources : previous.resources,
      timelineAt: previous.timelineAt ?? projected.timelineAt,
      updatedAt: (previous.updatedAt ?? previous.timelineAt ?? '').localeCompare(projected.updatedAt ?? projected.timelineAt ?? '') > 0 ? previous.updatedAt : projected.updatedAt,
    };
  }

  const previousOrder = new Map(state.itemOrder.map((key, index) => [key, index]));
  const itemOrder = [...new Set([...state.itemOrder, ...hydrated.itemOrder])].sort((leftKey, rightKey) => {
    const left = items[leftKey];
    const right = items[rightKey];
    if (!left || !right) return left ? -1 : right ? 1 : 0;
    const chronology = (left.timelineAt ?? left.updatedAt ?? '').localeCompare(right.timelineAt ?? right.updatedAt ?? '');
    if (chronology !== 0) return chronology;
    return (previousOrder.get(leftKey) ?? Number.MAX_SAFE_INTEGER) - (previousOrder.get(rightKey) ?? Number.MAX_SAFE_INTEGER) || leftKey.localeCompare(rightKey);
  });

  const turnsByProviderId = { ...hydrated.turnsByProviderId };
  for (const [turnId, previous] of Object.entries(state.turnsByProviderId)) {
    const projected = turnsByProviderId[turnId];
    if (!projected || (isTerminalTurnStatus(previous.status) && !isTerminalTurnStatus(projected.status)) || previous.updatedAt.localeCompare(projected.updatedAt) > 0) turnsByProviderId[turnId] = previous;
  }
  const turns = [...new Map([...snapshot.turns, ...Object.values(turnsByProviderId)].map((turn) => [turn.providerTurnId ?? turn.id, turn])).values()].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  return {
    ...hydrated,
    snapshot: { ...snapshot, turns },
    turnsByProviderId,
    terminalTurnIds: { ...hydrated.terminalTurnIds, ...state.terminalTurnIds },
    items,
    itemOrder,
    activeTurnId: state.activeTurnId,
    startedTurnId: state.startedTurnId,
    queue: state.queue,
    pendingRequests: state.pendingRequests,
    planImplementationRequests: state.planImplementationRequests,
    providerSettings: state.providerSettings,
    tokenUsage: state.tokenUsage,
    unifiedUsage: state.unifiedUsage,
    sessionMetrics: state.sessionMetrics,
    rateLimits: state.rateLimits,
    mcpStartup: state.mcpStartup,
    conversationState: state.conversationState,
    transcriptRevision: state.transcriptRevision + 1,
    feedbackEpoch: state.feedbackEpoch,
    visibleFeedbackEpoch: state.visibleFeedbackEpoch,
    error: state.error,
  };
}

/** 权威快照内容未变化时复用历史条目，避免后台校准重新解析整段 Markdown。 */
function reuseEquivalentSessionItems(previous: Record<string, NativeSessionItemBuffer>, projected: Record<string, NativeSessionItemBuffer>): Record<string, NativeSessionItemBuffer> {
  const projectedKeys = Object.keys(projected);
  const previousKeys = Object.keys(previous);
  let reusedCount = 0;
  const stable: Record<string, NativeSessionItemBuffer> = {};
  for (const key of projectedKeys) {
    const candidate = projected[key]!;
    const existing = previous[key];
    if (existing && equivalentSessionItem(existing, candidate)) {
      stable[key] = existing;
      reusedCount += 1;
    } else {
      stable[key] = candidate;
    }
  }
  return reusedCount === projectedKeys.length && projectedKeys.length === previousKeys.length ? previous : stable;
}

function equivalentSessionItem(left: NativeSessionItemBuffer, right: NativeSessionItemBuffer): boolean {
  return (
    left.key === right.key &&
    left.conversationId === right.conversationId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.itemId === right.itemId &&
    left.providerItemId === right.providerItemId &&
    left.localItemId === right.localItemId &&
    left.type === right.type &&
    left.status === right.status &&
    left.phase === right.phase &&
    left.text === right.text &&
    left.optimistic === right.optimistic &&
    left.clientUserMessageId === right.clientUserMessageId &&
    left.durableClientUserMessageId === right.durableClientUserMessageId &&
    left.timelineAt === right.timelineAt &&
    left.updatedAt === right.updatedAt &&
    sameSerializableValue(left.payload, right.payload) &&
    sameSerializableValue(left.resources, right.resources)
  );
}

function sameSerializableValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
      const openingUserEntry = submissionId ? Object.entries(base.items).find(([, item]) => item.optimistic && isUserMessageItem(item) && stringValue(item.payload.submissionId) === submissionId) : undefined;
      let items = base.items;
      if (openingUserEntry) {
        const [key, item] = openingUserEntry;
        const nextPayload = { ...item.payload };
        delete nextPayload.pausedReason;
        delete nextPayload.error;
        items = {
          ...items,
          [key]: {
            ...item,
            turnId,
            status: 'active',
            payload: nextPayload,
            updatedAt: event.createdAt,
          },
        };
      }
      return {
        ...base,
        activeTurnId: turnId,
        startedTurnId: turnId,
        queue,
        items,
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
      const warning = payload.severity === 'warning';
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
      const submissionId = stringValue(payload.submissionId) ?? turn.submissionId;
      let items = base.items;
      for (const [key, item] of Object.entries(base.items)) {
        if (!item.optimistic || !isUserMessageItem(item) || (item.turnId !== turnId && (!submissionId || stringValue(item.payload.submissionId) !== submissionId))) continue;
        const nextPayload = { ...item.payload };
        delete nextPayload.pausedReason;
        delete nextPayload.error;
        delete nextPayload.deliveryError;
        if (items === base.items) items = { ...base.items };
        items[key] = {
          ...item,
          turnId,
          status: 'completed',
          payload: nextPayload,
          optimistic: false,
          updatedAt: event.createdAt,
        };
      }
      const nextState = {
        ...base,
        terminalTurnIds,
        items,
        turnsByProviderId: { ...base.turnsByProviderId, [turnId]: turn },
        transcriptRevision: base.transcriptRevision + 1,
      };
      if (turnId !== state.activeTurnId) return nextState;
      return {
        ...nextState,
        activeTurnId: null,
        conversationState: status === 'failed' && !warning ? 'turn_failed' : 'native_idle',
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
      return { ...base, tokenUsage: tokenUsageFrom(payload), unifiedUsage: unifiedUsageFrom(payload.unifiedUsage) ?? base.unifiedUsage };
    case 'conversation.sessionMetrics.changed': {
      const sessionMetrics = sessionMetricsFrom(payload.sessionMetrics);
      return sessionMetrics ? { ...base, sessionMetrics, unifiedUsage: sessionMetrics.usage } : base;
    }
    case 'conversation.rateLimits.changed':
      return { ...base, rateLimits: providerValueFrom(payload) };
    case 'conversation.mcpStartup.changed':
      return { ...base, mcpStartup: providerValueFrom(payload) };
    case 'conversation.queue.changed': {
      const queue = isRecord(payload.queue) ? (payload.queue as unknown as NativeQueueSnapshot) : state.queue;
      return queue ? projectQueueSubmissionMessages(base, queue) : base;
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
      const rawEventRequest = requestId ? pendingRequestFromEvent(payload.request, requestId) : null;
      const eventRequest = rawEventRequest ? normalizePendingRequests(base, [rawEventRequest])[0] : null;
      const pendingRequests = eventRequest
        ? state.pendingRequests.some((request) => request.id === requestId)
          ? state.pendingRequests.map((request) => (request.id === requestId ? eventRequest : request))
          : [...state.pendingRequests, eventRequest]
        : state.pendingRequests;
      return {
        ...base,
        pendingRequests,
        conversationState: eventRequest ? (requestKind === 'request_user_input' || requestKind === 'userInput' ? 'waiting_user_input' : 'waiting_approval') : base.conversationState,
      };
    }
    case 'conversation.request.resolved': {
      const requestId = stringValue(payload.requestId);
      const wasPending = requestId ? state.pendingRequests.some((request) => request.id === requestId) : false;
      const rawEventRequest = requestId ? pendingRequestFromEvent(payload.request, requestId) : null;
      const eventRequest = rawEventRequest ? normalizePendingRequests(base, [rawEventRequest])[0] : null;
      const pendingRequests = requestId
        ? eventRequest
          ? state.pendingRequests.some((request) => request.id === requestId)
            ? state.pendingRequests.map((request) => (request.id === requestId ? eventRequest : request))
            : [...state.pendingRequests, eventRequest]
          : state.pendingRequests.filter((request) => request.id !== requestId)
        : state.pendingRequests;
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
      // HTTP 权威快照可能先于较早的 WebSocket pending 事件到达，已解决请求禁止回退成可再次操作。
      if (existing && existing.status !== 'pending' && status === 'pending') return base;
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
    case 'conversation.goal.updated':
      return base.snapshot && isRecord(payload.goal)
        ? {
            ...base,
            snapshot: {
              ...base.snapshot,
              goal: payload.goal as unknown as NonNullable<NativeSessionState['snapshot']>['goal'],
              ...(Array.isArray(payload.timeline) ? { goalTimeline: payload.timeline as NonNullable<NativeSessionState['snapshot']>['goalTimeline'] } : {}),
            },
          }
        : base;
    case 'conversation.goal.cleared':
      return base.snapshot ? { ...base, snapshot: { ...base.snapshot, goal: null, ...(Array.isArray(payload.timeline) ? { goalTimeline: payload.timeline as NonNullable<NativeSessionState['snapshot']>['goalTimeline'] } : {}) } } : base;
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

  const providerKey = nativeSessionItemKey(conversationId, threadId, turnId, itemId);
  const providerItem = state.items[providerKey];
  const completed = event.type === 'conversation.item.completed';
  const incomingText = stringValue(payload.textContent) ?? '';
  const incomingType = stringValue(payload.itemType);
  const incomingPayload = isRecord(payload.itemPayload) ? payload.itemPayload : null;
  const incomingResources = Array.isArray(payload.itemResources) ? payload.itemResources : null;
  const effectiveType = completed ? (incomingType ?? providerItem?.type ?? 'providerItem') : (providerItem?.type ?? incomingType ?? 'providerItem');
  const providerClientId = isUserMessageType(effectiveType) && incomingPayload ? (stringValue(incomingPayload.clientId) ?? stringValue(incomingPayload.clientUserMessageId)) : null;
  const matchedUserEntry = isUserMessageType(effectiveType)
    ? Object.entries(state.items).find(([, item]) => isUserMessageItem(item) && ((providerClientId !== null && userMessageClientIds(item).includes(providerClientId)) || (!item.optimistic && item.providerItemId === itemId)))
    : undefined;
  const optimisticEntry = matchedUserEntry?.[1].optimistic ? matchedUserEntry : undefined;
  const matchedUserItem = matchedUserEntry?.[1];
  const matchedKey = matchedUserEntry?.[0];
  const key = matchedKey ?? providerKey;
  const previous = state.items[key] ?? providerItem;
  if (previous && isTerminalItemStatus(previous.status) && !completed) return state;
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
    payload: completed
      ? isUserMessageType(effectiveType)
        ? mergeStableUserMessagePresentation(previous?.payload ?? matchedUserItem?.payload, incomingPayload)
        : (incomingPayload ?? previous?.payload ?? matchedUserItem?.payload ?? {})
      : mergeProgressPayload(previous?.payload ?? matchedUserItem?.payload, incomingPayload),
    resources: completed ? (incomingResources ?? previous?.resources ?? matchedUserItem?.resources ?? []) : (previous?.resources ?? matchedUserItem?.resources ?? incomingResources ?? []),
    ...(resolvedClientId ? { clientUserMessageId: resolvedClientId, durableClientUserMessageId: resolvedClientId, optimistic: false } : {}),
    // 首次事件确定条目的时间线位置；delta/completed 只更新内容，不能让历史位置漂移。
    timelineAt: previous?.timelineAt ?? matchedUserItem?.timelineAt ?? event.createdAt,
    updatedAt: event.createdAt,
  };
  const isNew = previous === undefined;
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

function latestResolvedRequestAt(requests: readonly NativePendingRequest[], turnId: string): string | null {
  let latest: string | null = null;
  for (const request of requests) {
    if (request.turnId !== turnId || request.status !== 'resolved' || !request.resolvedAt) continue;
    if (!latest || request.resolvedAt > latest) latest = request.resolvedAt;
  }
  return latest;
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

function mergeStableUserMessagePresentation(previous: Record<string, unknown> | undefined, incoming: Record<string, unknown> | null): Record<string, unknown> {
  const next = incoming ?? {};
  if (!previous) return next;
  return {
    ...next,
    ...(next.submissionId === undefined && previous.submissionId !== undefined ? { submissionId: previous.submissionId } : {}),
    ...(next.taskPushLayout === undefined && previous.taskPushLayout !== undefined ? { taskPushLayout: previous.taskPushLayout } : {}),
    ...(next.attachments === undefined && previous.attachments !== undefined ? { attachments: previous.attachments } : {}),
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
    status: action.queuedUntilHydrated ? 'queued' : 'pending',
    phase: 'prework',
    text: action.draft,
    payload: {
      attachments: action.submittedAttachments,
      delivery: action.delivery,
      ...(action.taskPushLayout ? { taskPushLayout: action.taskPushLayout } : {}),
      ...(action.browserComments.length ? { browserComments: action.browserComments } : {}),
      ...(action.contextDraft.responseAnnotations.length || action.contextDraft.codeComments.length ? { conversationContext: action.contextDraft } : {}),
    },
    resources: [],
    optimistic: true,
    clientUserMessageId: action.clientUserMessageId,
    durableClientUserMessageId: action.durableClientUserMessageId,
    timelineAt: action.startedAt,
    updatedAt: action.startedAt,
  };
  const keepActiveState =
    action.previousConversationState === 'active_prework' || action.previousConversationState === 'active_final_answer' || action.previousConversationState === 'waiting_approval' || action.previousConversationState === 'waiting_user_input';
  return {
    ...state,
    items: { ...state.items, [key]: item },
    itemOrder: existingOptimisticEntry || state.items[key] ? state.itemOrder : [...state.itemOrder, key],
    transcriptRevision: state.transcriptRevision + 1,
    conversationState: action.queuedUntilHydrated ? action.previousConversationState : keepActiveState ? action.previousConversationState : 'starting_turn',
    draft: '',
    attachments: [],
    browserSubmission: null,
    contextDraft: structuredClone(emptyConversationContextDraft),
    error: null,
  };
}

function projectQueueSubmissionMessages(state: NativeSessionState, queue: NativeQueueSnapshot): NativeSessionState {
  let items = state.items;
  let itemOrder = state.itemOrder;
  let transcriptChanged = false;
  const conversationId = state.conversationId;
  const threadId = state.providerThreadId ?? state.snapshot?.providerThreadId ?? 'unbound-thread';
  // send-now 的本地交接先于 HTTP/事件确认完成。旧的 queued/dispatching 快照不能把
  // 已经进入当前 turn 的 steer 消息重新画回队列，否则会出现“队列消失后又闪回”的断层。
  const projectedQueue: NativeQueueSnapshot = {
    ...queue,
    submissions: queue.submissions.filter((submission) => !hasPendingSteeringProjection(state.items, submission)),
  };

  if (conversationId) {
    for (const submission of projectedQueue.submissions) {
      const clientUserMessageId = submission.clientUserMessageId;
      if (!clientUserMessageId || !shouldProjectSubmissionMessage(submission)) continue;
      const matchedEntry = Object.entries(items).find(([, item]) => isUserMessageItem(item) && userMessageClientIds(item).includes(clientUserMessageId));
      if (matchedEntry && !matchedEntry[1].optimistic) continue;

      const key = matchedEntry?.[0] ?? optimisticUserItemKey(state, clientUserMessageId);
      const previous = matchedEntry?.[1];
      const turnId = submission.providerTurnId ?? `pending:${clientUserMessageId}`;
      const itemId = `${submission.delivery === 'steer_now' ? 'steering' : 'submission'}:${submission.id}`;
      const projected = submissionUserMessageItem(conversationId, threadId, submission, key, itemId, turnId);
      const next = previous
        ? {
            ...projected,
            resources: previous.resources,
            payload: mergeSubmissionUserMessagePayload(previous.payload, submission),
            timelineAt: previous.timelineAt ?? projected.timelineAt,
          }
        : projected;
      if (previous && equivalentSessionItem(previous, next)) continue;
      if (items === state.items) items = { ...state.items };
      items[key] = next;
      if (!previous) itemOrder = [...itemOrder, key];
      transcriptChanged = true;
    }
  }

  return {
    ...state,
    items,
    itemOrder,
    queue: projectedQueue,
    conversationState: conversationStateFromQueue(projectedQueue, state),
    transcriptRevision: state.transcriptRevision + (transcriptChanged ? 1 : 0),
  };
}

function shouldProjectSubmissionMessage(submission: NativeQueuedSubmission): boolean {
  if (shouldRecoverSubmissionToComposer(submission)) return false;
  if (submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active' || submission.status === 'failed' || submission.status === 'completed' || submission.status === 'resolved') return true;
  // user_confirmation 尚未确认进入会话记录，继续回到输入框；其余暂停态保留原消息和可见原因。
  return submission.status === 'paused' && submission.pausedReason !== 'user_confirmation';
}

function shouldDiscardSubmissionProjection(submission: NativeQueuedSubmission): boolean {
  return submission.status === 'cancelled' || submission.status === 'deleted';
}

function shouldRecoverSubmissionToComposer(submission: NativeQueuedSubmission): boolean {
  return (submission.status === 'queued' || submission.status === 'paused') && submission.pausedReason === 'user_confirmation' && !submission.providerTurnId;
}

function projectSteeringSubmission(state: NativeSessionState, submission: NativeQueuedSubmission, authoritativeQueue?: NativeQueueSnapshot): NativeSessionState {
  const queue = authoritativeQueue
    ? { ...authoritativeQueue, submissions: authoritativeQueue.submissions.filter((entry) => entry.id !== submission.id) }
    : state.queue
      ? { ...state.queue, submissions: state.queue.submissions.filter((entry) => entry.id !== submission.id) }
      : null;
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
  const previousKey = matchedEntry?.[0];
  const key = previousKey ?? nativeSessionItemKey(conversationId, threadId, turnId, itemId);
  const previous = matchedEntry?.[1];
  const item: NativeSessionItemBuffer = {
    ...submissionUserMessageItem(conversationId, threadId, submission, key, itemId),
    ...(previous
      ? {
          text: submission.content || previous.text,
          resources: previous.resources,
          payload: mergeSubmissionUserMessagePayload(previous.payload, submission),
        }
      : {}),
  };
  const items = { ...state.items, [key]: item };
  const itemOrder = previousKey || state.itemOrder.includes(key) ? state.itemOrder : [...state.itemOrder, key];
  return {
    ...state,
    items,
    itemOrder,
    ...(queue ? { queue, conversationState: conversationStateFromQueue(queue, state) } : {}),
    transcriptRevision: state.transcriptRevision + 1,
  };
}

function markSteeringSubmissionUnconfirmed(state: NativeSessionState, submissionId: string, clientUserMessageId: string | undefined, error: NativeSessionError): NativeSessionState {
  const matchedEntry = Object.entries(state.items).find(
    ([, item]) => item.optimistic && isUserMessageItem(item) && ((clientUserMessageId ? userMessageClientIds(item).includes(clientUserMessageId) : false) || stringValue(item.payload.submissionId) === submissionId),
  );
  if (!matchedEntry) return { ...state, error };
  const [key, previous] = matchedEntry;
  return {
    ...state,
    items: {
      ...state.items,
      [key]: {
        ...previous,
        status: 'unconfirmed',
        payload: {
          ...previous.payload,
          deliveryError: error,
        },
      },
    },
    transcriptRevision: state.transcriptRevision + 1,
    error,
  };
}

function hasPendingSteeringProjection(items: Record<string, NativeSessionItemBuffer>, submission: NativeQueuedSubmission): boolean {
  if (submission.status !== 'queued' && submission.status !== 'dispatching') return false;
  if (submission.providerTurnId) return false;
  return Object.values(items).some(
    (item) =>
      item.optimistic &&
      isUserMessageItem(item) &&
      stringValue(item.payload.delivery) === 'steer_now' &&
      item.status !== 'failed' &&
      item.status !== 'unconfirmed' &&
      ((submission.clientUserMessageId ? userMessageClientIds(item).includes(submission.clientUserMessageId) : false) || stringValue(item.payload.submissionId) === submission.id),
  );
}

function removeQueuedSubmissionProjection(state: NativeSessionState, submissionId: string, requestedClientUserMessageId: string | undefined, queue: NativeQueueSnapshot): NativeSessionState {
  const clientUserMessageId = requestedClientUserMessageId ?? state.queue?.submissions.find((submission) => submission.id === submissionId)?.clientUserMessageId;
  const removedKeys = Object.entries(state.items)
    .filter(([, item]) => item.optimistic && isUserMessageItem(item) && ((clientUserMessageId ? userMessageClientIds(item).includes(clientUserMessageId) : false) || stringValue(item.payload.submissionId) === submissionId))
    .map(([key]) => key);
  if (removedKeys.length === 0) {
    return { ...state, queue, conversationState: conversationStateFromQueue(queue, state) };
  }
  const removedKeySet = new Set(removedKeys);
  const items = { ...state.items };
  for (const key of removedKeys) delete items[key];
  return {
    ...state,
    items,
    itemOrder: state.itemOrder.filter((key) => !removedKeySet.has(key)),
    queue,
    conversationState: conversationStateFromQueue(queue, state),
    transcriptRevision: state.transcriptRevision + 1,
  };
}

function submissionUserMessageItem(conversationId: string, threadId: string, submission: NativeQueuedSubmission, key: string, itemId: string, turnId = submission.providerTurnId!): NativeSessionItemBuffer {
  return {
    key,
    conversationId,
    threadId,
    turnId,
    itemId,
    type: 'userMessage',
    status: submission.status,
    phase: 'prework',
    text: submission.content,
    payload: submissionUserMessagePayload(submission),
    resources: [],
    optimistic: submission.status !== 'completed' && submission.status !== 'resolved',
    clientUserMessageId: submission.clientUserMessageId,
    durableClientUserMessageId: submission.clientUserMessageId,
    timelineAt: submission.createdAt ?? submission.updatedAt,
    updatedAt: submission.updatedAt ?? submission.createdAt,
  };
}

function submissionUserMessagePayload(submission: NativeQueuedSubmission): Record<string, unknown> {
  return {
    delivery: submission.delivery ?? 'queue',
    submissionId: submission.id,
    attachments: submission.attachments ?? [],
    ...(submission.conversationContext ? { conversationContext: submission.conversationContext } : {}),
    ...(submission.pausedReason ? { pausedReason: submission.pausedReason } : {}),
    ...(submission.error ? { error: submission.error, deliveryError: submission.error } : {}),
  };
}

function mergeSubmissionUserMessagePayload(previous: Record<string, unknown>, submission: NativeQueuedSubmission): Record<string, unknown> {
  const next = { ...previous, ...submissionUserMessagePayload(submission) };
  if (!submission.pausedReason) delete next.pausedReason;
  if (!submission.error) {
    delete next.error;
    delete next.deliveryError;
  }
  return next;
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
  if (active?.providerTurnId) return active.providerTurnId;
  const activeSubmission = [...snapshot.submissions].reverse().find((submission) => submission.status === 'active' && submission.providerTurnId);
  return activeSubmission?.providerTurnId ?? null;
}

function conversationStateFromSnapshot(snapshot: NativeConversationSnapshot): ConversationState {
  if (snapshot.transportKind !== 'codex_native') return 'legacy_readonly';
  const requestState = requestConversationState(snapshot.requests);
  if (requestState) return requestState;
  if (snapshot.status === 'failed' || snapshot.providerState === 'failed') return 'turn_failed';
  if (activeTurnFromSnapshot(snapshot) && snapshot.queue.state.type === 'idle') return 'active_prework';
  if (snapshot.submissions.some((submission) => submission.status === 'dispatching' && !submission.providerTurnId)) return 'starting_turn';
  switch (snapshot.queue.state.type) {
    case 'dispatching':
      return 'starting_turn';
    case 'active':
      return snapshot.queue.state.phase === 'final_answer' ? 'active_final_answer' : 'active_prework';
    case 'waiting':
      return snapshot.queue.state.reason === 'user_input' ? 'waiting_user_input' : 'waiting_approval';
    case 'paused':
      return 'native_idle';
    case 'idle':
      return 'native_idle';
  }
}

function requestConversationState(requests: NativePendingRequest[]): ConversationState | null {
  const pending = requests.find((request) => request.status === 'pending');
  if (!pending) return null;
  return pending.type === 'userInput' || pending.type === 'request_user_input' ? 'waiting_user_input' : 'waiting_approval';
}

function pendingRequestFromEvent(value: unknown, requestId: string): NativePendingRequest | null {
  if (!isRecord(value) || value.id !== requestId || typeof value.conversationId !== 'string' || typeof value.generationId !== 'string' || typeof value.type !== 'string' || typeof value.status !== 'string') return null;
  if (!isRecord(value.payload) || Object.keys(value.payload).length === 0 || (value.response !== null && !isRecord(value.response))) return null;
  if (typeof value.containsSecret !== 'boolean' || typeof value.createdAt !== 'string') return null;
  if (value.turnId !== null && typeof value.turnId !== 'string') return null;
  if (value.itemId !== null && typeof value.itemId !== 'string') return null;
  if (value.expiresAt !== null && typeof value.expiresAt !== 'string') return null;
  if (value.resolvedAt !== null && typeof value.resolvedAt !== 'string') return null;
  if (value.autoResolutionState !== undefined && value.autoResolutionState !== 'none' && value.autoResolutionState !== 'scheduled' && value.autoResolutionState !== 'snoozed') return null;
  return value as unknown as NativePendingRequest;
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
      return 'native_idle';
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
  return {
    message: stringValue(nested?.message) ?? stringValue(payload.message) ?? 'Codex native conversation failed',
    code,
    recoveryRequired: false,
    retryable: booleanValue(nested?.retryable) ?? booleanValue(payload.retryable) ?? false,
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
    lastApiEquivalentUsd: numberValue(payload.lastApiEquivalentUsd),
    cacheSavingsUsd: numberValue(payload.cacheSavingsUsd),
    priceCoverage: numberValue(payload.priceCoverage),
    pricingCatalogDate: stringValue(payload.pricingCatalogDate),
    pricingSourceUrls: Array.isArray(payload.pricingSourceUrls) ? payload.pricingSourceUrls.filter((value): value is string => typeof value === 'string') : [],
    historyComplete: payload.historyComplete === true,
  };
}

function unifiedUsageFrom(value: unknown): NativeUnifiedUsageSnapshot | null {
  if (!isRecord(value) || !isRecord(value.conversationTotal) || !isRecord(value.turnTotal)) return null;
  return value as unknown as NativeUnifiedUsageSnapshot;
}

function sessionMetricsFrom(value: unknown): NativeSessionMetricsSnapshot | null {
  if (!isRecord(value) || !isRecord(value.usage) || !isRecord(value.cost) || !isRecord(value.performance) || !isRecord(value.activity) || !isRecord(value.changeSummary)) return null;
  return value as unknown as NativeSessionMetricsSnapshot;
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
