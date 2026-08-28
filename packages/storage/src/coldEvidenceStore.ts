import { createHash } from 'node:crypto';
import { isAbsolute, posix } from 'node:path';
import type { SqlValue, ZeusDatabasePort } from './databasePort.js';

export const coldEvidenceSchemaMigrationId = '20260821_0521_cold_evidence_metadata_index';
export const defaultColdEvidencePageLimit = 50;
export const maximumColdEvidencePageLimit = 200;
export const maximumColdEvidenceAnchorsPerSource = 250_000;

export type ColdEvidenceSourceKind = 'project_document' | 'provider_rollout' | 'provider_history' | 'runtime_evidence';
export type ColdEvidenceSourceStatus = 'ready' | 'partial' | 'stale' | 'missing';

export const coldEvidenceRetentionPolicies = {
  project_document: { originOwner: 'project', indexRetention: 'while_source_exists', originDeletionAuthority: 'user_or_project_workflow' },
  provider_rollout: { originOwner: 'provider', indexRetention: 'while_provider_binding_exists', originDeletionAuthority: 'provider_api_only' },
  provider_history: { originOwner: 'provider', indexRetention: 'while_provider_binding_exists', originDeletionAuthority: 'provider_api_only' },
  runtime_evidence: { originOwner: 'runtime', indexRetention: 'bounded_by_runtime_policy', originDeletionAuthority: 'execution_retention_policy' },
} as const satisfies Record<ColdEvidenceSourceKind, { originOwner: string; indexRetention: string; originDeletionAuthority: string }>;

export type ColdEvidenceStoreErrorCode = 'ZEUS_COLD_EVIDENCE_INVALID_ARGUMENT' | 'ZEUS_COLD_EVIDENCE_IDENTITY_CONFLICT' | 'ZEUS_COLD_EVIDENCE_NOT_FOUND' | 'ZEUS_COLD_EVIDENCE_SCHEMA_CONFLICT';

export class ColdEvidenceStoreError extends Error {
  readonly name = 'ColdEvidenceStoreError';

  constructor(
    readonly code: ColdEvidenceStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
  }
}

export interface ColdEvidenceSourceRecord {
  id: string;
  kind: ColdEvidenceSourceKind;
  rootId: string;
  relativePath: string;
  projectId: string | null;
  taskCode: string | null;
  providerId: string | null;
  nativeSessionId: string | null;
  summary: string;
  status: ColdEvidenceSourceStatus;
  sourceVersion: string;
  indexedThroughByte: number;
  sourceByteLength: number;
  sourceModifiedAt: string;
  indexedPrefixSha256: string;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  anchorCount: number;
  createdAt: string;
  indexedAt: string;
  updatedAt: string;
}

export interface ColdEvidenceAnchorRecord {
  sourceId: string;
  ordinal: number;
  lineNumber: number;
  byteOffset: number;
  byteLength: number;
  lineSha256: string;
  eventKind: string;
  turnId: string | null;
  eventSequence: number | null;
  occurredAt: string | null;
}

export interface ReplaceColdEvidenceIndexInput {
  source: Omit<ColdEvidenceSourceRecord, 'anchorCount' | 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string };
  anchors: ColdEvidenceAnchorRecord[];
}

export interface ListColdEvidenceSourcesInput {
  projectId?: string;
  taskCode?: string;
  providerId?: string;
  nativeSessionId?: string;
  kinds?: ColdEvidenceSourceKind[];
  statuses?: ColdEvidenceSourceStatus[];
  before?: { updatedAt: string; id: string };
  limit?: number;
}

export interface ColdEvidenceSourcePage {
  items: ColdEvidenceSourceRecord[];
  hasMore: boolean;
  nextCursor: { updatedAt: string; id: string } | null;
}

export interface ListColdEvidenceAnchorsInput {
  sourceId: string;
  turnId?: string;
  eventSequence?: number;
  afterOrdinal?: number;
  limit?: number;
}

export interface ColdEvidenceAnchorPage {
  items: ColdEvidenceAnchorRecord[];
  hasMore: boolean;
  nextOrdinal: number | null;
}

