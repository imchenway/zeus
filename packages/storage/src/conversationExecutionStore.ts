import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { nanoid } from 'nanoid';
import type { ZeusDatabase } from './index.js';

export const conversationSchemaGeneration = '2026-08-16-unified-conversation-segments';

export type ConversationRuntimeKind = 'codex' | 'pi';
export type ConversationSegmentState = 'provisional' | 'current' | 'sealed' | 'abandoned';
export type ConversationSwitchState = 'preflight' | 'provisional' | 'outcome_unknown' | 'accepted' | 'failed' | 'cancelled';
export type ConversationSubmissionOutcome = 'queued' | 'paused' | 'outcome_unknown' | 'accepted' | 'terminal';
export type ConversationProcessKind = 'reasoning' | 'tool' | 'command' | 'retry' | 'context_compaction' | 'waiting' | 'warning';
export type ConversationConfigEvidenceLayer = 'selected' | 'frozen' | 'adapter_serialized' | 'runtime_acknowledged' | 'provider_echo';

export interface ConversationExecutionSnapshotRecord {
  id: string;
  conversationId: string;
  runtimeKind: ConversationRuntimeKind;
  connectionId: string | null;
  credentialSlotId: string | null;
  endpointIdentity: string;
  protocolFamily: string;
  modelId: string;
  effort: string | null;
  serviceTier: string | null;
  permissionMode: string;
  collaborationMode: string;
  workspaceIdentityJson: string;
  routeFingerprint: string;
  createdAt: string;
}

