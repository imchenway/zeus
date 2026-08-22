import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createEncryptedRecoveryBackup,
  createZeusDatabase,
  promoteValidatedRecoveryCandidate,
  recoverInterruptedRecoveryPromotion,
  RecoveryBackupError,
  restoreEncryptedRecoveryBackup,
  type RecoveryPromotionManagedDataHandle,
  type RecoveryPromotionManagedDataPort,
  type RecoveryPromotionOfflineLeasePort,
} from '../packages/storage/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-recovery-promotion-probe-'));
const sourceDatabasePath = join(probeRoot, 'source.db');
const successfulTargetPath = join(probeRoot, 'successful-target.db');
const failingTargetPath = join(probeRoot, 'failing-target.db');
const backupDirectoryPath = join(probeRoot, 'backups');
const isolationDirectoryPath = join(probeRoot, 'isolation');
const successfulRollbackPath = join(probeRoot, 'rollback-success');
const failingRollbackPath = join(probeRoot, 'rollback-failure');
const assetPath = join(probeRoot, 'asset.txt');
const secret = Buffer.from('zeus-recovery-probe-secret-0001', 'utf8');
const wrongSecret = Buffer.from('zeus-recovery-probe-wrong--0002', 'utf8');
const observed: Record<string, unknown> = {};

