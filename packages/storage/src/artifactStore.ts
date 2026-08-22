import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statfsSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, stat, statfs, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { gunzip, gunzipSync, gzip, gzipSync } from 'node:zlib';
import type { ZeusDatabasePort, ZeusDatabaseWriteFaultReporter } from './databasePort.js';

export const artifactStoreGeneration = '2026-08-21-content-addressed-artifacts-v1';

export type ArtifactEncoding = 'identity' | 'gzip-v1';
export type ArtifactObjectState = 'staging' | 'promoted' | 'quarantining' | 'quarantined' | 'damaged' | 'deleted';

export type ArtifactStoreErrorCode =
  | 'ZEUS_ARTIFACT_INVALID_ARGUMENT'
  | 'ZEUS_ARTIFACT_PATH_ESCAPE'
  | 'ZEUS_ARTIFACT_SOURCE_CHANGED'
  | 'ZEUS_ARTIFACT_HASH_COLLISION'
  | 'ZEUS_ARTIFACT_TRANSITIONING'
  | 'ZEUS_ARTIFACT_NOT_FOUND'
  | 'ZEUS_ARTIFACT_OWNER_MISMATCH'
  | 'ZEUS_ARTIFACT_DAMAGED'
  | 'ZEUS_ARTIFACT_GC_CONFLICT'
  | 'ZEUS_ARTIFACT_GC_DELAY_NOT_ELAPSED'
  | 'ZEUS_ARTIFACT_CAPACITY_EXHAUSTED'
  | 'ZEUS_ARTIFACT_EXTERNAL_WRITE_FAILED';

export class ArtifactStoreError extends Error {
  readonly name = 'ArtifactStoreError';

  constructor(
    readonly code: ArtifactStoreErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export interface ArtifactOwnerIdentity {
  kind: string;
  id: string;
  generationId: string;
  projectId?: string | null;
  conversationId?: string | null;
}

export interface ArtifactRef {
  storageGeneration: typeof artifactStoreGeneration;
  sha256: string;
  contentSha256: string;
  byteLength: number;
  contentByteLength: number;
  mimeType: string;
  encoding: ArtifactEncoding;
  generationId: string;
  relativePath: string;
  owner: ArtifactOwnerIdentity;
  createdAt: string;
}

export interface ArtifactPutBytesInput {
  bytes: Uint8Array;
  mimeType: string;
  owner: ArtifactOwnerIdentity;
  compression?: 'never' | 'gzip-v1';
  createdAt?: string;
}

export interface ArtifactPutFileInput {
  sourcePath: string;
  mimeType: string;
  owner: ArtifactOwnerIdentity;
  createdAt?: string;
}

export interface ArtifactStoreOptions {
  quotaBytes?: number | null;
  minimumFreeBytes?: number;
  /** 真实外部文件系统硬故障必须上报 Core；配额拒绝不上报。 */
  writeFaultReporter?: ZeusDatabaseWriteFaultReporter;
  /** 只供故障注入/演练；产品运行时不得配置。 */
  faultInjection?: { beforeFileOperation(phase: 'staging_write' | 'recovery_preflight'): void };
}

export interface ArtifactGcCandidateManifest {
  id: string;
  state: 'candidate' | 'quarantining' | 'quarantined' | 'restoring' | 'cancelled' | 'deleted';
  policy: {
    eligibleBefore: string;
    limit: number;
    minimumQuarantineMs: number;
  };
  manifestSha256: string;
  artifactCount: number;
  totalBytes: number;
  createdAt: string;
  quarantinedAt: string | null;
  deleteAfter: string | null;
}

export type ArtifactRetentionOwnerClass = 'active_task' | 'active_conversation' | 'archived_conversation' | 'deleted_owner' | 'export' | 'restored_recovery';

export interface ArtifactRetentionPolicy {
  ownerClass: ArtifactRetentionOwnerClass;
  keepWhileOwned: boolean;
  minimumRetentionMs: number;
  deletionRequiresExplicitOwnerDetach: boolean;
  recoveryHold: boolean;
}

export const artifactRetentionPolicies: Readonly<Record<ArtifactRetentionOwnerClass, ArtifactRetentionPolicy>> = {
  active_task: { ownerClass: 'active_task', keepWhileOwned: true, minimumRetentionMs: 30 * 24 * 60 * 60 * 1_000, deletionRequiresExplicitOwnerDetach: true, recoveryHold: false },
  active_conversation: { ownerClass: 'active_conversation', keepWhileOwned: true, minimumRetentionMs: 30 * 24 * 60 * 60 * 1_000, deletionRequiresExplicitOwnerDetach: true, recoveryHold: false },
  archived_conversation: { ownerClass: 'archived_conversation', keepWhileOwned: true, minimumRetentionMs: 365 * 24 * 60 * 60 * 1_000, deletionRequiresExplicitOwnerDetach: true, recoveryHold: false },
  deleted_owner: { ownerClass: 'deleted_owner', keepWhileOwned: false, minimumRetentionMs: 7 * 24 * 60 * 60 * 1_000, deletionRequiresExplicitOwnerDetach: true, recoveryHold: false },
  export: { ownerClass: 'export', keepWhileOwned: true, minimumRetentionMs: 365 * 24 * 60 * 60 * 1_000, deletionRequiresExplicitOwnerDetach: true, recoveryHold: true },
  restored_recovery: { ownerClass: 'restored_recovery', keepWhileOwned: true, minimumRetentionMs: 30 * 24 * 60 * 60 * 1_000, deletionRequiresExplicitOwnerDetach: true, recoveryHold: true },
};

export interface ArtifactCapacityDiagnostic {
  generation: typeof artifactStoreGeneration;
  observedAt: string;
  filesystem: { totalBytes: number; freeBytes: number; availableBytes: number; minimumFreeBytes: number };
  quota: { configuredBytes: number | null; storedBytes: number; remainingBytes: number | null; exhausted: boolean };
  categories: Array<{ category: string; objects: number; storedBytes: number; contentBytes: number }>;
  largest: Array<{ sha256: string; mimeType: string; storedBytes: number; contentBytes: number; ownerKinds: string[] }>;
  reclaimability: { reclaimableObjects: number; reclaimableBytes: number; blockedByOwner: number; blockedByHold: number; transitioning: number };
  growth: { sampledFrom: string | null; sampledTo: string | null; bytesPerDay: number | null; samples: number };
  unresolvedFaults: Array<{ id: string; phase: string; code: string; errno: string | null; requestedBytes: number | null; occurredAt: string }>;
}

export interface ArtifactStorageRecoveryPreflight {
  generation: typeof artifactStoreGeneration;
  stagingWrite: 'ok' | 'failed';
  freeSpace: 'ok' | 'failed';
  availableBytes: number | null;
  minimumFreeBytes: number;
  eligibleForCoreRestart: boolean;
  errorCode: string | null;
  checkedAt: string;
}

interface ArtifactObjectRow {
  sha256: string;
  content_sha256: string;
  byte_length: number;
  content_byte_length: number;
  mime_type: string;
  encoding: ArtifactEncoding;
  generation_id: string;
  relative_path: string;
  state: ArtifactObjectState;
  created_at: string;
  promoted_at: string | null;
  quarantined_at: string | null;
  deleted_at: string | null;
}

interface ArtifactOwnerRow {
  owner_kind: string;
  owner_id: string;
  artifact_sha256: string;
  project_id: string | null;
  conversation_id: string | null;
  generation_id: string;
  created_at: string;
}

interface StagingRow {
  id: string;
  artifact_sha256: string;
  staging_relative_path: string;
  state: 'pending' | 'promotion_failed' | 'promoted' | 'discarded';
}

interface GcManifestRow {
  id: string;
  state: ArtifactGcCandidateManifest['state'];
  policy_json: string;
  manifest_sha256: string;
  artifact_count: number;
  total_bytes: number;
  created_at: string;
  quarantined_at: string | null;
  delete_after: string | null;
}

interface GcItemRow {
  manifest_id: string;
  artifact_sha256: string;
  relative_path: string;
  byte_length: number;
  state: 'candidate' | 'quarantining' | 'quarantined' | 'retained' | 'deleted';
  quarantine_relative_path: string | null;
}

const artifactSchemaMigrationId = '20260821_022_content_addressed_artifacts';
const defaultCompressionThreshold = 4 * 1024;
const maximumIdentityLength = 512;
const maximumMimeTypeLength = 256;
const defaultReadLimit = 8 * 1024 * 1024;
const defaultMinimumFreeBytes = 512 * 1024 * 1024;

/** 建立内容寻址对象、稳定 owner 关系、可恢复 staging 与两阶段 GC 清单。 */
export function migrateArtifactStoreSchema(db: ZeusDatabasePort): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS artifact_objects (
      sha256 TEXT PRIMARY KEY,
      content_sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      content_byte_length INTEGER NOT NULL CHECK (content_byte_length >= 0),
      mime_type TEXT NOT NULL,
      encoding TEXT NOT NULL CHECK (encoding IN ('identity', 'gzip-v1')),
      generation_id TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('staging', 'promoted', 'quarantining', 'quarantined', 'damaged', 'deleted')),
      created_at TEXT NOT NULL,
      promoted_at TEXT,
      quarantined_at TEXT,
      deleted_at TEXT
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS artifact_owners (
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      project_id TEXT,
      conversation_id TEXT,
      generation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (owner_kind, owner_id, artifact_sha256)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_artifact_owners_artifact ON artifact_owners(artifact_sha256, owner_kind, owner_id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_artifact_owners_conversation ON artifact_owners(conversation_id, owner_kind, owner_id) WHERE conversation_id IS NOT NULL`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS artifact_staging_operations (
      id TEXT PRIMARY KEY,
      artifact_sha256 TEXT NOT NULL UNIQUE,
      staging_relative_path TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('pending', 'promotion_failed', 'promoted', 'discarded')),
      last_error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS artifact_gc_manifests (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('candidate', 'quarantining', 'quarantined', 'restoring', 'cancelled', 'deleted')),
      policy_json TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      artifact_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      quarantined_at TEXT,
      delete_after TEXT
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS artifact_gc_manifest_items (
      manifest_id TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('candidate', 'quarantining', 'quarantined', 'retained', 'deleted')),
      quarantine_relative_path TEXT,
      PRIMARY KEY (manifest_id, artifact_sha256)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_artifact_gc_active_object ON artifact_gc_manifest_items(artifact_sha256, state)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS artifact_retention_holds (
      id TEXT PRIMARY KEY,
      artifact_sha256 TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      owner_class TEXT NOT NULL,
      reason TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'released')),
      retain_until TEXT,
      created_at TEXT NOT NULL,
      released_at TEXT
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_artifact_retention_active ON artifact_retention_holds(artifact_sha256, state, retain_until)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS artifact_capacity_samples (
      id TEXT PRIMARY KEY,
      stored_bytes INTEGER NOT NULL,
      content_bytes INTEGER NOT NULL,
      object_count INTEGER NOT NULL,
      free_bytes INTEGER NOT NULL,
      observed_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_artifact_capacity_samples_time ON artifact_capacity_samples(observed_at, id)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS artifact_storage_faults (
      id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      error_code TEXT NOT NULL,
      errno TEXT,
      message TEXT NOT NULL,
      requested_bytes INTEGER,
      occurred_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_artifact_storage_faults_open ON artifact_storage_faults(resolved_at, occurred_at)`);
  db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
    artifactSchemaMigrationId,
    '建立内容寻址 ArtifactRef、staging 提升、稳定 owner 与延迟 GC 清单',
    `sha256:${createHash('sha256').update('artifact-objects-owners-staging-gc-v1').digest('hex')}`,
    new Date().toISOString(),
  ]);
}

