import type {
  NativeConversationChoice,
  NativeConversationModelHistoryV2Item,
  NativeConversationProcessV2Item,
  NativeConversationSnapshot,
  NativeConversationSnapshotV2,
  NativeConversationSnapshotV2Page,
  NativeConversationV2PagingState,
  NativeGoalResponse,
  NativeItemSnapshot,
  NativePendingRequest,
  NativePlanImplementationRequest,
  NativeQueueSnapshot,
  NativeTurnSnapshot,
  NativeUnifiedUsageSnapshot,
} from './sessionTypes.js';

const syncStreamProtocolGeneration = 'zeus-conversation-sync-v2' as const;

export interface ConversationSnapshotV2BootstrapInput {
  snapshot: NativeConversationSnapshotV2;
  history: NativeConversationSnapshotV2Page<NativeConversationModelHistoryV2Item>;
  queue: NativeQueueSnapshot;
  requests: NativePendingRequest[];
  planImplementationRequests: NativePlanImplementationRequest[];
  choice: NativeConversationChoice;
  goal: NativeGoalResponse;
}

type HistoryPagingState = NativeConversationV2PagingState['history'];

export interface ConversationHistoryCacheReconciliation {
  snapshot: NativeConversationSnapshot;
  preserveCachedHistory: boolean;
}

/**
 * 把有界 V2 首屏投影到现有会话 reducer；这里只做展示适配，不伪造 Provider 事件或完整历史。
 * 历史、过程、资源和 diff 的游标仍保存在 snapshot.v2Paging 中并按需继续读取。
 */