interface ColdEvidenceSourceRow {
  id: string;
  source_kind: ColdEvidenceSourceKind;
  root_id: string;
  relative_path: string;
  project_id: string | null;
  task_code: string | null;
  provider_id: string | null;
  native_session_id: string | null;
  summary: string;
  status: ColdEvidenceSourceStatus;
  source_version: string;
  indexed_through_byte: number;
  source_byte_length: number;
  source_modified_at: string;
  indexed_prefix_sha256: string;
  first_occurred_at: string | null;
  last_occurred_at: string | null;
  anchor_count: number;
  created_at: string;
  indexed_at: string;
  updated_at: string;
}

interface ColdEvidenceAnchorRow {
  source_id: string;
  ordinal: number;
  line_number: number;
  byte_offset: number;
  byte_length: number;
  line_sha256: string;
  event_kind: string;
  turn_id: string | null;
  event_sequence: number | null;
  occurred_at: string | null;
}

/** 冷证据表只保存来源身份、摘要和字节锚点；不会复制 rollout/history 正文。 */
export function migrateColdEvidenceSchema(db: ZeusDatabasePort): void {
  const checksumSource = [
    'cold_evidence_sources:id,source_kind,root_id,relative_path,project_id,task_code,provider_id,native_session_id,summary,status,source_version',
    'indexed_through_byte,source_byte_length,source_modified_at,indexed_prefix_sha256,first_occurred_at,last_occurred_at,anchor_count,created_at,indexed_at,updated_at',
    'cold_evidence_anchors:source_id,ordinal,line_number,byte_offset,byte_length,line_sha256,event_kind,turn_id,event_sequence,occurred_at',
    'metadata-only:no-source-content',
  ].join(';');
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;

  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [coldEvidenceSchemaMigrationId]);
    if (existing && existing.checksum !== checksum) {
      throw evidenceError('ZEUS_COLD_EVIDENCE_SCHEMA_CONFLICT', '冷证据索引迁移账本与当前结构定义不一致，已拒绝继续打开数据库。', { migrationId: coldEvidenceSchemaMigrationId });
    }
    db.execute(`
      CREATE TABLE IF NOT EXISTS cold_evidence_sources (
        id TEXT PRIMARY KEY CHECK (length(id) > 0),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('project_document', 'provider_rollout', 'provider_history', 'runtime_evidence')),
        root_id TEXT NOT NULL CHECK (length(root_id) BETWEEN 1 AND 256),
        relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 4096),
        project_id TEXT,
        task_code TEXT,
        provider_id TEXT,
        native_session_id TEXT,
        summary TEXT NOT NULL CHECK (length(summary) <= 2048),
        status TEXT NOT NULL CHECK (status IN ('ready', 'partial', 'stale', 'missing')),
        source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 256),
        indexed_through_byte INTEGER NOT NULL CHECK (indexed_through_byte >= 0),
        source_byte_length INTEGER NOT NULL CHECK (source_byte_length >= indexed_through_byte),
        source_modified_at TEXT NOT NULL,
        indexed_prefix_sha256 TEXT NOT NULL CHECK (length(indexed_prefix_sha256) = 64 AND indexed_prefix_sha256 NOT GLOB '*[^0-9a-f]*'),
        first_occurred_at TEXT,
        last_occurred_at TEXT,
        anchor_count INTEGER NOT NULL CHECK (anchor_count >= 0),
        created_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (root_id, relative_path)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_cold_evidence_task ON cold_evidence_sources(task_code, updated_at DESC, id DESC) WHERE task_code IS NOT NULL`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_cold_evidence_project ON cold_evidence_sources(project_id, updated_at DESC, id DESC) WHERE project_id IS NOT NULL`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_cold_evidence_provider_session ON cold_evidence_sources(provider_id, native_session_id, updated_at DESC, id DESC) WHERE native_session_id IS NOT NULL`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS cold_evidence_anchors (
        source_id TEXT NOT NULL REFERENCES cold_evidence_sources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        line_number INTEGER NOT NULL CHECK (line_number > 0),
        byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
        byte_length INTEGER NOT NULL CHECK (byte_length > 0),
        line_sha256 TEXT NOT NULL CHECK (length(line_sha256) = 64 AND line_sha256 NOT GLOB '*[^0-9a-f]*'),
        event_kind TEXT NOT NULL CHECK (length(event_kind) BETWEEN 1 AND 160),
        turn_id TEXT,
        event_sequence INTEGER CHECK (event_sequence IS NULL OR event_sequence >= 0),
        occurred_at TEXT,
        PRIMARY KEY (source_id, ordinal)
      ) WITHOUT ROWID
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_cold_evidence_anchor_turn ON cold_evidence_anchors(source_id, turn_id, ordinal) WHERE turn_id IS NOT NULL`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_cold_evidence_anchor_sequence ON cold_evidence_anchors(source_id, event_sequence, ordinal) WHERE event_sequence IS NOT NULL`);
    if (!existing) {
      db.execute(
        `INSERT INTO schema_migrations (migration_id, description, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
        [coldEvidenceSchemaMigrationId, '增加不复制原始正文的 docs、rollout 与 history 冷证据元数据索引', checksum, new Date().toISOString()],
      );
    }
  });
}

export class ColdEvidenceRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  replaceIndex(input: ReplaceColdEvidenceIndexInput): ColdEvidenceSourceRecord {
    const prepared = prepareIndex(input);
    return this.db.transaction(() => {
      const existing = this.getSource(prepared.source.id);
      if (
        existing &&
        (existing.rootId !== prepared.source.rootId ||
          existing.relativePath !== prepared.source.relativePath ||
          existing.kind !== prepared.source.kind ||
          boundIdentityChanged(existing.projectId, prepared.source.projectId) ||
          boundIdentityChanged(existing.taskCode, prepared.source.taskCode) ||
          boundIdentityChanged(existing.providerId, prepared.source.providerId) ||
          boundIdentityChanged(existing.nativeSessionId, prepared.source.nativeSessionId))
      ) {
        throw evidenceError('ZEUS_COLD_EVIDENCE_IDENTITY_CONFLICT', '冷证据 source ID 已绑定到不同 owner、路径、类型或稳定身份。', { sourceId: prepared.source.id });
      }
      const pathOwner = this.db.get<{ id: string }>(`SELECT id FROM cold_evidence_sources WHERE root_id = ? AND relative_path = ?`, [prepared.source.rootId, prepared.source.relativePath]);
      if (pathOwner && pathOwner.id !== prepared.source.id) {
        throw evidenceError('ZEUS_COLD_EVIDENCE_IDENTITY_CONFLICT', '同一个受控根目录相对路径已经绑定到其他冷证据 source。', { sourceId: prepared.source.id, existingSourceId: pathOwner.id });
      }
      const createdAt = existing?.createdAt ?? prepared.source.createdAt ?? prepared.source.indexedAt;
      const updatedAt = prepared.source.updatedAt ?? prepared.source.indexedAt;
      this.db.execute(
        `INSERT INTO cold_evidence_sources
           (id, source_kind, root_id, relative_path, project_id, task_code, provider_id, native_session_id,
            summary, status, source_version, indexed_through_byte, source_byte_length, source_modified_at,
            indexed_prefix_sha256, first_occurred_at, last_occurred_at, anchor_count, created_at, indexed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           task_code = excluded.task_code,
           provider_id = excluded.provider_id,
           native_session_id = excluded.native_session_id,
           summary = excluded.summary,
           status = excluded.status,
           source_version = excluded.source_version,
           indexed_through_byte = excluded.indexed_through_byte,
           source_byte_length = excluded.source_byte_length,
           source_modified_at = excluded.source_modified_at,
           indexed_prefix_sha256 = excluded.indexed_prefix_sha256,
           first_occurred_at = excluded.first_occurred_at,
           last_occurred_at = excluded.last_occurred_at,
           anchor_count = excluded.anchor_count,
           indexed_at = excluded.indexed_at,
           updated_at = excluded.updated_at`,
        [
          prepared.source.id,
          prepared.source.kind,
          prepared.source.rootId,
          prepared.source.relativePath,
          prepared.source.projectId,
          prepared.source.taskCode,
          prepared.source.providerId,
          prepared.source.nativeSessionId,
          prepared.source.summary,
          prepared.source.status,
          prepared.source.sourceVersion,
          prepared.source.indexedThroughByte,
          prepared.source.sourceByteLength,
          prepared.source.sourceModifiedAt,
          prepared.source.indexedPrefixSha256,
          prepared.source.firstOccurredAt,
          prepared.source.lastOccurredAt,
          prepared.anchors.length,
          createdAt,
          prepared.source.indexedAt,
          updatedAt,
        ],
      );
      this.db.execute(`DELETE FROM cold_evidence_anchors WHERE source_id = ?`, [prepared.source.id]);
      for (const anchor of prepared.anchors) {
        this.db.execute(
          `INSERT INTO cold_evidence_anchors
             (source_id, ordinal, line_number, byte_offset, byte_length, line_sha256, event_kind, turn_id, event_sequence, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [anchor.sourceId, anchor.ordinal, anchor.lineNumber, anchor.byteOffset, anchor.byteLength, anchor.lineSha256, anchor.eventKind, anchor.turnId, anchor.eventSequence, anchor.occurredAt],
        );
      }
      return this.getSource(prepared.source.id)!;
    });
  }

  getSource(sourceId: string): ColdEvidenceSourceRecord | undefined {
    const row = this.db.get<ColdEvidenceSourceRow>(`${selectSourceColumns} WHERE id = ?`, [requiredIdentity(sourceId, 'sourceId', 512)]);
    return row ? mapSource(row) : undefined;
  }

  markStatus(sourceId: string, input: { status: Extract<ColdEvidenceSourceStatus, 'stale' | 'missing'>; updatedAt: string }): ColdEvidenceSourceRecord {
    const id = requiredIdentity(sourceId, 'sourceId', 512);
    const updatedAt = validTimestamp(input.updatedAt, 'updatedAt');
    this.db.execute(`UPDATE cold_evidence_sources SET status = ?, updated_at = ? WHERE id = ?`, [input.status, updatedAt, id]);
    const record = this.getSource(id);
    if (!record) throw evidenceError('ZEUS_COLD_EVIDENCE_NOT_FOUND', '冷证据来源不存在。', { sourceId: id });
    return record;
  }

  listSources(input: ListColdEvidenceSourcesInput): ColdEvidenceSourcePage {
    if (input.projectId === undefined && input.taskCode === undefined && input.providerId === undefined && input.nativeSessionId === undefined) {
      throw invalidArgument('冷证据查询必须至少限定 projectId、taskCode、providerId 或 nativeSessionId，禁止普通路径枚举全部历史。', { field: 'queryScope' });
    }
    const limit = boundedInteger(input.limit ?? defaultColdEvidencePageLimit, 'limit', 1, maximumColdEvidencePageLimit);
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (input.projectId !== undefined) {
      clauses.push('project_id = ?');
      params.push(requiredIdentity(input.projectId, 'projectId', 512));
    }
    if (input.taskCode !== undefined) {
      clauses.push('task_code = ?');
      params.push(requiredIdentity(input.taskCode, 'taskCode', 160));
    }
    if (input.providerId !== undefined) {
      clauses.push('provider_id = ?');
      params.push(requiredIdentity(input.providerId, 'providerId', 160));
    }
    if (input.nativeSessionId !== undefined) {
      clauses.push('native_session_id = ?');
      params.push(requiredIdentity(input.nativeSessionId, 'nativeSessionId', 512));
    }
    if (input.kinds?.length) {
      const kinds = uniqueSourceKinds(input.kinds);
      clauses.push(`source_kind IN (${kinds.map(() => '?').join(', ')})`);
      params.push(...kinds);
    }
    if (input.statuses?.length) {
      const statuses = uniqueSourceStatuses(input.statuses);
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (input.before) {
      const timestamp = validTimestamp(input.before.updatedAt, 'before.updatedAt');
      clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(timestamp, timestamp, requiredIdentity(input.before.id, 'before.id', 512));
    }
    const rows = this.db.select<ColdEvidenceSourceRow>(`${selectSourceColumns} WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`, [...params, limit + 1]);
    const items = rows.slice(0, limit).map(mapSource);
    const last = items.at(-1);
    return { items, hasMore: rows.length > limit, nextCursor: rows.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null };
  }

  listAnchors(input: ListColdEvidenceAnchorsInput): ColdEvidenceAnchorPage {
    const sourceId = requiredIdentity(input.sourceId, 'sourceId', 512);
    if (!this.getSource(sourceId)) throw evidenceError('ZEUS_COLD_EVIDENCE_NOT_FOUND', '冷证据来源不存在。', { sourceId });
    const limit = boundedInteger(input.limit ?? defaultColdEvidencePageLimit, 'limit', 1, maximumColdEvidencePageLimit);
    const clauses = ['source_id = ?', 'ordinal > ?'];
    const params: SqlValue[] = [sourceId, boundedInteger(input.afterOrdinal ?? 0, 'afterOrdinal', 0, Number.MAX_SAFE_INTEGER)];
    if (input.turnId !== undefined) {
      clauses.push('turn_id = ?');
      params.push(requiredIdentity(input.turnId, 'turnId', 512));
    }
    if (input.eventSequence !== undefined) {
      clauses.push('event_sequence = ?');
      params.push(boundedInteger(input.eventSequence, 'eventSequence', 0, Number.MAX_SAFE_INTEGER));
    }
    const rows = this.db.select<ColdEvidenceAnchorRow>(`${selectAnchorColumns} WHERE ${clauses.join(' AND ')} ORDER BY ordinal LIMIT ?`, [...params, limit + 1]);
    const items = rows.slice(0, limit).map(mapAnchor);
    return { items, hasMore: rows.length > limit, nextOrdinal: rows.length > limit ? (items.at(-1)?.ordinal ?? null) : null };
  }
}

