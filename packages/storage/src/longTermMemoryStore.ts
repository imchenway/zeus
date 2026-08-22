import { createHash, randomUUID } from 'node:crypto';
import type { SqlValue, ZeusDatabasePort } from './databasePort.js';

export const longTermMemorySchemaMigrationId = '20260821_0501_long_term_memory_governance';

export const acceptedLongTermMemoryKinds = ['preference', 'safety_boundary', 'stable_workflow'] as const;
export const rejectedLongTermMemoryCandidateKinds = ['task_fact', 'one_off_result', 'runtime_evidence'] as const;
export type LongTermMemoryKind = (typeof acceptedLongTermMemoryKinds)[number];
export type RejectedLongTermMemoryCandidateKind = (typeof rejectedLongTermMemoryCandidateKinds)[number];
export type LongTermMemoryCandidateKind = LongTermMemoryKind | RejectedLongTermMemoryCandidateKind;
export type LongTermMemoryScopeKind = 'global' | 'project';
export type LongTermMemoryEffect = 'advisory' | 'external_state';
export type LongTermMemoryConfirmationLevel = 'observed' | 'confirmed' | 'explicit';
export type LongTermMemorySourceKind = 'user_explicit' | 'project_instruction' | 'repeated_confirmation' | 'manual_import';

export type LongTermMemoryStoreErrorCode =
  | 'ZEUS_LONG_TERM_MEMORY_INVALID_ARGUMENT'
  | 'ZEUS_LONG_TERM_MEMORY_CANDIDATE_REJECTED'
  | 'ZEUS_LONG_TERM_MEMORY_CONFIRMATION_REQUIRED'
  | 'ZEUS_LONG_TERM_MEMORY_HEAD_CONFLICT'
  | 'ZEUS_LONG_TERM_MEMORY_NOT_FOUND'
  | 'ZEUS_LONG_TERM_MEMORY_SCHEMA_CONFLICT';

export class LongTermMemoryStoreError extends Error {
  readonly name = 'LongTermMemoryStoreError';

  constructor(
    readonly code: LongTermMemoryStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
  }
}

export interface LongTermMemoryScope {
  kind: LongTermMemoryScopeKind;
  /** 全局 scope 固定为 `*`；项目 scope 保存稳定 project ID，不保存路径。 */
  id: string;
}

export interface LongTermMemorySource {
  kind: LongTermMemorySourceKind;
  reference: string;
  observedAt: string;
  contentSha256?: string | null;
}

export interface LongTermMemoryRecord {
  id: string;
  memoryKey: string;
  scope: LongTermMemoryScope;
  kind: LongTermMemoryKind;
  content: string;
  contentSha256: string;
  effect: LongTermMemoryEffect;
  source: LongTermMemorySource;
  confirmationLevel: LongTermMemoryConfirmationLevel;
  confidence: number;
  reviewAfter: string;
  supersedesId: string | null;
  tombstone: boolean;
  tombstonedAt: string | null;
  tombstoneReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordLongTermMemoryCandidateInput {
  id?: string;
  memoryKey: string;
  scope: LongTermMemoryScope;
  candidateKind: LongTermMemoryCandidateKind;
  content: string;
  effect: LongTermMemoryEffect;
  source: LongTermMemorySource;
  confirmationLevel: LongTermMemoryConfirmationLevel;
  confidence: number;
  reviewAfter: string;
  supersedesId?: string | null;
  recordedAt: string;
}

export type RecordLongTermMemoryCandidateResult = { accepted: true; record: LongTermMemoryRecord } | { accepted: false; reason: RejectedLongTermMemoryCandidateKind };

export interface ListLongTermMemoriesInput {
  scope?: LongTermMemoryScope;
  includeTombstones?: boolean;
  before?: { updatedAt: string; id: string };
  limit?: number;
}

export interface LongTermMemoryPage {
  items: LongTermMemoryRecord[];
  hasMore: boolean;
  nextCursor: { updatedAt: string; id: string } | null;
}

export type LongTermMemoryExclusionReason = 'superseded' | 'tombstoned' | 'review_due' | 'scope_shadowed' | 'head_conflict' | 'confidence_below_threshold';

export interface LongTermMemoryResolution {
  selected: LongTermMemoryRecord[];
  reviewRequired: LongTermMemoryRecord[];
  excluded: Array<{ record: LongTermMemoryRecord; reason: LongTermMemoryExclusionReason }>;
}

interface LongTermMemoryRow {
  id: string;
  memory_key: string;
  scope_kind: LongTermMemoryScopeKind;
  scope_id: string;
  memory_kind: LongTermMemoryKind;
  content: string;
  content_sha256: string;
  effect: LongTermMemoryEffect;
  source_kind: LongTermMemorySourceKind;
  source_ref: string;
  source_observed_at: string;
  source_content_sha256: string | null;
  confirmation_level: LongTermMemoryConfirmationLevel;
  confidence: number;
  review_after: string;
  supersedes_id: string | null;
  tombstone: number;
  tombstoned_at: string | null;
  tombstone_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 建立 Zeus 自己拥有的稳定偏好记忆表。迁移不读取、不导入也不改写 Codex Home 中的 Memory。
 */
export function migrateLongTermMemorySchema(db: ZeusDatabasePort): void {
  const checksumSource = [
    'long_term_memories:id,memory_key,scope_kind,scope_id,memory_kind,content,content_sha256,effect',
    'source_kind,source_ref,source_observed_at,source_content_sha256,confirmation_level,confidence',
    'review_after,supersedes_id,tombstone,tombstoned_at,tombstone_reason,created_at,updated_at',
    'accepted-kinds:preference,safety_boundary,stable_workflow',
  ].join(';');
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;

  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [longTermMemorySchemaMigrationId]);
    if (existing && existing.checksum !== checksum) {
      throw memoryError('ZEUS_LONG_TERM_MEMORY_SCHEMA_CONFLICT', '长期记忆迁移账本与当前结构定义不一致，已拒绝继续打开数据库。', { migrationId: longTermMemorySchemaMigrationId });
    }

