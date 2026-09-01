import { randomId } from './randomId.js';
import { type ArtifactRef, type ArtifactStore, artifactStoreGeneration } from './artifactStore.js';
import type { ZeusDatabasePort } from './databasePort.js';
import type { TurnChangeFileType, TurnChangeSetState } from '@zeus/shared';

function assertEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) throw new Error(`Invalid ${label}: ${String(value)}`);
  return value as T[number];
}

export interface ZeusTurnChangeSetRecord {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  providerTurnId: string;
  state: TurnChangeSetState;
  unifiedDiff: string;
  unifiedDiffArtifactRef: ArtifactRef | null;
  unifiedDiffByteLength: number;
  preImageDigest: string | null;
  postImageDigest: string | null;
  conflictJson: string | null;
  unavailableReason: string | null;
  journalRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTurnChangeFileRecord {
  id: string;
  changeSetId: string;
  sourceItemId: string | null;
  sourceIndex: number;
  oldPath: string | null;
  newPath: string | null;
  changeType: TurnChangeFileType;
  addedLines: number;
  deletedLines: number;
  preHash: string | null;
  postHash: string | null;
  preExists: boolean;
  postExists: boolean;
  preMode: number | null;
  postMode: number | null;
  unifiedDiff: string;
  unifiedDiffArtifactRef: ArtifactRef | null;
  unifiedDiffByteLength: number;
  preBlobRef: string | null;
  postBlobRef: string | null;
  reversible: boolean;
  unavailableReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export const turnChangeDiffArtifactGeneration = '2026-08-21-turn-change-diff-artifact-v1';
export const turnChangeInlineDiffMaximumBytes = 64 * 1024;

export class TurnChangeSetRepository {
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly artifactStore?: ArtifactStore,
  ) {}

  upsert(
    input: Omit<ZeusTurnChangeSetRecord, 'id' | 'createdAt' | 'updatedAt' | 'unifiedDiffArtifactRef' | 'unifiedDiffByteLength'> & {
      id?: string;
      createdAt?: string;
      updatedAt: string;
    },
  ): ZeusTurnChangeSetRecord {
    const state = assertEnum(input.state, ['capturing', 'applied', 'undoing', 'undone', 'reapplying', 'conflicted', 'unavailable'] as const, 'turn change set state');
    const existingRow = this.db.get<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE conversation_id = ? AND turn_id = ?`, [input.conversationId, input.turnId]);
    const id = existingRow?.id ?? input.id ?? `turn_change_set_${randomId(12)}`;
    const createdAt = existingRow?.created_at ?? input.createdAt ?? input.updatedAt;
    const owner = { kind: 'turn_change_set_diff', id, generationId: turnChangeDiffArtifactGeneration, projectId: input.projectId, conversationId: input.conversationId };
    const previousRef = parseArtifactRefJson(existingRow?.unified_diff_artifact_ref_json ?? null);
    const prepared = prepareUnifiedDiffStorage(this.artifactStore, input.unifiedDiff, owner, input.updatedAt);
    try {
      this.db.execute(
        `INSERT INTO turn_change_sets
           (id, project_id, conversation_id, turn_id, provider_turn_id, state, unified_diff,
            unified_diff_artifact_ref_json, unified_diff_byte_length, unified_diff_character_length,
            pre_image_digest, post_image_digest, conflict_json, unavailable_reason, journal_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, turn_id) DO UPDATE SET
           provider_turn_id = excluded.provider_turn_id, state = excluded.state,
           unified_diff = excluded.unified_diff,
           unified_diff_artifact_ref_json = excluded.unified_diff_artifact_ref_json,
           unified_diff_byte_length = excluded.unified_diff_byte_length,
           unified_diff_character_length = excluded.unified_diff_character_length,
           pre_image_digest = excluded.pre_image_digest,
           post_image_digest = excluded.post_image_digest, conflict_json = excluded.conflict_json,
           unavailable_reason = excluded.unavailable_reason, journal_ref = excluded.journal_ref,
           updated_at = excluded.updated_at`,
        [
          id,
          input.projectId,
          input.conversationId,
          input.turnId,
          input.providerTurnId,
          state,
          prepared.projection,
          prepared.artifactRef ? JSON.stringify(prepared.artifactRef) : null,
          prepared.byteLength,
          prepared.characterLength,
          input.preImageDigest,
          input.postImageDigest,
          input.conflictJson,
          input.unavailableReason,
          input.journalRef,
          createdAt,
          input.updatedAt,
        ],
      );
    } catch (error) {
      compensatePreparedDiff(this.artifactStore, prepared.artifactRef, previousRef, owner, input.updatedAt);
      throw error;
    }
    releaseReplacedDiff(this.artifactStore, previousRef, prepared.artifactRef, owner, input.updatedAt);
    return this.getByTurn(input.conversationId, input.turnId)!;
  }

  getById(id: string): ZeusTurnChangeSetRecord | undefined {
    const row = this.db.get<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE id = ?`, [id]);
    return row ? this.mapRow(row) : undefined;
  }

