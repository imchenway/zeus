import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { inspectEncryptedRecoveryBackup } from './recoveryBackup.js';
import type { RecoveryBackupDestinationAccessPort, RecoveryBackupDestinationReceipt, UserSelectedRecoveryBackupDestination } from './recoveryBackupReplication.js';

const recoveryPackageNamePattern = /^zeus-(\d{14})-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.zeusbackup$/iu;
const maximumReceiptBytes = 64 * 1024;
const defaultMaximumInventoryEntries = 4_096;
const retentionPlanSchemaVersion = 1;

export interface RecoveryBackupRetentionPolicy {
  keepLatest: number;
  keepDailyDays: number;
  keepWeeklyWeeks: number;
  keepMonthlyMonths: number;
  minimumCompleteDestinations: 2;
  quarantineDays: number;
  planTtlMinutes: number;
  maximumInventoryEntries: number;
}

export const defaultRecoveryBackupRetentionPolicy: RecoveryBackupRetentionPolicy = {
  keepLatest: 7,
  keepDailyDays: 30,
  keepWeeklyWeeks: 12,
  keepMonthlyMonths: 24,
  minimumCompleteDestinations: 2,
  quarantineDays: 30,
  planTtlMinutes: 60,
  maximumInventoryEntries: defaultMaximumInventoryEntries,
};

export interface RecoveryBackupInventoryCopy {
  backupId: string;
  destinationId: string;
  displayName: string;
  packageFileName: string;
  receiptFileName: string;
  packageSha256: string;
  packageBytes: number;
  createdAt: string;
  copiedAt: string;
}

export interface RecoveryBackupInventoryIssue {
  destinationId: string;
  fileName: string;
  message: string;
}

export interface RecoveryBackupInventory {
  capturedAt: string;
  copies: RecoveryBackupInventoryCopy[];
  issues: RecoveryBackupInventoryIssue[];
  inventoryFingerprint: string;
}

export interface RecoveryBackupRetentionCandidate extends RecoveryBackupInventoryCopy {
  quarantineUntil: string;
}

export interface RecoveryBackupRetentionPlan {
  format: 'zeus-recovery-retention-plan';
  formatVersion: 1;
  planId: string;
  createdAt: string;
  expiresAt: string;
  policy: RecoveryBackupRetentionPolicy;
  inventoryFingerprint: string;
  protectedBackupIds: string[];
  incompleteBackupIds: string[];
  candidates: RecoveryBackupRetentionCandidate[];
  planHash: string;
}

export interface ApplyRecoveryBackupRetentionResult {
  planId: string;
  planHash: string;
  status: 'completed' | 'partial' | 'failed' | 'nothing_to_do';
  results: Array<{
    backupId: string;
    destinationId: string;
    status: 'quarantined' | 'failed';
    quarantinePackagePath: string | null;
    quarantineReceiptPath: string | null;
    error: string | null;
  }>;
}

/**
 * 只扫描两个已授权目的地中的严格恢复包文件名与有界回执。任何缺回执、身份冲突或目录过大都会
 * 进入 issue/失败关闭，不会被自动清理。清单读取不解密正文；真正隔离前会重新计算整包 SHA-256。
 */
