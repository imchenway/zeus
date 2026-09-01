/** Local Server 的 Telegram 适配实现。 */
import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';

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
  messageId?: number;
  callbackQueryId?: string;
  callbackData?: string;
  chatType?: 'private' | 'group' | 'supergroup' | 'channel' | 'unknown';
  senderDisplayName?: string | null;
  mediaGroupId?: string;
  attachments?: TelegramInboundAttachment[];
}

export type TelegramInboundAttachmentKind = 'photo' | 'document' | 'audio' | 'voice' | 'video' | 'video_note';

export interface TelegramInboundAttachment {
  kind: TelegramInboundAttachmentKind;
  fileId: string;
  fileUniqueId: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
}

export interface TelegramBotProfile {
  id: number;
  username: string;
  firstName: string;
  canJoinGroups: boolean;
}

export interface TelegramRemoteFile {
  fileId: string;
  filePath: string;
  fileSize: number | null;
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
  sendMessage: (chatId: number, text: string, options?: TelegramMessageOptions) => Promise<TelegramSentMessage | void>;
  editMessage?: (chatId: number, messageId: number, text: string, options?: TelegramMessageOptions) => Promise<void>;
  sendDocument?: (chatId: number, filePath: string, caption?: string) => Promise<void>;
  sendPhoto?: (chatId: number, filePath: string, caption?: string) => Promise<void>;
  answerCallbackQuery?: (callbackQueryId: string, options?: { text?: string; showAlert?: boolean }) => Promise<void>;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface TelegramMessageOptions {
  inlineKeyboard?: TelegramInlineKeyboardButton[][];
  parseMode?: 'HTML';
}

export interface TelegramSentMessage {
  messageId: number;
}

/** Telegram 已回应未接纳；与无响应的网络超时严格分开，供上层收口四态回执。 */
export class TelegramApiRejectedError extends Error {
  readonly name = 'TelegramApiRejectedError';
  readonly dispatchDisposition = 'explicitly_rejected' as const;

  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

interface TelegramApiFile {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

interface TelegramApiMessage {
  chat?: { id?: number; type?: string };
  from?: { id?: number; first_name?: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
  message_id?: number;
  media_group_id?: string;
  document?: TelegramApiFile;
  audio?: TelegramApiFile;
  voice?: TelegramApiFile;
  video?: TelegramApiFile;
  video_note?: TelegramApiFile;
  photo?: TelegramApiFile[];
}

interface TelegramApiUpdate {
  update_id?: number;
  message?: TelegramApiMessage;
  callback_query?: {
    id?: string;
    from?: { id?: number };
    message?: TelegramApiMessage;
    data?: string;
  };
}

interface TelegramApiGetUpdatesResponse {
  ok: boolean;
  result?: TelegramApiUpdate[];
  description?: string;
}

interface TelegramApiSendMessageResponse {
  ok: boolean;
  result?: { message_id?: number };
  description?: string;
}

interface TelegramApiGetMeResponse {
  ok: boolean;
  result?: { id?: number; username?: string; first_name?: string; can_join_groups?: boolean; is_bot?: boolean };
  description?: string;
}

interface TelegramApiGetFileResponse {
  ok: boolean;
  result?: { file_id?: string; file_path?: string; file_size?: number };
  description?: string;
}

const supportedCommands = new Set(['start', 'projects', 'tasks', 'run', 'status', 'stop', 'continue', 'logs', 'diff', 'ask', 'confirm', 'cancel', 'commands', 'command', 'help']);
const defaultTelegramMaxLength = 3900;
const mediaGroupQuietWindowMs = 1_500;

/** Telegram 未配置时只返回明确状态，不制造假消息。 */
export function getTelegramConfigurationState(token: string | undefined, allowedUserIds: number[] = []): TelegramConfigurationState {
  if (!token) return { enabled: false, reason: 'Telegram Bot Token 未配置。' };
  if (allowedUserIds.length === 0) return { enabled: false, reason: 'Telegram allowed user id 未配置。' };
  return { enabled: true, reason: 'Telegram long polling 可启用。' };
}

/** 解析 Telegram 命令文本，未知命令保持可解释错误。 */
export function parseTelegramCommand(text: string): TelegramCommand {
  const [rawCommand = '', ...args] = text.trim().split(/\s+/u);
  const command = rawCommand.replace(/^\//u, '').split('@')[0] ?? '';
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
    async sendMessage(chatId: number, text: string, messageOptions?: TelegramMessageOptions): Promise<TelegramSentMessage | void> {
      const url = `https://api.telegram.org/bot${options.token}/sendMessage`;
      const response = await safeTelegramFetch(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: messageOptions?.parseMode === 'HTML' ? formatTelegramHtml(text, { maxLength: options.maxLength }) : formatTelegramMessage(text, { maxLength: options.maxLength }),
            ...(messageOptions?.parseMode ? { parse_mode: messageOptions.parseMode } : {}),
            ...(messageOptions?.inlineKeyboard?.length ? { reply_markup: { inline_keyboard: toTelegramInlineKeyboard(messageOptions.inlineKeyboard) } } : {}),
          }),
        },
        'sendMessage',
      );
      if (!response.ok) {
        throw new TelegramApiRejectedError(`Telegram sendMessage failed: ${response.status}`, response.status);
      }
      const body = (await response.json()) as TelegramApiSendMessageResponse;
      if (!body.ok) {
        throw new TelegramApiRejectedError(body.description ?? 'Telegram sendMessage returned ok=false');
      }
      return typeof body.result?.message_id === 'number' ? { messageId: body.result.message_id } : undefined;
    },
    async editMessage(chatId: number, messageId: number, text: string, messageOptions?: TelegramMessageOptions): Promise<void> {
      const url = `https://api.telegram.org/bot${options.token}/editMessageText`;
      const response = await safeTelegramFetch(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: messageOptions?.parseMode === 'HTML' ? formatTelegramHtml(text, { maxLength: options.maxLength }) : formatTelegramMessage(text, { maxLength: options.maxLength }),
            ...(messageOptions?.parseMode ? { parse_mode: messageOptions.parseMode } : {}),
            ...(messageOptions?.inlineKeyboard?.length ? { reply_markup: { inline_keyboard: toTelegramInlineKeyboard(messageOptions.inlineKeyboard) } } : { reply_markup: { inline_keyboard: [] } }),
          }),
        },
        'editMessageText',
      );
      if (!response.ok) throw new TelegramApiRejectedError(`Telegram editMessageText failed: ${response.status}`, response.status);
      const body = (await response.json()) as TelegramApiSendMessageResponse;
      if (!body.ok && !body.description?.includes('message is not modified')) {
        throw new TelegramApiRejectedError(body.description ?? 'Telegram editMessageText returned ok=false');
      }
    },
    async sendDocument(chatId: number, filePath: string, caption?: string): Promise<void> {
      const url = `https://api.telegram.org/bot${options.token}/sendDocument`;
      const bytes = await readFile(filePath);
      const form = new FormData();
      form.set('chat_id', String(chatId));
      form.set('document', new Blob([bytes]), basename(filePath));
      if (caption) form.set('caption', formatTelegramMessage(caption, { maxLength: 900 }));
      const response = await safeTelegramFetch(fetchImpl, url, { method: 'POST', body: form }, 'sendDocument');
      if (!response.ok) throw new TelegramApiRejectedError(`Telegram sendDocument failed: ${response.status}`, response.status);
      const body = (await response.json()) as TelegramApiSendMessageResponse;
      if (!body.ok) throw new TelegramApiRejectedError(body.description ?? 'Telegram sendDocument returned ok=false');
    },
    async sendPhoto(chatId: number, filePath: string, caption?: string): Promise<void> {
      await sendTelegramFile({ fetchImpl, token: options.token, method: 'sendPhoto', field: 'photo', chatId, filePath, caption });
    },
    async answerCallbackQuery(callbackQueryId: string, callbackOptions = {}): Promise<void> {
      const response = await safeTelegramFetch(
        fetchImpl,
        `https://api.telegram.org/bot${options.token}/answerCallbackQuery`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callbackQueryId, ...(callbackOptions.text ? { text: formatTelegramMessage(callbackOptions.text, { maxLength: 180 }) } : {}), ...(callbackOptions.showAlert ? { show_alert: true } : {}) }),
        },
        'answerCallbackQuery',
      );
      if (!response.ok) throw new TelegramApiRejectedError(`Telegram answerCallbackQuery failed: ${response.status}`, response.status);
      const body = (await response.json()) as TelegramApiSendMessageResponse;
      if (!body.ok) throw new TelegramApiRejectedError(body.description ?? 'Telegram answerCallbackQuery returned ok=false');
    },
  };
}

