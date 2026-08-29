import type { ImAgentPresetRef } from '@zeus/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ImTelegramService, stableIdentity } from './imTelegramService.js';
import { telegramChildOperation, TelegramCommandApplication, telegramCommandHttpError, telegramCommandTypes, type TelegramCommandRequest } from './telegramCommandApplication.js';

interface CreateConnectionInput {
  projectId?: unknown;
  agentPreset?: unknown;
  botToken?: unknown;
  useLegacyToken?: unknown;
}

interface UpdateConnectionInput {
  expectedRevision?: unknown;
  agentPreset?: unknown;
  remoteApprovalEnabled?: unknown;
}

type EmptyInput = Record<string, never>;
type ConnectionParams = { connectionId: string };

export function registerImConnectionRoutes(options: { server: FastifyInstance; application: TelegramCommandApplication; service: ImTelegramService; redactSensitiveText(value: string): { text: string } }): void {
  const { server, application, service } = options;

  server.get('/api/im/settings', async () => service.settingsSnapshot());
  server.get('/api/im/options', async () => service.selectionOptions());

  server.post('/api/im/telegram/connections', async (request: FastifyRequest<{ Body: TelegramCommandRequest<CreateConnectionInput> }>, reply) => {
    try {
      const parsed = application.parse<CreateConnectionInput>({ value: request.body, commandType: telegramCommandTypes.imConnectionCreate, scopeId: 'im.telegram.connections' });
      assertOnlyKeys(parsed.input, ['agentPreset', 'botToken', 'projectId', 'useLegacyToken']);
      const projectId = requiredIdentity(parsed.input.projectId, 'projectId');
      const agentPreset = parseAgentPreset(parsed.input.agentPreset);
      if (parsed.input.useLegacyToken !== undefined && typeof parsed.input.useLegacyToken !== 'boolean') throw routeError('ZEUS_IM_COMMAND_INPUT_INVALID', 'useLegacyToken 必须是布尔值。', 400);
      if (parsed.input.botToken !== undefined && typeof parsed.input.botToken !== 'string') throw routeError('ZEUS_IM_COMMAND_INPUT_INVALID', 'botToken 必须是字符串。', 400);
      const useLegacyToken = parsed.input.useLegacyToken === true;
      const botToken = typeof parsed.input.botToken === 'string' ? parsed.input.botToken.trim() : undefined;
      if (!useLegacyToken && !botToken) throw routeError('ZEUS_IM_TOKEN_REQUIRED', '请输入 BotFather Token。', 400);
      if (useLegacyToken && botToken) throw routeError('ZEUS_IM_TOKEN_SOURCE_AMBIGUOUS', '迁移旧 Token 与输入新 Token 不能同时使用。', 400);
      service.createInputAllowed({ projectId, agentPreset });
      const connectionId = stableIdentity('im_connection', parsed.operationIdentity);
      const execution = await application.executeExternal({
        parsed,
        destinationId: 'im-telegram-connection-create',
        resourceId: connectionId,
        children: [
          telegramChildOperation(parsed.operationIdentity, 'telegram_get_me'),
          telegramChildOperation(parsed.operationIdentity, 'keychain_token_write'),
          telegramChildOperation(parsed.operationIdentity, 'connection_create'),
          telegramChildOperation(parsed.operationIdentity, 'pairing_create'),
          telegramChildOperation(parsed.operationIdentity, 'poller_start'),
        ],
        invoke: () => service.createConnection({ connectionId, projectId, agentPreset, botToken, useLegacyToken }),
      });
      return reply.code(201).send(service.pairingResponse(execution.result.connection, execution.result.pairingId));
    } catch (error) {
      return sendError(reply, error, options.redactSensitiveText);
    }
  });

  server.post('/api/im/telegram/connections/:connectionId/pairing', async (request: FastifyRequest<{ Params: ConnectionParams; Body: TelegramCommandRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = application.parse<EmptyInput>({ value: request.body, commandType: telegramCommandTypes.imConnectionRepair, scopeId: `im.connection.${request.params.connectionId}` });
      assertExactKeys(parsed.input, []);
      const execution = await application.executeExternal({
        parsed,
        destinationId: 'im-telegram-pairing-create',
        resourceId: request.params.connectionId,
        children: [telegramChildOperation(parsed.operationIdentity, 'previous_pairing_revoke'), telegramChildOperation(parsed.operationIdentity, 'pairing_create')],
        invoke: () => service.repair(request.params.connectionId),
      });
      return service.pairingResponse(execution.result.connection, execution.result.pairingId);
    } catch (error) {
      return sendError(reply, error, options.redactSensitiveText);
    }
  });

  server.get('/api/im/telegram/connections/:connectionId/pairing', async (request: FastifyRequest<{ Params: ConnectionParams }>, reply) => {
    try {
      return service.pairingStatus(request.params.connectionId);
    } catch (error) {
      return sendError(reply, error, options.redactSensitiveText);
    }
  });

  server.post('/api/im/telegram/connections/:connectionId/check', async (request: FastifyRequest<{ Params: ConnectionParams; Body: TelegramCommandRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = application.parse<EmptyInput>({ value: request.body, commandType: telegramCommandTypes.imConnectionCheck, scopeId: `im.connection.${request.params.connectionId}` });
      assertExactKeys(parsed.input, []);
      const execution = await application.executeExternal({
        parsed,
        destinationId: 'im-telegram-connection-check',
        resourceId: request.params.connectionId,
        children: [telegramChildOperation(parsed.operationIdentity, 'keychain_token_read'), telegramChildOperation(parsed.operationIdentity, 'telegram_get_me'), telegramChildOperation(parsed.operationIdentity, 'health_update')],
        invoke: () => service.check(request.params.connectionId),
      });
      return execution.result;
    } catch (error) {
      return sendError(reply, error, options.redactSensitiveText);
    }
  });

  server.patch('/api/im/telegram/connections/:connectionId', async (request: FastifyRequest<{ Params: ConnectionParams; Body: TelegramCommandRequest<UpdateConnectionInput> }>, reply) => {
    try {
      const parsed = application.parse<UpdateConnectionInput>({ value: request.body, commandType: telegramCommandTypes.imConnectionUpdate, scopeId: `im.connection.${request.params.connectionId}` });
      assertOnlyKeys(parsed.input, ['agentPreset', 'expectedRevision', 'remoteApprovalEnabled']);
      const expectedRevision = requiredRevision(parsed.input.expectedRevision);
      const agentPreset = parsed.input.agentPreset === undefined ? undefined : parseAgentPreset(parsed.input.agentPreset);
      const remoteApprovalEnabled = parsed.input.remoteApprovalEnabled === undefined ? undefined : requiredBoolean(parsed.input.remoteApprovalEnabled, 'remoteApprovalEnabled');
      if (!agentPreset && remoteApprovalEnabled === undefined) throw routeError('ZEUS_IM_CONNECTION_UPDATE_EMPTY', '没有可更新的连接配置。', 400);
      const execution = await application.executeExternal({
        parsed,
        destinationId: 'im-telegram-connection-update',
        resourceId: request.params.connectionId,
        children: [telegramChildOperation(parsed.operationIdentity, 'connection_config_update')],
        invoke: () => service.update(request.params.connectionId, { expectedRevision, ...(agentPreset ? { agentPreset } : {}), ...(remoteApprovalEnabled === undefined ? {} : { remoteApprovalEnabled }) }),
      });
      return execution.result;
    } catch (error) {
      return sendError(reply, error, options.redactSensitiveText);
    }
  });

  server.delete('/api/im/telegram/connections/:connectionId', async (request: FastifyRequest<{ Params: ConnectionParams; Body: TelegramCommandRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = application.parse<EmptyInput>({ value: request.body, commandType: telegramCommandTypes.imConnectionRemove, scopeId: `im.connection.${request.params.connectionId}` });
      assertExactKeys(parsed.input, []);
      const execution = await application.executeExternal({
        parsed,
        destinationId: 'im-telegram-connection-remove',
        resourceId: request.params.connectionId,
        children: [
          telegramChildOperation(parsed.operationIdentity, 'poller_stop'),
          telegramChildOperation(parsed.operationIdentity, 'pairing_revoke'),
          telegramChildOperation(parsed.operationIdentity, 'endpoint_revoke'),
          telegramChildOperation(parsed.operationIdentity, 'keychain_token_delete'),
          telegramChildOperation(parsed.operationIdentity, 'connection_remove'),
        ],
        invoke: async () => {
          await service.remove(request.params.connectionId);
          return { removed: true, connectionId: request.params.connectionId };
        },
      });
      return execution.result;
    } catch (error) {
      return sendError(reply, error, options.redactSensitiveText);
    }
  });

  server.get('/api/im/telegram/connections/:connectionId/logs', async (request: FastifyRequest<{ Params: ConnectionParams }>, reply) => {
    try {
      return service.logs(request.params.connectionId);
    } catch (error) {
      return sendError(reply, error, options.redactSensitiveText);
    }
  });
}

