import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { conversationSyncProtocolGeneration, conversationSyncTransportBudgets, type ConversationSyncFlowControlPort, type ConversationSyncProtocol } from './conversationSyncProtocol.js';

export interface ConversationRealtimeSocket {
  OPEN: number;
  readyState: number;
  bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'close', listener: () => void): void;
}

export interface ConversationSyncRoutePorts {
  server: FastifyInstance;
  protocol: ConversationSyncProtocol;
  flowControl: ConversationSyncFlowControlPort;
  subscribers: Set<ConversationRealtimeSocket>;
  isAuthorizedRealtimeRequest(request: FastifyRequest): boolean;
  isNativeConversation(conversationId: string, projectId?: string): boolean;
  /** 当前打开的会话按 Provider 水位补齐移动端新轮次与遗漏终态。 */
  synchronizeConversation?(conversationId: string): Promise<void>;
  serverIdentity(): { app: string; host: string; port: number };
}

const providerCatchUpIntervalMs = 5_000;

/**
 * 注册耐久会话增量的 WebSocket replay 与 HTTP cursor 补页。
 * 路由只依赖同步协议和会话访问端口，不读取 SQL、Provider JSONL 或产品会话行类型。
 */
export function registerConversationSyncRoutes(ports: ConversationSyncRoutePorts): void {
  ports.server.get('/api/events', { websocket: true }, (socket, request) => {
    const subscriber = socket as ConversationRealtimeSocket;
    if (!ports.isAuthorizedRealtimeRequest(request)) {
      subscriber.close(1008, 'Missing or invalid Zeus local API token');
      return;
    }
    try {
      const query = request.query as { conversationId?: string; afterSequence?: string; syncStreamGeneration?: string };
      const conversationId = query.conversationId?.trim() || null;
      const afterSequence = parseCursorInteger({ value: query.afterSequence, fallback: 0, maximum: Number.MAX_SAFE_INTEGER, field: 'afterSequence', allowZero: true });
      if (query.syncStreamGeneration && query.syncStreamGeneration !== conversationSyncProtocolGeneration) {
        subscriber.close(1008, 'Conversation sync stream generation changed; fetch a new authoritative snapshot.');
        return;
      }
      if (conversationId && !ports.isNativeConversation(conversationId)) {
        subscriber.close(1008, 'Native conversation not found.');
        return;
      }
      subscriber.send(
        JSON.stringify({
          id: randomUUID(),
          type: 'server.connected',
          payload: { ...ports.serverIdentity(), syncStreamGeneration: conversationSyncProtocolGeneration },
          createdAt: new Date().toISOString(),
        }),
      );
      if (conversationId) replayConversationPage(ports, subscriber, conversationId, afterSequence);
      ports.subscribers.add(subscriber);
      let catchUpInFlight = false;
      const catchUp = (): void => {
        if (!conversationId || !ports.synchronizeConversation || catchUpInFlight) return;
        catchUpInFlight = true;
        void ports
          .synchronizeConversation(conversationId)
          // 后台追赶的瞬时网络失败留待下一周期重试，不能污染当前轮次或制造红色消息。
          .catch(() => undefined)
          .finally(() => {
            catchUpInFlight = false;
          });
      };
      catchUp();
      const catchUpTimer = conversationId && ports.synchronizeConversation ? setInterval(catchUp, providerCatchUpIntervalMs) : null;
      catchUpTimer?.unref?.();
      subscriber.on('close', () => {
        if (catchUpTimer) clearInterval(catchUpTimer);
        ports.subscribers.delete(subscriber);
      });
    } catch {
      subscriber.close(1011, 'Conversation sync replay failed; fetch a new authoritative snapshot.');
    }
  });

  ports.server.get(
    '/api/projects/:projectId/conversations/:conversationId/events',
    async (
      request: FastifyRequest<{
        Params: { projectId: string; conversationId: string };
        Querystring: { afterSequence?: string; limit?: string; byteLimit?: string; syncStreamGeneration?: string };
      }>,
      reply,
    ) => {
      if (!ports.isNativeConversation(request.params.conversationId, request.params.projectId)) {
        return reply.code(404).send({ error: 'ZEUS_NATIVE_CONVERSATION_NOT_FOUND', message: 'Native conversation not found' });
      }
      if (request.query.syncStreamGeneration && request.query.syncStreamGeneration !== conversationSyncProtocolGeneration) {
        return reply.code(409).send({
          error: 'ZEUS_CONVERSATION_SYNC_GENERATION_MISMATCH',
          message: '会话增量协议代次已变化，必须重新读取权威快照。',
          syncStreamGeneration: conversationSyncProtocolGeneration,
        });
      }
      try {
        return ports.protocol.listPage({
          conversationId: request.params.conversationId,
          afterSequence: parseCursorInteger({ value: request.query.afterSequence, fallback: 0, maximum: Number.MAX_SAFE_INTEGER, field: 'afterSequence', allowZero: true }),
          limit: parseCursorInteger({ value: request.query.limit, fallback: 100, maximum: conversationSyncTransportBudgets.maximumReplayEvents, field: 'limit', allowZero: false }),
          byteLimit: parseCursorInteger({ value: request.query.byteLimit, fallback: 256 * 1024, maximum: conversationSyncTransportBudgets.maximumReplayPageBytes, field: 'byteLimit', allowZero: false }),
        });
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'ZEUS_CONVERSATION_SYNC_READ_FAILED';
        return reply.code(code === 'ZEUS_CONVERSATION_SYNC_CURSOR_INVALID' ? 400 : 409).send({
          error: code,
          message: error instanceof Error ? error.message : '无法读取会话增量事件。',
        });
      }
    },
  );
}

