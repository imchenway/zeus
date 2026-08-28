import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ZeusDatabasePort } from './databasePort.js';

export const digitalEmployeeSchemaMigrationId = '20260825_0001_digital_employees_v1';

export const digitalEmployeeAgentKinds = ['codex', 'pi'] as const;
export const digitalEmployeePermissionModes = ['read-only', 'auto', 'full-access'] as const;
export const digitalEmployeeWorkModes = ['default', 'plan'] as const;
export const digitalEmployeeAutomationTriggerKinds = ['immediate', 'once', 'daily', 'weekly', 'interval', 'task_created', 'task_updated', 'task_status_changed', 'code_changed'] as const;
export const digitalEmployeeAutomationActionKinds = ['assign_task', 'create_and_assign_task', 'explore_project'] as const;
export const digitalEmployeeExecutionStatuses = ['queued', 'dispatching', 'running', 'waiting', 'delivery_pending', 'delivered', 'blocked', 'failed', 'cancelled'] as const;
export const digitalEmployeeExecutionSources = ['manual', 'task_pool', 'exploration', 'automation'] as const;
export const digitalEmployeeDeliveryStages = ['none', 'commit', 'push', 'merge', 'deploy', 'complete', 'done'] as const;
export const digitalEmployeeExecutionModes = ['legacy_single_conversation', 'staged'] as const;

export type DigitalEmployeeAgentKind = (typeof digitalEmployeeAgentKinds)[number];
export type DigitalEmployeePermissionMode = (typeof digitalEmployeePermissionModes)[number];
export type DigitalEmployeeWorkMode = (typeof digitalEmployeeWorkModes)[number];
export type DigitalEmployeeAutomationTriggerKind = (typeof digitalEmployeeAutomationTriggerKinds)[number];
export type DigitalEmployeeAutomationActionKind = (typeof digitalEmployeeAutomationActionKinds)[number];
export type DigitalEmployeeExecutionStatus = (typeof digitalEmployeeExecutionStatuses)[number];
export type DigitalEmployeeExecutionSource = (typeof digitalEmployeeExecutionSources)[number];
export type DigitalEmployeeDeliveryStage = (typeof digitalEmployeeDeliveryStages)[number];
export type DigitalEmployeeExecutionMode = (typeof digitalEmployeeExecutionModes)[number];

export interface DigitalEmployeeDeliveryGrants {
  allowCommit: boolean;
  allowPush: boolean;
  allowMerge: boolean;
  allowDeploy: boolean;
  allowComplete: boolean;
}

export interface DigitalEmployeeTemplateRecord {
  id: string;
  name: string;
  description: string;
  role: string;
  domain: string;
  /** 兼容既有 JSON 列的数组形态；首版只允许零或一个默认 Zeus Skill 稳定身份。 */
  skillIds: string[];
  prompt: string;
  agentKind: DigitalEmployeeAgentKind;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  permissionMode: DigitalEmployeePermissionMode;
  workMode: DigitalEmployeeWorkMode;
  builtIn: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DigitalEmployeeRecord extends Omit<DigitalEmployeeTemplateRecord, 'builtIn'> {
  projectId: string;
  templateId: string | null;
  enabled: boolean;
  autoClaim: boolean;
  autonomousExploration: boolean;
  maxConcurrency: number;
  taskFilter: DigitalEmployeeTaskFilter;
  allowCodeChanges: boolean;
  allowTests: boolean;
  deliveryGrants: DigitalEmployeeDeliveryGrants;
  deployCommandId: string | null;
}

export interface DigitalEmployeeTaskFilter {
  managementStatuses: string[];
  taskTypes: string[];
  requiredTags: string[];
}

export interface DigitalEmployeeAutomationRecord {
  id: string;
  projectId: string;
  employeeId: string;
  name: string;
  enabled: boolean;
  triggerKind: DigitalEmployeeAutomationTriggerKind;
  triggerConfig: Record<string, unknown>;
  actionKind: DigitalEmployeeAutomationActionKind;
  actionConfig: Record<string, unknown>;
  nextRunAt: string | null;
  cursorSequence: number;
  lastTriggeredAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DigitalEmployeeExecutionRecord {
  id: string;
  projectId: string;
  taskId: string;
  employeeId: string;
  templateId: string | null;
  automationId: string | null;
  source: DigitalEmployeeExecutionSource;
  sourceRef: string | null;
  status: DigitalEmployeeExecutionStatus;
  executionMode: DigitalEmployeeExecutionMode;
  workflowId: string | null;
  currentStageId: string | null;
  revision: number;
  employeeSnapshot: DigitalEmployeeRecord;
  deliveryGrantsSnapshot: DigitalEmployeeDeliveryGrants;
  conversationId: string | null;
  environmentId: string | null;
  deliveryStage: DigitalEmployeeDeliveryStage;
  deliveryState: Record<string, unknown>;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDigitalEmployeeTemplateInput {
  id?: string;
  name: string;
  description?: string;
  role: string;
  domain?: string;
  skillIds?: string[];
  prompt: string;
  agentKind?: DigitalEmployeeAgentKind;
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  permissionMode?: DigitalEmployeePermissionMode;
  workMode?: DigitalEmployeeWorkMode;
}

export type UpdateDigitalEmployeeTemplateInput = Partial<Omit<CreateDigitalEmployeeTemplateInput, 'id'>> & { expectedRevision: number };

export interface CreateDigitalEmployeeInput extends Omit<CreateDigitalEmployeeTemplateInput, 'id'> {
  id?: string;
  projectId: string;
  templateId?: string | null;
  enabled?: boolean;
  autoClaim?: boolean;
  autonomousExploration?: boolean;
  maxConcurrency?: number;
  taskFilter?: Partial<DigitalEmployeeTaskFilter>;
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  deliveryGrants?: Partial<DigitalEmployeeDeliveryGrants>;
  deployCommandId?: string | null;
}

export type UpdateDigitalEmployeeInput = Partial<Omit<CreateDigitalEmployeeInput, 'id' | 'projectId'>> & { expectedRevision: number };

export interface CreateDigitalEmployeeAutomationInput {
  id?: string;
  projectId: string;
  employeeId: string;
  name: string;
  enabled?: boolean;
  triggerKind: DigitalEmployeeAutomationTriggerKind;
  triggerConfig?: Record<string, unknown>;
  actionKind: DigitalEmployeeAutomationActionKind;
  actionConfig?: Record<string, unknown>;
  nextRunAt?: string | null;
}

export type UpdateDigitalEmployeeAutomationInput = Partial<Omit<CreateDigitalEmployeeAutomationInput, 'id' | 'projectId' | 'employeeId'>> & { expectedRevision: number };

export interface CreateDigitalEmployeeExecutionInput {
  id?: string;
  employee: DigitalEmployeeRecord;
  taskId: string;
  automationId?: string | null;
  source: DigitalEmployeeExecutionSource;
  sourceRef?: string | null;
  executionMode?: DigitalEmployeeExecutionMode;
  workflowId?: string | null;
  currentStageId?: string | null;
}

const builtInDigitalEmployeeTemplates: ReadonlyArray<CreateDigitalEmployeeTemplateInput & { id: string }> = [
  {
    id: 'digital_employee_template_product',
    name: '产品数字员工',
    description: '分析需求、业务规则、取舍与验收标准。',
    role: '产品',
    domain: '通用',
    skillIds: [],
    prompt: '你是产品数字员工。先核对需求来源和真实产品语义，再给出边界、取舍、验收标准与可执行任务。所有建议必须说明优缺点。',
    permissionMode: 'read-only',
  },
  {
    id: 'digital_employee_template_frontend',
    name: '前端数字员工',
    description: '负责前端交互、实现与真实界面验收。',
    role: '前端',
    domain: '通用',
    skillIds: [],
    prompt: '你是前端数字员工。基于现有设计系统完成最小范围实现，并以真实渲染、交互与可访问性证据验收。',
    permissionMode: 'auto',
  },
  {
    id: 'digital_employee_template_developer',
    name: '开发数字员工',
    description: '负责代码调查、实现、静态验证与交付说明。',
    role: '开发',
    domain: '通用',
    skillIds: [],
    prompt: '你是开发数字员工。先确认代码现场与边界，再实施最小且完整的修改；保留可审计证据，不把构建成功夸大为运行验收。',
    permissionMode: 'auto',
  },
  {
    id: 'digital_employee_template_test',
    name: '测试数字员工',
    description: '负责风险分析、验证执行与缺口报告。',
    role: '测试',
    domain: '通用',
    skillIds: [],
    prompt: '你是测试数字员工。从用户路径、边界条件与失败恢复出发执行允许的验证，清楚区分已证实、未验证和理论风险。',
    permissionMode: 'auto',
  },
  {
    id: 'digital_employee_template_deployment',
    name: '部署数字员工',
    description: '负责发布前检查与已授权部署命令的执行跟踪。',
    role: '部署',
    domain: '通用',
    skillIds: [],
    prompt: '你是部署数字员工。只使用项目已配置且明确授权的发布或部署命令；逐项核对产物、目标、版本、结果与回滚条件。',
    permissionMode: 'read-only',
  },
];

export function migrateDigitalEmployeeSchema(db: ZeusDatabasePort): void {
  const checksumSource = [
    'digital_employee_templates:v1',
    'digital_employees:v1',
    'digital_employee_automations:v1',
    'digital_employee_executions:v1',
    'digital_employee_event_receipts:v1',
    'built-ins:product,frontend,developer,test,deployment',
  ].join(';');
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [digitalEmployeeSchemaMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('数字员工迁移账本与当前结构定义不一致。');
    db.execute(`
      CREATE TABLE IF NOT EXISTS digital_employee_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        role TEXT NOT NULL,
        domain TEXT NOT NULL,
        skill_ids_json TEXT NOT NULL,
        prompt TEXT NOT NULL,
        agent_kind TEXT NOT NULL,
        model TEXT,
        reasoning_effort TEXT,
        service_tier TEXT,
        permission_mode TEXT NOT NULL,
        work_mode TEXT NOT NULL,
        built_in INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_digital_employee_templates_visible ON digital_employee_templates(deleted_at, built_in, name)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS digital_employees (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        template_id TEXT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        role TEXT NOT NULL,
        domain TEXT NOT NULL,
        skill_ids_json TEXT NOT NULL,
        prompt TEXT NOT NULL,
        agent_kind TEXT NOT NULL,
        model TEXT,
        reasoning_effort TEXT,
        service_tier TEXT,
        permission_mode TEXT NOT NULL,
        work_mode TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        auto_claim INTEGER NOT NULL DEFAULT 0,
        autonomous_exploration INTEGER NOT NULL DEFAULT 0,
        max_concurrency INTEGER NOT NULL DEFAULT 1,
        task_filter_json TEXT NOT NULL,
        allow_code_changes INTEGER NOT NULL DEFAULT 0,
        allow_tests INTEGER NOT NULL DEFAULT 0,
        allow_commit INTEGER NOT NULL DEFAULT 0,
        allow_push INTEGER NOT NULL DEFAULT 0,
        allow_merge INTEGER NOT NULL DEFAULT 0,
        allow_deploy INTEGER NOT NULL DEFAULT 0,
        allow_complete INTEGER NOT NULL DEFAULT 0,
        deploy_command_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (template_id) REFERENCES digital_employee_templates(id)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_digital_employees_project ON digital_employees(project_id, deleted_at, enabled, name)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS digital_employee_automations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_kind TEXT NOT NULL,
        trigger_config_json TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        action_config_json TEXT NOT NULL,
        next_run_at TEXT,
        cursor_sequence INTEGER NOT NULL DEFAULT 0,
        last_triggered_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (employee_id) REFERENCES digital_employees(id)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_digital_employee_automations_due ON digital_employee_automations(enabled, next_run_at, project_id) WHERE deleted_at IS NULL`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_digital_employee_automations_employee ON digital_employee_automations(employee_id, deleted_at)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS digital_employee_executions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        template_id TEXT,
        automation_id TEXT,
        source TEXT NOT NULL,
        source_ref TEXT,
        status TEXT NOT NULL,
        employee_snapshot_json TEXT NOT NULL,
        delivery_grants_snapshot_json TEXT NOT NULL,
        conversation_id TEXT,
        environment_id TEXT,
        delivery_stage TEXT NOT NULL DEFAULT 'none',
        delivery_state_json TEXT NOT NULL DEFAULT '{}',
        attempt INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
        error_message TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (employee_id) REFERENCES digital_employees(id),
        FOREIGN KEY (automation_id) REFERENCES digital_employee_automations(id)
      )
    `);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_digital_employee_execution_source ON digital_employee_executions(employee_id, source, source_ref) WHERE source_ref IS NOT NULL`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_digital_employee_execution_queue ON digital_employee_executions(status, lease_expires_at, created_at)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_digital_employee_execution_task ON digital_employee_executions(task_id, created_at)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_digital_employee_execution_project ON digital_employee_executions(project_id, created_at)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS digital_employee_event_receipts (
        automation_id TEXT NOT NULL,
        event_identity TEXT NOT NULL,
        execution_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (automation_id, event_identity),
        FOREIGN KEY (automation_id) REFERENCES digital_employee_automations(id),
        FOREIGN KEY (execution_id) REFERENCES digital_employee_executions(id)
      )
    `);

    const timestamp = new Date().toISOString();
    for (const template of builtInDigitalEmployeeTemplates) {
      const normalized = normalizeTemplateInput(template);
      db.execute(
        `INSERT OR IGNORE INTO digital_employee_templates
         (id, name, description, role, domain, skill_ids_json, prompt, agent_kind, model, reasoning_effort, service_tier, permission_mode, work_mode, built_in, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        [
          template.id,
          normalized.name,
          normalized.description,
          normalized.role,
          normalized.domain,
          JSON.stringify(normalized.skillIds),
          normalized.prompt,
          normalized.agentKind,
          normalized.model,
          normalized.reasoningEffort,
          normalized.serviceTier,
          normalized.permissionMode,
          normalized.workMode,
          timestamp,
          timestamp,
        ],
      );
      db.execute(
        `UPDATE digital_employee_templates SET name = ?, description = ?, role = ?, domain = ?, skill_ids_json = ?, prompt = ?, agent_kind = ?, model = ?, reasoning_effort = ?, service_tier = ?, permission_mode = ?, work_mode = ?, updated_at = ? WHERE id = ? AND built_in = 1`,
        [
          normalized.name,
          normalized.description,
          normalized.role,
          normalized.domain,
          JSON.stringify(normalized.skillIds),
          normalized.prompt,
          normalized.agentKind,
          normalized.model,
          normalized.reasoningEffort,
          normalized.serviceTier,
          normalized.permissionMode,
          normalized.workMode,
          timestamp,
          template.id,
        ],
      );
    }
    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      digitalEmployeeSchemaMigrationId,
      '新增数字员工模板、项目员工、自动化、执行与项目事件去重回执',
      checksum,
      timestamp,
    ]);
  });
}

export class DigitalEmployeeTemplateRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  list(): DigitalEmployeeTemplateRecord[] {
    return this.db.select<DigitalEmployeeTemplateRow>(`SELECT * FROM digital_employee_templates WHERE deleted_at IS NULL ORDER BY built_in DESC, name COLLATE NOCASE ASC, created_at ASC`).map(mapTemplateRow);
  }

  getById(id: string): DigitalEmployeeTemplateRecord | undefined {
    const row = this.db.get<DigitalEmployeeTemplateRow>(`SELECT * FROM digital_employee_templates WHERE id = ? AND deleted_at IS NULL`, [requiredIdentity(id, 'templateId')]);
    return row ? mapTemplateRow(row) : undefined;
  }

  create(input: CreateDigitalEmployeeTemplateInput): DigitalEmployeeTemplateRecord {
    const value = normalizeTemplateInput(input);
    const timestamp = new Date().toISOString();
    const id = input.id ? requiredIdentity(input.id, 'template.id') : `digital_employee_template_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO digital_employee_templates
       (id, name, description, role, domain, skill_ids_json, prompt, agent_kind, model, reasoning_effort, service_tier, permission_mode, work_mode, built_in, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [
        id,
        value.name,
        value.description,
        value.role,
        value.domain,
        JSON.stringify(value.skillIds),
        value.prompt,
        value.agentKind,
        value.model,
        value.reasoningEffort,
        value.serviceTier,
        value.permissionMode,
        value.workMode,
        timestamp,
        timestamp,
      ],
    );
    return this.getById(id)!;
  }

  update(id: string, input: UpdateDigitalEmployeeTemplateInput): DigitalEmployeeTemplateRecord {
    const existing = this.requireMutable(id);
    assertRevision(existing.revision, input.expectedRevision, '数字员工模板');
    const value = normalizeTemplateInput({ ...existing, ...input });
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(
      `UPDATE digital_employee_templates SET name = ?, description = ?, role = ?, domain = ?, skill_ids_json = ?, prompt = ?, agent_kind = ?, model = ?, reasoning_effort = ?, service_tier = ?, permission_mode = ?, work_mode = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND built_in = 0 AND deleted_at IS NULL`,
      [
        value.name,
        value.description,
        value.role,
        value.domain,
        JSON.stringify(value.skillIds),
        value.prompt,
        value.agentKind,
        value.model,
        value.reasoningEffort,
        value.serviceTier,
        value.permissionMode,
        value.workMode,
        timestamp,
        existing.id,
        existing.revision,
      ],
    );
    assertChanged(this.db, '数字员工模板已被其他操作更新。');
    return this.getById(existing.id)!;
  }

  delete(id: string, expectedRevision: number): DigitalEmployeeTemplateRecord {
    const existing = this.requireMutable(id);
    assertRevision(existing.revision, expectedRevision, '数字员工模板');
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE digital_employee_templates SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND built_in = 0 AND deleted_at IS NULL`, [
      timestamp,
      timestamp,
      existing.id,
      existing.revision,
    ]);
    assertChanged(this.db, '数字员工模板已被其他操作更新。');
    return existing;
  }

  private requireMutable(id: string): DigitalEmployeeTemplateRecord {
    const existing = this.getById(id);
    if (!existing) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_TEMPLATE_NOT_FOUND', '数字员工模板不存在。');
    if (existing.builtIn) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_BUILT_IN_IMMUTABLE', '内置数字员工模板不可直接修改；请基于它创建项目员工或自定义模板。');
    return existing;
  }
}

