import { createHash } from 'node:crypto';
import { automationEventStatusId, digitalEmployeeAvatarIds, type DigitalEmployeeAvatarId, resolveEmployeeConfiguration } from '@zeus/shared';
import { migrateDigitalEmployeeIdentity } from './digitalEmployeeIdentityMigration.js';
import { randomId } from './randomId.js';
import type { ZeusDatabasePort } from './databasePort.js';

export const digitalEmployeeSchemaMigrationId = '20260825_0001_digital_employees_v1';

export const digitalEmployeeAgentKinds = ['codex', 'pi'] as const;
export const digitalEmployeePermissionModes = ['read-only', 'auto', 'full-access'] as const;
export const digitalEmployeeWorkModes = ['default', 'plan'] as const;
export const digitalEmployeeAutomationTriggerKinds = ['immediate', 'once', 'daily', 'weekly', 'interval', 'task_created', 'task_updated', 'task_status_changed', 'code_changed'] as const;
export const digitalEmployeeAutomationActionKinds = ['assign_task', 'create_and_assign_task', 'explore_project'] as const;
export const digitalEmployeeExecutionStatuses = ['queued', 'dispatching', 'running', 'waiting', 'delivery_pending', 'delivered', 'blocked', 'failed', 'cancelled'] as const;

/** 判断指定任务是否仍会阻止删除数字员工。 */
export type DigitalEmployeeTaskBlocksDeletion = (taskId: string) => boolean;
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

export interface ModelPolicyV1 {
  defaultMode: 'project' | 'explicit';
  defaultModel: string | null;
  allowedModels: string[];
  allowedReasoningEfforts: string[];
  allowedServiceTiers: string[];
}

export interface SkillPolicyV1 {
  allowedSkillIds: string[];
}

export interface AuthorityPolicyV1 {
  permissionMode: DigitalEmployeePermissionMode;
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowCommit: boolean;
  allowPush: boolean;
  allowMerge: boolean;
  allowDeploy: boolean;
  allowComplete: boolean;
}

export interface AgentEntrypointV2 {
  kind: 'agent';
  prompt: string;
  agentKind: DigitalEmployeeAgentKind;
  modelPolicy: ModelPolicyV1;
  skillPolicy: SkillPolicyV1;
  authorityPolicy: AuthorityPolicyV1;
}

export type DigitalEmployeeEntrypointMigrationState = 'ready' | 'requires_selection' | 'requires_configuration';

export interface DigitalEmployeeDeliveryGrants {
  allowCommit: boolean;
  allowPush: boolean;
  allowMerge: boolean;
  allowDeploy: boolean;
  allowComplete: boolean;
}

export interface DigitalEmployeeTemplateRecord {
  /** 内置记录是创建模板；用户创建记录是可跨项目复用的员工身份。 */
  identityKind?: 'template' | 'employee';
  /** 员工默认的个人经验读取偏好。 */
  memoryEnabled?: boolean;
  /** 历史默认值仅供旧记录读取，新工作由任务授权决定。 */
  allowCodeChanges?: boolean;
  /** 历史验证默认值，不再参与员工配置继承。 */
  allowTests?: boolean;
  /** 历史交付默认值，新工作不从员工获得交付授权。 */
  deliveryGrants?: DigitalEmployeeDeliveryGrants;
  id: string;
  name: string;
  description: string;
  role: string;
  domain: string;
  /** 未选择时按岗位使用默认头像。 */
  avatarId?: DigitalEmployeeAvatarId | null;
  /** 可用 Zeus Skill 的稳定身份集合；每次运行另行冻结内容与资源快照。 */
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
  /** 跨项目复用的员工身份；历史仅项目员工保留为空。 */
  globalEmployeeId?: string | null;
  /** 是否在新工作中读取经过治理的个人经验。 */
  memoryEnabled?: boolean;
  projectId: string;
  templateId: string | null;
  /** 可用性统一来自全局身份，历史项目停启值不再参与新工作。 */
  enabled: boolean;
  autoClaim: boolean;
  autonomousExploration: boolean;
  maxConcurrency: number;
  taskFilter: DigitalEmployeeTaskFilter;
  /** 历史员工与执行快照中的源码授权，不作为新工作权限上限。 */
  allowCodeChanges: boolean;
  /** 历史员工与执行快照中的验证授权。 */
  allowTests: boolean;
  /** 仅为历史交付记录保留，当前员工配置不再写入。 */
  deliveryGrants: DigitalEmployeeDeliveryGrants;
  /** 历史执行使用的部署命令，新员工不可配置。 */
  deployCommandId: string | null;
  /** 当前数字员工始终使用 Agent；null 仅供读取损坏或未完成的旧快照时防御。 */
  entrypoint: AgentEntrypointV2 | null;
  entrypointMigrationState: DigitalEmployeeEntrypointMigrationState;
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
  /** 默认执行后端；未指定时使用 Codex。 */
  agentKind?: DigitalEmployeeAgentKind;
  /** 稳定模型身份；空值继承项目默认。 */
  model?: string | null;
  /** 默认推理级别；空值使用模型默认。 */
  reasoningEffort?: string | null;
  /** 默认是否读取已确认经验。 */
  memoryEnabled?: boolean;
  id?: string;
  name: string;
  description?: string;
  role: string;
  domain?: string;
  /** 预置头像的稳定身份。 */
  avatarId?: DigitalEmployeeAvatarId | null;
  prompt: string;
}