function replayConversationPage(ports: ConversationSyncRoutePorts, subscriber: ConversationRealtimeSocket, conversationId: string, afterSequence: number): void {
  const page = ports.protocol.listPage({
    conversationId,
    afterSequence,
    limit: conversationSyncTransportBudgets.maximumReplayEvents,
    byteLimit: conversationSyncTransportBudgets.maximumReplayPageBytes,
  });
  for (const event of page.events) {
    if ((subscriber.bufferedAmount ?? 0) > conversationSyncTransportBudgets.maximumBufferedBytes) {
      ports.flowControl.observeWebSocketSlowConsumerDisconnect(subscriber.bufferedAmount ?? 0);
      subscriber.close(1013, 'Conversation replay consumer exceeded the bounded queue; reconnect and resume by cursor.');
      return;
    }
    subscriber.send(JSON.stringify(event));
  }
  if (!page.requestedBeforeBaseline && !page.hasMore) return;
  if ((subscriber.bufferedAmount ?? 0) > conversationSyncTransportBudgets.maximumBufferedBytes) {
    ports.flowControl.observeWebSocketSlowConsumerDisconnect(subscriber.bufferedAmount ?? 0);
    subscriber.close(1013, 'Conversation replay consumer exceeded the bounded queue; reconnect and resume by cursor.');
    return;
  }
  subscriber.send(
    JSON.stringify({
      id: randomUUID(),
      type: page.requestedBeforeBaseline ? 'conversation.sync.baseline_required' : 'conversation.sync.catch_up_required',
      payload: {
        conversationId,
        syncStreamGeneration: conversationSyncProtocolGeneration,
        requestedAfterSequence: afterSequence,
        baseSequence: page.baseSequence,
        nextCursor: page.nextCursor,
        throughEventSeq: page.throughEventSeq,
      },
      createdAt: new Date().toISOString(),
    }),
  );
}

function parseCursorInteger(input: { value: string | undefined; fallback: number; maximum: number; field: string; allowZero: boolean }): number {
  if (input.value === undefined || input.value === '') return input.fallback;
  const parsed = Number(input.value);
  if (!Number.isSafeInteger(parsed) || parsed > input.maximum || (input.allowZero ? parsed < 0 : parsed <= 0)) {
    throw Object.assign(new Error(`${input.field} 必须是${input.allowZero ? '非负' : '正'}安全整数，且不得超过 ${input.maximum}。`), {
      code: 'ZEUS_CONVERSATION_SYNC_CURSOR_INVALID',
    });
  }
  return parsed;
}
