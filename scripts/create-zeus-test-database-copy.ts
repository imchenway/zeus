import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdtemp, open, readdir, realpath, rm, statfs, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { expectedBundleIdForDataRootProfile, publishProvisionedZeusDataRootIdentity, zeusDataRootHostIdentity, zeusDataRootIdentityPath } from '../apps/desktop/src/main/dataRootIdentity.js';
import { resolveDesktopKeychainService } from '../apps/desktop/src/main/secretServiceIdentity.js';
import { createZeusDatabase } from '../packages/storage/src/index.js';

const formatVersion = 1;
const strictValidationManifestFormatVersion = 2;
const onlineValidationManifestFormatVersion = 3;
const migratedOnlineValidationManifestFormatVersion = 4;
const reserveBytes = 64 * 1024 * 1024;
const arguments_ = parseArguments(process.argv.slice(2));
const sourcePath = await requireRegularFile(arguments_.sourcePath, 'source');
const validationRoot = await requireDestinationDirectory(arguments_.validationRootPath);
const requestedDestinationPath = resolve(arguments_.destinationPath);
const destinationDirectoryPath = await requireDestinationDirectory(dirname(requestedDestinationPath));
// 后续所有核对和发布都使用真实父目录下的规范路径，避免父目录软链接在计划与执行间改变目标。
const destinationPath = join(destinationDirectoryPath, basename(requestedDestinationPath));
const expectedDestinationPath = join(validationRoot, 'data', 'zeus.db');
if (destinationPath !== expectedDestinationPath) fail('ZEUS_TEST_DATABASE_COPY_INVALID_DESTINATION', `只读验证数据库必须位于 ${expectedDestinationPath}。`);
const validationManifestPath = `${destinationPath}.read-only-validation.json`;
const dataRootIdentityPath = zeusDataRootIdentityPath(validationRoot);
if (sourcePath === destinationPath) fail('ZEUS_TEST_DATABASE_COPY_SAME_PATH', '源数据库与 Test 目标数据库不能是同一路径。');
await requireMissingPath(destinationPath, '目标数据库');
await requireMissingPath(validationManifestPath, '只读验证 manifest');
await requireMissingPath(dataRootIdentityPath, 'Test 数据根身份');
await requireProvisionableValidationRoot(validationRoot);
const isolatedValidationLayout = arguments_.requireSourceTreeImmutable || arguments_.onlineBackupSnapshot ? await requireIsolatedValidationLayout({ sourcePath, validationRoot, validationBasePath: arguments_.validationBasePath }) : null;

const sourceStats = await lstat(sourcePath, { bigint: true });
const plannedSourceTreeSnapshot = arguments_.requireSourceTreeImmutable ? await captureSourceTreeSnapshot(sourcePath) : null;
if (plannedSourceTreeSnapshot && (plannedSourceTreeSnapshot.database.device !== sourceStats.dev.toString() || plannedSourceTreeSnapshot.database.inode !== sourceStats.ino.toString())) {
  fail('ZEUS_TEST_DATABASE_COPY_SOURCE_NOT_QUIESCENT', '正式源数据库在计划身份读取与源树摘要之间发生变化。');
}
const plan = {
  format: 'zeus-test-database-copy-plan',
  formatVersion,
  sourcePath,
  sourceDevice: sourceStats.dev.toString(),
  sourceInode: sourceStats.ino.toString(),
  destinationPath,
  destinationDirectoryPath,
  validationRoot,
  validationBase: isolatedValidationLayout?.validationBase ?? null,
  validationRunId: isolatedValidationLayout?.runId ?? null,
  validationManifestPath,
  copyMethod: 'node:sqlite-backup-api',
  backupRatePages: arguments_.backupRatePages,
  sourceMode: 'read-only',
  sourceOpenMode: arguments_.requireSourceTreeImmutable ? 'sqlite-immutable-uri' : 'sqlite-read-only',
  sourceTreeImmutability: arguments_.requireSourceTreeImmutable ? 'required_quiescent' : arguments_.onlineBackupSnapshot ? 'online_backup_snapshot' : 'not_claimed',
  sourceTreeSnapshot: plannedSourceTreeSnapshot,
  offlineCandidateMigration: arguments_.migrateOfflineCandidate,
  destinationMustNotExist: true,
  validationRootMustContainOnlyEmptyDataDirectory: true,
} as const;
const planHash = sha256Json(plan);
const expectedConfirmation = `COPY ${planHash}`;
if (arguments_.confirmation !== expectedConfirmation) {
  process.stdout.write(`${JSON.stringify({ status: 'confirmation_required', plan, planHash, expectedConfirmation }, null, 2)}\n`);
  process.exitCode = 2;
} else {
  await executeCopy();
}

