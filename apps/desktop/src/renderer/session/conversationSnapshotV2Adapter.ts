import type {
  NativeConversationChoice,
  NativeConversationModelHistoryV2Item,
  NativeConversationProcessV2Item,
  NativeConversationSnapshot,
  NativeConversationSnapshotV2,
  NativeConversationSnapshotV2Page,
  NativeGoalResponse,
  NativeItemSnapshot,
  NativePendingRequest,
  NativePlanImplementationRequest,
  NativeQueueSnapshot,
  NativeTurnSnapshot,
} from './sessionTypes.js';

const syncStreamProtocolGeneration = 'zeus-conversation-sync-v1' as const;

export interface ConversationSnapshotV2BootstrapInput {
  snapshot: NativeConversationSnapshotV2;
  history: NativeConversationSnapshotV2Page<NativeConversationModelHistoryV2Item>;
  queue: NativeQueueSnapshot;
  requests: NativePendingRequest[];
  planImplementationRequests: NativePlanImplementationRequest[];
  choice: NativeConversationChoice;
  goal: NativeGoalResponse;
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
  const usage = snapshot.sessionMetrics.usage;
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
      confirmedEntryCount: input.history.items.length,
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
    items: historyItems(input.history.items, providerTurnIdentityMap(turns)),
    changeSets: [],
    submissions: input.queue.submissions,
    queue: input.queue,
    requests: input.requests,
    planImplementationRequests: input.planImplementationRequests,
    ...(snapshot.conversation.providerSettings ? { providerSettings: snapshot.conversation.providerSettings } : snapshot.conversation.providerModel ? { providerSettings: { model: snapshot.conversation.providerModel } } : {}),
    ...(nextTurnSettings ? { nextTurnSettings } : {}),
    sessionMetrics: snapshot.sessionMetrics,
    permissionMode,
    collaborationMode,
    goal: input.goal.goal,
    goalTimeline: input.goal.timeline,
    goalCapability: input.goal.capability,
    snapshotV2: snapshot,
    v2Paging: {
      history: { nextCursor: input.history.nextCursor, hasMore: input.history.hasMore, loading: false, error: null },
      processByTurn: {},
      resources: { nextCursor: null, hasMore: snapshot.collections.resources.available, loading: false, loaded: false, error: null, items: [] },
      changeSetsByTurn: {},
    },
  };
}

export function mergeConversationHistoryV2(snapshot: NativeConversationSnapshot, page: NativeConversationSnapshotV2Page<NativeConversationModelHistoryV2Item>): NativeConversationSnapshot {
  if (!snapshot.snapshotV2 || !snapshot.v2Paging || page.schemaVersion !== 2 || page.structureGeneration !== snapshot.snapshotV2.structureGeneration || page.conversationId !== snapshot.id || page.kind !== 'model_history')
    throw new Error('会话 V2 历史页与当前快照不匹配。');
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  for (const item of historyItems(page.items, providerTurnIdentityMap(snapshot.turns))) byId.set(item.id, item);
  const items = [...byId.values()].sort(compareNativeItems);
  return {
    ...snapshot,
    items,
    contextState: {
      ...snapshot.contextState,
      throughModelHistorySequence: page.throughSequence,
      confirmedEntryCount: items.length,
      partial: page.hasMore,
    },
    v2Paging: {
      ...snapshot.v2Paging,
      history: { nextCursor: page.nextCursor, hasMore: page.hasMore, loading: false, error: null },
    },
  };
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
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const byProviderItemId = new Map(snapshot.items.flatMap((item) => (item.providerItemId ? [[item.providerItemId, item] as const] : [])));
  for (const item of processItems(page.items, providerTurnIdentityMap(snapshot.turns))) {
    const previous = item.providerItemId ? byProviderItemId.get(item.providerItemId) : undefined;
    if (previous && previous.id !== item.id) byId.delete(previous.id);
    byId.set(item.id, item);
    if (item.providerItemId) byProviderItemId.set(item.providerItemId, item);
  }
  return {
    ...snapshot,
    items: [...byId.values()].sort(compareNativeItems),
    v2Paging: {
      ...snapshot.v2Paging,
      processByTurn: {
        ...snapshot.v2Paging.processByTurn,
        [turnId]: { nextCursor: page.nextCursor, hasMore: page.hasMore, loading: false, loaded: true, error: null },
      },
    },
  };
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
    const phase = item.role === 'user' || reasoning || item.phase === 'prework' || item.phase === 'commentary' ? 'prework' : 'final_answer';
    const historicalUserPayload =
      item.role === 'user' && contentRecord
        ? {
            ...(Array.isArray(contentRecord.attachments) ? { attachments: contentRecord.attachments } : {}),
            ...(recordValue(contentRecord.taskPushLayout) ? { taskPushLayout: contentRecord.taskPushLayout } : {}),
            ...(recordValue(contentRecord.conversationContext) ? { conversationContext: contentRecord.conversationContext } : {}),
          }
        : {};
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
  if (text) return text;
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