    db.execute(`
      CREATE TABLE IF NOT EXISTS long_term_memories (
        id TEXT PRIMARY KEY CHECK (length(id) > 0),
        memory_key TEXT NOT NULL CHECK (length(memory_key) BETWEEN 1 AND 160),
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project')),
        scope_id TEXT NOT NULL CHECK ((scope_kind = 'global' AND scope_id = '*') OR (scope_kind = 'project' AND length(scope_id) > 0)),
        memory_kind TEXT NOT NULL CHECK (memory_kind IN ('preference', 'safety_boundary', 'stable_workflow')),
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 16384),
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
        effect TEXT NOT NULL CHECK (effect IN ('advisory', 'external_state')),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('user_explicit', 'project_instruction', 'repeated_confirmation', 'manual_import')),
        source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 2048),
        source_observed_at TEXT NOT NULL,
        source_content_sha256 TEXT CHECK (source_content_sha256 IS NULL OR (length(source_content_sha256) = 64 AND source_content_sha256 NOT GLOB '*[^0-9a-f]*')),
        confirmation_level TEXT NOT NULL CHECK (confirmation_level IN ('observed', 'confirmed', 'explicit')),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        review_after TEXT NOT NULL,
        supersedes_id TEXT REFERENCES long_term_memories(id),
        tombstone INTEGER NOT NULL DEFAULT 0 CHECK (tombstone IN (0, 1)),
        tombstoned_at TEXT,
        tombstone_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((tombstone = 0 AND tombstoned_at IS NULL AND tombstone_reason IS NULL) OR (tombstone = 1 AND tombstoned_at IS NOT NULL AND length(tombstone_reason) > 0)),
        CHECK (effect <> 'external_state' OR (confirmation_level = 'explicit' AND source_kind IN ('user_explicit', 'project_instruction'))),
        CHECK (supersedes_id IS NULL OR supersedes_id <> id)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_long_term_memories_scope_key ON long_term_memories(scope_kind, scope_id, memory_key, updated_at DESC, id DESC)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_long_term_memories_supersedes ON long_term_memories(supersedes_id) WHERE supersedes_id IS NOT NULL`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_long_term_memories_review ON long_term_memories(review_after, updated_at, id) WHERE tombstone = 0`);
    if (!existing) {
      db.execute(
        `INSERT INTO schema_migrations (migration_id, description, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
        [longTermMemorySchemaMigrationId, '增加只接纳稳定偏好、安全边界和工作流的长期记忆治理表', checksum, new Date().toISOString()],
      );
    }
  });
}