function boundIdentityChanged(existing: string | null, candidate: string | null): boolean {
  return existing !== null && existing !== candidate;
}

const selectSourceColumns = `SELECT id, source_kind, root_id, relative_path, project_id, task_code, provider_id,
  native_session_id, summary, status, source_version, indexed_through_byte, source_byte_length,
  source_modified_at, indexed_prefix_sha256, first_occurred_at, last_occurred_at, anchor_count,
  created_at, indexed_at, updated_at FROM cold_evidence_sources`;
const selectAnchorColumns = `SELECT source_id, ordinal, line_number, byte_offset, byte_length, line_sha256,
  event_kind, turn_id, event_sequence, occurred_at FROM cold_evidence_anchors`;

function prepareIndex(input: ReplaceColdEvidenceIndexInput): { source: ReplaceColdEvidenceIndexInput['source']; anchors: ColdEvidenceAnchorRecord[] } {
  if (input.anchors.length > maximumColdEvidenceAnchorsPerSource) throw invalidArgument('单个来源的冷证据锚点超过上限。', { maximum: maximumColdEvidenceAnchorsPerSource });
  const source = input.source;
  const preparedSource: ReplaceColdEvidenceIndexInput['source'] = {
    id: requiredIdentity(source.id, 'source.id', 512),
    kind: validSourceKind(source.kind),
    rootId: requiredIdentity(source.rootId, 'source.rootId', 256),
    relativePath: validRelativePath(source.relativePath),
    projectId: optionalIdentity(source.projectId, 'source.projectId', 512),
    taskCode: optionalIdentity(source.taskCode, 'source.taskCode', 160),
    providerId: optionalIdentity(source.providerId, 'source.providerId', 160),
    nativeSessionId: optionalIdentity(source.nativeSessionId, 'source.nativeSessionId', 512),
    summary: boundedText(source.summary, 'source.summary', 0, 2_048),
    status: validSourceStatus(source.status),
    sourceVersion: requiredIdentity(source.sourceVersion, 'source.sourceVersion', 256),
    indexedThroughByte: boundedInteger(source.indexedThroughByte, 'source.indexedThroughByte', 0, Number.MAX_SAFE_INTEGER),
    sourceByteLength: boundedInteger(source.sourceByteLength, 'source.sourceByteLength', 0, Number.MAX_SAFE_INTEGER),
    sourceModifiedAt: validTimestamp(source.sourceModifiedAt, 'source.sourceModifiedAt'),
    indexedPrefixSha256: validSha256(source.indexedPrefixSha256, 'source.indexedPrefixSha256'),
    firstOccurredAt: optionalTimestamp(source.firstOccurredAt, 'source.firstOccurredAt'),
    lastOccurredAt: optionalTimestamp(source.lastOccurredAt, 'source.lastOccurredAt'),
    indexedAt: validTimestamp(source.indexedAt, 'source.indexedAt'),
    createdAt: source.createdAt ? validTimestamp(source.createdAt, 'source.createdAt') : undefined,
    updatedAt: source.updatedAt ? validTimestamp(source.updatedAt, 'source.updatedAt') : undefined,
  };
  if (preparedSource.indexedThroughByte > preparedSource.sourceByteLength) throw invalidArgument('indexedThroughByte 不能超过 sourceByteLength。', { sourceId: preparedSource.id });
  if (preparedSource.status === 'ready' && preparedSource.indexedThroughByte !== preparedSource.sourceByteLength) {
    throw invalidArgument('ready 冷证据必须完整覆盖当前来源长度。', { sourceId: preparedSource.id });
  }
  if (preparedSource.kind === 'project_document' && (!preparedSource.projectId || !preparedSource.taskCode)) {
    throw invalidArgument('任务文档索引必须携带 projectId 与 taskCode。', { sourceId: preparedSource.id });
  }
  if ((preparedSource.kind === 'provider_rollout' || preparedSource.kind === 'provider_history') && !preparedSource.providerId) {
    throw invalidArgument('Provider 冷证据索引必须携带 providerId。', { sourceId: preparedSource.id });
  }
  if (preparedSource.firstOccurredAt && preparedSource.lastOccurredAt && preparedSource.firstOccurredAt.localeCompare(preparedSource.lastOccurredAt) > 0) {
    throw invalidArgument('firstOccurredAt 不能晚于 lastOccurredAt。', { sourceId: preparedSource.id });
  }
  if (preparedSource.createdAt && preparedSource.updatedAt && preparedSource.createdAt.localeCompare(preparedSource.updatedAt) > 0) {
    throw invalidArgument('createdAt 不能晚于 updatedAt。', { sourceId: preparedSource.id });
  }
  const anchors: ColdEvidenceAnchorRecord[] = [];
  let previousOrdinal = 0;
  let previousLineNumber = 0;
  let previousEnd = 0;
  for (const rawAnchor of input.anchors) {
    const anchor: ColdEvidenceAnchorRecord = {
      sourceId: requiredIdentity(rawAnchor.sourceId, 'anchor.sourceId', 512),
      ordinal: boundedInteger(rawAnchor.ordinal, 'anchor.ordinal', 1, Number.MAX_SAFE_INTEGER),
      lineNumber: boundedInteger(rawAnchor.lineNumber, 'anchor.lineNumber', 1, Number.MAX_SAFE_INTEGER),
      byteOffset: boundedInteger(rawAnchor.byteOffset, 'anchor.byteOffset', 0, Number.MAX_SAFE_INTEGER),
      byteLength: boundedInteger(rawAnchor.byteLength, 'anchor.byteLength', 1, 16 * 1024 * 1024),
      lineSha256: validSha256(rawAnchor.lineSha256, 'anchor.lineSha256'),
      eventKind: boundedText(rawAnchor.eventKind, 'anchor.eventKind', 1, 160),
      turnId: optionalIdentity(rawAnchor.turnId, 'anchor.turnId', 512),
      eventSequence: rawAnchor.eventSequence === null ? null : boundedInteger(rawAnchor.eventSequence, 'anchor.eventSequence', 0, Number.MAX_SAFE_INTEGER),
      occurredAt: optionalTimestamp(rawAnchor.occurredAt, 'anchor.occurredAt'),
    };
    if (anchor.sourceId !== preparedSource.id) throw invalidArgument('所有锚点必须属于同一个 source。', { sourceId: preparedSource.id, anchorSourceId: anchor.sourceId });
    if (anchor.ordinal <= previousOrdinal || anchor.lineNumber <= previousLineNumber || anchor.byteOffset < previousEnd) {
      throw invalidArgument('锚点必须按 ordinal、行号与字节位置严格递增且不得重叠。', { sourceId: preparedSource.id, ordinal: anchor.ordinal });
    }
    if (anchor.byteOffset + anchor.byteLength > preparedSource.indexedThroughByte) throw invalidArgument('锚点越过已索引前缀。', { sourceId: preparedSource.id, ordinal: anchor.ordinal });
    anchors.push(anchor);
    previousOrdinal = anchor.ordinal;
    previousLineNumber = anchor.lineNumber;
    previousEnd = anchor.byteOffset + anchor.byteLength;
  }
  return { source: preparedSource, anchors };
}

