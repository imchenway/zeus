import {createHash} from 'node:crypto';
import {randomId} from './randomId.js';
import type {ZeusDatabasePort} from './databasePort.js';

export const taskWorkSchemaMigrationId = '20260829_0001_task_work_v2';
export const taskWorkWorkspaceBindingMigrationId = '20260831_0425_task_work_workspace_binding_v1';
export const taskWorkDeliverableArtifactGeneration = 'task_work_deliverable_v1';

export const taskWorkItemStatuses = ['queued', 'active', 'waiting_manager', 'completed', 'blocked', 'failed', 'cancelled'] as const;
export const taskWorkRunStatuses = ['prepared', 'dispatching', 'active', 'waiting_input', 'runtime_completed', 'succeeded', 'failed', 'outcome_unknown', 'cancelled'] as const;
export const taskWorkDeliverableStatuses = ['submitted', 'accepted', 'changes_requested', 'superseded'] as const;
export const taskWorkDecisionStatuses = ['pending', 'resolved', 'dismissed', 'expired'] as const;
export const taskWorkDecisionKinds = ['input_required', 'authorization', 'deliverable_acceptance', 'command_confirmation', 'command_failure', 'outcome_unknown'] as const;
export const taskWorkEntrypointKinds = ['agent', 'command'] as const;

export type TaskWorkItemStatus = (typeof taskWorkItemStatuses)[number];
export type TaskWorkRunStatus = (typeof taskWorkRunStatuses)[number];
export type TaskWorkDeliverableStatus = (typeof taskWorkDeliverableStatuses)[number];
export type TaskWorkDecisionStatus = (typeof taskWorkDecisionStatuses)[number];
export type TaskWorkDecisionKind = (typeof taskWorkDecisionKinds)[number];
export type TaskWorkEntrypointKind = (typeof taskWorkEntrypointKinds)[number];

export interface WorkContextDeliverableRefV1 {
  deliverableId: string;
  version: number;
  contentSha256: string;
  title: string;
}

export interface WorkContextManifestV1 {
  version: 1;
  task: {
    id: string;
    revision: string;
    title: string;
    description: string;
    taskType: string;
    tags: string[];
  };
  attachments: Array<{ path: string; field: string | null }>;
  projectRules: Array<{ identity: string; sha256: string; title: string }>;
  acceptedDeliverables: WorkContextDeliverableRefV1[];
}

export type TaskWorkWorkspaceSnapshot =
  | { mode: 'direct' }
  | { mode: 'existing'; environmentId: string }
  | {
      mode: 'create';
      repositoryRevision: string;
      repositories: Array<{ repositoryId: string; sourceRef: string; branchName: string }>;
    };

export interface TaskWorkItemRecord {
  id: string;
  projectId: string;
  taskId: string;
  employeeId: string;
  source: 'manual' | 'automation';
  sourceRef: string | null;
  title: string;
  description: string;
  entrypointKind: TaskWorkEntrypointKind;
  status: TaskWorkItemStatus;
  currentRunId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskWorkRunRecord {
  id: string;
  projectId: string;
  taskId: string;
  workItemId: string;
  employeeId: string;
  attempt: number;
  status: TaskWorkRunStatus;
  entrypointKind: TaskWorkEntrypointKind;
  employeeRevision: number;
  employeeSnapshot: Record<string, unknown>;
  entrypointSnapshot: Record<string, unknown>;
  modelSnapshot: Record<string, unknown> | null;
  skillSnapshot: Record<string, unknown>;
  authoritySnapshot: Record<string, unknown>;
  contextManifest: WorkContextManifestV1;
  workspaceSnapshot: TaskWorkWorkspaceSnapshot | null;
  environmentId: string | null;
  enabledSkillIds: string[];
  conversationId: string | null;
  commandRunId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  runtimeCompletedAt: string | null;
  completedAt: string | null;
}

export interface TaskWorkDeliverableRecord {
  id: string;
  projectId: string;
  taskId: string;
  workItemId: string;
  runId: string;
  version: number;
  status: TaskWorkDeliverableStatus;
  kind: string;
  title: string;
  summary: string;
  artifactSha256: string;
  contentSha256: string;
  sourceMessageId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
}

export interface TaskWorkDecisionRecord {
  id: string;
  projectId: string;
  taskId: string;
  workItemId: string;
  runId: string | null;
  deliverableId: string | null;
  kind: TaskWorkDecisionKind;
  status: TaskWorkDecisionStatus;
  title: string;
  prompt: string;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown> | null;
  operationIdentity: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
}

export class TaskWorkStoreError extends Error {
  readonly name = 'TaskWorkStoreError';

  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: 400 | 404 | 409 = 409,
  ) {
    super(message);
  }
}