export async function buildRecoveryBackupRetentionPlan(input: {
  destinations: readonly UserSelectedRecoveryBackupDestination[];
  accessPort: RecoveryBackupDestinationAccessPort;
  policy?: Partial<RecoveryBackupRetentionPolicy>;
  now?: string;
}): Promise<{ inventory: RecoveryBackupInventory; plan: RecoveryBackupRetentionPlan }> {
  const destinations = assertExactlyTwoDestinations(input.destinations);
  const now = validTimestamp(input.now ?? new Date().toISOString(), 'now');
  const policy = normalizePolicy(input.policy);
  const snapshots = await Promise.all(destinations.map((destination) => inventoryDestination(destination, input.accessPort, policy.maximumInventoryEntries)));
  const copies = snapshots.flatMap((snapshot) => snapshot.copies).sort(compareInventoryCopies);
  const issues = snapshots.flatMap((snapshot) => snapshot.issues).sort(compareIssues);
  const inventoryFingerprint = sha256Json({ copies, issues });
  const inventory: RecoveryBackupInventory = { capturedAt: now, copies, issues, inventoryFingerprint };
  const groups = groupCopies(copies);
  const protectedBackupIds = selectProtectedBackupIds(groups, policy, now);
  const incompleteBackupIds: string[] = [];
  for (const group of groups) {
    const distinctDestinations = new Set(group.copies.map((copy) => copy.destinationId));
    if (distinctDestinations.size < policy.minimumCompleteDestinations) {
      incompleteBackupIds.push(group.backupId);
      protectedBackupIds.add(group.backupId);
    }
  }
  if (issues.length > 0) {
    // 目录中存在无法认证的 Zeus 备份痕迹时，整个保留计划保持只读；不能根据不完整视图推导删除。
    groups.forEach((group) => protectedBackupIds.add(group.backupId));
  }
  const quarantineUntil = addDays(now, policy.quarantineDays);
  const candidates = groups
    .filter((group) => !protectedBackupIds.has(group.backupId))
    .flatMap((group) => group.copies.map((copy) => ({ ...copy, quarantineUntil })))
    .sort(compareInventoryCopies);
  const unsigned = {
    format: 'zeus-recovery-retention-plan' as const,
    formatVersion: retentionPlanSchemaVersion as 1,
    planId: randomUUID(),
    createdAt: now,
    expiresAt: addMinutes(now, policy.planTtlMinutes),
    policy,
    inventoryFingerprint,
    protectedBackupIds: [...protectedBackupIds].sort(compareCodeUnits),
    incompleteBackupIds: incompleteBackupIds.sort(compareCodeUnits),
    candidates,
  };
  const plan: RecoveryBackupRetentionPlan = { ...unsigned, planHash: sha256Json(unsigned) };
  return { inventory, plan };
}

/**
 * 应用保留计划只做可恢复隔离，不直接永久删除。调用方必须展示候选并回传精确 planHash 确认；
 * 计划过期、文件漂移、哈希不符或 security-scoped 授权丢失均逐目的地失败关闭。
 */
export async function applyRecoveryBackupRetentionPlan(input: {
  plan: RecoveryBackupRetentionPlan;
  confirmation: string;
  destinations: readonly UserSelectedRecoveryBackupDestination[];
  accessPort: RecoveryBackupDestinationAccessPort;
  now?: string;
}): Promise<ApplyRecoveryBackupRetentionResult> {
  assertRetentionPlan(input.plan);
  const expectedConfirmation = `QUARANTINE ${input.plan.planHash}`;
  if (input.confirmation !== expectedConfirmation) throw new Error(`保留计划必须使用精确确认：${expectedConfirmation}`);
  const now = validTimestamp(input.now ?? new Date().toISOString(), 'now');
  if (Date.parse(now) > Date.parse(input.plan.expiresAt)) throw new Error('保留计划已经过期，请重新扫描并生成候选。');
  const destinations = assertExactlyTwoDestinations(input.destinations);
  const destinationById = new Map(destinations.map((destination) => [destination.destinationId, destination]));
  if (input.plan.candidates.length === 0) return { planId: input.plan.planId, planHash: input.plan.planHash, status: 'nothing_to_do', results: [] };

  const results = [] as ApplyRecoveryBackupRetentionResult['results'];
  for (const candidate of input.plan.candidates) {
    const destination = destinationById.get(candidate.destinationId);
    if (!destination) {
      results.push(failedCandidate(candidate, '当前授权中缺少计划指定的目的地，请重新授权并重新生成计划。'));
      continue;
    }
    try {
      const result = await input.accessPort.withAccess(destination, (directoryPath) => quarantineCandidate(directoryPath, input.plan, candidate));
      results.push(result);
    } catch (error) {
      results.push(failedCandidate(candidate, errorMessage(error)));
    }
  }
  const completed = results.filter((result) => result.status === 'quarantined').length;
  const status: ApplyRecoveryBackupRetentionResult['status'] = completed === results.length ? 'completed' : completed === 0 ? 'failed' : 'partial';
  return { planId: input.plan.planId, planHash: input.plan.planHash, status, results };
}

interface BackupGroup {
  backupId: string;
  createdAt: string;
  packageSha256: string;
  copies: RecoveryBackupInventoryCopy[];
}

