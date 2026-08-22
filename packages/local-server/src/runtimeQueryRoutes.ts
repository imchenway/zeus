import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendNativeQueryRouteError } from './nativeQueryRouteError.js';
import type { ListRuntimeLogsQuery, ListRuntimeSessionsQuery, ListTerminalEventsQuery, RuntimeQueryApplication } from './runtimeQueryApplication.js';

/** 只注册 Runtime 查询；启动、输入、停止、归档与设置更新仍由显式 Command 路径拥有。 */
export function registerRuntimeQueryRoutes(options: { server: FastifyInstance; application: RuntimeQueryApplication }): void {
  options.server.get('/api/runtime/adapters', async () => options.application.listAdapters());

  options.server.get('/api/runtime/adapters/:adapter/check', async (request: FastifyRequest<{ Params: { adapter: string } }>, reply) => {
    try {
      return await options.application.checkAdapter(request.params.adapter);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/runtime/settings', async () => options.application.readSettings());

  options.server.get('/api/runtime/sessions', async (request: FastifyRequest<{ Querystring: ListRuntimeSessionsQuery }>) => options.application.listSessions(request.query));

  options.server.get('/api/runtime/sessions/:sessionId', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
    try {
      return options.application.readSession(request.params.sessionId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/runtime/sessions/:sessionId/logs', async (request: FastifyRequest<{ Params: { sessionId: string }; Querystring: ListRuntimeLogsQuery }>, reply) => {
    try {
      return options.application.readLogs(request.params.sessionId, request.query);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/runtime/sessions/:sessionId/terminal', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
    try {
      return options.application.readTerminal(request.params.sessionId);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });

  options.server.get('/api/runtime/sessions/:sessionId/terminal/events', async (request: FastifyRequest<{ Params: { sessionId: string }; Querystring: ListTerminalEventsQuery }>, reply) => {
    try {
      return options.application.readTerminalEvents(request.params.sessionId, request.query);
    } catch (error) {
      return sendNativeQueryRouteError(reply, error);
    }
  });
}
