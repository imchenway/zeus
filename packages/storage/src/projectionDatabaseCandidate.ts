import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ZeusDatabasePort } from './databasePort.js';

export const projectionIndexCandidateGeneration = '2026-08-21-projection-index-runtime-v2';
export const projectionCacheCandidateGeneration = '2026-08-21-projection-cache-runtime-v2';

export type ProjectionDatabaseCandidateErrorCode =
  | 'ZEUS_PROJECTION_CANDIDATE_INVALID_PATH'
  | 'ZEUS_PROJECTION_CANDIDATE_ALREADY_EXISTS'
  | 'ZEUS_PROJECTION_CANDIDATE_SOURCE_INVALID'
  | 'ZEUS_PROJECTION_CANDIDATE_BUILD_FAILED'
  | 'ZEUS_PROJECTION_CANDIDATE_INTEGRITY_FAILED';

export class ProjectionDatabaseCandidateError extends Error {
  readonly name = 'ProjectionDatabaseCandidateError';

  constructor(
    readonly code: ProjectionDatabaseCandidateErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export interface ProjectionDatabaseCandidateReceipt {
  candidateKind: 'index' | 'cache';
  candidatePath: string;
  generationId: string;
  sourceDatabaseIdentity: string;
  fileSha256: string;
  byteLength: number;
  quickCheck: 'ok';
  rebuildable: true;
  published: false;
  counts: Record<string, number>;
  gaps: string[];
  createdAt: string;
}

interface ConversationProjectionRow {
  id: string;
  project_id: string;
  task_id: string | null;
  title: string;
  status: string;
  stage: string;
  archived: number;
  transport_kind: string;
  agent_kind: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnProjectionRow {
  id: string;
  conversation_id: string;
  provider_turn_id: string | null;
  client_submission_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface WatermarkRow {
  conversation_id: string;
  timeline_sequence: number;
  model_history_sequence: number;
  process_sequence: number;
  model_request_sequence: number;
  sync_event_sequence: number;
}

interface GenericProjectionRow {
  [key: string]: unknown;
}

const maximumIdentityLength = 512;

/**
 * 从当前 Core 读模型构建完全可丢弃的 index.db 候选。
 * 该函数强制使用 *.index.candidate.db 新文件，不包含 rename/promote 或运行态切换入口。
 */
export async function createProjectionIndexCandidate(input: { source: ZeusDatabasePort; candidatePath: string; generationId: string; sourceDatabaseIdentity: string; createdAt?: string }): Promise<ProjectionDatabaseCandidateReceipt> {
  const candidatePath = await validateCandidatePath(input.candidatePath, 'index');
  const generationId = normalizeIdentity(input.generationId, 'generationId');
  const sourceDatabaseIdentity = normalizeIdentity(input.sourceDatabaseIdentity, 'sourceDatabaseIdentity');
  const createdAt = normalizeTimestamp(input.createdAt ?? new Date().toISOString());
  const temporaryPath = `${candidatePath}.partial-${randomUUID()}`;
  const gaps: string[] = [];
  const counts: Record<string, number> = {};
  let candidate: DatabaseSync | null = null;

  try {
    const conversations = input.source.select<ConversationProjectionRow>(
      `SELECT id, project_id, task_id, title, status, stage, archived, transport_kind, agent_kind, created_at, updated_at
         FROM conversations
        ORDER BY id`,
    );
    const turns = input.source.select<TurnProjectionRow>(
      `SELECT id, conversation_id, provider_turn_id, client_submission_id, status, created_at, updated_at
         FROM conversation_turns
        ORDER BY conversation_id, created_at, id`,
    );
    const watermarks = input.source.select<WatermarkRow>(
      `SELECT counters.conversation_id,
              counters.timeline_sequence,
              counters.model_history_sequence,
              counters.process_sequence,
              counters.model_request_sequence,
              COALESCE(stream.latest_sequence, 0) AS sync_event_sequence
         FROM conversation_sequence_counters AS counters
         LEFT JOIN conversation_sync_event_streams AS stream
           ON stream.conversation_id = counters.conversation_id AND stream.is_current = 1
        ORDER BY counters.conversation_id`,
    );
    const graphNodes = sourceTableExists(input.source, 'project_nodes') ? input.source.select<GenericProjectionRow>(`SELECT * FROM project_nodes ORDER BY id`) : [];
    const graphEdges = sourceTableExists(input.source, 'project_edges') ? input.source.select<GenericProjectionRow>(`SELECT * FROM project_edges ORDER BY id`) : [];
    const codeSymbols = sourceTableExists(input.source, 'code_symbols') ? input.source.select<GenericProjectionRow>(`SELECT * FROM code_symbols ORDER BY id`) : [];
    const graphViews = sourceTableExists(input.source, 'graph_views') ? input.source.select<GenericProjectionRow>(`SELECT * FROM graph_views ORDER BY id`) : [];
    if (!sourceTableExists(input.source, 'project_nodes')) gaps.push('source_table_missing:project_nodes');
    if (!sourceTableExists(input.source, 'project_edges')) gaps.push('source_table_missing:project_edges');
    if (!sourceTableExists(input.source, 'code_symbols')) gaps.push('source_table_missing:code_symbols');
    if (!sourceTableExists(input.source, 'graph_views')) gaps.push('source_table_missing:graph_views');

    candidate = new DatabaseSync(temporaryPath);
    configureCandidate(candidate);
    createIndexCandidateSchema(candidate);
    candidate.exec('BEGIN IMMEDIATE');
    try {
      candidate
        .prepare(
          `INSERT INTO projection_metadata
           (singleton, candidate_kind, structure_generation, generation_id, source_database_identity, rebuildable, publication_state, created_at)
           VALUES (1, 'index', ?, ?, ?, 1, 'candidate_only', ?)`,
        )
        .run(projectionIndexCandidateGeneration, generationId, sourceDatabaseIdentity, createdAt);
      const conversationInsert = candidate.prepare(
        `INSERT INTO conversation_search_documents
         (conversation_id, project_id, task_id, title, normalized_title, status, stage, archived, transport_kind, agent_kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ftsInsert = candidate.prepare(`INSERT INTO conversation_search_fts (conversation_id, project_id, title) VALUES (?, ?, ?)`);
      for (const row of conversations) {
        conversationInsert.run(row.id, row.project_id, row.task_id, boundedText(row.title, 4_096), normalizeSearchText(row.title), row.status, row.stage, row.archived, row.transport_kind, row.agent_kind, row.created_at, row.updated_at);
        ftsInsert.run(row.id, row.project_id, boundedText(row.title, 4_096));
      }
      const turnInsert = candidate.prepare(
        `INSERT INTO conversation_turn_documents
         (turn_id, conversation_id, provider_turn_id, submission_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of turns) turnInsert.run(row.id, row.conversation_id, row.provider_turn_id, row.client_submission_id, row.status, row.created_at, row.updated_at);
      const watermarkInsert = candidate.prepare(
        `INSERT INTO conversation_projection_watermarks
         (conversation_id, timeline_sequence, model_history_sequence, process_sequence, model_request_sequence, sync_event_sequence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const row of watermarks) watermarkInsert.run(row.conversation_id, row.timeline_sequence, row.model_history_sequence, row.process_sequence, row.model_request_sequence, row.sync_event_sequence);
      insertGenericProjectionRows(candidate, 'graph_node_documents', 'project_nodes', graphNodes);
      insertGenericProjectionRows(candidate, 'graph_edge_documents', 'project_edges', graphEdges);
      insertGenericProjectionRows(candidate, 'code_symbol_documents', 'code_symbols', codeSymbols);
      insertGenericProjectionRows(candidate, 'graph_node_documents', 'graph_views', graphViews);
      for (const gap of gaps) candidate.prepare(`INSERT INTO projection_gaps (gap_kind, detail, observed_at) VALUES ('source_capability', ?, ?)`).run(gap, createdAt);
      const sourceWaterline = watermarks.reduce((maximum, row) => Math.max(maximum, row.sync_event_sequence), 0);
      candidate.prepare(`UPDATE projection_metadata SET event_waterline = ? WHERE singleton = 1`).run(sourceWaterline);
      candidate.exec('COMMIT');
    } catch (error) {
      candidate.exec('ROLLBACK');
      throw error;
    }
    counts.conversations = conversations.length;
    counts.turns = turns.length;
    counts.watermarks = watermarks.length;
    counts.graphNodes = graphNodes.length;
    counts.graphEdges = graphEdges.length;
    counts.codeSymbols = codeSymbols.length;
    counts.graphViews = graphViews.length;
    assertCandidateQuickCheck(candidate, 'index.db 候选');
    candidate.close();
    candidate = null;
    await chmod(temporaryPath, 0o600);
    await publishCandidateOnly(temporaryPath, candidatePath);
    return candidateReceipt({ candidateKind: 'index', candidatePath, generationId, sourceDatabaseIdentity, counts, gaps, createdAt });
  } catch (error) {
    candidate?.close();
    await safeUnlink(temporaryPath);
    if (error instanceof ProjectionDatabaseCandidateError) throw error;
    throw candidateError('ZEUS_PROJECTION_CANDIDATE_BUILD_FAILED', '构建 index.db 候选失败。', error);
  }
}

/** 创建空的、可随时删除重建的 cache.db 候选；不复制任何业务真相。 */
export async function createProjectionCacheCandidate(input: { candidatePath: string; generationId: string; sourceDatabaseIdentity: string; createdAt?: string }): Promise<ProjectionDatabaseCandidateReceipt> {
  const candidatePath = await validateCandidatePath(input.candidatePath, 'cache');
  const generationId = normalizeIdentity(input.generationId, 'generationId');
  const sourceDatabaseIdentity = normalizeIdentity(input.sourceDatabaseIdentity, 'sourceDatabaseIdentity');
  const createdAt = normalizeTimestamp(input.createdAt ?? new Date().toISOString());
  const temporaryPath = `${candidatePath}.partial-${randomUUID()}`;
  let candidate: DatabaseSync | null = null;
  try {
    candidate = new DatabaseSync(temporaryPath);
    configureCandidate(candidate);
    candidate.exec(`
      CREATE TABLE cache_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        candidate_kind TEXT NOT NULL CHECK (candidate_kind = 'cache'),
        structure_generation TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        source_database_identity TEXT NOT NULL,
        rebuildable INTEGER NOT NULL CHECK (rebuildable = 1),
        publication_state TEXT NOT NULL CHECK (publication_state IN ('candidate_only', 'active')),
        event_waterline INTEGER NOT NULL DEFAULT 0 CHECK (event_waterline >= 0),
        activated_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE cache_entries (
        namespace TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        payload BLOB NOT NULL,
        byte_length INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        PRIMARY KEY (namespace, cache_key, generation_id)
      );
      CREATE INDEX idx_cache_entries_expiry ON cache_entries(expires_at, namespace, cache_key);
    `);
    candidate
      .prepare(
        `INSERT INTO cache_metadata
         (singleton, candidate_kind, structure_generation, generation_id, source_database_identity, rebuildable, publication_state, event_waterline, activated_at, created_at)
         VALUES (1, 'cache', ?, ?, ?, 1, 'candidate_only', 0, NULL, ?)`,
      )
      .run(projectionCacheCandidateGeneration, generationId, sourceDatabaseIdentity, createdAt);
    assertCandidateQuickCheck(candidate, 'cache.db 候选');
    candidate.close();
    candidate = null;
    await chmod(temporaryPath, 0o600);
    await publishCandidateOnly(temporaryPath, candidatePath);
    return candidateReceipt({ candidateKind: 'cache', candidatePath, generationId, sourceDatabaseIdentity, counts: { entries: 0 }, gaps: [], createdAt });
  } catch (error) {
    candidate?.close();
    await safeUnlink(temporaryPath);
    if (error instanceof ProjectionDatabaseCandidateError) throw error;
    throw candidateError('ZEUS_PROJECTION_CANDIDATE_BUILD_FAILED', '构建 cache.db 候选失败。', error);
  }
}

export async function verifyProjectionDatabaseCandidate(
  receipt: Pick<ProjectionDatabaseCandidateReceipt, 'candidateKind' | 'candidatePath' | 'generationId' | 'sourceDatabaseIdentity' | 'fileSha256'>,
): Promise<{ valid: true; quickCheck: 'ok'; byteLength: number }> {
  const path = resolve(receipt.candidatePath);
  const metadata = await lstat(path).catch((error: unknown) => {
    throw candidateError('ZEUS_PROJECTION_CANDIDATE_INTEGRITY_FAILED', '投影数据库候选不存在。', error);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw candidateError('ZEUS_PROJECTION_CANDIDATE_INTEGRITY_FAILED', '投影数据库候选不是安全普通文件。');
  const fileHash = sha256(await readFile(path));
  if (fileHash !== receipt.fileSha256) throw candidateError('ZEUS_PROJECTION_CANDIDATE_INTEGRITY_FAILED', '投影数据库候选文件哈希不匹配。');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assertCandidateQuickCheck(db, `${receipt.candidateKind}.db 候选`);
    const table = receipt.candidateKind === 'index' ? 'projection_metadata' : 'cache_metadata';
    const row = db.prepare(`SELECT generation_id, source_database_identity, publication_state, rebuildable FROM ${table} WHERE singleton = 1`).get() as
      | { generation_id: string; source_database_identity: string; publication_state: string; rebuildable: number }
      | undefined;
    if (!row || row.generation_id !== receipt.generationId || row.source_database_identity !== receipt.sourceDatabaseIdentity || row.publication_state !== 'candidate_only' || row.rebuildable !== 1) {
      throw candidateError('ZEUS_PROJECTION_CANDIDATE_INTEGRITY_FAILED', '投影数据库候选身份或候选态契约不匹配。');
    }
  } finally {
    db.close();
  }
  return { valid: true, quickCheck: 'ok', byteLength: metadata.size };
}

function createIndexCandidateSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE projection_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      candidate_kind TEXT NOT NULL CHECK (candidate_kind = 'index'),
      structure_generation TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      source_database_identity TEXT NOT NULL,
      rebuildable INTEGER NOT NULL CHECK (rebuildable = 1),
      publication_state TEXT NOT NULL CHECK (publication_state IN ('candidate_only', 'active')),
      event_waterline INTEGER NOT NULL DEFAULT 0 CHECK (event_waterline >= 0),
      activated_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE conversation_search_documents (
      conversation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      archived INTEGER NOT NULL,
      transport_kind TEXT NOT NULL,
      agent_kind TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_projection_conversations_project ON conversation_search_documents(project_id, archived, updated_at DESC, conversation_id);
    CREATE INDEX idx_projection_conversations_task ON conversation_search_documents(task_id, updated_at DESC, conversation_id) WHERE task_id IS NOT NULL;
    CREATE VIRTUAL TABLE conversation_search_fts USING fts5(conversation_id UNINDEXED, project_id UNINDEXED, title, tokenize = 'unicode61');
    CREATE TABLE conversation_turn_documents (
      turn_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      provider_turn_id TEXT,
      submission_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_projection_turns_conversation ON conversation_turn_documents(conversation_id, updated_at DESC, turn_id);
    CREATE TABLE conversation_projection_watermarks (
      conversation_id TEXT PRIMARY KEY,
      timeline_sequence INTEGER NOT NULL,
      model_history_sequence INTEGER NOT NULL,
      process_sequence INTEGER NOT NULL,
      model_request_sequence INTEGER NOT NULL,
      sync_event_sequence INTEGER NOT NULL
    );
    CREATE TABLE graph_node_documents (
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      project_id TEXT,
      kind TEXT,
      label TEXT,
      updated_at TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (source_table, source_id)
    );
    CREATE INDEX idx_projection_graph_nodes_project ON graph_node_documents(project_id, kind, source_id);
    CREATE TABLE graph_edge_documents (
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      project_id TEXT,
      kind TEXT,
      label TEXT,
      updated_at TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (source_table, source_id)
    );
    CREATE INDEX idx_projection_graph_edges_project ON graph_edge_documents(project_id, kind, source_id);
    CREATE TABLE code_symbol_documents (
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      project_id TEXT,
      kind TEXT,
      label TEXT,
      updated_at TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (source_table, source_id)
    );
    CREATE INDEX idx_projection_code_symbols_project ON code_symbol_documents(project_id, kind, source_id);
    CREATE TABLE projection_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gap_kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE VIEW code_symbols AS
      SELECT source_id AS id,
             json_extract(payload_json, '$.project_name') AS project_name,
             json_extract(payload_json, '$.symbol_type') AS symbol_type,
             json_extract(payload_json, '$.name') AS name,
             json_extract(payload_json, '$.qualified_name') AS qualified_name,
             json_extract(payload_json, '$.file_path') AS file_path,
             CAST(json_extract(payload_json, '$.line_start') AS INTEGER) AS line_start,
             CAST(json_extract(payload_json, '$.line_end') AS INTEGER) AS line_end,
             json_extract(payload_json, '$.language') AS language,
             json_extract(payload_json, '$.metadata_json') AS metadata_json,
             json_extract(payload_json, '$.source_hash') AS source_hash
        FROM code_symbol_documents WHERE source_table = 'code_symbols';
    CREATE TRIGGER code_symbols_insert INSTEAD OF INSERT ON code_symbols BEGIN
      INSERT INTO code_symbol_documents (source_table, source_id, project_id, kind, label, updated_at, payload_json)
      VALUES ('code_symbols', NEW.id, NEW.project_name, NEW.symbol_type, NEW.name, NULL,
        json_object('id', NEW.id, 'project_name', NEW.project_name, 'symbol_type', NEW.symbol_type, 'name', NEW.name,
          'qualified_name', NEW.qualified_name, 'file_path', NEW.file_path, 'line_start', NEW.line_start,
          'line_end', NEW.line_end, 'language', NEW.language, 'metadata_json', NEW.metadata_json, 'source_hash', NEW.source_hash));
    END;
    CREATE TRIGGER code_symbols_delete INSTEAD OF DELETE ON code_symbols BEGIN
      DELETE FROM code_symbol_documents WHERE source_table = 'code_symbols' AND source_id = OLD.id;
    END;
    CREATE VIEW project_nodes AS
      SELECT source_id AS id,
             json_extract(payload_json, '$.project_name') AS project_name,
             json_extract(payload_json, '$.node_type') AS node_type,
             json_extract(payload_json, '$.name') AS name,
             json_extract(payload_json, '$.qualified_name') AS qualified_name,
             json_extract(payload_json, '$.source_ref') AS source_ref,
             json_extract(payload_json, '$.symbol_id') AS symbol_id,
             json_extract(payload_json, '$.metadata_json') AS metadata_json
        FROM graph_node_documents WHERE source_table = 'project_nodes';
    CREATE TRIGGER project_nodes_insert INSTEAD OF INSERT ON project_nodes BEGIN
      INSERT INTO graph_node_documents (source_table, source_id, project_id, kind, label, updated_at, payload_json)
      VALUES ('project_nodes', NEW.id, NEW.project_name, NEW.node_type, NEW.name, NULL,
        json_object('id', NEW.id, 'project_name', NEW.project_name, 'node_type', NEW.node_type, 'name', NEW.name,
          'qualified_name', NEW.qualified_name, 'source_ref', NEW.source_ref, 'symbol_id', NEW.symbol_id, 'metadata_json', NEW.metadata_json));
    END;
    CREATE TRIGGER project_nodes_update INSTEAD OF UPDATE ON project_nodes BEGIN
      UPDATE graph_node_documents
         SET project_id = NEW.project_name, kind = NEW.node_type, label = NEW.name,
             payload_json = json_object('id', NEW.id, 'project_name', NEW.project_name, 'node_type', NEW.node_type, 'name', NEW.name,
               'qualified_name', NEW.qualified_name, 'source_ref', NEW.source_ref, 'symbol_id', NEW.symbol_id, 'metadata_json', NEW.metadata_json)
       WHERE source_table = 'project_nodes' AND source_id = OLD.id;
    END;
    CREATE TRIGGER project_nodes_delete INSTEAD OF DELETE ON project_nodes BEGIN
      DELETE FROM graph_node_documents WHERE source_table = 'project_nodes' AND source_id = OLD.id;
    END;
    CREATE VIEW project_edges AS
      SELECT source_id AS id,
             json_extract(payload_json, '$.project_name') AS project_name,
             json_extract(payload_json, '$.edge_type') AS edge_type,
             json_extract(payload_json, '$.source_node_id') AS source_node_id,
             json_extract(payload_json, '$.target_node_id') AS target_node_id,
             json_extract(payload_json, '$.source_ref') AS source_ref,
             CAST(json_extract(payload_json, '$.confidence') AS REAL) AS confidence,
             json_extract(payload_json, '$.metadata_json') AS metadata_json
        FROM graph_edge_documents WHERE source_table = 'project_edges';
    CREATE TRIGGER project_edges_insert INSTEAD OF INSERT ON project_edges BEGIN
      INSERT INTO graph_edge_documents (source_table, source_id, project_id, kind, label, updated_at, payload_json)
      VALUES ('project_edges', NEW.id, NEW.project_name, NEW.edge_type, NEW.source_ref, NULL,
        json_object('id', NEW.id, 'project_name', NEW.project_name, 'edge_type', NEW.edge_type,
          'source_node_id', NEW.source_node_id, 'target_node_id', NEW.target_node_id, 'source_ref', NEW.source_ref,
          'confidence', NEW.confidence, 'metadata_json', NEW.metadata_json));
    END;
    CREATE TRIGGER project_edges_delete INSTEAD OF DELETE ON project_edges BEGIN
      DELETE FROM graph_edge_documents WHERE source_table = 'project_edges' AND source_id = OLD.id;
    END;
    CREATE VIEW graph_views AS
      SELECT source_id AS id,
             json_extract(payload_json, '$.project_name') AS project_name,
             json_extract(payload_json, '$.view_type') AS view_type,
             json_extract(payload_json, '$.title') AS title,
             json_extract(payload_json, '$.payload_json') AS payload_json
        FROM graph_node_documents WHERE source_table = 'graph_views';
    CREATE TRIGGER graph_views_insert INSTEAD OF INSERT ON graph_views BEGIN
      INSERT INTO graph_node_documents (source_table, source_id, project_id, kind, label, updated_at, payload_json)
      VALUES ('graph_views', NEW.id, NEW.project_name, NEW.view_type, NEW.title, NULL,
        json_object('id', NEW.id, 'project_name', NEW.project_name, 'view_type', NEW.view_type, 'title', NEW.title, 'payload_json', NEW.payload_json));
    END;
    CREATE TRIGGER graph_views_delete INSTEAD OF DELETE ON graph_views BEGIN
      DELETE FROM graph_node_documents WHERE source_table = 'graph_views' AND source_id = OLD.id;
    END;
  `);
}

function insertGenericProjectionRows(db: DatabaseSync, targetTable: 'graph_node_documents' | 'graph_edge_documents' | 'code_symbol_documents', sourceTable: string, rows: GenericProjectionRow[]): void {
  const insert = db.prepare(
    `INSERT INTO ${targetTable} (source_table, source_id, project_id, kind, label, updated_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  rows.forEach((row, index) => {
    const id = stringField(row, ['id', 'symbol_id', 'node_id', 'edge_id']) ?? `${sourceTable}:${index}`;
    insert.run(
      sourceTable,
      id,
      stringField(row, ['project_id', 'projectId']),
      stringField(row, ['kind', 'type', 'symbol_kind', 'edge_type']),
      boundedText(stringField(row, ['label', 'name', 'display_name', 'qualified_name']) ?? id, 4_096),
      stringField(row, ['updated_at', 'created_at']),
      stableJson(sqliteJsonValue(row)),
    );
  });
}

function sourceTableExists(source: ZeusDatabasePort, table: 'project_nodes' | 'project_edges' | 'code_symbols' | 'graph_views'): boolean {
  return Boolean(source.get<{ present: number }>(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]));
}

function configureCandidate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;');
}

function assertCandidateQuickCheck(db: DatabaseSync, label: string): void {
  const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
  const values = rows.flatMap((row) => Object.values(row)).map(String);
  if (values.length !== 1 || values[0] !== 'ok') throw candidateError('ZEUS_PROJECTION_CANDIDATE_INTEGRITY_FAILED', `${label} quick_check 失败：${values.join('; ')}`);
}

async function validateCandidatePath(pathValue: string, kind: 'index' | 'cache'): Promise<string> {
  if (typeof pathValue !== 'string' || !pathValue.trim()) throw candidateError('ZEUS_PROJECTION_CANDIDATE_INVALID_PATH', '投影数据库候选路径不能为空。');
  const path = resolve(pathValue);
  const expectedSuffix = `.${kind}.candidate.db`;
  if (!basename(path).endsWith(expectedSuffix)) throw candidateError('ZEUS_PROJECTION_CANDIDATE_INVALID_PATH', `候选文件名必须以 ${expectedSuffix} 结尾。`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw candidateError('ZEUS_PROJECTION_CANDIDATE_INVALID_PATH', '候选父目录必须是非符号链接目录。');
  try {
    await lstat(path);
    throw candidateError('ZEUS_PROJECTION_CANDIDATE_ALREADY_EXISTS', '候选路径已存在，禁止覆盖。');
  } catch (error) {
    if (error instanceof ProjectionDatabaseCandidateError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path;
}

async function publishCandidateOnly(temporaryPath: string, candidatePath: string): Promise<void> {
  try {
    await link(temporaryPath, candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw candidateError('ZEUS_PROJECTION_CANDIDATE_ALREADY_EXISTS', '候选路径在构建期间被占用，禁止覆盖。');
    throw error;
  }
  await unlink(temporaryPath);
  await chmod(candidatePath, 0o600);
}

async function candidateReceipt(input: {
  candidateKind: 'index' | 'cache';
  candidatePath: string;
  generationId: string;
  sourceDatabaseIdentity: string;
  counts: Record<string, number>;
  gaps: string[];
  createdAt: string;
}): Promise<ProjectionDatabaseCandidateReceipt> {
  const bytes = await readFile(input.candidatePath);
  const verifier = new DatabaseSync(input.candidatePath, { readOnly: true });
  try {
    assertCandidateQuickCheck(verifier, `${input.candidateKind}.db 候选`);
  } finally {
    verifier.close();
  }
  return {
    candidateKind: input.candidateKind,
    candidatePath: input.candidatePath,
    generationId: input.generationId,
    sourceDatabaseIdentity: input.sourceDatabaseIdentity,
    fileSha256: sha256(bytes),
    byteLength: bytes.byteLength,
    quickCheck: 'ok',
    rebuildable: true,
    published: false,
    counts: input.counts,
    gaps: input.gaps,
    createdAt: input.createdAt,
  };
}

function normalizeIdentity(value: string, field: string): string {
  if (typeof value !== 'string') throw candidateError('ZEUS_PROJECTION_CANDIDATE_SOURCE_INVALID', `${field} 必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumIdentityLength || !/^[\w:./@+-]+$/u.test(normalized)) throw candidateError('ZEUS_PROJECTION_CANDIDATE_SOURCE_INVALID', `${field} 格式无效。`);
  return normalized;
}

function normalizeTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw candidateError('ZEUS_PROJECTION_CANDIDATE_SOURCE_INVALID', 'createdAt 无效。');
  return new Date(value).toISOString();
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim().slice(0, 4_096);
}

function boundedText(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : value.slice(0, maximumLength);
}

function stringField(row: GenericProjectionRow, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  }
  return null;
}

function sqliteJsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(sqliteJsonValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sqliteJsonValue(nested)]));
  return value;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function candidateError(code: ProjectionDatabaseCandidateErrorCode, message: string, cause?: unknown): ProjectionDatabaseCandidateError {
  return new ProjectionDatabaseCandidateError(code, message, cause);
}
