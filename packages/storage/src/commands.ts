import { randomId } from './randomId.js';
import { createHash } from 'node:crypto';
import { type CommandArtifact, type CommandDefinition, type CommandDefinitionInput, type CommandRun, type CommandRunStatus, type CommandRunTrigger, type CommandScope, defaultCommandRiskFlags } from '@zeus/shared';
import type { ArtifactRef, ArtifactStore } from './artifactStore.js';
import type { ZeusDatabasePort } from './databasePort.js';

interface DbCommandDefinitionRow {
  id: string;
  scope: CommandScope;
  project_id: string | null;
  name: string;
  title: string;
  description: string;
  command_text: string;
  parameters_json: string;
  timeout_seconds: number;
  enabled: number;
  telegram_enabled: number;
  risk_flags_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface DbCommandAliasRow {
  command_id: string;
  alias: string;
}

interface DbCommandRunRow {
  id: string;
  command_id: string | null;
  project_id: string;
  runtime_session_id: string | null;
  trigger: CommandRunTrigger;
  status: CommandRunStatus;
  command_snapshot_json: string;
  parameter_snapshot_json: string;
  cwd: string;
  timeout_seconds: number;
  exit_code: number | null;
  failure_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DbCommandArtifactRow {
  id: string;
  run_id: string;
  relative_path: string;
  absolute_path: string;
  artifact_ref_json: string | null;
  mime_type: string | null;
  byte_length: number;
  created_at: string;
}

export interface CreateStoredCommandInput extends CommandDefinitionInput {
  id?: string;
  scope: CommandScope;
  projectId: string | null;
  revision?: number;
  createdAt?: string;
}

export interface UpdateStoredCommandInput extends CommandDefinitionInput {
  revision: number;
}

export interface CommandTokenConflict {
  token: string;
  commandId: string;
  commandName: string;
  scope: CommandScope;
  projectId: string | null;
}

export interface CreateCommandRunRecordInput {
  id?: string;
  commandId: string;
  projectId: string;
  trigger: CommandRunTrigger;
  status: CommandRunStatus;
  commandSnapshot: CommandDefinition;
  parameterSnapshot: Record<string, string | number | boolean>;
  cwd: string;
  timeoutSeconds: number;
}

export interface UpdateCommandRunRecordInput {
  status?: CommandRunStatus;
  runtimeSessionId?: string | null;
  exitCode?: number | null;
  failureReason?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

/** 命令中心迁移只创建结构和索引，不注入任何默认命令或用户脚本。 */
export function migrateCommandCenterSchema(db: ZeusDatabasePort): void {
  const migrationId = '20260728_0009_command_center';
  if (db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])) {
    migrateCommandArtifactRefColumn(db);
    return;
  }
  db.transaction(() => {
    db.execute(`
      CREATE TABLE IF NOT EXISTS command_definitions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        project_id TEXT,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        command_text TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        telegram_enabled INTEGER NOT NULL DEFAULT 0,
        risk_flags_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS command_aliases (
        id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS command_runs (
        id TEXT PRIMARY KEY,
        command_id TEXT,
        project_id TEXT NOT NULL,
        runtime_session_id TEXT,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        command_snapshot_json TEXT NOT NULL,
        parameter_snapshot_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        exit_code INTEGER,
        failure_reason TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS command_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        artifact_ref_json TEXT,
        mime_type TEXT,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    for (const statement of [
      `CREATE INDEX IF NOT EXISTS idx_command_definitions_scope_project ON command_definitions(scope, project_id, updated_at)`,
      `CREATE INDEX IF NOT EXISTS idx_command_definitions_normalized_name ON command_definitions(normalized_name)`,
      `CREATE INDEX IF NOT EXISTS idx_command_aliases_command ON command_aliases(command_id)`,
      `CREATE INDEX IF NOT EXISTS idx_command_aliases_normalized ON command_aliases(normalized_alias)`,
      `CREATE INDEX IF NOT EXISTS idx_command_runs_project_created ON command_runs(project_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_command_runs_command_created ON command_runs(command_id, created_at)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_command_artifacts_run_path ON command_artifacts(run_id, relative_path)`,
    ]) {
      db.execute(statement);
    }
    const checksum = `sha256:${createHash('sha256').update('command_definitions,command_aliases,command_runs,command_artifacts:v1').digest('hex')}`;
    db.execute(`INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [migrationId, '增加通用命令定义、别名、执行记录与产物持久化', checksum, nowIso()]);
  });
  migrateCommandArtifactRefColumn(db);
}

function migrateCommandArtifactRefColumn(db: ZeusDatabasePort): void {
  try {
    db.execute(`ALTER TABLE command_artifacts ADD COLUMN artifact_ref_json TEXT`);
  } catch {
    // 新库已由 CREATE TABLE 包含；旧库幂等补列。
  }
}

export class CommandDefinitionRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  create(input: CreateStoredCommandInput): CommandDefinition {
    const timestamp = input.createdAt ?? nowIso();
    const id = input.id ?? `command_${randomId(12)}`;
    this.db.transaction(() => {
      this.db.execute(
        `INSERT INTO command_definitions
           (id, scope, project_id, name, normalized_name, title, description, command_text,
            parameters_json, timeout_seconds, enabled, telegram_enabled, risk_flags_json,
            revision, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          id,
          input.scope,
          input.projectId,
          input.name.trim(),
          normalizeCommandToken(input.name),
          input.title.trim(),
          input.description?.trim() ?? '',
          input.command.trim(),
          JSON.stringify(input.parameters ?? []),
          input.timeoutSeconds ?? 300,
          input.enabled === false ? 0 : 1,
          input.telegramEnabled ? 1 : 0,
          JSON.stringify({ ...defaultCommandRiskFlags, ...(input.riskFlags ?? {}) }),
          input.revision ?? 1,
          timestamp,
          timestamp,
        ],
      );
      this.replaceAliases(id, input.aliases ?? [], timestamp);
    });
    return this.getById(id)!;
  }

  update(id: string, input: UpdateStoredCommandInput): CommandDefinition {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Command definition not found: ${id}`);
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE command_definitions
         SET name = ?, normalized_name = ?, title = ?, description = ?, command_text = ?,
             parameters_json = ?, timeout_seconds = ?, enabled = ?, telegram_enabled = ?,
             risk_flags_json = ?, revision = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
        [
          input.name.trim(),
          normalizeCommandToken(input.name),
          input.title.trim(),
          input.description?.trim() ?? '',
          input.command.trim(),
          JSON.stringify(input.parameters ?? []),
          input.timeoutSeconds ?? 300,
          input.enabled === false ? 0 : 1,
          input.telegramEnabled ? 1 : 0,
          JSON.stringify({ ...defaultCommandRiskFlags, ...(input.riskFlags ?? {}) }),
          input.revision,
          timestamp,
          id,
        ],
      );
      this.replaceAliases(id, input.aliases ?? [], timestamp);
    });
    return this.getById(id)!;
  }

