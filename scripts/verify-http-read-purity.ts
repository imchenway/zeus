import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {CodexAppServerManager} from '@zeus/ai-runtime';
import {createZeusDataLayout, startZeusLocalServer} from '../packages/local-server/src/index.js';
import {
    ConversationProviderItemRepository,
    ConversationRepository,
    createZeusDatabase,
    ProjectRepository,
    ProjectRepositoryRegistrationRepository,
    RuntimeSessionRepository,
    TaskEventRepository,
    TaskRepository,
} from '../packages/storage/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-http-read-purity-'));
const dataRoot = join(probeRoot, 'zeus-test-data');
const projectRoot = join(probeRoot, 'project');
const databasePath = join(dataRoot, 'data', 'zeus.db');
const apiToken = 'http-read-purity-probe-token';
const providerCalls: string[] = [];
let runningServer: Awaited<ReturnType<typeof startZeusLocalServer>> | undefined;
let observer: DatabaseSync | undefined;

try {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, 'README.md'), 'HTTP read purity probe\n');
  git(projectRoot, ['init', '-b', 'main']);
  git(projectRoot, ['config', 'user.name', 'Zeus Read Purity Probe']);
  git(projectRoot, ['config', 'user.email', 'read-purity@zeus.invalid']);
  git(projectRoot, ['add', 'README.md']);
  git(projectRoot, ['commit', '-m', 'read purity baseline']);
  const commitHash = git(projectRoot, ['rev-parse', 'HEAD']).trim();

  const database = await createZeusDatabase(databasePath);
  let projectId: string;
  let taskId: string;
  let conversationId: string;
  let repositoryId: string;
  let runtimeSessionId: string;
  try {
    const project = new ProjectRepository(database).create({ id: 'project_http_read_purity', name: 'HTTP 读取纯度', localPath: projectRoot });
    const task = new TaskRepository(database).create({
      id: 'task_http_read_purity',
      projectId: project.id,
      title: 'GET 不得隐式启动或保存',
      taskType: 'optimization',
      description: '',
      optimizationCurrentState: '读取可能混入副作用',
      optimizationExpectedOutcome: '读取只消费既有状态',
      createdFrom: 'verification',
      sourceContext: {},
      managementStatus: 'todo',
      allowCodeChanges: true,
      allowGitCommit: false,
    });
    const conversation = new ConversationRepository(database).create({
      id: 'conversation_http_read_purity',
      projectId: project.id,
      taskId: task.id,
      title: 'Provider 未启动的历史会话',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerThreadId: 'thread_http_read_purity',
      providerState: 'ready',
      agentKind: 'codex',
      agentTransport: 'app_server',
      nativeSessionId: 'thread_http_read_purity',
    });
    new ConversationProviderItemRepository(database).upsertCompleted({
      conversationId: conversation.id,
      turnId: 'turn_http_read_purity',
      providerThreadId: 'thread_http_read_purity',
      providerTurnId: 'turn_http_read_purity',
      providerItemId: 'subagent_activity_http_read_purity',
      itemType: 'subAgentActivity',
      phase: 'prework',
      payload: { type: 'subAgentActivity', agentThreadId: 'thread_child_probe', agentPath: '/root/thread_child_probe', kind: 'spawned' },
      textContent: '',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agentKind: 'codex',
    });
    const repository = new ProjectRepositoryRegistrationRepository(database).replaceForProject(project.id, [{ projectId: project.id, name: 'project', relativePath: '.', localPath: projectRoot }])[0]!;
    new TaskEventRepository(database).create({ taskId: task.id, eventType: 'verification.seeded', title: '读取纯度探针已准备', payload: { source: 'temporary_database' } });
    const runtimeSessions = new RuntimeSessionRepository(database);
    const runtimeStartedAt = new Date(Date.now() - 1_000).toISOString();
    const runtimeSession = runtimeSessions.create({
      id: 'runtime_http_read_purity',
      projectId: project.id,
      taskId: task.id,
      command: '/usr/bin/printf',
      args: ['runtime read purity'],
      cwd: projectRoot,
      status: 'exited',
      startedAt: runtimeStartedAt,
    });
    runtimeSessions.updateStatus(runtimeSession.id, { status: 'exited', exitCode: 0, endedAt: new Date().toISOString() });
    runtimeSessions.appendLog({ id: 'runtime_log_http_read_purity', sessionId: runtimeSession.id, stream: 'stdout', text: 'runtime read purity\n', createdAt: new Date().toISOString() });
    await database.save();
    projectId = project.id;
    taskId = task.id;
    conversationId = conversation.id;
    repositoryId = repository.id;
    runtimeSessionId = runtimeSession.id;
  } finally {
    await database.close();
  }

  runningServer = await startZeusLocalServer({
    dbPath: databasePath,
    dataLayout: createZeusDataLayout(dataRoot),
    apiToken,
    projectRoot: probeRoot,
    keychainService: 'dev.hypha.zeus.test.http-read-purity',
    telegramToken: '',
    codexAppServerManager: createPassiveCodexManager(providerCalls),
    codexNativeEnabled: false,
    executionHost: {
      instanceId: 'http-read-purity-probe',
      protocolVersion: 1,
      startedAt: new Date().toISOString(),
      mode: 'embedded',
    },
  });

  observer = new DatabaseSync(databasePath);
  const dataVersionBefore = readDataVersion(observer);
  const providerCallCountBefore = providerCalls.length;
  const requestPaths = [
    requestJson(`/api/projects/${projectId}/conversations/${conversationId}/subagents`),
    requestJson(`/api/projects/${projectId}/conversations/${conversationId}/subagents/thread_child_probe`),
    requestJson(`/api/projects/${projectId}/codex-conversation-capabilities`),
    requestJson(`/api/projects/${projectId}/codex-task-push-capabilities?taskId=${taskId}`),
    requestJson(`/api/projects/${projectId}/git/workbench`),
    requestJson(`/api/projects/${projectId}/git/workbench/repositories/${repositoryId}/commits/${commitHash}`),
    requestJson(`/api/projects/${projectId}/git/workbench/repositories/${repositoryId}/compare?ref=main`),
    requestJson(`/api/projects/${projectId}/git/status`),
    requestJson(`/api/projects/${projectId}/git/diff`),
    requestJson(`/api/projects?query=${encodeURIComponent('HTTP 读取纯度')}`),
    requestJson('/api/projects/archived'),
    requestJson(`/api/projects/${projectId}`),
    requestJson(`/api/projects/${projectId}/config`),
    requestJson(`/api/projects/${projectId}/scan-status`),
    requestJson(`/api/projects/${projectId}/overview`),
    requestJson(`/api/projects/${projectId}/workspace-config`),
    requestJson(`/api/projects/${projectId}/task-board`),
    requestJson(`/api/tasks/${taskId}`),
    requestJson(`/api/tasks/${taskId}/events`),
    requestJson(`/api/tasks?projectId=${projectId}`),
    requestJson(`/api/tasks/archived?projectId=${projectId}`),
    requestJson(`/api/task-templates?projectId=${projectId}`),
    requestJson('/api/runtime/adapters'),
    requestJson('/api/runtime/adapters/not-a-real-adapter/check'),
    requestJson('/api/runtime/settings'),
    requestJson('/api/runtime/sessions'),
    requestJson(`/api/runtime/sessions?projectId=${projectId}`),
    requestJson(`/api/runtime/sessions/${runtimeSessionId}`),
    requestJson(`/api/runtime/sessions/${runtimeSessionId}/logs`),
    requestJson(`/api/runtime/sessions/${runtimeSessionId}/logs?limit=1&offset=0`),
    requestJson(`/api/runtime/sessions/${runtimeSessionId}/terminal`),
    requestJson(`/api/runtime/sessions/${runtimeSessionId}/terminal/events?limit=1&offset=0`),
  ];
  const responses = await Promise.all(requestPaths);
  const dataVersionAfter = readDataVersion(observer);
  const providerCallsFromReads = providerCalls.slice(providerCallCountBefore);

  assertProbe(
    responses.every((response) => response.statusCode < 500),
    `GET 路由出现服务端错误：${JSON.stringify(responses)}`,
  );
  assertProbe(responses[0]?.statusCode === 409 && responses[1]?.statusCode === 409, 'Provider 未就绪时 subagents GET 必须明确 unavailable，不能尝试启动。');
  assertProbe(readErrorCode(responses[0]?.body) === 'ZEUS_CODEX_SUBAGENTS_UNAVAILABLE' && readErrorCode(responses[1]?.body) === 'ZEUS_CODEX_SUBAGENTS_UNAVAILABLE', 'Subagents 模块必须保持既有 unavailable 错误码。');
  assertProbe(responses[2]?.statusCode === 200 && isRecord(responses[2].body) && responses[2].body.available === false && Array.isArray(responses[2].body.models), '会话能力模块必须在 Provider idle 时返回兼容的不可用投影。');
  assertProbe(
    responses[3]?.statusCode === 200 && isRecord(responses[3].body) && responses[3].body.taskId === taskId && Array.isArray(responses[3].body.repositories) && responses[3].body.repositories.length === 1,
    '任务推送能力模块必须保留 taskId 与已登记仓库响应。',
  );
  assertProbe(responses[4]?.statusCode === 200 && responses[5]?.statusCode === 200 && responses[6]?.statusCode === 200, '三个 Git workbench GET 必须只读取已登记 repository。');
  assertProbe(responses[7]?.statusCode === 200 && responses[8]?.statusCode === 200, 'Project Git status/diff 模块必须保持 200 查询响应。');
  assertAllSuccessfulExcept(responses, [
    `/api/projects/${projectId}/conversations/${conversationId}/subagents`,
    `/api/projects/${projectId}/conversations/${conversationId}/subagents/thread_child_probe`,
    '/api/runtime/adapters/not-a-real-adapter/check',
  ]);
  assertProbe(readResponse(responses, `/api/projects/${projectId}/overview`).statusCode === 200, 'Project Query overview 必须保持兼容的 Git/任务聚合响应。');
  assertProbe(readResponse(responses, `/api/projects/${projectId}/task-board`).statusCode === 200, 'Work Management Query task-board 必须保持 copied-DB 响应。');
  assertProbe(readResponse(responses, `/api/tasks/${taskId}/events`).statusCode === 200, 'Work Management Query events 必须读取既有任务时间线。');
  assertProbe(readResponse(responses, `/api/runtime/adapters/not-a-real-adapter/check`).statusCode === 404, '未知 Runtime adapter check 必须保持历史 404，不得启动会话。');
  const runtimeSessionResponse = readResponse(responses, `/api/runtime/sessions/${runtimeSessionId}`);
  assertProbe(runtimeSessionResponse.statusCode === 200 && isRecord(runtimeSessionResponse.body) && runtimeSessionResponse.body.id === runtimeSessionId, 'Runtime Query 必须返回持久会话投影。');
  const runtimeEventsResponse = readResponse(responses, `/api/runtime/sessions/${runtimeSessionId}/terminal/events?limit=1&offset=0`);
  assertProbe(runtimeEventsResponse.statusCode === 200 && isRecord(runtimeEventsResponse.body) && runtimeEventsResponse.body.total === 1, 'Runtime Query 必须以只读分页返回 terminal_events。');
  assertProbe(dataVersionAfter === dataVersionBefore, `${responses.length} 个 GET 改变了 SQLite data_version：before=${dataVersionBefore} after=${dataVersionAfter}`);
  assertProbe(providerCallsFromReads.length === 0, `${responses.length} 个 GET 触发了 Provider 调用：${providerCallsFromReads.join(', ')}`);

  console.log(
    JSON.stringify(
      {
        status: 'passed',
        observed: {
          routeCount: responses.length,
          routeGroups: { priorQueries: 9, projectQueries: 7, workManagementQueries: 6, runtimeQueries: 10 },
          statusCodes: responses.map((response) => response.statusCode),
          sqliteDataVersionStable: dataVersionAfter === dataVersionBefore,
          providerCallsFromReads,
          gitRepositorySource: 'registered_projection',
        },
      },
      null,
      2,
    ),
  );
} finally {
  observer?.close();
  if (runningServer) {
    await runningServer.prepareForShutdown().catch(() => undefined);
    await runningServer.close().catch(() => undefined);
  }
  await rm(probeRoot, { recursive: true, force: true });
}