async function inventoryDestination(
  destination: UserSelectedRecoveryBackupDestination,
  accessPort: RecoveryBackupDestinationAccessPort,
  maximumEntries: number,
): Promise<{ copies: RecoveryBackupInventoryCopy[]; issues: RecoveryBackupInventoryIssue[] }> {
  return accessPort.withAccess(destination, async (directoryPath) => {
    const canonical = await requireRealDirectory(directoryPath);
    const entries = await readdir(canonical, { withFileTypes: true });
    const packageEntries = entries.filter((entry) => entry.name.endsWith('.zeusbackup'));
    if (packageEntries.length > maximumEntries) throw new Error(`备份目录中的恢复包超过 ${maximumEntries} 个有界扫描上限。`);
    const copies: RecoveryBackupInventoryCopy[] = [];
    const issues: RecoveryBackupInventoryIssue[] = [];
    for (const entry of packageEntries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
      try {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('恢复包必须是普通文件且不能是软链接。');
        const parsedName = parseRecoveryPackageFileName(entry.name);
        const packagePath = join(canonical, entry.name);
        const receiptPath = `${packagePath}.receipt.json`;
        const [packageStats, receipt] = await Promise.all([lstat(packagePath), readBoundedReceipt(receiptPath)]);
        if (!packageStats.isFile() || packageStats.isSymbolicLink()) throw new Error('恢复包必须是普通文件且不能是软链接。');
        assertReceiptIdentity(receipt, parsedName.backupId, entry.name, packageStats.size);
        if (receipt.destinationId !== destination.destinationId) throw new Error('恢复包回执属于另一个目的地身份。');
        copies.push({
          backupId: receipt.backupId,
          destinationId: destination.destinationId,
          displayName: destination.displayName,
          packageFileName: entry.name,
          receiptFileName: basename(receiptPath),
          packageSha256: receipt.packageSha256,
          packageBytes: receipt.packageBytes,
          createdAt: parsedName.createdAt,
          copiedAt: validTimestamp(receipt.copiedAt, 'receipt.copiedAt'),
        });
      } catch (error) {
        issues.push({ destinationId: destination.destinationId, fileName: entry.name, message: errorMessage(error) });
      }
    }
    return { copies, issues };
  });
}

async function quarantineCandidate(directoryPath: string, plan: RecoveryBackupRetentionPlan, candidate: RecoveryBackupRetentionCandidate): Promise<ApplyRecoveryBackupRetentionResult['results'][number]> {
  const canonical = await requireRealDirectory(directoryPath);
  const packagePath = join(canonical, candidate.packageFileName);
  const receiptPath = join(canonical, candidate.receiptFileName);
  const receipt = await readBoundedReceipt(receiptPath);
  assertReceiptIdentity(receipt, candidate.backupId, candidate.packageFileName, candidate.packageBytes);
  if (receipt.packageSha256 !== candidate.packageSha256 || receipt.destinationId !== candidate.destinationId) throw new Error('保留候选回执身份已经漂移。');
  const inspected = await inspectEncryptedRecoveryBackup(packagePath);
  if (inspected.packageSha256 !== candidate.packageSha256 || inspected.packageBytes !== candidate.packageBytes || inspected.header.backupId !== candidate.backupId) {
    throw new Error('保留候选整包哈希、大小或 backupId 已经漂移。');
  }
  const quarantineDirectory = join(canonical, '.zeus-backup-quarantine', plan.planId);
  await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
  await chmod(quarantineDirectory, 0o700);
  const quarantinePackagePath = join(quarantineDirectory, candidate.packageFileName);
  const quarantineReceiptPath = join(quarantineDirectory, candidate.receiptFileName);
  await assertTargetAbsent(quarantinePackagePath);
  await assertTargetAbsent(quarantineReceiptPath);
  await rename(packagePath, quarantinePackagePath);
  try {
    await rename(receiptPath, quarantineReceiptPath);
  } catch (error) {
    try {
      await rename(quarantinePackagePath, packagePath);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '恢复包已进入隔离区，但回执移动与回退均失败；需要人工恢复。');
    }
    throw error;
  }
  return {
    backupId: candidate.backupId,
    destinationId: candidate.destinationId,
    status: 'quarantined',
    quarantinePackagePath,
    quarantineReceiptPath,
    error: null,
  };
}

