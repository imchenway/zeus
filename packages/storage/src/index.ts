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
  taskCode: string;
  taskSequence: number | null;
  title: string;
  description: string;
  status: 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';
  priority: string;
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowGitCommit: boolean;
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
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
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
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
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
  transportKind: ConversationTransportKind;
  providerId: string | null;
  providerThreadId: string | null;
  providerThreadPath: string | null;
  providerModel: string | null;
  providerState: ConversationProviderState;
  providerProtocolVersion: string | null;
  providerBinaryVersion: string | null;
  legacySourceConversationId: string | null;
  providerSettingsJson: string;
  providerTokenUsageJson: string;
  permissionMode: ConversationPermissionMode;
}

export type ConversationTransportKind = 'legacy_cli' | 'codex_native';
export type ConversationProviderState = 'unbound' | 'binding' | 'ready' | 'active' | 'waiting' | 'paused' | 'closed' | 'failed';
export type ConversationPermissionMode = 'read-only' | 'auto' | 'full-access';

export interface ZeusConversationMessageRecord {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadataJson: string;
  createdAt: string;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerItemId: string | null;
  clientMessageId: string | null;
}

export interface ZeusConversationWithMessagesRecord extends ZeusConversationRecord {
  messages: ZeusConversationMessageRecord[];
}

export type CodexLegacyImportStatus = 'prepared' | 'waiting' | 'completed' | 'failed';

export interface ZeusCodexLegacyImportRecord {
  id: string;
  providerImportId: string | null;
  sourceConversationId: string;
  targetConversationId: string | null;
  snapshotPath: string;
  snapshotSha256: string;
  status: CodexLegacyImportStatus;
  targetThreadId: string | null;
  failureStage: string | null;
  failureMessage: string | null;
  providerBinaryVersion: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CreateCodexLegacyImportRunInput {
  sourceConversationId: string;
  snapshotPath: string;
  snapshotSha256: string;
  providerBinaryVersion: string;
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
  id?: string;
  projectId: string;
  taskId?: string;
  sessionId?: string;
  title: string;
  summary?: string;
  status?: string;
  transportKind?: ConversationTransportKind;
  providerId?: string;
  providerThreadId?: string;
  providerThreadPath?: string;
  providerModel?: string;
  providerState?: ConversationProviderState;
  providerProtocolVersion?: string;
  providerBinaryVersion?: string;
  legacySourceConversationId?: string;
  permissionMode?: ConversationPermissionMode;
}

export interface AppendConversationMessageInput {
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  clientMessageId?: string;
}

export interface UpdateConversationRuntimeStateInput {
  sessionId?: string | null;
  status?: string;
  summary?: string | null;
}

export interface BindConversationProviderInput {
  providerId: string;
  providerThreadId: string;
  providerThreadPath?: string | null;
  providerModel?: string | null;
  providerState: ConversationProviderState;
  providerProtocolVersion?: string | null;
  providerBinaryVersion?: string | null;
}

export interface ProviderSequenceSnapshot {
  generationId: string;
  sequence: number;
}

export interface ConversationProviderSettingsSnapshot extends ProviderSequenceSnapshot {
  model: string;
  effort?: string;
}

export interface ConversationProviderTokenUsageSnapshot extends ProviderSequenceSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type ProviderVisibleJson = null | boolean | number | string | ProviderVisibleJson[] | { [key: string]: ProviderVisibleJson };
export interface CodexRateLimitWindowState {
  remaining?: number;
  usedPercent?: number;
  resetsAt?: number | string | null;
}
export interface CodexRateLimitCreditsState {
  balance?: number | string | null;
  unlimited?: boolean;
}
export interface CodexRateLimitsState {
  primary?: CodexRateLimitWindowState;
  secondary?: CodexRateLimitWindowState;
  credits?: CodexRateLimitCreditsState;
  planType?: string;
}
export interface CodexRateLimitsSnapshot extends ProviderSequenceSnapshot {
  value: CodexRateLimitsState;
}
export type CodexMcpServerStartupState = string | { status: string; error?: string | null };
export interface CodexMcpStartupStatusSnapshot extends ProviderSequenceSnapshot {
  value: Record<string, CodexMcpServerStartupState>;
}

export type ConversationTurnStatus = 'queued' | 'dispatching' | 'running' | 'waiting' | 'paused' | 'completed' | 'interrupted' | 'failed';
export interface ZeusConversationTurnRecord {
  id: string;
  conversationId: string;
  providerThreadId: string;
  providerTurnId: string | null;
  clientSubmissionId: string;
  status: ConversationTurnStatus;
  errorJson: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ConversationItemType = 'userMessage' | 'agentMessage' | 'reasoning' | 'commandExecution' | 'fileChange' | 'mcpToolCall' | 'dynamicToolCall' | 'plan' | 'imageView' | 'webSearch' | 'error';
export type ConversationItemStatus = 'in_progress' | 'completed' | 'failed';
export type ConversationItemPhase = 'prework' | 'final_answer';
export interface ZeusConversationItemRecord {
  id: string;
  conversationId: string;
  turnId: string;
  providerThreadId: string;
  providerTurnId: string;
  providerItemId: string;
  itemType: ConversationItemType;
  status: ConversationItemStatus;
  phase: ConversationItemPhase;
  textContent: string;
  payloadJson: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type ConversationSubmissionKind = 'message' | 'steer';
export type ConversationRequestedDelivery = 'queue' | 'send_now';
export type ConversationSubmissionStatus = 'queued' | 'dispatching' | 'active' | 'paused' | 'completed' | 'resolved' | 'failed' | 'cancelled' | 'deleted';
export interface ZeusConversationSubmissionRecord {
  id: string;
  conversationId: string;
  idempotencyKey: string;
  requestHash: string;
  clientMessageId: string;
  kind: ConversationSubmissionKind;
  requestedDelivery: ConversationRequestedDelivery;
  status: ConversationSubmissionStatus;
  queuePosition: number | null;
  inputJson: string;
  targetProviderTurnId: string | null;
  providerTurnId: string | null;
  pausedReason: string | null;
  errorJson: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  resolvedAt: string | null;
}

export type ConversationServerRequestKind = 'command' | 'file' | 'permissions' | 'request_user_input' | 'mcp';
export type ConversationServerRequestStatus = 'pending' | 'resolved' | 'declined' | 'expired' | 'failed';
export interface ZeusConversationServerRequestRecord {
  id: string;
  conversationId: string;
  turnId: string | null;
  itemId: string | null;
  transportGenerationId: string;
  providerRequestIdJson: string;
  requestKind: ConversationServerRequestKind;
  payloadJson: string;
  status: ConversationServerRequestStatus;
  responseJson: string | null;
  containsSecret: boolean;
  expiresAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type IdempotencyRequestStatus = 'in_progress' | 'completed' | 'failed';
export interface ZeusIdempotencyRequestRecord {
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  status: IdempotencyRequestStatus;
  httpStatus: number | null;
  responseJson: string | null;
  resourceId: string | null;
  createdAt: string;
  updatedAt: string;
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