async function executeCopy(): Promise<void> {
  await requireMissingPath(destinationPath, '目标数据库');
  await requireMissingPath(validationManifestPath, '只读验证 manifest');
  await requireMissingPath(dataRootIdentityPath, 'Test 数据根身份');
  await requireProvisionableValidationRoot(validationRoot);
  const currentSourceStats = await lstat(sourcePath, { bigint: true });
  if (currentSourceStats.dev !== sourceStats.dev || currentSourceStats.ino !== sourceStats.ino || !currentSourceStats.isFile() || currentSourceStats.isSymbolicLink()) {
    fail('ZEUS_TEST_DATABASE_COPY_SOURCE_IDENTITY_CHANGED', '确认后源数据库文件身份发生变化，拒绝复制。');
  }
  if (plannedSourceTreeSnapshot) {
    assertSourceTreeSnapshot(plannedSourceTreeSnapshot, await captureSourceTreeSnapshot(sourcePath), '确认后正式源数据库树发生变化');
  }

  // 严格静止源不能仅依赖 readOnly：WAL 模式数据库即使只读打开也可能创建
  // `-shm`/空 `-wal`。immutable URI 明确告诉 SQLite 不做锁与伴随文件写入；
  // 前后的整棵源目录快照仍负责证明调用期间没有外部 writer。
  const sourceDatabasePath = arguments_.requireSourceTreeImmutable ? `${pathToFileURL(sourcePath).href}?immutable=1` : sourcePath;
  const sourceDatabase = new DatabaseSync(sourceDatabasePath, { readOnly: true, timeout: 30_000 });
  let sourceDatabaseClosed = false;
  let stagingDirectoryPath: string | null = null;
  let destinationPublished = false;
  try {
    sourceDatabase.exec('PRAGMA query_only = ON');
    const sourceQuickCheck = readQuickCheck(sourceDatabase, '正式数据库只读源');
    const sourcePageCountBefore = readPositivePragma(sourceDatabase, 'page_count');
    const sourceDataVersionBefore = readPositivePragma(sourceDatabase, 'data_version');
    const sourcePageSize = readPositivePragma(sourceDatabase, 'page_size');
    const sourceLogicalBytes = safeMultiply(sourcePageCountBefore, sourcePageSize);
    const availableBytes = await availableFilesystemBytes(destinationDirectoryPath);
    const requiredBytes = safeAdd(sourceLogicalBytes, reserveBytes);
    if (availableBytes < requiredBytes) {
      fail('ZEUS_TEST_DATABASE_COPY_INSUFFICIENT_SPACE', `Test 目标卷至少需要 ${requiredBytes} 字节可用空间，当前只有 ${availableBytes} 字节。`);
    }

    stagingDirectoryPath = await mkdtemp(join(destinationDirectoryPath, '.zeus-test-database-copy-'));
    await chmod(stagingDirectoryPath, 0o700);
    const stagingPath = join(stagingDirectoryPath, `${basename(destinationPath)}.${randomUUID()}.staging`);
    let lastProgress: { totalPages: number; remainingPages: number } | null = null;
    const backupStartedAt = new Date().toISOString();
    const transferredPages = await backup(sourceDatabase, stagingPath, {
      rate: arguments_.backupRatePages,
      progress: (progress) => {
        lastProgress = progress;
        if (arguments_.emitProgress) {
          process.stderr.write(`${JSON.stringify({ event: 'sqlite_backup_progress', planHash, ...progress })}\n`);
        }
        if (process.env.ZEUS_TEST_DATABASE_COPY_PROBE_MODE === '1' && process.env.ZEUS_TEST_DATABASE_COPY_PROBE_ABORT_AFTER_PROGRESS === '1') {
          fail('ZEUS_TEST_DATABASE_COPY_PROBE_INTERRUPTED', '合成探针在 Backup API 进度回调中注入异常中断。');
        }
      },
    });
    const backupCompletedAt = new Date().toISOString();
    const backupTarget = inspectCandidateDatabase(stagingPath, 'Zeus Test 在线快照候选数据库');
    if (
      backupTarget.pageSize !== sourcePageSize ||
      transferredPages !== backupTarget.pageCount ||
      (lastProgress && (lastProgress.totalPages !== backupTarget.pageCount || lastProgress.remainingPages <= 0 || lastProgress.remainingPages > arguments_.backupRatePages))
    ) {
      fail('ZEUS_TEST_DATABASE_COPY_PAGE_BOUNDARY_MISMATCH', 'SQLite Backup API 进度与 Test 候选数据库页边界不一致。');
    }

    const sourcePageCountAfter = readPositivePragma(sourceDatabase, 'page_count');
    const sourceDataVersionAfter = readPositivePragma(sourceDatabase, 'data_version');
    const sourceSchemaSha256After = schemaSha256(sourceDatabase);
    const sourcePathStatsAfter = await lstat(sourcePath, { bigint: true });
    if (sourcePathStatsAfter.dev !== sourceStats.dev || sourcePathStatsAfter.ino !== sourceStats.ino || !sourcePathStatsAfter.isFile() || sourcePathStatsAfter.isSymbolicLink()) {
      fail('ZEUS_TEST_DATABASE_COPY_SOURCE_IDENTITY_CHANGED', 'Backup API 读取期间正式源数据库路径身份发生变化，拒绝发布副本。');
    }
    // 正式应用可能继续合法写入；Backup API 已给出一致快照，复制结束后的源端前进只作为证据记录。
    const sourceAdvancedAfterBackup = sourceDataVersionAfter !== sourceDataVersionBefore || sourcePageCountAfter !== backupTarget.pageCount || sourceSchemaSha256After !== backupTarget.schemaSha256;
    sourceDatabase.close();
    sourceDatabaseClosed = true;
    if (plannedSourceTreeSnapshot) {
      assertSourceTreeSnapshot(plannedSourceTreeSnapshot, await captureSourceTreeSnapshot(sourcePath), 'Backup API 读取期间正式源数据库树发生变化');
    }

    const migrationEvidence = arguments_.migrateOfflineCandidate ? await migrateOfflineCandidate(stagingPath, backupTarget) : undefined;
    const targetJournalMode = prepareReadOnlyValidationJournal(stagingPath);
    await requireMissingCompanionPath(`${stagingPath}-wal`, 'WAL');
    await requireMissingCompanionPath(`${stagingPath}-shm`, 'SHM');
    await requireMissingCompanionPath(`${stagingPath}-journal`, 'rollback journal');
    await chmod(stagingPath, 0o600);
    await syncFile(stagingPath);
    const target = inspectCandidateDatabase(stagingPath, 'Zeus Test 最终候选数据库');

    const sourceManifestEvidence = plannedSourceTreeSnapshot
      ? sourceEvidenceFromImmutableSnapshot(plannedSourceTreeSnapshot)
      : arguments_.onlineBackupSnapshot
        ? onlineSourceEvidence(sourcePath, sourceStats)
        : await captureNonStrictSourceEvidence(sourcePath);
    const digest = await digestFile(stagingPath);
    const stagingStats = await lstat(stagingPath, { bigint: true });
    if (stagingStats.dev.toString() === sourceManifestEvidence.device && stagingStats.ino.toString() === sourceManifestEvidence.inode) {
      fail('ZEUS_TEST_DATABASE_COPY_SOURCE_DESTINATION_OVERLAP', 'Backup API 候选与正式源数据库拥有相同 device/inode，拒绝发布硬链接冒充的副本。');
    }
    const validationManifestPayload = {
      format: 'zeus-read-only-validation-manifest',
      formatVersion: arguments_.migrateOfflineCandidate ? migratedOnlineValidationManifestFormatVersion : arguments_.onlineBackupSnapshot ? onlineValidationManifestFormatVersion : strictValidationManifestFormatVersion,
      mode: 'read_only_validation',
      runId: isolatedValidationLayout?.runId ?? randomUUID(),
      createdAt: new Date().toISOString(),
      copyPlanHash: planHash,
      validationRoot,
      source: sourceManifestEvidence,
      allowedApplication: { bundleId: 'dev.hypha.zeus.test', executableName: 'Zeus Test' },
      ...(arguments_.onlineBackupSnapshot
        ? {
            backup: {
              startedAt: backupStartedAt,
              completedAt: backupCompletedAt,
              sourcePageCountBefore,
              sourcePageCountAfter,
              sourceDataVersionBefore,
              sourceDataVersionAfter,
              targetPageCount: backupTarget.pageCount,
              pageSize: backupTarget.pageSize,
              sourceAdvancedAfterBackup,
            },
          }
        : {}),
      ...(migrationEvidence ? { migration: migrationEvidence } : {}),
      database: {
        path: destinationPath,
        device: stagingStats.dev.toString(),
        inode: stagingStats.ino.toString(),
        nlink: 1,
        sha256: digest.sha256,
        bytes: digest.bytes,
        schemaSha256: target.schemaSha256,
        journalMode: targetJournalMode,
      },
    } as const;
    const validationManifestHash = sha256Json(validationManifestPayload);
    const stagingManifestPath = join(stagingDirectoryPath, `${basename(destinationPath)}.${randomUUID()}.manifest.staging`);
    await writeNewPrivateFile(stagingManifestPath, `${JSON.stringify({ ...validationManifestPayload, manifestHash: validationManifestHash }, null, 2)}\n`);
    try {
      await link(stagingPath, destinationPath);
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) fail('ZEUS_TEST_DATABASE_COPY_DESTINATION_EXISTS', 'Test 目标数据库已经存在，拒绝覆盖。');
      throw error;
    }
    destinationPublished = true;
    try {
      await link(stagingManifestPath, validationManifestPath);
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) fail('ZEUS_TEST_DATABASE_COPY_DESTINATION_EXISTS', '只读验证 manifest 已经存在，拒绝覆盖。');
      throw error;
    }
    await syncFile(destinationPath);
    await syncFile(validationManifestPath);
    await syncDirectory(destinationDirectoryPath);
    await unlink(stagingPath);
    await unlink(stagingManifestPath);
    await rm(stagingDirectoryPath, { recursive: true, force: false });
    stagingDirectoryPath = null;
    const dataRootIdentity = publishProvisionedZeusDataRootIdentity({
      rootPath: validationRoot,
      profile: 'test',
      bundleId: expectedBundleIdForDataRootProfile('test'),
      keychainService: resolveDesktopKeychainService({ profile: 'test', dataRootPath: validationRoot }),
      allowedExistingRelativePaths: ['data', relative(validationRoot, destinationPath), relative(validationRoot, validationManifestPath)],
    });
    const publishedStats = await lstat(destinationPath, { bigint: true });
    if (publishedStats.dev.toString() !== validationManifestPayload.database.device || publishedStats.ino.toString() !== validationManifestPayload.database.inode || publishedStats.nlink !== 1n) {
      fail('ZEUS_TEST_DATABASE_COPY_DESTINATION_IDENTITY_CHANGED', 'Test 副本发布后的 device/inode/nlink 不符合唯一普通文件身份。');
    }
    if (plannedSourceTreeSnapshot) {
      assertSourceTreeSnapshot(plannedSourceTreeSnapshot, await captureSourceTreeSnapshot(sourcePath), 'Test 副本发布期间正式源数据库树发生变化');
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'completed',
          planHash,
          method: 'node:sqlite-backup-api',
          sourceOpenedReadOnly: true,
          sourceQuickCheck,
          sourcePageCountBefore,
          sourcePageCountAfter,
          sourceDataVersionBefore,
          sourceDataVersionAfter,
          targetQuickCheck: target.quickCheck,
          targetPageCount: target.pageCount,
          pageSize: target.pageSize,
          transferredPages,
          lastProgress,
          targetSchemaSha256: target.schemaSha256,
          targetJournalMode,
          readOnlyValidationCompanionFiles: false,
          sourceSchemaSha256After,
          sourceAdvancedAfterBackup,
          sourceIdentityStable: true,
          sourceTreeImmutability: arguments_.requireSourceTreeImmutable ? 'required_quiescent' : arguments_.onlineBackupSnapshot ? 'online_backup_snapshot' : 'not_claimed',
          sourceTreeSnapshotStable: plannedSourceTreeSnapshot ? true : null,
          sourceSqlWritesIssuedByCopyTool: false,
          sourceDirectoryWriteFreeVerified: Boolean(plannedSourceTreeSnapshot),
          sourceReadOnlyConnectionMayUpdateExistingWalSharedMemory: !plannedSourceTreeSnapshot,
          onlineBackupSnapshot: arguments_.onlineBackupSnapshot,
          offlineCandidateMigration: migrationEvidence ?? null,
          backupStartedAt,
          backupCompletedAt,
          destination: { path: destinationPath, sha256: digest.sha256, bytes: digest.bytes, mode: '0600' },
          validationManifest: {
            path: validationManifestPath,
            hash: validationManifestHash,
            runId: validationManifestPayload.runId,
            validationRoot,
            databaseDevice: validationManifestPayload.database.device,
            databaseInode: validationManifestPayload.database.inode,
            mode: '0600',
          },
          dataRootIdentity: {
            path: dataRootIdentityPath,
            ...zeusDataRootHostIdentity(dataRootIdentity),
            mode: '0600',
          },
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    if (destinationPublished) {
      throw new AggregateError([error], `Test 数据库已不可覆盖发布到 ${destinationPath}，但发布后的耐久核对失败；目标被保留，必须人工检查，不能自动覆盖或删除。`);
    }
    throw error;
  } finally {
    if (!sourceDatabaseClosed) sourceDatabase.close();
    if (stagingDirectoryPath) await rm(stagingDirectoryPath, { recursive: true, force: true });
  }
}