/**
 * 文件系统只保存不可变大对象，SQLite 只保存身份、owner、状态与审计清单。
 * 所有删除都必须经过候选清单、重新验引、隔离期和显式 manifest hash 确认。
 */
export class ArtifactStore {
  private readonly absoluteRoot: string;
  private readonly quotaBytes: number | null;
  private readonly minimumFreeBytes: number;
  private readonly writeFaultReporter: ZeusDatabaseWriteFaultReporter | undefined;
  private readonly faultInjection: ArtifactStoreOptions['faultInjection'];

  constructor(
    private readonly db: ZeusDatabasePort,
    rootPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
    options: ArtifactStoreOptions = {},
  ) {
    if (!rootPath.trim()) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact 根目录不能为空。');
    this.absoluteRoot = resolve(rootPath);
    this.quotaBytes = options.quotaBytes == null ? null : boundedInteger(options.quotaBytes, 'quotaBytes', 1, Number.MAX_SAFE_INTEGER);
    this.minimumFreeBytes = boundedInteger(options.minimumFreeBytes ?? defaultMinimumFreeBytes, 'minimumFreeBytes', 0, Number.MAX_SAFE_INTEGER);
    this.writeFaultReporter = options.writeFaultReporter;
    this.faultInjection = options.faultInjection;
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.absoluteRoot);
    await ensurePrivateDirectory(this.absolute('.staging'));
    await ensurePrivateDirectory(this.absolute('objects'));
    await ensurePrivateDirectory(this.absolute('.quarantine'));
    const [rootStat, stagingStat, objectStat] = await Promise.all([stat(this.absoluteRoot), stat(this.absolute('.staging')), stat(this.absolute('objects'))]);
    if (rootStat.dev !== stagingStat.dev || rootStat.dev !== objectStat.dev) {
      throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact staging 与对象目录必须位于同一文件系统。');
    }
  }

  async putBytes(input: ArtifactPutBytesInput): Promise<ArtifactRef> {
    const requestedBytes = input.bytes.byteLength;
    try {
      await this.initialize();
      await this.preflightCapacity(requestedBytes);
      const owner = normalizeOwner(input.owner);
      const mimeType = normalizeMimeType(input.mimeType);
      const raw = Buffer.from(input.bytes);
      const contentSha256 = sha256(raw);
      const shouldCompress = input.compression === 'gzip-v1' && raw.byteLength >= defaultCompressionThreshold;
      const compressed = shouldCompress ? await gzipBytes(raw) : null;
      const useCompressed = Boolean(compressed && compressed.byteLength < raw.byteLength);
      const stored = useCompressed ? compressed! : raw;
      const encoding: ArtifactEncoding = useCompressed ? 'gzip-v1' : 'identity';
      const staged = await this.writeStagingBytes(stored);
      const result = await this.commitAndPromote({
        staged,
        contentSha256,
        contentByteLength: raw.byteLength,
        mimeType,
        encoding,
        generationId: owner.generationId,
        owner,
        createdAt: normalizeTimestamp(input.createdAt ?? this.now()),
      });
      this.resolveStorageFaults('put_bytes');
      return result;
    } catch (error) {
      throw this.classifyExternalWriteFailure('put_bytes', error, requestedBytes);
    }
  }

  async putJson(input: Omit<ArtifactPutBytesInput, 'bytes' | 'mimeType'> & { value: unknown; mimeType?: string }): Promise<ArtifactRef> {
    const canonical = `${stableJson(input.value)}\n`;
    return this.putBytes({ ...input, bytes: Buffer.from(canonical), mimeType: input.mimeType ?? 'application/json', compression: input.compression ?? 'gzip-v1' });
  }

  async putText(input: Omit<ArtifactPutBytesInput, 'bytes'> & { text: string }): Promise<ArtifactRef> {
    return this.putBytes({ ...input, bytes: Buffer.from(input.text), compression: input.compression ?? 'gzip-v1' });
  }

  /**
   * 仅供必须在同步 Provider/Runtime 回调内提交稳定引用的写入口使用。
   * 协议与异步 putBytes 相同；调用方仍应把大批量工作交给独立写队列，避免阻塞事件循环。
   */
  putBytesSync(input: ArtifactPutBytesInput): ArtifactRef {
    const requestedBytes = input.bytes.byteLength;
    try {
      this.initializeSync();
      this.preflightCapacitySync(requestedBytes);
      const owner = normalizeOwner(input.owner);
      const mimeType = normalizeMimeType(input.mimeType);
      const raw = Buffer.from(input.bytes);
      const contentSha256 = sha256(raw);
      const compressed = input.compression === 'gzip-v1' && raw.byteLength >= defaultCompressionThreshold ? gzipSync(raw, { level: 6 }) : null;
      const useCompressed = Boolean(compressed && compressed.byteLength < raw.byteLength);
      const stored = useCompressed ? compressed! : raw;
      const staged = this.writeStagingBytesSync(stored);
      const result = this.commitAndPromoteSync({
        staged,
        contentSha256,
        contentByteLength: raw.byteLength,
        mimeType,
        encoding: useCompressed ? 'gzip-v1' : 'identity',
        generationId: owner.generationId,
        owner,
        createdAt: normalizeTimestamp(input.createdAt ?? this.now()),
      });
      this.resolveStorageFaults('put_bytes_sync');
      return result;
    } catch (error) {
      throw this.classifyExternalWriteFailure('put_bytes_sync', error, requestedBytes);
    }
  }

  putTextSync(input: Omit<ArtifactPutBytesInput, 'bytes'> & { text: string }): ArtifactRef {
    return this.putBytesSync({ ...input, bytes: Buffer.from(input.text), compression: input.compression ?? 'gzip-v1' });
  }

  putJsonSync(input: Omit<ArtifactPutBytesInput, 'bytes' | 'mimeType'> & { value: unknown; mimeType?: string }): ArtifactRef {
    return this.putBytesSync({
      ...input,
      bytes: Buffer.from(`${stableJson(input.value)}\n`),
      mimeType: input.mimeType ?? 'application/json',
      compression: input.compression ?? 'gzip-v1',
    });
  }

  putFileSync(input: ArtifactPutFileInput): ArtifactRef {
    let requestedBytes: number | null = null;
    try {
      this.initializeSync();
      const owner = normalizeOwner(input.owner);
      const sourcePath = resolve(input.sourcePath);
      const sourceBefore = lstatSync(sourcePath);
      requestedBytes = sourceBefore.size;
      this.preflightCapacitySync(sourceBefore.size);
      if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink()) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact 来源必须是普通文件且不能是符号链接。');
      const staged = this.writeStagingFileSync(sourcePath);
      const sourceAfter = lstatSync(sourcePath);
      if (sourceBefore.dev !== sourceAfter.dev || sourceBefore.ino !== sourceAfter.ino || sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) {
        safeUnlinkSync(staged.absolutePath);
        throw artifactError('ZEUS_ARTIFACT_SOURCE_CHANGED', 'Artifact 来源在复制期间发生变化，未提交引用。');
      }
      const result = this.commitAndPromoteSync({
        staged,
        contentSha256: staged.sha256,
        contentByteLength: staged.byteLength,
        mimeType: normalizeMimeType(input.mimeType),
        encoding: 'identity',
        generationId: owner.generationId,
        owner,
        createdAt: normalizeTimestamp(input.createdAt ?? this.now()),
      });
      this.resolveStorageFaults('put_file_sync');
      return result;
    } catch (error) {
      throw this.classifyExternalWriteFailure('put_file_sync', error, requestedBytes);
    }
  }

  async putFile(input: ArtifactPutFileInput): Promise<ArtifactRef> {
    let requestedBytes: number | null = null;
    try {
      await this.initialize();
      const owner = normalizeOwner(input.owner);
      const sourcePath = resolve(input.sourcePath);
      const sourceBefore = await lstat(sourcePath);
      requestedBytes = sourceBefore.size;
      await this.preflightCapacity(sourceBefore.size);
      if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink()) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact 来源必须是普通文件且不能是符号链接。');
      const staged = await this.writeStagingFile(sourcePath);
      const sourceAfter = await lstat(sourcePath);
      if (sourceBefore.dev !== sourceAfter.dev || sourceBefore.ino !== sourceAfter.ino || sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) {
        await safeUnlink(staged.absolutePath);
        throw artifactError('ZEUS_ARTIFACT_SOURCE_CHANGED', 'Artifact 来源在复制期间发生变化，未提交引用。');
      }
      const result = await this.commitAndPromote({
        staged,
        contentSha256: staged.sha256,
        contentByteLength: staged.byteLength,
        mimeType: normalizeMimeType(input.mimeType),
        encoding: 'identity',
        generationId: owner.generationId,
        owner,
        createdAt: normalizeTimestamp(input.createdAt ?? this.now()),
      });
      this.resolveStorageFaults('put_file');
      return result;
    } catch (error) {
      throw this.classifyExternalWriteFailure('put_file', error, requestedBytes);
    }
  }

  attachOwner(input: { sha256: string; owner: ArtifactOwnerIdentity; createdAt?: string }): ArtifactRef {
    const owner = normalizeOwner(input.owner);
    const object = this.requireObject(normalizeSha256(input.sha256));
    if (object.state !== 'promoted') throw artifactError('ZEUS_ARTIFACT_TRANSITIONING', `Artifact 当前不可附加 owner：${object.state}`);
    const createdAt = normalizeTimestamp(input.createdAt ?? this.now());
    this.db.durableTransactionSync(() => this.insertOwner(object.sha256, owner, createdAt));
    return mapArtifactRef(object, owner, createdAt);
  }

  detachOwner(input: { sha256: string; owner: Pick<ArtifactOwnerIdentity, 'kind' | 'id'> }): boolean {
    const sha = normalizeSha256(input.sha256);
    const kind = normalizeIdentity(input.owner.kind, 'owner.kind');
    const id = normalizeIdentity(input.owner.id, 'owner.id');
    const existing = this.db.get<{ present: number }>(`SELECT 1 AS present FROM artifact_owners WHERE owner_kind = ? AND owner_id = ? AND artifact_sha256 = ?`, [kind, id, sha]);
    if (!existing) return false;
    this.db.durableTransactionSync(() => this.db.execute(`DELETE FROM artifact_owners WHERE owner_kind = ? AND owner_id = ? AND artifact_sha256 = ?`, [kind, id, sha]));
    return true;
  }

  async resolveAuthorized(input: { sha256: string; owner: Pick<ArtifactOwnerIdentity, 'kind' | 'id'>; verifyHash?: boolean }): Promise<{ ref: ArtifactRef; absolutePath: string }> {
    const sha = normalizeSha256(input.sha256);
    const owner = this.requireOwner(sha, input.owner);
    const object = this.requireObject(sha);
    if (object.state !== 'promoted') throw artifactError(object.state === 'damaged' ? 'ZEUS_ARTIFACT_DAMAGED' : 'ZEUS_ARTIFACT_TRANSITIONING', `Artifact 当前不可读取：${object.state}`);
    const absolutePath = this.absolute(object.relative_path);
    await verifyImmutableFile(absolutePath, object.sha256, object.byte_length, input.verifyHash === true);
    return { ref: mapArtifactRef(object, mapOwner(owner), owner.created_at), absolutePath };
  }

  async readAuthorized(input: { sha256: string; owner: Pick<ArtifactOwnerIdentity, 'kind' | 'id'>; maximumContentBytes?: number }): Promise<{ ref: ArtifactRef; bytes: Uint8Array }> {
    const resolved = await this.resolveAuthorized({ ...input, verifyHash: false });
    const maximumContentBytes = boundedInteger(input.maximumContentBytes ?? defaultReadLimit, 'maximumContentBytes', 1, 1024 * 1024 * 1024);
    if (resolved.ref.contentByteLength > maximumContentBytes) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact 解码后大小超过调用方预算。');
    const stored = await readFile(resolved.absolutePath);
    if (sha256(stored) !== resolved.ref.sha256) throw artifactError('ZEUS_ARTIFACT_DAMAGED', 'Artifact 存储内容哈希与引用不一致。');
    const content = resolved.ref.encoding === 'gzip-v1' ? await gunzipBytes(stored, maximumContentBytes) : stored;
    if (content.byteLength !== resolved.ref.contentByteLength || sha256(content) !== resolved.ref.contentSha256) {
      throw artifactError('ZEUS_ARTIFACT_DAMAGED', 'Artifact 解码内容与持久元数据不一致。');
    }
    return { ref: resolved.ref, bytes: content };
  }

  /**
   * 供同步 SQLite Repository 在一次受控用例内物化大字段。授权、路径、长度和双哈希
   * 与异步入口完全一致；调用方必须传入明确解码预算，禁止把它用于无界列表投影。
   */
  readAuthorizedSync(input: { sha256: string; owner: Pick<ArtifactOwnerIdentity, 'kind' | 'id'>; maximumContentBytes?: number }): { ref: ArtifactRef; bytes: Uint8Array } {
    const sha = normalizeSha256(input.sha256);
    const owner = this.requireOwner(sha, input.owner);
    const object = this.requireObject(sha);
    if (object.state !== 'promoted') throw artifactError(object.state === 'damaged' ? 'ZEUS_ARTIFACT_DAMAGED' : 'ZEUS_ARTIFACT_TRANSITIONING', `Artifact 当前不可读取：${object.state}`);
    const maximumContentBytes = boundedInteger(input.maximumContentBytes ?? defaultReadLimit, 'maximumContentBytes', 1, 1024 * 1024 * 1024);
    if (object.content_byte_length > maximumContentBytes) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact 解码后大小超过调用方预算。');
    const absolutePath = this.absolute(object.relative_path);
    verifyImmutableFileSync(absolutePath, object.sha256, object.byte_length, false);
    const stored = readFileSync(absolutePath);
    if (sha256(stored) !== object.sha256) throw artifactError('ZEUS_ARTIFACT_DAMAGED', 'Artifact 存储内容哈希与引用不一致。');
    const content = object.encoding === 'gzip-v1' ? gunzipSync(stored, { maxOutputLength: maximumContentBytes }) : stored;
    if (content.byteLength !== object.content_byte_length || sha256(content) !== object.content_sha256) {
      throw artifactError('ZEUS_ARTIFACT_DAMAGED', 'Artifact 解码内容与持久元数据不一致。');
    }
    return { ref: mapArtifactRef(object, mapOwner(owner), owner.created_at), bytes: content };
  }

  /** 恢复 DB 引用已提交但文件尚未完成原子提升的操作。 */
  async recoverStaging(): Promise<{ recovered: string[]; damaged: string[] }> {
    await this.initialize();
    const rows = this.db.select<StagingRow>(`SELECT id, artifact_sha256, staging_relative_path, state FROM artifact_staging_operations WHERE state IN ('pending', 'promotion_failed') ORDER BY created_at, id`);
    const recovered: string[] = [];
    const damaged: string[] = [];
    for (const row of rows) {
      const object = this.requireObject(row.artifact_sha256);
      try {
        await this.promoteStagedObject(row, object);
        this.markPromoted(row.id, object.sha256, this.now());
        recovered.push(object.sha256);
      } catch (error) {
        const destination = this.absolute(object.relative_path);
        if (!(await regularFileExists(destination))) {
          this.db.durableTransactionSync(() => {
            this.db.execute(`UPDATE artifact_objects SET state = 'damaged' WHERE sha256 = ? AND state = 'staging'`, [object.sha256]);
            this.db.execute(`UPDATE artifact_staging_operations SET state = 'promotion_failed', last_error_json = ?, updated_at = ? WHERE id = ?`, [safeErrorJson(error), this.now(), row.id]);
          });
          damaged.push(object.sha256);
        }
      }
    }
    return { recovered, damaged };
  }

  createGcCandidate(input: { eligibleBefore: string; limit?: number; minimumQuarantineMs?: number; createdAt?: string }): ArtifactGcCandidateManifest {
    const eligibleBefore = normalizeTimestamp(input.eligibleBefore);
    const limit = boundedInteger(input.limit ?? 1_000, 'limit', 1, 10_000);
    const minimumQuarantineMs = boundedInteger(input.minimumQuarantineMs ?? 7 * 24 * 60 * 60 * 1_000, 'minimumQuarantineMs', 60_000, 365 * 24 * 60 * 60 * 1_000);
    const createdAt = normalizeTimestamp(input.createdAt ?? this.now());
    const candidates = this.db.select<Pick<ArtifactObjectRow, 'sha256' | 'relative_path' | 'byte_length'>>(
      `SELECT object.sha256, object.relative_path, object.byte_length
         FROM artifact_objects AS object
        WHERE object.state = 'promoted'
          AND object.created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM artifact_owners AS owner WHERE owner.artifact_sha256 = object.sha256)
          AND NOT EXISTS (SELECT 1 FROM artifact_retention_holds AS hold WHERE hold.artifact_sha256 = object.sha256 AND hold.state = 'active')
          AND NOT EXISTS (
            SELECT 1 FROM artifact_gc_manifest_items AS item
             WHERE item.artifact_sha256 = object.sha256 AND item.state IN ('candidate', 'quarantining', 'quarantined')
          )
        ORDER BY object.created_at, object.sha256
        LIMIT ?`,
      [eligibleBefore, limit],
    );
    const id = `artifact_gc_${randomUUID()}`;
    const policy = { eligibleBefore, limit, minimumQuarantineMs };
    const canonicalItems = candidates.map((row) => ({ sha256: row.sha256, relativePath: row.relative_path, byteLength: row.byte_length }));
    const manifestSha256 = sha256(Buffer.from(stableJson({ id, policy, items: canonicalItems })));
    const totalBytes = sum(candidates.map((row) => row.byte_length));
    this.db.durableTransactionSync(() => {
      this.db.execute(
        `INSERT INTO artifact_gc_manifests
         (id, state, policy_json, manifest_sha256, artifact_count, total_bytes, created_at, quarantined_at, delete_after)
         VALUES (?, 'candidate', ?, ?, ?, ?, ?, NULL, NULL)`,
        [id, JSON.stringify(policy), manifestSha256, candidates.length, totalBytes, createdAt],
      );
      for (const row of candidates) {
        this.db.execute(
          `INSERT INTO artifact_gc_manifest_items
           (manifest_id, artifact_sha256, relative_path, byte_length, state, quarantine_relative_path)
           VALUES (?, ?, ?, ?, 'candidate', NULL)`,
          [id, row.sha256, row.relative_path, row.byte_length],
        );
      }
    });
    return this.requireGcManifest(id);
  }

  revalidateGcCandidate(idValue: string): { manifest: ArtifactGcCandidateManifest; safe: boolean; retainedSha256: string[] } {
    const id = normalizeIdentity(idValue, 'manifestId');
    const manifest = this.requireGcManifestRow(id);
    if (manifest.state !== 'candidate') throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', `GC 清单当前状态不可复核：${manifest.state}`);
    const retained = this.db.select<{ artifact_sha256: string }>(
      `SELECT item.artifact_sha256
         FROM artifact_gc_manifest_items AS item
        WHERE item.manifest_id = ?
          AND (
            EXISTS (SELECT 1 FROM artifact_owners AS owner WHERE owner.artifact_sha256 = item.artifact_sha256)
            OR EXISTS (SELECT 1 FROM artifact_retention_holds AS hold WHERE hold.artifact_sha256 = item.artifact_sha256 AND hold.state = 'active')
          )
        ORDER BY item.artifact_sha256`,
      [id],
    );
    return { manifest: mapGcManifest(manifest), safe: retained.length === 0, retainedSha256: retained.map((row) => row.artifact_sha256) };
  }

  cancelGcCandidate(idValue: string): ArtifactGcCandidateManifest {
    const id = normalizeIdentity(idValue, 'manifestId');
    this.db.durableTransactionSync(() => {
      const manifest = this.requireGcManifestRow(id);
      if (manifest.state !== 'candidate') throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', `只能取消尚未隔离的 GC 清单：${manifest.state}`);
      this.db.execute(`UPDATE artifact_gc_manifest_items SET state = 'retained' WHERE manifest_id = ? AND state = 'candidate'`, [id]);
      this.db.execute(`UPDATE artifact_gc_manifests SET state = 'cancelled' WHERE id = ?`, [id]);
    });
    return this.requireGcManifest(id);
  }

  /** 显式隔离；不会删除内容。调用前会在同一持久事务内重新检查全部 owner。 */
  async quarantineGcCandidate(input: { manifestId: string; expectedManifestSha256: string; quarantinedAt?: string }): Promise<ArtifactGcCandidateManifest> {
    await this.initialize();
    const manifestId = normalizeIdentity(input.manifestId, 'manifestId');
    const expectedHash = normalizeSha256(input.expectedManifestSha256);
    const quarantinedAt = normalizeTimestamp(input.quarantinedAt ?? this.now());
    const manifest = this.requireGcManifestRow(manifestId);
    if (manifest.manifest_sha256 !== expectedHash) throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', 'GC 清单确认哈希不匹配。');
    if (manifest.state !== 'candidate' && manifest.state !== 'quarantining') throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', `GC 清单当前状态不可隔离：${manifest.state}`);
    const policy = parseGcPolicy(manifest.policy_json);

    if (manifest.state === 'candidate') {
      this.db.durableTransactionSync(() => {
        const newlyReferenced = this.db.get<{ artifact_sha256: string }>(
          `SELECT item.artifact_sha256
             FROM artifact_gc_manifest_items AS item
            WHERE item.manifest_id = ?
              AND (
                EXISTS (SELECT 1 FROM artifact_owners AS owner WHERE owner.artifact_sha256 = item.artifact_sha256)
                OR EXISTS (SELECT 1 FROM artifact_retention_holds AS hold WHERE hold.artifact_sha256 = item.artifact_sha256 AND hold.state = 'active')
              )
            LIMIT 1`,
          [manifestId],
        );
        if (newlyReferenced) throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', `GC 候选已重新获得 owner：${newlyReferenced.artifact_sha256}`);
        this.db.execute(
          `UPDATE artifact_objects SET state = 'quarantining'
            WHERE sha256 IN (SELECT artifact_sha256 FROM artifact_gc_manifest_items WHERE manifest_id = ?) AND state = 'promoted'`,
          [manifestId],
        );
        const transitioning =
          this.db.get<{ row_count: number }>(
            `SELECT COUNT(*) AS row_count FROM artifact_objects
            WHERE sha256 IN (SELECT artifact_sha256 FROM artifact_gc_manifest_items WHERE manifest_id = ?) AND state = 'quarantining'`,
            [manifestId],
          )?.row_count ?? 0;
        if (transitioning !== manifest.artifact_count) throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', 'GC 候选对象状态已变化，未开始隔离。');
        this.db.execute(`UPDATE artifact_gc_manifest_items SET state = 'quarantining' WHERE manifest_id = ? AND state = 'candidate'`, [manifestId]);
        this.db.execute(`UPDATE artifact_gc_manifests SET state = 'quarantining' WHERE id = ? AND state = 'candidate'`, [manifestId]);
      });
    }

    const items = this.db.select<GcItemRow>(`SELECT * FROM artifact_gc_manifest_items WHERE manifest_id = ? ORDER BY artifact_sha256`, [manifestId]);
    for (const item of items) {
      if (item.state === 'quarantined') continue;
      const quarantineRelativePath = item.quarantine_relative_path ?? `.quarantine/${manifestId}/${item.artifact_sha256}`;
      const source = this.absolute(item.relative_path);
      const destination = this.absolute(quarantineRelativePath);
      await ensurePrivateDirectory(dirname(destination));
      if (await regularFileExists(source)) {
        await verifyImmutableFile(source, item.artifact_sha256, item.byte_length, true);
        await renameNoReplace(source, destination, item.artifact_sha256, item.byte_length);
      } else {
        await verifyImmutableFile(destination, item.artifact_sha256, item.byte_length, true);
      }
      await chmod(destination, 0o600);
      this.db.durableTransactionSync(() => {
        this.db.execute(`UPDATE artifact_gc_manifest_items SET state = 'quarantined', quarantine_relative_path = ? WHERE manifest_id = ? AND artifact_sha256 = ?`, [quarantineRelativePath, manifestId, item.artifact_sha256]);
        this.db.execute(`UPDATE artifact_objects SET state = 'quarantined', quarantined_at = ? WHERE sha256 = ? AND state = 'quarantining'`, [quarantinedAt, item.artifact_sha256]);
      });
    }
    const deleteAfter = new Date(Date.parse(quarantinedAt) + policy.minimumQuarantineMs).toISOString();
    this.db.durableTransactionSync(() => {
      const incomplete = this.db.get<{ row_count: number }>(`SELECT COUNT(*) AS row_count FROM artifact_gc_manifest_items WHERE manifest_id = ? AND state <> 'quarantined'`, [manifestId])?.row_count ?? 0;
      if (incomplete !== 0) throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', 'GC 隔离仍有未完成对象。');
      this.db.execute(`UPDATE artifact_gc_manifests SET state = 'quarantined', quarantined_at = ?, delete_after = ? WHERE id = ?`, [quarantinedAt, deleteAfter, manifestId]);
    });
    return this.requireGcManifest(manifestId);
  }

  /** 隔离期内的显式恢复；逐对象幂等返回 CAS 路径，恢复中不允许进入删除。 */
  async restoreQuarantinedGcCandidate(input: { manifestId: string; expectedManifestSha256: string; restoredAt?: string }): Promise<ArtifactGcCandidateManifest> {
    await this.initialize();
    const manifestId = normalizeIdentity(input.manifestId, 'manifestId');
    const expectedHash = normalizeSha256(input.expectedManifestSha256);
    const restoredAt = normalizeTimestamp(input.restoredAt ?? this.now());
    const manifest = this.requireGcManifestRow(manifestId);
    if (manifest.manifest_sha256 !== expectedHash) throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', 'GC 清单确认哈希不匹配。');
    if (manifest.state !== 'quarantined' && manifest.state !== 'restoring') throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', `GC 清单当前状态不可恢复：${manifest.state}`);
    if (manifest.state === 'quarantined') {
      this.db.durableTransactionSync(() => this.db.execute(`UPDATE artifact_gc_manifests SET state = 'restoring' WHERE id = ? AND state = 'quarantined'`, [manifestId]));
    }
    const items = this.db.select<GcItemRow>(`SELECT * FROM artifact_gc_manifest_items WHERE manifest_id = ? ORDER BY artifact_sha256`, [manifestId]);
    for (const item of items) {
      if (item.state === 'retained') continue;
      if (item.state !== 'quarantined' || !item.quarantine_relative_path) throw artifactError('ZEUS_ARTIFACT_DAMAGED', `GC 隔离对象缺少可恢复路径：${item.artifact_sha256}`);
      const source = this.absolute(item.quarantine_relative_path);
      const destination = this.absolute(item.relative_path);
      await ensurePrivateDirectory(dirname(destination));
      if (await regularFileExists(source)) {
        await verifyImmutableFile(source, item.artifact_sha256, item.byte_length, true);
        await renameNoReplace(source, destination, item.artifact_sha256, item.byte_length);
      } else {
        await verifyImmutableFile(destination, item.artifact_sha256, item.byte_length, true);
      }
      await chmod(destination, 0o600);
      this.db.durableTransactionSync(() => {
        this.db.execute(`UPDATE artifact_objects SET state = 'promoted', promoted_at = ?, quarantined_at = NULL WHERE sha256 = ? AND state = 'quarantined'`, [restoredAt, item.artifact_sha256]);
        this.db.execute(`UPDATE artifact_gc_manifest_items SET state = 'retained' WHERE manifest_id = ? AND artifact_sha256 = ? AND state = 'quarantined'`, [manifestId, item.artifact_sha256]);
      });
    }
    this.db.durableTransactionSync(() => {
      const incomplete = this.db.get<{ row_count: number }>(`SELECT COUNT(*) AS row_count FROM artifact_gc_manifest_items WHERE manifest_id = ? AND state <> 'retained'`, [manifestId])?.row_count ?? 0;
      if (incomplete !== 0) throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', 'GC 隔离恢复仍有未完成对象。');
      this.db.execute(`UPDATE artifact_gc_manifests SET state = 'cancelled', delete_after = NULL WHERE id = ? AND state = 'restoring'`, [manifestId]);
    });
    return this.requireGcManifest(manifestId);
  }

  /** 隔离期届满后的显式删除；不提供定时自动调用入口。 */
  async deleteQuarantinedGcCandidate(input: { manifestId: string; expectedManifestSha256: string; deletedAt?: string }): Promise<ArtifactGcCandidateManifest> {
    const manifestId = normalizeIdentity(input.manifestId, 'manifestId');
    const expectedHash = normalizeSha256(input.expectedManifestSha256);
    const deletedAt = normalizeTimestamp(input.deletedAt ?? this.now());
    const manifest = this.requireGcManifestRow(manifestId);
    if (manifest.state !== 'quarantined' || !manifest.delete_after) throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', `GC 清单尚未处于可删除隔离态：${manifest.state}`);
    if (manifest.manifest_sha256 !== expectedHash) throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', 'GC 清单确认哈希不匹配。');
    if (Date.parse(deletedAt) < Date.parse(manifest.delete_after)) throw artifactError('ZEUS_ARTIFACT_GC_DELAY_NOT_ELAPSED', `GC 隔离期尚未结束：${manifest.delete_after}`);
    const referenced = this.db.get<{ artifact_sha256: string }>(
      `SELECT item.artifact_sha256 FROM artifact_gc_manifest_items AS item
        WHERE item.manifest_id = ? AND (
          EXISTS (SELECT 1 FROM artifact_owners AS owner WHERE owner.artifact_sha256 = item.artifact_sha256)
          OR EXISTS (SELECT 1 FROM artifact_retention_holds AS hold WHERE hold.artifact_sha256 = item.artifact_sha256 AND hold.state = 'active')
        ) LIMIT 1`,
      [manifestId],
    );
    if (referenced) throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', `隔离对象出现 owner，拒绝删除：${referenced.artifact_sha256}`);
    const items = this.db.select<GcItemRow>(`SELECT * FROM artifact_gc_manifest_items WHERE manifest_id = ? ORDER BY artifact_sha256`, [manifestId]);
    for (const item of items) {
      if (item.state === 'deleted') continue;
      if (!item.quarantine_relative_path) throw artifactError('ZEUS_ARTIFACT_DAMAGED', `隔离对象缺少路径：${item.artifact_sha256}`);
      const path = this.absolute(item.quarantine_relative_path);
      if (await regularFileExists(path)) {
        await verifyImmutableFile(path, item.artifact_sha256, item.byte_length, true);
        await unlink(path);
      }
      this.db.durableTransactionSync(() => {
        const ownerOrHold = this.db.get<{ present: number }>(
          `SELECT 1 AS present
             FROM artifact_objects AS object
            WHERE object.sha256 = ? AND (
              EXISTS (SELECT 1 FROM artifact_owners AS owner WHERE owner.artifact_sha256 = object.sha256)
              OR EXISTS (SELECT 1 FROM artifact_retention_holds AS hold WHERE hold.artifact_sha256 = object.sha256 AND hold.state = 'active')
            )`,
          [item.artifact_sha256],
        );
        if (ownerOrHold) throw artifactError('ZEUS_ARTIFACT_GC_CONFLICT', `删除提交前对象重新获得 owner 或保留锁：${item.artifact_sha256}`);
        this.db.execute(`UPDATE artifact_gc_manifest_items SET state = 'deleted' WHERE manifest_id = ? AND artifact_sha256 = ?`, [manifestId, item.artifact_sha256]);
        this.db.execute(`UPDATE artifact_objects SET state = 'deleted', deleted_at = ? WHERE sha256 = ? AND state = 'quarantined'`, [deletedAt, item.artifact_sha256]);
      });
    }
    this.db.durableTransactionSync(() => this.db.execute(`UPDATE artifact_gc_manifests SET state = 'deleted' WHERE id = ?`, [manifestId]));
    return this.requireGcManifest(manifestId);
  }

  health(): { generation: typeof artifactStoreGeneration; objects: Record<ArtifactObjectState, number>; pendingStaging: number; activeGcManifests: number } {
    const objects = Object.fromEntries(
      (['staging', 'promoted', 'quarantining', 'quarantined', 'damaged', 'deleted'] as const).map((state) => [
        state,
        this.db.get<{ row_count: number }>(`SELECT COUNT(*) AS row_count FROM artifact_objects WHERE state = ?`, [state])?.row_count ?? 0,
      ]),
    ) as Record<ArtifactObjectState, number>;
    return {
      generation: artifactStoreGeneration,
      objects,
      pendingStaging: this.db.get<{ row_count: number }>(`SELECT COUNT(*) AS row_count FROM artifact_staging_operations WHERE state IN ('pending', 'promotion_failed')`)?.row_count ?? 0,
      activeGcManifests: this.db.get<{ row_count: number }>(`SELECT COUNT(*) AS row_count FROM artifact_gc_manifests WHERE state IN ('candidate', 'quarantining', 'quarantined', 'restoring')`)?.row_count ?? 0,
    };
  }

  /**
   * 用户明确请求的恢复预检：实际在 staging 目录 create-only、fsync 并删除一个空探针文件。
   * 不修改 Artifact owner/故障表，也不会在原 Core generation 上恢复写入。
   */
  async runRecoveryPreflight(): Promise<ArtifactStorageRecoveryPreflight> {
    const checkedAt = normalizeTimestamp(this.now());
    const probePath = this.absolute(`.staging/.recovery-preflight-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let availableBytes: number | null = null;
    try {
      await this.initialize();
      const filesystem = await statfs(this.absoluteRoot);
      availableBytes = safeFilesystemBytes(filesystem.bavail, filesystem.bsize);
      if (availableBytes < this.minimumFreeBytes) {
        return {
          generation: artifactStoreGeneration,
          stagingWrite: 'failed',
          freeSpace: 'failed',
          availableBytes,
          minimumFreeBytes: this.minimumFreeBytes,
          eligibleForCoreRestart: false,
          errorCode: 'ENOSPC',
          checkedAt,
        };
      }
      this.faultInjection?.beforeFileOperation('recovery_preflight');
      handle = await open(probePath, 'wx', 0o600);
      await handle.sync();
      await handle.close();
      handle = null;
      await unlink(probePath);
      return {
        generation: artifactStoreGeneration,
        stagingWrite: 'ok',
        freeSpace: 'ok',
        availableBytes,
        minimumFreeBytes: this.minimumFreeBytes,
        eligibleForCoreRestart: true,
        errorCode: null,
        checkedAt,
      };
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // 原始预检失败优先。
      }
      try {
        await safeUnlink(probePath);
      } catch {
        // 预检已失败，不用清理错误覆盖原始证据。
      }
      return {
        generation: artifactStoreGeneration,
        stagingWrite: 'failed',
        freeSpace: availableBytes !== null && availableBytes >= this.minimumFreeBytes ? 'ok' : 'failed',
        availableBytes,
        minimumFreeBytes: this.minimumFreeBytes,
        eligibleForCoreRestart: false,
        errorCode: isNodeError(error) && error.code ? error.code : error instanceof ArtifactStoreError ? error.code : 'UNKNOWN',
        checkedAt,
      };
    }
  }

  hold(input: { sha256: string; owner: Pick<ArtifactOwnerIdentity, 'kind' | 'id'>; ownerClass: ArtifactRetentionOwnerClass; reason: string; retainUntil?: string | null; createdAt?: string }): {
    id: string;
    retainUntil: string | null;
    policy: ArtifactRetentionPolicy;
  } {
    const sha = normalizeSha256(input.sha256);
    const owner = this.requireOwner(sha, input.owner);
    const ownerClass = normalizeRetentionOwnerClass(input.ownerClass);
    const policy = artifactRetentionPolicies[ownerClass];
    const createdAt = normalizeTimestamp(input.createdAt ?? this.now());
    const explicitRetainUntil = input.retainUntil == null ? null : normalizeTimestamp(input.retainUntil);
    const policyRetainUntil = new Date(Date.parse(createdAt) + policy.minimumRetentionMs).toISOString();
    const retainUntil = explicitRetainUntil && explicitRetainUntil > policyRetainUntil ? explicitRetainUntil : policyRetainUntil;
    const reason = normalizeReason(input.reason);
    const id = `artifact_hold_${createHash('sha256').update(`${sha}\0${owner.owner_kind}\0${owner.owner_id}\0${ownerClass}\0${reason}`).digest('hex').slice(0, 32)}`;
    this.db.durableTransactionSync(() => {
      this.db.execute(
        `INSERT INTO artifact_retention_holds
         (id, artifact_sha256, owner_kind, owner_id, owner_class, reason, state, retain_until, created_at, released_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           state = 'active', retain_until = excluded.retain_until, released_at = NULL`,
        [id, sha, owner.owner_kind, owner.owner_id, ownerClass, reason, retainUntil, createdAt],
      );
    });
    return { id, retainUntil, policy };
  }

  releaseHold(input: { id: string; releasedAt?: string }): boolean {
    const id = normalizeIdentity(input.id, 'holdId');
    const present = this.db.get<{ present: number }>(`SELECT 1 AS present FROM artifact_retention_holds WHERE id = ? AND state = 'active'`, [id]);
    if (!present) return false;
    const releasedAt = normalizeTimestamp(input.releasedAt ?? this.now());
    this.db.durableTransactionSync(() => this.db.execute(`UPDATE artifact_retention_holds SET state = 'released', released_at = ? WHERE id = ? AND state = 'active'`, [releasedAt, id]));
    return true;
  }

  releaseOwnerHolds(input: { owner: Pick<ArtifactOwnerIdentity, 'kind' | 'id'>; sha256?: string; releasedAt?: string }): number {
    const kind = normalizeIdentity(input.owner.kind, 'owner.kind');
    const id = normalizeIdentity(input.owner.id, 'owner.id');
    const sha = input.sha256 === undefined ? null : normalizeSha256(input.sha256);
    const releasedAt = normalizeTimestamp(input.releasedAt ?? this.now());
    return this.db.durableTransactionSync(() => {
      const count =
        this.db.get<{ row_count: number }>(
          `SELECT COUNT(*) AS row_count
             FROM artifact_retention_holds
            WHERE owner_kind = ? AND owner_id = ? AND state = 'active'
              AND (? IS NULL OR artifact_sha256 = ?)`,
          [kind, id, sha, sha],
        )?.row_count ?? 0;
      this.db.execute(
        `UPDATE artifact_retention_holds
            SET state = 'released', released_at = ?
          WHERE owner_kind = ? AND owner_id = ? AND state = 'active'
            AND (? IS NULL OR artifact_sha256 = ?)`,
        [releasedAt, kind, id, sha, sha],
      );
      return count;
    });
  }

  async capacityDiagnostic(input: { recordSample?: boolean; largestLimit?: number } = {}): Promise<ArtifactCapacityDiagnostic> {
    await this.initialize();
    const observedAt = normalizeTimestamp(this.now());
    const filesystem = await statfs(this.absoluteRoot);
    const totalBytes = safeFilesystemBytes(filesystem.blocks, filesystem.bsize);
    const freeBytes = safeFilesystemBytes(filesystem.bfree, filesystem.bsize);
    const availableBytes = safeFilesystemBytes(filesystem.bavail, filesystem.bsize);
    const totals = this.db.get<{ stored_bytes: number; content_bytes: number; object_count: number }>(
      `SELECT COALESCE(SUM(byte_length), 0) AS stored_bytes,
              COALESCE(SUM(content_byte_length), 0) AS content_bytes,
              COUNT(*) AS object_count
         FROM artifact_objects WHERE state <> 'deleted'`,
    ) ?? { stored_bytes: 0, content_bytes: 0, object_count: 0 };
    if (input.recordSample !== false) {
      this.db.execute(
        `INSERT INTO artifact_capacity_samples (id, stored_bytes, content_bytes, object_count, free_bytes, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`artifact_capacity_${randomUUID()}`, totals.stored_bytes, totals.content_bytes, totals.object_count, availableBytes, observedAt],
      );
    }
    const categories = this.db.select<{ category: string; objects: number; stored_bytes: number; content_bytes: number }>(
      `WITH categorized_objects AS (
         SELECT DISTINCT object.sha256,
                object.byte_length,
                object.content_byte_length,
                COALESCE(owner.owner_kind, 'unowned') AS category
           FROM artifact_objects AS object
           LEFT JOIN (
             SELECT DISTINCT artifact_sha256, owner_kind FROM artifact_owners
           ) AS owner ON owner.artifact_sha256 = object.sha256
          WHERE object.state <> 'deleted'
       )
       SELECT category,
              COUNT(*) AS objects,
              COALESCE(SUM(byte_length), 0) AS stored_bytes,
              COALESCE(SUM(content_byte_length), 0) AS content_bytes
         FROM categorized_objects
        GROUP BY category
        ORDER BY stored_bytes DESC, category`,
    );
    const largestLimit = boundedInteger(input.largestLimit ?? 20, 'largestLimit', 1, 100);
    const largest = this.db.select<{ sha256: string; mime_type: string; stored_bytes: number; content_bytes: number; owner_kinds: string | null }>(
      `SELECT object.sha256, object.mime_type,
              object.byte_length AS stored_bytes, object.content_byte_length AS content_bytes,
              GROUP_CONCAT(DISTINCT owner.owner_kind) AS owner_kinds
         FROM artifact_objects AS object
         LEFT JOIN artifact_owners AS owner ON owner.artifact_sha256 = object.sha256
        WHERE object.state <> 'deleted'
        GROUP BY object.sha256
        ORDER BY object.byte_length DESC, object.sha256
        LIMIT ?`,
      [largestLimit],
    );
    const reclaim = this.db.get<{
      reclaimable_objects: number;
      reclaimable_bytes: number;
      blocked_by_owner: number;
      blocked_by_hold: number;
      transitioning: number;
    }>(
      `SELECT
          SUM(CASE WHEN object.state = 'promoted'
                    AND NOT EXISTS (SELECT 1 FROM artifact_owners AS owner WHERE owner.artifact_sha256 = object.sha256)
                    AND NOT EXISTS (SELECT 1 FROM artifact_retention_holds AS hold WHERE hold.artifact_sha256 = object.sha256 AND hold.state = 'active')
                   THEN 1 ELSE 0 END) AS reclaimable_objects,
          SUM(CASE WHEN object.state = 'promoted'
                    AND NOT EXISTS (SELECT 1 FROM artifact_owners AS owner WHERE owner.artifact_sha256 = object.sha256)
                    AND NOT EXISTS (SELECT 1 FROM artifact_retention_holds AS hold WHERE hold.artifact_sha256 = object.sha256 AND hold.state = 'active')
                   THEN object.byte_length ELSE 0 END) AS reclaimable_bytes,
          SUM(CASE WHEN EXISTS (SELECT 1 FROM artifact_owners AS owner WHERE owner.artifact_sha256 = object.sha256) THEN 1 ELSE 0 END) AS blocked_by_owner,
          SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM artifact_owners AS owner WHERE owner.artifact_sha256 = object.sha256)
                    AND EXISTS (SELECT 1 FROM artifact_retention_holds AS hold WHERE hold.artifact_sha256 = object.sha256 AND hold.state = 'active')
                   THEN 1 ELSE 0 END) AS blocked_by_hold,
          SUM(CASE WHEN object.state IN ('staging', 'quarantining', 'quarantined', 'damaged') THEN 1 ELSE 0 END) AS transitioning
         FROM artifact_objects AS object WHERE object.state <> 'deleted'`,
    ) ?? { reclaimable_objects: 0, reclaimable_bytes: 0, blocked_by_owner: 0, blocked_by_hold: 0, transitioning: 0 };
    const sampleRows = this.db.select<{ stored_bytes: number; observed_at: string }>(
      `SELECT stored_bytes, observed_at FROM artifact_capacity_samples
        WHERE observed_at >= ? ORDER BY observed_at, id`,
      [new Date(Date.parse(observedAt) - 30 * 24 * 60 * 60 * 1_000).toISOString()],
    );
    const firstSample = sampleRows.at(0);
    const lastSample = sampleRows.at(-1);
    const elapsedDays = firstSample && lastSample ? (Date.parse(lastSample.observed_at) - Date.parse(firstSample.observed_at)) / (24 * 60 * 60 * 1_000) : 0;
    const unresolvedFaults = this.db.select<{ id: string; phase: string; error_code: string; errno: string | null; requested_bytes: number | null; occurred_at: string }>(
      `SELECT id, phase, error_code, errno, requested_bytes, occurred_at
         FROM artifact_storage_faults WHERE resolved_at IS NULL
        ORDER BY occurred_at DESC, id DESC LIMIT 100`,
    );
    return {
      generation: artifactStoreGeneration,
      observedAt,
      filesystem: { totalBytes, freeBytes, availableBytes, minimumFreeBytes: this.minimumFreeBytes },
      quota: {
        configuredBytes: this.quotaBytes,
        storedBytes: totals.stored_bytes,
        remainingBytes: this.quotaBytes === null ? null : Math.max(0, this.quotaBytes - totals.stored_bytes),
        exhausted: availableBytes < this.minimumFreeBytes || (this.quotaBytes !== null && totals.stored_bytes >= this.quotaBytes),
      },
      categories: categories.map((row) => ({ category: row.category, objects: row.objects, storedBytes: row.stored_bytes, contentBytes: row.content_bytes })),
      largest: largest.map((row) => ({
        sha256: row.sha256,
        mimeType: row.mime_type,
        storedBytes: row.stored_bytes,
        contentBytes: row.content_bytes,
        ownerKinds: row.owner_kinds ? row.owner_kinds.split(',').sort() : [],
      })),
      reclaimability: {
        reclaimableObjects: reclaim.reclaimable_objects,
        reclaimableBytes: reclaim.reclaimable_bytes,
        blockedByOwner: reclaim.blocked_by_owner,
        blockedByHold: reclaim.blocked_by_hold,
        transitioning: reclaim.transitioning,
      },
      growth: {
        sampledFrom: firstSample?.observed_at ?? null,
        sampledTo: lastSample?.observed_at ?? null,
        bytesPerDay: firstSample && lastSample && elapsedDays > 0 ? (lastSample.stored_bytes - firstSample.stored_bytes) / elapsedDays : null,
        samples: sampleRows.length,
      },
      unresolvedFaults: unresolvedFaults.map((row) => ({
        id: row.id,
        phase: row.phase,
        code: row.error_code,
        errno: row.errno,
        requestedBytes: row.requested_bytes,
        occurredAt: row.occurred_at,
      })),
    };
  }

  private async preflightCapacity(requestedBytes: number): Promise<void> {
    const filesystem = await statfs(this.absoluteRoot);
    const availableBytes = safeFilesystemBytes(filesystem.bavail, filesystem.bsize);
    if (availableBytes - requestedBytes < this.minimumFreeBytes) {
      throw artifactError('ZEUS_ARTIFACT_CAPACITY_EXHAUSTED', `Artifact 可用空间不足：available=${availableBytes}, requested=${requestedBytes}, reserve=${this.minimumFreeBytes}`);
    }
    if (this.quotaBytes !== null) {
      const storedBytes = this.db.get<{ stored_bytes: number }>(`SELECT COALESCE(SUM(byte_length), 0) AS stored_bytes FROM artifact_objects WHERE state <> 'deleted'`)?.stored_bytes ?? 0;
      if (storedBytes + requestedBytes > this.quotaBytes) {
        throw artifactError('ZEUS_ARTIFACT_CAPACITY_EXHAUSTED', `Artifact 配额不足：stored=${storedBytes}, requested=${requestedBytes}, quota=${this.quotaBytes}`);
      }
    }
  }

  private initializeSync(): void {
    ensurePrivateDirectorySync(this.absoluteRoot);
    ensurePrivateDirectorySync(this.absolute('.staging'));
    ensurePrivateDirectorySync(this.absolute('objects'));
    ensurePrivateDirectorySync(this.absolute('.quarantine'));
    const rootStat = statSync(this.absoluteRoot);
    const stagingStat = statSync(this.absolute('.staging'));
    const objectStat = statSync(this.absolute('objects'));
    if (rootStat.dev !== stagingStat.dev || rootStat.dev !== objectStat.dev) {
      throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact staging 与对象目录必须位于同一文件系统。');
    }
  }

  private preflightCapacitySync(requestedBytes: number): void {
    const filesystem = statfsSync(this.absoluteRoot);
    const availableBytes = safeFilesystemBytes(filesystem.bavail, filesystem.bsize);
    if (availableBytes - requestedBytes < this.minimumFreeBytes) {
      throw artifactError('ZEUS_ARTIFACT_CAPACITY_EXHAUSTED', `Artifact 可用空间不足：available=${availableBytes}, requested=${requestedBytes}, reserve=${this.minimumFreeBytes}`);
    }
    if (this.quotaBytes !== null) {
      const storedBytes = this.db.get<{ stored_bytes: number }>(`SELECT COALESCE(SUM(byte_length), 0) AS stored_bytes FROM artifact_objects WHERE state <> 'deleted'`)?.stored_bytes ?? 0;
      if (storedBytes + requestedBytes > this.quotaBytes) {
        throw artifactError('ZEUS_ARTIFACT_CAPACITY_EXHAUSTED', `Artifact 配额不足：stored=${storedBytes}, requested=${requestedBytes}, quota=${this.quotaBytes}`);
      }
    }
  }

  private classifyExternalWriteFailure(phase: string, error: unknown, requestedBytes: number | null): unknown {
    if (error instanceof ArtifactStoreError) {
      if (error.code === 'ZEUS_ARTIFACT_CAPACITY_EXHAUSTED') this.recordStorageFault(phase, error, requestedBytes);
      return error;
    }
    const errno = isNodeError(error) ? (error.code ?? null) : null;
    if (!errno || !['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EACCES', 'EPERM', 'ENOTDIR'].includes(errno)) return error;
    const wrapped = artifactError('ZEUS_ARTIFACT_EXTERNAL_WRITE_FAILED', `Artifact 外部文件写入失败（${errno}）；已要求 Core 进入统一只读保护。`, error);
    this.recordStorageFault(phase, wrapped, requestedBytes, errno);
    this.writeFaultReporter?.reportExternalWriteFault(`artifact_${phase}`, error);
    return wrapped;
  }

  private recordStorageFault(phase: string, error: ArtifactStoreError, requestedBytes: number | null, errno: string | null = null): void {
    try {
      this.db.durableTransactionSync(() =>
        this.db.execute(
          `INSERT INTO artifact_storage_faults
           (id, phase, error_code, errno, message, requested_bytes, occurred_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          [`artifact_fault_${randomUUID()}`, phase, error.code, errno, error.message.slice(0, 4_096), requestedBytes, normalizeTimestamp(this.now())],
        ),
      );
    } catch {
      // 数据库本身也不可写时由 ZeusDatabase 的全局只读故障链负责；不能递归记录。
    }
  }

  private resolveStorageFaults(phase: string): void {
    try {
      this.db.execute(`UPDATE artifact_storage_faults SET resolved_at = ? WHERE phase = ? AND resolved_at IS NULL`, [normalizeTimestamp(this.now()), phase]);
    } catch {
      // 成功保存 Artifact 后，诊断收口失败不应把已提交内容回滚。
    }
  }

  private async writeStagingBytes(bytes: Uint8Array): Promise<{ id: string; relativePath: string; absolutePath: string; sha256: string; byteLength: number }> {
    this.faultInjection?.beforeFileOperation('staging_write');
    const id = `artifact_stage_${randomUUID()}`;
    const relativePath = `.staging/${id}`;
    const absolutePath = this.absolute(relativePath);
    const handle = await open(absolutePath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(absolutePath, 0o600);
    return { id, relativePath, absolutePath, sha256: sha256(bytes), byteLength: bytes.byteLength };
  }

  private async writeStagingFile(sourcePath: string): Promise<{ id: string; relativePath: string; absolutePath: string; sha256: string; byteLength: number }> {
    this.faultInjection?.beforeFileOperation('staging_write');
    const id = `artifact_stage_${randomUUID()}`;
    const relativePath = `.staging/${id}`;
    const absolutePath = this.absolute(relativePath);
    const source = await open(sourcePath, 'r');
    const destination = await open(absolutePath, 'wx', 0o600);
    const hash = createHash('sha256');
    let byteLength = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await destination.write(chunk);
        byteLength += bytesRead;
      }
      await destination.sync();
    } catch (error) {
      await safeUnlink(absolutePath);
      throw error;
    } finally {
      await Promise.all([source.close(), destination.close()]);
    }
    await chmod(absolutePath, 0o600);
    return { id, relativePath, absolutePath, sha256: hash.digest('hex'), byteLength };
  }

  private writeStagingBytesSync(bytes: Uint8Array): { id: string; relativePath: string; absolutePath: string; sha256: string; byteLength: number } {
    this.faultInjection?.beforeFileOperation('staging_write');
    const id = `artifact_stage_${randomUUID()}`;
    const relativePath = `.staging/${id}`;
    const absolutePath = this.absolute(relativePath);
    const descriptor = openSync(absolutePath, 'wx', 0o600);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      fsyncSync(descriptor);
    } catch (error) {
      safeUnlinkSync(absolutePath);
      throw error;
    } finally {
      closeSync(descriptor);
    }
    chmodSync(absolutePath, 0o600);
    return { id, relativePath, absolutePath, sha256: sha256(bytes), byteLength: bytes.byteLength };
  }

  private writeStagingFileSync(sourcePath: string): { id: string; relativePath: string; absolutePath: string; sha256: string; byteLength: number } {
    this.faultInjection?.beforeFileOperation('staging_write');
    const id = `artifact_stage_${randomUUID()}`;
    const relativePath = `.staging/${id}`;
    const absolutePath = this.absolute(relativePath);
    const source = openSync(sourcePath, 'r');
    const destination = openSync(absolutePath, 'wx', 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let byteLength = 0;
    try {
      while (true) {
        const bytesRead = readSync(source, buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) offset += writeSync(destination, chunk, offset, chunk.byteLength - offset);
        byteLength += bytesRead;
      }
      fsyncSync(destination);
    } catch (error) {
      safeUnlinkSync(absolutePath);
      throw error;
    } finally {
      closeSync(source);
      closeSync(destination);
    }
    chmodSync(absolutePath, 0o600);
    return { id, relativePath, absolutePath, sha256: hash.digest('hex'), byteLength };
  }

  private commitAndPromoteSync(input: {
    staged: { id: string; relativePath: string; absolutePath: string; sha256: string; byteLength: number };
    contentSha256: string;
    contentByteLength: number;
    mimeType: string;
    encoding: ArtifactEncoding;
    generationId: string;
    owner: ArtifactOwnerIdentity;
    createdAt: string;
  }): ArtifactRef {
    const relativePath = objectRelativePath(input.staged.sha256);
    const existing = this.db.get<ArtifactObjectRow>(`SELECT * FROM artifact_objects WHERE sha256 = ?`, [input.staged.sha256]);
    if (existing) {
      assertSameArtifact(existing, input);
      if (existing.state === 'staging') this.recoverObjectSync(existing);
      const current = this.requireObject(existing.sha256);
      if (current.state !== 'promoted') {
        safeUnlinkSync(input.staged.absolutePath);
        throw artifactError('ZEUS_ARTIFACT_TRANSITIONING', `相同 Artifact 当前不可复用：${current.state}`);
      }
      verifyImmutableFileSync(this.absolute(current.relative_path), current.sha256, current.byte_length, true);
      this.db.durableTransactionSync(() => this.insertOwner(current.sha256, input.owner, input.createdAt));
      safeUnlinkSync(input.staged.absolutePath);
      return mapArtifactRef(current, input.owner, input.createdAt);
    }

    try {
      this.db.durableTransactionSync(() => {
        this.db.execute(
          `INSERT INTO artifact_objects
           (sha256, content_sha256, byte_length, content_byte_length, mime_type, encoding, generation_id,
            relative_path, state, created_at, promoted_at, quarantined_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, NULL, NULL, NULL)`,
          [input.staged.sha256, input.contentSha256, input.staged.byteLength, input.contentByteLength, input.mimeType, input.encoding, input.generationId, relativePath, input.createdAt],
        );
        this.db.execute(
          `INSERT INTO artifact_staging_operations
           (id, artifact_sha256, staging_relative_path, state, last_error_json, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
          [input.staged.id, input.staged.sha256, input.staged.relativePath, input.createdAt, input.createdAt],
        );
        this.insertOwner(input.staged.sha256, input.owner, input.createdAt);
      });
    } catch (error) {
      safeUnlinkSync(input.staged.absolutePath);
      throw error;
    }

    const object = this.requireObject(input.staged.sha256);
    const staging = this.db.get<StagingRow>(`SELECT id, artifact_sha256, staging_relative_path, state FROM artifact_staging_operations WHERE id = ?`, [input.staged.id])!;
    try {
      this.promoteStagedObjectSync(staging, object);
      this.markPromoted(staging.id, object.sha256, input.createdAt);
    } catch (error) {
      this.db.durableTransactionSync(() => this.db.execute(`UPDATE artifact_staging_operations SET state = 'promotion_failed', last_error_json = ?, updated_at = ? WHERE id = ?`, [safeErrorJson(error), this.now(), staging.id]));
      throw artifactError('ZEUS_ARTIFACT_TRANSITIONING', 'Artifact 引用已持久化，但对象提升尚未完成；需执行 staging 恢复。', error);
    }
    return mapArtifactRef(this.requireObject(object.sha256), input.owner, input.createdAt);
  }

  private recoverObjectSync(object: ArtifactObjectRow): void {
    const staging = this.db.get<StagingRow>(`SELECT id, artifact_sha256, staging_relative_path, state FROM artifact_staging_operations WHERE artifact_sha256 = ?`, [object.sha256]);
    if (!staging) throw artifactError('ZEUS_ARTIFACT_DAMAGED', 'staging Artifact 缺少恢复记录。');
    this.promoteStagedObjectSync(staging, object);
    this.markPromoted(staging.id, object.sha256, this.now());
  }

  private promoteStagedObjectSync(staging: StagingRow, object: ArtifactObjectRow): void {
    const source = this.absolute(staging.staging_relative_path);
    const destination = this.absolute(object.relative_path);
    ensurePrivateDirectorySync(dirname(destination));
    if (regularFileExistsSync(destination)) {
      verifyImmutableFileSync(destination, object.sha256, object.byte_length, true);
      safeUnlinkSync(source);
      return;
    }
    verifyImmutableFileSync(source, object.sha256, object.byte_length, true);
    if (statSync(source).dev !== statSync(dirname(destination)).dev) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact staging 与提升目标不在同一文件系统。');
    try {
      linkSync(source, destination);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      verifyImmutableFileSync(destination, object.sha256, object.byte_length, true);
    }
    chmodSync(destination, 0o600);
    safeUnlinkSync(source);
  }

  private async commitAndPromote(input: {
    staged: { id: string; relativePath: string; absolutePath: string; sha256: string; byteLength: number };
    contentSha256: string;
    contentByteLength: number;
    mimeType: string;
    encoding: ArtifactEncoding;
    generationId: string;
    owner: ArtifactOwnerIdentity;
    createdAt: string;
  }): Promise<ArtifactRef> {
    const relativePath = objectRelativePath(input.staged.sha256);
    const existing = this.db.get<ArtifactObjectRow>(`SELECT * FROM artifact_objects WHERE sha256 = ?`, [input.staged.sha256]);
    if (existing) {
      assertSameArtifact(existing, input);
      if (existing.state === 'staging') await this.recoverObject(existing);
      const current = this.requireObject(existing.sha256);
      if (current.state !== 'promoted') {
        await safeUnlink(input.staged.absolutePath);
        throw artifactError('ZEUS_ARTIFACT_TRANSITIONING', `相同 Artifact 当前不可复用：${current.state}`);
      }
      await verifyImmutableFile(this.absolute(current.relative_path), current.sha256, current.byte_length, true);
      this.db.durableTransactionSync(() => this.insertOwner(current.sha256, input.owner, input.createdAt));
      await safeUnlink(input.staged.absolutePath);
      return mapArtifactRef(current, input.owner, input.createdAt);
    }

    try {
      this.db.durableTransactionSync(() => {
        this.db.execute(
          `INSERT INTO artifact_objects
           (sha256, content_sha256, byte_length, content_byte_length, mime_type, encoding, generation_id,
            relative_path, state, created_at, promoted_at, quarantined_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, NULL, NULL, NULL)`,
          [input.staged.sha256, input.contentSha256, input.staged.byteLength, input.contentByteLength, input.mimeType, input.encoding, input.generationId, relativePath, input.createdAt],
        );
        this.db.execute(
          `INSERT INTO artifact_staging_operations
           (id, artifact_sha256, staging_relative_path, state, last_error_json, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
          [input.staged.id, input.staged.sha256, input.staged.relativePath, input.createdAt, input.createdAt],
        );
        this.insertOwner(input.staged.sha256, input.owner, input.createdAt);
      });
    } catch (error) {
      await safeUnlink(input.staged.absolutePath);
      throw error;
    }

    const object = this.requireObject(input.staged.sha256);
    const staging = this.db.get<StagingRow>(`SELECT id, artifact_sha256, staging_relative_path, state FROM artifact_staging_operations WHERE id = ?`, [input.staged.id])!;
    try {
      await this.promoteStagedObject(staging, object);
      this.markPromoted(staging.id, object.sha256, input.createdAt);
    } catch (error) {
      this.db.durableTransactionSync(() => this.db.execute(`UPDATE artifact_staging_operations SET state = 'promotion_failed', last_error_json = ?, updated_at = ? WHERE id = ?`, [safeErrorJson(error), this.now(), staging.id]));
      throw artifactError('ZEUS_ARTIFACT_TRANSITIONING', 'Artifact 引用已持久化，但对象提升尚未完成；需执行 staging 恢复。', error);
    }
    return mapArtifactRef(this.requireObject(object.sha256), input.owner, input.createdAt);
  }

  private async recoverObject(object: ArtifactObjectRow): Promise<void> {
    const staging = this.db.get<StagingRow>(`SELECT id, artifact_sha256, staging_relative_path, state FROM artifact_staging_operations WHERE artifact_sha256 = ?`, [object.sha256]);
    if (!staging) throw artifactError('ZEUS_ARTIFACT_DAMAGED', 'staging Artifact 缺少恢复记录。');
    await this.promoteStagedObject(staging, object);
    this.markPromoted(staging.id, object.sha256, this.now());
  }

  private async promoteStagedObject(staging: StagingRow, object: ArtifactObjectRow): Promise<void> {
    const source = this.absolute(staging.staging_relative_path);
    const destination = this.absolute(object.relative_path);
    await ensurePrivateDirectory(dirname(destination));
    if (await regularFileExists(destination)) {
      await verifyImmutableFile(destination, object.sha256, object.byte_length, true);
      await safeUnlink(source);
      return;
    }
    await verifyImmutableFile(source, object.sha256, object.byte_length, true);
    const [sourceStat, destinationParentStat] = await Promise.all([stat(source), stat(dirname(destination))]);
    if (sourceStat.dev !== destinationParentStat.dev) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact staging 与提升目标不在同一文件系统。');
    try {
      await link(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await verifyImmutableFile(destination, object.sha256, object.byte_length, true);
    }
    await chmod(destination, 0o600);
    await safeUnlink(source);
  }

  private markPromoted(stagingId: string, sha: string, promotedAt: string): void {
    this.db.durableTransactionSync(() => {
      this.db.execute(`UPDATE artifact_objects SET state = 'promoted', promoted_at = COALESCE(promoted_at, ?) WHERE sha256 = ? AND state = 'staging'`, [normalizeTimestamp(promotedAt), sha]);
      this.db.execute(`UPDATE artifact_staging_operations SET state = 'promoted', last_error_json = NULL, updated_at = ? WHERE id = ?`, [normalizeTimestamp(promotedAt), stagingId]);
    });
  }

  private insertOwner(sha: string, owner: ArtifactOwnerIdentity, createdAt: string): void {
    const existing = this.db.get<ArtifactOwnerRow>(`SELECT * FROM artifact_owners WHERE owner_kind = ? AND owner_id = ? AND artifact_sha256 = ?`, [owner.kind, owner.id, sha]);
    if (existing) {
      if (existing.generation_id !== owner.generationId || existing.project_id !== (owner.projectId ?? null) || existing.conversation_id !== (owner.conversationId ?? null)) {
        throw artifactError('ZEUS_ARTIFACT_OWNER_MISMATCH', '相同 Artifact owner 身份被不同作用域或代次复用。');
      }
      return;
    }
    this.db.execute(
      `INSERT INTO artifact_owners
       (owner_kind, owner_id, artifact_sha256, project_id, conversation_id, generation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [owner.kind, owner.id, sha, owner.projectId ?? null, owner.conversationId ?? null, owner.generationId, createdAt],
    );
  }

  private requireOwner(sha: string, input: Pick<ArtifactOwnerIdentity, 'kind' | 'id'>): ArtifactOwnerRow {
    const kind = normalizeIdentity(input.kind, 'owner.kind');
    const id = normalizeIdentity(input.id, 'owner.id');
    const row = this.db.get<ArtifactOwnerRow>(`SELECT * FROM artifact_owners WHERE artifact_sha256 = ? AND owner_kind = ? AND owner_id = ?`, [sha, kind, id]);
    if (!row) throw artifactError('ZEUS_ARTIFACT_OWNER_MISMATCH', 'Artifact 不属于请求方提供的稳定 owner。');
    return row;
  }

  private requireObject(sha: string): ArtifactObjectRow {
    const row = this.db.get<ArtifactObjectRow>(`SELECT * FROM artifact_objects WHERE sha256 = ?`, [sha]);
    if (!row) throw artifactError('ZEUS_ARTIFACT_NOT_FOUND', 'Artifact 不存在。');
    return row;
  }

  private requireGcManifest(id: string): ArtifactGcCandidateManifest {
    return mapGcManifest(this.requireGcManifestRow(id));
  }

  private requireGcManifestRow(id: string): GcManifestRow {
    const row = this.db.get<GcManifestRow>(`SELECT * FROM artifact_gc_manifests WHERE id = ?`, [id]);
    if (!row) throw artifactError('ZEUS_ARTIFACT_NOT_FOUND', 'Artifact GC 清单不存在。');
    return row;
  }

  private absolute(relativePath: string): string {
    if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\')) throw artifactError('ZEUS_ARTIFACT_PATH_ESCAPE', 'Artifact 相对路径无效。');
    const absolutePath = resolve(this.absoluteRoot, relativePath);
    if (absolutePath !== this.absoluteRoot && !absolutePath.startsWith(`${this.absoluteRoot}${sep}`)) throw artifactError('ZEUS_ARTIFACT_PATH_ESCAPE', 'Artifact 路径逃逸根目录。');
    return absolutePath;
  }
}

function objectRelativePath(sha: string): string {
  return `objects/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
}

function normalizeOwner(input: ArtifactOwnerIdentity): ArtifactOwnerIdentity {
  return {
    kind: normalizeIdentity(input.kind, 'owner.kind'),
    id: normalizeIdentity(input.id, 'owner.id'),
    generationId: normalizeIdentity(input.generationId, 'owner.generationId'),
    projectId: input.projectId == null ? null : normalizeIdentity(input.projectId, 'owner.projectId'),
    conversationId: input.conversationId == null ? null : normalizeIdentity(input.conversationId, 'owner.conversationId'),
  };
}

function normalizeIdentity(value: string, field: string): string {
  if (typeof value !== 'string') throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', `${field} 必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumIdentityLength || !/^[\w:./@+-]+$/u.test(normalized)) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', `${field} 格式无效。`);
  return normalized;
}

function normalizeMimeType(value: string): string {
  if (typeof value !== 'string') throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'mimeType 必须是字符串。');
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > maximumMimeTypeLength || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+"'():-]+)*$/u.test(normalized)) {
    throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'mimeType 格式无效。');
  }
  return normalized;
}

