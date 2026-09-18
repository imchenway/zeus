import { ZeusApiError } from '../apps/desktop/src/renderer/transport/localApiTransport.ts';
import { createSessionController, type SessionControllerClient, sessionRealtimeBufferBudget } from '../apps/desktop/src/renderer/session/useSessionController.ts';
import { adaptConversationSnapshotV2, mergeConversationProcessV2, resumeCachedConversationSnapshot } from '../apps/desktop/src/renderer/session/conversationSnapshotV2Adapter.ts';
import { createHydratedSessionState, createInitialSessionState, sessionReducer } from '../apps/desktop/src/renderer/session/sessionReducer.ts';
import type { NativePlanImplementationRequest, NativeRealtimeEventEnvelope, NativeQueueSnapshot } from '../apps/desktop/src/renderer/session/sessionTypes.ts';
import { orderTranscriptItemsWithQueue } from '../apps/desktop/src/renderer/session/conversationQueuePresentation.ts';
import type { TurnChangeSet } from '../packages/shared/src/conversationResources.ts';
import type { ConversationTranscriptEnvelope } from '../packages/shared/src/conversationTranscriptWire.ts';

const projectId = 'renderer-event-flow-project';
const conversationId = 'renderer-event-flow-conversation';
const threadId = 'renderer-event-flow-thread';
const occurredAt = '2026-08-21T00:00:00.000Z';
const queue = { state: { type: 'idle' as const }, submissions: [] };

/** 为既有渲染探针提供与正式接口一致的持久显示凭证。 */
function transcript(entryId: string, order: number, sourceId = entryId, turnId: string | null = 'turn'): ConversationTranscriptEnvelope {
  return {
    placement: { entryId, order, orderEpoch: 1, placementRevision: order, turnId, openingInputId: 'probe-input', displayStageId: null },
    sources: [{ domain: 'probe', scope: 'segment', sourceId, facet: 'body', revision: order, contentRevision: order }],
  };
}

const snapshotV2 = {
  schemaVersion: 2 as const,
  structureGeneration: '2026-09-16-transcript-placement' as const,
  conversationSchemaGeneration: '2026-08-16-unified-conversation-segments' as const,
  orderEpoch: 1,
  throughEventSeq: 0,
  eventStreamGeneration: 'zeus-conversation-sync-v2',
  conversation: {
    id: conversationId,
    projectId,
    taskId: null,
    title: 'Renderer event flow verifier',
    titleRedacted: false,
    status: 'active',
    stage: 'ready' as const,
    stageUpdatedAt: occurredAt,
    archived: false,
    transportKind: 'codex_native',
    providerState: 'idle',
    providerModel: 'probe-model',
    providerSettings: null,
    nextTurnSettings: null,
    agentKind: 'codex',
    createdAt: occurredAt,
    updatedAt: occurredAt,
  },
  openSegment: {
    id: 'segment',
    runtimeKind: 'codex',
    state: 'ready',
    nativeSessionId: threadId,
    providerModel: 'probe-model',
    openedAt: occurredAt,
    acceptedAt: occurredAt,
    updatedAt: occurredAt,
  },
  activeTurn: null,
  recentClosedTurns: [],
  collections: {
    timeline: { throughSequence: 0 },
    modelHistory: { throughSequence: 0 },
    process: { throughSequence: 0 },
    resources: { available: false },
  },
  limits: { closedTurnLimit: 20, byteLimit: 96 * 1024, returnedTurnCount: 0, responseBytes: 1 },
};

const historyV2 = {
  schemaVersion: 2 as const,
  structureGeneration: '2026-09-16-transcript-placement' as const,
  conversationId,
  kind: 'model_history' as const,
  throughEventSeq: 0,
  throughSequence: 0,
  orderEpoch: 1,
  items: [],
  hasMore: false,
  nextCursor: null,
  limits: { entryLimit: 48, byteLimit: 96 * 1024, returnedItems: 0, responseBytes: 1 },
};

const choice = {
  id: conversationId,
  projectId,
  taskId: null,
  title: 'Renderer event flow verifier',
  summary: null,
  status: 'active',
  stage: 'ready' as const,
  stageUpdatedAt: occurredAt,
  transportKind: 'codex_native',
  providerId: 'codex',
  providerThreadId: threadId,
  providerModel: 'probe-model',
  providerState: 'idle',
  createdAt: occurredAt,
  updatedAt: occurredAt,
  archived: false,
  hasUnreadAttention: false,
  attentionKind: 'none' as const,
  attentionRevision: 0,
  attentionTurnId: null,
  attentionUpdatedAt: null,
  pendingRequestKind: null,
  resumable: true,
  readOnly: false,
  permissionMode: 'read-only' as const,
  collaborationMode: 'default' as const,
};

const goal = {
  goal: null,
  timeline: [],
  capability: { supported: false, enabled: false, stage: null, reason: 'disabled' as const },
};

class VerifierSocket {
  readyState = 1;
  closeCount = 0;
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closeCount += 1;
    for (const listener of this.listeners.get('close') ?? []) listener();
  }
}

type EventPageLoader = SessionControllerClient['loadNativeConversationEvents'];

