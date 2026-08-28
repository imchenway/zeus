import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  EXECUTION_HOST_WORK_INDEX_MIGRATION_ID,
  ConversationRepository,
  ExecutionHostWorkRepository,
  createZeusDatabase,
  executionHostPendingRequestIdentitiesSql,
  executionHostWorkCountsSql,
  executionHostWorkIndexes,
  runtimeSessionMayOwnProcess,
} from '../packages/storage/src/index.js';

interface QueryPlanRow {
  detail: string;
}

const historyRowsPerTable = 1_000;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'zeus-execution-host-work-'));
const databasePath = join(temporaryRoot, 'zeus.db');
const database = await createZeusDatabase(databasePath);

try {
  seedHistoricalAndActiveWork();
  await database.save();

  const repository = new ExecutionHostWorkRepository(database);
  const counts = repository.readCounts();
  assertJsonEqual(counts, {
    activeSubmissionCount: 2,
    effectfulTurnCount: 2,
    pendingRequestCount: 4,
    activeRuntimeCount: 2,
    activeCommandRunCount: 4,
  });

  const checkpoint = repository.listPendingRequestIdentities();
  assertJsonEqual(checkpoint, [
    {
      id: 'request-pending-user-input',
      conversationId: 'conversation-active',
      transportGenerationId: 'generation-a',
      requestKind: 'request_user_input',
    },
    {
      id: 'request-pending-permissions',
      conversationId: 'conversation-active',
      transportGenerationId: 'generation-b',
      requestKind: 'permissions',
    },
  ]);
  if (checkpoint.length >= counts.pendingRequestCount) throw new Error('Pi/冲突身份待回复请求未形成 checkpoint 数量缺口，自动交接不会保守阻断。');
  if (checkpoint.some((identity) => Object.keys(identity).length !== 4)) throw new Error('交接 checkpoint 读取了最小身份列之外的数据。');

  if (!runtimeSessionMayOwnProcess('running') || !runtimeSessionMayOwnProcess('orphan_detected') || runtimeSessionMayOwnProcess('lost')) {
    throw new Error('Runtime 进程所有权状态与 Execution Host 聚合语义不一致。');
  }
  database.execute(`UPDATE runtime_sessions SET status = 'lost' WHERE id = 'runtime-orphan-hidden'`);
  if (repository.readCounts().activeRuntimeCount !== 1) throw new Error('Runtime 离开进程所有权状态后，部分索引计数未同步收敛。');
  database.execute(`UPDATE runtime_sessions SET status = 'orphan_detected' WHERE id = 'runtime-orphan-hidden'`);
  if (repository.readCounts().activeRuntimeCount !== 2) throw new Error('orphan_detected Runtime 未重新进入活动工作计数。');
  await database.save();

  const countPlan = readPlan(executionHostWorkCountsSql);
  const checkpointPlan = readPlan(executionHostPendingRequestIdentitiesSql);
  const planViolations = validatePlans(countPlan, checkpointPlan);
  if (planViolations.length > 0) throw new Error(`${planViolations.join('\n')}\ncountPlan=${JSON.stringify(countPlan)}\ncheckpointPlan=${JSON.stringify(checkpointPlan)}`);

  const samples: number[] = [];
  for (let index = 0; index < 250; index += 1) {
    const startedAt = performance.now();
    repository.readCounts();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;

  // 模拟比当前迁移旧的正式历史副本：validation 只能读，不能补建索引。
  for (const definition of executionHostWorkIndexes) database.execute(`DROP INDEX ${definition.name}`);
  let ordinaryMissingIndexFailedClosed = false;
  try {
    repository.readCounts();
  } catch (error) {
    ordinaryMissingIndexFailedClosed = error instanceof Error && error.message.includes('no such index');
  }
  if (!ordinaryMissingIndexFailedClosed) throw new Error('普通世代缺失 Execution Host 索引时没有失败关闭。');
  const readOnlyCompatibilityCounts = repository.readCountsForReadOnlyCompatibility();
  assertJsonEqual(readOnlyCompatibilityCounts, counts);
  for (const definition of executionHostWorkIndexes) database.execute(definition.createSql);

  const migrationRecorded = Boolean(database.get<{ present: number }>(`SELECT 1 AS present FROM schema_migrations WHERE migration_id = ?`, [EXECUTION_HOST_WORK_INDEX_MIGRATION_ID]));
  if (!migrationRecorded) throw new Error(`缺少迁移账本 ${EXECUTION_HOST_WORK_INDEX_MIGRATION_ID}`);
  const quickCheck = database.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? 'missing';
  if (quickCheck !== 'ok') throw new Error(`临时数据库 quick_check 失败：${quickCheck}`);

  console.log(
    JSON.stringify(
      {
        status: 'passed',
        historyRowsPerTable,
        counts,
        checkpoint,
        handoffBlockedPendingCountMismatch: checkpoint.length < counts.pendingRequestCount,
        runtimeOwnershipTransition: 'orphan_detected -> lost -> orphan_detected',
        indexes: executionHostWorkIndexes.map((index) => index.name),
        countPlan,
        checkpointPlan,
        aggregateReadSamples: { count: samples.length, p95Ms: Number(p95Ms.toFixed(3)) },
        oldSnapshotCompatibility: { ordinaryMissingIndexFailedClosed, readOnlyCompatibilityCounts },
        migrationRecorded,
        quickCheck,
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

function seedHistoricalAndActiveWork(): void {
  const timestamp = '2026-08-21T00:00:00.000Z';
  const conversations = new ConversationRepository(database);
  conversations.create({
    id: 'conversation-active',
    projectId: 'project-active',
    title: 'Codex pending requests',
    transportKind: 'codex_native',
    providerId: 'codex',
    providerThreadId: 'thread-active',
    providerState: 'waiting',
    agentKind: 'codex',
    agentTransport: 'app_server',
    nativeSessionId: 'thread-active',
  });
  conversations.create({
    id: 'conversation-pi',
    projectId: 'project-active',
    title: 'Pi pending request',
    transportKind: 'codex_native',
    providerId: 'pi:source',
    providerThreadId: 'pi-session',
    providerState: 'waiting',
    agentKind: 'pi',
    agentTransport: 'rpc',
    nativeSessionId: 'pi-session',
  });
  conversations.create({
    id: 'conversation-codex-mismatch',
    projectId: 'project-active',
    title: 'Mismatched Codex identity',
    transportKind: 'codex_native',
    providerId: 'pi:wrong-provider',
    providerThreadId: 'mismatch-session',
    providerState: 'waiting',
    agentKind: 'codex',
    agentTransport: 'app_server',
    nativeSessionId: 'mismatch-session',
  });
  database.transaction(() => {
    database.execute(
      `WITH RECURSIVE seq(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM seq WHERE value < ?)
       INSERT INTO conversation_submissions
         (id, conversation_id, idempotency_key, request_hash, client_message_id, kind, requested_delivery, status, input_json, created_at, updated_at)
       SELECT 'history-submission-' || value, 'history-conversation', 'history-key-' || value, 'history-hash-' || value,
              'history-client-' || value, 'message', 'queue', 'completed', '{}', ?, ?
         FROM seq`,
      [historyRowsPerTable, timestamp, timestamp],
    );
    database.execute(
      `WITH RECURSIVE seq(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM seq WHERE value < ?)
       INSERT INTO conversation_turns
         (id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status, created_at, updated_at)
       SELECT 'history-turn-' || value, 'history-conversation', 'history-thread', NULL, NULL, 'completed', ?, ?
         FROM seq`,
      [historyRowsPerTable, timestamp, timestamp],
    );
    database.execute(
      `WITH RECURSIVE seq(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM seq WHERE value < ?)
       INSERT INTO conversation_server_requests
         (id, conversation_id, transport_generation_id, provider_request_id_json, request_kind, payload_json, status, created_at)
       SELECT 'history-request-' || value, 'history-conversation', 'history-generation', json_quote(value), 'mcp', '{}', 'resolved', ?
         FROM seq`,
      [historyRowsPerTable, timestamp],
    );
    database.execute(
      `WITH RECURSIVE seq(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM seq WHERE value < ?)
       INSERT INTO runtime_sessions
         (id, project_id, command, args_json, cwd, status, started_at, ended_at, created_at, updated_at)
       SELECT 'history-runtime-' || value, 'history-project', 'true', '[]', '/tmp', 'exited', ?, ?, ?, ?
         FROM seq`,
      [historyRowsPerTable, timestamp, timestamp, timestamp, timestamp],
    );
    database.execute(
      `WITH RECURSIVE seq(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM seq WHERE value < ?)
       INSERT INTO command_runs
         (id, command_id, project_id, trigger, status, command_snapshot_json, parameter_snapshot_json, cwd, timeout_seconds, ended_at, created_at, updated_at)
       SELECT 'history-command-' || value, NULL, 'history-project', 'ui', 'succeeded', '{}', '{}', '/tmp', 30, ?, ?, ?
         FROM seq`,
      [historyRowsPerTable, timestamp, timestamp, timestamp],
    );

    for (const [id, status] of [
      ['submission-dispatching', 'dispatching'],
      ['submission-active', 'active'],
      ['submission-queued', 'queued'],
      ['submission-paused', 'paused'],
    ] as const) {
      database.execute(
        `INSERT INTO conversation_submissions
          (id, conversation_id, idempotency_key, request_hash, client_message_id, kind, requested_delivery, status, input_json, created_at, updated_at)
         VALUES (?, 'conversation-active', ?, ?, ?, 'message', 'queue', ?, '{}', ?, ?)`,
        [id, `${id}-key`, `${id}-hash`, `${id}-client`, status, timestamp, timestamp],
      );
    }

    for (const [id, status] of [
      ['turn-dispatching', 'dispatching'],
      ['turn-running', 'running'],
      ['turn-waiting', 'waiting'],
      ['turn-queued', 'queued'],
      ['turn-paused', 'paused'],
    ] as const) {
      database.execute(
        `INSERT INTO conversation_turns
          (id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status, created_at, updated_at)
         VALUES (?, 'conversation-active', 'thread-active', NULL, NULL, ?, ?, ?)`,
        [id, status, timestamp, timestamp],
      );
    }

    const largeSecretRedactedPayload = JSON.stringify({ prompt: 'x'.repeat(512 * 1024) });
    database.execute(
      `INSERT INTO conversation_server_requests
        (id, conversation_id, transport_generation_id, provider_request_id_json, request_kind, payload_json, status, created_at)
       VALUES ('request-pending-user-input', 'conversation-active', 'generation-a', '"provider-a"', 'request_user_input', ?, 'pending', '2026-08-21T00:00:01.000Z')`,
      [largeSecretRedactedPayload],
    );
    database.execute(
      `INSERT INTO conversation_server_requests
        (id, conversation_id, transport_generation_id, provider_request_id_json, request_kind, payload_json, status, created_at)
       VALUES ('request-pending-permissions', 'conversation-active', 'generation-b', '"provider-b"', 'permissions', ?, 'pending', '2026-08-21T00:00:02.000Z')`,
      [largeSecretRedactedPayload],
    );
    database.execute(
      `INSERT INTO conversation_server_requests
        (id, conversation_id, transport_generation_id, provider_request_id_json, request_kind, payload_json, status, created_at)
       VALUES ('request-pending-pi', 'conversation-pi', 'generation-pi', '"provider-pi"', 'request_user_input', ?, 'pending', '2026-08-21T00:00:03.000Z')`,
      [largeSecretRedactedPayload],
    );
    database.execute(
      `INSERT INTO conversation_server_requests
        (id, conversation_id, transport_generation_id, provider_request_id_json, request_kind, payload_json, status, created_at)
       VALUES ('request-pending-mismatch', 'conversation-codex-mismatch', 'generation-mismatch', '"provider-mismatch"', 'permissions', ?, 'pending', '2026-08-21T00:00:04.000Z')`,
      [largeSecretRedactedPayload],
    );

    database.execute(
      `INSERT INTO runtime_sessions
        (id, project_id, command, args_json, cwd, status, pid, started_at, created_at, updated_at)
       VALUES ('runtime-running', 'project-active', 'sleep', '[]', '/tmp', 'running', 9001, ?, ?, ?)`,
      [timestamp, timestamp, timestamp],
    );
    database.execute(
      `INSERT INTO runtime_sessions
        (id, project_id, command, args_json, cwd, status, pid, archived, started_at, created_at, updated_at, deleted_at)
       VALUES ('runtime-orphan-hidden', 'project-active', 'sleep', '[]', '/tmp', 'orphan_detected', 9002, 1, ?, ?, ?, ?)`,
      [timestamp, timestamp, timestamp, timestamp],
    );

    for (const status of ['pending_confirmation', 'starting', 'running', 'stopping'] as const) {
      database.execute(
        `INSERT INTO command_runs
          (id, command_id, project_id, trigger, status, command_snapshot_json, parameter_snapshot_json, cwd, timeout_seconds, created_at, updated_at)
         VALUES (?, NULL, 'project-active', 'ui', ?, '{}', '{}', '/tmp', 30, ?, ?)`,
        [`command-${status}`, status, timestamp, timestamp],
      );
    }
  });
}

function readPlan(sql: string): string[] {
  return database.select<QueryPlanRow>(`EXPLAIN QUERY PLAN ${sql}`).map((row) => row.detail);
}

function validatePlans(countPlan: string[], checkpointPlan: string[]): string[] {
  const violations: string[] = [];
  for (const definition of executionHostWorkIndexes) {
    if (!countPlan.some((detail) => detail.includes(definition.name)) && !(definition.name === 'idx_execution_host_pending_requests' && checkpointPlan.some((detail) => detail.includes(definition.name)))) {
      violations.push(`聚合查询未命中预期索引 ${definition.name}`);
    }
    const tablePattern = definition.table.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const unindexedScan = new RegExp(`\\bSCAN\\s+(?:TABLE\\s+)?${tablePattern}\\b(?!.*\\bUSING\\b)`, 'iu');
    if ([...countPlan, ...checkpointPlan].some((detail) => unindexedScan.test(detail))) violations.push(`${definition.table} 出现无索引全表扫描`);
  }
  if (!checkpointPlan.some((detail) => detail.includes('idx_execution_host_pending_requests'))) violations.push('checkpoint 未命中待回复请求覆盖索引');
  if (!checkpointPlan.some((detail) => /SEARCH conversation USING (?:COVERING )?INDEX/iu.test(detail))) violations.push('checkpoint 未通过会话主键索引核验 Codex 身份');
  if (checkpointPlan.some((detail) => /\bSCAN conversation\b(?!.*\bUSING\b)/iu.test(detail))) violations.push('checkpoint 对 conversations 出现无索引全表扫描');
  if (checkpointPlan.some((detail) => /USE TEMP B-TREE/iu.test(detail))) violations.push('checkpoint 出现临时 B-Tree 排序');
  return violations;
}

function assertJsonEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`行为结果不一致：\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`);
  }
}
