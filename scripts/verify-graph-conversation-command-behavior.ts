import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/index.js';
import { ArtifactStore, CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import {
  GraphConversationCommandApplication,
  graphConversationCommandTypes,
  graphConversationInputSha256,
  type GraphConversationCommandPayload,
  type GraphConversationCommandType,
  type GraphConversationMutationRequest,
} from '../packages/local-server/src/graphConversationCommandApplication.js';
import {
  currentGraphCommandScopeId,
  graphConversationCommandRoutePolicy,
  graphConversationReject,
  isExplicitGraphConversationRejection,
  registerGraphConversationCommandRoutes,
} from '../packages/local-server/src/graphConversationCommandRoutes.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-graph-conversation-command-probe-'));
const observed: Record<string, unknown> = {};
const clockMs = Date.parse('2026-08-21T21:00:00.000Z');

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const server = Fastify({ logger: false });
  try {
    db.execute('CREATE TABLE graph_conversation_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const deliveries = new CommandDeliveryRepository(db);
    const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), () => now().toISOString(), { minimumFreeBytes: 0 });
    const application = new GraphConversationCommandApplication({ db, deliveries, artifacts, redactSensitiveText, now });
    const invocations = new Map<string, number>();
    const scanCommits = new Map<string, number>();
    let releaseConcurrent = (): void => undefined;
    const concurrentBarrier = new Promise<void>((resolveBarrier) => {
      releaseConcurrent = resolveBarrier;
    });

    registerGraphConversationCommandRoutes({
      server,
      application,
      operations: {
        prepareProjectConversation: async (input) => prepared('project-conversation', input.projectId, input.operationIdentity),
        startProjectConversation: async ({ prepared: value, operationIdentity }) => {
          count('project-conversation');
          return { statusCode: 202, body: { operationIdentity, prepared: value, accepted: true } };
        },
        prepareTaskConversation: async (input) => prepared('task-conversation', input.taskId, input.operationIdentity),
        startTaskConversation: async ({ prepared: value, operationIdentity }) => {
          count('task-conversation');
          return { statusCode: 202, body: { operationIdentity, prepared: value, accepted: true } };
        },
        prepareProjectScan: async (input) => {
          if (input.projectId === 'missing') graphConversationReject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
          return prepared(input.commandType, input.projectId, input.operationIdentity);
        },
        runProjectScan: async ({ prepared: value }) => {
          const entry = requirePrepared(value);
          count(entry.kind);
          return { projectId: entry.resourceId, commandType: entry.kind, nodeCount: 7 };
        },
        commitProjectScanAccepted: ({ prepared: value }) => {
          const entry = requirePrepared(value);
          scanCommits.set(entry.kind, (scanCommits.get(entry.kind) ?? 0) + 1);
          db.execute('INSERT INTO graph_conversation_probe (id, value) VALUES (?, ?)', [entry.kind, 'accepted']);
        },
        commitProjectScanFailure: ({ prepared: value, outcome }) => {
          const entry = requirePrepared(value);
          db.execute('INSERT INTO graph_conversation_probe (id, value) VALUES (?, ?)', [`${entry.kind}:failure`, outcome]);
        },
        releaseProjectScan: () => undefined,
        prepareGraphAsk: async (input) => prepared('graph-ask', input.projectId, input.operationIdentity),
        askGraph: async ({ question, operationIdentity }) => {
          count(`graph-ask:${question}`);
          if (question === 'unknown') throw Object.assign(new Error(`/secret/graph token=probe ${'ambiguous '.repeat(512)}`), { code: 'ZEUS_GRAPH_PROBE_UNKNOWN' });
          return { question, answer: 'real-answer', operationIdentity };
        },
        prepareCurrentScan: async (input) => prepared('current-scan', currentGraphCommandScopeId, input.operationIdentity),
        runCurrentScan: async ({ operationIdentity }) => {
          count('current-scan');
          await concurrentBarrier;
          return { operationIdentity, payload: 'x'.repeat(1_250_000) };
        },
        releaseCurrentScan: () => undefined,
        isExplicitRejection: isExplicitGraphConversationRejection,
      },
      sendNativeError: (reply, error) => {
        const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'ZEUS_GRAPH_PROBE_ERROR';
        return reply.code(500).send({ error: code, message: error instanceof Error ? error.message : String(error) });
      },
    });

    const projectConversation = commandRequest('project-conversation', graphConversationCommandTypes.projectConversationCreate, 'project', 'project-a', { mode: 'create', content: 'hello' });
    const projectConversationResponse = await inject('/api/projects/project-a/conversations', projectConversation.body);
    const taskConversation = commandRequest('task-conversation', graphConversationCommandTypes.taskConversationCreate, 'task', 'task-a', { mode: 'create', content: 'task' });
    const taskConversationResponse = await inject('/api/tasks/task-a/conversations', taskConversation.body);
    const projectScan = commandRequest('project-scan', graphConversationCommandTypes.projectGraphScan, 'project', 'project-a', {});
    const projectScanResponse = await inject('/api/projects/project-a/scan', projectScan.body);
    const projectViews = commandRequest('project-views', graphConversationCommandTypes.projectGraphViewsGenerate, 'project', 'project-a', {});
    const projectViewsResponse = await inject('/api/projects/project-a/graph/views/generate', projectViews.body);
    const graphAsk = commandRequest('graph-ask', graphConversationCommandTypes.projectGraphAsk, 'project', 'project-a', { question: 'where?' });
    const graphAskResponse = await inject('/api/projects/project-a/ask', graphAsk.body);

    const concurrent = commandRequest('current-concurrent', graphConversationCommandTypes.currentGraphScan, 'project', currentGraphCommandScopeId, {});
    const concurrentFirst = inject('/api/graph/scan-current', concurrent.body);
    const concurrentDuplicate = inject('/api/graph/scan-current', concurrent.body);
    await Promise.resolve();
    releaseConcurrent();
    const [currentFirst, currentDuplicate] = await Promise.all([concurrentFirst, concurrentDuplicate]);
    const currentReplay = await inject('/api/graph/scan-current', concurrent.body);
    const acceptedAttempt = requiredAttempt(deliveries, concurrent.commandId);
    const acceptedEvidence = JSON.parse(acceptedAttempt.receipt.evidenceJson) as { resultArtifact?: { contentByteLength?: number; generationId?: string } };

    const unknown = commandRequest('graph-unknown', graphConversationCommandTypes.projectGraphAsk, 'project', 'project-unknown', { question: 'unknown' });
    const unknownFirst = await inject('/api/projects/project-unknown/ask', unknown.body);
    const unknownReplay = await inject('/api/projects/project-unknown/ask', unknown.body);
    const unknownAttempt = requiredAttempt(deliveries, unknown.commandId);
    const unknownEvidence = JSON.parse(unknownAttempt.receipt.evidenceJson) as { error?: { message?: string } };

    const failedBeforeWrite = commandRequest('missing-project', graphConversationCommandTypes.projectGraphScan, 'project', 'missing', {});
    const failedBeforeWriteResponse = await inject('/api/projects/missing/scan', failedBeforeWrite.body);
    const failedBeforeWriteAttempt = requiredAttempt(deliveries, failedBeforeWrite.commandId);

    observed.routes = {
      policyCount: graphConversationCommandRoutePolicy.externalOperations.length,
      statuses: [projectConversationResponse, taskConversationResponse, projectScanResponse, projectViewsResponse, graphAskResponse].map((entry) => entry.statusCode),
      invocations: Object.fromEntries(invocations),
      scanCommits: Object.fromEntries(scanCommits),
    };
    observed.concurrentAcceptedReplay = {
      statuses: [currentFirst.statusCode, currentDuplicate.statusCode, currentReplay.statusCode],
      invocations: invocations.get('current-scan'),
      identical: currentFirst.body.payload === currentDuplicate.body.payload && currentFirst.body.payload === currentReplay.body.payload,
      artifactBytes: acceptedEvidence.resultArtifact?.contentByteLength,
      artifactGeneration: acceptedEvidence.resultArtifact?.generationId,
      receiptBytes: Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8'),
    };
    observed.unknown = {
      firstCode: unknownFirst.body.error,
      replayCode: unknownReplay.body.error,
      invocations: invocations.get('graph-ask:unknown'),
      outcome: unknownAttempt.receipt.outcome,
      writeMarker: unknownAttempt.attempt.providerWriteStartedAt !== null,
      redacted: !(unknownEvidence.error?.message ?? '').includes('/secret/graph') && !(unknownEvidence.error?.message ?? '').includes('token=probe'),
      errorBytes: Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8'),
    };
    observed.failedBeforeWrite = {
      statusCode: failedBeforeWriteResponse.statusCode,
      code: failedBeforeWriteResponse.body.error,
      outcome: failedBeforeWriteAttempt.receipt.outcome,
      writeMarker: failedBeforeWriteAttempt.attempt.providerWriteStartedAt,
    };
    observed.quickCheck = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? null;
    observed.realProviderWorkerProcessFsStarted = false;

    assertProbe(projectConversationResponse.statusCode === 202 && taskConversationResponse.statusCode === 202, '两个会话首发必须保留 202 接受语义。');
    assertProbe(projectScanResponse.statusCode === 200 && projectViewsResponse.statusCode === 200 && graphAskResponse.statusCode === 200, '三个项目图谱入口必须返回真实结果。');
    assertProbe(graphConversationCommandRoutePolicy.externalOperations.length === 6 && graphConversationCommandRoutePolicy.automaticRetryAfterUnknown === false, '路由政策必须精确覆盖六条且 unknown 禁止自动重试。');
    assertProbe(invocations.get('current-scan') === 1 && currentFirst.body.payload === currentDuplicate.body.payload && currentFirst.body.payload === currentReplay.body.payload, '并发重复与 accepted replay 都不得二次执行外部端口。');
    assertProbe((acceptedEvidence.resultArtifact?.contentByteLength ?? 0) > 1_000_000 && acceptedEvidence.resultArtifact?.generationId === 'graph-conversation-command-result-v1', '大型接受结果必须使用不可变 ArtifactRef。');
    assertProbe(Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8') < 16_384, 'accepted receipt 只允许有界 ArtifactRef。');
    assertProbe(unknownFirst.body.error === 'ZEUS_GRAPH_CONVERSATION_COMMAND_OUTCOME_UNKNOWN' && unknownFirst.body.recoveryRequired === true, 'write marker 后异常必须成为 outcome unknown。');
    assertProbe(unknownReplay.body.error === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' && invocations.get('graph-ask:unknown') === 1, 'unknown 必须阻断盲重试。');
    assertProbe(unknownAttempt.receipt.outcome === 'outcome_unknown_after_write' && unknownAttempt.attempt.providerWriteStartedAt !== null, 'unknown receipt 必须保留 write marker。');
    assertProbe(observed.unknown && (observed.unknown as { redacted?: unknown }).redacted === true && Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8') <= 2_048, '错误 evidence 必须有界脱敏。');
    assertProbe(
      failedBeforeWriteResponse.statusCode === 404 && failedBeforeWriteAttempt.receipt.outcome === 'failed_before_write' && failedBeforeWriteAttempt.attempt.providerWriteStartedAt === null,
      '只读预检拒绝必须停在 write marker 之前。',
    );
    assertProbe((scanCommits.get(graphConversationCommandTypes.projectGraphScan) ?? 0) === 1 && (scanCommits.get(graphConversationCommandTypes.projectGraphViewsGenerate) ?? 0) === 1, '扫描 Core 状态与 accepted receipt 必须各提交一次。');
    assertProbe(observed.quickCheck === 'ok', '临时 SQLite quick_check 必须通过。');
    assertProbe(observed.realProviderWorkerProcessFsStarted === false, '行为 verifier 不得启动真实 Provider、Worker、进程或文件扫描。');

    console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

    function prepared(kind: string, resourceId: string, operationIdentity: string) {
      return { kind, resourceId, operationIdentity };
    }

    function requirePrepared(value: unknown): { kind: string; resourceId: string; operationIdentity: string } {
      if (!value || typeof value !== 'object') throw new Error('Probe preparation missing.');
      return value as { kind: string; resourceId: string; operationIdentity: string };
    }

    function count(key: string): void {
      invocations.set(key, (invocations.get(key) ?? 0) + 1);
    }

    async function inject(path: string, body: unknown): Promise<{ statusCode: number; body: Record<string, unknown> }> {
      const response = await server.inject({ method: 'POST', url: path, payload: body });
      return { statusCode: response.statusCode, body: response.body ? (JSON.parse(response.body) as Record<string, unknown>) : {} };
    }
  } finally {
    await server.close();
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

function now(): Date {
  return new Date(clockMs);
}

function redactSensitiveText(value: string): { text: string; redacted: boolean } {
  const text = value.replaceAll('/secret/graph', '[REDACTED_PATH]').replaceAll('token=probe', '[REDACTED_TOKEN]');
  return { text, redacted: text !== value };
}

function commandRequest<TInput extends object>(label: string, commandType: GraphConversationCommandType, scopeKind: 'project' | 'task', scopeId: string, input: TInput): { commandId: string; body: GraphConversationMutationRequest<TInput> } {
  const operationIdentity = `graph-conversation-probe-${label}`;
  const commandId = `command_graph_conversation_probe_${label}`;
  const payload: GraphConversationCommandPayload = { operationIdentity, inputSha256: graphConversationInputSha256(input) };
  const command: CommandEnvelope<GraphConversationCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType,
    actor: { kind: 'local_api', id: 'graph-conversation-command-probe' },
    scope: { kind: scopeKind, id: scopeId },
    expectedRevision: null,
    idempotencyKey: `${commandType}:${operationIdentity}`,
    issuedAt: now().toISOString(),
    payload,
  };
  return { commandId, body: { command, input } };
}

function requiredAttempt(deliveries: CommandDeliveryRepository, commandId: string) {
  const snapshot = deliveries.get(commandId);
  const attempt = snapshot?.attempts.at(-1);
  const receipt = attempt?.receipt;
  assertProbe(snapshot && attempt && receipt, `Command ${commandId} 必须存在耐久 attempt/receipt。`);
  return { snapshot, attempt, receipt };
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
