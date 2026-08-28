import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConversationDispatchCommandApplication, conversationDispatchCommandHttpError, conversationDispatchCommandTypes, type ConversationDispatchMutationRequest } from './conversationDispatchCommandApplication.js';

type EmptyInput = Record<string, never>;
type ConversationParams = { projectId: string; conversationId: string };
type SubmissionParams = ConversationParams & { submissionId: string };
type TurnParams = ConversationParams & { turnId: string };
type RequestParams = ConversationParams & { requestId: string };

interface ChangeSetInput {
  changeSetId?: unknown;
  expectedState?: unknown;
}

interface QueueUpdateInput {
  content?: unknown;
}

interface QueueRerouteInput {
  model?: unknown;
  effort?: unknown;
  serviceTier?: unknown;
  permissionMode?: unknown;
  collaborationMode?: unknown;
}

interface QueueReorderInput {
  orderedSubmissionIds?: unknown;
}

interface SideChatInput {
  selectedText?: unknown;
  question?: unknown;
}

interface PlanImplementationInput {
  action?: unknown;
  feedback?: unknown;
}

interface RouteResponse<T = unknown> {
  statusCode: number;
  body: T;
}

export interface ConversationDispatchCommandRouteOperations {
  changeSet(input: { params: TurnParams; action: 'undo' | 'reapply'; changeSetId: string; expectedState: 'applied' | 'undone'; operationIdentity: string }): Promise<unknown>;
  message(input: {
    params: ConversationParams;
    body: Record<string, unknown>;
    operationIdentity: string;
    providerWriteLifecycle: { markPrepared(resourceId: string): Promise<void>; markRpcStarted(resourceId: string): void };
  }): Promise<RouteResponse>;
  sideChat(input: { params: ConversationParams; selectedText: string; question: string; operationIdentity: string }): Promise<unknown>;
  queueUpdate(input: { params: SubmissionParams; content: string }): unknown;
  queueRetry(input: { params: SubmissionParams }): unknown;
  prepareQueueReroute(input: { params: SubmissionParams; settings: QueueRerouteInput }): Promise<unknown>;
  queueReroute(input: { params: SubmissionParams; prepared: unknown }): unknown;
  queueDelete(input: { params: SubmissionParams }): unknown;
  queueSendNow(input: { params: SubmissionParams; operationIdentity: string }): Promise<unknown>;
  turnInterrupt(input: { params: TurnParams; operationIdentity: string }): Promise<unknown>;
  serverRequestRespond(input: { params: RequestParams; response: Record<string, unknown>; operationIdentity: string }): Promise<unknown>;
  planImplementationRespond(input: { params: RequestParams; action: 'implement' | 'refine' | 'dismiss'; feedback?: string; operationIdentity: string }): Promise<unknown>;
  requestSnooze(input: { params: RequestParams }): unknown;
  queueResume(input: { params: ConversationParams; operationIdentity: string }): Promise<unknown>;
  queueRecover(input: { params: ConversationParams; operationIdentity: string }): Promise<unknown>;
  queueReorder(input: { params: ConversationParams; orderedSubmissionIds: string[] }): unknown;
  afterCoreAccepted(input: { kind: 'queue_update' | 'queue_retry' | 'queue_reroute' | 'queue_delete' | 'request_snooze' | 'queue_reorder'; params: ConversationParams; result: unknown }): void;
}