export function adaptConversationSnapshotV2(input: ConversationSnapshotV2BootstrapInput): NativeConversationSnapshot {
  assertSnapshotV2Identity(input.snapshot, input.history, input.choice);
  const snapshot = input.snapshot;
  const choice = input.choice;
  const turns = snapshotTurns(snapshot);
  const bootstrapHistory = modelHistoryWithOpeningAnchors(snapshot, input.history.items);
  const permissionMode = snapshot.conversation.nextTurnSettings?.permissionMode ?? choice.permissionMode ?? 'read-only';
  const collaborationMode = snapshot.conversation.nextTurnSettings?.collaborationMode ?? choice.collaborationMode ?? 'default';
  const nextTurnSettings =
    snapshot.conversation.nextTurnSettings ??
    (snapshot.conversation.providerModel
      ? {
          model: snapshot.conversation.providerModel,
          permissionMode,
          collaborationMode,
        }
      : undefined);
  const usage = snapshot.sessionMetrics?.usage ?? emptyUnifiedUsageSnapshot();
  return {
    conversationSchemaGeneration: snapshot.conversationSchemaGeneration,
    syncStreamGeneration: syncStreamProtocolGeneration,
    throughEventSeq: snapshot.throughEventSeq,
    productConversation: {
      id: snapshot.conversation.id,
      projectId: snapshot.conversation.projectId,
      taskId: snapshot.conversation.taskId,
      title: snapshot.conversation.title,
      archived: snapshot.conversation.archived,
      createdAt: snapshot.conversation.createdAt,
      updatedAt: snapshot.conversation.updatedAt,
    },
    openSegment: snapshot.openSegment,
    segments: snapshot.openSegment ? [snapshot.openSegment] : [],
    composerPreset: nextTurnSettings ? { ...nextTurnSettings } : {},
    executionQueue: input.queue,
    process: [],
    usage,
    contextState: {
      throughModelHistorySequence: input.history.throughSequence,
      confirmedEntryCount: bootstrapHistory.length,
      partial: input.history.hasMore,
    },
    persistentWarnings: [],
    configurationEvidence: [],
    id: snapshot.conversation.id,
    projectId: snapshot.conversation.projectId,
    taskId: snapshot.conversation.taskId,
    sessionId: null,
    title: snapshot.conversation.title,
    summary: choice.summary,
    status: snapshot.conversation.status,
    stage: snapshot.conversation.stage,
    stageUpdatedAt: snapshot.conversation.stageUpdatedAt,
    transportKind: snapshot.conversation.transportKind,
    providerId: choice.providerId,
    providerThreadId: snapshot.openSegment?.nativeSessionId ?? choice.providerThreadId,
    providerModel: snapshot.conversation.providerModel,
    providerState: snapshot.conversation.providerState,
    legacySourceConversationId: choice.legacySourceConversationId,
    provider: {
      id: choice.providerId,
      threadId: snapshot.openSegment?.nativeSessionId ?? choice.providerThreadId,
      model: snapshot.conversation.providerModel,
      state: snapshot.conversation.providerState,
    },
    agent: choice.agent ?? {
      kind: snapshot.conversation.agentKind === 'codex' || snapshot.conversation.agentKind === 'pi' || snapshot.conversation.agentKind === 'claude' ? snapshot.conversation.agentKind : null,
      transport: null,
      supportStatus: 'unavailable',
      capabilitySnapshotId: null,
    },
    model: choice.model ?? { sourceId: null, id: snapshot.conversation.providerModel },
    nativeSession: choice.nativeSession ?? { id: snapshot.openSegment?.nativeSessionId ?? null, path: null },
    createdAt: snapshot.conversation.createdAt,
    updatedAt: snapshot.conversation.updatedAt,
    archived: snapshot.conversation.archived,
    hasUnreadAttention: choice.hasUnreadAttention,
    attentionKind: choice.attentionKind,
    attentionRevision: choice.attentionRevision,
    attentionTurnId: choice.attentionTurnId,
    attentionUpdatedAt: choice.attentionUpdatedAt,
    pendingRequestKind: choice.pendingRequestKind,
    messages: [],
    turns,
    items: historyItems(bootstrapHistory, providerTurnIdentityMap(turns)),
    changeSets: [],
    submissions: input.queue.submissions,
    queue: input.queue,
    requests: input.requests,
    planImplementationRequests: input.planImplementationRequests,
    ...(snapshot.conversation.providerSettings ? { providerSettings: snapshot.conversation.providerSettings } : snapshot.conversation.providerModel ? { providerSettings: { model: snapshot.conversation.providerModel } } : {}),
    ...(nextTurnSettings ? { nextTurnSettings } : {}),
    ...(snapshot.sessionMetrics ? { sessionMetrics: snapshot.sessionMetrics } : {}),
    permissionMode,
    collaborationMode,
    goal: input.goal.goal,
    goalTimeline: input.goal.timeline,
    goalCapability: input.goal.capability,
    snapshotV2: snapshot,
    v2Paging: {
      history: {
        nextCursor: input.history.nextCursor,
        hasMore: input.history.hasMore,
        loading: false,
        error: null,
        loadedThroughSequence: input.history.throughSequence,
        oldestLoadedSequence: oldestHistorySequence(input.history.items),
      },
      historyByTurn: {},
      processByTurn: {},
      resources: { nextCursor: null, hasMore: snapshot.collections.resources.available, loading: false, loaded: false, error: null, items: [] },
      changeSetsByTurn: {},
    },
  };
}

function emptyUnifiedUsageSnapshot(): NativeUnifiedUsageSnapshot {
  const empty = {
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    estimatedUsd: null,
    complete: false,
  };
  return {
    conversationTotal: { ...empty },
    turnTotal: { ...empty },
    latestModelRequest: null,
    preflightEstimate: null,
  };
}

export function mergeConversationHistoryV2(snapshot: NativeConversationSnapshot, page: NativeConversationSnapshotV2Page<NativeConversationModelHistoryV2Item>): NativeConversationSnapshot {
  if (!snapshot.snapshotV2 || !snapshot.v2Paging || page.schemaVersion !== 2 || page.structureGeneration !== snapshot.snapshotV2.structureGeneration || page.conversationId !== snapshot.id || page.kind !== 'model_history')
    throw new Error('会话 V2 历史页与当前快照不匹配。');
  const items = mergeItemsByProviderIdentity(snapshot.items, historyItems(page.items, providerTurnIdentityMap(snapshot.turns)));
  const currentHistory = snapshot.v2Paging.history;
  const pageOldestSequence = oldestHistorySequence(page.items);
  return {
    ...snapshot,
    items,
    contextState: {
      ...snapshot.contextState,
      throughModelHistorySequence: maximumKnownSequence(currentHistory.loadedThroughSequence, page.throughSequence) ?? page.throughSequence,
      confirmedEntryCount: items.length,
      partial: page.hasMore,
    },
    v2Paging: {
      ...snapshot.v2Paging,
      history: {
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        loading: false,
        error: null,
        loadedThroughSequence: maximumKnownSequence(currentHistory.loadedThroughSequence, page.throughSequence),
        oldestLoadedSequence: minimumKnownSequence(currentHistory.oldestLoadedSequence, pageOldestSequence),
      },
    },
  };
}

