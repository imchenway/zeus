import { createHash } from 'node:crypto';
import { chmod, lstat, realpath, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { conversationSyncProtocolV2Generation, conversationSyncProtocolV2MigrationId } from '../packages/storage/src/conversationSyncEventStore.js';

const maintenanceMigrationId = '20260826_0002_retired_conversation_sync_event_cleanup';
const maximumRetainedEvents = 4_096;
const maximumRetainedBytes = 16 * 1024 * 1024;
const freeSpaceReserveBytes = 2 * 1024 * 1024 * 1024;
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
  databasePath: string;
  apply: boolean;
  confirmation: string | null;
}

export interface ConversationSyncDatabaseFacts {
  databaseBytes: number;
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  quickCheck: string;
  foreignKeyViolations: number;
  syncEvents: number;
  syncBytes: number;
  legacySyncEvents: number;
  legacySyncBytes: number;
  currentV2Streams: number;
  currentNonV2Streams: number;
  business: Record<string, { rows: number; minimumId: string | null; maximumId: string | null; idCharacters: number }>;
}

const arguments_ = parseArguments(process.argv.slice(2));
assertOutsideFormalDataRoot(arguments_.databasePath);
const fileStats = await lstat(arguments_.databasePath, { bigint: true });
if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.nlink !== 1n) throw new Error('同步事件压缩候选必须是单链接普通文件。');
const canonicalPath = await realpath(arguments_.databasePath);
assertOutsideFormalDataRoot(canonicalPath);
const preflight = inspectConversationSyncDatabase(canonicalPath);
if (preflight.quickCheck !== 'ok' || preflight.foreignKeyViolations !== 0) throw new Error('候选数据库在压缩前未通过完整性检查。');
if (preflight.currentNonV2Streams !== 0 || preflight.currentV2Streams === 0) throw new Error('候选数据库尚未完成会话同步 V2 迁移。');

const plan = {
  format: 'zeus-conversation-sync-candidate-compaction-plan',
  databasePath: canonicalPath,
  device: fileStats.dev.toString(),
  inode: fileStats.ino.toString(),
  size: fileStats.size.toString(),
  modifiedAtMs: fileStats.mtimeMs.toString(),
  protocolGeneration: conversationSyncProtocolV2Generation,
  maximumRetainedEvents,
  maximumRetainedBytes,
  preflight,
} as const;
const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const expectedConfirmation = `COMPACT ${planHash}`;

