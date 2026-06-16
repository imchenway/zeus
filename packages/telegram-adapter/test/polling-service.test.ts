import { describe, expect, it } from 'vitest';
import { createTelegramPollingService, type TelegramLongPollingClient } from '../src/index.js';

describe('Telegram polling service', () => {
  it('starts, polls updates once, records audit logs, advances offset, and stops', async () => {
    const client: TelegramLongPollingClient = {
      poll: async (offset = 0) => [
        { updateId: offset + 1, chatId: 1001, userId: 42, text: '/projects' },
        {
          updateId: offset + 2,
          chatId: 1002,
          userId: 99,
          text: '/tasks project_real',
        },
      ],
    };
    const service = createTelegramPollingService({
      client,
      allowedUserIds: [42],
    });

    expect(service.status()).toEqual({
      running: false,
      offset: 0,
      lastError: null,
      handledUpdates: 0,
    });
    await service.start();
    await service.pollOnce();
    await service.stop();

    expect(service.status()).toEqual({
      running: false,
      offset: 3,
      lastError: null,
      handledUpdates: 2,
    });
    expect(service.logs()).toEqual([
      {
        updateId: 1,
        chatId: 1001,
        userId: 42,
        command: 'projects',
        allowed: true,
      },
      {
        updateId: 2,
        chatId: 1002,
        userId: 99,
        command: 'tasks',
        allowed: false,
      },
    ]);
  });

  it('keeps running state and records errors when polling fails', async () => {
    const client: TelegramLongPollingClient = {
      poll: async () => {
        throw new Error('network down');
      },
    };
    const service = createTelegramPollingService({
      client,
      allowedUserIds: [42],
    });

    await service.start();
    await service.pollOnce();

    expect(service.status()).toEqual({
      running: true,
      offset: 0,
      lastError: 'network down',
      handledUpdates: 0,
    });
    expect(service.logs()).toEqual([
      {
        updateId: null,
        chatId: null,
        userId: null,
        command: 'poll',
        allowed: false,
        error: 'network down',
      },
    ]);
  });

  it('replies with help for unknown whitelisted commands and still advances the update offset', async () => {
    const replies: Array<{ chatId: number; text: string }> = [];
    const client: TelegramLongPollingClient = {
      poll: async (offset = 0) => [{ updateId: offset + 1, chatId: 1001, userId: 42, text: '/deploy now' }],
    };
    const service = createTelegramPollingService({
      client,
      allowedUserIds: [42],
      reply: async (chatId, text) => {
        replies.push({ chatId, text });
      },
      handleCommand: async () => '不应执行未知命令处理器',
    });

    await service.start();
    await service.pollOnce();

    expect(service.status()).toEqual({
      running: true,
      offset: 2,
      lastError: null,
      handledUpdates: 1,
    });
    expect(replies).toEqual([
      {
        chatId: 1001,
        text: '未知 Zeus 远程命令：/deploy。发送 /help 查看可用命令。',
      },
    ]);
    expect(service.logs()).toEqual([
      {
        updateId: 1,
        chatId: 1001,
        userId: 42,
        command: 'deploy',
        allowed: true,
      },
    ]);
  });
});
