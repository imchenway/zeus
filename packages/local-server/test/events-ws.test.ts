import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { createLocalServer } from '../src/index.js';
import type { AiRuntimeProcessHandle, AiRuntimeSpawn } from '@zeus/ai-runtime';

interface ZeusEventMessage {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

function waitForMessage(socket: WebSocket, predicate: (message: ZeusEventMessage) => boolean, timeoutMs = 2_000): Promise<ZeusEventMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for Zeus WebSocket event')), timeoutMs);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ZeusEventMessage;
      if (predicate(message)) {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
}

function createHoldingRuntimeSpawn(): AiRuntimeSpawn {
  return () => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 929,
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
      callbacks.get('stdout')?.forEach((callback) => callback('真实 Runtime 已启动'));
    });
    return handle;
  };
}

function createCompletingRuntimeSpawn(): AiRuntimeSpawn {
  return () => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 930,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        return handle;
      },
      kill() {},
    };
    queueMicrotask(() => {
      callbacks.get('stdout')?.forEach((callback) => callback('真实 Runtime stdout'));
      callbacks.get('stderr')?.forEach((callback) => callback('真实 Runtime stderr'));
      callbacks.get('exit')?.forEach((callback) => callback(0));
    });
    return handle;
  };
}

describe('Zeus local event WebSocket', () => {
  it('streams authenticated local events without exposing the API token in payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-events-ws-'));
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { headers: { authorization: 'Bearer test-token' } });
      await waitForMessage(socket, (message) => message.type === 'server.connected');
      const projectCreated = waitForMessage(socket, (message) => message.type === 'project.created');

      const response = await fetch(`http://127.0.0.1:${address.port}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
          description: '真实当前仓库',
        }),
      });
      expect(response.status).toBe(201);

      const event = await projectCreated;
      expect(event).toMatchObject({
        type: 'project.created',
        payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
      });
      const project = (await response.json()) as { id: string };
      const taskCreated = waitForMessage(socket, (message) => message.type === 'task.created');
      const taskResponse = await fetch(`http://127.0.0.1:${address.port}/api/tasks`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          title: '分析当前项目结构',
          description: '真实任务',
          sourceContext: { path: '/Users/david/hypha/zeus' },
        }),
      });
      expect(taskResponse.status).toBe(201);
      const taskEvent = await taskCreated;
      expect(taskEvent).toMatchObject({
        type: 'task.created',
        payload: { projectId: project.id, title: '分析当前项目结构' },
      });
      const task = (await taskResponse.json()) as { id: string };
      const taskStatusChanged = waitForMessage(socket, (message) => message.type === 'task.status.changed');
      const statusResponse = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'running' }),
      });
      expect(statusResponse.status).toBe(200);
      const statusEvent = await taskStatusChanged;
      expect(statusEvent).toMatchObject({
        type: 'task.status.changed',
        payload: {
          taskId: task.id,
          projectId: project.id,
          from: 'ready',
          to: 'running',
          source: 'task.status.patch',
        },
      });
      expect(JSON.stringify([event, taskEvent, statusEvent])).not.toContain('test-token');
      socket.close();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('streams runtime session lifecycle events without exposing command output or API tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-events-runtime-ws-'));
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createHoldingRuntimeSpawn(),
    });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { headers: { authorization: 'Bearer test-token' } });
      await waitForMessage(socket, (message) => message.type === 'server.connected');
      const runtimeCreated = waitForMessage(socket, (message) => message.type === 'runtime.session.created');

      const startResponse = await fetch(`http://127.0.0.1:${address.port}/api/runtime/sessions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: 'project-1',
          taskId: 'task-1',
          command: 'codex',
          args: ['--version'],
          cwd: '/Users/david/hypha/zeus',
        }),
      });
      expect(startResponse.status).toBe(201);
      const session = (await startResponse.json()) as { id: string };
      const createdEvent = await runtimeCreated;
      expect(createdEvent).toMatchObject({
        type: 'runtime.session.created',
        payload: {
          sessionId: session.id,
          projectId: 'project-1',
          taskId: 'task-1',
          command: 'codex',
          status: 'running',
        },
      });

      const runtimeStopped = waitForMessage(socket, (message) => message.type === 'runtime.session.stopped');
      const stopResponse = await fetch(`http://127.0.0.1:${address.port}/api/runtime/sessions/${session.id}/stop`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(stopResponse.status).toBe(200);
      const stoppedEvent = await runtimeStopped;
      expect(stoppedEvent).toMatchObject({
        type: 'runtime.session.stopped',
        payload: {
          sessionId: session.id,
          projectId: 'project-1',
          taskId: 'task-1',
          status: 'stopped',
        },
      });
      expect(JSON.stringify([createdEvent, stoppedEvent])).not.toContain('test-token');
      expect(JSON.stringify([createdEvent, stoppedEvent])).not.toContain('真实 Runtime 已启动');
      socket.close();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('streams runtime output, error, and ended events from real runtime logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-events-runtime-output-ws-'));
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createCompletingRuntimeSpawn(),
    });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { headers: { authorization: 'Bearer test-token' } });
      await waitForMessage(socket, (message) => message.type === 'server.connected');
      const runtimeOutput = waitForMessage(socket, (message) => message.type === 'runtime.session.output');
      const runtimeError = waitForMessage(socket, (message) => message.type === 'runtime.session.error');
      const runtimeEnded = waitForMessage(socket, (message) => message.type === 'runtime.session.ended');

      const startResponse = await fetch(`http://127.0.0.1:${address.port}/api/runtime/sessions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: 'project-1',
          taskId: 'task-1',
          command: 'codex',
          args: ['--version'],
          cwd: '/Users/david/hypha/zeus',
        }),
      });
      expect(startResponse.status).toBe(201);
      const session = (await startResponse.json()) as { id: string };

      await expect(runtimeOutput).resolves.toMatchObject({
        type: 'runtime.session.output',
        payload: {
          sessionId: session.id,
          stream: 'stdout',
          text: '真实 Runtime stdout',
        },
      });
      await expect(runtimeError).resolves.toMatchObject({
        type: 'runtime.session.error',
        payload: {
          sessionId: session.id,
          stream: 'stderr',
          text: '真实 Runtime stderr',
        },
      });
      await expect(runtimeEnded).resolves.toMatchObject({
        type: 'runtime.session.ended',
        payload: {
          sessionId: session.id,
          projectId: 'project-1',
          taskId: 'task-1',
          status: 'exited',
          exitCode: 0,
        },
      });
      socket.close();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('streams Git and Runtime confirmation-required events for native notifications without leaking secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-events-confirmation-ws-'));
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { headers: { authorization: 'Bearer test-token' } });
      await waitForMessage(socket, (message) => message.type === 'server.connected');
      const gitConfirmationCreated = waitForMessage(socket, (message) => message.type === 'git.confirmation.created');
      const runtimeConfirmationCreated = waitForMessage(socket, (message) => message.type === 'runtime.confirmation.created');

      const gitResponse = await fetch(`http://127.0.0.1:${address.port}/api/git/confirmations`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'commit',
          reason: '提交真实变更',
          message: 'feat: 不包含 secret-real-123',
        }),
      });
      expect(gitResponse.status).toBe(201);

      const runtimeResponse = await fetch(`http://127.0.0.1:${address.port}/api/runtime/confirmations`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'start_generic_session',
          reason: '运行高风险 shell secret-real-123',
          session: {
            projectId: 'project-1',
            command: 'sh',
            args: ['-lc', 'echo secret-real-123'],
            cwd: '/Users/david/hypha/zeus',
          },
        }),
      });
      expect(runtimeResponse.status).toBe(201);

      const gitEvent = await gitConfirmationCreated;
      const runtimeEvent = await runtimeConfirmationCreated;
      expect(gitEvent).toMatchObject({
        type: 'git.confirmation.created',
        payload: { operation: 'commit', riskLevel: 'high' },
      });
      expect(runtimeEvent).toMatchObject({
        type: 'runtime.confirmation.created',
        payload: {
          action: 'start_generic_session',
          projectId: 'project-1',
          riskLevel: 'high',
        },
      });
      expect(JSON.stringify([gitEvent, runtimeEvent])).not.toContain('test-token');
      expect(JSON.stringify([gitEvent, runtimeEvent])).not.toContain('secret-real-123');
      socket.close();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('streams security confirmation approved and rejected events for Git and Runtime confirmation decisions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-events-confirmation-decision-ws-'));
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { headers: { authorization: 'Bearer test-token' } });
      await waitForMessage(socket, (message) => message.type === 'server.connected');

      const gitCreated = await fetch(`http://127.0.0.1:${address.port}/api/git/confirmations`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'commit',
          reason: '提交真实变更 secret-real-123',
          message: 'feat: real change',
        }),
      });
      expect(gitCreated.status).toBe(201);
      const gitConfirmationId = ((await gitCreated.json()) as { id: string }).id;
      const gitApprovedEvent = waitForMessage(socket, (message) => message.type === 'security.confirmation.approved' && message.payload.confirmationId === gitConfirmationId);
      const gitConfirmed = await fetch(`http://127.0.0.1:${address.port}/api/git/confirmations/${gitConfirmationId}/confirm`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(gitConfirmed.status).toBe(200);

      const gitRejectCreated = await fetch(`http://127.0.0.1:${address.port}/api/git/confirmations`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operation: 'stash', reason: '暂存真实变更' }),
      });
      expect(gitRejectCreated.status).toBe(201);
      const gitRejectConfirmationId = ((await gitRejectCreated.json()) as { id: string }).id;
      const gitRejectedEvent = waitForMessage(socket, (message) => message.type === 'security.confirmation.rejected' && message.payload.confirmationId === gitRejectConfirmationId);
      const gitRejected = await fetch(`http://127.0.0.1:${address.port}/api/git/confirmations/${gitRejectConfirmationId}/reject`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: '用户拒绝 secret-real-123' }),
      });
      expect(gitRejected.status).toBe(200);

      const runtimeCreated = await fetch(`http://127.0.0.1:${address.port}/api/runtime/confirmations`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'start_generic_session',
          reason: '运行高风险 shell secret-real-123',
          session: {
            projectId: 'project-1',
            command: 'sh',
            args: ['-lc', 'echo ok'],
            cwd: '/Users/david/hypha/zeus',
          },
        }),
      });
      expect(runtimeCreated.status).toBe(201);
      const runtimeConfirmationId = ((await runtimeCreated.json()) as { id: string }).id;
      const runtimeApprovedEvent = waitForMessage(socket, (message) => message.type === 'security.confirmation.approved' && message.payload.confirmationId === runtimeConfirmationId);
      const runtimeConfirmed = await fetch(`http://127.0.0.1:${address.port}/api/runtime/confirmations/${runtimeConfirmationId}/confirm`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(runtimeConfirmed.status).toBe(200);

      const runtimeRejectCreated = await fetch(`http://127.0.0.1:${address.port}/api/runtime/confirmations`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'start_generic_session',
          reason: '准备运行后取消 shell secret-real-123',
          session: {
            projectId: 'project-1',
            command: 'sh',
            args: ['-lc', 'echo reject'],
            cwd: '/Users/david/hypha/zeus',
          },
        }),
      });
      expect(runtimeRejectCreated.status).toBe(201);
      const runtimeRejectConfirmationId = ((await runtimeRejectCreated.json()) as { id: string }).id;
      const runtimeRejectedEvent = waitForMessage(socket, (message) => message.type === 'security.confirmation.rejected' && message.payload.confirmationId === runtimeRejectConfirmationId);
      const runtimeRejected = await fetch(`http://127.0.0.1:${address.port}/api/runtime/confirmations/${runtimeRejectConfirmationId}/reject`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: '用户拒绝 Runtime secret-real-123' }),
      });
      expect(runtimeRejected.status).toBe(200);

      const events = await Promise.all([gitApprovedEvent, gitRejectedEvent, runtimeApprovedEvent, runtimeRejectedEvent]);
      expect(events.map((event) => event.type)).toEqual(['security.confirmation.approved', 'security.confirmation.rejected', 'security.confirmation.approved', 'security.confirmation.rejected']);
      expect(events[0]).toMatchObject({
        payload: { operation: 'commit', riskLevel: 'high' },
      });
      expect(events[1]).toMatchObject({
        payload: { operation: 'stash', riskLevel: 'high' },
      });
      expect(events[2]).toMatchObject({
        payload: {
          action: 'start_generic_session',
          projectId: 'project-1',
          riskLevel: 'high',
        },
      });
      expect(events[3]).toMatchObject({
        payload: {
          action: 'start_generic_session',
          projectId: 'project-1',
          riskLevel: 'high',
        },
      });
      expect(JSON.stringify(events)).not.toContain('test-token');
      expect(JSON.stringify(events)).not.toContain('secret-real-123');
      socket.close();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('streams project scan and graph view generation events from real scans', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-events-scan-ws-'));
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { headers: { authorization: 'Bearer test-token' } });
      await waitForMessage(socket, (message) => message.type === 'server.connected');
      const scanStarted = waitForMessage(socket, (message) => message.type === 'project.scan.started', 10_000);
      const scanProgress = waitForMessage(socket, (message) => message.type === 'project.scan.progress' && message.payload.stage === 'index_source', 10_000);
      const scanCompleted = waitForMessage(socket, (message) => message.type === 'project.scan.completed', 10_000);

      const scanResponse = await fetch(`http://127.0.0.1:${address.port}/api/graph/scan-current`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(scanResponse.status).toBe(200);
      const scanBody = (await scanResponse.json()) as {
        fileCount: number;
        nodeCount: number;
        viewCount: number;
      };
      await expect(scanStarted).resolves.toMatchObject({
        type: 'project.scan.started',
        payload: { projectName: 'Zeus', rootPath: '/Users/david/hypha/zeus' },
      });
      await expect(scanProgress).resolves.toMatchObject({
        type: 'project.scan.progress',
        payload: {
          projectName: 'Zeus',
          stage: 'index_source',
          message: '扫描真实源码文件',
        },
      });
      await expect(scanCompleted).resolves.toMatchObject({
        type: 'project.scan.completed',
        payload: {
          projectName: 'Zeus',
          fileCount: scanBody.fileCount,
          nodeCount: scanBody.nodeCount,
          viewCount: scanBody.viewCount,
        },
      });

      const graphViewGenerated = waitForMessage(socket, (message) => message.type === 'graph.view.generated', 10_000);
      const viewResponse = await fetch(`http://127.0.0.1:${address.port}/api/graph/views/architecture`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(viewResponse.status).toBe(200);
      const view = (await viewResponse.json()) as {
        viewType: string;
        nodes: unknown[];
        edges: unknown[];
      };
      await expect(graphViewGenerated).resolves.toMatchObject({
        type: 'graph.view.generated',
        payload: {
          viewType: view.viewType,
          nodeCount: view.nodes.length,
          edgeCount: view.edges.length,
        },
      });
      socket.close();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('streams readonly git diff and snapshot events without exposing diff text or API tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-events-git-ws-'));
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { headers: { authorization: 'Bearer test-token' } });
      await waitForMessage(socket, (message) => message.type === 'server.connected');
      const diffUpdated = waitForMessage(socket, (message) => message.type === 'git.diff.updated');
      const snapshotCreated = waitForMessage(socket, (message) => message.type === 'git.snapshot.created');

      const response = await fetch(`http://127.0.0.1:${address.port}/api/git/diff?projectId=project-real&taskId=task-real`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(response.status).toBe(200);
      const diff = (await response.json()) as {
        isRepository: boolean;
        files: string[];
        diffText: string;
      };
      const diffEvent = await diffUpdated;
      const snapshotEvent = await snapshotCreated;

      expect(diffEvent).toMatchObject({
        type: 'git.diff.updated',
        payload: {
          isRepository: diff.isRepository,
          fileCount: diff.files.length,
          diffTextLength: diff.diffText.length,
        },
      });
      expect(snapshotEvent).toMatchObject({
        type: 'git.snapshot.created',
        payload: {
          projectId: 'project-real',
          taskId: 'task-real',
          snapshotType: 'readonly_diff',
          fileCount: diff.files.length,
        },
      });
      expect(JSON.stringify([diffEvent, snapshotEvent])).not.toContain('test-token');
      if (diff.diffText) expect(JSON.stringify([diffEvent, snapshotEvent])).not.toContain(diff.diffText.slice(0, 30));
      socket.close();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