/**
 * 完整正文读取成功后只替换同一稳定句柄对应的模型历史投影。
 * 句柄包含正文 revision；后续权威快照只有携带同一句柄时才能复用该全文。
 */
export function mergeConversationModelContentV2(snapshot: NativeConversationSnapshot, handle: string, text: string, redacted: boolean): NativeConversationSnapshot {
  if (!snapshot.snapshotV2) throw new Error('当前会话不支持 Snapshot V2 完整正文。');
  let matched = false;
  const items = snapshot.items.map((item) => {
    if (item.payload.v2ContentHandle !== handle) return item;
    if (item.payload.v2ContentKind !== 'model_history') throw new Error('正文句柄没有指向模型历史。');
    matched = true;
    const content = parseProjection(text, false);
    return {
      ...item,
      text: projectionText(content, text, false),
      payload: {
        ...item.payload,
        content,
        ...historicalUserPresentation(content, item.type === 'userMessage'),
        v2ContentTruncated: false,
        v2ContentCompleteHandle: handle,
        v2ContentRedacted: item.payload.v2ContentRedacted === true || redacted,
      },
    };
  });
  if (!matched) throw new Error('完整正文句柄不属于当前会话快照。');
  return { ...snapshot, items };
}

/**
 * 热缓存重新接管时只恢复可复用的展示进度，不恢复已取消请求的瞬时状态。
 * 旧 session-view-cache-v1 没有范围字段时，从 V2 高水位与可见历史序列保守推导；
 * 无法证明时写入 null，让下一次权威水合按尾页安全回退。
 */
export function resumeCachedConversationSnapshot(snapshot: NativeConversationSnapshot): NativeConversationSnapshot {
  if (!snapshot.snapshotV2 || !snapshot.v2Paging) return snapshot;
  const history = normalizeHistoryPaging(snapshot);
  return {
    ...snapshot,
    v2Paging: {
      ...snapshot.v2Paging,
      history: { ...history, loading: false, error: null },
    },
  };
}

/**
 * 权威尾页只有在覆盖到缓存最高水位时才能继续沿用缓存深游标。
 * 若高水位倒退、两段范围断开或旧缓存范围不可证明，则由权威尾页重新拥有时间线。
 */
export function reconcileConversationHistoryCache(previous: NativeConversationSnapshot | null, authoritative: NativeConversationSnapshot): ConversationHistoryCacheReconciliation {
  const next = resumeCachedConversationSnapshot(authoritative);
  if (!previous?.snapshotV2 || !previous.v2Paging || !next.snapshotV2 || !next.v2Paging || previous.id !== next.id || previous.snapshotV2.structureGeneration !== next.snapshotV2.structureGeneration)
    return { snapshot: next, preserveCachedHistory: false };

  const cached = normalizeHistoryPaging(previous);
  const fresh = next.v2Paging.history;
  if (!historyRangesJoin(cached, fresh)) return { snapshot: next, preserveCachedHistory: false };

  return {
    snapshot: {
      ...next,
      v2Paging: {
        ...next.v2Paging,
        history: {
          ...fresh,
          nextCursor: cached.nextCursor,
          hasMore: cached.hasMore,
          loadedThroughSequence: maximumKnownSequence(cached.loadedThroughSequence, fresh.loadedThroughSequence),
          oldestLoadedSequence: minimumKnownSequence(cached.oldestLoadedSequence, fresh.oldestLoadedSequence),
        },
      },
    },
    preserveCachedHistory: true,
  };
}