  transaction<T>(operation: () => T): T {
    this.execute('BEGIN');
    try {
      const result = operation();
      this.execute('COMMIT');
      return result;
    } catch (error) {
      this.execute('ROLLBACK');
      throw error;
    }
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
  migrateCodexNativeConversationSchema(zeusDb);
  migrateCodexLegacyImportSchema(zeusDb);
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
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN task_code TEXT`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN task_sequence INTEGER`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }

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
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_task_code ON tasks(project_id, task_code)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_sequence ON tasks(project_id, task_sequence)`,
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
  backfillMissingTaskCodes(db);
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

function migrateCodexNativeConversationSchema(db: ZeusDatabase): void {
  for (const statement of [
    `ALTER TABLE conversations ADD COLUMN transport_kind TEXT NOT NULL DEFAULT 'legacy_cli'`,
    `ALTER TABLE conversations ADD COLUMN provider_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_thread_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_thread_path TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_model TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_state TEXT NOT NULL DEFAULT 'unbound'`,
    `ALTER TABLE conversations ADD COLUMN provider_protocol_version TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_binary_version TEXT`,
    `ALTER TABLE conversations ADD COLUMN legacy_source_conversation_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_settings_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE conversations ADD COLUMN provider_token_usage_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'read-only'`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // sql.js 不支持 ADD COLUMN IF NOT EXISTS；重复打开数据库时忽略已存在字段。
    }
  }

  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_provider_thread_id ON conversations(provider_thread_id) WHERE provider_thread_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_task_updated_at ON conversations(task_id, updated_at)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
      provider_turn_id TEXT, client_submission_id TEXT NOT NULL, status TEXT NOT NULL,
      error_json TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turn_provider ON conversation_turns(provider_thread_id, provider_turn_id) WHERE provider_turn_id IS NOT NULL`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_items (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, provider_item_id TEXT NOT NULL,
      item_type TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, text_content TEXT NOT NULL,
      payload_json TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_item_provider ON conversation_items(provider_thread_id, provider_item_id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_submissions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, client_message_id TEXT NOT NULL, kind TEXT NOT NULL,
      requested_delivery TEXT NOT NULL, status TEXT NOT NULL, queue_position INTEGER,
      input_json TEXT NOT NULL, target_provider_turn_id TEXT, provider_turn_id TEXT,
      paused_reason TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      dispatched_at TEXT, resolved_at TEXT
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_submission_idempotency ON conversation_submissions(conversation_id, idempotency_key)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_server_requests (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT, item_id TEXT,
      transport_generation_id TEXT NOT NULL, provider_request_id_json TEXT NOT NULL,
      request_kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
      response_json TEXT, contains_secret INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_server_request_provider ON conversation_server_requests(transport_generation_id, provider_request_id_json)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS idempotency_requests (
      scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      status TEXT NOT NULL, http_status INTEGER, response_json TEXT, resource_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, idempotency_key)
    )
  `);

  for (const statement of [
    `ALTER TABLE conversation_messages ADD COLUMN provider_thread_id TEXT`,
    `ALTER TABLE conversation_messages ADD COLUMN provider_turn_id TEXT`,
    `ALTER TABLE conversation_messages ADD COLUMN provider_item_id TEXT`,
    `ALTER TABLE conversation_messages ADD COLUMN client_message_id TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // sql.js 不支持 ADD COLUMN IF NOT EXISTS；重复打开数据库时忽略已存在字段。
    }
  }
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_provider_item ON conversation_messages(conversation_id, provider_item_id) WHERE provider_item_id IS NOT NULL`);

  recordSchemaMigration(db, {
    migrationId: '20260713_0002_codex_native_conversation',
    description: '增加 Codex native 会话运行表、唯一身份与本地幂等',
    checksumSource: 'codex_native_conversation:conversation_transport_provider,turns,items,submissions,server_requests,idempotency_requests,message_provider_identity,indexes,v1',
  });
  recordSchemaMigration(db, {
    migrationId: '20260715_0004_conversation_permission_mode',
    description: '增加 Codex native 会话权限模式事实源',
    checksumSource: 'conversations:permission_mode:read-only,auto,full-access:v1',
  });
}

function migrateCodexLegacyImportSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS codex_legacy_imports (
      id TEXT PRIMARY KEY,
      provider_import_id TEXT,
      source_conversation_id TEXT NOT NULL,
      target_conversation_id TEXT,
      snapshot_path TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      target_thread_id TEXT,
      failure_stage TEXT,
      failure_message TEXT,
      provider_binary_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_legacy_import_source_snapshot ON codex_legacy_imports(source_conversation_id, snapshot_sha256)`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_legacy_import_target_thread ON codex_legacy_imports(target_thread_id) WHERE target_thread_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_legacy_import_provider_import ON codex_legacy_imports(provider_import_id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_legacy_import_status ON codex_legacy_imports(status, updated_at)`);
  recordSchemaMigration(db, {
    migrationId: '20260714_0003_codex_legacy_import',
    description: '增加 Codex legacy 会话导入快照映射、恢复状态与唯一身份',
    checksumSource: 'codex_legacy_imports:source_snapshot,target_thread,provider_import,status,v1',
  });
}

function backfillMissingTaskCodes(db: ZeusDatabase): void {
  const projectIds = db.select<{ project_id: string }>(`SELECT DISTINCT project_id FROM tasks WHERE deleted_at IS NULL ORDER BY project_id ASC`).map((row) => row.project_id);
  for (const projectId of projectIds) {
    const rows = db.select<{ id: string; task_sequence: number | null; task_code: string | null }>(`SELECT id, task_sequence, task_code FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`, [projectId]);
    const firstSequenceOwnerIds = new Map<number, string>();
    for (const row of rows) {
      const currentSequence = normalizeTaskSequence(row.task_sequence);
      if (currentSequence && !firstSequenceOwnerIds.has(currentSequence)) {
        firstSequenceOwnerIds.set(currentSequence, row.id);
      }
    }
    let nextSequence = 1;
    const usedSequences = new Set<number>();
    for (const row of rows) {
      // 预先保留每个合法序号的第一拥有者，避免空/非法行抢占后续合法任务编码。
      const currentSequence = normalizeTaskSequence(row.task_sequence);
      const isFirstSequenceOwner = currentSequence !== null && firstSequenceOwnerIds.get(currentSequence) === row.id;
      while (firstSequenceOwnerIds.has(nextSequence) || usedSequences.has(nextSequence)) nextSequence += 1;
      const sequence = isFirstSequenceOwner && currentSequence !== null ? currentSequence : nextSequence;
      usedSequences.add(sequence);
      nextSequence = Math.max(nextSequence, sequence + 1);
      const code = formatTaskCode(sequence);
      if (row.task_sequence !== sequence || row.task_code !== code) {
        db.execute(`UPDATE tasks SET task_sequence = ?, task_code = ? WHERE id = ?`, [sequence, code, row.id]);
      }
    }
  }
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

function formatTaskCode(sequence: number): string {
  return `ZEU-${String(sequence).padStart(6, '0')}`;
}

function normalizeTaskSequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeTaskCode(value: unknown, sequence: number | null): string {
  if (typeof value === 'string') {
    const code = value.trim();
    // 只保留统一展示格式；旧库里的 ZEU-1、ABC-1 等不规范编码必须按序号重算。
    if (/^ZEU-\d{6}$/u.test(code)) return code;
  }
  return formatTaskCode(sequence ?? 1);
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
    const matchesQuery = !query || [record.taskCode, record.id, record.title, record.description, record.createdFrom, record.sourceContextJson, record.priority].join('\n').toLowerCase().includes(query);
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

  upsertCodexRateLimitsSnapshot(snapshot: CodexRateLimitsSnapshot): CodexRateLimitsSnapshot | undefined {
    return this.upsertSequencedSnapshot('codex.native.rate_limits', snapshot);
  }

  getCodexRateLimitsSnapshot(): CodexRateLimitsSnapshot | undefined {
    return this.getJson<CodexRateLimitsSnapshot>('codex.native.rate_limits');
  }

  upsertCodexMcpStartupStatusSnapshot(snapshot: CodexMcpStartupStatusSnapshot): CodexMcpStartupStatusSnapshot | undefined {
    return this.upsertSequencedSnapshot('codex.native.mcp_startup_status', snapshot);
  }

  getCodexMcpStartupStatusSnapshot(): CodexMcpStartupStatusSnapshot | undefined {
    return this.getJson<CodexMcpStartupStatusSnapshot>('codex.native.mcp_startup_status');
  }

  private upsertSequencedSnapshot<T extends CodexRateLimitsSnapshot | CodexMcpStartupStatusSnapshot>(key: 'codex.native.rate_limits' | 'codex.native.mcp_startup_status', snapshot: T): T | undefined {
    if (key === 'codex.native.rate_limits') validateRateLimitsSnapshot(snapshot);
    else validateMcpStartupStatusSnapshot(snapshot);
    const current = this.getJson<T>(key);
    if (!shouldAcceptProviderSnapshot(this.db, snapshot, current)) return current;
    this.setJson(key, snapshot);
    return snapshot;
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

  recoverInterruptedScans(activeProjectIds: readonly string[] = []): number {
    const timestamp = nowIso();
    const activeIds = activeProjectIds.filter((id) => typeof id === 'string' && id.length > 0);
    const activeFilter = activeIds.length > 0 ? ` AND id NOT IN (${activeIds.map(() => '?').join(', ')})` : '';
    const interrupted = this.db.select<{ id: string }>(`SELECT id FROM projects WHERE scan_status = 'scanning' AND deleted_at IS NULL${activeFilter}`, activeIds);
    if (interrupted.length === 0) return 0;
    // 扫描是进程内任务；无本进程所有权的 scanning 只能来自上次异常退出或旧版本崩溃残留，恢复为 failed 让用户可以重试。
    this.db.execute(`UPDATE projects SET scan_status = 'failed', updated_at = ? WHERE scan_status = 'scanning' AND deleted_at IS NULL${activeFilter}`, [timestamp, ...activeIds]);
    return interrupted.length;
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

const selectTaskFields = `id, project_id, task_code, task_sequence, title, description, status, priority, tags_json, template_id,
  allow_code_changes, allow_tests, allow_git_commit, created_from, source_context_json, created_at, updated_at`;

/** 任务仓储保存真实任务定义，初始状态统一为 ready，等待用户或 runtime 执行。 */
export class TaskRepository {
  constructor(private readonly db: ZeusDatabase) {}

  private nextTaskSequence(projectId: string): number {
    // 任务编码按项目内未删除任务的最大序号递增，保持与当前列表/回填口径一致。
    const row = this.db.get<{ sequence: number | null }>(`SELECT MAX(task_sequence) AS sequence FROM tasks WHERE project_id = ? AND deleted_at IS NULL`, [projectId]);
    return (row?.sequence ?? 0) + 1;
  }

  create(input: CreateTaskInput): ZeusTaskRecord {
    const timestamp = nowIso();
    const taskSequence = this.nextTaskSequence(input.projectId);
    const record: ZeusTaskRecord = {
      id: `task_${nanoid(12)}`,
      projectId: input.projectId,
      taskCode: formatTaskCode(taskSequence),
      taskSequence,
      title: input.title,
      description: input.description,
      status: 'ready',
      priority: 'normal',
      allowCodeChanges: input.allowCodeChanges === true,
      allowTests: input.allowTests === true,
      allowGitCommit: input.allowGitCommit === true,
      templateId: input.templateId ?? null,
      tags: normalizeTags(input.tags ?? []),
      createdFrom: input.createdFrom,
      sourceContextJson: JSON.stringify(input.sourceContext),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO tasks (id, project_id, task_code, task_sequence, title, description, status, priority, tags_json, template_id,
        allow_code_changes, allow_tests, allow_git_commit, created_from, source_context_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.taskCode,
        record.taskSequence,
        record.title,
        record.description,
        record.status,
        record.priority,
        JSON.stringify(record.tags),
        record.templateId,
        record.allowCodeChanges ? 1 : 0,
        record.allowTests ? 1 : 0,
        record.allowGitCommit ? 1 : 0,
        record.createdFrom,
        record.sourceContextJson,
        record.createdAt,
        record.updatedAt,
      ],
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
      `SELECT ${selectTaskFields}
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
    this.db.execute(`UPDATE tasks SET title = ?, description = ?, allow_code_changes = ?, allow_tests = ?, allow_git_commit = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [
      input.title ?? existing.title,
      input.description ?? existing.description,
      (input.allowCodeChanges ?? existing.allowCodeChanges) ? 1 : 0,
      (input.allowTests ?? existing.allowTests) ? 1 : 0,
      (input.allowGitCommit ?? existing.allowGitCommit) ? 1 : 0,
      timestamp,
      taskId,
    ]);
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
        `SELECT ${selectTaskFields}
       FROM tasks WHERE archived = 0 AND deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .map(mapTaskRow);
    return filterAndSortTasks(records, options);
  }

  listByProject(projectId: string, options: TaskListOptions = {}): ZeusTaskRecord[] {
    const records = this.db
      .select<DbTaskRow>(
        `SELECT ${selectTaskFields}
       FROM tasks WHERE project_id = ? AND archived = 0 AND deleted_at IS NULL ORDER BY created_at ASC`,
        [projectId],
      )
      .map(mapTaskRow);
    return filterAndSortTasks(records, options);
  }

  listArchivedByProject(projectId: string, options: TaskListOptions = {}): ZeusTaskRecord[] {
    const records = this.db
      .select<DbTaskRow>(
        `SELECT ${selectTaskFields}
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

const selectConversationFields = `id, project_id, task_id, session_id, title, summary, status, created_at, updated_at, archived,
  transport_kind, provider_id, provider_thread_id, provider_thread_path, provider_model, provider_state,
  provider_protocol_version, provider_binary_version, legacy_source_conversation_id, provider_settings_json, provider_token_usage_json, permission_mode`;
const selectConversationMessageFields = `id, conversation_id, role, content, source, metadata_json, created_at,
  provider_thread_id, provider_turn_id, provider_item_id, client_message_id`;

/** 对话仓储保存 AI 对话主记录与消息，不写入任何 seed 对话。 */
export class ConversationRepository {
  constructor(private readonly db: ZeusDatabase) {}

  create(input: CreateConversationInput): ZeusConversationRecord {
    const transportKind = assertEnum(input.transportKind ?? 'legacy_cli', ['legacy_cli', 'codex_native'] as const, 'conversation transport kind');
    const providerState = assertEnum(input.providerState ?? 'unbound', ['unbound', 'binding', 'ready', 'active', 'waiting', 'paused', 'closed', 'failed'] as const, 'conversation provider state');
    const permissionMode = assertEnum(input.permissionMode ?? 'read-only', ['read-only', 'auto', 'full-access'] as const, 'conversation permission mode');
    const timestamp = nowIso();
    const record: ZeusConversationRecord = {
      id: input.id ?? `conversation_${nanoid(12)}`,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      title: input.title,
      summary: input.summary ?? null,
      status: input.status ?? 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
      archived: false,
      transportKind,
      providerId: input.providerId ?? null,
      providerThreadId: input.providerThreadId ?? null,
      providerThreadPath: input.providerThreadPath ?? null,
      providerModel: input.providerModel ?? null,
      providerState,
      providerProtocolVersion: input.providerProtocolVersion ?? null,
      providerBinaryVersion: input.providerBinaryVersion ?? null,
      legacySourceConversationId: input.legacySourceConversationId ?? null,
      providerSettingsJson: '{}',
      providerTokenUsageJson: '{}',
      permissionMode,
    };
    this.db.execute(
      `INSERT INTO conversations (id, project_id, task_id, session_id, title, summary, status, created_at, updated_at, archived,
        transport_kind, provider_id, provider_thread_id, provider_thread_path, provider_model, provider_state,
        provider_protocol_version, provider_binary_version, legacy_source_conversation_id, provider_settings_json, provider_token_usage_json, permission_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.taskId,
        record.sessionId,
        record.title,
        record.summary,
        record.status,
        record.createdAt,
        record.updatedAt,
        record.transportKind,
        record.providerId,
        record.providerThreadId,
        record.providerThreadPath,
        record.providerModel,
        record.providerState,
        record.providerProtocolVersion,
        record.providerBinaryVersion,
        record.legacySourceConversationId,
        record.providerSettingsJson,
        record.providerTokenUsageJson,
        record.permissionMode,
      ],
    );
    return record;
  }

  updatePermissionMode(conversationId: string, permissionMode: ConversationPermissionMode): ZeusConversationWithMessagesRecord {
    const normalized = assertEnum(permissionMode, ['read-only', 'auto', 'full-access'] as const, 'conversation permission mode');
    this.db.execute(`UPDATE conversations SET permission_mode = ?, updated_at = ? WHERE id = ?`, [normalized, nowIso(), conversationId]);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
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
      providerThreadId: input.providerThreadId ?? null,
      providerTurnId: input.providerTurnId ?? null,
      providerItemId: input.providerItemId ?? null,
      clientMessageId: input.clientMessageId ?? null,
    };
    const params = [record.id, record.conversationId, record.role, record.content, record.source, record.metadataJson, record.createdAt, record.providerThreadId, record.providerTurnId, record.providerItemId, record.clientMessageId];
    if (record.providerItemId) {
      this.db.execute(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, provider_item_id) WHERE provider_item_id IS NOT NULL DO UPDATE SET
           role = excluded.role, content = excluded.content, source = excluded.source, metadata_json = excluded.metadata_json,
           provider_thread_id = excluded.provider_thread_id, provider_turn_id = excluded.provider_turn_id,
           client_message_id = excluded.client_message_id`,
        params,
      );
    } else {
      this.db.execute(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params,
      );
    }
    this.db.execute(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [record.createdAt, record.conversationId]);
    if (!record.providerItemId) return record;
    return this.db
      .select<DbConversationMessageRow>(`SELECT ${selectConversationMessageFields} FROM conversation_messages WHERE conversation_id = ? AND provider_item_id = ?`, [record.conversationId, record.providerItemId])
      .map(mapConversationMessageRow)[0]!;
  }

  bindProvider(conversationId: string, input: BindConversationProviderInput): ZeusConversationWithMessagesRecord {
    assertEnum(input.providerState, ['unbound', 'binding', 'ready', 'active', 'waiting', 'paused', 'closed', 'failed'] as const, 'conversation provider state');
    const timestamp = nowIso();
    this.db.execute(
      `UPDATE conversations SET transport_kind = 'codex_native', provider_id = ?, provider_thread_id = ?, provider_thread_path = COALESCE(?, provider_thread_path),
       provider_model = COALESCE(?, provider_model), provider_state = ?, provider_protocol_version = COALESCE(?, provider_protocol_version), provider_binary_version = COALESCE(?, provider_binary_version), updated_at = ? WHERE id = ?`,
      [input.providerId, input.providerThreadId, input.providerThreadPath ?? null, input.providerModel ?? null, input.providerState, input.providerProtocolVersion ?? null, input.providerBinaryVersion ?? null, timestamp, conversationId],
    );
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  upsertProviderSettingsSnapshot(conversationId: string, snapshot: ConversationProviderSettingsSnapshot): ConversationProviderSettingsSnapshot | undefined {
    return this.upsertConversationSnapshot(conversationId, 'provider_settings_json', snapshot);
  }

  getProviderSettingsSnapshot(conversationId: string): ConversationProviderSettingsSnapshot | undefined {
    return this.getConversationSnapshot<ConversationProviderSettingsSnapshot>(conversationId, 'provider_settings_json');
  }

  upsertProviderTokenUsageSnapshot(conversationId: string, snapshot: ConversationProviderTokenUsageSnapshot): ConversationProviderTokenUsageSnapshot | undefined {
    return this.upsertConversationSnapshot(conversationId, 'provider_token_usage_json', snapshot);
  }

  getProviderTokenUsageSnapshot(conversationId: string): ConversationProviderTokenUsageSnapshot | undefined {
    return this.getConversationSnapshot<ConversationProviderTokenUsageSnapshot>(conversationId, 'provider_token_usage_json');
  }

  private upsertConversationSnapshot<T extends ProviderSequenceSnapshot>(conversationId: string, column: 'provider_settings_json' | 'provider_token_usage_json', snapshot: T): T | undefined {
    if (column === 'provider_settings_json') validateProviderSettingsSnapshot(snapshot);
    else validateProviderTokenUsageSnapshot(snapshot);
    const current = this.getConversationSnapshot<T>(conversationId, column);
    if (!shouldAcceptProviderSnapshot(this.db, snapshot, current)) return current;
    this.db.execute(`UPDATE conversations SET ${column} = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(snapshot), nowIso(), conversationId]);
    if (!this.db.get<{ id: string }>(`SELECT id FROM conversations WHERE id = ?`, [conversationId])) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return snapshot;
  }

