import { createHash } from 'node:crypto';
import { randomId } from './randomId.js';
import type { SqlValue, ZeusDatabasePort } from './databasePort.js';

function nowIso(): string {
  return new Date().toISOString();
}

function clampPositiveInteger(value: number | undefined | null, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export type RuntimeSessionStatus = 'running' | 'exited' | 'failed' | 'stopped' | 'orphan_detected' | 'lost';
export const runtimeSessionProcessOwningStatuses = ['running', 'orphan_detected'] as const satisfies readonly RuntimeSessionStatus[];

/** 只要持久状态仍可能对应存活进程，恢复和退出都必须保守按“持有进程”处理。 */
export function runtimeSessionMayOwnProcess(status: string): boolean {
  return runtimeSessionProcessOwningStatuses.some((candidate) => candidate === status);
}

export type RuntimeLogStream = 'system' | 'stdout' | 'stderr';
const DEFAULT_RUNTIME_LOG_PROJECTION_BYTES = 4 * 1024 * 1024;
const RUNTIME_LOG_PROJECTION_MARKER_TEXT = '[该轻量日志投影已按约 4 MB 预算省略部分内容；完整历史仍保存在 Runtime。]\n';
const RUNTIME_LOG_ENTRY_INLINE_BYTES = 16 * 1024;
const RUNTIME_LOG_ENTRY_EXTERNAL_MARKER = '\n…[完整命令日志已写入终端文件并在终态登记为 ArtifactRef]…\n';

export interface ZeusRuntimeSessionRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  command: string;
  argsJson: string;
  cwd: string;
  status: RuntimeSessionStatus;
  pid: number | null;
  processIdentityToken: string | null;
  exitCode: number | null;
  summary: string | null;
  favorite: boolean;
  archived: boolean;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ZeusRuntimeLogRecord {
  id: string;
  sessionId: string;
  stream: RuntimeLogStream;
  text: string;
  createdAt: string;
}

export interface CreateRuntimeSessionInput {
  id: string;
  projectId: string;
  taskId?: string;
  command: string;
  args: string[];
  cwd: string;
  status: RuntimeSessionStatus;
  pid?: number;
  startedAt: string;
}

export interface UpdateRuntimeSessionStatusInput {
  status: RuntimeSessionStatus;
  exitCode?: number | null;
  endedAt?: string | null;
  pid?: number | null;
}

export interface AppendRuntimeLogInput {
  id: string;
  sessionId: string;
  stream: RuntimeLogStream;
  text: string;
  createdAt: string;
}

export interface AppendRuntimeLogResult {
  record: ZeusRuntimeLogRecord;
  inserted: boolean;
}

export interface RuntimeSessionListOptions {
  query?: string;
  projectId?: string;
  taskId?: string;
  archived?: boolean;
  favoriteOnly?: boolean;
}

export interface RuntimeLogListOptions {
  query?: string;
  stream?: RuntimeLogStream;
  limit?: number;
  offset?: number;
  /** 命令详情增量读取使用持久化终端序号，避免 OFFSET 在并发追加时漂移。 */
  afterSeq?: number;
  /** 终态首次打开时只读取展示预算内的末尾日志。 */
  tail?: boolean;
  /** 轻量投影的 UTF-8 正文字节预算；不传时保留完整分页语义。 */
  byteBudget?: number;
}

export interface RuntimeLogListResult {
  items: ZeusRuntimeLogRecord[];
  total: number;
  limit: number;
  offset: number;
  afterSeq: number;
  nextSeq: number;
  hasMore: boolean;
  truncated: boolean;
  query: string | null;
  stream: RuntimeLogStream | null;
}

export interface ZeusTerminalEventRecord {
  id: string;
  sessionId: string;
  taskId: string | null;
  seq: number;
  eventType: string;
  content: string;
  rawChunkPath: string | null;
  createdAt: string;
}

export interface AppendTerminalEventInput {
  sessionId: string;
  taskId?: string;
  seq: number;
  eventType: string;
  content: string;
  rawChunkPath?: string;
  createdAt: string;
}

export interface TerminalEventListOptions {
  limit?: number;
  offset?: number;
}

export interface TerminalEventListResult {
  sessionId: string;
  items: ZeusTerminalEventRecord[];
  total: number;
  limit: number;
  offset: number;
}

function assertRuntimeSessionCanBeHidden(session: ZeusRuntimeSessionRecord, operation: 'archive' | 'delete'): void {
  const confirmedTerminal = (session.status === 'exited' || session.status === 'failed' || session.status === 'stopped' || session.status === 'lost') && Boolean(session.endedAt);
  if (confirmedTerminal) return;
  throw Object.assign(new Error(`Runtime session ${session.id} must reach a terminal status before ${operation}.`), {
    code: 'ZEUS_RUNTIME_SESSION_UNFINISHED',
  });
}

/** Runtime 会话仓储保存真实 AI CLI 会话和终端日志，支持 App 重启后恢复列表。 */
export class RuntimeSessionRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  create(input: CreateRuntimeSessionInput): ZeusRuntimeSessionRecord {
    const timestamp = nowIso();
    const record: ZeusRuntimeSessionRecord = {
      id: input.id,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      command: input.command,
      argsJson: JSON.stringify(input.args),
      cwd: input.cwd,
      status: input.status,
      pid: input.pid ?? null,
      processIdentityToken: null,
      exitCode: null,
      summary: null,
      favorite: false,
      archived: false,
      startedAt: input.startedAt,
      endedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    this.db.execute(
      `INSERT OR REPLACE INTO runtime_sessions (id, project_id, task_id, command, args_json, cwd, status, pid, process_identity_token, exit_code, summary, favorite, archived, started_at, ended_at, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.taskId,
        record.command,
        record.argsJson,
        record.cwd,
        record.status,
        record.pid,
        record.processIdentityToken,
        record.exitCode,
        record.summary,
        0,
        0,
        record.startedAt,
        record.endedAt,
        record.createdAt,
        record.updatedAt,
        record.deletedAt,
      ],
    );
    return record;
  }

  updateStatus(sessionId: string, input: UpdateRuntimeSessionStatusInput): ZeusRuntimeSessionRecord {
    const existing = this.getByIdIncludingDeleted(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    const updatedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET status = ?, exit_code = ?, ended_at = ?, pid = COALESCE(?, pid), updated_at = ? WHERE id = ?`, [
      input.status,
      input.exitCode ?? existing.exitCode,
      input.endedAt ?? existing.endedAt,
      input.pid ?? null,
      updatedAt,
      sessionId,
    ]);
    return this.getByIdIncludingDeleted(sessionId)!;
  }

  getById(sessionId: string): ZeusRuntimeSessionRecord | undefined {
    const row = this.db.get<DbRuntimeSessionRow>(runtimeSessionSelectSql(`WHERE id = ? AND deleted_at IS NULL LIMIT 1`), [sessionId]);
    return row ? mapRuntimeSessionRow(row) : undefined;
  }

  /** 启动恢复必须覆盖已归档和软删除记录，不能因可见性过滤漏掉仍在运行的进程。 */
  getByIdIncludingDeleted(sessionId: string): ZeusRuntimeSessionRecord | undefined {
    const row = this.db.get<DbRuntimeSessionRow>(runtimeSessionSelectSql(`WHERE id = ? LIMIT 1`), [sessionId]);
    return row ? mapRuntimeSessionRow(row) : undefined;
  }

  listUnfinishedForRecovery(): ZeusRuntimeSessionRecord[] {
    return this.db.select<DbRuntimeSessionRow>(runtimeSessionSelectSql(`WHERE status IN ('running', 'orphan_detected') ORDER BY started_at, id`)).map(mapRuntimeSessionRow);
  }

  /** 进程身份只能首次写入或幂等重放，禁止替换后把旧进程误认成新进程。 */
  setProcessIdentity(sessionId: string, token: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(token)) {
      throw new Error('ZEUS_RUNTIME_PROCESS_IDENTITY_INVALID');
    }
    const existing = this.getByIdIncludingDeleted(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    if (existing.processIdentityToken && existing.processIdentityToken !== token) {
      throw new Error(`ZEUS_RUNTIME_PROCESS_IDENTITY_CONFLICT: ${sessionId}`);
    }
    if (existing.processIdentityToken === token) return;
    this.db.execute(`UPDATE runtime_sessions SET process_identity_token = ?, updated_at = ? WHERE id = ?`, [token, nowIso(), sessionId]);
  }

  /** 发现仍活动的隐藏记录时先恢复可见性，确保用户能够检查并停止，不能静默留在归档或回收站。 */
  restoreForRecovery(sessionId: string): ZeusRuntimeSessionRecord {
    const existing = this.getByIdIncludingDeleted(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    if (existing.status !== 'running' && existing.status !== 'orphan_detected') {
      throw new Error(`ZEUS_RUNTIME_RECOVERY_NOT_UNFINISHED: ${sessionId}`);
    }
    const updatedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET archived = 0, deleted_at = NULL, updated_at = ? WHERE id = ?`, [updatedAt, sessionId]);
    return this.getById(sessionId)!;
  }

  list(options: RuntimeSessionListOptions = {}): ZeusRuntimeSessionRecord[] {
    const query = options.query?.trim().toLowerCase();
    const queryClause = query
      ? `AND (
           LOWER(command) LIKE ?
           OR LOWER(cwd) LIKE ?
           OR LOWER(COALESCE(summary, '')) LIKE ?
           OR EXISTS (
             SELECT 1 FROM runtime_logs
             WHERE runtime_logs.session_id = runtime_sessions.id
               AND (LOWER(runtime_logs.text) LIKE ? OR LOWER(runtime_logs.stream) LIKE ? OR LOWER(runtime_logs.created_at) LIKE ?)
           )
         )`
      : '';
    const params: SqlValue[] = [options.archived ? 1 : 0, options.projectId ?? null, options.projectId ?? null, options.taskId ?? null, options.taskId ?? null, options.favoriteOnly ? 1 : 0];
    if (query) {
      const like = `%${query}%`;
      params.push(like, like, like, like, like, like);
    }
    return this.db
      .select<DbRuntimeSessionRow>(
        runtimeSessionSelectSql(`WHERE deleted_at IS NULL AND archived = ? AND (? IS NULL OR project_id = ?) AND (? IS NULL OR task_id = ?) AND (? = 0 OR favorite = 1) ${queryClause} ORDER BY started_at DESC, id DESC`),
        params,
      )
      .map(mapRuntimeSessionRow);
  }

  appendLog(input: AppendRuntimeLogInput): AppendRuntimeLogResult {
    const contentSha256 = createHash('sha256').update(input.text).digest('hex');
    const contentByteLength = Buffer.byteLength(input.text, 'utf8');
    const projection = boundedRuntimeLogEntryProjection(input.text);
    const record: ZeusRuntimeLogRecord = {
      id: input.id,
      sessionId: input.sessionId,
      stream: input.stream,
      text: projection.text,
      createdAt: input.createdAt,
    };
    const existingRow = this.db.get<DbRuntimeLogRow>(
      `SELECT id, session_id, stream, text, content_sha256, content_byte_length, projection_truncated, created_at
         FROM runtime_logs WHERE id = ? LIMIT 1`,
      [record.id],
    );
    if (existingRow) {
      const existing = mapRuntimeLogRow(existingRow);
      const sameContent = existingRow.content_sha256 ? existingRow.content_sha256 === contentSha256 && existingRow.content_byte_length === contentByteLength : existingRow.text === input.text;
      if (existing.sessionId !== record.sessionId || existing.stream !== record.stream || !sameContent || existing.createdAt !== record.createdAt) {
        throw new Error(`ZEUS_RUNTIME_LOG_ID_CONFLICT: ${record.id}`);
      }
      return { record: existing, inserted: false };
    }
    this.db.transaction(() => {
      this.db.execute(
        `INSERT INTO runtime_logs
         (id, session_id, stream, text, content_sha256, content_byte_length, projection_truncated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [record.id, record.sessionId, record.stream, record.text, contentSha256, contentByteLength, projection.truncated ? 1 : 0, record.createdAt],
      );
      this.appendTerminalEventFromRuntimeLog(record);
    });
    return { record, inserted: true };
  }

  listLogs(sessionId: string): ZeusRuntimeLogRecord[] {
    return this.db
      .select<DbRuntimeLogRow>(
        `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.text, runtime_logs.created_at
         FROM terminal_events
         INNER JOIN runtime_logs ON runtime_logs.id = substr(terminal_events.id, 16) AND runtime_logs.session_id = terminal_events.session_id
         WHERE terminal_events.session_id = ?
         ORDER BY terminal_events.seq ASC`,
        [sessionId],
      )
      .map(mapRuntimeLogRow);
  }

  /** 高频状态投影先读取长度元数据，再按字节预算取正文，避免巨型日志先进入 Node 堆。 */
  listRecentLogs(sessionId: string, limit = 8, byteBudget = DEFAULT_RUNTIME_LOG_PROJECTION_BYTES): ZeusRuntimeLogRecord[] {
    const boundedLimit = clampPositiveInteger(limit, 8, 1, 2_500);
    const boundedByteBudget = clampPositiveInteger(byteBudget, DEFAULT_RUNTIME_LOG_PROJECTION_BYTES, 1_024, 16 * 1024 * 1024);
    const metadata = this.db.select<DbRuntimeLogMetadataRow>(
      `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.created_at,
              terminal_events.seq AS sequence,
              COALESCE(NULLIF(runtime_logs.content_byte_length, 0), length(CAST(runtime_logs.text AS BLOB))) AS byte_length
         FROM terminal_events
         INNER JOIN runtime_logs ON runtime_logs.id = substr(terminal_events.id, 16) AND runtime_logs.session_id = terminal_events.session_id
         WHERE terminal_events.session_id = ?
         ORDER BY terminal_events.seq DESC
         LIMIT ?`,
      [sessionId, boundedLimit],
    );
    const projection = takeRuntimeLogMetadataWithinBudget(metadata, boundedByteBudget);
    const items = this.listLogsBySequenceRange(sessionId, projection.items);
    if (projection.truncated) items.unshift(createRuntimeLogProjectionMarker(sessionId, metadata[0]?.created_at));
    return items;
  }

  searchLogs(sessionId: string, options: RuntimeLogListOptions = {}): RuntimeLogListResult {
    const query = options.query?.trim() || null;
    const stream = options.stream ?? null;
    const limit = clampPositiveInteger(options.limit, 200, 1, 2_000);
    const offset = clampPositiveInteger(options.offset, 0, 0, 2_147_483_647);
    const afterSeq = clampPositiveInteger(options.afterSeq, 0, 0, Number.MAX_SAFE_INTEGER);
    const byteBudget = options.byteBudget === undefined ? null : clampPositiveInteger(options.byteBudget, DEFAULT_RUNTIME_LOG_PROJECTION_BYTES, 1_024, 16 * 1024 * 1024);
    const clauses = ['terminal_events.session_id = ?'];
    const params: SqlValue[] = [sessionId];
    if (stream) {
      clauses.push('runtime_logs.stream = ?');
      params.push(stream);
    }
    if (query) {
      clauses.push('(LOWER(runtime_logs.text) LIKE ? OR LOWER(runtime_logs.stream) LIKE ? OR LOWER(runtime_logs.created_at) LIKE ?)');
      const like = `%${query.toLowerCase()}%`;
      params.push(like, like, like);
    }
    const whereSql = clauses.join(' AND ');
    const fromSql = `FROM terminal_events
      INNER JOIN runtime_logs ON runtime_logs.id = substr(terminal_events.id, 16) AND runtime_logs.session_id = terminal_events.session_id`;
    const selectSql = `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.text, runtime_logs.created_at, terminal_events.seq AS sequence`;
    // 无筛选时 seq 是会话内持久单调序号，MAX 可直接走 session+seq 索引，避免 1 Hz 轮询反复 COUNT 全历史。
    const total =
      query || stream
        ? (this.db.get<{ count: number }>(`SELECT COUNT(*) AS count ${fromSql} WHERE ${whereSql}`, params)?.count ?? 0)
        : (this.db.get<{ count: number }>(`SELECT COALESCE(MAX(seq), 0) AS count FROM terminal_events WHERE session_id = ?`, [sessionId])?.count ?? 0);

    if (options.tail && byteBudget !== null) {
      const metadata = this.db.select<DbRuntimeLogMetadataRow>(
        `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.created_at,
                terminal_events.seq AS sequence,
                COALESCE(NULLIF(runtime_logs.content_byte_length, 0), length(CAST(runtime_logs.text AS BLOB))) AS byte_length
         ${fromSql} WHERE ${whereSql} ORDER BY terminal_events.seq DESC LIMIT ?`,
        [...params, limit],
      );
      const projection = takeRuntimeLogMetadataWithinBudget(metadata, byteBudget);
      const sequenceClause = runtimeLogSequenceRangeClause(projection.items);
      const rows = sequenceClause ? this.db.select<DbSequencedRuntimeLogRow>(`${selectSql} ${fromSql} WHERE ${whereSql} AND ${sequenceClause.sql} ORDER BY terminal_events.seq ASC`, [...params, ...sequenceClause.params]) : [];
      const items = rows.map(mapRuntimeLogRow);
      if (projection.truncated) items.unshift(createRuntimeLogProjectionMarker(sessionId, metadata[0]?.created_at));
      return {
        items,
        total,
        limit,
        offset: Math.max(0, total - metadata.length),
        afterSeq,
        nextSeq: metadata[0]?.sequence ?? afterSeq,
        hasMore: false,
        truncated: projection.truncated || total > metadata.length,
        query,
        stream,
      };
    }

    if (options.tail) {
      const rows = this.db.select<DbSequencedRuntimeLogRow>(`${selectSql} ${fromSql} WHERE ${whereSql} ORDER BY terminal_events.seq DESC LIMIT ?`, [...params, limit]).reverse();
      const nextSeq = rows.at(-1)?.sequence ?? afterSeq;
      return {
        items: rows.map(mapRuntimeLogRow),
        total,
        limit,
        offset: Math.max(0, total - rows.length),
        afterSeq,
        nextSeq,
        hasMore: false,
        truncated: total > rows.length,
        query,
        stream,
      };
    }

    if (options.afterSeq !== undefined && byteBudget !== null) {
      const metadata = this.db.select<DbRuntimeLogMetadataRow>(
        `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.created_at,
                terminal_events.seq AS sequence,
                COALESCE(NULLIF(runtime_logs.content_byte_length, 0), length(CAST(runtime_logs.text AS BLOB))) AS byte_length
         ${fromSql} WHERE ${whereSql} AND terminal_events.seq > ? ORDER BY terminal_events.seq ASC LIMIT ?`,
        [...params, afterSeq, limit + 1],
      );
      const hasMore = metadata.length > limit;
      const pageMetadata = hasMore ? metadata.slice(0, limit) : metadata;
      const nextSeq = pageMetadata.at(-1)?.sequence ?? afterSeq;
      const projection = takeRuntimeLogMetadataWithinBudget([...pageMetadata].reverse(), byteBudget);
      const sequenceClause = runtimeLogSequenceRangeClause(projection.items);
      const rows = sequenceClause ? this.db.select<DbSequencedRuntimeLogRow>(`${selectSql} ${fromSql} WHERE ${whereSql} AND ${sequenceClause.sql} ORDER BY terminal_events.seq ASC`, [...params, ...sequenceClause.params]) : [];
      const items = rows.map(mapRuntimeLogRow);
      if (projection.truncated) items.unshift(createRuntimeLogProjectionMarker(sessionId, pageMetadata[0]?.created_at));
      return { items, total, limit, offset: 0, afterSeq, nextSeq, hasMore, truncated: projection.truncated, query, stream };
    }

    if (options.afterSeq !== undefined) {
      const rows = this.db.select<DbSequencedRuntimeLogRow>(`${selectSql} ${fromSql} WHERE ${whereSql} AND terminal_events.seq > ? ORDER BY terminal_events.seq ASC LIMIT ?`, [...params, afterSeq, limit + 1]);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const nextSeq = pageRows.at(-1)?.sequence ?? afterSeq;
      return { items: pageRows.map(mapRuntimeLogRow), total, limit, offset: 0, afterSeq, nextSeq, hasMore, truncated: false, query, stream };
    }

    const rows = this.db.select<DbSequencedRuntimeLogRow>(`${selectSql} ${fromSql} WHERE ${whereSql} ORDER BY terminal_events.seq ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return {
      items: rows.map(mapRuntimeLogRow),
      total,
      limit,
      offset,
      afterSeq,
      nextSeq: rows.at(-1)?.sequence ?? afterSeq,
      hasMore: offset + rows.length < total,
      truncated: false,
      query,
      stream,
    };
  }

  private listLogsBySequenceRange(sessionId: string, metadata: DbRuntimeLogMetadataRow[]): ZeusRuntimeLogRecord[] {
    const sequenceClause = runtimeLogSequenceRangeClause(metadata);
    if (!sequenceClause) return [];
    return this.db
      .select<DbRuntimeLogRow>(
        `SELECT runtime_logs.id, runtime_logs.session_id, runtime_logs.stream, runtime_logs.text, runtime_logs.created_at
         FROM terminal_events
         INNER JOIN runtime_logs ON runtime_logs.id = substr(terminal_events.id, 16) AND runtime_logs.session_id = terminal_events.session_id
         WHERE terminal_events.session_id = ? AND ${sequenceClause.sql}
         ORDER BY terminal_events.seq ASC`,
        [sessionId, ...sequenceClause.params],
      )
      .map(mapRuntimeLogRow);
  }

  setFavorite(sessionId: string, favorite: boolean): ZeusRuntimeSessionRecord {
    this.updateFlag(sessionId, 'favorite', favorite);
    return this.getById(sessionId)!;
  }

  archive(sessionId: string): ZeusRuntimeSessionRecord {
    const existing = this.getById(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    assertRuntimeSessionCanBeHidden(existing, 'archive');
    this.updateFlag(sessionId, 'archived', true);
    return this.getById(sessionId)!;
  }

  restore(sessionId: string): ZeusRuntimeSessionRecord {
    this.updateFlag(sessionId, 'archived', false);
    return this.getById(sessionId)!;
  }

  delete(sessionId: string): ZeusRuntimeSessionRecord {
    const existing = this.getById(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    assertRuntimeSessionCanBeHidden(existing, 'delete');
    const deletedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET deleted_at = ?, updated_at = ? WHERE id = ?`, [deletedAt, deletedAt, sessionId]);
    return { ...existing, deletedAt, updatedAt: deletedAt };
  }

  /**
   * 只返回没有任务归属、未收藏、已归档或已删除且早于保留边界的终态会话。
   * 活动会话和任务证据默认豁免，避免把“到期”误当成可以删除业务历史。
   */
  listLogRetentionCandidates(cutoff: string): ZeusRuntimeSessionRecord[] {
    return this.db
      .select<DbRuntimeSessionRow>(
        runtimeSessionSelectSql(
          `WHERE task_id IS NULL
             AND favorite = 0
             AND status IN ('exited', 'failed', 'stopped', 'lost')
             AND ended_at IS NOT NULL
             AND (archived = 1 OR deleted_at IS NOT NULL)
             AND COALESCE(ended_at, updated_at) < ?
             AND (EXISTS (SELECT 1 FROM runtime_logs WHERE runtime_logs.session_id = runtime_sessions.id)
               OR EXISTS (SELECT 1 FROM terminal_events WHERE terminal_events.session_id = runtime_sessions.id))
           ORDER BY COALESCE(ended_at, updated_at), id`,
        ),
        [cutoff],
      )
      .map(mapRuntimeSessionRow);
  }

  purgeRetainedLogs(sessionId: string): { runtimeLogCount: number; terminalEventCount: number } {
    const runtimeLogCount = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM runtime_logs WHERE session_id = ?`, [sessionId])?.count ?? 0;
    const terminalEventCount = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM terminal_events WHERE session_id = ?`, [sessionId])?.count ?? 0;
    this.db.execute(`DELETE FROM runtime_logs WHERE session_id = ?`, [sessionId]);
    this.db.execute(`DELETE FROM terminal_events WHERE session_id = ?`, [sessionId]);
    return { runtimeLogCount, terminalEventCount };
  }

  generateSummary(sessionId: string): ZeusRuntimeSessionRecord {
    const existing = this.getById(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    const realLogs: string[] = [];
    let afterSeq = 0;
    let remainingCharacters = 500;
    while (remainingCharacters > 0) {
      const rows = this.db.select<{ sequence: number; excerpt: string }>(
        `SELECT terminal_events.seq AS sequence, substr(trim(runtime_logs.text), 1, 500) AS excerpt
           FROM terminal_events
           INNER JOIN runtime_logs ON runtime_logs.id = substr(terminal_events.id, 16) AND runtime_logs.session_id = terminal_events.session_id
          WHERE terminal_events.session_id = ? AND terminal_events.seq > ? AND length(trim(runtime_logs.text)) > 0
          ORDER BY terminal_events.seq ASC
          LIMIT 32`,
        [sessionId, afterSeq],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const separatorLength = realLogs.length > 0 ? 1 : 0;
        const available = remainingCharacters - separatorLength;
        if (available <= 0) {
          remainingCharacters = 0;
          break;
        }
        realLogs.push(row.excerpt.slice(0, available));
        remainingCharacters -= separatorLength + Math.min(row.excerpt.length, available);
        afterSeq = row.sequence;
        if (remainingCharacters <= 0) break;
      }
      if (rows.length < 32) break;
    }
    // 摘要只能来自真实 Runtime 日志；没有日志时保持 null，由 UI 展示“未生成摘要”。
    const summary = realLogs.length > 0 ? realLogs.join('\n') : null;
    const updatedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET summary = ?, updated_at = ? WHERE id = ?`, [summary, updatedAt, sessionId]);
    return this.getById(sessionId)!;
  }

  private updateFlag(sessionId: string, column: 'favorite' | 'archived', enabled: boolean): void {
    const existing = this.getById(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    const updatedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET ${column} = ?, updated_at = ? WHERE id = ?`, [enabled ? 1 : 0, updatedAt, sessionId]);
  }

  /** Runtime 日志同时镜像成 terminal_events，保证设计书要求的终端回放表有真实写入来源。 */
  private appendTerminalEventFromRuntimeLog(record: ZeusRuntimeLogRecord): void {
    const session = this.getById(record.sessionId);
    const nextSeq = this.db.get<{ next_seq: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM terminal_events WHERE session_id = ?`, [record.sessionId])?.next_seq ?? 1;
    this.db.execute(
      `INSERT INTO terminal_events (id, session_id, task_id, seq, event_type, content, raw_chunk_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      // 正文只保存在 runtime_logs；terminal_events 保留稳定序号和引用，读取回放时再关联正文。
      [`terminal_event_${record.id}`, record.sessionId, session?.taskId ?? null, nextSeq, record.stream, '', null, record.createdAt],
    );
  }
}

