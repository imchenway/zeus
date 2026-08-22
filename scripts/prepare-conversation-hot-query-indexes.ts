import { lstat, realpath, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { CONVERSATION_HOT_QUERY_INDEX_MIGRATION_ID, conversationHotQueryIndexes, createZeusDatabase } from '../packages/storage/src/index.js';

const FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;

interface Arguments {
  databasePath: string;
  apply: boolean;
}

function parseArguments(arguments_: string[]): Arguments {
  let databasePath: string | null = null;
  let apply = false;
  let candidateCopy = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--db' && arguments_[index + 1]) {
      databasePath = resolve(arguments_[index + 1]!);
      index += 1;
      continue;
    }
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--candidate-copy') {
      candidateCopy = true;
      continue;
    }
    throw new Error(`未知参数：${argument ?? ''}`);
  }
  if (!databasePath || !candidateCopy) {
    throw new Error('用法：tsx scripts/prepare-conversation-hot-query-indexes.ts --db <离线候选库> --candidate-copy [--apply]\n不带 --apply 时只执行只读预检。');
  }
  return { databasePath, apply };
}

function assertOutsideZeusDataRoot(databasePath: string): void {
  const zeusDataRoot = resolve(join(homedir(), '.zeus'));
  if (databasePath === zeusDataRoot || databasePath.startsWith(`${zeusDataRoot}${sep}`)) {
    throw new Error('候选库索引维护拒绝 ~/.zeus 内的任何路径；请先复制到独立且已停止写入的候选目录。');
  }
}

