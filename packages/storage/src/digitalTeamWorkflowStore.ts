import { createHash } from 'node:crypto';
import {
  assertDigitalTeamWorkflowReady,
  canonicalCommandInputJson,
  type CreateDigitalTeamNodeAttemptInput,
  type CreateDigitalTeamWorkflowRunInput,
  type CreateDigitalTeamWorkflowTemplateInput,
  digitalTeamNodeAttemptStatuses,
  digitalTeamRunControlStates,
  digitalTeamRunStatuses,
  validateDigitalTeamStructuredPlan,
  validateDigitalTeamWorkflowDefinition,
  type DigitalTeamApprovalDecision,
  type DigitalTeamBaseRevision,
  type DigitalTeamCandidateRevision,
  type DigitalTeamEmployeeNode,
  type DigitalTeamNode,
  type DigitalTeamNodeAttemptRecord,
  type DigitalTeamNodeAttemptStatus,
  type DigitalTeamNodeType,
  type DigitalTeamRunStatus,
  type DigitalTeamStructuredPlan,
  type DigitalTeamStructuredResult,
  type DigitalTeamWorkflowDefinition,
  type DigitalTeamWorkflowRunRecord,
  type DigitalTeamWorkflowTemplateRecord,
  type DigitalTeamWorkflowValidationIssue,
  type DigitalTeamRoleSnapshot,
  type UpdateDigitalTeamNodeAttemptInput,
  type UpdateDigitalTeamWorkflowRunInput,
  type UpdateDigitalTeamWorkflowTemplateInput,
} from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';
import { DigitalEmployeeRepository } from './digitalEmployeeStore.js';
import { randomId } from './randomId.js';

/** 兼容 storage 聚合入口，同时保证公开契约只在 shared 定义一次。 */
export type {
  CreateDigitalTeamNodeAttemptInput,
  CreateDigitalTeamWorkflowRunInput,
  CreateDigitalTeamWorkflowTemplateInput,
  DigitalTeamApprovalDecision,
  DigitalTeamBaseRevision,
  DigitalTeamCandidateRevision,
  DigitalTeamNodeAttemptRecord,
  DigitalTeamRoleSnapshot,
  DigitalTeamWorkflowRunRecord,
  DigitalTeamWorkflowTemplateRecord,
  UpdateDigitalTeamNodeAttemptInput,
  UpdateDigitalTeamWorkflowRunInput,
  UpdateDigitalTeamWorkflowTemplateInput,
} from '@zeus/shared';

/** 数字团队流程存储迁移身份。 */
export const digitalTeamWorkflowSchemaMigrationId = '20260915_0630_digital_team_workflow';

/** 数字团队存储边界错误。 */
export class DigitalTeamWorkflowStoreError extends Error {
  /** 错误名称。 */
  readonly name = 'DigitalTeamWorkflowStoreError';

  /** 保存稳定错误代码和 HTTP 建议状态。 */
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: 400 | 404 | 409 | 500 = 400,
  ) {
    super(message);
  }
}

