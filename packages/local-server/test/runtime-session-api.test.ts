import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAiRuntimeSessionManager, type AiRuntimeProcessHandle, type AiRuntimeSpawn } from '@zeus/ai-runtime';
import { AuditLogRepository, createZeusDatabase } from '@zeus/storage';
import { createLocalServer } from '../src/index.js';
import type { SecretStore } from '@zeus/security-core';
import type { TelegramMessageSender } from '@zeus/telegram-adapter';

function createImmediateSpawn(): AiRuntimeSpawn {
  return () => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 100,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        return handle;
      },
      kill() {
        callbacks.get('exit')?.forEach((callback) => callback(143));
      },
    };
    queueMicrotask(() => {
      callbacks.get('stdout')?.forEach((callback) => callback('真实 AI CLI 输出'));
      callbacks.get('exit')?.forEach((callback) => callback(0));
    });
    return handle;
  };
}

function createMemorySecretStore(token: string): SecretStore {
  return {
    async setSecret() {},
    async getSecret(account) {
      return account === 'telegram.botToken' ? token : undefined;
    },
    async deleteSecret() {},
  };
}

function createRuntimeProgressSpawn(lines: string[]): AiRuntimeSpawn {
  return () => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 333,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        return handle;
      },
      kill() {},
    };
    queueMicrotask(() => {
      for (const line of lines) callbacks.get('stdout')?.forEach((callback) => callback(line));
    });
    return handle;
  };
}

function createHangingSpawn(started: Array<{ command: string }>): AiRuntimeSpawn {
  return (command) => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 444,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        return handle;
      },
      kill() {
        callbacks.get('exit')?.forEach((callback) => callback(143));
      },
    };
    started.push({ command });
    return handle;
  };
}

