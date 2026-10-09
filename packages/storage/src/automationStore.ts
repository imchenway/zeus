import { createHash } from 'node:crypto';
import { temporaryWorkspaceId, type AutomationActionConfig, type AutomationDispatchTarget, type AutomationExecutionReference, type AutomationSourceEvent } from '@zeus/shared';
import { randomId } from './randomId.js';
import type { ZeusDatabasePort } from './databasePort.js';

export const automationSchemaMigrationId = '20260829_0374_automation_tasks_v1';
/** 把一次自动化触发的全部目标项目冻结到同一条运行。 */
export const automationRunTargetsMigrationId = '20260926_0426_automation_run_targets';

export const automationStatuses = ['active', 'paused', 'deleted'] as const;
export const automationTriggerKinds = ['manual', 'once', 'interval', 'daily', 'weekly', 'rrule', 'event'] as const;
export const automationConversationModes = ['independent', 'original'] as const;
export const automationBlockStrategies = ['serial', 'discard', 'cover'] as const;
/** 待验收保留真实成果引用，独立员工工作不再占用执行队列。 */
export const automationRunStatuses = ['queued', 'dispatching', 'running', 'awaiting_review', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'] as const;
export const automationPermissionModes = ['read-only', 'auto', 'full-access'] as const;

export type AutomationStatus = (typeof automationStatuses)[number];
export type AutomationTriggerKind = (typeof automationTriggerKinds)[number];
export type AutomationConversationMode = (typeof automationConversationModes)[number];
export type AutomationBlockStrategy = (typeof automationBlockStrategies)[number];
export type AutomationRunStatus = (typeof automationRunStatuses)[number];
export type AutomationPermissionMode = (typeof automationPermissionModes)[number];

export interface AutomationTriggerConfig {
  at?: string;
  everyMinutes?: number;
  localTime?: string;
  weekdays?: number[];
  rrule?: string;
  eventKinds?: string[];
  /** 项目状态事件的发生前状态条件。 */
  beforeStatusId?: string;
  /** 项目状态事件的发生后状态条件。 */
  afterStatusId?: string;
}

export interface AutomationNotificationConfig {
  success: boolean;
  failure: boolean;
  blocked: boolean;
}

export interface AutomationDefinitionSnapshot {
  /** 业务动作与员工引用随修订冻结。 */
  action: AutomationActionConfig;
  name: string;
  description: string;
  prompt: string;
  triggerKind: AutomationTriggerKind;
  triggerConfig: AutomationTriggerConfig;
  timezone: string;
  conversationMode: AutomationConversationMode;
  originalConversationId: string | null;
  permissionMode: AutomationPermissionMode;
  modelSourceId: string;
  modelId: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
  fastMode: boolean;
  skillId: string | null;
  pluginIds: string[];
  blockStrategy: AutomationBlockStrategy;
  queueCapacity: number;
  maxRunsPerDay: number | null;
  maxTokensPerDay: number | null;
  retentionDays: number;
  notifications: AutomationNotificationConfig;
}

export interface AutomationTaskRecord extends AutomationDefinitionSnapshot {
  /** 存量规则的目标或授权需要重新确认时给出核对原因。 */
  migrationIssue: string | null;
  /** 原事件消费游标按项目保存，迁移不回放旧事件。 */
  eventCursors: Record<string, number>;
  id: string;
  status: AutomationStatus;
  currentRevisionId: string;
  revision: number;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTargetRecord {
  automationId: string;
  projectId: string;
  position: number;
  enabled: boolean;
  createdAt: string;
}

export interface AutomationRevisionRecord {
  id: string;
  automationId: string;
  revision: number;
  snapshot: AutomationDefinitionSnapshot;
  projectIds: string[];
  createdAt: string;
}

export interface AutomationRunRecord {
  /** 每个冻结目标的耐久接纳进度。 */
  dispatchTargets: AutomationDispatchTarget[];
  /** 全部目标已处理的事实，与工作完成时间分离。 */
  dispatchCompletedAt: string | null;
  /** 存量运行核对保留原结论，不抹掉曾经误报的历史。 */
  dispatchReconciliation: { previousStatus: AutomationRunStatus; checkedAt: string; reason: string; completedAt?: string | null } | null;
  /** 本次触发的真实工作或完整流程引用。 */
  executionReferences: AutomationExecutionReference[];
  /** 事件原始事实随触发冻结。 */
  sourceEvent: AutomationSourceEvent | null;
  id: string;
  automationId: string;
  automationRevisionId: string;
  projectId: string;
  /** 本次触发按顺序处理的全部用户项目；空数组表示无项目运行。 */
  projectIds: string[];
  triggerKind: string;
  triggerIdentity: string;
  causalChainId: string;
  status: AutomationRunStatus;
  queuePosition: number | null;
  conversationId: string | null;
  submissionId: string | null;
  attempt: number;
  unread: boolean;
  mayOverlapPrevious: boolean;
  previousRunId: string | null;
  scheduledAt: string;
  acceptedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAutomationTaskInput extends Partial<Omit<AutomationDefinitionSnapshot, 'name' | 'prompt' | 'modelSourceId' | 'modelId'>> {
  id?: string;
  name: string;
  prompt: string;
  /** 历史客户端字段不再参与新规则执行。 */
  modelSourceId?: string;
  /** 历史客户端字段不再参与新规则执行。 */
  modelId?: string;
  projectIds: string[];
}

export type UpdateAutomationTaskInput = Partial<CreateAutomationTaskInput> & { expectedRevision: number };

export interface EnqueueAutomationRunInput {
  /** 项目事件原始事实。 */
  sourceEvent?: AutomationSourceEvent | null;
  id?: string;
  automationId: string;
  /** 一次触发的完整用户项目范围；空数组表示无项目运行。 */
  projectIds: string[];
  /** 无项目运行在写回执前必须提供已存在的临时工作区锚点。 */
  projectId?: string;
  triggerKind: string;
  triggerIdentity: string;
  scheduledAt: string;
  causalChainId?: string;
}

interface DbAutomationTaskRow {
  /** 旧动作需要人工核对的原因。 */
  migration_issue: string | null;
  /** 动作配置持久化。 */
  action_json: string;
  /** 按项目持久化的事件游标。 */
  event_cursors_json: string;
  id: string;
  name: string;
  description: string;
  prompt: string;
  status: AutomationStatus;
  current_revision_id: string;
  revision: number;
  trigger_kind: AutomationTriggerKind;
  trigger_config_json: string;
  timezone: string;
  conversation_mode: AutomationConversationMode;
  original_conversation_id: string | null;
  permission_mode: AutomationPermissionMode;
  model_source_id: string;
  model_id: string;
  reasoning_effort: string | null;
  service_tier: string | null;
  fast_mode: number;
  skill_id: string | null;
  plugin_ids_json: string;
  block_strategy: AutomationBlockStrategy;
  queue_capacity: number;
  max_runs_per_day: number | null;
  max_tokens_per_day: number | null;
  retention_days: number;
  notification_json: string;
  next_run_at: string | null;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DbAutomationRunRow {
  /** 逐目标耐久状态。 */
  dispatch_targets_json: string;
  /** 完整派发时间。 */
  dispatch_completed_at: string | null;
  /** 存量核对记录。 */
  dispatch_reconciliation_json: string | null;
  /** 真实执行关联持久化。 */
  execution_references_json: string;
  /** 原事件持久化。 */
  source_event_json: string | null;
  id: string;
  automation_id: string;
  automation_revision_id: string;
  project_id: string;
  project_ids_json: string | null;
  trigger_kind: string;
  trigger_identity: string;
  causal_chain_id: string;
  status: AutomationRunStatus;
  queue_position: number | null;
  conversation_id: string | null;
  submission_id: string | null;
  attempt: number;
  unread: number;
  may_overlap_previous: number;
  previous_run_id: string | null;
  scheduled_at: string;
  accepted_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const taskSelect = `id, name, description, prompt, status, current_revision_id, revision, trigger_kind, trigger_config_json, timezone,
  conversation_mode, original_conversation_id, permission_mode, model_source_id, model_id, reasoning_effort, service_tier,
  fast_mode, skill_id, plugin_ids_json, block_strategy, queue_capacity, max_runs_per_day, max_tokens_per_day, retention_days,
  notification_json, next_run_at, last_triggered_at, created_at, updated_at, action_json, event_cursors_json, migration_issue`;

const runSelect = `id, automation_id, automation_revision_id, project_id, trigger_kind, trigger_identity, causal_chain_id, status,
  queue_position, conversation_id, submission_id, attempt, unread, may_overlap_previous, previous_run_id, scheduled_at, accepted_at,
  started_at, completed_at, error_code, error_message, project_ids_json, created_at, updated_at, execution_references_json, source_event_json, dispatch_targets_json, dispatch_completed_at, dispatch_reconciliation_json`;

function nowIso(): string {
  return new Date().toISOString();
}

function requiredText(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`ZEUS_AUTOMATION_CONFIG_INVALID: ${field} 不能为空。`);
  if (normalized.length > max) throw new Error(`ZEUS_AUTOMATION_CONFIG_INVALID: ${field} 超过 ${max} 字符。`);
  return normalized;
}

function enumValue<T extends string>(value: string, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new Error(`ZEUS_AUTOMATION_CONFIG_INVALID: ${field} 无效。`);
  return value as T;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) throw new Error(`ZEUS_AUTOMATION_CONFIG_INVALID: ${field} 必须为 ${min}-${max} 的整数。`);
  return normalized;
}

function nullableBudget(value: number | null | undefined, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1) throw new Error(`ZEUS_AUTOMATION_CONFIG_INVALID: ${field} 必须为正整数。`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`ZEUS_AUTOMATION_CONFIG_INVALID: ${field} 必须为字符串数组。`);
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

/** 旧表需要非空项目锚点；无项目运行只接受 Zeus 临时工作区。 */
function runAnchorProjectId(projectIds: string[], projectId?: string): string {
  const anchor = projectIds[0] ?? projectId;
  if (!anchor || (projectIds.length === 0 && anchor !== temporaryWorkspaceId)) throw new Error('ZEUS_AUTOMATION_TEMPORARY_WORKSPACE_REQUIRED: 无项目运行需要 Zeus 临时工作区。');
  return anchor;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeSnapshot(input: CreateAutomationTaskInput | (Partial<CreateAutomationTaskInput> & AutomationDefinitionSnapshot), projectEmployeeIds?: Record<string, string>): AutomationDefinitionSnapshot {
  /** 新配置只触发员工工作或项目流程，普通会话只保留历史读取。 */
  const action = { ...(input.action ?? { kind: 'employee_work', employeeId: null }) };
  /** 请求正文不得注入项目绑定；已有内部映射只从仓储原记录传入。 */
  delete action.projectEmployeeIds;
  if (projectEmployeeIds && Object.keys(projectEmployeeIds).length > 0) action.projectEmployeeIds = projectEmployeeIds;
  /** 员工身份在 HTTP 信任边界只接受非空字符串。 */
  const employeeId = typeof action.employeeId === 'string' ? action.employeeId.trim() : null;
  if (!['employee_work', 'project_task'].includes(action.kind) || !employeeId) throw new Error('ZEUS_AUTOMATION_ACTION_INVALID: 请选择数字员工工作或项目流程及执行员工。');
  if ((action.taskId != null && typeof action.taskId !== 'string') || (action.title !== undefined && typeof action.title !== 'string') || (action.useEventTask !== undefined && typeof action.useEventTask !== 'boolean'))
    throw new Error('ZEUS_AUTOMATION_ACTION_INVALID: 任务引用或动作配置无效。');
  if (action.taskSelection !== undefined && !['specified', 'event', 'pool', 'create'].includes(action.taskSelection)) throw new Error('ZEUS_AUTOMATION_TASK_SELECTION_INVALID: 项目任务目标策略无效。');
  if (action.taskFilter !== undefined && (!action.taskFilter || typeof action.taskFilter !== 'object' || Array.isArray(action.taskFilter))) throw new Error('ZEUS_AUTOMATION_TASK_FILTER_INVALID: 任务筛选必须是对象。');
  if (action.kind === 'project_task' && action.taskSelection === 'specified' && !action.taskId?.trim()) throw new Error('ZEUS_AUTOMATION_TASK_REQUIRED: 指定已有任务必须提供任务身份。');
  const triggerKind = enumValue(input.triggerKind ?? 'manual', automationTriggerKinds, '触发方式');
  if (input.triggerConfig?.eventKinds?.includes('code_changed') && input.triggerConfig.eventKinds.length > 1) throw new Error('ZEUS_AUTOMATION_EVENT_STREAM_INVALID: 代码变化与任务状态使用不同事件流，请分别创建规则。');
  const timezone = requiredText(input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC', '时区', 128);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error('ZEUS_AUTOMATION_CONFIG_TIMEZONE_INVALID: 必须使用有效 IANA 时区。');
  }
  return {
    action: {
      ...action,
      employeeId,
      ...(action.kind === 'project_task'
        ? {
            taskFilter: {
              managementStatuses: stringArray(action.taskFilter?.managementStatuses ?? [], '任务状态'),
              taskTypes: stringArray(action.taskFilter?.taskTypes ?? [], '任务类型'),
              requiredTags: stringArray(action.taskFilter?.requiredTags ?? [], '任务标签'),
            },
          }
        : {}),
    },
    name: requiredText(input.name, '名称', 120),
    description: (input.description ?? '').trim().slice(0, 500),
    prompt: requiredText(input.prompt, '指令', 100_000),
    triggerKind,
    triggerConfig: input.triggerConfig ?? {},
    timezone,
    conversationMode: 'independent',
    originalConversationId: null,
    permissionMode: enumValue(input.permissionMode ?? 'read-only', automationPermissionModes, '权限模式'),
    modelSourceId: 'inherit',
    modelId: 'inherit',
    reasoningEffort: null,
    serviceTier: null,
    fastMode: false,
    skillId: null,
    pluginIds: [],
    blockStrategy: enumValue(input.blockStrategy ?? 'serial', automationBlockStrategies, '阻塞策略'),
    queueCapacity: boundedInteger(input.queueCapacity, 10, 1, 10_000, '队列容量'),
    maxRunsPerDay: nullableBudget(input.maxRunsPerDay, '每日运行上限'),
    maxTokensPerDay: nullableBudget(input.maxTokensPerDay, '每日 Token 上限'),
    retentionDays: boundedInteger(input.retentionDays, 30, 1, 3650, '保留天数'),
    notifications: {
      success: input.notifications?.success ?? true,
      failure: input.notifications?.failure ?? true,
      blocked: input.notifications?.blocked ?? true,
    },
  };
}

/** 已有会话沿用原项目权限边界，不能由自动化静默扩成跨项目会话。 */
function validateConversationProjects(snapshot: AutomationDefinitionSnapshot, projectIds: string[]): void {
  if (snapshot.action.kind === 'project_task' && snapshot.action.taskSelection === 'specified' && projectIds.length !== 1) throw new Error('ZEUS_AUTOMATION_TASK_SCOPE: 指定已有任务只能选择一个项目。');
  if (snapshot.action.kind === 'project_task' && snapshot.action.taskSelection === 'event' && snapshot.triggerKind !== 'event') throw new Error('ZEUS_AUTOMATION_EVENT_TASK_REQUIRED: 使用事件任务必须选择事件触发。');
  if (snapshot.action.kind === 'project_task' && projectIds.length === 0) throw new Error('ZEUS_AUTOMATION_ACTION_PROJECT_REQUIRED: 处理项目任务必须选择项目。');
  if (snapshot.action.kind !== 'conversation' && snapshot.conversationMode === 'original') throw new Error('ZEUS_AUTOMATION_ACTION_ORIGINAL_CONVERSATION_INVALID: 员工动作使用独立工作会话。');
  if (snapshot.conversationMode === 'original' && projectIds.length !== 1) {
    throw new Error('ZEUS_AUTOMATION_CONFIG_ORIGINAL_CONVERSATION_SINGLE_PROJECT_REQUIRED: 追加原会话必须选择一个项目；无项目或多项目运行请新建独立会话。');
  }
}

function mapTask(row: DbAutomationTaskRow): AutomationTaskRecord {
  return {
    action: parseJson<AutomationActionConfig>(row.action_json, { kind: 'conversation', employeeId: null }),
    migrationIssue: row.migration_issue,
    eventCursors: parseJson<Record<string, number>>(row.event_cursors_json, {}),
    id: row.id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    status: enumValue(row.status, automationStatuses, '自动化状态'),
    currentRevisionId: row.current_revision_id,
    revision: row.revision,
    triggerKind: enumValue(row.trigger_kind, automationTriggerKinds, '触发方式'),
    triggerConfig: parseJson<AutomationTriggerConfig>(row.trigger_config_json, {}),
    timezone: row.timezone,
    conversationMode: enumValue(row.conversation_mode, automationConversationModes, '会话模式'),
    originalConversationId: row.original_conversation_id,
    permissionMode: enumValue(row.permission_mode, automationPermissionModes, '权限模式'),
    modelSourceId: row.model_source_id,
    modelId: row.model_id,
    reasoningEffort: row.reasoning_effort,
    serviceTier: row.service_tier,
    fastMode: row.fast_mode === 1,
    skillId: row.skill_id,
    pluginIds: parseJson<string[]>(row.plugin_ids_json, []),
    blockStrategy: enumValue(row.block_strategy, automationBlockStrategies, '阻塞策略'),
    queueCapacity: row.queue_capacity,
    maxRunsPerDay: row.max_runs_per_day,
    maxTokensPerDay: row.max_tokens_per_day,
    retentionDays: row.retention_days,
    notifications: parseJson<AutomationNotificationConfig>(row.notification_json, { success: true, failure: true, blocked: true }),
    nextRunAt: row.next_run_at,
    lastTriggeredAt: row.last_triggered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: DbAutomationRunRow): AutomationRunRecord {
  return {
    dispatchTargets: parseJson<AutomationDispatchTarget[]>(row.dispatch_targets_json, []),
    dispatchCompletedAt: row.dispatch_completed_at,
    dispatchReconciliation: row.dispatch_reconciliation_json ? parseJson<AutomationRunRecord['dispatchReconciliation']>(row.dispatch_reconciliation_json, null) : null,
    executionReferences: parseJson<AutomationExecutionReference[]>(row.execution_references_json, []),
    sourceEvent: row.source_event_json ? parseJson<AutomationSourceEvent | null>(row.source_event_json, null) : null,
    id: row.id,
    automationId: row.automation_id,
    automationRevisionId: row.automation_revision_id,
    projectId: row.project_id,
    projectIds: stringArray(parseJson<unknown>(row.project_ids_json ?? '', [row.project_id]), '运行项目'),
    triggerKind: row.trigger_kind,
    triggerIdentity: row.trigger_identity,
    causalChainId: row.causal_chain_id,
    status: enumValue(row.status, automationRunStatuses, '运行状态'),
    queuePosition: row.queue_position,
    conversationId: row.conversation_id,
    submissionId: row.submission_id,
    attempt: row.attempt,
    unread: row.unread === 1,
    mayOverlapPrevious: row.may_overlap_previous === 1,
    previousRunId: row.previous_run_id,
    scheduledAt: row.scheduled_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function migrateAutomationSchema(db: ZeusDatabasePort): void {
  const checksum = `sha256:${createHash('sha256').update('automation_tasks:v1;automation_revisions:v1;automation_targets:v1;automation_runs:v1;automation_attempts:v1;automation_receipts:v1;automation_grants:v1;conversation_origin:v1').digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [automationSchemaMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('自动化任务迁移账本与当前结构定义不一致。');
    for (const statement of [
      `ALTER TABLE conversations ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'ordinary'`,
      `ALTER TABLE conversations ADD COLUMN listing_scope TEXT NOT NULL DEFAULT 'ordinary'`,
      `ALTER TABLE conversations ADD COLUMN automation_run_id TEXT`,
    ]) {
      try {
        db.execute(statement);
      } catch {
        // 新库或已迁移数据库已包含字段。
      }
    }
    // 此迁移早于 conversation stage 迁移，只能使用 Core 初始表已存在的列。
    db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_listing_scope ON conversations(listing_scope, archived, created_at DESC)`);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_automation_run ON conversations(automation_run_id) WHERE automation_run_id IS NOT NULL`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS automation_tasks (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, current_revision_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        trigger_kind TEXT NOT NULL, trigger_config_json TEXT NOT NULL, timezone TEXT NOT NULL,
        conversation_mode TEXT NOT NULL, original_conversation_id TEXT, permission_mode TEXT NOT NULL,
        model_source_id TEXT NOT NULL, model_id TEXT NOT NULL, reasoning_effort TEXT, service_tier TEXT,
        fast_mode INTEGER NOT NULL DEFAULT 0, skill_id TEXT, plugin_ids_json TEXT NOT NULL,
        block_strategy TEXT NOT NULL, queue_capacity INTEGER NOT NULL, max_runs_per_day INTEGER,
        max_tokens_per_day INTEGER, retention_days INTEGER NOT NULL, notification_json TEXT NOT NULL,
        next_run_at TEXT, last_triggered_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_automation_tasks_due ON automation_tasks(status, next_run_at) WHERE deleted_at IS NULL`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS automation_task_revisions (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL, project_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(automation_id, revision), FOREIGN KEY (automation_id) REFERENCES automation_tasks(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS automation_task_targets (
        automation_id TEXT NOT NULL, project_id TEXT NOT NULL, position INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, PRIMARY KEY (automation_id, project_id),
        FOREIGN KEY (automation_id) REFERENCES automation_tasks(id), FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, automation_revision_id TEXT NOT NULL, project_id TEXT NOT NULL,
        trigger_kind TEXT NOT NULL, trigger_identity TEXT NOT NULL, causal_chain_id TEXT NOT NULL, status TEXT NOT NULL,
        queue_position INTEGER, conversation_id TEXT, submission_id TEXT, attempt INTEGER NOT NULL DEFAULT 0,
        unread INTEGER NOT NULL DEFAULT 0, may_overlap_previous INTEGER NOT NULL DEFAULT 0, previous_run_id TEXT,
        scheduled_at TEXT NOT NULL, accepted_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
        error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(automation_id, project_id, trigger_identity), FOREIGN KEY (automation_id) REFERENCES automation_tasks(id),
        FOREIGN KEY (automation_revision_id) REFERENCES automation_task_revisions(id), FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_automation_runs_dispatch ON automation_runs(status, queue_position, accepted_at)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_automation_runs_inbox ON automation_runs(unread, completed_at DESC, created_at DESC)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS automation_run_attempts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
        operation_identity TEXT NOT NULL, write_marker_at TEXT, provider_request_id TEXT,
        started_at TEXT NOT NULL, completed_at TEXT, error_code TEXT, error_message TEXT,
        UNIQUE(run_id, attempt), FOREIGN KEY (run_id) REFERENCES automation_runs(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS automation_trigger_receipts (
        automation_id TEXT NOT NULL, project_id TEXT NOT NULL, trigger_identity TEXT NOT NULL, run_id TEXT,
        occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (automation_id, project_id, trigger_identity), FOREIGN KEY (automation_id) REFERENCES automation_tasks(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS automation_causal_chain_members (
        causal_chain_id TEXT NOT NULL, automation_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (causal_chain_id, automation_id, project_id),
        FOREIGN KEY (run_id) REFERENCES automation_runs(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS automation_full_access_grants (
        automation_id TEXT PRIMARY KEY, config_revision INTEGER NOT NULL, granted INTEGER NOT NULL,
        granted_at TEXT, revoked_at TEXT, updated_at TEXT NOT NULL, FOREIGN KEY (automation_id) REFERENCES automation_tasks(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS automation_notification_outbox (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
        delivered_at TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES automation_runs(id)
      )
    `);
    const timestamp = nowIso();
    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      automationSchemaMigrationId,
      '新增顶级自动化定义、修订、目标、运行、尝试、收件箱与会话来源',
      checksum,
      timestamp,
    ]);
  });
  migrateAutomationRunTargets(db);
  migrateAutomationActions(db);
  migrateAutomationDispatchProgress(db);
  migrateAutomationTaskCreationGrants(db);
  migrateAutomationConversationRules(db);
}

/** 旧普通会话只保留历史，规则需显式改选员工动作才可再次启用。 */
function migrateAutomationConversationRules(db: ZeusDatabasePort): void {
  /** 一次登记不反复暂停已经完成改配的规则。 */
  const migrationId = '20261006_0782_automation_employee_actions';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    /** 暂停不改写旧修订和已经接纳的会话。 */
    const tasks = new AutomationTaskRepository(db);
    for (const task of tasks.list().filter((entry) => entry.action.kind === 'conversation')) tasks.setMigrationIssue(task.id, '普通会话自动化已停止，请选择数字员工或项目流程后保存。');
    db.execute('INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      migrationId,
      '自动化统一为员工或项目流程触发',
      `sha256:${createHash('sha256').update(migrationId).digest('hex')}`,
      nowIso(),
    ]);
  });
}

/** 旧完全访问确认未包含新建任务的本地提交，必须重新保存授权。 */
function migrateAutomationTaskCreationGrants(db: ZeusDatabasePort): void {
  /** 一次迁移只收紧已经存在的规则，不影响之后新建的显式授权。 */
  const migrationId = '20261006_0782_automation_task_creation_grants';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    /** 复用现有授权与迁移暂停机制，不改写冻结修订和目标引用。 */
    const tasks = new AutomationTaskRepository(db);
    for (const task of tasks.list()) {
      if (task.permissionMode !== 'full-access' || task.action.kind !== 'project_task' || (task.action.taskSelection ? task.action.taskSelection !== 'create' : Boolean(task.action.taskId))) continue;
      tasks.setFullAccessGrant(task.id, task.revision, false);
      tasks.setMigrationIssue(task.id, [task.migrationIssue, '旧规则的完全访问确认未包含新建任务的本地提交，请核对任务策略并重新保存授权；原运行不会自动获得新权限。'].filter(Boolean).join('\n'));
    }
    db.execute('INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      migrationId,
      '新建项目任务的完全访问授权重新确认',
      `sha256:${createHash('sha256').update(migrationId).digest('hex')}`,
      nowIso(),
    ]);
  });
}

/** 动作、来源事实和执行引用在同一迁移中补齐，历史修订保持普通会话语义。 */
function migrateAutomationActions(db: ZeusDatabasePort): void {
  /** 迁移身份不改写历史账本。 */
  const migrationId = '20261005_0782_automation_actions';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    for (const [table, name, definition] of [
      ['automation_tasks', 'action_json', `TEXT NOT NULL DEFAULT '{"kind":"conversation","employeeId":null}'`],
      ['automation_tasks', 'event_cursors_json', `TEXT NOT NULL DEFAULT '{}'`],
      ['automation_runs', 'execution_references_json', `TEXT NOT NULL DEFAULT '[]'`],
      ['automation_runs', 'source_event_json', 'TEXT'],
    ]) {
      /** 只在字段确实缺失时修改结构，不忽略迁移错误。 */
      if (!db.select<{ name: string }>(`PRAGMA table_info(${table})`).some((column) => column.name === name)) db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
    db.execute('INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      migrationId,
      '统一自动化业务动作与真实执行引用',
      `sha256:${createHash('sha256').update(migrationId).digest('hex')}`,
      nowIso(),
    ]);
  });
}

/** 新旧运行共用最小逐目标接纳账本，历史结论另存核对记录。 */
function migrateAutomationDispatchProgress(db: ZeusDatabasePort): void {
  /** 迁移身份只代表结构，不替换旧运行身份。 */
  const migrationId = '20261005_0782_automation_dispatch_progress';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    if (!db.select<{ name: string }>('PRAGMA table_info(automation_tasks)').some((column) => column.name === 'migration_issue')) db.execute('ALTER TABLE automation_tasks ADD COLUMN migration_issue TEXT');
    for (const [name, definition] of [
      ['dispatch_targets_json', "TEXT NOT NULL DEFAULT '[]'"],
      ['dispatch_completed_at', 'TEXT'],
      ['dispatch_reconciliation_json', 'TEXT'],
    ]) {
      if (!db.select<{ name: string }>('PRAGMA table_info(automation_runs)').some((column) => column.name === name)) db.execute(`ALTER TABLE automation_runs ADD COLUMN ${name} ${definition}`);
    }
    db.execute('INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      migrationId,
      '自动化逐目标接纳与历史结论核对',
      `sha256:${createHash('sha256').update(migrationId).digest('hex')}`,
      nowIso(),
    ]);
  });
}

/** 为旧运行补成单项目范围，新运行由调度入口写入完整项目列表。 */
function migrateAutomationRunTargets(db: ZeusDatabasePort): void {
  /** 迁移摘要绑定新增字段与旧记录补齐规则。 */
  const checksum = `sha256:${createHash('sha256').update('automation_runs:project_ids_json:single_trigger_multi_project').digest('hex')}`;
  db.transaction(() => {
    /** 已登记迁移必须与当前定义完全一致。 */
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [automationRunTargetsMigrationId]);
    if (existing) {
      if (existing.checksum !== checksum) throw new Error('自动化运行项目迁移账本与当前结构定义不一致。');
      return;
    }
    try {
      db.execute(`ALTER TABLE automation_runs ADD COLUMN project_ids_json TEXT`);
    } catch {
      // 新库或恢复中的数据库可能已包含字段，账本仍在下方补齐。
    }
    db.execute(`UPDATE automation_runs SET project_ids_json = json_array(project_id) WHERE project_ids_json IS NULL`);
    db.execute(`INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [automationRunTargetsMigrationId, '自动化一次触发冻结全部目标项目', checksum, nowIso()]);
  });
}

export class AutomationTaskRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  create(input: CreateAutomationTaskInput): AutomationTaskRecord {
    const snapshot = normalizeSnapshot(input);
    const projectIds = stringArray(input.projectIds, '项目');
    validateConversationProjects(snapshot, projectIds);
    const id = input.id ?? `automation_${randomId(12)}`;
    const revisionId = `automation_revision_${randomId(12)}`;
    const timestamp = nowIso();
    return this.db.transaction(() => {
      this.insertTask(id, revisionId, 0, snapshot, timestamp);
      this.db.execute('UPDATE automation_tasks SET action_json = ? WHERE id = ?', [JSON.stringify(snapshot.action), id]);
      this.insertRevision(revisionId, id, 0, snapshot, projectIds, timestamp);
      this.replaceTargets(id, projectIds, timestamp);
      this.initializeEventCursors(id);
      return this.getById(id)!;
    });
  }

  update(id: string, input: UpdateAutomationTaskInput): AutomationTaskRecord {
    const existing = this.getById(id);
    if (!existing || existing.status === 'deleted') throw new Error('ZEUS_AUTOMATION_CONFIG_NOT_FOUND: 自动化任务不存在。');
    if (existing.revision !== input.expectedRevision) throw new Error('ZEUS_AUTOMATION_CONFIG_REVISION_CONFLICT: 配置已被更新，请刷新后重试。');
    /** 原目标范围用于辨别新增项目，普通编辑不推进既有游标。 */
    const previousProjectIds = this.listTargets(id).map((target) => target.projectId);
    const projectIds = input.projectIds === undefined ? previousProjectIds : stringArray(input.projectIds, '项目');
    /** 普通编辑沿用原绑定；改选员工或移除项目时不能把旧映射带到新范围。 */
    const projectEmployeeIds =
      (input.action?.employeeId ?? existing.action.employeeId) === existing.action.employeeId
        ? Object.fromEntries(Object.entries(existing.action.projectEmployeeIds ?? {}).filter(([projectId]) => projectIds.includes(projectId)))
        : undefined;
    const snapshot = normalizeSnapshot({ ...existing, ...input, projectIds }, projectEmployeeIds);
    validateConversationProjects(snapshot, projectIds);
    const revision = existing.revision + 1;
    const revisionId = `automation_revision_${randomId(12)}`;
    const timestamp = nowIso();
    return this.db.transaction(() => {
      this.db.execute(
        `UPDATE automation_tasks SET name = ?, description = ?, prompt = ?, current_revision_id = ?, revision = ?, trigger_kind = ?, trigger_config_json = ?, timezone = ?,
          conversation_mode = ?, original_conversation_id = ?, permission_mode = ?, model_source_id = ?, model_id = ?, reasoning_effort = ?, service_tier = ?, fast_mode = ?, skill_id = ?, plugin_ids_json = ?,
          block_strategy = ?, queue_capacity = ?, max_runs_per_day = ?, max_tokens_per_day = ?, retention_days = ?, notification_json = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        [
          snapshot.name,
          snapshot.description,
          snapshot.prompt,
          revisionId,
          revision,
          snapshot.triggerKind,
          JSON.stringify(snapshot.triggerConfig),
          snapshot.timezone,
          snapshot.conversationMode,
          snapshot.originalConversationId,
          snapshot.permissionMode,
          snapshot.modelSourceId,
          snapshot.modelId,
          snapshot.reasoningEffort,
          snapshot.serviceTier,
          snapshot.fastMode ? 1 : 0,
          snapshot.skillId,
          JSON.stringify(snapshot.pluginIds),
          snapshot.blockStrategy,
          snapshot.queueCapacity,
          snapshot.maxRunsPerDay,
          snapshot.maxTokensPerDay,
          snapshot.retentionDays,
          JSON.stringify(snapshot.notifications),
          timestamp,
          id,
          input.expectedRevision,
        ],
      );
      if ((this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) !== 1) throw new Error('ZEUS_AUTOMATION_CONFIG_REVISION_CONFLICT: 配置已被更新。');
      this.db.execute('UPDATE automation_tasks SET action_json = ?, migration_issue = ? WHERE id = ?', [
        JSON.stringify(snapshot.action),
        input.action && (input.action.kind !== 'project_task' || input.action.taskSelection) ? null : existing.migrationIssue,
        id,
      ]);
      this.insertRevision(revisionId, id, revision, snapshot, projectIds, timestamp);
      this.replaceTargets(id, projectIds, timestamp);
      /** 筛选生效边界变化时以新事件流当前边界替换，不能比较独立流的序号。 */
      const eventBoundaryChanged = existing.triggerKind !== snapshot.triggerKind || JSON.stringify(existing.triggerConfig) !== JSON.stringify(snapshot.triggerConfig);
      this.initializeEventCursors(id, eventBoundaryChanged ? projectIds : projectIds.filter((projectId) => !previousProjectIds.includes(projectId)));
      if (snapshot.permissionMode !== 'full-access') this.db.execute(`DELETE FROM automation_full_access_grants WHERE automation_id = ?`, [id]);
      return this.getById(id)!;
    });
  }

  /** 旧规则需要核对目标或重新授权时暂停，不覆盖用户配置。 */
  setMigrationIssue(id: string, reason: string | null): void {
    this.db.execute('UPDATE automation_tasks SET migration_issue = ?, updated_at = ? WHERE id = ?', [reason, nowIso(), id]);
    if (reason) this.setStatus(id, 'paused');
  }

  getById(id: string): AutomationTaskRecord | undefined {
    const row = this.db.get<DbAutomationTaskRow>(`SELECT ${taskSelect} FROM automation_tasks WHERE id = ? AND deleted_at IS NULL`, [id]);
    return row ? mapTask(row) : undefined;
  }

  list(): AutomationTaskRecord[] {
    return this.db.select<DbAutomationTaskRow>(`SELECT ${taskSelect} FROM automation_tasks WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC`).map(mapTask);
  }

  listDue(at: string): AutomationTaskRecord[] {
    return this.db.select<DbAutomationTaskRow>(`SELECT ${taskSelect} FROM automation_tasks WHERE status = 'active' AND deleted_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id`, [at]).map(mapTask);
  }

  listTargets(automationId: string): AutomationTargetRecord[] {
    return this.db
      .select<{
        automation_id: string;
        project_id: string;
        position: number;
        enabled: number;
        created_at: string;
      }>(`SELECT automation_id, project_id, position, enabled, created_at FROM automation_task_targets WHERE automation_id = ? ORDER BY position, project_id`, [automationId])
      .map((row) => ({ automationId: row.automation_id, projectId: row.project_id, position: row.position, enabled: row.enabled === 1, createdAt: row.created_at }));
  }

  getRevision(id: string): AutomationRevisionRecord | undefined {
    const row = this.db.get<{ id: string; automation_id: string; revision: number; snapshot_json: string; project_ids_json: string; created_at: string }>(
      `SELECT id, automation_id, revision, snapshot_json, project_ids_json, created_at FROM automation_task_revisions WHERE id = ?`,
      [id],
    );
    return row
      ? {
          id: row.id,
          automationId: row.automation_id,
          revision: row.revision,
          snapshot: normalizeRevisionSnapshot(row.snapshot_json),
          projectIds: parseJson<string[]>(row.project_ids_json, []),
          createdAt: row.created_at,
        }
      : undefined;
  }

  setStatus(id: string, status: Exclude<AutomationStatus, 'deleted'>): AutomationTaskRecord {
    if (status === 'active' && this.getById(id)?.migrationIssue) throw new Error('ZEUS_AUTOMATION_MIGRATION_REVIEW_REQUIRED: 请先核对旧规则目标选择并保存。');
    const timestamp = nowIso();
    this.db.execute(`UPDATE automation_tasks SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [status, timestamp, id]);
    const updated = this.getById(id);
    if (!updated) throw new Error('ZEUS_AUTOMATION_CONFIG_NOT_FOUND: 自动化任务不存在。');
    return updated;
  }

  delete(id: string): void {
    const timestamp = nowIso();
    this.db.execute(`UPDATE automation_tasks SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, timestamp, id]);
  }

  setNextRun(id: string, nextRunAt: string | null, triggeredAt?: string): void {
    this.db.execute(`UPDATE automation_tasks SET next_run_at = ?, last_triggered_at = COALESCE(?, last_triggered_at), updated_at = ? WHERE id = ?`, [nextRunAt, triggeredAt ?? null, nowIso(), id]);
  }

  /** 事件消费单调推进；移交调度时可精确替换原游标，事务避免重启重复消费。 */
  setEventCursor(id: string, projectId: string, sequence: number, replace = false): void {
    const current = this.getById(id);
    if (!current) throw new Error('ZEUS_AUTOMATION_CONFIG_NOT_FOUND: 自动化任务不存在。');
    this.db.execute('UPDATE automation_tasks SET event_cursors_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({ ...current.eventCursors, [projectId]: replace ? sequence : Math.max(current.eventCursors[projectId] ?? 0, sequence) }),
      nowIso(),
      id,
    ]);
  }

  /** 配置事件规则时从当前事件边界开始，不补跑配置前事件。 */
  initializeEventCursors(id: string, projectIds?: string[]): void {
    const task = this.getById(id);
    if (!task || task.triggerKind !== 'event') return;
    for (const target of this.listTargets(id).filter((target) => projectIds === undefined || projectIds.includes(target.projectId))) {
      const codeEvents = task.triggerConfig.eventKinds?.includes('code_changed') === true;
      const sequence = codeEvents
        ? (this.db.get<{ sequence: number }>('SELECT COALESCE(MAX(rowid), 0) AS sequence FROM git_snapshots WHERE project_id = ?', [target.projectId])?.sequence ?? 0)
        : (this.db.get<{ sequence: number }>('SELECT COALESCE(MAX(event.rowid), 0) AS sequence FROM task_events event JOIN tasks task ON task.id = event.task_id WHERE task.project_id = ?', [target.projectId])?.sequence ?? 0);
      /** 保存时替换新流边界，事件消费时才采用单调推进。 */
      this.db.execute('UPDATE automation_tasks SET event_cursors_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify({ ...this.getById(id)!.eventCursors, [target.projectId]: sequence }), nowIso(), id]);
    }
  }

  /** 从耐久事件表读取发生时的事实，游标独立于任务最新状态。 */
  listTriggerEvents(projectId: string, afterSequence: number, limit = 50): Array<AutomationSourceEvent & { sequence: number; identity: string }> {
    return this.db
      .select<{ sequence: number; id: string; task_id: string; event_type: string; payload_json: string; created_at: string }>(
        "SELECT event.rowid AS sequence, event.id, event.task_id, event.event_type, event.payload_json, event.created_at FROM task_events event JOIN tasks task ON task.id = event.task_id WHERE task.project_id = ? AND event.rowid > ? AND event.event_type IN ('task.created', 'task.updated', 'task.tags.updated', 'task.relationships.updated', 'task.status.changed', 'task.management_status.changed') ORDER BY event.rowid LIMIT ?",
        [projectId, afterSequence, Math.min(100, Math.max(1, limit))],
      )
      .map((row) => ({ projectId, taskId: row.task_id, eventType: row.event_type, occurredAt: row.created_at, payload: parseJson<Record<string, unknown>>(row.payload_json, {}), sequence: row.sequence, identity: `task_event:${row.id}` }));
  }

  /** 代码规则延续原 git snapshot 游标，不把任务事件序号混入该流。 */
  listCodeTriggerEvents(projectId: string, afterSequence: number, limit = 50): Array<AutomationSourceEvent & { sequence: number; identity: string }> {
    return this.db
      .select<{ sequence: number; id: string; task_id: string; snapshot_type: string; source_context_json: string; created_at: string }>(
        'SELECT snapshot.rowid AS sequence, snapshot.id, snapshot.task_id, snapshot.snapshot_type, snapshot.created_at, task.source_context_json FROM git_snapshots snapshot JOIN tasks task ON task.id = snapshot.task_id WHERE snapshot.project_id = ? AND snapshot.rowid > ? ORDER BY snapshot.rowid LIMIT ?',
        [projectId, afterSequence, Math.min(100, Math.max(1, limit))],
      )
      .map((row) => ({
        projectId,
        taskId: row.task_id,
        eventType: 'code_changed',
        occurredAt: row.created_at,
        payload: { snapshotId: row.id, snapshotType: row.snapshot_type, source: parseJson<Record<string, unknown>>(row.source_context_json, {}).type },
        sequence: row.sequence,
        identity: `git_snapshot:${row.id}`,
      }));
  }

  /** 写回执与推进游标共用一次事务，忽略的事件也只消费一次。 */
  consumeEvent<T>(id: string, projectId: string, sequence: number, accept: () => T): T {
    return this.db.transaction(() => {
      const result = accept();
      this.setEventCursor(id, projectId, sequence);
      return result;
    });
  }

  setFullAccessGrant(id: string, expectedRevision: number, granted: boolean): void {
    const task = this.getById(id);
    if (!task || task.revision !== expectedRevision || task.permissionMode !== 'full-access') throw new Error('ZEUS_AUTOMATION_PERMISSION_GRANT_STALE: 完全访问授权与当前配置不匹配。');
    const timestamp = nowIso();
    this.db.execute(
      `INSERT INTO automation_full_access_grants (automation_id, config_revision, granted, granted_at, revoked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(automation_id) DO UPDATE SET config_revision = excluded.config_revision, granted = excluded.granted,
         granted_at = excluded.granted_at, revoked_at = excluded.revoked_at, updated_at = excluded.updated_at`,
      [id, expectedRevision, granted ? 1 : 0, granted ? timestamp : null, granted ? null : timestamp, timestamp],
    );
  }

  hasFullAccessGrant(id: string, revision: number): boolean {
    return this.db.get<{ granted: number }>(`SELECT granted FROM automation_full_access_grants WHERE automation_id = ? AND config_revision = ?`, [id, revision])?.granted === 1;
  }

  private insertTask(id: string, revisionId: string, revision: number, snapshot: AutomationDefinitionSnapshot, timestamp: string): void {
    this.db.execute(
      `INSERT INTO automation_tasks (id, name, description, prompt, status, current_revision_id, revision, trigger_kind, trigger_config_json, timezone,
        conversation_mode, original_conversation_id, permission_mode, model_source_id, model_id, reasoning_effort, service_tier, fast_mode, skill_id,
        plugin_ids_json, block_strategy, queue_capacity, max_runs_per_day, max_tokens_per_day, retention_days, notification_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        snapshot.name,
        snapshot.description,
        snapshot.prompt,
        revisionId,
        revision,
        snapshot.triggerKind,
        JSON.stringify(snapshot.triggerConfig),
        snapshot.timezone,
        snapshot.conversationMode,
        snapshot.originalConversationId,
        snapshot.permissionMode,
        snapshot.modelSourceId,
        snapshot.modelId,
        snapshot.reasoningEffort,
        snapshot.serviceTier,
        snapshot.fastMode ? 1 : 0,
        snapshot.skillId,
        JSON.stringify(snapshot.pluginIds),
        snapshot.blockStrategy,
        snapshot.queueCapacity,
        snapshot.maxRunsPerDay,
        snapshot.maxTokensPerDay,
        snapshot.retentionDays,
        JSON.stringify(snapshot.notifications),
        timestamp,
        timestamp,
      ],
    );
  }

  private insertRevision(id: string, automationId: string, revision: number, snapshot: AutomationDefinitionSnapshot, projectIds: string[], timestamp: string): void {
    this.db.execute(`INSERT INTO automation_task_revisions (id, automation_id, revision, snapshot_json, project_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      id,
      automationId,
      revision,
      JSON.stringify(snapshot),
      JSON.stringify(projectIds),
      timestamp,
    ]);
  }

  private replaceTargets(automationId: string, projectIds: string[], timestamp: string): void {
    this.db.execute(`DELETE FROM automation_task_targets WHERE automation_id = ?`, [automationId]);
    projectIds.forEach((projectId, position) => this.db.execute(`INSERT INTO automation_task_targets (automation_id, project_id, position, enabled, created_at) VALUES (?, ?, ?, 1, ?)`, [automationId, projectId, position, timestamp]));
  }
}

/** 历史修订只补动作默认值，不重算其冻结的模型或权限。 */
function normalizeRevisionSnapshot(value: string): AutomationDefinitionSnapshot {
  const snapshot = parseJson<AutomationDefinitionSnapshot>(value, {} as AutomationDefinitionSnapshot);
  return { ...snapshot, action: snapshot.action ?? { kind: 'conversation', employeeId: null } };
}

export class AutomationRunRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  enqueue(input: EnqueueAutomationRunInput): AutomationRunRecord {
    const task = new AutomationTaskRepository(this.db).getById(input.automationId);
    if (!task || task.status !== 'active') throw new Error('ZEUS_AUTOMATION_TRIGGER_INACTIVE: 自动化任务未启用。');
    /** 运行项目列表去重并保留选择顺序。 */
    const projectIds = stringArray(input.projectIds, '运行项目');
    /** 首项目用于普通运行归属；无项目运行由临时工作区兼容既有非空字段。 */
    const projectId = runAnchorProjectId(projectIds, input.projectId);
    const timestamp = nowIso();
    /** 同一自动化触发身份全局幂等，不再按项目各建一条运行。 */
    const existing = this.db.get<DbAutomationRunRow>(`SELECT ${runSelect} FROM automation_runs WHERE automation_id = ? AND trigger_identity = ? ORDER BY accepted_at, id LIMIT 1`, [input.automationId, input.triggerIdentity]);
    if (existing) return mapRun(existing);
    if (task.conversationMode === 'original' && projectIds.length !== 1) {
      return this.insertTerminal(input, task, 'blocked', 'ZEUS_AUTOMATION_CONFIG_ORIGINAL_CONVERSATION_SINGLE_PROJECT_REQUIRED', '追加原会话只能选择一个项目；请修改自动化配置。', timestamp);
    }
    return this.db.transaction(() => {
      if (task.maxRunsPerDay !== null) {
        const dayStart = `${input.scheduledAt.slice(0, 10)}T00:00:00.000Z`;
        const dayEnd = `${input.scheduledAt.slice(0, 10)}T23:59:59.999Z`;
        const count = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id = ? AND accepted_at BETWEEN ? AND ?`, [task.id, dayStart, dayEnd])?.count ?? 0;
        if (count >= task.maxRunsPerDay) return this.insertTerminal(input, task, 'blocked', 'ZEUS_AUTOMATION_BUDGET_RUNS_EXHAUSTED', '已达到当日运行次数上限。', timestamp);
      }
      if (task.permissionMode === 'full-access' && !new AutomationTaskRepository(this.db).hasFullAccessGrant(task.id, task.revision)) {
        return this.insertTerminal(input, task, 'blocked', 'ZEUS_AUTOMATION_PERMISSION_GRANT_REQUIRED', '当前修订的完全访问尚未授权。', timestamp);
      }
      /** 阻塞策略作用于整次自动化，不再按项目拆分。 */
      const active = this.listActive(task.id);
      if (task.blockStrategy === 'discard' && active.length > 0) return this.insertTerminal(input, task, 'cancelled', 'ZEUS_AUTOMATION_QUEUE_DISCARDED', '已按阻塞策略丢弃本次触发。', timestamp);
      let previousRunId: string | null = null;
      let mayOverlap = false;
      if (task.blockStrategy === 'cover' && active.length > 0) {
        const previous = active[0]!;
        previousRunId = previous.id;
        mayOverlap = previous.status === 'dispatching' || previous.status === 'running';
        this.setTerminal(previous.id, 'outcome_unknown', 'ZEUS_AUTOMATION_DISPATCH_OUTCOME_UNKNOWN', '覆盖时无法证明旧 Provider 或外部命令已停止。');
      }
      /** 队列容量同样按自动化整体计算。 */
      const queued = this.db.select<{ id: string }>(`SELECT id FROM automation_runs WHERE automation_id = ? AND status = 'queued' ORDER BY queue_position, accepted_at, id`, [task.id]);
      if (task.blockStrategy === 'serial' && active.length > 0 && queued.length >= task.queueCapacity) {
        this.setTerminal(queued[0]!.id, 'cancelled', 'ZEUS_AUTOMATION_QUEUE_EVICTED', '队列已满，已淘汰最早等待运行。');
      }
      const id = input.id ?? `automation_run_${randomId(12)}`;
      const causalChainId = input.causalChainId ?? `automation_chain_${randomId(12)}`;
      const queuePosition = task.blockStrategy === 'serial' && active.length > 0 ? queued.length + 1 : 0;
      this.db.execute(
        `INSERT INTO automation_runs (id, automation_id, automation_revision_id, project_id, project_ids_json, trigger_kind, trigger_identity, causal_chain_id,
          status, queue_position, attempt, unread, may_overlap_previous, previous_run_id, scheduled_at, accepted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          task.id,
          task.currentRevisionId,
          projectId,
          JSON.stringify(projectIds),
          input.triggerKind,
          input.triggerIdentity,
          causalChainId,
          queuePosition,
          mayOverlap ? 1 : 0,
          previousRunId,
          input.scheduledAt,
          timestamp,
          timestamp,
          timestamp,
        ],
      );
      this.db.execute(`INSERT OR IGNORE INTO automation_trigger_receipts (automation_id, project_id, trigger_identity, run_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
        task.id,
        projectId,
        input.triggerIdentity,
        id,
        input.scheduledAt,
        timestamp,
      ]);
      if (input.sourceEvent) this.db.execute('UPDATE automation_runs SET source_event_json = ? WHERE id = ?', [JSON.stringify(input.sourceEvent), id]);
      try {
        this.db.execute(`INSERT INTO automation_causal_chain_members (causal_chain_id, automation_id, project_id, run_id, created_at) VALUES (?, ?, ?, ?, ?)`, [causalChainId, task.id, projectId, id, timestamp]);
      } catch {
        this.setTerminal(id, 'blocked', 'ZEUS_AUTOMATION_TRIGGER_CAUSAL_CYCLE', '因果链内已存在同一自动化与项目。');
      }
      return this.getById(id)!;
    });
  }

  getById(id: string): AutomationRunRecord | undefined {
    const row = this.db.get<DbAutomationRunRow>(`SELECT ${runSelect} FROM automation_runs WHERE id = ?`, [id]);
    return row ? mapRun(row) : undefined;
  }

  listByAutomation(automationId: string, limit = 100): AutomationRunRecord[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    return this.db.select<DbAutomationRunRow>(`SELECT ${runSelect} FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, [automationId, safeLimit]).map(mapRun);
  }

  /** 按同一筛选入口读取在途和历史回执，排队不再从收件箱中消失。 */
  listInbox(input: { unreadOnly?: boolean; status?: AutomationRunStatus; limit?: number } = {}): AutomationRunRecord[] {
    /** 在途和待验收记录也必须可见，不能把已触发任务显示成空收件箱。 */
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.unreadOnly) clauses.push('unread = 1');
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    params.push(Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 500)));
    return this.db.select<DbAutomationRunRow>(`SELECT ${runSelect} FROM automation_runs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, params).map(mapRun);
  }

  /** 待验收继续对账真实成果，不受历史列表页数限制。 */
  listInFlight(): AutomationRunRecord[] {
    return this.db.select<DbAutomationRunRow>(`SELECT ${runSelect} FROM automation_runs WHERE status IN ('dispatching', 'running', 'awaiting_review') ORDER BY accepted_at, id`).map(mapRun);
  }

  findAcceptedSubmission(run: AutomationRunRecord): { conversationId: string; submissionId: string } | undefined {
    return this.db.get<{ conversationId: string; submissionId: string }>(
      `SELECT s.conversation_id AS conversationId, s.id AS submissionId FROM conversation_submissions s
       JOIN conversations c ON c.id = s.conversation_id WHERE s.idempotency_key = ? AND c.project_id = ? LIMIT 1`,
      [`automation:${run.id}`, run.projectId],
    );
  }

  listDispatchable(limit = 10): AutomationRunRecord[] {
    return this.db
      .select<DbAutomationRunRow>(
        `SELECT ${runSelect} FROM automation_runs r WHERE r.status = 'queued' AND COALESCE(r.queue_position, 0) = 0
       AND EXISTS (SELECT 1 FROM automation_tasks t WHERE t.id = r.automation_id AND t.status = 'active')
       AND NOT EXISTS (SELECT 1 FROM automation_runs active WHERE active.automation_id = r.automation_id
         AND active.id <> r.id AND active.status IN ('dispatching', 'running')) ORDER BY r.accepted_at, r.id LIMIT ?`,
        [Math.max(1, Math.min(Math.trunc(limit), 100))],
      )
      .map(mapRun);
  }

  listActive(automationId: string): AutomationRunRecord[] {
    return this.db.select<DbAutomationRunRow>(`SELECT ${runSelect} FROM automation_runs WHERE automation_id = ? AND status IN ('dispatching', 'running') ORDER BY accepted_at, id`, [automationId]).map(mapRun);
  }

  /** 领取与状态核对共用事务，暂停后已取出的候选也不得继续派发。 */
  markDispatching(id: string): AutomationRunRecord | undefined {
    return this.db.transaction(() => {
      /** 候选可能在等待前一次派发时被取消或移出队列。 */
      const current = this.getById(id);
      if (!current || current.status !== 'queued') return undefined;
      /** 领取时重新核对启用和串行占位，防止旧候选越过刚接纳的工作。 */
      const task = this.db.get<{ status: AutomationStatus }>('SELECT status FROM automation_tasks WHERE id = ?', [current.automationId]);
      if (task?.status !== 'active' || this.listActive(current.automationId).length > 0) return undefined;
      /** 仅实际领取的运行记录开始时间和尝试次数。 */
      const timestamp = nowIso();
      /** 本次领取使用下一次尝试身份。 */
      const attempt = current.attempt + 1;
      this.db.execute(`UPDATE automation_runs SET status = 'dispatching', attempt = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'`, [attempt, timestamp, timestamp, id]);
      this.db.execute(`INSERT INTO automation_run_attempts (id, run_id, attempt, status, operation_identity, started_at) VALUES (?, ?, ?, 'dispatching', ?, ?)`, [
        `automation_attempt_${randomId(12)}`,
        id,
        attempt,
        `automation-dispatch:${id}:${attempt}`,
        timestamp,
      ]);
      return this.getById(id)!;
    });
  }

  markRunning(id: string, conversationId: string, submissionId: string): AutomationRunRecord {
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.execute(`UPDATE automation_runs SET status = 'running', conversation_id = ?, submission_id = ?, updated_at = ? WHERE id = ? AND status = 'dispatching'`, [conversationId, submissionId, timestamp, id]);
      this.db.execute(`UPDATE automation_run_attempts SET status = 'running', write_marker_at = COALESCE(write_marker_at, ?) WHERE run_id = ? AND attempt = (SELECT attempt FROM automation_runs WHERE id = ?)`, [timestamp, id, id]);
      const revision = this.db.get<{ snapshot_json: string }>(`SELECT snapshot_json FROM automation_task_revisions WHERE id = (SELECT automation_revision_id FROM automation_runs WHERE id = ?)`, [id]);
      const snapshot = parseJson<AutomationDefinitionSnapshot>(revision?.snapshot_json ?? '{}', {} as AutomationDefinitionSnapshot);
      if (snapshot.conversationMode === 'independent') this.db.execute(`UPDATE conversations SET origin_kind = 'automation', listing_scope = 'automation_inbox', automation_run_id = ? WHERE id = ?`, [id, conversationId]);
    });
    return this.getById(id)!;
  }

  /** 冻结完整目标，并由真实任务归属补齐旧引用；缺失关系保持待核对。 */
  ensureDispatchTargets(id: string): AutomationRunRecord {
    /** 已经保存的目标不能被当前配置覆盖。 */
    const run = this.getById(id)!;
    if (run.dispatchTargets.length > 0) return run;
    /** 无项目工作使用稳定技术归属。 */
    const projectIds = run.projectIds.length > 0 ? run.projectIds : [run.projectId];
    /** 引用必须能证明项目，不能按数量或数组位置猜测。 */
    const targets: AutomationDispatchTarget[] = projectIds.map((projectId) => ({ projectId, taskId: null, employeeId: null, sourceRef: `automation:${run.id}:${projectId}`, status: 'pending', reference: null, reason: null }));
    for (const reference of run.executionReferences) {
      /** 旧引用从准确业务运行反查任务，再读取归属。 */
      const taskId =
        reference.taskId ??
        (reference.kind === 'workflow'
          ? this.db.get<{ task_id: string }>('SELECT task_id FROM digital_team_workflow_runs WHERE id = ?', [reference.id])?.task_id
          : reference.kind === 'task_work'
            ? this.db.get<{ task_id: string }>('SELECT item.task_id FROM task_work_runs run JOIN task_work_items item ON item.id = run.work_item_id WHERE run.id = ?', [reference.id])?.task_id
            : reference.kind === 'legacy_employee'
              ? this.db.get<{ task_id: string }>('SELECT task_id FROM digital_employee_executions WHERE id = ?', [reference.id])?.task_id
              : undefined);
      /** 单一引用也必须具有可验证的项目归属。 */
      const projectId = taskId ? this.db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', [taskId])?.project_id : undefined;
      /** 多份引用落入一个项目仍全部保留在原引用账本，目标只记录接纳代表。 */
      const target = targets.find((entry) => entry.projectId === projectId);
      if (target) Object.assign(target, { taskId: taskId ?? null, status: 'accepted', reference });
    }
    this.db.execute('UPDATE automation_runs SET dispatch_targets_json = ?, dispatch_completed_at = ? WHERE id = ?', [JSON.stringify(targets), targets.every((target) => target.status === 'accepted') ? nowIso() : null, id]);
    return this.getById(id)!;
  }

  /** 核对全部旧员工动作，已误报的部分成功显式保留核对原因。 */
  listUntrackedActionRuns(): AutomationRunRecord[] {
    return this.db
      .select<DbAutomationRunRow>(
        `SELECT ${runSelect} FROM automation_runs WHERE dispatch_targets_json = '[]' AND status IN ('dispatching', 'running', 'succeeded') AND automation_revision_id IN (SELECT id FROM automation_task_revisions WHERE json_extract(snapshot_json, '$.action.kind') IN ('employee_work', 'project_task'))`,
      )
      .map(mapRun);
  }

  /** 接纳前冻结任务、绑定和来源；接纳结果只能更新原项目。 */
  updateDispatchTarget(id: string, target: AutomationDispatchTarget): AutomationRunRecord {
    return this.db.transaction(() => {
      /** 逐目标状态始终从当前耐久运行读取，不能用旧快照覆盖其他目标。 */
      const run = this.ensureDispatchTargets(id);
      /** 目标不允许追加成不同的项目范围。 */
      const current = run.dispatchTargets.find((entry) => entry.projectId === target.projectId);
      if (!current || current.sourceRef !== target.sourceRef) throw new Error('ZEUS_AUTOMATION_DISPATCH_TARGET_INVALID: 接纳目标与冻结项目不一致。');
      if (current.status === 'accepted' || current.status === 'skipped') return run;
      if (current.taskId && current.taskId !== target.taskId) throw new Error('ZEUS_AUTOMATION_DISPATCH_TARGET_INVALID: 恢复不能更换已冻结任务。');
      if (current.employeeId && current.employeeId !== target.employeeId) throw new Error('ZEUS_AUTOMATION_DISPATCH_TARGET_INVALID: 恢复不能更换已冻结员工。');
      if (target.status === 'accepted' && (!target.reference?.id || (target.taskId && target.reference.taskId !== target.taskId))) throw new Error('ZEUS_AUTOMATION_DISPATCH_TARGET_INVALID: 接纳引用缺少准确任务身份。');
      /** 新引用按身份去重，旧工作引用完整保留。 */
      const references = [...run.executionReferences];
      if (target.reference && !references.some((reference) => reference.kind === target.reference!.kind && reference.id === target.reference!.id)) references.push(target.reference);
      this.db.execute('UPDATE automation_runs SET dispatch_targets_json = ?, execution_references_json = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(run.dispatchTargets.map((entry) => (entry.projectId === target.projectId ? target : entry))),
        JSON.stringify(references),
        nowIso(),
        id,
      ]);
      return this.getById(id)!;
    });
  }

  /** 精确来源身份对账；Core 与 Task Work 接纳均持久化后才返回。 */
  findAcceptedExecution(target: AutomationDispatchTarget): AutomationExecutionReference | null | false {
    /** 旧安排领取也以正式来源回执冻结原流程代次。 */
    const plannedReceipt = this.db.get<{ evidence_json: string }>("SELECT evidence_json FROM command_delivery_receipts WHERE operation_identity = ? AND outcome = 'accepted'", [`automation-planned:${target.sourceRef}`]);
    if (plannedReceipt) {
      /** 来源回执记录准确计划身份，当前任务的新安排不能替代。 */
      const evidence = parseJson<{ result?: AutomationExecutionReference | null }>(plannedReceipt.evidence_json, {});
      if (evidence.result === null) return false;
      const reference = evidence.result;
      if (reference?.kind !== 'task_plan' || !reference.id || reference.taskId !== target.taskId || !Number.isInteger(reference.generation)) throw new Error('ZEUS_AUTOMATION_DISPATCH_OUTCOME_UNKNOWN: 旧安排接纳回执不可核对。');
      return reference;
    }
    /** 工作来源包含冻结绑定，禁止按任务最新执行猜测。 */
    const work = target.employeeId
      ? this.db.get<{ run_id: string; task_id: string; conversation_id: string | null }>(
          'SELECT run.id AS run_id, item.task_id, run.conversation_id FROM task_work_items item JOIN task_work_runs run ON run.work_item_id = item.id WHERE item.source = ? AND item.source_ref = ? ORDER BY run.attempt, run.created_at, run.id LIMIT 1',
          ['automation', `${target.employeeId}:${target.sourceRef}`],
        )
      : undefined;
    /** 流程接纳与该命令回执在同一 Core 事务中提交。 */
    const receipt = this.db.get<{ evidence_json: string }>("SELECT evidence_json FROM command_delivery_receipts WHERE operation_identity = ? AND outcome = 'accepted'", [`project-workflow:${target.sourceRef}`]);
    /** 同一来源被两种业务同时接纳属于冲突，不猜测选择。 */
    if (work && receipt) throw new Error('ZEUS_AUTOMATION_DISPATCH_OUTCOME_UNKNOWN: 同一目标存在两种接纳记录。');
    if (work) {
      if (target.taskId && work.task_id !== target.taskId) throw new Error('ZEUS_AUTOMATION_DISPATCH_OUTCOME_UNKNOWN: 接纳记录的任务不符。');
      return { kind: 'task_work', id: work.run_id, taskId: work.task_id, ...(work.conversation_id ? { conversationId: work.conversation_id } : {}) };
    }
    if (receipt) {
      /** 只读取正式回执里的已接纳运行身份。 */
      const evidence = parseJson<{ result?: { run?: { id?: string; taskId?: string } } }>(receipt.evidence_json, {});
      /** 回执不可读时保持未知，不能从最新流程猜测。 */
      const workflowId = evidence.result?.run?.id;
      const workflow = workflowId ? this.db.get<{ task_id: string; project_id: string }>('SELECT task_id, project_id FROM digital_team_workflow_runs WHERE id = ?', [workflowId]) : undefined;
      if (!workflow || workflow.project_id !== target.projectId || (target.taskId && workflow.task_id !== target.taskId)) throw new Error('ZEUS_AUTOMATION_DISPATCH_OUTCOME_UNKNOWN: 已接纳流程回执不能对应冻结目标。');
      return { kind: 'workflow', id: workflowId!, taskId: workflow.task_id };
    }
    return null;
  }

  /** 全部目标有明确接纳或跳过结果后才能进入工作终态核对。 */
  completeDispatch(id: string): AutomationRunRecord {
    /** 已接纳数量不能代替冻结目标完整性。 */
    const run = this.ensureDispatchTargets(id);
    if (run.dispatchTargets.some((target) => target.status !== 'accepted' && target.status !== 'skipped')) throw new Error('ZEUS_AUTOMATION_DISPATCH_INCOMPLETE: 仍有目标没有明确处理结果。');
    this.db.execute("UPDATE automation_runs SET status = 'running', dispatch_completed_at = COALESCE(dispatch_completed_at, ?), updated_at = ? WHERE id = ? AND status IN ('dispatching', 'running')", [nowIso(), nowIso(), id]);
    return this.getById(id)!;
  }

  /** 原运行恢复后只处理缺失目标；终态历史保存在尝试和核对记录。 */
  resumeDispatch(id: string): AutomationRunRecord {
    return this.db.transaction(() => {
      /** 恢复明确限制为存在逐目标范围的部分派发。 */
      const run = this.getById(id);
      if (!run || !['blocked', 'outcome_unknown'].includes(run.status) || run.dispatchTargets.length === 0 || run.dispatchCompletedAt) throw new Error('ZEUS_AUTOMATION_RESUME_UNAVAILABLE: 当前运行没有可恢复的剩余目标。');
      if (run.dispatchTargets.some((target) => target.reason?.startsWith('ZEUS_AUTOMATION_EMPLOYEE_IDENTITY_MIGRATED:'))) throw new Error('ZEUS_AUTOMATION_EMPLOYEE_IDENTITY_MIGRATED: 员工身份已迁移，本次未开始部分请重新运行。');
      /** 同规则的其他在途工作必须先结束，避免重叠副作用。 */
      if (this.listActive(run.automationId).some((active) => active.id !== id)) throw new Error('ZEUS_AUTOMATION_RESUME_BUSY: 同一自动化仍有其他运行。');
      /** 原终态时间与原因旁路保留，当前完成时间等待后续准确结果。 */
      this.db.execute('UPDATE automation_runs SET dispatch_reconciliation_json = COALESCE(dispatch_reconciliation_json, ?) WHERE id = ?', [
        JSON.stringify({ previousStatus: run.status, checkedAt: nowIso(), reason: run.errorMessage ?? '用户沿原运行恢复剩余目标。', completedAt: run.completedAt }),
        id,
      ]);
      this.db.execute("UPDATE automation_runs SET status = 'queued', queue_position = 0, completed_at = NULL, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?", [nowIso(), id]);
      new AutomationTaskRepository(this.db).setStatus(run.automationId, 'active');
      return this.getById(id)!;
    });
  }

  /** 存量误报成功保留原状态和完成时间，在当前投影显露实际未完整派发。 */
  recordIncompleteReconciliation(id: string, reason: string): AutomationRunRecord {
    /** 原核对只记录一次，后续恢复不覆盖历史。 */
    const run = this.getById(id)!;
    this.db.execute('UPDATE automation_runs SET dispatch_reconciliation_json = COALESCE(dispatch_reconciliation_json, ?) WHERE id = ?', [
      JSON.stringify({ previousStatus: run.status, checkedAt: nowIso(), reason, completedAt: run.completedAt }),
      id,
    ]);
    new AutomationTaskRepository(this.db).setStatus(run.automationId, 'paused');
    return this.setTerminal(id, 'outcome_unknown', 'ZEUS_AUTOMATION_DISPATCH_INCOMPLETE', reason);
  }

  /** 先耐久保存真实执行关联，再等待各执行终态；不会把首个会话结束当作流程结束。 */
  markExecuting(id: string, references: AutomationExecutionReference[]): AutomationRunRecord {
    if (references.length === 0 || references.some((reference) => !reference.id)) throw new Error('ZEUS_AUTOMATION_EXECUTION_REFERENCE_REQUIRED: 自动化执行必须返回真实运行引用。');
    this.db.execute(`UPDATE automation_runs SET status = 'running', execution_references_json = ?, updated_at = ? WHERE id = ? AND status IN ('dispatching', 'running')`, [JSON.stringify(references), nowIso(), id]);
    return this.getById(id)!;
  }

  /** 独立员工工作已产出成果时释放执行队列，验收仍由原任务处理。 */
  markAwaitingReview(id: string): AutomationRunRecord {
    return this.db.transaction(() => {
      /** 冻结动作决定是否可以释放，后续编辑不改变原运行的验收边界。 */
      const run = this.getById(id);
      if (!run) throw new Error('ZEUS_AUTOMATION_RUN_NOT_FOUND: 自动化运行不存在。');
      if (run.status !== 'running' || new AutomationTaskRepository(this.db).getRevision(run.automationRevisionId)?.snapshot.action.kind !== 'employee_work') return run;
      /** 待验收不是成功或终态，完成时间仍为空。 */
      const timestamp = nowIso();
      this.db.execute("UPDATE automation_runs SET status = 'awaiting_review', unread = 1, updated_at = ? WHERE id = ?", [timestamp, id]);
      this.db.execute("UPDATE automation_run_attempts SET status = 'awaiting_review' WHERE run_id = ? AND attempt = ?", [id, run.attempt]);
      this.promoteNext(id);
      return this.getById(id)!;
    });
  }

  setTerminal(id: string, status: Extract<AutomationRunStatus, 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown'>, errorCode: string | null = null, errorMessage: string | null = null): AutomationRunRecord {
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.execute(`UPDATE automation_runs SET status = ?, unread = 1, completed_at = COALESCE(completed_at, ?), error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`, [
        status,
        timestamp,
        errorCode,
        errorMessage,
        timestamp,
        id,
      ]);
      this.db.execute(`UPDATE automation_run_attempts SET status = ?, completed_at = COALESCE(completed_at, ?), error_code = ?, error_message = ? WHERE run_id = ? AND attempt = (SELECT attempt FROM automation_runs WHERE id = ?)`, [
        status,
        timestamp,
        errorCode,
        errorMessage,
        id,
        id,
      ]);
      const task = this.db.get<{ notification_json: string }>(`SELECT notification_json FROM automation_tasks WHERE id = (SELECT automation_id FROM automation_runs WHERE id = ?)`, [id]);
      const notifications = parseJson<AutomationNotificationConfig>(task?.notification_json ?? '{}', { success: true, failure: true, blocked: true });
      const notificationEnabled = status === 'succeeded' ? notifications.success : status === 'blocked' || status === 'outcome_unknown' ? notifications.blocked : notifications.failure;
      if (notificationEnabled) {
        this.db.execute(
          `INSERT OR IGNORE INTO automation_notification_outbox (id, run_id, kind, payload_json, status, attempt, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
          [
            `automation_notification_${randomId(12)}`,
            id,
            status,
            JSON.stringify({
              runId: id,
              status,
            }),
            timestamp,
            timestamp,
            timestamp,
          ],
        );
      }
      this.promoteNext(id);
    });
    const updated = this.getById(id);
    if (!updated) throw new Error('ZEUS_AUTOMATION_RUN_NOT_FOUND: 自动化运行不存在。');
    return updated;
  }

  acknowledge(id: string): AutomationRunRecord {
    this.db.execute(`UPDATE automation_runs SET unread = 0 WHERE id = ?`, [id]);
    const updated = this.getById(id);
    if (!updated) throw new Error('ZEUS_AUTOMATION_RUN_NOT_FOUND: 自动化运行不存在。');
    return updated;
  }

  private insertTerminal(input: EnqueueAutomationRunInput, task: AutomationTaskRecord, status: Extract<AutomationRunStatus, 'blocked' | 'cancelled'>, errorCode: string, errorMessage: string, timestamp: string): AutomationRunRecord {
    /** 终态运行也保留完整项目范围，便于界面解释失败对象。 */
    const projectIds = stringArray(input.projectIds, '运行项目');
    /** 终态无项目运行同样使用临时工作区兼容非空字段。 */
    const projectId = runAnchorProjectId(projectIds, input.projectId);
    const id = input.id ?? `automation_run_${randomId(12)}`;
    const causalChainId = input.causalChainId ?? `automation_chain_${randomId(12)}`;
    this.db.execute(
      `INSERT INTO automation_runs (id, automation_id, automation_revision_id, project_id, project_ids_json, trigger_kind, trigger_identity, causal_chain_id, status,
       attempt, unread, scheduled_at, accepted_at, completed_at, error_code, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [id, task.id, task.currentRevisionId, projectId, JSON.stringify(projectIds), input.triggerKind, input.triggerIdentity, causalChainId, status, input.scheduledAt, timestamp, timestamp, errorCode, errorMessage, timestamp, timestamp],
    );
    this.db.execute(`INSERT OR IGNORE INTO automation_trigger_receipts (automation_id, project_id, trigger_identity, run_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      task.id,
      projectId,
      input.triggerIdentity,
      id,
      input.scheduledAt,
      timestamp,
    ]);
    if (input.sourceEvent) this.db.execute('UPDATE automation_runs SET source_event_json = ? WHERE id = ?', [JSON.stringify(input.sourceEvent), id]);
    return this.getById(id)!;
  }

  /** 执行占位释放后只提升一个队首，成果验收和终态结算共用此边界。 */
  private promoteNext(completedId: string): void {
    /** 原运行决定队列归属，不读取当前规则的新项目范围。 */
    const completed = this.getById(completedId);
    if (!completed || this.listActive(completed.automationId).length > 0) return;
    /** 按队列位置保持同毫秒触发的顺序；旧成果验收不能再次提升已就绪队首。 */
    const next = this.db.get<{ id: string; position: number }>(`SELECT id, queue_position AS position FROM automation_runs WHERE automation_id = ? AND status = 'queued' ORDER BY queue_position, accepted_at, id LIMIT 1`, [
      completed.automationId,
    ]);
    if (!next || next.position === 0) return;
    this.db.execute(`UPDATE automation_runs SET queue_position = 0 WHERE id = ?`, [next.id]);
    this.db.execute(`UPDATE automation_runs SET queue_position = queue_position - 1 WHERE automation_id = ? AND status = 'queued' AND queue_position > 0 AND id <> ?`, [completed.automationId, next.id]);
  }
}