function selectProtectedBackupIds(groups: BackupGroup[], policy: RecoveryBackupRetentionPolicy, now: string): Set<string> {
  const protectedIds = new Set<string>();
  const sorted = [...groups].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || compareCodeUnits(left.backupId, right.backupId));
  sorted.slice(0, policy.keepLatest).forEach((group) => protectedIds.add(group.backupId));
  selectFirstPerBucket(
    sorted,
    protectedIds,
    (group) => withinDays(group.createdAt, now, policy.keepDailyDays),
    (group) => group.createdAt.slice(0, 10),
  );
  selectFirstPerBucket(
    sorted,
    protectedIds,
    (group) => withinDays(group.createdAt, now, policy.keepWeeklyWeeks * 7),
    (group) => isoWeekBucket(group.createdAt),
  );
  selectFirstPerBucket(
    sorted,
    protectedIds,
    (group) => withinMonths(group.createdAt, now, policy.keepMonthlyMonths),
    (group) => group.createdAt.slice(0, 7),
  );
  return protectedIds;
}

function selectFirstPerBucket(groups: BackupGroup[], selected: Set<string>, eligible: (group: BackupGroup) => boolean, bucket: (group: BackupGroup) => string): void {
  const seen = new Set<string>();
  for (const group of groups) {
    if (!eligible(group)) continue;
    const key = bucket(group);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.add(group.backupId);
  }
}

function groupCopies(copies: RecoveryBackupInventoryCopy[]): BackupGroup[] {
  const groups = new Map<string, BackupGroup>();
  for (const copy of copies) {
    const identity = `${copy.backupId}:${copy.packageSha256}`;
    const existing = groups.get(identity);
    if (existing) {
      existing.copies.push(copy);
      if (copy.createdAt !== existing.createdAt) throw new Error(`同一恢复包 ${copy.backupId} 的创建时间不一致。`);
      continue;
    }
    groups.set(identity, { backupId: copy.backupId, createdAt: copy.createdAt, packageSha256: copy.packageSha256, copies: [copy] });
  }
  return [...groups.values()];
}

async function readBoundedReceipt(path: string): Promise<RecoveryBackupDestinationReceipt> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maximumReceiptBytes) throw new Error('恢复包回执必须是有界普通文件。');
  const raw = await readFile(path, 'utf8');
  const value = JSON.parse(raw) as unknown;
  assertReceipt(value);
  return value;
}

function assertReceipt(value: unknown): asserts value is RecoveryBackupDestinationReceipt {
  const receipt = value as RecoveryBackupDestinationReceipt;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    receipt.format !== 'zeus-backup-destination-receipt' ||
    receipt.formatVersion !== 1 ||
    typeof receipt.backupId !== 'string' ||
    typeof receipt.destinationId !== 'string' ||
    typeof receipt.packageFileName !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(receipt.packageSha256) ||
    !Number.isSafeInteger(receipt.packageBytes) ||
    receipt.packageBytes <= 0 ||
    receipt.immutable !== true
  ) {
    throw new Error('恢复包回执格式无效。');
  }
}

function assertReceiptIdentity(receipt: RecoveryBackupDestinationReceipt, backupId: string, packageFileName: string, packageBytes: number): void {
  if (receipt.backupId !== backupId || receipt.packageFileName !== packageFileName || receipt.packageBytes !== packageBytes) throw new Error('恢复包与回执身份不一致。');
}

