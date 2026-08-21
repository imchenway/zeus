import { constants as fsConstants } from 'node:fs';
import { access, chmod, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';

const recoveryBackupFormatVersion = 1;
const recoveryBackupPackageMagic = Buffer.from('ZEUSBK01', 'ascii');
const recoveryBackupPayloadMagic = Buffer.from('ZEUSPL01', 'ascii');
const recoveryBackupAuthenticationTagBytes = 16;
const recoveryBackupKeyBytes = 32;
const recoveryBackupSaltBytes = 32;
const recoveryBackupIvBytes = 12;
const recoveryBackupMaximumHeaderBytes = 64 * 1024;
const recoveryBackupMaximumManifestBytes = 16 * 1024 * 1024;
const recoveryBackupIoChunkBytes = 1024 * 1024;
const recoveryBackupScryptN = 1 << 17;
const recoveryBackupScryptR = 8;
const recoveryBackupScryptP = 1;
const recoveryBackupScryptMaxMemoryBytes = 256 * 1024 * 1024;

export const recoveryBackupMinimumSecretBytes = 16;
export const recoveryBackupDefaultFreeSpaceReserveBytes = 64 * 1024 * 1024;

export type RecoveryBackupErrorCode =
  | 'ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT'
  | 'ZEUS_RECOVERY_BACKUP_PERMISSION_DENIED'
  | 'ZEUS_RECOVERY_BACKUP_INSUFFICIENT_SPACE'
  | 'ZEUS_RECOVERY_BACKUP_SOURCE_INTEGRITY_FAILED'
  | 'ZEUS_RECOVERY_BACKUP_PROVIDER_AUTHORIZATION_REQUIRED'
  | 'ZEUS_RECOVERY_BACKUP_PROVIDER_CONSISTENCY_REQUIRED'
  | 'ZEUS_RECOVERY_BACKUP_IMMUTABLE_CONFLICT'
  | 'ZEUS_RECOVERY_BACKUP_IO_FAILED'
  | 'ZEUS_RECOVERY_BACKUP_FORMAT_INVALID'
  | 'ZEUS_RECOVERY_BACKUP_DECRYPTION_FAILED'
  | 'ZEUS_RECOVERY_BACKUP_PACKAGE_INTEGRITY_FAILED'
  | 'ZEUS_RECOVERY_BACKUP_RESTORE_VALIDATION_FAILED';

export type RecoveryBackupPhase = 'preflight' | 'database_snapshot' | 'manifest' | 'encryption' | 'publication' | 'inspection' | 'decryption' | 'restore_validation';

/** 所有错误都失败关闭：不改源数据、不覆盖现有备份，也不把候选目录提升为正式数据。 */
export class RecoveryBackupError extends Error {
  readonly name = 'RecoveryBackupError';
  readonly failClosed = true;

  constructor(
    readonly code: RecoveryBackupErrorCode,
    readonly phase: RecoveryBackupPhase,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface RecoveryBackupAssetSourceInput {
  assetId: string;
  /** 仅由调用方显式授权的文件或目录；软链接与特殊文件一律拒绝。 */
  sourcePath: string;
  /** 相对于恢复包 assets/ 的便携路径，禁止绝对路径和 ..。 */
  relativePath: string;
  authorizationId: string;
}

export type ProviderRecoveryCapabilityGapCode = 'authorization_missing' | 'consistent_export_unavailable' | 'provider_still_running' | 'source_missing' | 'provider_unsupported';

export interface ProviderRecoveryCapabilityGap {
  code: ProviderRecoveryCapabilityGapCode;
  message: string;
}

export interface AuthorizedProviderRecoveryCopyInput {
  authorized: true;
  authorizationId: string;
  sourcePath: string;
  /** 相对于 providers/<provider>/sessions/<identity-hash>/ 的便携路径。 */
  relativePath: string;
  consistency: 'provider_closed' | 'provider_export';
  consistentAt: string;
}

interface ProviderRecoveryIdentityInputBase {
  providerId: string;
  accountScopeId: string | null;
  nativeSessionId: string;
}

export type ProviderRecoveryIdentityInput = ProviderRecoveryIdentityInputBase &
  (
    | {
        copy: AuthorizedProviderRecoveryCopyInput;
        capabilityGap?: never;
      }
    | {
        copy?: never;
        capabilityGap: ProviderRecoveryCapabilityGap;
      }
  );

export interface CreateEncryptedRecoveryBackupInput {
  sourceDatabasePath: string;
  outputDirectoryPath: string;
  /** 调用方持有密钥材料；本模块只派生本次密钥且不会把解密密钥写入包或回执。 */
  encryptionSecret: Uint8Array;
  assets?: readonly RecoveryBackupAssetSourceInput[];
  providers?: readonly ProviderRecoveryIdentityInput[];
  createdAt?: string;
  freeSpaceReserveBytes?: number;
}

export interface RecoveryBackupFileManifestEntry {
  path: string;
  kind: 'database' | 'asset' | 'provider_session';
  size: number;
  sha256: string;
  mode: number;
  assetId: string | null;
  providerIdentityIndex: number | null;
}

export interface RecoveryBackupAssetManifestEntry {
  assetId: string;
  authorizationId: string;
  archiveRoot: string;
  filePaths: string[];
}

export interface RecoveryBackupProviderManifestEntry {
  providerId: string;
  accountScopeId: string | null;
  nativeSessionId: string;
  copyStatus: 'included' | 'capability_gap';
  authorizationId: string | null;
  consistency: 'provider_closed' | 'provider_export' | null;
  consistentAt: string | null;
  filePaths: string[];
  capabilityGap: ProviderRecoveryCapabilityGap | null;
}

export interface RecoveryBackupDatabaseManifest {
  path: 'database/zeus.db';
  size: number;
  sha256: string;
  pageCount: number;
  pageSize: number;
  schemaSha256: string;
  schemaGeneration: string | null;
  schemaMigrations: Array<{ migrationId: string; checksum: string }>;
}

export interface RecoveryBackupManifest {
  format: 'zeus-recovery-manifest';
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  database: RecoveryBackupDatabaseManifest;
  files: RecoveryBackupFileManifestEntry[];
  assets: RecoveryBackupAssetManifestEntry[];
  providers: RecoveryBackupProviderManifestEntry[];
  sensitiveDataPolicy: {
    providerCredentialsIncluded: false;
    systemKeysIncluded: false;
    providerSessionCopiesRequireExplicitAuthorization: true;
  };
}

export interface RecoveryBackupPreflightResult {
  availableBytes: number;
  requiredBytes: number;
  estimatedPackageBytes: number;
  databaseLogicalBytes: number;
  selectedAssetBytes: number;
  authorizedProviderBytes: number;
  providerCapabilityGapCount: number;
}

export interface CreateEncryptedRecoveryBackupResult {
  backupId: string;
  packagePath: string;
  packageFileName: string;
  packageSha256: string;
  packageBytes: number;
  manifestSha256: string;
  manifest: RecoveryBackupManifest;
  preflight: RecoveryBackupPreflightResult;
  warnings: string[];
}

export interface RecoveryBackupPackageHeader {
  format: 'zeusbackup';
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  cipher: 'aes-256-gcm';
  kdf: 'scrypt';
  scryptN: number;
  scryptR: number;
  scryptP: number;
  saltBase64: string;
  ivBase64: string;
  manifestSha256: string;
  plaintextByteLength: number;
  fileCount: number;
}

export interface InspectEncryptedRecoveryBackupResult {
  header: RecoveryBackupPackageHeader;
  packageSha256: string;
  packageBytes: number;
  packageFileName: string;
}

export interface RestoreEncryptedRecoveryBackupInput {
  packagePath: string;
  encryptionSecret: Uint8Array;
  /** 只在该隔离父目录创建新候选；本函数绝不替换正式用户数据目录。 */
  isolationParentPath: string;
  expectedPackageSha256?: string;
  freeSpaceReserveBytes?: number;
}

export interface RestoreEncryptedRecoveryBackupResult {
  backupId: string;
  candidatePath: string;
  databasePath: string;
  packageSha256: string;
  manifestSha256: string;
  manifest: RecoveryBackupManifest;
  quickCheck: 'ok';
  promotable: true;
  providerCapabilityGaps: RecoveryBackupProviderManifestEntry[];
}

interface PreparedRecoveryFile {
  sourcePath: string;
  path: string;
  kind: RecoveryBackupFileManifestEntry['kind'];
  size: number;
  sha256: string;
  mode: number;
  assetId: string | null;
  providerIdentityIndex: number | null;
}

interface PreparedSources {
  files: PreparedRecoveryFile[];
  assets: RecoveryBackupAssetManifestEntry[];
  providers: RecoveryBackupProviderManifestEntry[];
  assetBytes: number;
  providerBytes: number;
}

interface OpenedRecoveryBackupPackage {
  handle: FileHandle;
  header: RecoveryBackupPackageHeader;
  headerPrefix: Buffer;
  payloadOffset: number;
  ciphertextBytes: number;
  packageBytes: number;
}

/**
 * 生成单文件、客户端加密、不可覆盖的 .zeusbackup。
 * SQLite 使用在线 Backup API；资产与 Provider 文件在清单和再次打包时各核验一次哈希，源漂移会中止发布。
 */
export async function createEncryptedRecoveryBackup(input: CreateEncryptedRecoveryBackupInput): Promise<CreateEncryptedRecoveryBackupResult> {
  assertEncryptionSecret(input.encryptionSecret);
  const sourceDatabasePath = resolveRequiredPath(input.sourceDatabasePath, 'sourceDatabasePath');
  const outputDirectoryPath = await requireWritableDirectory(input.outputDirectoryPath, 'outputDirectoryPath');
  const createdAt = validTimestamp(input.createdAt ?? new Date().toISOString(), 'createdAt');
  const reserveBytes = nonNegativeSafeInteger(input.freeSpaceReserveBytes ?? recoveryBackupDefaultFreeSpaceReserveBytes, 'freeSpaceReserveBytes');
  const backupId = randomUUID();
  const sourceDatabaseStats = await requireRegularFile(sourceDatabasePath, 'sourceDatabasePath');
  const sourceDb = openReadOnlyDatabase(sourceDatabasePath);
  let stagingDirectoryPath: string | null = null;
  let published = false;
  const warnings: string[] = [];

  try {
    assertDatabaseQuickCheck(sourceDb, '源 Zeus 数据库', 'preflight');
    const sourcePageCount = readSqlitePositiveInteger(sourceDb, 'page_count');
    const sourcePageSize = readSqlitePositiveInteger(sourceDb, 'page_size');
    const databaseLogicalBytes = sourcePageCount * sourcePageSize;
    if (!Number.isSafeInteger(databaseLogicalBytes)) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_SOURCE_INTEGRITY_FAILED', 'preflight', 'SQLite 数据库逻辑大小超出安全整数范围。');
    }

    const preparedSources = await prepareRecoverySources(input.assets ?? [], input.providers ?? [], outputDirectoryPath);
    const estimatedPackageBytes = databaseLogicalBytes + preparedSources.assetBytes + preparedSources.providerBytes + recoveryBackupMaximumManifestBytes;
    const requiredBytes = databaseLogicalBytes + estimatedPackageBytes + reserveBytes;
    const availableBytes = await availableFilesystemBytes(outputDirectoryPath);
    if (availableBytes < requiredBytes) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_INSUFFICIENT_SPACE', 'preflight', `恢复包至少需要 ${requiredBytes} 字节可用空间，当前仅有 ${availableBytes} 字节。`, {
        availableBytes,
        requiredBytes,
      });
    }
    const preflight: RecoveryBackupPreflightResult = {
      availableBytes,
      requiredBytes,
      estimatedPackageBytes,
      databaseLogicalBytes,
      selectedAssetBytes: preparedSources.assetBytes,
      authorizedProviderBytes: preparedSources.providerBytes,
      providerCapabilityGapCount: preparedSources.providers.filter((provider) => provider.copyStatus === 'capability_gap').length,
    };

    stagingDirectoryPath = await mkdtemp(join(outputDirectoryPath, '.zeus-recovery-backup-'));
    await chmod(stagingDirectoryPath, 0o700);
    const snapshotPath = join(stagingDirectoryPath, 'zeus.db.snapshot');
    try {
      await backup(sourceDb, snapshotPath);
      await chmod(snapshotPath, 0o600);
    } catch (error) {
      throw wrapRecoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'database_snapshot', 'SQLite Backup API 未能生成一致性快照。', error);
    }

    const snapshotDb = openReadOnlyDatabase(snapshotPath);
    let databaseManifest: RecoveryBackupDatabaseManifest;
    let databaseFile: PreparedRecoveryFile;
    try {
      assertDatabaseQuickCheck(snapshotDb, '恢复包 SQLite 快照', 'database_snapshot');
      const snapshotDigest = await digestRegularFile(snapshotPath);
      databaseManifest = readDatabaseManifest(snapshotDb, snapshotDigest);
      databaseFile = {
        sourcePath: snapshotPath,
        path: databaseManifest.path,
        kind: 'database',
        size: snapshotDigest.size,
        sha256: snapshotDigest.sha256,
        mode: 0o600,
        assetId: null,
        providerIdentityIndex: null,
      };
    } finally {
      snapshotDb.close();
    }

    if (databaseManifest.pageCount !== sourcePageCount || databaseManifest.pageSize !== sourcePageSize) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_SOURCE_INTEGRITY_FAILED', 'database_snapshot', 'SQLite Backup API 快照页边界与源数据库不一致。', {
        sourcePageCount,
        snapshotPageCount: databaseManifest.pageCount,
        sourcePageSize,
        snapshotPageSize: databaseManifest.pageSize,
      });
    }
    if (sourceDatabaseStats.size > 0 && databaseManifest.size <= 0) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_SOURCE_INTEGRITY_FAILED', 'database_snapshot', 'SQLite Backup API 产生了空快照。');
    }

    const preparedFiles = [databaseFile, ...preparedSources.files].sort((left, right) => compareCodeUnits(left.path, right.path));
    assertUniqueArchivePaths(preparedFiles);
    const manifest: RecoveryBackupManifest = {
      format: 'zeus-recovery-manifest',
      formatVersion: recoveryBackupFormatVersion,
      backupId,
      createdAt,
      database: databaseManifest,
      files: preparedFiles.map((file) => ({
        path: file.path,
        kind: file.kind,
        size: file.size,
        sha256: file.sha256,
        mode: file.mode,
        assetId: file.assetId,
        providerIdentityIndex: file.providerIdentityIndex,
      })),
      assets: preparedSources.assets,
      providers: preparedSources.providers,
      sensitiveDataPolicy: {
        providerCredentialsIncluded: false,
        systemKeysIncluded: false,
        providerSessionCopiesRequireExplicitAuthorization: true,
      },
    };
    assertRecoveryBackupManifest(manifest);

    const packageFileName = buildRecoveryBackupFileName(createdAt, backupId);
    const packagePath = join(outputDirectoryPath, packageFileName);
    const temporaryPackagePath = join(stagingDirectoryPath, `.creating-${packageFileName}`);
    const encrypted = await writeEncryptedRecoveryPackage(temporaryPackagePath, packagePath, manifest, preparedFiles, input.encryptionSecret);
    published = true;
    const publishedDigest = await digestRegularFile(packagePath);
    if (publishedDigest.sha256 !== encrypted.packageSha256 || publishedDigest.size !== encrypted.packageBytes) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_PACKAGE_INTEGRITY_FAILED', 'publication', '已发布恢复包与加密写入结果的哈希或大小不一致。', {
        expectedBytes: encrypted.packageBytes,
        actualBytes: publishedDigest.size,
      });
    }
    const inspected = await inspectEncryptedRecoveryBackup(packagePath);
    if (inspected.header.manifestSha256 !== encrypted.manifestSha256 || inspected.header.backupId !== backupId) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_PACKAGE_INTEGRITY_FAILED', 'publication', '已发布恢复包头与本次清单身份不一致。');
    }

    try {
      await rm(stagingDirectoryPath, { recursive: true, force: false });
      stagingDirectoryPath = null;
    } catch (error) {
      warnings.push(`恢复包已安全发布，但明文暂存目录清理失败：${errorMessage(error)}`);
    }

    return {
      backupId,
      packagePath,
      packageFileName,
      packageSha256: encrypted.packageSha256,
      packageBytes: encrypted.packageBytes,
      manifestSha256: encrypted.manifestSha256,
      manifest,
      preflight,
      warnings,
    };
  } catch (error) {
    if (stagingDirectoryPath) {
      try {
        await rm(stagingDirectoryPath, { recursive: true, force: false });
        stagingDirectoryPath = null;
      } catch (cleanupError) {
        throw new AggregateError([normalizeRecoveryError(error), cleanupError], `恢复包失败且明文暂存目录清理失败：${stagingDirectoryPath}`);
      }
    }
    throw normalizeRecoveryError(error, published ? '恢复包发布后校验失败；现有包保持不可变，禁止自动覆盖。' : undefined);
  } finally {
    sourceDb.close();
  }
}