export function migrateTaskWorkSchema(db: ZeusDatabasePort): void {
  const checksumSource = ['task_work_items:v1', 'task_work_runs:v1', 'task_work_deliverables:v1', 'task_work_decisions:v1', 'agent-or-command,isolated-context,versioned-deliverables,manager-decisions'].join(';');
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [taskWorkSchemaMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('任务工作管理 v2 迁移账本与当前结构定义不一致。');
    db.execute(`
      CREATE TABLE IF NOT EXISTS task_work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        entrypoint_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        current_run_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (employee_id) REFERENCES digital_employees(id)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_work_items_task ON task_work_items(task_id, created_at DESC)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_work_items_employee_active ON task_work_items(employee_id, status, created_at)`);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_work_items_source ON task_work_items(source, source_ref) WHERE source_ref IS NOT NULL`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS task_work_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        entrypoint_kind TEXT NOT NULL,
        employee_revision INTEGER NOT NULL,
        employee_snapshot_json TEXT NOT NULL,
        entrypoint_snapshot_json TEXT NOT NULL,
        model_snapshot_json TEXT,
        skill_snapshot_json TEXT NOT NULL,
        authority_snapshot_json TEXT NOT NULL,
        context_manifest_json TEXT NOT NULL,
        enabled_skill_ids_json TEXT NOT NULL DEFAULT '[]',
        conversation_id TEXT,
        command_run_id TEXT,
        error_code TEXT,
        error_message TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        runtime_completed_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (work_item_id) REFERENCES task_work_items(id),
        FOREIGN KEY (employee_id) REFERENCES digital_employees(id),
        UNIQUE (work_item_id, attempt),
        CHECK (NOT (conversation_id IS NOT NULL AND command_run_id IS NOT NULL))
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_work_runs_recoverable ON task_work_runs(status, created_at)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_work_runs_task ON task_work_runs(task_id, created_at DESC)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS task_work_deliverables (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        source_message_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (work_item_id) REFERENCES task_work_items(id),
        FOREIGN KEY (run_id) REFERENCES task_work_runs(id),
        UNIQUE (work_item_id, version)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_work_deliverables_task ON task_work_deliverables(task_id, created_at DESC)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS task_work_decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        run_id TEXT,
        deliverable_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        request_payload_json TEXT NOT NULL,
        response_payload_json TEXT,
        operation_identity TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        expires_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (work_item_id) REFERENCES task_work_items(id),
        FOREIGN KEY (run_id) REFERENCES task_work_runs(id),
        FOREIGN KEY (deliverable_id) REFERENCES task_work_deliverables(id)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_work_decisions_task_pending ON task_work_decisions(task_id, status, created_at)`);
    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      taskWorkSchemaMigrationId,
      '新增任务工作项、冻结运行、版本化交付物与管理者决定',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

/** ZEUS-0425 只做前向加列；既有 v2 工作管理迁移账本保持不变。 */
export function migrateTaskWorkWorkspaceBindingSchema(db: ZeusDatabasePort): void {
  const checksumSource = ['task_work_runs:workspace_snapshot_json,environment_id', 'backfill-from-authoritative-conversation-environment'].join(';');
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [taskWorkWorkspaceBindingMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('任务工作区绑定迁移账本与当前结构不一致。');

    addTaskWorkColumn(db, 'workspace_snapshot_json', 'TEXT');
    addTaskWorkColumn(db, 'environment_id', 'TEXT');
    db.execute(`
      UPDATE task_work_runs
      SET environment_id = (
        SELECT conversations.environment_id
        FROM conversations
        WHERE conversations.id = task_work_runs.conversation_id
      )
      WHERE environment_id IS NULL
        AND conversation_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM conversations
          WHERE conversations.id = task_work_runs.conversation_id
            AND conversations.environment_id IS NOT NULL
        )
    `);
    db.execute(`
      UPDATE task_work_runs
      SET workspace_snapshot_json = json_object('mode', 'existing', 'environmentId', environment_id)
      WHERE workspace_snapshot_json IS NULL AND environment_id IS NOT NULL
    `);
    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      taskWorkWorkspaceBindingMigrationId,
      '冻结数字员工工作区选择并记录实际任务环境身份',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

function addTaskWorkColumn(db: ZeusDatabasePort, column: string, definition: string): void {
  const exists = db.select<{ name: string }>(`PRAGMA table_info(task_work_runs)`).some((candidate) => candidate.name === column);
  if (!exists) db.execute(`ALTER TABLE task_work_runs ADD COLUMN ${column} ${definition}`);
}

export class TaskWorkItemRepository {
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getById(id: string): TaskWorkItemRecord | undefined {
    const row = this.db.get<TaskWorkItemRow>(`SELECT * FROM task_work_items WHERE id = ?`, [identity(id, 'workItemId')]);
    return row ? mapWorkItem(row) : undefined;
  }

  getBySource(source: TaskWorkItemRecord['source'], sourceRef: string): TaskWorkItemRecord | undefined {
    const row = this.db.get<TaskWorkItemRow>(`SELECT * FROM task_work_items WHERE source = ? AND source_ref = ?`, [source, identity(sourceRef, 'sourceRef')]);
    return row ? mapWorkItem(row) : undefined;
  }

  listByTask(taskId: string): TaskWorkItemRecord[] {
    return this.db.select<TaskWorkItemRow>(`SELECT * FROM task_work_items WHERE task_id = ? ORDER BY created_at ASC, id ASC`, [identity(taskId, 'taskId')]).map(mapWorkItem);
  }

  countActiveByEmployee(employeeId: string): number {
    return this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM task_work_items WHERE employee_id = ? AND status IN ('queued','active','waiting_manager','blocked')`, [identity(employeeId, 'employeeId')])?.count ?? 0;
  }

  create(input: Omit<TaskWorkItemRecord, 'revision' | 'createdAt' | 'updatedAt' | 'completedAt' | 'currentRunId'> & { currentRunId?: string | null }): TaskWorkItemRecord {
    if (input.sourceRef) {
      const replay = this.getBySource(input.source, input.sourceRef);
      if (replay) return replay;
    }
    const timestamp = this.now();
    this.db.execute(
      `INSERT INTO task_work_items (id, project_id, task_id, employee_id, source, source_ref, title, description, entrypoint_kind, status, current_run_id, revision, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      [
        identity(input.id, 'workItem.id'),
        identity(input.projectId, 'projectId'),
        identity(input.taskId, 'taskId'),
        identity(input.employeeId, 'employeeId'),
        input.source,
        input.sourceRef ?? null,
        text(input.title, 'title', 240),
        text(input.description, 'description', 4_000, true),
        member(input.entrypointKind, taskWorkEntrypointKinds, 'entrypointKind'),
        member(input.status, taskWorkItemStatuses, 'status'),
        input.currentRunId ?? null,
        timestamp,
        timestamp,
      ],
    );
    return this.getById(input.id)!;
  }

  update(id: string, input: { expectedRevision?: number; status?: TaskWorkItemStatus; currentRunId?: string | null; completedAt?: string | null }): TaskWorkItemRecord {
    const current = this.require(id);
    if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) conflict('工作项已更新，请刷新后重试。');
    const status = input.status ?? current.status;
    assertWorkItemTransition(current.status, status);
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    this.db.execute(`UPDATE task_work_items SET status = ?, current_run_id = ?, completed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`, [
      status,
      input.currentRunId === undefined ? current.currentRunId : input.currentRunId,
      input.completedAt === undefined ? current.completedAt : input.completedAt,
      timestamp,
      current.id,
      current.revision,
    ]);
    assertChanged(this.db, '工作项已更新，请刷新后重试。');
    return this.getById(id)!;
  }

  private require(id: string): TaskWorkItemRecord {
    const current = this.getById(id);
    if (!current) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ITEM_NOT_FOUND', '工作项不存在。', 404);
    return current;
  }
}

export class TaskWorkRunRepository {
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getById(id: string): TaskWorkRunRecord | undefined {
    const row = this.db.get<TaskWorkRunRow>(`SELECT * FROM task_work_runs WHERE id = ?`, [identity(id, 'runId')]);
    return row ? mapWorkRun(row) : undefined;
  }

  listByTask(taskId: string): TaskWorkRunRecord[] {
    return this.db.select<TaskWorkRunRow>(`SELECT * FROM task_work_runs WHERE task_id = ? ORDER BY created_at ASC, id ASC`, [identity(taskId, 'taskId')]).map(mapWorkRun);
  }

  listRecoverable(limit = 100): TaskWorkRunRecord[] {
    return this.db.select<TaskWorkRunRow>(`SELECT * FROM task_work_runs WHERE status IN ('prepared','dispatching','active','waiting_input','runtime_completed') ORDER BY created_at ASC LIMIT ?`, [boundedLimit(limit)]).map(mapWorkRun);
  }

  nextAttempt(workItemId: string): number {
    return (this.db.get<{ maximum: number | null }>(`SELECT MAX(attempt) AS maximum FROM task_work_runs WHERE work_item_id = ?`, [identity(workItemId, 'workItemId')])?.maximum ?? 0) + 1;
  }

  create(
    input: Omit<TaskWorkRunRecord, 'revision' | 'createdAt' | 'updatedAt' | 'startedAt' | 'runtimeCompletedAt' | 'completedAt' | 'conversationId' | 'commandRunId' | 'errorCode' | 'errorMessage' | 'enabledSkillIds'>,
  ): TaskWorkRunRecord {
    const timestamp = this.now();
    this.db.execute(
      `INSERT INTO task_work_runs
       (id, project_id, task_id, work_item_id, employee_id, attempt, status, entrypoint_kind, employee_revision, employee_snapshot_json, entrypoint_snapshot_json, model_snapshot_json, skill_snapshot_json, authority_snapshot_json, context_manifest_json, workspace_snapshot_json, environment_id, enabled_skill_ids_json, conversation_id, command_run_id, error_code, error_message, revision, created_at, updated_at, started_at, runtime_completed_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, NULL, NULL, NULL, 1, ?, ?, NULL, NULL, NULL)`,
      [
        identity(input.id, 'run.id'),
        identity(input.projectId, 'projectId'),
        identity(input.taskId, 'taskId'),
        identity(input.workItemId, 'workItemId'),
        identity(input.employeeId, 'employeeId'),
        positiveInteger(input.attempt, 'attempt'),
        member(input.status, taskWorkRunStatuses, 'status'),
        member(input.entrypointKind, taskWorkEntrypointKinds, 'entrypointKind'),
        positiveInteger(input.employeeRevision + 1, 'employeeRevisionPlusOne') - 1,
        json(input.employeeSnapshot),
        json(input.entrypointSnapshot),
        input.modelSnapshot ? json(input.modelSnapshot) : null,
        json(input.skillSnapshot),
        json(input.authoritySnapshot),
        json(input.contextManifest),
        input.workspaceSnapshot ? json(input.workspaceSnapshot) : null,
        input.environmentId ? identity(input.environmentId, 'environmentId') : null,
        timestamp,
        timestamp,
      ],
    );
    return this.getById(input.id)!;
  }

  update(
    id: string,
    input: {
      expectedRevision?: number;
      status?: TaskWorkRunStatus;
      enabledSkillIds?: string[];
      conversationId?: string | null;
      commandRunId?: string | null;
      workspaceSnapshot?: TaskWorkWorkspaceSnapshot | null;
      environmentId?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      startedAt?: string | null;
      runtimeCompletedAt?: string | null;
      completedAt?: string | null;
    },
  ): TaskWorkRunRecord {
    const current = this.require(id);
    if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) conflict('工作运行已更新，请刷新后重试。');
    const status = input.status ?? current.status;
    assertRunTransition(current.status, status);
    const conversationId = input.conversationId === undefined ? current.conversationId : input.conversationId;
    const commandRunId = input.commandRunId === undefined ? current.commandRunId : input.commandRunId;
    if (conversationId && commandRunId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_RUN_REFERENCE_CONFLICT', 'Agent 会话与 Command 运行不能同时绑定。', 400);
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    this.db.execute(
      `UPDATE task_work_runs SET status = ?, enabled_skill_ids_json = ?, conversation_id = ?, command_run_id = ?, workspace_snapshot_json = ?, environment_id = ?, error_code = ?, error_message = ?, started_at = ?, runtime_completed_at = ?, completed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`,
      [
        status,
        JSON.stringify(input.enabledSkillIds ?? current.enabledSkillIds),
        conversationId,
        commandRunId,
        input.workspaceSnapshot === undefined ? (current.workspaceSnapshot ? json(current.workspaceSnapshot) : null) : input.workspaceSnapshot ? json(input.workspaceSnapshot) : null,
        input.environmentId === undefined ? current.environmentId : input.environmentId ? identity(input.environmentId, 'environmentId') : null,
        input.errorCode === undefined ? current.errorCode : input.errorCode,
        input.errorMessage === undefined ? current.errorMessage : input.errorMessage,
        input.startedAt === undefined ? current.startedAt : input.startedAt,
        input.runtimeCompletedAt === undefined ? current.runtimeCompletedAt : input.runtimeCompletedAt,
        input.completedAt === undefined ? current.completedAt : input.completedAt,
        timestamp,
        current.id,
        current.revision,
      ],
    );
    assertChanged(this.db, '工作运行已更新，请刷新后重试。');
    return this.getById(id)!;
  }

  private require(id: string): TaskWorkRunRecord {
    const current = this.getById(id);
    if (!current) throw new TaskWorkStoreError('ZEUS_TASK_WORK_RUN_NOT_FOUND', '工作运行不存在。', 404);
    return current;
  }
}

export class TaskWorkDeliverableRepository {
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getById(id: string): TaskWorkDeliverableRecord | undefined {
    const row = this.db.get<TaskWorkDeliverableRow>(`SELECT * FROM task_work_deliverables WHERE id = ?`, [identity(id, 'deliverableId')]);
    return row ? mapDeliverable(row) : undefined;
  }

  listByTask(taskId: string): TaskWorkDeliverableRecord[] {
    return this.db.select<TaskWorkDeliverableRow>(`SELECT * FROM task_work_deliverables WHERE task_id = ? ORDER BY created_at DESC, id DESC`, [identity(taskId, 'taskId')]).map(mapDeliverable);
  }

  listAcceptedByTask(taskId: string): TaskWorkDeliverableRecord[] {
    return this.db.select<TaskWorkDeliverableRow>(`SELECT * FROM task_work_deliverables WHERE task_id = ? AND status = 'accepted' ORDER BY created_at DESC`, [identity(taskId, 'taskId')]).map(mapDeliverable);
  }

  create(input: Omit<TaskWorkDeliverableRecord, 'id' | 'version' | 'status' | 'revision' | 'createdAt' | 'updatedAt' | 'acceptedAt'> & { id?: string }): TaskWorkDeliverableRecord {
      const id = input.id ?? `task_work_deliverable_${randomId(16)}`;
    const version = (this.db.get<{ maximum: number | null }>(`SELECT MAX(version) AS maximum FROM task_work_deliverables WHERE work_item_id = ?`, [identity(input.workItemId, 'workItemId')])?.maximum ?? 0) + 1;
    const timestamp = this.now();
    this.db.execute(
      `INSERT INTO task_work_deliverables (id, project_id, task_id, work_item_id, run_id, version, status, kind, title, summary, artifact_sha256, content_sha256, source_message_id, revision, created_at, updated_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      [
        id,
        input.projectId,
        input.taskId,
        input.workItemId,
        input.runId,
        version,
        text(input.kind, 'kind', 80),
        text(input.title, 'title', 240),
        text(input.summary, 'summary', 4_000, true),
        sha256(input.artifactSha256, 'artifactSha256'),
        sha256(input.contentSha256, 'contentSha256'),
        input.sourceMessageId ?? null,
        timestamp,
        timestamp,
      ],
    );
    return this.getById(id)!;
  }

  transition(id: string, expectedRevision: number, status: Extract<TaskWorkDeliverableStatus, 'accepted' | 'changes_requested' | 'superseded'>): TaskWorkDeliverableRecord {
    const current = this.getById(id);
    if (!current) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DELIVERABLE_NOT_FOUND', '交付物不存在。', 404);
    if (current.revision !== expectedRevision) conflict('交付物已更新，请刷新后重试。');
    if (current.status !== 'submitted') conflict('只有待验收交付物可以执行该操作。');
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    this.db.execute(`UPDATE task_work_deliverables SET status = ?, accepted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'submitted'`, [
      status,
      status === 'accepted' ? timestamp : null,
      timestamp,
      current.id,
      current.revision,
    ]);
    assertChanged(this.db, '交付物已更新，请刷新后重试。');
    return this.getById(id)!;
  }
}

export class TaskWorkDecisionRepository {
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getById(id: string): TaskWorkDecisionRecord | undefined {
    const row = this.db.get<TaskWorkDecisionRow>(`SELECT * FROM task_work_decisions WHERE id = ?`, [identity(id, 'decisionId')]);
    return row ? mapDecision(row) : undefined;
  }

  getByOperation(operationIdentity: string): TaskWorkDecisionRecord | undefined {
    const row = this.db.get<TaskWorkDecisionRow>(`SELECT * FROM task_work_decisions WHERE operation_identity = ?`, [identity(operationIdentity, 'operationIdentity')]);
    return row ? mapDecision(row) : undefined;
  }

  listByTask(taskId: string): TaskWorkDecisionRecord[] {
    return this.db.select<TaskWorkDecisionRow>(`SELECT * FROM task_work_decisions WHERE task_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`, [identity(taskId, 'taskId')]).map(mapDecision);
  }

  create(input: Omit<TaskWorkDecisionRecord, 'id' | 'status' | 'responsePayload' | 'revision' | 'createdAt' | 'updatedAt' | 'resolvedAt'> & { id?: string }): TaskWorkDecisionRecord {
    const replay = this.getByOperation(input.operationIdentity);
    if (replay) return replay;
      const id = input.id ?? `task_work_decision_${randomId(16)}`;
    const timestamp = this.now();
    this.db.execute(
      `INSERT INTO task_work_decisions (id, project_id, task_id, work_item_id, run_id, deliverable_id, kind, status, title, prompt, request_payload_json, response_payload_json, operation_identity, revision, created_at, updated_at, resolved_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, ?, 1, ?, ?, NULL, ?)`,
      [
        id,
        input.projectId,
        input.taskId,
        input.workItemId,
        input.runId,
        input.deliverableId,
        member(input.kind, taskWorkDecisionKinds, 'decision.kind'),
        text(input.title, 'title', 240),
        text(input.prompt, 'prompt', 4_000, true),
        json(input.requestPayload),
        identity(input.operationIdentity, 'operationIdentity'),
        timestamp,
        timestamp,
        input.expiresAt,
      ],
    );
    return this.getById(id)!;
  }

  resolve(id: string, expectedRevision: number, responsePayload: Record<string, unknown>, status: Extract<TaskWorkDecisionStatus, 'resolved' | 'dismissed'> = 'resolved'): TaskWorkDecisionRecord {
    const current = this.getById(id);
    if (!current) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DECISION_NOT_FOUND', '管理者待办不存在。', 404);
    if (current.revision !== expectedRevision) conflict('管理者待办已更新，请刷新后重试。');
    if (current.status !== 'pending') conflict('该管理者待办已经处置。');
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    this.db.execute(`UPDATE task_work_decisions SET status = ?, response_payload_json = ?, resolved_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'pending'`, [
      status,
      json(responsePayload),
      timestamp,
      timestamp,
      current.id,
      current.revision,
    ]);
    assertChanged(this.db, '管理者待办已更新，请刷新后重试。');
    return this.getById(id)!;
  }
}

interface TaskWorkItemRow {
  id: string;
  project_id: string;
  task_id: string;
  employee_id: string;
  source: string;
  source_ref: string | null;
  title: string;
  description: string;
  entrypoint_kind: string;
  status: string;
  current_run_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
interface TaskWorkRunRow {
  id: string;
  project_id: string;
  task_id: string;
  work_item_id: string;
  employee_id: string;
  attempt: number;
  status: string;
  entrypoint_kind: string;
  employee_revision: number;
  employee_snapshot_json: string;
  entrypoint_snapshot_json: string;
  model_snapshot_json: string | null;
  skill_snapshot_json: string;
  authority_snapshot_json: string;
  context_manifest_json: string;
  workspace_snapshot_json: string | null;
  environment_id: string | null;
  enabled_skill_ids_json: string;
  conversation_id: string | null;
  command_run_id: string | null;
  error_code: string | null;
  error_message: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  runtime_completed_at: string | null;
  completed_at: string | null;
}
interface TaskWorkDeliverableRow {
  id: string;
  project_id: string;
  task_id: string;
  work_item_id: string;
  run_id: string;
  version: number;
  status: string;
  kind: string;
  title: string;
  summary: string;
  artifact_sha256: string;
  content_sha256: string;
  source_message_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
}
interface TaskWorkDecisionRow {
  id: string;
  project_id: string;
  task_id: string;
  work_item_id: string;
  run_id: string | null;
  deliverable_id: string | null;
  kind: string;
  status: string;
  title: string;
  prompt: string;
  request_payload_json: string;
  response_payload_json: string | null;
  operation_identity: string;
  revision: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  expires_at: string | null;
}

function mapWorkItem(row: TaskWorkItemRow): TaskWorkItemRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    employeeId: row.employee_id,
    source: member(row.source, ['manual', 'automation'] as const, 'workItem.source'),
    sourceRef: row.source_ref,
    title: row.title,
    description: row.description,
    entrypointKind: member(row.entrypoint_kind, taskWorkEntrypointKinds, 'workItem.entrypointKind'),
    status: member(row.status, taskWorkItemStatuses, 'workItem.status'),
    currentRunId: row.current_run_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapWorkRun(row: TaskWorkRunRow): TaskWorkRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    workItemId: row.work_item_id,
    employeeId: row.employee_id,
    attempt: row.attempt,
    status: member(row.status, taskWorkRunStatuses, 'run.status'),
    entrypointKind: member(row.entrypoint_kind, taskWorkEntrypointKinds, 'run.entrypointKind'),
    employeeRevision: row.employee_revision,
    employeeSnapshot: record(row.employee_snapshot_json, 'run.employeeSnapshot'),
    entrypointSnapshot: record(row.entrypoint_snapshot_json, 'run.entrypointSnapshot'),
    modelSnapshot: row.model_snapshot_json ? record(row.model_snapshot_json, 'run.modelSnapshot') : null,
    skillSnapshot: record(row.skill_snapshot_json, 'run.skillSnapshot'),
    authoritySnapshot: record(row.authority_snapshot_json, 'run.authoritySnapshot'),
    contextManifest: record(row.context_manifest_json, 'run.contextManifest') as unknown as WorkContextManifestV1,
    workspaceSnapshot: row.workspace_snapshot_json ? taskWorkWorkspaceSnapshot(row.workspace_snapshot_json) : null,
    environmentId: row.environment_id ? identity(row.environment_id, 'run.environmentId') : null,
    enabledSkillIds: stringArray(row.enabled_skill_ids_json, 'run.enabledSkillIds'),
    conversationId: row.conversation_id,
    commandRunId: row.command_run_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    runtimeCompletedAt: row.runtime_completed_at,
    completedAt: row.completed_at,
  };
}

function mapDeliverable(row: TaskWorkDeliverableRow): TaskWorkDeliverableRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    version: row.version,
    status: member(row.status, taskWorkDeliverableStatuses, 'deliverable.status'),
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    artifactSha256: row.artifact_sha256,
    contentSha256: row.content_sha256,
    sourceMessageId: row.source_message_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
  };
}

function mapDecision(row: TaskWorkDecisionRow): TaskWorkDecisionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    deliverableId: row.deliverable_id,
    kind: member(row.kind, taskWorkDecisionKinds, 'decision.kind'),
    status: member(row.status, taskWorkDecisionStatuses, 'decision.status'),
    title: row.title,
    prompt: row.prompt,
    requestPayload: record(row.request_payload_json, 'decision.requestPayload'),
    responsePayload: row.response_payload_json ? record(row.response_payload_json, 'decision.responsePayload') : null,
    operationIdentity: row.operation_identity,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    expiresAt: row.expires_at,
  };
}

function assertWorkItemTransition(from: TaskWorkItemStatus, to: TaskWorkItemStatus): void {
  if (from === to) return;
  const allowed: Record<TaskWorkItemStatus, readonly TaskWorkItemStatus[]> = {
    queued: ['active', 'blocked', 'failed', 'cancelled'],
    active: ['waiting_manager', 'completed', 'blocked', 'failed', 'cancelled'],
    waiting_manager: ['active', 'completed', 'blocked', 'failed', 'cancelled'],
    blocked: ['active', 'completed', 'failed', 'cancelled'],
    failed: ['active', 'cancelled'],
    completed: [],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) conflict(`工作项状态不能从 ${from} 转为 ${to}。`);
}

function assertRunTransition(from: TaskWorkRunStatus, to: TaskWorkRunStatus): void {
  if (from === to) return;
  const allowed: Record<TaskWorkRunStatus, readonly TaskWorkRunStatus[]> = {
    prepared: ['dispatching', 'cancelled'],
    dispatching: ['active', 'waiting_input', 'failed', 'outcome_unknown', 'cancelled'],
    active: ['waiting_input', 'runtime_completed', 'succeeded', 'failed', 'outcome_unknown', 'cancelled'],
    waiting_input: ['active', 'failed', 'outcome_unknown', 'cancelled'],
    runtime_completed: ['succeeded', 'failed', 'outcome_unknown'],
    succeeded: [],
    failed: [],
    outcome_unknown: ['succeeded', 'failed'],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) conflict(`工作运行状态不能从 ${from} 转为 ${to}。`);
}

function identity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw new TaskWorkStoreError('ZEUS_TASK_WORK_INVALID', `${field} 无效。`, 400);
  return normalized;
}
function text(value: string, field: string, maximum: number, allowEmpty = false): string {
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maximum) throw new TaskWorkStoreError('ZEUS_TASK_WORK_INVALID', `${field} 无效。`, 400);
  return normalized;
}
function json(value: unknown): string {
  return JSON.stringify(value);
}
function record(value: string, field: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${field} 损坏。`);
  return parsed as Record<string, unknown>;
}
function taskWorkWorkspaceSnapshot(value: string): TaskWorkWorkspaceSnapshot {
  const parsed = record(value, 'run.workspaceSnapshot');
  if (parsed.mode === 'direct') return { mode: 'direct' };
  if (parsed.mode === 'existing' && typeof parsed.environmentId === 'string') return { mode: 'existing', environmentId: identity(parsed.environmentId, 'run.workspaceSnapshot.environmentId') };
  if (parsed.mode === 'create' && typeof parsed.repositoryRevision === 'string' && Array.isArray(parsed.repositories)) {
    const repositories = parsed.repositories.map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`run.workspaceSnapshot.repositories[${index}] 损坏。`);
      const repository = candidate as Record<string, unknown>;
      if (typeof repository.repositoryId !== 'string' || typeof repository.sourceRef !== 'string' || typeof repository.branchName !== 'string') {
        throw new Error(`run.workspaceSnapshot.repositories[${index}] 损坏。`);
      }
      return {
        repositoryId: identity(repository.repositoryId, `run.workspaceSnapshot.repositories[${index}].repositoryId`),
        sourceRef: identity(repository.sourceRef, `run.workspaceSnapshot.repositories[${index}].sourceRef`),
        branchName: identity(repository.branchName, `run.workspaceSnapshot.repositories[${index}].branchName`),
      };
    });
    if (repositories.length === 0) throw new Error('run.workspaceSnapshot.repositories 损坏。');
    return { mode: 'create', repositoryRevision: identity(parsed.repositoryRevision, 'run.workspaceSnapshot.repositoryRevision'), repositories };
  }
  throw new Error('run.workspaceSnapshot 损坏。');
}
function stringArray(value: string, field: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new Error(`${field} 损坏。`);
  return parsed;
}
function sha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_INVALID', `${field} 无效。`, 400);
  return value;
}
function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new TaskWorkStoreError('ZEUS_TASK_WORK_INVALID', `${field} 无效。`, 400);
  return value;
}
function boundedLimit(value: number): number {
  return Number.isInteger(value) ? Math.max(1, Math.min(500, value)) : 100;
}
function member<const Values extends readonly string[]>(value: string, values: Values, field: string): Values[number] {
  if (!values.includes(value)) throw new Error(`${field} 包含未知值 ${value}。`);
  return value as Values[number];
}
function nextTimestamp(previous: string, candidate: string): string {
  return candidate > previous ? candidate : new Date(Date.parse(previous) + 1).toISOString();
}
function conflict(message: string): never {
  throw new TaskWorkStoreError('ZEUS_TASK_WORK_REVISION_CONFLICT', message, 409);
}
function assertChanged(db: ZeusDatabasePort, message: string): void {
  if ((db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) !== 1) conflict(message);
}
