export interface TelegramConfigurationState {
  enabled: boolean;
  reason: string;
}

export interface TelegramCommand {
  command: string;
  args: string[];
}

export interface TelegramUpdate {
  updateId: number;
  chatId: number;
  userId: number;
  text: string;
}

export interface TelegramAuditEvent {
  updateId: number;
  chatId: number;
  userId: number;
  command: string;
  allowed: boolean;
}

export interface TelegramDispatchResult {
  allowed: boolean;
  command?: TelegramCommand;
  reason?: string;
  auditEvent: TelegramAuditEvent;
}

export interface TelegramLongPollingClient {
  poll: (offset?: number) => Promise<TelegramUpdate[]>;
}

export interface TelegramMessageSender {
  sendMessage: (chatId: number, text: string) => Promise<void>;
}

interface TelegramApiMessage {
  chat?: { id?: number };
  from?: { id?: number };
  text?: string;
}

interface TelegramApiUpdate {
  update_id?: number;
  message?: TelegramApiMessage;
}

interface TelegramApiGetUpdatesResponse {
  ok: boolean;
  result?: TelegramApiUpdate[];
  description?: string;
}

interface TelegramApiSendMessageResponse {
  ok: boolean;
  description?: string;
}

const supportedCommands = new Set(['start', 'projects', 'tasks', 'run', 'status', 'stop', 'continue', 'logs', 'diff', 'ask', 'confirm', 'cancel', 'help']);
const defaultTelegramMaxLength = 3900;

/** Telegram 未配置时只返回明确状态，不制造假消息。 */
export function getTelegramConfigurationState(token: string | undefined, allowedUserIds: number[] = []): TelegramConfigurationState {
  if (!token) return { enabled: false, reason: 'Telegram Bot Token 未配置。' };
  if (allowedUserIds.length === 0) return { enabled: false, reason: 'Telegram allowed user id 未配置。' };
  return { enabled: true, reason: 'Telegram long polling 可启用。' };
}

/** 解析 Telegram 命令文本，未知命令保持可解释错误。 */
export function parseTelegramCommand(text: string): TelegramCommand {
  const [rawCommand = '', ...args] = text.trim().split(/\s+/u);
  const command = rawCommand.replace(/^\//u, '');
  if (!supportedCommands.has(command)) {
    throw new Error(`Unsupported Zeus Telegram command: ${rawCommand}`);
  }
  return { command, args };
}

/** 创建 Telegram Bot API long polling 客户端，只处理真实 API 返回的 update。 */
/** 创建 Telegram Bot API 消息发送器；发送前统一脱敏和截断。 */
export function createTelegramBotMessageClient(options: { token: string; fetch?: typeof fetch; maxLength?: number }): TelegramMessageSender {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async sendMessage(chatId: number, text: string): Promise<void> {
      const url = `https://api.telegram.org/bot${options.token}/sendMessage`;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatTelegramMessage(text, { maxLength: options.maxLength }),
        }),
      });
      if (!response.ok) {
        throw new Error(`Telegram sendMessage failed: ${response.status}`);
      }
      const body = (await response.json()) as TelegramApiSendMessageResponse;
      if (!body.ok) {
        throw new Error(body.description ?? 'Telegram sendMessage returned ok=false');
      }
    },
  };
}

export function createTelegramLongPollingClient(options: { token: string; fetch?: typeof fetch; timeoutSeconds?: number; limit?: number }): TelegramLongPollingClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutSeconds = options.timeoutSeconds ?? 25;
  const limit = options.limit ?? 20;
  return {
    async poll(offset = 0): Promise<TelegramUpdate[]> {
      const url = new URL(`https://api.telegram.org/bot${options.token}/getUpdates`);
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('timeout', String(timeoutSeconds));
      url.searchParams.set('limit', String(limit));
      const response = await fetchImpl(url.toString());
      if (!response.ok) {
        throw new Error(`Telegram getUpdates failed: ${response.status}`);
      }
      const body = (await response.json()) as TelegramApiGetUpdatesResponse;
      if (!body.ok) {
        throw new Error(body.description ?? 'Telegram getUpdates returned ok=false');
      }
      return (body.result ?? []).flatMap(normalizeTelegramUpdate);
    },
  };
}

/** 对单条 update 做白名单校验和命令解析，返回可落审计日志的结构。 */
export function dispatchTelegramUpdate(update: TelegramUpdate, options: { allowedUserIds: number[] }): TelegramDispatchResult {
  const allowed = options.allowedUserIds.includes(update.userId);
  const rawCommand = extractTelegramRawCommand(update.text);
  let command: TelegramCommand | undefined;
  try {
    command = parseTelegramCommand(update.text);
  } catch {
    const auditEvent: TelegramAuditEvent = {
      updateId: update.updateId,
      chatId: update.chatId,
      userId: update.userId,
      command: rawCommand,
      allowed,
    };
    if (!allowed) {
      return {
        allowed: false,
        reason: 'Telegram 用户不在 Zeus 白名单。',
        auditEvent,
      };
    }
    // 白名单用户输入未知命令时给出可执行恢复路径，不把 parser 异常升级成 polling 故障。
    return {
      allowed: true,
      reason: `未知 Zeus 远程命令：/${rawCommand}。发送 /help 查看可用命令。`,
      auditEvent,
    };
  }
  const auditEvent: TelegramAuditEvent = {
    updateId: update.updateId,
    chatId: update.chatId,
    userId: update.userId,
    command: command.command,
    allowed,
  };
  if (!allowed) {
    return {
      allowed: false,
      reason: 'Telegram 用户不在 Zeus 白名单。',
      auditEvent,
    };
  }
  return { allowed: true, command, auditEvent };
}

