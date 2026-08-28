import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendNativeQueryRouteError } from './nativeQueryRouteError.js';
import type { ProjectQueryApplication } from './projectQueryApplication.js';

/** 只注册 Project 查询；配置更新、扫描和项目生命周期仍由显式 Command 路径拥有。 */
export function registerProjectQueryRoutes(options: { server: FastifyInstance; application: ProjectQueryApplication }): void {
  options.server.get('/api/projects', async (request: FastifyRequest<{ Querystring: { query?: string } }>) => options.application.search(request.query.query));

  options.server.get('/api/projects/archived', async () => options.application.listArchived());

  options.server.get('/api/projects/:projectId', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return options.application.readProject(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/projects/:projectId/config', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return options.application.readConfig(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/projects/:projectId/scan-status', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return options.application.readScanStatus(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/projects/:projectId/overview', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return await options.application.readOverview(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/projects/:projectId/workspace-config', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return options.application.readWorkspaceConfig(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });
}
