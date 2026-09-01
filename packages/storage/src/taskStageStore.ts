import {createHash} from 'node:crypto';
import {randomId} from './randomId.js';
import type {ArtifactRef} from './artifactStore.js';
import type {ZeusDatabasePort} from './databasePort.js';

export const taskStageSchemaMigrationId = '20260825_0263_task_stage_workflows_v1';
export const taskStageDeliverableArtifactGeneration = '2026-08-25-task-stage-deliverable-v1';

export type TaskWorkflowStatus = 'active' | 'completed' | 'cancelled';
export type TaskStageKind = 'plan' | 'implementation' | 'code_review' | 'custom';
export type TaskStageStatus = 'pending' | 'ready' | 'running' | 'awaiting_acceptance' | 'accepted' | 'changes_requested' | 'failed' | 'cancelled' | 'skipped';
export type TaskStageAttemptStatus = 'starting' | 'active' | 'completed' | 'failed' | 'outcome_unknown' | 'cancelled';
export type TaskStageDeliverableStatus = 'submitted' | 'accepted' | 'changes_requested' | 'superseded';
export type TaskStageAdvanceMode = 'manual' | 'auto';
export type TaskStageAgentKind = 'codex' | 'pi';
export type TaskStagePermissionMode = 'read-only' | 'auto' | 'full-access';
export type TaskStageWorkMode = 'default' | 'plan';
export type TaskStageEmployeeMode = 'none' | 'inherit' | 'explicit';

export type TaskStageStoreErrorCode =
  | 'ZEUS_TASK_WORKFLOW_NOT_FOUND'
  | 'ZEUS_TASK_WORKFLOW_ALREADY_EXISTS'
  | 'ZEUS_TASK_STAGE_NOT_FOUND'
  | 'ZEUS_TASK_STAGE_NOT_CONFIGURED'
  | 'ZEUS_TASK_STAGE_NOT_READY'
  | 'ZEUS_TASK_STAGE_ACTIVE_ATTEMPT_EXISTS'
  | 'ZEUS_TASK_STAGE_ATTEMPT_NOT_FOUND'
  | 'ZEUS_TASK_STAGE_CONVERSATION_CONFLICT'
  | 'ZEUS_TASK_STAGE_DELIVERABLE_NOT_FOUND'
  | 'ZEUS_TASK_STAGE_DELIVERABLE_CONFLICT'
  | 'ZEUS_TASK_STAGE_REVISION_CONFLICT'
  | 'ZEUS_TASK_STAGE_INVALID_ARGUMENT'
  | 'ZEUS_TASK_STAGE_DOWNSTREAM_STARTED';

export class TaskStageStoreError extends Error {
  readonly name = 'TaskStageStoreError';

  constructor(
    readonly code: TaskStageStoreErrorCode,
    message: string,
    readonly statusCode: number,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
  }
}

