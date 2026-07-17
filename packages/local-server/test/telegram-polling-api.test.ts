import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalServer } from '../src/index.js';
import { AuditLogRepository, createZeusDatabase } from '@zeus/storage';
import { createAiRuntimeSessionManager, type AiRuntimeProcessHandle, type AiRuntimeSpawn, type CodexAppServerManager } from '@zeus/ai-runtime';
import type { SecretStore } from '@zeus/security-core';
import type { TelegramLongPollingClient, TelegramMessageSender } from '@zeus/telegram-adapter';

const tmpRoots: string[] = [];

function createMemorySecretStore(token: string): SecretStore {
  return {
    async setSecret() {},
    async getSecret(account) {
      return account === 'telegram.botToken' ? token : undefined;
    },
    async deleteSecret() {},
  };
}

async function createTmpDb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zeus-telegram-polling-api-'));
  tmpRoots.push(root);
  return join(root, 'zeus.json');
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Telegram polling local API', () => {
  it('sends real Telegram notifications for important task status changes', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const dbPath = await createTmpDb();
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      telegramAllowedUserIds: [1001],
      telegramNotificationChatIds: [1001],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramMessageSender: sender,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    const project = projectResponse.json();
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '通知任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-notify-test' },
      },
    });
    const taskId = taskResponse.json().id;

    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'ready' },
    });
    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'running' },
    });
    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'completed' },
    });
    const events = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/events`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sent.map((item) => item.chatId)).toEqual([1001, 1001]);
    expect(sent[0].text).toContain('任务开始');
    expect(sent[0].text).toContain('通知任务');
    expect(sent[1].text).toContain('任务完成');
    expect(events.json().map((event: { eventType: string }) => event.eventType)).toContain('telegram.notification.sent');
  });

  it('keeps critical Telegram notifications in silent mode while suppressing routine task updates', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramAllowedUserIds: [1001],
      telegramNotificationChatIds: [1001],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramMessageSender: sender,
    });
    await server.inject({
      method: 'PUT',
      url: '/api/telegram/notification-settings',
      headers: { authorization: 'Bearer test-token' },
      payload: { enabled: true, chatIds: [1001], silentMode: true },
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    const project = projectResponse.json();
    const waitingTaskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '等待确认任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-silent-waiting-test' },
      },
    });
    const waitingTaskId = waitingTaskResponse.json().id;
    const completedTaskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '完成任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-silent-completed-test' },
      },
    });
    const completedTaskId = completedTaskResponse.json().id;

    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${waitingTaskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'ready' },
    });
    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${waitingTaskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'running' },
    });
    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${waitingTaskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'waiting_confirmation' },
    });
    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${waitingTaskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'failed' },
    });
    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${completedTaskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'ready' },
    });
    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${completedTaskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'running' },
    });
    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${completedTaskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'completed' },
    });

    expect(sent.map((item) => item.text)).toHaveLength(2);
    expect(sent[0].text).toContain('任务等待确认');
    expect(sent[0].text).toContain('等待确认任务');
    expect(sent[1].text).toContain('任务失败');
    expect(sent[1].text).toContain('等待确认任务');
    expect(sent.map((item) => item.text).join('\n')).not.toContain('任务开始');
    expect(sent.map((item) => item.text).join('\n')).not.toContain('任务完成');
    expect(sent.map((item) => item.text).join('\n')).not.toContain('完成任务');
  });

  it('retries a failed Telegram notification before recording it as sent', async () => {
    let attempts = 0;
    const sender: TelegramMessageSender = {
      sendMessage: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('temporary telegram outage');
        }
      },
    };
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramAllowedUserIds: [1001],
      telegramNotificationChatIds: [1001],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramMessageSender: sender,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    const project = projectResponse.json();
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '重试通知任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-retry-test' },
      },
    });
    const taskId = taskResponse.json().id;

    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'running' },
    });
    const events = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/events`,
      headers: { authorization: 'Bearer test-token' },
    });
    const eventTypes = events.json().map((event: { eventType: string }) => event.eventType);

    expect(attempts).toBe(2);
    expect(eventTypes).toContain('telegram.notification.sent');
    expect(eventTypes).not.toContain('telegram.notification.failed');
    expect(events.json().find((event: { eventType: string; payloadJson: string }) => event.eventType === 'telegram.notification.sent').payloadJson).toContain('"attempts":2');
  });

  it('records Telegram notification failure after exhausting retry attempts', async () => {
    let attempts = 0;
    const sender: TelegramMessageSender = {
      sendMessage: async () => {
        attempts += 1;
        throw new Error('telegram unavailable');
      },
    };
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramAllowedUserIds: [1001],
      telegramNotificationChatIds: [1001],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramMessageSender: sender,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    const project = projectResponse.json();
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '失败通知任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-retry-fail-test' },
      },
    });
    const taskId = taskResponse.json().id;

    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'running' },
    });
    const events = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/events`,
      headers: { authorization: 'Bearer test-token' },
    });
    const failedEvent = events.json().find((event: { eventType: string }) => event.eventType === 'telegram.notification.failed');

    expect(attempts).toBe(3);
    expect(failedEvent.payloadJson).toContain('"attempts":3');
    expect(failedEvent.payloadJson).toContain('telegram unavailable');
  });

  it('sends business replies for allowed Telegram project and task commands', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let taskId = '';
    const client: TelegramLongPollingClient = {
      poll: async () => [
        { updateId: 7, chatId: 1001, userId: 42, text: '/projects' },
        { updateId: 8, chatId: 1001, userId: 42, text: '/tasks' },
        { updateId: 9, chatId: 1001, userId: 42, text: '/help' },
        { updateId: 10, chatId: 1001, userId: 42, text: `/status ${taskId}` },
      ],
    };
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      telegramNotificationChatIds: [],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: sender,
    });
    await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        id: 'ignored',
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    const projectsResponse = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
    });
    const projectId = projectsResponse.json()[0].id;
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId,
        title: '远程任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-test' },
      },
    });
    taskId = taskResponse.json().id;
    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}/status`,
      headers: { authorization: 'Bearer test-token' },
      payload: { status: 'running' },
    });

    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sent[0].text).toContain('项目列表');
    expect(sent[0].text).toContain('Zeus');
    expect(sent[1].text).toContain('任务列表');
    expect(sent[1].text).toContain('远程任务');
    expect(sent[1].text).toContain('状态：running');
    expect(sent[1].text).toContain('更新：');
    expect(sent[1].text).toContain('下一步：/status');
    expect(sent[2].text).toContain('/run <project> <task>');
    expect(sent[2].text).toContain('/stop <task>');
    expect(sent[2].text).toContain('/continue <task>');
    expect(sent[2].text).toContain('/help');
    expect(sent[2].text).toContain('白名单用户：1');
    expect(sent[2].text).toContain('Token：已配置');
    expect(sent[2].text).toContain('Polling：运行中');
    expect(sent[2].text).toContain('默认禁止远程执行任意 shell');
    expect(sent[2].text).not.toContain('telegram-token-real');
    expect(sent[3].text).toContain('任务状态：远程任务');
    expect(sent[3].text).toContain('状态：running');
    expect(sent[3].text).toContain('Runtime：暂无运行中会话');
    expect(sent[3].text).toContain('最近事件：');
    expect(sent[3].text).toContain('任务已开始');
    expect(sent[3].text).toContain('下一步：/status');
  });

  it('replies to /logs and /diff with real runtime logs and readonly git diff data', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let taskId = '';
    let diffConfirmationId = '';
    let pollStep = 0;
    const client: TelegramLongPollingClient = {
      poll: async () => {
        pollStep += 1;
        if (pollStep === 1) {
          return [
            { updateId: 21, chatId: 1001, userId: 42, text: `/logs ${taskId}` },
            { updateId: 22, chatId: 1001, userId: 42, text: `/diff ${taskId}` },
          ];
        }
        if (pollStep === 2)
          return [
            {
              updateId: 23,
              chatId: 1001,
              userId: 42,
              text: `/confirm ${diffConfirmationId}`,
            },
          ];
        return [];
      },
    };
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const spawn: AiRuntimeSpawn = () => {
      const callbacks = new Map<string, Array<(value: unknown) => void>>();
      const handle: AiRuntimeProcessHandle = {
        pid: 42,
        on(event, callback) {
          const entries = callbacks.get(event) ?? [];
          entries.push(callback as (value: unknown) => void);
          callbacks.set(event, entries);
          return handle;
        },
        kill() {},
      };
      queueMicrotask(() => {
        callbacks.get('stdout')?.forEach((callback) => callback('真实 Runtime 日志 for Telegram'));
        callbacks.get('exit')?.forEach((callback) => callback(0));
      });
      return handle;
    };
    const aiRuntimeManager = createAiRuntimeSessionManager({
      allowedRoot: '/Users/david/hypha/zeus',
      spawn,
      now: () => '2026-06-13T00:00:00.000Z',
    });
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: sender,
      aiRuntimeManager,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    const project = projectResponse.json();
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '远程日志任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-test' },
      },
    });
    taskId = taskResponse.json().id;
    await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        taskId,
        command: 'claude',
        cwd: '/Users/david/hypha/zeus',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    diffConfirmationId = sent[1].text.match(/\/confirm ([0-9a-f-]+)/u)?.[1] ?? '';
    const taskBeforeConfirm = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    const taskAfterConfirm = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sent[0].text).toContain('Runtime 日志');
    expect(sent[0].text).toContain('真实 Runtime 日志 for Telegram');
    expect(sent[0].text).not.toContain('业务数据回复仍在本地 Zeus 中继续补齐');
    expect(sent[1].text).toContain('等待确认');
    expect(sent[1].text).toContain('查看 Git Diff');
    expect(diffConfirmationId).not.toBe('');
    expect(sent[1].text).not.toContain('业务数据回复仍在本地 Zeus 中继续补齐');
    expect(taskBeforeConfirm.json().status).toBe('ready');
    expect(sent[2].text).toContain('Git Diff');
    expect(sent[2].text).toContain('/Users/david/hypha/zeus');
    expect(taskAfterConfirm.json().status).toBe('ready');
  });

  it('exports full Telegram runtime logs to a local redacted file without sending the whole log body', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let taskId = '';
    let confirmationId = '';
    let pollStep = 0;
    const client: TelegramLongPollingClient = {
      poll: async () => {
        pollStep += 1;
        if (pollStep === 1)
          return [
            {
              updateId: 24,
              chatId: 1001,
              userId: 42,
              text: `/logs ${taskId} --full`,
            },
          ];
        if (pollStep === 2)
          return [
            {
              updateId: 25,
              chatId: 1001,
              userId: 42,
              text: `/confirm ${confirmationId}`,
            },
          ];
        return [];
      },
    };
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const spawn: AiRuntimeSpawn = () => {
      const callbacks = new Map<string, Array<(value: unknown) => void>>();
      const handle: AiRuntimeProcessHandle = {
        pid: 43,
        on(event, callback) {
          const entries = callbacks.get(event) ?? [];
          entries.push(callback as (value: unknown) => void);
          callbacks.set(event, entries);
          return handle;
        },
        kill() {},
      };
      queueMicrotask(() => {
        for (let index = 0; index < 12; index += 1) {
          const suffix = index === 5 ? ' token=telegram-secret-real' : '';
          callbacks.get('stdout')?.forEach((callback) => callback(`完整 Runtime 日志行 ${index}${suffix}`));
        }
        callbacks.get('exit')?.forEach((callback) => callback(0));
      });
      return handle;
    };
    const aiRuntimeManager = createAiRuntimeSessionManager({
      allowedRoot: '/Users/david/hypha/zeus',
      spawn,
      now: () => '2026-06-13T00:00:00.000Z',
    });
    const dbPath = await createTmpDb();
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: sender,
      aiRuntimeManager,
      now: () => new Date('2026-06-13T01:02:03.000Z'),
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    const project = projectResponse.json();
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '完整日志导出任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-full-log-test' },
      },
    });
    taskId = taskResponse.json().id;
    await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        taskId,
        command: 'claude',
        cwd: '/Users/david/hypha/zeus',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    confirmationId = sent[0].text.match(/\/confirm ([0-9a-f-]+)/u)?.[1] ?? '';
    const taskBeforeConfirm = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    const taskAfterConfirm = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sent[0].text).toContain('等待确认');
    expect(sent[0].text).toContain('导出完整 Runtime 日志');
    expect(confirmationId).not.toBe('');
    expect(taskBeforeConfirm.json().status).toBe('ready');
    expect(sent[0].text).not.toContain('完整 Runtime 日志行 0');
    expect(sent[1].text).toContain('Runtime 日志已导出');
    expect(sent[1].text).toContain('日志 14 行');
    expect(sent[1].text).not.toContain('完整 Runtime 日志行 0');
    expect(sent[1].text).not.toContain('telegram-secret-real');
    expect(taskAfterConfirm.json().status).toBe('ready');
    const exportPath = sent[1].text.match(/文件：(.*\.log)/u)?.[1]?.trim() ?? '';
    expect(exportPath).toContain(`${dbPath}.logs/telegram-exports/`);
    const exported = await readFile(exportPath, 'utf8');
    expect(exported).toContain('完整 Runtime 日志行 0');
    expect(exported).toContain('完整 Runtime 日志行 11');
    expect(exported).toContain('token=[REDACTED]');
    expect(exported).not.toContain('telegram-secret-real');
  });

  it('summarizes large Telegram diffs and redacts sensitive fragments before replying', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let taskId = '';
    let confirmationId = '';
    let pollStep = 0;
    const client: TelegramLongPollingClient = {
      poll: async () => {
        pollStep += 1;
        if (pollStep === 1) return [{ updateId: 23, chatId: 1001, userId: 42, text: `/diff ${taskId}` }];
        if (pollStep === 2)
          return [
            {
              updateId: 24,
              chatId: 1001,
              userId: 42,
              text: `/confirm ${confirmationId}`,
            },
          ];
        return [];
      },
    };
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: sender,
      gitDiffReader: async () => ({
        isRepository: true,
        branch: 'main',
        clean: false,
        changedFiles: ['src/large.ts', 'src/secret.ts'],
        conflictFiles: [],
        fileStatuses: [
          { filePath: 'src/large.ts', status: 'modified' },
          { filePath: 'src/secret.ts', status: 'modified' },
        ],
        remoteBranches: [],
        recentCommits: [],
        files: ['src/large.ts', 'src/secret.ts'],
        diffText: `diff --git a/src/secret.ts b/src/secret.ts\n+token=telegram-secret-real\n${'+x'.repeat(1800)}`,
      }),
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    const project = projectResponse.json();
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '大 Diff 任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-large-diff-test' },
      },
    });
    taskId = taskResponse.json().id;

    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    confirmationId = sent[0].text.match(/\/confirm ([0-9a-f-]+)/u)?.[1] ?? '';
    const taskBeforeConfirm = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    const taskAfterConfirm = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sent[0].text).toContain('等待确认');
    expect(sent[0].text).toContain('查看 Git Diff');
    expect(confirmationId).not.toBe('');
    expect(taskBeforeConfirm.json().status).toBe('ready');
    expect(sent[1].text).toContain('Git Diff 摘要');
    expect(sent[1].text).toContain('diffTextLength');
    expect(sent[1].text).toContain('src/large.ts');
    expect(sent[1].text).toContain('src/secret.ts');
    expect(sent[1].text).not.toContain('telegram-secret-real');
    expect(sent[1].text).not.toContain('+x+x+x+x+x+x+x+x+x+x');
    expect(taskAfterConfirm.json().status).toBe('ready');
  });

  it('requires Telegram confirmation before running and continuing a real task', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let projectId = '';
    let taskId = '';
    let pollStep = 0;
    let runConfirmationId = '';
    let stopConfirmationId = '';
    let continueConfirmationId = '';
    const killedSignals: Array<string | undefined> = [];
    const runtimeInvocations: Array<{ command: string; args: string[] }> = [];
    const client: TelegramLongPollingClient = {
      poll: async () => {
        pollStep += 1;
        if (pollStep === 1)
          return [
            {
              updateId: 31,
              chatId: 1001,
              userId: 42,
              text: `/run ${projectId} ${taskId}`,
            },
          ];
        if (pollStep === 2)
          return [
            {
              updateId: 32,
              chatId: 1001,
              userId: 42,
              text: `/confirm ${runConfirmationId}`,
            },
          ];
        if (pollStep === 3) return [{ updateId: 33, chatId: 1001, userId: 42, text: `/stop ${taskId}` }];
        if (pollStep === 4)
          return [
            {
              updateId: 34,
              chatId: 1001,
              userId: 42,
              text: `/confirm ${stopConfirmationId}`,
            },
          ];
        if (pollStep === 5)
          return [
            {
              updateId: 35,
              chatId: 1001,
              userId: 42,
              text: `/continue ${taskId}`,
            },
          ];
        if (pollStep === 6)
          return [
            {
              updateId: 36,
              chatId: 1001,
              userId: 42,
              text: `/confirm ${continueConfirmationId}`,
            },
          ];
        return [];
      },
    };
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const spawn: AiRuntimeSpawn = (command, args) => {
      runtimeInvocations.push({ command, args });
      const callbacks = new Map<string, Array<(value: unknown) => void>>();
      const handle: AiRuntimeProcessHandle = {
        pid: 88,
        on(event, callback) {
          const entries = callbacks.get(event) ?? [];
          entries.push(callback as (value: unknown) => void);
          callbacks.set(event, entries);
          return handle;
        },
        kill(signal) {
          killedSignals.push(signal);
          callbacks.get('stderr')?.forEach((callback) => callback(`stopped:${signal}`));
        },
      };
      queueMicrotask(() => {
        callbacks.get('stdout')?.forEach((callback) => callback('真实 Telegram run 日志'));
      });
      return handle;
    };
    const aiRuntimeManager = createAiRuntimeSessionManager({
      allowedRoot: '/Users/david/hypha/zeus',
      spawn,
      now: () => '2026-06-13T00:00:00.000Z',
    });
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: sender,
      aiRuntimeManager,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    projectId = projectResponse.json().id;
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId,
        title: '远程执行任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-run-test' },
      },
    });
    taskId = taskResponse.json().id;
    await server.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: { defaultAdapterId: 'claude' },
    });

    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    const sessionsBeforeConfirm = await server.inject({
      method: 'GET',
      url: `/api/runtime/sessions?taskId=${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });
    runConfirmationId = sent[0].text.match(/\/confirm ([0-9a-f-]+)/u)?.[1] ?? '';
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    stopConfirmationId = sent[2].text.match(/\/confirm ([0-9a-f-]+)/u)?.[1] ?? '';
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    continueConfirmationId = sent[4].text.match(/\/confirm ([0-9a-f-]+)/u)?.[1] ?? '';
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finalTask = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });
    const sessions = await server.inject({
      method: 'GET',
      url: `/api/runtime/sessions?taskId=${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sent[0].text).toContain('等待确认');
    expect(sent[0].text).toContain('/confirm');
    expect(runConfirmationId).not.toBe('');
    expect(sessionsBeforeConfirm.json()).toHaveLength(0);
    expect(sent[1].text).toContain('已启动 Runtime 会话');
    expect(sent[2].text).toContain('等待确认');
    expect(sent[2].text).toContain('远程停止 Runtime 会话');
    expect(stopConfirmationId).not.toBe('');
    expect(sent[3].text).toContain('已停止任务');
    expect(sent[4].text).toContain('等待确认');
    expect(sent[4].text).toContain('/confirm');
    expect(continueConfirmationId).not.toBe('');
    expect(sent[5].text).toContain('已继续任务');
    expect(sent.join('\n')).not.toContain('高风险操作需要确认；当前不会远程伪造执行结果');
    expect(killedSignals).toContain('SIGTERM');
    expect(finalTask.json().status).toBe('running');
    expect(sessions.json().length).toBeGreaterThanOrEqual(1);
    expect(runtimeInvocations[0]).toMatchObject({ command: 'claude' });
    expect(runtimeInvocations[0].args[0]).toBe('-p');
    expect(runtimeInvocations[0].args.join('\n')).toContain('任务：远程执行任务');
    expect(runtimeInvocations[0].args.join('\n')).toContain('"source":"telegram-run-test"');
  });

  it('routes confirmed Codex run through native and keeps continue choice-safe without spawning a CLI', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const threadStarts: unknown[] = [];
    const turnStarts: unknown[] = [];
    let cliSpawnCount = 0;
    let projectId = '';
    let taskId = '';
    let pollStep = 0;
    let runConfirmationId = '';
    let continueConfirmationId = '';
    const capabilities = {
      generationId: 'telegram-native-generation',
      initializedAt: '2026-07-13T00:00:00.000Z',
      models: [],
      supportedModels: ['gpt-5.4'],
    };
    const codexManager: CodexAppServerManager = {
      async ensureReady() {
        return capabilities;
      },
      async startThread(input) {
        threadStarts.push(input);
        return { id: 'telegram-native-thread', turns: [] };
      },
      async resumeThread(input) {
        return { id: input.threadId, turns: [] };
      },
      async readThread(input) {
        return { id: input.threadId, turns: [] };
      },
      async startTurn(input) {
        turnStarts.push(input);
        return { id: 'telegram-native-turn', threadId: input.threadId, items: [] };
      },
      async steerTurn(input) {
        return { turnId: input.turnId };
      },
      async interruptTurn() {},
      async respondToServerRequest() {},
      subscribe() {
        return () => {};
      },
      getState() {
        return { type: 'ready', generationId: capabilities.generationId, capabilities };
      },
      async prepareForShutdown() {},
      async close() {},
    };
    const client: TelegramLongPollingClient = {
      poll: async () => {
        pollStep += 1;
        if (pollStep === 1) return [{ updateId: 81, chatId: 1001, userId: 42, text: `/run ${projectId} ${taskId}` }];
        if (pollStep === 2) return [{ updateId: 82, chatId: 1001, userId: 42, text: `/confirm ${runConfirmationId}` }];
        if (pollStep === 3) return [{ updateId: 83, chatId: 1001, userId: 42, text: `/continue ${taskId}` }];
        if (pollStep === 4) return [{ updateId: 84, chatId: 1001, userId: 42, text: `/confirm ${continueConfirmationId}` }];
        return [];
      },
    };
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: sender,
      codexAppServerManager: codexManager,
      aiRuntimeSpawn: () => {
        cliSpawnCount += 1;
        throw new Error('Codex Telegram must not spawn a CLI');
      },
    });
    const project = (
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer test-token' },
        payload: { name: 'Telegram native', localPath: '/Users/david/hypha/zeus' },
      })
    ).json();
    projectId = project.id;
    const task = (
      await server.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: 'Bearer test-token' },
        payload: { projectId, title: 'Telegram Codex native', description: '不得降级 CLI', sourceContext: { source: 'telegram-native-test' } },
      })
    ).json();
    taskId = task.id;
    expect((await server.inject({ method: 'PUT', url: '/api/runtime/settings', headers: { authorization: 'Bearer test-token' }, payload: { defaultAdapterId: 'codex' } })).statusCode).toBe(200);
    await server.inject({ method: 'POST', url: '/api/telegram/polling/start', headers: { authorization: 'Bearer test-token' } });

    await server.inject({ method: 'POST', url: '/api/telegram/polling/poll-once', headers: { authorization: 'Bearer test-token' } });
    runConfirmationId = sent[0]?.text.match(/\/confirm ([0-9a-f-]+)/u)?.[1] ?? '';
    await server.inject({ method: 'POST', url: '/api/telegram/polling/poll-once', headers: { authorization: 'Bearer test-token' } });
    await server.inject({ method: 'POST', url: '/api/telegram/polling/poll-once', headers: { authorization: 'Bearer test-token' } });
    continueConfirmationId = sent[2]?.text.match(/\/confirm ([0-9a-f-]+)/u)?.[1] ?? '';
    await server.inject({ method: 'POST', url: '/api/telegram/polling/poll-once', headers: { authorization: 'Bearer test-token' } });
    const finalTask = await server.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: { authorization: 'Bearer test-token' } });
    const runtimeSessions = await server.inject({ method: 'GET', url: `/api/runtime/sessions?taskId=${taskId}`, headers: { authorization: 'Bearer test-token' } });

    expect(runConfirmationId).not.toBe('');
    expect(sent[1]?.text).toContain('已启动 Codex native 会话');
    expect(continueConfirmationId).not.toBe('');
    expect(sent[3]?.text).toContain('远程操作未执行');
    expect(sent[3]?.text).toContain('显式选择');
    expect(threadStarts).toHaveLength(1);
    expect(turnStarts).toHaveLength(1);
    expect(cliSpawnCount).toBe(0);
    expect(runtimeSessions.json()).toHaveLength(0);
    expect(finalTask.json().status).toBe('cancelled');
    await server.close();
  });

  it('cancels pending Telegram runtime confirmation without starting a session', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let projectId = '';
    let taskId = '';
    let pollStep = 0;
    let confirmationId = '';
    const client: TelegramLongPollingClient = {
      poll: async () => {
        pollStep += 1;
        if (pollStep === 1)
          return [
            {
              updateId: 36,
              chatId: 1001,
              userId: 42,
              text: `/run ${projectId} ${taskId}`,
            },
          ];
        if (pollStep === 2)
          return [
            {
              updateId: 37,
              chatId: 1001,
              userId: 42,
              text: `/cancel ${confirmationId}`,
            },
          ];
        if (pollStep === 3)
          return [
            {
              updateId: 38,
              chatId: 1001,
              userId: 42,
              text: `/confirm ${confirmationId}`,
            },
          ];
        return [];
      },
    };
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const spawn: AiRuntimeSpawn = () => {
      const callbacks = new Map<string, Array<(value: unknown) => void>>();
      const handle: AiRuntimeProcessHandle = {
        pid: 99,
        on(event, callback) {
          const entries = callbacks.get(event) ?? [];
          entries.push(callback as (value: unknown) => void);
          callbacks.set(event, entries);
          return handle;
        },
        kill() {},
      };
      queueMicrotask(() => {
        callbacks.get('stdout')?.forEach((callback) => callback('AI 图谱回答：local-server 由真实图谱来源支撑'));
        callbacks.get('exit')?.forEach((callback) => callback(0));
      });
      return handle;
    };
    const dbPath = await createTmpDb();
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: sender,
      aiRuntimeSpawn: spawn,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    projectId = projectResponse.json().id;
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId,
        title: '远程取消任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-cancel-test' },
      },
    });
    taskId = taskResponse.json().id;

    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    confirmationId = sent[0].text.match(/\/confirm ([0-9a-f-]+)/u)?.[1] ?? '';
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    const task = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });
    const sessions = await server.inject({
      method: 'GET',
      url: `/api/runtime/sessions?taskId=${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(confirmationId).not.toBe('');
    expect(sent[1].text).toContain('已取消远程确认');
    expect(sent[2].text).toContain('确认不存在或已失效');
    expect(task.json().status).toBe('cancelled');
    expect(sessions.json()).toHaveLength(0);
    const auditText = JSON.stringify(new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent());
    expect(auditText).toContain('security.confirmation.rejected');
    expect(auditText).toContain('telegram');
    expect(auditText).not.toContain('telegram-token-real');
  });

  it('expires stale Telegram runtime confirmations before executing them', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let projectId = '';
    let taskId = '';
    let pollStep = 0;
    let confirmationId = '';
    const client: TelegramLongPollingClient = {
      poll: async () => {
        pollStep += 1;
        if (pollStep === 1)
          return [
            {
              updateId: 39,
              chatId: 1001,
              userId: 42,
              text: `/run ${projectId} ${taskId}`,
            },
          ];
        if (pollStep === 2)
          return [
            {
              updateId: 40,
              chatId: 1001,
              userId: 42,
              text: `/confirm ${confirmationId}`,
            },
          ];
        return [];
      },
    };
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      telegramAllowedUserIds: [42],
      telegramConfirmationTtlMs: -1,
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: sender,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    projectId = projectResponse.json().id;
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId,
        title: '远程过期任务',
        description: '真实任务',
        sourceContext: { source: 'telegram-expire-test' },
      },
    });
    taskId = taskResponse.json().id;

    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    confirmationId = sent[0].text.match(/\/confirm ([0-9a-f-]+)/u)?.[1] ?? '';
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    const sessions = await server.inject({
      method: 'GET',
      url: `/api/runtime/sessions?taskId=${taskId}`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(confirmationId).not.toBe('');
    expect(sent[1].text).toContain('确认已过期');
    expect(sessions.json()).toHaveLength(0);
  });

  it('answers /ask with AI Runtime output and source-backed graph context', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let projectId = '';
    const client: TelegramLongPollingClient = {
      poll: async () => [
        {
          updateId: 41,
          chatId: 1001,
          userId: 42,
          text: `/ask ${projectId} local-server`,
        },
      ],
    };
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const spawn: AiRuntimeSpawn = () => {
      const callbacks = new Map<string, Array<(value: unknown) => void>>();
      const handle: AiRuntimeProcessHandle = {
        pid: 99,
        on(event, callback) {
          const entries = callbacks.get(event) ?? [];
          entries.push(callback as (value: unknown) => void);
          callbacks.set(event, entries);
          return handle;
        },
        kill() {},
      };
      queueMicrotask(() => {
        callbacks.get('stdout')?.forEach((callback) => callback('AI 图谱回答：local-server 由真实图谱来源支撑'));
        callbacks.get('exit')?.forEach((callback) => callback(0));
      });
      return handle;
    };
    const dbPath = await createTmpDb();
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: sender,
      aiRuntimeSpawn: spawn,
    });
    await server.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: { defaultAdapterId: 'claude' },
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      },
    });
    projectId = projectResponse.json().id;
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer test-token' },
    });

    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sent[0].text).toContain('图谱问答回答');
    expect(sent[0].text).toContain('AI 图谱回答：local-server 由真实图谱来源支撑');
    expect(sent[0].text).toContain('来源');
    expect(sent[0].text).toContain('Runtime 会话');
    expect(sent[0].text).not.toContain('当前不会伪造 AI 答案');
  });

  it('starts, polls once, exposes status and audit logs, and stops', async () => {
    const client: TelegramLongPollingClient = {
      poll: async () => [{ updateId: 5, chatId: 1001, userId: 42, text: '/projects' }],
    };
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: { sendMessage: async () => {} },
    });

    const start = await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    const poll = await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    const status = await server.inject({
      method: 'GET',
      url: '/api/telegram/polling/status',
      headers: { authorization: 'Bearer test-token' },
    });
    const logs = await server.inject({
      method: 'GET',
      url: '/api/telegram/polling/logs',
      headers: { authorization: 'Bearer test-token' },
    });
    const stop = await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/stop',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ running: true, offset: 0 });
    expect(poll.json()).toMatchObject({
      running: true,
      offset: 6,
      handledUpdates: 1,
    });
    expect(status.json()).toMatchObject({
      running: true,
      offset: 6,
      handledUpdates: 1,
    });
    expect(logs.json()).toEqual([
      {
        updateId: 5,
        chatId: 1001,
        userId: 42,
        command: 'projects',
        allowed: true,
      },
    ]);
    expect(stop.json()).toMatchObject({
      running: false,
      offset: 6,
      handledUpdates: 1,
    });
  });

  it('recreates polling service when Telegram allowed user ids change', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    let pollStep = 0;
    const client: TelegramLongPollingClient = {
      poll: async () => {
        pollStep += 1;
        if (pollStep === 1) return [{ updateId: 50, chatId: 1001, userId: 42, text: '/projects' }];
        if (pollStep === 2) return [{ updateId: 51, chatId: 1001, userId: 42, text: '/tasks' }];
        return [];
      },
    };
    const sender: TelegramMessageSender = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
      telegramAllowedUserIds: [42],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramPollingClient: client,
      telegramMessageSender: sender,
    });

    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    const updated = await server.inject({
      method: 'PUT',
      url: '/api/telegram/security-settings',
      headers: { authorization: 'Bearer test-token' },
      payload: { allowedUserIds: [1001] },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/poll-once',
      headers: { authorization: 'Bearer test-token' },
    });
    const logs = await server.inject({
      method: 'GET',
      url: '/api/telegram/polling/logs',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(updated.json()).toEqual({ allowedUserIds: [1001] });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('项目列表');
    expect(logs.json()).toEqual([
      {
        updateId: 51,
        chatId: 1001,
        userId: 42,
        command: 'tasks',
        allowed: false,
      },
    ]);
  });

  it('refuses to start polling when Telegram token or allowed users are missing', async () => {
    const server = await createLocalServer({
      dbPath: await createTmpDb(),
      apiToken: 'test-token',
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/telegram/polling/start',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'ZEUS_TELEGRAM_UNCONFIGURED',
    });
  });
});