export interface ConversationRuntimeSegmentRecord {
  id: string;
  conversationId: string;
  runtimeKind: ConversationRuntimeKind;
  state: ConversationSegmentState;
  executionSnapshotId: string | null;
  providerId: string | null;
  nativeSessionId: string | null;
  nativeSessionPath: string | null;
  providerModel: string | null;
  providerProtocolVersion: string | null;
  providerBinaryVersion: string | null;
  provisionalForSubmissionId: string | null;
  openedAt: string;
  acceptedAt: string | null;
  sealedAt: string | null;
  sealReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSwitchOperationRecord {
  id: string;
  conversationId: string;
  submissionId: string;
  sourceSegmentId: string | null;
  targetSegmentId: string;
  state: ConversationSwitchState;
  acceptanceEvidenceJson: string | null;
  failureJson: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ConversationModelHistoryRecord {
  id: string;
  conversationId: string;
  sequence: number;
  turnId: string;
  submissionId: string | null;
  segmentId: string;
  role: 'user' | 'assistant' | 'tool';
  contentJson: string;
  reasoningSourceJson: string | null;
  toolPairId: string | null;
  capabilityLossJson: string | null;
  confirmedAt: string;
}

export interface ConversationModelRequestUsageRecord {
  id: string;
  conversationId: string;
  turnId: string | null;
  segmentId: string;
  requestKind: 'inference' | 'tool_continuation' | 'retry' | 'context_compaction';
  requestSequence: number;
  modelId: string;
  contextWindow: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  estimatedUsd: number | null;
  usageComplete: boolean;
  occurredAt: string;
}

export interface ConversationProcessItemRecord {
  id: string;
  conversationId: string;
  turnId: string;
  segmentId: string;
  processSequence: number;
  kind: ConversationProcessKind;
  status: 'in_progress' | 'completed' | 'failed';
  title: string;
  detailJson: string;
  sourceEventId: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ConversationToolResultRecord {
  handle: string;
  conversationId: string;
  turnId: string;
  segmentId: string;
  toolPairId: string;
  relativePath: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
  projectionJson: string;
  createdAt: string;
}

export interface ConversationUnifiedSnapshot {
  conversationSchemaGeneration: typeof conversationSchemaGeneration;
  throughEventSeq: number;
  currentSegment: ConversationRuntimeSegmentRecord | null;
  segments: ConversationRuntimeSegmentRecord[];
  executionSnapshots: ConversationExecutionSnapshotRecord[];
  modelHistory: ConversationModelHistoryRecord[];
  process: ConversationProcessItemRecord[];
  usage: {
    conversationTotal: NullableUsage;
    turnTotal: NullableUsage;
    latestModelRequest: ConversationModelRequestUsageRecord | null;
    preflightEstimate: null;
  };
  warnings: ConversationPersistentWarningRecord[];
  configurationEvidence: ConversationConfigEvidenceRecord[];
}

export interface ConversationPersistentWarningRecord {
  id: string;
  conversationId: string;
  warningKind: string;
  payloadJson: string;
  firstEventSeq: number;
  lastEventSeq: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ConversationConfigEvidenceRecord {
  id: string;
  conversationId: string;
  turnId: string | null;
  submissionId: string | null;
  segmentId: string | null;
  layer: ConversationConfigEvidenceLayer;
  configurationJson: string;
  evidenceJson: string;
  mismatch: boolean;
  observedAt: string;
}

interface NullableUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  estimatedUsd: number | null;
  complete: boolean;
}

interface ExecutionSnapshotInput {
  conversationId: string;
  runtimeKind: ConversationRuntimeKind;
  connectionId?: string | null;
  credentialSlotId?: string | null;
  endpointIdentity: string;
  protocolFamily: string;
  modelId: string;
  effort?: string | null;
  serviceTier?: string | null;
  permissionMode: string;
  collaborationMode: string;
  workspaceIdentity: unknown;
  createdAt: string;
}

interface BeginSwitchInput {
  conversationId: string;
  submissionId: string;
  executionSnapshotId: string;
  runtimeKind: ConversationRuntimeKind;
  providerId?: string | null;
  nativeSessionId?: string | null;
  nativeSessionPath?: string | null;
  providerModel?: string | null;
  providerProtocolVersion?: string | null;
  providerBinaryVersion?: string | null;
  createdAt: string;
}

interface AcceptSwitchInput {
  operationId: string;
  providerTurnId: string;
  turnId: string;
  acceptanceEvidence: unknown;
  userHistoryContent: unknown;
  acceptedAt: string;
}

interface AcceptCurrentSegmentInput {
  conversationId: string;
  submissionId: string;
  segmentId: string;
  providerTurnId: string;
  turnId: string;
  userHistoryContent: unknown;
  acceptedAt: string;
}

const schemaMigrationId = '20260816_0311_unified_conversation_segments';

/** 建立统一会话语义表，并把所有旧 Provider 身份一次性封存为只读分段。 */
export function migrateUnifiedConversationStoreSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_store_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_generation TEXT NOT NULL,
      dispatch_enabled INTEGER NOT NULL DEFAULT 0,
      migrated_at TEXT NOT NULL,
      migration_manifest_sha256 TEXT
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_sequence_counters (
      conversation_id TEXT PRIMARY KEY,
      timeline_sequence INTEGER NOT NULL DEFAULT 0,
      model_history_sequence INTEGER NOT NULL DEFAULT 0,
      sync_event_sequence INTEGER NOT NULL DEFAULT 0,
      process_sequence INTEGER NOT NULL DEFAULT 0,
      model_request_sequence INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_execution_snapshots (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, runtime_kind TEXT NOT NULL,
      connection_id TEXT, credential_slot_id TEXT, endpoint_identity TEXT NOT NULL,
      protocol_family TEXT NOT NULL, model_id TEXT NOT NULL, effort TEXT, service_tier TEXT,
      permission_mode TEXT NOT NULL, collaboration_mode TEXT NOT NULL,
      workspace_identity_json TEXT NOT NULL, route_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_execution_snapshots ON conversation_execution_snapshots(conversation_id, created_at, id)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_runtime_segments (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, runtime_kind TEXT NOT NULL,
      state TEXT NOT NULL, execution_snapshot_id TEXT, provider_id TEXT,
      native_session_id TEXT, native_session_path TEXT, provider_model TEXT,
      provider_protocol_version TEXT, provider_binary_version TEXT,
      provisional_for_submission_id TEXT, opened_at TEXT NOT NULL, accepted_at TEXT,
      sealed_at TEXT, seal_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_current_segment ON conversation_runtime_segments(conversation_id) WHERE state = 'current'`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_provisional_segment ON conversation_runtime_segments(conversation_id) WHERE state = 'provisional'`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_segment_native_identity ON conversation_runtime_segments(runtime_kind, native_session_id) WHERE native_session_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_segments ON conversation_runtime_segments(conversation_id, created_at, id)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_switch_operations (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, submission_id TEXT NOT NULL UNIQUE,
      source_segment_id TEXT, target_segment_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
      acceptance_evidence_json TEXT, failure_json TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, resolved_at TEXT
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_open_switch ON conversation_switch_operations(conversation_id) WHERE state IN ('preflight', 'provisional', 'outcome_unknown')`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_timeline_events (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      event_kind TEXT NOT NULL, turn_id TEXT, submission_id TEXT, segment_id TEXT,
      payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
      UNIQUE(conversation_id, sequence)
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_model_history (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      turn_id TEXT NOT NULL, submission_id TEXT, segment_id TEXT NOT NULL,
      role TEXT NOT NULL, content_json TEXT NOT NULL, reasoning_source_json TEXT,
      tool_pair_id TEXT, capability_loss_json TEXT, confirmed_at TEXT NOT NULL,
      UNIQUE(conversation_id, sequence)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_model_history_turn ON conversation_model_history(conversation_id, turn_id, sequence)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_process_items (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      segment_id TEXT NOT NULL, process_sequence INTEGER NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, title TEXT NOT NULL, detail_json TEXT NOT NULL,
      source_event_id TEXT, started_at TEXT NOT NULL, completed_at TEXT,
      UNIQUE(conversation_id, process_sequence),
      UNIQUE(segment_id, source_event_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_process_turn ON conversation_process_items(conversation_id, turn_id, process_sequence)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_portable_contexts (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, through_model_history_sequence INTEGER NOT NULL,
      target_execution_snapshot_id TEXT NOT NULL, status TEXT NOT NULL,
      content_json TEXT NOT NULL, capability_loss_json TEXT NOT NULL,
      estimated_input_tokens INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_context_checkpoints (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, portable_context_id TEXT NOT NULL,
      route_fingerprint TEXT NOT NULL, through_model_history_sequence INTEGER NOT NULL,
      request_usage_id TEXT, summary_json TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(conversation_id, route_fingerprint, through_model_history_sequence)
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_tool_results (
      handle TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      segment_id TEXT NOT NULL, tool_pair_id TEXT NOT NULL, relative_path TEXT NOT NULL,
      sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, mime_type TEXT NOT NULL,
      projection_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(conversation_id, tool_pair_id)
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_model_requests (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT, segment_id TEXT NOT NULL,
      request_kind TEXT NOT NULL, request_sequence INTEGER NOT NULL, model_id TEXT NOT NULL,
      context_window INTEGER, input_tokens INTEGER, cached_input_tokens INTEGER,
      cache_write_input_tokens INTEGER, output_tokens INTEGER, reasoning_output_tokens INTEGER,
      total_tokens INTEGER, estimated_usd REAL, usage_complete INTEGER NOT NULL DEFAULT 0,
      occurred_at TEXT NOT NULL, UNIQUE(conversation_id, request_sequence)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_model_requests_turn ON conversation_model_requests(conversation_id, turn_id, request_sequence)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_config_evidence (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT, submission_id TEXT,
      segment_id TEXT, layer TEXT NOT NULL, configuration_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL, mismatch INTEGER NOT NULL DEFAULT 0,
      observed_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_config_evidence ON conversation_config_evidence(conversation_id, turn_id, observed_at, id)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_persistent_warnings (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, warning_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, first_event_seq INTEGER NOT NULL, last_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT,
      UNIQUE(conversation_id, warning_kind, resolved_at)
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_open_warning ON conversation_persistent_warnings(conversation_id, warning_kind) WHERE resolved_at IS NULL`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_migration_mappings (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      source_identity TEXT NOT NULL, target_kind TEXT NOT NULL, target_identity TEXT NOT NULL,
      source_hash TEXT NOT NULL, mapped_at TEXT NOT NULL,
      UNIQUE(source_kind, source_identity, target_kind)
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_recovery_events (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, segment_id TEXT,
      event_kind TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL
    )
  `);

  for (const [column, definition] of [
    ['replacement_of_submission_id', 'TEXT'],
    ['replacement_reason', 'TEXT'],
    ['execution_snapshot_id', 'TEXT'],
    ['segment_id', 'TEXT'],
    ['submission_outcome', "TEXT NOT NULL DEFAULT 'queued'"],
    ['accepted_at', 'TEXT'],
    ['timeline_sequence', 'INTEGER'],
    ['model_history_sequence', 'INTEGER'],
  ] as const) {
    addColumn(db, 'conversation_submissions', column, definition);
  }
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_submission_replacement ON conversation_submissions(replacement_of_submission_id) WHERE replacement_of_submission_id IS NOT NULL`);

  const migratedAt = new Date().toISOString();
  const existingMetadata = db.get<{ schema_generation: string }>(`SELECT schema_generation FROM conversation_store_metadata WHERE singleton = 1`);
  if (!existingMetadata) {
    sealLegacyProviderSessions(db, migratedAt);
    migrateLegacyConversationHistory(db, migratedAt);
    db.execute(
      `UPDATE conversation_submissions
          SET status = 'paused', paused_reason = 'upgrade_interrupted', submission_outcome = 'paused', updated_at = ?
        WHERE status IN ('queued', 'dispatching', 'active', 'paused')`,
      [migratedAt],
    );
    const manifest = migrationManifest(db);
    db.execute(
      `INSERT INTO conversation_store_metadata (singleton, schema_generation, dispatch_enabled, migrated_at, migration_manifest_sha256)
       VALUES (1, ?, 0, ?, ?)`,
      [conversationSchemaGeneration, migratedAt, manifest],
    );
  } else if (existingMetadata.schema_generation !== conversationSchemaGeneration) {
    throw new Error(`会话结构代次不匹配：${existingMetadata.schema_generation}`);
  }

  db.execute(`
    CREATE TRIGGER IF NOT EXISTS reject_conversation_submission_payload_rewrite
    BEFORE UPDATE OF conversation_id, idempotency_key, request_hash, client_message_id, kind,
                     requested_delivery, input_json, target_provider_turn_id, created_at,
                     replacement_of_submission_id, replacement_reason
    ON conversation_submissions
    WHEN OLD.conversation_id IS NOT NEW.conversation_id
      OR OLD.idempotency_key IS NOT NEW.idempotency_key
      OR OLD.request_hash IS NOT NEW.request_hash
      OR OLD.client_message_id IS NOT NEW.client_message_id
      OR OLD.kind IS NOT NEW.kind
      OR OLD.requested_delivery IS NOT NEW.requested_delivery
      OR OLD.input_json IS NOT NEW.input_json
      OR OLD.target_provider_turn_id IS NOT NEW.target_provider_turn_id
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.replacement_of_submission_id IS NOT NEW.replacement_of_submission_id
      OR OLD.replacement_reason IS NOT NEW.replacement_reason
    BEGIN
      SELECT RAISE(ABORT, 'ZEUS_IMMUTABLE_SUBMISSION_PAYLOAD');
    END
  `);

  const checksum = `sha256:${createHash('sha256').update('unified-conversation-segments-submissions-history-context-tools-usage-evidence-process-recovery').digest('hex')}`;
  db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
    schemaMigrationId,
    '建立统一产品会话、运行分段、不可变提交、上下文、用量与处理过程语义表',
    checksum,
    migratedAt,
  ]);
  db.execute(`CREATE TABLE IF NOT EXISTS conversation_legacy_write_fence (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), current_writer_open INTEGER NOT NULL CHECK (current_writer_open IN (0, 1)))`);
  db.execute(`INSERT OR IGNORE INTO conversation_legacy_write_fence (singleton, current_writer_open) VALUES (1, 1)`);
  for (const action of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    db.execute(`
      CREATE TRIGGER IF NOT EXISTS reject_legacy_schema_migrations_${action.toLowerCase()}
      BEFORE ${action} ON schema_migrations
      WHEN (SELECT current_writer_open FROM conversation_legacy_write_fence WHERE singleton = 1) = 0
      BEGIN
        SELECT RAISE(ABORT, 'ZEUS_DOWNGRADE_REQUIRES_SAFE_ROLLBACK_DATABASE');
      END
    `);
  }
}

/** 统一会话账本仓储；运行适配器不得自行维护产品队列或切换状态。 */
export class ConversationExecutionRepository {
  constructor(private readonly db: ZeusDatabase) {}

  setDispatchEnabled(enabled: boolean): void {
    this.db.execute(`UPDATE conversation_store_metadata SET dispatch_enabled = ? WHERE singleton = 1 AND schema_generation = ?`, [enabled ? 1 : 0, conversationSchemaGeneration]);
  }

  isDispatchEnabled(): boolean {
    const row = this.db.get<{ dispatch_enabled: number; schema_generation: string }>(`SELECT dispatch_enabled, schema_generation FROM conversation_store_metadata WHERE singleton = 1`);
    if (!row || row.schema_generation !== conversationSchemaGeneration) throw new Error('统一会话存储尚未完成迁移。');
    return row.dispatch_enabled === 1;
  }

  createExecutionSnapshot(input: ExecutionSnapshotInput): ConversationExecutionSnapshotRecord {
    const id = `conversation_execution_snapshot_${nanoid(12)}`;
    const workspaceIdentityJson = JSON.stringify(input.workspaceIdentity);
    const routeFingerprint = createHash('sha256')
      .update(JSON.stringify([input.runtimeKind, input.connectionId ?? null, input.endpointIdentity, input.protocolFamily, input.modelId, input.credentialSlotId ?? null]))
      .digest('hex');
    this.db.execute(
      `INSERT INTO conversation_execution_snapshots
       (id, conversation_id, runtime_kind, connection_id, credential_slot_id, endpoint_identity,
        protocol_family, model_id, effort, service_tier, permission_mode, collaboration_mode,
        workspace_identity_json, route_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.conversationId,
        input.runtimeKind,
        input.connectionId ?? null,
        input.credentialSlotId ?? null,
        input.endpointIdentity,
        input.protocolFamily,
        input.modelId,
        input.effort ?? null,
        input.serviceTier ?? null,
        input.permissionMode,
        input.collaborationMode,
        workspaceIdentityJson,
        routeFingerprint,
        input.createdAt,
      ],
    );
    return this.getExecutionSnapshot(id)!;
  }

  getExecutionSnapshot(id: string): ConversationExecutionSnapshotRecord | undefined {
    const row = this.db.get<ExecutionSnapshotRow>(`SELECT * FROM conversation_execution_snapshots WHERE id = ?`, [id]);
    return row ? mapExecutionSnapshot(row) : undefined;
  }

  /** 入队时只冻结执行配置；运行分段与模型历史水位要等到队首派发时再绑定。 */
  freezeSubmissionExecutionSnapshot(input: { conversationId: string; submissionId: string; executionSnapshotId: string }): void {
    const submission = this.db.get<{ execution_snapshot_id: string | null }>(`SELECT execution_snapshot_id FROM conversation_submissions WHERE id = ? AND conversation_id = ?`, [input.submissionId, input.conversationId]);
    if (!submission) throw new Error(`会话提交不存在：${input.submissionId}`);
    if (submission.execution_snapshot_id && submission.execution_snapshot_id !== input.executionSnapshotId) {
      throw new Error(`会话提交已经冻结到其他执行快照：${input.submissionId}`);
    }
    this.db.execute(`UPDATE conversation_submissions SET execution_snapshot_id = ? WHERE id = ? AND conversation_id = ?`, [input.executionSnapshotId, input.submissionId, input.conversationId]);
  }

  beginSwitch(input: BeginSwitchInput): ConversationSwitchOperationRecord {
    const existing = this.getSwitchBySubmission(input.submissionId);
    if (existing) return existing;
    if (!this.getExecutionSnapshot(input.executionSnapshotId)) throw new Error(`执行快照不存在：${input.executionSnapshotId}`);
    const segmentId = `conversation_segment_${nanoid(12)}`;
    const operationId = `conversation_switch_${nanoid(12)}`;
    this.db.transaction(() => {
      this.reconcileSwitchSlot(input.conversationId, input.createdAt);
      const source = this.currentSegment(input.conversationId);
      this.db.execute(
        `INSERT INTO conversation_runtime_segments
         (id, conversation_id, runtime_kind, state, execution_snapshot_id, provider_id,
          native_session_id, native_session_path, provider_model, provider_protocol_version,
          provider_binary_version, provisional_for_submission_id, opened_at, accepted_at,
          sealed_at, seal_reason, created_at, updated_at)
         VALUES (?, ?, ?, 'provisional', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        [
          segmentId,
          input.conversationId,
          input.runtimeKind,
          input.executionSnapshotId,
          input.providerId ?? null,
          input.nativeSessionId ?? null,
          input.nativeSessionPath ?? null,
          input.providerModel ?? null,
          input.providerProtocolVersion ?? null,
          input.providerBinaryVersion ?? null,
          input.submissionId,
          input.createdAt,
          input.createdAt,
          input.createdAt,
        ],
      );
      this.db.execute(
        `INSERT INTO conversation_switch_operations
         (id, conversation_id, submission_id, source_segment_id, target_segment_id, state,
          acceptance_evidence_json, failure_json, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, 'provisional', NULL, NULL, ?, ?, NULL)`,
        [operationId, input.conversationId, input.submissionId, source?.id ?? null, segmentId, input.createdAt, input.createdAt],
      );
      this.db.execute(
        `UPDATE conversation_submissions
            SET execution_snapshot_id = ?, segment_id = ?, submission_outcome = 'queued'
          WHERE id = ? AND conversation_id = ?`,
        [input.executionSnapshotId, segmentId, input.submissionId, input.conversationId],
      );
    });
    return this.getSwitch(operationId)!;
  }

  ensureSwitchSlotAvailable(input: { conversationId: string; submissionId: string; occurredAt: string }): void {
    this.db.transaction(() => this.reconcileSwitchSlot(input.conversationId, input.occurredAt, input.submissionId));
  }

  cancelOpenSwitchForSubmission(input: { conversationId: string; submissionId: string; reason: 'submission_deleted' | 'submission_cancelled'; occurredAt: string }): ConversationSwitchOperationRecord | null {
    const operation = this.getSwitchBySubmission(input.submissionId);
    if (!operation) return null;
    if (operation.conversationId !== input.conversationId) throw new Error(`运行分段切换不属于产品会话：${input.submissionId}`);
    if (!isOpenSwitch(operation)) return operation;
    this.db.transaction(() => this.cancelOpenSwitch(operation, input.reason, input.occurredAt));
    return this.getSwitch(operation.id)!;
  }

  updateProvisionalNativeIdentity(
    operationId: string,
    input: { nativeSessionId: string; nativeSessionPath?: string | null; providerId?: string | null; providerModel?: string | null; providerProtocolVersion?: string | null; providerBinaryVersion?: string | null; updatedAt: string },
  ): ConversationRuntimeSegmentRecord {
    const operation = this.requireOpenSwitch(operationId);
    this.db.execute(
      `UPDATE conversation_runtime_segments
          SET native_session_id = ?, native_session_path = ?, provider_id = COALESCE(?, provider_id),
              provider_model = COALESCE(?, provider_model), provider_protocol_version = COALESCE(?, provider_protocol_version),
              provider_binary_version = COALESCE(?, provider_binary_version), updated_at = ?
        WHERE id = ? AND state = 'provisional'`,
      [input.nativeSessionId, input.nativeSessionPath ?? null, input.providerId ?? null, input.providerModel ?? null, input.providerProtocolVersion ?? null, input.providerBinaryVersion ?? null, input.updatedAt, operation.targetSegmentId],
    );
    return this.segmentById(operation.targetSegmentId)!;
  }

  acceptSwitchDurably(input: AcceptSwitchInput): ConversationSwitchOperationRecord {
    return this.db.durableTransactionSync(() => {
      const operation = this.requireOpenSwitch(input.operationId);
      const target = this.segmentById(operation.targetSegmentId);
      if (!target || target.state !== 'provisional' || !target.nativeSessionId) throw new Error('候选运行分段尚未具备可提升的原生身份。');
      if (operation.sourceSegmentId) {
        this.db.execute(
          `UPDATE conversation_runtime_segments
              SET state = 'sealed', sealed_at = ?, seal_reason = 'route_switched', updated_at = ?
            WHERE id = ? AND state = 'current'`,
          [input.acceptedAt, input.acceptedAt, operation.sourceSegmentId],
        );
      }
      this.db.execute(
        `UPDATE conversation_runtime_segments
            SET state = 'current', accepted_at = ?, updated_at = ?
          WHERE id = ? AND state = 'provisional'`,
        [input.acceptedAt, input.acceptedAt, target.id],
      );
      const timelineSequence = this.nextSequence(operation.conversationId, 'timeline_sequence');
      const modelHistorySequence = this.nextSequence(operation.conversationId, 'model_history_sequence');
      const eventSequence = this.nextSequence(operation.conversationId, 'sync_event_sequence');
      this.upsertAcceptedTurn({
        turnId: input.turnId,
        conversationId: operation.conversationId,
        providerThreadId: target.nativeSessionId,
        providerTurnId: input.providerTurnId,
        submissionId: operation.submissionId,
        runtimeKind: target.runtimeKind,
        acceptedAt: input.acceptedAt,
      });
      this.db.execute(
        `UPDATE conversation_switch_operations
            SET state = 'accepted', acceptance_evidence_json = ?, updated_at = ?, resolved_at = ?
          WHERE id = ?`,
        [JSON.stringify(input.acceptanceEvidence), input.acceptedAt, input.acceptedAt, operation.id],
      );
      this.db.execute(
        `UPDATE conversation_submissions
            SET status = 'active', provider_turn_id = ?, submission_outcome = 'accepted',
                accepted_at = ?, timeline_sequence = ?, model_history_sequence = ?, updated_at = ?
          WHERE id = ?`,
        [input.providerTurnId, input.acceptedAt, timelineSequence, modelHistorySequence, input.acceptedAt, operation.submissionId],
      );
      this.db.execute(
        `INSERT INTO conversation_timeline_events
         (id, conversation_id, sequence, event_kind, turn_id, submission_id, segment_id, payload_json, occurred_at)
         VALUES (?, ?, ?, 'turn_accepted', ?, ?, ?, ?, ?)`,
        [`conversation_timeline_event_${nanoid(12)}`, operation.conversationId, timelineSequence, input.turnId, operation.submissionId, target.id, JSON.stringify({ providerTurnId: input.providerTurnId, eventSequence }), input.acceptedAt],
      );
      this.db.execute(
        `INSERT INTO conversation_model_history
         (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json,
          reasoning_source_json, tool_pair_id, capability_loss_json, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'user', ?, NULL, NULL, NULL, ?)`,
        [`conversation_model_history_${nanoid(12)}`, operation.conversationId, modelHistorySequence, input.turnId, operation.submissionId, target.id, JSON.stringify(input.userHistoryContent), input.acceptedAt],
      );
      this.resumeQueueBlockedByHead(operation.conversationId, input.acceptedAt);
      this.projectCurrentSegmentToLegacyConversation(target, input.acceptedAt);
      return this.getSwitch(operation.id)!;
    });
  }

  bindSubmissionToCurrentSegment(input: { conversationId: string; submissionId: string; executionSnapshotId: string; segmentId: string }): void {
    const current = this.currentSegment(input.conversationId);
    if (!current || current.id !== input.segmentId) throw new Error('提交绑定的运行分段已经不是当前分段。');
    this.db.execute(`UPDATE conversation_submissions SET execution_snapshot_id = ?, segment_id = ? WHERE id = ? AND conversation_id = ?`, [input.executionSnapshotId, input.segmentId, input.submissionId, input.conversationId]);
  }

  acceptOnCurrentSegmentDurably(input: AcceptCurrentSegmentInput): void {
    this.db.durableTransactionSync(() => {
      const segment = this.currentSegment(input.conversationId);
      if (!segment || segment.id !== input.segmentId || !segment.nativeSessionId) throw new Error('当前运行分段无法接受该提交。');
      const timelineSequence = this.nextSequence(input.conversationId, 'timeline_sequence');
      const modelHistorySequence = this.nextSequence(input.conversationId, 'model_history_sequence');
      const eventSequence = this.nextSequence(input.conversationId, 'sync_event_sequence');
      this.upsertAcceptedTurn({
        turnId: input.turnId,
        conversationId: input.conversationId,
        providerThreadId: segment.nativeSessionId,
        providerTurnId: input.providerTurnId,
        submissionId: input.submissionId,
        runtimeKind: segment.runtimeKind,
        acceptedAt: input.acceptedAt,
      });
      this.db.execute(
        `UPDATE conversation_submissions
            SET status = 'active', provider_turn_id = ?, submission_outcome = 'accepted',
                accepted_at = ?, timeline_sequence = ?, model_history_sequence = ?, updated_at = ?
          WHERE id = ? AND conversation_id = ?`,
        [input.providerTurnId, input.acceptedAt, timelineSequence, modelHistorySequence, input.acceptedAt, input.submissionId, input.conversationId],
      );
      this.db.execute(
        `INSERT INTO conversation_timeline_events
         (id, conversation_id, sequence, event_kind, turn_id, submission_id, segment_id, payload_json, occurred_at)
         VALUES (?, ?, ?, 'turn_accepted', ?, ?, ?, ?, ?)`,
        [`conversation_timeline_event_${nanoid(12)}`, input.conversationId, timelineSequence, input.turnId, input.submissionId, segment.id, JSON.stringify({ providerTurnId: input.providerTurnId, eventSequence }), input.acceptedAt],
      );
      this.db.execute(
        `INSERT INTO conversation_model_history
         (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json,
          reasoning_source_json, tool_pair_id, capability_loss_json, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'user', ?, NULL, NULL, NULL, ?)`,
        [`conversation_model_history_${nanoid(12)}`, input.conversationId, modelHistorySequence, input.turnId, input.submissionId, segment.id, JSON.stringify(input.userHistoryContent), input.acceptedAt],
      );
      this.resumeQueueBlockedByHead(input.conversationId, input.acceptedAt);
    });
  }

  markOutcomeUnknown(operationId: string, evidence: unknown, updatedAt: string): ConversationSwitchOperationRecord {
    const operation = this.requireOpenSwitch(operationId);
    this.db.execute(`UPDATE conversation_switch_operations SET state = 'outcome_unknown', failure_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(evidence), updatedAt, operation.id]);
    this.db.execute(`UPDATE conversation_submissions SET status = 'paused', paused_reason = 'outcome_unknown', submission_outcome = 'outcome_unknown', updated_at = ? WHERE id = ?`, [updatedAt, operation.submissionId]);
    this.pauseQueueBehindHead(operation.conversationId, operation.submissionId, updatedAt);
    return this.getSwitch(operation.id)!;
  }

  failBeforeProviderWrite(operationId: string, failure: unknown, updatedAt: string): ConversationSwitchOperationRecord {
    const operation = this.requireOpenSwitch(operationId);
    this.db.transaction(() => {
      this.db.execute(`UPDATE conversation_runtime_segments SET state = 'abandoned', sealed_at = ?, seal_reason = 'preflight_failed', updated_at = ? WHERE id = ? AND state = 'provisional'`, [
        updatedAt,
        updatedAt,
        operation.targetSegmentId,
      ]);
      this.db.execute(`UPDATE conversation_switch_operations SET state = 'failed', failure_json = ?, updated_at = ?, resolved_at = ? WHERE id = ?`, [JSON.stringify(failure), updatedAt, updatedAt, operation.id]);
      this.db.execute(`UPDATE conversation_submissions SET status = 'paused', paused_reason = 'preflight_failed', submission_outcome = 'paused', error_json = ?, updated_at = ? WHERE id = ?`, [
        JSON.stringify(failure),
        updatedAt,
        operation.submissionId,
      ]);
      this.pauseQueueBehindHead(operation.conversationId, operation.submissionId, updatedAt);
    });
    return this.getSwitch(operation.id)!;
  }

  rejectSwitchBeforeAcceptance(operationId: string, failure: unknown, updatedAt: string): ConversationSwitchOperationRecord {
    const operation = this.requireOpenSwitch(operationId);
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE conversation_runtime_segments
            SET state = 'abandoned', sealed_at = ?, seal_reason = 'runtime_rejected', updated_at = ?
          WHERE id = ? AND state = 'provisional'`,
        [updatedAt, updatedAt, operation.targetSegmentId],
      );
      this.db.execute(
        `UPDATE conversation_switch_operations
            SET state = 'failed', failure_json = ?, updated_at = ?, resolved_at = ?
          WHERE id = ?`,
        [JSON.stringify(failure), updatedAt, updatedAt, operation.id],
      );
      this.db.execute(
        `UPDATE conversation_submissions
            SET status = 'paused', paused_reason = 'runtime_rejected', submission_outcome = 'paused',
                error_json = ?, updated_at = ?
          WHERE id = ?`,
        [JSON.stringify(failure), updatedAt, operation.submissionId],
      );
      this.pauseQueueBehindHead(operation.conversationId, operation.submissionId, updatedAt);
    });
    return this.getSwitch(operation.id)!;
  }

  markCurrentSubmissionOutcomeUnknown(conversationId: string, submissionId: string, evidence: unknown, updatedAt: string): void {
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE conversation_submissions
            SET status = 'paused', paused_reason = 'outcome_unknown', submission_outcome = 'outcome_unknown',
                error_json = ?, updated_at = ?
          WHERE id = ? AND conversation_id = ? AND provider_turn_id IS NULL`,
        [JSON.stringify(evidence), updatedAt, submissionId, conversationId],
      );
      this.pauseQueueBehindHead(conversationId, submissionId, updatedAt);
    });
  }

  pauseCurrentSubmissionBeforeProviderWrite(conversationId: string, submissionId: string, failure: unknown, updatedAt: string): void {
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE conversation_submissions
            SET status = 'paused', paused_reason = 'preflight_failed', submission_outcome = 'paused',
                error_json = ?, updated_at = ?
          WHERE id = ? AND conversation_id = ? AND provider_turn_id IS NULL`,
        [JSON.stringify(failure), updatedAt, submissionId, conversationId],
      );
      this.pauseQueueBehindHead(conversationId, submissionId, updatedAt);
    });
  }

  rejectCurrentSubmissionBeforeAcceptance(conversationId: string, submissionId: string, failure: unknown, updatedAt: string): void {
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE conversation_submissions
            SET status = 'paused', paused_reason = 'runtime_rejected', submission_outcome = 'paused',
                error_json = ?, updated_at = ?
          WHERE id = ? AND conversation_id = ? AND provider_turn_id IS NULL`,
        [JSON.stringify(failure), updatedAt, submissionId, conversationId],
      );
      this.pauseQueueBehindHead(conversationId, submissionId, updatedAt);
    });
  }

  currentSegment(conversationId: string): ConversationRuntimeSegmentRecord | null {
    const row = this.db.get<RuntimeSegmentRow>(`SELECT * FROM conversation_runtime_segments WHERE conversation_id = ? AND state = 'current'`, [conversationId]);
    return row ? mapRuntimeSegment(row) : null;
  }

  provisionalSegment(conversationId: string): ConversationRuntimeSegmentRecord | null {
    const row = this.db.get<RuntimeSegmentRow>(`SELECT * FROM conversation_runtime_segments WHERE conversation_id = ? AND state = 'provisional'`, [conversationId]);
    return row ? mapRuntimeSegment(row) : null;
  }

  segmentById(segmentId: string): ConversationRuntimeSegmentRecord | undefined {
    const row = this.db.get<RuntimeSegmentRow>(`SELECT * FROM conversation_runtime_segments WHERE id = ?`, [segmentId]);
    return row ? mapRuntimeSegment(row) : undefined;
  }

  segmentByNativeSession(nativeSessionId: string, conversationId?: string): ConversationRuntimeSegmentRecord | undefined {
    const row = conversationId
      ? this.db.get<RuntimeSegmentRow>(`SELECT * FROM conversation_runtime_segments WHERE native_session_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT 1`, [nativeSessionId, conversationId])
      : this.db.get<RuntimeSegmentRow>(`SELECT * FROM conversation_runtime_segments WHERE native_session_id = ? ORDER BY created_at DESC LIMIT 1`, [nativeSessionId]);
    return row ? mapRuntimeSegment(row) : undefined;
  }

  listSegments(conversationId: string): ConversationRuntimeSegmentRecord[] {
    return this.db.select<RuntimeSegmentRow>(`SELECT * FROM conversation_runtime_segments WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapRuntimeSegment);
  }

  listOpenSwitchOperations(): ConversationSwitchOperationRecord[] {
    return this.db.select<SwitchOperationRow>(`SELECT * FROM conversation_switch_operations WHERE state IN ('preflight', 'provisional', 'outcome_unknown') ORDER BY created_at, id`).map(mapSwitchOperation);
  }

  recordRecoveryEvent(input: { conversationId: string; segmentId?: string | null; eventKind: string; payload: unknown; occurredAt: string }): string {
    const id = `conversation_recovery_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_recovery_events
       (id, conversation_id, segment_id, event_kind, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.conversationId, input.segmentId ?? null, input.eventKind, JSON.stringify(input.payload), input.occurredAt],
    );
    return id;
  }

  getSwitch(operationId: string): ConversationSwitchOperationRecord | undefined {
    const row = this.db.get<SwitchOperationRow>(`SELECT * FROM conversation_switch_operations WHERE id = ?`, [operationId]);
    return row ? mapSwitchOperation(row) : undefined;
  }

  getSwitchBySubmission(submissionId: string): ConversationSwitchOperationRecord | undefined {
    const row = this.db.get<SwitchOperationRow>(`SELECT * FROM conversation_switch_operations WHERE submission_id = ?`, [submissionId]);
    return row ? mapSwitchOperation(row) : undefined;
  }

  appendModelHistory(input: {
    conversationId: string;
    turnId: string;
    segmentId: string;
    role: 'assistant' | 'tool';
    content: unknown;
    submissionId?: string | null;
    reasoningSource?: unknown;
    toolPairId?: string | null;
    capabilityLoss?: unknown;
    confirmedAt: string;
  }): ConversationModelHistoryRecord {
    const sequence = this.nextSequence(input.conversationId, 'model_history_sequence');
    const id = `conversation_model_history_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_model_history
       (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json,
        reasoning_source_json, tool_pair_id, capability_loss_json, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.conversationId,
        sequence,
        input.turnId,
        input.submissionId ?? null,
        input.segmentId,
        input.role,
        JSON.stringify(input.content),
        input.reasoningSource === undefined ? null : JSON.stringify(input.reasoningSource),
        input.toolPairId ?? null,
        input.capabilityLoss === undefined ? null : JSON.stringify(input.capabilityLoss),
        input.confirmedAt,
      ],
    );
    return this.modelHistoryById(id)!;
  }

  confirmedModelHistory(conversationId: string, throughSequence?: number): ConversationModelHistoryRecord[] {
    const clause = throughSequence === undefined ? '' : ' AND sequence <= ?';
    const params = throughSequence === undefined ? [conversationId] : [conversationId, throughSequence];
    return this.db.select<ModelHistoryRow>(`SELECT * FROM conversation_model_history WHERE conversation_id = ?${clause} ORDER BY sequence`, params).map(mapModelHistory);
  }

  recordPortableContext(input: {
    conversationId: string;
    throughModelHistorySequence: number;
    targetExecutionSnapshotId: string;
    status: 'ready' | 'compacting' | 'compacted' | 'failed';
    content: unknown;
    capabilityLosses: unknown;
    estimatedInputTokens: number | null;
    occurredAt: string;
  }): string {
    const id = `conversation_portable_context_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_portable_contexts
       (id, conversation_id, through_model_history_sequence, target_execution_snapshot_id, status,
        content_json, capability_loss_json, estimated_input_tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.conversationId,
        input.throughModelHistorySequence,
        input.targetExecutionSnapshotId,
        input.status,
        JSON.stringify(input.content),
        JSON.stringify(input.capabilityLosses),
        input.estimatedInputTokens,
        input.occurredAt,
        input.occurredAt,
      ],
    );
    return id;
  }

  updatePortableContext(input: { id: string; status: 'ready' | 'compacting' | 'compacted' | 'failed'; content: unknown; updatedAt: string }): void {
    this.db.execute(`UPDATE conversation_portable_contexts SET status = ?, content_json = ?, updated_at = ? WHERE id = ?`, [input.status, JSON.stringify(input.content), input.updatedAt, input.id]);
  }

  recordContextCheckpoint(input: {
    conversationId: string;
    portableContextId: string;
    routeFingerprint: string;
    throughModelHistorySequence: number;
    requestUsageId: string | null;
    summary: unknown;
    status: 'completed' | 'failed';
    occurredAt: string;
  }): string {
    const existing = this.db.get<{ id: string }>(
      `SELECT id FROM conversation_context_checkpoints
        WHERE conversation_id = ? AND route_fingerprint = ? AND through_model_history_sequence = ?`,
      [input.conversationId, input.routeFingerprint, input.throughModelHistorySequence],
    );
    const id = existing?.id ?? `conversation_context_checkpoint_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_context_checkpoints
       (id, conversation_id, portable_context_id, route_fingerprint, through_model_history_sequence,
        request_usage_id, summary_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, route_fingerprint, through_model_history_sequence) DO UPDATE SET
         portable_context_id = excluded.portable_context_id,
         request_usage_id = excluded.request_usage_id,
         summary_json = excluded.summary_json,
         status = excluded.status,
         updated_at = excluded.updated_at`,
      [id, input.conversationId, input.portableContextId, input.routeFingerprint, input.throughModelHistorySequence, input.requestUsageId, JSON.stringify(input.summary), input.status, input.occurredAt, input.occurredAt],
    );
    return id;
  }

  appendProcessItem(input: {
    conversationId: string;
    turnId: string;
    segmentId: string;
    kind: ConversationProcessKind;
    status: 'in_progress' | 'completed' | 'failed';
    title: string;
    detail: unknown;
    sourceEventId?: string | null;
    startedAt: string;
    completedAt?: string | null;
  }): ConversationProcessItemRecord {
    const existing = input.sourceEventId ? this.db.get<ProcessItemRow>(`SELECT * FROM conversation_process_items WHERE segment_id = ? AND source_event_id = ?`, [input.segmentId, input.sourceEventId]) : undefined;
    if (existing) {
      this.db.execute(
        `UPDATE conversation_process_items
            SET status = ?, title = ?, detail_json = ?, completed_at = COALESCE(?, completed_at)
          WHERE id = ?`,
        [input.status, input.title, JSON.stringify(input.detail), input.completedAt ?? null, existing.id],
      );
      return this.processItemById(existing.id)!;
    }
    const processSequence = this.nextSequence(input.conversationId, 'process_sequence');
    const id = `conversation_process_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_process_items
       (id, conversation_id, turn_id, segment_id, process_sequence, kind, status, title,
        detail_json, source_event_id, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.conversationId, input.turnId, input.segmentId, processSequence, input.kind, input.status, input.title, JSON.stringify(input.detail), input.sourceEventId ?? null, input.startedAt, input.completedAt ?? null],
    );
    return this.processItemById(id)!;
  }

  recordToolResult(input: ConversationToolResultRecord): ConversationToolResultRecord {
    const existing = this.getToolResult(input.handle);
    if (existing) {
      if (existing.conversationId !== input.conversationId || existing.sha256 !== input.sha256 || existing.relativePath !== input.relativePath) {
        throw new Error(`工具结果句柄发生身份冲突：${input.handle}`);
      }
      return existing;
    }
    this.db.execute(
      `INSERT INTO conversation_tool_results
       (handle, conversation_id, turn_id, segment_id, tool_pair_id, relative_path, sha256,
        byte_length, mime_type, projection_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.handle, input.conversationId, input.turnId, input.segmentId, input.toolPairId, input.relativePath, input.sha256, input.byteLength, input.mimeType, input.projectionJson, input.createdAt],
    );
    return this.getToolResult(input.handle)!;
  }

  getToolResult(handle: string): ConversationToolResultRecord | undefined {
    const row = this.db.get<ToolResultRow>(`SELECT * FROM conversation_tool_results WHERE handle = ?`, [handle]);
    return row ? mapToolResult(row) : undefined;
  }

  observeModelRequest(input: Omit<ConversationModelRequestUsageRecord, 'id' | 'requestSequence'> & { observationIdentity?: string }): ConversationModelRequestUsageRecord {
    const id = input.observationIdentity ? `conversation_model_request_${createHash('sha256').update(`${input.conversationId}\0${input.observationIdentity}`).digest('hex').slice(0, 24)}` : `conversation_model_request_${nanoid(12)}`;
    const existing = this.modelRequestById(id);
    if (existing) return existing;
    const requestSequence = this.nextSequence(input.conversationId, 'model_request_sequence');
    this.db.execute(
      `INSERT INTO conversation_model_requests
       (id, conversation_id, turn_id, segment_id, request_kind, request_sequence, model_id,
        context_window, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
        reasoning_output_tokens, total_tokens, estimated_usd, usage_complete, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.conversationId,
        input.turnId,
        input.segmentId,
        input.requestKind,
        requestSequence,
        input.modelId,
        input.contextWindow,
        input.inputTokens,
        input.cachedInputTokens,
        input.cacheWriteInputTokens,
        input.outputTokens,
        input.reasoningOutputTokens,
        input.totalTokens,
        input.estimatedUsd,
        input.usageComplete ? 1 : 0,
        input.occurredAt,
      ],
    );
    return this.modelRequestById(id)!;
  }

  /** 读取同一产品轮次已经确认的真实模型请求，供 Provider 的增量用量事件恢复请求边界。 */
  listModelRequestsForTurn(conversationId: string, turnId: string): ConversationModelRequestUsageRecord[] {
    return this.db.select<ModelRequestRow>(`SELECT * FROM conversation_model_requests WHERE conversation_id = ? AND turn_id = ? ORDER BY request_sequence`, [conversationId, turnId]).map(mapModelRequest);
  }

  appendConfigEvidence(input: {
    conversationId: string;
    turnId?: string | null;
    submissionId?: string | null;
    segmentId?: string | null;
    layer: ConversationConfigEvidenceLayer;
    configuration: unknown;
    evidence: unknown;
    mismatch?: boolean;
    observedAt: string;
  }): string {
    const id = `conversation_config_evidence_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_config_evidence
       (id, conversation_id, turn_id, submission_id, segment_id, layer, configuration_json,
        evidence_json, mismatch, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.conversationId, input.turnId ?? null, input.submissionId ?? null, input.segmentId ?? null, input.layer, JSON.stringify(input.configuration), JSON.stringify(input.evidence), input.mismatch ? 1 : 0, input.observedAt],
    );
    return id;
  }

  persistWarning(input: { conversationId: string; warningKind: string; payload: unknown; occurredAt: string }): ConversationPersistentWarningRecord {
    const sequence = this.nextSequence(input.conversationId, 'sync_event_sequence');
    const existing = this.db.get<PersistentWarningRow>(`SELECT * FROM conversation_persistent_warnings WHERE conversation_id = ? AND warning_kind = ? AND resolved_at IS NULL`, [input.conversationId, input.warningKind]);
    if (existing) {
      this.db.execute(`UPDATE conversation_persistent_warnings SET payload_json = ?, last_event_seq = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(input.payload), sequence, input.occurredAt, existing.id]);
      return this.warningById(existing.id)!;
    }
    const id = `conversation_warning_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_persistent_warnings
       (id, conversation_id, warning_kind, payload_json, first_event_seq, last_event_seq, created_at, updated_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [id, input.conversationId, input.warningKind, JSON.stringify(input.payload), sequence, sequence, input.occurredAt, input.occurredAt],
    );
    return this.warningById(id)!;
  }

  nextSyncEventSequence(conversationId: string): number {
    return this.nextSequence(conversationId, 'sync_event_sequence');
  }

  pauseQueuedAfterConfigurationMismatch(conversationId: string, acceptedSubmissionId: string, evidence: unknown, occurredAt: string): void {
    this.db.execute(
      `UPDATE conversation_submissions
          SET status = 'paused', paused_reason = 'configuration_mismatch', submission_outcome = 'paused', updated_at = ?
        WHERE conversation_id = ? AND id <> ? AND status = 'queued'`,
      [occurredAt, conversationId, acceptedSubmissionId],
    );
    this.persistWarning({ conversationId, warningKind: 'configuration_mismatch', payload: evidence, occurredAt });
  }

  pauseQueueBehindHead(conversationId: string, headSubmissionId: string, occurredAt: string): void {
    this.db.execute(
      `UPDATE conversation_submissions
          SET status = 'paused', paused_reason = 'blocked_by_head', submission_outcome = 'paused', updated_at = ?
        WHERE conversation_id = ? AND id <> ? AND status = 'queued' AND provider_turn_id IS NULL`,
      [occurredAt, conversationId, headSubmissionId],
    );
  }

  resumeQueueBlockedByHead(conversationId: string, occurredAt: string): void {
    this.db.execute(
      `UPDATE conversation_submissions
          SET status = 'queued', paused_reason = NULL, submission_outcome = 'queued', updated_at = ?
        WHERE conversation_id = ? AND status = 'paused' AND paused_reason = 'blocked_by_head' AND provider_turn_id IS NULL`,
      [occurredAt, conversationId],
    );
  }

  snapshot(conversationId: string, turnId?: string | null): ConversationUnifiedSnapshot {
    const latest = this.db.get<ModelRequestRow>(`SELECT * FROM conversation_model_requests WHERE conversation_id = ? ORDER BY request_sequence DESC LIMIT 1`, [conversationId]);
    return {
      conversationSchemaGeneration,
      throughEventSeq: this.db.get<{ sync_event_sequence: number }>(`SELECT sync_event_sequence FROM conversation_sequence_counters WHERE conversation_id = ?`, [conversationId])?.sync_event_sequence ?? 0,
      currentSegment: this.currentSegment(conversationId),
      segments: this.listSegments(conversationId),
      executionSnapshots: this.db.select<ExecutionSnapshotRow>(`SELECT * FROM conversation_execution_snapshots WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapExecutionSnapshot),
      modelHistory: this.confirmedModelHistory(conversationId),
      process: this.db.select<ProcessItemRow>(`SELECT * FROM conversation_process_items WHERE conversation_id = ? ORDER BY process_sequence`, [conversationId]).map(mapProcessItem),
      usage: {
        conversationTotal: aggregateUsage(this.db.select<ModelRequestRow>(`SELECT * FROM conversation_model_requests WHERE conversation_id = ? ORDER BY request_sequence`, [conversationId])),
        turnTotal: turnId ? aggregateUsage(this.db.select<ModelRequestRow>(`SELECT * FROM conversation_model_requests WHERE conversation_id = ? AND turn_id = ? ORDER BY request_sequence`, [conversationId, turnId])) : emptyNullableUsage(),
        latestModelRequest: latest ? mapModelRequest(latest) : null,
        preflightEstimate: null,
      },
      warnings: this.db.select<PersistentWarningRow>(`SELECT * FROM conversation_persistent_warnings WHERE conversation_id = ? AND resolved_at IS NULL ORDER BY first_event_seq`, [conversationId]).map(mapPersistentWarning),
      configurationEvidence: this.db.select<ConfigEvidenceRow>(`SELECT * FROM conversation_config_evidence WHERE conversation_id = ? ORDER BY observed_at, id`, [conversationId]).map(mapConfigEvidence),
    };
  }

  private requireOpenSwitch(operationId: string): ConversationSwitchOperationRecord {
    const operation = this.getSwitch(operationId);
    if (!operation || !isOpenSwitch(operation)) throw new Error(`运行分段切换操作不可继续：${operationId}`);
    return operation;
  }

  private openSwitchByConversation(conversationId: string): ConversationSwitchOperationRecord | undefined {
    const row = this.db.get<SwitchOperationRow>(
      `SELECT * FROM conversation_switch_operations
        WHERE conversation_id = ? AND state IN ('preflight', 'provisional', 'outcome_unknown')
        ORDER BY created_at, id
        LIMIT 1`,
      [conversationId],
    );
    return row ? mapSwitchOperation(row) : undefined;
  }

  private reconcileSwitchSlot(conversationId: string, occurredAt: string, allowedSubmissionId?: string): void {
    const openSwitch = this.openSwitchByConversation(conversationId);
    if (openSwitch) {
      if (openSwitch.submissionId === allowedSubmissionId) return;
      const owner = this.db.get<{ status: string }>(`SELECT status FROM conversation_submissions WHERE id = ? AND conversation_id = ?`, [openSwitch.submissionId, conversationId]);
      if (owner && (owner.status === 'cancelled' || owner.status === 'deleted')) {
        this.cancelOpenSwitch(openSwitch, 'terminal_submission_recovery', occurredAt);
      } else {
        throw conversationSwitchBusyError(conversationId);
      }
    }
    const staleProvisional = this.provisionalSegment(conversationId);
    if (!staleProvisional) return;
    const owner = staleProvisional.provisionalForSubmissionId
      ? this.db.get<{ status: string }>(`SELECT status FROM conversation_submissions WHERE id = ? AND conversation_id = ?`, [staleProvisional.provisionalForSubmissionId, conversationId])
      : undefined;
    if (!owner || (owner.status !== 'cancelled' && owner.status !== 'deleted')) throw conversationSwitchBusyError(conversationId);
    this.db.execute(
      `UPDATE conversation_runtime_segments
          SET state = 'abandoned', sealed_at = ?, seal_reason = 'terminal_submission_recovery', updated_at = ?
        WHERE id = ? AND state = 'provisional'`,
      [occurredAt, occurredAt, staleProvisional.id],
    );
  }

  private cancelOpenSwitch(operation: ConversationSwitchOperationRecord, reason: 'submission_deleted' | 'submission_cancelled' | 'terminal_submission_recovery', occurredAt: string): void {
    const target = this.segmentById(operation.targetSegmentId);
    if (!target || target.conversationId !== operation.conversationId || (target.state !== 'provisional' && target.state !== 'abandoned')) {
      throw Object.assign(new Error('开放切换的候选运行分段状态不一致，不能安全取消。'), { code: 'ZEUS_CONVERSATION_SWITCH_STATE_CONFLICT' as const });
    }
    if (target.state === 'provisional') {
      this.db.execute(
        `UPDATE conversation_runtime_segments
            SET state = 'abandoned', sealed_at = ?, seal_reason = ?, updated_at = ?
          WHERE id = ? AND state = 'provisional'`,
        [occurredAt, reason, occurredAt, target.id],
      );
    }
    this.db.execute(
      `UPDATE conversation_switch_operations
          SET state = 'cancelled', failure_json = ?, updated_at = ?, resolved_at = ?
        WHERE id = ? AND state IN ('preflight', 'provisional', 'outcome_unknown')`,
      [JSON.stringify({ code: 'ZEUS_CONVERSATION_SWITCH_CANCELLED', reason }), occurredAt, occurredAt, operation.id],
    );
  }

  private nextSequence(conversationId: string, column: 'timeline_sequence' | 'model_history_sequence' | 'sync_event_sequence' | 'process_sequence' | 'model_request_sequence'): number {
    this.db.execute(`INSERT OR IGNORE INTO conversation_sequence_counters (conversation_id) VALUES (?)`, [conversationId]);
    this.db.execute(`UPDATE conversation_sequence_counters SET ${column} = ${column} + 1 WHERE conversation_id = ?`, [conversationId]);
    return this.db.get<Record<typeof column, number>>(`SELECT ${column} FROM conversation_sequence_counters WHERE conversation_id = ?`, [conversationId])![column];
  }

  private projectCurrentSegmentToLegacyConversation(segment: ConversationRuntimeSegmentRecord, updatedAt: string): void {
    const snapshot = segment.executionSnapshotId ? this.getExecutionSnapshot(segment.executionSnapshotId) : undefined;
    this.db.execute(
      `UPDATE conversations
          SET provider_id = ?, provider_thread_id = ?, provider_thread_path = ?, provider_model = ?,
              provider_state = 'active', provider_protocol_version = ?, provider_binary_version = ?,
              agent_kind = ?, agent_transport = ?, model_source_id = ?, model_id = ?,
              native_session_id = ?, native_session_path = ?, permission_mode = COALESCE(?, permission_mode),
              collaboration_mode = COALESCE(?, collaboration_mode), updated_at = ?
        WHERE id = ?`,
      [
        segment.providerId,
        segment.nativeSessionId,
        segment.nativeSessionPath,
        segment.providerModel ?? snapshot?.modelId ?? null,
        segment.providerProtocolVersion,
        segment.providerBinaryVersion,
        segment.runtimeKind,
        segment.runtimeKind === 'codex' ? 'app_server' : 'sdk',
        snapshot?.connectionId ?? null,
        snapshot?.modelId ?? segment.providerModel,
        segment.nativeSessionId,
        segment.nativeSessionPath,
        snapshot?.permissionMode ?? null,
        snapshot?.collaborationMode ?? null,
        updatedAt,
        segment.conversationId,
      ],
    );
  }

  private upsertAcceptedTurn(input: { turnId: string; conversationId: string; providerThreadId: string; providerTurnId: string; submissionId: string; runtimeKind: ConversationRuntimeKind; acceptedAt: string }): void {
    this.db.execute(
      `INSERT INTO conversation_turns
       (id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status,
        error_json, plan_json, started_at, completed_at, created_at, updated_at, agent_kind, native_run_id)
       VALUES (?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT(provider_thread_id, provider_turn_id) WHERE provider_turn_id IS NOT NULL DO UPDATE SET
         client_submission_id = excluded.client_submission_id, status = 'running', started_at = COALESCE(conversation_turns.started_at, excluded.started_at),
         completed_at = NULL, updated_at = excluded.updated_at, agent_kind = excluded.agent_kind, native_run_id = excluded.native_run_id`,
      [input.turnId, input.conversationId, input.providerThreadId, input.providerTurnId, input.submissionId, input.acceptedAt, input.acceptedAt, input.acceptedAt, input.runtimeKind, input.providerTurnId],
    );
  }

  private modelHistoryById(id: string): ConversationModelHistoryRecord | undefined {
    const row = this.db.get<ModelHistoryRow>(`SELECT * FROM conversation_model_history WHERE id = ?`, [id]);
    return row ? mapModelHistory(row) : undefined;
  }

  private processItemById(id: string): ConversationProcessItemRecord | undefined {
    const row = this.db.get<ProcessItemRow>(`SELECT * FROM conversation_process_items WHERE id = ?`, [id]);
    return row ? mapProcessItem(row) : undefined;
  }

  private modelRequestById(id: string): ConversationModelRequestUsageRecord | undefined {
    const row = this.db.get<ModelRequestRow>(`SELECT * FROM conversation_model_requests WHERE id = ?`, [id]);
    return row ? mapModelRequest(row) : undefined;
  }

  private warningById(id: string): ConversationPersistentWarningRecord | undefined {
    const row = this.db.get<PersistentWarningRow>(`SELECT * FROM conversation_persistent_warnings WHERE id = ?`, [id]);
    return row ? mapPersistentWarning(row) : undefined;
  }
}

