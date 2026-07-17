import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { createLocalServer } from '../src/index.js';
import type { AiRuntimeProcessHandle, AiRuntimeSpawn, CodexAppServerEvent, CodexAppServerManager, CodexTransportState, CodexTurnStartInput, CodexTurnSteerInput } from '@zeus/ai-runtime';

interface ZeusEventMessage {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

function waitForMessage(socket: WebSocket, predicate: (message: ZeusEventMessage) => boolean, timeoutMs = 2_000): Promise<ZeusEventMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for Zeus WebSocket event'));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as ZeusEventMessage;
      if (predicate(message)) {
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve(message);
      }
    };
    socket.on('message', onMessage);
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

class EventCodexManager implements CodexAppServerManager {
  private readonly listeners = new Set<(event: CodexAppServerEvent) => unknown>();
  private turnSequence = 0;
  readonly state: CodexTransportState = {
    type: 'ready',
    generationId: 'generation-ws',
    capabilities: { generationId: 'generation-ws', initializedAt: '2026-07-13T07:00:00.000Z', models: [], supportedModels: ['gpt-5.4'] },
  };

  async ensureReady() {
    return this.state.capabilities;
  }
  async startThread() {
    return { id: 'thread-ws', turns: [] };
  }
  async resumeThread(input: { threadId: string }) {
    return { id: input.threadId, turns: [] };
  }
  async readThread(input: { threadId: string }) {
    return { id: input.threadId, turns: [] };
  }
  async startTurn(input: CodexTurnStartInput) {
    this.turnSequence += 1;
    return { id: this.turnSequence === 1 ? 'turn-ws' : `turn-ws-${this.turnSequence}`, threadId: input.threadId, items: [] };
  }
  async steerTurn(input: CodexTurnSteerInput) {
    return { turnId: input.turnId };
  }
  async interruptTurn() {}
  async respondToServerRequest() {}
  subscribe(listener: (event: CodexAppServerEvent) => unknown) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getState() {
    return this.state;
  }
  async prepareForShutdown() {}
  async close() {}