/** 读取不含密钥的包头并计算整包哈希；不会解密或访问任何正式数据目录。 */
export async function inspectEncryptedRecoveryBackup(packagePathValue: string): Promise<InspectEncryptedRecoveryBackupResult> {
  const packagePath = resolveRequiredPath(packagePathValue, 'packagePath');
  const opened = await openRecoveryBackupPackage(packagePath);
  try {
    const digest = await digestOpenFile(opened.handle);
    if (digest.size !== opened.packageBytes) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_PACKAGE_INTEGRITY_FAILED', 'inspection', '恢复包在检查期间发生大小漂移。');
    }
    return {
      header: opened.header,
      packageSha256: digest.sha256,
      packageBytes: digest.size,
      packageFileName: basename(packagePath),
    };
  } finally {
    await opened.handle.close();
  }
}

/**
 * 解密到全新隔离候选，逐文件核对清单和哈希，并对恢复数据库执行 quick_check 与结构身份复核。
 * 成功仅表示候选可提升；替换正式数据必须由另一个停机、带锁、用户确认的原子提升流程完成。
 */
export async function restoreEncryptedRecoveryBackup(input: RestoreEncryptedRecoveryBackupInput): Promise<RestoreEncryptedRecoveryBackupResult> {
  assertEncryptionSecret(input.encryptionSecret);
  const packagePath = resolveRequiredPath(input.packagePath, 'packagePath');
  const isolationParentPath = await requireWritableDirectory(input.isolationParentPath, 'isolationParentPath');
  const reserveBytes = nonNegativeSafeInteger(input.freeSpaceReserveBytes ?? recoveryBackupDefaultFreeSpaceReserveBytes, 'freeSpaceReserveBytes');
  const inspected = await inspectEncryptedRecoveryBackup(packagePath);
  if (input.expectedPackageSha256 && normalizeSha256(input.expectedPackageSha256, 'expectedPackageSha256') !== inspected.packageSha256) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_PACKAGE_INTEGRITY_FAILED', 'inspection', '恢复包 SHA-256 与所选回执不一致。', {
      expectedPackageSha256: input.expectedPackageSha256,
      actualPackageSha256: inspected.packageSha256,
    });
  }

  const requiredBytes = inspected.header.plaintextByteLength + reserveBytes;
  const availableBytes = await availableFilesystemBytes(isolationParentPath);
  if (availableBytes < requiredBytes) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_INSUFFICIENT_SPACE', 'preflight', `隔离恢复至少需要 ${requiredBytes} 字节可用空间，当前仅有 ${availableBytes} 字节。`, {
      availableBytes,
      requiredBytes,
    });
  }

  const candidatePath = await mkdtemp(join(isolationParentPath, '.zeus-recovery-candidate-'));
  await chmod(candidatePath, 0o700);
  let extractor: RecoveryPayloadExtractor | null = null;
  try {
    const opened = await openRecoveryBackupPackage(packagePath);
    let manifest: RecoveryBackupManifest;
    try {
      extractor = new RecoveryPayloadExtractor(candidatePath, opened.header);
      manifest = await decryptRecoveryPayload(opened, extractor, input.encryptionSecret);
    } finally {
      await opened.handle.close();
    }

    const databasePath = joinArchivePath(candidatePath, manifest.database.path);
    const restoredDb = openReadOnlyDatabase(databasePath);
    try {
      assertDatabaseQuickCheck(restoredDb, '隔离恢复候选数据库', 'restore_validation');
      const digest = await digestRegularFile(databasePath);
      const restoredManifest = readDatabaseManifest(restoredDb, digest);
      if (JSON.stringify(restoredManifest) !== JSON.stringify(manifest.database)) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_RESTORE_VALIDATION_FAILED', 'restore_validation', '隔离恢复数据库的结构代次、页边界或哈希与清单不一致。');
      }
    } finally {
      restoredDb.close();
    }

    const marker = {
      format: 'zeus-recovery-candidate',
      formatVersion: 1,
      backupId: manifest.backupId,
      packageSha256: inspected.packageSha256,
      manifestSha256: inspected.header.manifestSha256,
      validatedAt: new Date().toISOString(),
      quickCheck: 'ok',
      promotable: true,
    } as const;
    await writeImmutableFile(join(candidatePath, 'recovery-candidate.json'), Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8'), 0o400);
    await syncDirectory(candidatePath);
    return {
      backupId: manifest.backupId,
      candidatePath,
      databasePath,
      packageSha256: inspected.packageSha256,
      manifestSha256: inspected.header.manifestSha256,
      manifest,
      quickCheck: 'ok',
      promotable: true,
      providerCapabilityGaps: manifest.providers.filter((provider) => provider.copyStatus === 'capability_gap'),
    };
  } catch (error) {
    await extractor?.abort().catch(() => undefined);
    try {
      await rm(candidatePath, { recursive: true, force: false });
    } catch (cleanupError) {
      throw new AggregateError([normalizeRecoveryError(error), cleanupError], `隔离恢复失败且候选目录清理失败：${candidatePath}`);
    }
    throw normalizeRecoveryError(error);
  }
}

