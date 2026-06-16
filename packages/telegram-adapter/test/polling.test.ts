import { describe, expect, it } from 'vitest';
import { createTelegramLongPollingClient, dispatchTelegramUpdate, formatTelegramMessage } from '../src/index.js';

describe('Telegram long polling adapter', () => {
  it('polls real Telegram update contracts with offset and token without fabricating messages', async () => {
    const requestedUrls: string[] = [];
    const client = createTelegramLongPollingClient({
      token: 'telegram-token-real',
      fetch: async (url) => {
        requestedUrls.push(String(url));
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 41,
                message: {
                  message_id: 7,
                  chat: { id: 1001 },
                  from: { id: 42 },
                  text: '/tasks project_real',
                },
              },
            ],
          }),
        };
      },
    });

    const updates = await client.poll(40);

    expect(requestedUrls[0]).toContain('/bottelegram-token-real/getUpdates');
    expect(requestedUrls[0]).toContain('offset=40');
    expect(updates).toEqual([{ updateId: 41, chatId: 1001, userId: 42, text: '/tasks project_real' }]);
  });

  it('dispatches only allowed users and records rejected commands for audit', async () => {
    const allowed = dispatchTelegramUpdate({ updateId: 1, chatId: 1001, userId: 42, text: '/projects' }, { allowedUserIds: [42] });
    const rejected = dispatchTelegramUpdate({ updateId: 2, chatId: 1002, userId: 99, text: '/projects' }, { allowedUserIds: [42] });

    expect(allowed).toEqual({
      allowed: true,
      command: { command: 'projects', args: [] },
      auditEvent: {
        updateId: 1,
        chatId: 1001,
        userId: 42,
        command: 'projects',
        allowed: true,
      },
    });
    expect(rejected).toEqual({
      allowed: false,
      reason: 'Telegram 用户不在 Zeus 白名单。',
      auditEvent: {
        updateId: 2,
        chatId: 1002,
        userId: 99,
        command: 'projects',
        allowed: false,
      },
    });
  });

  it('returns a helpful error for unknown commands from whitelisted users without leaking help to others', () => {
    const allowedUnknown = dispatchTelegramUpdate({ updateId: 3, chatId: 1001, userId: 42, text: '/deploy now' }, { allowedUserIds: [42] });
    const rejectedUnknown = dispatchTelegramUpdate({ updateId: 4, chatId: 1002, userId: 99, text: '/deploy now' }, { allowedUserIds: [42] });

    expect(allowedUnknown).toMatchObject({
      allowed: true,
      reason: '未知 Zeus 远程命令：/deploy。发送 /help 查看可用命令。',
      auditEvent: {
        updateId: 3,
        chatId: 1001,
        userId: 42,
        command: 'deploy',
        allowed: true,
      },
    });
    expect(allowedUnknown.command).toBeUndefined();
    expect(rejectedUnknown).toMatchObject({
      allowed: false,
      reason: 'Telegram 用户不在 Zeus 白名单。',
      auditEvent: {
        updateId: 4,
        chatId: 1002,
        userId: 99,
        command: 'deploy',
        allowed: false,
      },
    });
  });

  it('redacts sensitive text and truncates long Telegram messages', () => {
    const message = formatTelegramMessage(`token=abc123 ${'x'.repeat(4100)}`, {
      maxLength: 80,
    });

    expect(message).toContain('token=[REDACTED]');
    expect(message.length).toBeLessThanOrEqual(80);
    expect(message).toContain('已截断');
  });

  it('redacts authorization cookies ssh private keys and env secrets before sending Telegram messages', () => {
    const message = formatTelegramMessage(
      ['Authorization: Bearer telegram-secret', 'Cookie: session=telegram-cookie', 'DATABASE_PASSWORD="telegram-db-password"', '-----BEGIN OPENSSH PRIVATE KEY-----', 'telegram-private-key', '-----END OPENSSH PRIVATE KEY-----'].join('\n'),
      { maxLength: 1000 },
    );

    expect(message).toContain('Authorization: Bearer [REDACTED]');
    expect(message).toContain('Cookie: [REDACTED]');
    expect(message).toContain('DATABASE_PASSWORD=[REDACTED]');
    expect(message).toContain('[REDACTED SSH PRIVATE KEY]');
    expect(message).not.toContain('telegram-secret');
    expect(message).not.toContain('telegram-cookie');
    expect(message).not.toContain('telegram-db-password');
    expect(message).not.toContain('telegram-private-key');
  });
});
