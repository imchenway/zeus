import { createHash } from 'node:crypto';
import { setImmediate as yieldToCore } from 'node:timers/promises';
import { assistantMessageMetadata } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';
import { ConversationExecutionRepository } from './conversationExecutionStore.js';
import { ConversationProviderItemRepository, conversationProviderItemStoreGeneration } from './conversationProviderItemStore.js';
import type { ConversationAgentKind, ConversationItemPhase, ConversationItemStatus, ConversationItemType } from './conversationItemTypes.js';

export const conversationLegacyCutoverGeneration = '2026-08-21-conversation-items-cutover-v1';

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

const legacyItemBatchSize = 1_000;
/** 存量迁移逐批释放写锁，避免几十万条历史阻塞正常会话。 */
const retirementBatchSize = 128;

/** 旧库仍有源表时才允许迁移或安装兼容读取。 */
export function hasLegacyConversationItems(db: ZeusDatabasePort): boolean {
  return Boolean(db.get("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'conversation_items'"));
}

/** 一行旧历史在时间线中保留完整身份和可重建的原始内容。 */
type LegacyItemEvidence = {
  source: Omit<LegacyItemRow, 'text_content' | 'payload_json'>;
  sourceHash: string;
  processId?: string;
  textContent?: string;
  payloadJson?: string;
};

/** 迁移旧条目、核对真实目标内容，再在原库内原子删表。源表保留到最后一笔提交。 */
export async function retireLegacyConversationItems(db: ZeusDatabasePort, shouldStop: () => boolean): Promise<{ sourceRows: number; copiedMessages: number; reusedProcessRows: number; sourceDigest: string } | undefined> {
  if (!hasLegacyConversationItems(db) || shouldStop()) return;
  assertLegacyWriteFenceClosed(db);
  /** 旧安装可能重建过空表。已经写好的逐条对账回执保持原样。 */
  if (!db.get('SELECT 1 FROM conversation_items LIMIT 1')) {
    db.durableTransactionSync(() => db.execute('DROP TABLE conversation_items'));
    return;
  }
  /** 未安装延后索引的旧库也按范围分页；源表删除时一并移除该索引。 */
  if (!db.get("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'idx_conversation_items_timeline'")) {
    db.durableTransactionSync(() => db.execute('CREATE INDEX idx_conversation_items_timeline ON conversation_items(conversation_id, updated_at, id)'));
  }
  const mappedAt = new Date().toISOString();
  /** 正式模型和 Provider 仓储同时维护可见历史及其位置索引。 */
  const history = new ConversationExecutionRepository(db);
  const providerItems = new ConversationProviderItemRepository(db);
  const sourceHash = createHash('sha256');
  let sourceRows = 0;
  let copiedMessages = 0;
  let reusedProcessRows = 0;
  for await (const rows of readRetirementBatches(db, shouldStop)) {
    db.durableTransactionSync(() => {
      for (const row of rows) {
        /** 已提交的时间线身份也是可重入边界。 */
        const timelineId = ensureUnifiedTimelineIdentity(db, row, mappedAt);
        const prior = readLegacyItemEvidence(db, timelineId);
        if (prior) {
          if (prior.processId) reusedProcessRows++;
        } else {
          const process = legacyProcessCopy(db, row);
          if (process && process.payloadJson === row.payload_json && process.textContent === row.text_content) {
            reusedProcessRows++;
            saveLegacyItemEvidence(db, timelineId, row, process.id);
          } else {
            saveLegacyItemEvidence(db, timelineId, row);
          }
          if (row.item_type === 'agentMessage' || row.item_type === 'userMessage') {
            if (restoreMissingLegacyMessage(db, history, row, mappedAt)) copiedMessages++;
          } else if (!process && !providerItems.getByProvider(row.provider_thread_id, row.provider_item_id)) {
            /** 执行器已经停写，归档中的旧进行中状态不重启任务。原始状态保留在时间线。 */
            migrateProviderState(providerItems, row.status === 'in_progress' ? { ...row, status: 'failed' } : row);
          }
        }
        sourceHash.update(canonicalLegacyIdentity(row));
        sourceRows++;
      }
    });
  }
  if (shouldStop()) return;

  /** 独立读回已提交的目标，比较包括全部旧标识和字段的完整摘要。 */
  const verifiedHash = createHash('sha256');
  let verifiedRows = 0;
  for await (const rows of readRetirementBatches(db, shouldStop)) {
    for (const row of rows) {
      const evidence = readLegacyItemEvidence(db, `conversation_timeline_legacy_item_${identityHash(row.id)}`);
      if (!evidence || evidence.sourceHash !== legacyRowHash(row)) throw new Error(`旧会话切换缺少来源证据：${row.id}`);
      const content = evidence.processId ? readLegacyProcessCopy(db, evidence.processId, row) : evidence;
      if (!content || typeof content.payloadJson !== 'string' || typeof content.textContent !== 'string') throw new Error(`旧会话切换缺少原始内容：${row.id}`);
      const restored = { ...evidence.source, text_content: content.textContent, payload_json: content.payloadJson };
      if (legacyRowHash(restored) !== evidence.sourceHash) throw new Error(`旧会话切换对账失败：${row.id}`);
      verifiedHash.update(canonicalLegacyIdentity(restored));
      verifiedRows++;
    }
  }
  if (shouldStop()) return;
  const sourceDigest = sourceHash.digest('hex');
  const targetDigest = verifiedHash.digest('hex');
  db.durableTransactionSync(() => {
    assertLegacyWriteFenceClosed(db);
    if (sourceRows !== verifiedRows || sourceDigest !== targetDigest || sourceRows !== db.countRows('conversation_items')) {
      throw new Error(`旧会话切换对账失败：来源 ${sourceRows}，目标 ${verifiedRows}。`);
    }
    db.execute(
      `UPDATE conversation_legacy_cutover_metadata
        SET state = 'ready', source_rows = ?, mapped_rows = ?, source_digest = ?, mapping_digest = ?,
              completed_at = ?, rollback_database_identity = NULL, failure_json = NULL
        WHERE singleton = 1`,
      [sourceRows, verifiedRows, sourceDigest, targetDigest, new Date().toISOString()],
    );
    db.execute('DROP TABLE conversation_items');
  });
  return { sourceRows, copiedMessages, reusedProcessRows, sourceDigest };
}

