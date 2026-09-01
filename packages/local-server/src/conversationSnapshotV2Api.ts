import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConversationSnapshotV2Error, type ConversationSnapshotV2ExecutionContext, type ConversationSnapshotV2Repository, conversationSnapshotV2StructureGeneration } from '@zeus/storage';

interface ConversationOwnershipRecord {
  id: string;
  projectId: string;
}

interface ConversationSnapshotV2ApiOptions {
  server: FastifyInstance;
  repository: ConversationSnapshotV2Repository;
  projectExists: (projectId: string) => boolean;
  getConversation: (conversationId: string) => ConversationOwnershipRecord | undefined;
  readExecutionContext?: (conversationId: string) => Promise<ConversationSnapshotV2ExecutionContext>;
  readQueueState: (conversationId: string) => unknown;
}

interface ConversationParams {
  projectId: string;
  conversationId: string;
}

interface TurnParams extends ConversationParams {
  turnId: string;
}

interface ChangeSetParams extends TurnParams {
  changeSetId: string;
}

interface PageQuery {
  cursor?: string;
  limit?: string;
  byteLimit?: string;
  direction?: string;
}

interface ContentQuery {
  handle?: string;
  offset?: string;
  byteLimit?: string;
}

type ProcessKind = 'reasoning' | 'tool' | 'command' | 'retry' | 'context_compaction' | 'waiting' | 'warning';

/** 注册 Snapshot V2 与所有重内容按需读取入口；V1 路由继续由主 server 保持兼容。 */
export function registerConversationSnapshotV2Api(options: ConversationSnapshotV2ApiOptions): void {
  const { server, repository } = options;

  server.get(
    '/api/projects/:projectId/conversations/:conversationId/snapshot-v2',
    async (
      request: FastifyRequest<{
        Params: ConversationParams;
        Querystring: { closedTurns?: string; byteLimit?: string; includeMetrics?: string };
      }>,
      reply,
    ) => {
      if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
      markV2Response(reply);
      try {
        if (request.query.includeMetrics !== undefined && request.query.includeMetrics !== 'true' && request.query.includeMetrics !== 'false') {
          throw new ConversationSnapshotV2Error('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_ARGUMENT', 'includeMetrics 必须为 true 或 false。', 400);
        }
        const executionContext = await options.readExecutionContext?.(request.params.conversationId);
        const snapshot = repository.readSnapshot(request.params.conversationId, {
          ...(request.query.closedTurns === undefined ? {} : { closedTurnLimit: Number(request.query.closedTurns) }),
          ...(request.query.byteLimit === undefined ? {} : { byteLimit: Number(request.query.byteLimit) }),
          ...(request.query.includeMetrics === undefined ? {} : { includeSessionMetrics: request.query.includeMetrics === 'true' }),
          ...(executionContext ? { executionContext } : {}),
        });
        return snapshot;
      } catch (error) {
        return sendSnapshotV2Error(reply, error);
      }
    },
  );

  server.get('/api/projects/:projectId/conversations/:conversationId/session-metrics', async (request: FastifyRequest<{ Params: ConversationParams }>, reply) => {
    if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
    markV2Response(reply);
    try {
      return repository.readSessionMetrics(request.params.conversationId);
    } catch (error) {
      return sendSnapshotV2Error(reply, error);
    }
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/timeline', async (request: FastifyRequest<{ Params: ConversationParams; Querystring: PageQuery }>, reply) => {
    if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
    markV2Response(reply);
    try {
      return repository.listTimelinePage(pageInput(request.params.conversationId, request.query));
    } catch (error) {
      return sendSnapshotV2Error(reply, error);
    }
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/model-history', async (request: FastifyRequest<{ Params: ConversationParams; Querystring: PageQuery }>, reply) => {
    if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
    markV2Response(reply);
    try {
      if (request.query.direction !== undefined && request.query.direction !== 'forward' && request.query.direction !== 'tail') {
        throw new ConversationSnapshotV2Error('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_ARGUMENT', '模型历史分页方向无效。', 400);
      }
      const input = pageInput(request.params.conversationId, request.query);
      return request.query.direction === 'tail' ? repository.listModelHistoryTailPage(input) : repository.listModelHistoryPage(input);
    } catch (error) {
      return sendSnapshotV2Error(reply, error);
    }
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/turns/:turnId/model-history', async (request: FastifyRequest<{ Params: TurnParams; Querystring: PageQuery }>, reply) => {
    if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
    markV2Response(reply);
    try {
      return repository.listTurnModelHistoryPage({
        ...pageInput(request.params.conversationId, request.query),
        turnId: request.params.turnId,
      });
    } catch (error) {
      return sendSnapshotV2Error(reply, error);
    }
  });

  server.get(
    '/api/projects/:projectId/conversations/:conversationId/turns/:turnId/process',
    async (
      request: FastifyRequest<{
        Params: TurnParams;
        Querystring: PageQuery & { kind?: string };
      }>,
      reply,
    ) => {
      if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
      markV2Response(reply);
      try {
        return repository.listProcessPage({
          ...pageInput(request.params.conversationId, request.query),
          turnId: request.params.turnId,
          ...(request.query.kind === undefined ? {} : { kind: parseProcessKind(request.query.kind) }),
        });
      } catch (error) {
        return sendSnapshotV2Error(reply, error);
      }
    },
  );

  server.get('/api/projects/:projectId/conversations/:conversationId/turns/:turnId/commands', async (request: FastifyRequest<{ Params: TurnParams; Querystring: PageQuery }>, reply) => {
    if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
    markV2Response(reply);
    try {
      return repository.listProcessPage({
        ...pageInput(request.params.conversationId, request.query),
        turnId: request.params.turnId,
        kind: 'command',
      });
    } catch (error) {
      return sendSnapshotV2Error(reply, error);
    }
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/resources/page', async (request: FastifyRequest<{ Params: ConversationParams; Querystring: PageQuery }>, reply) => {
    if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
    markV2Response(reply);
    try {
      return repository.listResourcePage(pageInput(request.params.conversationId, request.query));
    } catch (error) {
      return sendSnapshotV2Error(reply, error);
    }
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/queue-state', async (request: FastifyRequest<{ Params: ConversationParams }>, reply) => {
    if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
    markV2Response(reply);
    return options.readQueueState(request.params.conversationId);
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/turns/:turnId/change-set/summary', async (request: FastifyRequest<{ Params: TurnParams }>, reply) => {
    if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
    markV2Response(reply);
    try {
      return repository.getChangeSetSummary(request.params.conversationId, request.params.turnId);
    } catch (error) {
      return sendSnapshotV2Error(reply, error);
    }
  });

  server.get('/api/projects/:projectId/conversations/:conversationId/turns/:turnId/change-set/:changeSetId/files', async (request: FastifyRequest<{ Params: ChangeSetParams; Querystring: PageQuery }>, reply) => {
    if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
    markV2Response(reply);
    try {
      return repository.listChangeFilesPage({
        ...pageInput(request.params.conversationId, request.query),
        turnId: request.params.turnId,
        changeSetId: request.params.changeSetId,
      });
    } catch (error) {
      return sendSnapshotV2Error(reply, error);
    }
  });

  const readContent = async (
    request: FastifyRequest<{
      Params: ConversationParams & { handle?: string };
      Querystring: ContentQuery;
    }>,
    reply: FastifyReply,
  ) => {
    if (!hasConversationAccess(options, request.params)) return conversationNotFound(reply);
    markV2Response(reply);
    const handle = request.query.handle ?? request.params.handle;
    if (!handle) {
      return reply.code(400).send({
        error: 'ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_ARGUMENT',
        message: '正文句柄不能为空。',
      });
    }
    try {
      return repository.readContentPage({
        conversationId: request.params.conversationId,
        handle,
        ...(request.query.offset === undefined ? {} : { offset: Number(request.query.offset) }),
        ...(request.query.byteLimit === undefined ? {} : { byteLimit: Number(request.query.byteLimit) }),
      });
    } catch (error) {
      return sendSnapshotV2Error(reply, error);
    }
  };

  // 签名正文句柄可能超过 Fastify 路径参数的默认长度上限，因此新客户端统一走查询参数。
  // 旧路径继续保留，兼容长度较短的历史客户端。
  server.get('/api/projects/:projectId/conversations/:conversationId/content', readContent);
  server.get(
    '/api/projects/:projectId/conversations/:conversationId/content/:handle',
    async (
      request: FastifyRequest<{
        Params: ConversationParams & { handle: string };
        Querystring: ContentQuery;
      }>,
      reply,
    ) => readContent(request, reply),
  );
}

