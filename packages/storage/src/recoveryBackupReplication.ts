import { constants as fsConstants } from 'node:fs';
import { access, chmod, copyFile, link, lstat, open, realpath, statfs, unlink } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectEncryptedRecoveryBackup, recoveryBackupDefaultFreeSpaceReserveBytes, type InspectEncryptedRecoveryBackupResult } from './recoveryBackup.js';

export interface UserSelectedRecoveryBackupDestination {
  destinationId: string;
  displayName: string;
  directoryPath: string;
  /** 仅在 Desktop Main 内短期持有；不得写入恢复包或目的地回执。 */
  securityScopedBookmark: string | null;
}

export interface RecoveryBackupDestinationSelection {
  cancelled: boolean;
  destinations: UserSelectedRecoveryBackupDestination[];
}

/** 系统目录选择器端口；实现必须由用户选择，禁止猜测 iCloud、Google Drive 或其他同步盘路径。 */
export interface RecoveryBackupDestinationPickerPort {
  chooseExactlyTwoDirectories(): Promise<RecoveryBackupDestinationSelection>;
}

/** security-scoped bookmark 的访问生命周期必须覆盖预检、复制、哈希和回执发布。 */
export interface RecoveryBackupDestinationAccessPort {
  withAccess<T>(destination: UserSelectedRecoveryBackupDestination, operation: (directoryPath: string) => Promise<T>): Promise<T>;
}

export interface ReplicateRecoveryBackupInput {
  packagePath: string;
  destinations: readonly UserSelectedRecoveryBackupDestination[];
  accessPort: RecoveryBackupDestinationAccessPort;
  copiedAt?: string;
  freeSpaceReserveBytes?: number;
}

export type RecoveryBackupDestinationCopyStatus = 'copied' | 'already_present' | 'copied_without_receipt' | 'already_present_without_receipt' | 'failed';

export interface RecoveryBackupDestinationReceipt {
  format: 'zeus-backup-destination-receipt';
  formatVersion: 1;
  backupId: string;
  destinationId: string;
  packageFileName: string;
  packageSha256: string;
  packageBytes: number;
  copiedAt: string;
  immutable: true;
}

export interface RecoveryBackupDestinationCopyResult {
  destinationId: string;
  displayName: string;
  status: RecoveryBackupDestinationCopyStatus;
  packagePath: string | null;
  receiptPath: string | null;
  packageSha256: string;
  packageBytes: number;
  error: string | null;
}

export interface ReplicateRecoveryBackupResult {
  backupId: string;
  packageSha256: string;
  packageBytes: number;
  status: 'completed' | 'partial' | 'failed';
  destinations: [RecoveryBackupDestinationCopyResult, RecoveryBackupDestinationCopyResult];
}

/** 非沙箱或已经由宿主授予访问权时使用；Desktop 正式入口应使用 security-scoped 实现。 */
export const directRecoveryBackupDestinationAccess: RecoveryBackupDestinationAccessPort = {
  withAccess: async (_destination, operation) => operation(_destination.directoryPath),
};

/**
 * 恰好复制到两个用户选择的目录。两个目的地独立完成，任何一侧失败都不会回滚另一侧已验证副本。
 * 同名文件永不覆盖；相同哈希视为幂等，内容不同则明确不可变冲突。
 */
export async function replicateRecoveryBackupToTwoDestinations(input: ReplicateRecoveryBackupInput): Promise<ReplicateRecoveryBackupResult> {
  if (input.destinations.length !== 2) throw new Error('恢复包复制必须恰好提供两个用户选择的目的地。');
  const copiedAt = validTimestamp(input.copiedAt ?? new Date().toISOString());
  const reserveBytes = nonNegativeSafeInteger(input.freeSpaceReserveBytes ?? recoveryBackupDefaultFreeSpaceReserveBytes, 'freeSpaceReserveBytes');
  const source = await inspectEncryptedRecoveryBackup(input.packagePath);
  input.destinations.forEach(validateDestinationIdentity);
  assertDistinctDestinationSelections(input.destinations);

  const results = await Promise.all(input.destinations.map((destination) => copyToDestination(input.packagePath, source, destination, input.accessPort, copiedAt, reserveBytes)));
  const [first, second] = results;
  if (!first || !second) throw new Error('恢复包双目的地复制结果不完整。');
  const fullySuccessful = results.filter((result) => result.status === 'copied' || result.status === 'already_present').length;
  const status: ReplicateRecoveryBackupResult['status'] = fullySuccessful === 2 ? 'completed' : fullySuccessful === 0 && results.every((result) => result.status === 'failed') ? 'failed' : 'partial';
  return {
    backupId: source.header.backupId,
    packageSha256: source.packageSha256,
    packageBytes: source.packageBytes,
    status,
    destinations: [first, second],
  };
}

