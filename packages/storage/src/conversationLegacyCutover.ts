import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';
import { ConversationProviderItemRepository, conversationProviderItemStoreGeneration } from './conversationProviderItemStore.js';
import type { ConversationAgentKind, ConversationItemPhase, ConversationItemStatus, ConversationItemType } from './conversationItemTypes.js';

export const conversationLegacyCutoverGeneration = '2026-08-21-conversation-items-cutover-v1';

export type ConversationLegacyCutoverState = 'not_started' | 'migrating' | 'ready' | 'failed';

export interface ConversationLegacyCutoverReceipt {
  schemaVersion: 1;
  generation: typeof conversationLegacyCutoverGeneration;
  state: 'ready';
  sourceRows: number;
  providerStateRows: number;
  mappedRows: number;
  sourceDigest: string;
  mappingDigest: string;
  legacyWriteFenceClosed: true;
  rollbackDatabaseIdentity: string;
  completedAt: string;
}

interface LegacyItemRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  provider_thread_id: string;
  provider_turn_id: string;
  provider_item_id: string;
  item_type: ConversationItemType;
  status: ConversationItemStatus;
  phase: ConversationItemPhase;
  text_content: string;
  payload_json: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  agent_kind: ConversationAgentKind | null;
  native_item_id: string | null;
}

interface CutoverMetadataRow {
  state: ConversationLegacyCutoverState;
  source_rows: number;
  provider_state_rows: number;
  mapped_rows: number;
  source_digest: string | null;
  mapping_digest: string | null;
  rollback_database_identity: string | null;
  completed_at: string | null;
}

const legacyItemBatchSize = 1_000;