function mapSource(row: ColdEvidenceSourceRow): ColdEvidenceSourceRecord {
  return {
    id: row.id,
    kind: row.source_kind,
    rootId: row.root_id,
    relativePath: row.relative_path,
    projectId: row.project_id,
    taskCode: row.task_code,
    providerId: row.provider_id,
    nativeSessionId: row.native_session_id,
    summary: row.summary,
    status: row.status,
    sourceVersion: row.source_version,
    indexedThroughByte: row.indexed_through_byte,
    sourceByteLength: row.source_byte_length,
    sourceModifiedAt: row.source_modified_at,
    indexedPrefixSha256: row.indexed_prefix_sha256,
    firstOccurredAt: row.first_occurred_at,
    lastOccurredAt: row.last_occurred_at,
    anchorCount: row.anchor_count,
    createdAt: row.created_at,
    indexedAt: row.indexed_at,
    updatedAt: row.updated_at,
  };
}

function mapAnchor(row: ColdEvidenceAnchorRow): ColdEvidenceAnchorRecord {
  return {
    sourceId: row.source_id,
    ordinal: row.ordinal,
    lineNumber: row.line_number,
    byteOffset: row.byte_offset,
    byteLength: row.byte_length,
    lineSha256: row.line_sha256,
    eventKind: row.event_kind,
    turnId: row.turn_id,
    eventSequence: row.event_sequence,
    occurredAt: row.occurred_at,
  };
}

