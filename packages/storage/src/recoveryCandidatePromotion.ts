import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, open, readFile, realpath, rename, statfs, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const recoveryCandidateMarkerMaximumBytes = 64 * 1024;
const recoveryPromotionJournalVersion = 1;
const recoveryPromotionReserveBytes = 64 * 1024 * 1024;

export type RecoveryPromotionPhase = 'preflight' | 'managed_data_prepared' | 'rollback_ready' | 'database_promoted' | 'managed_data_activated' | 'completed' | 'rolled_back' | 'failed';

export interface RecoveryPromotionOfflineLease {
  leaseId: string;
  coreState: 'stopped';
  databaseWriterCount: 0;
  acquiredAt: string;
  assertStillExclusive(): Promise<void>;
}

export interface RecoveryPromotionOfflineLeasePort {
  withExclusiveOfflineLease<T>(operation: (lease: RecoveryPromotionOfflineLease) => Promise<T>): Promise<T>;
}

export interface RecoveryPromotionManagedDataHandle {
  handleId: string;
  generationId: string;
}

/**
 * 资产与 Provider 副本必须先准备到不可见 generation，再原子激活；不能逐文件覆盖正式目录。
 * activate/rollback 必须幂等，且不得修改凭据或系统密钥。
 */
export interface RecoveryPromotionManagedDataPort {
  prepare(input: { candidatePath: string; backupId: string; packageSha256: string; manifestSha256: string; managedFileCount: number }): Promise<RecoveryPromotionManagedDataHandle>;
  activate(handle: RecoveryPromotionManagedDataHandle): Promise<void>;
  rollback(handle: RecoveryPromotionManagedDataHandle): Promise<void>;
}

export interface PromoteRecoveryCandidateInput {
  candidatePath: string;
  targetDatabasePath: string;
  rollbackDirectoryPath: string;
  expectedBackupId: string;
  expectedPackageSha256: string;
  expectedManifestSha256: string;
  expectedDatabaseSha256: string;
  expectedDatabaseBytes: number;
  expectedManifestFileCount: number;
  confirmation: string;
  offlineLeasePort: RecoveryPromotionOfflineLeasePort;
  managedDataPort?: RecoveryPromotionManagedDataPort;
  promotedAt?: string;
  freeSpaceReserveBytes?: number;
}

export interface RecoveryPromotionJournal {
  format: 'zeus-recovery-promotion-journal';
  formatVersion: 1;
  promotionId: string;
  phase: RecoveryPromotionPhase;
  backupId: string;
  packageSha256: string;
  manifestSha256: string;
  candidateDatabaseSha256: string;
  originalDatabaseSha256: string;
  targetDatabaseFileName: string;
  rollbackDatabaseFileName: string;
  stagingDatabaseFileName: string;
  managedDataHandle: RecoveryPromotionManagedDataHandle | null;
  managedFileCount: number;
  leaseId: string;
  updatedAt: string;
  error: string | null;
}

export interface PromoteRecoveryCandidateResult {
  promotionId: string;
  phase: 'completed';
  backupId: string;
  packageSha256: string;
  promotedDatabaseSha256: string;
  rollbackDatabasePath: string;
  journalPath: string;
  managedDataGenerationId: string | null;
}

export interface RecoverInterruptedRecoveryPromotionResult {
  promotionId: string;
  status: 'already_completed' | 'already_rolled_back' | 'rolled_back';
  journalPath: string;
  restoredDatabaseSha256: string;
  managedDataRolledBack: boolean;
}

/**
 * 离线原子提升已通过 restoreEncryptedRecoveryBackup 验证的候选。
 * 正式 DB 在同目录 staging 后以 POSIX rename 原子替换；原库先生成独立耐久回退副本。
 * 任一步失败都会在同一租约内尝试回退，且保留日志供下次启动核对，绝不创建空库。
 */