try {
  await Promise.all([backupDirectoryPath, isolationDirectoryPath, successfulRollbackPath, failingRollbackPath].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(assetPath, 'asset-must-follow-database\n', { mode: 0o600 });
  await createProbeDatabase(sourceDatabasePath, 'candidate');
  await createProbeDatabase(successfulTargetPath, 'original-success');
  await createProbeDatabase(failingTargetPath, 'original-failure');

  const backup = await createEncryptedRecoveryBackup({
    sourceDatabasePath,
    outputDirectoryPath: backupDirectoryPath,
    encryptionSecret: secret,
    assets: [{ assetId: 'probe-asset', sourcePath: assetPath, relativePath: 'probe/asset.txt', authorizationId: 'probe-authorization' }],
    providers: [
      {
        providerId: 'probe-provider',
        accountScopeId: null,
        nativeSessionId: 'probe-native-session',
        capabilityGap: { code: 'consistent_export_unavailable', message: '行为探针不伪造 Provider 一致导出。' },
      },
    ],
    freeSpaceReserveBytes: 0,
    createdAt: '2026-08-21T00:00:00.000Z',
  });
  observed.backup = {
    fileCount: backup.manifest.files.length,
    assetCount: backup.manifest.assets.length,
    providerGapCount: backup.preflight.providerCapabilityGapCount,
    packageBytes: backup.packageBytes,
  };
  observed.wrongSecret = await captureAsyncCode(() =>
    restoreEncryptedRecoveryBackup({
      packagePath: backup.packagePath,
      encryptionSecret: wrongSecret,
      isolationParentPath: isolationDirectoryPath,
      expectedPackageSha256: backup.packageSha256,
      freeSpaceReserveBytes: 0,
    }),
  );

  const candidate = await restoreEncryptedRecoveryBackup({
    packagePath: backup.packagePath,
    encryptionSecret: secret,
    isolationParentPath: isolationDirectoryPath,
    expectedPackageSha256: backup.packageSha256,
    freeSpaceReserveBytes: 0,
  });
  observed.candidate = {
    quickCheck: candidate.quickCheck,
    promotable: candidate.promotable,
    databaseFact: readProbeFact(candidate.databasePath),
    providerGapCount: candidate.providerCapabilityGaps.length,
  };

  let leaseEntries = 0;
  const offlineLeasePort: RecoveryPromotionOfflineLeasePort = {
    withExclusiveOfflineLease: async (operation) => {
      leaseEntries += 1;
      const leaseId = `probe-offline-lease-${leaseEntries}`;
      return operation({
        leaseId,
        coreState: 'stopped',
        databaseWriterCount: 0,
        acquiredAt: new Date().toISOString(),
        assertStillExclusive: async () => undefined,
      });
    },
  };
  const successfulManagedData = managedDataPort('success');
  const failingManagedData = managedDataPort('activation_failure');
  const promotionInput = {
    candidatePath: candidate.candidatePath,
    expectedBackupId: candidate.backupId,
    expectedPackageSha256: candidate.packageSha256,
    expectedManifestSha256: candidate.manifestSha256,
    expectedDatabaseSha256: candidate.manifest.database.sha256,
    expectedDatabaseBytes: candidate.manifest.database.size,
    expectedManifestFileCount: candidate.manifest.files.length,
    confirmation: `PROMOTE ${candidate.packageSha256}`,
    offlineLeasePort,
    freeSpaceReserveBytes: 0,
  } as const;

  observed.invalidConfirmation = await captureAsyncCode(() =>
    promoteValidatedRecoveryCandidate({
      ...promotionInput,
      targetDatabasePath: successfulTargetPath,
      rollbackDirectoryPath: successfulRollbackPath,
      confirmation: 'PROMOTE invalid',
      managedDataPort: successfulManagedData.port,
    }),
  );
  assertProbe(leaseEntries === 0, '错误确认不得取得离线租约或触碰正式目标');

  const promoted = await promoteValidatedRecoveryCandidate({
    ...promotionInput,
    targetDatabasePath: successfulTargetPath,
    rollbackDirectoryPath: successfulRollbackPath,
    managedDataPort: successfulManagedData.port,
  });
  observed.successfulPromotion = {
    phase: promoted.phase,
    targetFact: readProbeFact(successfulTargetPath),
    rollbackFact: readProbeFact(promoted.rollbackDatabasePath),
    managed: [...successfulManagedData.events],
  };

  const interruptedJournal = JSON.parse(await readFile(promoted.journalPath, 'utf8')) as Record<string, unknown>;
  interruptedJournal.phase = 'database_promoted';
  interruptedJournal.error = 'probe-simulated-crash-before-completion';
  await writeFile(promoted.journalPath, `${JSON.stringify(interruptedJournal, null, 2)}\n`, { mode: 0o600 });
  const interruptedRecovery = await recoverInterruptedRecoveryPromotion({
    journalPath: promoted.journalPath,
    targetDatabasePath: successfulTargetPath,
    rollbackDirectoryPath: successfulRollbackPath,
    offlineLeasePort,
    managedDataPort: successfulManagedData.port,
  });
  observed.interruptedRecovery = {
    status: interruptedRecovery.status,
    targetFact: readProbeFact(successfulTargetPath),
    managedDataRolledBack: interruptedRecovery.managedDataRolledBack,
    managed: [...successfulManagedData.events],
  };

  observed.activationFailure = await captureAsyncCode(() =>
    promoteValidatedRecoveryCandidate({
      ...promotionInput,
      targetDatabasePath: failingTargetPath,
      rollbackDirectoryPath: failingRollbackPath,
      managedDataPort: failingManagedData.port,
    }),
  );
  const [failingJournalName] = (await readdir(failingRollbackPath)).filter((name) => name.startsWith('recovery-promotion-') && name.endsWith('.json'));
  assertProbe(failingJournalName, '激活失败必须保留恢复提升日志');
  const failingJournal = JSON.parse(await readFile(join(failingRollbackPath, failingJournalName), 'utf8')) as { phase?: unknown };
  observed.activationFailureRollback = {
    targetFact: readProbeFact(failingTargetPath),
    journalPhase: failingJournal.phase,
    managed: [...failingManagedData.events],
  };

  assertProbe(observed.wrongSecret === 'ZEUS_RECOVERY_BACKUP_DECRYPTION_FAILED', '错误密钥不得产生可提升候选');
  assertProbe(candidate.quickCheck === 'ok' && candidate.promotable && readProbeFact(candidate.databasePath) === 'candidate', '隔离候选必须通过哈希与 quick_check');
  assertProbe(observed.invalidConfirmation === 'ZEUS_RECOVERY_PROMOTION_CONFIRMATION_REQUIRED', '提升必须使用包哈希精确确认');
  assertProbe(promoted.phase === 'completed' && (observed.successfulPromotion as { targetFact: string }).targetFact === 'candidate', '提升必须原子发布候选数据库');
  assertProbe((observed.successfulPromotion as { rollbackFact: string }).rollbackFact === 'original-success', '提升前必须保留原数据库回退副本');
  assertProbe(interruptedRecovery.status === 'rolled_back' && readProbeFact(successfulTargetPath) === 'original-success', '未完成日志必须固定回退到晋升前数据库');
  assertProbe(observed.activationFailure === 'Error:probe-managed-activation-failure', 'managed data 激活失败必须作为真实失败返回');
  assertProbe(readProbeFact(failingTargetPath) === 'original-failure' && failingJournal.phase === 'rolled_back', 'managed data 激活失败必须同步回退数据库并持久记录');
  assertProbe(failingManagedData.events.join(',') === 'prepare,activate,rollback', 'managed data 失败路径必须执行幂等回退');
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

async function createProbeDatabase(path: string, fact: string): Promise<void> {
  const database = await createZeusDatabase(path);
  try {
    database.execute(`CREATE TABLE recovery_probe (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), fact TEXT NOT NULL)`);
    database.execute(`INSERT INTO recovery_probe (singleton, fact) VALUES (1, ?)`, [fact]);
    await database.save();
  } finally {
    await database.close();
  }
}

function readProbeFact(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare(`SELECT fact FROM recovery_probe WHERE singleton = 1`).get() as { fact?: unknown } | undefined;
    return typeof row?.fact === 'string' ? row.fact : '';
  } finally {
    database.close();
  }
}

function managedDataPort(mode: 'success' | 'activation_failure'): { port: RecoveryPromotionManagedDataPort; events: string[] } {
  const events: string[] = [];
  const handles = new Set<string>();
  const port: RecoveryPromotionManagedDataPort = {
    prepare: async () => {
      events.push('prepare');
      const handle: RecoveryPromotionManagedDataHandle = { handleId: randomUUID(), generationId: randomUUID() };
      handles.add(handle.handleId);
      return handle;
    },
    activate: async (handle) => {
      assertProbe(handles.has(handle.handleId), 'managed data 只能激活已准备的 generation');
      events.push('activate');
      if (mode === 'activation_failure') throw new Error('probe-managed-activation-failure');
    },
    rollback: async (handle) => {
      assertProbe(handles.has(handle.handleId), 'managed data 只能回退已准备的 generation');
      events.push('rollback');
    },
  };
  return { port, events };
}

async function captureAsyncCode(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (error instanceof RecoveryBackupError) return error.code;
    if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
    return error instanceof Error ? `${error.name}:${error.message}` : String(error);
  }
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`恢复提升行为探针失败：${message}`);
}
