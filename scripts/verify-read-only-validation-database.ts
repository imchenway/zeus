import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createZeusDatabase } from '../packages/storage/src/index.js';
import type { ReadOnlyValidationDescriptor } from '../packages/shared/src/readOnlyValidation.js';

const probeRoot = await realpath(await mkdtemp(join(tmpdir(), 'zeus-read-only-validation-db-')));
const databasePath = join(probeRoot, 'zeus.db');

try {
  const writable = await createZeusDatabase(databasePath);
  writable.execute(`CREATE TABLE validation_probe (id INTEGER PRIMARY KEY, fact TEXT NOT NULL)`);
  writable.execute(`INSERT INTO validation_probe (id, fact) VALUES (?, ?)`, [1, 'immutable-copy-fact']);
  await writable.save();
  await writable.close();
  const validationCopyPreparation = new DatabaseSync(databasePath);
  try {
    const journal = validationCopyPreparation.prepare('PRAGMA journal_mode = DELETE').get() as { journal_mode?: unknown } | undefined;
    assertProbe(String(journal?.journal_mode ?? '').toLowerCase() === 'delete', '验证副本必须在只读打开前转换为 rollback journal。');
  } finally {
    validationCopyPreparation.close();
  }

  const before = await snapshot(databasePath, probeRoot);
  const databaseStats = await lstat(databasePath, { bigint: true });
  const descriptor = {
    formatVersion: 2,
    mode: 'read_only_validation',
    runId: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-08-21T00:00:00.000Z',
    copyPlanHash: '1'.repeat(64),
    manifestPath: `${databasePath}.read-only-validation.json`,
    manifestHash: '2'.repeat(64),
    validationRoot: probeRoot,
    allowedApplication: { bundleId: 'dev.hypha.zeus.test', executableName: 'Zeus Test' },
    source: {
      path: join(probeRoot, 'formal-source.db'),
      inferredDataRoot: probeRoot,
      device: '0',
      inode: '0',
      sha256: '3'.repeat(64),
      bytes: 0,
      treeImmutability: 'required_quiescent',
    },
    database: {
      path: databasePath,
      device: databaseStats.dev.toString(),
      inode: databaseStats.ino.toString(),
      nlink: 1,
      sha256: before.sha256,
      bytes: Number(databaseStats.size),
      schemaSha256: '4'.repeat(64),
      journalMode: 'delete',
    },
  } satisfies ReadOnlyValidationDescriptor;
  const readOnly = await createZeusDatabase(databasePath, { readOnlyValidation: descriptor });
  const fact = readOnly.get<{ fact: string }>(`SELECT fact FROM validation_probe WHERE id = 1`)?.fact ?? null;
  const health = readOnly.storageHealthSnapshot();
  const rejected = {
    execute: captureCode(() => readOnly.execute(`UPDATE validation_probe SET fact = 'mutated' WHERE id = 1`)),
    durableTransaction: captureCode(() => readOnly.durableTransactionSync(() => undefined)),
    externalWriteFault: captureCode(() => readOnly.reportExternalWriteFault('validation_probe', Object.assign(new Error('denied'), { code: 'EACCES' }))),
    save: await captureAsyncCode(() => readOnly.save()),
  };
  await readOnly.close();
  const after = await snapshot(databasePath, probeRoot);

  const observed = {
    fact,
    health,
    rejected,
    databaseSha256Unchanged: before.sha256 === after.sha256,
    databaseSizeUnchanged: before.size === after.size,
    databaseMtimeUnchanged: before.mtimeMs === after.mtimeMs,
    directoryEntriesBefore: before.entries,
    directoryEntriesAfter: after.entries,
  };
  const rejectionCodes = Object.values(rejected);
  assertProbe(fact === 'immutable-copy-fact', '只读连接必须保留查询能力。');
  assertProbe(health.state === 'read_only_validation' && health.readsAvailable && !health.writesAllowed && health.fault === null, 'Storage health 必须显式区分只读验证与磁盘故障。');
  assertProbe(
    rejectionCodes.every((code) => code === 'ZEUS_STORAGE_READ_ONLY_VALIDATION'),
    '所有写入口必须返回统一只读验证失败码。',
  );
  assertProbe(before.sha256 === after.sha256 && before.size === after.size && before.mtimeMs === after.mtimeMs, '只读验证打开、拒写和关闭不得改写数据库文件。');
  assertProbe(JSON.stringify(before.entries) === JSON.stringify(after.entries), '只读验证不得创建 WAL、SHM、迁移备份或其他伴随文件。');

  console.log(JSON.stringify({ status: 'passed', observed }, null, 2));
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

async function snapshot(path: string, root: string): Promise<{ sha256: string; size: number; mtimeMs: number; entries: string[] }> {
  const [bytes, metadata, entries] = await Promise.all([readFile(path), stat(path), readdir(root)]);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    entries: entries.sort(),
  };
}

function captureCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null;
  }
}

async function captureAsyncCode(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null;
  }
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Read-only validation database verifier failed: ${message}`);
}