/** 复用真实会话控制器，外部输入由隔离事件与读取结果提供。 */
function createHarness(
  eventPageLoader?: EventPageLoader,
  snapshotSequence = 0,
  live = true,
  planImplementationRequests: NativePlanImplementationRequest[] = [],
  persistedDraft: string | null = null,
  sendFailure?: Error,
  changeSetLoader?: SessionControllerClient['loadTurnChangeSet'],
) {
  let eventSink: ((event: NativeRealtimeEventEnvelope) => void) | null = null;
  let snapshotReads = 0;
  let sendCalls = 0;
  const sentMessages: Array<Record<string, unknown>> = [];
  let storedDraft = persistedDraft;
  const sockets: VerifierSocket[] = [];
  const requestedAfterSequences: number[] = [];
  const connectedAfterSequences: number[] = [];
  const client = {
    /** 差异读取用于验证终态摘要补齐和用户重试。 */
    loadTurnChangeSet: changeSetLoader,
    /** 模拟服务端一次返回同一事件进度下的结构和消息。 */
    async loadNativeConversationReadableSnapshot() {
      snapshotReads += 1;
      return { snapshot: { ...snapshotV2, throughEventSeq: snapshotSequence }, history: { ...historyV2, throughEventSeq: snapshotSequence } };
    },
    async loadNativeConversationModelHistoryV2() {
      return { ...historyV2, throughEventSeq: snapshotSequence };
    },
    async loadNativeConversationQueueV2() {
      if (planImplementationRequests.some((request) => request.status === 'pending')) {
        return {
          state: { type: 'idle' as const },
          waitReason: 'plan_confirmation' as const,
          submissions: [],
        };
      }
      return live
        ? {
            state: { type: 'active' as const, turnId: 'turn', phase: 'prework' as const },
            submissions: [],
          }
        : queue;
    },
    async loadNativeConversationChoice() {
      return choice;
    },
    async loadNativePendingRequests() {
      return { conversationId, requests: [], planImplementationRequests };
    },
    async loadNativeGoal() {
      return goal;
    },
    async loadNativeConversationEvents(project: string, conversation: string, options: Parameters<EventPageLoader>[2]) {
      requestedAfterSequences.push(options.afterSequence);
      if (eventPageLoader) return eventPageLoader(project, conversation, options);
      return {
        conversationId,
        conversationSchemaGeneration: '2026-08-16-unified-conversation-segments' as const,
        syncStreamGeneration: 'zeus-conversation-sync-v2' as const,
        baseSequence: null,
        throughEventSeq: options.afterSequence,
        nextCursor: options.afterSequence,
        hasMore: false,
        requestedBeforeBaseline: false,
        events: [],
      };
    },
    connectEvents(nextEventSink: (event: NativeRealtimeEventEnvelope) => void, options: { afterSequence: number }) {
      eventSink = nextEventSink;
      connectedAfterSequences.push(options.afterSequence);
      const socket = new VerifierSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    async sendNativeMessage(_project: string, _conversation: string, input: Record<string, unknown>) {
      sendCalls += 1;
      sentMessages.push(input);
      if (sendFailure) throw sendFailure;
      return { operation: { status: 'accepted' }, conversation: { id: conversationId } };
    },
  } as unknown as SessionControllerClient;
  const controller = createSessionController({
    client,
    projectId,
    conversationId,
    storage: {
      getItem: () => storedDraft,
      setItem: (_key, value) => {
        storedDraft = value;
      },
      removeItem: () => {
        storedDraft = null;
      },
    },
    reconnectDelay: async () => undefined,
  });
  return {
    controller,
    client,
    emit(event: NativeRealtimeEventEnvelope) {
      if (!eventSink) throw new Error('Verifier socket is not connected.');
      eventSink(event);
    },
    sockets,
    connectedAfterSequences,
    requestedAfterSequences,
    snapshotReads: () => snapshotReads,
    sendCalls: () => sendCalls,
    sentMessages,
    persistedDraft: () => storedDraft,
  };
}

/** 反复收到有界首屏时，已读正文和分页状态不得被反复清空。 */
function verifyStableHydrationPages() {
  /** 首屏省略更早的已读过程项。 */
  const fresh = adaptConversationSnapshotV2({ snapshot: snapshotV2, history: historyV2, queue, requests: [], planImplementationRequests: [], choice, goal });
  /** 模拟已读取的完整过程正文，与既有接口的条目结构一致。 */
  const item = {
    id: 'loaded-process',
    providerItemId: 'loaded-process',
    turnId: 'turn',
    type: 'commandExecution',
    status: 'completed',
    text: '已读完整正文',
    phase: 'prework',
    payload: { v2ContentKind: 'process_detail' },
    resources: [],
    startedAt: occurredAt,
    updatedAt: occurredAt,
    transcript: transcript('loaded-process', 1),
  };
  /** 已完成页的游标和内容必须一起保存。 */
  const page = { loaded: true, loading: false, nextCursor: null, hasMore: false, error: null };
  /** 只在当前会话内构造缓存，不读取真实用户数据。 */
  const cached = { ...fresh, items: [item], v2Paging: { ...fresh.v2Paging!, historyByTurn: { turn: page }, processByTurn: { turn: page } } };
  /** 通过实际状态归并入口重放多次刷新，而不是只检查工具函数返回值。 */
  let state = sessionReducer(createInitialSessionState(), { type: 'snapshot_hydrated', snapshot: cached });
  const order = state.itemOrder.join(',');
  for (let index = 0; index < 20; index += 1) {
    state = sessionReducer(state, { type: 'snapshot_hydrated', snapshot: fresh });
    assert(state.itemOrder.join(',') === order && state.snapshot?.items[0]?.text === item.text, '补读不能清空或替换已显示正文。');
    assert(state.snapshot?.v2Paging?.processByTurn.turn?.loaded === true && state.snapshot?.v2Paging?.historyByTurn?.turn?.loaded === true, '补读不能清空已完成的分页进度。');
  }
  /** 重连只释放已经失效的请求标记，保留已完成进度。 */
  const resumed = resumeCachedConversationSnapshot({ ...cached, v2Paging: { ...cached.v2Paging, processByTurn: { turn: { ...page, loading: true } } } });
  assert(resumed.v2Paging?.processByTurn.turn?.loading === false && resumed.v2Paging.processByTurn.turn.loaded, '重连不能保留旧请求的忙碌状态。');
  return { refreshes: 20, stableItemIdentity: true, retainedPages: true };
}

/** 用户重试只在核对未送达后重发，重复点击共用一次操作。 */
async function verifyQueuedRetryReconciliation() {
  /** 复用现有真实控制器和快照，单独控制恢复结果。 */
  const harness = createHarness(undefined, 0, false);
  /** 三种结果共享同一提交身份，避免按消息正文猜测。 */
  const submission = { id: 'retry-submission', clientUserMessageId: 'retry-client', content: '重试验收', position: 1, status: 'failed' as const, pausedReason: null };
  /** 初始失败尚未核对，不能直接调用发送。 */
  let recovered: NativeQueueSnapshot = { ...queue, submissions: [submission] };
  /** 记录核对和真实重试次数。 */
  let checks = 0;
  let retries = 0;
  harness.client.recoverNativeQueue = async () => {
    checks += 1;
    return recovered;
  };
  harness.client.retryNativeQueuedSubmission = async () => {
    retries += 1;
    return queue;
  };
  try {
    await Promise.all([harness.controller.retryQueuedSubmission(submission.id), harness.controller.retryQueuedSubmission(submission.id)]);
    assert(checks === 1 && retries === 1, '重复点击必须只核对和重试一次。');
    assert(harness.connectedAfterSequences.length === 1, '空闲会话重试后必须恢复实时连接，接收正文和后续进展。');
    assert(!Object.values(harness.controller.getState().items).some((item) => item.payload.submissionId === submission.id), '替换成功后不得遗留旧失败气泡。');
    recovered = { ...queue, submissions: [{ ...submission, status: 'paused', pausedReason: 'outcome_unknown' }] };
    /** 仍未知必须保留错误，不得调用重试接口。 */
    const unknown = await harness.controller.retryQueuedSubmission(submission.id).then(
      () => null,
      (error: Error) => error,
    );
    assert(unknown?.message.includes('ZEUS_NATIVE_SUBMISSION_OUTCOME_UNKNOWN') === true && retries === 1, '未知结果不得再次发送。');
    recovered = { ...queue, submissions: [{ ...submission, providerTurnId: 'accepted-turn' }] };
    /** 已送达分支仍须独立补齐权威正文。 */
    const readsBeforeAccepted = harness.snapshotReads();
    await harness.controller.retryQueuedSubmission(submission.id);
    assert(retries === 1 && harness.snapshotReads() === readsBeforeAccepted + 1, '已送达必须恢复正文，不能重发。');
    return { checks, retries, acceptedRestored: true, unknownPreserved: true };
  } finally {
    harness.controller.dispose();
  }
}

async function verifyIdleHistoryDoesNotSubscribe() {
  const harness = createHarness(undefined, 0, false);
  await harness.controller.start();
  assert(harness.connectedAfterSequences.length === 0, 'Idle history hydration must not establish a realtime subscription.');
  assert(harness.controller.getState().transportState === 'ready', 'Idle history must remain readable and send-ready without a realtime socket.');
  harness.controller.setDraft('continue');
  await harness.controller.send('queue');
  await waitUntil(() => harness.connectedAfterSequences.length === 1 && harness.sendCalls() === 1, 'idle history lazy send connection');
  harness.controller.dispose();
  return {
    initialConnections: 0,
    sendTriggeredConnections: harness.connectedAfterSequences.length,
    sendCalls: harness.sendCalls(),
    transportState: 'ready',
  };
}

/** 重启与重新读取只恢复待发送状态，不自动再次发送模型请求。 */
async function verifyRestartedPendingSendPreservesIdentity() {
  const originalIdentity = {
    idempotencyKey: 'renderer-restart-idempotency',
    clientUserMessageId: 'renderer-restart-client-message',
  };
  const persisted = JSON.stringify({
    draft: '',
    attachments: [],
    contextDraft: { responseAnnotations: [], codeComments: [] },
    pendingSend: {
      fingerprint: 'renderer-restart-fingerprint',
      content: 'restart recovery marker',
      displayText: 'restart recovery marker',
      draft: 'restart recovery marker',
      attachments: [],
      composerAttachments: [],
      browserSubmission: null,
      contextDraft: { responseAnnotations: [], codeComments: [] },
      delivery: 'queue',
      collaborationMode: 'default',
      ...originalIdentity,
      startedAt: occurredAt,
      autoReplayCount: 0,
      deliveryState: 'failed',
      deliveryError: { message: 'Execution Host restarted before acceptance.', code: 'ZEUS_LOCAL_API_UNAVAILABLE', recoveryRequired: false, retryable: true },
    },
  });
  /** 持续服务不可用时也不能把读取恢复变成自动重发。 */
  const failure = Object.assign(new Error('Execution Host is still unavailable.'), { code: 'ZEUS_LOCAL_API_UNAVAILABLE' });
  for (const deliveryState of ['failed', 'pending', 'uncertain']) {
    /** 同一持久提交在三种重启状态下必须保留身份。 */
    const restored = JSON.parse(persisted);
    restored.pendingSend.deliveryState = deliveryState;
    const harness = createHarness(undefined, 0, true, [], JSON.stringify(restored), failure);
    try {
      await harness.controller.start();
      await harness.controller.reconnect();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert(harness.sendCalls() === 0, '重启和重新读取均不得自动重发待确认消息。');
      /** 读取后保存的本地提交仍可由用户确认后继续处理。 */
      const retained = JSON.parse(harness.persistedDraft() ?? '{}').pendingSend;
      assert(retained?.idempotencyKey === originalIdentity.idempotencyKey && retained?.clientUserMessageId === originalIdentity.clientUserMessageId, '重启必须保留原提交与显示身份。');
      assert(retained.deliveryState !== 'accepted', '未取得服务端证据的提交不得标记为已接纳。');
      assert(
        Object.values(harness.controller.getState().items).some((item) => item.optimistic && item.status === (deliveryState === 'failed' ? 'failed' : 'unconfirmed')),
        '重启后的本地消息必须显示失败或待确认状态。',
      );
      await harness.controller.retryPendingSend(originalIdentity.clientUserMessageId, 'check').catch(() => undefined);
      assert(harness.sendCalls() === 0, '仅核对发送结果不得发送新请求。');
    } finally {
      harness.controller.dispose();
    }
  }
  return { states: 3, automaticReplayCalls: 0, checkOnlySends: 0, identitiesPreserved: true };
}

/** 长任务推送载荷被截断时，历史身份仍须让本地任务卡与 Provider 用户项合并。 */
function verifyTruncatedTaskPushIdentityCoalescing() {
  // 客户端消息身份代表发送前已创建的本地任务卡。
  const clientUserMessageId = 'task-push-client-message';
  // Provider 项身份用于关联历史投影和活动投影。
  const providerItemId = 'task-push-provider-item';
  // 提交身份用于保持持久化发送链路连续。
  const submissionId = 'task-push-submission';
  // 附件模拟推送任务中的粘贴文本，验证水合后仍归属原任务卡。
  const attachment = {
    name: 'Pasted text.txt',
    mime: 'text/plain',
    size: 9_105,
    kind: 'pasted_text' as const,
    localPath: '/tmp/Pasted text.txt',
    taskPushAttachmentKey: 'task-push-attachment',
  };
  // 结构化布局模拟推送任务在本地乐观展示时保存的任务卡信息。
  const taskPushLayout = {
    kind: 'task_push' as const,
    blocks: [
      {
        contextKind: 'current' as const,
        taskId: 'task-push-task',
        taskCode: 'ZEUS-0451',
        taskTitle: '推送子任务提示词重复显示',
        taskType: 'defect' as const,
        taskTypeLabel: '缺陷',
        fields: [{ field: 'defectCurrentState' as const, label: '现状', text: '同一提示词显示两次', attachmentKeys: ['task-push-attachment'] }],
        attachments: [{ key: 'task-push-attachment', field: 'defectCurrentState' as const, name: attachment.name, kind: 'pasted_text' as const, mimeType: attachment.mime, size: attachment.size }],
        conversationPaths: [],
      },
    ],
    supplementalInfo: '',
    supplementalAttachments: [],
  };
  // 历史用户项携带完整稳定身份，代表已经持久化的首发消息。
  const openingUserMessage = {
    id: 'task-push-history',
    sequence: 1,
    turnId: 'task-push-turn',
    submissionId,
    clientUserMessageId,
    providerItemId,
    reasoningSummary: false,
    phase: null,
    segmentId: 'segment',
    role: 'user',
    toolPairId: null,
    confirmedAt: occurredAt,
    content: {
      preview: '{"text":"同一提示词"}',
      byteLength: 27,
      truncated: false,
      redacted: false,
      contentHandle: null,
      refreshRequired: false,
    },
    toolResult: null,
    transcript: transcript('task-push-history', 1, providerItemId, 'task-push-turn'),
  };
  // 活动用户项故意提供无法解析的截断载荷，复现现场身份丢失条件。
  const activeSnapshot = {
    ...snapshotV2,
    activeTurn: {
      id: 'task-push-turn',
      providerTurnId: 'task-push-provider-turn',
      submissionId,
      status: 'running',
      hasError: false,
      hasPlan: false,
      plan: null,
      startedAt: occurredAt,
      completedAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      agentKind: 'codex',
      openingUserMessage,
      completionOutput: null,
      activeItems: [
        {
          id: 'task-push-active',
          order: 0,
          turnId: 'task-push-turn',
          providerItemId,
          itemType: 'userMessage',
          status: 'completed' as const,
          phase: 'prework' as const,
          text: { preview: '同一提示词', byteLength: 15, truncated: false, redacted: false, contentHandle: null, refreshRequired: true },
          payload: {
            preview: `{"clientId":"${clientUserMessageId}","taskPushLayout":`,
            byteLength: 2_348,
            truncated: true,
            redacted: false,
            contentHandle: null,
            refreshRequired: true,
          },
          startedAt: occurredAt,
          completedAt: occurredAt,
          updatedAt: occurredAt,
          transcript: transcript('task-push-history', 1, providerItemId, 'task-push-turn'),
        },
      ],
      activeItemsTruncated: false,
      process: { available: false, latestSequence: 0 },
      resourcesAvailable: true,
      changeSetAvailable: false,
    },
    collections: { ...snapshotV2.collections, modelHistory: { throughSequence: 1 }, resources: { available: true } },
    limits: { ...snapshotV2.limits, returnedTurnCount: 1 },
  };
  // 历史页只返回与活动项同一 Provider 身份的用户消息。
  const history = { ...historyV2, throughSequence: 1, items: [openingUserMessage], limits: { ...historyV2.limits, returnedItems: 1 } };
  // 首屏适配结果应从历史项继承身份，同时保留活动项最新投影。
  const adapted = adaptConversationSnapshotV2({ snapshot: activeSnapshot, history, queue, requests: [], planImplementationRequests: [], choice, goal });
  assert(adapted.items.length === 1 && adapted.items[0]?.payload.clientId === clientUserMessageId, 'A truncated active task-push item must retain the stable client identity from model history.');
  assert(adapted.items[0]?.payload.clientUserMessageId === clientUserMessageId, 'A truncated active task-push item must retain the durable client user message identity from model history.');
  assert(adapted.items[0]?.payload.submissionId === submissionId, 'A truncated active task-push item must retain the stable submission identity from model history.');

  let state = createInitialSessionState();
  state = { ...state, projectId, conversationId, providerThreadId: threadId, conversationState: 'active_prework' };
  state = sessionReducer(state, {
    type: 'send_started',
    clientUserMessageId,
    durableClientUserMessageId: clientUserMessageId,
    draft: '同一提示词',
    attachments: [attachment],
    submittedAttachments: [attachment],
    browserSubmission: null,
    contextDraft: { responseAnnotations: [], codeComments: [] },
    browserComments: [],
    delivery: 'queue',
    previousConversationState: 'active_prework',
    startedAt: occurredAt,
    taskPushLayout,
  });
  state = sessionReducer(state, { type: 'snapshot_hydrated', snapshot: adapted });
  // 水合后的用户项数量直接验证原任务卡没有再生成第二张 Provider 卡。
  const userItems = state.itemOrder.map((key) => state.items[key]).filter((item) => item?.type === 'userMessage');
  assert(userItems.length === 1, 'The optimistic task card and matching Provider projection must hydrate as one user item.');
  assert(
    userItems[0]?.payload.taskPushLayout === taskPushLayout && Array.isArray(userItems[0]?.payload.attachments) && userItems[0].payload.attachments.length === 1,
    'The single hydrated user item must retain its task layout and attachment.',
  );

  // 第二条历史消息仅复用正文，所有稳定身份均不同，必须作为真实重复发送保留。
  const repeatedHistory = {
    ...history,
    throughSequence: 2,
    items: [
      openingUserMessage,
      {
        ...openingUserMessage,
        id: 'deliberate-repeat-history',
        sequence: 2,
        submissionId: 'deliberate-repeat-submission',
        clientUserMessageId: 'deliberate-repeat-client',
        providerItemId: 'deliberate-repeat-provider',
        transcript: transcript('deliberate-repeat-history', 2, 'deliberate-repeat-provider', 'task-push-turn'),
      },
    ],
    limits: { ...history.limits, returnedItems: 2 },
  };
  // 再次适配用于确认实现没有引入按正文相等去重。
  const repeated = adaptConversationSnapshotV2({
    snapshot: { ...activeSnapshot, collections: { ...activeSnapshot.collections, modelHistory: { throughSequence: 2 } } },
    history: repeatedHistory,
    queue,
    requests: [],
    planImplementationRequests: [],
    choice,
    goal,
  });
  assert(repeated.items.filter((item) => item.type === 'userMessage').length === 2, 'Identical text with distinct durable identities must remain two user messages.');
  return { mergedUserItems: userItems.length, taskLayoutPreserved: true, attachmentCount: 1, deliberateRepeats: 2 };
}

/** 任务首发、连续引导与下一条排队消息在冷开和热恢复后保持同一顺序。 */
function verifyRestoredSubmissionOrder() {
  /** 固定时间让更新队列状态不能伪装成新消息。 */
  const at = (second: number) => new Date(Date.parse(occurredAt) + second * 1000).toISOString();
  /** 复用正式快照适配器构造完整会话，消息身份刻意等待原生回显。 */
  const base = adaptConversationSnapshotV2({ snapshot: snapshotV2, history: historyV2, queue, requests: [], planImplementationRequests: [], choice, goal });
  /** 持久的任务首发已经被模型接手；后续两次引导也已经进入同轮。 */
  const submissions = ['任务推送提示词', '第一次引导', '第二次引导', '待发消息'].map((content, index) => ({
    id: `order-submission-${index}`,
    clientUserMessageId: `order-client-${index}`,
    content,
    status: index === 0 ? 'active' : index === 3 ? 'queued' : 'resolved',
    delivery: index === 0 || index === 3 ? ('queue' as const) : ('steer_now' as const),
    position: index + 1,
    pausedReason: null,
    providerTurnId: index === 3 ? null : 'order-turn',
    createdAt: at(index * 2),
    updatedAt: at(20),
  }));
  /** 正文穿插两次引导，测试不能把首发或引导挪到正文、队尾之后。 */
  const replies = [1, 3, 5].map((second) => ({
    id: `reply-${second}`,
    turnId: 'order-turn',
    providerItemId: `reply-${second}`,
    type: 'agentMessage',
    phase: 'commentary',
    status: 'completed',
    text: `回复 ${second}`,
    payload: {},
    resources: [],
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
    transcript: transcript(`reply-${second}`, second + 1, `reply-${second}`, 'order-turn'),
  }));
  /** 接纳事务已经写入用户历史，但 Provider 仍可尚未给出自己的消息身份。 */
  const acceptedInputs = submissions.slice(0, 3).map((submission, index) => ({
    id: `accepted-input-${index}`,
    turnId: 'order-turn',
    type: 'userMessage',
    phase: 'prework',
    status: submission.status,
    text: submission.content,
    payload: { submissionId: submission.id, clientId: submission.clientUserMessageId, clientUserMessageId: submission.clientUserMessageId, delivery: submission.delivery },
    resources: [],
    startedAt: submission.createdAt,
    completedAt: submission.updatedAt,
    updatedAt: submission.updatedAt,
    transcript: transcript(`accepted-input-${index}`, index * 2 + 1, submission.id, 'order-turn'),
  }));
  /** 每次切回都从同一权威提交重建，不能依赖上一屏的临时条目。 */
  const snapshot = { ...base, items: [...replies, ...acceptedInputs], submissions, queue: { ...queue, submissions } };
  /** 回复先到、提交后到时，HTTP 补读和实时队列事件都必须立刻恢复相同顺序。 */
  for (const firstStatus of ['active', 'completed', 'resolved']) {
    /** 活动和已结束的首发均属于已接纳历史，待发消息仍留在最后。 */
    const lateQueue = { ...snapshot.queue, submissions: submissions.map((submission, index) => (index === 0 ? { ...submission, status: firstStatus } : submission)) };
    /** 不先加载提交，复现历史正文已显示而队列信息稍后到达的真实边界。 */
    const repliesOnly = createHydratedSessionState({ ...base, items: replies, submissions: [], queue });
    /** 独立的引导接纳入口也必须复用相同插入规则。 */
    const steered = sessionReducer(repliesOnly, { type: 'steering_submission_hydrated', submission: submissions[1]! });
    assert(
      orderTranscriptItemsWithQueue(
        steered.itemOrder.map((key) => steered.items[key]!),
        steered.queue,
      )
        .map((item) => item.text)
        .join('|') === '回复 1|第一次引导|回复 3|回复 5',
      '迟到的引导接纳必须插回对应回复之前。',
    );
    for (const action of [
      { type: 'queue_hydrated' as const, queue: lateQueue },
      { type: 'event_received' as const, event: conversationEvent(1, 'conversation.queue.changed', { queue: lateQueue }) },
    ]) {
      /** 不允许依赖切换会话或完整快照的重新排序。 */
      const live = sessionReducer(repliesOnly, action);
      const ordered = orderTranscriptItemsWithQueue(
        live.itemOrder.map((key) => live.items[key]!),
        live.queue,
      );
      assert(ordered.map((item) => item.text).join('|') === '任务推送提示词|回复 1|第一次引导|回复 3|第二次引导|回复 5|待发消息', '实时补回的首发和引导必须立即归位，不能等待切换会话。');
      /** 内容增量更新不能用更新时间把回复挪到后续输入之后。 */
      const updated = ordered.map((item) => (item.text === '回复 1' ? { ...item, updatedAt: at(30) } : item));
      assert(
        orderTranscriptItemsWithQueue(updated, live.queue)
          .map((item) => item.key)
          .join('|') === ordered.map((item) => item.key).join('|'),
        '正文更新不能改变首次发言顺序。',
      );
    }
  }
  /** 冷恢复和带缓存的恢复都经过真实状态归并。 */
  let state = createHydratedSessionState(snapshot);
  for (let pass = 0; pass < 3; pass += 1) {
    state = sessionReducer(state, { type: 'snapshot_hydrated', snapshot });
    /** 再收到队列快照时，同一条首发也不能被重新推入待发区域。 */
    state = sessionReducer(state, { type: 'queue_hydrated', queue: snapshot.queue });
    /** 已接纳的普通发送与引导统一保持原始发言位置。 */
    const ordered = orderTranscriptItemsWithQueue(
      state.itemOrder.map((key) => state.items[key]!),
      state.queue,
    );
    assert(ordered.map((item) => item.text).join('|') === '任务推送提示词|回复 1|第一次引导|回复 3|第二次引导|回复 5|待发消息', '切回会话后，任务首发和多次引导必须留在对应回复之前。');
    for (const status of ['completed', 'resolved']) {
      /** 终态已确认但原生身份仍未补齐的分页合并结果也不能进入队尾。 */
      const terminal = ordered.map((item) => (item.clientUserMessageId === submissions[0]!.clientUserMessageId ? { ...item, status } : item));
      assert(orderTranscriptItemsWithQueue(terminal, state.queue)[0]?.text === '任务推送提示词', '终态消息不能因保留乐观标记被误当成待发送消息。');
    }
  }
  return { coldAndWarmRestoration: true, lateHttpAndRealtimeSubmissions: true, stableDeltaOrder: true, steeringMessages: 2, queuedMessages: 1, acceptedWithoutNativeEcho: true };
}

function verifyInternalPayloadsStayOutOfTranscript() {
  const history = {
    ...historyV2,
    throughSequence: 2,
    items: [
      {
        id: 'tool-call-history',
        sequence: 1,
        turnId: 'turn',
        submissionId: null,
        clientUserMessageId: null,
        providerItemId: null,
        reasoningSummary: false,
        phase: null,
        segmentId: 'segment',
        role: 'assistant',
        toolPairId: null,
        confirmedAt: occurredAt,
        content: {
          preview: '{"type":"tool_call","itemType":"commandExecution","payload":{"command":"pwd"',
          byteLength: 4_096,
          truncated: true,
          redacted: false,
          contentHandle: 'tool-call-handle',
          refreshRequired: false,
        },
        toolResult: null,
        transcript: transcript('tool-call-history', 1),
      },
      {
        id: 'reasoning-history',
        sequence: 2,
        turnId: 'turn',
        submissionId: null,
        clientUserMessageId: null,
        providerItemId: 'reasoning-history-provider-item',
        reasoningSummary: true,
        phase: null,
        segmentId: 'segment',
        role: 'assistant',
        toolPairId: null,
        confirmedAt: occurredAt,
        content: {
          preview: '**等待命令完成**',
          byteLength: 24,
          truncated: false,
          redacted: false,
          contentHandle: null,
          refreshRequired: false,
        },
        toolResult: null,
        transcript: transcript('reasoning-history', 2, 'reasoning-history-provider-item'),
      },
      {
        id: 'assistant-history',
        sequence: 3,
        turnId: 'turn',
        submissionId: null,
        clientUserMessageId: null,
        providerItemId: 'assistant-history-provider-item',
        reasoningSummary: false,
        phase: 'final_answer',
        segmentId: 'segment',
        role: 'assistant',
        toolPairId: null,
        confirmedAt: occurredAt,
        content: {
          preview: '最终回答',
          byteLength: 12,
          truncated: false,
          redacted: false,
          contentHandle: null,
          refreshRequired: false,
        },
        toolResult: null,
        transcript: transcript('assistant-history', 3, 'assistant-history-provider-item'),
      },
    ],
    limits: { ...historyV2.limits, returnedItems: 3 },
  };
  const adapted = adaptConversationSnapshotV2({
    snapshot: {
      ...snapshotV2,
      collections: { ...snapshotV2.collections, modelHistory: { throughSequence: 3 } },
    },
    history,
    queue,
    requests: [],
    planImplementationRequests: [],
    choice,
    goal,
  });
  assert(adapted.items.length === 2 && adapted.items[0]?.type === 'reasoning' && adapted.items[0]?.phase === 'prework', 'Snapshot V2 reasoning identity must survive a plain-text history projection.');
  assert(adapted.items[1]?.text === '最终回答' && adapted.items[1]?.type === 'agentMessage', 'Internal tool_call projections must never become visible assistant transcript rows.');
  const merged = mergeConversationProcessV2(adapted, 'turn', {
    schemaVersion: 2,
    structureGeneration: '2026-09-16-transcript-placement',
    conversationId,
    kind: 'process',
    throughEventSeq: 0,
    throughSequence: 1,
    orderEpoch: 1,
    items: [
      {
        id: 'command-process',
        sequence: 1,
        turnId: 'turn',
        segmentId: 'segment',
        providerItemId: 'command-process',
        kind: 'command',
        status: 'completed',
        title: '执行命令',
        sourceEventId: 'codex:item:command-process',
        startedAt: occurredAt,
        completedAt: occurredAt,
        detail: {
          preview: '{"provider":"codex","itemType":"commandExecution","payload":{"command":"pwd","aggregatedOutput":"internal"',
          byteLength: 4_096,
          truncated: true,
          redacted: false,
          contentHandle: 'process-detail-handle',
          refreshRequired: false,
        },
        toolResult: null,
        transcript: transcript('command-process', 4),
      },
    ],
    hasMore: false,
    nextCursor: null,
    limits: { entryLimit: 64, byteLimit: 128 * 1024, returnedItems: 1, responseBytes: 512 },
  });
  const command = Object.values(merged.items).find((item) => item.id === 'command-process');
  assert(command?.text === 'pwd', 'Truncated process JSON must project a readable command instead of the internal JSON wrapper.');
  assert(command.payload.command === 'pwd' && !Object.prototype.hasOwnProperty.call(command.payload, 'detail'), 'Process items must expose presentation fields without retaining the internal detail wrapper.');
  return {
    visibleHistoryItems: adapted.items.map((item) => item.id),
    reasoningHistoryType: adapted.items[0]?.type,
    commandText: command.text,
    internalDetailExposed: false,
  };
}

function verifyProcessPageDoesNotDowngradeLiveTerminalState() {
  const providerTurnId = 'provider-terminal-turn';
  const localTurnId = 'local-terminal-turn';
  const activeSnapshot = {
    ...snapshotV2,
    activeTurn: {
      id: localTurnId,
      providerTurnId,
      submissionId: null,
      status: 'running',
      hasError: false,
      hasPlan: false,
      plan: null,
      startedAt: occurredAt,
      completedAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      agentKind: 'codex',
      process: { available: true, latestSequence: 1 },
      resourcesAvailable: false,
      changeSetAvailable: false,
    },
    limits: { ...snapshotV2.limits, returnedTurnCount: 1 },
  };
  const adapted = adaptConversationSnapshotV2({
    snapshot: activeSnapshot,
    history: historyV2,
    queue,
    requests: [],
    planImplementationRequests: [],
    choice,
    goal,
  });
  let state = createHydratedSessionState(adapted);
  state = sessionReducer(state, {
    type: 'event_received',
    event: conversationEvent(1, 'conversation.item.completed', {
      turnId: providerTurnId,
      itemId: 'command-process',
      itemType: 'commandExecution',
      itemPayload: { command: 'pwd' },
      status: 'completed',
      textContent: 'pwd',
    }),
  });
  state = sessionReducer(state, {
    type: 'event_received',
    event: conversationEvent(2, 'conversation.item.completed', {
      turnId: providerTurnId,
      itemId: 'final-answer',
      itemType: 'agentMessage',
      itemPayload: {},
      phase: 'final_answer',
      status: 'completed',
      textContent: 'FINAL-OK',
    }),
  });
  state = sessionReducer(state, {
    type: 'event_received',
    event: conversationEvent(3, 'conversation.turn.completed', {
      turnId: providerTurnId,
      status: 'completed',
      completedAt: '2026-08-21T00:00:03.000Z',
    }),
  });

  const staleProcessPage = mergeConversationProcessV2(adapted, providerTurnId, {
    schemaVersion: 2,
    structureGeneration: '2026-09-16-transcript-placement',
    conversationId,
    kind: 'process',
    throughEventSeq: 0,
    throughSequence: 1,
    orderEpoch: 1,
    items: [
      {
        id: 'durable-command-process',
        sequence: 1,
        turnId: localTurnId,
        segmentId: 'segment',
        providerItemId: 'command-process',
        kind: 'command',
        status: 'completed',
        title: '执行命令',
        sourceEventId: 'codex:item:command-process',
        startedAt: occurredAt,
        completedAt: '2026-08-21T00:00:01.000Z',
        detail: {
          preview: '{"provider":"codex","itemType":"commandExecution","payload":{"command":"pwd"}}',
          byteLength: 84,
          truncated: false,
          redacted: false,
          contentHandle: null,
          refreshRequired: false,
        },
        toolResult: null,
        transcript: transcript('command-process', 1, 'command-process', localTurnId),
      },
    ],
    hasMore: false,
    nextCursor: null,
    limits: { entryLimit: 32, byteLimit: 96 * 1024, returnedItems: 1, responseBytes: 256 },
  });
  state = sessionReducer(state, { type: 'snapshot_v2_page_merged', snapshot: staleProcessPage });
  const commandItems = Object.values(state.items).filter((item) => item.providerItemId === 'command-process');
  assert(state.activeTurnId === null && state.conversationState === 'native_idle', 'A stale process page must not downgrade a completed realtime turn to active.');
  assert(state.turnsByProviderId[providerTurnId]?.status === 'completed', 'A stale process page must preserve the stronger realtime terminal turn.');
  assert(commandItems.length === 1, 'The durable process row and realtime Provider item must merge by provider item identity.');
  assert(
    Object.values(state.items).some((item) => item.providerItemId === 'final-answer' && item.text === 'FINAL-OK'),
    'A process page must not erase a realtime final answer.',
  );
  return {
    commandItems: commandItems.length,
    finalAnswerPreserved: true,
    conversationState: state.conversationState,
    turnStatus: state.turnsByProviderId[providerTurnId]?.status,
  };
}

function verifyQueuedSubmissionCanChangeNativeThread() {
  const submissionId = 'cross-runtime-submission';
  const nextThreadId = 'cross-runtime-thread';
  const nextTurnId = 'cross-runtime-turn';
  const adapted = adaptConversationSnapshotV2({
    snapshot: snapshotV2,
    history: historyV2,
    queue: {
      state: { type: 'idle' as const },
      submissions: [],
    },
    requests: [],
    planImplementationRequests: [],
    choice,
    goal,
  });
  let state = createHydratedSessionState(adapted);
  const previousThreadId = state.providerThreadId;
  state = sessionReducer(state, {
    type: 'event_received',
    event: conversationEvent(1, 'conversation.queue.changed', {
      threadId: nextThreadId,
      providerThreadId: nextThreadId,
      turnId: nextTurnId,
      submissionId,
      queue: { state: { type: 'active', turnId: nextTurnId, phase: 'prework' }, submissions: [], waitReason: 'current_turn' },
    }),
  });
  assert(state.providerThreadId === previousThreadId, 'An incomplete cross-thread queue fact must not replace the selected Provider identity.');
  state = sessionReducer(state, {
    type: 'event_received',
    event: conversationEvent(2, 'conversation.queue.changed', {
      threadId: nextThreadId,
      providerThreadId: nextThreadId,
      turnId: nextTurnId,
      providerTurnId: nextTurnId,
      submissionId,
      queue: { state: { type: 'active', turnId: nextTurnId, phase: 'prework' }, submissions: [], waitReason: 'current_turn' },
    }),
  });
  assert(state.providerThreadId === nextThreadId, 'A new thread may replace the old identity when queue.changed names a known queued submission.');
  assert(state.activeTurnId === nextTurnId && state.conversationState === 'active_prework', 'The accepted cross-runtime queue head must become active immediately.');
  return { providerThreadId: state.providerThreadId, activeTurnId: state.activeTurnId };
}

function verifySnapshotV2SettingsAndPlanRestoration() {
  const plan = {
    explanation: '保留已完成的开发计划',
    steps: [
      { step: '读取历史快照', status: 'completed' as const },
      { step: '继续实施', status: 'inProgress' as const },
    ],
  };
  const adapted = adaptConversationSnapshotV2({
    snapshot: {
      ...snapshotV2,
      conversation: {
        ...snapshotV2.conversation,
        providerSettings: {
          generationId: 'generation-xhigh',
          sequence: 7,
          model: 'probe-model',
          effort: 'xhigh',
          serviceTier: 'priority',
        },
        nextTurnSettings: {
          model: 'probe-model',
          effort: 'xhigh',
          serviceTier: 'priority',
          permissionMode: 'full-access',
          collaborationMode: 'plan',
        },
      },
      recentClosedTurns: [
        {
          id: 'plan-turn',
          providerTurnId: 'provider-plan-turn',
          submissionId: null,
          status: 'completed',
          hasError: false,
          hasPlan: true,
          plan,
          startedAt: occurredAt,
          completedAt: occurredAt,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          agentKind: 'codex',
          process: { available: false, latestSequence: 0 },
          resourcesAvailable: false,
          changeSetAvailable: false,
        },
      ],
      limits: { ...snapshotV2.limits, returnedTurnCount: 1 },
    },
    history: historyV2,
    queue,
    requests: [],
    planImplementationRequests: [],
    choice,
    goal,
  });
  assert(adapted.providerSettings?.effort === 'xhigh', 'Snapshot V2 must restore the authoritative provider effort.');
  assert(adapted.nextTurnSettings?.effort === 'xhigh' && adapted.nextTurnSettings.collaborationMode === 'plan', 'Snapshot V2 must restore the next-turn PLAN settings without falling back to low/default.');
  assert(adapted.turns[0]?.plan?.steps[1]?.status === 'inProgress', 'Snapshot V2 must restore the persisted development plan after the active turn closes.');
  return {
    providerEffort: adapted.providerSettings.effort,
    nextTurnEffort: adapted.nextTurnSettings.effort,
    collaborationMode: adapted.nextTurnSettings.collaborationMode,
    restoredPlanSteps: adapted.turns[0]?.plan?.steps.length ?? 0,
  };
}

async function verifyPendingPlanConfirmationRestoration() {
  const request: NativePlanImplementationRequest = {
    id: 'plan-request',
    conversationId,
    turnId: 'plan-turn',
    planItemId: 'plan-item',
    status: 'pending',
    submissionId: null,
    createdAt: occurredAt,
    resolvedAt: null,
    updatedAt: occurredAt,
  };
  const harness = createHarness(undefined, 0, false, [request]);
  await harness.controller.start();
  const state = harness.controller.getState();
  assert(state.planImplementationRequests.length === 1 && state.planImplementationRequests[0]?.id === request.id, 'Snapshot V2 hydration must restore the pending plan confirmation card.');
  assert(harness.connectedAfterSequences.length === 1, 'A pending plan confirmation must keep realtime synchronization active.');
  harness.controller.dispose();
  return {
    restoredRequestId: request.id,
    waitReason: state.queue?.waitReason,
    realtimeConnections: harness.connectedAfterSequences.length,
  };
}

async function verifyActiveSnapshotWatermarkSubscription() {
  const snapshotSequence = 483;
  const harness = createHarness(undefined, snapshotSequence);
  await harness.controller.start();
  assert(harness.connectedAfterSequences.length === 1 && harness.connectedAfterSequences[0] === snapshotSequence, 'Active hydration must subscribe after the authoritative snapshot watermark.');
  harness.controller.dispose();
  return { snapshotSequence, connectedAfterSequences: harness.connectedAfterSequences };
}

async function verifyIdleTransitionReleasesSubscription() {
  const harness = createHarness();
  await harness.controller.start();
  harness.emit(conversationEvent(1, 'conversation.queue.changed', { queue }));
  await waitUntil(() => harness.sockets[0]?.closeCount === 1, 'idle transition realtime release');
  assert(harness.controller.getState().transportState === 'ready', 'Releasing an idle subscription must not mark the readable history disconnected.');
  assert(harness.connectedAfterSequences.length === 1, 'Intentional idle release must not schedule a reconnect loop.');
  harness.controller.dispose();
  return { socketClosed: 1, connections: harness.connectedAfterSequences.length, transportState: 'ready' };
}

function conversationEvent(sequence: number, type: string, fields: Record<string, unknown> = {}): NativeRealtimeEventEnvelope {
  return {
    id: `event-${sequence}`,
    type,
    createdAt: occurredAt,
    payload: {
      projectId,
      conversationId,
      threadId,
      generationId: 'generation',
      conversationSchemaGeneration: '2026-08-16-unified-conversation-segments',
      syncStreamGeneration: 'zeus-conversation-sync-v2',
      entityRevision: sequence,
      sequence,
      ...fields,
    },
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Renderer event-flow verifier timed out: ${label}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function verifyRenderDeltaOverflow() {
  const harness = createHarness();
  await harness.controller.start();
  for (let sequence = 1; sequence <= sessionRealtimeBufferBudget.maxEntries + 1; sequence += 1) {
    harness.emit(
      conversationEvent(sequence, 'conversation.item.delta', {
        turnId: 'turn',
        itemId: `item-${sequence}`,
        itemType: 'agentMessage',
        itemPayload: {},
        textContent: 'x',
      }),
    );
  }
  const overflow = harness.controller.getDiagnostics();
  assert(overflow.syncProjectionSuspended, 'Render-delta overflow must suspend incremental projection.');
  assert(harness.sockets[0]?.closeCount === 1, 'Render-delta overflow must close the active socket exactly once.');
  assert(overflow.pendingRenderDeltaEntries === 0 && overflow.pendingRenderDeltaBytes === 0, 'Render-delta overflow must clear unprojected local deltas.');
  assert(overflow.realtimeBufferWatermarks['render-delta']?.entries === sessionRealtimeBufferBudget.maxEntries, 'Render-delta high watermark must reach the hard entry budget.');
  await waitUntil(() => harness.snapshotReads() >= 2 && harness.controller.getState().transportState === 'ready', 'render-delta Snapshot V2 recovery');
  const recovered = harness.controller.getDiagnostics();
  assert(!recovered.syncProjectionSuspended, 'Snapshot V2 recovery must reopen incremental projection.');
  assert(harness.sockets.length === 2, 'Snapshot V2 recovery must establish a fresh socket.');
  harness.controller.dispose();
  return {
    suspendedOnOverflow: overflow.syncProjectionSuspended,
    socketClosed: 1,
    watermarkEntries: overflow.realtimeBufferWatermarks['render-delta']?.entries ?? 0,
    snapshotReads: harness.snapshotReads(),
    recoveredTransport: 'ready',
  };
}

async function verifyGapByteOverflow() {
  const harness = createHarness();
  await harness.controller.start();
  harness.emit(
    conversationEvent(2, 'conversation.settings.changed', {
      model: 'x'.repeat(Math.ceil(sessionRealtimeBufferBudget.maxBytes / 3) + 100),
      effort: 'high',
    }),
  );
  const overflow = harness.controller.getDiagnostics();
  assert(overflow.syncProjectionSuspended, 'Sync-gap byte overflow must suspend incremental projection.');
  assert(harness.sockets[0]?.closeCount === 1, 'Sync-gap byte overflow must close the active socket exactly once.');
  assert(overflow.pendingSyncGapEntries === 0 && overflow.pendingSyncGapBytes === 0, 'Sync-gap overflow must clear unprojected local events.');
  await waitUntil(() => harness.snapshotReads() >= 2 && harness.controller.getState().transportState === 'ready', 'sync-gap Snapshot V2 recovery');
  assert(!harness.controller.getDiagnostics().syncProjectionSuspended, 'Snapshot V2 recovery must resume after sync-gap overflow.');
  harness.controller.dispose();
  return { suspendedOnOverflow: true, socketClosed: 1, snapshotReads: harness.snapshotReads(), recoveredTransport: 'ready' };
}

async function verifyContiguousGapReplay() {
  const missingEvents = [conversationEvent(1, 'conversation.settings.changed', { model: 'model-1' }), conversationEvent(2, 'conversation.settings.changed', { model: 'model-2' })];
  const harness = createHarness(async (_project, _conversation, options) => ({
    conversationId,
    conversationSchemaGeneration: '2026-08-16-unified-conversation-segments',
    syncStreamGeneration: 'zeus-conversation-sync-v2',
    baseSequence: 1,
    throughEventSeq: 2,
    nextCursor: 2,
    hasMore: false,
    requestedBeforeBaseline: false,
    events: options.afterSequence === 0 ? missingEvents : [],
  }));
  await harness.controller.start();
  harness.emit(conversationEvent(3, 'conversation.settings.changed', { model: 'model-3' }));
  await waitUntil(() => harness.controller.getDiagnostics().lastAppliedSyncEventSequence === 3, 'contiguous gap replay');
  const diagnostics = harness.controller.getDiagnostics();
  assert(harness.requestedAfterSequences.length === 1 && harness.requestedAfterSequences[0] === 0, 'Gap fetch must start at the last applied sequence.');
  assert(diagnostics.pendingSyncGapEntries === 0, 'Buffered sequence 3 must apply only after sequences 1 and 2.');
  assert(harness.controller.getState().providerSettings?.model === 'model-3', 'The buffered event must become the final projection after the gap closes.');
  harness.controller.dispose();
  return {
    requestedAfterSequences: harness.requestedAfterSequences,
    lastAppliedSequence: diagnostics.lastAppliedSyncEventSequence,
    pendingGapEntries: diagnostics.pendingSyncGapEntries,
    finalModel: 'model-3',
  };
}

/** 重放实际故障链：摘要事件先消费，全文稍后到达，资源旧页随后返回。 */
async function verifyTurnChangeReviewHydration() {
  // 不可撤销的变更仍有权威差异正文可供审阅。
  const full: TurnChangeSet = {
    id: 'review-change-set',
    projectId,
    conversationId,
    turnId: 'review-local-turn',
    providerTurnId: 'review-turn',
    state: 'unavailable',
    contentProjection: 'full',
    files: [
      {
        id: 'review-file',
        oldPath: 'example.ts',
        newPath: 'example.ts',
        changeType: 'modified',
        addedLines: 1,
        deletedLines: 1,
        unifiedDiff: '@@ -1 +1 @@\n-before\n+after\n',
        preHash: null,
        postHash: null,
        reversible: false,
        unavailableReason: '快照缺失',
      },
    ],
    unifiedDiff: '',
    fileCount: 1,
    addedLines: 1,
    deletedLines: 1,
    preImageDigest: null,
    postImageDigest: null,
    unavailableReason: '快照缺失',
    conflict: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  // 实时通知只有摘要，不重复传输正文。
  const summary: TurnChangeSet = { ...full, contentProjection: 'summary', files: full.files.map((file) => ({ ...file, unifiedDiff: '' })) };
  for (const failFirstRead of [false, true]) {
    // 计数确认正常终态读取一次，失败后明确重试一次。
    let reads = 0;
    // 使用同一控制器覆盖自动水合与审阅入口的读取路径。
    const harness = createHarness(undefined, 0, true, [], null, undefined, async () => {
      reads += 1;
      if (failFirstRead && reads === 1) throw new Error('隔离的读取失败');
      return full;
    });
    try {
      await harness.controller.start();
      // 保留早于实时摘要的资源页基准，复现异步覆盖顺序。
      const staleSnapshot = harness.controller.getState().snapshot!;
      harness.emit(conversationEvent(1, 'conversation.turn.change_set.changed', { turnId: full.providerTurnId, changeSetId: full.id, changeSet: summary }));
      await waitUntil(() => reads === 1, '变更集自动读取');
      if (failFirstRead) await harness.controller.loadTurnArtifacts(full.providerTurnId);
      await waitUntil(() => harness.controller.getState().changeSetsByProviderId[full.providerTurnId]?.contentProjection === 'full', '差异全文合入');
      // 分页和重复摘要不能清空正文，按需读取也不能推进实时序号。
      let state = sessionReducer(harness.controller.getState(), { type: 'snapshot_v2_page_merged', snapshot: staleSnapshot });
      state = sessionReducer(state, { type: 'event_received', event: conversationEvent(2, 'conversation.turn.change_set.changed', { changeSet: summary }) });
      assert(state.changeSetsByProviderId[full.providerTurnId]?.files[0]?.unifiedDiff === full.files[0]!.unifiedDiff, '旧资源页和同修订摘要不得清空已加载正文。');
      assert(state.snapshot?.changeSets?.[0]?.contentProjection === 'full', '完整差异必须同时保存到快照。');
      assert(harness.controller.getDiagnostics().lastAppliedSyncEventSequence === 1, '差异读取不得制造实时事件序号。');
      // 新修订先到时，旧全文迟到也不能把撤销状态改回去。
      const newer = { ...summary, state: 'undone' as const, updatedAt: '2026-08-21T00:00:01.000Z' };
      state = sessionReducer(state, { type: 'event_received', event: conversationEvent(3, 'conversation.turn.change_set.changed', { changeSet: newer }) });
      state = sessionReducer(state, { type: 'turn_change_set_loaded', changeSet: full });
      assert(state.changeSetsByProviderId[full.providerTurnId]?.state === 'undone', '旧全文不得覆盖新修订。');
      assert(reads === (failFirstRead ? 2 : 1), '正常加载和失败重试的读取次数必须有界。');
    } finally {
      harness.controller.dispose();
    }
  }
  return { automaticHydration: true, reviewRetry: true, summaryAndPagePreservation: true, staleRevisionRejected: true };
}

/** 审阅专项可独立运行，避免无关历史探针的既有失败遮蔽结果。 */
/** 真实控制器必须先取齐全部位置，再一次通知 UI，期间文本事件继续保留。 */
async function verifyPlacementEpochTakeover() {
  const harness = createHarness();
  let reads = 0;
  harness.client.loadNativeConversationTranscriptPlacements = async (_project, _conversation, ids) => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { conversationId, orderEpoch: 2, revision: 1000, uncoveredEntryIds: [], removedEntryIds: [], placements: ids.map((id) => ({ ...transcript(id, Number(id.split('-').at(-1)) + 1).placement, orderEpoch: 2 })) };
  };
  await harness.controller.start();
  try {
    for (let index = 0; index < 260; index += 1)
      harness.emit(conversationEvent(index + 1, 'conversation.item.started', { turnId: 'turn', itemId: `placement-${index}`, itemType: 'agentMessage', textContent: '正文', transcript: transcript(`placement-${index}`, index + 1) }));
    let publications = 0;
    const unsubscribe = harness.controller.subscribe(() => {
      publications += 1;
      const epochs = new Set(Object.values(harness.controller.getState().items).flatMap((item) => (item.transcript ? [item.transcript.placement.orderEpoch] : [])));
      assert(epochs.size <= 1, '位置接管不得发布混合代次。');
    });
    harness.emit(conversationEvent(261, 'conversation.transcript.placement.changed', { orderEpoch: 2, revision: 1000 }));
    harness.emit(
      conversationEvent(262, 'conversation.item.completed', {
        turnId: 'turn',
        itemId: 'placement-259',
        itemType: 'agentMessage',
        textContent: '期间完成正文',
        transcript: { ...transcript('placement-259', 260), placement: { ...transcript('placement-259', 260).placement, orderEpoch: 2 }, sources: [{ ...transcript('placement-259', 260).sources[0]!, revision: 1001, contentRevision: 1001 }] },
      }),
    );
    await waitUntil(() => Object.values(harness.controller.getState().items).every((item) => item.transcript?.placement.orderEpoch === 2), 'placement epoch takeover');
    assert(reads === 2 && publications === 1, '超过 256 个位置需分批读取且只发布一次。');
    assert(
      Object.values(harness.controller.getState().items).some((item) => item.text === '期间完成正文'),
      '位置接管不能丢失缓冲正文。',
    );
    unsubscribe();
    return { loadedItems: 260, batches: reads, publications };
  } finally {
    harness.controller.dispose();
  }
}
/** 真实控制器的正常初始化、取消、预算与故障边界，不更改发送语义。 */
async function verifyTranscriptInitializationRecovery() {
  /** 只读等待使用正式传输错误类型，服务端提示为一秒。 */
  const preparing = () => new ZeusApiError({ status: 503, error: 'ZEUS_CONVERSATION_TRANSCRIPT_INITIALIZING', message: '会话显示位置正在初始化。', retryAfterMs: 1_000 });
  /** 每个场景都拥有独立控制器并在 finally 销毁。 */
  const recovered = createHarness(undefined, 0, false);
  let reads = 0;
  let choices = 0;
  let queueReads = 0;
  try {
    const load = recovered.client.loadNativeConversationReadableSnapshot;
    const loadChoice = recovered.client.loadNativeConversationChoice;
    const loadQueue = recovered.client.loadNativeConversationQueueV2;
    recovered.client.loadNativeConversationReadableSnapshot = async (...args) => {
      if (++reads <= 2) throw preparing();
      return load(...args);
    };
    recovered.client.loadNativeConversationChoice = async (...args) => {
      choices += 1;
      return loadChoice(...args);
    };
    recovered.client.loadNativeConversationQueueV2 = async (...args) => {
      queueReads += 1;
      return loadQueue(...args);
    };
    recovered.controller.setDraft('保留未发送草稿');
    await recovered.controller.start();
    assert(reads === 3 && choices === 1 && queueReads === 1, '初始化只能重读可读快照，其他独立数据只读一次。');
    assert(recovered.controller.getState().transportState === 'ready' && recovered.controller.getState().draft === '保留未发送草稿' && recovered.sendCalls() === 0, '正常准备应自动接续、保留草稿且不发送模型请求。');
    /** 已显示内容在一次新的正常准备中始终保留。 */
    const previous = recovered.controller.getState().snapshot;
    let warmReads = 0;
    recovered.client.loadNativeConversationReadableSnapshot = async (...args) => {
      if (++warmReads === 1) throw preparing();
      return load(...args);
    };
    const reconnecting = recovered.controller.reconnect();
    await waitUntil(() => recovered.controller.getState().transcriptInitializing === true, 'warm transcript initialization');
    assert(recovered.controller.getState().snapshot?.id === previous?.id, '准备期间不能清空已显示快照。');
    await reconnecting;
  } finally {
    recovered.controller.dispose();
  }

  /** 手动重连取消旧计时器，迟到请求不创建额外恢复链。 */
  const cancelled = createHarness(undefined, 0, false);
  let cancelledReads = 0;
  try {
    const load = cancelled.client.loadNativeConversationReadableSnapshot;
    cancelled.client.loadNativeConversationReadableSnapshot = async (...args) => {
      if (++cancelledReads === 1) throw preparing();
      return load(...args);
    };
    const first = cancelled.controller.start().catch((error) => error);
    await waitUntil(() => cancelled.controller.getState().transcriptInitializing === true, 'initialization before reconnect');
    await cancelled.controller.reconnect();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert(cancelledReads === 2 && cancelled.controller.getState().transportState === 'ready', '手动重连后旧计时器不得继续读取或污染当前状态。');
  } finally {
    cancelled.controller.dispose();
  }

  /** 真实失败只有一次读取，错误码与不可重试语义不能丢失。 */
  const failed = createHarness(undefined, 0, false);
  let failedReads = 0;
  try {
    failed.client.loadNativeConversationReadableSnapshot = async () => {
      failedReads += 1;
      throw new ZeusApiError({ status: 500, error: 'ZEUS_CONVERSATION_TRANSCRIPT_INITIALIZATION_FAILED', message: '来源身份冲突。' });
    };
    await failed.controller.start().catch(() => undefined);
    assert(
      failedReads === 1 && failed.controller.getState().error?.code === 'ZEUS_CONVERSATION_TRANSCRIPT_INITIALIZATION_FAILED' && failed.controller.getState().error?.retryable === false,
      '真实初始化失败不能被自动重试或包装成普通读取错误。',
    );
  } finally {
    failed.controller.dispose();
  }

  /** 销毁立即终止正常准备，等待窗口过后不再请求。 */
  const disposed = createHarness(undefined, 0, false);
  let disposedReads = 0;
  try {
    disposed.client.loadNativeConversationReadableSnapshot = async () => {
      disposedReads += 1;
      throw preparing();
    };
    const pending = disposed.controller.start().catch((error) => error);
    await waitUntil(() => disposed.controller.getState().transcriptInitializing === true, 'initialization before dispose');
    disposed.controller.dispose();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert(disposedReads === 1, '销毁后不得残留初始化轮询。');
  } finally {
    disposed.controller.dispose();
  }

  /** 真正经过二十秒预算，卡住的第二次网络读取也必须被取消。 */
  const budget = createHarness(undefined, 0, false);
  let budgetReads = 0;
  let aborted = false;
  const began = Date.now();
  try {
    budget.client.loadNativeConversationReadableSnapshot = async (_project, _conversation, options) => {
      if (++budgetReads === 1) throw preparing();
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(options.signal?.reason);
          },
          { once: true },
        ),
      );
    };
    await budget.controller.start().catch(() => undefined);
    assert(Date.now() - began >= 19_000 && Date.now() - began < 23_000 && aborted && budgetReads === 2, '原二十秒预算必须取消卡住的读取，不能按重读续期。');
    assert(budget.controller.getState().error?.code === 'ZEUS_CONVERSATION_TRANSCRIPT_INITIALIZATION_PENDING' && budget.controller.getState().error?.retryable === true, '预算用尽应保留稍后重读入口，不冒充真实初始化失败。');
  } finally {
    budget.controller.dispose();
  }
  return { normalReads: reads, choices, queueReads, cancelledReads, failedReads, disposedReads, budgetReads, budgetCancelled: aborted };
}

