import { createHash } from 'node:crypto';
import type { ConversationServerRequestKind } from './conversationStore.js';
import type { ZeusDatabasePort } from './databasePort.js';
import { runtimeSessionProcessOwningStatuses } from './runtimeSessionStore.js';

export const EXECUTION_HOST_WORK_INDEX_MIGRATION_ID = '20260821_0002_execution_host_work_indexes';

const activeSubmissionPredicate = "status IN ('dispatching', 'active')";
const effectfulTurnPredicate = "status IN ('dispatching', 'running')";
const pendingRequestPredicate = "status = 'pending'";
const processOwningRuntimePredicate = `status IN (${runtimeSessionProcessOwningStatuses.map((status) => `'${status}'`).join(', ')})`;
const activeCommandRunPredicate = "status IN ('pending_confirmation', 'starting', 'running', 'stopping')";

export interface ExecutionHostWorkIndexDefinition {
  name: string;
  table: string;
  predicate: string;
  createSql: string;
}

/**
 * Execution Host 心跳只扫描“当前仍活动”的小型部分索引，不随终态历史正文增长。
 * pending request 索引同时覆盖交接 checkpoint 的全部身份列，禁止读取 payload_json。
 */
export const executionHostWorkIndexes: readonly ExecutionHostWorkIndexDefinition[] = [
  {
    name: 'idx_execution_host_active_submissions',
    table: 'conversation_submissions',
    predicate: activeSubmissionPredicate,
    createSql: `CREATE INDEX IF NOT EXISTS idx_execution_host_active_submissions ON conversation_submissions(status, id) WHERE ${activeSubmissionPredicate}`,
  },
  {
    name: 'idx_execution_host_effectful_turns',
    table: 'conversation_turns',
    predicate: effectfulTurnPredicate,
    createSql: `CREATE INDEX IF NOT EXISTS idx_execution_host_effectful_turns ON conversation_turns(status, id) WHERE ${effectfulTurnPredicate}`,
  },
  {
    name: 'idx_execution_host_pending_requests',
    table: 'conversation_server_requests',
    predicate: pendingRequestPredicate,
    createSql: `CREATE INDEX IF NOT EXISTS idx_execution_host_pending_requests ON conversation_server_requests(status, created_at, id, conversation_id, transport_generation_id, request_kind) WHERE ${pendingRequestPredicate}`,
  },
  {
    name: 'idx_execution_host_process_owning_runtimes',
    table: 'runtime_sessions',
    predicate: processOwningRuntimePredicate,
    createSql: `CREATE INDEX IF NOT EXISTS idx_execution_host_process_owning_runtimes ON runtime_sessions(status, id) WHERE ${processOwningRuntimePredicate}`,
  },
  {
    name: 'idx_execution_host_active_command_runs',
    table: 'command_runs',
    predicate: activeCommandRunPredicate,
    createSql: `CREATE INDEX IF NOT EXISTS idx_execution_host_active_command_runs ON command_runs(status, id) WHERE ${activeCommandRunPredicate}`,
  },
];

export const EXECUTION_HOST_WORK_INDEX_CHECKSUM_SOURCE = executionHostWorkIndexes.map((definition) => `${definition.name}:${definition.createSql}`).join(';');

export const executionHostWorkCountsSql = `
  SELECT
    (SELECT COUNT(*) FROM conversation_submissions INDEXED BY idx_execution_host_active_submissions WHERE ${activeSubmissionPredicate}) AS active_submission_count,
    (SELECT COUNT(*) FROM conversation_turns INDEXED BY idx_execution_host_effectful_turns WHERE ${effectfulTurnPredicate}) AS effectful_turn_count,
    (SELECT COUNT(*) FROM conversation_server_requests INDEXED BY idx_execution_host_pending_requests WHERE ${pendingRequestPredicate}) AS pending_request_count,
    (SELECT COUNT(*) FROM runtime_sessions INDEXED BY idx_execution_host_process_owning_runtimes WHERE ${processOwningRuntimePredicate}) AS active_runtime_count,
    (SELECT COUNT(*) FROM command_runs INDEXED BY idx_execution_host_active_command_runs WHERE ${activeCommandRunPredicate}) AS active_command_run_count
`;

/**
 * 只读历史副本可能早于活动工作部分索引。验收世代禁止迁移，因此只允许该显式
 * 兼容查询退回表扫描；普通可写世代仍必须命中迁移后的固定索引并对 schema 漂移失败关闭。
 */