  async emit(method: string, params: unknown, sequence: number, requestId?: string | number) {
    const event: CodexAppServerEvent = {
      generationId: 'generation-ws',
      sequence,
      method,
      params,
      receivedAt: `2026-07-13T07:00:${String(sequence).padStart(2, '0')}.000Z`,
      ...(requestId === undefined ? {} : { requestId }),
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

describe('Zeus local event WebSocket', () => {
  it('broadcasts an authoritative typed queue snapshot after every queue mutation route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-native-queue-events-ws-'));
    const manager = new EventCodexManager();
    const server = await createLocalServer({ dbPath: join(dir, 'zeus.db'), apiToken: 'test-token', projectRoot: dir, codexAppServerManager: manager });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
      const project = (await (await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'Queue WS', localPath: dir }) })).json()) as { id: string };
      const task = (await (
        await fetch(`${baseUrl}/api/tasks`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ projectId: project.id, title: 'Queue WS', description: 'queue route events', allowCodeChanges: false, allowTests: false, allowGitCommit: false }),
        })
      ).json()) as { id: string };
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { headers: { authorization: 'Bearer test-token' } });
      await waitForMessage(socket, (message) => message.type === 'server.connected');
      const created = (await (
        await fetch(`${baseUrl}/api/tasks/${task.id}/conversations`, {
          method: 'POST',
          headers: { ...headers, 'idempotency-key': 'queue-ws-parent' },
          body: JSON.stringify({ mode: 'create', content: 'active parent' }),
        })
      ).json()) as { conversation: { id: string } };
      const conversationUrl = `${baseUrl}/api/projects/${project.id}/conversations/${created.conversation.id}`;
      const queue = async (key: string, content: string) => {
        const changed = waitForMessage(socket, (message) => message.type === 'conversation.queue.changed');
        const response = await fetch(`${conversationUrl}/messages`, {
          method: 'POST',
          headers: { ...headers, 'idempotency-key': key },
          body: JSON.stringify({ content, delivery: 'queue' }),
        });
        expect(response.status).toBe(202);
        await changed;
        return (await response.json()) as { submission: { id: string } };
      };
      const first = await queue('queue-ws-first', 'first');
      const second = await queue('queue-ws-second', 'second');
      const third = await queue('queue-ws-third', 'third');

      const editedEvent = waitForMessage(socket, (message) => message.type === 'conversation.queue.changed');
      const edited = await fetch(`${conversationUrl}/queue/${first.submission.id}`, { method: 'PATCH', headers, body: JSON.stringify({ content: 'first edited' }) });
      expect(edited.status).toBe(200);
      await expect(editedEvent).resolves.toMatchObject({
        payload: {
          projectId: project.id,
          conversationId: created.conversation.id,
          generationId: expect.stringMatching(/^zeus-local-/u),
          sequence: expect.any(Number),
          queue: { submissions: expect.arrayContaining([expect.objectContaining({ id: first.submission.id, content: 'first edited' })]) },
        },
      });

      const reorderedEvent = waitForMessage(socket, (message) => message.type === 'conversation.queue.changed');
      const reordered = await fetch(`${conversationUrl}/queue/reorder`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ orderedSubmissionIds: [third.submission.id, first.submission.id, second.submission.id] }),
      });
      expect(reordered.status).toBe(200);
      expect(((await reorderedEvent).payload.queue as { submissions: Array<{ id: string }> }).submissions.map((submission) => submission.id)).toEqual([third.submission.id, first.submission.id, second.submission.id]);

      const deletedEvent = waitForMessage(socket, (message) => message.type === 'conversation.queue.changed');
      const deleted = await fetch(`${conversationUrl}/queue/${second.submission.id}`, { method: 'DELETE', headers: { authorization: 'Bearer test-token' } });
      expect(deleted.status).toBe(200);
      expect(((await deletedEvent).payload.queue as { submissions: Array<{ id: string }> }).submissions.map((submission) => submission.id)).toEqual([third.submission.id, first.submission.id]);

      const sentEvent = waitForMessage(socket, (message) => message.type === 'conversation.queue.changed');
      const sent = await fetch(`${conversationUrl}/queue/${third.submission.id}/send-now`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
      expect(sent.status).toBe(202);
      expect(((await sentEvent).payload.queue as { submissions: Array<{ id: string }> }).submissions.map((submission) => submission.id)).toEqual([first.submission.id]);

      const interrupted = await fetch(`${conversationUrl}/turns/turn-ws/interrupt`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
      expect(interrupted.status).toBe(202);
      await manager.emit('turn/completed', { threadId: 'thread-ws', turn: { id: 'turn-ws', status: 'interrupted' } }, 40);
      const resumedEvent = waitForMessage(socket, (message) => message.type === 'conversation.queue.changed');
      const resumed = await fetch(`${conversationUrl}/queue/resume`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
      expect(resumed.status).toBe(202);
      await expect(resumedEvent).resolves.toMatchObject({
        payload: {
          projectId: project.id,
          conversationId: created.conversation.id,
          generationId: expect.stringMatching(/^zeus-local-/u),
          sequence: expect.any(Number),
          queue: { state: { type: 'active', turnId: 'turn-ws-2' }, submissions: [] },
        },
      });
      socket.close();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses a distinct local event generation for every Fastify server instance', async () => {
    const captureLocalGeneration = async (dir: string, key: string) => {
      const manager = new EventCodexManager();
      const server = await createLocalServer({ dbPath: join(dir, 'zeus.db'), apiToken: 'test-token', projectRoot: dir, codexAppServerManager: manager });
      try {
        await server.listen({ host: '127.0.0.1', port: 0 });
        const address = server.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
        const project = (await (await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: key, localPath: dir }) })).json()) as { id: string };
        const task = (await (
          await fetch(`${baseUrl}/api/tasks`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ projectId: project.id, title: key, description: key, allowCodeChanges: false, allowTests: false, allowGitCommit: false }),
          })
        ).json()) as { id: string };
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { headers: { authorization: 'Bearer test-token' } });
        await waitForMessage(socket, (message) => message.type === 'server.connected');
        const transportChanged = waitForMessage(socket, (message) => message.type === 'conversation.transport.changed');
        const threadChanged = waitForMessage(socket, (message) => message.type === 'conversation.thread.changed');
        const turnStarted = waitForMessage(socket, (message) => message.type === 'conversation.turn.started');
        const response = await fetch(`${baseUrl}/api/tasks/${task.id}/conversations`, {
          method: 'POST',
          headers: { ...headers, 'idempotency-key': key },
          body: JSON.stringify({ mode: 'create', content: key }),
        });
        expect(response.status).toBe(202);
        const events = await Promise.all([transportChanged, threadChanged, turnStarted]);
        socket.close();
        return {
          generationId: events[0]!.payload.generationId,
          sequences: events.map((event) => event.payload.sequence),
        };
      } finally {
        await server.close();
      }
    };

    const firstDir = await mkdtemp(join(tmpdir(), 'zeus-native-local-generation-a-'));
    const secondDir = await mkdtemp(join(tmpdir(), 'zeus-native-local-generation-b-'));
    try {
      const first = await captureLocalGeneration(firstDir, 'local-generation-a');
      const second = await captureLocalGeneration(secondDir, 'local-generation-b');
      expect(first.generationId).toMatch(/^zeus-local-/u);
      expect(second.generationId).toMatch(/^zeus-local-/u);
      expect(second.generationId).not.toBe(first.generationId);
      expect(first.sequences).toEqual([1, 2, 3]);
      expect(second.sequences).toEqual([1, 2, 3]);
    } finally {
      await Promise.all([rm(firstDir, { recursive: true, force: true }), rm(secondDir, { recursive: true, force: true })]);
    }
  });

  it('streams typed native conversation events and exposes a reconnect-authoritative snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-native-events-ws-'));
    const manager = new EventCodexManager();
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'test-token',
      projectRoot: dir,
      codexAppServerManager: manager,
    });
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
      const project = (await (await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'Native WS', localPath: dir }) })).json()) as { id: string };
      const task = (await (
        await fetch(`${baseUrl}/api/tasks`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ projectId: project.id, title: 'Native WS', description: 'typed events', allowCodeChanges: false, allowTests: false, allowGitCommit: false }),
        })
      ).json()) as { id: string };
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { headers: { authorization: 'Bearer test-token' } });
      await waitForMessage(socket, (message) => message.type === 'server.connected');

      const transportChanged = waitForMessage(socket, (message) => message.type === 'conversation.transport.changed');
      const threadChanged = waitForMessage(socket, (message) => message.type === 'conversation.thread.changed');
      const turnStarted = waitForMessage(socket, (message) => message.type === 'conversation.turn.started');
      const createResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/conversations`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'ws-create' },
        body: JSON.stringify({ mode: 'create', content: 'start typed stream' }),
      });
      expect(createResponse.status).toBe(202);
      const created = (await createResponse.json()) as { conversation: { id: string } };
      await expect(transportChanged).resolves.toMatchObject({ payload: { projectId: project.id, conversationId: created.conversation.id, generationId: expect.stringMatching(/^zeus-local-/u) } });
      await expect(threadChanged).resolves.toMatchObject({ payload: { projectId: project.id, conversationId: created.conversation.id, threadId: 'thread-ws', generationId: expect.stringMatching(/^zeus-local-/u) } });
      await expect(turnStarted).resolves.toMatchObject({
        type: 'conversation.turn.started',
        payload: {
          projectId: project.id,
          conversationId: created.conversation.id,
          threadId: 'thread-ws',
          turnId: 'turn-ws',
          generationId: expect.stringMatching(/^zeus-local-/u),
          sequence: expect.any(Number),
        },
      });

      const queueChanged = waitForMessage(socket, (message) => message.type === 'conversation.queue.changed');
      const queuedResponse = await fetch(`${baseUrl}/api/projects/${project.id}/conversations/${created.conversation.id}/messages`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'ws-queued' },
        body: JSON.stringify({ content: 'queued from websocket test', delivery: 'queue' }),
      });
      expect(queuedResponse.status).toBe(202);
      await expect(queueChanged).resolves.toMatchObject({
        payload: { projectId: project.id, conversationId: created.conversation.id, generationId: expect.stringMatching(/^zeus-local-/u), queue: { submissions: expect.any(Array) } },
      });

      const itemStarted = waitForMessage(socket, (message) => message.type === 'conversation.item.started');
      await manager.emit('item/started', { threadId: 'thread-ws', turnId: 'turn-ws', item: { id: 'item-ws', type: 'agentMessage', status: 'in_progress', content: [{ type: 'output_text', text: '' }] } }, 9);
      await expect(itemStarted).resolves.toMatchObject({
        payload: {
          projectId: project.id,
          conversationId: created.conversation.id,
          threadId: 'thread-ws',
          turnId: 'turn-ws',
          itemId: 'item-ws',
          itemType: 'agentMessage',
          itemPayload: { id: 'item-ws', type: 'agentMessage', status: 'in_progress', content: [{ type: 'output_text', text: '' }] },
          generationId: 'generation-ws',
          sequence: 9,
        },
      });

      const delta = waitForMessage(socket, (message) => message.type === 'conversation.item.delta');
      await manager.emit('item/agentMessage/delta', { threadId: 'thread-ws', turnId: 'turn-ws', itemId: 'item-ws', delta: 'draft' }, 10);
      await expect(delta).resolves.toMatchObject({
        payload: {
          projectId: project.id,
          conversationId: created.conversation.id,
          threadId: 'thread-ws',
          turnId: 'turn-ws',
          itemId: 'item-ws',
          itemType: 'agentMessage',
          itemPayload: { threadId: 'thread-ws', turnId: 'turn-ws', itemId: 'item-ws', delta: 'draft' },
          generationId: 'generation-ws',
          sequence: 10,
        },
      });

      const completed = waitForMessage(socket, (message) => message.type === 'conversation.item.completed');
      await manager.emit(
        'item/completed',
        { threadId: 'thread-ws', turnId: 'turn-ws', item: { id: 'item-ws', type: 'agentMessage', status: 'completed', text: 'final', phase: 'final_answer', citations: [{ url: 'https://example.test' }] } },
        11,
      );
      await expect(completed).resolves.toMatchObject({
        payload: {
          itemId: 'item-ws',
          itemType: 'agentMessage',
          itemPayload: {
            id: 'item-ws',
            type: 'agentMessage',
            status: 'completed',
            text: 'final',
            phase: 'final_answer',
            citations: [{ url: 'https://example.test' }],
          },
          generationId: 'generation-ws',
          sequence: 11,
        },
      });

      const settingsChanged = waitForMessage(socket, (message) => message.type === 'conversation.settings.changed');
      const tokenUsageChanged = waitForMessage(socket, (message) => message.type === 'conversation.tokenUsage.changed');
      const rateLimitsChanged = waitForMessage(socket, (message) => message.type === 'conversation.rateLimits.changed');
      const mcpStartupChanged = waitForMessage(socket, (message) => message.type === 'conversation.mcpStartup.changed');
      await manager.emit('thread/settings/updated', { threadId: 'thread-ws', model: 'gpt-5.4', effort: 'high' }, 12);
      await manager.emit('thread/tokenUsage/updated', { threadId: 'thread-ws', tokenUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } }, 13);
      await manager.emit('account/rateLimits/updated', { rateLimits: { primary: { remaining: 66 } } }, 14);
      await manager.emit('mcpServer/startupStatus/updated', { statuses: { filesystem: 'ready' } }, 15);
      await expect(settingsChanged).resolves.toMatchObject({ payload: { conversationId: created.conversation.id, generationId: 'generation-ws', sequence: 12 } });
      await expect(tokenUsageChanged).resolves.toMatchObject({ payload: { conversationId: created.conversation.id, generationId: 'generation-ws', sequence: 13 } });
      await expect(rateLimitsChanged).resolves.toMatchObject({ payload: { conversationId: created.conversation.id, generationId: 'generation-ws', sequence: 14 } });
      await expect(mcpStartupChanged).resolves.toMatchObject({ payload: { conversationId: created.conversation.id, generationId: 'generation-ws', sequence: 15 } });

      const requestCreated = waitForMessage(socket, (message) => message.type === 'conversation.request.created');
      await manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-ws', turnId: 'turn-ws', command: '/bin/pwd' }, 16, 'request-ws');
      const createdRequestEvent = await requestCreated;
      expect(createdRequestEvent).toMatchObject({
        payload: { projectId: project.id, conversationId: created.conversation.id, turnId: 'turn-ws', generationId: 'generation-ws', sequence: 16, requestKind: 'command' },
      });
      const requestId = createdRequestEvent.payload.requestId as string;
      const requestResolved = waitForMessage(socket, (message) => message.type === 'conversation.request.resolved');
      const respond = await fetch(`${baseUrl}/api/projects/${project.id}/conversations/${created.conversation.id}/requests/${requestId}/respond`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'command', decision: 'decline' }),
      });
      expect(respond.status).toBe(202);
      await expect(requestResolved).resolves.toMatchObject({
        payload: { projectId: project.id, conversationId: created.conversation.id, requestId, generationId: expect.stringMatching(/^zeus-local-/u), sequence: expect.any(Number) },
      });

      const turnCompleted = waitForMessage(socket, (message) => message.type === 'conversation.turn.completed');
      await manager.emit('turn/completed', { threadId: 'thread-ws', turn: { id: 'turn-ws', status: 'completed' } }, 17);
      await expect(turnCompleted).resolves.toMatchObject({
        payload: { projectId: project.id, conversationId: created.conversation.id, threadId: 'thread-ws', turnId: 'turn-ws', generationId: 'generation-ws', sequence: 17 },
      });

      socket.close();
      const snapshot = (await (await fetch(`${baseUrl}/api/projects/${project.id}/conversations/${created.conversation.id}`, { headers: { authorization: 'Bearer test-token' } })).json()) as Record<string, unknown>;
      expect(snapshot).toMatchObject({
        providerSettings: { model: 'gpt-5.4', effort: 'high' },
        tokenUsage: { totalTokens: 8 },
        rateLimits: { value: { primary: { remaining: 66 } } },
        mcpStartup: { value: { filesystem: 'ready' } },
      });
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

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
          command: 'claude',
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
          command: 'claude',
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
          command: 'claude',
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