describe('AI runtime session API', () => {
  it('creates a runtime session and exposes real collected logs through token-protected APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-api-'));
    try {
      const aiRuntimeManager = createAiRuntimeSessionManager({
        allowedRoot: '/Users/david/hypha/zeus',
        spawn: createImmediateSpawn(),
        now: () => '2026-06-13T00:00:00.000Z',
      });
      const server = await createLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'test-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeManager,
      });

      const startResponse = await server.inject({
        method: 'POST',
        url: '/api/runtime/sessions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          projectId: 'project-1',
          taskId: 'task-1',
          command: 'codex',
          args: ['--version'],
          cwd: '/Users/david/hypha/zeus',
        },
      });
      expect(startResponse.statusCode).toBe(201);
      const session = startResponse.json();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/runtime/sessions',
        headers: { authorization: 'Bearer test-token' },
      });
      const logsResponse = await server.inject({
        method: 'GET',
        url: `/api/runtime/sessions/${session.id}/logs`,
        headers: { authorization: 'Bearer test-token' },
      });

      expect(listResponse.json().map((item: { id: string }) => item.id)).toContain(session.id);
      expect(logsResponse.json().map((entry: { stream: string; text: string }) => `${entry.stream}:${entry.text}`)).toContain('stdout:真实 AI CLI 输出');
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('enforces default runtime concurrency limits for direct sessions without starting extra processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-concurrency-direct-'));
  const started: Array<{ command: string }> = [];
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createHangingSpawn(started),
    });

    const first = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'codex',
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const sameProjectSecond = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'codex',
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const otherProject = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-2',
        command: 'codex',
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const globalThird = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-3',
        command: 'codex',
        cwd: '/Users/david/hypha/zeus',
      },
    });

    expect(first.statusCode).toBe(201);
    expect(sameProjectSecond.statusCode).toBe(409);
    expect(sameProjectSecond.json()).toMatchObject({
      error: 'ZEUS_RUNTIME_CONCURRENCY_LIMIT',
      scope: 'project',
      limit: 1,
    });
    expect(otherProject.statusCode).toBe(201);
    expect(globalThird.statusCode).toBe(409);
    expect(globalThird.json()).toMatchObject({
      error: 'ZEUS_RUNTIME_CONCURRENCY_LIMIT',
      scope: 'global',
      limit: 2,
    });
    expect(started).toHaveLength(2);
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps task runtime requests ready when concurrency is exhausted instead of starting a fake queued session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-concurrency-task-'));
  const started: Array<{ command: string }> = [];
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createHangingSpawn(started),
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();
    const firstTaskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '运行任务',
        description: '占用项目并发',
        sourceContext: { source: 'runtime-concurrency' },
      },
    });
    const secondTaskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '排队任务',
        description: '应保持 ready',
        sourceContext: { source: 'runtime-concurrency' },
      },
    });
    const firstTask = firstTaskResponse.json();
    const secondTask = secondTaskResponse.json();

    const firstRun = await server.inject({
      method: 'POST',
      url: `/api/tasks/${firstTask.id}/run`,
      headers: { authorization: 'Bearer test-token' },
    });
    const secondRun = await server.inject({
      method: 'POST',
      url: `/api/tasks/${secondTask.id}/run`,
      headers: { authorization: 'Bearer test-token' },
    });
    const taskEvents = await server.inject({
      method: 'GET',
      url: `/api/tasks/${secondTask.id}/events`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(firstRun.statusCode).toBe(201);
    expect(secondRun.statusCode).toBe(202);
    expect(secondRun.json()).toMatchObject({
      queued: true,
      task: { id: secondTask.id, status: 'ready' },
      reason: expect.stringContaining('并发'),
    });
    expect(taskEvents.json().map((event: { eventType: string }) => event.eventType)).toContain('task.runtime.queued');
    expect(started).toHaveLength(1);
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('searches and paginates persisted runtime logs by text and stream without loading the whole session log list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-api-log-search-'));
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createRuntimeProgressSpawn(['boot ready', 'AI: first answer', 'AI: second answer', 'cleanup done']),
    });
    const startResponse = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        taskId: 'task-1',
        command: 'codex',
        args: ['run'],
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const session = startResponse.json();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = await server.inject({
      method: 'GET',
      url: `/api/runtime/sessions/${session.id}/logs?query=AI&stream=stdout&limit=1&offset=1`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId: session.id,
      query: 'AI',
      stream: 'stdout',
      total: 2,
      limit: 1,
      offset: 1,
    });
    expect(response.json().items.map((entry: { text: string }) => entry.text)).toEqual(['AI: second answer']);
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('restores persisted runtime sessions and logs after reopening the local server database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-api-reopen-'));
  const dbPath = join(dir, 'zeus.db');
  try {
    const firstServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
    });
    const startResponse = await firstServer.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'codex',
        args: ['--version'],
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const session = startResponse.json();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await firstServer.close();

    const secondServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
    });
    const sessionsResponse = await secondServer.inject({
      method: 'GET',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
    });
    const logsResponse = await secondServer.inject({
      method: 'GET',
      url: `/api/runtime/sessions/${session.id}/logs`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sessionsResponse.json().map((item: { id: string; status: string }) => `${item.id}:${item.status}`)).toContain(`${session.id}:exited`);
    expect(logsResponse.json().map((entry: { stream: string; text: string }) => `${entry.stream}:${entry.text}`)).toContain('stdout:真实 AI CLI 输出');
    await secondServer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('marks unfinished runtime sessions as lost after restart when their PID no longer exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-recovery-lost-'));
  const dbPath = join(dir, 'zeus.db');
  const started: Array<{ command: string }> = [];
  try {
    const firstServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createHangingSpawn(started),
    });
    const startResponse = await firstServer.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        taskId: 'task-1',
        command: 'codex',
        args: ['run'],
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const session = startResponse.json();
    await firstServer.close();

    const secondServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
      runtimePidExists: () => false,
    });
    const sessionsResponse = await secondServer.inject({
      method: 'GET',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
    });
    const logsResponse = await secondServer.inject({
      method: 'GET',
      url: `/api/runtime/sessions/${session.id}/logs`,
      headers: { authorization: 'Bearer test-token' },
    });
    const eventsResponse = await secondServer.inject({
      method: 'GET',
      url: '/api/tasks/task-1/events',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sessionsResponse.json().map((item: { id: string; status: string }) => `${item.id}:${item.status}`)).toContain(`${session.id}:lost`);
    expect(logsResponse.json().map((entry: { stream: string; text: string }) => `${entry.stream}:${entry.text}`)).toContain('system:Runtime 会话恢复状态：lost，原 PID 不存在，已保留已收集日志。');
    expect(eventsResponse.json().map((entry: { eventType: string; title: string }) => `${entry.eventType}:${entry.title}`)).toContain('runtime.session.recovered:Runtime 会话恢复状态');
    await secondServer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('marks unfinished runtime sessions as orphan_detected after restart when their PID still exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-recovery-orphan-'));
  const dbPath = join(dir, 'zeus.db');
  const started: Array<{ command: string }> = [];
  try {
    const firstServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createHangingSpawn(started),
    });
    const startResponse = await firstServer.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        taskId: 'task-1',
        command: 'codex',
        args: ['run'],
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const session = startResponse.json();
    await firstServer.close();

    const secondServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
      runtimePidExists: () => true,
    });
    const sessionsResponse = await secondServer.inject({
      method: 'GET',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
    });
    const logsResponse = await secondServer.inject({
      method: 'GET',
      url: `/api/runtime/sessions/${session.id}/logs`,
      headers: { authorization: 'Bearer test-token' },
    });
    const eventsResponse = await secondServer.inject({
      method: 'GET',
      url: '/api/tasks/task-1/events',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sessionsResponse.json().map((item: { id: string; status: string }) => `${item.id}:${item.status}`)).toContain(`${session.id}:orphan_detected`);
    expect(logsResponse.json().map((entry: { stream: string; text: string }) => `${entry.stream}:${entry.text}`)).toContain('system:Runtime 会话恢复状态：orphan_detected，原 PID 仍存在，请重新附着或终止。');
    expect(eventsResponse.json().map((entry: { eventType: string; title: string }) => `${entry.eventType}:${entry.title}`)).toContain('runtime.session.recovered:Runtime 会话恢复状态');
    await secondServer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('terminates orphan_detected runtime sessions by PID and persists stopped status without claiming reattach', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-orphan-stop-'));
  const dbPath = join(dir, 'zeus.db');
  const started: Array<{ command: string }> = [];
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  try {
    const firstServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createHangingSpawn(started),
    });
    const startResponse = await firstServer.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'codex',
        args: ['run'],
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const session = startResponse.json();
    await firstServer.close();

    const secondServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
      runtimePidExists: () => true,
      runtimeKillPid: (pid, signal) => killed.push({ pid, signal }),
    });
    const stopResponse = await secondServer.inject({
      method: 'POST',
      url: `/api/runtime/sessions/${session.id}/stop`,
      headers: { authorization: 'Bearer test-token' },
    });
    const logsResponse = await secondServer.inject({
      method: 'GET',
      url: `/api/runtime/sessions/${session.id}/logs`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(stopResponse.statusCode).toBe(200);
    expect(stopResponse.json()).toMatchObject({
      id: session.id,
      status: 'stopped',
    });
    expect(killed).toEqual([{ pid: 444, signal: 'SIGTERM' }]);
    expect(logsResponse.json().map((entry: { stream: string; text: string }) => `${entry.stream}:${entry.text}`)).toContain('system:已终止 orphan_detected Runtime 会话 PID 444');
    await secondServer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('manages runtime session search, summary, favorite, archive, and delete through APIs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-api-manage-'));
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
    });
    const startResponse = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'codex',
        args: ['--version'],
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const session = startResponse.json();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const summaryResponse = await server.inject({
      method: 'POST',
      url: `/api/runtime/sessions/${session.id}/summary`,
      headers: { authorization: 'Bearer test-token' },
    });
    const favoriteResponse = await server.inject({
      method: 'PUT',
      url: `/api/runtime/sessions/${session.id}/favorite`,
      headers: { authorization: 'Bearer test-token' },
      payload: { favorite: true },
    });
    const searchResponse = await server.inject({
      method: 'GET',
      url: '/api/runtime/sessions?query=AI%20CLI&favoriteOnly=true',
      headers: { authorization: 'Bearer test-token' },
    });
    const archiveResponse = await server.inject({
      method: 'POST',
      url: `/api/runtime/sessions/${session.id}/archive`,
      headers: { authorization: 'Bearer test-token' },
    });
    const archivedResponse = await server.inject({
      method: 'GET',
      url: '/api/runtime/sessions?archived=true',
      headers: { authorization: 'Bearer test-token' },
    });
    const deleteResponse = await server.inject({
      method: 'DELETE',
      url: `/api/runtime/sessions/${session.id}`,
      headers: { authorization: 'Bearer test-token' },
    });
    const afterDeleteResponse = await server.inject({
      method: 'GET',
      url: '/api/runtime/sessions?archived=true',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(summaryResponse.json().summary).toContain('真实 AI CLI 输出');
    expect(favoriteResponse.json().favorite).toBe(true);
    expect(searchResponse.json().map((item: { id: string }) => item.id)).toEqual([session.id]);
    expect(archiveResponse.json().archived).toBe(true);
    expect(archivedResponse.json().map((item: { id: string }) => item.id)).toEqual([session.id]);
    expect(deleteResponse.json().deletedAt).toBeTruthy();
    expect(afterDeleteResponse.json()).toEqual([]);
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('persists runtime adapter settings with per-adapter models and rejects invalid values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-settings-'));
  const dbPath = join(dir, 'zeus.db');
  try {
    const firstServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
    });
    const defaultResponse = await firstServer.inject({
      method: 'GET',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
    });
    const invalidResponse = await firstServer.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: { defaultAdapterId: 'unknown-cli' },
    });
    const invalidModelResponse = await firstServer.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        defaultAdapterId: 'claude',
        adapterModels: { claude: 'bad\nmodel' },
      },
    });
    const genericDefaultResponse = await firstServer.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: { defaultAdapterId: 'generic' },
    });
    const invalidAutoConfirmationResponse = await firstServer.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: { defaultAdapterId: 'claude', autoConfirmationPolicy: 'always' },
    });
    const invalidCliPathResponse = await firstServer.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        defaultAdapterId: 'claude',
        adapterCliPaths: { claude: 'relative/claude' },
      },
    });
    const saveResponse = await firstServer.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        defaultAdapterId: 'claude',
        adapterModels: { claude: 'claude-sonnet-real', codex: '  ' },
        adapterCliPaths: { claude: '/opt/homebrew/bin/claude' },
        logRetentionDays: 14,
        autoConfirmationPolicy: 'low_risk_only',
      },
    });

    expect(defaultResponse.json()).toEqual({
      defaultAdapterId: 'codex',
      adapterModels: {},
      adapterDefaultArgs: {},
      adapterCliPaths: {},
      terminalEnv: {},
      shell: { path: null, login: false },
      concurrency: { maxPerProject: 1, maxGlobal: 2 },
      executionTimeoutSeconds: 3600,
      logRetentionDays: 30,
      autoConfirmationPolicy: 'never',
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json().error).toBe('ZEUS_INVALID_RUNTIME_SETTINGS');
    expect(invalidModelResponse.statusCode).toBe(400);
    expect(invalidModelResponse.json().error).toBe('ZEUS_INVALID_RUNTIME_SETTINGS');
    expect(genericDefaultResponse.statusCode).toBe(400);
    expect(genericDefaultResponse.json().error).toBe('ZEUS_GENERIC_RUNTIME_REQUIRES_CONFIRMATION');
    expect(invalidAutoConfirmationResponse.statusCode).toBe(400);
    expect(invalidAutoConfirmationResponse.json().error).toBe('ZEUS_INVALID_RUNTIME_SETTINGS');
    expect(invalidCliPathResponse.statusCode).toBe(400);
    expect(invalidCliPathResponse.json().error).toBe('ZEUS_INVALID_RUNTIME_SETTINGS');
    expect(saveResponse.json()).toEqual({
      defaultAdapterId: 'claude',
      adapterModels: { claude: 'claude-sonnet-real' },
      adapterDefaultArgs: {},
      adapterCliPaths: { claude: '/opt/homebrew/bin/claude' },
      terminalEnv: {},
      shell: { path: null, login: false },
      concurrency: { maxPerProject: 1, maxGlobal: 2 },
      executionTimeoutSeconds: 3600,
      logRetentionDays: 14,
      autoConfirmationPolicy: 'low_risk_only',
    });
    await firstServer.close();

    const secondServer = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
    });
    const restoredResponse = await secondServer.inject({
      method: 'GET',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(restoredResponse.json()).toEqual({
      defaultAdapterId: 'claude',
      adapterModels: { claude: 'claude-sonnet-real' },
      adapterDefaultArgs: {},
      adapterCliPaths: { claude: '/opt/homebrew/bin/claude' },
      terminalEnv: {},
      shell: { path: null, login: false },
      concurrency: { maxPerProject: 1, maxGlobal: 2 },
      executionTimeoutSeconds: 3600,
      logRetentionDays: 14,
      autoConfirmationPolicy: 'low_risk_only',
    });
    await secondServer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('passes the selected adapter model into dedicated task runtime sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-task-model-'));
  const started: Array<{ command: string; args: string[] }> = [];
  const spawn: AiRuntimeSpawn = (command, args) => {
    started.push({ command, args });
    return createImmediateSpawn()(command, args, {
      cwd: '/Users/david/hypha/zeus',
    });
  };
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: spawn,
    });
    await server.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        defaultAdapterId: 'claude',
        adapterModels: { claude: 'claude-sonnet-real' },
        adapterDefaultArgs: { claude: ['--dangerously-skip-permissions'] },
        adapterCliPaths: { claude: '/opt/homebrew/bin/claude' },
      },
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();
    await server.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}/config`,
      headers: { authorization: 'Bearer test-token' },
      payload: {
        defaultModel: 'claude-project-model',
        defaultWorkMode: 'develop',
        defaultTaskPrompt: '执行前先读取项目默认提示词并保留真实证据链',
      },
    });
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '模型参数任务',
        description: '使用指定模型执行',
        sourceContext: { source: 'runtime-model-test' },
      },
    });
    const task = taskResponse.json();

    const runResponse = await server.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/run`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(runResponse.statusCode).toBe(201);
    expect(started[0].command).toBe('/opt/homebrew/bin/claude');
    expect(started[0].args).toContain('--dangerously-skip-permissions');
    expect(started[0].args).toContain('--model');
    expect(started[0].args).toContain('claude-project-model');
    expect(started[0].args).not.toContain('claude-sonnet-real');
    const promptArg = started[0].args.find((arg) => arg.includes('任务：模型参数任务')) ?? '';
    expect(promptArg).toContain('项目默认工作模式：develop');
    expect(promptArg).toContain('项目默认任务提示词：执行前先读取项目默认提示词并保留真实证据链');
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('persists runtime terminal environment and shell settings and injects them into sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-terminal-settings-'));
  const started: Array<{
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }> = [];
  const spawn: AiRuntimeSpawn = (command, args, options) => {
    started.push({ command, args, env: options.env });
    return createImmediateSpawn()(command, args, options);
  };
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: spawn,
    });
    const saveResponse = await server.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        defaultAdapterId: 'codex',
        adapterModels: { codex: 'gpt-real' },
        terminalEnv: { ZEUS_REAL_TASK: 'enabled', EMPTY_VALUE: '  ' },
        shell: { path: '/bin/zsh', login: true },
        concurrency: { maxPerProject: 1, maxGlobal: 2 },
        executionTimeoutSeconds: 900,
      },
    });

    const startResponse = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'codex',
        cwd: '/Users/david/hypha/zeus',
      },
    });

    expect(saveResponse.statusCode).toBe(200);
    expect(saveResponse.json()).toMatchObject({
      defaultAdapterId: 'codex',
      adapterModels: { codex: 'gpt-real' },
      terminalEnv: { ZEUS_REAL_TASK: 'enabled' },
      shell: { path: '/bin/zsh', login: true },
      executionTimeoutSeconds: 900,
    });
    expect(startResponse.statusCode).toBe(201);
    expect(started[0].env).toMatchObject({
      ZEUS_REAL_TASK: 'enabled',
      SHELL: '/bin/zsh',
      ZEUS_SHELL_LOGIN: '1',
      ZEUS_RUNTIME_TIMEOUT_SECONDS: '900',
    });
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects runtime sessions for commands that are not registered AI CLI adapters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-command-policy-'));
  const started: string[] = [];
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: (command, args, options) => {
        started.push(command);
        return createImmediateSpawn()(command, args, options);
      },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'rm',
        args: ['-rf', '.'],
        cwd: '/Users/david/hypha/zeus',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'ZEUS_UNSUPPORTED_RUNTIME_COMMAND',
    });
    expect(started).toEqual([]);
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('starts a direct generic shell runtime session only after a matching high-risk confirmation is confirmed once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-generic-confirmation-'));
  const started: Array<{ command: string; args: string[] }> = [];
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: (command, args, options) => {
        started.push({ command, args });
        return createImmediateSpawn()(command, args, options);
      },
    });

    const createConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '用户明确确认要启动通用 shell runtime',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'echo confirmed'],
          cwd: '/Users/david/hypha/zeus',
        },
      },
    });
    expect(createConfirmation.statusCode).toBe(201);
    const confirmation = createConfirmation.json();

    const confirmResponse = await server.inject({
      method: 'POST',
      url: `/api/runtime/confirmations/${confirmation.id}/confirm`,
      headers: { authorization: 'Bearer test-token' },
    });
    expect(confirmResponse.statusCode).toBe(200);
    expect(confirmResponse.json()).toMatchObject({
      id: confirmation.id,
      status: 'confirmed',
      riskLevel: 'high',
    });

    const startResponse = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'sh',
        args: ['-lc', 'echo confirmed'],
        cwd: '/Users/david/hypha/zeus',
        confirmationId: confirmation.id,
      },
    });
    expect(startResponse.statusCode).toBe(201);
    expect(started).toEqual([{ command: 'sh', args: ['-lc', 'echo confirmed'] }]);

    const reuseResponse = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'sh',
        args: ['-lc', 'echo confirmed'],
        cwd: '/Users/david/hypha/zeus',
        confirmationId: confirmation.id,
      },
    });
    expect(reuseResponse.statusCode).toBe(400);
    expect(reuseResponse.json()).toMatchObject({
      error: 'ZEUS_GENERIC_RUNTIME_REQUIRES_CONFIRMATION',
    });
    expect(started).toHaveLength(1);
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects a pending Generic shell runtime confirmation before any session can start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-generic-reject-'));
  const dbPath = join(dir, 'zeus.db');
  const started: Array<{ command: string; args: string[] }> = [];
  try {
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: (command, args, options) => {
        started.push({ command, args });
        return createImmediateSpawn()(command, args, options);
      },
    });

    const createConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '用户明确确认要启动通用 shell runtime',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'echo rejected'],
          cwd: '/Users/david/hypha/zeus',
        },
      },
    });
    expect(createConfirmation.statusCode).toBe(201);
    const confirmation = createConfirmation.json();

    const rejectResponse = await server.inject({
      method: 'POST',
      url: `/api/runtime/confirmations/${confirmation.id}/reject`,
      headers: { authorization: 'Bearer test-token' },
      payload: { reason: '用户取消 Generic shell；secret=runtime-token-real' },
    });
    expect(rejectResponse.statusCode).toBe(200);
    expect(rejectResponse.json()).toMatchObject({
      id: confirmation.id,
      status: 'rejected',
      rejectedReason: '用户取消 Generic shell；secret=[REDACTED]',
      riskLevel: 'high',
    });
    expect(rejectResponse.json().rejectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    const startResponse = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'sh',
        args: ['-lc', 'echo rejected'],
        cwd: '/Users/david/hypha/zeus',
        confirmationId: confirmation.id,
      },
    });
    expect(startResponse.statusCode).toBe(409);
    expect(startResponse.json()).toMatchObject({
      error: 'ZEUS_RUNTIME_CONFIRMATION_REJECTED',
    });
    expect(started).toEqual([]);
    await server.close();

    const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
    const rejectedAudit = auditLogs.find((entry) => entry.action === 'security.confirmation.rejected');
    expect(rejectedAudit).toBeDefined();
    expect(rejectedAudit?.actorType).toBe('local_api');
    expect(JSON.stringify(rejectedAudit)).toContain('secret=[REDACTED]');
    expect(JSON.stringify(rejectedAudit)).not.toContain('runtime-token-real');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('returns and audits redacted security context for generic shell confirmations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-generic-security-context-'));
  const dbPath = join(dir, 'zeus.db');
  try {
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
    });

    const createConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '用户确认执行带 secret-real-123 的 shell 命令',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'echo --api-key secret-real-123'],
          cwd: '/Users/david/hypha/zeus',
        },
      },
    });

    expect(createConfirmation.statusCode).toBe(201);
    expect(createConfirmation.json()).toMatchObject({
      securityContext: {
        operationKind: 'shell_command',
        requiresConfirmation: true,
        redacted: true,
        commandPreview: 'sh -lc echo --api-key [REDACTED]',
      },
    });
    expect(JSON.stringify(createConfirmation.json())).not.toContain('secret-real-123');

    const confirmationId = createConfirmation.json().id;
    const confirmResponse = await server.inject({
      method: 'POST',
      url: `/api/runtime/confirmations/${confirmationId}/confirm`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(confirmResponse.statusCode).toBe(200);
    expect(confirmResponse.json().securityContext).toMatchObject({
      operationKind: 'shell_command',
      requiresConfirmation: true,
      redacted: true,
    });
    expect(JSON.stringify(confirmResponse.json())).not.toContain('secret-real-123');

    await server.close();

    const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
    expect(auditLogs.map((entry) => entry.action)).toEqual(expect.arrayContaining(['security.confirmation.required', 'security.confirmation.approved', 'runtime.confirmation.created', 'runtime.confirmation.confirmed']));
    expect(JSON.stringify(auditLogs)).toContain('shell_command');
    expect(JSON.stringify(auditLogs)).toContain('[REDACTED]');
    expect(JSON.stringify(auditLogs)).not.toContain('secret-real-123');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects generic shell confirmations and sessions whose cwd is outside the project root before consuming confirmation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-cwd-boundary-'));
  const dbPath = join(dir, 'zeus.db');
  const projectRoot = join(dir, 'project');
  const outsideRoot = join(dir, 'outside');
  const started: string[] = [];
  try {
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot,
      aiRuntimeSpawn: (command, args, options) => {
        started.push(`${command} ${args.join(' ')} @ ${options.cwd}`);
        return createImmediateSpawn()(command, args, options);
      },
    });

    const rejectedConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '尝试项目外目录',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'pwd'],
          cwd: outsideRoot,
        },
      },
    });

    expect(rejectedConfirmation.statusCode).toBe(400);
    expect(rejectedConfirmation.json()).toMatchObject({
      error: 'ZEUS_RUNTIME_CWD_OUTSIDE_PROJECT',
    });

    const createConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '项目内目录确认',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'pwd'],
          cwd: projectRoot,
        },
      },
    });
    const confirmationId = createConfirmation.json().id;
    await server.inject({
      method: 'POST',
      url: `/api/runtime/confirmations/${confirmationId}/confirm`,
      headers: { authorization: 'Bearer test-token' },
    });

    const rejectedSession = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'sh',
        args: ['-lc', 'pwd'],
        cwd: outsideRoot,
        confirmationId,
      },
    });

    expect(rejectedSession.statusCode).toBe(400);
    expect(rejectedSession.json()).toMatchObject({
      error: 'ZEUS_RUNTIME_CWD_OUTSIDE_PROJECT',
    });

    const validSession = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'sh',
        args: ['-lc', 'pwd'],
        cwd: projectRoot,
        confirmationId,
      },
    });

    expect(validSession.statusCode).toBe(201);
    expect(started).toEqual([`sh -lc pwd @ ${projectRoot}`]);
    await server.close();

    const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
    expect(auditLogs.map((entry) => entry.action)).toEqual(expect.arrayContaining(['security.runtime.cwd_rejected']));
    expect(JSON.stringify(auditLogs)).toContain(outsideRoot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects generic shell confirmations whose write command arguments target paths outside the project root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-shell-arg-boundary-'));
  const dbPath = join(dir, 'zeus.db');
  const projectRoot = join(dir, 'project');
  const outsideFile = join(dir, 'outside', 'result.txt');
  try {
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot,
      aiRuntimeSpawn: createImmediateSpawn(),
    });

    const rejectedConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '尝试写入项目外路径',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', `cp README.md ${outsideFile}`],
          cwd: projectRoot,
        },
      },
    });

    expect(rejectedConfirmation.statusCode).toBe(400);
    expect(rejectedConfirmation.json()).toMatchObject({
      error: 'ZEUS_RUNTIME_SHELL_PATH_OUTSIDE_PROJECT',
    });

    const safeConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '写入项目内路径',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', `mkdir -p ${join(projectRoot, 'tmp')}`],
          cwd: projectRoot,
        },
      },
    });

    expect(safeConfirmation.statusCode).toBe(201);
    await server.close();

    const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
    expect(auditLogs.map((entry) => entry.action)).toContain('security.runtime.shell_path_rejected');
    expect(JSON.stringify(auditLogs)).toContain(outsideFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects generic shell confirmations whose output redirection targets paths outside the project root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-shell-redirect-boundary-'));
  const dbPath = join(dir, 'zeus.db');
  const projectRoot = join(dir, 'project');
  const outsideFile = join(dir, 'outside', 'redirect.txt');
  try {
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot,
      aiRuntimeSpawn: createImmediateSpawn(),
    });

    const rejectedConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '尝试通过重定向写入项目外路径',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', `echo zeus > ${outsideFile}`],
          cwd: projectRoot,
        },
      },
    });

    expect(rejectedConfirmation.statusCode).toBe(400);
    expect(rejectedConfirmation.json()).toMatchObject({
      error: 'ZEUS_RUNTIME_SHELL_PATH_OUTSIDE_PROJECT',
    });

    const safeConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '通过重定向写入项目内路径',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', `echo zeus > ${join(projectRoot, 'tmp', 'redirect.txt')}`],
          cwd: projectRoot,
        },
      },
    });

    expect(safeConfirmation.statusCode).toBe(201);
    await server.close();

    const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
    expect(auditLogs.map((entry) => entry.action)).toContain('security.runtime.shell_path_rejected');
    expect(JSON.stringify(auditLogs)).toContain(outsideFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects generic shell confirmations that read or write sensitive local directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-sensitive-path-'));
  const dbPath = join(dir, 'zeus.db');
  const projectRoot = join(dir, 'project');
  try {
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot,
      aiRuntimeSpawn: createImmediateSpawn(),
    });

    const rejectedConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '尝试读取 SSH 私钥目录',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'cat ~/.ssh/id_rsa'],
          cwd: projectRoot,
        },
      },
    });

    expect(rejectedConfirmation.statusCode).toBe(400);
    expect(rejectedConfirmation.json()).toMatchObject({
      error: 'ZEUS_RUNTIME_SENSITIVE_PATH_REJECTED',
    });

    const safeConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '读取项目内文件',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', `cat ${join(projectRoot, 'README.md')}`],
          cwd: projectRoot,
        },
      },
    });

    expect(safeConfirmation.statusCode).toBe(201);
    await server.close();

    const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
    expect(auditLogs.map((entry) => entry.action)).toContain('security.runtime.sensitive_path_rejected');
    expect(JSON.stringify(auditLogs)).toContain('~/.ssh/id_rsa');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects generic shell confirmations that access likely secret file names inside the project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-secret-file-'));
  const dbPath = join(dir, 'zeus.db');
  const projectRoot = join(dir, 'project');
  try {
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot,
      aiRuntimeSpawn: createImmediateSpawn(),
    });

    const rejectedConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '尝试读取项目内 env 文件',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', `cat ${join(projectRoot, '.env')}`],
          cwd: projectRoot,
        },
      },
    });

    expect(rejectedConfirmation.statusCode).toBe(400);
    expect(rejectedConfirmation.json()).toMatchObject({
      error: 'ZEUS_RUNTIME_SECRET_FILE_REJECTED',
    });

    const safeConfirmation = await server.inject({
      method: 'POST',
      url: '/api/runtime/confirmations',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'start_generic_session',
        reason: '读取普通项目文档',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', `cat ${join(projectRoot, 'README.md')}`],
          cwd: projectRoot,
        },
      },
    });

    expect(safeConfirmation.statusCode).toBe(201);
    await server.close();

    const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
    expect(auditLogs.map((entry) => entry.action)).toContain('security.runtime.secret_file_rejected');
    expect(JSON.stringify(auditLogs)).toContain('.env');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects direct generic shell runtime sessions until a high-risk confirmation flow exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-generic-policy-'));
  const started: string[] = [];
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: (command, args, options) => {
        started.push(command);
        return createImmediateSpawn()(command, args, options);
      },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'sh',
        args: ['-lc', 'echo unsafe'],
        cwd: '/Users/david/hypha/zeus',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'ZEUS_GENERIC_RUNTIME_REQUIRES_CONFIRMATION',
    });
    expect(started).toEqual([]);
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('sends Telegram runtime progress summaries from real logs for long running task sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-api-telegram-summary-'));
  const sent: Array<{ chatId: number; text: string }> = [];
  const sender: TelegramMessageSender = {
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  };
  try {
    const dbPath = join(dir, 'zeus.db');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createRuntimeProgressSpawn(['真实日志 1', '真实日志 2', '真实日志 3', '真实日志 4']),
      telegramNotificationChatIds: [1001],
      secretStore: createMemorySecretStore('telegram-token-real'),
      telegramMessageSender: sender,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        title: '长任务摘要',
        description: '真实长任务',
        sourceContext: { source: 'runtime-summary-test' },
      },
    });
    const task = taskResponse.json();

    const startResponse = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        taskId: task.id,
        command: 'codex',
        args: ['run'],
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const session = startResponse.json();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = await server.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/events`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: 1001 });
    expect(sent[0].text).toContain('Runtime 阶段摘要');
    expect(sent[0].text).toContain('长任务摘要');
    expect(sent[0].text).toContain(session.id);
    expect(sent[0].text).toContain('真实日志 4');
    expect(sent[0].text).not.toContain('模拟');
    expect(events.json().map((event: { eventType: string }) => event.eventType)).toContain('telegram.runtime.summary.sent');
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('restores archived runtime sessions and creates a follow-up task from a real session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-api-continue-'));
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer test-token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();
    const startResponse = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: project.id,
        command: 'codex',
        args: ['--version'],
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const session = startResponse.json();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await server.inject({
      method: 'POST',
      url: `/api/runtime/sessions/${session.id}/archive`,
      headers: { authorization: 'Bearer test-token' },
    });

    const restoreResponse = await server.inject({
      method: 'POST',
      url: `/api/runtime/sessions/${session.id}/restore`,
      headers: { authorization: 'Bearer test-token' },
    });
    const taskResponse = await server.inject({
      method: 'POST',
      url: `/api/runtime/sessions/${session.id}/tasks`,
      headers: { authorization: 'Bearer test-token' },
      payload: {
        title: '继续分析 Runtime 会话',
        instruction: '基于真实 Runtime 日志继续排查风险',
      },
    });

    expect(restoreResponse.json().archived).toBe(false);
    expect(taskResponse.statusCode).toBe(201);
    expect(taskResponse.json().projectId).toBe(project.id);
    expect(taskResponse.json().description).toContain('基于真实 Runtime 日志继续排查风险');
    expect(taskResponse.json().sourceContextJson).toContain(session.id);
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('lists required runtime adapters and checks one adapter without fabricating availability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-api-adapters-'));
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
    });

    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/runtime/adapters',
      headers: { authorization: 'Bearer test-token' },
    });
    const checkResponse = await server.inject({
      method: 'GET',
      url: '/api/runtime/adapters/codex/check',
      headers: { authorization: 'Bearer test-token' },
    });
    const missingResponse = await server.inject({
      method: 'GET',
      url: '/api/runtime/adapters/unknown/check',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().map((adapter: { id: string }) => adapter.id)).toEqual(['codex', 'claude', 'gemini', 'generic']);
    expect(checkResponse.statusCode).toBe(200);
    expect(checkResponse.json()).toMatchObject({
      id: 'codex',
      name: 'Codex CLI',
      command: 'codex',
    });
    expect(typeof checkResponse.json().available).toBe('boolean');
    expect(checkResponse.json().reason).not.toHaveLength(0);
    expect(missingResponse.statusCode).toBe(404);
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('accepts runtime input, interrupt, resize, and exposes terminal snapshot through APIs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-api-terminal-'));
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  try {
    const dbPath = join(dir, 'zeus.db');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: () => {
        const callbacks = new Map<string, Array<(value: unknown) => void>>();
        const handle: AiRuntimeProcessHandle = {
          pid: 222,
          on(event, callback) {
            const entries = callbacks.get(event) ?? [];
            entries.push(callback as (value: unknown) => void);
            callbacks.set(event, entries);
            return handle;
          },
          kill(signal) {
            callbacks.get('stderr')?.forEach((callback) => callback(`signal:${signal}`));
          },
          write(input) {
            writes.push(input);
            callbacks.get('stdout')?.forEach((callback) => callback(`echo:${input}`));
          },
          resize(cols, rows) {
            resizes.push({ cols, rows });
          },
        };
        return handle;
      },
    });
    const startResponse = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        projectId: 'project-1',
        command: 'codex',
        cwd: '/Users/david/hypha/zeus',
      },
    });
    const session = startResponse.json();

    const inputResponse = await server.inject({
      method: 'POST',
      url: `/api/runtime/sessions/${session.id}/input`,
      headers: { authorization: 'Bearer test-token' },
      payload: { input: '继续执行' },
    });
    const resizeResponse = await server.inject({
      method: 'POST',
      url: `/api/runtime/sessions/${session.id}/resize`,
      headers: { authorization: 'Bearer test-token' },
      payload: { cols: 120, rows: 32 },
    });
    const interruptResponse = await server.inject({
      method: 'POST',
      url: `/api/runtime/sessions/${session.id}/interrupt`,
      headers: { authorization: 'Bearer test-token' },
    });
    const terminalResponse = await server.inject({
      method: 'GET',
      url: `/api/runtime/sessions/${session.id}/terminal`,
      headers: { authorization: 'Bearer test-token' },
    });
    const terminalEventsResponse = await server.inject({
      method: 'GET',
      url: `/api/runtime/sessions/${session.id}/terminal/events?limit=10&offset=0`,
      headers: { authorization: 'Bearer test-token' },
    });
    const sessionDirectory = join(dir, 'sessions', session.id);
    const rawLog = await readFile(join(sessionDirectory, 'terminal.raw.log'), 'utf8');
    const normalizedLog = await readFile(join(sessionDirectory, 'terminal.normalized.log'), 'utf8');
    const metadata = JSON.parse(await readFile(join(sessionDirectory, 'metadata.json'), 'utf8'));

    expect(inputResponse.statusCode).toBe(200);
    expect(resizeResponse.statusCode).toBe(200);
    expect(interruptResponse.statusCode).toBe(200);
    expect(terminalEventsResponse.statusCode).toBe(200);
    expect(writes).toEqual(['继续执行']);
    expect(resizes).toEqual([{ cols: 120, rows: 32 }]);
    expect(terminalResponse.json().logs.map((entry: { text: string }) => entry.text)).toContain('echo:继续执行');
    expect(terminalResponse.json().logs.map((entry: { text: string }) => entry.text)).toContain('signal:SIGINT');
    expect(terminalEventsResponse.json()).toMatchObject({
      sessionId: session.id,
      limit: 10,
      offset: 0,
      total: expect.any(Number),
    });
    expect(terminalEventsResponse.json().total).toBeGreaterThanOrEqual(2);
    expect(terminalEventsResponse.json().items.map((entry: { eventType: string; content: string }) => `${entry.eventType}:${entry.content}`)).toEqual(expect.arrayContaining(['stdout:echo:继续执行', 'stderr:signal:SIGINT']));
    expect(terminalEventsResponse.json().items.map((entry: { seq: number }) => entry.seq)).toEqual([...terminalEventsResponse.json().items.map((entry: { seq: number }) => entry.seq)].sort((left, right) => left - right));
    expect(terminalEventsResponse.json().items.every((entry: { rawChunkPath: string | null }) => typeof entry.rawChunkPath === 'string' && entry.rawChunkPath.includes('/chunks/'))).toBe(true);
    expect(rawLog).toContain('echo:继续执行');
    expect(rawLog).toContain('signal:SIGINT');
    expect(normalizedLog).toContain('[stdout] echo:继续执行');
    expect(normalizedLog).toContain('[stderr] signal:SIGINT');
    expect(metadata).toMatchObject({
      sessionId: session.id,
      projectId: 'project-1',
      command: 'codex',
      cwd: '/Users/david/hypha/zeus',
    });
    await server.close();
    const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
    expect(auditLogs.map((entry) => entry.action)).toEqual(expect.arrayContaining(['runtime.session.input', 'runtime.session.resize', 'runtime.session.interrupt']));
    expect(JSON.parse(auditLogs.find((entry) => entry.action === 'runtime.session.resize')!.payloadJson)).toMatchObject({ sessionId: session.id, cols: 120, rows: 32 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('reports approved PTY dependency status while keeping injected test spawns explicit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-api-pty-status-'));
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createImmediateSpawn(),
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/settings/runtime-status',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().terminal).toMatchObject({
      provider: 'child_process',
      pty: { available: true },
    });
    expect(response.json().terminal.pty.reason).toContain('node-pty 已可用');
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('uses node-pty as the default runtime provider when no test spawn overrides it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-api-pty-provider-'));
  try {
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/settings/runtime-status',
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().terminal).toMatchObject({
      provider: 'node-pty',
      pty: { available: true },
    });
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