  getByTurn(conversationId: string, turnId: string): ZeusTurnChangeSetRecord | undefined {
    const row = this.db.get<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE conversation_id = ? AND turn_id = ?`, [conversationId, turnId]);
    return row ? this.mapRow(row) : undefined;
  }

  getByProviderTurn(conversationId: string, providerTurnId: string): ZeusTurnChangeSetRecord | undefined {
    const row = this.db.get<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE conversation_id = ? AND provider_turn_id = ?`, [conversationId, providerTurnId]);
    return row ? this.mapRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusTurnChangeSetRecord[] {
    return this.db.select<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map((row) => this.mapRow(row));
  }

  listInProgress(): ZeusTurnChangeSetRecord[] {
    return this.db.select<DbTurnChangeSetRow>(`SELECT * FROM turn_change_sets WHERE state IN ('undoing', 'reapplying') ORDER BY updated_at, id`).map((row) => this.mapRow(row));
  }

  private mapRow(row: DbTurnChangeSetRow): ZeusTurnChangeSetRecord {
    return mapTurnChangeSetRow(row, materializeUnifiedDiff(this.artifactStore, row.unified_diff, row.unified_diff_artifact_ref_json, 'turn_change_set_diff', row.id));
  }
}

export class TurnChangeFileRepository {
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly artifactStore?: ArtifactStore,
  ) {}

  upsert(
    input: Omit<ZeusTurnChangeFileRecord, 'id' | 'createdAt' | 'updatedAt' | 'unifiedDiffArtifactRef' | 'unifiedDiffByteLength'> & {
      id?: string;
      createdAt?: string;
      updatedAt: string;
      replacePreImage?: boolean;
    },
  ): ZeusTurnChangeFileRecord {
    const changeType = assertEnum(input.changeType, ['added', 'deleted', 'modified', 'renamed', 'binary'] as const, 'turn change file type');
    const existing =
      input.sourceItemId === null
        ? undefined
        : this.db.get<DbTurnChangeFileRow>(`SELECT * FROM turn_change_files WHERE change_set_id = ? AND source_item_id = ? AND source_index = ?`, [input.changeSetId, input.sourceItemId, input.sourceIndex]);
    const id = existing?.id ?? input.id ?? `turn_change_file_${randomId(12)}`;
    const createdAt = existing?.created_at ?? input.createdAt ?? input.updatedAt;
    const ownership = this.db.get<{ project_id: string; conversation_id: string }>(`SELECT project_id, conversation_id FROM turn_change_sets WHERE id = ?`, [input.changeSetId]);
    if (!ownership) throw new Error(`Turn change set not found: ${input.changeSetId}`);
    const owner = { kind: 'turn_change_file_diff', id, generationId: turnChangeDiffArtifactGeneration, projectId: ownership.project_id, conversationId: ownership.conversation_id };
    const previousRef = parseArtifactRefJson(existing?.unified_diff_artifact_ref_json ?? null);
    const prepared = prepareUnifiedDiffStorage(this.artifactStore, input.unifiedDiff, owner, input.updatedAt);
    try {
      this.db.execute(
        `INSERT INTO turn_change_files
           (id, change_set_id, source_item_id, source_index, old_path, new_path, change_type,
            added_lines, deleted_lines, pre_hash, post_hash, pre_exists, post_exists,
            pre_mode, post_mode, unified_diff, unified_diff_artifact_ref_json, unified_diff_byte_length, unified_diff_character_length,
            pre_blob_ref, post_blob_ref, reversible, unavailable_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(change_set_id, source_item_id, source_index) DO UPDATE SET
           old_path = excluded.old_path, new_path = excluded.new_path, change_type = excluded.change_type,
           added_lines = excluded.added_lines, deleted_lines = excluded.deleted_lines,
           pre_hash = CASE WHEN ? = 1 THEN excluded.pre_hash ELSE COALESCE(turn_change_files.pre_hash, excluded.pre_hash) END,
           post_hash = excluded.post_hash,
           pre_exists = CASE WHEN ? = 1 THEN excluded.pre_exists ELSE turn_change_files.pre_exists END,
           post_exists = excluded.post_exists,
           pre_mode = CASE WHEN ? = 1 THEN excluded.pre_mode ELSE COALESCE(turn_change_files.pre_mode, excluded.pre_mode) END,
           post_mode = excluded.post_mode, unified_diff = excluded.unified_diff,
           unified_diff_artifact_ref_json = excluded.unified_diff_artifact_ref_json,
           unified_diff_byte_length = excluded.unified_diff_byte_length,
           unified_diff_character_length = excluded.unified_diff_character_length,
           pre_blob_ref = CASE WHEN ? = 1 THEN excluded.pre_blob_ref ELSE COALESCE(turn_change_files.pre_blob_ref, excluded.pre_blob_ref) END,
           post_blob_ref = excluded.post_blob_ref, reversible = excluded.reversible,
           unavailable_reason = excluded.unavailable_reason, updated_at = excluded.updated_at`,
        [
          id,
          input.changeSetId,
          input.sourceItemId,
          input.sourceIndex,
          input.oldPath,
          input.newPath,
          changeType,
          input.addedLines,
          input.deletedLines,
          input.preHash,
          input.postHash,
          input.preExists ? 1 : 0,
          input.postExists ? 1 : 0,
          input.preMode,
          input.postMode,
          prepared.projection,
          prepared.artifactRef ? JSON.stringify(prepared.artifactRef) : null,
          prepared.byteLength,
          prepared.characterLength,
          input.preBlobRef,
          input.postBlobRef,
          input.reversible ? 1 : 0,
          input.unavailableReason,
          createdAt,
          input.updatedAt,
          input.replacePreImage ? 1 : 0,
          input.replacePreImage ? 1 : 0,
          input.replacePreImage ? 1 : 0,
          input.replacePreImage ? 1 : 0,
        ],
      );
    } catch (error) {
      compensatePreparedDiff(this.artifactStore, prepared.artifactRef, previousRef, owner, input.updatedAt);
      throw error;
    }
    releaseReplacedDiff(this.artifactStore, previousRef, prepared.artifactRef, owner, input.updatedAt);
    return this.getById(id)!;
  }

  getById(id: string): ZeusTurnChangeFileRecord | undefined {
    const row = this.db.get<DbTurnChangeFileRow>(`SELECT * FROM turn_change_files WHERE id = ?`, [id]);
    return row ? this.mapRow(row) : undefined;
  }

  listByChangeSet(changeSetId: string): ZeusTurnChangeFileRecord[] {
    return this.db.select<DbTurnChangeFileRow>(`SELECT * FROM turn_change_files WHERE change_set_id = ? ORDER BY source_index, id`, [changeSetId]).map((row) => this.mapRow(row));
  }

  private mapRow(row: DbTurnChangeFileRow): ZeusTurnChangeFileRecord {
    return mapTurnChangeFileRow(row, materializeUnifiedDiff(this.artifactStore, row.unified_diff, row.unified_diff_artifact_ref_json, 'turn_change_file_diff', row.id));
  }
}