function takeRuntimeLogMetadataWithinBudget(metadata: DbRuntimeLogMetadataRow[], byteBudget: number): { items: DbRuntimeLogMetadataRow[]; truncated: boolean } {
  const markerBytes = Buffer.byteLength(RUNTIME_LOG_PROJECTION_MARKER_TEXT, 'utf8');
  let remainingBytes = Math.max(0, byteBudget - markerBytes);
  const items: DbRuntimeLogMetadataRow[] = [];
  for (const entry of metadata) {
    if (entry.byte_length > remainingBytes) return { items, truncated: true };
    items.push(entry);
    remainingBytes -= entry.byte_length;
  }
  return { items, truncated: false };
}

function boundedRuntimeLogEntryProjection(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= RUNTIME_LOG_ENTRY_INLINE_BYTES) return { text, truncated: false };
  const markerBytes = Buffer.byteLength(RUNTIME_LOG_ENTRY_EXTERNAL_MARKER, 'utf8');
  const sideBudget = Math.max(256, Math.floor((RUNTIME_LOG_ENTRY_INLINE_BYTES - markerBytes) / 2));
  const characters = Array.from(text);
  let prefix = '';
  let prefixBytes = 0;
  let prefixCount = 0;
  while (prefixCount < characters.length) {
    const character = characters[prefixCount];
    const bytes = Buffer.byteLength(character, 'utf8');
    if (prefixBytes + bytes > sideBudget) break;
    prefix += character;
    prefixBytes += bytes;
    prefixCount += 1;
  }
  const suffix: string[] = [];
  let suffixBytes = 0;
  for (let index = characters.length - 1; index >= prefixCount; index -= 1) {
    const character = characters[index];
    const bytes = Buffer.byteLength(character, 'utf8');
    if (suffixBytes + bytes > sideBudget) break;
    suffix.push(character);
    suffixBytes += bytes;
  }
  return { text: `${prefix}${RUNTIME_LOG_ENTRY_EXTERNAL_MARKER}${suffix.reverse().join('')}`, truncated: true };
}