function normalizeSha256(value: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'SHA-256 格式无效。');
  return normalized;
}

function normalizeTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', '时间戳无效。');
  return new Date(value).toISOString();
}

function normalizeRetentionOwnerClass(value: ArtifactRetentionOwnerClass): ArtifactRetentionOwnerClass {
  if (['active_task', 'active_conversation', 'archived_conversation', 'deleted_owner', 'export', 'restored_recovery'].includes(value)) return value;
  throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact 保留 ownerClass 无效。');
}

function normalizeReason(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || Buffer.byteLength(normalized) > 4_096) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', 'Artifact 保留原因无效。');
  return normalized;
}

function safeFilesystemBytes(blocks: number | bigint, blockSize: number | bigint): number {
  const bytes = Number(blocks) * Number(blockSize);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : Number.MAX_SAFE_INTEGER;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw artifactError('ZEUS_ARTIFACT_INVALID_ARGUMENT', `${field} 必须位于 ${minimum} 到 ${maximum}。`);
  return value;
}

function assertSameArtifact(row: ArtifactObjectRow, input: { contentSha256: string; contentByteLength: number; mimeType: string; encoding: ArtifactEncoding; staged: { byteLength: number } }): void {
  if (row.content_sha256 !== input.contentSha256 || row.content_byte_length !== input.contentByteLength || row.byte_length !== input.staged.byteLength || row.mime_type !== input.mimeType || row.encoding !== input.encoding) {
    throw artifactError('ZEUS_ARTIFACT_HASH_COLLISION', '相同存储 SHA-256 对应的 Artifact 元数据不同。');
  }
}

