import { createHash } from 'node:crypto';
import { constants as fsConstants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ReadOnlyValidationDescriptor } from '@zeus/shared';

const maximumManifestBytes = 64 * 1024;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ReadOnlyValidationApplicationIdentity {
  bundleId: string;
  executableName: string;
  packaged: boolean;
}

/**
 * Main 模块加载期只做有界 manifest 与文件身份检查，以便在 Electron profile 创建前选定隔离 root。
 * 数据库全量摘要和 schema 会在 BrowserHost/Core 启动前由异步复验完成。
 */
export function inspectReadOnlyValidationManifest(manifestPathInput: string, applicationIdentity?: ReadOnlyValidationApplicationIdentity): ReadOnlyValidationDescriptor {
  const manifestPath = requireCanonicalRegularFile(manifestPathInput, '只读验证 manifest', 0o600);
  const serialized = readBoundedFileNoFollow(manifestPath);
  let raw: unknown;
  try {
    raw = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', '只读验证 manifest 不是有效 JSON。', error);
  }
  const manifest = requireRecord(raw, '只读验证 manifest');
  const manifestHash = requireSha256(manifest.manifestHash, 'manifestHash');
  const payload = { ...manifest };
  delete payload.manifestHash;
  if (sha256Json(payload) !== manifestHash) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_HASH_MISMATCH', '只读验证 manifest 摘要不匹配。');

  const onlineBackupSnapshot = manifest.formatVersion === 3 || manifest.formatVersion === 4;
  const migratedOnlineSnapshot = manifest.formatVersion === 4;
  requireExactKeys(
    manifest,
    migratedOnlineSnapshot
      ? ['format', 'formatVersion', 'mode', 'runId', 'createdAt', 'copyPlanHash', 'validationRoot', 'allowedApplication', 'source', 'backup', 'migration', 'database', 'manifestHash']
      : onlineBackupSnapshot
        ? ['format', 'formatVersion', 'mode', 'runId', 'createdAt', 'copyPlanHash', 'validationRoot', 'allowedApplication', 'source', 'backup', 'database', 'manifestHash']
        : ['format', 'formatVersion', 'mode', 'runId', 'createdAt', 'copyPlanHash', 'validationRoot', 'allowedApplication', 'source', 'database', 'manifestHash'],
    '只读验证 manifest',
  );
  if (manifest.format !== 'zeus-read-only-validation-manifest' || ![2, 3, 4].includes(Number(manifest.formatVersion)) || manifest.mode !== 'read_only_validation') {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', '只读验证 manifest 格式或版本不受支持。');
  }
  const runId = requireString(manifest.runId, 'runId');
  if (!uuidPattern.test(runId)) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', '只读验证 runId 无效。');
  const createdAt = requireTimestamp(manifest.createdAt, 'createdAt');
  const copyPlanHash = requireSha256(manifest.copyPlanHash, 'copyPlanHash');
  const validationRoot = requireCanonicalDirectory(manifest.validationRoot, 'validationRoot');
  const expectedDatabasePath = join(validationRoot, 'data', 'zeus.db');
  const expectedManifestPath = `${expectedDatabasePath}.read-only-validation.json`;
  if (manifestPath !== expectedManifestPath) throw validationError('ZEUS_READ_ONLY_VALIDATION_PATH_MISMATCH', '只读验证 manifest 必须与 validationRoot/data/zeus.db 同目录绑定。');

  const allowedApplication = requireRecord(manifest.allowedApplication, 'allowedApplication');
  requireExactKeys(allowedApplication, ['bundleId', 'executableName'], 'allowedApplication');
  if (allowedApplication.bundleId !== 'dev.hypha.zeus.test' || allowedApplication.executableName !== 'Zeus Test') {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_APPLICATION_MISMATCH', '只读验证 manifest 只允许 Zeus Test 身份。');
  }
  if (applicationIdentity && (!applicationIdentity.packaged || applicationIdentity.bundleId !== allowedApplication.bundleId || applicationIdentity.executableName !== allowedApplication.executableName)) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_APPLICATION_MISMATCH', '当前应用不是 manifest 授权的打包 Zeus Test。');
  }

  const source = requireRecord(manifest.source, 'source');
  requireExactKeys(source, onlineBackupSnapshot ? ['path', 'inferredDataRoot', 'device', 'inode', 'treeImmutability'] : ['path', 'inferredDataRoot', 'device', 'inode', 'sha256', 'bytes', 'treeImmutability'], 'source');
  const expectedSourceConsistency = onlineBackupSnapshot ? 'online_backup_snapshot' : 'required_quiescent';
  if (source.treeImmutability !== expectedSourceConsistency) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_SOURCE_NOT_QUIESCENT', `Desktop manifest 来源证据必须声明 ${expectedSourceConsistency}。`);
  }
  const sourceDataRoot = requireCanonicalDirectory(source.inferredDataRoot, 'source.inferredDataRoot');
  const sourcePath = requireCanonicalRegularFile(source.path, '只读验证来源数据库', 0o600);
  if (!containsPath(sourceDataRoot, sourcePath) || sourceDataRoot === sourcePath || pathsOverlap(validationRoot, sourceDataRoot)) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_SOURCE_PATH_MISMATCH', '来源数据库树与 validationRoot 未严格隔离。');
  }
  const sourceDevice = requireDecimalIdentity(source.device, 'source.device');
  const sourceInode = requireDecimalIdentity(source.inode, 'source.inode');
  const sourceBytes = onlineBackupSnapshot ? undefined : requireSafeInteger(source.bytes, 'source.bytes');
  if (!onlineBackupSnapshot) {
    const sourceStats = statSync(sourcePath, { bigint: true });
    if (sourceStats.nlink !== 1n || sourceDevice !== sourceStats.dev.toString() || sourceInode !== sourceStats.ino.toString() || BigInt(sourceBytes ?? -1) !== sourceStats.size) {
      throw validationError('ZEUS_READ_ONLY_VALIDATION_SOURCE_IDENTITY_MISMATCH', '来源数据库 nlink/device/inode/size 与 manifest 不一致。');
    }
    for (const companion of [`${sourcePath}-wal`, `${sourcePath}-shm`, `${sourcePath}-journal`]) {
      if (existsSync(companion)) throw validationError('ZEUS_READ_ONLY_VALIDATION_SOURCE_NOT_QUIESCENT', `strict 来源数据库存在伴随文件：${basename(companion)}。`);
    }
  }

  const backup = onlineBackupSnapshot ? parseOnlineBackupEvidence(manifest.backup) : undefined;
  const migration = migratedOnlineSnapshot ? parseOfflineCandidateMigrationEvidence(manifest.migration) : undefined;

  const database = requireRecord(manifest.database, 'database');
  requireExactKeys(database, ['path', 'device', 'inode', 'nlink', 'sha256', 'bytes', 'schemaSha256', 'journalMode'], 'database');
  const databasePath = requireCanonicalRegularFile(database.path, '只读验证数据库', 0o600);
  if (databasePath !== expectedDatabasePath) throw validationError('ZEUS_READ_ONLY_VALIDATION_PATH_MISMATCH', '只读验证数据库路径未绑定规范 validationRoot。');
  if (database.journalMode !== 'delete') throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_INVALID', '只读验证数据库必须使用 rollback journal。');
  const databaseStats = statSync(databasePath, { bigint: true });
  const device = requireDecimalIdentity(database.device, 'database.device');
  const inode = requireDecimalIdentity(database.inode, 'database.inode');
  const bytes = requireSafeInteger(database.bytes, 'database.bytes');
  if (database.nlink !== 1 || databaseStats.nlink !== 1n || device !== databaseStats.dev.toString() || inode !== databaseStats.ino.toString() || BigInt(bytes) !== databaseStats.size) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_IDENTITY_MISMATCH', '只读验证数据库 nlink/device/inode/size 与 manifest 不一致。');
  }
  if (device === sourceDevice && inode === sourceInode) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_SOURCE_PATH_MISMATCH', '只读验证数据库不能与来源数据库共享同一文件身份。');
  }
  for (const companion of [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]) {
    if (existsSync(companion)) throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_INVALID', `只读验证数据库存在不允许的伴随文件：${basename(companion)}。`);
  }
  assertRollbackJournalHeader(databasePath);

  return Object.freeze({
    formatVersion: migratedOnlineSnapshot ? 4 : onlineBackupSnapshot ? 3 : 2,
    mode: 'read_only_validation',
    runId,
    createdAt,
    copyPlanHash,
    manifestPath,
    manifestHash,
    validationRoot,
    allowedApplication: Object.freeze({ bundleId: 'dev.hypha.zeus.test', executableName: 'Zeus Test' }),
    source: Object.freeze({
      path: sourcePath,
      inferredDataRoot: sourceDataRoot,
      device: sourceDevice,
      inode: sourceInode,
      ...(onlineBackupSnapshot ? {} : { sha256: requireSha256(source.sha256, 'source.sha256'), bytes: sourceBytes }),
      treeImmutability: expectedSourceConsistency,
    }),
    ...(backup ? { backup: Object.freeze(backup) } : {}),
    ...(migration ? { migration: Object.freeze(migration) } : {}),
    database: Object.freeze({
      path: databasePath,
      device,
      inode,
      nlink: 1 as const,
      sha256: requireSha256(database.sha256, 'database.sha256'),
      bytes,
      schemaSha256: requireSha256(database.schemaSha256, 'database.schemaSha256'),
      journalMode: 'delete',
    }),
  });
}