export const executionHostWorkCountsReadOnlyCompatibilitySql = `
  SELECT
    (SELECT COUNT(*) FROM conversation_submissions WHERE ${activeSubmissionPredicate}) AS active_submission_count,
    (SELECT COUNT(*) FROM conversation_turns WHERE ${effectfulTurnPredicate}) AS effectful_turn_count,
    (SELECT COUNT(*) FROM conversation_server_requests WHERE ${pendingRequestPredicate}) AS pending_request_count,
    (SELECT COUNT(*) FROM runtime_sessions WHERE ${processOwningRuntimePredicate}) AS active_runtime_count,
    (SELECT COUNT(*) FROM command_runs WHERE ${activeCommandRunPredicate}) AS active_command_run_count
`;

export const executionHostPendingRequestIdentitiesSql = `
  SELECT request.id, request.conversation_id, request.transport_generation_id, request.request_kind
    FROM conversation_server_requests AS request INDEXED BY idx_execution_host_pending_requests
    JOIN conversations AS conversation ON conversation.id = request.conversation_id
   WHERE request.${pendingRequestPredicate}
     AND conversation.agent_kind = 'codex'
     AND conversation.transport_kind = 'codex_native'
     AND conversation.agent_transport = 'app_server'
     AND conversation.provider_id = 'codex'
     AND conversation.provider_thread_id IS NOT NULL
     AND conversation.native_session_id = conversation.provider_thread_id
   ORDER BY request.created_at, request.id
`;

export interface ExecutionHostWorkCounts {
  activeSubmissionCount: number;
  effectfulTurnCount: number;
  pendingRequestCount: number;
  activeRuntimeCount: number;
  activeCommandRunCount: number;
}

export interface ExecutionHostPendingRequestIdentity {
  id: string;
  conversationId: string;
  transportGenerationId: string;
  requestKind: ConversationServerRequestKind;
}

interface DbExecutionHostWorkCountsRow {
  active_submission_count: number;
  effectful_turn_count: number;
  pending_request_count: number;
  active_runtime_count: number;
  active_command_run_count: number;
}

interface DbExecutionHostPendingRequestIdentityRow {
  id: string;
  conversation_id: string;
  transport_generation_id: string;
  request_kind: string;
}

/** 为 Execution Host 安装历史规模无关的活动工作部分索引；不创建业务记录。 */
export function migrateExecutionHostWorkSchema(db: ZeusDatabasePort): void {
  db.transaction(() => {
    for (const definition of executionHostWorkIndexes) db.execute(definition.createSql);
    const checksum = `sha256:${createHash('sha256').update(EXECUTION_HOST_WORK_INDEX_CHECKSUM_SOURCE).digest('hex')}`;
    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      EXECUTION_HOST_WORK_INDEX_MIGRATION_ID,
      '增加 Execution Host 活动工作聚合与交接身份覆盖索引',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

export class ExecutionHostWorkRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  readCounts(): ExecutionHostWorkCounts {
    return this.readCountsWithSql(executionHostWorkCountsSql);
  }

  /** 仅供 query_only 的历史副本使用，不得作为可写世代缺失迁移的静默回退。 */
  readCountsForReadOnlyCompatibility(): ExecutionHostWorkCounts {
    return this.readCountsWithSql(executionHostWorkCountsReadOnlyCompatibilitySql);
  }

  private readCountsWithSql(sql: string): ExecutionHostWorkCounts {
    const row = this.db.get<DbExecutionHostWorkCountsRow>(sql);
    if (!row) throw new Error('Execution Host 活动工作聚合查询未返回结果。');
    return {
      activeSubmissionCount: assertCount(row.active_submission_count, 'active submission'),
      effectfulTurnCount: assertCount(row.effectful_turn_count, 'effectful turn'),
      pendingRequestCount: assertCount(row.pending_request_count, 'pending request'),
      activeRuntimeCount: assertCount(row.active_runtime_count, 'active runtime'),
      activeCommandRunCount: assertCount(row.active_command_run_count, 'active command run'),
    };
  }

  listPendingRequestIdentities(): ExecutionHostPendingRequestIdentity[] {
    return this.db.select<DbExecutionHostPendingRequestIdentityRow>(executionHostPendingRequestIdentitiesSql).map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      transportGenerationId: row.transport_generation_id,
      requestKind: parseRequestKind(row.request_kind),
    }));
  }
}

function assertCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Execution Host ${label} count 非法。`);
  return value;
}

function parseRequestKind(value: string): ConversationServerRequestKind {
  if (value === 'command' || value === 'file' || value === 'permissions' || value === 'request_user_input' || value === 'mcp') return value;
  throw new Error(`Execution Host 待回复请求类型非法：${value}`);
}