  private getConversationSnapshot<T extends ProviderSequenceSnapshot>(conversationId: string, column: 'provider_settings_json' | 'provider_token_usage_json'): T | undefined {
    const row = this.db.get<{ value_json: string }>(`SELECT ${column} AS value_json FROM conversations WHERE id = ?`, [conversationId]);
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.value_json) as T;
      return typeof parsed.generationId === 'string' && typeof parsed.sequence === 'number' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  updateRuntimeState(conversationId: string, input: UpdateConversationRuntimeStateInput): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    const timestamp = nowIso();
    const assignments = ['updated_at = ?'];
    const values: Array<string | number | null> = [timestamp];
    if ('sessionId' in input) {
      assignments.push('session_id = ?');
      values.push(input.sessionId ?? null);
    }
    if ('status' in input) {
      assignments.push('status = ?');
      values.push(input.status ?? existing.status);
    }
    if ('summary' in input) {
      assignments.push('summary = ?');
      values.push(input.summary ?? null);
    }
    this.db.execute(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`, [...values, conversationId]);
    const updated = this.getById(conversationId);
    if (!updated) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    return updated;
  }

  listMessages(conversationId: string): ZeusConversationMessageRecord[] {
    return this.db
      .select<DbConversationMessageRow>(
        `SELECT ${selectConversationMessageFields}
       FROM conversation_messages WHERE conversation_id = ${toSqlStringLiteral(conversationId)} ORDER BY created_at ASC, id ASC`,
      )
      .map(mapConversationMessageRow);
  }

  getById(conversationId: string): ZeusConversationWithMessagesRecord | undefined {
    const row = this.db.get<DbConversationRow>(
      `SELECT ${selectConversationFields}
       FROM conversations WHERE id = ${toSqlStringLiteral(conversationId)}`,
    );
    if (!row) return undefined;
    const conversation = mapConversationRow(row);
    return { ...conversation, messages: this.listMessages(conversation.id) };
  }

  getByProviderThreadId(providerThreadId: string): ZeusConversationWithMessagesRecord | undefined {
    const row = this.db.get<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE provider_thread_id = ? AND archived = 0`, [providerThreadId]);
    if (!row) return undefined;
    const conversation = mapConversationRow(row);
    return { ...conversation, messages: this.listMessages(conversation.id) };
  }