async function copyToDestination(
  sourcePackagePath: string,
  source: InspectEncryptedRecoveryBackupResult,
  destination: UserSelectedRecoveryBackupDestination,
  accessPort: RecoveryBackupDestinationAccessPort,
  copiedAt: string,
  reserveBytes: number,
): Promise<RecoveryBackupDestinationCopyResult> {
  const baseResult = {
    destinationId: destination.destinationId,
    displayName: destination.displayName,
    packageSha256: source.packageSha256,
    packageBytes: source.packageBytes,
  };
  let packagePath: string | null = null;
  let receiptPath: string | null = null;
  let packageStatus: 'copied' | 'already_present' | null = null;

  try {
    return await accessPort.withAccess(destination, async (directoryPath) => {
      const canonicalDirectoryPath = await requireWritableDestinationDirectory(directoryPath);
      packagePath = join(canonicalDirectoryPath, source.packageFileName);
      receiptPath = `${packagePath}.receipt.json`;
      packageStatus = await publishPackageCopy(sourcePackagePath, packagePath, source, reserveBytes);
      const receipt: RecoveryBackupDestinationReceipt = {
        format: 'zeus-backup-destination-receipt',
        formatVersion: 1,
        backupId: source.header.backupId,
        destinationId: destination.destinationId,
        packageFileName: source.packageFileName,
        packageSha256: source.packageSha256,
        packageBytes: source.packageBytes,
        copiedAt,
        immutable: true,
      };
      try {
        await publishDestinationReceipt(receiptPath, receipt);
      } catch (error) {
        return {
          ...baseResult,
          status: packageStatus === 'copied' ? ('copied_without_receipt' as const) : ('already_present_without_receipt' as const),
          packagePath,
          receiptPath: null,
          error: `恢复包已验证，但目的地回执未能不可变发布：${errorMessage(error)}`,
        };
      }
      return {
        ...baseResult,
        status: packageStatus,
        packagePath,
        receiptPath,
        error: null,
      };
    });
  } catch (error) {
    return {
      ...baseResult,
      status: packageStatus === 'copied' ? 'copied_without_receipt' : packageStatus === 'already_present' ? 'already_present_without_receipt' : 'failed',
      packagePath,
      receiptPath: null,
      error: errorMessage(error),
    };
  }
}