/** 按旧库已有的会话时间索引扫描，跨批次保持原有顺序。 */
async function* readRetirementBatches(db: ZeusDatabasePort, shouldStop: () => boolean): AsyncGenerator<LegacyItemRow[]> {
  let cursor: [string, string, string] = ['', '', ''];
  while (!shouldStop()) {
    await yieldToCore();
    if (shouldStop()) return;
    const rows = readLegacyBatch(db, ...cursor, retirementBatchSize);
    const tail = rows.at(-1);
    if (!tail) return;
    yield rows;
    cursor = [tail.conversation_id, tail.updated_at, tail.id];
  }
}

/** 按同一会话、轮次和旧条目来源寻找不可变的过程副本。 */
function legacyProcessCopy(db: ZeusDatabasePort, row: LegacyItemRow): { id: string; payloadJson: string; textContent: string } | undefined {
  const match = db.get<{ id: string }>(
    `SELECT p.id FROM conversation_runtime_segments AS s
      JOIN conversation_process_items AS p ON p.segment_id = s.id AND p.source_event_id = ?
      WHERE s.conversation_id = ? AND p.conversation_id = ? AND p.turn_id = ? AND p.status IN ('completed', 'failed')
      ORDER BY p.process_sequence LIMIT 1`,
    [`migration:item:${row.id}`, row.conversation_id, row.conversation_id, row.turn_id],
  );
  return match ? readLegacyProcessCopy(db, match.id, row) : undefined;
}

