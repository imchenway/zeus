import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CodeIntelligenceQueryApplication, CodeIntelligenceQueryError } from './codeIntelligenceQueryApplication.js';

type SearchQuery = { query?: string; nodeType?: string; edgeType?: string; minConfidence?: string };

export function registerCodeIntelligenceQueryRoutes(options: { server: FastifyInstance; application: CodeIntelligenceQueryApplication }): void {
  const execute = async (reply: FastifyReply, query: () => unknown | Promise<unknown>): Promise<unknown> => {
    try {
      return await query();
    } catch (error) {
      if (error instanceof CodeIntelligenceQueryError) return reply.code(error.statusCode).send(error.payload);
      throw error;
    }
  };

  options.server.get('/api/graph/edges/:edgeId', async (request: FastifyRequest<{ Params: { edgeId: string } }>, reply) => execute(reply, () => options.application.readEdge(request.params.edgeId)));
  options.server.get('/api/graph/nodes/:nodeId/neighborhood', async (request: FastifyRequest<{ Params: { nodeId: string }; Querystring: { depth?: string } }>, reply) =>
    execute(reply, () => options.application.readNeighborhood(request.params.nodeId, request.query.depth)),
  );
  options.server.get('/api/graph/search', async (request: FastifyRequest<{ Querystring: SearchQuery }>, reply) => execute(reply, () => options.application.search(request.query)));
  options.server.get('/api/projects/:projectId/graph/search', async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: SearchQuery }>, reply) =>
    execute(reply, () => options.application.search(request.query, request.params.projectId)),
  );
  options.server.get('/api/projects/:projectId/graph/views', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => execute(reply, () => options.application.listProjectViews(request.params.projectId)));
  options.server.get('/api/projects/:projectId/graph/views/:viewId', async (request: FastifyRequest<{ Params: { projectId: string; viewId: string } }>, reply) =>
    execute(reply, () => options.application.readProjectView(request.params.projectId, request.params.viewId)),
  );
  options.server.get('/api/projects/:projectId/graph/nodes/:nodeId', async (request: FastifyRequest<{ Params: { projectId: string; nodeId: string } }>, reply) =>
    execute(reply, () => options.application.readProjectNode(request.params.projectId, request.params.nodeId)),
  );
  options.server.get('/api/projects/:projectId/graph/nodes/:nodeId/neighborhood', async (request: FastifyRequest<{ Params: { projectId: string; nodeId: string }; Querystring: { depth?: string } }>, reply) =>
    execute(reply, () => options.application.readNeighborhood(request.params.nodeId, request.query.depth, request.params.projectId)),
  );
  options.server.get('/api/graph/views/:viewType', async (request: FastifyRequest<{ Params: { viewType: string } }>, reply) => execute(reply, () => options.application.readGlobalView(request.params.viewType)));
  options.server.get('/api/projects/:projectId/apis', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) =>
    execute(reply, () => options.application.listSemanticNodes(request.params.projectId, 'api_sequence', ['api'])),
  );
  options.server.get('/api/projects/:projectId/apis/:apiId', async (request: FastifyRequest<{ Params: { projectId: string; apiId: string } }>, reply) =>
    execute(reply, () => options.application.readSemanticNode(request.params.projectId, request.params.apiId, ['api'])),
  );
  options.server.get('/api/projects/:projectId/apis/:apiId/sequence', async (request: FastifyRequest<{ Params: { projectId: string; apiId: string } }>, reply) =>
    execute(reply, () => options.application.readFocusedSemanticView(request.params.projectId, request.params.apiId, ['api'], 'api_sequence')),
  );
  options.server.get('/api/projects/:projectId/modules', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) =>
    execute(reply, () => options.application.listSemanticNodes(request.params.projectId, 'module', ['file', 'package'])),
  );
  options.server.get('/api/projects/:projectId/modules/:moduleId', async (request: FastifyRequest<{ Params: { projectId: string; moduleId: string } }>, reply) =>
    execute(reply, () => options.application.readSemanticNode(request.params.projectId, request.params.moduleId, ['file', 'package'])),
  );
  options.server.get('/api/projects/:projectId/modules/:moduleId/flow', async (request: FastifyRequest<{ Params: { projectId: string; moduleId: string } }>, reply) =>
    execute(reply, () => options.application.readFocusedSemanticView(request.params.projectId, request.params.moduleId, ['file', 'package'], 'module_flow')),
  );
  options.server.get('/api/projects/:projectId/tables', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => execute(reply, () => options.application.listSemanticNodes(request.params.projectId, 'table', ['table'])));
  options.server.get('/api/projects/:projectId/tables/columns/search', async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { query?: string } }>, reply) =>
    execute(reply, () => options.application.searchTableFields(request.params.projectId, request.query.query ?? '')),
  );
  options.server.get('/api/projects/:projectId/tables/:tableId', async (request: FastifyRequest<{ Params: { projectId: string; tableId: string } }>, reply) =>
    execute(reply, () => options.application.readSemanticNode(request.params.projectId, request.params.tableId, ['table'])),
  );
  options.server.get('/api/projects/:projectId/tables/:tableId/impact', async (request: FastifyRequest<{ Params: { projectId: string; tableId: string } }>, reply) =>
    execute(reply, () => options.application.readFocusedSemanticView(request.params.projectId, request.params.tableId, ['table'], 'method_logic')),
  );
  options.server.get('/api/projects/:projectId/methods/:methodId/logic', async (request: FastifyRequest<{ Params: { projectId: string; methodId: string } }>, reply) =>
    execute(reply, () => options.application.readFocusedSemanticView(request.params.projectId, request.params.methodId, ['function'], 'method_logic')),
  );
}