function prepareReadOnlyValidationJournal(path: string): 'delete' {
  const database = new DatabaseSync(path, { timeout: 30_000 });
  try {
    const row = database.prepare('PRAGMA journal_mode = DELETE').get() as { journal_mode?: unknown } | undefined;
    if (String(row?.journal_mode ?? '').toLowerCase() !== 'delete') {
      fail('ZEUS_TEST_DATABASE_COPY_JOURNAL_MODE_FAILED', 'Test 候选数据库无法转换为 rollback journal；只读启动可能创建 WAL/SHM，已拒绝发布。');
    }
    database.exec('PRAGMA synchronous = FULL');
    return 'delete';
  } finally {
    database.close();
  }
}

interface CandidateDatabaseSnapshot {
  quickCheck: 'ok';
  pageCount: number;
  pageSize: number;
  schemaSha256: string;
  ledgerSha256: string;
  migrationIds: readonly string[];
}

function inspectCandidateDatabase(path: string, label: string): CandidateDatabaseSnapshot {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 30_000 });
  try {
    database.exec('PRAGMA query_only = ON');
    const ledgerExists = Boolean(database.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'`).get());
    const ledgerRows = ledgerExists ? (database.prepare(`SELECT migration_id, description, checksum FROM schema_migrations ORDER BY migration_id`).all() as Array<Record<string, unknown>>) : [];
    const migrationIds = ledgerRows.map((row) => String(row.migration_id)).sort();
    return {
      quickCheck: readQuickCheck(database, label),
      pageCount: readPositivePragma(database, 'page_count'),
      pageSize: readPositivePragma(database, 'page_size'),
      schemaSha256: schemaSha256(database),
      ledgerSha256: sha256Json(ledgerRows),
      migrationIds,
    };
  } finally {
    database.close();
  }
}

