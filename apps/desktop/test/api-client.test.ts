import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startZeusLocalServer } from '../../../packages/local-server/src/index.js';
import { createDashboardClient, ZeusApiError } from '../src/renderer/apiClient.js';
import type { SecretStore } from '@zeus/security-core';
import type { AiRuntimeProcessHandle, AiRuntimeSpawn } from '@zeus/ai-runtime';

function createMemorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    async setSecret(account, value) {
      values.set(account, value);
    },
    async getSecret(account) {
      return values.get(account);
    },
    async deleteSecret(account) {
      values.delete(account);
    },
  };
}

function createGraphAnswerSpawn(): AiRuntimeSpawn {
  return (_command, args) => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 616,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        return handle;
      },
      kill() {},
    };
    queueMicrotask(() => {
      callbacks.get('stdout')?.forEach((callback) => callback(`AI 图谱回答：${args.join(' ').includes('local-server') ? 'local-server 来源已核验' : '不足以判断'}`));
      callbacks.get('exit')?.forEach((callback) => callback(0));
    });
    return handle;
  };
}

async function selectLegacyCliTestAdapter(client: ReturnType<typeof createDashboardClient>): Promise<void> {
  const settings = await client.loadRuntimeSettings();
  await client.saveRuntimeSettings({ ...settings, defaultAdapterId: 'claude' });
}

