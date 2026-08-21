import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';

export const conversationSyncEventSchemaMigrationId = '20260821_0315_conversation_sync_events_v3';
export const defaultConversationSyncEventPageLimit = 100;
export const maximumConversationSyncEventPageLimit = 1_000;
export const defaultConversationSyncEventPageBytes = 256 * 1024;
export const maximumConversationSyncEventPageBytes = 4 * 1024 * 1024;

export type ConversationSyncEventStoreErrorCode =
  | 'ZEUS_CONVERSATION_SYNC_EVENT_INVALID_ARGUMENT'
  | 'ZEUS_CONVERSATION_SYNC_EVENT_IDENTITY_CONFLICT'
  | 'ZEUS_CONVERSATION_SYNC_EVENT_SEQUENCE_GAP'
  | 'ZEUS_CONVERSATION_SYNC_EVENT_STREAM_GENERATION_CONFLICT'
  | 'ZEUS_CONVERSATION_SYNC_EVENT_SCHEMA_CONFLICT';

export class ConversationSyncEventStoreError extends Error {
  readonly name = 'ConversationSyncEventStoreError';

  constructor(
    readonly code: ConversationSyncEventStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
  }
}

/** generationId 是 Zeus 增量协议流代次；Provider runtime generation 应作为 payload 字段保存。 */
export interface OpenConversationSyncEventStreamInput {
  conversationId: string;
  generationId: string;
  baseSequence?: number;
  establishedAt: string;
}

export interface ConversationSyncEventStreamRecord {
  conversationId: string;
  generationId: string;
  baseSequence: number;
  latestSequence: number;
  establishedAt: string;
  retiredAt: string | null;
  current: boolean;
}

export interface AppendNextConversationSyncEventInput {
  conversationId: string;
  generationId: string;
  eventId: string;
  payload: unknown;
  occurredAt: string;
  /** 仅在会话尚无当前协议流时生效；默认从 1 开始。 */
  baseSequence?: number;
}

export interface ConversationSyncEventRecord {
  conversationId: string;
  generationId: string;
  sequence: number;
  eventId: string;
  contentSha256: string;
  payloadJson: string;
  payloadByteLength: number;
  occurredAt: string;
}

export interface AppendNextConversationSyncEventResult {
  event: ConversationSyncEventRecord;
  appended: boolean;
  baseSequence: number;
  latestSequence: number;
}

export interface ListConversationSyncEventsInput {
  conversationId: string;
  generationId: string;
  afterSequence?: number;
  limit?: number;
  byteLimit?: number;
}

export interface ConversationSyncEventPage {
  events: ConversationSyncEventRecord[];
  baseSequence: number | null;
  requestedBeforeBaseline: boolean;
  hasMore: boolean;
  nextSequence: number;
  throughSequence: number;
}

interface ConversationSyncEventStreamRow {
  conversation_id: string;
  generation_id: string;
  base_sequence: number;
  latest_sequence: number;
  established_at: string;
  retired_at: string | null;
  is_current: number;
}

interface ConversationSyncEventRow {
  conversation_id: string;
  generation_id: string;
  sequence: number;
  event_id: string;
  content_sha256: string;
  payload_json: string;
  payload_byte_length: number;
  occurred_at: string;
}

interface ConversationSyncEventMetadataRow {
  sequence: number;
  payload_byte_length: number;
}

