import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalServer } from '../src/index.js';
import type { SecretStore } from '@zeus/security-core';

const tmpRoots: string[] = [];

function createMemorySecretStore(token?: string): SecretStore {
  const values = new Map<string, string>();
  if (token) values.set('telegram.botToken', token);
  return {
    getSecret: async (key) => values.get(key),
    setSecret: async (key, value) => {
      values.set(key, value);
    },
    deleteSecret: async (key) => {
      values.delete(key);
    },
  };
}

async function createTmpDb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zeus-telegram-api-'));
  tmpRoots.push(root);
  return join(root, 'zeus.json');
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Telegram local API', () => {
  it('rejects Telegram test connection when token or notification chat ids are missing', async () => {
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/telegram/test',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'ZEUS_TELEGRAM_UNCONFIGURED',
    });
  });

  it('sends a real Telegram test notification through the configured sender without exposing token values', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      telegramNotificationChatIds: [1001, 1002],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramMessageSender: {
        sendMessage: async (chatId, text) => {
          sent.push({ chatId, text });
        },
      },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/telegram/test',
      headers: { authorization: 'Bearer test-token' },
    });
    const audit = await server.inject({
      method: 'GET',
      url: '/api/security/audit-logs',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      chatIds: [1001, 1002],
      attempts: 1,
    });
    expect(sent.map((item) => item.chatId)).toEqual([1001, 1002]);
    expect(sent.every((item) => item.text.includes('Zeus Telegram 测试连接'))).toBe(true);
    expect(JSON.stringify(response.json())).not.toContain('telegram-token-real');
    expect(JSON.stringify(audit.json())).not.toContain('telegram-token-real');
    expect(audit.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'telegram.test.sent',
          resourceType: 'telegram',
          resourceId: 'notification-settings',
        }),
      ]),
    );
  });

  it('reports disabled state when token or allowed users are missing', async () => {
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramToken: 'real-token',
    });
    const response = await server.inject({
      method: 'GET',
      url: '/api/settings/runtime-status',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().telegram).toMatchObject({
      enabled: false,
      reason: 'Telegram allowed user id 未配置。',
    });
  });

  it('serves design-book Telegram status, settings, start, and stop aliases without exposing token values', async () => {
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('real-token'),
      telegramPollingClient: { poll: async () => [] },
      telegramMessageSender: { sendMessage: async () => undefined },
    });

    const saved = await server.inject({
      method: 'PATCH',
      url: '/api/telegram/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        enabled: true,
        chatIds: [1001, 1001, 1002],
        silentMode: true,
        allowedUserIds: [42, 42, 1001],
      },
    });
    const started = await server.inject({
      method: 'POST',
      url: '/api/telegram/start',
      headers: { authorization: 'Bearer test-token' },
    });
    const status = await server.inject({
      method: 'GET',
      url: '/api/telegram/status',
      headers: { authorization: 'Bearer test-token' },
    });
    const stopped = await server.inject({
      method: 'POST',
      url: '/api/telegram/stop',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      notificationSettings: {
        enabled: true,
        chatIds: [1001, 1002],
        silentMode: true,
      },
      securitySettings: { allowedUserIds: [42, 1001] },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ running: true });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      configured: true,
      polling: { running: true },
      notificationSettings: {
        enabled: true,
        chatIds: [1001, 1002],
        silentMode: true,
      },
      securitySettings: { allowedUserIds: [42, 1001] },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ running: false });
    expect(JSON.stringify([saved.json(), started.json(), status.json(), stopped.json()])).not.toContain('real-token');
  });

  it('serves design-book Telegram messages from real polling logs', async () => {
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('real-token'),
      telegramPollingClient: {
        poll: async () => [{ updateId: 10, chatId: 1001, userId: 42, text: '/projects' }],
      },
      telegramMessageSender: { sendMessage: async () => undefined },
    });

    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    const response = await server.inject({
      method: 'GET',
      url: '/api/telegram/messages',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          updateId: 10,
          chatId: 1001,
          userId: 42,
          command: 'projects',
          allowed: true,
        }),
      ]),
    );
    expect(JSON.stringify(response.json())).not.toContain('real-token');
  });

  it('previews allowed Telegram commands and rejects non-whitelisted users', async () => {
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramToken: 'real-token',
      telegramAllowedUserIds: [42],
    });
    const allowed = await server.inject({
      method: 'POST',
      url: '/api/telegram/dispatch-preview',
      headers: { authorization: 'Bearer test-token' },
      payload: { updateId: 10, chatId: 1001, userId: 42, text: '/projects' },
    });
    const rejected = await server.inject({
      method: 'POST',
      url: '/api/telegram/dispatch-preview',
      headers: { authorization: 'Bearer test-token' },
      payload: { updateId: 11, chatId: 1002, userId: 99, text: '/projects' },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      allowed: true,
      command: { command: 'projects', args: [] },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      allowed: false,
      reason: 'Telegram 用户不在 Zeus 白名单。',
    });
  });

  it('reads and updates Telegram notification settings without exposing token values', async () => {
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramToken: 'real-token',
      telegramAllowedUserIds: [42],
      telegramNotificationChatIds: [1001],
    });
    const before = await server.inject({
      method: 'GET',
      url: '/api/telegram/notification-settings',
      headers: { authorization: 'Bearer test-token' },
    });
    const updated = await server.inject({
      method: 'PUT',
      url: '/api/telegram/notification-settings',
      headers: { authorization: 'Bearer test-token' },
      payload: { enabled: true, chatIds: [1002, 1003], silentMode: true },
    });

    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({
      enabled: true,
      chatIds: [1001],
      silentMode: false,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      enabled: true,
      chatIds: [1002, 1003],
      silentMode: true,
    });
    expect(JSON.stringify(updated.json())).not.toContain('real-token');
  });

  it('persists Telegram notification settings after local server restart', async () => {
    const dbPath = await createTmpDb();
    const firstServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      telegramToken: 'real-token',
      telegramAllowedUserIds: [42],
      telegramNotificationChatIds: [1001],
    });
    await firstServer.inject({
      method: 'PUT',
      url: '/api/telegram/notification-settings',
      headers: { authorization: 'Bearer test-token' },
      payload: { enabled: true, chatIds: [2001], silentMode: true },
    });
    await firstServer.close();

    const secondServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      telegramToken: 'real-token',
      telegramAllowedUserIds: [42],
      telegramNotificationChatIds: [1001],
    });
    const restored = await secondServer.inject({
      method: 'GET',
      url: '/api/telegram/notification-settings',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(restored.json()).toEqual({
      enabled: true,
      chatIds: [2001],
      silentMode: true,
    });
    await secondServer.close();
  });

  it('persists Telegram allowed user ids and uses them for runtime status and dispatch preview', async () => {
    const dbPath = await createTmpDb();
    const firstServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      telegramToken: 'real-token',
    });
    const before = await firstServer.inject({
      method: 'GET',
      url: '/api/settings/runtime-status',
      headers: { authorization: 'Bearer test-token' },
    });
    const saved = await firstServer.inject({
      method: 'PUT',
      url: '/api/telegram/security-settings',
      headers: { authorization: 'Bearer test-token' },
      payload: { allowedUserIds: [42, 42, -1, 1001] },
    });
    await firstServer.close();

    const secondServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      telegramToken: 'real-token',
    });
    const restored = await secondServer.inject({
      method: 'GET',
      url: '/api/telegram/security-settings',
      headers: { authorization: 'Bearer test-token' },
    });
    const status = await secondServer.inject({
      method: 'GET',
      url: '/api/settings/runtime-status',
      headers: { authorization: 'Bearer test-token' },
    });
    const allowed = await secondServer.inject({
      method: 'POST',
      url: '/api/telegram/dispatch-preview',
      headers: { authorization: 'Bearer test-token' },
      payload: { updateId: 10, chatId: 1001, userId: 42, text: '/projects' },
    });
    const rejected = await secondServer.inject({
      method: 'POST',
      url: '/api/telegram/dispatch-preview',
      headers: { authorization: 'Bearer test-token' },
      payload: { updateId: 11, chatId: 1002, userId: 99, text: '/projects' },
    });

    expect(before.json().telegram).toMatchObject({
      enabled: false,
      reason: 'Telegram allowed user id 未配置。',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ allowedUserIds: [42, 1001] });
    expect(restored.json()).toEqual({ allowedUserIds: [42, 1001] });
    expect(status.json().telegram).toMatchObject({
      enabled: true,
      reason: 'Telegram long polling 可启用。',
    });
    expect(allowed.json()).toMatchObject({
      allowed: true,
      command: { command: 'projects', args: [] },
    });
    expect(rejected.json()).toMatchObject({
      allowed: false,
      reason: 'Telegram 用户不在 Zeus 白名单。',
    });
    await secondServer.close();
  });
});