export class DigitalEmployeeRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  listByProject(projectId: string): DigitalEmployeeRecord[] {
    return this.db
      .select<DigitalEmployeeRow>(`SELECT * FROM digital_employees WHERE project_id = ? AND deleted_at IS NULL ORDER BY enabled DESC, name COLLATE NOCASE ASC, created_at ASC`, [requiredIdentity(projectId, 'projectId')])
      .map(mapEmployeeRow);
  }

  listEnabled(): DigitalEmployeeRecord[] {
    return this.db.select<DigitalEmployeeRow>(`SELECT * FROM digital_employees WHERE enabled = 1 AND deleted_at IS NULL ORDER BY project_id ASC, created_at ASC`).map(mapEmployeeRow);
  }

  getById(id: string): DigitalEmployeeRecord | undefined {
    const row = this.db.get<DigitalEmployeeRow>(`SELECT * FROM digital_employees WHERE id = ? AND deleted_at IS NULL`, [requiredIdentity(id, 'employeeId')]);
    return row ? mapEmployeeRow(row) : undefined;
  }

  create(input: CreateDigitalEmployeeInput): DigitalEmployeeRecord {
    const value = normalizeEmployeeInput(input);
    const timestamp = new Date().toISOString();
    const id = input.id ? requiredIdentity(input.id, 'employee.id') : `digital_employee_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO digital_employees
       (id, project_id, template_id, name, description, role, domain, skill_ids_json, prompt, agent_kind, model, reasoning_effort, service_tier, permission_mode, work_mode,
        enabled, auto_claim, autonomous_exploration, max_concurrency, task_filter_json, allow_code_changes, allow_tests,
        allow_commit, allow_push, allow_merge, allow_deploy, allow_complete, deploy_command_id, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        value.projectId,
        value.templateId,
        value.name,
        value.description,
        value.role,
        value.domain,
        JSON.stringify(value.skillIds),
        value.prompt,
        value.agentKind,
        value.model,
        value.reasoningEffort,
        value.serviceTier,
        value.permissionMode,
        value.workMode,
        bool(value.enabled),
        bool(value.autoClaim),
        bool(value.autonomousExploration),
        value.maxConcurrency,
        JSON.stringify(value.taskFilter),
        bool(value.allowCodeChanges),
        bool(value.allowTests),
        bool(value.deliveryGrants.allowCommit),
        bool(value.deliveryGrants.allowPush),
        bool(value.deliveryGrants.allowMerge),
        bool(value.deliveryGrants.allowDeploy),
        bool(value.deliveryGrants.allowComplete),
        value.deployCommandId,
        timestamp,
        timestamp,
      ],
    );
    return this.getById(id)!;
  }

  createFromTemplate(input: { projectId: string; template: DigitalEmployeeTemplateRecord; overrides?: Partial<Omit<CreateDigitalEmployeeInput, 'projectId' | 'templateId'>> }): DigitalEmployeeRecord {
    return this.create({
      projectId: input.projectId,
      templateId: input.template.id,
      name: input.template.name,
      description: input.template.description,
      role: input.template.role,
      domain: input.template.domain,
      skillIds: input.template.skillIds,
      prompt: input.template.prompt,
      agentKind: input.template.agentKind,
      model: input.template.model,
      reasoningEffort: input.template.reasoningEffort,
      serviceTier: input.template.serviceTier,
      permissionMode: input.template.permissionMode,
      workMode: input.template.workMode,
      ...input.overrides,
    });
  }

  update(id: string, input: UpdateDigitalEmployeeInput): DigitalEmployeeRecord {
    const existing = this.require(id);
    assertRevision(existing.revision, input.expectedRevision, '数字员工');
    const value = normalizeEmployeeInput({ ...existing, ...input, projectId: existing.projectId, deliveryGrants: { ...existing.deliveryGrants, ...input.deliveryGrants }, taskFilter: { ...existing.taskFilter, ...input.taskFilter } });
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(
      `UPDATE digital_employees SET template_id = ?, name = ?, description = ?, role = ?, domain = ?, skill_ids_json = ?, prompt = ?, agent_kind = ?, model = ?, reasoning_effort = ?, service_tier = ?, permission_mode = ?, work_mode = ?,
       enabled = ?, auto_claim = ?, autonomous_exploration = ?, max_concurrency = ?, task_filter_json = ?, allow_code_changes = ?, allow_tests = ?,
       allow_commit = ?, allow_push = ?, allow_merge = ?, allow_deploy = ?, allow_complete = ?, deploy_command_id = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      [
        value.templateId,
        value.name,
        value.description,
        value.role,
        value.domain,
        JSON.stringify(value.skillIds),
        value.prompt,
        value.agentKind,
        value.model,
        value.reasoningEffort,
        value.serviceTier,
        value.permissionMode,
        value.workMode,
        bool(value.enabled),
        bool(value.autoClaim),
        bool(value.autonomousExploration),
        value.maxConcurrency,
        JSON.stringify(value.taskFilter),
        bool(value.allowCodeChanges),
        bool(value.allowTests),
        bool(value.deliveryGrants.allowCommit),
        bool(value.deliveryGrants.allowPush),
        bool(value.deliveryGrants.allowMerge),
        bool(value.deliveryGrants.allowDeploy),
        bool(value.deliveryGrants.allowComplete),
        value.deployCommandId,
        timestamp,
        existing.id,
        existing.revision,
      ],
    );
    assertChanged(this.db, '数字员工已被其他操作更新。');
    return this.getById(existing.id)!;
  }

  delete(id: string, expectedRevision: number): DigitalEmployeeRecord {
    const existing = this.require(id);
    assertRevision(existing.revision, expectedRevision, '数字员工');
    if (this.countActiveExecutions(id) > 0) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_ACTIVE', '数字员工仍有运行中或待交付的工作，不能删除。');
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.transaction(() => {
      this.db.execute(`UPDATE digital_employee_automations SET enabled = 0, deleted_at = COALESCE(deleted_at, ?), updated_at = ?, revision = revision + 1 WHERE employee_id = ? AND deleted_at IS NULL`, [timestamp, timestamp, existing.id]);
      this.db.execute(`UPDATE digital_employees SET enabled = 0, deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL`, [timestamp, timestamp, existing.id, existing.revision]);
      assertChanged(this.db, '数字员工已被其他操作更新。');
    });
    return existing;
  }

  countActiveExecutions(employeeId: string): number {
    return this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM digital_employee_executions WHERE employee_id = ? AND status IN ('queued', 'dispatching', 'running', 'waiting', 'delivery_pending')`, [employeeId])?.count ?? 0;
  }

  private require(id: string): DigitalEmployeeRecord {
    const existing = this.getById(id);
    if (!existing) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_NOT_FOUND', '数字员工不存在。');
    return existing;
  }
}

export class DigitalEmployeeAutomationRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  listByProject(projectId: string): DigitalEmployeeAutomationRecord[] {
    return this.db
      .select<DigitalEmployeeAutomationRow>(`SELECT * FROM digital_employee_automations WHERE project_id = ? AND deleted_at IS NULL ORDER BY enabled DESC, created_at ASC`, [requiredIdentity(projectId, 'projectId')])
      .map(mapAutomationRow);
  }

  listEnabled(): DigitalEmployeeAutomationRecord[] {
    return this.db.select<DigitalEmployeeAutomationRow>(`SELECT * FROM digital_employee_automations WHERE enabled = 1 AND deleted_at IS NULL ORDER BY project_id ASC, created_at ASC`).map(mapAutomationRow);
  }

  getById(id: string): DigitalEmployeeAutomationRecord | undefined {
    const row = this.db.get<DigitalEmployeeAutomationRow>(`SELECT * FROM digital_employee_automations WHERE id = ? AND deleted_at IS NULL`, [requiredIdentity(id, 'automationId')]);
    return row ? mapAutomationRow(row) : undefined;
  }

  create(input: CreateDigitalEmployeeAutomationInput, options: { initialCursorSequence?: number } = {}): DigitalEmployeeAutomationRecord {
    const value = normalizeAutomationInput(input);
    const timestamp = new Date().toISOString();
    const id = input.id ? requiredIdentity(input.id, 'automation.id') : `digital_employee_automation_${nanoid(12)}`;
    const initialCursorSequence = nonNegativeInteger(options.initialCursorSequence ?? 0, 'automation.initialCursorSequence');
    this.db.execute(
      `INSERT INTO digital_employee_automations
       (id, project_id, employee_id, name, enabled, trigger_kind, trigger_config_json, action_kind, action_config_json, next_run_at, cursor_sequence, last_triggered_at, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
      [
        id,
        value.projectId,
        value.employeeId,
        value.name,
        bool(value.enabled),
        value.triggerKind,
        JSON.stringify(value.triggerConfig),
        value.actionKind,
        JSON.stringify(value.actionConfig),
        value.nextRunAt,
        initialCursorSequence,
        timestamp,
        timestamp,
      ],
    );
    return this.getById(id)!;
  }

  update(id: string, input: UpdateDigitalEmployeeAutomationInput, options: { resetCursorSequence?: number } = {}): DigitalEmployeeAutomationRecord {
    const existing = this.require(id);
    assertRevision(existing.revision, input.expectedRevision, '数字员工自动化');
    const schedulingChanged = input.triggerKind !== undefined || input.triggerConfig !== undefined;
    const value = normalizeAutomationInput({
      ...existing,
      ...input,
      projectId: existing.projectId,
      employeeId: existing.employeeId,
      nextRunAt: input.nextRunAt !== undefined ? input.nextRunAt : schedulingChanged ? undefined : existing.nextRunAt,
    });
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(
      `UPDATE digital_employee_automations SET name = ?, enabled = ?, trigger_kind = ?, trigger_config_json = ?, action_kind = ?, action_config_json = ?, next_run_at = ?, cursor_sequence = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      [
        value.name,
        bool(value.enabled),
        value.triggerKind,
        JSON.stringify(value.triggerConfig),
        value.actionKind,
        JSON.stringify(value.actionConfig),
        value.nextRunAt,
        nonNegativeInteger(options.resetCursorSequence ?? existing.cursorSequence, 'automation.cursorSequence'),
        timestamp,
        existing.id,
        existing.revision,
      ],
    );
    assertChanged(this.db, '数字员工自动化已被其他操作更新。');
    return this.getById(existing.id)!;
  }

  delete(id: string, expectedRevision: number): DigitalEmployeeAutomationRecord {
    const existing = this.require(id);
    assertRevision(existing.revision, expectedRevision, '数字员工自动化');
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE digital_employee_automations SET enabled = 0, deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL`, [
      timestamp,
      timestamp,
      existing.id,
      existing.revision,
    ]);
    assertChanged(this.db, '数字员工自动化已被其他操作更新。');
    return existing;
  }

  advance(input: { id: string; cursorSequence?: number; nextRunAt?: string | null; lastTriggeredAt: string }): DigitalEmployeeAutomationRecord {
    const existing = this.require(input.id);
    const timestamp = nextTimestamp(existing.updatedAt);
    const cursorSequence = Math.max(existing.cursorSequence, input.cursorSequence ?? existing.cursorSequence);
    this.db.execute(`UPDATE digital_employee_automations SET cursor_sequence = ?, next_run_at = ?, last_triggered_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [
      cursorSequence,
      input.nextRunAt === undefined ? existing.nextRunAt : input.nextRunAt,
      input.lastTriggeredAt,
      timestamp,
      existing.id,
    ]);
    return this.getById(existing.id)!;
  }

  recordEventReceipt(input: { automationId: string; eventIdentity: string; executionId?: string | null; createdAt: string }): boolean {
    this.db.execute(`INSERT OR IGNORE INTO digital_employee_event_receipts (automation_id, event_identity, execution_id, created_at) VALUES (?, ?, ?, ?)`, [
      input.automationId,
      requiredIdentity(input.eventIdentity, 'eventIdentity'),
      input.executionId ?? null,
      input.createdAt,
    ]);
    return (this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) === 1;
  }

  hasEventReceipt(automationId: string, eventIdentity: string): boolean {
    return Boolean(this.db.get<{ present: number }>(`SELECT 1 AS present FROM digital_employee_event_receipts WHERE automation_id = ? AND event_identity = ?`, [automationId, eventIdentity]));
  }

  private require(id: string): DigitalEmployeeAutomationRecord {
    const existing = this.getById(id);
    if (!existing) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_AUTOMATION_NOT_FOUND', '数字员工自动化不存在。');
    return existing;
  }
}

export class DigitalEmployeeExecutionRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  getById(id: string): DigitalEmployeeExecutionRecord | undefined {
    const row = this.db.get<DigitalEmployeeExecutionRow>(`SELECT * FROM digital_employee_executions WHERE id = ?`, [requiredIdentity(id, 'executionId')]);
    return row ? mapExecutionRow(row) : undefined;
  }

  getBySource(employeeId: string, source: DigitalEmployeeExecutionSource, sourceRef: string): DigitalEmployeeExecutionRecord | undefined {
    const row = this.db.get<DigitalEmployeeExecutionRow>(`SELECT * FROM digital_employee_executions WHERE employee_id = ? AND source = ? AND source_ref = ?`, [employeeId, source, sourceRef]);
    return row ? mapExecutionRow(row) : undefined;
  }

  listByProject(projectId: string, limit = 100): DigitalEmployeeExecutionRecord[] {
    return this.db
      .select<DigitalEmployeeExecutionRow>(`SELECT * FROM digital_employee_executions WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, [requiredIdentity(projectId, 'projectId'), boundedLimit(limit)])
      .map(mapExecutionRow);
  }

  listByTask(taskId: string): DigitalEmployeeExecutionRecord[] {
    return this.db.select<DigitalEmployeeExecutionRow>(`SELECT * FROM digital_employee_executions WHERE task_id = ? ORDER BY created_at DESC, id DESC`, [requiredIdentity(taskId, 'taskId')]).map(mapExecutionRow);
  }

  listRecoverable(limit = 50): DigitalEmployeeExecutionRecord[] {
    return this.db
      .select<DigitalEmployeeExecutionRow>(`SELECT * FROM digital_employee_executions WHERE status IN ('queued', 'dispatching', 'running', 'waiting', 'delivery_pending') ORDER BY created_at ASC, id ASC LIMIT ?`, [boundedLimit(limit)])
      .map(mapExecutionRow);
  }

  listActiveByEmployee(employeeId: string): DigitalEmployeeExecutionRecord[] {
    return this.db
      .select<DigitalEmployeeExecutionRow>(`SELECT * FROM digital_employee_executions WHERE employee_id = ? AND status IN ('queued', 'dispatching', 'running', 'waiting', 'delivery_pending') ORDER BY created_at ASC`, [employeeId])
      .map(mapExecutionRow);
  }

  hasActiveTaskExecution(taskId: string): boolean {
    return Boolean(this.db.get<{ present: number }>(`SELECT 1 AS present FROM digital_employee_executions WHERE task_id = ? AND status IN ('queued', 'dispatching', 'running', 'waiting', 'delivery_pending') LIMIT 1`, [taskId]));
  }

  hasTaskExecutionForEmployee(employeeId: string, taskId: string, source?: DigitalEmployeeExecutionSource): boolean {
    const sourceClause = source ? ' AND source = ?' : '';
    const params = source ? [requiredIdentity(employeeId, 'employeeId'), requiredIdentity(taskId, 'taskId'), source] : [requiredIdentity(employeeId, 'employeeId'), requiredIdentity(taskId, 'taskId')];
    return Boolean(this.db.get<{ present: number }>(`SELECT 1 AS present FROM digital_employee_executions WHERE employee_id = ? AND task_id = ?${sourceClause} LIMIT 1`, params));
  }

  create(input: CreateDigitalEmployeeExecutionInput): DigitalEmployeeExecutionRecord {
    const timestamp = new Date().toISOString();
    const source = oneOf(input.source, digitalEmployeeExecutionSources, 'execution.source');
    const sourceRef = nullableText(input.sourceRef, 512);
    if (sourceRef) {
      const replay = this.getBySource(input.employee.id, source, sourceRef);
      if (replay) return replay;
    }
    const id = input.id ? requiredIdentity(input.id, 'execution.id') : `digital_employee_execution_${nanoid(12)}`;
    const snapshot = structuredClone(input.employee);
    this.db.execute(
      `INSERT INTO digital_employee_executions
       (id, project_id, task_id, employee_id, template_id, automation_id, source, source_ref, status, employee_snapshot_json, delivery_grants_snapshot_json,
        conversation_id, environment_id, delivery_stage, delivery_state_json, attempt, error_code, error_message, lease_owner, lease_expires_at, started_at, completed_at, created_at, updated_at,
        execution_mode, workflow_id, current_stage_id, revision, finalized_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, 'none', '{}', 1, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, 1, NULL)`,
      [
        id,
        input.employee.projectId,
        requiredIdentity(input.taskId, 'taskId'),
        input.employee.id,
        input.employee.templateId,
        input.automationId ?? null,
        source,
        sourceRef,
        JSON.stringify(snapshot),
        JSON.stringify(snapshot.deliveryGrants),
        timestamp,
        timestamp,
        oneOf(input.executionMode ?? 'legacy_single_conversation', digitalEmployeeExecutionModes, 'execution.executionMode'),
        nullableIdentity(input.workflowId, 'workflowId'),
        nullableIdentity(input.currentStageId, 'currentStageId'),
      ],
    );
    return this.getById(id)!;
  }

  claim(id: string, owner: string, leaseExpiresAt: string): DigitalEmployeeExecutionRecord | null {
    const now = new Date().toISOString();
    this.db.execute(
      `UPDATE digital_employee_executions SET lease_owner = ?, lease_expires_at = ?
       WHERE id = ? AND status IN ('queued', 'dispatching', 'running', 'waiting', 'delivery_pending') AND (lease_expires_at IS NULL OR lease_expires_at < ? OR lease_owner = ?)`,
      [requiredIdentity(owner, 'leaseOwner'), validTimestamp(leaseExpiresAt, 'leaseExpiresAt'), id, now, owner],
    );
    return (this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) === 1 ? this.getById(id)! : null;
  }

  releaseLease(id: string, owner: string): void {
    this.db.execute(`UPDATE digital_employee_executions SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?`, [id, owner]);
  }

  update(
    id: string,
    input: Partial<
      Pick<
        DigitalEmployeeExecutionRecord,
        'status' | 'conversationId' | 'environmentId' | 'deliveryStage' | 'deliveryState' | 'errorCode' | 'errorMessage' | 'startedAt' | 'completedAt' | 'finalizedAt' | 'attempt' | 'workflowId' | 'currentStageId'
      >
    >,
  ): DigitalEmployeeExecutionRecord {
    const existing = this.require(id);
    const status = input.status ? oneOf(input.status, digitalEmployeeExecutionStatuses, 'execution.status') : existing.status;
    assertExecutionTransition(existing.status, status);
    const values = {
      status,
      conversationId: input.conversationId === undefined ? existing.conversationId : nullableIdentity(input.conversationId, 'conversationId'),
      environmentId: input.environmentId === undefined ? existing.environmentId : nullableIdentity(input.environmentId, 'environmentId'),
      deliveryStage: input.deliveryStage ? oneOf(input.deliveryStage, digitalEmployeeDeliveryStages, 'execution.deliveryStage') : existing.deliveryStage,
      deliveryState: input.deliveryState === undefined ? existing.deliveryState : normalizeJsonRecord(input.deliveryState, 'execution.deliveryState', 32_000),
      errorCode: input.errorCode === undefined ? existing.errorCode : nullableText(input.errorCode, 256),
      errorMessage: input.errorMessage === undefined ? existing.errorMessage : nullableText(input.errorMessage, 4_000),
      startedAt: input.startedAt === undefined ? existing.startedAt : nullableTimestamp(input.startedAt, 'startedAt'),
      completedAt: input.completedAt === undefined ? existing.completedAt : nullableTimestamp(input.completedAt, 'completedAt'),
      attempt: input.attempt === undefined ? existing.attempt : positiveInteger(input.attempt, 'attempt', 100),
      workflowId: input.workflowId === undefined ? existing.workflowId : nullableIdentity(input.workflowId, 'workflowId'),
      currentStageId: input.currentStageId === undefined ? existing.currentStageId : nullableIdentity(input.currentStageId, 'currentStageId'),
      finalizedAt: input.finalizedAt === undefined ? existing.finalizedAt : nullableTimestamp(input.finalizedAt, 'finalizedAt'),
    };
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(
      `UPDATE digital_employee_executions SET status = ?, conversation_id = ?, environment_id = ?, delivery_stage = ?, delivery_state_json = ?, attempt = ?, error_code = ?, error_message = ?, started_at = ?, completed_at = ?, workflow_id = ?, current_stage_id = ?, finalized_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      [
        values.status,
        values.conversationId,
        values.environmentId,
        values.deliveryStage,
        JSON.stringify(values.deliveryState),
        values.attempt,
        values.errorCode,
        values.errorMessage,
        values.startedAt,
        values.completedAt,
        values.workflowId,
        values.currentStageId,
        values.finalizedAt,
        timestamp,
        existing.id,
      ],
    );
    return this.getById(existing.id)!;
  }

  retry(id: string): DigitalEmployeeExecutionRecord {
    const existing = this.require(id);
    if (existing.status !== 'failed' && existing.status !== 'blocked' && existing.status !== 'cancelled') {
      throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXECUTION_NOT_RETRYABLE', '只有失败、阻塞或已取消的工作执行可以重试。');
    }
    if (existing.deliveryState.retryUnsafe === true) {
      throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_RECOVERY_REQUIRED', '该执行的外部结果未知，不能通过重试自动重发；请先核对关联会话、Git 或部署现场。');
    }
    const timestamp = nextTimestamp(existing.updatedAt);
    const retryDelivery = existing.deliveryStage !== 'none' && existing.environmentId !== null;
    const deliveryState = structuredClone(existing.deliveryState);
    delete deliveryState.retryUnsafe;
    if (existing.deliveryStage === 'deploy') {
      delete deliveryState.deployRunId;
      deliveryState.deployRunRound = typeof deliveryState.deployRunRound === 'number' ? Math.max(0, Math.trunc(deliveryState.deployRunRound)) + 1 : 1;
    }
    this.db.execute(
      `UPDATE digital_employee_executions SET status = ?, conversation_id = ?, environment_id = ?, delivery_stage = ?, delivery_state_json = ?, attempt = attempt + 1,
       error_code = NULL, error_message = NULL, lease_owner = NULL, lease_expires_at = NULL, started_at = ?, completed_at = NULL, updated_at = ? WHERE id = ?`,
      [
        retryDelivery ? 'delivery_pending' : 'queued',
        retryDelivery ? existing.conversationId : null,
        existing.environmentId,
        retryDelivery ? existing.deliveryStage : 'none',
        JSON.stringify(retryDelivery ? deliveryState : {}),
        retryDelivery ? existing.startedAt : null,
        timestamp,
        existing.id,
      ],
    );
    return this.getById(existing.id)!;
  }

  advanceStage(id: string, input: { expectedRevision: number; employee: DigitalEmployeeRecord; currentStageId: string; deliveryState?: Record<string, unknown> }): DigitalEmployeeExecutionRecord {
    const existing = this.require(id);
    if (existing.executionMode !== 'staged') throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXECUTION_TRANSITION_INVALID', '旧版单会话执行不能直接切换阶段。');
    if (existing.revision !== input.expectedRevision) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_REVISION_CONFLICT', '数字员工协作执行已更新，请刷新后重试。');
    if (existing.status !== 'waiting' && existing.status !== 'failed' && existing.status !== 'blocked') {
      throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXECUTION_ACTIVE', '只有等待确认、失败或阻塞的阶段可以创建下一次尝试。');
    }
    if (input.employee.projectId !== existing.projectId) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', '下一阶段数字员工不属于当前项目。');
    const snapshot = structuredClone(input.employee);
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(
      `UPDATE digital_employee_executions
          SET employee_id = ?, template_id = ?, employee_snapshot_json = ?, delivery_grants_snapshot_json = ?, status = 'queued', conversation_id = NULL,
              environment_id = NULL, delivery_stage = 'none', delivery_state_json = ?, attempt = attempt + 1, error_code = NULL, error_message = NULL,
              lease_owner = NULL, lease_expires_at = NULL, started_at = NULL, completed_at = NULL, current_stage_id = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?`,
      [
        snapshot.id,
        snapshot.templateId,
        JSON.stringify(snapshot),
        JSON.stringify(snapshot.deliveryGrants),
        JSON.stringify(normalizeJsonRecord(input.deliveryState ?? {}, 'execution.deliveryState', 32_000)),
        requiredIdentity(input.currentStageId, 'currentStageId'),
        timestamp,
        existing.id,
        input.expectedRevision,
      ],
    );
    assertChanged(this.db, '数字员工协作执行已更新，请刷新后重试。');
    return this.getById(existing.id)!;
  }

  finalizeStaged(id: string, expectedRevision: number): DigitalEmployeeExecutionRecord {
    const existing = this.require(id);
    if (existing.executionMode !== 'staged') throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXECUTION_TRANSITION_INVALID', '旧版单会话执行不能进入阶段化最终交付。');
    if (existing.revision !== expectedRevision) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_REVISION_CONFLICT', '数字员工协作执行已更新，请刷新后重试。');
    if (existing.status !== 'waiting') throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXECUTION_ACTIVE', '只有等待最终确认的协作执行可以进入交付。');
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(
      `UPDATE digital_employee_executions
          SET status = 'delivery_pending', delivery_stage = 'none', finalized_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'waiting'`,
      [timestamp, timestamp, existing.id, expectedRevision],
    );
    assertChanged(this.db, '数字员工协作执行已更新，请刷新后重试。');
    return this.getById(existing.id)!;
  }

  adoptLegacyAsStaged(
    id: string,
    input: { expectedRevision: number; workflowId: string; currentStageId: string; candidateDeliverableId: string; candidateDeliverableVersion: number; candidateContentSha256: string },
  ): DigitalEmployeeExecutionRecord {
    const existing = this.require(id);
    if (existing.executionMode === 'staged') return existing;
    if (existing.revision !== input.expectedRevision) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_REVISION_CONFLICT', '旧版执行已更新，请刷新后重试。');
    if (!existing.conversationId || existing.status === 'queued' || existing.status === 'dispatching' || existing.status === 'running' || existing.status === 'waiting' || existing.status === 'delivery_pending') {
      throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXECUTION_ACTIVE', '只有已结束且保留真实会话的旧版执行可以接入阶段链。');
    }
    const timestamp = nextTimestamp(existing.updatedAt);
    const deliveryState = {
      candidateDeliverableId: requiredIdentity(input.candidateDeliverableId, 'candidateDeliverableId'),
      candidateDeliverableVersion: positiveInteger(input.candidateDeliverableVersion, 'candidateDeliverableVersion', Number.MAX_SAFE_INTEGER),
      candidateStageId: requiredIdentity(input.currentStageId, 'currentStageId'),
      candidateContentSha256: boundedText(input.candidateContentSha256, 'candidateContentSha256', 64, 64),
      adoptedLegacyConversationId: existing.conversationId,
      adoptedAt: timestamp,
    };
    this.db.execute(
      `UPDATE digital_employee_executions
          SET execution_mode = 'staged', workflow_id = ?, current_stage_id = ?, status = 'waiting', delivery_stage = 'none', delivery_state_json = ?,
              error_code = NULL, error_message = NULL, finalized_at = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND execution_mode = 'legacy_single_conversation'`,
      [requiredIdentity(input.workflowId, 'workflowId'), requiredIdentity(input.currentStageId, 'currentStageId'), JSON.stringify(deliveryState), timestamp, existing.id, input.expectedRevision],
    );
    assertChanged(this.db, '旧版执行已更新，请刷新后重试。');
    return this.getById(existing.id)!;
  }

  cancel(id: string): DigitalEmployeeExecutionRecord {
    const existing = this.require(id);
    if (existing.status === 'cancelled') return existing;
    if (existing.status !== 'queued') throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXECUTION_ACTIVE', '只有仍在排队的执行可以直接取消；已开始或已结束的执行不会被静默改写。');
    return this.update(id, { status: 'cancelled', completedAt: new Date().toISOString() });
  }

  private require(id: string): DigitalEmployeeExecutionRecord {
    const existing = this.getById(id);
    if (!existing) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXECUTION_NOT_FOUND', '数字员工工作执行不存在。');
    return existing;
  }
}

export interface DigitalEmployeeProjectEvent {
  sequence: number;
  identity: string;
  projectId: string;
  taskId: string;
  kind: 'task_created' | 'task_updated' | 'task_status_changed' | 'code_changed';
  eventType: string;
  occurredAt: string;
  suppressAutomation: boolean;
}

export class DigitalEmployeeProjectEventRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  listTaskEvents(input: { projectId: string; triggerKind: Extract<DigitalEmployeeAutomationTriggerKind, 'task_created' | 'task_updated' | 'task_status_changed'>; afterSequence: number; limit?: number }): DigitalEmployeeProjectEvent[] {
    const clause = taskEventTriggerClause(input.triggerKind);
    return this.db
      .select<{ sequence: number; id: string; task_id: string; event_type: string; payload_json: string; created_at: string }>(
        `SELECT event.rowid AS sequence, event.id, event.task_id, event.event_type, event.payload_json, event.created_at
         FROM task_events event JOIN tasks task ON task.id = event.task_id
         WHERE task.project_id = ? AND event.rowid > ? AND ${clause}
         ORDER BY event.rowid ASC LIMIT ?`,
        [input.projectId, Math.max(0, Math.trunc(input.afterSequence)), boundedLimit(input.limit ?? 100)],
      )
      .map((row) => ({
        sequence: row.sequence,
        identity: `task_event:${row.id}`,
        projectId: input.projectId,
        taskId: row.task_id,
        kind: input.triggerKind,
        eventType: row.event_type,
        occurredAt: row.created_at,
        suppressAutomation: input.triggerKind === 'task_status_changed' && parseRecord(row.payload_json, 'taskEvent.payload').source === 'task_push',
      }));
  }

  listCodeEvents(input: { projectId: string; afterSequence: number; limit?: number }): DigitalEmployeeProjectEvent[] {
    return this.db
      .select<{
        sequence: number;
        id: string;
        task_id: string;
        snapshot_type: string;
        created_at: string;
      }>(`SELECT rowid AS sequence, id, task_id, snapshot_type, created_at FROM git_snapshots WHERE project_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?`, [
        input.projectId,
        Math.max(0, Math.trunc(input.afterSequence)),
        boundedLimit(input.limit ?? 100),
      ])
      .map((row) => ({
        sequence: row.sequence,
        identity: `git_snapshot:${row.id}`,
        projectId: input.projectId,
        taskId: row.task_id,
        kind: 'code_changed',
        eventType: row.snapshot_type,
        occurredAt: row.created_at,
        suppressAutomation: false,
      }));
  }

  latestSequence(projectId: string, triggerKind: Extract<DigitalEmployeeAutomationTriggerKind, 'task_created' | 'task_updated' | 'task_status_changed' | 'code_changed'>): number {
    if (triggerKind === 'code_changed') {
      return this.db.get<{ sequence: number }>(`SELECT COALESCE(MAX(rowid), 0) AS sequence FROM git_snapshots WHERE project_id = ?`, [requiredIdentity(projectId, 'projectId')])?.sequence ?? 0;
    }
    return (
      this.db.get<{ sequence: number }>(`SELECT COALESCE(MAX(event.rowid), 0) AS sequence FROM task_events event JOIN tasks task ON task.id = event.task_id WHERE task.project_id = ? AND ${taskEventTriggerClause(triggerKind)}`, [
        requiredIdentity(projectId, 'projectId'),
      ])?.sequence ?? 0
    );
  }
}

interface DigitalEmployeeTemplateRow {
  id: string;
  name: string;
  description: string;
  role: string;
  domain: string;
  skill_ids_json: string;
  prompt: string;
  agent_kind: DigitalEmployeeAgentKind;
  model: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  permission_mode: DigitalEmployeePermissionMode;
  work_mode: DigitalEmployeeWorkMode;
  built_in: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface DigitalEmployeeRow extends Omit<DigitalEmployeeTemplateRow, 'built_in'> {
  project_id: string;
  template_id: string | null;
  enabled: number;
  auto_claim: number;
  autonomous_exploration: number;
  max_concurrency: number;
  task_filter_json: string;
  allow_code_changes: number;
  allow_tests: number;
  allow_commit: number;
  allow_push: number;
  allow_merge: number;
  allow_deploy: number;
  allow_complete: number;
  deploy_command_id: string | null;
}

interface DigitalEmployeeAutomationRow {
  id: string;
  project_id: string;
  employee_id: string;
  name: string;
  enabled: number;
  trigger_kind: DigitalEmployeeAutomationTriggerKind;
  trigger_config_json: string;
  action_kind: DigitalEmployeeAutomationActionKind;
  action_config_json: string;
  next_run_at: string | null;
  cursor_sequence: number;
  last_triggered_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface DigitalEmployeeExecutionRow {
  id: string;
  project_id: string;
  task_id: string;
  employee_id: string;
  template_id: string | null;
  automation_id: string | null;
  source: DigitalEmployeeExecutionSource;
  source_ref: string | null;
  status: DigitalEmployeeExecutionStatus;
  execution_mode: DigitalEmployeeExecutionMode;
  workflow_id: string | null;
  current_stage_id: string | null;
  revision: number;
  employee_snapshot_json: string;
  delivery_grants_snapshot_json: string;
  conversation_id: string | null;
  environment_id: string | null;
  delivery_stage: DigitalEmployeeDeliveryStage;
  delivery_state_json: string;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapTemplateRow(row: DigitalEmployeeTemplateRow): DigitalEmployeeTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    role: row.role,
    domain: row.domain,
    skillIds: parseStringList(row.skill_ids_json, 'template.skillIds'),
    prompt: row.prompt,
    agentKind: oneOf(row.agent_kind, digitalEmployeeAgentKinds, 'template.agentKind'),
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    serviceTier: row.service_tier,
    permissionMode: oneOf(row.permission_mode, digitalEmployeePermissionModes, 'template.permissionMode'),
    workMode: oneOf(row.work_mode, digitalEmployeeWorkModes, 'template.workMode'),
    builtIn: row.built_in === 1,
    revision: nonNegativeInteger(row.revision, 'template.revision'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEmployeeRow(row: DigitalEmployeeRow): DigitalEmployeeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    templateId: row.template_id,
    name: row.name,
    description: row.description,
    role: row.role,
    domain: row.domain,
    skillIds: parseStringList(row.skill_ids_json, 'employee.skillIds'),
    prompt: row.prompt,
    agentKind: oneOf(row.agent_kind, digitalEmployeeAgentKinds, 'employee.agentKind'),
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    serviceTier: row.service_tier,
    permissionMode: oneOf(row.permission_mode, digitalEmployeePermissionModes, 'employee.permissionMode'),
    workMode: oneOf(row.work_mode, digitalEmployeeWorkModes, 'employee.workMode'),
    enabled: row.enabled === 1,
    autoClaim: row.auto_claim === 1,
    autonomousExploration: row.autonomous_exploration === 1,
    maxConcurrency: positiveInteger(row.max_concurrency, 'employee.maxConcurrency', 20),
    taskFilter: parseTaskFilter(row.task_filter_json),
    allowCodeChanges: row.allow_code_changes === 1,
    allowTests: row.allow_tests === 1,
    deliveryGrants: {
      allowCommit: row.allow_commit === 1,
      allowPush: row.allow_push === 1,
      allowMerge: row.allow_merge === 1,
      allowDeploy: row.allow_deploy === 1,
      allowComplete: row.allow_complete === 1,
    },
    deployCommandId: row.deploy_command_id,
    revision: nonNegativeInteger(row.revision, 'employee.revision'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAutomationRow(row: DigitalEmployeeAutomationRow): DigitalEmployeeAutomationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    employeeId: row.employee_id,
    name: row.name,
    enabled: row.enabled === 1,
    triggerKind: oneOf(row.trigger_kind, digitalEmployeeAutomationTriggerKinds, 'automation.triggerKind'),
    triggerConfig: parseRecord(row.trigger_config_json, 'automation.triggerConfig'),
    actionKind: oneOf(row.action_kind, digitalEmployeeAutomationActionKinds, 'automation.actionKind'),
    actionConfig: parseRecord(row.action_config_json, 'automation.actionConfig'),
    nextRunAt: row.next_run_at,
    cursorSequence: nonNegativeInteger(row.cursor_sequence, 'automation.cursorSequence'),
    lastTriggeredAt: row.last_triggered_at,
    revision: nonNegativeInteger(row.revision, 'automation.revision'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExecutionRow(row: DigitalEmployeeExecutionRow): DigitalEmployeeExecutionRecord {
  const employeeSnapshot = parseRecord(row.employee_snapshot_json, 'execution.employeeSnapshot') as unknown as DigitalEmployeeRecord;
  const grants = parseRecord(row.delivery_grants_snapshot_json, 'execution.deliveryGrantsSnapshot');
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    employeeId: row.employee_id,
    templateId: row.template_id,
    automationId: row.automation_id,
    source: oneOf(row.source, digitalEmployeeExecutionSources, 'execution.source'),
    sourceRef: row.source_ref,
    status: oneOf(row.status, digitalEmployeeExecutionStatuses, 'execution.status'),
    executionMode: oneOf(row.execution_mode, digitalEmployeeExecutionModes, 'execution.executionMode'),
    workflowId: row.workflow_id,
    currentStageId: row.current_stage_id,
    revision: positiveInteger(row.revision, 'execution.revision', Number.MAX_SAFE_INTEGER),
    employeeSnapshot,
    deliveryGrantsSnapshot: normalizeDeliveryGrants(grants),
    conversationId: row.conversation_id,
    environmentId: row.environment_id,
    deliveryStage: oneOf(row.delivery_stage, digitalEmployeeDeliveryStages, 'execution.deliveryStage'),
    deliveryState: parseRecord(row.delivery_state_json, 'execution.deliveryState'),
    attempt: positiveInteger(row.attempt, 'execution.attempt', 100),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    finalizedAt: row.finalized_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTemplateInput(input: CreateDigitalEmployeeTemplateInput): Required<Omit<CreateDigitalEmployeeTemplateInput, 'id'>> {
  return {
    name: boundedText(input.name, 'template.name', 1, 120),
    description: boundedText(input.description ?? '', 'template.description', 0, 1_000),
    role: boundedText(input.role, 'template.role', 1, 120),
    domain: boundedText(input.domain ?? '', 'template.domain', 0, 120),
    skillIds: normalizeDigitalEmployeeSkillIds(input.skillIds ?? []),
    prompt: boundedText(input.prompt, 'template.prompt', 1, 20_000),
    agentKind: oneOf(input.agentKind ?? 'codex', digitalEmployeeAgentKinds, 'template.agentKind'),
    model: nullableText(input.model, 256),
    reasoningEffort: nullableText(input.reasoningEffort, 64),
    serviceTier: nullableText(input.serviceTier, 64),
    permissionMode: oneOf(input.permissionMode ?? 'read-only', digitalEmployeePermissionModes, 'template.permissionMode'),
    workMode: oneOf(input.workMode ?? 'default', digitalEmployeeWorkModes, 'template.workMode'),
  };
}

function normalizeEmployeeInput(input: CreateDigitalEmployeeInput): Omit<DigitalEmployeeRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'> {
  const template = normalizeTemplateInput(input);
  const taskFilter = normalizeTaskFilter(input.taskFilter ?? {});
  const deliveryGrants = normalizeDeliveryGrants(input.deliveryGrants ?? {});
  const deployCommandId = nullableIdentity(input.deployCommandId, 'deployCommandId');
  if (deliveryGrants.allowDeploy && !deployCommandId) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_DEPLOY_COMMAND_REQUIRED', '开启自动部署时必须选择项目命令中心里的部署命令。');
  if (deliveryGrants.allowPush && !deliveryGrants.allowCommit) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_GRANT_INVALID', '自动推送必须同时授权自动提交。');
  if (deliveryGrants.allowMerge && !deliveryGrants.allowCommit) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_GRANT_INVALID', '自动合入必须同时授权自动提交。');
  return {
    projectId: requiredIdentity(input.projectId, 'projectId'),
    templateId: nullableIdentity(input.templateId, 'templateId'),
    ...template,
    enabled: input.enabled !== false,
    autoClaim: input.autoClaim === true,
    autonomousExploration: input.autonomousExploration === true,
    maxConcurrency: positiveInteger(input.maxConcurrency ?? 1, 'employee.maxConcurrency', 20),
    taskFilter,
    allowCodeChanges: input.allowCodeChanges === true,
    allowTests: input.allowTests === true,
    deliveryGrants,
    deployCommandId,
  };
}

function normalizeAutomationInput(input: CreateDigitalEmployeeAutomationInput): Omit<DigitalEmployeeAutomationRecord, 'id' | 'cursorSequence' | 'lastTriggeredAt' | 'revision' | 'createdAt' | 'updatedAt'> {
  const triggerKind = oneOf(input.triggerKind, digitalEmployeeAutomationTriggerKinds, 'automation.triggerKind');
  const triggerConfig = normalizeJsonRecord(input.triggerConfig ?? {}, 'automation.triggerConfig', 16_000);
  const actionKind = oneOf(input.actionKind, digitalEmployeeAutomationActionKinds, 'automation.actionKind');
  const actionConfig = normalizeJsonRecord(input.actionConfig ?? {}, 'automation.actionConfig', 32_000);
  validateAutomationConfig(triggerKind, triggerConfig, actionKind, actionConfig);
  return {
    projectId: requiredIdentity(input.projectId, 'projectId'),
    employeeId: requiredIdentity(input.employeeId, 'employeeId'),
    name: boundedText(input.name, 'automation.name', 1, 120),
    enabled: input.enabled !== false,
    triggerKind,
    triggerConfig,
    actionKind,
    actionConfig,
    nextRunAt: normalizeNextRunAt(triggerKind, input.nextRunAt, triggerConfig),
  };
}

function validateAutomationConfig(triggerKind: DigitalEmployeeAutomationTriggerKind, triggerConfig: Record<string, unknown>, actionKind: DigitalEmployeeAutomationActionKind, actionConfig: Record<string, unknown>): void {
  if (triggerKind === 'interval') positiveInteger(triggerConfig.intervalMinutes, 'automation.triggerConfig.intervalMinutes', 43_200);
  if (triggerKind === 'weekly') {
    const weekday = nonNegativeInteger(triggerConfig.weekday, 'automation.triggerConfig.weekday');
    if (weekday > 6) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_AUTOMATION_INVALID', '每周自动化的 weekday 必须为 0 到 6。');
  }
  if (triggerKind === 'daily' || triggerKind === 'weekly') {
    const hour = nonNegativeInteger(triggerConfig.hour ?? 9, 'automation.triggerConfig.hour');
    const minute = nonNegativeInteger(triggerConfig.minute ?? 0, 'automation.triggerConfig.minute');
    if (hour > 23 || minute > 59) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_AUTOMATION_INVALID', '每日或每周自动化的时间无效。');
  }
  if (actionKind === 'assign_task') {
    if (actionConfig.taskId !== undefined) boundedText(actionConfig.taskId, 'automation.actionConfig.taskId', 1, 256);
    if (actionConfig.useEventTask !== undefined && typeof actionConfig.useEventTask !== 'boolean') {
      throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_AUTOMATION_INVALID', 'automation.actionConfig.useEventTask 必须是布尔值。');
    }
  }
  if (actionKind === 'create_and_assign_task') {
    boundedText(actionConfig.title, 'automation.actionConfig.title', 1, 200);
    boundedText(actionConfig.description, 'automation.actionConfig.description', 1, 20_000);
  }
  if (actionKind === 'explore_project' && triggerKind === 'immediate') {
    // immediate 只执行一次；持久游标防止重启后无限创建探索任务。
    return;
  }
}

function normalizeNextRunAt(triggerKind: DigitalEmployeeAutomationTriggerKind, explicit: string | null | undefined, triggerConfig: Record<string, unknown>): string | null {
  if (explicit !== undefined) return nullableTimestamp(explicit, 'automation.nextRunAt');
  if (triggerKind === 'once') return validTimestamp(triggerConfig.runAt, 'automation.triggerConfig.runAt');
  if (triggerKind === 'immediate') return new Date().toISOString();
  if (triggerKind === 'daily' || triggerKind === 'weekly' || triggerKind === 'interval') return initialScheduledRun(triggerKind, triggerConfig, new Date());
  return null;
}

function initialScheduledRun(triggerKind: Extract<DigitalEmployeeAutomationTriggerKind, 'daily' | 'weekly' | 'interval'>, config: Record<string, unknown>, from: Date): string {
  if (triggerKind === 'interval') {
    const minutes = positiveInteger(config.intervalMinutes, 'automation.triggerConfig.intervalMinutes', 43_200);
    return new Date(from.getTime() + minutes * 60_000).toISOString();
  }
  const hour = nonNegativeInteger(config.hour ?? 9, 'automation.triggerConfig.hour');
  const minute = nonNegativeInteger(config.minute ?? 0, 'automation.triggerConfig.minute');
  const candidate = new Date(from);
  candidate.setHours(hour, minute, 0, 0);
  if (triggerKind === 'daily') {
    if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate.toISOString();
  }
  const weekday = nonNegativeInteger(config.weekday, 'automation.triggerConfig.weekday');
  const dayDelta = (weekday - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + dayDelta);
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 7);
  return candidate.toISOString();
}

function taskEventTriggerClause(triggerKind: Extract<DigitalEmployeeAutomationTriggerKind, 'task_created' | 'task_updated' | 'task_status_changed'>): string {
  if (triggerKind === 'task_created') return `event.event_type = 'task.created'`;
  if (triggerKind === 'task_updated') return `event.event_type IN ('task.updated', 'task.tags.updated', 'task.relationships.updated')`;
  return `event.event_type IN ('task.status.changed', 'task.management_status.changed')`;
}

function normalizeTaskFilter(input: Partial<DigitalEmployeeTaskFilter>): DigitalEmployeeTaskFilter {
  return {
    managementStatuses: normalizeStringList(input.managementStatuses ?? [], 'taskFilter.managementStatuses', 50, 80),
    taskTypes: normalizeStringList(input.taskTypes ?? [], 'taskFilter.taskTypes', 50, 80),
    requiredTags: normalizeStringList(input.requiredTags ?? [], 'taskFilter.requiredTags', 50, 120),
  };
}

function normalizeDeliveryGrants(input: Partial<DigitalEmployeeDeliveryGrants> | Record<string, unknown>): DigitalEmployeeDeliveryGrants {
  return {
    allowCommit: input.allowCommit === true,
    allowPush: input.allowPush === true,
    allowMerge: input.allowMerge === true,
    allowDeploy: input.allowDeploy === true,
    allowComplete: input.allowComplete === true,
  };
}

function parseTaskFilter(value: string): DigitalEmployeeTaskFilter {
  return normalizeTaskFilter(parseRecord(value, 'employee.taskFilter'));
}

function normalizeJsonRecord(value: Record<string, unknown>, field: string, maximumBytes: number): Record<string, unknown> {
  if (!isPlainRecord(value)) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', `${field} 必须是对象。`);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', `${field} 必须是可序列化 JSON。`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', `${field} 超出大小限制。`);
  return JSON.parse(serialized) as Record<string, unknown>;
}

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isPlainRecord(parsed)) throw new Error('not record');
    return parsed;
  } catch (error) {
    throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_CORRUPT', `${field} 的持久化 JSON 无法解析。`, error);
  }
}

function parseStringList(value: string, field: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('not array');
    return normalizeStringList(parsed, field, 100, 256);
  } catch (error) {
    throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_CORRUPT', `${field} 的持久化 JSON 无法解析。`, error);
  }
}

function normalizeStringList(value: unknown[], field: string, maximumItems: number, maximumLength: number): string[] {
  if (value.length > maximumItems) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', `${field} 项目过多。`);
  const normalized = value.map((entry) => boundedText(entry, field, 1, maximumLength));
  return [...new Set(normalized)];
}

function normalizeDigitalEmployeeSkillIds(value: unknown[]): string[] {
  const skillIds = normalizeStringList(value, 'template.skillIds', 1, 32);
  if (skillIds.some((skillId) => !/^[a-f0-9]{32}$/u.test(skillId))) {
    throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_SKILL_INVALID', '数字员工必须从 Zeus Skill 目录选择默认 Skill。');
  }
  return skillIds;
}

const executionTransitions: Record<DigitalEmployeeExecutionStatus, readonly DigitalEmployeeExecutionStatus[]> = {
  queued: ['queued', 'dispatching', 'cancelled', 'failed', 'blocked'],
  dispatching: ['dispatching', 'running', 'waiting', 'failed', 'blocked'],
  running: ['running', 'waiting', 'delivery_pending', 'failed', 'blocked'],
  waiting: ['waiting', 'running', 'delivery_pending', 'failed', 'blocked'],
  delivery_pending: ['delivery_pending', 'delivered', 'failed', 'blocked'],
  delivered: ['delivered'],
  blocked: ['blocked', 'queued'],
  failed: ['failed', 'queued'],
  cancelled: ['cancelled', 'queued'],
};

function assertExecutionTransition(from: DigitalEmployeeExecutionStatus, to: DigitalEmployeeExecutionStatus): void {
  if (!executionTransitions[from].includes(to)) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXECUTION_TRANSITION_INVALID', `数字员工执行不能从 ${from} 变为 ${to}。`);
}

function assertRevision(actual: number, expected: number, label: string): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || actual !== expected) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_REVISION_CONFLICT', `${label}已被其他操作更新，请刷新后重试。`);
}

function assertChanged(db: ZeusDatabasePort, message: string): void {
  if ((db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) !== 1) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_REVISION_CONFLICT', message);
}

function requiredIdentity(value: unknown, field: string): string {
  return boundedText(value, field, 1, 256);
}

function nullableIdentity(value: unknown, field: string): string | null {
  return value === null || value === undefined || value === '' ? null : requiredIdentity(value, field);
}

function boundedText(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', `${field} 必须是字符串。`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', `${field} 长度必须在 ${minimum} 到 ${maximum} 之间。`);
  return normalized;
}

function nullableText(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return boundedText(value, 'nullableText', 1, maximum);
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T, field: string): T[number] {
  if (typeof value !== 'string' || !choices.includes(value as T[number])) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', `${field} 的值无效。`);
  return value as T[number];
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', `${field} 必须是非负整数。`);
  return value;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', `${field} 必须是 1 到 ${maximum} 的整数。`);
  return value;
}

function boundedLimit(value: number): number {
  return Math.max(1, Math.min(500, Math.trunc(value)));
}

function validTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', `${field} 必须是有效时间。`);
  return new Date(value).toISOString();
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null || value === undefined || value === '' ? null : validTimestamp(value, field);
}

function nextTimestamp(previous: string): string {
  const now = Date.now();
  return new Date(Math.max(now, Date.parse(previous) + 1)).toISOString();
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DigitalEmployeeStoreError extends Error {
  readonly name = 'DigitalEmployeeStoreError';
  readonly statusCode: number;

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown; statusCode?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.statusCode = options?.statusCode ?? (code.endsWith('_NOT_FOUND') ? 404 : code.includes('CONFLICT') || code.includes('ACTIVE') || code.includes('TRANSITION') ? 409 : 400);
  }
}

function employeeStoreError(code: string, message: string, cause?: unknown): DigitalEmployeeStoreError {
  return new DigitalEmployeeStoreError(code, message, cause === undefined ? undefined : { cause });
}