/** Token 身份校验只返回 Bot 公共资料，调用方不得记录请求 URL 或 Token。 */
export async function getTelegramBotProfile(options: { token: string; fetch?: typeof fetch }): Promise<TelegramBotProfile> {
  const response = await safeTelegramFetch(options.fetch ?? fetch, `https://api.telegram.org/bot${options.token}/getMe`, undefined, 'getMe');
  if (!response.ok) throw new TelegramApiRejectedError(`Telegram getMe failed: ${response.status}`, response.status);
  const body = (await response.json()) as TelegramApiGetMeResponse;
  const profile = body.result;
  if (!body.ok || profile?.is_bot !== true || typeof profile.id !== 'number' || typeof profile.username !== 'string' || !profile.username || typeof profile.first_name !== 'string') {
    throw new TelegramApiRejectedError(body.description ?? 'Telegram getMe returned an invalid Bot identity');
  }
  return { id: profile.id, username: profile.username, firstName: profile.first_name, canJoinGroups: profile.can_join_groups === true };
}

export async function getTelegramRemoteFile(options: { token: string; fileId: string; fetch?: typeof fetch }): Promise<TelegramRemoteFile> {
  if (!options.fileId || options.fileId.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(options.fileId)) throw new Error('Telegram file identity is invalid.');
  const url = new URL(`https://api.telegram.org/bot${options.token}/getFile`);
  url.searchParams.set('file_id', options.fileId);
  const response = await safeTelegramFetch(options.fetch ?? fetch, url, undefined, 'getFile');
  if (!response.ok) throw new TelegramApiRejectedError(`Telegram getFile failed: ${response.status}`, response.status);
  const body = (await response.json()) as TelegramApiGetFileResponse;
  if (!body.ok || typeof body.result?.file_path !== 'string' || !body.result.file_path || typeof body.result.file_id !== 'string') {
    throw new TelegramApiRejectedError(body.description ?? 'Telegram getFile returned an invalid file identity');
  }
  return { fileId: body.result.file_id, filePath: body.result.file_path, fileSize: typeof body.result.file_size === 'number' ? body.result.file_size : null };
}