/** 建立独立于旧会话计数器的协议事件流；迁移不伪造任何历史事件或 baseline。 */
export function migrateConversationSyncEventStoreSchema(db: ZeusDatabasePort): void {
  const checksumSource =
    'conversation_sync_event_streams:conversation_id,generation_id,base_sequence,latest_sequence,established_at,retired_at,is_current;conversation_sync_events:conversation_id,generation_id,sequence,event_id,content_sha256,payload_json,payload_byte_length,occurred_at;append-next-protocol-stream:v3';
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;

  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [conversationSyncEventSchemaMigrationId]);
    if (existing && existing.checksum !== checksum) {
      throw schemaConflict('会话增量事件迁移账本与当前结构定义不一致，已拒绝继续打开数据库。', {
        migrationId: conversationSyncEventSchemaMigrationId,
      });
    }

    db.execute(`
      CREATE TABLE IF NOT EXISTS conversation_sync_event_streams (
        conversation_id TEXT NOT NULL CHECK (length(conversation_id) > 0),
        generation_id TEXT NOT NULL CHECK (length(generation_id) > 0),
        base_sequence INTEGER NOT NULL CHECK (base_sequence > 0),
        latest_sequence INTEGER NOT NULL CHECK (latest_sequence >= base_sequence - 1),
        established_at TEXT NOT NULL,
        retired_at TEXT,
        is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
        CHECK ((is_current = 1 AND retired_at IS NULL) OR (is_current = 0 AND retired_at IS NOT NULL)),
        PRIMARY KEY (conversation_id, generation_id)
      ) WITHOUT ROWID
    `);
    assertRequiredColumns(db, 'conversation_sync_event_streams', ['conversation_id', 'generation_id', 'base_sequence', 'latest_sequence', 'established_at', 'retired_at', 'is_current']);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sync_event_current_stream ON conversation_sync_event_streams(conversation_id) WHERE is_current = 1`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS conversation_sync_events (
        conversation_id TEXT NOT NULL CHECK (length(conversation_id) > 0),
        generation_id TEXT NOT NULL CHECK (length(generation_id) > 0),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        event_id TEXT NOT NULL CHECK (length(event_id) > 0),
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        payload_byte_length INTEGER NOT NULL CHECK (payload_byte_length = length(CAST(payload_json AS BLOB))),
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, generation_id, sequence),
        UNIQUE (conversation_id, generation_id, event_id)
      ) WITHOUT ROWID
    `);
    assertRequiredColumns(db, 'conversation_sync_events', ['conversation_id', 'generation_id', 'sequence', 'event_id', 'content_sha256', 'payload_json', 'payload_byte_length', 'occurred_at']);
    if (db.get<{ present: number }>(`SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_conversation_sync_events_global_sequence'`)) {
      throw schemaConflict('检测到旧版跨协议代次的全局序号索引，无法把 Provider generation 猜测为协议流代次。', {
        index: 'idx_conversation_sync_events_global_sequence',
      });
    }

    const eventWithoutStream = db.get<{ conversation_id: string; generation_id: string; sequence: number }>(
      `SELECT event.conversation_id, event.generation_id, event.sequence
         FROM conversation_sync_events AS event
         LEFT JOIN conversation_sync_event_streams AS stream
           ON stream.conversation_id = event.conversation_id
          AND stream.generation_id = event.generation_id
        WHERE stream.conversation_id IS NULL
        ORDER BY event.conversation_id, event.generation_id, event.sequence
        LIMIT 1`,
    );
    if (eventWithoutStream) {
      throw schemaConflict('会话增量事件缺少显式协议流 baseline，已拒绝从事件内容反向猜测。', {
        conversationId: eventWithoutStream.conversation_id,
        generationId: eventWithoutStream.generation_id,
        sequence: eventWithoutStream.sequence,
      });
    }

    const boundaryMismatch = db.get<{
      conversation_id: string;
      generation_id: string;
      base_sequence: number;
      latest_sequence: number;
      event_count: number;
      actual_base_sequence: number | null;
      actual_latest_sequence: number | null;
    }>(
      `SELECT stream.conversation_id, stream.generation_id, stream.base_sequence, stream.latest_sequence,
              COUNT(event.sequence) AS event_count,
              MIN(event.sequence) AS actual_base_sequence,
              MAX(event.sequence) AS actual_latest_sequence
         FROM conversation_sync_event_streams AS stream
         LEFT JOIN conversation_sync_events AS event
           ON event.conversation_id = stream.conversation_id
          AND event.generation_id = stream.generation_id
        GROUP BY stream.conversation_id, stream.generation_id
       HAVING (stream.latest_sequence = stream.base_sequence - 1 AND COUNT(event.sequence) <> 0)
           OR (stream.latest_sequence >= stream.base_sequence AND (
                COUNT(event.sequence) <> stream.latest_sequence - stream.base_sequence + 1
                OR MIN(event.sequence) <> stream.base_sequence
                OR MAX(event.sequence) <> stream.latest_sequence
              ))
        LIMIT 1`,
    );
    if (boundaryMismatch) {
      throw schemaConflict('会话增量协议流 baseline/latest 与实际连续事件不一致。', {
        conversationId: boundaryMismatch.conversation_id,
        generationId: boundaryMismatch.generation_id,
        baseSequence: boundaryMismatch.base_sequence,
        latestSequence: boundaryMismatch.latest_sequence,
        eventCount: boundaryMismatch.event_count,
        actualBaseSequence: boundaryMismatch.actual_base_sequence,
        actualLatestSequence: boundaryMismatch.actual_latest_sequence,
      });
    }

    if (!existing) {
      db.execute(
        `INSERT INTO schema_migrations (migration_id, description, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
        [conversationSyncEventSchemaMigrationId, '增加独立连续序号、显式 baseline 和协议代次的耐久会话增量事件流', checksum, new Date().toISOString()],
      );
    }
  });
}

/** Repository 不自行 commit，业务投影、回执和 sync event 可由调用方在同一事务提交。 */
export class ConversationSyncEventRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  currentStream(conversationIdValue: string): ConversationSyncEventStreamRecord | undefined {
    const conversationId = requiredIdentity(conversationIdValue, 'conversationId');
    const row = this.readCurrentStream(conversationId);
    if (!row) return undefined;
    this.assertStreamBoundaries(row);
    return mapStream(row);
  }

  /** 显式开启新的 Zeus 协议流代次；已退役 generation 不可重新成为当前流。 */
  openStream(input: OpenConversationSyncEventStreamInput): ConversationSyncEventStreamRecord {
    const conversationId = requiredIdentity(input.conversationId, 'conversationId');
    const generationId = requiredIdentity(input.generationId, 'generationId');
    const baseSequence = positiveSequence(input.baseSequence ?? 1, 'baseSequence');
    const establishedAt = validTimestamp(input.establishedAt, 'establishedAt');

    return this.db.transaction(() => {
      const existing = this.readStream(conversationId, generationId);
      if (existing) {
        if (existing.is_current === 1 && existing.base_sequence === baseSequence && existing.established_at === establishedAt) {
          this.assertStreamBoundaries(existing);
          return mapStream(existing);
        }
        throw streamGenerationConflict('协议流 generation 已存在，不能用不同 baseline、时间或状态重新打开。', {
          conversationId,
          generationId,
          baseSequence,
          existingBaseSequence: existing.base_sequence,
          existingCurrent: existing.is_current === 1,
        });
      }

      const current = this.readCurrentStream(conversationId);
      if (current) {
        this.assertStreamBoundaries(current);
        this.db.execute(
          `UPDATE conversation_sync_event_streams
              SET is_current = 0, retired_at = ?
            WHERE conversation_id = ? AND generation_id = ? AND is_current = 1`,
          [establishedAt, conversationId, current.generation_id],
        );
      }
      this.db.execute(
        `INSERT INTO conversation_sync_event_streams
           (conversation_id, generation_id, base_sequence, latest_sequence, established_at, retired_at, is_current)
         VALUES (?, ?, ?, ?, ?, NULL, 1)`,
        [conversationId, generationId, baseSequence, baseSequence - 1, establishedAt],
      );
      return mapStream(this.requireStream(conversationId, generationId));
    });
  }

  /** 为当前协议流分配下一个连续序号；稳定 eventId 是跨重试幂等身份。 */
  appendNext(input: AppendNextConversationSyncEventInput): AppendNextConversationSyncEventResult {
    const prepared = prepareNextEvent(input);
    const existing = this.getByEventId(prepared.conversationId, prepared.generationId, prepared.eventId);
    if (existing) return assertIdempotentEvent(existing, prepared, this.requireStream(prepared.conversationId, prepared.generationId));

    return this.db.transaction(() => {
      const raced = this.getByEventId(prepared.conversationId, prepared.generationId, prepared.eventId);
      if (raced) return assertIdempotentEvent(raced, prepared, this.requireStream(prepared.conversationId, prepared.generationId));

      let stream = this.readCurrentStream(prepared.conversationId);
      if (!stream) {
        const baseSequence = positiveSequence(input.baseSequence ?? 1, 'baseSequence');
        this.db.execute(
          `INSERT INTO conversation_sync_event_streams
             (conversation_id, generation_id, base_sequence, latest_sequence, established_at, retired_at, is_current)
           VALUES (?, ?, ?, ?, ?, NULL, 1)`,
          [prepared.conversationId, prepared.generationId, baseSequence, baseSequence - 1, prepared.occurredAt],
        );
        stream = this.requireStream(prepared.conversationId, prepared.generationId);
      }
      if (stream.generation_id !== prepared.generationId) {
        throw streamGenerationConflict('appendNext 的 generation 不是当前 Zeus 协议流；必须先显式 openStream，不能由迟到事件切换代次。', {
          conversationId: prepared.conversationId,
          requestedGenerationId: prepared.generationId,
          currentGenerationId: stream.generation_id,
        });
      }
      if (input.baseSequence !== undefined && input.baseSequence !== stream.base_sequence) {
        throw streamGenerationConflict('appendNext 提供的 baseline 与当前协议流不一致。', {
          conversationId: prepared.conversationId,
          generationId: prepared.generationId,
          requestedBaseSequence: input.baseSequence,
          currentBaseSequence: stream.base_sequence,
        });
      }
      this.assertStreamBoundaries(stream);

      const event: ConversationSyncEventRecord = { ...prepared, sequence: stream.latest_sequence + 1 };
      this.insertEvent(event);
      this.db.execute(
        `UPDATE conversation_sync_event_streams
            SET latest_sequence = ?
          WHERE conversation_id = ? AND generation_id = ? AND latest_sequence = ? AND is_current = 1`,
        [event.sequence, event.conversationId, event.generationId, stream.latest_sequence],
      );
      return {
        event,
        appended: true,
        baseSequence: stream.base_sequence,
        latestSequence: event.sequence,
      };
    });
  }

  get(conversationIdValue: string, generationIdValue: string, sequenceValue: number): ConversationSyncEventRecord | undefined {
    const conversationId = requiredIdentity(conversationIdValue, 'conversationId');
    const generationId = requiredIdentity(generationIdValue, 'generationId');
    const sequence = positiveSequence(sequenceValue, 'sequence');
    const row = this.db.get<ConversationSyncEventRow>(`${eventSelectSql()} WHERE conversation_id = ? AND generation_id = ? AND sequence = ?`, [conversationId, generationId, sequence]);
    return row ? mapEvent(row) : undefined;
  }

  listPage(input: ListConversationSyncEventsInput): ConversationSyncEventPage {
    const conversationId = requiredIdentity(input.conversationId, 'conversationId');
    const generationId = requiredIdentity(input.generationId, 'generationId');
    const afterSequence = nonNegativeSequence(input.afterSequence ?? 0, 'afterSequence');
    const limit = boundedPositiveInteger(input.limit ?? defaultConversationSyncEventPageLimit, 'limit', maximumConversationSyncEventPageLimit);
    const byteLimit = boundedPositiveInteger(input.byteLimit ?? defaultConversationSyncEventPageBytes, 'byteLimit', maximumConversationSyncEventPageBytes);
    const stream = this.readStream(conversationId, generationId);
    if (!stream) {
      const untrackedLatest = this.latestPersistedSequence(conversationId, generationId);
      if (untrackedLatest !== null) {
        throw schemaConflict('会话增量事件存在未登记 baseline 的协议流，无法安全分页。', {
          conversationId,
          generationId,
          actualLatestSequence: untrackedLatest,
        });
      }
      return { events: [], baseSequence: null, requestedBeforeBaseline: false, hasMore: false, nextSequence: afterSequence, throughSequence: 0 };
    }
    this.assertStreamBoundaries(stream);

    const baseSequence = stream.base_sequence;
    const throughSequence = stream.latest_sequence;
    const requestedBeforeBaseline = afterSequence < baseSequence - 1;
    const effectiveAfterSequence = requestedBeforeBaseline ? baseSequence - 1 : afterSequence;
    if (effectiveAfterSequence >= throughSequence) {
      return { events: [], baseSequence, requestedBeforeBaseline, hasMore: false, nextSequence: effectiveAfterSequence, throughSequence };
    }

    const metadata = this.db.select<ConversationSyncEventMetadataRow>(
      `SELECT sequence, payload_byte_length
         FROM conversation_sync_events
        WHERE conversation_id = ? AND generation_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?`,
      [conversationId, generationId, effectiveAfterSequence, limit + 1],
    );
    assertContiguousPage(metadata, effectiveAfterSequence, throughSequence, conversationId, generationId);

    const selected: ConversationSyncEventMetadataRow[] = [];
    let selectedBytes = 0;
    for (const candidate of metadata.slice(0, limit)) {
      if (selected.length > 0 && selectedBytes + candidate.payload_byte_length > byteLimit) break;
      selected.push(candidate);
      selectedBytes += candidate.payload_byte_length;
      if (selectedBytes >= byteLimit) break;
    }

    const nextSequence = selected.at(-1)?.sequence ?? effectiveAfterSequence;
    const rows =
      selected.length === 0
        ? []
        : this.db.select<ConversationSyncEventRow>(
            `${eventSelectSql()}
              WHERE conversation_id = ? AND generation_id = ? AND sequence > ? AND sequence <= ?
              ORDER BY sequence`,
            [conversationId, generationId, effectiveAfterSequence, nextSequence],
          );
    return {
      events: rows.map(mapEvent),
      baseSequence,
      requestedBeforeBaseline,
      hasMore: nextSequence < throughSequence,
      nextSequence,
      throughSequence,
    };
  }

  private readCurrentStream(conversationId: string): ConversationSyncEventStreamRow | undefined {
    return this.db.get<ConversationSyncEventStreamRow>(`${streamSelectSql()} WHERE conversation_id = ? AND is_current = 1`, [conversationId]);
  }

  private readStream(conversationId: string, generationId: string): ConversationSyncEventStreamRow | undefined {
    return this.db.get<ConversationSyncEventStreamRow>(`${streamSelectSql()} WHERE conversation_id = ? AND generation_id = ?`, [conversationId, generationId]);
  }

  private requireStream(conversationId: string, generationId: string): ConversationSyncEventStreamRow {
    const stream = this.readStream(conversationId, generationId);
    if (!stream) throw schemaConflict('会话增量事件已经存在，但缺少显式协议流 baseline。', { conversationId, generationId });
    this.assertStreamBoundaries(stream);
    return stream;
  }

  private getByEventId(conversationId: string, generationId: string, eventId: string): ConversationSyncEventRecord | undefined {
    const row = this.db.get<ConversationSyncEventRow>(`${eventSelectSql()} WHERE conversation_id = ? AND generation_id = ? AND event_id = ?`, [conversationId, generationId, eventId]);
    return row ? mapEvent(row) : undefined;
  }

  private insertEvent(event: ConversationSyncEventRecord): void {
    this.db.execute(
      `INSERT INTO conversation_sync_events
         (conversation_id, generation_id, sequence, event_id, content_sha256, payload_json, payload_byte_length, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.conversationId, event.generationId, event.sequence, event.eventId, event.contentSha256, event.payloadJson, event.payloadByteLength, event.occurredAt],
    );
  }

  private assertStreamBoundaries(stream: ConversationSyncEventStreamRow): void {
    const expectedEmptyLatest = stream.base_sequence - 1;
    const actualLatestSequence = this.latestPersistedSequence(stream.conversation_id, stream.generation_id) ?? expectedEmptyLatest;
    if (actualLatestSequence !== stream.latest_sequence) {
      throw schemaConflict('会话增量协议流 latestSequence 元数据与实际事件水位不一致。', {
        conversationId: stream.conversation_id,
        generationId: stream.generation_id,
        recordedLatestSequence: stream.latest_sequence,
        actualLatestSequence,
      });
    }
    if (stream.latest_sequence === expectedEmptyLatest) return;
    if (!this.get(stream.conversation_id, stream.generation_id, stream.base_sequence)) {
      throw schemaConflict('会话增量协议流 baseline 指向的首条事件不存在。', {
        conversationId: stream.conversation_id,
        generationId: stream.generation_id,
        baseSequence: stream.base_sequence,
      });
    }
  }

  private latestPersistedSequence(conversationId: string, generationId: string): number | null {
    return (
      this.db.get<{ sequence: number | null }>(
        `SELECT MAX(sequence) AS sequence
           FROM conversation_sync_events
          WHERE conversation_id = ? AND generation_id = ?`,
        [conversationId, generationId],
      )?.sequence ?? null
    );
  }
}

