import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAiRuntimeSessionManager, type AiRuntimeProcessHandle, type AiRuntimeSpawn } from '@zeus/ai-runtime';
import { AuditLogRepository, createZeusDatabase } from '@zeus/storage';
import { startZeusLocalServer } from '../src/index.js';

function createImmediateRuntimeSpawn(invocations: Array<{ command: string; args: string[] }>): AiRuntimeSpawn {
  return (command, args) => {
    invocations.push({ command, args });
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 717,
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
      callbacks.get('stdout')?.forEach((callback) => callback('真实任务 Runtime 输出'));
      callbacks.get('exit')?.forEach((callback) => callback(0));
    });
    return handle;
  };
}

function createWritableRuntimeSpawn(invocations: Array<{ command: string; args: string[] }>, inputs: string[]): AiRuntimeSpawn {
  return (command, args) => {
    invocations.push({ command, args });
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 818,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        return handle;
      },
      kill() {
        callbacks.get('exit')?.forEach((callback) => callback(143));
      },
      write(input) {
        inputs.push(input);
        callbacks.get('stdout')?.forEach((callback) => callback(`收到后续输入：${input}`));
      },
    };
    queueMicrotask(() => {
      callbacks.get('stdout')?.forEach((callback) => callback('Runtime 等待后续输入'));
    });
    return handle;
  };
}

function createManualRuntimeSpawn(invocations: Array<{ command: string; args: string[] }>, handles: Array<{ stdout: (text: string) => void; stderr: (text: string) => void; exit: (code: number) => void }>): AiRuntimeSpawn {
  return (command, args) => {
    invocations.push({ command, args });
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 919,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        return handle;
      },
      kill() {
        callbacks.get('exit')?.forEach((callback) => callback(143));
      },
      write(input) {
        callbacks.get('stdout')?.forEach((callback) => callback(`收到后续输入：${input}`));
      },
    };
    handles.push({
      stdout: (text: string) => callbacks.get('stdout')?.forEach((callback) => callback(text)),
      stderr: (text: string) => callbacks.get('stderr')?.forEach((callback) => callback(text)),
      exit: (code: number) => callbacks.get('exit')?.forEach((callback) => callback(code)),
    });
    return handle;
  };
}

function createBurstRuntimeSpawn(invocations: Array<{ command: string; args: string[] }>, stdoutCount: number): AiRuntimeSpawn {
  return (command, args) => {
    invocations.push({ command, args });
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 1020,
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
      for (let index = 1; index <= stdoutCount; index += 1) {
        callbacks.get('stdout')?.forEach((callback) => callback(`启动输出 ${index}`));
      }
    });
    return handle;
  };
}

async function configureLegacyCliRuntime(baseUrl: string, defaultAdapterId: 'claude' | 'gemini' = 'claude'): Promise<void> {
  const response = await fetch(`${baseUrl}/api/runtime/settings`, {
    method: 'PUT',
    headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      defaultAdapterId,
      adapterModels: {},
      adapterDefaultArgs: {},
      adapterCliPaths: {},
      terminalEnv: {},
      shell: { path: null, login: false },
      concurrency: { maxPerProject: 1, maxGlobal: 2 },
      executionTimeoutSeconds: 3600,
      logRetentionDays: 30,
      autoConfirmationPolicy: 'never',
    }),
  });
  if (!response.ok) throw new Error(`Failed to configure legacy CLI runtime: ${response.status}`);
}