async function publishPackageCopy(sourcePackagePath: string, targetPackagePath: string, source: InspectEncryptedRecoveryBackupResult, reserveBytes: number): Promise<'copied' | 'already_present'> {
  const existing = await inspectIfPresent(targetPackagePath);
  if (existing) {
    assertSameImmutablePackage(existing, source, targetPackagePath);
    return 'already_present';
  }
  const destinationDirectoryPath = resolve(targetPackagePath, '..');
  const availableBytes = await availableFilesystemBytes(destinationDirectoryPath);
  const requiredBytes = safeAdd(source.packageBytes, reserveBytes);
  if (availableBytes < requiredBytes) throw new Error(`目的地至少需要 ${requiredBytes} 字节可用空间，当前仅有 ${availableBytes} 字节。`);

  const temporaryPath = join(destinationDirectoryPath, `.${basename(targetPackagePath)}.copying-${process.pid}-${randomUUID()}.zeusbackup`);
  try {
    await copyFile(sourcePackagePath, temporaryPath, fsConstants.COPYFILE_EXCL);
    await chmod(temporaryPath, 0o400);
    await syncFile(temporaryPath);
    const copied = await inspectEncryptedRecoveryBackup(temporaryPath);
    assertSameImmutablePackage(copied, source, temporaryPath);
    try {
      await link(temporaryPath, targetPackagePath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      const raced = await inspectEncryptedRecoveryBackup(targetPackagePath);
      assertSameImmutablePackage(raced, source, targetPackagePath);
      return 'already_present';
    }
    await syncDirectory(destinationDirectoryPath);
    return 'copied';
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function publishDestinationReceipt(receiptPath: string, receipt: RecoveryBackupDestinationReceipt): Promise<void> {
  const existing = await readReceiptIfPresent(receiptPath);
  if (existing) {
    assertSameReceiptIdentity(existing, receipt);
    return;
  }
  const directoryPath = resolve(receiptPath, '..');
  const temporaryPath = join(directoryPath, `.${basename(receiptPath)}.creating-${process.pid}-${randomUUID()}`);
  const handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, receiptPath);
    await syncDirectory(directoryPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    const raced = await readReceiptIfPresent(receiptPath);
    if (!raced) throw error;
    assertSameReceiptIdentity(raced, receipt);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function inspectIfPresent(path: string): Promise<InspectEncryptedRecoveryBackupResult | null> {
  try {
    return await inspectEncryptedRecoveryBackup(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    if (error instanceof Error && 'cause' in error && isNodeError(error.cause) && error.cause.code === 'ENOENT') return null;
    throw error;
  }
}

function assertSameImmutablePackage(candidate: InspectEncryptedRecoveryBackupResult, source: InspectEncryptedRecoveryBackupResult, path: string): void {
  if (candidate.packageSha256 !== source.packageSha256 || candidate.packageBytes !== source.packageBytes || candidate.header.backupId !== source.header.backupId) {
    throw new Error(`目的地已有同名但内容不同的不可变恢复包，已拒绝覆盖：${path}`);
  }
}

async function readReceiptIfPresent(path: string): Promise<RecoveryBackupDestinationReceipt | null> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const raw = await handle.readFile('utf8');
    const value = JSON.parse(raw) as unknown;
    assertDestinationReceipt(value);
    return value;
  } finally {
    await handle.close();
  }
}

function assertDestinationReceipt(value: unknown): asserts value is RecoveryBackupDestinationReceipt {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as RecoveryBackupDestinationReceipt).format !== 'zeus-backup-destination-receipt' ||
    (value as RecoveryBackupDestinationReceipt).formatVersion !== 1 ||
    typeof (value as RecoveryBackupDestinationReceipt).backupId !== 'string' ||
    typeof (value as RecoveryBackupDestinationReceipt).destinationId !== 'string' ||
    typeof (value as RecoveryBackupDestinationReceipt).packageFileName !== 'string' ||
    !/^[0-9a-f]{64}$/u.test((value as RecoveryBackupDestinationReceipt).packageSha256) ||
    !Number.isSafeInteger((value as RecoveryBackupDestinationReceipt).packageBytes) ||
    typeof (value as RecoveryBackupDestinationReceipt).copiedAt !== 'string' ||
    (value as RecoveryBackupDestinationReceipt).immutable !== true
  ) {
    throw new Error('目的地已有无效或不兼容的恢复包回执。');
  }
}

function assertSameReceiptIdentity(existing: RecoveryBackupDestinationReceipt, candidate: RecoveryBackupDestinationReceipt): void {
  if (
    existing.backupId !== candidate.backupId ||
    existing.destinationId !== candidate.destinationId ||
    existing.packageFileName !== candidate.packageFileName ||
    existing.packageSha256 !== candidate.packageSha256 ||
    existing.packageBytes !== candidate.packageBytes
  ) {
    throw new Error('目的地已有同名但身份不同的不可变恢复包回执，已拒绝覆盖。');
  }
}

async function requireWritableDestinationDirectory(pathValue: string): Promise<string> {
  const path = resolve(pathValue);
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('备份目的地必须是用户选择的真实目录。');
  const canonical = await realpath(path);
  await access(canonical, fsConstants.R_OK | fsConstants.W_OK);
  const probePath = join(canonical, `.zeus-destination-probe-${process.pid}-${randomUUID()}`);
  const probe = await open(probePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await probe.writeFile('zeus');
    await probe.sync();
  } finally {
    await probe.close();
    await unlink(probePath).catch(() => undefined);
  }
  await syncDirectory(canonical);
  return canonical;
}

function assertDistinctDestinationSelections(destinations: readonly UserSelectedRecoveryBackupDestination[]): void {
  const [first, second] = destinations;
  if (!first || !second) throw new Error('恢复包复制必须恰好提供两个目的地。');
  if (first.destinationId === second.destinationId) throw new Error('两个备份目的地必须使用不同 destinationId。');
  if (pathsEqualOrNested(first.directoryPath, second.directoryPath)) {
    throw new Error('两个备份目的地必须是互不相同且不互相嵌套的用户选择目录。');
  }
}

function pathsEqualOrNested(first: string, second: string): boolean {
  const firstToSecond = relative(resolve(first), resolve(second));
  const secondToFirst = relative(resolve(second), resolve(first));
  return firstToSecond === '' || (!firstToSecond.startsWith(`..${sep}`) && firstToSecond !== '..') || (!secondToFirst.startsWith(`..${sep}`) && secondToFirst !== '..');
}

function validateDestinationIdentity(destination: UserSelectedRecoveryBackupDestination): void {
  if (!destination || typeof destination !== 'object') throw new Error('备份目的地结构无效。');
  for (const [field, value] of [
    ['destinationId', destination.destinationId],
    ['displayName', destination.displayName],
    ['directoryPath', destination.directoryPath],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new Error(`${field} 必须是非空且首尾无空白的字符串。`);
  }
  if (destination.securityScopedBookmark !== null && (typeof destination.securityScopedBookmark !== 'string' || destination.securityScopedBookmark.length === 0)) {
    throw new Error('securityScopedBookmark 必须是非空字符串或 null。');
  }
}

async function availableFilesystemBytes(directoryPath: string): Promise<number> {
  const stats = await statfs(directoryPath);
  const value = stats.bavail * stats.bsize;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('无法读取备份目的地可用空间。');
  return value;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
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

function validTimestamp(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || Number.isNaN(Date.parse(value))) throw new Error('copiedAt 必须是有效时间字符串。');
  return value;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} 必须是非负安全整数。`);
  return value;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('备份目的地所需空间超出安全整数范围。');
  return total;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