function validRelativePath(value: string): string {
  const path = boundedText(value, 'relativePath', 1, 4_096);
  if (isAbsolute(path) || path.includes('\\') || posix.normalize(path) !== path || path === '.' || path === '..' || path.endsWith('/') || path.startsWith('../')) {
    throw invalidArgument('relativePath 必须是规范化、不能越过受控根目录的 POSIX 相对路径。', { field: 'relativePath' });
  }
  return path;
}

function uniqueSourceKinds(values: ColdEvidenceSourceKind[]): ColdEvidenceSourceKind[] {
  return [...new Set(values.map(validSourceKind))].sort();
}

function uniqueSourceStatuses(values: ColdEvidenceSourceStatus[]): ColdEvidenceSourceStatus[] {
  return [...new Set(values.map(validSourceStatus))].sort();
}

function validSourceKind(value: ColdEvidenceSourceKind): ColdEvidenceSourceKind {
  if (value !== 'project_document' && value !== 'provider_rollout' && value !== 'provider_history' && value !== 'runtime_evidence') throw invalidArgument('未知冷证据来源类型。', { value: String(value) });
  return value;
}

function validSourceStatus(value: ColdEvidenceSourceStatus): ColdEvidenceSourceStatus {
  if (value !== 'ready' && value !== 'partial' && value !== 'stale' && value !== 'missing') throw invalidArgument('未知冷证据来源状态。', { value: String(value) });
  return value;
}