  delete(id: string): CommandDefinition {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Command definition not found: ${id}`);
    const timestamp = nowIso();
    this.db.execute(`UPDATE command_definitions SET deleted_at = ?, enabled = 0, telegram_enabled = 0, revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, timestamp, id]);
    return existing;
  }

  getById(id: string): CommandDefinition | undefined {
    const row = this.db.get<DbCommandDefinitionRow>(`${commandDefinitionSelectSql()} WHERE command_definitions.id = ? AND command_definitions.deleted_at IS NULL`, [id]);
    return row ? this.mapRow(row) : undefined;
  }

  listGlobal(): CommandDefinition[] {
    return this.listWhere(`command_definitions.scope = 'global'`);
  }

  listProject(projectId: string): CommandDefinition[] {
    return this.listWhere(`command_definitions.scope = 'project' AND command_definitions.project_id = ?`, [projectId]);
  }

  listMerged(projectId: string, enabledOnly = false): CommandDefinition[] {
    const enabledClause = enabledOnly ? ' AND command_definitions.enabled = 1' : '';
    return this.listWhere(`(command_definitions.scope = 'global' OR (command_definitions.scope = 'project' AND command_definitions.project_id = ?))${enabledClause}`, [projectId]);
  }

  findByToken(projectId: string, token: string, enabledOnly = true): CommandDefinition | undefined {
    const normalized = normalizeCommandToken(token);
    const enabledClause = enabledOnly ? ' AND command_definitions.enabled = 1' : '';
    const row = this.db.get<DbCommandDefinitionRow>(
      `${commandDefinitionSelectSql()}
       WHERE command_definitions.deleted_at IS NULL
         AND (command_definitions.scope = 'global' OR command_definitions.project_id = ?)
         AND (command_definitions.normalized_name = ? OR EXISTS (
           SELECT 1 FROM command_aliases lookup_alias
           WHERE lookup_alias.command_id = command_definitions.id AND lookup_alias.normalized_alias = ?
         ))${enabledClause}
       ORDER BY CASE command_definitions.scope WHEN 'project' THEN 0 ELSE 1 END, command_definitions.updated_at DESC
       LIMIT 1`,
      [projectId, normalized, normalized],
    );
    return row ? this.mapRow(row) : undefined;
  }

  findTokenConflicts(input: { scope: CommandScope; projectId: string | null; tokens: string[]; excludeCommandId?: string }): CommandTokenConflict[] {
    const normalizedTokens = [...new Set(input.tokens.map(normalizeCommandToken))];
    if (normalizedTokens.length === 0) return [];
    const definitions = this.db.select<DbCommandDefinitionRow>(
      `${commandDefinitionSelectSql()}
       WHERE command_definitions.deleted_at IS NULL
         AND command_definitions.id <> ?
         AND (
           ? = 'global'
           OR command_definitions.scope = 'global'
           OR (command_definitions.scope = 'project' AND command_definitions.project_id = ?)
         )`,
      [input.excludeCommandId ?? '', input.scope, input.projectId],
    );
    const conflicts: CommandTokenConflict[] = [];
    for (const definition of definitions) {
      const tokens = [definition.name, ...this.listAliases(definition.id)];
      for (const token of tokens) {
        if (!normalizedTokens.includes(normalizeCommandToken(token))) continue;
        conflicts.push({
          token,
          commandId: definition.id,
          commandName: definition.name,
          scope: definition.scope,
          projectId: definition.project_id,
        });
      }
    }
    return conflicts;
  }

  private listWhere(where: string, params: Array<string | number | null> = []): CommandDefinition[] {
    return this.db
      .select<DbCommandDefinitionRow>(
        `${commandDefinitionSelectSql()} WHERE command_definitions.deleted_at IS NULL AND ${where}
         ORDER BY CASE command_definitions.scope WHEN 'global' THEN 0 ELSE 1 END,
                  command_definitions.title COLLATE NOCASE, command_definitions.name COLLATE NOCASE`,
        params,
      )
      .map((row) => this.mapRow(row));
  }

  private replaceAliases(commandId: string, aliases: string[], createdAt: string): void {
    this.db.execute(`DELETE FROM command_aliases WHERE command_id = ?`, [commandId]);
    for (const alias of aliases) {
      this.db.execute(
        `INSERT INTO command_aliases (id, command_id, alias, normalized_alias, created_at)
                         VALUES (?, ?, ?, ?,
                                 ?)`,
        [`command_alias_${randomId(12)}`, commandId, alias.trim(), normalizeCommandToken(alias), createdAt],
      );
    }
  }

  private listAliases(commandId: string): string[] {
    return this.db.select<DbCommandAliasRow>(`SELECT command_id, alias FROM command_aliases WHERE command_id = ? ORDER BY rowid`, [commandId]).map((row) => row.alias);
  }

  private mapRow(row: DbCommandDefinitionRow): CommandDefinition {
    return {
      id: row.id,
      scope: row.scope,
      projectId: row.project_id,
      name: row.name,
      aliases: this.listAliases(row.id),
      title: row.title,
      description: row.description,
      command: row.command_text,
      parameters: parseJsonArray(row.parameters_json),
      timeoutSeconds: row.timeout_seconds,
      enabled: row.enabled === 1,
      telegramEnabled: row.telegram_enabled === 1,
      riskFlags: { ...defaultCommandRiskFlags, ...parseJsonObject(row.risk_flags_json) },
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export class CommandRunRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  create(input: CreateCommandRunRecordInput): CommandRun {
    const id = input.id ?? `command_run_${randomId(12)}`;
    const timestamp = nowIso();
    this.db.execute(
      `INSERT INTO command_runs
         (id, command_id, project_id, runtime_session_id, trigger, status, command_snapshot_json,
          parameter_snapshot_json, cwd, timeout_seconds, exit_code, failure_reason,
          started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      [id, input.commandId, input.projectId, input.trigger, input.status, JSON.stringify(input.commandSnapshot), JSON.stringify(input.parameterSnapshot), input.cwd, input.timeoutSeconds, timestamp, timestamp],
    );
    return this.getById(id)!;
  }

  update(id: string, input: UpdateCommandRunRecordInput): CommandRun {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Command run not found: ${id}`);
    const updatedAt = nowIso();
    this.db.execute(
      `UPDATE command_runs
       SET status = ?, runtime_session_id = ?, exit_code = ?, failure_reason = ?,
           started_at = ?, ended_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.status ?? existing.status,
        input.runtimeSessionId === undefined ? existing.runtimeSessionId : input.runtimeSessionId,
        input.exitCode === undefined ? existing.exitCode : input.exitCode,
        input.failureReason === undefined ? existing.failureReason : input.failureReason,
        input.startedAt === undefined ? existing.startedAt : input.startedAt,
        input.endedAt === undefined ? existing.endedAt : input.endedAt,
        updatedAt,
        id,
      ],
    );
    return this.getById(id)!;
  }

  getById(id: string): CommandRun | undefined {
    const row = this.db.get<DbCommandRunRow>(`${commandRunSelectSql()} WHERE id = ?`, [id]);
    return row ? mapCommandRunRow(row) : undefined;
  }

  getByRuntimeSessionId(sessionId: string): CommandRun | undefined {
    const row = this.db.get<DbCommandRunRow>(`${commandRunSelectSql()} WHERE runtime_session_id = ? ORDER BY created_at DESC LIMIT 1`, [sessionId]);
    return row ? mapCommandRunRow(row) : undefined;
  }

  listByProject(projectId: string, limit = 100): CommandRun[] {
    return this.db.select<DbCommandRunRow>(`${commandRunSelectSql()} WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, [projectId, Math.max(1, Math.min(500, Math.trunc(limit)))]).map(mapCommandRunRow);
  }

  listActive(): CommandRun[] {
    return this.db.select<DbCommandRunRow>(`${commandRunSelectSql()} WHERE status IN ('pending_confirmation', 'starting', 'running', 'stopping') ORDER BY created_at`).map(mapCommandRunRow);
  }
}

export class CommandArtifactRepository {
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly artifactStore?: ArtifactStore,
  ) {}

  create(input: Omit<CommandArtifact, 'id' | 'createdAt'>): CommandArtifact {
    const existing = this.db.get<DbCommandArtifactRow>(`${commandArtifactSelectSql()} WHERE run_id = ? AND relative_path = ?`, [input.runId, input.relativePath]);
    if (existing) return mapCommandArtifactRow(existing);
    const record: CommandArtifact = {
      id: `command_artifact_${randomId(12)}`,
      ...input,
      artifactRef: input.artifactRef ?? null,
      createdAt: nowIso(),
    };
    this.db.execute(
      `INSERT INTO command_artifacts (id, run_id, relative_path, absolute_path, artifact_ref_json, mime_type, byte_length, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.runId, record.relativePath, record.absolutePath, record.artifactRef ? JSON.stringify(record.artifactRef) : null, record.mimeType, record.byteLength, record.createdAt],
    );
    return record;
  }

  createFromFile(input: { runId: string; projectId: string; relativePath: string; sourcePath: string; mimeType: string | null; createdAt?: string }): CommandArtifact {
    if (!this.artifactStore) throw new Error('ZEUS_COMMAND_ARTIFACT_STORE_REQUIRED');
    const existing = this.db.get<DbCommandArtifactRow>(`${commandArtifactSelectSql()} WHERE run_id = ? AND relative_path = ?`, [input.runId, input.relativePath]);
    if (existing) return mapCommandArtifactRow(existing);
    const id = `command_artifact_${randomId(12)}`;
    const createdAt = input.createdAt ?? nowIso();
    const owner = { kind: 'command_artifact', id, generationId: '2026-08-21-command-artifact-v1', projectId: input.projectId };
    const artifactRef = this.artifactStore.putFileSync({ sourcePath: input.sourcePath, mimeType: input.mimeType ?? 'application/octet-stream', owner, createdAt });
    const hold = this.artifactStore.hold({ sha256: artifactRef.sha256, owner, ownerClass: 'active_task', reason: `命令执行产物 ${id} 仍由运行记录引用`, createdAt });
    try {
      this.db.execute(
        `INSERT INTO command_artifacts (id, run_id, relative_path, absolute_path, artifact_ref_json, mime_type, byte_length, created_at)
         VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
        [id, input.runId, input.relativePath, JSON.stringify(artifactRef), input.mimeType, artifactRef.contentByteLength, createdAt],
      );
    } catch (error) {
      this.artifactStore.releaseHold({ id: hold.id, releasedAt: createdAt });
      this.artifactStore.detachOwner({ sha256: artifactRef.sha256, owner });
      throw error;
    }
    return this.getById(id)!;
  }

  getById(id: string): CommandArtifact | undefined {
    const row = this.db.get<DbCommandArtifactRow>(`${commandArtifactSelectSql()} WHERE id = ?`, [id]);
    return row ? mapCommandArtifactRow(row) : undefined;
  }

  listByRun(runId: string): CommandArtifact[] {
    return this.db.select<DbCommandArtifactRow>(`${commandArtifactSelectSql()} WHERE run_id = ? ORDER BY created_at, id`, [runId]).map(mapCommandArtifactRow);
  }
}