type PreparedNextEvent = Omit<ConversationSyncEventRecord, 'sequence'>;

function prepareNextEvent(input: AppendNextConversationSyncEventInput): PreparedNextEvent {
  const conversationId = requiredIdentity(input.conversationId, 'conversationId');
  const generationId = requiredIdentity(input.generationId, 'generationId');
  const eventId = requiredIdentity(input.eventId, 'eventId');
  const occurredAt = validTimestamp(input.occurredAt, 'occurredAt');
  if (input.baseSequence !== undefined) positiveSequence(input.baseSequence, 'baseSequence');
  const payloadJson = serializeCanonicalJson(input.payload);
  const contentJson = `{"occurredAt":${JSON.stringify(occurredAt)},"payload":${payloadJson}}`;
  return {
    conversationId,
    generationId,
    eventId,
    contentSha256: createHash('sha256').update(contentJson).digest('hex'),
    payloadJson,
    payloadByteLength: Buffer.byteLength(payloadJson, 'utf8'),
    occurredAt,
  };
}

function assertIdempotentEvent(existing: ConversationSyncEventRecord, candidate: PreparedNextEvent, stream: ConversationSyncEventStreamRow): AppendNextConversationSyncEventResult {
  if (existing.contentSha256 === candidate.contentSha256 && existing.payloadJson === candidate.payloadJson && existing.occurredAt === candidate.occurredAt) {
    return {
      event: existing,
      appended: false,
      baseSequence: stream.base_sequence,
      latestSequence: stream.latest_sequence,
    };
  }
  throw syncEventError('ZEUS_CONVERSATION_SYNC_EVENT_IDENTITY_CONFLICT', '同一会话、协议 generation 和 eventId 已经绑定到不同事件内容。', {
    conversationId: candidate.conversationId,
    generationId: candidate.generationId,
    eventId: candidate.eventId,
    existingSha256: existing.contentSha256,
    candidateSha256: candidate.contentSha256,
  });
}

