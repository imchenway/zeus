import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { nanoid } from 'nanoid';
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';

export interface ZeusProjectRecord {
  id: string;
  name: string;
  slug: string;
  localPath: string;
  description: string | null;
  note: string | null;
  defaultTemplateId: string | null;
  scanStatus: 'not_scanned' | 'scanning' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTaskRecord {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';
  templateId: string | null;
  tags: string[];
  createdFrom: string;
  sourceContextJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTaskTemplateRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  promptTemplate: string;
  defaultOptionsJson: string;
  projectId: string | null;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusSettingRecord {
  key: string;
  valueJson: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  localPath: string;
  description?: string;
  note?: string;
}

export interface UpdateProjectInput {
  name?: string;
  localPath?: string;
  description?: string | null;
  note?: string | null;
}

export interface ProjectSearchOptions {
  query?: string;
}

export interface ProjectArchiveConfirmation {
  projectId: string;
  confirmationText: string;
  riskLevel: 'medium';
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description: string;
  createdFrom: string;
  sourceContext: Record<string, unknown>;
  templateId?: string;
  tags?: string[];
}

export interface CreateTaskTemplateInput {
  projectId?: string;
  name: string;
  description: string;
  promptTemplate: string;
  category?: string;
  defaultOptions?: Record<string, unknown>;
}

export interface CreateTaskFromTemplateInput {
  projectId: string;
  template: ZeusTaskTemplateRecord;
  title?: string;
  variables?: Record<string, string>;
}

export interface TaskListOptions {
  query?: string;
  status?: ZeusTaskRecord['status'];
  tag?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'status';
  sortDirection?: 'asc' | 'desc';
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
}

export interface ZeusTaskEventRecord {
  id: string;
  taskId: string;
  eventType: string;
  title: string;
  payloadJson: string;
  createdAt: string;
}

export type RuntimeSessionStatus = 'running' | 'exited' | 'failed' | 'stopped' | 'orphan_detected' | 'lost';
export type RuntimeLogStream = 'system' | 'stdout' | 'stderr';

export interface ZeusRuntimeSessionRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  command: string;
  argsJson: string;
  cwd: string;
  status: RuntimeSessionStatus;
  pid: number | null;
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
}

export interface RuntimeLogListResult {
  items: ZeusRuntimeLogRecord[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  stream: RuntimeLogStream | null;
}

export interface CreateTaskEventInput {
  taskId: string;
  eventType: string;
  title: string;
  payload: Record<string, unknown>;
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

export interface ZeusConversationRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  sessionId: string | null;
  title: string;
  summary: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface ZeusConversationMessageRecord {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadataJson: string;
  createdAt: string;
}

export interface ZeusConversationWithMessagesRecord extends ZeusConversationRecord {
  messages: ZeusConversationMessageRecord[];
}

export interface ConversationListOptions {
  query?: string;
  limit?: number;
  offset?: number;
  archived?: boolean;
}

export interface ConversationListResult {
  items: ZeusConversationWithMessagesRecord[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  archived: boolean;
}

export interface CreateConversationInput {
  projectId: string;
  taskId?: string;
  sessionId?: string;
  title: string;
  summary?: string;
  status?: string;
}

export interface AppendConversationMessageInput {
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ZeusGitSnapshotRecord {
  id: string;
  taskId: string;
  projectId: string;
  snapshotType: string;
  branch: string | null;
  headSha: string | null;
  statusJson: string;
  diffTextPath: string | null;
  createdAt: string;
}

export interface ZeusGitChangeRecord {
  id: string;
  taskId: string;
  projectId: string;
  filePath: string;
  changeType: string;
  additions: number;
  deletions: number;
  diffHunkPath: string | null;
  linkedGraphNodesJson: string;
  createdAt: string;
}

export interface CreateGitSnapshotInput {
  taskId: string;
  projectId: string;
  snapshotType: string;
  branch?: string;
  headSha?: string;
  status: Record<string, unknown>;
  diffTextPath?: string;
  createdAt: string;
}

export interface CreateGitChangeInput {
  taskId: string;
  projectId: string;
  filePath: string;
  changeType: string;
  additions?: number;
  deletions?: number;
  diffHunkPath?: string;
  linkedGraphNodes?: string[];
  createdAt: string;
}

export interface ZeusAuditLogRecord {
  id: string;
  actorType: string;
  actorRef: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payloadJson: string;
  createdAt: string;
}

export interface AppendAuditLogInput {
  actorType: string;
  actorRef?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const builtInTaskTemplates = [
  {
    id: 'task_template_requirement_analysis',
    sortOrder: 1,
    name: '需求分析',
    description: '澄清真实需求、业务规则、边界与验收标准。',
    promptTemplate: '请基于 {{project_context}} 分析需求：{{requirement}}，输出业务规则、边界场景和验收标准。',
  },
  {
    id: 'task_template_code_implementation',
    sortOrder: 2,
    name: '代码实现',
    description: '根据已确认方案实现真实代码变更并补充验证。',
    promptTemplate: '请在 {{project_path}} 按设计实现：{{implementation_goal}}，并说明影响范围与验证方式。',
  },
  {
    id: 'task_template_bug_fix',
    sortOrder: 3,
    name: 'Bug 修复',
    description: '定位真实缺陷、补充回归测试并修复。',
    promptTemplate: '请复现并修复缺陷：{{bug_report}}，要求先补回归测试，再给出根因、修法和验证结果。',
  },
  {
    id: 'task_template_code_review',
    sortOrder: 4,
    name: '代码评审',
    description: '审查真实变更的正确性、风险和可维护性。',
    promptTemplate: '请审查以下真实变更：{{diff_context}}，重点关注正确性、风险、测试缺口和回滚建议。',
  },
  {
    id: 'task_template_unit_test',
    sortOrder: 5,
    name: '单元测试',
    description: '为真实模块补充聚焦单元测试和边界用例。',
    promptTemplate: '请为 {{target_module}} 设计并实现单元测试，覆盖主路径、边界和错误场景。',
  },
  {
    id: 'task_template_performance_analysis',
    sortOrder: 6,
    name: '性能分析',
    description: '分析真实代码路径的性能瓶颈与可观测指标。',
    promptTemplate: '请分析 {{target_flow}} 的性能风险，给出瓶颈假设、验证方式、优化建议和回归指标。',
  },
  {
    id: 'task_template_architecture_analysis',
    sortOrder: 7,
    name: '架构分析',
    description: '基于真实图谱理解模块边界、依赖和演进风险。',
    promptTemplate: '请基于 {{graph_context}} 分析架构边界、依赖方向、风险点和改造顺序。',
  },
  {
    id: 'task_template_sql_optimization',
    sortOrder: 8,
    name: 'SQL 优化',
    description: '分析真实 SQL、表结构或查询路径的优化空间。',
    promptTemplate: '请基于 {{sql_context}} 分析 SQL 性能、索引、事务一致性和回滚风险。',
  },
] as const;

let sqlModulePromise: Promise<SqlJsStatic> | undefined;

/** 加载 sql.js SQLite 引擎；保持单例，避免每次打开数据库都重复初始化 wasm。 */
async function loadSqlModule(): Promise<SqlJsStatic> {
  sqlModulePromise ??= initSqlJs();
  return sqlModulePromise;
}

/** Zeus SQLite 包装器：负责迁移、保存和少量测试/诊断辅助查询。 */
export class ZeusDatabase {
  constructor(
    private readonly db: Database,
    private readonly filePath: string,
  ) {}