function normalizeHistoryPaging(snapshot: NativeConversationSnapshot): HistoryPagingState {
  const history = snapshot.v2Paging!.history as HistoryPagingState;
  if (validHistoryRange(history.loadedThroughSequence, history.oldestLoadedSequence)) return history;
  const throughSequence = snapshot.snapshotV2?.collections?.modelHistory?.throughSequence;
  const visibleSequences = snapshot.items
    .filter((item) => item.payload.v2ContentKind === 'model_history')
    .map((item) => item.payload.v2Sequence)
    .filter((sequence): sequence is number => validNonNegativeSequence(sequence));
  const inferredOldest = visibleSequences.length > 0 ? Math.min(...visibleSequences) : null;
  const canInfer = validNonNegativeSequence(throughSequence) && ((throughSequence === 0 && inferredOldest === null) || (inferredOldest !== null && inferredOldest <= throughSequence));
  return {
    ...history,
    loadedThroughSequence: canInfer ? throughSequence : null,
    oldestLoadedSequence: canInfer ? inferredOldest : null,
  };
}

function historyRangesJoin(cached: HistoryPagingState, fresh: HistoryPagingState): boolean {
  const cachedThrough = cached.loadedThroughSequence;
  const freshThrough = fresh.loadedThroughSequence;
  if (!validHistoryRange(cachedThrough, cached.oldestLoadedSequence) || !validHistoryRange(freshThrough, fresh.oldestLoadedSequence)) return false;
  if (cachedThrough === null || freshThrough === null || freshThrough < cachedThrough) return false;
  if (cachedThrough === 0) return freshThrough === 0;
  if (cached.oldestLoadedSequence === null || fresh.oldestLoadedSequence === null) return false;
  return fresh.oldestLoadedSequence <= cachedThrough + 1;
}

function validHistoryRange(throughSequence: number | null | undefined, oldestSequence: number | null | undefined): boolean {
  if (!validNonNegativeSequence(throughSequence)) return false;
  if (throughSequence === 0) return oldestSequence === null;
  return validNonNegativeSequence(oldestSequence) && oldestSequence > 0 && oldestSequence <= throughSequence;
}

function validNonNegativeSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function oldestHistorySequence(items: NativeConversationModelHistoryV2Item[]): number | null {
  return items.length > 0 ? Math.min(...items.map((item) => item.sequence)) : null;
}

function maximumKnownSequence(left: number | null | undefined, right: number | null | undefined): number | null {
  const values = [left, right].filter(validNonNegativeSequence);
  return values.length > 0 ? Math.max(...values) : null;
}

function minimumKnownSequence(left: number | null | undefined, right: number | null | undefined): number | null {
  const values = [left, right].filter(validNonNegativeSequence);
  return values.length > 0 ? Math.min(...values) : null;
}

export function mergeConversationProcessV2(snapshot: NativeConversationSnapshot, turnId: string, page: NativeConversationSnapshotV2Page<NativeConversationProcessV2Item>): NativeConversationSnapshot {
  if (
    !snapshot.snapshotV2 ||
    !snapshot.v2Paging ||
    page.schemaVersion !== 2 ||
    page.structureGeneration !== snapshot.snapshotV2.structureGeneration ||
    page.conversationId !== snapshot.id ||
    (page.kind !== 'process' && page.kind !== 'commands')
  )
    throw new Error('会话 V2 过程页与当前快照不匹配。');
  const items = mergeItemsByProviderIdentity(snapshot.items, processItems(page.items, providerTurnIdentityMap(snapshot.turns)));
  return {
    ...snapshot,
    items,
    v2Paging: {
      ...snapshot.v2Paging,
      processByTurn: {
        ...snapshot.v2Paging.processByTurn,
        [turnId]: { nextCursor: page.nextCursor, hasMore: page.hasMore, loading: false, loaded: true, error: null },
      },
    },
  };
}

export function mergeConversationTurnHistoryV2(snapshot: NativeConversationSnapshot, turnId: string, page: NativeConversationSnapshotV2Page<NativeConversationModelHistoryV2Item>): NativeConversationSnapshot {
  if (!snapshot.snapshotV2 || !snapshot.v2Paging || page.schemaVersion !== 2 || page.structureGeneration !== snapshot.snapshotV2.structureGeneration || page.conversationId !== snapshot.id || page.kind !== 'model_history') {
    throw new Error('会话 V2 轮次正文页与当前快照不匹配。');
  }
  const items = mergeItemsByProviderIdentity(snapshot.items, historyItems(page.items, providerTurnIdentityMap(snapshot.turns)));
  return {
    ...snapshot,
    items,
    v2Paging: {
      ...snapshot.v2Paging,
      historyByTurn: {
        ...snapshot.v2Paging.historyByTurn,
        [turnId]: { nextCursor: page.nextCursor, hasMore: page.hasMore, loading: false, loaded: true, error: null },
      },
    },
  };
}