async function prepareRecoverySources(assetInputs: readonly RecoveryBackupAssetSourceInput[], providerInputs: readonly ProviderRecoveryIdentityInput[], outputDirectoryPath: string): Promise<PreparedSources> {
  const files: PreparedRecoveryFile[] = [];
  const assets: RecoveryBackupAssetManifestEntry[] = [];
  const providers: RecoveryBackupProviderManifestEntry[] = [];
  let assetBytes = 0;
  let providerBytes = 0;

  for (const asset of assetInputs) {
    const assetId = requiredIdentity(asset.assetId, 'assetId');
    const authorizationId = requiredIdentity(asset.authorizationId, 'authorizationId');
    const relativePath = validateArchivePath(asset.relativePath, 'asset.relativePath');
    const archiveRoot = `assets/${relativePath}`;
    const expanded = await expandAuthorizedSource(asset.sourcePath, archiveRoot, 'asset', assetId, null, outputDirectoryPath);
    if (expanded.length === 0) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `资产 ${assetId} 没有可备份的普通文件。`);
    files.push(...expanded);
    const filePaths = expanded.map((file) => file.path).sort(compareCodeUnits);
    assets.push({ assetId, authorizationId, archiveRoot, filePaths });
    assetBytes += sumSafeFileBytes(expanded, '资产');
  }

  for (const [providerIdentityIndex, provider] of providerInputs.entries()) {
    const providerId = safeArchiveSegment(provider.providerId, 'providerId');
    const accountScopeId = provider.accountScopeId === null ? null : requiredIdentity(provider.accountScopeId, 'accountScopeId');
    const nativeSessionId = requiredIdentity(provider.nativeSessionId, 'nativeSessionId');
    if (!provider.copy) {
      const gap = validateProviderCapabilityGap(provider.capabilityGap);
      providers.push({
        providerId,
        accountScopeId,
        nativeSessionId,
        copyStatus: 'capability_gap',
        authorizationId: null,
        consistency: null,
        consistentAt: null,
        filePaths: [],
        capabilityGap: gap,
      });
      continue;
    }
    if (provider.copy.authorized !== true) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_PROVIDER_AUTHORIZATION_REQUIRED', 'preflight', `Provider ${providerId} 原生会话没有显式复制授权。`);
    }
    const authorizationId = requiredIdentity(provider.copy.authorizationId, 'provider.copy.authorizationId');
    if (provider.copy.consistency !== 'provider_closed' && provider.copy.consistency !== 'provider_export') {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_PROVIDER_CONSISTENCY_REQUIRED', 'preflight', `Provider ${providerId} 原生会话缺少正式关闭或导出一致性证明。`);
    }
    const consistentAt = validTimestamp(provider.copy.consistentAt, 'provider.copy.consistentAt');
    const relativePath = validateArchivePath(provider.copy.relativePath, 'provider.copy.relativePath');
    const identityHash = createHash('sha256')
      .update(`${providerId}\0${accountScopeId ?? ''}\0${nativeSessionId}`)
      .digest('hex')
      .slice(0, 24);
    const archiveRoot = `providers/${providerId}/sessions/${identityHash}/${relativePath}`;
    const expanded = await expandAuthorizedSource(provider.copy.sourcePath, archiveRoot, 'provider_session', null, providerIdentityIndex, outputDirectoryPath);
    if (expanded.length === 0) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_PROVIDER_CONSISTENCY_REQUIRED', 'preflight', `Provider ${providerId} 授权副本为空，不能伪称已包含原生会话。`);
    }
    files.push(...expanded);
    const filePaths = expanded.map((file) => file.path).sort(compareCodeUnits);
    providers.push({
      providerId,
      accountScopeId,
      nativeSessionId,
      copyStatus: 'included',
      authorizationId,
      consistency: provider.copy.consistency,
      consistentAt,
      filePaths,
      capabilityGap: null,
    });
    providerBytes += sumSafeFileBytes(expanded, 'Provider 原生会话');
  }

  assertUniqueArchivePaths(files);
  return { files, assets, providers, assetBytes, providerBytes };
}

