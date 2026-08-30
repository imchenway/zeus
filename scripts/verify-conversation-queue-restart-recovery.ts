import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexAccountSnapshot, CodexAppServerEvent, CodexAppServerManager, CodexCapabilitiesSnapshot, CodexThreadSnapshot, CodexTurnSnapshot, CodexTurnStartInput } from '@zeus/ai-runtime';
import { ConversationRepository, ConversationSubmissionRepository, ConversationTurnRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import { conversationDispatchInputSha256 } from '../packages/local-server/src/conversationDispatchCommandApplication.js';
import { graphConversationInputSha256 } from '../packages/local-server/src/graphConversationCommandApplication.js';
import { createZeusDataLayout, startZeusLocalServer, type RunningZeusLocalServer } from '../packages/local-server/src/index.js';
import { workManagementInputSha256 } from '../packages/local-server/src/workManagementCommandApplication.js';

type JsonObject = Record<string, unknown>;

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-conversation-queue-restart-'));
const dataRoot = join(probeRoot, 'data-root');
const projectRoot = join(probeRoot, 'project');
const databasePath = join(dataRoot, 'data', 'zeus.db');
const apiToken = 'conversation-queue-restart-probe-token';
const projectId = `project_${randomUUID().replaceAll('-', '')}`;
const providerThreadId = `thread_${randomUUID().replaceAll('-', '')}`;
const firstProviderTurnId = `turn_${randomUUID().replaceAll('-', '')}`;
const secondProviderTurnId = `turn_${randomUUID().replaceAll('-', '')}`;
let runningServer: RunningZeusLocalServer | null = null;

try {
  await mkdir(projectRoot, { recursive: true });
  const firstProvider = createRestartProbeManager({
    providerThreadId,
    turnIds: [firstProviderTurnId],
    initialTurns: [],
  });
  runningServer = await startProbeServer(firstProvider.manager, 'before-restart');

  const projectInput = {
    name: 'ZEUS-0387 队列重启恢复探针',
    localPath: projectRoot,
    description: '只在临时 SQLite 和可控 Provider 桩中验证重启后的统一队列自动唤醒。',
  };
  const projectCreate = await requestJson(runningServer, '/api/projects', {
    method: 'POST',
    body: commandRequest({
      commandType: 'work_management.project.create',
      scopeKind: 'project',
      scopeId: projectId,
      operationIdentity: projectId,
      input: projectInput,
      inputSha256: workManagementInputSha256(projectInput),
    }),
  });
  assertBehavior(projectCreate.status === 201, `临时项目创建失败：${projectCreate.status} ${JSON.stringify(projectCreate.body)}`);

  const firstClientMessageId = `message_${randomUUID().replaceAll('-', '')}`;
  const firstConversationInput = {
    mode: 'create',
    agentKind: 'codex',
    content: '第一轮只用于形成重启前的 Provider 活动态。',
    model: 'gpt-5.6-sol',
    effort: 'low',
    permissionMode: 'read-only',
    collaborationMode: 'default',
    clientUserMessageId: firstClientMessageId,
  };
  const firstConversation = await requestJson(runningServer, `/api/projects/${projectId}/conversations`, {
    method: 'POST',
    body: commandRequest({
      commandType: 'conversation.project.create',
      scopeKind: 'project',
      scopeId: projectId,
      operationIdentity: `conversation_${randomUUID().replaceAll('-', '')}`,
      input: firstConversationInput,
      inputSha256: graphConversationInputSha256(firstConversationInput),
    }),
  });
  assertBehavior(firstConversation.status === 202, `首轮会话接纳失败：${firstConversation.status} ${JSON.stringify(firstConversation.body)}`);
  const conversationId = requiredResultString(firstConversation.body, ['conversation', 'id']);
  try {
    await waitFor(() => firstProvider.startTurnInputs.length === 1, '首轮 turn/start 未发生。');
  } catch (error) {
    const [snapshot, queueState] = await Promise.all([
      requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/snapshot-v2`),
      requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/queue-state`),
    ]);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nsnapshot=${JSON.stringify(snapshot.body, null, 2)}\nqueue=${JSON.stringify(queueState.body, null, 2)}`);
  }

  await runningServer.prepareForShutdown();
  await runningServer.close();
  runningServer = null;

  // 精确复现升级/Host 重启窗口：Provider 已结束上一轮，但 Core 的 durable projection 仍是 running。
  const database = await createZeusDatabase(databasePath);
  try {
    const conversations = new ConversationRepository(database);
    const submissions = new ConversationSubmissionRepository(database);
    const turns = new ConversationTurnRepository(database);
    const firstSubmission = submissions.listByConversation(conversationId).find((submission) => submission.clientMessageId === firstClientMessageId);
    const firstTurn = turns.listByConversation(conversationId).find((turn) => turn.providerTurnId === firstProviderTurnId);
    assertBehavior(firstSubmission, '重启前缺少首轮 submission。');
    assertBehavior(firstTurn, '重启前缺少首轮 turn。');
    submissions.updateStatus(firstSubmission.id, 'active', {
      providerTurnId: firstProviderTurnId,
      acceptedAt: firstSubmission.acceptedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    turns.upsert({ ...firstTurn, status: 'running', completedAt: null, updatedAt: new Date().toISOString() });
    conversations.bindProvider(conversationId, {
      providerId: 'codex',
      providerThreadId,
      providerModel: 'gpt-5.6-sol',
      providerState: 'active',
    });
    await database.save();
  } finally {
    await database.close();
  }

  const completedFirstTurn: CodexTurnSnapshot = {
    id: firstProviderTurnId,
    threadId: providerThreadId,
    status: 'completed',
    completedAt: new Date().toISOString(),
    items: [],
  };
  const restartedProvider = createRestartProbeManager({
    providerThreadId,
    turnIds: [secondProviderTurnId],
    initialTurns: [completedFirstTurn],
  });
  runningServer = await startProbeServer(restartedProvider.manager, 'after-restart');

  const secondClientMessageId = `message_${randomUUID().replaceAll('-', '')}`;
  const secondMessageInput = {
    content: '第二轮必须在 Provider 权威确认 idle 后自动离开排队态。',
    idempotencyKey: `queue_${randomUUID().replaceAll('-', '')}`,
    clientUserMessageId: secondClientMessageId,
    delivery: 'queue',
  };
  const secondMessage = await requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: commandRequest({
      commandType: 'conversation.message.submit',
      scopeKind: 'product_conversation',
      scopeId: conversationId,
      operationIdentity: `message_${randomUUID().replaceAll('-', '')}`,
      input: secondMessageInput,
      inputSha256: conversationDispatchInputSha256(secondMessageInput),
    }),
  });
  assertBehavior(secondMessage.status === 202, `重启后消息接纳失败：${secondMessage.status} ${JSON.stringify(secondMessage.body)}`);

  await waitFor(() => restartedProvider.readThreadCalls > 0, '重启后的旧 active 投影没有进入 Provider thread authority。', 8_000);
  await waitFor(() => restartedProvider.startTurnInputs.length === 1, 'Provider 已确认 idle，但统一队列没有被 queue.changed 再次唤醒。', 8_000);
  const secondStart = restartedProvider.startTurnInputs[0];
  assertBehavior(secondStart?.clientUserMessageId === secondClientMessageId, '重启后 turn/start 没有消费新消息的稳定 clientUserMessageId。');

  const snapshot = await requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/snapshot-v2`);
  const snapshotBody = snapshot.body;
  const queue = Array.isArray(snapshotBody.queue) ? snapshotBody.queue : [];
  const secondQueueEntry = queue.find((entry) => isRecord(entry) && entry.clientMessageId === secondClientMessageId);
  assertBehavior(!secondQueueEntry || secondQueueEntry.status !== 'queued', '新消息仍停留在 queued，未真正进入 Provider。');

  console.log(
    JSON.stringify(
      {
        status: 'passed',
        restartCount: 1,
        staleLocalTurnReconciled: true,
        providerAuthorityReads: restartedProvider.readThreadCalls,
        queueChangedRedispatch: true,
        secondProviderTurnId,
        secondClientMessageIdPreserved: true,
        manualRetryRequired: false,
        temporaryDatabaseCleanup: 'finally',
      },
      null,
      2,
    ),
  );
} finally {
  if (runningServer) {
    await runningServer.prepareForShutdown().catch(() => undefined);
    await runningServer.close().catch(() => undefined);
  }
  await rm(probeRoot, { recursive: true, force: true });
}