/**
 * V2 正文、过程和实时投影可以用不同本地行 id 描述同一个 Provider item。
 * Provider 身份是跨分页稳定主键；过程详情比模型历史预览完整，冲突时保持过程详情。
 */
function mergeItemsByProviderIdentity(current: readonly NativeItemSnapshot[], incoming: readonly NativeItemSnapshot[]): NativeItemSnapshot[] {
  const byId = new Map<string, NativeItemSnapshot>();
  const byProviderItemId = new Map<string, NativeItemSnapshot>();
  const add = (item: NativeItemSnapshot): void => {
    const previous = item.providerItemId ? byProviderItemId.get(item.providerItemId) : byId.get(item.id);
    if (previous && previous.payload.v2ContentKind === 'process_detail' && item.payload.v2ContentKind !== 'process_detail') return;
    if (previous && previous.id !== item.id) byId.delete(previous.id);
    byId.set(item.id, item);
    if (item.providerItemId) byProviderItemId.set(item.providerItemId, item);
  };
  for (const item of current) add(item);
  for (const item of incoming) add(item);
  return [...byId.values()].sort(compareNativeItems);
}

export function updateConversationV2Paging(snapshot: NativeConversationSnapshot, update: (paging: NonNullable<NativeConversationSnapshot['v2Paging']>) => NonNullable<NativeConversationSnapshot['v2Paging']>): NativeConversationSnapshot {
  if (!snapshot.v2Paging) return snapshot;
  return { ...snapshot, v2Paging: update(snapshot.v2Paging) };
}

function assertSnapshotV2Identity(snapshot: NativeConversationSnapshotV2, history: NativeConversationSnapshotV2Page<NativeConversationModelHistoryV2Item>, choice: NativeConversationChoice): void {
  if (
    snapshot.schemaVersion !== 2 ||
    snapshot.structureGeneration !== '2026-08-21-conversation-snapshot-v2' ||
    snapshot.conversationSchemaGeneration !== '2026-08-16-unified-conversation-segments' ||
    history.schemaVersion !== 2 ||
    history.structureGeneration !== snapshot.structureGeneration ||
    history.kind !== 'model_history' ||
    history.conversationId !== snapshot.conversation.id ||
    history.throughEventSeq !== snapshot.throughEventSeq ||
    choice.id !== snapshot.conversation.id ||
    choice.projectId !== snapshot.conversation.projectId ||
    !Number.isSafeInteger(snapshot.throughEventSeq) ||
    snapshot.throughEventSeq < 0 ||
    (snapshot.eventStreamGeneration !== null && snapshot.eventStreamGeneration !== syncStreamProtocolGeneration)
  ) {
    throw new Error('Snapshot V2 首屏身份、结构代次或事件水位不一致。');
  }
}