  execute(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params);
  }

  select<T>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql, params);
    const rows: T[] = [];
    try {
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.select<T>(sql, params)[0];
  }

  listTableNames(): string[] {
    return this.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name);
  }

  countRows(tableName: string): number {
    if (!/^[a-z_]+$/u.test(tableName)) {
      throw new Error(`Invalid Zeus table name: ${tableName}`);
    }
    return this.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${tableName}`)?.count ?? 0;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, Buffer.from(this.db.export()));
  }
}

export interface SqliteSchemaIntrospectionSnapshot {
  sourcePath: string;
  statements: Array<{
    type: 'table' | 'index' | 'trigger' | 'view';
    name: string;
    sql: string;
  }>;
}

/** 只读读取用户配置的 SQLite 文件 schema；不执行迁移、不写回目标数据库。 */
export async function introspectSqliteSchema(filePath: string): Promise<SqliteSchemaIntrospectionSnapshot> {
  const SQL = await loadSqlModule();
  const bytes = await readFile(filePath);
  const sqlite = new SQL.Database(bytes);
  try {
    const tableNames = selectSqliteObjects(sqlite, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .map((row) => String(row.name ?? ''))
      .filter(Boolean);
    const statements: SqliteSchemaIntrospectionSnapshot['statements'] = tableNames.map((tableName) => ({
      type: 'table',
      name: tableName,
      sql: renderSqliteCreateTable(sqlite, tableName),
    }));
    statements.push(...tableNames.flatMap((tableName) => renderSqliteCreateIndexes(sqlite, tableName)));
    statements.push(
      ...selectSqliteObjects(sqlite, `SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') AND sql IS NOT NULL ORDER BY type, name`).flatMap((row) => {
        if ((row.type === 'trigger' || row.type === 'view') && typeof row.name === 'string' && typeof row.sql === 'string') {
          return [
            {
              type: row.type as 'trigger' | 'view',
              name: row.name,
              sql: row.sql,
            },
          ];
        }
        return [];
      }),
    );
    return { sourcePath: filePath, statements };
  } finally {
    sqlite.close();
  }
}

function selectSqliteObjects(sqlite: Database, sql: string): Array<Record<string, SqlValue>> {
  const stmt = sqlite.prepare(sql);
  const rows: Array<Record<string, SqlValue>> = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, SqlValue>);
  } finally {
    stmt.free();
  }
  return rows;
}

function renderSqliteCreateTable(sqlite: Database, tableName: string): string {
  const columns = selectSqliteObjects(sqlite, `PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`);
  const foreignKeys = selectSqliteObjects(sqlite, `PRAGMA foreign_key_list(${quoteSqliteIdentifier(tableName)})`);
  const columnLines = columns.map((column) => {
    const parts = [
      quoteSqliteIdentifier(String(column.name)),
      String(column.type || 'TEXT').toUpperCase(),
      Number(column.notnull ?? 0) === 1 ? 'NOT NULL' : '',
      Number(column.pk ?? 0) === 1 ? 'PRIMARY KEY' : '',
      column.dflt_value !== null && column.dflt_value !== undefined ? `DEFAULT ${String(column.dflt_value)}` : '',
    ].filter(Boolean);
    return `  ${parts.join(' ')}`;
  });
  const foreignKeyLines = foreignKeys.map((foreignKey) => `  FOREIGN KEY (${quoteSqliteIdentifier(String(foreignKey.from))}) REFERENCES ${quoteSqliteIdentifier(String(foreignKey.table))}(${quoteSqliteIdentifier(String(foreignKey.to))})`);
  return `CREATE TABLE ${quoteSqliteIdentifier(tableName)} (\n${[...columnLines, ...foreignKeyLines].join(',\n')}\n)`;
}