/** 读回过程正文时固定来源身份，避免引用另一条命令或另一会话。 */
function readLegacyProcessCopy(db: ZeusDatabasePort, id: string, row: Pick<LegacyItemRow, 'id' | 'conversation_id' | 'turn_id'>): { id: string; payloadJson: string; textContent: string } | undefined {
  const record = db.get<{ detail_json: string }>('SELECT detail_json FROM conversation_process_items WHERE id = ? AND conversation_id = ? AND turn_id = ? AND source_event_id = ?', [
    id,
    row.conversation_id,
    row.turn_id,
    `migration:item:${row.id}`,
  ]);
  const detail = record ? (JSON.parse(record.detail_json) as { payload?: unknown; text?: unknown }) : undefined;
  if (!detail || typeof detail.text !== 'string' || detail.payload === undefined) return;
  return { id, payloadJson: JSON.stringify(detail.payload), textContent: detail.text };
}

/** 时间线只保留需要迁入的源字段。已有逐字相同的过程正文按身份引用。 */
function saveLegacyItemEvidence(db: ZeusDatabasePort, timelineId: string, row: LegacyItemRow, processId?: string): void {
  const { text_content, payload_json, ...source } = row;
  const evidence: LegacyItemEvidence = { source, sourceHash: legacyRowHash(row), ...(processId ? { processId } : { textContent: text_content, payloadJson: payload_json }) };
  db.execute('UPDATE conversation_timeline_events SET payload_json = ? WHERE id = ?', [JSON.stringify(evidence), timelineId]);
}

/** 区分已迁入的完整证据和旧候选工具只写过的摘要。 */
function readLegacyItemEvidence(db: ZeusDatabasePort, timelineId: string): LegacyItemEvidence | undefined {
  const row = db.get<{ payload_json: string }>("SELECT payload_json FROM conversation_timeline_events WHERE id = ? AND event_kind = 'legacy_item_migrated'", [timelineId]);
  const value = row ? (JSON.parse(row.payload_json) as Partial<LegacyItemEvidence>) : undefined;
  return value?.source && typeof value.sourceHash === 'string' ? (value as LegacyItemEvidence) : undefined;
}

/** 只补当前正文账本缺失的旧用户或助手消息，不重复生成同轮正文。 */
function restoreMissingLegacyMessage(db: ZeusDatabasePort, history: ConversationExecutionRepository, row: LegacyItemRow, mappedAt: string): boolean {
  if (!row.text_content) return false;
  const role = row.item_type === 'userMessage' ? 'user' : 'assistant';
  if (
    db.get(
      `SELECT 1 FROM conversation_model_history
      WHERE conversation_id = ? AND turn_id = ? AND role = ? AND tool_pair_id IS NULL
        AND CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.text') END = ?
      LIMIT 1`,
      [row.conversation_id, row.turn_id, role, row.text_content],
    )
  )
    return false;
  if (
    db.get(
      `SELECT 1 FROM conversation_messages
      WHERE conversation_id = ? AND provider_thread_id = ? AND provider_item_id = ? AND role = ? AND content = ? LIMIT 1`,
      [row.conversation_id, row.provider_thread_id, row.provider_item_id, role, row.text_content],
    )
  )
    return false;
  const payload = parseJson(row.payload_json);
  history.appendModelHistory({
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    segmentId: ensureMigrationSegment(db, row, mappedAt),
    role,
    content: {
      text: row.text_content,
      legacySourceItemId: row.id,
      ...(role === 'assistant' ? { assistantMessage: assistantMessageMetadata(typeof payload === 'object' && payload && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}, row.phase) } : {}),
    },
    confirmedAt: row.completed_at ?? row.updated_at,
  });
  return true;
}

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

function readLegacyBatch(db: ZeusDatabasePort, conversationId: string, updatedAt: string, id: string, limit = legacyItemBatchSize): LegacyItemRow[] {
  return db.select<LegacyItemRow>(
    `SELECT id, conversation_id, turn_id, provider_thread_id, provider_turn_id, provider_item_id,
            item_type, status, phase, text_content, payload_json, started_at, completed_at,
            updated_at, agent_kind, native_item_id
       FROM conversation_items
      WHERE (conversation_id, updated_at, id) > (?, ?, ?)
      ORDER BY conversation_id, updated_at, id
      LIMIT ?`,
    [conversationId, updatedAt, id, limit],
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
