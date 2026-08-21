import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CodexSubagentQueryApplication } from './codexSubagentQueryApplication.js';

/** 只注册 Codex 子智能体查询；Provider 未就绪时保持 409，不以 GET 启动运行时。 */
export function registerCodexSubagentQueryRoutes(options: { server: FastifyInstance; application: CodexSubagentQueryApplication }): void {
  options.server.get('/api/projects/:projectId/conversations/:conversationId/subagents', async (request: FastifyRequest<{ Params: { projectId: string; conversationId: string } }>, reply) => {
    try {
      return await options.application.list(request.params.projectId, request.params.conversationId);
    } catch (error) {
      const code = errorCode(error);
      const statusCode = code === 'ZEUS_CONVERSATION_NOT_FOUND' ? 404 : 409;
      return reply.code(statusCode).send({ error: code ?? 'ZEUS_CODEX_SUBAGENTS_READ_FAILED', message: error instanceof Error ? error.message : 'Failed to read Codex subagents.' });
    }
  });

  options.server.get('/api/projects/:projectId/conversations/:conversationId/subagents/:threadId', async (request: FastifyRequest<{ Params: { projectId: string; conversationId: string; threadId: string } }>, reply) => {
    try {
      return await options.application.read(request.params.projectId, request.params.conversationId, request.params.threadId);
    } catch (error) {
      const code = errorCode(error);
      const statusCode = code === 'ZEUS_CONVERSATION_NOT_FOUND' || code === 'ZEUS_CODEX_SUBAGENT_NOT_FOUND' ? 404 : 409;
      return reply.code(statusCode).send({ error: code ?? 'ZEUS_CODEX_SUBAGENT_THREAD_READ_FAILED', message: error instanceof Error ? error.message : 'Failed to read Codex subagent thread.' });
    }
  });
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof (error as Error & { code?: unknown }).code === 'string' ? ((error as Error & { code: string }).code ?? null) : null;
}