export async function downloadTelegramRemoteFile(options: { token: string; filePath: string; maximumBytes: number; fetch?: typeof fetch }): Promise<Uint8Array> {
  if (!isSafeTelegramFilePath(options.filePath)) throw new Error('Telegram file path is outside the allowed Bot API path form.');
  const response = await safeTelegramFetch(options.fetch ?? fetch, `https://api.telegram.org/file/bot${options.token}/${options.filePath}`, undefined, 'file download');
  if (!response.ok) throw new TelegramApiRejectedError(`Telegram file download failed: ${response.status}`, response.status);
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > options.maximumBytes) throw new Error('Telegram attachment exceeds the configured size limit.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > options.maximumBytes) throw new Error('Telegram attachment exceeds the configured size limit.');
  return bytes;
}

export function createTelegramLongPollingClient(options: { token: string; fetch?: typeof fetch; timeoutSeconds?: number; limit?: number }): TelegramLongPollingClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutSeconds = options.timeoutSeconds ?? 25;
  const limit = options.limit ?? 20;
  const fetchUpdates = async (offset: number, timeout: number): Promise<TelegramApiUpdate[]> => {
    const url = new URL(`https://api.telegram.org/bot${options.token}/getUpdates`);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('timeout', String(timeout));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('allowed_updates', JSON.stringify(['message', 'callback_query']));
    const response = await safeTelegramFetch(fetchImpl, url.toString(), undefined, 'getUpdates');
    if (!response.ok) throw new Error(`Telegram getUpdates failed: ${response.status}`);
    const body = (await response.json()) as TelegramApiGetUpdatesResponse;
    if (!body.ok) throw new Error(body.description ?? 'Telegram getUpdates returned ok=false');
    return body.result ?? [];
  };
  return {
    async poll(offset = 0): Promise<TelegramUpdate[]> {
      const rawUpdates = await fetchUpdates(offset, timeoutSeconds);
      if (rawUpdates.some((update) => Boolean(update.message?.media_group_id))) {
        let nextOffset = maximumRawUpdateId(rawUpdates) + 1;
        let quietUntil = Date.now() + mediaGroupQuietWindowMs;
        while (Date.now() < quietUntil) {
          await waitFor(Math.min(250, Math.max(1, quietUntil - Date.now())));
          const more = await fetchUpdates(nextOffset, 0);
          if (more.length === 0) continue;
          rawUpdates.push(...more);
          nextOffset = maximumRawUpdateId(rawUpdates) + 1;
          if (more.some((update) => Boolean(update.message?.media_group_id))) quietUntil = Date.now() + mediaGroupQuietWindowMs;
        }
      }
      return aggregateTelegramMediaGroups(rawUpdates.flatMap(normalizeTelegramUpdate));
    },
  };
}