/** 专项入口复用现有脚本，避免与历史待发送重放断言混淆。 */
if (process.argv.includes('--transcript-initialization-only')) {
  console.log(JSON.stringify({ transcriptInitialization: await verifyTranscriptInitializationRecovery() }));
  process.exit(0);
}

const placementTakeover = await verifyPlacementEpochTakeover();
console.log(JSON.stringify({ placementTakeover }));

const turnChangeReview = await verifyTurnChangeReviewHydration();
/** 重试专项可单独核验，不受其他既有投影断言影响。 */
const queuedRetryReconciliation = await verifyQueuedRetryReconciliation();
/** 补读与答题刷新共用同一稳定性核验。 */
const stableHydrationPages = verifyStableHydrationPages();
/** 会话恢复专项同时核对已接纳消息与待发队列的边界。 */
const restoredSubmissionOrder = verifyRestoredSubmissionOrder();
/** 默认仍执行既有全量入口；专项参数只缩小本地验收范围。 */
const result =
  process.argv.includes('--queue-retry-only') || process.argv.includes('--session-recovery-only')
    ? { queuedRetryReconciliation, stableHydrationPages, restoredSubmissionOrder }
    : process.argv.includes('--change-review-only')
      ? { turnChangeReview }
      : {
          turnChangeReview,
          budget: sessionRealtimeBufferBudget,
          restoredSubmissionOrder,
          truncatedTaskPushIdentity: verifyTruncatedTaskPushIdentityCoalescing(),
          internalPayloadVisibility: verifyInternalPayloadsStayOutOfTranscript(),
          processPageTerminalPreservation: verifyProcessPageDoesNotDowngradeLiveTerminalState(),
          queuedSubmissionThreadTransition: verifyQueuedSubmissionCanChangeNativeThread(),
          snapshotV2SettingsAndPlanRestoration: verifySnapshotV2SettingsAndPlanRestoration(),
          pendingPlanConfirmationRestoration: await verifyPendingPlanConfirmationRestoration(),
          idleHistoryWithoutSubscription: await verifyIdleHistoryDoesNotSubscribe(),
          restartedPendingSendPreservation: await verifyRestartedPendingSendPreservesIdentity(),
          transcriptInitialization: await verifyTranscriptInitializationRecovery(),
          queuedRetryReconciliation,
          activeSnapshotWatermarkSubscription: await verifyActiveSnapshotWatermarkSubscription(),
          idleTransitionReleasesSubscription: await verifyIdleTransitionReleasesSubscription(),
          renderDeltaOverflow: await verifyRenderDeltaOverflow(),
          syncGapByteOverflow: await verifyGapByteOverflow(),
          contiguousGapReplay: await verifyContiguousGapReplay(),
        };

process.stdout.write(`${JSON.stringify(result)}\n`);
