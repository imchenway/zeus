import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {CodexAppServerManager} from '@zeus/ai-runtime';
import {
    type BrowserAutomationPort,
    createZeusDataLayout,
    inspectReadOnlyValidationManifest,
    startZeusLocalServer,
    verifyReadOnlyValidationDescriptor
} from '../packages/local-server/src/index.ts';
import {
    ConversationGoalRepository,
    ConversationRepository,
    createZeusDatabase,
    ProjectRepository
} from '../packages/storage/src/index.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const probeRoot = await realpath(await mkdtemp(join(tmpdir(), 'zeus-read-only-validation-fence-')));
const sourceRoot = join(probeRoot, 'formal-source');
const validationBase = join(probeRoot, 'isolated-zeus-test-instance');
const validationRunId = randomUUID();
const validationRoot = join(validationBase, 'read-only-validation', validationRunId);
const sourceDatabasePath = join(sourceRoot, 'data', 'zeus.db');
const validationDatabasePath = join(validationRoot, 'data', 'zeus.db');
const manifestPath = `${validationDatabasePath}.read-only-validation.json`;
const poisonWorkspace = join(sourceRoot, 'formal-workspace-do-not-read');
const poisonPath = join(poisonWorkspace, 'poison.txt');
const apiToken = 'read-only-validation-probe-token';
const forbiddenProviderCalls: string[] = [];
let browserInvocationCount = 0;
const observed: Record<string, unknown> = {};
let runningServer: Awaited<ReturnType<typeof startZeusLocalServer>> | undefined;