/** 对单条 update 做白名单校验和命令解析，返回可落审计日志的结构。 */
export function dispatchTelegramUpdate(update: TelegramUpdate, options: { allowedUserIds: number[] }): TelegramDispatchResult {
  const allowed = options.allowedUserIds.includes(update.userId);
  const rawCommand = extractTelegramRawCommand(update.text);
  let command: TelegramCommand | undefined;
  try {
    command = update.callbackData ? parseTelegramCallbackData(update.callbackData) : parseTelegramCommand(update.text);
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

/** 只允许 Telegram 支持的安全 HTML 子集；普通模型文本先转义，再由明确标记转换。 */
export function formatTelegramHtml(input: string, options: { maxLength?: number } = {}): string {
  const maximum = options.maxLength ?? defaultTelegramMaxLength;
  const redacted = redactSensitiveText(input);
  const render = (value: string): string =>
    value
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
      .replace(/\*\*([^*\n]+)\*\*/gu, '<b>$1</b>')
      .replace(/`([^`\n]+)`/gu, '<code>$1</code>');
  const points = [...redacted];
  if (points.length <= maximum) return render(redacted);
  return render(`${points.slice(0, Math.max(0, maximum - 1)).join('')}…`);
}

function normalizeTelegramUpdate(update: TelegramApiUpdate): TelegramUpdate[] {
  const updateId = update.update_id;
  const chatId = update.message?.chat?.id;
  const userId = update.message?.from?.id;
  const text = update.message?.text ?? update.message?.caption ?? '';
  if (typeof updateId === 'number' && typeof chatId === 'number' && typeof userId === 'number' && (typeof text === 'string' || telegramMessageAttachments(update.message).length > 0)) {
    return [
      {
        updateId,
        chatId,
        userId,
        text,
        messageId: update.message?.message_id,
        chatType: normalizeChatType(update.message?.chat?.type),
        senderDisplayName: telegramSenderDisplayName(update.message?.from),
        ...(update.message?.media_group_id ? { mediaGroupId: update.message.media_group_id } : {}),
        attachments: telegramMessageAttachments(update.message),
      },
    ];
  }
  const callback = update.callback_query;
  const callbackChatId = callback?.message?.chat?.id;
  const callbackUserId = callback?.from?.id;
  const callbackData = callback?.data;
  if (typeof updateId === 'number' && typeof callbackChatId === 'number' && typeof callbackUserId === 'number' && typeof callbackData === 'string') {
    return [
      {
        updateId,
        chatId: callbackChatId,
        userId: callbackUserId,
        text: callbackData,
        messageId: callback?.message?.message_id,
        callbackQueryId: callback?.id,
        callbackData,
        chatType: normalizeChatType(callback?.message?.chat?.type),
        senderDisplayName: telegramSenderDisplayName(callback?.from),
        attachments: [],
      },
    ];
  }
  return [];
}

/** 相册按 chat/user/media_group_id 合并为一个稳定 update，交给上层作为一次用户意图处理。 */
function aggregateTelegramMediaGroups(updates: TelegramUpdate[]): TelegramUpdate[] {
  const groups = new Map<string, TelegramUpdate[]>();
  const independent: TelegramUpdate[] = [];
  for (const update of updates) {
    if (!update.mediaGroupId) {
      independent.push(update);
      continue;
    }
    const key = `${update.chatId}:${update.userId}:${update.mediaGroupId}`;
    const group = groups.get(key) ?? [];
    group.push(update);
    groups.set(key, group);
  }
  const aggregated = [...groups.values()].map((group) => {
    const ordered = [...group].sort((left, right) => left.updateId - right.updateId);
    const last = ordered.at(-1)!;
    const captions = [...new Set(ordered.map((item) => item.text.trim()).filter(Boolean))];
    return {
      ...last,
      updateId: Math.max(...ordered.map((item) => item.updateId)),
      messageId: last.messageId,
      text: captions.join('\n'),
      attachments: ordered.flatMap((item) => item.attachments ?? []),
    };
  });
  return [...independent, ...aggregated].sort((left, right) => left.updateId - right.updateId);
}

function maximumRawUpdateId(updates: TelegramApiUpdate[]): number {
  return updates.reduce((maximum, update) => (typeof update.update_id === 'number' ? Math.max(maximum, update.update_id) : maximum), 0);
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 网络异常不得把包含 Bot Token 的请求 URL 带入上层错误、日志或命令回执。 */
async function safeTelegramFetch(fetchImpl: typeof fetch, input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], operation: string): Promise<Response> {
  try {
    return await fetchImpl(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(45_000) });
  } catch {
    throw new Error(`Telegram ${operation} network request failed.`);
  }
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
  lastSuccessfulPollAt: string | null;
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

export interface TelegramCommandResponse {
  text: string;
  inlineKeyboard?: TelegramInlineKeyboardButton[][];
  editOriginalMessage?: boolean;
}

export interface TelegramReplyOptions extends TelegramMessageOptions {
  editMessageId?: number;
}

/** Telegram 后台轮询服务：只消费真实 client 返回的 update，并记录可审计日志。 */
export function createTelegramPollingService(options: {
  client: TelegramLongPollingClient;
  allowedUserIds: number[];
  initialOffset?: number;
  maxLogs?: number;
  reply?: (chatId: number, text: string, options?: TelegramReplyOptions) => Promise<TelegramSentMessage | void>;
  handleCommand?: (command: TelegramCommand, update: TelegramUpdate) => Promise<string | TelegramCommandResponse | undefined>;
  /** 新 IM 桥负责配对、可信端点和普通消息时使用；存在时不再经过旧命令白名单分发。 */
  handleUpdate?: (update: TelegramUpdate) => Promise<string | TelegramCommandResponse | undefined>;
  onPollComplete?: (status: TelegramPollingStatus) => void | Promise<void>;
}): TelegramPollingService {
  let running = false;
  let offset = options.initialOffset ?? 0;
  let lastError: string | null = null;
  let handledUpdates = 0;
  let lastSuccessfulPollAt: string | null = null;
  const maxLogs = options.maxLogs ?? 200;
  const logs: TelegramPollingLogEntry[] = [];

  function snapshot(): TelegramPollingStatus {
    return { running, offset, lastError, handledUpdates, lastSuccessfulPollAt };
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
          if (options.handleUpdate) {
            const response = await options.handleUpdate(update);
            appendLog({ updateId: update.updateId, chatId: update.chatId, userId: update.userId, command: update.callbackData ? 'callback' : update.text.startsWith('/') ? extractTelegramRawCommand(update.text) : 'message', allowed: true });
            if (options.reply && response) {
              if (typeof response === 'string') await options.reply(update.chatId, response);
              else await options.reply(update.chatId, response.text, { inlineKeyboard: response.inlineKeyboard, editMessageId: response.editOriginalMessage ? update.messageId : undefined });
            }
            handledUpdates += 1;
            offset = Math.max(offset, update.updateId + 1);
            continue;
          }
          const result = dispatchTelegramUpdate(update, {
            allowedUserIds: options.allowedUserIds,
          });
          appendLog(result.auditEvent);
          if (result.allowed && result.reason && options.reply) {
            await options.reply(update.chatId, result.reason);
          }
          if (result.allowed && result.command && options.reply && options.handleCommand) {
            const commandResponse = await options.handleCommand(result.command, update);
            if (typeof commandResponse === 'string') {
              await options.reply(update.chatId, commandResponse);
            } else if (commandResponse) {
              await options.reply(update.chatId, commandResponse.text, {
                inlineKeyboard: commandResponse.inlineKeyboard,
                editMessageId: commandResponse.editOriginalMessage ? update.messageId : undefined,
              });
            }
          }
          handledUpdates += 1;
          offset = Math.max(offset, update.updateId + 1);
        }
        lastError = null;
        lastSuccessfulPollAt = new Date().toISOString();
        await options.onPollComplete?.(snapshot());
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

function telegramMessageAttachments(message: TelegramApiMessage | undefined): TelegramInboundAttachment[] {
  if (!message) return [];
  const selectedPhoto = message.photo?.filter((item) => typeof item.file_id === 'string').sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
  const entries: Array<[TelegramInboundAttachmentKind, TelegramApiFile | undefined]> = [
    ['photo', selectedPhoto],
    ['document', message.document],
    ['audio', message.audio],
    ['voice', message.voice],
    ['video', message.video],
    ['video_note', message.video_note],
  ];
  return entries.flatMap(([kind, file]) =>
    typeof file?.file_id === 'string'
      ? [
          {
            kind,
            fileId: file.file_id,
            fileUniqueId: typeof file.file_unique_id === 'string' ? file.file_unique_id : null,
            fileName: typeof file.file_name === 'string' ? file.file_name : null,
            mimeType: typeof file.mime_type === 'string' ? file.mime_type : kind === 'photo' ? 'image/jpeg' : null,
            fileSize: typeof file.file_size === 'number' ? file.file_size : null,
          },
        ]
      : [],
  );
}

function telegramSenderDisplayName(from: TelegramApiMessage['from']): string | null {
  const name = [from?.first_name, from?.last_name]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join(' ')
    .trim();
  return name || (typeof from?.username === 'string' ? `@${from.username}` : null);
}

function normalizeChatType(value: string | undefined): TelegramUpdate['chatType'] {
  return value === 'private' || value === 'group' || value === 'supergroup' || value === 'channel' ? value : 'unknown';
}

function isSafeTelegramFilePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.startsWith('/') && !value.includes('..') && /^[A-Za-z0-9_./-]+$/u.test(value);
}

async function sendTelegramFile(input: { fetchImpl: typeof fetch; token: string; method: 'sendPhoto'; field: 'photo'; chatId: number; filePath: string; caption?: string }): Promise<void> {
  const bytes = await readFile(input.filePath);
  const form = new FormData();
  form.set('chat_id', String(input.chatId));
  form.set(input.field, new Blob([bytes]), basename(input.filePath));
  if (input.caption) form.set('caption', formatTelegramMessage(input.caption, { maxLength: 900 }));
  const response = await safeTelegramFetch(input.fetchImpl, `https://api.telegram.org/bot${input.token}/${input.method}`, { method: 'POST', body: form }, input.method);
  if (!response.ok) throw new TelegramApiRejectedError(`Telegram ${input.method} failed: ${response.status}`, response.status);
  const body = (await response.json()) as TelegramApiSendMessageResponse;
  if (!body.ok) throw new TelegramApiRejectedError(body.description ?? `Telegram ${input.method} returned ok=false`);
}

function parseTelegramCallbackData(data: string): TelegramCommand {
  const [namespace, action, ...parts] = data.split('|');
  if (namespace !== 'zc') throw new Error('Unsupported Zeus Telegram callback');
  if (action === 'ps') return { command: 'commands', args: [] };
  if (action === 'p' && parts[0]) return { command: 'commands', args: [decodeCallbackPart(parts[0])] };
  if (action === 'd' && parts[0] && parts[1]) {
    return { command: 'command', args: ['detail', decodeCallbackPart(parts[0]), decodeCallbackPart(parts[1])] };
  }
  if (action === 'r' && parts[0] && parts[1]) {
    return { command: 'command', args: ['run', decodeCallbackPart(parts[0]), decodeCallbackPart(parts[1])] };
  }
  throw new Error('Unsupported Zeus Telegram callback');
}

function decodeCallbackPart(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function toTelegramInlineKeyboard(rows: TelegramInlineKeyboardButton[][]): Array<Array<{ text: string; callback_data: string }>> {
  return rows.map((row) =>
    row.map((button) => ({
      text: button.text.slice(0, 64),
      callback_data: button.callbackData.slice(0, 64),
    })),
  );
}
