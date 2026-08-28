import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendNativeQueryRouteError } from './nativeQueryRouteError.js';
import type { ProjectGitQueryApplication } from './projectGitQueryApplication.js';

/** 只注册 Project Git 查询；Git mutation 仍由既有 Command 路由拥有。 */
export function registerProjectGitQueryRoutes(options: { server: FastifyInstance; application: ProjectGitQueryApplication }): void {
  options.server.get('/api/projects/:projectId/git/status', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return await options.application.readStatus(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/projects/:projectId/git/workbench', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return await options.application.readWorkbench(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/projects/:projectId/git/workbench/repositories/:repositoryId/commits/:commitHash', async (request: FastifyRequest<{ Params: { projectId: string; repositoryId: string; commitHash: string } }>, reply) => {
    try {
      return await options.application.readCommit(request.params.projectId, request.params.repositoryId, request.params.commitHash);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get(
    '/api/projects/:projectId/git/workbench/repositories/:repositoryId/compare',
    async (request: FastifyRequest<{ Params: { projectId: string; repositoryId: string }; Querystring: { ref?: string; mode?: string } }>, reply) => {
      try {
        return await options.application.readComparison(request.params.projectId, request.params.repositoryId, request.query.ref, request.query.mode);
      } catch (error) {
        return sendNativeQueryRouteError(reply, error);
      }
    },
  );

  options.server.get('/api/projects/:projectId/git/diff', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return await options.application.readDiff(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });
}
