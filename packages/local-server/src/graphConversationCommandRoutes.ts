import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GraphConversationCommandApplication, graphConversationCommandHttpError, graphConversationCommandTypes, type GraphConversationMutationRequest } from './graphConversationCommandApplication.js';

type EmptyInput = Record<string, never>;
type ProjectParams = { projectId: string };
type TaskParams = { taskId: string };

export const currentGraphCommandScopeId = 'current-project-root';

export const graphConversationCommandRoutePolicy = {
  externalOperations: [
    'POST /api/projects/:projectId/conversations',
    'POST /api/tasks/:taskId/conversations',
    'POST /api/projects/:projectId/scan',
    'POST /api/projects/:projectId/graph/views/generate',
    'POST /api/projects/:projectId/ask',
    'POST /api/graph/scan-current',
  ],
  acceptedResult: 'immutable-artifact-ref',
  stableChildIdentity: 'command-operation-identity-derived',
  postWriteFailure: 'outcome_unknown_after_write',
  automaticRetryAfterUnknown: false,
} as const;

export interface GraphConversationRouteResponse {
  statusCode: number;
  body: unknown;
}

export interface GraphConversationCommandRouteOperations {
  prepareProjectConversation(input: { projectId: string; value: Record<string, unknown>; operationIdentity: string }): Promise<unknown>;
  startProjectConversation(input: { prepared: unknown; value: Record<string, unknown>; operationIdentity: string }): Promise<GraphConversationRouteResponse>;
  prepareTaskConversation(input: { taskId: string; value: Record<string, unknown>; operationIdentity: string }): Promise<unknown>;
  startTaskConversation(input: { prepared: unknown; value: Record<string, unknown>; operationIdentity: string }): Promise<GraphConversationRouteResponse>;
  prepareProjectScan(input: { projectId: string; operationIdentity: string; commandType: typeof graphConversationCommandTypes.projectGraphScan | typeof graphConversationCommandTypes.projectGraphViewsGenerate }): Promise<unknown>;
  runProjectScan(input: { prepared: unknown; operationIdentity: string; commandType: typeof graphConversationCommandTypes.projectGraphScan | typeof graphConversationCommandTypes.projectGraphViewsGenerate }): Promise<unknown>;
  commitProjectScanAccepted(input: { prepared: unknown; result: unknown }): void;
  commitProjectScanFailure(input: { prepared: unknown; outcome: 'failed_before_write' | 'explicitly_rejected' | 'outcome_unknown_after_write'; error: unknown }): void;
  releaseProjectScan(input: { prepared: unknown; operationIdentity: string }): void;
  prepareGraphAsk(input: { projectId: string; question: string; operationIdentity: string }): Promise<unknown>;
  askGraph(input: { prepared: unknown; question: string; operationIdentity: string }): Promise<unknown>;
  prepareCurrentScan(input: { operationIdentity: string }): Promise<unknown>;
  runCurrentScan(input: { prepared: unknown; operationIdentity: string }): Promise<unknown>;
  releaseCurrentScan(input: { prepared: unknown; operationIdentity: string }): void;
  isExplicitRejection(error: unknown): boolean;
}

