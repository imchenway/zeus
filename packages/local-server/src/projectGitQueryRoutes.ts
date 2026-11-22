import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendNativeQueryRouteError } from './nativeQueryRouteError.js';
import type { ProjectGitQueryApplication } from './projectGitQueryApplication.js';

/** 工作台按完整仓库 ID 查询；会话子仓 ID 可长于路由路径参数。 */
export const gitWorkbenchRepositoryRouteOptions = {
  schema: {
    querystring: { type: 'object', properties: { repositoryId: { type: 'string', minLength: 1 } }, required: ['repositoryId'] },
  },
};

/** 只注册 Project Git 查询；Git mutation 仍由既有 Command 路由拥有。 */
export function registerProjectGitQueryRoutes(options: { server: FastifyInstance; application: ProjectGitQueryApplication }): void {
  options.server.get('/api/projects/:projectId/git/status', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return await options.application.readStatus(request.params.projectId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/projects/:projectId/git/workbench', async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { conversationId?: string; includePatches?: string } }>, reply) => {
    try {
      return await options.application.readWorkbench(request.params.projectId, request.query.conversationId, request.query.includePatches !== 'false');
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get(
    '/api/projects/:projectId/git/workbench/repositories/commits/:commitHash',
    gitWorkbenchRepositoryRouteOptions,
    async (request: FastifyRequest<{ Params: { projectId: string; commitHash: string }; Querystring: { repositoryId: string } }>, reply) => {
      try {
        return await options.application.readCommit(request.params.projectId, request.query.repositoryId, request.params.commitHash);
      } catch (error) {
        return sendNativeQueryRouteError(reply, error);
      }
    },
  );

  options.server.get(
    '/api/projects/:projectId/git/workbench/repositories/compare',
    gitWorkbenchRepositoryRouteOptions,
    async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { repositoryId: string; ref?: string; mode?: string; path?: string; summaryOnly?: string } }>, reply) => {
      try {
        return await options.application.readComparison(request.params.projectId, request.query.repositoryId, request.query.ref, request.query.mode, request.query.path, request.query.summaryOnly === 'true');
      } catch (error) {
        return sendNativeQueryRouteError(reply, error);
      }
    },
  );

  options.server.get(
    '/api/projects/:projectId/git/workbench/repositories/history',
    gitWorkbenchRepositoryRouteOptions,
    async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { repositoryId: string; offset?: string; ref?: string } }>, reply) => {
      try {
        return await options.application.readHistory(request.params.projectId, request.query.repositoryId, Number(request.query.offset ?? 0), request.query.ref);
      } catch (error) {
        return sendNativeQueryRouteError(reply, error);
      }
    },
  );

  /** 推送范围是本地只读查询，不能隐式执行 fetch 或 push。 */
  options.server.get(
    '/api/projects/:projectId/git/workbench/repositories/push-preview',
    gitWorkbenchRepositoryRouteOptions,
    async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { repositoryId: string; sourceBranch?: string; remote?: string; targetBranch?: string; offset?: string } }>, reply) => {
      try {
        return await options.application.readPushPreview(request.params.projectId, request.query.repositoryId, {
          sourceBranch: request.query.sourceBranch ?? '',
          remote: request.query.remote ?? '',
          targetBranch: request.query.targetBranch ?? '',
          offset: Number(request.query.offset ?? 0),
        });
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