  listNativeBound(): ZeusConversationWithMessagesRecord[] {
    return this.db
      .select<DbConversationRow>(
        `SELECT ${selectConversationFields} FROM conversations WHERE transport_kind = 'codex_native' AND provider_thread_id IS NOT NULL AND provider_state NOT IN ('closed', 'failed') AND archived = 0 ORDER BY created_at, id`,
      )
      .map((row) => {
        const conversation = mapConversationRow(row);
        return { ...conversation, messages: this.listMessages(conversation.id) };
      });
  }

  listBySessionId(sessionId: string): ZeusConversationWithMessagesRecord[] {
    return this.db
      .select<DbConversationRow>(
        `SELECT ${selectConversationFields}
       FROM conversations WHERE session_id = ${toSqlStringLiteral(sessionId)} ORDER BY updated_at DESC, id DESC`,
      )
      .map((row) => {
        const conversation = mapConversationRow(row);
        return { ...conversation, messages: this.listMessages(conversation.id) };
      });
  }

  listByProject(projectId: string, options: ConversationListOptions = {}): ConversationListResult {
    const query = options.query?.trim().toLowerCase() ?? '';
    const limit = clampConversationLimit(options.limit);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const archived = options.archived === true;
    const allRows = this.db.select<DbConversationRow>(
      `SELECT ${selectConversationFields}
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

export class CodexLegacyImportRepository {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(
    private readonly db: ZeusDatabase,
    options: { now?: () => string; id?: () => string } = {},
  ) {
    this.now = options.now ?? nowIso;
    this.createId = options.id ?? (() => `codex_legacy_import_${nanoid(12)}`);
  }

  createRun(input: CreateCodexLegacyImportRunInput): ZeusCodexLegacyImportRecord {
    const existing = this.db.get<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE source_conversation_id = ? AND snapshot_sha256 = ?`, [input.sourceConversationId, input.snapshotSha256]);
    if (existing) return mapCodexLegacyImportRow(existing);
    if (!/^[a-f0-9]{64}$/u.test(input.snapshotSha256)) throw new Error('Codex legacy snapshot SHA-256 is invalid.');
    const source = this.db.get<{ id: string }>(`SELECT id FROM conversations WHERE id = ?`, [input.sourceConversationId]);
    if (!source) throw new Error(`Codex legacy source conversation not found: ${input.sourceConversationId}`);
    const timestamp = this.now();
    const id = this.createId();
    this.db.execute(
      `INSERT INTO codex_legacy_imports
       (id, provider_import_id, source_conversation_id, target_conversation_id, snapshot_path, snapshot_sha256, status,
        target_thread_id, failure_stage, failure_message, provider_binary_version, created_at, updated_at, started_at, completed_at)
       VALUES (?, NULL, ?, NULL, ?, ?, 'prepared', NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      [id, input.sourceConversationId, input.snapshotPath, input.snapshotSha256, input.providerBinaryVersion, timestamp, timestamp],
    );
    return this.getById(id)!;
  }

  getById(id: string): ZeusCodexLegacyImportRecord | undefined {
    const row = this.db.get<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE id = ?`, [id]);
    return row ? mapCodexLegacyImportRow(row) : undefined;
  }

  getByImportId(providerImportId: string): ZeusCodexLegacyImportRecord[] {
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE provider_import_id = ? ORDER BY created_at, id`, [providerImportId]).map(mapCodexLegacyImportRow);
  }

  listBySourceConversation(sourceConversationId: string): ZeusCodexLegacyImportRecord[] {
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE source_conversation_id = ? ORDER BY created_at DESC, id DESC`, [sourceConversationId]).map(mapCodexLegacyImportRow);
  }

  listRecoverable(): ZeusCodexLegacyImportRecord[] {
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE status IN ('prepared', 'waiting') ORDER BY created_at, id`).map(mapCodexLegacyImportRow);
  }

  listRecent(limit = 100): ZeusCodexLegacyImportRecord[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports ORDER BY updated_at DESC, id DESC LIMIT ?`, [safeLimit]).map(mapCodexLegacyImportRow);
  }