try {
  await mkdir(join(sourceRoot, 'data'), { recursive: true, mode: 0o700 });
  await mkdir(poisonWorkspace, { recursive: true, mode: 0o700 });
  await writeFile(poisonPath, 'copied path routes must never read this formal workspace file\n', { mode: 0o600 });
  await mkdir(join(validationBase, 'read-only-validation'), { recursive: true, mode: 0o700 });
  await mkdir(join(validationRoot, 'data'), { recursive: true, mode: 0o700 });
  await chmod(sourceRoot, 0o700);
  await chmod(join(sourceRoot, 'data'), 0o700);
  await chmod(validationBase, 0o700);
  await chmod(join(validationBase, 'read-only-validation'), 0o700);
  await chmod(validationRoot, 0o700);
  await chmod(join(validationRoot, 'data'), 0o700);

  const sourceDatabase = await createZeusDatabase(sourceDatabasePath);
  try {
    const project = new ProjectRepository(sourceDatabase).create({
      id: 'project_read_only_validation_probe',
      name: '正式历史只读验证',
      localPath: join(sourceRoot, 'workspace'),
      description: '该记录必须可读且永不被验证模式改写。',
    });
    new ConversationRepository(sourceDatabase).create({
      id: 'conversation_read_only_validation_probe',
      projectId: project.id,
      title: '正式历史副本记录',
      summary: '只读验证必须能展示历史，但不能续接 Provider。',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerThreadId: 'thread_read_only_validation_probe',
      providerState: 'ready',
      agentKind: 'codex',
      agentTransport: 'app_server',
      nativeSessionId: 'thread_read_only_validation_probe',
    });
    new ConversationGoalRepository(sourceDatabase).upsert(
      {
        conversationId: 'conversation_read_only_validation_probe',
        providerThreadId: 'thread_read_only_validation_probe',
        objective: '复制时已经持久化的目标',
        status: 'paused',
        tokenBudget: null,
        tokensUsed: 321,
        timeUsedSeconds: 45,
        providerCreatedAt: 1,
        providerUpdatedAt: 2,
      },
      { eventKind: 'created', occurredAt: '2026-08-21T00:00:00.000Z' },
    );
    sourceDatabase.execute(
      `INSERT INTO conversation_turns
        (id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
      [
        'turn_read_only_validation_poison',
        'conversation_read_only_validation_probe',
        'thread_read_only_validation_probe',
        'provider_turn_read_only_validation_poison',
        'client_submission_poison',
        '2026-08-21T00:00:00.000Z',
        '2026-08-21T00:00:00.000Z',
      ],
    );
    sourceDatabase.execute(
      `INSERT INTO conversation_resources
        (id, project_id, conversation_id, turn_id, item_id, source_index, canonical_target_digest,
         kind, presentation, display_json, target_json, authority_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'file', 'card', ?, ?, ?, ?, ?)`,
      [
        'resource_read_only_validation_poison',
        'project_read_only_validation_probe',
        'conversation_read_only_validation_probe',
        'turn_read_only_validation_poison',
        'item_read_only_validation_poison',
        'a'.repeat(64),
        JSON.stringify({ displayName: 'poison.txt', projectRelativePath: 'poison.txt', iconKind: 'file' }),
        JSON.stringify({ absolutePath: poisonPath }),
        JSON.stringify({ allowedRoot: poisonWorkspace }),
        '2026-08-21T00:00:00.000Z',
        '2026-08-21T00:00:00.000Z',
      ],
    );
    sourceDatabase.execute(
      `INSERT INTO turn_change_sets
        (id, project_id, conversation_id, turn_id, provider_turn_id, state, unified_diff, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'applied', '', ?, ?)`,
      [
        'change_set_read_only_validation_poison',
        'project_read_only_validation_probe',
        'conversation_read_only_validation_probe',
        'turn_read_only_validation_poison',
        'provider_turn_read_only_validation_poison',
        '2026-08-21T00:00:00.000Z',
        '2026-08-21T00:00:00.000Z',
      ],
    );
    sourceDatabase.execute(
      `INSERT INTO turn_change_files
        (id, change_set_id, source_item_id, source_index, new_path, change_type, unified_diff, post_exists, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'poison.txt', 'modified', '', 1, ?, ?)`,
      ['change_file_read_only_validation_poison', 'change_set_read_only_validation_poison', 'item_read_only_validation_poison', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z'],
    );
    sourceDatabase.execute(
      `INSERT INTO conversation_submissions
        (id, conversation_id, idempotency_key, request_hash, client_message_id, kind, requested_delivery, status, input_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'message', 'queue', 'active', '{}', ?, ?)`,
      [
        'submission_read_only_validation_historical_active',
        'conversation_read_only_validation_probe',
        'read-only-validation-historical-active-key',
        'read-only-validation-historical-active-hash',
        'read-only-validation-historical-active-client',
        '2026-08-21T00:00:00.000Z',
        '2026-08-21T00:00:00.000Z',
      ],
    );
    await sourceDatabase.save();
  } finally {
    await sourceDatabase.close();
  }
  const sourceJournalPreparation = new DatabaseSync(sourceDatabasePath);
  try {
    const journal = sourceJournalPreparation.prepare('PRAGMA journal_mode = DELETE').get() as { journal_mode?: unknown } | undefined;
    assertProbe(String(journal?.journal_mode ?? '').toLowerCase() === 'delete', 'strict 来源数据库必须在复制前进入无 companion 的 rollback journal。');
  } finally {
    sourceJournalPreparation.close();
  }

  const canonicalValidationRoot = await realpath(validationRoot);
  const copyArguments = ['--source', sourceDatabasePath, '--validation-root', canonicalValidationRoot, '--destination', validationDatabasePath, '--require-source-tree-immutable', '--validation-base', validationBase];
  const planRun = runCopyTool(copyArguments);
  const plan = parseJsonOutput(planRun.stdout) as { status?: unknown; expectedConfirmation?: unknown };
  assertProbe(planRun.status === 2 && plan.status === 'confirmation_required' && typeof plan.expectedConfirmation === 'string', 'Backup API 复制必须先返回绑定目标的确认计划。');
  const copyRun = runCopyTool([...copyArguments, '--confirmation', String(plan.expectedConfirmation)]);
  if (copyRun.status !== 0) throw new Error(`只读验证副本创建失败（exit=${String(copyRun.status)}）：${String(copyRun.stderr).slice(0, 2_000)}`);

  const descriptor = inspectReadOnlyValidationManifest(manifestPath);
  await verifyReadOnlyValidationDescriptor(descriptor);
  const immutableBefore = await immutableSnapshot(validationDatabasePath, manifestPath);
  const treeBefore = await listTree(validationRoot);
  const sourceBefore = await fileSnapshot(sourceDatabasePath);
  const poisonBefore = await fileIdentity(poisonPath);

  const browserAutomation: BrowserAutomationPort = {
    invoke: async () => {
      browserInvocationCount += 1;
      throw new Error('只读验证不允许调用 Browser automation。');
    },
  };
  runningServer = await startZeusLocalServer({
    dbPath: validationDatabasePath,
    dataLayout: createZeusDataLayout(validationRoot),
    apiToken,
    projectRoot: validationRoot,
    keychainService: 'dev.hypha.zeus.test.read-only-validation-probe',
    browserAutomation,
    codexAppServerManager: createPoisonCodexManager(forbiddenProviderCalls),
    codexNativeEnabled: false,
    readOnlyValidation: descriptor,
    executionHost: {
      instanceId: `read-only-validation-${descriptor.runId}`,
      protocolVersion: 1,
      startedAt: new Date().toISOString(),
      mode: 'embedded',
    },
  });

  const health = await requestJson(runningServer.baseUrl, '/health', { authenticated: false });
  const dashboard = await requestJson(runningServer.baseUrl, '/api/dashboard');
  const projects = await requestJson(runningServer.baseUrl, '/api/projects');
  const history = await requestJson(runningServer.baseUrl, '/api/projects/project_read_only_validation_probe/conversations');
  const goal = await requestJson(runningServer.baseUrl, '/api/projects/project_read_only_validation_probe/conversations/conversation_read_only_validation_probe/goal');
  const overview = await requestJson(runningServer.baseUrl, '/api/projects/project_read_only_validation_probe/overview');
  const diagnostics = await requestJson(runningServer.baseUrl, '/api/diagnostics/read-only-validation');
  const heavyWorkers = await requestJson(runningServer.baseUrl, '/api/diagnostics/heavy-workers');
  const executionHostStatus = await requestJson(runningServer.baseUrl, '/api/execution-host/status');

  assertProbe(health.statusCode === 200 && isRecord(health.body) && health.body.status === 'read_only_validation' && health.body.database === 'read_only_validation', 'health 必须显式报告 read_only_validation，而不是普通健康或故障。');
  assertProbe(
    dashboard.statusCode === 200 && isRecord(dashboard.body) && Array.isArray(dashboard.body.projects) && dashboard.body.projects.some((project) => isRecord(project) && project.id === 'project_read_only_validation_probe'),
    `Dashboard 必须能读取副本中的正式项目投影；实际响应 ${JSON.stringify(dashboard)}。`,
  );
  assertProbe(projects.statusCode === 200 && Array.isArray(projects.body) && projects.body.some((project) => isRecord(project) && project.id === 'project_read_only_validation_probe'), '项目查询必须读取副本事实。');
  assertProbe(
    history.statusCode === 200 && isRecord(history.body) && Array.isArray(history.body.items) && history.body.items.some((conversation) => isRecord(conversation) && conversation.id === 'conversation_read_only_validation_probe'),
    '会话历史查询必须读取副本事实。',
  );
  assertProbe(
    goal.statusCode === 200 &&
      isRecord(goal.body) &&
      isRecord(goal.body.goal) &&
      goal.body.goal.objective === '复制时已经持久化的目标' &&
      isRecord(goal.body.projection) &&
      goal.body.projection.source === 'copied_database' &&
      goal.body.projection.refreshBlocked === true,
    `目标查询必须只返回复制库投影并明确禁止 Provider refresh；实际响应 ${JSON.stringify(goal)}。`,
  );
  assertProbe(
    overview.statusCode === 200 && isRecord(overview.body) && isRecord(overview.body.git) && typeof overview.body.git.limitation === 'string' && overview.body.git.limitation.includes('不访问正式项目 Git'),
    `项目总览必须保留复制库查询，但显式降级 Git，实际响应 ${JSON.stringify(overview)}。`,
  );
  assertProbe(
    diagnostics.statusCode === 200 &&
      isRecord(diagnostics.body) &&
      diagnostics.body.runId === descriptor.runId &&
      diagnostics.body.manifestHash === descriptor.manifestHash &&
      Array.isArray(diagnostics.body.skipped) &&
      diagnostics.body.skipped.length === 15 &&
      new Set(diagnostics.body.skipped.map((entry) => (isRecord(entry) ? entry.id : null))).size === 15,
      '诊断接口必须给出同一副本身份和 15 项互异的启动副作用跳过证据。',
  );
  assertProbe(
    heavyWorkers.statusCode === 200 && isRecord(heavyWorkers.body) && heavyWorkers.body.acceptingJobs === false && heavyWorkers.body.activeJobs === 0 && heavyWorkers.body.queuedJobs === 0,
    `只读验证启动后 Heavy Worker 必须真实关闭且无排队；实际响应 ${JSON.stringify(heavyWorkers)}。`,
  );
  assertProbe(
    executionHostStatus.statusCode === 200 &&
      isRecord(executionHostStatus.body) &&
      executionHostStatus.body.activeTurnCount === 0 &&
      executionHostStatus.body.effectfulTurnCount === 0 &&
      executionHostStatus.body.waitingRequestCount === 0 &&
      executionHostStatus.body.activeRuntimeCount === 0 &&
      executionHostStatus.body.activeCommandRunCount === 0 &&
      executionHostStatus.body.hasActiveWork === false &&
      isRecord(executionHostStatus.body.copiedHistoryWork) &&
      executionHostStatus.body.copiedHistoryWork.activeTurnCount === 1 &&
      executionHostStatus.body.copiedHistoryWork.hasActiveWork === true,
    `副本中的历史活动行不能被宿主监督当作当前活动工作；实际响应 ${JSON.stringify(executionHostStatus)}。`,
  );

  const mutationResults = await Promise.all(
    [
      ['POST', '/api/projects'],
      ['PUT', '/api/settings/runtime'],
      ['PATCH', '/api/projects/project_read_only_validation_probe'],
      ['DELETE', '/api/projects/project_read_only_validation_probe'],
    ].map(async ([method, path]) => ({ method, path, response: await requestJson(runningServer!.baseUrl, path, { method, body: {} }) })),
  );
  for (const result of mutationResults) assertBlocked(result.response, `${result.method} ${result.path}`);

  const externalReadPaths = [
    '/api/codex/account',
    '/api/provider-runtime/health',
    '/api/runtime/sessions',
    '/api/telegram/settings',
    '/api/model-connections',
    '/api/models/catalog',
    '/api/zentao-instances',
    '/api/usage-overview',
    '/api/release/update',
    '/api/security/secrets',
    '/api/git/status',
    '/api/code-map/status',
      '/api/skills',
    '/api/projects/project_read_only_validation_probe/git/status',
    '/api/projects/project_read_only_validation_probe/database/secret',
    '/api/projects/project_read_only_validation_probe/model-selection',
    '/api/projects/project_read_only_validation_probe/scan-status',
    '/api/projects/project_read_only_validation_probe/codex-task-push-capabilities',
    '/api/projects/project_read_only_validation_probe/codex-conversation-capabilities',
    '/api/tasks/task_probe/diff',
    '/api/tasks/task_probe/git-workspaces',
    '/api/tasks/task_probe/integrations',
    '/api/projects/project_read_only_validation_probe/conversations/conversation_read_only_validation_probe/subagents',
    '/api/projects/project_read_only_validation_probe/conversations/conversation_read_only_validation_probe/resources/resource_read_only_validation_poison/open-intent',
    '/api/projects/project_read_only_validation_probe/conversations/conversation_read_only_validation_probe/resources/resource_read_only_validation_poison/preview',
    '/api/projects/project_read_only_validation_probe/conversations/conversation_read_only_validation_probe/tool-results/tool_result_read_only_validation_poison',
    '/api/projects/project_read_only_validation_probe/conversations/conversation_read_only_validation_probe/turns/turn_read_only_validation_poison/change-set/change_set_read_only_validation_poison/files/change_file_read_only_validation_poison/open-intent',
    '/api/projects/project_read_only_validation_probe/conversations/conversation_read_only_validation_probe/turns/turn_read_only_validation_poison/change-set/change_set_read_only_validation_poison/files/change_file_read_only_validation_poison/preview',
    '/api/execution-host/handoff',
    '/api/diagnostics/storage/artifacts',
  ];
  const externalReadResults = await Promise.all(externalReadPaths.map(async (path) => ({ path, response: await requestJson(runningServer!.baseUrl, path) })));
  for (const result of externalReadResults) assertBlocked(result.response, `GET ${result.path}`);

  await runningServer.prepareForShutdown();
  await runningServer.close();
  runningServer = undefined;

  const immutableAfter = await immutableSnapshot(validationDatabasePath, manifestPath);
  const treeAfter = await listTree(validationRoot);
  const sourceAfter = await fileSnapshot(sourceDatabasePath);
  const poisonAfter = await fileIdentity(poisonPath);
  observed.health = health.body;
  observed.reads = {
    dashboardProjects: isRecord(dashboard.body) && Array.isArray(dashboard.body.projects) ? dashboard.body.projects.length : null,
    projectCount: Array.isArray(projects.body) ? projects.body.length : null,
    historyCount: isRecord(history.body) && Array.isArray(history.body.items) ? history.body.items.length : null,
  };
  observed.blocked = { mutationMethods: mutationResults.map((entry) => entry.method), externalReadCount: externalReadResults.length };
  observed.skippedCapabilityCount = isRecord(diagnostics.body) && Array.isArray(diagnostics.body.skipped) ? diagnostics.body.skipped.length : null;
  observed.providerExternalCalls = forbiddenProviderCalls;
  observed.browserInvocationCount = browserInvocationCount;
  observed.validationTree = treeAfter;
  observed.validationFilesImmutable = immutableBefore.sha256 === immutableAfter.sha256 && JSON.stringify(immutableBefore) === JSON.stringify(immutableAfter);
  observed.sourceDatabaseImmutable = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter);
  observed.copiedPathReadsBlockedBeforeRecordResolution =
    JSON.stringify(poisonBefore) === JSON.stringify(poisonAfter) &&
    externalReadResults
      .filter((entry) => entry.path.includes('resource_read_only_validation_poison') || entry.path.includes('change_file_read_only_validation_poison'))
      .every((entry) => entry.response.statusCode === 503 && isRecord(entry.response.body) && typeof entry.response.body.limitation === 'string');

  assertProbe(forbiddenProviderCalls.length === 0, `验证启动或 API 读取触发了 Provider 外部调用：${forbiddenProviderCalls.join(', ')}`);
  assertProbe(browserInvocationCount === 0, '验证启动或 API 读取触发了 Browser automation。');
  assertProbe(JSON.stringify(immutableBefore) === JSON.stringify(immutableAfter), 'Core 启动、查询、拒绝写入或关闭改变了副本数据库/manifest 的身份、摘要或时间戳。');
  assertProbe(JSON.stringify(treeBefore) === JSON.stringify(treeAfter), `Core 启动或关闭在 validation root 创建了额外文件或目录；before=${JSON.stringify(treeBefore)} after=${JSON.stringify(treeAfter)}。`);
  assertProbe(JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), '验证流程改变了正式来源数据库。');
  assertProbe(observed.copiedPathReadsBlockedBeforeRecordResolution === true, '四个 copied-path GET 必须在 record/path 解析前返回带 limitation 的 503，且不能触碰正式 workspace poison 文件。');
  for (const companion of [`${validationDatabasePath}-wal`, `${validationDatabasePath}-shm`, `${validationDatabasePath}-journal`]) {
    assertProbe(!(await pathExists(companion)), `验证流程产生了 SQLite 伴随文件：${companion}`);
  }
} finally {
  if (runningServer) {
    await runningServer.prepareForShutdown().catch(() => undefined);
    await runningServer.close().catch(() => undefined);
  }
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

function createPoisonCodexManager(forbiddenCalls: string[]): CodexAppServerManager {
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
        forbiddenCalls.push(String(property));
        throw Object.assign(new Error(`只读验证触发了禁止的 Provider 调用：${String(property)}`), {
          code: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
          statusCode: 503,
        });
      };
    },
  });
}

async function requestJson(baseUrl: string, path: string, options: { authenticated?: boolean; method?: string; body?: unknown } = {}): Promise<{ statusCode: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      origin: 'app://zeus',
      ...(options.authenticated === false ? {} : { authorization: `Bearer ${apiToken}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return { statusCode: response.status, body };
}

function assertBlocked(response: { statusCode: number; body: unknown }, label: string): void {
  assertProbe(response.statusCode === 503 && isRecord(response.body) && response.body.error === 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED' && response.body.recoveryRequired === false, `${label} 未以明确只读验证错误失败关闭。`);
}

function runCopyTool(arguments_: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('pnpm', ['exec', 'tsx', 'scripts/create-zeus-test-database-copy.ts', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseJsonOutput(value: string | Buffer | null): unknown {
  const text = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`复制工具没有返回有效 JSON：${text.slice(0, 500)}`, { cause: error });
  }
}

async function immutableSnapshot(databasePath: string, validationManifestPath: string) {
  return {
    database: await fileSnapshot(databasePath),
    manifest: await fileSnapshot(validationManifestPath),
    sha256: createHash('sha256')
      .update(`${await digestFile(databasePath)}:${await digestFile(validationManifestPath)}`)
      .digest('hex'),
  };
}

async function fileSnapshot(path: string) {
  const stats = await lstat(path, { bigint: true });
  return {
    path,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    bytes: stats.size.toString(),
    mode: Number(stats.mode & 0o777n)
      .toString(8)
      .padStart(4, '0'),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    sha256: await digestFile(path),
  };
}

async function fileIdentity(path: string) {
  const stats = await lstat(path, { bigint: true });
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    bytes: stats.size.toString(),
    mode: stats.mode.toString(),
    uid: stats.uid.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
}

async function digestFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function listTree(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relative = path.slice(root.length + 1);
      const stats = await lstat(path);
      output.push(`${stats.isDirectory() ? 'd' : stats.isFile() ? 'f' : 'x'}:${relative}`);
      if (stats.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return output;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`只读验证 Fence 行为探针失败：${message}`);
}
