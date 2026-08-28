import { createHash, randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { conversationSchemaGeneration, createZeusDatabase } from '@zeus/storage';
import type { ZeusDataLayout } from './zeusDataLayout.js';

export type ConversationStoreMigrationPhase = 'not_required' | 'preflight' | 'candidate_build' | 'candidate_validation' | 'promotion' | 'promoted_but_validation_failed' | 'completed' | 'failed';

export interface ConversationStoreMigrationStatus {
  phase: ConversationStoreMigrationPhase;
  migrationId: string;
  databasePath: string;
  candidatePath: string | null;
  safeRollbackPath: string | null;
  diagnosticPath: string;
  updatedAt: string;
  error: { message: string; code: string | null } | null;
}

export interface ConversationStoreMigrationOptions {
  /** 在接触 SQLite 前完成旧宿主、锁和进程身份收敛；失败同样进入维护诊断。 */
  preflightGuard?: () => Promise<void>;
}

/**
 * 统一会话库的一次性候选构建与同卷提升。
 * 调用方必须先完成旧宿主身份核对和退出；本函数不会猜测或终止进程。
 */
export async function prepareUnifiedConversationStoreMigration(layout: ZeusDataLayout, options: ConversationStoreMigrationOptions = {}): Promise<ConversationStoreMigrationStatus> {
  const statusPath = join(layout.databaseBackups, 'conversation-store-migration-status.json');
  const diagnosticPath = join(layout.databaseBackups, 'conversation-store-migration-diagnostic.json');
  const migrationId = `conversation-store-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const candidatePath = join(dirname(layout.database), `.zeus-conversation-store-${migrationId}.candidate`);
  const safeRollbackPath = join(layout.databaseBackups, `zeus.safe-rollback.${migrationId}.db`);
  let status: ConversationStoreMigrationStatus = {
    phase: 'preflight',
    migrationId,
    databasePath: layout.database,
    candidatePath,
    safeRollbackPath,
    diagnosticPath,
    updatedAt: new Date().toISOString(),
    error: null,
  };
  const persistStatus = (next: Partial<ConversationStoreMigrationStatus>) => {
    status = { ...status, ...next, updatedAt: new Date().toISOString() };
    atomicWriteJson(statusPath, status);
  };
  let databasePromoted = false;

  try {
    mkdirSync(layout.databaseBackups, { recursive: true, mode: 0o700 });
    chmodSync(layout.databaseBackups, 0o700);
    await options.preflightGuard?.();
    if (!existsSync(layout.database)) {
      persistStatus({ phase: 'not_required', candidatePath: null, safeRollbackPath: null });
      return status;
    }
    if (readSchemaGeneration(layout.database) === conversationSchemaGeneration) {
      persistStatus({ phase: 'not_required', candidatePath: null, safeRollbackPath: findLatestSafeRollback(layout.databaseBackups) });
      return status;
    }
    accessSync(layout.database, constants.R_OK | constants.W_OK);
    accessSync(dirname(layout.database), constants.R_OK | constants.W_OK);
    const sourceBytes = statSync(layout.database).size + fileSize(`${layout.database}-wal`) + fileSize(`${layout.database}-shm`);
    const availableBytes = statfsSync(dirname(layout.database)).bavail * statfsSync(dirname(layout.database)).bsize;
    const requiredBytes = Math.max(64 * 1024 * 1024, sourceBytes * 3);
    if (availableBytes < requiredBytes) throw migrationError('ZEUS_CONVERSATION_MIGRATION_SPACE_INSUFFICIENT', `统一会话迁移至少需要 ${requiredBytes} 字节可用空间，当前只有 ${availableBytes} 字节。`);
    checkpointAndValidate(layout.database);

    const recoveryManifest = normalizeSafeRollbackCopy(layout.database, safeRollbackPath);
    chmodSync(safeRollbackPath, 0o600);
    persistStatus({ phase: 'candidate_build' });
    copyFileSync(layout.database, candidatePath);
    chmodSync(candidatePath, 0o600);
    const candidateDb = await createZeusDatabase(candidatePath);
    await candidateDb.save();
    candidateDb.discardAndClose();
    const extractedToolResults = extractLegacyToolResults(candidatePath, layout.conversationToolResults);

    persistStatus({ phase: 'candidate_validation' });
    const validation = validateCandidate(layout.database, candidatePath);
    atomicWriteJson(diagnosticPath, {
      schema: 1,
      migrationId,
      sourceDatabase: layout.database,
      candidateDatabase: candidatePath,
      safeRollbackDatabase: safeRollbackPath,
      recoveryManifest,
      extractedToolResults,
      validation,
      createdAt: new Date().toISOString(),
    });

    persistStatus({ phase: 'promotion' });
    // 提升前再次确认来源和候选都已经把 WAL 收敛进主库，并把旧旁文件移入备份目录。
    // 这样候选主库替换正式路径后，不会误读属于旧主库身份的 -wal / -shm。
    checkpointAndValidate(layout.database);
    checkpointAndValidate(candidatePath);
    const archivedSidecars = [...archiveDatabaseSidecars(layout.database, layout.databaseBackups, `${migrationId}.source`), ...archiveDatabaseSidecars(candidatePath, layout.databaseBackups, `${migrationId}.candidate`)];
    atomicWriteJson(diagnosticPath, {
      schema: 1,
      migrationId,
      sourceDatabase: layout.database,
      candidateDatabase: candidatePath,
      safeRollbackDatabase: safeRollbackPath,
      recoveryManifest,
      extractedToolResults,
      validation,
      archivedSidecars,
      createdAt: new Date().toISOString(),
    });
    // candidate 与正式库位于同一目录；POSIX rename 在同一卷内原子替换目标路径。
    renameSync(candidatePath, layout.database);
    databasePromoted = true;
    chmodSync(layout.database, 0o600);
    checkpointAndValidate(layout.database);
    if (readSchemaGeneration(layout.database) !== conversationSchemaGeneration) throw migrationError('ZEUS_CONVERSATION_MIGRATION_PROMOTION_INVALID', '提升后的数据库结构代次校验失败。');
    persistStatus({ phase: 'completed', candidatePath: null });
    return status;
  } catch (error) {
    const serialized = serializeError(error);
    status = { ...status, phase: databasePromoted ? 'promoted_but_validation_failed' : 'failed', error: serialized, updatedAt: new Date().toISOString() };
    // 权限故障可能同时阻止状态文件落盘；此处尽最大努力保留诊断，但不能用二次写入错误覆盖根因。
    try {
      mkdirSync(layout.databaseBackups, { recursive: true, mode: 0o700 });
      atomicWriteJson(statusPath, status);
      atomicWriteJson(diagnosticPath, { schema: 1, ...status, failure: serialized });
    } catch {
      // Main 仍会通过统一迁移错误码进入维护界面。
    }
    if (serialized.code?.startsWith('ZEUS_CONVERSATION_MIGRATION_')) throw error;
    const wrapped = migrationError('ZEUS_CONVERSATION_MIGRATION_FAILED', serialized.message);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

export function readUnifiedConversationStoreMigrationStatus(layout: ZeusDataLayout): ConversationStoreMigrationStatus | null {
  const path = join(layout.databaseBackups, 'conversation-store-migration-status.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ConversationStoreMigrationStatus;
  } catch {
    return null;
  }
}

function checkpointAndValidate(path: string): void {
  const db = new DatabaseSync(path, { timeout: 5_000 });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Record<string, unknown> | undefined;
    if (Number(checkpoint?.busy ?? 0) !== 0) throw migrationError('ZEUS_CONVERSATION_MIGRATION_DATABASE_BUSY', 'SQLite WAL 仍被其他写入者占用。');
    const quickCheck = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (String(quickCheck?.quick_check ?? '').toLowerCase() !== 'ok') throw migrationError('ZEUS_CONVERSATION_MIGRATION_INTEGRITY_FAILED', 'SQLite quick_check 未通过。');
  } finally {
    db.close();
  }
}

function normalizeSafeRollbackCopy(source: string, destination: string): { interruptedSubmissions: Array<{ id: string; sourceHash: string }> } {
  copyFileSync(source, destination);
  const db = new DatabaseSync(destination, { timeout: 5_000 });
  try {
    const hasSubmissions = Boolean(db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_submissions'`).get());
    if (!hasSubmissions) return { interruptedSubmissions: [] };
    const columns = new Set((db.prepare(`PRAGMA table_info(conversation_submissions)`).all() as Array<{ name: string }>).map((row) => row.name));
    const rows = db
      .prepare(`SELECT id, status${columns.has('paused_reason') ? ', paused_reason' : ''}${columns.has('error_json') ? ', error_json' : ''} FROM conversation_submissions WHERE status IN ('queued', 'dispatching', 'active', 'paused')`)
      .all() as Array<Record<string, unknown>>;
    const interruptedSubmissions = rows.map((row) => ({ id: String(row.id), sourceHash: createHash('sha256').update(JSON.stringify(row)).digest('hex') }));
    if (columns.has('paused_reason')) {
      db.prepare(`UPDATE conversation_submissions SET status = 'paused', paused_reason = 'recovery_required' WHERE status IN ('queued', 'dispatching', 'active', 'paused')`).run();
    } else {
      db.prepare(`UPDATE conversation_submissions SET status = 'failed' WHERE status IN ('queued', 'dispatching', 'active', 'paused')`).run();
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { interruptedSubmissions };
  } finally {
    db.close();
  }
}