function mapArtifactRef(row: ArtifactObjectRow, owner: ArtifactOwnerIdentity, createdAt: string): ArtifactRef {
  return {
    storageGeneration: artifactStoreGeneration,
    sha256: row.sha256,
    contentSha256: row.content_sha256,
    byteLength: row.byte_length,
    contentByteLength: row.content_byte_length,
    mimeType: row.mime_type,
    encoding: row.encoding,
    generationId: row.generation_id,
    relativePath: row.relative_path,
    owner,
    createdAt,
  };
}

function mapOwner(row: ArtifactOwnerRow): ArtifactOwnerIdentity {
  return {
    kind: row.owner_kind,
    id: row.owner_id,
    generationId: row.generation_id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
  };
}

function mapGcManifest(row: GcManifestRow): ArtifactGcCandidateManifest {
  return {
    id: row.id,
    state: row.state,
    policy: parseGcPolicy(row.policy_json),
    manifestSha256: row.manifest_sha256,
    artifactCount: row.artifact_count,
    totalBytes: row.total_bytes,
    createdAt: row.created_at,
    quarantinedAt: row.quarantined_at,
    deleteAfter: row.delete_after,
  };
}

function parseGcPolicy(value: string): ArtifactGcCandidateManifest['policy'] {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      eligibleBefore: normalizeTimestamp(String(parsed.eligibleBefore)),
      limit: boundedInteger(Number(parsed.limit), 'limit', 1, 10_000),
      minimumQuarantineMs: boundedInteger(Number(parsed.minimumQuarantineMs), 'minimumQuarantineMs', 60_000, 365 * 24 * 60 * 60 * 1_000),
    };
  } catch (error) {
    if (error instanceof ArtifactStoreError) throw error;
    throw artifactError('ZEUS_ARTIFACT_DAMAGED', 'Artifact GC 策略不可解析。', error);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw artifactError('ZEUS_ARTIFACT_PATH_ESCAPE', `Artifact 目录不安全：${path}`);
  await chmod(path, 0o700);
}