function assertContiguousPage(metadata: readonly ConversationSyncEventMetadataRow[], afterSequence: number, throughSequence: number, conversationId: string, generationId: string): void {
  let expectedSequence = afterSequence + 1;
  if (metadata.length === 0 && expectedSequence <= throughSequence) {
    throw syncEventError('ZEUS_CONVERSATION_SYNC_EVENT_SEQUENCE_GAP', `会话增量协议流存在真实内部缺口：期望 ${expectedSequence}，但该事件不存在。`, {
      conversationId,
      generationId,
      expectedSequence,
      actualSequence: null,
    });
  }
  for (const row of metadata) {
    if (row.sequence !== expectedSequence) {
      throw syncEventError('ZEUS_CONVERSATION_SYNC_EVENT_SEQUENCE_GAP', `会话增量协议流存在真实内部缺口：期望 ${expectedSequence}，实际 ${row.sequence}。`, {
        conversationId,
        generationId,
        expectedSequence,
        actualSequence: row.sequence,
      });
    }
    expectedSequence += 1;
  }
}

function mapStream(row: ConversationSyncEventStreamRow): ConversationSyncEventStreamRecord {
  return {
    conversationId: row.conversation_id,
    generationId: row.generation_id,
    baseSequence: row.base_sequence,
    latestSequence: row.latest_sequence,
    establishedAt: row.established_at,
    retiredAt: row.retired_at,
    current: row.is_current === 1,
  };
}