export interface ZeusTaskWorkflowRecord {
  id: string;
  taskId: string;
  templateKey: string;
  templateRevision: number;
  status: TaskWorkflowStatus;
  currentStageId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTaskStageRecord {
  id: string;
  workflowId: string;
  taskId: string;
  stageKey: string;
  sequence: number;
  kind: TaskStageKind;
  title: string;
  description: string;
  status: TaskStageStatus;
  employeeMode: TaskStageEmployeeMode;
  employeeId: string | null;
  agentKind: TaskStageAgentKind;
  modelRef: string;
  effort: string | null;
  serviceTier: string | null;
  workMode: TaskStageWorkMode;
  permissionMode: TaskStagePermissionMode;
  advanceMode: TaskStageAdvanceMode;
  prompt: string;
  outputContractJson: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTaskStageAttemptRecord {
  id: string;
  taskId: string;
  stageId: string;
  attemptNumber: number;
  operationIdentity: string;
  conversationId: string | null;
  submissionId: string | null;
  segmentId: string | null;
  workspaceId: string | null;
  environmentId: string | null;
  workExecutionId: string | null;
  employeeId: string | null;
  employeeRevision: number | null;
  employeeSnapshot: Record<string, unknown> | null;
  skillId: string | null;
  effectivePermissions: Record<string, unknown> | null;
  agentKind: TaskStageAgentKind;
  modelRef: string;
  effort: string | null;
  serviceTier: string | null;
  workMode: TaskStageWorkMode;
  permissionMode: TaskStagePermissionMode;
  inputDeliverableIds: string[];
  sourceSnapshotJson: string;
  status: TaskStageAttemptStatus;
  errorJson: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTaskStageDeliverableRecord {
  id: string;
  taskId: string;
  stageId: string;
  attemptId: string;
  version: number;
  kind: string;
  title: string;
  summary: string;
  mimeType: string;
  artifactSha256: string;
  artifactRefJson: string;
  contentSha256: string;
  contentByteLength: number;
  operationIdentity: string;
  status: TaskStageDeliverableStatus;
  decisionReason: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTaskStageSnapshot extends ZeusTaskStageRecord {
  attempts: ZeusTaskStageAttemptRecord[];
  deliverables: ZeusTaskStageDeliverableRecord[];
}

export interface ZeusTaskWorkflowSnapshot {
  workflow: ZeusTaskWorkflowRecord;
  stages: ZeusTaskStageSnapshot[];
}

export interface CreateTaskStageInput {
  stageKey: string;
  kind: TaskStageKind;
  title: string;
  description: string;
  agentKind: TaskStageAgentKind;
  modelRef: string;
  effort?: string | null;
  serviceTier?: string | null;
  workMode: TaskStageWorkMode;
  permissionMode: TaskStagePermissionMode;
  advanceMode: TaskStageAdvanceMode;
  prompt: string;
  outputContract: Record<string, unknown>;
}

export interface UpdateTaskStageInput {
  expectedRevision: number;
  title?: string;
  description?: string;
  agentKind?: TaskStageAgentKind;
  modelRef?: string;
  effort?: string | null;
  serviceTier?: string | null;
  workMode?: TaskStageWorkMode;
  permissionMode?: TaskStagePermissionMode;
  advanceMode?: TaskStageAdvanceMode;
  prompt?: string;
  outputContract?: Record<string, unknown>;
}

export interface PrepareTaskStageAttemptInput {
  stageId: string;
  operationIdentity: string;
  sourceSnapshot?: Record<string, unknown>;
  workExecutionId?: string | null;
  employeeId?: string | null;
  employeeRevision?: number | null;
  employeeSnapshot?: Record<string, unknown> | null;
  skillId?: string | null;
  effectivePermissions?: Record<string, unknown> | null;
}

export interface AssignTaskStageEmployeeInput {
  expectedRevision: number;
  employeeMode: Exclude<TaskStageEmployeeMode, 'none'>;
  employeeId: string;
  agentKind: TaskStageAgentKind;
  modelRef: string;
  effort?: string | null;
  serviceTier?: string | null;
  workMode: TaskStageWorkMode;
  permissionMode: TaskStagePermissionMode;
  prompt: string;
}

export interface BindTaskStageAttemptInput {
  attemptId: string;
  conversationId: string;
  submissionId: string;
  segmentId?: string | null;
  workspaceId?: string | null;
  environmentId?: string | null;
  agentKind: TaskStageAgentKind;
  modelRef: string;
  effort?: string | null;
  serviceTier?: string | null;
  workMode: TaskStageWorkMode;
  permissionMode: TaskStagePermissionMode;
}

export interface BindExistingTaskStageAttemptInput {
  attemptId: string;
  conversationId: string;
  workspaceId?: string | null;
  environmentId?: string | null;
}

export interface CreateTaskStageDeliverableInput {
  taskId: string;
  stageId: string;
  attemptId: string;
  operationIdentity: string;
  kind: string;
  title: string;
  summary: string;
  artifactRef: ArtifactRef;
}

interface TaskWorkflowRow {
  id: string;
  task_id: string;
  template_key: string;
  template_revision: number;
  status: TaskWorkflowStatus;
  current_stage_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface TaskStageRow {
  id: string;
  workflow_id: string;
  task_id: string;
  stage_key: string;
  sequence: number;
  kind: TaskStageKind;
  title: string;
  description: string;
  status: TaskStageStatus;
  employee_mode: TaskStageEmployeeMode;
  employee_id: string | null;
  agent_kind: TaskStageAgentKind;
  model_ref: string;
  effort: string | null;
  service_tier: string | null;
  work_mode: TaskStageWorkMode;
  permission_mode: TaskStagePermissionMode;
  advance_mode: TaskStageAdvanceMode;
  prompt: string;
  output_contract_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface TaskStageAttemptRow {
  id: string;
  task_id: string;
  stage_id: string;
  attempt_number: number;
  operation_identity: string;
  conversation_id: string | null;
  submission_id: string | null;
  segment_id: string | null;
  workspace_id: string | null;
  environment_id: string | null;
  work_execution_id: string | null;
  employee_id: string | null;
  employee_revision: number | null;
  employee_snapshot_json: string | null;
  skill_id: string | null;
  effective_permissions_json: string | null;
  agent_kind: TaskStageAgentKind;
  model_ref: string;
  effort: string | null;
  service_tier: string | null;
  work_mode: TaskStageWorkMode;
  permission_mode: TaskStagePermissionMode;
  input_deliverable_ids_json: string;
  source_snapshot_json: string;
  status: TaskStageAttemptStatus;
  error_json: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskStageDeliverableRow {
  id: string;
  task_id: string;
  stage_id: string;
  attempt_id: string;
  version: number;
  kind: string;
  title: string;
  summary: string;
  mime_type: string;
  artifact_sha256: string;
  artifact_ref_json: string;
  content_sha256: string;
  content_byte_length: number;
  operation_identity: string;
  status: TaskStageDeliverableStatus;
  decision_reason: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

const selectWorkflowFields = 'id, task_id, template_key, template_revision, status, current_stage_id, revision, created_at, updated_at';
const selectStageFields =
  'id, workflow_id, task_id, stage_key, sequence, kind, title, description, status, employee_mode, employee_id, agent_kind, model_ref, effort, service_tier, work_mode, permission_mode, advance_mode, prompt, output_contract_json, revision, created_at, updated_at';
const selectAttemptFields =
  'id, task_id, stage_id, attempt_number, operation_identity, conversation_id, submission_id, segment_id, workspace_id, environment_id, work_execution_id, employee_id, employee_revision, employee_snapshot_json, skill_id, effective_permissions_json, agent_kind, model_ref, effort, service_tier, work_mode, permission_mode, input_deliverable_ids_json, source_snapshot_json, status, error_json, started_at, completed_at, created_at, updated_at';
const selectDeliverableFields =
  'id, task_id, stage_id, attempt_id, version, kind, title, summary, mime_type, artifact_sha256, artifact_ref_json, content_sha256, content_byte_length, operation_identity, status, decision_reason, accepted_at, created_at, updated_at';
const selectJoinedDeliverableFields = selectDeliverableFields
  .split(', ')
  .map((field) => `deliverable.${field} AS ${field}`)
  .join(', ');

export function migrateTaskStageSchema(db: ZeusDatabasePort): void {
  const checksumSource = 'task-stage-workflows:v1:workflow,ordered-stage,immutable-attempt,versioned-artifact-ref,manual-or-auto-acceptance,review-rework-loop';
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [taskStageSchemaMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('任务阶段工作流迁移账本与当前结构不一致。');
    db.execute(`
      CREATE TABLE IF NOT EXISTS task_workflows (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        template_key TEXT NOT NULL,
        template_revision INTEGER NOT NULL CHECK (template_revision >= 1),
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
        current_stage_id TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS task_stages (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        stage_key TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        kind TEXT NOT NULL CHECK (kind IN ('plan', 'implementation', 'code_review', 'custom')),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'running', 'awaiting_acceptance', 'accepted', 'changes_requested', 'failed', 'cancelled', 'skipped')),
        agent_kind TEXT NOT NULL CHECK (agent_kind IN ('codex', 'pi')),
        model_ref TEXT NOT NULL,
        effort TEXT,
        service_tier TEXT,
        work_mode TEXT NOT NULL CHECK (work_mode IN ('default', 'plan')),
        permission_mode TEXT NOT NULL CHECK (permission_mode IN ('read-only', 'auto', 'full-access')),
        advance_mode TEXT NOT NULL CHECK (advance_mode IN ('manual', 'auto')),
        prompt TEXT NOT NULL,
        output_contract_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workflow_id, stage_key),
        UNIQUE (workflow_id, sequence),
        FOREIGN KEY (workflow_id) REFERENCES task_workflows(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS task_stage_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        operation_identity TEXT NOT NULL UNIQUE,
        conversation_id TEXT UNIQUE,
        submission_id TEXT UNIQUE,
        segment_id TEXT,
        workspace_id TEXT,
        environment_id TEXT,
        agent_kind TEXT NOT NULL CHECK (agent_kind IN ('codex', 'pi')),
        model_ref TEXT NOT NULL,
        effort TEXT,
        service_tier TEXT,
        work_mode TEXT NOT NULL CHECK (work_mode IN ('default', 'plan')),
        permission_mode TEXT NOT NULL CHECK (permission_mode IN ('read-only', 'auto', 'full-access')),
        input_deliverable_ids_json TEXT NOT NULL,
        source_snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('starting', 'active', 'completed', 'failed', 'outcome_unknown', 'cancelled')),
        error_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (stage_id, attempt_number),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (stage_id) REFERENCES task_stages(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS task_stage_deliverables (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL,
        artifact_ref_json TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        content_byte_length INTEGER NOT NULL CHECK (content_byte_length >= 0),
        operation_identity TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('submitted', 'accepted', 'changes_requested', 'superseded')),
        decision_reason TEXT,
        accepted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (stage_id, version),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (stage_id) REFERENCES task_stages(id) ON DELETE CASCADE,
        FOREIGN KEY (attempt_id) REFERENCES task_stage_attempts(id) ON DELETE CASCADE
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_stages_task_sequence ON task_stages(task_id, sequence)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_stage_attempts_stage_created ON task_stage_attempts(stage_id, attempt_number)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_stage_attempts_task_status ON task_stage_attempts(task_id, status, updated_at)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_stage_deliverables_stage_version ON task_stage_deliverables(stage_id, version)`);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_stage_one_open_attempt ON task_stage_attempts(stage_id) WHERE status IN ('starting', 'active')`);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_stage_one_accepted_deliverable ON task_stage_deliverables(stage_id) WHERE status = 'accepted'`);
    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      taskStageSchemaMigrationId,
      '增加任务级阶段工作流、冻结执行尝试与版本化交付物',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

export class TaskStageRepository {
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getWorkflowByTask(taskId: string): ZeusTaskWorkflowSnapshot | null {
    const row = this.db.get<TaskWorkflowRow>(`SELECT ${selectWorkflowFields} FROM task_workflows WHERE task_id = ?`, [taskId]);
    if (!row) return null;
    const workflow = mapWorkflowRow(row);
    const stages = this.db
      .select<TaskStageRow>(`SELECT ${selectStageFields} FROM task_stages WHERE workflow_id = ? ORDER BY sequence, id`, [workflow.id])
      .map(mapStageRow)
      .map((stage) => ({
        ...stage,
        attempts: this.listAttemptsByStage(stage.id),
        deliverables: this.listDeliverablesByStage(stage.id),
      }));
    return { workflow, stages };
  }

  getStage(stageId: string): ZeusTaskStageRecord | null {
    const row = this.db.get<TaskStageRow>(`SELECT ${selectStageFields} FROM task_stages WHERE id = ?`, [stageId]);
    return row ? mapStageRow(row) : null;
  }

  getAttempt(attemptId: string): ZeusTaskStageAttemptRecord | null {
    const row = this.db.get<TaskStageAttemptRow>(`SELECT ${selectAttemptFields} FROM task_stage_attempts WHERE id = ?`, [attemptId]);
    return row ? mapAttemptRow(row) : null;
  }

  getAttemptByOperation(operationIdentity: string): ZeusTaskStageAttemptRecord | null {
    const row = this.db.get<TaskStageAttemptRow>(`SELECT ${selectAttemptFields} FROM task_stage_attempts WHERE operation_identity = ?`, [operationIdentity]);
    return row ? mapAttemptRow(row) : null;
  }

  getAttemptByConversation(conversationId: string): ZeusTaskStageAttemptRecord | null {
    const row = this.db.get<TaskStageAttemptRow>(`SELECT ${selectAttemptFields} FROM task_stage_attempts WHERE conversation_id = ?`, [conversationId]);
    return row ? mapAttemptRow(row) : null;
  }

  getDeliverable(deliverableId: string): ZeusTaskStageDeliverableRecord | null {
    const row = this.db.get<TaskStageDeliverableRow>(`SELECT ${selectDeliverableFields} FROM task_stage_deliverables WHERE id = ?`, [deliverableId]);
    return row ? mapDeliverableRow(row) : null;
  }

  getDeliverableByOperation(operationIdentity: string): ZeusTaskStageDeliverableRecord | null {
    const row = this.db.get<TaskStageDeliverableRow>(`SELECT ${selectDeliverableFields} FROM task_stage_deliverables WHERE operation_identity = ?`, [operationIdentity]);
    return row ? mapDeliverableRow(row) : null;
  }

  initializeDefault(input: { taskId: string; templateKey?: string; templateRevision?: number; stages: CreateTaskStageInput[] }): ZeusTaskWorkflowSnapshot {
    const existing = this.getWorkflowByTask(input.taskId);
    if (existing) return existing;
    const stages = validateInitialStages(input.stages);
    const timestamp = this.now();
      const workflowId = `task_workflow_${randomId(16)}`;
      const stageIds = stages.map(() => `task_stage_${randomId(16)}`);
    this.db.transaction(() => {
      this.db.execute(
        `INSERT INTO task_workflows (id, task_id, template_key, template_revision, status, current_stage_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, 1, ?, ?)`,
        [workflowId, input.taskId, boundedString(input.templateKey ?? 'default-plan-implement-review', 'templateKey', 120), positiveInteger(input.templateRevision ?? 1, 'templateRevision'), stageIds[0] ?? null, timestamp, timestamp],
      );
      stages.forEach((stage, index) => {
        const normalized = normalizeCreateStage(stage);
        this.db.execute(
          `INSERT INTO task_stages
           (id, workflow_id, task_id, stage_key, sequence, kind, title, description, status, agent_kind, model_ref, effort, service_tier, work_mode, permission_mode, advance_mode, prompt, output_contract_json, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            stageIds[index],
            workflowId,
            input.taskId,
            normalized.stageKey,
            index + 1,
            normalized.kind,
            normalized.title,
            normalized.description,
            index === 0 ? 'ready' : 'pending',
            normalized.agentKind,
            normalized.modelRef,
            normalized.effort,
            normalized.serviceTier,
            normalized.workMode,
            normalized.permissionMode,
            normalized.advanceMode,
            normalized.prompt,
            JSON.stringify(normalized.outputContract),
            timestamp,
            timestamp,
          ],
        );
      });
    });
    return this.requireWorkflow(input.taskId);
  }

  updateStage(stageId: string, input: UpdateTaskStageInput): ZeusTaskWorkflowSnapshot {
    const stage = this.requireStage(stageId);
    if (stage.revision !== input.expectedRevision) throw revisionConflict(stage);
    if (stage.status !== 'pending' && stage.status !== 'ready') {
      throw storeError('ZEUS_TASK_STAGE_NOT_READY', '阶段开始后配置已冻结；请创建新的阶段尝试，而不是改写历史配置。', 409, { stageId, status: stage.status });
    }
    if (this.listAttemptsByStage(stage.id).length > 0) {
      throw storeError('ZEUS_TASK_STAGE_NOT_READY', '已有执行尝试的阶段不能再修改配置。', 409, { stageId });
    }
    const next = normalizeStageUpdate(stage, input);
    const timestamp = nextTimestamp(stage.updatedAt, this.now());
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE task_stages
            SET title = ?, description = ?, agent_kind = ?, model_ref = ?, effort = ?, service_tier = ?, work_mode = ?, permission_mode = ?, advance_mode = ?, prompt = ?, output_contract_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?`,
        [next.title, next.description, next.agentKind, next.modelRef, next.effort, next.serviceTier, next.workMode, next.permissionMode, next.advanceMode, next.prompt, next.outputContractJson, timestamp, stage.id, input.expectedRevision],
      );
      if (changesCount(this.db) !== 1) throw revisionConflict(this.requireStage(stage.id));
      this.bumpWorkflow(stage.workflowId, timestamp);
    });
    return this.requireWorkflow(stage.taskId);
  }

  assignEmployee(stageId: string, input: AssignTaskStageEmployeeInput): ZeusTaskWorkflowSnapshot {
    const stage = this.requireStage(stageId);
    if (stage.revision !== input.expectedRevision) throw revisionConflict(stage);
    if (stage.status !== 'pending' && stage.status !== 'ready' && stage.status !== 'changes_requested' && stage.status !== 'failed') {
      throw storeError('ZEUS_TASK_STAGE_NOT_READY', '活动阶段不允许切换数字员工；请等待本次尝试结束。', 409, { stageId, status: stage.status });
    }
    const activeAttempt = this.db.get<{ id: string }>(`SELECT id FROM task_stage_attempts WHERE stage_id = ? AND status IN ('starting', 'active')`, [stage.id]);
    if (activeAttempt) throw storeError('ZEUS_TASK_STAGE_ACTIVE_ATTEMPT_EXISTS', '当前阶段已有活动尝试，不能切换数字员工。', 409, { stageId, attemptId: activeAttempt.id });
    const normalized = normalizeStageUpdate(stage, {
      expectedRevision: input.expectedRevision,
      agentKind: input.agentKind,
      modelRef: input.modelRef,
      effort: input.effort,
      serviceTier: input.serviceTier,
      workMode: input.workMode,
      permissionMode: input.permissionMode,
      prompt: input.prompt,
    });
    const employeeMode = enumValue(input.employeeMode, ['inherit', 'explicit'] as const, 'employeeMode');
    const employeeId = boundedString(input.employeeId, 'employeeId', 256);
    const timestamp = nextTimestamp(stage.updatedAt, this.now());
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE task_stages
            SET employee_mode = ?, employee_id = ?, agent_kind = ?, model_ref = ?, effort = ?, service_tier = ?, work_mode = ?, permission_mode = ?, prompt = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?`,
        [employeeMode, employeeId, normalized.agentKind, normalized.modelRef, normalized.effort, normalized.serviceTier, normalized.workMode, normalized.permissionMode, normalized.prompt, timestamp, stage.id, input.expectedRevision],
      );
      if (changesCount(this.db) !== 1) throw revisionConflict(this.requireStage(stage.id));
      this.bumpWorkflow(stage.workflowId, timestamp);
    });
    return this.requireWorkflow(stage.taskId);
  }

  prepareAttempt(input: PrepareTaskStageAttemptInput): ZeusTaskStageAttemptRecord {
    const operationIdentity = boundedString(input.operationIdentity, 'operationIdentity', 256);
    const existing = this.getAttemptByOperation(operationIdentity);
    if (existing) {
      if (existing.stageId !== input.stageId) {
        throw storeError('ZEUS_TASK_STAGE_CONVERSATION_CONFLICT', '同一操作身份已经属于另一个任务阶段。', 409, { attemptId: existing.id, stageId: existing.stageId });
      }
      return existing;
    }
    const stage = this.requireStage(input.stageId);
    assertStageConfigReady(stage);
    if (stage.status !== 'ready' && stage.status !== 'changes_requested' && stage.status !== 'failed') {
      throw storeError('ZEUS_TASK_STAGE_NOT_READY', '当前阶段尚未就绪，或已有结果正在等待验收。', 409, { stageId: stage.id, status: stage.status });
    }
    const activeAttempt = this.db.get<{ id: string }>(`SELECT id FROM task_stage_attempts WHERE stage_id = ? AND status IN ('starting', 'active')`, [stage.id]);
    if (activeAttempt) throw storeError('ZEUS_TASK_STAGE_ACTIVE_ATTEMPT_EXISTS', '当前阶段已有启动中或运行中的执行尝试。', 409, { stageId: stage.id, attemptId: activeAttempt.id });
    this.assertUpstreamAccepted(stage);
    const timestamp = nextTimestamp(stage.updatedAt, this.now());
    const attemptNumber = (this.db.get<{ maximum: number }>(`SELECT COALESCE(MAX(attempt_number), 0) AS maximum FROM task_stage_attempts WHERE stage_id = ?`, [stage.id])?.maximum ?? 0) + 1;
      const attemptId = `task_stage_attempt_${randomId(16)}`;
    const inputDeliverableIds = this.acceptedInputDeliverables(stage).map((deliverable) => deliverable.id);
    const employeeId = nullableString(input.employeeId, 'employeeId', 256);
    if (stage.employeeMode === 'explicit' && employeeId !== stage.employeeId) {
      throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '阶段尝试的实际员工与阶段指派不一致。', 409, { stageId: stage.id });
    }
    const employeeRevision = input.employeeRevision === null || input.employeeRevision === undefined ? null : nonNegativeInteger(input.employeeRevision, 'employeeRevision');
    const employeeSnapshot = input.employeeSnapshot === null || input.employeeSnapshot === undefined ? null : plainRecord(input.employeeSnapshot, 'employeeSnapshot');
    const effectivePermissions = input.effectivePermissions === null || input.effectivePermissions === undefined ? null : plainRecord(input.effectivePermissions, 'effectivePermissions');
    this.db.transaction(() => {
      this.db.execute(
        `INSERT INTO task_stage_attempts
         (id, task_id, stage_id, attempt_number, operation_identity, conversation_id, submission_id, segment_id, workspace_id, environment_id,
          work_execution_id, employee_id, employee_revision, employee_snapshot_json, skill_id, effective_permissions_json,
          agent_kind, model_ref, effort, service_tier, work_mode, permission_mode, input_deliverable_ids_json, source_snapshot_json, status, error_json, started_at, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', NULL, ?, NULL, ?, ?)`,
        [
          attemptId,
          stage.taskId,
          stage.id,
          attemptNumber,
          operationIdentity,
          nullableString(input.workExecutionId, 'workExecutionId', 256),
          employeeId,
          employeeRevision,
          employeeSnapshot ? JSON.stringify(employeeSnapshot) : null,
          nullableString(input.skillId, 'skillId', 256),
          effectivePermissions ? JSON.stringify(effectivePermissions) : null,
          stage.agentKind,
          stage.modelRef,
          stage.effort,
          stage.serviceTier,
          stage.workMode,
          stage.permissionMode,
          JSON.stringify(inputDeliverableIds),
          JSON.stringify(input.sourceSnapshot ?? {}),
          timestamp,
          timestamp,
          timestamp,
        ],
      );
      this.db.execute(`UPDATE task_stages SET status = 'running', revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, stage.id]);
      this.db.execute(`UPDATE task_workflows SET status = 'active', current_stage_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?`, [stage.id, timestamp, stage.workflowId]);
    });
    return this.requireAttempt(attemptId);
  }

  bindAttempt(input: BindTaskStageAttemptInput): ZeusTaskStageAttemptRecord {
    const attempt = this.requireAttempt(input.attemptId);
    if (attempt.conversationId) {
      if (attempt.conversationId !== input.conversationId || attempt.submissionId !== input.submissionId) {
        throw storeError('ZEUS_TASK_STAGE_CONVERSATION_CONFLICT', '阶段尝试已经绑定到另一条会话。', 409, { attemptId: attempt.id, conversationId: attempt.conversationId });
      }
      return attempt;
    }
    assertFrozenExecutionMatches(attempt, input);
    const timestamp = nextTimestamp(attempt.updatedAt, this.now());
    this.db.execute(
      `UPDATE task_stage_attempts
          SET conversation_id = ?, submission_id = ?, segment_id = ?, workspace_id = ?, environment_id = ?, status = 'active', updated_at = ?
        WHERE id = ? AND conversation_id IS NULL`,
      [input.conversationId, input.submissionId, input.segmentId ?? null, input.workspaceId ?? null, input.environmentId ?? null, timestamp, attempt.id],
    );
    if (changesCount(this.db) !== 1) return this.requireAttempt(attempt.id);
    return this.requireAttempt(attempt.id);
  }

  bindExistingConversationAttempt(input: BindExistingTaskStageAttemptInput): ZeusTaskStageAttemptRecord {
    const attempt = this.requireAttempt(input.attemptId);
    if (attempt.conversationId) {
      if (attempt.conversationId !== input.conversationId) throw storeError('ZEUS_TASK_STAGE_CONVERSATION_CONFLICT', '阶段尝试已经绑定到另一条会话。', 409, { attemptId: attempt.id });
      return attempt;
    }
    const timestamp = nextTimestamp(attempt.updatedAt, this.now());
    this.db.execute(
      `UPDATE task_stage_attempts
          SET conversation_id = ?, workspace_id = ?, environment_id = ?, status = 'active', updated_at = ?
        WHERE id = ? AND conversation_id IS NULL`,
      [boundedString(input.conversationId, 'conversationId', 256), nullableString(input.workspaceId, 'workspaceId', 256), nullableString(input.environmentId, 'environmentId', 256), timestamp, attempt.id],
    );
    if (changesCount(this.db) !== 1) return this.requireAttempt(attempt.id);
    return this.requireAttempt(attempt.id);
  }

  failAttempt(attemptId: string, input: { outcomeUnknown: boolean; error: Record<string, unknown> }): ZeusTaskStageAttemptRecord {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.status === 'completed' || attempt.status === 'cancelled') return attempt;
    const stage = this.requireStage(attempt.stageId);
    const timestamp = nextTimestamp(attempt.updatedAt, this.now());
    const status: TaskStageAttemptStatus = input.outcomeUnknown ? 'outcome_unknown' : 'failed';
    this.db.transaction(() => {
      this.db.execute(`UPDATE task_stage_attempts SET status = ?, error_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [status, JSON.stringify(input.error), timestamp, timestamp, attempt.id]);
      this.db.execute(`UPDATE task_stages SET status = 'failed', revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, stage.id]);
      this.bumpWorkflow(stage.workflowId, timestamp);
    });
    return this.requireAttempt(attempt.id);
  }

  createDeliverable(input: CreateTaskStageDeliverableInput): ZeusTaskWorkflowSnapshot {
    const existing = this.getDeliverableByOperation(input.operationIdentity);
    if (existing) {
      if (existing.taskId !== input.taskId || existing.stageId !== input.stageId || existing.attemptId !== input.attemptId || existing.artifactSha256 !== input.artifactRef.sha256) {
        throw storeError('ZEUS_TASK_STAGE_DELIVERABLE_CONFLICT', '同一操作身份已经提交了不同的阶段交付物。', 409, { deliverableId: existing.id });
      }
      return this.requireWorkflow(existing.taskId);
    }
    const stage = this.requireStage(input.stageId);
    const attempt = this.requireAttempt(input.attemptId);
    if (stage.taskId !== input.taskId || attempt.taskId !== input.taskId || attempt.stageId !== stage.id) {
      throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '交付物的任务、阶段与执行尝试不一致。', 400);
    }
    if (!attempt.conversationId || (attempt.status !== 'active' && attempt.status !== 'starting')) {
      throw storeError('ZEUS_TASK_STAGE_NOT_READY', '只有已绑定真实会话的活动阶段尝试才能提交交付物。', 409, { attemptId: attempt.id, status: attempt.status });
    }
    if (input.artifactRef.owner.kind !== 'task_stage_deliverable' || input.artifactRef.owner.id === '') {
      throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '阶段交付物必须由专属资产 owner 持有。', 400);
    }
    const timestamp = nextTimestamp(attempt.updatedAt, this.now());
    const version = (this.db.get<{ maximum: number }>(`SELECT COALESCE(MAX(version), 0) AS maximum FROM task_stage_deliverables WHERE stage_id = ?`, [stage.id])?.maximum ?? 0) + 1;
    const deliverableId = input.artifactRef.owner.id;
    const accepted = stage.advanceMode === 'auto';
    this.db.transaction(() => {
      if (accepted) {
        this.db.execute(`UPDATE task_stage_deliverables SET status = 'superseded', updated_at = ? WHERE stage_id = ? AND status = 'accepted'`, [timestamp, stage.id]);
      }
      this.db.execute(
        `INSERT INTO task_stage_deliverables
         (id, task_id, stage_id, attempt_id, version, kind, title, summary, mime_type, artifact_sha256, artifact_ref_json, content_sha256, content_byte_length, operation_identity, status, decision_reason, accepted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          deliverableId,
          input.taskId,
          stage.id,
          attempt.id,
          version,
          boundedString(input.kind, 'deliverable.kind', 80),
          boundedString(input.title, 'deliverable.title', 240),
          boundedString(input.summary, 'deliverable.summary', 4_000, true),
          input.artifactRef.mimeType,
          input.artifactRef.sha256,
          JSON.stringify(input.artifactRef),
          input.artifactRef.contentSha256,
          input.artifactRef.contentByteLength,
          boundedString(input.operationIdentity, 'operationIdentity', 256),
          accepted ? 'accepted' : 'submitted',
          accepted ? timestamp : null,
          timestamp,
          timestamp,
        ],
      );
      this.db.execute(`UPDATE task_stage_attempts SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`, [timestamp, timestamp, attempt.id]);
      this.db.execute(`UPDATE task_stages SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?`, [accepted ? 'accepted' : 'awaiting_acceptance', timestamp, stage.id]);
      if (accepted) this.advanceAfterAcceptedStage(stage, timestamp);
      else this.bumpWorkflow(stage.workflowId, timestamp);
    });
    return this.requireWorkflow(input.taskId);
  }

  acceptDeliverable(deliverableId: string, expectedStageRevision: number): ZeusTaskWorkflowSnapshot {
    const deliverable = this.requireDeliverable(deliverableId);
    const stage = this.requireStage(deliverable.stageId);
    if (deliverable.status === 'accepted') return this.requireWorkflow(deliverable.taskId);
    if (stage.revision !== expectedStageRevision) throw revisionConflict(stage);
    if (deliverable.status !== 'submitted' || stage.status !== 'awaiting_acceptance') {
      throw storeError('ZEUS_TASK_STAGE_DELIVERABLE_CONFLICT', '只有当前待验收版本可以被接受。', 409, { deliverableId, status: deliverable.status, stageStatus: stage.status });
    }
    const timestamp = nextTimestamp(stage.updatedAt, this.now());
    this.db.transaction(() => {
      this.db.execute(`UPDATE task_stage_deliverables SET status = 'superseded', updated_at = ? WHERE stage_id = ? AND status = 'accepted'`, [timestamp, stage.id]);
      this.db.execute(`UPDATE task_stage_deliverables SET status = 'accepted', decision_reason = NULL, accepted_at = ?, updated_at = ? WHERE id = ? AND status = 'submitted'`, [timestamp, timestamp, deliverable.id]);
      this.db.execute(`UPDATE task_stages SET status = 'accepted', revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, stage.id]);
      this.advanceAfterAcceptedStage(stage, timestamp);
    });
    return this.requireWorkflow(deliverable.taskId);
  }

  requestChanges(deliverableId: string, input: { expectedStageRevision: number; reason: string; stayOnStage?: boolean }): ZeusTaskWorkflowSnapshot {
    const deliverable = this.requireDeliverable(deliverableId);
    const stage = this.requireStage(deliverable.stageId);
    const reason = boundedString(input.reason, 'reason', 4_000);
    if (deliverable.status === 'changes_requested' && deliverable.decisionReason === reason) return this.requireWorkflow(deliverable.taskId);
    if (stage.revision !== input.expectedStageRevision) throw revisionConflict(stage);
    if (deliverable.status !== 'submitted' && deliverable.status !== 'accepted') {
      throw storeError('ZEUS_TASK_STAGE_DELIVERABLE_CONFLICT', '只有待验收或已接受的当前交付物可以要求修改。', 409, { deliverableId, status: deliverable.status });
    }
    this.assertNoStartedDownstream(stage);
    const timestamp = nextTimestamp(stage.updatedAt, this.now());
    this.db.transaction(() => {
      this.db.execute(`UPDATE task_stage_deliverables SET status = 'changes_requested', decision_reason = ?, accepted_at = NULL, updated_at = ? WHERE id = ?`, [reason, timestamp, deliverable.id]);
      if (stage.kind === 'code_review' && input.stayOnStage !== true) {
        const implementation = this.previousImplementationStage(stage);
        if (!implementation) throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '代码审查阶段缺少可返工的实施阶段。', 409, { stageId: stage.id });
        this.db.execute(`UPDATE task_stages SET status = 'changes_requested', revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, implementation.id]);
        this.db.execute(`UPDATE task_stages SET status = 'pending', revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, stage.id]);
        this.db.execute(`UPDATE task_workflows SET status = 'active', current_stage_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?`, [implementation.id, timestamp, stage.workflowId]);
      } else {
        this.db.execute(`UPDATE task_stages SET status = 'changes_requested', revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, stage.id]);
        this.db.execute(`UPDATE task_workflows SET status = 'active', current_stage_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?`, [stage.id, timestamp, stage.workflowId]);
      }
    });
    return this.requireWorkflow(deliverable.taskId);
  }

  skipStage(stageId: string, expectedRevision: number, reason: string): ZeusTaskWorkflowSnapshot {
    const stage = this.requireStage(stageId);
    if (stage.status === 'skipped') return this.requireWorkflow(stage.taskId);
    if (stage.revision !== expectedRevision) throw revisionConflict(stage);
    if (stage.status !== 'ready') throw storeError('ZEUS_TASK_STAGE_NOT_READY', '只有当前已就绪且尚未开始的阶段可以跳过。', 409, { stageId, status: stage.status });
    this.assertUpstreamAccepted(stage);
    boundedString(reason, 'reason', 4_000);
    const timestamp = nextTimestamp(stage.updatedAt, this.now());
    this.db.transaction(() => {
      this.db.execute(`UPDATE task_stages SET status = 'skipped', revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, stage.id]);
      this.advanceAfterAcceptedStage(stage, timestamp);
    });
    return this.requireWorkflow(stage.taskId);
  }

  acceptedInputDeliverables(stage: ZeusTaskStageRecord): ZeusTaskStageDeliverableRecord[] {
    return this.db
      .select<TaskStageDeliverableRow>(
        `SELECT ${selectJoinedDeliverableFields}
           FROM task_stage_deliverables AS deliverable
           JOIN task_stages AS source_stage ON source_stage.id = deliverable.stage_id
          WHERE source_stage.workflow_id = ?
            AND source_stage.sequence < ?
            AND deliverable.status = 'accepted'
          ORDER BY source_stage.sequence, deliverable.version`,
        [stage.workflowId, stage.sequence],
      )
      .map(mapDeliverableRow);
  }

  latestAttempt(stageId: string): ZeusTaskStageAttemptRecord | null {
    const row = this.db.get<TaskStageAttemptRow>(`SELECT ${selectAttemptFields} FROM task_stage_attempts WHERE stage_id = ? ORDER BY attempt_number DESC LIMIT 1`, [stageId]);
    return row ? mapAttemptRow(row) : null;
  }

  private listAttemptsByStage(stageId: string): ZeusTaskStageAttemptRecord[] {
    return this.db.select<TaskStageAttemptRow>(`SELECT ${selectAttemptFields} FROM task_stage_attempts WHERE stage_id = ? ORDER BY attempt_number, id`, [stageId]).map(mapAttemptRow);
  }

  private listDeliverablesByStage(stageId: string): ZeusTaskStageDeliverableRecord[] {
    return this.db.select<TaskStageDeliverableRow>(`SELECT ${selectDeliverableFields} FROM task_stage_deliverables WHERE stage_id = ? ORDER BY version, id`, [stageId]).map(mapDeliverableRow);
  }

  private requireWorkflow(taskId: string): ZeusTaskWorkflowSnapshot {
    const workflow = this.getWorkflowByTask(taskId);
    if (!workflow) throw storeError('ZEUS_TASK_WORKFLOW_NOT_FOUND', '任务尚未启用阶段工作流。', 404, { taskId });
    return workflow;
  }

  private requireStage(stageId: string): ZeusTaskStageRecord {
    const stage = this.getStage(stageId);
    if (!stage) throw storeError('ZEUS_TASK_STAGE_NOT_FOUND', '任务阶段不存在。', 404, { stageId });
    return stage;
  }

  private requireAttempt(attemptId: string): ZeusTaskStageAttemptRecord {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw storeError('ZEUS_TASK_STAGE_ATTEMPT_NOT_FOUND', '阶段执行尝试不存在。', 404, { attemptId });
    return attempt;
  }

  private requireDeliverable(deliverableId: string): ZeusTaskStageDeliverableRecord {
    const deliverable = this.getDeliverable(deliverableId);
    if (!deliverable) throw storeError('ZEUS_TASK_STAGE_DELIVERABLE_NOT_FOUND', '阶段交付物不存在。', 404, { deliverableId });
    return deliverable;
  }

  private assertUpstreamAccepted(stage: ZeusTaskStageRecord): void {
    const incomplete = this.db.get<{ id: string; status: TaskStageStatus }>(`SELECT id, status FROM task_stages WHERE workflow_id = ? AND sequence < ? AND status NOT IN ('accepted', 'skipped') ORDER BY sequence LIMIT 1`, [
      stage.workflowId,
      stage.sequence,
    ]);
    if (incomplete) throw storeError('ZEUS_TASK_STAGE_NOT_READY', '上游阶段尚未验收，不能启动当前阶段。', 409, { stageId: stage.id, upstreamStageId: incomplete.id, upstreamStatus: incomplete.status });
  }

  private assertNoStartedDownstream(stage: ZeusTaskStageRecord): void {
    const downstream = this.db.get<{ id: string; status: TaskStageStatus }>(`SELECT id, status FROM task_stages WHERE workflow_id = ? AND sequence > ? AND status NOT IN ('pending', 'ready', 'skipped') ORDER BY sequence LIMIT 1`, [
      stage.workflowId,
      stage.sequence,
    ]);
    if (downstream) throw storeError('ZEUS_TASK_STAGE_DOWNSTREAM_STARTED', '下游阶段已经开始，不能静默改写上游验收结论。请先显式取消或返工下游。', 409, { stageId: stage.id, downstreamStageId: downstream.id });
  }

  private previousImplementationStage(stage: ZeusTaskStageRecord): ZeusTaskStageRecord | null {
    const row = this.db.get<TaskStageRow>(`SELECT ${selectStageFields} FROM task_stages WHERE workflow_id = ? AND sequence < ? AND kind = 'implementation' ORDER BY sequence DESC LIMIT 1`, [stage.workflowId, stage.sequence]);
    return row ? mapStageRow(row) : null;
  }

  private advanceAfterAcceptedStage(stage: ZeusTaskStageRecord, timestamp: string): void {
    const nextRow = this.db.get<TaskStageRow>(`SELECT ${selectStageFields} FROM task_stages WHERE workflow_id = ? AND sequence > ? AND status <> 'skipped' ORDER BY sequence LIMIT 1`, [stage.workflowId, stage.sequence]);
    if (!nextRow) {
      this.db.execute(`UPDATE task_workflows SET status = 'completed', current_stage_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, stage.workflowId]);
      return;
    }
    const next = mapStageRow(nextRow);
    if (next.status === 'pending') this.db.execute(`UPDATE task_stages SET status = 'ready', revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, next.id]);
    this.db.execute(`UPDATE task_workflows SET status = 'active', current_stage_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?`, [next.id, timestamp, stage.workflowId]);
  }

  private bumpWorkflow(workflowId: string, timestamp: string): void {
    this.db.execute(`UPDATE task_workflows SET revision = revision + 1, updated_at = ? WHERE id = ?`, [timestamp, workflowId]);
  }
}

function validateInitialStages(stages: CreateTaskStageInput[]): CreateTaskStageInput[] {
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > 12) throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '任务工作流必须包含 1 到 12 个阶段。', 400);
  const keys = new Set<string>();
  for (const stage of stages) {
    const key = boundedString(stage.stageKey, 'stageKey', 80);
    if (keys.has(key)) throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `任务阶段 key 重复：${key}`, 400);
    keys.add(key);
  }
  return stages;
}

function normalizeCreateStage(stage: CreateTaskStageInput): CreateTaskStageInput & { effort: string | null; serviceTier: string | null } {
  const kind = enumValue(stage.kind, ['plan', 'implementation', 'code_review', 'custom'] as const, 'kind');
  const normalized = {
    stageKey: boundedString(stage.stageKey, 'stageKey', 80),
    kind,
    title: boundedString(stage.title, 'title', 160),
    description: boundedString(stage.description, 'description', 2_000, true),
    agentKind: enumValue(stage.agentKind, ['codex', 'pi'] as const, 'agentKind'),
    modelRef: boundedString(stage.modelRef, 'modelRef', 300, true),
    effort: nullableString(stage.effort, 'effort', 80),
    serviceTier: nullableString(stage.serviceTier, 'serviceTier', 120),
    workMode: enumValue(stage.workMode, ['default', 'plan'] as const, 'workMode'),
    permissionMode: enumValue(stage.permissionMode, ['read-only', 'auto', 'full-access'] as const, 'permissionMode'),
    advanceMode: enumValue(stage.advanceMode, ['manual', 'auto'] as const, 'advanceMode'),
    prompt: boundedString(stage.prompt, 'prompt', 20_000, true),
    outputContract: plainRecord(stage.outputContract, 'outputContract'),
  };
  assertKindExecutionPolicy(normalized);
  return normalized;
}

function normalizeStageUpdate(stage: ZeusTaskStageRecord, input: UpdateTaskStageInput): Omit<ZeusTaskStageRecord, 'revision' | 'createdAt' | 'updatedAt'> & { outputContractJson: string } {
  const next = {
    ...stage,
    title: input.title === undefined ? stage.title : boundedString(input.title, 'title', 160),
    description: input.description === undefined ? stage.description : boundedString(input.description, 'description', 2_000, true),
    agentKind: input.agentKind === undefined ? stage.agentKind : enumValue(input.agentKind, ['codex', 'pi'] as const, 'agentKind'),
    modelRef: input.modelRef === undefined ? stage.modelRef : boundedString(input.modelRef, 'modelRef', 300, true),
    effort: input.effort === undefined ? stage.effort : nullableString(input.effort, 'effort', 80),
    serviceTier: input.serviceTier === undefined ? stage.serviceTier : nullableString(input.serviceTier, 'serviceTier', 120),
    workMode: input.workMode === undefined ? stage.workMode : enumValue(input.workMode, ['default', 'plan'] as const, 'workMode'),
    permissionMode: input.permissionMode === undefined ? stage.permissionMode : enumValue(input.permissionMode, ['read-only', 'auto', 'full-access'] as const, 'permissionMode'),
    advanceMode: input.advanceMode === undefined ? stage.advanceMode : enumValue(input.advanceMode, ['manual', 'auto'] as const, 'advanceMode'),
    prompt: input.prompt === undefined ? stage.prompt : boundedString(input.prompt, 'prompt', 20_000, true),
    outputContractJson: input.outputContract === undefined ? stage.outputContractJson : JSON.stringify(plainRecord(input.outputContract, 'outputContract')),
  };
  assertKindExecutionPolicy(next);
  return next;
}

function assertKindExecutionPolicy(stage: Pick<ZeusTaskStageRecord, 'kind' | 'workMode' | 'permissionMode'>): void {
  if (stage.kind === 'plan' && stage.permissionMode !== 'read-only') {
    throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '计划阶段固定为只读权限；工作态由具体编排决定。', 400);
  }
  if (stage.kind === 'code_review' && (stage.workMode !== 'default' || stage.permissionMode !== 'read-only')) {
    throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '代码审查阶段固定为默认工作态和只读权限。', 400);
  }
}

function assertStageConfigReady(stage: ZeusTaskStageRecord): void {
  if (!stage.modelRef.trim()) throw storeError('ZEUS_TASK_STAGE_NOT_CONFIGURED', '请先为当前阶段选择可用模型。', 409, { stageId: stage.id });
  assertKindExecutionPolicy(stage);
}

function assertFrozenExecutionMatches(attempt: ZeusTaskStageAttemptRecord, input: BindTaskStageAttemptInput): void {
  const matches =
    attempt.agentKind === input.agentKind &&
    attempt.modelRef === input.modelRef &&
    attempt.effort === (input.effort ?? null) &&
    attempt.serviceTier === (input.serviceTier ?? null) &&
    attempt.workMode === input.workMode &&
    attempt.permissionMode === input.permissionMode;
  if (!matches) throw storeError('ZEUS_TASK_STAGE_CONVERSATION_CONFLICT', '真实会话配置与阶段尝试的冻结配置不一致。', 409, { attemptId: attempt.id });
}

function revisionConflict(stage: ZeusTaskStageRecord): TaskStageStoreError {
  return storeError('ZEUS_TASK_STAGE_REVISION_CONFLICT', '任务阶段已在其他位置更新，请载入最新状态后重试。', 409, { stageId: stage.id, currentRevision: stage.revision });
}

function storeError(code: TaskStageStoreErrorCode, message: string, statusCode: number, details: Readonly<Record<string, string | number | boolean | null>> = {}): TaskStageStoreError {
  return new TaskStageStoreError(code, message, statusCode, details);
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 必须是字符串。`, 400);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 不能为空。`, 400);
  if (normalized.length > maximum) throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 不能超过 ${maximum} 个字符。`, 400);
  return normalized;
}

function nullableString(value: unknown, label: string, maximum: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return boundedString(value, label, maximum);
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 不是受支持的值。`, 400);
  return value as T[number];
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 必须是对象。`, 400);
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 必须是正整数。`, 400);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw storeError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 必须是非负整数。`, 400);
  return Number(value);
}

function changesCount(db: ZeusDatabasePort): number {
  return db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0;
}

function nextTimestamp(previous: string, candidate: string): string {
  if (candidate > previous) return candidate;
  return new Date(Date.parse(previous) + 1).toISOString();
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function mapWorkflowRow(row: TaskWorkflowRow): ZeusTaskWorkflowRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    templateKey: row.template_key,
    templateRevision: row.template_revision,
    status: row.status,
    currentStageId: row.current_stage_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStageRow(row: TaskStageRow): ZeusTaskStageRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    stageKey: row.stage_key,
    sequence: row.sequence,
    kind: row.kind,
    title: row.title,
    description: row.description,
    status: row.status,
    employeeMode: enumValue(row.employee_mode, ['none', 'inherit', 'explicit'] as const, 'employeeMode'),
    employeeId: row.employee_id,
    agentKind: row.agent_kind,
    modelRef: row.model_ref,
    effort: row.effort,
    serviceTier: row.service_tier,
    workMode: row.work_mode,
    permissionMode: row.permission_mode,
    advanceMode: row.advance_mode,
    prompt: row.prompt,
    outputContractJson: row.output_contract_json,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttemptRow(row: TaskStageAttemptRow): ZeusTaskStageAttemptRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    stageId: row.stage_id,
    attemptNumber: row.attempt_number,
    operationIdentity: row.operation_identity,
    conversationId: row.conversation_id,
    submissionId: row.submission_id,
    segmentId: row.segment_id,
    workspaceId: row.workspace_id,
    environmentId: row.environment_id,
    workExecutionId: row.work_execution_id,
    employeeId: row.employee_id,
    employeeRevision: row.employee_revision,
    employeeSnapshot: row.employee_snapshot_json ? plainRecord(JSON.parse(row.employee_snapshot_json), 'employeeSnapshot') : null,
    skillId: row.skill_id,
    effectivePermissions: row.effective_permissions_json ? plainRecord(JSON.parse(row.effective_permissions_json), 'effectivePermissions') : null,
    agentKind: row.agent_kind,
    modelRef: row.model_ref,
    effort: row.effort,
    serviceTier: row.service_tier,
    workMode: row.work_mode,
    permissionMode: row.permission_mode,
    inputDeliverableIds: parseStringArray(row.input_deliverable_ids_json),
    sourceSnapshotJson: row.source_snapshot_json,
    status: row.status,
    errorJson: row.error_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeliverableRow(row: TaskStageDeliverableRow): ZeusTaskStageDeliverableRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    stageId: row.stage_id,
    attemptId: row.attempt_id,
    version: row.version,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    mimeType: row.mime_type,
    artifactSha256: row.artifact_sha256,
    artifactRefJson: row.artifact_ref_json,
    contentSha256: row.content_sha256,
    contentByteLength: row.content_byte_length,
    operationIdentity: row.operation_identity,
    status: row.status,
    decisionReason: row.decision_reason,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