/** 只注册会话首发与图谱扫描/问答六个公开 mutation；读取接口继续由组合根持有。 */
export function registerGraphConversationCommandRoutes(options: {
  server: FastifyInstance;
  application: GraphConversationCommandApplication;
  operations: GraphConversationCommandRouteOperations;
  sendNativeError(reply: FastifyReply, error: unknown): unknown;
}): void {
  const { server, application, operations } = options;

  server.post('/api/projects/:projectId/conversations', async (request: FastifyRequest<{ Params: ProjectParams; Body: GraphConversationMutationRequest<Record<string, unknown>> }>, reply) => {
    try {
      const parsed = application.parse<Record<string, unknown>>({
        value: request.body,
        commandType: graphConversationCommandTypes.projectConversationCreate,
        scopeKind: 'project',
        scopeId: request.params.projectId,
      });
      assertOnlyInputKeys(parsed.input, ['agentKind', 'attachments', 'clientUserMessageId', 'collaborationMode', 'content', 'effort', 'goalObjective', 'mode', 'model', 'permissionMode', 'serviceTier'], parsed.command.commandType);
      let prepared: unknown;
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'project-conversation-create',
        resourceId: request.params.projectId,
        externalOperationId: externalOperationId(parsed.command.commandType, request.params.projectId, parsed.operationIdentity),
        beforeWrite: async () => {
          prepared = await operations.prepareProjectConversation({ projectId: request.params.projectId, value: parsed.input, operationIdentity: parsed.operationIdentity });
        },
        invoke: () => operations.startProjectConversation({ prepared: requirePrepared(prepared), value: parsed.input, operationIdentity: parsed.operationIdentity }),
        isExplicitRejection: operations.isExplicitRejection,
      });
      return reply.code(executed.result.statusCode).send(executed.result.body);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/tasks/:taskId/conversations', async (request: FastifyRequest<{ Params: TaskParams; Body: GraphConversationMutationRequest<Record<string, unknown>> }>, reply) => {
    try {
      const parsed = application.parse<Record<string, unknown>>({
        value: request.body,
        commandType: graphConversationCommandTypes.taskConversationCreate,
        scopeKind: 'task',
        scopeId: request.params.taskId,
      });
      assertOnlyInputKeys(
        parsed.input,
        [
          'agentKind',
          'attachments',
          'clientUserMessageId',
          'collaborationMode',
          'conflictContent',
          'conflictPath',
          'content',
          'conversationId',
          'effort',
          'goalObjective',
          'inheritConversationId',
          'integrationId',
          'messageIds',
          'mode',
          'model',
          'permissionMode',
          'serviceTier',
          'source',
          'sourceConversationId',
          'supplementalAttachments',
          'supplementalInfo',
          'taskContext',
          'workMode',
          'workspace',
        ],
        parsed.command.commandType,
      );
      let prepared: unknown;
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'task-conversation-create',
        resourceId: request.params.taskId,
        externalOperationId: externalOperationId(parsed.command.commandType, request.params.taskId, parsed.operationIdentity),
        beforeWrite: async () => {
          prepared = await operations.prepareTaskConversation({ taskId: request.params.taskId, value: parsed.input, operationIdentity: parsed.operationIdentity });
        },
        invoke: () => operations.startTaskConversation({ prepared: requirePrepared(prepared), value: parsed.input, operationIdentity: parsed.operationIdentity }),
        isExplicitRejection: operations.isExplicitRejection,
      });
      return reply.code(executed.result.statusCode).send(executed.result.body);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/scan', async (request: FastifyRequest<{ Params: ProjectParams; Body: GraphConversationMutationRequest<EmptyInput> }>, reply) =>
    executeProjectScan(request, reply, graphConversationCommandTypes.projectGraphScan),
  );

  server.post('/api/projects/:projectId/graph/views/generate', async (request: FastifyRequest<{ Params: ProjectParams; Body: GraphConversationMutationRequest<EmptyInput> }>, reply) =>
    executeProjectScan(request, reply, graphConversationCommandTypes.projectGraphViewsGenerate),
  );

  server.post('/api/projects/:projectId/ask', async (request: FastifyRequest<{ Params: ProjectParams; Body: GraphConversationMutationRequest<{ question?: unknown }> }>, reply) => {
    try {
      const parsed = application.parse<{ question?: unknown }>({
        value: request.body,
        commandType: graphConversationCommandTypes.projectGraphAsk,
        scopeKind: 'project',
        scopeId: request.params.projectId,
      });
      assertExactInputKeys(parsed.input, ['question'], parsed.command.commandType);
      const question = requiredBoundedString(parsed.input.question, 'question', 100_000);
      let prepared: unknown;
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'project-graph-question-provider',
        resourceId: request.params.projectId,
        externalOperationId: externalOperationId(parsed.command.commandType, request.params.projectId, parsed.operationIdentity),
        beforeWrite: async () => {
          prepared = await operations.prepareGraphAsk({ projectId: request.params.projectId, question, operationIdentity: parsed.operationIdentity });
        },
        invoke: () => operations.askGraph({ prepared: requirePrepared(prepared), question, operationIdentity: parsed.operationIdentity }),
        isExplicitRejection: operations.isExplicitRejection,
      });
      return executed.result;
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/graph/scan-current', async (request: FastifyRequest<{ Body: GraphConversationMutationRequest<EmptyInput> }>, reply) => {
    let prepared: unknown;
    let operationIdentity: string | null = null;
    try {
      const parsed = application.parse<EmptyInput>({
        value: request.body,
        commandType: graphConversationCommandTypes.currentGraphScan,
        scopeKind: 'project',
        scopeId: currentGraphCommandScopeId,
      });
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      operationIdentity = parsed.operationIdentity;
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'current-project-graph-scan-worker',
        resourceId: currentGraphCommandScopeId,
        externalOperationId: externalOperationId(parsed.command.commandType, currentGraphCommandScopeId, parsed.operationIdentity),
        beforeWrite: async () => {
          prepared = await operations.prepareCurrentScan({ operationIdentity: parsed.operationIdentity });
        },
        invoke: () => operations.runCurrentScan({ prepared: requirePrepared(prepared), operationIdentity: parsed.operationIdentity }),
        isExplicitRejection: operations.isExplicitRejection,
      });
      return executed.result;
    } catch (error) {
      return sendRouteError(reply, error);
    } finally {
      if (prepared !== undefined && operationIdentity) operations.releaseCurrentScan({ prepared, operationIdentity });
    }
  });

  async function executeProjectScan(
    request: FastifyRequest<{ Params: ProjectParams; Body: GraphConversationMutationRequest<EmptyInput> }>,
    reply: FastifyReply,
    commandType: typeof graphConversationCommandTypes.projectGraphScan | typeof graphConversationCommandTypes.projectGraphViewsGenerate,
  ): Promise<unknown> {
    let prepared: unknown;
    let operationIdentity: string | null = null;
    try {
      const parsed = application.parse<EmptyInput>({ value: request.body, commandType, scopeKind: 'project', scopeId: request.params.projectId });
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      operationIdentity = parsed.operationIdentity;
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'project-graph-scan-worker',
        resourceId: request.params.projectId,
        externalOperationId: externalOperationId(parsed.command.commandType, request.params.projectId, parsed.operationIdentity),
        beforeWrite: async () => {
          prepared = await operations.prepareProjectScan({ projectId: request.params.projectId, operationIdentity: parsed.operationIdentity, commandType });
        },
        invoke: () => operations.runProjectScan({ prepared: requirePrepared(prepared), operationIdentity: parsed.operationIdentity, commandType }),
        mutateAcceptedBusinessState: (result) => operations.commitProjectScanAccepted({ prepared: requirePrepared(prepared), result }),
        mutateFailureBusinessState: (outcome, error) => {
          if (prepared !== undefined) operations.commitProjectScanFailure({ prepared, outcome, error });
        },
        isExplicitRejection: operations.isExplicitRejection,
      });
      return executed.result;
    } catch (error) {
      return sendRouteError(reply, error);
    } finally {
      if (prepared !== undefined && operationIdentity) operations.releaseProjectScan({ prepared, operationIdentity });
    }
  }

  function sendRouteError(reply: FastifyReply, error: unknown): unknown {
    const mapped = graphConversationCommandHttpError(error);
    if (mapped) return reply.code(mapped.statusCode).send(mapped.payload);
    if (isExplicitRouteRejection(error)) return reply.code(error.statusCode).send(error.payload);
    return options.sendNativeError(reply, error);
  }
}

