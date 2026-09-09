import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConversationStartCommandApplication, conversationStartCommandHttpError, conversationStartCommandTypes, type ConversationStartMutationRequest } from './conversationStartCommandApplication.js';
/** 会话首发的数据约束。 */
type ProjectParams = { projectId: string };
/** 会话首发的数据约束。 */
type TaskParams = { taskId: string };

/** 公开首发路由与未知结果禁止重发的约束。 */
export const conversationStartCommandRoutePolicy = {
  externalOperations: ['POST /api/projects/:projectId/conversations', 'POST /api/tasks/:taskId/conversations'],
  acceptedResult: 'immutable-artifact-ref',
  stableChildIdentity: 'command-operation-identity-derived',
  postWriteFailure: 'outcome_unknown_after_write',
  automaticRetryAfterUnknown: false,
} as const;

/** 会话首发的数据约束。 */
export interface ConversationStartRouteResponse {
  statusCode: number;
  body: unknown;
}

/** 会话首发的数据约束。 */
export interface ConversationStartCommandRouteOperations {
  prepareProjectConversation(input: { projectId: string; value: Record<string, unknown>; operationIdentity: string }): Promise<unknown>;

  startProjectConversation(input: { prepared: unknown; value: Record<string, unknown>; operationIdentity: string; markExternalWriteStarted(): void }): Promise<ConversationStartRouteResponse>;
  prepareTaskConversation(input: { taskId: string; value: Record<string, unknown>; operationIdentity: string }): Promise<unknown>;

  startTaskConversation(input: { prepared: unknown; value: Record<string, unknown>; operationIdentity: string; markExternalWriteStarted(): void }): Promise<ConversationStartRouteResponse>;
  isExplicitRejection(error: unknown): boolean;
}

/** 注册项目与任务两条会话首发命令，复用持久回执避免重复发送。 */
export function registerConversationStartCommandRoutes(options: {
  server: FastifyInstance;
  application: ConversationStartCommandApplication;
  operations: ConversationStartCommandRouteOperations;
  sendNativeError(reply: FastifyReply, error: unknown): unknown;
}): void {
  const { server, application, operations } = options;

  server.post('/api/projects/:projectId/conversations', async (request: FastifyRequest<{ Params: ProjectParams; Body: ConversationStartMutationRequest<Record<string, unknown>> }>, reply) => {
    try {
      const parsed = application.parse<Record<string, unknown>>({
        value: request.body,
        commandType: conversationStartCommandTypes.projectConversationCreate,
        scopeKind: 'project',
        scopeId: request.params.projectId,
      });
      assertOnlyInputKeys(
        parsed.input,
        [
          'agentKind',
          'attachments',
          'clientUserMessageId',
          'collaborationMode',
          'computerUseRequested',
          'content',
          'displayText',
          'effort',
          'expertMentions',
          'goalObjective',
          'mode',
          'model',
          'permissionMode',
          'pluginReferences',
          'serviceTier',
          'skillReferences',
        ],
        parsed.command.commandType,
      );
      let prepared: unknown;
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'project-conversation-create',
        resourceId: request.params.projectId,
        externalOperationId: externalOperationId(parsed.command.commandType, request.params.projectId, parsed.operationIdentity),
        beforeWrite: async () => {
          prepared = await operations.prepareProjectConversation({ projectId: request.params.projectId, value: parsed.input, operationIdentity: parsed.operationIdentity });
        },
        invoke: (markExternalWriteStarted) =>
          operations.startProjectConversation({
            prepared: requirePrepared(prepared),
            value: parsed.input,
            operationIdentity: parsed.operationIdentity,
            markExternalWriteStarted,
          }),
        isExplicitRejection: operations.isExplicitRejection,
      });
      return reply.code(executed.result.statusCode).send(executed.result.body);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/tasks/:taskId/conversations', async (request: FastifyRequest<{ Params: TaskParams; Body: ConversationStartMutationRequest<Record<string, unknown>> }>, reply) => {
    try {
      const parsed = application.parse<Record<string, unknown>>({
        value: request.body,
        commandType: conversationStartCommandTypes.taskConversationCreate,
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
          'computerUseRequested',
          'conflictContent',
          'conflictPath',
          'content',
          'conversationId',
          'displayText',
          'effort',
          'expertMentions',
          'goalObjective',
          'inheritConversationId',
          'integrationId',
          'messageIds',
          'mode',
          'model',
          'permissionMode',
          'pluginReferences',
          'serviceTier',
          'skillId',
          'skillReferences',
          'source',
          'sourceConversationId',
          'stageId',
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
        invoke: (markExternalWriteStarted) =>
          operations.startTaskConversation({
            prepared: requirePrepared(prepared),
            value: parsed.input,
            operationIdentity: parsed.operationIdentity,
            markExternalWriteStarted,
          }),
        isExplicitRejection: operations.isExplicitRejection,
      });
      return reply.code(executed.result.statusCode).send(executed.result.body);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  /** 统一转换会话首发路由错误。 */
  function sendRouteError(reply: FastifyReply, error: unknown): unknown {
    const mapped = conversationStartCommandHttpError(error);
    if (mapped) return reply.code(mapped.statusCode).send(mapped.payload);
    if (isExplicitRouteRejection(error)) return reply.code(error.statusCode).send(error.payload);
    return options.sendNativeError(reply, error);
  }
}

/** 会话首发的数据约束。 */
export interface ConversationStartExplicitRejection extends Error {
  conversationStartExplicitRejection: true;
  statusCode: number;
  payload: { error: string; message: string };
}

/** 以明确错误终止首发操作。 */
export function conversationStartReject(statusCode: number, code: string, message: string): never {
  throw Object.assign(new Error(message), {
    conversationStartExplicitRejection: true as const,
    statusCode,
    payload: { error: code, message },
  }) satisfies ConversationStartExplicitRejection;
}

/** 判断首发操作是否已被明确拒绝。 */
export function isExplicitConversationStartRejection(error: unknown): error is ConversationStartExplicitRejection {
  return isExplicitRouteRejection(error);
}

/** 识别携带明确拒绝标记的路由错误。 */
function isExplicitRouteRejection(error: unknown): error is ConversationStartExplicitRejection {
  return Boolean(error) && typeof error === 'object' && (error as { conversationStartExplicitRejection?: unknown }).conversationStartExplicitRejection === true;
}

/** 派生稳定的首发外部操作身份。 */
function externalOperationId(commandType: string, resourceId: string, operationIdentity: string): string {
  return `${commandType}:${resourceId}:${operationIdentity}`;
}

/** 要求只读预检完成后再执行首发。 */
function requirePrepared(value: unknown): unknown {
  if (value === undefined) conversationStartReject(500, 'ZEUS_CONVERSATION_START_PREPARE_MISSING', '会话首发缺少必要的预检结果。');
  return value;
}

/** 拒绝首发入口未声明的输入字段。 */
function assertOnlyInputKeys(value: object, allowed: readonly string[], commandType: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length === 0) return;
  conversationStartReject(400, 'ZEUS_CONVERSATION_START_COMMAND_INVALID', `${commandType} input contains unsupported fields: ${unexpected.join(', ')}.`);
}