async function expandAuthorizedSource(
  sourcePathValue: string,
  archiveRoot: string,
  kind: 'asset' | 'provider_session',
  assetId: string | null,
  providerIdentityIndex: number | null,
  outputDirectoryPath: string,
): Promise<PreparedRecoveryFile[]> {
  const sourcePath = resolveRequiredPath(sourcePathValue, 'sourcePath');
  const canonicalSourcePath = await realpath(sourcePath).catch((error) => {
    throw wrapRecoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'preflight', `无法解析授权备份来源：${sourcePath}`, error);
  });
  if (pathIsWithin(canonicalSourcePath, outputDirectoryPath) || pathIsWithin(outputDirectoryPath, canonicalSourcePath)) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', '备份来源与恢复包输出目录不能互相包含，避免递归纳入本次备份。');
  }
  const sourceStats = await lstat(canonicalSourcePath);
  if (sourceStats.isSymbolicLink()) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `备份来源不能是软链接：${sourcePath}`);
  if (sourceStats.isFile()) {
    return [await prepareRegularFile(canonicalSourcePath, archiveRoot, kind, assetId, providerIdentityIndex)];
  }
  if (!sourceStats.isDirectory()) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `备份来源必须是普通文件或目录：${sourcePath}`);

  const result: PreparedRecoveryFile[] = [];
  await walkDirectory(canonicalSourcePath, async (filePath) => {
    const nested = relative(canonicalSourcePath, filePath).split(sep).join('/');
    result.push(await prepareRegularFile(filePath, `${archiveRoot}/${validateArchivePath(nested, 'source relative path')}`, kind, assetId, providerIdentityIndex));
  });
  return result.sort((left, right) => compareCodeUnits(left.path, right.path));
}

async function walkDirectory(directoryPath: string, onFile: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isSymbolicLink()) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `授权备份目录包含软链接：${entryPath}`);
    if (entry.isDirectory()) {
      await walkDirectory(entryPath, onFile);
      continue;
    }
    if (!entry.isFile()) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `授权备份目录包含特殊文件：${entryPath}`);
    await onFile(entryPath);
  }
}

async function prepareRegularFile(sourcePath: string, archivePath: string, kind: 'asset' | 'provider_session', assetId: string | null, providerIdentityIndex: number | null): Promise<PreparedRecoveryFile> {
  const path = validateArchivePath(archivePath, 'archivePath');
  const digest = await digestRegularFile(sourcePath);
  return {
    sourcePath,
    path,
    kind,
    size: digest.size,
    sha256: digest.sha256,
    mode: digest.mode,
    assetId,
    providerIdentityIndex,
  };
}