function snapshotTurns(snapshot: NativeConversationSnapshotV2): NativeTurnSnapshot[] {
  const turns = [...snapshot.recentClosedTurns, ...(snapshot.activeTurn ? [snapshot.activeTurn] : [])];
  return [...new Map(turns.map((turn) => [turn.id, turn])).values()]
    .map((turn) => ({
      id: turn.id,
      providerTurnId: turn.providerTurnId,
      submissionId: turn.submissionId,
      status: turn.status,
      error: null,
      plan: turn.plan,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function modelHistoryWithOpeningAnchors(snapshot: NativeConversationSnapshotV2, items: NativeConversationModelHistoryV2Item[]): NativeConversationModelHistoryV2Item[] {
  const byId = new Map<string, NativeConversationModelHistoryV2Item>();
  for (const turn of [...snapshot.recentClosedTurns, ...(snapshot.activeTurn ? [snapshot.activeTurn] : [])]) {
    if (turn.openingUserMessage) byId.set(turn.openingUserMessage.id, turn.openingUserMessage);
  }
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function historyItems(items: NativeConversationModelHistoryV2Item[], providerTurnByLocalId: ReadonlyMap<string, string>): NativeItemSnapshot[] {
  return items.flatMap((item) => {
    const content = parseProjection(item.content.preview, item.content.truncated);
    const contentRecord = recordValue(content);
    // 工具调用正文可能超过 Snapshot V2 的 2,048 字符预览上限；此时 JSON 不完整，
    // 不能只依赖 content.type 分类。toolPairId 是稳定结构身份，前缀检查为缺失配对身份的旧数据兜底。
    const isToolCall = item.role === 'tool' || Boolean(item.toolPairId) || contentRecord?.type === 'tool_call' || startsWithToolCallProjection(item.content.preview);
    if (isToolCall) return [];
    // Snapshot V2 为控制首屏体积会把结构化模型正文投影为纯文本，reasoningSummary
    // 是跨分页、冷启动仍稳定的语义身份；provenance 只用于兼容旧服务端返回。
    const reasoning = item.reasoningSummary || typeof contentRecord?.provenance === 'string';
    const text = projectionText(content, item.content.preview, item.content.truncated);
    const persistedPlan = item.phase === 'plan';
    // 旧 Pi/DeepSeek 历史没有 phase；没有 reasoning/plan 证据的 assistant 内容是用户正文，
    // 不能因为缺少新版元数据就折叠进“处理过程”。
    const missingPhase = item.phase === null || item.phase === undefined || item.phase === '';
    const phase = item.role === 'assistant' && (item.phase === 'final_answer' || item.phase === 'finalAnswer' || (missingPhase && !persistedPlan && !reasoning)) ? 'final_answer' : 'prework';
    const historicalUserPayload = historicalUserPresentation(content, item.role === 'user');
    return [
      {
        id: item.id,
        turnId: providerTurnByLocalId.get(item.turnId) ?? item.turnId,
        providerItemId: item.providerItemId,
        type: item.role === 'user' ? 'userMessage' : persistedPlan ? 'plan' : reasoning ? 'reasoning' : 'agentMessage',
        status: 'completed',
        phase,
        text,
        payload: {
          content,
          ...(persistedPlan ? { formalPlan: item.formalPlan } : {}),
          ...historicalUserPayload,
          ...(item.submissionId ? { submissionId: item.submissionId } : {}),
          ...(item.clientUserMessageId
            ? {
                clientId: item.clientUserMessageId,
                clientUserMessageId: item.clientUserMessageId,
              }
            : {}),
          ...(item.phase ? { phase: item.phase } : {}),
          v2ContentKind: 'model_history',
          v2Sequence: item.sequence,
          v2ContentHandle: item.content.contentHandle,
          v2ContentTruncated: item.content.truncated,
          v2ContentBytes: item.content.byteLength,
          v2ContentRedacted: item.content.redacted,
        },
        resources: [],
        startedAt: item.confirmedAt,
        completedAt: item.confirmedAt,
        updatedAt: item.confirmedAt,
      },
    ];
  });
}

function historicalUserPresentation(content: unknown, userMessage: boolean): Record<string, unknown> {
  const contentRecord = userMessage ? recordValue(content) : null;
  if (!contentRecord) return {};
  return {
    ...(typeof contentRecord.displayText === 'string' && contentRecord.displayText.trim() ? { displayText: contentRecord.displayText } : {}),
    ...(Array.isArray(contentRecord.attachments) ? { attachments: contentRecord.attachments } : {}),
    ...(recordValue(contentRecord.taskPushLayout) ? { taskPushLayout: contentRecord.taskPushLayout } : {}),
    ...(recordValue(contentRecord.conversationContext) ? { conversationContext: contentRecord.conversationContext } : {}),
  };
}

function processItems(items: NativeConversationProcessV2Item[], providerTurnByLocalId: ReadonlyMap<string, string>): NativeItemSnapshot[] {
  return items.map((item) => {
    const detail = parseProjection(item.detail.preview, item.detail.truncated);
    const type = item.kind === 'reasoning' ? 'reasoning' : item.kind === 'command' ? 'commandExecution' : item.kind === 'context_compaction' ? 'contextCompaction' : item.kind === 'warning' ? 'error' : 'dynamicToolCall';
    const text = processProjectionText(item, detail);
    return {
      id: item.id,
      turnId: providerTurnByLocalId.get(item.turnId) ?? item.turnId,
      providerItemId: item.providerItemId,
      type,
      status: item.status,
      phase: 'prework',
      text,
      payload: {
        ...processPresentationPayload(item, detail, text),
        processKind: item.kind,
        title: item.title,
        toolResult: item.toolResult,
        v2ContentKind: 'process_detail',
        v2Sequence: item.sequence,
        v2ContentHandle: item.detail.contentHandle,
        v2ContentTruncated: item.detail.truncated,
        v2ContentBytes: item.detail.byteLength,
        v2ContentRedacted: item.detail.redacted,
      },
      resources: [],
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      updatedAt: item.completedAt ?? item.startedAt,
    };
  });
}

/**
 * Snapshot V2 的存储分页使用 Zeus 本地轮次 ID；会话 reducer 和实时事件使用
 * Provider 轮次 ID。进入 Renderer 时统一身份，避免同一轮的正文、过程、计划和
 * 已回答询问被拆成互不相认的两组。
 */
function providerTurnIdentityMap(turns: readonly NativeTurnSnapshot[]): ReadonlyMap<string, string> {
  return new Map(turns.map((turn) => [turn.id, turn.providerTurnId ?? turn.id]));
}

function processPresentationPayload(item: NativeConversationProcessV2Item, detail: unknown, text: string): Record<string, unknown> {
  const detailRecord = recordValue(detail);
  const source = recordValue(detailRecord?.payload) ?? recordValue(detailRecord?.block) ?? detailRecord;
  const presentation: Record<string, unknown> = {};
  if (source) {
    for (const key of ['type', 'command', 'cwd', 'aggregatedOutput', 'output', 'stdout', 'stderr', 'name', 'toolName', 'arguments', 'args', 'query', 'status', 'error', 'summary', 'content', 'presentation', 'commandActions'] as const) {
      if (source[key] !== undefined) presentation[key] = source[key];
    }
  }
  if (detailRecord) {
    for (const key of ['provider', 'itemType', 'eventType'] as const) {
      if (detailRecord[key] !== undefined) presentation[key] = detailRecord[key];
    }
  }
  if (item.kind === 'command' && presentation.command === undefined) presentation.command = text;
  return presentation;
}

function startsWithToolCallProjection(preview: string): boolean {
  return /^\s*\{\s*"type"\s*:\s*"tool_call"(?:\s*[,}])/u.test(preview);
}

function processProjectionText(item: NativeConversationProcessV2Item, detail: unknown): string {
  const projected = projectionText(detail, item.title, item.detail.truncated);
  if (!item.detail.truncated || typeof detail !== 'string') return projected;
  const preferredFields = item.kind === 'command' ? ['command'] : item.kind === 'tool' ? ['name', 'toolName', 'query'] : item.kind === 'reasoning' ? ['text', 'summary'] : ['message', 'text', 'summary'];
  for (const field of preferredFields) {
    const value = leadingJsonString(detail, field);
    if (value?.trim()) return value.trim();
  }
  return item.title;
}

function parseProjection(preview: string, truncated: boolean): unknown {
  if (!truncated) {
    try {
      return JSON.parse(preview) as unknown;
    } catch {
      return preview;
    }
  }
  const text = leadingJsonText(preview);
  return text === null ? preview : { text: `${text}…`, truncated: true };
}

function leadingJsonText(preview: string): string | null {
  return leadingJsonString(preview, 'text');
}

function leadingJsonString(preview: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, 'u').exec(preview);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replaceAll('\\n', '\n').replaceAll('\\"', '"');
  }
}

function projectionText(value: unknown, fallback: string, truncated: boolean): string {
  const fragments = textFragments(value);
  const text = fragments.join('\n\n').trim();
  if (text) return truncated && !text.endsWith('…') ? `${text}…` : text;
  return truncated ? `${fallback.trim()}…` : fallback;
}

function textFragments(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => textFragments(entry, depth + 1));
  const record = recordValue(value);
  if (!record) return [];
  return ['text', 'content', 'summary', 'value'].flatMap((key) => textFragments(record[key], depth + 1));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function compareNativeItems(left: NativeItemSnapshot, right: NativeItemSnapshot): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id);
}
