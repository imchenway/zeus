import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TelegramPollingService, TelegramPollingStatus } from '@zeus/telegram-adapter';
import { TelegramCommandApplication, telegramChildOperation, telegramCommandHttpError, telegramCommandTypes, type TelegramCommandRequest } from './telegramCommandApplication.js';

interface TelegramPollingApiOptions {
  server: FastifyInstance;
  application: TelegramCommandApplication;
  requireService(): Promise<TelegramPollingService>;
  getService(): TelegramPollingService | undefined;
  getTimer(): ReturnType<typeof setInterval> | undefined;
  setTimer(timer: ReturnType<typeof setInterval> | undefined): void;
  redactSensitiveText(value: string): { text: string };
}

type EmptyInput = Record<string, never>;

const stoppedStatus = { running: false, offset: 0, lastError: null, handledUpdates: 0, lastSuccessfulPollAt: null } as const;
const pollingScopeId = 'telegram.polling';

/** Telegram 轮询控制面；两个兼容 alias 共享同一稳定 command type 和 settings scope。 */
export function registerTelegramPollingApi(options: TelegramPollingApiOptions): void {
  const start = async (request: FastifyRequest<{ Body: TelegramCommandRequest<EmptyInput> }>, reply: FastifyReply) => {
    try {
      const parsed = parseEmptyCommand(options.application, request.body, telegramCommandTypes.pollingStart);
      let service: TelegramPollingService | undefined;
      const execution = await options.application.executeExternal({
        parsed,
        destinationId: 'telegram-polling-control',
        resourceId: pollingScopeId,
        children: [telegramChildOperation(parsed.operationIdentity, 'polling_service_start'), telegramChildOperation(parsed.operationIdentity, 'polling_timer_start')],
        beforeWrite: async () => {
          service = await options.requireService();
        },
        invoke: async () => {
          const status = await service!.start();
          if (!options.getTimer()) {
            const timer = setInterval(() => void service!.pollOnce(), 30_000);
            timer.unref?.();
            options.setTimer(timer);
          }
          return sanitizeStatus(status, options.redactSensitiveText);
        },
      });
      return execution.result;
    } catch (error) {
      return sendTelegramCommandError(reply, error, options.redactSensitiveText);
    }
  };

  const stop = async (request: FastifyRequest<{ Body: TelegramCommandRequest<EmptyInput> }>, reply: FastifyReply) => {
    try {
      const parsed = parseEmptyCommand(options.application, request.body, telegramCommandTypes.pollingStop);
      const execution = await options.application.executeExternal({
        parsed,
        destinationId: 'telegram-polling-control',
        resourceId: pollingScopeId,
        children: [telegramChildOperation(parsed.operationIdentity, 'polling_timer_stop'), telegramChildOperation(parsed.operationIdentity, 'polling_service_stop')],
        invoke: async () => {
          const timer = options.getTimer();
          if (timer) clearInterval(timer);
          options.setTimer(undefined);
          const status = (await options.getService()?.stop()) ?? stoppedStatus;
          return sanitizeStatus(status, options.redactSensitiveText);
        },
      });
      return execution.result;
    } catch (error) {
      return sendTelegramCommandError(reply, error, options.redactSensitiveText);
    }
  };

  const pollOnce = async (request: FastifyRequest<{ Body: TelegramCommandRequest<EmptyInput> }>, reply: FastifyReply) => {
    try {
      const parsed = parseEmptyCommand(options.application, request.body, telegramCommandTypes.pollingOnce);
      let service: TelegramPollingService | undefined;
      const execution = await options.application.executeExternal({
        parsed,
        destinationId: 'telegram-polling-network',
        resourceId: pollingScopeId,
        children: [telegramChildOperation(parsed.operationIdentity, 'telegram_get_updates'), telegramChildOperation(parsed.operationIdentity, 'telegram_update_dispatch')],
        capacityGroup: 'poll_once',
        beforeWrite: async () => {
          service = await options.requireService();
        },
        invoke: async () => {
          const status = await service!.pollOnce();
          if (status.lastError) throw Object.assign(new Error(status.lastError), { code: 'ZEUS_TELEGRAM_POLL_RESULT_UNKNOWN' });
          return sanitizeStatus(status, options.redactSensitiveText);
        },
      });
      return execution.result;
    } catch (error) {
      return sendTelegramCommandError(reply, error, options.redactSensitiveText);
    }
  };

  options.server.post('/api/telegram/start', start);
  options.server.post('/api/telegram/stop', stop);
  options.server.get('/api/telegram/polling/status', async () => sanitizeStatus(options.getService()?.status() ?? stoppedStatus, options.redactSensitiveText));
  options.server.get('/api/telegram/polling/logs', async () => options.getService()?.logs() ?? []);
  options.server.get('/api/telegram/messages', async () => options.getService()?.logs() ?? []);
  options.server.post('/api/telegram/polling/start', start);
  options.server.post('/api/telegram/polling/poll-once', pollOnce);
  options.server.post('/api/telegram/polling/stop', stop);
}

function parseEmptyCommand(application: TelegramCommandApplication, value: unknown, commandType: typeof telegramCommandTypes.pollingStart | typeof telegramCommandTypes.pollingStop | typeof telegramCommandTypes.pollingOnce) {
  const parsed = application.parse<EmptyInput>({ value, commandType, scopeId: pollingScopeId });
  if (Object.keys(parsed.input).length !== 0) throw Object.assign(new Error('Telegram polling command input must be empty.'), { code: 'ZEUS_TELEGRAM_COMMAND_INVALID', statusCode: 400 });
  return parsed;
}

function sanitizeStatus(status: TelegramPollingStatus, redactor: (value: string) => { text: string }): TelegramPollingStatus {
  return { ...status, lastError: status.lastError ? redactor(status.lastError).text.slice(0, 2_048) : null };
}

function sendTelegramCommandError(reply: FastifyReply, error: unknown, redactor: (value: string) => { text: string }): unknown {
  const commandError = telegramCommandHttpError(error);
  if (commandError) return reply.code(commandError.statusCode).send(commandError.payload);
  const statusCode = typeof error === 'object' && error !== null && typeof (error as { statusCode?: unknown }).statusCode === 'number' ? Number((error as { statusCode: number }).statusCode) : 500;
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code).slice(0, 128) : 'ZEUS_TELEGRAM_COMMAND_FAILED';
  const rawMessage = error instanceof Error ? error.message : String(error);
  return reply.code(statusCode).send({ error: code, message: redactor(rawMessage).text.slice(0, 2_048) });
}