async function writeEncryptedRecoveryPackage(
  temporaryPackagePath: string,
  packagePath: string,
  manifest: RecoveryBackupManifest,
  preparedFiles: readonly PreparedRecoveryFile[],
  encryptionSecret: Uint8Array,
): Promise<{ packageSha256: string; packageBytes: number; manifestSha256: string }> {
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (manifestBytes.byteLength > recoveryBackupMaximumManifestBytes) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'manifest', `恢复包清单超过 ${recoveryBackupMaximumManifestBytes} 字节上限。`);
  }
  const manifestSha256 = sha256Buffer(manifestBytes);
  const plaintextByteLength = safeAdd(recoveryBackupPayloadMagic.byteLength + 4 + manifestBytes.byteLength, ...preparedFiles.map((file) => file.size));
  const salt = randomBytes(recoveryBackupSaltBytes);
  const iv = randomBytes(recoveryBackupIvBytes);
  const header: RecoveryBackupPackageHeader = {
    format: 'zeusbackup',
    formatVersion: recoveryBackupFormatVersion,
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    scryptN: recoveryBackupScryptN,
    scryptR: recoveryBackupScryptR,
    scryptP: recoveryBackupScryptP,
    saltBase64: salt.toString('base64'),
    ivBase64: iv.toString('base64'),
    manifestSha256,
    plaintextByteLength,
    fileCount: preparedFiles.length,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBytes.byteLength > recoveryBackupMaximumHeaderBytes) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'encryption', '恢复包头超过格式上限。');
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(headerBytes.byteLength, 0);
  const headerPrefix = Buffer.concat([recoveryBackupPackageMagic, headerLength, headerBytes]);
  const payloadManifestLength = Buffer.allocUnsafe(4);
  payloadManifestLength.writeUInt32BE(manifestBytes.byteLength, 0);
  const key = await deriveRecoveryBackupKey(encryptionSecret, salt);
  const handle = await open(temporaryPackagePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600).catch((error) => {
    throw wrapRecoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'encryption', '无法独占创建加密恢复包暂存文件。', error);
  });
  const packageHash = createHash('sha256');
  let packageBytes = 0;

  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: recoveryBackupAuthenticationTagBytes });
    cipher.setAAD(headerPrefix);
    const writePackage = async (bytes: Buffer): Promise<void> => {
      if (bytes.byteLength === 0) return;
      await writeAll(handle, bytes);
      packageHash.update(bytes);
      packageBytes = safeAdd(packageBytes, bytes.byteLength);
    };
    const writePlaintext = async (bytes: Buffer): Promise<void> => writePackage(cipher.update(bytes));

    await writePackage(headerPrefix);
    await writePlaintext(recoveryBackupPayloadMagic);
    await writePlaintext(payloadManifestLength);
    await writePlaintext(manifestBytes);
    for (const file of preparedFiles) {
      const source = await openNoFollow(file.sourcePath, fsConstants.O_RDONLY);
      const sourceHash = createHash('sha256');
      let sourceBytes = 0;
      try {
        const buffer = Buffer.allocUnsafe(recoveryBackupIoChunkBytes);
        let position = 0;
        while (true) {
          const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          sourceHash.update(chunk);
          sourceBytes = safeAdd(sourceBytes, bytesRead);
          position += bytesRead;
          await writePlaintext(chunk);
        }
      } finally {
        await source.close();
      }
      const actualSha256 = sourceHash.digest('hex');
      if (sourceBytes !== file.size || actualSha256 !== file.sha256) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_SOURCE_INTEGRITY_FAILED', 'encryption', `备份来源在清单生成后发生变化：${file.path}`, {
          expectedBytes: file.size,
          actualBytes: sourceBytes,
        });
      }
    }
    await writePackage(cipher.final());
    await writePackage(cipher.getAuthTag());
    await handle.sync();
  } catch (error) {
    throw normalizeRecoveryError(error);
  } finally {
    key.fill(0);
    await handle.close();
  }

  try {
    await chmod(temporaryPackagePath, 0o400);
    const staged = await inspectEncryptedRecoveryBackup(temporaryPackagePath);
    const expectedPackageSha256 = packageHash.copy().digest('hex');
    if (staged.packageSha256 !== expectedPackageSha256 || staged.packageBytes !== packageBytes || staged.header.manifestSha256 !== manifestSha256 || staged.header.backupId !== manifest.backupId) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_PACKAGE_INTEGRITY_FAILED', 'publication', '加密恢复包暂存文件未通过发布前哈希与包头复核。');
    }
    await link(temporaryPackagePath, packagePath);
    await unlink(temporaryPackagePath);
    await syncDirectory(dirname(packagePath));
  } catch (error) {
    await unlink(temporaryPackagePath).catch(() => undefined);
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_IMMUTABLE_CONFLICT', 'publication', '同名 .zeusbackup 已存在，已拒绝覆盖。', { packageFileName: basename(packagePath) }, { cause: error });
    }
    throw wrapRecoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'publication', '无法以不可覆盖方式发布 .zeusbackup。', error);
  }
  return { packageSha256: packageHash.digest('hex'), packageBytes, manifestSha256 };
}

async function decryptRecoveryPayload(opened: OpenedRecoveryBackupPackage, extractor: RecoveryPayloadExtractor, encryptionSecret: Uint8Array): Promise<RecoveryBackupManifest> {
  const salt = decodeExactBase64(opened.header.saltBase64, recoveryBackupSaltBytes, 'saltBase64');
  const iv = decodeExactBase64(opened.header.ivBase64, recoveryBackupIvBytes, 'ivBase64');
  const key = await deriveRecoveryBackupKey(encryptionSecret, salt);
  try {
    const authTag = await readExact(opened.handle, recoveryBackupAuthenticationTagBytes, opened.packageBytes - recoveryBackupAuthenticationTagBytes);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: recoveryBackupAuthenticationTagBytes });
    decipher.setAAD(opened.headerPrefix);
    decipher.setAuthTag(authTag);
    const buffer = Buffer.allocUnsafe(recoveryBackupIoChunkBytes);
    let remaining = opened.ciphertextBytes;
    let position = opened.payloadOffset;
    let payloadError: unknown;
    while (remaining > 0) {
      const requested = Math.min(buffer.byteLength, remaining);
      const { bytesRead } = await opened.handle.read(buffer, 0, requested, position);
      if (bytesRead <= 0) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'decryption', '恢复包密文提前结束。');
      position += bytesRead;
      remaining -= bytesRead;
      const plaintext = decipher.update(buffer.subarray(0, bytesRead));
      if (!payloadError) {
        try {
          await extractor.consume(plaintext);
        } catch (error) {
          // GCM 在 final 前不会认证明文。先记住格式错误并继续完成认证，避免把错误密钥误报成普通格式问题。
          payloadError = error;
          await extractor.abort().catch(() => undefined);
        }
      }
    }
    let finalPlaintext: Buffer;
    try {
      finalPlaintext = decipher.final();
    } catch (error) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_DECRYPTION_FAILED', 'decryption', '恢复包密钥错误或密文认证失败。', {}, { cause: error });
    }
    if (payloadError) throw payloadError;
    await extractor.consume(finalPlaintext);
    return await extractor.finish();
  } finally {
    key.fill(0);
  }
}

class RecoveryPayloadExtractor {
  private prefixAndManifest = Buffer.alloc(0);
  private expectedManifestBytes: number | null = null;
  private manifest: RecoveryBackupManifest | null = null;
  private fileIndex = 0;
  private currentHandle: FileHandle | null = null;
  private currentHash: ReturnType<typeof createHash> | null = null;
  private currentRemaining = 0;
  private currentWritten = 0;

  constructor(
    private readonly candidatePath: string,
    private readonly header: RecoveryBackupPackageHeader,
  ) {}

