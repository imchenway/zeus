import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor } from '../packages/local-server/src/readOnlyValidation.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-test-database-copy-probe-'));
const sourcePath = join(probeRoot, 'active-wal-source', 'data', 'zeus.db');
const validationRoot = join(probeRoot, 'isolated-test-data');
const destinationDirectoryPath = join(validationRoot, 'data');
const destinationPath = join(destinationDirectoryPath, 'zeus.db');
const validationManifestPath = `${destinationPath}.read-only-validation.json`;
const activeWalStrictBase = join(probeRoot, 'active-wal-test-instance');
const activeWalStrictRoot = join(activeWalStrictBase, 'read-only-validation', '66666666-6666-4666-8666-666666666666');
const activeWalStrictDestinationPath = join(activeWalStrictRoot, 'data', 'zeus.db');
const preloadedStrictBase = join(probeRoot, 'preloaded-strict-test-instance');
const preloadedStrictRoot = join(preloadedStrictBase, 'read-only-validation', '55555555-5555-4555-8555-555555555555');
const preloadedStrictDestinationPath = join(preloadedStrictRoot, 'data', 'zeus.db');
const observed: Record<string, unknown> = {};

try {
  await mkdir(destinationDirectoryPath, { mode: 0o700, recursive: true });
  await mkdir(join(probeRoot, 'active-wal-source', 'data'), { mode: 0o700, recursive: true });
  await mkdir(join(activeWalStrictRoot, 'data'), { mode: 0o700, recursive: true });
  await mkdir(join(preloadedStrictRoot, 'data'), { mode: 0o700, recursive: true });
  await mkdir(join(preloadedStrictRoot, 'profile'), { mode: 0o700 });
  await writeFile(join(preloadedStrictRoot, 'zeus.config.json'), '{"must":"survive"}\n', { mode: 0o600 });
  const canonicalValidationRoot = await realpath(validationRoot);
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec(`PRAGMA journal_mode = WAL`);
    source.exec(`PRAGMA synchronous = FULL`);
    source.exec(`CREATE TABLE copy_probe (id INTEGER PRIMARY KEY, fact TEXT NOT NULL)`);
    source.prepare(`INSERT INTO copy_probe (id, fact) VALUES (?, ?)`).run(1, 'formal-source-must-survive');
    const sourceBefore = await fileDigest(sourcePath);

    const copyArguments = ['--source', sourcePath, '--validation-root', canonicalValidationRoot, '--destination', destinationPath];
    const planRun = runCopyTool(copyArguments);
    observed.planExitCode = planRun.status;
    const plan = parseJsonOutput(planRun.stdout) as { status?: unknown; expectedConfirmation?: unknown; planHash?: unknown };
    observed.planStatus = plan.status;
    observed.destinationAbsentAfterPlan = !(await pathExists(destinationPath));
    assertProbe(planRun.status === 2 && plan.status === 'confirmation_required' && typeof plan.expectedConfirmation === 'string', '首次调用必须只返回绑定目标的确认计划');
    assertProbe(observed.destinationAbsentAfterPlan === true, '确认计划不得创建目标数据库');

    const preloadedStrictRun = runCopyTool([
      '--source',
      sourcePath,
      '--validation-root',
      await realpath(preloadedStrictRoot),
      '--validation-base',
      await realpath(preloadedStrictBase),
      '--destination',
      preloadedStrictDestinationPath,
      '--require-source-tree-immutable',
    ]);
    observed.preloadedStrictRootRejectedBeforePublish =
      preloadedStrictRun.status !== 0 &&
      `${preloadedStrictRun.stdout}\n${preloadedStrictRun.stderr}`.includes('ZEUS_TEST_DATABASE_COPY_VALIDATION_ROOT_NOT_PRISTINE') &&
      !(await pathExists(preloadedStrictDestinationPath)) &&
      !(await pathExists(join(preloadedStrictRoot, '.zeus-root-identity.json'))) &&
      (await readFile(join(preloadedStrictRoot, 'zeus.config.json'), 'utf8')) === '{"must":"survive"}\n';

    const strictActiveWalRun = runCopyTool([
      '--source',
      sourcePath,
      '--validation-root',
      await realpath(activeWalStrictRoot),
      '--validation-base',
      await realpath(activeWalStrictBase),
      '--destination',
      activeWalStrictDestinationPath,
      '--require-source-tree-immutable',
    ]);
    observed.strictActiveWalExitCode = strictActiveWalRun.status;
    observed.strictActiveWalRejectedBeforePublish =
      strictActiveWalRun.status !== 0 && `${strictActiveWalRun.stdout}\n${strictActiveWalRun.stderr}`.includes('ZEUS_TEST_DATABASE_COPY_SOURCE_NOT_QUIESCENT') && !(await pathExists(activeWalStrictDestinationPath));

    source.prepare(`INSERT INTO copy_probe (id, fact) VALUES (?, ?)`).run(2, 'committed-after-plan-same-inode');
    const copyRun = runCopyTool([...copyArguments, '--confirmation', String(plan.expectedConfirmation)]);
    observed.copyExitCode = copyRun.status;
    if (copyRun.status !== 0) {
      throw new Error(`Test 数据库复制执行失败（exit=${String(copyRun.status)}）：${String(copyRun.stderr).slice(0, 2_000)}`);
    }
    const result = parseJsonOutput(copyRun.stdout) as Record<string, unknown>;
    observed.copyResult = result;
    const publishedRootIdentity = result.dataRootIdentity as Record<string, unknown> | undefined;
    const publishedRootIdentityStats = publishedRootIdentity?.path ? await lstat(String(publishedRootIdentity.path)) : null;
    observed.publishedRootIdentity = {
      profile: publishedRootIdentity?.profile ?? null,
      bundleId: publishedRootIdentity?.bundleId ?? null,
      rootId: publishedRootIdentity?.rootId ?? null,
      mode: publishedRootIdentityStats ? (publishedRootIdentityStats.mode & 0o777).toString(8).padStart(4, '0') : null,
      nlink: publishedRootIdentityStats?.nlink ?? null,
    };
    const sourceAfter = await fileDigest(sourcePath);
    observed.sourceMainFileUnchangedByCopy = sourceBefore.sha256 === sourceAfter.sha256 && sourceBefore.bytes === sourceAfter.bytes;
    // WAL 中第二条记录由行为探针自己写入；Backup API 必须读取它，但不得要求关闭源连接。
    const target = new DatabaseSync(destinationPath, { readOnly: true });
    try {
      observed.targetFacts = target
        .prepare(`SELECT fact FROM copy_probe ORDER BY id`)
        .all()
        .map((row) => (row as { fact: string }).fact);
      observed.targetQuickCheck = (target.prepare(`PRAGMA quick_check`).get() as { quick_check?: unknown } | undefined)?.quick_check ?? null;
    } finally {
      target.close();
    }
    observed.targetCompanionFilesAfterReadOnlyOpen = {
      wal: await pathExists(`${destinationPath}-wal`),
      shm: await pathExists(`${destinationPath}-shm`),
      journal: await pathExists(`${destinationPath}-journal`),
    };
    const destinationMode = (await lstat(destinationPath)).mode & 0o777;
    observed.destinationMode = destinationMode.toString(8).padStart(4, '0');
    const validationManifest = JSON.parse(await readFile(validationManifestPath, 'utf8')) as Record<string, unknown>;
    const manifestHash = validationManifest.manifestHash;
    delete validationManifest.manifestHash;
    const targetStats = await lstat(destinationPath, { bigint: true });
    observed.validationManifest = {
      format: validationManifest.format,
      formatVersion: validationManifest.formatVersion,
      mode: validationManifest.mode,
      root: validationManifest.validationRoot,
      source: validationManifest.source,
      database: validationManifest.database,
      hashMatches: typeof manifestHash === 'string' && manifestHash === sha256Json(validationManifest),
      inodeMatches: (validationManifest.database as { inode?: unknown } | undefined)?.inode === targetStats.ino.toString(),
      deviceMatches: (validationManifest.database as { device?: unknown } | undefined)?.device === targetStats.dev.toString(),
      nlinkMatches: (validationManifest.database as { nlink?: unknown } | undefined)?.nlink === Number(targetStats.nlink),
      fileMode: ((await lstat(validationManifestPath)).mode & 0o777).toString(8).padStart(4, '0'),
    };

    const overwriteRun = runCopyTool([...copyArguments, '--confirmation', String(plan.expectedConfirmation)]);
    observed.overwriteExitCode = overwriteRun.status;
    observed.overwriteRejected = overwriteRun.status !== 0 && `${overwriteRun.stdout}\n${overwriteRun.stderr}`.includes('ZEUS_TEST_DATABASE_COPY_DESTINATION_EXISTS');

    assertProbe(copyRun.status === 0 && result.status === 'completed' && result.method === 'node:sqlite-backup-api', '确认后必须由 SQLite Backup API 生成 Test 副本');
    assertProbe(
      result.sourceSqlWritesIssuedByCopyTool === false && result.sourceDirectoryWriteFreeVerified === false && result.sourceReadOnlyConnectionMayUpdateExistingWalSharedMemory === true && result.sourceTreeImmutability === 'not_claimed',
      '活跃 WAL 模式只能证明没有发出 SQL 写入，必须明确不承诺源目录零写且提示 SHM reader metadata 风险。',
    );
    assertProbe(
      result.targetJournalMode === 'delete' &&
        result.readOnlyValidationCompanionFiles === false &&
        result.sourceIdentityStable === true &&
        JSON.stringify(observed.targetCompanionFilesAfterReadOnlyOpen) === JSON.stringify({ wal: false, shm: false, journal: false }),
      'Test 副本必须保持源 inode 身份稳定并转换为 rollback journal，确保后续只读打开不创建 WAL/SHM/journal。',
    );
    assertProbe(JSON.stringify(observed.targetFacts) === JSON.stringify(['formal-source-must-survive', 'committed-after-plan-same-inode']), 'Test 副本必须包含 WAL 中已提交事实');
    assertProbe(observed.targetQuickCheck === 'ok' && observed.destinationMode === '0600', 'Test 副本必须通过 quick_check 且权限为 0600');
    assertProbe(
      (observed.publishedRootIdentity as { profile?: unknown; bundleId?: unknown; rootId?: unknown; mode?: unknown; nlink?: unknown }).profile === 'test' &&
        (observed.publishedRootIdentity as { bundleId?: unknown }).bundleId === 'dev.hypha.zeus.test' &&
        typeof (observed.publishedRootIdentity as { rootId?: unknown }).rootId === 'string' &&
        (observed.publishedRootIdentity as { mode?: unknown }).mode === '0600' &&
        (observed.publishedRootIdentity as { nlink?: unknown }).nlink === 1,
      'Backup API 发布的 validationRoot 必须同时获得唯一、0600 的 Test 数据根身份。',
    );
    assertProbe(
      (observed.validationManifest as { format?: unknown; mode?: unknown; root?: unknown; hashMatches?: unknown; inodeMatches?: unknown; deviceMatches?: unknown; fileMode?: unknown }).format === 'zeus-read-only-validation-manifest' &&
        (observed.validationManifest as { formatVersion?: unknown }).formatVersion === 2 &&
        (observed.validationManifest as { mode?: unknown }).mode === 'read_only_validation' &&
        (observed.validationManifest as { root?: unknown }).root === canonicalValidationRoot &&
        (observed.validationManifest as { hashMatches?: unknown }).hashMatches === true &&
        (observed.validationManifest as { inodeMatches?: unknown }).inodeMatches === true &&
        (observed.validationManifest as { deviceMatches?: unknown }).deviceMatches === true &&
        (observed.validationManifest as { nlinkMatches?: unknown }).nlinkMatches === true &&
        (observed.validationManifest as { source?: { treeImmutability?: unknown } }).source?.treeImmutability === 'not_claimed' &&
        (observed.validationManifest as { fileMode?: unknown }).fileMode === '0600',
      '复制工具必须生成绑定 Test root、数据库 device/inode/hash 的 0600 只读验证 manifest。',
    );
    assertProbe(observed.overwriteRejected === true, '已有 Test 目标必须失败关闭，绝不覆盖');
    assertProbe(observed.preloadedStrictRootRejectedBeforePublish === true, '预置 profile/config 的 strict validationRoot 必须在 SQLite 打开、目标发布和 Test 根身份认领前失败关闭。');
    assertProbe(observed.strictActiveWalRejectedBeforePublish === true, '严格源树零写模式必须在打开 SQLite 或发布目标前拒绝活跃 WAL/SHM 源');
  } finally {
    source.close();
  }

  observed.strictQuiescent = await verifyStrictQuiescentCopy(probeRoot);
  observed.onlineBackupSnapshot = await verifyOnlineBackupSnapshot(probeRoot);
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