  markStarted(id: string, providerImportId: string): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status !== 'prepared') throw new Error(`Invalid Codex legacy import transition: ${record.status} -> waiting.`);
    if (!providerImportId.trim()) throw new Error('Codex legacy provider import id is required.');
    const timestamp = this.now();
    this.db.execute(
      `UPDATE codex_legacy_imports SET provider_import_id = ?, status = 'waiting', failure_stage = NULL, failure_message = NULL,
       started_at = ?, updated_at = ? WHERE id = ?`,
      [providerImportId, timestamp, timestamp, id],
    );
    return this.requireById(id);
  }

  markCompleted(id: string, targetThreadId: string, targetConversationId: string): ZeusCodexLegacyImportRecord {
    const record = this.requireTransition(id, 'waiting', 'completed');
    if (!targetThreadId.trim() || !targetConversationId.trim()) throw new Error('Codex legacy import completion requires target identities.');
    const timestamp = this.now();
    this.db.execute(
      `UPDATE codex_legacy_imports SET status = 'completed', target_thread_id = ?, target_conversation_id = ?,
       failure_stage = NULL, failure_message = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?`,
      [targetThreadId, targetConversationId, timestamp, timestamp, id, record.status],
    );
    return this.requireById(id);
  }

  markFailed(id: string, input: { stage: string; message: string }): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status === 'completed') throw new Error('Invalid Codex legacy import transition: completed -> failed.');
    const timestamp = this.now();
    this.db.execute(`UPDATE codex_legacy_imports SET status = 'failed', failure_stage = ?, failure_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [input.stage, input.message, timestamp, timestamp, id]);
    return this.requireById(id);
  }

  retryFailed(id: string): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status !== 'failed') throw new Error(`Invalid Codex legacy import transition: ${record.status} -> prepared.`);
    const timestamp = this.now();
    this.db.execute(
      `UPDATE codex_legacy_imports SET provider_import_id = NULL, status = 'prepared', target_thread_id = NULL,
       target_conversation_id = NULL, failure_stage = NULL, failure_message = NULL, started_at = NULL,
       completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'failed'`,
      [timestamp, id],
    );
    return this.requireById(id);
  }

  bindThreadAndArchiveSource(input: { id: string; targetThreadId: string; providerBinaryVersion: string }): { run: ZeusCodexLegacyImportRecord; conversation: ZeusConversationWithMessagesRecord } {
    if (!input.targetThreadId.trim()) throw new Error('Codex legacy import target thread id is required.');
    const run = this.requireTransition(input.id, 'waiting', 'completed');
    const targetConversationId = `conversation_${nanoid(12)}`;
    this.db.transaction(() => {
      const source = this.db.get<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE id = ? AND transport_kind = 'legacy_cli' AND archived = 0`, [run.sourceConversationId]);
      if (!source) throw new Error(`Eligible Codex legacy source conversation not found: ${run.sourceConversationId}`);
      const timestamp = this.now();
      this.db.execute(
        `INSERT INTO conversations
         (id, project_id, task_id, session_id, title, summary, status, created_at, updated_at, archived,
          transport_kind, provider_id, provider_thread_id, provider_thread_path, provider_model, provider_state,
          provider_protocol_version, provider_binary_version, legacy_source_conversation_id, provider_settings_json, provider_token_usage_json)
         VALUES (?, ?, ?, NULL, ?, ?, 'open', ?, ?, 0, 'codex_native', 'codex', ?, NULL, NULL, 'ready', '0.144.2', ?, ?, '{}', '{}')`,
        [targetConversationId, source.project_id, source.task_id, source.title, source.summary, timestamp, timestamp, input.targetThreadId, input.providerBinaryVersion, source.id],
      );
      const sourceMessages = this.db.select<DbConversationMessageRow>(`SELECT ${selectConversationMessageFields} FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id`, [source.id]);
      for (const message of sourceMessages) {
        this.db.execute(
          `INSERT INTO conversation_messages
           (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `conversation_message_${nanoid(12)}`,
            targetConversationId,
            message.role,
            message.content,
            message.source,
            message.metadata_json,
            message.created_at,
            input.targetThreadId,
            message.provider_turn_id,
            message.provider_item_id,
            message.client_message_id,
          ],
        );
      }
      this.db.execute(`UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?`, [timestamp, source.id]);
      this.db.execute(
        `UPDATE codex_legacy_imports SET status = 'completed', target_thread_id = ?, target_conversation_id = ?, provider_binary_version = ?,
         failure_stage = NULL, failure_message = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`,
        [input.targetThreadId, targetConversationId, input.providerBinaryVersion, timestamp, timestamp, input.id],
      );
    });
    const conversation = new ConversationRepository(this.db).getById(targetConversationId);
    if (!conversation) throw new Error(`Imported Codex conversation not found: ${targetConversationId}`);
    return { run: this.requireById(input.id), conversation };
  }

  private requireById(id: string): ZeusCodexLegacyImportRecord {
    const record = this.getById(id);
    if (!record) throw new Error(`Codex legacy import record not found: ${id}`);
    return record;
  }

  private requireTransition(id: string, from: CodexLegacyImportStatus, to: CodexLegacyImportStatus): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status !== from) throw new Error(`Invalid Codex legacy import transition: ${record.status} -> ${to}.`);
    return record;
  }
}

export class ConversationTurnRepository {
  constructor(private readonly db: ZeusDatabase) {}

  upsert(input: Omit<ZeusConversationTurnRecord, 'id' | 'errorJson'> & { id?: string; error?: unknown }): ZeusConversationTurnRecord {
    const status = assertEnum(input.status, ['queued', 'dispatching', 'running', 'waiting', 'paused', 'completed', 'interrupted', 'failed'] as const, 'conversation turn status');
    const existing = input.providerTurnId ? this.db.get<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE provider_thread_id = ? AND provider_turn_id = ?`, [input.providerThreadId, input.providerTurnId]) : undefined;
    if (existing?.status === 'completed') return mapConversationTurnRow(existing);
    const id = existing?.id ?? input.id ?? `conversation_turn_${nanoid(12)}`;
    const errorJson = input.error === undefined ? null : JSON.stringify(input.error);
    this.db.execute(
      `INSERT INTO conversation_turns (id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status, error_json, started_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider_thread_id = excluded.provider_thread_id, provider_turn_id = excluded.provider_turn_id,
       status = excluded.status, error_json = excluded.error_json, started_at = COALESCE(excluded.started_at, conversation_turns.started_at),
       completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
      [id, input.conversationId, input.providerThreadId, input.providerTurnId, input.clientSubmissionId, status, errorJson, input.startedAt, input.completedAt, input.createdAt, input.updatedAt],
    );
    return mapConversationTurnRow(this.db.get<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE id = ?`, [id])!);
  }

  getById(id: string): ZeusConversationTurnRecord | undefined {
    const row = this.db.get<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE id = ?`, [id]);
    return row ? mapConversationTurnRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationTurnRecord[] {
    return this.db.select<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapConversationTurnRow);
  }
}

type ConversationItemBaseInput = {
  conversationId: string;
  turnId: string;
  providerThreadId: string;
  providerTurnId: string;
  providerItemId: string;
  itemType: ConversationItemType;
  phase: ConversationItemPhase;
  payload: unknown;
  startedAt?: string | null;
  updatedAt: string;
};

export class ConversationItemRepository {
  constructor(private readonly db: ZeusDatabase) {}

  appendDelta(input: ConversationItemBaseInput & { delta: string; status?: ConversationItemStatus }): ZeusConversationItemRecord {
    const itemType = assertEnum(input.itemType, ['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'plan', 'imageView', 'webSearch', 'error'] as const, 'conversation item type');
    const status = assertEnum(input.status ?? 'in_progress', ['in_progress', 'completed', 'failed'] as const, 'conversation item status');
    const phase = assertEnum(input.phase, ['prework', 'final_answer'] as const, 'conversation item phase');
    const existing = this.getByProvider(input.providerThreadId, input.providerItemId);
    if (existing?.status === 'completed') return existing;
    const id = existing?.id ?? `conversation_item_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_items (id, conversation_id, turn_id, provider_thread_id, provider_turn_id, provider_item_id, item_type, status, phase, text_content, payload_json, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(provider_thread_id, provider_item_id) DO UPDATE SET
       turn_id = excluded.turn_id, provider_turn_id = excluded.provider_turn_id, item_type = excluded.item_type,
       status = excluded.status, phase = excluded.phase, text_content = conversation_items.text_content || excluded.text_content,
       payload_json = excluded.payload_json, started_at = COALESCE(conversation_items.started_at, excluded.started_at), updated_at = excluded.updated_at`,
      [id, input.conversationId, input.turnId, input.providerThreadId, input.providerTurnId, input.providerItemId, itemType, status, phase, input.delta, JSON.stringify(input.payload), input.startedAt ?? null, input.updatedAt],
    );
    return this.getByProvider(input.providerThreadId, input.providerItemId)!;
  }

  upsertCompleted(input: ConversationItemBaseInput & { textContent: string; completedAt: string | null; status?: ConversationItemStatus }): ZeusConversationItemRecord {
    const itemType = assertEnum(input.itemType, ['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'plan', 'imageView', 'webSearch', 'error'] as const, 'conversation item type');
    const status = assertEnum(input.status ?? 'completed', ['in_progress', 'completed', 'failed'] as const, 'conversation item status');
    const phase = assertEnum(input.phase, ['prework', 'final_answer'] as const, 'conversation item phase');
    const existing = this.getByProvider(input.providerThreadId, input.providerItemId);
    if (existing?.status === 'completed') return existing;
    const id = existing?.id ?? `conversation_item_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO conversation_items (id, conversation_id, turn_id, provider_thread_id, provider_turn_id, provider_item_id, item_type, status, phase, text_content, payload_json, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_thread_id, provider_item_id) DO UPDATE SET
       turn_id = excluded.turn_id, provider_turn_id = excluded.provider_turn_id, item_type = excluded.item_type,
       status = excluded.status, phase = excluded.phase, text_content = excluded.text_content,
       payload_json = excluded.payload_json, started_at = COALESCE(conversation_items.started_at, excluded.started_at),
       completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
      [
        id,
        input.conversationId,
        input.turnId,
        input.providerThreadId,
        input.providerTurnId,
        input.providerItemId,
        itemType,
        status,
        phase,
        input.textContent,
        JSON.stringify(input.payload),
        input.startedAt ?? null,
        input.completedAt,
        input.updatedAt,
      ],
    );
    return this.getByProvider(input.providerThreadId, input.providerItemId)!;
  }

  getByProvider(providerThreadId: string, providerItemId: string): ZeusConversationItemRecord | undefined {
    const row = this.db.get<DbConversationItemRow>(`SELECT * FROM conversation_items WHERE provider_thread_id = ? AND provider_item_id = ?`, [providerThreadId, providerItemId]);
    return row ? mapConversationItemRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationItemRecord[] {
    return this.db.select<DbConversationItemRow>(`SELECT * FROM conversation_items WHERE conversation_id = ? ORDER BY updated_at, id`, [conversationId]).map(mapConversationItemRow);
  }
}