/** Main 和 Detached Core 各自调用；核对期间文件发生变化也会失败关闭。 */
export async function verifyReadOnlyValidationDescriptor(descriptor: ReadOnlyValidationDescriptor): Promise<ReadOnlyValidationDescriptor> {
  const current = inspectReadOnlyValidationManifest(descriptor.manifestPath);
  if (JSON.stringify(current) !== JSON.stringify(descriptor)) throw validationError('ZEUS_READ_ONLY_VALIDATION_DESCRIPTOR_CHANGED', '只读验证描述符在启动链传递期间发生变化。');
  if (descriptor.source.treeImmutability === 'required_quiescent') {
    const sourceDigest = await digestStableFileNoFollow(descriptor.source.path, '来源数据库');
    if (sourceDigest.bytes !== descriptor.source.bytes || sourceDigest.sha256 !== descriptor.source.sha256) {
      throw validationError('ZEUS_READ_ONLY_VALIDATION_SOURCE_IDENTITY_MISMATCH', '来源数据库 SHA-256 与 strict manifest 不一致。');
    }
  }
  const digest = await digestStableFileNoFollow(descriptor.database.path, '只读验证数据库');
  if (digest.bytes !== descriptor.database.bytes || digest.sha256 !== descriptor.database.sha256) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_HASH_MISMATCH', '只读验证数据库 SHA-256 与 manifest 不一致。');
  }
  const beforeOpen = statSync(descriptor.database.path, { bigint: true });
  assertDescriptorDatabaseIdentity(beforeOpen, descriptor);
  const database = new DatabaseSync(descriptor.database.path, { readOnly: true, timeout: 30_000 });
  try {
    const afterOpen = statSync(descriptor.database.path, { bigint: true });
    assertStableFileIdentity(beforeOpen, afterOpen, '只读验证数据库在校验连接 open 前后发生变化。');
    database.exec('PRAGMA query_only = ON');
    database.enableDefensive(true);
    const quickCheck = database.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined;
    if (String(quickCheck?.quick_check ?? '').toLowerCase() !== 'ok') throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_INVALID', '只读验证数据库 quick_check 未通过。');
    const rows = database.prepare(`SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name, sql`).all() as Array<Record<string, unknown>>;
    if (sha256Json(rows) !== descriptor.database.schemaSha256) throw validationError('ZEUS_READ_ONLY_VALIDATION_SCHEMA_MISMATCH', '只读验证数据库 schema 摘要与 manifest 不一致。');
    if (descriptor.migration) {
      const pageCount = Number((database.prepare('PRAGMA page_count').get() as { page_count?: unknown } | undefined)?.page_count);
      if (pageCount !== descriptor.migration.postMigrationPageCount || descriptor.database.schemaSha256 !== descriptor.migration.postMigrationSchemaSha256) {
        throw validationError('ZEUS_READ_ONLY_VALIDATION_SCHEMA_MISMATCH', '离线迁移后的页边界或 schema 摘要与 manifest 不一致。');
      }
      const ledgerRows = database.prepare(`SELECT migration_id, description, checksum FROM schema_migrations ORDER BY migration_id`).all() as Array<Record<string, unknown>>;
      if (sha256Json(ledgerRows) !== descriptor.migration.postMigrationLedgerSha256) {
        throw validationError('ZEUS_READ_ONLY_VALIDATION_SCHEMA_MISMATCH', '离线迁移后的 schema migration 账本摘要与 manifest 不一致。');
      }
    }
  } finally {
    database.close();
  }
  for (const companion of [`${descriptor.database.path}-wal`, `${descriptor.database.path}-shm`, `${descriptor.database.path}-journal`]) {
    if (existsSync(companion)) throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_INVALID', `只读核验产生了不允许的伴随文件：${basename(companion)}。`);
  }
  return descriptor;
}