function ensurePrivateDirectorySync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw artifactError('ZEUS_ARTIFACT_PATH_ESCAPE', `Artifact 目录不安全：${path}`);
  chmodSync(path, 0o700);
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function regularFileExistsSync(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyImmutableFile(path: string, expectedSha256: string, expectedBytes: number, verifyHash: boolean): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw artifactError('ZEUS_ARTIFACT_DAMAGED', `Artifact 文件不存在：${path}`, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expectedBytes) throw artifactError('ZEUS_ARTIFACT_DAMAGED', `Artifact 文件类型或大小不一致：${path}`);
  if (verifyHash && (await sha256File(path)) !== expectedSha256) throw artifactError('ZEUS_ARTIFACT_DAMAGED', `Artifact 文件哈希不一致：${path}`);
}

function verifyImmutableFileSync(path: string, expectedSha256: string, expectedBytes: number, verifyHash: boolean): void {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw artifactError('ZEUS_ARTIFACT_DAMAGED', `Artifact 文件不存在：${path}`, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expectedBytes) throw artifactError('ZEUS_ARTIFACT_DAMAGED', `Artifact 文件类型或大小不一致：${path}`);
  if (verifyHash && sha256FileSync(path) !== expectedSha256) throw artifactError('ZEUS_ARTIFACT_DAMAGED', `Artifact 文件哈希不一致：${path}`);
}

function sha256FileSync(path: string): string {
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function renameNoReplace(source: string, destination: string, expectedSha256: string, expectedBytes: number): Promise<void> {
  try {
    await link(source, destination);
    await unlink(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await verifyImmutableFile(destination, expectedSha256, expectedBytes, true);
    await safeUnlink(source);
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function safeUnlinkSync(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

/** zlib 使用 libuv Worker 池，避免大对象压缩/解压占用 Core JavaScript 事件循环。 */
function gzipBytes(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolveResult, rejectResult) => {
    gzip(bytes, { level: 6 }, (error, result) => {
      if (error) rejectResult(error);
      else resolveResult(result);
    });
  });
}

function gunzipBytes(bytes: Uint8Array, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolveResult, rejectResult) => {
    gunzip(bytes, { maxOutputLength }, (error, result) => {
      if (error) rejectResult(error);
      else resolveResult(result);
    });
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function safeErrorJson(error: unknown): string {
  return JSON.stringify({ name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function artifactError(code: ArtifactStoreErrorCode, message: string, cause?: unknown): ArtifactStoreError {
  return new ArtifactStoreError(code, message, cause);
}
