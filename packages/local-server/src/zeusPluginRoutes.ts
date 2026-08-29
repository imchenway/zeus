import { PluginStoreError, type PluginApprovalMode, type PluginScope } from '@zeus/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZeusPluginServiceError, type ZeusPluginInstallSource, type ZeusPluginService } from './zeusPluginService.js';
import { ZeusPluginSourceError, type ZeusPluginDirectSource } from './zeusPluginSource.js';
import type { ZeusConversationPluginRuntime } from './zeusConversationPluginRuntime.js';

export function registerZeusPluginRoutes(options: { server: FastifyInstance; plugins?: ZeusPluginService; runtime?: ZeusConversationPluginRuntime; dangerouslyBypassHookTrust?: boolean; hasProject(projectId: string): boolean }): void {
  const { server } = options;

  server.get('/api/plugins', async (request: FastifyRequest<{ Querystring: { projectId?: string } }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      return { plugins: await options.plugins.list({ projectId: optionalProjectId(request.query.projectId, options.hasProject) }) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.get('/api/plugin-skills', async (request: FastifyRequest<{ Querystring: { projectId?: string } }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      return { skills: await options.plugins.listSkills({ projectId: optionalProjectId(request.query.projectId, options.hasProject) }) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.get('/api/plugin-runtime-status', async () => ({
    available: Boolean(options.plugins),
    dangerouslyBypassHookTrust: options.dangerouslyBypassHookTrust === true,
  }));

  server.post(
    '/api/conversations/:conversationId/plugin-app-tools/:pluginId/:serverId/:toolName',
    async (request: FastifyRequest<{ Params: { conversationId: string; pluginId: string; serverId: string; toolName: string }; Body: unknown }>, reply) => {
      if (!options.runtime) return unavailable(reply);
      try {
        const body = recordBody(request.body);
        exactKeys(body, ['arguments']);
        const args = body.arguments === undefined ? {} : recordValue(body.arguments, 'arguments');
        if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 1024 * 1024) throw new ZeusPluginServiceError('ZEUS_PLUGIN_MCP_APP_ARGUMENTS_TOO_LARGE', 'MCP App 工具参数不得超过 1 MiB。', 413);
        return await options.runtime.invokeAppMcp({
          conversationId: identity(request.params.conversationId, 'conversationId'),
          pluginId: identity(request.params.pluginId, 'pluginId'),
          serverId: identity(request.params.serverId, 'serverId'),
          toolName: identity(request.params.toolName, 'toolName'),
          args,
        });
      } catch (error) {
        return sendPluginError(reply, error);
      }
    },
  );

  server.post('/api/plugins/install', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      const body = recordBody(request.body);
      exactKeys(body, ['scope', 'projectId', 'source']);
      const scope = pluginScope(body.scope);
      const projectId = scope === 'project' ? requiredProjectId(body.projectId, options.hasProject) : null;
      return await options.plugins.install({ scope, projectId, source: installSource(body.source) });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.post('/api/plugins/:pluginId/update', async (request: FastifyRequest<{ Params: { pluginId: string } }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      return await options.plugins.update({ pluginId: identity(request.params.pluginId, 'pluginId') });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.patch('/api/plugins/:pluginId/enabled', async (request: FastifyRequest<{ Params: { pluginId: string }; Body: unknown }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      const body = recordBody(request.body);
      exactKeys(body, ['enabled', 'expectedRevision']);
      return await options.plugins.setEnabled({
        pluginId: identity(request.params.pluginId, 'pluginId'),
        enabled: booleanValue(body.enabled, 'enabled'),
        ...(body.expectedRevision === undefined ? {} : { expectedRevision: nonNegativeInteger(body.expectedRevision, 'expectedRevision') }),
      });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.delete('/api/plugins/:pluginId', async (request: FastifyRequest<{ Params: { pluginId: string }; Body?: unknown }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      const body = request.body === undefined ? {} : recordBody(request.body);
      exactKeys(body, ['expectedRevision']);
      return await options.plugins.remove({
        pluginId: identity(request.params.pluginId, 'pluginId'),
        ...(body.expectedRevision === undefined ? {} : { expectedRevision: nonNegativeInteger(body.expectedRevision, 'expectedRevision') }),
      });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.post('/api/plugins/:pluginId/hooks/:hookId/trust', async (request: FastifyRequest<{ Params: { pluginId: string; hookId: string }; Body: unknown }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      const body = recordBody(request.body);
      exactKeys(body, ['pluginRevisionId', 'trusted']);
      return await options.plugins.trustHook({
        pluginId: identity(request.params.pluginId, 'pluginId'),
        pluginRevisionId: identity(body.pluginRevisionId, 'pluginRevisionId'),
        hookId: identity(request.params.hookId, 'hookId'),
        trusted: booleanValue(body.trusted, 'trusted'),
      });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.patch('/api/plugins/:pluginId/hooks/:hookId/enabled', async (request: FastifyRequest<{ Params: { pluginId: string; hookId: string }; Body: unknown }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      const body = recordBody(request.body);
      exactKeys(body, ['pluginRevisionId', 'enabled']);
      return await options.plugins.setHookEnabled({
        pluginId: identity(request.params.pluginId, 'pluginId'),
        pluginRevisionId: identity(body.pluginRevisionId, 'pluginRevisionId'),
        hookId: identity(request.params.hookId, 'hookId'),
        enabled: booleanValue(body.enabled, 'enabled'),
      });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.get('/api/plugin-marketplaces', async (request: FastifyRequest<{ Querystring: { projectId?: string } }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      return { marketplaces: await options.plugins.listMarketplaces({ projectId: optionalProjectId(request.query.projectId, options.hasProject) }) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.post('/api/plugin-marketplaces', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      const body = recordBody(request.body);
      exactKeys(body, ['scope', 'projectId', 'source']);
      const scope = pluginScope(body.scope);
      const projectId = scope === 'project' ? requiredProjectId(body.projectId, options.hasProject) : null;
      return await options.plugins.addMarketplace({ scope, projectId, source: directSource(body.source) });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.post('/api/plugin-marketplaces/:marketplaceId/refresh', async (request: FastifyRequest<{ Params: { marketplaceId: string } }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      return await options.plugins.refreshMarketplace({ marketplaceId: identity(request.params.marketplaceId, 'marketplaceId') });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.delete('/api/plugin-marketplaces/:marketplaceId', async (request: FastifyRequest<{ Params: { marketplaceId: string } }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      return await options.plugins.removeMarketplace({ marketplaceId: identity(request.params.marketplaceId, 'marketplaceId') });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.put('/api/plugins/:pluginId/connectors/:connectorId', async (request: FastifyRequest<{ Params: { pluginId: string; connectorId: string }; Body: unknown }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      const body = recordBody(request.body);
      exactKeys(body, ['appTechnicalId', 'serverConfig', 'secret', 'connected']);
      return await options.plugins.bindConnector({
        pluginId: identity(request.params.pluginId, 'pluginId'),
        connectorId: identity(request.params.connectorId, 'connectorId'),
        appTechnicalId: identity(body.appTechnicalId, 'appTechnicalId'),
        serverConfig: recordValue(body.serverConfig, 'serverConfig'),
        ...(body.secret === undefined || body.secret === null ? {} : { secret: identity(body.secret, 'secret', 64 * 1024) }),
        connected: booleanValue(body.connected, 'connected'),
      });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.delete('/api/plugin-connectors/:connectorId/authorization', async (request: FastifyRequest<{ Params: { connectorId: string } }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      return await options.plugins.revokeConnectorAuthorization({ connectorId: identity(request.params.connectorId, 'connectorId') });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  server.put('/api/plugins/:pluginId/mcp/:serverId/policy', async (request: FastifyRequest<{ Params: { pluginId: string; serverId: string }; Body: unknown }>, reply) => {
    if (!options.plugins) return unavailable(reply);
    try {
      const body = recordBody(request.body);
      exactKeys(body, ['toolName', 'enabled', 'approvalMode']);
      return await options.plugins.setMcpPolicy({
        pluginId: identity(request.params.pluginId, 'pluginId'),
        serverId: identity(request.params.serverId, 'serverId'),
        toolName: body.toolName === undefined || body.toolName === null ? '*' : identity(body.toolName, 'toolName'),
        enabled: booleanValue(body.enabled, 'enabled'),
        approvalMode: approvalMode(body.approvalMode),
      });
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });
}

function installSource(value: unknown): ZeusPluginInstallSource {
  const source = recordValue(value, 'source');
  if (source.kind === 'marketplace') {
    exactKeys(source, ['kind', 'marketplaceId', 'pluginName']);
    return { kind: 'marketplace', marketplaceId: identity(source.marketplaceId, 'marketplaceId'), pluginName: identity(source.pluginName, 'pluginName') };
  }
  return directSource(source);
}

function directSource(value: unknown): ZeusPluginDirectSource {
  const source = recordValue(value, 'source');
  if (source.kind === 'local') {
    exactKeys(source, ['kind', 'path']);
    return { kind: 'local', path: identity(source.path, 'path', 16_000) };
  }
  if (source.kind === 'git') {
    exactKeys(source, ['kind', 'repositoryUrl', 'ref', 'subdirectory']);
    return {
      kind: 'git',
      repositoryUrl: identity(source.repositoryUrl, 'repositoryUrl', 8_000),
      ...(source.ref === undefined || source.ref === null || source.ref === '' ? {} : { ref: identity(source.ref, 'ref') }),
      ...(source.subdirectory === undefined || source.subdirectory === null || source.subdirectory === '' ? {} : { subdirectory: identity(source.subdirectory, 'subdirectory', 4_000) }),
    };
  }
  throw inputError('source.kind 仅支持 local、git 或 marketplace。');
}

function optionalProjectId(value: unknown, hasProject: (id: string) => boolean): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredProjectId(value, hasProject);
}

function requiredProjectId(value: unknown, hasProject: (id: string) => boolean): string {
  const projectId = identity(value, 'projectId');
  if (!hasProject(projectId)) throw new ZeusPluginServiceError('ZEUS_PROJECT_NOT_FOUND', '项目不存在。', 404);
  return projectId;
}

function pluginScope(value: unknown): PluginScope {
  if (value !== 'personal' && value !== 'project') throw inputError('scope 仅支持 personal 或 project。');
  return value;
}

function approvalMode(value: unknown): PluginApprovalMode {
  if (value !== 'prompt' && value !== 'approve' && value !== 'deny') throw inputError('approvalMode 仅支持 prompt、approve 或 deny。');
  return value;
}

function recordBody(value: unknown): Record<string, unknown> {
  return recordValue(value, 'body');
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw inputError(`请求包含未知字段：${unexpected.join('、')}`);
}

function identity(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || value.includes('\0')) throw inputError(`${label} 无效。`);
  return value.trim();
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw inputError(`${label} 必须是布尔值。`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw inputError(`${label} 必须是非负整数。`);
  return value;
}

function inputError(message: string): ZeusPluginServiceError {
  return new ZeusPluginServiceError('ZEUS_PLUGIN_INPUT_INVALID', message, 400);
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ error: 'ZEUS_PLUGIN_HOST_UNAVAILABLE', message: 'Zeus Plugin Host 当前不可用。' });
}

function sendPluginError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZeusPluginServiceError || error instanceof ZeusPluginSourceError || error instanceof PluginStoreError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({ error: 'ZEUS_PLUGIN_OPERATION_FAILED', message: error instanceof Error ? error.message : 'Plugin 操作失败。' });
}