function commandDefinitionSelectSql(): string {
  return `SELECT command_definitions.id, command_definitions.scope, command_definitions.project_id,
                 command_definitions.name, command_definitions.title, command_definitions.description,
                 command_definitions.command_text, command_definitions.parameters_json,
                 command_definitions.timeout_seconds, command_definitions.enabled,
                 command_definitions.telegram_enabled, command_definitions.risk_flags_json,
                 command_definitions.revision, command_definitions.created_at, command_definitions.updated_at
          FROM command_definitions`;
}

function commandRunSelectSql(): string {
  return `SELECT id, command_id, project_id, runtime_session_id, trigger, status,
                 command_snapshot_json, parameter_snapshot_json, cwd, timeout_seconds,
                 exit_code, failure_reason, started_at, ended_at, created_at, updated_at
          FROM command_runs`;
}

function commandArtifactSelectSql(): string {
  return `SELECT id, run_id, relative_path, absolute_path, artifact_ref_json, mime_type, byte_length, created_at
          FROM command_artifacts`;
}

function mapCommandRunRow(row: DbCommandRunRow): CommandRun {
  return {
    id: row.id,
    commandId: row.command_id,
    projectId: row.project_id,
    runtimeSessionId: row.runtime_session_id,
    trigger: row.trigger,
    status: row.status,
    commandSnapshot: JSON.parse(row.command_snapshot_json) as CommandDefinition,
    parameterSnapshot: parseJsonObject(row.parameter_snapshot_json),
    cwd: row.cwd,
    timeoutSeconds: row.timeout_seconds,
    exitCode: row.exit_code,
    failureReason: row.failure_reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCommandArtifactRow(row: DbCommandArtifactRow): CommandArtifact {
  return {
    id: row.id,
    runId: row.run_id,
    relativePath: row.relative_path,
    absolutePath: row.absolute_path,
    artifactRef: parseCommandArtifactRef(row.artifact_ref_json),
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    createdAt: row.created_at,
  };
}

function parseCommandArtifactRef(value: string | null): ArtifactRef | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ArtifactRef>;
    if (typeof parsed.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(parsed.sha256) || typeof parsed.contentSha256 !== 'string' || typeof parsed.relativePath !== 'string') {
      throw new Error('Command ArtifactRef 字段无效。');
    }
    return parsed as ArtifactRef;
  } catch (error) {
    throw new Error('Command ArtifactRef 无法解析。', { cause: error });
  }
}

function normalizeCommandToken(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends Record<string, unknown>>(value: string): T {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