export async function promoteValidatedRecoveryCandidate(input: PromoteRecoveryCandidateInput): Promise<PromoteRecoveryCandidateResult> {
  assertPromotionInput(input);
  const expectedConfirmation = `PROMOTE ${input.expectedPackageSha256}`;
  if (input.confirmation !== expectedConfirmation) throw promotionError('ZEUS_RECOVERY_PROMOTION_CONFIRMATION_REQUIRED', `恢复候选必须使用精确确认：${expectedConfirmation}`);
  return input.offlineLeasePort.withExclusiveOfflineLease(async (lease) => {
    assertOfflineLease(lease);
    const promotedAt = validTimestamp(input.promotedAt ?? new Date().toISOString(), 'promotedAt');
    const promotionId = randomUUID();
    const candidateRoot = await requireRealDirectory(input.candidatePath, 'candidatePath');
    const marker = await readCandidateMarker(candidateRoot);
    assertCandidateMarker(marker, input);
    const candidateDatabasePath = join(candidateRoot, 'database', 'zeus.db');
    const targetDatabasePath = await requireExistingRegularFile(input.targetDatabasePath, 'targetDatabasePath');
    const targetDirectoryPath = dirname(targetDatabasePath);
    const rollbackDirectoryPath = await requireOrCreateRealDirectory(input.rollbackDirectoryPath, 'rollbackDirectoryPath');
    const candidateDigest = await digestRegularFile(candidateDatabasePath);
    if (candidateDigest.sha256 !== input.expectedDatabaseSha256 || candidateDigest.size !== input.expectedDatabaseBytes) {
      throw promotionError('ZEUS_RECOVERY_PROMOTION_CANDIDATE_DRIFT', '恢复候选数据库的哈希或大小与认证清单不一致。');
    }
    assertDatabaseIntegrity(candidateDatabasePath, true, '恢复候选数据库');
    const managedFileCount = input.expectedManifestFileCount - 1;
    if (managedFileCount > 0 && !input.managedDataPort) {
      throw promotionError('ZEUS_RECOVERY_PROMOTION_MANAGED_DATA_PORT_REQUIRED', '候选包含资产或 Provider 副本，必须配置版本化 managed data 提升端口。');
    }
    const availableBytes = await filesystemAvailableBytes(targetDirectoryPath);
    const originalStats = await lstat(targetDatabasePath);
    const reserveBytes = nonNegativeSafeInteger(input.freeSpaceReserveBytes ?? recoveryPromotionReserveBytes, 'freeSpaceReserveBytes');
    const requiredBytes = safeAdd(originalStats.size, candidateDigest.size, reserveBytes);
    if (availableBytes < requiredBytes) throw promotionError('ZEUS_RECOVERY_PROMOTION_SPACE_INSUFFICIENT', `恢复提升至少需要 ${requiredBytes} 字节可用空间，当前只有 ${availableBytes} 字节。`);

    checkpointOfflineDatabase(targetDatabasePath);
    await lease.assertStillExclusive();
    const originalDigest = await digestRegularFile(targetDatabasePath);
    const rollbackDatabaseFileName = `${basename(targetDatabasePath)}.recovery-${promotionId}.rollback`;
    const stagingDatabaseFileName = `.${basename(targetDatabasePath)}.recovery-${promotionId}.staging`;
    const rollbackDatabasePath = join(rollbackDirectoryPath, rollbackDatabaseFileName);
    const stagingDatabasePath = join(targetDirectoryPath, stagingDatabaseFileName);
    const journalPath = join(rollbackDirectoryPath, `recovery-promotion-${promotionId}.json`);
    let managedDataHandle: RecoveryPromotionManagedDataHandle | null = null;
    let databasePromoted = false;
    let journal: RecoveryPromotionJournal = {
      format: 'zeus-recovery-promotion-journal',
      formatVersion: recoveryPromotionJournalVersion,
      promotionId,
      phase: 'preflight',
      backupId: input.expectedBackupId,
      packageSha256: input.expectedPackageSha256,
      manifestSha256: input.expectedManifestSha256,
      candidateDatabaseSha256: candidateDigest.sha256,
      originalDatabaseSha256: originalDigest.sha256,
      targetDatabaseFileName: basename(targetDatabasePath),
      rollbackDatabaseFileName,
      stagingDatabaseFileName,
      managedDataHandle: null,
      managedFileCount,
      leaseId: lease.leaseId,
      updatedAt: promotedAt,
      error: null,
    };
    await writeAtomicJson(journalPath, journal, true);

    const persistPhase = async (phase: RecoveryPromotionPhase, error: string | null = null): Promise<void> => {
      journal = { ...journal, phase, managedDataHandle, updatedAt: new Date().toISOString(), error };
      await writeAtomicJson(journalPath, journal, false);
    };

    try {
      if (managedFileCount > 0) {
        managedDataHandle = await input.managedDataPort!.prepare({
          candidatePath: candidateRoot,
          backupId: input.expectedBackupId,
          packageSha256: input.expectedPackageSha256,
          manifestSha256: input.expectedManifestSha256,
          managedFileCount,
        });
        assertManagedDataHandle(managedDataHandle);
        await persistPhase('managed_data_prepared');
      }

      await copyFileExclusive(targetDatabasePath, rollbackDatabasePath, 0o400);
      const rollbackDigest = await digestRegularFile(rollbackDatabasePath);
      if (rollbackDigest.sha256 !== originalDigest.sha256 || rollbackDigest.size !== originalDigest.size) throw promotionError('ZEUS_RECOVERY_PROMOTION_ROLLBACK_INVALID', '原数据库回退副本的哈希或大小不一致。');
      assertDatabaseIntegrity(rollbackDatabasePath, true, '回退数据库');
      await copyFileExclusive(candidateDatabasePath, stagingDatabasePath, 0o600);
      const stagingDigest = await digestRegularFile(stagingDatabasePath);
      if (stagingDigest.sha256 !== candidateDigest.sha256 || stagingDigest.size !== candidateDigest.size) throw promotionError('ZEUS_RECOVERY_PROMOTION_STAGING_INVALID', '同目录 staging 数据库的哈希或大小不一致。');
      assertDatabaseIntegrity(stagingDatabasePath, true, 'staging 数据库');
      await syncDirectory(targetDirectoryPath);
      await persistPhase('rollback_ready');

      await lease.assertStillExclusive();
      await archiveDatabaseSidecars(targetDatabasePath, rollbackDirectoryPath, promotionId);
      await rename(stagingDatabasePath, targetDatabasePath);
      databasePromoted = true;
      await syncDirectory(targetDirectoryPath);
      await persistPhase('database_promoted');
      const promotedDigest = await digestRegularFile(targetDatabasePath);
      if (promotedDigest.sha256 !== candidateDigest.sha256 || promotedDigest.size !== candidateDigest.size) throw promotionError('ZEUS_RECOVERY_PROMOTION_POSTCHECK_FAILED', '原子提升后的数据库哈希或大小不一致。');
      assertDatabaseIntegrity(targetDatabasePath, true, '提升后数据库');

      if (managedDataHandle) {
        await input.managedDataPort!.activate(managedDataHandle);
        await persistPhase('managed_data_activated');
      }
      await lease.assertStillExclusive();
      await persistPhase('completed');
      return {
        promotionId,
        phase: 'completed',
        backupId: input.expectedBackupId,
        packageSha256: input.expectedPackageSha256,
        promotedDatabaseSha256: candidateDigest.sha256,
        rollbackDatabasePath,
        journalPath,
        managedDataGenerationId: managedDataHandle?.generationId ?? null,
      };
    } catch (error) {
      const failures: unknown[] = [error];
      if (managedDataHandle) {
        try {
          await input.managedDataPort!.rollback(managedDataHandle);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (databasePromoted) {
        try {
          await restoreDatabaseFromRollback({ targetDatabasePath, rollbackDatabasePath, expectedSha256: originalDigest.sha256, lease });
          databasePromoted = false;
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      try {
        await persistPhase(databasePromoted ? 'failed' : 'rolled_back', errorMessage(error));
      } catch (journalError) {
        failures.push(journalError);
      }
      if (failures.length > 1) throw new AggregateError(failures, '恢复候选提升失败，且至少一个回退或日志步骤未完成。');
      throw error;
    }
  });
}

/**
 * Core 启动前核对未完成日志。恢复策略固定为回退到晋升前数据库，不猜测“可能已经成功”；
 * managed data 有 handle 时必须由同一幂等端口回退，否则保持维护态并失败关闭。
 */
export async function recoverInterruptedRecoveryPromotion(input: {
  journalPath: string;
  targetDatabasePath: string;
  rollbackDirectoryPath: string;
  offlineLeasePort: RecoveryPromotionOfflineLeasePort;
  managedDataPort?: RecoveryPromotionManagedDataPort;
}): Promise<RecoverInterruptedRecoveryPromotionResult> {
  const journalPath = await requireExistingRegularFile(input.journalPath, 'journalPath');
  const targetDatabasePath = await requireExistingRegularFile(input.targetDatabasePath, 'targetDatabasePath');
  const rollbackDirectoryPath = await requireRealDirectory(input.rollbackDirectoryPath, 'rollbackDirectoryPath');
  const journal = await readPromotionJournal(journalPath);
  if (journal.targetDatabaseFileName !== basename(targetDatabasePath)) throw promotionError('ZEUS_RECOVERY_PROMOTION_JOURNAL_TARGET_MISMATCH', '恢复提升日志与目标数据库文件名不一致。');
  if (journal.phase === 'completed') {
    const digest = await digestRegularFile(targetDatabasePath);
    if (digest.sha256 !== journal.candidateDatabaseSha256) throw promotionError('ZEUS_RECOVERY_PROMOTION_COMPLETED_DRIFT', '已完成提升的正式数据库哈希已经漂移。');
    assertDatabaseIntegrity(targetDatabasePath, true, '已完成提升数据库');
    return { promotionId: journal.promotionId, status: 'already_completed', journalPath, restoredDatabaseSha256: digest.sha256, managedDataRolledBack: false };
  }
  if (journal.phase === 'rolled_back') {
    const digest = await digestRegularFile(targetDatabasePath);
    if (digest.sha256 !== journal.originalDatabaseSha256) throw promotionError('ZEUS_RECOVERY_PROMOTION_ROLLBACK_DRIFT', '已回退数据库哈希已经漂移。');
    assertDatabaseIntegrity(targetDatabasePath, true, '已回退数据库');
    return { promotionId: journal.promotionId, status: 'already_rolled_back', journalPath, restoredDatabaseSha256: digest.sha256, managedDataRolledBack: journal.managedDataHandle !== null };
  }
  return input.offlineLeasePort.withExclusiveOfflineLease(async (lease) => {
    assertOfflineLease(lease);
    await lease.assertStillExclusive();
    const rollbackDatabasePath = join(rollbackDirectoryPath, safeJournalBasename(journal.rollbackDatabaseFileName, 'rollbackDatabaseFileName'));
    let managedDataRolledBack = false;
    if (journal.managedDataHandle) {
      if (!input.managedDataPort) throw promotionError('ZEUS_RECOVERY_PROMOTION_MANAGED_DATA_PORT_REQUIRED', '中断日志包含 managed data generation，必须提供原幂等回退端口。');
      await input.managedDataPort.rollback(journal.managedDataHandle);
      managedDataRolledBack = true;
    }
    const current = await digestRegularFile(targetDatabasePath);
    if (current.sha256 === journal.candidateDatabaseSha256) {
      const rollbackDigest = await digestRegularFile(rollbackDatabasePath);
      if (rollbackDigest.sha256 !== journal.originalDatabaseSha256) throw promotionError('ZEUS_RECOVERY_PROMOTION_ROLLBACK_INVALID', '中断恢复所需的原数据库回退副本哈希不一致。');
      assertDatabaseIntegrity(rollbackDatabasePath, true, '中断恢复回退数据库');
      await restoreDatabaseFromRollback({ targetDatabasePath, rollbackDatabasePath, expectedSha256: journal.originalDatabaseSha256, lease });
    } else if (current.sha256 !== journal.originalDatabaseSha256) throw promotionError('ZEUS_RECOVERY_PROMOTION_TARGET_UNKNOWN', '中断后的正式数据库既不是原库也不是认证候选，拒绝自动覆盖。');
    await quarantineInterruptedStagingFile(targetDatabasePath, rollbackDirectoryPath, journal);
    const rolledBackJournal: RecoveryPromotionJournal = {
      ...journal,
      phase: 'rolled_back',
      leaseId: lease.leaseId,
      updatedAt: new Date().toISOString(),
      error: journal.error ?? '启动前发现未完成恢复提升，已按固定策略回退。',
    };
    await writeAtomicJson(journalPath, rolledBackJournal, false);
    const restored = await digestRegularFile(targetDatabasePath);
    if (restored.sha256 !== journal.originalDatabaseSha256) throw promotionError('ZEUS_RECOVERY_PROMOTION_ROLLBACK_FAILED', '中断恢复完成后原数据库哈希不一致。');
    return {
      promotionId: journal.promotionId,
      status: 'rolled_back',
      journalPath,
      restoredDatabaseSha256: restored.sha256,
      managedDataRolledBack,
    };
  });
}

interface RecoveryCandidateMarker {
  format: 'zeus-recovery-candidate';
  formatVersion: 1;
  backupId: string;
  packageSha256: string;
  manifestSha256: string;
  validatedAt: string;
  quickCheck: 'ok';
  promotable: true;
}

async function readCandidateMarker(candidatePath: string): Promise<RecoveryCandidateMarker> {
  const markerPath = join(candidatePath, 'recovery-candidate.json');
  const stats = await lstat(markerPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > recoveryCandidateMarkerMaximumBytes) throw promotionError('ZEUS_RECOVERY_PROMOTION_MARKER_INVALID', '恢复候选 marker 必须是有界普通文件。');
  const value = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
  const marker = value as RecoveryCandidateMarker;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    marker.format !== 'zeus-recovery-candidate' ||
    marker.formatVersion !== 1 ||
    marker.quickCheck !== 'ok' ||
    marker.promotable !== true ||
    typeof marker.backupId !== 'string' ||
    !isSha256(marker.packageSha256) ||
    !isSha256(marker.manifestSha256) ||
    typeof marker.validatedAt !== 'string' ||
    Number.isNaN(Date.parse(marker.validatedAt))
  ) {
    throw promotionError('ZEUS_RECOVERY_PROMOTION_MARKER_INVALID', '恢复候选 marker 格式或认证字段无效。');
  }
  return marker;
}

async function readPromotionJournal(path: string): Promise<RecoveryPromotionJournal> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > recoveryCandidateMarkerMaximumBytes) {
    throw promotionError('ZEUS_RECOVERY_PROMOTION_JOURNAL_INVALID', '恢复提升日志必须是有界普通文件。');
  }
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const journal = value as RecoveryPromotionJournal;
  const phases = new Set<RecoveryPromotionPhase>(['preflight', 'managed_data_prepared', 'rollback_ready', 'database_promoted', 'managed_data_activated', 'completed', 'rolled_back', 'failed']);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    journal.format !== 'zeus-recovery-promotion-journal' ||
    journal.formatVersion !== 1 ||
    typeof journal.promotionId !== 'string' ||
    !phases.has(journal.phase) ||
    typeof journal.backupId !== 'string' ||
    !isSha256(journal.packageSha256) ||
    !isSha256(journal.manifestSha256) ||
    !isSha256(journal.candidateDatabaseSha256) ||
    !isSha256(journal.originalDatabaseSha256) ||
    !Number.isSafeInteger(journal.managedFileCount) ||
    journal.managedFileCount < 0 ||
    typeof journal.leaseId !== 'string' ||
    journal.leaseId.length === 0 ||
    typeof journal.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(journal.updatedAt)) ||
    (journal.error !== null && typeof journal.error !== 'string')
  ) {
    throw promotionError('ZEUS_RECOVERY_PROMOTION_JOURNAL_INVALID', '恢复提升日志格式或认证字段无效。');
  }
  safeJournalBasename(journal.targetDatabaseFileName, 'targetDatabaseFileName');
  safeJournalBasename(journal.rollbackDatabaseFileName, 'rollbackDatabaseFileName');
  safeJournalBasename(journal.stagingDatabaseFileName, 'stagingDatabaseFileName');
  if (journal.managedDataHandle !== null) assertManagedDataHandle(journal.managedDataHandle);
  return journal;
}