export class ConversationSubmissionRepository {
  constructor(private readonly db: ZeusDatabase) {}

  createOrGet(input: {
    id?: string;
    conversationId: string;
    idempotencyKey: string;
    requestHash: string;
    clientMessageId: string;
    kind: ConversationSubmissionKind;
    requestedDelivery: ConversationRequestedDelivery;
    status: ConversationSubmissionStatus;
    queuePosition?: number | null;
    input: unknown;
    targetProviderTurnId?: string | null;
    providerTurnId?: string | null;
    pausedReason?: string | null;
    error?: unknown;
    createdAt: string;
    dispatchedAt?: string | null;
    resolvedAt?: string | null;
  }): ZeusConversationSubmissionRecord {
    const kind = assertEnum(input.kind, ['message', 'steer'] as const, 'conversation submission kind');
    const requestedDelivery = assertEnum(input.requestedDelivery, ['queue', 'send_now'] as const, 'conversation submission requested delivery');
    const status = assertEnum(input.status, ['queued', 'dispatching', 'active', 'paused', 'completed', 'resolved', 'failed', 'cancelled', 'deleted'] as const, 'conversation submission status');
    const existing = this.db.get<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE conversation_id = ? AND idempotency_key = ?`, [input.conversationId, input.idempotencyKey]);
    if (existing) {
      if (existing.request_hash !== input.requestHash || (input.id !== undefined && existing.id !== input.id)) throwIdempotencyConflict(input.conversationId, input.idempotencyKey);
      return mapConversationSubmissionRow(existing);
    }
    const id = input.id ?? `conversation_submission_${nanoid(12)}`;
    const errorJson = input.error === undefined ? null : JSON.stringify(input.error);
    this.db.execute(
      `INSERT INTO conversation_submissions (id, conversation_id, idempotency_key, request_hash, client_message_id, kind, requested_delivery, status, queue_position, input_json, target_provider_turn_id, provider_turn_id, paused_reason, error_json, created_at, updated_at, dispatched_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.conversationId,
        input.idempotencyKey,
        input.requestHash,
        input.clientMessageId,
        kind,
        requestedDelivery,
        status,
        input.queuePosition ?? null,
        JSON.stringify(input.input),
        input.targetProviderTurnId ?? null,
        input.providerTurnId ?? null,
        input.pausedReason ?? null,
        errorJson,
        input.createdAt,
        input.createdAt,
        input.dispatchedAt ?? null,
        input.resolvedAt ?? null,
      ],
    );
    return this.getById(id)!;
  }

  getById(id: string): ZeusConversationSubmissionRecord | undefined {
    const row = this.db.get<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE id = ?`, [id]);
    return row ? mapConversationSubmissionRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationSubmissionRecord[] {
    return this.db.select<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE conversation_id = ? ORDER BY queue_position, created_at, id`, [conversationId]).map(mapConversationSubmissionRow);
  }

  listRecoverable(): ZeusConversationSubmissionRecord[] {
    return this.db
      .select<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE status IN ('queued', 'dispatching', 'active', 'paused') ORDER BY conversation_id, queue_position, created_at, id`)
      .map(mapConversationSubmissionRow);
  }

  updateQueuedInput(id: string, input: { requestHash: string; input: unknown; updatedAt?: string }): ZeusConversationSubmissionRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation submission not found: ${id}`);
    if (existing.status !== 'queued' && existing.status !== 'paused' && existing.status !== 'failed') {
      throw Object.assign(new Error('Only queued, paused, or failed submissions can be edited.'), { code: 'ZEUS_NATIVE_SUBMISSION_NOT_EDITABLE' as const });
    }
    this.db.execute(`UPDATE conversation_submissions SET request_hash = ?, input_json = ?, updated_at = ? WHERE id = ?`, [input.requestHash, JSON.stringify(input.input), input.updatedAt ?? nowIso(), id]);
    return this.getById(id)!;
  }

  reorderQueued(conversationId: string, orderedSubmissionIds: readonly string[], updatedAt = nowIso()): ZeusConversationSubmissionRecord[] {
    const queued = this.listByConversation(conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
    if (orderedSubmissionIds.length !== queued.length || new Set(orderedSubmissionIds).size !== queued.length || orderedSubmissionIds.some((id) => !queued.some((entry) => entry.id === id))) {
      throw Object.assign(new Error('Queued submission reorder must contain every queued or paused submission exactly once.'), { code: 'ZEUS_NATIVE_QUEUE_REORDER_INVALID' as const });
    }
    this.db.execute('BEGIN');
    try {
      orderedSubmissionIds.forEach((id, index) => this.db.execute(`UPDATE conversation_submissions SET queue_position = ?, updated_at = ? WHERE id = ? AND conversation_id = ?`, [index + 1, updatedAt, id, conversationId]));
      this.db.execute('COMMIT');
    } catch (error) {
      this.db.execute('ROLLBACK');
      throw error;
    }
    return this.listByConversation(conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
  }

  updateStatus(
    id: string,
    statusValue: ConversationSubmissionStatus,
    input: { providerTurnId?: string | null; pausedReason?: string | null; error?: unknown; dispatchedAt?: string | null; resolvedAt?: string | null; updatedAt?: string } = {},
  ): ZeusConversationSubmissionRecord {
    const status = assertEnum(statusValue, ['queued', 'dispatching', 'active', 'paused', 'completed', 'resolved', 'failed', 'cancelled', 'deleted'] as const, 'conversation submission status');
    this.db.execute(
      `UPDATE conversation_submissions SET status = ?, provider_turn_id = COALESCE(?, provider_turn_id), paused_reason = ?, error_json = ?, dispatched_at = COALESCE(?, dispatched_at), resolved_at = COALESCE(?, resolved_at), updated_at = ? WHERE id = ?`,
      [status, input.providerTurnId ?? null, input.pausedReason ?? null, input.error === undefined ? null : JSON.stringify(input.error), input.dispatchedAt ?? null, input.resolvedAt ?? null, input.updatedAt ?? nowIso(), id],
    );
    const updated = this.getById(id);
    if (!updated) throw new Error(`Conversation submission not found: ${id}`);
    return updated;
  }
}

export class ConversationServerRequestRepository {
  constructor(private readonly db: ZeusDatabase) {}

  upsert(input: {
    conversationId: string;
    turnId?: string | null;
    itemId?: string | null;
    transportGenerationId: string;
    providerRequestId: string | number;
    requestKind: ConversationServerRequestKind;
    payload: unknown;
    status: ConversationServerRequestStatus;
    response?: unknown;
    containsSecret?: boolean;
    expiresAt?: string | null;
    createdAt: string;
    resolvedAt?: string | null;
  }): ZeusConversationServerRequestRecord {
    const requestKind = assertEnum(input.requestKind, ['command', 'file', 'permissions', 'request_user_input', 'mcp'] as const, 'conversation server request kind');
    const status = assertEnum(input.status, ['pending', 'resolved', 'declined', 'expired', 'failed'] as const, 'conversation server request status');
    const providerRequestIdJson = serializeProviderRequestId(input.providerRequestId);
    const existing = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE transport_generation_id = ? AND provider_request_id_json = ?`, [input.transportGenerationId, providerRequestIdJson]);
    const persistedPayload = parseStoredJson(existing?.payload_json);
    const containsSecret = input.containsSecret === true || existing?.contains_secret === 1 || hasSecretUserInputQuestion(input.payload) || hasSecretUserInputQuestion(persistedPayload);
    const payload = containsSecret ? redactSecretValues(input.payload) : input.payload;
    if (existing) {
      assertConversationServerRequestIdentity(existing, requestKind, payload, containsSecret);
      return mapConversationServerRequestRow(existing);
    }
    const id = `conversation_server_request_${nanoid(12)}`;
    const response = containsSecret && input.response !== undefined ? createSecretResponseSummary(input.payload, input.response) : input.response;
    this.db.execute(
      `INSERT INTO conversation_server_requests (id, conversation_id, turn_id, item_id, transport_generation_id, provider_request_id_json, request_kind, payload_json, status, response_json, contains_secret, expires_at, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(transport_generation_id, provider_request_id_json) DO NOTHING`,
      [
        id,
        input.conversationId,
        input.turnId ?? null,
        input.itemId ?? null,
        input.transportGenerationId,
        providerRequestIdJson,
        requestKind,
        JSON.stringify(payload),
        status,
        response === undefined ? null : JSON.stringify(response),
        containsSecret ? 1 : 0,
        input.expiresAt ?? null,
        input.createdAt,
        input.resolvedAt ?? null,
      ],
    );
    const stored = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE transport_generation_id = ? AND provider_request_id_json = ?`, [input.transportGenerationId, providerRequestIdJson]);
    if (!stored) throw new Error('Conversation server request insert did not persist a record.');
    assertConversationServerRequestIdentity(stored, requestKind, payload, containsSecret);
    return mapConversationServerRequestRow(stored);
  }

  resolve(id: string, input: { response: unknown; isSecret?: boolean; questionIds?: string[]; answerCount?: number; resolvedAt: string }): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    const persistedPayload = parseStoredJson(existing.payloadJson);
    const secret = input.isSecret === true || existing.containsSecret || hasSecretUserInputQuestion(persistedPayload);
    const responseJson = secret ? JSON.stringify(createSecretResponseSummary(persistedPayload, input.response, input.questionIds, input.answerCount)) : JSON.stringify(input.response);
    this.db.execute(`UPDATE conversation_server_requests SET status = 'resolved', response_json = ?, contains_secret = ?, resolved_at = ? WHERE id = ?`, [responseJson, secret ? 1 : 0, input.resolvedAt, id]);
    return this.getById(id)!;
  }

  fail(id: string, input: { error: unknown; resolvedAt: string }): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    this.db.execute(`UPDATE conversation_server_requests SET status = 'failed', response_json = ?, resolved_at = ? WHERE id = ?`, [JSON.stringify(input.error), input.resolvedAt, id]);
    return this.getById(id)!;
  }

  getById(id: string): ZeusConversationServerRequestRecord | undefined {
    const row = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE id = ?`, [id]);
    return row ? mapConversationServerRequestRow(row) : undefined;
  }

  getByProvider(transportGenerationId: string, providerRequestId: string | number): ZeusConversationServerRequestRecord | undefined {
    const row = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE transport_generation_id = ? AND provider_request_id_json = ?`, [
      transportGenerationId,
      serializeProviderRequestId(providerRequestId),
    ]);
    return row ? mapConversationServerRequestRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationServerRequestRecord[] {
    return this.db.select<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapConversationServerRequestRow);
  }
}