function runCopyTool(arguments_: string[], environment: NodeJS.ProcessEnv = process.env): ReturnType<typeof spawnSync> {
  return spawnSync('pnpm', ['exec', 'tsx', 'scripts/create-zeus-test-database-copy.ts', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function runCopyToolAsync(arguments_: string[], environment: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'scripts/create-zeus-test-database-copy.ts', ...arguments_], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function verifyOnlineBackupSnapshot(root: string): Promise<Record<string, unknown>> {
  const sourceDirectory = join(root, 'online-source', 'data');
  const sourceDatabasePath = join(sourceDirectory, 'zeus.db');
  const validationBase = join(root, 'online-test-instance');
  const runId = '88888888-8888-4888-8888-888888888888';
  const rootPath = join(validationBase, 'read-only-validation', runId);
  const destinationPath = join(rootPath, 'data', 'zeus.db');
  const manifestPath = `${destinationPath}.read-only-validation.json`;
  await mkdir(sourceDirectory, { mode: 0o700, recursive: true });
  await mkdir(join(rootPath, 'data'), { mode: 0o700, recursive: true });
  const source = new DatabaseSync(sourceDatabasePath);
  try {
    source.exec('PRAGMA journal_mode = WAL');
    source.exec('PRAGMA wal_autocheckpoint = 0');
    source.exec('PRAGMA busy_timeout = 30000');
    source.exec('CREATE TABLE online_probe (id INTEGER PRIMARY KEY, fact TEXT NOT NULL)');
    source.exec('CREATE TABLE online_payload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
    source.prepare('INSERT INTO online_probe (fact) VALUES (?)').run('captured-by-online-backup');
    source.prepare('INSERT INTO online_payload (payload) VALUES (zeroblob(?))').run(48 * 1024 * 1024);
    await chmod(sourceDatabasePath, 0o600);
    const arguments_ = [
      '--source',
      sourceDatabasePath,
      '--validation-root',
      await realpath(rootPath),
      '--validation-base',
      await realpath(validationBase),
      '--destination',
      destinationPath,
      '--online-backup-snapshot',
      '--migrate-offline-candidate',
      '--backup-rate-pages',
      '64',
      '--progress',
    ];
    const planRun = runCopyTool(arguments_);
    const plan = parseJsonOutput(planRun.stdout) as { expectedConfirmation?: unknown };
    assertProbe(planRun.status === 2 && typeof plan.expectedConfirmation === 'string', '在线 WAL 快照必须先返回两阶段确认计划。');
    let copyFinished = false;
    const copyPromise = runCopyToolAsync([...arguments_, '--confirmation', String(plan.expectedConfirmation)]).then((result) => {
      copyFinished = true;
      return result;
    });
    let sourceWritesDuringBackup = 0;
    while (!copyFinished && sourceWritesDuringBackup < 2_000) {
      try {
        source.prepare('INSERT INTO online_probe (fact) VALUES (?)').run(`committed-during-backup-${sourceWritesDuringBackup + 1}`);
        sourceWritesDuringBackup += 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('locked')) throw error;
      }
      await delay(2);
    }
    const copyRun = await copyPromise;
    assertProbe(copyRun.status === 0, `在线 WAL 快照复制失败：${copyRun.stderr.slice(-2_000)}`);
    const result = parseJsonOutput(copyRun.stdout) as Record<string, unknown>;
    const publishedManifestPath = String((result.validationManifest as { path?: unknown } | undefined)?.path ?? manifestPath);
    source.prepare('INSERT INTO online_probe (fact) VALUES (?)').run('source-advanced-after-copy');
    const descriptor = inspectReadOnlyValidationManifest(publishedManifestPath);
    await verifyReadOnlyValidationDescriptor(descriptor);
    const target = new DatabaseSync(destinationPath, { readOnly: true });
    let facts: string[];
    try {
      facts = target
        .prepare('SELECT fact FROM online_probe ORDER BY id')
        .all()
        .map((row) => String((row as { fact?: unknown }).fact ?? ''));
    } finally {
      target.close();
    }
    assertProbe(
      descriptor.formatVersion === 4 &&
        descriptor.source.treeImmutability === 'online_backup_snapshot' &&
        Boolean(descriptor.backup) &&
        descriptor.migration?.strategy === 'offline_candidate_schema_migration' &&
        descriptor.migration.sourceAccessClosedBeforeMigration === true &&
        descriptor.migration.runtimeWriterCount === 0 &&
        descriptor.migration.postMigrationSchemaSha256 === descriptor.database.schemaSha256,
      '在线快照离线迁移必须生成 formatVersion=4，并分别封存 Backup API 与候选 schema 迁移证据。',
    );
    assertProbe(result.sourceTreeImmutability === 'online_backup_snapshot' && result.sourceDirectoryWriteFreeVerified === false, '在线快照不得声称正式来源目录零写。');
    assertProbe(sourceWritesDuringBackup > 0 && descriptor.backup?.sourceAdvancedAfterBackup === true, '在线备份期间必须允许正式 WAL writer 持续提交，并由 data_version 证据记录来源前进。');
    assertProbe(facts[0] === 'captured-by-online-backup' && !facts.includes('source-advanced-after-copy') && facts.length <= sourceWritesDuringBackup + 1, '在线快照必须冻结 Backup API 时间点，复制完成后的正式来源前进不得污染副本。');

    const overwriteRun = runCopyTool([...arguments_, '--confirmation', String(plan.expectedConfirmation)]);
    assertProbe(overwriteRun.status !== 0 && `${overwriteRun.stdout}\n${overwriteRun.stderr}`.includes('ZEUS_TEST_DATABASE_COPY_DESTINATION_EXISTS'), '在线模式已有目标也必须失败关闭。');
    const insufficientSpace = await verifyOnlineFailure(
      root,
      sourceDatabasePath,
      '99999999-9999-4999-8999-999999999999',
      {
        ZEUS_TEST_DATABASE_COPY_PROBE_MODE: '1',
        ZEUS_TEST_DATABASE_COPY_PROBE_AVAILABLE_BYTES: '0',
      },
      'ZEUS_TEST_DATABASE_COPY_INSUFFICIENT_SPACE',
    );
    const interrupted = await verifyOnlineFailure(
      root,
      sourceDatabasePath,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      {
        ZEUS_TEST_DATABASE_COPY_PROBE_MODE: '1',
        ZEUS_TEST_DATABASE_COPY_PROBE_ABORT_AFTER_PROGRESS: '1',
      },
      'ZEUS_TEST_DATABASE_COPY_PROBE_INTERRUPTED',
    );
    const replacement = await verifyOnlineSourceReplacement(root);
    return {
      planExitCode: planRun.status,
      copyExitCode: copyRun.status,
      formatVersion: descriptor.formatVersion,
      sourceConsistency: descriptor.source.treeImmutability,
      backup: descriptor.backup,
      migration: descriptor.migration,
      targetFactCount: facts.length,
      sourceWritesDuringBackup,
      sourceAdvancedAfterValidation: true,
      descriptorVerifiedWithoutSourceDigestEquality: true,
      overwriteRejected: true,
      insufficientSpace,
      interrupted,
      replacement,
    };
  } finally {
    source.close();
  }
}

async function verifyOnlineFailure(root: string, sourcePath: string, runId: string, overrides: NodeJS.ProcessEnv, expectedCode: string): Promise<Record<string, unknown>> {
  const validationBase = join(root, `online-failure-${runId}`);
  const validationRoot = join(validationBase, 'read-only-validation', runId);
  const destinationPath = join(validationRoot, 'data', 'zeus.db');
  await mkdir(join(validationRoot, 'data'), { mode: 0o700, recursive: true });
  const arguments_ = [
    '--source',
    sourcePath,
    '--validation-root',
    await realpath(validationRoot),
    '--validation-base',
    await realpath(validationBase),
    '--destination',
    destinationPath,
    '--online-backup-snapshot',
    '--backup-rate-pages',
    '64',
  ];
  const planRun = runCopyTool(arguments_);
  const plan = parseJsonOutput(planRun.stdout) as { expectedConfirmation?: unknown };
  assertProbe(planRun.status === 2 && typeof plan.expectedConfirmation === 'string', `${expectedCode} 探针必须先形成确认计划。`);
  const run = runCopyTool([...arguments_, '--confirmation', String(plan.expectedConfirmation)], { ...process.env, ...overrides });
  const output = `${run.stdout}\n${run.stderr}`;
  assertProbe(run.status !== 0 && output.includes(expectedCode) && !(await pathExists(destinationPath)), `${expectedCode} 必须在发布目标前失败关闭。`);
  return { exitCode: run.status, expectedCode, destinationAbsent: true };
}

async function verifyOnlineSourceReplacement(root: string): Promise<Record<string, unknown>> {
  const sourceDirectory = join(root, 'online-replacement-source', 'data');
  const sourcePath = join(sourceDirectory, 'zeus.db');
  const validationBase = join(root, 'online-replacement-test');
  const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const validationRoot = join(validationBase, 'read-only-validation', runId);
  const destinationPath = join(validationRoot, 'data', 'zeus.db');
  await mkdir(sourceDirectory, { mode: 0o700, recursive: true });
  await mkdir(join(validationRoot, 'data'), { mode: 0o700, recursive: true });
  const original = new DatabaseSync(sourcePath);
  original.exec('CREATE TABLE identity_probe (id INTEGER PRIMARY KEY)');
  original.close();
  await chmod(sourcePath, 0o600);
  const arguments_ = ['--source', sourcePath, '--validation-root', await realpath(validationRoot), '--validation-base', await realpath(validationBase), '--destination', destinationPath, '--online-backup-snapshot'];
  const planRun = runCopyTool(arguments_);
  const plan = parseJsonOutput(planRun.stdout) as { expectedConfirmation?: unknown };
  assertProbe(planRun.status === 2 && typeof plan.expectedConfirmation === 'string', '来源替换探针必须先形成确认计划。');
  await rename(sourcePath, `${sourcePath}.planned`);
  const replacement = new DatabaseSync(sourcePath);
  replacement.exec('CREATE TABLE replacement_probe (id INTEGER PRIMARY KEY)');
  replacement.close();
  await chmod(sourcePath, 0o600);
  const run = runCopyTool([...arguments_, '--confirmation', String(plan.expectedConfirmation)]);
  const replacedPlan = parseJsonOutput(run.stdout) as { status?: unknown; expectedConfirmation?: unknown };
  assertProbe(
    run.status === 2 && replacedPlan.status === 'confirmation_required' && replacedPlan.expectedConfirmation !== plan.expectedConfirmation && !(await pathExists(destinationPath)),
    '计划确认后来源路径被替换必须使原确认失效，并在 SQLite open 前失败关闭。',
  );
  return { exitCode: run.status, staleConfirmationRejected: true, destinationAbsent: true };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function verifyStrictQuiescentCopy(root: string): Promise<Record<string, unknown>> {
  const sourceDirectoryPath = join(root, 'strict-source');
  const strictSourcePath = join(sourceDirectoryPath, 'source.db');
  const strictValidationBase = join(root, 'strict-test-instance');
  const strictRunId = '77777777-7777-4777-8777-777777777777';
  const strictValidationRoot = join(strictValidationBase, 'read-only-validation', strictRunId);
  const strictDestinationDirectoryPath = join(strictValidationRoot, 'data');
  const strictDestinationPath = join(strictDestinationDirectoryPath, 'zeus.db');
  await mkdir(sourceDirectoryPath, { mode: 0o700 });
  await mkdir(strictDestinationDirectoryPath, { mode: 0o700, recursive: true });
  const database = new DatabaseSync(strictSourcePath);
  try {
    database.exec(`PRAGMA journal_mode = DELETE`);
    database.exec(`CREATE TABLE strict_probe (id INTEGER PRIMARY KEY, fact TEXT NOT NULL)`);
    database.prepare(`INSERT INTO strict_probe (fact) VALUES (?)`).run('quiescent-source');
  } finally {
    database.close();
  }
  await chmod(strictSourcePath, 0o600);
  const sourceBefore = await sourceTreeEvidence(strictSourcePath);
  const copyArguments = [
    '--source',
    strictSourcePath,
    '--validation-root',
    await realpath(strictValidationRoot),
    '--validation-base',
    await realpath(strictValidationBase),
    '--destination',
    strictDestinationPath,
    '--require-source-tree-immutable',
  ];
  const planRun = runCopyTool(copyArguments);
  const plan = parseJsonOutput(planRun.stdout) as { status?: unknown; expectedConfirmation?: unknown; plan?: { sourceTreeImmutability?: unknown; sourceTreeSnapshot?: unknown } };
  assertProbe(
    planRun.status === 2 && plan.status === 'confirmation_required' && typeof plan.expectedConfirmation === 'string' && plan.plan?.sourceTreeImmutability === 'required_quiescent' && plan.plan.sourceTreeSnapshot !== null,
    '严格静止源必须生成绑定源树摘要的二阶段确认计划。',
  );
  const copyRun = runCopyTool([...copyArguments, '--confirmation', plan.expectedConfirmation]);
  if (copyRun.status !== 0) throw new Error(`严格静止源复制失败（exit=${String(copyRun.status)}）：${String(copyRun.stderr).slice(0, 2_000)}`);
  const result = parseJsonOutput(copyRun.stdout) as Record<string, unknown>;
  const manifest = JSON.parse(await readFile(`${strictDestinationPath}.read-only-validation.json`, 'utf8')) as {
    formatVersion?: unknown;
    runId?: unknown;
    source?: { treeImmutability?: unknown; path?: unknown };
    database?: { nlink?: unknown };
  };
  const sourceAfter = await sourceTreeEvidence(strictSourcePath);
  const target = new DatabaseSync(strictDestinationPath, { readOnly: true });
  let targetFact: unknown;
  try {
    targetFact = (target.prepare(`SELECT fact FROM strict_probe`).get() as { fact?: unknown } | undefined)?.fact ?? null;
  } finally {
    target.close();
  }
  assertProbe(JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), '严格静止模式必须证明源数据库、父目录和伴随文件前后完全不变。');
  assertProbe(
    result.status === 'completed' &&
      result.sourceTreeImmutability === 'required_quiescent' &&
      result.sourceTreeSnapshotStable === true &&
      result.sourceSqlWritesIssuedByCopyTool === false &&
      result.sourceDirectoryWriteFreeVerified === true &&
      result.sourceReadOnlyConnectionMayUpdateExistingWalSharedMemory === false &&
      manifest.formatVersion === 2 &&
      manifest.runId === strictRunId &&
      manifest.source?.treeImmutability === 'required_quiescent' &&
      manifest.source.path === (await realpath(strictSourcePath)) &&
      manifest.database?.nlink === 1 &&
      targetFact === 'quiescent-source',
    '严格静止模式必须只在完整源树证据稳定时发布可读 Backup API 副本。',
  );
  return { planExitCode: planRun.status, copyExitCode: copyRun.status, sourceTreeUnchanged: true, targetFact, manifest, result };
}

async function sourceTreeEvidence(path: string): Promise<Record<string, unknown>> {
  const stats = await lstat(path, { bigint: true });
  const directoryStats = await lstat(resolve(path, '..'), { bigint: true });
  return {
    database: {
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      bytes: stats.size.toString(),
      mode: (stats.mode & 0o777n).toString(8),
      uid: stats.uid.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
      digest: await fileDigest(path),
    },
    directory: {
      device: directoryStats.dev.toString(),
      inode: directoryStats.ino.toString(),
      bytes: directoryStats.size.toString(),
      mode: (directoryStats.mode & 0o777n).toString(8),
      uid: directoryStats.uid.toString(),
      mtimeNs: directoryStats.mtimeNs.toString(),
      ctimeNs: directoryStats.ctimeNs.toString(),
    },
    companions: {
      wal: await pathExists(`${path}-wal`),
      shm: await pathExists(`${path}-shm`),
      journal: await pathExists(`${path}-journal`),
    },
  };
}

function parseJsonOutput(value: string | Buffer | null): unknown {
  const text = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Test 数据库复制工具没有返回有效 JSON：${text.slice(0, 500)}`, { cause: error });
  }
}

async function fileDigest(path: string): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Test 数据库复制行为探针失败：${message}`);
}