describe('Task control API', () => {
  it('creates a task with empty description and persists local image/file attachments in source context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-attachments-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();

      const response = await fetch(`${running.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          title: '分析截图里的异常',
          description: '',
          sourceContext: {
            path: project.localPath,
            attachments: [
              { path: '/Users/david/Desktop/error.png', name: 'error.png', kind: 'image' },
              { path: '/Users/david/Desktop/log.txt', name: 'log.txt', kind: 'file' },
            ],
          },
        }),
      });
      const task = await response.json();

      expect(response.status).toBe(201);
      expect(task.description).toBe('');
      expect(JSON.parse(task.sourceContextJson).attachments).toEqual([
        { path: '/Users/david/Desktop/error.png', name: 'error.png', kind: 'image' },
        { path: '/Users/david/Desktop/log.txt', name: 'log.txt', kind: 'file' },
      ]);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('transitions task status and records timeline events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-control-'));
    try {
      const dbPath = join(dir, 'zeus.db');
      const running = await startZeusLocalServer({
        dbPath,
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '真实任务',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();
      expect(task).toMatchObject({
        taskCode: 'ZEU-000001',
        taskSequence: 1,
        priority: 'normal',
        createdFrom: 'user',
      });
      expect(typeof task.createdAt).toBe('string');
      expect(typeof task.updatedAt).toBe('string');
      expect(typeof task.sourceContextJson).toBe('string');
      expect(JSON.stringify(task)).not.toContain('assignee');
      expect(JSON.stringify(task)).not.toContain('owner');
      const runningTask = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/status`, {
          method: 'PATCH',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ status: 'running' }),
        })
      ).json();
      expect(runningTask.status).toBe('running');
      const pausedTask = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/status`, {
          method: 'PATCH',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ status: 'paused' }),
        })
      ).json();
      expect(pausedTask.status).toBe('paused');
      const events = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/events`, {
          headers: { authorization: 'Bearer control-token' },
        })
      ).json();
      expect(events.map((event: { eventType: string }) => event.eventType)).toContain('task.status.changed');
      await running.close();
      const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
      const statusAuditPayloads = auditLogs.filter((entry) => entry.action === 'task.status.changed').map((entry) => JSON.parse(entry.payloadJson));
      expect(statusAuditPayloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: 'ready',
            to: 'running',
            taskId: task.id,
          }),
          expect.objectContaining({
            from: 'running',
            to: 'paused',
            taskId: task.id,
          }),
        ]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid status transitions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-control-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '真实任务',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();
      await fetch(`${running.baseUrl}/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'running' }),
      });
      await fetch(`${running.baseUrl}/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'completed' }),
      });
      const invalid = await fetch(`${running.baseUrl}/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'running' }),
      });
      expect(invalid.status).toBe(409);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs, pauses, continues, cancels, and retries a task through dedicated Runtime control endpoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-runtime-control-'));
    const invocations: Array<{ command: string; args: string[] }> = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createImmediateRuntimeSpawn(invocations),
      });
      await configureLegacyCliRuntime(running.baseUrl);
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '执行真实任务',
            description: '通过 dedicated API 启动 Runtime',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();

      const runResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/run`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const runBody = await runResponse.json();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const pauseResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/pause`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const continueResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/continue`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const cancelResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/cancel`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const retryResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/retry`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const sessions = await (await fetch(`${running.baseUrl}/api/runtime/sessions?taskId=${task.id}`, { headers: { authorization: 'Bearer control-token' } })).json();
      const events = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/events`, {
          headers: { authorization: 'Bearer control-token' },
        })
      ).json();

      expect(runResponse.status).toBe(201);
      expect(runBody.task.status).toBe('running');
      expect(runBody.runtimeSession.id).toMatch(/^ai-session-/);
      expect(runBody.conversation).toMatchObject({
        projectId: project.id,
        taskId: task.id,
        sessionId: runBody.runtimeSession.id,
        status: 'running',
      });
      expect(runBody.conversation.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            source: 'task_prompt',
            content: expect.stringContaining('执行真实任务'),
          }),
          expect.objectContaining({
            role: 'assistant',
            source: 'runtime_stdout',
            content: '真实任务 Runtime 输出',
          }),
        ]),
      );
      const persistedConversation = await (await fetch(`${running.baseUrl}/api/projects/${project.id}/conversations/${runBody.conversation.id}`, { headers: { authorization: 'Bearer control-token' } })).json();
      expect(persistedConversation.sessionId).toBe(runBody.runtimeSession.id);
      expect(persistedConversation.messages[0]).toMatchObject({
        role: 'user',
        source: 'task_prompt',
      });
      expect(persistedConversation.messages[0].content).toContain('执行真实任务');
      expect(pauseResponse.status).toBe(200);
      expect((await pauseResponse.json()).status).toBe('paused');
      expect(continueResponse.status).toBe(201);
      expect((await continueResponse.json()).task.status).toBe('running');
      expect(cancelResponse.status).toBe(200);
      expect((await cancelResponse.json()).status).toBe('cancelled');
      expect(retryResponse.status).toBe(200);
      expect((await retryResponse.json()).status).toBe('ready');
      expect(invocations[0]).toMatchObject({ command: 'claude' });
      expect(invocations[0].args.join('\n')).toContain('执行真实任务');
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(events.map((event: { eventType: string }) => event.eventType)).toContain('task.runtime.run');
      expect(events.map((event: { eventType: string }) => event.eventType)).toContain('task.runtime.continue');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allows task Runtime cwd to use the registered project local path when packaged app root is app.asar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-runtime-packaged-root-'));
    const invocations: Array<{ command: string; args: string[] }> = [];
    try {
      const packagedAppRoot = join(dir, 'Zeus.app', 'Contents', 'Resources', 'app.asar');
      const realProjectRoot = join(dir, 'real-project');
      await mkdir(packagedAppRoot, { recursive: true });
      await mkdir(realProjectRoot, { recursive: true });
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: packagedAppRoot,
        aiRuntimeSpawn: createImmediateRuntimeSpawn(invocations),
      });
      await configureLegacyCliRuntime(running.baseUrl);
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Packaged Project',
            localPath: realProjectRoot,
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '在真实项目目录运行',
            description: 'packaged appRoot 不能阻止注册项目路径',
            sourceContext: { path: realProjectRoot },
          }),
        })
      ).json();

      const runResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/run`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const runBody = await runResponse.json();

      expect(runResponse.status).toBe(201);
      expect(runBody.task.status).toBe('running');
      expect(runBody.conversation.status).toBe('running');
      expect(runBody).not.toHaveProperty('runtimeError');
      expect(invocations).toHaveLength(1);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['claude', 'gemini'] as const)('appends %s task conversation follow-up messages and forwards them to the matching Runtime session', async (adapterId) => {
    const dir = await mkdtemp(join(tmpdir(), `zeus-task-conversation-${adapterId}-message-`));
    const invocations: Array<{ command: string; args: string[] }> = [];
    const inputs: string[] = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createWritableRuntimeSpawn(invocations, inputs),
      });
      await configureLegacyCliRuntime(running.baseUrl, adapterId);
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '基于真实扫描和 Git 状态分析当前 Zeus 仓库',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();
      const runBody = await (await fetch(`${running.baseUrl}/api/tasks/${task.id}/run`, { method: 'POST', headers: { authorization: 'Bearer control-token' } })).json();

      const messageResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/conversations/${runBody.conversation.id}/messages`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          content: '继续检查任务发送链路',
        }),
      });
      const messageBody = await messageResponse.json();
      const persistedConversation = await (await fetch(`${running.baseUrl}/api/projects/${project.id}/conversations/${runBody.conversation.id}`, { headers: { authorization: 'Bearer control-token' } })).json();

      expect(messageResponse.status).toBe(201);
      const messageSources = messageBody.conversation.messages.map((message: { source: string }) => message.source);
      expect(messageSources).toEqual(expect.arrayContaining(['task_prompt', 'runtime_stdout', 'user_followup']));
      expect(messageBody.conversation.messages.find((message: { source: string }) => message.source === 'user_followup')).toMatchObject({
        role: 'user',
        content: '继续检查任务发送链路',
        source: 'user_followup',
      });
      expect(messageBody.conversation.messages.find((message: { source: string; content: string }) => message.source === 'runtime_stdout' && message.content.includes('收到后续输入'))).toBeDefined();
      expect(messageBody.runtimeSession.id).toBe(runBody.runtimeSession.id);
      expect(persistedConversation.messages.map((message: { source: string }) => message.source)).toEqual(expect.arrayContaining(['task_prompt', 'runtime_stdout', 'user_followup']));
      expect(inputs).toEqual(['继续检查任务发送链路\n']);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.command).toBe(adapterId);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('mirrors task Runtime stdout into the bound app-server conversation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-runtime-output-conversation-'));
    const invocations: Array<{ command: string; args: string[] }> = [];
    const runtimeHandles: Array<{ stdout: (text: string) => void; stderr: (text: string) => void; exit: (code: number) => void }> = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createManualRuntimeSpawn(invocations, runtimeHandles),
      });
      await configureLegacyCliRuntime(running.baseUrl);
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '基于真实扫描和 Git 状态分析当前 Zeus 仓库',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();
      const runBody = await (await fetch(`${running.baseUrl}/api/tasks/${task.id}/run`, { method: 'POST', headers: { authorization: 'Bearer control-token' } })).json();

      runtimeHandles[0].stdout('模型回复：已读取真实仓库结构，下一步会列出证据。');
      runtimeHandles[0].stderr('错误输出：权限检查失败。');
      const conversation = await (await fetch(`${running.baseUrl}/api/projects/${project.id}/conversations/${runBody.conversation.id}`, { headers: { authorization: 'Bearer control-token' } })).json();

      expect(conversation.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            source: 'runtime_stdout',
            content: '模型回复：已读取真实仓库结构，下一步会列出证据。',
            metadata: expect.objectContaining({
              sessionId: runBody.runtimeSession.id,
              runtimeLogId: expect.any(String),
              stream: 'stdout',
            }),
          }),
          expect.objectContaining({
            role: 'system',
            source: 'runtime_stderr',
            content: '错误输出：权限检查失败。',
            metadata: expect.objectContaining({
              sessionId: runBody.runtimeSession.id,
              runtimeLogId: expect.any(String),
              stream: 'stderr',
            }),
          }),
        ]),
      );
      expect(conversation.messages.filter((message: { source: string }) => message.source === 'runtime_stdout')).toHaveLength(1);
      expect(invocations).toHaveLength(1);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backfills every startup Runtime stdout chunk that arrives before the conversation binding is visible', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-runtime-output-backfill-'));
    const invocations: Array<{ command: string; args: string[] }> = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createBurstRuntimeSpawn(invocations, 205),
      });
      await configureLegacyCliRuntime(running.baseUrl);
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析启动输出',
            description: 'Runtime 启动阶段输出超过默认日志页大小',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();

      const runBody = await (await fetch(`${running.baseUrl}/api/tasks/${task.id}/run`, { method: 'POST', headers: { authorization: 'Bearer control-token' } })).json();
      const stdoutMessages = runBody.conversation.messages.filter((message: { source: string }) => message.source === 'runtime_stdout');

      expect(stdoutMessages).toHaveLength(205);
      expect(stdoutMessages[0].content).toBe('启动输出 1');
      expect(stdoutMessages.at(-1).content).toBe('启动输出 205');
      expect(invocations).toHaveLength(1);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['claude', 'gemini'],
    ['gemini', 'claude'],
  ] as const)('reconnects a stopped %s conversation without drifting to the new %s default', async (originalAdapterId, newDefaultAdapterId) => {
    const dir = await mkdtemp(join(tmpdir(), `zeus-task-conversation-${originalAdapterId}-reconnect-`));
    const dbPath = join(dir, 'zeus.db');
    const invocations: Array<{ command: string; args: string[] }> = [];
    try {
      const firstServer = await startZeusLocalServer({
        dbPath,
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createImmediateRuntimeSpawn(invocations),
      });
      await configureLegacyCliRuntime(firstServer.baseUrl, originalAdapterId);
      const project = await (
        await fetch(`${firstServer.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${firstServer.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '基于真实扫描和 Git 状态分析当前 Zeus 仓库',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();
      const runBody = await (await fetch(`${firstServer.baseUrl}/api/tasks/${task.id}/run`, { method: 'POST', headers: { authorization: 'Bearer control-token' } })).json();
      await firstServer.close();

      const secondServer = await startZeusLocalServer({
        dbPath,
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createImmediateRuntimeSpawn(invocations),
      });
      await configureLegacyCliRuntime(secondServer.baseUrl, newDefaultAdapterId);
      const messageResponse = await fetch(`${secondServer.baseUrl}/api/projects/${project.id}/conversations/${runBody.conversation.id}/messages`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          content: '继续检查旧 Runtime 丢失后的会话续接',
        }),
      });
      const messageBody = await messageResponse.json();
      const persistedConversation = await (await fetch(`${secondServer.baseUrl}/api/projects/${project.id}/conversations/${runBody.conversation.id}`, { headers: { authorization: 'Bearer control-token' } })).json();

      expect(messageResponse.status).toBe(201);
      expect(messageBody).not.toHaveProperty('runtimeError');
      expect(messageBody.runtimeSession.id).not.toBe(runBody.runtimeSession.id);
      expect(messageBody.conversation.sessionId).toBe(messageBody.runtimeSession.id);
      expect(messageBody.conversation.messages.map((message: { source: string }) => message.source)).toEqual(expect.arrayContaining(['task_prompt', 'runtime_stdout', 'user_followup', 'task_runtime_reconnected']));
      expect(persistedConversation.sessionId).toBe(messageBody.runtimeSession.id);
      expect(invocations).toHaveLength(2);
      expect(invocations[0].command).toBe(originalAdapterId);
      expect(invocations[1].command).toBe(originalAdapterId);
      expect(invocations[1].args.join('\n')).toContain('继续检查旧 Runtime 丢失后的会话续接');
      expect(invocations[1].args.join('\n')).toContain('legacy CLI');
      expect(invocations[1].args.join('\n')).not.toContain('同一个 app-server 会话');
      expect(messageBody.conversation.messages.find((message: { source: string }) => message.source === 'task_runtime_reconnected').metadata).toMatchObject({
        adapterId: originalAdapterId,
        adapterCommand: originalAdapterId,
      });
      await secondServer.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['project', 'task', 'command'] as const)('rejects a running legacy session whose %s identity does not match before appending or writing', async (mismatchKind) => {
    const dir = await mkdtemp(join(tmpdir(), `zeus-task-conversation-${mismatchKind}-mismatch-`));
    const dbPath = join(dir, 'zeus.db');
    const invocations: Array<{ command: string; args: string[] }> = [];
    const inputs: string[] = [];
    const manager = createAiRuntimeSessionManager({
      allowedRoot: '/Users/david/hypha/zeus',
      spawn: createWritableRuntimeSpawn(invocations, inputs),
    });
    try {
      const firstServer = await startZeusLocalServer({
        dbPath,
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeManager: manager,
      });
      await configureLegacyCliRuntime(firstServer.baseUrl);
      const project = await (
        await fetch(`${firstServer.baseUrl}/api/projects`, {
          method: 'POST',
          headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Zeus', localPath: '/Users/david/hypha/zeus' }),
        })
      ).json();
      const task = await (
        await fetch(`${firstServer.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: project.id, title: '验证会话身份', description: '拒绝错配 Runtime', sourceContext: { path: project.localPath } }),
        })
      ).json();
      const runBody = await (await fetch(`${firstServer.baseUrl}/api/tasks/${task.id}/run`, { method: 'POST', headers: { authorization: 'Bearer control-token' } })).json();
      const mismatchedSession = await manager.startSession({
        projectId: mismatchKind === 'project' ? 'another-project' : project.id,
        taskId: mismatchKind === 'task' ? 'another-task' : task.id,
        command: mismatchKind === 'command' ? 'gemini' : 'claude',
        cwd: project.localPath,
      });
      await firstServer.close();

      const db = await createZeusDatabase(dbPath);
      db.execute(`UPDATE conversations SET session_id = ? WHERE id = ?`, [mismatchedSession.id, runBody.conversation.id]);
      await db.save();

      const secondServer = await startZeusLocalServer({
        dbPath,
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeManager: manager,
      });
      const before = await (await fetch(`${secondServer.baseUrl}/api/projects/${project.id}/conversations/${runBody.conversation.id}`, { headers: { authorization: 'Bearer control-token' } })).json();
      const response = await fetch(`${secondServer.baseUrl}/api/projects/${project.id}/conversations/${runBody.conversation.id}/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
        body: JSON.stringify({ content: '不得写入错配会话' }),
      });
      const after = await (await fetch(`${secondServer.baseUrl}/api/projects/${project.id}/conversations/${runBody.conversation.id}`, { headers: { authorization: 'Bearer control-token' } })).json();

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'ZEUS_LEGACY_RUNTIME_IDENTITY_MISMATCH' });
      expect(after.messages).toHaveLength(before.messages.length);
      expect(inputs).toEqual([]);
      expect(invocations).toHaveLength(2);
      await secondServer.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a failed app-server conversation when Runtime startup throws before the CLI can run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-runtime-failure-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: () => {
          throw new Error('codex unavailable');
        },
      });
      await configureLegacyCliRuntime(running.baseUrl);
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '验证失败恢复',
            description: 'Runtime 启动失败也要留下 app-server 会话',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();

      const runResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/run`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const runBody = await runResponse.json();
      const persistedTask = await (await fetch(`${running.baseUrl}/api/tasks/${task.id}`, { headers: { authorization: 'Bearer control-token' } })).json();
      const conversations = await (await fetch(`${running.baseUrl}/api/projects/${project.id}/conversations`, { headers: { authorization: 'Bearer control-token' } })).json();

      expect(runResponse.status).toBe(201);
      expect(runBody).toMatchObject({
        task: { id: task.id, status: 'failed' },
        conversation: {
          projectId: project.id,
          taskId: task.id,
          sessionId: null,
          status: 'failed',
        },
        runtimeError: {
          message: 'codex unavailable',
        },
      });
      expect(persistedTask.status).toBe('failed');
      expect(conversations.items).toHaveLength(1);
      expect(conversations.items[0]).toMatchObject({
        projectId: project.id,
        taskId: task.id,
        sessionId: null,
        status: 'failed',
      });
      expect(conversations.items[0].messages.map((message: { source: string }) => message.source)).toEqual(['task_prompt', 'task_runtime_error']);
      expect(conversations.items[0].messages[1].content).toContain('codex unavailable');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('archives a task and hides it from dashboard active tasks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-archive-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '真实任务',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();

      const archiveResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/archive`, {
        method: 'POST',
        headers: { authorization: 'Bearer control-token' },
      });
      expect(archiveResponse.status).toBe(200);
      expect((await archiveResponse.json()).id).toBe(task.id);

      const dashboard = await (
        await fetch(`${running.baseUrl}/api/dashboard`, {
          headers: { authorization: 'Bearer control-token' },
        })
      ).json();
      expect(dashboard.tasks).toHaveLength(0);
      const archivedTasks = await (await fetch(`${running.baseUrl}/api/tasks/archived?projectId=${project.id}`, { headers: { authorization: 'Bearer control-token' } })).json();
      expect(archivedTasks.map((item: { id: string }) => item.id)).toEqual([task.id]);

      const restoreResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/restore`, {
        method: 'POST',
        headers: { authorization: 'Bearer control-token' },
      });
      expect(restoreResponse.status).toBe(200);
      expect((await restoreResponse.json()).id).toBe(task.id);
      const restoredDashboard = await (
        await fetch(`${running.baseUrl}/api/dashboard`, {
          headers: { authorization: 'Bearer control-token' },
        })
      ).json();
      expect(restoredDashboard.tasks).toHaveLength(1);
      const restoredArchivedTasks = await (await fetch(`${running.baseUrl}/api/tasks/archived?projectId=${project.id}`, { headers: { authorization: 'Bearer control-token' } })).json();
      expect(restoredArchivedTasks).toEqual([]);
      const events = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/events`, {
          headers: { authorization: 'Bearer control-token' },
        })
      ).json();
      expect(events.map((event: { title: string }) => event.title)).toContain('任务已归档');
      expect(events.map((event: { title: string }) => event.title)).toContain('任务已恢复');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists tasks with query, status, tag, and sort filters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-search-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      await fetch(`${running.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          title: '修复 API Bug',
          description: '真实后端缺陷',
          sourceContext: { path: project.localPath },
          tags: ['backend', 'bug'],
        }),
      });
      const uiTask = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '优化任务 UI',
            description: '真实前端任务',
            sourceContext: { path: project.localPath },
            tags: ['frontend'],
          }),
        })
      ).json();
      await fetch(`${running.baseUrl}/api/tasks/${uiTask.id}/status`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'running' }),
      });

      const response = await fetch(`${running.baseUrl}/api/tasks?projectId=${project.id}&query=Bug&status=ready&tag=backend&sortBy=title&sortDirection=asc`, { headers: { authorization: 'Bearer control-token' } });

      expect(response.status).toBe(200);
      const filtered = await response.json();
      expect(filtered.map((task: { title: string }) => task.title)).toEqual(['修复 API Bug']);
      expect(filtered[0].tags).toEqual(['backend', 'bug']);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads, edits, retags, and soft deletes a task through APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-detail-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '真实任务',
            sourceContext: { path: project.localPath },
            tags: ['analysis'],
          }),
        })
      ).json();

      const detailResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}`, { headers: { authorization: 'Bearer control-token' } });
      const updateResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: '分析 Zeus 项目结构',
          description: '更新后的真实任务',
        }),
      });
      const tagResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/tags`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tags: ['analysis', 'backend'] }),
      });
      const deleteResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer control-token' },
      });
      const tasksResponse = await fetch(`${running.baseUrl}/api/tasks?projectId=${project.id}`, { headers: { authorization: 'Bearer control-token' } });

      expect(detailResponse.status).toBe(200);
      expect((await updateResponse.json()).title).toBe('分析 Zeus 项目结构');
      expect((await tagResponse.json()).tags).toEqual(['analysis', 'backend']);
      expect(deleteResponse.status).toBe(200);
      expect(await tasksResponse.json()).toEqual([]);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