async function migrateOfflineCandidate(
  path: string,
  before: CandidateDatabaseSnapshot,
): Promise<{
  strategy: 'offline_candidate_schema_migration';
  startedAt: string;
  completedAt: string;
  sourceAccessClosedBeforeMigration: true;
  runtimeWriterCount: 0;
  rollbackWindow: 'source_unchanged_candidate_only';
  preMigrationPageCount: number;
  preMigrationSchemaSha256: string;
  preMigrationLedgerSha256: string;
  postMigrationPageCount: number;
  postMigrationSchemaSha256: string;
  postMigrationLedgerSha256: string;
  appliedMigrationIds: readonly string[];
}> {
  const startedAt = new Date().toISOString();
  // 此时正式来源连接已关闭；唯一 writer 是尚未发布的 staging 候选，正式库本身即回退窗口。
  const database = await createZeusDatabase(path, {
    applyDeferredConversationHotQueryIndexes: true,
    offlineCandidateSourceAlreadySealed: true,
  });
  await database.close();
  const after = inspectCandidateDatabase(path, '离线迁移后的 Zeus Test 候选数据库');
  const previousIds = new Set(before.migrationIds);
  const appliedMigrationIds = after.migrationIds.filter((migrationId) => !previousIds.has(migrationId)).sort();
  return {
    strategy: 'offline_candidate_schema_migration',
    startedAt,
    completedAt: new Date().toISOString(),
    sourceAccessClosedBeforeMigration: true,
    runtimeWriterCount: 0,
    rollbackWindow: 'source_unchanged_candidate_only',
    preMigrationPageCount: before.pageCount,
    preMigrationSchemaSha256: before.schemaSha256,
    preMigrationLedgerSha256: before.ledgerSha256,
    postMigrationPageCount: after.pageCount,
    postMigrationSchemaSha256: after.schemaSha256,
    postMigrationLedgerSha256: after.ledgerSha256,
    appliedMigrationIds,
  };
}