function parseOnlineBackupEvidence(value: unknown): NonNullable<ReadOnlyValidationDescriptor['backup']> {
  const backup = requireRecord(value, 'backup');
  requireExactKeys(backup, ['startedAt', 'completedAt', 'sourcePageCountBefore', 'sourcePageCountAfter', 'sourceDataVersionBefore', 'sourceDataVersionAfter', 'targetPageCount', 'pageSize', 'sourceAdvancedAfterBackup'], 'backup');
  const startedAt = requireTimestamp(backup.startedAt, 'backup.startedAt');
  const completedAt = requireTimestamp(backup.completedAt, 'backup.completedAt');
  if (Date.parse(completedAt) < Date.parse(startedAt)) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', '在线 Backup API 完成时间早于开始时间。');
  return {
    startedAt,
    completedAt,
    sourcePageCountBefore: requirePositiveSafeInteger(backup.sourcePageCountBefore, 'backup.sourcePageCountBefore'),
    sourcePageCountAfter: requirePositiveSafeInteger(backup.sourcePageCountAfter, 'backup.sourcePageCountAfter'),
    sourceDataVersionBefore: requirePositiveSafeInteger(backup.sourceDataVersionBefore, 'backup.sourceDataVersionBefore'),
    sourceDataVersionAfter: requirePositiveSafeInteger(backup.sourceDataVersionAfter, 'backup.sourceDataVersionAfter'),
    targetPageCount: requirePositiveSafeInteger(backup.targetPageCount, 'backup.targetPageCount'),
    pageSize: requirePositiveSafeInteger(backup.pageSize, 'backup.pageSize'),
    sourceAdvancedAfterBackup: requireBoolean(backup.sourceAdvancedAfterBackup, 'backup.sourceAdvancedAfterBackup'),
  };
}