function mapEvent(row: ConversationSyncEventRow): ConversationSyncEventRecord {
  return {
    conversationId: row.conversation_id,
    generationId: row.generation_id,
    sequence: row.sequence,
    eventId: row.event_id,
    contentSha256: row.content_sha256,
    payloadJson: row.payload_json,
    payloadByteLength: row.payload_byte_length,
    occurredAt: row.occurred_at,
  };
}

function streamSelectSql(): string {
  return `SELECT conversation_id, generation_id, base_sequence, latest_sequence, established_at, retired_at, is_current
            FROM conversation_sync_event_streams`;
}

function eventSelectSql(): string {
  return `SELECT conversation_id, generation_id, sequence, event_id, content_sha256, payload_json, payload_byte_length, occurred_at
            FROM conversation_sync_events`;
}

function assertRequiredColumns(db: ZeusDatabasePort, table: string, requiredColumns: readonly string[]): void {
  const columns = new Set(db.select<{ name: string }>(`PRAGMA table_info(${table})`).map((column) => column.name));
  const missing = requiredColumns.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw schemaConflict('检测到不兼容的会话增量事件预发布结构；该结构没有被自动猜测迁移。', {
      table,
      missingColumns: missing.join(','),
    });
  }
}

function requiredIdentity(value: string, field: 'conversationId' | 'generationId' | 'eventId'): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw invalidArgument(`${field} 必须是非空且首尾无空白的字符串。`, { field });
  }
  return value;
}