describe('renderer dashboard API client', () => {
  it('loads and starts project-scoped conversations without routing through task APIs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ operation: { status: 'accepted' }, conversation: { id: 'project-conversation-1', taskId: null }, submission: { id: 'submission-1' } }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ projectId: 'project-1', choices: [], items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const client = createDashboardClient({ baseUrl: 'http://127.0.0.1:3210', apiToken: 'client-token' });
      await client.loadProjectConversationChoices('project-1');
      await client.startProjectConversation('project-1', {
        mode: 'create',
        content: '自由输入项目问题',
        attachments: [],
        permissionMode: 'auto',
        idempotencyKey: 'project-start-key',
        clientUserMessageId: 'project-client-message',
      });

      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3210/api/projects/project-1/conversation-choices');
      expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:3210/api/projects/project-1/conversations');
      expect(fetchMock.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'idempotency-key': 'project-start-key' }),
        }),
      );
      expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
        mode: 'create',
        content: '自由输入项目问题',
        attachments: [],
        permissionMode: 'auto',
        clientUserMessageId: 'project-client-message',
      });
      expect(fetchMock.mock.calls.flatMap(([url]) => String(url))).not.toContain('/api/tasks/');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('sends stable native identities in the header and body without widening Graph conversation types', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ operation: { status: 'active' }, conversation: { id: 'conversation-1' }, submission: { id: 'submission-1' } }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const client = createDashboardClient({ baseUrl: 'http://127.0.0.1:3210', apiToken: 'client-token' });
      await client.sendNativeMessage('project-1', 'conversation-1', {
        content: 'continue the same thread',
        attachments: [],
        delivery: 'queue',
        idempotencyKey: 'stable-idempotency',
        clientUserMessageId: 'stable-client-message',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3210/api/projects/project-1/conversations/conversation-1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ authorization: 'Bearer client-token', 'idempotency-key': 'stable-idempotency' }),
        }),
      );
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
      expect(body).toEqual({ content: 'continue the same thread', attachments: [], delivery: 'queue', clientUserMessageId: 'stable-client-message' });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('forwards the real local-server pending-request response wire schema unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ operation: { status: 'responded' }, request: { id: 'request-1', status: 'resolved' } }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    try {
      const client = createDashboardClient({ baseUrl: 'http://127.0.0.1:3210', apiToken: 'client-token' });
      const responses = [
        { type: 'userInput', answers: { scope: { answers: ['workspace'] } } },
        { type: 'MCP', action: 'decline', content: null, _meta: null },
        { type: 'permissions', permissions: {}, scope: 'turn' },
      ];
      for (const response of responses) await client.respondToNativeRequest('project-1', 'conversation-1', 'request-1', response);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const [index, response] of responses.entries()) {
        expect(fetchMock.mock.calls[index]?.[0]).toBe('http://127.0.0.1:3210/api/projects/project-1/conversations/conversation-1/requests/request-1/respond');
        expect(JSON.parse(String((fetchMock.mock.calls[index]?.[1] as RequestInit).body))).toEqual(response);
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('preserves typed native API status, error code, and recoveryRequired metadata', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE', message: 'retired generation', recoveryRequired: true }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const client = createDashboardClient({ baseUrl: 'http://127.0.0.1:3210', apiToken: 'client-token' });
      const failure = await client.loadNativeConversation('project-1', 'conversation-1').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ZeusApiError);
      expect(failure).toMatchObject({ status: 409, error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE', recoveryRequired: true, message: 'retired generation' });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('fail-closes an idempotency recovery response from its code and operation status even when the boolean is absent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED',
          message: 'provider outcome is unknown',
          operation: { id: 'operation-1', status: 'recovery_required', idempotencyKey: 'stable-key' },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      const client = createDashboardClient({ baseUrl: 'http://127.0.0.1:3210', apiToken: 'client-token' });
      const failure = await client.loadNativeConversation('project-1', 'conversation-1').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ZeusApiError);
      expect(failure).toMatchObject({ status: 409, error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED', recoveryRequired: true, message: 'provider outcome is unknown' });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('connects to the local WebSocket event stream with token subprotocols', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-events-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const socket = client.connectEvents((event) => events.push(event));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket connection')), 2_000);
        const timer = setInterval(() => {
          if (events.some((event) => event.type === 'server.connected')) {
            clearInterval(timer);
            clearTimeout(timeout);
            resolve(undefined);
          }
        }, 10);
      });

      await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实当前仓库',
      });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for project.created event')), 2_000);
        const timer = setInterval(() => {
          if (events.some((event) => event.type === 'project.created')) {
            clearInterval(timer);
            clearTimeout(timeout);
            resolve(undefined);
          }
        }, 10);
      });

      expect(events.map((event) => event.type)).toContain('project.created');
      expect(JSON.stringify(events)).not.toContain('client-token');
      socket.close();
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('loads dashboard snapshot from the real local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const snapshot = await client.loadDashboard();
      expect(snapshot.app).toBe('Zeus');
      expect(snapshot.localServer.host).toBe('127.0.0.1');
      expect(snapshot.projects).toHaveLength(0);
      expect(snapshot.git.isRepository).toBe(true);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads project-scoped scan, scan status, and overview through the local API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-project-overview-'));
    const serviceRoot = join(dir, 'service-root');
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(serviceRoot, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      await writeFile(join(projectRoot, 'project-client.ts'), 'export function projectClientOverviewRealSource() { return 1; }');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: serviceRoot,
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Client Project Overview',
        localPath: projectRoot,
      });

      const scan = await client.scanProject(project.id);
      const status = await client.loadProjectScanStatus(project.id);
      const overview = await client.loadProjectOverview(project.id);

      expect(scan.rootPath).toBe(projectRoot);
      expect(scan.fileCount).toBe(1);
      expect(status.scanStatus).toBe('completed');
      expect(overview.project.id).toBe(project.id);
      expect(overview.graph.nodeCount).toBe(scan.nodeCount);
      expect(overview.tasks.total).toBe(0);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refreshes the local server config and retries once after the previous baseUrl is closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-recover-'));
    try {
      const dbPath = join(dir, 'zeus.db');
      const first = await startZeusLocalServer({
        dbPath,
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const second = await startZeusLocalServer({
        dbPath,
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: first.baseUrl,
        apiToken: 'client-token',
        refreshLocalServerConfig: async () => ({
          baseUrl: second.baseUrl,
          apiToken: 'client-token',
        }),
      });

      await first.close();

      const snapshot = await client.loadDashboard();

      expect(snapshot.app).toBe('Zeus');
      expect(snapshot.localServer.port).toBe(new URL(second.baseUrl).port ? Number(new URL(second.baseUrl).port) : null);
      const events: string[] = [];
      const socket = client.connectEvents((event) => events.push(event.type), { afterEventId: 'last-native-event' });
      await vi.waitFor(() => expect(events).toContain('server.connected'));
      expect(socket.url).toContain(second.baseUrl.replace(/^http/u, 'ws'));
      expect(socket.url).toContain('afterEventId=last-native-event');
      socket.close();
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('triggers a real graph scan through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-scan-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const result = await client.scanCurrentGraph();
      expect(result.nodeCount).toBeGreaterThan(0);
      expect(result.edgeCount).toBeGreaterThan(0);
      const snapshot = await client.loadDashboard();
      expect(snapshot.graph.nodeCount).toBe(result.nodeCount);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a real project and task through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-create-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实当前仓库',
      });
      expect(project.name).toBe('Zeus');
      const task = await client.createTask({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '基于真实扫描和 Git 状态分析当前 Zeus 仓库',
        sourceContext: { path: '/Users/david/hypha/zeus' },
      });
      expect(task.projectId).toBe(project.id);
      const snapshot = await client.loadDashboard();
      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.tasks).toHaveLength(1);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('archives a project through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-project-archive-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实当前仓库',
      });
      await client.createTask({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '基于真实扫描和 Git 状态分析当前 Zeus 仓库',
        sourceContext: { path: '/Users/david/hypha/zeus' },
      });

      const archived = await client.archiveProject(project.id);

      expect(archived.id).toBe(project.id);
      const dashboard = await client.loadDashboard();
      expect(dashboard.projects).toHaveLength(0);
      expect(dashboard.tasks).toHaveLength(0);
      expect((await client.loadArchivedProjects()).map((item) => item.id)).toEqual([project.id]);
      const restored = await client.restoreProject(project.id);
      expect(restored.id).toBe(project.id);
      expect((await client.loadDashboard()).projects).toHaveLength(1);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads and saves project configuration through the renderer client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-project-config-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实当前仓库',
        defaultModel: 'gpt-5.1-codex',
        defaultWorkMode: 'review',
        defaultTaskPrompt: '创建时默认提示词',
      });

      const defaultConfig = await client.loadProjectConfig(project.id);
      expect(defaultConfig).toMatchObject({
        projectId: project.id,
        defaultModel: 'gpt-5.1-codex',
        defaultWorkMode: 'review',
        defaultTaskPrompt: '创建时默认提示词',
        language: { primary: 'typescript' },
        vcs: { isGitRepository: true, gitRoot: '/Users/david/hypha/zeus' },
      });

      const saved = await client.saveProjectConfig(project.id, {
        defaultModel: 'gpt-5.1-codex',
        defaultWorkMode: 'debug',
        defaultTaskPrompt: '保留真实证据链',
        scan: { ignoreDirectories: ['node_modules'], indexScope: 'src' },
        language: { primary: 'typescript', additional: ['java'] },
        dependencies: {
          packageManagers: ['pnpm'],
          manifestPaths: ['package.json'],
        },
        vcs: defaultConfig.vcs,
        database: {
          connectionName: 'local-sqlite',
          schemaPaths: ['packages/storage/src/index.ts'],
        },
        telegram: { alias: 'zeus-local' },
        security: { allowShell: true, allowGitWrite: false },
      });

      expect(saved).toMatchObject({
        projectId: project.id,
        defaultModel: 'gpt-5.1-codex',
        defaultWorkMode: 'debug',
        scan: { ignoreDirectories: ['node_modules'], indexScope: 'src' },
        telegram: { alias: 'zeus-local' },
      });
      expect(await client.loadProjectConfig(project.id)).toMatchObject(saved);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('manages project detail, search, update, archive confirmation, and delete through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-project-management-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实当前仓库',
      });
      const duplicate = await client.createProject({
        name: 'Zeus Again',
        localPath: '/Users/david/hypha/zeus/',
        description: '重复路径不应新增项目',
      });
      const hermesPath = join(dir, 'hermes');
      await mkdir(hermesPath, { recursive: true });
      await client.createProject({
        name: 'Hermes',
        localPath: hermesPath,
        description: '另一个真实仓库',
      });

      expect(duplicate.id).toBe(project.id);
      expect((await client.loadProject(project.id)).name).toBe('Zeus');
      expect((await client.loadProjects()).filter((item) => item.localPath === project.localPath).map((item) => item.id)).toEqual([project.id]);
      expect((await client.loadProjects({ query: '真实当前仓库' })).map((item) => item.id)).toEqual([project.id]);
      expect(
        (
          await client.updateProject(project.id, {
            name: 'Zeus Workbench',
            description: '本地优先工作台',
          })
        ).name,
      ).toBe('Zeus Workbench');
      expect((await client.createProjectArchiveConfirmation(project.id)).confirmationText).toBe('确认归档项目 Zeus Workbench');
      expect((await client.deleteProject(project.id)).id).toBe(project.id);
      expect((await client.loadDashboard()).projects.map((item) => item.name)).toEqual(['Hermes']);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads readonly git diff through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-diff-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const diff = await client.loadGitDiff();
      expect(diff.isRepository).toBe(true);
      expect(Array.isArray(diff.files)).toBe(true);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads project-scoped git status and diff through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-project-git-'));
    const projectPath = join(dir, 'project-a');
    await mkdir(projectPath, { recursive: true });
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        gitStatusReader: async () => ({
          isRepository: true,
          branch: 'feature/project-client',
          clean: false,
          changedFiles: ['README.md'],
          conflictFiles: [],
          fileStatuses: [],
          remoteBranches: [],
          recentCommits: [],
        }),
        gitDiffReader: async () => ({
          isRepository: true,
          files: ['README.md'],
          diffText: 'diff --git a/README.md b/README.md',
          fileDiffs: [
            {
              oldPath: 'README.md',
              newPath: 'README.md',
              changeType: 'modified',
              addedLines: 1,
              deletedLines: 0,
              hunks: [],
            },
          ],
        }),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Project Client',
        localPath: projectPath,
      });

      const status = await client.loadProjectGitStatus(project.id);
      const diff = await client.loadProjectGitDiff(project.id);

      expect(status.branch).toBe('feature/project-client');
      expect(diff.files).toEqual(['README.md']);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a project-scoped git snapshot through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-project-git-snapshot-'));
    const projectPath = join(dir, 'project-snapshot');
    await mkdir(projectPath, { recursive: true });
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        gitDiffReader: async () => ({
          isRepository: true,
          files: ['README.md'],
          diffText: 'diff --git a/README.md b/README.md',
          fileDiffs: [
            {
              oldPath: 'README.md',
              newPath: 'README.md',
              changeType: 'modified',
              addedLines: 1,
              deletedLines: 0,
              hunks: [],
            },
          ],
        }),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Project Snapshot Client',
        localPath: projectPath,
      });
      const task = await client.createTask({
        projectId: project.id,
        title: 'Snapshot client task',
        description: '创建项目级 Git snapshot',
      });

      const snapshot = await client.createProjectGitSnapshot(project.id, task.id);

      expect(snapshot).toMatchObject({
        projectId: project.id,
        taskId: task.id,
        snapshotType: 'readonly_diff',
        fileCount: 1,
      });
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads task-scoped git diff through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-task-diff-'));
    const projectPath = join(dir, 'project-task-client');
    await mkdir(projectPath, { recursive: true });
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        gitDiffReader: async () => ({
          isRepository: true,
          files: ['src/task-client.ts'],
          diffText: 'diff --git a/src/task-client.ts b/src/task-client.ts',
          fileDiffs: [
            {
              oldPath: 'src/task-client.ts',
              newPath: 'src/task-client.ts',
              changeType: 'modified',
              addedLines: 1,
              deletedLines: 1,
              hunks: [],
            },
          ],
        }),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Task Diff Client',
        localPath: projectPath,
      });
      const task = await client.createTask({
        projectId: project.id,
        title: 'Task diff client',
        description: '读取任务级 diff',
      });

      const diff = await client.loadTaskGitDiff(task.id);

      expect(diff.files).toEqual(['src/task-client.ts']);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads and saves runtime adapter settings through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-runtime-settings-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });

      expect(await client.loadRuntimeSettings()).toEqual({
        defaultAdapterId: 'codex',
        adapterModels: {},
        adapterDefaultArgs: {},
        adapterCliPaths: {},
        autoConfirmationPolicy: 'never',
        terminalEnv: {},
        shell: { path: null, login: false },
        concurrency: { maxPerProject: 1, maxGlobal: 2 },
        executionTimeoutSeconds: 3600,
        logRetentionDays: 30,
      });
      expect(
        await client.saveRuntimeSettings({
          defaultAdapterId: 'gemini',
          adapterModels: { gemini: 'gemini-pro-real' },
          adapterDefaultArgs: {},
          adapterCliPaths: { gemini: '/opt/homebrew/bin/gemini' },
          autoConfirmationPolicy: 'low_risk_only',
          terminalEnv: { ZEUS_REAL_TASK: 'enabled' },
          shell: { path: '/bin/zsh', login: true },
          concurrency: { maxPerProject: 1, maxGlobal: 2 },
          executionTimeoutSeconds: 3600,
          logRetentionDays: 14,
        }),
      ).toEqual({
        defaultAdapterId: 'gemini',
        adapterModels: { gemini: 'gemini-pro-real' },
        adapterDefaultArgs: {},
        adapterCliPaths: { gemini: '/opt/homebrew/bin/gemini' },
        autoConfirmationPolicy: 'low_risk_only',
        terminalEnv: { ZEUS_REAL_TASK: 'enabled' },
        shell: { path: '/bin/zsh', login: true },
        concurrency: { maxPerProject: 1, maxGlobal: 2 },
        executionTimeoutSeconds: 3600,
        logRetentionDays: 14,
      });
      expect(await client.loadRuntimeSettings()).toEqual({
        defaultAdapterId: 'gemini',
        adapterModels: { gemini: 'gemini-pro-real' },
        adapterDefaultArgs: {},
        adapterCliPaths: { gemini: '/opt/homebrew/bin/gemini' },
        autoConfirmationPolicy: 'low_risk_only',
        terminalEnv: { ZEUS_REAL_TASK: 'enabled' },
        shell: { path: '/bin/zsh', login: true },
        concurrency: { maxPerProject: 1, maxGlobal: 2 },
        executionTimeoutSeconds: 3600,
        logRetentionDays: 14,
      });
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads and saves code map settings through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-code-map-settings-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });

      expect(await client.loadCodeMapSettings()).toMatchObject({
        defaultScanScope: 'project',
        defaultIgnoreDirectories: expect.arrayContaining(['node_modules', 'dist']),
        maxCallChainDepth: 3,
        showLowConfidenceEdges: false,
      });
      const saved = await client.saveCodeMapSettings({
        defaultScanScope: 'project',
        defaultIgnoreDirectories: ['node_modules', 'dist', 'generated-real'],
        maxCallChainDepth: 5,
        showLowConfidenceEdges: true,
        layoutAlgorithm: 'hierarchical',
        graphCacheStrategy: 'sqlite',
        tableRelationInference: 'foreign_key_and_name',
        aiSummaryEnabled: true,
        incrementalScanEnabled: true,
        performanceMonitoringEnabled: true,
        moduleFlowManualNotes: '下单流程：Controller -> Service -> Mapper；待人工确认库存扣减节点。',
      });

      expect(saved).toMatchObject({
        defaultIgnoreDirectories: ['node_modules', 'dist', 'generated-real'],
        maxCallChainDepth: 5,
        showLowConfidenceEdges: true,
        layoutAlgorithm: 'hierarchical',
        moduleFlowManualNotes: '下单流程：Controller -> Service -> Mapper；待人工确认库存扣减节点。',
      });
      expect(await client.loadCodeMapSettings()).toEqual(saved);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads task timeline events through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-events-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const task = await client.createTask({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '真实任务',
        sourceContext: { path: project.localPath },
      });
      const events = await client.loadTaskEvents(task.id);
      expect(events.map((event) => event.title)).toContain('任务已创建');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads built-in task templates through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-templates-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const templates = await client.loadTaskTemplates();
      expect(templates.map((template) => template.name)).toContain('代码评审');
      expect(templates.every((template) => template.builtIn)).toBe(true);
      expect((await client.loadDashboard()).tasks).toHaveLength(0);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a custom template and creates a real task from that template through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-template-task-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const template = await client.createTaskTemplate({
        projectId: project.id,
        name: 'Zeus 专项重构',
        description: '真实项目级 prompt 模板',
        promptTemplate: '请在 {{project_path}} 完成 {{goal}}',
        category: 'custom',
        defaultOptions: { allowTests: true },
      });
      const defaultProject = await client.setProjectDefaultTemplate(project.id, template.id);
      const task = await client.createTaskFromTemplate(template.id, {
        projectId: project.id,
        title: 'Zeus 专项重构',
        variables: {
          project_path: project.localPath,
          goal: '整理任务模板闭环',
        },
      });

      expect(template.builtIn).toBe(false);
      expect(defaultProject.defaultTemplateId).toBe(template.id);
      expect(task.templateId).toBe(template.id);
      expect(task.description).toContain('整理任务模板闭环');
      expect((await client.loadDashboard()).tasks).toHaveLength(1);
      expect((await client.loadTaskTemplates(project.id)).map((item) => item.id)).toContain(template.id);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads filtered and sorted real tasks with tags through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-task-search-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      await client.createTask({
        projectId: project.id,
        title: '修复 API Bug',
        description: '真实后端缺陷',
        sourceContext: { path: project.localPath },
        tags: ['backend', 'bug'],
      });
      await client.createTask({
        projectId: project.id,
        title: '优化任务 UI',
        description: '真实前端任务',
        sourceContext: { path: project.localPath },
        tags: ['frontend'],
      });

      const filtered = await client.loadTasks({
        projectId: project.id,
        query: 'Bug',
        status: 'ready',
        tag: 'backend',
        sortBy: 'title',
        sortDirection: 'asc',
      });

      expect(filtered.map((task) => task.title)).toEqual(['修复 API Bug']);
      expect(filtered[0]?.tags).toEqual(['backend', 'bug']);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('manages task detail, edit, tags, and delete through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-task-detail-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const task = await client.createTask({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '真实任务',
        sourceContext: { path: project.localPath },
        tags: ['analysis'],
      });

      expect((await client.loadTask(task.id)).title).toBe('分析当前项目结构');
      expect(
        (
          await client.updateTask(task.id, {
            title: '分析 Zeus 项目结构',
            description: '更新后的真实任务',
          })
        ).title,
      ).toBe('分析 Zeus 项目结构');
      expect((await client.updateTaskTags(task.id, ['analysis', 'backend'])).tags).toEqual(['analysis', 'backend']);
      expect((await client.deleteTask(task.id)).id).toBe(task.id);
      expect(await client.loadTasks({ projectId: project.id })).toEqual([]);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates task status through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-control-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const task = await client.createTask({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '真实任务',
        sourceContext: { path: project.localPath },
      });
      const runningTask = await client.updateTaskStatus(task.id, 'running');
      expect(runningTask.status).toBe('running');
      const pausedTask = await client.updateTaskStatus(task.id, 'paused');
      expect(pausedTask.status).toBe('paused');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('controls task Runtime lifecycle through dedicated task APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-task-runtime-control-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createRuntimeClientTestSpawn(),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      await selectLegacyCliTestAdapter(client);
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const task = await client.createTask({
        projectId: project.id,
        title: '执行真实任务',
        description: '真实 Runtime 生命周期',
        sourceContext: { path: project.localPath },
      });

      const runResult = await client.runTask(task.id);
      const paused = await client.pauseTask(task.id);
      const continueResult = await client.continueTask(task.id);
      const cancelled = await client.cancelTask(task.id);
      const retried = await client.retryTask(task.id);

      expect(runResult.task.status).toBe('running');
      expect(runResult.runtimeSession.id).toMatch(/^ai-session-/);
      expect(paused.status).toBe('paused');
      expect(continueResult.task.status).toBe('running');
      expect(cancelled.status).toBe('cancelled');
      expect(retried.status).toBe('ready');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('archives a task through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-archive-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const task = await client.createTask({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '真实任务',
        sourceContext: { path: project.localPath },
      });
      const archived = await client.archiveTask(task.id);
      expect(archived.id).toBe(task.id);
      expect((await client.loadDashboard()).tasks).toHaveLength(0);
      expect((await client.loadArchivedTasks(project.id)).map((item) => item.id)).toEqual([task.id]);
      const restored = await client.restoreTask(task.id);
      expect(restored.id).toBe(task.id);
      expect((await client.loadDashboard()).tasks).toHaveLength(1);
      expect(await client.loadArchivedTasks(project.id)).toEqual([]);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a high-risk git confirmation through the renderer client before any git write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-git-confirm-reject-'));
    const gitRuns: Array<{ cwd: string; args: string[] }> = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: dir,
        gitCommandRunner: async (cwd, args) => {
          gitRuns.push({ cwd, args });
          return { stdout: 'should-not-run', stderr: '' };
        },
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const pending = await client.createGitConfirmation({
        operation: 'stash',
        reason: '用户准备暂存',
      });
      const rejected = await client.rejectGitOperation(pending.id, '用户取消操作');

      await expect(
        client.executeGitOperation({
          confirmationId: pending.id,
          operation: 'stash',
          message: 'save work',
        }),
      ).rejects.toThrow('Git confirmation was rejected');
      expect(rejected).toMatchObject({
        id: pending.id,
        status: 'rejected',
        rejectedReason: '用户取消操作',
      });
      expect(gitRuns).toEqual([]);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates and confirms high-risk git operation confirmations through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-git-confirm-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const pending = await client.createGitConfirmation({
        operation: 'stash',
        reason: '用户请求暂存当前变更',
      });
      expect(pending.status).toBe('pending');
      expect(pending.confirmationText).toBe('确认执行 Git stash');
      const confirmed = await client.confirmGitOperation(pending.id);
      expect(confirmed.status).toBe('confirmed');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('executes project git pull and push through the renderer client with confirmed operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-git-pull-push-'));
    const gitRuns: Array<{ cwd: string; args: string[] }> = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: dir,
        gitCommandRunner: async (cwd, args) => {
          gitRuns.push({ cwd, args });
          return { stdout: args.join(' '), stderr: '' };
        },
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: '远端 Git 项目',
        localPath: dir,
        description: '设计书 pull push 路由',
      });
      async function confirm(operation: 'pull' | 'push'): Promise<string> {
        const pending = await client.createGitConfirmation({
          operation,
          reason: `确认 ${operation}`,
        });
        await client.confirmGitOperation(pending.id);
        return pending.id;
      }

      await client.executeProjectGitPull(project.id, {
        confirmationId: await confirm('pull'),
        remote: 'origin',
        targetRef: 'main',
      });
      await client.executeProjectGitPush(project.id, {
        confirmationId: await confirm('push'),
        remote: 'origin',
        targetRef: 'HEAD',
      });

      expect(gitRuns.map((run) => run.args)).toEqual([
        ['pull', '--ff-only', 'origin', 'main'],
        ['push', 'origin', 'HEAD'],
      ]);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('executes design-book project and task git routes through the renderer client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-git-design-routes-'));
    const gitRuns: Array<{ cwd: string; args: string[] }> = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: dir,
        gitCommandRunner: async (cwd, args) => {
          gitRuns.push({ cwd, args });
          return { stdout: args.join(' '), stderr: '' };
        },
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: '真实 Git 项目',
        localPath: dir,
        description: '设计书 Git 路由',
      });
      const task = await client.createTask({
        projectId: project.id,
        title: 'Git 回滚任务',
        description: '通过 task rollback 路由执行',
      });

      async function confirm(operation: 'branch' | 'switch_branch' | 'commit' | 'stash' | 'apply_stash' | 'rollback'): Promise<string> {
        const pending = await client.createGitConfirmation({
          operation,
          reason: `确认 ${operation}`,
        });
        await client.confirmGitOperation(pending.id);
        return pending.id;
      }

      await client.executeProjectGitBranch(project.id, {
        confirmationId: await confirm('branch'),
        branchName: 'feature/client-route',
      });
      await client.executeProjectGitCheckout(project.id, {
        confirmationId: await confirm('switch_branch'),
        branchName: 'main',
      });
      await client.executeProjectGitCommit(project.id, {
        confirmationId: await confirm('commit'),
        message: 'feat: client git routes',
      });
      await client.executeProjectGitStash(project.id, {
        confirmationId: await confirm('stash'),
        message: 'save client work',
      });
      await client.executeProjectGitApplyStash(project.id, {
        confirmationId: await confirm('apply_stash'),
        stashRef: 'stash@{0}',
      });
      await client.executeTaskGitRollback(task.id, {
        confirmationId: await confirm('rollback'),
        targetRef: 'HEAD',
      });

      expect(gitRuns.map((run) => run.args)).toEqual([
        ['switch', '-c', 'feature/client-route'],
        ['switch', 'main'],
        ['commit', '-m', 'feat: client git routes'],
        ['stash', 'push', '-m', 'save client work'],
        ['stash', 'apply', 'stash@{0}'],
        ['restore', '--source', 'HEAD', '--', '.'],
      ]);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('executes confirmed high-risk git operations through the local server API client without exposing arbitrary git commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-git-operation-'));
    const gitRuns: Array<{ cwd: string; args: string[] }> = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: dir,
        gitCommandRunner: async (cwd, args) => {
          gitRuns.push({ cwd, args });
          return { stdout: 'stashed', stderr: '' };
        },
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const pending = await client.createGitConfirmation({
        operation: 'stash',
        reason: '暂存已审查变更',
      });
      await client.confirmGitOperation(pending.id);

      const executed = await client.executeGitOperation({
        confirmationId: pending.id,
        operation: 'stash',
        message: 'save reviewed work',
      });

      expect(executed).toMatchObject({
        operation: 'stash',
        args: ['stash', 'push', '-m', 'save reviewed work'],
        stdout: 'stashed',
      });
      expect(gitRuns).toEqual([{ cwd: dir, args: ['stash', 'push', '-m', 'save reviewed work'] }]);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads a real graph view through the local server API after scanning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-graph-view-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      await client.scanCurrentGraph();
      const view = await client.loadGraphView('module');
      expect(view.title).toContain('模块图');
      expect(view.viewType).toBe('module');
      expect(view.nodes.length).toBeGreaterThan(0);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('controls Telegram through design-book status, settings, start, and stop renderer client methods', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-telegram-design-aliases-'));
    try {
      const secretStore = createMemorySecretStore();
      await secretStore.setSecret('telegram.botToken', 'telegram-token-real');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        telegramAllowedUserIds: [42],
        secretStore,
        telegramPollingClient: { poll: async () => [] },
        telegramMessageSender: { sendMessage: async () => undefined },
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });

      const settings = await client.saveTelegramSettings({
        enabled: true,
        chatIds: [1001, 1001, 1002],
        silentMode: true,
        allowedUserIds: [42, 42, 1001],
      });
      const started = await client.startTelegram();
      const status = await client.loadTelegramStatus();
      const stopped = await client.stopTelegram();

      expect(settings).toMatchObject({
        notificationSettings: {
          enabled: true,
          chatIds: [1001, 1002],
          silentMode: true,
        },
        securitySettings: { allowedUserIds: [42, 1001] },
      });
      expect(started).toMatchObject({ running: true });
      expect(status).toMatchObject({
        configured: true,
        polling: { running: true },
      });
      expect(stopped).toMatchObject({ running: false });
      expect(JSON.stringify([settings, started, status, stopped])).not.toContain('telegram-token-real');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads design-book Telegram messages through the renderer client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-telegram-messages-'));
    try {
      const secretStore = createMemorySecretStore();
      await secretStore.setSecret('telegram.botToken', 'telegram-token-real');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        telegramAllowedUserIds: [42],
        secretStore,
        telegramPollingClient: {
          poll: async () => [{ updateId: 20, chatId: 1002, userId: 42, text: '/status' }],
        },
        telegramMessageSender: { sendMessage: async () => undefined },
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });

      await client.pollTelegramOnce();
      const messages = await client.loadTelegramMessages();

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            updateId: 20,
            chatId: 1002,
            userId: 42,
            command: 'status',
            allowed: true,
          }),
        ]),
      );
      expect(JSON.stringify(messages)).not.toContain('telegram-token-real');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('controls Telegram polling through the settings API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-telegram-polling-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        telegramToken: 'telegram-token-real',
        telegramAllowedUserIds: [42],
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const started = await client.startTelegramPolling();
      const status = await client.loadTelegramPollingStatus();
      const logs = await client.loadTelegramPollingLogs();
      const stopped = await client.stopTelegramPolling();

      expect(started.running).toBe(true);
      expect(status.running).toBe(true);
      expect(Array.isArray(logs)).toBe(true);
      expect(stopped.running).toBe(false);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stores and clears Telegram Bot Token through the security settings API without exposing the value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-security-secrets-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        telegramAllowedUserIds: [42],
        secretStore: createMemorySecretStore(),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const saved = await client.saveTelegramBotToken('telegram-token-real');
      const status = await client.loadSecuritySecrets();
      const auditLogs = await client.loadSecurityAuditLogs();
      const cleared = await client.clearTelegramBotToken();

      expect(saved.telegramBotToken).toEqual({
        configured: true,
        label: '已安全保存',
      });
      expect(status.telegramBotToken).toEqual({
        configured: true,
        label: '已安全保存',
      });
      expect(JSON.stringify(status)).not.toContain('telegram-token-real');
      expect(auditLogs[0]).toMatchObject({
        action: 'security.secret.telegram_bot_token.saved',
        resourceType: 'secret',
        resourceId: 'telegram.botToken',
        payload: { configured: true, secretValueStored: false },
      });
      expect(JSON.stringify(auditLogs)).not.toContain('telegram-token-real');
      expect(cleared.telegramBotToken).toEqual({
        configured: false,
        label: '未配置',
      });
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stores and clears external API key through the security settings API without exposing the value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-external-api-key-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        telegramAllowedUserIds: [42],
        secretStore: createMemorySecretStore(),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });

      const saved = await client.saveExternalApiKey('external-api-key-real');
      const status = await client.loadSecuritySecrets();
      const auditLogs = await client.loadSecurityAuditLogs();
      const cleared = await client.clearExternalApiKey();

      expect(saved.externalApiKey).toEqual({
        configured: true,
        label: '已安全保存',
      });
      expect(status.externalApiKey).toEqual({
        configured: true,
        label: '已安全保存',
      });
      expect(JSON.stringify(status)).not.toContain('external-api-key-real');
      expect(auditLogs[0]).toMatchObject({
        action: 'security.secret.external_api_key.saved',
        resourceType: 'secret',
        resourceId: 'external.apiKey',
        payload: { configured: true, secretValueStored: false },
      });
      expect(JSON.stringify(auditLogs)).not.toContain('external-api-key-real');
      expect(cleared.externalApiKey).toEqual({
        configured: false,
        label: '未配置',
      });
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stores project database password through the renderer client without exposing the value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-database-secret-'));
    try {
      const secretStore = createMemorySecretStore();
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        telegramAllowedUserIds: [42],
        secretStore,
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实项目',
      });
      const config = await client.loadProjectConfig(project.id);
      await client.saveProjectConfig(project.id, {
        ...config,
        database: { connectionName: 'local-postgres', schemaPaths: [] },
      });

      const saved = await client.saveProjectDatabasePassword(project.id, 'db-password-real');
      const status = await client.loadProjectDatabaseSecret(project.id);
      const auditLogs = await client.loadSecurityAuditLogs();
      const cleared = await client.clearProjectDatabasePassword(project.id);

      expect(saved).toEqual({
        connectionName: 'local-postgres',
        password: { configured: true, label: '已安全保存' },
      });
      expect(status).toEqual({
        connectionName: 'local-postgres',
        password: { configured: true, label: '已安全保存' },
      });
      expect(JSON.stringify(status)).not.toContain('db-password-real');
      expect(auditLogs[0]).toMatchObject({
        action: 'security.secret.database_connection_password.saved',
        resourceType: 'secret',
      });
      expect(JSON.stringify(auditLogs)).not.toContain('db-password-real');
      expect(cleared).toEqual({
        connectionName: 'local-postgres',
        password: { configured: false, label: '未配置' },
      });
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resets security settings through the renderer client without exposing secret values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-security-reset-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        telegramAllowedUserIds: [42],
        telegramNotificationChatIds: [1001],
        secretStore: createMemorySecretStore(),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      await client.saveTelegramBotToken('telegram-token-real');

      const reset = await client.resetSecurity();
      const auditLogs = await client.loadSecurityAuditLogs();

      expect(reset).toEqual({
        secrets: {
          telegramBotToken: { configured: false, label: '未配置' },
          externalApiKey: { configured: false, label: '未配置' },
        },
        telegramNotificationSettings: {
          enabled: false,
          chatIds: [],
          silentMode: true,
        },
        telegramSecuritySettings: { allowedUserIds: [] },
      });
      expect(auditLogs[0]).toMatchObject({
        action: 'security.reset.completed',
        resourceType: 'security',
      });
      expect(JSON.stringify(reset)).not.toContain('telegram-token-real');
      expect(JSON.stringify(auditLogs)).not.toContain('telegram-token-real');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads and saves Telegram notification settings through the local API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-telegram-notification-settings-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        telegramToken: 'telegram-token-real',
        telegramAllowedUserIds: [42],
        telegramNotificationChatIds: [1001],
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const before = await client.loadTelegramNotificationSettings();
      const saved = await client.saveTelegramNotificationSettings({
        enabled: true,
        chatIds: [1002, 1003],
        silentMode: true,
      });

      expect(before).toEqual({
        enabled: true,
        chatIds: [1001],
        silentMode: false,
      });
      expect(saved).toEqual({
        enabled: true,
        chatIds: [1002, 1003],
        silentMode: true,
      });
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sends a Telegram test connection through the renderer client without exposing token values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-telegram-test-'));
    const sent: Array<{ chatId: number; text: string }> = [];
    try {
      const secretStore = createMemorySecretStore();
      await secretStore.setSecret('telegram.botToken', 'telegram-token-real');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        telegramAllowedUserIds: [42],
        telegramNotificationChatIds: [1001],
        secretStore,
        telegramMessageSender: {
          sendMessage: async (chatId, text) => {
            sent.push({ chatId, text });
          },
        },
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const result = await client.testTelegramConnection();

      expect(result).toMatchObject({ ok: true, chatIds: [1001], attempts: 1 });
      expect(result.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toContain('Zeus Telegram 测试连接');
      expect(JSON.stringify(result)).not.toContain('telegram-token-real');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads and saves Telegram allowed user ids through the renderer client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-telegram-security-settings-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        telegramToken: 'telegram-token-real',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const before = await client.loadTelegramSecuritySettings();
      const saved = await client.saveTelegramSecuritySettings({
        allowedUserIds: [42, 42, 1001],
      });
      const runtimeStatus = await client.loadRuntimeStatus();

      expect(before).toEqual({ allowedUserIds: [] });
      expect(saved).toEqual({ allowedUserIds: [42, 1001] });
      expect(runtimeStatus.telegram).toMatchObject({
        enabled: true,
        reason: 'Telegram long polling 可启用。',
      });
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads runtime adapter registry and checks an adapter through the settings API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-runtime-adapters-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const adapters = await client.loadRuntimeAdapters();
      const codex = await client.checkRuntimeAdapter('codex');

      expect(adapters.map((adapter) => adapter.id)).toEqual(['codex', 'claude', 'gemini', 'generic']);
      expect(codex.id).toBe('codex');
      expect(codex.command).toBe('codex');
      expect(typeof codex.available).toBe('boolean');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads runtime configuration status through the settings API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-runtime-status-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const runtimeStatus = await client.loadRuntimeStatus();
      expect(runtimeStatus.aiCli.name).toBe('Codex CLI');
      expect(runtimeStatus.aiCli.available).toBeTypeOf('boolean');
      expect(runtimeStatus.telegram.enabled).toBe(false);
      expect(runtimeStatus.telegram.reason).toContain('Telegram');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports unsigned release readiness waiting items when Apple credentials are absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-release-waiting-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        releaseEnvironment: {},
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const releaseStatus = await client.loadReleaseStatus();

      expect(releaseStatus.readiness).toEqual({
        canBuildUnsignedArtifacts: true,
        canSign: false,
        canNotarize: false,
        waitingFor: ['Apple signing certificate', 'Apple notarization credentials'],
      });
      expect(releaseStatus.autoUpdate).toEqual({
        currentVersion: '0.1.0',
        channel: 'manual',
        checkMode: 'manual',
        updateFeedConfigured: false,
        changelogPath: 'docs/release.md',
        waitingFor: ['signed and notarized artifacts'],
        label: '手动更新 · 0.1.0',
      });
      expect(JSON.stringify(releaseStatus)).not.toContain('CSC_LINK');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks GitHub release updates without exposing signing environment variables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-update-status-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        releaseUpdateManifestProvider: async () => ({
          app: 'Zeus',
          schemaVersion: 1,
          version: '0.2.0',
          channel: 'stable',
          repository: 'imchenway/zeus',
          releasePageUrl: 'https://github.com/imchenway/zeus/releases/tag/v0.2.0',
          latestReleaseUrl: 'https://github.com/imchenway/zeus/releases/latest',
          releaseNotesUrl: 'https://github.com/imchenway/zeus/releases/tag/v0.2.0',
          installScriptUrl: 'https://github.com/imchenway/zeus/releases/latest/download/install.sh',
          publishedAt: '2026-06-16T00:00:00.000Z',
          signed: false,
          notarized: false,
          minimumSystemVersion: '13.0',
          artifacts: [
            {
              arch: 'arm64',
              kind: 'dmg',
              fileName: 'Zeus-0.2.0-arm64.dmg',
              sha256: 'arm-dmg-sha',
              sizeBytes: null,
              downloadUrl: 'https://github.com/imchenway/zeus/releases/download/v0.2.0/Zeus-0.2.0-arm64.dmg',
            },
          ],
          homebrew: {
            tap: 'imchenway/zeus',
            cask: 'zeus',
            installCommand: 'brew install --cask imchenway/zeus/zeus',
            upgradeCommand: 'brew upgrade --cask zeus',
          },
        }),
        releaseEnvironment: {
          CSC_LINK: 'certificate-bytes',
          CSC_KEY_PASSWORD: 'certificate-password',
        },
        now: () => new Date('2026-06-16T01:00:00.000Z'),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const updateStatus = await client.checkReleaseUpdate();

      expect(updateStatus).toMatchObject({
        status: 'available',
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        channel: 'stable',
        releasePageUrl: 'https://github.com/imchenway/zeus/releases/tag/v0.2.0',
        recommendedAction: 'open_download_page',
        automaticInstallEnabled: false,
      });
      expect(updateStatus.reason).toContain('未同时签名和公证');
      expect(JSON.stringify(updateStatus)).not.toContain('CSC_KEY_PASSWORD');
      expect(JSON.stringify(updateStatus)).not.toContain('certificate-password');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads release configuration status without exposing signing secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-release-status-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        releaseEnvironment: {
          CSC_LINK: 'certificate-bytes',
          CSC_KEY_PASSWORD: 'certificate-password',
          APPLE_ID: 'developer@example.com',
          APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
          APPLE_TEAM_ID: 'TEAM123',
        },
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const releaseStatus = await client.loadReleaseStatus();

      expect(releaseStatus.signing).toEqual({
        configured: true,
        label: '签名证书已配置',
      });
      expect(releaseStatus.notarization).toEqual({
        configured: true,
        label: '公证凭据已配置',
      });
      expect(releaseStatus.homebrewCask.configured).toBe(true);
      expect(releaseStatus.homebrewCask.label).toContain('Casks/zeus.rb');
      expect(releaseStatus.releaseWorkflow.configured).toBe(true);
      expect(releaseStatus.readiness).toEqual({
        canBuildUnsignedArtifacts: true,
        canSign: true,
        canNotarize: true,
        waitingFor: [],
      });
      expect(releaseStatus.autoUpdate.waitingFor).toEqual([]);
      expect(releaseStatus.autoUpdate.updateFeedConfigured).toBe(true);
      expect(JSON.stringify(releaseStatus)).not.toContain('certificate-password');
      expect(JSON.stringify(releaseStatus)).not.toContain('app-password');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a task from a graph node through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-graph-node-task-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      await client.scanCurrentGraph();
      const view = await client.loadGraphView('architecture');
      const task = await client.createTaskFromGraphNode(view.nodes[0].id, {
        projectId: project.id,
        intent: '分析该节点的实现风险',
      });
      expect(task.projectId).toBe(project.id);
      expect(task.title).toContain(view.nodes[0].name);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a task from a graph question conversation through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-graph-conversation-task-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createGraphAnswerSpawn(),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      await selectLegacyCliTestAdapter(client);
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      await client.scanCurrentGraph();
      await client.askGraph(project.id, { question: 'local-server' });
      const history = await client.loadGraphConversations(project.id, {
        query: 'local-server',
        limit: 5,
        offset: 0,
      });

      const task = await client.createTaskFromGraphConversation(project.id, history.items[0].id, { intent: '把问答结论转为任务' });

      expect(task.projectId).toBe(project.id);
      expect(task.title).toContain('local-server');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('searches graph nodes through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-graph-search-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      await client.scanCurrentGraph();
      const result = await client.searchGraph({
        query: 'local-server',
        nodeType: 'file',
        edgeType: 'declares',
        minConfidence: 1,
      });
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.every((node) => node.nodeType === 'file')).toBe(true);
      expect(result.edges.every((edge) => edge.edgeType === 'declares' && edge.confidence >= 1)).toBe(true);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads graph question conversation history through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-graph-conversations-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createGraphAnswerSpawn(),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      await selectLegacyCliTestAdapter(client);
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      await client.scanCurrentGraph();
      await client.askGraph(project.id, { question: 'local-server' });

      const history = await client.loadGraphConversations(project.id, {
        query: 'local-server',
        limit: 5,
        offset: 0,
      });

      expect(history.items).toHaveLength(1);
      expect(history.total).toBe(1);
      expect(history.items[0].title).toBe('图谱问答：local-server');
      expect(history.items[0].messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(history.items[0].messages[1].content).toContain('local-server 来源已核验');
      const detail = await client.loadGraphConversation(project.id, history.items[0].id);
      expect(detail.messages).toHaveLength(2);
      const archived = await client.archiveGraphConversation(project.id, history.items[0].id);
      expect(archived.archived).toBe(true);
      const restored = await client.restoreGraphConversation(project.id, history.items[0].id);
      expect(restored.archived).toBe(false);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('asks a graph question through the local server API and returns AI answer with sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-graph-ask-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createGraphAnswerSpawn(),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      await selectLegacyCliTestAdapter(client);
      const project = await client.createProject({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      await client.scanCurrentGraph();

      const answer = await client.askGraph(project.id, {
        question: 'local-server',
      });

      expect(answer.answer).toContain('AI 图谱回答');
      expect(answer.sessionId).toMatch(/^ai-session-/);
      expect(answer.sources.nodes.length).toBeGreaterThan(0);
      expect(answer.sources.nodes[0].sourceRef).toContain('local-server');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads graph edge detail and one-hop neighborhood through the local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-graph-detail-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      await client.scanCurrentGraph();
      const view = await client.loadGraphView('architecture');
      const edgeDetail = await client.loadGraphEdgeDetail(view.edges[0].id);
      expect(edgeDetail.id).toBe(view.edges[0].id);
      const neighborhood = await client.loadGraphNeighborhood(view.edges[0].sourceNodeId, 1);
      expect(neighborhood.centerNode.id).toBe(view.edges[0].sourceNodeId);
      expect(neighborhood.edges.length).toBeGreaterThan(0);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads project-scoped graph view, search, node, and neighborhood through the renderer client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-project-graph-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Client Project Graph',
        localPath: '/Users/david/hypha/zeus',
      });
      await client.scanProject(project.id);

      const view = await client.loadProjectGraphView(project.id, 'architecture');
      const node = view.nodes[0];
      const search = await client.searchProjectGraph(project.id, {
        query: node.name,
      });
      const detail = await client.loadProjectGraphNode(project.id, node.id);
      const neighborhood = await client.loadProjectGraphNeighborhood(project.id, node.id, 1);

      expect(view.viewType).toBe('architecture');
      expect(search.nodes.some((item) => item.id === node.id)).toBe(true);
      expect(detail).toMatchObject({ id: node.id, sourceRef: node.sourceRef });
      expect(neighborhood.centerNode.id).toBe(node.id);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates and links graph tasks through the project-scoped renderer client APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-project-graph-task-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Client Project Graph Task',
        localPath: '/Users/david/hypha/zeus',
      });
      await client.scanProject(project.id);
      const view = await client.loadProjectGraphView(project.id, 'architecture');
      const node = view.nodes[0];
      const nodeTask = await client.createProjectTaskFromGraphNode(project.id, node.id, { intent: '项目级节点任务' });
      const viewTask = await client.createProjectTaskFromGraphView(project.id, view.viewType, { intent: '项目级视图任务' });
      const manualTask = await client.createTask({
        projectId: project.id,
        title: '关联图谱节点',
        description: '手动创建后关联图谱节点',
      });
      const linkedTask = await client.linkTaskGraphNode(manualTask.id, {
        nodeId: node.id,
        reason: '从 renderer client 关联',
      });

      expect(nodeTask.createdFrom).toBe('graph_node');
      expect(JSON.parse(nodeTask.sourceContextJson).graphNode).toMatchObject({
        id: node.id,
        sourceRef: node.sourceRef,
      });
      expect(viewTask.createdFrom).toBe('graph_view');
      expect(JSON.parse(viewTask.sourceContextJson).graphView).toMatchObject({
        viewType: view.viewType,
      });
      expect(JSON.parse(linkedTask.sourceContextJson).linkedGraphNodes).toEqual([
        expect.objectContaining({
          id: node.id,
          reason: '从 renderer client 关联',
        }),
      ]);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads project-scoped semantic Code Map APIs through the renderer client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-semantic-code-map-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      const project = await client.createProject({
        name: 'Client Semantic Code Map',
        localPath: '/Users/david/hypha/zeus',
      });
      await client.scanProject(project.id);

      const apis = await client.loadProjectApis(project.id);
      const api = apis.items.find((item) => item.name === 'GET /api/dashboard')!;
      const apiDetail = await client.loadProjectApi(project.id, api.id);
      const apiSequence = await client.loadProjectApiSequence(project.id, api.id);

      const modules = await client.loadProjectModules(project.id);
      const moduleNode = modules.items.find((item) => item.nodeType === 'file' && item.sourceRef.endsWith('/packages/local-server/src/index.ts'))!;
      const moduleDetail = await client.loadProjectModule(project.id, moduleNode.id);
      const moduleFlow = await client.loadProjectModuleFlow(project.id, moduleNode.id);

      const tables = await client.loadProjectTables(project.id);
      const table = tables.items.find((item) => item.name === 'tasks')!;
      const fields = await client.searchProjectTableFields(project.id, 'slug');
      const tableDetail = await client.loadProjectTable(project.id, table.id);
      const tableImpact = await client.loadProjectTableImpact(project.id, table.id);

      const methodView = await client.loadProjectGraphView(project.id, 'method_logic');
      const methodNode = methodView.nodes.find((item) => item.nodeType === 'function')!;
      const methodLogic = await client.loadProjectMethodLogic(project.id, methodNode.id);

      expect(apiDetail.node).toMatchObject({ id: api.id, nodeType: 'api' });
      expect(apiSequence.view.viewType).toBe('api_sequence');
      expect(moduleDetail.node).toMatchObject({
        id: moduleNode.id,
        nodeType: 'file',
      });
      expect(moduleFlow.view.viewType).toBe('module_flow');
      expect(tableDetail.node).toMatchObject({
        id: table.id,
        nodeType: 'table',
      });
      expect(fields).toMatchObject({
        projectId: project.id,
        query: 'slug',
        viewType: 'table',
      });
      expect(fields.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeType: 'column',
            name: 'projects.slug',
          }),
        ]),
      );
      expect(tableImpact.nodes.some((item) => item.id === table.id)).toBe(true);
      expect(methodLogic.view.viewType).toBe('method_logic');
      expect(methodLogic.nodes.some((item) => item.id === methodNode.id)).toBe(true);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { createAiRuntimeSessionManager, type AiRuntimeProcessHandle, type AiRuntimeSpawn } from '../../../packages/ai-runtime/src/index.js';