function parseOfflineCandidateMigrationEvidence(value: unknown): NonNullable<ReadOnlyValidationDescriptor['migration']> {
  const migration = requireRecord(value, 'migration');
  requireExactKeys(
    migration,
    [
      'strategy',
      'startedAt',
      'completedAt',
      'sourceAccessClosedBeforeMigration',
      'runtimeWriterCount',
      'rollbackWindow',
      'preMigrationPageCount',
      'preMigrationSchemaSha256',
      'preMigrationLedgerSha256',
      'postMigrationPageCount',
      'postMigrationSchemaSha256',
      'postMigrationLedgerSha256',
      'appliedMigrationIds',
    ],
    'migration',
  );
  const startedAt = requireTimestamp(migration.startedAt, 'migration.startedAt');
  const completedAt = requireTimestamp(migration.completedAt, 'migration.completedAt');
  if (Date.parse(completedAt) < Date.parse(startedAt)) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', '离线候选迁移完成时间早于开始时间。');
  if (migration.strategy !== 'offline_candidate_schema_migration' || migration.sourceAccessClosedBeforeMigration !== true || migration.runtimeWriterCount !== 0 || migration.rollbackWindow !== 'source_unchanged_candidate_only') {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', '离线候选迁移边界无效。');
  }
  const appliedMigrationIds = requireBoundedStringArray(migration.appliedMigrationIds, 'migration.appliedMigrationIds');
  return {
    strategy: 'offline_candidate_schema_migration',
    startedAt,
    completedAt,
    sourceAccessClosedBeforeMigration: true,
    runtimeWriterCount: 0,
    rollbackWindow: 'source_unchanged_candidate_only',
    preMigrationPageCount: requirePositiveSafeInteger(migration.preMigrationPageCount, 'migration.preMigrationPageCount'),
    preMigrationSchemaSha256: requireSha256(migration.preMigrationSchemaSha256, 'migration.preMigrationSchemaSha256'),
    preMigrationLedgerSha256: requireSha256(migration.preMigrationLedgerSha256, 'migration.preMigrationLedgerSha256'),
    postMigrationPageCount: requirePositiveSafeInteger(migration.postMigrationPageCount, 'migration.postMigrationPageCount'),
    postMigrationSchemaSha256: requireSha256(migration.postMigrationSchemaSha256, 'migration.postMigrationSchemaSha256'),
    postMigrationLedgerSha256: requireSha256(migration.postMigrationLedgerSha256, 'migration.postMigrationLedgerSha256'),
    appliedMigrationIds,
  };
}