function validTimestamp(value: string, field: 'occurredAt' | 'establishedAt'): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || Number.isNaN(Date.parse(value))) {
    throw invalidArgument(`${field} 必须是有效且首尾无空白的时间字符串。`, { field });
  }
  return value;
}

function positiveSequence(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidArgument(`${field} 必须是正安全整数。`, { field });
  return value;
}

function nonNegativeSequence(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidArgument(`${field} 必须是非负安全整数。`, { field });
  return value;
}

function boundedPositiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw invalidArgument(`${field} 必须是 1 到 ${maximum} 之间的安全整数。`, { field, maximum });
  }
  return value;
}

function serializeCanonicalJson(value: unknown, stack = new Set<object>(), path = '$'): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return serializeJsonPrimitive(value, path);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidArgument(`payload 在 ${path} 包含非有限数字。`, { field: 'payload' });
    return serializeJsonPrimitive(value, path);
  }
  if (typeof value !== 'object') {
    throw invalidArgument(`payload 在 ${path} 包含不可序列化值。`, { field: 'payload', valueType: typeof value });
  }
  if (stack.has(value)) throw invalidArgument(`payload 在 ${path} 包含循环引用。`, { field: 'payload' });

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from({ length: value.length }, (_, index) => serializeCanonicalJson(value[index], stack, `${path}[${index}]`)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidArgument(`payload 在 ${path} 包含非普通对象。`, { field: 'payload' });
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(record[key], stack, `${path}.${key}`)}`)
      .join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

function serializeJsonPrimitive(value: string | number | boolean | null, path: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw invalidArgument(`payload 在 ${path} 无法序列化。`, { field: 'payload' });
  return serialized;
}

function invalidArgument(message: string, details: Readonly<Record<string, string | number | boolean | null>>): ConversationSyncEventStoreError {
  return syncEventError('ZEUS_CONVERSATION_SYNC_EVENT_INVALID_ARGUMENT', message, details);
}

function streamGenerationConflict(message: string, details: Readonly<Record<string, string | number | boolean | null>>): ConversationSyncEventStoreError {
  return syncEventError('ZEUS_CONVERSATION_SYNC_EVENT_STREAM_GENERATION_CONFLICT', message, details);
}

function schemaConflict(message: string, details: Readonly<Record<string, string | number | boolean | null>>): ConversationSyncEventStoreError {
  return syncEventError('ZEUS_CONVERSATION_SYNC_EVENT_SCHEMA_CONFLICT', message, details);
}

function syncEventError(code: ConversationSyncEventStoreErrorCode, message: string, details: Readonly<Record<string, string | number | boolean | null>> = {}): ConversationSyncEventStoreError {
  return new ConversationSyncEventStoreError(code, message, details);
}