function extractLegacyToolResults(candidatePath: string, managedRoot: string): { stored: number; skipped: number } {
  mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  chmodSync(managedRoot, 0o700);
  const db = new DatabaseSync(candidatePath, { timeout: 5_000 });
  let stored = 0;
  let skipped = 0;
  try {
    const segments = db.prepare(`SELECT id, conversation_id, native_session_path FROM conversation_runtime_segments WHERE state = 'sealed' ORDER BY created_at, id`).all() as Array<{
      id: string;
      conversation_id: string;
      native_session_path: string | null;
    }>;
    const segmentByConversation = new Map(segments.map((segment) => [segment.conversation_id, segment]));
    const candidates: Array<{ conversationId: string; segmentId: string; turnId: string; toolPairId: string; text: string; createdAt: string }> = [];
    const hasItems = Boolean(db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_items'`).get());
    if (hasItems) {
      const items = db
        .prepare(
          `SELECT conversation_id, turn_id, provider_item_id, item_type, status, text_content, payload_json,
                  COALESCE(completed_at, updated_at) AS occurred_at
             FROM conversation_items
            WHERE status = 'completed' AND item_type IN ('dynamicToolCall', 'commandExecution', 'tool', 'toolCall')`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const item of items) {
        const conversationId = String(item.conversation_id);
        const segment = segmentByConversation.get(conversationId);
        if (!segment) {
          skipped += 1;
          continue;
        }
        const text = String(item.text_content || item.payload_json || '');
        if (!text) {
          skipped += 1;
          continue;
        }
        candidates.push({
          conversationId,
          segmentId: segment.id,
          turnId: String(item.turn_id),
          toolPairId: `legacy-item:${String(item.provider_item_id)}`,
          text,
          createdAt: String(item.occurred_at),
        });
      }
    }
    for (const segment of segments) {
      if (!segment.native_session_path || !existsSync(segment.native_session_path)) continue;
      try {
        const lines = readFileSync(segment.native_session_path, 'utf8').split(/\r?\n/).filter(Boolean);
        for (let index = 0; index < lines.length; index += 1) {
          const parsed = JSON.parse(lines[index]!) as unknown;
          const tool = piToolResultFromEntry(parsed);
          if (!tool) continue;
          candidates.push({
            conversationId: segment.conversation_id,
            segmentId: segment.id,
            turnId: tool.turnId ?? `legacy-pi-turn:${index}`,
            toolPairId: tool.toolPairId ?? `legacy-pi-tool:${index}`,
            text: tool.text,
            createdAt: tool.createdAt ?? new Date(0).toISOString(),
          });
        }
      } catch {
        // 对应的 provider_history_gap 已由语义迁移记录；工具提取失败不得阻断其他会话。
      }
    }
    const insert = db.prepare(
      `INSERT OR IGNORE INTO conversation_tool_results
       (handle, conversation_id, turn_id, segment_id, tool_pair_id, relative_path, sha256,
        byte_length, mime_type, projection_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'text/plain; charset=utf-8', ?, ?)`,
    );
    for (const candidate of candidates) {
      const duplicate = db.prepare(`SELECT 1 AS present FROM conversation_tool_results WHERE conversation_id = ? AND tool_pair_id = ?`).get(candidate.conversationId, candidate.toolPairId);
      if (duplicate) {
        skipped += 1;
        continue;
      }
      const handle = `conversation_tool_result_${randomUUID().replaceAll('-', '')}`;
      const conversationDirectory = join(managedRoot, createHash('sha256').update(candidate.conversationId).digest('hex'));
      mkdirSync(conversationDirectory, { recursive: true, mode: 0o700 });
      chmodSync(conversationDirectory, 0o700);
      const path = join(conversationDirectory, `${handle}.txt`);
      writeFileSync(path, candidate.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      chmodSync(path, 0o600);
      const bytes = Buffer.from(candidate.text, 'utf8');
      const projection = candidate.text.length <= 16_384 ? candidate.text : `${candidate.text.slice(0, 12_288)}\n\n[迁移结果已截断；使用句柄 ${handle} 分页读取]\n\n${candidate.text.slice(-4_096)}`;
      insert.run(
        handle,
        candidate.conversationId,
        candidate.turnId,
        candidate.segmentId,
        candidate.toolPairId,
        relative(managedRoot, path),
        createHash('sha256').update(bytes).digest('hex'),
        bytes.byteLength,
        JSON.stringify({ text: projection, truncated: projection !== candidate.text }),
        candidate.createdAt,
      );
      stored += 1;
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { stored, skipped };
  } finally {
    db.close();
  }
}

function piToolResultFromEntry(value: unknown): { text: string; toolPairId: string | null; turnId: string | null; createdAt: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const message = entry.message && typeof entry.message === 'object' && !Array.isArray(entry.message) ? (entry.message as Record<string, unknown>) : entry;
  const role = typeof message.role === 'string' ? message.role : typeof entry.type === 'string' ? entry.type : '';
  if (!['toolResult', 'tool_result', 'tool'].includes(role)) return null;
  const text = portableText(message.content ?? message.result ?? message.output);
  if (!text) return null;
  const toolPairId = [message.toolCallId, message.tool_call_id, message.id].find((candidate) => typeof candidate === 'string') as string | undefined;
  const turnId = [message.turnId, message.turn_id, entry.turnId].find((candidate) => typeof candidate === 'string') as string | undefined;
  const timestamp = [message.timestamp, entry.timestamp].find((candidate) => typeof candidate === 'string') as string | undefined;
  return { text, toolPairId: toolPairId ?? null, turnId: turnId ?? null, createdAt: timestamp ?? null };
}

function portableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(portableText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return value === undefined || value === null ? '' : String(value);
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  return JSON.stringify(value);
}

function validateCandidate(sourcePath: string, candidatePath: string): Record<string, unknown> {
  checkpointAndValidate(candidatePath);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const candidate = new DatabaseSync(candidatePath, { readOnly: true });
  try {
    const sourceConversations = count(source, 'conversations');
    const sourceSubmissions = count(source, 'conversation_submissions');
    const candidateConversations = count(candidate, 'conversations');
    const candidateSubmissions = count(candidate, 'conversation_submissions');
    const duplicateCurrent = Number(
      (candidate.prepare(`SELECT COUNT(*) AS count FROM (SELECT conversation_id FROM conversation_runtime_segments WHERE state = 'current' GROUP BY conversation_id HAVING COUNT(*) > 1)`).get() as { count: number }).count,
    );
    const duplicateProvisional = Number(
      (candidate.prepare(`SELECT COUNT(*) AS count FROM (SELECT conversation_id FROM conversation_runtime_segments WHERE state = 'provisional' GROUP BY conversation_id HAVING COUNT(*) > 1)`).get() as { count: number }).count,
    );
    const generation = readSchemaGeneration(candidatePath);
    if (sourceConversations !== candidateConversations || sourceSubmissions !== candidateSubmissions || duplicateCurrent !== 0 || duplicateProvisional !== 0 || generation !== conversationSchemaGeneration) {
      throw migrationError('ZEUS_CONVERSATION_MIGRATION_CANDIDATE_MISMATCH', '统一会话候选库的数量或唯一性校验失败。');
    }
    return {
      sourceConversations,
      candidateConversations,
      sourceSubmissions,
      candidateSubmissions,
      sealedSegments: countWhere(candidate, 'conversation_runtime_segments', `state = 'sealed'`),
      mappings: count(candidate, 'conversation_migration_mappings'),
      persistentWarnings: count(candidate, 'conversation_persistent_warnings'),
      generation,
    };
  } finally {
    source.close();
    candidate.close();
  }
}

function readSchemaGeneration(path: string): string | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_store_metadata'`).get()) return null;
    return String((db.prepare(`SELECT schema_generation FROM conversation_store_metadata WHERE singleton = 1`).get() as { schema_generation?: unknown } | undefined)?.schema_generation ?? '') || null;
  } finally {
    db.close();
  }
}

function count(db: DatabaseSync, table: string): number {
  if (!db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function countWhere(db: DatabaseSync, table: string, where: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count);
}

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function archiveDatabaseSidecars(databasePath: string, backupDirectory: string, archiveIdentity: string): string[] {
  const archived: string[] = [];
  for (const suffix of ['-wal', '-shm']) {
    const source = `${databasePath}${suffix}`;
    if (!existsSync(source)) continue;
    const destination = join(backupDirectory, `conversation-store.${archiveIdentity}${suffix}`);
    renameSync(source, destination);
    chmodSync(destination, 0o600);
    archived.push(destination);
  }
  return archived;
}

function findLatestSafeRollback(directory: string): string | null {
  const statusPath = join(directory, 'conversation-store-migration-status.json');
  if (!existsSync(statusPath)) return null;
  try {
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as ConversationStoreMigrationStatus;
    return status.safeRollbackPath && existsSync(status.safeRollbackPath) ? status.safeRollbackPath : null;
  } catch {
    return null;
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function migrationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function serializeError(error: unknown): { message: string; code: string | null } {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null,
  };
}