function assertDescriptorDatabaseIdentity(identity: { dev: bigint; ino: bigint; size: bigint; nlink: bigint }, descriptor: ReadOnlyValidationDescriptor): void {
  if (identity.dev.toString() !== descriptor.database.device || identity.ino.toString() !== descriptor.database.inode || identity.size !== BigInt(descriptor.database.bytes) || identity.nlink !== 1n) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_IDENTITY_MISMATCH', '只读验证数据库在 SQLite open 前已不再指向 descriptor 身份。');
  }
}

function readBoundedFileNoFollow(path: string): string {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > maximumManifestBytes) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', '只读验证 manifest 大小无效。');
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

async function digestStableFileNoFollow(path: string, label: string): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw validationError('ZEUS_READ_ONLY_VALIDATION_UNSAFE_FILE', `${label} 必须是普通文件。`);
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
      if (!Number.isSafeInteger(bytes)) throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_INVALID', '只读验证数据库大小超出安全整数范围。');
    }
    const after = await handle.stat({ bigint: true });
    assertStableFileIdentity(before, after, `${label}在摘要核对期间发生变化。`);
    assertPathStillPointsToIdentity(path, after, label);
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

function assertPathStillPointsToIdentity(path: string, expected: { dev: bigint; ino: bigint; size: bigint; mode: bigint; uid: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint }, label: string): void {
  const pathStats = lstatSync(path, { bigint: true });
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || realpathSync(path) !== path) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_CHANGED', `${label}摘要后路径不再指向规范普通文件。`);
  }
  assertStableFileIdentity(expected, pathStats, `${label}摘要后路径不再指向同一文件描述符身份。`);
}

function assertStableFileIdentity(
  before: { dev: bigint; ino: bigint; size: bigint; mode: bigint; uid: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint },
  after: { dev: bigint; ino: bigint; size: bigint; mode: bigint; uid: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint },
  message: string,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mode !== after.mode ||
    before.uid !== after.uid ||
    before.nlink !== after.nlink ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_CHANGED', message);
  }
}