function pageInput(conversationId: string, query: PageQuery): { conversationId: string; cursor?: string; entryLimit?: number; byteLimit?: number } {
  return {
    conversationId,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { entryLimit: Number(query.limit) }),
    ...(query.byteLimit === undefined ? {} : { byteLimit: Number(query.byteLimit) }),
  };
}

function hasConversationAccess(options: ConversationSnapshotV2ApiOptions, params: ConversationParams): boolean {
  if (!options.projectExists(params.projectId)) return false;
  const conversation = options.getConversation(params.conversationId);
  return Boolean(conversation && conversation.id === params.conversationId && conversation.projectId === params.projectId);
}

function parseProcessKind(value: string): ProcessKind {
  if (['reasoning', 'tool', 'command', 'retry', 'context_compaction', 'waiting', 'warning'].includes(value)) return value as ProcessKind;
  throw new ConversationSnapshotV2Error('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_ARGUMENT', '过程类型无效。', 400);
}

function markV2Response(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-zeus-conversation-snapshot-generation', conversationSnapshotV2StructureGeneration);
}

function conversationNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'ZEUS_CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
}

function sendSnapshotV2Error(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ConversationSnapshotV2Error) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({
    error: 'ZEUS_CONVERSATION_SNAPSHOT_V2_READ_FAILED',
    message: error instanceof Error ? error.message : 'Snapshot V2 read failed.',
  });
}