async function startProbeServer(manager: CodexAppServerManager, instanceId: string): Promise<RunningZeusLocalServer> {
  return startZeusLocalServer({
    dbPath: databasePath,
    dataLayout: createZeusDataLayout(dataRoot),
    apiToken,
    keychainService: 'dev.hypha.zeus.test.conversation-queue-restart',
    projectRoot: probeRoot,
    currentAppVersion: '0.3.82',
    codexAppServerManager: manager,
    codexNativeEnabled: true,
    codexRuntimeCommandPath: '/usr/bin/true',
    codexHome: join(dataRoot, 'providers', 'codex'),
    telegramToken: '',
    executionHost: {
      instanceId: `conversation-queue-restart-${instanceId}`,
      protocolVersion: 1,
      startedAt: new Date().toISOString(),
      mode: 'embedded',
    },
  });
}

function createRestartProbeManager(input: { providerThreadId: string; turnIds: string[]; initialTurns: CodexTurnSnapshot[] }): {
  manager: CodexAppServerManager;
  startTurnInputs: CodexTurnStartInput[];
  readonly readThreadCalls: number;
} {
  const generationId = `generation_${randomUUID().replaceAll('-', '')}`;
  const capabilities: CodexCapabilitiesSnapshot = {
    generationId,
    initializedAt: new Date().toISOString(),
    providerVersion: 'restart-probe',
    protocolVersion: 'codex-app-server-v2',
    models: [
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol Probe',
        supportedReasoningEfforts: ['low'],
        defaultReasoningEffort: 'low',
        serviceTiers: [],
        defaultServiceTier: null,
        raw: {},
      },
    ],
    supportedModels: ['gpt-5.6-sol'],
    modelBudgets: {
      'gpt-5.6-sol': {
        contextWindowTokens: 258_000,
        reservedOutputTokens: 32_000,
        contextWindowSource: `conversation_queue_restart_probe:${generationId}`,
        reservedOutputSource: `conversation_queue_restart_probe:${generationId}`,
        checkedAt: new Date().toISOString(),
      },
    },
    preflightTokenCount: { state: 'unavailable', exact: false, reason: 'deterministic restart probe' },
    goals: { supported: false, enabled: false, stage: null },
  };
  const account: CodexAccountSnapshot = {
    generationId,
    requiresOpenaiAuth: true,
    signedIn: true,
    accountType: 'chatgpt',
    planType: 'probe',
    accountScopeId: 'conversation-queue-restart-probe',
  };
  const listeners = new Set<(event: CodexAppServerEvent) => void | Promise<void>>();
  const startTurnInputs: CodexTurnStartInput[] = [];
  const turns = [...input.initialTurns];
  let readThreadCalls = 0;
  const threadSnapshot = (): CodexThreadSnapshot => ({
    id: input.providerThreadId,
    status: { type: turns.some((turn) => String(turn.status).toLowerCase() === 'active') ? 'active' : 'idle', ...(turns.some((turn) => String(turn.status).toLowerCase() === 'active') ? { activeFlags: [] } : {}) },
    turns: [...turns],
    providerSettings: { generationId, sequence: 1, model: 'gpt-5.6-sol', effort: 'low', serviceTier: null },
  });
  const implementation = {
    ensureReady: async () => capabilities,
    readAccount: async () => account,
    readAccountRateLimits: async () => ({ generationId, rateLimits: { limitId: null, limitName: null, primary: null, secondary: null, credits: null, planType: null }, rateLimitsByLimitId: null }),
    readAccountUsage: async () => ({ generationId, summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null }),
    startThread: async () => threadSnapshot(),
    resumeThread: async () => threadSnapshot(),
    readThread: async () => {
      readThreadCalls += 1;
      return threadSnapshot();
    },
    listThreadTurns: async () => ({ data: [...turns].reverse(), nextCursor: null }),
    listThreads: async () => ({ data: [threadSnapshot()], nextCursor: null }),
    listSkills: async ({ cwds }: { cwds?: string[] }) => (cwds ?? []).map((cwd) => ({ cwd, skills: [], errors: [] })),
    startTurn: async (turnInput: CodexTurnStartInput) => {
      turnInput.requestWritten?.();
      startTurnInputs.push(turnInput);
      const turnId = input.turnIds[startTurnInputs.length - 1];
      if (!turnId) throw new Error('重启探针没有为 turn/start 预留 Provider turn id。');
      const turn: CodexTurnSnapshot = { id: turnId, threadId: input.providerThreadId, status: 'active', items: [] };
      turns.push(turn);
      return turn;
    },
    detectExternalAgentConfig: async () => ({ status: 'not_found', sourceRoot: null, candidates: [], warnings: [] }),
    readExternalAgentImportHistories: async () => [],
    subscribeExternalAgentImport: () => () => undefined,
    subscribeRpcRetries: () => () => undefined,
    subscribe: (listener: (event: CodexAppServerEvent) => void | Promise<void>) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => ({ type: 'ready' as const, generationId, capabilities }),
    hasGeneration: (candidate: string) => candidate === generationId,
    generationForThread: (threadId: string) => (threadId === input.providerThreadId ? generationId : null),
    listRuntimeGenerations: () => [{ generationId, commandPath: '/usr/bin/true', state: 'ready' as const, active: true, activeThreadCount: 1, pendingRequestCount: 0 }],
    prepareForShutdown: async () => undefined,
    close: async () => undefined,
  };
  const manager = new Proxy(implementation as unknown as CodexAppServerManager, {
    get(target, property, receiver) {
      if (Reflect.has(target as object, property)) return Reflect.get(target as object, property, receiver) as unknown;
      return () => {
        throw new Error(`重启探针尚未实现 Provider 方法：${String(property)}`);
      };
    },
  });
  return {
    manager,
    startTurnInputs,
    get readThreadCalls() {
      return readThreadCalls;
    },
  };
}

function commandRequest(input: { commandType: string; scopeKind: 'project' | 'product_conversation'; scopeId: string; operationIdentity: string; input: JsonObject; inputSha256: string }): JsonObject {
  return {
    command: {
      schemaGeneration: 'zeus-command-envelope-v1',
      commandId: randomUUID(),
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'conversation-queue-restart-probe' },
      scope: { kind: input.scopeKind, id: input.scopeId },
      expectedRevision: null,
      idempotencyKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      payload: { operationIdentity: input.operationIdentity, inputSha256: input.inputSha256 },
    },
    input: input.input,
  };
}

async function requestJson(server: RunningZeusLocalServer, path: string, input: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: { origin: 'app://zeus', authorization: `Bearer ${apiToken}`, ...(input.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as JsonObject) : {} };
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function requiredResultString(value: unknown, path: string[]): string {
  let current: unknown = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  if (typeof current !== 'string' || !current) throw new Error(`响应缺少 ${path.join('.')}：${JSON.stringify(value)}`);
  return current;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`会话队列重启恢复探针失败：${message}`);
}