function sealLegacyProviderSessions(db: ZeusDatabase, migratedAt: string): void {
  const rows = db.select<{
    id: string;
    agent_kind: string | null;
    provider_id: string | null;
    provider_thread_id: string | null;
    provider_thread_path: string | null;
    provider_model: string | null;
    provider_protocol_version: string | null;
    provider_binary_version: string | null;
    native_session_path: string | null;
    created_at: string;
  }>(
    `SELECT id, agent_kind, provider_id, provider_thread_id, provider_thread_path, provider_model,
            provider_protocol_version, provider_binary_version, native_session_path, created_at
       FROM conversations
      WHERE provider_thread_id IS NOT NULL AND agent_kind IN ('codex', 'pi')
      ORDER BY created_at, id`,
  );
  for (const row of rows) {
    const segmentId = `conversation_segment_${nanoid(12)}`;
    const sourceIdentity = `${row.agent_kind}:${row.provider_thread_id}`;
    db.execute(
      `INSERT INTO conversation_runtime_segments
       (id, conversation_id, runtime_kind, state, execution_snapshot_id, provider_id,
        native_session_id, native_session_path, provider_model, provider_protocol_version,
        provider_binary_version, provisional_for_submission_id, opened_at, accepted_at,
        sealed_at, seal_reason, created_at, updated_at)
       VALUES (?, ?, ?, 'sealed', NULL, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 'upgrade_sealed', ?, ?)`,
      [
        segmentId,
        row.id,
        row.agent_kind,
        row.provider_id,
        row.provider_thread_id,
        row.provider_thread_path,
        row.provider_model,
        row.provider_protocol_version,
        row.provider_binary_version,
        row.created_at,
        migratedAt,
        row.created_at,
        migratedAt,
      ],
    );
    db.execute(
      `INSERT INTO conversation_migration_mappings
       (id, conversation_id, source_kind, source_identity, target_kind, target_identity, source_hash, mapped_at)
       VALUES (?, ?, 'provider_session', ?, 'sealed_segment', ?, ?, ?)`,
      [`conversation_migration_mapping_${nanoid(12)}`, row.id, sourceIdentity, segmentId, createHash('sha256').update(JSON.stringify(row)).digest('hex'), migratedAt],
    );
    if (row.agent_kind === 'pi') inspectPiMigrationSource(db, row.id, row.native_session_path ?? row.provider_thread_path, migratedAt);
  }
}

