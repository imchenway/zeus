import { copyFile, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiRuntimeProcessHandle,
  AiRuntimeSpawn,
  CodexAppServerEvent,
  CodexAppServerManager,
  CodexServerRequestResponse,
  CodexThreadStartInput,
  CodexTransportState,
  CodexTurnStartInput,
  CodexTurnSteerInput,
  ExternalAgentConfigDetectParams,
  ExternalAgentConfigImportParams,
  ExternalAgentImportEvent,
} from '@zeus/ai-runtime';
import { ConversationRepository, ConversationSubmissionRepository, createZeusDatabase, ProjectRepository, RuntimeSessionRepository, TaskEventRepository, TaskRepository, ZeusDatabase } from '@zeus/storage';
import { createLocalServer } from '../src/index.js';

class FakeCodexManager implements CodexAppServerManager {
  readonly threadStarts: CodexThreadStartInput[] = [];
  readonly turnStarts: CodexTurnStartInput[] = [];
  readonly steers: CodexTurnSteerInput[] = [];
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly responses: CodexServerRequestResponse[] = [];
  readonly resumes: string[] = [];
  readonly reads: string[] = [];
  readonly readinessInputs: Array<{ commandPath: string; externalAgentHome?: string }> = [];
  readonly externalDetects: ExternalAgentConfigDetectParams[] = [];
  readonly externalImports: ExternalAgentConfigImportParams[] = [];
  readonly threadSnapshots = new Map<string, Record<string, unknown>>();
  private readonly listeners = new Set<(event: CodexAppServerEvent) => unknown>();
  private readonly externalImportListeners = new Set<(event: ExternalAgentImportEvent) => void>();
  private threadSequence = 0;
  private turnSequence = 0;
  state: CodexTransportState = {
    type: 'ready',
    generationId: 'generation-api',
    capabilities: {
      generationId: 'generation-api',
      initializedAt: '2026-07-13T06:00:00.000Z',
      models: [
        {
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          supportedReasoningEfforts: ['medium', 'high'],
          defaultReasoningEffort: 'medium',
          raw: {},
        },
      ],
      supportedModels: ['gpt-5.4'],
    },
  };

  async ensureReady(input: { commandPath: string; externalAgentHome?: string }) {
    this.readinessInputs.push(input);
    if (this.state.type !== 'ready') throw new Error('transport unavailable');
    return { ...this.state.capabilities, generationId: this.state.generationId };
  }

  async startThread(input: CodexThreadStartInput) {
    this.threadStarts.push(input);
    return { id: `thread-${++this.threadSequence}`, turns: [] };
  }

  async resumeThread(input: { threadId: string }) {
    this.resumes.push(input.threadId);
    return (this.threadSnapshots.get(input.threadId) ?? { id: input.threadId, turns: [] }) as { id: string; turns: unknown[] };
  }

  async readThread(input: { threadId: string }) {
    this.reads.push(input.threadId);
    return (this.threadSnapshots.get(input.threadId) ?? { id: input.threadId, turns: [] }) as { id: string; turns: unknown[] };
  }

  async startTurn(input: CodexTurnStartInput) {
    this.turnStarts.push(input);
    return { id: `turn-${++this.turnSequence}`, threadId: input.threadId, items: [] };
  }

  async steerTurn(input: CodexTurnSteerInput) {
    this.steers.push(input);
    return { turnId: input.turnId };
  }

  async interruptTurn(input: { threadId: string; turnId: string }) {
    this.interrupts.push(input);
  }

  async respondToServerRequest(input: CodexServerRequestResponse) {
    this.responses.push(input);
  }

  async detectExternalAgentConfig(input: ExternalAgentConfigDetectParams = {}) {
    this.externalDetects.push(input);
    return { items: [] };
  }

  async startExternalAgentImport(input: ExternalAgentConfigImportParams) {
    this.externalImports.push(input);
    return { importId: 'provider-legacy-import-1' };
  }

  async readExternalAgentImportHistories() {
    return [];
  }

  subscribeExternalAgentImport(listener: (event: ExternalAgentImportEvent) => void) {
    this.externalImportListeners.add(listener);
    return () => this.externalImportListeners.delete(listener);
  }

  subscribe(listener: (event: CodexAppServerEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState() {
    return this.state;
  }

  async prepareForShutdown() {}
  async close() {}

  async emit(method: string, params: unknown, requestId?: string | number, sequence = 1, generationId?: string) {
    const event: CodexAppServerEvent = {
      generationId: generationId ?? (this.state.type === 'ready' ? this.state.generationId : 'generation-api'),
      sequence,
      method,
      params,
      receivedAt: `2026-07-13T06:00:${String(sequence).padStart(2, '0')}.000Z`,
      ...(requestId === undefined ? {} : { requestId }),
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }

  async emitExternalImport(event: ExternalAgentImportEvent) {
    for (const listener of this.externalImportListeners) listener(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createApiFixture(manager: FakeCodexManager = new FakeCodexManager()) {
  const directory = await mkdtemp(join(tmpdir(), 'zeus-native-api-'));
  const taskAttachmentRoot = await mkdtemp(join(tmpdir(), 'zeus-native-task-attachments-'));
  cleanup.push(directory, taskAttachmentRoot);
  const server = await createLocalServer({
    dbPath: join(directory, 'zeus.db'),
    apiToken: 'native-api-token',
    projectRoot: directory,
    taskAttachmentRoot,
    codexAppServerManager: manager,
  });
  const headers = { authorization: 'Bearer native-api-token' };
  const project = (
    await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'Native API', localPath: directory },
    })
  ).json();
  const task = (
    await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers,
      payload: {
        projectId: project.id,
        title: '原生会话 API',
        description: '验证显式选择与 durable acceptance',
        allowCodeChanges: true,
        allowTests: true,
        allowGitCommit: false,
      },
    })
  ).json();
  return { directory, taskAttachmentRoot, manager, server, headers, project, task };
}

function createControlledRuntimeSpawn(inputs?: string[]): AiRuntimeSpawn {
  return () => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 13_705,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        return handle;
      },
      kill() {
        callbacks.get('exit')?.forEach((callback) => callback(143));
      },
      ...(inputs
        ? {
            write(input: string) {
              inputs.push(input);
            },
          }
        : {}),
    };
    return handle;
  };
}

async function setRuntimeAdapter(fixture: Awaited<ReturnType<typeof createApiFixture>>, defaultAdapterId: 'codex' | 'claude') {
  return fixture.server.inject({
    method: 'PUT',
    url: '/api/runtime/settings',
    headers: fixture.headers,
    payload: {
      defaultAdapterId,
      adapterModels: {},
      adapterDefaultArgs: {},
      adapterCliPaths: {},
      terminalEnv: {},
      shell: { path: null, login: false },
      concurrency: { maxPerProject: 4, maxGlobal: 4 },
      executionTimeoutSeconds: 3600,
      logRetentionDays: 30,
      autoConfirmationPolicy: 'never',
    },
  });
}