  async consume(chunk: Buffer): Promise<void> {
    if (chunk.byteLength === 0) return;
    if (!this.manifest) {
      this.prefixAndManifest = Buffer.concat([this.prefixAndManifest, chunk]);
      if (this.prefixAndManifest.byteLength < recoveryBackupPayloadMagic.byteLength + 4) return;
      if (!this.prefixAndManifest.subarray(0, recoveryBackupPayloadMagic.byteLength).equals(recoveryBackupPayloadMagic)) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'decryption', '恢复包明文帧标识无效。');
      }
      this.expectedManifestBytes ??= this.prefixAndManifest.readUInt32BE(recoveryBackupPayloadMagic.byteLength);
      if (this.expectedManifestBytes > recoveryBackupMaximumManifestBytes) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'decryption', '恢复包清单长度超过格式上限。');
      }
      const manifestOffset = recoveryBackupPayloadMagic.byteLength + 4;
      const frameBytes = manifestOffset + this.expectedManifestBytes;
      if (this.prefixAndManifest.byteLength < frameBytes) return;
      const manifestBytes = this.prefixAndManifest.subarray(manifestOffset, frameBytes);
      if (sha256Buffer(manifestBytes) !== this.header.manifestSha256) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_PACKAGE_INTEGRITY_FAILED', 'decryption', '恢复包清单哈希与认证包头不一致。');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifestBytes.toString('utf8')) as unknown;
      } catch (error) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'decryption', '恢复包清单不是有效 JSON。', {}, { cause: error });
      }
      assertRecoveryBackupManifest(parsed);
      if (parsed.backupId !== this.header.backupId || parsed.createdAt !== this.header.createdAt || parsed.files.length !== this.header.fileCount) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_PACKAGE_INTEGRITY_FAILED', 'decryption', '恢复包清单身份与认证包头不一致。');
      }
      const expectedPlaintextBytes = safeAdd(frameBytes, ...parsed.files.map((file) => file.size));
      if (expectedPlaintextBytes !== this.header.plaintextByteLength) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'decryption', '恢复包明文长度与清单不一致。');
      }
      this.manifest = parsed;
      const remainder = this.prefixAndManifest.subarray(frameBytes);
      this.prefixAndManifest = Buffer.alloc(0);
      if (remainder.byteLength > 0) await this.consumeFileBytes(remainder);
      return;
    }
    await this.consumeFileBytes(chunk);
  }

  async finish(): Promise<RecoveryBackupManifest> {
    if (!this.manifest) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'decryption', '恢复包缺少完整清单。');
    await this.openOrFinalizeZeroLengthFiles();
    if (this.currentHandle || this.fileIndex !== this.manifest.files.length) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'decryption', '恢复包文件内容提前结束。');
    }
    return this.manifest;
  }

  async abort(): Promise<void> {
    if (this.currentHandle) {
      await this.currentHandle.close().catch(() => undefined);
      this.currentHandle = null;
    }
  }

  private async consumeFileBytes(chunk: Buffer): Promise<void> {
    if (!this.manifest) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'decryption', '恢复包尚未读取清单。');
    let offset = 0;
    while (offset < chunk.byteLength) {
      await this.openOrFinalizeZeroLengthFiles();
      if (!this.currentHandle || !this.currentHash) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'decryption', '恢复包包含超出清单的尾随明文。');
      }
      const bytes = Math.min(this.currentRemaining, chunk.byteLength - offset);
      const part = chunk.subarray(offset, offset + bytes);
      await writeAll(this.currentHandle, part);
      this.currentHash.update(part);
      this.currentRemaining -= bytes;
      this.currentWritten += bytes;
      offset += bytes;
      if (this.currentRemaining === 0) await this.finalizeCurrentFile();
    }
  }

  private async openOrFinalizeZeroLengthFiles(): Promise<void> {
    if (!this.manifest) return;
    while (!this.currentHandle && this.fileIndex < this.manifest.files.length) {
      const entry = this.manifest.files[this.fileIndex]!;
      const targetPath = joinArchivePath(this.candidatePath, entry.path);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      this.currentHandle = await open(targetPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      this.currentHash = createHash('sha256');
      this.currentRemaining = entry.size;
      this.currentWritten = 0;
      if (entry.size > 0) return;
      await this.finalizeCurrentFile();
    }
  }

  private async finalizeCurrentFile(): Promise<void> {
    if (!this.manifest || !this.currentHandle || !this.currentHash) return;
    const entry = this.manifest.files[this.fileIndex]!;
    const handle = this.currentHandle;
    const digest = this.currentHash.digest('hex');
    this.currentHandle = null;
    this.currentHash = null;
    try {
      await handle.sync();
      await handle.chmod(entry.mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (this.currentWritten !== entry.size || digest !== entry.sha256) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_PACKAGE_INTEGRITY_FAILED', 'decryption', `恢复文件与清单哈希不一致：${entry.path}`, {
        expectedBytes: entry.size,
        actualBytes: this.currentWritten,
      });
    }
    this.fileIndex += 1;
    this.currentRemaining = 0;
    this.currentWritten = 0;
  }
}

async function openRecoveryBackupPackage(packagePath: string): Promise<OpenedRecoveryBackupPackage> {
  if (!packagePath.endsWith('.zeusbackup')) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'inspection', '恢复包扩展名必须是 .zeusbackup。');
  const stats = await requireRegularFile(packagePath, 'packagePath');
  const handle = await openNoFollow(packagePath, fsConstants.O_RDONLY);
  try {
    const fixedHeader = await readExact(handle, recoveryBackupPackageMagic.byteLength + 4, 0);
    if (!fixedHeader.subarray(0, recoveryBackupPackageMagic.byteLength).equals(recoveryBackupPackageMagic)) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'inspection', '不是 Zeus 加密恢复包。');
    }
    const headerBytesLength = fixedHeader.readUInt32BE(recoveryBackupPackageMagic.byteLength);
    if (headerBytesLength <= 0 || headerBytesLength > recoveryBackupMaximumHeaderBytes) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'inspection', '恢复包头长度无效。');
    }
    const headerBytes = await readExact(handle, headerBytesLength, fixedHeader.byteLength);
    let parsed: unknown;
    try {
      parsed = JSON.parse(headerBytes.toString('utf8')) as unknown;
    } catch (error) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'inspection', '恢复包头不是有效 JSON。', {}, { cause: error });
    }
    assertRecoveryBackupHeader(parsed);
    const headerPrefix = Buffer.concat([fixedHeader, headerBytes]);
    const payloadOffset = headerPrefix.byteLength;
    const ciphertextBytes = stats.size - payloadOffset - recoveryBackupAuthenticationTagBytes;
    if (ciphertextBytes !== parsed.plaintextByteLength || ciphertextBytes <= 0) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'inspection', '恢复包密文长度与认证包头不一致。');
    }
    return { handle, header: parsed, headerPrefix, payloadOffset, ciphertextBytes, packageBytes: stats.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function readDatabaseManifest(db: DatabaseSync, digest: { size: number; sha256: string }): RecoveryBackupDatabaseManifest {
  const pageCount = readSqlitePositiveInteger(db, 'page_count');
  const pageSize = readSqlitePositiveInteger(db, 'page_size');
  const schemaRows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  const schemaSha256 = sha256Buffer(Buffer.from(JSON.stringify(schemaRows), 'utf8'));
  const hasMigrationLedger = Boolean(db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get());
  const schemaMigrations = hasMigrationLedger
    ? db
        .prepare(`SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id`)
        .all()
        .map((row) => ({ migrationId: String(row.migration_id), checksum: String(row.checksum) }))
    : [];
  const hasConversationMetadata = Boolean(db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_store_metadata'`).get());
  const schemaGeneration = hasConversationMetadata ? String(db.prepare(`SELECT schema_generation FROM conversation_store_metadata WHERE singleton = 1`).get()?.schema_generation ?? '') || null : null;
  return {
    path: 'database/zeus.db',
    size: digest.size,
    sha256: digest.sha256,
    pageCount,
    pageSize,
    schemaSha256,
    schemaGeneration,
    schemaMigrations,
  };
}

function assertRecoveryBackupHeader(value: unknown): asserts value is RecoveryBackupPackageHeader {
  if (!isRecord(value)) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'inspection', '恢复包头结构无效。');
  if (
    value.format !== 'zeusbackup' ||
    value.formatVersion !== recoveryBackupFormatVersion ||
    value.cipher !== 'aes-256-gcm' ||
    value.kdf !== 'scrypt' ||
    value.scryptN !== recoveryBackupScryptN ||
    value.scryptR !== recoveryBackupScryptR ||
    value.scryptP !== recoveryBackupScryptP ||
    typeof value.backupId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.saltBase64 !== 'string' ||
    typeof value.ivBase64 !== 'string' ||
    typeof value.manifestSha256 !== 'string' ||
    !Number.isSafeInteger(value.plaintextByteLength) ||
    Number(value.plaintextByteLength) <= 0 ||
    !Number.isSafeInteger(value.fileCount) ||
    Number(value.fileCount) <= 0
  ) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'inspection', '恢复包头字段或加密参数无效。');
  }
  requiredIdentity(value.backupId, 'header.backupId');
  validTimestamp(value.createdAt, 'header.createdAt');
  normalizeSha256(value.manifestSha256, 'header.manifestSha256');
  decodeExactBase64(value.saltBase64, recoveryBackupSaltBytes, 'header.saltBase64');
  decodeExactBase64(value.ivBase64, recoveryBackupIvBytes, 'header.ivBase64');
}