/** 只注册消息、change-set、交互请求与 Queue mutation，读取接口继续由组合根持有。 */
export function registerConversationDispatchCommandRoutes(options: {
  server: FastifyInstance;
  application: ConversationDispatchCommandApplication;
  operations: ConversationDispatchCommandRouteOperations;
  sendNativeError(reply: FastifyReply, error: unknown): unknown;
  sendChangeSetError(reply: FastifyReply, error: unknown): unknown;
}): void {
  const { server, application, operations } = options;

  for (const action of ['undo', 'reapply'] as const) {
    server.post(`/api/projects/:projectId/conversations/:conversationId/turns/:turnId/change-set/${action}`, async (request: FastifyRequest<{ Params: TurnParams; Body: ConversationDispatchMutationRequest<ChangeSetInput> }>, reply) => {
      try {
        const parsed = application.parse<ChangeSetInput>({
          value: request.body,
          commandType: action === 'undo' ? conversationDispatchCommandTypes.changeSetUndo : conversationDispatchCommandTypes.changeSetReapply,
          scopeKind: 'turn',
          scopeId: request.params.turnId,
        });
        assertExactInputKeys(parsed.input, ['changeSetId', 'expectedState'], parsed.command.commandType);
        const changeSetId = requiredString(parsed.input.changeSetId, 'changeSetId');
        if (parsed.input.expectedState !== 'applied' && parsed.input.expectedState !== 'undone') throw routeError('ZEUS_TURN_CHANGE_SET_REQUEST_INVALID', 'expectedState must be applied or undone.', 400);
        const executed = await application.executeExternal({
          parsed,
          destinationId: 'conversation-turn-change-set-files',
          resourceId: changeSetId,
          externalOperationId: `turn-change-set:${changeSetId}:${action}:${parsed.operationIdentity}`,
          invoke: () => operations.changeSet({ params: request.params, action, changeSetId, expectedState: parsed.input.expectedState as 'applied' | 'undone', operationIdentity: parsed.operationIdentity }),
          isExplicitRejection: isExplicitRouteRejection,
        });
        return executed.result;
      } catch (error) {
        const mapped = conversationDispatchCommandHttpError(error);
        if (mapped) return reply.code(mapped.statusCode).send(mapped.payload);
        return options.sendChangeSetError(reply, error);
      }
    });
  }

  server.post('/api/projects/:projectId/conversations/:conversationId/messages', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationDispatchMutationRequest<Record<string, unknown>> }>, reply) => {
    try {
      const parsed = parseConversationCommand(request, conversationDispatchCommandTypes.messageSubmit);
      const idempotencyKey = requiredString(parsed.input.idempotencyKey, 'idempotencyKey');
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'conversation-message-dispatch',
        resourceId: request.params.conversationId,
        externalOperationId: `conversation-message:${request.params.conversationId}:${idempotencyKey}`,
        manualExternalWriteStart: true,
        invoke: (markExternalWriteStarted) =>
          operations.message({
            params: request.params,
            body: parsed.input,
            operationIdentity: parsed.operationIdentity,
            providerWriteLifecycle: {
              markPrepared: async () => undefined,
              markRpcStarted: () => markExternalWriteStarted(),
            },
          }),
        isExplicitRejection: isExplicitRouteRejection,
      });
      return reply.code(executed.result.statusCode).send(executed.result.body);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/side-chat', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationDispatchMutationRequest<SideChatInput> }>, reply) => {
    try {
      const parsed = parseConversationCommand(request, conversationDispatchCommandTypes.sideChatAsk);
      assertExactInputKeys(parsed.input, ['question', 'selectedText'], parsed.command.commandType);
      const selectedText = requiredString(parsed.input.selectedText, 'selectedText').trim();
      const question = requiredString(parsed.input.question, 'question').trim();
      if (!selectedText || selectedText.length > 20_000 || !question || question.length > 100_000) throw routeError('ZEUS_SIDE_CHAT_INPUT_INVALID', 'Selected text and question must stay within the supported size.', 400);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'conversation-side-chat-provider',
        resourceId: request.params.conversationId,
        externalOperationId: `side-chat:${parsed.operationIdentity}`,
        invoke: () => operations.sideChat({ params: request.params, selectedText, question, operationIdentity: parsed.operationIdentity }),
        isExplicitRejection: isExplicitRouteRejection,
      });
      return executed.result;
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.patch('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId', async (request: FastifyRequest<{ Params: SubmissionParams; Body: ConversationDispatchMutationRequest<QueueUpdateInput> }>, reply) => {
    try {
      const parsed = parseSubmissionCommand(request, conversationDispatchCommandTypes.queueUpdate);
      assertExactInputKeys(parsed.input, ['content'], parsed.command.commandType);
      const content = requiredString(parsed.input.content, 'content').trim();
      if (!content) throw routeError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'Queued message content is required.', 400);
      const executed = application.executeCore({
        parsed,
        destinationId: 'conversation-queue-application',
        resourceId: request.params.submissionId,
        mutateBusinessState: () => operations.queueUpdate({ params: request.params, content }),
      });
      afterCore(executed.replayed, 'queue_update', request.params, executed.result);
      return executed.result;
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId/retry', async (request: FastifyRequest<{ Params: SubmissionParams; Body: ConversationDispatchMutationRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseSubmissionCommand(request, conversationDispatchCommandTypes.queueRetry);
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = application.executeCore({
        parsed,
        destinationId: 'conversation-queue-application',
        resourceId: request.params.submissionId,
        mutateBusinessState: () => operations.queueRetry({ params: request.params }),
      });
      afterCore(executed.replayed, 'queue_retry', request.params, executed.result);
      return reply.code(202).send(executed.result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId/reroute', async (request: FastifyRequest<{ Params: SubmissionParams; Body: ConversationDispatchMutationRequest<QueueRerouteInput> }>, reply) => {
    try {
      const parsed = parseSubmissionCommand(request, conversationDispatchCommandTypes.queueReroute);
      assertOnlyInputKeys(parsed.input, ['collaborationMode', 'effort', 'model', 'permissionMode', 'serviceTier'], parsed.command.commandType);
      const prepared = await operations.prepareQueueReroute({ params: request.params, settings: parsed.input });
      const executed = application.executeCore({
        parsed,
        destinationId: 'conversation-queue-application',
        resourceId: request.params.submissionId,
        mutateBusinessState: () => operations.queueReroute({ params: request.params, prepared }),
      });
      afterCore(executed.replayed, 'queue_reroute', request.params, executed.result);
      return reply.code(202).send(executed.result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.delete('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId', async (request: FastifyRequest<{ Params: SubmissionParams; Body: ConversationDispatchMutationRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseSubmissionCommand(request, conversationDispatchCommandTypes.queueDelete);
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = application.executeCore({
        parsed,
        destinationId: 'conversation-queue-application',
        resourceId: request.params.submissionId,
        mutateBusinessState: () => operations.queueDelete({ params: request.params }),
      });
      afterCore(executed.replayed, 'queue_delete', request.params, executed.result);
      return executed.result;
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId/send-now', async (request: FastifyRequest<{ Params: SubmissionParams; Body: ConversationDispatchMutationRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseSubmissionCommand(request, conversationDispatchCommandTypes.queueSendNow);
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'conversation-provider-turn-steer',
        resourceId: request.params.submissionId,
        externalOperationId: `provider-turn-steer:${request.params.submissionId}`,
        invoke: () => operations.queueSendNow({ params: request.params, operationIdentity: parsed.operationIdentity }),
        isExplicitRejection: isExplicitRouteRejection,
      });
      return reply.code(202).send(executed.result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/turns/:turnId/interrupt', async (request: FastifyRequest<{ Params: TurnParams; Body: ConversationDispatchMutationRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseTurnCommand(request, conversationDispatchCommandTypes.turnInterrupt);
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'conversation-provider-turn-interrupt',
        resourceId: request.params.turnId,
        externalOperationId: `provider-turn-interrupt:${request.params.turnId}`,
        invoke: () => operations.turnInterrupt({ params: request.params, operationIdentity: parsed.operationIdentity }),
        isExplicitRejection: isExplicitRouteRejection,
      });
      return reply.code(202).send(executed.result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/requests/:requestId/respond', async (request: FastifyRequest<{ Params: RequestParams; Body: ConversationDispatchMutationRequest<Record<string, unknown>> }>, reply) => {
    try {
      const parsed = parseRequestCommand(request, conversationDispatchCommandTypes.serverRequestRespond);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'conversation-provider-server-request',
        resourceId: request.params.requestId,
        externalOperationId: `provider-server-request:${request.params.requestId}`,
        invoke: () => operations.serverRequestRespond({ params: request.params, response: parsed.input, operationIdentity: parsed.operationIdentity }),
        isExplicitRejection: isExplicitRouteRejection,
      });
      return reply.code(202).send(executed.result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post(
    '/api/projects/:projectId/conversations/:conversationId/plan-implementation-requests/:requestId/respond',
    async (request: FastifyRequest<{ Params: RequestParams; Body: ConversationDispatchMutationRequest<PlanImplementationInput> }>, reply) => {
      try {
        const parsed = parseRequestCommand(request, conversationDispatchCommandTypes.planImplementationRespond);
        assertOnlyInputKeys(parsed.input, ['action', 'feedback'], parsed.command.commandType);
        const action = parsed.input.action;
        if (action !== 'implement' && action !== 'refine' && action !== 'dismiss') throw routeError('ZEUS_INVALID_PLAN_IMPLEMENTATION_RESPONSE', 'action must be implement, refine, or dismiss.', 400);
        if (parsed.input.feedback !== undefined && typeof parsed.input.feedback !== 'string') throw routeError('ZEUS_INVALID_PLAN_IMPLEMENTATION_RESPONSE', 'feedback must be a string.', 400);
        const executed = await application.executeExternal({
          parsed,
          destinationId: 'conversation-plan-implementation',
          resourceId: request.params.requestId,
          externalOperationId: `plan-implementation-response:${request.params.requestId}`,
          invoke: () =>
            operations.planImplementationRespond({
              params: request.params,
              action,
              ...(typeof parsed.input.feedback === 'string' ? { feedback: parsed.input.feedback } : {}),
              operationIdentity: parsed.operationIdentity,
            }),
          isExplicitRejection: isExplicitRouteRejection,
        });
        return reply.code(202).send(executed.result);
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );

  server.post('/api/projects/:projectId/conversations/:conversationId/requests/:requestId/snooze', async (request: FastifyRequest<{ Params: RequestParams; Body: ConversationDispatchMutationRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseRequestCommand(request, conversationDispatchCommandTypes.requestSnooze);
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = application.executeCore({
        parsed,
        destinationId: 'conversation-request-application',
        resourceId: request.params.requestId,
        mutateBusinessState: () => operations.requestSnooze({ params: request.params }),
      });
      afterCore(executed.replayed, 'request_snooze', request.params, executed.result);
      return executed.result;
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/queue/resume', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationDispatchMutationRequest<EmptyInput> }>, reply) => {
    return executeConversationExternal(request, reply, conversationDispatchCommandTypes.queueResume, 'conversation-queue-resume', `queue-resume:${request.params.conversationId}`, (operationIdentity) =>
      operations.queueResume({ params: request.params, operationIdentity }),
    );
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/queue/recover', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationDispatchMutationRequest<EmptyInput> }>, reply) => {
    return executeConversationExternal(request, reply, conversationDispatchCommandTypes.queueRecover, 'conversation-queue-recover', `queue-recover:${request.params.conversationId}`, (operationIdentity) =>
      operations.queueRecover({ params: request.params, operationIdentity }),
    );
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/queue/reorder', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationDispatchMutationRequest<QueueReorderInput> }>, reply) => {
    try {
      const parsed = parseConversationCommand(request, conversationDispatchCommandTypes.queueReorder);
      assertExactInputKeys(parsed.input, ['orderedSubmissionIds'], parsed.command.commandType);
      if (!Array.isArray(parsed.input.orderedSubmissionIds) || parsed.input.orderedSubmissionIds.some((id) => typeof id !== 'string')) {
        throw routeError('ZEUS_INVALID_NATIVE_QUEUE_REORDER', 'orderedSubmissionIds must be an array of submission ids.', 400);
      }
      const orderedSubmissionIds = [...parsed.input.orderedSubmissionIds] as string[];
      const executed = application.executeCore({
        parsed,
        destinationId: 'conversation-queue-application',
        resourceId: request.params.conversationId,
        mutateBusinessState: () => operations.queueReorder({ params: request.params, orderedSubmissionIds }),
      });
      afterCore(executed.replayed, 'queue_reorder', request.params, executed.result);
      return executed.result;
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  function parseConversationCommand<TInput extends object>(
    request: FastifyRequest<{ Params: ConversationParams; Body: ConversationDispatchMutationRequest<TInput> }>,
    commandType: Parameters<ConversationDispatchCommandApplication['parse']>[0]['commandType'],
  ) {
    return application.parse<TInput>({ value: request.body, commandType, scopeKind: 'product_conversation', scopeId: request.params.conversationId });
  }

  function parseSubmissionCommand<TInput extends object>(
    request: FastifyRequest<{ Params: SubmissionParams; Body: ConversationDispatchMutationRequest<TInput> }>,
    commandType: Parameters<ConversationDispatchCommandApplication['parse']>[0]['commandType'],
  ) {
    return application.parse<TInput>({ value: request.body, commandType, scopeKind: 'submission', scopeId: request.params.submissionId });
  }

  function parseTurnCommand<TInput extends object>(
    request: FastifyRequest<{ Params: TurnParams; Body: ConversationDispatchMutationRequest<TInput> }>,
    commandType: Parameters<ConversationDispatchCommandApplication['parse']>[0]['commandType'],
  ) {
    return application.parse<TInput>({ value: request.body, commandType, scopeKind: 'turn', scopeId: request.params.turnId });
  }

  function parseRequestCommand<TInput extends object>(
    request: FastifyRequest<{ Params: RequestParams; Body: ConversationDispatchMutationRequest<TInput> }>,
    commandType: Parameters<ConversationDispatchCommandApplication['parse']>[0]['commandType'],
  ) {
    return application.parse<TInput>({ value: request.body, commandType, scopeKind: 'approval', scopeId: request.params.requestId });
  }

  async function executeConversationExternal(
    request: FastifyRequest<{ Params: ConversationParams; Body: ConversationDispatchMutationRequest<EmptyInput> }>,
    reply: FastifyReply,
    commandType: Parameters<ConversationDispatchCommandApplication['parse']>[0]['commandType'],
    destinationId: string,
    externalOperationId: string,
    invoke: (operationIdentity: string) => Promise<unknown>,
  ) {
    try {
      const parsed = parseConversationCommand(request, commandType);
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const executed = await application.executeExternal({
        parsed,
        destinationId,
        resourceId: request.params.conversationId,
        externalOperationId: `${externalOperationId}:${parsed.operationIdentity}`,
        invoke: () => invoke(parsed.operationIdentity),
        isExplicitRejection: isExplicitRouteRejection,
      });
      return reply.code(202).send(executed.result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  }

  function afterCore(replayed: boolean, kind: Parameters<ConversationDispatchCommandRouteOperations['afterCoreAccepted']>[0]['kind'], params: ConversationParams, result: unknown): void {
    if (!replayed) operations.afterCoreAccepted({ kind, params, result });
  }

  function sendRouteError(reply: FastifyReply, error: unknown): unknown {
    const commandError = conversationDispatchCommandHttpError(error);
    if (commandError) return reply.code(commandError.statusCode).send(commandError.payload);
    if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { statusCode?: unknown }).statusCode === 'number') {
      return reply.code((error as { statusCode: number }).statusCode).send({ error: (error as { code: string }).code, message: error instanceof Error ? error.message : String(error) });
    }
    return options.sendNativeError(reply, error);
  }
}

function assertExactInputKeys(value: object, expected: readonly string[], commandType: string): void {
  const actual = Object.keys(value).sort();
  const normalized = [...expected].sort();
  if (actual.length === normalized.length && actual.every((key, index) => key === normalized[index])) return;
  throw routeError('ZEUS_CONVERSATION_DISPATCH_COMMAND_INVALID', `${commandType} input must contain exactly: ${normalized.join(', ')}.`, 400);
}

function assertOnlyInputKeys(value: object, allowed: readonly string[], commandType: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length === 0) return;
  throw routeError('ZEUS_CONVERSATION_DISPATCH_COMMAND_INVALID', `${commandType} input contains unsupported fields: ${unexpected.join(', ')}.`, 400);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw routeError('ZEUS_CONVERSATION_DISPATCH_COMMAND_INVALID', `${field} must be a non-empty string.`, 400);
  return value;
}

function routeError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function isExplicitRouteRejection(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && typeof (error as { statusCode?: unknown }).statusCode === 'number' && (error as { statusCode: number }).statusCode >= 400 && (error as { statusCode: number }).statusCode < 500;
}