export function migrateConversationLegacyCutoverSchema(db: ZeusDatabasePort): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_legacy_cutover_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      structure_generation TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('not_started', 'migrating', 'ready', 'failed')),
      source_rows INTEGER NOT NULL DEFAULT 0,
      provider_state_rows INTEGER NOT NULL DEFAULT 0,
      mapped_rows INTEGER NOT NULL DEFAULT 0,
      source_digest TEXT,
      mapping_digest TEXT,
      rollback_database_identity TEXT,
      started_at TEXT,
      completed_at TEXT,
      failure_json TEXT
    )
  `);
  db.execute(
    `INSERT OR IGNORE INTO conversation_legacy_cutover_metadata
     (singleton, structure_generation, state, source_rows, provider_state_rows, mapped_rows)
     VALUES (1, ?, 'not_started', 0, 0, 0)`,
    [conversationLegacyCutoverGeneration],
  );
}

/**
 * 只允许对离线候选副本调用。旧表保持只读；每条旧记录获得：
 * 1) 有界 Provider 摄取状态；2) 统一时间线稳定身份；3) 消息类统一模型历史。
 */
export function migrateLegacyConversationItemsCandidate(db: ZeusDatabasePort, input: { rollbackDatabaseIdentity: string; now?: string }): ConversationLegacyCutoverReceipt {
  const rollbackDatabaseIdentity = normalizeIdentity(input.rollbackDatabaseIdentity, 'rollbackDatabaseIdentity');
  const startedAt = normalizeTimestamp(input.now ?? new Date().toISOString());
  migrateConversationLegacyCutoverSchema(db);
  assertLegacyWriteFenceClosed(db);
  db.execute(
    `UPDATE conversation_legacy_cutover_metadata
        SET state = 'migrating', rollback_database_identity = ?, started_at = ?, completed_at = NULL, failure_json = NULL
      WHERE singleton = 1`,
    [rollbackDatabaseIdentity, startedAt],
  );

  const providerItems = new ConversationProviderItemRepository(db);
  const sourceHash = createHash('sha256');
  let sourceRows = 0;
  let cursorConversationId = '';
  let cursorUpdatedAt = '';
  let cursorId = '';
  try {
    while (true) {
      const rows = readLegacyBatch(db, cursorConversationId, cursorUpdatedAt, cursorId);
      if (rows.length === 0) break;
      db.durableTransactionSync(() => {
        for (const row of rows) {
          sourceHash.update(canonicalLegacyIdentity(row));
          migrateProviderState(providerItems, row);
          ensureUnifiedTimelineIdentity(db, row, startedAt);
          ensureMessageHistory(db, row, startedAt);
          sourceRows += 1;
        }
      });
      const last = rows.at(-1)!;
      cursorConversationId = last.conversation_id;
      cursorUpdatedAt = last.updated_at;
      cursorId = last.id;
    }

    const sourceDigest = sourceHash.digest('hex');
    const providerStateRows = countCoveredProviderStates(db);
    const mappedRows = countCutoverMappings(db);
    const mappingDigest = digestCutoverMappings(db);
    if (providerStateRows !== sourceRows || mappedRows !== sourceRows) {
      throw new Error(`旧会话切换对账失败：source=${sourceRows}, provider=${providerStateRows}, mapping=${mappedRows}`);
    }
    assertLegacyWriteFenceClosed(db);
    const completedAt = normalizeTimestamp(input.now ?? new Date().toISOString());
    db.durableTransactionSync(() => {
      db.execute(
        `UPDATE conversation_legacy_cutover_metadata
            SET state = 'ready', source_rows = ?, provider_state_rows = ?, mapped_rows = ?,
                source_digest = ?, mapping_digest = ?, completed_at = ?, failure_json = NULL
          WHERE singleton = 1 AND structure_generation = ?`,
        [sourceRows, providerStateRows, mappedRows, sourceDigest, mappingDigest, completedAt, conversationLegacyCutoverGeneration],
      );
    });
    return {
      schemaVersion: 1,
      generation: conversationLegacyCutoverGeneration,
      state: 'ready',
      sourceRows,
      providerStateRows,
      mappedRows,
      sourceDigest,
      mappingDigest,
      legacyWriteFenceClosed: true,
      rollbackDatabaseIdentity,
      completedAt,
    };
  } catch (error) {
    db.execute(`UPDATE conversation_legacy_cutover_metadata SET state = 'failed', failure_json = ? WHERE singleton = 1`, [safeErrorJson(error)]);
    throw error;
  }
}

export function readConversationLegacyCutoverReceipt(db: ZeusDatabasePort): ConversationLegacyCutoverReceipt | null {
  migrateConversationLegacyCutoverSchema(db);
  const row = db.get<CutoverMetadataRow>(
    `SELECT state, source_rows, provider_state_rows, mapped_rows, source_digest, mapping_digest,
            rollback_database_identity, completed_at
       FROM conversation_legacy_cutover_metadata WHERE singleton = 1`,
  );
  if (!row || row.state !== 'ready' || !row.source_digest || !row.mapping_digest || !row.rollback_database_identity || !row.completed_at || row.source_rows !== row.provider_state_rows || row.source_rows !== row.mapped_rows) {
    return null;
  }
  assertLegacyWriteFenceClosed(db);
  return {
    schemaVersion: 1,
    generation: conversationLegacyCutoverGeneration,
    state: 'ready',
    sourceRows: row.source_rows,
    providerStateRows: row.provider_state_rows,
    mappedRows: row.mapped_rows,
    sourceDigest: row.source_digest,
    mappingDigest: row.mapping_digest,
    legacyWriteFenceClosed: true,
    rollbackDatabaseIdentity: row.rollback_database_identity,
    completedAt: row.completed_at,
  };
}

function readLegacyBatch(db: ZeusDatabasePort, conversationId: string, updatedAt: string, id: string): LegacyItemRow[] {
  return db.select<LegacyItemRow>(
    `SELECT id, conversation_id, turn_id, provider_thread_id, provider_turn_id, provider_item_id,
            item_type, status, phase, text_content, payload_json, started_at, completed_at,
            updated_at, agent_kind, native_item_id
       FROM conversation_items
      WHERE conversation_id > ?
         OR (conversation_id = ? AND updated_at > ?)
         OR (conversation_id = ? AND updated_at = ? AND id > ?)
      ORDER BY conversation_id, updated_at, id
      LIMIT ?`,
    [conversationId, conversationId, updatedAt, conversationId, updatedAt, id, legacyItemBatchSize],
  );
}

function migrateProviderState(repository: ConversationProviderItemRepository, row: LegacyItemRow): void {
  const payload = parseJson(row.payload_json);
  const base = {
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    providerItemId: row.provider_item_id,
    itemType: row.item_type,
    phase: row.phase,
    payload,
    textContent: row.text_content,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    agentKind: row.agent_kind ?? undefined,
    nativeItemId: row.native_item_id ?? undefined,
  };
  if (row.status === 'in_progress') repository.upsertProgress({ ...base, status: row.status });
  else repository.upsertCompleted({ ...base, status: row.status, completedAt: row.completed_at ?? row.updated_at });
}

function ensureUnifiedTimelineIdentity(db: ZeusDatabasePort, row: LegacyItemRow, mappedAt: string): string {
  const existing = db.get<{ target_identity: string }>(
    `SELECT target_identity
       FROM conversation_migration_mappings
      WHERE source_kind = 'conversation_item' AND source_identity = ? AND target_kind = 'timeline_event'`,
    [row.id],
  );
  if (existing) return existing.target_identity;
  const sequence = nextSequence(db, row.conversation_id, 'timeline_sequence');
  const targetIdentity = `conversation_timeline_legacy_item_${identityHash(row.id)}`;
  db.execute(
    `INSERT INTO conversation_timeline_events
     (id, conversation_id, sequence, event_kind, turn_id, submission_id, segment_id, payload_json, occurred_at)
     VALUES (?, ?, ?, 'legacy_item_migrated', ?, NULL, NULL, ?, ?)`,
    [
      targetIdentity,
      row.conversation_id,
      sequence,
      row.turn_id,
      JSON.stringify({
        sourceItemId: row.id,
        providerThreadId: row.provider_thread_id,
        providerTurnId: row.provider_turn_id,
        providerItemId: row.provider_item_id,
        itemType: row.item_type,
        status: row.status,
        phase: row.phase,
        sourceHash: legacyRowHash(row),
        providerStateGeneration: conversationProviderItemStoreGeneration,
      }),
      row.updated_at,
    ],
  );
  db.execute(
    `INSERT INTO conversation_migration_mappings
     (id, conversation_id, source_kind, source_identity, target_kind, target_identity, source_hash, mapped_at)
     VALUES (?, ?, 'conversation_item', ?, 'timeline_event', ?, ?, ?)`,
    [`conversation_migration_mapping_${identityHash(`timeline:${row.id}`)}`, row.conversation_id, row.id, targetIdentity, legacyRowHash(row), mappedAt],
  );
  return targetIdentity;
}

function ensureMessageHistory(db: ZeusDatabasePort, row: LegacyItemRow, mappedAt: string): void {
  if (row.item_type !== 'userMessage' && row.item_type !== 'agentMessage') return;
  const priorTarget = db.get<{ target_identity: string }>(
    `SELECT mapping.target_identity
       FROM conversation_messages AS message
       JOIN conversation_migration_mappings AS mapping
         ON mapping.source_kind = 'conversation_message'
        AND mapping.source_identity = message.id
        AND mapping.target_kind = 'model_history'
      WHERE message.conversation_id = ? AND message.provider_item_id = ?
      ORDER BY message.created_at, message.id
      LIMIT 1`,
    [row.conversation_id, row.provider_item_id],
  );
  if (priorTarget) {
    db.execute(
      `INSERT OR IGNORE INTO conversation_migration_mappings
       (id, conversation_id, source_kind, source_identity, target_kind, target_identity, source_hash, mapped_at)
       VALUES (?, ?, 'conversation_item', ?, 'model_history', ?, ?, ?)`,
      [`conversation_migration_mapping_${identityHash(`history:${row.id}`)}`, row.conversation_id, row.id, priorTarget.target_identity, legacyRowHash(row), mappedAt],
    );
    return;
  }
  const segmentId = ensureMigrationSegment(db, row, mappedAt);
  const sequence = nextSequence(db, row.conversation_id, 'model_history_sequence');
  const historyId = `conversation_model_history_legacy_item_${identityHash(row.id)}`;
  db.execute(
    `INSERT OR IGNORE INTO conversation_model_history
     (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json,
      reasoning_source_json, tool_pair_id, capability_loss_json, confirmed_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?)`,
    [historyId, row.conversation_id, sequence, row.turn_id, segmentId, row.item_type === 'userMessage' ? 'user' : 'assistant', JSON.stringify({ text: row.text_content }), row.completed_at ?? row.updated_at],
  );
  db.execute(
    `INSERT OR IGNORE INTO conversation_migration_mappings
     (id, conversation_id, source_kind, source_identity, target_kind, target_identity, source_hash, mapped_at)
     VALUES (?, ?, 'conversation_item', ?, 'model_history', ?, ?, ?)`,
    [`conversation_migration_mapping_${identityHash(`history:${row.id}`)}`, row.conversation_id, row.id, historyId, legacyRowHash(row), mappedAt],
  );
}

function ensureMigrationSegment(db: ZeusDatabasePort, row: LegacyItemRow, occurredAt: string): string {
  const existing = db.get<{ id: string }>(
    `SELECT id FROM conversation_runtime_segments
      WHERE conversation_id = ?
      ORDER BY CASE state WHEN 'current' THEN 0 WHEN 'provisional' THEN 1 ELSE 2 END, created_at DESC, id DESC
      LIMIT 1`,
    [row.conversation_id],
  );
  if (existing) return existing.id;
  const segmentId = `conversation_segment_legacy_${identityHash(row.conversation_id)}`;
  db.execute(
    `INSERT OR IGNORE INTO conversation_runtime_segments
     (id, conversation_id, runtime_kind, state, execution_snapshot_id, provider_id,
      native_session_id, native_session_path, provider_model, provider_protocol_version,
      provider_binary_version, provisional_for_submission_id, opened_at, accepted_at,
      sealed_at, seal_reason, created_at, updated_at)
     VALUES (?, ?, ?, 'sealed', NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?,
             'legacy_cutover', ?, ?)`,
    [segmentId, row.conversation_id, row.agent_kind ?? 'codex', row.agent_kind ?? 'codex', row.provider_thread_id, occurredAt, occurredAt, occurredAt, occurredAt],
  );
  return segmentId;
}

function nextSequence(db: ZeusDatabasePort, conversationId: string, column: 'timeline_sequence' | 'model_history_sequence'): number {
  db.execute(`INSERT OR IGNORE INTO conversation_sequence_counters (conversation_id) VALUES (?)`, [conversationId]);
  db.execute(`UPDATE conversation_sequence_counters SET ${column} = ${column} + 1 WHERE conversation_id = ?`, [conversationId]);
  return db.get<Record<typeof column, number>>(`SELECT ${column} FROM conversation_sequence_counters WHERE conversation_id = ?`, [conversationId])![column];
}

function countCoveredProviderStates(db: ZeusDatabasePort): number {
  return (
    db.get<{ row_count: number }>(
      `SELECT COUNT(*) AS row_count
         FROM conversation_items AS legacy
        WHERE EXISTS (
          SELECT 1 FROM conversation_provider_item_states AS provider
           WHERE provider.provider_thread_id = legacy.provider_thread_id
             AND provider.provider_item_id = legacy.provider_item_id
        )`,
    )?.row_count ?? 0
  );
}

function countCutoverMappings(db: ZeusDatabasePort): number {
  return (
    db.get<{ row_count: number }>(
      `SELECT COUNT(*) AS row_count
         FROM conversation_items AS legacy
        WHERE EXISTS (
          SELECT 1 FROM conversation_migration_mappings AS mapping
           WHERE mapping.source_kind = 'conversation_item'
             AND mapping.source_identity = legacy.id
             AND mapping.target_kind IN ('timeline_event', 'model_history')
        )`,
    )?.row_count ?? 0
  );
}

function digestCutoverMappings(db: ZeusDatabasePort): string {
  const hash = createHash('sha256');
  let cursor = '';
  while (true) {
    const rows = db.select<{ source_identity: string; target_kind: string; target_identity: string; source_hash: string }>(
      `SELECT source_identity, target_kind, target_identity, source_hash
         FROM conversation_migration_mappings
        WHERE source_kind = 'conversation_item' AND source_identity > ?
          AND target_kind IN ('timeline_event', 'model_history')
        ORDER BY source_identity
        LIMIT ?`,
      [cursor, legacyItemBatchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) hash.update(`${row.source_identity}\0${row.target_kind}\0${row.target_identity}\0${row.source_hash}\n`);
    cursor = rows.at(-1)!.source_identity;
  }
  return hash.digest('hex');
}

function assertLegacyWriteFenceClosed(db: ZeusDatabasePort): void {
  const fence = db.get<{ current_writer_open: number }>(`SELECT current_writer_open FROM conversation_legacy_write_fence WHERE singleton = 1`);
  if (!fence || fence.current_writer_open !== 0) throw new Error('旧 conversation_items 写入围栏未关闭，拒绝候选切换。');
  const triggerCount =
    db.get<{ row_count: number }>(
      `SELECT COUNT(*) AS row_count FROM sqlite_master
        WHERE type = 'trigger' AND name IN (
          'reject_legacy_conversation_items_insert',
          'reject_legacy_conversation_items_update',
          'reject_legacy_conversation_items_delete'
        )`,
    )?.row_count ?? 0;
  if (triggerCount !== 3) throw new Error('旧 conversation_items 写入触发器不完整。');
}

function canonicalLegacyIdentity(row: LegacyItemRow): string {
  return `${row.conversation_id}\0${row.updated_at}\0${row.id}\0${legacyRowHash(row)}\n`;
}

function legacyRowHash(row: LegacyItemRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.conversation_id,
        row.turn_id,
        row.provider_thread_id,
        row.provider_turn_id,
        row.provider_item_id,
        row.item_type,
        row.status,
        row.phase,
        row.text_content,
        row.payload_json,
        row.started_at,
        row.completed_at,
        row.updated_at,
        row.agent_kind,
        row.native_item_id,
      ]),
    )
    .digest('hex');
}

function identityHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function normalizeIdentity(value: string, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 512 || !/^[\w:./@+-]+$/u.test(normalized)) throw new Error(`${field} 格式无效。`);
  return normalized;
}

function normalizeTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('切换时间戳无效。');
  return new Date(value).toISOString();
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function safeErrorJson(error: unknown): string {
  return JSON.stringify(error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) });
}