interface ParsedArguments {
  sourcePath: string;
  destinationPath: string;
  validationRootPath: string;
  confirmation: string | null;
  emitProgress: boolean;
  requireSourceTreeImmutable: boolean;
  onlineBackupSnapshot: boolean;
  migrateOfflineCandidate: boolean;
  validationBasePath: string;
  backupRatePages: number;
}

function parseArguments(values: string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    sourcePath: '',
    destinationPath: '',
    validationRootPath: '',
    confirmation: null,
    emitProgress: false,
    requireSourceTreeImmutable: false,
    onlineBackupSnapshot: false,
    migrateOfflineCandidate: false,
    validationBasePath: '',
    backupRatePages: 8_192,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--source') parsed.sourcePath = requiredArgument(values[++index], '--source');
    else if (value === '--destination') parsed.destinationPath = requiredArgument(values[++index], '--destination');
    else if (value === '--validation-root') parsed.validationRootPath = requiredArgument(values[++index], '--validation-root');
    else if (value === '--confirmation') parsed.confirmation = requiredArgument(values[++index], '--confirmation');
    else if (value === '--progress') parsed.emitProgress = true;
    else if (value === '--require-source-tree-immutable') parsed.requireSourceTreeImmutable = true;
    else if (value === '--online-backup-snapshot') parsed.onlineBackupSnapshot = true;
    else if (value === '--migrate-offline-candidate') parsed.migrateOfflineCandidate = true;
    else if (value === '--validation-base') parsed.validationBasePath = requiredArgument(values[++index], '--validation-base');
    else if (value === '--backup-rate-pages') parsed.backupRatePages = requireIntegerArgument(values[++index], '--backup-rate-pages', 1, 8_192);
    else fail('ZEUS_TEST_DATABASE_COPY_INVALID_ARGUMENT', `未知参数：${String(value)}`);
  }
  if (!parsed.sourcePath || !parsed.destinationPath || !parsed.validationRootPath) {
    fail(
      'ZEUS_TEST_DATABASE_COPY_INVALID_ARGUMENT',
      '用法：--source <正式 zeus.db> --validation-root <仅含空 data/ 的全新 Test ZEUS_USER_DATA_DIR> --destination <root/data/zeus.db> [--confirmation "COPY <planHash>"] [--progress] [--backup-rate-pages <1..8192>] [(--require-source-tree-immutable|--online-backup-snapshot [--migrate-offline-candidate]) --validation-base <Test 实例基座>]',
    );
  }
  if (parsed.requireSourceTreeImmutable && parsed.onlineBackupSnapshot) {
    fail('ZEUS_TEST_DATABASE_COPY_INVALID_ARGUMENT', '静止源树与在线 WAL 快照模式不能同时启用。');
  }
  if (parsed.migrateOfflineCandidate && !parsed.onlineBackupSnapshot) {
    fail('ZEUS_TEST_DATABASE_COPY_INVALID_ARGUMENT', '--migrate-offline-candidate 只允许用于在线 WAL 快照，且迁移只发生在来源连接关闭后的未发布候选库。');
  }
  if ((parsed.requireSourceTreeImmutable || parsed.onlineBackupSnapshot) && !parsed.validationBasePath) {
    fail('ZEUS_TEST_DATABASE_COPY_INVALID_ARGUMENT', '隔离只读验证模式必须提供 --validation-base <Zeus Test 专用实例基座>。');
  }
  if (!parsed.requireSourceTreeImmutable && !parsed.onlineBackupSnapshot && parsed.validationBasePath) {
    fail('ZEUS_TEST_DATABASE_COPY_INVALID_ARGUMENT', '--validation-base 只允许与隔离只读验证模式一起使用。');
  }
  return parsed;
}