function renderSqliteCreateIndexes(sqlite: Database, tableName: string): SqliteSchemaIntrospectionSnapshot['statements'] {
  return selectSqliteObjects(sqlite, `PRAGMA index_list(${quoteSqliteIdentifier(tableName)})`)
    .filter((index) => String(index.origin ?? 'c') === 'c')
    .flatMap((index) => {
      const indexName = String(index.name ?? '');
      if (!indexName || indexName.startsWith('sqlite_')) return [];
      const columns = selectSqliteObjects(sqlite, `PRAGMA index_info(${quoteSqliteIdentifier(indexName)})`)
        .map((column) => quoteSqliteIdentifier(String(column.name ?? '')))
        .filter((name) => name !== '""');
      if (columns.length === 0) return [];
      const unique = Number(index.unique ?? 0) === 1 ? 'UNIQUE ' : '';
      return [
        {
          type: 'index' as const,
          name: indexName,
          sql: `CREATE ${unique}INDEX ${quoteSqliteIdentifier(indexName)} ON ${quoteSqliteIdentifier(tableName)} (${columns.join(', ')})`,
        },
      ];
    });
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

/** 创建或打开 Zeus SQLite 数据库，并执行幂等迁移；不会写入任何 seed 业务记录。 */
export async function createZeusDatabase(filePath: string): Promise<ZeusDatabase> {
  const SQL = await loadSqlModule();
  let db: Database;
  try {
    const bytes = await readFile(filePath);
    db = new SQL.Database(bytes);
  } catch {
    db = new SQL.Database();
  }
  const zeusDb = new ZeusDatabase(db, filePath);
  migrateCoreSchema(zeusDb);
  return zeusDb;
}

function migrateCoreSchema(db: ZeusDatabase): void {
  createSchemaMigrationsLedger(db);

  db.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      local_path TEXT NOT NULL,
      git_root TEXT,
      project_type TEXT,
      primary_language TEXT,
      description TEXT,
      note TEXT,
      default_model TEXT,
      default_work_mode TEXT,
      default_template_id TEXT,
      scan_status TEXT NOT NULL DEFAULT 'not_scanned',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  try {
    db.execute(`ALTER TABLE projects ADD COLUMN note TEXT`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  try {
    db.execute(`ALTER TABLE projects ADD COLUMN default_template_id TEXT`);
  } catch {
    // 列已存在时忽略；sql.js 不支持 ADD COLUMN IF NOT EXISTS。
  }
  db.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      tags_json TEXT NOT NULL,
      template_id TEXT,
      model TEXT,
      work_dir TEXT,
      allow_code_changes INTEGER NOT NULL DEFAULT 0,
      allow_tests INTEGER NOT NULL DEFAULT 0,
      allow_git_commit INTEGER NOT NULL DEFAULT 0,
      created_from TEXT NOT NULL,
      source_context_json TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS runtime_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      exit_code INTEGER,
      summary TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  for (const statement of [
    `ALTER TABLE runtime_sessions ADD COLUMN summary TEXT`,
    `ALTER TABLE runtime_sessions ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runtime_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runtime_sessions ADD COLUMN deleted_at TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // 列已存在时忽略；sql.js 不支持 ADD COLUMN IF NOT EXISTS。
    }
  }

  db.execute(`
    CREATE TABLE IF NOT EXISTS runtime_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS terminal_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      content TEXT NOT NULL,
      raw_chunk_path TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      session_id TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS git_snapshots (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      branch TEXT,
      head_sha TEXT,
      status_json TEXT NOT NULL,
      diff_text_path TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS git_changes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      change_type TEXT NOT NULL,
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      diff_hunk_path TEXT,
      linked_graph_nodes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_ref TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS task_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      prompt_template TEXT NOT NULL,
      default_options_json TEXT NOT NULL DEFAULT '{}',
      built_in INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  for (const statement of [
    `CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_status_updated_at ON tasks(project_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_task_events_task_created_at ON task_events(task_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_sessions_task_status ON runtime_sessions(task_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_terminal_events_session_seq ON terminal_events(session_id, seq)`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_project_updated_at ON conversations(project_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_created_at ON conversation_messages(conversation_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_git_snapshots_task_created_at ON git_snapshots(task_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_git_changes_task_file_path ON git_changes(task_id, file_path)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_at ON audit_logs(action, created_at)`,
  ]) {
    db.execute(statement);
  }
  try {
    db.execute(`ALTER TABLE task_templates ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // 列已存在时忽略；sql.js 不支持 ADD COLUMN IF NOT EXISTS。
  }
  try {
    db.execute(`ALTER TABLE task_templates ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`);
  } catch {
    // 列已存在时忽略；sql.js 不支持 ADD COLUMN IF NOT EXISTS。
  }
  try {
    db.execute(`ALTER TABLE task_templates ADD COLUMN default_options_json TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // 列已存在时忽略；sql.js 不支持 ADD COLUMN IF NOT EXISTS。
  }

  const timestamp = nowIso();
  for (const template of builtInTaskTemplates) {
    db.execute(
      `INSERT OR IGNORE INTO task_templates (id, name, description, category, prompt_template, default_options_json, built_in, created_at, updated_at)
       VALUES (?, ?, ?, 'built_in', ?, '{}', 1, ?, ?)`,
      [template.id, template.name, template.description, template.promptTemplate, timestamp, timestamp],
    );
    db.execute(`UPDATE task_templates SET sort_order = ?, name = ?, description = ?, category = 'built_in', prompt_template = ?, default_options_json = '{}', updated_at = ? WHERE id = ? AND built_in = 1`, [
      template.sortOrder,
      template.name,
      template.description,
      template.promptTemplate,
      timestamp,
      template.id,
    ]);
  }

  recordSchemaMigration(db, {
    migrationId: '20260613_0001_core_schema',
    description: '初始化 Zeus 核心表、索引和内置任务模板定义',
    checksumSource: 'projects,tasks,task_events,runtime_sessions,runtime_logs,terminal_events,conversations,conversation_messages,git_snapshots,git_changes,audit_logs,event_log,settings,task_templates,indexes,built_in_templates',
  });
}

function createSchemaMigrationsLedger(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function recordSchemaMigration(
  db: ZeusDatabase,
  migration: {
    migrationId: string;
    description: string;
    checksumSource: string;
  },
): void {
  // migration 账本只记录结构版本，不写入项目/任务等业务假数据。
  const checksum = `sha256:${createHash('sha256').update(migration.checksumSource).digest('hex')}`;
  db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [migration.migrationId, migration.description, checksum, nowIso()]);
}

function clampPositiveInteger(value: number | undefined | null, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugifyProjectName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/(^-|-$)/gu, '');
  return slug || `project-${nanoid(8)}`;
}

function normalizeProjectLocalPath(localPath: string): string {
  const trimmed = localPath.trim();
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/u, '');
}

function dedupeProjectsByLocalPath(projects: ZeusProjectRecord[]): ZeusProjectRecord[] {
  const seen = new Set<string>();
  const deduped: ZeusProjectRecord[] = [];
  for (const project of projects) {
    const localPathKey = normalizeProjectLocalPath(project.localPath);
    if (seen.has(localPathKey)) {
      continue;
    }
    seen.add(localPathKey);
    deduped.push(project);
  }
  return deduped;
}

function renderPromptTemplate(promptTemplate: string, variables: Record<string, string>): string {
  return promptTemplate.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (match, key: string) => variables[key] ?? match);
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function parseTagsJson(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    return Array.isArray(parsed) ? normalizeTags(parsed.filter((tag): tag is string => typeof tag === 'string')) : [];
  } catch {
    return [];
  }
}

function filterAndSortTasks(records: ZeusTaskRecord[], options: TaskListOptions): ZeusTaskRecord[] {
  const query = options.query?.trim().toLowerCase();
  const tag = options.tag?.trim();
  const filtered = records.filter((record) => {
    const matchesQuery = !query || `${record.title}\n${record.description}`.toLowerCase().includes(query);
    const matchesStatus = !options.status || record.status === options.status;
    const matchesTag = !tag || record.tags.includes(tag);
    return matchesQuery && matchesStatus && matchesTag;
  });
  const sortBy = options.sortBy ?? 'createdAt';
  const direction = options.sortDirection === 'desc' ? -1 : 1;
  return [...filtered].sort((left, right) => {
    const leftValue = String(left[sortBy]);
    const rightValue = String(right[sortBy]);
    return leftValue.localeCompare(rightValue) * direction;
  });
}

/** 设置仓储保存本机偏好与通知策略，不存储 token、密码等敏感明文。 */
export class SettingRepository {
  constructor(private readonly db: ZeusDatabase) {}

  getJson<T>(key: string): T | undefined {
    const row = this.db.get<DbSettingRow>(`SELECT key, value_json, updated_at FROM settings WHERE key = ?`, [key]);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return undefined;
    }
  }

  setJson(key: string, value: unknown): ZeusSettingRecord {
    const record: ZeusSettingRecord = {
      key,
      valueJson: JSON.stringify(value),
      updatedAt: nowIso(),
    };
    this.db.execute(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [record.key, record.valueJson, record.updatedAt],
    );
    return record;
  }
}

/** 项目仓储只保存用户明确创建的真实本地路径记录。 */
export class ProjectRepository {
  constructor(private readonly db: ZeusDatabase) {}

  /**
   * 创建项目时以规范化后的本地路径作为唯一事实源；同一路径重复创建直接返回已有项目。
   */
  create(input: CreateProjectInput): ZeusProjectRecord {
    const localPath = normalizeProjectLocalPath(input.localPath);
    const existing = this.findByLocalPath(localPath);
    if (existing) {
      return existing;
    }
    const timestamp = nowIso();
    const record: ZeusProjectRecord = {
      id: `project_${nanoid(12)}`,
      name: input.name,
      slug: `${slugifyProjectName(input.name)}-${nanoid(6)}`,
      localPath,
      description: input.description ?? null,
      note: input.note ?? null,
      defaultTemplateId: null,
      scanStatus: 'not_scanned',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO projects (id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.name, record.slug, record.localPath, record.description, record.note, record.defaultTemplateId, record.scanStatus, record.createdAt, record.updatedAt],
    );
    return record;
  }

  list(): ZeusProjectRecord[] {
    return this.search();
  }

  search(options: ProjectSearchOptions = {}): ZeusProjectRecord[] {
    const query = options.query?.trim().toLowerCase();
    const projects = this.db
      .select<DbProjectRow>(
        `SELECT id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at
       FROM projects WHERE archived = 0 AND deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .map(mapProjectRow)
      .filter((project) => {
        if (!query) return true;
        return `${project.name}\n${project.localPath}\n${project.description ?? ''}\n${project.note ?? ''}`.toLowerCase().includes(query);
      });
    return dedupeProjectsByLocalPath(projects);
  }

  getById(projectId: string): ZeusProjectRecord | undefined {
    const row = this.db.get<DbProjectRow>(
      `SELECT id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at
       FROM projects WHERE id = ? AND deleted_at IS NULL`,
      [projectId],
    );
    return row ? mapProjectRow(row) : undefined;
  }

  update(projectId: string, input: UpdateProjectInput): ZeusProjectRecord {
    const existing = this.getById(projectId);
    if (!existing) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    const localPath = input.localPath === undefined ? existing.localPath : normalizeProjectLocalPath(input.localPath);
    const duplicated = this.findByLocalPath(localPath, projectId);
    if (duplicated) {
      throw new Error(`Zeus project localPath already exists: ${localPath}`);
    }
    const timestamp = nowIso();
    this.db.execute(`UPDATE projects SET name = ?, local_path = ?, description = ?, note = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [
      input.name ?? existing.name,
      localPath,
      input.description === undefined ? existing.description : input.description,
      input.note === undefined ? existing.note : input.note,
      timestamp,
      projectId,
    ]);
    const updated = this.getById(projectId);
    if (!updated) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return updated;
  }

  /**
   * 按规范化路径查找未删除项目，包含归档项目，保证归档态也不会被重复创建绕过。
   */
  private findByLocalPath(localPath: string, excludeProjectId?: string): ZeusProjectRecord | undefined {
    return this.db
      .select<DbProjectRow>(
        `SELECT id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at
       FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .map(mapProjectRow)
      .find((project) => project.id !== excludeProjectId && normalizeProjectLocalPath(project.localPath) === localPath);
  }

  updateScanStatus(projectId: string, scanStatus: ZeusProjectRecord['scanStatus']): ZeusProjectRecord {
    const timestamp = nowIso();
    // 扫描状态只记录真实扫描生命周期，不提前写入 completed，避免 UI 误判图谱已可用。
    this.db.execute(`UPDATE projects SET scan_status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [scanStatus, timestamp, projectId]);
    const updated = this.getById(projectId);
    if (!updated) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return updated;
  }

  prepareArchive(projectId: string): ProjectArchiveConfirmation {
    const existing = this.getById(projectId);
    if (!existing) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return {
      projectId,
      confirmationText: `确认归档项目 ${existing.name}`,
      riskLevel: 'medium',
    };
  }

  delete(projectId: string): ZeusProjectRecord {
    const existing = this.getById(projectId);
    if (!existing) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    const timestamp = nowIso();
    // 删除采用软删除，保留审计链路和关联任务来源，避免误删真实项目历史。
    this.db.execute(`UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, timestamp, projectId]);
    return existing;
  }

  setDefaultTemplate(projectId: string, templateId: string | null): ZeusProjectRecord {
    const timestamp = nowIso();
    // 项目默认模板只保存模板引用，不创建任务，避免引入任何 seed/mock 业务记录。
    this.db.execute(`UPDATE projects SET default_template_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [templateId, timestamp, projectId]);
    const updated = this.getById(projectId);
    if (!updated) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return updated;
  }

  archive(projectId: string): ZeusProjectRecord {
    const timestamp = nowIso();
    this.db.execute(`UPDATE projects SET archived = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, projectId]);
    const archived = this.getById(projectId);
    if (!archived) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return archived;
  }

  restore(projectId: string): ZeusProjectRecord {
    const timestamp = nowIso();
    this.db.execute(`UPDATE projects SET archived = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, projectId]);
    const restored = this.getById(projectId);
    if (!restored) {
      throw new Error(`Zeus project not found: ${projectId}`);
    }
    return restored;
  }

  listArchived(): ZeusProjectRecord[] {
    return this.db
      .select<DbProjectRow>(
        `SELECT id, name, slug, local_path, description, note, default_template_id, scan_status, created_at, updated_at
       FROM projects WHERE archived = 1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
      )
      .map(mapProjectRow);
  }
}

/** 任务仓储保存真实任务定义，初始状态统一为 ready，等待用户或 runtime 执行。 */
export class TaskRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateTaskInput): ZeusTaskRecord {
    const timestamp = nowIso();
    const record: ZeusTaskRecord = {
      id: `task_${nanoid(12)}`,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: 'ready',
      templateId: input.templateId ?? null,
      tags: normalizeTags(input.tags ?? []),
      createdFrom: input.createdFrom,
      sourceContextJson: JSON.stringify(input.sourceContext),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO tasks (id, project_id, title, description, status, tags_json, template_id, created_from, source_context_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.projectId, record.title, record.description, record.status, JSON.stringify(record.tags), record.templateId, record.createdFrom, record.sourceContextJson, record.createdAt, record.updatedAt],
    );
    return record;
  }

  createFromTemplate(input: CreateTaskFromTemplateInput): ZeusTaskRecord {
    const variables = input.variables ?? {};
    const description = renderPromptTemplate(input.template.promptTemplate, variables);
    return this.create({
      projectId: input.projectId,
      title: input.title ?? input.template.name,
      description,
      createdFrom: 'template',
      templateId: input.template.id,
      sourceContext: {
        type: 'task_template',
        templateId: input.template.id,
        templateName: input.template.name,
        variables,
      },
    });
  }

  getById(taskId: string): ZeusTaskRecord | undefined {
    const row = this.db.get<DbTaskRow>(
      `SELECT id, project_id, title, description, status, tags_json, template_id, created_from, source_context_json, created_at, updated_at
       FROM tasks WHERE id = ? AND deleted_at IS NULL`,
      [taskId],
    );
    return row ? mapTaskRow(row) : undefined;
  }

  archive(taskId: string): ZeusTaskRecord {
    const timestamp = nowIso();
    this.db.execute(`UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, taskId]);
    const archived = this.getById(taskId);
    if (!archived) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return archived;
  }

  restore(taskId: string): ZeusTaskRecord {
    const timestamp = nowIso();
    // 恢复只切换归档标记，保留任务状态与时间线来源，避免丢失真实执行上下文。
    this.db.execute(`UPDATE tasks SET archived = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, taskId]);
    const restored = this.getById(taskId);
    if (!restored) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return restored;
  }

  updateStatus(taskId: string, status: ZeusTaskRecord['status']): ZeusTaskRecord {
    const timestamp = nowIso();
    this.db.execute(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [status, timestamp, taskId]);
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  update(taskId: string, input: UpdateTaskInput): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    const timestamp = nowIso();
    this.db.execute(`UPDATE tasks SET title = ?, description = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [input.title ?? existing.title, input.description ?? existing.description, timestamp, taskId]);
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  updateSourceContext(taskId: string, sourceContext: Record<string, unknown>): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    const timestamp = nowIso();
    // 图谱关联会持续补充任务来源上下文，单独更新 source_context_json，避免误改标题、描述和状态。
    this.db.execute(`UPDATE tasks SET source_context_json = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [JSON.stringify(sourceContext), timestamp, taskId]);
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  updateTags(taskId: string, tags: string[]): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    const timestamp = nowIso();
    this.db.execute(`UPDATE tasks SET tags_json = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [JSON.stringify(normalizeTags(tags)), timestamp, taskId]);
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  delete(taskId: string): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    const timestamp = nowIso();
    // 任务删除采用软删除，保留真实任务来源与事件审计，避免误删历史链路。
    this.db.execute(`UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, timestamp, taskId]);
    return existing;
  }

  listAll(options: TaskListOptions = {}): ZeusTaskRecord[] {
    const records = this.db
      .select<DbTaskRow>(
        `SELECT id, project_id, title, description, status, tags_json, template_id, created_from, source_context_json, created_at, updated_at
       FROM tasks WHERE archived = 0 AND deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .map(mapTaskRow);
    return filterAndSortTasks(records, options);
  }

  listByProject(projectId: string, options: TaskListOptions = {}): ZeusTaskRecord[] {
    const records = this.db
      .select<DbTaskRow>(
        `SELECT id, project_id, title, description, status, tags_json, template_id, created_from, source_context_json, created_at, updated_at
       FROM tasks WHERE project_id = ? AND archived = 0 AND deleted_at IS NULL ORDER BY created_at ASC`,
        [projectId],
      )
      .map(mapTaskRow);
    return filterAndSortTasks(records, options);
  }

  listArchivedByProject(projectId: string, options: TaskListOptions = {}): ZeusTaskRecord[] {
    const records = this.db
      .select<DbTaskRow>(
        `SELECT id, project_id, title, description, status, tags_json, template_id, created_from, source_context_json, created_at, updated_at
       FROM tasks WHERE project_id = ? AND archived = 1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
        [projectId],
      )
      .map(mapTaskRow);
    return filterAndSortTasks(records, options);
  }
}

/** 任务模板是产品 prompt 定义，不是项目、任务、会话或执行结果数据。 */
export class TaskTemplateRepository {
  constructor(private readonly db: ZeusDatabase) {}

  createCustom(input: CreateTaskTemplateInput): ZeusTaskTemplateRecord {
    const timestamp = nowIso();
    const record: ZeusTaskTemplateRecord = {
      id: `task_template_${nanoid(12)}`,
      name: input.name,
      description: input.description,
      category: input.category ?? 'custom',
      promptTemplate: input.promptTemplate,
      defaultOptionsJson: JSON.stringify(input.defaultOptions ?? {}),
      projectId: input.projectId ?? null,
      builtIn: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO task_templates (id, name, description, category, prompt_template, default_options_json, built_in, sort_order, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      [record.id, record.name, record.description, record.category, record.promptTemplate, record.defaultOptionsJson, record.projectId, record.createdAt, record.updatedAt],
    );
    return record;
  }

  getById(templateId: string): ZeusTaskTemplateRecord | undefined {
    const row = this.db.get<DbTaskTemplateRow>(
      `SELECT id, name, description, category, prompt_template, default_options_json, project_id, built_in, created_at, updated_at
       FROM task_templates WHERE id = ? AND deleted_at IS NULL`,
      [templateId],
    );
    return row ? mapTaskTemplateRow(row) : undefined;
  }

  listBuiltIn(): ZeusTaskTemplateRecord[] {
    return this.db
      .select<DbTaskTemplateRow>(
        `SELECT id, name, description, category, prompt_template, default_options_json, project_id, built_in, created_at, updated_at
       FROM task_templates WHERE built_in = 1 AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC`,
      )
      .map(mapTaskTemplateRow);
  }

  listAll(): ZeusTaskTemplateRecord[] {
    return this.db
      .select<DbTaskTemplateRow>(
        `SELECT id, name, description, category, prompt_template, default_options_json, project_id, built_in, created_at, updated_at
       FROM task_templates WHERE deleted_at IS NULL ORDER BY built_in DESC, sort_order ASC, created_at ASC, id ASC`,
      )
      .map(mapTaskTemplateRow);
  }

  listForProject(projectId: string): ZeusTaskTemplateRecord[] {
    return this.db
      .select<DbTaskTemplateRow>(
        `SELECT id, name, description, category, prompt_template, default_options_json, project_id, built_in, created_at, updated_at
       FROM task_templates
       WHERE deleted_at IS NULL AND (built_in = 1 OR project_id = ?)
       ORDER BY built_in DESC, sort_order ASC, created_at ASC, id ASC`,
        [projectId],
      )
      .map(mapTaskTemplateRow);
  }
}

/** 任务事件仓储记录真实任务时间线，供任务详情和远程入口复用。 */
export class TaskEventRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateTaskEventInput): ZeusTaskEventRecord {
    const record: ZeusTaskEventRecord = {
      id: `task_event_${nanoid(12)}`,
      taskId: input.taskId,
      eventType: input.eventType,
      title: input.title,
      payloadJson: JSON.stringify(input.payload),
      createdAt: nowIso(),
    };
    this.db.execute(`INSERT INTO task_events (id, task_id, event_type, title, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [record.id, record.taskId, record.eventType, record.title, record.payloadJson, record.createdAt]);
    return record;
  }

  listByTask(taskId: string): ZeusTaskEventRecord[] {
    return this.db.select<DbTaskEventRow>(`SELECT id, task_id, event_type, title, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY created_at ASC`, [taskId]).map(mapTaskEventRow);
  }
}

/** Runtime 会话仓储保存真实 AI CLI 会话和终端日志，支持 App 重启后恢复列表。 */
export class RuntimeSessionRepository {
  constructor(private readonly db: ZeusDatabase) {}

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
      `INSERT OR REPLACE INTO runtime_sessions (id, project_id, task_id, command, args_json, cwd, status, pid, exit_code, summary, favorite, archived, started_at, ended_at, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.taskId,
        record.command,
        record.argsJson,
        record.cwd,
        record.status,
        record.pid,
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
    const existing = this.getById(sessionId);
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
    return this.getById(sessionId)!;
  }

  getById(sessionId: string): ZeusRuntimeSessionRecord | undefined {
    const row = this.db.get<DbRuntimeSessionRow>(runtimeSessionSelectSql(`WHERE id = ? AND deleted_at IS NULL LIMIT 1`), [sessionId]);
    return row ? mapRuntimeSessionRow(row) : undefined;
  }

  list(options: RuntimeSessionListOptions = {}): ZeusRuntimeSessionRecord[] {
    const query = options.query?.trim().toLowerCase();
    const rows = this.db
      .select<DbRuntimeSessionRow>(runtimeSessionSelectSql(`WHERE deleted_at IS NULL AND archived = ? AND (? IS NULL OR project_id = ?) AND (? IS NULL OR task_id = ?) AND (? = 0 OR favorite = 1) ORDER BY started_at DESC, id DESC`), [
        options.archived ? 1 : 0,
        options.projectId ?? null,
        options.projectId ?? null,
        options.taskId ?? null,
        options.taskId ?? null,
        options.favoriteOnly ? 1 : 0,
      ])
      .map(mapRuntimeSessionRow);
    if (!query) return rows;
    return rows.filter((session) => {
      const logsText = this.listLogs(session.id)
        .map((log) => log.text)
        .join('\n')
        .toLowerCase();
      return `${session.command}\n${session.cwd}\n${session.summary ?? ''}\n${logsText}`.toLowerCase().includes(query);
    });
  }

  appendLog(input: AppendRuntimeLogInput): ZeusRuntimeLogRecord {
    const record: ZeusRuntimeLogRecord = {
      id: input.id,
      sessionId: input.sessionId,
      stream: input.stream,
      text: input.text,
      createdAt: input.createdAt,
    };
    this.db.execute(`INSERT OR REPLACE INTO runtime_logs (id, session_id, stream, text, created_at) VALUES (?, ?, ?, ?, ?)`, [record.id, record.sessionId, record.stream, record.text, record.createdAt]);
    this.appendTerminalEventFromRuntimeLog(record);
    return record;
  }

  listLogs(sessionId: string): ZeusRuntimeLogRecord[] {
    return this.searchLogs(sessionId).items;
  }

  searchLogs(sessionId: string, options: RuntimeLogListOptions = {}): RuntimeLogListResult {
    const query = options.query?.trim() || null;
    const stream = options.stream ?? null;
    const limit = clampPositiveInteger(options.limit, 200, 1, 1_000);
    const offset = clampPositiveInteger(options.offset, 0, 0, 100_000);
    const clauses = ['session_id = ?'];
    const params: SqlValue[] = [sessionId];
    if (stream) {
      clauses.push('stream = ?');
      params.push(stream);
    }
    if (query) {
      clauses.push('(LOWER(text) LIKE ? OR LOWER(stream) LIKE ? OR LOWER(created_at) LIKE ?)');
      const like = `%${query.toLowerCase()}%`;
      params.push(like, like, like);
    }
    const whereSql = clauses.join(' AND ');
    const total = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM runtime_logs WHERE ${whereSql}`, params)?.count ?? 0;
    const rows = this.db.select<DbRuntimeLogRow>(`SELECT id, session_id, stream, text, created_at FROM runtime_logs WHERE ${whereSql} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]).map(mapRuntimeLogRow);
    return { items: rows, total, limit, offset, query, stream };
  }

  setFavorite(sessionId: string, favorite: boolean): ZeusRuntimeSessionRecord {
    this.updateFlag(sessionId, 'favorite', favorite);
    return this.getById(sessionId)!;
  }

  archive(sessionId: string): ZeusRuntimeSessionRecord {
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
    const deletedAt = nowIso();
    this.db.execute(`UPDATE runtime_sessions SET deleted_at = ?, updated_at = ? WHERE id = ?`, [deletedAt, deletedAt, sessionId]);
    return { ...existing, deletedAt, updatedAt: deletedAt };
  }

  generateSummary(sessionId: string): ZeusRuntimeSessionRecord {
    const existing = this.getById(sessionId);
    if (!existing) throw new Error(`Runtime session not found: ${sessionId}`);
    const realLogs = this.listLogs(sessionId)
      .map((log) => log.text.trim())
      .filter(Boolean);
    // 摘要只能来自真实 Runtime 日志；没有日志时保持 null，由 UI 展示“未生成摘要”。
    const summary = realLogs.length > 0 ? realLogs.join('\n').slice(0, 500) : null;
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
      `INSERT OR REPLACE INTO terminal_events (id, session_id, task_id, seq, event_type, content, raw_chunk_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`terminal_event_${record.id}`, record.sessionId, session?.taskId ?? null, nextSeq, record.stream, record.text, null, record.createdAt],
    );
  }
}

/** 终端事件仓储按 session+seq 持久化真实输出，后续可支撑 PTY 回放与审计。 */
export class TerminalEventRepository {
  constructor(private readonly db: ZeusDatabase) {}

  append(input: AppendTerminalEventInput): ZeusTerminalEventRecord {
    const record: ZeusTerminalEventRecord = {
      id: `terminal_event_${nanoid(12)}`,
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
        `SELECT id, session_id, task_id, seq, event_type, content, raw_chunk_path, created_at
       FROM terminal_events WHERE session_id = ? ORDER BY seq ASC, created_at ASC`,
        [sessionId],
      )
      .map(mapTerminalEventRow);
  }

  /** 按 session 和 seq 做稳定 SQL 分页，避免终端长会话回放时一次性加载全量事件。 */
  listBySessionPage(sessionId: string, options: TerminalEventListOptions = {}): TerminalEventListResult {
    const limit = clampPositiveInteger(options.limit, 200, 1, 1_000);
    const offset = clampPositiveInteger(options.offset, 0, 0, 100_000);
    const total = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM terminal_events WHERE session_id = ?`, [sessionId])?.count ?? 0;
    const items = this.db
      .select<DbTerminalEventRow>(
        `SELECT id, session_id, task_id, seq, event_type, content, raw_chunk_path, created_at
       FROM terminal_events WHERE session_id = ? ORDER BY seq ASC, created_at ASC LIMIT ? OFFSET ?`,
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

/** 对话仓储保存 AI 对话主记录与消息，不写入任何 seed 对话。 */
export class ConversationRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateConversationInput): ZeusConversationRecord {
    const timestamp = nowIso();
    const record: ZeusConversationRecord = {
      id: `conversation_${nanoid(12)}`,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      title: input.title,
      summary: input.summary ?? null,
      status: input.status ?? 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
      archived: false,
    };
    this.db.execute(
      `INSERT INTO conversations (id, project_id, task_id, session_id, title, summary, status, created_at, updated_at, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [record.id, record.projectId, record.taskId, record.sessionId, record.title, record.summary, record.status, record.createdAt, record.updatedAt],
    );
    return record;
  }

  appendMessage(input: AppendConversationMessageInput): ZeusConversationMessageRecord {
    const record: ZeusConversationMessageRecord = {
      id: `conversation_message_${nanoid(12)}`,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      source: input.source,
      metadataJson: JSON.stringify(input.metadata),
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO conversation_messages (id, conversation_id, role, content, source, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.conversationId, record.role, record.content, record.source, record.metadataJson, record.createdAt],
    );
    this.db.execute(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [record.createdAt, record.conversationId]);
    return record;
  }

  listMessages(conversationId: string): ZeusConversationMessageRecord[] {
    return this.db
      .select<DbConversationMessageRow>(
        `SELECT id, conversation_id, role, content, source, metadata_json, created_at
       FROM conversation_messages WHERE conversation_id = ${toSqlStringLiteral(conversationId)} ORDER BY created_at ASC, id ASC`,
      )
      .map(mapConversationMessageRow);
  }

  getById(conversationId: string): ZeusConversationWithMessagesRecord | undefined {
    const row = this.db.get<DbConversationRow>(
      `SELECT id, project_id, task_id, session_id, title, summary, status, created_at, updated_at, archived
       FROM conversations WHERE id = ${toSqlStringLiteral(conversationId)}`,
    );
    if (!row) return undefined;
    const conversation = mapConversationRow(row);
    return { ...conversation, messages: this.listMessages(conversation.id) };
  }

  listByProject(projectId: string, options: ConversationListOptions = {}): ConversationListResult {
    const query = options.query?.trim().toLowerCase() ?? '';
    const limit = clampConversationLimit(options.limit);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const archived = options.archived === true;
    const allRows = this.db.select<DbConversationRow>(
      `SELECT id, project_id, task_id, session_id, title, summary, status, created_at, updated_at, archived
       FROM conversations WHERE project_id = ${toSqlStringLiteral(projectId)} AND archived = ${archived ? 1 : 0} ORDER BY updated_at DESC, id DESC`,
    );
    const matchedRows = allRows.filter((row) => {
      if (!query) return true;
      const messages = this.listMessages(row.id);
      // 搜索覆盖标题、摘要、会话与消息正文，避免用户记得答案片段却找不到历史记录。
      return `${row.title}\n${row.summary ?? ''}\n${row.session_id ?? ''}\n${messages.map((message) => message.content).join('\n')}`.toLowerCase().includes(query);
    });
    const rows = matchedRows.slice(offset, offset + limit);
    return {
      items: rows.map((row) => {
        const conversation = mapConversationRow(row);
        return {
          ...conversation,
          messages: this.listMessages(conversation.id),
        };
      }),
      total: matchedRows.length,
      limit,
      offset,
      query: query || null,
      archived,
    };
  }

  archive(conversationId: string): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    const timestamp = nowIso();
    // 归档只隐藏会话列表，不删除消息，保证图谱问答证据链可恢复。
    this.db.execute(`UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ${toSqlStringLiteral(conversationId)}`, [1, timestamp]);
    const archived = this.getById(conversationId);
    if (!archived) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    return archived;
  }

  restore(conversationId: string): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    const timestamp = nowIso();
    this.db.execute(`UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ${toSqlStringLiteral(conversationId)}`, [0, timestamp]);
    const restored = this.getById(conversationId);
    if (!restored) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    return restored;
  }

  listByProjectLegacy(projectId: string, limit = 20): ZeusConversationWithMessagesRecord[] {
    return this.listByProject(projectId, { limit }).items;
  }
}

function clampConversationLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function toSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/** Git 快照仓储只记录状态与 diff 路径，不主动执行任何 Git 写操作。 */
export class GitSnapshotRepository {
  constructor(private readonly db: ZeusDatabase) {}

  createSnapshot(input: CreateGitSnapshotInput): ZeusGitSnapshotRecord {
    const record: ZeusGitSnapshotRecord = {
      id: `git_snapshot_${nanoid(12)}`,
      taskId: input.taskId,
      projectId: input.projectId,
      snapshotType: input.snapshotType,
      branch: input.branch ?? null,
      headSha: input.headSha ?? null,
      statusJson: JSON.stringify(input.status),
      diffTextPath: input.diffTextPath ?? null,
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO git_snapshots (id, task_id, project_id, snapshot_type, branch, head_sha, status_json, diff_text_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.taskId, record.projectId, record.snapshotType, record.branch, record.headSha, record.statusJson, record.diffTextPath, record.createdAt],
    );
    return record;
  }

  createChange(input: CreateGitChangeInput): ZeusGitChangeRecord {
    const record: ZeusGitChangeRecord = {
      id: `git_change_${nanoid(12)}`,
      taskId: input.taskId,
      projectId: input.projectId,
      filePath: input.filePath,
      changeType: input.changeType,
      additions: input.additions ?? 0,
      deletions: input.deletions ?? 0,
      diffHunkPath: input.diffHunkPath ?? null,
      linkedGraphNodesJson: JSON.stringify(input.linkedGraphNodes ?? []),
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO git_changes (id, task_id, project_id, file_path, change_type, additions, deletions, diff_hunk_path, linked_graph_nodes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.taskId, record.projectId, record.filePath, record.changeType, record.additions, record.deletions, record.diffHunkPath, record.linkedGraphNodesJson, record.createdAt],
    );
    return record;
  }

  listSnapshots(taskId: string): ZeusGitSnapshotRecord[] {
    return this.db
      .select<DbGitSnapshotRow>(
        `SELECT id, task_id, project_id, snapshot_type, branch, head_sha, status_json, diff_text_path, created_at
       FROM git_snapshots WHERE task_id = ? ORDER BY created_at ASC`,
        [taskId],
      )
      .map(mapGitSnapshotRow);
  }

  listChanges(taskId: string): ZeusGitChangeRecord[] {
    return this.db
      .select<DbGitChangeRow>(
        `SELECT id, task_id, project_id, file_path, change_type, additions, deletions, diff_hunk_path, linked_graph_nodes_json, created_at
       FROM git_changes WHERE task_id = ? ORDER BY file_path ASC, created_at ASC`,
        [taskId],
      )
      .map(mapGitChangeRow);
  }
}

/** 审计日志仓储记录真实本地/远程动作，payload 由调用方传入且不写入默认假数据。 */
export class AuditLogRepository {
  constructor(private readonly db: ZeusDatabase) {}

  append(input: AppendAuditLogInput): ZeusAuditLogRecord {
    const record: ZeusAuditLogRecord = {
      id: `audit_log_${nanoid(12)}`,
      actorType: input.actorType,
      actorRef: input.actorRef ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      payloadJson: JSON.stringify(input.payload),
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO audit_logs (id, actor_type, actor_ref, action, resource_type, resource_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.actorType, record.actorRef, record.action, record.resourceType, record.resourceId, record.payloadJson, record.createdAt],
    );
    return record;
  }

  listRecent(limit = 20): ZeusAuditLogRecord[] {
    return this.db
      .select<DbAuditLogRow>(
        `SELECT id, actor_type, actor_ref, action, resource_type, resource_id, payload_json, created_at
       FROM audit_logs ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        [limit],
      )
      .map(mapAuditLogRow);
  }
}

interface DbTaskEventRow {
  id: string;
  task_id: string;
  event_type: string;
  title: string;
  payload_json: string;
  created_at: string;
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
  created_at: string;
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

interface DbConversationRow {
  id: string;
  project_id: string;
  task_id: string | null;
  session_id: string | null;
  title: string;
  summary: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  archived: number;
}

interface DbConversationMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  source: string;
  metadata_json: string;
  created_at: string;
}

interface DbGitSnapshotRow {
  id: string;
  task_id: string;
  project_id: string;
  snapshot_type: string;
  branch: string | null;
  head_sha: string | null;
  status_json: string;
  diff_text_path: string | null;
  created_at: string;
}

interface DbGitChangeRow {
  id: string;
  task_id: string;
  project_id: string;
  file_path: string;
  change_type: string;
  additions: number;
  deletions: number;
  diff_hunk_path: string | null;
  linked_graph_nodes_json: string;
  created_at: string;
}

interface DbAuditLogRow {
  id: string;
  actor_type: string;
  actor_ref: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  payload_json: string;
  created_at: string;
}

interface DbSettingRow {
  key: string;
  value_json: string;
  updated_at: string;
}

interface DbProjectRow {
  id: string;
  name: string;
  slug: string;
  local_path: string;
  description: string | null;
  note: string | null;
  default_template_id: string | null;
  scan_status: ZeusProjectRecord['scanStatus'];
  created_at: string;
  updated_at: string;
}

interface DbTaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: ZeusTaskRecord['status'];
  tags_json: string;
  template_id: string | null;
  created_from: string;
  source_context_json: string;
  created_at: string;
  updated_at: string;
}

interface DbTaskTemplateRow {
  id: string;
  name: string;
  description: string;
  category: string;
  prompt_template: string;
  default_options_json: string;
  project_id: string | null;
  built_in: number;
  created_at: string;
  updated_at: string;
}

function mapTaskEventRow(row: DbTaskEventRow): ZeusTaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    eventType: row.event_type,
    title: row.title,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
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
  return `SELECT id, project_id, task_id, command, args_json, cwd, status, pid, exit_code, summary, favorite, archived, started_at, ended_at, created_at, updated_at, deleted_at
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

function mapConversationRow(row: DbConversationRow): ZeusConversationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
  };
}

function mapConversationMessageRow(row: DbConversationMessageRow): ZeusConversationMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    source: row.source,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
  };
}

function mapGitSnapshotRow(row: DbGitSnapshotRow): ZeusGitSnapshotRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    snapshotType: row.snapshot_type,
    branch: row.branch,
    headSha: row.head_sha,
    statusJson: row.status_json,
    diffTextPath: row.diff_text_path,
    createdAt: row.created_at,
  };
}

function mapGitChangeRow(row: DbGitChangeRow): ZeusGitChangeRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    filePath: row.file_path,
    changeType: row.change_type,
    additions: row.additions,
    deletions: row.deletions,
    diffHunkPath: row.diff_hunk_path,
    linkedGraphNodesJson: row.linked_graph_nodes_json,
    createdAt: row.created_at,
  };
}

function mapAuditLogRow(row: DbAuditLogRow): ZeusAuditLogRecord {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorRef: row.actor_ref,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function mapProjectRow(row: DbProjectRow): ZeusProjectRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    localPath: row.local_path,
    description: row.description,
    note: row.note,
    defaultTemplateId: row.default_template_id,
    scanStatus: row.scan_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskRow(row: DbTaskRow): ZeusTaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    templateId: row.template_id,
    tags: parseTagsJson(row.tags_json),
    createdFrom: row.created_from,
    sourceContextJson: row.source_context_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskTemplateRow(row: DbTaskTemplateRow): ZeusTaskTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    promptTemplate: row.prompt_template,
    defaultOptionsJson: row.default_options_json,
    projectId: row.project_id,
    builtIn: row.built_in === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