/** 创建数字团队模板、运行和节点尝试表，不接管旧阶段或团队配方。 */
export function migrateDigitalTeamWorkflowSchema(db: ZeusDatabasePort): void {
  const checksumSource = 'digital-team-workflow:templates,runs,node-attempts:frozen-graph,roles,facts,base-revisions,turn-bound-evidence,approval,candidate-validation,invalidation';
  const checksum = createHash('sha256').update(checksumSource).digest('hex');
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE migration_id = ?', [digitalTeamWorkflowSchemaMigrationId]);
    if (existing && existing.checksum !== checksum) throw storeError('ZEUS_DIGITAL_TEAM_SCHEMA_CONFLICT', '数字团队流程迁移账本与当前结构不一致。', 500);
    db.execute(`
      CREATE TABLE IF NOT EXISTS digital_team_workflow_templates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
        ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
        validation_issues_json TEXT NOT NULL CHECK (json_valid(validation_issues_json)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )
    `);
    db.execute('CREATE INDEX IF NOT EXISTS idx_digital_team_templates_project ON digital_team_workflow_templates(project_id, deleted_at, updated_at DESC)');
    db.execute(`
      CREATE TABLE IF NOT EXISTS digital_team_workflow_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        template_id TEXT REFERENCES digital_team_workflow_templates(id),
        template_revision INTEGER,
        definition_snapshot_json TEXT NOT NULL CHECK (json_valid(definition_snapshot_json)),
        role_snapshots_json TEXT NOT NULL CHECK (json_valid(role_snapshots_json)),
        task_facts_json TEXT NOT NULL CHECK (json_valid(task_facts_json)),
        base_revisions_json TEXT NOT NULL CHECK (json_valid(base_revisions_json)),
        main_conversation_id TEXT REFERENCES conversations(id),
        status TEXT NOT NULL CHECK (status IN ('planning','awaiting_plan_approval','executing','integrating','verifying','summarizing','awaiting_final_approval','completed','failed','outcome_unknown','cancelled')),
        control_state TEXT NOT NULL CHECK (control_state IN ('running','paused','cancelled')),
        plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
        plan_version INTEGER NOT NULL DEFAULT 0 CHECK (plan_version >= 0),
        plan_sha256 TEXT,
        approved_plan_sha256 TEXT,
        plan_approved_by TEXT,
        plan_approved_at TEXT,
        candidate_revisions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_revisions_json)),
        candidate_set_sha256 TEXT,
        final_approved_candidate_set_sha256 TEXT,
        final_approved_by TEXT,
        final_approved_at TEXT,
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
    db.execute('CREATE INDEX IF NOT EXISTS idx_digital_team_runs_task ON digital_team_workflow_runs(task_id, created_at DESC, id)');
    db.execute("CREATE INDEX IF NOT EXISTS idx_digital_team_runs_recoverable ON digital_team_workflow_runs(control_state, status, updated_at) WHERE status NOT IN ('completed','failed','cancelled')");
    db.execute(`
      CREATE TABLE IF NOT EXISTS digital_team_node_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES digital_team_workflow_runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL CHECK (node_type IN ('start','employee','human_confirmation','code_integration','end')),
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        status TEXT NOT NULL CHECK (status IN ('prepared','dispatching','active','awaiting_approval','succeeded','changes_requested','invalidated','failed','outcome_unknown','cancelled')),
        input_sha256 TEXT NOT NULL,
        plan_version INTEGER,
        work_item_id TEXT REFERENCES task_work_items(id),
        work_run_id TEXT REFERENCES task_work_runs(id),
        conversation_id TEXT REFERENCES conversations(id),
        submission_id TEXT REFERENCES conversation_submissions(id),
        turn_id TEXT REFERENCES conversation_turns(id),
        segment_id TEXT,
        environment_id TEXT REFERENCES task_environments(id),
        workspace_id TEXT REFERENCES task_workspaces(id),
        command_id TEXT,
        external_operation_id TEXT,
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        deliverable_id TEXT REFERENCES task_work_deliverables(id),
        deliverable_version INTEGER,
        artifact_ref_json TEXT CHECK (artifact_ref_json IS NULL OR json_valid(artifact_ref_json)),
        verified_candidate_set_sha256 TEXT,
        approval_json TEXT CHECK (approval_json IS NULL OR json_valid(approval_json)),
        invalidated_by_attempt_id TEXT REFERENCES digital_team_node_attempts(id),
        invalidation_reason TEXT,
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (run_id, node_id, attempt)
      )
    `);
    db.execute('CREATE INDEX IF NOT EXISTS idx_digital_team_attempts_run ON digital_team_node_attempts(run_id, node_id, attempt DESC)');
    db.execute("CREATE INDEX IF NOT EXISTS idx_digital_team_attempts_recoverable ON digital_team_node_attempts(status, updated_at) WHERE status IN ('prepared','dispatching','active','awaiting_approval','outcome_unknown')");
    db.execute('INSERT OR IGNORE INTO schema_migrations(migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      digitalTeamWorkflowSchemaMigrationId,
      '新增数字团队画布模板、冻结运行和逐节点尝试',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

/** 管理项目内数字团队画布模板。 */
export class DigitalTeamWorkflowTemplateRepository {
  /** 保存数据库和可替换时钟。 */
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** 按项目读取未删除模板。 */
  listByProject(projectId: string): DigitalTeamWorkflowTemplateRecord[] {
    return this.db.select<DigitalTeamWorkflowTemplateRow>('SELECT * FROM digital_team_workflow_templates WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id', [identity(projectId, 'projectId')]).map(mapTemplate);
  }

  /** 按身份读取未删除模板。 */
  getById(id: string): DigitalTeamWorkflowTemplateRecord | undefined {
    const row = this.db.get<DigitalTeamWorkflowTemplateRow>('SELECT * FROM digital_team_workflow_templates WHERE id = ? AND deleted_at IS NULL', [identity(id, 'templateId')]);
    return row ? mapTemplate(row) : undefined;
  }

  /** 保存新画布；校验问题随草稿一起保存，不阻断继续编辑。 */
  create(input: CreateDigitalTeamWorkflowTemplateInput): DigitalTeamWorkflowTemplateRecord {
    requireProject(this.db, input.projectId);
    const id = input.id ? identity(input.id, 'template.id') : `digital_team_template_${randomId(12)}`;
    const timestamp = this.now();
    const issues = validateDigitalTeamWorkflowDefinition(input.definition);
    this.db.execute(
      'INSERT INTO digital_team_workflow_templates(id, project_id, name, description, definition_json, ready, validation_issues_json, revision, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)',
      [
        id,
        identity(input.projectId, 'projectId'),
        boundedText(input.name, 'name', 160),
        boundedText(input.description, 'description', 2_000, true),
        boundedJson(input.definition, 'definition'),
        issues.length === 0 ? 1 : 0,
        boundedJson(issues, 'validationIssues'),
        timestamp,
        timestamp,
      ],
    );
    return this.getById(id)!;
  }

  /** 使用乐观并发修改模板草稿。 */
  update(id: string, input: UpdateDigitalTeamWorkflowTemplateInput): DigitalTeamWorkflowTemplateRecord {
    const current = this.require(id);
    assertRevision(current.revision, input.expectedRevision, '流程模板');
    const definition = input.definition ?? current.definition;
    const issues = validateDigitalTeamWorkflowDefinition(definition);
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    this.db.execute(
      'UPDATE digital_team_workflow_templates SET name = ?, description = ?, definition_json = ?, ready = ?, validation_issues_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL',
      [
        boundedText(input.name ?? current.name, 'name', 160),
        boundedText(input.description ?? current.description, 'description', 2_000, true),
        boundedJson(definition, 'definition'),
        issues.length === 0 ? 1 : 0,
        boundedJson(issues, 'validationIssues'),
        timestamp,
        current.id,
        current.revision,
      ],
    );
    assertChanged(this.db, '流程模板已被其他操作更新。');
    return this.getById(current.id)!;
  }

  /** 软删除模板，已经创建的运行继续保留冻结快照。 */
  delete(id: string, expectedRevision: number): DigitalTeamWorkflowTemplateRecord {
    const current = this.require(id);
    assertRevision(current.revision, expectedRevision, '流程模板');
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    this.db.execute('UPDATE digital_team_workflow_templates SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL', [timestamp, timestamp, current.id, current.revision]);
    assertChanged(this.db, '流程模板已被其他操作更新。');
    return current;
  }

  /** 要求模板存在。 */
  private require(id: string): DigitalTeamWorkflowTemplateRecord {
    const record = this.getById(id);
    if (!record) throw storeError('ZEUS_DIGITAL_TEAM_TEMPLATE_NOT_FOUND', '数字团队流程模板不存在。', 404);
    return record;
  }
}

/** 管理一次数字团队运行的冻结事实和当前阶段。 */
export class DigitalTeamWorkflowRunRepository {
  /** 保存数据库和可替换时钟。 */
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** 按身份读取运行。 */
  getById(id: string): DigitalTeamWorkflowRunRecord | undefined {
    const row = this.db.get<DigitalTeamWorkflowRunRow>('SELECT * FROM digital_team_workflow_runs WHERE id = ?', [identity(id, 'runId')]);
    return row ? mapRun(row) : undefined;
  }

  /** 按任务读取全部历史运行。 */
  listByTask(taskId: string): DigitalTeamWorkflowRunRecord[] {
    return this.db.select<DigitalTeamWorkflowRunRow>('SELECT * FROM digital_team_workflow_runs WHERE task_id = ? ORDER BY created_at DESC, id', [identity(taskId, 'taskId')]).map(mapRun);
  }

  /** 按项目读取运行。 */
  listByProject(projectId: string, limit = 100): DigitalTeamWorkflowRunRecord[] {
    return this.db.select<DigitalTeamWorkflowRunRow>('SELECT * FROM digital_team_workflow_runs WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ?', [identity(projectId, 'projectId'), boundedLimit(limit)]).map(mapRun);
  }

  /** 读取需要恢复或人工核对的运行。 */
  listRecoverable(limit = 100): DigitalTeamWorkflowRunRecord[] {
    return this.db.select<DigitalTeamWorkflowRunRow>("SELECT * FROM digital_team_workflow_runs WHERE status NOT IN ('completed','failed','cancelled') ORDER BY updated_at, id LIMIT ?", [boundedLimit(limit)]).map(mapRun);
  }

  /** 创建运行并一次冻结画布、全部角色、任务事实和逐仓 baseSha。 */
  create(input: CreateDigitalTeamWorkflowRunInput): DigitalTeamWorkflowRunRecord {
    assertDigitalTeamWorkflowReady(input.definition);
    const task = this.db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', [identity(input.taskId, 'taskId')]);
    if (!task || task.project_id !== input.projectId) throw storeError('ZEUS_DIGITAL_TEAM_TASK_NOT_FOUND', '任务不存在或不属于当前项目。', 404);
    const templateId = input.templateId ? identity(input.templateId, 'templateId') : null;
    let templateRevision: number | null = null;
    if (templateId) {
      const template = this.db.get<{ project_id: string; revision: number; definition_json: string; deleted_at: string | null }>('SELECT project_id, revision, definition_json, deleted_at FROM digital_team_workflow_templates WHERE id = ?', [
        templateId,
      ]);
      if (!template || template.deleted_at || template.project_id !== input.projectId) throw storeError('ZEUS_DIGITAL_TEAM_TEMPLATE_NOT_FOUND', '运行来源模板不存在或不属于当前项目。', 404);
      if (template.revision !== input.templateRevision || canonicalCommandInputJson(JSON.parse(template.definition_json)) !== canonicalCommandInputJson(input.definition))
        throw storeError('ZEUS_DIGITAL_TEAM_TEMPLATE_CONFLICT', '流程模板已变化，请重新读取后创建运行。', 409);
      templateRevision = template.revision;
    }
    /** 员工节点能力与角色冻结在同一事务内核对，HTTP 调用不能绕过前端创建无效运行。 */
    const employeeNodes = input.definition.nodes.filter((node): node is DigitalTeamEmployeeNode => node.type === 'employee');
    const employeeIds = [...new Set(employeeNodes.map((node) => node.data.employeeId))];
    const roleSnapshots = employeeIds.map((employeeId) =>
      freezeEmployee(
        this.db,
        input.projectId,
        employeeId,
        employeeNodes.filter((node) => node.data.employeeId === employeeId),
      ),
    );
    const baseRevisions = normalizeBaseRevisions(input.baseRevisions);
    const id = input.id ? identity(input.id, 'run.id') : `digital_team_run_${randomId(12)}`;
    const timestamp = this.now();
    this.db.execute(
      `INSERT INTO digital_team_workflow_runs
       (id, project_id, task_id, template_id, template_revision, definition_snapshot_json, role_snapshots_json, task_facts_json, base_revisions_json,
        main_conversation_id, status, control_state, plan_json, plan_version, plan_sha256, approved_plan_sha256, plan_approved_by, plan_approved_at,
        candidate_revisions_json, candidate_set_sha256, final_approved_candidate_set_sha256, final_approved_by, final_approved_at, error_json,
        revision, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'planning', 'running', NULL, 0, NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL, 1, ?, ?, NULL)`,
      [
        id,
        identity(input.projectId, 'projectId'),
        input.taskId,
        templateId,
        templateRevision,
        boundedJson(input.definition, 'definitionSnapshot'),
        boundedJson(roleSnapshots, 'roleSnapshots'),
        boundedJson(input.taskFacts, 'taskFacts'),
        boundedJson(baseRevisions, 'baseRevisions'),
        timestamp,
        timestamp,
      ],
    );
    return this.getById(id)!;
  }

  /** 修改运行阶段、控制、主会话或集成候选。 */
  update(id: string, input: UpdateDigitalTeamWorkflowRunInput): DigitalTeamWorkflowRunRecord {
    const current = this.require(id);
    assertRevision(current.revision, input.expectedRevision, '流程运行');
    if (['completed', 'cancelled'].includes(current.status)) throw storeError('ZEUS_DIGITAL_TEAM_RUN_STATE_INVALID', '已经结束的流程运行不能再修改。', 409);
    const status = input.status ?? current.status;
    const controlState = input.controlState ?? current.controlState;
    assertRunTransition(current.status, status);
    member(controlState, digitalTeamRunControlStates, 'controlState');
    const candidates = input.candidateRevisions === undefined ? current.candidateRevisions : normalizeCandidateRevisions(input.candidateRevisions);
    const candidateSetSha256 = candidates.length > 0 ? digest(candidates) : null;
    const candidateChanged = input.candidateRevisions !== undefined && candidateSetSha256 !== current.candidateSetSha256;
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    this.db.transaction(() => {
      if (candidateChanged) invalidateCandidateConsumersInCurrentTransaction(this.db, current, timestamp);
      this.db.execute(
        `UPDATE digital_team_workflow_runs SET status = ?, control_state = ?, main_conversation_id = ?, candidate_revisions_json = ?, candidate_set_sha256 = ?,
         final_approved_candidate_set_sha256 = CASE WHEN ? = 1 THEN NULL ELSE final_approved_candidate_set_sha256 END,
         final_approved_by = CASE WHEN ? = 1 THEN NULL ELSE final_approved_by END,
         final_approved_at = CASE WHEN ? = 1 THEN NULL ELSE final_approved_at END,
         error_json = ?, completed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`,
        [
          status,
          controlState,
          input.mainConversationId === undefined ? current.mainConversationId : optionalIdentity(input.mainConversationId, 'mainConversationId'),
          boundedJson(candidates, 'candidateRevisions'),
          candidateSetSha256,
          candidateChanged ? 1 : 0,
          candidateChanged ? 1 : 0,
          candidateChanged ? 1 : 0,
          input.error === undefined ? optionalJson(current.error, 'error') : optionalJson(input.error, 'error'),
          input.completedAt === undefined ? current.completedAt : optionalTimestamp(input.completedAt, 'completedAt'),
          timestamp,
          current.id,
          current.revision,
        ],
      );
      assertChanged(this.db, '流程运行已被其他操作更新。');
    });
    return this.getById(current.id)!;
  }

  /** 冻结 CTO 逐节点规划并进入人工批准。 */
  submitPlan(id: string, input: { expectedRevision: number; plan: DigitalTeamStructuredPlan }): DigitalTeamWorkflowRunRecord {
    const current = this.require(id);
    assertRevision(current.revision, input.expectedRevision, '流程运行');
    if (current.status !== 'planning') throw storeError('ZEUS_DIGITAL_TEAM_RUN_STATE_INVALID', '只有规划阶段可以提交 CTO 规划。', 409);
    const errors = validateDigitalTeamStructuredPlan(current.definitionSnapshot, input.plan);
    if (errors.length > 0) throw storeError('ZEUS_DIGITAL_TEAM_PLAN_INVALID', errors[0]!, 400);
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    const planJson = boundedJson(input.plan, 'plan');
    this.db.execute(
      "UPDATE digital_team_workflow_runs SET plan_json = ?, plan_version = plan_version + 1, plan_sha256 = ?, approved_plan_sha256 = NULL, plan_approved_by = NULL, plan_approved_at = NULL, status = 'awaiting_plan_approval', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      [planJson, digestJson(planJson), timestamp, current.id, current.revision],
    );
    assertChanged(this.db, '流程运行已被其他操作更新。');
    return this.getById(current.id)!;
  }

  /** 只批准当前规划摘要，重复或过期批准不会启动员工。 */
  approvePlan(id: string, input: { expectedRevision: number; planSha256: string; actorId: string }): DigitalTeamWorkflowRunRecord {
    const current = this.require(id);
    assertRevision(current.revision, input.expectedRevision, '流程运行');
    if (current.status !== 'awaiting_plan_approval' || !current.planSha256 || current.planSha256 !== sha256(input.planSha256, 'planSha256')) throw storeError('ZEUS_DIGITAL_TEAM_PLAN_APPROVAL_STALE', '规划已变化或不在等待批准状态。', 409);
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    this.db.execute(
      "UPDATE digital_team_workflow_runs SET approved_plan_sha256 = plan_sha256, plan_approved_by = ?, plan_approved_at = ?, status = 'executing', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND approved_plan_sha256 IS NULL",
      [identity(input.actorId, 'actorId'), timestamp, timestamp, current.id, current.revision],
    );
    assertChanged(this.db, '规划已经被其他操作处理。');
    return this.getById(current.id)!;
  }

  /** 最终验收只完成当前候选，不触发 push、目标分支更新或发布。 */
  approveFinal(id: string, input: { expectedRevision: number; candidateSetSha256: string; actorId: string }): DigitalTeamWorkflowRunRecord {
    const current = this.require(id);
    assertRevision(current.revision, input.expectedRevision, '流程运行');
    if (current.status !== 'awaiting_final_approval' || !current.candidateSetSha256 || current.candidateSetSha256 !== sha256(input.candidateSetSha256, 'candidateSetSha256'))
      throw storeError('ZEUS_DIGITAL_TEAM_FINAL_APPROVAL_STALE', '集成候选已变化或不在最终验收状态。', 409);
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    this.db.execute(
      "UPDATE digital_team_workflow_runs SET final_approved_candidate_set_sha256 = candidate_set_sha256, final_approved_by = ?, final_approved_at = ?, status = 'completed', completed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND final_approved_candidate_set_sha256 IS NULL",
      [identity(input.actorId, 'actorId'), timestamp, timestamp, timestamp, current.id, current.revision],
    );
    assertChanged(this.db, '最终验收已经被其他操作处理。');
    return this.getById(current.id)!;
  }

  /** 要求运行存在。 */
  private require(id: string): DigitalTeamWorkflowRunRecord {
    const record = this.getById(id);
    if (!record) throw storeError('ZEUS_DIGITAL_TEAM_RUN_NOT_FOUND', '数字团队运行不存在。', 404);
    return record;
  }
}

/** 管理节点逐次尝试及其精确会话、轮次和结果绑定。 */
export class DigitalTeamNodeAttemptRepository {
  /** 保存数据库和可替换时钟。 */
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** 按身份读取节点尝试。 */
  getById(id: string): DigitalTeamNodeAttemptRecord | undefined {
    const row = this.db.get<DigitalTeamNodeAttemptRow>('SELECT * FROM digital_team_node_attempts WHERE id = ?', [identity(id, 'attemptId')]);
    return row ? mapAttempt(row) : undefined;
  }

  /** 按运行读取完整尝试历史。 */
  listByRun(runId: string): DigitalTeamNodeAttemptRecord[] {
    return this.db.select<DigitalTeamNodeAttemptRow>('SELECT * FROM digital_team_node_attempts WHERE run_id = ? ORDER BY created_at, node_id, attempt', [identity(runId, 'runId')]).map(mapAttempt);
  }

  /** 读取节点最新尝试。 */
  getCurrentByNode(runId: string, nodeId: string): DigitalTeamNodeAttemptRecord | undefined {
    const row = this.db.get<DigitalTeamNodeAttemptRow>('SELECT * FROM digital_team_node_attempts WHERE run_id = ? AND node_id = ? ORDER BY attempt DESC LIMIT 1', [identity(runId, 'runId'), identity(nodeId, 'nodeId')]);
    return row ? mapAttempt(row) : undefined;
  }

  /** 为节点创建下一次尝试；活跃、成功或结果未知时拒绝隐式重放。 */
  create(input: CreateDigitalTeamNodeAttemptInput): DigitalTeamNodeAttemptRecord {
    const run = requireRun(this.db, input.runId);
    if (run.controlState === 'cancelled' || ['completed', 'cancelled'].includes(run.status)) throw storeError('ZEUS_DIGITAL_TEAM_RUN_NOT_DISPATCHABLE', '流程已经结束，不能创建节点尝试。', 409);
    const node = requireNode(run.definitionSnapshot, input.nodeId);
    const current = this.getCurrentByNode(run.id, node.id);
    if (current && !['changes_requested', 'invalidated', 'failed', 'cancelled'].includes(current.status)) throw storeError('ZEUS_DIGITAL_TEAM_ATTEMPT_ACTIVE', '节点已有不可重放的当前尝试。', 409);
    const attempt = (current?.attempt ?? 0) + 1;
    const id = input.id ? identity(input.id, 'attempt.id') : `digital_team_attempt_${randomId(12)}`;
    const timestamp = this.now();
    const status = input.status ?? (node.type === 'human_confirmation' ? 'awaiting_approval' : 'prepared');
    this.db.execute(
      `INSERT INTO digital_team_node_attempts
       (id, run_id, node_id, node_type, attempt, status, input_sha256, plan_version, work_item_id, work_run_id, conversation_id, submission_id, turn_id, segment_id,
        environment_id, workspace_id, command_id, external_operation_id, result_json, deliverable_id, deliverable_version, artifact_ref_json,
        verified_candidate_set_sha256, approval_json, invalidated_by_attempt_id, invalidation_reason, error_json, revision, started_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, ?, ?)`,
      [id, run.id, node.id, node.type, attempt, member(status, digitalTeamNodeAttemptStatuses, 'attempt.status'), sha256(input.inputSha256, 'inputSha256'), (input.planVersion ?? run.planVersion) || null, timestamp, timestamp],
    );
    return this.getById(id)!;
  }

  /** 使用乐观并发修改当前节点尝试。 */
  update(id: string, input: UpdateDigitalTeamNodeAttemptInput): DigitalTeamNodeAttemptRecord {
    const current = this.requireCurrent(id);
    assertRevision(current.revision, input.expectedRevision, '节点尝试');
    const status = input.status ?? current.status;
    assertAttemptTransition(current.status, status);
    const run = requireRun(this.db, current.runId);
    const verifiedCandidate = input.verifiedCandidateSetSha256 === undefined ? current.verifiedCandidateSetSha256 : input.verifiedCandidateSetSha256 ? sha256(input.verifiedCandidateSetSha256, 'verifiedCandidateSetSha256') : null;
    if (verifiedCandidate && verifiedCandidate !== run.candidateSetSha256) throw storeError('ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', '验证结果没有绑定当前集成候选。', 409);
    const timestamp = nextTimestamp(current.updatedAt, this.now());
    this.db.execute(
      `UPDATE digital_team_node_attempts SET status = ?, work_item_id = ?, work_run_id = ?, conversation_id = ?, submission_id = ?, turn_id = ?, segment_id = ?,
       environment_id = ?, workspace_id = ?, command_id = ?, external_operation_id = ?, result_json = ?, deliverable_id = ?, deliverable_version = ?, artifact_ref_json = ?,
       verified_candidate_set_sha256 = ?, approval_json = ?, error_json = ?, started_at = ?, completed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`,
      [
        status,
        patchIdentity(input.workItemId, current.workItemId, 'workItemId'),
        patchIdentity(input.workRunId, current.workRunId, 'workRunId'),
        patchIdentity(input.conversationId, current.conversationId, 'conversationId'),
        patchIdentity(input.submissionId, current.submissionId, 'submissionId'),
        patchIdentity(input.turnId, current.turnId, 'turnId'),
        patchIdentity(input.segmentId, current.segmentId, 'segmentId'),
        patchIdentity(input.environmentId, current.environmentId, 'environmentId'),
        patchIdentity(input.workspaceId, current.workspaceId, 'workspaceId'),
        patchIdentity(input.commandId, current.commandId, 'commandId'),
        patchIdentity(input.externalOperationId, current.externalOperationId, 'externalOperationId'),
        input.result === undefined ? optionalJson(current.result, 'result') : optionalJson(input.result, 'result'),
        patchIdentity(input.deliverableId, current.deliverableId, 'deliverableId'),
        input.deliverableVersion === undefined ? current.deliverableVersion : input.deliverableVersion,
        input.artifactRef === undefined ? optionalJson(current.artifactRef, 'artifactRef') : optionalJson(input.artifactRef, 'artifactRef'),
        verifiedCandidate,
        input.approval === undefined ? optionalJson(current.approval, 'approval') : optionalJson(input.approval, 'approval'),
        input.error === undefined ? optionalJson(current.error, 'error') : optionalJson(input.error, 'error'),
        input.startedAt === undefined ? current.startedAt : optionalTimestamp(input.startedAt, 'startedAt'),
        input.completedAt === undefined ? current.completedAt : optionalTimestamp(input.completedAt, 'completedAt'),
        timestamp,
        current.id,
        current.revision,
      ],
    );
    assertChanged(this.db, '节点尝试已被其他操作更新。');
    return this.getById(current.id)!;
  }

  /** 绑定本次工作和 Provider 轮次，禁止只记录可复用会话。 */
  bindExecution(
    id: string,
    input: {
      expectedRevision: number;
      workItemId?: string | null;
      workRunId?: string | null;
      conversationId: string;
      submissionId: string;
      turnId: string;
      segmentId: string;
      environmentId?: string | null;
      workspaceId?: string | null;
      commandId?: string | null;
      externalOperationId?: string | null;
    },
  ): DigitalTeamNodeAttemptRecord {
    return this.update(id, { ...input, status: 'active', startedAt: this.now() });
  }

  /** 提交员工结构化结果；说明文字本身不构成成功证据。 */
  submitResult(
    id: string,
    input: {
      expectedRevision: number;
      result: DigitalTeamStructuredResult;
      deliverableId?: string | null;
      deliverableVersion?: number | null;
      artifactRef?: Record<string, unknown> | null;
      verifiedCandidateSetSha256?: string | null;
    },
  ): DigitalTeamNodeAttemptRecord {
    const current = this.requireCurrent(id);
    const run = requireRun(this.db, current.runId);
    const node = requireNode(run.definitionSnapshot, current.nodeId);
    if (node.type !== 'employee' || current.status !== 'active') throw storeError('ZEUS_DIGITAL_TEAM_RESULT_STATE_INVALID', '只有当前活动员工尝试可以提交结果。', 409);
    validateStructuredResult(node, input.result, run);
    const verifiedCandidateSetSha256 = node.data.purpose === 'verify' ? run.candidateSetSha256 : input.verifiedCandidateSetSha256;
    return this.update(id, { ...input, verifiedCandidateSetSha256, status: input.result.outcome === 'succeeded' ? 'succeeded' : 'failed', completedAt: this.now() });
  }

  /** 记录人工决定，并精确绑定当前规划或候选摘要。 */
  decideApproval(id: string, input: { expectedRevision: number; approval: DigitalTeamApprovalDecision }): DigitalTeamNodeAttemptRecord {
    const current = this.requireCurrent(id);
    const run = requireRun(this.db, current.runId);
    const node = requireNode(run.definitionSnapshot, current.nodeId);
    if (node.type !== 'human_confirmation' || current.status !== 'awaiting_approval' || node.data.purpose !== input.approval.purpose) throw storeError('ZEUS_DIGITAL_TEAM_APPROVAL_STATE_INVALID', '人工决定不属于当前等待批准节点。', 409);
    const expectedSha = node.data.purpose === 'plan_approval' ? run.planSha256 : run.candidateSetSha256;
    if (!expectedSha || expectedSha !== sha256(input.approval.boundSha256, 'approval.boundSha256')) throw storeError('ZEUS_DIGITAL_TEAM_APPROVAL_STALE', '人工决定绑定的规划或候选已经变化。', 409);
    return this.update(id, { expectedRevision: input.expectedRevision, approval: normalizeApproval(input.approval), status: input.approval.decision === 'approved' ? 'succeeded' : 'changes_requested', completedAt: this.now() });
  }

  /** 让目标节点及全部后继的当前结果失效，未受影响并行分支保持不变。 */
  invalidateCurrentAndDescendants(input: { runId: string; nodeId: string; reason: string; invalidatedByAttemptId?: string | null }): DigitalTeamNodeAttemptRecord[] {
    const run = requireRun(this.db, input.runId);
    requireNode(run.definitionSnapshot, input.nodeId);
    const affected = descendants(run.definitionSnapshot, input.nodeId);
    const current = this.listByRun(run.id).filter((candidate) => affected.has(candidate.nodeId) && candidate.id === this.getCurrentByNode(run.id, candidate.nodeId)?.id);
    if (current.some((candidate) => candidate.status === 'outcome_unknown')) throw storeError('ZEUS_DIGITAL_TEAM_UNKNOWN_OUTCOME', '受影响节点仍有未知外部结果，核对前不能创建返工尝试。', 409);
    const reason = boundedText(input.reason, 'reason', 2_000);
    const invalidatedByAttemptId = optionalIdentity(input.invalidatedByAttemptId ?? null, 'invalidatedByAttemptId');
    const timestamp = this.now();
    this.db.transaction(() => {
      for (const attempt of current.filter((candidate) => !['invalidated', 'cancelled'].includes(candidate.status))) {
        this.db.execute(
          "UPDATE digital_team_node_attempts SET status = 'invalidated', invalidated_by_attempt_id = ?, invalidation_reason = ?, revision = revision + 1, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND revision = ?",
          [invalidatedByAttemptId, reason, timestamp, nextTimestamp(attempt.updatedAt, timestamp), attempt.id, attempt.revision],
        );
        assertChanged(this.db, '节点尝试已被其他操作更新。');
      }
    });
    return current.map((attempt) => this.getById(attempt.id)!);
  }

  /** 要求尝试仍是该节点最新尝试。 */
  private requireCurrent(id: string): DigitalTeamNodeAttemptRecord {
    const current = this.getById(id);
    if (!current) throw storeError('ZEUS_DIGITAL_TEAM_ATTEMPT_NOT_FOUND', '节点尝试不存在。', 404);
    if (this.getCurrentByNode(current.runId, current.nodeId)?.id !== current.id) throw storeError('ZEUS_DIGITAL_TEAM_ATTEMPT_STALE', '迟到结果属于旧节点尝试，已拒绝接纳。', 409);
    return current;
  }
}

interface DigitalTeamWorkflowTemplateRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  definition_json: string;
  ready: number;
  validation_issues_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface DigitalTeamWorkflowRunRow {
  id: string;
  project_id: string;
  task_id: string;
  template_id: string | null;
  template_revision: number | null;
  definition_snapshot_json: string;
  role_snapshots_json: string;
  task_facts_json: string;
  base_revisions_json: string;
  main_conversation_id: string | null;
  status: string;
  control_state: string;
  plan_json: string | null;
  plan_version: number;
  plan_sha256: string | null;
  approved_plan_sha256: string | null;
  plan_approved_by: string | null;
  plan_approved_at: string | null;
  candidate_revisions_json: string;
  candidate_set_sha256: string | null;
  final_approved_candidate_set_sha256: string | null;
  final_approved_by: string | null;
  final_approved_at: string | null;
  error_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface DigitalTeamNodeAttemptRow {
  id: string;
  run_id: string;
  node_id: string;
  node_type: string;
  attempt: number;
  status: string;
  input_sha256: string;
  plan_version: number | null;
  work_item_id: string | null;
  work_run_id: string | null;
  conversation_id: string | null;
  submission_id: string | null;
  turn_id: string | null;
  segment_id: string | null;
  environment_id: string | null;
  workspace_id: string | null;
  command_id: string | null;
  external_operation_id: string | null;
  result_json: string | null;
  deliverable_id: string | null;
  deliverable_version: number | null;
  artifact_ref_json: string | null;
  verified_candidate_set_sha256: string | null;
  approval_json: string | null;
  invalidated_by_attempt_id: string | null;
  invalidation_reason: string | null;
  error_json: string | null;
  revision: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 把模板行映射为领域记录。 */
function mapTemplate(row: DigitalTeamWorkflowTemplateRow): DigitalTeamWorkflowTemplateRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    definition: parseJson<DigitalTeamWorkflowDefinition>(row.definition_json, 'template.definition'),
    ready: row.ready === 1,
    validationIssues: parseJson<DigitalTeamWorkflowValidationIssue[]>(row.validation_issues_json, 'template.validationIssues'),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 把运行行映射为领域记录。 */
function mapRun(row: DigitalTeamWorkflowRunRow): DigitalTeamWorkflowRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    templateId: row.template_id,
    templateRevision: row.template_revision,
    definitionSnapshot: parseJson<DigitalTeamWorkflowDefinition>(row.definition_snapshot_json, 'run.definitionSnapshot'),
    roleSnapshots: parseJson<DigitalTeamRoleSnapshot[]>(row.role_snapshots_json, 'run.roleSnapshots'),
    taskFacts: parseJson<Record<string, unknown>>(row.task_facts_json, 'run.taskFacts'),
    baseRevisions: parseJson<DigitalTeamBaseRevision[]>(row.base_revisions_json, 'run.baseRevisions'),
    mainConversationId: row.main_conversation_id,
    status: member(row.status, digitalTeamRunStatuses, 'run.status'),
    controlState: member(row.control_state, digitalTeamRunControlStates, 'run.controlState'),
    plan: row.plan_json ? parseJson<DigitalTeamStructuredPlan>(row.plan_json, 'run.plan') : null,
    planVersion: row.plan_version,
    planSha256: row.plan_sha256,
    approvedPlanSha256: row.approved_plan_sha256,
    planApprovedBy: row.plan_approved_by,
    planApprovedAt: row.plan_approved_at,
    candidateRevisions: parseJson<DigitalTeamCandidateRevision[]>(row.candidate_revisions_json, 'run.candidateRevisions'),
    candidateSetSha256: row.candidate_set_sha256,
    finalApprovedCandidateSetSha256: row.final_approved_candidate_set_sha256,
    finalApprovedBy: row.final_approved_by,
    finalApprovedAt: row.final_approved_at,
    error: row.error_json ? parseJson<Record<string, unknown>>(row.error_json, 'run.error') : null,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/** 把节点尝试行映射为领域记录。 */
function mapAttempt(row: DigitalTeamNodeAttemptRow): DigitalTeamNodeAttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    nodeType: row.node_type as DigitalTeamNodeType,
    attempt: row.attempt,
    status: member(row.status, digitalTeamNodeAttemptStatuses, 'attempt.status'),
    inputSha256: row.input_sha256,
    planVersion: row.plan_version,
    workItemId: row.work_item_id,
    workRunId: row.work_run_id,
    conversationId: row.conversation_id,
    submissionId: row.submission_id,
    turnId: row.turn_id,
    segmentId: row.segment_id,
    environmentId: row.environment_id,
    workspaceId: row.workspace_id,
    commandId: row.command_id,
    externalOperationId: row.external_operation_id,
    result: row.result_json ? parseJson<DigitalTeamStructuredResult>(row.result_json, 'attempt.result') : null,
    deliverableId: row.deliverable_id,
    deliverableVersion: row.deliverable_version,
    artifactRef: row.artifact_ref_json ? parseJson<Record<string, unknown>>(row.artifact_ref_json, 'attempt.artifactRef') : null,
    verifiedCandidateSetSha256: row.verified_candidate_set_sha256,
    approval: row.approval_json ? parseJson<DigitalTeamApprovalDecision>(row.approval_json, 'attempt.approval') : null,
    invalidatedByAttemptId: row.invalidated_by_attempt_id,
    invalidationReason: row.invalidation_reason,
    error: row.error_json ? parseJson<Record<string, unknown>>(row.error_json, 'attempt.error') : null,
    revision: row.revision,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 从权威员工记录冻结不含凭据的完整角色配置。 */
function freezeEmployee(db: ZeusDatabasePort, projectId: string, employeeId: string, nodes: DigitalTeamEmployeeNode[]): DigitalTeamRoleSnapshot {
  const employee = new DigitalEmployeeRepository(db).getById(identity(employeeId, 'employeeId'));
  if (!employee?.enabled || employee.projectId !== identity(projectId, 'projectId')) throw storeError('ZEUS_DIGITAL_TEAM_EMPLOYEE_UNAVAILABLE', '流程中的数字员工不存在、已停用或不属于当前项目。', 409);
  if (employee.entrypoint?.kind !== 'agent' || employee.entrypointMigrationState !== 'ready') {
    throw storeError('ZEUS_DIGITAL_TEAM_EMPLOYEE_NOT_READY', `数字员工“${employee.name}”尚未完成 Agent 配置。`, 409);
  }
  /** 节点需要的能力必须同时得到角色顶层授权和冻结 Agent 策略授权。 */
  const authority = employee.entrypoint.authorityPolicy;
  for (const node of nodes) {
    if (
      node.data.executionMode === 'isolated_write' &&
      (employee.permissionMode === 'read-only' || authority.permissionMode === 'read-only' || !employee.allowCodeChanges || !authority.allowCodeChanges || !employee.deliveryGrants.allowCommit || !authority.allowCommit)
    ) {
      throw storeError('ZEUS_DIGITAL_TEAM_EMPLOYEE_AUTHORITY_INCOMPATIBLE', `数字员工“${employee.name}”缺少节点“${node.data.title}”所需的代码修改或本地提交权限。`, 409);
    }
    if (node.data.purpose === 'verify' && (employee.permissionMode === 'read-only' || authority.permissionMode === 'read-only' || !employee.allowTests || !authority.allowTests)) {
      throw storeError('ZEUS_DIGITAL_TEAM_EMPLOYEE_AUTHORITY_INCOMPATIBLE', `数字员工“${employee.name}”缺少节点“${node.data.title}”所需的验证权限。`, 409);
    }
  }
  return { employeeId: employee.id, employeeRevision: employee.revision, configuration: structuredClone(employee) as unknown as Record<string, unknown> };
}

/** 要求项目存在。 */
function requireProject(db: ZeusDatabasePort, projectId: string): void {
  if (!db.get('SELECT id FROM projects WHERE id = ?', [identity(projectId, 'projectId')])) throw storeError('ZEUS_DIGITAL_TEAM_PROJECT_NOT_FOUND', '项目不存在。', 404);
}

/** 读取运行并验证冻结定义。 */
function requireRun(db: ZeusDatabasePort, runId: string): DigitalTeamWorkflowRunRecord {
  const row = db.get<DigitalTeamWorkflowRunRow>('SELECT * FROM digital_team_workflow_runs WHERE id = ?', [identity(runId, 'runId')]);
  if (!row) throw storeError('ZEUS_DIGITAL_TEAM_RUN_NOT_FOUND', '数字团队运行不存在。', 404);
  const run = mapRun(row);
  assertDigitalTeamWorkflowReady(run.definitionSnapshot);
  return run;
}

/** 读取冻结画布中的节点。 */
function requireNode(definition: DigitalTeamWorkflowDefinition, nodeId: string): DigitalTeamNode {
  const node = definition.nodes.find((candidate) => candidate.id === identity(nodeId, 'nodeId'));
  if (!node) throw storeError('ZEUS_DIGITAL_TEAM_NODE_NOT_FOUND', '运行中的节点不存在。', 404);
  return node;
}

/** 规范并验证逐仓来源提交。 */
function normalizeBaseRevisions(values: DigitalTeamBaseRevision[]): DigitalTeamBaseRevision[] {
  if (!Array.isArray(values) || values.length === 0) throw storeError('ZEUS_DIGITAL_TEAM_BASE_REVISION_INVALID', '创建运行必须冻结至少一个仓库的 baseSha。');
  const normalized = values.map((value) => ({ repositoryId: identity(value.repositoryId, 'base.repositoryId'), sourceRef: identity(value.sourceRef, 'base.sourceRef'), baseSha: gitSha(value.baseSha, 'base.baseSha') }));
  if (new Set(normalized.map((value) => value.repositoryId)).size !== normalized.length) throw storeError('ZEUS_DIGITAL_TEAM_BASE_REVISION_INVALID', '同一仓库不能重复冻结 baseSha。');
  return normalized.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
}

/** 规范并验证逐仓候选提交。 */
function normalizeCandidateRevisions(values: DigitalTeamCandidateRevision[]): DigitalTeamCandidateRevision[] {
  if (!Array.isArray(values)) throw storeError('ZEUS_DIGITAL_TEAM_CANDIDATE_INVALID', '集成候选必须按仓库提交。');
  const normalized = values.map((value) => ({
    repositoryId: identity(value.repositoryId, 'candidate.repositoryId'),
    headSha: gitSha(value.headSha, 'candidate.headSha'),
    workspaceRef: identity(value.workspaceRef, 'candidate.workspaceRef'),
  }));
  if (new Set(normalized.map((value) => value.repositoryId)).size !== normalized.length) throw storeError('ZEUS_DIGITAL_TEAM_CANDIDATE_INVALID', '同一仓库不能出现多个当前候选。');
  return normalized.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
}

/** 校验员工结果与节点职责以及当前候选一致。 */
function validateStructuredResult(node: Extract<DigitalTeamNode, { type: 'employee' }>, result: DigitalTeamStructuredResult, run: DigitalTeamWorkflowRunRecord): void {
  if (
    !result ||
    !['succeeded', 'failed', 'blocked'].includes(result.outcome) ||
    !['passed', 'failed', 'not_run'].includes(result.verification) ||
    typeof result.summary !== 'string' ||
    !result.summary.trim() ||
    !Array.isArray(result.evidence) ||
    result.evidence.length === 0 ||
    !Array.isArray(result.remainingIssues) ||
    !result.remainingIssues.every((issue) => typeof issue === 'string' && Boolean(issue.trim()))
  )
    throw storeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '员工结果必须包含结论、验证状态、摘要、剩余问题和当前尝试的真实证据。');
  for (const evidence of result.evidence) {
    if (
      !evidence ||
      !['message', 'change_set', 'command', 'artifact', 'git_candidate'].includes(evidence.kind) ||
      !identity(evidence.id, 'evidence.id') ||
      !sha256(evidence.sha256, 'evidence.sha256') ||
      !boundedText(evidence.status, 'evidence.status', 128)
    )
      throw storeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '员工结果包含无效证据。');
  }
  if (node.data.executionMode === 'isolated_write' && (!Array.isArray(result.repositoryResults) || result.repositoryResults.length === 0)) throw storeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '写入节点必须提交逐仓 baseSha 和 headSha。');
  if (node.data.executionMode !== 'isolated_write' && Array.isArray(result.repositoryResults) && result.repositoryResults.length > 0) throw storeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '非写入节点不能提交代码版本。');
  if (
    !Array.isArray(result.repositoryResults) ||
    result.repositoryResults.some((value) => !value || !identity(value.repositoryId, 'result.repositoryId') || !gitSha(value.baseSha, 'result.baseSha') || !gitSha(value.headSha, 'result.headSha'))
  )
    throw storeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '逐仓代码结果字段无效。');
  if (node.data.purpose === 'verify') {
    const verified = normalizeVerifiedCandidates(result.verifiedCandidates);
    const current = run.candidateRevisions.map((value) => ({ repositoryId: value.repositoryId, headSha: value.headSha }));
    if (result.outcome === 'succeeded' && result.verification !== 'passed') throw storeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '候选验证只有取得 passed 结论后才能成功。');
    if (run.candidateSetSha256 === null || digest(verified) !== digest(current)) throw storeError('ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', '验证结果没有覆盖当前逐仓集成候选。', 409);
  }
}

/** 规范候选验证列表。 */
function normalizeVerifiedCandidates(values: DigitalTeamStructuredResult['verifiedCandidates']): Array<{ repositoryId: string; headSha: string }> {
  if (!Array.isArray(values) || values.length === 0) throw storeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '候选验证结果不能为空。');
  const normalized = values
    .map((value) => ({ repositoryId: identity(value.repositoryId, 'verified.repositoryId'), headSha: gitSha(value.headSha, 'verified.headSha') }))
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  if (new Set(normalized.map((value) => value.repositoryId)).size !== normalized.length) throw storeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '同一仓库不能重复提交候选验证。');
  return normalized;
}

/** 规范人工决定。 */
function normalizeApproval(value: DigitalTeamApprovalDecision): DigitalTeamApprovalDecision {
  if (!['plan_approval', 'final_acceptance'].includes(value.purpose) || !['approved', 'changes_requested'].includes(value.decision) || !['user', 'system', 'local_api', 'remote_control', 'worker'].includes(value.actorKind))
    throw storeError('ZEUS_DIGITAL_TEAM_APPROVAL_INVALID', '人工决定字段无效。');
  return { ...value, actorId: identity(value.actorId, 'approval.actorId'), boundSha256: sha256(value.boundSha256, 'approval.boundSha256'), reason: boundedText(value.reason, 'approval.reason', 2_000, true) };
}

/** 返回目标节点及全部后继身份。 */
function descendants(definition: DigitalTeamWorkflowDefinition, nodeId: string): Set<string> {
  const outgoing = new Map(definition.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of definition.edges) outgoing.get(edge.source)!.add(edge.target);
  const result = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    for (const next of outgoing.get(current) ?? []) pending.push(next);
  }
  return result;
}

/** 候选提交变化时让验证及全部后继当前结果失效，避免沿用旧验证。 */
function invalidateCandidateConsumersInCurrentTransaction(db: ZeusDatabasePort, run: DigitalTeamWorkflowRunRecord, timestamp: string): void {
  const verification = run.definitionSnapshot.nodes.find((node) => node.type === 'employee' && node.data.purpose === 'verify');
  if (!verification) throw storeError('ZEUS_DIGITAL_TEAM_DATA_CORRUPTED', '冻结流程缺少候选验证节点。', 500);
  const affected = descendants(run.definitionSnapshot, verification.id);
  const attempts = db
    .select<DigitalTeamNodeAttemptRow>(
      `SELECT current.* FROM digital_team_node_attempts AS current
       WHERE current.run_id = ?
         AND current.attempt = (SELECT MAX(latest.attempt) FROM digital_team_node_attempts AS latest WHERE latest.run_id = current.run_id AND latest.node_id = current.node_id)`,
      [run.id],
    )
    .map(mapAttempt)
    .filter((attempt) => affected.has(attempt.nodeId) && !['invalidated', 'cancelled'].includes(attempt.status));
  if (attempts.some((attempt) => attempt.status === 'outcome_unknown')) throw storeError('ZEUS_DIGITAL_TEAM_UNKNOWN_OUTCOME', '旧候选仍有未知外部结果，核对前不能替换候选。', 409);
  for (const attempt of attempts) {
    db.execute(
      "UPDATE digital_team_node_attempts SET status = 'invalidated', invalidation_reason = '集成候选已经变化，旧验证和下游结果失效。', revision = revision + 1, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND revision = ?",
      [timestamp, nextTimestamp(attempt.updatedAt, timestamp), attempt.id, attempt.revision],
    );
    assertChanged(db, '候选验证已经被其他操作更新。');
  }
}

/** 校验运行阶段迁移。 */
function assertRunTransition(from: DigitalTeamRunStatus, to: DigitalTeamRunStatus): void {
  if (from === to) return;
  const allowed: Record<DigitalTeamRunStatus, readonly DigitalTeamRunStatus[]> = {
    planning: ['awaiting_plan_approval', 'failed', 'outcome_unknown', 'cancelled'],
    awaiting_plan_approval: ['planning', 'executing', 'cancelled'],
    executing: ['planning', 'integrating', 'failed', 'outcome_unknown', 'cancelled'],
    integrating: ['planning', 'executing', 'verifying', 'failed', 'outcome_unknown', 'cancelled'],
    verifying: ['planning', 'executing', 'summarizing', 'failed', 'outcome_unknown', 'cancelled'],
    summarizing: ['planning', 'executing', 'verifying', 'awaiting_final_approval', 'failed', 'outcome_unknown', 'cancelled'],
    awaiting_final_approval: ['planning', 'executing', 'verifying', 'summarizing', 'completed', 'cancelled'],
    completed: [],
    failed: [],
    outcome_unknown: ['planning', 'executing', 'verifying', 'summarizing', 'failed', 'cancelled'],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) throw storeError('ZEUS_DIGITAL_TEAM_RUN_STATE_INVALID', `流程不能从 ${from} 进入 ${to}。`, 409);
}

/** 校验节点尝试状态迁移。 */
function assertAttemptTransition(from: DigitalTeamNodeAttemptStatus, to: DigitalTeamNodeAttemptStatus): void {
  if (from === to) return;
  const allowed: Record<DigitalTeamNodeAttemptStatus, readonly DigitalTeamNodeAttemptStatus[]> = {
    prepared: ['dispatching', 'active', 'awaiting_approval', 'failed', 'cancelled'],
    dispatching: ['active', 'failed', 'outcome_unknown', 'cancelled'],
    active: ['succeeded', 'failed', 'outcome_unknown', 'cancelled'],
    awaiting_approval: ['succeeded', 'changes_requested', 'cancelled'],
    succeeded: ['invalidated'],
    changes_requested: ['invalidated'],
    invalidated: [],
    failed: ['invalidated'],
    outcome_unknown: ['succeeded', 'failed'],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) throw storeError('ZEUS_DIGITAL_TEAM_ATTEMPT_STATE_INVALID', `节点尝试不能从 ${from} 进入 ${to}。`, 409);
}

/** 校验乐观并发修订。 */
function assertRevision(current: number, expected: number, label: string): void {
  if (current !== expected) throw storeError('ZEUS_DIGITAL_TEAM_REVISION_CONFLICT', `${label}已变化，请刷新后重试。`, 409);
}

/** 校验上一条更新实际命中一行。 */
function assertChanged(db: ZeusDatabasePort, message: string): void {
  if ((db.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0) !== 1) throw storeError('ZEUS_DIGITAL_TEAM_REVISION_CONFLICT', message, 409);
}

/** 校验稳定身份。 */
function identity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw storeError('ZEUS_DIGITAL_TEAM_INPUT_INVALID', `${field} 无效。`);
  return normalized;
}

/** 校验可空身份。 */
function optionalIdentity(value: string | null, field: string): string | null {
  return value === null ? null : identity(value, field);
}

/** 从修改输入选取并校验身份。 */
function patchIdentity(value: string | null | undefined, current: string | null, field: string): string | null {
  return value === undefined ? current : optionalIdentity(value, field);
}

/** 校验有限文字。 */
function boundedText(value: string, field: string, maximum: number, allowEmpty = false): string {
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maximum) throw storeError('ZEUS_DIGITAL_TEAM_INPUT_INVALID', `${field} 无效。`);
  return normalized;
}

/** 序列化有大小上限的 JSON。 */
function boundedJson(value: unknown, field: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) throw storeError('ZEUS_DIGITAL_TEAM_INPUT_INVALID', `${field} 超过 1 MiB，请改用 ArtifactRef。`);
  return serialized;
}

/** 序列化可空 JSON。 */
function optionalJson(value: unknown | null, field: string): string | null {
  return value === null ? null : boundedJson(value, field);
}

/** 解析数据库 JSON。 */
function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw storeError('ZEUS_DIGITAL_TEAM_DATA_CORRUPTED', `${field} 已损坏。`, 500);
  }
}

/** 校验枚举成员。 */
function member<const TValues extends readonly string[]>(value: string, values: TValues, field: string): TValues[number] {
  if (!values.includes(value)) throw storeError('ZEUS_DIGITAL_TEAM_DATA_CORRUPTED', `${field} 包含未知值。`, 500);
  return value as TValues[number];
}

/** 校验完整 Git 提交。 */
function gitSha(value: string, field: string): string {
  const normalized = value.toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(normalized)) throw storeError('ZEUS_DIGITAL_TEAM_INPUT_INVALID', `${field} 必须是完整 Git 提交。`);
  return normalized;
}

/** 校验 SHA-256。 */
function sha256(value: string, field: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw storeError('ZEUS_DIGITAL_TEAM_INPUT_INVALID', `${field} 必须是 SHA-256。`);
  return normalized;
}

/** 对稳定 JSON 内容取 SHA-256。 */
function digest(value: unknown): string {
  return digestJson(JSON.stringify(value));
}

/** 对已有 JSON 正文取 SHA-256。 */
function digestJson(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 校验可空时间。 */
function optionalTimestamp(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!Number.isFinite(Date.parse(value))) throw storeError('ZEUS_DIGITAL_TEAM_INPUT_INVALID', `${field} 不是有效时间。`);
  return value;
}

/** 保证更新时间严格递增。 */
function nextTimestamp(previous: string, candidate: string): string {
  return candidate > previous ? candidate : new Date(Date.parse(previous) + 1).toISOString();
}

/** 限制列表读取数量。 */
function boundedLimit(value: number): number {
  return Number.isInteger(value) ? Math.max(1, Math.min(500, value)) : 100;
}

/** 构造统一存储错误。 */
function storeError(code: string, message: string, statusCode: 400 | 404 | 409 | 500 = 400): DigitalTeamWorkflowStoreError {
  return new DigitalTeamWorkflowStoreError(code, message, statusCode);
}