function createPassiveCodexManager(calls: string[]): CodexAppServerManager {
  const passive = {
    getState: () => ({ type: 'idle' as const }),
    hasGeneration: () => false,
    generationForThread: () => null,
    listRuntimeGenerations: () => [],
    subscribe: () => () => undefined,
      subscribeRpcRetries: () => () => undefined,
    subscribeExternalAgentImport: () => () => undefined,
    prepareForShutdown: async () => undefined,
    close: async () => undefined,
  };
  return new Proxy(passive as unknown as CodexAppServerManager, {
    get(target, property, receiver) {
      if (Reflect.has(target as object, property)) return Reflect.get(target as object, property, receiver) as unknown;
      return () => {
        calls.push(String(property));
        throw Object.assign(new Error(`HTTP 读取触发了未就绪 Provider：${String(property)}`), { code: 'ZEUS_HTTP_READ_PROVIDER_START_FORBIDDEN' });
      };
    },
  });
}

async function requestJson(path: string): Promise<{ path: string; statusCode: number; body: unknown }> {
  if (!runningServer) throw new Error('HTTP 读取纯度探针尚未启动。');
  const response = await fetch(`${runningServer.baseUrl}${path}`, {
    headers: { origin: 'app://zeus', authorization: `Bearer ${apiToken}` },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = text;
  }
  return { path, statusCode: response.status, body };
}

function readDataVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA data_version').get() as { data_version?: unknown } | undefined;
  if (typeof row?.data_version !== 'number') throw new Error(`无法读取 SQLite data_version：${JSON.stringify(row)}`);
  return row.data_version;
}

function git(cwd: string, arguments_: string[]): string {
  const result = spawnSync('git', arguments_, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`Git 探针失败：git ${arguments_.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`HTTP GET 纯度行为探针失败：${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readErrorCode(value: unknown): string | null {
  return isRecord(value) && typeof value.error === 'string' ? value.error : null;
}

function readResponse(responses: Array<{ path: string; statusCode: number; body: unknown }>, path: string): { path: string; statusCode: number; body: unknown } {
  const response = responses.find((candidate) => candidate.path === path);
  if (!response) throw new Error(`HTTP GET 纯度行为探针缺少响应：${path}`);
  return response;
}

function assertAllSuccessfulExcept(responses: Array<{ path: string; statusCode: number; body: unknown }>, allowedNonSuccessPaths: string[]): void {
  const allowed = new Set(allowedNonSuccessPaths);
  const failed = responses.filter((response) => response.statusCode >= 400 && !allowed.has(response.path));
  assertProbe(failed.length === 0, `模块化查询出现非兼容状态：${JSON.stringify(failed)}`);
}