export interface GraphConversationExplicitRejection extends Error {
  graphConversationExplicitRejection: true;
  statusCode: number;
  payload: { error: string; message: string };
}

export function graphConversationReject(statusCode: number, code: string, message: string): never {
  throw Object.assign(new Error(message), {
    graphConversationExplicitRejection: true as const,
    statusCode,
    payload: { error: code, message },
  }) satisfies GraphConversationExplicitRejection;
}

export function isExplicitGraphConversationRejection(error: unknown): error is GraphConversationExplicitRejection {
  return isExplicitRouteRejection(error);
}

function isExplicitRouteRejection(error: unknown): error is GraphConversationExplicitRejection {
  return Boolean(error) && typeof error === 'object' && (error as { graphConversationExplicitRejection?: unknown }).graphConversationExplicitRejection === true;
}

function externalOperationId(commandType: string, resourceId: string, operationIdentity: string): string {
  return `${commandType}:${resourceId}:${operationIdentity}`;
}

function requirePrepared(value: unknown): unknown {
  if (value === undefined) graphConversationReject(500, 'ZEUS_GRAPH_CONVERSATION_PREPARE_MISSING', 'Graph/Conversation command preparation is missing.');
  return value;
}

function assertOnlyInputKeys(value: object, allowed: readonly string[], commandType: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length === 0) return;
  graphConversationReject(400, 'ZEUS_GRAPH_CONVERSATION_COMMAND_INVALID', `${commandType} input contains unsupported fields: ${unexpected.join(', ')}.`);
}

function assertExactInputKeys(value: object, expected: readonly string[], commandType: string): void {
  const actual = Object.keys(value).sort();
  const normalized = [...expected].sort();
  if (actual.length === normalized.length && actual.every((key, index) => key === normalized[index])) return;
  graphConversationReject(400, 'ZEUS_GRAPH_CONVERSATION_COMMAND_INVALID', `${commandType} input must contain exactly: ${normalized.join(', ')}.`);
}

function requiredBoundedString(value: unknown, field: string, maximumCharacters: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumCharacters) {
    graphConversationReject(400, 'ZEUS_GRAPH_CONVERSATION_COMMAND_INVALID', `${field} must be a non-empty string no longer than ${maximumCharacters} characters.`);
  }
  return value.trim();
}