export type UpdateDigitalEmployeeTemplateInput = Partial<Omit<CreateDigitalEmployeeTemplateInput, 'id'>> & { expectedRevision: number };

export interface CreateDigitalEmployeeInput extends Omit<CreateDigitalEmployeeTemplateInput, 'id'> {
  /** 新绑定引用已创建的全局员工，不允许引用内置模板。 */
  globalEmployeeId?: string | null;
  /** 新工作是否读取员工个人经验。 */
  memoryEnabled?: boolean;
  id?: string;
  projectId: string;
  templateId?: string | null;
}

/** 项目写入仅允许关联已有全局员工，不接受独立职责或经验配置。 */
export type UpdateDigitalEmployeeInput = { globalEmployeeId?: string; expectedRevision: number };

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
    id: 'digital_employee_template_cto',
    name: 'CTO 数字员工',
    description: '负责研发计划、权限边界、集成取舍与最终汇总。',
    role: 'CTO',
    domain: '研发管理',
    prompt: '你是 CTO 数字员工。先核对任务事实、代码基线与授权边界，再提交按流程节点绑定的结构化计划；执行结束后只基于已核验成果和命令证据做汇总。',
  },
  {
    id: 'digital_employee_template_product',
    name: '产品数字员工',
    description: '分析需求、业务规则、取舍与验收标准。',
    role: '产品',
    domain: '通用',
    prompt: '你是产品数字员工。先核对需求来源和真实产品语义，再给出边界、取舍、验收标准与可执行任务。所有建议必须说明优缺点。',
  },
  {
    id: 'digital_employee_template_frontend',
    name: '前端数字员工',
    description: '负责前端交互、实现与真实界面验收。',
    role: '前端',
    domain: '通用',
    prompt: '你是前端数字员工。基于现有设计系统完成最小范围实现，并以真实渲染、交互与可访问性证据验收。',
  },
  {
    id: 'digital_employee_template_developer',
    name: '开发数字员工',
    description: '负责代码调查、实现、静态验证与交付说明。',
    role: '开发',
    domain: '通用',
    prompt: '你是开发数字员工。先确认代码现场与边界，再实施最小且完整的修改；保留可审计证据，不把构建成功夸大为运行验收。',
  },
  {
    id: 'digital_employee_template_test',
    name: '测试数字员工',
    description: '负责风险分析、验证执行与缺口报告。',
    role: '测试',
    domain: '通用',
    prompt: '你是测试数字员工。从用户路径、边界条件与失败恢复出发执行允许的验证，清楚区分已证实、未验证和理论风险。',
  },
  {
    id: 'digital_employee_template_deployment',
    name: '部署数字员工',
    description: '负责发布前检查与已授权部署命令的执行跟踪。',
    role: '部署',
    domain: '通用',
    prompt: '你是部署数字员工。只使用项目已配置且明确授权的发布或部署命令；逐项核对产物、目标、版本、结果与回滚条件。',
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

    // 增量扩展不改写原迁移校验；重复启动保留用户选择的头像。
    for (const table of ['digital_employee_templates', 'digital_employees']) {
      /** 结构检查覆盖已有数据库与首次创建。 */
      const columns = db.select<{ name: string }>(`PRAGMA table_info(${table})`);
      if (!columns.some((column) => column.name === 'avatar_id')) db.execute(`ALTER TABLE ${table} ADD COLUMN avatar_id TEXT`);
    }
    /** 新字段单独登记，保留已有迁移校验与用户头像数据。 */
    db.execute('INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      '20260909_digital_employee_portraits',
      '数字员工模板和项目员工增加预置头像',
      `sha256:${createHash('sha256').update('digital_employee_templates:avatar_id:text;digital_employees:avatar_id:text').digest('hex')}`,
      new Date().toISOString(),
    ]);
    /** CTO 作为研发流程的默认规划与汇总角色，独立登记且不改写旧迁移。 */
    db.execute('INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      '20260915_digital_employee_cto_template',
      '数字团队研发流程增加 CTO 内置角色',
      `sha256:${createHash('sha256').update('digital_employee_template_cto:read-only').digest('hex')}`,
      new Date().toISOString(),
    ]);
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
  migrateDigitalEmployeeIdentity(db);
}