function runtimeLogSequenceRangeClause(metadata: DbRuntimeLogMetadataRow[]): { sql: string; params: SqlValue[] } | null {
  if (metadata.length === 0) return null;
  const sequences = metadata.map((entry) => entry.sequence);
  return { sql: 'terminal_events.seq BETWEEN ? AND ?', params: [Math.min(...sequences), Math.max(...sequences)] };
}

function createRuntimeLogProjectionMarker(sessionId: string, createdAt?: string): ZeusRuntimeLogRecord {
  return {
    id: `runtime_log_projection_marker_${sessionId}`,
    sessionId,
    stream: 'system',
    text: RUNTIME_LOG_PROJECTION_MARKER_TEXT,
    createdAt: createdAt ?? nowIso(),
  };
}

/** 终端事件仓储按 session+seq 持久化真实输出，后续可支撑 PTY 回放与审计。 */
export class TerminalEventRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  append(input: AppendTerminalEventInput): ZeusTerminalEventRecord {
    const record: ZeusTerminalEventRecord = {
      id: `terminal_event_${randomId(12)}`,
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      seq: input.seq,
      eventType: input.eventType,
      content: input.content,
      rawChunkPath: input.rawChunkPath ?? null,
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO terminal_events (id, session_id, task_id, seq, event_type, content, raw_chunk_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.sessionId, record.taskId, record.seq, record.eventType, record.content, record.rawChunkPath, record.createdAt],
    );
    return record;
  }

  listBySession(sessionId: string): ZeusTerminalEventRecord[] {
    return this.db
      .select<DbTerminalEventRow>(
        `SELECT terminal_events.id, terminal_events.session_id, terminal_events.task_id, terminal_events.seq,
                terminal_events.event_type, COALESCE(runtime_logs.text, terminal_events.content) AS content,
                terminal_events.raw_chunk_path, terminal_events.created_at
           FROM terminal_events
           LEFT JOIN runtime_logs
             ON terminal_events.id = 'terminal_event_' || runtime_logs.id
            AND terminal_events.session_id = runtime_logs.session_id
          WHERE terminal_events.session_id = ?
          ORDER BY terminal_events.seq ASC, terminal_events.created_at ASC`,
        [sessionId],
      )
      .map(mapTerminalEventRow);
  }

  /** 按 session 和 seq 做稳定 SQL 分页，避免终端长会话回放时一次性加载全量事件。 */
  listBySessionPage(sessionId: string, options: TerminalEventListOptions = {}): TerminalEventListResult {
    const limit = clampPositiveInteger(options.limit, 200, 1, 1_000);
    const offset = clampPositiveInteger(options.offset, 0, 0, 2_147_483_647);
    const total = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM terminal_events WHERE session_id = ?`, [sessionId])?.count ?? 0;
    const items = this.db
      .select<DbTerminalEventRow>(
        `SELECT terminal_events.id, terminal_events.session_id, terminal_events.task_id, terminal_events.seq,
                terminal_events.event_type, COALESCE(runtime_logs.text, terminal_events.content) AS content,
                terminal_events.raw_chunk_path, terminal_events.created_at
           FROM terminal_events
           LEFT JOIN runtime_logs
             ON terminal_events.id = 'terminal_event_' || runtime_logs.id
            AND terminal_events.session_id = runtime_logs.session_id
          WHERE terminal_events.session_id = ?
          ORDER BY terminal_events.seq ASC, terminal_events.created_at ASC
          LIMIT ? OFFSET ?`,
        [sessionId, limit, offset],
      )
      .map(mapTerminalEventRow);
    return { sessionId, items, total, limit, offset };
  }

  /** 为 runtime log 镜像出的 terminal event 补充 chunk 文件路径，让 SQLite 索引能指向大文本文件。 */
  setRawChunkPathByRuntimeLogId(runtimeLogId: string, rawChunkPath: string): void {
    this.db.execute(`UPDATE terminal_events SET raw_chunk_path = ? WHERE id = ?`, [rawChunkPath, `terminal_event_${runtimeLogId}`]);
  }
}

interface DbRuntimeSessionRow {
  id: string;
  project_id: string;
  task_id: string | null;
  command: string;
  args_json: string;
  cwd: string;
  status: RuntimeSessionStatus;
  pid: number | null;
  process_identity_token: string | null;
  exit_code: number | null;
  summary: string | null;
  favorite: number;
  archived: number;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface DbRuntimeLogRow {
  id: string;
  session_id: string;
  stream: RuntimeLogStream;
  text: string;
  content_sha256?: string | null;
  content_byte_length?: number;
  projection_truncated?: number;
  created_at: string;
}

interface DbSequencedRuntimeLogRow extends DbRuntimeLogRow {
  sequence: number;
}

interface DbRuntimeLogMetadataRow {
  id: string;
  session_id: string;
  stream: RuntimeLogStream;
  created_at: string;
  sequence: number;
  byte_length: number;
}

interface DbTerminalEventRow {
  id: string;
  session_id: string;
  task_id: string | null;
  seq: number;
  event_type: string;
  content: string;
  raw_chunk_path: string | null;
  created_at: string;
}

function mapRuntimeSessionRow(row: DbRuntimeSessionRow): ZeusRuntimeSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    command: row.command,
    argsJson: row.args_json,
    cwd: row.cwd,
    status: row.status,
    pid: row.pid,
    processIdentityToken: row.process_identity_token,
    exitCode: row.exit_code,
    summary: row.summary,
    favorite: row.favorite === 1,
    archived: row.archived === 1,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function runtimeSessionSelectSql(whereClause: string): string {
  return `SELECT id, project_id, task_id, command, args_json, cwd, status, pid, process_identity_token, exit_code, summary, favorite, archived, started_at, ended_at, created_at, updated_at, deleted_at
          FROM runtime_sessions ${whereClause}`;
}

function mapRuntimeLogRow(row: DbRuntimeLogRow): ZeusRuntimeLogRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    stream: row.stream,
    text: row.text,
    createdAt: row.created_at,
  };
}

function mapTerminalEventRow(row: DbTerminalEventRow): ZeusTerminalEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    seq: row.seq,
    eventType: row.event_type,
    content: row.content,
    rawChunkPath: row.raw_chunk_path,
    createdAt: row.created_at,
  };
}