function migrateLegacyConversationHistory(db: ZeusDatabase, migratedAt: string): void {
  const messages = db.select<{
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    source: string;
    provider_turn_id: string | null;
    created_at: string;
  }>(
    `SELECT id, conversation_id, role, content, source, provider_turn_id, created_at
       FROM conversation_messages
      WHERE role IN ('user', 'assistant')
      ORDER BY conversation_id, created_at, id`,
  );
  for (const message of messages) {
    const segment = db.get<{ id: string }>(`SELECT id FROM conversation_runtime_segments WHERE conversation_id = ? AND state = 'sealed' ORDER BY created_at DESC LIMIT 1`, [message.conversation_id]);
    if (!segment) continue;
    const mapped = db.get<{ present: number }>(`SELECT 1 AS present FROM conversation_migration_mappings WHERE source_kind = 'conversation_message' AND source_identity = ? AND target_kind = 'model_history'`, [message.id]);
    if (mapped) continue;
    const turn = message.provider_turn_id
      ? db.get<{ id: string }>(`SELECT id FROM conversation_turns WHERE conversation_id = ? AND provider_turn_id = ? ORDER BY created_at LIMIT 1`, [message.conversation_id, message.provider_turn_id])
      : undefined;
    const turnId =
      turn?.id ??
      `migration_turn_${createHash('sha256')
        .update(`${message.conversation_id}\0${message.provider_turn_id ?? message.id}`)
        .digest('hex')
        .slice(0, 24)}`;
    const sequence = nextMigrationSequence(db, message.conversation_id, 'model_history_sequence');
    const historyId = `conversation_model_history_${nanoid(12)}`;
    db.execute(
      `INSERT INTO conversation_model_history
       (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json,
        reasoning_source_json, tool_pair_id, capability_loss_json, confirmed_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?)`,
      [historyId, message.conversation_id, sequence, turnId, segment.id, message.role, JSON.stringify({ text: message.content, source: message.source, migratedFromMessageId: message.id }), message.created_at],
    );
    db.execute(
      `INSERT INTO conversation_migration_mappings
       (id, conversation_id, source_kind, source_identity, target_kind, target_identity, source_hash, mapped_at)
       VALUES (?, ?, 'conversation_message', ?, 'model_history', ?, ?, ?)`,
      [`conversation_migration_mapping_${nanoid(12)}`, message.conversation_id, message.id, historyId, createHash('sha256').update(JSON.stringify(message)).digest('hex'), migratedAt],
    );
  }

  const items = db.select<{
    id: string;
    conversation_id: string;
    turn_id: string;
    provider_item_id: string;
    item_type: string;
    status: string;
    text_content: string;
    payload_json: string;
    completed_at: string | null;
    updated_at: string;
  }>(
    `SELECT id, conversation_id, turn_id, provider_item_id, item_type, status, text_content,
            payload_json, completed_at, updated_at
       FROM conversation_items
      WHERE item_type IN ('reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'contextCompaction')
      ORDER BY conversation_id, updated_at, id`,
  );
  for (const item of items) {
    const segment = db.get<{ id: string }>(`SELECT id FROM conversation_runtime_segments WHERE conversation_id = ? AND state = 'sealed' ORDER BY created_at DESC LIMIT 1`, [item.conversation_id]);
    if (!segment) continue;
    const kind: ConversationProcessKind = item.item_type === 'reasoning' ? 'reasoning' : item.item_type === 'commandExecution' ? 'command' : item.item_type === 'contextCompaction' ? 'context_compaction' : 'tool';
    const processSequence = nextMigrationSequence(db, item.conversation_id, 'process_sequence');
    db.execute(
      `INSERT OR IGNORE INTO conversation_process_items
       (id, conversation_id, turn_id, segment_id, process_sequence, kind, status, title,
        detail_json, source_event_id, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `conversation_process_${nanoid(12)}`,
        item.conversation_id,
        item.turn_id,
        segment.id,
        processSequence,
        kind,
        item.status === 'in_progress' ? 'failed' : item.status,
        kind === 'reasoning' ? '思考摘要' : kind === 'command' ? '执行命令' : kind === 'context_compaction' ? '上下文压缩' : '调用工具',
        JSON.stringify({ payload: safeJson(item.payload_json), text: item.text_content, migratedFromItemId: item.id, ...(item.status === 'in_progress' ? { interrupted: true } : {}) }),
        `migration:item:${item.id}`,
        item.updated_at,
        item.completed_at ?? item.updated_at,
      ],
    );
    if (kind === 'reasoning' && item.text_content.trim()) {
      const sequence = nextMigrationSequence(db, item.conversation_id, 'model_history_sequence');
      db.execute(
        `INSERT INTO conversation_model_history
         (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json,
          reasoning_source_json, tool_pair_id, capability_loss_json, confirmed_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'assistant', ?, ?, NULL, NULL, ?)`,
        [
          `conversation_model_history_${nanoid(12)}`,
          item.conversation_id,
          sequence,
          item.turn_id,
          segment.id,
          JSON.stringify({ text: item.text_content, provenance: '迁移的可读思考摘要' }),
          JSON.stringify({ providerItemId: item.provider_item_id, readableSummary: true }),
          item.completed_at ?? item.updated_at,
        ],
      );
    } else if (kind === 'tool' || kind === 'command') {
      const callSequence = nextMigrationSequence(db, item.conversation_id, 'model_history_sequence');
      db.execute(
        `INSERT INTO conversation_model_history
         (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json,
          reasoning_source_json, tool_pair_id, capability_loss_json, confirmed_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'assistant', ?, NULL, ?, NULL, ?)`,
        [
          `conversation_model_history_${nanoid(12)}`,
          item.conversation_id,
          callSequence,
          item.turn_id,
          segment.id,
          JSON.stringify({ type: 'tool_call', itemType: item.item_type, payload: safeJson(item.payload_json) }),
          item.provider_item_id,
          item.updated_at,
        ],
      );
      const sequence = nextMigrationSequence(db, item.conversation_id, 'model_history_sequence');
      const resultText = item.status === 'in_progress' ? `工具调用在升级前未闭合，Zeus 已生成明确的中断结果。\n${item.text_content}` : item.text_content || item.payload_json;
      db.execute(
        `INSERT INTO conversation_model_history
         (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json,
          reasoning_source_json, tool_pair_id, capability_loss_json, confirmed_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'tool', ?, NULL, ?, NULL, ?)`,
        [`conversation_model_history_${nanoid(12)}`, item.conversation_id, sequence, item.turn_id, segment.id, JSON.stringify({ text: resultText, migratedFromItemId: item.id }), item.provider_item_id, item.completed_at ?? item.updated_at],
      );
    }
  }
}

function inspectPiMigrationSource(db: ZeusDatabase, conversationId: string, sessionPath: string | null, migratedAt: string): void {
  let warning: Record<string, unknown> | null = null;
  if (!sessionPath || !existsSync(sessionPath)) warning = { sessionPath, reason: 'missing_pi_jsonl' };
  else {
    try {
      const lines = readFileSync(sessionPath, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const [index, line] of lines.entries()) {
        try {
          JSON.parse(line);
        } catch {
          warning = { sessionPath, reason: 'corrupt_pi_jsonl', line: index + 1 };
          break;
        }
      }
    } catch (error) {
      warning = { sessionPath, reason: 'unreadable_pi_jsonl', message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!warning) return;
  const sequence = nextMigrationSequence(db, conversationId, 'sync_event_sequence');
  db.execute(
    `INSERT INTO conversation_persistent_warnings
     (id, conversation_id, warning_kind, payload_json, first_event_seq, last_event_seq, created_at, updated_at, resolved_at)
     VALUES (?, ?, 'provider_history_gap', ?, ?, ?, ?, ?, NULL)`,
    [`conversation_warning_${nanoid(12)}`, conversationId, JSON.stringify(warning), sequence, sequence, migratedAt, migratedAt],
  );
}

function nextMigrationSequence(db: ZeusDatabase, conversationId: string, column: 'model_history_sequence' | 'process_sequence' | 'sync_event_sequence'): number {
  db.execute(`INSERT OR IGNORE INTO conversation_sequence_counters (conversation_id) VALUES (?)`, [conversationId]);
  db.execute(`UPDATE conversation_sequence_counters SET ${column} = ${column} + 1 WHERE conversation_id = ?`, [conversationId]);
  return db.get<Record<typeof column, number>>(`SELECT ${column} FROM conversation_sequence_counters WHERE conversation_id = ?`, [conversationId])![column];
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function migrationManifest(db: ZeusDatabase): string {
  const payload = {
    conversations: db.countRows('conversations'),
    sealedSegments: db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM conversation_runtime_segments WHERE state = 'sealed'`)?.count ?? 0,
    submissions: db.countRows('conversation_submissions'),
    mappings: db.countRows('conversation_migration_mappings'),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function addColumn(db: ZeusDatabase, table: string, column: string, definition: string): void {
  const exists = db.select<{ name: string }>(`PRAGMA table_info(${table})`).some((row) => row.name === column);
  if (!exists) db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

interface ExecutionSnapshotRow {
  id: string;
  conversation_id: string;
  runtime_kind: ConversationRuntimeKind;
  connection_id: string | null;
  credential_slot_id: string | null;
  endpoint_identity: string;
  protocol_family: string;
  model_id: string;
  effort: string | null;
  service_tier: string | null;
  permission_mode: string;
  collaboration_mode: string;
  workspace_identity_json: string;
  route_fingerprint: string;
  created_at: string;
}

interface RuntimeSegmentRow {
  id: string;
  conversation_id: string;
  runtime_kind: ConversationRuntimeKind;
  state: ConversationSegmentState;
  execution_snapshot_id: string | null;
  provider_id: string | null;
  native_session_id: string | null;
  native_session_path: string | null;
  provider_model: string | null;
  provider_protocol_version: string | null;
  provider_binary_version: string | null;
  provisional_for_submission_id: string | null;
  opened_at: string;
  accepted_at: string | null;
  sealed_at: string | null;
  seal_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface SwitchOperationRow {
  id: string;
  conversation_id: string;
  submission_id: string;
  source_segment_id: string | null;
  target_segment_id: string;
  state: ConversationSwitchState;
  acceptance_evidence_json: string | null;
  failure_json: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface ModelHistoryRow {
  id: string;
  conversation_id: string;
  sequence: number;
  turn_id: string;
  submission_id: string | null;
  segment_id: string;
  role: 'user' | 'assistant' | 'tool';
  content_json: string;
  reasoning_source_json: string | null;
  tool_pair_id: string | null;
  capability_loss_json: string | null;
  confirmed_at: string;
}

interface ProcessItemRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  segment_id: string;
  process_sequence: number;
  kind: ConversationProcessKind;
  status: 'in_progress' | 'completed' | 'failed';
  title: string;
  detail_json: string;
  source_event_id: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ModelRequestRow {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  segment_id: string;
  request_kind: ConversationModelRequestUsageRecord['requestKind'];
  request_sequence: number;
  model_id: string;
  context_window: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  estimated_usd: number | null;
  usage_complete: number;
  occurred_at: string;
}

interface PersistentWarningRow {
  id: string;
  conversation_id: string;
  warning_kind: string;
  payload_json: string;
  first_event_seq: number;
  last_event_seq: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface ToolResultRow {
  handle: string;
  conversation_id: string;
  turn_id: string;
  segment_id: string;
  tool_pair_id: string;
  relative_path: string;
  sha256: string;
  byte_length: number;
  mime_type: string;
  projection_json: string;
  created_at: string;
}

interface ConfigEvidenceRow {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  submission_id: string | null;
  segment_id: string | null;
  layer: ConversationConfigEvidenceLayer;
  configuration_json: string;
  evidence_json: string;
  mismatch: number;
  observed_at: string;
}

function mapExecutionSnapshot(row: ExecutionSnapshotRow): ConversationExecutionSnapshotRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runtimeKind: row.runtime_kind,
    connectionId: row.connection_id,
    credentialSlotId: row.credential_slot_id,
    endpointIdentity: row.endpoint_identity,
    protocolFamily: row.protocol_family,
    modelId: row.model_id,
    effort: row.effort,
    serviceTier: row.service_tier,
    permissionMode: row.permission_mode,
    collaborationMode: row.collaboration_mode,
    workspaceIdentityJson: row.workspace_identity_json,
    routeFingerprint: row.route_fingerprint,
    createdAt: row.created_at,
  };
}

function mapRuntimeSegment(row: RuntimeSegmentRow): ConversationRuntimeSegmentRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runtimeKind: row.runtime_kind,
    state: row.state,
    executionSnapshotId: row.execution_snapshot_id,
    providerId: row.provider_id,
    nativeSessionId: row.native_session_id,
    nativeSessionPath: row.native_session_path,
    providerModel: row.provider_model,
    providerProtocolVersion: row.provider_protocol_version,
    providerBinaryVersion: row.provider_binary_version,
    provisionalForSubmissionId: row.provisional_for_submission_id,
    openedAt: row.opened_at,
    acceptedAt: row.accepted_at,
    sealedAt: row.sealed_at,
    sealReason: row.seal_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSwitchOperation(row: SwitchOperationRow): ConversationSwitchOperationRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    submissionId: row.submission_id,
    sourceSegmentId: row.source_segment_id,
    targetSegmentId: row.target_segment_id,
    state: row.state,
    acceptanceEvidenceJson: row.acceptance_evidence_json,
    failureJson: row.failure_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function isOpenSwitch(operation: ConversationSwitchOperationRecord): boolean {
  return operation.state === 'preflight' || operation.state === 'provisional' || operation.state === 'outcome_unknown';
}

function conversationSwitchBusyError(conversationId: string): Error {
  return Object.assign(new Error(`产品会话已有一个尚未结束的运行分段切换：${conversationId}`), { code: 'ZEUS_CONVERSATION_SWITCH_IN_PROGRESS' as const });
}

function mapModelHistory(row: ModelHistoryRow): ConversationModelHistoryRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    turnId: row.turn_id,
    submissionId: row.submission_id,
    segmentId: row.segment_id,
    role: row.role,
    contentJson: row.content_json,
    reasoningSourceJson: row.reasoning_source_json,
    toolPairId: row.tool_pair_id,
    capabilityLossJson: row.capability_loss_json,
    confirmedAt: row.confirmed_at,
  };
}

function mapProcessItem(row: ProcessItemRow): ConversationProcessItemRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    segmentId: row.segment_id,
    processSequence: row.process_sequence,
    kind: row.kind,
    status: row.status,
    title: row.title,
    detailJson: row.detail_json,
    sourceEventId: row.source_event_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapModelRequest(row: ModelRequestRow): ConversationModelRequestUsageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    segmentId: row.segment_id,
    requestKind: row.request_kind,
    requestSequence: row.request_sequence,
    modelId: row.model_id,
    contextWindow: row.context_window,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteInputTokens: row.cache_write_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens,
    estimatedUsd: row.estimated_usd,
    usageComplete: row.usage_complete === 1,
    occurredAt: row.occurred_at,
  };
}

