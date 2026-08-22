import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';

export const taskEventFileProjectionSchemaMigrationId = '20260821_031_task_event_file_projection_outbox_v1';

export interface TaskEventFileProjectionRecord {
  taskId: string;
  requestedRevision: number;
  appliedRevision: number;
  appliedEventId: string | null;
  writeStartedRevision: number | null;
  writeStartedEventId: string | null;
  state: 'pending' | 'write_started' | 'accepted';
  lastEventId: string;
  lastErrorJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskEventFileProjectionRow {
  task_id: string;
  requested_revision: number;
  applied_revision: number;
  applied_event_id: string | null;
  write_started_revision: number | null;
  write_started_event_id: string | null;
  state: TaskEventFileProjectionRecord['state'];
  last_event_id: string;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 任务 JSONL/人工日志是 SQLite task_events 的可重建文件投影。
 * requested/applied revision 让提交后消费者可以安全重写，而不是在 COMMIT 前不可回滚地 append。
 */
export function migrateTaskEventFileProjectionSchema(db: ZeusDatabasePort): void {
  const checksumSource = 'task_event_file_projection_outbox:v1:task-owner,requested-applied-revision,write-started-event-cursor,incremental-append,deterministic-recovery-replace';
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [taskEventFileProjectionSchemaMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('任务事件文件投影迁移账本与当前结构不一致。');
    db.execute(`
      CREATE TABLE IF NOT EXISTS task_event_file_projection_outbox (
        task_id TEXT PRIMARY KEY,
        requested_revision INTEGER NOT NULL CHECK (requested_revision >= 1),
        applied_revision INTEGER NOT NULL DEFAULT 0 CHECK (applied_revision >= 0),
        applied_event_id TEXT,
        write_started_revision INTEGER,
        write_started_event_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'write_started', 'accepted')),
        last_event_id TEXT NOT NULL,
        last_error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_event_file_projection_pending ON task_event_file_projection_outbox(state, updated_at, task_id) WHERE state != 'accepted'`);
    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      taskEventFileProjectionSchemaMigrationId,
      '任务事件 JSONL 与人工日志使用耐久提交后文件投影',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

export class TaskEventFileProjectionRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  enqueue(taskId: string, eventId: string, occurredAt: string): TaskEventFileProjectionRecord {
    this.db.execute(
      `INSERT INTO task_event_file_projection_outbox
       (task_id, requested_revision, applied_revision, applied_event_id, write_started_revision, write_started_event_id, state, last_event_id, last_error_json, created_at, updated_at)
       VALUES (?, 1, 0, NULL, NULL, NULL, 'pending', ?, NULL, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         requested_revision = task_event_file_projection_outbox.requested_revision + 1,
         state = CASE WHEN task_event_file_projection_outbox.state = 'write_started' THEN 'write_started' ELSE 'pending' END,
         last_event_id = excluded.last_event_id,
         last_error_json = NULL,
         updated_at = excluded.updated_at`,
      [taskId, eventId, occurredAt, occurredAt],
    );
    return this.require(taskId);
  }

  claim(taskId: string, occurredAt: string): { record: TaskEventFileProjectionRecord; targetRevision: number; targetEventId: string; recoveryNeeded: boolean } | null {
    const current = this.get(taskId);
    if (!current || current.requestedRevision <= current.appliedRevision) return null;
    const targetRevision = current.requestedRevision;
    const targetEventId = current.lastEventId;
    const recoveryNeeded = current.state === 'write_started';
    this.db.durableTransactionSync(() => {
      this.db.execute(
        `UPDATE task_event_file_projection_outbox
         SET state = 'write_started', write_started_revision = ?, write_started_event_id = ?, last_error_json = NULL, updated_at = ?
         WHERE task_id = ? AND requested_revision >= ? AND applied_revision < ?`,
        [targetRevision, targetEventId, occurredAt, taskId, targetRevision, targetRevision],
      );
    });
    const claimed = this.require(taskId);
    return claimed.writeStartedRevision === targetRevision && claimed.writeStartedEventId === targetEventId ? { record: claimed, targetRevision, targetEventId, recoveryNeeded } : null;
  }

  markAccepted(taskId: string, revision: number, eventId: string, occurredAt: string): TaskEventFileProjectionRecord {
    this.db.durableTransactionSync(() => {
      this.db.execute(
        `UPDATE task_event_file_projection_outbox
         SET applied_revision = MAX(applied_revision, ?),
             applied_event_id = CASE WHEN applied_revision <= ? THEN ? ELSE applied_event_id END,
             write_started_revision = NULL,
             write_started_event_id = NULL,
             state = CASE WHEN requested_revision <= ? THEN 'accepted' ELSE 'pending' END,
             last_error_json = NULL,
             updated_at = ?
         WHERE task_id = ?`,
        [revision, revision, eventId, revision, occurredAt, taskId],
      );
    });
    return this.require(taskId);
  }

  markRetryable(taskId: string, revision: number, error: unknown, occurredAt: string): TaskEventFileProjectionRecord {
    const errorJson = boundedErrorJson(error);
    this.db.durableTransactionSync(() => {
      this.db.execute(
        `UPDATE task_event_file_projection_outbox
         SET state = 'write_started', last_error_json = ?, updated_at = ?
         WHERE task_id = ? AND write_started_revision = ?`,
        [errorJson, occurredAt, taskId, revision],
      );
    });
    return this.require(taskId);
  }

  listRecoverableAfter(afterTaskId: string | null, limit = 256): TaskEventFileProjectionRecord[] {
    return this.db
      .select<TaskEventFileProjectionRow>(
        `SELECT * FROM task_event_file_projection_outbox
         WHERE applied_revision < requested_revision AND (? IS NULL OR task_id > ?)
         ORDER BY task_id ASC LIMIT ?`,
        [afterTaskId, afterTaskId, limit],
      )
      .map(mapRow);
  }

  get(taskId: string): TaskEventFileProjectionRecord | null {
    const row = this.db.get<TaskEventFileProjectionRow>(`SELECT * FROM task_event_file_projection_outbox WHERE task_id = ?`, [taskId]);
    return row ? mapRow(row) : null;
  }

  private require(taskId: string): TaskEventFileProjectionRecord {
    const record = this.get(taskId);
    if (!record) throw new Error(`任务事件文件投影不存在：${taskId}`);
    return record;
  }
}

function mapRow(row: TaskEventFileProjectionRow): TaskEventFileProjectionRecord {
  return {
    taskId: row.task_id,
    requestedRevision: row.requested_revision,
    appliedRevision: row.applied_revision,
    appliedEventId: row.applied_event_id,
    writeStartedRevision: row.write_started_revision,
    writeStartedEventId: row.write_started_event_id,
    state: row.state,
    lastEventId: row.last_event_id,
    lastErrorJson: row.last_error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function boundedErrorJson(error: unknown): string {
  const structured = error && typeof error === 'object' ? (error as { code?: unknown; name?: unknown; message?: unknown }) : null;
  const raw =
    error instanceof Error
      ? { code: 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : null, name: error.name.slice(0, 128), message: error.message }
      : structured && typeof structured.message === 'string'
        ? {
            code: typeof structured.code === 'string' || typeof structured.code === 'number' ? structured.code : null,
            name: typeof structured.name === 'string' ? structured.name.slice(0, 128) : 'Error',
            message: structured.message,
          }
        : { code: null, name: typeof error, message: String(error) };
  const bytes = Buffer.from(raw.message, 'utf8');
  const message =
    bytes.byteLength <= 2_048
      ? raw.message
      : `${bytes
          .subarray(0, 2_045)
          .toString('utf8')
          .replace(/\uFFFD$/u, '')}...`;
  return JSON.stringify({ ...raw, code: typeof raw.code === 'string' ? raw.code.slice(0, 128) : raw.code, message });
}