function assertRecoveryBackupManifest(value: unknown): asserts value is RecoveryBackupManifest {
  if (!isRecord(value)) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '恢复包清单结构无效。');
  if (
    value.format !== 'zeus-recovery-manifest' ||
    value.formatVersion !== recoveryBackupFormatVersion ||
    typeof value.backupId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.assets) ||
    !Array.isArray(value.providers) ||
    !isRecord(value.database) ||
    !isRecord(value.sensitiveDataPolicy)
  ) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '恢复包清单缺少必要字段。');
  }
  requiredIdentity(value.backupId, 'manifest.backupId');
  validTimestamp(value.createdAt, 'manifest.createdAt');
  if (value.sensitiveDataPolicy.providerCredentialsIncluded !== false || value.sensitiveDataPolicy.systemKeysIncluded !== false || value.sensitiveDataPolicy.providerSessionCopiesRequireExplicitAuthorization !== true) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '恢复包敏感数据策略无效。');
  }

  const files = value.files as unknown[];
  const paths = new Set<string>();
  for (const raw of files) {
    if (!isRecord(raw)) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '恢复包文件条目无效。');
    const path = typeof raw.path === 'string' ? validateArchivePath(raw.path, 'manifest.files.path') : '';
    if (paths.has(path)) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', `恢复包清单包含重复路径：${path}`);
    paths.add(path);
    if (
      (raw.kind !== 'database' && raw.kind !== 'asset' && raw.kind !== 'provider_session') ||
      !Number.isSafeInteger(raw.size) ||
      Number(raw.size) < 0 ||
      typeof raw.sha256 !== 'string' ||
      !Number.isSafeInteger(raw.mode) ||
      Number(raw.mode) < 0 ||
      Number(raw.mode) > 0o777 ||
      (raw.assetId !== null && typeof raw.assetId !== 'string') ||
      (raw.providerIdentityIndex !== null && (!Number.isSafeInteger(raw.providerIdentityIndex) || Number(raw.providerIdentityIndex) < 0))
    ) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', `恢复包文件条目字段无效：${path}`);
    }
    normalizeSha256(raw.sha256, 'manifest.files.sha256');
  }
  const sortedPaths = [...paths].sort(compareCodeUnits);
  if (JSON.stringify([...paths]) !== JSON.stringify(sortedPaths)) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '恢复包文件清单必须按便携路径稳定排序。');
  }

  const database = value.database;
  if (
    database.path !== 'database/zeus.db' ||
    !Number.isSafeInteger(database.size) ||
    Number(database.size) <= 0 ||
    typeof database.sha256 !== 'string' ||
    !Number.isSafeInteger(database.pageCount) ||
    Number(database.pageCount) <= 0 ||
    !Number.isSafeInteger(database.pageSize) ||
    Number(database.pageSize) <= 0 ||
    typeof database.schemaSha256 !== 'string' ||
    (database.schemaGeneration !== null && typeof database.schemaGeneration !== 'string') ||
    !Array.isArray(database.schemaMigrations)
  ) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '恢复包数据库清单无效。');
  }
  normalizeSha256(database.sha256, 'manifest.database.sha256');
  normalizeSha256(database.schemaSha256, 'manifest.database.schemaSha256');
  const databaseFile = files.find((raw) => isRecord(raw) && raw.path === 'database/zeus.db');
  if (!isRecord(databaseFile) || databaseFile.kind !== 'database' || databaseFile.size !== database.size || databaseFile.sha256 !== database.sha256) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '数据库文件条目与数据库清单不一致。');
  }
  if (databaseFile.assetId !== null || databaseFile.providerIdentityIndex !== null || files.filter((raw) => isRecord(raw) && raw.kind === 'database').length !== 1) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '恢复包必须且只能包含一个无外部归属的数据库文件。');
  }
  for (const migration of database.schemaMigrations) {
    if (!isRecord(migration) || typeof migration.migrationId !== 'string' || typeof migration.checksum !== 'string') {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '数据库迁移身份条目无效。');
    }
  }

  const filesByPath = new Map(files.flatMap((raw) => (isRecord(raw) && typeof raw.path === 'string' ? [[raw.path, raw] as const] : [])));
  const referencedProviderPaths = new Set<string>();
  for (const [providerIndex, provider] of (value.providers as unknown[]).entries()) {
    if (!isRecord(provider) || typeof provider.providerId !== 'string' || typeof provider.nativeSessionId !== 'string' || !Array.isArray(provider.filePaths)) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', 'Provider 恢复身份条目无效。');
    }
    if (provider.copyStatus === 'included') {
      if (typeof provider.authorizationId !== 'string' || (provider.consistency !== 'provider_closed' && provider.consistency !== 'provider_export') || typeof provider.consistentAt !== 'string' || provider.capabilityGap !== null) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '已包含的 Provider 副本缺少授权或一致性证明。');
      }
      for (const filePath of provider.filePaths) {
        const file = typeof filePath === 'string' ? filesByPath.get(filePath) : undefined;
        if (!file || file.kind !== 'provider_session' || file.providerIdentityIndex !== providerIndex || file.assetId !== null || referencedProviderPaths.has(filePath as string)) {
          throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', 'Provider 副本引用了清单外、归属错误或重复的文件。');
        }
        referencedProviderPaths.add(filePath as string);
      }
    } else if (provider.copyStatus === 'capability_gap') {
      validateProviderCapabilityGap(provider.capabilityGap);
      if (provider.filePaths.length !== 0) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '能力缺口 Provider 不得伪装包含副本文件。');
    } else {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', 'Provider 副本状态无效。');
    }
  }

  const referencedAssetPaths = new Set<string>();
  for (const asset of value.assets as unknown[]) {
    if (!isRecord(asset) || typeof asset.assetId !== 'string' || typeof asset.authorizationId !== 'string' || typeof asset.archiveRoot !== 'string' || !Array.isArray(asset.filePaths)) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '资产清单条目无效。');
    }
    for (const filePath of asset.filePaths) {
      const file = typeof filePath === 'string' ? filesByPath.get(filePath) : undefined;
      if (!file || file.kind !== 'asset' || file.assetId !== asset.assetId || file.providerIdentityIndex !== null || referencedAssetPaths.has(filePath as string)) {
        throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '资产条目引用了清单外、归属错误或重复的文件。');
      }
      referencedAssetPaths.add(filePath as string);
    }
  }
  for (const raw of files) {
    if (!isRecord(raw) || typeof raw.path !== 'string') continue;
    if (raw.kind === 'provider_session' && !referencedProviderPaths.has(raw.path)) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '恢复包包含没有 Provider 身份归属的原生会话文件。');
    }
    if (raw.kind === 'asset' && !referencedAssetPaths.has(raw.path)) {
      throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'manifest', '恢复包包含没有资产清单归属的文件。');
    }
  }
}

function assertDatabaseQuickCheck(db: DatabaseSync, label: string, phase: RecoveryBackupPhase): void {
  let messages: string[];
  try {
    messages = db
      .prepare('PRAGMA quick_check')
      .all()
      .flatMap((row) => Object.values(row).map(String));
  } catch (error) {
    throw wrapRecoveryError('ZEUS_RECOVERY_BACKUP_SOURCE_INTEGRITY_FAILED', phase, `${label}无法执行 quick_check。`, error);
  }
  if (messages.length !== 1 || messages[0]?.toLowerCase() !== 'ok') {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_SOURCE_INTEGRITY_FAILED', phase, `${label} quick_check 失败：${messages.join('; ') || '无检查结果'}`);
  }
}

function readSqlitePositiveInteger(db: DatabaseSync, pragma: 'page_count' | 'page_size'): number {
  const value = Number(db.prepare(`PRAGMA ${pragma}`).get()?.[pragma]);
  if (!Number.isSafeInteger(value) || value <= 0) throw recoveryError('ZEUS_RECOVERY_BACKUP_SOURCE_INTEGRITY_FAILED', 'database_snapshot', `SQLite ${pragma} 无效。`);
  return value;
}

function openReadOnlyDatabase(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true, timeout: 5_000, enableForeignKeyConstraints: true, allowExtension: false });
  } catch (error) {
    throw wrapRecoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'preflight', `无法只读打开 SQLite 数据库：${path}`, error);
  }
}