function assertRollbackJournalHeader(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(100);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1) {
      throw validationError('ZEUS_READ_ONLY_VALIDATION_DATABASE_INVALID', '只读验证目标不是完整的 rollback-journal SQLite 数据库。');
    }
  } finally {
    closeSync(descriptor);
  }
}

function requireCanonicalRegularFile(value: unknown, label: string, exactMode: number): string {
  const path = requireAbsolutePath(value, label);
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) throw validationError('ZEUS_READ_ONLY_VALIDATION_UNSAFE_FILE', `${label} 必须是普通文件且不能是符号链接。`);
  if (Number(stats.mode & 0o777n) !== exactMode) throw validationError('ZEUS_READ_ONLY_VALIDATION_UNSAFE_FILE', `${label} 权限必须为 ${exactMode.toString(8).padStart(4, '0')}。`);
  if (typeof process.getuid === 'function' && stats.uid !== BigInt(process.getuid())) throw validationError('ZEUS_READ_ONLY_VALIDATION_UNSAFE_FILE', `${label} 不属于当前用户。`);
  const canonical = realpathSync(path);
  if (canonical !== path) throw validationError('ZEUS_READ_ONLY_VALIDATION_UNSAFE_FILE', `${label} 路径不是规范真实路径。`);
  return canonical;
}

function requireCanonicalDirectory(value: unknown, label: string): string {
  const path = requireAbsolutePath(value, label);
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw validationError('ZEUS_READ_ONLY_VALIDATION_UNSAFE_FILE', `${label} 必须是普通目录且不能是符号链接。`);
  if ((stats.mode & 0o077n) !== 0n) throw validationError('ZEUS_READ_ONLY_VALIDATION_UNSAFE_FILE', `${label} 权限范围过宽。`);
  if (typeof process.getuid === 'function' && stats.uid !== BigInt(process.getuid())) throw validationError('ZEUS_READ_ONLY_VALIDATION_UNSAFE_FILE', `${label} 不属于当前用户。`);
  const canonical = realpathSync(path);
  if (canonical !== path) throw validationError('ZEUS_READ_ONLY_VALIDATION_UNSAFE_FILE', `${label} 路径不是规范真实路径。`);
  return canonical;
}

function requireAbsolutePath(value: unknown, label: string): string {
  const path = requireString(value, label);
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path) throw validationError('ZEUS_READ_ONLY_VALIDATION_PATH_MISMATCH', `${label} 必须是规范绝对路径。`);
  return path;
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function containsPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 结构无效。`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 字段集合无效。`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 4_096) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 必须是有界非空字符串。`);
  return value;
}

function requireBoundedStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 512) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 必须是有界字符串数组。`);
  const entries = value.map((entry, index) => requireString(entry, `${label}[${index}]`));
  if (new Set(entries).size !== entries.length || JSON.stringify(entries) !== JSON.stringify([...entries].sort())) {
    throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 必须去重并按字典序排列。`);
  }
  return Object.freeze(entries);
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 不是有效时间。`);
  return timestamp;
}

function requireSha256(value: unknown, label: string): string {
  const hash = requireString(value, label);
  if (!sha256Pattern.test(hash)) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 不是小写 SHA-256。`);
  return hash;
}

function requireDecimalIdentity(value: unknown, label: string): string {
  const identity = requireString(value, label);
  if (!/^(0|[1-9][0-9]*)$/u.test(identity)) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 不是十进制身份。`);
  return identity;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 不是非负安全整数。`);
  return Number(value);
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const integer = requireSafeInteger(value, label);
  if (integer <= 0) throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 必须大于零。`);
  return integer;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw validationError('ZEUS_READ_ONLY_VALIDATION_MANIFEST_INVALID', `${label} 必须是布尔值。`);
  return value;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validationError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, statusCode: 503, failClosed: true as const });
}
