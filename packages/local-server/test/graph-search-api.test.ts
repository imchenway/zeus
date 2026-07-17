import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiRuntimeProcessHandle, AiRuntimeSpawn, CodexAppServerEvent, CodexAppServerManager, CodexThreadStartInput, CodexTurnStartInput } from '@zeus/ai-runtime';
import { createZeusDatabase } from '@zeus/storage';
import { createLocalServer } from '../src/index';

function createGraphAnswerSpawn(): AiRuntimeSpawn {
  return (_command, args) => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 515,
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

class GraphNativeCodexManager implements CodexAppServerManager {
  readonly threadStarts: CodexThreadStartInput[] = [];
  readonly turnStarts: CodexTurnStartInput[] = [];
  private readonly listeners = new Set<(event: CodexAppServerEvent) => unknown>();
  private sequence = 0;

  async ensureReady() {
    return { generationId: 'graph-native-generation', initializedAt: '2026-07-13T00:00:00.000Z', models: [], supportedModels: ['project-codex-model'] };
  }
  async startThread(input: CodexThreadStartInput) {
    this.threadStarts.push(input);
    return { id: 'graph-native-thread', turns: [] };
  }
  async resumeThread(input: { threadId: string }) {
    return { id: input.threadId, turns: [] };
  }
  async readThread(input: { threadId: string }) {
    return { id: input.threadId, turns: [] };
  }
  async startTurn(input: CodexTurnStartInput) {
    this.turnStarts.push(input);
    setTimeout(() => {
      void this.emit('item/completed', {
        threadId: input.threadId,
        turnId: 'graph-native-turn',
        item: { id: 'graph-answer-item', type: 'agentMessage', status: 'completed', phase: 'final_answer', text: 'AI 图谱回答：local-server 来源已核验' },
      }).then(() => this.emit('turn/completed', { threadId: input.threadId, turn: { id: 'graph-native-turn', status: 'completed' } }));
    }, 0);
    return { id: 'graph-native-turn', threadId: input.threadId, items: [] };
  }
  async steerTurn() {
    return { turnId: 'graph-native-turn' };
  }
  async interruptTurn() {}
  async respondToServerRequest() {}
  subscribe(listener: (event: CodexAppServerEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getState() {
    return { type: 'ready' as const, generationId: 'graph-native-generation', capabilities: { generationId: 'graph-native-generation', initializedAt: '2026-07-13T00:00:00.000Z', models: [], supportedModels: ['project-codex-model'] } };
  }
  async prepareForShutdown() {}
  async close() {}
  private async emit(method: string, params: unknown) {
    const event: CodexAppServerEvent = { generationId: 'graph-native-generation', sequence: ++this.sequence, method, params, receivedAt: `2026-07-13T00:00:0${this.sequence}.000Z` };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

class FailingGraphNativeCodexManager extends GraphNativeCodexManager {
  override async startTurn(input: CodexTurnStartInput): Promise<never> {
    this.turnStarts.push(input);
    throw new Error('native graph dispatch failed');
  }
}

async function configureLegacyGraphRuntime(server: Awaited<ReturnType<typeof createLocalServer>>, defaultAdapterId: 'claude' | 'gemini' = 'claude'): Promise<void> {
  const response = await server.inject({
    method: 'PUT',
    url: '/api/runtime/settings',
    headers: { authorization: 'Bearer token' },
    payload: {
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
    },
  });
  expect(response.statusCode).toBe(200);
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'zeus-graph-search-api-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('graph search API', () => {
  it('searches real graph nodes by keyword and node type after scanning', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/search?query=local-server&nodeType=file&edgeType=declares&minConfidence=1',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.query).toBe('local-server');
    expect(result.nodeType).toBe('file');
    expect(result.edgeType).toBe('declares');
    expect(result.minConfidence).toBe(1);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.every((node: { nodeType: string; sourceRef: string }) => node.nodeType === 'file' && node.sourceRef.includes('local-server'))).toBe(true);
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.edges.every((edge: { edgeType: string; confidence: number }) => edge.edgeType === 'declares' && edge.confidence >= 1)).toBe(true);
    await server.close();
  });

  it('searches graph nodes from memory cache without persisting SQLite graph facts', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const settingsResponse = await server.inject({
      method: 'PUT',
      url: '/api/code-map/settings',
      headers: { authorization: 'Bearer token' },
      payload: {
        defaultScanScope: 'project',
        defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
        maxCallChainDepth: 3,
        showLowConfidenceEdges: false,
        layoutAlgorithm: 'hierarchical',
        graphCacheStrategy: 'memory',
        tableRelationInference: 'foreign_key_and_name',
        aiSummaryEnabled: false,
        incrementalScanEnabled: true,
        performanceMonitoringEnabled: false,
      },
    });
    expect(settingsResponse.statusCode).toBe(200);
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/search?query=local-server&nodeType=file&edgeType=declares&minConfidence=1',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.every((node: { nodeType: string; sourceRef: string }) => node.nodeType === 'file' && node.sourceRef.includes('local-server'))).toBe(true);
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.edges.every((edge: { edgeType: string; confidence: number }) => edge.edgeType === 'declares' && edge.confidence >= 1)).toBe(true);
    await server.close();

    const restarted = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const staleResponse = await restarted.inject({
      method: 'GET',
      url: '/api/graph/search?query=local-server&nodeType=file',
      headers: { authorization: 'Bearer token' },
    });
    expect(staleResponse.statusCode).toBe(200);
    expect(staleResponse.json().nodes).toHaveLength(0);
    await restarted.close();
  });

  it('answers a project graph question through AI Runtime with sourced graph context', async () => {
    const codexManager = new GraphNativeCodexManager();
    let cliSpawnCount = 0;
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
      codexAppServerManager: codexManager,
      aiRuntimeSpawn: (command, args, options) => {
        cliSpawnCount += 1;
        return createGraphAnswerSpawn()(command, args, options);
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer token' },
      payload: {
        defaultAdapterId: 'codex',
        adapterModels: { codex: 'global-codex-model' },
      },
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();
    await server.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}/config`,
      headers: { authorization: 'Bearer token' },
      payload: {
        defaultModel: 'project-codex-model',
        defaultWorkMode: 'review',
        defaultTaskPrompt: '图谱问答也必须继承项目默认提示词',
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ask`,
      headers: { authorization: 'Bearer token' },
      payload: { question: 'local-server' },
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    expect(answer.answer).toContain('AI 图谱回答');
    expect(answer.answer).toContain('local-server 来源已核验');
    expect(answer.sessionId).toBeNull();
    expect(answer.conversationId).toMatch(/^conversation_/);
    expect(answer.sources.nodes.length).toBeGreaterThan(0);
    expect(answer.sources.nodes[0].sourceRef).toContain('local-server');
    expect(answer.sources.nodes[0].sourceRef).not.toContain('mock');
    expect(codexManager.threadStarts[0]).toMatchObject({ model: 'project-codex-model', cwd: '/Users/david/hypha/zeus', ephemeral: true, sandbox: { type: 'readOnly', networkAccess: false } });
    expect(codexManager.turnStarts[0]?.input).toEqual([{ type: 'text', text: expect.stringContaining('图谱问答：local-server') }]);
    const promptText = String(codexManager.turnStarts[0]?.input[0]?.text ?? '');
    expect(promptText).toContain('项目默认工作模式：review');
    expect(promptText).toContain('项目默认任务提示词：图谱问答也必须继承项目默认提示词');
    expect(cliSpawnCount).toBe(0);
    await server.close();
  });

  it('maps the disabled native Codex graph route to 409 while leaving a non-Codex graph provider available', async () => {
    const codexManager = new GraphNativeCodexManager();
    let cliSpawnCount = 0;
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
      codexNativeEnabled: false,
      codexAppServerManager: codexManager,
      aiRuntimeSpawn: (command, args, options) => {
        cliSpawnCount += 1;
        return createGraphAnswerSpawn()(command, args, options);
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/runtime/settings',
      headers: { authorization: 'Bearer token' },
      payload: { defaultAdapterId: 'codex', adapterModels: { codex: 'project-codex-model' } },
    });
    const project = (
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: 'Bearer token' },
        payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
      })
    ).json();
    await server.inject({ method: 'POST', url: '/api/graph/scan-current', headers: { authorization: 'Bearer token' } });

    const disabled = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ask`,
      headers: { authorization: 'Bearer token' },
      payload: { question: 'local-server' },
    });

    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ error: 'ZEUS_CODEX_NATIVE_DISABLED' });
    expect(codexManager.threadStarts).toHaveLength(0);
    expect(codexManager.turnStarts).toHaveLength(0);
    expect(cliSpawnCount).toBe(0);

    await configureLegacyGraphRuntime(server);
    const legacy = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ask`,
      headers: { authorization: 'Bearer token' },
      payload: { question: 'local-server' },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toMatchObject({ answer: expect.stringContaining('local-server 来源已核验') });
    expect(cliSpawnCount).toBe(1);
    await server.close();
  });

  it('does not fall back to a CLI when native Codex graph dispatch fails', async () => {
    const codexManager = new FailingGraphNativeCodexManager();
    let cliSpawnCount = 0;
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
      codexAppServerManager: codexManager,
      aiRuntimeSpawn: (command, args, options) => {
        cliSpawnCount += 1;
        return createGraphAnswerSpawn()(command, args, options);
      },
    });
    await server.inject({ method: 'PUT', url: '/api/runtime/settings', headers: { authorization: 'Bearer token' }, payload: { defaultAdapterId: 'codex', adapterModels: { codex: 'project-codex-model' } } });
    const project = (await server.inject({ method: 'POST', url: '/api/projects', headers: { authorization: 'Bearer token' }, payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' } })).json();
    await server.inject({ method: 'POST', url: '/api/graph/scan-current', headers: { authorization: 'Bearer token' } });

    const response = await server.inject({ method: 'POST', url: `/api/projects/${project.id}/ask`, headers: { authorization: 'Bearer token' }, payload: { question: 'local-server' } });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(codexManager.threadStarts).toHaveLength(1);
    expect(codexManager.turnStarts).toHaveLength(1);
    expect(cliSpawnCount).toBe(0);
    await server.close();
  });

  it.each([
    ['claude', 'claude'],
    ['gemini', 'gemini'],
  ] as const)('dispatches %s graph questions only through the matching non-Codex CLI', async (adapterId, expectedCommand) => {
    const invocations: Array<{ command: string; args: string[] }> = [];
    const answerSpawn = createGraphAnswerSpawn();
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: (command, args, options) => {
        invocations.push({ command, args });
        return answerSpawn(command, args, options);
      },
    });
    await configureLegacyGraphRuntime(server, adapterId);
    const project = (await server.inject({ method: 'POST', url: '/api/projects', headers: { authorization: 'Bearer token' }, payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' } })).json();
    await server.inject({ method: 'POST', url: '/api/graph/scan-current', headers: { authorization: 'Bearer token' } });

    const response = await server.inject({ method: 'POST', url: `/api/projects/${project.id}/ask`, headers: { authorization: 'Bearer token' }, payload: { question: 'local-server' } });

    expect(response.statusCode).toBe(200);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.command).toBe(expectedCommand);
    await server.close();
  });

  it('answers graph questions from memory graph cache without requiring SQLite graph facts', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createGraphAnswerSpawn(),
    });
    await configureLegacyGraphRuntime(server);
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();
    await server.inject({
      method: 'PUT',
      url: '/api/code-map/settings',
      headers: { authorization: 'Bearer token' },
      payload: {
        defaultScanScope: 'project',
        defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
        maxCallChainDepth: 3,
        showLowConfidenceEdges: false,
        layoutAlgorithm: 'hierarchical',
        graphCacheStrategy: 'memory',
        tableRelationInference: 'foreign_key_and_name',
        aiSummaryEnabled: false,
        incrementalScanEnabled: true,
        performanceMonitoringEnabled: false,
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ask`,
      headers: { authorization: 'Bearer token' },
      payload: { question: 'local-server' },
    });

    expect(response.statusCode).toBe(200);
    const answer = response.json();
    expect(answer.answer).toContain('local-server 来源已核验');
    expect(answer.sources.nodes.length).toBeGreaterThan(0);
    expect(answer.sources.nodes[0].sourceRef).toContain('local-server');
    await server.close();
  });

  it('lists persisted graph question conversation history for a project', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createGraphAnswerSpawn(),
    });
    await configureLegacyGraphRuntime(server);
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });
    await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ask`,
      headers: { authorization: 'Bearer token' },
      payload: { question: 'local-server' },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/conversations`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const history = response.json();
    expect(history.items).toHaveLength(1);
    expect(history.total).toBe(1);
    expect(history.items[0].title).toBe('图谱问答：local-server');
    expect(history.items[0].messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant']);
    expect(history.items[0].messages[1].content).toContain('local-server 来源已核验');
    expect(history.items[0].messages[1].metadata.sourceNodeIds.length).toBeGreaterThan(0);
    await server.close();
  });

  it('searches, paginates, archives, restores, and loads graph question conversation detail', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createGraphAnswerSpawn(),
    });
    await configureLegacyGraphRuntime(server);
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });
    await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ask`,
      headers: { authorization: 'Bearer token' },
      payload: { question: 'local-server' },
    });
    await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ask`,
      headers: { authorization: 'Bearer token' },
      payload: { question: 'storage' },
    });

    const firstPageResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/conversations?query=storage&limit=1&offset=0`,
      headers: { authorization: 'Bearer token' },
    });

    expect(firstPageResponse.statusCode).toBe(200);
    const firstPage = firstPageResponse.json();
    expect(firstPage).toMatchObject({
      total: 1,
      limit: 1,
      offset: 0,
      query: 'storage',
      archived: false,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0].messages.some((message: { content: string }) => message.content.includes('storage'))).toBe(true);

    const detailResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/conversations/${firstPage.items[0].id}`,
      headers: { authorization: 'Bearer token' },
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant']);

    const archiveResponse = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/conversations/${firstPage.items[0].id}/archive`,
      headers: { authorization: 'Bearer token' },
    });

    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json().archived).toBe(true);
    const activePage = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/conversations?query=storage`,
      headers: { authorization: 'Bearer token' },
    });
    expect(activePage.json().items).toHaveLength(0);
    const archivedPage = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/conversations?query=storage&archived=true`,
      headers: { authorization: 'Bearer token' },
    });
    expect(archivedPage.json().items).toHaveLength(1);

    const restoreResponse = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/conversations/${firstPage.items[0].id}/restore`,
      headers: { authorization: 'Bearer token' },
    });

    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().archived).toBe(false);
    await server.close();
  });

  it('persists sourced graph question conversations and messages', async () => {
    const dbPath = join(tempDir, 'zeus.db');
    const server = await createLocalServer({
      dbPath,
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createGraphAnswerSpawn(),
    });
    await configureLegacyGraphRuntime(server);
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ask`,
      headers: { authorization: 'Bearer token' },
      payload: { question: 'local-server' },
    });

    expect(response.statusCode).toBe(200);
    await server.close();
    const db = await createZeusDatabase(dbPath);
    const conversations = db.select<{
      id: string;
      project_id: string;
      session_id: string | null;
      title: string;
      status: string;
    }>(`SELECT id, project_id, session_id, title, status FROM conversations WHERE project_id = ?`, [project.id]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      project_id: project.id,
      session_id: response.json().sessionId,
      title: '图谱问答：local-server',
      status: 'closed',
    });
    const messages = db.select<{
      role: string;
      content: string;
      source: string;
      metadata_json: string;
    }>(`SELECT role, content, source, metadata_json FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`, [conversations[0].id]);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]).toMatchObject({
      content: 'local-server',
      source: 'graph_question',
    });
    expect(messages[1].content).toContain('local-server 来源已核验');
    expect(JSON.parse(messages[1].metadata_json).sourceNodeIds.length).toBeGreaterThan(0);
  });

  it('creates a sourced task from a graph question conversation', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: createGraphAnswerSpawn(),
    });
    await configureLegacyGraphRuntime(server);
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });
    await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ask`,
      headers: { authorization: 'Bearer token' },
      payload: { question: 'local-server' },
    });
    const history = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/conversations`,
      headers: { authorization: 'Bearer token' },
    });
    const conversation = history.json().items[0];

    const response = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/conversations/${conversation.id}/tasks`,
      headers: { authorization: 'Bearer token' },
      payload: { intent: '把这次问答转为可执行整改任务' },
    });

    expect(response.statusCode).toBe(201);
    const task = response.json();
    expect(task.projectId).toBe(project.id);
    expect(task.createdFrom).toBe('graph_question');
    expect(task.title).toContain('local-server');
    const context = JSON.parse(task.sourceContextJson);
    expect(context.graphQuestion).toMatchObject({
      conversationId: conversation.id,
      question: 'local-server',
    });
    expect(context.graphQuestion.answer).toContain('local-server 来源已核验');
    expect(context.graphQuestion.sourceNodeIds.length).toBeGreaterThan(0);
    expect(context.suggestedTestScope.some((item: string) => item.includes('local-server'))).toBe(true);
    const events = await server.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/events`,
      headers: { authorization: 'Bearer token' },
    });
    expect(events.json().map((event: { eventType: string }) => event.eventType)).toContain('task.created.from_graph_question');
    await server.close();
  });

  it('does not call AI Runtime when graph question has no sourced context', async () => {
    let spawned = false;
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
      aiRuntimeSpawn: ((command, args, options) => {
        spawned = true;
        return createGraphAnswerSpawn()(command, args, options);
      }) satisfies AiRuntimeSpawn,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    const project = projectResponse.json();

    const response = await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ask`,
      headers: { authorization: 'Bearer token' },
      payload: { question: '完全不存在的模块' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().answer).toContain('不足以判断');
    expect(response.json().sources.nodes).toEqual([]);
    expect(spawned).toBe(false);
    await server.close();
  });
});