async function requireWritableDirectory(pathValue: string, field: string): Promise<string> {
  const path = resolveRequiredPath(pathValue, field);
  let canonicalPath: string;
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('not a real directory');
    canonicalPath = await realpath(path);
    await access(canonicalPath, fsConstants.R_OK | fsConstants.W_OK);
    const probePath = join(canonicalPath, `.zeus-write-probe-${process.pid}-${randomUUID()}`);
    const probe = await open(probePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await probe.writeFile('zeus');
      await probe.sync();
    } finally {
      await probe.close();
      await unlink(probePath).catch(() => undefined);
    }
    await syncDirectory(canonicalPath);
  } catch (error) {
    throw wrapRecoveryError('ZEUS_RECOVERY_BACKUP_PERMISSION_DENIED', 'preflight', `${field} 必须是当前用户可写的真实目录。`, error);
  }
  return canonicalPath;
}

async function requireRegularFile(path: string, field: string): Promise<{ size: number }> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('not a regular file');
    if (!Number.isSafeInteger(stats.size) || stats.size < 0) throw new Error('invalid regular file size');
    return { size: stats.size };
  } catch (error) {
    throw wrapRecoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'preflight', `${field} 必须是可读取的普通文件。`, error);
  }
}

async function digestRegularFile(path: string): Promise<{ size: number; sha256: string; mode: number }> {
  const handle = await openNoFollow(path, fsConstants.O_RDONLY);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `备份来源不是普通文件：${path}`);
    const digest = await digestOpenFile(handle);
    return { ...digest, mode: stats.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function digestOpenFile(handle: FileHandle): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(recoveryBackupIoChunkBytes);
  let size = 0;
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    size = safeAdd(size, bytesRead);
    position += bytesRead;
  }
  return { size, sha256: hash.digest('hex') };
}

async function openNoFollow(path: string, flags: number): Promise<FileHandle> {
  try {
    return await open(path, flags | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw wrapRecoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'preflight', `无法安全打开普通文件：${path}`, error);
  }
}

async function availableFilesystemBytes(directoryPath: string): Promise<number> {
  const stats = await statfs(directoryPath);
  const value = stats.bavail * stats.bsize;
  if (!Number.isSafeInteger(value) || value < 0) throw recoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'preflight', '无法读取目标文件系统可用空间。');
  return value;
}

async function deriveRecoveryBackupKey(secret: Uint8Array, salt: Buffer): Promise<Buffer> {
  const material = Buffer.from(secret);
  try {
    return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
      scrypt(material, salt, recoveryBackupKeyBytes, { N: recoveryBackupScryptN, r: recoveryBackupScryptR, p: recoveryBackupScryptP, maxmem: recoveryBackupScryptMaxMemoryBytes }, (error, derivedKey) =>
        error ? rejectPromise(error) : resolvePromise(derivedKey),
      );
    });
  } catch (error) {
    throw wrapRecoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'encryption', '无法派生恢复包加密密钥。', error);
  } finally {
    material.fill(0);
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    if (bytesWritten <= 0) throw recoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'encryption', '恢复包文件写入没有取得进展。');
    offset += bytesWritten;
  }
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const result = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(result, offset, length - offset, position + offset);
    if (bytesRead <= 0) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'inspection', '恢复包提前结束。');
    offset += bytesRead;
  }
  return result;
}

async function writeImmutableFile(path: string, contents: Buffer, mode: number): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await writeAll(handle, contents);
    await handle.sync();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateProviderCapabilityGap(value: unknown): ProviderRecoveryCapabilityGap {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string' || value.message.trim().length === 0) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_PROVIDER_CONSISTENCY_REQUIRED', 'preflight', '未包含 Provider 副本时必须给出明确能力缺口。');
  }
  if (!['authorization_missing', 'consistent_export_unavailable', 'provider_still_running', 'source_missing', 'provider_unsupported'].includes(value.code)) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_PROVIDER_CONSISTENCY_REQUIRED', 'preflight', `未知 Provider 能力缺口：${value.code}`);
  }
  return { code: value.code as ProviderRecoveryCapabilityGapCode, message: value.message };
}

function validateArchivePath(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `${field} 必须是非空 POSIX 相对路径。`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `${field} 包含空段、. 或 ..。`);
  }
  return value;
}

function joinArchivePath(root: string, archivePath: string): string {
  const safePath = validateArchivePath(archivePath, 'archivePath');
  const target = resolve(root, ...safePath.split('/'));
  if (!pathIsWithin(target, root)) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'restore_validation', '恢复包路径逃逸隔离候选目录。');
  return target;
}

function pathIsWithin(candidate: string, parent: string): boolean {
  const difference = relative(resolve(parent), resolve(candidate));
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !difference.startsWith(sep));
}

function assertUniqueArchivePaths(files: readonly Pick<PreparedRecoveryFile, 'path'>[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'manifest', `恢复包便携路径重复：${file.path}`);
    paths.add(file.path);
  }
}

function buildRecoveryBackupFileName(createdAt: string, backupId: string): string {
  const timestamp = createdAt.replace(/[-:.TZ]/gu, '').slice(0, 14);
  return `zeus-${timestamp}-${backupId}.zeusbackup`;
}

function resolveRequiredPath(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `${field} 必须是非空且首尾无空白的路径。`);
  return resolve(value);
}

function requiredIdentity(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `${field} 必须是非空且首尾无空白的字符串。`);
  return value;
}

function safeArchiveSegment(value: string, field: string): string {
  const identity = requiredIdentity(value, field);
  if (!/^[a-zA-Z0-9._-]+$/u.test(identity) || identity === '.' || identity === '..') {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `${field} 不能安全用于便携恢复路径。`);
  }
  return identity;
}

function validTimestamp(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || Number.isNaN(Date.parse(value))) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `${field} 必须是有效时间字符串。`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `${field} 必须是非负安全整数。`);
  return value;
}

function assertEncryptionSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.byteLength < recoveryBackupMinimumSecretBytes) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `encryptionSecret 至少需要 ${recoveryBackupMinimumSecretBytes} 字节。`);
  }
}

function normalizeSha256(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'inspection', `${field} 必须是小写 SHA-256。`);
  return value;
}

function decodeExactBase64(value: string, bytes: number, field: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== bytes || decoded.toString('base64') !== value) throw recoveryError('ZEUS_RECOVERY_BACKUP_FORMAT_INVALID', 'inspection', `${field} 不是规范 Base64。`);
  return decoded;
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeAdd(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', '恢复包字节数超出安全整数范围。');
    total += value;
  }
  return total;
}

function sumSafeFileBytes(files: readonly Pick<PreparedRecoveryFile, 'size'>[], label: string): number {
  try {
    return safeAdd(...files.map((file) => file.size));
  } catch (error) {
    throw recoveryError('ZEUS_RECOVERY_BACKUP_INVALID_ARGUMENT', 'preflight', `${label}总大小超出安全整数范围。`, {}, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryError(code: RecoveryBackupErrorCode, phase: RecoveryBackupPhase, message: string, details: Readonly<Record<string, string | number | boolean | null>> = {}, options?: ErrorOptions): RecoveryBackupError {
  return new RecoveryBackupError(code, phase, message, details, options);
}

function wrapRecoveryError(code: RecoveryBackupErrorCode, phase: RecoveryBackupPhase, message: string, cause: unknown): RecoveryBackupError {
  if (cause instanceof RecoveryBackupError) return cause;
  return recoveryError(code, phase, `${message} ${errorMessage(cause)}`, {}, { cause });
}

function normalizeRecoveryError(error: unknown, prefix?: string): RecoveryBackupError {
  if (error instanceof RecoveryBackupError) {
    if (!prefix) return error;
    return recoveryError(error.code, error.phase, `${prefix} ${error.message}`, error.details, { cause: error });
  }
  return recoveryError('ZEUS_RECOVERY_BACKUP_IO_FAILED', 'publication', `${prefix ? `${prefix} ` : ''}${errorMessage(error)}`, {}, { cause: error });
}