function requiredArgument(value: string | undefined, flag: string): string {
  if (!value || value.startsWith('--')) fail('ZEUS_TEST_DATABASE_COPY_INVALID_ARGUMENT', `${flag} 缺少参数。`);
  return value;
}

function requireIntegerArgument(value: string | undefined, flag: string, minimum: number, maximum: number): number {
  const text = requiredArgument(value, flag);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('ZEUS_TEST_DATABASE_COPY_INVALID_ARGUMENT', `${flag} 必须是 ${minimum}..${maximum} 的整数。`);
  }
  return parsed;
}

async function requireRegularFile(pathValue: string, field: string): Promise<string> {
  const path = resolve(pathValue);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) fail('ZEUS_TEST_DATABASE_COPY_INVALID_SOURCE', `${field} 必须是已有普通文件，不能是软链接。`);
  return realpath(path);
}

async function requireDestinationDirectory(pathValue: string): Promise<string> {
  const path = resolve(pathValue);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail('ZEUS_TEST_DATABASE_COPY_INVALID_DESTINATION', 'Test 目标父目录必须是已经存在的真实目录，不能是软链接。');
  return realpath(path);
}

async function requireIsolatedValidationLayout(input: { sourcePath: string; validationRoot: string; validationBasePath: string }): Promise<{ validationBase: string; runId: string }> {
  const validationBase = await requireDestinationDirectory(input.validationBasePath);
  const runId = basename(input.validationRoot);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)) {
    fail('ZEUS_TEST_DATABASE_COPY_INVALID_DESTINATION', '隔离只读验证 root 末级必须是 UUID runId。');
  }
  const expectedRoot = join(validationBase, 'read-only-validation', runId);
  if (input.validationRoot !== expectedRoot) {
    fail('ZEUS_TEST_DATABASE_COPY_INVALID_DESTINATION', `隔离只读验证 root 必须精确位于 ${join(validationBase, 'read-only-validation', '<runId>')}。`);
  }
  for (const path of [validationBase, dirname(input.validationRoot), input.validationRoot, join(input.validationRoot, 'data')]) {
    await requirePrivateOwnedDirectory(path);
  }
  const inferredSourceDataRoot = inferSourceDataRoot(input.sourcePath);
  if (pathsOverlap(input.validationRoot, inferredSourceDataRoot)) {
    fail('ZEUS_TEST_DATABASE_COPY_SOURCE_DESTINATION_OVERLAP', '隔离只读验证 root 与正式源数据库数据树发生祖先/后代重叠，拒绝复制。');
  }
  return { validationBase, runId };
}

async function requireProvisionableValidationRoot(root: string): Promise<void> {
  const rootEntries = await readdir(root, { withFileTypes: true });
  if (rootEntries.length !== 1 || rootEntries[0]?.name !== 'data' || !rootEntries[0].isDirectory() || rootEntries[0].isSymbolicLink()) {
    fail('ZEUS_TEST_DATABASE_COPY_VALIDATION_ROOT_NOT_PRISTINE', 'Test validationRoot 必须全新且只含一个空 data/ 目录；预置 profile、config、marker 或其他文件都拒绝认领。');
  }
  const dataEntries = await readdir(join(root, 'data'));
  if (dataEntries.length !== 0) {
    fail('ZEUS_TEST_DATABASE_COPY_VALIDATION_ROOT_NOT_PRISTINE', 'Test validationRoot 的 data/ 必须为空，不能认领已有数据库或伴随文件。');
  }
}

function inferSourceDataRoot(path: string): string {
  const sourceDirectory = dirname(path);
  return basename(sourceDirectory) === 'data' ? dirname(sourceDirectory) : sourceDirectory;
}