describe('Codex native conversation REST API', () => {
  it('creates and lists a persistent project conversation without creating or mutating official tasks', async () => {
    const fixture = await createApiFixture();
    const attachmentPath = join(fixture.directory, 'project-conversation-context.txt');
    await writeFile(attachmentPath, 'project conversation evidence');
    const canonicalAttachmentPath = await realpath(attachmentPath);
    const before = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    const taskCountBefore = before.countRows('tasks');
    const taskEventCountBefore = before.countRows('task_events');

    const emptyChoices = await fixture.server.inject({
      method: 'GET',
      url: `/api/projects/${fixture.project.id}/conversation-choices`,
      headers: fixture.headers,
    });
    expect(emptyChoices.statusCode).toBe(200);
    expect(emptyChoices.json()).toEqual({ projectId: fixture.project.id, choices: [], items: [] });

    const requestBody = {
      mode: 'create',
      content: '\n   项目   自由 对话   \n第二行保持原文',
      attachments: [{ name: 'context.txt', mime: 'text/plain', size: 29, localPath: attachmentPath }],
      permissionMode: 'auto',
      clientUserMessageId: 'project-conversation-client-message',
    };
    const created = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'project-conversation-create' },
      payload: requestBody,
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({
      operation: { status: 'accepted', idempotencyKey: 'project-conversation-create' },
      conversation: {
        projectId: fixture.project.id,
        taskId: null,
        title: '项目 自由 对话',
        summary: requestBody.content.slice(0, 240),
        transportKind: 'codex_native',
      },
      submission: {
        content: requestBody.content,
        attachments: [expect.objectContaining({ name: 'context.txt', localPath: canonicalAttachmentPath })],
      },
    });
    expect(fixture.manager.threadStarts).toHaveLength(1);

    const replay = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'project-conversation-create' },
      payload: requestBody,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(created.json());
    expect(fixture.manager.threadStarts).toHaveLength(1);

    const conflict = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'project-conversation-create' },
      payload: { ...requestBody, content: '同 key 不同正文' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'ZEUS_IDEMPOTENCY_CONFLICT' });

    const choices = await fixture.server.inject({
      method: 'GET',
      url: `/api/projects/${fixture.project.id}/conversation-choices`,
      headers: fixture.headers,
    });
    expect(choices.statusCode).toBe(200);
    expect(choices.json()).toMatchObject({
      projectId: fixture.project.id,
      choices: [{ id: created.json().conversation.id, taskId: null, title: '项目 自由 对话', resumable: true }],
    });

    const taskChoices = await fixture.server.inject({ method: 'GET', url: `/api/tasks/${fixture.task.id}/conversation-choices`, headers: fixture.headers });
    expect(taskChoices.json().choices).toEqual([]);
    const after = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    expect(after.countRows('tasks')).toBe(taskCountBefore);
    expect(after.countRows('task_events')).toBe(taskEventCountBefore);
    expect(after.get<{ task_id: string | null }>('SELECT task_id FROM conversations WHERE id = ?', [created.json().conversation.id])?.task_id).toBeNull();
    await fixture.server.close();
  });

  it.each([
    [{ mode: 'create', content: '   ', permissionMode: 'auto' }, 'ZEUS_INVALID_CONVERSATION_START'],
    [{ mode: 'create', content: '项目消息', permissionMode: 'unsafe' }, 'ZEUS_INVALID_PERMISSION_MODE'],
    [{ mode: 'resume', content: '不能续接' }, 'ZEUS_INVALID_CONVERSATION_START'],
  ])('rejects invalid project conversation input without creating a task: %j', async (payload, errorCode) => {
    const fixture = await createApiFixture();
    const response = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': `invalid-project-conversation-${errorCode}-${JSON.stringify(payload)}` },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: errorCode });
    const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM conversations WHERE task_id IS NULL')?.count).toBe(0);
    await fixture.server.close();
  });

  it('rejects missing projects and attachments outside the selected project boundary', async () => {
    const fixture = await createApiFixture();
    const missingProject = await fixture.server.inject({
      method: 'POST',
      url: '/api/projects/project-missing/conversations',
      headers: { ...fixture.headers, 'idempotency-key': 'missing-project-conversation' },
      payload: { mode: 'create', content: '不能创建' },
    });
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json()).toMatchObject({ error: 'ZEUS_PROJECT_NOT_FOUND' });

    const outsideDirectory = await mkdtemp(join(tmpdir(), 'zeus-project-attachment-outside-'));
    cleanup.push(outsideDirectory);
    const outsidePath = join(outsideDirectory, 'outside.txt');
    await writeFile(outsidePath, 'outside project');
    const outsideAttachment = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'outside-project-attachment' },
      payload: {
        mode: 'create',
        content: '附件边界',
        attachments: [{ name: 'outside.txt', mime: 'text/plain', size: 15, localPath: outsidePath }],
        permissionMode: 'auto',
      },
    });
    expect(outsideAttachment.statusCode).toBe(400);
    expect(outsideAttachment.json()).toMatchObject({ error: 'ZEUS_INVALID_CONVERSATION_ATTACHMENT' });
    await fixture.server.close();
  });

  it('loads composer capabilities without creating a thread, then pushes canonical task content and managed attachments with explicit settings', async () => {
    const fixture = await createApiFixture();
    const managedImagePath = join(fixture.taskAttachmentRoot, 'task-evidence.png');
    const managedFilePath = join(fixture.taskAttachmentRoot, 'task-notes.md');
    await writeFile(managedImagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    await writeFile(managedFilePath, '# task evidence');
    const pushTask = (
      await fixture.server.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: fixture.headers,
        payload: {
          projectId: fixture.project.id,
          title: '验证推送到模型',
          description: '必须组装真实任务内容并携带全部附件',
          sourceContext: {
            type: 'manual',
            attachments: [
              { path: managedImagePath, name: 'task-evidence.png', kind: 'image', mimeType: 'image/png' },
              { path: managedFilePath, name: 'task-notes.md', kind: 'file', mimeType: 'text/markdown' },
            ],
          },
        },
      })
    ).json();

    const capabilities = await fixture.server.inject({
      method: 'GET',
      url: `/api/projects/${fixture.project.id}/codex-task-push-capabilities`,
      headers: fixture.headers,
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      projectId: fixture.project.id,
      preferredModel: 'gpt-5.4',
      models: [{ model: 'gpt-5.4', supportedReasoningEfforts: ['medium', 'high'], defaultReasoningEffort: 'medium' }],
    });
    expect(fixture.manager.threadStarts).toHaveLength(0);
    expect(fixture.manager.turnStarts).toHaveLength(0);

    const pushed = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${pushTask.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'task-model-push-success' },
      payload: {
        mode: 'create',
        source: 'task_push',
        model: 'gpt-5.4',
        effort: 'high',
        workMode: 'plan',
        permissionMode: 'read-only',
        supplementalInfo: '本次优先核对附件证据。',
        clientUserMessageId: 'task-model-push-client',
      },
    });

    expect(pushed.statusCode).toBe(202);
    expect(pushed.json()).toMatchObject({
      operation: { status: 'accepted', idempotencyKey: 'task-model-push-success' },
      conversation: { taskId: pushTask.id, providerThreadId: 'thread-1', permissionMode: 'read-only' },
      submission: { status: 'active' },
    });
    expect(fixture.manager.threadStarts).toHaveLength(1);
    expect(fixture.manager.threadStarts[0]).toMatchObject({ model: 'gpt-5.4', sandbox: { type: 'readOnly' }, developerInstructions: '' });
    expect(fixture.manager.turnStarts[0]).toMatchObject({
      model: 'gpt-5.4',
      effort: 'high',
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.4', reasoning_effort: 'high' } },
    });
    expect(fixture.manager.turnStarts[0]?.input).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('验证推送到模型') }),
      { type: 'localImage', path: await realpath(managedImagePath) },
      { type: 'mention', name: 'task-notes.md', path: await realpath(managedFilePath) },
    ]);
    expect(fixture.manager.turnStarts[0]?.input[0]).toMatchObject({ text: expect.stringContaining('## 本次推送补充信息\n本次优先核对附件证据。') });
    const refreshedTask = await fixture.server.inject({ method: 'GET', url: `/api/tasks/${pushTask.id}`, headers: fixture.headers });
    expect(refreshedTask.json()).toMatchObject({ status: 'running' });
    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 1);
    const taskAfterModelCompletion = await fixture.server.inject({ method: 'GET', url: `/api/tasks/${pushTask.id}`, headers: fixture.headers });
    expect(taskAfterModelCompletion.json()).toMatchObject({ status: 'running' });
    await fixture.server.close();
  });

  it('fails the whole task push before thread creation when any canonical task attachment is unavailable', async () => {
    const fixture = await createApiFixture();
    const missingPath = join(fixture.taskAttachmentRoot, 'missing-evidence.pdf');
    const damagedImagePath = join(fixture.taskAttachmentRoot, 'damaged-image.png');
    await writeFile(damagedImagePath, 'not a decodable PNG');
    const pushTask = (
      await fixture.server.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: fixture.headers,
        payload: {
          projectId: fixture.project.id,
          title: '附件缺失任务',
          description: '不得部分发送',
          sourceContext: {
            attachments: [
              { path: missingPath, name: 'missing-evidence.pdf', kind: 'file', mimeType: 'application/pdf' },
              { path: damagedImagePath, name: 'damaged-image.png', kind: 'image', mimeType: 'image/png' },
            ],
          },
        },
      })
    ).json();
    const pushed = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${pushTask.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'task-model-push-missing-attachment' },
      payload: { mode: 'create', source: 'task_push', model: 'gpt-5.4', effort: 'medium', workMode: 'default', permissionMode: 'read-only' },
    });
    expect(pushed.statusCode).toBe(409);
    expect(pushed.json()).toMatchObject({ error: 'ZEUS_TASK_PUSH_ATTACHMENT_UNAVAILABLE' });
    expect(pushed.json().message).toContain('missing-evidence.pdf');
    expect(pushed.json().message).toContain('damaged-image.png');
    expect(fixture.manager.threadStarts).toHaveLength(0);
    expect(fixture.manager.turnStarts).toHaveLength(0);
    const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM conversations WHERE task_id = ?', [pushTask.id])?.count).toBe(0);
    await fixture.server.close();
  });

  it('preserves and exposes the real thread while marking the task failed when the first turn start fails', async () => {
    class FirstTurnFailureManager extends FakeCodexManager {
      override async startTurn(input: CodexTurnStartInput) {
        await super.startTurn(input);
        throw Object.assign(new Error('first turn failed'), { code: 'PROVIDER_FIRST_TURN_FAILED' });
      }
    }
    const fixture = await createApiFixture(new FirstTurnFailureManager());
    const pushed = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'task-model-push-first-turn-failure' },
      payload: { mode: 'create', source: 'task_push', model: 'gpt-5.4', effort: 'medium', workMode: 'default', permissionMode: 'read-only' },
    });
    expect(pushed.statusCode).toBe(202);
    expect(pushed.json()).toMatchObject({
      operation: { status: 'accepted' },
      conversation: { providerThreadId: 'thread-1' },
      submission: { status: 'paused', pausedReason: 'recovery_required' },
    });
    const refreshedTask = await fixture.server.inject({ method: 'GET', url: `/api/tasks/${fixture.task.id}`, headers: fixture.headers });
    expect(refreshedTask.json()).toMatchObject({ status: 'failed' });
    const choices = await fixture.server.inject({ method: 'GET', url: `/api/tasks/${fixture.task.id}/conversation-choices`, headers: fixture.headers });
    expect(choices.json().choices).toEqual([expect.objectContaining({ id: pushed.json().conversation.id, providerThreadId: 'thread-1', transportKind: 'codex_native' })]);
    await fixture.server.close();
  });

  it('shares one project acceptance across concurrent identical requests', async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    class DeferredProjectTurnManager extends FakeCodexManager {
      override async startTurn(input: CodexTurnStartInput) {
        const turn = super.startTurn(input);
        await turnGate;
        return turn;
      }
    }
    const manager = new DeferredProjectTurnManager();
    const fixture = await createApiFixture(manager);
    const request = {
      method: 'POST' as const,
      url: `/api/projects/${fixture.project.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'concurrent-project-create' },
      payload: { mode: 'create', content: '并发项目会话只接收一次', permissionMode: 'auto' },
    };
    const first = fixture.server.inject(request);
    while (manager.turnStarts.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = fixture.server.inject(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.threadStarts).toHaveLength(1);
    releaseTurn();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(manager.threadStarts).toHaveLength(1);
    await fixture.server.close();
  });

  it('replays a project durable acceptance after restart without repeating provider writes', async () => {
    const fixture = await createApiFixture();
    const requestBody = { mode: 'create', content: '项目 acceptance 重启恢复', permissionMode: 'auto' };
    const first = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'project-restart-acceptance' },
      payload: requestBody,
    });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();
    await fixture.server.close();

    const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    db.execute(`UPDATE idempotency_requests SET status = 'in_progress' WHERE scope = ? AND idempotency_key = ?`, [`project-conversation:${fixture.project.id}`, 'project-restart-acceptance']);
    await db.save();
    const replacementManager = new FakeCodexManager();
    const replacement = await createLocalServer({
      dbPath: join(fixture.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: fixture.directory,
      codexAppServerManager: replacementManager,
    });
    const replay = await replacement.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'project-restart-acceptance' },
      payload: requestBody,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(firstBody);
    expect(replacementManager.threadStarts).toEqual([]);
    expect(replacementManager.turnStarts).toEqual([]);
    await replacement.close();
  });

  it('uses the bundled native runtime identity while resolving the default model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeus-native-bundled-model-path-api-'));
    cleanup.push(directory);
    const dbPath = join(directory, 'zeus.db');
    const db = await createZeusDatabase(dbPath);
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const project = projects.create({ name: 'Bundled runtime model path', localPath: directory });
    const task = tasks.create({
      projectId: project.id,
      title: '使用随包 runtime 新建会话',
      description: '未配置 model 时仍应复用随包 runtime 查询 capability',
      createdFrom: 'user',
      sourceContext: { path: directory },
      allowCodeChanges: true,
      allowTests: true,
      allowGitCommit: false,
    });
    await db.save();
    const manager = new FakeCodexManager();
    const bundledCommandPath = '/Applications/Zeus.app/Contents/Resources/codex/codex';
    const legacyImportRoot = join(directory, 'codex-legacy-import');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'native-api-token',
      projectRoot: directory,
      codexAppServerManager: manager,
      codexRuntimeCommandPath: bundledCommandPath,
      codexLegacyImportRoot: legacyImportRoot,
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/conversations`,
      headers: { authorization: 'Bearer native-api-token', 'idempotency-key': 'bundled-model-path-create' },
      payload: { mode: 'create', content: '创建 native 会话' },
    });

    expect(response.statusCode).toBe(202);
    expect(manager.readinessInputs.length).toBeGreaterThan(0);
    expect(manager.readinessInputs.every((input) => input.commandPath === bundledCommandPath)).toBe(true);
    const canonicalLegacyImportRoot = await realpath(legacyImportRoot);
    expect(manager.readinessInputs.every((input) => input.externalAgentHome === canonicalLegacyImportRoot)).toBe(true);
    await server.close();
  });

  it('exposes explicit legacy import APIs while keeping the bundled native runtime path immutable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeus-native-legacy-import-settings-api-'));
    cleanup.push(directory);
    const dbPath = join(directory, 'zeus.db');
    const db = await createZeusDatabase(dbPath);
    const projects = new ProjectRepository(db);
    const conversations = new ConversationRepository(db);
    const project = projects.create({ name: 'Legacy settings import', localPath: directory });
    const legacy = conversations.create({ projectId: project.id, title: '历史会话', transportKind: 'legacy_cli' });
    conversations.appendMessage({ conversationId: legacy.id, role: 'user', content: '历史问题', source: 'task_prompt', metadata: {}, createdAt: '2026-07-14T00:00:00.000Z' });
    await db.save();
    const manager = new FakeCodexManager();
    const server = await createLocalServer({
      dbPath,
      apiToken: 'native-api-token',
      projectRoot: directory,
      codexAppServerManager: manager,
      codexRuntimeCommandPath: '/Applications/Zeus.app/Contents/Resources/codex/codex',
      codexLegacyImportRoot: join(directory, 'codex-legacy-import'),
    });
    const headers = { authorization: 'Bearer native-api-token' };

    const detected = await server.inject({ method: 'GET', url: '/api/codex-native/import', headers });
    expect(detected.statusCode).toBe(200);
    expect(detected.json().eligible).toEqual([expect.objectContaining({ sourceConversationId: legacy.id, title: '历史会话' })]);
    const duplicate = await server.inject({ method: 'POST', url: '/api/codex-native/import', headers, payload: { sourceConversationIds: [legacy.id, legacy.id] } });
    expect(duplicate.statusCode).toBe(400);

    const started = await server.inject({ method: 'POST', url: '/api/codex-native/import', headers, payload: { sourceConversationIds: [legacy.id] } });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ importId: 'provider-legacy-import-1', status: 'waiting' });
    expect(manager.externalDetects.at(-1)).toEqual({ includeHome: true, cwds: [await realpath(directory)] });
    expect(manager.readinessInputs.every((input) => input.commandPath === '/Applications/Zeus.app/Contents/Resources/codex/codex')).toBe(true);
    expect(manager.externalImports[0]).toMatchObject({ source: 'zeus-legacy', migrationItems: [{ itemType: 'SESSIONS' }] });
    const sourcePath = (manager.externalImports[0]?.migrationItems[0]?.details?.sessions as Array<{ path: string }>)[0]!.path;

    await manager.emitExternalImport({
      type: 'completed',
      generationId: 'generation-api',
      importId: 'provider-legacy-import-1',
      itemTypeResults: [{ itemType: 'SESSIONS', successes: [{ itemType: 'SESSIONS', cwd: await realpath(directory), source: sourcePath, target: 'thread-imported-api' }], failures: [] }],
    });
    const completed = await server.inject({ method: 'GET', url: '/api/codex-native/import/provider-legacy-import-1', headers });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ importId: 'provider-legacy-import-1', status: 'completed', runs: [{ sourceConversationId: legacy.id, targetThreadId: 'thread-imported-api' }] });
    await server.close();
  });

  it('imports legacy Codex threads as resumable native choices and starts the next turn on the selected thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeus-native-legacy-import-api-'));
    cleanup.push(directory);
    const dbPath = join(directory, 'zeus.db');
    const db = await createZeusDatabase(dbPath);
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const conversations = new ConversationRepository(db);
    const runtimeSessions = new RuntimeSessionRepository(db);
    const taskEvents = new TaskEventRepository(db);
    const project = projects.create({ name: 'Legacy import API', localPath: directory });
    const task = tasks.create({
      projectId: project.id,
      title: '恢复旧 Codex 会话',
      description: '将两个真实 provider thread 拆分为 native conversation',
      createdFrom: 'user',
      sourceContext: { path: directory },
      allowCodeChanges: true,
      allowTests: true,
      allowGitCommit: false,
    });
    const legacy = conversations.create({
      projectId: project.id,
      taskId: task.id,
      title: `任务会话：${task.title}`,
      summary: '旧聚合记录',
      status: 'exited',
      transportKind: 'legacy_cli',
    });
    const threadIds = ['019f461b-9a85-7983-9779-e4bd0fff6676', '019f463f-5e6f-75c0-b168-34b375e54be2'];
    for (const [index, threadId] of threadIds.entries()) {
      const runtimeSessionId = `ai-session-import-${index + 1}`;
      runtimeSessions.create({
        id: runtimeSessionId,
        projectId: project.id,
        taskId: task.id,
        command: 'codex',
        args: ['exec', `旧提示 ${index + 1}`],
        cwd: directory,
        status: 'exited',
        startedAt: `2026-07-09T09:0${index}:00.000Z`,
      });
      runtimeSessions.appendLog({
        id: `runtime-log-import-${index + 1}`,
        sessionId: runtimeSessionId,
        stream: 'stdout',
        text: `OpenAI Codex v0.142.5\nmodel: gpt-5.5\nsession id: ${threadId}`,
        createdAt: `2026-07-09T09:0${index}:01.000Z`,
      });
      taskEvents.create({
        taskId: task.id,
        eventType: index === 0 ? 'task.runtime.continue' : 'task.runtime.reconnect',
        title: '旧 Codex Runtime',
        payload: { runtimeSessionId, conversationId: legacy.id, projectId: project.id, adapterId: 'codex' },
      });
    }
    await db.save();

    const manager = new FakeCodexManager();
    for (const [index, threadId] of threadIds.entries()) {
      manager.threadSnapshots.set(threadId, {
        id: threadId,
        path: join(directory, `rollout-${threadId}.jsonl`),
        cwd: directory,
        preview: `真实旧会话 ${index + 1}`,
        cliVersion: '0.142.5',
        createdAt: 1_783_576_287 + index,
        updatedAt: 1_783_576_300 + index,
        status: { type: 'idle' },
        turns: [
          {
            id: `provider-turn-${index + 1}`,
            status: 'completed',
            startedAt: 1_783_576_287 + index,
            completedAt: 1_783_576_300 + index,
            items: [
              { id: `provider-user-${index + 1}`, type: 'userMessage', clientId: `provider-client-${index + 1}`, content: [{ type: 'text', text: `旧用户消息 ${index + 1}` }] },
              { id: `provider-agent-${index + 1}`, type: 'agentMessage', text: `旧助手回复 ${index + 1}`, phase: 'final_answer' },
            ],
          },
        ],
      });
    }
    const server = await createLocalServer({ dbPath, apiToken: 'native-api-token', projectRoot: directory, codexAppServerManager: manager });
    const headers = { authorization: 'Bearer native-api-token' };

    const choicesResponse = await server.inject({ method: 'GET', url: `/api/tasks/${task.id}/conversation-choices`, headers });

    expect(choicesResponse.statusCode).toBe(200);
    const choices = choicesResponse.json().choices as Array<{ id: string; providerThreadId: string; transportKind: string; resumable: boolean; readOnly: boolean }>;
    expect(choices).toHaveLength(2);
    expect(choices).toEqual(expect.arrayContaining(threadIds.map((providerThreadId) => expect.objectContaining({ providerThreadId, transportKind: 'codex_native', resumable: true, readOnly: false }))));
    const selected = choices.find((choice) => choice.providerThreadId === threadIds[0])!;
    const resumed = await server.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/conversations`,
      headers: { ...headers, 'idempotency-key': 'resume-imported-thread' },
      payload: { mode: 'resume', conversationId: selected.id, content: '继续原生 thread', clientUserMessageId: 'resume-imported-client-message' },
    });

    expect(resumed.statusCode).toBe(202);
    expect(manager.threadStarts).toEqual([]);
    expect(manager.turnStarts.at(-1)).toEqual(expect.objectContaining({ threadId: threadIds[0] }));
  });

  it('uses validated renderer client ids while keeping durable user transcript messages provider-confirmed', async () => {
    const fixture = await createApiFixture();
    const created = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'renderer-client-create-key' },
      payload: { mode: 'create', content: 'renderer create prompt', clientUserMessageId: 'renderer-create-message' },
    });
    expect(created.statusCode).toBe(202);
    const conversationId = created.json().conversation.id as string;
    let detail = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    expect(detail.messages).toEqual([]);
    expect(detail.submissions).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'renderer create prompt', clientUserMessageId: 'renderer-create-message' })]));

    await fixture.manager.emit(
      'item/completed',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'provider-create-user-message', type: 'userMessage', clientId: 'renderer-create-message', content: [{ type: 'text', text: 'renderer create prompt' }] },
      },
      undefined,
      9,
    );
    detail = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    expect(detail.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'renderer create prompt', metadata: expect.objectContaining({ clientUserMessageId: 'renderer-create-message' }) })]));

    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 10);
    const followUp = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'renderer-client-follow-up-key' },
      payload: { content: 'renderer follow-up prompt', delivery: 'queue', clientUserMessageId: 'renderer-follow-up-message' },
    });
    expect(followUp.statusCode).toBe(202);
    detail = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    expect(detail.messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ metadata: expect.objectContaining({ clientUserMessageId: 'renderer-follow-up-message' }) })]));
    expect(detail.submissions).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'renderer follow-up prompt', clientUserMessageId: 'renderer-follow-up-message' })]));

    await fixture.manager.emit(
      'item/completed',
      {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: { id: 'provider-follow-up-user-message', type: 'userMessage', clientId: 'renderer-follow-up-message', content: [{ type: 'text', text: 'renderer follow-up prompt' }] },
      },
      undefined,
      11,
    );
    detail = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    expect(detail.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'renderer follow-up prompt', metadata: expect.objectContaining({ clientUserMessageId: 'renderer-follow-up-message' }) })]));

    for (const [index, clientUserMessageId] of ['', 'x'.repeat(201)].entries()) {
      const invalid = await fixture.server.inject({
        method: 'POST',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/messages`,
        headers: { ...fixture.headers, 'idempotency-key': `invalid-client-message-${index}` },
        payload: { content: 'invalid client id', delivery: 'queue', clientUserMessageId },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'ZEUS_INVALID_CLIENT_USER_MESSAGE_ID' });
    }
    await fixture.server.close();
  });

  it('rejects arbitrary, missing, and overreaching RUI answers before any provider write', async () => {
    const fixture = await createApiFixture();
    const created = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'rui-authority-start' },
      payload: { mode: 'create', content: 'request canonical user input', clientUserMessageId: 'rui-authority-client' },
    });
    expect(created.statusCode).toBe(202);
    const conversationId = created.json().conversation.id as string;

    const canonicalQuestion = {
      id: 'choice',
      header: 'Choice',
      question: 'Choose one',
      options: [
        { label: 'A', description: 'First' },
        { label: 'B', description: 'Second' },
      ],
      isOther: false,
      isSecret: false,
    };
    const invalidCases = [
      {
        providerRequestId: 'rui-arbitrary-id',
        questions: [canonicalQuestion],
        body: { type: 'userInput', answers: { invented: { answers: ['A'] } } },
      },
      {
        providerRequestId: 'rui-missing-answer',
        questions: [canonicalQuestion, { id: 'notes', header: 'Notes', question: 'Explain', options: null, isOther: false, isSecret: false }],
        body: { type: 'userInput', answers: { choice: { answers: ['A'] } } },
      },
      {
        providerRequestId: 'rui-single-overreach',
        questions: [canonicalQuestion],
        body: { type: 'userInput', answers: { choice: { answers: ['A', 'B'] } } },
      },
      {
        providerRequestId: 'rui-option-overreach',
        questions: [canonicalQuestion],
        body: { type: 'userInput', answers: { choice: { answers: ['invented'] } } },
      },
    ];

    for (const [index, invalidCase] of invalidCases.entries()) {
      await fixture.manager.emit('item/tool/requestUserInput', { threadId: 'thread-1', turnId: 'turn-1', itemId: `rui-item-${index}`, questions: invalidCase.questions, autoResolutionMs: null }, invalidCase.providerRequestId, 210 + index);
      const detail = (
        await fixture.server.inject({
          method: 'GET',
          url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
          headers: fixture.headers,
        })
      ).json();
      const pending = detail.requests.find((entry: { status: string; payload: { itemId?: string } }) => entry.status === 'pending' && entry.payload.itemId === `rui-item-${index}`);
      expect(pending).toBeDefined();
      const providerWritesBefore = fixture.manager.responses.length;
      const response = await fixture.server.inject({
        method: 'POST',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${pending.id}/respond`,
        headers: fixture.headers,
        payload: invalidCase.body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
      expect(fixture.manager.responses).toHaveLength(providerWritesBefore);
    }

    await fixture.manager.emit(
      'item/tool/requestUserInput',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'rui-valid-item',
        questions: [
          { ...canonicalQuestion, id: 'scopes', header: 'Scopes', question: 'Choose scopes', isOther: true, multiple: true },
          { id: 'notes', header: 'Notes', question: 'Explain', options: null, isOther: false, isSecret: true },
        ],
        autoResolutionMs: null,
      },
      'rui-valid',
      215,
    );
    const validDetail = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    const validPending = validDetail.requests.find((entry: { status: string; payload: { itemId?: string } }) => entry.status === 'pending' && entry.payload.itemId === 'rui-valid-item');
    const valid = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${validPending.id}/respond`,
      headers: fixture.headers,
      payload: { type: 'userInput', answers: { scopes: { answers: ['A', 'Custom scope'] }, notes: { answers: ['private note'] } } },
    });
    expect(valid.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'request_user_input', answers: { scopes: { answers: ['A', 'Custom scope'] }, notes: { answers: ['private note'] } } });
    await fixture.server.close();
  });

  it('exposes malformed request_user_input envelopes only as failed recovery state, never pending UI authority', async () => {
    const fixture = await createApiFixture();
    const created = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'malformed-rui-start' },
      payload: { mode: 'create', content: 'malformed RUI authority', clientUserMessageId: 'malformed-rui-start-client' },
    });
    const conversationId = created.json().conversation.id as string;
    await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'malformed-rui-queued' },
      payload: { content: 'must remain paused', delivery: 'queue', clientUserMessageId: 'malformed-rui-queued-client' },
    });

    await fixture.manager.emit(
      'item/tool/requestUserInput',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'malformed-rui-item',
        questions: [{ id: 'choice', header: 'Choice', question: 'Choose', options: [{ label: 'A', description: '' }], isOther: false, isSecret: false }],
        autoResolutionMs: null,
        unexpected: true,
      },
      'malformed-rui-request',
      216,
    );

    const snapshot = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    const malformedRequest = snapshot.requests.find((entry: { payload: { itemId?: string } }) => entry.payload.itemId === 'malformed-rui-item');
    expect(malformedRequest).toMatchObject({
      status: 'failed',
      response: { error: 'ZEUS_CODEX_REQUEST_USER_INPUT_ENVELOPE_INVALID', recoveryRequired: true },
    });
    expect(snapshot.requests.some((entry: { status: string }) => entry.status === 'pending')).toBe(false);
    expect(snapshot.queue.state).toEqual({ type: 'paused', reason: 'recovery_required' });
    expect(snapshot.submissions).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'paused', pausedReason: 'recovery_required' })]));
    expect(fixture.manager.interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    expect(fixture.manager.turnStarts).toHaveLength(1);
    await fixture.server.close();
  });

  it('shares one in-flight acceptance for concurrent identical requests without treating the live owner as crash recovery', async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    class DeferredTurnManager extends FakeCodexManager {
      override async startTurn(input: CodexTurnStartInput) {
        const turn = super.startTurn(input);
        await turnGate;
        return turn;
      }
    }
    const manager = new DeferredTurnManager();
    const fixture = await createApiFixture(manager);
    const request = {
      method: 'POST' as const,
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'concurrent-create' },
      payload: { mode: 'create', content: '并发只接收一次' },
    };

    const first = fixture.server.inject(request);
    while (manager.turnStarts.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = fixture.server.inject(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.threadStarts).toHaveLength(1);
    expect(manager.turnStarts).toHaveLength(1);

    releaseTurn();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.statusCode).toBe(202);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(manager.threadStarts).toHaveLength(1);
    expect(manager.turnStarts).toHaveLength(1);

    const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    expect(db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM conversations WHERE task_id = ?`, [fixture.task.id])?.count).toBe(1);
    expect(db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM conversation_submissions WHERE idempotency_key = ?`, ['concurrent-create'])?.count).toBe(1);
    await fixture.server.close();
  });

  it('requires an explicit history choice and provides replay-identical durable create/resume operations', async () => {
    const fixture = await createApiFixture();

    const emptyChoices = await fixture.server.inject({
      method: 'GET',
      url: `/api/tasks/${fixture.task.id}/conversation-choices`,
      headers: fixture.headers,
    });
    expect(emptyChoices.statusCode).toBe(200);
    expect(emptyChoices.json()).toMatchObject({ taskId: fixture.task.id, hasHistory: false, requiresChoice: false, choices: [] });

    const createBody = { mode: 'create', content: '第一轮 API 输入' };
    const first = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'create-first' },
      payload: createBody,
    });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();
    expect(firstBody).toMatchObject({
      operation: { status: 'accepted', idempotencyKey: 'create-first' },
      conversation: {
        taskId: fixture.task.id,
        transportKind: 'codex_native',
        provider: { id: 'codex', threadId: 'thread-1', model: 'gpt-5.4' },
      },
      submission: { content: '第一轮 API 输入', status: 'active' },
    });
    expect(fixture.manager.threadStarts).toHaveLength(1);

    const replay = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'create-first' },
      payload: createBody,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(firstBody);
    expect(fixture.manager.threadStarts).toHaveLength(1);

    const conflict = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'create-first' },
      payload: { ...createBody, content: '冲突输入' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'ZEUS_IDEMPOTENCY_CONFLICT' });

    const choices = await fixture.server.inject({
      method: 'GET',
      url: `/api/tasks/${fixture.task.id}/conversation-choices`,
      headers: fixture.headers,
    });
    expect(choices.json()).toMatchObject({
      hasHistory: true,
      requiresChoice: true,
      choices: [{ id: firstBody.conversation.id, transportKind: 'codex_native', resumable: true }],
    });

    const omittedChoice = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'choice-omitted' },
      payload: {},
    });
    expect(omittedChoice.statusCode).toBe(409);
    expect(omittedChoice.json()).toMatchObject({ error: 'ZEUS_CONVERSATION_CHOICE_REQUIRED' });

    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 2);
    const resumed = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'resume-first' },
      payload: { mode: 'resume', conversationId: firstBody.conversation.id, content: '精确续接这一条' },
    });
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toMatchObject({
      operation: { status: 'accepted', idempotencyKey: 'resume-first' },
      conversation: { id: firstBody.conversation.id, provider: { threadId: 'thread-1' } },
      submission: { content: '精确续接这一条', providerTurnId: 'turn-2' },
    });
    expect(fixture.manager.threadStarts).toHaveLength(1);
    expect(fixture.manager.turnStarts.at(-1)?.threadId).toBe('thread-1');

    const explicitNew = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'create-second' },
      payload: { mode: 'create', content: '显式新建第二条' },
    });
    expect(explicitNew.statusCode).toBe(202);
    expect(explicitNew.json().conversation.id).not.toBe(firstBody.conversation.id);

    await fixture.server.close();
  });

  it('recovers an in-progress durable acceptance after restart without repeating provider writes', async () => {
    const fixture = await createApiFixture();
    const requestBody = { mode: 'create', content: 'crash-window acceptance' };
    const first = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'crash-window-create' },
      payload: requestBody,
    });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();
    expect(fixture.manager.threadStarts).toHaveLength(1);
    expect(fixture.manager.turnStarts).toHaveLength(1);
    await fixture.server.close();

    const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    const persistedAcceptance = db.get<{ request_hash: string; resource_id: string; response_json: string }>(`SELECT request_hash, resource_id, response_json FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [
      `task-conversation:${fixture.task.id}`,
      'crash-window-create',
    ])!;
    expect(persistedAcceptance.resource_id).toMatch(/^rpc_started:task-acceptance:/u);
    const reservation = JSON.parse(Buffer.from(persistedAcceptance.resource_id.slice('rpc_started:task-acceptance:'.length), 'base64url').toString('utf8'));
    expect(reservation).toEqual({
      scope: `task-conversation:${fixture.task.id}`,
      requestHash: persistedAcceptance.request_hash,
      operationId: firstBody.operation.id,
      conversationId: firstBody.conversation.id,
      submissionId: firstBody.submission.id,
    });
    expect(JSON.parse(persistedAcceptance.response_json)).toEqual(firstBody);
    db.execute(`UPDATE idempotency_requests SET status = 'in_progress' WHERE scope = ? AND idempotency_key = ?`, [`task-conversation:${fixture.task.id}`, 'crash-window-create']);
    db.execute(`UPDATE conversations SET provider_state = 'paused', provider_model = 'mutated-after-acceptance', updated_at = '2026-07-13T23:59:59.000Z' WHERE id = ?`, [firstBody.conversation.id]);
    db.execute(`UPDATE conversation_submissions SET status = 'paused', paused_reason = 'recovery_required', updated_at = '2026-07-13T23:59:59.000Z' WHERE id = ?`, [firstBody.submission.id]);
    await db.save();

    class RecoveringFakeCodexManager extends FakeCodexManager {
      override async readThread(input: { threadId: string }) {
        this.reads.push(input.threadId);
        return { id: input.threadId, turns: [{ id: 'turn-1', status: 'running' }] };
      }
    }
    const restartedManager = new RecoveringFakeCodexManager();
    const restarted = await createLocalServer({
      dbPath: join(fixture.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: fixture.directory,
      codexAppServerManager: restartedManager,
    });
    const replay = await restarted.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'crash-window-create' },
      payload: requestBody,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(firstBody);
    expect(restartedManager.threadStarts).toHaveLength(0);
    expect(restartedManager.turnStarts).toHaveLength(0);
    await restarted.close();
    const verifiedDb = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    expect(verifiedDb.get<{ status: string }>(`SELECT status FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [`task-conversation:${fixture.task.id}`, 'crash-window-create'])?.status).toBe('completed');

    verifiedDb.execute(`UPDATE idempotency_requests SET status = 'in_progress', response_json = NULL, http_status = NULL WHERE scope = ? AND idempotency_key = ?`, [`task-conversation:${fixture.task.id}`, 'crash-window-create']);
    await verifiedDb.save();
    const secondRestartManager = new RecoveringFakeCodexManager();
    const secondRestart = await createLocalServer({
      dbPath: join(fixture.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: fixture.directory,
      codexAppServerManager: secondRestartManager,
    });
    const missingCheckpoint = await secondRestart.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'crash-window-create' },
      payload: requestBody,
    });
    expect(missingCheckpoint.statusCode).toBe(409);
    expect(missingCheckpoint.json()).toMatchObject({ error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED', recoveryRequired: true, operation: { status: 'recovery_required' } });
    expect(secondRestartManager.threadStarts).toHaveLength(0);
    expect(secondRestartManager.turnStarts).toHaveLength(0);
    await secondRestart.close();
  });

  it('rejects a task recovery marker that points at an unrelated same-key message submission', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'collision-parent' },
        payload: { mode: 'create', content: 'collision parent' },
      })
    ).json();
    const unrelated = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/messages`,
        headers: { ...fixture.headers, 'idempotency-key': 'collision-task-key' },
        payload: { content: 'unrelated same-key message', delivery: 'steer_now', expectedTurnId: 'turn-1' },
      })
    ).json();
    expect(unrelated.submission).toMatchObject({ status: 'resolved', providerTurnId: 'turn-1' });
    await fixture.server.close();

    const requestBody = { mode: 'create', content: 'must create a distinct task conversation' };
    const canonicalBody = `{"content":${JSON.stringify(requestBody.content)},"mode":"create"}`;
    const requestHash = createHash('sha256').update(canonicalBody).digest('hex');
    const scope = `task-conversation:${fixture.task.id}`;
    const stableOperationId = `native_operation_${createHash('sha256').update(`${scope}\0collision-task-key\0${requestHash}`).digest('hex').slice(0, 24)}`;
    const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    db.execute(
      `INSERT INTO idempotency_requests (scope, idempotency_key, request_hash, status, http_status, response_json, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, 'in_progress', NULL, NULL, ?, ?, ?)`,
      [scope, 'collision-task-key', requestHash, `rpc_started:${unrelated.submission.id}`, '2026-07-13T08:00:00.000Z', '2026-07-13T08:00:00.000Z'],
    );
    await db.save();

    class RecoveringFakeCodexManager extends FakeCodexManager {
      override async readThread(input: { threadId: string }) {
        this.reads.push(input.threadId);
        return { id: input.threadId, turns: [{ id: 'turn-1', status: 'running' }] };
      }
    }
    const manager = new RecoveringFakeCodexManager();
    const restarted = await createLocalServer({
      dbPath: join(fixture.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: fixture.directory,
      codexAppServerManager: manager,
    });
    const replay = await restarted.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'collision-task-key' },
      payload: requestBody,
    });

    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED',
      operation: { id: stableOperationId, status: 'recovery_required', idempotencyKey: 'collision-task-key' },
    });
    expect(manager.threadStarts).toHaveLength(0);
    expect(manager.turnStarts).toHaveLength(0);
    await restarted.close();
  });

  it('reconstructs a send-now acceptance after restart without steering the provider twice', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'send-now-crash-parent' },
        payload: { mode: 'create', content: 'active parent' },
      })
    ).json();
    const queued = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/messages`,
        headers: { ...fixture.headers, 'idempotency-key': 'send-now-crash-child' },
        payload: { content: 'steer exactly once', delivery: 'queue' },
      })
    ).json();
    const sendNowUrl = `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/queue/${queued.submission.id}/send-now`;
    const first = await fixture.server.inject({ method: 'POST', url: sendNowUrl, headers: fixture.headers });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();
    expect(fixture.manager.steers).toHaveLength(1);
    await fixture.server.close();

    const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    db.execute(`UPDATE idempotency_requests SET status = 'in_progress', response_json = NULL, http_status = NULL WHERE scope = ? AND idempotency_key = ?`, [`native-send-now:${created.conversation.id}`, queued.submission.id]);
    await db.save();
    class RecoveringFakeCodexManager extends FakeCodexManager {
      override async readThread(input: { threadId: string }) {
        this.reads.push(input.threadId);
        return { id: input.threadId, turns: [{ id: 'turn-1', status: 'running' }] };
      }
    }
    const restartedManager = new RecoveringFakeCodexManager();
    const restarted = await createLocalServer({
      dbPath: join(fixture.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: fixture.directory,
      codexAppServerManager: restartedManager,
    });
    const replay = await restarted.inject({ method: 'POST', url: sendNowUrl, headers: fixture.headers });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(firstBody);
    expect(restartedManager.steers).toHaveLength(0);
    await restarted.close();
  });

  it('executes a prepared send-now after restart but fail-closes an rpc-started unknown outcome', async () => {
    const prepareFixture = async (key: string) => {
      const fixture = await createApiFixture();
      const created = (
        await fixture.server.inject({
          method: 'POST',
          url: `/api/tasks/${fixture.task.id}/conversations`,
          headers: { ...fixture.headers, 'idempotency-key': `${key}-parent` },
          payload: { mode: 'create', content: `${key} parent` },
        })
      ).json();
      const queued = (
        await fixture.server.inject({
          method: 'POST',
          url: `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/messages`,
          headers: { ...fixture.headers, 'idempotency-key': `${key}-child` },
          payload: { content: `${key} child`, delivery: 'queue' },
        })
      ).json();
      await fixture.server.close();
      return {
        ...fixture,
        conversationId: created.conversation.id as string,
        submissionId: queued.submission.id as string,
        sendNowUrl: `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/queue/${queued.submission.id}/send-now`,
      };
    };
    class RecoveringFakeCodexManager extends FakeCodexManager {
      override async readThread(input: { threadId: string }) {
        this.reads.push(input.threadId);
        return { id: input.threadId, turns: [{ id: 'turn-1', status: 'running' }] };
      }
    }
    const seedMarker = async (fixture: Awaited<ReturnType<typeof prepareFixture>>, phase: 'prepared' | 'rpc_started') => {
      const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
      const scope = `native-send-now:${fixture.conversationId}`;
      const requestHash = createHash('sha256').update('{}').digest('hex');
      const stableOperationId = `native_operation_${createHash('sha256').update(`${scope}\0${fixture.submissionId}\0${requestHash}`).digest('hex').slice(0, 24)}`;
      db.execute(
        `INSERT INTO idempotency_requests (scope, idempotency_key, request_hash, status, http_status, response_json, resource_id, created_at, updated_at)
         VALUES (?, ?, ?, 'in_progress', NULL, NULL, ?, ?, ?)`,
        [scope, fixture.submissionId, requestHash, `${phase}:send-now:${fixture.submissionId}`, '2026-07-13T08:00:00.000Z', '2026-07-13T08:00:00.000Z'],
      );
      await db.save();
      return { stableOperationId };
    };

    const prepared = await prepareFixture('prepared-marker');
    await seedMarker(prepared, 'prepared');
    const preparedManager = new RecoveringFakeCodexManager();
    const preparedServer = await createLocalServer({
      dbPath: join(prepared.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: prepared.directory,
      codexAppServerManager: preparedManager,
    });
    const preparedReplay = await preparedServer.inject({ method: 'POST', url: prepared.sendNowUrl, headers: prepared.headers });
    expect(preparedReplay.statusCode).toBe(202);
    expect(preparedReplay.json()).toMatchObject({ operation: { status: 'accepted' }, submission: { status: 'resolved' } });
    expect(preparedManager.steers).toHaveLength(1);
    await preparedServer.close();
    const preparedDb = await createZeusDatabase(join(prepared.directory, 'zeus.db'));
    expect(preparedDb.get<{ resource_id: string }>(`SELECT resource_id FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [`native-send-now:${prepared.conversationId}`, prepared.submissionId])?.resource_id).toBe(
      `rpc_started:send-now:${prepared.submissionId}`,
    );

    const unknown = await prepareFixture('rpc-started-marker');
    await seedMarker(unknown, 'rpc_started');
    const unknownManager = new RecoveringFakeCodexManager();
    const unknownServer = await createLocalServer({
      dbPath: join(unknown.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: unknown.directory,
      codexAppServerManager: unknownManager,
    });
    const unknownReplay = await unknownServer.inject({ method: 'POST', url: unknown.sendNowUrl, headers: unknown.headers });
    expect(unknownReplay.statusCode).toBe(409);
    expect(unknownReplay.json()).toMatchObject({
      error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED',
      operation: { status: 'recovery_required' },
    });
    expect(unknownManager.steers).toHaveLength(0);
    await unknownServer.close();
  });

  it('durably marks send-now rpc-started before dispatching so a pre-provider crash cannot leave a prepared dead state', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'send-now-order-parent' },
        payload: { mode: 'create', content: 'active parent' },
      })
    ).json();
    const queued = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/messages`,
        headers: { ...fixture.headers, 'idempotency-key': 'send-now-order-child' },
        payload: { content: 'must not enter a prepared dispatching dead state', delivery: 'queue' },
      })
    ).json();
    const scope = `native-send-now:${created.conversation.id}`;
    const sendNowUrl = `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/queue/${queued.submission.id}/send-now`;
    const databasePath = join(fixture.directory, 'zeus.db');
    const crashDatabasePath = join(fixture.directory, 'send-now-pre-provider-crash.db');
    let releaseDispatchSave!: () => void;
    let signalDispatchSaved!: () => void;
    const dispatchSaveGate = new Promise<void>((resolve) => {
      releaseDispatchSave = resolve;
    });
    const dispatchSaved = new Promise<void>((resolve) => {
      signalDispatchSaved = resolve;
    });
    const originalSave = ZeusDatabase.prototype.save;
    let interceptedDispatchSave = false;
    const saveSpy = vi.spyOn(ZeusDatabase.prototype, 'save').mockImplementation(async function (this: ZeusDatabase) {
      await originalSave.call(this);
      if (interceptedDispatchSave) return;
      const submissionStatus = this.get<{ status: string }>(`SELECT status FROM conversation_submissions WHERE id = ?`, [queued.submission.id])?.status;
      if (submissionStatus !== 'dispatching' || fixture.manager.steers.length > 0) return;
      interceptedDispatchSave = true;
      signalDispatchSaved();
      await dispatchSaveGate;
    });
    let sending: ReturnType<typeof fixture.server.inject> | undefined;
    try {
      sending = fixture.server.inject({ method: 'POST', url: sendNowUrl, headers: fixture.headers });
      await dispatchSaved;
      await copyFile(databasePath, crashDatabasePath);
      const crashDb = await createZeusDatabase(crashDatabasePath);
      expect(crashDb.get<{ status: string }>(`SELECT status FROM conversation_submissions WHERE id = ?`, [queued.submission.id])?.status).toBe('dispatching');
      expect(crashDb.get<{ resource_id: string }>(`SELECT resource_id FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [scope, queued.submission.id])?.resource_id).toBe(`rpc_started:send-now:${queued.submission.id}`);
      expect(fixture.manager.steers).toHaveLength(0);
    } finally {
      releaseDispatchSave();
      saveSpy.mockRestore();
      if (sending) await sending;
      await fixture.server.close();
    }

    class RecoveringFakeCodexManager extends FakeCodexManager {
      override async readThread(input: { threadId: string }) {
        this.reads.push(input.threadId);
        return { id: input.threadId, turns: [{ id: 'turn-1', status: 'running' }] };
      }
    }
    const restartedManager = new RecoveringFakeCodexManager();
    const restarted = await createLocalServer({
      dbPath: crashDatabasePath,
      apiToken: 'native-api-token',
      projectRoot: fixture.directory,
      codexAppServerManager: restartedManager,
    });
    const replay = await restarted.inject({ method: 'POST', url: sendNowUrl, headers: fixture.headers });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED',
      operation: { status: 'recovery_required', idempotencyKey: queued.submission.id },
    });
    expect(restartedManager.steers).toHaveLength(0);
    await restarted.close();
  });

  it('reconstructs a resolved request acceptance after restart without responding to the provider twice', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'request-crash-parent' },
        payload: { mode: 'create', content: 'request crash parent' },
      })
    ).json();
    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd', availableDecisions: ['accept', 'decline', 'cancel'] }, 'request-crash', 45);
    const snapshot = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}`,
        headers: fixture.headers,
      })
    ).json();
    const request = snapshot.requests.find((candidate: { type: string }) => candidate.type === 'command');
    const responseBody = { type: 'command', decision: 'accept' };
    const responseUrl = `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/requests/${request.id}/respond`;
    const first = await fixture.server.inject({ method: 'POST', url: responseUrl, headers: fixture.headers, payload: responseBody });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();
    expect(fixture.manager.responses).toHaveLength(1);
    await fixture.server.close();

    const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    db.execute(`UPDATE idempotency_requests SET status = 'in_progress', response_json = NULL, http_status = NULL WHERE scope = ? AND idempotency_key = ?`, [`native-request-response:${created.conversation.id}`, request.id]);
    await db.save();
    class RecoveringFakeCodexManager extends FakeCodexManager {
      override async readThread(input: { threadId: string }) {
        this.reads.push(input.threadId);
        return { id: input.threadId, turns: [{ id: 'turn-1', status: 'running' }] };
      }
    }
    const restartedManager = new RecoveringFakeCodexManager();
    const restarted = await createLocalServer({
      dbPath: join(fixture.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: fixture.directory,
      codexAppServerManager: restartedManager,
    });
    const replay = await restarted.inject({ method: 'POST', url: responseUrl, headers: fixture.headers, payload: responseBody });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(firstBody);
    expect(restartedManager.responses).toHaveLength(0);
    await restarted.close();
  });

  it('fail-closes an rpc-started interrupt after restart without interrupting twice and marks recovery required', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'interrupt-crash-parent' },
        payload: { mode: 'create', content: 'interrupt crash parent' },
      })
    ).json();
    const interruptUrl = `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/turns/turn-1/interrupt`;
    const first = await fixture.server.inject({ method: 'POST', url: interruptUrl, headers: fixture.headers });
    expect(first.statusCode).toBe(202);
    expect(fixture.manager.interrupts).toHaveLength(1);
    await fixture.server.close();

    const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    db.execute(`UPDATE idempotency_requests SET status = 'in_progress', response_json = NULL, http_status = NULL WHERE scope = ? AND idempotency_key = ?`, [`native-interrupt:${created.conversation.id}`, 'turn-1']);
    await db.save();
    class RecoveringFakeCodexManager extends FakeCodexManager {
      override async readThread(input: { threadId: string }) {
        this.reads.push(input.threadId);
        return { id: input.threadId, turns: [{ id: 'turn-1', status: 'running' }] };
      }
    }
    const restartedManager = new RecoveringFakeCodexManager();
    const restarted = await createLocalServer({
      dbPath: join(fixture.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: fixture.directory,
      codexAppServerManager: restartedManager,
    });
    const replay = await restarted.inject({ method: 'POST', url: interruptUrl, headers: fixture.headers });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED',
      operation: { status: 'recovery_required', idempotencyKey: 'turn-1' },
      resourceId: expect.stringContaining('interrupt:'),
    });
    expect(restartedManager.interrupts).toHaveLength(0);
    const snapshot = await restarted.inject({
      method: 'GET',
      url: `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}`,
      headers: fixture.headers,
    });
    expect(snapshot.json()).toMatchObject({ queue: { state: { type: 'paused', reason: 'recovery_required' } } });
    await restarted.close();
  });

  it('maps native domain validation failures to client 4xx responses', async () => {
    const fixture = await createApiFixture();
    const invalidChoice = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'invalid-choice' },
      payload: { mode: 'resume', conversationId: 'conversation-not-owned', content: '不可续接' },
    });
    expect(invalidChoice.statusCode).toBe(400);
    expect(invalidChoice.json()).toMatchObject({ error: 'ZEUS_CONVERSATION_CHOICE_INVALID' });

    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'validation-parent' },
        payload: { mode: 'create', content: 'validation parent' },
      })
    ).json();
    await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'validation-queued' },
      payload: { content: 'queued', delivery: 'queue' },
    });
    const invalidReorder = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${created.conversation.id}/queue/reorder`,
      headers: fixture.headers,
      payload: { orderedSubmissionIds: [] },
    });
    expect(invalidReorder.statusCode).toBe(400);
    expect(invalidReorder.json()).toMatchObject({ error: 'ZEUS_NATIVE_QUEUE_REORDER_INVALID' });

    await fixture.server.close();
  });

  it('keeps non-Codex legacy messages writable while Codex run/continue remains choice-safe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeus-native-api-legacy-'));
    cleanup.push(directory);
    const manager = new FakeCodexManager();
    const legacyInputs: string[] = [];
    const legacyInvocations: Array<{ command: string; args: string[] }> = [];
    const controlledSpawn = createControlledRuntimeSpawn(legacyInputs);
    const server = await createLocalServer({
      dbPath: join(directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: directory,
      codexAppServerManager: manager,
      aiRuntimeSpawn: (command, args, options) => {
        legacyInvocations.push({ command, args });
        return controlledSpawn(command, args, options);
      },
    });
    const headers = { authorization: 'Bearer native-api-token' };
    const project = (await server.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Legacy reference', localPath: directory } })).json();
    const task = (
      await server.inject({
        method: 'POST',
        url: '/api/tasks',
        headers,
        payload: { projectId: project.id, title: 'Legacy reference', description: '旧上下文只读引用', allowCodeChanges: true, allowTests: true, allowGitCommit: false },
      })
    ).json();
    const fixture = { directory, manager, server, headers, project, task };

    expect((await setRuntimeAdapter(fixture, 'claude')).statusCode).toBe(200);
    const legacyRun = await server.inject({ method: 'POST', url: `/api/tasks/${task.id}/run`, headers });
    expect(legacyRun.statusCode).toBe(201);
    const legacy = legacyRun.json().conversation;
    expect(legacy.messages.length).toBeGreaterThan(0);
    expect(manager.threadStarts).toHaveLength(0);

    const legacyWrite = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/conversations/${legacy.id}/messages`,
      headers: { ...headers, 'idempotency-key': 'legacy-write' },
      payload: { content: '继续写入明确的非 Codex legacy 会话' },
    });
    expect(legacyWrite.statusCode).toBe(201);
    expect(legacyWrite.json()).toMatchObject({ conversation: { id: legacy.id } });

    expect((await setRuntimeAdapter(fixture, 'codex')).statusCode).toBe(200);
    const pinnedLegacyWrite = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/conversations/${legacy.id}/messages`,
      headers,
      payload: { content: '全局默认切到 Codex 后仍写原 Claude handle' },
    });
    expect(pinnedLegacyWrite.statusCode).toBe(201);
    expect(legacyInvocations).toHaveLength(1);
    expect(legacyInvocations[0]?.command).toBe('claude');
    expect(legacyInputs).toEqual(['继续写入明确的非 Codex legacy 会话\n', '全局默认切到 Codex 后仍写原 Claude handle\n']);
    expect(manager.threadStarts).toHaveLength(0);
    expect(manager.turnStarts).toHaveLength(0);
    const choices = await server.inject({ method: 'GET', url: `/api/tasks/${task.id}/conversation-choices`, headers });
    expect(choices.json()).toMatchObject({ choices: [{ id: legacy.id, transportKind: 'legacy_cli', readOnly: true, resumable: false }] });

    for (const endpoint of ['run', 'continue']) {
      const response = await server.inject({ method: 'POST', url: `/api/tasks/${task.id}/${endpoint}`, headers });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'ZEUS_CONVERSATION_CHOICE_REQUIRED' });
    }

    const referenced = await server.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/conversations`,
      headers: { ...headers, 'idempotency-key': 'reference-legacy' },
      payload: {
        mode: 'reference_legacy',
        sourceConversationId: legacy.id,
        messageIds: [legacy.messages[0].id],
        content: '仅参考明确选择的旧消息',
      },
    });
    expect(referenced.statusCode).toBe(202);
    expect(referenced.json()).toMatchObject({
      conversation: { transportKind: 'codex_native', legacySourceConversationId: legacy.id },
      submission: { content: '仅参考明确选择的旧消息' },
    });
    expect(manager.turnStarts[0]?.additionalContext).toEqual({
      kind: 'untrusted',
      items: [{ messageId: legacy.messages[0].id, role: legacy.messages[0].role, content: legacy.messages[0].content }],
    });

    const freshTask = (
      await server.inject({
        method: 'POST',
        url: '/api/tasks',
        headers,
        payload: { projectId: project.id, title: 'Fresh Codex run', description: '兼容入口转 create', allowCodeChanges: false, allowTests: false, allowGitCommit: false },
      })
    ).json();
    const forwardedRun = await server.inject({ method: 'POST', url: `/api/tasks/${freshTask.id}/run`, headers });
    expect(forwardedRun.statusCode).toBe(202);
    expect(forwardedRun.json()).toMatchObject({ operation: { status: 'accepted' }, conversation: { taskId: freshTask.id, transportKind: 'codex_native' } });

    await server.close();
  });

  it.each([
    ['conflicting legacy adapter provenance', 'claude', 'gemini'],
    ['an old legacy Codex conversation', 'codex', 'codex'],
  ] as const)('rejects %s before appending, spawning, or starting a native turn', async (_caseName, providerId, messageAdapterId) => {
    const directory = await mkdtemp(join(tmpdir(), `zeus-native-api-legacy-${providerId}-${messageAdapterId}-`));
    cleanup.push(directory);
    const dbPath = join(directory, 'zeus.db');
    const manager = new FakeCodexManager();
    const invocations: Array<{ command: string; args: string[] }> = [];
    const controlledSpawn = createControlledRuntimeSpawn();
    const spawn: AiRuntimeSpawn = (command, args, options) => {
      invocations.push({ command, args });
      return controlledSpawn(command, args, options);
    };
    const firstServer = await createLocalServer({ dbPath, apiToken: 'native-api-token', projectRoot: directory, codexAppServerManager: manager, aiRuntimeSpawn: spawn });
    const headers = { authorization: 'Bearer native-api-token' };
    const project = (await firstServer.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Legacy conflict', localPath: directory } })).json();
    const task = (
      await firstServer.inject({
        method: 'POST',
        url: '/api/tasks',
        headers,
        payload: { projectId: project.id, title: 'Legacy conflict', description: '冲突 provenance 必须只读', allowCodeChanges: true, allowTests: true, allowGitCommit: false },
      })
    ).json();
    const firstFixture = { directory, manager, server: firstServer, headers, project, task };
    expect((await setRuntimeAdapter(firstFixture, 'claude')).statusCode).toBe(200);
    const legacyRun = await firstServer.inject({ method: 'POST', url: `/api/tasks/${task.id}/run`, headers });
    expect(legacyRun.statusCode).toBe(201);
    const conversationId = legacyRun.json().conversation.id as string;
    await firstServer.close();

    const db = await createZeusDatabase(dbPath);
    const taskPrompt = db.get<{ id: string; metadata_json: string }>(`SELECT id, metadata_json FROM conversation_messages WHERE conversation_id = ? AND source = 'task_prompt'`, [conversationId]);
    if (!taskPrompt) throw new Error('task_prompt fixture missing');
    db.execute(`UPDATE conversations SET provider_id = ? WHERE id = ?`, [providerId, conversationId]);
    db.execute(`UPDATE conversation_messages SET metadata_json = ? WHERE id = ?`, [JSON.stringify({ ...JSON.parse(taskPrompt.metadata_json), adapterId: messageAdapterId }), taskPrompt.id]);
    await db.save();

    const secondServer = await createLocalServer({ dbPath, apiToken: 'native-api-token', projectRoot: directory, codexAppServerManager: manager, aiRuntimeSpawn: spawn });
    const before = (await secondServer.inject({ method: 'GET', url: `/api/projects/${project.id}/conversations/${conversationId}`, headers })).json();
    const response = await secondServer.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/conversations/${conversationId}/messages`,
      headers,
      payload: { content: '不得进入任何写路径' },
    });
    const after = (await secondServer.inject({ method: 'GET', url: `/api/projects/${project.id}/conversations/${conversationId}`, headers })).json();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'ZEUS_LEGACY_CONVERSATION_READ_ONLY' });
    expect(after.messages).toHaveLength(before.messages.length);
    expect(invocations).toHaveLength(1);
    expect(manager.threadStarts).toHaveLength(0);
    expect(manager.turnStarts).toHaveLength(0);
    await secondServer.close();
  });

  it('durably preserves attachment metadata and implements queue versus steer-now delivery idempotently', async () => {
    const fixture = await createApiFixture();
    await writeFile(join(fixture.directory, 'evidence.png'), 'not dereferenced attachment metadata');
    await writeFile(join(fixture.directory, 'trace.json'), '{}');
    const created = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'message-parent' },
      payload: { mode: 'create', content: '保持 turn active' },
    });
    const conversation = created.json().conversation;
    const evidencePath = await realpath(join(fixture.directory, 'evidence.png'));
    const tracePath = await realpath(join(fixture.directory, 'trace.json'));
    const attachments = [
      { name: 'evidence.png', mime: 'image/png', size: 1234, localPath: evidencePath },
      { name: 'trace.json', mime: 'application/json', size: 99, localPath: tracePath },
    ];
    const queuedBody = { content: '排队并保留附件', attachments, delivery: 'queue' };
    const queued = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversation.id}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'message-queued' },
      payload: queuedBody,
    });
    expect(queued.statusCode).toBe(202);
    const queuedResponse = queued.json();
    expect(queuedResponse).toMatchObject({
      operation: { status: 'accepted', idempotencyKey: 'message-queued' },
      conversation: { id: conversation.id },
      submission: { content: '排队并保留附件', delivery: 'queue', status: 'queued', attachments },
    });

    const replay = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversation.id}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'message-queued' },
      payload: queuedBody,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(queuedResponse);

    const conflict = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversation.id}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'message-queued' },
      payload: { ...queuedBody, content: '不同 payload' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'ZEUS_IDEMPOTENCY_CONFLICT' });

    const outsideDirectory = await mkdtemp(join(tmpdir(), 'zeus-native-attachment-outside-'));
    cleanup.push(outsideDirectory);
    const outsidePath = join(outsideDirectory, 'outside.png');
    await writeFile(outsidePath, 'outside');
    const symlinkPath = join(fixture.directory, 'escape.png');
    await symlink(outsidePath, symlinkPath);
    const invalidAttachments = [
      { attachment: { name: 'both.png', mime: 'image/png', size: 1, localPath: join(fixture.directory, 'evidence.png'), uploadRef: 'upload_both' }, error: 'ZEUS_INVALID_CONVERSATION_ATTACHMENT' },
      { attachment: { name: 'relative.png', mime: 'image/png', size: 1, localPath: 'relative.png' }, error: 'ZEUS_INVALID_CONVERSATION_ATTACHMENT' },
      { attachment: { name: 'missing.png', mime: 'image/png', size: 1, localPath: join(fixture.directory, 'missing.png') }, error: 'ZEUS_INVALID_CONVERSATION_ATTACHMENT' },
      { attachment: { name: 'outside.png', mime: 'image/png', size: 1, localPath: outsidePath }, error: 'ZEUS_INVALID_CONVERSATION_ATTACHMENT' },
      { attachment: { name: 'escape.png', mime: 'image/png', size: 1, localPath: symlinkPath }, error: 'ZEUS_INVALID_CONVERSATION_ATTACHMENT' },
      { attachment: { name: 'unresolved.json', mime: 'application/json', size: 1, uploadRef: 'upload_trace_1' }, error: 'ZEUS_NATIVE_ATTACHMENT_UPLOAD_UNSUPPORTED' },
    ];
    for (const [index, { attachment, error }] of invalidAttachments.entries()) {
      const invalid = await fixture.server.inject({
        method: 'POST',
        url: `/api/projects/${fixture.project.id}/conversations/${conversation.id}/messages`,
        headers: { ...fixture.headers, 'idempotency-key': `invalid-attachment-${index}` },
        payload: { content: `invalid attachment ${index}`, attachments: [attachment], delivery: 'queue' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error });
    }

    const snapshot = await fixture.server.inject({
      method: 'GET',
      url: `/api/projects/${fixture.project.id}/conversations/${conversation.id}`,
      headers: fixture.headers,
    });
    expect(snapshot.json()).toMatchObject({
      id: conversation.id,
      submissions: [{ id: created.json().submission.id }, { id: queuedResponse.submission.id, attachments }],
    });

    const steered = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversation.id}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'message-steer' },
      payload: { content: '立即 steer', delivery: 'steer_now', expectedTurnId: 'turn-1' },
    });
    expect(steered.statusCode).toBe(202);
    expect(steered.json()).toMatchObject({ submission: { content: '立即 steer', delivery: 'steer_now', status: 'resolved', expectedTurnId: 'turn-1' } });
    expect(fixture.manager.steers).toEqual([{ threadId: 'thread-1', turnId: 'turn-1', clientUserMessageId: steered.json().submission.clientUserMessageId, input: [{ type: 'text', text: '立即 steer' }] }]);

    const staleSteer = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversation.id}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'message-steer-stale' },
      payload: { content: '过期 steer', delivery: 'steer_now', expectedTurnId: 'turn-stale' },
    });
    expect(staleSteer.statusCode).toBe(409);
    expect(staleSteer.json()).toMatchObject({ error: 'ZEUS_NATIVE_TURN_MISMATCH' });

    await fixture.server.close();
  });

  it('delivers local image and file attachments to queued, steered, and idle native provider inputs', async () => {
    const fixture = await createApiFixture();
    const imagePath = join(fixture.directory, 'provider-image.png');
    const filePath = join(fixture.directory, 'provider-notes.md');
    await writeFile(imagePath, 'image bytes');
    await writeFile(filePath, '# notes');
    const attachments = [
      { name: 'provider-image.png', mime: 'image/png', size: 11, localPath: await realpath(imagePath) },
      { name: 'provider-notes.md', mime: 'text/markdown', size: 7, localPath: await realpath(filePath) },
    ];
    const providerInput = (text: string) => [
      { type: 'text', text },
      { type: 'localImage', path: attachments[0]!.localPath },
      { type: 'mention', name: 'provider-notes.md', path: attachments[1]!.localPath },
    ];
    const created = await fixture.server.inject({
      method: 'POST',
      url: `/api/tasks/${fixture.task.id}/conversations`,
      headers: { ...fixture.headers, 'idempotency-key': 'attachment-provider-parent' },
      payload: { mode: 'create', content: '保持首轮 active' },
    });
    const conversation = created.json().conversation;

    const queued = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversation.id}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'attachment-provider-queued' },
      payload: { content: 'queued attachments', attachments, delivery: 'queue' },
    });
    expect(queued.statusCode).toBe(202);
    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 60);
    expect(fixture.manager.turnStarts.at(-1)?.input).toEqual(providerInput('queued attachments'));

    const steered = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversation.id}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'attachment-provider-steered' },
      payload: { content: 'steered attachments', attachments, delivery: 'steer_now', expectedTurnId: 'turn-2' },
    });
    expect(steered.statusCode).toBe(202);
    expect(fixture.manager.steers.at(-1)?.input).toEqual(providerInput('steered attachments'));

    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } }, undefined, 61);
    const idle = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversation.id}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'attachment-provider-idle' },
      payload: { content: 'idle attachments', attachments, delivery: 'queue' },
    });
    expect(idle.statusCode).toBe(202);
    expect(fixture.manager.turnStarts.at(-1)?.input).toEqual(providerInput('idle attachments'));

    await fixture.server.close();
  });

  it('returns the durable native provider and queue snapshots after reconnect', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'snapshot-parent' },
        payload: { mode: 'create', content: 'snapshot parent' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'snapshot-queued' },
      payload: { content: 'durable queued child', delivery: 'queue' },
    });
    await fixture.manager.emit('thread/settings/updated', { threadId: 'thread-1', model: 'gpt-5.4', effort: 'high' }, undefined, 40);
    await fixture.manager.emit('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 } }, undefined, 41);
    await fixture.manager.emit('account/rateLimits/updated', { rateLimits: { primary: { remaining: 73 } } }, undefined, 42);
    await fixture.manager.emit('mcpServer/startupStatus/updated', { statuses: { filesystem: 'ready' } }, undefined, 43);
    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd' }, 'reconnect-command', 44);

    await fixture.server.close();
    class RecoveringFakeCodexManager extends FakeCodexManager {
      override async readThread(input: { threadId: string }) {
        this.reads.push(input.threadId);
        return { id: input.threadId, turns: [{ id: 'turn-1', status: 'running' }] };
      }
    }
    const restartedManager = new RecoveringFakeCodexManager();
    const restarted = await createLocalServer({
      dbPath: join(fixture.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: fixture.directory,
      codexAppServerManager: restartedManager,
    });
    const snapshot = (
      await restarted.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    expect(snapshot).toMatchObject({
      id: conversationId,
      provider: { model: 'gpt-5.4' },
      providerSettings: { generationId: 'generation-api', sequence: 40, model: 'gpt-5.4', effort: 'high' },
      tokenUsage: { generationId: 'generation-api', sequence: 41, inputTokens: 21, outputTokens: 8, totalTokens: 29 },
      rateLimits: { generationId: 'generation-api', sequence: 42, value: { primary: { remaining: 73 } } },
      mcpStartup: { generationId: 'generation-api', sequence: 43, value: { filesystem: 'ready' } },
      queue: {
        state: { type: 'waiting', turnId: 'turn-1', requestId: expect.any(String), reason: 'approval' },
        submissions: expect.arrayContaining([expect.objectContaining({ content: 'durable queued child', status: 'queued' })]),
      },
      requests: [expect.objectContaining({ type: 'command', status: 'pending' })],
    });
    await restarted.close();
  });

  it('exposes only current-generation pending request authority and rejects stale-generation responses as typed 409', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'generation-snapshot-parent' },
        payload: { mode: 'create', content: 'generation snapshot parent' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd' }, 'current-request', 80);
    await fixture.manager.emit('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', path: join(fixture.directory, 'late.txt') }, 'stale-request', 81, 'generation-retired');

    const snapshot = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    const currentRequest = snapshot.requests.find((request: { generationId: string; status: string }) => request.generationId === 'generation-api' && request.status === 'pending');
    const staleRequest = snapshot.requests.find((request: { generationId: string }) => request.generationId === 'generation-retired');
    expect(currentRequest).toBeDefined();
    expect(staleRequest).toMatchObject({ status: 'failed', response: { error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE', recoveryRequired: true } });
    expect(snapshot.queue.state).toMatchObject({ type: 'waiting', requestId: currentRequest.id });

    const currentResponse = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${currentRequest.id}/respond`,
      headers: fixture.headers,
      payload: { type: 'command', decision: 'decline' },
    });
    expect(currentResponse.statusCode).toBe(202);
    const afterCurrent = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    expect(afterCurrent.queue.state).toMatchObject({ type: 'active', turnId: 'turn-1' });

    const staleResponse = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${staleRequest.id}/respond`,
      headers: fixture.headers,
      payload: { type: 'file', decision: 'decline' },
    });
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json()).toMatchObject({ error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE', recoveryRequired: true });
    expect(fixture.manager.responses).toHaveLength(1);
    await fixture.server.close();
  });

  it('edits, reorders, sends, interrupts, and explicitly resumes the durable native queue', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'queue-parent' },
        payload: { mode: 'create', content: 'active parent' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    const queue = async (key: string, content: string) =>
      (
        await fixture.server.inject({
          method: 'POST',
          url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/messages`,
          headers: { ...fixture.headers, 'idempotency-key': key },
          payload: { content, delivery: 'queue' },
        })
      ).json().submission;
    const first = await queue('queue-first', 'first');
    const second = await queue('queue-second', 'second');
    const third = await queue('queue-third', 'third');

    const edited = await fixture.server.inject({
      method: 'PATCH',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/queue/${first.id}`,
      headers: fixture.headers,
      payload: { content: 'first edited' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().submissions.find((submission: { id: string }) => submission.id === first.id)).toMatchObject({ content: 'first edited', status: 'queued' });

    const reordered = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/queue/reorder`,
      headers: fixture.headers,
      payload: { orderedSubmissionIds: [third.id, first.id, second.id] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().submissions.map((submission: { id: string }) => submission.id)).toEqual([third.id, first.id, second.id]);

    const deleted = await fixture.server.inject({
      method: 'DELETE',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/queue/${second.id}`,
      headers: fixture.headers,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().submissions.map((submission: { id: string }) => submission.id)).toEqual([third.id, first.id]);

    const sendNow = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/queue/${third.id}/send-now`,
      headers: fixture.headers,
    });
    expect(sendNow.statusCode).toBe(202);
    expect(sendNow.json()).toMatchObject({ operation: { status: 'accepted' }, submission: { id: third.id, status: 'resolved' } });
    expect(fixture.manager.steers.at(-1)).toEqual({ threadId: 'thread-1', turnId: 'turn-1', clientUserMessageId: third.clientUserMessageId, input: [{ type: 'text', text: 'third' }] });

    const immutable = await fixture.server.inject({
      method: 'PATCH',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/queue/${third.id}`,
      headers: fixture.headers,
      payload: { content: 'must fail' },
    });
    expect(immutable.statusCode).toBe(409);
    expect(immutable.json()).toMatchObject({ error: 'ZEUS_NATIVE_SUBMISSION_NOT_EDITABLE' });

    const interrupt = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/turns/turn-1/interrupt`,
      headers: fixture.headers,
    });
    expect(interrupt.statusCode).toBe(202);
    const interruptBody = interrupt.json();
    expect(interruptBody).toMatchObject({ operation: { status: 'accepted', idempotencyKey: 'turn-1' }, conversation: { id: conversationId } });
    const interruptReplay = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/turns/turn-1/interrupt`,
      headers: fixture.headers,
    });
    expect(interruptReplay.json()).toEqual(interruptBody);
    expect(fixture.manager.interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);

    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } }, undefined, 20);
    const resumed = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/queue/resume`,
      headers: fixture.headers,
    });
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toMatchObject({ conversationId, state: { type: 'active', turnId: 'turn-2' } });
    expect(fixture.manager.turnStarts.at(-1)?.input).toEqual([{ type: 'text', text: 'first edited' }]);

    await fixture.server.close();
  });

  it('rejects a stale interrupt target before touching the current active turn', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'interrupt-target-parent' },
        payload: { mode: 'create', content: 'turn one' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    await fixture.manager.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }, undefined, 80);
    const second = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/messages`,
      headers: { ...fixture.headers, 'idempotency-key': 'interrupt-target-second' },
      payload: { content: 'turn two', delivery: 'queue' },
    });
    expect(second.json()).toMatchObject({ submission: { providerTurnId: 'turn-2', status: 'active' } });

    const stale = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/turns/turn-1/interrupt`,
      headers: fixture.headers,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'ZEUS_NATIVE_TURN_MISMATCH' });
    expect(fixture.manager.interrupts).toEqual([]);

    const current = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/turns/turn-2/interrupt`,
      headers: fixture.headers,
    });
    expect(current.statusCode).toBe(202);
    expect(fixture.manager.interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-2' }]);
    await fixture.server.close();
  });

  it('edits, reorders, and deletes failed submissions while keeping send-now and resume restricted', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'failed-api-parent' },
        payload: { mode: 'create', content: 'active failed parent' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    const queue = async (key: string, content: string) =>
      (
        await fixture.server.inject({
          method: 'POST',
          url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/messages`,
          headers: { ...fixture.headers, 'idempotency-key': key },
          payload: { content, delivery: 'queue' },
        })
      ).json().submission as { id: string };
    const first = await queue('failed-api-first', 'failed first');
    const second = await queue('failed-api-second', 'failed second');
    const third = await queue('failed-api-third', 'failed third');
    await fixture.server.close();

    const db = await createZeusDatabase(join(fixture.directory, 'zeus.db'));
    const submissions = new ConversationSubmissionRepository(db);
    for (const submission of [first, second, third]) submissions.updateStatus(submission.id, 'failed', { error: { code: 'PROVIDER_FAILED' } });
    await db.save();

    class RecoveringFakeCodexManager extends FakeCodexManager {
      override async readThread(input: { threadId: string }) {
        this.reads.push(input.threadId);
        return { id: input.threadId, turns: [{ id: 'turn-1', status: 'running' }] };
      }
    }
    const restarted = await createLocalServer({
      dbPath: join(fixture.directory, 'zeus.db'),
      apiToken: 'native-api-token',
      projectRoot: fixture.directory,
      codexAppServerManager: new RecoveringFakeCodexManager(),
    });
    const baseUrl = `/api/projects/${fixture.project.id}/conversations/${conversationId}`;
    const edited = await restarted.inject({ method: 'PATCH', url: `${baseUrl}/queue/${first.id}`, headers: fixture.headers, payload: { content: 'failed first edited' } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().submissions.find((submission: { id: string }) => submission.id === first.id)).toMatchObject({ content: 'failed first edited', status: 'failed' });

    const reordered = await restarted.inject({
      method: 'POST',
      url: `${baseUrl}/queue/reorder`,
      headers: fixture.headers,
      payload: { orderedSubmissionIds: [third.id, first.id, second.id] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().submissions.map((submission: { id: string }) => submission.id)).toEqual([third.id, first.id, second.id]);

    const sendNow = await restarted.inject({ method: 'POST', url: `${baseUrl}/queue/${third.id}/send-now`, headers: fixture.headers });
    expect(sendNow.statusCode).toBe(409);
    expect(sendNow.json()).toMatchObject({ error: 'ZEUS_NATIVE_SUBMISSION_NOT_QUEUED' });
    const resume = await restarted.inject({ method: 'POST', url: `${baseUrl}/queue/resume`, headers: fixture.headers });
    expect(resume.statusCode).toBe(409);
    expect(resume.json()).toMatchObject({ error: 'ZEUS_NATIVE_QUEUE_NOT_INTERRUPTED' });

    const deleted = await restarted.inject({ method: 'DELETE', url: `${baseUrl}/queue/${second.id}`, headers: fixture.headers });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().submissions.map((submission: { id: string }) => submission.id)).toEqual([third.id, first.id]);
    await restarted.close();
  });

  it('keeps the original API request authority when a provider reuses one generation-scoped id with conflicting method or payload', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'request-identity-parent' },
        payload: { mode: 'create', content: 'request identity parent' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    const originalPayload = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      command: ['/bin/echo', 'safe'],
      metadata: { cwd: fixture.directory, timeoutMs: 1_000 },
      availableDecisions: ['accept', 'decline', 'cancel'],
    };

    await fixture.manager.emit('item/commandExecution/requestApproval', originalPayload, 'provider-request-identity', 30);
    await fixture.manager.emit(
      'item/commandExecution/requestApproval',
      {
        metadata: { timeoutMs: 1_000, cwd: fixture.directory },
        command: ['/bin/echo', 'safe'],
        turnId: 'turn-1',
        threadId: 'thread-1',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
      'provider-request-identity',
      31,
    );
    await fixture.manager.emit('item/fileChange/requestApproval', originalPayload, 'provider-request-identity', 32);
    await fixture.manager.emit('item/commandExecution/requestApproval', { ...originalPayload, command: ['/bin/echo', 'mutated'] }, 'provider-request-identity', 33);

    const snapshot = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    const matchingRequests = snapshot.requests.filter((request: { generationId: string; payload: { threadId?: string } }) => request.generationId === 'generation-api' && request.payload.threadId === 'thread-1');
    expect(matchingRequests).toHaveLength(1);
    expect(matchingRequests[0]).toMatchObject({
      type: 'command',
      status: 'pending',
      payload: originalPayload,
      createdAt: '2026-07-13T06:00:30.000Z',
    });

    await fixture.server.close();
  });

  it('accepts tagged request responses with replay idempotency and payload conflict detection', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'request-parent' },
        payload: { mode: 'create', content: 'request parent' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: '/bin/pwd', availableDecisions: ['accept', 'decline', 'cancel'] }, 'command-request', 30);
    let snapshot = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    const commandRequest = snapshot.requests.find((request: { type: string }) => request.type === 'command');
    const commandBody = { type: 'command', decision: 'accept' };
    const commandResponse = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${commandRequest.id}/respond`,
      headers: fixture.headers,
      payload: commandBody,
    });
    expect(commandResponse.statusCode).toBe(202);
    const commandAccepted = commandResponse.json();
    expect(commandAccepted).toMatchObject({ operation: { status: 'accepted', idempotencyKey: commandRequest.id }, request: { id: commandRequest.id, type: 'command', status: 'resolved' } });
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'accept' });

    const commandReplay = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${commandRequest.id}/respond`,
      headers: fixture.headers,
      payload: commandBody,
    });
    expect(commandReplay.json()).toEqual(commandAccepted);
    expect(fixture.manager.responses).toHaveLength(1);

    const commandConflict = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${commandRequest.id}/respond`,
      headers: fixture.headers,
      payload: { type: 'command', decision: 'decline' },
    });
    expect(commandConflict.statusCode).toBe(409);
    expect(commandConflict.json()).toMatchObject({ error: 'ZEUS_IDEMPOTENCY_CONFLICT' });

    await fixture.manager.emit('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', path: join(fixture.directory, 'allowed.txt') }, 'file-request', 31);
    snapshot = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    const fileRequest = snapshot.requests.find((request: { type: string }) => request.type === 'file');
    const fileBody = { type: 'file', decision: 'accept' };
    const fileResponse = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${fileRequest.id}/respond`,
      headers: fixture.headers,
      payload: fileBody,
    });
    expect(fileResponse.statusCode).toBe(202);
    const fileAccepted = fileResponse.json();
    expect(fileAccepted).toMatchObject({
      operation: { status: 'accepted', idempotencyKey: fileRequest.id },
      request: { id: fileRequest.id, type: 'file', status: 'resolved', response: { type: 'file', decision: 'accept' } },
    });
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'file', decision: 'accept' });
    const fileResponseCount = fixture.manager.responses.length;
    const fileReplay = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${fileRequest.id}/respond`,
      headers: fixture.headers,
      payload: fileBody,
    });
    expect(fileReplay.json()).toEqual(fileAccepted);
    expect(fixture.manager.responses).toHaveLength(fileResponseCount);
    const fileConflict = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${fileRequest.id}/respond`,
      headers: fixture.headers,
      payload: { type: 'file', decision: 'decline' },
    });
    expect(fileConflict.statusCode).toBe(409);
    expect(fileConflict.json()).toMatchObject({ error: 'ZEUS_IDEMPOTENCY_CONFLICT' });

    const requestedPermissions = {
      network: { enabled: false },
      fileSystem: { read: [fixture.directory], write: [fixture.directory], globScanMaxDepth: 2 },
    };
    await fixture.manager.emit('item/permissions/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', permissions: requestedPermissions }, 'permissions-request', 32);
    snapshot = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    const permissionsRequest = snapshot.requests.find((request: { type: string }) => request.type === 'permissions');
    const permissionsBody = { type: 'permissions', permissions: requestedPermissions, scope: 'turn' };
    const permissionsResponse = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${permissionsRequest.id}/respond`,
      headers: fixture.headers,
      payload: permissionsBody,
    });
    expect(permissionsResponse.statusCode).toBe(202);
    const permissionsAccepted = permissionsResponse.json();
    expect(permissionsAccepted).toMatchObject({
      operation: { status: 'accepted', idempotencyKey: permissionsRequest.id },
      request: {
        id: permissionsRequest.id,
        type: 'permissions',
        status: 'resolved',
        response: { type: 'permissions', permissions: requestedPermissions, scope: 'turn' },
      },
    });
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'permissions', permissions: requestedPermissions, scope: 'turn' });
    const permissionsResponseCount = fixture.manager.responses.length;
    const permissionsReplay = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${permissionsRequest.id}/respond`,
      headers: fixture.headers,
      payload: permissionsBody,
    });
    expect(permissionsReplay.json()).toEqual(permissionsAccepted);
    expect(fixture.manager.responses).toHaveLength(permissionsResponseCount);
    const permissionsConflict = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${permissionsRequest.id}/respond`,
      headers: fixture.headers,
      payload: { ...permissionsBody, scope: 'session' },
    });
    expect(permissionsConflict.statusCode).toBe(409);
    expect(permissionsConflict.json()).toMatchObject({ error: 'ZEUS_IDEMPOTENCY_CONFLICT' });

    await fixture.manager.emit('item/permissions/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', permissions: requestedPermissions }, 'permissions-exceeds-request', 34);
    snapshot = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    const exceedsRequest = snapshot.requests.find((request: { type: string; status: string }) => request.type === 'permissions' && request.status === 'pending');
    const providerResponsesBeforeExceededGrant = fixture.manager.responses.length;
    const exceededGrant = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${exceedsRequest.id}/respond`,
      headers: fixture.headers,
      payload: {
        type: 'permissions',
        permissions: { ...requestedPermissions, fileSystem: { ...requestedPermissions.fileSystem, globScanMaxDepth: 3 } },
        scope: 'turn',
      },
    });
    expect(exceededGrant.statusCode).toBe(409);
    expect(exceededGrant.json()).toMatchObject({ error: 'ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_REQUEST' });
    expect(fixture.manager.responses).toHaveLength(providerResponsesBeforeExceededGrant);

    await fixture.manager.emit(
      'item/tool/requestUserInput',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'user-input-item',
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Choose',
            options: [
              { label: 'A', description: '' },
              { label: 'B', description: '' },
            ],
            isOther: false,
            isSecret: false,
          },
        ],
        autoResolutionMs: null,
      },
      'user-input-request',
      33,
    );
    snapshot = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    const userInputRequest = snapshot.requests.find((request: { type: string }) => request.type === 'userInput');
    const userInput = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${userInputRequest.id}/respond`,
      headers: fixture.headers,
      payload: { type: 'userInput', answers: { choice: { answers: ['A'] } } },
    });
    expect(userInput.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'request_user_input', answers: { choice: { answers: ['A'] } } });

    await fixture.manager.emit(
      'mcpServer/elicitation/request',
      { threadId: 'thread-1', turnId: 'turn-1', serverName: 'filesystem', mode: 'form', message: 'Choose', requestedSchema: { type: 'object', properties: {} }, _meta: null },
      'mcp-request',
      34,
    );
    snapshot = (
      await fixture.server.inject({
        method: 'GET',
        url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
        headers: fixture.headers,
      })
    ).json();
    const mcpRequest = snapshot.requests.find((request: { type: string }) => request.type === 'MCP');
    const mcp = await fixture.server.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${mcpRequest.id}/respond`,
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'decline', content: null, _meta: null },
    });
    expect(mcp.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'mcp', action: 'decline', content: null, _meta: null });

    await fixture.server.close();
  });

  it('rejects direct file accepts when the provider requests grantRoot while allowing decline', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'file-grant-root-parent' },
        payload: { mode: 'create', content: 'file grant root parent' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    const responseUrl = (requestId: string) => `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${requestId}/respond`;
    const pendingFileRequest = async () => {
      const snapshot = (
        await fixture.server.inject({
          method: 'GET',
          url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
          headers: fixture.headers,
        })
      ).json();
      return snapshot.requests.find((request: { type: string; status: string }) => request.type === 'file' && request.status === 'pending') as { id: string };
    };

    await fixture.manager.emit(
      'item/fileChange/requestApproval',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-grant-root',
        startedAtMs: 1,
        reason: null,
        grantRoot: fixture.directory,
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
      'file-grant-root',
      50,
    );
    const request = await pendingFileRequest();
    const responsesBeforeAccept = fixture.manager.responses.length;
    const accept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(request.id),
      headers: fixture.headers,
      payload: { type: 'file', decision: 'accept' },
    });
    expect(accept.statusCode).toBe(400);
    expect(accept.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
    expect(fixture.manager.responses).toHaveLength(responsesBeforeAccept);
    expect((await pendingFileRequest()).id).toBe(request.id);

    const decline = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(request.id),
      headers: fixture.headers,
      payload: { type: 'file', decision: 'decline' },
    });
    expect(decline.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'file', decision: 'decline' });

    await fixture.server.close();
  });

  it('rejects openai/form required keys inherited from Object.prototype while allowing fail-closed responses', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'prototype-required-parent' },
        payload: { mode: 'create', content: 'prototype required parent' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    const responseUrl = (requestId: string) => `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${requestId}/respond`;
    const pendingMcpRequest = async () => {
      const snapshot = (
        await fixture.server.inject({
          method: 'GET',
          url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
          headers: fixture.headers,
        })
      ).json();
      return snapshot.requests.find((request: { type: string; status: string }) => request.type === 'MCP' && request.status === 'pending') as { id: string };
    };

    for (const [index, requiredKey] of ['toString', 'constructor'].entries()) {
      await fixture.manager.emit(
        'mcpServer/elicitation/request',
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'filesystem',
          mode: 'openai/form',
          message: `Own property required: ${requiredKey}`,
          requestedSchema: { type: 'object', properties: {}, required: [requiredKey], additionalProperties: false },
          _meta: null,
        },
        `openai-form-prototype-required-${index}`,
        50 + index,
      );
      const request = await pendingMcpRequest();
      const responsesBeforeAccept = fixture.manager.responses.length;
      const accept = await fixture.server.inject({
        method: 'POST',
        url: responseUrl(request.id),
        headers: fixture.headers,
        payload: { type: 'MCP', action: 'accept', content: {}, _meta: null },
      });
      expect(accept.statusCode).toBe(400);
      expect(accept.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
      expect(fixture.manager.responses).toHaveLength(responsesBeforeAccept);
      expect((await pendingMcpRequest()).id).toBe(request.id);

      const action = index === 0 ? 'decline' : 'cancel';
      const reject = await fixture.server.inject({
        method: 'POST',
        url: responseUrl(request.id),
        headers: fixture.headers,
        payload: { type: 'MCP', action, content: null, _meta: null },
      });
      expect(reject.statusCode).toBe(202);
      expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'mcp', action, content: null, _meta: null });
    }

    await fixture.server.close();
  });

  it('accepts canonical form content when optional prototype-named properties are absent', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'prototype-optional-parent' },
        payload: { mode: 'create', content: 'prototype optional parent' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    const responseUrl = (requestId: string) => `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${requestId}/respond`;
    const pendingMcpRequest = async () => {
      const snapshot = (
        await fixture.server.inject({
          method: 'GET',
          url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
          headers: fixture.headers,
        })
      ).json();
      return snapshot.requests.find((request: { type: string; status: string }) => request.type === 'MCP' && request.status === 'pending') as { id: string };
    };

    for (const [index, optionalKey] of ['toString', 'constructor'].entries()) {
      await fixture.manager.emit(
        'mcpServer/elicitation/request',
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'filesystem',
          mode: 'form',
          message: `Optional own property: ${optionalKey}`,
          requestedSchema: { type: 'object', properties: { [optionalKey]: { type: 'string' } }, required: [] },
          _meta: null,
        },
        `canonical-form-prototype-optional-${index}`,
        60 + index,
      );
      const request = await pendingMcpRequest();
      const accept = await fixture.server.inject({
        method: 'POST',
        url: responseUrl(request.id),
        headers: fixture.headers,
        payload: { type: 'MCP', action: 'accept', content: {}, _meta: null },
      });
      expect(accept.statusCode).toBe(202);
      expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'mcp', action: 'accept', content: {}, _meta: null });
    }

    await fixture.server.close();
  });

  it('rejects renderer-bypass accepts for incomplete approvals and schema-invalid MCP content while keeping decline and cancel available', async () => {
    const fixture = await createApiFixture();
    const created = (
      await fixture.server.inject({
        method: 'POST',
        url: `/api/tasks/${fixture.task.id}/conversations`,
        headers: { ...fixture.headers, 'idempotency-key': 'authority-parent' },
        payload: { mode: 'create', content: 'authority parent' },
      })
    ).json();
    const conversationId = created.conversation.id as string;
    const responseUrl = (requestId: string) => `/api/projects/${fixture.project.id}/conversations/${conversationId}/requests/${requestId}/respond`;
    const pendingRequest = async (type: string) => {
      const snapshot = (
        await fixture.server.inject({
          method: 'GET',
          url: `/api/projects/${fixture.project.id}/conversations/${conversationId}`,
          headers: fixture.headers,
        })
      ).json();
      return snapshot.requests.find((request: { type: string; status: string }) => request.type === type && request.status === 'pending') as { id: string };
    };

    await fixture.manager.emit('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-no-decisions', command: '/bin/pwd' }, 'command-no-decisions', 50);
    const commandRequest = await pendingRequest('command');
    const commandAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(commandRequest.id),
      headers: fixture.headers,
      payload: { type: 'command', decision: 'accept' },
    });
    expect(commandAccept.statusCode).toBe(400);
    expect(commandAccept.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
    expect(fixture.manager.responses).toHaveLength(0);
    expect((await pendingRequest('command')).id).toBe(commandRequest.id);
    const commandDecline = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(commandRequest.id),
      headers: fixture.headers,
      payload: { type: 'command', decision: 'decline' },
    });
    expect(commandDecline.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'decline' });

    await fixture.manager.emit('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-no-target', startedAtMs: 1, grantRoot: null }, 'file-no-target', 51);
    const fileRequest = await pendingRequest('file');
    const fileAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(fileRequest.id),
      headers: fixture.headers,
      payload: { type: 'file', decision: 'accept' },
    });
    expect(fileAccept.statusCode).toBe(400);
    expect(fileAccept.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
    expect(fixture.manager.responses).toHaveLength(1);
    expect((await pendingRequest('file')).id).toBe(fileRequest.id);
    const fileCancel = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(fileRequest.id),
      headers: fixture.headers,
      payload: { type: 'file', decision: 'cancel' },
    });
    expect(fileCancel.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'file', decision: 'cancel' });

    await fixture.manager.emit(
      'mcpServer/elicitation/request',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'filesystem',
        mode: 'form',
        message: 'Choose',
        requestedSchema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'] },
        _meta: null,
      },
      'mcp-schema-invalid',
      52,
    );
    const mcpRequest = await pendingRequest('MCP');
    const mcpAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(mcpRequest.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'accept', content: {}, _meta: null },
    });
    expect(mcpAccept.statusCode).toBe(400);
    expect(mcpAccept.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
    expect(fixture.manager.responses).toHaveLength(2);
    expect((await pendingRequest('MCP')).id).toBe(mcpRequest.id);
    const mcpDecline = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(mcpRequest.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'decline', content: null, _meta: null },
    });
    expect(mcpDecline.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'mcp', action: 'decline', content: null, _meta: null });

    await fixture.manager.emit(
      'item/commandExecution/requestApproval',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'canonical-command',
        startedAtMs: 1,
        environmentId: null,
        reason: null,
        command: '/bin/pwd',
        cwd: null,
        commandActions: null,
        additionalPermissions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
      'canonical-command',
      53,
    );
    const canonicalCommand = await pendingRequest('command');
    const canonicalCommandAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(canonicalCommand.id),
      headers: fixture.headers,
      payload: { type: 'command', decision: 'accept' },
    });
    expect(canonicalCommandAccept.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'command', decision: 'accept' });

    const canonicalFilePath = join(fixture.directory, 'canonical-file.txt');
    await fixture.manager.emit(
      'item/started',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'canonical-file-item', type: 'fileChange', changes: [{ path: canonicalFilePath, kind: 'add', diff: '+safe' }] },
      },
      undefined,
      54,
    );
    await fixture.manager.emit('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'canonical-file-item', startedAtMs: 2, reason: null, grantRoot: null }, 'canonical-file', 55);
    const canonicalFile = await pendingRequest('file');
    const responsesBeforeFileSessionGrant = fixture.manager.responses.length;
    const canonicalFileSessionAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(canonicalFile.id),
      headers: fixture.headers,
      payload: { type: 'file', decision: 'acceptForSession' },
    });
    expect(canonicalFileSessionAccept.statusCode).toBe(400);
    expect(canonicalFileSessionAccept.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
    expect(fixture.manager.responses).toHaveLength(responsesBeforeFileSessionGrant);
    expect((await pendingRequest('file')).id).toBe(canonicalFile.id);
    const canonicalFileAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(canonicalFile.id),
      headers: fixture.headers,
      payload: { type: 'file', decision: 'accept' },
    });
    expect(canonicalFileAccept.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'file', decision: 'accept' });

    await fixture.manager.emit(
      'mcpServer/elicitation/request',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'filesystem',
        mode: 'form',
        message: 'Email',
        requestedSchema: { type: 'object', properties: { email: { type: 'string', format: 'email' } }, required: ['email'] },
        _meta: null,
      },
      'canonical-mcp-format',
      56,
    );
    const canonicalMcp = await pendingRequest('MCP');
    const responsesBeforeMetaInjection = fixture.manager.responses.length;
    const injectedMeta = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(canonicalMcp.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'accept', content: { email: 'safe@example.com' }, _meta: { injected: true } },
    });
    expect(injectedMeta.statusCode).toBe(400);
    expect(injectedMeta.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
    expect(fixture.manager.responses).toHaveLength(responsesBeforeMetaInjection);
    const canonicalMcpAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(canonicalMcp.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'accept', content: { email: 'safe@example.com' }, _meta: null },
    });
    expect(canonicalMcpAccept.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'mcp', action: 'accept', content: { email: 'safe@example.com' }, _meta: null });

    await fixture.manager.emit(
      'mcpServer/elicitation/request',
      { threadId: 'thread-1', turnId: 'turn-1', serverName: 'filesystem', mode: 'openai/form', message: 'Any JSON', requestedSchema: {}, _meta: null },
      'openai-form-empty-schema',
      57,
    );
    const openAiForm = await pendingRequest('MCP');
    const openAiFormAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(openAiForm.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'accept', content: 42, _meta: null },
    });
    expect(openAiFormAccept.statusCode).toBe(202);
    expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'mcp', action: 'accept', content: 42, _meta: null });

    await fixture.manager.emit(
      'mcpServer/elicitation/request',
      { threadId: 'thread-1', turnId: 'turn-1', serverName: 'filesystem', mode: 'openai/form', message: 'Unsupported', requestedSchema: { oneOf: [] }, _meta: null },
      'openai-form-unknown-keyword',
      58,
    );
    const unsupportedOpenAiForm = await pendingRequest('MCP');
    const responsesBeforeUnknownSchema = fixture.manager.responses.length;
    const unknownSchemaAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(unsupportedOpenAiForm.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'accept', content: 42, _meta: null },
    });
    expect(unknownSchemaAccept.statusCode).toBe(400);
    expect(unknownSchemaAccept.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
    expect(fixture.manager.responses).toHaveLength(responsesBeforeUnknownSchema);
    const unknownSchemaCancel = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(unsupportedOpenAiForm.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'cancel', content: null, _meta: null },
    });
    expect(unknownSchemaCancel.statusCode).toBe(202);

    await fixture.manager.emit(
      'mcpServer/elicitation/request',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        mode: 'form',
        message: 'Missing server',
        requestedSchema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'] },
        _meta: null,
      },
      'mcp-missing-envelope-field',
      59,
    );
    const missingEnvelope = await pendingRequest('MCP');
    const responsesBeforeMissingEnvelope = fixture.manager.responses.length;
    const missingEnvelopeAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(missingEnvelope.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'accept', content: { choice: 'A' }, _meta: null },
    });
    expect(missingEnvelopeAccept.statusCode).toBe(400);
    expect(missingEnvelopeAccept.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
    expect(fixture.manager.responses).toHaveLength(responsesBeforeMissingEnvelope);
    const missingEnvelopeDecline = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(missingEnvelope.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'decline', content: null, _meta: null },
    });
    expect(missingEnvelopeDecline.statusCode).toBe(202);

    await fixture.manager.emit(
      'mcpServer/elicitation/request',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'filesystem',
        mode: 'form',
        message: 'Extra field',
        requestedSchema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'] },
        _meta: null,
        unexpected: true,
      },
      'mcp-extra-envelope-field',
      60,
    );
    const extraEnvelopeField = await pendingRequest('MCP');
    const responsesBeforeExtraEnvelope = fixture.manager.responses.length;
    const extraEnvelopeAccept = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(extraEnvelopeField.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'accept', content: { choice: 'A' }, _meta: null },
    });
    expect(extraEnvelopeAccept.statusCode).toBe(400);
    expect(extraEnvelopeAccept.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
    expect(fixture.manager.responses).toHaveLength(responsesBeforeExtraEnvelope);
    const extraEnvelopeCancel = await fixture.server.inject({
      method: 'POST',
      url: responseUrl(extraEnvelopeField.id),
      headers: fixture.headers,
      payload: { type: 'MCP', action: 'cancel', content: null, _meta: null },
    });
    expect(extraEnvelopeCancel.statusCode).toBe(202);

    const dateTimeSchema = { type: 'object', properties: { when: { type: 'string', format: 'date-time' } }, required: ['when'] };
    for (const [index, value] of ['2026-02-28T10:20:30Z', '2026-02-28T10:20:30+08:00'].entries()) {
      await fixture.manager.emit(
        'mcpServer/elicitation/request',
        { threadId: 'thread-1', turnId: 'turn-1', serverName: 'filesystem', mode: 'form', message: 'Date time', requestedSchema: dateTimeSchema, _meta: null },
        `mcp-valid-date-time-${index}`,
        61 + index,
      );
      const validDateTime = await pendingRequest('MCP');
      const acceptedDateTime = await fixture.server.inject({
        method: 'POST',
        url: responseUrl(validDateTime.id),
        headers: fixture.headers,
        payload: { type: 'MCP', action: 'accept', content: { when: value }, _meta: null },
      });
      expect(acceptedDateTime.statusCode).toBe(202);
      expect(fixture.manager.responses.at(-1)).toMatchObject({ type: 'mcp', action: 'accept', content: { when: value }, _meta: null });
    }

    for (const [index, value] of ['2026-02-30T10:20:30Z', '2026-02-28T10:20:30', '2026-02-28T24:00:00Z'].entries()) {
      await fixture.manager.emit(
        'mcpServer/elicitation/request',
        { threadId: 'thread-1', turnId: 'turn-1', serverName: 'filesystem', mode: 'form', message: 'Date time', requestedSchema: dateTimeSchema, _meta: null },
        `mcp-invalid-date-time-${index}`,
        63 + index,
      );
      const invalidDateTime = await pendingRequest('MCP');
      const responsesBeforeInvalidDateTime = fixture.manager.responses.length;
      const rejectedDateTime = await fixture.server.inject({
        method: 'POST',
        url: responseUrl(invalidDateTime.id),
        headers: fixture.headers,
        payload: { type: 'MCP', action: 'accept', content: { when: value }, _meta: null },
      });
      expect(rejectedDateTime.statusCode).toBe(400);
      expect(rejectedDateTime.json()).toMatchObject({ error: 'ZEUS_INVALID_SERVER_REQUEST_RESPONSE' });
      expect(fixture.manager.responses).toHaveLength(responsesBeforeInvalidDateTime);
      const cancelInvalidDateTime = await fixture.server.inject({
        method: 'POST',
        url: responseUrl(invalidDateTime.id),
        headers: fixture.headers,
        payload: { type: 'MCP', action: 'cancel', content: null, _meta: null },
      });
      expect(cancelInvalidDateTime.statusCode).toBe(202);
    }

    await fixture.server.close();
  });
});