function extractTelegramRawCommand(text: string): string {
  const [rawCommand = ''] = text.trim().split(/\s+/u);
  return rawCommand.replace(/^\//u, '') || 'unknown';
}

/** Telegram 输出统一脱敏和截断，避免 token、长日志或大 diff 直接发到聊天。 */
export function formatTelegramMessage(input: string, options: { maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? defaultTelegramMaxLength;
  const redacted = redactSensitiveText(input);
  if (redacted.length <= maxLength) return redacted;
  const suffix = '…已截断';
  return `${redacted.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

function normalizeTelegramUpdate(update: TelegramApiUpdate): TelegramUpdate[] {
  const updateId = update.update_id;
  const chatId = update.message?.chat?.id;
  const userId = update.message?.from?.id;
  const text = update.message?.text;
  if (typeof updateId !== 'number' || typeof chatId !== 'number' || typeof userId !== 'number' || typeof text !== 'string') {
    return [];
  }
  return [{ updateId, chatId, userId, text }];
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu, '[REDACTED SSH PRIVATE KEY]')
    .replace(/\b(authorization)\s*:\s*Bearer\s+[^\s]+/giu, '$1: Bearer [REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(cookie)\s*:\s*[^\n\r]+/giu, '$1: [REDACTED]')
    .replace(/\b([A-Z0-9_.-]*(?:token|api[_-]?key|password|secret)[A-Z0-9_.-]*)\s*[:=]\s*("[^"\n\r]*"|'[^'\n\r]*'|[^\s,;]+)/giu, '$1=[REDACTED]');
}

export interface TelegramPollingStatus {
  running: boolean;
  offset: number;
  lastError: string | null;
  handledUpdates: number;
}

export type TelegramPollingLogEntry =
  | TelegramAuditEvent
  | {
      updateId: null;
      chatId: null;
      userId: null;
      command: 'poll';
      allowed: false;
      error: string;
    };

export interface TelegramPollingService {
  start: () => Promise<TelegramPollingStatus>;
  stop: () => Promise<TelegramPollingStatus>;
  pollOnce: () => Promise<TelegramPollingStatus>;
  status: () => TelegramPollingStatus;
  logs: () => TelegramPollingLogEntry[];
}

/** Telegram 后台轮询服务：只消费真实 client 返回的 update，并记录可审计日志。 */
export function createTelegramPollingService(options: {
  client: TelegramLongPollingClient;
  allowedUserIds: number[];
  initialOffset?: number;
  maxLogs?: number;
  reply?: (chatId: number, text: string) => Promise<void>;
  handleCommand?: (command: TelegramCommand, update: TelegramUpdate) => Promise<string | undefined>;
}): TelegramPollingService {
  let running = false;
  let offset = options.initialOffset ?? 0;
  let lastError: string | null = null;
  let handledUpdates = 0;
  const maxLogs = options.maxLogs ?? 200;
  const logs: TelegramPollingLogEntry[] = [];

  function snapshot(): TelegramPollingStatus {
    return { running, offset, lastError, handledUpdates };
  }

  function appendLog(entry: TelegramPollingLogEntry): void {
    logs.push(entry);
    if (logs.length > maxLogs) logs.splice(0, logs.length - maxLogs);
  }

  return {
    async start(): Promise<TelegramPollingStatus> {
      running = true;
      return snapshot();
    },
    async stop(): Promise<TelegramPollingStatus> {
      running = false;
      return snapshot();
    },
    async pollOnce(): Promise<TelegramPollingStatus> {
      try {
        const updates = await options.client.poll(offset);
        for (const update of updates) {
          const result = dispatchTelegramUpdate(update, {
            allowedUserIds: options.allowedUserIds,
          });
          appendLog(result.auditEvent);
          if (result.allowed && result.reason && options.reply) {
            await options.reply(update.chatId, result.reason);
          }
          if (result.allowed && result.command && options.reply && options.handleCommand) {
            const replyText = await options.handleCommand(result.command, update);
            if (replyText) await options.reply(update.chatId, replyText);
          }
          handledUpdates += 1;
          offset = Math.max(offset, update.updateId + 1);
        }
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Telegram polling failed';
        appendLog({
          updateId: null,
          chatId: null,
          userId: null,
          command: 'poll',
          allowed: false,
          error: lastError,
        });
      }
      return snapshot();
    },
    status: snapshot,
    logs: () => [...logs],
  };
}