async function requirePrivateOwnedDirectory(path: string): Promise<void> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || Number(stats.mode & 0o777n) !== 0o700) {
    fail('ZEUS_TEST_DATABASE_COPY_INVALID_DESTINATION', `严格只读验证目录必须是 0700 普通目录且不能是软链接：${path}`);
  }
  if (typeof process.getuid === 'function' && stats.uid !== BigInt(process.getuid())) {
    fail('ZEUS_TEST_DATABASE_COPY_INVALID_DESTINATION', `严格只读验证目录不属于当前用户：${path}`);
  }
  if ((await realpath(path)) !== path) fail('ZEUS_TEST_DATABASE_COPY_INVALID_DESTINATION', `严格只读验证目录必须是规范真实路径：${path}`);
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function isPathWithin(candidate: string, root: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

async function requireMissingPath(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
    fail('ZEUS_TEST_DATABASE_COPY_DESTINATION_EXISTS', `${label}已经存在，拒绝覆盖。`);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

async function requireMissingCompanionPath(path: string, kind: 'WAL' | 'SHM' | 'rollback journal'): Promise<void> {
  try {
    await lstat(path);
    fail('ZEUS_TEST_DATABASE_COPY_JOURNAL_MODE_FAILED', `Test 候选数据库转换后仍存在 ${kind} 伴随文件，已拒绝发布。`);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

function readQuickCheck(database: DatabaseSync, label: string): 'ok' {
  const row = database.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined;
  if (String(row?.quick_check ?? '').toLowerCase() !== 'ok') fail('ZEUS_TEST_DATABASE_COPY_INTEGRITY_FAILED', `${label} quick_check 未通过。`);
  return 'ok';
}

function readPositivePragma(database: DatabaseSync, name: 'page_count' | 'page_size'): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = Number(row?.[name]);
  if (!Number.isSafeInteger(value) || value <= 0) fail('ZEUS_TEST_DATABASE_COPY_INTEGRITY_FAILED', `${name} 不是正安全整数。`);
  return value;
}

function schemaSha256(database: DatabaseSync): string {
  const rows = database.prepare(`SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name, sql`).all() as Array<Record<string, unknown>>;
  return sha256Json(rows);
}

async function digestFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes = safeAdd(bytes, bytesRead);
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

interface ImmutableFileSnapshot {
  device: string;
  inode: string;
  bytes: string;
  mode: string;
  uid: string;
  nlink: string;
  mtimeNs: string;
  ctimeNs: string;
  sha256: string;
}

interface ImmutableDirectorySnapshot {
  path: string;
  device: string;
  inode: string;
  bytes: string;
  mode: string;
  uid: string;
  mtimeNs: string;
  ctimeNs: string;
}

interface SourceTreeSnapshot {
  database: ImmutableFileSnapshot;
  directory: ImmutableDirectorySnapshot;
  companions: { wal: false; shm: false; journal: false };
}

type ValidationManifestSourceEvidence =
  | {
      path: string;
      inferredDataRoot: string;
      device: string;
      inode: string;
      sha256: string;
      bytes: number;
      treeImmutability: 'required_quiescent' | 'not_claimed';
    }
  | {
      path: string;
      inferredDataRoot: string;
      device: string;
      inode: string;
      treeImmutability: 'online_backup_snapshot';
    };

async function captureSourceTreeSnapshot(path: string): Promise<SourceTreeSnapshot> {
  const directoryPath = dirname(path);
  const directoryBefore = await immutableDirectorySnapshot(directoryPath);
  await requireSourceCompanionsMissing(path);
  const database = await immutableFileSnapshot(path);
  if (database.mode !== '0600' || database.nlink !== '1' || (typeof process.getuid === 'function' && database.uid !== String(process.getuid()))) {
    fail('ZEUS_TEST_DATABASE_COPY_INVALID_SOURCE', '严格源树零写模式要求正式源数据库是当前用户拥有、nlink=1 的 0600 普通文件。');
  }
  await requireSourceCompanionsMissing(path);
  const directoryAfter = await immutableDirectorySnapshot(directoryPath);
  if (JSON.stringify(directoryBefore) !== JSON.stringify(directoryAfter)) {
    fail('ZEUS_TEST_DATABASE_COPY_SOURCE_NOT_QUIESCENT', '正式源数据库目录在静止性核对期间发生变化，拒绝打开 SQLite 或发布副本。');
  }
  return {
    database,
    directory: directoryAfter,
    companions: { wal: false, shm: false, journal: false },
  };
}

function sourceEvidenceFromImmutableSnapshot(snapshot: SourceTreeSnapshot): ValidationManifestSourceEvidence {
  const bytes = Number(snapshot.database.bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) fail('ZEUS_TEST_DATABASE_COPY_SIZE_OVERFLOW', '正式源数据库大小超出 manifest 安全整数范围。');
  return {
    path: sourcePath,
    inferredDataRoot: inferSourceDataRoot(sourcePath),
    device: snapshot.database.device,
    inode: snapshot.database.inode,
    sha256: snapshot.database.sha256,
    bytes,
    treeImmutability: 'required_quiescent',
  };
}

async function captureNonStrictSourceEvidence(path: string): Promise<ValidationManifestSourceEvidence> {
  const before = await lstat(path, { bigint: true });
  const digest = await digestFile(path);
  const after = await lstat(path, { bigint: true });
  if (!sameImmutableIdentity(before, after) || BigInt(digest.bytes) !== after.size) {
    fail('ZEUS_TEST_DATABASE_COPY_SOURCE_IDENTITY_CHANGED', '生成普通 Backup API 来源证据期间主数据库路径发生变化，拒绝发布。');
  }
  return {
    path,
    inferredDataRoot: inferSourceDataRoot(path),
    device: after.dev.toString(),
    inode: after.ino.toString(),
    sha256: digest.sha256,
    bytes: digest.bytes,
    treeImmutability: 'not_claimed',
  };
}

function onlineSourceEvidence(path: string, identity: { dev: bigint; ino: bigint }): ValidationManifestSourceEvidence {
  return {
    path,
    inferredDataRoot: inferSourceDataRoot(path),
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    treeImmutability: 'online_backup_snapshot',
  };
}

async function immutableFileSnapshot(path: string): Promise<ImmutableFileSnapshot> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash('sha256');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) fail('ZEUS_TEST_DATABASE_COPY_INVALID_SOURCE', '正式源数据库必须是普通文件且不能是软链接。');
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let bytesReadTotal = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytesReadTotal = safeAdd(bytesReadTotal, bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    const pathStats = await lstat(path, { bigint: true });
    if (!sameImmutableIdentity(before, after) || !sameImmutableIdentity(after, pathStats) || BigInt(bytesReadTotal) !== after.size) {
      fail('ZEUS_TEST_DATABASE_COPY_SOURCE_NOT_QUIESCENT', '正式源数据库在有界摘要读取期间发生变化，拒绝打开 SQLite 或发布副本。');
    }
    return {
      device: after.dev.toString(),
      inode: after.ino.toString(),
      bytes: after.size.toString(),
      mode: (after.mode & 0o777n).toString(8).padStart(4, '0'),
      uid: after.uid.toString(),
      nlink: after.nlink.toString(),
      mtimeNs: after.mtimeNs.toString(),
      ctimeNs: after.ctimeNs.toString(),
      sha256: hash.digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

async function immutableDirectorySnapshot(path: string): Promise<ImmutableDirectorySnapshot> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail('ZEUS_TEST_DATABASE_COPY_SOURCE_NOT_QUIESCENT', '正式源数据库父目录必须是普通目录且不能是软链接。');
  return {
    path,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    bytes: stats.size.toString(),
    mode: (stats.mode & 0o777n).toString(8).padStart(4, '0'),
    uid: stats.uid.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
}

async function requireSourceCompanionsMissing(path: string): Promise<void> {
  for (const [suffix, label] of [
    ['-wal', 'WAL'],
    ['-shm', 'SHM'],
    ['-journal', 'rollback journal'],
  ] as const) {
    if (await pathExists(`${path}${suffix}`)) {
      fail('ZEUS_TEST_DATABASE_COPY_SOURCE_NOT_QUIESCENT', `正式源数据库存在 ${label} 伴随文件；严格零写验收会在打开 SQLite 前拒绝。`);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function sameImmutableIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertSourceTreeSnapshot(expected: SourceTreeSnapshot, actual: SourceTreeSnapshot, message: string): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    fail('ZEUS_TEST_DATABASE_COPY_SOURCE_NOT_QUIESCENT', `${message}，严格零写验收失败关闭。`);
  }
}

async function availableFilesystemBytes(path: string): Promise<number> {
  if (process.env.ZEUS_TEST_DATABASE_COPY_PROBE_MODE === '1') {
    const override = process.env.ZEUS_TEST_DATABASE_COPY_PROBE_AVAILABLE_BYTES;
    if (override !== undefined) {
      const bytes = Number(override);
      if (!Number.isSafeInteger(bytes) || bytes < 0) fail('ZEUS_TEST_DATABASE_COPY_SPACE_UNKNOWN', '合成探针提供的可用空间覆盖值无效。');
      return bytes;
    }
  }
  const stats = await statfs(path);
  const bytes = stats.bavail * stats.bsize;
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail('ZEUS_TEST_DATABASE_COPY_SPACE_UNKNOWN', '无法读取 Test 目标卷可用空间。');
  return bytes;
}

async function writeNewPrivateFile(path: string, content: string): Promise<void> {
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
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

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeAdd(...values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) fail('ZEUS_TEST_DATABASE_COPY_SIZE_OVERFLOW', '数据库大小计算超出安全整数范围。');
  return total;
}

function safeMultiply(left: number, right: number): number {
  const total = left * right;
  if (!Number.isSafeInteger(total) || total < 0) fail('ZEUS_TEST_DATABASE_COPY_SIZE_OVERFLOW', '数据库页大小计算超出安全整数范围。');
  return total;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, failClosed: true as const });
}