/** 长期记忆写入只接受显式候选；不会从会话、rollout 或任务文档自动抽取。 */
export class LongTermMemoryRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  recordCandidate(input: RecordLongTermMemoryCandidateInput): RecordLongTermMemoryCandidateResult {
    const candidateKind = validCandidateKind(input.candidateKind);
    if (!isAcceptedKind(candidateKind)) return { accepted: false, reason: candidateKind };
    const prepared = prepareCandidate(input, candidateKind);
    return this.db.transaction(() => {
      const existingId = this.getById(prepared.id);
      if (existingId) {
        if (sameRecord(existingId, prepared)) return { accepted: true, record: existingId };
        throw memoryError('ZEUS_LONG_TERM_MEMORY_HEAD_CONFLICT', '长期记忆 ID 已绑定到不同内容。', { id: prepared.id });
      }

      const currentHead = this.currentHead(prepared.scope, prepared.memoryKey);
      if (currentHead && prepared.supersedesId !== currentHead.id) {
        throw memoryError('ZEUS_LONG_TERM_MEMORY_HEAD_CONFLICT', '同一 scope 与 memory key 已有当前版本，修正时必须显式 supersede 当前 head。', {
          scopeKind: prepared.scope.kind,
          scopeId: prepared.scope.id,
          memoryKey: prepared.memoryKey,
          currentHeadId: currentHead.id,
        });
      }
      if (!currentHead && prepared.supersedesId) {
        throw memoryError('ZEUS_LONG_TERM_MEMORY_HEAD_CONFLICT', 'supersedes 指向的记录不是该 scope 与 memory key 的当前 head。', { supersedesId: prepared.supersedesId });
      }
      this.insert(prepared);
      return { accepted: true, record: prepared };
    });
  }

  supersede(previousId: string, input: Omit<RecordLongTermMemoryCandidateInput, 'supersedesId' | 'scope' | 'memoryKey'>): LongTermMemoryRecord {
    const previous = this.getById(requiredIdentity(previousId, 'previousId'));
    if (!previous) throw memoryError('ZEUS_LONG_TERM_MEMORY_NOT_FOUND', '要修正的长期记忆不存在。', { id: previousId });
    const result = this.recordCandidate({ ...input, scope: previous.scope, memoryKey: previous.memoryKey, supersedesId: previous.id });
    if (!result.accepted) {
      throw memoryError('ZEUS_LONG_TERM_MEMORY_CANDIDATE_REJECTED', '任务事实、一次性结果和运行证据不能修正为长期记忆。', { candidateKind: result.reason });
    }
    return result.record;
  }

  tombstone(id: string, input: { at: string; reason: string }): LongTermMemoryRecord {
    const memoryId = requiredIdentity(id, 'id');
    const at = validTimestamp(input.at, 'at');
    const reason = boundedText(input.reason, 'reason', 1, 2_048);
    return this.db.transaction(() => {
      const record = this.getById(memoryId);
      if (!record) throw memoryError('ZEUS_LONG_TERM_MEMORY_NOT_FOUND', '要停用或删除的长期记忆不存在。', { id: memoryId });
      if (record.tombstone) return record;
      if (at.localeCompare(record.updatedAt) < 0) throw invalidArgument('墓碑时间不能早于记忆更新时间。', { id: memoryId });
      this.db.execute(`UPDATE long_term_memories SET tombstone = 1, tombstoned_at = ?, tombstone_reason = ?, updated_at = ? WHERE id = ?`, [at, reason, at, memoryId]);
      return this.getById(memoryId)!;
    });
  }

  getById(id: string): LongTermMemoryRecord | undefined {
    const row = this.db.get<LongTermMemoryRow>(`${selectMemoryColumns} WHERE id = ?`, [requiredIdentity(id, 'id')]);
    return row ? mapMemory(row) : undefined;
  }

  list(input: ListLongTermMemoriesInput = {}): LongTermMemoryPage {
    const limit = boundedInteger(input.limit ?? 100, 'limit', 1, 500);
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (input.scope) {
      const scope = normalizeScope(input.scope);
      clauses.push('scope_kind = ? AND scope_id = ?');
      params.push(scope.kind, scope.id);
    }
    if (!input.includeTombstones) clauses.push('tombstone = 0');
    if (input.before) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(validTimestamp(input.before.updatedAt, 'before.updatedAt'), validTimestamp(input.before.updatedAt, 'before.updatedAt'), requiredIdentity(input.before.id, 'before.id'));
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.select<LongTermMemoryRow>(`${selectMemoryColumns}${where} ORDER BY updated_at DESC, id DESC LIMIT ?`, [...params, limit + 1]);
    const selected = rows.slice(0, limit).map(mapMemory);
    const last = selected.at(-1);
    return {
      items: selected,
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null,
    };
  }

  resolveForContext(input: { projectId?: string | null; asOf: string; minimumConfidence?: number }): LongTermMemoryResolution {
    const asOf = validTimestamp(input.asOf, 'asOf');
    const minimumConfidence = input.minimumConfidence ?? 0;
    if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) throw invalidArgument('minimumConfidence 必须位于 0 到 1。', { minimumConfidence });
    const projectId = input.projectId === undefined || input.projectId === null ? null : requiredIdentity(input.projectId, 'projectId');
    const rows = projectId
      ? this.db.select<LongTermMemoryRow>(`${selectMemoryColumns} WHERE (scope_kind = 'global' AND scope_id = '*') OR (scope_kind = 'project' AND scope_id = ?) ORDER BY updated_at DESC, id DESC`, [projectId])
      : this.db.select<LongTermMemoryRow>(`${selectMemoryColumns} WHERE scope_kind = 'global' AND scope_id = '*' ORDER BY updated_at DESC, id DESC`);
    const records = rows.map(mapMemory);
    const supersededIds = new Set(records.flatMap((record) => (record.supersedesId ? [record.supersedesId] : [])));
    const excluded: LongTermMemoryResolution['excluded'] = records.filter((record) => supersededIds.has(record.id)).map((record) => ({ record, reason: 'superseded' }));
    const heads = records.filter((record) => !supersededIds.has(record.id));
    for (const record of heads.filter((candidate) => candidate.tombstone)) excluded.push({ record, reason: 'tombstoned' });
    const byKey = new Map<string, LongTermMemoryRecord[]>();
    for (const record of heads.filter((candidate) => !candidate.tombstone)) {
      const list = byKey.get(record.memoryKey) ?? [];
      list.push(record);
      byKey.set(record.memoryKey, list);
    }

    const selected: LongTermMemoryRecord[] = [];
    const reviewRequired: LongTermMemoryRecord[] = [];
    for (const memoryKey of [...byKey.keys()].sort()) {
      const candidates = byKey.get(memoryKey)!;
      const scoped = projectId ? candidates.filter((record) => record.scope.kind === 'project') : [];
      const eligibleScope = scoped.length > 0 ? scoped : candidates.filter((record) => record.scope.kind === 'global');
      for (const shadowed of candidates.filter((record) => !eligibleScope.includes(record))) excluded.push({ record: shadowed, reason: 'scope_shadowed' });
      const winner = eligibleScope[0];
      for (const conflict of eligibleScope.slice(1)) excluded.push({ record: conflict, reason: 'head_conflict' });
      if (!winner) continue;
      if (winner.reviewAfter.localeCompare(asOf) <= 0) {
        reviewRequired.push(winner);
        excluded.push({ record: winner, reason: 'review_due' });
        continue;
      }
      if (winner.confidence < minimumConfidence) {
        excluded.push({ record: winner, reason: 'confidence_below_threshold' });
        continue;
      }
      selected.push(winner);
    }
    selected.sort(compareResolvedMemory);
    reviewRequired.sort(compareResolvedMemory);
    excluded.sort((left, right) => compareResolvedMemory(left.record, right.record) || left.reason.localeCompare(right.reason));
    return { selected, reviewRequired, excluded };
  }

  private currentHead(scope: LongTermMemoryScope, memoryKey: string): LongTermMemoryRecord | undefined {
    const rows = this.db.select<LongTermMemoryRow>(
      `${selectMemoryColumns}
        WHERE scope_kind = ? AND scope_id = ? AND memory_key = ?
          AND id NOT IN (SELECT supersedes_id FROM long_term_memories WHERE supersedes_id IS NOT NULL)
        ORDER BY updated_at DESC, id DESC
        LIMIT 2`,
      [scope.kind, scope.id, memoryKey],
    );
    if (rows.length > 1) {
      throw memoryError('ZEUS_LONG_TERM_MEMORY_HEAD_CONFLICT', '同一 scope 与 memory key 存在多个未被 supersede 的 head，必须先人工修复。', { scopeKind: scope.kind, scopeId: scope.id, memoryKey });
    }
    return rows[0] ? mapMemory(rows[0]) : undefined;
  }

  private insert(record: LongTermMemoryRecord): void {
    this.db.execute(
      `INSERT INTO long_term_memories
         (id, memory_key, scope_kind, scope_id, memory_kind, content, content_sha256, effect,
          source_kind, source_ref, source_observed_at, source_content_sha256, confirmation_level,
          confidence, review_after, supersedes_id, tombstone, tombstoned_at, tombstone_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
      [
        record.id,
        record.memoryKey,
        record.scope.kind,
        record.scope.id,
        record.kind,
        record.content,
        record.contentSha256,
        record.effect,
        record.source.kind,
        record.source.reference,
        record.source.observedAt,
        record.source.contentSha256 ?? null,
        record.confirmationLevel,
        record.confidence,
        record.reviewAfter,
        record.supersedesId,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }
}

const selectMemoryColumns = `SELECT id, memory_key, scope_kind, scope_id, memory_kind, content, content_sha256,
  effect, source_kind, source_ref, source_observed_at, source_content_sha256, confirmation_level,
  confidence, review_after, supersedes_id, tombstone, tombstoned_at, tombstone_reason, created_at, updated_at
  FROM long_term_memories`;

function prepareCandidate(input: RecordLongTermMemoryCandidateInput, kind: LongTermMemoryKind): LongTermMemoryRecord {
  const recordedAt = validTimestamp(input.recordedAt, 'recordedAt');
  const reviewAfter = validTimestamp(input.reviewAfter, 'reviewAfter');
  const content = boundedText(input.content, 'content', 1, 16_384);
  if (!input.source || typeof input.source !== 'object') throw invalidArgument('source 必须是明确的长期记忆来源。', { field: 'source' });
  const source: LongTermMemorySource = {
    kind: validSourceKind(input.source.kind),
    reference: boundedText(input.source.reference, 'source.reference', 1, 2_048),
    observedAt: validTimestamp(input.source.observedAt, 'source.observedAt'),
    contentSha256: input.source.contentSha256 === undefined || input.source.contentSha256 === null ? null : validSha256(input.source.contentSha256, 'source.contentSha256'),
  };
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw invalidArgument('confidence 必须位于 0 到 1。', { confidence: input.confidence });
  const effect = validEffect(input.effect);
  const confirmationLevel = validConfirmationLevel(input.confirmationLevel);
  if (effect === 'external_state' && (confirmationLevel !== 'explicit' || (source.kind !== 'user_explicit' && source.kind !== 'project_instruction'))) {
    throw memoryError('ZEUS_LONG_TERM_MEMORY_CONFIRMATION_REQUIRED', '会影响外部状态的长期规则必须来自用户或项目指令，并具有 explicit 确认等级。', {
      effect,
      sourceKind: source.kind,
      confirmationLevel,
    });
  }
  return {
    id: input.id === undefined ? randomUUID() : requiredIdentity(input.id, 'id'),
    memoryKey: validMemoryKey(input.memoryKey),
    scope: normalizeScope(input.scope),
    kind,
    content,
    contentSha256: createHash('sha256').update(content).digest('hex'),
    effect,
    source,
    confirmationLevel,
    confidence: input.confidence,
    reviewAfter,
    supersedesId: input.supersedesId === undefined || input.supersedesId === null ? null : requiredIdentity(input.supersedesId, 'supersedesId'),
    tombstone: false,
    tombstonedAt: null,
    tombstoneReason: null,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  };
}

function mapMemory(row: LongTermMemoryRow): LongTermMemoryRecord {
  return {
    id: row.id,
    memoryKey: row.memory_key,
    scope: { kind: row.scope_kind, id: row.scope_id },
    kind: row.memory_kind,
    content: row.content,
    contentSha256: row.content_sha256,
    effect: row.effect,
    source: { kind: row.source_kind, reference: row.source_ref, observedAt: row.source_observed_at, contentSha256: row.source_content_sha256 },
    confirmationLevel: row.confirmation_level,
    confidence: row.confidence,
    reviewAfter: row.review_after,
    supersedesId: row.supersedes_id,
    tombstone: row.tombstone === 1,
    tombstonedAt: row.tombstoned_at,
    tombstoneReason: row.tombstone_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compareResolvedMemory(left: LongTermMemoryRecord, right: LongTermMemoryRecord): number {
  const kindPriority: Record<LongTermMemoryKind, number> = { safety_boundary: 0, stable_workflow: 1, preference: 2 };
  return kindPriority[left.kind] - kindPriority[right.kind] || left.memoryKey.localeCompare(right.memoryKey) || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function sameRecord(left: LongTermMemoryRecord, right: LongTermMemoryRecord): boolean {
  return (
    left.memoryKey === right.memoryKey &&
    left.scope.kind === right.scope.kind &&
    left.scope.id === right.scope.id &&
    left.kind === right.kind &&
    left.contentSha256 === right.contentSha256 &&
    left.effect === right.effect &&
    left.source.kind === right.source.kind &&
    left.source.reference === right.source.reference &&
    left.source.observedAt === right.source.observedAt &&
    left.source.contentSha256 === right.source.contentSha256 &&
    left.confirmationLevel === right.confirmationLevel &&
    left.confidence === right.confidence &&
    left.reviewAfter === right.reviewAfter &&
    left.supersedesId === right.supersedesId &&
    left.createdAt === right.createdAt
  );
}

function normalizeScope(scope: LongTermMemoryScope): LongTermMemoryScope {
  if (!scope || (scope.kind !== 'global' && scope.kind !== 'project')) throw invalidArgument('scope.kind 必须是 global 或 project。', { field: 'scope.kind' });
  if (scope.kind === 'global') {
    if (scope.id !== '*') throw invalidArgument('global scope 的 id 必须固定为 *。', { field: 'scope.id' });
    return { kind: 'global', id: '*' };
  }
  return { kind: 'project', id: requiredIdentity(scope.id, 'scope.id') };
}

function isAcceptedKind(value: LongTermMemoryCandidateKind): value is LongTermMemoryKind {
  return acceptedLongTermMemoryKinds.includes(value as LongTermMemoryKind);
}

function validCandidateKind(value: LongTermMemoryCandidateKind): LongTermMemoryCandidateKind {
  if (isAcceptedKind(value) || rejectedLongTermMemoryCandidateKinds.includes(value as RejectedLongTermMemoryCandidateKind)) return value;
  throw invalidArgument('未知长期记忆候选类型。', { value: String(value) });
}

function validEffect(value: LongTermMemoryEffect): LongTermMemoryEffect {
  if (value !== 'advisory' && value !== 'external_state') throw invalidArgument('effect 必须是 advisory 或 external_state。', { value: String(value) });
  return value;
}

function validConfirmationLevel(value: LongTermMemoryConfirmationLevel): LongTermMemoryConfirmationLevel {
  if (value !== 'observed' && value !== 'confirmed' && value !== 'explicit') throw invalidArgument('confirmationLevel 不合法。', { value: String(value) });
  return value;
}

function validSourceKind(value: LongTermMemorySourceKind): LongTermMemorySourceKind {
  if (value !== 'user_explicit' && value !== 'project_instruction' && value !== 'repeated_confirmation' && value !== 'manual_import') {
    throw invalidArgument('source.kind 不合法。', { value: String(value) });
  }
  return value;
}

function validMemoryKey(value: string): string {
  const key = boundedText(value, 'memoryKey', 1, 160);
  if (!/^[a-z][a-z0-9_.:-]*$/u.test(key)) throw invalidArgument('memoryKey 必须是稳定的小写标识符。', { field: 'memoryKey' });
  return key;
}

function requiredIdentity(value: string, field: string): string {
  return boundedText(value, field, 1, 512);
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

function validSha256(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw invalidArgument(`${field} 必须是小写 SHA-256。`, { field });
  return value;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidArgument(`${field} 必须是 ${minimum} 到 ${maximum} 之间的安全整数。`, { field, minimum, maximum });
  return value;
}

function invalidArgument(message: string, details: Readonly<Record<string, string | number | boolean | null>>): LongTermMemoryStoreError {
  return memoryError('ZEUS_LONG_TERM_MEMORY_INVALID_ARGUMENT', message, details);
}

function memoryError(code: LongTermMemoryStoreErrorCode, message: string, details: Readonly<Record<string, string | number | boolean | null>> = {}): LongTermMemoryStoreError {
  return new LongTermMemoryStoreError(code, message, details);
}
