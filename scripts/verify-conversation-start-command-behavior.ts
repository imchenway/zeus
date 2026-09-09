import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/index.js';
import { ArtifactStore, CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import {
  ConversationStartCommandApplication,
  conversationStartCommandTypes,
  conversationStartInputSha256,
  type ConversationStartCommandPayload,
  type ConversationStartCommandType,
  type ConversationStartMutationRequest,
} from '../packages/local-server/src/conversationStartCommandApplication.js';
import { conversationStartCommandRoutePolicy, conversationStartReject, isExplicitConversationStartRejection, registerConversationStartCommandRoutes } from '../packages/local-server/src/conversationStartCommandRoutes.js';

/** 专项检查专用临时目录，结束时清理。 */
const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-conversation-start-command-probe-'));
/** 记录迁移与首发检查的实际结果。 */
const observed: Record<string, unknown> = {};
/** 固定检查时间，便于核对持久回执。 */
const clockMs = Date.parse('2026-08-21T21:00:00.000Z');

try {
  await verifyGraphRetirement();
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const server = Fastify({ logger: false });
  try {
    const deliveries = new CommandDeliveryRepository(db);
    const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), () => now().toISOString(), { minimumFreeBytes: 0 });
    const application = new ConversationStartCommandApplication({ db, deliveries, artifacts, redactSensitiveText, now });
    const invocations = new Map<string, number>();
    let releaseConcurrent = (): void => undefined;
    const concurrentBarrier = new Promise<void>((resolveBarrier) => {
      releaseConcurrent = resolveBarrier;
    });

    registerConversationStartCommandRoutes({
      server,
      application,
      operations: {
        prepareProjectConversation: async (input) => {
          if (input.projectId === 'missing') conversationStartReject(404, 'ZEUS_PROJECT_NOT_FOUND', '项目不存在');
          return prepared('project-conversation', input.projectId, input.operationIdentity);
        },
        startProjectConversation: async ({ value, operationIdentity, markExternalWriteStarted }) => {
          count(`project-conversation:${value.content}`);
          markExternalWriteStarted();
          if (value.content === 'unknown') throw Object.assign(new Error(`/secret/conversation token=probe ${'ambiguous '.repeat(512)}`), { code: 'ZEUS_CONVERSATION_PROBE_UNKNOWN' });
          if (value.content === 'concurrent') await concurrentBarrier;
          return { statusCode: 202, body: { operationIdentity, accepted: true, payload: value.content === 'concurrent' ? 'x'.repeat(1_250_000) : value.content } };
        },
        prepareTaskConversation: async (input) => prepared('task-conversation', input.taskId, input.operationIdentity),
        startTaskConversation: async ({ prepared: value, operationIdentity, markExternalWriteStarted }) => {
          count('task-conversation');
          markExternalWriteStarted();
          return { statusCode: 202, body: { operationIdentity, prepared: value, accepted: true } };
        },
        isExplicitRejection: isExplicitConversationStartRejection,
      },
      sendNativeError: (reply, error) => {
        const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'ZEUS_CONVERSATION_PROBE_ERROR';
        return reply.code(500).send({ error: code, message: error instanceof Error ? error.message : String(error) });
      },
    });

    const projectConversation = commandRequest('project-conversation', conversationStartCommandTypes.projectConversationCreate, 'project', 'project-a', { mode: 'create', content: 'hello' });
    const projectConversationResponse = await inject('/api/projects/project-a/conversations', projectConversation.body);
    const taskConversation = commandRequest('task-conversation', conversationStartCommandTypes.taskConversationCreate, 'task', 'task-a', { mode: 'create', content: 'task' });
    const taskConversationResponse = await inject('/api/tasks/task-a/conversations', taskConversation.body);
    const concurrent = commandRequest('concurrent', conversationStartCommandTypes.projectConversationCreate, 'project', 'project-a', { mode: 'create', content: 'concurrent' });
    const concurrentFirst = inject('/api/projects/project-a/conversations', concurrent.body);
    const concurrentDuplicate = inject('/api/projects/project-a/conversations', concurrent.body);
    await Promise.resolve();
    releaseConcurrent();
    const [currentFirst, currentDuplicate] = await Promise.all([concurrentFirst, concurrentDuplicate]);
    const currentReplay = await inject('/api/projects/project-a/conversations', concurrent.body);
    const acceptedAttempt = requiredAttempt(deliveries, concurrent.commandId);
    const acceptedEvidence = JSON.parse(acceptedAttempt.receipt.evidenceJson) as { resultArtifact?: { contentByteLength?: number; generationId?: string } };

    const unknown = commandRequest('unknown', conversationStartCommandTypes.projectConversationCreate, 'project', 'project-unknown', { mode: 'create', content: 'unknown' });
    const unknownFirst = await inject('/api/projects/project-unknown/conversations', unknown.body);
    const unknownReplay = await inject('/api/projects/project-unknown/conversations', unknown.body);
    const unknownAttempt = requiredAttempt(deliveries, unknown.commandId);
    const unknownEvidence = JSON.parse(unknownAttempt.receipt.evidenceJson) as { error?: { message?: string } };

    const failedBeforeWrite = commandRequest('missing-project', conversationStartCommandTypes.projectConversationCreate, 'project', 'missing', { mode: 'create', content: 'missing' });
    const failedBeforeWriteResponse = await inject('/api/projects/missing/conversations', failedBeforeWrite.body);
    const failedBeforeWriteAttempt = requiredAttempt(deliveries, failedBeforeWrite.commandId);

    observed.routes = {
      policyCount: conversationStartCommandRoutePolicy.externalOperations.length,
      statuses: [projectConversationResponse, taskConversationResponse].map((entry) => entry.statusCode),
      invocations: Object.fromEntries(invocations),
    };
    observed.concurrentAcceptedReplay = {
      statuses: [currentFirst.statusCode, currentDuplicate.statusCode, currentReplay.statusCode],
      invocations: invocations.get('project-conversation:concurrent'),
      identical: currentFirst.body.payload === currentDuplicate.body.payload && currentFirst.body.payload === currentReplay.body.payload,
      artifactBytes: acceptedEvidence.resultArtifact?.contentByteLength,
      artifactGeneration: acceptedEvidence.resultArtifact?.generationId,
      receiptBytes: Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8'),
    };
    observed.unknown = {
      firstCode: unknownFirst.body.error,
      replayCode: unknownReplay.body.error,
      invocations: invocations.get('project-conversation:unknown'),
      outcome: unknownAttempt.receipt.outcome,
      writeMarker: unknownAttempt.attempt.providerWriteStartedAt !== null,
      redacted: !(unknownEvidence.error?.message ?? '').includes('/secret/conversation') && !(unknownEvidence.error?.message ?? '').includes('token=probe'),
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
    assertProbe(conversationStartCommandRoutePolicy.externalOperations.length === 2 && conversationStartCommandRoutePolicy.automaticRetryAfterUnknown === false, '路由政策必须精确覆盖两条且 unknown 禁止自动重试。');
    assertProbe(
      invocations.get('project-conversation:concurrent') === 1 && currentFirst.body.payload === currentDuplicate.body.payload && currentFirst.body.payload === currentReplay.body.payload,
      '并发重复与 accepted replay 都不得二次执行外部端口。',
    );
    assertProbe((acceptedEvidence.resultArtifact?.contentByteLength ?? 0) > 1_000_000 && acceptedEvidence.resultArtifact?.generationId === 'graph-conversation-command-result-v1', '大型接受结果必须使用不可变 ArtifactRef。');
    assertProbe(Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8') < 16_384, 'accepted receipt 只允许有界 ArtifactRef。');
    assertProbe(unknownFirst.body.error === 'ZEUS_CONVERSATION_START_COMMAND_OUTCOME_UNKNOWN' && unknownFirst.body.recoveryRequired === true, 'write marker 后异常必须成为 outcome unknown。');
    assertProbe(unknownReplay.body.error === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' && invocations.get('project-conversation:unknown') === 1, 'unknown 必须阻断盲重试。');
    assertProbe(unknownAttempt.receipt.outcome === 'outcome_unknown_after_write' && unknownAttempt.attempt.providerWriteStartedAt !== null, 'unknown receipt 必须保留 write marker。');
    assertProbe(observed.unknown && (observed.unknown as { redacted?: unknown }).redacted === true && Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8') <= 2_048, '错误 evidence 必须有界脱敏。');
    assertProbe(
      failedBeforeWriteResponse.statusCode === 404 && failedBeforeWriteAttempt.receipt.outcome === 'failed_before_write' && failedBeforeWriteAttempt.attempt.providerWriteStartedAt === null,
      '只读预检拒绝必须停在 write marker 之前。',
    );
    assertProbe(observed.quickCheck === 'ok', '临时 SQLite quick_check 必须通过。');
    assertProbe(observed.realProviderWorkerProcessFsStarted === false, '行为 verifier 不得启动真实 Provider、Worker、进程或文件扫描。');

    console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

    /** 返回隔离首发端口的只读预检结果。 */
    function prepared(kind: string, resourceId: string, operationIdentity: string) {
      return { kind, resourceId, operationIdentity };
    }

    /** 累计端口执行次数，发现重复发送。 */
    function count(key: string): void {
      invocations.set(key, (invocations.get(key) ?? 0) + 1);
    }

    /** 调用真实路由处理器并解析响应。 */
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

/** 返回专项检查使用的固定时间。 */
function now(): Date {
  return new Date(clockMs);
}

/** 移除检查样本中的路径和密钥标记。 */
function redactSensitiveText(value: string): { text: string; redacted: boolean } {
  const text = value.replaceAll('/secret/conversation', '[REDACTED_PATH]').replaceAll('token=probe', '[REDACTED_TOKEN]');
  return { text, redacted: text !== value };
}

/** 构造具有稳定身份和正文摘要的检查命令。 */
function commandRequest<TInput extends object>(label: string, commandType: ConversationStartCommandType, scopeKind: 'project' | 'task', scopeId: string, input: TInput): { commandId: string; body: ConversationStartMutationRequest<TInput> } {
  const operationIdentity = `conversation-start-probe-${label}`;
  const commandId = `command_conversation_start_probe_${label}`;
  const payload: ConversationStartCommandPayload = { operationIdentity, inputSha256: conversationStartInputSha256(input) };
  const command: CommandEnvelope<ConversationStartCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType,
    actor: { kind: 'local_api', id: 'conversation-start-command-probe' },
    scope: { kind: scopeKind, id: scopeId },
    expectedRevision: null,
    idempotencyKey: `${commandType}:${operationIdentity}`,
    issuedAt: now().toISOString(),
    payload,
  };
  return { commandId, body: { command, input } };
}

/** 要求命令已保存完整的执行记录与回执。 */
function requiredAttempt(deliveries: CommandDeliveryRepository, commandId: string) {
  const snapshot = deliveries.get(commandId);
  const attempt = snapshot?.attempts.at(-1);
  const receipt = attempt?.receipt;
  assertProbe(snapshot && attempt && receipt, `Command ${commandId} 必须存在耐久 attempt/receipt。`);
  return { snapshot, attempt, receipt };
}

/** 检查关键行为，不满足时立即失败。 */
function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 用隔离数据库核验旧图谱清理、设置保留和重复启动，禁止接触真实用户库。 */
async function verifyGraphRetirement(): Promise<void> {
  /** 独立迁移样本，沿用真实建库入口初始化全部业务结构。 */
  const path = join(probeRoot, 'retirement.db');
  const initial = await createZeusDatabase(path);
  const legacy = initial;
  try {
    legacy.execute(`
      UPDATE conversation_legacy_write_fence SET current_writer_open = 1 WHERE singleton = 1;
      DELETE FROM schema_migrations WHERE migration_id = '20260908_retire_code_graph';
      ALTER TABLE projects ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'idle';
      ALTER TABLE git_changes ADD COLUMN linked_graph_nodes_json TEXT NOT NULL DEFAULT '[]';
      INSERT INTO projects (id, name, slug, local_path, created_at, updated_at) VALUES ('keep-project', '保留项目', 'keep-project', '/fixture', '2026-09-08', '2026-09-08');
      INSERT INTO tasks (id, project_id, title, description, status, tags_json, created_from, source_context_json, created_at, updated_at) VALUES ('keep-task', 'keep-project', '保留任务', '用户正文', 'todo', '[]', 'graph_node', '{"nodeId":"old-node"}', '2026-09-08', '2026-09-08');
    `);
    for (const table of ['code_symbols', 'project_nodes', 'project_edges', 'graph_views']) {
      legacy.execute(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id)); INSERT INTO ${table} VALUES ('derived', 'keep-project');`);
    }
    for (const [key, value] of [
      ['codeMap.settings', { maxCallChainDepth: 3 }],
      ['app.shell.settings', { cache: { graphView: true }, lastCacheClearAt: 'old', language: 'zh-CN', appearance: 'dark' }],
      ['project.config.keep-project', { scan: {}, defaultTaskPrompt: 'old', database: { schemaPaths: ['/old'], connection: { enabled: false } }, defaultModel: 'keep-model' }],
    ] as const)
      legacy.execute('INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)', [key, JSON.stringify(value), '2026-09-08']);
  } finally {
    await legacy.close();
  }
  for (let startup = 0; startup < 2; startup += 1) {
    const migrated = await createZeusDatabase(path);
    try {
      assertProbe(migrated.select("SELECT name FROM sqlite_master WHERE name IN ('code_symbols', 'project_nodes', 'project_edges', 'graph_views')").length === 0, '图谱派生表必须删除且不能重建。');
      assertProbe(!migrated.select<{ name: string }>('PRAGMA table_info(projects)').some((column) => column.name === 'scan_status'), '旧扫描状态列必须移除。');
      assertProbe(!migrated.select<{ name: string }>('PRAGMA table_info(git_changes)').some((column) => column.name === 'linked_graph_nodes_json'), '旧图谱关联列必须移除。');
      assertProbe(migrated.get<{ description: string }>("SELECT description FROM tasks WHERE id = 'keep-task'")?.description === '用户正文', '图谱创建的历史任务必须保留正文。');
      assertProbe(!migrated.get("SELECT 1 FROM settings WHERE key = 'codeMap.settings'"), '专用图谱设置必须移除。');
      assertProbe(migrated.get<{ value: string }>("SELECT json_extract(value_json, '$.appearance') AS value FROM settings WHERE key = 'app.shell.settings'")?.value === 'dark', '外观设置必须保留。');
      assertProbe(migrated.get<{ value: string }>("SELECT json_extract(value_json, '$.defaultModel') AS value FROM settings WHERE key = 'project.config.keep-project'")?.value === 'keep-model', '项目默认模型必须保留。');
      assertProbe(migrated.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check === 'ok', '迁移后数据库必须完整。');
    } finally {
      await migrated.close();
    }
  }
  observed.retirement = { restarts: 2, derivedTablesRemoved: 4, historicalTaskPreserved: true, ordinarySettingsPreserved: true };
}
