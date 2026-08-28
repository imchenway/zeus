import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendNativeQueryRouteError } from './nativeQueryRouteError.js';
import type { ListWorkManagementTasksQuery, WorkManagementQueryApplication } from './workManagementQueryApplication.js';

/** 只注册工作管理查询；任务、看板与模板 mutation 仍由 Work Management Command 拥有。 */
export function registerWorkManagementQueryRoutes(options: { server: FastifyInstance; application: WorkManagementQueryApplication }): void {
  options.server.get('/api/projects/:projectId/task-board', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return options.application.readTaskBoard(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/tasks/:taskId', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    try {
      return options.application.readTask(request.params.taskId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/tasks/:taskId/events', async (request: FastifyRequest<{ Params: { taskId: string } }>) => options.application.listTaskEvents(request.params.taskId));

  options.server.get('/api/tasks', async (request: FastifyRequest<{ Querystring: ListWorkManagementTasksQuery }>, reply) => {
    try {
      return options.application.listTasks(request.query);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/tasks/archived', async (request: FastifyRequest<{ Querystring: { projectId?: string } }>, reply) => {
    try {
      return options.application.listArchivedTasks(request.query.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/task-templates', async (request: FastifyRequest<{ Querystring: { projectId?: string } }>) => options.application.listTaskTemplates(request.query.projectId));
}
