import { createHash } from 'node:crypto';
import { chmod, lstat, open, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createZeusDatabase, migrateLegacyConversationItemsCandidate } from '../packages/storage/src/index.js';

interface Arguments {
  sourcePath: string;
  candidatePath: string;
  rollbackPath: string;
  apply: boolean;
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  const sourcePath = await assertSafeSource(input.sourcePath);
  await assertNewOutput(input.candidatePath, '.conversation-cutover.candidate.db');
  await assertNewOutput(input.rollbackPath, '.conversation-cutover.rollback.db');
  assertDistinctPaths(sourcePath, input.candidatePath, input.rollbackPath);

  const source = openReadOnly(sourcePath, false);
  try {
    assertQuickCheck(source, '来源数据库');
    const sourceRows = countRows(source, 'conversation_items');
    const preview = {
      mode: input.apply ? 'apply' : 'preflight',
      sourcePath,
      candidatePath: input.candidatePath,
      rollbackPath: input.rollbackPath,
      sourceRows,
      sourceQuickCheck: 'ok',
      sourceReadOnly: true,
    };
    if (!input.apply) {
      process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      return;
    }
    await backup(source, input.rollbackPath);
    await chmod(input.rollbackPath, 0o600);
    await backup(source, input.candidatePath);
    await chmod(input.candidatePath, 0o600);
  } finally {
    source.close();
  }

  const rollbackSha256 = await sha256File(input.rollbackPath);
  const candidate = await createZeusDatabase(input.candidatePath);
  let receipt;
  try {
    receipt = migrateLegacyConversationItemsCandidate(candidate, {
      rollbackDatabaseIdentity: `sha256:${rollbackSha256}`,
    });
    await candidate.save();
  } finally {
    await candidate.close();
  }

  const candidateVerifier = openReadOnly(input.candidatePath, true);
  const rollbackVerifier = openReadOnly(input.rollbackPath, true);
  try {
    assertQuickCheck(candidateVerifier, '切换候选数据库');
    assertQuickCheck(rollbackVerifier, '安全回退数据库');
    const persisted = candidateVerifier
      .prepare(
        `SELECT state, source_rows, provider_state_rows, mapped_rows, source_digest,
                mapping_digest, rollback_database_identity, completed_at
           FROM conversation_legacy_cutover_metadata WHERE singleton = 1`,
      )
      .get();
    if (persisted?.state !== 'ready' || Number(persisted.source_rows) !== receipt.sourceRows || persisted.rollback_database_identity !== `sha256:${rollbackSha256}`) {
      throw new Error('切换候选持久回执与运行结果不一致。');
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'applied',
          sourcePath,
          candidate: {
            path: input.candidatePath,
            sha256: await sha256File(input.candidatePath),
            byteLength: (await stat(input.candidatePath)).size,
            quickCheck: 'ok',
          },
          rollback: {
            path: input.rollbackPath,
            sha256: rollbackSha256,
            byteLength: (await stat(input.rollbackPath)).size,
            quickCheck: 'ok',
          },
          receipt,
          sourceMutation: 'none_read_only_sqlite_backup_api',
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    candidateVerifier.close();
    rollbackVerifier.close();
  }
}

function parseArguments(values: string[]): Arguments {
  let sourcePath: string | null = null;
  let candidatePath: string | null = null;
  let rollbackPath: string | null = null;
  let apply = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const next = values[index + 1];
    if ((value === '--source' || value === '--candidate' || value === '--rollback') && next) {
      if (value === '--source') sourcePath = resolve(next);
      if (value === '--candidate') candidatePath = resolve(next);
      if (value === '--rollback') rollbackPath = resolve(next);
      index += 1;
      continue;
    }
    if (value === '--apply') {
      apply = true;
      continue;
    }
    throw new Error(`未知参数：${value ?? ''}`);
  }
  if (!sourcePath || !candidatePath || !rollbackPath) {
    throw new Error('用法：tsx scripts/prepare-conversation-legacy-cutover.ts --source <只读来源库> --candidate <*.conversation-cutover.candidate.db> --rollback <*.conversation-cutover.rollback.db> [--apply]');
  }
  return { sourcePath, candidatePath, rollbackPath, apply };
}

async function assertSafeSource(value: string): Promise<string> {
  const metadata = await lstat(value);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('来源数据库必须是普通文件且不能是符号链接。');
  return realpath(value);
}

async function assertNewOutput(value: string, suffix: string): Promise<void> {
  if (!value.endsWith(suffix)) throw new Error(`输出路径必须以 ${suffix} 结尾。`);
  await realpath(dirname(value));
  try {
    await lstat(value);
    throw new Error(`输出已经存在，拒绝覆盖：${value}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertDistinctPaths(sourcePath: string, candidatePath: string, rollbackPath: string): void {
  const paths = [sourcePath, resolve(candidatePath), resolve(rollbackPath)];
  if (new Set(paths).size !== paths.length) throw new Error('来源、候选和回退数据库路径必须彼此独立。');
  for (const output of paths.slice(1)) {
    if (output === '/' || output.endsWith(sep)) throw new Error('输出数据库路径无效。');
  }
}

function openReadOnly(path: string, immutable: boolean): DatabaseSync {
  const location = pathToFileURL(path);
  location.searchParams.set('mode', 'ro');
  if (immutable) location.searchParams.set('immutable', '1');
  const db = new DatabaseSync(location.href, {
    readOnly: true,
    timeout: 5_000,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function assertQuickCheck(db: DatabaseSync, label: string): void {
  const values = db
    .prepare('PRAGMA quick_check')
    .all()
    .flatMap((row) => Object.values(row).map(String));
  if (values.length !== 1 || values[0] !== 'ok') throw new Error(`${label} quick_check 失败：${values.join('; ')}`);
}

function countRows(db: DatabaseSync, table: string): number {
  const present = db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!present) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS row_count FROM ${table}`).get()?.row_count ?? 0);
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

await main();
