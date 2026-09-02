import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { promoteValidatedRecoveryCandidate, type RecoveryPromotionOfflineLeasePort } from '../packages/storage/src/index.js';
import { conversationSyncProtocolV2Generation } from '../packages/storage/src/conversationSyncEventStore.js';

const executeFile = promisify(execFile);
const maintenanceMigrationId = '20260826_0002_retired_conversation_sync_event_cleanup';
const maximumRetainedEvents = 4_096;
const maximumRetainedBytes = 16 * 1024 * 1024;
const markerFormatVersion = 1;
const businessFactTables = [
  'conversations',
  'conversation_turns',
  'conversation_items',
  'conversation_model_history',
  'conversation_process_items',
  'conversation_resources',
  'turn_change_sets',
  'turn_change_files',
  'conversation_server_requests',
  'conversation_submissions',
] as const;

interface Arguments {
  candidateDatabasePath: string;
  targetDatabasePath: string;
  rollbackDirectoryPath: string;
  apply: boolean;
  confirmation: string | null;
}

interface PromotionDatabaseFacts {
  quickCheck: string;
  foreignKeyViolations: number;
  maintenanceMigrationPresent: boolean;
  legacySyncEvents: number;
  currentNonV2Streams: number;
  retainedBudgetViolations: number;
  business: Record<string, { rows: number; minimumId: string | null; maximumId: string | null; idCharacters: number }>;
}

const arguments_ = parseArguments(process.argv.slice(2));
const formalDatabasePath = resolve(join(homedir(), '.zeus', 'data', 'zeus.db'));
if (resolve(arguments_.targetDatabasePath) !== formalDatabasePath) throw new Error(`正式同步事件提升只允许目标：${formalDatabasePath}`);
const candidateDatabasePath = await requireSingleLinkRegularFile(arguments_.candidateDatabasePath, 'candidateDatabasePath');
const targetDatabasePath = await requireSingleLinkRegularFile(arguments_.targetDatabasePath, 'targetDatabasePath');
if (basename(candidateDatabasePath) !== 'zeus.db' || basename(dirname(candidateDatabasePath)) !== 'database') {
  throw new Error('候选数据库必须位于隔离候选根的 database/zeus.db。');
}
const candidateRoot = dirname(dirname(candidateDatabasePath));
if (candidateRoot === resolve(join(homedir(), '.zeus')) || candidateRoot.startsWith(`${resolve(join(homedir(), '.zeus'))}/`)) {
  throw new Error('候选根不得位于正式 Zeus 数据目录。');
}
await mkdir(arguments_.rollbackDirectoryPath, { recursive: true, mode: 0o700 });
const rollbackDirectoryPath = await realpath(arguments_.rollbackDirectoryPath);

const candidateFacts = inspectPromotionDatabase(candidateDatabasePath);
const targetFacts = inspectPromotionDatabase(targetDatabasePath);
assertCandidateFacts(candidateFacts);
if (targetFacts.quickCheck !== 'ok' || targetFacts.foreignKeyViolations !== 0) throw new Error('正式数据库在提升前未通过完整性检查。');
if (JSON.stringify(candidateFacts.business) !== JSON.stringify(targetFacts.business)) throw new Error('候选数据库与正式数据库的业务事实身份不一致，拒绝提升。');

const [candidateDigest, targetDigest] = await Promise.all([digestFile(candidateDatabasePath), digestFile(targetDatabasePath)]);
const identity = {
  format: 'zeus-conversation-sync-promotion-identity',
  candidateDatabaseSha256: candidateDigest.sha256,
  candidateDatabaseBytes: candidateDigest.bytes,
  targetDatabaseSha256: targetDigest.sha256,
  targetDatabaseBytes: targetDigest.bytes,
  businessSha256: sha256(JSON.stringify(candidateFacts.business)),
  protocolGeneration: conversationSyncProtocolV2Generation,
  maintenanceMigrationId,
} as const;
const expectedBackupId = `conversation-sync-${identity.businessSha256.slice(0, 16)}`;
const expectedManifestSha256 = sha256(JSON.stringify(identity));
const expectedPackageSha256 = sha256(`${expectedBackupId}\0${expectedManifestSha256}\0${candidateDigest.sha256}`);
const marker = {
  format: 'zeus-recovery-candidate',
  formatVersion: markerFormatVersion,
  backupId: expectedBackupId,
  packageSha256: expectedPackageSha256,
  manifestSha256: expectedManifestSha256,
  validatedAt: new Date().toISOString(),
  quickCheck: 'ok',
  promotable: true,
} as const;
await publishOrVerifyMarker(join(candidateRoot, 'recovery-candidate.json'), marker);