function mapPersistentWarning(row: PersistentWarningRow): ConversationPersistentWarningRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    warningKind: row.warning_kind,
    payloadJson: row.payload_json,
    firstEventSeq: row.first_event_seq,
    lastEventSeq: row.last_event_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function mapToolResult(row: ToolResultRow): ConversationToolResultRecord {
  return {
    handle: row.handle,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    segmentId: row.segment_id,
    toolPairId: row.tool_pair_id,
    relativePath: row.relative_path,
    sha256: row.sha256,
    byteLength: row.byte_length,
    mimeType: row.mime_type,
    projectionJson: row.projection_json,
    createdAt: row.created_at,
  };
}

function mapConfigEvidence(row: ConfigEvidenceRow): ConversationConfigEvidenceRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    submissionId: row.submission_id,
    segmentId: row.segment_id,
    layer: row.layer,
    configurationJson: row.configuration_json,
    evidenceJson: row.evidence_json,
    mismatch: row.mismatch === 1,
    observedAt: row.observed_at,
  };
}

function aggregateUsage(rows: ModelRequestRow[]): NullableUsage {
  if (rows.length === 0) return emptyNullableUsage();
  const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens', 'estimated_usd'] as const;
  const totals = Object.fromEntries(
    fields.map((field) => {
      const values = rows.map((row) => row[field]);
      return [field, values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)];
    }),
  ) as Record<(typeof fields)[number], number | null>;
  return {
    inputTokens: totals.input_tokens,
    cachedInputTokens: totals.cached_input_tokens,
    cacheWriteInputTokens: totals.cache_write_input_tokens,
    outputTokens: totals.output_tokens,
    reasoningOutputTokens: totals.reasoning_output_tokens,
    totalTokens: totals.total_tokens,
    estimatedUsd: totals.estimated_usd,
    complete: rows.every((row) => row.usage_complete === 1),
  };
}

function emptyNullableUsage(): NullableUsage {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    estimatedUsd: null,
    complete: false,
  };
}