export class IdempotencyRequestRepository {
  constructor(private readonly db: ZeusDatabase) {}

  createOrGet(input: {
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    status: IdempotencyRequestStatus;
    httpStatus?: number | null;
    response?: unknown;
    resourceId?: string | null;
    createdAt: string;
  }): ZeusIdempotencyRequestRecord {
    const status = assertEnum(input.status, ['in_progress', 'completed', 'failed'] as const, 'idempotency request status');
    const existing = this.db.get<DbIdempotencyRequestRow>(`SELECT * FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [input.scope, input.idempotencyKey]);
    if (existing) {
      if (existing.request_hash !== input.requestHash) throwIdempotencyConflict(input.scope, input.idempotencyKey);
      return mapIdempotencyRequestRow(existing);
    }
    this.db.execute(`INSERT INTO idempotency_requests (scope, idempotency_key, request_hash, status, http_status, response_json, resource_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      input.scope,
      input.idempotencyKey,
      input.requestHash,
      status,
      input.httpStatus ?? null,
      input.response === undefined ? null : JSON.stringify(input.response),
      input.resourceId ?? null,
      input.createdAt,
      input.createdAt,
    ]);
    return mapIdempotencyRequestRow(this.db.get<DbIdempotencyRequestRow>(`SELECT * FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [input.scope, input.idempotencyKey])!);
  }
}

function clampConversationLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function toSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function assertEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`Unknown ${label}: ${String(value)}`);
  return value as T[number];
}

const providerGenerationOrderSettingKey = 'codex.native.transport_generation_order';

function assertProviderSequenceSnapshot(snapshot: unknown): asserts snapshot is ProviderSequenceSnapshot {
  if (!isPlainRecord(snapshot) || typeof snapshot.generationId !== 'string' || !snapshot.generationId || !Number.isSafeInteger(snapshot.sequence) || Number(snapshot.sequence) < 0) {
    throw new Error('Invalid provider generation/sequence snapshot');
  }
}

function validateProviderSettingsSnapshot(snapshot: unknown): asserts snapshot is ConversationProviderSettingsSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertNoSecretLikeProviderKeys(candidate);
  assertOnlyKeys(candidate, ['generationId', 'sequence', 'model', 'effort'], 'provider settings snapshot');
  if (typeof candidate.model !== 'string' || !candidate.model.trim() || (candidate.effort !== undefined && typeof candidate.effort !== 'string')) throw new Error('Invalid provider settings snapshot');
}

function validateProviderTokenUsageSnapshot(snapshot: unknown): asserts snapshot is ConversationProviderTokenUsageSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertNoSecretLikeProviderKeys(candidate, new Set(['inputtokens', 'outputtokens', 'totaltokens']));
  assertOnlyKeys(candidate, ['generationId', 'sequence', 'inputTokens', 'outputTokens', 'totalTokens'], 'provider token usage snapshot');
  if (![candidate.inputTokens, candidate.outputTokens, candidate.totalTokens].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new Error('Invalid provider token usage snapshot');
}

function validateRateLimitsSnapshot(snapshot: unknown): asserts snapshot is CodexRateLimitsSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertOnlyKeys(candidate, ['generationId', 'sequence', 'value'], 'Codex rate limits snapshot');
  assertNoSecretLikeProviderKeys(candidate.value);
  assertProviderVisibleJson(candidate.value, 'rate limits');
  if (!isPlainRecord(candidate.value)) throw new Error('Invalid Codex rate limits snapshot');
  for (const key of ['primary', 'secondary'] as const) {
    const window = candidate.value[key];
    if (window === undefined) continue;
    if (!isPlainRecord(window)) throw new Error('Invalid Codex rate limits snapshot');
    if (window.remaining !== undefined && (typeof window.remaining !== 'number' || !Number.isFinite(window.remaining))) throw new Error('Invalid Codex rate limits snapshot');
    if (window.usedPercent !== undefined && (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent))) throw new Error('Invalid Codex rate limits snapshot');
    if (window.resetsAt !== undefined && window.resetsAt !== null && typeof window.resetsAt !== 'number' && typeof window.resetsAt !== 'string') throw new Error('Invalid Codex rate limits snapshot');
  }
}

function validateMcpStartupStatusSnapshot(snapshot: unknown): asserts snapshot is CodexMcpStartupStatusSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertOnlyKeys(candidate, ['generationId', 'sequence', 'value'], 'Codex MCP startup snapshot');
  assertNoSecretLikeProviderKeys(candidate.value);
  assertProviderVisibleJson(candidate.value, 'MCP startup status');
  if (!isPlainRecord(candidate.value)) throw new Error('Invalid Codex MCP startup snapshot');
  for (const state of Object.values(candidate.value)) {
    if (typeof state === 'string') continue;
    if (!isPlainRecord(state) || typeof state.status !== 'string') throw new Error('Invalid Codex MCP startup snapshot');
    if (state.error !== undefined && state.error !== null && typeof state.error !== 'string') throw new Error('Invalid Codex MCP startup snapshot');
  }
}

function shouldAcceptProviderSnapshot(db: ZeusDatabase, incoming: ProviderSequenceSnapshot, current: ProviderSequenceSnapshot | undefined): boolean {
  const row = db.get<{ value_json: string }>(`SELECT value_json FROM settings WHERE key = ?`, [providerGenerationOrderSettingKey]);
  let generationIds: string[] = [];
  if (row) {
    const parsed = parseStoredJson(row.value_json);
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.generationIds) || !parsed.generationIds.every((value) => typeof value === 'string' && value)) throw new Error('Invalid persisted provider generation order');
    generationIds = [...new Set(parsed.generationIds)];
  }
  let changed = false;
  for (const generationId of [current?.generationId, incoming.generationId]) {
    if (generationId && !generationIds.includes(generationId)) {
      generationIds.push(generationId);
      changed = true;
    }
  }
  if (changed) {
    const timestamp = nowIso();
    db.execute(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [providerGenerationOrderSettingKey, JSON.stringify({ generationIds }), timestamp],
    );
  }
  const incomingEpoch = generationIds.indexOf(incoming.generationId);
  if (incomingEpoch < generationIds.length - 1) return false;
  return !(current && current.generationId === incoming.generationId && current.sequence >= incoming.sequence);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Invalid ${label}`);
}

function assertNoSecretLikeProviderKeys(value: unknown, allowedTokenCounters = new Set<string>(), path = 'snapshot', seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`Invalid cyclic provider state at ${path}`);
  seen.add(value);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
    const tokenLike = normalized.includes('token') && !allowedTokenCounters.has(normalized);
    const secretKeyLike =
      normalized === 'key' || ['apikey', 'accesskey', 'secretkey', 'privatekey', 'signingkey', 'encryptionkey', 'decryptionkey', 'sessionkey', 'serviceaccountkey', 'clientkey', 'keymaterial'].some((marker) => normalized.includes(marker));
    if (tokenLike || secretKeyLike || ['secret', 'authorization', 'credential', 'password', 'passphrase', 'bearer', 'cookie'].some((marker) => normalized.includes(marker))) {
      throw new Error(`Secret-like provider field rejected: ${path}.${key}`);
    }
    assertNoSecretLikeProviderKeys(nested, allowedTokenCounters, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function assertProviderVisibleJson(value: unknown, label: string, seen = new WeakSet<object>()): asserts value is ProviderVisibleJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid ${label} provider state`);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error(`Invalid ${label} provider state`);
  seen.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const nested of entries) assertProviderVisibleJson(nested, label, seen);
  seen.delete(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function throwIdempotencyConflict(scope: string, key: string): never {
  throw Object.assign(new Error(`Idempotency key conflict for ${scope}/${key}`), { code: 'ZEUS_IDEMPOTENCY_CONFLICT' as const });
}

function serializeProviderRequestId(value: string | number): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Provider request id must be a finite JSON scalar');
  return JSON.stringify(value);
}

function parseStoredJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function assertConversationServerRequestIdentity(existing: DbConversationServerRequestRow, requestKind: ConversationServerRequestKind, payload: unknown, containsSecret: boolean): void {
  const sameKind = existing.request_kind === requestKind;
  const samePayload = canonicalJson(existing.payload_json ? parseStoredJson(existing.payload_json) : undefined) === canonicalJson(payload);
  const sameSecretClassification = (existing.contains_secret === 1) === containsSecret;
  if (sameKind && samePayload && sameSecretClassification) return;
  throw Object.assign(new Error('Codex server request identity conflicts with an existing generation-scoped provider request.'), {
    code: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT' as const,
  });
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function hasSecretUserInputQuestion(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.some(hasSecretUserInputQuestion);
  if (!isPlainRecord(payload)) return false;
  if (Array.isArray(payload.questions) && payload.questions.some((question) => isPlainRecord(question) && question.isSecret === true)) return true;
  return Object.values(payload).some(hasSecretUserInputQuestion);
}

function extractUserInputQuestionIds(payload: unknown): string[] {
  if (!isPlainRecord(payload) || !Array.isArray(payload.questions)) return [];
  return payload.questions.flatMap((question) => {
    if (!isPlainRecord(question)) return [];
    const id = typeof question.id === 'string' ? question.id : typeof question.questionId === 'string' ? question.questionId : undefined;
    return id ? [id] : [];
  });
}

function countUserInputAnswers(response: unknown): number {
  if (!isPlainRecord(response) || !isPlainRecord(response.answers)) return 0;
  let count = 0;
  for (const answer of Object.values(response.answers)) {
    if (Array.isArray(answer)) count += answer.length;
    else if (isPlainRecord(answer) && Array.isArray(answer.answers)) count += answer.answers.length;
    else if (answer !== undefined && answer !== null) count += 1;
  }
  return count;
}

function createSecretResponseSummary(payload: unknown, response: unknown, questionIds?: string[], answerCount?: number): { questionIds: string[]; answerCount: number; answers: '[REDACTED]' } {
  return {
    questionIds: questionIds ?? extractUserInputQuestionIds(payload),
    answerCount: answerCount ?? countUserInputAnswers(response),
    answers: '[REDACTED]',
  };
}

function redactSecretValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretValues);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => (/^(?:answer|answers|value|secret)$/iu.test(key) ? [key, '[REDACTED]'] : [key, redactSecretValues(nested)])));
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
  transport_kind: ConversationTransportKind;
  provider_id: string | null;
  provider_thread_id: string | null;
  provider_thread_path: string | null;
  provider_model: string | null;
  provider_state: ConversationProviderState;
  provider_protocol_version: string | null;
  provider_binary_version: string | null;
  legacy_source_conversation_id: string | null;
  provider_settings_json: string;
  provider_token_usage_json: string;
  permission_mode: ConversationPermissionMode;
}

interface DbConversationMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  source: string;
  metadata_json: string;
  created_at: string;
  provider_thread_id: string | null;
  provider_turn_id: string | null;
  provider_item_id: string | null;
  client_message_id: string | null;
}

interface DbCodexLegacyImportRow {
  id: string;
  provider_import_id: string | null;
  source_conversation_id: string;
  target_conversation_id: string | null;
  snapshot_path: string;
  snapshot_sha256: string;
  status: CodexLegacyImportStatus;
  target_thread_id: string | null;
  failure_stage: string | null;
  failure_message: string | null;
  provider_binary_version: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface DbConversationTurnRow {
  id: string;
  conversation_id: string;
  provider_thread_id: string;
  provider_turn_id: string | null;
  client_submission_id: string;
  status: ConversationTurnStatus;
  error_json: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DbConversationItemRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  provider_thread_id: string;
  provider_turn_id: string;
  provider_item_id: string;
  item_type: ConversationItemType;
  status: ConversationItemStatus;
  phase: ConversationItemPhase;
  text_content: string;
  payload_json: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface DbConversationSubmissionRow {
  id: string;
  conversation_id: string;
  idempotency_key: string;
  request_hash: string;
  client_message_id: string;
  kind: ConversationSubmissionKind;
  requested_delivery: ConversationRequestedDelivery;
  status: ConversationSubmissionStatus;
  queue_position: number | null;
  input_json: string;
  target_provider_turn_id: string | null;
  provider_turn_id: string | null;
  paused_reason: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  resolved_at: string | null;
}

interface DbConversationServerRequestRow {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  item_id: string | null;
  transport_generation_id: string;
  provider_request_id_json: string;
  request_kind: ConversationServerRequestKind;
  payload_json: string;
  status: ConversationServerRequestStatus;
  response_json: string | null;
  contains_secret: number;
  expires_at: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface DbIdempotencyRequestRow {
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: IdempotencyRequestStatus;
  http_status: number | null;
  response_json: string | null;
  resource_id: string | null;
  created_at: string;
  updated_at: string;
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
  task_code: string | null;
  task_sequence: number | null;
  title: string;
  description: string;
  status: ZeusTaskRecord['status'];
  priority: string;
  tags_json: string;
  template_id: string | null;
  allow_code_changes: number;
  allow_tests: number;
  allow_git_commit: number;
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
    transportKind: row.transport_kind,
    providerId: row.provider_id,
    providerThreadId: row.provider_thread_id,
    providerThreadPath: row.provider_thread_path,
    providerModel: row.provider_model,
    providerState: row.provider_state,
    providerProtocolVersion: row.provider_protocol_version,
    providerBinaryVersion: row.provider_binary_version,
    legacySourceConversationId: row.legacy_source_conversation_id,
    providerSettingsJson: row.provider_settings_json,
    providerTokenUsageJson: row.provider_token_usage_json,
    permissionMode: assertEnum(row.permission_mode, ['read-only', 'auto', 'full-access'] as const, 'conversation permission mode'),
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
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    providerItemId: row.provider_item_id,
    clientMessageId: row.client_message_id,
  };
}

function mapCodexLegacyImportRow(row: DbCodexLegacyImportRow): ZeusCodexLegacyImportRecord {
  return {
    id: row.id,
    providerImportId: row.provider_import_id,
    sourceConversationId: row.source_conversation_id,
    targetConversationId: row.target_conversation_id,
    snapshotPath: row.snapshot_path,
    snapshotSha256: row.snapshot_sha256,
    status: row.status,
    targetThreadId: row.target_thread_id,
    failureStage: row.failure_stage,
    failureMessage: row.failure_message,
    providerBinaryVersion: row.provider_binary_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapConversationTurnRow(row: DbConversationTurnRow): ZeusConversationTurnRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    clientSubmissionId: row.client_submission_id,
    status: row.status,
    errorJson: row.error_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversationItemRow(row: DbConversationItemRow): ZeusConversationItemRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    providerItemId: row.provider_item_id,
    itemType: row.item_type,
    status: row.status,
    phase: row.phase,
    textContent: row.text_content,
    payloadJson: row.payload_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function mapConversationSubmissionRow(row: DbConversationSubmissionRow): ZeusConversationSubmissionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    clientMessageId: row.client_message_id,
    kind: row.kind,
    requestedDelivery: row.requested_delivery,
    status: row.status,
    queuePosition: row.queue_position,
    inputJson: row.input_json,
    targetProviderTurnId: row.target_provider_turn_id,
    providerTurnId: row.provider_turn_id,
    pausedReason: row.paused_reason,
    errorJson: row.error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
    resolvedAt: row.resolved_at,
  };
}

function mapConversationServerRequestRow(row: DbConversationServerRequestRow): ZeusConversationServerRequestRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    transportGenerationId: row.transport_generation_id,
    providerRequestIdJson: row.provider_request_id_json,
    requestKind: row.request_kind,
    payloadJson: row.payload_json,
    status: row.status,
    responseJson: row.response_json,
    containsSecret: row.contains_secret === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function mapIdempotencyRequestRow(row: DbIdempotencyRequestRow): ZeusIdempotencyRequestRecord {
  return {
    scope: row.scope,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    httpStatus: row.http_status,
    responseJson: row.response_json,
    resourceId: row.resource_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  const sequence = normalizeTaskSequence(row.task_sequence);
  return {
    id: row.id,
    projectId: row.project_id,
    taskCode: normalizeTaskCode(row.task_code, sequence),
    taskSequence: sequence,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority || 'normal',
    allowCodeChanges: row.allow_code_changes === 1,
    allowTests: row.allow_tests === 1,
    allowGitCommit: row.allow_git_commit === 1,
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