const expectedConfirmation = `PROMOTE ${expectedPackageSha256}`;
if (!arguments_.apply || arguments_.confirmation !== expectedConfirmation) {
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'confirmation_required',
        candidateRoot,
        candidateDatabasePath,
        targetDatabasePath,
        rollbackDirectoryPath,
        identity,
        candidateFacts,
        targetFacts,
        expectedConfirmation,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = arguments_.apply ? 2 : 0;
} else {
  const lockPath = join(dirname(targetDatabasePath), '.conversation-sync-promotion.lock');
  const lock = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, candidateDatabasePath, expectedPackageSha256, createdAt: new Date().toISOString() })}\n`);
    await lock.sync();
    await assertTargetNotOpen(targetDatabasePath);
    const offlineLeasePort: RecoveryPromotionOfflineLeasePort = {
      withExclusiveOfflineLease: async (operation) =>
        operation({
          leaseId: `conversation-sync-offline-${randomUUID()}`,
          coreState: 'stopped',
          databaseWriterCount: 0,
          acquiredAt: new Date().toISOString(),
          assertStillExclusive: () => assertTargetNotOpen(targetDatabasePath),
        }),
    };
    const result = await promoteValidatedRecoveryCandidate({
      candidatePath: candidateRoot,
      targetDatabasePath,
      rollbackDirectoryPath,
      expectedBackupId,
      expectedPackageSha256,
      expectedManifestSha256,
      expectedDatabaseSha256: candidateDigest.sha256,
      expectedDatabaseBytes: candidateDigest.bytes,
      expectedManifestFileCount: 1,
      confirmation: expectedConfirmation,
      offlineLeasePort,
    });
    const promotedFacts = inspectPromotionDatabase(targetDatabasePath);
    assertCandidateFacts(promotedFacts);
    if (JSON.stringify(promotedFacts.business) !== JSON.stringify(candidateFacts.business)) throw new Error('提升后业务事实身份发生变化。');
    process.stdout.write(`${JSON.stringify({ status: 'promoted', ...result, promotedFacts }, null, 2)}\n`);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

function inspectPromotionDatabase(path: string): PromotionDatabaseFacts {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 30_000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  try {
    database.exec('PRAGMA query_only = ON');
    const scalar = (sql: string, parameters: unknown[] = []): number => Number((database.prepare(sql).get(...parameters) as Record<string, unknown> | undefined)?.value ?? 0);
    const business = Object.fromEntries(
      businessFactTables.map((table) => {
        const present = Boolean(database.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table));
        if (!present) return [table, { rows: 0, minimumId: null, maximumId: null, idCharacters: 0 }];
        const row = database.prepare(`SELECT COUNT(*) AS rows, MIN(id) AS minimumId, MAX(id) AS maximumId, COALESCE(SUM(length(id)), 0) AS idCharacters FROM ${table}`).get() as Record<string, unknown>;
        return [table, { rows: Number(row.rows), minimumId: typeof row.minimumId === 'string' ? row.minimumId : null, maximumId: typeof row.maximumId === 'string' ? row.maximumId : null, idCharacters: Number(row.idCharacters) }];
      }),
    );
    return {
      quickCheck: String((database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined)?.quick_check ?? ''),
      foreignKeyViolations: (database.prepare('PRAGMA foreign_key_check').all() as unknown[]).length,
      maintenanceMigrationPresent: Boolean(database.prepare('SELECT 1 AS present FROM schema_migrations WHERE migration_id = ?').get(maintenanceMigrationId)),
      legacySyncEvents: scalar('SELECT COUNT(*) AS value FROM conversation_sync_events WHERE generation_id <> ?', [conversationSyncProtocolV2Generation]),
      currentNonV2Streams: scalar('SELECT COUNT(*) AS value FROM conversation_sync_event_streams WHERE generation_id <> ? AND is_current = 1', [conversationSyncProtocolV2Generation]),
      retainedBudgetViolations: scalar(
        `SELECT COUNT(*) AS value
           FROM (
             SELECT conversation_id, COUNT(*) AS event_count, COALESCE(SUM(payload_byte_length), 0) AS event_bytes
               FROM conversation_sync_events
              WHERE generation_id = ?
              GROUP BY conversation_id
             HAVING event_count > ? OR event_bytes > ?
           )`,
        [conversationSyncProtocolV2Generation, maximumRetainedEvents, maximumRetainedBytes],
      ),
      business,
    };
  } finally {
    database.close();
  }
}

function assertCandidateFacts(facts: PromotionDatabaseFacts): void {
  if (facts.quickCheck !== 'ok' || facts.foreignKeyViolations !== 0) throw new Error('候选数据库未通过完整性检查。');
  if (!facts.maintenanceMigrationPresent || facts.legacySyncEvents !== 0 || facts.currentNonV2Streams !== 0 || facts.retainedBudgetViolations !== 0) {
    throw new Error('候选数据库尚未完成同步事件 V2 压缩维护。');
  }
}

async function assertTargetNotOpen(target: string): Promise<void> {
  try {
    const result = await executeFile('/usr/sbin/lsof', ['-t', '--', target], { encoding: 'utf8' });
    const pids = result.stdout
      .split(/\s+/u)
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0 && value !== process.pid);
    if (pids.length > 0) throw new Error(`正式数据库仍被进程占用：${pids.join(',')}`);
  } catch (error) {
    if (isExecError(error) && error.code === 1) return;
    throw error;
  }
}

async function requireSingleLinkRegularFile(pathValue: string, field: string): Promise<string> {
  const path = resolve(pathValue);
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) throw new Error(`${field} 必须是单链接普通文件。`);
  return realpath(path);
}

async function digestFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function publishOrVerifyMarker(path: string, marker: Record<string, unknown>): Promise<void> {
  const content = `${JSON.stringify(marker, null, 2)}\n`;
  try {
    const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const comparableExisting = { ...existing, validatedAt: marker.validatedAt };
    if (JSON.stringify(comparableExisting) !== JSON.stringify(marker)) throw new Error('候选恢复 marker 与当前压缩候选身份不一致。');
  }
}

function parseArguments(values: string[]): Arguments {
  const parsed = parseArgs({
    args: values,
    strict: true,
    options: { 'candidate-db': { type: 'string' }, 'target-db': { type: 'string' }, 'rollback-dir': { type: 'string' }, apply: { type: 'boolean' }, confirmation: { type: 'string' } },
  }).values;
  if (!parsed['candidate-db'] || !parsed['target-db'] || !parsed['rollback-dir']) {
    throw new Error('用法：tsx scripts/promote-conversation-sync-candidate.ts --candidate-db <候选根/database/zeus.db> --target-db ~/.zeus/data/zeus.db --rollback-dir <回退目录> [--apply --confirmation <确认>]');
  }
  return {
    candidateDatabasePath: resolve(parsed['candidate-db']),
    targetDatabasePath: resolve(parsed['target-db']),
    rollbackDirectoryPath: resolve(parsed['rollback-dir']),
    apply: parsed.apply ?? false,
    confirmation: parsed.confirmation ?? null,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function isExecError(value: unknown): value is NodeJS.ErrnoException & { code: number } {
  return value instanceof Error && 'code' in value && typeof value.code === 'number';
}