interface DbTurnChangeSetRow {
  id: string;
  project_id: string;
  conversation_id: string;
  turn_id: string;
  provider_turn_id: string;
  state: TurnChangeSetState;
  unified_diff: string;
  unified_diff_artifact_ref_json: string | null;
  unified_diff_byte_length: number;
  unified_diff_character_length: number;
  pre_image_digest: string | null;
  post_image_digest: string | null;
  conflict_json: string | null;
  unavailable_reason: string | null;
  journal_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTurnChangeFileRow {
  id: string;
  change_set_id: string;
  source_item_id: string | null;
  source_index: number;
  old_path: string | null;
  new_path: string | null;
  change_type: TurnChangeFileType;
  added_lines: number;
  deleted_lines: number;
  pre_hash: string | null;
  post_hash: string | null;
  pre_exists: number;
  post_exists: number;
  pre_mode: number | null;
  post_mode: number | null;
  unified_diff: string;
  unified_diff_artifact_ref_json: string | null;
  unified_diff_byte_length: number;
  unified_diff_character_length: number;
  pre_blob_ref: string | null;
  post_blob_ref: string | null;
  reversible: number;
  unavailable_reason: string | null;
  created_at: string;
  updated_at: string;
}

function prepareUnifiedDiffStorage(
  artifactStore: ArtifactStore | undefined,
  unifiedDiff: string,
  owner: ArtifactRef['owner'],
  createdAt: string,
): { projection: string; artifactRef: ArtifactRef | null; byteLength: number; characterLength: number } {
  const byteLength = Buffer.byteLength(unifiedDiff, 'utf8');
  const characterLength = Array.from(unifiedDiff).length;
  if (byteLength <= turnChangeInlineDiffMaximumBytes) return { projection: unifiedDiff, artifactRef: null, byteLength, characterLength };
  if (!artifactStore) throw new Error('ZEUS_TURN_CHANGE_DIFF_ARTIFACT_STORE_REQUIRED');
  const artifactRef = artifactStore.putTextSync({
    text: unifiedDiff,
    mimeType: 'text/x-diff; charset=utf-8',
    owner,
    compression: 'gzip-v1',
    createdAt,
  });
  const preview = unifiedDiff.slice(0, 4_096);
  return {
    projection: `${preview}${preview.length < unifiedDiff.length ? '\n…[完整 diff 已外置为 ArtifactRef]…\n' : ''}`,
    artifactRef,
    byteLength,
    characterLength,
  };
}

function materializeUnifiedDiff(artifactStore: ArtifactStore | undefined, projection: string, serializedRef: string | null, ownerKind: string, ownerId: string): string {
  const ref = parseArtifactRefJson(serializedRef);
  if (!ref) return projection;
  if (!artifactStore) throw new Error('ZEUS_TURN_CHANGE_DIFF_ARTIFACT_STORE_REQUIRED');
  if (ref.owner.kind !== ownerKind || ref.owner.id !== ownerId) throw new Error('ZEUS_TURN_CHANGE_DIFF_ARTIFACT_OWNER_MISMATCH');
  const { bytes } = artifactStore.readAuthorizedSync({ sha256: ref.sha256, owner: { kind: ownerKind, id: ownerId }, maximumContentBytes: Math.max(1, ref.contentByteLength) });
  return Buffer.from(bytes).toString('utf8');
}

function compensatePreparedDiff(artifactStore: ArtifactStore | undefined, next: ArtifactRef | null, previous: ArtifactRef | null, owner: ArtifactRef['owner'], releasedAt: string): void {
  if (!artifactStore || !next || next.sha256 === previous?.sha256) return;
  artifactStore.releaseOwnerHolds({ owner, sha256: next.sha256, releasedAt });
  artifactStore.detachOwner({ sha256: next.sha256, owner });
}

function releaseReplacedDiff(artifactStore: ArtifactStore | undefined, previous: ArtifactRef | null, next: ArtifactRef | null, owner: ArtifactRef['owner'], releasedAt: string): void {
  if (!artifactStore || !previous || previous.sha256 === next?.sha256) return;
  artifactStore.releaseOwnerHolds({ owner, sha256: previous.sha256, releasedAt });
  artifactStore.detachOwner({ sha256: previous.sha256, owner });
}

function parseArtifactRefJson(value: string | null): ArtifactRef | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as Partial<ArtifactRef>;
  if (
    parsed.storageGeneration !== artifactStoreGeneration ||
    typeof parsed.sha256 !== 'string' ||
    typeof parsed.contentSha256 !== 'string' ||
    typeof parsed.byteLength !== 'number' ||
    typeof parsed.contentByteLength !== 'number' ||
    typeof parsed.mimeType !== 'string' ||
    (parsed.encoding !== 'identity' && parsed.encoding !== 'gzip-v1') ||
    typeof parsed.generationId !== 'string' ||
    typeof parsed.relativePath !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    !parsed.owner ||
    typeof parsed.owner.kind !== 'string' ||
    typeof parsed.owner.id !== 'string'
  ) {
    throw new Error('ZEUS_TURN_CHANGE_DIFF_ARTIFACT_REF_INVALID');
  }
  return parsed as ArtifactRef;
}