async function quarantineInterruptedStagingFile(targetDatabasePath: string, rollbackDirectoryPath: string, journal: RecoveryPromotionJournal): Promise<void> {
  const stagingFileName = safeJournalBasename(journal.stagingDatabaseFileName, 'stagingDatabaseFileName');
  const stagingPath = join(dirname(targetDatabasePath), stagingFileName);
  try {
    const stats = await lstat(stagingPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw promotionError('ZEUS_RECOVERY_PROMOTION_STAGING_INVALID', '中断遗留 staging 不是普通文件。');
    const quarantinePath = join(rollbackDirectoryPath, `${stagingFileName}.interrupted-${randomUUID()}`);
    await rename(stagingPath, quarantinePath);
    await syncDirectory(dirname(targetDatabasePath));
    await syncDirectory(rollbackDirectoryPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

function safeJournalBasename(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== basename(value) || value === '.' || value === '..') {
    throw promotionError('ZEUS_RECOVERY_PROMOTION_JOURNAL_INVALID', `${field} 不是安全文件名。`);
  }
  return value;
}

function assertCandidateMarker(marker: RecoveryCandidateMarker, input: PromoteRecoveryCandidateInput): void {
  if (marker.backupId !== input.expectedBackupId || marker.packageSha256 !== input.expectedPackageSha256 || marker.manifestSha256 !== input.expectedManifestSha256) {
    throw promotionError('ZEUS_RECOVERY_PROMOTION_IDENTITY_MISMATCH', '恢复候选 marker 与用户确认的包身份不一致。');
  }
}

async function restoreDatabaseFromRollback(input: { targetDatabasePath: string; rollbackDatabasePath: string; expectedSha256: string; lease: RecoveryPromotionOfflineLease }): Promise<void> {
  await input.lease.assertStillExclusive();
  const rollbackStage = join(dirname(input.targetDatabasePath), `.${basename(input.targetDatabasePath)}.rollback-${randomUUID()}.staging`);
  await copyFileExclusive(input.rollbackDatabasePath, rollbackStage, 0o600);
  const digest = await digestRegularFile(rollbackStage);
  if (digest.sha256 !== input.expectedSha256) throw promotionError('ZEUS_RECOVERY_PROMOTION_ROLLBACK_INVALID', '回退 staging 数据库哈希无效。');
  assertDatabaseIntegrity(rollbackStage, true, '回退 staging 数据库');
  await rename(rollbackStage, input.targetDatabasePath);
  await syncDirectory(dirname(input.targetDatabasePath));
  const restored = await digestRegularFile(input.targetDatabasePath);
  if (restored.sha256 !== input.expectedSha256) throw promotionError('ZEUS_RECOVERY_PROMOTION_ROLLBACK_FAILED', '回退后的正式数据库哈希不一致。');
  assertDatabaseIntegrity(input.targetDatabasePath, true, '回退后数据库');
}

function checkpointOfflineDatabase(path: string): void {
  const db = new DatabaseSync(path, { timeout: 5_000 });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Record<string, unknown> | undefined;
    if (Number(checkpoint?.busy ?? 0) !== 0) throw promotionError('ZEUS_RECOVERY_PROMOTION_DATABASE_BUSY', '正式数据库 WAL 仍被写入者占用。');
    const quickCheck = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (String(quickCheck?.quick_check ?? '').toLowerCase() !== 'ok') throw promotionError('ZEUS_RECOVERY_PROMOTION_SOURCE_INVALID', '正式数据库 quick_check 未通过。');
  } finally {
    db.close();
  }
}

function assertDatabaseIntegrity(path: string, readOnly: boolean, label: string): void {
  const db = new DatabaseSync(path, { readOnly, timeout: 5_000 });
  try {
    const quickCheck = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (String(quickCheck?.quick_check ?? '').toLowerCase() !== 'ok') throw promotionError('ZEUS_RECOVERY_PROMOTION_DATABASE_INVALID', `${label} quick_check 未通过。`);
  } finally {
    db.close();
  }
}

async function archiveDatabaseSidecars(databasePath: string, rollbackDirectoryPath: string, promotionId: string): Promise<void> {
  for (const suffix of ['-wal', '-shm']) {
    const source = `${databasePath}${suffix}`;
    try {
      const stats = await lstat(source);
      if (!stats.isFile() || stats.isSymbolicLink()) throw promotionError('ZEUS_RECOVERY_PROMOTION_SIDECAR_INVALID', `SQLite ${suffix} 旁文件不是普通文件。`);
      await rename(source, join(rollbackDirectoryPath, `${basename(databasePath)}.recovery-${promotionId}${suffix}`));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  await syncDirectory(dirname(databasePath));
  await syncDirectory(rollbackDirectoryPath);
}

async function copyFileExclusive(source: string, destination: string, mode: number): Promise<void> {
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  const handle = await open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(path: string, value: unknown, createOnly: boolean): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  let temporaryPublished = false;
  try {
    if (!createOnly) {
      await rename(temporaryPath, path);
      temporaryPublished = true;
    } else {
      // lstat + rename 在 POSIX 上存在覆盖竞态；同目录 hard link 以 EEXIST 原子实现不可覆盖发布。
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          throw promotionError('ZEUS_RECOVERY_PROMOTION_JOURNAL_CONFLICT', '同名恢复提升日志已经存在。');
        }
        throw error;
      }
      await unlink(temporaryPath);
      temporaryPublished = true;
    }
    await syncDirectory(directory);
  } catch (error) {
    try {
      if (!temporaryPublished) await unlink(temporaryPath);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '恢复提升日志发布失败，且暂存日志无法清理。');
    }
    throw error;
  }
}

async function digestRegularFile(path: string): Promise<{ sha256: string; size: number }> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash('sha256');
  let size = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      size += result.bytesRead;
      if (!Number.isSafeInteger(size)) throw promotionError('ZEUS_RECOVERY_PROMOTION_FILE_TOO_LARGE', '数据库大小超出安全整数范围。');
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), size };
}