function createRuntimeClientTestSpawn(): AiRuntimeSpawn {
  return () => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 101,
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
      callbacks.get('stdout')?.forEach((callback) => callback('真实 Runtime 日志'));
      callbacks.get('exit')?.forEach((callback) => callback(0));
    });
    return handle;
  };
}

describe('renderer runtime confirmation API client', () => {
  it('creates and confirms generic shell runtime confirmations before starting a confirmed session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-runtime-confirmation-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createRuntimeClientTestSpawn(),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });

      const pending = await client.createRuntimeConfirmation({
        action: 'start_generic_session',
        reason: '用户在桌面端明确确认通用 shell runtime',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'echo desktop-confirmed'],
          cwd: '/Users/david/hypha/zeus',
        },
      });
      expect(pending.status).toBe('pending');
      expect(pending.riskLevel).toBe('high');
      const confirmed = await client.confirmRuntimeOperation(pending.id);
      expect(confirmed.status).toBe('confirmed');

      const session = await client.startRuntimeSession({
        projectId: 'project-1',
        command: 'sh',
        args: ['-lc', 'echo desktop-confirmed'],
        cwd: '/Users/david/hypha/zeus',
        confirmationId: confirmed.id,
      });
      expect(session.command).toBe('sh');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects generic shell runtime confirmations and surfaces the server rejection message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-runtime-reject-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createRuntimeClientTestSpawn(),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });

      const pending = await client.createRuntimeConfirmation({
        action: 'start_generic_session',
        reason: '用户在桌面端明确确认通用 shell runtime',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'echo desktop-rejected'],
          cwd: '/Users/david/hypha/zeus',
        },
      });
      const rejected = await (
        client as {
          rejectRuntimeOperation: (confirmationId: string, reason?: string) => Promise<{ status: string; rejectedReason?: string }>;
        }
      ).rejectRuntimeOperation(pending.id, '用户拒绝 Generic shell');

      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectedReason).toBe('用户拒绝 Generic shell');
      await expect(
        client.startRuntimeSession({
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'echo desktop-rejected'],
          cwd: '/Users/david/hypha/zeus',
          confirmationId: pending.id,
        }),
      ).rejects.toThrow('Runtime confirmation was rejected');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('renderer AI runtime API client', () => {
  it('starts a runtime session and loads collected logs through the real local server API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-runtime-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeManager: createAiRuntimeSessionManager({
          allowedRoot: '/Users/david/hypha/zeus',
          spawn: createRuntimeClientTestSpawn(),
          now: () => '2026-06-13T00:00:00.000Z',
        }),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      await selectLegacyCliTestAdapter(client);

      const session = await client.startRuntimeSession({
        projectId: 'project-1',
        command: 'claude',
        args: ['--version'],
        cwd: '/Users/david/hypha/zeus',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const sessions = await client.loadRuntimeSessions();
      const logs = await client.loadRuntimeSessionLogs(session.id);

      expect(sessions.map((item) => item.id)).toContain(session.id);
      expect(logs.map((entry) => `${entry.stream}:${entry.text}`)).toContain('stdout:真实 Runtime 日志');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads paginated runtime logs through the renderer client without breaking legacy log arrays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-client-runtime-log-page-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'client-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createRuntimeClientTestSpawn(),
      });
      const client = createDashboardClient({
        baseUrl: running.baseUrl,
        apiToken: 'client-token',
      });
      await selectLegacyCliTestAdapter(client);
      const session = await client.startRuntimeSession({
        projectId: 'project-1',
        command: 'claude',
        args: ['--version'],
        cwd: '/Users/david/hypha/zeus',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const legacyLogs = await client.loadRuntimeSessionLogs(session.id);
      const page = await client.loadRuntimeSessionLogsPage(session.id, {
        query: 'Runtime',
        stream: 'stdout',
        limit: 1,
        offset: 0,
      });

      expect(Array.isArray(legacyLogs)).toBe(true);
      expect(page).toMatchObject({
        sessionId: session.id,
        query: 'Runtime',
        stream: 'stdout',
        limit: 1,
        offset: 0,
        total: 1,
      });
      expect(page.items.map((entry) => entry.text)).toEqual(['真实 Runtime 日志']);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('manages runtime session search, summary, favorite, archive, and delete through the renderer client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-client-runtime-manage-'));
  try {
    const running = await startZeusLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'client-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createRuntimeClientTestSpawn(),
    });
    const client = createDashboardClient({
      baseUrl: running.baseUrl,
      apiToken: 'client-token',
    });
    await selectLegacyCliTestAdapter(client);
    const session = await client.startRuntimeSession({
      projectId: 'project-1',
      command: 'claude',
      args: ['--version'],
      cwd: '/Users/david/hypha/zeus',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const summary = await client.generateRuntimeSessionSummary(session.id);
    const favorite = await client.setRuntimeSessionFavorite(session.id, true);
    const searched = await client.loadRuntimeSessions({
      query: 'Runtime 日志',
      favoriteOnly: true,
    });
    const archived = await client.archiveRuntimeSession(session.id);
    const archivedList = await client.loadRuntimeSessions({ archived: true });
    const deleted = await client.deleteRuntimeSession(session.id);

    expect(summary.summary).toContain('真实 Runtime 日志');
    expect(favorite.favorite).toBe(true);
    expect(searched.map((item) => item.id)).toEqual([session.id]);
    expect(archived.archived).toBe(true);
    expect(archivedList.map((item) => item.id)).toEqual([session.id]);
    expect(deleted.deletedAt).toBeTruthy();
    await running.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('exports readonly git patch through the renderer client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-client-patch-'));
  try {
    const running = await startZeusLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'client-token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const client = createDashboardClient({
      baseUrl: running.baseUrl,
      apiToken: 'client-token',
    });

    const patch = await client.exportGitPatch();

    expect(patch.fileName).toMatch(/^zeus-diff-.*\.patch$/u);
    expect(patch.mimeType).toBe('text/x-patch');
    await running.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('exports project-scoped readonly git patch through the renderer client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-client-project-patch-'));
  const projectPath = join(dir, 'project-client-patch');
  await mkdir(projectPath, { recursive: true });
  const observedDiffCwds: string[] = [];
  try {
    const running = await startZeusLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'client-token',
      projectRoot: '/Users/david/hypha/zeus',
      gitDiffReader: async (cwd) => {
        observedDiffCwds.push(cwd);
        return {
          isRepository: true,
          files: ['src/client-project-patch.ts'],
          diffText: 'diff --git a/src/client-project-patch.ts b/src/client-project-patch.ts',
          fileDiffs: [
            {
              oldPath: 'src/client-project-patch.ts',
              newPath: 'src/client-project-patch.ts',
              changeType: 'modified',
              addedLines: 1,
              deletedLines: 0,
              hunks: [],
            },
          ],
        };
      },
    });
    const client = createDashboardClient({
      baseUrl: running.baseUrl,
      apiToken: 'client-token',
    });
    const project = await client.createProject({
      name: 'Client Patch Project',
      localPath: projectPath,
    });

    const patch = await client.exportProjectGitPatch(project.id);

    expect(patch.fileName).toMatch(/^zeus-diff-.*\.patch$/u);
    expect(patch.mimeType).toBe('text/x-patch');
    expect(patch.files).toEqual(['src/client-project-patch.ts']);
    expect(observedDiffCwds).toEqual([projectPath]);
    await running.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('sends runtime input, interrupt, resize, and loads terminal snapshot through the renderer client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-client-runtime-terminal-'));
  const writes: string[] = [];
  try {
    const running = await startZeusLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'client-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: () => {
        const callbacks = new Map<string, Array<(value: unknown) => void>>();
        const handle: AiRuntimeProcessHandle = {
          pid: 333,
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
          resize() {},
        };
        return handle;
      },
    });
    const client = createDashboardClient({
      baseUrl: running.baseUrl,
      apiToken: 'client-token',
    });
    await selectLegacyCliTestAdapter(client);
    const session = await client.startRuntimeSession({
      projectId: 'project-1',
      command: 'claude',
      cwd: '/Users/david/hypha/zeus',
    });

    await client.sendRuntimeInput(session.id, '继续执行');
    await client.resizeRuntimeSession(session.id, { cols: 100, rows: 30 });
    await client.interruptRuntimeSession(session.id);
    const snapshot = await client.loadRuntimeTerminalSnapshot(session.id);
    const terminalEvents = await client.loadRuntimeTerminalEvents(session.id, {
      limit: 10,
      offset: 0,
    });

    expect(writes).toEqual(['继续执行']);
    expect(snapshot.logs.map((entry) => entry.text)).toContain('echo:继续执行');
    expect(snapshot.logs.map((entry) => entry.text)).toContain('signal:SIGINT');
    expect(terminalEvents).toMatchObject({
      sessionId: session.id,
      limit: 10,
      offset: 0,
      total: expect.any(Number),
    });
    expect(terminalEvents.total).toBeGreaterThanOrEqual(2);
    expect(terminalEvents.items.map((entry) => `${entry.eventType}:${entry.content}`)).toEqual(expect.arrayContaining(['stdout:echo:继续执行', 'stderr:signal:SIGINT']));
    expect(terminalEvents.items.map((entry) => entry.seq)).toEqual([...terminalEvents.items.map((entry) => entry.seq)].sort((left, right) => left - right));
    await running.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('restores archived runtime sessions and creates a follow-up task through the renderer client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-client-runtime-continue-'));
  try {
    const running = await startZeusLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'client-token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createRuntimeClientTestSpawn(),
    });
    const client = createDashboardClient({
      baseUrl: running.baseUrl,
      apiToken: 'client-token',
    });
    await selectLegacyCliTestAdapter(client);
    const project = await client.createProject({
      name: 'Zeus',
      localPath: '/Users/david/hypha/zeus',
    });
    const session = await client.startRuntimeSession({
      projectId: project.id,
      command: 'claude',
      args: ['--version'],
      cwd: project.localPath,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await client.archiveRuntimeSession(session.id);

    const restored = await client.restoreRuntimeSession(session.id);
    const task = await client.createTaskFromRuntimeSession(session.id, {
      title: '继续 Runtime 会话',
      instruction: '基于真实日志继续分析',
    });

    expect(restored.archived).toBe(false);
    expect(task.projectId).toBe(project.id);
    expect(task.description).toContain('基于真实日志继续分析');
    expect(task.sourceContextJson).toContain(session.id);
    await running.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('loads and saves app shell operations settings through the renderer client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-client-app-shell-'));
  try {
    const running = await startZeusLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'client-token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const client = createDashboardClient({
      baseUrl: running.baseUrl,
      apiToken: 'client-token',
    });
    const project = await client.createProject({
      name: 'Zeus',
      localPath: '/Users/david/hypha/zeus',
      description: '真实项目',
    });

    const initial = await client.loadAppShellSettings();
    const saved = await client.saveAppShellSettings({
      appLanguage: 'en-US',
      appearance: 'light',
      webviewDebugEnabled: true,
      developerModeEnabled: true,
      multiWindowEnabled: false,
      backgroundModeEnabled: false,
      desktopNotificationsEnabled: false,
      openAtLoginEnabled: true,
      autoUpdateChannel: 'manual',
      defaultProjectId: project.id,
      pinnedProjectIds: [project.id],
      defaultModel: 'gpt-5.1-codex',
      defaultTaskTemplateId: 'task_template_bug_fix',
    });
    const cleared = await client.clearLocalCaches();

    expect(initial.localLogDirectory).toContain('logs');
    expect(initial.dataPortability).toEqual({
      importSupported: true,
      exportSupported: true,
      redactsSecrets: true,
    });
    expect(initial.defaultProjectId).toBeNull();
    expect(initial.pinnedProjectIds).toEqual([]);
    expect(initial.defaultModel).toBeNull();
    expect(initial.defaultTaskTemplateId).toBeNull();
    expect(initial.appLanguage).toBe('zh-CN');
    expect(saved).toMatchObject({
      appLanguage: 'en-US',
      appearance: 'light',
      webviewDebugEnabled: true,
      developerModeEnabled: true,
      multiWindowEnabled: false,
      desktopNotificationsEnabled: false,
      openAtLoginEnabled: true,
      defaultProjectId: project.id,
      pinnedProjectIds: [project.id],
      defaultModel: 'gpt-5.1-codex',
      defaultTaskTemplateId: 'task_template_bug_fix',
    });
    expect(cleared.clearedCaches).toEqual(['code-index', 'graph-view', 'layout']);
    await running.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('exports and imports redacted local settings through the renderer client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-client-data-portability-'));
  try {
    const running = await startZeusLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'client-token',
      projectRoot: '/Users/david/hypha/zeus',
      secretStore: createMemorySecretStore(),
    });
    const client = createDashboardClient({
      baseUrl: running.baseUrl,
      apiToken: 'client-token',
    });

    await client.saveTelegramBotToken('telegram-token-real');
    await client.saveAppShellSettings({
      appLanguage: 'zh-CN',
      appearance: 'dark',
      webviewDebugEnabled: true,
      developerModeEnabled: true,
      multiWindowEnabled: true,
      backgroundModeEnabled: true,
      desktopNotificationsEnabled: false,
      openAtLoginEnabled: true,
      autoUpdateChannel: 'manual',
    });
    const exported = await client.exportLocalSettings();
    const imported = await client.importLocalSettings({
      schemaVersion: 1,
      settings: {
        appShell: {
          appLanguage: 'en-US',
          appearance: 'light',
          webviewDebugEnabled: false,
          developerModeEnabled: false,
          multiWindowEnabled: false,
          backgroundModeEnabled: false,
          desktopNotificationsEnabled: true,
          openAtLoginEnabled: false,
          autoUpdateChannel: 'manual',
          pinnedProjectIds: ['project_imported'],
        },
      },
    });

    expect(exported.redaction.secretsRedacted).toBe(true);
    expect(JSON.stringify(exported)).not.toContain('telegram-token-real');
    expect(imported.importedSettings).toEqual(['app-shell']);
    expect(await client.loadAppShellSettings()).toMatchObject({
      appLanguage: 'en-US',
      appearance: 'light',
      multiWindowEnabled: false,
      desktopNotificationsEnabled: true,
      openAtLoginEnabled: false,
      pinnedProjectIds: ['project_imported'],
    });
    await running.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('exports and imports redacted local business data through the renderer client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-client-business-data-portability-'));
  try {
    const running = await startZeusLocalServer({
      dbPath: join(dir, 'zeus.db'),
      apiToken: 'client-token',
      projectRoot: '/Users/david/hypha/zeus',
      secretStore: createMemorySecretStore(),
    });
    const client = createDashboardClient({
      baseUrl: running.baseUrl,
      apiToken: 'client-token',
    });
    const project = await client.createProject({
      name: 'Zeus',
      localPath: '/Users/david/hypha/zeus',
      description: '真实当前仓库',
    });
    const task = await client.createTask({
      projectId: project.id,
      title: '迁移任务',
      description: '验证业务数据快照',
      tags: ['portable'],
      sourceContext: { path: '/Users/david/hypha/zeus' },
    });
    await client.updateTaskStatus(task.id, 'running');

    const exported = await client.exportLocalBusinessData();
    const imported = await client.importLocalBusinessData(exported);

    expect(exported.redaction.secretsRedacted).toBe(true);
    expect(exported.data.projects.map((item) => item.id)).toContain(project.id);
    expect(exported.data.tasks.map((item) => item.id)).toContain(task.id);
    expect(JSON.stringify(exported)).not.toContain('telegram-token-real');
    expect(imported.importedCounts).toMatchObject({ projects: 1, tasks: 1 });
    await running.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