if (!arguments_.apply || arguments_.confirmation !== expectedConfirmation) {
  process.stdout.write(`${JSON.stringify({ status: 'confirmation_required', plan, planHash, expectedConfirmation }, null, 2)}\n`);
  process.exitCode = arguments_.apply ? 2 : 0;
} else {
  const filesystem = await statfs(dirname(canonicalPath));
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const estimatedLiveBytes = Math.max(0, (preflight.pageCount - preflight.freelistCount) * preflight.pageSize - preflight.legacySyncBytes);
  const requiredBytes = Math.max(estimatedLiveBytes, 512 * 1024 * 1024) + freeSpaceReserveBytes;
  if (availableBytes < requiredBytes) throw new Error(`候选压缩空间不足：需要至少 ${requiredBytes} 字节，当前 ${availableBytes} 字节。`);

  const database = new DatabaseSync(canonicalPath, {
    timeout: 30_000,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  let writerFenceOpened = false;
  try {
    database.exec('PRAGMA busy_timeout = 30000');
    const writerFencePresent = Boolean(database.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'conversation_legacy_write_fence'`).get());
    if (writerFencePresent) {
      const opened = database.prepare('UPDATE conversation_legacy_write_fence SET current_writer_open = 1 WHERE singleton = 1').run();
      if (opened.changes !== 1) throw new Error('候选数据库无法取得显式离线维护写入围栏。');
      writerFenceOpened = true;
    }
    // 候选是可丢弃副本；关闭回滚日志避免 17 GB DELETE 再制造同量 journal。
    // 任意异常都拒绝晋升并从正式源重新生成候选，绝不尝试修补半成品。
    database.exec('PRAGMA journal_mode = OFF');
    database.exec('PRAGMA synchronous = OFF');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(`DELETE FROM conversation_sync_events WHERE generation_id <> ${sqlString(conversationSyncProtocolV2Generation)}`);
    database.exec(`DELETE FROM conversation_sync_event_streams WHERE generation_id <> ${sqlString(conversationSyncProtocolV2Generation)}`);
    compactV2Tails(database);
    const checksum = createHash('sha256').update('retired-sync-generations-deleted,v2-tail<=4096-events,v2-tail<=16777216-bytes,v1').digest('hex');
    database
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(maintenanceMigrationId, '离线删除已退役同步流并压缩 V2 连续尾部', `sha256:${checksum}`, new Date().toISOString());
    database.exec('VACUUM');
    database.exec('PRAGMA journal_mode = DELETE');
    database.exec('PRAGMA synchronous = FULL');
  } finally {
    if (writerFenceOpened) database.prepare('UPDATE conversation_legacy_write_fence SET current_writer_open = 0 WHERE singleton = 1').run();
    database.close();
  }
  await chmod(canonicalPath, 0o600);

  const postflight = inspectConversationSyncDatabase(canonicalPath);
  if (postflight.quickCheck !== 'ok' || postflight.foreignKeyViolations !== 0) throw new Error('候选数据库压缩后未通过完整性检查。');
  if (postflight.legacySyncEvents !== 0 || postflight.currentNonV2Streams !== 0) throw new Error('候选数据库仍包含已退役同步事件或旧当前流。');
  if (JSON.stringify(preflight.business) !== JSON.stringify(postflight.business)) throw new Error('候选压缩触碰了会话业务事实，已拒绝晋升。');
  const retainedBudgetViolation = readOnlyDatabase(canonicalPath, (database) =>
    Number(
      database
        .prepare(
          `SELECT COUNT(*) AS violations
             FROM (
               SELECT conversation_id, COUNT(*) AS event_count, COALESCE(SUM(payload_byte_length), 0) AS event_bytes
                 FROM conversation_sync_events
                WHERE generation_id = ?
                GROUP BY conversation_id
               HAVING event_count > ? OR event_bytes > ?
             )`,
        )
        .get(conversationSyncProtocolV2Generation, maximumRetainedEvents, maximumRetainedBytes)?.violations ?? 0,
    ),
  );
  if (retainedBudgetViolation !== 0) throw new Error('候选数据库的 V2 同步尾部仍超过条数或字节预算。');

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'compacted',
        databasePath: canonicalPath,
        planHash,
        migrationId: maintenanceMigrationId,
        protocolMigrationId: conversationSyncProtocolV2MigrationId,
        preflight,
        postflight,
        reclaimedBytes: preflight.databaseBytes - postflight.databaseBytes,
        retainedBudgetViolation,
        rollback: '候选不晋升；从未修改的正式 SQLite 源重新生成。',
      },
      null,
      2,
    )}\n`,
  );
}

function compactV2Tails(database: DatabaseSync): void {
  const streams = database
    .prepare(`SELECT conversation_id, base_sequence, latest_sequence FROM conversation_sync_event_streams WHERE generation_id = ? AND is_current = 1 ORDER BY conversation_id`)
    .all(conversationSyncProtocolV2Generation) as Array<{ conversation_id: string; base_sequence: number; latest_sequence: number }>;
  const metadataStatement = database.prepare(
    `SELECT sequence, payload_byte_length
       FROM conversation_sync_events
      WHERE conversation_id = ? AND generation_id = ?
      ORDER BY sequence DESC
      LIMIT ?`,
  );
  const deleteStatement = database.prepare(`DELETE FROM conversation_sync_events WHERE conversation_id = ? AND generation_id = ? AND sequence < ?`);
  const updateStatement = database.prepare(`UPDATE conversation_sync_event_streams SET base_sequence = ? WHERE conversation_id = ? AND generation_id = ? AND is_current = 1`);
  for (const stream of streams) {
    const rows = metadataStatement.all(stream.conversation_id, conversationSyncProtocolV2Generation, maximumRetainedEvents) as Array<{ sequence: number; payload_byte_length: number }>;
    if (rows.length === 0) continue;
    let retainedBytes = 0;
    let nextBase = rows[0]!.sequence;
    for (const [index, row] of rows.entries()) {
      if (index > 0 && retainedBytes + row.payload_byte_length > maximumRetainedBytes) break;
      retainedBytes += row.payload_byte_length;
      nextBase = row.sequence;
    }
    if (nextBase <= stream.base_sequence) continue;
    deleteStatement.run(stream.conversation_id, conversationSyncProtocolV2Generation, nextBase);
    updateStatement.run(nextBase, stream.conversation_id, conversationSyncProtocolV2Generation);
  }
}

export function inspectConversationSyncDatabase(path: string): ConversationSyncDatabaseFacts {
  return readOnlyDatabase(path, (database) => {
    const scalar = (sql: string, parameters: unknown[] = []): number => Number((database.prepare(sql).get(...parameters) as Record<string, unknown> | undefined)?.value ?? 0);
    const business = Object.fromEntries(
      businessFactTables.map((table) => {
        const present = Boolean(database.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table));
        if (!present) return [table, { rows: 0, minimumId: null, maximumId: null, idCharacters: 0 }];
        const row = database.prepare(`SELECT COUNT(*) AS rows, MIN(id) AS minimumId, MAX(id) AS maximumId, COALESCE(SUM(length(id)), 0) AS idCharacters FROM ${table}`).get() as Record<string, unknown>;
        return [table, { rows: Number(row.rows), minimumId: typeof row.minimumId === 'string' ? row.minimumId : null, maximumId: typeof row.maximumId === 'string' ? row.maximumId : null, idCharacters: Number(row.idCharacters) }];
      }),
    );
    const pageCount = scalar('SELECT page_count AS value FROM pragma_page_count');
    const pageSize = scalar('SELECT page_size AS value FROM pragma_page_size');
    return {
      databaseBytes: pageCount * pageSize,
      pageCount,
      pageSize,
      freelistCount: scalar('SELECT freelist_count AS value FROM pragma_freelist_count'),
      quickCheck: String((database.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown> | undefined)?.quick_check ?? ''),
      foreignKeyViolations: (database.prepare('PRAGMA foreign_key_check').all() as unknown[]).length,
      syncEvents: scalar('SELECT COUNT(*) AS value FROM conversation_sync_events'),
      syncBytes: scalar('SELECT COALESCE(SUM(payload_byte_length), 0) AS value FROM conversation_sync_events'),
      legacySyncEvents: scalar('SELECT COUNT(*) AS value FROM conversation_sync_events WHERE generation_id <> ?', [conversationSyncProtocolV2Generation]),
      legacySyncBytes: scalar('SELECT COALESCE(SUM(payload_byte_length), 0) AS value FROM conversation_sync_events WHERE generation_id <> ?', [conversationSyncProtocolV2Generation]),
      currentV2Streams: scalar('SELECT COUNT(*) AS value FROM conversation_sync_event_streams WHERE generation_id = ? AND is_current = 1', [conversationSyncProtocolV2Generation]),
      currentNonV2Streams: scalar('SELECT COUNT(*) AS value FROM conversation_sync_event_streams WHERE generation_id <> ? AND is_current = 1', [conversationSyncProtocolV2Generation]),
      business,
    };
  });
}

function readOnlyDatabase<T>(path: string, operation: (database: DatabaseSync) => T): T {
  const location = pathToFileURL(path);
  location.searchParams.set('mode', 'ro');
  location.searchParams.set('immutable', '1');
  const database = new DatabaseSync(location.href, { readOnly: true, timeout: 30_000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  try {
    database.exec('PRAGMA query_only = ON');
    return operation(database);
  } finally {
    database.close();
  }
}

function assertOutsideFormalDataRoot(path: string): void {
  const roots = [resolve(join(homedir(), '.zeus')), resolve(join(homedir(), 'Library', 'Application Support', '@zeus', 'desktop'))];
  const candidate = resolve(path);
  if (roots.some((root) => candidate === root || candidate.startsWith(`${root}${sep}`))) throw new Error('候选压缩拒绝正式 Zeus 数据根；必须先用 SQLite Backup API 生成独立副本。');
}

function parseArguments(values: string[]): Arguments {
  const parsed = parseArgs({ args: values, strict: true, options: { db: { type: 'string' }, 'candidate-copy': { type: 'boolean' }, apply: { type: 'boolean' }, confirmation: { type: 'string' } } }).values;
  if (!parsed.db || !parsed['candidate-copy']) throw new Error('用法：tsx scripts/compact-conversation-sync-candidate.ts --db <离线候选库> --candidate-copy [--apply --confirmation <计划确认>]');
  return { databasePath: resolve(parsed.db), apply: parsed.apply ?? false, confirmation: parsed.confirmation ?? null };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