function mapTurnChangeSetRow(row: DbTurnChangeSetRow, unifiedDiff = row.unified_diff): ZeusTurnChangeSetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    providerTurnId: row.provider_turn_id,
    state: row.state,
    unifiedDiff,
    unifiedDiffArtifactRef: parseArtifactRefJson(row.unified_diff_artifact_ref_json),
    unifiedDiffByteLength: row.unified_diff_byte_length,
    preImageDigest: row.pre_image_digest,
    postImageDigest: row.post_image_digest,
    conflictJson: row.conflict_json,
    unavailableReason: row.unavailable_reason,
    journalRef: row.journal_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTurnChangeFileRow(row: DbTurnChangeFileRow, unifiedDiff = row.unified_diff): ZeusTurnChangeFileRecord {
  return {
    id: row.id,
    changeSetId: row.change_set_id,
    sourceItemId: row.source_item_id,
    sourceIndex: row.source_index,
    oldPath: row.old_path,
    newPath: row.new_path,
    changeType: row.change_type,
    addedLines: row.added_lines,
    deletedLines: row.deleted_lines,
    preHash: row.pre_hash,
    postHash: row.post_hash,
    preExists: row.pre_exists === 1,
    postExists: row.post_exists === 1,
    preMode: row.pre_mode,
    postMode: row.post_mode,
    unifiedDiff,
    unifiedDiffArtifactRef: parseArtifactRefJson(row.unified_diff_artifact_ref_json),
    unifiedDiffByteLength: row.unified_diff_byte_length,
    preBlobRef: row.pre_blob_ref,
    postBlobRef: row.post_blob_ref,
    reversible: row.reversible === 1,
    unavailableReason: row.unavailable_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
