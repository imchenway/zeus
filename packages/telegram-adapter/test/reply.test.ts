import { describe, expect, it } from 'vitest';
import { createTelegramBotMessageClient, createTelegramPollingService, type TelegramLongPollingClient } from '../src/index.js';

describe('Telegram reply sender', () => {
  it('sends redacted text through Telegram Bot API sendMessage contract', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const sender = createTelegramBotMessageClient({
      token: 'telegram-token-real',
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        };
      },
    });

    await sender.sendMessage(1001, 'token=abc123 项目列表');

    expect(requests[0].url).toContain('/bottelegram-token-real/sendMessage');
    expect(requests[0].body).toEqual({
      chat_id: 1001,
      text: 'token=[REDACTED] 项目列表',
    });
  });

  it('sends command replies only for allowed Telegram users', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const client: TelegramLongPollingClient = {
      poll: async () => [
        { updateId: 1, chatId: 1001, userId: 42, text: '/projects' },
        { updateId: 2, chatId: 1002, userId: 99, text: '/projects' },
      ],
    };
    const service = createTelegramPollingService({
      client,
      allowedUserIds: [42],
      reply: async (chatId, text) => sent.push({ chatId, text }),
      handleCommand: async (command) => `已处理 ${command.command}`,
    });

    await service.start();
    await service.pollOnce();

    expect(sent).toEqual([{ chatId: 1001, text: '已处理 projects' }]);
    expect(service.logs()).toContainEqual({
      updateId: 2,
      chatId: 1002,
      userId: 99,
      command: 'projects',
      allowed: false,
    });
  });
});