async function requireExistingRegularFile(pathValue: string, field: string): Promise<string> {
  const path = resolve(pathValue);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw promotionError('ZEUS_RECOVERY_PROMOTION_INVALID_ARGUMENT', `${field} 必须是已有普通文件。`);
  return realpath(path);
}

async function requireRealDirectory(pathValue: string, field: string): Promise<string> {
  const path = resolve(pathValue);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw promotionError('ZEUS_RECOVERY_PROMOTION_INVALID_ARGUMENT', `${field} 必须是已有真实目录。`);
  return realpath(path);
}

async function requireOrCreateRealDirectory(pathValue: string, field: string): Promise<string> {
  const path = resolve(pathValue);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return requireRealDirectory(path, field);
}

async function filesystemAvailableBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  const bytes = stats.bavail * stats.bsize;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw promotionError('ZEUS_RECOVERY_PROMOTION_SPACE_UNKNOWN', '无法读取恢复提升目标卷可用空间。');
  return bytes;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertPromotionInput(input: PromoteRecoveryCandidateInput): void {
  for (const [field, value] of [
    ['expectedBackupId', input.expectedBackupId],
    ['expectedPackageSha256', input.expectedPackageSha256],
    ['expectedManifestSha256', input.expectedManifestSha256],
    ['expectedDatabaseSha256', input.expectedDatabaseSha256],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw promotionError('ZEUS_RECOVERY_PROMOTION_INVALID_ARGUMENT', `${field} 必须是非空字符串。`);
  }
  for (const hash of [input.expectedPackageSha256, input.expectedManifestSha256, input.expectedDatabaseSha256]) {
    if (!isSha256(hash)) throw promotionError('ZEUS_RECOVERY_PROMOTION_INVALID_ARGUMENT', '恢复提升哈希必须是 SHA-256。');
  }
  if (!Number.isSafeInteger(input.expectedDatabaseBytes) || input.expectedDatabaseBytes <= 0) throw promotionError('ZEUS_RECOVERY_PROMOTION_INVALID_ARGUMENT', 'expectedDatabaseBytes 必须是正安全整数。');
  if (!Number.isSafeInteger(input.expectedManifestFileCount) || input.expectedManifestFileCount < 1) throw promotionError('ZEUS_RECOVERY_PROMOTION_INVALID_ARGUMENT', 'expectedManifestFileCount 至少为 1。');
  if (!input.offlineLeasePort) throw promotionError('ZEUS_RECOVERY_PROMOTION_OFFLINE_LEASE_REQUIRED', '恢复提升必须配置离线单写租约端口。');
}

function assertOfflineLease(lease: RecoveryPromotionOfflineLease): void {
  if (!lease || lease.coreState !== 'stopped' || lease.databaseWriterCount !== 0 || typeof lease.leaseId !== 'string' || lease.leaseId.length === 0 || typeof lease.assertStillExclusive !== 'function') {
    throw promotionError('ZEUS_RECOVERY_PROMOTION_OFFLINE_LEASE_INVALID', '离线租约不能证明 Core 已停止且数据库写入者为零。');
  }
  validTimestamp(lease.acquiredAt, 'lease.acquiredAt');
}

function assertManagedDataHandle(handle: RecoveryPromotionManagedDataHandle): void {
  if (!handle || typeof handle.handleId !== 'string' || handle.handleId.length === 0 || typeof handle.generationId !== 'string' || handle.generationId.length === 0) {
    throw promotionError('ZEUS_RECOVERY_PROMOTION_MANAGED_DATA_HANDLE_INVALID', 'managed data 端口返回了无效 generation 身份。');
  }
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validTimestamp(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || Number.isNaN(Date.parse(value))) throw promotionError('ZEUS_RECOVERY_PROMOTION_INVALID_ARGUMENT', `${field} 必须是有效时间字符串。`);
  return value;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw promotionError('ZEUS_RECOVERY_PROMOTION_INVALID_ARGUMENT', `${field} 必须是非负安全整数。`);
  return value;
}

function safeAdd(...values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) throw promotionError('ZEUS_RECOVERY_PROMOTION_SPACE_UNKNOWN', '恢复提升空间计算超出安全整数范围。');
  return total;
}

function promotionError(code: string, message: string): Error & { code: string; failClosed: true } {
  return Object.assign(new Error(message), { code, failClosed: true as const });
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