function optionalIdentity(value: string | null | undefined, field: string, maximum: number): string | null {
  return value === null || value === undefined ? null : requiredIdentity(value, field, maximum);
}

function requiredIdentity(value: string, field: string, maximum: number): string {
  return boundedText(value, field, 1, maximum);
}

function boundedText(value: string, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < minimum || value.length > maximum || value.includes('\0')) {
    throw invalidArgument(`${field} 必须是 ${minimum} 到 ${maximum} 个字符、首尾无空白且不含 NUL 的字符串。`, { field, minimum, maximum });
  }
  return value;
}

function validTimestamp(value: string, field: string): string {
  const timestamp = boundedText(value, field, 1, 64);
  const epoch = Date.parse(timestamp);
  if (Number.isNaN(epoch)) throw invalidArgument(`${field} 必须是有效时间字符串。`, { field });
  return new Date(epoch).toISOString();
}

function optionalTimestamp(value: string | null | undefined, field: string): string | null {
  return value === null || value === undefined ? null : validTimestamp(value, field);
}

function validSha256(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw invalidArgument(`${field} 必须是小写 SHA-256。`, { field });
  return value;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidArgument(`${field} 必须是 ${minimum} 到 ${maximum} 之间的安全整数。`, { field, minimum, maximum });
  return value;
}

function invalidArgument(message: string, details: Readonly<Record<string, string | number | boolean | null>>): ColdEvidenceStoreError {
  return evidenceError('ZEUS_COLD_EVIDENCE_INVALID_ARGUMENT', message, details);
}

function evidenceError(code: ColdEvidenceStoreErrorCode, message: string, details: Readonly<Record<string, string | number | boolean | null>> = {}): ColdEvidenceStoreError {
  return new ColdEvidenceStoreError(code, message, details);
}
