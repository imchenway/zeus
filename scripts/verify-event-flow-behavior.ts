import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodexAppServerEvent, CodexAppServerManager } from '../packages/ai-runtime/src/index.js';
import { createCodexProviderEventFlow } from '../packages/local-server/src/codexProviderEventFlow.js';
import { ConversationEventFlowControl } from '../packages/local-server/src/eventFlowControl.js';
import { ConversationSyncProtocol } from '../packages/local-server/src/conversationSyncProtocol.js';
import { registerConversationSyncRoutes, type ConversationRealtimeSocket } from '../packages/local-server/src/conversationSyncRoutes.js';
import { ConversationSyncEventRepository, createZeusDatabase } from '../packages/storage/src/index.js';

async function verifyCodexProviderEventFlow(): Promise<Record<string, unknown>> {
  let listener: ((event: CodexAppServerEvent) => void | Promise<void>) | null = null;
  let unsubscribed = 0;
  let dynamicCalls = 0;
  const handled: Array<{ method: string; delta: string | null; receiptCount: number }> = [];
  const handlerErrors: unknown[] = [];
  const flowControl = new ConversationEventFlowControl();
  const manager = {
    subscribe(next: (event: CodexAppServerEvent) => void | Promise<void>) {
      listener = next;
      return () => {
        unsubscribed += 1;
      };
    },
  } as unknown as CodexAppServerManager;
  const queue = createCodexProviderEventFlow({
    manager,
    flowControl,
    isKnown: (event) => event.sequence === 99,
    async handleEvent(event, receiptEvents) {
      const delta = isRecord(event.params) && typeof event.params.delta === 'string' ? event.params.delta : null;
      handled.push({ method: event.method, delta, receiptCount: receiptEvents?.length ?? 1 });
    },
    async handleEventError(_event, error) {
      handlerErrors.push(error);
    },
    async handleDynamicToolCall() {
      dynamicCalls += 1;
    },
  });
  const send = (event: CodexAppServerEvent): void | Promise<void> => {
    if (!listener) throw new Error('Codex Provider 行为核验未注册事件监听器。');
    return listener(event);
  };

  send(providerEvent(1, 'item/agentMessage/delta', { delta: 'hello ' }));
  send(providerEvent(2, 'item/agentMessage/delta', { delta: 'world' }));
  await send(providerEvent(3, 'turn/completed'));
  await queue.enqueueBarrier(async () => handled.push({ method: 'barrier', delta: null, receiptCount: 0 }));
  await send(providerEvent(99, 'item/agentMessage/delta', { delta: 'duplicate' }));
  const dynamicReturn = send(providerEvent(4, 'item/tool/call'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await queue.beginHandoff();

  const expected = [
    ['item/agentMessage/delta', 'hello world', 2],
    ['turn/completed', null, 1],
    ['barrier', null, 0],
  ];
  assertBehavior(JSON.stringify(handled.map((entry) => [entry.method, entry.delta, entry.receiptCount])) === JSON.stringify(expected), 'Provider delta、终态与 barrier 顺序不正确。');
  const snapshot = flowControl.snapshot();
  assertBehavior(snapshot.coalescedProcessEvents === 1, 'Provider delta 未按稳定 item 身份合并。');
  assertBehavior(snapshot.highWater.provider.pendingEvents >= 2, 'Provider 高水位没有记录排队事件。');
  assertBehavior(dynamicCalls === 1 && dynamicReturn === undefined, '动态工具调用必须旁路 transport backpressure，避免等待自身 Provider RPC。');
  assertBehavior(unsubscribed === 1, 'Provider handoff 必须且只能取消一次订阅。');
  assertBehavior(handlerErrors.length === 0, 'Provider handler 不应出现异常。');
  return {
    handled,
    coalescedProcessEvents: snapshot.coalescedProcessEvents,
    dynamicBackpressureBypassed: dynamicReturn === undefined,
    providerHighWaterEvents: snapshot.highWater.provider.pendingEvents,
    unsubscribed,
  };
}

async function verifyConversationSyncFlow(): Promise<Record<string, unknown>> {
  const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-event-flow-behavior-'));
  const database = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const repository = new ConversationSyncEventRepository(database);
  const flowControl = new ConversationEventFlowControl();
  const broadcasts: number[] = [];
  let clock = 0;
  const protocol = new ConversationSyncProtocol({
    db: database,
    repository,
    flowControl,
    now: () => new Date(Date.UTC(2026, 7, 21, 12, 0, clock++)),
    broadcast: (event) => {
      broadcasts.push(event.payload.sequence);
    },
  });
  const append = (conversationId: string, type: string, revision: number) => database.durableTransactionSync(() => protocol.append({ conversationId, type, payload: { entityRevision: revision, value: revision } }));

  try {
    append('conversation-gap', 'conversation.created', 1);
    append('conversation-gap', 'conversation.item.delta', 2);
    append('conversation-gap', 'conversation.turn.completed', 3);
    const first = protocol.listPage({ conversationId: 'conversation-gap', afterSequence: 0, limit: 2, byteLimit: 1024 * 1024 });
    const second = protocol.listPage({ conversationId: 'conversation-gap', afterSequence: first.nextCursor, limit: 2, byteLimit: 1024 * 1024 });
    const cursorPages = [first.events.map((event) => event.payload.sequence), second.events.map((event) => event.payload.sequence)];
    assertBehavior(JSON.stringify(cursorPages) === '[[1,2],[3]]' && first.hasMore && !second.hasMore, '增量补页必须严格连续且正确发布 hasMore。');

    database.durableTransactionSync(() => {
      repository.openStream({ conversationId: 'conversation-baseline', generationId: 'zeus-conversation-sync-v1', baseSequence: 10, establishedAt: '2026-08-21T12:10:00.000Z' });
      protocol.append({ conversationId: 'conversation-baseline', type: 'conversation.created', payload: { entityRevision: 1 } });
    });
    const baseline = protocol.listPage({ conversationId: 'conversation-baseline', afterSequence: 0 });
    assertBehavior(baseline.requestedBeforeBaseline && baseline.baseSequence === 10 && baseline.events[0]?.payload.sequence === 10, '早于 baseline 的 cursor 必须明确要求权威恢复。');

    const unknownDynamic = database.durableTransactionSync(() => protocol.append({ conversationId: 'conversation-gap', type: 'conversation.future.unregistered', payload: { entityRevision: 4 } }));
    assertBehavior(unknownDynamic.payload.sequence === 4, '未登记动态事件必须保守进入关键事实耐久流，不能按前缀或后缀静默丢弃。');

    const broadcastsBeforeCriticalCommit = broadcasts.length;
    const critical = database.commitCriticalFactSync(() => protocol.append({ conversationId: 'conversation-gap', type: 'conversation.request.created', payload: { entityRevision: 5 } }));
    assertBehavior(critical.payload.sequence === 5, '关键事实同步提交必须分配连续 sequence。');
    assertBehavior(broadcasts.length === broadcastsBeforeCriticalCommit + 1 && broadcasts.at(-1) === 5, '关键事实返回调用方前必须完成 COMMIT 后广播。');
    const observer = new DatabaseSync(join(probeRoot, 'probe.db'), { readOnly: true });
    try {
      const observed = observer.prepare('SELECT COUNT(*) AS count FROM conversation_sync_events WHERE conversation_id = ? AND sequence = ?').get('conversation-gap', 5) as { count?: number } | undefined;
      assertBehavior(observed?.count === 1, '关键事实返回调用方前必须能被独立只读连接观察到。');
    } finally {
      observer.close();
    }

    const routeHandlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const fakeServer = {
      get(path: string, ...arguments_: unknown[]) {
        const handler = arguments_.at(-1);
        if (typeof handler !== 'function') throw new Error(`同步路由 ${path} 缺少 handler。`);
        routeHandlers.set(path, handler as (...arguments_: unknown[]) => unknown);
        return fakeServer;
      },
    };
    const subscribers = new Set<ConversationRealtimeSocket>();
    registerConversationSyncRoutes({
      server: fakeServer as never,
      protocol,
      flowControl,
      subscribers,
      isAuthorizedRealtimeRequest: () => true,
      isNativeConversation: () => true,
      serverIdentity: () => ({ app: 'Zeus', host: '127.0.0.1', port: 12_345 }),
    });
    const websocketHandler = routeHandlers.get('/api/events');
    if (!websocketHandler) throw new Error('同步行为核验没有注册 /api/events。');

    const baselineSocket = new ProbeSocket();
    websocketHandler(baselineSocket, { query: { conversationId: 'conversation-baseline', afterSequence: '0', syncStreamGeneration: 'zeus-conversation-sync-v1' } });
    assertBehavior(baselineSocket.messages.at(-1)?.type === 'conversation.sync.baseline_required', 'WebSocket 必须发送 baseline_required 控制事件。');

    const slowSocket = new ProbeSocket((socket) => {
      if (socket.messages.length === 2) socket.bufferedAmount = 5 * 1024 * 1024;
    });
    websocketHandler(slowSocket, { query: { conversationId: 'conversation-gap', afterSequence: '0', syncStreamGeneration: 'zeus-conversation-sync-v1' } });
    assertBehavior(slowSocket.closed?.code === 1013, '超过 4 MiB 的慢消费者必须断开并按 cursor 恢复。');

    const snapshot = flowControl.snapshot();
    assertBehavior(snapshot.websocketSlowConsumerDisconnects === 1, '慢消费者断开必须进入诊断计数。');
    assertBehavior(snapshot.appendedByDurability.critical_fact === 5 && snapshot.appendedByDurability.coalescible_process === 1, '精确注册表与未知事件失败安全分类计数不正确。');
    assertBehavior(snapshot.droppedEphemeralEvents === 0, '当前 ephemeral 注册表为空，不应伪造临时事件丢弃计数。');
    assertBehavior(JSON.stringify(broadcasts) === '[1,2,3,10,4,5]', 'afterCommit 广播必须与耐久 sequence 一致。');
    const quickCheck = database.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check;
    assertBehavior(quickCheck === 'ok', `临时数据库 quick_check 失败：${quickCheck ?? 'missing'}`);
    return {
      cursorPages,
      baseline: { baseSequence: baseline.baseSequence, control: baselineSocket.messages.at(-1)?.type ?? null },
      slowConsumerClose: slowSocket.closed?.code ?? null,
      durability: snapshot.appendedByDurability,
      droppedEphemeralEvents: snapshot.droppedEphemeralEvents,
      broadcasts,
      quickCheck,
    };
  } finally {
    await database.close();
    await rm(probeRoot, { recursive: true, force: true });
  }
}

class ProbeSocket implements ConversationRealtimeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly messages: Array<Record<string, unknown>> = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  private closeListener: (() => void) | null = null;

  constructor(private readonly afterSend?: (socket: ProbeSocket) => void) {}

  send(data: string): void {
    const value = JSON.parse(data) as unknown;
    if (!isRecord(value)) throw new Error('WebSocket 行为核验收到非对象事件。');
    this.messages.push(value);
    this.afterSend?.(this);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 0;
    this.closeListener?.();
  }

  on(event: 'close', listener: () => void): void {
    if (event === 'close') this.closeListener = listener;
  }
}

function providerEvent(sequence: number, method: string, params: Record<string, unknown> = {}): CodexAppServerEvent {
  return {
    generationId: 'generation-probe',
    sequence,
    method,
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', ...params },
    receivedAt: '2026-08-21T12:00:00.000Z',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ZARCH 事件流行为核验失败：${message}`);
}

const provider = await verifyCodexProviderEventFlow();
const sync = await verifyConversationSyncFlow();

console.log(JSON.stringify({ status: 'passed', provider, sync }, null, 2));