function parseRecoveryPackageFileName(fileName: string): { backupId: string; createdAt: string } {
  const match = recoveryPackageNamePattern.exec(fileName);
  if (!match) throw new Error('恢复包文件名不符合 Zeus 不可变命名协议。');
  const compact = match[1]!;
  const createdAt = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(8, 10)}:${compact.slice(10, 12)}:${compact.slice(12, 14)}.000Z`;
  return { backupId: match[2]!, createdAt: validTimestamp(createdAt, 'package.createdAt') };
}

function normalizePolicy(input: Partial<RecoveryBackupRetentionPolicy> | undefined): RecoveryBackupRetentionPolicy {
  const policy = { ...defaultRecoveryBackupRetentionPolicy, ...(input ?? {}) };
  for (const field of ['keepLatest', 'keepDailyDays', 'keepWeeklyWeeks', 'keepMonthlyMonths', 'quarantineDays', 'planTtlMinutes', 'maximumInventoryEntries'] as const) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] < 0) throw new Error(`${field} 必须是非负安全整数。`);
  }
  if (policy.keepLatest < 1) throw new Error('keepLatest 至少为 1，禁止自动清空全部恢复点。');
  if (policy.quarantineDays < 7) throw new Error('quarantineDays 至少为 7 天。');
  if (policy.planTtlMinutes < 1 || policy.planTtlMinutes > 24 * 60) throw new Error('planTtlMinutes 必须介于 1 与 1440。');
  if (policy.maximumInventoryEntries < 1 || policy.maximumInventoryEntries > 100_000) throw new Error('maximumInventoryEntries 必须介于 1 与 100000。');
  if (policy.minimumCompleteDestinations !== 2) throw new Error('当前双目的地保留策略要求 minimumCompleteDestinations 固定为 2。');
  return policy;
}

function assertRetentionPlan(plan: RecoveryBackupRetentionPlan): void {
  if (!plan || plan.format !== 'zeus-recovery-retention-plan' || plan.formatVersion !== 1) throw new Error('恢复包保留计划格式无效。');
  const { planHash, ...unsigned } = plan;
  if (!/^[0-9a-f]{64}$/u.test(planHash) || sha256Json(unsigned) !== planHash) throw new Error('恢复包保留计划哈希无效。');
  normalizePolicy(plan.policy);
  validTimestamp(plan.createdAt, 'plan.createdAt');
  validTimestamp(plan.expiresAt, 'plan.expiresAt');
}

function assertExactlyTwoDestinations(value: readonly UserSelectedRecoveryBackupDestination[]): [UserSelectedRecoveryBackupDestination, UserSelectedRecoveryBackupDestination] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('恢复包保留策略必须同时核对两个授权目的地。');
  if (!value[0] || !value[1] || value[0].destinationId === value[1].destinationId) throw new Error('恢复包保留策略需要两个不同的目的地身份。');
  return [value[0], value[1]];
}

async function requireRealDirectory(pathValue: string): Promise<string> {
  const path = resolve(pathValue);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('备份目的地必须是用户授权的真实目录。');
  return realpath(path);
}

async function assertTargetAbsent(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(`隔离区已有同名文件，拒绝覆盖：${basename(path)}`);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

function failedCandidate(candidate: RecoveryBackupRetentionCandidate, error: string): ApplyRecoveryBackupRetentionResult['results'][number] {
  return { backupId: candidate.backupId, destinationId: candidate.destinationId, status: 'failed', quarantinePackagePath: null, quarantineReceiptPath: null, error };
}

function compareInventoryCopies(left: RecoveryBackupInventoryCopy, right: RecoveryBackupInventoryCopy): number {
  return left.createdAt.localeCompare(right.createdAt) || compareCodeUnits(left.backupId, right.backupId) || compareCodeUnits(left.destinationId, right.destinationId);
}

function compareIssues(left: RecoveryBackupInventoryIssue, right: RecoveryBackupInventoryIssue): number {
  return compareCodeUnits(left.destinationId, right.destinationId) || compareCodeUnits(left.fileName, right.fileName);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validTimestamp(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || Number.isNaN(Date.parse(value))) throw new Error(`${field} 必须是有效时间字符串。`);
  return value;
}

function addDays(value: string, days: number): string {
  return new Date(Date.parse(value) + days * 86_400_000).toISOString();
}

function addMinutes(value: string, minutes: number): string {
  return new Date(Date.parse(value) + minutes * 60_000).toISOString();
}

function withinDays(value: string, now: string, days: number): boolean {
  return days > 0 && Date.parse(value) >= Date.parse(now) - days * 86_400_000;
}

function withinMonths(value: string, now: string, months: number): boolean {
  if (months <= 0) return false;
  const boundary = new Date(now);
  boundary.setUTCMonth(boundary.getUTCMonth() - months);
  return Date.parse(value) >= boundary.getTime();
}

function isoWeekBucket(value: string): string {
  const date = new Date(value);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
