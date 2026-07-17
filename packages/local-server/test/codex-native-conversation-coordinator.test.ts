import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiRuntimeProcessHandle, AiRuntimeSpawn, CodexAppServerEvent, CodexAppServerManager, CodexServerRequestResponse, CodexThreadStartInput, CodexTransportState, CodexTurnStartInput, CodexTurnSteerInput } from '@zeus/ai-runtime';
import {
  ConversationItemRepository,
  ConversationRepository,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  createZeusDatabase,
  ProjectRepository,
  SettingRepository,
  TaskRepository,
} from '@zeus/storage';
import { createCodexNativeConversationCoordinator } from '../src/codexNativeConversationCoordinator.js';
import { createLocalServer, hasCodexFinalizationOwnershipClaim, startZeusLocalServer } from '../src/index.js';

class FakeCodexManager implements CodexAppServerManager {
  readonly threadStarts: CodexThreadStartInput[] = [];
  readonly turnStarts: CodexTurnStartInput[] = [];
  readonly steers: CodexTurnSteerInput[] = [];
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly responses: CodexServerRequestResponse[] = [];
  readonly resumes: string[] = [];
  readonly reads: string[] = [];
  readonly threadSnapshots = new Map<string, { id: string; turns: unknown[] }>();
  readonly resumeFailures = new Set<string>();
  readonly readFailures = new Set<string>();
  startTurnFailure: Error | null = null;
  beforeStartTurn: (() => Promise<void>) | null = null;
  beforeSteer: (() => Promise<void>) | null = null;
  replayEvents = false;
  private readonly listeners = new Set<(event: CodexAppServerEvent) => unknown>();
  private readonly replayBuffer: CodexAppServerEvent[] = [];
  private threadSequence = 0;
  private turnSequence = 0;
  state: CodexTransportState = {
    type: 'ready',
    generationId: 'generation-1',
    capabilities: { generationId: 'generation-1', initializedAt: '2026-07-13T00:00:00.000Z', models: [], supportedModels: ['gpt-5.4'] },
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  async ensureReady() {
    if (this.state.type !== 'ready') throw new Error('transport unavailable');
    return { ...this.state.capabilities, generationId: this.state.generationId };
  }
  async startThread(input: CodexThreadStartInput) {
    this.threadStarts.push(input);
    return { id: `thread-${++this.threadSequence}`, turns: [] };
  }
  async resumeThread(input: { threadId: string }) {
    this.resumes.push(input.threadId);
    if (this.resumeFailures.has(input.threadId)) throw new Error(`resume failed: ${input.threadId}`);
    return this.threadSnapshots.get(input.threadId) ?? { id: input.threadId, turns: [] };
  }
  async readThread(input: { threadId: string }) {
    this.reads.push(input.threadId);
    if (this.readFailures.has(input.threadId)) throw new Error(`read failed: ${input.threadId}`);
    return this.threadSnapshots.get(input.threadId) ?? { id: input.threadId, turns: [] };
  }
  async startTurn(input: CodexTurnStartInput) {
    if (this.startTurnFailure) throw this.startTurnFailure;
    if (this.beforeStartTurn) await this.beforeStartTurn();
    this.turnStarts.push(input);
    return { id: `turn-${++this.turnSequence}`, threadId: input.threadId, items: [] };
  }
  async steerTurn(input: CodexTurnSteerInput) {
    this.steers.push(input);
    if (this.beforeSteer) await this.beforeSteer();
    return { turnId: input.turnId };
  }
  async interruptTurn(input: { threadId: string; turnId: string }) {
    this.interrupts.push(input);
  }
  async respondToServerRequest(input: CodexServerRequestResponse) {
    this.responses.push(input);
  }
  subscribe(listener: (event: CodexAppServerEvent) => void) {
    this.listeners.add(listener);
    if (this.replayEvents) for (const event of this.replayBuffer) listener(event);
    return () => this.listeners.delete(listener);
  }
  getState() {
    return this.state;
  }
  async prepareForShutdown() {}
  async close() {}
  async emit(method: string, params: unknown, requestId?: string | number, sequence = 1, generationId?: string) {
    const event: CodexAppServerEvent = {
      generationId: generationId ?? (this.state.type === 'ready' ? this.state.generationId : 'generation-1'),
      sequence,
      method,
      params,
      receivedAt: `2026-07-13T00:00:${String(sequence).padStart(2, '0')}.000Z`,
      ...(requestId === undefined ? {} : { requestId }),
    };
    if (this.replayEvents) this.replayBuffer.push(event);
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

function createControlledRuntimeSpawn(): { spawn: AiRuntimeSpawn; exit: (code?: number) => void } {
  let exitCallbacks: Array<(code: number) => void> = [];
  const spawn: AiRuntimeSpawn = () => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 13_713,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        if (event === 'exit') exitCallbacks = entries as Array<(code: number) => void>;
        return handle;
      },
      kill() {
        callbacks.get('exit')?.forEach((callback) => callback(143));
      },
    };
    return handle;
  };
  return { spawn, exit: (code = 0) => exitCallbacks.forEach((callback) => callback(code)) };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFixture(input: { concurrency?: { project: number; global: number; maxPerProject: number; maxGlobal: number }; broadcasts?: Array<{ type: string; payload: Record<string, unknown> }> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-native-coordinator-'));
  cleanup.push(dir);
  const db = await createZeusDatabase(join(dir, 'zeus.db'));
  const projects = new ProjectRepository(db);
  const projectPath = join(dir, 'project');
  await mkdir(projectPath);
  const project = projects.create({ name: 'Zeus', localPath: projectPath });
  const tasks = new TaskRepository(db);
  const task = tasks.create({ projectId: project.id, title: 'Native 任务', description: '保持 running', createdFrom: 'test', sourceContext: {}, allowCodeChanges: true, allowTests: true, allowGitCommit: false });
  const manager = new FakeCodexManager();
  const conversations = new ConversationRepository(db);
  const turns = new ConversationTurnRepository(db);
  const items = new ConversationItemRepository(db);
  const submissions = new ConversationSubmissionRepository(db);
  const requests = new ConversationServerRequestRepository(db);
  const settings = new SettingRepository(db);
  const broadcasts = input.broadcasts ?? [];
  const coordinator = createCodexNativeConversationCoordinator({
    manager,
    commandPath: '/opt/homebrew/bin/codex',
    db,
    conversations,
    turns,
    items,
    submissions,
    requests,
    settings,
    getConcurrency: () => input.concurrency ?? { project: 0, global: 0, maxPerProject: 1, maxGlobal: 2 },
    broadcast: (type, payload) => broadcasts.push({ type, payload }),
    now: (() => {
      let tick = 0;
      return () => `2026-07-13T00:00:${String(++tick).padStart(2, '0')}.000Z`;
    })(),
  });
  return { dir, dbPath: join(dir, 'zeus.db'), db, project, task, tasks, manager, conversations, turns, items, submissions, requests, settings, broadcasts, coordinator };
}

function startInput(fixture: Awaited<ReturnType<typeof createFixture>>, overrides: Record<string, unknown> = {}) {
  return {
    projectId: fixture.project.id,
    projectLocalPath: fixture.project.localPath,
    taskId: fixture.task.id,
    taskTitle: fixture.task.title,
    prompt: '第一轮真实输入',
    model: 'gpt-5.4',
    effort: 'high',
    allowCodeChanges: fixture.task.allowCodeChanges,
    allowTests: fixture.task.allowTests,
    allowGitCommit: fixture.task.allowGitCommit,
    idempotencyKey: 'start-1',
    clientUserMessageId: 'client-1',
    ...overrides,
  };
}

function projectStartInput(fixture: Awaited<ReturnType<typeof createFixture>>, overrides: Record<string, unknown> = {}) {
  return {
    projectId: fixture.project.id,
    projectLocalPath: fixture.project.localPath,
    prompt: '项目级第一轮真实输入',
    model: 'gpt-5.4',
    effort: 'high',
    permissionMode: 'auto' as const,
    idempotencyKey: 'project-start-1',
    clientUserMessageId: 'project-client-1',
    ...overrides,
  };
}

function canonicalRuiPayload(questions: unknown[], itemId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId,
    questions,
    autoResolutionMs: null,
    ...overrides,
  };
}

describe('CodexNativeConversationCoordinator', () => {
  it('creates a persistent taskless project thread and continues it across multiple turns without mutating tasks', async () => {
    const fixture = await createFixture();
    const taskCountBefore = fixture.db.countRows('tasks');
    const first = await fixture.coordinator.startProjectConversation(
      projectStartInput(fixture, {
        prompt: '\n   项目   标题 🧪   \n原始摘要正文',
      }),
    );
    const conversation = fixture.conversations.getById(first.conversationId);
    expect(conversation).toMatchObject({ projectId: fixture.project.id, taskId: null, title: '项目 标题 🧪', summary: '\n   项目   标题 🧪   \n原始摘要正文', permissionMode: 'auto' });
    expect(fixture.manager.threadStarts[0]).toMatchObject({ sandbox: { type: 'workspaceWrite', writableRoots: [fixture.project.localPath], networkAccess: false } });

    await fixture.manager.emit('turn/completed', { threadId: first.providerThreadId, turn: { id: first.providerTurnId, status: 'completed' } }, undefined, 1);
    const second = await fixture.coordinator.submitMessage({ conversationId: first.conversationId, content: '项目级第二轮', idempotencyKey: 'project-message-2', clientUserMessageId: 'project-client-2' });

    expect(second.providerThreadId).toBe(first.providerThreadId);
    expect(second.providerTurnId).toBe('turn-2');
    expect(fixture.manager.threadStarts).toHaveLength(1);
    expect(fixture.db.countRows('tasks')).toBe(taskCountBefore);
  });

  it('queues concurrent project conversations with taskId null under the existing project capacity rules', async () => {
    const fixture = await createFixture({ concurrency: { project: 0, global: 0, maxPerProject: 1, maxGlobal: 2 } });
    const first = await fixture.coordinator.startProjectConversation(projectStartInput(fixture));
    const second = await fixture.coordinator.startProjectConversation(
      projectStartInput(fixture, {
        prompt: '第二条项目会话',
        idempotencyKey: 'project-start-2',
        clientUserMessageId: 'project-client-2',
      }),
    );

    expect(first.status).toBe('active');
    expect(second.status).toBe('queued');
    expect(fixture.conversations.getById(second.conversationId)?.taskId).toBeNull();
    expect(fixture.manager.threadStarts).toHaveLength(1);
  });

  it('derives a project title from the first non-empty line and truncates by 48 Unicode characters', async () => {
    const fixture = await createFixture();
    const longTitle = `  ${'🧪'.repeat(50)}   后缀  `;
    const started = await fixture.coordinator.startProjectConversation(projectStartInput(fixture, { prompt: `\n${longTitle}\n第二行` }));
    const title = fixture.conversations.getById(started.conversationId)?.title ?? '';

    expect([...title]).toHaveLength(48);
    expect(title).toBe('🧪'.repeat(48));
  });

  it('creates one native thread, reuses it for three provider turns, and never auto-completes the task', async () => {
    const fixture = await createFixture();
    const first = await fixture.coordinator.startTaskConversation(startInput(fixture));
    expect(first).toMatchObject({ status: 'active', providerThreadId: 'thread-1', providerTurnId: 'turn-1' });
    expect(fixture.manager.threadStarts[0]).toMatchObject({ sandbox: { type: 'workspaceWrite', writableRoots: [fixture.project.localPath], networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    expect(fixture.manager.turnStarts[0]).toMatchObject({ sandboxPolicy: { type: 'workspaceWrite', writableRoots: [fixture.project.localPath], networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 1);
    const second = await fixture.coordinator.submitMessage({ conversationId: first.conversationId, content: '第二轮', idempotencyKey: 'message-2', clientUserMessageId: 'client-2' });
    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } }, undefined, 2);
    const third = await fixture.coordinator.submitMessage({ conversationId: first.conversationId, content: '第三轮', idempotencyKey: 'message-3', clientUserMessageId: 'client-3' });

    expect(fixture.manager.threadStarts).toHaveLength(1);
    expect([first.providerTurnId, second.providerTurnId, third.providerTurnId]).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(fixture.manager.turnStarts.map((turn) => turn.threadId)).toEqual(['thread-1', 'thread-1', 'thread-1']);
    expect(fixture.tasks.getById(fixture.task.id)?.status).toBe('ready');
  });

  it('maps full-access to the Codex App danger-full-access profile for both thread and turn', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture, { permissionMode: 'full-access' }));

    expect(fixture.conversations.getById(started.conversationId)).toMatchObject({ permissionMode: 'full-access' });
    expect(fixture.manager.threadStarts[0]).toMatchObject({ sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' });
    expect(fixture.manager.turnStarts[0]).toMatchObject({ sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' });
  });

  it.each([
    { allowTests: true, allowGitCommit: true },
    { allowTests: false, allowGitCommit: true },
    { allowTests: true, allowGitCommit: false },
    { allowTests: false, allowGitCommit: false },
  ])('keeps mutable permission state out while stable task switches are allowTests=$allowTests and allowGitCommit=$allowGitCommit', async ({ allowTests, allowGitCommit }) => {
    const instructionsByMode = await Promise.all(
      (['read-only', 'auto', 'full-access'] as const).map(async (permissionMode) => {
        const fixture = await createFixture();
        await fixture.coordinator.startTaskConversation(startInput(fixture, { allowCodeChanges: permissionMode !== 'read-only', allowTests, allowGitCommit, permissionMode }));
        return fixture.manager.threadStarts[0]?.developerInstructions ?? '';
      }),
    );

    expect(new Set(instructionsByMode).size).toBe(1);
    for (const instructions of instructionsByMode) {
      expect(instructions).not.toMatch(/当前为(?:只读|自动|完全访问)模式/);
      expect(instructions).not.toContain('仅允许在项目根目录内工作');
      expect(instructions).not.toContain('允许运行项目验证');
      expect(instructions.includes('不得运行会修改项目状态的测试。')).toBe(!allowTests);
      expect(instructions.includes('不得执行 git commit')).toBe(!allowGitCommit);
    }
  });

  it('persists failed provider turns, rejects result waiters, and never drains that conversation queue', async () => {
    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const fixture = await createFixture({ broadcasts });
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const queued = await fixture.coordinator.submitMessage({
      conversationId: started.conversationId,
      content: 'must remain paused after provider failure',
      idempotencyKey: 'queued-after-failed-turn',
      clientUserMessageId: 'queued-after-failed-turn-client',
    });
    expect(queued.status).toBe('queued');
    const waiter = fixture.coordinator.waitForTurnResult({
      conversationId: started.conversationId,
      providerTurnId: started.providerTurnId!,
      timeoutMs: 10_000,
    });
    const waiterRejection = expect(waiter).rejects.toMatchObject({ code: 'ZEUS_CODEX_TURN_FAILED' });

    await fixture.manager.emit(
      'turn/completed',
      {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: { message: 'model unavailable', codexErrorInfo: null, additionalDetails: null },
        },
      },
      undefined,
      201,
    );

    await waiterRejection;
    await expect(fixture.coordinator.waitForTurnResult({ conversationId: started.conversationId, providerTurnId: started.providerTurnId!, timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'ZEUS_CODEX_TURN_FAILED' });
    expect(fixture.turns.listByConversation(started.conversationId)[0]).toMatchObject({ status: 'failed' });
    expect(fixture.turns.listByConversation(started.conversationId)[0]?.errorJson).toContain('model unavailable');
    expect(fixture.submissions.getById(started.submissionId)).toMatchObject({ status: 'failed' });
    expect(fixture.submissions.getById(queued.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('failed');
    expect(fixture.manager.turnStarts).toHaveLength(1);
    expect(broadcasts).toContainEqual(expect.objectContaining({ type: 'conversation.turn.completed', payload: expect.objectContaining({ status: 'failed' }) }));
  });

  it('fails closed when a turn/completed event omits its terminal status', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const queued = await fixture.coordinator.submitMessage({
      conversationId: started.conversationId,
      content: 'must not drain after malformed terminal event',
      idempotencyKey: 'queued-after-malformed-terminal',
      clientUserMessageId: 'queued-after-malformed-terminal-client',
    });

    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } }, undefined, 202);

    expect(fixture.turns.listByConversation(started.conversationId)[0]).toMatchObject({ status: 'failed' });
    expect(fixture.submissions.getById(started.submissionId)).toMatchObject({ status: 'failed' });
    expect(fixture.submissions.getById(queued.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('failed');
    expect(fixture.manager.turnStarts).toHaveLength(1);
  });

  it('uses provider userMessage items as the durable transcript authority and deduplicates replayed items', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    expect(fixture.conversations.getById(started.conversationId)?.messages).toEqual([]);

    await fixture.manager.emit(
      'item/started',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'provider-user-item-1', type: 'userMessage', clientId: 'client-1', content: [{ type: 'text', text: 'provider canonical draft' }] },
      },
      undefined,
      202,
    );
    expect(fixture.conversations.getById(started.conversationId)?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'provider canonical draft',
        providerItemId: 'provider-user-item-1',
        clientMessageId: 'client-1',
        metadataJson: expect.stringContaining('clientUserMessageId'),
      }),
    ]);

    const completedPayload = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'provider-user-item-1', type: 'userMessage', clientId: 'client-1', content: [{ type: 'text', text: 'provider canonical final' }] },
    };
    await fixture.manager.emit('item/completed', completedPayload, undefined, 203);
    await fixture.manager.emit('item/completed', completedPayload, undefined, 204);

    expect(fixture.conversations.getById(started.conversationId)?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'provider canonical final',
        providerThreadId: 'thread-1',
        providerTurnId: 'turn-1',
        providerItemId: 'provider-user-item-1',
        clientMessageId: 'client-1',
      }),
    ]);
  });

  it('preserves the durable client association and attachments when provider userMessage replays with clientId null', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 205);
    const attachmentPath = join(fixture.project.localPath, 'provider-client-null.txt');
    await writeFile(attachmentPath, 'provider-client-null');
    const clientMessageId = 'client-provider-null';
    const followUp = await fixture.coordinator.submitMessage({
      conversationId: started.conversationId,
      content: 'provider clientId null',
      attachments: [{ name: 'provider-client-null.txt', mime: 'text/plain', size: 20, localPath: attachmentPath }],
      idempotencyKey: 'provider-client-null',
      clientUserMessageId: clientMessageId,
    });

    await fixture.manager.emit(
      'item/started',
      {
        threadId: 'thread-1',
        turnId: followUp.providerTurnId,
        item: { id: 'provider-user-item-null', type: 'userMessage', clientId: null, content: [{ type: 'text', text: 'provider null draft' }] },
      },
      undefined,
      206,
    );
    await fixture.manager.emit(
      'item/completed',
      {
        threadId: 'thread-1',
        turnId: followUp.providerTurnId,
        item: { id: 'provider-user-item-null', type: 'userMessage', clientId: null, content: [{ type: 'text', text: 'provider null final' }] },
      },
      undefined,
      207,
    );

    const messages = fixture.conversations.getById(started.conversationId)?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      content: 'provider null final',
      providerItemId: 'provider-user-item-null',
      clientMessageId,
    });
    expect(JSON.parse(messages[0]!.metadataJson)).toEqual({
      clientUserMessageId: clientMessageId,
      attachments: [{ name: 'provider-client-null.txt', mime: 'text/plain', size: 20, localPath: attachmentPath }],
    });
    expect(
      fixture.broadcasts
        .filter((event) => ['conversation.item.started', 'conversation.item.updated'].includes(event.type) && event.payload.providerItemId === 'provider-user-item-null')
        .map((event) => (event.payload.itemPayload as Record<string, unknown>).clientId),
    ).toEqual([clientMessageId, clientMessageId]);
  });

  it('persists the dispatch intent before invoking startTurn on an existing provider thread', async () => {
    const fixture = await createFixture();
    const first = await fixture.coordinator.startTaskConversation(startInput(fixture));
    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 1);
    let durableStatus: string | undefined;
    fixture.manager.beforeStartTurn = async () => {
      const disk = await createZeusDatabase(fixture.dbPath);
      durableStatus = disk.get<{ status: string }>(`SELECT status FROM conversation_submissions WHERE conversation_id = ? AND idempotency_key = ?`, [first.conversationId, 'dispatch-intent'])?.status;
    };

    await fixture.coordinator.submitMessage({
      conversationId: first.conversationId,
      content: 'persist before RPC',
      idempotencyKey: 'dispatch-intent',
      clientUserMessageId: 'dispatch-intent-client',
    });

    expect(durableStatus).toBe('dispatching');
  });

  it('routes task run through native app-server and persists task permission fields from the API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-native-local-server-'));
    cleanup.push(dir);
    const manager = new FakeCodexManager();
    const server = await createLocalServer({ dbPath: join(dir, 'zeus.db'), apiToken: 'token', projectRoot: dir, codexAppServerManager: manager });
    const project = (await server.inject({ method: 'POST', url: '/api/projects', headers: { authorization: 'Bearer token' }, payload: { name: 'Native', localPath: dir } })).json();
    const taskResponse = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer token' },
      payload: { projectId: project.id, title: 'Native API', description: '不走 codex exec', allowCodeChanges: true, allowTests: true, allowGitCommit: false },
    });
    const task = taskResponse.json();
    expect(task).toMatchObject({ allowCodeChanges: true, allowTests: true, allowGitCommit: false });

    const run = await server.inject({ method: 'POST', url: `/api/tasks/${task.id}/run`, headers: { authorization: 'Bearer token' } });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({
      operation: { status: 'accepted' },
      conversation: { taskId: task.id, provider: { threadId: 'thread-1' } },
      submission: { status: 'active', providerTurnId: 'turn-1' },
    });
    const conversationId = run.json().conversation.id as string;
    expect(manager.threadStarts).toHaveLength(1);
    expect(manager.threadStarts[0]?.sandbox).toEqual({ type: 'workspaceWrite', writableRoots: [dir], networkAccess: false });
    expect(manager.turnStarts[0]?.input).toEqual([{ type: 'text', text: expect.stringContaining('Native API') }]);
    await manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 90);
    const permissionUpdate = await server.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}/conversations/${conversationId}/permission-mode`,
      headers: { authorization: 'Bearer token' },
      payload: { permissionMode: 'full-access' },
    });
    expect(permissionUpdate.statusCode).toBe(200);
    expect(permissionUpdate.json()).toMatchObject({ id: conversationId, permissionMode: 'full-access' });
    const nextMessage = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer token', 'idempotency-key': 'full-access-next-turn' },
      payload: { content: 'continue with full access', clientUserMessageId: 'full-access-client', delivery: 'queue', attachments: [] },
    });
    expect(nextMessage.statusCode).toBe(202);
    expect(manager.turnStarts[1]).toMatchObject({ sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' });
    const taskAfterTurn = await server.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: { authorization: 'Bearer token' } });
    expect(taskAfterTurn.json()).toMatchObject({ id: task.id, status: 'running' });
    await server.close();
  });

  it('drains the native durable queue when a real legacy runtime session releases its project slot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-native-legacy-slot-'));
    cleanup.push(dir);
    const manager = new FakeCodexManager();
    const runtime = createControlledRuntimeSpawn();
    const server = await createLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: dir,
      codexAppServerManager: manager,
      aiRuntimeSpawn: runtime.spawn,
    });
    const project = (await server.inject({ method: 'POST', url: '/api/projects', headers: { authorization: 'Bearer token' }, payload: { name: 'Legacy slot', localPath: dir } })).json();
    const legacy = await server.inject({
      method: 'POST',
      url: '/api/runtime/sessions',
      headers: { authorization: 'Bearer token' },
      payload: { projectId: project.id, command: 'claude', cwd: dir },
    });
    expect(legacy.statusCode).toBe(201);
    const task = (
      await server.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: 'Bearer token' },
        payload: { projectId: project.id, title: '等待 legacy 释放', description: 'slot release', allowCodeChanges: true, allowTests: true, allowGitCommit: false },
      })
    ).json();

    const run = await server.inject({ method: 'POST', url: `/api/tasks/${task.id}/run`, headers: { authorization: 'Bearer token' } });
    expect(run.statusCode).toBe(202);
    expect(run.json().submission.status).toBe('queued');
    expect(manager.turnStarts).toHaveLength(0);

    runtime.exit(0);
    await vi.waitFor(() => expect(manager.turnStarts).toHaveLength(1));
    expect(manager.turnStarts[0]?.input[0]?.text).toEqual(expect.stringContaining('等待 legacy 释放'));
    await server.close();
  });

  it('queues by default, steers send-now without taking a slot, pauses after interrupt, and resumes explicitly', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const queued = await fixture.coordinator.submitMessage({ conversationId: started.conversationId, content: '排队消息', idempotencyKey: 'queued-1', clientUserMessageId: 'queued-client' });
    expect(queued.status).toBe('queued');
    expect(fixture.manager.turnStarts).toHaveLength(1);
    const steered = await fixture.coordinator.sendQueuedNow({ conversationId: started.conversationId, submissionId: queued.submissionId });
    expect(steered.status).toBe('steered');
    expect(fixture.manager.steers).toEqual([{ threadId: 'thread-1', turnId: 'turn-1', clientUserMessageId: 'queued-client', input: [{ type: 'text', text: '排队消息' }] }]);
    expect(fixture.manager.turnStarts).toHaveLength(1);

    const remaining = await fixture.coordinator.submitMessage({ conversationId: started.conversationId, content: '保留到恢复', idempotencyKey: 'queued-2', clientUserMessageId: 'queued-client-2' });
    await fixture.coordinator.interruptTurn({ conversationId: started.conversationId, providerTurnId: 'turn-1' });
    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } }, undefined, 3);
    expect(fixture.submissions.getById(remaining.submissionId)?.status).toBe('paused');
    expect(fixture.manager.turnStarts).toHaveLength(1);
    await fixture.coordinator.resumeInterruptedQueue({ conversationId: started.conversationId });
    expect(fixture.manager.turnStarts).toHaveLength(2);
  });

  it('keeps a deferred send-now out of queue draining when the active turn completes before steer returns', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const queued = await fixture.coordinator.submitMessage({
      conversationId: started.conversationId,
      content: 'steer during completion race',
      idempotencyKey: 'send-now-race',
      clientUserMessageId: 'send-now-race-client',
    });
    let releaseSteer!: () => void;
    let signalSteerStarted!: () => void;
    const steerStarted = new Promise<void>((resolve) => {
      signalSteerStarted = resolve;
    });
    const steerGate = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    fixture.manager.beforeSteer = async () => {
      signalSteerStarted();
      await steerGate;
    };

    const sending = fixture.coordinator.sendQueuedNow({ conversationId: started.conversationId, submissionId: queued.submissionId });
    await steerStarted;
    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 103);
    releaseSteer();
    const result = await sending;

    expect(result).toMatchObject({ status: 'steered', providerTurnId: 'turn-1' });
    expect(fixture.manager.steers).toHaveLength(1);
    expect(fixture.manager.turnStarts).toHaveLength(1);
    expect(fixture.submissions.getById(queued.submissionId)).toMatchObject({ status: 'resolved', providerTurnId: 'turn-1' });
  });

  it('rejects send-now while idle or interrupted instead of dispatching a new turn', async () => {
    const concurrency = { project: 0, global: 0, maxPerProject: 1, maxGlobal: 1 };
    const idleFixture = await createFixture({ concurrency });
    const idleStarted = await idleFixture.coordinator.startTaskConversation(startInput(idleFixture));
    await idleFixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 101);
    concurrency.project = 1;
    concurrency.global = 1;
    const idleQueued = await idleFixture.coordinator.submitMessage({
      conversationId: idleStarted.conversationId,
      content: 'must remain queued while idle',
      idempotencyKey: 'idle-send-now',
      clientUserMessageId: 'idle-send-now-client',
    });
    concurrency.project = 0;
    concurrency.global = 0;
    await expect(idleFixture.coordinator.sendQueuedNow({ conversationId: idleStarted.conversationId, submissionId: idleQueued.submissionId })).rejects.toMatchObject({
      code: 'ZEUS_NATIVE_TURN_NOT_ACTIVE',
    });
    expect(idleFixture.manager.turnStarts).toHaveLength(1);
    expect(idleFixture.manager.steers).toEqual([]);
    expect(idleFixture.submissions.getById(idleQueued.submissionId)?.status).toBe('queued');

    const pausedFixture = await createFixture();
    const pausedStarted = await pausedFixture.coordinator.startTaskConversation(startInput(pausedFixture));
    const pausedQueued = await pausedFixture.coordinator.submitMessage({
      conversationId: pausedStarted.conversationId,
      content: 'must wait for explicit resume',
      idempotencyKey: 'paused-send-now',
      clientUserMessageId: 'paused-send-now-client',
    });
    await pausedFixture.coordinator.interruptTurn({ conversationId: pausedStarted.conversationId, providerTurnId: 'turn-1' });
    await pausedFixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } }, undefined, 102);
    await expect(pausedFixture.coordinator.sendQueuedNow({ conversationId: pausedStarted.conversationId, submissionId: pausedQueued.submissionId })).rejects.toMatchObject({
      code: 'ZEUS_NATIVE_TURN_NOT_ACTIVE',
    });
    expect(pausedFixture.manager.turnStarts).toHaveLength(1);
    expect(pausedFixture.manager.steers).toEqual([]);
    expect(pausedFixture.submissions.getById(pausedQueued.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'interrupted' });
  });

  it('does not create a provider thread while active native plus legacy concurrency is full', async () => {
    const fixture = await createFixture({ concurrency: { project: 1, global: 2, maxPerProject: 1, maxGlobal: 2 } });
    const accepted = await fixture.coordinator.startTaskConversation(startInput(fixture));
    expect(accepted.status).toBe('queued');
    expect(fixture.manager.threadStarts).toHaveLength(0);
    expect(fixture.manager.turnStarts).toHaveLength(0);
    expect(fixture.submissions.getById(accepted.submissionId)?.status).toBe('queued');
  });

  it('bypasses legacy Runtime concurrency only for an explicit task model push and forwards composer work mode', async () => {
    const fixture = await createFixture({ concurrency: { project: 1, global: 2, maxPerProject: 1, maxGlobal: 2 } });
    const accepted = await fixture.coordinator.startTaskConversation(
      startInput(fixture, {
        bypassConcurrency: true,
        workMode: 'plan',
        permissionMode: 'read-only',
        applyLegacyTaskGuards: false,
      }),
    );
    expect(accepted.status).toBe('active');
    expect(fixture.manager.threadStarts).toHaveLength(1);
    expect(fixture.manager.threadStarts[0]).toMatchObject({ sandbox: { type: 'readOnly' }, developerInstructions: '' });
    expect(fixture.manager.turnStarts[0]).toMatchObject({
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.4', reasoning_effort: 'high', developer_instructions: null } },
    });
  });

  it('allows failed queue entries to be edited, reordered, and deleted without changing other statuses', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const first = await fixture.coordinator.submitMessage({ conversationId: started.conversationId, content: 'failed first', idempotencyKey: 'failed-first', clientUserMessageId: 'failed-first-client' });
    const second = await fixture.coordinator.submitMessage({ conversationId: started.conversationId, content: 'failed second', idempotencyKey: 'failed-second', clientUserMessageId: 'failed-second-client' });
    const third = await fixture.coordinator.submitMessage({ conversationId: started.conversationId, content: 'failed third', idempotencyKey: 'failed-third', clientUserMessageId: 'failed-third-client' });
    for (const submission of [first, second, third]) fixture.submissions.updateStatus(submission.submissionId, 'failed', { error: { code: 'PROVIDER_FAILED' } });
    await fixture.db.save();

    const edited = await fixture.coordinator.editQueuedSubmission({ conversationId: started.conversationId, submissionId: first.submissionId, content: 'failed first edited' });
    expect(edited.submissions.find((submission) => submission.id === first.submissionId)).toMatchObject({ content: 'failed first edited', status: 'failed' });

    const reordered = await fixture.coordinator.reorderQueue({
      conversationId: started.conversationId,
      orderedSubmissionIds: [third.submissionId, first.submissionId, second.submissionId],
    });
    expect(reordered.submissions.map((submission) => submission.id)).toEqual([third.submissionId, first.submissionId, second.submissionId]);

    const deleted = await fixture.coordinator.deleteQueuedSubmission({ conversationId: started.conversationId, submissionId: second.submissionId });
    expect(deleted.submissions.map((submission) => submission.id)).toEqual([third.submissionId, first.submissionId]);
    expect(fixture.submissions.getById(second.submissionId)?.status).toBe('deleted');
    expect(fixture.submissions.getById(started.submissionId)?.status).toBe('active');
  });

  it('persists replay-safe items and typed snapshots before broadcasting them', async () => {
    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const fixture = await createFixture({ broadcasts });
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const assertPersisted = vi.fn((type: string, payload: Record<string, unknown>) => {
      if (type === 'conversation.item.updated') expect(fixture.items.listByConversation(started.conversationId)[0]?.textContent).toBe(payload.textContent);
      broadcasts.push({ type, payload });
    });
    await fixture.coordinator.close({ mode: 'handoff' });
    const coordinator = createCodexNativeConversationCoordinator({
      manager: fixture.manager,
      commandPath: '/opt/homebrew/bin/codex',
      db: fixture.db,
      conversations: fixture.conversations,
      turns: fixture.turns,
      items: fixture.items,
      submissions: fixture.submissions,
      requests: fixture.requests,
      settings: fixture.settings,
      getConcurrency: () => ({ project: 1, global: 1, maxPerProject: 2, maxGlobal: 2 }),
      broadcast: assertPersisted,
    });
    await fixture.manager.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '草稿' }, undefined, 4);
    await fixture.manager.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'item-1', type: 'agentMessage', status: 'completed', text: '最终答案', phase: 'final_answer' } }, undefined, 5);
    await fixture.manager.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'item-1', type: 'agentMessage', status: 'completed', text: '重放不覆盖', phase: 'final_answer' } }, undefined, 5);
    await fixture.manager.emit('thread/settings/updated', { threadId: 'thread-1', model: 'gpt-5.4', effort: 'high' }, undefined, 6);
    await fixture.manager.emit('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }, undefined, 7);
    await fixture.manager.emit('account/rateLimits/updated', { rateLimits: { primary: { remaining: 42 } } }, undefined, 8);
    await fixture.manager.emit('mcpServer/startupStatus/updated', { statuses: { filesystem: 'ready' } }, undefined, 9);

    expect(fixture.items.listByConversation(started.conversationId)[0]?.textContent).toBe('最终答案');
    expect(fixture.conversations.getProviderSettingsSnapshot(started.conversationId)).toMatchObject({ model: 'gpt-5.4', effort: 'high' });
    expect(fixture.conversations.getProviderTokenUsageSnapshot(started.conversationId)).toMatchObject({ totalTokens: 14 });
    expect(fixture.settings.getCodexRateLimitsSnapshot()?.value.primary?.remaining).toBe(42);
    expect(fixture.settings.getCodexMcpStartupStatusSnapshot()?.value.filesystem).toBe('ready');
    expect(assertPersisted).toHaveBeenCalledWith('conversation.provider.settings.updated', expect.any(Object));
    expect(assertPersisted).toHaveBeenCalledWith('conversation.provider.token_usage.updated', expect.any(Object));
    expect(assertPersisted).toHaveBeenCalledWith('codex.rate_limits.updated', expect.any(Object));
    expect(assertPersisted).toHaveBeenCalledWith('codex.mcp_startup_status.updated', expect.any(Object));
    await coordinator.close({ mode: 'final' });
  });

  it('accepts current Codex v2 nested thread settings and cumulative token usage notifications', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));

    await fixture.manager.emit(
      'thread/settings/updated',
      {
        threadId: 'thread-1',
        threadSettings: {
          model: 'gpt-5.4',
          effort: 'high',
        },
      },
      undefined,
      80,
    );
    await fixture.manager.emit(
      'thread/tokenUsage/updated',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: { inputTokens: 21, cachedInputTokens: 5, outputTokens: 8, reasoningOutputTokens: 3, totalTokens: 29 },
          last: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 10 },
          modelContextWindow: 200_000,
        },
      },
      undefined,
      81,
    );

    expect(fixture.conversations.getProviderSettingsSnapshot(started.conversationId)).toMatchObject({ sequence: 80, model: 'gpt-5.4', effort: 'high' });
    expect(fixture.conversations.getProviderTokenUsageSnapshot(started.conversationId)).toMatchObject({ sequence: 81, inputTokens: 21, outputTokens: 8, totalTokens: 29 });
    expect(fixture.broadcasts.filter((event) => event.type === 'conversation.native.error')).toEqual([]);
  });

  it('merges current single-server MCP startup events while preserving legacy status maps', async () => {
    const fixture = await createFixture();
    await fixture.coordinator.startTaskConversation(startInput(fixture));

    await fixture.manager.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'node_repl', status: 'starting', error: null, failureReason: null }, undefined, 90);
    await fixture.manager.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'codex_apps', status: 'starting', error: null, failureReason: null }, undefined, 91);
    await fixture.manager.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'node_repl', status: 'ready', error: null, failureReason: null }, undefined, 92);
    await fixture.manager.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'codex_apps', status: 'failed', error: null, failureReason: 'authentication unavailable' }, undefined, 93);

    expect(fixture.settings.getCodexMcpStartupStatusSnapshot()).toMatchObject({
      generationId: 'generation-1',
      sequence: 93,
      value: {
        node_repl: { status: 'ready', error: null },
        codex_apps: { status: 'failed', error: 'authentication unavailable' },
      },
    });
    expect(fixture.settings.getCodexMcpStartupStatusSnapshot()?.value).not.toHaveProperty('threadId');
    expect(fixture.settings.getCodexMcpStartupStatusSnapshot()?.value).not.toHaveProperty('name');
    expect(fixture.settings.getCodexMcpStartupStatusSnapshot()?.value).not.toHaveProperty('error');
    expect(fixture.broadcasts.filter((event) => event.type === 'codex.mcp_startup_status.updated').at(-1)?.payload).toMatchObject({
      sequence: 93,
      value: {
        node_repl: { status: 'ready', error: null },
        codex_apps: { status: 'failed', error: 'authentication unavailable' },
      },
    });

    await fixture.manager.emit('mcpServer/startupStatus/updated', { statuses: { filesystem: 'ready' } }, undefined, 94);
    expect(fixture.settings.getCodexMcpStartupStatusSnapshot()).toMatchObject({ sequence: 94, value: { filesystem: 'ready' } });

    await expect(fixture.manager.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'unsafe', status: 'failed', error: { token: 'must-not-persist' }, failureReason: null }, undefined, 95)).resolves.toBeUndefined();
    expect(fixture.settings.getCodexMcpStartupStatusSnapshot()).toMatchObject({ sequence: 94, value: { filesystem: 'ready' } });
    expect(fixture.items.listByConversation(fixture.conversations.listByProject(fixture.project.id).items[0]!.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemType: 'error', status: 'failed', textContent: expect.stringContaining('Invalid MCP startup error') })]),
    );

    await fixture.manager.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'node_repl', status: 'ready', error: null, failureReason: null }, undefined, 96);
    expect(fixture.settings.getCodexMcpStartupStatusSnapshot()).toMatchObject({
      sequence: 96,
      value: { filesystem: 'ready', node_repl: { status: 'ready', error: null } },
    });
  });

  it('uses only explicit legacy message ids as untrusted context without mutating the legacy conversation', async () => {
    const fixture = await createFixture();
    const legacy = fixture.conversations.create({ projectId: fixture.project.id, taskId: fixture.task.id, title: '旧会话' });
    const selected = fixture.conversations.appendMessage({ conversationId: legacy.id, role: 'assistant', content: '显式选择的历史', source: 'legacy', metadata: {}, createdAt: '2026-07-13T00:00:00.000Z' });
    fixture.conversations.appendMessage({ conversationId: legacy.id, role: 'assistant', content: '不得携带的历史', source: 'legacy', metadata: {}, createdAt: '2026-07-13T00:00:01.000Z' });

    const started = await fixture.coordinator.startTaskConversation(startInput(fixture, { legacyReference: { conversationId: legacy.id, messageIds: [selected.id] } }));
    expect(fixture.manager.turnStarts[0]?.additionalContext).toEqual({ kind: 'untrusted', items: [{ messageId: selected.id, role: 'assistant', content: '显式选择的历史' }] });
    expect(fixture.conversations.getById(started.conversationId)?.legacySourceConversationId).toBe(legacy.id);
    expect(fixture.conversations.getById(legacy.id)?.providerThreadId).toBeNull();
  });

  it('resumes and reads bound threads on a new generation and marks unknown dispatch windows recovery-required', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    await fixture.coordinator.close({ mode: 'handoff' });
    const inFlight = fixture.submissions.createOrGet({
      conversationId: started.conversationId,
      idempotencyKey: 'unknown-window',
      requestHash: 'sha256:unknown-window',
      clientMessageId: 'unknown-client',
      kind: 'message',
      requestedDelivery: 'queue',
      status: 'dispatching',
      input: { text: '可能已发送' },
      createdAt: '2026-07-13T00:00:30.000Z',
    });
    fixture.manager.state = { ...fixture.manager.state, generationId: 'generation-2' } as CodexTransportState;
    const recovered = createCodexNativeConversationCoordinator({
      manager: fixture.manager,
      commandPath: '/opt/homebrew/bin/codex',
      db: fixture.db,
      conversations: fixture.conversations,
      turns: fixture.turns,
      items: fixture.items,
      submissions: fixture.submissions,
      requests: fixture.requests,
      settings: fixture.settings,
      getConcurrency: () => ({ project: 0, global: 0, maxPerProject: 1, maxGlobal: 2 }),
      broadcast: () => undefined,
    });
    await recovered.recover();
    expect(fixture.manager.resumes).toContain('thread-1');
    expect(fixture.manager.reads).toContain('thread-1');
    expect(fixture.submissions.getById(inFlight.id)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
    expect(fixture.manager.turnStarts).toHaveLength(1);
    await recovered.close({ mode: 'final' });
  });

  it('reconciles a changed manager generation before dispatch and uses thread/read completion to release the slot', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    fixture.manager.threadSnapshots.set('thread-1', { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed' }] });
    fixture.manager.state = { ...fixture.manager.state, generationId: 'generation-2' } as CodexTransportState;

    const second = await fixture.coordinator.submitMessage({
      conversationId: started.conversationId,
      content: 'generation 变化后的第二轮',
      idempotencyKey: 'generation-2-message',
      clientUserMessageId: 'generation-2-client',
    });

    expect(fixture.manager.resumes).toContain('thread-1');
    expect(fixture.manager.reads).toContain('thread-1');
    expect(fixture.submissions.getById(started.submissionId)?.status).toBe('completed');
    expect(second).toMatchObject({ status: 'active', providerThreadId: 'thread-1', providerTurnId: 'turn-2' });
  });

  it('keeps a provider-confirmed active turn active during recovery instead of marking every in-flight submission unknown', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    await fixture.coordinator.close({ mode: 'handoff' });
    fixture.manager.threadSnapshots.set('thread-1', { id: 'thread-1', turns: [{ id: 'turn-1', status: 'running' }] });
    fixture.manager.state = { ...fixture.manager.state, generationId: 'generation-2' } as CodexTransportState;
    const recovered = createCodexNativeConversationCoordinator({
      manager: fixture.manager,
      commandPath: '/opt/homebrew/bin/codex',
      db: fixture.db,
      conversations: fixture.conversations,
      turns: fixture.turns,
      items: fixture.items,
      submissions: fixture.submissions,
      requests: fixture.requests,
      settings: fixture.settings,
      getConcurrency: () => ({ project: 0, global: 0, maxPerProject: 1, maxGlobal: 2 }),
      broadcast: () => undefined,
    });

    await recovered.recover();

    expect(fixture.submissions.getById(started.submissionId)).toMatchObject({ status: 'active', providerTurnId: 'turn-1' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('active');
    await recovered.close({ mode: 'final' });
  });

  it('keeps a provider-failed snapshot paused, rejects existing waiters, and never drains queued work during recovery', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const queued = await fixture.coordinator.submitMessage({
      conversationId: started.conversationId,
      content: 'must remain paused after failed recovery snapshot',
      idempotencyKey: 'queued-after-failed-snapshot',
      clientUserMessageId: 'queued-after-failed-snapshot-client',
    });
    await fixture.coordinator.close({ mode: 'handoff' });
    fixture.manager.threadSnapshots.set('thread-1', {
      id: 'thread-1',
      turns: [{ id: 'turn-1', status: 'failed', error: { message: 'failed while coordinator was offline' } }],
    });
    fixture.manager.state = { ...fixture.manager.state, generationId: 'generation-2' } as CodexTransportState;
    const recovered = createCodexNativeConversationCoordinator({
      manager: fixture.manager,
      commandPath: '/opt/homebrew/bin/codex',
      db: fixture.db,
      conversations: fixture.conversations,
      turns: fixture.turns,
      items: fixture.items,
      submissions: fixture.submissions,
      requests: fixture.requests,
      settings: fixture.settings,
      getConcurrency: () => ({ project: 0, global: 0, maxPerProject: 1, maxGlobal: 2 }),
      broadcast: () => undefined,
    });
    const waiter = recovered.waitForTurnResult({ conversationId: started.conversationId, providerTurnId: 'turn-1', timeoutMs: 500 });
    const waiterRejection = expect(waiter).rejects.toMatchObject({ code: 'ZEUS_CODEX_TURN_FAILED' });

    await recovered.recover();

    await waiterRejection;
    expect(fixture.submissions.getById(started.submissionId)).toMatchObject({ status: 'failed', providerTurnId: 'turn-1' });
    expect(fixture.submissions.getById(queued.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
    expect(fixture.turns.listByConversation(started.conversationId)[0]).toMatchObject({ status: 'failed' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('failed');
    expect(fixture.manager.turnStarts).toHaveLength(1);
    await recovered.close({ mode: 'final' });
  });

  it('fairly dispatches durable queued submissions from other conversations whenever a global slot is released', async () => {
    const fixture = await createFixture({ concurrency: { project: 0, global: 0, maxPerProject: 1, maxGlobal: 1 } });
    const first = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const second = await fixture.coordinator.startTaskConversation(
      startInput(fixture, {
        taskTitle: '第二个会话',
        prompt: '第二个会话先排队',
        idempotencyKey: 'second-conversation',
        clientUserMessageId: 'second-conversation-client',
      }),
    );
    const third = await fixture.coordinator.startTaskConversation(
      startInput(fixture, {
        taskTitle: '第三个会话',
        prompt: '第三个会话后排队',
        idempotencyKey: 'third-conversation',
        clientUserMessageId: 'third-conversation-client',
      }),
    );
    expect([second.status, third.status]).toEqual(['queued', 'queued']);

    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: first.providerTurnId, status: 'completed' } }, undefined, 31);
    expect(fixture.submissions.getById(second.submissionId)?.status).toBe('active');
    expect(fixture.submissions.getById(third.submissionId)?.status).toBe('queued');

    await fixture.manager.emit('turn/completed', { threadId: 'thread-2', turn: { id: 'turn-2', status: 'completed' } }, undefined, 32);
    expect(fixture.submissions.getById(third.submissionId)?.status).toBe('active');
    expect(fixture.manager.turnStarts.map((turn) => turn.input[0]?.text)).toEqual(['第一轮真实输入', '第二个会话先排队', '第三个会话后排队']);
  });

  it('honors queuePosition inside each conversation before applying createdAt fairness across conversation heads', async () => {
    const fixture = await createFixture({ concurrency: { project: 0, global: 0, maxPerProject: 1, maxGlobal: 1 } });
    const active = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const queuedConversation = await fixture.coordinator.startTaskConversation(
      startInput(fixture, {
        taskTitle: '可重排会话',
        prompt: '原队头',
        idempotencyKey: 'reorder-first',
        clientUserMessageId: 'reorder-first-client',
      }),
    );
    const promoted = await fixture.coordinator.submitMessage({
      conversationId: queuedConversation.conversationId,
      content: '重排后的队头',
      idempotencyKey: 'reorder-second',
      clientUserMessageId: 'reorder-second-client',
    });
    await fixture.coordinator.reorderQueue({
      conversationId: queuedConversation.conversationId,
      orderedSubmissionIds: [promoted.submissionId, queuedConversation.submissionId],
    });

    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: active.providerTurnId, status: 'completed' } }, undefined, 34);

    expect(fixture.submissions.getById(promoted.submissionId)?.status).toBe('active');
    expect(fixture.submissions.getById(queuedConversation.submissionId)?.status).toBe('queued');
    expect(fixture.manager.turnStarts.at(-1)?.input[0]?.text).toBe('重排后的队头');
  });

  it('drains durable queued submissions after restart recovery when capacity is available', async () => {
    const fixture = await createFixture({ concurrency: { project: 1, global: 1, maxPerProject: 1, maxGlobal: 1 } });
    const queued = await fixture.coordinator.startTaskConversation(startInput(fixture));
    expect(queued.status).toBe('queued');
    await fixture.coordinator.close({ mode: 'handoff' });
    const recovered = createCodexNativeConversationCoordinator({
      manager: fixture.manager,
      commandPath: '/opt/homebrew/bin/codex',
      db: fixture.db,
      conversations: fixture.conversations,
      turns: fixture.turns,
      items: fixture.items,
      submissions: fixture.submissions,
      requests: fixture.requests,
      settings: fixture.settings,
      getConcurrency: () => ({ project: 0, global: 0, maxPerProject: 1, maxGlobal: 1 }),
      broadcast: () => undefined,
    });

    await recovered.recover();

    expect(fixture.submissions.getById(queued.submissionId)?.status).toBe('active');
    expect(fixture.manager.threadStarts).toHaveLength(1);
    await recovered.close({ mode: 'final' });
  });

  it('finishes the active queue dispatch before handoff without starting later candidates from the same drain batch', async () => {
    const concurrency = { project: 2, global: 2, maxPerProject: 2, maxGlobal: 2 };
    const fixture = await createFixture({ concurrency });
    const first = await fixture.coordinator.startTaskConversation(
      startInput(fixture, {
        taskTitle: 'handoff drain first',
        prompt: 'first candidate',
        idempotencyKey: 'handoff-drain-first',
        clientUserMessageId: 'handoff-drain-first-client',
      }),
    );
    const second = await fixture.coordinator.startTaskConversation(
      startInput(fixture, {
        taskTitle: 'handoff drain second',
        prompt: 'second candidate',
        idempotencyKey: 'handoff-drain-second',
        clientUserMessageId: 'handoff-drain-second-client',
      }),
    );
    expect([first.status, second.status]).toEqual(['queued', 'queued']);

    const firstTurnEntered = deferred<void>();
    const releaseFirstTurn = deferred<void>();
    let startTurnCalls = 0;
    fixture.manager.beforeStartTurn = async () => {
      startTurnCalls += 1;
      if (startTurnCalls !== 1) return;
      firstTurnEntered.resolve(undefined);
      await releaseFirstTurn.promise;
    };
    concurrency.project = 0;
    concurrency.global = 0;
    const draining = fixture.coordinator.capacityChanged();
    await firstTurnEntered.promise;

    let handoffSettled = false;
    const handoff = fixture.coordinator.close({ mode: 'handoff' }).then(() => {
      handoffSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const handoffHeldThePersistenceBoundary = !handoffSettled;
    releaseFirstTurn.resolve(undefined);
    await Promise.all([draining, handoff]);

    expect(handoffHeldThePersistenceBoundary).toBe(true);
    expect(fixture.manager.threadStarts).toHaveLength(1);
    expect(fixture.manager.turnStarts).toHaveLength(1);
    expect(fixture.submissions.getById(first.submissionId)?.status).toBe('active');
    expect(fixture.submissions.getById(second.submissionId)?.status).toBe('queued');
    const disk = await createZeusDatabase(fixture.dbPath);
    expect(new ConversationSubmissionRepository(disk).getById(first.submissionId)?.status).toBe('active');
    fixture.manager.beforeStartTurn = null;
    await fixture.coordinator.close({ mode: 'final' });
  });

  it('restores a durable interrupted queue as explicitly resumable after restart', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const queued = await fixture.coordinator.submitMessage({
      conversationId: started.conversationId,
      content: '重启后显式恢复',
      idempotencyKey: 'restart-interrupted-queue',
      clientUserMessageId: 'restart-interrupted-client',
    });
    await fixture.coordinator.interruptTurn({ conversationId: started.conversationId, providerTurnId: 'turn-1' });
    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } }, undefined, 33);
    expect(fixture.submissions.getById(queued.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'interrupted' });
    await fixture.coordinator.close({ mode: 'handoff' });
    fixture.manager.threadSnapshots.set('thread-1', { id: 'thread-1', turns: [{ id: 'turn-1', status: 'interrupted' }] });
    fixture.manager.state = { ...fixture.manager.state, generationId: 'generation-2' } as CodexTransportState;
    const recovered = createCodexNativeConversationCoordinator({
      manager: fixture.manager,
      commandPath: '/opt/homebrew/bin/codex',
      db: fixture.db,
      conversations: fixture.conversations,
      turns: fixture.turns,
      items: fixture.items,
      submissions: fixture.submissions,
      requests: fixture.requests,
      settings: fixture.settings,
      getConcurrency: () => ({ project: 0, global: 0, maxPerProject: 1, maxGlobal: 1 }),
      broadcast: () => undefined,
    });

    await recovered.recover();
    await recovered.resumeInterruptedQueue({ conversationId: started.conversationId });

    expect(fixture.submissions.getById(queued.submissionId)?.status).toBe('active');
    expect(fixture.manager.turnStarts).toHaveLength(2);
    await recovered.close({ mode: 'final' });
  });

  it('persists waiting authority and resumes the provider turn identity after responding', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const queued = await fixture.coordinator.submitMessage({
      conversationId: started.conversationId,
      content: 'approval 后立即发送',
      idempotencyKey: 'waiting-queued',
      clientUserMessageId: 'waiting-queued-client',
    });

    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd', availableDecisions: ['accept', 'decline', 'cancel'] }, 'waiting-command', 39);
    const request = fixture.requests.getByProvider('generation-1', 'waiting-command')!;
    const waitingTurn = fixture.turns.getById(request.turnId!)!;
    expect(waitingTurn).toMatchObject({ providerTurnId: 'turn-1', status: 'waiting' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('waiting');

    await fixture.coordinator.respondToRequest({ requestId: request.id, response: { type: 'command', decision: 'accept' } });
    expect(fixture.turns.getById(request.turnId!)).toMatchObject({ providerTurnId: 'turn-1', status: 'running' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('active');

    await fixture.coordinator.sendQueuedNow({ conversationId: started.conversationId, submissionId: queued.submissionId });
    expect(fixture.manager.steers.at(-1)).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' });
  });

  it('fail-closes malformed canonical request_user_input envelopes and pauses all durable work', async () => {
    const question = { id: 'choice', header: 'Choice', question: 'Choose', options: [{ label: 'A', description: '' }], isOther: false, isSecret: false };
    const invalidCases: Array<{ name: string; payload: Record<string, unknown> }> = [
      {
        name: 'missing-item-id',
        payload: { threadId: 'thread-1', turnId: 'turn-1', questions: [question], autoResolutionMs: null },
      },
      {
        name: 'non-finite-auto-resolution',
        payload: canonicalRuiPayload([question], 'bad-auto-item', { autoResolutionMs: Number.POSITIVE_INFINITY }),
      },
      {
        name: 'unexpected-envelope-key',
        payload: canonicalRuiPayload([question], 'unexpected-key-item', { unexpected: true }),
      },
    ];

    for (const [index, invalidCase] of invalidCases.entries()) {
      const fixture = await createFixture();
      const started = await fixture.coordinator.startTaskConversation(startInput(fixture, { idempotencyKey: `rui-invalid-start-${index}`, clientUserMessageId: `rui-invalid-client-${index}` }));
      const queued = await fixture.coordinator.submitMessage({
        conversationId: started.conversationId,
        content: 'must not drain after malformed RUI',
        idempotencyKey: `rui-invalid-queued-${index}`,
        clientUserMessageId: `rui-invalid-queued-client-${index}`,
      });
      const providerRequestId = `rui-invalid-${invalidCase.name}`;

      await fixture.manager.emit('item/tool/requestUserInput', invalidCase.payload, providerRequestId, 300 + index);

      const durableRequest = fixture.requests.getByProvider('generation-1', providerRequestId)!;
      expect(durableRequest.status).toBe('failed');
      expect(JSON.parse(durableRequest.responseJson!)).toMatchObject({ error: 'ZEUS_CODEX_REQUEST_USER_INPUT_ENVELOPE_INVALID', recoveryRequired: true });
      expect(fixture.turns.getById(durableRequest.turnId!)).toMatchObject({ status: 'paused' });
      expect(fixture.submissions.getById(started.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
      expect(fixture.submissions.getById(queued.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
      expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('paused');
      expect(fixture.manager.interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
      expect(fixture.manager.turnStarts).toHaveLength(1);
      expect(fixture.broadcasts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'conversation.native.error', payload: expect.objectContaining({ error: 'ZEUS_CODEX_REQUEST_USER_INPUT_ENVELOPE_INVALID' }) })]));
      expect(fixture.broadcasts.some((event) => event.type === 'conversation.request.created')).toBe(false);
    }
  });

  it('routes the current app-server MCP elicitation method as a durable MCP request', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));

    await fixture.manager.emit(
      'mcpServer/elicitation/request',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'node_repl',
        mode: 'form',
        message: 'Choose a safe action',
        requestedSchema: { type: 'object', properties: {} },
        _meta: null,
      },
      'mcp-current-method',
      40,
    );

    const request = fixture.requests.getByProvider('generation-1', 'mcp-current-method');
    expect(request).toMatchObject({ requestKind: 'mcp', status: 'pending' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('waiting');

    await fixture.coordinator.respondToRequest({
      requestId: request!.id,
      response: { type: 'mcp', action: 'decline', content: null, _meta: null },
    });

    expect(fixture.manager.responses.at(-1)).toMatchObject({
      type: 'mcp',
      action: 'decline',
      generationId: 'generation-1',
      requestId: 'mcp-current-method',
    });
  });

  it('retires stale-generation requests during recovery and grants waiting authority only to the current generation', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd' }, 'generation-request', 70);
    const staleRequest = fixture.requests.getByProvider('generation-1', 'generation-request')!;
    expect(staleRequest.status).toBe('pending');
    await fixture.coordinator.close({ mode: 'handoff' });

    fixture.manager.threadSnapshots.set('thread-1', { id: 'thread-1', turns: [{ id: 'turn-1', status: 'running' }] });
    fixture.manager.state = { ...fixture.manager.state, generationId: 'generation-2' } as CodexTransportState;
    const recovered = createCodexNativeConversationCoordinator({
      manager: fixture.manager,
      commandPath: '/opt/homebrew/bin/codex',
      db: fixture.db,
      conversations: fixture.conversations,
      turns: fixture.turns,
      items: fixture.items,
      submissions: fixture.submissions,
      requests: fixture.requests,
      settings: fixture.settings,
      getConcurrency: () => ({ project: 0, global: 0, maxPerProject: 1, maxGlobal: 2 }),
      broadcast: (type, payload) => fixture.broadcasts.push({ type, payload }),
    });

    await recovered.recover();

    expect(fixture.requests.getById(staleRequest.id)).toMatchObject({ status: 'failed', transportGenerationId: 'generation-1' });
    expect(JSON.parse(fixture.requests.getById(staleRequest.id)!.responseJson!)).toMatchObject({ error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE', recoveryRequired: true });
    expect(fixture.turns.getById(staleRequest.turnId!)).toMatchObject({ status: 'running' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('active');
    await expect(recovered.respondToRequest({ requestId: staleRequest.id, response: { type: 'command', decision: 'decline' } })).rejects.toMatchObject({ code: 'ZEUS_CODEX_REQUEST_GENERATION_STALE' });
    expect(fixture.manager.responses).toHaveLength(0);

    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd' }, 'generation-request', 71);
    const currentRequest = fixture.requests.getByProvider('generation-2', 'generation-request')!;
    expect(currentRequest).toMatchObject({ status: 'pending', transportGenerationId: 'generation-2' });
    expect(fixture.turns.getById(currentRequest.turnId!)).toMatchObject({ status: 'waiting' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('waiting');

    await fixture.manager.emit('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', path: join(fixture.project.localPath, 'late.txt') }, 'late-stale-request', 72, 'generation-1');
    const lateStaleRequest = fixture.requests.getByProvider('generation-1', 'late-stale-request')!;
    expect(lateStaleRequest.status).toBe('failed');
    expect(JSON.parse(lateStaleRequest.responseJson!)).toMatchObject({ error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE', recoveryRequired: true });

    await recovered.respondToRequest({ requestId: currentRequest.id, response: { type: 'command', decision: 'decline' } });
    expect(fixture.manager.responses).toEqual([expect.objectContaining({ generationId: 'generation-2', requestId: 'generation-request', type: 'command', decision: 'decline' })]);
    expect(fixture.turns.getById(currentRequest.turnId!)).toMatchObject({ status: 'running' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('active');
    await recovered.close({ mode: 'final' });
  });

  it('replays a resolved request response without recreating waiting state on duplicate provider delivery', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const payload = { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd' };
    await fixture.manager.emit('item/commandExecution/requestApproval', payload, 'duplicate-command', 38);
    const request = fixture.requests.getByProvider('generation-1', 'duplicate-command')!;
    await fixture.coordinator.respondToRequest({ requestId: request.id, response: { type: 'command', decision: 'decline' } });
    const createdBeforeDuplicate = fixture.broadcasts.filter((event) => event.type === 'conversation.request.created').length;
    const effectiveResponse = fixture.manager.responses.at(-1);

    await fixture.manager.emit('item/commandExecution/requestApproval', payload, 'duplicate-command', 40);

    expect(fixture.requests.getById(request.id)?.status).toBe('resolved');
    expect(fixture.turns.getById(request.turnId!)?.status).toBe('running');
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('active');
    expect(fixture.broadcasts.filter((event) => event.type === 'conversation.request.created')).toHaveLength(createdBeforeDuplicate);
    expect(fixture.manager.responses).toEqual([effectiveResponse, effectiveResponse]);
  });

  it('does not replace durable interaction authority when one provider request id conflicts on method or payload', async () => {
    const fixture = await createFixture();
    await fixture.coordinator.startTaskConversation(startInput(fixture));
    const originalPayload = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      command: ['/bin/echo', 'safe'],
      metadata: { cwd: fixture.project.localPath, timeoutMs: 1_000 },
      availableDecisions: ['accept', 'decline', 'cancel'],
    };
    await fixture.manager.emit('item/commandExecution/requestApproval', originalPayload, 'conflicting-provider-request', 80);
    const original = fixture.requests.getByProvider('generation-1', 'conflicting-provider-request')!;

    await fixture.manager.emit('item/fileChange/requestApproval', originalPayload, 'conflicting-provider-request', 81);
    await fixture.manager.emit('item/commandExecution/requestApproval', { ...originalPayload, command: ['/bin/echo', 'mutated'] }, 'conflicting-provider-request', 82);

    expect(fixture.requests.listByConversation(original.conversationId)).toHaveLength(1);
    expect(fixture.requests.getById(original.id)).toEqual(original);
    expect(fixture.broadcasts.filter((event) => event.type === 'conversation.request.created')).toHaveLength(1);
    expect(fixture.broadcasts.filter((event) => event.type === 'conversation.native.error')).toHaveLength(2);
  });

  it('terminates durable request authority and pauses the whole conversation on a manager identity conflict', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const queued = await fixture.coordinator.submitMessage({
      conversationId: started.conversationId,
      content: 'must remain paused after request identity conflict',
      idempotencyKey: 'identity-conflict-queued',
      clientUserMessageId: 'identity-conflict-queued-client',
    });
    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: ['/bin/pwd'], availableDecisions: ['accept', 'decline', 'cancel'] }, 'identity-conflict-request', 83);
    const request = fixture.requests.getByProvider('generation-1', 'identity-conflict-request')!;
    expect(request.status).toBe('pending');

    await fixture.manager.emit(
      'transport/server_request_identity_conflict',
      {
        originalMethod: 'item/commandExecution/requestApproval',
        receivedMethod: 'item/fileChange/requestApproval',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
      'identity-conflict-request',
      84,
    );

    const failedRequest = fixture.requests.getById(request.id)!;
    expect(failedRequest.status).toBe('failed');
    expect(JSON.parse(failedRequest.responseJson!)).toMatchObject({ error: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT', recoveryRequired: true });
    expect(fixture.turns.getById(request.turnId!)).toMatchObject({ status: 'paused' });
    expect(fixture.submissions.getById(started.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
    expect(fixture.submissions.getById(queued.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('paused');
    expect(fixture.manager.interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    expect(fixture.manager.turnStarts).toHaveLength(1);
    expect(fixture.broadcasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'conversation.request.resolved', payload: expect.objectContaining({ requestId: request.id }) }),
        expect.objectContaining({ type: 'conversation.native.error', payload: expect.objectContaining({ error: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT' }) }),
      ]),
    );
    await expect(fixture.coordinator.respondToRequest({ requestId: request.id, response: { type: 'command', decision: 'decline' } })).rejects.toMatchObject({ code: 'ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND' });
  });

  it('interrupts and marks recovery-required when a resolved secret request is delivered again and cannot be replayed safely', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const payload = canonicalRuiPayload([{ id: 'token', header: 'Token', question: '请输入', options: null, isOther: false, isSecret: true }], 'duplicate-secret-item');
    const secret = 'SECRET-DUPLICATE-MUST-NOT-PERSIST';
    await fixture.manager.emit('item/tool/requestUserInput', payload, 'duplicate-secret', 72);
    const request = fixture.requests.getByProvider('generation-1', 'duplicate-secret')!;
    await fixture.coordinator.respondToRequest({
      requestId: request.id,
      response: { type: 'request_user_input', answers: { token: { answers: [secret] } } },
    });
    expect(fixture.manager.responses).toHaveLength(1);

    await fixture.manager.emit('item/tool/requestUserInput', payload, 'duplicate-secret', 73);

    expect(fixture.manager.responses).toHaveLength(1);
    expect(fixture.manager.interrupts).toContainEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(fixture.requests.getById(request.id)?.status).toBe('failed');
    expect(JSON.parse(fixture.requests.getById(request.id)!.responseJson!)).toMatchObject({
      error: 'ZEUS_CODEX_SECRET_REQUEST_REPLAY_UNAVAILABLE',
      recoveryRequired: true,
    });
    expect(fixture.turns.getById(request.turnId!)).toMatchObject({ status: 'paused' });
    expect(fixture.submissions.getById(started.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('paused');
    expect(fixture.broadcasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'conversation.native.error',
          payload: expect.objectContaining({ error: 'ZEUS_CODEX_SECRET_REQUEST_REPLAY_UNAVAILABLE', recoveryRequired: true }),
        }),
      ]),
    );
    const createdAfterRecovery = fixture.broadcasts.filter((event) => event.type === 'conversation.request.created').length;
    const interruptsAfterRecovery = fixture.manager.interrupts.length;
    await fixture.manager.emit('item/tool/requestUserInput', payload, 'duplicate-secret', 74);
    expect(fixture.requests.getById(request.id)?.status).toBe('failed');
    expect(fixture.turns.getById(request.turnId!)).toMatchObject({ status: 'paused' });
    expect(fixture.submissions.getById(started.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
    expect(fixture.manager.responses).toHaveLength(1);
    expect(fixture.manager.interrupts).toHaveLength(interruptsAfterRecovery);
    expect(fixture.broadcasts.filter((event) => event.type === 'conversation.request.created')).toHaveLength(createdAfterRecovery);
    const dump = JSON.stringify(fixture.db.listTableNames().flatMap((table) => fixture.db.select<Record<string, unknown>>(`SELECT * FROM "${table}"`)));
    expect(dump).not.toContain(secret);
  });

  it('enforces read-only and network-disabled policy at the approval boundary regardless of the user response', async () => {
    const fixture = await createFixture();
    await fixture.coordinator.startTaskConversation(startInput(fixture, { allowCodeChanges: false }));
    expect(fixture.manager.threadStarts[0]).toMatchObject({ sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' });

    await fixture.manager.emit('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', path: join(fixture.project.localPath, 'blocked.txt') }, 'readonly-file', 40);
    const fileRequest = fixture.requests.getByProvider('generation-1', 'readonly-file')!;
    await fixture.coordinator.respondToRequest({ requestId: fileRequest.id, response: { type: 'file', decision: 'accept' } });
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'file', decision: 'accept' });

    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: ['pwd'], availableDecisions: ['accept', 'decline', 'cancel'] }, 'readonly-command', 43);
    const readonlyCommandRequest = fixture.requests.getByProvider('generation-1', 'readonly-command')!;
    await fixture.coordinator.respondToRequest({ requestId: readonlyCommandRequest.id, response: { type: 'command', decision: 'accept' } });
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'accept' });
    expect(JSON.parse(fixture.requests.getById(readonlyCommandRequest.id)!.responseJson!)).toEqual({ type: 'command', decision: 'accept' });

    await fixture.manager.emit('item/permissions/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', permissions: { network: { enabled: true }, fileSystem: { read: [fixture.project.localPath], write: [] } } }, 'network-policy', 41);
    const networkRequest = fixture.requests.getByProvider('generation-1', 'network-policy')!;
    await expect(
      fixture.coordinator.respondToRequest({
        requestId: networkRequest.id,
        response: { type: 'permissions', permissions: { network: { enabled: true }, fileSystem: { read: [fixture.project.localPath], write: [] } }, scope: 'turn' },
      }),
    ).rejects.toMatchObject({ code: 'ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_POLICY' });

    await fixture.manager.emit(
      'item/permissions/requestApproval',
      { threadId: 'thread-1', turnId: 'turn-1', permissions: { network: { enabled: false }, fileSystem: { read: [fixture.project.localPath], write: [fixture.project.localPath] } } },
      'readonly-write-policy',
      42,
    );
    const writeRequest = fixture.requests.getByProvider('generation-1', 'readonly-write-policy')!;
    await expect(
      fixture.coordinator.respondToRequest({
        requestId: writeRequest.id,
        response: { type: 'permissions', permissions: { network: { enabled: false }, fileSystem: { read: [fixture.project.localPath], write: [fixture.project.localPath] } }, scope: 'turn' },
      }),
    ).rejects.toMatchObject({ code: 'ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_POLICY' });
    expect(fixture.manager.responses.filter((response) => response.type === 'permissions')).toHaveLength(0);

    const parityFixture = await createFixture();
    await parityFixture.coordinator.startTaskConversation(startInput(parityFixture, { allowCodeChanges: false, permissionMode: 'auto' }));
    await parityFixture.manager.emit(
      'item/commandExecution/requestApproval',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        command: ['/bin/zsh', '-lc', 'rg --files docs'],
        cwd: parityFixture.project.localPath,
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
      'codex-parity-shell-read',
      44,
    );
    const parityRequest = parityFixture.requests.getByProvider('generation-1', 'codex-parity-shell-read')!;
    await parityFixture.coordinator.respondToRequest({ requestId: parityRequest.id, response: { type: 'command', decision: 'accept' } });
    expect(parityFixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'accept' });
    expect(JSON.parse(parityFixture.requests.getById(parityRequest.id)!.responseJson!)).toEqual({ type: 'command', decision: 'accept' });

    const outside = join(fixture.dir, 'permission-outside');
    await mkdir(outside);
    const symlinkEscape = join(fixture.project.localPath, 'permission-escape');
    await symlink(outside, symlinkEscape);
    await fixture.manager.emit('item/permissions/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', permissions: { network: { enabled: false }, fileSystem: { read: [symlinkEscape], write: [] } } }, 'symlink-permission-escape', 43);
    const symlinkRequest = fixture.requests.getByProvider('generation-1', 'symlink-permission-escape')!;
    await expect(
      fixture.coordinator.respondToRequest({
        requestId: symlinkRequest.id,
        response: { type: 'permissions', permissions: { network: { enabled: false }, fileSystem: { read: [symlinkEscape], write: [] } }, scope: 'turn' },
      }),
    ).rejects.toMatchObject({ code: 'ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_REQUEST' });

    const writableFixture = await createFixture();
    await writableFixture.coordinator.startTaskConversation(startInput(writableFixture));
    await writableFixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd', availableDecisions: ['accept', 'decline', 'cancel'] }, 'direct-pwd', 44);
    const directPwdRequest = writableFixture.requests.getByProvider('generation-1', 'direct-pwd')!;
    await writableFixture.coordinator.respondToRequest({ requestId: directPwdRequest.id, response: { type: 'command', decision: 'accept' } });
    expect(writableFixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'accept' });
    expect(JSON.parse(writableFixture.requests.getById(directPwdRequest.id)!.responseJson!)).toEqual({ type: 'command', decision: 'accept' });

    await writableFixture.manager.emit(
      'item/fileChange/requestApproval',
      { threadId: 'thread-1', turnId: 'turn-1', path: join(writableFixture.project.localPath, 'one-shot-only.txt'), reason: null, grantRoot: null },
      'file-one-shot-only',
      45,
    );
    const oneShotFileRequest = writableFixture.requests.getByProvider('generation-1', 'file-one-shot-only')!;
    const responsesBeforeFileSessionGrant = writableFixture.manager.responses.length;
    await expect(writableFixture.coordinator.respondToRequest({ requestId: oneShotFileRequest.id, response: { type: 'file', decision: 'acceptForSession' } })).rejects.toMatchObject({ code: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
    expect(writableFixture.manager.responses).toHaveLength(responsesBeforeFileSessionGrant);

    await writableFixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: ['curl', 'https://example.com'] }, 'network-command', 44);
    const networkCommandRequest = writableFixture.requests.getByProvider('generation-1', 'network-command')!;
    await writableFixture.coordinator.respondToRequest({ requestId: networkCommandRequest.id, response: { type: 'command', decision: 'accept' } });
    expect(writableFixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'decline' });

    await writableFixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', argvObject: { executable: 'pwd' } }, 'unknown-command-schema', 45);
    const unknownCommandRequest = writableFixture.requests.getByProvider('generation-1', 'unknown-command-schema')!;
    await writableFixture.coordinator.respondToRequest({ requestId: unknownCommandRequest.id, response: { type: 'command', decision: 'accept' } });
    expect(writableFixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'decline' });

    const unsafePolicies: Array<{ id: string; policy: Record<string, unknown> }> = [
      { id: 'danger-full-access', policy: { sandboxPolicy: { type: 'dangerFullAccess' } } },
      { id: 'network-access', policy: { sandboxPolicy: { type: 'workspaceWrite', writableRoots: [writableFixture.project.localPath], networkAccess: true } } },
      { id: 'unknown-elevation-field', policy: { sandboxPolicy: { type: 'workspaceWrite', writableRoots: [writableFixture.project.localPath], networkAccess: false, elevationMode: 'none' } } },
      { id: 'outside-writable-root', policy: { sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/tmp'], networkAccess: false } } },
    ];
    for (const [index, { id, policy }] of unsafePolicies.entries()) {
      await writableFixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: ['/bin/pwd'], ...policy }, id, 46 + index);
      const policyRequest = writableFixture.requests.getByProvider('generation-1', id)!;
      await writableFixture.coordinator.respondToRequest({ requestId: policyRequest.id, response: { type: 'command', decision: 'accept' } });
      expect(writableFixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'decline' });
      expect(JSON.parse(writableFixture.requests.getById(policyRequest.id)!.responseJson!)).toEqual({ type: 'command', decision: 'decline' });
    }
  });

  it('fail-closes Git approvals unless the task explicitly allows a trusted absolute Git executable', async () => {
    const fixture = await createFixture();
    await fixture.coordinator.startTaskConversation(startInput(fixture));
    const mutations: unknown[] = [
      `/usr/bin/git -C ${fixture.project.localPath} commit -m forbidden`,
      ['git', '-C', fixture.project.localPath, 'reset', '--hard', 'HEAD~1'],
      ['/opt/homebrew/bin/git', '--git-dir', join(fixture.project.localPath, '.git'), 'update-ref', 'refs/heads/main', 'deadbeef'],
      `/bin/zsh -lc "git -C ${fixture.project.localPath} rebase main"`,
      ['git', '-c', 'alias.safe=status', 'safe'],
      ['git', 'unknown-subcommand'],
      ['git', 'fast-import'],
      ['git', 'am', join(fixture.project.localPath, 'change.patch')],
      ['git', 'remote', 'update'],
      `sh -c 'g=git; "$g" commit -m forbidden'`,
    ];
    for (const [index, command] of mutations.entries()) {
      const requestId = `git-mutation-${index}`;
      await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command }, requestId, 50 + index);
      const request = fixture.requests.getByProvider('generation-1', requestId)!;
      await fixture.coordinator.respondToRequest({ requestId: request.id, response: { type: 'command', decision: 'accept' } });
      expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'decline' });
      expect(JSON.parse(fixture.requests.getById(request.id)!.responseJson!)).toEqual({ type: 'command', decision: 'decline' });
    }

    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/usr/bin/git status' }, 'git-readonly', 55);
    const readonlyRequest = fixture.requests.getByProvider('generation-1', 'git-readonly')!;
    await fixture.coordinator.respondToRequest({ requestId: readonlyRequest.id, response: { type: 'command', decision: 'accept' } });
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'decline' });
    expect(JSON.parse(fixture.requests.getById(readonlyRequest.id)!.responseJson!)).toEqual({ type: 'command', decision: 'decline' });

    const allowedFixture = await createFixture();
    await allowedFixture.coordinator.startTaskConversation(startInput(allowedFixture, { allowGitCommit: true }));
    await allowedFixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/usr/bin/git status', availableDecisions: ['accept', 'decline', 'cancel'] }, 'trusted-git', 70);
    const trustedGit = allowedFixture.requests.getByProvider('generation-1', 'trusted-git')!;
    await allowedFixture.coordinator.respondToRequest({ requestId: trustedGit.id, response: { type: 'command', decision: 'accept' } });
    expect(allowedFixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'accept' });
    expect(JSON.parse(allowedFixture.requests.getById(trustedGit.id)!.responseJson!)).toEqual({ type: 'command', decision: 'accept' });

    const fakeBin = join(allowedFixture.project.localPath, 'fake-bin');
    const fakeGit = join(fakeBin, 'git');
    await mkdir(fakeBin);
    await writeFile(fakeGit, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(fakeGit, 0o755);
    const unsafeExecutions: Array<{ id: string; payload: Record<string, unknown> }> = [
      { id: 'naked-git-path', payload: { command: ['git', '-C', allowedFixture.project.localPath, 'status'], PATH: fakeBin } },
      { id: 'project-fake-git', payload: { command: [fakeGit, '-C', allowedFixture.project.localPath, 'status'] } },
      { id: 'git-env', payload: { command: ['/usr/bin/git', '-C', allowedFixture.project.localPath, 'status'], env: { GIT_CONFIG_GLOBAL: join(allowedFixture.project.localPath, 'hostile.gitconfig') } } },
      { id: 'naked-pwd', payload: { command: ['pwd'] } },
      { id: 'string-shell-indirection', payload: { command: `/bin/zsh -lc 'g=/usr/bin/git; "$g" status'` } },
      { id: 'string-pipe', payload: { command: '/usr/bin/git status | /usr/bin/git status' } },
      { id: 'string-command-substitution', payload: { command: '/usr/bin/git $(printf status)' } },
      { id: 'string-newline', payload: { command: '/usr/bin/git status\n/bin/pwd' } },
      { id: 'string-redirection', payload: { command: '/usr/bin/git status > result.txt' } },
      { id: 'string-complex-quoting', payload: { command: "/usr/bin/git 'status'" } },
    ];
    for (const [index, { id, payload }] of unsafeExecutions.entries()) {
      await allowedFixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', ...payload }, id, 71 + index);
      const request = allowedFixture.requests.getByProvider('generation-1', id)!;
      await allowedFixture.coordinator.respondToRequest({ requestId: request.id, response: { type: 'command', decision: 'accept' } });
      expect(allowedFixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'decline' });
      expect(JSON.parse(allowedFixture.requests.getById(request.id)!.responseJson!)).toEqual({ type: 'command', decision: 'decline' });
    }

    const outside = join(allowedFixture.project.localPath, '..', 'outside-realpath');
    const escape = join(allowedFixture.project.localPath, 'escape');
    await mkdir(outside);
    await symlink(outside, escape);
    const symlinkEscapes: Array<{ id: string; payload: Record<string, unknown> }> = [
      { id: 'cwd-symlink-escape', payload: { command: ['/bin/pwd'], cwd: escape } },
      { id: 'writable-root-symlink-escape', payload: { command: ['/bin/pwd'], writableRoots: [escape] } },
      { id: 'git-c-symlink-escape', payload: { command: ['/usr/bin/git', '-C', escape, 'status'] } },
    ];
    for (const [index, { id, payload }] of symlinkEscapes.entries()) {
      await allowedFixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', ...payload }, id, 80 + index);
      const request = allowedFixture.requests.getByProvider('generation-1', id)!;
      await allowedFixture.coordinator.respondToRequest({ requestId: request.id, response: { type: 'command', decision: 'accept' } });
      expect(allowedFixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'decline' });
      expect(JSON.parse(allowedFixture.requests.getById(request.id)!.responseJson!)).toEqual({ type: 'command', decision: 'decline' });
    }
  });

  it('validates permissions glob depth and rejects unknown or amplified grant schemas fail-closed', async () => {
    const fixture = await createFixture();
    await fixture.coordinator.startTaskConversation(startInput(fixture));
    await fixture.manager.emit(
      'item/permissions/requestApproval',
      { threadId: 'thread-1', turnId: 'turn-1', permissions: { network: { enabled: false }, fileSystem: { read: [fixture.project.localPath], write: [], globScanMaxDepth: 4 } } },
      'glob-depth',
      60,
    );
    const depthRequest = fixture.requests.getByProvider('generation-1', 'glob-depth')!;
    await expect(
      fixture.coordinator.respondToRequest({
        requestId: depthRequest.id,
        response: { type: 'permissions', permissions: { network: { enabled: false }, fileSystem: { read: [fixture.project.localPath], write: [], globScanMaxDepth: 5 } }, scope: 'turn' },
      }),
    ).rejects.toMatchObject({ code: 'ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_REQUEST' });

    await fixture.manager.emit('item/permissions/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', permissions: { fileSystem: { read: [fixture.project.localPath], write: [], globScanMaxDepth: -1 } } }, 'invalid-glob-depth', 61);
    const invalidRequest = fixture.requests.getByProvider('generation-1', 'invalid-glob-depth')!;
    await expect(
      fixture.coordinator.respondToRequest({
        requestId: invalidRequest.id,
        response: { type: 'permissions', permissions: { fileSystem: { read: [fixture.project.localPath], write: [], globScanMaxDepth: 0 } }, scope: 'turn' },
      }),
    ).rejects.toMatchObject({ code: 'ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED' });

    await fixture.manager.emit('item/permissions/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', permissions: { fileSystem: { read: [fixture.project.localPath], write: [], globScanMaxDepth: 4 } } }, 'unknown-grant-field', 62);
    const unknownGrantRequest = fixture.requests.getByProvider('generation-1', 'unknown-grant-field')!;
    await expect(
      fixture.coordinator.respondToRequest({
        requestId: unknownGrantRequest.id,
        response: { type: 'permissions', permissions: { fileSystem: { read: [fixture.project.localPath], write: [], globScanMaxDepth: 3, execute: [fixture.project.localPath] } }, scope: 'turn' } as never,
      }),
    ).rejects.toMatchObject({ code: 'ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED' });
  });

  it('rejects a concurrency-full ephemeral Graph turn before creating any durable conversation or queued orphan', async () => {
    const fixture = await createFixture({ concurrency: { project: 1, global: 1, maxPerProject: 1, maxGlobal: 1 } });
    const before = fixture.conversations.listByProject(fixture.project.id).total;

    await expect(
      fixture.coordinator.startEphemeralConversation({
        projectId: fixture.project.id,
        projectLocalPath: fixture.project.localPath,
        title: 'Graph 临时问答',
        prompt: '不得留下 orphan queue',
        model: 'gpt-5.4',
        idempotencyKey: 'ephemeral-full',
        clientUserMessageId: 'ephemeral-full-client',
      }),
    ).rejects.toMatchObject({ code: 'ZEUS_CODEX_CONCURRENCY_FULL' });

    expect(fixture.conversations.listByProject(fixture.project.id).total).toBe(before);
    expect(fixture.submissions.listRecoverable()).toHaveLength(0);
  });

  it('times out an ephemeral waiter by interrupting and closing durable state, and rejects pending waiters on coordinator close', async () => {
    const fixture = await createFixture();
    const operation = await fixture.coordinator.startEphemeralConversation({
      projectId: fixture.project.id,
      projectLocalPath: fixture.project.localPath,
      title: 'Graph timeout',
      prompt: '等待超时',
      model: 'gpt-5.4',
      idempotencyKey: 'ephemeral-timeout',
      clientUserMessageId: 'ephemeral-timeout-client',
    });
    const timeoutOutcome = await Promise.race([
      fixture.coordinator.waitForTurnResult({ conversationId: operation.conversationId, providerTurnId: operation.providerTurnId!, timeoutMs: 10 }).then(
        () => 'resolved',
        (error: { code?: string }) => error.code ?? 'rejected',
      ),
      new Promise<string>((resolveOutcome) => setTimeout(() => resolveOutcome('still-pending'), 50)),
    ]);
    expect(timeoutOutcome).toBe('ZEUS_CODEX_TURN_RESULT_TIMEOUT');
    expect(fixture.manager.interrupts).toContainEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(fixture.submissions.getById(operation.submissionId)?.status).toBe('cancelled');
    expect(fixture.conversations.getById(operation.conversationId)?.providerState).toBe('closed');

    const secondFixture = await createFixture();
    const second = await secondFixture.coordinator.startEphemeralConversation({
      projectId: secondFixture.project.id,
      projectLocalPath: secondFixture.project.localPath,
      title: 'Graph close',
      prompt: 'close 时拒绝',
      model: 'gpt-5.4',
      idempotencyKey: 'ephemeral-close',
      clientUserMessageId: 'ephemeral-close-client',
    });
    const closed = secondFixture.coordinator.waitForTurnResult({ conversationId: second.conversationId, providerTurnId: second.providerTurnId!, timeoutMs: 10_000 }).then(
      () => 'resolved',
      (error: { code?: string }) => error.code ?? 'rejected',
    );
    const closing = secondFixture.coordinator.close({ mode: 'final' });
    await closing;
    expect(secondFixture.submissions.getById(second.submissionId)).toMatchObject({ status: 'failed' });
    expect(secondFixture.conversations.getById(second.conversationId)?.providerState).toBe('closed');
    expect(secondFixture.manager.interrupts).toContainEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(await Promise.race([closed, new Promise<string>((resolveOutcome) => setTimeout(() => resolveOutcome('still-pending'), 50))])).toBe('ZEUS_CODEX_COORDINATOR_CLOSED');
  });

  it('hands an active ephemeral turn and pending request to a replacement coordinator without terminalizing provider state', async () => {
    const fixture = await createFixture();
    fixture.manager.replayEvents = true;
    const started = await fixture.coordinator.startEphemeralConversation({
      projectId: fixture.project.id,
      projectLocalPath: fixture.project.localPath,
      title: 'Graph restart handoff',
      prompt: 'local-server restart must not cancel this turn',
      model: 'gpt-5.4',
      idempotencyKey: 'ephemeral-handoff',
      clientUserMessageId: 'ephemeral-handoff-client',
    });
    const waiter = fixture.coordinator.waitForTurnResult({ conversationId: started.conversationId, providerTurnId: started.providerTurnId!, timeoutMs: 10_000 }).then(
      () => 'resolved',
      (error: { code?: string }) => error.code ?? 'rejected',
    );

    await fixture.coordinator.close({ mode: 'handoff' });

    await fixture.manager.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'handoff-item', type: 'agentMessage', status: 'completed', text: 'gap output', phase: 'prework' } }, undefined, 119);
    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd' }, 'handoff-request', 120);

    expect(await waiter).toBe('ZEUS_CODEX_SERVER_RESTARTING');
    expect(fixture.submissions.getById(started.submissionId)?.status).toBe('active');
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('active');
    expect(fixture.items.listByConversation(started.conversationId)).toHaveLength(0);
    expect(fixture.requests.getByProvider('generation-1', 'handoff-request')).toBeUndefined();
    expect(fixture.manager.interrupts).toEqual([]);
    expect(fixture.manager.responses).toEqual([]);

    fixture.manager.threadSnapshots.set('thread-1', { id: 'thread-1', turns: [{ id: 'turn-1', status: 'running' }] });
    const replacement = createCodexNativeConversationCoordinator({
      manager: fixture.manager,
      commandPath: '/opt/homebrew/bin/codex',
      db: fixture.db,
      conversations: fixture.conversations,
      turns: fixture.turns,
      items: fixture.items,
      submissions: fixture.submissions,
      requests: fixture.requests,
      settings: fixture.settings,
      getConcurrency: () => ({ project: 0, global: 0, maxPerProject: 1, maxGlobal: 2 }),
      broadcast: () => undefined,
    });
    await replacement.recover();
    const request = fixture.requests.getByProvider('generation-1', 'handoff-request')!;

    expect(fixture.items.listByConversation(started.conversationId)).toContainEqual(expect.objectContaining({ providerItemId: 'handoff-item', textContent: 'gap output' }));
    expect(fixture.requests.getById(request.id)?.status).toBe('pending');
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('waiting');
    await replacement.respondToRequest({ requestId: request.id, response: { type: 'command', decision: 'decline' } });

    expect(fixture.requests.getById(request.id)?.status).toBe('resolved');
    expect(fixture.manager.responses).toContainEqual({
      type: 'command',
      decision: 'decline',
      generationId: 'generation-1',
      requestId: 'handoff-request',
    });
    await replacement.close({ mode: 'final' });
  });

  it('upgrades a completed handoff to final shutdown and settles ephemeral approval, RUI, and MCP state', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startEphemeralConversation({
      projectId: fixture.project.id,
      projectLocalPath: fixture.project.localPath,
      title: 'Graph handoff final upgrade',
      prompt: 'handoff 后应用退出仍须收口',
      model: 'gpt-5.4',
      idempotencyKey: 'ephemeral-handoff-final',
      clientUserMessageId: 'ephemeral-handoff-final-client',
    });
    const waiter = fixture.coordinator.waitForTurnResult({ conversationId: started.conversationId, providerTurnId: started.providerTurnId!, timeoutMs: 10_000 }).then(
      () => 'resolved',
      (error: { code?: string }) => error.code ?? 'rejected',
    );
    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd' }, 'upgrade-command', 121);
    await fixture.manager.emit('item/tool/requestUserInput', canonicalRuiPayload([{ id: 'confirm', header: 'Confirm', question: '继续？', options: null, isOther: false, isSecret: false }], 'upgrade-rui-item'), 'upgrade-rui', 122);
    await fixture.manager.emit(
      'mcpServer/elicitation/request',
      { threadId: 'thread-1', turnId: 'turn-1', serverName: 'test', mode: 'form', message: 'Choose', requestedSchema: { type: 'object', properties: {} }, _meta: null },
      'upgrade-mcp',
      123,
    );

    await fixture.coordinator.close({ mode: 'handoff' });

    expect(await waiter).toBe('ZEUS_CODEX_SERVER_RESTARTING');
    expect(fixture.manager.responses).toEqual([]);
    expect(fixture.manager.interrupts).toEqual([]);
    expect(fixture.submissions.getById(started.submissionId)?.status).toBe('active');

    await fixture.coordinator.close({ mode: 'final' });

    expect(fixture.manager.responses).toContainEqual({
      type: 'command',
      decision: 'cancel',
      generationId: 'generation-1',
      requestId: 'upgrade-command',
    });
    expect(fixture.manager.interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    expect(fixture.requests.getByProvider('generation-1', 'upgrade-command')).toMatchObject({ status: 'resolved' });
    expect(fixture.requests.getByProvider('generation-1', 'upgrade-rui')).toMatchObject({ status: 'failed' });
    expect(fixture.requests.getByProvider('generation-1', 'upgrade-mcp')).toMatchObject({ status: 'failed' });
    expect(fixture.submissions.getById(started.submissionId)?.status).toBe('failed');
    expect(fixture.conversations.getById(started.conversationId)?.providerState).toBe('closed');
  });

  it('drains every provider event accepted before handoff before crossing the persistence boundary', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const firstSaveEntered = deferred<void>();
    const releaseFirstSave = deferred<void>();
    const originalSave = fixture.db.save.bind(fixture.db);
    let saveCount = 0;
    let handoffSettled = false;
    const savesAfterHandoff: number[] = [];
    const saveSpy = vi.spyOn(fixture.db, 'save').mockImplementation(async () => {
      const call = ++saveCount;
      if (call === 1) {
        firstSaveEntered.resolve(undefined);
        await releaseFirstSave.promise;
      }
      if (handoffSettled) savesAfterHandoff.push(call);
      await originalSave();
    });

    const firstEvent = fixture.manager.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'drain-first', type: 'agentMessage', status: 'completed', text: 'first', phase: 'prework' } }, undefined, 124);
    await firstSaveEntered.promise;
    const secondEvent = fixture.manager.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'drain-second', type: 'agentMessage', status: 'completed', text: 'second', phase: 'prework' } }, undefined, 125);
    const handoff = fixture.coordinator.close({ mode: 'handoff' }).then(() => {
      handoffSettled = true;
    });
    await Promise.resolve();
    expect(handoffSettled).toBe(false);

    releaseFirstSave.resolve(undefined);
    await Promise.all([firstEvent, secondEvent, handoff]);

    expect(saveCount).toBe(2);
    expect(savesAfterHandoff).toEqual([]);
    expect(fixture.items.listByConversation(started.conversationId)).toContainEqual(expect.objectContaining({ providerItemId: 'drain-second', textContent: 'second' }));
    expect(fixture.broadcasts).toContainEqual(expect.objectContaining({ type: 'conversation.item.updated', payload: expect.objectContaining({ providerItemId: 'drain-second', sequence: 125 }) }));
    const disk = await createZeusDatabase(fixture.dbPath);
    expect(new ConversationItemRepository(disk).listByConversation(started.conversationId)).toContainEqual(expect.objectContaining({ providerItemId: 'drain-second', textContent: 'second' }));
    saveSpy.mockRestore();
    await fixture.coordinator.close({ mode: 'final' });
  });

  it('closes a newly created coordinator when startup recovery rejects before listen', async () => {
    const fixture = await createFixture();
    await fixture.coordinator.startTaskConversation(startInput(fixture));
    await fixture.coordinator.close({ mode: 'handoff' });
    const recoverError = new Error('startup recovery failed');
    let closeMode: { mode: 'handoff' | 'final' } | undefined;
    const coordinatorFactory = vi.fn((options: Parameters<typeof createCodexNativeConversationCoordinator>[0]) => {
      const runtime = createCodexNativeConversationCoordinator(options);
      return {
        ...runtime,
        recover: vi.fn(async () => {
          throw recoverError;
        }),
        close: vi.fn(async (input?: { mode: 'handoff' | 'final' }) => {
          closeMode = input;
          await runtime.close(input);
        }),
      };
    });
    let running: Awaited<ReturnType<typeof startZeusLocalServer>> | undefined;
    let failure: unknown;

    try {
      running = await startZeusLocalServer({
        dbPath: fixture.dbPath,
        apiToken: 'token',
        projectRoot: fixture.project.localPath,
        codexAppServerManager: fixture.manager,
        codexNativeCoordinatorFactory: coordinatorFactory,
      });
    } catch (error) {
      failure = error;
    }
    await running?.close();

    expect(failure).toBe(recoverError);
    expect(hasCodexFinalizationOwnershipClaim(failure)).toBe(true);
    expect(coordinatorFactory).toHaveBeenCalledTimes(1);
    expect(closeMode).toEqual({ mode: 'final' });
    expect(fixture.manager.listenerCount).toBe(0);
  });

  it('preserves a synchronous coordinator factory failure without leaving a manager subscription', async () => {
    const fixture = await createFixture();
    await fixture.coordinator.close({ mode: 'handoff' });
    const factoryError = new Error('coordinator factory failed');

    let failure: unknown;
    try {
      await startZeusLocalServer({
        dbPath: fixture.dbPath,
        apiToken: 'token',
        projectRoot: fixture.project.localPath,
        codexAppServerManager: fixture.manager,
        codexNativeCoordinatorFactory: () => {
          throw factoryError;
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(factoryError);
    expect(hasCodexFinalizationOwnershipClaim(failure)).toBe(false);
    expect(fixture.manager.listenerCount).toBe(0);
  });

  it('closes an ephemeral conversation and reports a distinct provider dispatch failure', async () => {
    const fixture = await createFixture();
    fixture.manager.startTurnFailure = Object.assign(new Error('turn start failed'), { code: 'PROVIDER_FAILURE' });
    await expect(
      fixture.coordinator.startEphemeralConversation({
        projectId: fixture.project.id,
        projectLocalPath: fixture.project.localPath,
        title: 'Graph failure',
        prompt: 'provider failure cleanup',
        model: 'gpt-5.4',
        idempotencyKey: 'ephemeral-failure',
        clientUserMessageId: 'ephemeral-failure-client',
      }),
    ).rejects.toMatchObject({ code: 'ZEUS_CODEX_EPHEMERAL_DISPATCH_FAILED', message: expect.stringContaining('provider') });

    const failedConversation = fixture.conversations.listByProject(fixture.project.id).items.at(-1)!;
    const failedSubmission = fixture.submissions.listByConversation(failedConversation.id).at(-1)!;
    expect(failedSubmission.status).toBe('failed');
    expect(failedConversation.providerState).toBe('closed');
  });

  it('isolates malformed provider events as typed native errors and continues processing later events without rejection', async () => {
    const fixture = await createFixture();
    const started = await fixture.coordinator.startTaskConversation(startInput(fixture));

    await expect(fixture.manager.emit('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { inputTokens: -1, outputTokens: 2, totalTokens: 1 } }, undefined, 70)).resolves.toBeUndefined();
    expect(fixture.items.listByConversation(started.conversationId)).toEqual(expect.arrayContaining([expect.objectContaining({ itemType: 'error', status: 'failed', providerTurnId: 'turn-1' })]));
    expect(fixture.broadcasts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'conversation.native.error' })]));

    await expect(fixture.manager.emit('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }, undefined, 71)).resolves.toBeUndefined();
    expect(fixture.conversations.getProviderTokenUsageSnapshot(started.conversationId)).toMatchObject({ sequence: 71, totalTokens: 5 });
  });

  it('continues recovery after one bound provider thread fails and preserves the healthy thread state', async () => {
    const fixture = await createFixture({ concurrency: { project: 0, global: 0, maxPerProject: 2, maxGlobal: 2 } });
    const failed = await fixture.coordinator.startTaskConversation(startInput(fixture));
    const healthy = await fixture.coordinator.startTaskConversation(startInput(fixture, { taskTitle: 'healthy', prompt: 'healthy thread', idempotencyKey: 'healthy-thread', clientUserMessageId: 'healthy-thread-client' }));
    await fixture.coordinator.close({ mode: 'handoff' });
    fixture.manager.readFailures.add('thread-1');
    fixture.manager.threadSnapshots.set('thread-2', { id: 'thread-2', turns: [{ id: 'turn-2', status: 'running' }] });
    fixture.manager.state = { ...fixture.manager.state, generationId: 'generation-2' } as CodexTransportState;
    const recovered = createCodexNativeConversationCoordinator({
      manager: fixture.manager,
      commandPath: '/opt/homebrew/bin/codex',
      db: fixture.db,
      conversations: fixture.conversations,
      turns: fixture.turns,
      items: fixture.items,
      submissions: fixture.submissions,
      requests: fixture.requests,
      settings: fixture.settings,
      getConcurrency: () => ({ project: 0, global: 0, maxPerProject: 2, maxGlobal: 2 }),
      broadcast: () => undefined,
    });

    await expect(recovered.recover()).resolves.toBeUndefined();
    expect(fixture.submissions.getById(failed.submissionId)).toMatchObject({ status: 'paused', pausedReason: 'recovery_required' });
    expect(fixture.submissions.getById(healthy.submissionId)).toMatchObject({ status: 'active', providerTurnId: 'turn-2' });
    expect(fixture.manager.reads).toEqual(expect.arrayContaining(['thread-1', 'thread-2']));
    await recovered.close({ mode: 'final' });
  });

  it('enforces task sandbox, Git approval, permission subsets, unknown-schema interrupt, and secret RUI redaction', async () => {
    const fixture = await createFixture();
    await fixture.coordinator.startTaskConversation(startInput(fixture));
    expect(fixture.manager.threadStarts[0]?.sandbox).toEqual({ type: 'workspaceWrite', writableRoots: [fixture.project.localPath], networkAccess: false });
    expect(fixture.manager.threadStarts[0]?.developerInstructions).toContain('不得执行 git commit');

    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: 'git commit -am forbidden' }, 'git-request', 10);
    const gitRequest = fixture.requests.getByProvider('generation-1', 'git-request')!;
    await fixture.coordinator.respondToRequest({ requestId: gitRequest.id, response: { type: 'command', decision: 'accept' } });
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'decline' });

    await fixture.manager.emit(
      'item/permissions/requestApproval',
      { threadId: 'thread-1', turnId: 'turn-1', permissions: { network: { enabled: false }, fileSystem: { read: [fixture.project.localPath], write: [fixture.project.localPath] } } },
      'permission-request',
      11,
    );
    const permissionRequest = fixture.requests.getByProvider('generation-1', 'permission-request')!;
    await fixture.coordinator.respondToRequest({
      requestId: permissionRequest.id,
      response: { type: 'permissions', permissions: { network: { enabled: false }, fileSystem: { read: [fixture.project.localPath], write: [fixture.project.localPath] } }, scope: 'turn' },
    });
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'permissions', permissions: { fileSystem: { write: [fixture.project.localPath] } } });

    await fixture.manager.emit('item/permissions/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', permissions: { fileSystem: { entries: [{ path: fixture.project.localPath, access: 'write' }] } } }, 'unknown-schema', 12);
    const unknownRequest = fixture.requests.getByProvider('generation-1', 'unknown-schema')!;
    await expect(fixture.coordinator.respondToRequest({ requestId: unknownRequest.id, response: { type: 'permissions', permissions: { fileSystem: { read: null, write: null } }, scope: 'turn' } })).rejects.toMatchObject({
      code: 'ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED',
    });
    expect(fixture.manager.interrupts.at(-1)).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });

    const secret = 'SECRET-RUI-NEVER-PERSIST';
    await fixture.manager.emit('item/tool/requestUserInput', canonicalRuiPayload([{ id: 'token', header: 'Token', question: '请输入', options: null, isOther: false, isSecret: true }], 'rui-request-item'), 'rui-request', 13);
    const ruiRequest = fixture.requests.getByProvider('generation-1', 'rui-request')!;
    await fixture.coordinator.respondToRequest({ requestId: ruiRequest.id, response: { type: 'request_user_input', answers: { token: { answers: [secret] } } } });
    const dump = JSON.stringify(fixture.db.listTableNames().flatMap((table) => fixture.db.select<Record<string, unknown>>(`SELECT * FROM "${table}"`)));
    expect(dump).not.toContain(secret);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'request_user_input', answers: { token: { answers: [secret] } } });
  });
});
