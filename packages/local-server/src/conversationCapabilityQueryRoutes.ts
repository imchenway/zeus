import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ConversationCapabilityQueryApplication } from './conversationCapabilityQueryApplication.js';
import { sendNativeQueryRouteError } from './nativeQueryRouteError.js';

/** 只注册会话与任务推送能力查询；创建会话、刷新仓库和 Provider 启动仍由命令路径拥有。 */
export function registerConversationCapabilityQueryRoutes(options: { server: FastifyInstance; application: ConversationCapabilityQueryApplication }): void {
  options.server.get('/api/digital-employee-capabilities', async (_request, reply) => {
    try {
      return await options.application.readDigitalEmployee();
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/projects/:projectId/codex-task-push-capabilities', async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { taskId?: string } }>, reply) => {
    try {
      return await options.application.readTaskPush(request.params.projectId, request.query.taskId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/projects/:projectId/codex-conversation-capabilities', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return await options.application.readConversation(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });
}