async function assertNotFormalDatabaseHardLink(databaseStats: Awaited<ReturnType<typeof stat>>): Promise<void> {
  for (const formalPath of [join(homedir(), '.zeus', 'data', 'zeus.db'), join(homedir(), '.zeus', 'zeus.db')]) {
    try {
      const formalStats = await stat(formalPath);
      if (formalStats.dev === databaseStats.dev && formalStats.ino === databaseStats.ino) {
        throw new Error(`候选数据库与正式库是同一个文件或硬链接：${formalPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function sidecarFiles(databasePath: string): Promise<Array<{ path: string; bytes: number }>> {
  const present: Array<{ path: string; bytes: number }> = [];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const path = `${databasePath}${suffix}`;
    try {
      const sidecar = await stat(path);
      present.push({ path, bytes: sidecar.size });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return present;
}

function immutableReadOnlyLocation(databasePath: string): string {
  const location = pathToFileURL(databasePath);
  location.searchParams.set('mode', 'ro');
  location.searchParams.set('immutable', '1');
  return location.href;
}

function inspectReadOnly(
  databasePath: string,
  runQuickCheck: boolean,
): {
  quickCheck: string | null;
  migrationRecorded: boolean;
  indexes: Array<{ name: string; present: boolean }>;
} {
  const database = new DatabaseSync(immutableReadOnlyLocation(databasePath), {
    readOnly: true,
    timeout: 5_000,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    database.exec('PRAGMA query_only = ON');
    const requiredTables = [...new Set(conversationHotQueryIndexes.map((definition) => definition.table))];
    const missingTables = requiredTables.filter((table) => !database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    if (missingTables.length > 0) throw new Error(`候选库缺少目标表：${missingTables.join(', ')}`);
    const hasLedger = Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get());
    if (!hasLedger) throw new Error('候选库缺少 schema_migrations，不能安全记录索引迁移。');
    const migrationRecorded = Boolean(database.prepare('SELECT 1 AS present FROM schema_migrations WHERE migration_id = ?').get(CONVERSATION_HOT_QUERY_INDEX_MIGRATION_ID));
    const indexes = conversationHotQueryIndexes.map((definition) => ({
      name: definition.name,
      present: Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?").get(definition.name)),
    }));
    const quickCheck = runQuickCheck ? String(database.prepare('PRAGMA quick_check(1)').get()?.quick_check ?? '') : null;
    if (runQuickCheck && quickCheck !== 'ok') throw new Error(`候选库 quick_check 未通过：${quickCheck || '无结果'}`);
    return { quickCheck, migrationRecorded, indexes };
  } finally {
    database.close();
  }
}

const arguments_ = parseArguments(process.argv.slice(2));
assertOutsideZeusDataRoot(arguments_.databasePath);

const pathStats = await lstat(arguments_.databasePath);
if (pathStats.isSymbolicLink()) throw new Error('候选数据库路径不能是符号链接。');
const canonicalDatabasePath = await realpath(arguments_.databasePath);
assertOutsideZeusDataRoot(canonicalDatabasePath);
const databaseStats = await stat(arguments_.databasePath);
if (!databaseStats.isFile()) throw new Error('候选数据库路径不是普通文件。');
await assertNotFormalDatabaseHardLink(databaseStats);
const sidecars = await sidecarFiles(arguments_.databasePath);
const nonEmptyRecoverySidecars = sidecars.filter((sidecar) => !sidecar.path.endsWith('-shm') && sidecar.bytes > 0);
if (nonEmptyRecoverySidecars.length > 0) {
  throw new Error(`候选库仍有未收口的 SQLite WAL/journal：${nonEmptyRecoverySidecars.map((sidecar) => `${sidecar.path} (${sidecar.bytes} bytes)`).join(', ')}`);
}

const filesystem = await statfs(dirname(arguments_.databasePath));
const freeBytes = filesystem.bavail * filesystem.bsize;
const requiredFreeBytes = Math.ceil(databaseStats.size * 1.5) + FREE_SPACE_RESERVE_BYTES;
const preflight = inspectReadOnly(arguments_.databasePath, arguments_.apply);
const missingIndexes = preflight.indexes.filter((index) => !index.present).map((index) => index.name);

if (!arguments_.apply) {
  const diskPreflightPassed = freeBytes >= requiredFreeBytes;
  console.log(
    JSON.stringify(
      {
        status: !diskPreflightPassed ? 'blocked-insufficient-disk' : missingIndexes.length === 0 && preflight.migrationRecorded ? 'already-applied' : 'ready-for-maintenance',
        mode: 'candidate-read-only-preflight',
        databasePath: arguments_.databasePath,
        databaseBytes: databaseStats.size,
        freeBytes,
        requiredFreeBytes,
        diskPreflightPassed,
        sidecars,
        quickCheck: 'skipped-until-apply',
        migrationRecorded: preflight.migrationRecorded,
        indexes: preflight.indexes,
        nextCommand: diskPreflightPassed ? `tsx scripts/prepare-conversation-hot-query-indexes.ts --db ${JSON.stringify(arguments_.databasePath)} --candidate-copy --apply` : null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (freeBytes < requiredFreeBytes) {
  throw new Error(`候选库所在卷可用空间不足：需要至少 ${requiredFreeBytes} bytes，当前 ${freeBytes} bytes。`);
}

const database = await createZeusDatabase(arguments_.databasePath, {
  applyDeferredConversationHotQueryIndexes: true,
  onConversationHotQueryIndexProgress: (progress) => {
    console.error(`[${progress.index}/${progress.total}] ${progress.name}: ${progress.status}`);
  },
});
await database.close();

const verification = inspectReadOnly(arguments_.databasePath, true);
const remainingIndexes = verification.indexes.filter((index) => !index.present);
if (!verification.migrationRecorded || remainingIndexes.length > 0) {
  throw new Error(`候选库索引维护未完整提交：ledger=${verification.migrationRecorded ? 'present' : 'missing'}, indexes=${remainingIndexes.map((index) => index.name).join(', ') || 'ok'}`);
}

console.log(
  JSON.stringify(
    {
      status: 'applied',
      mode: 'candidate-offline-maintenance',
      databasePath: arguments_.databasePath,
      migrationId: CONVERSATION_HOT_QUERY_INDEX_MIGRATION_ID,
      quickCheck: verification.quickCheck,
      indexes: verification.indexes,
      rollback: '候选副本不晋升并从原始一致性副本重新生成；脚本未触碰正式库。',
    },
    null,
    2,
  ),
);