function parseAgentPreset(value: unknown): ImAgentPresetRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw routeError('ZEUS_IM_AGENT_PRESET_INVALID', 'Agent Preset 无效。', 400);
  const record = value as Record<string, unknown>;
  assertExactKeys(record, ['digitalEmployeeId', 'kind']);
  if (record.kind === 'zeus_default' && record.digitalEmployeeId === null) return { kind: 'zeus_default', digitalEmployeeId: null };
  if (record.kind === 'digital_employee' && typeof record.digitalEmployeeId === 'string' && record.digitalEmployeeId.trim()) return { kind: 'digital_employee', digitalEmployeeId: record.digitalEmployeeId.trim() };
  throw routeError('ZEUS_IM_AGENT_PRESET_INVALID', 'Agent Preset 无效。', 400);
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw routeError('ZEUS_IM_COMMAND_INPUT_INVALID', 'IM 命令字段不完整或包含额外字段。', 400);
}

function assertOnlyKeys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw routeError('ZEUS_IM_COMMAND_INPUT_INVALID', 'IM 命令包含额外字段。', 400);
}

function requiredIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 256) throw routeError('ZEUS_IM_COMMAND_INPUT_INVALID', `${field} 无效。`, 400);
  return value;
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw routeError('ZEUS_IM_COMMAND_INPUT_INVALID', 'expectedRevision 无效。', 400);
  return value as number;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw routeError('ZEUS_IM_COMMAND_INPUT_INVALID', `${field} 必须是布尔值。`, 400);
  return value;
}

function sendError(reply: FastifyReply, error: unknown, redactor: (value: string) => { text: string }): unknown {
  const mapped = telegramCommandHttpError(error);
  if (mapped) return reply.code(mapped.statusCode).send(mapped.payload);
  const statusCode = typeof error === 'object' && error !== null && typeof (error as { statusCode?: unknown }).statusCode === 'number' ? Number((error as { statusCode: number }).statusCode) : 500;
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code).slice(0, 128) : 'ZEUS_IM_COMMAND_FAILED';
  const message = redactor(error instanceof Error ? error.message : String(error)).text.slice(0, 2_048);
  return reply.code(statusCode).send({ error: code, message });
}

function routeError(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}