/** 管理内置创建模板和用户已经创建的全局员工，保留原目录接口。 */
export class DigitalEmployeeTemplateRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  /** 目录只展示创建模板与用户创建的员工；迁出的旧项目身份仅供历史引用读取。 */
  list(): DigitalEmployeeTemplateRecord[] {
    return this.db
      .select<DigitalEmployeeTemplateRow>(
        `SELECT template.* FROM digital_employee_templates template
         WHERE template.deleted_at IS NULL
           AND template.id NOT IN (SELECT migrated_memory_global_id FROM digital_employees WHERE migrated_memory_global_id IS NOT NULL)
         ORDER BY template.built_in DESC, template.name COLLATE NOCASE ASC, template.created_at ASC`,
      )
      .map(mapTemplateRow);
  }

  getById(id: string): DigitalEmployeeTemplateRecord | undefined {
    const row = this.db.get<DigitalEmployeeTemplateRow>(`SELECT * FROM digital_employee_templates WHERE id = ? AND deleted_at IS NULL`, [requiredIdentity(id, 'templateId')]);
    return row ? mapTemplateRow(row) : undefined;
  }

  create(input: CreateDigitalEmployeeTemplateInput): DigitalEmployeeTemplateRecord {
    const value = normalizeTemplateInput(input);
    const timestamp = new Date().toISOString();
    const id = input.id ? requiredIdentity(input.id, 'template.id') : `digital_employee_template_${randomId(12)}`;
    this.db.execute(
      `INSERT INTO digital_employee_templates
       (id, name, description, role, domain, avatar_id, skill_ids_json, prompt, agent_kind, model, reasoning_effort, service_tier, permission_mode, work_mode, built_in, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [
        id,
        value.name,
        value.description,
        value.role,
        value.domain,
        value.avatarId ?? null,
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
    this.db.execute('UPDATE digital_employee_templates SET base_configuration_json = ? WHERE id = ?', [JSON.stringify(globalEmployeeDefaults(value)), id]);
    return this.getById(id)!;
  }

  update(id: string, input: UpdateDigitalEmployeeTemplateInput): DigitalEmployeeTemplateRecord {
    /** 内置模板只开放头像，工作配置和删除规则保持只读。 */
    const candidate = this.getById(id);
    if (candidate?.builtIn && Object.keys(input).every((key) => key === 'avatarId' || key === 'expectedRevision') && input.avatarId !== undefined) {
      assertRevision(candidate.revision, input.expectedRevision, '数字员工模板');
      /** 在写入边界校验头像，禁止注入文件路径。 */
      const avatarId = input.avatarId === null ? null : oneOf(input.avatarId, digitalEmployeeAvatarIds, 'template.avatarId');
      this.db.execute('UPDATE digital_employee_templates SET avatar_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL', [
        avatarId,
        nextTimestamp(candidate.updatedAt),
        candidate.id,
        candidate.revision,
      ]);
      assertChanged(this.db, '数字员工模板已被其他操作更新。');
      return this.getById(candidate.id)!;
    }
    const existing = this.requireMutable(id);
    assertRevision(existing.revision, input.expectedRevision, '数字员工模板');
    const value = normalizeTemplateInput({ ...existing, ...input });
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(
      `UPDATE digital_employee_templates SET name = ?, description = ?, role = ?, domain = ?, avatar_id = ?, prompt = ?, agent_kind = ?, model = ?, reasoning_effort = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND built_in = 0 AND deleted_at IS NULL`,
      [value.name, value.description, value.role, value.domain, value.avatarId ?? null, value.prompt, value.agentKind, value.model, value.reasoningEffort, timestamp, existing.id, existing.revision],
    );
    assertChanged(this.db, '数字员工模板已被其他操作更新。');
    this.db.execute('UPDATE digital_employee_templates SET base_configuration_json = ? WHERE id = ?', [JSON.stringify(globalEmployeeDefaults(value)), existing.id]);
    return this.getById(existing.id)!;
  }

  /** 删除员工并停用闲置项目关联；默认保守保护活动工作，历史快照继续保留。 */
  delete(id: string, expectedRevision: number, taskBlocksDeletion: DigitalEmployeeTaskBlocksDeletion = () => true): DigitalEmployeeTemplateRecord {
    const existing = this.requireMutable(id);
    assertRevision(existing.revision, expectedRevision, '数字员工模板');
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.transaction(() => {
      /** 复用项目关联的活动工作保护与自动化停用逻辑，任何失败均回滚整个删除。 */
      const employees = new DigitalEmployeeRepository(this.db);
      /** 只处理该准确身份的有效关联，不按姓名清理其他员工。 */
      const bindings = this.db.select<{ id: string; revision: number }>('SELECT id, revision FROM digital_employees WHERE global_employee_id = ? AND deleted_at IS NULL ORDER BY id', [existing.id]);
      for (const binding of bindings) employees.delete(binding.id, binding.revision, taskBlocksDeletion);
      this.db.execute(`UPDATE digital_employee_templates SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND built_in = 0 AND deleted_at IS NULL`, [
        timestamp,
        timestamp,
        existing.id,
        existing.revision,
      ]);
      assertChanged(this.db, '数字员工模板已被其他操作更新。');
    });
    return existing;
  }

  private requireMutable(id: string): DigitalEmployeeTemplateRecord {
    const existing = this.getById(id);
    if (!existing) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_TEMPLATE_NOT_FOUND', '数字员工模板不存在。');
    if (existing.builtIn) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_BUILT_IN_IMMUTABLE', '内置数字员工模板不可直接修改；请基于它创建项目员工或自定义模板。');
    return existing;
  }
}

/** 项目员工保留稳定绑定 ID，读取时统一解析当前全局默认与项目差异。 */
export class DigitalEmployeeRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  listByProject(projectId: string): DigitalEmployeeRecord[] {
    return this.db
      .select<DigitalEmployeeRow>(`SELECT * FROM digital_employees WHERE project_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC, created_at ASC`, [requiredIdentity(projectId, 'projectId')])
      .map((row) => this.resolveRow(row));
  }

  listEnabled(): DigitalEmployeeRecord[] {
    return this.db.select<DigitalEmployeeRow>(`SELECT * FROM digital_employees WHERE deleted_at IS NULL ORDER BY project_id ASC, created_at ASC`).map((row) => this.resolveRow(row));
  }

  getById(id: string): DigitalEmployeeRecord | undefined {
    const row = this.db.get<DigitalEmployeeRow>(`SELECT * FROM digital_employees WHERE id = ? AND deleted_at IS NULL`, [requiredIdentity(id, 'employeeId')]);
    return row ? this.resolveRow(row) : undefined;
  }

  /** 通过跨项目身份找到本项目绑定，不按姓名猜测或合并员工。 */
  getByGlobalEmployee(projectId: string, globalEmployeeId: string): DigitalEmployeeRecord | undefined {
    /** 只检索本项目仍然有效的绑定。 */
    const row = this.db.get<DigitalEmployeeRow>('SELECT * FROM digital_employees WHERE project_id = ? AND global_employee_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1', [
      requiredIdentity(projectId, 'projectId'),
      requiredIdentity(globalEmployeeId, 'globalEmployeeId'),
    ]);
    return row ? this.resolveRow(row) : undefined;
  }

  /** 只读解析本项目绑定或跨项目员工身份，禁止读取其他项目的专用配置。 */
  resolveProjectEmployee(projectId: string, employeeId: string): DigitalEmployeeRecord | undefined {
    /** 已明确属于当前项目的历史绑定优先。 */
    const binding = this.getById(employeeId);
    if (binding) return binding.projectId === projectId ? binding : undefined;
    return this.getByGlobalEmployee(projectId, employeeId);
  }

  /** 目录和预览可选择尚未绑定的正式员工，不因读取而创建项目记录。 */
  previewProjectEmployee(projectId: string, employeeId: string): DigitalEmployeeRecord | undefined {
    /** 精确项目身份先解析；外项目绑定不能转成当前项目员工。 */
    const binding = this.getById(employeeId);
    if (binding) return binding.projectId === projectId ? binding : undefined;
    /** 已有绑定保留关联身份，配置统一读取全局员工。 */
    const existing = this.getByGlobalEmployee(projectId, employeeId);
    if (existing) return existing;
    /** 未绑定时只读取正式全局员工，不混入其他项目配置或内置模板。 */
    const global = new DigitalEmployeeTemplateRepository(this.db).getById(employeeId);
    if (!global || global.builtIn) return undefined;
    return {
      ...normalizeEmployeeInput({ ...global, projectId, templateId: global.id, globalEmployeeId: global.id }),
      id: global.id,
      revision: global.revision,
      createdAt: global.createdAt,
      updatedAt: global.updatedAt,
    };
  }

  /** 工作接纳时显式建立项目绑定，重复接纳沿用原绑定身份。 */
  ensureProjectEmployee(projectId: string, employeeId: string): DigitalEmployeeRecord {
    /** 查找已经存在的本项目配置。 */
    const existing = this.resolveProjectEmployee(projectId, employeeId);
    if (existing) return existing;
    /** 全局员工与模板严格区分，不按姓名创建或匹配。 */
    const global = new DigitalEmployeeTemplateRepository(this.db).getById(employeeId);
    if (!global || global.builtIn) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_GLOBAL_UNAVAILABLE', '员工未绑定到当前项目，且没有可绑定的全局员工身份。');
    return this.createFromTemplate({ projectId, template: global });
  }

  /** 所有调用方共用此解析结果；已运行工作继续使用存储的 employeeSnapshot。 */
  private resolveRow(row: DigitalEmployeeRow): DigitalEmployeeRecord {
    /** 保留历史绑定的配置与身份。 */
    const binding = mapEmployeeRow(row);
    /** 全局模板不具备可指派员工身份。 */
    const global = binding.globalEmployeeId ? new DigitalEmployeeTemplateRepository(this.db).getById(binding.globalEmployeeId) : undefined;
    if (binding.globalEmployeeId && (!global || global.builtIn)) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_GLOBAL_UNAVAILABLE', '关联的全局员工不可用，请重新绑定员工。');
    /** 模型、Skill 和权限从同一份有效配置重建，不保留相互冲突的入口副本。 */
    const effective = resolveEmployeeConfiguration(global, binding);
    effective.entrypointMigrationState = 'ready';
    effective.entrypoint = {
      kind: 'agent',
      prompt: effective.prompt,
      agentKind: effective.agentKind,
      modelPolicy: defaultModelPolicy(effective),
      skillPolicy: { allowedSkillIds: effective.skillIds },
      authorityPolicy: defaultAuthorityPolicy(effective),
    };
    return effective;
  }

  create(input: CreateDigitalEmployeeInput): DigitalEmployeeRecord {
    const value = normalizeEmployeeInput(input);
    /** 新绑定只能引用用户已经创建的全局员工。 */
    const global = value.globalEmployeeId ? new DigitalEmployeeTemplateRepository(this.db).getById(value.globalEmployeeId) : undefined;
    if (value.globalEmployeeId && (!global || global.builtIn)) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_GLOBAL_UNAVAILABLE', '请选择已经创建的全局数字员工，不能直接指派内置模板。');
    const timestamp = new Date().toISOString();
    const id = input.id ? requiredIdentity(input.id, 'employee.id') : `digital_employee_${randomId(12)}`;
    this.db.execute(
      `INSERT INTO digital_employees
       (id, project_id, template_id, name, description, role, domain, avatar_id, skill_ids_json, prompt, agent_kind, model, reasoning_effort, service_tier, permission_mode, work_mode,
        enabled, auto_claim, autonomous_exploration, max_concurrency, task_filter_json, allow_code_changes, allow_tests,
        allow_commit, allow_push, allow_merge, allow_deploy, allow_complete, deploy_command_id, revision, created_at, updated_at,
        entrypoint_kind, entrypoint_migration_state, model_policy_json, skill_policy_json, authority_policy_json, command_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        value.projectId,
        value.templateId,
        value.name,
        value.description,
        value.role,
        value.domain,
        value.avatarId ?? null,
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
        value.entrypoint?.kind ?? null,
        value.entrypointMigrationState,
        JSON.stringify(value.entrypoint?.kind === 'agent' ? value.entrypoint.modelPolicy : defaultModelPolicy(value)),
        JSON.stringify(value.entrypoint?.kind === 'agent' ? value.entrypoint.skillPolicy : { allowedSkillIds: value.skillIds }),
        JSON.stringify(value.entrypoint?.kind === 'agent' ? value.entrypoint.authorityPolicy : defaultAuthorityPolicy(value)),
        null,
      ],
    );
    this.db.execute('UPDATE digital_employees SET memory_enabled = ? WHERE id = ?', [value.memoryEnabled === false ? 0 : 1, id]);
    this.db.execute('UPDATE digital_employees SET global_employee_id = ? WHERE id = ?', [value.globalEmployeeId ?? null, id]);
    return this.getById(id)!;
  }

  /** 为已创建的员工建立工作关联，禁止在项目复制或覆盖配置。 */
  createFromTemplate(input: { projectId: string; template: DigitalEmployeeTemplateRecord; id?: string }): DigitalEmployeeRecord {
    if (input.template.builtIn) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_TEMPLATE_NOT_ASSIGNABLE', '请先从内置模板创建全局员工，再绑定到项目。');
    /** 同一员工在一个项目只有一份绑定，不重复创建配置副本。 */
    const existing = this.getByGlobalEmployee(input.projectId, input.template.id);
    if (existing) return existing;
    return this.create({
      memoryEnabled: input.template.memoryEnabled,
      name: input.template.name,
      description: input.template.description,
      role: input.template.role,
      domain: input.template.domain,
      avatarId: input.template.avatarId,
      prompt: input.template.prompt,
      agentKind: input.template.agentKind,
      model: input.template.model,
      reasoningEffort: input.template.reasoningEffort,
      id: input.id,
      projectId: input.projectId,
      templateId: input.template.id,
      globalEmployeeId: input.template.id,
    });
  }

  /** 更新员工关联身份，原项目配置列和历史运行保持原文。 */
  update(id: string, input: UpdateDigitalEmployeeInput): DigitalEmployeeRecord {
    if (Object.keys(input).some((key) => key !== 'globalEmployeeId' && key !== 'expectedRevision')) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_INVALID', '项目只保留员工关联，请在数字员工中修改职责和经验。');
    const existing = this.require(id);
    assertRevision(existing.revision, input.expectedRevision, '数字员工');
    /** 关联只接受真实全局身份，不能重新恢复项目专用配置。 */
    const globalEmployeeId = requiredIdentity(input.globalEmployeeId ?? existing.globalEmployeeId, 'globalEmployeeId');
    const global = new DigitalEmployeeTemplateRepository(this.db).getById(globalEmployeeId);
    if (!global || global.builtIn) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_GLOBAL_UNAVAILABLE', '请选择已经创建的全局数字员工。');
    /** 同一全局员工在项目中只有一个工作关联。 */
    const duplicate = this.getByGlobalEmployee(existing.projectId, globalEmployeeId);
    if (duplicate && duplicate.id !== existing.id) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_ALREADY_BOUND', '该全局员工已在当前项目中，请使用已有项目配置。');
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute('UPDATE digital_employees SET global_employee_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL', [globalEmployeeId, timestamp, existing.id, existing.revision]);
    assertChanged(this.db, '数字员工已被其他操作更新。');
    return this.getById(existing.id)!;
  }

  /** 删除没有被非终态任务占用的数字员工，并保留历史任务中的员工快照。 */
  delete(id: string, expectedRevision: number, taskBlocksDeletion: DigitalEmployeeTaskBlocksDeletion): DigitalEmployeeRecord {
    const existing = this.require(id);
    assertRevision(existing.revision, expectedRevision, '数字员工');
    if (this.countActiveExecutions(id, taskBlocksDeletion) > 0) throw employeeStoreError('ZEUS_DIGITAL_EMPLOYEE_ACTIVE', '数字员工仍有运行中或待交付的工作，不能删除。');
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.transaction(() => {
      this.db.execute(`UPDATE digital_employee_automations SET enabled = 0, deleted_at = COALESCE(deleted_at, ?), updated_at = ?, revision = revision + 1 WHERE employee_id = ? AND deleted_at IS NULL`, [timestamp, timestamp, existing.id]);
      this.db.execute(`UPDATE digital_employees SET enabled = 0, deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL`, [timestamp, timestamp, existing.id, existing.revision]);
      assertChanged(this.db, '数字员工已被其他操作更新。');
    });
    return existing;
  }

  /** 只统计仍属于非终态任务或没有任务归属的活动工作。 */
  countActiveExecutions(employeeId: string, taskBlocksDeletion: DigitalEmployeeTaskBlocksDeletion): number {
    const legacy = this.db.select<{ task_id: string | null }>(`SELECT task_id FROM digital_employee_executions WHERE employee_id = ? AND status IN ('queued', 'dispatching', 'running', 'waiting', 'delivery_pending')`, [employeeId]);
    const workItems = this.db.select<{ task_id: string }>(`SELECT task_id FROM task_work_items WHERE employee_id = ? AND status IN ('queued', 'active', 'waiting_manager', 'blocked')`, [employeeId]);
    let active = 0;
    for (const record of [...legacy, ...workItems]) {
      if (record.task_id === null || taskBlocksDeletion(record.task_id)) active += 1;
    }
    return active;
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
    const id = input.id ? requiredIdentity(input.id, 'automation.id') : `digital_employee_automation_${randomId(12)}`;
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
    const id = input.id ? requiredIdentity(input.id, 'execution.id') : `digital_employee_execution_${randomId(12)}`;
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
  /** 原事件 payload，保留实际发生时的状态与来源。 */
  payload: Record<string, unknown>;
  /** 原事件的来源，防止流程自身重复触发自动化。 */
  source: string | null;
  /** 状态变化前的真实项目状态。 */
  beforeStatusId: string | null;
  /** 状态变化后的真实项目状态。 */
  afterStatusId: string | null;
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
      .map((row) => {
        /** 同一个原始 payload 只解析一次，避免重复读取和状态歧义。 */
        const payload = parseRecord(row.payload_json, 'taskEvent.payload');
        return {
          sequence: row.sequence,
          identity: `task_event:${row.id}`,
          projectId: input.projectId,
          taskId: row.task_id,
          kind: input.triggerKind,
          eventType: row.event_type,
          occurredAt: row.created_at,
          payload,
          source: typeof payload.source === 'string' ? payload.source : null,
          beforeStatusId: automationEventStatusId(payload, true),
          afterStatusId: automationEventStatusId(payload, false),
          suppressAutomation: payload.suppressAutomation === true || ['task_push', 'automation', 'digital_employee_automation', 'digital_team_workflow'].includes(String(payload.source)),
        };
      });
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
        payload: {},
        source: null,
        beforeStatusId: null,
        afterStatusId: null,
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
  /** 全局员工默认经验与交付权限，不包含项目归属。 */
  base_configuration_json?: string;
  /** 已持久保存的预置头像。 */
  avatar_id: DigitalEmployeeAvatarId | null;
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
  /** 已创建全局员工的稳定身份。 */
  global_employee_id?: string | null;
  /** 历史有效配置或用户明确设置的项目差异。 */
  project_overrides_json?: string;
  /** 项目追加工作要求。 */
  project_instructions?: string;
  /** 员工记忆读取偏好。 */
  memory_enabled?: number;
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
  entrypoint_kind: string | null;
  entrypoint_migration_state: string;
  model_policy_json: string;
  skill_policy_json: string;
  authority_policy_json: string;
  command_id: string | null;
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
  /** 全局权限默认不因为旧目录升级而扩大。 */
  const defaults = parseRecord(row.base_configuration_json ?? '{}', 'globalEmployee.defaults');
  return {
    identityKind: row.built_in === 1 ? 'template' : 'employee',
    memoryEnabled: defaults.memoryEnabled !== false,
    allowCodeChanges: defaults.allowCodeChanges === true,
    allowTests: defaults.allowTests === true,
    deliveryGrants: normalizeDeliveryGrants(isPlainRecord(defaults.deliveryGrants) ? defaults.deliveryGrants : {}),
    id: row.id,
    name: row.name,
    description: row.description,
    role: row.role,
    domain: row.domain,
    avatarId: row.avatar_id,
    skillIds: [],
    prompt: row.prompt,
    agentKind: oneOf(row.agent_kind, digitalEmployeeAgentKinds, 'template.agentKind'),
    model: nullableText(row.model, 512),
    reasoningEffort: nullableText(row.reasoning_effort, 120),
    serviceTier: null,
    permissionMode: 'read-only',
    workMode: 'default',
    builtIn: row.built_in === 1,
    revision: nonNegativeInteger(row.revision, 'template.revision'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 读取员工身份，历史动作列保留原值但不恢复为公开配置。 */
function mapEmployeeRow(row: DigitalEmployeeRow): DigitalEmployeeRecord {
  oneOf(row.entrypoint_migration_state, ['ready', 'requires_selection', 'requires_configuration'] as const, 'employee.entrypointMigrationState');
  return {
    globalEmployeeId: row.global_employee_id ?? null,
    memoryEnabled: row.memory_enabled !== 0,
    id: row.id,
    projectId: row.project_id,
    templateId: row.template_id,
    name: row.name,
    description: row.description,
    role: row.role,
    domain: row.domain,
    avatarId: row.avatar_id,
    skillIds: [],
    prompt: row.prompt,
    agentKind: oneOf(row.agent_kind, digitalEmployeeAgentKinds, 'employee.agentKind'),
    model: nullableText(row.model, 512),
    reasoningEffort: nullableText(row.reasoning_effort, 120),
    serviceTier: null,
    permissionMode: 'read-only',
    workMode: 'default',
    // 项目停启配置已经退役，仍保留原列给历史记录核对。
    enabled: true,
    autoClaim: false,
    autonomousExploration: false,
    maxConcurrency: positiveInteger(row.max_concurrency, 'employee.maxConcurrency', 20),
    taskFilter: { managementStatuses: [], taskTypes: [], requiredTags: [] },
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
    entrypoint: null,
    entrypointMigrationState: 'ready',
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

/** 校验身份、提示词与默认执行参数；实际模型能力由派发预检核对。 */
function normalizeTemplateInput(input: CreateDigitalEmployeeTemplateInput): Omit<DigitalEmployeeTemplateRecord, 'id' | 'identityKind' | 'builtIn' | 'revision' | 'createdAt' | 'updatedAt'> {
  return {
    memoryEnabled: input.memoryEnabled !== false,
    name: boundedText(input.name, 'template.name', 1, 120),
    description: boundedText(input.description ?? '', 'template.description', 0, 1_000),
    role: boundedText(input.role, 'template.role', 1, 120),
    domain: boundedText(input.domain ?? '', 'template.domain', 0, 120),
    avatarId: input.avatarId == null ? null : oneOf(input.avatarId, digitalEmployeeAvatarIds, 'template.avatarId'),
    skillIds: [],
    prompt: boundedText(input.prompt, 'template.prompt', 1, 20_000),
    agentKind: oneOf(input.agentKind ?? 'codex', digitalEmployeeAgentKinds, 'template.agentKind'),
    model: nullableText(input.model, 512),
    reasoningEffort: nullableText(input.reasoningEffort, 120),
    serviceTier: null,
    permissionMode: 'read-only',
    workMode: 'default',
  };
}

/** 只从公开员工字段生成项目绑定与 Agent 入口。 */
function normalizeEmployeeInput(input: CreateDigitalEmployeeInput): Omit<DigitalEmployeeRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'> {
  const template = normalizeTemplateInput(input);

  const base = {
    globalEmployeeId: nullableIdentity(input.globalEmployeeId, 'globalEmployeeId'),
    projectId: requiredIdentity(input.projectId, 'projectId'),
    templateId: nullableIdentity(input.templateId, 'templateId'),
    ...template,
    enabled: true,
    autoClaim: false,
    autonomousExploration: false,
    // 历史列只作存储兼容；数字员工不再设置或执行并发上限。
    maxConcurrency: 1,
    taskFilter: { managementStatuses: [], taskTypes: [], requiredTags: [] },
    // 新员工的历史列保持关闭，任务运行另行计算权限。
    allowCodeChanges: false,
    allowTests: false,
    deliveryGrants: normalizeDeliveryGrants({}),
    deployCommandId: null,
  };
  /** 入口从同一份员工配置派生，不接收第二份提示词或权限配置。 */
  const entrypoint: AgentEntrypointV2 = {
    kind: 'agent',
    prompt: template.prompt,
    agentKind: template.agentKind,
    modelPolicy: defaultModelPolicy(base),
    skillPolicy: { allowedSkillIds: template.skillIds },
    authorityPolicy: defaultAuthorityPolicy(base),
  };
  return { ...base, entrypoint, entrypointMigrationState: 'ready' };
}

/** 只保存员工经验偏好，执行与交付权限属于具体任务。 */
function globalEmployeeDefaults(input: CreateDigitalEmployeeTemplateInput): Pick<DigitalEmployeeTemplateRecord, 'memoryEnabled'> {
  return { memoryEnabled: input.memoryEnabled !== false };
}

function defaultModelPolicy(input: Pick<DigitalEmployeeTemplateRecord, 'model' | 'reasoningEffort' | 'serviceTier'>): ModelPolicyV1 {
  return {
    defaultMode: input.model ? 'explicit' : 'project',
    defaultModel: input.model,
    allowedModels: input.model ? [input.model] : [],
    allowedReasoningEfforts: input.reasoningEffort ? [input.reasoningEffort] : [],
    allowedServiceTiers: input.serviceTier ? [input.serviceTier] : [],
  };
}

/** 旧入口形状保持保守默认，动作授权在运行接纳时由任务与节点计算。 */
function defaultAuthorityPolicy(input: { permissionMode: DigitalEmployeePermissionMode }): AuthorityPolicyV1 {
  return {
    permissionMode: input.permissionMode,
    allowCodeChanges: false,
    allowTests: false,
    allowCommit: false,
    allowPush: false,
    allowMerge: false,
    allowDeploy: false,
    allowComplete: false,
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

function normalizeDeliveryGrants(input: Partial<DigitalEmployeeDeliveryGrants> | Record<string, unknown>): DigitalEmployeeDeliveryGrants {
  return {
    allowCommit: input.allowCommit === true,
    allowPush: input.allowPush === true,
    allowMerge: input.allowMerge === true,
    allowDeploy: input.allowDeploy === true,
    allowComplete: input.allowComplete === true,
  };
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
